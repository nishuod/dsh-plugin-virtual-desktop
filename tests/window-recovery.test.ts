import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { NativeRuntime, type IdentityPort, type DriverPort } from '../src/native-runtime.ts'
import { NativeWindowError, nativeReplySchema, nativeRequestSchema, restoreWindowResultSchema, windowFailure, type DesktopRuntimeState } from '../src/native-contract.ts'
import { createChildDispatcher } from '../src/child-session-bridge.ts'
import { WindowsIdentity } from '../src/windows-identity.ts'
import { NativeSession } from '../src/native-session.ts'

async function fixture() {
  const png = await sharp({ create: { width: 1920, height: 859, channels: 3, background: '#abcdef' } }).png().toBuffer()
  let minimized = false, birth = 'initial', restores = 0, inputs = 0
  let rect = { x: 20, y: 30, width: 1920, height: 859, foreground: '1' }
  const identity: IdentityPort & {
    restoreWindow(id: string, pid: number): void
    restoredWindow(id: string, pid: number): { rect: ReturnType<IdentityPort['window']>; bounds: Pick<ReturnType<IdentityPort['window']>, 'x'|'y'|'width'|'height'> }
  } = {
    assertInteractive() {}, process: () => ({ birth, image: 'fixture.exe' }),
    window() {
      if (minimized) throw Object.assign(new Error('窗口已最小化'), { reason: 'minimized', nextTool: 'desktop_restore_window' })
      return { ...rect }
    },
    windowShellInfo: () => ({ shellDesktop: false, className: 'Fixture' }),
    rawTopLevelCount: () => 1, acquireLease: () => () => {}, movePointer() { inputs++ },
    restoreWindow(id, pid) { assert.equal(id, '1'); assert.equal(pid, 42); minimized = false; restores++ },
    restoredWindow(id, pid) { return {rect:this.window(id,pid),bounds:rect} },
  }
  const driver: DriverPort = {
    listWindows: async () => {
      const {foreground,...bounds}=rect
      return { windows: [{ windowId: 1n, pid: 42, title: 'Fixture', appName: 'Fixture', bounds, isOnScreen: true }] }
    },
    getWindowState: async () => ({ pid: 42, windowId: 1n, screenshotFrameValid: true, images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }], treeMarkdown: 'fixture' }),
    getDesktopState: async () => ({ isError: false, text: '', rawJson: '{}', images: [], degraded: false }),
    callTool: async () => { inputs++; return { isError: false, text: 'delivered', rawJson: '{}', images: [], degraded: false } },
    shutdown: async () => {},
  }
  const runtime = new NativeRuntime({ frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000 }, identity, () => driver, undefined, true,undefined,async()=>({complete:true,passwordRegions:[]}))
  await runtime.enable()
  const [window] = await runtime.listWindows()
  const selected = await runtime.select(window.id, false)
  return { runtime, window, epoch: selected.epoch, identity, driver,
    minimize() { minimized = true }, setBirth(value: string) { birth = value },
    resize() { rect = { ...rect, x: 100, width: 1600 } }, restores: () => restores, inputs: () => inputs }
}

test('D2 minimized target can restore without a screenshot, keeps identity and invalidates old frames', async t => {
  const f = await fixture(); t.after(() => f.runtime.pause(true))
  const before = await f.runtime.capture()
  f.minimize()
  await assert.rejects(f.runtime.capture(), { reason: 'minimized', nextTool: 'desktop_restore_window' })
  assert.equal(typeof f.runtime.restore, 'function', 'a minimized target currently has no frame-independent restore entry point')
  const state = await f.runtime.restore(f.window.id, f.window.pid, f.epoch)
  assert.equal(state.state,'restored')
  assert.equal(state.window?.id, f.window.id); assert.equal(state.window?.pid, f.window.pid)
  await assert.rejects(f.runtime.execute({ operationId: randomUUID(), frameId: before.id, epoch: before.epoch, delivery: 'background', action: { type: 'click', x: 100, y: 100 } }))
  await f.runtime.restore(f.window.id, f.window.pid, f.epoch)
  assert.ok(await f.runtime.capture()); assert.equal(f.inputs(), 0)
})

