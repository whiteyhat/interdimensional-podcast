import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['cluster']);
const { clusterOf, explorerTx } = await import('../work/tests/cluster.js');

void test('a deployment is on devnet only when its RPC says so', () => {
  assert.equal(clusterOf('https://api.devnet.solana.com'), 'devnet');
  assert.equal(clusterOf('http://127.0.0.1:8899'), 'devnet');
  assert.equal(clusterOf('http://localhost:8899'), 'devnet');
  assert.equal(
    clusterOf('https://mainnet.helius-rpc.com/?api-key=x'),
    'mainnet-beta',
  );
  // Providers that name the cluster in the path or a subdomain.
  assert.equal(clusterOf('https://rpc.ankr.com/solana_devnet'), 'devnet');
  assert.equal(
    clusterOf('https://x.solana-devnet.quiknode.pro/abc123/'),
    'devnet',
  );
  // An API key can spell anything; only the host and path say which cluster it is.
  assert.equal(
    clusterOf('https://mainnet.helius-rpc.com/?api-key=devnet-looking-key'),
    'mainnet-beta',
  );
  assert.equal(
    clusterOf('https://rpc.example.com/?cluster=devnet'),
    'mainnet-beta',
  );
  assert.equal(
    clusterOf('https://solana-mainnet.example.com/devnet-proxy'),
    'mainnet-beta',
    'a host that says mainnet is mainnet',
  );
  assert.equal(clusterOf('not a url'), 'mainnet-beta');
  // Unset means the default mainnet RPC, never test pricing.
  assert.equal(clusterOf(undefined), 'mainnet-beta');
  assert.equal(clusterOf('  '), 'mainnet-beta');
});

void test('a payment links to the explorer of the cluster it settled on', () => {
  assert.equal(explorerTx('abc', 'mainnet-beta'), 'https://solscan.io/tx/abc');
  assert.equal(
    explorerTx('abc', 'devnet'),
    'https://solscan.io/tx/abc?cluster=devnet',
  );
});
