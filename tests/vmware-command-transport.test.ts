import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import test from 'node:test'
import sharp from 'sharp'
import { AppBrokerTransportError } from '../src/app-broker-client.ts'
import { createChildDispatcher } from '../src/child-session-bridge.ts'
import { NativeRuntime, type DriverPort, type IdentityPort } from '../src/native-runtime.ts'
import { NativeSession } from '../src/native-session.ts'
import { nativeRequestSchema, type DesktopRuntimeState } from '../src/native-contract.ts'
import {
  matchesVmwareCommandTarget, runVmwareCommand, vmwareCommandRequestSchema, vmwareCommandResultSchema,
  type VmwareCommandResult, type VmwareCommandRunner,
} from '../src/vmware-command.ts'

const vmwarePath = 'D:\\VMware\\vmware.exe'
const vmxPath = 'D:\\Virtual Machines\\Test VM\\Test VM.vmx'
const command = { operationId: randomUUID(), vmwarePath, command: 'start', vmxPath, timeoutMs: 30000 } as const
const owner = { vmwareHwnd: '100', vmwareBirth: '8040453aba53da01' }
const target = { id: randomUUID(), pid: 1000, title: 'VMware Workstation', app: 'VMware', imagePath: vmwarePath,
  windowClass: 'VMUIFrame', x: 0, y: 0, width: 200, height: 150 }
const workerState: DesktopRuntimeState = {
  backend: 'windows-attended', isolated: false, status: 'enabled', epoch: 2, window: target,
  foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
  capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
}
const result: VmwareCommandResult = {
  status: 'confirmed', state: 'running', message: 'running', vmx: vmxPath, vmPid: 1001, exitCode: 0, childSessionId: 9,
  evidence: { vmrunList: [vmxPath], processCheck: [{ pid: 1001, vmxPath, cpuMs: 25 }] },
  elapsedMs: 20, argv: ['-T', 'ws', 'start', vmxPath, 'nogui'], vmrunPid: 1002, stdout: '', stderr: '',
  fallbackAllowed: false,
}
const bridgeCommand = { ...command, expectedEpoch: workerState.epoch, windowId: target.id, pid: target.pid }

test('VMware command transport admits only fixed commands, command-specific deadlines and local .vmx paths', () => {
  assert.equal(vmwareCommandRequestSchema.parse(command).vmxPath, vmxPath)
  assert.equal(vmwareCommandRequestSchema.safeParse({ ...command, command: 'list', vmxPath: undefined, timeoutMs: 10000 }).success, true)
  for (const patch of [
    { command: 'deleteVM' }, { timeoutMs: 180001 }, { timeoutMs: 14999, command: 'stop' },
    { vmxPath: '\\\\server\\VM\\guest.vmx' }, { vmxPath: 'D:guest.vmx' },
    { vmxPath: 'D:\\guest.vmx:stream' }, { vmxPath: 'D:\\..\\guest.vmx' },
    { vmxPath: 'D:\\guest".vmx' }, { vmwarePath: 'D:\\vmrun.exe' },
    { argv: ['deleteVM'] }, { command: 'list', timeoutMs: 10000 }, { vmxPath: undefined },
  ]) {
    assert.equal(vmwareCommandRequestSchema.safeParse({ ...command, ...patch }).success, false, JSON.stringify(patch))
  }
})

function bridge(runCommand: VmwareCommandRunner, beforeScope?: () => Promise<unknown>) {
  const scopeCalls: unknown[] = []
  const dispatch = createChildDispatcher({
    childSessionId: 9, assertSession() {}, assertPid(pid) { assert.ok([target.pid, 2000].includes(pid)) },
  }, async (method, payload) => {
    if (method === 'windows') return [target]
    if (method === 'select' || method === 'pause' || method === 'stop' || method === 'status') return workerState
    if (method === 'appCommandScope') {
      scopeCalls.push(payload)
      await beforeScope?.()
      return owner
    }
    throw new Error('unexpected native call: ' + method)
  }, undefined, runCommand)
  const send = (method: string, payload: unknown, signal = new AbortController().signal) =>
    dispatch(nativeRequestSchema.parse({ version: 1, id: randomUUID(), method, payload }), signal)
  return { send, scopeCalls, select: async () => {
    await send('windows', null)
    await send('select', { windowId: target.id, foreground: false })
  } }
}

