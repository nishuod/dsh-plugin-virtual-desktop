import { z } from 'zod'

export const pointSchema = z.strictObject({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() })
export const cropSchema = pointSchema.extend({ width: z.int().positive(), height: z.int().positive() })
export const targetSelectorSchema = z.strictObject({id:z.string().max(80).optional(),name:z.string().min(1).max(512).optional(),controlType:z.string().max(80).optional(),allowCoordinateFallback:z.boolean().default(false)})
  .refine(value=>Boolean(value.id)||Boolean(value.name),'Target id or name required')
export const actionSchema = z.discriminatedUnion('type', [
  pointSchema.extend({ type: z.literal('click'), button: z.enum(['left', 'right', 'middle']).default('left'), count: z.int().min(1).max(2).default(1), target:targetSelectorSchema.optional() }),
  pointSchema.extend({ type: z.literal('move') }),
  pointSchema.extend({ type: z.literal('hold'), durationMs: z.int().min(100).max(2000) }),
  pointSchema.extend({ type: z.literal('drag'), toX: z.number().finite().nonnegative(), toY: z.number().finite().nonnegative(), durationMs: z.int().min(100).max(2000).default(500) }),
  pointSchema.extend({ type: z.literal('type'), text: z.string().min(1).max(2000) }),
  pointSchema.extend({ type: z.literal('key'), key: z.string().min(1).max(24), modifiers: z.array(z.enum(['ctrl', 'shift', 'alt'])).max(3).default([]) }),
  pointSchema.extend({ type: z.literal('clear') }),
  pointSchema.extend({ type: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.int().min(1).max(10).default(3) }),
])
export type DesktopAction = z.infer<typeof actionSchema>
export type DesktopBackend = 'windows-attended' | 'windows-child-session'
export interface ChildLaunchReceipt { operationId: string; path: string; pid: number; outcome: 'started'; message: string }
export interface DesktopWindow {
  id: string; title: string; app: string; pid: number
  imagePath?: string; windowClass?: string; responsive?: boolean
  x: number; y: number; width: number; height: number
}
const frameScaleSchema = z.strictObject({
  rawWidth: z.int().positive(), rawHeight: z.int().positive(),
  width: z.int().positive(), height: z.int().positive(),
})
export type FrameScale = z.infer<typeof frameScaleSchema>

const targetBounds = {bbox:cropSchema,crop:cropSchema}
const bboxEvidenceSchema = z.strictObject({
  first:cropSchema,second:cropSchema.nullable(),deltaPx:z.int().nonnegative().nullable(),
})
export type BboxEvidence = z.infer<typeof bboxEvidenceSchema>
const suggestedTargetSchema = z.discriminatedUnion('basis', [
  z.strictObject({...targetBounds,id:z.string().max(80),name:z.string().max(512),controlType:z.string().max(80),basis:z.literal('uia-bounds'),
    stable:z.boolean().optional(),bboxEvidence:bboxEvidenceSchema.optional()}),
  z.strictObject({...targetBounds,id:z.string().regex(/^visual-\d+(?:\.icon-[0-2])?$/).max(80),name:z.literal(''),controlType:z.literal('region'),basis:z.literal('visual'),confidence:z.number().min(0).max(1),shadowedBy:z.string().max(80).optional(),
    parent:z.string().regex(/^visual-\d+$/).max(80).optional(),
  }).refine(target => target.id.includes('.icon-')
    ? target.parent === target.id.split('.icon-')[0]
    : target.parent === undefined, 'Visual icon must name its own parent'),
])

export interface FrameAccessibility {
  status: 'available' | 'limited' | 'unavailable'
  scope: 'window'
  unnamedButtons?: number
  treeTruncated: boolean
  guidance: string
  suggestedTargets?: z.infer<typeof suggestedTargetSchema>[]
  visualCandidates?: {elapsedMs:number;truncated:boolean;reason?:string;clientArea?:{x:number;y:number;width:number;height:number}}
}
const frameAccessibilitySchema: z.ZodType<FrameAccessibility> = z.strictObject({
  status: z.enum(['available', 'limited', 'unavailable']), scope: z.literal('window'),
  unnamedButtons: z.int().nonnegative().optional(), treeTruncated: z.boolean(), guidance: z.string().max(512),
  suggestedTargets:z.array(suggestedTargetSchema).max(72).optional(),
  visualCandidates:z.strictObject({elapsedMs:z.number().nonnegative(),truncated:z.boolean(),reason:z.string().max(80).optional(),clientArea:cropSchema.optional()}).optional(),
})

