// Opt-in owned-session integration. Build beside the packaged bridge/native-worker and host.
// It refuses an existing Windows child association and kills only its own ChildProcess handle.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import koffi from 'koffi'
import { NativeSession } from '../src/native-session.ts'
import { ApplicationLifecycle } from '../src/application-lifecycle.ts'

if(process.argv[2]!=='--run-owned-test')throw new Error('Pass --run-owned-test explicitly')
const iterations=Number(process.argv[3]??20)
if(!Number.isInteger(iterations)||iterations<1||iterations>20)throw new Error('iterations must be 1..20')
const output=resolve(process.argv[4]??'evidence/rc1-recovery-live.json')
const application=process.argv[5]
const wts=koffi.load('wtsapi32.dll')
const childId=wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
const associated=()=>{const id=[0];return childId(id)&&id[0]!==0xffffffff?id[0]:null}
assert.equal(associated(),null,'Existing Windows child association: test refuses to change it')
const native=new NativeSession({timeoutMs:15000,frameAgeMs:60000,maxDimension:1280,imageBytes:512000})
const evidence={date:new Date().toISOString(),passed:false,cycles:[],errors:[]}
const signal=()=>AbortSignal.timeout(90000)
try{
  const initial=await native.enable(signal(),'windows-child-session')
  assert.equal(initial.childSessionId,associated())
  const owned=native['client'],broker=owned['process']
  assert.ok(broker?.pid)
  evidence.orphan={childSessionId:initial.childSessionId,brokerPid:broker.pid}
  broker.kill() // exact child handle created by this test, never a PID/process-name lookup
  await owned['exit']
  evidence.orphan.associationAfterKill=associated()
  const reset=await native.resetChildSession(signal())
  assert.equal(reset.status,'stopped');assert.equal(associated(),null)
  evidence.orphan.resetStatus=reset.status
  if(application){
    const result=await new ApplicationLifecycle(native).open({path:application,operationId:randomUUID()},async()=>{},signal())
    evidence.openApplication={status:result.status,message:result.message,childSessionId:result.childSessionId,
      privacy:result.frame?.privacy,accessibility:result.frame?.accessibility,tree:result.frame?.tree}
    assert.equal(result.status,'ready',result.message)
    // The optional application argument is the dedicated DesktopFixture copy only.
    if(process.argv.includes('--click-fixture')){
      const frame=result.frame;assert.ok(frame)
      const fixtureFile=join(dirname(application),'fixture-state.json')
      const before=JSON.parse(await readFile(fixtureFile,'utf8'));assert.equal(before.pid,result.pid)
      const receipt=await native.execute({operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',
        action:{type:'click',x:0,y:0,target:{name:'增加计数',controlType:'Button'}}},signal())
      const after=JSON.parse(await readFile(fixtureFile,'utf8'));assert.equal(after.pid,result.pid)
      evidence.namedClick={outcome:receipt.outcome,message:receipt.message,evidence:receipt.evidence,beforeClicks:before.clicks,afterClicks:after.clicks,
        uiaChanged:frame.tree!==receipt.after?.tree,screenshotChanged:receipt.after?createHash('sha256').update(frame.data).digest('hex')!==createHash('sha256').update(receipt.after.data).digest('hex'):false}
      assert.equal(receipt.outcome,'delivered');assert.equal(after.clicks,before.clicks+1)
      assert.equal(evidence.namedClick.uiaChanged,true);assert.equal(evidence.namedClick.screenshotChanged,true)
    }
    await native.control('stop',signal())
  }
  for(let cycle=0;cycle<iterations;cycle++){
    const start=Date.now(),opened=await native.enable(signal(),'windows-child-session')
    assert.equal(opened.childSessionId,associated())
    const stopped=await native.control('stop',signal())
    assert.equal(stopped.status,'stopped');assert.equal(associated(),null)
    assert.equal(native['ownedChildren'].size,0)
    const item={cycle:cycle+1,childSessionId:opened.childSessionId,elapsedMs:Date.now()-start}
    evidence.cycles.push(item);console.log(JSON.stringify(item))
  }
  evidence.passed=true
}catch(error){evidence.errors.push(error instanceof Error?error.message:String(error));process.exitCode=1}
finally{
  try{await native.resetChildSession(signal())}catch(error){evidence.errors.push(`cleanup: ${error.message}`);process.exitCode=1}
  evidence.finalAssociation=associated();await writeFile(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}
