import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoopContract, type LoopPorts, type LoopEvent, type ContextMemory } from '../src/loop-contract.ts'

const limits = { steps: 4, recent: 1, summary: 2 }
const signal = () => new AbortController().signal
function fixture() {
  const events: string[] = []
  const contexts: ContextMemory[] = []
  let revision = 0
  let clicked = false
  let evaluations = 0
  const ports: LoopPorts = {
    async observe() { events.push('observe'); return { revision: ++revision, feedback: clicked ? 'button changed' : 'unchanged' } },
    async decide(context) { events.push('decide'); contexts.push(context); return clicked
      ? { kind: 'finished', explanation: '操作后状态已变化' }
      : { kind: 'act', explanation: '尝试点击目标', action: { type: 'click', x: 10, y: 20 } } },
    async execute(_action, observedRevision) { events.push('execute'); assert.equal(observedRevision, revision); clicked = true; return 'input delivered' },
    async evaluate(context) { events.push('evaluate'); evaluations++; return { verdict: clicked ? 'pass' : 'fail', revision: context.observation.revision, evidence: context.observation.feedback } },
    async record(event: LoopEvent) { events.push(`record:${event.type}`) },
  }
  return { ports, events, contexts, get evaluations() { return evaluations } }
}
test('observe → context → decision → parsed action → feedback, then independently verify finished', async () => {
  const f = fixture()
  assert.equal(await runLoopContract('click button', 'button changed', f.ports, limits, signal()), 'completed')
  assert.deepEqual(f.events.filter(x => !x.startsWith('record:')), ['observe', 'decide', 'execute', 'observe', 'decide', 'observe', 'evaluate'])
  assert.equal(f.evaluations, 1)
  assert.equal(f.contexts[1].recent[0].receipt, 'input delivered')
  assert.equal(f.contexts[1].observation.feedback, 'button changed')
})
test('a convincing finished explanation cannot complete an unmet task', async () => {
  const f = fixture()
  f.ports.decide = async () => ({ kind: 'finished', explanation: '我保证已经完成' })
  assert.equal(await runLoopContract('task', 'changed', f.ports, limits, signal()), 'budget-exhausted')
  assert.equal(f.evaluations, limits.steps)
  assert.ok(!f.events.includes('execute'))
})
test('inconclusive completion remains unfinished', async () => {
  const f = fixture()
  f.ports.decide = async () => ({ kind: 'finished', explanation: '' })
  f.ports.evaluate = async context => ({ verdict: 'inconclusive', revision: context.observation.revision, evidence: 'insufficient evidence' })
  assert.equal(await runLoopContract('task', 'test', f.ports, limits, signal()), 'budget-exhausted')
})
test('malformed or injected actions are rejected before execution', async () => {
  for (const value of [
    { kind: 'act', explanation: '', action: { type: 'click', x: -1, y: 0 } },
    { kind: 'act', explanation: '', action: { type: 'shell', command: 'anything' } },
    { kind: 'finished', explanation: '', confirmed: true },
  ]) {
    const f = fixture(); f.ports.decide = async () => value
    await assert.rejects(runLoopContract('task', 'test', f.ports, limits, signal()), /Invalid model action/)
    assert.ok(!f.events.includes('execute'))
  }
})
test('executor receipts cannot substitute for a new observation', async () => {
  const f = fixture(); f.ports.observe = async () => ({ revision: 1, feedback: 'old' })
  f.ports.execute = async () => 'delivered'
  await assert.rejects(runLoopContract('task', 'test', f.ports, limits, signal()), /new executor observation/)
})
test('external evaluator must cite fresh evidence', async () => {
  for (const evidence of ['', 'older frame']) {
    const f = fixture()
    f.ports.evaluate = async () => ({ verdict: 'pass', revision: 0, evidence })
    await assert.rejects(runLoopContract('task', 'test', f.ports, limits, signal()), /Evaluator must cite/)
  }
})
test('audit failure blocks dispatch rather than exposing unlogged decisions', async () => {
  const f = fixture(); f.ports.record = async event => { if (event.type === 'decision') throw new Error('log unavailable') }
  await assert.rejects(runLoopContract('task', 'test', f.ports, limits, signal()), /log unavailable/)
  assert.ok(!f.events.includes('execute'))
})
test('cancellation after model response blocks its action', async () => {
  const f = fixture(); const abort = new AbortController()
  f.ports.decide = async () => { abort.abort(); return { kind: 'act', explanation: '', action: { type: 'click', x: 0, y: 0 } } }
  await assert.rejects(runLoopContract('task', 'test', f.ports, limits, abort.signal))
  assert.ok(!f.events.includes('execute'))
})
test('recent outcomes and older factual summaries are bounded and separate', async () => {
  const f = fixture()
  f.ports.decide = async context => { f.contexts.push(context); return { kind: 'act', explanation: '公开说明', action: { type: 'click', x: 0, y: 0 } } }
  assert.equal(await runLoopContract('task', 'test', f.ports, { ...limits, steps: 8 }, signal()), 'budget-exhausted')
  assert.equal(f.contexts[7].task, 'task')
  assert.equal(f.contexts[7].recent.length, 1)
  assert.equal(f.contexts[7].earlierSummary.length, 2)
  assert.match(f.contexts[7].earlierSummary[0], /Observed after revision/)
})
