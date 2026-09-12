// The switch for the hosted broadcast box: what OBS and a MacBook used to be.
//
//   node scripts/air.mjs setup [--no-queue]  create the box and send it this machine's settings
//   node scripts/air.mjs deploy              upload the source and build the image
//   node scripts/air.mjs on [--minutes N]    go on air (default: AIR_MAX_MINUTES, else 24 hours)
//   node scripts/air.mjs status              what the box and the show are doing
//   node scripts/air.mjs frame [file]        save the picture currently going out
//   node scripts/air.mjs logs [build|run]    the last of the box's own output
//   node scripts/air.mjs off                 go off air
//
// `--no-queue` leaves INTERACT_ORIGIN off the box, so it never claims paid requests and never
// opens the five-dollar seat on the public site. That is what a rehearsal wants.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { studioVarNames } from '../broadcast/air-policy.mjs';
import { boxClient, boxInstance, boxOnlyVarNames } from './box.mjs';
import { credentials, ingest } from './cfapi.mjs';
import { devVar, devVars, remember, VARS } from './devvars.mjs';
import * as railway from './railway.mjs';

const { call: box } = boxClient('AIR_URL', 'node scripts/air.mjs setup');

// ---- commands ---------------------------------------------------------------------------

async function setup(args) {
  const rehearsal = args.includes('--no-queue');
  const studio = await devVars(studioVarNames);
  if (!studio.FAL_KEY)
    throw Error(`Set FAL_KEY in ${VARS}: it is what generates the show.`);
  if (!studio.STUDIO_TOKEN)
    throw Error(
      `Set STUDIO_TOKEN in ${VARS}: without it the box would take orders from anyone.`,
    );
  if (rehearsal) delete studio.INTERACT_ORIGIN;
  else if (!studio.INTERACT_ORIGIN)
    console.warn(
      'Warning: INTERACT_ORIGIN is not set, so the five-dollar seat stays closed.',
    );

  // The box is a second studio, and the site tells studios apart by name. Inheriting this
  // machine's name would give both the same one, and a guard that cannot tell them apart is a
  // guard that never fires — two studios generating the same show at $22-90/hr each.
  const mine = studio.STUDIO_ID;
  delete studio.STUDIO_ID;
  const boxStudioId = (await devVar('AIR_STUDIO_ID')) || 'railway';
  if (mine && mine === boxStudioId)
    throw Error(
      `STUDIO_ID is "${mine}" on this machine and the box would use the same name, which ` +
        'turns off the one-studio-at-a-time guard. Set AIR_STUDIO_ID to something else.',
    );
  const settings = {
    ...studio,
    STUDIO_ID: boxStudioId,
    ...(await devVars(boxOnlyVarNames)),
  };
  settings.AIR_MAX_MINUTES ||= '1440';
  console.log(
    `The box calls itself "${boxStudioId}"${mine ? `; this machine is "${mine}"` : ''}.`,
  );

  // AIR_RTMP_INPUT points the box at a live input other than the show's own: a rehearsal input
  // has no simulcast destinations, so nothing said into it can reach X or pump.fun.
  const input =
    (await devVar('AIR_RTMP_INPUT')) || (await devVar('CF_LIVE_INPUT_ID'));
  if (input) {
    const target = await ingest(await credentials(), input);
    settings.RTMP_URL = target.url;
    settings.RTMP_KEY = target.key;
    console.log(`Streaming to Cloudflare live input ${target.uid}.`);
  } else {
    console.warn(
      'Warning: no live input configured, so the show will run without being streamed.',
    );
  }

  const ids = await railway.target();
  await railway.setVariables(ids, settings);
  await railway.configure(ids, boxInstance);
  const url = await railway.domain(ids);
  await remember({ AIR_URL: url });
  console.log(
    `\nSent ${Object.keys(settings).length} settings${rehearsal ? ' (rehearsal: no paid queue)' : ''}.`,
  );
  console.log(`The box is at ${url} (saved to ${VARS}).`);
  console.log('Next: node scripts/air.mjs deploy');
}

async function deploy() {
  const ids = await railway.target();
  console.log('Uploading the source...');
  const started = await railway.deploy(ids);
  console.log(
    `Building ${started.megabytes} MB as deployment ${started.id.slice(0, 8)}.`,
  );
  if (!(await railway.follow(started, 'the box'))) process.exit(1);
  console.log('\nDeployed. The box is up and off air.');
  console.log('Next: node scripts/air.mjs on');
}

async function on(args) {
  const flag = args.indexOf('--minutes');
  const minutes = flag === -1 ? undefined : Number(args[flag + 1]);
  const result = await box('/air/on', {
    method: 'POST',
    body: minutes ? { minutes } : {},
  });
  console.log(result.already ? 'Already on air.' : 'On air.');
  report(result);
  if (!result.already)
    console.log(
      '\nThe first frame is about 90 seconds away while the reserve builds.',
    );
}

async function off() {
  report(await box('/air/off', { method: 'POST' }));
  console.log('\nGeneration has stopped. Nothing is being billed for airtime.');
}

function report(status) {
  const show = status.show ?? {};
  console.log(`  box       ${status.status} — ${status.reason}`);
  console.log(
    `  show      ${show.phase ?? 'not started'}${show.error ? ` — ${show.error}` : ''}`,
  );
  console.log(`  buffer    ${show.buffered ?? 0}s of footage ready`);
  console.log(
    `  aired     ${show.aired ?? 0} clips, ${show.stalls ?? 0} stalls, ${status.reloads ?? 0} reloads`,
  );
  console.log(
    `  encoder   ${status.encoder} (${status.encoderRestarts} restarts), ${status.video}`,
  );
  if (status.minutesLeft !== null && status.minutesLeft !== undefined)
    console.log(`  ends in   ${status.minutesLeft} minutes`);
  console.log(
    `  box uses  ${status.memoryMb} MB, up ${Math.round((status.uptimeSeconds ?? 0) / 60)} minutes`,
  );
}

async function status() {
  report(await box('/air/status'));
  console.log('\nCloudflare:');
  const child = spawn(process.execPath, ['scripts/stream.mjs', 'status'], {
    stdio: 'inherit',
  });
  await once(child, 'exit');
}

async function frame(args) {
  const file = args[0] || 'air-frame.jpg';
  await writeFile(file, await box('/air/frame.jpg'));
  console.log(`Saved the picture going out to ${file}`);
}

async function logs(args) {
  const ids = await railway.target();
  const found = await railway.latest(ids);
  if (!found) return console.log('The box has never been deployed.');
  const kind = args[0] === 'build' ? 'build' : 'run';
  console.log(
    `Deployment ${found.id.slice(0, 8)} (${found.status.toLowerCase()}), ${kind} log:\n`,
  );
  for (const line of await railway.logs(found.id, kind, 80))
    console.log(`  ${line}`);
}

const commands = { setup, deploy, on, off, status, frame, logs };
const [command, ...rest] = process.argv.slice(2);
const run = commands[command];
if (!run) {
  console.error(
    `Usage: node scripts/air.mjs <${Object.keys(commands).join('|')}>`,
  );
  process.exit(1);
}
try {
  await run(rest);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
