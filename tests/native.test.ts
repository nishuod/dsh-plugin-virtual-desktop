import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {NativeRuntime,type DriverPort,type IdentityPort} from '../src/native-runtime.ts'
import {frameSchema,imagePoint,nativeRequestSchema,operationSchema,runtimeStateSchema} from '../src/native-contract.ts'
import {BackgroundScrollRefused,type WindowsBackgroundScroller} from '../src/background-scroll.ts'
import type { PrivacyScanner } from '../src/privacy.ts'

async function fixture(scroller?: Pick<WindowsBackgroundScroller,'scroll'>, childSession = scroller !== undefined, scanner:PrivacyScanner=async()=>({complete:true,passwordRegions:[]})){
  const png=await sharp({create:{width:900,height:600,channels:3,background:'#b4c1f6'}}).png().toBuffer()
  let rect={x:-900,y:100,width:900,height:600,foreground:'1'}
  let birth='process-1';let calls=0;let closed=0;let released=0
  const driver:DriverPort={
    listWindows:async()=>({windows:[{windowId:1n,pid:42,appName:'Fixture',title:'Fixture',bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},isOnScreen:true}]}),
    getWindowState:async()=>({pid:42,windowId:1n,screenshotFrameValid:true,images:[{mimeType:'image/png',dataBase64:png.toString('base64')}],treeMarkdown:'fixture'}),
    getDesktopState:async()=>({isError:false,text:'',rawJson:'{}',images:[{mimeType:'image/png',dataBase64:png.toString('base64')}],degraded:false}),
    callTool:async()=>{calls++;return {isError:false,text:'delivered',rawJson:'{}',images:[],degraded:false}},
    shutdown:async()=>{closed++},
  }
  const identity:IdentityPort={assertInteractive(){},process:()=>({birth,image:'fixture.exe'}),window:()=>({...rect}),windowShellInfo:()=>({shellDesktop:false,className:'Fixture'}),rawTopLevelCount:()=>null,acquireLease:()=>()=>{released++},movePointer:()=>{calls++}}
  const runtime=new NativeRuntime({frameAgeMs:60000,maxDimension:600,imageBytes:100000},identity,()=>driver,scroller,childSession,undefined,scanner)
  async function ready(){await runtime.enable();const [window]=await runtime.listWindows();await runtime.select(window.id,!childSession);return await runtime.capture()}
  return {runtime,driver,identity,ready,setRect:(value:Partial<typeof rect>)=>{rect={...rect,...value}},setBirth:(value:string)=>{birth=value},calls:()=>calls,closed:()=>closed,released:()=>released}
}
function op(frame:{id:string;epoch:number}){return {operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action:{type:'click',x:100,y:100}}}
test('named UIA click records resolution and post-action state, and consumes the frame once',async t=>{
  const target={name:'Save',controlType:'Button',enabled:true,bounds:{x:-849,y:151,width:100,height:50}}
  const f=await fixture(undefined,false,async()=>({complete:true,passwordRegions:[],targets:[target]}));t.after(()=>f.runtime.pause(true))
  const frame=await f.ready();assert.equal(frame.accessibility?.suggestedTargets?.[0].name,'Save')
  const original=f.driver.callTool
  f.driver.callTool=async(...args)=>{const result=await original(...args);const previous=f.driver.getWindowState;f.driver.getWindowState=async input=>({...await previous(input),treeMarkdown:'Saved'});return result}
  const operation={...op(frame),action:{type:'click',x:0,y:0,target:{name:'Save',controlType:'Button'}}}
  const receipt=await f.runtime.execute(operation)
  assert.equal(receipt.outcome,'delivered');assert.equal(f.calls(),1)
  assert.equal(receipt.evidence?.[0].result,'unique target');assert.match(receipt.evidence?.[1].result??'',/uiaChanged=true/)
  await assert.rejects(f.runtime.execute({...operation,operationId:randomUUID()}),/截图/);assert.equal(f.calls(),1)
})
test('ambiguous, changed and missing UIA targets never silently fall back',async t=>{
  for(const mode of ['ambiguous','changed','missing']){
    let scans=0
    const target={name:'Save',controlType:'Button',enabled:true,bounds:{x:-849,y:151,width:100,height:50}}
    const f=await fixture(undefined,false,async()=>({complete:true,passwordRegions:[],targets:mode==='missing'?[]:mode==='ambiguous'?[target,{...target,bounds:{...target.bounds,x:-699}}]:[{...target,bounds:{...target.bounds,x:++scans>2?-699:-849}}]}));t.after(()=>f.runtime.pause(true))
    const frame=await f.ready()
    const receipt=await f.runtime.execute({...op(frame),action:{type:'click',x:100,y:100,target:{name:'Save'}}})
    assert.equal(receipt.outcome,'refused',mode);assert.equal(f.calls(),0,mode)
  }
})
test('explicit coordinate fallback is evidenced after failed UIA lookup',async t=>{
  const f=await fixture();t.after(()=>f.runtime.pause(true));const frame=await f.ready()
  const receipt=await f.runtime.execute({...op(frame),action:{type:'click',x:100,y:100,target:{name:'Missing',allowCoordinateFallback:true}}})
  assert.equal(receipt.outcome,'delivered');assert.deepEqual(receipt.evidence?.slice(0,2).map(e=>e.channel),['uia','coordinates'])
})
test('native capture measures visual content on request and omits the result for ordinary frames', async t => {
  const f = await fixture()
  t.after(() => f.runtime.pause(true))
  assert.equal((await f.ready()).visualContent, undefined)
  assert.equal((await f.runtime.capture('window', undefined, undefined, true)).visualContent, false)

  const pattern = Buffer.alloc(900 * 600 * 3)
  pattern.fill(255, pattern.length / 2)
  const png = await sharp(pattern, { raw: { width: 900, height: 600, channels: 3 } }).png().toBuffer()
  f.driver.getWindowState = async () => ({
    pid: 42, windowId: 1n, screenshotFrameValid: true,
    images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }], treeMarkdown: 'fixture',
  })
  assert.equal((await f.runtime.capture('window', undefined, undefined, true)).visualContent, true)
})

