// Word timestamps are evidence, not a guessed words-per-second cutoff.
export class SpeechError extends Error {}
const small = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function numberWords(n: number): string {
  if (n < 20) return small[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? numberWords(n % 10) : '');
  for (const [size, name] of [[1e12,'trillion'],[1e9,'billion'],[1e6,'million'],[1000,'thousand'],[100,'hundred']] as const)
    if (n >= size) return numberWords(Math.floor(n / size)) + name + (n % size ? numberWords(n % size) : '');
  return '';
}
const normalized = (text: string) => text.toLowerCase()
  .replace(/\$(\d[\d,.]*)/g, '$1 dollars')
  .replace(/%/g, ' percent')
  .replace(/(?<=\d),(?=\d)/g, '')
  .replace(/\b\d{1,15}(?:\.\d+)?\b/g, value => {
    const [whole, fraction] = value.split('.');
    return numberWords(Number(whole)) + (fraction ? 'point' + fraction.split('').map(n => small[Number(n)]).join('') : '');
  })
  .replace(/[^a-z0-9]/g, '');
function timing(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 ||
    !value.every(v => typeof v === 'number' && Number.isFinite(v)) ||
    value[0] < 0 || value[1] <= value[0] || value[1] > 16)
    throw new SpeechError('Invalid speech timestamps');
  return value as [number, number];
}
/** Edit distance between two short strings; the transcript and the script are under a few hundred characters. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}
/**
 * How far the transcript may stray from the script and still count as the same line: an eighth
 * of its characters, at least three and at most fourteen. Whisper mishears a name or a
 * contraction on real takes; refusing those cost a retake each and, on air, a frozen frame
 * while it rendered. On air a tenth refused takes eleven characters off on a 105-character
 * line, one misheard name, so the allowance is an eighth.
 */
export function transcriptTolerance(expected: string): number {
  return Math.min(14, Math.max(3, Math.floor(expected.length / 8)));
}
/** Refuse an uncertain take; never air the unverified full soundtrack as a fallback. */
export function speechEndFor(script: string, raw: unknown): number {
  const result = raw as { chunks?: { text?: unknown; timestamp?: unknown; speaker?: unknown }[]; diarization_segments?: { timestamp?: unknown; speaker?: unknown }[] } | null;
  if (!Array.isArray(result?.chunks) || !Array.isArray(result?.diarization_segments) || !result.diarization_segments.length)
    throw new SpeechError('Missing speech alignment or speaker analysis');
  const expected = normalized(script);
  if (!expected) throw new SpeechError('Missing scripted speech');
  const lastWord = normalized(script.trim().split(/\s+/).at(-1) ?? '');
  const tolerance = transcriptTolerance(expected);
  let heard = '';
  let end = 0;
  const speakers = new Set<string>();
  const timings: [number, number][] = [];
  // The closest prefix of the transcript to the script, by edit distance. An exact match wins at
  // once; otherwise the best prefix must be within tolerance and still end on the script's last
  // word, so a take that dropped its final word is never certified by a near miss before it.
  let best: { distance: number; consumed: number; end: number } | undefined;
  for (const [index, chunk] of result.chunks.entries()) {
    if (typeof chunk.text !== 'string') throw new SpeechError('Invalid speech transcript');
    const [start, stop] = timing(chunk.timestamp);
    if (start < end - 0.02) throw new SpeechError('Overlapping speech timestamps');
    timings.push([start, stop]);
    heard += normalized(chunk.text);
    end = stop;
    if (typeof chunk.speaker === 'string' && chunk.speaker.trim()) speakers.add(chunk.speaker);
    const d = heard === expected ? 0 : distance(heard, expected);
    if (!best || d < best.distance) best = { distance: d, consumed: index + 1, end };
    if (d === 0) break;
    // Numeric words can temporarily differ until their complete number is assembled.
    if (heard.length > expected.length + tolerance) break;
  }
  if (!best || best.distance > tolerance)
    throw new SpeechError(`Generated speech does not match the scripted line${best ? ` (closest prefix differs by ${best.distance} of ${expected.length} characters)` : ''}`);
  const kept = result.chunks.slice(0, best.consumed).map((c) => normalized(String(c.text))).join('');
  if (best.distance > 0 && lastWord && !kept.endsWith(lastWord))
    throw new SpeechError(`Generated speech does not end on the scripted last word (closest prefix differs by ${best.distance} of ${expected.length} characters)`);
  const consumed = best.consumed;
  end = best.end;
  const accepted = timings.slice(0, consumed);
  // Only the excluded chunks' starts matter, and Whisper leaves the end of a final chunk null now
  // and then; that alone must not refuse an otherwise verified take.
  for (const extra of result.chunks.slice(consumed)) {
    const start = Array.isArray(extra.timestamp) ? extra.timestamp[0] : undefined;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) throw new SpeechError('Invalid speech timestamps');
    if (start < end) throw new SpeechError('Excluded speech overlaps the scripted line');
  }
  const segments = result.diarization_segments.map(segment => {
    const [start, stop] = timing(segment.timestamp);
    const speaker = typeof segment.speaker === 'string' ? segment.speaker.trim() : '';
    if (start < end) {
      if (!speaker) throw new SpeechError('Missing speaker attribution');
      speakers.add(speaker);
    }
    return { start, stop, speaker };
  });
  // Diarization boundaries sit on a coarser grid than word alignment, and the diarizer does
  // not smooth its own output: real takes carry same-speaker holes of 84-236 ms mid-line, and
  // the first block starts 100-190 ms after Whisper's first word, whose start is snapped to
  // the clip origin. Bridge same-speaker holes up to half a second, allow half a second before
  // the first word and a quarter-second collar at every other edge. An unlabelled word or a
  // larger hole still refuses the take, and the message says which word so a refusal on air
  // can be read from the box.
  const COLLAR = 0.25;
  const BRIDGE = 0.5;
  const ONSET = 0.5;
  const blocks: { start: number; stop: number; speaker: string }[] = [];
  for (const s of segments.filter(s => s.speaker).sort((a, b) => a.start - b.start)) {
    const previous = blocks.at(-1);
    if (previous && previous.speaker === s.speaker && s.start <= previous.stop + BRIDGE) previous.stop = Math.max(previous.stop, s.stop);
    else blocks.push({ start: s.start, stop: s.stop, speaker: s.speaker });
  }
  for (const [i, [start, stop]] of accepted.entries())
    if (!blocks.some(b => b.start <= start + (i === 0 ? ONSET : COLLAR) && b.stop >= stop - COLLAR)) {
      const word = String(result.chunks[i].text).trim();
      throw new SpeechError(`Incomplete speaker coverage for scripted speech: "${word}" at ${start.toFixed(2)}-${stop.toFixed(2)}s`);
    }
  if (speakers.size !== 1) throw new SpeechError('Speech contains multiple or unknown speakers');
  return end;
}
