import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['sponsor-program']);
const { SponsorProgram, WARDROBE_STRIKES } =
  await import('../work/tests/sponsor-program.js');

const cap = () => ({
  id: 'cap1',
  leaseToken: 'lease1',
  leaseUntil: Date.now() + 45000,
  draft: {
    product: 'cap',
    name: 'alice',
    message: 'We make tools for artists.',
    projectName: 'Canvas',
    target: 'host',
    assetId: 'design1',
  },
  assetUrl: 'https://site.test/preview.png',
  assetMetadata: {
    sourceUrl: 'https://site.test/cap.png',
    sha256: 'design1',
    templateVersion: 'caps-v1',
  },
  fulfillment: {
    visibleMs: 0,
    appearances: 0,
    intro: false,
    callback: false,
    startedAt: null,
    completedAt: null,
  },
});
const lines = (start = 0) =>
  ['host', 'guest', 'host', 'guest'].map((speaker, i) => ({
    id: start + i,
    speaker,
    text: `line ${start + i}`,
  }));
function program() {
  const events = [];
  const p = new SponsorProgram({
    sync: async () => [cap()],
    event: async (e) => {
      events.push(e);
      return { status: e.type === 'paused' ? 'paused' : 'playing' };
    },
  });
  const paused = () => events.some((e) => e.type === 'paused');
  return { p, events, paused };
}
async function onAir(p) {
  await p.sync();
  const intro = p.written(p.nextCue(0), lines());
  const first = p.decorate(intro[0]);
  await p.before(first);
  return first;
}

// On devnet a free line with a figure in it failed its speech check four times, and because
// the cap happened to be on it, the paying cap's whole delivery was paused for a cooldown.
void test('a dressed free line that fails costs the cap one appearance, not its delivery', async () => {
  const { p, paused } = program();
  await onAir(p);
  const free = p.decorate({ id: 10, speaker: 'host', text: 'free' }, 'guest');
  assert.ok(free.wardrobe, 'the cap is on the free line');
  for (let i = 1; i < WARDROBE_STRIKES; i++)
    await p.failedRender(free, Error('bad take'));
  assert.equal(paused(), false, 'lost appearances do not pause the order');
  // A played appearance clears the run.
  await p.ended({ ...free, duration: 5 });
  for (let i = 1; i < WARDROBE_STRIKES; i++)
    await p.failedRender(free, Error('bad take'));
  assert.equal(paused(), false, 'the run starts over after an appearance');
  await p.failedRender(free, Error('bad take'));
  assert.equal(
    paused(),
    true,
    'a run of failures pauses the order for a new lease',
  );
});

void test('the cap’s own exchange failing still pauses the order at once', async () => {
  const { p, paused } = program();
  const first = await onAir(p);
  assert.ok(first.sponsorship && first.wardrobe);
  await p.failedRender(first, Error('bad take'));
  assert.equal(paused(), true);
});
