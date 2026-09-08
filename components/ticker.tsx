'use client';
import type { Cue } from '@/lib/engine';
import { sourceLabel, type Topic } from '@/lib/topics';
/** The broadcast lower-third: what the stream audience sees about the current subject. */
export function Ticker({ topics, cues }: { topics: Topic[]; cues: Cue[] }) {
  const topic = topics.find((t) => t.status === 'on-air');
  const cue = cues.find((c) => c.status === 'on-air');
  // Whichever subject reached the microphone last is the one on air.
  const showCue = cue && (!topic?.shot || (cue.shot ?? -1) > topic.shot);
  const title = showCue ? cue.text : topic?.title;
  const label = showCue
    ? 'audience request'
    : topic && sourceLabel(topic);
  if (!title) return null;
  return (
    <div className="ticker" key={showCue ? cue.id : topic?.id}>
      <span className="ticker-live">
        <i />
        LIVE
      </span>
      <span className="ticker-title">{title}</span>
      {label && <span className="ticker-source">{label}</span>}
    </div>
  );
}
