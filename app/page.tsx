'use client';
/* oxlint-disable next/no-img-element -- Canonical generated camera still, shown without an image optimizer. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  Mic,
  Radio,
  ArrowUpRight,
  Headphones,
  Square,
  Pause,
  Play,
  Volume2,
  VolumeX,
  Maximize,
  Download,
} from 'lucide-react';
import { Podcast } from '@/lib/engine';
import { createServices } from '@/lib/services';
import { Player } from '@/components/player';
import { Ticker } from '@/components/ticker';
import { Wire } from '@/components/wire';
import { FeedPanel } from '@/components/feed-panel';
import { ManualCommentSource } from '@/lib/chat';
import { cast, show, shotDuration } from '@/lib/show';
export default function Page() {
  const [engine] = useState(() => new Podcast(createServices()));
  const [chat] = useState(() => new ManualCommentSource());
  const state = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  const [text, setText] = useState('');
  const [muted, setMuted] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [uiError, setUiError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
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
          !!(data as { configured?: { xai?: boolean } }).configured?.xai,
        ),
      )
      .catch(() => {});
    chat.start((batch) => engine.ingestComments(batch));
    return () => {
      chat.stop();
      engine.dispose();
    };
  }, [engine, chat]);
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
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
                cues: s.cues,
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
  const ready = state.slots.filter((s) => s.status === 'ready');
  const buffered = ready.reduce((sum, s) => sum + (s.clip?.duration || 0), 0);
  const latestCue = state.cues.at(-1);
  function send(value: string) {
    engine.cue(value);
    setText('');
  }
  function exportEpisode() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            shots: state.history.map(({ url: _url, ...clip }) => clip),
            cues: state.cues,
            topics: state.topics,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${show.slug}-episode.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <main className="podcast">
      <header>
        <Link className="brand" href="/">
          <Mic />
          {show.name.toUpperCase()}
          <span className="edition">{show.edition}</span>
        </Link>
        <span className="strap">{show.strap}</span>
        <button className="quiet details-toggle" aria-expanded={showDetails} aria-controls="studio-details" onClick={() => setShowDetails(!showDetails)}>
          {showDetails ? 'Hide details' : 'Studio details'}
        </button>
        <span className="credit">Powered by fal</span>
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
      {(state.error || uiError || configured === false || state.slots.some(s=>s.status==='failed')) && (
        <div className="notice" role="alert">
          {uiError ||
            state.error ||
            (configured===false?'Add FAL_KEY to .dev.vars and restart the local server.':'Some buffered shots need retry.')}
          {(state.error || state.slots.some(s=>s.status==='failed')) && (
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
            />
            {!state.current && (
              <div className="opening">
                <Headphones size={30} />
                <p className="eyebrow">OPEN MIC / NO FINAL EPISODE</p>
                <h1>{show.headline}</h1>
                <p>
                  {state.phase === 'buffering'
                    ? `${ready.length} of 3 opening shots ready. Loading complete videos before we roll.`
                    : `${cast.host.name} and ${cast.guest.name} react to the news as it breaks. None of it is advice.`}
                </p>
                <button
                  className="primary"
                  disabled={!configured}
                  onClick={() => (running ? engine.stop() : engine.start())}
                >
                  {running ? 'Cancel warmup' : 'Tune in'}
                  <ArrowUpRight size={17} />
                </button>
                <small>
                  Tightly paced 5-7-second speaking turns. Three-shot startup buffer. Sound
                  on.
                </small>
              </div>
            )}
            {state.current && (
              <div className="stage-tools">
                <button
                  className="quiet"
                  title={muted ? 'Unmute' : 'Mute'}
                  onClick={() => setMuted(!muted)}
                >
                  {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
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
            {state.current && <Ticker topics={state.topics} cues={state.cues} />}
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
              {['playing', 'paused'].includes(state.phase) && (
                <button className="quiet" onClick={() => engine.pause()}>
                  {state.phase === 'paused' ? (
                    <Play size={13} />
                  ) : (
                    <Pause size={13} />
                  )}{' '}
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
            </div>
          </div>
          {showDetails && (
          <div id="studio-details">
          <div className="buffer">
            <span className="eyebrow">ON DECK</span>
            <div className="buffer-track">
              {Array.from({ length: 4 }, (_, i) => (
                <i
                  className={state.slots[i]?.status === 'ready' ? 'ready' : ''}
                  key={i}
                />
              ))}
            </div>
            <span>
              {buffered.toFixed(0)}s ready /{' '}
              {state.slots.filter((s) => s.status === 'rendering').length}{' '}
              rendering
            </span>
          </div>
          <div className="queue-list">
            {state.slots.map((s) => (
              <div className="queue-card" key={s.id}>
                SHOT {String(s.id + 1).padStart(3, '0')}
                <b>{cast[s.speaker].name}</b>
                {s.status === 'ready'
                  ? 'Ready to play'
                  : s.status === 'failed'
                    ? 'Needs retry'
                    : 'Generating dialogue video'}
              </div>
            ))}
          </div>
          <div className="metrics">
            <span>
              Startup{' '}
              <b>
                {state.initialMs
                  ? `${(state.initialMs / 1000).toFixed(1)}s`
                  : 'Pending'}
              </b>
            </span>
            <span>
              Last render{' '}
              <b>
                {state.current
                  ? `${(state.current.renderMs / 1000).toFixed(1)}s`
                  : 'Pending'}
              </b>
            </span>
            <span>
              Buffer underruns <b>{state.stalls}</b>
            </span>
          </div>
          <FeedPanel
            feed={state.feed}
            topics={state.topics}
            ranking={state.ranking}
            onToggleFeed={(enabled) => engine.setFeed(enabled)}
            onChat={(text) => chat.push(text)}
          />
          {state.history.length > 0 && (
            <div className="download-links">
              <button className="quiet" onClick={exportEpisode}>
                <Download size={13} /> Export episode manifest
              </button>
              {state.current && (
                <a
                  className="quiet"
                  href={state.current.rawUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Download size={13} /> Current clip
                </a>
              )}
            </div>
          )}
          </div>
          )}
        </section>
        <aside>
          <p className="eyebrow">THE FLOOR IS OPEN</p>
          <h2>Ask the wrong question.</h2>
          <p className="muted">
            Pick the next subject. They’ll find a deeply questionable way to get
            there.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send(text);
            }}
          >
            <textarea
              aria-label="Next topic"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={240}
              placeholder="Who actually reads the whitepaper?…"
              disabled={!running}
            />
            <button className="primary" disabled={!running || !text.trim()}>
              Send to the studio <ArrowUpRight size={16} />
            </button>
          </form>
          <Wire
            topics={state.topics}
            feed={state.feed}
            running={running}
            onPromote={(id) => engine.promoteTopic(id)}
            onDismiss={(id) => engine.dismissTopic(id)}
          />
          <output className="statusline">
            {state.writing
              ? 'Writing the next exchange…'
              : latestCue?.status === 'on-air'
                ? 'Your topic is on air.'
                : latestCue
                  ? `Topic ${latestCue.status}. Already-committed shots play first; roughly ${Math.ceil((state.current?.duration || 0) + state.slots.reduce((sum, s) => sum + (s.clip?.duration || shotDuration(s.text)), 0))}s or more.`
                  : 'Send a topic once the studio starts. Buffered dialogue keeps playing.'}
          </output>
          <div className="producer-note">
            <span className="eyebrow">THE ROOM</span>
            <p>
              {cast.host.name.toUpperCase()} / {cast.host.tag}
            </p>
            <p>
              {cast.guest.name.toUpperCase()} / {cast.guest.tag}
            </p>
            <p>
              Start fills three shots. Then we maintain up to four ahead. Pause
              stops new submissions; Stop ends the run. Generated shots use fal
              credits.
            </p>
          </div>
          {state.cues.length > 0 && (
            <div className="audience-log">
              <span className="eyebrow">PRODUCER NOTES</span>
              {state.cues
                .slice(-3)
                .reverse()
                .map((c) => (
                  <p key={c.id}>
                    {c.text}
                    <br />
                    <small>{c.status.toUpperCase()}</small>
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
        <span>MiniMax H3 Max Turbo / Image to video</span>
      </footer>
    </main>
  );
}