test('D2 restore rejects stale epoch, other PID/window and reused process identity', async t => {
  const f = await fixture(); t.after(() => f.runtime.pause(true))
  const restore = (f.runtime as any).restore
  assert.equal(typeof restore, 'function')
  for (const [id, pid, epoch] of [[f.window.id, 42, f.epoch - 1], [f.window.id, 43, f.epoch], [randomUUID(), 42, f.epoch]] as const) {
    await assert.rejects(restore.call(f.runtime, id, pid, epoch))
  }
  assert.equal(f.restores(), 0)
  f.setBirth('replacement')
  await assert.rejects(restore.call(f.runtime, f.window.id, 42, f.epoch), { reason: 'identity-changed' })
  assert.equal(f.restores(), 0)
})

test('D2 new capture rebinds moved/resized geometry and reports it while old input stays refused', async t => {
  const f = await fixture(); t.after(() => f.runtime.pause(true))
  const old = await f.runtime.capture()
  f.resize()
  await assert.rejects(f.runtime.execute({ operationId: randomUUID(), frameId: old.id, epoch: old.epoch, delivery: 'background', action: { type: 'click', x: 100, y: 100 } }))
  const fresh = await f.runtime.capture()
  assert.equal(f.runtime.snapshot().window?.width, 1600)
  assert.match((fresh as any).notice, /重绑/)
  assert.equal(fresh.windowId, f.window.id); assert.equal(f.inputs(), 0)
})

test('D1 wide frame exposes the same inverse scale used for native input', async t => {
  const f = await fixture(); t.after(() => f.runtime.pause(true))
  const frame = await f.runtime.capture()
  assert.deepEqual((frame as any).scale, { rawWidth: 1920, rawHeight: 859, width: 1280, height: frame.height })
})

test('D2 geometry changing during capture returns resized and the next capture recovers', async t => {
  const f = await fixture(); t.after(() => f.runtime.pause(true))
  const capture = f.driver.getWindowState
  f.driver.getWindowState = async args => { const value = await capture(args); f.resize(); return value }
  await assert.rejects(f.runtime.capture(), { reason: 'resized', nextTool: 'desktop_get_screenshot' })
  f.driver.getWindowState = capture
  assert.equal((await f.runtime.capture()).windowId, f.window.id)
})

test('D2 stopping during restore drains it and cannot resurrect target authorization', async () => {
  const f = await fixture()
  f.identity.window = () => { throw new NativeWindowError('minimized', 'minimized') }
  f.identity.restoreWindow = () => {}
  const restoring = f.runtime.restore(f.window.id, f.window.pid, f.epoch)
  const rejected = assert.rejects(restoring, /撤销/)
  const stopped = await f.runtime.pause(true)
  await rejected
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.window, null)
})

test('D2 window reasons survive the strict worker wire format independently', () => {
  for (const reason of ['minimized', 'hidden', 'resized', 'exited', 'identity-changed'] as const) {
    const error = new NativeWindowError(reason, 'window failure')
    const reply = nativeReplySchema.parse({ version: 1, id: randomUUID(), ok: false, value: null, error: error.message, details: windowFailure(error) })
    assert.equal(reply.details?.reason, reason)
    assert.equal(reply.details?.nextTool, ['minimized', 'hidden'].includes(reason) ? 'desktop_restore_window' : reason === 'resized' ? 'desktop_get_screenshot' : 'desktop_get_windows')
  }
})

