// Pure helpers behind /api/interact. No DOM, network or clock reads at import: the route
// and lib/solana.ts hand these the values they already hold, and the tests run them as-is.
import { shortWallet, spokenName } from './requests';
import { defaultBrand, type CoinBrand } from './show';

/** Every state a request can be in, in lifecycle order. */
export const rowStatuses = [
  'quoted',
  'submitted',
  'paid',
  'claimed',
  'aired',
  'expired',
  'failed',
] as const;
export type RowStatus = (typeof rowStatuses)[number];
/** One row of the D1 `requests` table; every amount on it was computed by the server. */
export type RequestRow = {
  id: string;
  reference: string;
  wallet: string;
  name: string;
  message: string;
  amount_ui: number;
  amount_base: string;
  mint: string;
  recipient: string;
  price_usd: number;
  status: RowStatus;
  signature: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  claimed_at: number | null;
  aired_at: number | null;
};
/** What the site shows about a request: no full wallet, no amounts, no ids. */
export type PublicRequest = {
  reference: string;
  from: string;
  wallet: string;
  text: string;
  status: RowStatus;
  at: number;
  position?: number;
};
/** What the studio receives when it claims paid requests. */
export type PullItem = {
  id: string;
  reference: string;
  from: string;
  wallet: string;
  text: string;
  amount: number;
  at: number;
};

export const interactLimits = {
  /** A quote's blockhash lives about a minute; the card counts this down. */
  quoteTtlMs: 60_000,
  /** Quoted rows this old are marked expired the next time anyone asks for status. */
  staleQuoteMs: 180_000,
  /** Submitted rows whose transaction never landed are tidied after this long. */
  staleSubmittedMs: 30 * 60_000,
  /** The studio pulls every 8s; silence for this long means it is off air. */
  heartbeatMs: 60_000,
  quotesPerMinute: 3,
  /** Quote attempts per client address per minute, counted before any chain work. */
  quotesPerMinuteIp: 12,
  /** A claimed row the studio never reported as aired is offered to it again after this long. */
  reclaimMs: 3 * 60_000,
  /** Once a minute the studio pull re-checks recent quotes whose payment may have landed late. */
  recoverEveryMs: 60_000,
  recoverWindowMs: 15 * 60_000,
  recoverBatch: 2,
  claimBatch: 5,
  recent: 20,
  /** Cache windows inside one Worker isolate. */
  priceCacheMs: 20_000,
  treasuryCacheMs: 60_000,
} as const;

/** An error that already knows which HTTP status and code it should answer with. */
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
  }
}
export const fail = (status: number, message: string, code?: string) =>
  new HttpError(status, message, code);

export const defaultInteractUsd = 5;
/** Dollars per request from the environment, with the default when unset or nonsense. */
export function usdPerRequest(raw: string | undefined, fallback = defaultInteractUsd) {
  const usd = Number(raw);
  return Number.isFinite(usd) && usd > 0 ? usd : fallback;
}
export const buyUrlFor = (mint: string | null) => (mint ? `https://pump.fun/coin/${mint}` : null);
/** The RPC the browser broadcasts through when a deployment names no other. */
export const publicRpc = 'https://api.mainnet-beta.solana.com';
/** The show's coin, as this deployment configured it. Both routes read it through here. */
export function readBrand(env: {
  COIN_NAME?: string;
  COIN_TICKER?: string;
  INTERACT_USD?: string;
}): CoinBrand {
  return {
    name: env.COIN_NAME?.trim() || defaultBrand.name,
    ticker: env.COIN_TICKER?.trim().replace(/^\$/, '') || defaultBrand.ticker,
    usd: usdPerRequest(env.INTERACT_USD, defaultBrand.usd),
  };
}