test('window frames report UIA limits from SDK evidence without generating targets', async t => {
  const f = await fixture()
  t.after(() => f.runtime.pause(true))
  const captured = await f.driver.getWindowState({ pid: 42, windowId: 1n })
  const tree = '- [0] Button "Named"\n- [1] Button\n- [2] Button\n- [3] Edit'
  f.driver.getWindowState = async () => ({
    ...captured, treeMarkdown: tree, elementsComplete: true, elements: [
      { role: 'Button', label: 'Named', elementIndex: 0n, depth: 0 },
      { role: 'Button', elementIndex: 1n, depth: 0 },
      { role: 'button', label: '  ', elementIndex: 2n, depth: 0 },
      { role: 'Edit', elementIndex: 3n, depth: 0 },
    ],
  })
  const frame = frameSchema.parse(await f.ready())
  assert.equal(frame.tree, tree)
  assert.deepEqual(frame.accessibility, {
    status: 'limited', scope: 'window', unnamedButtons: 2, treeTruncated: false,
    guidance: 'UIA 只覆盖应用公开的控件。缺少控件或名称时，用当前截图核对目标，无法从图像确认时停止输入。',
  })

  f.driver.getWindowState = async () => ({ ...captured, treeMarkdown: undefined })
  const empty = await f.runtime.capture()
  assert.equal(empty.accessibility?.status, 'unavailable')
  assert.equal(empty.accessibility?.unnamedButtons, undefined)

  f.driver.getWindowState = async () => ({ ...captured, truncated: true })
  const sdkTruncated = await f.runtime.capture()
  assert.equal(sdkTruncated.accessibility?.status, 'limited')
  assert.equal(sdkTruncated.accessibility?.treeTruncated, true)

  f.driver.getWindowState = async () => ({ ...captured, treeMarkdown: 'a'.repeat(12001) })
  const clipped = await f.runtime.capture()
  assert.equal(clipped.tree.length, 12000)
  assert.equal(clipped.accessibility?.treeTruncated, true)

  assert.equal((await f.runtime.capture('desktop')).accessibility, undefined)
})
test('crop/resize inverse mapping supports 100%, 150%, 200% and negative origins',()=>{
  for(const scale of [1,1.5,2])assert.deepEqual(imagePoint(30,20,{width:300,height:200},{x:-200,y:40,width:300*scale,height:200*scale}),{x:-200+30*scale,y:40+20*scale})
  for(const [x,y]of [[-1,0],[300,0],[0,200],[Infinity,1]])assert.throws(()=>imagePoint(x,y,{width:300,height:200},{x:0,y:0,width:600,height:400}))
})
test('native access starts disabled and a model JSON boolean cannot authorize it',async()=>{
  const f=await fixture();await assert.rejects(f.runtime.listWindows());await assert.rejects(f.runtime.capture())
  await assert.rejects(f.runtime.execute({...op({id:randomUUID(),epoch:1}),approved:true}))
  assert.equal(f.calls(),0)
})
test('only a server-discovered opaque window can be selected',async()=>{
  const f=await fixture();await f.runtime.enable();await assert.rejects(f.runtime.select('42',true));assert.equal(f.calls(),0)
})
test('only PiP discovery filters the shell desktop and Windows shell surfaces', async t => {
  const candidates = [
    { title: 'Shell desktop', image: 'explorer.exe', className: 'CabinetWClass', shellDesktop: true },
    { title: 'Desktop host', image: 'explorer.exe', className: 'Progman', shellDesktop: false },
    { title: 'Worker', image: 'explorer.exe', className: 'WorkerW', shellDesktop: false },
    { title: 'Taskbar', image: 'explorer.exe', className: 'Shell_TrayWnd', shellDesktop: false },
    { title: 'Secondary taskbar', image: 'explorer.exe', className: 'Shell_SecondaryTrayWnd', shellDesktop: false },
    { title: 'Start', image: 'StartMenuExperienceHost.exe', className: 'CoreWindow', shellDesktop: false },
    { title: 'Search', image: 'SearchHost.exe', className: 'CoreWindow', shellDesktop: false },
    { title: 'Text input', image: 'TextInputHost.exe', className: 'CoreWindow', shellDesktop: false },
    { title: 'Downloads', image: 'explorer.exe', className: 'CabinetWClass', shellDesktop: false },
    { title: 'Program Manager', image: 'fixture.exe', className: 'Fixture', shellDesktop: false },
  ]
  for (const childSession of [true, false]) {
    const f = await fixture(undefined, childSession)
    t.after(() => f.runtime.pause(true))
    const { windows: [base] } = await f.driver.listWindows({})
    f.driver.listWindows = async () => ({ windows: candidates.map(({ title }, index) => ({
      ...base, title, windowId: BigInt(index + 1), pid: 100 + index,
    })) })
    f.identity.process = pid => ({ birth: `process-${pid}`, image: candidates[pid - 100].image })
    f.identity.windowShellInfo = id => candidates[Number(id) - 1]
    assert.match((await f.runtime.enable()).lastResult, childSession ? /画中画子会话/ : /本机观察/)
    const listed = await f.runtime.listWindows()
    assert.deepEqual(listed.map(window => window.title),
      childSession ? ['Downloads', 'Program Manager'] : candidates.map(candidate => candidate.title))
    assert.equal(f.runtime.snapshot().windowDiscovery?.filtered.systemSurface, childSession ? 8 : undefined)
    if(childSession){
      const details=f.runtime.snapshot().windowDiscovery!.systemSurfaces!
      assert.equal(details.length,8)
      assert.equal(details[0].reason,'shell-desktop:GetShellWindow')
      assert.equal(details[1].reason,'explorer-class:Progman')
      assert.equal(details[5].reason,'shell-process:startmenuexperiencehost.exe')
      assert.ok(details.every(detail=>detail.pid>0&&!('hwnd' in detail)))
    }
    const selected = await f.runtime.select(listed.at(-1)!.id, false)
    assert.match(selected.lastResult, childSession ? /画中画应用窗口/ : /本机窗口/)
  }
})
test('PiP discovery reports aggregate filter reasons without changing window arrays', async t => {
  const f = await fixture(undefined, true)
  t.after(() => f.runtime.pause(true))
  const { windows: [base] } = await f.driver.listWindows({})
  f.driver.listWindows = async options => {
    assert.deepEqual(options, { onScreenOnly: true })
    return { windows: [
      base,
      { ...base, pid: 0, minimized: true },
      { ...base, minimized: true },
      { ...base, bounds: { ...base.bounds, width: 1 } },
      { ...base, pid: 43, title: 'private blocked title' },
      { ...base, pid: 44 },
      { ...base, pid: 45 },
      ...Array<typeof base>(144).fill({ ...base, pid: 0 }),
    ] }
  }
  f.identity.process = pid => {
    if (pid === 44) throw new Error('private process details')
    return { birth: `process-${pid}`, image: pid === 43 ? 'consent.exe' : 'fixture.exe' }
  }
  f.identity.windowShellInfo = (_id, pid) => {
    if (pid === 45) throw new Error('private HWND details')
    return { shellDesktop: false, className: 'Fixture' }
  }
  f.identity.rawTopLevelCount = () => 162
  assert.equal((await f.runtime.enable()).windowDiscovery, undefined)
  assert.deepEqual((await f.runtime.listWindows()).map(window => window.title), ['Fixture'])
  const state = runtimeStateSchema.parse(f.runtime.snapshot())
  assert.ok(state.windowDiscovery)
  const { sampledAt, ...counts } = state.windowDiscovery
  assert.ok(sampledAt > 0)
  assert.deepEqual(counts, {
    rawTopLevel: 162, sdkCandidates: 151, workerEligible: 1, systemSurfaces: [],
    filtered: {
      missingPid: 144, minimized: 1, invalidBounds: 1, blockedProcess: 1,
      systemSurface: 0, unverifiedProcess: 1, unverifiedWindow: 1, limit: 1,
    },
  })
  assert.equal(runtimeStateSchema.safeParse({ ...state, connectionId: randomUUID() }).success, false)
  assert.equal(runtimeStateSchema.safeParse({ ...state, windowDiscovery: { ...state.windowDiscovery, title: 'private' } }).success, false)
  assert.equal((await f.runtime.pause(true)).windowDiscovery, undefined)
})

