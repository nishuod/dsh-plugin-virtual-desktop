import { createHash, randomBytes } from 'node:crypto'

/** Identify a build invocation independently of the final archive checksum. */
export function createBuildIdentity(version) {
  const builtAt = new Date().toISOString()
  const buildHash = createHash('sha256')
    .update(version)
    .update(builtAt)
    .update(randomBytes(16))
    .digest('hex')
    .slice(0, 12)
  return { version, buildHash, builtAt }
}
