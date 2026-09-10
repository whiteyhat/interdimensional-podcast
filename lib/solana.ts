// Server-only Solana helpers: prices, balances, quote transactions and payment checks.
// Built on @solana/kit 6 and @solana/pay; never import this from a client component.
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getAddressEncoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
  type Address,
  type Base64EncodedWireTransaction,
} from '@solana/kit';
import { createTransfer, findReference } from '@solana/pay';
import nacl from 'tweetnacl';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  AccountState,
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  checkTransfer,
  fail,
  fixedPrice,
  friendlyPayError,
  HttpError,
  interactLimits,
  isRequoteError,
  readJupiterPrice,
  readPumpPrice,
} from './interact';
import { fetchJson } from './http';
import { isTransportError, withRetry } from './rpc-upstream';

const clients = new Map<string, ReturnType<typeof createSolanaRpc>>();
/** One RPC client per URL per isolate. */
export function rpcFor(url: string) {
  let rpc = clients.get(url);
  if (!rpc) {
    rpc = createSolanaRpc(url);
    clients.set(url, rpc);
  }
  return rpc;
}
export type SolanaRpc = ReturnType<typeof rpcFor>;

/** Everything an error can tell us, including the RPC server's own message. */
export function errorText(e: unknown) {
  if (!(e instanceof Error)) return String(e);
  const context = (e as { context?: unknown }).context;
  let extra = '';
  try {
    extra = context ? JSON.stringify(context) : '';
  } catch {
    extra = '';
  }
  return `${e.message} ${extra}`.trim();
}
function friendly(e: unknown, ticker: string): unknown {
  if (e instanceof HttpError) return e;
  const mapped = friendlyPayError(errorText(e), ticker);
  return mapped ? fail(mapped.status, mapped.error, mapped.code) : e;
}


// ---- price -------------------------------------------------------------------------

let priceMemo: { mint: string; at: number; value: number } | null = null;
/**
 * Dollars per token: Jupiter first, pump.fun's market cap over supply as the fallback,
 * remembered for a few seconds per isolate. PRICE_FIXED (tokens per dollar) wins on devnet.
 */
export async function priceUsd(
  mint: string,
  decimals: number,
  now = Date.now(),
  fixed?: string,
): Promise<number> {
  const pinned = fixedPrice(fixed);
  if (pinned) return pinned;
  if (priceMemo && priceMemo.mint === mint && now - priceMemo.at < interactLimits.priceCacheMs)
    return priceMemo.value;
  let value: number | null = null;
  try {
    value = readJupiterPrice(await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { timeoutMs: 6000 }), mint);
  } catch (e) {
    console.warn('[interact] jupiter price failed', e instanceof Error ? e.message : e);
  }
  if (!value) {
    try {
      value = readPumpPrice(await fetchJson(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, { timeoutMs: 6000 }), decimals);
    } catch (e) {
      console.warn('[interact] pump.fun price failed', e instanceof Error ? e.message : e);
    }
  }
  if (!value) throw fail(503, 'The coin has no price right now; try again in a moment.', 'PRICE');
  priceMemo = { mint, at: now, value };
  return value;
}

// ---- mint, balances, treasury -------------------------------------------------------

