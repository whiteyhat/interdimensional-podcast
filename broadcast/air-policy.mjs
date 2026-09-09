// The decisions the broadcast box makes while it is on air, as pure functions.
//
// The supervisor owns processes; this file owns judgement. Keeping them apart is what makes
// "reload once, then give up", "stop at the cap" and "never publish a credential" testable
// without a display, a browser or a stream.

/** Everything the operator can tune, and the numbers we default to. */
export const airDefaults = {
  /** Hard stop. A forgotten broadcast is the expensive kind: generation is $22-90/hr. */
  maxMinutes: 1440,
  /**
   * How long the show may make NO progress before it counts as stuck. Measured from the last
   * sign of life, not from going on air: a warmup whose takes are rejected and retried can run
   * far past any fixed deadline, and reloading it would throw away the footage it has built.
   */
  readyTimeoutMs: 600_000,
  /** A clip is ~10s. Six minutes without one means playback is wedged. */
  stallMs: 360_000,
  /** Consecutive reloads that fail to bring the show back before we go off air. */
  maxReloads: 2,
  /** How often the supervisor asks the page how it is doing. */
  pollMs: 15_000,
  /** Encoder restarts back off, but stay inside Cloudflare's reconnect window. */
  ffmpegBackoffMs: [2_000, 4_000, 8_000, 15_000, 30_000],
};

/**
 * Variables the box may hand to the studio worker. An allowlist rather than a denylist: a new
 * operator-side secret must be added here deliberately, so it cannot leak by being forgotten.
 *
 * Deliberately absent: CF_ACCOUNT_ID, CF_STREAM_TOKEN, CF_LIVE_INPUT_ID (operator-side only,
 * the worker never needs them) and CLIENT_RPC_URL (served to every visitor; setting it
 * publishes the provider key).
 */
export const studioVarNames = Object.freeze([
  'FAL_KEY',
  'NEWSDESK_URL',
  'NEWSDESK_TOKEN',
  'NEWSDESK_X_HANDLES',
  'COIN_MINT',
  'COIN_NAME',
  'COIN_TICKER',
  'TREASURY_WALLET',
  'SOLANA_RPC_URL',
  'PRICE_FIXED',
  'STUDIO_TOKEN',
  'STUDIO_ID',
  'INTERACT_ORIGIN',
  'INTERACT_USD',
  'CHART_MINT',
  'DIRECTOR_SESSION_SECONDS',
  'WRITER_STRICT_VOICE',
]);
const NEVER_FORWARD = /^(CF_|CLIENT_RPC_URL$)/;

/**
 * The `.dev.vars` file the studio worker reads, built from the box's environment. Values are
 * written raw on one line each, which is the format wrangler parses; a value carrying a newline
 * would silently define a second variable, so those are refused rather than truncated.
 */
export function renderDevVars(source, names = studioVarNames) {
  const lines = [];
  for (const name of names) {
    if (NEVER_FORWARD.test(name)) throw Error(`${name} must never reach the studio worker.`);
    const value = source[name];
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    if (/[\r\n]/.test(text)) throw Error(`${name} contains a newline and cannot be forwarded.`);
    lines.push(`${name}=${text}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Minutes the operator asked for, clamped to something a box can actually stay awake for. */
export function readMinutes(raw, fallback = airDefaults.maxMinutes) {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return Math.min(Math.round(minutes), 2880);
}

/** How long to wait before restarting the encoder after `failures` consecutive exits. */
export function ffmpegDelay(failures, backoff = airDefaults.ffmpegBackoffMs) {
  if (failures <= 0) return 0;
  return backoff[Math.min(failures, backoff.length) - 1];
}

/** The show is only worth encoding once there is a picture; before that we would air a poster. */
export const isOnAirPhase = (phase) => phase === 'playing' || phase === 'paused' || phase === 'waiting';

/** A studio elsewhere claimed the queue. Retrying would only fight it, and pay twice. */
export const isBusyError = (error) => typeof error === 'string' && /another studio is on air/i.test(error);

export function startAir({ now, minutes = airDefaults.maxMinutes, config = airDefaults }) {
  return {
    onAirSince: now,
    deadlineAt: now + readMinutes(minutes, config.maxMinutes) * 60_000,
    ready: false,
    clip: null,
    lastClipAt: now,
    /** Footage the show has decoded, and when it last grew. Growth is what "not stuck" means. */
    buffered: 0,
    lastProgressAt: now,
    reloads: 0,
    config,
  };
}

/** A reload rewinds the clocks: the page has 60-90s of warmup ahead of it all over again. */
export function reloaded(state, now) {
  return {
    ...state,
    ready: false,
    clip: null,
    lastClipAt: now,
    buffered: 0,
    lastProgressAt: now,
    reloads: state.reloads + 1,
  };
}

/**
 * Push the cap out without interrupting the show. Measured from now, and never backwards: a
 * broadcast already older than the requested window would otherwise be given a deadline in the
 * past, which the cap timer turns into an immediate shutdown.
 */
export function extend(state, minutes, now) {
  const asked = (now ?? state.onAirSince) + readMinutes(minutes, state.config.maxMinutes) * 60_000;
  // Bound new extensions without shortening a longer duration accepted at startup.
  const ceiling = state.onAirSince + readMinutes(Infinity, state.config.maxMinutes) * 60_000;
  return { ...state, deadlineAt: Math.max(state.deadlineAt, Math.min(asked, ceiling)) };
}

/**
 * One observation of the page, folded into the state, with the action it calls for.
 *
 * `action` is one of:
 *   ok     - nothing to do
 *   reload - the page is wedged; reload it and eat the rebuffer
 *   off    - go off air (the cap, a studio elsewhere, or reloads that did not help)
 */
export function step(state, observation) {
  const { now, phase = null, clip = null, error = '', alive = true, buffered = 0 } = observation;
  const config = state.config ?? airDefaults;
  let next = state;
  if (alive && clip && clip !== state.clip) next = { ...next, clip, lastClipAt: now };
  // Footage arriving is progress even before anything plays, and it is the only thing that
  // separates a slow warmup from a wedged one.
  if (alive && buffered > (next.buffered ?? 0)) next = { ...next, buffered, lastProgressAt: now };
  // Reaching the air clears the reload budget: whatever went wrong, the show recovered.
  if (alive && !next.ready && isOnAirPhase(phase)) next = { ...next, ready: true, reloads: 0 };

  const decide = (reason) =>
    next.reloads >= config.maxReloads
      ? { state: next, action: 'off', reason: `${reason}; reloading did not bring the show back` }
      : { state: next, action: 'reload', reason };

  if (isBusyError(error)) return { state: next, action: 'off', reason: 'another studio is on air' };
  if (now >= next.deadlineAt)
    return { state: next, action: 'off', reason: 'the scheduled end of the broadcast' };
  if (!alive) return decide('the browser is gone');
  if (!next.ready)
    return now - (next.lastProgressAt ?? next.onAirSince) >= config.readyTimeoutMs
      ? decide('the show stopped building its reserve and never reached the air')
      : { state: next, action: 'ok', reason: `warming up, ${next.buffered ?? 0}s of footage ready` };
  if (phase === 'stopped' || phase === 'idle') return decide('the show stopped itself');
  if (now - next.lastClipAt >= config.stallMs) return decide('playback stalled');
  return { state: next, action: 'ok', reason: 'on air' };
}
