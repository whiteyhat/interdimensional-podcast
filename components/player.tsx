'use client';
/* oxlint-disable jsx-a11y/media-has-caption -- Dialogue captions are rendered from the script below the live shot. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/lib/engine';
import { cast, fadedShot } from '@/lib/show';
import { PlaybackAudio } from '@/lib/playback-audio';
import { PlaybackHealth } from '@/lib/playback-health';
import { playbackRateFor } from '@/lib/playback-policy';
import { formatSubtitle } from '@/lib/subtitles';
export function Player({
  state,
  muted,
  onEnded,
  onShown,
  onPlaybackFailure,
  gate = true,
  bed = false,
}: {
  state: Snapshot;
  muted: boolean;
  onEnded: (id: number) => void;
  onShown: (id: number) => void;
  /** True means the engine moved past this media (it relinquished a paid lease or skipped the
   * shot); this URL may never resume. `skippable` marks failures that belong to the clip itself. */
  onPlaybackFailure?: (
    id: number,
    url: string,
    reason: string,
    skippable?: boolean,
  ) => boolean;
  /** Legacy clips without playbackEnd may air their full ordinary soundtrack when false.
   * New clips always enforce their verified speech and picture boundaries. */
  gate?: boolean;
  /** After a fade, play studio room tone and the gesture's sound instead of dead air. */
  bed?: boolean;
}) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const audio = useRef<PlaybackAudio | null>(null);
  const mounted = useRef(false);
  const revoked = useRef(new Set<string>());
  const completedUrl = useRef<string | null>(null);
  const endedCallback = useRef(onEnded);
  const failureCallback = useRef(onPlaybackFailure);
  useLayoutEffect(() => {
    endedCallback.current = onEnded;
    failureCallback.current = onPlaybackFailure;
  }, [onEnded, onPlaybackFailure]);
  useEffect(() => {
    mounted.current = true;
    const elements = videos.current;
    return () => {
      mounted.current = false;
      audio.current?.silence();
      for (const video of elements.values()) video.pause();
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
  const completePlayback = (id: number, url: string) => {
    if (
      playback.current.url !== url ||
      !playback.current.playing ||
      revoked.current.has(url) ||
      completedUrl.current === url
    )
      return;
    completedUrl.current = url;
    const video = videos.current.get(url);
    if (video) {
      audio.current?.silence(video);
      video.pause();
    }
    setBlocked(false);
    endedCallback.current(id);
  };
  const reportCompletion = useRef(completePlayback);
  useLayoutEffect(() => {
    reportCompletion.current = completePlayback;
  });
  const failPlayback = (
    id: number,
    url: string,
    reason: string,
    skippable = false,
  ) => {
    if (playback.current.url !== url || !playback.current.playing) return;
    if (revoked.current.has(url) || completedUrl.current === url) return;
    const video = videos.current.get(url);
    if (video) {
      audio.current?.silence(video);
      video.pause();
    }
    const handled = !!failureCallback.current?.(id, url, reason, skippable);
    if (handled) {
      revoked.current.add(url);
      setRevokedUrl(url);
    }
    // The engine moved on by itself; only an unhandled failure needs the viewer's click.
    setBlocked(!handled);
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
    for (const [url, video] of videos.current) {
      if (
        url !== current?.url ||
        state.phase === 'paused' ||
        state.phase === 'stopped'
      )
        video.pause();
    }
    if (current && state.phase === 'playing') {
      const video = videos.current.get(current.url);
      if (
        !video ||
        revoked.current.has(current.url) ||
        completedUrl.current === current.url
      )
        return;
      let cancelled = false;
      let failed = false;
      const fail = (reason: string, skippable = false) => {
        if (cancelled || failed) return;
        failed = true;
        reportFailure.current(current.id, current.url, reason, skippable);
      };
      // A clip whose media already errored while it preloaded as a slot cannot play: it is the
      // clip's fault, so the engine skips it rather than asking the viewer for a click.
      if (video.error) {
        queueMicrotask(() => {
          if (mounted.current)
            fail('The current video could not be decoded.', true);
        });
        return;
      }
      video.defaultPlaybackRate = playbackRateFor(current);
      video.playbackRate = playbackRateFor(current);
      video.preservesPitch = true;
      let bus: PlaybackAudio;
      try {
        bus = audio.current ??= new PlaybackAudio();
        // New clips carry independent acoustic and picture endings: clean takes keep their
        // complete source, while contaminated tails stop together. Older clips keep their gate.
        const fades =
          current.playbackEnd !== undefined ||
          gate ||
          fadedShot(current.text, current.gesture);
        const audioEnd =
          current.audioEnd ?? (fades ? (current.speechEnd ?? 0) : Infinity);
        bus.setMuted(muted);
        bus.attach(
          video,
          // Native endings own their last sample; only excluded tails need a scheduled fade.
          audioEnd === current.mediaDuration && current.playbackEnd === current.mediaDuration
            ? Infinity
            : audioEnd,
          // A clip without a verified line end stays silent until regenerated: no bed either.
          bed &&
            fades &&
            current.speechEnd !== undefined &&
            audioEnd !== current.mediaDuration
            ? { gesture: current.gesture }
            : undefined,
        );
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
      let cutTimer: ReturnType<typeof setTimeout> | undefined;
      const health = new PlaybackHealth(performance.now());
      const cancelCut = () => {
        if (cutTimer !== undefined) clearTimeout(cutTimer);
        cutTimer = undefined;
      };
      // The media clock determines the cut. A pause or a decoder stall cannot spend the
      // remaining dialogue, and seeking/rate changes rearm it from the new media position.
      const scheduleCut = () => {
        cancelCut();
        const end = current.playbackEnd;
        if (
          cancelled ||
          failed ||
          completedUrl.current === current.url ||
          end === undefined ||
          // Let the browser present its final frame and dispatch `ended` for complete sources.
          // A timer at duration can otherwise pause between the last timeupdate and ended.
          (Number.isFinite(video.duration) && end >= video.duration) ||
          video.paused ||
          video.ended ||
          video.seeking
        )
          return;
        const remaining = end - video.currentTime;
        if (remaining <= 0) {
          reportCompletion.current(current.id, current.url);
          return;
        }
        cutTimer = setTimeout(
          scheduleCut,
          Math.max(10, (remaining / video.playbackRate) * 1000),
        );
      };
      const playing = () => {
        if (
          cancelled ||
          video.paused ||
          video.ended ||
          revoked.current.has(current.url) ||
          completedUrl.current === current.url
        )
          return;
        // A successful user retry keeps this effect alive. Restore its cut and stall
        // detection only when the browser confirms that the media is playing again.
        failed = false;
        health.resume(performance.now());
        scheduleCut();
      };
      video.addEventListener('playing', playing);
      for (const event of ['seeked', 'ratechange', 'timeupdate'])
        video.addEventListener(event, scheduleCut);
      for (const event of ['pause', 'waiting', 'seeking'])
        video.addEventListener(event, cancelCut);
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
          if (
            cancelled ||
            revoked.current.has(current.url) ||
            completedUrl.current === current.url
          ) {
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
          scheduleCut();
          setBlocked(false);
          if (!frameCallbacks && acknowledged.current !== current.url)
            fallback();
        })
        .catch(() => {
          // The media is sound (see the check above), so this is a refused gesture.
          fail('The browser blocked this clip from playing.');
        });
      let hidden = document.visibilityState === 'hidden';
      const watchdog = setInterval(() => {
        // A finished clip waiting for the engine is not a stall.
        if (
          cancelled ||
          failed ||
          video.ended ||
          completedUrl.current === current.url
        )
          return;
        const now = performance.now();
        // Neither is a tab the browser paused: its clock restarts when the tab is back.
        if (document.visibilityState === 'hidden') {
          hidden = true;
          return;
        }
        if (hidden) {
          hidden = false;
          health.resume(now);
          return;
        }
        if (health.stalled(video.currentTime, now))
          fail('Playback stopped making progress for eight seconds.', true);
      }, 500);
      return () => {
        cancelled = true;
        cancelCut();
        video.removeEventListener('playing', playing);
        for (const event of ['seeked', 'ratechange', 'timeupdate'])
          video.removeEventListener(event, scheduleCut);
        for (const event of ['pause', 'waiting', 'seeking'])
          video.removeEventListener(event, cancelCut);
        bus.silence(video);
        video.pause();
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
        if (paint !== undefined) cancelAnimationFrame(paint);
        video.removeEventListener('playing', fallback);
        clearInterval(watchdog);
      };
    }
  }, [current, state.phase, muted, gate, bed]);
  return (
    <>
      {clips.map(
        (clip) =>
          clip && (
            <video
              key={clip.url}
              ref={(node) => {
                if (node) videos.current.set(clip.url, node);
                else videos.current.delete(clip.url);
              }}
              src={clip.url}
              preload="auto"
              playsInline
              muted={
                muted ||
                (!!clip.continuity && !(clip.audioEnd && clip.audioEnd > 0)) ||
                clip.url !== current?.url || state.phase !== 'playing'
              }
              style={{
                opacity: visible === clip.url ? 1 : 0,
                pointerEvents: 'none',
              }}
              onPlaying={(event) => {
                if (
                  clip.url === current?.url &&
                  state.phase === 'playing' &&
                  !revoked.current.has(clip.url) &&
                  completedUrl.current !== clip.url
                )
                  audio.current?.sync(event.currentTarget);
                else event.currentTarget.pause();
              }}
              onPause={(event) => audio.current?.silence(event.currentTarget)}
              onWaiting={(event) => audio.current?.silence(event.currentTarget)}
              onSeeking={(event) => audio.current?.silence(event.currentTarget)}
              onSeeked={(event) => {
                if (
                  !revoked.current.has(clip.url) &&
                  completedUrl.current !== clip.url
                )
                  audio.current?.sync(event.currentTarget);
              }}
              onRateChange={(event) => {
                if (
                  !revoked.current.has(clip.url) &&
                  completedUrl.current !== clip.url
                )
                  audio.current?.sync(event.currentTarget);
              }}
              onEnded={() => completePlayback(clip.id, clip.url)}
              onError={() => {
                if (clip.url === current?.url)
                  reportFailure.current(
                    clip.id,
                    clip.url,
                    'The current video could not be decoded.',
                    true,
                  );
              }}
              aria-label={`${cast[clip.speaker].name} ${clip.continuity ? 'listening' : 'speaking'}`}
            />
          ),
      )}
      {current && (
        <>
          <span className="speaker-label">
            CAM {current.speaker === 'host' ? '01' : '02'} /{' '}
            {cast[current.speaker].name.toUpperCase()}
          </span>
          {visible === current.url && !current.continuity && (
            <div className="caption">
              {formatSubtitle(current.text, {
                tickers: state.coin?.symbol ? [state.coin.symbol] : undefined,
              })}
            </div>
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
                const video = videos.current.get(current.url);
                const epoch = playback.current.epoch;
                const active = () =>
                  mounted.current &&
                  playback.current.epoch === epoch &&
                  playback.current.playing &&
                  playback.current.url === current.url &&
                  !revoked.current.has(current.url) &&
                  completedUrl.current !== current.url;
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
