'use client';
/* oxlint-disable next/no-img-element -- Uses the show's canonical generated artwork. */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Play, Square, Volume2, VolumeX, Radio } from 'lucide-react';
import { cast, show } from '@/lib/show';
import type { createDirector } from '@/lib/director-live';
import type { DirectorBrief } from '@/lib/director-program';
import type { DirectorSnapshot } from '@/lib/director-rotation';
const idle: DirectorSnapshot = {
  phase: 'idle',
  running: false,
  activeId: null,
  candidateId: null,
  remainingSeconds: 0,
  bufferedSeconds: 0,
  rotations: 0,
  failures: 0,
  error: '',
};
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export function DirectorStudio() {
  const params = useSearchParams();
  const broadcast = params.get('broadcast') === '1';
  const autostart = params.get('autostart') === '1';
  const [config, setConfig] = useState<{
    configured: boolean;
    sessionSeconds: number;
  } | null>(null);
  const [snapshot, setSnapshot] = useState(idle);
  const [brief, setBrief] = useState<DirectorBrief | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [muted, setMuted] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const runtime = useRef<ReturnType<typeof createDirector> | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const master = useRef<GainNode | null>(null);
  const release = useRef<(() => void) | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const run = useRef(0);
  const busy = useRef(false);
  const retiring = useRef(Promise.resolve());
  const startedAutomatically = useRef(false);
  const mute = useRef(false);
  const stop = useCallback(() => {
    run.current++;
    busy.current = false;
    const closed = runtime.current?.rotation.stop() ?? Promise.resolve();
    runtime.current = null;
    unsubscribe.current?.();
    unsubscribe.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    const unlock = release.current;
    release.current = null;
    retiring.current = Promise.allSettled([retiring.current, closed]).then(
      () => {
        unlock?.();
      },
    );
    if (master.current && audio.current) {
      master.current.gain.cancelScheduledValues(audio.current.currentTime);
      master.current.gain.value = 0;
    }
    setStarting(false);
  }, []);
  const start = useCallback(async () => {
    if (
      !config?.configured ||
      busy.current ||
      runtime.current?.rotation.getSnapshot().running
    )
      return;
    if (runtime.current) stop();
    busy.current = true;
    const generation = ++run.current;
    setStarting(true);
    setError('');
    try {
      // Resume on the operator's click, before imports/network erase its user activation.
      audio.current ??= new AudioContext();
      const context = audio.current;
      master.current ??= context.createGain();
      master.current.disconnect();
      master.current.connect(context.destination);
      master.current.gain.value = mute.current ? 0 : 1;
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Error('Click Start Director to allow browser audio.')),
            3000,
          ),
        ),
      ]);
      await retiring.current;
      if (generation !== run.current) return;
      if (!navigator.locks)
        throw Error(
          'Director requires a Chrome or OBS browser with Web Locks.',
        );
      const unlock = await new Promise<() => void>((resolve, reject) => {
        void navigator.locks
          .request(
            'pepe-chad-director',
            { ifAvailable: true },
            async (lock) => {
              if (!lock) {
                reject(
                  Error(
                    'Another Director tab is already running. Stop it before starting this one.',
                  ),
                );
                return;
              }
              await new Promise<void>((done) => resolve(done));
            },
          )
          .catch(reject);
      });
      if (generation !== run.current) {
        unlock();
        return;
      }
      release.current = unlock;
      const { createDirector } = await import('@/lib/director-live');
      if (generation !== run.current || !stage.current) return;
      const director = createDirector(
        stage.current,
        context,
        master.current!,
        config.sessionSeconds,
        setBrief,
      );
      runtime.current = director;
      unsubscribe.current = director.rotation.subscribe(() => {
        const next = director.rotation.getSnapshot();
        setSnapshot(next);
        if (!next.running && next.phase === 'error') {
          const unlock = release.current;
          release.current = null;
          retiring.current = director.rotation.drain().then(() => {
            unlock?.();
          });
        }
      });
      director.rotation.start();
      timer.current = setInterval(() => director.tick(), 250);
    } catch (e) {
      if (generation === run.current) {
        stop();
        setError(e instanceof Error ? e.message : 'Director could not start.');
      }
    } finally {
      if (generation === run.current) {
        busy.current = false;
        setStarting(false);
      }
    }
  }, [config, stop]);
  useEffect(() => {
    const lifecycle = new AbortController();
    fetch('/api/director', { signal: lifecycle.signal })
      .then((r) => r.json())
      .then((value) => {
        const data = value as {
          configured?: unknown;
          sessionSeconds?: unknown;
        };
        setConfig({
          configured: data.configured === true,
          sessionSeconds:
            typeof data.sessionSeconds === 'number' &&
            Number.isFinite(data.sessionSeconds)
              ? data.sessionSeconds
              : 3600,
        });
      })
      .catch(() => {});
    const leave = () => stop();
    window.addEventListener('pagehide', leave);
    return () => {
      lifecycle.abort();
      window.removeEventListener('pagehide', leave);
      stop();
      const context = audio.current;
      audio.current = null;
      master.current = null;
      void context?.close().catch(() => {});
    };
  }, [stop]);
  useEffect(() => {
    if (!broadcast) return;
    document.documentElement.classList.add('broadcast-page');
    return () => document.documentElement.classList.remove('broadcast-page');
  }, [broadcast]);
  useEffect(() => {
    if (autostart && config?.configured && !startedAutomatically.current) {
      startedAutomatically.current = true;
      void start();
    }
  }, [autostart, config, start]);
  const toggleMute = () => {
    mute.current = !mute.current;
    setMuted(mute.current);
    if (master.current) master.current.gain.value = mute.current ? 0 : 1;
    void audio.current?.resume();
  };
  const controls = (
    <>
      <button
        className="quiet"
        onClick={() => (snapshot.running || starting ? stop() : void start())}
        disabled={!config?.configured}
      >
        {snapshot.running || starting ? (
          <Square size={13} />
        ) : (
          <Play size={13} />
        )}
        {snapshot.running || starting ? 'Stop Director' : 'Start Director'}
      </button>
      <button
        className="quiet"
        aria-label={muted ? 'Unmute' : 'Mute'}
        onClick={toggleMute}
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
    </>
  );
  return (
    <main className={broadcast ? 'podcast broadcast-mode' : 'podcast'}>
      <header>
        <Link className="brand" href="/studio">
          <img className="brand-mark" src="/logo.png" alt="" />
          {show.name.toUpperCase()}
        </Link>
        <span className="strap">DIRECTOR / CONTINUOUS BROADCAST</span>
      </header>
      <div className="topline">
        <span className="eyebrow">HOURLY SESSION ROTATION</span>
        <span className="pill">
          <i />
          {snapshot.phase.toUpperCase()}
        </span>
      </div>
      {(error || snapshot.error || config?.configured === false) && (
        <div className="notice" role="alert">
          {error ||
            snapshot.error ||
            'Open the local producer server with FAL_KEY configured.'}
        </div>
      )}
      <div className="studio">
        <section className="broadcast">
          <div className="stage">
            <img src={cast.host.image} alt="Pepe at the podcast microphone" />
            <div ref={stage} style={{ position: 'absolute', inset: 0 }} />
            {!snapshot.activeId && (
              <div className="opening">
                <img className="opening-mark" src="/logo.png" alt={show.name} />
                <p className="eyebrow">OPEN MIC / NO FINAL EPISODE</p>
                <h1>{show.headline}</h1>
                <p>
                  {starting || snapshot.running
                    ? 'Connecting and preparing the opening…'
                    : 'A continuous conversation, carried into the next hour.'}
                </p>
                <div className="playback-controls">{controls}</div>
              </div>
            )}
            {broadcast && (
              <div
                className="broadcast-controls"
                role="toolbar"
                aria-label="Broadcast controls"
              >
                {controls}
              </div>
            )}
          </div>
          <div className="playbar">
            <span>
              <Radio size={14} />
              {snapshot.activeId
                ? `SESSION ${snapshot.activeId} / ${clock(snapshot.remainingSeconds)} LEFT`
                : 'DIRECTOR READY'}
            </span>
            <div className="playback-controls">{controls}</div>
          </div>
        </section>
        <aside>
          <p className="eyebrow">THE NEXT HOUR</p>
          <h2>Keep the room open.</h2>
          <p className="muted">
            The next session prepares before the current one ends. We switch
            during a quiet reaction when possible, with one voice track audible
            at a time.
          </p>
          <output className="statusline">
            {snapshot.candidateId
              ? `Preparing session ${snapshot.candidateId}.`
              : snapshot.running
                ? `${snapshot.bufferedSeconds}s of playback ready.`
                : 'Start to connect to fal Director.'}{' '}
            {snapshot.rotations > 0
              ? `${snapshot.rotations} handovers completed.`
              : ''}
          </output>
          <div className="producer-note">
            <span className="eyebrow">CURRENT EDITORIAL DIRECTION</span>
            <p>
              {brief?.title ?? 'Sourced crypto news and dated Solana stories.'}
            </p>
            {brief?.url && (
              <p>
                <a href={brief.url} target="_blank" rel="noreferrer">
                  Read source ↗
                </a>
              </p>
            )}
          </div>
          <div className="producer-note">
            <span className="eyebrow">PRODUCER NOTES</span>
            <p>
              Target: {Math.round((config?.sessionSeconds ?? 3600) / 60)}{' '}
              minutes per session. A shorter limit reported by fal takes
              precedence. Standby sessions also use fal credits.
            </p>
            <p>
              Director mode is experimental. Its live speech is generated by the
              model. Paid requests and verified clip audio run in the standard
              studio.
            </p>
            <p>
              <Link href="/studio">Open standard studio ↗</Link>
            </p>
          </div>
        </aside>
      </div>
      <footer>
        <span>AI-generated satire. Not financial advice. Powered by fal.</span>
      </footer>
    </main>
  );
}
