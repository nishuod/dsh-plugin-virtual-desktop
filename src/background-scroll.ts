import { createRequire } from 'node:module'

export class BackgroundScrollRefused extends Error {}

interface Point {
  x: number
  y: number
}

interface ClientPoint extends Point {
  width: number
  height: number
}

interface ScrollWindow {
  pid: number
  thread: number
  root: bigint
  bounds: readonly [number, number, number, number]
}

export interface BackgroundScrollPort {
  withPerMonitorV2<T>(operation: () => T): T
  sessionOf(pid: number): number | undefined
  window(hwnd: bigint): ScrollWindow | undefined
  clientPoint(hwnd: bigint, point: Point): ClientPoint | undefined
  childAt(hwnd: bigint, point: Point): bigint
  sendWheel(hwnd: bigint, wParam: bigint, lParam: bigint, timeoutMs: number): 'delivered' | 'access-denied' | 'unknown'
}

interface Hit {
  hwnd: bigint
  window: ScrollWindow
  point: ClientPoint
}

const maxHitDepth = 32
const timeoutMs = 750
const validHwnd = (value: bigint) => value > 0n && value !== 0xffffn && value < 0xffffffffffffffffn
const signedWord = (value: number) => Number.isInteger(value) && value >= -32768 && value <= 32767
const packWords = (low: number, high: number) => (BigInt(high & 0xffff) << 16n) | BigInt(low & 0xffff)

/** Targeted vertical wheel delivery for the authenticated child-session worker. */
export class WindowsBackgroundScroller {
  constructor(private port?: BackgroundScrollPort) {}

  scroll(rootId: string, pid: number, x: number, y: number, direction: 'up' | 'down', amount: number): void {
    if (!/^[1-9]\d{0,19}$/.test(rootId) || !Number.isInteger(pid) || pid <= 0 ||
        pid > 0xffffffff || pid === process.pid || !signedWord(x) || !signedWord(y) ||
        (direction !== 'up' && direction !== 'down') || !Number.isInteger(amount) || amount < 1 || amount > 10) {
      throw new BackgroundScrollRefused('后台滚轮的窗口、坐标或滚动量无效；未发送输入')
    }
    const root = BigInt(rootId)
    if (!validHwnd(root)) throw new BackgroundScrollRefused('后台滚轮的窗口句柄无效；未发送输入')
    const port = this.port ??= createWin32Port()
    port.withPerMonitorV2(() => {
      const session = port.sessionOf(process.pid)
      if (!session || port.sessionOf(pid) !== session) {
        throw new BackgroundScrollRefused('后台滚轮目标不在当前子会话；未发送输入')
      }

      const point = { x, y }
      const initial = hitPath(port, root, pid, point)
      const current = hitPath(port, root, pid, point)
      if (initial.length !== current.length || !initial.every((hit, index) => sameHit(hit, current[index])) ||
          port.sessionOf(pid) !== session) {
        throw new BackgroundScrollRefused('后台滚轮目标身份或位置已变化；未发送输入')
      }

      const delta = (direction === 'up' ? 120 : -120) * amount
      const target = current[current.length - 1].hwnd
      const result = port.sendWheel(target, packWords(0, delta), packWords(x, y), timeoutMs)
      if (result === 'access-denied') {
        throw new BackgroundScrollRefused('Windows 拒绝后台滚轮消息；未发送输入')
      }
      if (result !== 'delivered') {
        throw new Error('后台滚轮消息处理结果未知；请查看新观察后再决定是否重试')
      }
    })
  }
}

