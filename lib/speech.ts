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
/** Refuse an uncertain take; never air the unverified full soundtrack as a fallback. */
export function speechEndFor(script: string, raw: unknown): number {
  const result = raw as { chunks?: { text?: unknown; timestamp?: unknown; speaker?: unknown }[]; diarization_segments?: { timestamp?: unknown; speaker?: unknown }[] } | null;
  if (!Array.isArray(result?.chunks) || !Array.isArray(result?.diarization_segments) || !result.diarization_segments.length)
    throw new SpeechError('Missing speech alignment or speaker analysis');
  const expected = normalized(script);
  if (!expected) throw new SpeechError('Missing scripted speech');
  let heard = '';
  let end = 0;
  let found = false;
  const speakers = new Set<string>();
  const accepted: [number, number][] = [];
  let consumed = 0;
  for (const chunk of result.chunks) {
    if (typeof chunk.text !== 'string') throw new SpeechError('Invalid speech transcript');
    const [start, stop] = timing(chunk.timestamp);
    if (start < end - 0.02) throw new SpeechError('Overlapping speech timestamps');
    accepted.push([start, stop]);
    consumed++;
    heard += normalized(chunk.text);
    end = stop;
    if (typeof chunk.speaker === 'string' && chunk.speaker.trim()) speakers.add(chunk.speaker);
    if (heard === expected) { found = true; break; }
    // Numeric words can temporarily differ until their complete number is assembled.
  }
  if (!found) throw new SpeechError('Generated speech does not match the scripted line');
  for (const extra of result.chunks.slice(consumed)) {
    const [start] = timing(extra.timestamp);
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
