// Runs the real-Chrome Player suites (tests/browser/player-*.html) and prints their check
// counts. Each page publishes `window.playerChecks`; a failed check or a page error fails the
// run. Serves this repo through its own Vite instance (tests/browser/chrome.mjs), so it needs
// nothing running beforehand.
//   node tests/browser/player-suites.mjs [page ...]      default: handoff handoff?fallback=1 audio recovery
// Needs Google Chrome (Playwright channel 'chrome'; CHROME_PATH overrides the binary).
import { launchChrome, serveRepo } from './chrome.mjs';

const pages = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['handoff', 'handoff?fallback=1', 'audio', 'recovery'];
const server = await serveRepo({ name: 'player-suites', port: 3330 });
const origin = server.origin;
const browser = await launchChrome();
let failed = false;
try {
  for (const name of pages) {
    const [file, query] = name.split('?');
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/tests/browser/player-${file}.html${query ? `?${query}` : ''}`);
    await page.waitForFunction(() => typeof window.playerChecks !== 'undefined', null, {
      timeout: 60000,
    });
    const result = await page.evaluate(() => window.playerChecks);
    const checks = Array.isArray(result) ? result : (result.checks ?? []);
    const failures = checks.filter((c) => !c.pass).map((c) => c.message);
    const bad = !!result.error || errors.length > 0 || failures.length > 0;
    failed ||= bad;
    console.log(
      `${bad ? 'FAIL' : 'ok  '} player-${name}: ${checks.length - failures.length}/${checks.length}` +
        (result.error ? ` error: ${result.error}` : '') +
        (failures.length ? ` failed: ${failures.join('; ')}` : '') +
        (errors.length ? ` page errors: ${errors.join('; ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
