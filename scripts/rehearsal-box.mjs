// A second broadcast box, for devnet rehearsals: the real show, written, generated and paid
// placements delivered, streamed into the rehearsal live input the devnet site embeds. So a
// person can buy on the devnet site and watch the purchase air there, as a customer would.
//
//   node scripts/rehearsal-box.mjs setup              create it and send it its settings
//   node scripts/rehearsal-box.mjs deploy             upload this working tree and build it
//   node scripts/rehearsal-box.mjs on [--minutes N]   go on air (default 60 minutes)
//   node scripts/rehearsal-box.mjs status | off
//
// It is not the show's box and never touches it. It streams only to AIR_RTMP_INPUT, refuses
// the show's own input and any input with simulcast outputs, takes paid orders only from the
// devnet site, and goes off air by itself when its minutes run out. Generation is paid for
// like the real show's, so leave it off when nobody is testing.
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { studioVarNames } from '../broadcast/air-policy.mjs';
import { cf, credentials, ingest } from './cfapi.mjs';
import { devVar, devVars, remember, VARS } from './devvars.mjs';
import * as railway from './railway.mjs';

export const SERVICE = 'broadcast-box-devnet';
export const DEVNET_SITE =
  'https://interdimensional-podcast-staging.leonardo-chekup.workers.dev';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_MINUTES = 60;

/**
 * What the rehearsal box is told: this machine's studio settings, pointed at devnet. Pure, so
 * the test can prove it never carries the show's input or the production site.
 */
export function rehearsalSettings(studio, rtmp, minutes = DEFAULT_MINUTES) {
  if (!studio.FAL_KEY)
    throw Error(`Set FAL_KEY in ${VARS}: it is what generates the show.`);
  if (!studio.STUDIO_TOKEN)
    throw Error(
      `Set STUDIO_TOKEN in ${VARS}: it is what the devnet site trusts.`,
    );
  const settings = {};
  for (const [name, value] of Object.entries(studio))
    if (value !== undefined && value !== '') settings[name] = value;
  return {
    ...settings,
    // Paid orders come from the devnet site, and nowhere else.
    INTERACT_ORIGIN: DEVNET_SITE,
    // The site allows one studio at a time and tells them apart by name.
    STUDIO_ID: 'rehearsal-box',
    // A devnet RPC makes the studio's own routes treat the coin as the test mint it is,
    // instead of asking pump.fun about it on every chart poll.
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    RTMP_URL: rtmp.url,
    RTMP_KEY: rtmp.key,
    AIR_MAX_MINUTES: String(minutes),
  };
}

/** The rehearsal input, after proving it is neither the show's input nor a simulcast. */
async function rehearsalInput() {
  const uid = await devVar('AIR_RTMP_INPUT');
  if (!uid)
    throw Error(
      `Set AIR_RTMP_INPUT in ${VARS} to the rehearsal live input (node scripts/stream.mjs create rehearsal).`,
    );
  if (uid === (await devVar('CF_LIVE_INPUT_ID')))
    throw Error(
      `AIR_RTMP_INPUT is the show's own live input. A rehearsal never goes there.`,
    );
  const creds = await credentials();
  const outputs = await cf(
    `/accounts/${creds.account}/stream/live_inputs/${uid}/outputs`,
    creds,
  );
  if (Array.isArray(outputs) && outputs.length)
    throw Error(
      `Live input ${uid} has ${outputs.length} simulcast output(s); a rehearsal would reach them.`,
    );
  return ingest(creds, uid);
}

/** Every file of this working tree the image is built from, secrets and scratch left out. */
async function sourceFiles() {
  const out = await new Promise((done, fail) =>
    execFile(
      'git',
      ['ls-files', '-co', '--exclude-standard'],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    ),
  );
  return out
    .split('\n')
    .filter(Boolean)
    .filter(
      (file) =>
        !/(^|\/)(\.dev\.vars|\.env|\.devnet-keys\.json)/.test(file) &&
        !/^(work|node_modules|dist|\.claude)\//.test(file),
    );
}

async function ids(create = true) {
  const found = await railway.target({ service: SERVICE, create });
  if (!found)
    throw Error(
      `Railway has no ${SERVICE} yet. Run: node scripts/rehearsal-box.mjs setup`,
    );
  return found;
}

async function url() {
  const saved = await devVar('REHEARSAL_BOX_URL');
  if (!saved)
    throw Error('The rehearsal box has no address yet. Run setup first.');
  return saved.replace(/\/$/, '');
}

async function call(path, body) {
  const token = await devVar('STUDIO_TOKEN');
  const response = await fetch(`${await url()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-studio-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(data.error || `The rehearsal box answered ${response.status}.`);
  return data;
}

const commands = {
  async setup() {
    const settings = rehearsalSettings(
      await devVars([
        ...studioVarNames,
        'AIR_HEIGHT',
        'AIR_FPS',
        'AIR_BITRATE',
      ]),
      await rehearsalInput(),
    );
    const box = await ids();
    await railway.upsertVariables(box, settings);
    await railway.configure(box, {
      dockerfilePath: 'Dockerfile',
      healthcheckPath: '/air/health',
      healthcheckTimeout: 120,
      restartPolicyType: 'ALWAYS',
      restartPolicyMaxRetries: 10,
      sleepApplication: false,
      numReplicas: 1,
    });
    const address = await railway.domain(box, 8080);
    await remember({ REHEARSAL_BOX_URL: address });
    console.log(
      `${SERVICE} is at ${address}. It streams to the rehearsal input and takes orders from ${DEVNET_SITE}.`,
    );
    console.log('Next: node scripts/rehearsal-box.mjs deploy');
  },
  async deploy() {
    const box = await ids(false);
    const files = await sourceFiles();
    console.log(`Uploading ${files.length} files of this working tree...`);
    const started = await railway.deploy(box, { files, root: ROOT });
    console.log(
      `Building ${started.megabytes} MB as deployment ${started.id.slice(0, 8)}.`,
    );
    let last = '';
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const state = await railway.deployment(started.id).catch(() => null);
      if (!state) continue;
      if (state.status !== last)
        console.log(`  ${(last = state.status).toLowerCase()}`);
      if (state.status === 'SUCCESS') return true;
      if (['FAILED', 'CRASHED', 'REMOVED'].includes(state.status)) {
        for (const line of (await railway.logs(started.id, 'build', 40)) ?? [])
          console.error(`  ${line}`);
        return false;
      }
    }
    return false;
  },
  async on(...args) {
    const at = args.indexOf('--minutes');
    const minutes = at >= 0 ? Number(args[at + 1]) : DEFAULT_MINUTES;
    console.log(JSON.stringify(await call('/air/on', { minutes }), null, 1));
  },
  async off() {
    console.log(JSON.stringify(await call('/air/off', {}), null, 1));
  },
  async status() {
    console.log(JSON.stringify(await call('/air/status'), null, 1));
  },
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, ...rest] = process.argv.slice(2);
  const run = commands[command];
  if (!run) {
    console.error(
      `Usage: node scripts/rehearsal-box.mjs <${Object.keys(commands).join('|')}>`,
    );
    process.exit(1);
  }
  try {
    if ((await run(...rest)) === false) process.exitCode = 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
