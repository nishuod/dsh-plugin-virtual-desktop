import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolRuntime, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import sharp from 'sharp'
import type { VirtualDesktopController } from '../src/controller.ts'
import type { DesktopFrame, DesktopRuntimeState, DesktopWindow } from '../src/native-contract.ts'
import { registerNativeTools } from '../src/native-tools.ts'

const open = 'desktop_open_child_session'
const list = 'desktop_get_windows'
const select = 'desktop_select_window'
const capture = 'desktop_get_screenshot'

function runtimeState(overrides: Partial<DesktopRuntimeState> = {}): DesktopRuntimeState {
  return {
    backend: 'windows-attended', isolated: false, status: 'disabled', epoch: 0, window: null,
    foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: 'fixture',
    capabilities: { windowCapture: true, desktopCapture: false, regionCapture: true, clipboard: false, autonomousTask: false },
    ...overrides,
  }
}

function connectedState(): DesktopRuntimeState {
  return runtimeState({ backend: 'windows-child-session', isolated: true, status: 'observing', epoch: 1, parentSessionId: 1, childSessionId: 9 })
}

interface TestPermissions {
  configured?: 'ask' | 'never'
  override?: 'ask' | 'never'
  mode?: string
  preset?: string
}

interface Options {
  initial?: DesktopRuntimeState
  approve?: false | ((request: ApprovalRequest) => string | Promise<string>)
  enableError?: Error
  selectionEpochIncrement?: number
  permissions?: TestPermissions
  scopedTools?: boolean
}

