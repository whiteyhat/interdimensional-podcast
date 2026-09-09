// Paid audience requests. Pure: no DOM, no network, no clock reads.
// The site, the interact route and the studio engine all agree on these shapes.
export type RequestStatus = 'queued' | 'writing' | 'buffered' | 'on-air' | 'aired';
export type PaidRequest = {
  id: string;
  /** Solana Pay reference key; unique per payment. */
  reference: string;
  /** Name the hosts say on air (viewer-chosen, or a friendly fallback). */
  from: string;
  wallet: string;
  text: string;
  /** Tokens paid, in UI units. */
  amount: number;
  status: RequestStatus;
  shot?: number;
  at: number;
};
export const requestConfig = {
  limits: { text: 240, name: 20, keep: 30 },
  minWords: 1,
  /** Reference the payer picked nothing: the hosts still have someone to thank. */
  anonymous: 'an anonymous viewer',
} as const;

export function shortWallet(address: string) {
  const value = address.trim();
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

const URLISH = /https?:\/\/|www\.|\.(com|io|xyz|fun|app|net|org)\b/i;
const EVM_ADDRESS = /0x[a-f0-9]{40}/i;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
// Anything below a space, or DEL, has no place in a spoken line.
const hasControl = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};
// A paid message becomes spoken dialogue, so the worst words are refused before payment.
const SLURS =
  /\b(n[i1]gg(a|er)s?|f[a4]gg?[o0]ts?|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|tr[a4]nn(y|ies)|r[e3]t[a4]rds?|w[e3]tb[a4]cks?)\b/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,19}$/;

export type MessageCheck = { ok: true; text: string } | { ok: false; error: string };
/** The one validator for a paid message, shared by the card (instant feedback) and the server. */
export function checkMessage(raw: unknown): MessageCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Write a message first.' };
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 3) return { ok: false, error: 'Say a little more than that.' };
  if (text.length > requestConfig.limits.text)
    return { ok: false, error: `Keep it under ${requestConfig.limits.text} characters.` };
  if (hasControl(text)) return { ok: false, error: 'Plain text only.' };
  if (URLISH.test(text)) return { ok: false, error: 'No links; the hosts cannot read them out.' };
  if (EVM_ADDRESS.test(text) || SOLANA_ADDRESS.test(text))
    return { ok: false, error: 'No wallet or contract addresses.' };
  if (SLURS.test(text)) return { ok: false, error: 'That will not be read on air.' };
  return { ok: true, text };
}
/** A display name the hosts can say aloud; empty is allowed and means anonymous. */
export function checkName(raw: unknown): MessageCheck {
  if (raw === undefined || raw === null || raw === '') return { ok: true, text: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'Use letters and numbers for your name.' };
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, requestConfig.limits.name);
  if (!name) return { ok: true, text: '' };
  if (!NAME.test(name)) return { ok: false, error: 'Use letters and numbers for your name.' };
  if (SLURS.test(name) || URLISH.test(name)) return { ok: false, error: 'Pick another name.' };
  return { ok: true, text: name };
}
export function spokenName(name: string) {
  return name.trim() || requestConfig.anonymous;
}

/**
 * Tokens for a dollar amount, rounded UP to the mint's decimals and clamped to 15
 * significant digits, which is the most Solana Pay will encode.
 */
export function quoteAmount(priceUsd: number, usd: number, decimals: number) {
  if (!(priceUsd > 0) || !(usd > 0) || !Number.isInteger(decimals) || decimals < 0)
    throw Error('Cannot price the request');
  const raw = usd / priceUsd;
  const digits = Math.max(1, Math.floor(Math.log10(raw)) + 1);
  const places = Math.max(0, Math.min(decimals, 15 - digits));
  const factor = 10 ** places;
  const amount = Math.ceil(raw * factor - 1e-9) / factor;
  if (!Number.isFinite(amount) || amount <= 0) throw Error('Cannot price the request');
  return amount;
}
/** Base units as a decimal string, for storage and exact comparison. */
export function toBaseUnits(amount: number, decimals: number) {
  const [whole, frac = ''] = amount.toFixed(decimals).split('.');
  return `${whole}${frac}`.replace(/^0+(?=\d)/, '');
}

export function nextQueued(list: PaidRequest[]) {
  return list.find((r) => r.status === 'queued');
}
/** FIFO append; a request already known by reference is never added twice. */
export function mergeIncoming(list: PaidRequest[], incoming: PaidRequest[]): PaidRequest[] {
  const known = new Set(list.map((r) => r.reference));
  const added = incoming.filter((r) => {
    if (known.has(r.reference)) return false;
    known.add(r.reference);
    return true;
  });
  if (!added.length) return list;
  return trimRequests([...list, ...added.map((r) => ({ ...r, status: 'queued' as const }))]);
}
export function markRequest(
  list: PaidRequest[],
  id: string,
  status: RequestStatus,
  shot?: number,
): PaidRequest[] {
  return list.map((r) =>
    r.id === id ? { ...r, status, ...(shot === undefined ? {} : { shot }) } : r,
  );
}
/** Keep the pending ones and the most recent finished ones for the producer log. */
export function trimRequests(list: PaidRequest[]): PaidRequest[] {
  if (list.length <= requestConfig.limits.keep) return list;
  const done = list.filter((r) => r.status === 'aired');
  const drop = new Set(done.slice(0, Math.max(0, list.length - requestConfig.limits.keep)));
  return list.filter((r) => !drop.has(r));
}
/** Parse whatever the interact route returned into a request, or nothing. */
export function readRequest(raw: unknown): PaidRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = checkMessage(r.text);
  const reference = typeof r.reference === 'string' ? r.reference.trim() : '';
  if (!text.ok || !reference) return null;
  const name = checkName(r.from);
  const amount = Number(r.amount);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : reference,
    reference,
    from: spokenName(name.ok ? name.text : ''),
    wallet: typeof r.wallet === 'string' ? r.wallet : '',
    text: text.text,
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    status: 'queued',
    at: Number.isFinite(Number(r.at)) ? Number(r.at) : 0,
  };
}
