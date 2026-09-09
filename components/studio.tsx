'use client';
/* oxlint-disable next/no-img-element -- Canonical generated camera still, shown without an image optimizer. */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Radio,
  ArrowUpRight,
  Square,
  Pause,
  Play,
  Volume2,
  VolumeX,
  Maximize,
} from 'lucide-react';
import {
  Podcast,
  bufferConfig,
  readySeconds,
  type Snapshot,
} from '@/lib/engine';
import { createServices } from '@/lib/services';
import { Player } from '@/components/player';
import { Ticker } from '@/components/ticker';
import { CoinCard } from '@/components/coin-card';
import { CoinBug } from '@/components/coin-bug';
import { PumpChatSource } from '@/lib/pumpchat';
import { ChatPanel } from '@/components/chat-panel';
import { ManualCommentSource } from '@/lib/chat';
import { cast, show } from '@/lib/show';
import { SponsorConsole, SponsorOnAir } from '@/components/sponsor-console';
/** The pause/resume and stop/start pair, shown on the broadcast overlay and the playbar. */
function Transport({
  engine,
  state,
  running,
}: {
  engine: Podcast;
  state: Snapshot;
  running: boolean;
}) {
  return (
    <>
      {['playing', 'paused'].includes(state.phase) && (
        <button className="quiet" onClick={() => engine.pause()}>
          {state.phase === 'paused' ? <Play size={13} /> : <Pause size={13} />}{' '}
          {state.phase === 'paused' ? 'Resume' : 'Pause'}
        </button>
      )}
      {running ? (
        <button className="quiet" onClick={() => engine.stop()}>
          <Square size={12} /> Stop
        </button>
      ) : (
        state.current && (
          <button className="quiet" onClick={() => engine.start()}>
            <Play size={13} /> New transmission
          </button>
        )
      )}
    </>
  );
}
/** The one mute toggle, shared by the stage tools and the broadcast overlay. */
function MuteButton({
  muted,
  onToggle,
}: {
  muted: boolean;
  onToggle: () => void;
}) {
  const label = muted ? 'Unmute' : 'Mute';
  return (
    <button
      className="quiet"
      title={label}
      aria-label={label}
      onClick={onToggle}
    >
      {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
    </button>
  );
}
/**
 * The producer console at /studio: the engine, the stage, the buffer and the aside.
 * `?broadcast=1` strips it down to the stage for an OBS browser source and
 * `?autostart=1` tunes in as soon as the local server reports a fal key.
 */
export function Studio() {
  const params = useSearchParams();
  const broadcast = params.get('broadcast') === '1';
  const autostart = params.get('autostart') === '1';
  // A hosted box has no operator sitting at the screen: everything drawn for one would only
  // reach the audience. The box reports errors through its own status instead.
  const hosted = params.get('hosted') === '1';
  const [engine] = useState(() => new Podcast(createServices()));
  const [chat] = useState(() => new ManualCommentSource());
  const state = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  const [muted, setMuted] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [uiError, setUiError] = useState('');
  // The engine owns the chart: one poll, and its copy is the one carrying the live viewer count.
  const mint = state.coin?.mint ?? null;
  // The pump.fun chat is read only once the coin exists; the constructor has no side effects.
  const pumpChat = useMemo(
    () => (mint ? new PumpChatSource(mint) : null),
    [mint],
  );
  // The snapshot changes many times a clip; the queued ids only move when the topics do.
  const queuedIds = useMemo(
    () =>
      new Set(
        state.topics
          .filter((t) => t.commentId && t.status !== 'dropped')
          .map((t) => t.commentId as string),
      ),
    [state.topics],
  );
  const stage = useRef<HTMLDivElement>(null);
  const autostarted = useRef(false);
  const running = ['buffering', 'playing', 'paused', 'waiting'].includes(
    state.phase,
  );
  useEffect(() => {
    fetch('/api/podcast')
      .then((r) => r.json())
      .then((data) =>
        setConfigured((data as { configured: boolean }).configured),
      )
      .catch(() => setUiError('Cannot reach the local server.'));
    fetch('/api/topics')
      .then((r) => r.json())
      .then((data) =>
        engine.setFeed(
          !!(data as { configured?: { feed?: boolean } }).configured?.feed,
        ),
      )
      .catch(() => {});
    // The chart is ambient: show it from the moment the console opens, not from Start.
    engine.readCoin();
    chat.start((batch) => engine.ingestComments(batch));
    return () => {
      chat.stop();
      engine.dispose();
    };
  }, [engine, chat]);
  useEffect(() => {
    if (!pumpChat) return;
    pumpChat.start((batch) => engine.ingestComments(batch));
    const unsubscribe = pumpChat.subscribe(() => {
      const { viewers } = pumpChat.getState();
      if (viewers !== null) engine.setViewers(viewers);
    });
    return () => {
      unsubscribe();
      pumpChat.stop();
    };
  }, [engine, pumpChat]);
  // OBS reloads its browser source at will; the leave-page prompt would only wedge it.
  useEffect(() => {
    if (!running || broadcast) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running, broadcast]);
  useEffect(() => {
    if (!broadcast) return;
    const classes = document.documentElement.classList;
    classes.add('broadcast-page');
    if (hosted) classes.add('hosted-page');
    return () => classes.remove('broadcast-page', 'hosted-page');
  }, [broadcast, hosted]);
  // A hosted broadcast box has no eyes. It reads the show's state off the document to decide
  // whether to keep streaming, reload a wedged page, or go off air. Broadcast view only.
  const { phase, aired, stalls, error } = state;
  const airClip = state.current ? String(state.current.id) : '';
  // Warmup can outlast any fixed deadline when takes are rejected and retried, so the box is
  // told how much footage exists rather than left to guess whether the show is stuck.
  const airBuffered = Math.floor(readySeconds(state.slots));
  useEffect(() => {
    if (!broadcast) return;
    const air = document.documentElement.dataset;
    air.airPhase = phase;
    air.airClip = airClip;
    air.airAired = String(aired);
    air.airStalls = String(stalls);
    air.airBuffered = String(airBuffered);
    air.airError = error;
    return () => {
      for (const key of [
        'airPhase',
        'airClip',
        'airAired',
        'airStalls',
        'airBuffered',
        'airError',
      ])
        delete air[key];
    };
  }, [broadcast, phase, airClip, aired, stalls, airBuffered, error]);
  // Tune in once, and only after the local server has confirmed a fal key.
  useEffect(() => {
    if (!autostart || configured !== true || autostarted.current) return;
    autostarted.current = true;
    if (!running) engine.start();
  }, [autostart, configured, running, engine]);
  useEffect(() => {
    const context = (
      document as unknown as {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options: { signal: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'podcast_read_episode',
            description: 'Read the on-air dialogue, buffer and audience cues.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            execute: async () => {
              const s = engine.getSnapshot();
              return {
                phase: s.phase,
                current: s.current
                  ? {
                      speaker: s.current.speaker,
                      text: s.current.text,
                      id: s.current.id,
                    }
                  : null,
                buffer: s.slots.map((x) => ({
                  id: x.id,
                  speaker: x.speaker,
                  status: x.status,
                })),
                requests: s.requests,
                topics: s.topics.map((t) => ({
                  id: t.id,
                  title: t.title,
                  source: t.source,
                  score: t.score,
                  status: t.status,
                })),
                feed: { status: s.feed.status, costUsd: s.feed.costUsd },
                stalls: s.stalls,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => lifecycle.abort();
  }, [engine]);
  const bufferedSeconds = airBuffered;
  return (
    <main className={broadcast ? 'podcast broadcast-mode' : 'podcast'}>
      <header>
        <Link className="brand" href="/studio">
          <img className="brand-mark" src="/logo.png" alt="" />
          {show.name.toUpperCase()}
          <span className="edition">{show.edition}</span>
        </Link>
        <span className="strap">{show.strap}</span>
      </header>
      <div className="topline">
        <span className="eyebrow">
          {show.kicker} / {cast.host.name.toUpperCase()} +{' '}
          {cast.guest.name.toUpperCase()}
        </span>
        <span className="pill">
          <i />
          {state.phase === 'playing'
            ? 'ON AIR'
            : state.phase === 'buffering'
              ? 'WARMING UP'
              : 'OPEN CHANNEL'}
        </span>
      </div>
      {(state.error ||
        uiError ||
        configured === false ||
        state.slots.some((s) => s.status === 'failed')) && (
        <div className="notice" role="alert">
          {uiError ||
            state.error ||
            (configured === false
              ? 'Add FAL_KEY to .dev.vars and restart the local server.'
              : 'Some buffered shots need retry.')}
          {(state.error || state.slots.some((s) => s.status === 'failed')) && (
            <button className="quiet" onClick={() => engine.retry()}>
              Retry existing jobs
            </button>
          )}
        </div>
      )}
      <div className="studio">
        <section className="broadcast">
          <div className="stage" ref={stage}>
            <img
              src={cast.host.image}
              alt={`${cast.host.name} at his podcast microphone`}
            />
            <Player
              state={state}
              muted={muted}
              onEnded={(id) => engine.clipEnded(id)}
              onShown={(id) => engine.shown(id)}
              onPlaybackFailure={(id, url, reason) =>
                engine.playbackFailed(id, url, reason)
              }
            />
            {!state.current && (
              <div className="opening">
                <img className="opening-mark" src="/logo.png" alt={show.name} />
                <p className="eyebrow">OPEN MIC / NO FINAL EPISODE</p>
                <h1>{show.headline}</h1>
                <p>
                  {state.phase === 'buffering' && !hosted
                    ? `${bufferedSeconds} of ${bufferConfig.startupSeconds} seconds ready. Building a reserve before we go live.`
                    : `${cast.host.name} and ${cast.guest.name} react to the news as it breaks. None of it is advice.`}
                </p>
                {/*
                  A hosted box is already streaming when the show rebuilds its reserve after a
                  reload, so this card is what the audience sees. It stays a title slate: no
                  buffer arithmetic, and no button nobody can press.
                */}
                {!hosted && (
                  <>
                    <button
                      className="primary"
                      disabled={!configured}
                      onClick={() => (running ? engine.stop() : engine.start())}
                    >
                      {running ? 'Cancel warmup' : 'Tune in'}
                      <ArrowUpRight size={17} />
                    </button>
                    <small>
                      {bufferConfig.startupSeconds} seconds of footage ready
                      before we go live. Sound on.
                    </small>
                  </>
                )}
              </div>
            )}
            {state.current && !broadcast && (
              <div className="stage-tools">
                <MuteButton muted={muted} onToggle={() => setMuted(!muted)} />
                <button
                  className="quiet"
                  title="Fullscreen"
                  onClick={() => {
                    void stage.current
                      ?.requestFullscreen()
                      .catch(() => setUiError('Fullscreen is unavailable.'));
                  }}
                >
                  <Maximize size={15} />
                </button>
              </div>
            )}
            {broadcast && (
              <div
                className="broadcast-controls"
                role="toolbar"
                aria-label="Broadcast controls"
              >
                <Transport engine={engine} state={state} running={running} />
                <MuteButton muted={muted} onToggle={() => setMuted(!muted)} />
              </div>
            )}
            {state.coin && <CoinBug coin={state.coin} />}
            <SponsorOnAir sponsor={state.current?.sponsorship} />
            {state.current && (
              <Ticker topics={state.topics} requests={state.requests} />
            )}
            {state.phase === 'waiting' && (
              <div className="loading">
                The next speaking turn is still rendering. Holding the last
                frame.
              </div>
            )}
          </div>
          <div className="playbar">
            <span>
              <Radio size={14} />
              {state.current
                ? `SHOT ${String(state.current.id + 1).padStart(3, '0')} / ${cast[state.current.speaker].name.toUpperCase()}`
                : 'NOT ON AIR YET'}
            </span>
            <div className="playback-controls">
              <Transport engine={engine} state={state} running={running} />
            </div>
          </div>
        </section>
        <aside>
          <SponsorConsole
            orders={state.sponsors}
            requests={state.requests}
            error={state.sponsorError}
            running={running}
          />
          <details className="sponsor-coin-disclosure">
            <summary>The coin chart</summary>
            <CoinCard
              coin={state.coin}
              launched={state.coinLaunched}
              error={state.coinError}
              ticker={show.ticker}
            />
          </details>
          {pumpChat && <ChatPanel source={pumpChat} queuedIds={queuedIds} />}
          <div className="producer-note">
            <p>
              <Link href="/studio/director">
                Try continuous Director mode ↗
              </Link>
            </p>
            <span className="eyebrow">THE ROOM</span>
            <p>
              {cast.host.name.toUpperCase()} / {cast.host.tag}
            </p>
            <p>
              {cast.guest.name.toUpperCase()} / {cast.guest.tag}
            </p>
            <p>
              Start prepares {bufferConfig.startupSeconds} seconds of footage.
              We then prepare up to {bufferConfig.targetSeconds} seconds ahead.
              Pause stops new submissions; Stop ends the run. Generated shots
              use fal credits.
            </p>
          </div>
          {state.requests.length > 0 && (
            <div className="audience-log">
              <span className="eyebrow">PAID REQUESTS</span>
              {state.requests
                .slice(-5)
                .reverse()
                .map((r) => (
                  <p key={r.id}>
                    <b>{r.from}</b>
                    {r.text}
                    <br />
                    <small>{r.status.toUpperCase()}</small>
                  </p>
                ))}
            </div>
          )}
        </aside>
      </div>
      <footer>
        <span>
          Meme characters used as parody. AI-generated satire, not financial
          advice. Powered by fal.
        </span>
      </footer>
    </main>
  );
}
