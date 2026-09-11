import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  createMediaService,
  handleMediaRequest,
  MAX_LOGO,
  MEDIA_DEFAULTS,
  qualifiedTemplates,
  renderKey,
  SHUTDOWN_MS,
  startMediaServer,
} from '../broadcast/sponsor-media.mjs';
// The desk only fetches takes from fal.media. These tests serve takes from loopback instead,
// a door the service opens only under NODE_ENV=test.
process.env.NODE_ENV = 'test';
const config = {
  token: 'media-test-token-32-characters-long',
  python:
    process.env.WEARABLE_PYTHON ||
    (existsSync('work/vision-venv/bin/python')
      ? 'work/vision-venv/bin/python'
      : 'python3'),
  workdir: 'work/media-test',
  siteOrigin: 'http://127.0.0.1:3316',
};
// Normalizing a cap and rejecting a malformed one both go through scripts/wearable-render.py,
// so they need cv2 and numpy on the configured interpreter. That is present on a studio machine
// and inside the broadcast container, and absent on a stock CI runner, where the worker answers
// 503 rather than doing the work. Ask the worker itself instead of guessing, and skip rather
// than fail: a missing vision runtime is not a broken build, but silently dropping the checks
// would hide one. /health answers from what the worker measured at boot, so wait for that.
const probe = createMediaService(config);
await probe.booted;
const health = probe.health();
await probe.close();
const needsRuntime = health.ready
  ? false
  : `no wearable vision runtime on ${config.python} (needs cv2 and numpy)`;
