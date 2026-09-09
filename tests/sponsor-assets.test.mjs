import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { d1 } from './fixtures/d1.mjs';
import { build } from './build.mjs';
await build([
  'sponsor-assets',
  'sponsor-server',
  'sponsor-db',
  'sponsor-pay',
  'sponsorship',
  'requests',
  'interact',
  'producer-lease',
  'throttle',
]);
const { uploadSponsorAsset } = await import('../work/tests/sponsor-assets.js');
const png = Buffer.from('canonical-media-worker-output'),
  logo = Buffer.from('normalized-original-mark');
const hash = (b) => createHash('sha256').update(b).digest('hex');
function request(ip = 'asset-test', origin = 'https://show.test') {
  const form = new FormData();
  form.set('image', new File([png], 'logo.png', { type: 'image/png' }));
  form.set('kind', 'cap');
  form.set('target', 'host');
  return new Request('https://show.test/api/sponsorship/assets', {
    method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip },
    body: form,
  });
}
void test('canonical uploads bind qualification and original logo into immutable asset identities', async () => {
  const DB = d1(),
    objects = new Map(),
    v = {
      DB,
      SITE_URL: 'https://show.test',
      SPONSOR_MEDIA_URL: 'https://media.test',
      SPONSOR_MEDIA_TOKEN: 'a'.repeat(32),
      SPONSOR_ASSETS: {
        async put(key, bytes) {
          objects.set(key, Buffer.from(bytes));
        },
      },
    };
  const originalFetch = globalThis.fetch;
  let qualified = false,
    corrupt = false;
  globalThis.fetch = async () =>
    Response.json({
      preview: png.toString('base64'),
      logo: logo.toString('base64'),
      sha256: corrupt ? 'corrupted' : hash(png),
      logoSha256: hash(logo),
      templateId: 'pepe-cap-v1',
      templateVersion: 'caps-v1',
      qualificationVersion: qualified ? 'caps-v1' : null,
    });
  try {
    const preview = await (await uploadSponsorAsset(request(), v)).json();
    assert.equal(preview.status, 'preview');
    qualified = true;
    const accepted = await (await uploadSponsorAsset(request(), v)).json();
    assert.equal(accepted.status, 'qualified');
    assert.notEqual(accepted.id, preview.id);
    assert.equal(
      DB.sql
        .prepare('SELECT status FROM sponsor_assets WHERE id=?')
        .get(preview.id).status,
      'preview',
      'qualification never rewrites the earlier design',
    );
    const repeated = await (await uploadSponsorAsset(request(), v)).json();
    assert.equal(repeated.id, accepted.id);
    assert.equal(
      DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n,
      2,
    );
    assert.deepEqual(objects.get(`${accepted.id}/logo.png`), logo);
    corrupt = true;
    const invalid = await uploadSponsorAsset(request(), v);
    assert.equal(invalid.status, 502);
    assert.equal(
      DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n,
      2,
      'corrupt media cannot enter inventory',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
void test('cross-origin artwork requests fail before storage or worker calls', async () => {
  const response = await uploadSponsorAsset(
    request('other', 'https://attacker.test'),
    {},
  );
  assert.equal(response.status, 403);
});