test('D2 child restore checks PID/session before and after worker restoration', async () => {
  const target = { id: randomUUID(), pid: 42, title: 'Fixture', app: 'Fixture', x: 0, y: 0, width: 1920, height: 859 }
  const state: DesktopRuntimeState = {
    backend: 'windows-attended', isolated: false, status: 'enabled', epoch: 2, window: target,
    foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
    capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
  }
  let active = true, restores = 0, revokeAfter = false, pendingPid: number | undefined
  const dispatch = createChildDispatcher({
    assertSession() { if (!active) throw new Error('disconnected') }, assertPid(pid) { assert.equal(pid, 42) },
  }, async method => {
    if (method === 'windows') return [target]
    if (method === 'restore') {
      restores++
      if (revokeAfter) active = false
      return pendingPid === undefined
        ? {...state,state:'restored',verified:true,nextTool:'desktop_get_screenshot'}
        : {state:'restoring',retryAfterMs:200,nextTool:'desktop_get_screenshot',pid:pendingPid,windowId:target.id,epoch:2}
    }
    return state
  })
  const send = (method: string, payload: unknown) => dispatch(nativeRequestSchema.parse({ version: 1, id: randomUUID(), method, payload }), new AbortController().signal)
  await send('windows', null); await send('select', { windowId: target.id, foreground: false })
  await assert.rejects(send('restore', { windowId: target.id, pid: 43, expectedEpoch: 2 }), /不一致/)
  assert.equal(restores, 0)
  await send('restore', { windowId: target.id, pid: 42, expectedEpoch: 2 }); assert.equal(restores, 1)
  pendingPid = 43
  await assert.rejects(send('restore', { windowId: target.id, pid: 42, expectedEpoch: 2 }), /恢复窗口身份/)
  pendingPid = 42
  const pending=await send('restore', { windowId: target.id, pid: 42, expectedEpoch: 2 })
  assert.equal((pending as {state:string}).state,'restoring')
  assert.ok(!Object.hasOwn(pending as object,'window'))
  revokeAfter = true
  await assert.rejects(send('restore', { windowId: target.id, pid: 42, expectedEpoch: 2 }), /disconnected/)
})

test('D2 Win32 window preflight distinguishes exited, replaced, minimized, hidden and invalid bounds', () => {
  for (const reason of ['exited', 'identity-changed', 'minimized', 'hidden', 'resized'] as const) {
    const identity: WindowsIdentity = Object.create(WindowsIdentity.prototype)
    Object.assign(identity, {
      dpiContext: () => 0,
      exists: () => reason !== 'exited',
      owner: (_hwnd: bigint, pid: number[]) => { pid[0] = reason === 'identity-changed' ? 43 : 42; return 1 },
      minimized: () => reason === 'minimized', visible: () => reason !== 'hidden',
      bounds: (_hwnd: bigint, rect: number[]) => { rect.splice(0, 4, 0, 0, reason === 'resized' ? 0 : 1920, 859); return 1 },
      foreground: () => 1n,
    })
    assert.throws(() => identity.window('1', 42), { reason })
    if (reason === 'exited' || reason === 'identity-changed') assert.throws(() => identity.windowShellInfo('1', 42), { reason })
  }
})

test('N1 rejects the minimized sentinel even when the first IsIconic sample is false', () => {
  const identity: WindowsIdentity = Object.create(WindowsIdentity.prototype)
  Object.assign(identity,{
    dpiContext:()=>0,exists:()=>true,owner:(_hwnd:bigint,pid:number[])=>{pid[0]=42;return 1},
    minimized:()=>false,visible:()=>true,
    bounds:(_hwnd:bigint,rect:number[])=>{rect.splice(0,4,-32000,-32000,-31871,-31972);return 1},
    foreground:()=>1n,
  })
  assert.throws(()=>identity.window('1',42),{reason:'minimized'})
})

test('N1 uses verified compositor geometry within the virtual screen and rejects out-of-screen bounds', () => {
  const identity: WindowsIdentity = Object.create(WindowsIdentity.prototype)
  let frame = [-1920,0,0,1080]
  Object.assign(identity, {
    dpiContext:()=>-4n,exists:()=>true,owner:(_hwnd:bigint,pid:number[])=>{pid[0]=42;return 1},
    visible:()=>true,minimized:()=>false,foreground:()=>1n,
    bounds:(_hwnd:bigint,rect:number[])=>{rect.splice(0,4,-1928,-8,8,1088);return 1},
    extendedBounds:(_hwnd:bigint,_attr:number,rect:number[])=>{rect.splice(0,4,...frame);return 0},
    systemMetric:(index:number)=>({76:-1920,77:0,78:3840,79:1080})[index],
  })
  const verified=identity.restoredWindow('1',42)
  assert.equal(verified.rect.x,-1928)
  assert.deepEqual(verified.bounds,{x:-1920,y:0,width:1920,height:1080})
  frame=[-1922,0,0,1080]
  assert.throws(()=>identity.restoredWindow('1',42),{reason:'resized'})
})

