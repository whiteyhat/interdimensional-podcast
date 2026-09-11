import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The Workers runtime throws on fetch(url, { redirect: 'error' }): "Invalid redirect value,
// must be one of follow or manual". Node accepts it, so every unit test passed while the
// deployed site could never reach the cap media service: health, logo upload and render
// all threw before sending a byte. Code that runs in the Worker asks for 'manual' instead.
async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

void test('nothing the Worker runs asks fetch to throw on a redirect', async () => {
  const offenders = [];
  for (const root of ['lib', 'app'])
    for await (const path of sources(root)) {
      const text = await readFile(path, 'utf8');
      if (/redirect:\s*['"]error['"]/.test(text)) offenders.push(path);
    }
  assert.deepEqual(offenders, []);
});