async function harness(t: TestContext, options: Options = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(NativeToolExecutor)
  const target: DesktopWindow = {
    id: randomUUID(), app: 'fixture.exe', title: '含引号的窗口 "工作表"', pid: 1234,
    x: 0, y: 0, width: 10, height: 10,
  }
  const fake = { state: options.initial ?? runtimeState(), windows: [target], afterStatus: undefined as (() => void) | undefined }
  const calls = { child: 0, local: 0, launch: 0, select: [] as [string, number][], capture: 0, execute:0, restore:0, saved: 0, sandbox: 0 }
  const requests: ApprovalRequest[] = []
  const permissions: TestPermissions = { ...options.permissions }
  const agent = {
    session: { requestHeader: () => undefined }, options: { provider: 'qa', model: 'vision' },
  } as unknown as NonNullable<ToolExecution['agent']>
  if (options.approve !== false) {
    const approve = options.approve
    ctx.provide('approval', {
      config: { get policy() { return permissions.configured } },
      overrideOf(session: unknown) {
        assert.equal(session, agent.session)
        return permissions.override
      },
      async request(request: ApprovalRequest) {
        requests.push(request)
        return await (approve?.(request) ?? 'allowed-once')
      },
    } as unknown as Context['approval'])
  }
  if (permissions.mode !== undefined) {
    ctx.provide('sandboxPolicy', {
      resolve({ session }: { session: unknown }) {
        assert.equal(session, agent.session)
        calls.sandbox++
        return { mode: permissions.mode }
      },
    } as unknown as Context['sandboxPolicy'])
  }
  if (permissions.preset !== undefined) {
    ctx.provide('permissionPresets', {
      current(session: unknown) {
        assert.equal(session, agent.session)
        return permissions.preset
      },
    } as unknown as Context['permissionPresets'])
  }
  ctx.provide('llm', {
    resolveModelInfo: async (provider: string, model: string) => {
      assert.deepEqual([provider, model], ['qa', 'vision'])
      return { inputModalities: ['image'] }
    },
  } as unknown as Context['llm'])
  const attachmentStore = {
    saveImage: async (input: SaveImageAttachment) => {
      calls.saved++
      assert.equal(input.mediaType, 'image/jpeg')
      return { attachmentId: AttachmentId(createHash('sha256').update(input.data).digest('hex')),
        mediaType: input.mediaType, width: 2, height: 2, bytes: input.data.length }
    },
  } as unknown as Context['attachments']
  if (options.scopedTools) await ctx.plugin({
    name: 'host-attachment-store',
    provide: 'attachments',
    apply(inner) { inner.provide('attachments', attachmentStore) },
  })
  else ctx.provide('attachments', attachmentStore)
  const service = {
    restoreWindowApproved:async(id:string,pid:number,connectionId:string,epoch:number)=>{
      assert.equal(id,fake.state.window?.id);assert.equal(pid,fake.state.window?.pid)
      assert.equal(connectionId,fake.state.connectionId);assert.equal(epoch,fake.state.epoch)
      calls.restore++;return structuredClone(fake.state)
    },
    executeApproved:async(operation: {operationId:string})=>{calls.execute++;return {operationId:operation.operationId,outcome:"delivered",message:"test",after:null}},
    launchChildApplication: async (path: string, operationId: string, connectionId: string, expectedEpoch: number) => {
      assert.equal(connectionId,fake.state.connectionId)
      assert.equal(expectedEpoch,fake.state.epoch)
      calls.launch++
      return {path,operationId,pid:1234,outcome:'started',message:'fixture'}
    },
    desktopStatus: async () => {
      fake.afterStatus?.()
      return structuredClone(fake.state)
    },
    enableChildSession: async (signal: AbortSignal) => {
      calls.child++
      signal.throwIfAborted()
      if (options.enableError) throw options.enableError
      fake.state = connectedState()
      return structuredClone(fake.state)
    },
    enableLocal: async () => { calls.local++; throw new Error('Test forbids host fallback') },
    windows: async () => structuredClone(fake.windows),
    selectWindowApproved: async (id: string, expectedEpoch: number, signal: AbortSignal) => {
      calls.select.push([id, expectedEpoch])
      signal.throwIfAborted()
      assert.equal(id, target.id)
      assert.equal(expectedEpoch, fake.state.epoch)
      fake.state = { ...fake.state, status: 'enabled', epoch: fake.state.epoch + (options.selectionEpochIncrement ?? 1),
        window: target, foregroundAllowed: false }
      return structuredClone(fake.state)
    },
    capture: async (source: string, crop: string, signal: AbortSignal): Promise<DesktopFrame> => {
      calls.capture++
      signal.throwIfAborted()
      assert.equal(source, 'window')
      assert.equal(crop, '')
      assert.equal(fake.state.window?.id, target.id)
      const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#8192bb' } }).jpeg().toBuffer()
      return { id: randomUUID(), windowId: target.id, epoch: fake.state.epoch, capturedAt: Date.now(), source,
        width: 2, height: 2, mimeType: 'image/jpeg', data: image.toString('base64'), tree: '' }
    },
  }
  const register = (toolContext: Context) => registerNativeTools(toolContext, service as unknown as VirtualDesktopController)
  if (options.scopedTools) await ctx.plugin({ name: 'virtual-desktop-runtime', inject: ['tools'], apply: register })
  else register(ctx)
  async function execute(name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal, withAgent = true) {
    const id = ToolCallId(randomUUID())
    const { results } = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
      signal, ...(withAgent ? { agent } : {}) })
    assert.equal(results.length, 1)
    assert.equal(results[0].callId, id)
    return { id, result: results[0].result }
  }
  return { execute, requests, fake, target, calls, agent, permissions }
}

function toolText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')
}

