#!/usr/bin/env node
// X (Twitter) header: both hosts together in the studio, delivered at 1500x500.
// Generates a 21:9 two-shot with fal-ai/nano-banana-pro/edit, using the promoted
// stills as references so the cast stays on-model, then crops to X's 3:1 header.
//   node scripts/cover.mjs --dry-run                  print the payload, spend nothing
//   node scripts/cover.mjs --variants 3               candidates in work/cover/
//   node scripts/cover.mjs rebadge --variant 1        redraw the mug and wall badge from the
//                                                     promoted logo, as new candidates
//   node scripts/cover.mjs rebadge --variant 1 --reuse  recompose answers already downloaded,
//                                                     spending nothing
//   node scripts/cover.mjs pick --variant 1           promote to public/x-cover.png
//   node scripts/cover.mjs pick --variant 1 --bias .3 recrop higher before promoting
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import sharp from 'sharp';
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

// Re-branding an existing banner rather than rendering a new one: the cast, the room and the
// composition are already approved, and only the two places the badge appears are redrawn. The
// wide render is edited, not the 3:1 crop, so the same crop and promote steps still apply.
const REBADGE = `Edit the first image, a wide 2D animated podcast studio banner. Make exactly TWO changes and keep every other part of the picture pixel-identical: both characters, their poses, expressions, clothes, headphones, hands, the microphones and boom arms, the desk, the lamp, the shelves, the plant, the radio, the acoustic panels, the lighting, the palette, the line weight, the grain, the camera angle and the 21:9 framing.

1. The small framed badge print hanging flat on the acoustic panel wall in the upper right: replace the artwork inside the frame with EXACTLY the round badge in the second image — the green cartoon frog with black headphones on the left, the black studio microphone in the middle, and on the right the man with short near-black slicked-back hair, a thick square black beard, heavy dark brows, an enormous square jaw and a plain black t-shirt, with the arched "PEPE & CHAD" wordmark above them and the small "LIVE" box below. Delete any text printed under the badge inside the frame. Keep the frame itself, its size, position, angle, thickness and the dim room light falling on it exactly as they are; the print must not glow or grow brighter than its surroundings.

2. The black mug standing on the desk: replace the badge printed on it with the same badge from the second image, shrunk and simplified the way a real printed mug logo would be — fewer fine details, following the mug's existing curve, shading and highlight so it reads as printed on ceramic. Keep the mug's size, shape, position, colour and lighting identical.

The man on the right of the badge must no longer have long brown hair, a brown beard or a tan shirt in either place. Add no other text, wordmark, watermark or signature anywhere.`;

// Where this composition puts the two badges, as fractions of the frame. The edit is trusted
// only inside these two windows; everywhere else the original render's pixels are kept, so a
// re-render cannot quietly redraw a face, a hand or the lighting while it redraws a logo.
const BADGES = {
  mug: { x: [0.52, 0.63], y: [0.76, 0.98] },
  print: { x: [0.84, 0.94], y: [0.03, 0.34] },
};
// A redrawn badge moves pixels hard; a re-render's drift is a point or two everywhere.
const REDRAWN = 60;
// How crowded a neighbourhood must be to count as redrawn rather than drift: at least this
// share of a 25x25 box around the pixel.
const CROWD_RADIUS = 12;
const DENSITY = 0.23;
// Past the badge's own soft edge, then a feather wide enough that the seam lands on pixels the
// two renders already agree on.
const GROW = 26;
const FEATHER = 9;

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
    reuse: { type: 'boolean', default: false },
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

/** Running sums, so "how much of this neighbourhood moved" costs four lookups per pixel. */
function integral(flags, width, height) {
  const sums = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += flags[y * width + x] ? 1 : 0;
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
    }
  }
  return (x0, y0, x1, y1) => {
    const a = Math.max(0, x0), b = Math.max(0, y0);
    const c = Math.min(width, x1 + 1), e = Math.min(height, y1 + 1);
    return (
      sums[e * (width + 1) + c] - sums[b * (width + 1) + c] -
      sums[e * (width + 1) + a] + sums[b * (width + 1) + a]
    );
  };
}

/**
 * Keep the edit only where it redrew a badge, and the original everywhere else.
 * Returns the share of the frame that came from the edit.
 */
