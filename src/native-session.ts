import { z } from 'zod'
import type { PrivacyOptions } from './privacy.ts'
import type { VisualOptions } from './visual-targets.ts'
import { randomUUID } from 'node:crypto'
import { NativeClient, NativeTransportError } from './native-client.ts'
import { ChildSessionClient, type ChildSessionIdentity } from './child-session-client.ts'
import { childDelivery } from './child-delivery.ts'
import {
  frameSchema, windowSchema, runtimeStateSchema, nativeRestoreResultSchema, restoreWindowResultSchema, receiptSchema, operationSchema, cropSchema,
  type DesktopBackend, type DesktopFrame, type DesktopWindow, type DesktopRuntimeState, type DesktopReceipt, type RestoreWindowResult,
} from './native-contract.ts'
import type { ValueCheck } from './task-contract.ts'
import { childLaunchSchema, childLaunchReceiptSchema, type ChildLaunchReceipt } from './child-launch.ts'
import { FrameStore } from './frame-store.ts'
import { matchesVmwareCommandTarget, sameWindowsPath, vmwareCommandRequestSchema, vmwareCommandResultSchema, type VmwareCommandRequest, type VmwareCommandResult } from './vmware-command.ts'

export interface NativeOptions { timeoutMs: number; frameAgeMs: number; maxDimension: number; imageBytes: number; lifecycleJoinMs?: number; privacy?: PrivacyOptions; visualCandidates?:VisualOptions }
type Transport = NativeClient | ChildSessionClient

export class DesktopLifecycleError extends NativeTransportError {
  readonly retryable = true
  readonly retryAfterMs = 500
  readonly nextTool = 'desktop_open_child_session'
  constructor(message: string, readonly reason = 'connection-closing') { super(message) }
}

function inactiveState(backend: DesktopBackend, status: 'disabled' | 'stopped' | 'failed', lastResult: string): DesktopRuntimeState {
  return {
    backend, isolated: false, status, epoch: 0, window: null, foregroundAllowed: false,
    inputMode: 'ask-each-action', lastResult,
    capabilities: {
      windowCapture: true, desktopCapture: backend === 'windows-attended', regionCapture: true,
      clipboard: false, autonomousTask: false,
    },
  }
}

/** Host authorization surface; each enable selects one transport for all operations. */
export class NativeSession {
  private client?: Transport
  private opening?: AbortController
  private openingDone?: Promise<void>
  private closing?: Promise<void>
  private stopping?: Promise<void>
  private resetting?: Promise<DesktopRuntimeState>
  private readonly ownedChildren = new Set<ChildSessionClient>()
  private readonly frames = new FrameStore()
  private identity?: ChildSessionIdentity
  private connectionId?: string
  private state = inactiveState('windows-attended', 'disabled', '尚未连接；可调用 desktop_open_child_session 请求批准并打开 PiP，也可在面板选择桌面模式')

  constructor(private readonly options: NativeOptions, private readonly onDisconnect: () => void = () => {}) {}

  async enable(signal: AbortSignal, backend: DesktopBackend = 'windows-attended'): Promise<DesktopRuntimeState> {
    signal.throwIfAborted()
    await this.joinLifecycle(signal)
    // Even an empty async join yields. A close may have begun in that microtask
    // gap; reserve startup only after every currently visible teardown joins.
    while (this.stopping || this.closing || this.resetting) await this.joinLifecycle(signal)
    signal.throwIfAborted()
    if (this.opening) throw new DesktopLifecycleError('正在连接桌面，请稍后重新读取状态', 'connection-busy')
    const canReplace = this.state.status === 'stopped' || this.state.status === 'failed'
    if (this.client && this.state.backend !== backend && !canReplace) {
      throw Object.assign(new Error('请先结束当前桌面连接，再切换模式'), { nextTool: 'desktop_stop_task' })
    }
    const opening = this.opening = new AbortController()
    let opened!: () => void
    this.openingDone = new Promise<void>(resolve => { opened = resolve })
    const startup = AbortSignal.any([signal, opening.signal])
    let newClient: Transport | undefined
    let allocatedConnection = false
    try {
      if (canReplace) {
        const previous = this.client
        this.client = undefined
        await previous?.close()
      }
      startup.throwIfAborted()
      if (!this.client) {
        const child = backend === 'windows-child-session'
        this.state = inactiveState(backend, 'disabled', child ? '正在建立 Windows 画中画连接' : '正在打开本机执行器')
        this.identity = undefined
        allocatedConnection = true
        this.connectionId = randomUUID()
        await this.frames.begin(this.connectionId)
        startup.throwIfAborted()
        this.client = newClient = child
          ? new ChildSessionClient(this.options.timeoutMs, message => {
            if (this.client !== newClient) return
            this.fail(message)
            this.onDisconnect()
          })
          : new NativeClient(this.options.timeoutMs)
        if (newClient instanceof ChildSessionClient) {
          this.ownedChildren.add(newClient)
          this.identity = await newClient.open(startup)
        }
      }
      startup.throwIfAborted()
      return await this.stateCall('enable', {
        frameAgeMs: this.options.frameAgeMs, maxDimension: this.options.maxDimension, imageBytes: this.options.imageBytes, ...(this.options.privacy ? { privacy: this.options.privacy } : {}),...(this.options.visualCandidates?{visualCandidates:this.options.visualCandidates}:{}),
      }, startup)
    } catch (error) {
      // Cancellation can occur while frame storage is opening, before a transport
      // exists. That connection still owns a directory which must be drained.
      if (allocatedConnection && !this.closing && (!newClient || this.client === newClient)) {
        this.client = undefined
        this.fail(error instanceof Error ? error.message : '无法开启桌面连接')
        await newClient?.close().catch(() => {})
      }
      if (error && typeof error === 'object' && 'nextTool' in error && error.nextTool === 'desktop_open_child_session') {
        Object.assign(error, { nextTool: 'desktop_reset_child_session' })
      }
      throw error
    } finally {
      if (this.opening === opening) this.opening = undefined
      opened()
      this.openingDone = undefined
    }
  }

