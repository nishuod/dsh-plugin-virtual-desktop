import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { childDelivery } from '../src/child-delivery.ts'
import { createChildDispatcher } from '../src/child-session-bridge.ts'
import { actionSchema, nativeRequestSchema, type DesktopFrame, type DesktopRuntimeState } from '../src/native-contract.ts'

const point = { x: 10, y: 20 }
const click = actionSchema.parse({ ...point, type: 'click' })
const scroll = actionSchema.parse({ ...point, type: 'scroll', direction: 'down' })

test('child delivery permits only validated pilot actions and routes', () => {
  assert.equal(childDelivery(click), 'background')
  assert.equal(childDelivery(actionSchema.parse({ ...point, type: 'type', text: '中文' })), 'background')
  assert.equal(childDelivery(scroll), 'background')
  for (const action of [
    { ...point, type: 'click', button: 'right' },
    { ...point, type: 'key', key: 'f4', modifiers: ['alt'] },
    { ...point, type: 'scroll', direction: 'left' },
    { ...point, type: 'move' },
  ]) {
    assert.throws(() => childDelivery(actionSchema.parse(action)), /子会话试用/)
  }
})

test('child bridge filters other sessions and rejects unmatched targets, routes and desktop capture', async () => {
  const target = { id: randomUUID(), pid: 120, title: 'Fixture', app: 'Fixture', x: 0, y: 0, width: 200, height: 120 }
  const foreign = { ...target, id: randomUUID(), pid: 222 }
  const frame: DesktopFrame = { id: randomUUID(), windowId: target.id, epoch: 2, capturedAt: 0, width: 200, height: 120, source: 'window', mimeType: 'image/jpeg', data: '', tree: '' }
  const state: DesktopRuntimeState = {
    backend: 'windows-attended', isolated: false, status: 'enabled', epoch: 2, window: target,
    foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
    capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
  }
  const operation = { operationId: randomUUID(), frameId: frame.id, epoch: frame.epoch, action: click, delivery: 'background' }
  const calls: unknown[] = []
  let active = true
  let validPid = target.pid
  const dispatch = createChildDispatcher({
    assertSession() { if (!active) throw new Error('disconnected') },
    assertPid(pid) { if (pid !== validPid) throw new Error('outside session') },
  }, async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'windows') return [target, foreign]
    if (method === 'select') return state
    if (method === 'capture') return frame
    if (method === 'execute') return { operationId: operation.operationId, outcome: 'delivered', message: '', after: frame }
    throw new Error('unexpected native call')
  })
  const send = (method: string, payload: unknown) => dispatch(nativeRequestSchema.parse({ version: 1, id: randomUUID(), method, payload }), new AbortController().signal)

  assert.deepEqual(await send('windows', null), [target])
  await assert.rejects(send('select', { windowId: foreign.id, foreground: false }), /选择/)
  await send('select', { windowId: target.id, foreground: false })
  assert.deepEqual(calls.at(-1), { method: 'select', payload: { windowId: target.id, foreground: false } })
  await assert.rejects(send('capture', { source: 'desktop' }))
  await assert.rejects(send('execute', { ...operation, action: scroll, delivery: 'foreground' }), /传递模式/)
  await assert.rejects(send('execute', { ...operation, delivery: 'foreground' }), /传递模式/)
  assert.equal(calls.length, 2)
  assert.deepEqual(await send('capture', { source: 'window' }), frame)
  await send('execute', operation)
  assert.deepEqual(calls.at(-1), { method: 'execute', payload: operation })

  validPid = 333
  await assert.rejects(send('capture', { source: 'window' }), /outside session/)
  await assert.rejects(send('execute', operation), /outside session/)
  active = false
  await assert.rejects(send('windows', null), /disconnected/)
  assert.equal(calls.length, 4)
})

test('child bridge reports only its own session-eligible count for the latest completed enumeration', async () => {
  const target = { id: randomUUID(), pid: 120, title: 'Fixture', app: 'Fixture', x: 0, y: 0, width: 200, height: 120 }
  const foreign = { ...target, id: randomUUID(), pid: 222 }
  const state: DesktopRuntimeState = {
    backend: 'windows-attended', isolated: false, status: 'observing', epoch: 1, window: null,
    foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
    capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
    windowDiscovery: {
      sampledAt: 1, rawTopLevel: 6, sdkCandidates: 2, workerEligible: 2, sessionEligible: 2,
      filtered: { missingPid: 0, minimized: 0, invalidBounds: 0, blockedProcess: 0, systemSurface: 0, unverifiedProcess: 0, unverifiedWindow: 0, limit: 0 },
    },
  }
  let finishList: (() => void) | undefined
  const dispatch = createChildDispatcher({
    assertSession() {},
    assertPid(pid) { if (pid === foreign.pid) throw new Error('outside session') },
  }, async method => {
    if (method === 'status') return state
    if (method === 'windows') {
      await new Promise<void>(resolve => { finishList = resolve })
      return [target, foreign]
    }
    throw new Error('unexpected native call')
  })
  const send = (method: 'status' | 'windows') => dispatch({ version: 1, id: randomUUID(), method, payload: null }, new AbortController().signal)
  const eligibleCount = async () => (await send('status') as DesktopRuntimeState).windowDiscovery?.sessionEligible
  assert.equal(await eligibleCount(), undefined)
  const list = send('windows')
  assert.equal(await eligibleCount(), undefined)
  finishList!()
  assert.deepEqual(await list, [target])
  assert.equal(await eligibleCount(), 1)
})