void test('media worker refuses unauthenticated work before decoding a file', async () => {
  const r = await handleMediaRequest(
    new Request('http://worker/preview', {
      method: 'POST',
      body: 'not an image',
    }),
    config,
  );
  assert.equal(r.status, 401);
});
void test(
  'normalized upload returns the canonical cap image and immutable hashes',
  { skip: needsRuntime },
  async () => {
    const r = await handleMediaRequest(
      new Request('http://worker/preview?kind=cap&target=host', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'image/png',
        },
        body: await readFile('public/logo.png'),
      }),
      config,
    );
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.match(data.sha256, /^[a-f0-9]{64}$/);
    assert.equal(data.templateId, 'pepe-cap-v1');
    assert.ok(data.preview.length > 100);
    assert.ok(data.logo.length > 100);
    assert.equal(data.qualificationVersion, 'caps-v1');
  },
);
void test('qualification requires matching trial proof and a working runtime, not a template boolean', async () => {
  assert.ok((await qualifiedTemplates()).every((t) => t.qualified));
  const dir = await mkdtemp('/tmp/sponsor-proof-');
  try {
    const qualificationPath = `${dir}/proof.json`,
      proof = JSON.parse(
        await readFile('public/wearables/caps-v1-qualification.json', 'utf8'),
      );
    assert.ok(
      (await qualifiedTemplates({ qualificationPath })).every(
        (t) => !t.qualified,
      ),
    );
    proof.code['scripts/wearable-render.py'] = 'changed';
    await writeFile(qualificationPath, JSON.stringify(proof));
    assert.ok(
      (await qualifiedTemplates({ qualificationPath })).every(
        (t) => !t.qualified,
      ),
    );
    const missing = createMediaService({
      ...config,
      python: '/missing/python',
    });
    await missing.booted;
    const unavailable = missing.health();
    await missing.close();
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.capQualified, false);
    assert.equal(unavailable.decoder, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
void test(
  'malformed images and remote video targets fail before any broadcast output',
  { skip: needsRuntime },
  async () => {
    const r = await handleMediaRequest(
      new Request('http://worker/preview?kind=logo', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}` },
        body: 'bad PNG',
      }),
      config,
    );
    assert.equal(r.status, 422);
    const s = await handleMediaRequest(
      new Request('http://worker/render', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          videoUrl: 'http://169.254.169.254/latest/meta-data/',
          logoUrl: 'http://attacker/logo.png',
          target: 'host',
        }),
      }),
      config,
    );
    assert.equal(s.status, 400);
  },
);

// Everything below drives the desk over real HTTP, the way the site does. The queue, deadline
// and cleanup tests swap the renderer for a small script, so they run on a CI box without
// OpenCV; the render tests that need the real renderer skip there, like the ones above.
const run = promisify(execFile);
const TOKEN = config.token;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LOGO = await readFile('public/logo.png');
const scratch = await mkdtemp(join(tmpdir(), 'sponsor-media-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

// A stand-in for fal.media, and for the site's asset route in the legacy tests.
const files = new Map();
const fal = http.createServer((req, res) => {
  const body = files.get(req.url);
  if (!body) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
});
await new Promise((ready) => fal.listen(0, '127.0.0.1', ready));
const FAL = `http://127.0.0.1:${fal.address().port}`;
after(() => new Promise((done) => fal.close(done)));
let takes = 0;
function take(bytes = Buffer.from(`take-${++takes}-${Date.now()}`)) {
  const path = `/files/take-${++takes}.mp4`;
  files.set(path, bytes);
  return `${FAL}${path}`;
}

// Stands in for scripts/wearable-render.py: waits, then writes an output and a report the way
// the real one does for each of its three modes, or hangs holding a child of its own, or
// crashes, or reports a code. The code (plan.codeFile) and the size of a normalized mark
// (plan.sizeFile) are read from files at run time, so one desk can be made to answer many ways.
async function fakeRenderer(name, plan = {}) {
  const path = join(scratch, `${name}.cjs`);
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const plan = ${JSON.stringify(plan)};
const argv = process.argv.slice(2);
if (argv[0] !== 'scripts/wearable-render.py') process.exit(3);
const mode = argv[1];
const arg = (name) => argv[argv.indexOf(name) + 1];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = (value) => fs.writeFileSync(arg('--report'), JSON.stringify(value));
const told = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function finish() {
  if (plan.crash) process.exit(1);
  const code = plan.reject ? 'TRACK_LOST' : told(plan.codeFile);
  if (code && (!plan.codeMode || plan.codeMode === mode)) {
    report({ accepted: false, code, error: plan.error || 'The cap surface could not be verified.' });
    process.exit(2);
  }
  if (mode === 'normalize') {
    const size = Number(told(plan.sizeFile));
    const bytes = size ? Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]) : fs.readFileSync(arg('--asset'));
    fs.writeFileSync(arg('--output'), bytes);
    report({ accepted: true, sha256: sha(bytes) });
    return;
  }
  if (mode === 'preview') {
    const bytes = Buffer.concat([Buffer.from('cap:'), fs.readFileSync(arg('--asset'))]);
    fs.writeFileSync(arg('--output'), bytes);
    report({ accepted: true, sha256: sha(bytes) });
    return;
  }
  const bytes = Buffer.concat([Buffer.from('fake-mp4:'), fs.readFileSync(arg('--video')), fs.readFileSync(arg('--asset'))]);
  fs.writeFileSync(arg('--output'), bytes);
  report({ accepted: true, version: 1, frames: 10, fps: 10, durationMs: 1000, audioVerified: true, outputSha256: sha(bytes), tracking: [{}] });
}
if (plan.hang) {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(plan.pids, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else setTimeout(finish, plan.delayMs || 0);
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
// What a machine with the vision runtime reports, for desks whose tools are stood in for.
const TOOLS = {
  python: '3.12.0',
  cv2: '5.0.0',
  numpy: '2.5.3',
  ffmpeg: '7.1',
  ffprobe: '7.1',
};

async function desk(t, options = {}) {
  const workdir = await mkdtemp(join(scratch, 'desk-'));
  const logs = [],
    spawns = [];
  // A stand-in renderer has no OpenCV for the desk to measure, so it is told how it decodes.
  const standIn =
    options.python !== undefined && options.python !== config.python;
  const media = await startMediaServer({
    token: TOKEN,
    python: config.python,
    workdir,
    videoOriginForTests: FAL,
    log: (line) => logs.push(line),
    onSpawn: (spawned) => spawns.push(spawned),
    // A test's desk must not hold the run up for a minute and a half if a take outlives it.
    drainMs: 3_000,
    // Nor does it write a real MP4 for ffmpeg to scale up for broadcast.
    ...(standIn ? { decoder: 'direct', broadcastHeight: 0 } : {}),
    ...options,
  });
  t.after(() => media.close());
  // /health answers from what the desk measured at boot, so let it measure first.
  await media.service.booted;
  return {
    ...media,
    workdir,
    logs,
    spawns,
    renders: () => spawns.filter((s) => s.mode === 'render'),
    requests: () => logs.filter((l) => l.event === 'request'),
  };
}
function order(videoUrl, logo = LOGO, extra = {}) {
  const logoSha256 = sha(logo);
  return {
    videoUrl,
    logo: logo.toString('base64'),
    logoSha256,
    target: 'host',
    templateVersion: 'caps-v1',
    key: renderKey(videoUrl, logoSha256, 'host', 'caps-v1'),
    ...extra,
  };
}
async function post(media, body, options = {}) {
  const { signal, token = TOKEN, path = '/render', type } = options;
  const started = Date.now();
  const response = await fetch(`${media.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': type || 'application/json',
    },
    body:
      typeof body === 'string' || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body),
    signal,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    ms: Date.now() - started,
    json: () => JSON.parse(bytes.toString('utf8')),
  };
}
const quality = (r) =>
  JSON.parse(
    Buffer.from(r.headers.get('x-sponsor-quality'), 'base64').toString(),
  );
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await pause(25);
  }
  return !!(await check());
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
function freePort() {
  return new Promise((done) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

void test('the desk listens on the port Railway injects and says it is not ready without a token', async (t) => {
  const port = await freePort();
  const workdir = await mkdtemp(join(scratch, 'cli-'));
  const child = spawn(process.execPath, ['broadcast/sponsor-media.mjs'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      SPONSOR_MEDIA_WORKDIR: workdir,
      WEARABLE_PYTHON: config.python,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill('SIGKILL'));
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (line) =>
    lines.push(JSON.parse(line)),
  );
  const waitFor = (event) =>
    until(() => lines.some((l) => l.event === event), 10_000);
  assert.ok(await waitFor('listening'), 'the desk never said it was listening');
  const listening = lines.find((l) => l.event === 'listening');
  assert.equal(listening.port, port);
  assert.equal(listening.host, '0.0.0.0');
  // /health answers from memory; the boot line says the measuring is done.
  assert.ok(await waitFor('boot'), 'the desk never finished its boot checks');
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const state = await response.json();
  assert.equal(response.status, 503);
  assert.equal(state.ready, false);
  assert.equal(state.capQualified, false);
  assert.equal(state.templateVersion, 'caps-v1');
  assert.equal(state.tools.node, process.versions.node);
  assert.match(state.version, /^[a-f0-9]{12}$/);
  assert.ok(await waitFor('request'));
  const logged = lines.find((l) => l.event === 'request');
  assert.equal(logged.path, '/health');
  assert.equal(logged.status, 503);
  assert.equal(typeof logged.ms, 'number');
  const exited = new Promise((done) => child.once('exit', done));
  const signalled = Date.now();
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  // With nothing running, a drain has nothing to wait for.
  assert.ok(Date.now() - signalled < 5_000, 'an idle desk was slow to stop');
  assert.ok(lines.some((l) => l.event === 'shutdown'));
});

void test('health answers from what the desk measured at boot, and never measures on request', async () => {
  const dir = await mkdtemp(join(scratch, 'proof-'));
  const qualificationPath = join(dir, 'proof.json');
  await writeFile(
    qualificationPath,
    await readFile('public/wearables/caps-v1-qualification.json'),
  );
  const python = await fakeRenderer('no-runtime');
  const service = createMediaService({
    token: TOKEN,
    python,
    workdir: join(dir, 'work'),
    qualificationPath,
  });
  // Asked before it has measured anything, the desk says so, and is not ready.
  const early = service.health();
  assert.equal(early.ready, false);
  assert.equal(early.starting, true);
  await service.booted;
  const first = await service.handle(new Request('http://desk/health'));
  const state = await first.json();
  // No OpenCV behind this interpreter, so the desk must not claim it can render.
  assert.equal(first.status, 503);
  assert.equal(state.ready, false);
  assert.equal(state.starting, false);
  assert.equal(state.tools.cv2, null);
  assert.equal(state.tools.node, process.versions.node);
  assert.equal(state.decoder, null);
  assert.ok(state.templates.every((t) => t.qualified));
  // The proof changing on disk after boot does not change what this desk measured at boot.
  await writeFile(qualificationPath, '{}');
  for (let i = 0; i < 3; i++) {
    const again = await (
      await service.handle(new Request('http://desk/health'))
    ).json();
    assert.ok(again.templates.every((t) => t.qualified));
  }
  // Both checks failed here, and each is retried on its own clock (10 s for the tools, 60 s for
  // the decoder), never because /health was asked.
  assert.equal(service.status().toolProbes, 1);
  assert.equal(service.status().decoderProbes, 1);
  await service.close();
  const rebooted = createMediaService({
    token: TOKEN,
    python,
    workdir: join(dir, 'work'),
    qualificationPath,
  });
  await rebooted.booted;
  assert.ok(rebooted.health().templates.every((t) => !t.qualified));
  await rebooted.close();
});

void test('the tools are measured at boot and again only while they fail', async () => {
  let probes = 0;
  const service = createMediaService({
    token: TOKEN,
    workdir: await mkdtemp(join(scratch, 'tools-')),
    decoder: 'direct',
    toolRetryMs: 50,
    // Missing OpenCV twice, the way a first import starved of CPU at boot times out.
    probeTools: async () => (++probes < 3 ? { ...TOOLS, cv2: null } : TOOLS),
  });
  await service.booted;
  assert.equal(service.health().ready, false);
  assert.ok(
    await until(() => service.health().ready),
    'the tools never passed',
  );
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await service.handle(new Request('http://desk/health'))).status,
      200,
    );
  await pause(300);
  assert.equal(probes, 3, 'tools that passed were measured again');
  await service.close();
});

void test('a desk is not ready until it decodes the way caps were qualified, and a failed decoder probe heals by itself', async (t) => {
  let calls = 0,
    release;
  const retried = new Promise((done) => (release = done));
  const media = await desk(t, {
    python: await fakeRenderer('recalibrated'),
    probeTools: async () => TOOLS,
    decoder: undefined,
    // The boot measurement fails, as one starved of CPU might; the next runs until released.
    calibrate: async () => {
      if (++calls === 1) return { mode: null, error: 'timed out' };
      await retried;
      return { mode: 'direct' };
    },
    decoderRetryMs: 100,
  });
  const broken = await fetch(`${media.url}/health`);
  const state = await broken.json();
  // Railway's healthcheck reads this 503 and keeps the deployment it has.
  assert.equal(broken.status, 503);
  assert.equal(state.ready, false);
  assert.equal(state.capQualified, false);
  assert.equal(state.decoder, null);
  assert.equal(state.tools.cv2, TOOLS.cv2);
  const refused = await post(media, order(take()));
  assert.equal(refused.status, 409);
  assert.equal(refused.json().code, 'NOT_QUALIFIED');
  assert.ok(
    await until(() => calls === 2),
    'the failed decoder probe never ran again',
  );
  // The probe is out and has not answered; /health still answers at once, from memory.
  const asked = performance.now();
  const during = await fetch(`${media.url}/health`);
  assert.equal(during.status, 503);
  assert.ok(performance.now() - asked < 250, 'health waited on a probe');
  release();
  assert.ok(
    await until(
      async () => (await fetch(`${media.url}/health`)).status === 200,
    ),
    'the desk never became ready',
  );
  const healed = await (await fetch(`${media.url}/health`)).json();
  assert.equal(healed.ready, true);
  assert.equal(healed.capQualified, true);
  assert.equal(healed.decoder, 'direct');
  // A measurement that passed is not taken again.
  await pause(300);
  assert.equal(calls, 2);
  assert.equal(media.service.status().decoderProbes, 2);
  assert.equal((await post(media, order(take()))).status, 200);
});

void test(
  '/health answers 200 with tool versions when ready, and 503 without a token',
  { skip: needsRuntime },
  async (t) => {
    const media = await desk(t);
    const response = await fetch(`${media.url}/health`);
    const state = await response.json();
    assert.equal(response.status, 200);
    assert.equal(state.ready, true);
    assert.equal(state.capQualified, true);
    for (const tool of ['python', 'cv2', 'numpy', 'ffmpeg', 'node'])
      assert.match(state.tools[tool], /^\S+$/, `${tool} version missing`);
    // Either OpenCV decodes like the qualification run, or ffmpeg can be made to.
    assert.ok(['direct', 'convert'].includes(state.decoder), state.decoder);
    t.diagnostic(`decoder on this machine: ${state.decoder}`);
    const closed = await desk(t, { token: undefined });
    const refused = await fetch(`${closed.url}/health`);
    const closedState = await refused.json();
    assert.equal(refused.status, 503);
    assert.equal(closedState.ready, false);
    assert.equal(closedState.capQualified, false);
    const short = await desk(t, { token: 'too-short' });
    assert.equal((await fetch(`${short.url}/health`)).status, 503);
  },
);

void test('scratch left behind by a desk that died mid-take is swept at boot', async () => {
  const workdir = await mkdtemp(join(scratch, 'sweep-'));
  const hourAgo = new Date(Date.now() - 3_600_000);
  await mkdir(join(workdir, 'job-dead'));
  await writeFile(join(workdir, 'job-dead', 'input.mp4'), 'partial');
  await utimes(join(workdir, 'job-dead'), hourAgo, hourAgo);
  await mkdir(join(workdir, 'job-live'));
  await mkdir(join(workdir, 'cache'));
  await writeFile(join(workdir, 'cache', `${'a'.repeat(64)}.entry`), 'old');
  await utimes(
    join(workdir, 'cache', `${'a'.repeat(64)}.entry`),
    hourAgo,
    hourAgo,
  );
  const service = createMediaService({ token: TOKEN, workdir });
  await service.booted;
  const left = await readdir(workdir);
  assert.ok(!left.includes('job-dead'));
  // A recent directory may belong to another desk sharing the disk, so it stays.
  assert.ok(left.includes('job-live'));
  assert.deepEqual(await readdir(join(workdir, 'cache')), []);
  await service.close();
});

void test('render requests are checked before any work starts, and every error is JSON', async (t) => {
  const media = await desk(t, { python: await fakeRenderer('unused') });
  const video = take();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
  const cases = [
    [{ ...order(video), target: 'hat' }, 400, 'TEMPLATE'],
    [{ ...order(video), templateVersion: 'caps-v2' }, 400, 'TEMPLATE'],
    [order('http://v3.fal.media/files/take.mp4'), 400, 'HOST'],
    [order('https://v3.fal.media:8443/files/take.mp4'), 400, 'HOST'],
    [order('https://fal.media.attacker.test/take.mp4'), 400, 'HOST'],
    [order('http://169.254.169.254/latest/meta-data/'), 400, 'HOST'],
    [{ ...order(video), logo: '@@@@' }, 400, 'LOGO'],
    [
      { ...order(video), logoSha256: sha(Buffer.from('another logo')) },
      409,
      'LOGO_HASH',
    ],
    [order(video, jpeg), 409, 'LOGO_FORMAT'],
    [{ ...order(video), logo: 'A'.repeat(6_000_000) }, 413, 'TOO_LARGE'],
    [{ ...order(video), logo: undefined }, 400, 'LOGO'],
    [
      {
        ...order(video),
        logo: undefined,
        logoUrl: `${FAL}/api/sponsorship/assets/x`,
      },
      503,
      'LEGACY_UNAVAILABLE',
    ],
    [{ ...order(video), key: 'not-a-key' }, 400, 'KEY'],
    ['{"videoUrl":', 400, 'JSON'],
    [' '.repeat(8 * 1024 * 1024 + 1), 413, 'TOO_LARGE'],
  ];
  for (const [body, status, code] of cases) {
    const r = await post(media, body);
    const failure = r.json();
    assert.equal(r.status, status, JSON.stringify(failure));
    assert.equal(failure.code, code);
    assert.equal(typeof failure.error, 'string');
  }
  const wrongToken = await post(media, order(video), { token: 'x'.repeat(34) });
  assert.equal(wrongToken.status, 401);
  assert.equal(wrongToken.json().code, 'UNAUTHORIZED');
  const unknown = await post(media, order(video), { path: '/encode' });
  assert.equal(unknown.status, 404);
  assert.equal(media.spawns.length, 0);
});

void test('identical requests share one render, a repeat comes from the cache, and logs stay clean', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('shared', { delayMs: 300 }),
  });
  const body = order(take());
  const [a, b] = await Promise.all([post(media, body), post(media, body)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(media.renders().length, 1);
  assert.deepEqual(a.bytes, b.bytes);
  assert.deepEqual(
    new Set([
      a.headers.get('x-sponsor-cache'),
      b.headers.get('x-sponsor-cache'),
    ]),
    new Set(['join', 'miss']),
  );
  assert.equal(a.headers.get('x-sponsor-key'), body.key);
  assert.equal(a.headers.get('content-type'), 'video/mp4');
  const summary = quality(a);
  assert.equal(summary.outputSha256, sha(a.bytes));
  assert.equal(summary.tracking, undefined);
  const again = await post(media, body);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-sponsor-cache'), 'hit');
  assert.deepEqual(again.bytes, a.bytes);
  assert.equal(media.renders().length, 1);
  // A caller that labels the same take differently still gets this take, under its own label.
  const relabelled = await post(media, { ...body, key: 'f'.repeat(64) });
  assert.equal(relabelled.headers.get('x-sponsor-cache'), 'hit');
  assert.equal(relabelled.headers.get('x-sponsor-key'), 'f'.repeat(64));
  assert.deepEqual(relabelled.bytes, a.bytes);
  await post(media, body, { token: 'y'.repeat(34) });
  await until(() => media.requests().length >= 5);
  const renders = media.requests().filter((l) => l.path === '/render');
  for (const line of renders) {
    assert.equal(line.method, 'POST');
    assert.equal(typeof line.status, 'number');
    assert.equal(typeof line.ms, 'number');
  }
  const served = renders.filter((l) => l.status === 200);
  assert.ok(served.every((l) => l.key.length === 12 && l.cache));
  assert.ok(served.every((l) => typeof l.queueMs === 'number'));
  assert.ok(served.some((l) => l.keyMismatch === true));
  assert.ok(renders.some((l) => l.status === 401 && l.code === 'UNAUTHORIZED'));
  const everything = JSON.stringify(media.logs);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes(body.key));
  assert.ok(!everything.includes(body.logo.slice(0, 40)));
});

void test('a busy desk queues the next take instead of refusing it', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('queue', { delayMs: 400 }),
    concurrency: 1,
  });
  const [a, b] = await Promise.all([
    post(media, order(take())),
    pause(50).then(() => post(media, order(take()))),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(media.renders().length, 2);
  await until(() => media.requests().length >= 2);
  const waits = media.requests().map((l) => l.queueMs);
  assert.ok(Math.max(...waits) >= 250, `queue waits ${waits}`);
});

void test('a full queue, or a take that cannot start in time, is told BUSY with a retry hint', async (t) => {
  const full = await desk(t, {
    python: await fakeRenderer('full', { delayMs: 800 }),
    concurrency: 1,
    queue: 1,
  });
  const running = post(full, order(take()));
  await pause(50);
  const waiting = post(full, order(take()));
  await pause(50);
  const refused = await post(full, order(take()));
  assert.equal(refused.status, 503);
  const busy = refused.json();
  assert.equal(busy.code, 'BUSY');
  assert.ok(busy.retryAfterMs >= 1000);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.ok(refused.ms < 500, 'a full queue answers at once');
  assert.equal((await running).status, 200);
  assert.equal((await waiting).status, 200);

  const late = await desk(t, {
    python: await fakeRenderer('late', { delayMs: 1200 }),
    concurrency: 1,
    queue: 2,
    deadlineMs: 2000,
    minRunMs: 1500,
  });
  const first = post(late, order(take()));
  await pause(50);
  const second = await post(late, order(take()));
  assert.equal(second.status, 503);
  assert.equal(second.json().code, 'BUSY');
  assert.ok(
    second.ms < 1100,
    `gave up at ${second.ms}ms, not when the slot freed`,
  );
  assert.equal((await first).status, 200);
  assert.equal(late.renders().length, 1);
});

void test('a renderer past its deadline is killed with its children and its scratch removed', async (t) => {
  const pids = join(scratch, 'deadline-pids.json');
  const media = await desk(t, {
    python: await fakeRenderer('deadline', { hang: true, pids }),
    deadlineMs: 1500,
    minRunMs: 0,
  });
  const r = await post(media, order(take()));
  assert.equal(r.status, 503);
  assert.equal(r.json().code, 'DEADLINE');
  assert.ok(r.ms >= 1400 && r.ms < 3000, `answered after ${r.ms}ms`);
  const [renderer, child] = JSON.parse(await readFile(pids, 'utf8'));
  assert.ok(
    await until(() => !alive(renderer) && !alive(child)),
    'renderer group survived',
  );
  const [spawned] = media.renders();
  assert.ok(await until(() => !existsSync(spawned.dir)), 'scratch survived');
  assert.ok(await until(() => media.service.status().running === 0));
  assert.equal(media.service.status().inflight, 0);
});

void test('a caller hanging up stops the renderer it was waiting on', async (t) => {
  const pids = join(scratch, 'hangup-pids.json');
  const media = await desk(t, {
    python: await fakeRenderer('hangup', { hang: true, pids }),
  });
  const caller = new AbortController();
  const pending = post(media, order(take()), { signal: caller.signal }).catch(
    (error) => error,
  );
  assert.ok(await until(() => existsSync(pids)), 'the renderer never started');
  caller.abort();
  await pending;
  const [renderer, child] = JSON.parse(await readFile(pids, 'utf8'));
  assert.ok(
    await until(() => !alive(renderer) && !alive(child)),
    'renderer group survived',
  );
  assert.ok(await until(() => !existsSync(media.renders()[0].dir)));
  assert.ok(await until(() => media.service.status().running === 0));
  assert.ok(await until(() => media.requests().some((l) => l.status === 499)));
});

void test('a caller hanging up while queued cancels the take before it starts', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('queued-hangup', { delayMs: 800 }),
    concurrency: 1,
  });
  const first = post(media, order(take()));
  await pause(50);
  const caller = new AbortController();
  const queued = post(media, order(take()), { signal: caller.signal }).catch(
    (error) => error,
  );
  await pause(150);
  assert.equal(media.service.status().queued, 1);
  caller.abort();
  await queued;
  assert.ok(await until(() => media.service.status().queued === 0));
  assert.equal((await first).status, 200);
  await pause(300);
  assert.equal(media.renders().length, 1);
  assert.equal(media.service.status().inflight, 0);
});

// What SIGTERM does on Railway: the desk is being replaced, and a take it is rendering has been
// paid for.
void test('a desk told to stop finishes the take it is running, and turns new and queued work away', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('drain', { delayMs: 1500 }),
    concurrency: 1,
    drainMs: 10_000,
  });
  const running = post(media, order(take()));
  assert.ok(await until(() => media.renders().length === 1));
  const queued = post(media, order(take()));
  assert.ok(await until(() => media.service.status().queued === 1));
  let closed = false;
  const closing = media.close().then(() => (closed = true));
  // The queued take has cost nothing yet: BUSY, so the site sends it to the replacement.
  const waited = await queued;
  assert.equal(waited.status, 503);
  assert.equal(waited.json().code, 'BUSY');
  assert.ok(waited.json().retryAfterMs >= 1000);
  assert.ok(Number(waited.headers.get('retry-after')) >= 1);
  // Railway reads a draining desk as not ready.
  const health = await fetch(`${media.url}/health`);
  const state = await health.json();
  assert.equal(health.status, 503);
  assert.equal(state.ready, false);
  assert.equal(state.draining, true);
  // New work hears BUSY too, rather than a refused connection.
  const fresh = await post(media, order(take()));
  assert.equal(fresh.status, 503);
  assert.equal(fresh.json().code, 'BUSY');
  assert.ok(fresh.json().retryAfterMs >= 1000);
  assert.equal(closed, false, 'the desk stopped with a take still running');
  const r = await running;
  assert.equal(r.status, 200, r.bytes.toString().slice(0, 200));
  assert.equal(quality(r).outputSha256, sha(r.bytes));
  await closing;
  assert.equal(media.renders().length, 1, 'a take started during the drain');
  await assert.rejects(
    fetch(`${media.url}/health`),
    'still listening after the drain',
  );
});

void test('a drain waits for a running take only until that take’s own deadline', async (t) => {
  const pids = join(scratch, 'drain-pids.json');
  const media = await desk(t, {
    python: await fakeRenderer('drain-deadline', { hang: true, pids }),
    deadlineMs: 1500,
    minRunMs: 0,
    drainMs: 60_000,
  });
  const pending = post(media, order(take()));
  assert.ok(await until(() => existsSync(pids)), 'the renderer never started');
  const signalled = Date.now();
  await media.close();
  const drained = Date.now() - signalled;
  assert.ok(drained < 4_000, `the drain took ${drained}ms`);
  const r = await pending;
  assert.equal(r.status, 503);
  assert.equal(r.json().code, 'DEADLINE');
  const [renderer, child] = JSON.parse(await readFile(pids, 'utf8'));
  assert.ok(
    await until(() => !alive(renderer) && !alive(child)),
    'renderer group survived',
  );
});

void test('renderer verdicts keep their status codes and leave no scratch behind', async (t) => {
  const rejecting = await desk(t, {
    python: await fakeRenderer('reject', { reject: true }),
  });
  const rejected = await post(rejecting, order(take()));
  assert.equal(rejected.status, 422);
  assert.equal(rejected.json().code, 'TRACK_LOST');
  const crashing = await desk(t, {
    python: await fakeRenderer('crash', { crash: true }),
  });
  const crashed = await post(crashing, order(take()));
  assert.equal(crashed.status, 503);
  assert.equal(crashed.json().code, 'RENDERER');
  const gone = await desk(t, { python: '/missing/renderer' });
  assert.equal((await post(gone, order(take()))).status, 503);
  for (const media of [rejecting, crashing, gone])
    assert.ok(
      await until(async () =>
        (await readdir(media.workdir)).every((name) => name === 'cache'),
      ),
    );
});

// The site maps a 422 to INVALID_WEARABLE, and the studio pays fal for up to two new takes
// because of it. Only a verdict on the footage may say 422.
void test('at /render only a verdict on the take is a 422: artwork verdicts are 409 and faults of this machine 503', async (t) => {
  const codeFile = join(scratch, 'render-code.txt');
  const media = await desk(t, {
    python: await fakeRenderer('render-codes', {
      codeFile,
      codeMode: 'render',
      error:
        'ffmpeg exited 1: /app/work/sponsor-media/job-x/input.mp4: Invalid data',
    }),
  });
  const cases = [
    // What the footage did. A new take may pass.
    ['TRACK_LOST', 422, 'TRACK_LOST'],
    ['LOGO_OUTSIDE_PANEL', 422, 'LOGO_OUTSIDE_PANEL'],
    ['INVALID_VIDEO', 422, 'INVALID_VIDEO'],
    ['INVALID_AUDIO', 422, 'INVALID_AUDIO'],
    ['UNSUPPORTED_TIMING', 422, 'UNSUPPORTED_TIMING'],
    // The artwork, which already passed /preview. A new take cannot fix it.
    ['LOGO_TOO_THIN', 409, 'LOGO_TOO_THIN'],
    ['INVALID_IMAGE', 409, 'INVALID_IMAGE'],
    // This machine. The same take, tried again, may pass; a new one fails the same way.
    ['MEDIA_FAILED', 503, 'RENDERER'],
    ['MEDIA_CHANGED', 503, 'RENDERER'],
    ['TEMPLATE_CHANGED', 503, 'RENDERER'],
    ['GEOMETRY_CHANGED', 503, 'RENDERER'],
    ['TEMPLATE_UNTRACKABLE', 503, 'RENDERER'],
    ['MISSING_MASK', 503, 'RENDERER'],
    ['A_CODE_FROM_A_NEWER_RENDERER', 503, 'RENDERER'],
  ];
  for (const [said, status, code] of cases) {
    await writeFile(codeFile, said);
    const r = await post(media, order(take()));
    const failure = r.json();
    assert.equal(r.status, status, `${said}: ${JSON.stringify(failure)}`);
    assert.equal(failure.code, code, said);
    if (status === 503)
      assert.ok(
        !failure.error.includes('/app/work'),
        `${said} handed the caller the renderer's own words`,
      );
  }
  // A fault's details go to the log, for whoever fixes the machine.
  assert.ok(
    media.logs.some(
      (l) =>
        l.event === 'renderer' &&
        l.code === 'MEDIA_FAILED' &&
        l.error.includes('Invalid data'),
    ),
  );
});

void test('at /preview an artwork verdict is the buyer’s answer, and anything else is this machine failing', async (t) => {
  const codeFile = join(scratch, 'preview-code.txt');
  const media = await desk(t, {
    python: await fakeRenderer('preview-codes', {
      codeFile,
      error: 'Use artwork between 8 and 4096 pixels per side.',
    }),
  });
  const cases = [
    ['INVALID_IMAGE', 422, 'INVALID_IMAGE'],
    ['EMPTY_IMAGE', 422, 'EMPTY_IMAGE'],
    ['LOGO_TOO_THIN', 422, 'LOGO_TOO_THIN'],
    ['LOGO_OUTSIDE_PANEL', 422, 'LOGO_OUTSIDE_PANEL'],
    ['MEDIA_FAILED', 503, 'RENDERER'],
    ['TEMPLATE_CHANGED', 503, 'RENDERER'],
    // A verdict on footage means nothing for a still image.
    ['TRACK_LOST', 503, 'RENDERER'],
    ['A_CODE_FROM_A_NEWER_RENDERER', 503, 'RENDERER'],
  ];
  for (const [said, status, code] of cases) {
    await writeFile(codeFile, said);
    const r = await post(media, LOGO, {
      path: '/preview?kind=cap&target=host',
      type: 'image/png',
    });
    const failure = r.json();
    assert.equal(r.status, status, `${said}: ${JSON.stringify(failure)}`);
    assert.equal(failure.code, code, said);
    if (status === 422)
      assert.equal(
        failure.error,
        'Use artwork between 8 and 4096 pixels per side.',
      );
  }
});

void test('a take this machine’s ffmpeg cannot convert is a fault of the desk, not a verdict on the take', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('never-reached'),
    decoder: 'convert',
  });
  const r = await post(media, order(take(Buffer.from('not a video'))));
  assert.equal(r.status, 503, JSON.stringify(r.json()));
  assert.equal(r.json().code, 'CONVERT');
  assert.equal(media.renders().length, 0);
  assert.ok(
    await until(async () =>
      (await readdir(media.workdir)).every((name) => name === 'cache'),
    ),
  );
});

void test('the legacy logoUrl form still renders, and still checks the logo hash', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('legacy', { delayMs: 50 }),
    siteOrigin: FAL,
  });
  const logoPath = '/api/sponsorship/assets/abc123?part=logo';
  files.set(logoPath, LOGO);
  const videoUrl = take();
  const body = {
    videoUrl,
    logoUrl: `${FAL}${logoPath}`,
    logoSha256: sha(LOGO),
    target: 'host',
    templateVersion: 'caps-v1',
  };
  const r = await post(media, body);
  assert.equal(r.status, 200);
  assert.equal(
    r.headers.get('x-sponsor-key'),
    renderKey(videoUrl, sha(LOGO), 'host', 'caps-v1'),
  );
  const changed = await post(media, {
    ...body,
    videoUrl: take(),
    logoSha256: sha(Buffer.from('a different mark')),
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json().code, 'LOGO_HASH');
  const elsewhere = await post(media, {
    ...body,
    logoUrl: 'http://attacker.test/api/sponsorship/assets/abc123',
  });
  assert.equal(elsewhere.status, 400);
});

