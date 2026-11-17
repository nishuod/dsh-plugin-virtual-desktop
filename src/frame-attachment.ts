import type { Context } from '@deepseek-ai/cordis'
import { redactDiagnostics, projectToolReceipt } from './redaction.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

type TextBlock = { type: 'text'; text: string }
type JpegBlock = { type: 'image'; mimeType: 'image/jpeg'; data: string }
export type FrameToolResult = {
  content: (TextBlock | JpegBlock)[]
  structuredContent?: Record<string, unknown>
}

/** Preserve the provider's actual error, including nested storage codes. */
export function attachmentFailure(error: unknown): Record<string, unknown> {
  const value = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
  return redactDiagnostics({ name: String(value?.name ?? 'Error'), message: String(value?.message ?? error),
    ...(value?.code !== undefined ? { code: value.code } : {}),
    ...(value?.cause ? { cause: attachmentFailure(value.cause) } : {}) })
}

/** Native tool projection uses the host's durable image service exactly once. */
export async function admitFrameResult(ctx: Pick<Context, 'get'>, raw: FrameToolResult): Promise<{
  content: (TextBlock | { type: 'image'; attachment: ImageAttachmentRef })[]
  structuredContent?: Record<string, unknown>
}> {
  const image = raw.content.find(block => block.type === 'image')
  const text = raw.content.filter(block => block.type === 'text')
  if (!image) return { ...raw, content: text }

  // The host supplies attachments from a sibling fiber. Cordis requires a
  // scoped lookup for this optional service when the tool fiber is mounted.
  const metadata = projectToolReceipt(raw.structuredContent ?? {})
  try {
    const attachments = ctx.get('attachments')
    if (!attachments) throw Object.assign(new Error('DSH 图像附件服务未挂载'), { code: 'ATTACHMENT_SERVICE_UNAVAILABLE' })
    const attachment = await attachments.saveImage({ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType })
    const structuredContent = { ...metadata, imageMode: 'attachment' }
    return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }, { type: 'image', attachment }] }
  } catch (error) {
    const filePath = typeof metadata.filePath === 'string' ? metadata.filePath : undefined
    const structuredContent = {
      ...metadata,
      imageMode: 'unavailable',
      attachmentError: attachmentFailure(error),
      ...(filePath ? { nextTool: 'read_image', nextToolArgs: { file_path: filePath } } : { nextTool: 'desktop_get_task_status' }),
    }
    return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] }
  }
}
