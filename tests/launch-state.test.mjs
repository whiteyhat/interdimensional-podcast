import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const S = await import('../scripts/launch/state.mjs').catch(() => ({}));
void test('launch identity survives reopens; config drift and concurrent access fail closed', async () => {
  assert.equal(typeof S.withWorkspace, 'function');
  const dir = await mkdtemp(path.join(tmpdir(), 'launch-state-'));
  try {
    const first = await S.withWorkspace(dir, async (store) => {
      const state = await store.identity({ name: 'one' });
      await assert.rejects(() => S.withWorkspace(dir, async () => {}), /locked/i);
      return state;
    });
    const second = await S.withWorkspace(dir, store => store.identity({ name: 'one' }));
    assert.equal(first.mint, second.mint);
    assert.equal(first.id, second.id);
    assert.equal((await stat(path.join(dir, 'mint-keypair.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).mint, first.mint);
    await assert.rejects(() => S.withWorkspace(dir, store => store.identity({ name: 'changed' })), /changed/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
