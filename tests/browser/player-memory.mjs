// The on-air Player's regression check for the leak that killed the broadcast box (the story
// is on assignLayers in lib/video-layers.ts). It runs the real Player and engine through
// hundreds of clip changes in Chrome, samples the page and every Chrome process every `every`
// clips, prints the table and the growth per clip, and exits 1 on any condition in `verdict`
// at the bottom of this file. No video is generated.
//
//   node tests/browser/player-memory.mjs [--clips=200] [--every=25] [--pad=4] [--hold=300]
//        [--fixture=bars.mp4] [--no-source] [--headed] [--json=path]
//
// --pad appends N MB to every blob (an mp4 `free` box) so takes are production-sized.
// --hold is milliseconds of real playback per take; 0 plays every take to its natural end.
// --fixture may be an absolute path to a real take; --no-source stubs createMediaElementSource,
// which isolates the audio bus from the picture (the measurement that found the leak).
// Video decoding is forced into the renderer process, as on the box, which has no GPU.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launchChrome, serveRepo } from './chrome.mjs';

const { values: options } = parseArgs({
  strict: true,
  options: {
    clips: { type: 'string', default: '200' },
    every: { type: 'string', default: '25' },
    pad: { type: 'string', default: '4' },
    hold: { type: 'string', default: '300' },
    fixture: { type: 'string', default: 'bars.mp4' },
    'no-source': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});
const clips = Number(options.clips);
const every = Number(options.every);
if (!(clips > 0 && every > 0)) throw Error('--clips and --every must be positive numbers.');
const query = new URLSearchParams({
  fixture: options.fixture,
  pad: options.pad,
  hold: options.hold,
  ...(options['no-source'] ? { noSource: '1' } : {}),
});

const server = await serveRepo({
  name: 'player-memory',
  port: 3340,
  allow: options.fixture.startsWith('/') ? [path.dirname(options.fixture)] : [],
});
const origin = server.origin;
const browser = await launchChrome({
  args: ['--disable-accelerated-video-decode'],
  headless: !options.headed,
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('page error:', error.message));
page.on('console', (message) => {
  if (message.type() === 'error') console.error('console:', message.text());
});
page.on('response', (response) => {
  if (response.status() >= 400) console.error(`${response.status()} ${response.url()}`);
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Runtime.enable');
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.enable');
await page.goto(`${origin}/tests/browser/player-memory.html?${query}`);
await page.waitForFunction(() => !!window.memoryHarness, null, { timeout: 60000 });

const system = await browser.newBrowserCDPSession();
/**
 * Resident size and OS thread count of every Chrome process (Chrome's own list), in one `ps`:
 * `nlwp` on Linux (the box), one row per thread from `ps -M` on macOS.
 */
function usage(pids) {
  const run = (args) => {
    try {
      return execFileSync('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const byPid = new Map();
  if (process.platform === 'darwin') {
    for (const line of run(['-o', 'pid=,rss=', '-p', pids.join(',')]).split('\n').filter(Boolean)) {
      const [pid, rss] = line.trim().split(/\s+/).map(Number);
      byPid.set(pid, { rssMB: rss / 1024, threads: 0 });
    }
    // `ps -M` prints each thread on its own row; the pid column is blank on continuation rows.
    let owner;
    for (const line of run(['-M', '-p', pids.join(',')]).split('\n').slice(1).filter(Boolean)) {
      const pid = Number(line.trim().split(/\s+/)[1]);
      if (pids.includes(pid)) owner = pid;
      const entry = byPid.get(owner);
      if (entry) entry.threads++;
    }
  } else {
    for (const line of run(['-o', 'pid=,rss=,nlwp=', '-p', pids.join(',')]).split('\n').filter(Boolean)) {
      const [pid, rss, threads] = line.trim().split(/\s+/).map(Number);
      byPid.set(pid, { rssMB: rss / 1024, threads });
    }
  }
  return byPid;
}
/** Every Chrome process by pid and type, with its resident size and threads. */
async function processes() {
  const { processInfo } = await system.send('SystemInfo.getProcessInfo');
  const measured = usage(processInfo.map((p) => p.id));
  return processInfo.map((p) => ({
    pid: p.id,
    type: p.type === 'GPU' ? 'gpu-process' : p.type,
    rssMB: measured.get(p.id)?.rssMB ?? 0,
    threads: measured.get(p.id)?.threads ?? 0,
  }));
}
async function liveCount(prototype) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: prototype,
    objectGroup: 'query',
  });
  const { objects } = await cdp.send('Runtime.queryObjects', {
    prototypeObjectId: result.objectId,
    objectGroup: 'query',
  });
  const { result: length } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId,
    functionDeclaration: 'function () { return this.length; }',
    returnByValue: true,
  });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'query' });
  return length.value;
}
async function sample(aired) {
  // Each queryObjects runs a full garbage collection first, so the heap read after them is clean.
  const videos = await liveCount('HTMLVideoElement.prototype');
  const sources = await liveCount('MediaElementAudioSourceNode.prototype');
  const blobs = await liveCount('Blob.prototype');
  const metrics = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
  );
  const dom = await cdp.send('Memory.getDOMCounters');
  const stats = await page.evaluate(() => window.memoryHarness.stats());
  const procs = await processes();
  const renderers = procs.filter((p) => p.type === 'renderer');
  const byType = (type) => procs.filter((p) => p.type === type).reduce((s, p) => s + p.rssMB, 0);
  return {
    aired,
    heapMB: metrics.JSHeapUsedSize / 1048576,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    videos,
    sources,
    blobs,
    urls: stats.outstanding,
    rendererMB: Math.max(0, ...renderers.map((p) => p.rssMB)),
    rendererThreads: Math.max(0, ...renderers.map((p) => p.threads)),
    threads: procs.reduce((s, p) => s + p.threads, 0),
    gpuMB: byType('gpu-process'),
    browserMB: byType('browser'),
    totalMB: procs.reduce((s, p) => s + p.rssMB, 0),
    stats,
  };
}
const columns = [
  ['aired', 5, 0],
  ['heapMB', 7, 1],
  ['nodes', 6, 0],
  ['listeners', 9, 0],
  ['videos', 6, 0],
  ['sources', 7, 0],
  ['blobs', 5, 0],
  ['urls', 4, 0],
  ['rendererMB', 10, 0],
  ['rendererThreads', 15, 0],
  ['threads', 7, 0],
  ['gpuMB', 6, 0],
  ['browserMB', 9, 0],
  ['totalMB', 7, 0],
];
const row = (s) =>
  columns.map(([key, width, digits]) => String(s[key].toFixed(digits)).padStart(width)).join(' ');
