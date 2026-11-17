// Opt-in Windows acceptance for a fixed application in a fresh child session.
// node tests/caption-evidence.live.mjs --allow-owned-vmware
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {cp,mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const optIn='--allow-owned-vmware'
const workerFlag='--probe-worker'
if(!process.argv.includes(optIn))throw new Error('Pass --allow-owned-vmware to open, minimize, and restore the test-owned VMware window')
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This live probe requires Windows x64')

if(!process.argv.includes(workerFlag)){
  const {build}=await import('esbuild')
  const output=resolve('artifacts/b3-live')
  await mkdir(output,{recursive:true})
  await cp('lib/child-session-host',join(output,'child-session-host'),{recursive:true})
  await build({
    entryPoints:{
      probe:fileURLToPath(import.meta.url),
      'child-session-bridge':'src/child-session-bridge.ts',
      'native-worker':'src/native-worker.ts',
    },
    outdir:output,bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',sourcemap:false,
  })
  const run=spawnSync(process.execPath,[join(output,'probe.js'),optIn,workerFlag],{stdio:'inherit',windowsHide:true})
  if(run.error)throw run.error
  process.exitCode=run.status??1
}else{
  await probe()
}

async function probe(){
  const {default:koffi}=await import('koffi')
  const {NativeSession}=await import('../src/native-session.ts')
  const {ApplicationLifecycle}=await import('../src/application-lifecycle.ts')
  const {decodeChildAssociation}=await import('../scripts/eval-contract.mjs')
  const {redactDiagnostics}=await import('../src/redaction.ts')
  const wts=koffi.load('wtsapi32.dll'),kernel=koffi.load('kernel32.dll')
  const query=wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
  const lastError=kernel.func('uint32_t __stdcall GetLastError()')
  const clearError=kernel.func('void __stdcall SetLastError(uint32_t error)')
  const associated=()=>{
    const id=[0xffffffff]
    clearError(0)
    const ok=query(id)
    const error=lastError()
    return decodeChildAssociation(ok,id[0],error)
  }
  const signal=()=>AbortSignal.timeout(90000)
  const output=resolve('evidence/b3')
  await mkdir(output,{recursive:true})
  const report={startedAt:new Date().toISOString(),passed:false,clicks:[]}
  let native
  let stage='prove there is no existing child association'
  try{
    assert.equal(associated(),null,'Existing child association: refusing to open the probe')
    native=new NativeSession({
      timeoutMs:20000,frameAgeMs:60000,maxDimension:1280,imageBytes:512000,
      visualCandidates:{enabled:false},
    })
    stage='open VMware Workstation in the probe-owned child session'
    const application=new ApplicationLifecycle(native)
    const opened=await application.open({appId:'vmware-workstation',operationId:randomUUID()},async()=>{},signal())
    assert.equal(opened.status,'ready',opened.message)
    const {id:windowId,pid}=opened.window
    let state=await native.status(signal())
    const {connectionId,childSessionId,parentSessionId}=state
    assert.ok(connectionId)
    assert.ok(childSessionId)
    assert.equal(childSessionId,associated())
    assert.notEqual(childSessionId,parentSessionId)
    assert.equal(state.backend,'windows-child-session')
    assert.equal(state.isolated,true)
    assert.equal(state.foregroundAllowed,false)
    assert.equal(state.window?.id,windowId)
    assert.equal(state.window?.pid,pid)
    report.window={windowId,pid,connectionId,childSessionId,parentSessionId}
    const chosenPoints={
      center:({x,y,width,height})=>({x:x+width/2,y:y+height/2}),
      'top-left':({x,y})=>({x,y}),
      'bottom-right':({x,y,width,height})=>({x:x+width-1,y:y+height-1}),
    }
    for(const [position,selectPoint] of Object.entries(chosenPoints)){
      stage=`capture fresh caption bbox for ${position}`
      const frame=await native.capture('window',undefined,signal())
      assert.equal(frame.windowId,windowId)
      assert.equal(frame.privacy?.status,'clear')
      assert.ok(report.clicks.every(step=>step.frameId!==frame.id))
      const matches=frame.accessibility?.suggestedTargets?.filter(target=>
        target.basis==='uia-bounds'&&target.controlType==='Button'&&/^(最小化|Minimi[sz]e)$/iu.test(target.name))??[]
      assert.equal(matches.length,1,'The frame must identify exactly one UIA caption minimize button')
      const {bbox}=matches[0]
      assert.ok(bbox.width>2&&bbox.height>2)
      const point=selectPoint(bbox)
      const step={position,bbox,point,frameId:frame.id,epoch:frame.epoch}
      report.clicks.push(step)
      stage=`verify physical hit and system command for ${position}`
      const receipt=await native.execute({
        operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action:{type:'click',...point},
      },signal())
      const {operationId,outcome,message,sourcePoint,effectivePoint,effectivePointSpace,hitTest,delivery,postAction}=receipt
      step.receipt={operationId,outcome,message,sourcePoint,effectivePoint,effectivePointSpace,hitTest,delivery,postAction}
      assert.equal(outcome,'delivered',message)
      assert.equal(hitTest?.class,'HTMINBUTTON')
      assert.equal(hitTest.code,8)
      assert.equal(hitTest.windowRelative,true)
      assert.equal(effectivePointSpace,'physical-screen-pixels')
      assert.deepEqual(effectivePoint,hitTest.screenPoint)
      assert.deepEqual(hitTest.point,{
        x:effectivePoint.x-hitTest.windowOrigin.x,
        y:effectivePoint.y-hitTest.windowOrigin.y,
      })
      assert.deepEqual(delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
      assert.deepEqual(postAction,{reason:'minimized',nextTool:'desktop_restore_window'})
      stage=`restore the same PID and window after ${position}`
      const minimized=await native.status(signal())
      state=await native.restore(windowId,pid,connectionId,minimized.epoch,signal())
      assert.equal(state.window?.id,windowId)
      assert.equal(state.window?.pid,pid)
      assert.equal(state.connectionId,connectionId)
      assert.equal(state.childSessionId,childSessionId)
      assert.ok(state.epoch>=frame.epoch)
      step.restoredEpoch=state.epoch
      await assert.rejects(native.execute({
        operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action:{type:'click',...point},
      },signal()),/输入许可未开启|截图已过期/)
      step.oldFrameRejected=true
    }
    assert.equal(new Set(report.clicks.map(step=>JSON.stringify(step.receipt.hitTest.screenPoint))).size,3)
    report.passed=true
  }catch(error){
    report.error={stage,message:String(error?.message??error)}
    process.exitCode=1
  }finally{
    if(native){
      try{
        const reset=await native.resetChildSession(signal())
        report.cleanup={status:reset.status,association:associated()}
        assert.equal(reset.status,'stopped')
        assert.equal(report.cleanup.association,null)
      }catch(error){
        report.cleanup={...report.cleanup,error:String(error?.message??error)}
        report.passed=false
        process.exitCode=1
      }
    }
    report.completedAt=new Date().toISOString()
    const path=join(output,'live.json')
    await writeFile(path,JSON.stringify(redactDiagnostics(report),null,2)+'\n')
    console.log(JSON.stringify(redactDiagnostics({path,passed:report.passed,clicks:report.clicks.length,error:report.error,cleanup:report.cleanup})))
  }
}
