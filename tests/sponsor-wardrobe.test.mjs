import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
import { lease, lines } from './fixtures/sponsor-lease.mjs';
await build(['sponsor-program']);
const { SponsorProgram, WARDROBE_STRIKES } =
  await import('../work/tests/sponsor-program.js');

function program() {
  const events = [];
  const p = new SponsorProgram({
    sync: async () => [lease('cap')],
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

// One wardrobe per run. A dressed take that fails for good used to be made again undressed
// while the same host's next line aired dressed: the tee and cap flipped off and back on
// between two adjacent lines of his. The engine tells the program which shot failed; every
// later line of that host, until the next cut to him, is left undressed, and the look
// returns at that cut.
void test('after a dressed take fails, the rest of that host’s run airs undressed and the look returns at the next cut', async () => {
  const { p, paused } = program();
  await onAir(p);
  const free = p.decorate({ id: 10, speaker: 'host', text: 'free' }, 'guest');
  assert.ok(free.wardrobe, 'the cap is on the free line');
  await p.failedRender(free, Error('bad take'));
  p.undressed('order1', 10);
  assert.equal(
    p.decorate({ id: 11, speaker: 'host', text: 'still his turn' }, 'host')
      .wardrobe,
    undefined,
    'the same host’s next line airs undressed',
  );
  assert.equal(
    p.decorate({ id: 12, speaker: 'guest', text: 'the other host' }, 'host')
      .wardrobe,
    undefined,
    'the other host was never dressed',
  );
  assert.ok(
    p.decorate({ id: 13, speaker: 'host', text: 'back to him' }, 'guest')
      .wardrobe,
    'the look returns at the cut back to him',
  );
  assert.ok(
    p.decorate({ id: 14, speaker: 'host', text: 'and stays on' }, 'host')
      .wardrobe,
    'the note is gone, not merely skipped: his second line in the new run is dressed',
  );
  p.undressed('no-such-order', 14);
  assert.ok(
    p.decorate({ id: 15, speaker: 'host', text: 'unknown orders' }, 'host')
      .wardrobe,
    'a note for an unknown order changes nothing',
  );
  assert.equal(paused(), false, 'none of this pauses the order');
});

void test('a played dressed appearance clears the undressed note, like the strikes', async () => {
  const { p } = program();
  await onAir(p);
  const free = p.decorate({ id: 10, speaker: 'host', text: 'free' }, 'guest');
  p.undressed('order1', 10);
  assert.equal(
    p.decorate({ id: 11, speaker: 'host', text: 'undressed' }, 'host').wardrobe,
    undefined,
  );
  await p.ended({ ...free, duration: 5 });
  assert.ok(
    p.decorate({ id: 12, speaker: 'host', text: 'dressed again' }, 'host')
      .wardrobe,
    'an appearance that played clears the note',
  );
});
