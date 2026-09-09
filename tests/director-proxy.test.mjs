import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['director-proxy']);
const { directorProxy } = await import('../work/tests/director-proxy.js');
const request = (
  target = 'https://wma.fal.run/session',
  body = { app_id: 'minimax/h3-max/director', sdp: 'v=0', type: 'offer' },
  origin = 'http://127.0.0.1:3212',
  url = 'http://127.0.0.1:3212/api/director',
) =>
  new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-fal-target-url': target,
    },
    body: JSON.stringify(body),
  });
test('only the local producer can reach an allowlisted Director operation', async () => {
  for (const req of [
    request('https://evil.example/session'),
    request('https://wma.fal.run/session?redirect=x'),
    request('https://key@wma.fal.run/session'),
    request(undefined, {
      app_id: 'expensive/model',
      sdp: 'v=0',
      type: 'offer',
    }),
    request(undefined, undefined, 'https://evil.example'),
    request(
      undefined,
      undefined,
      'https://public.example',
      'https://public.example/api/director',
    ),
  ]) {
    const response = await directorProxy(req, 'secret', () => {
      assert.fail('must not reach provider');
    });
    assert.ok([400, 403].includes(response.status));
  }
});
test('forwards only provider authentication and the validated payload with redirects disabled', async () => {
  let calls = 0;
  const response = await directorProxy(
    request(),
    'secret',
    async (url, init) => {
      calls++;
      assert.equal(url, 'https://wma.fal.run/session');
      assert.equal(init.headers.Authorization, 'Key secret');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.origin, undefined);
      assert.equal(JSON.parse(init.body).app_id, 'minimax/h3-max/director');
      return Response.json(
        { session_id: '123', sdp: 'v=0' },
        { headers: { 'x-private': 'hidden' } },
      );
    },
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-private'), null);
  assert.equal((await response.json()).session_id, '123');
});
test('heartbeat, ICE and fallback are admitted; missing keys and oversized requests fail closed', async () => {
  for (const [target, payload] of [
    ['https://wma.fal.run/ice', { app_id: 'minimax/h3-max/director' }],
    ['https://wma.fal.run/session/heartbeat', { session_id: 'abc-123' }],
    ['https://fal.run/minimax/h3-max/director/ice', {}],
  ]) {
    const response = await directorProxy(
      request(target, payload),
      'secret',
      async () => Response.json({ ok: true }),
    );
    assert.equal(response.status, 200);
  }
  assert.equal((await directorProxy(request(), undefined)).status, 503);
  assert.equal(
    (
      await directorProxy(
        request(undefined, {
          app_id: 'minimax/h3-max/director',
          sdp: 'x'.repeat(140000),
          type: 'offer',
        }),
        'secret',
      )
    ).status,
    413,
  );
});

test('upstream redirects cannot carry the provider key to another destination', async () => {
  let calls = 0;
  const response = await directorProxy(request(), 'secret', async () => {
    calls++;
    return new Response(null, {
      status: 307,
      headers: { location: 'https://evil.example' },
    });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);
});
