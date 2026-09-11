// Watches a real studio deliver a paid sponsorship: runs /studio headless against a local
// worker whose INTERACT_ORIGIN points at a deployed site, records the stage, captures every
// exchange the writer returns, and stops once the watched order is fulfilled.
//
//   SITE=https://…staging… WATCH=<order id or prefix> STUDIO=http://127.0.0.1:3212 \
//     node scripts/generation-test.mjs
//
// This generates the show for real, at the show's normal cost per minute (docs/LAUNCH.md).
// MAX_MINUTES (default 30) is a hard stop. The browser is muted; captions carry the words.
import { chromium } from 'playwright-core';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const SITE = process.env.SITE;
const WATCH = process.env.WATCH;
const STUDIO = `${process.env.STUDIO || 'http://127.0.0.1:3212'}/studio?autostart=1`;
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 30);
const OUT = process.env.OUT || 'work/generation';
if (!SITE || !WATCH) throw Error('SITE and WATCH are required.');
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/run.log`, '');
writeFileSync(`${OUT}/exchanges.jsonl`, '');
const log = (m) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  appendFileSync(`${OUT}/run.log`, `${line}\n`);
};

// The flags the broadcast box uses: sound may start without a click, and a background tab is
// not throttled. The player fails a clip whose AudioContext is not running.
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: `${OUT}/video`, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
page.on('pageerror', (e) => log(`pageerror ${e.message.slice(0, 160)}`));
page.on('response', async (r) => {
  if (!r.url().includes('/api/podcast') || r.request().method() !== 'POST')
    return;
  try {
    const lines = (await r.json())?.lines;
    if (!Array.isArray(lines) || !lines.length) return;
    appendFileSync(
      `${OUT}/exchanges.jsonl`,
      `${JSON.stringify({ at: Date.now(), lines: lines.map((l) => ({ speaker: l.speaker, text: l.text })) })}\n`,
    );
  } catch {}
});

await page.goto(STUDIO, { waitUntil: 'commit' });
await page.waitForTimeout(4000);
log(
  `audio: ${await page.evaluate(() => {
    const c = new AudioContext();
    const s = c.state;
    void c.close();
    return s;
  })}`,
);

const started = Date.now();
let seen = '';
let shots = 0;
let done = false;
while (!done && Date.now() - started < MAX_MINUTES * 60000) {
  await page.waitForTimeout(10000);
  const overlay = await page
    .evaluate(
      () =>
        document
          .querySelector('.sponsor-on-air')
          ?.innerText?.replace(/\n+/g, ' | ') ?? null,
    )
    .catch(() => null);
  let orders = [];
  try {
    orders =
      (await (await fetch(`${SITE}/api/sponsorship?action=activity`)).json())
        .orders ?? [];
  } catch {}
  const summary = orders
    .slice(0, 6)
    .map((o) => `${o.id.slice(0, 8)}:${o.product}:${o.status}`)
    .join(' ');
  if (summary !== seen) log(`orders ${(seen = summary)}`);
  if (overlay && shots < 20) {
    shots++;
    await page.screenshot({ path: `${OUT}/on-air-${shots}.png` });
    if (shots === 1 || shots % 5 === 0) log(`on air: ${overlay}`);
  }
  if (orders.find((o) => o.id.startsWith(WATCH))?.status === 'fulfilled') {
    log(`${WATCH} fulfilled.`);
    done = true;
  }
}
if (!done) log(`stopped at the ${MAX_MINUTES}-minute cap.`);
await page
  .getByRole('button', { name: /^stop$/i })
  .click({ timeout: 3000 })
  .catch(() => {});
await page.waitForTimeout(3000);
await context.close();
await browser.close();
log(`recording and captures in ${OUT}`);