test('chat opens PiP, discovers an opaque window, binds it once, and obtains a DSH image attachment', async t => {
  const f = await harness(t)
  const opened = await f.execute(open)
  assert.equal(opened.result.isError, false, toolText(opened.result))
  assert.equal(f.calls.child, 1)
  assert.equal(f.calls.local, 0)
  assert.equal(f.fake.state.window, null)
  assert.deepEqual(JSON.parse(toolText(opened.result)), { state: connectedState(), windows: [f.target] })
  assert.equal(f.requests[0].toolName, open)
  assert.equal(f.requests[0].callId, opened.id)
  assert.equal(f.requests[0].agent, f.agent)

  const listed = (await f.execute(list)).result
  assert.equal(listed.isError, false, toolText(listed))
  const [discovered] = JSON.parse(toolText(listed))
  assert.equal(discovered.id, f.target.id)
  assert.equal(f.requests.length, 1, 'discovering windows requires no input grant')
  const unbound = (await f.execute(capture)).result
  assert.equal(unbound.isError, true)
  assert.match(toolText(unbound), /desktop_open_application|desktop_select_window/)
  assert.equal(f.calls.capture, 0)

  const selected = await f.execute(select, { windowId: discovered.id })
  assert.equal(selected.result.isError, false, toolText(selected.result))
  assert.deepEqual(f.calls.select, [[f.target.id, connectedState().epoch]])
  assert.deepEqual(JSON.parse(toolText(selected.result)), f.fake.state)
  assert.equal(f.requests[1].toolName, select)
  assert.equal(f.requests[1].callId, selected.id)
  assert.ok(f.requests[1].reason?.includes(JSON.stringify({
    title: f.target.title, app: f.target.app, pid: f.target.pid, windowId: f.target.id,
  })))

  const screenshot = (await f.execute(capture)).result
  assert.equal(screenshot.isError, false, toolText(screenshot))
  assert.equal(f.calls.capture, 1)
  assert.equal(f.calls.saved, 1)
  assert.ok(screenshot.content.some(block => block.type === 'image'))
  assert.equal(f.requests.length, 2)
})

test('chat screenshot in the production Cordis fiber reaches the attachment store', async t => {
  const f = await harness(t, { scopedTools: true })
  f.fake.state = { ...connectedState(), connectionId: randomUUID(), status: 'enabled', window: f.target }
  const { result } = await f.execute(capture)
  assert.equal(result.isError, false, toolText(result))
  assert.equal(f.calls.saved, 1, toolText(result))
  assert.ok(result.content.some(block => block.type === 'image'), toolText(result))
})

test('chat connection and binding grant nothing for rejected, cancelled, unavailable or persistent decisions', async t => {
  for (const decision of ['rejected', 'cancelled', 'unavailable', 'always-allow']) {
    await t.test(decision, async t => {
      const f = await harness(t, { approve: () => decision })
      const connection = (await f.execute(open)).result
      assert.equal(connection.isError, true)
      assert.match(toolText(connection), /本次批准/)
      assert.equal(f.calls.child, 0)
      assert.equal(f.calls.local, 0)
      f.fake.state = connectedState()
      const binding = (await f.execute(select, { windowId: f.target.id })).result
      assert.equal(binding.isError, true)
      assert.match(toolText(binding), /本次批准/)
      assert.deepEqual(f.calls.select, [])
    })
  }
})

test('chat connection requires both an approval service and an owning agent', async t => {
  for (const missing of ['approval', 'agent'] as const) {
    await t.test(missing, async t => {
      const f = await harness(t, { approve: missing === 'approval' ? false : undefined })
      const result = (await f.execute(open, {}, undefined, missing !== 'agent')).result
      assert.equal(result.isError, true)
      assert.match(toolText(result), /批准/)
      assert.equal(f.calls.child, 0)
      assert.equal(f.calls.local, 0)
      assert.deepEqual(f.requests, [])
    })
  }
})

test('aborting during approval cannot turn a late grant into a connection or binding', async t => {
  for (const name of [open, select]) {
    await t.test(name, async t => {
      const cancellation = new AbortController()
      const f = await harness(t, {
        initial: name === select ? connectedState() : undefined,
        approve: async () => { cancellation.abort(); return 'allowed-once' },
      })
      const args = name === select ? { windowId: f.target.id } : {}
      const result = (await f.execute(name, args, cancellation.signal)).result
      assert.equal(result.isError, true)
      assert.equal(f.requests.length, 1)
      assert.equal(f.calls.child, 0)
      assert.equal(f.calls.local, 0)
      assert.deepEqual(f.calls.select, [])
    })
  }
})

