// What every broadcast box has in common, shared by the show's box (scripts/air.mjs) and the
// devnet rehearsal box (scripts/rehearsal-box.mjs): the settings only a box reads, how it is
// configured on Railway, and how its control API is called. Two boxes that assembled these on
// their own drifted apart in five places nobody chose.
import { devVar, VARS } from './devvars.mjs';

/** Settings the box needs beyond the ones the studio worker itself reads. */
export const boxOnlyVarNames = Object.freeze([
  'AIR_MAX_MINUTES',
  'AIR_HEIGHT',
  'AIR_FPS',
  'AIR_BITRATE',
  'AIR_ALERT_WEBHOOK',
]);

/** How a box runs on Railway: the same image, healthcheck and restart rules for both. */
export const boxInstance = Object.freeze({
  dockerfilePath: 'Dockerfile',
  healthcheckPath: '/air/health',
  healthcheckTimeout: 300,
  restartPolicyType: 'ALWAYS',
  restartPolicyMaxRetries: 10,
  numReplicas: 1,
  sleepApplication: false,
});

/** The `--minutes N` flag of an `on` command; undefined leaves the box to its own default. */
export function minutesFlag(args) {
  const at = args.indexOf('--minutes');
  if (at < 0) return undefined;
  const minutes = Number(args[at + 1]);
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw Error('--minutes takes a whole number of minutes.');
  return minutes;
}

/**
 * A client for one box's control API. `urlVar` names the .dev.vars entry holding its address
 * and `setup` the command that writes it, so the error a fresh machine gets says what to run.
 */
export function boxClient(urlVar, setup) {
  async function url() {
    const saved = await devVar(urlVar);
    if (!saved) throw Error(`The box has no address yet. Run: ${setup}`);
    return saved.replace(/\/$/, '');
  }
  async function call(path, { method = 'GET', body } = {}) {
    const token = await devVar('STUDIO_TOKEN');
    if (!token)
      throw Error(`Set STUDIO_TOKEN in ${VARS}; it is what the box trusts.`);
    const response = await fetch(`${await url()}${path}`, {
      method,
      headers: {
        'x-studio-token': token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(300_000),
    });
    if (path.endsWith('.jpg')) {
      if (!response.ok) throw Error(`The box answered ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(data.error || `The box answered ${response.status}.`);
    return data;
  }
  return { url, call };
}
