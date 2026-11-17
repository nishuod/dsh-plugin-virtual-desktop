import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DesktopTasks } from '../src/desktop-tasks.ts'
import type { TaskPlanner } from '../src/task-model.ts'
import type { TaskLogEntry, TaskRequest, TaskSnapshot, ValueCheck } from '../src/task-contract.ts'
import type { ContextMemory } from '../src/loop-contract.ts'
import { operationSchema, type DesktopBackend, type DesktopFrame, type DesktopRuntimeState, type DesktopReceipt } from '../src/native-contract.ts'

const signal = () => new AbortController().signal
const frameAction = { kind: 'act', explanation: '点击目标', action: { type: 'click', x: 10, y: 10 } }
const finished = { kind: 'finished', explanation: '界面似乎已更新' }

function harness(decide: (context: ContextMemory) => unknown | Promise<unknown>, backend: DesktopBackend = 'windows-attended') {
  const events: TaskLogEntry[] = []
  const calls: string[] = []
  const window = { id: randomUUID(), title: 'fixture', app: 'fixture.exe', pid: 123, x: 0, y: 0, width: 100, height: 100 }
  const state: DesktopRuntimeState = {
    backend, isolated: backend === 'windows-child-session', status: 'enabled', epoch: 1, window, foregroundAllowed: backend !== 'windows-child-session',
    inputMode: 'ask-each-action', lastResult: '',
    capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
  }
  let text = ''
  let clicks = 0
  let decoration = 0
  let lastFrame: DesktopFrame
  let dispatched = 0
  const runtime = {
    async status() { return structuredClone(state) },
    async capture(_source: 'window', _crop: unknown, _signal: AbortSignal, check?: ValueCheck): Promise<DesktopFrame> {
      calls.push(check ? 'readback' : 'capture')
      assert.equal(state.status, 'enabled')
      const tree = `clicks=${clicks}; value=${text}; decoration=${decoration}`
      lastFrame = {
        id: randomUUID(), windowId: window.id, epoch: state.epoch, capturedAt: Date.now(),
        width: 100, height: 100, mimeType: 'image/jpeg', data: Buffer.from(tree).toString('base64'),
        source: 'window', tree,
        ...(check ? { valueCheck: text === check.expected ? 'match' as const : 'mismatch' as const } : {}),
      }
      return lastFrame
    },
    async execute(raw: unknown): Promise<DesktopReceipt> {
      const operation = operationSchema.parse(raw)
      assert.equal(operation.epoch, state.epoch)
      assert.equal(operation.frameId, lastFrame.id)
      assert.ok(events.some(event => event.kind === 'dispatch' && event.message.includes(operation.operationId)))
      calls.push('execute')
      dispatched++
      if (operation.action.type === 'type') text = operation.action.text
      if (operation.action.type === 'click') clicks++
      return { operationId: operation.operationId, outcome: 'delivered', after: null, message: 'delivered' }
    },
    async control(command: 'pause' | 'resume' | 'stop') {
      calls.push(command)
      state.epoch++
      state.status = command === 'pause' ? 'paused' : command === 'resume' ? 'enabled' : 'stopped'
      return structuredClone(state)
    },
    async close() { state.status = 'stopped' },
  }
  const planner: TaskPlanner = {
    async routes() { return [] },
    async check() {},
    async decide(_id, _request, context) { calls.push('decide'); return await decide(context) },
    journal() {
      return { append(entry) { events.push(entry) }, async close() {} }
    },
  }
  const task = new DesktopTasks(runtime, planner)
  const start = (options: Partial<TaskRequest> = {}) => task.start({
    goal: '点击并输入中文', acceptance: '查看输入框', windowId: window.id, epoch: state.epoch,
    route: { provider: 'fixture', model: 'fixture-vision' }, ...options,
  }, signal())
  return { task, runtime, planner, start, calls, events, mutateFrame: () => { decoration++ }, get dispatched() { return dispatched } }
}

