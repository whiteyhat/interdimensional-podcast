import { cast } from './show';
import { sponsorOffers, sponsorPriceCents } from './sponsorship';
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
export const defaultSponsorAsset: SponsorAsset = 'FROGCLENCH';
export type SavedCheckout = {
  version: 1;
  draft: SponsorDraft;
  asset: SponsorAsset;
  token: string | null;
};
export const emptyDraft: SponsorDraft = {
  product: 'spotlight',
  name: '',
  message: '',
  style: 'intro',
  target: 'host',
};
export function readCheckout(raw: string | null): SavedCheckout {
  const fallback: SavedCheckout = {
    version: 1,
    draft: { ...emptyDraft },
    asset: defaultSponsorAsset,
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
      // A draft for a placement that came off sale keeps its words under the default offer.
      if (sponsorOffers.some((p) => p.id === d.product))
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
export function receiptStage(
  receipt: Pick<SponsorReceipt, 'status'> &
    Partial<Pick<SponsorReceipt, 'draft' | 'look'>>,
) {
  switch (receipt.status) {
    case 'draft':
    case 'payment-pending':
      return 'payment';
    case 'paid':
      // A paid cap cannot be leased until its look exists; the receipt says what it is
      // waiting for. A refused look is back in the queue with a request for a new logo.
      return receipt.draft?.product === 'cap' &&
        (!receipt.look || receipt.look.status === 'tailoring')
        ? 'tailoring'
        : 'queued';
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
  cast[target ?? 'host'].name;
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
    title: 'Dress the host',
    short: 'Your logo on the tee, a cap in your colours',
    description:
      'Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad for 10 live minutes. Six clear appearances, an introduction and a callback.',
    icon: 'cap',
  },
} as const;
/**
 * Every line the wardrobe card and the receipt say while a tee and cap are made, pinned
 * here so the panel, the preview and the receipt cannot drift apart. The look is tailored
 * after payment only, so the pre-payment caption is a promise and the rest is a clock.
 */
export const LOOK_COPY = {
  previewCaption:
    'An example look. Yours is tailored right after payment · usually one to two minutes',
  tailoring: 'Tailoring your tee and cap · usually one to two minutes',
  anotherFit: 'Still tailoring — trying another fit',
  slow: 'This is taking longer than usual',
  replace: 'Use a different logo',
  improving: "We'll keep improving the fit",
  refused: 'This logo could not be dressed.',
} as const;
/** What the wardrobe card and the receipt show for a paid cap order at one moment. */
export type LookView = {
  kind: 'tailoring' | 'ready' | 'refused';
  label: 'TAILORING' | 'YOUR ON-AIR PASS';
  /** The sentence under the card: the waiting copy, the fallback note, or the refusal. */
  line: string | null;
  /** Offer "Use a different logo". */
  replace: boolean;
  /** The look, once it is ready; the card shows the host's own still until then. */
  url: string | null;
};
/**
 * The sub-states are driven by the clock, not by the desk: the tailor usually answers in
 * one to two minutes, a second fit past two, and past ten the customer is offered a way
 * out. `replacedAt` restarts that clock after "Use a different logo", because the payment
 * time no longer says when this logo's tailoring began. Null before payment and for every
 * other product, so the card stays a preview.
 */
export function lookView(
  receipt: Pick<SponsorReceipt, 'status' | 'draft' | 'paidAt' | 'look'>,
  now: number,
  replacedAt: number | null = null,
): LookView | null {
  if (receipt.draft.product !== 'cap') return null;
  if (receipt.status === 'draft' || receipt.status === 'payment-pending')
    return null;
  const look = receipt.look;
  // The site lets a paid cap that is not on air yet take a different logo, and refuses the
  // swap once the cap is leased; the receipt offers it only while the site would accept it.
  const canReplace = receipt.status === 'paid';
  if (look?.status === 'ready' && look.url)
    return {
      kind: 'ready',
      label: 'YOUR ON-AIR PASS',
      line: look.fallback ? LOOK_COPY.improving : null,
      replace: !!look.fallback && canReplace,
      url: look.url,
    };
  if (look?.status === 'refused')
    return {
      kind: 'refused',
      label: 'TAILORING',
      line: look.reason || LOOK_COPY.refused,
      replace: canReplace,
      url: null,
    };
  // The clock starts at the payment, or at the swap for a different logo: the receipt's own
  // `since` carries that across reloads and devices, `replacedAt` covers the moment before
  // the next receipt arrives.
  const since = Math.max(
    receipt.paidAt ?? now,
    look?.since ?? 0,
    replacedAt ?? 0,
  );
  const elapsed = now - since;
  return {
    kind: 'tailoring',
    label: 'TAILORING',
    line:
      elapsed < 120_000
        ? LOOK_COPY.tailoring
        : elapsed < 600_000
          ? LOOK_COPY.anotherFit
          : LOOK_COPY.slow,
    replace: elapsed >= 600_000 && canReplace,
    url: null,
  };
}
/** The look's alt text: the host, dressed. The card names Chad the way its caption does. */
export const lookAlt = (target: SponsorTarget | undefined) =>
  `${target === 'guest' ? 'Chad' : 'Pepe'} wearing your tee and cap`;
/** The stored, normalised logo, shown as a swatch on the card until the look replaces it. */
export const logoSwatchUrl = (assetId: string | undefined) =>
  assetId
    ? `/api/sponsorship/assets/${encodeURIComponent(assetId)}?part=logo`
    : null;
/** The host's own still: what the card shows while the tailor works. */
export const baseStill = (target: SponsorTarget | undefined) =>
  target === 'guest' ? '/gigachad-video.avif' : '/pepe-video.avif';
/**
 * A finished look from a real order (Northwind's tee and cap, devnet rehearsal of
 * 2026-09-14), shown on the card before payment so a buyer sees what a dressed host is,
 * not an undressed one. Never the buyer's own look: theirs does not exist until they pay.
 */
export const exampleLook = (target: SponsorTarget | undefined) =>
  target === 'guest'
    ? '/looks/gigachad-northwind.avif'
    : '/looks/pepe-northwind.avif';
export const exampleAlt = (target: SponsorTarget | undefined) =>
  `An example: ${target === 'guest' ? 'Chad' : 'Pepe'} wearing Northwind's tee and cap`;
