import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp,readFile,writeFile,mkdir,realpath} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {verifyTarball} from './verify-package.mjs'

// A fresh dependency tree on this machine, not a clean Windows/registry acceptance test.
// No desktop capture, application launch, user-profile modification or publication.
if(!process.env.npm_execpath)throw new Error('Run npm run verify:install -- <candidate.tgz>')
if(!process.argv[2])throw new Error('A candidate .tgz path is required')
const tarball=await realpath(resolve(process.argv[2])),verified=await verifyTarball(tarball)
assert.equal(verified.package,'dsh-plugin-virtual-desktop')
const manifest=JSON.parse(await readFile('package.json','utf8'))
const directory=await mkdtemp(join(tmpdir(),'dsh-virtual-desktop-install-'))
const output=resolve('artifacts/install-smoke');await mkdir(output,{recursive:true})
const report={timestamp:new Date().toISOString(),kind:'isolated-local-tarball-install',version:verified.version,
  sha256:createHash('sha256').update(await readFile(tarball)).digest('hex'),directory,status:'failed',cleanMachine:false,registryPackage:false}
await writeFile(join(directory,'package.json'),JSON.stringify({name:'dsh-release-install-smoke',private:true,type:'module'}))
const hostPackages=['@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tool-executor-native']
try{
  const log=execFileSync(process.execPath,[process.env.npm_execpath,'install','--ignore-scripts','--no-audit','--no-fund',
    '--registry=https://registry.npmjs.org/',tarball,...hostPackages.map(name=>`${name}@${manifest.devDependencies[name]}`)],
    {cwd:directory,encoding:'utf8',windowsHide:true,timeout:300000,env:{...process.env,NODE_PATH:''}})
  await writeFile(join(output,'install.log'),log)
  const probe=String.raw`
import assert from 'node:assert/strict'
import {realpath,readFile,access} from 'node:fs/promises'
import {dirname,join,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import * as plugin from 'dsh-plugin-virtual-desktop'
const root=await realpath(process.cwd()),entry=await realpath(fileURLToPath(import.meta.resolve('dsh-plugin-virtual-desktop')))
const within=relative(root,entry);assert.ok(!within.startsWith('..')&&!isAbsolute(within),'Plugin resolved outside isolated install')
const lib=dirname(entry),pkg=JSON.parse(await readFile(join(lib,'..','package.json'),'utf8'))
for(const path of ['worker.js','native-worker.js','child-session-bridge.js','child-session-host/ChildSessionHost.exe','cordis.patch.yml'])await access(join(lib,path))
// Check native dependencies from this installed tree without accessing the desktop.
const sharp=(await import('sharp')).default
await sharp({create:{width:2,height:2,channels:3,background:'#000000'}}).png().toBuffer()
const koffi=(await import('koffi')).default
if(process.platform==='win32')assert.equal(koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentProcessId()')(),process.pid)
await import('@trycua/cua-driver')
const ctx=new Context()
try{
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolRuntime,{})
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(plugin,{})
  const {results}=await ctx.tools.execute({calls:[{type:'tool-call',id:'install-diagnostics',name:'desktop_get_diagnostics',arguments:'{}'}],signal:AbortSignal.timeout(10000)})
  const result=results[0].result;assert.equal(result.isError,false)
  assert.equal(result.value.diagnosticChannel.status,'ready')
  assert.equal(result.value.desktop.status,'disabled');assert.equal(result.value.desktop.activeBackend,null)
  const build=result.value.plugin
  assert.equal(build?.version,pkg.version)
  assert.match(build.buildHash,/^[0-9a-f]{12}$/)
  assert.ok(Number.isFinite(Date.parse(build.builtAt)))
  const tools=ctx.tools.schemas().filter(tool=>tool.name.startsWith('desktop_'))
  assert.equal(tools.length,23)
  const resetTool=tools.find(tool=>tool.name==='desktop_reset_child_session')
  assert.deepEqual(Object.keys(resetTool.parameters.properties),['operationId'])
  const resetCall=await ctx.tools.execute({calls:[{type:'tool-call',id:'install-idle-reset',name:resetTool.name,arguments:'{}'}],signal:AbortSignal.timeout(10000)})
  const resetResult=resetCall.results[0].result;assert.equal(resetResult.isError,false)
  const reset=JSON.parse(resetResult.content.find(block=>block.type==='text').text)
  assert.equal(reset.state,'idle');assert.deepEqual(reset.releasedPids,[])
  console.log(JSON.stringify({version:pkg.version,plugin:build,diagnosticChannel:'ready',desktop:'disabled',activeBackend:null,tools:tools.length,nativeDependenciesLoaded:true,idleReset:reset.state}))
}finally{await ctx.fiber.dispose()}
`
  await writeFile(join(directory,'probe.mjs'),probe)
  const result=execFileSync(process.execPath,['probe.mjs'],{cwd:directory,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,NODE_PATH:''}})
  report.probe=JSON.parse(result.trim().split(/\r?\n/).at(-1));assert.equal(report.probe.version,verified.version)
  report.status='passed'
}catch(error){
  report.error=String(error)
  await writeFile(join(output,'failure.log'),String(error.stdout??'')+'\n'+String(error.stderr??'')+'\n'+String(error))
  process.exitCode=1
}finally{
  await writeFile(join(output,'latest.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}
