// Opt-in overlay for an isolated DSH profile. Only the copied test fixture is eligible.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'

export const name = 'desktop-child-session-qa'
export const inject = ['virtualDesktop']

function sessionOf(pid) {
  const kernel = koffi.load('kernel32.dll')
  const getSession = kernel.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t* session)')
  const session = [0]
  assert.ok(getSession(pid, session), 'Cannot verify process session')
  return session[0]
}

export function apply(ctx) {
  const directory = process.env.DSH_VD_CHILD_QA
  if (!directory || !isAbsolute(directory)) throw new Error('The child QA overlay requires an isolated evidence directory')
  void run(ctx.virtualDesktop, directory).then(passed => { process.exit(passed ? 0 : 1) })
}

async function run(service, directory) {
  const signal = AbortSignal.timeout(150000)
  const evidence = { passed: false, parentSessionId: sessionOf(process.pid), actions: [] }
  const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'))
  const write = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
  const fixture = () => read('child-fixture/fixture-state.json')
  async function waitFor(callback) {
    for (;;) {
      signal.throwIfAborted()
      const value = await callback()
      if (value) return value
      await delay(100, undefined, { signal })
    }
  }
  const capture = () => service.capture('window', '', signal)
  try {
    const initial = await service.desktopStatus(signal)
    assert.equal(initial.status, 'disabled')
    const connected = await service.enableChildSession(signal)
    assert.equal(connected.backend, 'windows-child-session')
    assert.equal(connected.isolated, true)
    assert.equal(connected.parentSessionId, evidence.parentSessionId)
    assert.notEqual(connected.childSessionId, connected.parentSessionId)
    evidence.childSessionId = connected.childSessionId
    await assert.rejects(service.enableLocal(signal), /切换模式/)
    await assert.rejects(service.capture('desktop', '', signal), /只采集/)
    const baseline = await waitFor(() => fixture().catch(() => null))
    assert.equal(sessionOf(baseline.pid), connected.childSessionId)
    assert.deepEqual([baseline.clicks, baseline.wheels, baseline.text], [0, 0, ''])
    const options = await service.windows(signal)
    assert.ok(options.length > 0 && options.every(window => sessionOf(window.pid) === connected.childSessionId))
    const targets = options.filter(window => window.pid === baseline.pid && window.title === 'DSH Desktop Test Fixture')
    assert.equal(targets.length, 1)
    const target = targets[0]
    await service.selectWindow(target.id, false, signal)
    await write('selected.json', { pid: baseline.pid, childSessionId: connected.childSessionId })
    // The operator focuses the known child fixture, switches to the host fixture, and arms the observation.
    await waitFor(() => read('input-start.json').catch(() => null))

    async function execute(type, control, fields) {
      const frame = await capture()
      const before = await fixture()
      const x = Math.floor((before[control + 'X'] - target.x) * frame.width / target.width)
      const y = Math.floor((before[control + 'Y'] - target.y) * frame.height / target.height)
      const operation = {
        operationId: randomUUID(), frameId: frame.id, epoch: frame.epoch,
        // Deliberately request the unapproved host route; the PiP policy determines actual delivery.
        delivery: 'foreground',
        action: { type, x, y, ...fields },
      }
      const receipt = await service.manualAction(JSON.stringify(operation), signal)
      assert.equal(receipt.outcome, 'delivered', receipt.message)
      assert.equal(receipt.after?.windowId, target.id)
      evidence.actions.push({ type, outcome: receipt.outcome })
      return operation
    }

    const wanted = 'Harness 画中画试验 · 中文 ✓'
    const beforeInput = await capture()
    await assert.rejects(service.manualAction(JSON.stringify({
      operationId: randomUUID(), frameId: beforeInput.id, epoch: beforeInput.epoch,
      delivery: 'foreground', action: { type: 'move', x: 20, y: 20 },
    }), signal), /画中画|子会话/)
    await execute('click', 'button', {})
    await execute('type', 'text', { text: wanted })
    const oldOperation = await execute('scroll', 'scroll', { direction: 'down', amount: 3 })
    const saved = await waitFor(async () => {
      const value = await fixture()
      return value.clicks === 1 && value.wheels > 0 && value.text === wanted ? value : null
    })
    evidence.saved = { clicks: saved.clicks, wheels: saved.wheels, text: saved.text }
    await write('input-verified.json', evidence.saved)

    const paused = await service.control('pause', signal)
    assert.equal(paused.status, 'paused')
    const resumed = await service.control('resume', signal)
    assert.equal(resumed.status, 'enabled')
    await assert.rejects(service.manualAction(JSON.stringify({ ...oldOperation, operationId: randomUUID() }), signal))
    await write('disconnect-ready.json', { childSessionId: connected.childSessionId })
    const failed = await waitFor(async () => {
      const state = await service.desktopStatus(signal)
      return state.status === 'failed' ? state : null
    })
    assert.equal(failed.backend, 'windows-child-session')
    assert.equal(failed.isolated, false)
    assert.equal(failed.window, null)
    await assert.rejects(service.manualAction(JSON.stringify({ ...oldOperation, operationId: randomUUID() }), signal))
    evidence.disconnected = true
    evidence.passed = true
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
  } finally {
    await service.control('stop', AbortSignal.timeout(18000)).catch(() => {})
    await write('harness-qa.json', evidence)
  }
  return evidence.passed
}
