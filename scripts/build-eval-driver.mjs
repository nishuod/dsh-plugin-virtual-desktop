import {build} from 'esbuild'
import {mkdir,copyFile,cp,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import sharp from 'sharp'

// Source checkout only. Dedicated output; never modifies lib or installed packages.
const output=resolve('artifacts/eval-live')
await mkdir(join(output,'fixture'),{recursive:true})
if(process.platform!=='win32')throw new Error('Live fixture build requires Windows')
const executable=join(output,'fixture','dsh-desktop-fixture.exe')
const compiler=join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe')
execFileSync(compiler,['/nologo','/target:winexe','/platform:x64',`/out:${executable}`,
  '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',
  `/win32manifest:${resolve('tests/fixtures/fixture.manifest')}`,resolve('tests/fixtures/DesktopFixture.cs')],{stdio:'inherit',windowsHide:true})
const fixture=await readFile(executable)
const manifest={name:'repository-owned-desktop-fixture',sha256:createHash('sha256').update(fixture).digest('hex')}
const referenceFlag=process.argv.indexOf('--visual-reference')
const reference=referenceFlag===-1?'evidence/b4/vmware-home.jpg':process.argv[referenceFlag+1]
if(!reference)throw new Error('--visual-reference requires the path of a reviewed VMware Home JPEG')
const referenceBytes=await readFile(reference).catch(error=>{
  if(error.code==='ENOENT'&&referenceFlag===-1)return undefined
  throw error
})
if(referenceBytes){
  const image=sharp(referenceBytes)
  const {width,height}=await image.metadata()
  if(width!==1280||height!==808)throw new Error('Reviewed VMware Home image must use 1280x808 JPEG coordinates')
  const crop=await image.extract({left:655,top:230,width:152,height:145}).removeAlpha().toColourspace('srgb').raw().toBuffer()
  await writeFile(join(output,'fixture','vmware-open-card.rgb'),crop)
  manifest.cardReferenceSha256=createHash('sha256').update(crop).digest('hex')
}
await writeFile(join(output,'fixture-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
await cp('lib/child-session-host',join(output,'child-session-host'),{recursive:true})
await build({entryPoints:{driver:'evals/owned-fixture-driver.mjs','child-session-bridge':'src/child-session-bridge.ts','native-worker':'src/native-worker.ts'},
  outdir:output,outExtension:{'.js':'.mjs'},bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',sourcemap:false})
// The runtime resolves the fixed companion .js names, independently of driver name.
await copyFile(join(output,'child-session-bridge.mjs'),join(output,'child-session-bridge.js'))
await copyFile(join(output,'native-worker.mjs'),join(output,'native-worker.js'))
console.log(`Built opt-in fixture driver: ${join(output,'driver.mjs')}`)
