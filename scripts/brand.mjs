#!/usr/bin/env node
// Brand assets: a logo, then the same logo mounted in both studio frames.
//   node scripts/brand.mjs logo --variants 2            candidates in work/brand/
//   node scripts/brand.mjs stills --logo 0              re-edit both stills with logo candidate 0
//   node scripts/brand.mjs pick --logo 0 --host 0 --guest 1   promote to public/ + assets json
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { download, falKey, generate } from './fal.mjs';

const OUT = 'work/brand';
const MANIFEST = `${OUT}/manifest.json`;
const ASSETS = 'character-assets.json';
const CEL =
  'flat 2D adult-animation cel style, bold clean dark outlines, flat muted colors, simple shading, like a Rick and Morty title card';

const LOGO_PROMPT = `Podcast logo for "PEPE & CHAD LIVE", drawn in ${CEL}. A round broadcast badge on a dark olive background. Inside the badge, two profiles face each other across a black studio microphone: on the left a green cartoon frog with big round eyes and wide red lips wearing black headphones, on the right a heavily bearded man with an enormous square jaw wearing black headphones. Bold condensed sans-serif wordmark "PEPE & CHAD" arched across the top of the badge in cream, and the word "LIVE" in a small amber on-air box at the bottom. Underneath the badge, small monospace text "$FROGCLENCH" in sage green. Palette: dark olive, amber orange, sage green, cream. Clean, centred, vector-like, high contrast. No other text, no photo, no gradients, no watermark.`;

const signPrompt = (side) =>
  `Edit this 2D animated podcast frame. Add ONE illuminated wall sign showing EXACTLY the logo in the second image, reproduced faithfully with the same badge, the same frog and bearded man profiles, the same "PEPE & CHAD" wordmark, the same amber "LIVE" box and the same "$FROGCLENCH" text. Mount it flat on the dark teal acoustic panel wall in the upper ${side} of the background, above head height and behind the microphone boom, sized to about one fifth of the frame width, with a soft warm glow. It must not cover any part of the character, the headphones, the microphone or the lamp. Change nothing else: keep the character, pose, expression, clothes, desk, lamp, shelves, panels, lighting, palette, line weight, camera angle and 16:9 framing identical to the first image. No other text, no watermark.`;

const ROLES = {
  host: { key: 'pepe', file: 'pepe-cartoon.png', side: 'right' },
  guest: { key: 'gigachad', file: 'gigachad-cartoon.png', side: 'left' },
};

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    variants: { type: 'string', default: '1' },
    logo: { type: 'string' },
    host: { type: 'string', default: '0' },
    guest: { type: 'string', default: '0' },
    seed: { type: 'string' },
  },
});
const mode = positionals[0] || 'logo';
const manifest = async () =>
  JSON.parse(await readFile(MANIFEST, 'utf8').catch(() => '{}'));
const save = (data) => writeFile(MANIFEST, `${JSON.stringify(data, null, 2)}\n`);

async function logo(key) {
  process.stdout.write('logo: submitting ');
  const { images, requestId } = await generate('fal-ai/nano-banana-pro', key, {
    prompt: LOGO_PROMPT,
    num_images: Number(opt.variants),
    aspect_ratio: '1:1',
    resolution: '1K',
    output_format: 'png',
    ...(opt.seed ? { seed: Number(opt.seed) } : {}),
  });
  const data = await manifest();
  data.logo = [];
  for (const [index, image] of images.entries()) {
    const file = `${OUT}/logo-${index}.png`;
    await download(image.url, file);
    data.logo.push({ index, file, url: image.url, requestId });
  }
  await save(data);
  console.log(` ${images.length} image(s)`);
  for (const c of data.logo) console.log(`  logo #${c.index}  ${c.file}  ${c.url}`);
}

async function stills(key) {
  const data = await manifest();
  const chosen = data.logo?.[Number(opt.logo ?? 0)];
  if (!chosen) throw Error('Run `logo` first and pass --logo <index>.');
  const assets = JSON.parse(await readFile(ASSETS, 'utf8'));
  data.stills = {};
  for (const [role, spec] of Object.entries(ROLES)) {
    const parent = assets.sources[spec.file.replace(/\.png$/, '')];
    if (!parent) throw Error(`No current still for ${role} in ${ASSETS}`);
    process.stdout.write(`${role}: submitting `);
    const { images, requestId } = await generate('fal-ai/nano-banana-pro/edit', key, {
      prompt: signPrompt(spec.side),
      image_urls: [parent, chosen.url],
      num_images: Number(opt.variants),
      aspect_ratio: '16:9',
      resolution: '1K',
      output_format: 'png',
      ...(opt.seed ? { seed: Number(opt.seed) } : {}),
    });
    data.stills[role] = [];
    for (const [index, image] of images.entries()) {
      const file = `${OUT}/${role}-${index}.png`;
      await download(image.url, file);
      data.stills[role].push({ index, file, url: image.url, requestId, parent, logo: chosen.url });
    }
    console.log(` ${images.length} image(s)`);
    for (const c of data.stills[role]) console.log(`  ${role} #${c.index}  ${c.file}  ${c.url}`);
  }
  await save(data);
}

async function pick() {
  const data = await manifest();
  const chosenLogo = data.logo?.[Number(opt.logo ?? 0)];
  if (!chosenLogo) throw Error('No logo candidate to promote.');
  await copyFile(chosenLogo.file, 'public/logo.png');
  const assets = JSON.parse(await readFile(ASSETS, 'utf8'));
  assets.logo = { url: chosenLogo.url, prompt: LOGO_PROMPT, requestId: chosenLogo.requestId };
  for (const [role, spec] of Object.entries(ROLES)) {
    const candidate = data.stills?.[role]?.[Number(opt[role])];
    if (!candidate) throw Error(`No still candidate ${opt[role]} for ${role}.`);
    await copyFile(candidate.file, `public/${spec.file}`);
    const name = spec.file.replace(/\.png$/, '');
    assets.parents[name] = candidate.parent;
    assets.sources[name] = candidate.url;
    assets.prompts[spec.key] = signPrompt(spec.side);
    assets.requestIds[spec.key] = candidate.requestId;
  }
  assets.method = 'fal-ai/nano-banana-pro/edit, branding the previous stills listed under parents';
  assets.generatedAt = new Date().toISOString();
  await writeFile(ASSETS, `${JSON.stringify(assets, null, 2)}\n`);
  console.log('Promoted public/logo.png, public/pepe-cartoon.png, public/gigachad-cartoon.png');
  console.log('Paste into lib/show.ts:');
  for (const [role, spec] of Object.entries(ROLES))
    console.log(`  ${role}.source: '${assets.sources[spec.file.replace(/\.png$/, '')]}'`);
}

await mkdir(OUT, { recursive: true });
const key = mode === 'pick' ? null : await falKey();
if (mode === 'logo') await logo(key);
else if (mode === 'stills') await stills(key);
else if (mode === 'pick') await pick();
else throw Error(`Unknown mode: ${mode}`);
