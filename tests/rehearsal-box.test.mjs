import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rehearsalSettings, DEVNET_SITE, SERVICE } =
  await import('../scripts/rehearsal-box.mjs');

const studio = {
  FAL_KEY: 'fal',
  STUDIO_TOKEN: 'token',
  STUDIO_ID: 'this-mac',
  INTERACT_ORIGIN: 'https://frogclench.fun',
  SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x',
  COIN_NAME: 'Frog',
  NEWSDESK_URL: '',
};
const rtmp = {
  url: 'rtmps://live.cloudflare.com:443/live/',
  key: 'rehearsal-key',
};

void test('the rehearsal box is a devnet studio on the rehearsal input, never the show', () => {
  const settings = rehearsalSettings(studio, rtmp);
  // Orders come from the devnet site even when this machine points at production.
  assert.equal(settings.INTERACT_ORIGIN, DEVNET_SITE);
  assert.match(settings.SOLANA_RPC_URL, /devnet/);
  // A name of its own, so the one-studio-at-a-time guard stays on.
  assert.equal(settings.STUDIO_ID, 'rehearsal-box');
  assert.notEqual(settings.STUDIO_ID, studio.STUDIO_ID);
  assert.equal(settings.RTMP_KEY, 'rehearsal-key');
  // It goes off air by itself.
  assert.equal(settings.AIR_MAX_MINUTES, '60');
  assert.equal(rehearsalSettings(studio, rtmp, 30).AIR_MAX_MINUTES, '30');
  // Empty settings are left out rather than overwriting the box with blanks.
  assert.equal('NEWSDESK_URL' in settings, false);
  assert.equal(settings.COIN_NAME, 'Frog');
  assert.notEqual(SERVICE, 'broadcast-box');
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
