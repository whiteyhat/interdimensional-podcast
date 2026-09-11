#!/usr/bin/env node
// Authenticated CPU worker. The public Worker owns orders and persists these media results in R2.
//
// A paid cap placement waits on this service, so most of what follows is about time. Every
// render finishes or fails inside one deadline that sits below the site's own timeout. A busy
// desk queues work rather than refusing it. The same take asked for twice is rendered once. A
// renderer that outlives its deadline, or every caller waiting on it, is killed together with
// the ffmpeg it started, and its scratch directory goes with it.
import http from 'node:http';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
// The renderer, its templates and the qualification proof ship beside this file. Resolving
// them from here means the service works whatever directory a platform starts it in.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_VERSION = 'caps-v1';
const MAX_UPLOAD = 4 * 1024 * 1024,
  MAX_VIDEO = 40 * 1024 * 1024,
  MAX_RENDER_BODY = 8 * 1024 * 1024;
const templates = { host: 'pepe-cap-v1', guest: 'gigachad-cap-v1' };
const HEX64 = /^[a-f0-9]{64}$/;
// The show airs every shot 1080 lines tall, scaled by fal from the model's native frame
// (scaleInput in lib/show.ts: libx264, crf 18, preset fast). A cap is tracked and composited on
// that native frame, the only one the qualification proof covers: on the scaled frame every
// tracking error grows by the scale factor and the work doubles, which made real takes lose
// tracking or run out the deadline. Only the verified composite is scaled up, here, with the
// show's own encoder settings, so a cap shot matches its neighbours on air.
export const BROADCAST_HEIGHT = 1080;
const DEFAULTS = {
  // The site gives a render 105 seconds and retries once while 40 of them remain. Answering
  // inside 95 leaves it room to hear the answer: 15 for fetching the take, the rest to render.
  deadlineMs: 95_000,
  downloadMs: 15_000,
  concurrency: 2,
  queue: 6,
  // A queued take that could only start with less than this left would die at the deadline
  // anyway. Saying BUSY while the site still has time to retry is the kinder failure.
  minRunMs: 30_000,
  previewMs: 30_000,
  previewConcurrency: 2,
  cacheTtlMs: 10 * 60_000,
  cacheMax: 32,
  toolTtlMs: 30_000,
  // The height a verified composite is scaled to before it leaves; 0 sends it as rendered.
  broadcastHeight: BROADCAST_HEIGHT,
};

class MediaError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reply = (value, status = 200, headers = {}) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });
function failure(error) {
  const retry = error.extra.retryAfterMs;
  return reply(
    { code: error.code, error: error.message, ...error.extra },
    error.status,
    retry ? { 'retry-after': String(Math.ceil(retry / 1000)) } : {},
  );
}

/** The idempotency key the site sends: one fal take, one logo, one cap, one template. */
export function renderKey(videoUrl, logoSha256, target, templateVersion) {
  return hash(`${videoUrl}|${logoSha256}|${target}|${templateVersion}`);
}

