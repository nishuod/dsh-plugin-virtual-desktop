import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,isAbsolute} from 'node:path'
import sharp from 'sharp'
import {Context} from '@deepseek-ai/cordis'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,type ToolExecution} from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import {AttachmentId} from '@deepseek-ai/dsh-attachment'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {registerNativeTools} from '../src/native-tools.ts'
import type {VirtualDesktopController} from '../src/controller.ts'
import {FrameStore} from '../src/frame-store.ts'
import {DiagnosticJournal} from '../src/diagnostic-export.ts'
import {redactDiagnostics,redactText,projectToolReceipt} from '../src/redaction.ts'

test('operational projection exempts only file handles and their matching read_image argument, including nested receipts',()=>{
  const filePath='C:\\Users\\FixtureUser\\AppData\\Local\\Temp\\image.jpg'
  const original={filePath,filePathDisplay:'do not trust this display',path:filePath,password:'fixture-secret',
    nextTool:'read_image',nextToolArgs:{file_path:filePath},after:{filePath},items:[{filePath}],
    error:{message:`failure at ${filePath}`,token:'fixture-token'}}
  const projected=projectToolReceipt(original)
  for(const item of [projected,projected.after,projected.items[0]]){
    assert.equal(item.filePath,filePath)
    assert.equal((item as typeof projected).filePathDisplay,redactText(filePath))
  }
  assert.equal(projected.nextToolArgs.file_path,filePath)
  assert.equal(projected.path,redactText(filePath));assert.equal(projected.password,'[redacted]')
  assert.equal(projected.error.message,`failure at ${redactText(filePath)}`);assert.equal(projected.error.token,'[redacted]')
  assert.deepEqual(projectToolReceipt(projected),projected)
  const logCopy=redactDiagnostics(projected)
  assert.equal(logCopy.filePath,redactText(filePath));assert.equal(logCopy.nextToolArgs.file_path,redactText(filePath))
  assert.ok(!JSON.stringify(logCopy).includes('FixtureUser'))
  assert.equal(original.password,'fixture-secret');assert.equal(original.filePathDisplay,'do not trust this display')
})

test('chat open, screenshot, action and attachment fallback retain readable image handles while journal/export redact them',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-operational-paths-'))
  const frames=new FrameStore(directory),ctx=new Context()
  t.after(async()=>{await ctx.fiber.dispose();await frames.close();await rm(directory,{recursive:true,force:true})})
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolRuntime,{})
  await ctx.plugin(NativeToolExecutor)
  const connectionId=randomUUID(),windowId=randomUUID()
  await frames.begin(connectionId)
  const bytes=await sharp({create:{width:32,height:24,channels:3,background:'#8192bb'}}).jpeg().toBuffer()
  const frame=await frames.save({id:randomUUID(),windowId,epoch:2,capturedAt:Date.now(),source:'window',
    width:32,height:24,mimeType:'image/jpeg',data:bytes.toString('base64'),tree:'Button Fixture',privacy:{status:'clear',passwordRegions:0,configuredRegions:0,titleMatched:false}})
  const state={backend:'windows-child-session',isolated:true,status:'enabled',epoch:2,connectionId,childSessionId:7,parentSessionId:1,
    window:{id:windowId,pid:42,title:'Fixture',app:'fixture.exe',x:0,y:0,width:32,height:24},foregroundAllowed:false}
  const journal=new DiagnosticJournal(redactDiagnostics,join(directory,'journal'))
  let failAttachment=false
  ctx.provide('approval',{request:async()=> 'allowed-once'} as any)
  ctx.provide('llm',{resolveModelInfo:async()=>({inputModalities:['image']})} as any)
  ctx.provide('attachments',{saveImage:async()=>{
    if(failAttachment)throw Object.assign(new Error(`Cannot save image at ${frame.filePath}`),{code:'EDQUOT'})
    return {attachmentId:AttachmentId('fixture'),mediaType:'image/jpeg',width:32,height:24,bytes:bytes.length}
  }} as any)
  const service={
    desktopStatus:async()=>structuredClone(state),
    openApplicationApproved:async()=>({operationId:randomUUID(),status:'ready',stage:'ready',message:`opened ${frame.filePath}`,
      path:'C:\\Users\\Example\\fixture.exe',pid:42,connectionId,epoch:2,childSessionId:7,window:state.window,frame}),
    capture:async()=>frame,
    executeApproved:async(operation:{operationId:string})=>({operationId:operation.operationId,outcome:'delivered',message:'clicked',after:frame}),
    exportDiagnostics:async()=>journal.export({filePath:frame.filePath,password:'fixture-secret'},0),
  }
  registerNativeTools(ctx,service as unknown as VirtualDesktopController)
  const agent={session:{requestHeader:()=>undefined},options:{provider:'fixture',model:'vision'}} as unknown as NonNullable<ToolExecution['agent']>
  const execute=async(name:string,args:Record<string,unknown>)=>{
    const {results}=await ctx.tools.execute({calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name,arguments:JSON.stringify(args)}],agent,signal:AbortSignal.timeout(10000)})
    const result=results[0].result
    assert.equal(result.isError,false,JSON.stringify(result.content))
    return JSON.parse(result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))
  }
  const assertImage=async(receipt:any)=>{
    assert.equal(receipt.filePath,frame.filePath)
    assert.ok(isAbsolute(receipt.filePath));assert.ok((await stat(receipt.filePath)).isFile())
    assert.equal((await sharp(receipt.filePath).metadata()).width,32)
    assert.equal(receipt.filePathDisplay,redactText(frame.filePath!))
    journal.record('receipt',receipt)
  }
  const opened=await execute('desktop_open_application',{path:'C:\\Fixture\\fixture.exe'})
  await assertImage(opened)
  assert.equal(opened.path,'C:\\Users\\[redacted]\\fixture.exe')
  assert.ok(!opened.message.includes('fixture-secret'))
  await assertImage(await execute('desktop_get_screenshot',{}))
  await assertImage(await execute('desktop_click',{operationId:randomUUID(),frameId:frame.id,epoch:2,x:1,y:1}))
  failAttachment=true
  const fallback=await execute('desktop_get_screenshot',{})
  await assertImage(fallback)
  assert.equal(fallback.imageMode,'unavailable');assert.equal(fallback.nextTool,'read_image')
  assert.equal(fallback.nextToolArgs.file_path,frame.filePath)
  assert.equal((await sharp(fallback.nextToolArgs.file_path).metadata()).height,24)
  const uia=await execute('desktop_get_screenshot',{mode:'uia'})
  assert.equal(uia.imageMode,'uia-only');assert.equal(uia.filePath,undefined)
  const exported=await execute('desktop_export_diagnostics',{})
  assert.ok(isAbsolute(exported.filePath));assert.ok((await stat(exported.filePath)).isFile())
  assert.equal(exported.filePathDisplay,redactText(exported.filePath))
  const archive=await readFile(exported.filePath)
  assert.equal(archive.readUInt32LE(0),0x04034b50)
  assert.ok(!archive.toString().includes('fixture-secret'))
  const [logName]=await readdir(join(directory,'journal','logs'))
  const log=await readFile(join(directory,'journal','logs',logName),'utf8')
  const recorded=JSON.parse(log.trim().split('\n')[0]).value
  assert.equal(recorded.filePath,redactText(frame.filePath!))
  if(redactText(frame.filePath!)!==frame.filePath){
    assert.ok(!log.includes(JSON.stringify(frame.filePath).slice(1,-1)))
    assert.ok(!archive.toString().includes(JSON.stringify(frame.filePath).slice(1,-1)))
  }
})
