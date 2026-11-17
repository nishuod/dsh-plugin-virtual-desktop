import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { assertSupportedPlatform } from './platform.ts'
import { MAX_NATIVE_BYTES, nativeReplySchema, nativeRequestSchema, pipDisplaySchema, type PipDisplay } from './native-contract.ts'
import { NativeTransportError } from './native-client.ts'
import { vmwareCommandTransportSchema } from './vmware-command.ts'

const readySchema = z.strictObject({
  event: z.literal('ready'),
  parentSessionId: z.int().positive(),
  childSessionId: z.int().positive(),
  pipDisplay: pipDisplaySchema.optional(),
}).refine(event => event.parentSessionId !== event.childSessionId)
const errorSchema = z.strictObject({ event: z.literal('error'), message: z.string().max(1000),
  association: z.enum(['active', 'orphan', 'unknown']).optional(), reason: z.string().max(100).optional(), retryAfterMs: z.int().positive().optional(), nextTool: z.string().max(100).optional() })

function connectionError(message: string, details: object = {}): NativeTransportError {
  return Object.assign(new NativeTransportError(/\bEPIPE\b|\bERR_STREAM_DESTROYED\b/.test(message)
    ? '画中画控制通道已关闭；未确认的操作结果未知，请稍后重新连接' : message),
  { reason: 'transport-disconnected', retryable: true, retryAfterMs: 500, nextTool: 'desktop_reset_child_session' }, details)
}
type BrokerProcess = ChildProcessByStdio<Writable, Readable, null>
type Reply = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export interface ChildSessionIdentity {
  parentSessionId: number
  childSessionId: number
  pipDisplay?: PipDisplay
}

/** Private stdio to the Windows companion, which verifies the other end of its pipe. */
export class ChildSessionClient {
  private originalBrokerPid?: number
  private cleanupConfirmed = false
  get ownedBrokerPid(): number | undefined { return this.originalBrokerPid }
  get isCleanupConfirmed(): boolean { return this.cleanupConfirmed }
  private process?: BrokerProcess
  private exit?: Promise<void>
  private directory?: string
  private ready?: Reply
  private identity?: ChildSessionIdentity
  private readonly pending = new Map<string, Reply>()
  private buffer = Buffer.alloc(0)
  private failure?: NativeTransportError
  private closing?: Promise<void>
  private heartbeat?: NodeJS.Timeout
  private heartbeatPending = false
  private readonly recoveryToken = randomUUID()
  private executable?: string

  constructor(private readonly timeoutMs: number, private readonly onDisconnect: (message: string) => void) {}

  async open(signal: AbortSignal): Promise<ChildSessionIdentity> {
    signal.throwIfAborted()
    assertSupportedPlatform()
    const executable = fileURLToPath(new URL('./child-session-host/ChildSessionHost.exe', import.meta.url))
    const bridge = fileURLToPath(new URL('./child-session-bridge.js', import.meta.url))
    try {
      await Promise.all([access(executable), access(bridge)])
    } catch {
      throw new Error('画中画组件缺失，请检查安装包')
    }
    signal.throwIfAborted()
    if (this.failure) throw this.failure
    const directory = await mkdtemp(join(tmpdir(), 'dsh-child-session-'))
    if (this.failure) {
      await rm(directory, { recursive: true, force: true })
      throw this.failure
    }
    this.directory = directory
    this.executable = executable
    try {
      await writeFile(join(directory, 'broker-config.json'), JSON.stringify({
        version: 1, recoveryToken: this.recoveryToken, nodePath: process.execPath, bridgePath: bridge, electronNode: !!process.versions.electron,
      }), { flag: 'wx' })
      signal.throwIfAborted()
      if (this.failure) throw this.failure
      const result = await new Promise<unknown>((resolve, reject) => {
        const startup = AbortSignal.any([signal, AbortSignal.timeout(60000)])
        const cancel = () => this.fail('连接子会话已取消或超时')
        this.ready = { resolve, reject, cleanup: () => startup.removeEventListener('abort', cancel) }
        startup.addEventListener('abort', cancel, { once: true })
        if (startup.aborted) { cancel(); return }
        this.start(executable, directory)
      })
      return result as ChildSessionIdentity
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private start(executable: string, directory: string): void {
    const environment = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'].flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]),
    )
    const child = spawn(executable, ['--broker', directory], {
      stdio: ['pipe', 'pipe', 'ignore'], env: environment, windowsHide: true,
    })
    this.process = child
    this.originalBrokerPid = child.pid
    this.exit = new Promise(resolve => child.once('close', () => resolve()))
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stdin.on('error', () => this.fail('画中画控制管道已断开'))
    child.once('error', () => this.fail('无法启动画中画组件，请检查 .NET 8 桌面运行时'))
    child.once('close', () => this.fail('画中画连接已关闭；未确认的输入结果未知'))
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return
    try {
      const data = Buffer.concat([this.buffer, chunk])
      let start = 0
      for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
        if (end - start > MAX_NATIVE_BYTES) throw new Error('oversized frame')
        this.receiveLine(JSON.parse(data.toString('utf8', start, end)))
        if (this.failure) return
        start = end + 1
      }
      this.buffer = Buffer.from(data.subarray(start))
      if (this.buffer.length > MAX_NATIVE_BYTES) throw new Error('oversized frame')
    } catch {
      this.fail('画中画控制协议异常，连接已关闭')
    }
  }

