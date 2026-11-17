import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSession } from '../src/native-session.ts'

test('D5 enable racing with a synchronous close rechecks join before opening frame storage', async () => {
  let finishClose!: () => void, finishBegin!: () => void, begins = 0
  const closingGate = new Promise<void>(resolve => { finishClose = resolve })
  const openingGate = new Promise<void>(resolve => { finishBegin = resolve })
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000 })
  Object.assign(session, {
    client: { close: () => closingGate },
    frames: { begin: async () => { begins++; await openingGate }, close: async () => {} },
  })
  const cancel = new AbortController()
  const opening = session.enable(cancel.signal).catch(error => error)
  const closing = session.close()
  try {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(begins, 0, 'enable must recheck lifecycle after its initial await, before opening another connection directory')
  } finally {
    cancel.abort(); finishBegin(); finishClose()
    await Promise.allSettled([opening, closing])
    await session.close()
  }
})

test('D3 cancelled startup between frame storage and transport creation cleans the allocated directory', async () => {
  const cancel = new AbortController()
  let closed = 0
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000 })
  Object.assign(session, { frames: {
    begin: async () => { cancel.abort() }, close: async () => { closed++ },
  } })
  try {
    await assert.rejects(session.enable(cancel.signal))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.ok(closed > 0, 'a cancelled startup must clean frame storage even when no transport was created')
    assert.equal((await session.status(AbortSignal.timeout(1000))).connectionId, undefined)
  } finally { await session.close() }
})
