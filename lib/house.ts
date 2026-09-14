// The show plugs itself: where the coin lives and where the show lives, said in character on a
// clock, and shown in the lower-third now and then. Nothing here advertises a purchase the
// site is not selling right now: the sale half comes from the site's own catalog and fails
// closed to "nothing on sale".
import { spokenTicker, type CoinBrand, type Line } from './show';

export const houseConfig = {
  /** Aired seconds before the first plug, and between plugs. */
  firstAfterSeconds: 90,
  everySeconds: 240,
  /** The lower-third house slot: shown this long, this often. */
  ticker: { everyMs: 90000, showMs: 12000 },
} as const;
/** Where the show lives, as the picture prints it. */
export const siteHostDefault = 'frogclench.fun';
export type Sale = { message: boolean; spotlight: boolean; cap: boolean };
export const noSale: Sale = { message: false, spotlight: false, cap: false };
/** What the engine asks for: the coin half only when the coin is launched. */
export type HouseCue = { coinLive: boolean };

/** The site's catalog says what can be bought right now; anything malformed sells nothing. */
export function saleFromCatalog(raw: unknown): Sale {
  const products = (raw as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) return noSale;
  const available = (id: string) =>
    products.some((p) => (p as { id?: unknown; available?: unknown })?.id === id && (p as { available?: unknown }).available === true);
  return { message: available('message'), spotlight: available('spotlight'), cap: available('cap') };
}
/** "frogclench.fun" as the hosts say it: a place name, never a link read aloud. */
export const spokenHost = (host: string) => host.replace(/^www\./, '').replace(/\./g, ' dot ');

/** The paragraph a house batch adds to the writer's brief. */
export function houseRequest(brand: CoinBrand, siteHost: string, sale: Sale, coinLive: boolean): string {
  const spoken = spokenTicker(brand.ticker);
  const site = spokenHost(siteHost);
  const offers = [
    sale.spotlight ? 'put their own project on the show' : '',
    sale.cap ? 'sponsor the podcast and have a host wear their cap' : '',
    sale.message ? 'pay to have a message read on air' : '',
  ].filter(Boolean);
  return [
    'HOUSE MESSAGE, this exchange only: the show plugs itself, folded into the current subject, in passing and in character, never as an announcement and never in the first turn.',
    coinLive
      ? `Pepe, in one of his turns, mentions that the show's own coin, ${spoken}, is live on pump dot fun right now (say "pump dot fun" exactly like that, as a place name, once), and in the same breath undercuts it with a fresh not-financial-advice joke as THE SHOW'S OWN COIN rules require.`
      : '',
    `GigaChad, in one of his turns, says flatly that the show lives at ${site} (say it exactly like that, as a place name, once)${offers.length ? `, where anyone can ${offers.join(', or ')}` : ''}.`,
    offers.length
      ? 'Name only those offers, without prices.'
      : 'Do not mention sponsorships, paid messages, buying airtime, or anything for sale: nothing is on sale right now.',
    'Never read a contract address, a wallet, or any other link.',
  ]
    .filter(Boolean)
    .join(' ');
}
const venue = (host: string) => new RegExp(`\\b${spokenHost(host).replace(/\s+/g, '\\s*').replace(/dot/g, '(?:dot|\\.)')}\\b`, 'i');
const PUMP = /\bpump\s*(?:dot|\.)?\s*fun\b/i;
const SALES = /\b(sponsor|sponsorship|paid message|buy(ing)? airtime|send a request|a message read)\b/i;
/** What is wrong with a house exchange the writer returned; empty when it did the job. */
export function houseSaid(lines: Line[], brand: CoinBrand, siteHost: string, sale: Sale, coinLive: boolean): string[] {
  const problems: string[] = [];
  const said = (speaker: Line['speaker'], re: RegExp) => lines.filter((l) => l.speaker === speaker && re.test(l.text)).length;
  if (coinLive) {
    const pepe = said('host', PUMP);
    if (pepe !== 1) problems.push(`Pepe says pump dot fun ${pepe} times, not once`);
    if (!lines.some((l) => l.speaker === 'host' && new RegExp(spokenTicker(brand.ticker).split(/\s+/).join('\\s*'), 'i').test(l.text)))
      problems.push('Pepe never names the coin');
  } else if (lines.some((l) => PUMP.test(l.text))) problems.push('pump dot fun is mentioned with no coin live');
  const chad = said('guest', venue(siteHost));
  if (chad !== 1) problems.push(`GigaChad says the site ${chad} times, not once`);
  if (!sale.message && !sale.spotlight && !sale.cap && lines.some((l) => SALES.test(l.text)))
    problems.push('an exchange offers something that is not on sale');
  return problems;
}
/** Whether the lower-third's house slot is up at this moment. */
export function houseTickerUp(nowMs: number, cfg = houseConfig.ticker): boolean {
  return nowMs % cfg.everyMs < cfg.showMs;
}
