// Opt-in integration against the compiled fixture only, never general app coordinates.
import {readFile,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import koffi from 'koffi'
import {NativeClient} from '../lib/native-client.js'
const client=new NativeClient(20000)
const competing=new NativeClient(20000)
const signal=AbortSignal.timeout(120000)
const evidence=[]
const limits={frameAgeMs:60000,maxDimension:1280,imageBytes:512000}
const state=async()=>JSON.parse(await readFile('tests/fixtures/fixture-state.json','utf8'))
let window
let frame
async function observe(){frame=await client.call('capture',{source:'window'},signal);return frame}
async function act(type,control,extra={}){
  await observe()
  const before=await state()
  const x=(before[control+'X']-window.x)*frame.width/window.width
  const y=(before[control+'Y']-window.y)*frame.height/window.height
  const operation={operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'foreground',action:{type,x,y,...extra}}
  const result=await client.call('execute',operation,signal)
  evidence.push({type,outcome:result.outcome,message:result.message,frameBefore:frame.id,frameAfter:result.after?.id??null})
  assert.equal(result.outcome,'delivered',result.message)
  assert.ok(result.after)
  frame=result.after
  return {operation,result,before}
}
try{
  await client.call('enable',limits,signal)
  const windows=await client.call('windows',null,signal)
  const candidates=windows.filter(w=>w.title==='DSH Desktop Test Fixture')
  assert.equal(candidates.length,1,'Start exactly one owned test fixture first')
  window=candidates[0]
  const initial=await state();assert.equal(window.pid,initial.pid)
  await client.call('select',{windowId:window.id,foreground:true},signal)
  await competing.call('enable',limits,signal)
  const other=(await competing.call('windows',null,signal)).find(w=>w.pid===window.pid&&w.title===window.title)
  await assert.rejects(competing.call('select',{windowId:other.id,foreground:true},signal),/租约/)
  await competing.close()
  await observe();await writeFile('evidence/native-fixture-before.jpg',Buffer.from(frame.data,'base64'))
  assert.ok(Math.abs(frame.width-window.width)<10 && Math.abs(frame.height-window.height)<10,'unscaled capture must include the entire physical window')
  const cropped=await client.call('capture',{source:'window',crop:{x:20,y:50,width:400,height:180}},signal)
  assert.equal(cropped.width,400);assert.equal(cropped.height,180)
  await act('move','text')
  const cursor=[0,0]
  const user=koffi.load('user32.dll')
  const dpi=user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')
  const previous=dpi(-4n)
  try{assert.ok(user.func('int __stdcall GetPhysicalCursorPos(_Out_ int32_t* point)')(cursor))}
  finally{if(previous)dpi(previous)}
  const target=await state()
  evidence.push({type:'pointer-readback',cursor,target:{x:target.textX,y:target.textY}})
  assert.ok(Math.abs(cursor[0]-target.textX)<=2 && Math.abs(cursor[1]-target.textY)<=2,'pointer must land on screenshot-mapped physical position')
  const clicked=await act('click','button',{button:'left',count:1})
  assert.equal((await state()).clicks,initial.clicks+1)
  await client.call('execute',clicked.operation,signal)
  assert.equal((await state()).clicks,initial.clicks+1,'duplicate must not click twice')
  await act('type','text',{text:'DSH 第三阶段：中文输入 ✓ 2026'})
  assert.match((await state()).text,/DSH 第三阶段：中文输入 ✓ 2026/)
  await act('clear','text')
  assert.equal((await state()).text,'')
  await act('type','text',{text:'观察 → 执行 → 验证'})
  await act('key','text',{key:'end',modifiers:[]})
  await act('click','target',{button:'right',count:1})
  assert.ok((await state()).rights>initial.rights)
  await act('click','target',{button:'left',count:2})
  assert.ok((await state()).doubles>initial.doubles)
  const current=await state()
  const toX=(current.targetX-window.x+100)*frame.width/window.width
  const toY=(current.targetY-window.y+30)*frame.height/window.height
  await act('drag','target',{toX,toY,durationMs:400})
  assert.ok((await state()).drags>initial.drags)
  await act('hold','target',{durationMs:300})
  await act('scroll','scroll',{direction:'down',amount:3})
  assert.ok((await state()).wheels>initial.wheels)
  await observe()
  const old=frame
  const paused=await client.call('pause',null,signal);assert.equal(paused.status,'paused')
  await client.call('resume',null,signal)
  await assert.rejects(client.call('execute',{operationId:randomUUID(),frameId:old.id,epoch:old.epoch,delivery:'foreground',action:{type:'click',x:10,y:10}},signal))
  await observe();await writeFile('evidence/native-fixture-after.jpg',Buffer.from(frame.data,'base64'))
  await client.call('stop',null,signal)
  await assert.rejects(client.call('resume',null,signal))
  await writeFile('evidence/windows-integration.json',JSON.stringify({passed:true,fixturePid:window.pid,window,actions:evidence,final:await state()},null,2))
  console.log(JSON.stringify({passed:true,actions:evidence.filter(e=>e.outcome).length,fixturePid:window.pid}))
}catch(error){
  await writeFile('evidence/windows-integration.json',JSON.stringify({passed:false,actions:evidence,error:String(error)},null,2))
  throw error
}finally{await competing.close();await client.close()}
