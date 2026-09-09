// The broadcast plumbing. OBS pushes one RTMPS stream at Cloudflare, and Cloudflare fans it
// out to X, to pump.fun, and to the player on the public site. Managing the destinations from
// here rather than a dashboard means launch night is a command, not a scavenger hunt.
//
//   node scripts/stream.mjs create            make the live input; prints ingest + embed
//   node scripts/stream.mjs create rehearsal  a second input nothing is simulcast from
//   node scripts/stream.mjs status            is video arriving? which destinations are on?
//   node scripts/stream.mjs ingest [uid]      where to push video: server + stream key
//   node scripts/stream.mjs add x <url> <key> start simulcasting to a destination
//   node scripts/stream.mjs rm <output-id>    stop simulcasting to one
//   node scripts/stream.mjs delete            tear the live input down
//
// Credentials stay on the operator's machine: the deployed Worker never sees them.
import { cf, credentials, ingest, inputId } from './cfapi.mjs';
import { remember, VARS } from './devvars.mjs';

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

/**
 * A named input is a rehearsal input: it is created and printed but never written to .dev.vars,
 * so it has no simulcast destinations and nothing said into it can reach X or pump.fun. The
 * unnamed one is the show's input, and it is remembered.
 */
async function create(creds, [name]) {
  const input = await cf(`/accounts/${creds.account}/stream/live_inputs`, creds, {
    method: 'POST',
    body: JSON.stringify({
      meta: { name: name ? `Pepe & Chad ${name}` : 'Pepe & Chad Live' },
      recording: { mode: 'automatic', timeoutSeconds: 10, requireSignedURLs: false },
    }),
  });
  if (name) {
    console.log(`Rehearsal input "${input.meta.name}" created; nothing is simulcast from it.\n`);
    console.log(`  Server      ${input.rtmps.url}`);
    console.log(`  Stream key  ${input.rtmps.streamKey}`);
    console.log(`\n  Live input ${input.uid} (not saved; watch it in the Stream dashboard)`);
    console.log('  Point the box at it with: railway variable set RTMP_KEY --stdin');
    return;
  }
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

/**
 * Where to push video. OBS reads this off `create`, but a hosted broadcast box needs it again
 * later, and possibly for a second live input kept for rehearsals.
 */
async function where(creds, [uid]) {
  const target = await ingest(creds, uid || (await inputId()));
  console.log(`Live input ${target.uid}`);
  console.log(`  server      ${target.url}`);
  console.log(`  stream key  ${target.key}`);
  console.log('\nThis key is a credential: anyone holding it can broadcast to this input.');
}

const commands = { create, status, add, rm, ingest: where, delete: destroy };

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
