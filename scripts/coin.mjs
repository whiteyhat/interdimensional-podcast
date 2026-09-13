#!/usr/bin/env node
// Coin logo: the badge from work/brand/logo-full.png, redrawn so Chad matches the on-air
// Gigachad still, with no ticker text and the round coin filling the whole 1:1 image.
//   node scripts/coin.mjs --variants 2      candidates in work/brand/coin/
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { download, fal, falKey, generate } from './fal.mjs';

const { values: opt } = parseArgs({
  options: { variants: { type: 'string', default: '2' }, seed: { type: 'string' } },
});
const OUT = 'work/brand/coin';
const SOURCE = 'work/brand/logo-full.png'; // already cropped: coin fills the square, no ticker text
const CHAD = 'https://v3b.fal.media/files/b/0aa9975a/z4WfXzKN2ADHGOl_Vk60J_ifRTwuae.png';

const PROMPT = `Edit the first image, a round podcast badge logo. Make exactly ONE change and keep everything else pixel-identical: the frog with headphones on the left, the black studio microphone in the middle, the arched "PEPE & CHAD" wordmark on top, the "LIVE" box at the bottom, the flat 2D cartoon style, the dark olive ring, the warm amber center, the bold dark outlines, the colors, and the round coin filling the whole square image with flat dark olive corners.

The change: redraw the bearded man on the right so he is the SAME character as the man in the second image: short dark near-black hair slicked back, a thick full black beard trimmed square, heavy dark eyebrows, narrow confident half-lidded eyes, an enormous square chiseled jaw and thick neck, a plain black crew-neck t-shirt, a huge shoulder. Keep his black over-ear headphones and keep him in side profile facing the microphone, at the same size and position as before. He must no longer have long brown hair, a brown beard, or a tan shirt.

No text outside the coin, no watermark, no signature.`;

async function upload(key, path) {
  const init = await fal(
    'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
    key,
    { file_name: 'logo-full.png', content_type: 'image/png' },
  );
  const put = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: await readFile(path),
  });
  if (!put.ok) throw Error(`upload ${put.status}`);
  return init.file_url;
}

const key = await falKey();
process.stdout.write('uploading source ');
const sourceUrl = await upload(key, SOURCE);
console.log(sourceUrl);
process.stdout.write('coin: submitting ');
const { images, requestId } = await generate('fal-ai/nano-banana-pro/edit', key, {
  prompt: PROMPT,
  image_urls: [sourceUrl, CHAD],
  num_images: Number(opt.variants),
  aspect_ratio: '1:1',
  resolution: '1K',
  output_format: 'png',
  ...(opt.seed ? { seed: Number(opt.seed) } : {}),
});
const out = [];
for (const [index, image] of images.entries()) {
  const file = `${OUT}/coin-${index}.png`;
  await download(image.url, file);
  out.push({ index, file, url: image.url, requestId, sourceUrl });
}
await writeFile(`${OUT}/manifest.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(` ${images.length} image(s)`);
for (const c of out) console.log(`  coin #${c.index}  ${c.file}  ${c.url}`);
