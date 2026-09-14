'use client';
/* oxlint-disable jsx-a11y/media-has-caption -- Dialogue captions are rendered from the script below the live shot. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Clip, Snapshot } from '@/lib/engine';
import { cast } from '@/lib/show';
import { PlaybackAudio } from '@/lib/playback-audio';
import { PlaybackHealth } from '@/lib/playback-health';
import { assignLayers } from '@/lib/video-layers';
/** The element on the layer that shows `url`, if any. Reads committed layers, never render state. */
function layerVideo(
  urls: readonly (string | null)[],
  elements: readonly (HTMLVideoElement | null)[],
  url: string,
) {
  const index = urls.indexOf(url);
  return index < 0 ? undefined : (elements[index] ?? undefined);
}
export function Player({
  state,
  muted,
  onEnded,
  onShown,
  onPlaybackFailure,
}: {
  state: Snapshot;
  muted: boolean;
  onEnded: (id: number) => void;
  onShown: (id: number) => void;
  /** True means the engine relinquished this media's paid lease; this URL may never resume. */
  onPlaybackFailure?: (id: number, url: string, reason: string) => boolean;
}) {
  // Every element the audio bus has ever routed lives as long as its AudioContext: Chromium
  // registers each MediaElementAudioSourceNode as an active source until the context closes.
  // A fresh <video> per clip therefore kept one decoded player per take for the whole
  // broadcast (about a hundred megabytes a minute on the box). Clips share a small pool of
  // layers instead, so the bus only ever meets as many elements as there are layers.
  const [pool, setPool] = useState<readonly (string | null)[]>([]);
  const elements = useRef<(HTMLVideoElement | null)[]>([]);
  // The committed layout, for effects and handlers. Playback must not restart whenever a newly
  // buffered clip takes a free layer, so the playback effect reads this ref, not `layers`.
  const layerUrls = useRef<readonly (string | null)[]>([]);
  const audio = useRef<PlaybackAudio | null>(null);
  const mounted = useRef(false);
  const revoked = useRef(new Set<string>());
  const failureCallback = useRef(onPlaybackFailure);
  useLayoutEffect(() => {
    failureCallback.current = onPlaybackFailure;
  }, [onPlaybackFailure]);
  useEffect(() => {
    mounted.current = true;
    const media = elements.current;
    return () => {
      mounted.current = false;
      audio.current?.silence();
      for (const video of media) video?.pause();
      // React StrictMode immediately mounts effects again; keep its media source reusable.
      queueMicrotask(() => {
        if (!mounted.current) void audio.current?.close();
      });
    };
  }, []);
  // URLs identify the decoded media even when a new transmission reuses clip ids.
  const [visible, setVisible] = useState<string | null>(null);
  const acknowledged = useRef<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [revokedUrl, setRevokedUrl] = useState<string | null>(null);
  const current = state.current;
  const playback = useRef({
    url: null as string | null,
    playing: false,
    epoch: 0,
  });
  const clips = [
    state.previous,
    current,
    ...state.slots.map((s) => s.clip),
  ].filter(
    (c, i, all): c is Clip =>
      !!c && all.findIndex((x) => x?.id === c.id) === i,
  );
  const layers = assignLayers(
    pool,
    clips.map((clip) => clip.url),
  );
  // A changed layout re-renders at once; effects and handlers below see the committed one.
  if (layers !== pool) setPool(layers);
  const failPlayback = (id: number, url: string, reason: string) => {
    if (playback.current.url !== url || !playback.current.playing) return;
    if (revoked.current.has(url)) return;
    const video = layerVideo(layerUrls.current, elements.current, url);
    if (video) {
      audio.current?.silence(video);
      video.pause();
    }
    if (failureCallback.current?.(id, url, reason)) {
      revoked.current.add(url);
      setRevokedUrl(url);
    }
    setBlocked(true);
  };
  const reportFailure = useRef(failPlayback);
  useLayoutEffect(() => {
    reportFailure.current = failPlayback;
  });
  useLayoutEffect(() => {
    playback.current = {
      url: current?.url ?? null,
      playing: state.phase === 'playing',
      epoch: playback.current.epoch + 1,
    };
    return () => {
      playback.current = {
        url: null,
        playing: false,
        epoch: playback.current.epoch + 1,
      };
    };
  }, [current?.url, state.phase]);
  useLayoutEffect(() => {
    layerUrls.current = layers;
    // React only drops a freed layer's src attribute; loading with no source is what discards
    // its decoded media, so a resting layer holds nothing between clips.
    layers.forEach((url, index) => {
      const video = elements.current[index];
      if (url === null && video && video.networkState !== video.NETWORK_EMPTY)
        video.load();
    });
  }, [layers]);
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
    layerUrls.current.forEach((url, index) => {
      const video = elements.current[index];
      if (
        video &&
        (url !== current?.url ||
          state.phase === 'paused' ||
          state.phase === 'stopped')
      )
        video.pause();
    });
    if (current && state.phase === 'playing') {
      const video = layerVideo(
        layerUrls.current,
        elements.current,
        current.url,
      );
      if (!video || revoked.current.has(current.url)) return;
      let cancelled = false;
      let failed = false;
      const fail = (reason: string) => {
        if (cancelled || failed) return;
        failed = true;
        reportFailure.current(current.id, current.url, reason);
      };
      let bus: PlaybackAudio;
      try {
        bus = audio.current ??= new PlaybackAudio();
        // Older buffered clips lack an audit boundary. Regenerate them before airing.
        bus.attach(video, current.speechEnd ?? 0);
        void bus
          .resume()
          .catch(() => fail('The browser could not start the verified audio.'));
      } catch {
        video.muted = true;
        queueMicrotask(() => {
          if (mounted.current)
            fail('The verified audio could not be attached to this clip.');
        });
        return;
      }
      let frame: number | undefined;
      let paint: number | undefined;
      const reveal = () => {
        if (!cancelled && !revoked.current.has(current.url))
          setVisible(current.url);
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
          if (cancelled || revoked.current.has(current.url)) {
            bus.silence(video);
            video.pause();
            return;
          }
          if (!muted && bus.context.state !== 'running') {
            video.pause();
            fail('The browser blocked the sponsorship audio.');
            return;
          }
          bus.sync(video);
          setBlocked(false);
          if (!frameCallbacks && acknowledged.current !== current.url)
            fallback();
        })
        .catch(() => {
          fail('The browser blocked or failed to decode this clip.');
        });
      const health = new PlaybackHealth(performance.now());
      const watchdog = setInterval(() => {
        if (
          !cancelled &&
          !failed &&
          health.stalled(video.currentTime, performance.now())
        )
          fail('Playback stopped making progress for eight seconds.');
      }, 500);
      return () => {
        cancelled = true;
        bus.silence(video);
        video.pause();
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
        if (paint !== undefined) cancelAnimationFrame(paint);
        video.removeEventListener('playing', fallback);
        clearInterval(watchdog);
      };
    }
  }, [current, state.phase, muted]);
  return (
    <>
      {layers.map((url, index) => {
        const clip =
          url === null ? undefined : clips.find((c) => c.url === url);
        return (
          <video
            key={index}
            ref={(node) => {
              elements.current[index] = node;
            }}
            src={clip?.url}
            preload="auto"
            playsInline
            muted={
              !clip ||
              muted ||
              clip.url !== current?.url ||
              state.phase !== 'playing'
            }
            style={{
              opacity: clip && visible === clip.url ? 1 : 0,
              pointerEvents: 'none',
            }}
            onPlaying={(event) => {
              if (
                clip &&
                clip.url === current?.url &&
                state.phase === 'playing' &&
                !revoked.current.has(clip.url)
              )
                audio.current?.sync(event.currentTarget);
              else event.currentTarget.pause();
            }}
            onPause={(event) => audio.current?.silence(event.currentTarget)}
            onWaiting={(event) => audio.current?.silence(event.currentTarget)}
            onSeeking={(event) => audio.current?.silence(event.currentTarget)}
            onSeeked={(event) => {
              if (clip && !revoked.current.has(clip.url))
                audio.current?.sync(event.currentTarget);
            }}
            onRateChange={(event) => {
              if (clip && !revoked.current.has(clip.url))
                audio.current?.sync(event.currentTarget);
            }}
            onEnded={() => {
              if (
                clip &&
                clip.url === current?.url &&
                !revoked.current.has(clip.url)
              )
                onEnded(clip.id);
            }}
            onError={() => {
              if (clip && clip.url === current?.url)
                reportFailure.current(
                  clip.id,
                  clip.url,
                  'The current video could not be decoded.',
                );
            }}
            aria-label={clip ? `${cast[clip.speaker].name} speaking` : undefined}
          />
        );
      })}
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
      {blocked &&
        current &&
        state.phase === 'playing' &&
        revokedUrl !== current.url && (
          <div className="opening">
            <h1>The studio is ready.</h1>
            <p>Your browser needs one click to play with sound.</p>
            <button
              className="primary"
              onClick={() => {
                const video = layerVideo(
                  layerUrls.current,
                  elements.current,
                  current.url,
                );
                const epoch = playback.current.epoch;
                const active = () =>
                  mounted.current &&
                  playback.current.epoch === epoch &&
                  playback.current.playing &&
                  playback.current.url === current.url &&
                  !revoked.current.has(current.url);
                const bus = audio.current;
                if (video && bus && active())
                  void bus
                    .resume()
                    .then(() => {
                      if (active()) return video.play();
                    })
                    .then(() => {
                      if (active()) {
                        audio.current?.sync(video);
                        setBlocked(false);
                      }
                    })
                    .catch(() => {
                      if (active())
                        reportFailure.current(
                          current.id,
                          current.url,
                          'The browser could not resume verified playback.',
                        );
                    });
              }}
            >
              Play with sound
            </button>
          </div>
        )}
    </>
  );
}
