import { sponsorPriceCents } from './sponsorship';
import type {
  SponsorAsset,
  SponsorCatalog,
  SponsorDraft,
  SponsorFulfillment,
  SponsorProduct,
  SponsorReceipt,
  SponsorTarget,
} from './sponsorship';

export const checkoutKey = 'pepe-chad:sponsorship:v1';
export type SavedCheckout = {
  version: 1;
  draft: SponsorDraft;
  asset: SponsorAsset;
  token: string | null;
};
export const emptyDraft: SponsorDraft = {
  product: 'message',
  name: '',
  message: '',
  style: 'intro',
  target: 'host',
};
export function readCheckout(raw: string | null): SavedCheckout {
  const fallback: SavedCheckout = {
    version: 1,
    draft: { ...emptyDraft },
    asset: 'USDC',
    token: null,
  };
  try {
    const saved = JSON.parse(raw || 'null');
    if (!saved || saved.version !== 1) return fallback;
    if (['USDC', 'SOL', 'FROGCLENCH'].includes(saved.asset))
      fallback.asset = saved.asset;
    if (
      typeof saved.token === 'string' &&
      /^[a-zA-Z0-9_-]{32,180}$/.test(saved.token)
    )
      fallback.token = saved.token;
    const d = saved.draft;
    if (d && ['message', 'spotlight', 'cap'].includes(d.product)) {
      fallback.draft.product = d.product;
      for (const key of [
        'name',
        'message',
        'projectName',
        'projectUrl',
        'assetId',
      ] as const) {
        if (typeof d[key] === 'string')
          fallback.draft[key] = d[key].slice(0, key === 'message' ? 240 : 300);
      }
      if (['intro', 'debate', 'gentle-roast'].includes(d.style))
        fallback.draft.style = d.style;
      if (d.target === 'host' || d.target === 'guest')
        fallback.draft.target = d.target;
    }
  } catch {
    /* Corrupt or blocked browser storage must never prevent checkout. */
  }
  return fallback;
}
export function receiptStage(receipt: Pick<SponsorReceipt, 'status'>) {
  switch (receipt.status) {
    case 'draft':
    case 'payment-pending':
      return 'payment';
    case 'paid':
    case 'leased':
      return 'queued';
    case 'prepared':
      return 'preparing';
    case 'playing':
      return 'on-air';
    case 'paused':
      return 'paused';
    case 'fulfilled':
      return 'delivered';
  }
}
export function deliveryProgress(
  f: Pick<
    SponsorFulfillment,
    'visibleMs' | 'appearances' | 'intro' | 'callback'
  >,
) {
  const duration = Math.min(100, Math.floor(f.visibleMs / 6000));
  return f.intro && f.callback && f.appearances >= 6
    ? duration
    : Math.min(99, duration);
}
/**
 * What a placement costs is the server's answer, not the browser's. The catalog already
 * carries it, and a deployment may price differently from the built-in ladder, so a page
 * that did its own arithmetic would quote one number and charge another. The ladder is
 * only the fallback for the moment before the first catalog arrives.
 */
export function catalogPriceCents(
  catalog: SponsorCatalog | null,
  product: SponsorProduct,
  asset: SponsorAsset,
): number {
  const listed = catalog?.products.find((p) => p.id === product);
  if (!listed) return sponsorPriceCents(product, asset);
  return asset === 'FROGCLENCH' ? listed.frogPriceCents : listed.priceCents;
}
export const hostName = (target: SponsorTarget | undefined) =>
  target === 'guest' ? 'GigaChad' : 'Pepe';
/**
 * The line under each host in the cap chooser. Nothing about a host is ever reserved or
 * disabled: caps for one host go on one at a time, so the only thing a buyer needs to know
 * is how many paid caps go on before theirs.
 */
export function capQueueLabel(ahead: number | undefined): string {
  if (ahead === undefined) return 'Checking the line…';
  if (ahead === 0) return 'Available now';
  if (ahead === 1) return '1 ahead · yours starts after it';
  return `${ahead} ahead · yours starts after them`;
}
/** The receipt's one honest line while a paid cap waits behind earlier caps on its host. */
export function capAheadCopy(
  ahead: number,
  target: SponsorTarget | undefined,
): string {
  const host = hostName(target);
  return ahead === 1
    ? `Another cap is ahead of yours on ${host}. Yours starts the moment it finishes.`
    : `${ahead} caps are ahead of yours on ${host}. Yours starts the moment they finish.`;
}
export const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);
export const productCopy = {
  message: {
    title: 'Get on air',
    short: 'Your message. Their take.',
    description:
      'A question, an idea, or a little trench therapy. The hosts read it out on air and answer it.',
    icon: 'message',
  },
  spotlight: {
    title: 'Project spotlight',
    short: 'Put your project in the conversation.',
    description:
      'Four turns of sponsored banter, with your project named on screen for the whole exchange.',
    icon: 'spotlight',
  },
  cap: {
    title: 'Dress the hosts',
    short: 'Your brand. Their very big heads.',
    description:
      'A branded cap on Pepe or Chad for 10 live minutes. Six clear appearances, an introduction, and a callback.',
    icon: 'cap',
  },
} as const;
