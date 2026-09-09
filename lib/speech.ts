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
  // Diarization and word alignment use different frame grids. Allow at most 80ms
  // of boundary drift, but never accept an unlabelled word or a large coverage gap.
  for (const [start, stop] of accepted)
    if (!segments.some(s => s.speaker && s.start <= start + 0.08 && s.stop >= stop - 0.08))
      throw new SpeechError('Incomplete speaker coverage for scripted speech');
  if (speakers.size !== 1) throw new SpeechError('Speech contains multiple or unknown speakers');
  return end;
}
