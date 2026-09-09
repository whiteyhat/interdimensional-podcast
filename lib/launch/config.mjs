import { PublicKey } from '@solana/web3.js';

export const NETWORKS = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
});
export const DISCLOSURE = 'The listed wallets are controlled by the project.';
export const U64_MAX = (1n << 64n) - 1n;
export function textField(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || Array.from(value).some(c => c.charCodeAt(0) < 32) || new TextEncoder().encode(value).length > max)
    throw new Error(`${name} must be nonempty text of at most ${max} UTF-8 bytes.`);
  return value;
}
export function publicKey(value, name) {
  try { if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw Error(); }
  catch { throw new Error(`${name} must be a Solana public key.`); }
  return value;
}
export function uint(value, name, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > U64_MAX || (positive && BigInt(value) === 0n))
    throw new Error(`${name} must be an ${positive ? 'positive ' : ''}unsigned 64-bit integer string.`);
  return value;
}
export function publicUrl(value, name) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw Error();
    return url.href;
  } catch { throw new Error(`${name} must be a public HTTPS URL without credentials, query, or fragment.`); }
}
export function validateWallets(raw, creator, treasury) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error('Declare 1–100 project wallets.');
  const seen = new Set();
  const wallets = raw.map((w) => {
    const address = publicKey(w?.address, 'wallet address');
    if (seen.has(address)) throw new Error('Duplicate wallet address.');
    seen.add(address);
    if (typeof w.maySell !== 'boolean') throw new Error('Every wallet needs an explicit maySell policy.');
    if (typeof w.plannedTokens !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(w.plannedTokens) || w.plannedTokens.length > 30)
      throw new Error('plannedTokens must be a nonnegative token amount with at most six decimals.');
    return { address, label: textField(w.label, 'wallet label', 80), purpose: textField(w.purpose, 'wallet purpose', 500), plannedTokens: w.plannedTokens, maySell: w.maySell };
  });
  if (!seen.has(creator)) throw new Error('The creator must be in the wallet register.');
  if (!seen.has(treasury)) throw new Error('The treasury must be in the wallet register.');
  return wallets;
}
export function validateConfig(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Object.hasOwn(NETWORKS, raw.network)) throw new Error('Expected schemaVersion 1 and network mainnet-beta or devnet.');
  if (['cashback', 'mayhemMode', 'tokenizedAgent', 'frontRunningProtection'].some(k => raw[k] !== undefined && raw[k] !== false))
    throw new Error('Only standard coin creation is supported.');
  const creator = publicKey(raw.creator, 'creator');
  const treasury = publicKey(raw.treasury, 'treasury');
  if (!PublicKey.isOnCurve(new PublicKey(creator).toBytes())) throw new Error('creator must be a signing wallet.');
  const result = {
    schemaVersion: 1, network: raw.network, name: textField(raw.name, 'name', 32), symbol: textField(raw.symbol, 'symbol', 10),
    description: textField(raw.description, 'description', 2000), imagePath: textField(raw.imagePath, 'imagePath', 512),
    website: publicUrl(raw.website, 'website'), creator, treasury,
    buyLamports: uint(raw.buyLamports, 'buyLamports', true), maxTotalLamports: uint(raw.maxTotalLamports, 'maxTotalLamports', true),
    priorityMicroLamports: uint(raw.priorityMicroLamports, 'priorityMicroLamports'),
    wallets: validateWallets(raw.wallets, creator, treasury),
  };
  if (BigInt(result.maxTotalLamports) <= BigInt(result.buyLamports)) throw new Error('The total spending limit must include transaction fees and account rent.');
  for (const key of ['twitter', 'telegram', 'video']) if (raw[key]) result[key] = publicUrl(raw[key], key);
  return result;
}
export function metadataFor(config, image) {
  const metadata = { name: config.name, symbol: config.symbol, description: config.description, image: publicUrl(image, 'image'), showName: true, createdOn: 'https://pump.fun', website: config.website };
  for (const key of ['twitter', 'telegram', 'video']) if (config[key]) metadata[key] = config[key];
  return metadata;
}
export function tokenUnits(raw, decimals) {
  const amount = BigInt(raw);
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid token quantity.');
  if (!decimals) return amount.toString();
  const value = amount.toString().padStart(decimals + 1, '0');
  return `${value.slice(0, -decimals)}.${value.slice(-decimals)}`.replace(/\.?0+$/, '');
}
