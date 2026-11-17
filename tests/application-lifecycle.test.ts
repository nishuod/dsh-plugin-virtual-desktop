import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { ApplicationLifecycle } from '../src/application-lifecycle.ts'
import type { DesktopRuntimeState, DesktopWindow, DesktopFrame } from '../src/native-contract.ts'
const signal=()=>AbortSignal.timeout(10000)
async function fixture(options:{error?:boolean;generic?:boolean;genericReady?:boolean;empty?:boolean;visualContent?:boolean|null}={}) {
  const connectionId=randomUUID()
  let state:DesktopRuntimeState={backend:'windows-attended',isolated:false,status:'disabled',epoch:0,window:null,foregroundAllowed:false,inputMode:'ask-each-action',lastResult:'fixture',capabilities:{windowCapture:true,desktopCapture:false,regionCapture:true,clipboard:false,autonomousTask:false}}
  const target:DesktopWindow={id:randomUUID(),pid:32,app:'vmware.exe',imagePath:'C:\\VMware\\vmware.exe',windowClass:'VMUIFrame',responsive:true,title:options.error?'VMware Workstation Error':'VMware Workstation',x:0,y:0,width:40,height:40}
  const bytes=await sharp({create:{width:40,height:40,channels:3,background:'white'}}).composite([{input:Buffer.from('<svg width="40" height="40"><rect width="20" height="40" fill="black"/></svg>')}]).jpeg().toBuffer()
  let windows:DesktopWindow[]=[]
  const counts={enable:0,launch:0,select:0,capture:0,pause:0}
  const native={
    status:async()=>structuredClone(state),
    enable:async()=>{counts.enable++;state={...state,connectionId,backend:'windows-child-session',isolated:true,parentSessionId:1,childSessionId:7,status:'observing',epoch:1};return structuredClone(state)},
    windows:async()=>structuredClone(windows),
    launch:async(path:string,operationId:string)=>{counts.launch++;if(!options.empty)windows=[target];return {path,operationId,pid:32,outcome:'started' as const,message:'created'}},
    select:async(id:string)=>{counts.select++;state={...state,status:'enabled',epoch:state.epoch+1,window:target};assert.equal(id,target.id);return structuredClone(state)},
    capture:async(_source: string, _crop: unknown, _signal: AbortSignal, _check: unknown, verifyVisual?: boolean):Promise<DesktopFrame>=>{
      counts.capture++
      assert.equal(verifyVisual, true)
      return {
        id:randomUUID(),windowId:target.id,epoch:state.epoch,capturedAt:Date.now(),width:40,height:40,mimeType:'image/jpeg',
        data:bytes.toString('base64'),source:'window',tree:options.genericReady?'Button "Save"; Edit "Text"':'menu File; menu VM; menu Help',
        ...(options.genericReady?{accessibility:{status:'available' as const,scope:'window' as const,treeTruncated:false,guidance:'fixture'}}:{}),
        ...(options.visualContent === null ? {} : { visualContent: options.visualContent ?? true }),
      }
    },
    control:async()=>{counts.pause++;state={...state,status:'paused',epoch:state.epoch+1};return structuredClone(state)},
  }
  const lifecycle=new ApplicationLifecycle(native,async()=>({path:target.imagePath!,adapter:options.generic||options.genericReady?'generic':'vmware'}),options.generic||options.empty?10:1500)
  const input={appId:'vmware-workstation' as const,operationId:randomUUID()}
  return {native,lifecycle,input,counts,target,change:(patch:Partial<DesktopRuntimeState>)=>{state={...state,...patch}}}
}
test('one request connects an empty child, launches once, verifies, binds, and returns a fresh frame',async()=>{
  const f=await fixture();let grants=0,checks=0
  const result=await f.lifecycle.open(f.input,async()=>{grants++;return ()=>{checks++}},signal())
  assert.equal(result.status,'ready');assert.equal(result.childSessionId,7);assert.ok(result.frame);assert.equal(grants,1);assert.ok(checks>3)
  assert.deepEqual(f.counts,{enable:1,launch:1,select:1,capture:1,pause:0})
  const repeated=await f.lifecycle.open(f.input,async()=>{throw Error('should not reauthorize replay')},signal())
  assert.equal(repeated.status,'ready');assert.equal(repeated.frame,undefined);assert.equal(f.counts.launch,1)
  const reuse=await f.lifecycle.open({...f.input,operationId:randomUUID()},async()=>{},signal())
  assert.equal(reuse.status,'ready');assert.equal(reuse.reused,true);assert.equal(f.counts.launch,1)
})
test('generic application requires stable identity, UIA controls and positive pixels to become ready',async()=>{
  const f=await fixture({genericReady:true})
  const result=await f.lifecycle.open(f.input,async()=>{},signal())
  assert.equal(result.status,'ready');assert.equal(f.counts.select,1);assert.equal(f.counts.capture,1)
  const blank=await fixture({genericReady:true,visualContent:false})
  assert.equal((await blank.lifecycle.open(blank.input,async()=>{},signal())).status,'needs_review')
  assert.equal(blank.counts.pause,1)
})

