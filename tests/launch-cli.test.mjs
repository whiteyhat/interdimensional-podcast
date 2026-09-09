import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { main, template, checkDisclosure } from '../scripts/launch.mjs';
import { DISCLOSURE } from '../lib/launch/config.mjs';
import { digest } from '../scripts/launch/state.mjs';

void test('init cannot overwrite configuration, and prelaunch reports need no keys, RPC or mint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'launch-cli-'));
  try {
    const configPath = path.join(dir, 'config.json'), out = path.join(dir, 'report.json');
    await main(['init', '--config', configPath]);
    await assert.rejects(() => main(['init', '--config', configPath]), /EEXIST/);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.buyLamports, '');
    await assert.rejects(() => main(['check', '--config', configPath]), /creator/);
    const address = Keypair.generate().publicKey.toBase58();
    Object.assign(config, { creator: address, treasury: address, description: 'Public test', website: 'https://example.com', buyLamports: '1000000', maxTotalLamports: '50000000' });
    config.wallets[0].address = address;
    await writeFile(configPath, JSON.stringify(config));
    await main(['report', '--prelaunch', '--config', configPath, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.mint, null); assert.equal(report.wallets[0].balanceBase, null);
    assert.equal(report.disclosure, DISCLOSURE);
    assert.equal(report.wallets[0].address, address);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
void test('launch checks reject omitted or altered public declarations', async () => {
  const config = { ...template, website: 'https://example.com' };
  const report = { schemaVersion: 1, name: config.name, symbol: config.symbol, network: config.network, disclosure: DISCLOSURE, wallets: config.wallets };
  await checkDisclosure(config, async (_url, json = true) => json ? report : undefined);
  await assert.rejects(() => checkDisclosure(config, async (_url,json = true) => json ? { ...report, wallets: [] } : undefined), /declarations/i);
  await assert.rejects(() => checkDisclosure(config, async () => ({ ...report, disclosure: 'Independent holders' })), /register/i);
});
void test('metadata/config digests do not depend on JSON object property order', () => {
  assert.equal(digest({ name: 'Test', image: 'image' }), digest({ image: 'image', name: 'Test' }));
});
