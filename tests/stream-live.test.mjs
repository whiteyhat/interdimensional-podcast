import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['hooks/use-stream-live']);
const s = await import('../work/tests/use-stream-live.js');

void test('a Cloudflare player points at the live input state beside it', () => {
  assert.equal(
    s.lifecycleUrl(
      'https://customer-abc123.cloudflarestream.com/8c2ccfe3082b71c778b0ee8b5fb1abcb/iframe',
    ),
    'https://customer-abc123.cloudflarestream.com/8c2ccfe3082b71c778b0ee8b5fb1abcb/lifecycle',
  );
  // Whatever the player URL carries, the state lives at the same uid.
  assert.equal(
    s.lifecycleUrl(
      'https://customer-abc123.cloudflarestream.com/deadbeef/iframe?autoplay=true&muted=true',
    ),
    'https://customer-abc123.cloudflarestream.com/deadbeef/lifecycle',
  );
});
void test('anything we cannot ask about is left to the caller to judge', () => {
  // Null, not a guess: the caller falls back to the studio's own word rather than
  // gambling on a player that renders blank when it has nothing to show.
  for (const embed of [
    null,
    '',
    'not a url',
    'https://youtube.com/embed/xyz',
    'https://cloudflarestream.com/',
    'https://evil-cloudflarestream.com.attacker.test/uid/iframe',
  ])
    assert.equal(s.lifecycleUrl(embed), null, String(embed));
});
