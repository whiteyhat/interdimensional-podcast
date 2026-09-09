import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  airDefaults,
  extend,
  ffmpegDelay,
  isBusyError,
  isOnAirPhase,
  readMinutes,
  renderDevVars,
  reloaded,
  startAir,
  step,
  studioVarNames,
} from '../broadcast/air-policy.mjs';

const T0 = 1_000_000;
const on = (over = {}) => startAir({ now: T0, minutes: 60, ...over });
/** Walk a run of observations, keeping the last action. */
function run(state, observations) {
  let action = 'ok';
  let reason = '';
  for (const o of observations) ({ state, action, reason } = step(state, o));
  return { state, action, reason };
}

void test('the studio worker only ever receives allowlisted variables', () => {
  const source = {
    FAL_KEY: 'fal-123',
    STUDIO_TOKEN: 'secret',
    INTERACT_ORIGIN: 'https://site.workers.dev',
    COIN_TICKER: 'FROGCLENCH',
    CF_STREAM_TOKEN: 'cf-token',
    CF_ACCOUNT_ID: 'acct',
    CLIENT_RPC_URL: 'https://provider/?api-key=leak',
    RTMP_KEY: 'stream-key',
    AIR_ALERT_WEBHOOK: 'https://hooks.example/x',
    COIN_MINT: '',
  };
  const rendered = renderDevVars(source);
  assert.equal(
    rendered,
    'FAL_KEY=fal-123\nCOIN_TICKER=FROGCLENCH\nSTUDIO_TOKEN=secret\nINTERACT_ORIGIN=https://site.workers.dev\n',
  );
  for (const leak of ['CF_STREAM_TOKEN', 'CF_ACCOUNT_ID', 'CLIENT_RPC_URL', 'RTMP_KEY', 'AIR_ALERT_WEBHOOK'])
    assert.equal(rendered.includes(leak), false, `${leak} must not reach the worker`);
  assert.equal(rendered.includes('COIN_MINT'), false, 'an empty value is left unset, not set to ""');
  assert.equal(studioVarNames.includes('CLIENT_RPC_URL'), false);
  assert.equal(studioVarNames.includes('CF_STREAM_TOKEN'), false);
  assert.throws(() => renderDevVars({ CF_STREAM_TOKEN: 'x' }, ['CF_STREAM_TOKEN']), /never reach/);
  assert.throws(() => renderDevVars({ FAL_KEY: 'a\nSTUDIO_TOKEN=b' }), /newline/);
});

void test('the broadcast length is clamped, and never accepts nonsense', () => {
  assert.equal(readMinutes(720), 720);
  assert.equal(readMinutes('720'), 720);
  assert.equal(readMinutes(0), airDefaults.maxMinutes, 'zero falls back to the default cap');
  assert.equal(readMinutes(-5), airDefaults.maxMinutes);
  assert.equal(readMinutes('soon'), airDefaults.maxMinutes);
  assert.equal(readMinutes(undefined, 60), 60);
  assert.equal(readMinutes(99_999), 2880, 'two days is the ceiling');
});

void test('the encoder backs off, and only the on-air phases are worth encoding', () => {
  assert.equal(ffmpegDelay(0), 0);
  assert.equal(ffmpegDelay(1), 2_000);
  assert.equal(ffmpegDelay(3), 8_000);
  assert.equal(ffmpegDelay(99), 30_000, 'the backoff stops growing');
  for (const phase of ['playing', 'paused', 'waiting']) assert.equal(isOnAirPhase(phase), true);
  for (const phase of ['idle', 'buffering', 'stopped', null]) assert.equal(isOnAirPhase(phase), false);
});

void test('a warming-up page is left alone until it runs out of patience', () => {
  const state = on();
  const early = step(state, { now: T0 + 60_000, phase: 'buffering' });
  assert.equal(early.action, 'ok');
  assert.equal(early.state.ready, false);
  const late = step(state, { now: T0 + airDefaults.readyTimeoutMs, phase: 'buffering' });
  assert.equal(late.action, 'reload');
  assert.match(late.reason, /never reached the air/);
});