async function until(task: DesktopTasks, predicate: (value: TaskSnapshot) => boolean): Promise<TaskSnapshot> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const value = task.snapshot()
    if (value && predicate(value)) return value
    await delay(5)
  }
  assert.fail(JSON.stringify(task.snapshot()))
}

test('child-session approval shows its effective delivery and expires on disconnect', async t => {
  const fixture = harness(() => frameAction, 'windows-child-session')
  t.after(() => fixture.task.close())
  await fixture.start({ delivery: 'foreground' })
  const waiting = await until(fixture.task, state => state.status === 'awaiting-approval')
  assert.equal(JSON.parse(waiting.review!.detail).delivery, 'background')
  fixture.task.disconnect()
  assert.throws(() => fixture.task.answer(waiting.id, waiting.review!.id, 'approve'), /失效/)
  assert.throws(() => fixture.task.frame(waiting.id, waiting.review!.frameId), /更新/)
  await until(fixture.task, state => !state.active)
  assert.equal(fixture.dispatched, 0)
})

test('PiP scroll task needs no foreground permission and approves only background delivery', async t => {
  const fixture = harness(context => context.recent.length === 0
    ? { kind: 'act', explanation: '滚动已批准区域', action: { type: 'scroll', x: 50, y: 50, direction: 'down', amount: 3 } }
    : finished, 'windows-child-session')
  t.after(() => fixture.task.close())
  await fixture.start({ delivery: 'foreground' })
  const review = await until(fixture.task, value => value.status === 'awaiting-approval')
  const operation = JSON.parse(review.review!.detail)
  assert.equal(operation.delivery, 'background')
  assert.equal(operation.type, 'scroll')
  fixture.task.answer(review.id, review.review!.id, 'approve')
  await until(fixture.task, value => value.status === 'awaiting-verification')
  assert.equal(fixture.dispatched, 1)
  assert.notEqual(fixture.task.snapshot()?.status, 'completed')
})

test('task uses post-action observations and fresh control readback to complete two approved actions', async t => {
  const fixture = harness(context => {
    if (context.recent.length === 0) return frameAction
    assert.match(context.observation.feedback, /clicks=1/)
    if (context.recent.length === 1) {
      return { kind: 'act', explanation: '输入测试文本', action: { type: 'type', x: 5, y: 6, text: '闭环验证' } }
    }
    assert.match(context.recent[1].after.feedback, /闭环验证/)
    return finished
  })
  t.after(() => fixture.task.close())
  const initial = await fixture.start({ valueCheck: { label: '输入框', expected: '闭环验证' } })
  assert.equal(initial.active, true)
  const first = await until(fixture.task, status => status.status === 'awaiting-approval')
  assert.throws(() => fixture.task.assertIdle(), /正在使用/)
  assert.equal(fixture.dispatched, 0)
  fixture.task.answer(first.id, first.review!.id, 'approve')
  assert.throws(() => fixture.task.answer(first.id, first.review!.id, 'approve'), /失效/)
  const second = await until(fixture.task, status => status.step === 2 && status.status === 'awaiting-approval')
  fixture.task.answer(second.id, second.review!.id, 'approve')
  const end = await until(fixture.task, status => !status.active)
  assert.equal(end.status, 'completed')
  assert.equal(fixture.dispatched, 2)
  assert.ok(end.logs.some(entry => entry.kind === 'evaluation' && entry.message.includes('精确匹配')))
  assert.deepEqual(fixture.calls.slice(-2), ['decide', 'readback'])
})

test('a completion claim with a wrong control value exhausts the budget', async t => {
  const fixture = harness(() => finished)
  t.after(() => fixture.task.close())
  await fixture.start({ maxSteps: 2, valueCheck: { label: '输入框', expected: '预期内容' } })
  const end = await until(fixture.task, status => !status.active)
  assert.equal(end.status, 'budget-exhausted')
  assert.equal(fixture.dispatched, 0)
  assert.equal(fixture.calls.filter(call => call === 'readback').length, 2)
})

