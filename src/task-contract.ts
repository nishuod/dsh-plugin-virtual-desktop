import { z } from 'zod'

export const routeSchema = z.strictObject({
  provider: z.string().trim().min(1).max(160),
  model: z.string().trim().min(1).max(200),
})

export const valueCheckSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  expected: z.string().max(2000),
})
export type ValueCheck = z.infer<typeof valueCheckSchema>

export const taskGoalSchema = z.strictObject({
  goal: z.string().trim().min(1).max(1500),
  acceptance: z.string().trim().min(1).max(600),
  maxSteps: z.int().min(1).max(24).default(10),
  timeoutSeconds: z.int().min(30).max(600).default(180),
  delivery: z.enum(['background', 'foreground']).default('background'),
})

export const taskRequestSchema = taskGoalSchema.extend({
  route: routeSchema,
  windowId: z.uuid(),
  epoch: z.int().positive(),
  valueCheck: valueCheckSchema.optional(),
})
export type TaskRequest = z.infer<typeof taskRequestSchema>

export interface TaskRoute { provider: string; model: string; label: string }
export interface TaskLogEntry {
  time: number
  step: number
  kind: 'start' | 'observed' | 'model' | 'approval' | 'dispatch' | 'result' | 'evaluation' | 'control' | 'error'
  message: string
}
export interface TaskReview {
  id: string
  kind: 'input' | 'verification'
  frameId: string
  detail: string
  explanation: string
}
export interface TaskSnapshot {
  id: string
  status: 'observing' | 'planning' | 'awaiting-approval' | 'executing' | 'verifying'
    | 'awaiting-verification' | 'pausing' | 'paused' | 'resuming' | 'stopping'
    | 'stopped' | 'completed' | 'failed' | 'budget-exhausted' | 'blocked'
  active: boolean
  goal: string
  acceptance: string
  windowTitle: string
  provider: string
  model: string
  step: number
  maxSteps: number
  deadlineAt: number
  frameId: string | null
  review: TaskReview | null
  logs: TaskLogEntry[]
}
