import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {Context} from '@deepseek-ai/cordis'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,type ToolExecution} from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {extractVisualTargets,visualDifference,screenshotSha256,visualOptionsSchema,type Rect} from '../src/visual-targets.ts'
import {NativeRuntime,type DriverPort,type IdentityPort} from '../src/native-runtime.ts'
import {frameSchema,receiptSchema} from '../src/native-contract.ts'
import {registerNativeTools} from '../src/native-tools.ts'
import type {VirtualDesktopController} from '../src/controller.ts'

const cards=[{x:80,y:100,width:120,height:112},{x:232,y:100,width:120,height:112},{x:384,y:100,width:120,height:112}]
async function picture(rects:Rect[]=cards,width=600,height=360,icon=false){
  const data=Buffer.alloc(width*height*3,245)
  for(const r of rects)for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++){
    const border=x===r.x||x===r.x+r.width-1||y===r.y||y===r.y+r.height-1
    if(border){const at=(y*width+x)*3;data[at]=data[at+1]=data[at+2]=160}
  }
  if(icon)for(let y=114;y<148;y++)for(let x=104;x<138;x++){
    const dx=x-121,dy=y-131,distance=dx*dx+dy*dy
    const ring=distance>=12*12&&distance<=16*16
    const plus=(Math.abs(dx)<=1&&Math.abs(dy)<=8)||(Math.abs(dy)<=1&&Math.abs(dx)<=8)
    if(ring||plus){const at=(y*width+x)*3;data[at]=data[at+1]=data[at+2]=32}
  }
  return sharp(data,{raw:{width,height,channels:3}}).png().toBuffer()
}
const client={x:0,y:40,width:600,height:320}
test('visual detector proposes three unlabelled card outlines within four pixels, only inside the authorized client',async()=>{
  const outside={x:8,y:0,width:40,height:32},bytes=await picture([...cards,outside])
  const result=await extractVisualTargets(bytes,client,[],{},()=>0)
  assert.equal(result.truncated,false);assert.equal(result.targets.length,3)
  for(const [index,target]of result.targets.entries()){
    assert.equal(target.id,`visual-${index}`);assert.equal(target.name,'');assert.equal(target.controlType,'region');assert.equal(target.basis,'visual')
    assert.ok(target.confidence>=.55&&target.confidence<=1)
    for(const key of ['x','y','width','height']as const)assert.ok(Math.abs(target.bbox[key]-cards[index][key])<4)
    assert.deepEqual(target.bbox,target.crop);assert.ok(target.bbox.y>=client.y)
  }
})
test('visual limits discard over-budget work, cap candidates, preserve UIA precedence and avoid guessed client bounds',async()=>{
  const bytes=await picture()
  const shadow=await extractVisualTargets(bytes,client,[{id:'uia-31',bbox:cards[1]}],{},()=>0)
  assert.equal(shadow.targets[1].shadowedBy,'uia-31')
  const limited=await extractVisualTargets(bytes,client,[],{maxCandidates:2},()=>0)
  assert.equal(limited.targets.length,2);assert.equal(limited.truncated,true);assert.equal(limited.reason,'candidate-limit')
  let tick=0
  const timed=await extractVisualTargets(bytes,client,[],{budgetMs:1},()=>tick++*2)
  assert.deepEqual(timed.targets,[]);assert.equal(timed.truncated,true);assert.equal(timed.reason,'budget-exceeded')
  assert.deepEqual((await extractVisualTargets(bytes,client,[],{enabled:false})).targets,[])
  assert.equal((await extractVisualTargets(bytes,{x:NaN,y:0,width:600,height:360})).reason,'client-unavailable')
  assert.throws(()=>visualOptionsSchema.parse({maxCandidates:9}));assert.throws(()=>visualOptionsSchema.parse({budgetMs:121}))
})
test('dark JPEG cards survive weak contrast and a sparse focus-ring extension',async()=>{
  const rectangles=cards.map((r,i)=>`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="#282828" ${i===1?'stroke="#8462ab" stroke-width="2"':''} rx="4"/>`)
  const markup=`<svg width="600" height="360"><path fill="#1e1e1e" d="M0 0h600v360H0z"/>${rectangles.join('')}<path fill="#8462ab" d="M285 89h3v13h-3z"/></svg>`
  const result=await extractVisualTargets(await sharp(Buffer.from(markup)).jpeg({quality:75}).toBuffer(),client,[],{},()=>0)
  assert.equal(result.targets.length,3)
  const actual=result.targets.sort((a,b)=>a.bbox.x-b.bbox.x)
  for(const [index,target]of actual.entries()){
    const {x,y,width,height}=target.bbox,expected=cards[index]
    assert.ok(Math.max(Math.abs(x-expected.x),Math.abs(y-expected.y),Math.abs(x+width-expected.x-expected.width),
      Math.abs(y+height-expected.y-expected.height))<8,JSON.stringify(target.bbox))
  }
})
test('text-like visual regions do not displace cards or count towards the candidate limit', async () => {
  const short = { x: 20, y: 252, width: 180, height: 28 }
  const wide = { x: 20, y: 300, width: 300, height: 32 }
  const bytes = await picture([...cards, short, wide])
  const defaults = await extractVisualTargets(bytes, client, [], { maxCandidates: 3 }, () => 0)
  assert.deepEqual(defaults.targets.map(target => target.bbox), cards)
  assert.equal(defaults.truncated, false)

  const allowShort = await extractVisualTargets(bytes, client, [], { minRegionHeightPx: 28 }, () => 0)
  assert.deepEqual(allowShort.targets.map(target => target.bbox), [...cards, short])
  const allowWide = await extractVisualTargets(bytes, client, [], { maxRegionAspectRatio: 9.375 }, () => 0)
  assert.deepEqual(allowWide.targets.map(target => target.bbox), [...cards, wide])
  assert.throws(() => visualOptionsSchema.parse({ minRegionHeightPx: 23 }))
  assert.throws(() => visualOptionsSchema.parse({ maxRegionAspectRatio: 0 }))
})
test('optional icons keep parent IDs and respect the shared candidate limit', async () => {
  const bytes = await picture(cards,600,360,true)
  const result = await extractVisualTargets(bytes,client,[],{},()=>0)
  assert.deepEqual(result.targets.map(item=>item.id),['visual-0','visual-1','visual-2','visual-0.icon-0'])
  const icon = result.targets[3]
  assert.equal(icon.parent,'visual-0')
  assert.deepEqual(icon.bbox,{x:105,y:115,width:33,height:33})
  const capped = await extractVisualTargets(bytes,client,[],{maxCandidates:3},()=>0)
  assert.deepEqual(capped.targets.map(item=>item.id),['visual-0','visual-1','visual-2'])
  assert.equal(capped.reason,'candidate-limit')
  const shadowed = await extractVisualTargets(bytes,client,[{id:'uia-0',bbox:cards[0]}],{},()=>0)
  assert.ok(!shadowed.targets.some(item=>item.parent==='visual-0'))
})
test('connected letters sharing a baseline are not exposed as icons', async () => {
  const svg = '<svg width="600" height="360"><rect width="600" height="360" fill="#212121"/>' +
    '<rect x="82" y="93" width="280" height="160" fill="#444"/>' +
    '<text x="105" y="188" fill="white" font-family="Arial" font-size="38">OPEN VM</text></svg>'
  const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer()
  const result = await extractVisualTargets(jpeg,client,[],{},()=>0)
  assert.equal(result.targets.filter(target=>!target.parent).length,1)
  assert.deepEqual(result.targets.filter(target=>target.parent),[])
})
test('visual verification records encoded image hashes and the changed region without asserting success',async()=>{
  const before=await picture(),after=await picture([...cards,{x:20,y:250,width:40,height:40}])
  const diff=await visualDifference(before.toString('base64'),after.toString('base64'))
  assert.equal(diff.beforeScreenshotSha256,screenshotSha256(before.toString('base64')))
  assert.equal(diff.afterScreenshotSha256,screenshotSha256(after.toString('base64')))
  assert.deepEqual(diff.changedRegion,{x:20,y:250,width:40,height:40})
  assert.equal((await visualDifference(before.toString('base64'),before.toString('base64'))).changedRegion,null)
})

