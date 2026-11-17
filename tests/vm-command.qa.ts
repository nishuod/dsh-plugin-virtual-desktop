import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { win32 } from 'node:path'
import type { DesktopFrame, DesktopRuntimeState } from '../src/native-contract.ts'

const appId = 'vmware-workstation'
const commandTool = 'desktop_vm_command'
type QaToolResult = { isError: boolean; content: string; raw: { value?: unknown } }
type Invoke = (name: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<QaToolResult>
type Fixture = { root: string; vmx: string; name: string; marker: string }
type ProcessEvidence = { pid: number; vmxPath: string; cpuMs: number | null }
type VmReceipt = {
  status: string
  state: string
  code?: string
  runningCount?: number
  vmx?: string
  vmPid?: number
  exitCode?: number | null
  evidence: { vmrunList: string[]; processCheck: ProcessEvidence[] }
}

function samePath(a: string, b: string): boolean {
  return win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
}

async function verifyDisposableFixture(fixture: Fixture): Promise<void> {
  assert.ok(samePath(await realpath(fixture.vmx), fixture.vmx), 'The QA VMX now resolves to another path')
  assert.ok(samePath(await realpath(fixture.root), fixture.root), 'The QA directory now resolves to another path')
  assert.ok(samePath(win32.dirname(fixture.vmx), fixture.root), 'The QA VMX must stay in its private directory')
  const vmx = await readFile(fixture.vmx, 'utf8')
  const lines = vmx.split(/\r?\n/)
  assert.ok(lines.includes(`displayName = "${fixture.marker}"`), 'Disposable VM marker is missing')
  assert.ok(lines.includes('powerType.powerOff = "hard"'), 'The disposable no-guest VM must support powering off')
  assert.doesNotMatch(vmx, /(?:\.vmdk|\.vhdx?|\.iso)\b/i, 'A test VM must have no disk or ISO')
  assert.doesNotMatch(vmx, /^(?:ethernet|usb(?:_xhci)?|ehci|floppy|serial|parallel|ide|scsi|sata|nvme|sharedFolder|pciPassthru)[^\r\n]*\.present\s*=\s*"true"/im,
    'A test VM must have no external devices')
}

export async function prepareVmCommandQa(evidenceDirectory: string) {
  if (process.env.DSH_VD_VM_COMMAND_QA !== '1') return undefined
  const requestedVmx = process.env.DSH_VD_VM_COMMAND_QA_VMX || undefined
  const powerCycle = process.env.DSH_VD_VM_COMMAND_QA_POWER_CYCLE === '1'
  assert.ok(!requestedVmx || powerCycle, 'A QA VMX name requires explicit power-cycle mode')
  let fixture: Fixture | undefined
  if (powerCycle) {
    const name = `dsh-d6-qa-${randomUUID()}`
    const filename = requestedVmx ?? 'Disposable VMware QA.vmx'
    assert.match(filename, /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,75}\.vmx$/i,
      'The optional VMX value is a fresh filename, not an existing file path')
    assert.doesNotMatch(filename, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\s*\./i, 'Reserved DOS device filename')
    const fixtureDirectory = win32.join(evidenceDirectory, name)
    await mkdir(fixtureDirectory)
    const root = await realpath(fixtureDirectory)
    const marker = `DSH disposable ${name}`
    const vmx = win32.join(root, filename)
    const values = {
      '.encoding': 'UTF-8', 'config.version': '8', 'virtualHW.version': '19',
      displayName: marker, guestOS: 'other-64', memsize: '256', numvcpus: '1',
      'powerType.powerOff': 'hard', 'powerType.reset': 'hard', 'msg.autoAnswer': 'TRUE',
      'ide0.present': 'FALSE', 'ide1.present': 'FALSE', 'scsi0.present': 'FALSE',
      'sata0.present': 'FALSE', 'nvme0.present': 'FALSE', 'floppy0.present': 'FALSE',
      'ethernet0.present': 'FALSE', 'usb.present': 'FALSE', 'ehci.present': 'FALSE',
      'usb_xhci.present': 'FALSE', 'sound.present': 'FALSE', 'sharedFolder.maxNum': '0',
      'isolation.tools.hgfs.disable': 'TRUE', 'vmci0.present': 'FALSE', 'mks.enable3d': 'FALSE',
    }
    await writeFile(vmx, Object.entries(values).map(([key, value]) => `${key} = "${value}"\n`).join(''), { flag: 'wx' })
    fixture = { root, vmx, name, marker }
    await verifyDisposableFixture(fixture)
  }
  return {
    fixture,
    config: {
      vmAllowedRoots: fixture ? [fixture.root] : [],
      vmInventory: fixture ? [{ name: fixture.name, vmx: fixture.vmx }] : [],
    },
  }
}

function parseTool<T>(result: QaToolResult): T {
  assert.equal(result.isError, false, result.content)
  return JSON.parse(result.content) as T
}

