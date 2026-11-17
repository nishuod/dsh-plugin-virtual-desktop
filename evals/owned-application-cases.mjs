import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'
import { VirtualDesktopController } from '../src/controller.ts'
import { DesktopTasks } from '../src/desktop-tasks.ts'
import { DshTaskPlanner } from '../src/task-model.ts'
import { DiagnosticWorker } from '../src/worker-client.ts'
import { registerNativeTools } from '../src/native-tools.ts'

export const signal = () => AbortSignal.timeout(90000)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const observation = frame => ({uia:frame.tree,screenshotSha256:sha(Buffer.from(frame.data,'base64'))})
function frameFree(receipt) {
  const {after, data, ...other} = receipt
  return other
}

/** Use real chat tool definitions with local-only, opt-in test approval and attachments. */
export async function withTools(native, progress, use, failAttachments = false) {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(NativeToolExecutor)
    const agent = {session:{requestHeader:()=>undefined},options:{provider:'fixture',model:'vision'}}
    let attachment
    ctx.provide('approval',{request:async()=> 'allowed-once'})
    ctx.provide('llm',{resolveModelInfo:async()=>({inputModalities:['image']})})
    ctx.provide('attachments',{saveImage:async({data,mediaType})=>{
      attachment = Buffer.from(data)
      if (failAttachments) throw Object.assign(new Error('Evaluation fixture storage rejected the attachment'),{code:'EVAL_ATTACHMENT_UNAVAILABLE'})
      const {width,height}=await sharp(attachment).metadata()
      return {attachmentId:AttachmentId('owned-live-eval'),mediaType,width,height,bytes:attachment.length}
    }})
    const controller = new VirtualDesktopController(ctx,new DiagnosticWorker(5000),native,new DesktopTasks(native,new DshTaskPlanner(ctx)))
    registerNativeTools(ctx,controller)
    const run = async(name,args={},expectedError=false)=>{
      progress.stage=name
      const {results}=await ctx.tools.execute({
        calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name,arguments:JSON.stringify(args)}],agent,signal:signal(),
      })
      const result=results[0].result
      const block=result.content.find(block=>block.type==='text')
      let value=result.structuredContent
      if (!value && block?.text) {
        try { value=JSON.parse(block.text) } catch { value={message:block.text} }
      }
      progress.receipt=value
      assert.equal(Boolean(result.isError),expectedError,JSON.stringify(value).slice(0,1000))
      assert.ok(value,'Desktop tool returned no receipt')
      return value
    }
    return await use(run,()=>attachment,controller)
  } finally { await ctx.fiber.dispose() }
}

export async function verifyAttachmentFallback(native, progress, before) {
  return await withTools(native,progress,async(run,rejectedBytes)=>{
    const receipt=await run('desktop_get_screenshot')
    assert.equal(receipt.imageMode,'unavailable')
    assert.equal(receipt.attachmentError.code,'EVAL_ATTACHMENT_UNAVAILABLE')
    assert.equal(receipt.nextTool,'read_image')
    assert.equal(receipt.nextToolArgs.file_path,receipt.filePath)
    assert.ok(isAbsolute(receipt.filePath))
    progress.stage='decode the operational attachment fallback'
    const jpeg=await readFile(receipt.filePath)
    const {format,width,height}=await sharp(jpeg).metadata()
    assert.equal(format,'jpeg')
    assert.deepEqual(jpeg,rejectedBytes(),'The fallback file differs from the rejected attachment bytes')
    const decoded=await sharp(jpeg).raw().toBuffer({resolveWithObject:true})
    assert.ok(decoded.data.length>0)
    assert.deepEqual([decoded.info.width,decoded.info.height],[width,height])
    assert.deepEqual([width,height],[receipt.width,receipt.height])
    return {receipt:{...receipt,outcome:'fallback-readable'},before,after:{uia:receipt.tree,screenshotSha256:sha(jpeg)},
      independent:{format,width,height,sameAttachmentBytes:true},assertionPassed:true,route:'registered-cordis-fixture'}
  },true)
}