async function composeBadges(sourcePath, editPath, outPath) {
  const { width, height } = await sharp(sourcePath).metadata();
  const original = await sharp(sourcePath).removeAlpha().raw().toBuffer();
  const edited = await sharp(editPath).resize(width, height).removeAlpha().raw().toBuffer();
  // Hard pixel changes, and only where this composition puts a badge.
  const moved = new Uint8Array(width * height);
  for (const { x, y } of Object.values(BADGES))
    for (let row = Math.round(y[0] * height); row < Math.round(y[1] * height); row++)
      for (let col = Math.round(x[0] * width); col < Math.round(x[1] * width); col++) {
        const p = (row * width + col) * 3;
        const delta = Math.max(
          Math.abs(original[p] - edited[p]),
          Math.abs(original[p + 1] - edited[p + 1]),
          Math.abs(original[p + 2] - edited[p + 2]),
        );
        if (delta > REDRAWN) moved[row * width + col] = 1;
      }
  // A redrawn badge crowds its neighbourhood, even though it is line art with flat gaps; the
  // drift a re-render leaves elsewhere is speckle that never crowds anything.
  const crowding = integral(moved, width, height);
  const busy = (CROWD_RADIUS * 2 + 1) ** 2 * DENSITY;
  const blob = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!moved[y * width + x]) continue;
      const near = crowding(x - CROWD_RADIUS, y - CROWD_RADIUS, x + CROWD_RADIUS, y + CROWD_RADIUS);
      if (near >= busy) blob[y * width + x] = 1;
    }
  // Past the badge's own soft edge, then feathered across pixels both renders agree on.
  const reach = integral(blob, width, height);
  const grown = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (reach(x - GROW, y - GROW, x + GROW, y + GROW) > 0) grown[y * width + x] = 255;
  // sharp widens a one-channel raw buffer to three on the way out, which would slide the mask
  // out of step with the picture, so the grey is asked for explicitly.
  const soft = await sharp(grown, { raw: { width, height, channels: 1 } })
    .blur(FEATHER)
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  if (soft.length !== width * height) throw Error('The feathered mask is not one channel.');
  const out = Buffer.alloc(original.length);
  let taken = 0;
  for (let i = 0; i < soft.length; i++) {
    const weight = soft[i] / 255;
    let moved = false;
    for (let c = 0; c < 3; c++) {
      const p = i * 3 + c;
      out[p] = Math.round(original[p] * (1 - weight) + edited[p] * weight);
      if (out[p] !== original[p]) moved = true;
    }
    if (moved) taken++;
  }
  await sharp(out, { raw: { width, height, channels: 3 } }).png().toFile(outPath);
  return taken / (width * height);
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

/** Redraw the badge on the mug and on the wall of an existing render, as new candidates. */
async function rebadge(key) {
  const data = await manifest();
  const source = data.candidates?.[Number(opt.variant)];
  if (!source) throw Error('Generate first, then pass --variant <index> to re-badge.');
  const { logo } = JSON.parse(await readFile(ASSETS, 'utf8'));
  if (!logo?.url) throw Error('character-assets.json has no promoted logo to copy.');
  const input = {
    prompt: REBADGE,
    image_urls: [source.url, logo.url],
    num_images: Number(opt.variants),
    aspect_ratio: '21:9',
    resolution: opt.resolution,
    output_format: 'png',
    safety_tolerance: 4,
  };
  if (opt['dry-run']) {
    console.log(JSON.stringify({ endpoint: ENDPOINT, input }, null, 2));
    return;
  }
  // Recomposing what the model already answered costs nothing, so a better mask never
  // means paying for the same render twice.
  const existing = data.candidates.filter((c) => c.rebadgedFrom === source.index);
  let answers;
  if (opt.reuse) {
    if (!existing.length) throw Error('Nothing to recompose: run rebadge without --reuse first.');
    answers = existing.map((c) => ({ candidate: c, edit: c.edit, url: c.url, requestId: c.requestId }));
    console.log(`rebadge #${source.index}: recomposing ${answers.length} answer(s)`);
  } else {
    process.stdout.write(`rebadge #${source.index}: submitting `);
    const { images, requestId } = await generate(ENDPOINT, key, input);
    console.log(` ${images.length} image(s)`);
    answers = images.map((image, n) => ({
      candidate: null, edit: `${OUT}/edit-${data.candidates.length + n}.png`,
      url: image.url, width: image.width, height: image.height, requestId,
    }));
  }
  const added = [];
  for (const answer of answers) {
    // Appended, never overwriting the render they came from, and cropped at the same bias,
    // so `pick --variant <new index>` promotes one with the geometry already chosen.
    const index = answer.candidate?.index ?? data.candidates.length;
    const raw = `${OUT}/raw-${index}.png`;
    const cover = `${OUT}/cover-${index}.png`;
    if (!opt.reuse) await download(answer.url, answer.edit);
    const share = await composeBadges(source.raw, answer.edit, raw);
    await crop(raw, cover, source.bias);
    const candidate = {
      ...answer.candidate,
      index, raw, cover, edit: answer.edit, url: answer.url,
      width: answer.width ?? answer.candidate?.width,
      height: answer.height ?? answer.candidate?.height,
      bias: source.bias, seed: null,
      rebadgedFrom: source.index, logo: logo.url,
      requestId: answer.requestId,
      composedShare: Number(share.toFixed(5)),
    };
    if (answer.candidate) data.candidates[index] = candidate;
    else data.candidates.push(candidate);
    added.push(candidate);
  }
  await save(data);
  for (const c of added)
    console.log(`  #${c.index}  ${c.cover}  (${(c.composedShare * 100).toFixed(1)}% of the frame taken from the edit)`);
  console.log(`\nPromote one with: node scripts/cover.mjs pick --variant <index>`);
}

if (mode === 'pick') await pick();
else if (mode === 'rebadge') await rebadge(opt['dry-run'] ? null : await falKey());
else if (mode === 'generate')
  await build(opt['dry-run'] ? null : await falKey());
else throw Error(`Unknown mode "${mode}". Use generate, rebadge or pick.`);
