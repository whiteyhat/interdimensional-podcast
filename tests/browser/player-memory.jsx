// The memory harness page: the real Player and the real streaming engine, fed short local
// clips as fresh blob URLs the way lib/services.ts render() makes them, released the way the
// engine releases them. player-memory.mjs drives it and samples the browser between clips.
// Query parameters (player-memory.mjs documents them and always sends them):
//   fixture, pad, hold, and noSource=1 to stub AudioContext.createMediaElementSource.
import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '../../components/player';
import { Podcast } from '../../lib/engine';

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') ?? 'bars.mp4';
const padMB = Number(params.get('pad') ?? 4);
const hold = Number(params.get('hold') ?? 300);
if (params.get('noSource') === '1') {
  AudioContext.prototype.createMediaElementSource = function () {
    return this.createGain();
  };
}
const contexts = new Set();
const NativeAudioContext = window.AudioContext;
window.AudioContext = class extends NativeAudioContext {
  constructor(...args) {
    super(...args);
    contexts.add(this);
  }
};
const outstanding = new Set();
const nativeCreate = URL.createObjectURL.bind(URL);
const nativeRevoke = URL.revokeObjectURL.bind(URL);
let created = 0;
let revoked = 0;
URL.createObjectURL = (blob) => {
  const url = nativeCreate(blob);
  outstanding.add(url);
  created++;
  return url;
};
URL.revokeObjectURL = (url) => {
  if (outstanding.delete(url)) revoked++;
  nativeRevoke(url);
};

// A name is a file next to this page; an absolute path is served through Vite's /@fs/.
const bytes = await (
  await fetch(fixture.startsWith('/') ? `/@fs${fixture}` : `./${fixture}`)
).arrayBuffer();
let pad;
if (padMB > 0) {
  const size = padMB * 1024 * 1024;
  pad = new Uint8Array(size);
  new DataView(pad.buffer).setUint32(0, size);
  pad.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
}
const texts = [
  'The chart is a staircase that only goes down and I am still holding the rail.',
  'You hold nothing. You hold the idea of holding, which is cheaper and much safer.',
  'My portfolio is a museum of things that were about to happen and then did not.',
  'A museum charges admission. Yours pays people to leave. That is the difference.',
  'I bought the dip, and then the dip bought a smaller dip, and now we are roommates.',
  'Roommates are fine. Roommates split the rent. Your dip does not split anything.',
];
const failures = [];
// Production takes are ten seconds and the reserve holds about a minute of them; the same
// ratio with two-second takes keeps the engine's slot count and release paths on their
// production schedule while the harness cuts many times faster than the show does.
const engine = new Podcast(
  {
    async render(line) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const blob = new Blob(pad ? [bytes, pad] : [bytes], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      // The same detached probe lib/services.ts uses to read the decoded duration.
      const duration = await new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const finish = (error) => {
          video.onloadeddata = null;
          video.onerror = null;
          const value = video.duration;
          video.removeAttribute('src');
          video.load();
          if (error) reject(error);
          else resolve(value);
        };
        video.muted = true;
        video.preload = 'auto';
        video.onloadeddata = () => finish();
        video.onerror = () => finish(Error('Generated video is not playable'));
        video.src = url;
        video.load();
      });
      return {
        ...line,
        url,
        rawUrl: '',
        duration,
        speechEnd: Math.min(1, duration),
        renderMs: 0,
      };
    },
    async write(_recent, start) {
      return Array.from({ length: 4 }, (_, i) => ({
        id: start + i,
        speaker: (start + i) % 2 ? 'guest' : 'host',
        text: texts[(start + i) % texts.length],
      }));
    },
    release: (url) => URL.revokeObjectURL(url),
  },
  {
    startupSeconds: 6,
    targetSeconds: 12,
    recoverySeconds: 4,
    concurrency: 3,
    maxSlots: 8,
  },
);
function Harness() {
  const state = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  return (
    <Player
      state={state}
      muted={false}
      onEnded={(id) => engine.clipEnded(id)}
      onShown={(id) => engine.shown(id)}
      onPlaybackFailure={(id, url, reason) => {
        failures.push({ id, reason });
        return engine.playbackFailed(id, url, reason);
      }}
    />
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeout = 20000) => {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > end)
      throw Error(`Timed out: ${JSON.stringify(window.memoryHarness.stats())}`);
    await wait(10);
  }
};
const visible = (url) =>
  [...document.querySelectorAll('video')].some(
    (v) => v.getAttribute('src') === url && v.style.opacity === '1',
  );
// The most clips the show held at once (previous, current and ready slots): the pool's bound.
let maxHeld = 0;
const held = () => {
  const snapshot = engine.getSnapshot();
  return new Set(
    [snapshot.previous, snapshot.current, ...snapshot.slots.map((s) => s.clip)]
      .filter(Boolean)
      .map((clip) => clip.url),
  ).size;
};
engine.subscribe(() => {
  maxHeld = Math.max(maxHeld, held());
});
window.memoryHarness = {
  start() {
    engine.start();
  },
  /** Airs one take: wait for its frame, hold it, end it, wait for the cut. */
  async step() {
    await until(() => {
      const snapshot = engine.getSnapshot();
      return snapshot.phase === 'playing' && snapshot.current;
    });
    const current = engine.getSnapshot().current;
    await until(() => visible(current.url));
    if (hold > 0) {
      await wait(hold);
      engine.clipEnded(current.id);
    }
    await until(() => engine.getSnapshot().current?.url !== current.url, 40000);
    return current.id;
  },
  stats() {
    const snapshot = engine.getSnapshot();
    return {
      aired: snapshot.aired,
      phase: snapshot.phase,
      slots: snapshot.slots.length,
      history: snapshot.history.length,
      created,
      revoked,
      outstanding: outstanding.size,
      domVideos: document.querySelectorAll('video').length,
      maxHeld,
      audio: [...contexts].map((c) => c.state).join(','),
      failures: failures.length,
    };
  },
};
document.getElementById('results').textContent = 'Harness ready.';