export async function verifyVmwareCase(id,native,progress,referenceFile) {
  return await withTools(native,progress,async run=>{
    const opened=await run('desktop_open_application',{appId:'vmware-workstation',operationId:randomUUID()})
    assert.equal(opened.status,'ready',opened.message)
    const state=await native.status(signal())
    const target={pid:opened.pid,childSessionId:state.childSessionId,connectionId:state.connectionId}
    progress.target=target
    assert.equal(state.backend,'windows-child-session')
    assert.equal(state.isolated,true)
    assert.notEqual(state.parentSessionId,state.childSessionId)
    assert.equal(state.window.pid,opened.pid)
    progress.stage='capture the audited VMware window'
    const frame=await native.capture('window',undefined,signal(),undefined,true)
    const before=observation(frame)
    progress.before=before
    assert.equal(frame.windowId,state.window.id)
    assert.equal(frame.privacy?.status,'clear')
    const click = selector => run('desktop_click_target',{
      operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,target:selector,
    })
    let receipt, after, independent
    if (id==='app-11-vmware-list') {
      const listed=await run('desktop_vm_command',{appId:'vmware-workstation',operationId:randomUUID(),command:'list'})
      assert.equal(listed.status,'confirmed',JSON.stringify(listed).slice(0,1000))
      assert.equal(listed.state,'listed')
      assert.equal(listed.childSessionId,target.childSessionId)
      assert.equal(listed.runningCount,listed.evidence.vmrunList.length)
      for (const vmxPath of listed.evidence.vmrunList)
        assert.equal(listed.evidence.processCheck.filter(process=>process.vmxPath.toLowerCase()===vmxPath.toLowerCase()).length,1)
      receipt={...listed,outcome:listed.status}
      independent={runningCount:listed.runningCount,checkedProcesses:listed.evidence.processCheck.length,vmPowerCommands:0}
      after=observation(await native.capture('window',undefined,signal()))
    } else if (id==='app-12-vmware-restore') {
      const minimize=frame.accessibility?.suggestedTargets?.filter(target=>target.basis==='uia-bounds' && /^最小化$|^Minimize$/i.test(target.name))??[]
      assert.equal(minimize.length,1,'No unique named Minimize control in the current frame')
      const minimized=await click({id:minimize[0].id})
      assert.equal(minimized.outcome,'delivered')
      assert.equal(minimized.hitTest?.class,'HTMINBUTTON')
      assert.deepEqual(minimized.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
      const denied=await run('desktop_get_screenshot',{},true)
      assert.equal(denied.reason,'minimized')
      const restored=await run('desktop_restore_window',{
        connectionId:target.connectionId,windowId:state.window.id,pid:target.pid,epoch:state.epoch,
      })
      assert.equal(restored.state,'restored')
      assert.equal(restored.verified,true)
      assert.equal(restored.connectionId,target.connectionId)
      assert.equal(restored.childSessionId,target.childSessionId)
      assert.equal(restored.window.id,state.window.id)
      assert.equal(restored.window.pid,target.pid)
      assert.ok(restored.window.x > -30000 && restored.window.y > -30000)
      const restoredFrame=await native.capture('window',undefined,signal())
      assert.notEqual(restoredFrame.id,frame.id)
      assert.equal(restoredFrame.windowId,frame.windowId)
      receipt={...restored,outcome:restored.state}
      independent={minimized,denied,restoredFrameId:restoredFrame.id}
      after=observation(restoredFrame)
    } else {
      progress.stage='verify the audited Open a Virtual Machine card before input'
      const candidates=frame.accessibility.suggestedTargets.filter(target=>target.basis==='visual'&&!target.parent)
      assert.deepEqual([frame.width,frame.height],[1280,808])
      const rectangle=[639,219,827,390]
      const matches=candidates.filter(({bbox:{x,y,width,height}})=>[x,y,x+width,y+height].every((value,i)=>Math.abs(value-rectangle[i])<8))
      assert.equal(matches.length,1,'No unique visual region at the audited card bounds')
      const card=matches[0]
      assert.equal(card.shadowedBy,undefined)
      const current=await sharp(Buffer.from(frame.data,'base64')).extract({left:655,top:230,width:152,height:145}).removeAlpha().toColourspace('srgb').raw().toBuffer()
      const reference=await readFile(referenceFile)
      assert.equal(current.length,reference.length)
      const ratio=current.reduce((changed,value,index)=>changed+(Math.abs(value-reference[index])>12?1:0),0)/current.length
      assert.ok(ratio<.015,'Current card pixels do not match the audited VM opening card')
      const dialogs=async()=>(await native.windows(signal())).filter(window=>
        window.pid===target.pid&&window.id!==state.window.id&&(/^(open|打开)(?:\s|$)/i.test(window.title)||window.windowClass==='#32770'))
      assert.deepEqual(await dialogs(),[],'A dialog already exists in this VMware process')
      const clicked=await click({id:card.id})
      assert.equal(clicked.outcome,'delivered',clicked.message)
      assert.equal(clicked.visualVerification?.targetId,card.id)
      assert.equal(clicked.visualVerification.beforeScreenshotSha256,before.screenshotSha256)
      assert.ok(clicked.visualVerification.changedRegion)
      progress.stage='observe the resulting same-PID file dialog'
      const openedDialogs=await dialogs()
      assert.equal(openedDialogs.length,1)
      assert.match(openedDialogs[0].title,/^(open|打开)(?:\s|$)/i)
      assert.equal(clicked.mimeType,'image/jpeg')
      assert.ok(clicked.filePath)
      const jpeg=await readFile(clicked.filePath)
      assert.equal(sha(jpeg),clicked.visualVerification.afterScreenshotSha256)
      receipt=frameFree(clicked)
      // Read the independently discovered same-PID dialog in addition to the
      // owning window UIA tree. The .vmx picker is never used to select a file.
      after={uia:clicked.tree+'\n'+JSON.stringify(openedDialogs.map(({id,title,windowClass})=>({id,title,windowClass}))),screenshotSha256:sha(jpeg)}
      independent={target:card,cardPixelDifferenceRatio:ratio,dialogs:openedDialogs,candidateCount:candidates.length}
    }
    return {live:true,target,before,after,receipt,independent,assertionPassed:true,route:'registered-cordis-fixture'}
  })
}
