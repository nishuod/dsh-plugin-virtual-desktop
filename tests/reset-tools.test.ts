import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import {VirtualDesktopController} from '../src/controller.ts'
import {NativeSession} from '../src/native-session.ts'
import {ChildSessionClient} from '../src/child-session-client.ts'
import {DiagnosticWorker} from '../src/worker-client.ts'
import {registerNativeTools} from '../src/native-tools.ts'

const signal=()=>AbortSignal.timeout(5000)
async function fixture(){
  const ctx=new Context()
  await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime,{});await ctx.plugin(NativeToolExecutor)
  const native=new NativeSession({timeoutMs:5000,frameAgeMs:30000,maxDimension:1280,imageBytes:512000})
  const tasks:any={snapshot:()=>null,assertIdle(){},control:async()=>native.close().then(()=>native.status(signal())),close:async()=>{}}
  const controller=new VirtualDesktopController(ctx,new DiagnosticWorker(5000),native,tasks)
  registerNativeTools(ctx,controller)
  const execute=async(args:Record<string,unknown>={})=>{
    const {results}=await ctx.tools.execute({calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name:'desktop_reset_child_session',arguments:JSON.stringify(args)}],signal:signal()})
    return results[0].result
  }
  return {ctx,native,controller,execute,tasks}
}

test('reset is projected to real chat schemas with only optional operationId and idle invocation succeeds',async t=>{
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  const schema=f.ctx.tools.schemas().find(tool=>tool.name==='desktop_reset_child_session')!
  assert.ok(schema)
  const parameters=schema.parameters as any
  assert.deepEqual(Object.keys(parameters.properties),['operationId'])
  assert.equal(parameters.additionalProperties,false);assert.ok(!parameters.required?.length)
  const id=randomUUID(),result=await f.execute({operationId:id})
  assert.equal(result.isError,false)
  const value=JSON.parse((result.content[0] as any).text)
  assert.equal(value.operationId,id);assert.equal(value.state,'idle');assert.deepEqual(value.releasedPids,[])
  assert.equal((await f.execute()).isError,false)
  assert.equal((await f.execute({pid:process.pid})).isError,true)
})

test('reset reports only confirmed owned broker PIDs, joins concurrent callers and never repeats after reopen',async t=>{
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  const owned=new ChildSessionClient(5000,()=>{})
  Object.assign(owned,{originalBrokerPid:12345})
  f.native['ownedChildren'].add(owned)
  let release!:()=>void,closes=0
  const gate=new Promise<void>(resolve=>{release=resolve})
  owned.close=async()=>{closes++;await gate;Object.assign(owned,{cleanupConfirmed:true})}
  const id=randomUUID(),first=f.controller.resetChildSession(id,signal()),second=f.controller.resetChildSession(id,signal())
  release();const result=await first
  assert.deepEqual(result.releasedPids,[12345]);assert.equal(result.state,'released')
  assert.deepEqual(await second,result);assert.equal(closes,1)
  let stopped=0;f.tasks.control=async()=>{stopped++;throw Error('new session must remain intact')}
  assert.deepEqual(await f.controller.resetChildSession(id,signal()),result);assert.equal(stopped,0)
  assert.ok(!result.releasedPids.includes(process.pid))
})

test('failed cleanup never claims released; retry with same operationId can complete retained ownership',async t=>{
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  const owned=new ChildSessionClient(5000,()=>{});Object.assign(owned,{originalBrokerPid:12346})
  f.native['ownedChildren'].add(owned);owned.close=async()=>{throw Error('ownership proof incomplete')}
  const id=randomUUID();await assert.rejects(f.controller.resetChildSession(id,signal()),/ownership proof/)
  owned.close=async()=>{Object.assign(owned,{cleanupConfirmed:true})}
  const result=await f.controller.resetChildSession(id,signal())
  assert.equal(result.state,'released');assert.deepEqual(result.releasedPids,[12346])
})

test('concurrent reset IDs reserve the replay budget without counting duplicate calls', async t => {
  const { ctx, native, controller, tasks } = await fixture()
  t.after(() => ctx.fiber.dispose())
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let stops = 0
  tasks.control = async () => {
    stops++
    await gate
    return native.status(signal())
  }
  const ids = Array.from({ length: 256 }, () => randomUUID())
  const requests = ids.map(id => controller.resetChildSession(id, signal()))
  const duplicate = controller.resetChildSession(ids[0], signal())
  const excess = assert.rejects(controller.resetChildSession(randomUUID(), signal()), /重置请求已达上限/)
  release()
  const [receipts, replay] = await Promise.all([Promise.all(requests), duplicate, excess])
  assert.deepEqual(receipts.map(receipt => receipt.operationId), ids)
  assert.deepEqual(replay, receipts[0])
  assert.deepEqual(await controller.resetChildSession(ids[0], signal()), receipts[0])
  await assert.rejects(controller.resetChildSession(randomUUID(), signal()), /重置请求已达上限/)
  assert.equal(stops, 1)
})

test('reset refuses an attended startup before it can stop that runtime', async t => {
  const { ctx, native, controller, tasks } = await fixture()
  t.after(() => ctx.fiber.dispose())
  let finishStartup!: () => void
  const startup = new Promise<void>(resolve => { finishStartup = resolve })
  native.enable = async () => {
    await startup
    return native.status(signal())
  }
  let stops = 0
  tasks.control = async () => {
    stops++
    return native.status(signal())
  }
  const local = controller.enableLocal(signal())
  try {
    await assert.rejects(controller.resetChildSession(randomUUID(), signal()), /本机桌面/)
    assert.equal(stops, 0)
  } finally {
    finishStartup()
    await local
  }
})