void test('a slow warmup that is still building footage is never reloaded', () => {
  // A real warmup on the deployed box sat at 10 of 40 seconds after five minutes, because takes
  // that fail speech verification are retried. Reloading it would throw that footage away and
  // start the same slow climb again, so only a warmup that stops growing counts as stuck.
  let state = on();
  const minute = 60_000;
  for (let i = 1; i <= 20; i++) {
    const result = step(state, { now: T0 + i * minute, phase: 'buffering', buffered: i * 2 });
    assert.equal(result.action, 'ok', `still building at minute ${i}`);
    state = result.state;
  }
  assert.equal(state.buffered, 40);
  assert.equal(state.reloads, 0, 'twenty minutes of progress is patience, not a stall');
  // Now the reserve stops growing: that is a stall, whatever the phase says.
  const stuck = step(state, {
    now: T0 + 20 * minute + airDefaults.readyTimeoutMs,
    phase: 'buffering',
    buffered: 40,
  });
  assert.equal(stuck.action, 'reload');
  assert.match(stuck.reason, /stopped building its reserve/);
});

void test('a reload forgets the footage it threw away', () => {
  const { state } = step(on(), { now: T0 + 60_000, phase: 'buffering', buffered: 30 });
  assert.equal(state.buffered, 30);
  const after = reloaded(state, T0 + 90_000);
  assert.equal(after.buffered, 0, 'the page starts its reserve again, so the box must too');
  assert.equal(after.lastProgressAt, T0 + 90_000, 'and gets the full patience again');
});

void test('playback that stops advancing is reloaded, and a recovered show clears the budget', () => {
  const first = step(on(), { now: T0 + 90_000, phase: 'playing', clip: 'clip-1' });
  assert.equal(first.action, 'ok');
  assert.equal(first.state.ready, true);
  const stalled = step(first.state, {
    now: T0 + 90_000 + airDefaults.stallMs,
    phase: 'playing',
    clip: 'clip-1',
  });
  assert.equal(stalled.action, 'reload', 'the same clip for six minutes is a wedge');
  assert.match(stalled.reason, /stalled/);
  const moving = step(first.state, { now: T0 + 200_000, phase: 'playing', clip: 'clip-2' });
  assert.equal(moving.action, 'ok');
  assert.equal(moving.state.lastClipAt, T0 + 200_000);
  // A reload that works is forgiven: the next wedge gets its own reload rather than going off air.
  const recovered = step(reloaded(first.state, T0 + 300_000), {
    now: T0 + 400_000,
    phase: 'playing',
    clip: 'clip-9',
  });
  assert.equal(recovered.state.reloads, 0, 'reaching the air clears the reload budget');
});

void test('two reloads that do not help end the broadcast instead of looping', () => {
  let state = on();
  const dead = { phase: 'buffering', alive: false };
  const first = step(state, { now: T0 + 10_000, ...dead });
  assert.equal(first.action, 'reload');
  state = reloaded(first.state, T0 + 10_000);
  const second = step(state, { now: T0 + 20_000, ...dead });
  assert.equal(second.action, 'reload');
  state = reloaded(second.state, T0 + 20_000);
  const third = step(state, { now: T0 + 30_000, ...dead });
  assert.equal(third.action, 'off', 'the third failure gives up rather than burning credits');
  assert.match(third.reason, /browser is gone/);
});

void test('a reload six hours into a broadcast still gets a full warmup, not an instant verdict', () => {
  // The warmup patience must be measured from the reload, not from going on air. Measuring it
  // from the start would judge every late reload "never reached the air" on its very next tick
  // and take a healthy long broadcast off the air two ticks later.
  const sixHours = 6 * 60 * 60_000;
  let state = on({ minutes: 1440 });
  state = step(state, { now: T0 + 90_000, phase: 'playing', clip: 'c1' }).state;
  state = reloaded(state, T0 + sixHours);
  const justAfter = step(state, { now: T0 + sixHours + 1000, phase: 'buffering', buffered: 0 });
  assert.equal(justAfter.action, 'ok', 'a fresh reload gets the full warmup allowance');
  assert.match(justAfter.reason, /warming up/);
  const recovered = step(justAfter.state, { now: T0 + sixHours + 120_000, phase: 'playing', clip: 'c2' });
  assert.equal(recovered.action, 'ok');
  assert.equal(recovered.state.reloads, 0, 'coming back clears the reload budget');
});

