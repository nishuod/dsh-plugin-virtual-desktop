import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NativeSession } from '../src/native-session.ts'
import { randomUUID } from 'node:crypto'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const runtime = {
  backend: 'windows-attended', isolated: false, status: 'stopped', epoch: 4,
  window: null, foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: 'stopped',
  capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
}

test('stop followed immediately by open cannot create a replacement before the previous child joins', async () => {
  const join = deferred(), closing = deferred()
  const previous = {
    call: async () => runtime,
    close: async () => { closing.resolve(); await join.promise },
  }
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000 })
  Object.assign(session, {
    client: previous, identity: { parentSessionId: 1, childSessionId: 2 }, connectionId: randomUUID(),
    state: { ...runtime, status: 'enabled', backend: 'windows-child-session', isolated: true },
  })
  const stop = session.control('stop', AbortSignal.timeout(5000))
  await closing.promise
  const cancel = new AbortController()
  const open = session.enable(cancel.signal, 'windows-child-session').then(() => null, error => error)
  try {
    await Promise.resolve()
    assert.equal((session as unknown as { client?: unknown }).client, undefined,
      'A replacement broker must wait until the old child logoff/join is complete')
  } finally {
    cancel.abort()
    join.resolve()
    await Promise.allSettled([stop, open])
    await session.close()
  }
})

test('closing admission revokes stale launch identity while cleanup is still pending', async () => {
  const join = deferred()
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000 })
  const connectionId = randomUUID()
  Object.assign(session, {
    client: { close: () => join.promise }, identity: { parentSessionId: 1, childSessionId: 2 }, connectionId,
    state: { ...runtime, status: 'enabled', epoch: 3, backend: 'windows-child-session', isolated: true },
  })
  const closing = session.close()
  try {
    await assert.rejects(session.launch('C:\\fixture.exe', randomUUID(), connectionId, 3, AbortSignal.timeout(5000)))
    const state = await session.status(AbortSignal.timeout(5000))
    assert.equal(state.connectionId, undefined)
    assert.equal(state.window, null)
  } finally {
    join.resolve()
    await closing
  }
})

test('open returns retry guidance within its bounded join while the previous child is still signing out', async () => {
  const join = deferred()
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000, lifecycleJoinMs: 20 })
  Object.assign(session, { client: { close: () => join.promise }, state: { ...runtime, status: 'enabled' } })
  const closing = session.close()
  try {
    await assert.rejects(session.enable(AbortSignal.timeout(5000), 'windows-child-session'), error => {
      const failure = error as Error & { retryAfterMs?: number; nextTool?: string }
      assert.ok(failure.retryAfterMs! > 0)
      assert.equal(failure.nextTool, 'desktop_open_child_session')
      assert.doesNotMatch(failure.message, /EPIPE/)
      return true
    })
    assert.equal((session as unknown as { client?: unknown }).client, undefined)
  } finally { join.resolve(); await closing }
})

test('a broken pipe is reported as a retryable connection failure rather than EPIPE', async () => {
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 60000, maxDimension: 1280, imageBytes: 512000 })
  Object.assign(session, {
    client: { call: async () => { throw Object.assign(new Error('read EPIPE'), { code: 'EPIPE' }) }, close: async () => {} },
    state: { ...runtime, status: 'enabled' },
  })
  try {
    await assert.rejects(session.windows(AbortSignal.timeout(5000)), error => {
      const failure = error as Error & { retryAfterMs?: number; nextTool?: string }
      assert.ok(failure.retryAfterMs! > 0)
      assert.equal(failure.nextTool, 'desktop_open_child_session')
      assert.doesNotMatch(failure.message, /EPIPE/)
      return true
    })
  } finally { await session.close() }
})
