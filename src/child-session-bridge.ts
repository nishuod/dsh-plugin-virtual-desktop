import { once } from 'node:events'
import { open } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import koffi from 'koffi'
import { z } from 'zod'
import { AppBrokerTransportError } from './app-broker-client.ts'
import { childDelivery } from './child-delivery.ts'
import { NativeClient, NativeTransportError } from './native-client.ts'
import {
  cropSchema, frameSchema, MAX_NATIVE_BYTES, nativeReplySchema, nativeRequestSchema, nativeRestoreResultSchema, restoreWindowSchema, windowFailure, NativeWindowError,
  operationSchema, receiptSchema, runtimeStateSchema, windowSchema, type DesktopRuntimeState, type DesktopWindow,
} from './native-contract.ts'
import { valueCheckSchema } from './task-contract.ts'
import { childLaunchSchema, launchChildExecutable, type ChildLauncher, type ChildLaunchReceipt } from './child-launch.ts'
import {
  matchesVmwareCommandTarget, runVmwareCommand, sameWindowsPath, vmwareCommandResultSchema, vmwareCommandTransportSchema,
  vmwareProcessIdentitySchema, type VmwareCommandResult, type VmwareCommandRunner,
} from './vmware-command.ts'

const bindingSchema = z.strictObject({
  version: z.literal(1),
  pipePath: z.string().regex(/^\\\\\.\\pipe\\DSH\.ChildSession\.[0-9a-f]{32}$/),
  parentSessionId: z.int().positive().lt(0xffffffff),
  childSessionId: z.int().positive().lt(0xffffffff),
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
}).refine(value => value.parentSessionId !== value.childSessionId)
const selectSchema = z.strictObject({ windowId: z.uuid(), foreground: z.boolean(), expectedEpoch: z.int().nonnegative().optional() })
const captureSchema = z.strictObject({
  source: z.literal('window'),
  crop: cropSchema.optional(),
  check: valueCheckSchema.optional(),
  verifyVisual: z.literal(true).optional(),
})
type Binding = z.infer<typeof bindingSchema>
type Request = z.infer<typeof nativeRequestSchema>
type NativeCall = (method: Request['method'], payload: unknown, signal: AbortSignal) => Promise<unknown>
type SessionIdentity = { readonly childSessionId?: number; assertSession(): void; assertPid(pid: number): void }
const decoder = new TextDecoder('utf-8', { fatal: true })

async function readBinding(directory: string): Promise<Binding> {
  const file = await open(join(directory, 'broker-binding.json'), 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error('Invalid child broker binding file')
    const bytes = Buffer.alloc(info.size + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== info.size) throw new Error('Child broker binding changed while reading')
    return bindingSchema.parse(JSON.parse(decoder.decode(bytes.subarray(0, bytesRead))))
  } finally {
    await file.close()
  }
}

