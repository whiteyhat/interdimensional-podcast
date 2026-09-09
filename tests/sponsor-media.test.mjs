import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  handleMediaRequest,
  qualifiedTemplates,
} from '../broadcast/sponsor-media.mjs';
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
void test('normalized upload returns the canonical cap image and immutable hashes', async () => {
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
});
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
void test('malformed images and remote video targets fail before any broadcast output', async () => {
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
});
