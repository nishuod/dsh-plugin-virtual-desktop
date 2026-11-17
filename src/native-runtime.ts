import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import sharp from 'sharp'
import { projectTargetBounds, suggestedTargets } from './accessibility-targets.ts'
import {extractVisualTargets,visualDifference,screenshotSha256,imagePixelHash,type VisualOptions} from './visual-targets.ts'
import { maskScreenshot, scanPasswordRegions, redactText, titleIsPrivate, type CaptionButton, type PrivacyOptions, type PrivacyScanner, type PrivacyScan, type PrivacyTarget } from './privacy.ts'
import { CuaDriver, ActionEffect, type WindowInfo, type CuaDriverLike } from '@trycua/cua-driver'
import { WindowsIdentity } from './windows-identity.ts'
import { BackgroundScrollRefused, type WindowsBackgroundScroller } from './background-scroll.ts'
import { BackgroundInputRefused, type WindowsBackgroundInput } from './background-input.ts'
import { imagePoint, cropSchema, operationSchema, NativeWindowError, windowFailure, type DesktopFrame, type DesktopRuntimeState, type DesktopWindow, type DesktopReceipt, type DesktopOperation, type WindowDiscovery, type NativeRestoreResult } from './native-contract.ts'
import type { ValueCheck } from './task-contract.ts'
import { sameWindowsPath, vmwareProcessIdentitySchema, type VmwareCommandScope, type VmwareProcessIdentity } from './vmware-command.ts'

interface KnownWindow { public: DesktopWindow; raw: WindowInfo; birth: string; boundRect?: {x:number;y:number;width:number;height:number} }
interface FrameRecord { public: DesktopFrame; rect: {x:number;y:number;width:number;height:number}; screen: {x:number;y:number;width:number;height:number}; source: {x:number;y:number;width:number;height:number}; rawWidth:number;rawHeight:number;foreground: string; used: boolean; visualRawHash?:string; captionTargets?:ReadonlyMap<string,CaptionButton> }
interface Limits { frameAgeMs: number; maxDimension: number; imageBytes: number; privacy?:PrivacyOptions; visualCandidates?:VisualOptions }
type ActionCoordinates = Pick<DesktopReceipt, 'coordinates' | 'sourceScale' | 'sourcePoint' | 'effectivePoint' | 'effectivePointSpace' | 'hitTest' | 'delivery' | 'nextTool' | 'evidence' | 'visualVerification'>
type BackgroundInput = Pick<WindowsBackgroundInput, 'key' | 'doubleClick'> & Partial<Pick<WindowsBackgroundInput, 'tryMinimizeCaption' | 'replaceText' | 'captionButtons'>>
type CaptionBounds = ReturnType<WindowsBackgroundInput['captionButtons']>
export type IdentityPort = Pick<WindowsIdentity,'assertInteractive'|'process'|'window'|'windowShellInfo'|'rawTopLevelCount'|'acquireLease'|'movePointer'> & Partial<Pick<WindowsIdentity,'rawWindowDiscovery'|'responsive'|'restoreWindow'|'restoredWindow'|'clientBounds'>>
export type DriverPort = Pick<CuaDriverLike,'listWindows'|'getWindowState'|'getDesktopState'|'callTool'|'shutdown'> & {uniffiDestroy?:()=>void}
const deniedApps = /^(?:childsessionhost|deepseek harness|codex|chatgpt|credentialuibroker|logonui|lockapp|consent|keepass(?:xc)?|1password|bitwarden|cmd|powershell|pwsh|windowsterminal|conhost)\.exe$/i
const childShellApps = /^(?:startmenuexperiencehost|shellexperiencehost|searchhost|searchapp|searchui|textinputhost)\.exe$/i
const explorerShellClasses = new Set(['progman', 'workerw', 'shell_traywnd', 'shell_secondarytraywnd'])
const safeKey = /^(?:[a-z0-9]|return|enter|tab|escape|up|down|left|right|space|delete|backspace|home|end|pageup|pagedown|f[1-9]|f1[0-2])$/i
class InputRefused extends Error {}
const containsPoint=(bounds:{x:number;y:number;width:number;height:number},x:number,y:number)=>
  x>=bounds.x&&x<bounds.x+bounds.width&&y>=bounds.y&&y<bounds.y+bounds.height

