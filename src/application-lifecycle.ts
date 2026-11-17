import { setTimeout as delay } from 'node:timers/promises'
import type { NativeSession } from './native-session.ts'
import type { ApplicationResult, DesktopRuntimeState, DesktopWindow } from './native-contract.ts'
import { applicationInput, resolveApplication, type ApplicationInput, type ResolvedApplication } from './application-catalog.ts'
import { applicationAdapters } from './application-adapters.ts'

type Port = Pick<NativeSession,'status'|'enable'|'windows'|'launch'|'select'|'capture'|'control'>
export type ApplicationAuthorization = (reason: string) => Promise<void | (() => void)>
const pathKey = (path: string) => path.replaceAll('/','\\').toLowerCase()
const errorTitle = /\berror\b|unrecoverable|fatal|错误|失败|崩溃/i
function child(state: DesktopRuntimeState): void {
  if (state.status==='stopping'||state.status==='pausing') throw Object.assign(new Error('桌面连接正在结束或排空，请稍后重试'),{reason:'connection-closing',retryAfterMs:500,nextTool:'desktop_open_application'})
  if (state.backend!=='windows-child-session'||!state.isolated||!state.connectionId||!state.childSessionId||
      !state.parentSessionId||state.childSessionId===state.parentSessionId||!['observing','enabled'].includes(state.status))
    throw new Error('需要正在运行的已核实 PiP 子会话；暂停或切换后请由用户恢复')
}
export function sameApplicationScope(a: DesktopRuntimeState,b: DesktopRuntimeState): boolean {
  return a.connectionId===b.connectionId&&a.epoch===b.epoch&&a.status===b.status&&a.backend===b.backend&&
    a.isolated===b.isolated&&a.childSessionId===b.childSessionId&&a.parentSessionId===b.parentSessionId&&
    a.window?.id===b.window?.id&&a.window?.pid===b.window?.pid
}
export function applicationWindowKind(window: DesktopWindow, adapter: ResolvedApplication['adapter']): 'error'|'main'|'review' {
  if ((adapter==='vmware'||window.windowClass==='#32770')&&errorTitle.test(window.title)) return 'error'
  if (!window.responsive || !window.windowClass || window.windowClass==='#32770') return 'review'
  return applicationAdapters.get(adapter).mainWindow(window) ? 'main' : 'review'
}

