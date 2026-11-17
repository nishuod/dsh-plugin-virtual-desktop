import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateScenarios } from './eval-contract.mjs'

const scenarios = validateScenarios(JSON.parse(await readFile(new URL('../evals/scenarios.json', import.meta.url), 'utf8')))
const driverFlag = process.argv.indexOf('--driver')
const driverPath = driverFlag >= 0 ? process.argv[driverFlag + 1] : undefined
if (driverFlag >= 0 && !driverPath) throw new Error('--driver requires a local fixture-driver module')
const driver = driverPath ? await import(pathToFileURL(resolve(driverPath)).href) : undefined
if (driver && (typeof driver.runScenario !== 'function' || typeof driver.cleanup !== 'function')) throw new Error('Driver must export runScenario and cleanup')
const results = []
const runErrors = []
try {
  for (const scenario of scenarios) {
    if (!driver) { results.push({id: scenario.id, status: 'skipped', reason: 'No opt-in live fixture driver supplied'}); continue }
    const started = performance.now()
    try {
      const evidence = await driver.runScenario(structuredClone(scenario))
      if(evidence?.status==='skipped'){
        if(typeof evidence.reason!=='string'||!evidence.reason.trim())throw new Error('Driver skip must explain its missing capability or environment')
        results.push({id:scenario.id,status:'skipped',reason:evidence.reason,durationMs:Math.round(performance.now()-started)})
        continue
      }
      const failures = []
      if (evidence?.live !== true) failures.push('Driver did not attest a live Windows run')
      if (!evidence?.target?.pid || !evidence?.target?.childSessionId || !evidence?.target?.connectionId) failures.push('Missing isolated target identity')
      if (scenario.expected.reason) {
        if (evidence?.receipt?.reason !== scenario.expected.reason) failures.push(`Expected ${scenario.expected.reason}`)
        if (evidence?.inputDelivered !== false) failures.push('Failed action did not prove input was withheld')
      } else {
        if (evidence?.receipt?.outcome !== scenario.expected.outcome) failures.push('Unexpected action outcome')
        if (typeof evidence?.before?.uia !== 'string' || typeof evidence?.after?.uia !== 'string' || !evidence.before.uia || !evidence.after.uia) failures.push('Missing real UIA observations')
        else if (scenario.expected.uiaChanged && evidence.before.uia === evidence.after.uia) failures.push('UIA state change not demonstrated')
        if (!/^[a-f0-9]{64}$/i.test(evidence?.before?.screenshotSha256 ?? '') || !/^[a-f0-9]{64}$/i.test(evidence?.after?.screenshotSha256 ?? '')) failures.push('Missing observed screenshot hashes')
        else if (scenario.expected.screenshotHashChanged && evidence.before.screenshotSha256 === evidence.after.screenshotSha256) failures.push('Screenshot hash change not demonstrated')
        if (evidence?.assertionPassed !== true) failures.push('Scenario-specific expected state not verified')
      }
      results.push({id: scenario.id, status: failures.length ? 'failed' : 'passed', durationMs: Math.round(performance.now() - started), failures, evidence})
      console.log(`${scenario.id}: ${failures.length?'failed':'passed'}`)
    } catch (error) {
      results.push({id: scenario.id, status: 'failed', durationMs: Math.round(performance.now() - started),
        failures: [String(error)], ...(error?.evidence ? { evidence: error.evidence } : {})})
      console.log(`${scenario.id}: failed (${error?.evidence?.stage ?? 'driver'})`)
    }
  }
} catch(error) { runErrors.push({phase:'execution',message:String(error)}) }
finally {
  if(driver){
    try { await driver.cleanup() }
    catch(error) { runErrors.push({phase:'cleanup',message:String(error)}) }
  }
}
const count = status => results.filter(result => result.status === status).length
const executed = count('passed') + count('failed')
const report = {timestamp: new Date().toISOString(), kind: driver ? 'opt-in-live-driver' : 'unverified-scenario-catalog',
  runStatus:runErrors.length||count('failed')?'failed':count('skipped')?'incomplete':'passed',runErrors,
  total: scenarios.length, executed, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), passRate: executed ? count('passed') / executed : null, coverage: executed / scenarios.length, results}
await mkdir('artifacts/evals', {recursive: true})
await writeFile('artifacts/evals/latest.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({...report, results: undefined}, null, 2))
if (report.failed || report.runErrors.length || process.argv.includes('--require-live') && report.skipped) process.exitCode = 1
