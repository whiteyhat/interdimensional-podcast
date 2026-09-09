// Browser-safe verification for the exact instruction formats emitted by Pump SDK 1.36.0.
// This module never imports the SDK, filesystem code, provider credentials, or wallet keys.
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { NETWORKS, publicKey, publicUrl, textField, uint } from './config.mjs';

export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
const FEES = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s.toBuffer()), program)[0];
export const associated = (mint, owner, program = TOKEN_2022) => pda(ASSOCIATED, owner, program, mint);
const CREATE = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
const BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const encodeTx = tx => Buffer.from(tx.serialize()).toString('base64');
export function decodeTx(raw) {
  if (typeof raw !== 'string' || raw.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Invalid transaction encoding.');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > 1232 || bytes.toString('base64') !== raw) throw new Error('Invalid transaction size or encoding.');
  try { const tx = VersionedTransaction.deserialize(bytes); if (tx.version !== 0) throw Error(); return tx; }
  catch { throw new Error('Expected a version 0 Solana transaction.'); }
}
export async function messageDigest(tx) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(tx.message.serialize()))).toString('hex');
}
// Bind all fields displayed by the trusted signing page, not just the on-chain message.
// A modified imported budget must not be silently replaced by the stored CLI budget.
export function reviewedDigest(artifact) {
  const fields = ['schemaVersion', 'id', 'revision', 'kind', 'network', 'genesisHash', 'creator', 'treasury', 'mint',
    'name', 'symbol', 'metadataUri', 'buyLamports', 'maxTotalLamports', 'quotedTokens', 'estimatedTotalLamports',
    'blockhash', 'lastValidBlockHeight', 'messageHash', 'transaction'];
  return Buffer.from(nacl.hash(Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k => [k, artifact[k]])))))).toString('hex');
}
function checkSignatures(tx, creatorRequired) {
  const bytes = tx.message.serialize();
  for (let i = 0; i < tx.message.header.numRequiredSignatures; i++) {
    const signature = tx.signatures[i];
    if (!creatorRequired && i === 0 && signature.every(b => b === 0)) continue;
    if (!nacl.sign.detached.verify(bytes, signature, tx.message.staticAccountKeys[i].toBytes())) throw new Error('Missing or invalid transaction signature.');
  }
}
function checkKeys(ix, expected) {
  if (ix.keys.length !== expected.length || expected.some((key, i) => key && !ix.keys[i].pubkey.equals(key)))
    throw new Error('Instruction accounts do not match the launch intent.');
}
function checkAta(ix, mint, payer, owner, program) {
  if (!ix.programId.equals(ASSOCIATED) || !ix.data.equals(Buffer.from([1]))) throw new Error('Expected one idempotent token-account instruction.');
  checkKeys(ix, [payer, associated(mint, owner, program), owner, mint, SystemProgram.programId, program]);
}
function readString(data, cursor) {
  if (cursor.at + 4 > data.length) throw new Error('Malformed metadata instruction.');
  const size = data.readUInt32LE(cursor.at); cursor.at += 4;
  if (size > 2000 || cursor.at + size > data.length) throw new Error('Malformed metadata instruction.');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(cursor.at, cursor.at + size)); cursor.at += size;
  return value;
}
function validateInstructions(a, instructions, tokenProgram) {
  if (instructions.length !== (a.kind === 'create' ? 5 : 3)) throw new Error('Unexpected launch instructions.');
  const [limit, price] = instructions;
  if (!limit.programId.equals(ComputeBudgetProgram.programId) || limit.data.length !== 5 || limit.data[0] !== 2 || limit.keys.length ||
      !price.programId.equals(ComputeBudgetProgram.programId) || price.data.length !== 9 || price.data[0] !== 3 || price.keys.length)
    throw new Error('Invalid compute-budget instructions.');
  const units = limit.data.readUInt32LE(1);
  if (units === 0 || units > 1400000) throw new Error('Invalid compute limit.');
  const fee = (BigInt(units) * price.data.readBigUInt64LE(1) + 999999n) / 1000000n;
  if (fee + BigInt(a.buyLamports) > BigInt(a.maxTotalLamports) || BigInt(a.estimatedTotalLamports) > BigInt(a.maxTotalLamports))
    throw new Error('Transaction exceeds the spending limit.');
  const creator = new PublicKey(a.creator), mint = new PublicKey(a.mint);
  if (a.kind === 'treasury') {
    if (a.buyLamports !== '0' || a.quotedTokens !== '0') throw new Error('Treasury setup cannot contain a purchase.');
    checkAta(instructions[2], mint, creator, new PublicKey(a.treasury), tokenProgram);
    return;
  }
  const [, , create, ata, buy] = instructions;
  if (!create.programId.equals(PUMP) || !create.data.subarray(0, 8).equals(CREATE) || !buy.programId.equals(PUMP) || !buy.data.subarray(0, 8).equals(BUY))
    throw new Error('Only standard Pump creation and its initial purchase are supported.');
  const cursor = { at: 8 };
  if (readString(create.data, cursor) !== a.name || readString(create.data, cursor) !== a.symbol || readString(create.data, cursor) !== a.metadataUri)
    throw new Error('Transaction metadata differs from the displayed intent.');
  if (create.data.length !== cursor.at + 34 || !new PublicKey(create.data.subarray(cursor.at, cursor.at + 32)).equals(creator) || create.data[cursor.at + 32] !== 0 || create.data[cursor.at + 33] !== 0)
    throw new Error('Creator or coin mode differs from the launch intent.');
  const curve = pda(PUMP, 'bonding-curve', mint), global = pda(PUMP, 'global'), event = pda(PUMP, '__event_authority');
  const solVault = pda(MAYHEM, 'sol-vault');
  checkKeys(create, [mint, pda(PUMP, 'mint-authority'), curve, associated(mint, curve), global, creator,
    SystemProgram.programId, TOKEN_2022, ASSOCIATED, MAYHEM, pda(MAYHEM, 'global-params'), solVault,
    pda(MAYHEM, 'mayhem-state', mint), associated(mint, solVault), event, PUMP]);
  checkAta(ata, mint, creator, creator, TOKEN_2022);
  if (buy.data.length !== 25 || buy.data.readBigUInt64LE(8).toString() !== a.quotedTokens || buy.data.readBigUInt64LE(16).toString() !== a.buyLamports || buy.data[24] !== 1)
    throw new Error('Purchase amount differs from the displayed spending limit.');
  // The Pump program validates fee-recipient membership against its configuration. All other
  // accounts are derived here; no arbitrary transfer, approval, or additional operation is allowed.
  checkKeys(buy, [global, null, mint, curve, associated(mint, curve), associated(mint, creator), creator,
    SystemProgram.programId, TOKEN_2022, pda(PUMP, 'creator-vault', creator), event, PUMP,
    pda(PUMP, 'global_volume_accumulator'), pda(PUMP, 'user_volume_accumulator', creator),
    pda(FEES, 'fee_config', PUMP), FEES, pda(PUMP, 'bonding-curve-v2', mint), null]);
}
export async function reviewPrepared(raw, connection) {
  if (!raw || raw.schemaVersion !== 1 || !['create', 'treasury'].includes(raw.kind) || !Object.hasOwn(NETWORKS, raw.network)) throw new Error('Invalid launch artifact.');
  const a = { schemaVersion: 1, id: textField(raw.id, 'id', 80), revision: raw.revision, kind: raw.kind, network: raw.network,
    genesisHash: raw.genesisHash, creator: publicKey(raw.creator, 'creator'), treasury: publicKey(raw.treasury, 'treasury'), mint: publicKey(raw.mint, 'mint'),
    name: textField(raw.name, 'name', 32), symbol: textField(raw.symbol, 'symbol', 10), metadataUri: publicUrl(raw.metadataUri, 'metadataUri'),
    buyLamports: uint(raw.buyLamports, 'buyLamports', raw.kind === 'create'), maxTotalLamports: uint(raw.maxTotalLamports, 'maxTotalLamports', true),
    quotedTokens: uint(raw.quotedTokens, 'quotedTokens', raw.kind === 'create'), estimatedTotalLamports: uint(raw.estimatedTotalLamports, 'estimatedTotalLamports', true),
    blockhash: publicKey(raw.blockhash, 'blockhash'), lastValidBlockHeight: raw.lastValidBlockHeight,
    messageHash: raw.messageHash, transaction: raw.transaction };
  if (!Number.isSafeInteger(a.revision) || a.revision < 1 || !Number.isSafeInteger(a.lastValidBlockHeight) || a.lastValidBlockHeight < 1) throw new Error('Invalid artifact revision or expiry.');
  const tx = decodeTx(a.transaction);
  if (tx.message.recentBlockhash !== a.blockhash || await messageDigest(tx) !== a.messageHash) throw new Error('Transaction message or blockhash has changed.');
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58());
  if (signers.length !== (a.kind === 'create' ? 2 : 1) || signers[0] !== a.creator || (a.kind === 'create' && signers[1] !== a.mint)) throw new Error('Unexpected transaction signers.');
  checkSignatures(tx, false);
  const [genesis, valid, tables] = await Promise.all([
    connection.getGenesisHash(), connection.isBlockhashValid(a.blockhash, { commitment: 'confirmed' }),
    Promise.all(tx.message.addressTableLookups.map(async lookup => {
      const { value } = await connection.getAddressLookupTable(lookup.accountKey);
      if (!value || !value.isActive()) throw new Error('Address lookup table is missing or inactive.');
      return value;
    })),
  ]);
  if (genesis !== NETWORKS[a.network] || genesis !== a.genesisHash) throw new Error('RPC network does not match the launch network.');
  if (!valid.value) throw new Error('Transaction expired. Prepare again with the same launch workspace.');
  let tokenProgram = TOKEN_2022;
  if (a.kind === 'treasury') {
    const info = await connection.getAccountInfo(new PublicKey(a.mint), 'confirmed');
    if (!info || ![TOKEN, TOKEN_2022].some(k => k.equals(info.owner))) throw new Error('Mint token program could not be verified.');
    tokenProgram = info.owner;
  }
  validateInstructions(a, TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }).instructions, tokenProgram);
  return { artifact: a, transaction: tx };
}
export function makeSignedEnvelope(artifact, transaction) {
  const prepared = decodeTx(artifact.transaction);
  if (!Buffer.from(transaction.message.serialize()).equals(Buffer.from(prepared.message.serialize()))) throw new Error('Wallet changed the prepared transaction message.');
  checkSignatures(transaction, true);
  return { schemaVersion: 1, id: artifact.id, revision: artifact.revision, reviewHash: reviewedDigest(artifact), transaction: encodeTx(transaction) };
}
