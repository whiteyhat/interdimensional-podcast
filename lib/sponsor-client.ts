import type {
  SponsorAsset,
  SponsorDraft,
  SponsorFulfillment,
  SponsorReceipt,
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
    case 'refund-pending':
    case 'refunded':
      return 'refund';
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
      'A question, an idea, or a little trench therapy. The hosts thank you by name and respond.',
    icon: 'message',
  },
  spotlight: {
    title: 'Project spotlight',
    short: 'Put your project in the conversation.',
    description:
      'Four turns of sponsored banter, your project on screen, and a link the room can follow.',
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
