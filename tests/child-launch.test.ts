import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createChildDispatcher } from '../src/child-session-bridge.ts'
import type { DesktopRuntimeState } from '../src/native-contract.ts'

function fixture() {
  let active=true, count=0
  let beforeSpawn: (()=>Promise<void>)|undefined
  const state:DesktopRuntimeState={backend:'windows-attended',isolated:false,status:'observing',epoch:1,window:null,foregroundAllowed:false,inputMode:'ask-each-action',lastResult:'',capabilities:{windowCapture:true,desktopCapture:false,regionCapture:true,clipboard:false,autonomousTask:false}}
  const dispatch=createChildDispatcher({assertSession(){if(!active)throw new Error('disconnected')},assertPid(pid){assert.equal(pid,123)}},async method=>{
    if(method==='pause')state.status='paused'
    return structuredClone(state)
  },async(path,check,verify)=>{await beforeSpawn?.();check();count++;verify(123);return{path,pid:123}})
  const input={path:'C:\\Apps\\fixture.exe',operationId:randomUUID(),expectedEpoch:1}
  const send=(payload=input,signal=new AbortController().signal)=>dispatch({version:1,id:randomUUID(),method:'launch',payload},signal)
  return{state,input,send,dispatch,count:()=>count,disconnect:()=>{active=false},setHook:(hook:()=>Promise<void>)=>{beforeSpawn=hook}}
}

test('child launch needs no window, deduplicates concurrent retries, and rejects changed payloads',async()=>{
  const f=fixture()
  const [first,second]=await Promise.all([f.send(),f.send()])
  assert.deepEqual(first,second)
  assert.equal(f.count(),1)
  await assert.rejects(f.send({...f.input,path:'C:\\Other.exe'}),/operationId/)
  f.disconnect()
  await assert.rejects(f.send(),/disconnected/)
})

test('child launch refuses stale epochs, paused state, cancellation and pause during file resolution',async()=>{
  for(const change of ['epoch','paused','aborted','race']){
    const f=fixture(),abort=new AbortController()
    if(change==='epoch')f.state.epoch++
    if(change==='paused')f.state.status='paused'
    if(change==='aborted')abort.abort()
    if(change==='race')f.setHook(async()=>{await f.dispatch({version:1,id:randomUUID(),method:'pause',payload:null},abort.signal)})
    await assert.rejects(f.send(f.input,abort.signal))
    assert.equal(f.count(),0)
  }
})
