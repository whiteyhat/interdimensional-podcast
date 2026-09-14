import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['speech']);
const { speechEndFor, transcriptTolerance } = await import('../work/tests/speech.js');
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
// The diarizer's own grid: it leaves same-speaker holes inside a line and starts late on the
// first word (measured on real takes: holes of 84-236 ms, onsets of 100-190 ms). The audit
// bridges those and still refuses a hole a listener would notice or an unlabelled word.
void test('bridges the diarizer\'s same-speaker holes and its late start on the first word', () => {
  const chunks = [chunk('Of', .03, .35), chunk('course', .35, .8), chunk('not.', .8, 1.15)];
  assert.equal(speechEndFor('Of course not.', { chunks, diarization_segments: [
    { timestamp: [.22, .5], speaker: 'SPEAKER_00' },
    { timestamp: [.736, 1.4], speaker: 'SPEAKER_00' }, // a 236 ms hole under "course"
  ] }), 1.15);
  assert.equal(speechEndFor('Of course not.', { chunks, diarization_segments: [
    { timestamp: [.4, 1.1], speaker: 'SPEAKER_00' }, // 370 ms after "Of" begins; 50 ms before "not." ends
  ] }), 1.15);
});
void test('a larger hole, a late start on a later word, or a hole a different speaker fills still refuses', () => {
  const chunks = [chunk('Of', .03, .35), chunk('course', .35, .8), chunk('not.', .8, 1.15)];
  for (const diarization_segments of [
    [{ timestamp: [0, .4], speaker: 'SPEAKER_00' }, { timestamp: [1.0, 1.4], speaker: 'SPEAKER_00' }], // 600 ms hole
    [{ timestamp: [.7, 1.4], speaker: 'SPEAKER_00' }], // 670 ms after the first word begins
    [{ timestamp: [0, .4], speaker: 'SPEAKER_00' }, { timestamp: [.6, 1.4], speaker: 'SPEAKER_01' }],
  ]) assert.throws(() => speechEndFor('Of course not.', { chunks, diarization_segments }), /speaker/i);
});

// Whisper mishears a name or a contraction on real takes. A near miss within tolerance is the
// same line; a take that dropped its last word, or said a different line, is not.
void test('tolerates a small transcription difference and keeps the aligned end of the last word', () => {
  const script = 'I told you, anon, the chart never lies.';
  assert.equal(transcriptTolerance('itoldyouanonthechartneverlies'), 3);
  assert.equal(transcriptTolerance('a'.repeat(105)), 13, 'one misheard name on a long line passes');
  assert.equal(speechEndFor(script, result([
    chunk('I', 0, .2), chunk('told', .2, .4), chunk('you,', .4, .6), chunk('and on,', .6, 1.0),
    chunk('the', 1.0, 1.1), chunk('chart', 1.1, 1.4), chunk('never', 1.4, 1.7), chunk('lies.', 1.7, 2.1), chunk('Right?', 2.3, 2.6),
  ])), 2.1);
});
void test('refuses a near miss that dropped the scripted last word, and a different line', () => {
  const script = 'The chart is bleeding and nobody is buying it.';
  assert.throws(() => speechEndFor(script, result([
    chunk('The chart is bleeding', 0, 1.2), chunk('and nobody is buying.', 1.2, 2.4),
  ])), /last word/i);
  assert.throws(() => speechEndFor(script, result([
    chunk('The chart is pumping', 0, 1.2), chunk('and everybody is buying it.', 1.2, 2.4),
  ])), /does not match/i);
});
void test('an excluded trailing chunk with no end time does not refuse a verified take', () => {
  assert.equal(speechEndFor('Of course.', result([
    chunk('Of', .03, .35), chunk('course.', .35, 1.15), { text: 'and', timestamp: [1.4, null], speaker: 'SPEAKER_00' },
  ])), 1.15);
  assert.throws(() => speechEndFor('Of course.', result([
    chunk('Of', .03, .35), chunk('course.', .35, 1.15), { text: 'and', timestamp: [null, null], speaker: 'SPEAKER_00' },
  ])), /timestamps/i);
});