export interface DesktopFrame {
  id: string; windowId: string; epoch: number; capturedAt: number
  width: number; height: number; mimeType: 'image/jpeg'; data: string
  source: 'window' | 'desktop'; tree: string
  valueCheck?: 'match' | 'mismatch' | 'unavailable'
  visualContent?: boolean
  accessibility?: FrameAccessibility
  privacy?: {status:'redacted'|'clear'|'blocked';passwordRegions:number;configuredRegions:number;titleMatched:boolean;reason?:string}
  scale?: FrameScale
  filePath?: string
  notice?: string
}
export const windowFailureSchema = z.strictObject({
  reason: z.enum(['minimized', 'hidden', 'resized', 'exited', 'identity-changed']),
  nextTool: z.string().min(1).max(100),
})
export type WindowFailure = z.infer<typeof windowFailureSchema>
export class NativeWindowError extends Error implements WindowFailure {
  readonly nextTool: string
  constructor(readonly reason: WindowFailure['reason'], message: string) {
    super(message)
    this.name = 'NativeWindowError'
    this.nextTool = reason === 'minimized' || reason === 'hidden' ? 'desktop_restore_window'
      : reason === 'resized' ? 'desktop_get_screenshot' : 'desktop_get_windows'
  }
}
export function windowFailure(error: unknown): WindowFailure | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as Partial<WindowFailure>
  const result = windowFailureSchema.safeParse({ reason: candidate.reason, nextTool: candidate.nextTool })
  return result.success ? result.data : undefined
}
export const restoreWindowSchema = z.strictObject({ windowId: z.uuid(), pid: z.int().positive(), expectedEpoch: z.int().nonnegative() })
export interface WindowDiscovery {
  sdkSelection?: SdkSelection
  sampledAt: number
  rawTopLevel: number | null
  sdkCandidates: number
  workerEligible: number
  sessionEligible?: number
  systemSurfaces?: { pid: number; image: string; title: string; reason: string }[]
  filtered: {
    missingPid: number
    minimized: number
    invalidBounds: number
    blockedProcess: number
    systemSurface: number
    unverifiedProcess: number
    unverifiedWindow: number
    limit: number
  }
}
export type SdkSelection = {
  notCandidate: number
  candidateNotInRaw: number
  observedStates: { notVisible: number; minimized: number; invalidBounds: number; otherOrUnknown: number }
  note: string
}
const windowCount = z.int().nonnegative()
const windowDiscoverySchema: z.ZodType<WindowDiscovery> = z.strictObject({
  sdkSelection: z.strictObject({notCandidate:windowCount,candidateNotInRaw:windowCount,
    observedStates:z.strictObject({notVisible:windowCount,minimized:windowCount,invalidBounds:windowCount,otherOrUnknown:windowCount}),note:z.string().max(512)}).optional(),
  sampledAt: z.int().positive(),
  rawTopLevel: windowCount.nullable(),
  sdkCandidates: windowCount,
  workerEligible: windowCount,
  sessionEligible: windowCount.optional(),
  systemSurfaces: z.array(z.strictObject({ pid: z.int().positive(), image: z.string().max(256), title: z.string().max(512), reason: z.string().max(256) })).max(150).optional(),
  filtered: z.strictObject({
    missingPid: windowCount,
    minimized: windowCount,
    invalidBounds: windowCount,
    blockedProcess: windowCount,
    systemSurface: windowCount,
    unverifiedProcess: windowCount,
    unverifiedWindow: windowCount,
    limit: windowCount,
  }),
})
const displayResolutionSchema = z.strictObject({ width: z.int().positive().max(32768), height: z.int().positive().max(32768) })
export const pipDisplaySchema = z.strictObject({
  requested: displayResolutionSchema,
  actual: displayResolutionSchema.nullable(),
  source: z.literal('wts-client-display'),
  sampledAt: z.int().positive(),
})
export type PipDisplay = z.infer<typeof pipDisplaySchema>

