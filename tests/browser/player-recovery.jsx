import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Player } from '../../components/player';
const checks = [];
const check = (pass, message) => {
  checks.push({ pass: !!pass, message });
  if (!pass) throw Error(message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate) => {
  const end = performance.now() + 12000;
  while (!predicate()) {
    if (performance.now() > end) throw Error('Timed out');
    await wait(20);
  }
};
const root = createRoot(document.getElementById('root'));
const bytes = await (await fetch('./tone.mp4')).blob();
const urls = [];
const reports = [];
let state;
let mode = 'reject';
let resolvePlay;
// oxlint-disable-next-line typescript/unbound-method -- The spy restores the receiver with nativePause.call(this).
const nativePause = HTMLVideoElement.prototype.pause;
let pauses = 0;
HTMLVideoElement.prototype.pause = function () {
  pauses++;
  nativePause.call(this);
};
HTMLVideoElement.prototype.play = function () {
  if (mode === 'reject') return Promise.reject(Error('Autoplay blocked'));
  if (mode === 'deferred')
    return new Promise((resolve) => {
      resolvePlay = resolve;
    });
  return Promise.resolve();
};
const render = () =>
  flushSync(() =>
    root.render(
      <Player
        state={state}
        muted
        onEnded={() => {}}
        onShown={() => {}}
        onPlaybackFailure={(id, url, reason) => {
          reports.push({ id, url, reason });
          state = {
            ...state,
            current: null,
            previous: state.current,
            phase: 'waiting',
          };
          queueMicrotask(render);
          return true;
        }}
      />,
    ),
  );
const start = (id) => {
  const url = URL.createObjectURL(bytes);
  urls.push(url);
  state = {
    phase: 'playing',
    current: {
      id,
      url,
      rawUrl: '',
      speaker: 'host',
      text: 'A sponsored line.',
      duration: 0.6,
      speechEnd: 0.2,
      renderMs: 1,
      sponsorship: { orderId: 'order', leaseToken: 'lease' },
    },
    previous: null,
    slots: [],
  };
  render();
  return url;
};
window.playerChecks = (async () => {
  start(1);
  await until(() => reports.length === 1);
  await wait(40);
  check(
    !document.querySelector('button'),
    'A revoked sponsorship offers no play-again action',
  );
  mode = 'deferred';
  const url = start(2);
  await until(() => resolvePlay);
  const video = [...document.querySelectorAll('video')].find(
    (v) => v.src === url,
  );
  video.dispatchEvent(new Event('error'));
  await until(() => reports.length === 2);
  await wait(40);
  const before = pauses;
  resolvePlay();
  await wait(40);
  check(
    pauses > before,
    'A play promise resolving after revocation is stopped',
  );
  check(
    reports.filter((r) => r.id === 2).length === 1,
    'A failed clip reports its delivery interruption once',
  );
  mode = 'stall';
  start(3);
  await until(() => reports.some((r) => r.id === 3));
  check(
    reports.find((r) => r.id === 3).reason.includes('eight seconds'),
    'A clip with no media-time progress has a bounded recovery grace',
  );
  root.unmount();
  for (const value of urls) URL.revokeObjectURL(value);
  return checks;
})().catch((error) => ({ error: error.message, checks }));
window.playerChecks.then(
  (result) =>
    (document.getElementById('results').textContent = JSON.stringify(
      result,
      null,
      2,
    )),
);
