import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['topics', 'stories']);
const { storyTopics, withHistory } = await import('../work/tests/stories.js');
const { sanitizeDraft, briefOf } = await import('../work/tests/topics.js');

test('historical stories retain their source and historical date through the queue', () => {
  assert.ok(storyTopics.length >= 4);
  for (const story of storyTopics) {
    const brief = briefOf(sanitizeDraft(story));
    assert.equal(brief.brief, story.brief);
    assert.match(brief.brief, /^HISTORICAL/);
    assert.match(brief.brief, /202[234]/);
    assert.ok(new URL(brief.url).protocol === 'https:');
  }
});

test('a quiet wire gets one memory, and covered stories are never recycled to fill space', () => {
  const result = withHistory([], [], 0);
  assert.equal(result.length, 1);
  assert.deepEqual(withHistory([], storyTopics.map(t => t.title), 0), []);
  assert.ok(!withHistory([], [result[0].title.toLowerCase()], 0).some(t => t.title === result[0].title));
});

test('fresh reporting leads alone, and the memory rotates between quiet polls', () => {
  const live = Array.from({ length: 4 }, (_, i) => ({ ...storyTopics[0], title: `Fresh report ${i}` }));
  const result = withHistory(live, [], 0);
  assert.deepEqual(result, live, 'a wire with fresh reporting carries no history at all');
  assert.notEqual(withHistory([], [], 1)[0].title, withHistory([], [], 0)[0].title);
});

void test('history is a fallback only: a fresh wire gets no memories, an empty one gets a single memory', () => {
  const live = [{ title: 'Fresh: something happening today', brief: 'b', angle: 'a', url: 'https://x', handle: 'h', source: 'web', category: 'crypto', score: 30 }];
  assert.deepEqual(withHistory(live, [], 0).map((t) => t.title), [live[0].title]);
  const alone = withHistory([], [], 0);
  assert.equal(alone.length, 1);
  assert.match(alone[0].angle, /Keep it to this one memory/);
});