/** Everything GET /api/interact?action=config tells the page. Never secrets. */
export type PublicConfig = {
  launched: boolean;
  mint: string | null;
  ticker: string;
  name: string;
  treasury: string | null;
  buyUrl: string | null;
  /** Tokens a seat costs right now, priced by the server so the card never does the maths. */
  previewAmountUi: number | null;
  interactUsd: number;
  streamEmbedUrl: string | null;
  links: { pumpfun: string | null; x: string | null };
  studioOnline: boolean;
  treasuryReady: boolean;
  clientRpcUrl: string;
  queued: number;
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Coerce the config the route sent into one the cards can trust. */
export function readConfig(raw: unknown): PublicConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const links = (r.links && typeof r.links === 'object' ? r.links : {}) as Record<string, unknown>;
  return {
    launched: r.launched === true,
    mint: str(r.mint),
    ticker: (str(r.ticker) ?? defaultBrand.ticker).replace(/^\$/, '').toUpperCase(),
    name: str(r.name) ?? defaultBrand.name,
    treasury: str(r.treasury),
    buyUrl: str(r.buyUrl),
    previewAmountUi: num(r.previewAmountUi),
    interactUsd: num(r.interactUsd) ?? defaultBrand.usd,
    streamEmbedUrl: str(r.streamEmbedUrl),
    links: { pumpfun: str(links.pumpfun), x: str(links.x) },
    studioOnline: r.studioOnline === true,
    treasuryReady: r.treasuryReady === true,
    clientRpcUrl: str(r.clientRpcUrl) ?? publicRpc,
    queued: num(r.queued) ?? 0,
  };
}
const statuses = new Set<string>(rowStatuses);
/** Coerce one row of the status feed; unknown shapes are dropped rather than guessed at. */
export function readPublicRequest(raw: unknown): PublicRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const reference = str(r.reference);
  const status = typeof r.status === 'string' && statuses.has(r.status) ? (r.status as RowStatus) : null;
  if (!reference || !status) return null;
  const position = num(r.position);
  return {
    reference,
    from: spokenName(typeof r.from === 'string' ? r.from : ''),
    wallet: typeof r.wallet === 'string' ? r.wallet : '',
    text: typeof r.text === 'string' ? r.text : '',
    status,
    at: num(r.at) ?? 0,
    ...(position && position > 0 ? { position } : {}),
  };
}

/** 1-based place of every unaired request; `rows` arrive already in service order. */
export function queuePositions(rows: readonly Pick<RequestRow, 'reference'>[]) {
  const positions = new Map<string, number>();
  rows.forEach((row, i) => positions.set(row.reference, i + 1));
  return positions;
}
export function publicView(row: RequestRow, positions?: Map<string, number>): PublicRequest {
  const position = positions?.get(row.reference);
  return {
    reference: row.reference,
    from: spokenName(row.name),
    wallet: shortWallet(row.wallet),
    text: row.message,
    status: row.status,
    at: row.paid_at ?? row.created_at,
    ...(position && (row.status === 'paid' || row.status === 'claimed') ? { position } : {}),
  };
}
export function pullView(row: RequestRow): PullItem {
  return {
    id: row.id,
    reference: row.reference,
    from: row.name,
    wallet: row.wallet,
    text: row.message,
    amount: row.amount_ui,
    at: row.paid_at ?? row.created_at,
  };
}

/** Constant-time string comparison for the studio token; only the length can leak. */
export function sameToken(given: string, expected: string) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0 && b.length > 0;
}
/** Where a token-less studio pull is still acceptable: the developer's own machine. */
export function isLocalHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

// ---- price feeds --------------------------------------------------------------------

