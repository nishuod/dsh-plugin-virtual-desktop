import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const decoder = new TextDecoder('utf-8', { fatal: true })
const pipePathSchema = z.string().regex(/^\\\\\.\\pipe\\DSH\.AppBroker\.[0-9a-f]{32}$/)
const nonceSchema = z.string().regex(/^[0-9a-f]{64}$/)
const pidSchema = z.coerce.number().int().positive().lt(0xffffffff)

interface AppBrokerCall {
  timeoutMs: number
  maxReplyBytes: number
  signal?: AbortSignal
  beforeSend: () => void
  verifyPid: (pid: number) => void
}

const errnoSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/)
export const appBrokerTransportErrorSchema = z.strictObject({
  phase: z.enum(['connect', 'exchange']),
  reason: z.union([errnoSchema, z.enum(['cancelled', 'timeout', 'closed', 'io-error'])]),
})
type AppBrokerPhase = z.infer<typeof appBrokerTransportErrorSchema>['phase']

export class AppBrokerTransportError extends Error {
  constructor(readonly phase: AppBrokerPhase, readonly reason: string, cause?: unknown) {
    super(reason === 'cancelled' || reason === 'timeout'
      ? '原生应用调用已取消或超时，结果未知，请核对状态'
      : '原生应用通道已中断，结果未知，请核对状态', { cause })
  }
}

/** The broker accepts only the bridge process that it created for this child. */
export async function callAppBroker(fields: Record<string, unknown>, call: AppBrokerCall): Promise<unknown> {
  const timeout = AbortSignal.timeout(call.timeoutMs)
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
  signal.throwIfAborted()
  const path = pipePathSchema.parse(process.env.DSH_APP_PIPE)
  const nonce = nonceSchema.parse(process.env.DSH_APP_NONCE)
  const brokerPid = pidSchema.parse(process.env.DSH_APP_PID)
  call.verifyPid(brokerPid)
  const id = randomUUID()
  const request = JSON.stringify({ ...fields, version: 1, id, nonce })
  if (Buffer.byteLength(request) > 8192) throw new Error('原生应用请求超过上限')
  const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ version: z.literal(1), id: z.literal(id), ok: z.literal(true), value: z.unknown() }),
    z.strictObject({ version: z.literal(1), id: z.literal(id), ok: z.literal(false), error: z.string().max(8192) }),
  ])
  const socket = createConnection({ path })
  let phase: AppBrokerPhase = 'connect'
  const abort = () => socket.destroy(new AppBrokerTransportError(phase, timeout.aborted ? 'timeout' : 'cancelled'))
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      let bytes = Buffer.alloc(0)
      socket.once('error', error => {
        const code = (error as NodeJS.ErrnoException).code
        const errno = errnoSchema.safeParse(code)
        const reason = errno.success ? errno.data : 'io-error'
        reject(error instanceof AppBrokerTransportError ? error : new AppBrokerTransportError(phase, reason, error))
      })
      socket.once('close', () => reject(new AppBrokerTransportError(phase, 'closed')))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      socket.once('connect', () => {
        phase = 'exchange'
        try {
          signal.throwIfAborted()
          call.verifyPid(brokerPid)
          call.beforeSend()
          socket.write(request + '\n')
        } catch (error) {
          reject(error)
          socket.destroy()
        }
      })
      socket.on('data', (chunk: Buffer) => {
        try {
          if (bytes.length + chunk.length > call.maxReplyBytes) throw new Error('原生应用响应超过上限')
          bytes = Buffer.concat([bytes, chunk])
          const end = bytes.indexOf(10)
          if (end < 0) return
          if (end !== bytes.length - 1) throw new Error('原生应用返回了多余数据')
          const reply = replySchema.parse(JSON.parse(decoder.decode(bytes.subarray(0, end))))
          if (!reply.ok) throw new Error(reply.error)
          resolve(reply.value)
        } catch (error) {
          reject(error)
          socket.destroy()
        }
      })
    })
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abort)
    socket.destroy()
  }
}
