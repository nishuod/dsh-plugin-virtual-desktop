// Opt-in verification through the built chat tools, in one owned child session.
// npm run build; node tests/uia-bbox-stability.live.mjs --allow-owned-vmware
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import koffi from 'koffi'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { decodeChildAssociation } from '../scripts/eval-contract.mjs'

assert.ok(process.argv.includes('--allow-owned-vmware'), 'Explicit consent to open a VMware test window is required')
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')

const wts=koffi.load('wtsapi32.dll'), kernel=koffi.load('kernel32.dll')
const query=wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
const readError=kernel.func('uint32_t __stdcall GetLastError()')
const clearError=kernel.func('void __stdcall SetLastError(uint32_t error)')
function associated() {
  const id=[0xffffffff]
  clearError(0)
  const ok=query(id)
  return decodeChildAssociation(ok,id[0],readError())
}
assert.equal(associated(),null,'An existing child association must not be changed by the probe')
const artifacts=resolve('artifacts')
await mkdir(artifacts,{recursive:true})
const working=await mkdtemp(join(artifacts,'r3-live-'))
const lib=join(working,'lib')
await cp('lib',lib,{recursive:true,errorOnExist:true})
const plugin=await import(pathToFileURL(join(lib,'index.js')).href)
const report={startedAt:new Date().toISOString(),passed:false,frames:[],snapshot:{
  index:createHash('sha256').update(await readFile(join(lib,'index.js'))).digest('hex'),
  worker:createHash('sha256').update(await readFile(join(lib,'native-worker.js'))).digest('hex'),
}}
const ctx=new Context()
const signal=()=>AbortSignal.timeout(90_000)
const agent={session:{requestHeader:()=>undefined},options:{provider:'fixture',model:'vision'}}
let controller, stage='mount built chat tools'
async function run(name,args={}) {
  const {results}=await ctx.tools.execute({
    calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name,arguments:JSON.stringify(args)}],agent,signal:signal(),
  })
  const result=results[0].result
  const block=result.content.find(entry=>entry.type==='text')
  assert.equal(result.isError,false,block?.text)
  return result.structuredContent??JSON.parse(block.text)
}
function minimizeCandidate(frame) {
  const matches=frame.accessibility?.suggestedTargets?.filter(target=>target.basis==='uia-bounds'&&target.controlType==='Button'&&
    /^(最小化|Minimi[sz]e)$/iu.test(target.name))??[]
  assert.equal(matches.length,1,'Expected a single named minimize candidate')
  assert.equal(typeof matches[0].stable,'boolean','Expected two verified geometry samples')
  return matches[0]
}
async function capture(mode,windowId) {
  const started=performance.now()
  const frame=await run('desktop_get_screenshot',{mode})
  assert.equal(frame.windowId,windowId)
  assert.equal(frame.privacy?.status,'clear')
  return {frame,elapsedMs:performance.now()-started,target:minimizeCandidate(frame)}
}
function point(bbox) { return {x:bbox.x+bbox.width/2,y:bbox.y+bbox.height/2} }
function clickArguments(frame,action) {
  return {operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,action:{type:'click',...action}}
}
try {
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolRuntime,{})
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ComputerUseRegistry)
  // Each fixed fixture operation receives one test approval. No model request is sent.
  ctx.provide('approval',{request:async()=> 'allowed-once'})
  ctx.provide('llm',{resolveModelInfo:async()=>({inputModalities:['image']})})
  ctx.provide('attachments',{saveImage:async()=>{throw Error('Fixture retains the local read_image fallback')}})
  await ctx.plugin(plugin,{})
  controller=ctx.virtualDesktop
  assert.equal(associated(),null,'Association changed while the test plugin loaded')
  stage='open fixed owned VMware application'
  const application=await run('desktop_open_application',{appId:'vmware-workstation'})
  assert.equal(application.status,'ready',application.message)
  const status=await run('desktop_get_task_status')
  const windowId=application.window.id
  assert.equal(status.window?.id,windowId)
  assert.equal(status.window?.pid,application.window.pid)
  assert.equal(status.isolated,true)
  assert.equal(status.childSessionId,associated())
  assert.notEqual(status.childSessionId,status.parentSessionId)
  report.scope={windowId,pid:application.window.pid,childSessionId:status.childSessionId}
  let latest
  for(let i=0;i<10;i++){
    const mode=i%2===0?'uia':'image'
    stage=`capture ${mode} frame ${i+1}`
    latest=await capture(mode,windowId)
    const {frame,target,elapsedMs}=latest
    assert.ok(report.frames.every(entry=>entry.frameId!==frame.id))
    const entry={mode,frameId:frame.id,epoch:frame.epoch,elapsedMs,target}
    report.frames.push(entry)
    if(!target.stable){
      stage=`refuse reported unstable coordinates on frame ${i+1}`
      assert.deepEqual(target.bboxEvidence?.first,target.bbox)
      const receipt=await run('desktop_execute_action',clickArguments(frame,point(target.bbox)))
      assert.equal(receipt.outcome,'refused')
      assert.equal(receipt.nextTool,'desktop_click_target')
      assert.equal(receipt.delivery,undefined)
      assert.deepEqual(receipt.evidence.at(-1).bboxEvidence,target.bboxEvidence)
      entry.refusal={outcome:receipt.outcome,nextTool:receipt.nextTool,evidence:receipt.evidence}
    }
  }
  stage='verify one real minimize remains available'
  const sawInstability=report.frames.some(entry=>entry.refusal)
  const candidate=sawInstability?await capture('image',windowId):latest
  const input=sawInstability
    ? {tool:'desktop_click_target',args:{operationId:randomUUID(),frameId:candidate.frame.id,epoch:candidate.frame.epoch,
      target:{name:candidate.target.name,controlType:candidate.target.controlType}}}
    : {tool:'desktop_execute_action',args:clickArguments(candidate.frame,point(candidate.target.bbox))}
  const receipt=await run(input.tool,input.args)
  assert.equal(receipt.outcome,'delivered',receipt.message)
  assert.equal(receipt.hitTest?.class,'HTMINBUTTON')
  assert.deepEqual(receipt.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
  assert.equal(receipt.postAction?.reason,'minimized')
  report.finalClick={tool:input.tool,outcome:receipt.outcome,hitTest:receipt.hitTest,delivery:receipt.delivery}
  report.passed=true
} catch(error) {
  report.error={stage,message:error instanceof Error?error.message:String(error)}
  process.exitCode=1
} finally {
  try {
    if(controller)await controller.resetChildSession(randomUUID(),signal())
    report.finalAssociation=associated()
    assert.equal(report.finalAssociation,null)
  } catch(error) {
    report.cleanupError=error instanceof Error?error.message:String(error)
    report.passed=false
    process.exitCode=1
  }
  await ctx.fiber.dispose()
  report.completedAt=new Date().toISOString()
  await writeFile('evidence/r3-bbox-live.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({passed:report.passed,frames:report.frames.length,
    unstable:report.frames.filter(entry=>entry.refusal).length,finalAssociation:report.finalAssociation,error:report.error}))
}