test('child dispatch rechecks authorized VMware scope, invalidates frames and deduplicates commands', async () => {
  let dispatches = 0
  const f = bridge(async (input, signal, beforeSend, verifyPid) => {
    dispatches++
    signal.throwIfAborted()
    verifyPid(2000)
    beforeSend()
    assert.equal(input.vmwareBirth, owner.vmwareBirth)
    assert.equal(input.vmwareHwnd, owner.vmwareHwnd)
    assert.equal(input.vmwarePid, target.pid)
    return result
  })
  await assert.rejects(f.send('appCommand', bridgeCommand), /选择/)
  await f.select()
  await assert.rejects(f.send('appCommand', { ...bridgeCommand, pid: 4321 }), /不一致/)
  await assert.rejects(f.send('appCommandScope', {}), /仅供/)
  assert.deepEqual(await f.send('appCommand', bridgeCommand), result)
  assert.deepEqual(await f.send('appCommand', bridgeCommand), result)
  assert.equal(dispatches, 1)
  const scope = { windowId: target.id, pid: target.pid, expectedEpoch: workerState.epoch, vmwarePath }
  assert.deepEqual(f.scopeCalls, [
    { ...scope, invalidateFrame: true }, { ...scope, invalidateFrame: false }, { ...scope, invalidateFrame: false },
  ])
  await assert.rejects(f.send('appCommand', { ...bridgeCommand, vmxPath: 'D:\\Different.vmx' }), /不同/)
  await f.send('pause', null)
  await assert.rejects(f.send('appCommand', bridgeCommand), /撤销/)
})

test('revocation during the worker preflight prevents any broker dispatch', async () => {
  const scopeStarted = Promise.withResolvers<void>()
  const continueScope = Promise.withResolvers<void>()
  let dispatches = 0
  const f = bridge(async () => { dispatches++; return result }, async () => {
    scopeStarted.resolve()
    await continueScope.promise
  })
  await f.select()
  const pending = f.send('appCommand', bridgeCommand)
  const revoked = assert.rejects(pending, /撤销/)
  await scopeStarted.promise
  await f.send('pause', null)
  continueScope.resolve()
  await revoked
  assert.equal(dispatches, 0)
})

test('loss of the AppBroker pipe returns an unknown receipt without replay or control disconnection', async () => {
  const list: VmwareCommandResult = { ...result, vmx: null, vmPid: null, state: 'listed', runningCount: 1,
    argv: ['-T', 'ws', 'list'] }
  let dispatches = 0
  const f = bridge(async input => {
    dispatches++
    if (input.command === 'list') return list
    throw new AppBrokerTransportError('exchange', 'EPIPE')
  })
  await f.select()
  const receipt = vmwareCommandResultSchema.parse(await f.send('appCommand', bridgeCommand))
  assert.equal(receipt.status, 'unknown')
  assert.equal(receipt.code, 'app-broker-disconnected')
  assert.equal(receipt.childSessionId, 9)
  assert.equal(receipt.vmx, vmxPath)
  assert.deepEqual(receipt.transportError, { phase: 'exchange', reason: 'EPIPE' })
  assert.equal(receipt.stderr, '')
  assert.equal(receipt.fallbackAllowed, false)
  assert.deepEqual(receipt.evidence, { vmrunList: [], processCheck: [] })
  assert.deepEqual(await f.send('appCommand', bridgeCommand), receipt)
  assert.equal(dispatches, 1)
  assert.equal((await f.send('status', null) as DesktopRuntimeState).status, 'enabled')
  assert.deepEqual(await f.send('appCommand', { ...bridgeCommand, operationId: randomUUID(), command: 'list',
    vmxPath: undefined, timeoutMs: 10000 }), list)
  assert.equal(dispatches, 2)
})

test('a confirmed empty VM list reports listed and a zero count, and cannot claim a VM state', () => {
  const emptyList = { ...result, vmx: null, vmPid: null, state: 'listed', runningCount: 0,
    argv: ['-T', 'ws', 'list'], evidence: { vmrunList: [], processCheck: [] } }
  const parsed = vmwareCommandResultSchema.parse(emptyList)
  assert.equal(matchesVmwareCommandTarget(parsed, undefined), true)
  assert.equal(matchesVmwareCommandTarget(parsed, vmxPath), false)
  assert.equal(vmwareCommandResultSchema.safeParse({ ...emptyList, runningCount: 1 }).success, false)
  assert.equal(vmwareCommandResultSchema.safeParse({ ...emptyList, state: 'unknown' }).success, false)
  assert.equal(matchesVmwareCommandTarget(vmwareCommandResultSchema.parse({
    ...emptyList, state: 'unknown', runningCount: undefined,
  }), undefined), false)
})