void test('the cap ends the show, and extending it keeps the show on air', () => {
  const state = on({ minutes: 60 });
  const capped = step(state, { now: T0 + 60 * 60_000, phase: 'playing', clip: 'c' });
  assert.equal(capped.action, 'off');
  assert.match(capped.reason, /scheduled end/);
  const longer = extend(state, 180, T0);
  assert.equal(step(longer, { now: T0 + 60 * 60_000, phase: 'playing', clip: 'c' }).action, 'ok');
  assert.equal(longer.onAirSince, state.onAirSince, 'extending does not restart the clock');
});

void test('extending a broadcast never sets a deadline in the past', () => {
  // `air on --minutes 30` typed five hours into a show must not end it on the spot, which is
  // what anchoring the new deadline to the start time would do.
  const fiveHours = 5 * 60 * 60_000;
  const state = on({ minutes: 600 });
  const shorter = extend(state, 30, T0 + fiveHours);
  assert.ok(shorter.deadlineAt > T0 + fiveHours, 'the deadline stays in the future');
  assert.equal(
    step(shorter, { now: T0 + fiveHours + 1000, phase: 'playing', clip: 'c' }).action,
    'ok',
    'the show keeps going',
  );
  assert.equal(shorter.deadlineAt, state.deadlineAt, 'and a shorter window never cuts it short');
  const later = extend(state, 600, T0 + fiveHours);
  assert.equal(later.deadlineAt, T0 + fiveHours + 600 * 60_000, 'a longer window moves it out');
  // The daily ceiling still holds however often it is extended.
  let creeping = on({ minutes: 600 });
  for (let hour = 1; hour <= 40; hour++) creeping = extend(creeping, 600, T0 + hour * 60 * 60_000);
  assert.equal(creeping.deadlineAt, T0 + 1440 * 60_000, 'no amount of extending passes the cap');
});

void test('extending an accepted 48-hour broadcast preserves its deadline after the default cap', () => {
  const hour = 60 * 60_000;
  const state = on({ minutes: 2880 });
  const now = T0 + 25 * hour;
  const extended = extend(state, 60, now);

  assert.equal(extended.deadlineAt, T0 + 48 * hour, 'the accepted 48-hour window remains intact');
  assert.equal(
    step(extended, { now, phase: 'playing', clip: 'still-playing' }).action,
    'ok',
    'asking for more time must not stop a broadcast that is still within its accepted window',
  );
  const later = extend(extended, 2880, T0 + 47 * hour);
  assert.equal(later.deadlineAt, state.deadlineAt, 'repeated extensions cannot move the accepted cap');
  assert.equal(
    step(later, { now: T0 + 48 * hour, phase: 'playing', clip: 'last-clip' }).action,
    'off',
    'the accepted cap still stops the broadcast on time',
  );
});

void test('a studio elsewhere takes us off air immediately, without a reload', () => {
  const { state } = step(on(), { now: T0 + 90_000, phase: 'playing', clip: 'clip-1' });
  const busy = step(state, {
    now: T0 + 100_000,
    phase: 'playing',
    clip: 'clip-1',
    error: 'Another studio is on air.',
  });
  assert.equal(busy.action, 'off');
  assert.match(busy.reason, /another studio/i);
  assert.equal(isBusyError('Another studio is on air.'), true);
  assert.equal(isBusyError('Provider request failed'), false);
  assert.equal(isBusyError(undefined), false);
});

void test('a show that stops itself is reloaded once, then left off', () => {
  const { state } = step(on(), { now: T0 + 90_000, phase: 'playing', clip: 'clip-1' });
  const stopped = run(state, [{ now: T0 + 120_000, phase: 'stopped', clip: 'clip-1' }]);
  assert.equal(stopped.action, 'reload');
  assert.match(stopped.reason, /stopped itself/);
});
