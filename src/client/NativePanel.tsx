import { useEffect,useState,type CSSProperties } from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {DesktopRuntimeState,DesktopWindow,DesktopFrame} from '../native-contract.ts'
import type {} from '../../lib/typert.remote-client.js'
import { TaskPanel } from './TaskPanel.tsx'

const box:CSSProperties={background:'#1a2030',border:'1px solid #35415d',borderRadius:14,padding:22,marginTop:18}
const field:CSSProperties={background:'#0e1422',color:'#edf0ff',border:'1px solid #4b5874',borderRadius:7,padding:'9px 10px',maxWidth:'100%',boxSizing:'border-box'}
const btn:CSSProperties={background:'#b9bcff',color:'#141529',border:0,padding:'10px 14px',borderRadius:8,cursor:'pointer',fontWeight:600}
const line:CSSProperties={display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginTop:12}
type ActionKind='click'|'move'|'type'|'key'|'scroll'|'drag'|'hold'|'clear'
type DesktopMode = DesktopRuntimeState['backend']
type WindowDiscovery = {
  connection: string
  refresh: number
  windows: DesktopWindow[]
  error?: string
}
const actionOptions: [ActionKind, string][] = [
  ['click','点击 / 双击 / 右键'], ['move','移动真实鼠标'], ['type','输入文本'], ['key','按键 / 快捷键'],
  ['scroll','滚动'], ['drag','拖拽'], ['hold','长按'], ['clear','清空输入框'],
]
const childActions: [ActionKind, string][] = [['click','左键单击'], ['type','输入文本'], ['scroll','垂直滚动']]
const runtimeLabels: Record<DesktopMode, string> = {
  'windows-attended': '本机调试',
  'windows-child-session': 'Windows 子会话 · PiP 试验版',
}

function hasVerifiedChildSession(state: DesktopRuntimeState): boolean {
  const { parentSessionId, childSessionId } = state
  return state.backend === 'windows-child-session' && state.isolated
    && typeof parentSessionId === 'number' && typeof childSessionId === 'number'
    && parentSessionId > 0 && childSessionId > 0 && parentSessionId !== childSessionId
}

function connectionKey(state: DesktopRuntimeState): string {
  if (state.connectionId) return state.connectionId
  return state.backend === 'windows-child-session'
    ? `${state.backend}:${state.parentSessionId}:${state.childSessionId}`
    : state.backend
}

