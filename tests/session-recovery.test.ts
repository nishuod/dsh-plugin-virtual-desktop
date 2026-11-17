import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NativeSession } from '../src/native-session.ts'
import { ChildSessionClient } from '../src/child-session-client.ts'

const options = { timeoutMs: 5000, frameAgeMs: 30000, maxDimension: 1280, imageBytes: 512000 }
const signal = () => AbortSignal.timeout(5000)
function fixture() {
  const session = new NativeSession(options)
  const client = new ChildSessionClient(5000, () => {})
  Object.assign(session, { client, identity: { parentSessionId: 1, childSessionId: 2 }, connectionId: randomUUID(),
    state: { ...session['state'], backend: 'windows-child-session', status: 'enabled', isolated: true, epoch: 4 } })
  session['ownedChildren'].add(client)
  return { session, client }
}

test('reset joins concurrent calls, revokes immediately, and leaves no owned association', async () => {
  const { session, client } = fixture()
  let closes = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  client.close = async () => { closes++; await gate }
  const first = session.resetChildSession(signal())
  const second = session.resetChildSession(signal())
  assert.equal(first, second)
  assert.equal((await session.status(signal())).connectionId, undefined)
  assert.equal(session['identity'], undefined)
  release()
  assert.equal((await first).status, 'stopped')
  assert.equal(closes, 1)
  assert.equal(session['ownedChildren'].size, 0)
  assert.equal((await session.resetChildSession(signal())).status, 'stopped')
  assert.equal(closes, 1)
})

test('failed owned cleanup remains retryable and cannot reopen input with the old connection', async () => {
  const { session, client } = fixture()
  const oldConnection = session['connectionId']!
  client.close = async () => { throw new Error('orphan cleanup pending') }
  await assert.rejects(session.resetChildSession(signal()), /orphan/)
  assert.equal(session['ownedChildren'].has(client), true)
  assert.equal((await session.status(signal())).connectionId, undefined)
  await assert.rejects(session.launch('C:\\fixture.exe', randomUUID(), oldConnection, 4, signal()))
  client.close = async () => {}
  assert.equal((await session.resetChildSession(signal())).status, 'stopped')
  assert.equal(session['ownedChildren'].size, 0)
})

test('reset never terminates an attended desktop connection', async () => {
  const { session, client } = fixture()
  session['state'].backend = 'windows-attended'
  let calls = 0
  client.close = async () => { calls++ }
  await assert.rejects(session.resetChildSession(signal()), /本机/)
  assert.equal(calls, 0)
  await session.close()
})

test('twenty serialized stop-reset cycles release every owned client and stale identity', async () => {
  const session = new NativeSession(options)
  for (let i = 0; i < 20; i++) {
    const client = new ChildSessionClient(5000, () => {})
    let closes = 0
    client.close = async () => { closes++ }
    client.call = async () => ({ ...session['state'], backend: 'windows-attended', isolated: false, status: 'stopped' })
    Object.assign(session, { client, identity: { parentSessionId: 1, childSessionId: i + 2 }, connectionId: randomUUID(),
      state: { ...session['state'], backend: 'windows-child-session', status: 'enabled', isolated: true } })
    session['ownedChildren'].add(client)
    await session.control('stop', signal())
    await session.resetChildSession(signal())
    assert.equal(closes, 1)
    assert.equal(session['ownedChildren'].size, 0)
    assert.equal(session['connectionId'], undefined)
    assert.equal(session['identity'], undefined)
  }
})

test('heartbeat loss revokes pending requests and tears down exactly once', async () => {
  const notices: string[] = []
  const client = new ChildSessionClient(5000, message => notices.push(message))
  let closes = 0
  client['closeProcess'] = async () => { closes++ }
  client.call = async () => { throw new Error('hung worker') }
  let rejected = false
  client['pending'].set('request', { resolve() {}, reject() { rejected = true }, cleanup() {} })
  await client['checkHeartbeat']()
  await client['checkHeartbeat']()
  await client.close()
  assert.equal(rejected, true)
  assert.equal(closes, 1)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /心跳/)
  assert.equal(client['pending'].size, 0)
})

test('child close retries failed cleanup without losing its ownership record', async () => {
  const client = new ChildSessionClient(5000, () => {})
  let attempts = 0
  client['closeProcess'] = async () => { if (++attempts === 1) throw new Error('association still releasing') }
  await assert.rejects(client.close(), /releasing/)
  await client.close()
  assert.equal(attempts, 2)
})

test('an enable already joining lifecycle cannot pass a reset that starts in its microtask gap', async () => {
  const session = new NativeSession({...options,lifecycleJoinMs:30})
  let release!: () => void
  const gate=new Promise<void>(resolve=>{release=resolve})
  const orphan=new ChildSessionClient(5000,()=>{})
  orphan.close=async()=>gate
  session['ownedChildren'].add(orphan)
  const opening=session.enable(signal(),'windows-child-session')
  const resetting=session.resetChildSession(signal())
  try{
    await assert.rejects(opening,/仍在退出/)
    assert.equal(session['client'],undefined,'reset must retain admission until all owned orphans join')
  }finally{
    release();await resetting;await session.close()
  }
})

