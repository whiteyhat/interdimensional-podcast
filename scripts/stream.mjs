// The broadcast plumbing. OBS pushes one RTMPS stream at Cloudflare, and Cloudflare fans it
// out to X, to pump.fun, and to the player on the public site. Managing the destinations from
// here rather than a dashboard means launch night is a command, not a scavenger hunt.
//
//   node scripts/stream.mjs create            make the live input; prints ingest + embed
//   node scripts/stream.mjs status            is video arriving? which destinations are on?
//   node scripts/stream.mjs add x <url> <key> start simulcasting to a destination
//   node scripts/stream.mjs rm <output-id>    stop simulcasting to one
//   node scripts/stream.mjs delete            tear the live input down
//
// Credentials stay on the operator's machine: the deployed Worker never sees them.
import { readFile, writeFile } from 'node:fs/promises';

const VARS = '.dev.vars';
const API = 'https://api.cloudflare.com/client/v4';

async function devVar(name) {
  if (process.env[name]) return process.env[name].trim();
  const file = await readFile(VARS, 'utf8').catch(() => '');
  const found = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\r\n]+)"?`, 'm').exec(file);
  return found ? found[1].trim() : '';
}

async function credentials() {
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

async function cf(path, { token }, init = {}) {
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
async function inputId() {
  const id = await devVar('CF_LIVE_INPUT_ID');
  if (!id) throw Error('No live input yet. Run: node scripts/stream.mjs create');
  return id;
}

/** Append or replace a key in .dev.vars without disturbing the rest of the file. */
async function remember(pairs) {
  let file = await readFile(VARS, 'utf8').catch(() => '');
  for (const [key, value] of Object.entries(pairs)) {
    const line = `${key}=${value}`;
    const existing = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    file = existing.test(file) ? file.replace(existing, line) : `${file.replace(/\s*$/, '')}\n${line}`;
  }
  await writeFile(VARS, `${file.replace(/\s*$/, '')}\n`);
}

/**
 * The player URL has to sit on this account's own cloudflarestream.com host: that is what
 * StreamEmbed recognises, and the only host it adds autoplay and muted to. Cloudflare does not
 * return the customer subdomain on its own, but the WebRTC playback URL is served from it, so
 * take the hostname from there rather than pattern-matching Cloudflare's naming.
 */
function embedUrl(input) {
  try {
    const { hostname } = new URL(input.webRTCPlayback?.url ?? '');
    if (hostname.endsWith('.cloudflarestream.com'))
      return `https://${hostname}/${input.uid}/iframe`;
  } catch {
    // Fall through: an unusable playback URL is reported, never written.
  }
  return null;
}

async function create(creds) {
  const input = await cf(`/accounts/${creds.account}/stream/live_inputs`, creds, {
    method: 'POST',
    body: JSON.stringify({
      meta: { name: 'Pepe & Chad Live' },
      recording: { mode: 'automatic', timeoutSeconds: 10, requireSignedURLs: false },
    }),
  });
  const embed = embedUrl(input);
  // Only ever remember a URL the player can actually use. Writing a known-bad one plus a
  // printed apology just means the next command reads it back as though it were good.
  await remember(embed ? { CF_LIVE_INPUT_ID: input.uid, STREAM_EMBED_URL: embed } : { CF_LIVE_INPUT_ID: input.uid });
  console.log('Live input created.\n');
  console.log('  OBS > Settings > Stream > Custom');
  console.log(`    Server      ${input.rtmps.url}`);
  console.log(`    Stream key  ${input.rtmps.streamKey}`);
  if (embed) {
    console.log('\n  Public site secret (wrangler secret put STREAM_EMBED_URL)');
    console.log(`    ${embed}`);
  } else {
    console.log(
      '\n  Could not read this account\'s player host from the API response, so\n' +
        '  STREAM_EMBED_URL was not written. Copy the iframe URL from the Stream\n' +
        '  dashboard and set it by hand.',
    );
  }
  console.log(`\n  Live input ${input.uid} (saved to ${VARS})`);
}

async function status(creds) {
  const uid = await inputId();
  const input = await cf(`/accounts/${creds.account}/stream/live_inputs/${uid}`, creds);
  const live = input.status?.current?.state ?? 'disconnected';
  console.log(`Live input ${uid}`);
  console.log(`  ingest   ${live}${live === 'connected' ? ' — video is arriving' : ''}`);
  const outputs = await cf(`/accounts/${creds.account}/stream/live_inputs/${uid}/outputs`, creds);
  if (!outputs.length) return console.log('  outputs  none — nothing is being simulcast');
  console.log(`  outputs  ${outputs.length}`);
  for (const o of outputs)
    console.log(
      `    ${o.uid}  ${o.enabled ? 'on ' : 'off'}  ${o.url}  ${o.status?.current?.state ?? ''}`,
    );
}

async function add(creds, [name, url, key]) {
  if (!url || !key)
    throw Error('Usage: node scripts/stream.mjs add <name> <rtmp-url> <stream-key>');
  const uid = await inputId();
  const output = await cf(`/accounts/${creds.account}/stream/live_inputs/${uid}/outputs`, creds, {
    method: 'POST',
    body: JSON.stringify({ url, streamKey: key, enabled: true }),
  });
  console.log(`Simulcasting to ${name}: ${output.uid}`);
  console.log('Outputs can be added and removed mid-broadcast; no need to restart OBS.');
}

async function rm(creds, [id]) {
  if (!id) throw Error('Usage: node scripts/stream.mjs rm <output-id>');
  const uid = await inputId();
  await cf(`/accounts/${creds.account}/stream/live_inputs/${uid}/outputs/${id}`, creds, {
    method: 'DELETE',
  });
  console.log(`Stopped simulcasting to ${id}`);
}

async function destroy(creds) {
  const uid = await inputId();
  await cf(`/accounts/${creds.account}/stream/live_inputs/${uid}`, creds, { method: 'DELETE' });
  console.log(`Deleted live input ${uid}. Clear CF_LIVE_INPUT_ID from ${VARS}.`);
}

const commands = { create, status, add, rm, delete: destroy };

const [command, ...rest] = process.argv.slice(2);
const run = commands[command];
if (!run) {
  console.error(`Usage: node scripts/stream.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
try {
  await run(await credentials(), rest);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
