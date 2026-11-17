import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {NativeRuntime,type DriverPort,type IdentityPort} from '../src/native-runtime.ts'
import {BackgroundInputRefused,type WindowsBackgroundInput} from '../src/background-input.ts'

async function fixture(failure?:Error,replace?:boolean){
  const bytes=await sharp({create:{width:1920,height:900,channels:3,background:'#c0c0c0'}}).png().toBuffer()
  let sdk=0
  const calls:unknown[][]=[]
  const driver:DriverPort={
    listWindows:async()=>({windows:[{windowId:1n,pid:42,title:'Fixture',appName:'Fixture',bounds:{x:10,y:20,width:1920,height:900},isOnScreen:true}]}),
    getWindowState:async()=>({pid:42,windowId:1n,screenshotFrameValid:true,images:[{mimeType:'image/png',dataBase64:bytes.toString('base64')}],treeMarkdown:'fixture',windowBounds:{x:10,y:20,width:1920,height:900}}),
    getDesktopState:async()=>{throw new Error('no desktop')},callTool:async()=>{sdk++;throw new Error('no SDK fallback')},shutdown:async()=>{},
  }
  const identity:IdentityPort={assertInteractive(){},process:()=>({birth:'p1',image:'fixture.exe'}),window:()=>({x:10,y:20,width:1920,height:900,foreground:'1'}),windowShellInfo:()=>({shellDesktop:false,className:'Fixture'}),rawTopLevelCount:()=>null,acquireLease:()=>()=>{},movePointer(){throw new Error('no pointer movement')}}
  const input:Pick<WindowsBackgroundInput,'key'|'doubleClick'> & Partial<Pick<WindowsBackgroundInput,'replaceText'>>={
    key(...args){calls.push(['key',...args]);if(failure)throw failure},
    doubleClick(...args){calls.push(['double',...args]);if(failure)throw failure},
  }
  if(replace!==undefined)input.replaceText=(...args)=>{calls.push(['replace',...args]);if(failure)throw failure;return replace}
  const runtime=new NativeRuntime({frameAgeMs:60000,maxDimension:1280,imageBytes:100000},identity,()=>driver,undefined,true,input,async()=>({complete:true,passwordRegions:[]}))
  await runtime.enable();const[target]=await runtime.listWindows();await runtime.select(target.id,false)
  return{runtime,calls,sdk:()=>sdk}
}
function op(frame:{id:string;epoch:number},action:unknown){return{operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action}}

test('PiP keys and double click use one frame and never SDK input; double-click coordinates inverse scale once',async t=>{
  const f=await fixture();t.after(()=>f.runtime.pause(true))
  const frame=await f.runtime.capture()
  const request=op(frame,{type:'click',x:1000,y:100,button:'left',count:2})
  assert.equal((await f.runtime.execute(request)).outcome,'delivered')
  assert.deepEqual(f.calls,[['double','1',42,1510,170]])
  await f.runtime.execute(request)
  assert.equal(f.calls.length,1)
  await assert.rejects(f.runtime.execute({...request,operationId:randomUUID()}),/截图已过期/)
  const keyFrame=await f.runtime.capture()
  assert.equal((await f.runtime.execute(op(keyFrame,{type:'key',x:0,y:0,key:'enter'}))).outcome,'delivered')
  assert.deepEqual(f.calls[1],['key','1',42,'enter',[]])
  assert.equal(f.sdk(),0)
  const current=await f.runtime.capture()
  await f.runtime.pause(true)
  await assert.rejects(f.runtime.execute(op(current,{type:'key',x:0,y:0,key:'esc'})),/输入许可/)
  assert.equal(f.calls.length,2)
})

test('PiP background refusal and unknown receipt consume the frame and never replay or fallback',async t=>{
  for(const[failure,outcome]of[[new BackgroundInputRefused('refused'),'refused'],[new Error('timeout'),'unknown']]as const){
    const f=await fixture(failure);t.after(()=>f.runtime.pause(true));const frame=await f.runtime.capture()
    const request=op(frame,{type:'key',x:0,y:0,key:'enter'})
    assert.equal((await f.runtime.execute(request)).outcome,outcome)
    assert.equal((await f.runtime.execute(request)).outcome,outcome)
    assert.equal(f.calls.length,1);assert.equal(f.sdk(),0)
  }
})

test('PiP out-of-frame double click still refuses before background dispatch',async t=>{
  const f=await fixture();t.after(()=>f.runtime.pause(true));const frame=await f.runtime.capture()
  const result=await f.runtime.execute(op(frame,{type:'click',x:frame.width,y:0,button:'left',count:2}))
  assert.equal(result.outcome,'refused');assert.deepEqual(f.calls,[]);assert.equal(f.sdk(),0)
})

test('PiP focused text replacement consumes one frame and falls through only when no message was sent',async t=>{
  const f=await fixture(undefined,true);t.after(()=>f.runtime.pause(true))
  const frame=await f.runtime.capture(),request=op(frame,{type:'type',x:400,y:100,text:'Replacement'})
  assert.equal((await f.runtime.execute(request)).outcome,'delivered')
  assert.deepEqual(f.calls,[['replace','1',42,{x:610,y:170},'Replacement']])
  assert.equal(f.sdk(),0)
  assert.equal((await f.runtime.execute(request)).outcome,'delivered')
  await assert.rejects(f.runtime.execute({...request,operationId:randomUUID()}),/截图已过期/)
  assert.equal(f.calls.length,1)
  const unsupported=await fixture(undefined,false);t.after(()=>unsupported.runtime.pause(true))
  const other=await unsupported.runtime.capture()
  assert.equal((await unsupported.runtime.execute(op(other,{type:'type',x:400,y:100,text:'SDK target'}))).outcome,'unknown')
  assert.equal(unsupported.calls.length,1);assert.equal(unsupported.sdk(),1)
})

test('PiP focused replacement refusal or timeout never falls back to SDK or repeats the mutation',async t=>{
  for(const [error,outcome] of [[new BackgroundInputRefused('identity changed'),'refused'],[new Error('timeout'),'unknown']] as const){
    const f=await fixture(error,true);t.after(()=>f.runtime.pause(true))
    const frame=await f.runtime.capture(),request=op(frame,{type:'type',x:400,y:100,text:'Replacement'})
    assert.equal((await f.runtime.execute(request)).outcome,outcome)
    assert.equal((await f.runtime.execute(request)).outcome,outcome)
    assert.equal(f.calls.length,1);assert.equal(f.sdk(),0)
  }
})
