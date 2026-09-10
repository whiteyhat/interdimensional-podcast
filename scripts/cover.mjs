#!/usr/bin/env node
// X (Twitter) header: both hosts together in the studio, delivered at 1500x500.
// Generates a 21:9 two-shot with fal-ai/nano-banana-pro/edit, using the promoted
// stills as references so the cast stays on-model, then crops to X's 3:1 header.
//   node scripts/cover.mjs --dry-run                  print the payload, spend nothing
//   node scripts/cover.mjs --variants 3               candidates in work/cover/
//   node scripts/cover.mjs pick --variant 1           promote to public/x-cover.png
//   node scripts/cover.mjs pick --variant 1 --bias .3 recrop higher before promoting
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { download, falKey, generate } from './fal.mjs';

const run = promisify(execFile);
const ENDPOINT = 'fal-ai/nano-banana-pro/edit';
const OUT = 'work/cover';
const MANIFEST = `${OUT}/manifest.json`;
const ASSETS = 'character-assets.json';
const FINAL = 'public/x-cover.png';
// X renders the header at 1500x500 and lays the avatar over the lower left, so the
// desk corner there is kept empty and both hosts sit inside the middle of the frame.
const WIDTH = 1500;
const HEIGHT = 500;

const CEL =
  'drawn in exactly the same flat 2D adult-animation cel style as the reference images: bold clean dark outlines, flat muted colors, simple cel shading, soft painterly gradients, a faint film grain, not photorealistic and not grayscale';
const ROOM =
  'The same dim basement podcast studio as the reference images: dark teal slatted acoustic panels across the back wall, a warm amber table lamp glowing at the far left, a walnut wood desk running the full width of the frame, wooden shelves holding vinyl records, a small potted plant and a vintage radio at the far right, black microphone boom arms. The same muted palette of dark teal-olive, walnut brown, burnt amber lamplight and aged cream, the same dim warm-cool lighting and slight haze, the same line weight, straight-on camera at eye level.';
const HOST =
  'Pepe the Frog from the first reference image, unchanged: an adult male cartoon frog with smooth green skin, a wide flat head, large round white eyes with small black pupils under heavy half-lowered lids, no nose, a small chin, thick wide red lips with the mouth closed in a relaxed, faintly amused expression, black over-ear headphones, a plain blue crew-neck t-shirt, a gold wristwatch and four-fingered green hands.';
const GUEST =
  'GigaChad from the second reference image, unchanged: an adult man with a natural warm skin tone, an absurdly oversized square chiseled jawline, sharp cheekbones, a heavy brow over narrow calm eyes, a thick neatly trimmed dark beard, dark slicked-back hair, a thick neck, broad shoulders and hugely muscular arms, a fitted plain black t-shirt and black over-ear headphones, mouth closed in a calm, faintly smug expression.';
const COMPOSITION =
  'Wide two-shot, both characters seated side by side behind the same desk and both facing the camera. Pepe sits left of centre and GigaChad right of centre, turned very slightly toward each other, with a black studio microphone on a boom arm in front of each of them. Leave a clear gap of studio wall between their heads. Both heads sit in the upper middle of the frame with a little headroom above them, and neither character reaches the left or right edge — the far left is lamp and wall, the far right is shelves. Keep the lower left corner of the frame as empty walnut desk surface: no props, no hands and no objects there. The black mug with the small round PEPE & CHAD badge sits on the desk in front of GigaChad, and the small framed PEPE & CHAD badge print hangs flat on the acoustic panel wall in the upper right, dimly lit like the rest of the room.';
const RULES =
  'Full color. Do not add any text, caption, title, subtitle, wordmark, logo, watermark or signature anywhere in the image, apart from the small framed badge on the wall and the small badge printed on the mug. No borders, no letterboxing, no split-screen, no panel divider.';

