// Opt-in local desktop latency benchmark. No model/API requests are made.
// Bundle beside child-session-bridge.js, native-worker.js and child-session-host/.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import koffi from 'koffi'
import { NativeSession } from '../src/native-session.ts'
import { ApplicationLifecycle } from '../src/application-lifecycle.ts'

if(process.argv[2]!=='--run-owned-test')throw new Error('Pass --run-owned-test explicitly')
const fixture=resolve(process.argv[3]),output=resolve(process.argv[4]??'evidence/rc1-desktop-benchmark.json')
assert.ok(fixture.endsWith('dsh-desktop-fixture.exe'),'Only the controlled test fixture is supported')
const wts=koffi.load('wtsapi32.dll'),childId=wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
const associated=()=>{const id=[0];return childId(id)&&id[0]!==0xffffffff?id[0]:null}
assert.equal(associated(),null,'Existing Windows child association: test refuses to change it')
const evidence={date:new Date().toISOString(),kind:'real-local-desktop-no-model',passed:false,profiles:[],errors:[]}
const signal=()=>AbortSignal.timeout(90000)
const hash=frame=>createHash('sha256').update(frame.data).digest('hex')
let native
try{
  for(const maxDimension of [1280,640]){
    native=new NativeSession({timeoutMs:20000,frameAgeMs:60000,maxDimension,imageBytes:512000})
    const opened=await new ApplicationLifecycle(native).open({path:fixture,operationId:randomUUID()},async()=>{},signal())
    assert.equal(opened.status,'ready',opened.message);assert.ok(opened.frame)
    let frame=opened.frame
    const stateFile=join(dirname(fixture),'fixture-state.json')
    let observed=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(observed.pid,opened.pid)
    const profile={maxDimension,childSessionId:opened.childSessionId,pid:opened.pid,steps:[]}
    evidence.profiles.push(profile)
    for(let step=0;step<20;step++){
      const start=performance.now(),beforeTree=frame.tree,beforeHash=hash(frame)
      const receipt=await native.execute({operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',
        action:{type:'click',x:0,y:0,target:{name:'增加计数',controlType:'Button'}}},signal())
      const elapsedMs=performance.now()-start
      assert.equal(receipt.outcome,'delivered',receipt.message);assert.ok(receipt.after)
      const after=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(after.pid,opened.pid);assert.equal(after.clicks,observed.clicks+1)
      frame=receipt.after;observed=after
      const measured={step:step+1,elapsedMs,bytes:Buffer.from(frame.data,'base64').length,width:frame.width,height:frame.height,
        clicks:after.clicks,uiaChanged:beforeTree!==frame.tree,screenshotChanged:beforeHash!==hash(frame),privacy:frame.privacy?.status}
      assert.equal(measured.uiaChanged,true);assert.equal(measured.screenshotChanged,true)
      profile.steps.push(measured);console.log(JSON.stringify({maxDimension,...measured}))
    }
    profile.meanStepMs=profile.steps.reduce((sum,step)=>sum+step.elapsedMs,0)/profile.steps.length
    profile.meanJpegBytes=profile.steps.reduce((sum,step)=>sum+step.bytes,0)/profile.steps.length
    await native.control('stop',signal());await native.resetChildSession(signal());native=undefined
    assert.equal(associated(),null)
  }
  evidence.passed=true
}catch(error){evidence.errors.push(error instanceof Error?error.message:String(error));process.exitCode=1}
finally{
  try{await native?.resetChildSession(signal())}catch(error){evidence.errors.push(`cleanup: ${error.message}`);process.exitCode=1}
  evidence.finalAssociation=associated();await writeFile(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:evidence.passed,errors:evidence.errors,finalAssociation:evidence.finalAssociation}))
}