  async status(signal: AbortSignal): Promise<DesktopRuntimeState> {
    signal.throwIfAborted()
    if (this.opening || this.closing || this.stopping || !this.client || this.state.status === 'failed') return structuredClone(this.state)
    // Closing a polling view must not close a worker running an owner's task.
    const state = await this.stateCall('status', null, AbortSignal.timeout(31000)).catch(error => {
      if (this.inactiveConnection()) return structuredClone(this.state)
      throw error
    })
    signal.throwIfAborted()
    return state
  }

  async windows(signal: AbortSignal): Promise<DesktopWindow[]> {
    return z.array(windowSchema).max(150).parse(await this.call('windows', null, signal))
  }

  async launch(path: string, operationId: string, connectionId: string, expectedEpoch: number, signal: AbortSignal): Promise<ChildLaunchReceipt> {
    const state = await this.status(signal)
    if (!this.identity || state.backend !== 'windows-child-session' || !state.isolated ||
        state.connectionId !== connectionId || state.epoch !== expectedEpoch || !['observing', 'enabled'].includes(state.status)) {
      throw new Error('子会话连接已变化，请重新读取状态后启动应用')
    }
    const input = childLaunchSchema.parse({ path, operationId, expectedEpoch })
    const receipt = childLaunchReceiptSchema.parse(await this.call('launch', input, signal))
    if (receipt.operationId !== operationId) throw new Error('启动回执不匹配；请检查窗口，不要自动重试')
    return receipt
  }

  async appCommand(value: VmwareCommandRequest, scope: DesktopRuntimeState, signal: AbortSignal,
    beforeDispatch?: () => void): Promise<VmwareCommandResult> {
    const input = vmwareCommandRequestSchema.parse(value)
    const state = await this.status(signal)
    const target = state.window
    const approved = scope.window
    if (this.opening || this.closing || this.stopping || !this.identity || !state.connectionId ||
      state.backend !== 'windows-child-session' || scope.backend !== state.backend || !state.isolated || !scope.isolated ||
      state.status !== 'enabled' || scope.status !== state.status ||
      state.connectionId !== scope.connectionId || state.epoch !== scope.epoch ||
      state.childSessionId !== this.identity.childSessionId || state.childSessionId !== scope.childSessionId ||
      state.parentSessionId !== this.identity.parentSessionId || state.parentSessionId !== scope.parentSessionId ||
      state.childSessionId === state.parentSessionId || !target || !approved ||
      target.id !== approved.id || target.pid !== approved.pid ||
      !sameWindowsPath(target.imagePath, input.vmwarePath) || !sameWindowsPath(approved.imagePath, input.vmwarePath)) {
      throw new NativeTransportError('VMware 应用命令的子会话或窗口授权已变化')
    }
    signal.throwIfAborted()
    beforeDispatch?.()
    const result = vmwareCommandResultSchema.parse(await this.call('appCommand', {
      ...input, expectedEpoch: state.epoch, windowId: target.id, pid: target.pid,
    }, signal))
    signal.throwIfAborted()
    if (result.childSessionId !== state.childSessionId || !matchesVmwareCommandTarget(result, input.vmxPath)) {
      throw new NativeTransportError('VMware 命令回执与已授权目标不匹配，结果未知')
    }
    return result
  }

