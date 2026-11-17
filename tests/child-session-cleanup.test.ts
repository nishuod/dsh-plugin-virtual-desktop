import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChildSessionClient, type ChildSessionIdentity } from '../src/child-session-client.ts'
import { NativeSession } from '../src/native-session.ts'
import { runtimeStateSchema } from '../src/native-contract.ts'

test('desktop status carries the verified broker display sample until the connection ends', async () => {
  const client = new ChildSessionClient(5000, () => {})
  const pipDisplay = {
    requested: { width: 1920, height: 1080 },
    actual: { width: 1600, height: 900 },
    source: 'wts-client-display',
    sampledAt: Date.now(),
  }
  const identity = await new Promise<ChildSessionIdentity>((resolve, reject) => {
    client['ready'] = { resolve: value => resolve(value as ChildSessionIdentity), reject, cleanup() {} }
    client['receiveLine']({ event: 'ready', parentSessionId: 1, childSessionId: 2, pipDisplay })
  })
  const workerState = {
    backend: 'windows-attended', isolated: false, status: 'observing', epoch: 1,
    window: null, foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
    capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
  }
  // The ordinary worker reply cannot impersonate the separately verified broker sample.
  assert.equal(runtimeStateSchema.safeParse({ ...workerState, pipDisplay }).success, false)
  const session = new NativeSession({ timeoutMs: 5000, frameAgeMs: 30000, maxDimension: 1280, imageBytes: 512000 })
  Object.assign(session, { client: { call: async () => workerState, close: async () => {} }, identity, connectionId: randomUUID() })
  const signal = AbortSignal.timeout(5000)
  assert.deepEqual((await session.status(signal)).pipDisplay, pipDisplay)
  await session.close()
  assert.equal((await session.status(signal)).pipDisplay, undefined)
})

test('child cleanup tolerates Windows releasing a working directory after viewer exit', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-child-session-cleanup-test-'))
  const holder = spawn(process.execPath, ['-e', "process.send('ready'); setTimeout(()=>process.exit(0), 400)"],
    { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(holder, 'close')
  try {
    await once(holder, 'message')
    const client = new ChildSessionClient(5000, () => {})
    // Model the viewer having already exited while its child still owns the cwd.
    Object.assign(client, { directory })
    await client.close()
    await assert.rejects(access(directory), { code: 'ENOENT' })
    await exited
  } finally {
    if (holder.exitCode === null) holder.kill()
    await exited
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
