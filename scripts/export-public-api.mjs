import {writeFile,readFile} from 'node:fs/promises'
import {Context} from '@deepseek-ai/cordis'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import * as plugin from '../lib/index.js'
import { z } from 'zod'
import { tsImport } from 'tsx/esm/api'

const { frameSchema, pipDisplaySchema, receiptSchema, restoreWindowResultSchema, runtimeStateSchema, windowSchema } =
  await tsImport('../src/native-contract.ts', import.meta.url)
const { visualOptionsSchema } = await tsImport('../src/visual-targets.ts', import.meta.url)
const { pluginBuildSchema } = await tsImport('../src/build-identity.ts', import.meta.url)

const filePath = z.string().max(32768)
const paths = { filePath, filePathDisplay: filePath }
const frame = frameSchema.omit({data:true}).extend({
  filePathDisplay: filePath.optional(),
})
const imageHash = z.string().regex(/^[0-9a-f]{64}$/)
const imageDelivery = {
  imageMode: z.enum(['attachment','unavailable','uia-only','unchanged']),
  attachmentError: z.record(z.string(), z.unknown()).optional(),
  nextTool: z.string().optional(),
  nextToolArgs: z.strictObject({file_path:filePath}).optional(),
}
const action = receiptSchema.omit({ after:true })
const resetCommon = runtimeStateSchema.extend({
  backend: z.literal('windows-child-session'),
  operationId: z.uuid(),
  status: z.literal('stopped'),
})
const records = {
  Diagnostics: z.strictObject({
    plugin:pluginBuildSchema.optional(), diagnosticChannel:z.looseObject({}), platform:z.looseObject({}),
    desktop:z.looseObject({}), pipProfile:z.looseObject({}), childStartPermission:z.enum(['ask','session-grant','blocked']),
    nextTool:z.string().nullable(), guidance:z.string(), completionPolicy:z.string(),
  }),
  ChildSessionReset: z.discriminatedUnion('state', [
    resetCommon.extend({state:z.literal('idle'),releasedPids:z.tuple([])}),
    resetCommon.extend({state:z.literal('released'),releasedPids:z.array(z.int().positive()).min(1)}),
  ]),
  RestoreWindow: restoreWindowResultSchema,
  OpenApplication: z.strictObject({
    plugin:pluginBuildSchema.optional(),
    operationId:z.uuid(), status:z.enum(['ready','needs_review','app_error','instance_conflict','timed_out','unknown']),
    stage:z.string(), path:z.string(), message:z.string(), connectionId:z.uuid().optional(),
    childSessionId:z.int().nonnegative().optional(), epoch:z.int().optional(), pid:z.int().positive().optional(),
    window:windowSchema.optional(), reused:z.boolean().optional(), pipDisplay:pipDisplaySchema.optional(),
    filePath:filePath.optional(), filePathDisplay:filePath.optional(), scale:frameSchema.shape.scale, nextTool:z.string().optional(),
  }),
  Screenshot: z.union([
    frame.omit({filePath:true,filePathDisplay:true}).extend({imageMode:z.literal('uia-only'),screenshotSha256:imageHash,
      note:z.literal('省流模式不含自绘控件候选；点击卡片等区域请改用 mode=image')}),
    frame.extend({...imageDelivery,imageMode:z.enum(['attachment','unavailable','unchanged']),screenshotSha256:imageHash}),
  ]),
  Action: z.union([
    action.extend({ after:frame.omit({filePath:true,filePathDisplay:true}).nullable() }),
    frame.extend(action.shape).extend({...imageDelivery,frameId:z.uuid()}),
  ]),
  DiagnosticsExport: z.strictObject({
    ...paths, sha256:z.string().regex(/^[0-9a-f]{64}$/), frames:z.int().nonnegative(), logWriteFailures:z.int().nonnegative(),
  }),
}
const responseSchemas = {
  $schema:'http://json-schema.org/draft-07/schema#',
  title:'Desktop tool success payloads',
  description:'Definitions for decoded tool results. Text content and structuredContent carry these records.',
  definitions:Object.fromEntries(Object.entries(records).map(([name, schema])=>{
    const {$schema, ...definition}=z.toJSONSchema(schema,{target:'draft-7',io:'output'})
    return [name, definition]
  })),
}
const configSchema = z.toJSONSchema(z.looseObject({
  visualCandidates: visualOptionsSchema.optional(),
}).meta({title:'Desktop visual candidate configuration'}),{target:'draft-7',io:'input'})

async function writeOrCheck(filename, data) {
  const content=JSON.stringify(data,null,2)+'\n'
  const path=new URL(`../docs/${filename}`,import.meta.url)
  if(process.argv.includes('--check')){
    if(await readFile(path,'utf8')!==content)throw new Error(`Public schema changed; regenerate docs/${filename}`)
  }else await writeFile(path,content)
}
const ctx=new Context()
try{
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolRuntime,{})
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(plugin,{})
  const schemas=ctx.tools.schemas().filter(tool=>tool.name.startsWith('desktop_')).sort((a,b)=>a.name.localeCompare(b.name))
  await writeOrCheck('PUBLIC-API.schema.json',schemas)
  await writeOrCheck('PUBLIC-API.responses.schema.json',responseSchemas)
  await writeOrCheck('PUBLIC-API.config.schema.json',configSchema)
  console.log(`Verified ${schemas.length} desktop tool schemas, ${Object.keys(records).length} response records and visual configuration`)
}finally{await ctx.fiber.dispose()}
