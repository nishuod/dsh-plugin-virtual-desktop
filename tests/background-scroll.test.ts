import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BackgroundScrollRefused, WindowsBackgroundScroller, type BackgroundScrollPort } from '../src/background-scroll.ts'

const root = 0x100n
const panel = 0x200n
const control = 0x300n
const pid = 0xffffffe0

function fixture() {
  const windows = new Map<bigint, NonNullable<ReturnType<BackgroundScrollPort['window']>>>([
    [root, { pid, thread: 1, root, bounds: [-150, -150, 150, 150] }],
    [panel, { pid, thread: 1, root, bounds: [-100, -100, 100, 100] }],
    [control, { pid, thread: 1, root, bounds: [-50, -50, 50, 50] }],
  ])
  const calls: Parameters<BackgroundScrollPort['sendWheel']>[] = []
  let targetSession = 2
  let result: ReturnType<BackgroundScrollPort['sendWheel']> = 'delivered'
  let inDpiContext = false
  const port: BackgroundScrollPort = {
    withPerMonitorV2(operation) {
      inDpiContext = true
      try { return operation() } finally { inDpiContext = false }
    },
    sessionOf(target) { return target === pid ? targetSession : 2 },
    window(hwnd) { return windows.get(hwnd) },
    clientPoint(hwnd, point) {
      const bounds = windows.get(hwnd)?.bounds
      if (!bounds) return
      const [left, top, right, bottom] = bounds
      return { x: point.x - left, y: point.y - top, width: right - left, height: bottom - top }
    },
    childAt(hwnd) { return hwnd === root ? panel : hwnd === panel ? control : hwnd },
    sendWheel(...args) {
      assert.equal(inDpiContext, true)
      calls.push(args)
      return result
    },
  }
  const scroller = new WindowsBackgroundScroller(port)
  const scroll = (direction: 'up' | 'down' = 'down', amount = 1, x = -20, y = -35) =>
    scroller.scroll(root.toString(), pid, x, y, direction, amount)
  return {
    windows, port, calls, scroll,
    setSession: (value: number) => { targetSession = value },
    setResult: (value: typeof result) => { result = value },
  }
}

test('background wheel targets the deepest owned HWND and preserves signed coordinates and delta', () => {
  const f = fixture()
  f.scroll('up', 3)
  f.scroll('down', 2)
  const positive = BigInt(360) << 16n
  const negative = BigInt((-240) & 0xffff) << 16n
  const point = (BigInt((-35) & 0xffff) << 16n) | BigInt((-20) & 0xffff)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0].slice(0, 3), [control, positive, point])
  assert.deepEqual(f.calls[1].slice(0, 3), [control, negative, point])
  assert.ok(f.calls.every(([, , , timeout]) => timeout > 0 && timeout <= 1000))
})

test('background wheel refuses a child from another PID or root and a target in another session', () => {
  for (const modify of [
    (f: ReturnType<typeof fixture>) => { f.windows.set(control, { ...f.windows.get(control)!, pid: 99 }) },
    (f: ReturnType<typeof fixture>) => { f.windows.set(control, { ...f.windows.get(control)!, root: 0x999n }) },
    (f: ReturnType<typeof fixture>) => { f.setSession(3) },
  ]) {
    const f = fixture()
    modify(f)
    assert.throws(() => f.scroll(), BackgroundScrollRefused)
    assert.deepEqual(f.calls, [])
  }
})

test('background wheel refuses a nonclient hit, out-of-range coordinates and geometry changes', () => {
  const f = fixture()
  assert.throws(() => f.scroll('down', 1, 32768), BackgroundScrollRefused)
  assert.throws(() => f.scroll('down', 1, -151), BackgroundScrollRefused)
  const inspect = f.port.window
  let rootReads = 0
  f.port.window = hwnd => {
    if (hwnd === root && ++rootReads === 2) {
      f.windows.set(root, { ...f.windows.get(root)!, bounds: [-148, -150, 152, 150] })
    }
    return inspect(hwnd)
  }
  assert.throws(() => f.scroll(), BackgroundScrollRefused)
  assert.deepEqual(f.calls, [])
})

test('an uncertain send is reported without retry and a UIPI refusal stays explicit', () => {
  const f = fixture()
  f.setResult('unknown')
  assert.throws(() => f.scroll(), (error: unknown) =>
    error instanceof Error && !(error instanceof BackgroundScrollRefused) && error.message.includes('结果未知'))
  assert.equal(f.calls.length, 1)

  f.setResult('access-denied')
  assert.throws(() => f.scroll(), BackgroundScrollRefused)
  assert.equal(f.calls.length, 2)
})