test('chat tools reject injected mode and window identifiers, with discovery guidance for a valid unknown ID', async t => {
  const f = await harness(t)
  assert.equal((await f.execute(open, { mode: 'windows-attended' })).result.isError, true)
  const unconnected = (await f.execute(list)).result
  assert.equal(unconnected.isError, true)
  assert.match(toolText(unconnected), /desktop_open_application|desktop_open_child_session/)
  const disconnected = (await f.execute(select, { windowId: f.target.id })).result
  assert.equal(disconnected.isError, true)
  assert.match(toolText(disconnected), /desktop_open_application|desktop_open_child_session/)
  f.fake.state = connectedState()
  assert.equal((await f.execute(select, { windowId: f.target.title })).result.isError, true)
  assert.equal((await f.execute(select, { windowId: f.target.id, pid: f.target.pid })).result.isError, true)
  const unknown = (await f.execute(select, { windowId: randomUUID() })).result
  assert.equal(unknown.isError, true)
  assert.match(toolText(unknown), /desktop_get_windows/)
  assert.deepEqual(f.requests, [])
  assert.equal(f.calls.child, 0)
  assert.deepEqual(f.calls.select, [])
})

test('active host debugging and PiP startup failure never fall back to host input', async t => {
  const f = await harness(t, { initial: runtimeState({ status: 'observing' }), enableError: new Error('fixture startup failed') })
  const hostActive = (await f.execute(open)).result
  assert.equal(hostActive.isError, true)
  assert.match(toolText(hostActive), /结束本机调试/)
  const localBinding = (await f.execute(select, { windowId: f.target.id })).result
  assert.equal(localBinding.isError, true)
  assert.match(toolText(localBinding), /desktop_open_application|desktop_open_child_session/)
  assert.deepEqual(f.calls.select, [])
  assert.deepEqual(f.requests, [])
  assert.equal(f.calls.child, 0)
  f.fake.state = runtimeState()
  const failure = (await f.execute(open)).result
  assert.equal(failure.isError, true)
  assert.equal(f.requests.length, 1)
  assert.equal(f.calls.child, 1)
  assert.equal(f.calls.local, 0)
})

test('selection approval is invalidated by changes to the connection, epoch or approved window identity', async t => {
  for (const change of ['status', 'epoch', 'child-session', 'bound-window', 'listed-title'] as const) {
    await t.test(change, async t => {
      let revise = () => {}
      const f = await harness(t, {
        initial: connectedState(), approve: async () => { revise(); return 'allowed-once' },
      })
      revise = () => {
        switch (change) {
          case 'status': f.fake.state.status = 'paused'; break
          case 'epoch': f.fake.state.epoch++; break
          case 'child-session': f.fake.state.childSessionId = 10; break
          case 'bound-window': f.fake.state.window = { ...f.target, id: randomUUID() }; break
          case 'listed-title': f.fake.windows = [{ ...f.target, title: '新标题' }]; break
        }
      }
      const result = (await f.execute(select, { windowId: f.target.id })).result
      assert.equal(result.isError, true)
      assert.match(toolText(result), /重新发现并批准/)
      assert.equal(f.requests.length, 1)
      assert.deepEqual(f.calls.select, [])
    })
  }
})

test('a child selection reply must acknowledge exactly the next approved epoch', async t => {
  const f = await harness(t, { initial: connectedState(), selectionEpochIncrement: 2 })
  const result = (await f.execute(select, { windowId: f.target.id })).result
  assert.equal(result.isError, true)
  assert.match(toolText(result), /未确认本次授权/)
  assert.deepEqual(f.calls.select, [[f.target.id, connectedState().epoch]])
})

const fullNever = {
  configured: 'never', mode: 'danger-full-access', preset: 'danger-full-access',
} satisfies TestPermissions

test('verified Full Access with never-ask opens and binds PiP without a prompt', async t => {
  const f = await harness(t, { permissions: fullNever })
  f.fake.state = runtimeState({ status: 'observing' })
  const activeHost = (await f.execute(open)).result
  assert.equal(activeHost.isError, true)
  assert.match(toolText(activeHost), /结束本机调试/)
  assert.equal(f.calls.child, 0)
  f.fake.state = runtimeState()

  const opened = (await f.execute(open)).result
  assert.equal(opened.isError, false, toolText(opened))
  assert.equal(f.calls.child, 1)
  assert.equal(f.calls.local, 0)
  assert.equal(f.fake.state.window, null)
  assert.equal(f.requests.length, 0)

  const selected = (await f.execute(select, { windowId: f.target.id })).result
  assert.equal(selected.isError, false, toolText(selected))
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.calls.select, [[f.target.id, connectedState().epoch]])

})

