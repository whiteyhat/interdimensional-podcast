import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['speech']);
const { speechEndFor } = await import('../work/tests/speech.js');
const chunk = (text, start, end, speaker = 'SPEAKER_00') => ({ text, timestamp: [start, end], speaker });
const result = chunks => ({ chunks, diarization_segments: [{ timestamp: [0, 10], speaker: 'SPEAKER_00' }] });
void test('keeps only the scripted prefix of a real contaminated continuity take', () => {
  assert.equal(speechEndFor('Of course.', result([
    chunk(' Of', .03, .35), chunk(' course.', .35, 1.15), chunk(' I', 1.15, 1.49), chunk(' tear', 1.49, 1.73),
  ])), 1.15);
});
void test('refuses missing words, extra opening speech and missing alignment', () => {
  for (const raw of [result([]), {}, result([chunk('Of', 0, .3)]), result([chunk('Hello', 0, .3), chunk('Of course', .3, 1.2)])])
    assert.throws(() => speechEndFor('Of course.', raw), /speech/i);
});
void test('refuses invalid timing and a second detected speaker during the scripted line', () => {
  for (const end of [null, NaN, -1, 30]) assert.throws(() => speechEndFor('Neither.', result([chunk('Neither', 0, end)])), /speech/i);
  const raw = result([chunk('Of', 0, .3), chunk('course', .3, .8)]);
  raw.diarization_segments.push({timestamp:[.2,.7], speaker:'SPEAKER_01'});
  assert.throws(() => speechEndFor('Of course.', raw), /speaker/i);
});
void test('accepts punctuation, acronyms and numeric transcription of spoken numbers', () => {
  assert.equal(speechEndFor('N G M I.', result([chunk('NGMI.', 0, 1)])), 1);
  assert.equal(speechEndFor('Down ninety percent.', result([chunk('Down', 0, .3), chunk('90%', .3, 1)])), 1);
  assert.equal(speechEndFor("I'm down bad.", result([chunk('I’m', 0, .3),chunk('down', .3, .5),chunk('bad.', .5, .8)])), .8);
});
void test('incomplete speaker coverage cannot certify the utterance', () => {
  for (const diarization_segments of [
    [{timestamp:[0,.3],speaker:'SPEAKER_00'},{timestamp:[.3,.8],speaker:null}],
    [{timestamp:[0,.8],speaker:''}],
    [{timestamp:[2,3],speaker:'SPEAKER_00'}],
  ]) assert.throws(() => speechEndFor('Of course.', {
    chunks:[chunk('Of',0,.3),{text:'course.',timestamp:[.3,.8]}],diarization_segments,
  }), /speaker/i);
});
void test('excluded speech cannot overlap the verified final word', () => {
  assert.throws(() => speechEndFor('Neither.', result([chunk('Neither',0,1),chunk('hello',.8,1.5)])), /overlap/i);
});
