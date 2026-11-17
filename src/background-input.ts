import { createRequire } from 'node:module'
import { childKey } from './child-key.ts'
import type { HitTestEvidence } from './native-contract.ts'
import type { CaptionButton, PrivacyRectangle, PrivacyTarget } from './privacy.ts'

export class BackgroundInputRefused extends Error {}
interface Point { x: number; y: number }
interface ClientPoint extends Point { width: number; height: number }
interface TargetWindow { pid: number; thread: number; root: bigint; bounds: readonly [number, number, number, number] }
type SendResult = 'delivered' | 'access-denied' | 'unknown'
export interface BackgroundInputPort {
  withPerMonitorV2<T>(operation: () => T): T
  sessionOf(pid: number): number | undefined
  window(hwnd: bigint): TargetWindow | undefined
  focus(thread: number): bigint
  standardEdit?(hwnd:bigint):boolean
  replaceSelection?(hwnd:bigint,text:string):SendResult
  clientPoint(hwnd: bigint, point: Point): ClientPoint | undefined
  childAt(hwnd: bigint, point: Point): bigint
  hitTest(hwnd: bigint, point: Point, timeoutMs?: number): number | undefined
  scanCode(virtualKey: number): number
  withControlState<T>(thread: number, operation: () => T): T
  send(hwnd: bigint, message: number, wParam: bigint, lParam: bigint, timeoutMs: number): SendResult
}
const validHwnd = (value: bigint) => value > 0n && value !== 0xffffn && value < 0xffffffffffffffffn
const signedWord = (value: number) => Number.isInteger(value) && value >= -32768 && value <= 32767
const sameWindow = (a: TargetWindow, b: TargetWindow | undefined) => b && a.pid === b.pid && a.thread === b.thread && a.root === b.root && a.bounds.every((n, i) => n === b.bounds[i])
const packPoint = (x: number, y: number) => (BigInt(y & 0xffff) << 16n) | BigInt(x & 0xffff)
const hitClasses:Record<number,string>={[-2]:'HTERROR',[-1]:'HTTRANSPARENT',0:'HTNOWHERE',1:'HTCLIENT',2:'HTCAPTION',3:'HTSYSMENU',4:'HTGROWBOX',5:'HTMENU',6:'HTHSCROLL',7:'HTVSCROLL',8:'HTMINBUTTON',9:'HTMAXBUTTON',10:'HTLEFT',11:'HTRIGHT',12:'HTTOP',13:'HTTOPLEFT',14:'HTTOPRIGHT',15:'HTBOTTOM',16:'HTBOTTOMLEFT',17:'HTBOTTOMRIGHT',18:'HTBORDER',19:'HTOBJECT',20:'HTCLOSE',21:'HTHELP'}
const captionHits={minimize:8,maximize:9,close:20} as const

