import { writeFile } from 'node:fs/promises'
import { CuaDriver } from '@trycua/cua-driver'
const driver = CuaDriver.create(undefined)
try {
  const catalog = JSON.parse(await driver.listToolsJson({ signal: AbortSignal.timeout(15000) }))
  await writeFile('evidence/cua-driver-catalog-0.28.0.json', JSON.stringify(catalog, null, 2))
  console.log(JSON.stringify({ version: '0.28.0', tools: catalog.tools.map(tool => tool.name) }))
} finally {
  await driver.shutdown()
  if (typeof driver.uniffiDestroy === 'function') driver.uniffiDestroy()
}