export interface DesktopRuntimeState {
  backend: DesktopBackend; isolated: boolean
  parentSessionId?: number; childSessionId?: number
  connectionId?: string
  pipDisplay?: PipDisplay
  windowDiscovery?: WindowDiscovery
  status: 'disabled' | 'observing' | 'enabled' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'failed'
  epoch: number; window: DesktopWindow | null; foregroundAllowed: boolean
  inputMode: 'ask-each-action'; lastResult: string
  capabilities: { windowCapture: boolean; desktopCapture: boolean; regionCapture: boolean; clipboard: false; autonomousTask: false }
}
export interface HitTestEvidence {
  point: {x:number;y:number}
  screenPoint: {x:number;y:number}
  windowOrigin: {x:number;y:number}
  windowRelative: true
  class: string
  code: number
}
export interface InputDeliveryEvidence {
  kind: 'sdk'|'WM_SYSCOMMAND'|'WM_MOUSE_MESSAGES'|'WM_KEY_MESSAGES'|'WM_MOUSEWHEEL'|'EM_REPLACESEL'|'pointer'
  command: 'SC_MINIMIZE'|null
}
export interface DesktopReceipt {
  operationId: string
  outcome: 'delivered' | 'refused' | 'unknown'
  message: string
  after: DesktopFrame | null
  /** Coordinate space of the submitted point; sourcePoint preserves the SDK image projection. */
  coordinates?: 'screenshot-pixels' | 'raw-pixels'
  sourcePoint?: { x: number; y: number }
  /** Point passed to the selected executor route, in effectivePointSpace. */
  effectivePoint?: { x: number; y: number }
  effectivePointSpace?: 'sdk-image-pixels'|'physical-screen-pixels'
  hitTest?: HitTestEvidence
  delivery?: InputDeliveryEvidence
  sourceScale?: FrameScale
  postAction?: WindowFailure
  nextTool?: 'desktop_click_target'|'desktop_get_screenshot'
  evidence?: {channel:'uia'|'visual'|'coordinates'|'verification';result:string;targetId?:string;bboxEvidence?:BboxEvidence}[]
  visualVerification?: {targetId:string;beforeScreenshotSha256:string;afterScreenshotSha256?:string;changedRegion?:{x:number;y:number;width:number;height:number}|null;elapsedMs:number}
}
export const operationSchema = z.strictObject({ operationId: z.uuid(), frameId: z.uuid(), epoch: z.int().positive(), delivery: z.enum(['background', 'foreground']).default('background'), action: actionSchema })
export type DesktopOperation = z.infer<typeof operationSchema>
export const nativeRequestSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(),
  method: z.enum(['enable', 'windows', 'launch', 'appCommand', 'appCommandScope', 'select', 'restore', 'capture', 'execute', 'pause', 'resume', 'stop', 'status', 'shutdown']),
  payload: z.unknown(),
})
export const nativeReplySchema = z.strictObject({ version: z.literal(1), id: z.uuid(), ok: z.boolean(), value: z.unknown(), error: z.string().max(1000).optional(), details: windowFailureSchema.optional() })
export const MAX_NATIVE_BYTES = 2 * 1024 * 1024