/** Jupiter lite-api price/v3: `{ [mint]: { usdPrice, decimals, priceChange24h } }`. */
export function readJupiterPrice(json: unknown, mint: string): number | null {
  if (!json || typeof json !== 'object') return null;
  const entry = (json as Record<string, unknown>)[mint];
  if (!entry || typeof entry !== 'object') return null;
  const price = Number((entry as { usdPrice?: unknown }).usdPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}
/** pump.fun coins-v2: market cap over circulating supply, in the mint's own decimals. */
export function readPumpPrice(json: unknown, decimals: number): number | null {
  if (!json || typeof json !== 'object') return null;
  const coin = json as { usd_market_cap?: unknown; total_supply?: unknown };
  const mcap = Number(coin.usd_market_cap);
  const supply = Number(coin.total_supply) / 10 ** decimals;
  if (!Number.isFinite(mcap) || !Number.isFinite(supply) || mcap <= 0 || supply <= 0) return null;
  return mcap / supply;
}
/** PRICE_FIXED (devnet only) is tokens per dollar; the show prices in dollars per token. */
export function fixedPrice(raw: string | undefined): number | null {
  const perDollar = Number(raw);
  return Number.isFinite(perDollar) && perDollar > 0 ? 1 / perDollar : null;
}

// ---- payment errors -----------------------------------------------------------------

export type FriendlyError = { status: number; error: string; code?: string };
const PAY_ERRORS: readonly [RegExp, number, (ticker: string) => string, string?][] = [
  [
    /recipient not initialized|recipient frozen/i,
    409,
    (t) => `The show's treasury cannot receive ${t} yet. Try again in a minute.`,
    'TREASURY',
  ],
  [/sender not initialized/i, 400, (t) => `This wallet does not hold any ${t} yet.`],
  [/insufficient funds/i, 400, (t) => `Not enough ${t} in this wallet for one request.`],
  [/sender frozen/i, 400, (t) => `This wallet's ${t} account is frozen.`],
  [
    /mint account not found|mint not initialized/i,
    503,
    (t) => `${t} could not be found on this network.`,
    'MINT',
  ],
  [
    /amount decimals invalid|floating-point precision|Invalid amount/i,
    503,
    () => 'Could not price the request; try again in a moment.',
    'PRICE',
  ],
];
/** Map a Solana Pay / RPC error message to something a viewer can act on. */
export function friendlyPayError(message: string, ticker: string): FriendlyError | null {
  for (const [pattern, status, text, code] of PAY_ERRORS)
    if (pattern.test(message)) return { status, error: text(ticker), ...(code ? { code } : {}) };
  return null;
}
/** The network no longer accepts the quote's blockhash: the card must ask for a new one. */
export function isRequoteError(message: string) {
  return /blockhash not found|block height exceeded|blockhash.*expired|transaction expired/i.test(
    message,
  );
}

// ---- on-chain check ---------------------------------------------------------------

type TokenBalanceJson = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};
/** The parts of a `getTransaction(..., { encoding: 'json' })` answer the check reads. */
export type TransactionJson = {
  meta: {
    err: unknown;
    preTokenBalances?: readonly TokenBalanceJson[];
    postTokenBalances?: readonly TokenBalanceJson[];
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] };
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};
export type TransferCheck = { ok: true } | { ok: false; reason: string; final: boolean };
/**
 * Loose verification for transactions a wallet rewrote around our quote (guard
 * instructions appended, so the transfer is not last): the transaction succeeded, our
 * reference key is on it, and the treasury's balance for the mint rose by the quoted
 * amount. `final: false` means "ask again later", not "rejected".
 */
export function checkTransfer(
  tx: TransactionJson,
  fields: {
    recipient: string;
    recipientAta?: string;
    mint: string;
    reference: string;
    amountBase: string;
  },
): TransferCheck {
  const meta = tx.meta;
  if (!meta) return { ok: false, reason: 'transaction has no metadata yet', final: false };
  if (meta.err) return { ok: false, reason: 'the transaction failed on chain', final: true };
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  if (!keys.includes(fields.reference))
    return { ok: false, reason: 'the transaction does not carry this request', final: true };
  const ataIndex = fields.recipientAta ? keys.indexOf(fields.recipientAta) : -1;
  const mine = (b: TokenBalanceJson) =>
    b.mint === fields.mint &&
    (b.owner ? b.owner === fields.recipient : b.accountIndex === ataIndex && ataIndex >= 0);
  const sum = (list: readonly TokenBalanceJson[] | undefined) =>
    (list ?? []).filter(mine).reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), BigInt(0));
  const delta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
  let expected: bigint;
  try {
    expected = BigInt(fields.amountBase);
  } catch {
    return { ok: false, reason: 'the stored amount is unreadable', final: true };
  }
  if (delta < expected)
    return { ok: false, reason: 'the treasury did not receive the quoted amount', final: true };
  return { ok: true };
}
