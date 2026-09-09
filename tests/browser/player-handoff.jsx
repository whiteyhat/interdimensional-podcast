// Run node tests/browser/serve.mjs, then open the printed URL.
// The decoder is controlled; React and the streaming engine are the real implementations.
import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '../../components/player';
import { Podcast } from '../../lib/engine';
const checks = [];
const frames = new Map();
const paints = new Map();
const fallback = new URLSearchParams(location.search).has('fallback');
let frameId = 0;
let denyPlayback = false;
const bytes = await (await fetch('./still.mp4')).blob();
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const check = (condition, message) => {
  checks.push({ message, pass: !!condition });
  if (!condition) throw Error(message);
};
HTMLVideoElement.prototype.play = function () {
  if (denyPlayback) return Promise.reject(Error('Autoplay blocked'));
  this.dispatchEvent(new Event('playing'));
  return Promise.resolve();
};
HTMLVideoElement.prototype.pause = function () {};
HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
  const id = ++frameId;
  frames.set(id, { video: this, callback });
  return id;
};
HTMLVideoElement.prototype.cancelVideoFrameCallback = (id) => frames.delete(id);
if (fallback) {
  HTMLVideoElement.prototype.requestVideoFrameCallback = undefined;
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    get: () => 2,
  });
  window.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    paints.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => paints.delete(id);
}
const render = async (line) => ({
  ...line,
  url: URL.createObjectURL(bytes),
  rawUrl: '',
  duration: 5,
  renderMs: 0,
});
const acknowledged = [];
const released = [];
const engine = new Podcast({
  render,
  write: async (_recent, start) =>
    Array.from({ length: 4 }, (_, i) => ({
      id: start + i,
      speaker: (start + i) % 2 ? 'guest' : 'host',
      text: 'Of course.',
    })),
  release: (url) => {
    released.push(url);
    URL.revokeObjectURL(url);
  },
});
function Harness() {
  const state = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  return (
    <Player
      state={state}
      muted
      onEnded={(id) => engine.clipEnded(id)}
      onShown={(id) => {
        const current = engine.getSnapshot().current;
        const video = [...document.querySelectorAll('video')].find(
          (v) => v.getAttribute('src') === current.url,
        );
        checks.push({
          message: 'The new video must be visible before acknowledging it',
          pass: video?.style.opacity === '1',
        });
        acknowledged.push(id);
        engine.shown(id);
      }}
    />
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
const visible = (url) =>
  [...document.querySelectorAll('video')].some(
    (v) => v.getAttribute('src') === url && v.style.opacity === '1',
  );
const present = (url) => {
  if (fallback) {
    for (let i = 0; i < 2; i++)
      for (const [id, callback] of [...paints]) {
        paints.delete(id);
        callback(performance.now());
      }
    return;
  }
  for (const [id, frame] of frames)
    if (frame.video.getAttribute('src') === url) {
      frames.delete(id);
      frame.callback(performance.now(), { mediaTime: 0, presentedFrames: 1 });
    }
};
window.playerChecks = (async () => {
  await tick();
  engine.start();
  await tick();
  const first = engine.getSnapshot().current;
  check(
    acknowledged.length === 0,
    'playing alone must not acknowledge a frame',
  );
  present(first.url);
  await tick();
  check(visible(first.url), 'The first presented video becomes visible');
  engine.clipEnded(first.id);
  await tick();
  const next = engine.getSnapshot().current;
  check(
    visible(first.url),
    'Keep the outgoing video while the next decoder is delayed',
  );
  check(
    !released.includes(first.url),
    'Keep the outgoing blob until its replacement is visible',
  );
  check(!visible(next.url), 'Do not reveal a video without a presented frame');
  const stale = [...frames.values()]
    .map((f) => f.callback)
    .concat([...paints.values()]);
  engine.pause();
  await tick();
  check(
    frames.size + paints.size === 0,
    'Pause cancels the pending presentation',
  );
  for (const callback of stale) callback(performance.now(), {});
  present(next.url);
  await tick();
  check(
    !visible(next.url),
    'A late callback cannot replace the frame while paused',
  );
  engine.pause();
  await tick();
  present(next.url);
  await tick();
  check(
    visible(next.url) && released.includes(first.url),
    'Reveal the replacement before releasing its predecessor',
  );
  check(acknowledged.length === 2, 'Each clip is acknowledged once');
  engine.pause();
  await tick();
  engine.pause();
  await tick();
  check(
    acknowledged.length === 2,
    'Resume does not repeat the acknowledgement',
  );
  engine.stop();
  engine.start();
  await tick();
  const restart = engine.getSnapshot().current;
  check(
    !visible(restart.url),
    'A reused clip id must not reveal a new transmission early',
  );
  present(restart.url);
  await tick();
  check(visible(restart.url), 'The new transmission waits for its own frame');
  denyPlayback = true;
  engine.clipEnded(restart.id);
  await tick();
  check(
    !!document.querySelector('button'),
    'Autoplay rejection offers a manual play control',
  );
  engine.pause();
  await tick();
  check(
    !document.querySelector('button'),
    'A paused engine must not offer a direct media play bypass',
  );
  denyPlayback = false;
  engine.pause();
  await tick();
  present(engine.getSnapshot().current.url);
  await tick();
  check(
    visible(engine.getSnapshot().current.url),
    'Resume after blocked autoplay rearms frame presentation',
  );
  engine.dispose();
  return checks;
})().catch((error) => ({ error: error.message, checks }));
window.playerChecks.then((result) => {
  document.getElementById('results').textContent = JSON.stringify(
    result,
    null,
    2,
  );
});
