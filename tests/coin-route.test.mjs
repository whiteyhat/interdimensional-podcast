import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { build } from './build.mjs';
await build(['cluster', 'coin', 'http', 'interact']);
// The route reads its mint from the worker env; each test sets its own, which also keeps the
// route's short memo from answering one test with another's result. Every route transpiles to
// route.js, so this one gets its own name rather than racing the podcast route tests for it.
globalThis.coinRouteEnv = {};
const source = ts
  .transpileModule(await readFile('app/api/coin/route.ts', 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  })
  .outputText.replace(/from '@\/lib\/([\w-]+)'/g, "from './$1.js'")
  .replace(
    "import { env } from 'cloudflare:workers';",
    'const env = globalThis.coinRouteEnv;',
  );
await writeFile('work/tests/coin-route.js', source);
const { GET } = await import('../work/tests/coin-route.js');
const get = () => GET(new Request('https://show.test/api/coin'));

void test('a devnet deployment never asks pump.fun about its test mint', async (t) => {
  Object.assign(globalThis.coinRouteEnv, {
    COIN_MINT: 'So11111111111111111111111111111111111111112',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({}),
  );
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { launched: false });
  assert.equal(
    fetch.mock.callCount(),
    0,
    'no upstream call for a mint that cannot exist',
  );
});

void test('pump.fun being down is still reported as an outage on mainnet', async (t) => {
  Object.assign(globalThis.coinRouteEnv, {
    COIN_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x',
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('{}', { status: 503 }),
  );
  const response = await get();
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.launched, true);
  assert.match(body.error, /returned 503/);
});
