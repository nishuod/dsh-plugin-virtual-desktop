// Replay the retained privacy-cleared VMware Home screenshot.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extractVisualTargets, screenshotSha256 } from '../src/visual-targets.ts'

const source = new URL('../evidence/b4/', import.meta.url)
const image = await readFile(new URL('vmware-before-click.jpg', source))
const recorded = JSON.parse(await readFile(new URL('click.json', source), 'utf8'))
const sha256 = screenshotSha256(image.toString('base64'))
assert.equal(sha256, recorded.tool.visualVerification.beforeScreenshotSha256)
const { clientArea } = recorded.frame.accessibility.visualCandidates
const uia = recorded.frame.accessibility.suggestedTargets.filter(target => target.basis === 'uia-bounds')
const detected = await extractVisualTargets(image, clientArea, uia)
const parents = detected.targets.filter(target => !target.parent)
const icons = detected.targets.filter(target => target.parent)
const plus = { x:507, y:245, width:50, height:51 }
const edgeError = (a, b) => Math.max(
  Math.abs(a.x - b.x), Math.abs(a.y - b.y),
  Math.abs(a.x + a.width - b.x - b.width), Math.abs(a.y + a.height - b.y - b.height),
)
console.log(JSON.stringify({ sha256, elapsedMs:detected.elapsedMs, truncated:detected.truncated, parents, icons },null,2))
assert.equal(detected.truncated, false, detected.reason)
assert.ok(detected.elapsedMs < 120)
for (const card of recorded.cards) {
  assert.equal(parents.filter(target => target.confidence > 0.9 && edgeError(target.bbox, card.target.bbox) < 3).length, 1)
}
const matched = icons.filter(item => edgeError(item.bbox, plus) <= 4)
assert.equal(matched.length, 1, 'The circled plus should be one distinct icon within the Create card')
const parent = parents.find(item => item.id === matched[0].parent)
assert.ok(parent)
assert.ok(edgeError(parent.bbox, recorded.cards[0].target.bbox) < 3)
assert.ok(matched[0].id.startsWith(`${parent.id}.icon-`))
assert.ok(detected.targets.length <= 8)
