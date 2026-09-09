// Shared sponsorship contract. Monetary amounts cross the network as integer decimal strings.
import { checkMessage, checkName } from './requests';
export type SponsorProduct = 'message' | 'spotlight' | 'cap';
export type SponsorAsset = 'FROGCLENCH' | 'USDC' | 'SOL';
export type SponsorStyle = 'intro' | 'debate' | 'gentle-roast';
export type SponsorTarget = 'host' | 'guest';
export type SponsorDraft = {
  product: SponsorProduct;
  name: string;
  message: string;
  projectName?: string;
  projectUrl?: string;
  style?: SponsorStyle;
  target?: SponsorTarget;
  assetId?: string;
};
export type SponsorStatus =
  | 'draft'
  | 'payment-pending'
  | 'paid'
  | 'leased'
  | 'prepared'
  | 'playing'
  | 'paused'
  | 'fulfilled'
  | 'refund-pending'
  | 'refunded';
export type SponsorFulfillment = {
  visibleMs: number;
  appearances: number;
  intro: boolean;
  callback: boolean;
  startedAt: number | null;
  completedAt: number | null;
};
export type SponsorAttempt = {
  id: string;
  productVersion: string;
  asset: SponsorAsset;
  amountBase: string;
  amountUi: string;
  decimals: number;
  priceCents: number;
  priceUsd: string;
  reference: string;
  recipient: string;
  mint: string | null;
  issuedAt: number;
  expiresAt: number;
  lastValidBlockHeight: number | null;
  status: 'issued' | 'submitted' | 'expired' | 'verified';
  broadcastSignature: string | null;
  verifiedSignature: string | null;
  solanaPayUrl: string;
};
export type SponsorRefund = {
  id: string;
  asset: SponsorAsset;
  amountBase: string;
  status: 'queued' | 'signed' | 'submitted' | 'confirmed' | 'blocked';
  signature: string | null;
  error: string | null;
};
export type SponsorReceipt = {
  id: string;
  token: string;
  status: SponsorStatus;
  draft: SponsorDraft;
  priceCents: number;
  attempts: SponsorAttempt[];
  fulfillment: SponsorFulfillment;
  refund: SponsorRefund | null;
  refunds: SponsorRefund[];
  paidAt: number | null;
  payer: string | null;
  canRefund: boolean;
  canReschedule: boolean;
  assetUrl: string | null;
  queuePosition?: number | null;
};
export type SponsorLease = {
  id: string;
  draft: SponsorDraft;
  leaseToken: string;
  leaseUntil: number;
  fulfillment: SponsorFulfillment;
  assetUrl: string | null;
  assetMetadata: Record<string, unknown> | null;
};
export type SponsorCapabilities = {
  message: boolean;
  spotlight: boolean;
  cap: boolean;
  capTemplateVersion?: string;
};
export type SponsorCatalog = {
  products: {
    id: SponsorProduct;
    title: string;
    priceCents: number;
    frogPriceCents: number;
    available: boolean;
    reason: string | null;
  }[];
  assets: {
    id: SponsorAsset;
    mint: string | null;
    decimals: number;
    available: boolean;
    reason: string | null;
    priceUsd: string | null;
  }[];
  studioOnline: boolean;
  capInventory?: { host: boolean; guest: boolean };
  capabilities: SponsorCapabilities;
  treasury: string | null;
  clientRpcUrl: string;
  now: number;
};
export const sponsorProducts = [
  { id: 'message', title: 'Read a message', priceCents: 500 },
  { id: 'spotlight', title: 'Project spotlight', priceCents: 2500 },
  { id: 'cap', title: 'Sponsor a cap', priceCents: 10000 },
] as const;
export const sponsorLimits = {
  quoteMs: 60000,
  heartbeatMs: 30000,
  leaseMs: 45000,
  capVisibleMs: 600000,
  capAppearances: 6,
  priceAgeMs: 90000,
} as const;
export class SponsorError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'SPONSOR',
  ) {
    super(message);
  }
}
export function sponsorPriceCents(
  product: SponsorProduct,
  asset: SponsorAsset,
): number {
  const price = sponsorProducts.find((p) => p.id === product)?.priceCents;
  if (!price) throw new SponsorError(400, 'Unknown product.');
  return asset === 'FROGCLENCH' ? (price * 70) / 100 : price;
}
function decimalFraction(raw: string): [bigint, bigint] {
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw))
    throw new SponsorError(503, 'Invalid asset price.', 'PRICE');
  const [mantissa, exponent = '0'] = raw.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const shift = Number(exponent) - fraction.length;
  if (Math.abs(shift) > 60)
    throw new SponsorError(503, 'Invalid asset price.', 'PRICE');
  const n = BigInt(whole + fraction);
  return shift >= 0
    ? [n * BigInt(10) ** BigInt(shift), BigInt(1)]
    : [n, BigInt(10) ** BigInt(-shift)];
}
export function amountBaseForCents(
  cents: number,
  price: string,
  decimals: number,
): string {
  if (
    !Number.isSafeInteger(cents) ||
    cents <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  )
    throw new SponsorError(503, 'Invalid quote.');
  const [n, d] = decimalFraction(price);
  if (n <= BigInt(0))
    throw new SponsorError(503, 'Invalid asset price.', 'PRICE');
  const numerator = BigInt(cents) * d * BigInt(10) ** BigInt(decimals),
    denominator = BigInt(100) * n;
  const amount = (numerator + denominator - BigInt(1)) / denominator;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SponsorError(
      503,
      'Asset price is outside the supported range.',
      'PRICE',
    );
  return amount.toString();
}
export function amountUi(base: string, decimals: number): string {
  const value = base.padStart(decimals + 1, '0');
  return decimals
    ? `${value.slice(0, -decimals)}.${value.slice(-decimals)}`.replace(
        /\.?0+$/,
        '',
      )
    : value;
}
export function freshJupiterPrice(
  value: unknown,
  blockTime: number | null,
  now: number,
): string {
  const p = value as { usdPrice?: unknown; blockId?: unknown };
  if (
    !p ||
    typeof p.usdPrice !== 'number' ||
    !Number.isFinite(p.usdPrice) ||
    p.usdPrice <= 0 ||
    typeof p.blockId !== 'number' ||
    !Number.isSafeInteger(p.blockId) ||
    !blockTime ||
    now - blockTime * 1000 > sponsorLimits.priceAgeMs ||
    blockTime * 1000 > now + 15000
  )
    throw new SponsorError(503, 'A fresh asset price is unavailable.', 'PRICE');
  return String(p.usdPrice);
}
export function validateSponsorDraft(raw: unknown): SponsorDraft {
  if (!raw || typeof raw !== 'object')
    throw new SponsorError(400, 'Choose a sponsorship.');
  const d = raw as Record<string, unknown>;
  if (!sponsorProducts.some((p) => p.id === d.product))
    throw new SponsorError(400, 'Choose a sponsorship.');
  const name = checkName(d.name),
    message = checkMessage(d.message);
  if (!name.ok) throw new SponsorError(400, name.error);
  if (!message.ok) throw new SponsorError(400, message.error);
  if (
    /(?:ignore|override|disregard).{0,40}(?:instructions|prompt)|system prompt|developer message/i.test(
      message.text,
    )
  )
    throw new SponsorError(
      400,
      'Messages cannot contain instructions to the hosts.',
    );
  const result: SponsorDraft = {
    product: d.product as SponsorProduct,
    name: name.text,
    message: message.text,
  };
  if (d.projectName !== undefined) {
    const project = checkName(d.projectName);
    if (!project.ok || !project.text)
      throw new SponsorError(400, 'Use a short project name.');
    result.projectName = project.text;
  }
  if (d.projectUrl) {
    try {
      if (typeof d.projectUrl !== 'string') throw Error();
      const url = new URL(d.projectUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.href.length > 300
      )
        throw Error();
      result.projectUrl = url.href;
    } catch {
      throw new SponsorError(400, 'Enter a valid project URL.');
    }
  }
  if ((d.product === 'spotlight' || d.product === 'cap') && !result.projectName)
    throw new SponsorError(400, 'Enter a project name.');
  if (d.product === 'spotlight') {
    if (!['intro', 'debate', 'gentle-roast'].includes(String(d.style)))
      throw new SponsorError(400, 'Choose a spotlight style.');
    result.style = d.style as SponsorStyle;
  }
  if (d.product === 'cap') {
    if (d.target !== 'host' && d.target !== 'guest')
      throw new SponsorError(400, 'Choose a host for the cap.');
    result.target = d.target;
    if (typeof d.assetId !== 'string' || !d.assetId)
      throw new SponsorError(400, 'Upload and qualify a cap asset first.');
  }
  if (d.assetId !== undefined) {
    if (
      typeof d.assetId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(d.assetId)
    )
      throw new SponsorError(400, 'Invalid artwork asset.');
    result.assetId = d.assetId;
  }
  return result;
}
export function fulfillmentComplete(
  product: SponsorProduct,
  f: Pick<
    SponsorFulfillment,
    'visibleMs' | 'appearances' | 'intro' | 'callback'
  >,
): boolean {
  return product === 'cap'
    ? f.visibleMs >= sponsorLimits.capVisibleMs &&
        f.appearances >= sponsorLimits.capAppearances &&
        f.intro &&
        f.callback
    : f.intro;
}
