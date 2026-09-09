import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build([
  'topics',
  'gestures',
  'video-frames',
  'show',
  'stories',
  'director-program',
]);
const { DirectorProgram, directorPrompt } =
  await import('../work/tests/director-program.js');
const { storyTopics } = await import('../work/tests/stories.js');
test('real historical source dates survive the Director brief and continuation does not introduce a new show', () => {
  const text = directorPrompt(
    storyTopics[2],
    ['Prior conversation direction'],
    true,
  );
  assert.match(text, /March 13, 2024/);
  assert.match(text, /691,000/);
  assert.ok(text.includes(storyTopics[2].url));
  assert.match(text, /without a welcome/);
  assert.match(text, /not a transcript/);
  assert.match(text, /not breaking news/);
});
test('feed failure supplies reviewed history and stopped preparation cannot publish a brief', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('offline');
  });
  const program = new DirectorProgram();
  const signal = new AbortController();
  const first = await program.next(signal.signal);
  assert.ok(first.prompt.includes('HISTORICAL'));
  signal.abort();
  await assert.rejects(
    program.next(signal.signal),
    (e) => e.name === 'AbortError',
  );
});
