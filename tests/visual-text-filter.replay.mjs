// Offline detector replay against the retained, privacy-cleared B4 frame.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extractVisualTargets, screenshotSha256 } from '../src/visual-targets.ts'

const evidence = new URL('../evidence/b4/', import.meta.url)
const frame = await readFile(new URL('vmware-before-click.jpg', evidence))
const original = JSON.parse(await readFile(new URL('click.json', evidence), 'utf8'))
const sha256 = screenshotSha256(frame.toString('base64'))
assert.equal(sha256, original.tool.visualVerification.beforeScreenshotSha256)
const { clientArea } = original.frame.accessibility.visualCandidates
const uia = original.frame.accessibility.suggestedTargets.filter(target => target.basis === 'uia-bounds')
const result = await extractVisualTargets(frame, clientArea, uia)

const expected = original.cards.map(card => card.expected)
const cards = expected.map(edges => {
  const matches = result.targets.map(target => {
    const { x, y, width, height } = target.bbox
    const edgeErrorPx = Math.max(Math.abs(x - edges.left), Math.abs(y - edges.top),
      Math.abs(x + width - edges.right), Math.abs(y + height - edges.bottom))
    return { bbox: target.bbox, confidence: target.confidence, edgeErrorPx }
  }).filter(target => target.edgeErrorPx < 8 && target.confidence > 0.9)
  return { expected: edges, matches }
})
const textLike = result.targets.filter(({ bbox, parent }) => !parent && (bbox.height < 32 || bbox.width / bbox.height > 8))
console.log(JSON.stringify({
  sha256, clientArea, elapsedMs: result.elapsedMs, truncated: result.truncated,
  targets: result.targets, textLike, cards,
}, null, 2))

assert.equal(result.truncated, false, result.reason)
assert.ok(result.elapsedMs < 120)
for (const card of cards) assert.equal(card.matches.length, 1, 'Each audited card must have one proposal within 8px and above 0.9 confidence')
assert.deepEqual(textLike.map(target => target.bbox), [], 'Text-like regions must not be visual candidates')