test('needs-review identifies the bound window process after a same-executable launcher handoff',async()=>{
  const f=await fixture({genericReady:true,visualContent:false})
  f.target.pid=99 // launch receipt remains PID 32; the verified window belongs to PID 99.
  const result=await f.lifecycle.open(f.input,async()=>{},signal())
  assert.equal(result.status,'needs_review');assert.equal(result.pid,99)
  assert.equal(result.window?.pid,99);assert.equal(f.counts.pause,1)
})
test('an application error is never bound, even with a different retry ID',async()=>{
  const f=await fixture({error:true})
  assert.equal((await f.lifecycle.open(f.input,async()=>{},signal())).status,'app_error')
  assert.equal((await f.lifecycle.open({...f.input,operationId:randomUUID()},async()=>{},signal())).status,'app_error')
  assert.equal(f.counts.select,0);assert.equal(f.counts.launch,1)
})
test('a matching application menu alone is insufficient without positive worker visual evidence',async()=>{
  for (const visualContent of [false, null]) {
    const f = await fixture({ visualContent })
    const result = await f.lifecycle.open(f.input, async () => {}, signal())
    assert.equal(result.status, 'needs_review')
    assert.equal(f.counts.pause, 1)
  }
})
test('unknown generic UI and no-window timeout never claim readiness or repeat launch',async()=>{
  for(const options of [{generic:true},{empty:true}]){
    const f=await fixture(options)
    const result=await f.lifecycle.open(f.input,async()=>{},signal())
    assert.equal(result.status,options.generic?'needs_review':'timed_out');assert.equal(f.counts.select,0)
    await f.lifecycle.open({...f.input,operationId:randomUUID()},async()=>{},signal());assert.equal(f.counts.launch,1)
  }
})
test('denied, cancelled, or changed grants create no child process',async()=>{
  for(const mode of ['denied','cancelled','revoked','changed']){
    const f=await fixture(),abort=new AbortController()
    await assert.rejects(f.lifecycle.open(f.input,async()=>{
      if(mode==='denied')throw Error('denied')
      if(mode==='cancelled')abort.abort()
      if(mode==='changed')f.change({epoch:2})
      return ()=>{if(mode==='revoked')throw Error('revoked')}
    },abort.signal))
    assert.equal(f.counts.enable,0);assert.equal(f.counts.launch,0)
  }
})
test('revoking after launch stops binding and blocks replay after reconnect',async()=>{
  const f=await fixture()
  const result=await f.lifecycle.open(f.input,async()=>()=>{if(f.counts.launch)throw Error('revoked')},signal())
  assert.equal(result.status,'unknown');assert.equal(f.counts.select,0)
  f.change({connectionId:randomUUID()})
  assert.equal((await f.lifecycle.open(f.input,async()=>{},signal())).status,'unknown');assert.equal(f.counts.launch,1)
})
test('changed parameters cannot reuse a receipt and concurrent admission is refused',async()=>{
  const f=await fixture()
  const pending=f.lifecycle.open(f.input,async()=>{},signal())
  await assert.rejects(f.lifecycle.open({...f.input,operationId:randomUUID()},async()=>{},signal()),/正在进行/)
  await pending
  await assert.rejects(f.lifecycle.open({path:'C:\\other.exe',operationId:f.input.operationId},async()=>{},signal()),/不能改换/)
})