const PROMPT = `Combine the two reference images into a single wide banner illustration of both podcast hosts in one room, ${CEL}. ${ROOM} On the left: ${HOST} On the right: ${GUEST} ${COMPOSITION} ${RULES}`;
const DESCRIPTIVE = PROMPT.replace(
  'Pepe the Frog from the first reference image',
  'the anthropomorphic green cartoon frog man from the first reference image',
).replace(
  'GigaChad from the second reference image',
  'the hyper-masculine cartoon man from the second reference image',
);

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    variants: { type: 'string', default: '3' },
    variant: { type: 'string', default: '0' },
    seed: { type: 'string' },
    // Where the 3:1 window sits inside the 21:9 render. 0 keeps the top of the
    // frame, 1 keeps the bottom; the default trims a little more desk than ceiling.
    bias: { type: 'string', default: '0.42' },
    resolution: { type: 'string', default: '2K' },
    descriptive: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
const mode = positionals[0] || 'generate';
const manifest = async () =>
  JSON.parse(await readFile(MANIFEST, 'utf8').catch(() => '{}'));
const save = (data) => writeFile(MANIFEST, `${JSON.stringify(data, null, 2)}\n`);

/** Crop the 21:9 render down to X's 3:1 header and scale it to 1500x500. */
async function crop(source, target, bias) {
  const window = `crop=iw:iw/3:0:(ih-iw/3)*${bias}`;
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', source,
    '-vf', `${window},scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
    target,
  ]);
}

async function build(key) {
  const assets = JSON.parse(await readFile(ASSETS, 'utf8'));
  const refs = [
    assets.sources['pepe-cartoon'],
    assets.sources['gigachad-cartoon'],
  ];
  if (refs.some((url) => !url))
    throw Error('character-assets.json is missing a promoted still.');
  const seed = opt.seed ? Number(opt.seed) : undefined;
  const input = {
    prompt: opt.descriptive ? DESCRIPTIVE : PROMPT,
    image_urls: refs,
    num_images: Number(opt.variants),
    aspect_ratio: '21:9',
    resolution: opt.resolution,
    output_format: 'png',
    safety_tolerance: 4,
    ...(seed === undefined ? {} : { seed }),
  };
  if (opt['dry-run']) {
    console.log(JSON.stringify({ endpoint: ENDPOINT, input }, null, 2));
    return;
  }
  await mkdir(OUT, { recursive: true });
  process.stdout.write('cover: submitting ');
  const { images, requestId } = await generate(ENDPOINT, key, input);
  console.log(` ${images.length} image(s)`);
  const data = await manifest();
  data.generatedAt = new Date().toISOString();
  data.endpoint = ENDPOINT;
  data.prompt = input.prompt;
  data.params = { ...input, image_urls: refs, prompt: undefined };
  data.requestId = requestId;
  data.candidates = [];
  for (const [index, image] of images.entries()) {
    const raw = `${OUT}/raw-${index}.png`;
    const cover = `${OUT}/cover-${index}.png`;
    await download(image.url, raw);
    await crop(raw, cover, opt.bias);
    data.candidates.push({
      index, raw, cover, url: image.url,
      width: image.width, height: image.height,
      bias: Number(opt.bias), seed: seed ?? null,
    });
  }
  await save(data);
  for (const c of data.candidates)
    console.log(`  #${c.index}  ${c.cover}  (raw ${c.width}x${c.height})`);
  console.log(`\nPromote one with: node scripts/cover.mjs pick --variant <index>`);
}

async function pick() {
  const data = await manifest();
  const chosen = data.candidates?.[Number(opt.variant)];
  if (!chosen) throw Error('Run the generate step first, then pass --variant <index>.');
  // A recrop is cheap and local, so a different bias never costs another render.
  if (Number(opt.bias) !== chosen.bias) {
    await crop(chosen.raw, chosen.cover, opt.bias);
    chosen.bias = Number(opt.bias);
  }
  await copyFile(chosen.cover, FINAL);
  data.promoted = { ...chosen, promotedAt: new Date().toISOString() };
  await save(data);
  console.log(`Promoted #${chosen.index} to ${FINAL} (${WIDTH}x${HEIGHT}).`);
}

if (mode === 'pick') await pick();
else if (mode === 'generate')
  await build(opt['dry-run'] ? null : await falKey());
else throw Error(`Unknown mode "${mode}". Use generate or pick.`);
