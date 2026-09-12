// A second broadcast box, for devnet rehearsals: the real show, written, generated and paid
// placements delivered, streamed into the rehearsal live input the devnet site embeds. So a
// person can buy on the devnet site and watch the purchase air there, as a customer would.
//
//   node scripts/rehearsal-box.mjs setup              create it and send it its settings
//   node scripts/rehearsal-box.mjs deploy             upload this working tree and build it
//   node scripts/rehearsal-box.mjs on [--minutes N]   go on air (the box's own default: 60)
//   node scripts/rehearsal-box.mjs status | off
//
// It is the show's box in every way but three: it takes paid orders only from the devnet site,
// settles on devnet, and streams only to the rehearsal input (never the show's own input, never
// one with simulcast outputs). It never touches the show's box. Generation is paid for like the
// real show's, so leave it off when nobody is testing.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { studioVarNames } from '../broadcast/air-policy.mjs';
import {
  boxClient,
  boxInstance,
  boxOnlyVarNames,
  minutesFlag,
} from './box.mjs';
import { rehearsalIngest } from './cfapi.mjs';
import { devVars, remember } from './devvars.mjs';
import { ROOT, SITES } from './media.mjs';
import * as railway from './railway.mjs';

const SERVICE = 'broadcast-box-devnet';
const box = boxClient(
  'REHEARSAL_BOX_URL',
  'node scripts/rehearsal-box.mjs setup',
);

/**
 * What the rehearsal box is told: this machine's studio settings, pointed at devnet. Pure, so
 * the test can prove it never carries the show's input or the production site.
 */
export function rehearsalSettings(studio, rtmp) {
  if (!studio.FAL_KEY)
    throw Error('Set FAL_KEY: it is what generates the show.');
  if (!studio.STUDIO_TOKEN)
    throw Error('Set STUDIO_TOKEN: it is what the devnet site trusts.');
  return {
    ...studio,
    // Paid orders come from the devnet site, and nowhere else.
    INTERACT_ORIGIN: SITES.devnet.origin,
    // The site allows one studio at a time and tells them apart by name.
    STUDIO_ID: 'rehearsal-box',
    // A devnet RPC makes the studio's own routes treat the coin as the test mint it is,
    // instead of asking pump.fun about it on every chart poll.
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    RTMP_URL: rtmp.url,
    RTMP_KEY: rtmp.key,
    // The box's own default when `on` names no minutes: an hour, not the show's day.
    AIR_MAX_MINUTES: '60',
  };
}

const commands = {
  async setup() {
    const [studio, rtmp, ids] = await Promise.all([
      devVars([...studioVarNames, ...boxOnlyVarNames]),
      rehearsalIngest(),
      railway.target({ service: SERVICE }),
    ]);
    await railway.upsertVariables(ids, rehearsalSettings(studio, rtmp));
    await railway.configure(ids, boxInstance);
    const address = await railway.domain(ids, 8080);
    await remember({ REHEARSAL_BOX_URL: address });
    console.log(
      `${SERVICE} is at ${address}. It streams to the rehearsal input and takes orders from ${SITES.devnet.origin}.`,
    );
    console.log('Next: node scripts/rehearsal-box.mjs deploy');
  },
  async deploy() {
    const ids = await railway.target({ service: SERVICE, create: false });
    if (!ids)
      throw Error(
        `Railway has no ${SERVICE} yet. Run: node scripts/rehearsal-box.mjs setup`,
      );
    const files = await railway.repositoryFiles(ROOT);
    console.log(`Uploading ${files.length} files of this working tree...`);
    const started = await railway.deploy(ids, { files, root: ROOT });
    console.log(
      `Building ${started.megabytes} MB as deployment ${started.id.slice(0, 8)}.`,
    );
    return railway.follow(started, SERVICE);
  },
  async on(...args) {
    const minutes = minutesFlag(args);
    console.log(
      JSON.stringify(
        await box.call('/air/on', {
          method: 'POST',
          body: minutes ? { minutes } : {},
        }),
        null,
        1,
      ),
    );
  },
  async off() {
    console.log(
      JSON.stringify(
        await box.call('/air/off', { method: 'POST', body: {} }),
        null,
        1,
      ),
    );
  },
  async status() {
    console.log(JSON.stringify(await box.call('/air/status'), null, 1));
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