void test('a desk that cannot decode the way caps were qualified refuses to render them', async (t) => {
  const media = await desk(t, {
    python: await fakeRenderer('undecodable'),
    decoder: null,
  });
  const r = await post(media, order(take()));
  assert.equal(r.status, 409);
  assert.equal(r.json().code, 'NOT_QUALIFIED');
  const state = await (await fetch(`${media.url}/health`)).json();
  assert.equal(state.decoder, null);
  assert.equal(state.capQualified, false);
  assert.equal(media.spawns.length, 0);
});

void test('previews refuse files that are not PNG, JPEG or WebP before decoding them', async (t) => {
  const media = await desk(t);
  const gif = await post(media, Buffer.from('GIF89a\x01\x00\x01\x00'), {
    path: '/preview?kind=cap&target=host',
    type: 'image/png',
  });
  assert.equal(gif.status, 422);
  assert.equal(gif.json().code, 'INVALID_IMAGE');
  const placement = await post(media, LOGO, {
    path: '/preview?kind=hat&target=host',
    type: 'image/png',
  });
  assert.equal(placement.status, 400);
  assert.equal(media.spawns.length, 0);
});

void test('/preview refuses cap artwork /render could not take, at the one limit both use', async (t) => {
  const sizeFile = join(scratch, 'normalized-size.txt');
  const media = await desk(t, {
    python: await fakeRenderer('heavy', { sizeFile }),
  });
  const upload = (kind) =>
    post(media, LOGO, {
      path: `/preview?kind=${kind}&target=host`,
      type: 'image/png',
    });
  const composites = () =>
    media.spawns.filter((s) => s.mode === 'preview').length;

  await writeFile(sizeFile, String(MAX_LOGO));
  const heaviest = await upload('cap');
  assert.equal(heaviest.status, 200, heaviest.bytes.toString().slice(0, 200));
  const logo = Buffer.from(heaviest.json().logo, 'base64');
  assert.equal(logo.length, MAX_LOGO);
  // Whatever /preview lets a buyer pay for, /render takes.
  const rendered = await post(media, order(take(), logo));
  assert.equal(rendered.status, 200, rendered.bytes.toString().slice(0, 200));

  await writeFile(sizeFile, String(MAX_LOGO + 1));
  const before = composites();
  const heavy = await upload('cap');
  assert.equal(heavy.status, 422);
  const refusal = heavy.json();
  assert.equal(refusal.code, 'LOGO_TOO_LARGE');
  assert.equal(
    refusal.error,
    'This artwork is too detailed to print on a cap; use a simpler PNG under 4 MB.',
  );
  assert.equal(
    composites(),
    before,
    'a cap was composited from artwork it cannot carry',
  );
  // A spotlight logo is only ever shown, so the same mark passes as one. As a cap, /render
  // refuses it at exactly that byte.
  const shown = await upload('logo');
  assert.equal(shown.status, 200);
  const refused = await post(
    media,
    order(take(), Buffer.from(shown.json().logo, 'base64')),
  );
  assert.equal(refused.status, 413);
  assert.equal(refused.json().code, 'TOO_LARGE');
});