test('N1 waits for real restored geometry before declaring success',async t=>{
  const f=await fixture();t.after(()=>f.runtime.pause(true))
  const actual=f.identity.window.bind(f.identity),prior=await f.runtime.capture()
  let polls=0
  f.identity.window=(id,pid)=>++polls===1
    ? {x:-32000,y:-32000,width:129,height:28,foreground:'1'}
    : actual(id,pid)
  f.identity.restoredWindow=(id,pid)=>{
    const rect=f.identity.window(id,pid)
    if(rect.x===-32000)throw new NativeWindowError('minimized','fixture sentinel')
    return {rect,bounds:{x:27,y:30,width:1906,height:852}}
  }
  const receipt=await f.runtime.restore(f.window.id,f.window.pid,f.epoch)
  assert.equal(receipt.state,'restored')
  const publicReceipt=restoreWindowResultSchema.parse({...receipt,connectionId:randomUUID()})
  assert.equal(publicReceipt.state,'restored')
  assert.equal(receipt.verified,true)
  assert.equal(receipt.window?.x,27)
  assert.equal(receipt.window?.width,1906)
  assert.equal(f.restores(),1)
  assert.ok(polls>=2)
  await assert.rejects(f.runtime.execute({operationId:randomUUID(),frameId:prior.id,epoch:prior.epoch,delivery:'background',action:{type:'click',x:100,y:100}}))
  assert.equal(f.inputs(),0)
})

test('N1 slow minimize restore returns pending without geometry, then a fresh capture can recover',async t=>{
  const f=await fixture();t.after(()=>f.runtime.pause(true))
  const old=await f.runtime.capture(),available=f.identity.window.bind(f.identity)
  f.identity.restoreWindow=()=>{}
  f.identity.window=()=>{throw new NativeWindowError('minimized','fixture still iconic')}
  const started=performance.now()
  const receipt=await f.runtime.restore(f.window.id,f.window.pid,f.epoch)
  const {epoch,windowId,pid,...publicReceipt}=receipt
  assert.equal(epoch,f.epoch);assert.equal(windowId,f.window.id);assert.equal(pid,f.window.pid)
  assert.deepEqual(publicReceipt,{state:'restoring',retryAfterMs:200,nextTool:'desktop_get_screenshot'})
  assert.ok(!restoreWindowResultSchema.safeParse({...publicReceipt,window:f.window}).success)
  assert.ok(performance.now()-started>=1400)
  await assert.rejects(f.runtime.execute({operationId:randomUUID(),frameId:old.id,epoch:old.epoch,delivery:'background',action:{type:'click',x:100,y:100}}))
  f.identity.window=available
  f.resize()
  const fresh=await f.runtime.capture()
  assert.match(fresh.notice??'',/重绑/)
  assert.equal(f.inputs(),0)
})

test('N1 Host keeps pending restore geometry private and rejects a revoked scope',async ()=>{
  const target={id:randomUUID(),pid:42,title:'Fixture',app:'Fixture',x:20,y:30,width:640,height:480}
  const connectionId=randomUUID(),epoch=2
  const native=new NativeSession({timeoutMs:5000,frameAgeMs:30000,maxDimension:1280,imageBytes:512000})
  const state={...await native.status(AbortSignal.timeout(1000)),status:'enabled',connectionId,epoch,window:target}
  let revokeAfter=false
  const call=async (method:string,payload:unknown)=>{
    assert.equal(method,'restore')
    assert.deepEqual(payload,{windowId:target.id,pid:42,expectedEpoch:epoch})
    if(revokeAfter)Object.assign(native,{state:{...state,status:'paused',epoch:epoch+1}})
    return {state:'restoring',retryAfterMs:200,nextTool:'desktop_get_screenshot',windowId:target.id,pid:42,epoch}
  }
  Object.assign(native,{state,client:{call},connectionId})
  const restore=()=>native.restore(target.id,42,connectionId,epoch,AbortSignal.timeout(1000))
  assert.deepEqual(await restore(),{state:'restoring',retryAfterMs:200,nextTool:'desktop_get_screenshot'})
  revokeAfter=true
  await assert.rejects(restore(),{reason:'identity-changed'})
})
