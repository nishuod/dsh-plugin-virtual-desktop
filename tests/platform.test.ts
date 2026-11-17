import test from 'node:test'
import assert from 'node:assert/strict'
import { platformSupport } from '../src/platform.ts'

test('platform declaration supports only Windows x64 with structured friendly rejection', () => {
  assert.equal(platformSupport('win32', 'x64').supported, true)
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'arm64'], ['win32', 'ia32']] as const) {
    const result = platformSupport(platform, arch)
    assert.equal(result.supported, false)
    assert.equal(result.reason, 'unsupported-platform')
    assert.match(result.message, /Windows 10\/11 x64/)
  }
})
