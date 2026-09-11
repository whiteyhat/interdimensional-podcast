// A devnet rehearsal that looks like a show: the site reports LIVE and a picture arrives,
// without generating a frame. The studio heartbeat keeps checkout open; ffmpeg loops the
// hosts' own idle footage from public/continuity into a rehearsal live input.
//
//   SITE=... STUDIO_TOKEN=... node scripts/rehearsal.mjs
//
// The picture goes to AIR_RTMP_INPUT from .dev.vars (`node scripts/stream.mjs create
// rehearsal` prints one). It refuses the show's own input and any input with simulcast
// outputs: a rehearsal that reached pump.fun or X would be the expensive kind of mistake,
// and nothing else in the pipeline blocks a wrong key.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cf, credentials, ingest } from './cfapi.mjs';
import { devVar, VARS } from './devvars.mjs';
import { holdAir } from './devnet.mjs';

const SITE = process.env.SITE;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
if (!SITE || !STUDIO_TOKEN) throw Error('SITE and STUDIO_TOKEN are required.');
const FOOTAGE = resolve('public/continuity');

// ---- which input, and is it safe to talk into
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
const target = await ingest(creds, uid);

// ---- the picture: the plain idle clips, in a fixed order, forever. Their audio variants
// carry the show's foley layer (a sip of tea, a beard scratch, headphone rustle over room
// tone), which is meant to sit under conversation; looped with no conversation on top it is
// just strange noise. So the picture goes out silent.
const clips = (await readdir(FOOTAGE))
  .filter((f) => /^(host|guest)-[a-z-]+-v1\.mp4$/.test(f))
  .sort();
if (!clips.length) throw Error(`No idle footage in ${FOOTAGE}.`);
const list = join(tmpdir(), 'pepe-chad-rehearsal.txt');
await writeFile(
  list,
  clips.map((f) => `file '${join(FOOTAGE, f)}'`).join('\n') + '\n',
);

// A rehearsal says so on screen. Anyone who opens the devnet site mid-test should read
// "rehearsal", not wonder why the hosts never speak. The label is skipped, not fatal, on a
// machine without a usable font.
const FONTS = [
  '/System/Library/Fonts/Supplemental/Courier New Bold.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
];
const font = FONTS.find((path) => existsSync(path));
const label = font
  ? `,drawtext=fontfile='${font}':text='DEVNET REHEARSAL - NOT THE SHOW':fontsize=26:fontcolor=0xefece4:x=40:y=40:box=1:boxcolor=0x171918@0.72:boxborderw=14`
  : '';

// The same shape the broadcast box sends: H.264 high, keyframe every two seconds, AAC 48k.
// Cloudflare Stream Live takes H.264 and AAC only, so the silence is still an AAC track.
// `-re` paces the file at real time; without it ffmpeg would push minutes of video a second.
// prettier-ignore
const args = [
  '-hide_banner', '-loglevel', 'warning', '-nostats',
  '-re', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', list,
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-map', '0:v:0', '-map', '1:a:0',
  '-vf', `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p${label}`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
  '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
  '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
  '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
  '-f', 'flv', `${target.url}${target.key}`,
];

let encoder = null;
let stopped = false;
function push(attempt = 0) {
  if (stopped) return;
  encoder = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  encoder.on('error', (e) => {
    if (e.code === 'ENOENT') {
      console.error('ffmpeg is not installed. On a Mac: brew install ffmpeg');
      process.exit(1);
    }
  });
  encoder.on('exit', (code) => {
    if (stopped) return;
    const wait = [2, 4, 8, 15, 30][Math.min(attempt, 4)];
    console.error(`encoder exited (${code}); reconnecting in ${wait}s`);
    setTimeout(() => push(attempt + 1), wait * 1000);
  });
}

// ---- on air
const letGo = await holdAir(SITE, STUDIO_TOKEN, {
  onRefused: (status) => console.error(`heartbeat refused: ${status}`),
});
push();
console.log(
  `Rehearsal on air\n  site     ${SITE}\n  picture  ${clips.length} clips of the hosts, looping, silent${font ? ', labelled' : ''}, into live input ${uid}\n  nothing is generated, delivered, or simulcast. Ctrl-C to stop.`,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true;
    letGo();
    encoder?.kill('SIGINT');
    process.exit(0);
  });
await new Promise(() => {});
