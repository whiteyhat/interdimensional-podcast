'use client';
/* oxlint-disable next/no-img-element -- Static studio artwork, shown without an image optimizer. */
import { ArrowUpRight } from 'lucide-react';
import { show } from '@/lib/show';
export type StreamLinks = { pumpfun: string | null; x: string | null };
/** Cloudflare Stream starts muted so autoplay is allowed; the viewer unmutes in the player. */
export function embedSrc(url: string) {
  try {
    const u = new URL(url);
    if (
      u.hostname === 'cloudflarestream.com' ||
      u.hostname.endsWith('.cloudflarestream.com')
    ) {
      u.searchParams.set('autoplay', 'true');
      u.searchParams.set('muted', 'true');
    }
    return u.toString();
  } catch {
    return url;
  }
}
/**
 * The stream when a picture is actually arriving; otherwise the studio poster and the places
 * the show plays. The `live` gate matters: an idle Cloudflare live input renders the player as
 * a blank white rectangle, which on a dark page reads as a broken site rather than a show
 * between episodes. It must be the input's own state and not the studio heartbeat, which says
 * a producer is alive and keeps saying so for the whole minute before an encoder connects.
 */
export function StreamEmbed({
  url,
  links,
  live,
  studioOnline = false,
  poster,
}: {
  url: string | null;
  links: StreamLinks;
  /** Required on purpose: a caller who forgets it would default back to the blank player. */
  live: boolean;
  /** Separates a show between episodes from one whose picture has not arrived yet. */
  studioOnline?: boolean;
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
  // Three different silences, and saying the wrong one is its own kind of broken: the stream
  // is not built yet, or it exists and the show is between episodes, or the studio is working
  // and the picture simply has not landed. Reaching here at all means no picture is arriving.
  const offAir = !!url;
  const warmingUp = offAir && studioOnline;
  const anywhere = !!(links.pumpfun || links.x);
  return (
    <div className="stage stream-embed">
      <img src={poster} alt="" />
      <div className="stream-poster">
        <img className="opening-mark" src="/logo.webp" alt={show.name} />
        <p className="eyebrow">
          {warmingUp
            ? 'STARTING'
            : offAir
              ? 'OFF AIR'
              : anywhere
                ? 'WATCH THE SHOW'
                : 'STREAM'}
        </p>
        <h1>{show.headline}</h1>
        <p className="stream-soon">
          {warmingUp
            ? 'The studio is on. The picture lands as soon as the encoder connects.'
            : offAir
              ? 'The studio is dark right now. The show picks up when it comes back.'
              : 'Stream link coming soon.'}
        </p>
        {anywhere && (
          <div className="stream-links">
            {links.pumpfun && (
              <a
                className="primary"
                href={links.pumpfun}
                target="_blank"
                rel="noreferrer"
              >
                Watch on pump.fun <ArrowUpRight size={16} />
              </a>
            )}
            {links.x && (
              <a
                className="primary"
                href={links.x}
                target="_blank"
                rel="noreferrer"
              >
                Watch on X <ArrowUpRight size={16} />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
