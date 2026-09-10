// The broadcast gate: a transaction is forwarded to the network only if it pays this show.
//
// sendTransaction has to stay on the proxy's allowlist -- the viewer's wallet broadcasts its
// own payment through /api/rpc -- but an open sendTransaction makes the domain a free public
// Solana relay, which is exactly what spam and MEV bots go looking for.
//
// Every transaction the site asks a wallet to sign carries a reference: a random 32-byte
// address minted by randomReference() and attached as a read-only account, on the $5 seat and
// on sponsorship payments alike. But a reference alone is not proof. Quotes are self-serve, so
// a stranger can take one, keep the reference, and staple it as a dummy read-only account onto
// any transaction they want relayed for as long as the quote stays open. So the gate reads the
// transaction's instructions and requires the thing the quote was for: a transfer of the quoted
// asset into the quoted treasury, signed by the quoted wallet. The only transaction that passes
// is one that pays us.
import {
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { rpcProxyLimits } from './rpcproxy';
/** More keys than any payment carries; a relay's lookup tables stop here. */
const maxKeys = 64;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** SPL Token instruction discriminators; identical in Token and Token-2022. */
const SPL_TRANSFER = 3;
const SPL_TRANSFER_CHECKED = 12;
/** System Program `Transfer`, a little-endian u32 instruction index. */
const SYSTEM_TRANSFER = 2;
export type Decoded = {
  /** Static account keys in message order; the fee payer is first. */
  keys: string[];
  instructions: { program: string; accounts: string[]; data: Uint8Array }[];
};
/**
 * The accounts and instructions of a wire transaction, or null if it will not decode. base64
 * when the wallet says so (web3.js v1 and the site's own submit path), base58 otherwise, which
 * is what JSON-RPC sendTransaction defaults to. Accounts reached through an address lookup
 * table are not resolved: the site never compiles its payments that way, so a transaction that
 * hides the treasury behind one is refused, which is the safe direction.
 */
export function decodeWire(params: unknown): Decoded | null {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return null;
  const wire = params[0];
  if (wire.length > 4_000) return null;
  const opts = params[1];
  const base64 =
    !!opts && typeof opts === 'object' && (opts as { encoding?: unknown }).encoding === 'base64';
  try {
    const bytes = base64 ? getBase64Encoder().encode(wire) : getBase58Encoder().encode(wire);
    const tx = getTransactionDecoder().decode(bytes);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    // The v1 message format carries its instructions differently and nothing the site issues
    // uses it; refusing it is the safe direction, like the lookup tables above.
    if (!('instructions' in message)) return null;
    const keys = message.staticAccounts.slice(0, maxKeys).map(String);
    const instructions = message.instructions.map((ix) => ({
      program: keys[ix.programAddressIndex] ?? '',
      accounts: (ix.accountIndices ?? []).map((i) => keys[i] ?? ''),
      data: ix.data ? new Uint8Array(ix.data) : new Uint8Array(),
    }));
    return { keys, instructions };
  } catch {
    return null;
  }
}
/** The static account keys alone, for callers that only need to know who is named. */
export const staticKeysOf = (params: unknown) => decodeWire(params)?.keys ?? null;
export type OpenQuote = {
  kind: 'seat' | 'sponsor';
  reference: string;
  /** The wallet the quote was issued to, when the quote knows it; null means any signer. */
  payer: string | null;
  recipient: string;
  /** The SPL mint being paid, or null for a payment in SOL. */
  mint: string | null;
};
/**
 * The open quote one of these keys refers to, or null. Two tables, because two things are
 * sold: the $5 seat (requests) and sponsorships (sponsor_payment_attempts). Both keep the
 * reference unique, both mark a quote 'submitted' when a wallet says it sent, and both get a
 * few minutes of grace past expiry because the submit action does too.
 *
 * The sponsorship table belongs to another module's schema and may not exist yet on a fresh
 * local database, so its lookup failing is treated as "no sponsorship matched" rather than as
 * an outage. The requests lookup failing is an outage, and the caller must refuse the send.
 */
export async function openQuoteFor(
  db: D1Database,
  keys: string[],
  now: number,
): Promise<OpenQuote | null> {
  if (!keys.length) return null;
  const marks = keys.map(() => '?').join(',');
  const since = now - rpcProxyLimits.sendGraceMs;
  const seat = db
    .prepare(
      `SELECT reference, wallet, recipient, mint FROM requests WHERE reference IN (${marks}) AND status IN ('quoted','submitted') AND expires_at > ? LIMIT 1`,
    )
    .bind(...keys, since)
    .first<{ reference: string; wallet: string; recipient: string; mint: string }>();
  const sponsor = db
    .prepare(
      `SELECT reference, wallet_hint, recipient, mint FROM sponsor_payment_attempts WHERE reference IN (${marks}) AND status IN ('issued','submitted') AND expires_at > ? LIMIT 1`,
    )
    .bind(...keys, since)
    .first<{ reference: string; wallet_hint: string | null; recipient: string; mint: string | null }>()
    .catch(() => null);
  const [a, b] = await Promise.all([seat, sponsor]);
  if (a) return { kind: 'seat', reference: a.reference, payer: a.wallet, recipient: a.recipient, mint: a.mint };
  if (b)
    return { kind: 'sponsor', reference: b.reference, payer: b.wallet_hint, recipient: b.recipient, mint: b.mint };
  return null;
}
/**
 * Where a payment of `mint` to `recipient` lands: its associated token account, under either
 * token program. Both are derived, so the gate never has to ask the network which one the
 * mint uses. Pure; a PDA is a hash.
 */
export async function treasuryAccountsFor(recipient: string, mint: string): Promise<string[]> {
  const owner = recipient as Parameters<typeof findAssociatedTokenPda>[0]['owner'];
  const m = mint as Parameters<typeof findAssociatedTokenPda>[0]['mint'];
  const [[a], [b]] = await Promise.all([
    findAssociatedTokenPda({ owner, mint: m, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    findAssociatedTokenPda({ owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
  ]);
  return [String(a), String(b)];
}
/**
 * Does this transaction pay this quote? Three things, all of them: it names the reference, it
 * is signed by the wallet the quote was issued to (when the quote knows one), and one of its
 * instructions is a transfer of the quoted asset into the quoted treasury. The amount is not
 * checked here -- that happens on the confirmed transaction, where balances are real -- because
 * the gate's question is narrower: is this a payment to us at all, or a stranger's transaction
 * wearing our reference?
 */
export function paysQuote(decoded: Decoded, quote: OpenQuote, treasuryAccounts: string[]): boolean {
  const { keys, instructions } = decoded;
  if (!keys.includes(quote.reference)) return false;
  if (quote.payer && keys[0] !== quote.payer) return false;
  return instructions.some((ix) => {
    if (quote.mint) {
      if (ix.program !== TOKEN_PROGRAM_ADDRESS && ix.program !== TOKEN_2022_PROGRAM_ADDRESS) return false;
      const op = ix.data[0];
      if (op !== SPL_TRANSFER && op !== SPL_TRANSFER_CHECKED) return false;
      return ix.accounts.some((a) => treasuryAccounts.includes(a));
    }
    if (ix.program !== SYSTEM_PROGRAM || ix.data.length < 4) return false;
    const op = ix.data[0] | (ix.data[1] << 8) | (ix.data[2] << 16) | (ix.data[3] << 24);
    return op === SYSTEM_TRANSFER && ix.accounts.includes(quote.recipient);
  });
}
