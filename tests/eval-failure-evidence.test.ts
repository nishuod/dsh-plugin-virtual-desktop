import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {scenarioRefusal} from '../evals/owned-fixture-driver.mjs'

test('live failure evidence accepts only the guard for its scenario, never an unrelated exception',()=>{
  const guards=[
    ['failure-15-minimized','minimized','目标窗口已最小化；请调用 desktop_restore_window'],
    ['failure-16-resized','request-failed','窗口位置或焦点已改变，请重新观察'],
    ['failure-18-revoked','request-failed','输入许可未开启'],
    ['failure-19-reused-frame','request-failed','截图已过期、被替换或已用于输入，请重新观察'],
  ]
  for(const [id,reason,message] of guards){
    assert.deepEqual(scenarioRefusal(id,Object.assign(new Error(message),{reason})),{reason,message})
    assert.throws(()=>scenarioRefusal(id,new TypeError('unrelated bug')))
    assert.throws(()=>scenarioRefusal(id,new TypeError(message)))
    assert.throws(()=>scenarioRefusal(id,new Error('a different failure')))
    assert.throws(()=>scenarioRefusal(id,Object.assign(new Error(message),{reason:'transport-disconnected'})))
  }
  assert.throws(()=>scenarioRefusal('failure-15-minimized',new Error(guards[0][2])))
  assert.throws(()=>scenarioRefusal('unknown-scenario',new Error('unrelated')))
})

test('eval persists a current failed run after cleanup failure without erasing per-scenario counts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-eval-failure-evidence-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  const output=join(directory,'artifacts','evals')
  await mkdir(output,{recursive:true})
  const path=join(output,'latest.json')
  await writeFile(path,JSON.stringify({timestamp:'stale',runStatus:'passed',passed:20}))
  const driver=join(directory,'synthetic-driver.mjs')
  // Tests the reporter only. It never loads NativeSession or opens a desktop.
  await writeFile(driver,`
    export async function runScenario(scenario){
      if(scenario.id!=='failure-18-revoked')return {status:'skipped',reason:'Synthetic reporter test'}
      return {live:true,target:{pid:1,childSessionId:2,connectionId:'synthetic'},receipt:{reason:'request-failed'},inputDelivered:false}
    }
    export async function cleanup(){throw new Error('synthetic cleanup failure')}
  `)
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/eval.mjs',import.meta.url)),'--driver',driver],
    {cwd:directory,encoding:'utf8',windowsHide:true,timeout:15000})
  assert.equal(result.error,undefined)
  assert.equal(result.status,1,result.stderr)
  const report=JSON.parse(await readFile(path,'utf8'))
  assert.notEqual(report.timestamp,'stale');assert.ok(Number.isFinite(Date.parse(report.timestamp)))
  assert.equal(report.runStatus,'failed')
  assert.deepEqual(report.runErrors,[{phase:'cleanup',message:'Error: synthetic cleanup failure'}])
  assert.equal(report.executed,1);assert.equal(report.passed,1);assert.equal(report.failed,0);assert.equal(report.skipped,19)
  assert.match(result.stdout,/synthetic cleanup failure/)
})
