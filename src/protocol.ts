import { z } from 'zod'

/** IPC is private to the child we spawn; no network listener is opened. */
export const PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 16_384
export const requestSchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION), id: z.uuid(),
  method: z.enum(['health', 'probe', 'shutdown']),
})
export const replySchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION), id: z.uuid(),
  kind: z.literal('diagnostic-only'), pid: z.int().positive(),
  nativeDesktop: z.literal(false), inputEnabled: z.literal(false),
  sequence: z.int().nonnegative(),
})
export type WorkerReply = z.infer<typeof replySchema>
export type WorkerRequest = z.infer<typeof requestSchema>

export class DesktopError extends Error {
  constructor(
    public readonly code: 'protocol' | 'worker-unavailable' | 'timeout' | 'cancelled' | 'permission-denied' | 'invalid-state',
    message: string,
    options?: ErrorOptions,
  ) { super(message, options); this.name = 'DesktopError' }
}

/** Validate every process-boundary message before considering its contents. */
export function boundedParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
    throw new DesktopError('protocol', 'Worker message exceeds the protocol limit')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new DesktopError('protocol', 'Invalid worker message')
  return parsed.data
}
