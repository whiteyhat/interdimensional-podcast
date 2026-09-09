#!/usr/bin/env node
// Regenerate the cast stills with fal-ai/nano-banana-pro/edit, editing the previous frames.
// Usage:
//   node scripts/characters.mjs --dry-run                 print payloads, spend nothing
//   node scripts/characters.mjs --variants 2 --seed 4242  candidates in work/characters, nothing promoted
//   node scripts/characters.mjs --pick host=1 guest=0     promote candidates from the last run
//   node scripts/characters.mjs --only host --descriptive regenerate one role without character names
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { download, fal, falKey, waitFor } from './fal.mjs';

const ENDPOINT = 'fal-ai/nano-banana-pro/edit';
const OUT = 'work/characters';
const MANIFEST = `${OUT}/manifest.json`;
const ASSETS = 'character-assets.json';
const STUDIO =
  'Change nothing else: keep the identical dark basement podcast studio, dark teal slatted acoustic panels, amber table lamp, shelves, black boom arm and microphone, walnut desk, lighting, palette, line weight, camera angle and 16:9 framing. Full color. No text, no captions, no logos, no watermark, no signature.';
const HOST_POSE =
  'Keep the identical pose and framing: he sits on the left side of the frame behind the walnut desk, body angled to the right, looking toward the microphone on the right, hands resting on the desk. He wears the same black over-ear headphones, a plain blue crew-neck t-shirt, and the same gold wristwatch. Keep the potted plant, vintage radio and shelf of records exactly where they are.';
const GUEST_POSE =
  'Keep the identical pose and framing: he sits on the right side of the frame behind the walnut desk, body angled to the left, looking toward the microphone on the left, one forearm resting on the desk, wearing the same black over-ear headphones and a fitted plain black t-shirt. Replace the wrapped gift box on the top shelf with a small potted plant. Keep the black mug on the desk.';
const HOST_FACE =
  'smooth green skin, a wide flat head, large round white eyes with small black pupils under heavy half-lowered lids, no nose, a small chin, and thick wide red lips, mouth closed, in a relaxed slightly amused expression. No horns, no goatee, no pointed ears, no red skin. Four-fingered green hands.';
const GUEST_FACE =
  'an absurdly oversized square chiseled jawline, sharp cheekbones, a heavy brow over narrow calm eyes, a thick neatly trimmed dark beard, dark slicked-back hair, a thick neck, broad shoulders and hugely muscular arms and chest. Calm, faintly smug expression, mouth closed. Remove the Santa hat, red coat, white beard and belly entirely.';
const CEL =
  'drawn in exactly the same flat 2D adult-animation cel style as the rest of the image: bold clean dark outlines, flat muted colors, simple cel shading, not photorealistic and not grayscale';

const ROLES = {
  host: {
    key: 'pepe',
    file: 'pepe-cartoon.png',
    parent:
      'https://v3b.fal.media/files/b/0aa9566d/af-RPcSXlTgsnlc7uJTrE_satan-cartoon.png',
    prompt: `Edit this 2D animated podcast frame. Replace the red devil character with Pepe the Frog, an adult male cartoon frog ${CEL}. Pepe has ${HOST_FACE} ${HOST_POSE} ${STUDIO}`,
    descriptive: `Edit this 2D animated podcast frame. Replace the red devil character with an original anthropomorphic green cartoon frog man, an adult character ${CEL}. He has ${HOST_FACE} ${HOST_POSE} ${STUDIO}`,
  },
  guest: {
    key: 'gigachad',
    file: 'gigachad-cartoon.png',
    parent:
      'https://v3b.fal.media/files/b/0aa9566d/D7-21mPU8XXQiFJ1Iikqj_santa-cartoon.png',
    prompt: `Edit this 2D animated podcast frame. Replace Santa Claus with GigaChad, an adult man with a natural warm skin tone ${CEL}. GigaChad has ${GUEST_FACE} ${GUEST_POSE} ${STUDIO}`,
    descriptive: `Edit this 2D animated podcast frame. Replace Santa Claus with an original hyper-masculine adult cartoon man with a natural warm skin tone ${CEL}. He has ${GUEST_FACE} ${GUEST_POSE} ${STUDIO}`,
  },
};

const { values: opt } = parseArgs({
  options: {
    variants: { type: 'string', default: '1' },
    seed: { type: 'string' },
    only: { type: 'string' },
    pick: { type: 'string', multiple: true, default: [] },
    descriptive: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    resolution: { type: 'string', default: '1K' },
  },
});


