import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { NETWORKS } from '../lib/launch/config.mjs';
import { reviewPrepared, reviewedDigest } from '../lib/launch/artifact.mjs';
import { assertNetwork } from '../scripts/launch/chain.mjs';
import { launchFixture } from './fixtures/launch.mjs';

// Captured from api.mainnet-beta.solana.com and api.devnet.solana.com on 2026-09-13.
// Keep these getGenesisHash responses independent of the implementation.
const rpcGenesisHashes = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};

void test('launch networks pin the complete canonical 32-byte RPC genesis hashes', () => {
  assert.deepEqual(NETWORKS, rpcGenesisHashes);
  for (const genesisHash of Object.values(NETWORKS)) {
    const decoded = new PublicKey(genesisHash);
    assert.equal(decoded.toBytes().byteLength, 32);
    assert.equal(decoded.toBase58(), genesisHash);
  }
});

for (const [network, genesisHash] of Object.entries(rpcGenesisHashes)) {
  void test(`RPC network verification accepts ${network} and rejects the other network or a truncated hash`, async () => {
    await assert.doesNotReject(assertNetwork({ getGenesisHash: async () => genesisHash }, network));
    const opposite = Object.entries(rpcGenesisHashes).find(([name]) => name !== network)[1];
    await assert.rejects(assertNetwork({ getGenesisHash: async () => opposite }, network), /network does not match/);
    await assert.rejects(assertNetwork({ getGenesisHash: async () => genesisHash.slice(0, 32) }, network), /network does not match/);
  });
}

void test('wallet review accepts the real devnet genesis and rejects stale or cross-network artifacts', async () => {
  const { artifact, connection } = await launchFixture();
  const devnet = { ...connection, getGenesisHash: async () => rpcGenesisHashes.devnet };
  const reviewed = await reviewPrepared(artifact, devnet);
  assert.equal(reviewed.artifact.genesisHash, rpcGenesisHashes.devnet);
  const stale = { ...artifact, genesisHash: rpcGenesisHashes.devnet.slice(0, 32) };
  await assert.rejects(reviewPrepared(stale, devnet), /network does not match/);
  await assert.rejects(reviewPrepared(artifact, { ...connection, getGenesisHash: async () => rpcGenesisHashes['mainnet-beta'] }), /network does not match/);
  assert.notEqual(reviewedDigest(artifact), reviewedDigest(stale), 'the wallet review digest binds the full genesis hash');
});