class WindowsChildIdentity implements SessionIdentity {
  private readonly kernel = koffi.load('kernel32.dll')
  private readonly user = koffi.load('user32.dll')
  private readonly wts = koffi.load('wtsapi32.dll')
  private readonly processSession = this.kernel.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t* session)')
  private readonly activeConsole = this.kernel.func('uint32_t __stdcall WTSGetActiveConsoleSessionId()')
  private readonly openDesktop = this.user.func('void* __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)')
  private readonly desktopName = this.user.func('int __stdcall GetUserObjectInformationW(void* object, int index, _Out_ void* name, uint32_t size, _Out_ uint32_t* required)')
  private readonly closeDesktop = this.user.func('int __stdcall CloseDesktop(void* desktop)')
  private readonly querySession = this.wts.func('int __stdcall WTSQuerySessionInformationW(void* server, uint32_t session, int field, _Out_ void** data, _Out_ uint32_t* size)')
  private readonly freeWts = this.wts.func('void __stdcall WTSFreeMemory(void* data)')

  constructor(private readonly binding: Binding) {}
  get childSessionId(): number { return this.binding.childSessionId }

  assertPid(pid: number): void {
    const session = [0]
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new NativeWindowError('identity-changed', '目标进程身份无效')
    if (!this.processSession(pid, session)) throw new NativeWindowError('exited', '目标进程已退出或不可查询，请重新发现窗口')
    if (session[0] !== this.binding.childSessionId) throw new NativeWindowError('identity-changed', '目标进程不在已验证的 Windows 子会话')
  }

  assertSession(): void {
    // The parent broker resolves the associated child using WTSGetChildSessionId.
    // This process independently verifies where it actually landed.
    this.assertPid(process.pid)
    if (this.binding.childSessionId === this.activeConsole() ||
        this.sessionValue(8, 4, 'int32_t') !== 0 || // WTSConnectState = WTSActive
        this.sessionValue(16, 2, 'uint16_t') !== 2) { // WTSClientProtocolType = RDP
      throw new Error('Windows 子会话已断开或不可交互')
    }
    const desktop = this.openDesktop(0, 0, 1) // DESKTOP_READOBJECTS
    if (!desktop) throw new Error('子会话的输入桌面不可用')
    try {
      const name = Buffer.alloc(512)
      const size = [0]
      if (!this.desktopName(desktop, 2, name, name.length, size) || size[0] < 2 || size[0] > name.length ||
          name.subarray(0, size[0] - 2).toString('utf16le') !== 'Default') {
        throw new Error('子会话必须使用 Default 输入桌面')
      }
    } finally {
      this.closeDesktop(desktop)
    }
  }

  private sessionValue(field: number, minBytes: number, type: 'int32_t' | 'uint16_t'): number {
    const data = [null]
    const size = [0]
    if (!this.querySession(null, this.binding.childSessionId, field, data, size)) throw new Error('无法查询 Windows 子会话')
    try {
      if (!data[0] || size[0] < minBytes) throw new Error('Windows 子会话状态无效')
      return koffi.decode(data[0], type) as number
    } finally {
      if (data[0]) this.freeWts(data[0])
    }
  }
}

