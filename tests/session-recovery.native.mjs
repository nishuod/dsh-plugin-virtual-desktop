import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Safe native negative tests: every request exits before WTS logoff can be reached.
const executable = resolve(process.argv[2] ?? 'artifacts/recovery-host-test/ChildSessionHost.exe')
const directory = await mkdtemp(join(tmpdir(), 'dsh-recovery-negative-'))
const token = randomUUID()
const outcomes = []
try {
  await writeFile(join(directory, 'broker-config.json'), JSON.stringify({ recoveryToken: token }))
  const run = requestToken => spawnSync(executable, ['--reset-owned', directory, requestToken], { encoding: 'utf8', windowsHide: true })
  const mismatch = run(randomUUID())
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stdout, /capability mismatch/)
  outcomes.push('rejects wrong ownership capability')
  assert.equal(run(token).status, 0)
  outcomes.push('no owned record is a no-op, never claims foreign association')
  await writeFile(join(directory, 'owned-session.json'), JSON.stringify({ version: 1, token, directory,
    parentSessionId: -1, childSessionId: 2, logonTime: 1, brokerPid: process.pid, brokerBirth: 1,
    executable, nonce: '0'.repeat(64) }))
  const foreign = run(token)
  assert.equal(foreign.status, 1)
  assert.match(foreign.stdout, /not owned/)
  assert.equal(JSON.parse(foreign.stdout).association, 'unknown')
  outcomes.push('rejects foreign parent without logoff or process kill')
  console.log(JSON.stringify({ passed: true, nativeMutation: false, outcomes }, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}
