import { z } from 'zod'
import { DesktopError } from './protocol.ts'
import { actionSchema, type DesktopAction } from './native-contract.ts'

export const decisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('act'), explanation: z.string().max(512), action: actionSchema }),
  z.strictObject({ kind: z.literal('finished'), explanation: z.string().max(512) }),
  z.strictObject({ kind: z.literal('blocked'), explanation: z.string().min(1).max(512) }),
])
export type Decision = z.infer<typeof decisionSchema>
export interface Observation { readonly revision: number; readonly feedback: string }
export interface Outcome { readonly action: Decision & { kind: 'act' }; readonly receipt: string; readonly after: Observation }
export interface ContextMemory {
  readonly task: string
  readonly acceptance: string
  readonly observation: Observation
  readonly recent: readonly Outcome[]
  /** Deterministic summaries of observed results, not a claim of paper-level memory. */
  readonly earlierSummary: readonly string[]
}
export interface LoopPorts {
  /** Must read the executor's actual state; never synthesize success from a decision. */
  observe(signal: AbortSignal, purpose: 'plan' | 'after-action' | 'evaluate'): Promise<Observation>
  decide(context: ContextMemory, signal: AbortSignal): Promise<unknown>
  execute(action: DesktopAction, revision: number, signal: AbortSignal): Promise<string>
  afterAction?(): void
  rejectDecision?(feedback: string): void
  /** Independent completion authority, not the model that emitted finished. */
  evaluate(context: ContextMemory, signal: AbortSignal): Promise<{
    verdict: 'pass' | 'fail' | 'inconclusive'; revision: number; evidence: string
  }>
  /** Commit before exposing the same context/decision/result to the next consumer. */
  record(event: LoopEvent): Promise<void>
}
export type LoopEvent =
  | { type: 'observed'; observation: Observation }
  | { type: 'context'; context: ContextMemory }
  | { type: 'decision'; decision: Decision }
  | { type: 'receipt'; receipt: string }
  | { type: 'evaluation'; verdict: string; revision: number; evidence: string }

export class InvalidDecision extends Error {}

/** The same bounded memory is kept across a deliberate pause and resume. */
export class LoopMemory {
  stepsUsed = 0
  revision = -1
  readonly recent: Outcome[] = []
  readonly earlierSummary: string[] = []
}

export async function runLoopContract(
  task: string, acceptance: string, ports: LoopPorts,
  limits: { steps: number; recent: number; summary: number }, signal: AbortSignal,
  memory = new LoopMemory(),
): Promise<'completed' | 'budget-exhausted' | 'blocked'> {
  if (![limits.steps, limits.recent, limits.summary].every(n => Number.isInteger(n) && n > 0)) {
    throw new DesktopError('invalid-state', 'Loop limits must be positive integers')
  }
  const { recent, earlierSummary } = memory
  const summarize = (summary: string) => {
    earlierSummary.push(summary.slice(0, 400))
    if (earlierSummary.length > limits.summary) earlierSummary.shift()
  }
  const observe = async (purpose: Parameters<LoopPorts['observe']>[1]) => {
    signal.throwIfAborted()
    const observation = await ports.observe(signal, purpose)
    signal.throwIfAborted()
    if (!Number.isSafeInteger(observation.revision) || observation.revision <= memory.revision) {
      throw new DesktopError('invalid-state', 'A new executor observation is required')
    }
    memory.revision = observation.revision
    await ports.record({ type: 'observed', observation })
    return observation
  }
  if (memory.stepsUsed >= limits.steps) return 'budget-exhausted'
  let observation = await observe('plan')
  while (memory.stepsUsed < limits.steps) {
    signal.throwIfAborted()
    memory.stepsUsed++
    const context: ContextMemory = structuredClone({ task, acceptance, observation, recent, earlierSummary })
    await ports.record({ type: 'context', context })
    signal.throwIfAborted()
    let decision: Decision
    try {
      const parsed = decisionSchema.safeParse(await ports.decide(context, signal))
      if (!parsed.success) throw new InvalidDecision('Invalid model action; nothing dispatched')
      decision = parsed.data
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof InvalidDecision) || !ports.rejectDecision) throw error
      ports.rejectDecision(error.message)
      summarize('上一步的模型输出未通过校验，没有派发输入。请根据新观察给出一个合法动作。')
      observation = await observe('plan')
      continue
    }
    signal.throwIfAborted()
    await ports.record({ type: 'decision', decision })
    signal.throwIfAborted()
    if (decision.kind === 'blocked') return 'blocked'
    if (decision.kind === 'finished') {
      // A completion claim always triggers a fresh observation and independent evaluation.
      observation = await observe('evaluate')
      const evaluationContext: ContextMemory = structuredClone({ ...context, observation })
      await ports.record({ type: 'context', context: evaluationContext })
      signal.throwIfAborted()
      const evaluation = await ports.evaluate(evaluationContext, signal)
      signal.throwIfAborted()
      await ports.record({ type: 'evaluation', ...evaluation })
      signal.throwIfAborted()
      if (evaluation.revision !== observation.revision || evaluation.evidence.trim() === '') {
        throw new DesktopError('invalid-state', 'Evaluator must cite the fresh observation')
      }
      if (evaluation.verdict === 'pass') return 'completed'
      summarize(`Completion check ${evaluation.verdict} at ${evaluation.revision}: ${evaluation.evidence}`)
      if (memory.stepsUsed < limits.steps) observation = await observe('plan')
    } else {
      const receipt = await ports.execute(decision.action, observation.revision, signal)
      signal.throwIfAborted()
      await ports.record({ type: 'receipt', receipt })
      observation = await observe('after-action')
      recent.push({ action: decision, receipt, after: observation })
      if (recent.length > limits.recent) {
        const older = recent.shift()!
        summarize(`Observed after revision ${older.after.revision}: ${older.receipt}. ${older.after.feedback}`)
      }
      ports.afterAction?.()
    }
  }
  return 'budget-exhausted'
}
