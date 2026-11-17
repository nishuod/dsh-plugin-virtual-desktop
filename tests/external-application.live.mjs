// Opt-in readiness probe for the locally verified application installations.
// No clicks, typing, VM commands, shell arguments, or parent-desktop fallback.
// Run from the source checkout after npm run build:
// node tests/external-application.live.mjs --allow-owned-apps
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, cp, copyFile, readFile, realpath, stat, writeFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {dirname, join, resolve, win32} from 'node:path'
import {fileURLToPath} from 'node:url'

if(!process.argv.includes('--allow-owned-apps'))throw new Error('Pass --allow-owned-apps to open the fixed applications in this probe\'s owned Windows child sessions')
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('External application readiness probe requires Windows x64')

if(!process.argv.includes('--probe-worker')){
  const {build}=await import('esbuild')
  const output=resolve('artifacts/external-probe')
  await mkdir(output,{recursive:true})
  await cp('lib/child-session-host',join(output,'child-session-host'),{recursive:true})
  await build({entryPoints:{probe:fileURLToPath(import.meta.url),'child-session-bridge':'src/child-session-bridge.ts','native-worker':'src/native-worker.ts'},
    outdir:output,outExtension:{'.js':'.mjs'},bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',sourcemap:false})
  await copyFile(join(output,'child-session-bridge.mjs'),join(output,'child-session-bridge.js'))
  await copyFile(join(output,'native-worker.mjs'),join(output,'native-worker.js'))
  const child=spawnSync(process.execPath,[join(output,'probe.mjs'),'--allow-owned-apps','--probe-worker'],{stdio:'inherit',windowsHide:true})
  if(child.error)throw child.error
  process.exitCode=child.status??1
}else{
  const {default:koffi}=await import('koffi')
  const {NativeSession}=await import('../src/native-session.ts')
  const {ApplicationLifecycle}=await import('../src/application-lifecycle.ts')
  const {redactDiagnostics}=await import('../src/redaction.ts')
  const {decodeChildAssociation}=await import('../scripts/eval-contract.mjs')
  const wts=koffi.load('wtsapi32.dll'),kernel=koffi.load('kernel32.dll')
  const query=wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
  const lastError=kernel.func('uint32_t __stdcall GetLastError()')
  const clearError=kernel.func('void __stdcall SetLastError(uint32_t error)')
  const associated=()=>{const id=[0];clearError(0);const success=query(id),error=lastError();return decodeChildAssociation(success,id[0],error)}
  const signal=()=>AbortSignal.timeout(90000)
  const samePath=(left,right)=>typeof left==='string'&&win32.normalize(left).toLowerCase()===win32.normalize(right).toLowerCase()
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
  const errorMetadata=error=>({name:error?.name??'Error',reason:typeof error?.reason==='string'?error.reason:undefined,
    code:typeof error?.code==='string'?error.code:undefined,message:String(error?.message??error).slice(0,1000)})
  const apps=[
    {id:'notepad',path:'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2609.11.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe'},
    {id:'calculator',path:'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2607.0.0_x64__8wekyb3d8bbwe\\CalculatorApp.exe'},
    {id:'vmware',path:'D:\\VMware\\vmware.exe'},
  ]
  const report={timestamp:new Date().toISOString(),kind:'opt-in-external-application-readiness',
    route:'trusted-native-readiness-probe',inputDelivered:false,vmCommandsIssued:false,
    contentPolicy:'No screenshot pixels, UIA text, window titles or target names are exported. Frame hashes and aggregate metadata only.',
    results:[],errors:[]}
  const output=resolve('evidence/rc1-external-applications-live.json')
  const save=async()=>{await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(redactDiagnostics(report),null,2)+'\n')}
  try{
    assert.equal(associated(),null,'Existing Windows child association: refusing to open, adopt or modify it')
    for(const app of apps){
      assert.equal(associated(),null,'A child association remains: no next application will be opened')
      const result={id:app.id,requestedPath:app.path,startedAt:new Date().toISOString(),inputDelivered:false}
      report.results.push(result)
      let native
      try{
        const appPath=await realpath(app.path)
        assert.ok((await stat(appPath)).isFile(),'Fixed application path is not a regular file')
        result.resolvedPath=appPath;result.executableSha256=hash(await readFile(appPath))
        native=new NativeSession({timeoutMs:20000,frameAgeMs:60000,maxDimension:1280,imageBytes:512000})
        const opened=await new ApplicationLifecycle(native).open({path:appPath,operationId:randomUUID()},async()=>{},signal())
        result.status=opened.status;result.stage=opened.stage
        result.connectionId=opened.connectionId;result.childSessionId=opened.childSessionId;result.pid=opened.pid
        // App error messages may contain document titles; keep status/stage, not titles.
        if(opened.status!=='app_error')result.message=opened.message
        const state=await native.status(signal())
        result.runtime={status:state.status,backend:state.backend,isolated:state.isolated,connectionId:state.connectionId,
          epoch:state.epoch,parentSessionId:state.parentSessionId,childSessionId:state.childSessionId,foregroundAllowed:state.foregroundAllowed}
        if(state.childSessionId){
          assert.equal(state.childSessionId,associated(),'Native child ID does not match the actual Windows association')
          assert.equal(state.backend,'windows-child-session');assert.equal(state.isolated,true)
          assert.notEqual(state.childSessionId,state.parentSessionId)
        }
        const window=opened.window
        if(window)result.window={id:window.id,pid:window.pid,imagePath:window.imagePath,windowClass:window.windowClass,
          x:window.x,y:window.y,width:window.width,height:window.height,responsive:window.responsive}
        const frame=opened.frame
        if(frame)result.frame={id:frame.id,epoch:frame.epoch,windowId:frame.windowId,width:frame.width,height:frame.height,
          visualContent:frame.visualContent,screenshotSha256:hash(Buffer.from(frame.data,'base64')),uiaSha256:hash(frame.tree),
          uiaCharacters:frame.tree.length,accessibilityStatus:frame.accessibility?.status,treeTruncated:frame.accessibility?.treeTruncated,
          suggestedTargets:frame.accessibility?.suggestedTargets?.length??0,privacyStatus:frame.privacy?.status,privacyReason:frame.privacy?.reason}
        if(opened.status==='ready'){
          assert.ok(window&&frame,'Ready application has no verified window/frame')
          assert.ok(samePath(window.imagePath,appPath),'Ready window does not belong to the exact configured executable')
          assert.equal(window.pid,opened.pid);assert.equal(state.window?.pid,opened.pid)
          assert.equal(state.window?.id,window.id);assert.equal(frame.windowId,window.id)
          assert.equal(frame.epoch,state.epoch);assert.equal(opened.connectionId,state.connectionId)
          assert.equal(state.status,'enabled');assert.equal(state.foregroundAllowed,false)
          result.identityVerified=true
        }else process.exitCode=1
      }catch(error){result.status='probe-error';result.error=errorMetadata(error);process.exitCode=1}
      finally{
        result.finishedAt=new Date().toISOString()
        // The retained NativeSession owns all cleanup; never find/kill external PIDs.
        // A cleanup/query failure stops the whole sequence before another app opens.
        if(native){
          try{
            const reset=await native.resetChildSession(signal())
            result.cleanup={status:reset.status,association:associated()}
            assert.equal(reset.status,'stopped');assert.equal(result.cleanup.association,null)
          }catch(error){result.cleanup={error:errorMetadata(error)};await save();throw error}
        }
        await save()
        console.log(JSON.stringify(redactDiagnostics({id:result.id,status:result.status,identityVerified:result.identityVerified,
          childSessionId:result.childSessionId,cleanup:result.cleanup})))
      }
    }
  }catch(error){report.errors.push(errorMetadata(error));process.exitCode=1}
  finally{
    try{report.finalAssociation=associated()}catch(error){report.errors.push(errorMetadata(error));process.exitCode=1}
    report.ready=report.results.filter(result=>result.status==='ready'&&result.identityVerified===true).length
    report.failed=report.results.length-report.ready
    report.completedAt=new Date().toISOString()
    await save();console.log(JSON.stringify({report:output,ready:report.ready,failed:report.failed,finalAssociation:report.finalAssociation}))
  }
}
