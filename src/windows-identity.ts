import koffi from 'koffi'
import { basename } from 'node:path'
import { compareWindowSamples, type RawWindowObservation } from './window-selection.ts'
import { NativeWindowError } from './native-contract.ts'

const windowEnumProc = koffi.proto('int __stdcall DshWindowEnumProc(uintptr_t hwnd, intptr_t param)')
type WindowBounds = { x: number; y: number; width: number; height: number }
type WindowObservation = WindowBounds & { foreground: string }

function containsBounds(outer: WindowBounds, inner: WindowBounds): boolean {
  return inner.width > 1 && inner.height > 1 &&
    inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
}

function decodeBounds(rect: number[]): WindowBounds {
  return {x:rect[0],y:rect[1],width:rect[2]-rect[0],height:rect[3]-rect[1]}
}

/** Worker-only DPI setup, identity preflight, input lease and explicitly approved pointer movement. */
export class WindowsIdentity {
  private kernel = koffi.load('kernel32.dll')
  private user = koffi.load('user32.dll')
  private advapi = koffi.load('advapi32.dll')
  private dwm = koffi.load('dwmapi.dll')
  private open = this.kernel.func('void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  private close = this.kernel.func('int __stdcall CloseHandle(void* handle)')
  private times = this.kernel.func('int __stdcall GetProcessTimes(void* process, _Out_ uint8_t* creation, _Out_ uint8_t* exit, _Out_ uint8_t* kernel, _Out_ uint8_t* user)')
  private image = this.kernel.func('int __stdcall QueryFullProcessImageNameW(void* process, uint32_t flags, _Out_ uint8_t* name, _Inout_ uint32_t* length)')
  private openToken = this.advapi.func('int __stdcall OpenProcessToken(void* process, uint32_t access, _Out_ void** token)')
  private tokenInfo = this.advapi.func('int __stdcall GetTokenInformation(void* token, int kind, _Out_ uint8_t* information, uint32_t length, _Out_ uint32_t* returned)')
  private owner = this.user.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t* pid)')
  private enumWindows = this.user.func('int __stdcall EnumWindows(DshWindowEnumProc* callback, intptr_t param)')
  private shellWindow = this.user.func('uintptr_t __stdcall GetShellWindow()')
  private className = this.user.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ uint8_t* name, int capacity)')
  private bounds = this.user.func('int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  private extendedBounds = this.dwm.func('int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attribute, _Out_ int32_t* rect, uint32_t size)')
  private systemMetric = this.user.func('int __stdcall GetSystemMetrics(int index)')
  private clientRect = this.user.func('int __stdcall GetClientRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  private clientOrigin = this.user.func('int __stdcall ClientToScreen(uintptr_t hwnd, _Inout_ int32_t* point)')
  private hung = this.user.func('int __stdcall IsHungAppWindow(uintptr_t hwnd)')
  private minimized = this.user.func('int __stdcall IsIconic(uintptr_t hwnd)')
  private exists = this.user.func('int __stdcall IsWindow(uintptr_t hwnd)')
  private restore = this.user.func('int __stdcall ShowWindowAsync(uintptr_t hwnd, int command)')
  private visible = this.user.func('int __stdcall IsWindowVisible(uintptr_t hwnd)')
  private foreground = this.user.func('uintptr_t __stdcall GetForegroundWindow()')
  private desktop = this.user.func('void* __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)')
  private desktopName = this.user.func('int __stdcall GetUserObjectInformationW(void* object, int index, _Out_ uint8_t* value, uint32_t length, _Out_ uint32_t* needed)')
  private closeDesktop = this.user.func('int __stdcall CloseDesktop(void* desktop)')
  private createMutex = this.kernel.func('void* __stdcall CreateMutexW(void* attributes, int owner, const char16_t* name)')
  private wait = this.kernel.func('uint32_t __stdcall WaitForSingleObject(void* handle, uint32_t milliseconds)')
  private release = this.kernel.func('int __stdcall ReleaseMutex(void* handle)')
  private cursor = this.user.func('int __stdcall SetPhysicalCursorPos(int x, int y)')
  private dpiContext = this.user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')
  constructor() {
    // The SDK owns capture/input threads. Configure the dedicated process, not only this JS thread,
    // before it creates those threads; otherwise mixed-DPI captures can be physically clipped.
    const set=this.user.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t context)')
    const current=this.user.func('intptr_t __stdcall GetThreadDpiAwarenessContext()')
    const awareness=this.user.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t context)')
    if(!set(-4n) && awareness(current())!==2)throw new Error('执行器无法启用每显示器 DPI 感知；拒绝不可靠的坐标映射')
  }

  process(pid: number): {birth: string; image: string; imagePath?: string} {
    const handle = this.open(0x1000, 0, pid)
    if (!handle) throw new Error('目标进程不可查询；可能已退出或受保护')
    try {
      const birth = Buffer.alloc(8)
      if (!this.times(handle, birth, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw new Error('无法核实进程创建身份')
      const name = Buffer.alloc(8192); const length = [4096]
      if (!this.image(handle, 0, name, length)) throw new Error('无法核实进程路径')
      const token: unknown[] = [null]
      if (!this.openToken(handle, 8, token)) throw new Error('无法核实目标权限')
      try {
        const elevated = Buffer.alloc(4)
        if (!this.tokenInfo(token[0], 20, elevated, 4, [0]) || elevated.readUInt32LE() !== 0) throw new Error('不操作提升权限的窗口')
      } finally { this.close(token[0]) }
      return { birth: birth.toString('hex'), imagePath: name.toString('utf16le', 0, length[0] * 2), image: basename(name.toString('utf16le', 0, length[0] * 2)).toLowerCase() }
    } finally { this.close(handle) }
  }
  rawTopLevelCount(): number | null {
    let count = 0
    try {
      // EnumWindows is synchronous and confined to this worker's desktop.
      const ok = this.enumWindows(() => { count++; return 1 }, 0)
      return ok ? count : null
    } catch {
      return null
    }
  }
  rawWindowDiscovery(candidates: string[]) {
    const raw: RawWindowObservation[] = []
    try {
      const ok = this.enumWindows((hwnd: bigint | number) => {
        const rect=[0,0,0,0]
        const boundsValid=Boolean(this.bounds(hwnd,rect))&&rect[2]-rect[0]>1&&rect[3]-rect[1]>1
        raw.push({id:String(hwnd),visible:Boolean(this.visible(hwnd)),minimized:Boolean(this.minimized(hwnd)),boundsValid})
        return 1
      },0)
      return ok ? {rawTopLevel:raw.length,sdkSelection:compareWindowSamples(raw,candidates)} : null
    } catch { return null }
  }
  responsive(id: string): boolean { return !this.hung(BigInt(id)) }
  windowShellInfo(id: string, pid: number): { shellDesktop: boolean; className: string } {
    const hwnd = BigInt(id)
    const owner = [0]
    this.assertWindowOwner(hwnd, pid, owner)
    const name = Buffer.alloc(512)
    const length = this.className(hwnd, name, name.length / 2)
    if (!length) throw new Error('无法核实目标窗口类别')
    return { shellDesktop: hwnd === BigInt(this.shellWindow()), className: name.toString('utf16le', 0, length * 2) }
  }
  window(id: string, pid: number): WindowObservation {
    const previous=this.dpiContext(-4n)
    try {
      const hwnd = BigInt(id)
      const rect = [0, 0, 0, 0]
      this.assertWindowOwner(hwnd, pid)
      this.assertVisibleWindow(hwnd)
      const sampled = this.bounds(hwnd, rect)
      this.assertWindowOwner(hwnd, pid)
      this.assertVisibleWindow(hwnd)
      // IsIconic can clear before the asynchronous restore updates GetWindowRect.
      if (rect[0] <= -30000 && rect[1] <= -30000) {
        throw new NativeWindowError('minimized', '目标窗口仍处于最小化几何状态')
      }
      const geometry = decodeBounds(rect)
      if (!sampled || geometry.width <= 1 || geometry.height <= 1) {
        throw new NativeWindowError('resized', '窗口尺寸暂不可捕获，请重新截图')
      }
      return { ...geometry, foreground: String(this.foreground()) }
    } finally { if(previous)this.dpiContext(previous) }
  }
  private assertVisibleWindow(hwnd: bigint): void {
    if (this.minimized(hwnd)) throw new NativeWindowError('minimized', '目标窗口已最小化；请调用 desktop_restore_window')
    if (!this.visible(hwnd)) throw new NativeWindowError('hidden', '目标窗口已隐藏；请调用 desktop_restore_window')
  }
  restoredWindow(id: string, pid: number): { rect: WindowObservation; bounds: WindowBounds } {
    const previous = this.dpiContext(-4n)
    if (!previous) throw new Error('无法核实还原窗口的 DPI 坐标')
    try {
      const rect = this.window(id, pid)
      const nativeFrame = [0, 0, 0, 0]
      const frameRead = this.extendedBounds(BigInt(id), 9, nativeFrame, 16) === 0
      const frame = decodeBounds(nativeFrame)
      // The compositor bounds remove the invisible resize border of a maximized window.
      const bounds = frameRead && containsBounds(rect, frame) ? frame : rect
      const virtualScreen = {
        x: this.systemMetric(76), y: this.systemMetric(77),
        width: this.systemMetric(78), height: this.systemMetric(79),
      }
      const current = this.window(id, pid)
      if (bounds.x <= -30000 || bounds.y <= -30000 || !containsBounds(virtualScreen, bounds) ||
          current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) {
        throw new NativeWindowError('resized', '暂未核实虚拟屏幕内稳定的窗口几何')
      }
      return { rect: current, bounds }
    } finally { this.dpiContext(previous) }
  }
  private assertWindowOwner(hwnd: bigint, pid: number, owner = [0]): void {
    if (!this.exists(hwnd) || !this.owner(hwnd, owner)) throw new NativeWindowError('exited', '目标窗口已退出，请重新发现窗口')
    if (owner[0] !== pid) throw new NativeWindowError('identity-changed', '窗口所属进程已改变，旧窗口许可失效')
  }
  clientBounds(id:string,pid:number):{x:number;y:number;width:number;height:number}{
    const previous=this.dpiContext(-4n)
    if(!previous)throw new Error('无法核实客户区 DPI 坐标')
    try{
      const hwnd=BigInt(id),rect=[0,0,0,0],origin=[0,0]
      this.assertWindowOwner(hwnd,pid)
      if(!this.clientRect(hwnd,rect)||!this.clientOrigin(hwnd,origin)||rect[2]<=rect[0]||rect[3]<=rect[1])throw new Error('无法核实窗口客户区')
      this.assertWindowOwner(hwnd,pid)
      return {x:origin[0],y:origin[1],width:rect[2]-rect[0],height:rect[3]-rect[1]}
    }finally{this.dpiContext(previous)}
  }
  restoreWindow(id: string, pid: number): void {
    this.assertInteractive()
    const hwnd = BigInt(id)
    this.assertWindowOwner(hwnd, pid)
    // SW_RESTORE is only sent after the Host's independent restore approval.
    // Async avoids waiting indefinitely on an application-owned UI thread.
    if ((this.minimized(hwnd) || !this.visible(hwnd)) && !this.restore(hwnd, 9)) {
      throw new Error('Windows 拒绝恢复目标窗口；请检查应用是否响应')
    }
  }
  assertInteractive(): void {
    const handle = this.desktop(0, 0, 1)
    if (!handle) throw new Error('桌面已锁定或处于安全桌面')
    try {
      const name = Buffer.alloc(512)
      if (!this.desktopName(handle, 2, name, name.length, [0]) || name.toString('utf16le').split('\0')[0] !== 'Default') throw new Error('不操作登录或安全桌面')
    } finally { this.closeDesktop(handle) }
  }
  acquireLease(): () => void {
    const handle = this.createMutex(null, 0, 'Local\\DSHVirtualDesktopInputV1')
    if (!handle) throw new Error('无法建立本机输入租约')
    const result = this.wait(handle, 0)
    if (result !== 0 && result !== 0x80) { this.close(handle); throw new Error('另一个 DSH 执行器正在持有本机输入租约') }
    return () => { this.release(handle); this.close(handle) }
  }
  movePointer(x: number, y: number): void {
    const previous=this.dpiContext(-4n)
    try {if (!this.cursor(Math.round(x), Math.round(y))) throw new Error('Windows 拒绝移动鼠标')}
    finally {if(previous)this.dpiContext(previous)}
  }
}