test('manual verification only accepts a fresh view and repeats review if it changes', async t => {
  const fixture = harness(() => finished)
  t.after(() => fixture.task.close())
  await fixture.start()
  const first = await until(fixture.task, status => status.status === 'awaiting-verification')
  assert.equal(fixture.calls.filter(call => call === 'capture').length, 2)
  fixture.mutateFrame()
  fixture.task.answer(first.id, first.review!.id, 'approve')
  const second = await until(fixture.task, status => status.status === 'awaiting-verification' && status.step === 2)
  assert.notEqual(first.frameId, second.frameId)
  fixture.task.answer(second.id, second.review!.id, 'approve')
  assert.equal((await until(fixture.task, status => !status.active)).status, 'completed')
})

test('a changed picture invalidates an input approval before dispatch', async t => {
  const fixture = harness(() => frameAction)
  t.after(() => fixture.task.close())
  await fixture.start()
  const first = await until(fixture.task, status => status.status === 'awaiting-approval')
  fixture.mutateFrame()
  fixture.task.answer(first.id, first.review!.id, 'approve')
  const second = await until(fixture.task, status => status.step === 2 && status.status === 'awaiting-approval')
  assert.notEqual(first.review!.id, second.review!.id)
  assert.equal(fixture.dispatched, 0)
  assert.ok(second.logs.some(entry => entry.message.includes('画面变化')))
})

test('pause discards a late model decision and resumes with a new observation and the same budget', async t => {
  const pending = Promise.withResolvers<unknown>()
  let decisions = 0
  const fixture = harness(() => ++decisions === 1 ? pending.promise : frameAction)
  t.after(() => fixture.task.close())
  await fixture.start({ maxSteps: 3 })
  const planning = await until(fixture.task, status => status.status === 'planning')
  await fixture.task.control('pause', signal())
  pending.resolve(frameAction)
  assert.equal(fixture.task.snapshot()?.status, 'paused')
  assert.equal(fixture.dispatched, 0)
  await fixture.task.control('resume', signal())
  const resumed = await until(fixture.task, status => status.status === 'awaiting-approval')
  assert.equal(resumed.step, 2)
  assert.notEqual(resumed.frameId, planning.frameId)
  await fixture.task.control('stop', signal())
  assert.throws(() => fixture.task.answer(resumed.id, resumed.review!.id, 'approve'), /失效/)
  assert.equal(fixture.dispatched, 0)
  assert.equal(fixture.task.snapshot()?.status, 'stopped')
})

test('an unknown result triggers a fresh observation and pauses without replay', async t => {
  const fixture = harness(() => frameAction)
  t.after(() => fixture.task.close())
  fixture.runtime.execute = async raw => {
    fixture.calls.push('unknown')
    return { operationId: operationSchema.parse(raw).operationId, outcome: 'unknown', after: null, message: '投递结果未知' }
  }
  await fixture.start()
  const review = await until(fixture.task, status => status.status === 'awaiting-approval')
  fixture.task.answer(review.id, review.review!.id, 'approve')
  const paused = await until(fixture.task, status => status.status === 'paused')
  assert.notEqual(paused.frameId, review.frameId)
  assert.deepEqual(fixture.calls.slice(-3), ['unknown', 'capture', 'pause'])
  assert.equal(fixture.calls.filter(call => call === 'decide').length, 1)
})


test('stop reaches a terminal task state even when both transport and teardown fail', async () => {
  const fixture = harness(() => frameAction, 'windows-child-session')
  await fixture.start()
  const review = await until(fixture.task, value => value.status === 'awaiting-approval')
  fixture.runtime.control = async () => { throw new Error('transport-disconnected') }
  fixture.runtime.close = async () => { throw new Error('orphan cleanup pending') }
  await assert.rejects(fixture.task.control('stop', signal()))
  assert.equal(fixture.task.snapshot()?.active, false)
  assert.equal(fixture.task.snapshot()?.status, 'failed')
  assert.equal(fixture.task.snapshot()?.review, null)
  assert.throws(() => fixture.task.answer(review.id, review.review!.id, 'approve'), /失效/)
  await fixture.task.close()
})
