import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { insideVmRoot, localVmPath, parseVmInventory, VmAdapter, VmCommandError, vmCommandInputSchema, vmrunArguments } from '../src/vm-adapter.ts'
import { VmCommandService, type VmPowerAuthorization } from '../src/vm-command-service.ts'
import type { DesktopRuntimeState } from '../src/native-contract.ts'
import type { VmwareCommandRequest, VmwareCommandResult } from '../src/vmware-command.ts'

const root = 'C:\\VM-QA'
const vmx = root + '\\Sample One.vmx'
const app = 'D:\\VMware\\vmware.exe'
const signal = () => AbortSignal.timeout(10000)
const input = (command: 'list' | 'start' | 'stop') => vmCommandInputSchema.parse({
  appId: 'vmware-workstation', operationId: randomUUID(), command, ...(command === 'list' ? {} : { vm: 'Sample One' }),
})

function adapter() {
  return new VmAdapter({ vmAllowedRoots: [root], vmInventory: [{ name: 'Sample One', vmx }] }, {
    async realpath(path) {
      if (path.endsWith('missing.vmx')) throw new Error('missing')
      return path.endsWith('alias.vmx') ? 'D:\\outside\\aliased.vmx' : path
    },
    async stat(path) { return { isFile: () => path.toLowerCase().endsWith('.vmx'), isDirectory: () => path === root } },
  }, async () => [])
}

test('VMX targets require a local absolute path, and root matching is component-aware', () => {
  for (const path of ['..\\a.vmx', root + '\\..\\a.vmx', '\\\\server\\share\\a.vmx', root + '\\a.txt',
    root + '\\a.vmx:stream', root + '\\.. \\a.vmx', '\\\\?\\C:\\VM-QA\\a.vmx']) {
    assert.throws(() => localVmPath(path), { code: 'vmx-invalid-path' })
  }
  assert.ok(insideVmRoot(vmx.toUpperCase(), root.toLowerCase()))
  assert.equal(insideVmRoot(root + '-copy\\a.vmx', root), false)
})

test('registered names and canonical paths resolve, copies and links outside the roots are denied', async () => {
  const catalog = adapter()
  const notRunning = async () => []
  assert.equal(await catalog.resolveVm('sample one', notRunning), vmx)
  assert.equal(await catalog.resolveVm(vmx.replaceAll('\\', '/'), notRunning), vmx)
  await assert.rejects(catalog.resolveVm(root + '\\copy.vmx', notRunning), { code: 'vmx-not-allowlisted' })
  await assert.rejects(catalog.resolveVm(root + '\\alias.vmx', notRunning), { code: 'vmx-root-denied' })
  await assert.rejects(catalog.resolveVm(root + '\\missing.vmx', notRunning), { code: 'vmx-not-found' })
  const runningVmx = root + '\\Running.vmx'
  assert.equal(await catalog.resolveVm('Running', async () => [runningVmx]), runningVmx)
})

test('Workstation inventory parser admits only known fields', () => {
  const text = [
    'vmlist2.config = "' + vmx + '"',
    'vmlist2.DisplayName = "Sample One"',
    'other.config = "' + root + '\\Copy.vmx"',
    'vmlist3.config = "\\\\server\\share\\Unsafe.vmx"',
    'pref.mruVM0.filename = "' + root + '\\Recent.vmx"',
  ].join('\n')
  assert.deepEqual(parseVmInventory(text), [{ name: 'Sample One', vmx }, { name: 'Recent', vmx: root + '\\Recent.vmx' }])
})

test('vmrun vectors are fixed and reject command/credential additions', () => {
  assert.deepEqual(vmrunArguments('list'), ['-T', 'ws', 'list'])
  assert.deepEqual(vmrunArguments('start', vmx), ['-T', 'ws', 'start', vmx, 'nogui'])
  for (const command of ['stop', 'suspend', 'reset'] as const) assert.deepEqual(vmrunArguments(command, vmx), ['-T', 'ws', command, vmx])
  assert.throws(() => vmrunArguments('list', vmx))
  assert.throws(() => vmCommandInputSchema.parse({ ...input('start'), argv: ['-gu', 'x'] }))
})

