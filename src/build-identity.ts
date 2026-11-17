import { z } from 'zod'

export const pluginBuildSchema = z.strictObject({
  version: z.string().min(1),
  buildHash: z.string().regex(/^[0-9a-f]{12}$/),
  builtAt: z.iso.datetime({ offset: true }),
})

type PluginBuild = z.infer<typeof pluginBuildSchema>
declare const __DSH_PLUGIN_BUILD__: PluginBuild | undefined

// Source runs have no injected value. No runtime file lookup or ID generation.
export const pluginBuild = typeof __DSH_PLUGIN_BUILD__ === 'undefined'
  ? undefined
  : Object.freeze(__DSH_PLUGIN_BUILD__)