test('raw SDK comparison survives the strict runtime wire schema',async t=>{
  const f=await fixture(undefined,true)
  t.after(()=>f.runtime.pause(true))
  f.identity.rawWindowDiscovery=ids=>{
    assert.deepEqual(ids,['1'])
    return{rawTopLevel:3,sdkSelection:{notCandidate:2,candidateNotInRaw:0,
      observedStates:{notVisible:1,minimized:0,invalidBounds:0,otherOrUnknown:1},note:'Independent samples'}}
  }
  await f.runtime.enable()
  await f.runtime.listWindows()
  const report=runtimeStateSchema.parse(f.runtime.snapshot()).windowDiscovery!
  assert.equal(report.rawTopLevel,3)
  assert.equal(report.sdkSelection?.notCandidate,2)
  assert.equal(report.workerEligible,1)
})
test('PiP rechecks the shell window identity before selection, capture and input', async t => {
  const f = await fixture(undefined, true)
  t.after(() => f.runtime.pause(true))
  let shellDesktop = false
  f.identity.windowShellInfo = () => ({ shellDesktop, className: 'Fixture' })
  await f.runtime.enable()
  const [window] = await f.runtime.listWindows()
  shellDesktop = true
  await assert.rejects(f.runtime.select(window.id, false), /普通应用窗口/)
  assert.equal(f.runtime.snapshot().window, null)
  shellDesktop = false
  await f.runtime.select(window.id, false)
  const frame = await f.runtime.capture()
  shellDesktop = true
  await assert.rejects(f.runtime.capture(), /普通应用窗口/)
  await assert.rejects(f.runtime.execute(op(frame)), /普通应用窗口/)
  assert.equal(f.calls(), 0)
})
test('only the first of two selections approved at the same epoch can bind a window', async t => {
  const f = await fixture()
  t.after(() => f.runtime.pause(true))
  const listWindows = f.driver.listWindows
  f.driver.listWindows = async () => {
    const listed = await listWindows()
    return { ...listed, windows: [...listed.windows, { ...listed.windows[0], windowId: 2n, pid: 43, title: 'Second fixture' }] }
  }
  const { epoch } = await f.runtime.enable()
  const [first, second] = await f.runtime.listWindows()
  const firstSelection = f.runtime.select(first.id, false, epoch)
  const results = await Promise.allSettled([firstSelection, f.runtime.select(second.id, true, epoch)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(String(results[1].reason), /授权已变化/)
  const selected = f.runtime.snapshot()
  assert.equal(selected.epoch, epoch + 1)
  assert.equal(selected.window?.id, first.id)
  assert.equal(selected.foregroundAllowed, false)
  const renewed = await f.runtime.select(second.id, false, selected.epoch)
  assert.equal(renewed.epoch, selected.epoch + 1)
  assert.equal(renewed.window?.id, second.id)
  assert.equal(renewed.foregroundAllowed, false)
})
test('real image compression bounds frames; an action returns a new observation',async()=>{
  const f=await fixture();const frame=await f.ready();assert.equal(frame.width,600);assert.equal(frame.height,400)
  assert.ok(Buffer.from(frame.data,'base64').length<=100000)
  const result=await f.runtime.execute(op(frame));assert.equal(result.outcome,'delivered');assert.notEqual(result.after?.id,frame.id);assert.equal(f.calls(),1)
  await f.runtime.pause(true)
})
test('duplicate operation receipt never dispatches again; altered replay is refused',async()=>{
  const f=await fixture();const frame=await f.ready();const request=op(frame)
  await f.runtime.execute(request);await f.runtime.execute(request);assert.equal(f.calls(),1)
  await assert.rejects(f.runtime.execute({...request,action:{type:'click',x:120,y:100}}),/不同动作/)
  await assert.rejects(f.runtime.execute({...request,operationId:randomUUID()}),/截图已过期/)
  await f.runtime.pause(true)
})
test('replaced frame, wrong epoch, moved window, changed focus and reused PID fail closed',async()=>{
  const f=await fixture();const frame=await f.ready();const next=await f.runtime.capture()
  await assert.rejects(f.runtime.execute(op(frame)),/截图已过期/)
  await assert.rejects(f.runtime.execute({...op(next),epoch:999}),/截图已过期/)
  f.setRect({x:-890});await assert.rejects(f.runtime.execute(op(next)),/窗口位置/)
  f.setRect({x:-900,foreground:'2'});await assert.rejects(f.runtime.execute(op(next)),/焦点/)
  f.setRect({foreground:'1'});f.setBirth('reused-pid');await assert.rejects(f.runtime.execute(op(next)),/进程已更换/)
  assert.equal(f.calls(),0);await f.runtime.pause(true)
})
test('desktop observation cannot grant screen-wide input',async()=>{
  const f=await fixture();await f.ready();const desktop=await f.runtime.capture('desktop')
  await assert.rejects(f.runtime.execute(op(desktop)),/截图已过期/);assert.equal(f.calls(),0);await f.runtime.pause(true)
})
test('out-of-frame action does not call native input',async()=>{
  const f=await fixture();const frame=await f.ready();const result=await f.runtime.execute({...op(frame),action:{type:'click',x:10000,y:0}})
  assert.equal(result.outcome,'refused');assert.equal(f.calls(),0);await f.runtime.pause(true)
})
test('pause closes admission before driver drain; resume needs a new frame',async()=>{
  const f=await fixture();const frame=await f.ready();let release!:()=>void
  f.driver.shutdown=()=>new Promise<void>(resolve=>{release=resolve})
  const pending=f.runtime.pause();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.runtime.snapshot().status,'pausing');await assert.rejects(f.runtime.execute(op(frame)),/输入许可未开启/)
  release();await pending;assert.equal(f.runtime.snapshot().status,'paused');assert.equal(f.released(),1)
  await f.runtime.resume();await assert.rejects(f.runtime.execute(op(frame)),/输入许可未开启/)
  f.driver.shutdown=async()=>{};await f.runtime.pause(true);await assert.rejects(f.runtime.resume(),/只有暂停/)
})
test('paused/cancelled in-flight operation is not replayed',async()=>{
  const f=await fixture();const frame=await f.ready()
  f.driver.callTool=async(_name,_json,opts)=>await new Promise((_resolve,reject)=>opts?.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))
  const request=op(frame);const run=f.runtime.execute(request);await new Promise(resolve=>setImmediate(resolve))
  await f.runtime.pause();assert.equal((await run).outcome,'unknown');assert.equal(f.runtime.snapshot().status,'paused')
  assert.equal((await f.runtime.execute(request)).outcome,'unknown');assert.equal(f.calls(),0)
})
test('wire schemas reject unknown executors, extra consent flags and unbounded holds',()=>{
  assert.equal(nativeRequestSchema.safeParse({version:1,id:randomUUID(),method:'shell',payload:{}}).success,false)
  assert.equal(operationSchema.safeParse({...op({id:randomUUID(),epoch:1}),confirmed:true}).success,false)
  assert.equal(operationSchema.safeParse({...op({id:randomUUID(),epoch:1}),action:{type:'hold',x:0,y:0,durationMs:999999}}).success,false)
})