async function generate(role, key) {
  const spec = ROLES[role];
  const seed = opt.seed ? Number(opt.seed) : undefined;
  const input = {
    prompt: opt.descriptive ? spec.descriptive : spec.prompt,
    image_urls: [spec.parent],
    num_images: Number(opt.variants),
    aspect_ratio: '16:9',
    resolution: opt.resolution,
    output_format: 'png',
    safety_tolerance: 4,
    ...(seed === undefined ? {} : { seed }),
  };
  if (opt['dry-run']) {
    console.log(JSON.stringify({ role, endpoint: ENDPOINT, input }, null, 2));
    return [];
  }
  process.stdout.write(`${role}: submitting `);
  const job = await fal(`https://queue.fal.run/${ENDPOINT}`, key, input);
  const result = await waitFor(job, key);
  const images = result.images || [];
  if (!images.length) throw Error(`No image returned for ${role}.`);
  const candidates = [];
  for (const [index, image] of images.entries()) {
    const file = `${OUT}/${role}-${seed ?? 'auto'}-${index}.png`;
    await download(image.url, file);
    candidates.push({
      role,
      index,
      file,
      url: image.url,
      width: image.width,
      height: image.height,
      seed: seed ?? null,
      requestId: job.request_id,
      prompt: input.prompt,
      descriptive: opt.descriptive,
    });
  }
  console.log(` ${images.length} image(s)`);
  return candidates;
}

async function promote(candidate) {
  const spec = ROLES[candidate.role];
  await copyFile(candidate.file, `public/${spec.file}`);
  const current = JSON.parse(await readFile(ASSETS, 'utf8').catch(() => '{}'));
  const assets = {
    method: `${ENDPOINT}, editing the previous stills listed under parents`,
    generatedAt: new Date().toISOString(),
    sources: { ...current.sources },
    parents: { ...current.parents },
    prompts: { ...current.prompts },
    params: { ...current.params },
    requestIds: { ...current.requestIds },
  };
  const name = spec.file.replace(/\.png$/, '');
  assets.sources[name] = candidate.url;
  assets.parents[name] = spec.parent;
  assets.prompts[spec.key] = candidate.prompt;
  assets.requestIds[spec.key] = candidate.requestId;
  assets.params[spec.key] = {
    aspect_ratio: '16:9',
    resolution: opt.resolution,
    output_format: 'png',
    seed: candidate.seed,
    descriptive: candidate.descriptive,
  };
  // Earlier casts are replaced wholesale, so drop keys that no role owns any more.
  const files = Object.values(ROLES).map((r) => r.file.replace(/\.png$/, ''));
  const keys = Object.values(ROLES).map((r) => r.key);
  for (const group of [assets.sources, assets.parents])
    for (const key of Object.keys(group))
      if (!files.includes(key)) delete group[key];
  for (const group of [assets.prompts, assets.params, assets.requestIds])
    for (const key of Object.keys(group))
      if (!keys.includes(key)) delete group[key];
  await writeFile(ASSETS, `${JSON.stringify(assets, null, 2)}\n`);
  return `public/${spec.file}`;
}

async function main() {
  const roles = opt.only ? [opt.only] : Object.keys(ROLES);
  for (const role of roles)
    if (!ROLES[role]) throw Error(`Unknown role: ${role}`);
  await mkdir(OUT, { recursive: true });

  const picks = new Map(
    opt.pick.map((entry) => {
      const [role, index] = entry.split('=');
      return [role, Number(index)];
    }),
  );

  let manifest = {};
  if (picks.size) {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  } else {
    const key = await falKey();
    for (const role of roles) manifest[role] = await generate(role, key);
    if (opt['dry-run']) return;
    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const promoted = [];
  for (const role of roles) {
    const candidates = manifest[role] || [];
    if (!candidates.length) continue;
    const index = picks.get(role) ?? (candidates.length === 1 ? 0 : null);
    if (index === null) continue;
    const candidate = candidates[index];
    if (!candidate) throw Error(`No candidate ${index} for ${role}.`);
    promoted.push({ role, candidate, path: await promote(candidate) });
  }

  console.log('\nCandidates');
  for (const role of roles)
    for (const candidate of manifest[role] || [])
      console.log(
        `  ${role} #${candidate.index}  ${candidate.file}  ${candidate.width}x${candidate.height}  ${candidate.url}`,
      );

  if (!promoted.length) {
    console.log(
      `\nNothing promoted. Review the files above, then run:\n  node scripts/characters.mjs --pick ${roles.map((r) => `${r}=0`).join(' --pick ')}`,
    );
    return;
  }
  console.log('\nPromoted');
  for (const { path } of promoted) console.log(`  ${path}`);
  console.log('\nRun node scripts/video-frames.mjs to prepare and upload the video conditioning frames.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
