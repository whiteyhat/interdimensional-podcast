'use client';
/* oxlint-disable next/no-img-element -- Small brand mark on a live overlay; no optimizer in this runtime. */
import { useEffect, useState } from 'react';
import { houseConfig, houseTickerUp, siteHostDefault } from '@/lib/house';
import type { PaidRequest } from '@/lib/requests';
import { show } from '@/lib/show';
import { sourceLabel, type Topic } from '@/lib/topics';
/**
 * The broadcast lower-third: what the stream audience sees about the current subject, and
 * now and then where the show's coin lives. The house slot comes up for twelve seconds in
 * every ninety, only once the coin is launched and never over a paid placement; it remounts
 * with the same entrance the topic banner uses, so the picture keeps one motion.
 */
export function Ticker({
  topics,
  requests,
  coinLive = false,
  paidOnAir = false,
}: {
  topics: Topic[];
  requests: PaidRequest[];
  coinLive?: boolean;
  paidOnAir?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);
  const topic = topics.find((t) => t.status === 'on-air');
  const request = requests.find((r) => r.status === 'on-air');
  // Whichever subject reached the microphone last is the one on air.
  const showRequest =
    request && (!topic?.shot || (request.shot ?? -1) > topic.shot);
  if (coinLive && !paidOnAir && !showRequest && houseTickerUp(now))
    return (
      <div
        className="ticker ticker-house"
        key={`house-${Math.floor(now / houseConfig.ticker.everyMs)}`}
      >
        <img className="ticker-mark" src="/logo.avif" alt="" />
        <span className="ticker-live">
          <i />
          LIVE
        </span>
        <span className="ticker-title">{show.ticker} is live on pump.fun</span>
        <span className="ticker-source">{siteHostDefault} · not financial advice</span>
      </div>
    );
  const title = showRequest ? request.text : topic?.title;
  const label = showRequest
    ? `paid request · ${request.from}`
    : topic && sourceLabel(topic);
  if (!title) return null;
  return (
    <div className="ticker" key={showRequest ? request.id : topic?.id}>
      <img className="ticker-mark" src="/logo.avif" alt="" />
      <span className="ticker-live">
        <i />
        LIVE
      </span>
      <span className="ticker-title">{title}</span>
      {label && <span className="ticker-source">{label}</span>}
    </div>
  );
}