  private receiveLine(raw: unknown): void {
    const problem = errorSchema.safeParse(raw)
    if (problem.success) {
      const { event: _event, message, ...details } = problem.data
      this.fail(message, details); return
    }
    if (this.ready) {
      const { event: _event, ...identity } = readySchema.parse(raw)
      const ready = this.ready
      this.ready = undefined
      this.identity = identity
      ready.cleanup()
      ready.resolve(this.identity)
      this.startWatchdog()
      return
    }
    const reply = nativeReplySchema.parse(raw)
    const request = this.pending.get(reply.id)
    if (!request) throw new Error('unmatched reply')
    this.pending.delete(reply.id)
    request.cleanup()
    if (reply.ok) request.resolve(reply.value)
    else request.reject(Object.assign(new Error(reply.error ?? '子会话执行器拒绝请求'), reply.details))
  }

  async call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (this.failure) throw this.failure
    const child = this.process
    if (this.closing || !this.identity || !child?.stdin.writable) throw connectionError('画中画执行器未就绪')
    const id = randomUUID()
    const line = JSON.stringify(nativeRequestSchema.parse({ version: 1, id, method, payload }))
    // AppBroker applies a bounded per-command deadline. Leave time for worker identity rechecks and IPC.
    const timeoutMs = method === 'appCommand'
      ? vmwareCommandTransportSchema.parse(payload).timeoutMs + 15000
      : this.timeoutMs
    if (Buffer.byteLength(line) > MAX_NATIVE_BYTES || this.pending.size >= 16) throw new Error('子会话请求过大或过多')
    return await new Promise((resolve, reject) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      const cancel = () => this.fail('子会话请求已取消或超时；请核对实际结果')
      this.pending.set(id, { resolve, reject, cleanup: () => deadline.removeEventListener('abort', cancel) })
      deadline.addEventListener('abort', cancel, { once: true })
      if (deadline.aborted) { cancel(); return }
      child.stdin.write(line + '\n', error => { if (error) this.fail('画中画控制管道已断开') })
    })
  }

  private startWatchdog(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => { void this.checkHeartbeat() }, 5000)
    this.heartbeat.unref()
  }

  private async checkHeartbeat(): Promise<void> {
    if (this.failure || this.closing || this.heartbeatPending) return
    this.heartbeatPending = true
    try { await this.call('status', null, AbortSignal.timeout(Math.min(this.timeoutMs, 10000))) }
    catch { this.fail('画中画执行器心跳失联，已撤销授权并清理子会话；请使用 desktop_reset_child_session 检查清理状态') }
    finally { this.heartbeatPending = false }
  }

  private fail(message: string, details: object = {}): void {
    if (this.failure) return
    this.rejectAll(connectionError(message, details))
    this.onDisconnect(message)
    void this.close().catch(() => {})
  }

  private rejectAll(error: NativeTransportError): void {
    this.failure = error
    const replies = [...this.pending.values(), ...(this.ready ? [this.ready] : [])]
    this.ready = undefined
    this.pending.clear()
    for (const reply of replies) { reply.cleanup(); reply.reject(error) }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    if (!this.failure) this.rejectAll(connectionError('画中画已结束'))
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    const closing = this.closing = this.closeProcess()
    // Retain ownership on failed cleanup, but allow an explicit reset to retry.
    void closing.catch(() => { if (this.closing === closing) this.closing = undefined })
    return closing
  }

  private async closeProcess(): Promise<void> {
    const child = this.process
    if (child && this.exit) {
      child.stdin.end()
      const closed = await Promise.race([this.exit.then(() => true), delay(12000, false, { ref: false })])
      if (!closed) {
        child.kill()
        const killed = await Promise.race([this.exit.then(() => true), delay(3000, false, { ref: false })])
        if (!killed) throw connectionError('画中画组件仍在退出，请稍后重新连接', { reason: 'connection-closing' })
      }
    }
    if (this.directory && this.executable) await this.resetOwnedAssociation()
    // Windows logoff may release the bridge's working directory after the viewer exits.
    // Retry only filesystem cleanup; never reconnect or replay input.
    if (this.directory) await rm(this.directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    this.directory = undefined
    this.process = undefined
    this.identity = undefined
    this.cleanupConfirmed = true
  }
  private async resetOwnedAssociation(): Promise<void> {
    const helper = spawn(this.executable!, ['--reset-owned', this.directory!, this.recoveryToken], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => { helper.kill(); reject(connectionError('子会话清理超时', { reason: 'connection-closing' })) }, 15000)
      helper.stdout.on('data', (data: Buffer) => { if (output.length < 4096) output += data.toString('utf8') })
      helper.once('error', () => { clearTimeout(timer); reject(connectionError('无法启动子会话清理组件')) })
      helper.once('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else {
          let details: object = {}
          try { const parsed = errorSchema.safeParse(JSON.parse(output)); if (parsed.success) details = parsed.data } catch {}
          reject(connectionError('未确认本插件子会话已清理；保留归属记录供 reset 重试', details))
        }
      })
    })
  }

}
