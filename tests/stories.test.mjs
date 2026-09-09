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

test('quiet feeds get history but covered stories are never recycled to fill space', () => {
  const result = withHistory([], [], 0);
  assert.ok(result.length >= 3);
  assert.deepEqual(withHistory([], storyTopics.map(t => t.title), 0), []);
  assert.ok(!withHistory([], [result[0].title.toLowerCase()], 0).some(t => t.title === result[0].title));
});

test('fresh reporting leads and gets only one historical callback when plentiful', () => {
  const live = Array.from({ length: 4 }, (_, i) => ({ ...storyTopics[0], title: `Fresh report ${i}` }));
  const result = withHistory(live, [], 0);
  assert.deepEqual(result.slice(0, 4), live);
  assert.equal(result.length, 5);
  assert.notEqual(withHistory([], [], 1)[0].title, withHistory([], [], 0)[0].title);
});
