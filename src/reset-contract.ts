import type { DesktopRuntimeState } from './native-contract.ts'

/** releasedPids identifies only broker handles owned by this plugin operation. */
export interface ChildSessionResetResult extends DesktopRuntimeState {
  operationId: string
  state: 'idle' | 'released'
  releasedPids: number[]
}
