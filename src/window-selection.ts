import type { SdkSelection } from './native-contract.ts'

export interface RawWindowObservation { id: string; visible: boolean; minimized: boolean; boundsValid: boolean }

/** Observed Win32 state, not a claim about the SDK's private exclusion rules. */
export function compareWindowSamples(raw: RawWindowObservation[], candidates: string[]): SdkSelection {
  const sdk = new Set(candidates), ids = new Set(raw.map(window => window.id))
  const states = { notVisible: 0, minimized: 0, invalidBounds: 0, otherOrUnknown: 0 }
  let notCandidate = 0
  for (const window of raw) {
    if (sdk.has(window.id)) continue
    notCandidate++
    if (!window.visible) states.notVisible++
    else if (window.minimized) states.minimized++
    else if (!window.boundsValid) states.invalidBounds++
    else states.otherOrUnknown++
  }
  return { notCandidate, candidateNotInRaw: [...sdk].filter(id => !ids.has(id)).length,
    observedStates: states,
    note: 'Win32 与 SDK 是相邻时刻的独立采样。observedStates 按不可见、最小化、无效尺寸、其他顺序互斥计数，不代表 SDK 内部过滤原因；未知项不推断为 DWM cloaked。' }
}