async function bytesLimited(message, max) {
  const size = Number(message.headers.get('content-length') || 0);
  if (size > max) throw new MediaError(413, 'TOO_LARGE', 'Media is too large.');
  const reader = message.body?.getReader();
  if (!reader) throw new MediaError(400, 'EMPTY', 'Media is empty.');
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max)
        throw new MediaError(413, 'TOO_LARGE', 'Media is too large.');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, length);
}
function authorized(request, token) {
  const expected = Buffer.from(`Bearer ${token || ''}`),
    actual = Buffer.from(request.headers.get('authorization') || '');
  return (
    !!token &&
    token.length >= 24 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
// OpenCV will decode far more formats than the site offers. Only the three a buyer can pick
// reach the decoder, so a crafted file in some other format never gets that far.
function imageKind(bytes) {
  if (
    bytes.length > 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'jpeg';
  if (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}
function decodeLogo(value) {
  if (typeof value !== 'string' || !value)
    throw new MediaError(400, 'LOGO', 'A logo is required.');
  if (value.length > Math.ceil(MAX_UPLOAD / 3) * 4)
    throw new MediaError(413, 'TOO_LARGE', 'The logo is too large.');
  if (value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new MediaError(400, 'LOGO', 'The logo is not valid base64.');
  return Buffer.from(value, 'base64');
}
function originOf(raw) {
  try {
    return raw ? new URL(raw).origin : null;
  } catch {
    return null;
  }
}
// Tests serve takes from their own loopback server. That door exists only under NODE_ENV=test
// and only onto loopback; the container runs with NODE_ENV=production.
function testVideoOrigin(raw) {
  if (process.env.NODE_ENV !== 'test' || !raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

// A boolean in a template cannot enable sales. The qualification binds the exact
// renderer, placement geometry, artwork and masks that passed the real-footage trial.
export async function qualifiedTemplates(config = {}) {
  const at = (path) => resolve(ROOT, path);
  const states = await Promise.all(
    Object.values(templates).map(async (id) => {
      const bytes = await readFile(at(`public/wearables/${id}.json`)),
        manifest = JSON.parse(bytes);
      return {
        id,
        qualified: false,
        sha256: manifest.blankCapImage.sha256,
        manifest,
        manifestHash: hash(bytes),
      };
    }),
  );
  try {
    const proof = JSON.parse(
      await readFile(
        config.qualificationPath
          ? resolve(config.qualificationPath)
          : at('public/wearables/caps-v1-qualification.json'),
        'utf8',
      ),
    );
    if (
      proof.version !== 'caps-v1' ||
      !proof.accepted ||
      !proof.visualReviewed ||
      !proof.negativeTestsPassed ||
      !proof.realOcclusionRejected
    )
      throw Error('Missing trial evidence');
    for (const path of [
      'scripts/wearable-render.py',
      'scripts/wearable_panel.py',
    ])
      if (hash(await readFile(at(path))) !== proof.code?.[path])
        throw Error('Renderer changed');
    for (const state of states) {
      const m = state.manifest,
        p = proof.templates?.[state.id],
        host = m.host === 'host' ? 'pepe' : 'gigachad';
      if (
        !m.qualified ||
        m.qualificationVersion !== proof.version ||
        state.manifestHash !== p?.manifestSha256
      )
        continue;
      if (
        hash(await readFile(at(m.blankCapImage.path))) !== p.image ||
        p.image !== state.sha256
      )
        continue;
      if (
        hash(await readFile(at(m.foregroundMask))) !== p.foregroundMask ||
        hash(await readFile(at(m.logoMask))) !== p.logoMask
      )
        continue;
      const trials =
        proof.trials?.filter(
          (t) => t.host === host && t.audioVerified && t.frames >= 200,
        ) || [];
      if (
        !['graphic', 'text'].every(
          (mark) =>
            trials.filter((t) => t.mark === mark).length >= 3 &&
            trials.some((t) => t.mark === mark && t.heldOut),
        )
      )
        continue;
      state.qualified = true;
    }
  } catch {
    /* Missing or changed proof closes inventory while previews remain available. */
  }
  return states.map(({ id, qualified, sha256 }) => ({ id, qualified, sha256 }));
}

/** What is running, by content: this service and the renderer it drives. */
async function serviceVersion() {
  try {
    const digest = createHash('sha256');
    for (const path of [
      'broadcast/sponsor-media.mjs',
      'scripts/wearable-render.py',
      'scripts/wearable_panel.py',
    ])
      digest.update(await readFile(join(ROOT, path)));
    return digest.digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

// The renderer needs a PATH to find ffmpeg and very little else from this process. In
// particular it never sees the service token.
function rendererEnv() {
  const env = {
    OPENCV_IO_MAX_IMAGE_PIXELS: '16777216',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

const PROBE = [
  'import json, sys',
  "found = {'python': sys.version.split()[0]}",
  "for name in ('cv2', 'numpy'):",
  '    try:',
  '        found[name] = __import__(name).__version__',
  '    except Exception:',
  '        found[name] = None',
  'print(json.dumps(found))',
].join('\n');
async function probeTools(python) {
  const output = async (command, args) => {
    try {
      const { stdout } = await run(command, args, {
        cwd: ROOT,
        env: rendererEnv(),
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  };
  const [py, ffmpeg, ffprobe] = await Promise.all([
    output(python, ['-c', PROBE]),
    output('ffmpeg', ['-version']),
    output('ffprobe', ['-version']),
  ]);
  let found = {};
  try {
    found = JSON.parse(py.trim().split('\n').pop());
  } catch {
    /* No interpreter, or one that could not say what it has. */
  }
  const text = (value) =>
    typeof value === 'string' && value.length < 64 ? value : null;
  const version = (out) => text(out?.match(/version\s+(\S+)/)?.[1]);
  return {
    python: text(found.python),
    cv2: text(found.cv2),
    numpy: text(found.numpy),
    ffmpeg: version(ffmpeg),
    ffprobe: version(ffprobe),
    node: process.versions.node,
  };
}

// What the tracker saw when caps-v1 passed its trials: FFmpeg's plain C conversion of
// unlabelled yuv420p into BGR. The Linux OpenCV wheel ships FFmpeg 8, whose ARM code converts
// differently, and x86 SIMD differs in every version, by up to three levels per channel. That
// is enough for the tracker to lose Pepe's cap on the very footage that qualified. So the desk
// decodes one deterministic probe frame at boot and compares it with this hash, the probe as
// the qualified decoder saw it.
const QUALIFIED_DECODE =
  '023f678169fd27e86f05c565e5d2ad0f328cb7d4269c08c9bd6611e2b39d22ee';
const PROBE_SIZE = 64;
function probeFrame() {
  const frame = Buffer.alloc((PROBE_SIZE * PROBE_SIZE * 3) / 2);
  let seed = 0x5eed1e55;
  for (let i = 0; i < frame.length; i++) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    frame[i] = (t ^ (t >>> 14)) & 255;
  }
  return frame;
}
const broadcastArgs = (source, target, height) => [
  '-v',
  'error',
  '-y',
  '-nostdin',
  '-i',
  source,
  '-map',
  '0:v:0',
  '-map',
  '0:a:0?',
  '-vf',
  `scale=-2:${height}:flags=lanczos`,
  '-c:v',
  'libx264',
  '-crf',
  '18',
  '-preset',
  'fast',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'copy',
  '-movflags',
  '+faststart',
  target,
];
// When OpenCV's own decode is not the qualified one, ffmpeg does the colour conversion instead,
// with SIMD off so it is the C reference on any CPU, into a lossless planar RGB take. OpenCV
// then only reorders bytes, which every build does exactly. Audio is copied untouched.
const convertArgs = (source, target) => [
  '-v',
  'error',
  '-y',
  '-nostdin',
  '-cpuflags',
  '0',
  '-i',
  source,
  '-map',
  '0:v:0',
  '-map',
  '0:a:0?',
  '-vf',
  'format=bgr24,format=gbrp',
  '-c:v',
  'utvideo',
  '-c:a',
  'copy',
  '-fps_mode',
  'passthrough',
  target,
];
const DECODE_CHECK = [
  'import hashlib, sys',
  'import cv2',
  'for path in sys.argv[1:]:',
  '    ok, frame = cv2.VideoCapture(path).read()',
  "    print(hashlib.sha256(frame.tobytes()).hexdigest() if ok else '-')",
].join('\n');
async function calibrateDecoder(python, workdir) {
  const quiet = {
    cwd: ROOT,
    env: rendererEnv(),
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  };
  let dir;
  try {
    dir = await mkdtemp(join(workdir, 'job-probe-'));
    const raw = join(dir, 'probe.yuv'),
      h264 = join(dir, 'probe.mp4'),
      converted = join(dir, 'probe.mov');
    await writeFile(raw, probeFrame());
    // Lossless H.264 carries the probe's exact YUV, signalled like a fal take.
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-nostdin',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        `${PROBE_SIZE}x${PROBE_SIZE}`,
        '-r',
        '24',
        '-i',
        raw,
        '-frames:v',
        '1',
        '-c:v',
        'libx264',
        '-qp',
        '0',
        '-preset',
        'ultrafast',
        '-chroma_sample_location',
        'left',
        h264,
      ],
      quiet,
    );
    await run('ffmpeg', convertArgs(h264, converted), quiet);
    const { stdout } = await run(
      python,
      ['-c', DECODE_CHECK, h264, converted],
      quiet,
    );
    const [direct, viaFfmpeg] = stdout.trim().split('\n');
    return {
      mode:
        direct === QUALIFIED_DECODE
          ? 'direct'
          : viaFfmpeg === QUALIFIED_DECODE
            ? 'convert'
            : null,
      direct: direct?.slice(0, 12),
      converted: viaFfmpeg?.slice(0, 12),
    };
  } catch (error) {
    return {
      mode: null,
      error: String(error?.message || error).slice(0, 200),
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A renderer or converter leads its own process group, so one signal reaches Python and every
// ffmpeg it started. Killing only Python, as execFile's timeout did, left the encoder running.
function spawnGroup(command, args, signal, onSpawn) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: rendererEnv(),
      });
    } catch {
      done({ code: null, signal: null, stderr: 'spawn failed' });
      return;
    }
    let stderr = '',
      finished = false;
    const group = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    };
    const finish = (code, exitSignal) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', group);
      // Anything still in the group once its leader has exited is a straggler.
      group();
      done({ code, signal: exitSignal, stderr });
    };
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stderr.on('error', () => {});
    child.once('error', () => finish(null, null));
    child.once('exit', finish);
    signal.addEventListener('abort', group, { once: true });
    if (signal.aborted) group();
    if (child.pid) onSpawn(child.pid);
  });
}

/**
 * One media desk: its queue, in-flight takes, result cache and the state it measured at boot.
 * The HTTP server and the tests both drive it through `handle`.
 */
export function createMediaService(options = {}) {
  const cfg = { ...DEFAULTS };
  for (const [name, value] of Object.entries(options))
    if (value !== undefined) cfg[name] = value;
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};
  const workdir = resolve(cfg.workdir || 'work/sponsor-media'),
    cacheDir = join(workdir, 'cache');
  const siteOrigin = originOf(cfg.siteOrigin),
    testOrigin = testVideoOrigin(cfg.videoOriginForTests);
  const inflight = new Map(),
    queue = [],
    active = new Set(),
    runs = new Set();
  let previews = 0,
    closing = false,
    expectedRunMs = cfg.minRunMs;

  // Hashing the renderer and ~2.7 MB of templates is boot work, not something to repeat for
  // every health probe. The files cannot change inside a running container.
  const qualification = qualifiedTemplates(cfg).catch(() =>
    Object.values(templates).map((id) => ({
      id,
      qualified: false,
      sha256: null,
    })),
  );
  const version = serviceVersion();
  const prepared = mkdir(cacheDir, { recursive: true }).then(
    () => sweep(),
    () => {},
  );
  // Measured once, like the hashes. Tests that swap in a stand-in renderer name the mode.
  const decoding = prepared
    .then(() =>
      cfg.decoder !== undefined
        ? { mode: cfg.decoder }
        : calibrateDecoder(cfg.python || 'python3', workdir),
    )
    .then((found) => {
      log({
        level: found.mode ? 'info' : 'warn',
        event: 'decoder',
        ...found,
      });
      return found;
    });

  let probe = null,
    probes = 0;
  function tools() {
    const now = Date.now();
    // A failed probe is retried sooner, so a slow first import does not hold readiness back.
    if (!probe || now - probe.at > (probe.ok ? cfg.toolTtlMs : 5_000)) {
      probes++;
      const entry = { at: now, ok: false };
      entry.value = probeTools(cfg.python || 'python3').then((found) => {
        entry.ok = !!(
          found.python &&
          found.cv2 &&
          found.numpy &&
          found.ffmpeg &&
          found.ffprobe
        );
        return found;
      });
      probe = entry;
    }
    return probe;
  }
  tools();

  async function health() {
    const entry = tools();
    const [states, found, running, decode] = await Promise.all([
      qualification,
      entry.value,
      version,
      decoding,
    ]);
    const ready =
      !closing &&
      typeof cfg.token === 'string' &&
      cfg.token.length >= 24 &&
      entry.ok;
    return {
      ready,
      // No refunds means no selling a cap this desk cannot deliver: the qualification holds
      // only where the renderer sees the pixels it was qualified on.
      capQualified: ready && !!decode.mode && states.every((t) => t.qualified),
      templateVersion: TEMPLATE_VERSION,
      templates: states,
      tools: found,
      decoder: decode.mode,
      version: running,
    };
  }

  async function sweep() {
    const now = Date.now(),
      stale = Math.max(cfg.deadlineMs, cfg.previewMs) + 60_000;
    // No live job directory can be older than its deadline, so anything older was left by a
    // process that died mid-take. Newer ones may belong to another desk on the same disk.
    for (const name of await readdir(workdir).catch(() => [])) {
      if (!name.startsWith('job-')) continue;
      const path = join(workdir, name),
        info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > stale)
        await rm(path, { recursive: true, force: true }).catch(() => {});
    }
    const kept = [];
    for (const name of await readdir(cacheDir).catch(() => [])) {
      const path = join(cacheDir, name),
        info = await stat(path).catch(() => null),
        entry = name.endsWith('.entry');
      if (!info) continue;
      if (now - info.mtimeMs > (entry ? cfg.cacheTtlMs : stale))
        await rm(path, { force: true }).catch(() => {});
      else if (entry) kept.push({ path, at: info.mtimeMs });
    }
    kept.sort((a, b) => b.at - a.at);
    for (const old of kept.slice(cfg.cacheMax))
      await rm(old.path, { force: true }).catch(() => {});
  }
  const sweeper = setInterval(() => void sweep(), 60_000);
  sweeper.unref();

  // A finished take is one file: a JSON header line, then the MP4. A single rename publishes
  // it, so a reader never sees a header without its video.
  async function cached(key) {
    let file;
    try {
      file = await readFile(join(cacheDir, `${key}.entry`));
    } catch {
      return null;
    }
    try {
      const cut = file.indexOf(10),
        meta = JSON.parse(file.subarray(0, cut).toString('utf8')),
        bytes = file.subarray(cut + 1);
      if (
        meta.version === (await version) &&
        Date.now() - meta.at <= cfg.cacheTtlMs &&
        hash(bytes) === meta.summary?.outputSha256
      )
        return { bytes, summary: meta.summary };
    } catch {
      /* A torn or foreign entry is a miss; the sweeper or the next take replaces it. */
    }
    return null;
  }
  async function remember(key, bytes, summary) {
    const path = join(cacheDir, `${key}.entry`),
      temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const header = Buffer.from(
      `${JSON.stringify({ at: Date.now(), version: await version, summary })}\n`,
    );
    try {
      const handle = await open(temp, 'w');
      try {
        await handle.writev([header, bytes]);
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  function retryAfterMs() {
    const now = Date.now();
    let soonest = Infinity;
    for (const job of active)
      soonest = Math.min(soonest, job.startedAt + expectedRunMs - now);
    return Math.min(
      60_000,
      Math.max(1_000, Math.round(Number.isFinite(soonest) ? soonest : 1_000)),
    );
  }
  const busy = (retry = retryAfterMs()) =>
    new MediaError(
      503,
      'BUSY',
      'The wardrobe desk is busy. Try again shortly.',
      { retryAfterMs: retry },
    );
  function stopped(reason) {
    if (reason === 'deadline')
      return new MediaError(
        503,
        'DEADLINE',
        'The wardrobe take ran out of time.',
      );
    // A restart hands the take to the replacement desk: BUSY is the answer the site retries.
    if (reason === 'shutdown') return busy(2_000);
    if (reason === 'expired') return busy();
    return new MediaError(503, 'CANCELLED', 'The wardrobe take was cancelled.');
  }

  function settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    job.finishedAt = Date.now();
    for (const timer of job.timers) clearTimeout(timer);
    // Delete by identity: a cancelled take must never unregister its own replacement.
    if (inflight.get(job.key) === job) inflight.delete(job.key);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    log({
      level: error ? 'warn' : 'info',
      event: 'job',
      key: job.label.slice(0, 12),
      outcome: error ? error.code || 'INTERNAL' : 'done',
      queueMs: (job.startedAt ?? job.finishedAt) - job.arrivedAt,
      runMs: job.startedAt ? job.finishedAt - job.startedAt : 0,
      ...job.stages,
    });
    if (error) job.reject(error);
    else job.resolve(result);
  }
  function abort(job, reason) {
    if (job.settled) return;
    if (job.state === 'running') job.controller.abort(reason);
    // Callers hear now; the dying renderer's cleanup runs on and holds its slot until done.
    settle(job, stopped(reason));
  }
  function start(job) {
    job.state = 'running';
    job.startedAt = Date.now();
    active.add(job);
    const work = render(job)
      .then(
        (result) => {
          expectedRunMs = Math.round(
            expectedRunMs * 0.7 + (Date.now() - job.startedAt) * 0.3,
          );
          settle(job, null, result);
        },
        (error) => settle(job, error),
      )
      .finally(() => {
        active.delete(job);
        runs.delete(work);
        pump();
      });
    runs.add(work);
  }
  function pump() {
    while (!closing && active.size < cfg.concurrency && queue.length) {
      const next = queue.shift();
      if (!next.settled) start(next);
    }
  }
  function admit(take, arrivedAt) {
    const deadlineAt = arrivedAt + cfg.deadlineMs,
      startBy = deadlineAt - cfg.minRunMs,
      now = Date.now();
    const free = active.size < cfg.concurrency && !queue.length;
    if (!free && (queue.length >= cfg.queue || now >= startBy)) throw busy();
    const job = {
      ...take,
      arrivedAt,
      deadlineAt,
      state: 'queued',
      waiters: 0,
      settled: false,
      timers: [],
      stages: {},
      controller: new AbortController(),
    };
    job.promise = new Promise((resolveJob, rejectJob) => {
      job.resolve = resolveJob;
      job.reject = rejectJob;
    });
    job.promise.catch(() => {});
    inflight.set(job.key, job);
    job.timers.push(setTimeout(() => abort(job, 'deadline'), deadlineAt - now));
    if (free) start(job);
    else {
      queue.push(job);
      job.timers.push(
        setTimeout(() => {
          if (job.state === 'queued') abort(job, 'expired');
        }, startBy - now),
      );
    }
    return job;
  }
  // Every caller is a waiter on the take. When the last one hangs up there is nobody left to
  // pay for the CPU, so the take is cancelled, queued or running.
  async function follow(job, signal) {
    job.waiters++;
    try {
      return await new Promise((resolveWait, rejectWait) => {
        const gone = () =>
          rejectWait(
            new MediaError(499, 'CLIENT_GONE', 'The caller disconnected.'),
          );
        if (signal?.aborted) return gone();
        signal?.addEventListener('abort', gone, { once: true });
        void job.promise
          .then(resolveWait, rejectWait)
          .finally(() => signal?.removeEventListener('abort', gone));
      });
    } finally {
      job.waiters--;
      if (job.waiters === 0 && !job.settled) abort(job, 'disconnect');
    }
  }

  async function download(url, path, max, signal, jobSignal) {
    const lost = () =>
      jobSignal.aborted
        ? stopped(String(jobSignal.reason))
        : signal.aborted
          ? new MediaError(
              502,
              'DOWNLOAD_TIMEOUT',
              'The rendered take took too long to download.',
            )
          : new MediaError(502, 'DOWNLOAD', 'Media download failed.');
    let response;
    try {
      response = await fetch(url, { redirect: 'error', signal });
    } catch {
      throw lost();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MediaError(502, 'DOWNLOAD', 'Media download failed.');
    }
    if (Number(response.headers.get('content-length') || 0) > max) {
      await response.body?.cancel().catch(() => {});
      throw new MediaError(413, 'TOO_LARGE', 'Media is too large.');
    }
    if (!response.body)
      throw new MediaError(502, 'DOWNLOAD', 'Media download was empty.');
    const handle = await open(path, 'w'),
      digest = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > max)
          throw new MediaError(413, 'TOO_LARGE', 'Media is too large.');
        digest.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      throw error instanceof MediaError ? error : lost();
    } finally {
      await handle.close();
    }
    if (!size)
      throw new MediaError(502, 'DOWNLOAD', 'Media download was empty.');
    return digest.digest('hex');
  }

  async function renderer(args, report, signal, dir) {
    // A preview runs two steps against one report path; the second must not inherit the first.
    await rm(report, { force: true });
    const outcome = await spawnGroup(
      cfg.python || 'python3',
      ['scripts/wearable-render.py', ...args],
      signal,
      (pid) => cfg.onSpawn?.({ pid, mode: args[0], dir }),
    );
    if (signal.aborted) throw stopped(String(signal.reason));
    let result = null;
    try {
      result = JSON.parse(await readFile(report, 'utf8'));
    } catch {
      /* No report: the renderer died before it could explain itself. */
    }
    if (outcome.code === 0 && result) return result;
    if (outcome.code && result && result.accepted === false)
      throw new MediaError(
        422,
        String(result.code || 'INVALID_WEARABLE'),
        // An encoder failure carries ffmpeg's stderr and scratch paths; the buyer needs neither.
        result.code === 'MEDIA_FAILED'
          ? 'The wardrobe take could not be encoded.'
          : String(
              result.error || result.code || 'Artwork could not be verified.',
            ).slice(0, 300),
      );
    log({
      level: 'error',
      event: 'renderer',
      mode: args[0],
      exit: outcome.code,
      signal: outcome.signal,
      stderr: outcome.stderr.slice(-600) || undefined,
    });
    throw new MediaError(
      503,
      'RENDERER',
      'The media worker could not process this file.',
    );
  }

  // Hand the renderer the take as the qualified decoder would see it: unchanged where OpenCV
  // already decodes that way, otherwise converted first.
  async function decodable(video, dir, signal) {
    if ((await decoding).mode !== 'convert') return video;
    const target = join(dir, 'decoded.mov');
    const outcome = await spawnGroup(
      'ffmpeg',
      convertArgs(video, target),
      signal,
      (pid) => cfg.onSpawn?.({ pid, mode: 'convert', dir }),
    );
    if (signal.aborted) throw stopped(String(signal.reason));
    if (outcome.code !== 0) {
      log({
        level: 'warn',
        event: 'convert',
        exit: outcome.code,
        signal: outcome.signal,
        stderr: outcome.stderr.slice(-600) || undefined,
      });
      throw new MediaError(
        422,
        'INVALID_VIDEO',
        'The rendered take could not be decoded.',
      );
    }
    return target;
  }

  // The verified composite at the height the show airs every other shot.
  async function broadcastCut(source, dir, signal) {
    const target = join(dir, 'broadcast.mp4');
    const outcome = await spawnGroup(
      'ffmpeg',
      broadcastArgs(source, target, cfg.broadcastHeight),
      signal,
      (pid) => cfg.onSpawn?.({ pid, mode: 'scale', dir }),
    );
    if (signal.aborted) throw stopped(String(signal.reason));
    if (outcome.code !== 0) {
      log({
        level: 'error',
        event: 'scale',
        exit: outcome.code,
        signal: outcome.signal,
        stderr: outcome.stderr.slice(-600) || undefined,
      });
      throw new MediaError(
        503,
        'RENDERER',
        'The wardrobe take could not be prepared for broadcast.',
      );
    }
    return readFile(target);
  }

  async function render(job) {
    const signal = job.controller.signal;
    await prepared;
    const dir = await mkdtemp(join(workdir, 'job-'));
    try {
      const video = join(dir, 'input.mp4'),
        logo = join(dir, 'logo.png'),
        out = join(dir, 'branded.mp4'),
        report = join(dir, 'report.json');
      const budget = Math.max(
        0,
        Math.min(cfg.downloadMs, job.deadlineAt - Date.now()),
      );
      // One failed download stops its partner rather than letting it run out the budget.
      const halt = new AbortController();
      const fetching = AbortSignal.any([
        signal,
        halt.signal,
        AbortSignal.timeout(budget),
      ]);
      const [takeSha256] = await Promise.all([
        download(job.videoUrl, video, MAX_VIDEO, fetching, signal),
        job.logo
          ? writeFile(logo, job.logo)
          : download(job.logoUrl, logo, MAX_UPLOAD, fetching, signal),
      ]).catch((error) => {
        halt.abort();
        throw error;
      });
      if (!job.logo && hash(await readFile(logo)) !== job.logoSha256)
        throw new MediaError(409, 'LOGO_HASH', 'Artwork hash changed.');
      // Where a slow take spent its time is the first question on a small box.
      const lap = (name, since) => (job.stages[name] = Date.now() - since);
      lap('downloadMs', job.startedAt);
      const converting = Date.now();
      const source = await decodable(video, dir, signal);
      if (source !== video) lap('convertMs', converting);
      const rendering = Date.now();
      const quality = await renderer(
        [
          'render',
          '--manifest',
          `public/wearables/${templates[job.target]}.json`,
          '--asset',
          logo,
          '--video',
          source,
          '--output',
          out,
          '--report',
          report,
        ],
        report,
        signal,
        dir,
      );
      lap('renderMs', rendering);
      if (!quality.accepted || !quality.audioVerified)
        throw new MediaError(
          422,
          'QUALITY',
          'The wardrobe take could not be verified.',
        );
      const rendered = await readFile(out);
      if (hash(rendered) !== quality.outputSha256)
        throw new MediaError(
          503,
          'RENDERER',
          'The wardrobe take failed its integrity check.',
        );
      const scaling = Date.now();
      const bytes = cfg.broadcastHeight
        ? await broadcastCut(out, dir, signal)
        : rendered;
      lap('scaleMs', scaling);
      // The renderer hashed whatever it read; the take the site sent is what this output is of.
      // What leaves is the broadcast cut, so its hash is the one the site checks the body
      // against; the renderer's own output stays on record beside it.
      const summary = {
        ...quality,
        inputSha256: takeSha256,
        renderedSha256: quality.outputSha256,
        outputSha256: hash(bytes),
        ...(cfg.broadcastHeight ? { height: cfg.broadcastHeight } : {}),
      };
      delete summary.tracking;
      await remember(job.key, bytes, summary).catch((error) =>
        log({
          level: 'warn',
          event: 'cache',
          error: String(error?.message || error).slice(0, 200),
        }),
      );
      return { bytes, summary };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function checkedUrl(raw, kind) {
    if (typeof raw !== 'string' || raw.length > 3000)
      throw new MediaError(400, 'URL', 'Invalid media URL.');
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new MediaError(400, 'URL', 'Invalid media URL.');
    }
    if (url.username || url.password || url.hash)
      throw new MediaError(400, 'URL', 'Invalid media URL.');
    const allowed =
      kind === 'video'
        ? (url.protocol === 'https:' &&
            !url.port &&
            (url.hostname === 'fal.media' ||
              url.hostname.endsWith('.fal.media'))) ||
          (!!testOrigin && url.origin === testOrigin)
        : !!siteOrigin &&
          url.origin === siteOrigin &&
          url.pathname.startsWith('/api/sponsorship/assets/');
    if (!allowed)
      throw new MediaError(400, 'HOST', 'Media host is not allowed.');
    return url;
  }

  async function handleRender(request, url, meta, arrivedAt) {
    let payload;
    try {
      payload = JSON.parse(
        (await bytesLimited(request, MAX_RENDER_BODY)).toString('utf8'),
      );
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError(400, 'JSON', 'A JSON render request is required.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new MediaError(400, 'JSON', 'A JSON render request is required.');
    const videoUrl = checkedUrl(payload.videoUrl, 'video');
    if (
      !templates[payload.target] ||
      payload.templateVersion !== TEMPLATE_VERSION
    )
      throw new MediaError(400, 'TEMPLATE', 'Unsupported wardrobe template.');
    if (
      typeof payload.logoSha256 !== 'string' ||
      !HEX64.test(payload.logoSha256)
    )
      throw new MediaError(400, 'LOGO', 'A logo hash is required.');
    if (
      payload.key !== undefined &&
      (typeof payload.key !== 'string' || !HEX64.test(payload.key))
    )
      throw new MediaError(400, 'KEY', 'The render key is malformed.');
    if (
      !(await qualification).find((t) => t.id === templates[payload.target])
        ?.qualified
    )
      throw new MediaError(
        409,
        'NOT_QUALIFIED',
        'This cap has not passed broadcast qualification.',
      );
    if (!(await decoding).mode)
      throw new MediaError(
        409,
        'NOT_QUALIFIED',
        'This desk cannot decode footage the way the caps were qualified.',
      );
    let logo = null,
      logoUrl = null;
    if (payload.logo !== undefined) {
      // The site hands over the stored bytes; they must be exactly what the buyer approved.
      logo = decodeLogo(payload.logo);
      if (logo.length > MAX_UPLOAD)
        throw new MediaError(413, 'TOO_LARGE', 'The logo is too large.');
      if (hash(logo) !== payload.logoSha256)
        throw new MediaError(409, 'LOGO_HASH', 'Artwork hash changed.');
      if (imageKind(logo) !== 'png')
        throw new MediaError(
          409,
          'LOGO_FORMAT',
          'The stored artwork is not a PNG.',
        );
    } else if (payload.logoUrl !== undefined) {
      // The older site fetched nothing itself and sent a URL. Kept so the desk can deploy first.
      if (!siteOrigin)
        throw new MediaError(
          503,
          'LEGACY_UNAVAILABLE',
          'This desk no longer fetches artwork by URL.',
        );
      logoUrl = checkedUrl(payload.logoUrl, 'logo');
    } else throw new MediaError(400, 'LOGO', 'A logo is required.');

    // The cache and the in-flight table are keyed by what this desk computed from the content,
    // never by the caller's label, so a mislabelled request cannot collect another take.
    const key = renderKey(
      payload.videoUrl,
      payload.logoSha256,
      payload.target,
      payload.templateVersion,
    );
    const label = payload.key || key;
    meta.key = label.slice(0, 12);
    if (payload.key && payload.key !== key) meta.keyMismatch = true;
    const respond = (result, cache) => {
      meta.cache = cache;
      return new Response(result.bytes, {
        headers: {
          'content-type': 'video/mp4',
          'x-sponsor-quality': Buffer.from(
            JSON.stringify(result.summary),
          ).toString('base64'),
          'x-sponsor-key': label,
          'x-sponsor-cache': cache,
          'cache-control': 'no-store',
        },
      });
    };
    const hit = await cached(key);
    if (hit) {
      meta.queueMs = 0;
      return respond(hit, 'hit');
    }
    const running = inflight.get(key),
      mode = running ? 'join' : 'miss';
    meta.cache = mode;
    const job =
      running ||
      admit(
        {
          key,
          label,
          videoUrl,
          logo,
          logoUrl,
          logoSha256: payload.logoSha256,
          target: payload.target,
        },
        arrivedAt,
      );
    try {
      const result = await follow(job, request.signal);
      meta.renderMs = job.finishedAt - job.startedAt;
      return respond(result, mode);
    } finally {
      meta.queueMs = Math.max(0, (job.startedAt ?? Date.now()) - arrivedAt);
    }
  }

  async function handlePreview(request, url) {
    const target = url.searchParams.get('target') || 'host',
      kind = url.searchParams.get('kind') || 'logo';
    if (!templates[target] || !['cap', 'logo'].includes(kind))
      throw new MediaError(400, 'PLACEMENT', 'Choose a supported placement.');
    // Previews are quick and have their own seats, so a buyer choosing artwork is never stuck
    // behind a paid render.
    if (previews >= cfg.previewConcurrency) throw busy(1_000);
    previews++;
    const clock = new AbortController(),
      timer = setTimeout(() => clock.abort('deadline'), cfg.previewMs);
    const signal = AbortSignal.any([clock.signal, request.signal]);
    let dir;
    try {
      const upload = await bytesLimited(request, MAX_UPLOAD);
      if (!imageKind(upload))
        throw new MediaError(
          422,
          'INVALID_IMAGE',
          'Use a color PNG, JPG, or WebP image.',
        );
      await prepared;
      dir = await mkdtemp(join(workdir, 'job-'));
      const input = join(dir, 'upload'),
        normalized = join(dir, 'logo.png'),
        output = join(dir, 'output.png'),
        report = join(dir, 'report.json');
      await writeFile(input, upload);
      await renderer(
        [
          'normalize',
          '--asset',
          input,
          '--output',
          normalized,
          '--report',
          report,
        ],
        report,
        signal,
        dir,
      );
      let template = null;
      if (kind === 'cap') {
        const manifest = `public/wearables/${templates[target]}.json`;
        template = JSON.parse(await readFile(join(ROOT, manifest), 'utf8'));
        await renderer(
          [
            'preview',
            '--manifest',
            manifest,
            '--asset',
            normalized,
            '--output',
            output,
            '--report',
            report,
          ],
          report,
          signal,
          dir,
        );
      }
      const logo = await readFile(normalized),
        preview = kind === 'cap' ? await readFile(output) : logo;
      const qualified =
        template &&
        (await qualification).find((t) => t.id === template.id)?.qualified;
      return reply({
        preview: preview.toString('base64'),
        logo: logo.toString('base64'),
        sha256: hash(preview),
        logoSha256: hash(logo),
        templateId: template?.id ?? null,
        templateVersion: template ? TEMPLATE_VERSION : null,
        qualificationVersion: qualified ? TEMPLATE_VERSION : null,
        target,
        kind,
      });
    } catch (error) {
      if (clock.signal.aborted && error?.status === 503)
        throw new MediaError(
          503,
          'DEADLINE',
          'Artwork took too long to prepare.',
        );
      throw error;
    } finally {
      clearTimeout(timer);
      previews--;
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function handle(request, meta = {}) {
    const arrivedAt = Date.now(),
      url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const body = await health();
        return reply(body, body.ready ? 200 : 503);
      }
      if (!authorized(request, cfg.token))
        throw new MediaError(
          401,
          'UNAUTHORIZED',
          'Media authorization required.',
        );
      const known =
        request.method === 'POST' &&
        (url.pathname === '/preview' || url.pathname === '/render');
      if (!known) throw new MediaError(404, 'NOT_FOUND', 'Unknown operation.');
      if (closing) throw busy(2_000);
      return url.pathname === '/render'
        ? await handleRender(request, url, meta, arrivedAt)
        : await handlePreview(request, url);
    } catch (error) {
      let known = error;
      // A caller that hung up mid-upload is not an internal fault.
      if (!(known instanceof MediaError) && request.signal?.aborted)
        known = new MediaError(499, 'CLIENT_GONE', 'The caller disconnected.');
      if (!(known instanceof MediaError)) {
        log({
          level: 'error',
          event: 'internal',
          path: url.pathname,
          error: String(error?.message || error).slice(0, 300),
        });
        known = new MediaError(
          500,
          'INTERNAL',
          'The wardrobe take could not be prepared.',
        );
      }
      meta.code = known.code;
      return failure(known);
    }
  }

  async function close() {
    closing = true;
    clearInterval(sweeper);
    for (const job of [...queue, ...active]) abort(job, 'shutdown');
    await Promise.race([
      Promise.allSettled(runs),
      new Promise((done) => setTimeout(done, 5_000).unref()),
    ]);
  }

  return {
    handle,
    health,
    close,
    booted: prepared,
    status: () => ({
      running: active.size,
      queued: queue.length,
      inflight: inflight.size,
      previews,
      toolProbes: probes,
    }),
  };
}

const services = new WeakMap();
/** One desk per config object, so callers that pass a config get boot-time state reused. */
export function handleMediaRequest(request, config) {
  let service = services.get(config);
  if (!service) services.set(config, (service = createMediaService(config)));
  return service.handle(request);
}

export function configFromEnv(env = process.env) {
  const count = (raw, fallback, min, max) => {
    const value = Number(raw);
    return raw !== undefined && raw !== '' && Number.isInteger(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  };
  return {
    token: env.SPONSOR_MEDIA_TOKEN,
    python: env.WEARABLE_PYTHON || 'python3',
    workdir: env.SPONSOR_MEDIA_WORKDIR || 'work/sponsor-media',
    siteOrigin: env.SPONSOR_SITE_ORIGIN || undefined,
    concurrency: count(env.MEDIA_CONCURRENCY, DEFAULTS.concurrency, 1, 16),
    queue: count(env.MEDIA_QUEUE, DEFAULTS.queue, 0, 100),
    videoOriginForTests:
      env.NODE_ENV === 'test' ? env.SPONSOR_MEDIA_TEST_VIDEO_HOST : undefined,
  };
}

// Railway, like most platforms, says which port to serve on through PORT and routes to it
// from outside the container. A studio laptop sets neither and keeps the desk on loopback.
export function listenAddress(env = process.env) {
  const port = Number(env.SPONSOR_MEDIA_PORT || env.PORT || 4017);
  return {
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : NaN,
    host: env.SPONSOR_MEDIA_HOST || (env.PORT ? '0.0.0.0' : '127.0.0.1'),
  };
}

async function serve(service, log, req, res) {
  const started = performance.now(),
    controller = new AbortController(),
    meta = {},
    path = (req.url || '/').split('?')[0];
  res.once('close', () => {
    // Closed before the answer was written means the caller hung up.
    if (!res.writableFinished) controller.abort();
    log({
      event: 'request',
      method: req.method,
      path,
      status: res.writableFinished ? res.statusCode : 499,
      ms: Math.round(performance.now() - started),
      ...meta,
    });
  });
  let response;
  try {
    const headers = new Headers();
    for (const name of ['authorization', 'content-type', 'content-length'])
      if (typeof req.headers[name] === 'string')
        headers.set(name, req.headers[name]);
    const request = new Request(`http://media.internal${req.url || '/'}`, {
      method: req.method,
      headers,
      signal: controller.signal,
      ...(['GET', 'HEAD'].includes(req.method)
        ? {}
        : { body: req, duplex: 'half' }),
    });
    response = await service.handle(request, meta);
  } catch {
    response = reply(
      { code: 'INTERNAL', error: 'Media service unavailable.' },
      500,
    );
  }
  if (res.destroyed) return;
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    ...Object.fromEntries(response.headers),
    'content-length': body.length,
  });
  res.end(body);
}

/** Serve a desk over HTTP. Port 0 picks a free one; the chosen port is returned. */
export function startMediaServer(
  options = {},
  { port = 0, host = '127.0.0.1' } = {},
) {
  const service = createMediaService(options);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const server = http.createServer(
    (req, res) => void serve(service, log, req, res),
  );
  // An 8 MiB body from the site arrives in seconds; a client that trickles one is not the site.
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  return new Promise((ready, failed) => {
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      const bound = server.address().port;
      ready({
        server,
        service,
        port: bound,
        url: `http://${host.includes(':') ? `[${host}]` : host}:${bound}`,
        async close() {
          await service.close();
          await new Promise((done) => {
            server.close(() => done());
            server.closeIdleConnections();
            setTimeout(() => server.closeAllConnections(), 2_000).unref();
          });
        },
      });
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // One JSON object per line, so Railway's log search can filter on any field. Nothing here
  // carries the token, a logo, or a full key.
  const log = (line) =>
    process.stdout.write(
      `${JSON.stringify({ t: new Date().toISOString(), level: 'info', ...line })}\n`,
    );
  const config = { ...configFromEnv(), log };
  const { port, host } = listenAddress();
  if (Number.isNaN(port)) {
    log({ level: 'error', event: 'boot', error: 'The port is not a number.' });
    process.exit(1);
  }
  const media = await startMediaServer(config, { port, host });
  log({ event: 'listening', port: media.port, host });
  void media.service.health().then((state) =>
    log({
      level: state.ready ? 'info' : 'warn',
      event: 'boot',
      ready: state.ready,
      capQualified: state.capQualified,
      version: state.version,
      tools: state.tools,
      concurrency: config.concurrency,
      queue: config.queue,
      legacyLogoUrl: !!config.siteOrigin,
    }),
  );
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log({ event: 'shutdown', signal });
    setTimeout(() => process.exit(0), 8_000).unref();
    await media.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}
