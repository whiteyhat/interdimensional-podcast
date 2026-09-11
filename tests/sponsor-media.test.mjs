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
  qualifiedTemplates,
  renderKey,
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
// would hide one.
const health = await (
  await handleMediaRequest(new Request('http://worker/health'), config)
).json();
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
    const unavailable = await (
      await handleMediaRequest(new Request('http://worker/health'), {
        ...config,
        python: '/missing/python',
      })
    ).json();
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.capQualified, false);
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
// the real one does, or hangs holding a child of its own, or fails in one of two ways.
async function fakeRenderer(name, plan = {}) {
  const path = join(scratch, `${name}.cjs`);
  const source = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const { createHash } = require('node:crypto');",
    "const { spawn } = require('node:child_process');",
    `const plan = ${JSON.stringify(plan)};`,
    'const argv = process.argv.slice(2);',
    "if (argv[0] !== 'scripts/wearable-render.py') process.exit(3);",
    'const arg = (name) => argv[argv.indexOf(name) + 1];',
    'if (plan.hang) {',
    "  const child = spawn('sleep', ['30'], { stdio: 'ignore' });",
    '  fs.writeFileSync(plan.pids, JSON.stringify([process.pid, child.pid]));',
    '  setInterval(() => {}, 1000);',
    '} else',
    '  setTimeout(() => {',
    '    if (plan.crash) process.exit(1);',
    '    if (plan.reject) {',
    "      fs.writeFileSync(arg('--report'), JSON.stringify({ accepted: false, code: 'TRACK_LOST', error: 'The cap surface could not be verified.' }));",
    '      process.exit(2);',
    '    }',
    "    const bytes = Buffer.concat([Buffer.from('fake-mp4:'), fs.readFileSync(arg('--video')), fs.readFileSync(arg('--asset'))]);",
    "    fs.writeFileSync(arg('--output'), bytes);",
    "    const outputSha256 = createHash('sha256').update(bytes).digest('hex');",
    "    fs.writeFileSync(arg('--report'), JSON.stringify({ accepted: true, version: 1, frames: 10, fps: 10, durationMs: 1000, audioVerified: true, outputSha256, tracking: [{}] }));",
    '  }, plan.delayMs || 0);',
    '',
  ].join('\n');
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

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
    // Nor does it write a real MP4 for ffmpeg to scale up for broadcast.
    ...(standIn ? { decoder: 'direct', broadcastHeight: 0 } : {}),
    ...options,
  });
  t.after(() => media.close());
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
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(lines.some((l) => l.event === 'shutdown'));
});

void test('health hashes the templates once at boot and reuses its tool probe', async () => {
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
  const first = await service.handle(new Request('http://desk/health'));
  const state = await first.json();
  // No OpenCV behind this interpreter, so the desk must not claim it can render.
  assert.equal(first.status, 503);
  assert.equal(state.ready, false);
  assert.equal(state.tools.cv2, null);
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
  assert.equal(service.status().toolProbes, 1);
  await service.close();
  const rebooted = createMediaService({
    token: TOKEN,
    python,
    workdir: join(dir, 'work'),
    qualificationPath,
  });
  const fresh = (await rebooted.health()).templates;
  assert.ok(fresh.every((t) => !t.qualified));
  await rebooted.close();
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