function fixture() {
  const calls: VmwareCommandRequest[] = []
  const state: DesktopRuntimeState = {
    backend: 'windows-child-session', isolated: true, status: 'enabled', epoch: 2, connectionId: randomUUID(),
    parentSessionId: 1, childSessionId: 2, foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
    window: { id: randomUUID(), app: 'vmware.exe', title: 'VMware Workstation', pid: 17, imagePath: app, x: 0, y: 0, width: 400, height: 400 },
    capabilities: { windowCapture: true, desktopCapture: false, regionCapture: true, clipboard: false, autonomousTask: false },
  }
  const result: VmwareCommandResult = {
    status: 'confirmed', state: 'running', vmx, vmPid: 31, exitCode: 0, elapsedMs: 3, message: 'verified',
    childSessionId: 2, evidence: { vmrunList: [vmx], processCheck: [{ pid: 31, vmxPath: vmx, cpuMs: 2 }] },
    argv: vmrunArguments('start', vmx), vmrunPid: 37, stdout: '', stderr: '', fallbackAllowed: false,
  }
  const service = new VmCommandService({
    async status() { return structuredClone(state) },
    async appCommand(request, _scope, _signal, beforeDispatch?: () => void) {
      beforeDispatch?.()
      calls.push(request)
      return request.command === 'list' ? { ...structuredClone(result), vmx: null, vmPid: null,
        state: 'listed', runningCount: 1, argv: vmrunArguments('list') } : structuredClone(result)
    },
  }, adapter(), async () => app)
  const grant: VmPowerAuthorization = { eligible: () => true, approve: async () => () => true }
  return { state, result, service, calls, grant }
}

test('read-only list needs no power approval, and restricted power attempts do not reach AppBroker', async () => {
  const f = fixture()
  const list = await f.service.execute(input('list'), undefined, signal())
  assert.equal(list.status, 'confirmed')
  assert.equal(list.state, 'listed')
  assert.equal(list.runningCount, 1)
  assert.equal((await f.service.execute(input('start'), undefined, signal())).status, 'needs_authorization')
  assert.deepEqual(f.calls.map(call => call.command), ['list'])
})

test('list distinguishes an unavailable VMware installation from a missing PiP binding', async () => {
  const { state } = fixture()
  state.window = null
  const native = {
    async status() { return state },
    async appCommand(): Promise<VmwareCommandResult> { throw new Error('app broker must stay idle') },
  }
  const missing = new VmCommandService(native, adapter(), async () => {
    throw new VmCommandError('vmware-not-installed', 'VMware Workstation unavailable')
  })
  assert.equal((await missing.execute(input('list'), undefined, signal())).code, 'vmware-not-installed')
  const present = new VmCommandService(native, adapter(), async () => app)
  const result = await present.execute(input('list'), undefined, signal())
  assert.equal(result.code, 'vmware-binding-required')
  assert.equal(result.nextTool, 'desktop_open_application')
})

test('duplicate operationId returns its receipt and cannot replay after rebind', async () => {
  const f = fixture()
  const request = input('start')
  const a = await f.service.execute(request, f.grant, signal())
  assert.deepEqual(await f.service.execute(request, f.grant, signal()), a)
  assert.equal((await f.service.execute({ ...request, command: 'stop' }, f.grant, signal())).code, 'operation-id-conflict')
  f.state.epoch++
  assert.equal((await f.service.execute(request, f.grant, signal())).code, 'authorization-changed')
  assert.equal(f.calls.length, 1)
})

test('permission or epoch changed during approval blocks dispatch', async () => {
  const f = fixture()
  const denied = await f.service.execute(input('start'), { ...f.grant, approve: async () => () => false }, signal())
  assert.equal(denied.status, 'needs_authorization')
  const changed = await f.service.execute(input('start'), { ...f.grant, approve: async () => {
    f.state.epoch++
    return () => true
  } }, signal())
  assert.equal(changed.code, 'authorization-changed')
  assert.equal(f.calls.length, 0)
})

test('vmrun errors preserve codes; only explicit and safe failure enters the UI path', async () => {
  const f = fixture()
  Object.assign(f.result, { status: 'failed', state: 'unknown', code: 'vmrun-missing', fallbackAllowed: true })
  assert.equal((await f.service.execute(input('start'), f.grant, signal())).degraded, undefined)
  const fallback = await f.service.execute({ ...input('start'), fallback: 'ui' }, f.grant, signal())
  assert.equal(fallback.code, 'vmrun-missing')
  assert.equal(fallback.degraded, true)
  assert.equal(fallback.nextTool, 'desktop_get_screenshot')

  Object.assign(f.result, { code: 'vmx-locked', fallbackAllowed: false })
  const locked = await f.service.execute({ ...input('start'), fallback: 'ui' }, f.grant, signal())
  assert.equal(locked.code, 'vmx-locked')
  assert.equal(locked.degraded, undefined)
  Object.assign(f.result, { status: 'unknown', code: 'timeout' })
  const timedOut = await f.service.execute({ ...input('start'), fallback: 'ui' }, f.grant, signal())
  assert.equal(timedOut.code, 'timeout')
  assert.equal(timedOut.degraded, undefined)
  assert.equal(timedOut.nextToolArgs?.command, 'list')
})
