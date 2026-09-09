import { createRequire } from 'node:module';
import BN from 'bn.js';
import { Connection, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getMint, getTokenMetadata, getAccount, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { getBase58Decoder } from '@solana/kit';
import { NETWORKS } from '../../lib/launch/config.mjs';
import { PUMP, TOKEN_2022, associated, pda, reviewPrepared, makeSignedEnvelope, reviewedDigest, decodeTx, encodeTx, messageDigest } from '../../lib/launch/artifact.mjs';

// The package's ESM entry pulls an incompatible named Anchor export under Node 22.
// Its published CommonJS entry is supported; keep this boundary out of browser imports.
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = createRequire(import.meta.url)('@pump-fun/pump-sdk');
const ALTS = { 'mainnet-beta': '7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe', devnet: '7y3623xaVQzsLxHRyp1wQD4Pmer5JjgbaagGFAEqCjua' };
const settled = new Set(['finalized', 'recovered', 'failed', 'expired']);
const checkedNumber = (n) => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('RPC returned an unsafe lamport quantity.'); return BigInt(n); };
export function connectionFor(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Set SOLANA_RPC_URL to an HTTPS Solana RPC.'); }
  if (parsed.protocol !== 'https:') throw new Error('SOLANA_RPC_URL must use HTTPS.');
  return new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: async (input, init) => {
    try { return await fetch(input, { ...init, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch { throw new Error('Solana RPC connection failed.'); }
  } });
}
export async function assertNetwork(connection, network) {
  if (await connection.getGenesisHash() !== NETWORKS[network]) throw new Error('RPC network does not match the configured launch network.');
}
export function requireSettled(state) {
  if (state.submissions.some(s => !settled.has(s.status))) throw new Error('An earlier submission is unresolved. Run status before preparing another transaction.');
}
export async function reconcile(store, state, connection, verifyCreation) {
  const pending = state.submissions.filter(s => !settled.has(s.status));
  if (!pending.length) return state;
  const [{ value }, epoch] = await Promise.all([
    connection.getSignatureStatuses(pending.map(s => s.signature), { searchTransactionHistory: true }),
    connection.getEpochInfo('finalized'),
  ]);
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i], status = value[i];
    if (status) {
      const commitment = status.confirmationStatus ?? (status.confirmations === null ? 'finalized' : 'processed');
      entry.status = status.err ? (commitment === 'finalized' ? 'failed' : 'unknown') : commitment;
      if (status.err) entry.error = 'Transaction failed on chain.';
    } else if (epoch.blockHeight > entry.lastValidBlockHeight && !(await connection.isBlockhashValid(entry.blockhash, { commitment: 'finalized' })).value) {
      if (entry.kind === 'create' && await connection.getAccountInfo(new PublicKey(state.mint), 'finalized')) {
        entry.status = 'unknown';
        entry.recovery = 'Mint exists; its launch intent needs verification.';
        if (verifyCreation) {
          await verifyCreation();
          entry.status = 'recovered';
          entry.recovery = 'Finalized mint intent verified; transaction signature history is unavailable.';
        }
      } else entry.status = 'expired';
    }
  }
  await store.write('state.json', state);
  return state;
}
export async function verifyMint(config, state, connection, metadataUri, commitment = 'finalized') {
  await assertNetwork(connection, config.network);
  const mint = new PublicKey(state.mint);
  const [info, curveInfo] = await Promise.all([connection.getAccountInfo(mint, commitment), connection.getAccountInfo(pda(PUMP, 'bonding-curve', mint), commitment)]);
  if (!info) throw new Error('The launch mint has not been verified on chain yet.');
  if (!info.owner.equals(TOKEN_2022) || !curveInfo?.owner.equals(PUMP)) throw new Error('Mint or bonding-curve program does not match this launch.');
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (curve.creator.toBase58() !== config.creator || curve.isMayhemMode || curve.isCashbackCoin) throw new Error('On-chain creator or coin mode differs from the launch intent.');
  const [mintState, metadata] = await Promise.all([getMint(connection, mint, commitment, info.owner), getTokenMetadata(connection, mint, commitment, info.owner)]);
  if (mintState.decimals !== 6 || !metadata || metadata.name !== config.name || metadata.symbol !== config.symbol || metadata.uri !== metadataUri) throw new Error('On-chain metadata does not match the launch intent.');
  return { mint, program: info.owner, decimals: mintState.decimals, supply: mintState.supply };
}
async function estimateDebit(connection, tx, buyLamports) {
  // Count every writable account's prospective rent as well as the purchase ceiling. This
  // conservative bound does not confuse a concurrent deposit into the payer with lower costs.
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l => {
    const { value } = await connection.getAddressLookupTable(l.accountKey); if (!value) throw new Error('Missing lookup table.'); return value;
  }));
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
  const writable = Array.from({ length: keys.length }, (_, i) => i).filter(i => tx.message.isAccountWritable(i)).map(i => keys.get(i));
  const [before, simulation, fee] = await Promise.all([
    connection.getMultipleAccountsInfo(writable, 'confirmed'),
    connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: writable.map(k => k.toBase58()) } }),
    connection.getFeeForMessage(tx.message, 'confirmed'),
  ]);
  if (simulation.value.err) throw new Error(`Launch simulation failed: ${JSON.stringify(simulation.value.err)}`);
  if (!simulation.value.accounts || fee.value === null) throw new Error('RPC could not estimate launch fees and account rent.');
  let rent = 0n;
  for (let i = 0; i < writable.length; i++) {
    const after = simulation.value.accounts[i];
    if (!after || writable[i].equals(tx.message.staticAccountKeys[0])) continue;
    const size = Buffer.from(after.data[0], 'base64').length;
    const required = checkedNumber(await connection.getMinimumBalanceForRentExemption(size, 'confirmed'));
    const existing = before[i] ? checkedNumber(before[i].lamports) : 0n;
    if (required > existing) rent += required - existing;
  }
  return (BigInt(buyLamports) + rent + checkedNumber(fee.value)).toString();
}
export async function buildPrepared(config, state, keypair, metadataUri, connection, kind = 'create') {
  requireSettled(state);
  await assertNetwork(connection, config.network);
  const creator = new PublicKey(config.creator), mint = keypair.publicKey;
  if (mint.toBase58() !== state.mint) throw new Error('Mint keypair does not match the launch identity.');
  const online = new OnlinePumpSdk(connection);
  let instructions, quotedTokens = '0', buyLamports = '0';
  const units = kind === 'create' ? 390000 : 50000;
  if (kind === 'create') {
    if (await connection.getAccountInfo(mint, 'confirmed')) throw new Error('This mint already exists. Verify status; a second launch will not be prepared.');
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    if (!global.createV2Enabled) throw new Error('Pump create-v2 is not enabled on this network.');
    const feeRecipient = global.feeRecipient, buybackFeeRecipient = global.buybackFeeRecipients?.[0];
    if (!buybackFeeRecipient || buybackFeeRecipient.equals(PublicKey.default)) throw new Error('Pump fee-recipient configuration is unavailable.');
    buyLamports = config.buyLamports;
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(buyLamports), quoteMint: PublicKey.default });
    if (amount.lten(0)) throw new Error('Initial purchase is too small to receive tokens.');
    quotedTokens = amount.toString();
    instructions = [
      await PUMP_SDK.createV2Instruction({ mint, name: config.name, symbol: config.symbol, uri: metadataUri, creator, user: creator, mayhemMode: false, cashback: false }),
      createAssociatedTokenAccountIdempotentInstruction(creator, associated(mint, creator), creator, mint, TOKEN_2022),
      await PUMP_SDK.getBuyInstructionRaw({ user: creator, mint, creator, amount, solAmount: new BN(buyLamports), feeRecipient, buybackFeeRecipient, tokenProgram: TOKEN_2022 }),
    ];
  } else {
    const verified = await verifyMint(config, state, connection, metadataUri);
    const owner = new PublicKey(config.treasury), ata = associated(mint, owner, verified.program);
    const existing = await connection.getAccountInfo(ata, 'finalized');
    if (existing) {
      const account = await getAccount(connection, ata, 'finalized', verified.program);
      if (!account.mint.equals(mint) || !account.owner.equals(owner)) throw new Error('Treasury token account does not match.');
      throw new Error('Treasury token account is already ready; no transaction is needed.');
    }
    instructions = [createAssociatedTokenAccountIdempotentInstruction(creator, ata, owner, mint, verified.program)];
  }
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(config.priorityMicroLamports) }), ...instructions];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const { value: table } = await connection.getAddressLookupTable(new PublicKey(ALTS[config.network]));
  let tx, encoded;
  try {
    tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: all }).compileToV0Message(table?.isActive() ? [table] : []));
    if (kind === 'create') tx.sign([keypair]);
    encoded = encodeTx(tx);
    if (tx.serialize().length > 1232) throw Error();
  }
  catch { throw new Error('Atomic launch transaction exceeds Solana size limits. Check the network lookup table; creation will not be split into separate trades.'); }
  const estimatedTotalLamports = await estimateDebit(connection, tx, buyLamports);
  if (BigInt(estimatedTotalLamports) > BigInt(config.maxTotalLamports)) throw new Error('Estimated total spending exceeds maxTotalLamports.');
  if (checkedNumber(await connection.getBalance(creator, 'confirmed')) < BigInt(estimatedTotalLamports)) throw new Error('Creator wallet has insufficient SOL for the purchase, fees, and rent.');
  const artifact = { schemaVersion: 1, id: state.id, revision: state.revision + 1, kind, network: config.network, genesisHash: NETWORKS[config.network],
    mint: state.mint, creator: config.creator, treasury: config.treasury, name: config.name, symbol: config.symbol, metadataUri,
    buyLamports, maxTotalLamports: config.maxTotalLamports, quotedTokens, estimatedTotalLamports, blockhash, lastValidBlockHeight, transaction: encoded, messageHash: await messageDigest(tx) };
  await reviewPrepared(artifact, connection);
  return artifact;
}
export async function submitPrepared(store, state, signed, connection) {
  if (signed?.schemaVersion !== 1 || signed.id !== state.id || signed.revision !== state.revision) throw new Error('Signed artifact does not match the current launch revision.');
  const prepared = await store.read(`prepared-${state.revision}.json`);
  if (typeof signed.reviewHash !== 'string' || signed.reviewHash !== reviewedDigest(prepared)) throw new Error('Reviewed launch intent differs from the stored artifact. Re-import and review the current prepared file.');
  const tx = decodeTx(signed.transaction);
  makeSignedEnvelope(prepared, tx);
  const signature = getBase58Decoder().decode(tx.signatures[0]);
  const prior = state.submissions.find(s => s.signature === signature);
  if (prior) { await reconcile(store, state, connection); return state.submissions.find(s => s.signature === signature); }
  requireSettled(state);
  await reviewPrepared(prepared, connection);
  const sim = await connection.simulateTransaction(tx, { sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' });
  if (sim.value.err) throw new Error(`Signed transaction failed preflight: ${JSON.stringify(sim.value.err)}`);
  const currentEstimate = await estimateDebit(connection, tx, prepared.buyLamports);
  if (BigInt(currentEstimate) > BigInt(prepared.maxTotalLamports)) throw new Error('Current estimated spending exceeds the reviewed budget. Prepare and review a new revision.');
  const entry = { signature, revision: state.revision, kind: prepared.kind, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, status: 'unknown', attemptedAt: new Date().toISOString() };
  state.submissions.push(entry);
  await store.write('state.json', state);
  try {
    const returned = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    if (returned !== signature) throw new Error('RPC returned a different signature.');
    await reconcile(store, state, connection);
  } catch { /* Persisted as unknown: status must reconcile it, never silently launch again. */ }
  return entry;
}
