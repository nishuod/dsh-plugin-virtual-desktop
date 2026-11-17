import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import type { DesktopFrame } from './native-contract.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Host-owned per-connection evidence. Worker paths are never trusted. */
export class FrameStore {
  private directory?: string
  private closing = false
  private writes = new Set<Promise<unknown>>()
  constructor(private readonly root = join(tmpdir(), 'dsh-virtual-desktop')) {}
  async begin(connectionId: string): Promise<void> {
    if (!uuid.test(connectionId)) throw new Error('截图连接 ID 无效')
    if (this.directory) throw new Error('旧截图目录尚未关闭')
    const directory = resolve(this.root, connectionId)
    if (dirname(directory) !== resolve(this.root)) throw new Error('截图目录越界')
    await mkdir(directory, { recursive: true })
    this.directory = directory
    this.closing = false
  }
  async save(frame: DesktopFrame): Promise<DesktopFrame> {
    if (!this.directory || this.closing || !uuid.test(frame.id)) throw new Error('截图连接已关闭或帧 ID 无效')
    const filePath = join(this.directory, `${frame.id}.jpg`)
    const write = writeFile(filePath, Buffer.from(frame.data, 'base64'), { flag: 'wx' })
    this.writes.add(write)
    try { await write } finally { this.writes.delete(write) }
    return { ...frame, filePath }
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.writes])
    const directory = this.directory
    if (directory) {
      if (dirname(resolve(directory)) !== resolve(this.root)) throw new Error('截图清理目录越界')
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
      this.directory = undefined
    }
  }
}