void test(
  'a real mark that normalizes past the limit is refused at upload, before anyone pays',
  { skip: needsRuntime },
  async (t) => {
    const media = await desk(t);
    // Noise with an alpha channel: 1.8 MB as WebP, 4.2 MB once normalized to PNG.
    const noisy = join(scratch, 'noisy.webp');
    await run(config.python, [
      '-c',
      `import cv2, numpy as np; cv2.imwrite(${JSON.stringify(noisy)}, np.random.default_rng(7).integers(0, 256, (1024, 1024, 4), dtype=np.uint8), [cv2.IMWRITE_WEBP_QUALITY, 80])`,
    ]);
    const upload = await readFile(noisy);
    assert.ok(upload.length < 4 * 1024 * 1024, 'the upload itself fits');
    const r = await post(media, upload, {
      path: '/preview?kind=cap&target=host',
      type: 'image/webp',
    });
    assert.equal(r.status, 422, r.bytes.toString().slice(0, 300));
    assert.equal(r.json().code, 'LOGO_TOO_LARGE');
  },
);

void test(
  '/preview over HTTP returns the qualified cap for the logo on file',
  { skip: needsRuntime },
  async (t) => {
    const media = await desk(t);
    const r = await post(media, LOGO, {
      path: '/preview?kind=cap&target=host',
      type: 'image/png',
    });
    assert.equal(r.status, 200);
    const data = r.json();
    assert.equal(data.qualificationVersion, 'caps-v1');
    assert.equal(data.templateId, 'pepe-cap-v1');
    assert.equal(data.logoSha256, sha(Buffer.from(data.logo, 'base64')));
    assert.ok(
      await until(async () =>
        (await readdir(media.workdir)).every((n) => n === 'cache'),
      ),
    );
  },
);

