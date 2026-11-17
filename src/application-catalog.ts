import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { z } from 'zod'
import { childExecutableSchema } from './child-launch.ts'
import { applicationAdapters } from './application-adapters.ts'

export const applicationInput = z.strictObject({
  appId: z.enum(['vmware-workstation']).optional(),
  path: childExecutableSchema.optional(),
  operationId: z.uuid(),
}).refine(value => Boolean(value.appId) !== Boolean(value.path), 'appId 与 path 必须且只能填写一个')
export type ApplicationInput = z.infer<typeof applicationInput>
export interface ResolvedApplication { path: string; adapter: string }
export async function resolveApplication(input: ApplicationInput): Promise<ResolvedApplication> {
  let target = input.path
  if (input.appId === 'vmware-workstation') {
    for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation','HKLM\\SOFTWARE\\VMware, Inc.\\VMware Workstation']) {
      try {
        const {stdout} = await promisify(execFile)('reg.exe',['query',key,'/v','InstallPath'],{windowsHide:true,timeout:4000})
        const location = stdout.match(/InstallPath\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim()
        if (location) { target = win32.join(location,'vmware.exe'); break }
      } catch { /* Try the other registry view; no guessed executable or PATH lookup. */ }
    }
  }
  if (!target) throw new Error('未找到 VMware 安装位置，请提供应用的本地绝对 .exe 路径')
  const path = childExecutableSchema.parse(await realpath(childExecutableSchema.parse(target)))
  if (!(await stat(path)).isFile()) throw new Error('启动目标不是应用文件')
  return {path,adapter:applicationAdapters.resolve(path).id}
}
