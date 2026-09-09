'use client';
/* oxlint-disable next/no-img-element -- Small brand mark on a live overlay; no optimizer in this runtime. */
import type { PaidRequest } from '@/lib/requests';
import { sourceLabel, type Topic } from '@/lib/topics';
/** The broadcast lower-third: what the stream audience sees about the current subject. */
export function Ticker({
  topics,
  requests,
}: {
  topics: Topic[];
  requests: PaidRequest[];
}) {
  const topic = topics.find((t) => t.status === 'on-air');
  const request = requests.find((r) => r.status === 'on-air');
  // Whichever subject reached the microphone last is the one on air.
  const showRequest =
    request && (!topic?.shot || (request.shot ?? -1) > topic.shot);
  const title = showRequest ? request.text : topic?.title;
  const label = showRequest
    ? `paid request · ${request.from}`
    : topic && sourceLabel(topic);
  if (!title) return null;
  return (
    <div className="ticker" key={showRequest ? request.id : topic?.id}>
      <img className="ticker-mark" src="/logo.png" alt="" />
      <span className="ticker-live">
        <i />
        LIVE
      </span>
      <span className="ticker-title">{title}</span>
      {label && <span className="ticker-source">{label}</span>}
    </div>
  );
}