export function NativePanel({ctx}:{ctx:Context}){
  const [state,setState]=useState<DesktopRuntimeState>()
  const [discovery,setDiscovery]=useState<WindowDiscovery>()
  const [refresh,setRefresh]=useState(0)
  const [selection,setSelection]=useState<{ connection: string; id: string }>()
  const [consent,setConsent]=useState(false)
  const [mode,setMode]=useState<DesktopMode>()
  const [foreground,setForeground]=useState(false)
  const [frame,setFrame]=useState<DesktopFrame>()
  const [error,setError]=useState('')
  const [launchPath,setLaunchPath]=useState('')
  const [launchResult,setLaunchResult]=useState('')
  const [applicationProgress,setApplicationProgress]=useState('')
  const [busy,setBusy]=useState(false)
  const [taskActive, setTaskActive] = useState(false)
  const [kind,setKind]=useState<ActionKind>('click')
  const [x,setX]=useState(0);const [y,setY]=useState(0)
  const [toX,setToX]=useState(0);const [toY,setToY]=useState(0)
  const [text,setText]=useState('');const [key,setKey]=useState('tab')
  const [modifiers,setModifiers]=useState('')
  const [delivery,setDelivery]=useState<'background'|'foreground'>('background')
  const [button,setButton]=useState('left');const [count,setCount]=useState(1)
  const [direction,setDirection]=useState('down');const [amount,setAmount]=useState(3)
  const [duration,setDuration]=useState(500)
  const [crop,setCrop]=useState('')
  useEffect(()=>{
    const abort=new AbortController()
    const refresh=()=>{void ctx.remote.virtualDesktop.applicationStatus(abort.signal).then(result=>{
      if(!abort.signal.aborted&&result.ok&&result.value)setApplicationProgress(`${result.value.status} / ${result.value.stage} · ${(result.value.elapsedMs/1000).toFixed(1)} s`)
    }).catch(()=>{})}
    refresh();const timer=setInterval(refresh,750)
    return()=>{clearInterval(timer);abort.abort()}
  },[ctx])
  useEffect(()=>{
    if(busy)return
    const abort=new AbortController()
    const refresh=()=>{void ctx.remote.virtualDesktop.desktopStatus(abort.signal).then(result=>{
      if(abort.signal.aborted)return
      if(result.ok)setState(result.value)
      else setError(result.error.message)
    }).catch(()=>{if(!abort.signal.aborted)setError('无法读取桌面状态')})}
    refresh();const timer=setInterval(refresh,2500)
    return()=>{clearInterval(timer);abort.abort()}
  },[ctx,busy])
  const status=state?.status
  const modeLocked=status!==undefined&&!['disabled','stopped','failed'].includes(status)
  const chosenMode=modeLocked&&state?state.backend:mode??state?.backend??'windows-attended'
  const childChosen=chosenMode==='windows-child-session'
  const childActive=state?.backend==='windows-child-session'
  const childVerified=state!==undefined&&hasVerifiedChildSession(state)
  const runtimeVerified=Boolean(state&&(!childActive||childVerified))
  const observing=runtimeVerified&&(status==='observing'||status==='enabled')
  const connection=observing&&state?connectionKey(state):undefined
  const currentDiscovery=connection&&discovery?.connection===connection&&discovery.refresh===refresh?discovery:undefined
  const discovering=Boolean(connection&&!currentDiscovery)
  const windows=currentDiscovery?.windows??[]
  const discoveryReport=childActive?state?.windowDiscovery:undefined
  const preferred=selection?.connection===connection?selection?.id:undefined
  const target=windows.find(window=>window.id===preferred)
    ?? windows.find(window=>window.id===state?.window?.id)

  useEffect(()=>{
    if(modeLocked&&state){setMode(state.backend);setConsent(false)}
  },[modeLocked,state?.backend])

  useEffect(()=>{
    if(!connection){setDiscovery(undefined);setSelection(undefined);return}
    const activeConnection=connection
    let stale=false
    async function discover(){
      try {
        const list=await ctx.remote.virtualDesktop.windows()
        if(stale)return
        if(!list.ok)throw new Error(list.error.message)
        setDiscovery({connection:activeConnection,refresh,windows:list.value})
      } catch(error) {
        if(!stale)setDiscovery({connection:activeConnection,refresh,windows:[],
          error:error instanceof Error?error.message:String(error)})
      }
    }
    void discover()
    // Ignore a superseded result without cancelling the worker's RPC.
    return()=>{stale=true}
  },[ctx,connection,refresh])

  const view=frame&&observing&&frame.epoch===state?.epoch
    &&(frame.source==='window'?frame.windowId===state.window?.id:!childActive)?frame:undefined
  const options=childChosen?childActions:actionOptions
  const actionKind=options.some(([value])=>value===kind)?kind:'click'
  const scrollDirection=childChosen&&direction!=='up'?'down':direction
  const actionDelivery=childChosen?'background':delivery
  const canExecute=Boolean(view?.source==='window'&&view.windowId===state?.window?.id&&status==='enabled')
  function resetWindow(){setDiscovery(undefined);setSelection(undefined);setFrame(undefined);setForeground(false)}
  function selectMode(value:DesktopMode){
    setMode(value);setConsent(false);resetWindow();setKind('click');setDelivery('background')
  }
  async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  async function enable(){await run(async()=>{
    resetWindow();setConsent(false)
    const result=childChosen?await ctx.remote.virtualDesktop.enableChildSession():await ctx.remote.virtualDesktop.enableLocal()
    if(!result.ok)throw new Error(result.error.message)
    if(result.value.backend!==chosenMode)throw new Error('执行器返回的桌面模式与所选模式不一致')
    if(childChosen&&!hasVerifiedChildSession(result.value))throw new Error('执行器尚未核实子会话身份')
    setState(result.value)
  })}
  async function choose(){
    if(!target||!state||!connection)return
    await run(async()=>{
      const result=await ctx.remote.virtualDesktop.selectWindow(target.id,!childActive&&foreground)
      if(!result.ok)throw new Error(`授权「${target.title||target.app}」失败。${result.error.message}`)
      if(result.value.status!=='enabled'||result.value.window?.id!==target.id||
         connectionKey(result.value)!==connection||result.value.epoch<=state.epoch){
        throw new Error('执行器未确认所选窗口的授权，请刷新窗口后重试。')
      }
      setState(result.value)
      setFrame(undefined)
    })
  }
  async function launchApplication(){
    if(!state?.connectionId||!childVerified)return
        await run(async()=>{
      setLaunchResult('')
      const result=await ctx.remote.virtualDesktop.openApplication(JSON.stringify({path:launchPath.trim(),operationId:crypto.randomUUID()}))
      if(!result.ok)throw new Error(result.error.message)
      setLaunchResult(`${result.value.status}：${result.value.message}`)
      const latest=await ctx.remote.virtualDesktop.desktopStatus()
      if(latest.ok)setState(latest.value)
      if(result.value.frame)setFrame(result.value.frame)
      setRefresh(value=>value+1)
    })
  }
  async function capture(source:'window'|'desktop'){await run(async()=>{
    const result=await ctx.remote.virtualDesktop.capture(source,crop);if(!result.ok)throw new Error(result.error.message)
    setFrame(result.value)
  })}
  async function control(command:'pause'|'resume'|'stop'){
    // Keep the stop channel available while a screenshot or input call is waiting.
    setError('');setFrame(undefined)
    const result=await ctx.remote.virtualDesktop.control(command)
    if(result.ok){setState(result.value);if(command==='stop'){resetWindow();setConsent(false)}}else setError(result.error.message)
  }
  async function execute(){if(!view||!canExecute)return;await run(async()=>{
    const action:Record<string,unknown>={type:actionKind,x,y}
    if(actionKind==='click'){action.button=childActive?'left':button;action.count=childActive?1:count}
    if(actionKind==='type')action.text=text
    if(actionKind==='key'){action.key=key;action.modifiers=modifiers.split('+').map(v=>v.trim()).filter(Boolean)}
    if(actionKind==='scroll'){action.direction=scrollDirection;action.amount=amount}
    if(actionKind==='drag'){action.toX=toX;action.toY=toY;action.durationMs=duration}
    if(actionKind==='hold')action.durationMs=duration
    const operation={operationId:crypto.randomUUID(),frameId:view.id,epoch:view.epoch,delivery:actionDelivery,action}
    setFrame(undefined)
    const result=await ctx.remote.virtualDesktop.manualAction(JSON.stringify(operation));if(!result.ok)throw new Error(result.error.message)
    if(result.value.after)setFrame(result.value.after)
    if(result.value.outcome!=='delivered')throw new Error(`${result.value.outcome}：${result.value.message}。请重新截图，不要直接重放。`)
  })}
  return <>
    <div style={{...box,borderColor:'#605c89'}}>
      <div style={{...line,marginTop:0,justifyContent:'space-between'}}>
        <strong style={{color:'#b6e6d8'}}>{state?runtimeLabels[state.backend]:'正在读取桌面状态'}{status&&` · ${status}`}</strong>
        <div style={line}>
          <button style={{...btn,background:'#34435f',color:'#eef'}} disabled={!modeLocked||status==='pausing'||status==='stopping'} onClick={()=>void control(status==='paused'?'resume':'pause')}>{status==='paused'?'继续（重新截图）':'暂停输入'}</button>
          <button style={{...btn,background:'#f3a9b9'}} onClick={()=>void control('stop')}>立即终止</button>
        </div>
      </div>
      <div style={line}>
        <label htmlFor="dsh-desktop-mode">执行环境</label>
        <select id="dsh-desktop-mode" style={field} value={chosenMode} disabled={!state||modeLocked||busy||taskActive} onChange={e=>selectMode(e.target.value as DesktopMode)}>
          <option value="windows-attended">当前 Windows 桌面 · 本机调试</option>
          <option value="windows-child-session">Windows 子会话 · PiP 试验版</option>
        </select>
      </div>
      {childChosen?<p style={{color:'#c4cbe1'}}>PiP 是独立的 Windows 会话。可在下方输入应用的 .exe 绝对路径并启动，无需先绑定窗口。主桌面已有的 VMware 窗口不会迁入 PiP。支持的应用会验证并绑定主窗口；其他应用需核对后手动授权。</p>
        :<p style={{color:'#c4cbe1'}}>本机调试会观察当前 Windows 桌面，前台输入会使用当前桌面的焦点和鼠标。</p>}
      <p style={{color:'#c4cbe1'}}>任务截图会交给 DSH 选定的图像模型并保存为附件。</p>
      {childActive&&<p aria-live="polite" style={{color:'#aeb9d5'}}>{childVerified&&modeLocked?`已核实会话 ID · 主会话 ${state.parentSessionId} · 子会话 ${state.childSessionId}`:'当前没有可用的已核实子会话。输入保持关闭。'}</p>}
      {childVerified&&modeLocked&&state?.pipDisplay&&<p style={{color:'#aeb9d5'}}>
        PiP 连接时桌面分辨率 {state.pipDisplay.actual ? `${state.pipDisplay.actual.width}×${state.pipDisplay.actual.height}` : '读取失败'}（请求 {state.pipDisplay.requested.width}×{state.pipDisplay.requested.height}）
      </p>}
      {!modeLocked&&<label style={{display:'block',marginTop:10}}><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{childChosen?' 我同意打开 PiP 窗口，并允许 Harness 观察子会话窗口。':' 我同意开启本机观察，并知晓这是非隔离调试。'}</label>}
      <div style={line}>
        {!modeLocked&&<button style={btn} disabled={!state||!consent||busy||taskActive} onClick={()=>void enable()}>{childChosen?'打开 PiP 并发现窗口':'开启观察并发现窗口'}</button>}
        {modeLocked&&<button style={btn} disabled={!observing||discovering||busy||taskActive} onClick={()=>setRefresh(value=>value+1)}>刷新窗口</button>}
        <select aria-label="目标窗口" style={{...field,minWidth:280,flex:1}} value={target?.id??''} disabled={!observing||discovering||!windows.length||busy||taskActive} onChange={e=>{if(connection)setSelection({connection,id:e.target.value})}}>
          <option value="">{discovering?'正在读取当前会话的窗口…':'选择一个明确的目标窗口'}</option>{windows.map(window=><option key={window.id} value={window.id}>{window.app} · {window.title} · PID {window.pid}</option>)}
        </select>
      </div>
      {currentDiscovery?.error&&<p role="alert" style={{color:'#ffb8c3'}}>读取窗口失败。{currentDiscovery.error} 请刷新窗口。</p>}
      {currentDiscovery&&!currentDiscovery.error&&!windows.length&&<p role="status" style={{color:'#aeb9d5'}}>{childActive
        ?`子会话 ${state?.childSessionId} 暂无可授权的应用窗口。使用「在 PiP 启动应用」，或让 DeepSeek 调用 desktop_open_application。`
        :'当前桌面暂无可授权的应用窗口。打开应用后刷新窗口。'}</p>}
      {childActive&&observing&&<div style={{marginTop:12}}>
        <label>应用 .exe 绝对路径<input style={{...field,width:'100%'}} value={launchPath} onChange={event=>setLaunchPath(event.target.value)} placeholder={'C:\\Program Files\\应用\\app.exe'}/></label>
        <button style={{...btn,marginTop:8}} disabled={busy||taskActive||!launchPath.trim()} onClick={()=>void launchApplication()}>在 PiP 打开并绑定应用</button>
        <p>此按钮授权启动、检查并绑定所填应用，不传命令行参数。验证不足时需手动核对。共享当前账户的文件和设置。</p>
        {launchResult&&<p role="status">{launchResult}</p>}
        {applicationProgress&&<p role="status">{applicationProgress}</p>}
      </div>}
      {discoveryReport&&<details style={{color:'#aeb9d5',marginTop:12}}>
        <summary>窗口发现诊断</summary>
        <p>顶层窗口 {discoveryReport.rawTopLevel??'读取失败'} · SDK 候选 {discoveryReport.sdkCandidates} · 可授权 {discoveryReport.sessionEligible??discoveryReport.workerEligible}</p>
        {discoveryReport.sdkSelection&&<div>
          <p>未进入 SDK 候选 {discoveryReport.sdkSelection.notCandidate} · SDK 有而 Win32 本次未采到 {discoveryReport.sdkSelection.candidateNotInRaw}</p>
          <p>未入选项观察状态：不可见 {discoveryReport.sdkSelection.observedStates.notVisible} · 最小化 {discoveryReport.sdkSelection.observedStates.minimized} · 无效尺寸 {discoveryReport.sdkSelection.observedStates.invalidBounds} · 其他或未知 {discoveryReport.sdkSelection.observedStates.otherOrUnknown}</p>
          <p>{discoveryReport.sdkSelection.note}</p>
        </div>}
        <p>系统界面 {discoveryReport.filtered.systemSurface} · 应用已最小化 {discoveryReport.filtered.minimized} · 无效尺寸 {discoveryReport.filtered.invalidBounds} · 无法核实身份 {discoveryReport.filtered.unverifiedProcess+discoveryReport.filtered.unverifiedWindow} · 禁止操作 {discoveryReport.filtered.blockedProcess}</p>
        {discoveryReport.systemSurfaces?.map((item,index)=><p key={index}>{item.image} · PID {item.pid} · {item.title||'无标题'} · {item.reason}</p>)}
      </details>}
      <div style={line}>
        {childChosen?<span style={{fontSize:13,color:'#c4cbe1'}}>点击、输入和垂直滚动均定向投递至子会话；可最小化预览，仍需核对每步结果。</span>:<label><input type="checkbox" checked={foreground} disabled={!observing||busy||taskActive} onChange={e=>setForeground(e.target.checked)}/> 允许对此窗口使用前台输入（会影响焦点与鼠标）</label>}
        <button style={btn} disabled={!observing||!target||busy||taskActive} onClick={()=>void choose()}>授权该窗口输入</button>
      </div>
      <p role="status" style={{fontSize:13,color:'#aeb9d5'}}>已绑定：{state?.window?`${state.window.app} · ${state.window.title||'无标题'} · ${childActive?`子会话 ${state.childSessionId}`:'当前桌面'} · 授权代次 ${state.epoch}`:'无'}。{state?.connectionId&&`本次连接 ${state.connectionId.slice(0,8)}。 `}PiP 模型工具遵循当前会话权限；完全权限且从不询问时无需另行批准。面板任务仍逐步确认。</p>
      <p aria-live="polite" style={{color:'#aeb9d5'}}>{state?.lastResult}</p>
      {error&&<p role="alert" style={{color:'#ffb8c3',whiteSpace:'pre-wrap'}}>{error}</p>}
    </div>
    <TaskPanel ctx={ctx} runtime={state} runtimeVerified={runtimeVerified} childMode={childChosen} onActiveChange={setTaskActive} />
    <div style={box}>
      <div style={{...line,marginTop:0}}>
        <strong>1. 获取真实观察</strong>
        <button style={btn} disabled={busy||taskActive||!observing||status!=='enabled'} onClick={()=>void capture('window')}>窗口截图</button>
        {!childChosen&&<button style={{...btn,background:'#34435f',color:'#eef'}} disabled={busy||taskActive||!observing||!state?.capabilities.desktopCapture} onClick={()=>void capture('desktop')}>主桌面截图（仅观察）</button>}
      </div>
      <label style={{display:'block',marginTop:14,fontSize:13,color:'#c4cbe1'}}>可选裁剪 JSON（原截图像素）：<input aria-label="截图裁剪区域" style={{...field,marginLeft:8,width:330}} placeholder='{"x":0,"y":0,"width":600,"height":400}' value={crop} onChange={e=>setCrop(e.target.value)}/></label>
      {view?<>
        <p style={{fontSize:12,color:'#aeb9d5'}}>{view.width} × {view.height} · {new Date(view.capturedAt).toLocaleTimeString()} · epoch {view.epoch} · {view.source==='desktop'?'主桌面（此帧不能用于输入）':childActive?'子会话窗口':'窗口'}。点击图片定位坐标。</p>
        <img alt="最新真实桌面观察" src={`data:${view.mimeType};base64,${view.data}`} style={{display:'block',maxWidth:'100%',maxHeight:420,cursor:'crosshair',outline:'1px solid #465371'}} onClick={event=>{
          const rect=event.currentTarget.getBoundingClientRect();setX(Math.floor((event.clientX-rect.left)/rect.width*view.width));setY(Math.floor((event.clientY-rect.top)/rect.height*view.height))
        }}/>
        <details style={{marginTop:12}}><summary>界面文本（不可信任务数据）</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:160,overflow:'auto',fontSize:12}}>{view.tree||'没有 UIA 文本；以真实截图为准'}</pre></details>
      </>:<p style={{color:'#aeb9d5'}}>暂无可用截图。每次输入消耗一帧；窗口位置或焦点改变后重新观察。</p>}
    </div>
    <div style={box}>
      <strong>2. 审阅并执行单个动作</strong>
      <p style={{fontSize:13,color:'#c4cbe1'}}>点击“执行本次操作”即批准这里显示的目标、动作、内容和投递模式。输入已交付不代表目标已达成，执行后检查新截图。</p>
      <div style={line}>
        <select aria-label="动作类型" style={field} value={actionKind} onChange={e=>setKind(e.target.value as ActionKind)}>{options.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
        <label>X <input aria-label="动作 X 坐标" type="number" min={0} style={{...field,width:90}} value={x} onChange={e=>setX(Number(e.target.value))}/></label>
        <label>Y <input aria-label="动作 Y 坐标" type="number" min={0} style={{...field,width:90}} value={y} onChange={e=>setY(Number(e.target.value))}/></label>
        {childChosen?<span style={{fontSize:13,color:'#c4cbe1'}}>子会话后台输入</span>:<select aria-label="投递模式" style={field} value={delivery} onChange={e=>setDelivery(e.target.value as 'background'|'foreground')}><option value="background">后台尝试</option><option value="foreground">明确使用前台</option></select>}
      </div>
      {!childChosen&&actionKind==='click'&&<div style={line}><select style={field} aria-label="鼠标按键" value={button} onChange={e=>setButton(e.target.value)}><option value="left">左键</option><option value="right">右键</option><option value="middle">中键</option></select><select style={field} aria-label="点击次数" value={count} onChange={e=>setCount(Number(e.target.value))}><option value={1}>单击</option><option value={2}>双击</option></select></div>}
      {actionKind==='type'&&<textarea aria-label="要输入的文本" style={{...field,display:'block',width:'100%',minHeight:80,marginTop:12}} placeholder="普通文本，支持中文；凭据请人工输入" maxLength={2000} value={text} onChange={e=>setText(e.target.value)}/>}
      {actionKind==='key'&&<div style={line}><input aria-label="按键名称" style={field} value={key} onChange={e=>setKey(e.target.value)}/><input aria-label="组合键修饰符" style={field} placeholder="ctrl+shift（可空）" value={modifiers} onChange={e=>setModifiers(e.target.value)}/></div>}
      {actionKind==='scroll'&&<div style={line}><select style={field} aria-label="滚动方向" value={scrollDirection} onChange={e=>setDirection(e.target.value)}>{(childChosen?['down','up']:['down','up','left','right']).map(value=><option key={value}>{value}</option>)}</select><input type="number" min={1} max={10} aria-label="滚动刻度" style={field} value={amount} onChange={e=>setAmount(Number(e.target.value))}/></div>}
      {actionKind==='drag'&&<div style={line}><label>终点 X <input type="number" min={0} style={field} value={toX} onChange={e=>setToX(Number(e.target.value))}/></label><label>终点 Y <input type="number" min={0} style={field} value={toY} onChange={e=>setToY(Number(e.target.value))}/></label></div>}
      {(actionKind==='drag'||actionKind==='hold')&&<label style={{display:'block',marginTop:12}}>持续毫秒 <input style={field} type="number" min={100} max={2000} value={duration} onChange={e=>setDuration(Number(e.target.value))}/></label>}
      <button style={{...btn,marginTop:16}} disabled={busy||taskActive||!canExecute} onClick={()=>void execute()}>{busy?'等待真实反馈…':'执行本次操作'}</button>
    </div>
  </>
}
