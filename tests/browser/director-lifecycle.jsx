import { LiveDirectorSession } from '/lib/director-live.ts';
const results = [];
const check = (name, ok) => {
  results.push({ name, ok });
  if (!ok) throw Error(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = new AudioContext();
await context.resume();
const master = context.createGain();
master.connect(context.destination);
const stage = document.querySelector('#stage');
const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 180;
const paint = canvas.getContext('2d');
paint.fillRect(0, 0, 320, 180);
const dest = context.createMediaStreamDestination();
const osc = context.createOscillator();
osc.connect(dest);
osc.start();
const stream = new MediaStream([
  ...canvas.captureStream(24).getTracks(),
  ...dest.stream.getAudioTracks(),
]);
let feed;
try {
  let options,
    finish,
    closeCalls = 0;
  const errors = [],
    sent = [],
    limits = [];
  const closing = new Promise((r) => {
    finish = r;
  });
  const lifecycle = new AbortController();
  feed = new LiveDirectorSession(
    1,
    stage,
    context,
    master,
    { limit: (s) => limits.push(s), ended: (e) => errors.push(e) },
    { prompt: 'Test', title: 'Test' },
    { next: async () => ({ prompt: 'Next', title: 'Next' }) },
    () => {},
    (o) => {
      options = o;
      return {
        send: (m) => sent.push(m),
        close: () => {
          closeCalls++;
          return closing;
        },
      };
    },
  );
  feed.open(lifecycle.signal);
  options.onState('live');
  options.onState('live');
  check(
    'configure is sent once after transport becomes live',
    sent.filter((m) => m.type === 'configure').length === 1,
  );
  options.onData(
    JSON.stringify({ type: 'session_info', max_session_seconds: 7200 }),
  );
  check(
    'actual extended entitlement reaches the rotation controller',
    limits[0] === 7200,
  );
  options.onMedia(stream);
  const track = stream.getAudioTracks()[0];
  Object.defineProperty(track, 'muted', { value: true, configurable: true });
  track.dispatchEvent(new Event('mute'));
  await sleep(500);
  Object.defineProperty(track, 'muted', { value: false, configurable: true });
  track.dispatchEvent(new Event('unmute'));
  await sleep(10000);
  check(
    'brief audio mute recovers without killing the session',
    errors.length === 0,
  );
  Object.defineProperty(track, 'muted', { value: true, configurable: true });
  track.dispatchEvent(new Event('mute'));
  await sleep(10100);
  check(
    'persistent audio-only outage is detected',
    errors.some((e) => e.includes('audio delivery stopped')),
  );
  lifecycle.abort();
  const first = feed.close();
  const second = feed.close();
  let closed = false;
  first.then(() => (closed = true));
  await sleep(0);
  check(
    'abort and repeated closes share the actual pending cleanup',
    first === second && !closed,
  );
  finish();
  await first;
  check(
    'close settles only after SDK cleanup',
    closed && stage.querySelectorAll('video').length === 0,
  );
  check(
    'stop after a failed stream does not send a new generation message',
    sent.every((m) => m.type === 'configure'),
  );
  window.__result = { ok: true, results };
} catch (e) {
  window.__result = { ok: false, error: String(e), results };
} finally {
  await feed?.close();
  osc.stop();
  await context.close();
}
document.querySelector('#result').textContent = JSON.stringify(
  window.__result,
  null,
  2,
);
