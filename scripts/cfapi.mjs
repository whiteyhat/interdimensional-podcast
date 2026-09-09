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
      data.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${response.status}`;
    // A Stream call that 403s on a valid token usually means Stream is not subscribed.
    throw Error(`Cloudflare refused: ${why}`);
  }
  return data.result;
}

/** The live input id, remembered in .dev.vars so every later command finds it. */
export async function inputId() {
  const id = await devVar('CF_LIVE_INPUT_ID');
  if (!id) throw Error('No live input yet. Run: node scripts/stream.mjs create');
  return id;
}

/** Where an encoder pushes video for this live input. This is a credential; treat it as one. */
export async function ingest(creds, uid) {
  const input = await cf(`/accounts/${creds.account}/stream/live_inputs/${uid}`, creds);
  return { url: input.rtmps.url, key: input.rtmps.streamKey, uid };
}
