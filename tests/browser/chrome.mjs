// What the real-Chrome runners share: this repository served by its own Vite instance, and
// Google Chrome. The Vite cache is private to each runner (a second Vite root on the shared
// node_modules/.vite breaks the dev server), and ports start above the fixed ones other
// runners use (3314 serve.mjs, 3315 launch-serve.mjs, 3316 the sponsor suites).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Serves the repository; `allow` adds directories outside it that pages may load from. */
export async function serveRepo({ name, port, allow = [] }) {
  const server = await createServer({
    configFile: false,
    root,
    resolve: { alias: { '@': root } },
    plugins: [react()],
    cacheDir: path.join(os.tmpdir(), `${name}-vite`),
    server: { host: '127.0.0.1', port, strictPort: false, hmr: false, fs: { allow: [root, ...allow] } },
    css: { postcss: { plugins: [] } },
    logLevel: 'error',
  });
  await server.listen();
  return { origin: server.resolvedUrls.local[0].replace(/\/$/, ''), close: () => server.close() };
}

/** Google Chrome (the Playwright `chrome` channel, or CHROME_PATH), with sound allowed to start on its own. */
export function launchChrome({ args = [], headless = true } = {}) {
  return chromium.launch({
    headless,
    args: ['--autoplay-policy=no-user-gesture-required', ...args],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  });
}