/** Child worker only. All messages address a verified HWND; no foreground or SendInput fallback. */
export class WindowsBackgroundInput {
  constructor(private port?: BackgroundInputPort) {}
  private target(rootId: string, pid: number) {
    if (!/^[1-9]\d{0,19}$/.test(rootId) || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff || pid === process.pid) throw new BackgroundInputRefused('后台输入目标身份无效；未发送输入')
    const root = BigInt(rootId)
    if (!validHwnd(root)) throw new BackgroundInputRefused('后台输入窗口句柄无效；未发送输入')
    const port = this.port ??= createWin32Port()
    const session = port.sessionOf(process.pid)
    const window = port.window(root)
    if (!session || port.sessionOf(pid) !== session || !window || window.pid !== pid || window.root !== root) throw new BackgroundInputRefused('后台输入目标不在当前子会话的授权窗口；未发送输入')
    return { root, port, session, window }
  }
  tryMinimizeCaption(rootId: string, pid: number, point: Point, onDispatch: () => void, onHitTest?: (hit:HitTestEvidence)=>void): boolean {
    if (!signedWord(point.x) || !signedWord(point.y)) return false
    const port = this.port ??= createWin32Port()
    return port.withPerMonitorV2(() => {
      // GetWindowRect and WM_NCHITTEST must share the physical-pixel DPI context.
      const { root, session, window } = this.target(rootId, pid)
      const [left, top, right, bottom] = window.bounds
      if (point.x < left || point.x >= right || point.y < top || point.y >= bottom) return false
      // A caption action is allowed only when the actual target HWND confirms HTMINBUTTON.
      const code=port.hitTest(root, point)
      if(code===undefined)return false
      if (!sameWindow(window, port.window(root)) || port.sessionOf(pid) !== session) {
        throw new BackgroundInputRefused('标题栏命中后窗口身份或位置变化；未发送输入')
      }
      onHitTest?.({point:{x:point.x-left,y:point.y-top},screenPoint:{...point},windowOrigin:{x:left,y:top},windowRelative:true,class:hitClasses[code]??'HTUNKNOWN',code})
      if(code!==8)return false
      onDispatch()
      // WM_SYSCOMMAND / SC_MINIMIZE avoids entering the non-client mouse capture loop.
      // A timeout may have changed the window already, so the caller must not retry via the SDK.
      this.send(port, root, 0x0112, 0xf020n, packPoint(point.x, point.y), 0)
      return true
    })
  }
  /** UIA identifies standard buttons. The owned HWND supplies their hit regions. */
  captionButtons(rootId:string,pid:number,targets:PrivacyTarget[]):Partial<Record<CaptionButton,PrivacyRectangle>> {
    const port=this.port??=createWin32Port()
    try{
      return port.withPerMonitorV2(()=>{
        const {root,window,session}=this.target(rootId,pid)
        const [left,top,right,bottom]=window.bounds
        const captionTargets=targets.filter(target=>target.captionButton&&target.enabled)
        if(!captionTargets.length)return {}
        const rectangles=captionTargets.map(target=>target.bounds)
        // UIA caption bounds can be displaced by the width difference between
        // themed and proxy buttons. Limit queries to an expanded caption band.
        const expansion=Math.min(120,3*Math.max(...rectangles.map(rect=>rect.width)))
        const x1=Math.max(left,Math.floor(Math.min(...rectangles.map(rect=>rect.x))-expansion))
        const x2=Math.min(right,Math.ceil(Math.max(...rectangles.map(rect=>rect.x+rect.width))+expansion))
        const y1=Math.max(top,Math.floor(Math.min(...rectangles.map(rect=>rect.y))))
        const y2=Math.min(bottom,Math.ceil(Math.max(...rectangles.map(rect=>rect.y+rect.height))))
        if(x2-x1<8||x2-x1>512||y2-y1<7||y2>top+128)return {}
        const wanted=new Map<number,CaptionButton>(captionTargets.map(target=>[captionHits[target.captionButton!],target.captionButton!]))
        const result:Partial<Record<CaptionButton,PrivacyRectangle>>={}
        const deadline=performance.now()+100
        const query=(x:number,y:number)=>performance.now()<deadline&&signedWord(x)&&signedWord(y)
          ?port.hitTest(root,{x,y},25):undefined
        const step=Math.max(4,Math.ceil((x2-x1)/48))
        for(const fraction of [.5,.3,.7]){
          const y=y1+Math.floor((y2-y1)*fraction)
          if(y-3<y1||y+3>=y2)continue
          let start=x1
          let previous:number|undefined
          for(let x=x1;x<x2+step;x+=step){
            const code=x<x2?query(x,y):undefined
            if(code===previous)continue
            const button=previous===undefined?undefined:wanted.get(previous)
            const end=x-step
            if(button&&!result[button]&&end-start>=step&&
              [start,end].every(px=>[y-3,y+3].every(py=>query(px,py)===previous))){
              result[button]={x:start,y:y-3,width:end-start+1,height:7}
            }
            start=x
            previous=code
          }
          if(Object.keys(result).length===wanted.size||performance.now()>=deadline)break
        }
        if(!sameWindow(window,port.window(root))||port.sessionOf(pid)!==session)return {}
        return result
      })
    }catch(error){
      if(error instanceof BackgroundInputRefused)return {}
      throw error
    }
  }
  key(rootId: string, pid: number, key: string, modifiers: readonly string[]): void {
    const spec = childKey(key, modifiers)
    if (!spec) throw new BackgroundInputRefused('按键不在子会话后台白名单；未发送输入')
    const { root, port, session, window } = this.target(rootId, pid)
    port.withPerMonitorV2(() => {
      const focus = port.focus(window.thread)
      const focused = port.window(focus)
      if (!validHwnd(focus) || !focused || focused.pid !== pid || focused.root !== root || focused.thread !== window.thread) throw new BackgroundInputRefused('目标线程没有属于授权窗口的焦点控件；未发送输入')
      let sent = 0
      const standardEdit=port.standardEdit?.(focus)===true
      const validate = () => {
        if (!sameWindow(window, port.window(root)) || !sameWindow(focused, port.window(focus)) || port.sessionOf(pid) !== session) {
          if (sent) throw new Error('后台按键期间窗口身份或位置变化；已投递部分结果未知')
          throw new BackgroundInputRefused('后台按键目标身份或位置变化；未发送输入')
        }
      }
      const send = (vk: number, up: boolean, extended: boolean) => {
        validate()
        const flags = 1n | BigInt(port.scanCode(vk) & 0xff) << 16n | (extended ? 1n << 24n : 0n) | (up ? 0xc0000000n : 0n)
        this.send(port, focus, up ? 0x101 : 0x100, BigInt(vk), flags, sent)
        sent++
      }
      validate()
      if (port.focus(window.thread) !== focus) throw new BackgroundInputRefused('后台按键焦点已变化；未发送输入')
      const deliver = () => {
        if (spec.control) send(0x11, false, false)
        send(spec.virtualKey, false, spec.extended)
        // SendMessage does not traverse the target's TranslateMessage loop.
        // Complete only fixed text keys for a verified standard EDIT HWND.
        if(standardEdit&&!spec.control&&[0x0d,0x08,0x20].includes(spec.virtualKey)){
          validate()
          if(port.focus(window.thread)!==focus||port.standardEdit?.(focus)!==true)throw new Error('文本按键期间焦点或控件类别变化；已投递部分结果未知')
          this.send(port,focus,0x102,BigInt(spec.virtualKey),1n|(BigInt(port.scanCode(spec.virtualKey)&0xff)<<16n),sent)
          sent++
        }
        send(spec.virtualKey, true, spec.extended)
        if (spec.control) send(0x11, true, false)
      }
      // WM_KEYDOWN itself does not update GetKeyState. Scope the queue state to this
      // owned child UI thread so controls can observe Ctrl, then restore and detach.
      if (spec.control) port.withControlState(window.thread, deliver)
      else deliver()
      if(standardEdit&&spec.control&&spec.virtualKey===0x41){
        validate()
        if(port.focus(window.thread)!==focus||port.standardEdit?.(focus)!==true)throw new Error('全选期间焦点或控件类别变化；已投递部分结果未知')
        // Fixed EM_SETSEL(0,-1), never caller-supplied window messages/parameters.
        this.send(port,focus,0x00b1,0n,-1n,sent)
      }
    })
  }
  replaceText(rootId:string,pid:number,point:Point,text:string):boolean {
    if(!text||text.length>2000||text.includes('\0'))throw new BackgroundInputRefused('文本参数无效；未发送输入')
    if(!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new BackgroundInputRefused('文本输入坐标无效；未发送输入')
    const {root,port,session,window}=this.target(rootId,pid)
    if(!port.replaceSelection)return false
    return port.withPerMonitorV2(()=>{
      const focus=port.focus(window.thread),focused=port.window(focus)
      if(!focused||focused.pid!==pid||focused.root!==root||focused.thread!==window.thread||port.standardEdit?.(focus)!==true)return false
      const local=port.clientPoint(focus,point)
      if(!local||local.x<0||local.y<0||local.x>=local.width||local.y>=local.height)return false
      if(!sameWindow(window,port.window(root))||!sameWindow(focused,port.window(focus))||port.sessionOf(pid)!==session||port.focus(window.thread)!==focus||port.standardEdit?.(focus)!==true)
        throw new BackgroundInputRefused('文本输入前目标或焦点变化；未发送输入')
      const result=port.replaceSelection!(focus,text)
      if(result==='access-denied')throw new BackgroundInputRefused('Windows 拒绝文本输入；未发送输入')
      if(result!=='delivered')throw new Error('文本替换消息结果未知；未重放，请检查新观察')
      return true
    })
  }
  doubleClick(rootId: string, pid: number, x: number, y: number): void {
    if (!signedWord(x) || !signedWord(y)) throw new BackgroundInputRefused('后台双击坐标无效；未发送输入')
    const { root, port, session, window } = this.target(rootId, pid)
    port.withPerMonitorV2(() => {
      const hit = () => {
        let hwnd = root
        for (let depth = 0; depth < 32; depth++) {
          const target = port.window(hwnd)
          const point = port.clientPoint(hwnd, { x, y })
          if (!target || target.pid !== pid || target.root !== root || !point || point.x < 0 || point.y < 0 || point.x >= point.width || point.y >= point.height) throw new BackgroundInputRefused('后台双击未命中授权窗口客户区控件；未发送输入')
          const child = port.childAt(hwnd, point)
          if (child === hwnd) return { hwnd, target, point }
          if (!validHwnd(child)) throw new BackgroundInputRefused('后台双击控件命中无效；未发送输入')
          hwnd = child
        }
        throw new BackgroundInputRefused('后台双击控件层级过深；未发送输入')
      }
      const first = hit()
      const second = hit()
      if (!sameWindow(window, port.window(root)) || first.hwnd !== second.hwnd || !sameWindow(first.target, second.target) || first.point.x !== second.point.x || first.point.y !== second.point.y || port.sessionOf(pid) !== session) throw new BackgroundInputRefused('后台双击目标身份或位置变化；未发送输入')
      const point = packPoint(second.point.x, second.point.y)
      let sent = 0
      // WM_LBUTTONDBLCLK replaces the second WM_LBUTTONDOWN in the Win32 sequence.
      for (const [message, button] of [[0x201, 1], [0x202, 0], [0x203, 1], [0x202, 0]]) {
        if (!sameWindow(window, port.window(root)) || !sameWindow(second.target, port.window(second.hwnd)) || port.sessionOf(pid) !== session) throw new Error('后台双击期间窗口变化；已投递部分结果未知')
        this.send(port, second.hwnd, message, BigInt(button), point, sent)
        sent++
      }
    })
  }
  private send(port: BackgroundInputPort, hwnd: bigint, message: number, wParam: bigint, lParam: bigint, sent: number): void {
    const result = port.send(hwnd, message, wParam, lParam, 750)
    if (result === 'access-denied' && sent === 0) throw new BackgroundInputRefused('Windows 拒绝后台输入消息；未发送输入')
    if (result !== 'delivered') throw new Error('后台输入消息处理结果未知；未重放，请检查新观察')
  }
}

function createWin32Port(): BackgroundInputPort {
  if (process.platform !== 'win32') throw new BackgroundInputRefused('后台输入仅支持 Windows')
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const kernel = koffi.load('kernel32.dll')
  const user = koffi.load('user32.dll')
  const session = kernel.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t* session)')
  const currentThread = kernel.func('uint32_t __stdcall GetCurrentThreadId()')
  const setLastError = kernel.func('void __stdcall SetLastError(uint32_t error)')
  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  const dpi = user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')
  const owner = user.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t* pid)')
  const className = user.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ void* name, int count)')
  const ancestor = user.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)')
  const visible = user.func('int __stdcall IsWindowVisible(uintptr_t hwnd)')
  const iconic = user.func('int __stdcall IsIconic(uintptr_t hwnd)')
  const enabled = user.func('int __stdcall IsWindowEnabled(uintptr_t hwnd)')
  const windowRect = user.func('int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  const clientRect = user.func('int __stdcall GetClientRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  const pointType = koffi.struct({ x: 'int32_t', y: 'int32_t' })
  const screenToClient = user.func('__stdcall', 'ScreenToClient', 'int', ['uintptr_t', koffi.inout(koffi.pointer(pointType))])
  const childFromPoint = user.func('__stdcall', 'ChildWindowFromPointEx', 'uintptr_t', ['uintptr_t', pointType, 'uint32_t'])
  const gui = koffi.struct({ cbSize: 'uint32_t', flags: 'uint32_t', active: 'uintptr_t', focus: 'uintptr_t', capture: 'uintptr_t', menuOwner: 'uintptr_t', moveSize: 'uintptr_t', caret: 'uintptr_t', rect: koffi.array('int32_t', 4) })
  const threadInfo = user.func('int __stdcall GetGUIThreadInfo(uint32_t thread, _Inout_ void* info)')
  const scan = user.func('uint32_t __stdcall MapVirtualKeyW(uint32_t key, uint32_t type)')
  const attach = user.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)')
  const getState = user.func('int __stdcall GetKeyboardState(_Out_ uint8_t* state)')
  const setState = user.func('int __stdcall SetKeyboardState(uint8_t* state)')
  const send = user.func('intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, void* result)')
  const replace = user.func('__stdcall','SendMessageTimeoutW','intptr_t',['uintptr_t','uint32_t','uintptr_t','str16','uint32_t','uint32_t','void*'])
  const query = user.func('intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t* result)')
  return {
    withPerMonitorV2(operation) {
      const previous = dpi(-4n)
      if (!previous) throw new BackgroundInputRefused('无法核实后台输入的 DPI 坐标；未发送输入')
      try { return operation() } finally { dpi(previous) }
    },
    sessionOf(pid) { const value = [0]; return session(pid, value) ? value[0] : undefined },
    window(hwnd) {
      const pid = [0]
      const thread = owner(hwnd, pid)
      const bounds: [number, number, number, number] = [0, 0, 0, 0]
      if (!thread || !visible(hwnd) || iconic(hwnd) || !enabled(hwnd) || !windowRect(hwnd, bounds) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return
      return { pid: pid[0], thread, root: BigInt(ancestor(hwnd, 2)), bounds }
    },
    focus(thread) {
      const bytes = Buffer.alloc(koffi.sizeof(gui))
      bytes.writeUInt32LE(bytes.length)
      return threadInfo(thread, bytes) ? BigInt(koffi.decode(bytes, gui).focus) : 0n
    },
    standardEdit(hwnd){
      const buffer=Buffer.alloc(512),length=className(hwnd,buffer,256)
      return length>0&&/^(?:Edit|WindowsForms10\.EDIT\..+)$/i.test(buffer.toString('utf16le',0,length*2))
    },
    replaceSelection(hwnd,text){
      setLastError(0)
      if(replace(hwnd,0x00c2,1n,text,0x23,750,null))return 'delivered'
      return lastError()===5?'access-denied':'unknown'
    },
    clientPoint(hwnd, point) {
      const client = { ...point }; const rect = [0, 0, 0, 0]
      if (!screenToClient(hwnd, client) || !clientRect(hwnd, rect)) return
      return { ...client, width: rect[2], height: rect[3] }
    },
    childAt(hwnd, { x, y }) { return BigInt(childFromPoint(hwnd, { x, y }, 7)) },
    hitTest(hwnd, point, timeoutMs=200) {
      const result = [0n]
      return query(hwnd, 0x0084, 0n, packPoint(point.x, point.y), 0x23, timeoutMs, result) ? Number(result[0]) : undefined
    },
    scanCode(key) { return scan(key, 0) },
    withControlState(thread, operation) {
      const own = currentThread()
      if (own === thread || !attach(own, thread, 1)) throw new BackgroundInputRefused('无法建立子会话目标线程的按键状态作用域；未发送输入')
      const state = Buffer.alloc(256)
      let saved = false
      try {
        if (!getState(state)) throw new BackgroundInputRefused('无法保存后台按键状态；未发送输入')
        saved = true
        const controlled = Buffer.from(state)
        controlled[0x11] |= 0x80
        controlled[0xa2] |= 0x80
        if (!setState(controlled)) throw new BackgroundInputRefused('无法设置后台 Ctrl 状态；未发送输入')
        return operation()
      } finally {
        const restored = !saved || Boolean(setState(state))
        const detached = Boolean(attach(own, thread, 0))
        if (!restored || !detached) throw new Error('后台按键状态清理未确认；请停止并检查子会话')
      }
    },
    send(hwnd, message, wParam, lParam, timeout) {
      setLastError(0)
      if (send(hwnd, message, wParam, lParam, 0x23, timeout, null)) return 'delivered'
      return lastError() === 5 ? 'access-denied' : 'unknown'
    },
  }
}