export const windowSchema = z.strictObject({imagePath:z.string().max(32768).optional(),windowClass:z.string().max(256).optional(),responsive:z.boolean().optional(),id: z.uuid(), title: z.string().max(512), app: z.string().max(256), pid: z.int().positive(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive()}) satisfies z.ZodType<DesktopWindow>
export const frameSchema = z.strictObject({
  id: z.uuid(), windowId: z.string(), epoch: z.int(), capturedAt: z.number(),
  width: z.int().positive(), height: z.int().positive(), mimeType: z.literal('image/jpeg'),
  data: z.string().max(900_000), source: z.enum(['window','desktop']), tree: z.string().max(12000),
  valueCheck: z.enum(['match', 'mismatch', 'unavailable']).optional(), visualContent: z.boolean().optional(),
  accessibility: frameAccessibilitySchema.optional(),
  privacy: z.strictObject({status:z.enum(['redacted','clear','blocked']),passwordRegions:z.int().nonnegative(),configuredRegions:z.int().nonnegative(),titleMatched:z.boolean(),reason:z.string().max(512).optional()}).optional(),
  scale: frameScaleSchema.optional(), filePath: z.string().max(32768).optional(), notice: z.string().max(1000).optional(),
}) satisfies z.ZodType<DesktopFrame>
export const runtimeStateSchema = z.strictObject({backend: z.literal('windows-attended'), isolated: z.literal(false), status: z.enum(['disabled','observing','enabled','pausing','paused','stopping','stopped','failed']), epoch: z.int(), window: windowSchema.nullable(), foregroundAllowed: z.boolean(), inputMode: z.literal('ask-each-action'), lastResult: z.string(), capabilities: z.strictObject({windowCapture: z.boolean(), desktopCapture: z.boolean(), regionCapture: z.boolean(), clipboard: z.literal(false), autonomousTask: z.literal(false)}), windowDiscovery: windowDiscoverySchema.optional()}) satisfies z.ZodType<DesktopRuntimeState>
const restoredWindowStateSchema = runtimeStateSchema.extend({
  state: z.literal('restored'), status: z.literal('enabled'), verified: z.literal(true),
  nextTool: z.literal('desktop_get_screenshot'),
  window: windowSchema.extend({ x: z.int().gt(-30000), y: z.int().gt(-30000), width: z.int().gt(1), height: z.int().gt(1) }),
})
export const restorePendingSchema = z.strictObject({
  state: z.literal('restoring'), retryAfterMs: z.literal(200), nextTool: z.literal('desktop_get_screenshot'),
})
export const nativeRestoreResultSchema = z.discriminatedUnion('state', [
  restoredWindowStateSchema,
  restorePendingSchema.extend({windowId:z.uuid(),pid:z.int().positive(),epoch:z.int().nonnegative()}),
])
export type NativeRestoreResult = z.infer<typeof nativeRestoreResultSchema>
export const restoreWindowResultSchema = z.union([
  restorePendingSchema,
  restoredWindowStateSchema.extend({connectionId:z.uuid()}),
  restoredWindowStateSchema.extend({
    backend:z.literal('windows-child-session'), isolated:z.literal(true), connectionId:z.uuid(),
    childSessionId:z.int().positive(), parentSessionId:z.int().positive(), pipDisplay:pipDisplaySchema.optional(),
  }),
])
export type RestoreWindowResult = z.infer<typeof restoreWindowResultSchema>
export const receiptSchema = z.strictObject({
  operationId: z.uuid(), outcome: z.enum(['delivered','refused','unknown']),
  message: z.string(), after: frameSchema.nullable(),
  coordinates: z.enum(['screenshot-pixels', 'raw-pixels']).optional(),
  sourcePoint: pointSchema.optional(),
  effectivePoint: z.strictObject({x:z.number().finite(),y:z.number().finite()}).optional(),
  effectivePointSpace: z.enum(['sdk-image-pixels','physical-screen-pixels']).optional(),
  hitTest: z.strictObject({point:pointSchema,screenPoint:z.strictObject({x:z.number().finite(),y:z.number().finite()}),windowOrigin:z.strictObject({x:z.number().finite(),y:z.number().finite()}),windowRelative:z.literal(true),class:z.string().regex(/^HT[A-Z]+$/).max(32),code:z.int().min(-2).max(0x7fffffff)}).optional(),
  delivery: z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('WM_SYSCOMMAND'),command:z.literal('SC_MINIMIZE')}),
    z.strictObject({kind:z.enum(['sdk','WM_MOUSE_MESSAGES','WM_KEY_MESSAGES','WM_MOUSEWHEEL','EM_REPLACESEL','pointer']),command:z.null()}),
  ]).optional(),
  sourceScale: frameScaleSchema.optional(),
  postAction: windowFailureSchema.optional(),
  nextTool:z.enum(['desktop_click_target','desktop_get_screenshot']).optional(),
  evidence:z.array(z.strictObject({channel:z.enum(['uia','visual','coordinates','verification']),result:z.string().max(512),targetId:z.string().max(80).optional(),bboxEvidence:bboxEvidenceSchema.optional()})).max(8).optional(),
  visualVerification:z.strictObject({targetId:z.string().max(80),beforeScreenshotSha256:z.string().regex(/^[a-f0-9]{64}$/),afterScreenshotSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),changedRegion:cropSchema.nullable().optional(),elapsedMs:z.number().nonnegative()}).optional(),
}) satisfies z.ZodType<DesktopReceipt>

/** Exact server-owned inverse resize/crop map; clients cannot supply transforms. */
export function imagePoint(x: number, y: number, frame: {width: number; height: number}, source: {x: number; y: number; width: number; height: number}): {x: number; y: number} {
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error('坐标不在当前截图内')
  return { x: source.x + x * source.width / frame.width, y: source.y + y * source.height / frame.height }
}

export interface ApplicationResult {
  operationId: string
  status: 'ready' | 'needs_review' | 'app_error' | 'instance_conflict' | 'timed_out' | 'unknown'
  stage: string
  path: string
  message: string
  connectionId?: string
  childSessionId?: number
  pipDisplay?: PipDisplay
  epoch?: number
  pid?: number
  window?: DesktopWindow
  frame?: DesktopFrame
  reused?: boolean
}
