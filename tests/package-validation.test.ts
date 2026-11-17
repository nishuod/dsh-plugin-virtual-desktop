import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore build-only ESM helper
import { validatePackageEntries } from '../scripts/verify-package.mjs'
// @ts-ignore build-only ESM helper
import { validateScenarios } from '../scripts/eval-contract.mjs'
import { readFileSync } from 'node:fs'

const runtime = ['package.json', 'lib/index.js', 'lib/client.js', 'lib/cordis.patch.yml', 'lib/child-session-host/ChildSessionHost.exe', 'lib/types/index.d.ts',
  'docs/PUBLIC-API.md', 'docs/PUBLIC-API.schema.json', 'docs/PUBLIC-API.responses.schema.json', 'docs/PUBLIC-API.config.schema.json', 'docs/PRIVACY.md', 'docs/SECURITY.md'].map(path => ({path}))
test('release package permits declarations but rejects source, maps and private directories', () => {
  assert.deepEqual(validatePackageEntries(runtime), [])
  for (const path of ['src/index.ts', 'evidence/frame.png', 'artifacts/archive.tgz', 'docs/Artifacts/archive.tgz', 'lib/index.js.map', 'lib/source.ts', 'lib/tests/private.json', 'lib/../secret']) {
    assert.ok(validatePackageEntries([...runtime, {path}]).length > 0, path)
  }
  assert.ok(validatePackageEntries([...runtime, {path: 'lib/index.js', data: Buffer.from('//# sourceMappingURL=data:application/json;base64,e30=')}]).length > 0)
})
test('release package must resolve runtime entry points and never carry local dependencies', () => {
  assert.ok(validatePackageEntries(runtime, {main: './lib/missing.js'}).some((error: string) => error.includes('Unresolved')))
  assert.ok(validatePackageEntries(runtime, {dependencies: {bad: 'file:C:/private.tgz'}}).some((error: string) => error.includes('Local')))
  assert.ok(validatePackageEntries(runtime.filter(entry => !entry.path.endsWith('.exe'))).some((error: string) => error.includes('runtime missing')))
  assert.ok(validatePackageEntries(runtime.filter(entry => entry.path !== 'package.json')).some((error: string) => error.includes('runtime missing')))
  assert.ok(validatePackageEntries([...runtime,...runtime]).some((error: string) => error.includes('Duplicate')))
})

test('release package fails closed when a public API or privacy/security document is absent', () => {
  for (const path of ['docs/PUBLIC-API.md', 'docs/PUBLIC-API.schema.json', 'docs/PUBLIC-API.responses.schema.json', 'docs/PUBLIC-API.config.schema.json', 'docs/PRIVACY.md', 'docs/SECURITY.md']) {
    const errors = validatePackageEntries(runtime.filter(entry => entry.path !== path))
    assert.ok(errors.includes(`Required release document missing: ${path}`), path)
  }
})

test('evaluation catalog rejects missing assertions and duplicate cases', () => {
  const catalog = JSON.parse(readFileSync(new URL('../evals/scenarios.json', import.meta.url), 'utf8'))
  assert.equal(validateScenarios(catalog).length, 20)
  assert.throws(() => validateScenarios(catalog.slice(1)))
  const duplicate = structuredClone(catalog); duplicate[1].id = duplicate[0].id
  assert.throws(() => validateScenarios(duplicate))
  const noEvidence = structuredClone(catalog); noEvidence[0].expected.uiaChanged = false
  assert.throws(() => validateScenarios(noEvidence))
})
