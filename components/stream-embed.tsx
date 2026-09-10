'use client';
/* oxlint-disable next/no-img-element -- Static studio artwork, shown without an image optimizer. */
import { ArrowUpRight } from 'lucide-react';
import { show } from '@/lib/show';
export type StreamLinks = { pumpfun: string | null; x: string | null };
/** Cloudflare Stream starts muted so autoplay is allowed; the viewer unmutes in the player. */
export function embedSrc(url: string) {
  try {
    const u = new URL(url);
    if (u.hostname === 'cloudflarestream.com' || u.hostname.endsWith('.cloudflarestream.com')) {
      u.searchParams.set('autoplay', 'true');
      u.searchParams.set('muted', 'true');
    }
    return u.toString();
  } catch {
    return url;
  }
}
/**
 * The stream when the show is actually on air; otherwise the studio poster and the places it
 * plays. The `live` gate matters: an idle Cloudflare live input renders the player as a blank
 * white rectangle, which on a dark page reads as a broken site rather than a show between
 * episodes. The studio heartbeat already tells us whether anything is being broadcast, so we
 * hold the poster until it is.
 */
export function StreamEmbed({
  url,
  links,
  live,
  poster,
}: {
  url: string | null;
  links: StreamLinks;
  /** Required on purpose: a caller who forgets it would default back to the blank player. */
  live: boolean;
  poster: string;
}) {
  if (url && live) {
    return (
      <div className="stage stream-embed live">
        <iframe
          src={embedSrc(url)}
          title={`${show.name} live stream`}
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
        />
        <span className="stream-hint">UNMUTE THE PLAYER TO HEAR THE SHOW</span>
      </div>
    );
  }
  // Two different silences, and saying the wrong one is its own kind of broken: either the
  // stream is not built yet, or it exists and the show is simply between episodes. Reaching
  // here at all means we are not live, so a stream we have is a stream that is off air.
  const offAir = !!url;
  const anywhere = !!(links.pumpfun || links.x);
  return (
    <div className="stage stream-embed">
      <img src={poster} alt="" />
      <div className="stream-poster">
        <img className="opening-mark" src="/logo.webp" alt={show.name} />
        <p className="eyebrow">{offAir ? 'OFF AIR' : anywhere ? 'WATCH THE SHOW' : 'STREAM'}</p>
        <h1>{show.headline}</h1>
        <p className="stream-soon">
          {offAir
            ? 'The studio is dark right now. The show picks up when it comes back.'
            : 'Stream link coming soon.'}
        </p>
        {anywhere && (
          <div className="stream-links">
            {links.pumpfun && (
              <a className="primary" href={links.pumpfun} target="_blank" rel="noreferrer">
                Watch on pump.fun <ArrowUpRight size={16} />
              </a>
            )}
            {links.x && (
              <a className="primary" href={links.x} target="_blank" rel="noreferrer">
                Watch on X <ArrowUpRight size={16} />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
