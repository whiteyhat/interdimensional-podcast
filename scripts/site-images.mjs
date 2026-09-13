#!/usr/bin/env node
// The rasters the pages display, as AVIF, plus the two icons: all cut from PNGs the repo keeps
// for other reasons. Run after replacing public/logo.png, a conditioning frame or a cap template:
//   node scripts/site-images.mjs
//
// What stays PNG, and why: logo.png is the pump.fun coin image and the Solana Pay wallet icon;
// pepe-video.png and gigachad-video.png are the exact frames fal conditions on, and a test
// decodes them; the cap templates are what the media service composites onto; share-card.png is
// read by link-preview crawlers; and the tab and home-screen icons are read by browsers that do
// not decode AVIF in those places.
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// 4:4:4 keeps the ink lines and the red lips crisp. At this quality a 1344x768 cartoon frame
// is about 45 KB, a thirtieth of its PNG, with no visible difference at 1:1.
const AVIF = { quality: 65, effort: 9, chromaSubsampling: '4:4:4' };

/** Write `source` as AVIF at `dest`, resized to a `size` square when given. */
export async function avif(source, dest, size) {
  const image = sharp(source);
  if (size) image.resize(size, size);
  await image.avif(AVIF).toFile(dest);
  return dest;
}

const icon = (size, dest) =>
  sharp('public/logo.png')
    .resize(size, size)
    .png({ palette: true, compressionLevel: 9 })
    .toFile(dest);

/** [source PNG, AVIF the pages load, square size when the display is far smaller]. */
const IMAGES = [
  ['public/logo.png', 'public/logo.avif', 512],
  ['public/pepe-video.png', 'public/pepe-video.avif'],
  ['public/gigachad-video.png', 'public/gigachad-video.avif'],
  ['public/wearables/pepe-cap-v1.png', 'public/wearables/pepe-cap-v1.avif'],
  ['public/wearables/gigachad-cap-v1.png', 'public/wearables/gigachad-cap-v1.avif'],
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kb = async (file) => `${Math.round((await stat(file)).size / 1024)} KB`;
  for (const [source, dest, size] of IMAGES) {
    await avif(source, dest, size);
    console.log(`${dest}  ${await kb(dest)}  (from ${await kb(source)})`);
  }
  await icon(96, 'public/favicon.png');
  await icon(180, 'public/apple-icon.png');
  console.log(`public/favicon.png  ${await kb('public/favicon.png')}`);
  console.log(`public/apple-icon.png  ${await kb('public/apple-icon.png')}`);
}