test('stop cancels an in-flight broker command and a foreign-session receipt is rejected', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const f = bridge(async (_input, signal, beforeSend) => {
    beforeSend()
    started.resolve(signal)
    return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await f.select()
  const pending = f.send('appCommand', bridgeCommand)
  const revoked = assert.rejects(pending, /撤销/)
  const signal = await started.promise
  await f.send('stop', null)
  assert.equal(signal.aborted, true)
  await revoked

  const foreign = bridge(async () => ({ ...result, childSessionId: 20 }))
  await foreign.select()
  await assert.rejects(foreign.send('appCommand', bridgeCommand), /子会话身份不一致/)
})

test('child dispatch preserves a preflight refusal but rejects a confirmed receipt for another VM', async () => {
  const failed: VmwareCommandResult = {
    ...result, status: 'failed', state: 'unknown', code: 'path-changed', vmx: null,
    vmPid: undefined, vmrunPid: null, exitCode: null, argv: [], evidence: { vmrunList: [], processCheck: [] },
  }
  const f = bridge(async () => failed)
  await f.select()
  assert.deepEqual(await f.send('appCommand', bridgeCommand), failed)
  const wrongVm = bridge(async () => ({ ...result, vmx: 'D:\\Other.vmx' }))
  await wrongVm.select()
  await assert.rejects(wrongVm.send('appCommand', bridgeCommand), /身份不一致/)
})

test('runtime proves the selected HWND and process identity without requiring a visible window', async () => {
  const frameBytes = await sharp({ create: { width: 200, height: 150, channels: 3, background: 'black' } }).png().toBuffer()
  let minimized = false
  let hwndVerified = true
  let birth = owner.vmwareBirth
  let imagePath = vmwarePath
  const identity: IdentityPort = {
    assertInteractive() {}, process: () => ({ birth, image: 'vmware.exe', imagePath }),
    window() {
      if (minimized) throw new Error('window is minimized')
      return { x: 0, y: 0, width: 200, height: 150, foreground: '100' }
    },
    windowShellInfo(id, pid) {
      assert.equal(id, owner.vmwareHwnd)
      assert.equal(pid, target.pid)
      if (!hwndVerified) throw new Error('HWND owner changed')
      return { shellDesktop: false, className: 'VMUIFrame' }
    },
    rawTopLevelCount: () => 1, acquireLease: () => () => {}, movePointer() { assert.fail() },
  }
  const driver = {
    listWindows: async () => ({ windows: [{ pid: target.pid, windowId: BigInt(owner.vmwareHwnd), title: target.title,
      appName: target.app, minimized: false, bounds: { x: 0, y: 0, width: 200, height: 150 } }] }),
    getWindowState: async () => ({ windowId: BigInt(owner.vmwareHwnd), pid: target.pid, images: [{ dataBase64: frameBytes.toString('base64') }] }),
    shutdown: async () => {},
  } as unknown as DriverPort
  const runtime = new NativeRuntime({ frameAgeMs: 60000, maxDimension: 1280, imageBytes: 100000 }, identity, () => driver, undefined, true,undefined,async()=>({complete:true,passwordRegions:[]}))
  await runtime.enable()
  const [window] = await runtime.listWindows()
  const state = await runtime.select(window.id, false)
  const frame = await runtime.capture()
  minimized = true
  const scope = { expectedEpoch: state.epoch, windowId: window.id, pid: target.pid, vmwarePath, invalidateFrame: true }
  assert.deepEqual(runtime.appCommandScope(scope), owner)
  await assert.rejects(runtime.execute({ operationId: randomUUID(), frameId: frame.id, epoch: state.epoch,
    action: { type: 'click', x: 5, y: 5 }, delivery: 'background' }), /输入许可未开启/)
  assert.throws(() => runtime.appCommandScope({ ...scope, expectedEpoch: state.epoch + 1 }), /许可已变化/)
  imagePath = 'D:\\Other\\vmware.exe'
  assert.throws(() => runtime.appCommandScope(scope), /安装位置不匹配/)
  imagePath = vmwarePath
  hwndVerified = false
  assert.throws(() => runtime.appCommandScope(scope), /HWND owner changed/)
  hwndVerified = true
  birth = '0000000000000000'
  assert.throws(() => runtime.appCommandScope(scope), /进程已更换/)
  await runtime.pause(true)
})

test('host appCommand compares current and approved child session, PID, epoch and executable', async () => {
  const connectionId = randomUUID()
  const childSessionId = 9
  const parentSessionId = 4
  const scope: DesktopRuntimeState = {
    ...workerState, backend: 'windows-child-session', isolated: true, connectionId, childSessionId, parentSessionId,
  }
  const session = new NativeSession({ timeoutMs: 1000, frameAgeMs: 1000, maxDimension: 1024, imageBytes: 100000 })
  const calls: string[] = []
  Object.assign(session, {
    connectionId, identity: { childSessionId, parentSessionId }, state: scope,
    client: { async call(method: string, payload: unknown) {
      calls.push(method)
      if (method === 'status') return workerState
      assert.deepEqual(payload, bridgeCommand)
      return result
    } },
  })
  const signal = new AbortController().signal
  for (const patch of [{ epoch: 1 }, { connectionId: randomUUID() }, { childSessionId: 8 },
    { window: { ...target, pid: 1234 } }, { window: { ...target, imagePath: 'D:\\Other\\vmware.exe' } }]) {
    await assert.rejects(session.appCommand(command, { ...scope, ...patch }, signal), /授权已变化/)
  }
  await assert.rejects(session.appCommand(command, scope, signal, () => { throw new Error('权限已撤销') }), /权限已撤销/)
  assert.equal(calls.includes('appCommand'), false)
  assert.deepEqual(await session.appCommand(command, scope, signal), result)
  assert.equal(calls.filter(method => method === 'appCommand').length, 1)
})

test('broker transport sends bounded authenticated command data and closes the pipe on cancellation', { skip: process.platform !== 'win32' }, async t => {
  const path = '\\\\.\\pipe\\DSH.AppBroker.' + randomUUID().replaceAll('-', '')
  const nonce = 'a'.repeat(64)
  const previous = [process.env.DSH_APP_PIPE, process.env.DSH_APP_NONCE, process.env.DSH_APP_PID]
  const received = Promise.withResolvers<Record<string, unknown>>()
  const disconnected = Promise.withResolvers<void>()
  let dropReply = false
  const server = createServer(socket => {
    socket.on('data', bytes => {
      if (dropReply) socket.destroy()
      else received.resolve(JSON.parse(bytes.toString('utf8')))
    })
    socket.on('close', () => disconnected.resolve())
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(() => {
    for (const [index, key] of ['DSH_APP_PIPE', 'DSH_APP_NONCE', 'DSH_APP_PID'].entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
    server.close()
  })
  process.env.DSH_APP_PIPE = path
  process.env.DSH_APP_NONCE = nonce
  process.env.DSH_APP_PID = '2000'
  const abort = new AbortController()
  const call = runVmwareCommand({ ...command, ...owner, vmwarePid: target.pid }, abort.signal, () => {}, pid => assert.equal(pid, 2000))
  const canceled = assert.rejects(call, { message: /已取消/, phase: 'exchange', reason: 'cancelled' })
  const { id, ...message } = await received.promise
  assert.equal(typeof id, 'string')
  assert.deepEqual(message, { version: 1, nonce, kind: 'vmware-command', vmwarePath, vmwarePid: target.pid,
    ...owner, command: 'start', vmxPath, timeoutMs: 30000 })
  abort.abort()
  await canceled
  await disconnected.promise

  dropReply = true
  await assert.rejects(runVmwareCommand({ ...command, ...owner, vmwarePid: target.pid }, new AbortController().signal,
    () => {}, pid => assert.equal(pid, 2000)), error => {
    assert.ok(error instanceof AppBrokerTransportError)
    assert.equal(error.phase, 'exchange')
    assert.match(error.reason, /^(?:closed|ECONNRESET|EPIPE)$/)
    return true
  })
})
