// Read-only smoke check of the installed package using Desktop's Electron-as-Node runtime.
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {writeFile} from 'node:fs/promises'
const installed=join(process.env.USERPROFILE,'.dsh/profiles/desktop/node_modules/dsh-plugin-virtual-desktop')
const {NativeClient}=await import(pathToFileURL(join(installed,'lib/native-client.js')).href)
const client=new NativeClient(20000)
const signal=AbortSignal.timeout(45000)
try {
  if(!process.versions.electron)throw Error('Expected the installed Desktop Electron runtime')
  await client.call('enable',{frameAgeMs:60000,maxDimension:1280,imageBytes:512000},signal)
  const windows=await client.call('windows',null,signal)
  const fixture=windows.filter(w=>w.title==='DSH Desktop Test Fixture')
  if(fixture.length!==1)throw Error('Expected exactly one owned fixture')
  await client.call('select',{windowId:fixture[0].id,foreground:false},signal)
  const frame=await client.call('capture',{source:'window'},signal)
  await client.call('stop',null,signal)
  const receipt={passed:true,electron:process.versions.electron,node:process.versions.node,installedPackage:installed,window:fixture[0].title,image:{width:frame.width,height:frame.height},nativeInputSent:false}
  await writeFile('evidence/electron-smoke.json',JSON.stringify(receipt,null,2))
  console.log(JSON.stringify(receipt))
} finally {await client.close()}