/** The bridge keeps its own allowed window identities and delegates frame/epoch binding to the worker. */
export function createChildDispatcher(identity: SessionIdentity, call: NativeCall, launch: ChildLauncher = launchChildExecutable,
  runCommand: VmwareCommandRunner = runVmwareCommand) {
  const launches = new Map<string, { key: string; result: Promise<ChildLaunchReceipt> }>()
  const appCommands = new Map<string, { key: string; revision: number; result: Promise<VmwareCommandResult> }>()
  let activeAppCommand: AbortController | undefined
  let windows = new Map<string, DesktopWindow>()
  let selected: DesktopWindow | undefined
  let revision = 0
  let discoveryVersion = 0
  let discoveryCounts: { worker: number; session: number } | undefined

  function discoveryState(value: unknown, startedDiscoveryVersion: number) {
    return addDiscovery(runtimeStateSchema.parse(value), startedDiscoveryVersion)
  }
  function addDiscovery<T extends DesktopRuntimeState>(state: T, startedDiscoveryVersion: number): T {
    const report = state.windowDiscovery
    if (report) {
      // Session eligibility is established only by the bridge, never by the worker.
      delete report.sessionEligible
      if (startedDiscoveryVersion === discoveryVersion && discoveryCounts?.worker === report.workerEligible) {
        report.sessionEligible = discoveryCounts.session
      }
    }
    return state
  }

  function verifyTarget(target: DesktopWindow | undefined): DesktopWindow {
    identity.assertSession()
    if (!target) throw new Error('请先选择子会话中的目标窗口')
    identity.assertPid(target.pid)
    return target
  }

  function verifyAfter(target: DesktopWindow, startedRevision: number): void {
    if (revision !== startedRevision) throw new Error('子会话窗口授权已撤销')
    verifyTarget(target)
  }

  return async (request: Request, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted()
    const startedRevision = revision
    const startedDiscoveryVersion = discoveryVersion
    switch (request.method) {
      case 'appCommandScope':
        throw new Error('应用命令身份校验仅供子会话桥接使用')
      case 'appCommand': {
        const input = vmwareCommandTransportSchema.parse(request.payload)
        const target = verifyTarget(selected)
        const childSessionId = identity.childSessionId
        if (!childSessionId || target.id !== input.windowId || target.pid !== input.pid ||
          !sameWindowsPath(target.imagePath, input.vmwarePath)) {
          throw new NativeWindowError('identity-changed', 'VMware 命令目标与已授权子会话窗口不一致')
        }
        const scope = { expectedEpoch: input.expectedEpoch, windowId: target.id, pid: target.pid, vmwarePath: input.vmwarePath }
        const key = JSON.stringify(input)
        const previous = appCommands.get(input.operationId)
        if (previous) {
          if (previous.key !== key) throw new Error('operationId 已用于不同的 VMware 命令')
          if (previous.revision !== startedRevision) throw new Error('原 VMware 命令许可已撤销，不会重放')
          const result = await previous.result
          signal.throwIfAborted()
          await call('appCommandScope', { ...scope, invalidateFrame: false }, signal)
          verifyAfter(target, startedRevision)
          return result
        }
        if (activeAppCommand) throw new Error('VMware 命令执行中，不会排队或重放')
        if (appCommands.size >= 128) throw new Error('本次连接 VMware 命令次数已达上限')
        const active = activeAppCommand = new AbortController()
        const commandSignal = AbortSignal.any([signal, active.signal])
        const check = () => {
          commandSignal.throwIfAborted()
          verifyAfter(target, startedRevision)
        }
        const result = (async (): Promise<VmwareCommandResult> => {
          try {
            const nativeIdentity = vmwareProcessIdentitySchema.parse(await call('appCommandScope', {
              ...scope, invalidateFrame: input.command !== 'list',
            }, signal))
            check()
            const startedAt = performance.now()
            let response: VmwareCommandResult
            try {
              response = vmwareCommandResultSchema.parse(await runCommand({
                operationId: input.operationId, vmwarePath: input.vmwarePath, vmwarePid: target.pid,
                command: input.command, vmxPath: input.vmxPath, timeoutMs: input.timeoutMs, ...nativeIdentity,
              }, commandSignal, check, pid => { check(); identity.assertPid(pid) }))
            } catch (error) {
              if (!(error instanceof AppBrokerTransportError)) throw error
              // The application pipe is separate from the control transport. A lost reply cannot prove the
              // command ran or justify replay. Recheck the authorization before returning this receipt.
              response = {
                status: 'unknown', state: 'unknown', code: 'app-broker-disconnected', message: error.message,
                childSessionId, vmx: input.vmxPath ?? null, vmPid: null, exitCode: null, vmrunPid: null,
                evidence: { vmrunList: [], processCheck: [] }, elapsedMs: performance.now() - startedAt,
                argv: [], stdout: '', stderr: '', fallbackAllowed: false,
                transportError: { phase: error.phase, reason: error.reason },
              }
            }
            check()
            const confirmedIdentity = vmwareProcessIdentitySchema.parse(await call('appCommandScope', {
              ...scope, invalidateFrame: false,
            }, signal))
            check()
            if (confirmedIdentity.vmwareHwnd !== nativeIdentity.vmwareHwnd ||
              confirmedIdentity.vmwareBirth !== nativeIdentity.vmwareBirth ||
              response.childSessionId !== childSessionId || !matchesVmwareCommandTarget(response, input.vmxPath)) {
              throw new Error('VMware 回执窗口、进程或子会话身份不一致，结果未知')
            }
            return response
          } finally {
            if (activeAppCommand === active) activeAppCommand = undefined
          }
        })()
        appCommands.set(input.operationId, { key, revision: startedRevision, result })
        return await result
      }
      case 'launch': {
        const input = childLaunchSchema.parse(request.payload)
        identity.assertSession()
        const key = JSON.stringify(input)
        const previous = launches.get(input.operationId)
        if (previous) {
          if (previous.key !== key) throw new Error('operationId 已用于不同的启动请求')
          return await previous.result
        }
        if (launches.size >= 128) throw new Error('本次连接启动次数已达上限')
        const result = (async (): Promise<ChildLaunchReceipt> => {
          const state = runtimeStateSchema.parse(await call('status', null, signal))
          const check = () => {
            signal.throwIfAborted()
            identity.assertSession()
            if (revision !== startedRevision || state.epoch !== input.expectedEpoch || !['observing', 'enabled'].includes(state.status)) {
              throw new Error('子会话状态已变化，未启动应用')
            }
          }
          check()
          const process = await launch(input.path, check, pid => { identity.assertSession(); identity.assertPid(pid) })
          return { operationId: input.operationId, ...process, outcome: 'started',
            message: '已在子会话创建应用进程；不代表窗口已就绪。请刷新窗口并绑定目标，未自动重试或切换到主会话。' }
        })()
        launches.set(input.operationId, { key, result })
        return await result
      }
      case 'enable': {
        identity.assertSession()
        const state = discoveryState(await call('enable', request.payload, signal), startedDiscoveryVersion)
        identity.assertSession()
        return state
      }
      case 'windows': {
        z.null().parse(request.payload)
        identity.assertSession()
        discoveryVersion++
        discoveryCounts = undefined
        const listed = z.array(windowSchema).max(150).parse(await call('windows', null, signal))
        identity.assertSession()
        if (revision !== startedRevision) throw new Error('子会话窗口授权已撤销')
        const eligible = listed.filter(window => {
          try { identity.assertPid(window.pid); return true } catch { return false }
        })
        windows = new Map(eligible.map(window => [window.id, window]))
        discoveryCounts = { worker: listed.length, session: eligible.length }
        discoveryVersion++
        return eligible
      }
      case 'select': {
        revision++
        activeAppCommand?.abort(new Error('子会话窗口授权已撤销'))
        const input = selectSchema.parse(request.payload)
        const target = verifyTarget(windows.get(input.windowId))
        // A stale approved selection must preserve the existing binding.
        if (input.expectedEpoch === undefined) selected = undefined
        const reply = await call('select', { ...input, windowId: target.id, foreground: false }, signal)
        selected = undefined
        const state = discoveryState(reply, startedDiscoveryVersion)
        verifyAfter(target, startedRevision + 1)
        if (state.window?.id !== target.id || state.window.pid !== target.pid) throw new Error('执行器返回了不同的子会话窗口')
        selected = target
        return state
      }
      case 'capture': {
        const input = captureSchema.parse(request.payload)
        if (input.crop && input.check) throw new Error('验收须观察完整目标窗口')
        const target = verifyTarget(selected)
        const frame = frameSchema.parse(await call('capture', input, signal))
        verifyAfter(target, startedRevision)
        if (frame.source !== 'window' || frame.windowId !== target.id) throw new Error('执行器返回了不同的子会话截图')
        return frame
      }
      case 'restore': {
        const input = restoreWindowSchema.parse(request.payload)
        const target = verifyTarget(selected)
        if (target.id !== input.windowId || target.pid !== input.pid) throw new Error('恢复目标与已授权子会话窗口不一致')
        const result = nativeRestoreResultSchema.parse(await call('restore', input, signal))
        signal.throwIfAborted()
        verifyAfter(target, startedRevision)
        const windowId = result.state === 'restored' ? result.window.id : result.windowId
        const pid = result.state === 'restored' ? result.window.pid : result.pid
        if (windowId !== target.id || pid !== target.pid || result.epoch !== input.expectedEpoch) throw new Error('执行器返回了不同的恢复窗口身份或代次')
        if (result.state === 'restoring') return result
        selected = result.window
        windows.set(selected.id, selected)
        return addDiscovery(result, startedDiscoveryVersion)
      }
      case 'execute': {
        const operation = operationSchema.parse(request.payload)
        if (childDelivery(operation.action) !== operation.delivery) throw new Error('子会话动作传递模式无效')
        const target = verifyTarget(selected)
        const receipt = receiptSchema.parse(await call('execute', operation, signal))
        verifyAfter(target, startedRevision)
        if (receipt.operationId !== operation.operationId || (receipt.after &&
            (receipt.after.source !== 'window' || receipt.after.windowId !== target.id))) {
          throw new Error('执行器返回了不同动作或窗口的回执')
        }
        return receipt
      }
      case 'resume':
        z.null().parse(request.payload)
        if (selected) verifyTarget(selected)
        else identity.assertSession()
        return discoveryState(await call('resume', null, signal), startedDiscoveryVersion)
      case 'stop':
      case 'shutdown':
        z.null().parse(request.payload)
        selected = undefined
        windows.clear()
        discoveryCounts = undefined
        discoveryVersion++
        revision++
        activeAppCommand?.abort(new Error('子会话窗口授权已撤销'))
        return discoveryState(await call(request.method, null, signal), startedDiscoveryVersion)
      case 'pause':
        z.null().parse(request.payload)
        revision++
        activeAppCommand?.abort(new Error('子会话窗口授权已撤销'))
        return discoveryState(await call('pause', null, signal), startedDiscoveryVersion)
      case 'status':
        z.null().parse(request.payload)
        identity.assertSession()
        return discoveryState(await call(request.method, null, signal), startedDiscoveryVersion)
    }
  }
}

