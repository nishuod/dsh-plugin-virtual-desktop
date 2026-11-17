import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import sharp from 'sharp'
import { WindowsBackgroundInput, type BackgroundInputPort } from '../src/background-input.ts'
import { NativeRuntime, type DriverPort, type IdentityPort } from '../src/native-runtime.ts'
import { NativeWindowError, receiptSchema } from '../src/native-contract.ts'

const cases = [
  {
    outer: { x: 128, y: 128, width: 1359, height: 859 },
    bounds: { x: 128, y: 128, width: 1359, height: 859 },
    sdk: { width: 1357, height: 857 },
    point: { x: 1144, y: 19 }, expectedScreen: { x: 1341, y: 149 },
    jpegHeight: 808,
  },
  {
    outer: { x: 0, y: 0, width: 1920, height: 859 },
    bounds: { x: 8, y: 0, width: 1904, height: 851 },
    sdk: { width: 1568, height: 700 },
    point: { x: 1190, y: 18 }, expectedScreen: { x: 1777, y: 27 },
    jpegHeight: 571,
  },
]
const hwnd = 1n
const pid = 42

for (const { outer, bounds, sdk, point, expectedScreen, jpegHeight } of cases) {
  test(`PiP ${outer.width}x${outer.height} screenshot click reaches the actual caption minimize button`, async t => {
    const image = await sharp({ create: { ...sdk, channels: 3, background: '#aaaaaa' } }).png().toBuffer()
    let minimized = false
    let deliveries = 0
    const driver: DriverPort = {
      listWindows: async () => ({ windows: [{ windowId: hwnd, pid, title: 'Fixture', appName: 'Fixture', bounds, isOnScreen: true }] }),
      getWindowState: async () => ({
        pid, windowId: hwnd, screenshotFrameValid: true, windowBounds: bounds,
        images: [{ mimeType: 'image/png', dataBase64: image.toString('base64') }],
      }),
      getDesktopState: async () => { throw new Error('Unexpected desktop capture') },
      callTool: async () => { throw new Error('Unexpected SDK click or fallback') },
      shutdown: async () => {},
    }
    const identity: IdentityPort = {
      assertInteractive() {},
      process: () => ({ birth: 'p1', image: 'fixture.exe' }),
      window() {
        if (minimized) throw new NativeWindowError('minimized', '窗口最小化')
        return { ...outer, foreground: String(hwnd) }
      },
      windowShellInfo: () => ({ shellDesktop: false, className: 'Fixture' }),
      rawTopLevelCount: () => null,
      acquireLease: () => () => {},
      movePointer() { throw new Error('Unexpected foreground pointer movement') },
    }
    const input = new WindowsBackgroundInput({
      withPerMonitorV2: work => work(),
      sessionOf: () => 2,
      window: candidate => candidate === hwnd ? {
        pid, thread: 1, root: hwnd,
        bounds: [outer.x, outer.y, outer.x + outer.width, outer.y + outer.height],
      } : undefined,
      hitTest(candidate, screen) {
        assert.equal(candidate, hwnd)
        return screen.x === expectedScreen.x && screen.y === expectedScreen.y ? 8 : 2
      },
      send(candidate, message, command, packed) {
        assert.equal(candidate, hwnd)
        assert.equal(message, 0x112)
        assert.equal(command, 0xf020n)
        assert.equal(packed, BigInt(expectedScreen.x) | (BigInt(expectedScreen.y) << 16n))
        deliveries++
        minimized = true
        return 'delivered'
      },
    } as BackgroundInputPort)
    const runtime = new NativeRuntime({ frameAgeMs: 60000, maxDimension: 1280, imageBytes: 100000 }, identity, () => driver, undefined, true, input,async()=>({complete:true,passwordRegions:[]}))
    t.after(() => runtime.pause(true))
    await runtime.enable()
    const [window] = await runtime.listWindows()
    await runtime.select(window.id, false)
    const frame = await runtime.capture()
    assert.equal(frame.width, 1280)
    assert.equal(frame.height, jpegHeight)
    const request = { operationId: randomUUID(), frameId: frame.id, epoch: frame.epoch, action: { type: 'click', ...point } }
    const receipt = receiptSchema.parse(await runtime.execute(request))
    assert.equal(deliveries, 1)
    assert.equal(minimized, true)
    assert.equal(receipt.outcome, 'delivered')
    assert.equal(receipt.coordinates, 'screenshot-pixels')
    assert.deepEqual(receipt.sourcePoint, { x: point.x * sdk.width / 1280, y: point.y * sdk.height / jpegHeight })
    assert.deepEqual(receipt.effectivePoint,expectedScreen)
    assert.equal(receipt.effectivePointSpace,'physical-screen-pixels')
    assert.deepEqual(receipt.hitTest,{point:{x:expectedScreen.x-outer.x,y:expectedScreen.y-outer.y},screenPoint:expectedScreen,windowOrigin:{x:outer.x,y:outer.y},windowRelative:true,class:'HTMINBUTTON',code:8})
    assert.deepEqual(receipt.delivery,{kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'})
    assert.deepEqual(receipt.sourceScale, frame.scale)
    assert.deepEqual(receipt.postAction, { reason: 'minimized', nextTool: 'desktop_restore_window' })
    assert.equal(receipt.after, null)
    assert.deepEqual(await runtime.execute(request), receipt, 'An operation retry returns the receipt without re-dispatch')
    assert.equal(deliveries, 1)
    await assert.rejects(runtime.execute({ ...request, operationId: randomUUID() }), /已用于输入/)
  })
}