test('concurrent stop upgrades pause and drains the driver exactly once',async()=>{
  const f=await fixture();await f.ready();let release!:()=>void;let drains=0
  f.driver.shutdown=()=>{drains++;return new Promise<void>(resolve=>{release=resolve})}
  const pause=f.runtime.pause();await new Promise(resolve=>setImmediate(resolve))
  const stop=f.runtime.pause(true);assert.equal(f.runtime.snapshot().status,'stopping')
  release();assert.equal((await pause).status,'stopped');assert.equal((await stop).status,'stopped')
  assert.equal(drains,1);assert.equal(f.released(),1);assert.equal(f.runtime.snapshot().window,null)
})

test('SDK refusal is distinct from partial or uncertain effects',async()=>{
  const f=await fixture();let frame=await f.ready()
  f.driver.callTool=async()=>({isError:true,text:'foreground unavailable',rawJson:'{}',images:[],degraded:false,action:{effect:4,route:2}})
  assert.equal((await f.runtime.execute(op(frame))).outcome,'refused')
  frame=await f.runtime.capture()
  f.driver.callTool=async()=>({isError:false,text:'partial delivery',rawJson:'{}',images:[],degraded:false,action:{effect:1,route:2}})
  assert.equal((await f.runtime.execute(op(frame))).outcome,'unknown');await f.runtime.pause(true)
})

