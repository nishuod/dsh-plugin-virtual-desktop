// Fixed-app, opt-in evidence. Never adopts an existing child session.
// node tests/visual-candidates.live.mjs --allow-owned-vmware --capture-only
// node tests/visual-candidates.live.mjs --allow-owned-vmware --open-file-dialog
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,cp,copyFile,readFile,writeFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const modeFlags=['--capture-only','--open-file-dialog'].filter(flag=>process.argv.includes(flag))
if(!process.argv.includes('--allow-owned-vmware')||modeFlags.length!==1)throw new Error('Pass --allow-owned-vmware with exactly one of --capture-only or --open-file-dialog')
const mode=modeFlags[0],click=mode==='--open-file-dialog'
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This live probe requires Windows x64')
if(!process.argv.includes('--probe-worker')){
  const {build}=await import('esbuild')
  const output=resolve('artifacts/b4-live')
  await mkdir(output,{recursive:true})
  await cp('lib/child-session-host',join(output,'child-session-host'),{recursive:true})
  await build({entryPoints:{probe:fileURLToPath(import.meta.url),'child-session-bridge':'src/child-session-bridge.ts','native-worker':'src/native-worker.ts'},
    outdir:output,outExtension:{'.js':'.mjs'},bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',sourcemap:false})
  await copyFile(join(output,'child-session-bridge.mjs'),join(output,'child-session-bridge.js'))
  await copyFile(join(output,'native-worker.mjs'),join(output,'native-worker.js'))
  const result=spawnSync(process.execPath,[join(output,'probe.mjs'),'--allow-owned-vmware',mode,'--probe-worker'],{stdio:'inherit',windowsHide:true})
  if(result.error)throw result.error
  process.exitCode=result.status??1
}else{
  const {default:koffi}=await import('koffi')
  const {NativeSession}=await import('../src/native-session.ts')
  const {ApplicationLifecycle}=await import('../src/application-lifecycle.ts')
  const {decodeChildAssociation}=await import('../scripts/eval-contract.mjs')
  const {redactDiagnostics}=await import('../src/redaction.ts')
  const {screenshotSha256}=await import('../src/visual-targets.ts')
  const wts=koffi.load('wtsapi32.dll'),kernel=koffi.load('kernel32.dll')
  const query=wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
  const lastError=kernel.func('uint32_t __stdcall GetLastError()'),clearError=kernel.func('void __stdcall SetLastError(uint32_t error)')
  const associated=()=>{const id=[0];clearError(0);const ok=query(id),error=lastError();return decodeChildAssociation(ok,id[0],error)}
  const signal=()=>AbortSignal.timeout(90000)
  const output=resolve('evidence/b4')
  await mkdir(output,{recursive:true})
  const report={timestamp:new Date().toISOString(),kind:'owned-vmware-visual-candidates',mode,inputDelivered:false,vmCommandsIssued:false}
  const imageFile=click?'vmware-before-click.jpg':'vmware-home.jpg',reportFile=click?'click.json':'capture.json'
  let native,ctx
  try{
    assert.equal(associated(),null,'Existing child association: refusing to adopt, reset or open another session')
    native=new NativeSession({timeoutMs:20000,frameAgeMs:60000,maxDimension:1280,imageBytes:512000,visualCandidates:{enabled:true,maxCandidates:8,budgetMs:120}})
    const opened=await new ApplicationLifecycle(native).open({appId:'vmware-workstation',operationId:randomUUID()},async()=>{},signal())
    report.status=opened.status;report.stage=opened.stage
    assert.equal(opened.status,'ready','VMware did not become ready')
    const state=await native.status(signal())
    assert.equal(state.backend,'windows-child-session');assert.equal(state.isolated,true)
    assert.equal(state.childSessionId,associated());assert.notEqual(state.childSessionId,state.parentSessionId)
    assert.equal(state.foregroundAllowed,false);assert.equal(opened.pid,opened.window?.pid)
    // Recapture after readiness has settled; no parent desktop fallback.
    const frame=await native.capture('window',undefined,signal(),undefined,true)
    assert.equal(frame.windowId,opened.window.id);assert.equal(frame.epoch,state.epoch)
    assert.equal(frame.privacy?.status,'clear','Privacy masking prevents visual candidate acceptance')
    const jpeg=Buffer.from(frame.data,'base64')
    await writeFile(join(output,imageFile),jpeg)
    const {id,pid,x,y,width,height,windowClass}=opened.window
    report.window={id,pid,x,y,width,height,windowClass}
    report.session={connectionId:state.connectionId,childSessionId:state.childSessionId,parentSessionId:state.parentSessionId,epoch:state.epoch}
    report.frame={id:frame.id,width:frame.width,height:frame.height,scale:frame.scale,privacy:frame.privacy,
      accessibility:{status:frame.accessibility?.status,unnamedButtons:frame.accessibility?.unnamedButtons,
        visualCandidates:frame.accessibility?.visualCandidates,suggestedTargets:frame.accessibility?.suggestedTargets}}
    if(click){
      // Refuse a theme, geometry or page different from the audited before image.
      assert.equal(frame.width,1280);assert.equal(frame.height,808)
      const edges=[{left:438,top:219,right:626,bottom:390},{left:639,top:219,right:827,bottom:390},{left:839,top:219,right:1028,bottom:390}]
      const candidates=frame.accessibility.suggestedTargets.filter(target=>target.basis==='visual')
      assert.equal(frame.accessibility.visualCandidates.truncated,false)
      report.cards=edges.map(expected=>{
        const matching=candidates.map(target=>{
          const {x,y,width,height}=target.bbox
          const edgeErrorPx=Math.max(Math.abs(expected.left-x),Math.abs(expected.top-y),Math.abs(expected.right-(x+width)),Math.abs(expected.bottom-(y+height)))
          return {target,expected,edgeErrorPx}
        }).filter(item=>item.edgeErrorPx<8)
        assert.equal(matching.length,1,'Expected exactly one proposal within 7px of all four audited card edges')
        return matching[0]
      })
      const card=report.cards[1].target
      assert.equal(card.shadowedBy,undefined)
      const {default:sharp}=await import('sharp')
      const crop={left:655,top:230,width:152,height:145}
      const cropBytes=bytes=>sharp(bytes).extract(crop).removeAlpha().toColourspace('srgb').raw().toBuffer()
      const audited=await readFile(join(output,'vmware-home.jpg'))
      const [before,reference]=await Promise.all([cropBytes(jpeg),cropBytes(audited)])
      const ratio=before.reduce((changed,value,index)=>changed+(Math.abs(value-reference[index])>12?1:0),0)/before.length
      report.auditedCardPixelDifferenceRatio=ratio
      assert.ok(ratio<.015,'Open Virtual Machine card no longer matches the audited image')
      const {Context}=await import('@deepseek-ai/cordis')
      const {SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt')
      const {ToolRuntime}=await import('@deepseek-ai/dsh-tools')
      const NativeToolExecutor=await import('@deepseek-ai/dsh-tool-executor-native')
      const {ToolCallId}=await import('@deepseek-ai/dsh-llm')
      const {AttachmentId}=await import('@deepseek-ai/dsh-attachment')
      const {registerNativeTools}=await import('../src/native-tools.ts')
      ctx=new Context()
      await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime,{});await ctx.plugin(NativeToolExecutor)
      let approvalRequests=0,receipt
      ctx.provide('approval',{request:async()=>{approvalRequests++;return 'allowed-once'}})
      ctx.provide('llm',{resolveModelInfo:async()=>({inputModalities:['image']})})
      ctx.provide('attachments',{saveImage:async({data,mediaType})=>{
        const {width,height}=await sharp(data).metadata()
        return {attachmentId:AttachmentId('live-probe'),mediaType,width,height,bytes:data.length}
      }})
      registerNativeTools(ctx,{desktopStatus:signal=>native.status(signal),executeApproved:async(operation,signal)=>{
        receipt=await native.execute(operation,signal)
        return receipt
      }})
      const dialogs=async()=>(await native.windows(signal())).filter(window=>window.pid===opened.pid&&window.id!==opened.window.id&&
        (/^#32770$/.test(window.windowClass??'')||/^(open|打开)(?:\s|$)/i.test(window.title)))
      assert.deepEqual(await dialogs(),[],'A dialog is already visible before the test click')
      const args={operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,target:{id:card.id}}
      const agent={session:{requestHeader:()=>undefined},options:{provider:'fixture',model:'vision'}}
      const {results}=await ctx.tools.execute({calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name:'desktop_click_target',arguments:JSON.stringify(args)}],agent,signal:signal()})
      const result=results[0].result
      const {after,...metadata}=receipt??{}
      report.tool={name:'desktop_click_target',args,approvalRequests,isError:result.isError,...metadata}
      report.inputDelivered=receipt?.outcome==='delivered'
      assert.equal(result.isError,false,JSON.stringify(result.content).slice(0,1500))
      assert.equal(approvalRequests,1)
      assert.equal(receipt?.outcome,'delivered',receipt?.message)
      assert.equal(receipt.evidence?.[0].channel,'visual')
      assert.equal(receipt.visualVerification?.targetId,card.id)
      assert.equal(receipt.visualVerification?.beforeScreenshotSha256,screenshotSha256(frame.data))
      const afterDialogs=await dialogs()
      report.dialogs=afterDialogs.map(({id,pid,title,windowClass})=>({id,pid,title,windowClass}))
      if(after)await writeFile(join(output,'vmware-after-click.jpg'),Buffer.from(after.data,'base64'))
      assert.equal(afterDialogs.length,1,'Expected one newly opened dialog in the authorized VMware process')
      assert.match(afterDialogs[0].title,/^(open|打开)(?:\s|$)/i)
      assert.ok(after,'Missing after-action JPEG')
      assert.equal(receipt.visualVerification?.afterScreenshotSha256,screenshotSha256(after.data))
      assert.notEqual(receipt.visualVerification.afterScreenshotSha256,receipt.visualVerification.beforeScreenshotSha256)
      assert.ok(receipt.visualVerification.changedRegion)
      const projected=JSON.parse(result.content.find(block=>block.type==='text').text)
      assert.deepEqual(projected.visualVerification,receipt.visualVerification)
    }
  }catch(error){report.error={name:error?.name??'Error',message:String(error?.message??error).slice(0,1000)};process.exitCode=1}
  finally{
    if(ctx)await ctx.fiber.dispose().catch(error=>{report.toolCleanupError=String(error?.message??error);process.exitCode=1})
    if(native){try{const reset=await native.resetChildSession(signal());report.cleanup={status:reset.status,association:associated()};assert.equal(reset.status,'stopped');assert.equal(report.cleanup.association,null)}catch(error){report.cleanup={error:String(error?.message??error)};process.exitCode=1}}
    report.completedAt=new Date().toISOString()
    await writeFile(join(output,reportFile),JSON.stringify(redactDiagnostics(report),null,2)+'\n')
    console.log(JSON.stringify({report:join(output,reportFile),image:join(output,imageFile),status:report.status,visualCandidates:report.frame?.accessibility?.visualCandidates,dialogs:report.dialogs,cleanup:report.cleanup,error:report.error}))
  }
}
