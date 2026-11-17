import { applicationInput } from './application-catalog.ts'
import { sameApplicationScope, type ApplicationAuthorization } from './application-lifecycle.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { pluginBuild } from './build-identity.ts'
import { operationSchema,actionSchema,targetSelectorSchema,type DesktopFrame,type DesktopRuntimeState } from './native-contract.ts'
import { redactDiagnostics, redactText, projectToolReceipt } from './redaction.ts'
import { childDelivery } from './child-delivery.ts'
import { resolveChildStartPermission, sessionApprovalPolicy } from './child-start-permission.ts'
import { openChildSessionFromTool, selectChildWindowFromTool, launchChildFromTool } from './connection-tools.ts'
import { childExecutableSchema } from './child-launch.ts'
import type { VirtualDesktopController } from './controller.ts'
import { taskGoalSchema } from './task-contract.ts'
import { admitFrameResult, type FrameToolResult } from './frame-attachment.ts'
import { vmCommandInputSchema } from './vm-adapter.ts'
import type { VmPowerAuthorization } from './vm-command-service.ts'

const empty={type:'object',properties:{},additionalProperties:false}
const selectInput = z.strictObject({ windowId: z.uuid() })
const restoreInput = z.strictObject({ connectionId:z.uuid(), epoch:z.int().nonnegative(), windowId:z.uuid(), pid:z.int().positive() })
const launchInput = z.strictObject({ path: childExecutableSchema, operationId: z.uuid().optional() })
const point={x:{type:'number'},y:{type:'number'}}
const frameFields={operationId:{type:'string'},frameId:{type:'string'},epoch:{type:'integer'},delivery:{type:'string',enum:['background','foreground']}}
const openApplicationInput = z.strictObject({appId:z.enum(['vmware-workstation']).optional(),path:childExecutableSchema.optional(),operationId:z.uuid().optional()})
const connectHint = '需要应用时优先调用 desktop_open_application({appId:"vmware-workstation"})，其他应用传本地绝对 .exe 路径 path。它会建立 PiP、启动并核验绑定，不需要已有窗口。needs_review 时请在面板核对；不要反复对空窗口调用 desktop_start_task。' 

function requireObservation(status: DesktopRuntimeState['status'], disconnected: string): void {
  if (status === 'paused') throw new Error('桌面观察已暂停，请在面板继续，或调用 desktop_resume_task 继续非任务连接。')
  if (status === 'pausing' || status === 'stopping') throw new Error('桌面状态正在切换，请稍后重新读取 desktop_get_task_status。')
  if (status !== 'observing' && status !== 'enabled') throw new Error(disconnected)
}

/** Exact route proof before observation or input. */
async function requireVision(ctx:Context,exec:ToolExecution,requireAttachmentStore=true):Promise<{provider:string;model:string}>{
  if(requireAttachmentStore&&!ctx.get('attachments'))throw new Error('DSH 图像附件服务未挂载')
  const header=exec.agent?.session.requestHeader()?.config
  const provider=header?.provider??exec.agent?.options.provider
  const model=header?.model??exec.agent?.options.model
  const llm=ctx.get('llm')
  if(!llm || provider===undefined || model===undefined)throw new Error('无法核实当前模型路由；请使用支持图像的 DSH 模型')
  const info=await llm.resolveModelInfo(provider,model,exec.signal)
  if(!info.inputModalities?.includes('image'))throw new Error('当前模型没有声明图像输入能力；未执行桌面动作')
  return { provider, model }
}
function frameResult(frame:DesktopFrame,details:Record<string,unknown>={}): FrameToolResult {
  const {data,...metadata}=frame
  return {content:[{type:'image',mimeType:frame.mimeType,data}],structuredContent:projectToolReceipt({...metadata,...details})}
}
function uiaMetadata(frame:DesktopFrame) {
  const {data,filePath,accessibility,...metadata}=frame
  if(!accessibility)return metadata
  const {visualCandidates,suggestedTargets,...uia}=accessibility
  const targets=suggestedTargets?.filter(target=>target.basis==='uia-bounds')
  return {...metadata,accessibility:{...uia,...(targets?{suggestedTargets:targets}:{})}}
}
function textResult(value:unknown){return {content:[{type:'text',text:JSON.stringify(projectToolReceipt(value))}]}}

