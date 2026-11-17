import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { maskScreenshot, privacyOptionsSchema, scanPasswordRegions, type PrivacyScan } from '../src/privacy.ts'
import { redactDiagnostics, redactText } from '../src/redaction.ts'
import { NativeRuntime, type IdentityPort, type DriverPort } from '../src/native-runtime.ts'

const bounds={x:-100,y:50,width:100,height:100}
const clean:PrivacyScan={complete:true,passwordRegions:[]}
async function source(){return await sharp({create:{width:200,height:200,channels:3,background:'white'}}).png().toBuffer()}
async function pixel(bytes:Buffer,x:number,y:number){return [...await sharp(bytes).extract({left:x,top:y,width:1,height:1}).removeAlpha().raw().toBuffer()]}

test('password bounds are solid black before crop/resize and outside content survives',async()=>{
  const masked=await maskScreenshot(await source(),bounds,{complete:true,passwordRegions:[{x:-75,y:75,width:20,height:20}]},'fixture',{},false,'verified')
  assert.deepEqual(await pixel(masked.bytes,60,60),[0,0,0])
  assert.deepEqual(await pixel(masked.bytes,10,10),[255,255,255])
  assert.equal(masked.privacy.status,'redacted');assert.equal(masked.suppressTree,true)
  const cropped=await sharp(masked.bytes).extract({left:50,top:50,width:30,height:30}).resize(15,15).jpeg().toBuffer()
  assert.deepEqual(await pixel(cropped,7,7),[0,0,0])
})
test('configured rectangles use physical screen coordinates including negative monitor positions',async()=>{
  const masked=await maskScreenshot(await source(),bounds,clean,'fixture',{excludedRectangles:[{x:-100,y:50,width:20,height:20}]},false,'verified')
  assert.deepEqual(await pixel(masked.bytes,10,10),[0,0,0]);assert.deepEqual(await pixel(masked.bytes,100,100),[255,255,255])
  assert.equal(masked.privacy.configuredRegions,1)
})
test('title match, failed privacy scan and desktop capture fail closed',async()=>{
  for(const [scan,title,config,desktop] of [
    [clean,'Sensitive Account',{windowTitleBlacklist:['sensitive']},false],
    [{complete:false,passwordRegions:[]},'fixture',{},false],
    [clean,'fixture',{},true],
  ] as const){
    const masked=await maskScreenshot(await source(),bounds,scan,title,config,desktop)
    assert.deepEqual(await pixel(masked.bytes,100,100),[0,0,0]);assert.equal(masked.suppressTree,true)
  }
  assert.equal((await scanPasswordRegions('not-a-hwnd',1)).complete,false)
  assert.equal(privacyOptionsSchema.safeParse({excludedRectangles:[{x:0,y:0,width:-1,height:1}]}).success,false)
})
test('redaction removes vmrun credentials, arbitrary secrets and username path segments without mutating input',()=>{
  const input={argv:['-gu','alice','-gp','super-secret','--token=abc','C:\\Users\\Alice\\VMs\\test.vmx'],stderr:'vmrun -gu "Alice Smith" -gp password123',nonce:'private',path:'C:/Users/Alice/test.txt',nested:{password:'hidden'}}
  const result=redactDiagnostics(input)
  assert.equal(result.argv[1],'[redacted]');assert.equal(result.argv[3],'[redacted]')
  assert.equal(result.argv[4],'--token=[redacted]')
  for(const secret of ['Alice','super-secret','password123','private','hidden']) assert.equal(JSON.stringify(result).includes(secret),false)
  assert.equal(input.argv[1],'alice');assert.equal(redactText('token=abc'),'token=[redacted]')
  assert.equal(redactText('C:\\Users\\Alice Smith\\private.txt'),'C:\\Users\\[redacted]\\private.txt')
  assert.equal(redactText('D:/Users/Alice Smith/private.txt'),'D:/Users/[redacted]/private.txt')
})
test('runtime never emits password UIA text or permits input from failed privacy observations',async t=>{
  const png=await source();let complete=true;let calls=0
  const identity:IdentityPort={assertInteractive(){},process:()=>({birth:'fixture',image:'fixture.exe'}),window:()=>({...bounds,foreground:'1'}),windowShellInfo:()=>({shellDesktop:false,className:'Fixture'}),rawTopLevelCount:()=>1,acquireLease:()=>()=>{},movePointer(){calls++}}
  const driver:DriverPort={listWindows:async()=>({windows:[{windowId:1n,pid:42,title:'Fixture',appName:'Fixture',bounds,isOnScreen:true}]}),
    getWindowState:async()=>({pid:42,windowId:1n,images:[{mimeType:'image/png',dataBase64:png.toString('base64')}],treeMarkdown:'secret-password-in-uia'}),
    getDesktopState:async()=>({isError:false,text:'',rawJson:'{}',images:[],degraded:false}),callTool:async()=>{calls++;return {isError:false,text:'',rawJson:'{}',images:[],degraded:false}},shutdown:async()=>{}}
  const runtime=new NativeRuntime({frameAgeMs:60000,maxDimension:320,imageBytes:100000},identity,()=>driver,undefined,true,undefined,async()=>({complete,passwordRegions:[{x:-75,y:75,width:20,height:20}]}))
  t.after(()=>runtime.pause(true));await runtime.enable();const [w]=await runtime.listWindows();await runtime.select(w.id,false)
  const frame=await runtime.capture();assert.equal(frame.tree,'');assert.equal(frame.privacy?.status,'blocked');assert.deepEqual(await pixel(Buffer.from(frame.data,'base64'),60,60),[0,0,0])
  await assert.rejects(runtime.execute({operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,action:{type:'click',x:100,y:100}}),/隐私/)
  complete=false;const blocked=await runtime.capture();assert.equal(blocked.privacy?.status,'blocked')
  await assert.rejects(runtime.execute({operationId:randomUUID(),frameId:blocked.id,epoch:blocked.epoch,action:{type:'click',x:100,y:100}}),/隐私/)
  assert.equal(calls,0)
})
test('unverified sensitive bitmap geometry blocks every pixel even when UIA and HWND agree',async()=>{
  for(const [scan,options] of [[{complete:true,passwordRegions:[{x:-75,y:75,width:20,height:20}]},{}],[clean,{excludedRectangles:[{x:-75,y:75,width:20,height:20}]}]] as const){
    const masked=await maskScreenshot(await source(),bounds,scan,'fixture',options)
    assert.equal(masked.privacy.status,'blocked');assert.equal(masked.privacy.reason,'sensitive-geometry-unverified')
    assert.ok((await sharp(masked.bytes).removeAlpha().raw().toBuffer()).every(value=>value===0))
  }
})