export type MintInfo = { program: Address; decimals: number };
const mints = new Map<string, MintInfo>();
/** Token program and decimals straight from the mint account; the HTTP feeds are never trusted for this. */
export async function mintInfo(rpc: SolanaRpc, mint: string): Promise<MintInfo> {
  const hit = mints.get(mint);
  if (hit) return hit;
  const account = await fetchMaybeMint(rpc, address(mint));
  if (!account.exists || !account.data.isInitialized)
    throw fail(503, 'The coin could not be found on this network.', 'MINT');
  if (
    account.programAddress !== TOKEN_PROGRAM_ADDRESS &&
    account.programAddress !== TOKEN_2022_PROGRAM_ADDRESS
  )
    throw fail(503, 'The configured mint is not a token.', 'MINT');
  const info = { program: account.programAddress, decimals: account.data.decimals };
  mints.set(mint, info);
  return info;
}
/** Tokens the wallet holds for the mint across all its token accounts, in UI units. */
export async function tokenBalance(rpc: SolanaRpc, owner: string, mint: string) {
  const { value } = await rpc
    .getTokenAccountsByOwner(address(owner), { mint: address(mint) }, { encoding: 'jsonParsed' })
    .send();
  let base = BigInt(0);
  let decimals = 0;
  for (const entry of value) {
    const amount = entry.account.data.parsed.info.tokenAmount;
    base += BigInt(amount.amount);
    decimals = amount.decimals;
  }
  return Number(base) / 10 ** decimals;
}
const treasuries = new Map<string, { at: number; ok: boolean }>();
/** The treasury can only receive the coin once its associated token account exists. */
export async function treasuryReady(
  rpc: SolanaRpc,
  treasury: string,
  mint: string,
  program: Address,
  now = Date.now(),
) {
  const key = `${treasury}:${mint}`;
  const hit = treasuries.get(key);
  if (hit && now - hit.at < interactLimits.treasuryCacheMs) return hit.ok;
  const [ata] = await findAssociatedTokenPda({
    owner: address(treasury),
    tokenProgram: program,
    mint: address(mint),
  });
  const account = await fetchMaybeToken(rpc, ata);
  const ok = account.exists && account.data.state === AccountState.Initialized;
  treasuries.set(key, { at: now, ok });
  return ok;
}

// ---- quote transaction --------------------------------------------------------------

/** A fresh 32-byte key that only this payment will ever carry. */
/**
 * What this transfer should bid per compute unit, from the provider's own estimate.
 *
 * The bid used to be a constant, 100,000 micro-lamports per unit: over the 60,000-unit budget
 * that is 6,000 lamports, a tenth of a cent, so cost was never the constraint -- landing was.
 * A constant is wrong in both directions: too high to be needed on a quiet network, and not
 * enough to be heard on a busy one. Helius's estimate is keyed on the accounts the transaction
 * touches, which is what actually determines contention. The floor is Helius's own threshold
 * for routing a send through its staked lane; the ceiling is a cent on this budget, which is
 * as much insurance as a five-dollar payment needs. On any failure the old constant stands,
 * because devnet, a local validator and a provider that is not Helius do not know this method
 * and the quote must still be issued.
 */
export const priorityFee = {
  fallbackMicroLamports: 100_000,
  minMicroLamports: 10_000,
  maxMicroLamports: 1_000_000,
  timeoutMs: 2_500,
} as const;
export async function priorityFeeFor(rpcUrl: string, accountKeys: string[]): Promise<number> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getPriorityFeeEstimate',
        params: [{ accountKeys, options: { recommended: true } }],
      }),
      signal: AbortSignal.timeout(priorityFee.timeoutMs),
    });
    const body = (await response.json()) as { result?: { priorityFeeEstimate?: unknown } };
    const estimate = Number(body?.result?.priorityFeeEstimate);
    if (!Number.isFinite(estimate) || estimate <= 0) return priorityFee.fallbackMicroLamports;
    return Math.min(priorityFee.maxMicroLamports, Math.max(priorityFee.minMicroLamports, Math.round(estimate)));
  } catch {
    return priorityFee.fallbackMicroLamports;
  }
}
export function randomReference(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return address(getBase58Decoder().decode(bytes));
}
export type QuoteFields = {
  wallet: string;
  recipient: string;
  mint: string;
  amountUi: number;
  reference: Address;
};
/**
 * The unsigned wire transaction the wallet signs: fee payer = the viewer, compute budget
 * first, the Solana Pay transfer (with the reference attached) last.
 */
export async function buildQuoteTx(
  rpc: SolanaRpc,
  fields: QuoteFields,
  ticker: string,
  priorityMicroLamports: number = priorityFee.fallbackMicroLamports,
) {
  const sender = createNoopSigner(address(fields.wallet));
  // The transfer and the blockhash need nothing from each other, and a wallet is waiting.
  const [transfer, latest] = await Promise.all([
    createTransfer(rpc, sender, {
      recipient: address(fields.recipient),
      amount: fields.amountUi,
      splToken: address(fields.mint),
      reference: fields.reference,
    }).catch((e: unknown) => {
      throw friendly(e, ticker);
    }),
    rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
  ]);
  const { blockhash, lastValidBlockHeight } = latest.value;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sender.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 60_000 }),
          getSetComputeUnitPriceInstruction({ microLamports: priorityMicroLamports }),
          ...transfer,
        ],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