function slope(samples, key) {
  const n = samples.length;
  if (n < 2) return 0;
  const xs = samples.map((s) => s.aired);
  const ys = samples.map((s) => s[key]);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

console.log(`Player memory: ${clips} clips, sample every ${every} (${query})`);
console.log(columns.map(([key, width]) => key.padStart(width)).join(' '));
await page.evaluate(() => window.memoryHarness.start());
const samples = [];
const started = Date.now();
try {
  for (let i = 1; i <= clips; i++) {
    await page.evaluate(() => window.memoryHarness.step());
    if (i % every === 0 || i === clips) {
      const s = await sample(i);
      samples.push(s);
      console.log(row(s));
      if (s.stats.failures)
        console.log(`  ${s.stats.failures} playback failures reported; audio ${s.stats.audio}`);
    }
  }
} catch (error) {
  console.error('run failed:', error instanceof Error ? error.message : error);
  process.exitCode = 2;
} finally {
  const seconds = (Date.now() - started) / 1000;
  const report = {
    query: query.toString(),
    seconds,
    perClip: Object.fromEntries(
      columns.slice(1).map(([key]) => [key, slope(samples, key)]),
    ),
    samples,
  };
  const perMinute = (mb) => `${(mb * 6).toFixed(1)} MB per show minute at 6 clips/min`;
  console.log(`\n${samples.length} samples over ${seconds.toFixed(0)} s (${(clips / seconds).toFixed(1)} clips/s)`);
  console.log(`growth per clip: JS heap ${report.perClip.heapMB.toFixed(3)} MB, renderer RSS ${report.perClip.rendererMB.toFixed(2)} MB (${perMinute(report.perClip.rendererMB)}), all Chrome processes ${report.perClip.totalMB.toFixed(2)} MB (${perMinute(report.perClip.totalMB)})`);
  console.log(`per clip: live <video> ${report.perClip.videos.toFixed(2)}, source nodes ${report.perClip.sources.toFixed(2)}, blobs ${report.perClip.blobs.toFixed(2)}, blob URLs ${report.perClip.urls.toFixed(2)}, DOM nodes ${report.perClip.nodes.toFixed(1)}, Chrome threads ${report.perClip.threads.toFixed(2)} (renderer ${report.perClip.rendererThreads.toFixed(2)})`);
  if (options.json) writeFileSync(options.json, JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
  const problems = verdict(report, samples);
  for (const problem of problems) console.log(`FAILED: ${problem}`);
  console.log(problems.length ? 'LEAK or failure: see above.' : 'OK: memory is flat across clips.');
  process.exit(problems.length || process.exitCode ? 1 : 0);
}

/** Every reason the run fails. Exact limits first: they catch the leak within a few dozen clips. */
function verdict(report, samples) {
  const problems = [];
  const last = samples.at(-1);
  // The pool holds one layer per clip the show held at once, and the audio bus routes only those
  // layers; anything above that is an element per clip coming back.
  const held = Math.max(0, ...samples.map((s) => s.stats.maxHeld));
  const worst = (key) => Math.max(0, ...samples.map((s) => s[key]));
  if (worst('sources') > held) problems.push(`${worst('sources')} audio source nodes for at most ${held} clips held at once`);
  const layers = Math.max(0, ...samples.map((s) => s.stats.domVideos));
  if (layers > held) problems.push(`${layers} <video> layers for at most ${held} clips held at once`);
  // Then growth: live elements, threads that keep accumulating (a quarter of a thread per clip is
  // ~450 extra threads in a 30-minute show) and, on long runs only, a renderer that gains a
  // megabyte per clip: resident memory steps up once while caches warm, which would read as
  // growth over a short run.
  if (report.perClip.videos > 0.5) problems.push(`live <video> grows ${report.perClip.videos.toFixed(2)} per clip`);
  if (clips >= 400 && report.perClip.rendererMB > 1) problems.push(`renderer grows ${report.perClip.rendererMB.toFixed(2)} MB per clip`);
  if (report.perClip.threads > 0.25) problems.push(`Chrome threads grow ${report.perClip.threads.toFixed(2)} per clip`);
  // A pooled layer is reused for the next clip: a stall, a decode error or a blocked audio start
  // on any take, a stale event from the layer's previous clip included, fails the run.
  if (last?.stats.failures) problems.push(`the Player reported ${last.stats.failures} playback failure(s)`);
  return problems;
}
