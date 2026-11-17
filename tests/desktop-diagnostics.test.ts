import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeDesktopConnection, pipProfile } from '../src/desktop-guidance.ts'
import type { DesktopRuntimeState } from '../src/native-contract.ts'

const inactive: DesktopRuntimeState = {
  backend: 'windows-attended', isolated: false, status: 'disabled', epoch: 0, window: null,
  foregroundAllowed: false, inputMode: 'ask-each-action', lastResult: '',
  capabilities: { windowCapture: true, desktopCapture: true, regionCapture: true, clipboard: false, autonomousTask: false },
}
const noCapture = { windowCapture: false, desktopCapture: false, regionCapture: false, clipboard: false, autonomousTask: false }

test('desktop diagnostics distinguish a pending or disconnected mode from the PiP profile', () => {
  for (const status of ['disabled', 'stopped', 'failed'] as const) {
    const disconnected = describeDesktopConnection({ ...inactive, status, connectionId: 'old-connection' })
    assert.equal(disconnected.backend, 'windows-attended')
    assert.equal(disconnected.activeBackend, null)
    assert.deepEqual(disconnected.capabilities, noCapture)
  }
  assert.equal(pipProfile.backend, 'windows-child-session')
  assert.equal(pipProfile.capabilities.desktopCapture, false)
  assert.equal(inactive.capabilities.desktopCapture, true)
})

test('desktop diagnostics show capture only when the current executor and target allow it', () => {
  const connected = { ...inactive, status: 'observing', connectionId: 'current-connection' } as const
  const attended = describeDesktopConnection(connected)
  assert.equal(attended.activeBackend, 'windows-attended')
  assert.equal(attended.capabilities.desktopCapture, true)
  assert.equal(attended.capabilities.windowCapture, false)
  assert.equal(attended.capabilities.regionCapture, true)

  const pip = { ...connected, backend: 'windows-child-session', isolated: true } as const
  const observing = describeDesktopConnection(pip)
  assert.equal(observing.activeBackend, 'windows-child-session')
  assert.deepEqual(observing.capabilities, noCapture)

  const enabled = { ...pip, status: 'enabled', window: { id: 'bound-window', pid: 1, title: '', app: '',
    x: 0, y: 0, width: 1, height: 1 } } as const
  assert.deepEqual(describeDesktopConnection(enabled).capabilities, pipProfile.capabilities)
  for (const status of ['pausing', 'paused', 'stopping'] as const) {
    const draining = describeDesktopConnection({ ...enabled, status })
    assert.equal(draining.activeBackend, 'windows-child-session')
    assert.deepEqual(draining.capabilities, noCapture)
  }
})
