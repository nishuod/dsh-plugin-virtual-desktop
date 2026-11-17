import { realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { z } from 'zod'
import type { ChildLaunchReceipt } from './native-contract.ts'
import { callAppBroker } from './app-broker-client.ts'
export type { ChildLaunchReceipt } from './native-contract.ts'

// No command line, shell, URI, shortcut, elevation, or parent-session fallback.
export const childExecutableSchema = z.string().min(4).max(1024).refine(
  path => /^[a-z]:[\\/]/i.test(path) && !/[\x00-\x1f"<>|?*]/.test(path) &&
    !path.slice(2).includes(':') && win32.extname(path).toLowerCase() === '.exe',
  '请提供本地应用的绝对 .exe 路径，不支持命令、参数或快捷方式',
)
export const childLaunchSchema = z.strictObject({
  path: childExecutableSchema, operationId: z.uuid(), expectedEpoch: z.int().nonnegative(),
})
export const childLaunchReceiptSchema: z.ZodType<ChildLaunchReceipt> = z.strictObject({
  operationId: z.uuid(), path: z.string(), pid: z.int().positive(), outcome: z.literal('started'),
  message: z.string(),
})
export type ChildLauncher = (path: string, beforeSpawn: () => void, verifyPid: (pid: number) => void) => Promise<{ path: string; pid: number }>

export const launchChildExecutable: ChildLauncher = async (input, beforeSpawn, verifyPid) => {
  const path = childExecutableSchema.parse(await realpath(childExecutableSchema.parse(input)))
  if (!(await stat(path)).isFile()) throw new Error('启动目标不是应用文件')
  const value = await callAppBroker({ path }, {
    timeoutMs: 14000, maxReplyBytes: 8192, beforeSend: beforeSpawn, verifyPid,
  })
  const reply = z.strictObject({
    path: z.literal(path), pid: z.int().positive(), sessionId: z.int().positive(), backend: z.literal('native-shell'),
  }).parse(value)
  verifyPid(reply.pid)
  return { path, pid: reply.pid }
}