async function runtimeFixture(options:{shadow?:boolean;private?:boolean;clientUnavailable?:boolean;privateOnRecheck?:boolean;icon?:boolean}={}){
  let bytes=await picture(cards,600,360,options.icon),calls=0,scans=0
  const rect={x:0,y:0,width:602,height:362,foreground:'1'}
  const driver:DriverPort={
    listWindows:async()=>({windows:[{windowId:1n,pid:42,title:'Fixture',appName:'Fixture',bounds:rect,isOnScreen:true}]}),
    getWindowState:async()=>({pid:42,windowId:1n,screenshotFrameValid:true,images:[{mimeType:'image/png',dataBase64:bytes.toString('base64')}],treeMarkdown:'Fixture',windowBounds:rect}),
    getDesktopState:async()=>{throw new Error('No desktop fallback')},
    callTool:async()=>{calls++;bytes=await picture([...cards,{x:20,y:250,width:40,height:40}],600,360,options.icon);return{isError:false,text:'delivered',rawJson:'{}',images:[],degraded:false}},
    shutdown:async()=>{},
  }
  const identity:IdentityPort={assertInteractive(){},process:()=>({birth:'fixture-process',image:'fixture.exe'}),window:()=>rect,
    clientBounds:()=>{
      if(options.clientUnavailable)throw new Error('Native client geometry unavailable')
      return {x:1,y:41,width:600,height:320}
    },windowShellInfo:()=>({shellDesktop:false,className:'Fixture'}),rawTopLevelCount:()=>null,
    acquireLease:()=>()=>{},movePointer(){throw new Error('No pointer movement')}}
  const runtime=new NativeRuntime({frameAgeMs:60000,maxDimension:600,imageBytes:100000,visualCandidates:{budgetMs:120}},identity,()=>driver,undefined,true,undefined,
    async()=>{
      scans++
      const privateFrame=options.private||options.privateOnRecheck&&scans>=3
      return {complete:true,passwordRegions:privateFrame?[{x:20,y:20,width:50,height:30}]:[],targets:options.shadow?[{name:'UIA card',controlType:'Button',enabled:true,bounds:{...cards[0],x:cards[0].x+1,y:cards[0].y+1}}]:[]}
    })
  await runtime.enable();const [window]=await runtime.listWindows();await runtime.select(window.id,false)
  return{runtime,calls:()=>calls,change:async()=>{bytes=await picture([...cards,{x:20,y:250,width:40,height:40}])}}
}
const operation=(frame:{id:string;epoch:number},target:unknown)=>({operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action:{type:'click',x:0,y:0,target}})
test('explicit current-frame visual id yields before/after proof and consumes the frame exactly once',async t=>{
  const f=await runtimeFixture();t.after(()=>f.runtime.pause(true))
  const frame=frameSchema.parse(await f.runtime.capture()),target=frame.accessibility?.suggestedTargets?.find(item=>item.basis==='visual')
  assert.ok(target,'Synthetic card detection should succeed within runtime budget')
  assert.deepEqual(frame.accessibility?.visualCandidates?.clientArea,client)
  const request=operation(frame,{id:target.id})
  const receipt=receiptSchema.parse(await f.runtime.execute(request))
  assert.equal(receipt.outcome,'delivered');assert.equal(f.calls(),1);assert.equal(receipt.evidence?.[0].channel,'visual')
  assert.equal(receipt.visualVerification?.targetId,target.id)
  assert.equal(receipt.visualVerification?.beforeScreenshotSha256,screenshotSha256(frame.data))
  assert.equal(receipt.visualVerification?.afterScreenshotSha256,screenshotSha256(receipt.after!.data))
  assert.ok(receipt.visualVerification?.changedRegion)
  await f.runtime.execute(request);assert.equal(f.calls(),1)
  await assert.rejects(f.runtime.execute({...request,operationId:randomUUID()}),/截图/);assert.equal(f.calls(),1)
  const invalid=structuredClone(frame);delete invalid.accessibility!.suggestedTargets![0].confidence
  assert.equal(frameSchema.safeParse(invalid).success,false)
})
test('parent and icon are separately selectable by exact current-frame IDs', async t => {
  const f=await runtimeFixture({icon:true});t.after(()=>f.runtime.pause(true))
  let frame=frameSchema.parse(await f.runtime.capture())
  const parent=frame.accessibility?.suggestedTargets?.find(item=>item.basis==='visual'&&item.id==='visual-0')
  assert.ok(parent)
  const parentReceipt=await f.runtime.execute(operation(frame,{id:parent.id}))
  assert.equal(parentReceipt.outcome,'delivered')
  assert.equal(parentReceipt.visualVerification?.targetId,parent.id)
  frame=frameSchema.parse(await f.runtime.capture())
  const icon=frame.accessibility?.suggestedTargets?.find(item=>item.basis==='visual'&&item.parent===parent.id)
  assert.ok(icon)
  const iconReceipt=await f.runtime.execute(operation(frame,{id:icon.id}))
  assert.equal(iconReceipt.outcome,'delivered')
  assert.equal(iconReceipt.visualVerification?.targetId,icon.id)
  assert.notDeepEqual(iconReceipt.sourcePoint,parentReceipt.sourcePoint)
  assert.equal(f.calls(),2)
})
test('visual targets refuse name/type lookup, stale pixels, shadowed ids, unknown ids and private frames without input',async t=>{
  for(const mode of ['type','changed','shadowed','unknown','private','privacy-change']as const){
    const f=await runtimeFixture({shadow:mode==='shadowed',private:mode==='private',privateOnRecheck:mode==='privacy-change'});t.after(()=>f.runtime.pause(true))
    const frame=await f.runtime.capture(),target=frame.accessibility?.suggestedTargets?.find(item=>item.basis==='visual')
    if(mode==='private'){assert.equal(target,undefined);continue}
    assert.ok(target,mode)
    if(mode==='changed')await f.change()
    const selector=mode==='type'?{controlType:'region',name:'guessed card'}:mode==='unknown'?{id:'visual-999',allowCoordinateFallback:true}:{id:target.id}
    const result=await f.runtime.execute(operation(frame,selector))
    assert.equal(result.outcome,'refused',mode);assert.equal(f.calls(),0,mode)
  }
})

