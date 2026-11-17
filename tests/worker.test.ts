import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DiagnosticWorker } from '../lib/worker-client.js'
import { boundedParse, requestSchema, replySchema } from '../src/protocol.ts'
import { PermissionGate } from '../src/permission.ts'

test('real child process handshake, correlated feedback, and awaited disposal', async () => {
  const worker = new DiagnosticWorker(5000)
  try {
    const first = await worker.start(new AbortController().signal)
    assert.equal(first.nativeDesktop, false)
    assert.equal(first.inputEnabled, false)
    const next = await worker.request('probe', new AbortController().signal)
    assert.equal(next.pid, first.pid)
    assert.equal(next.sequence, first.sequence + 1)
  } finally { await worker.close() }
  assert.ok(worker.isClosed)
  assert.throws(() => process.kill(worker.pid!, 0))
  await assert.rejects(worker.request('probe', new AbortController().signal), /not connected/)
})
test('cancelled startup spawns no process', async () => {
  const worker = new DiagnosticWorker(5000); const abort = new AbortController(); abort.abort()
  await assert.rejects(worker.start(abort.signal))
  assert.equal(worker.pid, undefined)
  await worker.close()
})
test('cancellation closes an in-flight process before returning failure', async () => {
  const worker = new DiagnosticWorker(5000)
  await worker.start(new AbortController().signal)
  const abort = new AbortController()
  const pending = worker.request('probe', abort.signal)
  abort.abort()
  await assert.rejects(pending, /cancelled/)
  assert.throws(() => process.kill(worker.pid!, 0))
  await worker.close()
})
test('strict worker boundary rejects wrong version, additional fields, native claims, oversized payloads', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  for (const value of [{ version: 9, id, method: 'probe' }, { version: 1, id, method: 'click' },
    { version: 1, id, method: 'probe', confirmed: true }, { payload: 'x'.repeat(17_000) }]) {
    assert.throws(() => boundedParse(requestSchema, value))
  }
  assert.throws(() => boundedParse(replySchema, { version: 1, id, kind: 'diagnostic-only', pid: 1, nativeDesktop: true, inputEnabled: true, sequence: 1 }))
})
test('phase 2 cannot grant native desktop access', () => {
  assert.throws(() => new PermissionGate().assertNativeAccess(), /no authorized native desktop backend/)
})