function connectionApproval(ctx: Context, exec: ToolExecution): (reason: string) => Promise<void> {
  const approval = ctx.get('approval')
  const { agent, name, callId, signal } = exec
  if (!agent || !approval) throw new Error('需要 DSH 的单次人工批准通道')
  return async reason => {
    const decision = await approval.request({ agent, toolName: name, callId, signal, reason })
    if (decision !== 'allowed-once') throw new Error('需要用户本次批准，未开启连接或绑定窗口')
  }
}

function childAuthorization(ctx:Context,exec:ToolExecution):ApplicationAuthorization {
  return async reason=>{
    const permission=resolveChildStartPermission(ctx,exec.agent)
    if(permission==='blocked')throw new Error('当前从不询问且未核实完全权限，请在虚拟桌面工具面板完成授权')
    if(permission==='session-grant')return ()=>{
      if(resolveChildStartPermission(ctx,exec.agent)!=='session-grant')throw new Error('会话权限已变化，未派发操作')
    }
    await connectionApproval(ctx,exec)(reason)
    return ()=>{if(resolveChildStartPermission(ctx,exec.agent)!=='ask')throw new Error('批准后会话策略已变化，请重新核验权限')}
  }
}

function vmPowerAuthorization(ctx: Context, exec: ToolExecution): VmPowerAuthorization {
  const eligible = () => {
    const session = exec.agent?.session
    return !!session && ctx.get('permissionPresets')?.current(session) === 'danger-full-access' &&
      ctx.get('sandboxPolicy')?.resolve({ session })?.mode === 'danger-full-access'
  }
  return {
    eligible,
    async approve(reason) {
      if (!eligible()) return undefined
      const policy = sessionApprovalPolicy(ctx, exec.agent)
      const recheck = () => eligible() && sessionApprovalPolicy(ctx, exec.agent) === policy
      if (policy === 'never') return recheck
      const approval = ctx.get('approval')
      if (!approval || !exec.agent) return undefined
      const decision = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal, reason })
      return decision === 'allowed-once' && recheck() ? recheck : undefined
    },
  }
}
function operationIdFor(exec:ToolExecution):string {
  const hash=createHash('sha256').update(String(exec.callId??randomUUID())).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
}

