import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['show']);
const { houseBrief, airedSeconds, pictureTailSeconds } = await import('../work/tests/show.js');

// What the hosts talk about when the wire is dry, and how long a cut take airs.
void test('the house brief rotates concrete current subjects, forbids old years, and plugs the coin', () => {
  const briefs = Array.from({ length: 6 }, (_, i) => houseBrief(i * 4, 'frog clench', '2026-09-14'));
  assert.equal(new Set(briefs).size, 6, 'six consecutive brief-less exchanges get six subjects');
  assert.equal(houseBrief(24, 'frog clench', '2026-09-14'), briefs[0], 'then the rotation repeats');
  assert.equal(houseBrief(1, 'frog clench', '2026-09-14'), briefs[0], 'the four lines of one exchange share a subject');
  for (const brief of briefs) {
    assert.match(brief, /HOUSE SEGMENT/);
    assert.match(brief, /2026-09-14/);
    assert.match(brief, /do not narrate past events, old hacks/);
  }
  assert.equal(briefs.filter((b) => /pump dot fun/.test(b)).length, 2, 'the coin is plugged twice a round');
});
void test('a cut take airs its spoken length plus the picture tail, well under its render', () => {
  assert.equal(airedSeconds('Of course.'), 2 + pictureTailSeconds);
  assert.ok(airedSeconds('A perfectly ordinary spoken line for this shot, said briskly.') < 5);
});
