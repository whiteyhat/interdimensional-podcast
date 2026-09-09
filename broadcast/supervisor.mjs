// The broadcast box. What OBS and a MacBook did, in a container that nobody has to watch.
//
//   POST /air/on       go on air (optional {"minutes": 720})
//   POST /air/off      go off air
//   GET  /air/status   what the box is doing, and what the show is doing
//   GET  /air/frame.jpg  the picture currently going out
//   GET  /air/health   for the platform's health check; no token, no detail
//
// Every route except /air/health requires the shared STUDIO_TOKEN. While on air the box owns
// five processes, in this order: a virtual screen, a virtual speaker, the studio worker, a
// real Chrome on that screen, and ffmpeg pushing the screen and the speaker to Cloudflare.
//
// The rules it enforces live in ./air-policy.mjs, where they can be tested without any of this.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import {
  airDefaults,
  extend,
  ffmpegDelay,
  isOnAirPhase,
  readMinutes,
  renderDevVars,
  reloaded,
  startAir,
  step,
} from './air-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WRANGLER_CONFIG = path.join(ROOT, 'dist/server/wrangler.json');
const STUDIO_VARS = path.join(ROOT, 'dist/server/.dev.vars');
const DISPLAY = process.env.AIR_DISPLAY || ':99';
const SINK = 'studio';
const STUDIO_PORT = Number(process.env.AIR_STUDIO_PORT || 3212);
const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}`;
const BROADCAST_PATH = '/studio?broadcast=1&autostart=1&hosted=1';
const HEIGHT = Number(process.env.AIR_HEIGHT || 1080);
const WIDTH = Math.round((HEIGHT * 16) / 9 / 2) * 2;
const FPS = Number(process.env.AIR_FPS || 30);
const BITRATE = process.env.AIR_BITRATE || (HEIGHT >= 1080 ? '4500k' : '2800k');
const TOKEN = (process.env.STUDIO_TOKEN || '').trim();
/** The watchdog's clocks, overridable so a rehearsal can exercise them in seconds. */
const POLICY = {
  ...airDefaults,
  ...(process.env.AIR_READY_TIMEOUT_MS ? { readyTimeoutMs: Number(process.env.AIR_READY_TIMEOUT_MS) } : {}),
  ...(process.env.AIR_STALL_MS ? { stallMs: Number(process.env.AIR_STALL_MS) } : {}),
  ...(process.env.AIR_POLL_MS ? { pollMs: Number(process.env.AIR_POLL_MS) } : {}),
};
const RTMP = `${process.env.RTMP_URL || ''}${process.env.RTMP_KEY || ''}`;

const log = (...parts) => console.log(`[air ${new Date().toISOString()}]`, ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- processes -------------------------------------------------------------------------

const running = new Map();
/** Spawn a long-lived child, remembering it by name so only one of each can ever exist. */
function start(name, command, args, options = {}) {
  if (running.has(name)) throw Error(`${name} is already running`);
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    ...options,
    env: { ...process.env, DISPLAY, PULSE_SINK: SINK, ...options.env },
  });
  const tail = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (!text) return;
      tail.push(text);
      if (tail.length > 20) tail.shift();
      if (process.env.AIR_VERBOSE === '1' || name !== 'ffmpeg') log(`${name}:`, text.slice(0, 400));
    });
  const record = { child, tail, exited: false, code: null };
  /**
   * Retire this record, and only this record. A child abandoned by stop() can exit long after
   * its replacement is running, and deleting by name alone would unregister the replacement —
   * after which isRunning() lies and a second encoder gets spawned onto the same stream key.
   */
  const retire = (code, why) => {
    if (record.exited) return;
    record.exited = true;
    record.code = code;
    if (running.get(name) === record) running.delete(name);
    log(`${name} ${why} (${code})`);
    record.onExit?.(code);
  };
  child.on('exit', (code, signal) => retire(code ?? signal, 'exited'));
  // Without retiring the record here it would stay in `running` for good, isRunning() would lie,
  // and start() would refuse to ever launch this piece again after one transient spawn failure.
  child.on('error', (e) => {
    log(`${name} failed to start:`, e.message);
    retire(e.code ?? 'spawn-failed', 'failed to start');
  });
  running.set(name, record);
  return record;
}
/** Ask a child to leave, then insist. Never returns while the process is still alive. */
async function stop(name, signal = 'SIGTERM') {
  const record = running.get(name);
  if (!record) return;
  record.onExit = undefined;
  record.child.kill(signal);
  const deadline = Date.now() + 8000;
  while (!record.exited && Date.now() < deadline) await sleep(100);
  if (!record.exited) record.child.kill('SIGKILL');
  // A process that ignores SIGKILL (uninterruptible I/O) must not hold the box on air. Let go
  // of it: going off air matters more than tidiness, and the container teardown collects it.
  const hard = Date.now() + 5000;
  while (!record.exited && Date.now() < hard) await sleep(50);
  if (!record.exited) {
    record.onExit = undefined;
    if (running.get(name) === record) running.delete(name);
    log(`${name} did not exit; abandoning it`);
  }
}
const isRunning = (name) => running.has(name);

/** Wait for `check` to pass, or explain what we were waiting for. */
async function waitFor(what, check, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(everyMs);
  }
  throw Error(`Timed out waiting for ${what}`);
}

// ---- the pieces of a broadcast ----------------------------------------------------------

async function startDisplay() {
  if (isRunning('xvfb')) return;
  start('xvfb', 'Xvfb', [DISPLAY, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-noreset']);
  await waitFor('the virtual screen', async () => {
    const probe = spawn('xdpyinfo', ['-display', DISPLAY], { stdio: 'ignore' });
    const [code] = await once(probe, 'exit');
    return code === 0;
  }, 15_000);
  log(`screen ${WIDTH}x${HEIGHT} on ${DISPLAY}`);
}

async function startAudio() {
  if (isRunning('pulse')) return;
  // A null sink is a speaker nobody listens to; its monitor is what ffmpeg records. Chrome is
  // pointed at it with PULSE_SINK, so the show's audio has somewhere real to go.
  start('pulse', 'pulseaudio', [
    '-n',
    '--exit-idle-time=-1',
    '--disallow-exit',
    '--disable-shm=true',
    '--log-target=stderr',
    '--load=module-native-protocol-unix',
    `--load=module-null-sink sink_name=${SINK} sink_properties=device.description=Studio`,
  ]);
  await waitFor('the virtual speaker', async () => {
    const probe = spawn('pactl', ['list', 'short', 'sinks'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (c) => (out += c));
    const [code] = await once(probe, 'exit');
    return code === 0 && out.includes(SINK);
  }, 15_000);
  log(`speaker ${SINK} ready`);
}

/**
 * The studio worker: the same build the public site runs, served on loopback with the
 * operator's variables. It has to be loopback, because the studio's queue proxy and the chart
 * rehearsal both refuse to serve anything else.
 */
async function startWorker() {
  if (isRunning('worker')) return;
  const vars = renderDevVars(process.env);
  if (!vars.includes('FAL_KEY=')) throw Error('FAL_KEY is not set on this box; there is nothing to generate.');
  await mkdir(path.dirname(STUDIO_VARS), { recursive: true });
  await writeFile(STUDIO_VARS, vars, { mode: 0o600 });
  // The generated config asks for container support, which would send wrangler looking for a
  // Docker daemon this image does not have.
  const config = JSON.parse(await readFile(WRANGLER_CONFIG, 'utf8'));
  if (config.dev?.enable_containers) {
    config.dev.enable_containers = false;
    await writeFile(WRANGLER_CONFIG, JSON.stringify(config));
  }
  start('worker', path.join(ROOT, 'node_modules/.bin/wrangler'), [
    'dev',
    '--config', WRANGLER_CONFIG,
    '--ip', '127.0.0.1',
    '--port', String(STUDIO_PORT),
    '--local',
    '--log-level', 'warn',
    '--show-interactive-dev-session=false',
  ], { env: { CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  await waitFor('the studio worker', async () => {
    const response = await fetch(`${STUDIO_URL}/api/podcast`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return body?.configured === true;
  }, 180_000);
  log('studio worker configured');
}

let browser = null;
let page = null;
/** The region of the screen the page actually occupies, measured rather than assumed. */
let stage = { width: WIDTH, height: HEIGHT };
// `page` is only assigned after several awaits, so testing it is not a lock: two overlapping
// callers would both launch Chrome, and two browsers on one screen means two shows and two bills.
let browserWork = null;
function startBrowser(epoch = air.epoch) {
  browserWork = (browserWork ?? Promise.resolve()).then(() => {
    // By the time this runs the broadcast may be over. Launching Chrome then would leave one
    // running for the life of the box, and leave `page` set so the next broadcast skips its own.
    if (epoch !== air.epoch || page) return undefined;
    return launchBrowser();
  });
  return browserWork;
}
function stopBrowser() {
  browserWork = (browserWork ?? Promise.resolve()).then(closeBrowser, closeBrowser);
  return browserWork;
}
async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  // A persistent context, not launch(): only the window Chrome opens for itself obeys --kiosk.
  // A window Playwright opens afterwards keeps its toolbar, which would be broadcast.
  browser = await chromium.launchPersistentContext('/tmp/air-profile', {
    channel: 'chrome',
    headless: false,
    viewport: null,
    // Muting the tab would mute the show: the audio the encoder records is Chrome's own output.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      // A container has no user namespaces for Chrome's sandbox to use. The browser runs as an
      // unprivileged user and only ever loads this box's own loopback page, which is the trade.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--kiosk',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--window-position=0,0',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    env: { ...process.env, DISPLAY, PULSE_SINK: SINK },
  });
  page = browser.pages()[0] ?? (await browser.newPage());
  page.on('console', (m) => m.type() === 'error' && log('page error:', m.text().slice(0, 300)));
  page.on('pageerror', (e) => log('page crash:', String(e).slice(0, 300)));
  // The studio streams its document and never stops, so a load event would never arrive.
  // Commit is the honest signal here; whether the show is actually on air is the watchdog's job.
  await page.goto(`${STUDIO_URL}${BROADCAST_PATH}`, { waitUntil: 'commit', timeout: 60_000 });
  stage = await measureStage();
  log(`browser on the studio, drawing ${stage.width}x${stage.height}`);
}

/**
 * What Chrome ended up giving the page. A kiosk window on a bare X server lands a pixel or two
 * short of the screen, and encoding the screen instead of the page would put a black edge on
 * air, so the encoder is told what the page really occupies and scales it to the target size.
 */
async function measureStage() {
  const measured = await page
    .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    .catch(() => null);
  if (!measured?.width || !measured.height) return { width: WIDTH, height: HEIGHT };
  // x11grab needs an even-sized region, and so does yuv420p.
  return { width: measured.width - (measured.width % 2), height: measured.height - (measured.height % 2) };
}
async function closeBrowser() {
  const closing = browser;
  browser = null;
  page = null;
  await closing?.close().catch(() => {});
  // Chrome keeps a lock on its profile; a restart with the old one still held would fail.
  await rm('/tmp/air-profile', { recursive: true, force: true }).catch(() => {});
}

/** What the page says about itself, mirrored onto the document by the broadcast view. */
async function readPage() {
  if (!page) return { alive: false };
  try {
    const asked = page.evaluate(() => {
      const air = document.documentElement.dataset;
      return {
        phase: air.airPhase ?? null,
        clip: air.airClip ?? null,
        aired: Number(air.airAired ?? 0),
        stalls: Number(air.airStalls ?? 0),
        buffered: Number(air.airBuffered ?? 0),
        error: air.airError ?? '',
      };
    });
    const data = await Promise.race([
      asked,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('the page did not answer')), Math.min(10_000, POLICY.pollMs)),
      ),
    ]);
    return { alive: true, ...data };
  } catch (e) {
    return { alive: false, error: '', reason: String(e).slice(0, 200) };
  }
}

let ffmpegFailures = 0;
function startEncoder() {
  // An encoder started after the broadcast ended cannot be stopped by anything: offAir has
  // already run, and it would push the abandoned screen to Cloudflare for good.
  if (air.status !== 'on' || isRunning('ffmpeg') || !RTMP) return;
  const startedAt = Date.now();
  const record = start('ffmpeg', 'ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-f', 'x11grab', '-framerate', String(FPS), '-video_size', `${stage.width}x${stage.height}`,
    '-draw_mouse', '0', '-i', `${DISPLAY}.0+0,0`,
    '-f', 'pulse', '-i', `${SINK}.monitor`,
    // Only resample when the page did not land exactly on the target; usually it is a pixel or two.
    ...(stage.width === WIDTH && stage.height === HEIGHT
      ? []
      : ['-vf', `scale=${WIDTH}:${HEIGHT}:flags=bicubic`]),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', `${parseInt(BITRATE, 10) * 2}k`,
    // Closed two-second GOPs: what Cloudflare Stream requires of an ingest.
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1',
    '-f', 'flv', RTMP,
  ]);
  // Cloudflare holds the same live video across a short reconnect, so a restart is invisible.
  record.onExit = async () => {
    if (air.status !== 'on') return;
    // A minute of clean encoding means whatever went wrong is behind us, not escalating.
    if (Date.now() - startedAt > 60_000) ffmpegFailures = 0;
    const delay = ffmpegDelay(++ffmpegFailures);
    if (ffmpegFailures > 10) {
      log(`encoder failed ${ffmpegFailures} times in a row; last output:\n${record.tail.join('\n')}`);
      await goOffAir('the encoder could not keep a connection');
      return;
    }
    log(`encoder restarting in ${delay}ms (failure ${ffmpegFailures})`);
    await sleep(delay);
    if (air.status === 'on') startEncoder();
  };
  log(`encoder pushing ${WIDTH}x${HEIGHT}@${FPS} at ${BITRATE}`);
}

// ---- going on and off air ---------------------------------------------------------------

const air = {
  /** Bumped by every transition. Async work compares it to know whether it is still wanted. */
  epoch: 0,
  status: 'off',
  since: null,
  until: null,
  reason: 'the box has not been asked to go on air yet',
  policy: null,
  show: { phase: null, clip: null, aired: 0, stalls: 0, buffered: 0, error: '' },
  reloads: 0,
};

async function alert(text) {
  const url = process.env.AIR_ALERT_WEBHOOK;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, text }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

let watchdog = null;
let capTimer = null;
/** The money stop, on its own timer. Nothing the page or the watchdog does can defer it. */
function armCap() {
  clearTimeout(capTimer);
  if (!air.policy) return;
  const left = Math.max(0, air.policy.deadlineAt - Date.now());
  capTimer = setTimeout(() => void goOffAir('the scheduled end of the broadcast'), left);
  if (capTimer.unref) capTimer.unref();
}

// One transition at a time. An `air off` racing an `air on` otherwise interleaves their
// ladders, and both end up half-owning the same processes.
let transition = Promise.resolve();
function serialise(work) {
  const next = transition.then(work, work);
  transition = next.then(
    () => {},
    () => {},
  );
  return next;
}

const goOnAir = (minutes) => serialise(() => onAir(minutes));
const goOffAir = (reason) => serialise(() => offAir(reason));

async function onAir(minutes) {
  // Generation costs the same whether or not anyone can see it.
  if (!RTMP && process.env.AIR_ALLOW_NO_STREAM !== '1')
    throw Error('No RTMP destination is configured, so going on air would generate a show nobody can watch.');
  if (air.status === 'on' || air.status === 'starting') {
    if (air.policy) {
      air.policy = extend(air.policy, minutes, Date.now());
      air.until = air.policy.deadlineAt;
      armCap();
      log(`broadcast extended to ${new Date(air.until).toISOString()}`);
    }
    return { ok: true, already: true };
  }
  air.status = 'starting';
  air.reason = 'starting up';
  air.since = Date.now();
  ffmpegFailures = 0;
  try {
    await startDisplay();
    await startAudio();
    await startWorker();
    await startBrowser();
    air.policy = startAir({ now: Date.now(), minutes, config: POLICY });
    air.until = air.policy.deadlineAt;
    air.status = 'on';
    air.epoch++;
    air.reason = 'warming up';
    armCap();
    watchdog ??= setInterval(() => void tick(), POLICY.pollMs);
    await alert(`On air. Warming up; the first frame is about 90 seconds away. Ends ${new Date(air.until).toISOString()}.`);
    return { ok: true };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    log('failed to go on air:', why);
    // offAir, not goOffAir: this runs inside the transition, and queueing behind ourselves
    // would deadlock the box in "starting" with every process still up.
    await offAir(`could not go on air: ${why}`);
    throw e;
  }
}

async function offAir(reason) {
  // Even when already off, reap a stray encoder: a tick that was in flight during the last
  // shutdown could have started one, and nothing else would ever stop it.
  if (air.status === 'off') {
    await stop('ffmpeg');
    return { ok: true, already: true };
  }
  air.status = 'stopping';
  air.epoch++;
  clearInterval(watchdog);
  watchdog = null;
  clearTimeout(capTimer);
  capTimer = null;
  // Deliberately NOT waiting for an in-flight watchdog turn. offAir is usually called *from*
  // one, so waiting would be waiting for ourselves — that deadlocked the box in "stopping"
  // with the encoder still up. The epoch bumped just above is what makes a stale turn harmless:
  // it returns at its next checkpoint, and startEncoder refuses to run unless we are on air.
  // The encoder goes first: better a clean end of stream than a frozen last frame.
  await stop('ffmpeg');
  await stopBrowser();
  await stop('worker');
  air.status = 'off';
  air.policy = null;
  air.since = null;
  air.until = null;
  air.reason = reason;
  air.reloads = 0;
  ffmpegFailures = 0;
  air.show = { phase: null, clip: null, aired: 0, stalls: 0, buffered: 0, error: '' };
  log(`off air: ${reason}`);
  await alert(`Off air: ${reason}.`);
  return { ok: true };
}

/** One turn of the watchdog: look at the page, then do what the policy says. */
let tickWork = null;
function tick() {
  if (tickWork || air.status !== 'on' || !air.policy) return tickWork;
  tickWork = watch()
    .catch((e) => log('watchdog error:', e instanceof Error ? e.message : e))
    .finally(() => {
      tickWork = null;
    });
  return tickWork;
}
async function watch() {
  // Everything below awaits, and a broadcast can end during any of them. Work from a finished
  // broadcast must not touch the next one — or, worse, start an encoder nothing can stop.
  const epoch = air.epoch;
  const current = () => air.epoch === epoch && air.status === 'on' && air.policy;

  // The page cannot be healthy if what serves it is gone, and nothing else would notice.
  for (const piece of ['worker', 'xvfb', 'pulse'])
    if (!isRunning(piece)) {
      await goOffAir(`the ${piece} process died`);
      return;
    }
  const observation = await readPage();
  if (!current()) return;
  air.show = {
    phase: observation.phase ?? null,
    clip: observation.clip ?? null,
    aired: observation.aired ?? air.show.aired,
    stalls: observation.stalls ?? air.show.stalls,
    buffered: observation.buffered ?? air.show.buffered,
    error: observation.error ?? '',
  };
  const { state, action, reason } = step(air.policy, { now: Date.now(), ...observation });
  air.policy = state;
  air.reason = reason;
  // Only start the encoder once there is a show to encode; a poster is not worth broadcasting.
  if (action === 'ok' && state.ready && isOnAirPhase(observation.phase)) startEncoder();
  if (action === 'reload') {
    // The encoder keeps running across a reload on purpose: the hosted view falls back to a
    // title slate, which is a better thing to broadcast than a ten-second gap that ends the
    // live video and drops every viewer's player.
    log(`reloading the studio: ${reason}`);
    await alert(`Reloading the studio: ${reason}. Back in about 90 seconds.`);
    if (!current()) return;
    try {
      await page.reload({ waitUntil: 'commit', timeout: 60_000 });
      stage = await measureStage();
    } catch (e) {
      log('reload failed, restarting the browser:', e instanceof Error ? e.message : e);
      await stopBrowser();
      if (!current()) return;
      await startBrowser(epoch).catch(() => {});
    }
    if (!current()) return;
    air.policy = reloaded(air.policy, Date.now());
    air.reloads = air.policy.reloads;
  }
  if (action === 'off') await goOffAir(reason);
}

// ---- the control API ---------------------------------------------------------------------

/** Constant-time enough for a shared secret: only the length can leak. */
function sameToken(given, expected) {
  if (!expected) return false;
  let diff = given.length ^ expected.length;
  for (let i = 0; i < Math.max(given.length, expected.length); i++)
    diff |= (given.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};
/**
 * What the box is using, Chrome and ffmpeg included. The Node process's own resident set is a
 * small fraction of it, and reporting that number would make a box near its memory limit look
 * idle.
 */
function containerMemoryMb() {
  for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'])
    try {
      return Math.round(Number(readFileSync(file, 'utf8').trim()) / 1e6);
    } catch {
      // Not a cgroup v2 host, or not a container: fall back to what we can measure.
    }
  return Math.round(process.memoryUsage.rss() / 1e6);
}

function statusBody() {
  return {
    status: air.status,
    reason: air.reason,
    onAirSince: air.since,
    endsAt: air.until,
    minutesLeft: air.until ? Math.max(0, Math.round((air.until - Date.now()) / 60_000)) : null,
    show: air.show,
    reloads: air.reloads,
    encoder: isRunning('ffmpeg') ? 'running' : 'stopped',
    encoderRestarts: ffmpegFailures,
    worker: isRunning('worker') ? 'running' : 'stopped',
    video: `${WIDTH}x${HEIGHT}@${FPS}`,
    studioId: process.env.STUDIO_ID || 'unset',
    memoryMb: containerMemoryMb(),
    uptimeSeconds: Math.round(process.uptime()),
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://box');
  try {
    if (url.pathname === '/air/health')
      return json(response, { ok: true, status: air.status, uptimeSeconds: Math.round(process.uptime()) });
    if (!sameToken((request.headers['x-studio-token'] || '').trim(), TOKEN))
      return json(response, { error: 'Studio token rejected.' }, 401);
    if (url.pathname === '/air/status') return json(response, statusBody());
    if (url.pathname === '/air/frame.jpg') {
      if (!page) return json(response, { error: 'The box is off air.' }, 409);
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 });
      response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      return response.end(shot);
    }
    if (request.method !== 'POST') return json(response, { error: 'Unknown request.' }, 404);
    if (url.pathname === '/air/on') {
      const body = await new Promise((resolve) => {
        let text = '';
        request.on('data', (c) => (text += c));
        request.on('end', () => {
          try { resolve(JSON.parse(text || '{}')); } catch { resolve({}); }
        });
      });
      const minutes = readMinutes(body.minutes ?? process.env.AIR_MAX_MINUTES);
      const result = await goOnAir(minutes);
      return json(response, { ...result, ...statusBody() });
    }
    if (url.pathname === '/air/off') return json(response, { ...(await goOffAir('asked to go off air')), ...statusBody() });
    return json(response, { error: 'Unknown request.' }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log('control error:', message);
    return json(response, { error: message, ...statusBody() }, 500);
  }
});

if (!TOKEN) {
  console.error('STUDIO_TOKEN is not set; the box would accept commands from anyone. Refusing to start.');
  process.exit(1);
}
if (!RTMP && process.env.AIR_ALLOW_NO_STREAM !== '1')
  log('warning: RTMP_URL/RTMP_KEY are unset. The box will refuse to go on air rather than ' +
      'generate a show nobody can watch. Set AIR_ALLOW_NO_STREAM=1 to override.');

// The show is worth more than tidiness: log what broke and keep the box up, because the
// watchdog is what would notice and recover. A crash here would end the broadcast outright.
process.on('unhandledRejection', (reason) => log('unhandled rejection:', String(reason).slice(0, 300)));

for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    log(`${signal}: shutting down`);
    void goOffAir('the box is shutting down').finally(() => process.exit(0));
  });

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0', () => {
  log(`control API on :${port}; the box starts off air`);
  // A restart mid-broadcast is otherwise silent: the stream simply stops and nobody is told.
  // The box always comes back off air on purpose, so this is the only notice you get.
  void alert('The box started, off air. If a broadcast was running, it has stopped.');
  if (process.env.AIR_AUTOSTART === '1') void goOnAir(readMinutes(process.env.AIR_MAX_MINUTES));
});