// One second of the real qualification footage when this machine has it, otherwise the blank
// cap still that the Python tests use. Either one tracks, and both carry audio to preserve.
async function realTake() {
  const trial =
    process.env.SPONSOR_MEDIA_TRIAL_CLIP ||
    'work/wearable-qualification/pepe-0.mp4';
  const out = join(scratch, `real-${Date.now()}.mp4`);
  const args = existsSync(trial)
    ? ['-i', trial, '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast']
    : [
        '-loop',
        '1',
        '-framerate',
        '10',
        '-i',
        'public/wearables/pepe-cap-v1.png',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
      ];
  await run('ffmpeg', [
    '-y',
    '-v',
    'error',
    ...args,
    '-crf',
    '8',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    out,
  ]);
  return {
    bytes: await readFile(out),
    source: existsSync(trial) ? trial : 'synthetic',
  };
}

void test(
  'a real take renders once for concurrent duplicates, verified, then comes from the cache',
  { skip: needsRuntime },
  async (t) => {
    const media = await desk(t);
    const preview = await post(media, LOGO, {
      path: '/preview?kind=logo&target=host',
      type: 'image/png',
    });
    const logo = Buffer.from(preview.json().logo, 'base64');
    const footage = await realTake();
    const body = order(take(footage.bytes), logo);
    const [a, b] = await Promise.all([post(media, body), post(media, body)]);
    assert.equal(a.status, 200, a.bytes.toString().slice(0, 300));
    assert.equal(b.status, 200);
    assert.equal(media.renders().length, 1);
    assert.deepEqual(a.bytes, b.bytes);
    assert.equal(a.bytes.subarray(4, 8).toString('latin1'), 'ftyp');
    const summary = quality(a);
    assert.equal(summary.accepted, true);
    assert.equal(summary.audioVerified, true);
    assert.ok(summary.frames >= 10);
    assert.equal(summary.outputSha256, sha(a.bytes));
    assert.equal(summary.inputSha256, sha(footage.bytes));
    // Composited on the take as the model made it, then scaled to the show's 1080 lines:
    // what leaves is the broadcast cut, and the renderer's own output is on record beside it.
    assert.equal(summary.height, 1080);
    assert.match(summary.renderedSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(summary.renderedSha256, summary.outputSha256);
    const file = join(scratch, 'branded.mp4');
    await writeFile(file, a.bytes);
    const probe = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-of',
          'json',
          file,
        ])
      ).stdout,
    );
    assert.deepEqual(
      new Set(probe.streams.map((s) => s.codec_type)),
      new Set(['audio', 'video']),
    );
    const picture = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(picture.height, 1080);
    assert.equal(picture.codec_name, 'h264');
    const again = await post(media, body);
    assert.equal(again.headers.get('x-sponsor-cache'), 'hit');
    assert.deepEqual(again.bytes, a.bytes);
    assert.equal(media.renders().length, 1);
    t.diagnostic(
      `${footage.source}: ${summary.frames} frames rendered in ${a.ms}ms, cache hit in ${again.ms}ms`,
    );
  },
);

