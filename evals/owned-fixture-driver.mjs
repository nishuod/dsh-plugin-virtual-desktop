// Explicitly opted-in integration driver. It uses only its copied repository fixture.
// Bundle with scripts/build-eval-driver.mjs; never run against a user's application.
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readFile,realpath,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join,dirname} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import koffi from 'koffi'
import {NativeSession} from '../src/native-session.ts'
import {ChildSessionClient} from '../src/child-session-client.ts'
import {ApplicationLifecycle} from '../src/application-lifecycle.ts'
import {redactDiagnostics} from '../src/redaction.ts'
import {decodeChildAssociation} from '../scripts/eval-contract.mjs'
import { signal, observation, verifyAttachmentFallback, verifyVmwareCase, withTools } from './owned-application-cases.mjs'
import sharp from 'sharp'

let native
const root=dirname(fileURLToPath(import.meta.url))
const fixture=join(root,'fixture','dsh-desktop-fixture.exe')
const stateFile=join(root,'fixture','fixture-state.json')
let associationQuery
let lastError
let clearError
function associated(){
  if(!associationQuery){
    associationQuery=koffi.load('wtsapi32.dll').func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
    const kernel=koffi.load('kernel32.dll')
    lastError=kernel.func('uint32_t __stdcall GetLastError()')
    clearError=kernel.func('void __stdcall SetLastError(uint32_t code)')
  }
  const id=[0]
  clearError(0)
  const success=associationQuery(id),error=lastError()
  return decodeChildAssociation(success,id[0],error)
}
async function fixtureState(pid){
  let last
  for(let attempt=0;attempt<10;attempt++){
    try{const value=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(value.pid,pid);return value}catch(error){last=error;await delay(50)}
  }
  throw last
}
function skipped(reason){return {status:'skipped',reason}}
// Only the known guard for this setup establishes its expected failure. An
// unrelated JS/transport error must fail the scenario instead of becoming proof.
export function scenarioRefusal(id,error){
  const guards={
    'failure-15-minimized':{reason:'minimized',message:'目标窗口已最小化；请调用 desktop_restore_window'},
    'failure-16-resized':{reason:'request-failed',message:'窗口位置或焦点已改变，请重新观察'},
    'failure-18-revoked':{reason:'request-failed',message:'输入许可未开启'},
    'failure-19-reused-frame':{reason:'request-failed',message:'截图已过期、被替换或已用于输入，请重新观察'},
    'failure-20-privacy':{reason:'request-failed',message:'隐私扫描未完成，当前帧不允许输入'},
  }
  const expected=guards[id]
  assert.ok(expected,`No refusal guard defined for ${id}`)
  assert.ok(error instanceof Error&&error.name==='Error',`Unexpected error type for ${id}`)
  assert.equal(error.message,expected.message,`Unexpected refusal message for ${id}`)
  assert.equal(error.reason??'request-failed',expected.reason,`Unexpected refusal reason for ${id}`)
  return {...expected}
}
async function mutateFixture(pid,action){
  assert.ok(['minimize','resize','show-password'].includes(action))
  const token=randomUUID()
  await writeFile(join(root,'fixture','fixture-command.json'),JSON.stringify({pid,token,action}))
  for(let attempt=0;attempt<50;attempt++){
    const state=await fixtureState(pid)
    if(state.commandToken===token)return state
    await delay(100)
  }
  throw new Error(`Owned fixture did not acknowledge ${action}`)
}
async function verifyOrphan(target,progress){
  const owned=native['client'],broker=owned?.['process']
  assert.ok(broker?.pid&&broker.exitCode===null,'Missing live owned broker handle')
  assert.equal(owned['identity']?.childSessionId,target.childSessionId)
  const actualClose=owned.close.bind(owned)
  // Hold only this test instance's automatic teardown long enough to expose the
  // real OS orphan. The actual recovery function runs unmodified in finally.
  let release,rejectRelease
  const held=new Promise((resolve,reject)=>{release=resolve;rejectRelease=reject})
  void held.catch(()=>{})
  owned.close=()=>held
  const probe=new ChildSessionClient(20000,()=>{})
  let refusal,closed=false
  const unhold=async()=>{
    if(closed)return
    closed=true
    owned.close=actualClose
    try{await actualClose();release()}catch(error){rejectRelease(error);throw error}
  }
  try{
    assert.equal(broker.kill(),true,'Owned broker could not be terminated')
    await owned['exit']
    assert.equal(associated(),target.childSessionId,'Orphan association must survive the owned broker exit')
    try{await probe.open(signal())}catch(error){refusal={reason:error.reason,message:error.message,association:error.association}}
    assert.ok(refusal,'New broker must refuse the existing association')
    assert.equal(refusal.reason,'child-session-unavailable')
    // A fresh probe without the original ownership record may classify the
    // association as unknown. The retained broker handle is the orphan proof.
    assert.ok(['unknown','orphan'].includes(refusal.association))
    progress.receipt=refusal
    const associationAfterKill=associated()
    await probe.close()
    const reset=await withTools(native,progress,async(run,_attachment,controller)=>{
      const result=run('desktop_reset_child_session',{operationId:randomUUID()})
      void result.catch(()=>{})
      // Wait for the real tool to capture its owned handle, then let its
      // unmodified recovery complete. This never holds a foreign association.
      try {
        for(let attempt=0;attempt<100&&!controller.resetting;attempt++)await delay(10)
        assert.ok(controller.resetting,'Reset was not admitted before recovery began')
      }finally{await unhold()}
      return await result
    })
    assert.equal(reset.state,'released')
    assert.deepEqual(reset.releasedPids,[broker.pid])
    return {receipt:refusal,reset,brokerPid:broker.pid,associationAfterKill}
  }finally{
    try{await probe.close()}
    finally{await unhold()}
  }
}
export async function cleanup(){
  if(!native)return
  const owned=native
  // Retain the owned handle if cleanup fails, so the runner's final cleanup can retry.
  await owned.resetChildSession(signal())
  native=undefined
  assert.equal(associated(),null,'Owned test did not clear its child association')
}
export async function runScenario(scenario){
  if(!process.argv.includes('--allow-owned-fixture'))throw new Error('Pass --allow-owned-fixture to authorize the copied test executable and its owned Windows child session')
  if(process.platform!=='win32'||process.arch!=='x64')return skipped('Owned live fixture requires Windows x64')
  if(scenario.app==='vmware'&&!process.argv.includes('--allow-owned-vmware'))return skipped('Pass --allow-owned-vmware to opt into the fixed read-only list, minimize/restore and Open dialog in test-owned VMware sessions')
  const progress={stage:'no-child preflight'}
  try{
    await cleanup()
    assert.equal(associated(),null,'Existing child association: refusing to open, adopt or modify it')
    const fixturePath=await realpath(fixture)
    const manifest=JSON.parse(await readFile(join(root,'fixture-manifest.json'),'utf8'))
    assert.equal(createHash('sha256').update(await readFile(fixturePath)).digest('hex'),manifest.sha256,'Fixture binary changed after build')
    const cardReference=join(root,'fixture','vmware-open-card.rgb')
    if(scenario.id==='app-09-visual-card'){
      if(!manifest.cardReferenceSha256)return skipped('Build with --visual-reference and an independently reviewed 1280x808 VMware Home JPEG')
      const cardHash=createHash('sha256').update(await readFile(cardReference)).digest('hex')
      assert.equal(cardHash,manifest.cardReferenceSha256,'Audited card reference changed since build')
    }
    native=new NativeSession({timeoutMs:20000,frameAgeMs:60000,maxDimension:1280,imageBytes:512000})
    if(scenario.app==='vmware'){
      const result=await verifyVmwareCase(scenario.id,native,progress,cardReference)
      assert.equal(result.target.childSessionId,associated())
      return redactDiagnostics(result)
    }
    progress.stage='open and verify the owned fixture'
    const opened=await new ApplicationLifecycle(native).open({path:fixturePath,operationId:randomUUID()},async()=>{},signal())
    progress.receipt={status:opened.status,stage:opened.stage,message:opened.message,pid:opened.pid}
    assert.equal(opened.status,'ready',opened.message);assert.ok(opened.frame)
    const target={pid:opened.pid,childSessionId:opened.childSessionId,connectionId:opened.connectionId}
    progress.target=target
    assert.equal(target.childSessionId,associated())
    let frame=opened.frame
    let state=await fixtureState(target.pid)
    assert.equal(state.text,'');assert.equal(state.clicks,0)
    const point=async(kind)=>{
      const runtime=await native.status(signal()),window=runtime.window
      assert.equal(window.pid,target.pid)
      state=await fixtureState(target.pid)
      const x=state[`${kind}X`],y=state[`${kind}Y`]
      const mapped={x:(x-window.x-1)*frame.width/(window.width-2),y:(y-window.y-1)*frame.height/(window.height-2)}
      assert.ok(mapped.x>=0&&mapped.x<frame.width&&mapped.y>=0&&mapped.y<frame.height)
      return mapped
    }
    const action=async(value)=>{
      progress.stage=`dispatch verified fixture ${value.type}`
      const receipt=await native.execute({operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action:value},signal())
      const {after,...metadata}=receipt
      progress.receipt=metadata
      assert.equal(receipt.outcome,'delivered',receipt.message);assert.ok(receipt.after)
      frame=receipt.after
      return receipt
    }
    const type=async(text)=>action({type:'type',...await point('text'),text})
    const key=async(key,modifiers=[])=>action({type:'key',...await point('text'),key,modifiers})
    if(['basic-03-clear','basic-06-replace'].includes(scenario.id))await type('Fixture initial text')
    if(['basic-04-key','basic-05-enter'].includes(scenario.id))await action({type:'click',...await point('text')})
    let before=observation(frame),beforeState=await fixtureState(target.pid),receipt,assertionPassed=false
    if(['basic-01-click','app-13-generic-ready'].includes(scenario.id)){
      receipt=await action({type:'click',x:0,y:0,target:{name:'增加计数',controlType:'Button'}})
      state=await fixtureState(target.pid);assertionPassed=state.clicks===beforeState.clicks+1
    }else if(scenario.id==='app-14-image-fallback'){
      receipt=await action({type:'click',...await point('button'),target:{name:'Definitely absent fixture target',allowCoordinateFallback:true}})
      state=await fixtureState(target.pid)
      assertionPassed=state.clicks===beforeState.clicks+1&&receipt.evidence?.some(value=>value.channel==='uia'&&value.result==='target not found')&&receipt.evidence?.some(value=>value.channel==='coordinates'&&value.result.includes('fallback'))
    }else if(scenario.id==='basic-02-type'){
      receipt=await type('Fixture safe text');state=await fixtureState(target.pid);assertionPassed=state.text==='Fixture safe text'
    }else if(scenario.id==='basic-03-clear'){
      await key('a',['ctrl']);receipt=await key('backspace');state=await fixtureState(target.pid);assertionPassed=state.text===''
    }else if(scenario.id==='basic-04-key'){
      receipt=await key('esc');state=await fixtureState(target.pid)
      assertionPassed=state.escapes===beforeState.escapes+1&&state.text===beforeState.text
    }else if(scenario.id==='basic-05-enter'){
      receipt=await key('enter');state=await fixtureState(target.pid);assertionPassed=state.enters===beforeState.enters+1&&/\r?\n/.test(state.text)
    }else if(scenario.id==='basic-06-replace'){
      await key('a',['ctrl']);receipt=await type('Fixture replacement');state=await fixtureState(target.pid);assertionPassed=state.text==='Fixture replacement'
    }else if(scenario.id==='basic-07-scroll'){
      receipt=await action({type:'scroll',...await point('scroll'),direction:'down',amount:3})
      state=await fixtureState(target.pid)
      assertionPassed=state.wheels>beforeState.wheels&&state.scrollOffsetY>beforeState.scrollOffsetY&&state.scrollFirstRowY<beforeState.scrollFirstRowY
    }else if(scenario.id==='basic-08-double-click'){
      receipt=await action({type:'click',...await point('target'),button:'left',count:2})
      state=await fixtureState(target.pid);assertionPassed=state.doubles===beforeState.doubles+1
    }else if(scenario.id==='app-10-attachment-fallback'){
      return redactDiagnostics({live:true,target,...await verifyAttachmentFallback(native,progress,before)})
    }else if(scenario.id==='failure-17-orphan'){
      progress.stage='terminate only the owned broker and verify orphan admission'
      const orphan=await verifyOrphan(target,progress)
      // The owner broker is dead and recovery then logged off only its session;
      // no execute call was issued anywhere in this failure scenario.
      assert.equal(orphan.associationAfterKill,target.childSessionId)
      assert.equal(associated(),null)
      return redactDiagnostics({live:true,target,receipt:orphan.receipt,before,inputDelivered:false,
        assertionPassed:true,independent:{before:beforeState,brokerPid:orphan.brokerPid,reset:orphan.reset,
          associationAfterKill:orphan.associationAfterKill,associationAfterRecovery:associated(),executeCalls:0},route:'trusted-native-fixture'})
    }else if(scenario.id==='failure-20-privacy'){
      const attempted=await point('button')
      progress.stage='show the synthetic password in the owned fixture'
      await mutateFixture(target.pid,'show-password')
      const blocked=await native.capture('window',undefined,signal())
      progress.receipt={privacy:blocked.privacy,treeSuppressed:blocked.tree===''}
      assert.equal(blocked.privacy?.status,'blocked')
      assert.ok(blocked.privacy.passwordRegions>=1)
      assert.equal(blocked.tree,'')
      assert.ok(!blocked.accessibility?.suggestedTargets?.length)
      const black=(await sharp(Buffer.from(blocked.data,'base64')).removeAlpha().raw().toBuffer()).every(value=>value===0)
      assert.ok(black,'Blocked screenshot leaked visible pixels')
      progress.stage='attempt input using the blocked frame'
      let denied
      try{await native.execute({operationId:randomUUID(),frameId:blocked.id,epoch:blocked.epoch,delivery:'background',action:{type:'click',...attempted}},signal())}
      catch(error){denied=scenarioRefusal(scenario.id,error)}
      assert.ok(denied,'Expected input refusal for the privacy-blocked frame')
      state=await fixtureState(target.pid)
      assert.equal(state.clicks,beforeState.clicks)
      return redactDiagnostics({live:true,target,receipt:denied,before,after:observation(blocked),inputDelivered:false,
        assertionPassed:true,independent:{privacy:blocked.privacy,allPixelsBlack:black,beforeClicks:beforeState.clicks,afterClicks:state.clicks},route:'trusted-native-fixture'})
    }else{
      const stale=frame
      const stalePoint=await point('button'),setupBefore=beforeState
      if(scenario.id==='failure-19-reused-frame')await action({type:'click',x:0,y:0,target:{name:'增加计数',controlType:'Button'}})
      else if(scenario.id==='failure-15-minimized'){
        state=await mutateFixture(target.pid,'minimize');assert.equal(state.minimized,true)
      }else if(scenario.id==='failure-16-resized'){
        state=await mutateFixture(target.pid,'resize')
        assert.ok(state.windowWidth!==beforeState.windowWidth||state.windowHeight!==beforeState.windowHeight)
      }
      else await native.control('pause',signal())
      before=observation(frame);beforeState=await fixtureState(target.pid)
      let refused
      progress.stage='verify the stale-frame refusal'
      try{
        const result=await native.execute({operationId:randomUUID(),frameId:stale.id,epoch:stale.epoch,delivery:'background',action:{type:'click',...stalePoint}},signal())
        const {after,...metadata}=result
        progress.receipt=metadata
        if(result.outcome==='refused')refused=scenarioRefusal(scenario.id,new Error(result.message))
      }catch(error){
        progress.receipt={reason:error.reason??'request-failed',message:error.message}
        refused=scenarioRefusal(scenario.id,error)
      }
      assert.ok(refused,'Expected old-frame operation to fail before dispatch')
      const afterRuntime=await native.status(signal())
      assert.equal(afterRuntime.connectionId,target.connectionId,'Expected refusal must leave the same live connection')
      assert.equal(afterRuntime.childSessionId,target.childSessionId)
      assert.equal(afterRuntime.status,scenario.id==='failure-18-revoked'?'paused':'enabled')
      state=await fixtureState(target.pid)
      assert.equal(state.clicks,beforeState.clicks);assert.equal(state.text,beforeState.text)
      let rebound
      if(scenario.id==='failure-16-resized'){
        progress.stage='check automatic rebind after resize'
        const fresh=await native.capture('window',undefined,signal())
        assert.notEqual(fresh.id,stale.id)
        assert.equal(fresh.windowId,stale.windowId)
        assert.match(fresh.notice,/自动重绑/u)
        rebound={frameId:fresh.id,windowId:fresh.windowId,width:fresh.width,height:fresh.height,notice:fresh.notice}
      }
      return redactDiagnostics({live:true,target,receipt:refused,before,after:observation(frame),inputDelivered:false,
        assertionPassed:true,independent:{setupBefore,before:beforeState,after:state,attemptedPoint:stalePoint,rebound,
          afterRuntime:{connectionId:afterRuntime.connectionId,childSessionId:afterRuntime.childSessionId,status:afterRuntime.status}},route:'trusted-native-fixture'})
    }
    assert.equal(assertionPassed,true,scenario.expected.assertion)
    const {after,...metadata}=receipt
    return redactDiagnostics({live:true,target,receipt:metadata,before,after:observation(frame),assertionPassed:true,
      independent:{before:beforeState,after:state},route:'trusted-native-fixture'})
  }catch(error){
    throw Object.assign(new Error(redactDiagnostics(error instanceof Error?error.message:String(error))),{evidence:redactDiagnostics(progress)})
  }finally{
    try{await cleanup()}
    catch(error){throw Object.assign(new Error(redactDiagnostics(error instanceof Error?error.message:String(error))),{evidence:redactDiagnostics({...progress,stage:'owned-session cleanup',priorStage:progress.stage})})}
  }
}
