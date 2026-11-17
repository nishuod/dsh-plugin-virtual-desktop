import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { win32 } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { CuaDriver } from '@trycua/cua-driver'
import { WindowsIdentity } from '../src/windows-identity.ts'
import koffi from 'koffi'
import { maskScreenshot, scanPasswordRegions } from '../src/privacy.ts'

if(process.platform!=='win32')throw new Error('Windows integration requires Windows')
const fixture=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public static class FixtureShow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command); }'
$form=New-Object System.Windows.Forms.Form
$form.Text='DSH privacy test fixture';$form.Width=440;$form.Height=210
$form.StartPosition='CenterScreen';$form.BackColor=[System.Drawing.Color]::White
$label=New-Object System.Windows.Forms.Label
$label.Text='Controlled synthetic password fixture';$label.Left=25;$label.Top=25;$label.Width=350
$field=New-Object System.Windows.Forms.TextBox
$field.UseSystemPasswordChar=$true;$field.Text='SyntheticSecret123';$field.Left=25;$field.Top=65;$field.Width=340
$button=New-Object System.Windows.Forms.Button
$button.Text='Public button 隐私';$button.Left=25;$button.Top=110;$button.Width=160
$form.Controls.AddRange(@($label,$field,$button))
$form.Add_Shown({[void][FixtureShow]::ShowWindow($form.Handle,5);[Console]::WriteLine((@{hwnd=$form.Handle.ToInt64().ToString();fieldHwnd=$field.Handle.ToInt64().ToString();labelHwnd=$label.Handle.ToInt64().ToString();pid=$PID}|ConvertTo-Json -Compress))})
$timer=New-Object System.Windows.Forms.Timer;$timer.Interval=45000;$timer.Add_Tick({$form.Close()});$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`
const child=spawn(win32.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fixture,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']})
child.stderr?.on('data',()=>{})
let driver:ReturnType<typeof CuaDriver.create>|undefined
try{
  const raw=await Promise.race([once(child.stdout!,'data').then(([v])=>String(v)),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture startup timeout')),10000);timer.unref()})])
  const target=JSON.parse(raw)
  await new Promise(resolve=>setTimeout(resolve,500))
  new WindowsIdentity()
  driver=CuaDriver.create(undefined)
  const capture=await driver.getWindowState({pid:target.pid,windowId:BigInt(target.hwnd),includeScreenshot:true,includeAccessibilityTree:true,maxDimension:4096})
  const scan=await scanPasswordRegions(target.hwnd,target.pid)
  assert.equal(scan.complete,true)
  assert.equal(scan.passwordRegions.length,1,JSON.stringify(scan))
  assert.ok(scan.targets?.some(t=>t.name==='Public button 隐私'),'UTF-8 UIA name survived')
  assert.ok(!('debug' in scan),'No debug metadata escaped the scanner')
  const rootPassword=await scanPasswordRegions(target.fieldHwnd,target.pid)
  assert.equal(rootPassword.complete,true)
  assert.equal(rootPassword.passwordRegions.length,1,'Root IsPassword control is included')
  const emptyTree=await scanPasswordRegions(target.labelHwnd,target.pid)
  assert.equal(emptyTree.complete,false,'Root-only non-password trees fail closed')
  assert.equal((await scanPasswordRegions(target.hwnd,target.pid+1)).complete,false,'Foreign PID is refused')
  assert.ok(capture.images[0]);assert.ok(capture.windowBounds)
  const result=await maskScreenshot(Buffer.from(capture.images[0].dataBase64,'base64'),capture.windowBounds!,scan,'DSH privacy test fixture')
  assert.equal(result.privacy.status,'blocked')
  assert.equal(result.privacy.reason,'sensitive-geometry-unverified')
  assert.ok((await sharp(result.bytes).removeAlpha().raw().toBuffer()).every(value=>value===0),'Production sensitive output must be entirely black; physical coordinate agreement is not pixel-alignment proof')
  const meta=await sharp(result.bytes).metadata();const r=scan.passwordRegions[0];const b=capture.windowBounds!
  const getRect=koffi.load('user32.dll').func('int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int32_t* rect)')
  const fieldBounds=[0,0,0,0];assert.ok(getRect(BigInt(target.fieldHwnd),fieldBounds))
  console.log(JSON.stringify({captureBounds:b,rawSize:{width:meta.width,height:meta.height},uiaPassword:r,physicalField:fieldBounds,sdkPassword:capture.elements?.filter(element=>/edit/i.test(element.role)).map(element=>({role:element.role,frame:element.frame}))}))
  assert.ok(Math.abs(r.x-fieldBounds[0])<=2&&Math.abs(r.y-fieldBounds[1])<=2,'UIA password bounds must match independent physical HWND bounds')
  // Independently observed field bounds verify every interior pixel, avoiding a
  // self-consistent but incorrectly projected mask passing a centre-only check.
  const left=Math.ceil((fieldBounds[0]-b.x+2)*meta.width!/b.width)
  const top=Math.ceil((fieldBounds[1]-b.y+2)*meta.height!/b.height)
  const right=Math.floor((fieldBounds[2]-b.x-2)*meta.width!/b.width)
  const bottom=Math.floor((fieldBounds[3]-b.y-2)*meta.height!/b.height)
  const fieldPixels=await sharp(result.bytes).extract({left,top,width:right-left,height:bottom-top}).removeAlpha().raw().toBuffer()
  assert.ok(fieldPixels.every(value=>value===0),'Every physical password-field pixel must be black')
  const x=Math.floor((r.x+r.width/2-b.x)*meta.width!/b.width);const y=Math.floor((r.y+r.height/2-b.y)*meta.height!/b.height)
  const pixel=await sharp(result.bytes).extract({left:x,top:y,width:1,height:1}).removeAlpha().raw().toBuffer()
  assert.deepEqual([...pixel],[0,0,0])
  await mkdir('evidence/rc1-privacy',{recursive:true})
  // Controlled synthetic fixture only: retain the former selective projection
  // for visual comparison. This helper mode is never enabled in production.
  const formerProjection=await maskScreenshot(Buffer.from(capture.images[0].dataBase64,'base64'),capture.windowBounds!,scan,'DSH privacy test fixture',{},false,'verified')
  await writeFile('evidence/rc1-privacy/before-selective-mask.png',formerProjection.bytes)
  await writeFile('evidence/rc1-privacy/password-masked.png',result.bytes)
  await writeFile('evidence/rc1-privacy/result.json',JSON.stringify({passed:true,policy:'whole-sensitive-frame-blocked',passwordRegions:scan.passwordRegions.length,publicButton:scan.targets?.some(t=>t.name==='Public button 隐私'),rootPasswordRegions:rootPassword.passwordRegions.length,emptyTreeBlocked:!emptyTree.complete,foreignPidBlocked:true,debugAbsent:!('debug' in scan),physicalBoundsMatch:true,allOutputPixelsBlack:true,maskedCenter:[...pixel],privacy:result.privacy},null,2))
  console.log(JSON.stringify({passed:true,passwordRegions:scan.passwordRegions.length,maskedCenter:[...pixel]}))
}finally{await driver?.shutdown();child.kill()}