/** Native Cordis tools reuse DSH's durable MCP-image admission adapter, not a separate MCP server. */
export function registerNativeTools(ctx:Context,service:VirtualDesktopController):void{
  const imageHashes=new WeakMap<object,string>()
  // Zod 4 attaches non-JSON ~standard callbacks to its JSON Schema root. DSH's
  // lossless schema snapshot rejects those; admit only the serialized schema.
  const add=(name:string,description:string,inputSchema:Record<string,unknown>,call:(args:Record<string,unknown>,exec:ToolExecution)=>Promise<unknown>)=>{
    const checked=async(args:Record<string,unknown>,exec:ToolExecution)=>{
      try{return await call(args,exec)}catch(error){
        const e=error as Error & {reason?:string;nextTool?:string;retryAfterMs?:number;association?:string}
        service.recordToolFailure?.(name,e)
        const proposed=e.nextTool??'desktop_get_task_status'
        const nextTool=proposed===name?(name==='desktop_open_child_session'?'desktop_reset_child_session':name==='desktop_get_task_status'?'desktop_get_diagnostics':'desktop_get_task_status'):proposed
        throw new Error(JSON.stringify({error:redactText(e.message??String(error)),reason:e.reason??'request-failed',nextTool,...(e.association?{association:e.association}:{}),...(e.retryAfterMs===undefined?{}:{retryAfterMs:e.retryAfterMs}),...(name==='desktop_open_application'&&pluginBuild?{plugin:pluginBuild}:{})}))
      }
    }
    const parameters=JSON.parse(JSON.stringify(inputSchema))
    const finalizeContent=(_exec:unknown,result:any)=>{
      if(!result.isError)return undefined
      try{
        const text=result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')
        const value=JSON.parse(text.slice(text.indexOf('{')))
        if(typeof value.nextTool==='string'&&typeof value.reason==='string')return [{type:'text' as const,text:JSON.stringify(value)}]
      }catch{}
      return undefined
    }
    if(['desktop_get_screenshot','desktop_execute_action','desktop_click','desktop_click_target','desktop_type_text','desktop_press_key','desktop_scroll','desktop_move_mouse'].includes(name)){
      ctx.tools.register({name,description,parameters,output:{schema:{type:'object',properties:{content:{type:'array',items:{}},structuredContent:{}},required:['content'],additionalProperties:false},render:(_args,value:any)=>value.content},
        execute:async(args,exec)=>{
          const result=await admitFrameResult(ctx,await checked(args as Record<string,unknown>,exec) as FrameToolResult)
          const hash=result.structuredContent?.screenshotSha256
          if(name==='desktop_get_screenshot'&&exec.agent?.session&&result.structuredContent?.imageMode==='attachment'&&typeof hash==='string')imageHashes.set(exec.agent.session,hash)
          return result
        },finalizeContent})
    }else ctx.tools.register({...createMcpToolDefinition(ctx,{name,rawName:name,description,inputSchema:parameters,call:checked}),finalizeContent})
  }
  add('desktop_reset_child_session','幂等重置本插件拥有的 PiP/孤儿子会话。只接受可选 operationId；未连接成功返回 state=idle，完成自有清理返回 state=released 与 releasedPids。相同 operationId 返回原回执，不会关闭后来建立的连接。撤销旧帧和授权；不终止其它进程或会话，不授予新权限。',{type:'object',properties:{operationId:{type:'string',format:'uuid'}},additionalProperties:false},async(args,exec)=>{
    const input=z.strictObject({operationId:z.uuid().optional()}).parse(args)
    return textResult(await service.resetChildSession(input.operationId??operationIdFor(exec),exec.signal))
  })
  add('desktop_export_diagnostics','将当前状态、脱敏日志和最多 5 张已遮蔽的近期帧导出到本机 zip。默认不包含截图；不会上传。',{type:'object',properties:{recentFrames:{type:'integer',minimum:0,maximum:5}},additionalProperties:false},async(args,exec)=>{
    const input=z.strictObject({recentFrames:z.int().min(0).max(5).default(0)}).parse(args)
    const result=await service.exportDiagnostics(input.recentFrames,exec.signal)
    return textResult(result)
  })
  add('desktop_open_application','优先使用：一次请求建立 PiP、在子会话启动应用、核验并绑定主窗口。VMware 使用 appId=vmware-workstation，其他应用使用绝对 exe 路径 path（两者选一）。完全权限且从不询问遵循会话授权。ready 才表示主窗口验证通过；needs_review 要在面板核对。失败或超时不要换 ID 反复启动。',z.toJSONSchema(openApplicationInput,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const parsed=openApplicationInput.parse(args)
    const input=applicationInput.parse({...parsed,operationId:parsed.operationId??operationIdFor(exec)})
    const result=await service.openApplicationApproved(JSON.stringify(input),childAuthorization(ctx,exec),exec.signal)
    // Opening/binding does not require a vision model; screenshots are fetched explicitly
    // through the image-admission tool, which verifies the active model route.
    const {frame,...metadata}=result
    return textResult({...metadata,...(pluginBuild?{plugin:pluginBuild}:{}),...(frame?{filePath:frame.filePath,scale:frame.scale}:{}),...(result.status==='ready'?{nextTool:'desktop_get_screenshot'}:{})})
  })
  add('desktop_vm_command','在已绑定 VMware Workstation 的 PiP 子会话中运行固定 vmrun 命令。appId=vmware-workstation，operationId 必须是 UUID。list 只读且不传 vm，确认后返回 state=listed 和 runningCount，空列表的数量为 0。start/stop/suspend/reset 要求本会话的完全权限，以及允许根目录内的可信 VM 名称或 VMX 路径。目标窗口可最小化。按证据确认状态，未知时用新请求 list 检查，勿重复电源命令。仅显式 fallback=ui 且命令确定未执行时返回新截图入口，UI 输入沿用独立授权。',z.toJSONSchema(vmCommandInputSchema,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const input = vmCommandInputSchema.parse(args)
    const authorize = input.command === 'list' ? undefined : vmPowerAuthorization(ctx, exec)
    return textResult(await service.vmCommandApproved(input, authorize, exec.signal))
  })
  add('desktop_launch_in_child_session','PiP 只有系统窗口、窗口列表为空时，下一步使用本工具启动应用，不要先启动任务。只需提供本地 .exe 绝对路径 path，operationId 可选；不接受命令行参数。无需已绑定窗口。完全权限且从不询问使用会话授权，否则请求本次批准。回执返回 operationId，重试时复用它；窗口未出现时先重新发现，不要盲目重复启动。',z.toJSONSchema(launchInput,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const input = launchInput.parse(args)
    const path = input.path
    const hash = createHash('sha256').update(String(exec.callId ?? randomUUID())).digest('hex')
    const operationId = input.operationId ?? `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
    return textResult(await launchChildFromTool(service, path, operationId, async reason => {
      const permission = resolveChildStartPermission(ctx, exec.agent)
      if (permission === 'blocked') throw new Error('当前从不询问且未核实完全权限，请在面板使用「在 PiP 启动应用」')
      if (permission === 'session-grant') return () => {
        if (resolveChildStartPermission(ctx, exec.agent) !== 'session-grant') throw new Error('会话权限已变化，未启动应用')
      }
      await connectionApproval(ctx, exec)(reason)
    }, exec.signal))
  })
  add('desktop_open_child_session','按当前 Harness 会话权限打开 Windows 画中画并返回窗口列表。完全权限且从不询问时直接启动，需询问时请求本次批准。窗口绑定和输入另行授权。',empty,async(args,exec)=>{
    z.strictObject({}).parse(args)
    return textResult(await openChildSessionFromTool(service, async reason => {
      const permission = resolveChildStartPermission(ctx, exec.agent)
      if (permission === 'blocked') {
        throw new Error('当前会话设为从不询问，且未核实完全权限。请用户在虚拟桌面工具面板打开 PiP，或调整此会话的权限。')
      }
      if (permission === 'session-grant') {
        return () => {
          if (resolveChildStartPermission(ctx, exec.agent) !== 'session-grant') {
            throw new Error('会话权限已变化，未启动 PiP。请按当前权限重试。')
          }
        }
      }
      await connectionApproval(ctx, exec)(reason)
    }, exec.signal))
  })
  add('desktop_get_windows','列出可授权应用窗口。includeDiagnostics=true 时返回 {windows,windowDiscovery}。PiP 为空时可调用 desktop_launch_in_child_session 启动应用，无需先绑定窗口。',{type:'object',properties:{includeDiagnostics:{type:'boolean'}},additionalProperties:false},async(args,exec)=>{
    const { includeDiagnostics } = z.strictObject({includeDiagnostics:z.boolean().default(false)}).parse(args)
    const state = await service.desktopStatus(exec.signal)
    requireObservation(state.status, `执行器未连接。${connectHint}`)
    const windows = await service.windows(exec.signal)
    return textResult(includeDiagnostics ? {windows,windowDiscovery:(await service.desktopStatus(exec.signal)).windowDiscovery??null} : windows)
  })
  add('desktop_select_window','将发现列表中的 windowId 绑定为 PiP 目标。完全权限且从不询问使用当前会话授权，否则请求批准；绑定后获取新截图。',z.toJSONSchema(selectInput,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const { windowId } = selectInput.parse(args)
    return textResult(await selectChildWindowFromTool(service, windowId, childAuthorization(ctx,exec), exec.signal))
  })
  add('desktop_restore_window','恢复已授权目标窗口，不需要截图或 frameId。传入 desktop_get_task_status 的 connectionId、epoch、windowId 和 pid；独立核验当前权限与目标身份。确认稳定几何后返回 state=restored、verified=true；超过等待时限返回 state=restoring 和 retryAfterMs，不附带窗口几何。按 nextTool 调用 desktop_get_screenshot 取得新帧。',z.toJSONSchema(restoreInput,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const input=restoreInput.parse(args)
    const before=await service.desktopStatus(exec.signal)
    if(before.connectionId!==input.connectionId||before.epoch!==input.epoch||before.window?.id!==input.windowId||before.window.pid!==input.pid||before.status!=='enabled')throw new Error('恢复目标、连接或许可已变化')
    const recheck=before.backend==='windows-child-session'
      ? await childAuthorization(ctx,exec)(`恢复已授权窗口 ${JSON.stringify(before.window)}`)
      : await connectionApproval(ctx,exec)(`恢复已授权窗口；此本机操作可能激活目标前台窗口 ${JSON.stringify(before.window)}`)
    if(!sameApplicationScope(before,await service.desktopStatus(exec.signal)))throw new Error('批准期间恢复目标或连接已变化')
    exec.signal.throwIfAborted();recheck?.()
    return textResult(await service.restoreWindowApproved(input.windowId,input.pid,input.connectionId,input.epoch,exec.signal))
  })
  add('desktop_get_task_status','读取桌面执行器连接、任务进度、当前确认请求和验收状态。未连接时可调用 desktop_open_child_session。',empty,async(_args,exec)=>textResult({
    ...await service.desktopStatus(exec.signal), childInputPermission:resolveChildStartPermission(ctx,exec.agent), task: await service.taskStatus(exec.signal),
  }))
  add('desktop_start_task','EXPERIMENTAL，默认关闭（experimentalTasks=true 才可用）。在用户已授权的单个窗口中创建任务，用图像模型逐步规划，由用户批准每步输入和验收。',z.toJSONSchema(taskGoalSchema,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const request = taskGoalSchema.parse(args)
    const route = await requireVision(ctx, exec)
    const approval = ctx.get('approval')
    if (!approval || !exec.agent) throw new Error('需要 DSH 的逐次批准通道')
    const state = await service.desktopStatus(exec.signal)
    if (state.status !== 'enabled' || !state.window) throw new Error(`缺少已授权的目标窗口。${connectHint}`)
    const decision = await approval.request({
      agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
      reason: `启动桌面任务：${state.window.title}。窗口截图将发送给 ${route.model}，请核对目标与验收条件。`,
    })
    if (decision !== 'allowed-once') throw new Error('启动任务需要用户本次批准')
    const task = await service.startTask(JSON.stringify({ ...request, route, windowId: state.window.id, epoch: state.epoch }), exec.signal)
    return textResult(task)
  })
  add('desktop_get_screenshot',`获取真实窗口、主桌面或区域截图。输入坐标以最新截图像素为准。scale.width/height 是 JPEG 尺寸，rawWidth/rawHeight 是 SDK 原图（裁剪时为原图中的裁剪区域）尺寸，与窗口外框尺寸分别记录。accessibility 描述窗口的 UIA 读取情况。自绘或无名称控件应在本帧图像上确认；不可用时用 read_image 读取 filePath。附件失败时 imageMode=unavailable，同时返回 UIA 树、filePath、attachmentError 和 read_image 参数。目标最小化时按 reason/nextTool 调用 desktop_restore_window。${connectHint}画中画仅允许目标窗口截图，主桌面截图仅供观察。`,{
    type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:['image','uia','changed']},source:{type:'string',enum:['window','desktop']},crop:{type:'object',additionalProperties:false,properties:{...point,width:{type:'integer'},height:{type:'integer'}},required:['x','y','width','height']}},
  },async(args,exec)=>{
    const input=z.strictObject({mode:z.enum(['image','uia','changed']).default('image'),source:z.enum(['window','desktop']).default('window'),crop:z.unknown().optional()}).parse(args)
    const state = await service.desktopStatus(exec.signal)
    const unavailable = `当前没有可截图的已授权窗口。${connectHint}`
    requireObservation(state.status, unavailable)
    if (input.source === 'window' && !state.window) throw new Error(unavailable)
    if(input.mode!=='uia')await requireVision(ctx,exec,false)
    const frame=await service.capture(input.source,input.crop===undefined?'':JSON.stringify(input.crop),exec.signal)
    const hash=createHash('sha256').update(`${state.connectionId}|${frame.windowId}|${frame.epoch}|${JSON.stringify(input.crop)}`).update(frame.data).digest('hex')
    const caller=exec.agent?.session
    const unchanged=caller?hash===imageHashes.get(caller):false
    if(input.mode==='uia'||input.mode==='changed'&&unchanged){
      const {data,filePath,...metadata}=frame
      const value=input.mode==='uia'
        ? {...uiaMetadata(frame),imageMode:'uia-only',screenshotSha256:hash,
          note:'省流模式不含自绘控件候选；点击卡片等区域请改用 mode=image'}
        : {...metadata,imageMode:'unchanged',screenshotSha256:hash}
      return {...textResult(value),structuredContent:redactDiagnostics(value)}
    }
    return frameResult(frame,{screenshotSha256:hash})
  })
  for(const [name,command] of [['desktop_pause_task','pause'],['desktop_resume_task','resume'],['desktop_stop_task','stop']] as const){
    add(name,`${command==='pause'?'暂停并排空':command==='resume'?'继续（必须重新截图）':'终止并撤销'}当前桌面执行会话。任务暂停后由面板所有者继续。`,empty,async(_args,exec)=>{
      if (command === 'resume' && (await service.taskStatus(exec.signal))?.active) throw new Error('请由用户在桌面工具面板继续任务')
      return textResult(await service.control(command,exec.signal))
    })
  }
  const execute=async(operation:unknown,exec:ToolExecution)=>{
    const parsed=operationSchema.parse(operation)
    const uiaOnly=parsed.action.type==='click'&&parsed.action.target&&!parsed.action.target.id?.startsWith('visual-')&&!parsed.action.target.allowCoordinateFallback
    if(!uiaOnly)await requireVision(ctx,exec)
    const state=await service.desktopStatus(exec.signal)
    if (state.status !== 'enabled' || !state.window) throw new Error(`缺少已授权的目标窗口。${connectHint}`)
    const child = state.backend === 'windows-child-session' && state.isolated && state.childSessionId!==state.parentSessionId && Boolean(state.connectionId)
    if (child) parsed.delivery = childDelivery(parsed.action)
    const reason=`${child?'画中画子会话':'本机桌面'} · ${state.window.app} / ${state.window.title}；动作 ${parsed.action.type}；请核对本次参数。`
    const recheck=child ? await childAuthorization(ctx,exec)(reason) : await connectionApproval(ctx,exec)(reason)
    if(!sameApplicationScope(state,await service.desktopStatus(exec.signal)))throw new Error('批准期间目标或连接已改变')
    exec.signal.throwIfAborted();recheck?.()
    const result=await service.executeApproved(parsed,exec.signal)
    const { after, ...receipt } = result
    if(uiaOnly){
      const value={...receipt,after:after?uiaMetadata(after):null}
      return {...textResult(value),structuredContent:redactDiagnostics(value)}
    }
    return after ? frameResult(after, { ...receipt, frameId: after.id }) : textResult(result)
  }
  add('desktop_execute_action','根据最新 JPEG 截图像素执行一个授权窗口动作。候选 bbox 仅对该帧有效。不稳定 UIA 候选拒绝纯坐标点击，按 nextTool 取得新帧并使用 desktop_click_target。coordinates 是输入坐标系；effectivePoint 是实际交给执行器的坐标，effectivePointSpace 标明其坐标系；sourcePoint 保留源图投影，sourceScale 属于输入帧。标题栏命中见 hitTest，若使用定向系统命令则 delivery 明示 WM_SYSCOMMAND/SC_MINIMIZE。PiP 支持左键单击/双击、文本输入、垂直滚动和白名单按键；按键发往目标焦点控件。操作 ID 去重、帧单次消费，遵循当前权限并用新观察核验。',z.toJSONSchema(operationSchema,{target:'draft-7',io:'input'}),async(args,exec)=>execute(args,exec))
  const targetInput=z.strictObject({operationId:z.uuid(),frameId:z.uuid(),epoch:z.int().positive(),target:targetSelectorSchema,fallback:z.strictObject({x:z.number().nonnegative().finite(),y:z.number().nonnegative().finite()}).optional()})
  add('desktop_click_target','按当前帧的 UIA accessible name/controlType 或 suggestedTargets.id 查找唯一目标并点击。视觉区域需要图像模型和当前帧精确 id，父区域使用 visual-N，图标使用 visual-N.icon-M，不能按名称或类型猜测；回执 visualVerification 记录前后截图哈希与变化区域。仅在提供 fallback 且 allowCoordinateFallback=true 时允许 UIA 缺失后的坐标回退；歧义直接拒绝。',z.toJSONSchema(targetInput,{target:'draft-7',io:'input'}),async(args,exec)=>{
    const {operationId,frameId,epoch,target,fallback}=targetInput.parse(args)
    if(target.allowCoordinateFallback&&!fallback)throw new Error('坐标回退需要显式 fallback')
    return execute({operationId,frameId,epoch,delivery:'background',action:{type:'click',...fallback??{x:0,y:0},target}},exec)
  })
  const kinds=[
    {name:'desktop_click',type:'click',fields:{button:{type:'string',enum:['left','right','middle']},count:{type:'integer'}},required:[]},
    {name:'desktop_move_mouse',type:'move',fields:{},required:[]},
    {name:'desktop_type_text',type:'type',fields:{text:{type:'string'}},required:['text']},
    {name:'desktop_press_key',type:'key',fields:{key:{type:'string'},modifiers:{type:'array',items:{type:'string',enum:['ctrl','shift','alt']}}},required:['key']},
    {name:'desktop_scroll',type:'scroll',fields:{direction:{type:'string',enum:['up','down','left','right']},amount:{type:'integer'}},required:['direction']},
  ] as const
  for(const kind of kinds){
    add(kind.name,`对已授权窗口执行 ${kind.type}，坐标使用 desktop_get_screenshot 的最新截图像素。PiP 支持左键 count=1/2、文本、垂直滚动和后台白名单按键（enter/esc/tab/backspace/方向/space/home/end/pageup/pagedown/f5、ctrl+单字母），其他动作拒绝。完全权限且从不询问使用会话授权，其他模式请求批准。`,{
      type:'object',additionalProperties:false,properties:{...frameFields,...point,...kind.fields},required:['operationId','frameId','epoch','x','y',...kind.required],
    },async(args,exec)=>{
      const {operationId,frameId,epoch,delivery,...fields}=args
      const action=actionSchema.parse({type:kind.type,...fields})
      return await execute({operationId,frameId,epoch,delivery:delivery??'background',action},exec)
    })
  }
}
