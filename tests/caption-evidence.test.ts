import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {WindowsBackgroundInput,type BackgroundInputPort} from '../src/background-input.ts'
import {NativeRuntime,type DriverPort,type IdentityPort} from '../src/native-runtime.ts'
import {receiptSchema} from '../src/native-contract.ts'

// Optional old compiled runtime permits a reproducible before-fix failure log.
const Runtime=process.env.DSH_B3_BASELINE_RUNTIME
  ?(await import(process.env.DSH_B3_BASELINE_RUNTIME)).NativeRuntime:NativeRuntime
const root=1n,pid=42,origin={x:128,y:128}
async function fixture(hit:number=8,unknown=false,calibrateCaption=false){
  const image=await sharp({create:{width:1357,height:857,channels:3,background:'#bbbbbb'}}).png().toBuffer()
  let sdkCalls=0
  const messages:unknown[][]=[],hitPoints:{x:number;y:number}[]=[]
  const bounds={...origin,width:1359,height:859}
  const driver:DriverPort={listWindows:async()=>({windows:[{windowId:root,pid,title:'Fixture',appName:'Fixture',bounds,isOnScreen:true}]}),
    getWindowState:async()=>({pid,windowId:root,screenshotFrameValid:true,windowBounds:bounds,images:[{mimeType:'image/png',dataBase64:image.toString('base64')}]}),
    getDesktopState:async()=>{throw Error('No desktop')},callTool:async()=>{sdkCalls++;throw Error('Unexpected SDK delivery')},shutdown:async()=>{}}
  const identity:IdentityPort={assertInteractive(){},process:()=>({birth:'p1',image:'fixture.exe'}),window:()=>({...bounds,foreground:'1'}),
    windowShellInfo:()=>({shellDesktop:false,className:'Fixture'}),rawTopLevelCount:()=>null,acquireLease:()=>()=>{},movePointer(){throw Error('No foreground')}}
  let liveHit=hit
  const input=new WindowsBackgroundInput({withPerMonitorV2:work=>work(),sessionOf:()=>2,
    window:hwnd=>hwnd===root?{pid,thread:1,root,bounds:[128,128,1487,987]}:undefined,
    hitTest(hwnd,point,timeout){assert.equal(hwnd,root);hitPoints.push({...point});
      // Fixed physical caption hit rectangle, independent from the caller's frame map.
      if(!calibrateCaption)return point.x>=1393&&point.x<1423&&point.y>=136&&point.y<166?hit:1
      return point.x>=1389&&point.x<1421&&point.y>=136&&point.y<166
        ?(timeout===25?hit:liveHit):point.x>=1421?9:1},
    send(...args){messages.push(args);return unknown?'unknown':'delivered'},
  } as BackgroundInputPort)
  const runtime=new Runtime({frameAgeMs:60000,maxDimension:1280,imageBytes:100000},identity,()=>driver,undefined,true,input,async()=>({
    complete:true,passwordRegions:[],
    ...(calibrateCaption?{targets:[{name:'最小化',controlType:'Button',enabled:true,captionButton:'minimize' as const,bounds:{x:1430,y:136,width:30,height:30}}]}:{}),
  }))
  await runtime.enable();const[target]=await runtime.listWindows();await runtime.select(target.id,false)
  return{runtime,messages,hitPoints,sdkCalls:()=>sdkCalls,setHit:(code:number)=>{liveHit=code}}
}
const points=[{x:1206.5,y:20.5},{x:1193,y:7},{x:1219.9,y:33.9}]
test('caption bbox center and both corners report the same real hit class and exact system-command coordinates',async t=>{
  const f=await fixture();t.after(()=>f.runtime.pause(true))
  for(const point of points){
    const frame=await f.runtime.capture(),operation={operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,action:{type:'click',...point}}
    const result=receiptSchema.parse(await f.runtime.execute(operation))
    assert.equal(result.outcome,'delivered')
    assert.equal(result.hitTest?.class,'HTMINBUTTON');assert.equal(result.hitTest.code,8)
    assert.deepEqual(result.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
    const actual=f.hitPoints.at(-1)!
    assert.deepEqual(result.effectivePoint,actual);assert.equal(result.effectivePointSpace,'physical-screen-pixels')
    assert.deepEqual(result.hitTest.screenPoint,actual);assert.deepEqual(result.hitTest.windowOrigin,origin)
    assert.deepEqual(result.hitTest.point,{x:actual.x-origin.x,y:actual.y-origin.y});assert.equal(result.hitTest.windowRelative,true)
    assert.deepEqual(result.sourcePoint,{x:point.x*1357/1280,y:point.y*857/frame.height})
    assert.notDeepEqual(result.sourcePoint,result.effectivePoint)
    const sent=f.messages.at(-1)!
    assert.deepEqual(sent.slice(0,4),[root,0x112,0xf020n,BigInt(actual.x)|(BigInt(actual.y)<<16n)])
    const count=f.messages.length
    const repeated=await f.runtime.execute(operation);assert.deepEqual(repeated.hitTest,result.hitTest)
    assert.deepEqual(repeated.delivery,result.delivery);assert.equal(f.messages.length,count)
    await assert.rejects(f.runtime.execute({...operation,operationId:randomUUID()}),/已用于输入/)
  }
  assert.equal(f.sdkCalls(),0);assert.equal(f.messages.length,3)
})

test('max/close hit classes are never described as minimization and uncertain minimize never falls through',async t=>{
  for(const [code,name] of [[9,'HTMAXBUTTON'],[20,'HTCLOSE']] as const){
    const f=await fixture(code);t.after(()=>f.runtime.pause(true));const frame=await f.runtime.capture()
    const result=receiptSchema.parse(await f.runtime.execute({operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,action:{type:'click',...points[0]}}))
    assert.equal(result.hitTest?.class,name);assert.equal(result.hitTest.code,code)
    assert.deepEqual(result.delivery,{kind:'sdk',command:null});assert.equal(result.effectivePointSpace,'sdk-image-pixels')
    assert.deepEqual(result.effectivePoint,result.sourcePoint);assert.equal(f.messages.length,0);assert.equal(f.sdkCalls(),1)
  }
  const f=await fixture(8,true);t.after(()=>f.runtime.pause(true));const frame=await f.runtime.capture()
  const operation={operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,action:{type:'click',...points[0]}}
  const result=receiptSchema.parse(await f.runtime.execute(operation))
  assert.equal(result.outcome,'unknown');assert.equal(result.hitTest?.class,'HTMINBUTTON')
  assert.deepEqual(result.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'});assert.equal(f.sdkCalls(),0)
  await f.runtime.execute(operation);assert.equal(f.messages.length,1)
})

test('a proxy title-bar rectangle uses native bounds and refuses a changed hit without SDK fallback',async t=>{
  const f=await fixture(8,false,true)
  t.after(()=>f.runtime.pause(true))
  const frame=await f.runtime.capture()
  const target=frame.accessibility?.suggestedTargets?.find((item:{name:string})=>item.name==='最小化')
  assert.ok(target)
  // The deliberately wrong proxy rectangle projected to x~1228.
  assert.ok(target.bbox.x+target.bbox.width<1228)
  const {x,y,width,height}=target.bbox
  const receipt=receiptSchema.parse(await f.runtime.execute({
    operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,action:{type:'click',x:x+width/2,y:y+height/2},
  }))
  assert.equal(receipt.hitTest?.class,'HTMINBUTTON')
  assert.deepEqual(receipt.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
  const fresh=await f.runtime.capture()
  f.setHit(9)
  const refused=receiptSchema.parse(await f.runtime.execute({
    operationId:randomUUID(),frameId:fresh.id,epoch:fresh.epoch,action:{type:'click',x,y: y+height-1},
  }))
  assert.equal(refused.outcome,'refused')
  assert.equal(refused.hitTest?.class,'HTMAXBUTTON')
  assert.equal(refused.delivery,undefined)
  assert.equal(f.messages.length,1)
  assert.equal(f.sdkCalls(),0)
})