/** Shared owner-panel and chat lifecycle. It never retries a launch after uncertainty. */
export class ApplicationLifecycle {
  private busy = false
  private receipts = new Map<string,{key:string;result:ApplicationResult}>()
  private uncertain = new Map<string,ApplicationResult>()
  private progress?: {status:string;stage:string;startedAt:number;elapsedMs:number;operationId:string}
  constructor(private readonly native: Port, private readonly resolve = resolveApplication, private readonly waitMs = 20000) {}
  snapshot(){return this.progress?{...this.progress,elapsedMs:this.busy?Date.now()-this.progress.startedAt:this.progress.elapsedMs}:null}
  assertIdle(): void { if(this.busy) throw new Error('应用启动与绑定正在进行，请等待结果或终止连接') }
  async open(value: ApplicationInput, authorize: ApplicationAuthorization, signal: AbortSignal): Promise<ApplicationResult> {
    const input = applicationInput.parse(value)
    this.assertIdle();this.busy=true
    let scope: DesktopRuntimeState|undefined, bound: DesktopRuntimeState|undefined
    let path='', stage='resolve', pid:number|undefined, issued=false
    this.progress={status:'launching',stage,startedAt:Date.now(),elapsedMs:0,operationId:input.operationId}
    const setStage=(next:string)=>{stage=next;this.progress={...this.progress!,stage:next,status:next==='waiting_window'?'waiting_window':'launching'}}
    const key=JSON.stringify({appId:input.appId,path:input.path})
    const result=(status:ApplicationResult['status'],message:string,extra:Partial<ApplicationResult>={}):ApplicationResult=>({
      operationId:input.operationId,status,stage,path,message,connectionId:scope?.connectionId,childSessionId:scope?.childSessionId,epoch:scope?.epoch,pid,
      ...(scope?.pipDisplay ? { pipDisplay: scope.pipDisplay } : {}),...extra,
    })
    const remember=(value:ApplicationResult)=>{
      if(this.progress)this.progress={...this.progress,status:value.status,stage:value.stage,elapsedMs:Date.now()-this.progress.startedAt}
      this.receipts.set(input.operationId,{key,result:value})
      if(value.status!=='ready'&&scope?.connectionId) this.uncertain.set(`${scope.connectionId}|${pathKey(path)}`,value)
      return value
    }
    try {
      signal.throwIfAborted()
      const old=this.receipts.get(input.operationId)
      if(old){
        if(old.key!==key)throw new Error('同一 operationId 不能改换应用')
        const state=await this.native.status(signal)
        this.progress={...this.progress!,status:old.result.status,stage:old.result.stage,elapsedMs:Date.now()-this.progress!.startedAt}
        if(state.connectionId!==old.result.connectionId||state.epoch!==old.result.epoch||!['observing','enabled'].includes(state.status))
          {this.progress.status='unknown';return {...old.result,status:'unknown',frame:undefined,message:'原请求已完成，但连接或授权已变化；没有重放启动。'}}
        return {...old.result,frame:undefined}
      }
      if(this.receipts.size>=128)throw new Error('本次 Host 的启动请求已达上限，请检查已有结果')
      const app=await this.resolve(input);path=app.path
      const before=await this.native.status(signal)
      const inactive=['disabled','stopped','failed'].includes(before.status)
      if(!inactive)child(before)
      setStage('authorize')
      const recheck=await authorize(`在 PiP 打开并绑定应用 ${JSON.stringify(path)}。必要时建立当前账户的 Windows 子会话；只启动此 .exe，不传参数。将检查窗口并采集截图，应用仍共享当前账户的文件和设置。`)
      signal.throwIfAborted()
      if(!sameApplicationScope(before,await this.native.status(signal)))throw new Error('批准期间连接或授权已变化')
      recheck?.()
      setStage('connect')
      scope=inactive?await this.native.enable(signal,'windows-child-session'):before
      child(scope)
      const guard=async()=>{
        signal.throwIfAborted()
        const now=await this.native.status(signal);child(now)
        if(!sameApplicationScope(scope!,now))throw new Error('应用启动期间连接或授权已改变，已停止后续操作')
        signal.throwIfAborted();recheck?.()
      }
      const blocked=this.uncertain.get(`${scope.connectionId}|${pathKey(path)}`)
      if(blocked)return remember(result(blocked.status,`此前请求 ${blocked.operationId} 未确认就绪：${blocked.message} 没有重复启动；请在面板检查，或结束连接后重试。`))
      setStage('discover')
      const matches=async()=> (await this.native.windows(signal)).filter(w=>w.imagePath&&pathKey(w.imagePath)===pathKey(path))
      let candidates=await matches();await guard()
      const reused=candidates.length>0
      if(!reused){
        setStage('launch');await guard();issued=true
        const launch=await this.native.launch(path,input.operationId,scope.connectionId!,scope.epoch,signal);pid=launch.pid
      }
      setStage('waiting_window')
      const deadline=Date.now()+this.waitMs
      let previous='',target:DesktopWindow|undefined
      while(Date.now()<deadline){
        await guard();candidates=await matches();await guard()
        const failure=candidates.find(w=>applicationWindowKind(w,app.adapter)==='error')
        if(failure)return remember(result('app_error',`应用显示错误窗口：${failure.title}。没有绑定该错误窗口。`,{window:failure,pid:failure.pid}))
        const main=candidates.filter(w=>applicationWindowKind(w,app.adapter)==='main')
        if(main.length>1)return remember(result('instance_conflict','发现多个主窗口，无法唯一确认目标；请在面板选择。'))
        if(main.length===1){
          if(main[0].id===previous){target=main[0];break}
          previous=main[0].id
        } else previous=''
        await delay(400,undefined,{signal})
      }
      if(!target)return remember(result(candidates.length?'needs_review':'timed_out',candidates.length?
        '应用窗口已出现，但尚无匹配的主窗口证据。请在面板核对并授权；没有重复启动。':'在等待期限内没有可验证的应用窗口。结果未确认，请检查后再处理，不要重复启动。',
        {window:candidates[0],pid:candidates[0]?.pid??pid,reused}))
      setStage('bind');await guard()
      bound=await this.native.select(target.id,false,signal,scope.epoch)
      if(bound.connectionId!==scope.connectionId||bound.childSessionId!==scope.childSessionId||bound.parentSessionId!==scope.parentSessionId||
        bound.epoch!==scope.epoch+1||bound.status!=='enabled'||bound.window?.id!==target.id||bound.foregroundAllowed)throw new Error('绑定回执不匹配')
      scope=bound
      setStage('verify_frame');await guard()
      const frame=await this.native.capture('window',undefined,signal,undefined,true)
      if(frame.windowId!==target.id||frame.epoch!==scope.epoch)throw new Error('截图不属于本次绑定')
      const visual=frame.visualContent===true
      const mainUi=applicationAdapters.get(app.adapter).readyEvidence(frame)
      await guard()
      if(!visual||!mainUi){
        await this.native.control('pause',signal);bound=undefined
        scope=await this.native.status(signal)
        return remember(result('needs_review','已取得窗口，但主界面验证不足；连接已暂停，需在面板检查后恢复。',{window:target,pid:target.pid,reused,frame}))
      }
      const fresh=await matches();await guard()
      if(fresh.some(w=>applicationWindowKind(w,app.adapter)==='error')||!fresh.some(w=>w.id===target!.id&&applicationWindowKind(w,app.adapter)==='main'))
        throw new Error('截图后主窗口状态已变化')
      setStage('ready')
      return remember(result('ready','应用主窗口、子会话、绑定和截图验证通过；任务完成仍需实际结果验收。',{window:target,pid:target.pid,reused,frame}))
    } catch(error) {
      if(this.progress)this.progress={...this.progress,status:'failed',elapsedMs:Date.now()-this.progress.startedAt}
      if(bound){
        try {const now=await this.native.status(AbortSignal.timeout(5000));if(sameApplicationScope(bound,now))await this.native.control('pause',AbortSignal.timeout(5000))}catch{}
      }
      if(!issued&&!bound)throw error
      return remember(result('unknown',`${error instanceof Error?error.message:'启动结果未知'}；没有自动重试。`))
    } finally {this.busy=false}
  }
}