async function writeLine(socket: Socket, value: unknown): Promise<void> {
  const line = JSON.stringify(value)
  if (Buffer.byteLength(line) > MAX_NATIVE_BYTES) throw new Error('Child bridge reply exceeds the wire limit')
  await new Promise<void>((resolve, reject) => socket.write(`${line}\n`, 'utf8', error => error ? reject(error) : resolve()))
}

async function serve(binding: Binding, identity: SessionIdentity): Promise<void> {
  identity.assertSession()
  const socket = createConnection({ path: binding.pipePath })
  const lifetime = new AbortController()
  const disconnect = () => lifetime.abort(new Error('Windows child broker disconnected'))
  socket.on('error', disconnect)
  socket.once('end', disconnect)
  socket.once('close', disconnect)
  const native = new NativeClient(30000, true)
  function verifyWorker(): void {
    try {
      if (native.pid === undefined) throw new Error('Missing native worker PID')
      identity.assertPid(native.pid)
    } catch {
      throw new NativeTransportError('无法核实子会话执行器进程')
    }
  }
  const dispatch = createChildDispatcher(identity, async (method, payload, signal) => {
    if (native.pid !== undefined) verifyWorker()
    const result = await native.call(method, payload, signal)
    if (method === 'enable') verifyWorker()
    return result
  })
  const inFlight = new Set<string>()
  let normalCallActive = false
  let ending = false
  const line = Buffer.allocUnsafe(MAX_NATIVE_BYTES)
  let size = 0
  let heartbeat: NodeJS.Timeout | undefined

  function accept(line: Buffer): void {
    lifetime.signal.throwIfAborted()
    const request = nativeRequestSchema.parse(JSON.parse(decoder.decode(line)))
    if (ending || inFlight.size >= 16 || inFlight.has(request.id)) throw new Error('Invalid or excessive child bridge requests')
    inFlight.add(request.id)
    if (request.method === 'shutdown') ending = true
    const priority = request.method === 'status' || request.method === 'pause' || request.method === 'stop' || request.method === 'shutdown'
    const busy = !priority && normalCallActive
    if (!priority && !busy) normalCallActive = true
    void (async () => {
      const reply = { version: 1 as const, id: request.id }
      let response
      try {
        if (busy) throw new Error('子会话执行器正忙；未排队执行')
        const value = await dispatch(request, lifetime.signal)
        response = { ...reply, ok: true, value }
      } catch (error) {
        if (error instanceof NativeTransportError) throw error
        response = { ...reply, ok: false, value: null, error: error instanceof Error ? error.message.slice(0, 1000) : '子会话执行器拒绝', ...(windowFailure(error) ? { details: windowFailure(error) } : {}) }
      } finally {
        if (!priority && !busy) normalCallActive = false
      }
      if (!lifetime.signal.aborted) await writeLine(socket, nativeReplySchema.parse(response))
      if (request.method === 'shutdown') socket.end()
    })().catch(error => socket.destroy(error)).finally(() => {
      inFlight.delete(request.id)
    })
  }

  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(10000) })
    identity.assertSession()
    await writeLine(socket, { version: 1, nonce: binding.nonce, sessionId: binding.childSessionId })
    heartbeat = setInterval(() => {
      try { identity.assertSession() } catch (error) { socket.destroy(error as Error) }
    }, 1000)
    for await (const chunk of socket) {
      const bytes: Buffer = chunk
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        const length = end - offset
        if (size + length > MAX_NATIVE_BYTES) throw new Error('Child bridge request exceeds the wire limit')
        bytes.copy(line, size, offset, end)
        size += length
        if (newline >= 0) {
          accept(line.subarray(0, size))
          size = 0
        }
        offset = end + 1
      }
    }
    if (size) throw new Error('Incomplete child bridge request')
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    disconnect()
    socket.destroy()
    await native.close()
  }
}

async function main(): Promise<void> {
  const directory = process.argv[2]
  if (process.platform !== 'win32' || process.argv.length !== 3 || !directory || !isAbsolute(directory)) {
    throw new Error('Usage on Windows: child-session-bridge.js <absolute run directory>')
  }
  const binding = await readBinding(directory)
  await serve(binding, new WindowsChildIdentity(binding))
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  void main().catch(() => { process.exitCode = 1 })
}
