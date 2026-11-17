import type { DesktopRuntimeState } from './native-contract.ts'
import type { ChildStartPermission } from './child-start-permission.ts'

export const pipProfile = {
  backend: 'windows-child-session',
  isolated: true,
  capabilities: { windowCapture: true, desktopCapture: false, regionCapture: true, clipboard: false, autonomousTask: false },
} as const

export function describeDesktopConnection(state: DesktopRuntimeState) {
  const disconnected = state.status === 'disabled' || state.status === 'stopped' || state.status === 'failed'
  const activeBackend = state.connectionId && !disconnected ? state.backend : null
  const canObserve = activeBackend !== null && (state.status === 'observing' || state.status === 'enabled')
  const windowCapture = canObserve && state.status === 'enabled' && state.window !== null && state.capabilities.windowCapture
  const desktopCapture = canObserve && activeBackend === 'windows-attended' && state.capabilities.desktopCapture
  return {
    ...state, activeBackend,
    capabilities: { ...state.capabilities, windowCapture, desktopCapture,
      regionCapture: (windowCapture || desktopCapture) && state.capabilities.regionCapture },
  }
}

/** A connection diagnosis must describe the executor, not the independent health worker. */
export function desktopGuidance(state: DesktopRuntimeState, permission: ChildStartPermission, noPrompts: boolean): { nextTool: string | null; guidance: string } {
  if (state.status === 'disabled' || state.status === 'stopped' || state.status === 'failed') {
    if (permission === 'blocked') {
      return { nextTool: null, guidance: '尚未连接桌面执行器。当前会话设为从不询问，且未核实完全权限。请用户在虚拟桌面工具面板打开 PiP，或调整会话权限。' }
    }
    const startup = permission === 'session-grant' ? '可使用当前会话的完全权限直接启动' : '需请求用户本次批准'
    return { nextTool: 'desktop_open_child_session', guidance: `尚未连接桌面执行器。调用 desktop_open_child_session 打开 PiP，${startup}。` }
  }
  if (state.status === 'pausing' || state.status === 'stopping') {
    return { nextTool: 'desktop_get_task_status', guidance: '正在排空操作，请等待状态稳定后再继续。' }
  }
  if (state.status === 'paused') {
    return { nextTool: 'desktop_get_task_status', guidance: '桌面已暂停。读取任务状态；若有运行中的任务，请用户在面板继续。恢复后必须重新截图。' }
  }
  if (!state.window) {
    if (state.backend !== 'windows-child-session') {
      return { nextTool: null, guidance: '当前为本机调试模式，请用户在面板选择并授权窗口。若需要 PiP，请先结束本机连接，再调用 desktop_open_child_session。' }
    }
    const discovery = state.windowDiscovery
    if (discovery && (discovery.sessionEligible ?? discovery.workerEligible) === 0) {
      return {
        nextTool: permission === 'blocked' ? null : 'desktop_open_application',
        guidance: '当前 PiP 没有可授权的应用窗口。优先调用 desktop_open_application，VMware 可传 appId=vmware-workstation，其他应用传绝对 exe 路径。无需预先绑定窗口；验证不足时在面板核对。desktop_get_windows 的 includeDiagnostics=true 返回计数和 systemSurfaces 原因明细。',
      }
    }
    return noPrompts && permission !== 'session-grant'
      ? { nextTool: null, guidance: 'PiP 已连接。请用户先在 PiP 内打开目标应用，然后在虚拟桌面工具面板刷新、选择并授权该窗口。' }
      : { nextTool: 'desktop_get_windows', guidance: 'PiP 已连接。用 desktop_get_windows 获取真实 id，再用 desktop_select_window 请求目标授权。目标应用需要在子会话中打开。' }
  }
  return { nextTool: 'desktop_get_screenshot', guidance: permission==='session-grant'&&state.backend==='windows-child-session'
    ? '目标已授权。图像模型读取新截图后，可以依照本会话完全权限派发 PiP 输入；模型声明完成后仍须核验真实结果。' : noPrompts
    ? '目标已授权。图像模型可以读取新截图。当前会话设为从不询问，请在面板执行输入，或由用户切换到允许询问的模式再批准聊天输入。'
    : '目标已授权。使用支持图像的当前模型读取新截图，再提出操作；每次输入仍须单独批准。模型声明完成后仍须核验真实结果。' }
}
