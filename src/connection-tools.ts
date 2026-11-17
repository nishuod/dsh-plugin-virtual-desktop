import type { VirtualDesktopController } from './controller.ts'
import type { DesktopRuntimeState, DesktopWindow } from './native-contract.ts'
import { childExecutableSchema } from './child-launch.ts'

type ConnectionToolService = Pick<VirtualDesktopController, 'desktopStatus' | 'enableChildSession' | 'windows' | 'selectWindowApproved'>
type Approve = (reason: string) => Promise<void>
type AuthorizeStart = (reason: string) => Promise<void | (() => void)>

function sameWindow(left: DesktopWindow | null, right: DesktopWindow | null): boolean {
  if (!left || !right) return left === right
  return left.id === right.id && left.pid === right.pid && left.app === right.app && left.title === right.title
}

function assertStable(before: DesktopRuntimeState, after: DesktopRuntimeState): void {
  if (before.connectionId !== after.connectionId || before.backend !== after.backend || before.status !== after.status || before.epoch !== after.epoch ||
      before.isolated !== after.isolated || before.parentSessionId !== after.parentSessionId ||
      before.childSessionId !== after.childSessionId || before.foregroundAllowed !== after.foregroundAllowed ||
      !sameWindow(before.window, after.window)) {
    throw new Error('窗口或子会话已变化，请重新发现并批准')
  }
}

function assertChild(state: DesktopRuntimeState): void {
  const { parentSessionId, childSessionId } = state
  if (state.backend !== 'windows-child-session' || !state.isolated ||
      typeof parentSessionId !== 'number' || !Number.isSafeInteger(parentSessionId) || parentSessionId <= 0 ||
      typeof childSessionId !== 'number' || !Number.isSafeInteger(childSessionId) || childSessionId <= 0 ||
      parentSessionId === childSessionId || (state.status !== 'observing' && state.status !== 'enabled')) {
    throw new Error('需要已核实且正在运行的画中画子会话，请先调用 desktop_open_child_session')
  }
}

function findWindow(windows: DesktopWindow[], id: string): DesktopWindow | undefined {
  const matches = windows.filter(window => window.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

export async function openChildSessionFromTool(service: ConnectionToolService, authorize: AuthorizeStart, signal: AbortSignal) {
  signal.throwIfAborted()
  const before = await service.desktopStatus(signal)
  const inactive = before.status === 'disabled' || before.status === 'stopped' || before.status === 'failed'
  if (!inactive) {
    if (before.backend !== 'windows-child-session') throw new Error('请先在桌面工具面板结束本机调试')
    if (before.status === 'paused') throw new Error('画中画已暂停，请由用户继续或结束当前连接')
    assertChild(before)
  }
  const recheckGrant = await authorize('打开 Windows 画中画子会话并发现其中的窗口。子会话使用当前 Windows 账户，共享该账户可访问的文件和设置。这个批准仅用于连接与观察，绑定目标和每次输入仍需单独批准。')
  signal.throwIfAborted()
  assertStable(before, await service.desktopStatus(signal))
  signal.throwIfAborted()
  recheckGrant?.()
  const state = await service.enableChildSession(signal)
  assertChild(state)
  const windows = await service.windows(signal)
  const discovered = await service.desktopStatus(signal)
  assertStable(state, discovered)
  return { state: discovered, windows,
    ...(windows.length === 0 ? { nextTool: 'desktop_open_application',
      guidance: '子会话尚无普通应用。现在调用 desktop_open_application({appId:"vmware-workstation"}) 或提供 path 即可启动并验证绑定，不要求已有窗口。不要先调用 desktop_start_task。' } : {}) }
}

export async function selectChildWindowFromTool(service: ConnectionToolService, windowId: string, approve: AuthorizeStart, signal: AbortSignal): Promise<DesktopRuntimeState> {
  signal.throwIfAborted()
  const before = await service.desktopStatus(signal)
  assertChild(before)
  const target = findWindow(await service.windows(signal), windowId)
  if (!target) throw new Error('窗口不在当前发现列表中，请重新调用 desktop_get_windows')
  assertStable(before, await service.desktopStatus(signal))
  const identity = JSON.stringify({ title: target.title, app: target.app, pid: target.pid, windowId: target.id })
  const recheck = await approve(`授权画中画子会话 ${before.childSessionId} 中的单个目标窗口 ${identity}。本次仅绑定目标，后续每次输入仍需单独批准。`)
  signal.throwIfAborted()
  assertStable(before, await service.desktopStatus(signal))
  const current = findWindow(await service.windows(signal), windowId)
  assertStable(before, await service.desktopStatus(signal))
  if (!current || !sameWindow(target, current)) throw new Error('窗口或子会话已变化，请重新发现并批准')
  signal.throwIfAborted()
  recheck?.()
  const selected = await service.selectWindowApproved(current.id, before.epoch, signal)
  assertChild(selected)
  if (selected.status !== 'enabled' || selected.foregroundAllowed || selected.epoch !== before.epoch + 1 ||
      selected.connectionId !== before.connectionId ||
      selected.parentSessionId !== before.parentSessionId || selected.childSessionId !== before.childSessionId ||
      !sameWindow(current, selected.window)) {
    throw new Error('执行器未确认本次授权的子会话目标')
  }
  return selected
}

export async function launchChildFromTool(service: Pick<VirtualDesktopController, 'desktopStatus' | 'launchChildApplication' | 'windows'>,
  path: string, operationId: string, authorize: AuthorizeStart, signal: AbortSignal) {
  childExecutableSchema.parse(path)
  const before = await service.desktopStatus(signal)
  assertChild(before)
  if (!before.connectionId) throw new Error('缺少已核实的子会话连接标识')
  const recheck = await authorize(`在 PiP 子会话 ${before.childSessionId} 启动应用 ${JSON.stringify(path)}。不传命令行参数，不自动绑定或控制窗口。`)
  signal.throwIfAborted()
  assertStable(before, await service.desktopStatus(signal))
  signal.throwIfAborted()
  recheck?.()
  const launch = await service.launchChildApplication(path, operationId, before.connectionId, before.epoch, signal)
  const windows = await service.windows(signal)
  const state = await service.desktopStatus(signal)
  assertStable(before, state)
  return { launch, windows, state }
}
