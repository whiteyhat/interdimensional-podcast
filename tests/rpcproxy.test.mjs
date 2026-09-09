import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['rpcproxy']);
const R = await import('../work/tests/rpcproxy.js');

const call = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });

test('the calls a wallet needs to pay are forwarded', () => {
  for (const method of [
    'getLatestBlockhash',
    'sendTransaction',
    'getSignatureStatuses',
    'simulateTransaction',
    'getAccountInfo',
    'getTokenAccountBalance',
  ]) {
    assert.equal(R.screenRpcCall(call(method)).ok, true, `${method} should be allowed`);
  }
});

test('the expensive calls someone would borrow the key for are refused', () => {
  // These are the reason a stolen RPC key is worth stealing.
  for (const method of [
    'getProgramAccounts',
    'getSignaturesForAddress',
    'getBlock',
    'getBlocks',
    'getLeaderSchedule',
    'getSupply',
    'getVoteAccounts',
    'getInflationReward',
  ]) {
    const seen = R.screenRpcCall(call(method));
    assert.equal(seen.ok, false, `${method} must be refused`);
    assert.match(seen.why, new RegExp(method));
    // The route logs and reports this name, so a wallet needing a new method is diagnosable.
    assert.equal(seen.method, method);
  }
});

test('a small batch passes only when every call in it is allowed', () => {
  assert.equal(R.screenRpcCall([call('getLatestBlockhash'), call('getSignatureStatuses')]).ok, true);
  // One bad apple rejects the whole batch, so a disallowed call cannot ride along with a good one.
  const smuggled = R.screenRpcCall([call('getLatestBlockhash'), call('getProgramAccounts')]);
  assert.equal(smuggled.ok, false);
});

test('malformed and oversized requests are refused before anything is forwarded', () => {
  assert.equal(R.screenRpcCall([]).ok, false, 'empty batch');
  assert.equal(R.screenRpcCall(null).ok, false, 'null');
  assert.equal(R.screenRpcCall('getHealth').ok, false, 'a bare string is not a call');
  assert.equal(R.screenRpcCall([[call('getHealth')]]).ok, false, 'nested arrays');
  assert.equal(R.screenRpcCall({ jsonrpc: '2.0', id: 1 }).ok, false, 'no method');
  assert.equal(R.screenRpcCall({ method: 42 }).ok, false, 'method must be a string');
  const huge = Array.from({ length: R.rpcProxyLimits.maxBatch + 1 }, () => call('getHealth'));
  assert.equal(R.screenRpcCall(huge).ok, false, 'batch over the cap');
});

test('the allowlist cannot be tricked by casing or padding', () => {
  for (const method of ['GETPROGRAMACCOUNTS', 'getprogramaccounts', ' getLatestBlockhash', 'getLatestBlockhash ']) {
    assert.equal(R.screenRpcCall(call(method)).ok, false, `${JSON.stringify(method)} must not pass`);
  }
});