  async select(windowId: string, foreground: boolean, signal: AbortSignal, expectedEpoch?: number): Promise<DesktopRuntimeState> {
    if (expectedEpoch !== undefined && (!this.identity || this.state.backend !== 'windows-child-session')) {
      throw new Error('画中画连接已变化，请重新发现并批准')
    }
    return await this.stateCall('select', {
      windowId,
      foreground: this.identity ? false : foreground,
      ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
    }, signal)
  }

  async restore(windowId: string, pid: number, connectionId: string, expectedEpoch: number, signal: AbortSignal): Promise<RestoreWindowResult> {
    const scopeChanged = () => Object.assign(new Error('窗口恢复许可已变化，请重新读取当前连接与窗口身份'), { reason: 'identity-changed', nextTool: 'desktop_get_task_status' })
    const assertScope = () => {
      signal.throwIfAborted()
      const state = this.state
      if (this.closing || this.stopping || this.opening || !this.client || state.status !== 'enabled' ||
          state.connectionId !== connectionId || state.epoch !== expectedEpoch ||
          state.window?.id !== windowId || state.window.pid !== pid) throw scopeChanged()
    }
    assertScope()
    const result = nativeRestoreResultSchema.parse(await this.call('restore', { windowId, pid, expectedEpoch }, signal))
    assertScope()
    if (result.epoch !== expectedEpoch) throw scopeChanged()
    if (result.state === 'restoring') {
      if (result.windowId !== windowId || result.pid !== pid) throw scopeChanged()
      return {state:result.state, retryAfterMs:result.retryAfterMs, nextTool:result.nextTool}
    }
    if (result.window.id !== windowId || result.window.pid !== pid) throw scopeChanged()
    const {state, verified, nextTool, ...runtime} = result
    return restoreWindowResultSchema.parse({ ...this.bindRuntimeState(runtime), state, verified, nextTool })
  }

  async capture(source: 'window' | 'desktop', crop: unknown, signal: AbortSignal, check?: ValueCheck, verifyVisual = false): Promise<DesktopFrame> {
    if (source === 'desktop' && !this.state.capabilities.desktopCapture) throw new Error('画中画试验版只采集已授权的窗口')
    const region = crop === undefined ? undefined : cropSchema.parse(crop)
    const frame = frameSchema.parse(await this.call('capture', {
      source,
      ...(region ? { crop: region } : {}),
      ...(check ? { check } : {}),
      ...(verifyVisual ? { verifyVisual: true } : {}),
    }, signal))
    return await this.frames.save(frame)
  }

  async execute(value: unknown, signal: AbortSignal): Promise<DesktopReceipt> {
    const operation = operationSchema.parse(value)
    if (this.state.backend === 'windows-child-session') operation.delivery = childDelivery(operation.action)
    const receipt = receiptSchema.parse(await this.call('execute', operation, signal))
    if (receipt.after) receipt.after = await this.frames.save(receipt.after)
    return receipt
  }

  async control(command: 'pause' | 'resume' | 'stop', signal: AbortSignal): Promise<DesktopRuntimeState> {
    signal.throwIfAborted()
    if (command !== 'stop') {
      if (this.stopping || this.closing) throw new DesktopLifecycleError('桌面正在结束，请稍后重试')
      return await this.stateCall(command, null, signal)
    }
    if (this.stopping) { await this.joinLifecycle(signal); return structuredClone(this.state) }
    const run = this.stopInternal(signal)
    const stopping = this.stopping = run.then(() => {})
    // A caller may leave while Windows logoff is still joining. Keep the promise observed.
    void stopping.catch(() => {})
    try { return await run } finally { if (this.stopping === stopping) this.stopping = undefined }
  }

  /** Idempotent recovery: only clients allocated by this NativeSession are eligible. */
  trackOwnedChildRelease(): () => number[] {
    // Capture only this session's retained handles, before task stop can drain them.
    // An opening client may receive its PID while cancellation is joining.
    const eligible = [...this.ownedChildren].filter(child => !child.isCleanupConfirmed)
    return () => [...new Set(eligible.filter(child => child.isCleanupConfirmed)
      .map(child => child.ownedBrokerPid).filter((pid): pid is number => Number.isInteger(pid) && pid! > 0))]
  }

  resetChildSession(signal: AbortSignal): Promise<DesktopRuntimeState> {
    signal.throwIfAborted()
    if (this.resetting) return this.resetting
    if (this.client && this.state.backend !== 'windows-child-session') {
      return Promise.reject(new Error('reset 仅清理本插件拥有的子会话，不终止本机桌面执行器'))
    }
    const resetting = this.resetting = (async () => {
      await this.close().catch(() => {})
      for (const child of this.ownedChildren) {
        await child.close()
        this.ownedChildren.delete(child)
      }
      this.state = inactiveState('windows-child-session', 'stopped', '本插件子会话已清理；旧连接、截图和授权已失效')
      return structuredClone(this.state)
    })()
    void resetting.finally(() => { if (this.resetting === resetting) this.resetting = undefined }).catch(() => {})
    return resetting
  }

