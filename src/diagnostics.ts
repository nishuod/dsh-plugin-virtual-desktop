/** Client-safe status vocabulary. It never represents a native desktop session. */
export type {DesktopWindow,DesktopFrame,DesktopRuntimeState,DesktopReceipt,WindowDiscovery} from './native-contract.ts'
export type { TaskRoute, TaskSnapshot, TaskReview, TaskLogEntry } from './task-contract.ts'
export interface DiagnosticState {
  readonly stage: 'phase2'
  readonly status: 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped'
  readonly backend: 'diagnostic-only'
  readonly nativeDesktop: false
  readonly inputEnabled: false
  readonly isolated: false
  readonly protocolVersion: number
  readonly workerPid: number | null
  readonly probes: number
  readonly lastFeedback: string
  readonly completionPolicy: 'external-evaluator-required'
}
export type { ChildLaunchReceipt } from './native-contract.ts'
export type { SdkSelection } from './native-contract.ts'

export type { ApplicationResult } from './native-contract.ts'
export type { ChildSessionResetResult } from './reset-contract.ts'
