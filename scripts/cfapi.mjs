// The Cloudflare REST calls the broadcast scripts make, and the credentials they need.
// These stay on the operator's machine: the deployed Worker never sees them.
import { devVar, VARS } from './devvars.mjs';

const API = 'https://api.cloudflare.com/client/v4';

export async function credentials() {
  const account = await devVar('CF_ACCOUNT_ID');
  const token = await devVar('CF_STREAM_TOKEN');
  if (!account || !token)
    throw Error(
      `Set CF_ACCOUNT_ID and CF_STREAM_TOKEN in ${VARS}.\n` +
        '  Account id: Cloudflare dashboard, right-hand sidebar of any account page.\n' +
        '  Token: My Profile > API Tokens > Create Token > Custom, with Account > Stream > Edit.',
    );
  return { account, token };
}

export async function cf(path, { token }, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const why =
      data.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ||
      `HTTP ${response.status}`;
    // A Stream call that 403s on a valid token usually means Stream is not subscribed.
    throw Error(`Cloudflare refused: ${why}`);
  }
  return data.result;
}

/** The live input id, remembered in .dev.vars so every later command finds it. */
export async function inputId() {
  const id = await devVar('CF_LIVE_INPUT_ID');
  if (!id)
    throw Error('No live input yet. Run: node scripts/stream.mjs create');
  return id;
}

/** Where an encoder pushes video for this live input. This is a credential; treat it as one. */
export async function ingest(creds, uid) {
  const input = await cf(
    `/accounts/${creds.account}/stream/live_inputs/${uid}`,
    creds,
  );
  return { url: input.rtmps.url, key: input.rtmps.streamKey, uid };
}

/**
 * The rehearsal input's ingest, once it is proven safe to talk into: never the show's own input,
 * and never one with simulcast outputs. A rehearsal that reached the public player, pump.fun or
 * X would be the expensive kind of mistake, and nothing else in the pipeline blocks a wrong key,
 * so every rehearsal goes through this one check.
 */
export async function rehearsalIngest() {
  const uid = await devVar('AIR_RTMP_INPUT');
  if (!uid)
    throw Error(
      `Set AIR_RTMP_INPUT in ${VARS} to a rehearsal live input. Make one with: node scripts/stream.mjs create rehearsal`,
    );
  if (uid === (await devVar('CF_LIVE_INPUT_ID')))
    throw Error(
      `AIR_RTMP_INPUT is the show's own live input (${uid}). A rehearsal never goes there: it would reach the public player and every simulcast output.`,
    );
  const creds = await credentials();
  const outputs = await cf(
    `/accounts/${creds.account}/stream/live_inputs/${uid}/outputs`,
    creds,
  );
  if (Array.isArray(outputs) && outputs.length)
    throw Error(
      `Live input ${uid} has ${outputs.length} simulcast output(s). Rehearsals only go to inputs nothing listens to; remove them with scripts/stream.mjs rm, or use another input.`,
    );
  return ingest(creds, uid);
}