// On a machine whose OpenCV already decodes like the qualification run, converting first must
// change nothing the tracker measures: same frames, same coverage, same flow error. That is
// the property the container relies on when its OpenCV does not.
void test(
  'converting a take first hands the renderer exactly the pixels a direct decode would',
  { skip: needsRuntime },
  async (t) => {
    const calibrated = await desk(t);
    const converting = await desk(t, { decoder: 'convert' });
    const logo = Buffer.from(
      (
        await post(calibrated, LOGO, {
          path: '/preview?kind=logo&target=host',
          type: 'image/png',
        })
      ).json().logo,
      'base64',
    );
    const footage = await realTake();
    const [plain, converted] = await Promise.all([
      post(calibrated, order(take(footage.bytes), logo)),
      post(converting, order(take(footage.bytes), logo)),
    ]);
    assert.equal(plain.status, 200, plain.bytes.toString().slice(0, 300));
    assert.equal(
      converted.status,
      200,
      converted.bytes.toString().slice(0, 300),
    );
    assert.ok(converting.spawns.some((s) => s.mode === 'convert'));
    const a = quality(plain),
      b = quality(converted);
    for (const field of [
      'frames',
      'durationMs',
      'minClothCoverage',
      'minEdgeContrast',
      'maxForwardBackwardErrorPx',
      'maxCornerDifference',
      'audioVerified',
    ])
      assert.equal(b[field], a[field], field);
    assert.equal(b.inputSha256, sha(footage.bytes));
    assert.equal(b.outputSha256, sha(converted.bytes));
    assert.ok(
      await until(async () =>
        (await readdir(converting.workdir)).every((n) => n === 'cache'),
      ),
    );
    const state = await (await fetch(`${calibrated.url}/health`)).json();
    t.diagnostic(
      `${state.decoder} decode ${plain.ms}ms, converted first ${converted.ms}ms`,
    );
  },
);