test('child background scroll uses capture geometry and consumes the frame without SDK input',async()=>{
  const sends: unknown[][]=[]
  const f=await fixture({scroll(...args){sends.push(args)}})
  await f.ready()
  // Capture bounds exclude invisible resize borders, and a cropped frame is resized separately.
  const prior=f.driver.getWindowState
  f.driver.getWindowState=async args=>({...await prior(args),windowBounds:{x:-892,y:108,width:884,height:584}})
  const frame=await f.runtime.capture('window',{x:150,y:90,width:450,height:300})
  const request={...op(frame),action:{type:'scroll',x:100,y:100,direction:'down',amount:3}}
  const receipt=await f.runtime.execute(request)
  assert.equal(receipt.outcome,'delivered')
  assert.notEqual(receipt.after?.id,frame.id)
  assert.deepEqual(sends,[['1',42,Math.round(-892+250*884/900),Math.round(108+190*584/600),'down',3]])
  assert.equal(f.calls(),0)
  await f.runtime.execute(request)
  assert.equal(sends.length,1)
  await f.runtime.pause(true)
})

test('background scroll refusal and timeout never fall back or replay',async()=>{
  for(const [error,outcome] of [[new BackgroundScrollRefused('wrong target'),'refused'],[new Error('timeout'),'unknown']] as const){
    let attempts=0
    const f=await fixture({scroll(){attempts++;throw error}})
    const frame=await f.ready()
    const request={...op(frame),action:{type:'scroll',x:100,y:100,direction:'down',amount:3}}
    assert.equal((await f.runtime.execute(request)).outcome,outcome)
    assert.equal((await f.runtime.execute(request)).outcome,outcome)
    assert.equal(attempts,1)
    assert.equal(f.calls(),0)
    await f.runtime.pause(true)
  }
})
