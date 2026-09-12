import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rehearsalSettings } = await import('../scripts/rehearsal-box.mjs');
const { SITES } = await import('../scripts/media.mjs');

const studio = {
  FAL_KEY: 'fal',
  STUDIO_TOKEN: 'token',
  STUDIO_ID: 'this-mac',
  INTERACT_ORIGIN: 'https://frogclench.fun',
  SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x',
  COIN_NAME: 'Frog',
  AIR_ALERT_WEBHOOK: 'https://hooks.example/air',
};
const rtmp = {
  url: 'rtmps://live.cloudflare.com:443/live/',
  key: 'rehearsal-key',
};

void test('the rehearsal box is a devnet studio on the rehearsal input, never the show', () => {
  const settings = rehearsalSettings(studio, rtmp);
  // Orders come from the devnet site even when this machine points at production.
  assert.equal(settings.INTERACT_ORIGIN, SITES.devnet.origin);
  assert.match(settings.SOLANA_RPC_URL, /devnet/);
  // A name of its own, so the one-studio-at-a-time guard stays on.
  assert.equal(settings.STUDIO_ID, 'rehearsal-box');
  assert.notEqual(settings.STUDIO_ID, studio.STUDIO_ID);
  assert.equal(settings.RTMP_KEY, 'rehearsal-key');
  // The box's own default is an hour, and everything else a box reads rides along unchanged.
  assert.equal(settings.AIR_MAX_MINUTES, '60');
  assert.equal(settings.AIR_ALERT_WEBHOOK, studio.AIR_ALERT_WEBHOOK);
  assert.equal(settings.COIN_NAME, 'Frog');
});

void test('a rehearsal box without a generator key or a studio token is refused', () => {
  assert.throws(
    () => rehearsalSettings({ ...studio, FAL_KEY: '' }, rtmp),
    /FAL_KEY/,
  );
  assert.throws(
    () => rehearsalSettings({ ...studio, STUDIO_TOKEN: undefined }, rtmp),
    /STUDIO_TOKEN/,
  );
});