void test(
  'SIGTERM lets the paid render in progress finish, turns new work away, then exits',
  { skip: needsRuntime },
  async (t) => {
    const port = await freePort();
    const workdir = await mkdtemp(join(scratch, 'sigterm-'));
    const child = spawn(process.execPath, ['broadcast/sponsor-media.mjs'], {
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        SPONSOR_MEDIA_WORKDIR: workdir,
        SPONSOR_MEDIA_TOKEN: TOKEN,
        WEARABLE_PYTHON: config.python,
        // The take comes from this test's loopback stand-in for fal.
        NODE_ENV: 'test',
        SPONSOR_MEDIA_TEST_VIDEO_HOST: FAL,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    t.after(() => child.kill('SIGKILL'));
    const lines = [];
    createInterface({ input: child.stdout }).on('line', (line) =>
      lines.push(JSON.parse(line)),
    );
    // 'close' rather than 'exit', so every line the desk wrote has been read.
    const exited = new Promise((done) => child.once('close', done));
    assert.ok(
      await until(() => lines.some((l) => l.event === 'boot'), 20_000),
      'the desk never booted',
    );
    assert.equal(lines.find((l) => l.event === 'boot').ready, true);
    const media = { url: `http://127.0.0.1:${port}` };
    const logo = Buffer.from(
      (
        await post(media, LOGO, {
          path: '/preview?kind=logo&target=host',
          type: 'image/png',
        })
      ).json().logo,
      'base64',
    );
    const footage = await realTake();
    const rendering = post(media, order(take(footage.bytes), logo));
    // Railway's SIGTERM lands while the renderer has the take.
    assert.ok(
      await until(
        async () =>
          (await readdir(workdir)).some(
            (name) => name.startsWith('job-') && !name.startsWith('job-probe-'),
          ),
        10_000,
      ),
      'the render never started',
    );
    child.kill('SIGTERM');
    assert.ok(await until(() => lines.some((l) => l.event === 'shutdown')));
    assert.equal(lines.find((l) => l.event === 'shutdown').running, 1);
    const health = await fetch(`${media.url}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).draining, true);
    const turnedAway = await post(media, order(take(footage.bytes), logo));
    assert.equal(turnedAway.status, 503);
    assert.equal(turnedAway.json().code, 'BUSY');
    assert.ok(turnedAway.json().retryAfterMs >= 1000);
    const r = await rendering;
    assert.equal(r.status, 200, r.bytes.toString().slice(0, 300));
    const summary = quality(r);
    assert.equal(summary.accepted, true);
    assert.equal(summary.outputSha256, sha(r.bytes));
    assert.equal(await exited, 0);
    // In the desk's own words: it answered the paid take, then stopped.
    const answered = lines.findIndex(
      (l) => l.event === 'request' && l.path === '/render' && l.status === 200,
    );
    const stopped = lines.findIndex((l) => l.event === 'stopped');
    assert.ok(answered >= 0 && stopped > answered, 'stopped before answering');
    t.diagnostic(`rendered through a drain in ${r.ms}ms`);
  },
);

// These numbers live in three places: this desk, the site (lib/sponsor-media.ts) and Railway's
// settings. Each promise below is one the docs make, and one broke when a side moved.
void test('the desk’s clock agrees with the site’s retry and with Railway’s shutdown window', async () => {
  const site = await readFile('lib/sponsor-media.ts', 'utf8');
  const constant = (name) =>
    Number(site.match(new RegExp(`const ${name} = (\\d+);`))?.[1]);
  const budget = constant('RENDER_BUDGET_MS'),
    floor = constant('RETRY_FLOOR_MS');
  assert.ok(budget > 0 && floor > 0, 'the site’s budget and retry floor moved');
  // Before its one retry the site waits what the desk asked, 1 s at least and 5 s at most, plus
  // up to half a second of jitter, and it retries only while `floor` of its budget remains.
  const shortestWait = 1_000,
    longestWait = 5_500;
  const { deadlineMs, minRunMs, drainMs } = MEDIA_DEFAULTS;
  // Every answer, DEADLINE included, reaches the site before its own timeout does.
  assert.ok(deadlineMs + 5_000 <= budget);
  // A take turned away on arrival, because the queue is full or the desk is draining, is retried.
  assert.ok(budget - longestWait >= floor);
  // A take that waited in the queue until it could no longer finish hears BUSY with at most
  // budget - (deadlineMs - minRunMs) of the site's clock left, under its floor even after the
  // shortest wait. So the site does not retry it, as the docs and minRunMs's comment say. If this
  // fails, the site now does: say so there.
  assert.ok(budget - (deadlineMs - minRunMs) - shortestWait < floor);
  // A drain lasts until the last running take meets its deadline. The process then stops itself
  // well inside the window Railway gives a replaced deployment.
  const railway = JSON.parse(
    await readFile('broadcast/railway.sponsor-media.json', 'utf8'),
  );
  assert.ok(drainMs >= deadlineMs);
  assert.ok(SHUTDOWN_MS > drainMs);
  assert.ok(SHUTDOWN_MS <= railway.deploy.drainingSeconds * 1000 - 10_000);
});
