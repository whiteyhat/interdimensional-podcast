import { DirectorMedia } from '/lib/director-media.ts';
// Model a remote stream whose first jointly playable audio/video timestamp is nonzero.
if (new URLSearchParams(location.search).has('offset')) {
  const NativeMediaSource = MediaSource;
  globalThis.MediaSource = class extends NativeMediaSource {
    addSourceBuffer(mime) {
      const buffer = super.addSourceBuffer(mime);
      buffer.timestampOffset = 0.4;
      return buffer;
    }
  };
}
const results = [];
const check = (name, ok) => {
  results.push({ name, ok });
  if (!ok) throw Error(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 25000) => {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw Error('Timed out');
    await wait(50);
  }
};
const stage = document.querySelector('#stage');
const context = new AudioContext();
const master = context.createGain();
master.connect(context.destination);
const tone = document.createElement('video');
tone.src = '/tests/browser/tone.mp4';
tone.loop = true;
tone.muted = true;
let a, b;
try {
  await context.resume();
  await tone.play();
  // Real canvas motion + an oscillator are recorded and decoded through MediaSource.
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext('2d');
  let frame = 0;
  const drawing = setInterval(() => {
    paint.fillStyle = frame++ % 2 ? '#386840' : '#d58761';
    paint.fillRect(0, 0, 320, 180);
  }, 40);
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();
  const makeStream = () =>
    new MediaStream([
      ...canvas.captureStream(24).getVideoTracks(),
      ...destination.stream.getAudioTracks().map((t) => t.clone()),
    ]);
  const errors = [];
  a = new DirectorMedia(stage, context, master, (e) => errors.push(String(e)));
  b = new DirectorMedia(stage, context, master, (e) => errors.push(String(e)));
  const peers = [];
  if (document.documentElement.dataset.webrtc === 'true') {
    async function remote() {
      const sender = new RTCPeerConnection(),
        receiver = new RTCPeerConnection();
      peers.push(sender, receiver);
      sender.onicecandidate = (e) => {
        if (e.candidate) void receiver.addIceCandidate(e.candidate);
      };
      receiver.onicecandidate = (e) => {
        if (e.candidate) void sender.addIceCandidate(e.candidate);
      };
      const received = new MediaStream();
      receiver.ontrack = (e) => received.addTrack(e.track);
      const input = makeStream();
      input.getTracks().forEach((t) => sender.addTrack(t, input));
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription);
      await until(() => received.getTracks().length === 2);
      return received;
    }
    a.ingest(await remote());
    b.ingest(await remote());
    await until(() => peers.every((p) => p.connectionState === 'connected'));
    check(
      'loopback peers actually connected before testing recording',
      peers.every((p) => p.connectionState === 'connected'),
    );
  } else {
    a.ingest(makeStream());
    b.ingest(makeStream());
  }

  await until(() => a.ready() && b.ready());
  check(
    'both buffered openings decode while silent and paused',
    a.video.paused &&
      b.video.paused &&
      a.gain.gain.value === 0 &&
      b.gain.gain.value === 0,
  );
  check(
    'standby retains the beginning',
    b.video.currentTime - b.video.buffered.start(0) < 0.1 && b.buffered() >= 8,
  );
  await a.take(undefined, () => true);
  await wait(500);
  check(
    'first deck plays with sound',
    !a.video.paused && a.gain.gain.value > 0.9,
  );
  check('tone is not mistaken for a quiet boundary', !a.quiet());
  let overlap = false,
    quietAt = 0,
    silentMs = 0;
  const monitor = setInterval(() => {
    if (a.gain.gain.value > 0.001 && b.gain.gain.value > 0.001) overlap = true;
    if (a.gain.gain.value < 0.001 && b.gain.gain.value < 0.001)
      quietAt ||= performance.now();
    else if (quietAt) {
      silentMs = Math.max(silentMs, performance.now() - quietAt);
      quietAt = 0;
    }
  }, 1);
  await b.take(a, () => true);
  await wait(300);
  clearInterval(monitor);
  check(
    'exclusive handover has no simultaneous audible gains',
    !overlap && a.gain.gain.value === 0 && b.gain.gain.value > 0.9,
  );
  check(
    'retired video is paused and replacement begins at its opening',
    a.video.paused && b.video.currentTime - b.video.buffered.start(0) < 1,
  );
  check(
    'audio transfer leaves less than 200 milliseconds of silence',
    silentMs < 200,
  );
  const position = b.video.currentTime;
  await a.take(b, () => false).catch(() => {});
  check(
    'cancelled handover leaves the active output alone',
    !b.video.paused &&
      b.gain.gain.value > 0.9 &&
      b.video.currentTime >= position,
  );
  a.close();
  b.close();
  check(
    'close removes media elements and recording resources',
    stage.querySelectorAll('video').length === 0,
  );
  check('no recording or decode errors', errors.length === 0);
  peers.forEach((p) => p.close());
  clearInterval(drawing);
  oscillator.stop();
  tone.pause();
  await context.close();
  window.__result = { ok: true, results };
} catch (e) {
  a?.close();
  b?.close();
  window.__result = { ok: false, error: String(e), results };
}
document.querySelector('#result').textContent = JSON.stringify(
  window.__result,
  null,
  2,
);