function hitPath(port: BackgroundScrollPort, root: bigint, pid: number, point: Point): Hit[] {
  const path: Hit[] = []
  let hwnd = root
  for (let depth = 0; depth < maxHitDepth; depth++) {
    const window = port.window(hwnd)
    const client = port.clientPoint(hwnd, point)
    if (!window || window.pid !== pid || window.root !== root || !client ||
        client.x < 0 || client.y < 0 || client.x >= client.width || client.y >= client.height) {
      throw new BackgroundScrollRefused('后台滚轮没有命中已批准窗口内可交互的控件；未发送输入')
    }
    path.push({ hwnd, window, point: client })
    const child = port.childAt(hwnd, client)
    if (child === hwnd) return path
    if (!validHwnd(child)) {
      throw new BackgroundScrollRefused('后台滚轮的控件命中已失效；未发送输入')
    }
    hwnd = child
  }
  throw new BackgroundScrollRefused('后台滚轮的控件层级过深；未发送输入')
}

function sameHit(before: Hit, after: Hit): boolean {
  return before.hwnd === after.hwnd && before.window.thread === after.window.thread &&
    before.window.bounds.every((value, index) => value === after.window.bounds[index]) &&
    before.point.x === after.point.x && before.point.y === after.point.y &&
    before.point.width === after.point.width && before.point.height === after.point.height
}

function createWin32Port(): BackgroundScrollPort {
  if (process.platform !== 'win32') throw new BackgroundScrollRefused('后台滚轮仅支持 Windows')
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const kernel = koffi.load('kernel32.dll')
  const user = koffi.load('user32.dll')
  const session = kernel.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t* session)')
  const setLastError = kernel.func('void __stdcall SetLastError(uint32_t error)')
  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  const dpi = user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')
  const owner = user.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t* pid)')
  const ancestor = user.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)')
  const visible = user.func('int __stdcall IsWindowVisible(uintptr_t hwnd)')
  const iconic = user.func('int __stdcall IsIconic(uintptr_t hwnd)')
  const enabled = user.func('int __stdcall IsWindowEnabled(uintptr_t hwnd)')
  const windowRect = user.func('int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  const clientRect = user.func('int __stdcall GetClientRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  const pointType = koffi.struct({ x: 'int32_t', y: 'int32_t' })
  const screenToClient = user.func('__stdcall', 'ScreenToClient', 'int', ['uintptr_t', koffi.inout(koffi.pointer(pointType))])
  const childFromPoint = user.func('__stdcall', 'ChildWindowFromPointEx', 'uintptr_t', ['uintptr_t', pointType, 'uint32_t'])
  const send = user.func('intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, void* result)')
  return {
    withPerMonitorV2(operation) {
      const previous = dpi(-4n) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
      if (!previous) throw new BackgroundScrollRefused('无法核实后台滚轮的 DPI 坐标；未发送输入')
      try { return operation() } finally { dpi(previous) }
    },
    sessionOf(pid) {
      const id = [0]
      return session(pid, id) ? id[0] : undefined
    },
    window(hwnd) {
      const pid = [0]
      const thread = owner(hwnd, pid)
      const rect: [number, number, number, number] = [0, 0, 0, 0]
      if (!thread || !visible(hwnd) || iconic(hwnd) || !enabled(hwnd) || !windowRect(hwnd, rect) ||
          rect[0] >= rect[2] || rect[1] >= rect[3]) return
      return { pid: pid[0], thread, root: BigInt(ancestor(hwnd, 2)), bounds: rect } // GA_ROOT
    },
    clientPoint(hwnd, point) {
      const client = { ...point }
      const rect = [0, 0, 0, 0]
      if (!screenToClient(hwnd, client) || !clientRect(hwnd, rect)) return
      return { ...client, width: rect[2], height: rect[3] }
    },
    childAt(hwnd, { x, y }) {
      // Skip invisible, disabled, and transparent child windows.
      return BigInt(childFromPoint(hwnd, { x, y }, 0x0007))
    },
    sendWheel(hwnd, wParam, lParam, timeout) {
      setLastError(0)
      // WM_MOUSEWHEEL, SMTO_BLOCK | SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT.
      if (send(hwnd, 0x020a, wParam, lParam, 0x0023, timeout, null)) return 'delivered'
      return lastError() === 5 ? 'access-denied' : 'unknown'
    },
  }
}
