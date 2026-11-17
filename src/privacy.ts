import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'

export const privacyRectangleSchema = z.strictObject({ x:z.number().finite(), y:z.number().finite(), width:z.number().positive().finite(), height:z.number().positive().finite() })
export const privacyOptionsSchema = z.strictObject({
  excludedRectangles:z.array(privacyRectangleSchema).max(64).default([]),
  windowTitleBlacklist:z.array(z.string().min(1).max(256)).max(64).default([]),
})
export type PrivacyOptions = z.input<typeof privacyOptionsSchema>
export type PrivacyRectangle = z.infer<typeof privacyRectangleSchema>
const captionButtonSchema=z.enum(['minimize','maximize','close'])
export type CaptionButton=z.infer<typeof captionButtonSchema>
export interface PrivacyTarget { name:string; controlType:string; bounds:PrivacyRectangle; enabled:boolean; captionButton?:CaptionButton; secondBounds?:PrivacyRectangle|null }
export interface PrivacyScan { complete:boolean; passwordRegions:PrivacyRectangle[]; targets?:PrivacyTarget[]; reason?:string; windowTitle?:string }
export type PrivacyScanner = (hwnd:string, pid:number, options?:{targetStability?:boolean}) => Promise<PrivacyScan>

// Fixed internal read-only helper. No shell, executable path, arguments or script
// text originate in a tool request. HWND/PID are decimal values from our binding.
const scanScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type 'using System; using System.Runtime.InteropServices; public static class DshPrivacyDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context); [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext(); [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context); }'
if(![DshPrivacyDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) -and [DshPrivacyDpi]::GetAwarenessFromDpiAwarenessContext([DshPrivacyDpi]::GetThreadDpiAwarenessContext()) -ne 2){throw 'Privacy DPI context unavailable'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$providers=[System.Reflection.Assembly]::Load('UIAutomationClientsideProviders, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')

$request=([Console]::In.ReadToEnd() | ConvertFrom-Json)
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$request.hwnd))
if ($null -eq $root -or $root.Current.ProcessId -ne [int]$request.pid) { throw 'Identity mismatch' }
[System.Windows.Automation.ClientSettings]::RegisterClientSideProviders([UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable)
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$request.hwnd))
if ($null -eq $root -or $root.Current.ProcessId -ne [int]$request.pid) { throw 'Identity mismatch' }
$scope=[System.Windows.Automation.TreeScope]::Subtree
$items=$root.FindAll($scope,[System.Windows.Automation.Condition]::TrueCondition)
if($items.Count -gt 2000 -or $items.Count -lt 1){throw 'Incomplete privacy tree'}
if($items.Count -eq 1 -and !$root.Current.IsPassword){throw 'Empty privacy tree'}
$regions=@()
$targets=@()
$measurements=@()
foreach($item in $items){
  $c=$item.Current
  $r=$c.BoundingRectangle
  if($c.IsPassword){
    if($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0){if(!$c.IsOffscreen){throw 'Unbounded password control'};continue}
    $regions+=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}
    if($regions.Count -gt 256){throw 'Password tree limit'}
    continue
  }
  if($c.IsOffscreen -or !$c.IsEnabled){continue}
  $kind=$c.ControlType.ProgrammaticName.Replace('ControlType.','')
  if($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0 -or $kind -notin @('Button','CheckBox','RadioButton','MenuItem','TabItem','Hyperlink','ListItem','ComboBox','Edit')){continue}
  # Reaching the target cap must not stop the password traversal.
  if($targets.Count -lt 64){
    $target=@{name=$c.Name;controlType=$kind;enabled=$true;bounds=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}}
    if($kind -eq 'Button' -and $c.AutomationId -in @('Minimize','Maximize','Restore','Close','Minimize-Restore','Maximize-Restore')){
      $walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
      $titleBar=$walker.GetParent($item)
      if($null -ne $titleBar -and $titleBar.Current.ControlType -eq [System.Windows.Automation.ControlType]::TitleBar){
        $titleRoot=$walker.GetParent($titleBar)
        if($null -ne $titleRoot -and $titleRoot.Current.NativeWindowHandle -eq [int]$request.hwnd){
          $target.captionButton=switch($c.AutomationId){
            'Minimize' {'minimize'}
            'Minimize-Restore' {'minimize'}
            'Close' {'close'}
            default {'maximize'}
          }
        }
      }
    }
    $targets+=$target
    if($request.targetStability){$measurements+=@{item=$item;target=$target}}
  }
}
if($measurements.Count -gt 0){
  # Read the same automation elements, rather than matching IDs from separate tree enumerations.
  foreach($measurement in $measurements){
    $current=$measurement.item.Current
    if($current.IsPassword){throw 'Privileged control changed during geometry sampling'}
    $r=$current.BoundingRectangle
    $measurement.target.secondBounds=$null
    $measurement.firstValid=!$current.IsOffscreen -and $current.IsEnabled -and !$r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0
    if($measurement.firstValid){$measurement.target.bounds=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}}
  }
  Start-Sleep -Milliseconds 30
  foreach($measurement in $measurements){
    if(!$measurement.firstValid){continue}
    $current=$measurement.item.Current
    if($current.IsPassword){throw 'Privileged control changed during geometry sampling'}
    $r=$current.BoundingRectangle
    if($current.IsOffscreen -or !$current.IsEnabled -or $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0){continue}
    $measurement.target.secondBounds=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}
  }
}
if($root.Current.ProcessId -ne [int]$request.pid){throw 'Identity mismatch'}
@{complete=$true;passwordRegions=@($regions);targets=@($targets);windowTitle=$root.Current.Name} | ConvertTo-Json -Depth 5 -Compress
`
const scanResult = z.strictObject({ complete:z.boolean(), windowTitle:z.string().max(4096).optional(), passwordRegions:z.array(privacyRectangleSchema).max(256), targets:z.array(z.strictObject({name:z.string().max(4096),controlType:z.string().max(80),bounds:privacyRectangleSchema,enabled:z.boolean(),captionButton:captionButtonSchema.optional(),secondBounds:privacyRectangleSchema.nullable().optional()})).max(64).optional() })

export const scanPasswordRegions: PrivacyScanner = async (hwnd, pid, options) => {
  if(process.platform !== 'win32' || !/^\d+$/.test(hwnd) || !Number.isSafeInteger(pid) || pid < 1) return {complete:false,passwordRegions:[],reason:'privacy-scan-unavailable'}
  const systemRoot=process.env.SystemRoot
  if(!systemRoot || !win32.isAbsolute(systemRoot)) return {complete:false,passwordRegions:[],reason:'privacy-scan-unavailable'}
  try {
    const stdout=await new Promise<string>((resolve,reject)=>{
      const child=execFile(win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
        ['-NoLogo','-NoProfile','-NonInteractive','-Mta','-EncodedCommand',Buffer.from(scanScript,'utf16le').toString('base64')],
        {windowsHide:true,timeout:5000,maxBuffer:128*1024,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout))
      child.stdin?.end(JSON.stringify({hwnd,pid,targetStability:options?.targetStability===true}))
    })
    return scanResult.parse(JSON.parse(stdout.replace(/^\uFEFF/,'')))
  } catch { return {complete:false,passwordRegions:[],reason:'privacy-scan-unavailable'} }
}

export function titleIsPrivate(title:string,options:PrivacyOptions={}):boolean {
  return (options.windowTitleBlacklist??[]).some(value=>title.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
}

/** Solid overwrite before crop, resize, JPEG, file persistence or model admission. */
export async function maskScreenshot(bytes:Buffer, bounds:PrivacyRectangle, scan:PrivacyScan, title:string, options:PrivacyOptions={}, desktop=false, projection:'verified'|'unverified'='unverified') {
  const config=privacyOptionsSchema.parse(options)
  const meta=await sharp(bytes).metadata()
  if(!meta.width || !meta.height || meta.width*meta.height>50_000_000) throw new Error('Invalid screenshot dimensions')
  const titleMatched=titleIsPrivate(title,config)
  const rectangles=[...scan.passwordRegions,...config.excludedRectangles]
  // Some DPI-unaware applications yield a bitmap whose content is scaled inside
  // a physical-size canvas. Matching UIA and HWND bounds alone cannot certify
  // pixel alignment. Production therefore withholds the entire sensitive frame.
  // Only synthetic/independently verified bitmap producers may opt into regions;
  // no tool or plugin configuration can set this internal argument.
  const uncertainGeometry=projection==='unverified'&&rectangles.length>0
  const blocked=desktop || !scan.complete || bounds.width<=0 || bounds.height<=0 || uncertainGeometry || titleMatched
  const full=blocked
  const masks=full ? [{left:0,top:0,width:meta.width,height:meta.height}] : rectangles.flatMap(r=>{
    // Two physical pixel padding includes DWM/SDK one-pixel capture insets and antialiasing.
    const left=Math.max(0,Math.floor((r.x-bounds.x-2)*meta.width!/bounds.width))
    const top=Math.max(0,Math.floor((r.y-bounds.y-2)*meta.height!/bounds.height))
    const right=Math.min(meta.width!,Math.ceil((r.x+r.width-bounds.x+2)*meta.width!/bounds.width))
    const bottom=Math.min(meta.height!,Math.ceil((r.y+r.height-bounds.y+2)*meta.height!/bounds.height))
    return right>left && bottom>top ? [{left,top,width:right-left,height:bottom-top}] : []
  })
  if(masks.length) bytes=await sharp(bytes).composite(masks.map(r=>({input:{create:{width:r.width,height:r.height,channels:4 as const,background:'#000000ff'}},left:r.left,top:r.top}))).png().toBuffer()
  return {bytes,suppressTree:full || masks.length>0, privacy:{status:blocked?'blocked' as const:masks.length?'redacted' as const:'clear' as const,
    passwordRegions:scan.passwordRegions.length, configuredRegions:config.excludedRectangles.length,titleMatched,
    ...(blocked?{reason:desktop?'desktop-privacy-boundary':titleMatched?'private-window-title':uncertainGeometry?'sensitive-geometry-unverified':scan.reason??'privacy-scan-unavailable'}:{})}}
}

export { redactText, redactDiagnostics } from './redaction.ts'