/** Refuse to relay anything that is not this viewer's own quote. */
export function inspectSigned(base64: string, expect: { wallet: string; reference: string }) {
  let keys: readonly string[];
  let signature:string;
  try {
    const bytes = getBase64Encoder().encode(base64);
    const tx = getTransactionDecoder().decode(bytes);
    keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
    const payer=tx.signatures[address(expect.wallet)];
    if(!payer||!nacl.sign.detached.verify(new Uint8Array(tx.messageBytes),new Uint8Array(payer),new Uint8Array(getAddressEncoder().encode(address(expect.wallet)))))throw Error('Invalid payer signature');
    signature=getBase58Decoder().decode(payer);
  } catch {
    throw fail(400, 'That is not a signed Solana transaction.');
  }
  if (keys[0] !== expect.wallet || !keys.includes(expect.reference))
    throw fail(400, 'That transaction does not belong to this quote.');
  return signature;
}
/** Broadcast a wallet-signed transaction for wallets that can sign but not send. */
export async function sendSigned(rpc: SolanaRpc, base64: string): Promise<string> {
  try {
    // A signed transaction is idempotent by its signature, so repeating the send when the
    // transport fails cannot double-spend; it can only give the network another chance to hear
    // it. A node that answers -- even to say the blockhash is stale -- is not retried.
    return await withRetry(
      () =>
        rpc
          .sendTransaction(base64 as Base64EncodedWireTransaction, {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: BigInt(3),
          })
          .send(),
      isTransportError,
    );
  } catch (e) {
    const text = errorText(e);
    if (isRequoteError(text))
      throw fail(409, 'That quote expired before it reached the network. Ask for a new one.', 'REQUOTE');
    throw fail(502, `The network rejected the transaction: ${text.slice(0, 200)}`);
  }
}

// ---- verification -------------------------------------------------------------------

export type Verdict =
  | { status: 'paid' }
  | { status: 'pending' }
  | { status: 'failed'; error: string };
export type VerifyFields = {
  recipient: string;
  amountBase: string;
  mint: string;
  reference: string;
  program: Address;
};
/**
 * One check, on the raw transaction: it succeeded, it carries our reference key, and the
 * treasury's balance for the mint rose by the quoted amount. That accepts everything strict
 * Solana Pay validation would and also transactions a wallet rewrote around our quote (guard
 * instructions appended, so the transfer is no longer last). A transaction the network has
 * not seen yet is "pending", and network trouble throws so the caller can say so too.
 */
export async function verifyPayment(
  rpc: SolanaRpc,
  sig: string,
  fields: VerifyFields,
): Promise<Verdict> {
  const signature = toSignature(sig);
  const recipient = address(fields.recipient);
  const mint = address(fields.mint);
  const tx = await withRetry(
    () =>
      rpc
        .getTransaction(signature, {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        })
        .send(),
    isTransportError,
  );
  if (!tx) return { status: 'pending' };
  const [ata] = await findAssociatedTokenPda({ owner: recipient, tokenProgram: fields.program, mint });
  const check = checkTransfer(tx, {
    recipient: fields.recipient,
    recipientAta: ata,
    mint: fields.mint,
    reference: fields.reference,
    amountBase: fields.amountBase,
  });
  if (check.ok) return { status: 'paid' };
  return check.final ? { status: 'failed', error: check.reason } : { status: 'pending' };
}
/** Recovery when the browser never told us the signature: the oldest transaction carrying the reference. */
export async function findPayment(rpc: SolanaRpc, reference: string): Promise<string | null> {
  try {
    const found = await withRetry(
      () => findReference(rpc, address(reference), { commitment: 'confirmed' }),
      isTransportError,
    );
    return found.signature;
  } catch (e) {
    if (e instanceof Error && e.name === 'FindReferenceError') return null;
    throw e;
  }
}
