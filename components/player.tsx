'use client';
/* oxlint-disable jsx-a11y/media-has-caption -- Dialogue captions are rendered from the script below the live shot. */
import { useEffect, useRef, useState } from 'react';
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
  const [visible, setVisible] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const current = state.current;
  const clips = [
    state.previous,
    current,
    ...state.slots.map((s) => s.clip),
  ].filter((c, i, all) => c && all.findIndex((x) => x?.id === c.id) === i);
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
      if (video)
        void video
          .play()
          .then(() => setBlocked(false))
          .catch(() => setBlocked(true));
    }
  }, [current, state.phase]);
  return (
    <>
      {clips.map(
        (clip) =>
          clip && (
            <video
              key={clip.id}
              ref={(node) => {
                if (node) videos.current.set(clip.id, node);
                else videos.current.delete(clip.id);
              }}
              src={clip.url}
              preload="auto"
              playsInline
              muted={muted}
              style={{
                opacity: visible === clip.id ? 1 : 0,
                pointerEvents: 'none',
              }}
              onPlaying={() => {
                if (clip.id === current?.id) {
                  setVisible(clip.id);
                  setBlocked(false);
                  onShown(clip.id);
                }
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
          {visible === current.id && (
            <div className="caption">{current.text}</div>
          )}
        </>
      )}
      {blocked && current && (
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