export async function runVmCommandQa(options: {
  fixture: Fixture | undefined
  state: DesktopRuntimeState
  invoke: Invoke
  windows: { session(pid: number): number | null; image(pid: number): string }
  evidence: Record<string, unknown>
  stage(value: string): void
  withRestrictedPolicy(run: () => Promise<void>): Promise<void>
}) {
  const { fixture, state, invoke, windows, evidence, stage } = options
  const target = state.window
  const session = state.childSessionId
  assert.ok(target && session && state.connectionId && state.isolated)
  assert.equal(windows.session(target.pid), session)
  assert.match(windows.image(target.pid), /[\\/]vmware\.exe$/i)

  const commands: { command: string; operationId: string; receipt?: unknown; error?: string }[] = []
  evidence.vmCommand = { mode: fixture ? 'disposable-power-cycle' : 'list-only', fixture, commands }
  async function command(commandName: 'list' | 'start' | 'stop', cleanupSignal?: AbortSignal): Promise<VmReceipt> {
    if (commandName !== 'list') {
      assert.ok(fixture, 'Only the QA-owned fixture can receive a power command')
      await verifyDisposableFixture(fixture)
    }
    const operationId = randomUUID()
    const entry: (typeof commands)[number] = { command: commandName, operationId }
    commands.push(entry)
    try {
      const result = await invoke(commandTool, {
        appId, command: commandName, operationId,
        ...(commandName === 'list' ? {} : { vm: fixture!.name }),
      }, cleanupSignal)
      entry.receipt = result.content
      const receipt = parseTool<VmReceipt>(result)
      entry.receipt = receipt
      assert.equal(receipt.status, 'confirmed', result.content)
      assert.ok(Array.isArray(receipt.evidence.vmrunList) && Array.isArray(receipt.evidence.processCheck))
      if (commandName === 'list') {
        assert.equal(receipt.state, 'listed')
        assert.equal(receipt.runningCount, receipt.evidence.vmrunList.length)
        assert.equal(receipt.runningCount, receipt.evidence.processCheck.length)
      }
      return receipt
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function requireSameBinding(signal?: AbortSignal): Promise<void> {
    const current = parseTool<DesktopRuntimeState>(await invoke('desktop_get_task_status', {}, signal))
    assert.equal(current.connectionId, state.connectionId)
    assert.equal(current.childSessionId, session)
    assert.equal(current.epoch, state.epoch)
    assert.equal(current.window?.id, target!.id)
    assert.equal(current.window?.pid, target!.pid)
  }

  async function verifyMinimized(): Promise<void> {
    const screenshot = await invoke('desktop_get_screenshot')
    assert.equal(screenshot.isError, true, 'VMware capture still works, so minimized state is unproven')
    assert.equal(JSON.parse(screenshot.content).reason, 'minimized', screenshot.content)
    await requireSameBinding()
  }

  function fixtureProcesses(result: VmReceipt): ProcessEvidence[] {
    assert.ok(fixture)
    return result.evidence.processCheck.filter(entry => samePath(entry.vmxPath, fixture.vmx))
  }
  function fixtureInList(result: VmReceipt): boolean {
    assert.ok(fixture)
    return result.evidence.vmrunList.some(path => samePath(path, fixture.vmx))
  }

  stage('capture verified VMware window and minimize using the measured preview.12 caption point')
  const screenshot = await invoke('desktop_get_screenshot')
  assert.equal(screenshot.isError, false, screenshot.content)
  const frame = (screenshot.raw.value as { structuredContent?: DesktopFrame } | undefined)?.structuredContent
  assert.ok(frame?.scale, 'Screenshot needs capture geometry to run caption QA')
  assert.equal(frame.windowId, target.id)
  assert.deepEqual([target.width, target.height, frame.width, frame.height, frame.scale.rawWidth, frame.scale.rawHeight],
    [1359, 859, 1280, 808, 1357, 857], 'Caption QA uses only the previously measured VMware window geometry')
  const minimized = parseTool<{ outcome: string; postAction?: { reason: string } }>(await invoke('desktop_execute_action', {
    operationId: randomUUID(), frameId: frame.id, epoch: frame.epoch, delivery: 'background',
    action: { type: 'click', button: 'left', count: 1, x: 1144, y: 19 },
  }))
  evidence.vmCommandCaption = minimized
  assert.equal(minimized.outcome, 'delivered')
  assert.equal(minimized.postAction?.reason, 'minimized')
  await verifyMinimized()

  if (fixture) {
    stage('verify read-only list and reject start under a restricted never-ask policy')
    const rejected: Record<string, VmReceipt> = {}
    evidence.vmCommandRefusals = rejected
    async function expectRefusal(name: string, selector: string, code: string): Promise<void> {
      const result = await invoke(commandTool, { appId, command: 'start', operationId: randomUUID(), vm: selector })
      const receipt = parseTool<VmReceipt>(result)
      rejected[name] = receipt
      assert.equal(receipt.status, code === 'needs_authorization' ? 'needs_authorization' : 'failed')
      assert.equal(receipt.code, code)
    }
    await options.withRestrictedPolicy(async () => {
      const readonly = await command('list')
      assert.equal(fixtureInList(readonly), false)
      await expectRefusal('restricted', fixture.name, 'needs_authorization')
    })
    stage('reject UNC, traversal and a modified unregistered copy')
    await expectRefusal('unc', '\\\\qa-invalid\\share\\Other.vmx', 'vmx-invalid-path')
    await expectRefusal('traversal', fixture.root + '\\..\\Other.vmx', 'vmx-invalid-path')
    const copy = win32.join(fixture.root, 'Unregistered disposable copy.vmx')
    const text = await readFile(fixture.vmx, 'utf8')
    await writeFile(copy, text.replace(fixture.marker, 'Unregistered disposable copy'), { flag: 'wx' })
    await expectRefusal('modified-copy', copy, 'vmx-not-allowlisted')
  }

  let startIssued = false
  let provedStopped = false
  let powerError: unknown
  try {
    stage('list in verified PiP while VMware is minimized')
    const before = await command('list')
    await verifyMinimized()
    if (fixture) {
      assert.equal(fixtureInList(before), false, 'The fresh disposable fixture is already running')
      assert.equal(fixtureProcesses(before).length, 0, 'The fresh disposable fixture already has a process')

      stage('start only the disposable VMX while VMware is minimized')
      startIssued = true
      const started = await command('start')
      assert.equal(started.state, 'running')
      assert.ok(started.vmx && samePath(started.vmx, fixture.vmx))
      assert.equal(fixtureInList(started), true)
      const processes = fixtureProcesses(started)
      assert.equal(processes.length, 1)
      assert.equal(started.vmPid, processes[0].pid)
      assert.equal(windows.session(processes[0].pid), session)
      assert.match(windows.image(processes[0].pid), /[\\/]vmware-vmx\.exe$/i)
      assert.ok(processes[0].cpuMs !== null && processes[0].cpuMs > 0, 'VMX process should have executed CPU time')
      await verifyMinimized()

      stage('independently list the running disposable VMX')
      const running = await command('list')
      assert.equal(fixtureInList(running), true)
      assert.deepEqual(fixtureProcesses(running).map(entry => entry.pid), [started.vmPid])
      await verifyMinimized()

      stage('stop only the disposable VMX while VMware is minimized')
      const stopped = await command('stop')
      assert.equal(stopped.state, 'stopped')
      assert.ok(stopped.vmx && samePath(stopped.vmx, fixture.vmx))
      assert.equal(fixtureInList(stopped), false)
      assert.equal(fixtureProcesses(stopped).length, 0)
      const after = await command('list')
      assert.equal(fixtureInList(after), false)
      assert.equal(fixtureProcesses(after).length, 0)
      assert.deepEqual(after.evidence.vmrunList.map(path => path.toLowerCase()).sort(),
        before.evidence.vmrunList.map(path => path.toLowerCase()).sort(), 'Other list entries changed during this run')
      provedStopped = true
      await verifyMinimized()
    }
  } catch (error) {
    powerError = error
    throw error
  } finally {
    if (startIssued && !provedStopped) {
      // A failed or timed-out launch is never replayed. A separate cleanup stop
      // requires both sources to verify the one QA-owned process again.
      const cleanup = AbortSignal.timeout(55000)
      try {
        await requireSameBinding(cleanup)
        await verifyDisposableFixture(fixture!)
        const observed = await command('list', cleanup)
        const processes = fixtureProcesses(observed)
        if (fixtureInList(observed) && processes.length === 1 && windows.session(processes[0].pid) === session &&
          /[\\/]vmware-vmx\.exe$/i.test(windows.image(processes[0].pid))) {
          const stopped = await command('stop', cleanup)
          assert.equal(stopped.state, 'stopped')
          assert.equal(fixtureInList(stopped), false)
          assert.equal(fixtureProcesses(stopped).length, 0)
        } else {
          assert.equal(fixtureInList(observed), false)
          assert.equal(processes.length, 0)
        }
        evidence.vmCommandCleanup = 'verified stopped'
      } catch (error) {
        evidence.vmCommandCleanup = { error: error instanceof Error ? error.message : String(error) }
        if (!powerError) throw error
      }
    }
  }

  stage('restore same VMware PID and window after vmrun commands')
  const restored = parseTool<DesktopRuntimeState>(await invoke('desktop_restore_window', {
    connectionId: state.connectionId, epoch: state.epoch, windowId: target.id, pid: target.pid,
  }))
  assert.equal(restored.window?.id, target.id)
  assert.equal(restored.window?.pid, target.pid)
  const restoredFrame = await invoke('desktop_get_screenshot')
  assert.equal(restoredFrame.isError, false, restoredFrame.content)
  evidence.vmCommandRestored = { connectionId: restored.connectionId, epoch: restored.epoch, pid: target.pid, windowId: target.id }
}
