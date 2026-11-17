export interface PlatformSupport {
  supported: boolean
  platform: string
  arch: string
  reason?: 'unsupported-platform'
  message: string
}

export function platformSupport(platform: string = process.platform, arch: string = process.arch): PlatformSupport {
  const supported = platform === 'win32' && arch === 'x64'
  return { supported, platform, arch, ...(supported ? {} : { reason: 'unsupported-platform' as const }), message: supported ? 'Windows x64 desktop executor available; connection and authorization are checked separately.' : 'Desktop execution requires Windows 10/11 x64. No executor is available for this platform.' }
}

export function assertSupportedPlatform(platform: string = process.platform, arch: string = process.arch): void {
  const result = platformSupport(platform, arch)
  if (!result.supported) throw Object.assign(new Error(result.message), {name: 'UnsupportedPlatformError', reason: result.reason, platform, arch})
}
