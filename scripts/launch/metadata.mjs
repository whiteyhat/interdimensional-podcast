import { readFile } from 'node:fs/promises';
import { digest } from './state.mjs';
import { metadataFor } from '../../lib/launch/config.mjs';

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Coin image must be a PNG, JPEG, GIF, or WebP file.');
}
export async function uploadMetadata(config, store, jwt, { fetcher = fetch, imageBytes } = {}) {
  const state = await store.read('state.json');
  if (state.revision > 0 || state.submissions?.length) throw new Error('Metadata is frozen once a transaction is prepared. Use the saved metadata for this launch.');
  if (!jwt) throw new Error('Set PINATA_JWT in the local environment before uploading.');
  const bytes = imageBytes ?? await readFile(config.imagePath);
  if (!bytes.length || bytes.length > 5_000_000) throw new Error('Coin image must be at most 5 MB.');
  const mime = imageMime(bytes);
  let receipts = {};
  try { receipts = await store.read('uploads.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  async function pin(endpoint, body, json = false) {
    let response;
    try { response = await fetcher(`https://api.pinata.cloud/pinning/${endpoint}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${jwt}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(body) : body, signal: AbortSignal.timeout(60000) }); }
    catch { throw new Error('Pinata upload failed or timed out. Retrying reuses saved upload receipts.'); }
    if (!response.ok) throw new Error(`Pinata rejected the upload (HTTP ${response.status}).`);
    const result = await response.json();
    if (typeof result.IpfsHash !== 'string' || !/^[a-zA-Z0-9]{5,100}$/.test(result.IpfsHash)) throw new Error('Pinata returned an invalid content identifier.');
    return result.IpfsHash;
  }
  const imageHash = digest(bytes);
  if (receipts.image?.hash !== imageHash) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `coin.${mime.split('/')[1]}`);
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    receipts.image = { hash: imageHash, cid: await pin('pinFileToIPFS', form) };
    await store.write('uploads.json', receipts);
  }
  const metadata = metadataFor(config, `https://ipfs.io/ipfs/${receipts.image.cid}`);
  const metadataHash = digest(metadata);
  if (receipts.metadata?.hash !== metadataHash) {
    receipts.metadata = { hash: metadataHash, cid: await pin('pinJSONToIPFS', { pinataContent: metadata, pinataOptions: { cidVersion: 1 } }, true) };
    await store.write('uploads.json', receipts);
  }
  const result = { metadata, metadataUri: `https://ipfs.io/ipfs/${receipts.metadata.cid}`, metadataHash };
  await store.write('metadata.json', result);
  return result;
}
