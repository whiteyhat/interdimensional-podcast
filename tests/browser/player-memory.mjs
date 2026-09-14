// Repeatable memory check for the on-air Player. The broadcast box leaked 100-150 MB per
// minute of show until its page was reloaded, so this runs the real Player and engine through
// hundreds of clip changes in Chrome and samples, after a forced GC every `every` clips:
// the JS heap, DOM node and listener counts, the number of live HTMLVideoElement /
// MediaElementAudioSourceNode / Blob objects, outstanding blob URLs, and the RSS and OS thread
// count of every Chrome process (renderer, GPU, browser, utilities). It prints the table and the
// growth per clip, and exits 1 when live video elements, the renderer or the thread count keep
// growing per clip. Threads are what killed the box: every retained decoder holds threads, and
// after ~40 minutes the container could not create another one, so the studio worker died.
//
//   node tests/browser/player-memory.mjs [--clips=200] [--every=25] [--pad=4] [--hold=300]
//        [--fixture=bars.mp4] [--no-source] [--muted] [--headed] [--json=path]
//
// --pad appends N MB to every blob (an mp4 `free` box) so takes are production-sized.
// --hold is milliseconds of real playback per take; 0 plays every take to its natural end.
// --no-source stubs createMediaElementSource, which isolates the audio bus from the picture.
// Needs Google Chrome (Playwright channel 'chrome'; CHROME_PATH overrides the binary), this
// repo's node_modules, and a free port from 3315 up. Video decoding is forced into the
// renderer process, as it is on the box, which has no GPU. Run from the repo root.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);
const clips = Number(options.clips ?? 200);
const every = Number(options.every ?? 25);
const query = new URLSearchParams({
  fixture: String(options.fixture ?? 'bars.mp4'),
  pad: String(options.pad ?? 4),
  hold: String(options.hold ?? 300),
  ...(options['no-source'] ? { noSource: '1' } : {}),
  ...(options.muted ? { muted: '1' } : {}),
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = await createServer({
  configFile: false,
  root,
  resolve: { alias: { '@': root } },
  plugins: [react()],
  // Never the shared node_modules/.vite: a second Vite root there breaks the dev server.
  cacheDir: path.join(os.tmpdir(), 'player-memory-vite'),
  server: {
    host: '127.0.0.1',
    port: 3315,
    strictPort: false,
    hmr: false,
    // --fixture may be an absolute path (a production-sized take kept outside the repo).
    fs: { allow: [root, ...(String(options.fixture ?? '').startsWith('/') ? [path.dirname(String(options.fixture))] : [])] },
  },
  css: { postcss: { plugins: [] } },
  logLevel: 'error',
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');

const launch = {
  headless: !options.headed,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-accelerated-video-decode',
  ],
};
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
else launch.channel = 'chrome';
const browser = await chromium.launch(launch);
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
/** OS threads of one process: `nlwp` on Linux (the box), one line per thread from `ps -M` on macOS. */
function threadsOf(pid) {
  try {
    const n = Number(execFileSync('ps', ['-o', 'nlwp=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    return execFileSync('ps', ['-M', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').length - 1;
  } catch {
    return 0;
  }
}
/** Every Chrome process by pid and type (Chrome's own list), with its resident size from ps. */
async function processes() {
  const { processInfo } = await system.send('SystemInfo.getProcessInfo');
  let listing = '';
  try {
    listing = execFileSync(
      'ps',
      ['-o', 'pid=,rss=', '-p', processInfo.map((p) => p.id).join(',')],
      { encoding: 'utf8' },
    );
  } catch {
    listing = '';
  }
  const rss = new Map(
    listing
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).map(Number)),
  );
  return processInfo.map((p) => ({
    pid: p.id,
    type: p.type === 'GPU' ? 'gpu-process' : p.type,
    rssMB: (rss.get(p.id) ?? 0) / 1024,
    threads: threadsOf(p.id),
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
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
  );
  const dom = await cdp.send('Memory.getDOMCounters');
  const videos = await liveCount('HTMLVideoElement.prototype');
  const sources = await liveCount('MediaElementAudioSourceNode.prototype');
  const blobs = await liveCount('Blob.prototype');
  const stats = await page.evaluate(() => window.memoryHarness.stats());
  const procs = await processes();
  const renderers = procs.filter((p) => p.type === 'renderer');
  const byType = (type) => procs.filter((p) => p.type === type).reduce((s, p) => s + p.rssMB, 0);
  return {
    aired,
    heapMB: metrics.JSHeapUsedSize / 1048576,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    documents: dom.documents,
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
      ['heapMB', 'nodes', 'videos', 'sources', 'blobs', 'urls', 'rendererMB', 'rendererThreads', 'threads', 'gpuMB', 'browserMB', 'totalMB'].map(
        (key) => [key, slope(samples, key)],
      ),
    ),
    samples,
  };
  const perMinute = (mb) => `${(mb * 6).toFixed(1)} MB per show minute at 6 clips/min`;
  console.log(`\n${samples.length} samples over ${seconds.toFixed(0)} s (${(clips / seconds).toFixed(1)} clips/s)`);
  console.log(`growth per clip: JS heap ${report.perClip.heapMB.toFixed(3)} MB, renderer RSS ${report.perClip.rendererMB.toFixed(2)} MB (${perMinute(report.perClip.rendererMB)}), all Chrome processes ${report.perClip.totalMB.toFixed(2)} MB (${perMinute(report.perClip.totalMB)})`);
  console.log(`per clip: live <video> ${report.perClip.videos.toFixed(2)}, source nodes ${report.perClip.sources.toFixed(2)}, blobs ${report.perClip.blobs.toFixed(2)}, blob URLs ${report.perClip.urls.toFixed(2)}, DOM nodes ${report.perClip.nodes.toFixed(1)}, Chrome threads ${report.perClip.threads.toFixed(2)} (renderer ${report.perClip.rendererThreads.toFixed(2)})`);
  if (options.json) writeFileSync(String(options.json), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
  // A retained element per clip, a renderer that grows by a megabyte per clip, or threads that
  // keep accumulating (a quarter of a thread per clip is ~450 extra threads in a 30-minute show)
  // is the leak.
  const leaking =
    report.perClip.videos > 0.5 ||
    report.perClip.sources > 0.5 ||
    report.perClip.rendererMB > 1 ||
    report.perClip.threads > 0.25;
  // A pooled layer is reused for the next clip: a stall, a decode error or a blocked audio start
  // on any take, a stale event from the layer's previous clip included, is reported by the
  // Player as a playback failure, and one is enough to fail the run.
  const failures = samples.at(-1)?.stats.failures ?? 0;
  if (failures) console.log(`FAILED: the Player reported ${failures} playback failure(s).`);
  console.log(leaking ? 'LEAK: memory grows with every clip.' : 'OK: memory is flat across clips.');
  process.exit(leaking || failures || process.exitCode ? 1 : 0);
}