test('never-ask cannot start a child session with limited, unknown, missing, or Auto permissions', async t => {
  const cases: [string, Partial<TestPermissions>][] = [
    ['lower sandbox mode', { mode: 'workspace-write' }],
    ['unknown sandbox mode', { mode: 'future-sandbox-mode' }],
    ['missing sandbox policy service', { mode: undefined }],
    ['unknown preset', { preset: 'future-preset' }],
    ['missing preset service', { preset: undefined }],
    ['custom preset', { preset: 'custom' }],
    ['Auto preset', { preset: 'auto' }],
  ]
  for (const [name, permissions] of cases) {
    await t.test(name, async t => {
      const f = await harness(t, { permissions: { ...fullNever, ...permissions } })
      const blocked = (await f.execute(open)).result
      assert.equal(blocked.isError, true)
      assert.match(toolText(blocked), /从不询问/)
      assert.match(toolText(blocked), /完全权限/)
      assert.deepEqual(f.requests, [])
      assert.equal(f.calls.child, 0)
      assert.equal(f.calls.local, 0)
    })
  }
})

test('Full Access respects a session approval-policy override in either direction', async t => {
  for (const override of ['ask', 'never'] as const) {
    await t.test(override, async t => {
      const f = await harness(t, { permissions: { ...fullNever, override, configured: override === 'ask' ? 'never' : 'ask' } })
      const result = (await f.execute(open)).result
      assert.equal(result.isError, false, toolText(result))
      assert.deepEqual(f.requests.map(request => request.toolName), override === 'ask' ? [open] : [])
      assert.equal(f.calls.child, 1)
    })
  }
})

test('tool arguments cannot claim a permission mode or an approval bypass', async t => {
  const f = await harness(t, { permissions: { configured: 'never', mode: 'workspace-write', preset: 'custom' } })
  const result = (await f.execute(open, { mode: 'danger-full-access', preset: 'danger-full-access', policy: 'never' })).result
  assert.equal(result.isError, true)
  assert.deepEqual(f.requests, [])
  assert.equal(f.calls.child, 0)
  assert.equal(f.calls.local, 0)
})

test('a Full Access launch grant is rechecked after desktop status and before enable', async t => {
  const f = await harness(t, { permissions: fullNever })
  let revoked = false
  f.fake.afterStatus = () => {
    if (f.calls.sandbox > 0) {
      revoked = true
      f.permissions.mode = 'workspace-write'
    }
  }
  const result = (await f.execute(open)).result
  assert.equal(revoked, true)
  assert.equal(result.isError, true)
  assert.match(toolText(result), /权限已变化/)
  assert.deepEqual(f.requests, [])
  assert.equal(f.calls.child, 0)
  assert.equal(f.calls.local, 0)
})

test('empty PiP can launch with the verified session grant, once approval, or explicit refusal',async t=>{
  for(const mode of ['full','ask','denied','limited','revoked','cancelled'] as const){
    await t.test(mode,async t=>{
      const cancel=new AbortController()
      const f=await harness(t,{initial:{...connectedState(),connectionId:randomUUID()},
        permissions:mode==='ask'||mode==='denied'||mode==='cancelled'?{}:{...fullNever,...(mode==='limited'?{mode:'workspace-write'}:{})},
        approve:()=>{if(mode==='cancelled')cancel.abort();return mode==='denied'?'rejected':'allowed-once'},
      })
      f.fake.windows=[]
      if(mode==='revoked')f.fake.afterStatus=()=>{if(f.calls.sandbox>0)f.permissions.mode='workspace-write'}
      const result=(await f.execute('desktop_launch_in_child_session',{path:'C:\\Apps\\fixture.exe',operationId:randomUUID()},cancel.signal)).result
      const allowed=mode==='full'||mode==='ask'
      assert.equal(result.isError,!allowed,toolText(result))
      assert.equal(f.calls.launch,allowed?1:0)
      assert.equal(f.fake.state.window,null)
      assert.equal(f.requests.length,mode==='ask'||mode==='denied'||mode==='cancelled'?1:0)
    })
  }
})