  private async stopInternal(signal: AbortSignal): Promise<DesktopRuntimeState> {
    if (this.opening || !this.client) { await this.close(); return structuredClone(this.state) }
    this.state = { ...this.state, status: 'stopping' }
    try {
      const state = await this.stateCall('stop', null, signal)
      if (state.backend === 'windows-child-session') { await this.close(); this.state = inactiveState('windows-child-session', 'stopped', '子会话已终止，授权已撤销'); return structuredClone(this.state) }
      await this.frames.close()
      return state
    } catch (error) {
      try { await this.close() } finally {
        this.state = inactiveState(this.state.backend, 'failed', '停止请求失败；授权已撤销，请使用 desktop_reset_child_session 核实清理')
      }
      throw error
    }
  }

  private async stateCall(method: string, payload: unknown, signal: AbortSignal): Promise<DesktopRuntimeState> {
    return this.bindRuntimeState(runtimeStateSchema.parse(await this.call(method, payload, signal)))
  }

  private bindRuntimeState(runtime:DesktopRuntimeState): DesktopRuntimeState {
    const identity = this.identity
    const connection = this.connectionId ? { connectionId: this.connectionId } : {}
    this.state = identity ? {
      ...runtime, ...connection, backend: 'windows-child-session', isolated: true, ...identity,
      capabilities: { ...runtime.capabilities, desktopCapture: false },
    } : { ...runtime, ...connection }
    return structuredClone(this.state)
  }

  private async call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const client = this.client
    if (!client || this.state.status === 'failed') throw new DesktopLifecycleError('桌面执行器未连接；请重新打开 PiP 并授权', 'transport-disconnected')
    try {
      const result = await client.call(method, payload, signal)
      this.assertCurrent(client)
      return result
    } catch (error) {
      const brokenPipe = error instanceof Error && (/\bEPIPE\b|\bERR_STREAM_DESTROYED\b/.test(error.message) ||
        (error as NodeJS.ErrnoException).code === 'EPIPE')
      if (this.client === client && !this.inactiveConnection() && (signal.aborted || error instanceof NativeTransportError || brokenPipe)) {
        this.fail('连接已关闭；未确认的输入结果未知，请重新授权')
      }
      if (brokenPipe) {
        throw new DesktopLifecycleError('画中画控制通道已结束；未确认的操作结果未知，请稍后重新连接', 'transport-disconnected')
      }
      if (error instanceof NativeTransportError) {
        throw Object.assign(error, { nextTool: 'desktop_open_child_session', retryable: true, retryAfterMs: 500 })
      }
      throw error
    }
  }

  private inactiveConnection(): boolean {
    return this.state.status === 'failed' || this.state.status === 'stopped'
  }

  private assertCurrent(client: Transport): void {
    if (this.client !== client || this.state.status === 'failed') throw new DesktopLifecycleError('桌面连接已失效', 'transport-disconnected')
  }

  private fail(message: string): void {
    this.identity = undefined
    this.connectionId = undefined
    this.state = inactiveState(this.state.backend, 'failed', message)
    void this.close().catch(() => {})
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.opening?.abort()
    const openingDone = this.openingDone
    const client = this.client
    this.client = undefined
    this.identity = undefined
    this.connectionId = undefined
    if (this.state.status !== 'failed') {
      this.state = inactiveState(this.state.backend, 'stopped', '桌面连接已结束，旧截图和授权已失效')
    }
    const closing = (async () => {
      try {
        await client?.close()
        if (client instanceof ChildSessionClient) this.ownedChildren.delete(client)
      } finally {
        await openingDone
        await this.frames.close()
      }
    })()
    this.closing = closing
    void closing.catch(() => {})
    void closing.finally(() => { if (this.closing === closing) this.closing = undefined }).catch(() => {})
    return closing
  }

  private async joinLifecycle(signal: AbortSignal): Promise<void> {
    const pending = [this.stopping, this.closing, this.resetting].filter((value): value is Promise<void> | Promise<DesktopRuntimeState> => !!value)
    if (!pending.length) return
    let timer: NodeJS.Timeout | undefined
    let cancel: (() => void) | undefined
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DesktopLifecycleError('上一个画中画连接仍在退出，请稍后重试')), this.options.lifecycleJoinMs ?? 1500)
          cancel = () => reject(signal.reason)
          signal.addEventListener('abort', cancel, { once: true })
          if (signal.aborted) cancel()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (cancel) signal.removeEventListener('abort', cancel)
    }
    signal.throwIfAborted()
  }
}
