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
  'flat 2D adult-animation cel style with soft painterly cel-shading gradients, bold but slightly worn dark outlines, like a Rick and Morty title card that has hung on a wall for years';
// Sampled from the actual studio stills, not a generic brand palette: the acoustic panels'
// dark teal, the walnut desk, the amber lamp glow (never a saturated poster-orange), and an
// aged cream close to old paper rather than stark white.
const PALETTE =
  'dark teal-olive (#2f3b30), warm walnut brown, muted burnt amber like lamplight (#b8703a), aged parchment cream (#e8dfc8), sage green';

const LOGO_PROMPT = `Design for a vintage enamel pin or screen-printed patch for the podcast "PEPE & CHAD LIVE", drawn in ${CEL}. Palette strictly limited to: ${PALETTE} — muted and slightly desaturated throughout, nothing bright, glossy or neon. A round badge with a worn, slightly uneven outline, like it has faded a little. Inside, two profiles face each other across a black studio microphone: on the left a green cartoon frog with big round eyes and wide red lips wearing black headphones, on the right a heavily bearded man with an enormous square jaw wearing black headphones, both rendered with the same soft cel-shading gradients as the rest of the palette, not flat vector color. A condensed hand-lettered-style wordmark "PEPE & CHAD" arched across the top in aged cream, and the word "LIVE" in a small muted-amber box at the bottom, not glowing. Underneath the badge, small monospace text "$FROGCLENCH" in sage green. Subtle fabric or enamel texture and grain, soft matte shading, no gloss, no gradients that look digital, no drop shadow, no watermark. The background behind the badge is transparent or a plain dark teal-olive flat color, not a separate colored square.`;

const signPrompt = (side) =>
  `Edit this 2D animated podcast frame. Add ONE small framed print or fabric patch pinned to the acoustic panel wall, showing EXACTLY the badge in the second image: the same worn circular badge, the same frog and bearded man profiles facing off across a mic, the same "PEPE & CHAD" wordmark, the same muted "LIVE" box and the same "$FROGCLENCH" text, in the same muted teal, walnut, amber and cream palette as the badge and the rest of this scene. Mount it flat on the dark teal acoustic panel wall in the upper ${side} of the background, above head height and behind the microphone boom, sized to about one eighth of the frame width — small, like a backstage keepsake, not a marquee. It is lit ONLY by the existing room light: the same dim, warm-cool lighting, the same brightness and the same slight haze as the shelf items behind it. It must NOT glow, NOT be brighter than its surroundings, and must cast only a soft, ordinary shadow like a framed print would. It must not cover any part of the character, the headphones, the microphone or the lamp. Change nothing else: keep the character, pose, expression, clothes, desk, lamp, shelves, panels, lighting, palette, line weight, camera angle and 16:9 framing identical to the first image. No other text, no watermark.`;

// A branded mug reads as a real prop in the room, which is why it is used for the co-host
// instead of a second wall sign — a studio would not hang two of the same badge.
const mugPrompt = `Edit this 2D animated podcast frame. On the black coffee mug already sitting on the desk, print a small circular badge logo matching EXACTLY the badge in the second image — the same frog and bearded man profiles, the same "PEPE & CHAD" wordmark, the same "LIVE" box — shrunk down and simplified to fit the curve of the mug the way a real printed mug logo would: fewer fine details, same muted teal, walnut, amber and cream palette, following the mug's existing shading and highlight so it looks printed on ceramic, not pasted flat. It is lit by the same room light as the mug already is, no glow, no extra highlight. It must be small, roughly a fifth of the mug's visible height, and must not change the mug's size, shape, position or color. Do not add any sign, print or patch anywhere else in the frame. Change nothing else: keep the character, pose, expression, clothes, desk, lamp, shelves, panels, wall, lighting, palette, line weight, camera angle and 16:9 framing identical to the first image. No other text, no watermark.`;

const ROLES = {
  host: { key: 'pepe', file: 'pepe-cartoon.png', prompt: (side) => signPrompt(side), side: 'right' },
  guest: { key: 'gigachad', file: 'gigachad-cartoon.png', prompt: () => mugPrompt },
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
    const name = spec.file.replace(/\.png$/, '');
    // Always brand the unbranded original. Editing an already-branded still compounds
    // the edits and leaves the previous logo behind next to the new one.
    const parent = assets.parents[name] ?? assets.sources[name];
    if (!parent) throw Error(`No original still for ${role} in ${ASSETS}`);
    process.stdout.write(`${role}: submitting `);
    const { images, requestId } = await generate('fal-ai/nano-banana-pro/edit', key, {
      prompt: spec.prompt(spec.side),
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
    assets.prompts[spec.key] = spec.prompt(spec.side);
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
