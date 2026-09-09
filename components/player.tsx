'use client';
/* oxlint-disable jsx-a11y/media-has-caption -- Dialogue captions are rendered from the script below the live shot. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/lib/engine';
import { cast } from '@/lib/show';
export function Player({
  state,
  muted,
  onEnded,
  onShown,
}: {
  state: Snapshot;
  muted: boolean;
  onEnded: (id: number) => void;
  onShown: (id: number) => void;
}) {
  const videos = useRef(new Map<number, HTMLVideoElement>());
  // URLs identify the decoded media even when a new transmission reuses clip ids.
  const [visible, setVisible] = useState<string | null>(null);
  const acknowledged = useRef<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const current = state.current;
  const clips = [
    state.previous,
    current,
    ...state.slots.map((s) => s.clip),
  ].filter((c, i, all) => c && all.findIndex((x) => x?.id === c.id) === i);
  useLayoutEffect(() => {
    if (
      current &&
      visible === current.url &&
      acknowledged.current !== current.url
    ) {
      acknowledged.current = current.url;
      // The opacity change has committed. Only now may the engine remove/revoke
      // the outgoing video; doing this in `playing` released it while still visible.
      onShown(current.id);
    }
  }, [current, visible, onShown]);
  useEffect(() => {
    for (const [id, video] of videos.current) {
      if (
        id !== current?.id ||
        state.phase === 'paused' ||
        state.phase === 'stopped'
      )
        video.pause();
    }
    if (current && state.phase === 'playing') {
      const video = videos.current.get(current.id);
      if (!video) return;
      let cancelled = false;
      let frame: number | undefined;
      let paint: number | undefined;
      const reveal = () => {
        if (!cancelled) setVisible(current.url);
      };
      // `playing` reports playback state, not that a frame reached the compositor.
      const frameCallbacks =
        typeof video.requestVideoFrameCallback === 'function';
      const fallback = () => {
        if (paint !== undefined || video.readyState < 2) return;
        paint = requestAnimationFrame(() => {
          paint = requestAnimationFrame(reveal);
        });
      };
      if (acknowledged.current !== current.url) {
        if (frameCallbacks) frame = video.requestVideoFrameCallback(reveal);
        else video.addEventListener('playing', fallback);
      }
      void video
        .play()
        .then(() => {
          if (cancelled) return;
          setBlocked(false);
          if (!frameCallbacks && acknowledged.current !== current.url)
            fallback();
        })
        .catch(() => {
          if (!cancelled) setBlocked(true);
        });
      return () => {
        cancelled = true;
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
        if (paint !== undefined) cancelAnimationFrame(paint);
        video.removeEventListener('playing', fallback);
      };
    }
  }, [current, state.phase]);
  return (
    <>
      {clips.map(
        (clip) =>
          clip && (
            <video
              key={clip.url}
              ref={(node) => {
                if (node) videos.current.set(clip.id, node);
                else videos.current.delete(clip.id);
              }}
              src={clip.url}
              preload="auto"
              playsInline
              muted={muted}
              style={{
                opacity: visible === clip.url ? 1 : 0,
                pointerEvents: 'none',
              }}
              onEnded={() => onEnded(clip.id)}
              onError={() => {
                if (clip.id === current?.id) setBlocked(true);
              }}
              aria-label={`${cast[clip.speaker].name} speaking`}
            />
          ),
      )}
      {current && (
        <>
          <span className="speaker-label">
            CAM {current.speaker === 'host' ? '01' : '02'} /{' '}
            {cast[current.speaker].name.toUpperCase()}
          </span>
          {visible === current.url && (
            <div className="caption">{current.text}</div>
          )}
        </>
      )}
      {blocked && current && state.phase === 'playing' && (
        <div className="opening">
          <h1>The studio is ready.</h1>
          <p>Your browser needs one click to play with sound.</p>
          <button
            className="primary"
            onClick={() => {
              const video = videos.current.get(current.id);
              if (video)
                void video
                  .play()
                  .then(() => setBlocked(false))
                  .catch(() => setBlocked(true));
            }}
          >
            Play with sound
          </button>
        </div>
      )}
    </>
  );
}
