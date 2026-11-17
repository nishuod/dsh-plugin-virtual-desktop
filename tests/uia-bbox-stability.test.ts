import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import sharp from 'sharp'
import { WindowsBackgroundInput, type BackgroundInputPort } from '../src/background-input.ts'
import { frameSchema, receiptSchema } from '../src/native-contract.ts'
import { NativeRuntime, type DriverPort, type IdentityPort } from '../src/native-runtime.ts'

const sample = JSON.parse(readFileSync(new URL('./fixtures/uia-bbox-jitter-rc2.json', import.meta.url), 'utf8'))
const bounds = { x:128, y:128, width:1359, height:859 }
const raw = { width:1357, height:857 }
const jpeg = { width:1280, height:808 }
const pid = 42, hwnd = 1n
type Rect = { x:number; y:number; width:number; height:number }

// Fit the fixture to the observed JPEG, with a small inset below ceil/floor boundaries.
function physical(rect: Rect): Rect {
  return {
    x:129 + (rect.x - .1) * raw.width / jpeg.width,
    y:129 + (rect.y - .1) * raw.height / jpeg.height,
    width:(rect.width + .2) * raw.width / jpeg.width,
    height:(rect.height + .2) * raw.height / jpeg.height,
  }
}
async function fixture() {
  const image = await sharp({create:{...raw,channels:3,background:'#778899'}}).png().toBuffer()
  let expected = physical(sample.image), unstable = false, reads = 0, deliveries = 0, sdkCalls = 0
  const driver: DriverPort = {
    listWindows: async () => ({windows:[{windowId:hwnd,pid,title:'VMware fixture',appName:'Fixture',bounds,isOnScreen:true}]}),
    getWindowState: async () => ({pid,windowId:hwnd,screenshotFrameValid:true,windowBounds:bounds,
      images:[{mimeType:'image/png',dataBase64:image.toString('base64')}]}),
    getDesktopState: async () => { throw Error('No desktop fallback') },
    callTool: async () => { sdkCalls++; throw Error('No SDK fallback for a caption') },
    shutdown: async () => {},
  }
  const identity: IdentityPort = {
    assertInteractive() {},
    process: () => ({birth:'trusted-fixture',image:'fixture.exe'}),
    window: () => ({...bounds,foreground:String(hwnd)}),
    windowShellInfo: () => ({shellDesktop:false,className:'Fixture'}),
    rawTopLevelCount: () => null,
    acquireLease: () => () => {},
    movePointer() { throw Error('No foreground pointer movement') },
  }
  const port = {
    withPerMonitorV2: <T>(work:()=>T) => work(),
    sessionOf: () => 2,
    window: (candidate:bigint) => candidate===hwnd?{pid,thread:1,root:hwnd,bounds:[128,128,1487,987]}:undefined,
    hitTest: (_candidate:bigint, point:{x:number;y:number}) => point.x>=expected.x && point.x<expected.x+expected.width &&
      point.y>=expected.y && point.y<expected.y+expected.height?8:9,
    send(candidate:bigint,message:number,wParam:bigint) {
      assert.equal(candidate,hwnd)
      assert.equal(message,0x0112)
      assert.equal(wParam,0xf020n)
      deliveries++
      return 'delivered'
    },
  } as BackgroundInputPort
  const input = new WindowsBackgroundInput(port)
  input.captionButtons = () => {
    reads++
    expected = physical(unstable && reads!==1 ? sample.uiaOnly : sample.image)
    return {minimize:expected}
  }
  const runtime = new NativeRuntime(
    {frameAgeMs:60000,maxDimension:1280,imageBytes:100000}, identity, () => driver,
    undefined, true, input, async () => ({complete:true,passwordRegions:[],targets:[{
      name:sample.target.name,controlType:sample.target.controlType,enabled:true,captionButton:'minimize',bounds:physical(sample.image),
    }]}),
  )
  await runtime.enable()
  const [window] = await runtime.listWindows()
  await runtime.select(window.id,false)
  return {
    runtime,
    beginFrame(value:boolean) { unstable=value;reads=0 },
    deliveries:() => deliveries,
    sdkCalls:() => sdkCalls,
  }
}

test('10-frame replay marks the rc.2 observed jitter, refuses both old coordinate boxes and still hit-tests named minimize', async t => {
  const f = await fixture()
  t.after(() => f.runtime.pause(true))
  for (let index=0;index<10;index++) {
    const unstable = index===4 || index===8 || index===9
    f.beginFrame(unstable)
    const frame = frameSchema.parse(await f.runtime.capture())
    const target = frame.accessibility?.suggestedTargets?.find(target => target.basis==='uia-bounds')
    assert.ok(target && target.basis==='uia-bounds')
    assert.deepEqual(target.bbox,sample.image)
    assert.equal(target.stable,!unstable)
    if (unstable) assert.deepEqual(target.bboxEvidence,{first:sample.image,second:sample.uiaOnly,deltaPx:37})
    const operation = {operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch}
    const priorDeliveries = f.deliveries()
    if (index===9) {
      const named = receiptSchema.parse(await f.runtime.execute({...operation,action:{type:'click',x:0,y:0,target:{name:sample.target.name,controlType:'Button'}}}))
      assert.equal(named.outcome,'delivered')
      assert.deepEqual(named.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
      assert.equal(named.hitTest?.class,'HTMINBUTTON')
      assert.equal(f.deliveries(),priorDeliveries+1)
    } else {
      const rect = index===8 ? sample.uiaOnly : sample.image
      const click={type:'click',x:rect.x+rect.width/2,y:rect.y+rect.height/2}
      const result=receiptSchema.parse(await f.runtime.execute({...operation,action:click}))
      if (unstable) {
        assert.equal(result.outcome,'refused')
        assert.equal(result.nextTool,'desktop_click_target')
        assert.deepEqual(result.evidence?.at(-1)?.bboxEvidence,target.bboxEvidence)
        assert.equal(f.deliveries(),priorDeliveries)
        await assert.rejects(f.runtime.execute({...operation,operationId:randomUUID(),action:click}),/已用于输入/)
      } else {
        assert.equal(result.outcome,'delivered')
        assert.equal(result.hitTest?.class,'HTMINBUTTON')
        assert.equal(f.deliveries(),priorDeliveries+1)
      }
    }
  }
  assert.equal(f.sdkCalls(),0)
})
