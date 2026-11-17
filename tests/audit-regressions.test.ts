import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {NativeRuntime,type IdentityPort,type DriverPort} from '../src/native-runtime.ts'
import {admitFrameResult} from '../src/frame-attachment.ts'

test('cached uncertain action receipts are redacted before storage and never repeat a dispatch',async t=>{
  const png=await sharp({create:{width:100,height:80,channels:3,background:'#e6e8ff'}}).png().toBuffer()
  const bounds={x:10,y:10,width:100,height:80}
  let dispatches=0
  const identity:IdentityPort={
    assertInteractive(){},process:()=>({birth:'audit-fixture',image:'fixture.exe'}),
    window:()=>({...bounds,foreground:'1'}),windowShellInfo:()=>({shellDesktop:false,className:'Fixture'}),
    rawTopLevelCount:()=>1,acquireLease:()=>()=>{},movePointer(){throw Error('Unexpected pointer move')},
  }
  const driver:DriverPort={
    listWindows:async()=>({windows:[{windowId:1n,pid:42,title:'Audit Fixture',appName:'Fixture',bounds,isOnScreen:true}]}),
    getWindowState:async()=>({pid:42,windowId:1n,images:[{mimeType:'image/png',dataBase64:png.toString('base64')}],treeMarkdown:'Button "Run"'}),
    getDesktopState:async()=>({isError:false,text:'',rawJson:'{}',images:[],degraded:false}),
    callTool:async()=>{dispatches++;throw Error('vmrun -gu AuditUser -gp AuditPassword C:\\Users\\AuditUser\\private.txt token=AuditToken')},
    shutdown:async()=>{},
  }
  const runtime=new NativeRuntime({frameAgeMs:60000,maxDimension:320,imageBytes:100000},identity,()=>driver,undefined,false,undefined,async()=>({complete:true,passwordRegions:[]}))
  t.after(()=>runtime.pause(true))
  await runtime.enable();const [window]=await runtime.listWindows();await runtime.select(window.id,false)
  const frame=await runtime.capture()
  const operation={operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action:{type:'click',x:20,y:20}}
  const first=await runtime.execute(operation),cached=await runtime.execute(operation)
  assert.equal(first.outcome,'unknown');assert.equal(cached.outcome,'unknown');assert.equal(dispatches,1)
  assert.equal(cached.message,first.message)
  for(const receipt of [first,cached]){
    assert.match(receipt.message,/\[redacted\]/)
    for(const secret of ['AuditUser','AuditPassword','AuditToken'])assert.equal(receipt.message.includes(secret),false,secret)
  }
  assert.equal(cached.after,null)
})

test('attachment errors redact nested sensitive metadata while retaining operational image paths',async()=>{
  const cause=Object.assign(new Error('C:\\Users\\AttachmentUser\\cache token=AttachmentToken'),{code:'EIO'})
  const error=Object.assign(new Error('save failed --password=AttachmentPassword'),{cause,code:'ESTORAGE'})
  const filePath='C:\\Users\\AttachmentUser\\AppData\\Local\\Temp\\dsh-frame.jpg'
  const ctx={get:()=>({saveImage:async()=>{throw error}})} as any
  const result=await admitFrameResult(ctx,{content:[{type:'image',mimeType:'image/jpeg',data:'AA=='}],structuredContent:{filePath}})
  const failure=result.structuredContent?.attachmentError
  assert.equal(result.structuredContent?.imageMode,'unavailable')
  const text=JSON.stringify(failure)
  for(const secret of ['AttachmentUser','AttachmentToken','AttachmentPassword'])assert.equal(text.includes(secret),false,secret)
  assert.match(text,/ESTORAGE/);assert.match(text,/EIO/)
  assert.equal(result.structuredContent?.filePath,filePath)
  assert.deepEqual(result.structuredContent?.nextToolArgs,{file_path:filePath})
  const noPath=await admitFrameResult(ctx,{content:[{type:'image',mimeType:'image/jpeg',data:'AA=='}]})
  assert.equal(noPath.structuredContent?.nextTool,'desktop_get_task_status')
})