/** Native automation inside the worker's Windows session. The Host verifies session isolation separately. */
export class NativeRuntime {
  private driver: DriverPort | undefined
  private windows = new Map<string, KnownWindow>()
  private selected: KnownWindow | undefined
  private frame: FrameRecord | undefined
  private releaseLease: (() => void) | undefined
  private busy: Promise<unknown> | undefined
  private abort: AbortController | undefined
  private draining: Promise<DesktopRuntimeState> | undefined
  private stopRequested = false
  private reading: Promise<unknown> | undefined
  private receipts = new Map<string, {hash:string; result: DesktopReceipt}>()
  private state: DesktopRuntimeState = {backend:'windows-attended', isolated:false, status:'disabled', epoch:0, window:null, foregroundAllowed:false, inputMode:'ask-each-action', lastResult:'尚未授权读取当前桌面', capabilities:{windowCapture:true, desktopCapture:true, regionCapture:true, clipboard:false, autonomousTask:false}}
  constructor(private readonly limits: Limits, private readonly identity: IdentityPort = new WindowsIdentity(), private readonly factory: ()=>DriverPort = ()=>CuaDriver.create(undefined), private readonly backgroundScroller?: Pick<WindowsBackgroundScroller, 'scroll'>, private readonly childSession = false, private readonly backgroundInput?: BackgroundInput, private readonly privacyScanner: PrivacyScanner = scanPasswordRegions) {
    if (childSession) this.state.lastResult = '尚未授权读取画中画子会话'
  }
  snapshot(): DesktopRuntimeState { return structuredClone(this.state) }
  private async connect(): Promise<DriverPort> {
    this.identity.assertInteractive()
    if (!this.driver) this.driver = this.factory()
    return this.driver
  }
  async enable(): Promise<DesktopRuntimeState> {
    if (!['disabled','stopped','failed'].includes(this.state.status)) return this.snapshot()
    const epoch=this.state.epoch
    await this.connect();if(epoch!==this.state.epoch)throw new Error('开启期间许可已撤销')
    this.state.status='observing'; this.state.epoch++
    this.state.lastResult = this.childSession
      ? '画中画子会话观察已开启；请选择并授权一个应用窗口'
      : '本机观察已开启；输入仍须选择窗口并逐次批准'
    return this.snapshot()
  }
  private assertRead(): void {
    if (!['observing','enabled'].includes(this.state.status)) {
      throw new Error(this.childSession
        ? '请先启用画中画观察；暂停或终止后须重新继续'
        : '请先在面板启用本机观察；暂停或终止后须重新继续')
    }
    this.identity.assertInteractive()
  }
  private isChildShellWindow(id: bigint, pid: number, image: string): string | undefined {
    if (!this.childSession) return undefined
    if (childShellApps.test(image)) return `shell-process:${image.toLowerCase()}`
    const shell = this.identity.windowShellInfo(id.toString(), pid)
    if (shell.shellDesktop) return 'shell-desktop:GetShellWindow'
    if (image.toLowerCase() === 'explorer.exe' && explorerShellClasses.has(shell.className.toLowerCase())) return `explorer-class:${shell.className}`
    return undefined
  }
  async listWindows(): Promise<DesktopWindow[]> {
    this.assertRead()
    const epoch = this.state.epoch
    const result = await (await this.connect()).listWindows({onScreenOnly:true})
    if (this.childSession) {
      if (epoch !== this.state.epoch) throw new Error('窗口发现期间许可已改变')
      this.assertRead()
    }
    const candidates = result.windows.slice(0,150)
    const filtered: WindowDiscovery['filtered'] = {
      missingPid: 0, minimized: 0, invalidBounds: 0, blockedProcess: 0,
      systemSurface: 0, unverifiedProcess: 0, unverifiedWindow: 0, limit: result.windows.length - candidates.length,
    }
    const next = new Map<string, KnownWindow>()
    const systemSurfaces: NonNullable<WindowDiscovery['systemSurfaces']> = []
    for (const raw of candidates) {
      if (!raw.pid) { filtered.missingPid++; continue }
      if (raw.minimized) { filtered.minimized++; continue }
      if (raw.bounds.width <= 1 || raw.bounds.height <= 1) { filtered.invalidBounds++; continue }
      let process: ReturnType<IdentityPort['process']>
      try { process = this.identity.process(raw.pid) }
      catch { filtered.unverifiedProcess++; continue }
      if (deniedApps.test(process.image)) { filtered.blockedProcess++; continue }
      try {
        const reason = this.isChildShellWindow(raw.windowId, raw.pid, process.image)
        if (reason) {
          filtered.systemSurface++
          systemSurfaces.push({pid:raw.pid,image:process.image.slice(0,256),title:raw.title.slice(0,512),reason})
          continue
        }
        const prior = [...this.windows.values()].find(w => w.raw.windowId === raw.windowId && w.raw.pid === raw.pid && w.birth === process.birth)
        const id = prior?.public.id ?? randomUUID()
        const details = process.imagePath ? { imagePath:process.imagePath, windowClass:this.identity.windowShellInfo(raw.windowId.toString(),raw.pid).className, responsive:this.identity.responsive?.(raw.windowId.toString()) ?? false } : {}
        const pub = {...details,id, title:raw.title.slice(0,512), app:raw.appName.slice(0,256), pid:raw.pid, ...raw.bounds}
        next.set(id, {public:pub, raw, birth:process.birth})
      } catch { filtered.unverifiedWindow++ }
    }
    this.windows = next
    if (this.childSession) {
      const rawDiscovery = this.identity.rawWindowDiscovery?.(result.windows.map(window=>String(window.windowId)))
      this.state.windowDiscovery = {
        sampledAt: Date.now(), rawTopLevel: rawDiscovery?.rawTopLevel ?? this.identity.rawTopLevelCount(),
        ...(rawDiscovery ? {sdkSelection:rawDiscovery.sdkSelection} : {}),
        sdkCandidates: result.windows.length, workerEligible: next.size, filtered, systemSurfaces,
      }
    }
    return [...next.values()].map(w => w.public)
  }
  async select(id: string, foreground: boolean, expectedEpoch?: number): Promise<DesktopRuntimeState> {
    this.assertRead()
    if (expectedEpoch !== undefined && this.state.epoch !== expectedEpoch) {
      throw new Error('窗口授权已变化，请重新发现并批准')
    }
    if (this.busy || this.reading) throw new Error('执行中不能更换窗口')
    const window = this.windows.get(id)
    if (!window) throw new Error('窗口不在当前发现列表中，请刷新')
    const rect = this.validateWindow(window)
    window.boundRect = rect
    this.releaseLease ??= this.identity.acquireLease()
    this.selected=window; this.frame=undefined; this.state.epoch++; this.state.window=window.public
    this.state.foregroundAllowed=foreground; this.state.status='enabled'
    this.state.lastResult = this.childSession
      ? '已授权画中画应用窗口；输入遵循 Host 当前会话权限'
      : '已选择本机窗口；每次模型输入仍须单独批准'
    return this.snapshot()
  }
  private validateWindow(window: KnownWindow) {
    this.validateIdentity(window)
    return this.identity.window(window.raw.windowId.toString(), window.public.pid)
  }
  private validateIdentity(window: KnownWindow): ReturnType<IdentityPort['process']> {
    this.identity.assertInteractive()
    let process: ReturnType<IdentityPort['process']>
    try { process = this.identity.process(window.public.pid) }
    catch { throw new NativeWindowError('exited', '目标进程已退出或不可查询，请重新发现窗口') }
    if (process.birth !== window.birth) throw new NativeWindowError('identity-changed', '进程已更换，旧窗口许可失效')
    if (this.isChildShellWindow(window.raw.windowId, window.public.pid, process.image)) {
      throw new NativeWindowError('identity-changed', '画中画仅支持普通应用窗口；请重新选择目标窗口')
    }
    return process
  }
  /** Recheck the selected HWND and process without demanding a visible window or a frame. */
  appCommandScope(scope: VmwareCommandScope): VmwareProcessIdentity {
    const window = this.selected
    if (!this.childSession || this.state.status !== 'enabled' || !window || !this.releaseLease ||
      this.state.epoch !== scope.expectedEpoch || window.public.id !== scope.windowId || window.public.pid !== scope.pid) {
      throw new NativeWindowError('identity-changed', 'VMware 应用命令的窗口许可已变化')
    }
    if (this.busy || this.reading) throw new Error('执行器尚未排空，不能执行 VMware 应用命令')
    const process = this.validateIdentity(window)
    if (process.image !== 'vmware.exe' || !sameWindowsPath(process.imagePath, scope.vmwarePath)) {
      throw new NativeWindowError('identity-changed', '已授权窗口与 VMware 安装位置不匹配')
    }
    const identity = vmwareProcessIdentitySchema.parse({
      vmwareHwnd: window.raw.windowId.toString(), vmwareBirth: process.birth,
    })
    if (scope.invalidateFrame) this.frame = undefined
    return identity
  }
  private rebindGeometry(window: KnownWindow, rect: {x:number;y:number;width:number;height:number}, captureBounds = rect, verifiedRestore = false): boolean {
    const changed = !!window.boundRect && !sameRect(window.boundRect, rect)
    window.boundRect = { ...rect }
    if (changed || verifiedRestore) {
      window.public = { ...window.public, x: captureBounds.x, y: captureBounds.y, width: captureBounds.width, height: captureBounds.height }
      this.state.window = window.public
      this.frame = undefined
      this.state.lastResult = '目标窗口已移动或缩放，已自动重绑；旧截图不可用于输入，请使用新截图'
    }
    return changed
  }
  async restore(windowId: string, pid: number, expectedEpoch: number): Promise<NativeRestoreResult> {
    this.assertRead()
    if (this.busy || this.reading) throw new Error('执行器尚未排空，不能恢复窗口')
    const window = this.selected
    if (this.state.status !== 'enabled' || !window || !this.releaseLease || window.public.id !== windowId || window.public.pid !== pid || this.state.epoch !== expectedEpoch) {
      throw new Error('恢复窗口的授权身份或代次已变化，请重新读取状态并批准')
    }
    this.validateIdentity(window)
    if (!this.identity.restoreWindow || !this.identity.restoredWindow) throw new Error('执行器不支持可核验的窗口恢复')
    this.frame = undefined
    const run = (async (): Promise<NativeRestoreResult> => {
      this.identity.restoreWindow!(window.raw.windowId.toString(), pid)
      const deadline = performance.now() + 1500
      while (true) {
        if (this.state.epoch !== expectedEpoch || this.state.status !== 'enabled' || this.selected !== window) throw new Error('恢复期间窗口授权已撤销')
        this.validateIdentity(window)
        if (performance.now() >= deadline) break
        try {
          const { rect, bounds } = this.identity.restoredWindow!(window.raw.windowId.toString(), pid)
          this.validateIdentity(window)
          if (performance.now() >= deadline) break
          this.rebindGeometry(window, rect, bounds, true)
          this.state.lastResult = '目标窗口已恢复并重新绑定；请调用 desktop_get_screenshot 获取新帧'
          return {
            ...this.snapshot(), backend:'windows-attended', isolated:false, status:'enabled',
            window:structuredClone(window.public), state:'restored', verified:true, nextTool:'desktop_get_screenshot',
          }
        } catch (error) {
          if (!(error instanceof NativeWindowError) || !['minimized', 'hidden', 'resized'].includes(error.reason)) throw error
          const remaining = deadline - performance.now()
          if (remaining > 0) await delay(Math.min(50,remaining))
        }
      }
      this.state.lastResult = '窗口仍在恢复，尚未核实可用几何；请稍后重新截图'
      return { state:'restoring', retryAfterMs:200, nextTool:'desktop_get_screenshot', windowId, pid, epoch:expectedEpoch }
    })()
    this.reading = run
    try { return await run } finally { if (this.reading === run) this.reading = undefined }
  }
  async capture(source: 'window'|'desktop'='window', crop?: z.infer<typeof cropSchema>, check?: ValueCheck, verifyVisual = false): Promise<DesktopFrame> {
    this.assertRead()
    if (this.busy || this.reading) throw new Error('执行器尚未排空，不能并发截图')
    const run=this.captureInternal(source,crop,check,verifyVisual);this.reading=run
    try {return await run} finally {if(this.reading===run)this.reading=undefined}
  }
  private async captureInternal(source: 'window'|'desktop', crop?: z.infer<typeof cropSchema>, check?: ValueCheck, verifyVisual = false): Promise<DesktopFrame> {
    const driver = await this.connect()
    const window = this.selected
    if (source==='window' && !window) throw new Error('请先选择目标窗口')
    const epoch = this.state.epoch
    const rect = window ? this.validateWindow(window) : {x:0,y:0,width:0,height:0,foreground:''}
    let rebound = false
    let bytes: Buffer; let tree='';let screen=rect
    let valueCheck: DesktopFrame['valueCheck']
    let accessibility: DesktopFrame['accessibility']
    let privacyScan:PrivacyScan={complete:false,passwordRegions:[],reason:'privacy-scan-unavailable'}
    if (source==='window' && window) {
      const beforeScan=await this.privacyScanner(window.raw.windowId.toString(),window.public.pid)
      const captured = await driver.getWindowState({pid:window.public.pid, windowId:window.raw.windowId, includeScreenshot:true, includeAccessibilityTree:true, maxElements:400, maxDepth:15, maxDimension:4096})
      if (captured.windowId !== window.raw.windowId || captured.pid !== window.public.pid) throw new NativeWindowError('identity-changed', '执行器返回了不同身份的窗口截图')
      if (captured.screenshotFrameValid === false || !captured.images[0]) {
        this.validateWindow(window)
        throw new Error('执行器未返回有效窗口截图；请重新截图')
      }
      bytes=Buffer.from(captured.images[0].dataBase64,'base64')
      const sdkTree = captured.treeMarkdown ?? ''
      tree = sdkTree.slice(0, 12000)
      const treeTruncated = captured.truncated === true || tree.length < sdkTree.length
      const unnamedButtons = captured.elements?.filter(element =>
        element.role.toLowerCase() === 'button' && !element.label?.trim(),
      ).length
      const limited = treeTruncated || captured.degraded === true || captured.elementsComplete === false || (unnamedButtons ?? 0) > 0
      accessibility = {
        status: !tree.trim() ? 'unavailable' : limited ? 'limited' : 'available',
        scope: 'window', treeTruncated,
        ...(unnamedButtons === undefined ? {} : { unnamedButtons }),
        guidance: 'UIA 只覆盖应用公开的控件。缺少控件或名称时，用当前截图核对目标，无法从图像确认时停止输入。',
      }
      if (check) {
        // Only a unique control in a complete, non-degraded tree is evidence.
        // Keep its actual value in the worker and return the comparison alone.
        const matches = captured.elements?.filter(element => element.label === check.label)
        const value = captured.elementsComplete && !captured.degraded && !captured.truncated
          && matches?.length === 1 ? matches[0].value : undefined
        valueCheck = value === undefined ? 'unavailable' : value === check.expected ? 'match' : 'mismatch'
      }
      // SDK capture bounds exclude invisible resize borders; GetWindowRect is only our change guard.
      if(captured.windowBounds)screen={...captured.windowBounds,foreground:rect.foreground}
      const now = this.validateWindow(window)
      if (!sameRect(now,rect)) {
        this.rebindGeometry(window, now)
        throw new NativeWindowError('resized', '截图期间窗口移动或缩放，已自动重绑，请重新截图')
      }
      const afterScan=await this.privacyScanner(window.raw.windowId.toString(),window.public.pid,{targetStability:true})
      privacyScan={...afterScan,windowTitle:[beforeScan.windowTitle,afterScan.windowTitle].filter(Boolean).join('\n'),complete:beforeScan.complete&&afterScan.complete,passwordRegions:[...beforeScan.passwordRegions,...afterScan.passwordRegions]}
      // Revalidate after the privacy helper too; scans may yield for seconds.
      if(!sameRect(this.validateWindow(window),rect)) throw new NativeWindowError('resized','窗口在隐私扫描期间移动，请重新截图')
      rebound = this.rebindGeometry(window, rect, screen)
    } else {
      const captured = await driver.getDesktopState({})
      if (captured.isError || !captured.images[0]) throw new Error('执行器无法捕获桌面')
      bytes=Buffer.from(captured.images[0].dataBase64,'base64')
    }
    if (epoch !== this.state.epoch) throw new Error('截图期间许可已改变')
    const masked=await maskScreenshot(bytes,screen,privacyScan,privacyScan.windowTitle||window?.public.title||'',this.limits.privacy,source==='desktop')
    bytes=masked.bytes
    if(masked.suppressTree){
      tree=''
      if(check)valueCheck='unavailable'
      if(accessibility)accessibility={...accessibility,status:'unavailable',guidance:'UIA 文本已随隐私区域隐藏。请勿猜测被遮蔽的内容。'}
    } else tree=redactText(tree)
    const meta = await sharp(bytes).metadata()
    if (!meta.width || !meta.height || meta.width * meta.height > 50_000_000) throw new Error('截图尺寸异常')
    const region = crop ? cropSchema.parse(crop) : {x:0,y:0,width:meta.width,height:meta.height}
    if (region.x + region.width > meta.width || region.y + region.height > meta.height || !Number.isInteger(region.x) || !Number.isInteger(region.y)) throw new Error('截图区域超出边界')
    let edge=this.limits.maxDimension; let encoded: {data:Buffer;info:{width:number;height:number}} | undefined
    for (let attempt=0; attempt<5; attempt++) {
      encoded = await sharp(bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height})
        .resize({width:edge,height:edge,fit:'inside',withoutEnlargement:true}).jpeg({quality:75-attempt*8}).toBuffer({resolveWithObject:true})
      if (encoded.data.length <= this.limits.imageBytes) break
      edge=Math.max(320, Math.floor(edge*.75))
    }
    if (!encoded || encoded.data.length > this.limits.imageBytes) throw new Error('截图超过传输限制')
    // Keep libvips in the native worker. Loading it in the Electron host would
    // conflict with the host's different sharp build on Windows.
    let visualContent: boolean | undefined
    if (verifyVisual) {
      const { channels } = await sharp(encoded.data).stats()
      visualContent = channels.some(channel => channel.stdev > 5)
    }
    if(epoch!==this.state.epoch || !['observing','enabled'].includes(this.state.status))throw new Error('截图期间许可已改变')
    const frame: DesktopFrame = {id:randomUUID(),windowId:window?.public.id ?? '',epoch,capturedAt:Date.now(),width:encoded.info.width,height:encoded.info.height,mimeType:'image/jpeg',data:encoded.data.toString('base64'),source,tree,scale:{rawWidth:region.width,rawHeight:region.height,width:encoded.info.width,height:encoded.info.height},...(rebound ? {notice:'目标窗口已移动或缩放，已自动重绑；请使用本次新截图坐标'} : {}),...(valueCheck ? { valueCheck } : {})}
    frame.privacy=masked.privacy
    let captionTargets:ReadonlyMap<string,CaptionButton>|undefined
    if(accessibility&&!masked.suppressTree&&privacyScan.targets?.length){
      const firstCaption=this.readCaptionBounds(privacyScan.targets,window)
      let captionSamples=firstCaption?{first:firstCaption,second:{} as CaptionBounds}:undefined
      if(firstCaption&&Object.keys(firstCaption).length){
        await delay(30)
        if(epoch!==this.state.epoch || !['observing','enabled'].includes(this.state.status))throw new Error('截图期间许可已改变')
        if(window&&!sameRect(this.validateWindow(window),rect))throw new NativeWindowError('resized','窗口在候选位置复核期间移动，请重新截图')
        const secondTargets=privacyScan.targets.flatMap(target=>target.secondBounds===null?[]:[{...target,bounds:target.secondBounds??target.bounds}])
        captionSamples={first:firstCaption,second:this.readCaptionBounds(secondTargets,window)??{}}
      }
      const projected=this.projectTargets(privacyScan.targets,window,screen,{width:meta.width,height:meta.height},region,encoded.info,captionSamples)
      accessibility.suggestedTargets=projected.targets
      captionTargets=projected.captionTargets
    }
    let visualRawHash:string|undefined
    if(accessibility&&!masked.suppressTree&&masked.privacy.status==='clear'&&window&&this.identity.clientBounds){
      const visualStarted=performance.now()
      let stage='client-unavailable'
      try{
        const client=this.identity.clientBounds(window.raw.windowId.toString(),window.public.pid)
        const clientImage={x:((client.x-screen.x-1)*meta.width/(screen.width-2)-region.x)*frame.width/region.width,
          y:((client.y-screen.y-1)*meta.height/(screen.height-2)-region.y)*frame.height/region.height,
          width:client.width*meta.width/(screen.width-2)*frame.width/region.width,height:client.height*meta.height/(screen.height-2)*frame.height/region.height}
        const clientLeft=Math.max(0,Math.ceil(clientImage.x)),clientTop=Math.max(0,Math.ceil(clientImage.y))
        const clientRight=Math.min(frame.width,Math.floor(clientImage.x+clientImage.width)),clientBottom=Math.min(frame.height,Math.floor(clientImage.y+clientImage.height))
        const clientArea=clientRight>clientLeft&&clientBottom>clientTop
          ? {x:clientLeft,y:clientTop,width:clientRight-clientLeft,height:clientBottom-clientTop}
          : undefined
        stage='analysis-unavailable'
        let visual=await extractVisualTargets(encoded.data,clientImage,accessibility.suggestedTargets,this.limits.visualCandidates)
        if(visual.targets.length){
          const rawHash=await imagePixelHash(bytes)
          const elapsedMs=performance.now()-visualStarted
          if(elapsedMs>(this.limits.visualCandidates?.budgetMs??120)){
            visual={targets:[],elapsedMs,truncated:true,reason:'budget-exceeded'}
          }else{
            visualRawHash=rawHash
            visual.elapsedMs=elapsedMs
          }
        }
        accessibility.visualCandidates={elapsedMs:visual.elapsedMs,truncated:visual.truncated,
          ...(clientArea?{clientArea}:{}),...(visual.reason?{reason:visual.reason}:{})}
        if(visual.targets.length)accessibility.suggestedTargets=[...(accessibility.suggestedTargets??[]),...visual.targets]
      }catch{
        const elapsedMs=performance.now()-visualStarted
        const expired=elapsedMs>(this.limits.visualCandidates?.budgetMs??120)
        accessibility.visualCandidates={elapsedMs,truncated:expired,reason:expired?'budget-exceeded':stage}
      }
      if(epoch!==this.state.epoch||!sameRect(this.validateWindow(window),rect))throw new NativeWindowError('resized','视觉候选提取期间授权或窗口状态改变，请重新观察')
    }
    if (accessibility) frame.accessibility = accessibility
    if (visualContent !== undefined) frame.visualContent = visualContent
    this.frame = {public:frame,rect,screen,foreground:rect.foreground,used:false,source:{...region},rawWidth:meta.width,rawHeight:meta.height,visualRawHash,captionTargets}
    this.state.lastResult=rebound ? '目标窗口已移动或缩放，已自动重绑并取得新截图' : '已取得新的真实观察；截图并不代表任务完成'
    return frame
  }
  private readCaptionBounds(targets:PrivacyTarget[],window:KnownWindow|undefined):CaptionBounds|undefined {
    if(window&&this.backgroundInput?.captionButtons&&targets.some(target=>target.captionButton)){
      return this.backgroundInput.captionButtons(window.raw.windowId.toString(),window.public.pid,targets)
    }
  }
  private projectTargets(
    targets:PrivacyTarget[],window:KnownWindow|undefined,screen:FrameRecord['screen'],
    raw:{width:number;height:number},region:FrameRecord['source'],image:{width:number;height:number},
    captionSamples?:{first:CaptionBounds;second:CaptionBounds},
  ){
    const verifiedBounds=captionSamples?.first??this.readCaptionBounds(targets,window)
    const adjusted=targets.map(target=>{
      const bounds=target.captionButton&&verifiedBounds?verifiedBounds[target.captionButton]:target.bounds
      return {...target,name:redactText(target.name),enabled:target.enabled&&!!bounds,bounds:bounds??target.bounds}
    }).filter(target=>target.enabled).slice(0,64)
    const projected=suggestedTargets(adjusted,screen,raw,region,image)
    const captionTargets=new Map<string,CaptionButton>()
    if(verifiedBounds){
      for(const [index,target] of adjusted.entries()){
        if(target.captionButton)captionTargets.set(`uia-${index}`,target.captionButton)
      }
    }
    for(const target of projected){
      const source=adjusted[Number(target.id.slice(4))]
      const secondBounds=source.captionButton&&verifiedBounds
        ?captionSamples?captionSamples.second[source.captionButton]??null:undefined
        :source.secondBounds
      if(secondBounds===undefined)continue
      const first=target.bbox
      const second=secondBounds?projectTargetBounds(secondBounds,screen,raw,region,image)??null:null
      const deltaPx=second?Math.max(
        Math.abs(first.x-second.x),Math.abs(first.y-second.y),
        Math.abs(first.width-second.width),Math.abs(first.height-second.height),
        Math.abs(first.x+first.width-second.x-second.width),
        Math.abs(first.y+first.height-second.y-second.height),
      ):null
      target.stable=deltaPx!==null&&deltaPx<=4
      if(!target.stable)target.bboxEvidence={first,second,deltaPx}
    }
    return {targets:projected,captionTargets}
  }
  async execute(raw: unknown): Promise<DesktopReceipt> {
    const operation = operationSchema.parse(raw)
    const hash = createHash('sha256').update(JSON.stringify(operation)).digest('hex')
    const previous = this.receipts.get(operation.operationId)
    if (previous) { if (previous.hash!==hash) throw new Error('operationId 已用于不同动作'); return previous.result }
    if (this.busy || this.reading) throw new Error('执行器正忙；不会排队或重放输入')
    const frame=this.frame; const window=this.selected
    if (this.state.status!=='enabled' || !window || !frame || !this.releaseLease) throw new Error('输入许可未开启')
    if (operation.epoch !== this.state.epoch || frame.public.id !== operation.frameId || frame.public.epoch !== operation.epoch || frame.used || frame.public.source!=='window' || Date.now()-frame.public.capturedAt > this.limits.frameAgeMs) throw new Error('截图已过期、被替换或已用于输入，请重新观察')
    if(frame.public.privacy?.status==='blocked') throw new Error('隐私扫描未完成，当前帧不允许输入')
    const current=this.validateWindow(window)
    if (!sameRect(current,frame.rect) || current.foreground!==frame.foreground) throw new Error('窗口位置或焦点已改变，请重新观察')
    if (operation.delivery==='foreground' && !this.state.foregroundAllowed) throw new Error('未允许本机前台操作')
    frame.used=true
    const abort=this.abort=new AbortController()
    const diagnostics: ActionCoordinates = {
      coordinates: 'screenshot-pixels',
      sourceScale: frame.public.scale,
      evidence:[{channel:'coordinates',result:'explicit point in authorized single-use frame'}],
    }
    const run: Promise<DesktopReceipt> = this.perform(operation,window,frame,abort.signal,diagnostics).then(async message => {
      const receipt: DesktopReceipt = {operationId:operation.operationId,outcome:'delivered',message,after:null,...diagnostics}
      if (this.state.status==='enabled' && operation.epoch===this.state.epoch) {
        try {
          receipt.after = await this.captureInternal('window')
          if(receipt.visualVerification){
            const difference=await visualDifference(frame.public.data,receipt.after.data)
            Object.assign(receipt.visualVerification,{...difference,elapsedMs:receipt.visualVerification.elapsedMs+difference.elapsedMs})
          }
          if(receipt.evidence)receipt.evidence.push({channel:'verification',result:`uiaChanged=${frame.public.tree!==receipt.after.tree}; screenshotChanged=${frame.public.data!==receipt.after.data}`})
        } catch (error) {
          // A successful dispatch can change the target's availability before the next capture.
          const failure = windowFailure(error)
          if (failure) receipt.postAction = failure
          const detail = error instanceof Error ? error.message : '截图失败'
          receipt.message = `${message}；动作后无法截图：${detail}`.slice(0,1000)
        }
      }
      return receipt
    },error => ({
      operationId:operation.operationId,
      outcome:error instanceof InputRefused ? 'refused' : 'unknown',
      message:error instanceof Error ? error.message.slice(0,1000) : '动作结果未知',
      after:null,
      ...diagnostics,
    }))
    this.busy=run
    try {
      const result=await run
      result.message=redactText(result.message)
      // Receipts retain no screenshot bytes; retries retrieve outcome but cannot cause another input.
      this.receipts.set(operation.operationId,{hash,result:{...result,after:null}})
      if (this.receipts.size>256) this.receipts.delete(this.receipts.keys().next().value!)
      this.state.lastResult=result.message
      return result
    } finally { this.busy=undefined; this.abort=undefined }
  }
  private async perform(operation: DesktopOperation, window: KnownWindow, frame: FrameRecord, signal: AbortSignal, diagnostics: ActionCoordinates): Promise<string> {
    let action=operation.action
    let expectsMinimize=false
    let coordinateClick=action.type==='click'&&!action.target
    if(action.type==='click'&&action.target){
      const selector=action.target
      const matches=(frame.public.accessibility?.suggestedTargets??[]).filter(target=>(target.basis!=='visual'||selector.id===target.id)&&(!selector.id||target.id===selector.id)&&(!selector.name||target.name===selector.name)&&(!selector.controlType||target.controlType.toLowerCase()===selector.controlType.toLowerCase()))
      diagnostics.evidence=[{channel:'uia',result:matches.length===1?'unique target':matches.length?'ambiguous target':'target not found'}]
      if(matches.length>1)throw new InputRefused('UIA 目标不唯一；未发送输入')
      if(matches.length===1){
        const target=matches[0]
        let bounds=target.bbox
        if(target.basis==='visual'&&target.shadowedBy)throw new InputRefused('视觉候选已由 UIA 目标覆盖；请使用对应 UIA id')
        const scan=await this.privacyScanner(window.raw.windowId.toString(),window.public.pid)
        signal.throwIfAborted()
        const now=this.validateWindow(window)
        if(!scan.complete||scan.passwordRegions.length||titleIsPrivate(scan.windowTitle??window.public.title,this.limits.privacy)||this.state.epoch!==operation.epoch||this.state.status!=='enabled'||
          !sameRect(now,frame.rect)||now.foreground!==frame.foreground)throw new InputRefused('UIA 核验期间目标、隐私状态或授权改变；未发送输入')
        if(target.basis==='visual'){
          if(!frame.visualRawHash||selector.id!==target.id)throw new InputRefused('视觉候选只接受当前帧精确 id；未发送输入')
          const driver=await this.connect()
          const current=await driver.getWindowState({pid:window.public.pid,windowId:window.raw.windowId,includeScreenshot:true,includeAccessibilityTree:false,maxDimension:4096})
          if(current.pid!==window.public.pid||current.windowId!==window.raw.windowId||current.screenshotFrameValid===false||!current.images?.[0])throw new InputRefused('视觉候选复核未取得同一窗口图像；未发送输入')
          const currentHash=await imagePixelHash(Buffer.from(current.images[0].dataBase64,'base64'))
          if(currentHash!==frame.visualRawHash)throw new InputRefused('视觉候选对应画面已改变；未发送输入')
          const latestPrivacy=await this.privacyScanner(window.raw.windowId.toString(),window.public.pid)
          signal.throwIfAborted()
          const verifiedNow=this.validateWindow(window)
          if(!latestPrivacy.complete||latestPrivacy.passwordRegions.length||titleIsPrivate(latestPrivacy.windowTitle??window.public.title,this.limits.privacy)||
            this.state.epoch!==operation.epoch||this.state.status!=='enabled'||!sameRect(verifiedNow,frame.rect)||verifiedNow.foreground!==frame.foreground){
            throw new InputRefused('视觉候选复核期间隐私状态、窗口或授权已改变；未发送输入')
          }
          diagnostics.evidence=[{channel:'visual',result:'explicit current-frame id; pixels revalidated; region is not a semantic button assertion',targetId:target.id}]
          diagnostics.visualVerification={targetId:target.id,beforeScreenshotSha256:screenshotSha256(frame.public.data),elapsedMs:frame.public.accessibility?.visualCandidates?.elapsedMs??0}
        }else{
          const fresh=this.projectTargets(scan.targets??[],window,frame.screen,{width:frame.rawWidth,height:frame.rawHeight},frame.source,frame.public)
          const caption=frame.captionTargets?.get(target.id)
          // A standard Minimize button can use freshly calibrated bounds: the
          // actual HTMINBUTTON still has to match the owned HWND before dispatch.
          const recalibrateMinimize=target.stable===false&&caption==='minimize'
          const verified=fresh.targets.filter(candidate=>candidate.name===target.name&&candidate.controlType===target.controlType&&
            fresh.captionTargets.get(candidate.id)===caption&&(recalibrateMinimize||sameRect(candidate.bbox,target.bbox)))
          if(verified.length!==1)throw new InputRefused('UIA 目标已变化，请重新截图；未发送输入')
          if(caption&&caption!=='minimize')throw new InputRefused('子会话暂不支持按名称投递此标题栏按钮；未发送输入')
          expectsMinimize=caption==='minimize'
          if(recalibrateMinimize)bounds=verified[0].bbox
          if(target.bboxEvidence)diagnostics.evidence[0].bboxEvidence=target.bboxEvidence
        }
        action={...action,x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};diagnostics.evidence[0].targetId=target.id
      }
      else if(selector.id?.startsWith('visual-'))throw new InputRefused('视觉候选 id 不属于当前帧；未发送输入')
      else if(!selector.allowCoordinateFallback)throw new InputRefused('UIA 目标缺失；未批准坐标回退')
      else{
        coordinateClick=true
        diagnostics.evidence.push({channel:'coordinates',result:'explicit screenshot coordinate fallback'})
      }
    }
    if(coordinateClick&&action.type==='click'){
      const {x,y}=action
      const unstable=frame.public.accessibility?.suggestedTargets?.find(target=>target.basis==='uia-bounds'&&target.stable===false&&
        (containsPoint(target.bbox,x,y)||!!target.bboxEvidence?.second&&containsPoint(target.bboxEvidence.second,x,y)))
      if(unstable?.basis==='uia-bounds'){
        // The tool response must not recommend the same rejected fallback call.
        diagnostics.nextTool=action.target?'desktop_get_screenshot':'desktop_click_target'
        diagnostics.evidence?.push({channel:'uia',result:'unstable UIA bounds; blocked coordinate click',targetId:unstable.id,bboxEvidence:unstable.bboxEvidence})
        throw new InputRefused('UIA 候选坐标不稳定，未发送输入。请重新截图并调用 desktop_click_target 按名称或 id 点击')
      }
    }
    if(action.type==='click'&&!expectsMinimize){
      expectsMinimize=frame.public.accessibility?.suggestedTargets?.some(({id,bbox})=>
        frame.captionTargets?.get(id)==='minimize'&&action.x>=bbox.x&&action.x<bbox.x+bbox.width&&action.y>=bbox.y&&action.y<bbox.y+bbox.height)??false
    }
    let point: {x:number;y:number}
    try {point=imagePoint(action.x,action.y,frame.public,frame.source)} catch {throw new InputRefused('坐标超出已批准的截图；未发送输入')}
    diagnostics.sourcePoint=point
    if(this.childSession&&operation.delivery==='background'&&action.type==='type'&&this.backgroundInput?.replaceText){
      signal.throwIfAborted()
      const now=this.validateWindow(window)
      if(!sameRect(now,frame.rect)||now.foreground!==frame.foreground)throw new InputRefused('文本输入前窗口状态改变；未发送输入')
      try{
        const screenPoint={
          x:frame.screen.x+1+Math.floor(point.x*(frame.screen.width-2)/frame.rawWidth),
          y:frame.screen.y+1+Math.floor(point.y*(frame.screen.height-2)/frame.rawHeight),
        }
        diagnostics.effectivePoint=screenPoint;diagnostics.effectivePointSpace='physical-screen-pixels'
        diagnostics.delivery={kind:'EM_REPLACESEL',command:null}
        const sent=this.backgroundInput.replaceText(window.raw.windowId.toString(),window.public.pid,screenPoint,action.text)
        if(sent)return '已向授权焦点编辑控件替换所选文本；请核验新观察'
        delete diagnostics.effectivePoint;delete diagnostics.effectivePointSpace;delete diagnostics.delivery
      }catch(error){if(error instanceof BackgroundInputRefused)throw new InputRefused(error.message);throw error}
    }
    if (this.childSession && operation.delivery === 'background' && action.type === 'click' &&
      action.button === 'left' && action.count === 1 && this.backgroundInput?.tryMinimizeCaption) {
      signal.throwIfAborted()
      const now = this.validateWindow(window)
      if (!sameRect(now, frame.rect) || now.foreground !== frame.foreground) {
        throw new InputRefused('后台点击前窗口状态已改变，请重新观察')
      }
      // SDK Windows bitmaps crop one pixel inside the DWM bounds. The SDK image
      // may itself be resized, so project from its image dimensions to those bounds.
      const screenPoint = {
        x: frame.screen.x + 1 + Math.floor(point.x * (frame.screen.width - 2) / frame.rawWidth),
        y: frame.screen.y + 1 + Math.floor(point.y * (frame.screen.height - 2) / frame.rawHeight),
      }
      try {
        const minimized = this.backgroundInput.tryMinimizeCaption(window.raw.windowId.toString(), window.public.pid, screenPoint,
          () => {
            diagnostics.effectivePoint = screenPoint
            diagnostics.effectivePointSpace='physical-screen-pixels'
            diagnostics.delivery={kind:'WM_SYSCOMMAND',command:'SC_MINIMIZE'}
          },hit=>{diagnostics.hitTest=hit})
        if (minimized) return '已向目标窗口投递标题栏最小化操作'
        if(expectsMinimize)throw new InputRefused('标题栏坐标未命中原生最小化按钮；未发送输入')
      } catch (error) {
        if (error instanceof BackgroundInputRefused) throw new InputRefused(error.message)
        throw error
      }
    }
    if(expectsMinimize)throw new InputRefused('子会话后台最小化通道不可用；未发送输入')
    if (this.childSession && (action.type === 'key' || action.type === 'click' && action.count === 2)) {
      if (operation.delivery !== 'background' || !this.backgroundInput) throw new InputRefused('子会话后台按键或双击通道不可用；未发送输入')
      signal.throwIfAborted()
      const now = this.validateWindow(window)
      if (!sameRect(now, frame.rect) || now.foreground !== frame.foreground) throw new InputRefused('后台输入前窗口状态已改变，请重新观察')
      try {
        if (action.type === 'key') {
          diagnostics.delivery={kind:'WM_KEY_MESSAGES',command:null}
          this.backgroundInput.key(window.raw.windowId.toString(), window.public.pid, action.key, action.modifiers)
        }
        else {
          if (action.button !== 'left') throw new InputRefused('子会话双击仅支持左键；未发送输入')
          const screenPoint={x:Math.round(frame.screen.x + point.x * frame.screen.width / frame.rawWidth),y:Math.round(frame.screen.y + point.y * frame.screen.height / frame.rawHeight)}
          diagnostics.effectivePoint = screenPoint;diagnostics.effectivePointSpace='physical-screen-pixels'
          diagnostics.delivery={kind:'WM_MOUSE_MESSAGES',command:null}
          this.backgroundInput.doubleClick(window.raw.windowId.toString(), window.public.pid,screenPoint.x,screenPoint.y)
        }
      } catch (error) {
        if (error instanceof BackgroundInputRefused) throw new InputRefused(error.message)
        throw error
      }
      return '后台输入消息已交付；请检查新截图中的控件状态，消息交付不代表任务完成'
    }
    // Only the child-session worker supplies this route. It addresses one owned HWND,
    // without SendInput, cursor movement, foreground activation, or a fallback retry.
    if (action.type === 'scroll' && operation.delivery === 'background' && this.backgroundScroller) {
      if (action.direction !== 'up' && action.direction !== 'down') throw new InputRefused('子会话仅支持垂直滚动')
      signal.throwIfAborted()
      const now = this.validateWindow(window)
      if (!sameRect(now, frame.rect) || now.foreground !== frame.foreground) throw new InputRefused('滚动前窗口状态已改变，请重新观察')
      try {
        const screenPoint={x:Math.round(frame.screen.x + point.x * frame.screen.width / frame.rawWidth),y:Math.round(frame.screen.y + point.y * frame.screen.height / frame.rawHeight)}
        diagnostics.effectivePoint = screenPoint;diagnostics.effectivePointSpace='physical-screen-pixels'
        diagnostics.delivery={kind:'WM_MOUSEWHEEL',command:null}
        this.backgroundScroller.scroll(window.raw.windowId.toString(), window.public.pid,screenPoint.x,screenPoint.y,action.direction,action.amount)
      } catch (error) {
        if (error instanceof BackgroundScrollRefused) throw new InputRefused(error.message)
        throw error
      }
      return '后台滚动消息已交付；请检查新截图中的实际位置，消息交付不代表滚动或任务已完成'
    }
    const common={pid:window.public.pid,window_id:'__WINDOW_ID__',delivery_mode:operation.delivery,x:point.x,y:point.y}
    let tool: string; let args: Record<string,unknown>
    switch(action.type) {
      case 'click': tool='click'; args={...common,button:action.button,count:action.count}; break
      case 'type': tool='type_text'; args={...common,text:action.text,delay_ms:0}; break
      case 'key':
        if (!safeKey.test(action.key) || (action.modifiers.includes('alt') && /^(?:tab|f4)$/i.test(action.key)) || (action.modifiers.length>0 && /^(?:escape)$/i.test(action.key))) throw new InputRefused('此按键组合不在本机试用范围内；未发送输入')
        tool='press_key'; args={...common,key:action.key,modifiers:action.modifiers}; break
      case 'clear': tool='hotkey'; args={...common,keys:['ctrl','a']}; break
      case 'scroll': tool='scroll'; args={...common,direction:action.direction,amount:action.amount}; break
      case 'drag': case 'hold': {
        let to=point
        try {if(action.type==='drag')to=imagePoint(action.toX,action.toY,frame.public,frame.source)} catch {throw new InputRefused('拖拽终点超出截图；未发送输入')}
        tool='drag'; args={...common,from_x:point.x,from_y:point.y,to_x:to.x,to_y:to.y,duration_ms:action.durationMs,steps:20}; delete args.x;delete args.y;break
      }
      case 'move': {
        if (operation.delivery!=='foreground' || frame.foreground!==window.raw.windowId.toString()) throw new InputRefused('真实鼠标移动要求目标已在前台并已批准前台操作；未发送输入')
        const screenPoint={x:frame.screen.x+point.x*frame.screen.width/frame.rawWidth,y:frame.screen.y+point.y*frame.screen.height/frame.rawHeight}
        diagnostics.effectivePoint = screenPoint;diagnostics.effectivePointSpace='physical-screen-pixels'
        diagnostics.delivery={kind:'pointer',command:null}
        this.identity.movePointer(screenPoint.x,screenPoint.y); return '鼠标已移动；请检查新的观察'
      }
    }
    const driver=await this.connect()
    const json=JSON.stringify(args).replace('"__WINDOW_ID__"',window.raw.windowId.toString())
    signal.throwIfAborted()
    diagnostics.effectivePoint = point
    diagnostics.effectivePointSpace='sdk-image-pixels'
    diagnostics.delivery={kind:'sdk',command:null}
    const result=await driver.callTool(tool,json,{signal})
    if (result.action?.effect===ActionEffect.Refused) throw new InputRefused(`执行器拒绝：${result.errorCode ?? result.text.slice(0,300)}`)
    if (result.isError || result.action?.effect===ActionEffect.Partial || result.action?.effect===ActionEffect.SuspectedNoop) throw new Error(`输入效果未确认：${result.errorCode ?? result.text.slice(0,300)}`)
    if (action.type==='clear') {
      signal.throwIfAborted()
      const now=this.validateWindow(window)
      if(!sameRect(now,frame.rect))throw new Error('清空期间窗口移动，剩余步骤已停止')
      const {x:_x,y:_y,...target}=common
      const erased=await driver.callTool('press_key',JSON.stringify({...target,key:'backspace'}).replace('"__WINDOW_ID__"',window.raw.windowId.toString()),{signal})
      if (erased.isError) throw new Error('清空结果未知，请重新观察')
    }
    return '输入已交付；这不代表任务完成，请查看动作后的新截图'
  }
  async pause(stop=false): Promise<DesktopRuntimeState> {
    if(stop)this.stopRequested=true
    if(this.draining){if(stop)this.state.status='stopping';return await this.draining}
    if(this.state.status==='stopped' || (!stop && this.state.status==='paused')){this.stopRequested=false;return this.snapshot()}
    this.state.epoch++; this.state.status=this.stopRequested?'stopping':'pausing'; this.frame=undefined; this.abort?.abort()
    this.draining=(async()=>{
      await this.busy?.catch(()=>{});await this.reading?.catch(()=>{})
      const driver=this.driver;this.driver=undefined
      try {
        if(driver){await driver.shutdown();driver.uniffiDestroy?.()}
      } catch(error) {this.state.status='failed';throw error}
      finally {this.releaseLease?.();this.releaseLease=undefined}
      const terminate=this.stopRequested
      this.state.status=terminate?'stopped':'paused'
      if(terminate){this.selected=undefined;this.state.window=null;this.state.foregroundAllowed=false;delete this.state.windowDiscovery}
      const connection = this.childSession ? '画中画执行器' : '本机连接'
      this.state.lastResult=terminate?`${connection}已终止；旧帧和许可失效`:'输入已排空并关闭驱动；继续后须获取新截图'
      return this.snapshot()
    })()
    try{return await this.draining}finally{this.draining=undefined;this.stopRequested=false}
  }
  async resume(): Promise<DesktopRuntimeState> {
    if (this.state.status!=='paused') throw new Error('只有暂停的连接可继续；终止后须重新授权')
    const epoch=this.state.epoch
    if (this.selected) { this.validateWindow(this.selected); this.releaseLease=this.identity.acquireLease() }
    await this.connect();if(epoch!==this.state.epoch)throw new Error('继续期间许可已撤销')
    this.state.epoch++;this.state.status=this.selected?'enabled':'observing';this.frame=undefined
    return this.snapshot()
  }
}
function sameRect(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number}) { return a.x===b.x && a.y===b.y && a.width===b.width && a.height===b.height }