test('unavailable client bounds leave the regular screenshot and UI Automation targets intact',async t=>{
  const f=await runtimeFixture({shadow:true,clientUnavailable:true});t.after(()=>f.runtime.pause(true))
  const frame=await f.runtime.capture()
  assert.ok(frame.data.length);assert.equal(frame.privacy?.status,'clear')
  assert.equal(frame.accessibility?.visualCandidates?.reason,'client-unavailable')
  assert.deepEqual(frame.accessibility?.suggestedTargets?.map(target=>target.basis),['uia-bounds'])
})

test('chat requires a vision route for explicit visual ids and projects only UIA targets in pixel-free results',async t=>{
  const f=await runtimeFixture({shadow:true});t.after(()=>f.runtime.pause(true))
  const frame=await f.runtime.capture()
  const ctx=new Context();t.after(()=>ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime,{});await ctx.plugin(NativeToolExecutor)
  ctx.provide('approval',{request:async()=> 'allowed-once'} as any)
  ctx.provide('llm',{resolveModelInfo:async()=>({inputModalities:['text']})} as any)
  ctx.provide('attachments',{saveImage:async()=>{throw Error('Text-only route must never admit images')}} as any)
  registerNativeTools(ctx,{
    desktopStatus:async()=>({backend:'windows-child-session',isolated:true,status:'enabled',epoch:frame.epoch,connectionId:randomUUID(),parentSessionId:1,childSessionId:7,window:{id:frame.windowId,pid:42}}),
    capture:async()=>frame,executeApproved:async()=>{throw Error('The incompatible model must never dispatch a visual click')},
  } as unknown as VirtualDesktopController)
  const agent={session:{requestHeader:()=>undefined},options:{provider:'fixture',model:'text-only'}} as unknown as NonNullable<ToolExecution['agent']>
  const execute=async(name:string,args:Record<string,unknown>)=>{
    const {results}=await ctx.tools.execute({calls:[{type:'tool-call',id:ToolCallId(randomUUID()),name,arguments:JSON.stringify(args)}],agent,signal:AbortSignal.timeout(10000)})
    return results[0].result
  }
  const result=await execute('desktop_get_screenshot',{mode:'uia'})
  assert.equal(result.isError,false)
  const metadata=JSON.parse((result.content[0] as {text:string}).text)
  assert.equal(metadata.imageMode,'uia-only');assert.equal(metadata.accessibility.visualCandidates,undefined)
  assert.equal(metadata.note,'省流模式不含自绘控件候选；点击卡片等区域请改用 mode=image')
  assert.ok(metadata.accessibility.suggestedTargets.length)
  assert.ok(metadata.accessibility.suggestedTargets.every((target:{basis:string})=>target.basis==='uia-bounds'))
  const target=frame.accessibility?.suggestedTargets?.find(item=>item.basis==='visual')
  assert.ok(target)
  const click=await execute('desktop_click_target',{frameId:frame.id,operationId:randomUUID(),epoch:frame.epoch,target:{id:target.id}})
  assert.equal(click.isError,true);assert.match((click.content[0] as {text:string}).text,/没有声明图像输入能力/)
})
