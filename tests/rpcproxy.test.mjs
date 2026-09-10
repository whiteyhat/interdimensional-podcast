import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['rpcproxy']);
const R = await import('../work/tests/rpcproxy.js');

const call = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });

void test('the calls a wallet needs to pay are forwarded', () => {
  for (const method of [
    'getLatestBlockhash',
    'getGenesisHash',
    'isBlockhashValid',
    'sendTransaction',
    'getSignatureStatuses',
    'simulateTransaction',
    'getAccountInfo',
    'getTokenAccountBalance',
  ]) {
    assert.equal(R.screenRpcCall(call(method)).ok, true, `${method} should be allowed`);
  }
});

void test('the expensive calls someone would borrow the key for are refused', () => {
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

void test('a small batch passes only when every call in it is allowed', () => {
  assert.equal(R.screenRpcCall([call('getLatestBlockhash'), call('getSignatureStatuses')]).ok, true);
  // One bad apple rejects the whole batch, so a disallowed call cannot ride along with a good one.
  const smuggled = R.screenRpcCall([call('getLatestBlockhash'), call('getProgramAccounts')]);
  assert.equal(smuggled.ok, false);
});

void test('malformed and oversized requests are refused before anything is forwarded', () => {
  assert.equal(R.screenRpcCall([]).ok, false, 'empty batch');
  assert.equal(R.screenRpcCall(null).ok, false, 'null');
  assert.equal(R.screenRpcCall('getHealth').ok, false, 'a bare string is not a call');
  assert.equal(R.screenRpcCall([[call('getHealth')]]).ok, false, 'nested arrays');
  assert.equal(R.screenRpcCall({ jsonrpc: '2.0', id: 1 }).ok, false, 'no method');
  assert.equal(R.screenRpcCall({ method: 42 }).ok, false, 'method must be a string');
  const huge = Array.from({ length: R.rpcProxyLimits.maxBatch + 1 }, () => call('getHealth'));
  assert.equal(R.screenRpcCall(huge).ok, false, 'batch over the cap');
});

void test('the allowlist cannot be tricked by casing or padding', () => {
  for (const method of ['GETPROGRAMACCOUNTS', 'getprogramaccounts', ' getLatestBlockhash', 'getLatestBlockhash ']) {
    assert.equal(R.screenRpcCall(call(method)).ok, false, `${JSON.stringify(method)} must not pass`);
  }
});

// ---- cost accounting ------------------------------------------------------------------

void test('a request is charged by what it carries, not by the fact of it', () => {
  // Ten cheap calls cost ten, which is the fix for a batch being a free 10x.
  const ten = R.screenRpcCall(Array.from({ length: 10 }, () => call('getHealth')));
  assert.equal(ten.ok, true);
  assert.equal(ten.units, 10);
  assert.equal(ten.calls.length, 10);
  // The reads an abuser would grind through cost more than the ones a wallet needs.
  assert.equal(R.screenRpcCall(call('getTransaction')).units, 4);
  assert.equal(R.screenRpcCall(call('getTokenAccountsByOwner')).units, 3);
  assert.equal(R.screenRpcCall(call('getHealth')).units, 1);
});

void test('a status poll that searches history is priced as the archival lookup it is', () => {
  assert.equal(R.screenRpcCall(call('getSignatureStatuses', [['sig']])).units, 1);
  assert.equal(
    R.screenRpcCall(call('getSignatureStatuses', [['sig'], { searchTransactionHistory: true }])).units,
    3,
  );
});

void test('a batch too expensive for the endpoint is refused before anything is charged', () => {
  // Five getTransaction is 20 units and fits; six does not.
  assert.equal(R.screenRpcCall(Array.from({ length: 5 }, () => call('getTransaction'))).ok, true);
  const heavy = R.screenRpcCall(Array.from({ length: 6 }, () => call('getTransaction')));
  assert.equal(heavy.ok, false);
  assert.match(heavy.why, /expensive/);
});

void test('a broadcast travels alone and is handed to the route to inspect', () => {
  const alone = R.screenRpcCall(call('sendTransaction', ['AAAA', { encoding: 'base64' }]));
  assert.equal(alone.ok, true);
  assert.equal(alone.send?.method, 'sendTransaction');
  assert.deepEqual(alone.send?.params, ['AAAA', { encoding: 'base64' }]);
  assert.equal(R.screenRpcCall(call('getHealth')).send, null);
  // A relay cannot hide broadcasts inside a batch and pay for them once.
  const hidden = R.screenRpcCall([call('getHealth'), call('sendTransaction', ['AAAA'])]);
  assert.equal(hidden.ok, false);
  assert.match(hidden.why, /alone/);
  assert.equal(hidden.method, 'sendTransaction');
});
