import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { boundedParse, replySchema, PROTOCOL_VERSION, DesktopError, type WorkerReply, type WorkerRequest } from './protocol.ts'

interface Pending {
  resolve(value: WorkerReply): void
  reject(error: Error): void
  cleanup(): void
}

/** One plugin-owned diagnostic process; timeout/cancellation closes it without replay. */
export class DiagnosticWorker {
  private child: ChildProcess | undefined
  private pending = new Map<string, Pending>()
  private closed = false
  private closing: Promise<void> | undefined
  private lastSequence = 0
  constructor(private readonly timeoutMs: number) {}

  get pid(): number | undefined { return this.child?.pid }
  get isClosed(): boolean { return this.closed }

  async start(signal: AbortSignal): Promise<WorkerReply> {
    signal.throwIfAborted()
    if (this.closed || this.child) throw new DesktopError('invalid-state', 'Worker cannot be started twice')
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url))], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      // Do not forward the Host's model credentials to this diagnostic process.
      env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]])),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    })
    this.child = child
    child.on('message', (value: unknown) => {
      try {
        const reply = boundedParse(replySchema, value)
        const pending = this.pending.get(reply.id)
        if (!pending || reply.pid !== child.pid || reply.sequence <= this.lastSequence) {
          throw new DesktopError('protocol', 'Unknown, replayed, or mismatched worker reply')
        }
        this.lastSequence = reply.sequence
        this.pending.delete(reply.id)
        pending.cleanup()
        pending.resolve(reply)
      } catch (error) {
        void this.close(error instanceof Error ? error : new DesktopError('protocol', 'Invalid reply'))
      }
    })
    child.on('error', error => { void this.close(new DesktopError('worker-unavailable', 'Worker process failed', { cause: error })) })
    child.on('exit', () => {
      void this.close(new DesktopError('worker-unavailable', 'Worker process exited'))
    })
    return await this.request('health', signal)
  }

  async request(method: WorkerRequest['method'], signal: AbortSignal): Promise<WorkerReply> {
    signal.throwIfAborted()
    const child = this.child
    if (this.closed || !child?.connected) throw new DesktopError('worker-unavailable', 'Worker is not connected')
    const id = randomUUID()
    return await new Promise<WorkerReply>((resolve, reject) => {
      const cancel = () => {
        const error = new DesktopError(signal.aborted ? 'cancelled' : 'timeout', 'Diagnostic call cancelled or timed out')
        // All pending calls settle only after the child is quiescent.
        void this.close(error)
      }
      const timer = setTimeout(cancel, this.timeoutMs)
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { cancel(); return }
      child.send({ version: PROTOCOL_VERSION, id, method }, error => {
        if (!error) return
        void this.close(new DesktopError('worker-unavailable', 'IPC send failed', { cause: error }))
      })
    })
  }

  /** Await child exit before the provider slot can be reused. */
  close(error: Error = new DesktopError('worker-unavailable', 'Worker is closing')): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const pendingCalls = [...this.pending.values()]
    this.pending.clear()
    for (const pending of pendingCalls) pending.cleanup()
    const child = this.child
    this.closing = !child || child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>(resolve => {
        child.once('close', () => resolve())
        child.kill()
      })
    this.closing = this.closing.then(() => { for (const pending of pendingCalls) pending.reject(error) })
    return this.closing
  }
}