test('launch rejects parent desktop and shell command shaped arguments before dispatch',async t=>{
  const f=await harness(t,{initial:{...connectedState(),connectionId:randomUUID()},permissions:fullNever})
  for(const path of ['app.exe','C:\\app.exe --flag','C:\\app.cmd','\\\\host\\app.exe','C:\\app.exe:stream.exe','"C:\\app.exe"']){
    assert.equal((await f.execute('desktop_launch_in_child_session',{path,operationId:randomUUID()})).result.isError,true)
  }
  assert.equal((await f.execute('desktop_launch_in_child_session',{path:'C:\\app.exe',operationId:randomUUID(),args:['x']})).result.isError,true)
  f.fake.state={...f.fake.state,backend:'windows-attended',isolated:false}
  assert.equal((await f.execute('desktop_launch_in_child_session',{path:'C:\\app.exe',operationId:randomUUID()})).result.isError,true)
  assert.equal(f.calls.launch,0)
})

test('empty open reply directs the model to launch, and launch accepts a path alone',async t=>{
  const f=await harness(t,{permissions:fullNever})
  f.fake.windows=[]
  const opened=(await f.execute(open)).result
  assert.equal(opened.isError,false,toolText(opened))
  const result=JSON.parse(toolText(opened))
  assert.equal(result.nextTool,'desktop_open_application')
  assert.match(result.guidance,/不要求已有窗口/)
  f.fake.state.connectionId=randomUUID()
  const launched=(await f.execute('desktop_launch_in_child_session',{path:'C:\\Apps\\fixture.exe'})).result
  assert.equal(launched.isError,false,toolText(launched))
  assert.match(JSON.parse(toolText(launched)).launch.operationId,/^[0-9a-f-]{36}$/)
  assert.equal(f.calls.launch,1)
})

test('child direct input follows the effective grant and rechecks it before dispatch',async t=>{
  for(const mode of ['full','limited','ask','revoked','changed'])await t.test(mode,async t=>{
    const f=await harness(t,{permissions:mode==='limited'?{...fullNever,mode:'workspace-write'}:mode==='ask'?{configured:'ask'}:fullNever})
    f.fake.state={...connectedState(),connectionId:randomUUID(),status:'enabled',window:f.target}
    let reads=0
    f.fake.afterStatus=()=>{if(++reads===2){if(mode==='revoked')f.permissions.mode='workspace-write';if(mode==='changed')f.fake.state.epoch++}}
    const result=(await f.execute('desktop_click',{operationId:randomUUID(),frameId:randomUUID(),epoch:1,x:1,y:1})).result
    assert.equal(result.isError,!['full','ask'].includes(mode),toolText(result))
    assert.equal(f.calls.execute,['full','ask'].includes(mode)?1:0)
    assert.equal(f.requests.length,mode==='ask'?1:0)
  })
})

test('restore has independent permission and connection identity checks without consuming a screenshot',async t=>{
  for(const mode of ['full','limited','ask','revoked','changed','wrong-pid'])await t.test(mode,async t=>{
    const f=await harness(t,{permissions:mode==='limited'?{...fullNever,mode:'workspace-write'}:mode==='ask'?{configured:'ask'}:fullNever})
    f.fake.state={...connectedState(),connectionId:randomUUID(),status:'enabled',window:f.target}
    const args={connectionId:f.fake.state.connectionId,epoch:f.fake.state.epoch,windowId:f.target.id,pid:mode==='wrong-pid'?f.target.pid+1:f.target.pid}
    let reads=0
    f.fake.afterStatus=()=>{if(++reads===2){if(mode==='revoked')f.permissions.mode='workspace-write';if(mode==='changed')f.fake.state.epoch++}}
    const result=(await f.execute('desktop_restore_window',args)).result
    assert.equal(result.isError,!['full','ask'].includes(mode),toolText(result))
    assert.equal(f.calls.restore,['full','ask'].includes(mode)?1:0)
    assert.equal(f.calls.capture,0)
    assert.equal(f.requests.length,mode==='ask'?1:0)
  })
})
