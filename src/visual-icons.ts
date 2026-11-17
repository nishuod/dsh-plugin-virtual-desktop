import type { Rect } from './visual-targets.ts'

interface Icon {
  bbox: Rect
  confidence: number
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height
}

function findTextRuns(glyphs: Rect[], expired: () => boolean): Set<Rect> | undefined {
  glyphs.sort((a, b) => a.x - b.x)
  const neighbours = glyphs.map(() => [] as number[])
  for (const [i, left] of glyphs.entries()) {
    if (expired()) return undefined
    for (let j = i + 1; j < glyphs.length; j++) {
      const right = glyphs[j]
      const gap = right.x - (left.x + left.width)
      if (gap > left.height * .8) break
      const height = Math.min(left.height, right.height)
      const baselineGap = Math.abs(left.y + left.height - right.y - right.height)
      if (gap < -2 || Math.max(left.height, right.height) > height * 1.5 ||
          baselineGap > Math.max(2, height * .18)) continue
      neighbours[i].push(j)
      neighbours[j].push(i)
    }
  }
  // A line of at least three neighbouring glyphs is stronger evidence than one
  // outline whose pixels could equally describe a letter or a standalone icon.
  const text = new Set<Rect>()
  for (const [i, adjacent] of neighbours.entries()) {
    if (adjacent.length < 2) continue
    text.add(glyphs[i])
    for (const j of adjacent) text.add(glyphs[j])
  }
  return text
}

/** Search inside a retained parent only. Undefined means the shared deadline elapsed. */
export function findVisualIcons(
  rgb: Buffer, stride: number, parent: Rect, expired: () => boolean,
): Icon[] | undefined {
  const inset = 6
  const x0 = parent.x + inset, y0 = parent.y + inset
  const width = parent.width - 2 * inset, height = parent.height - 2 * inset
  if (width < 16 || height < 16) return []
  if (expired()) return undefined

  // The inner corners sample the surface and skip the parent's focus outline.
  const corners = [
    (y0 * stride + x0) * 3, (y0 * stride + x0 + width - 1) * 3,
    ((y0 + height - 1) * stride + x0) * 3, ((y0 + height - 1) * stride + x0 + width - 1) * 3,
  ]
  const background = [0, 1, 2].map(channel => {
    const values = corners.map(index => rgb[index + channel]).sort((a, b) => a - b)
    return (values[1] + values[2]) / 2
  })
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    if ((y & 7) === 0 && expired()) return undefined
    const offset = ((y0 + y) * stride + x0) * 3
    for (let x = 0; x < width; x++) {
      const i = offset + x * 3
      const contrast = Math.max(
        Math.abs(rgb[i] - background[0]),
        Math.abs(rgb[i + 1] - background[1]),
        Math.abs(rgb[i + 2] - background[2]),
      )
      if (contrast >= 48) mask[y * width + x] = 1
    }
  }

  // Distinct components keep neighbouring letters from turning into word-sized proposals.
  const queue = new Int32Array(mask.length)
  const candidates: Icon[] = []
  const glyphs: Rect[] = []
  for (let start = 0; start < mask.length; start++) {
    if ((start & 1023) === 0 && expired()) return undefined
    if (mask[start] !== 1) continue
    let count = 1, edgePixels = 0
    let minX = width, minY = height, maxX = 0, maxY = 0
    queue[0] = start
    mask[start] = 2
    for (let cursor = 0; cursor < count; cursor++) {
      if ((cursor & 1023) === 0 && expired()) return undefined
      const at = queue[cursor], x = at % width, y = Math.floor(at / width)
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
          !mask[at - 1] || !mask[at + 1] || !mask[at - width] || !mask[at + width]) edgePixels++
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || mask[next] !== 1) continue
        mask[next] = 2
        queue[count++] = next
      }
    }

    const w = maxX - minX + 1, h = maxY - minY + 1
    const bbox = { x:x0+minX, y:y0+minY, width:w, height:h }
    if (w >= 3 && h >= 8 && h <= 64 && w <= h * 1.85) glyphs.push(bbox)
    if (Math.min(w, h) < 16 || Math.max(w, h) > 64 || Math.max(w, h) / Math.min(w, h) > 2.5) continue
    const fill = count / (w * h), edge = edgePixels / (2 * (w + h))
    if (fill < .1 || fill > .8 || edge < .5) continue
    const compactness = Math.min(w,h) / Math.max(w,h)
    const confidence = Math.min(.95, .55 + .26 * Math.min(1, edge) + .12 * compactness)
    candidates.push({bbox, confidence:Math.round(confidence*1000)/1000})
  }

  // Keep the enclosing outline when a glyph has separate strokes inside it.
  candidates.sort((a,b) => b.bbox.width*b.bbox.height - a.bbox.width*a.bbox.height || b.confidence-a.confidence)
  const text = findTextRuns(glyphs, expired)
  if (!text) return undefined
  const distinct: Icon[] = []
  for (const icon of candidates) {
    if (expired()) return undefined
    if (!text.has(icon.bbox) && !distinct.some(item => contains(item.bbox, icon.bbox))) distinct.push(icon)
  }
  return distinct
}
