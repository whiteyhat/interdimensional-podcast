import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';

await build(['video-layers']);
const { assignLayers } = await import('../work/tests/video-layers.js');

// The pool must be bounded by the clips held at once, never by the clips aired (why: the
// comment on assignLayers). These pin that contract.

void test('each new clip takes a layer, and a clip keeps its layer while the others move', () => {
  let layers = assignLayers([], ['a']);
  assert.deepEqual(layers, ['a']);
  layers = assignLayers(layers, ['a', 'b']);
  assert.deepEqual(layers, ['a', 'b']);
  layers = assignLayers(layers, ['b', 'c']);
  assert.deepEqual(layers, ['c', 'b'], 'b stays on layer 1, c reuses the layer a left');
});

void test('a layout that did not change keeps its identity, so the player renders nothing new', () => {
  const layers = assignLayers([], ['a', 'b', 'c']);
  assert.equal(assignLayers(layers, ['a', 'b', 'c']), layers);
  assert.equal(assignLayers(layers, ['c', 'a', 'b']), layers, 'order in the queue is not a move');
});

void test('a freed layer rests empty until the next clip needs it', () => {
  let layers = assignLayers([], ['a', 'b', 'c']);
  layers = assignLayers(layers, ['a', 'c']);
  assert.deepEqual(layers, ['a', null, 'c']);
  layers = assignLayers(layers, ['a', 'c', 'd']);
  assert.deepEqual(layers, ['a', 'd', 'c']);
});

void test('the pool grows only when every layer is taken', () => {
  let layers = assignLayers([], ['a', 'b']);
  layers = assignLayers(layers, ['b']);
  layers = assignLayers(layers, ['b', 'c']);
  assert.equal(layers.length, 2, 'c took the free layer instead of a new one');
  layers = assignLayers(layers, ['b', 'c', 'd']);
  assert.equal(layers.length, 3, 'every layer was taken, so the pool grew by one');
});

void test('hours of show never grow the pool past the most clips held at once', () => {
  // A long broadcast: a window of up to eight clips (the previous shot, the current one and the
  // ready slots) slides forward one clip at a time, sometimes shrinking and refilling the way
  // the buffer does, for two thousand takes.
  let layers = [];
  let next = 0;
  let window = [];
  let held = 0;
  for (let aired = 0; aired < 2000; aired++) {
    const size = 2 + ((aired * 5) % 7); // between two and eight clips held, in a shuffled rhythm
    while (window.length < size) window.push(`clip-${next++}`);
    while (window.length > size) window.shift();
    held = Math.max(held, window.length);
    layers = assignLayers(layers, window);
    const shown = layers.filter(Boolean);
    assert.equal(shown.length, window.length, 'every held clip has exactly one layer');
    assert.deepEqual(new Set(shown), new Set(window));
    window = window.slice(1); // the oldest clip leaves the stage
  }
  assert.equal(held, 8);
  assert.ok(layers.length <= held, `the pool has ${layers.length} layers for at most ${held} clips held at once`);
});

void test('a clip never occupies two layers', () => {
  const layers = assignLayers(['a', null, 'b'], ['a', 'b', 'a', 'c', 'c']);
  assert.deepEqual(layers, ['a', 'c', 'b']);
});
