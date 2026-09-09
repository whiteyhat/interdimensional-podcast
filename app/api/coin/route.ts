import { env } from 'cloudflare:workers';
import { isAddress } from '@solana/kit';
import { chartPickConfig, normalizeCoin, pickChartCoin } from '@/lib/coin';
import { fetchJson } from '@/lib/http';
import { isLocalHost } from '@/lib/interact';
type Vars = { COIN_MINT?: string; CHART_MINT?: string };
const vars = () => env as unknown as Vars;
// pump.fun's data endpoints are CORS-protected, so the browser reads them through here.
// One isolate remembers the last answer for a few seconds and the subrequest cache lets the
// other isolates in the colo share it, so a crowd of viewers costs pump.fun one call.
const FRESH_MS = 12000;
const upstream = { cacheTtl: FRESH_MS / 1000 };
const LIVE_LIST =
  'https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=48&sort=currently_live&order=DESC&includeNsfw=false';
let memo: { at: number; mint: string; body: unknown } | null = null;
let borrowed: { epoch: number; mint: string } | null = null;
let picking: Promise<string> | null = null;
const reply = (body: unknown, status = 200, cache = false) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': cache ? 'public, max-age=12' : 'no-store' },
  });
/**
 * Whichever live coin is trading hardest, held for a while so the subject does not change out
 * from under a conversation the hosts are still having. The hold is a shared clock bucket
 * rather than each isolate's own timer: isolates then re-pick together, from the same cached
 * list, and land on the same coin instead of drifting onto different ones.
 */
async function borrow(now: number): Promise<string> {
  const epoch = Math.floor(now / chartPickConfig.holdMs);
  if (borrowed?.epoch === epoch) return borrowed.mint;
  // One list fetch per isolate per bucket even when requests arrive together.
  picking ??= (async () => {
    const live = await fetchJson(LIVE_LIST, { cacheTtl: 180 }).catch(() => null);
    const pick = pickChartCoin(live, now);
    // Record the attempt whatever the outcome. Leaving the bucket unset on a failed or empty
    // pick turns every later request into another upstream call for as long as it keeps
    // failing, which is exactly when pump.fun least wants to hear from us.
    const mint = pick?.mint ?? borrowed?.mint ?? '';
    if (pick && pick.mint !== borrowed?.mint)
      console.log(`[coin] borrowing ${pick.symbol || pick.mint} for the chart lane`);
    borrowed = { epoch, mint };
    return mint;
  })().finally(() => {
    picking = null;
  });
  return picking;
}
/**
 * The coin the hosts talk about. Normally the show's own, but CHART_MINT overrides it so the
 * chart lane can be rehearsed against a live coin before the show's own token exists.
 * CHART_MINT never touches the payment path, which reads COIN_MINT and only COIN_MINT.
 */
async function subject(now: number): Promise<{ mint: string; rehearsal: boolean }> {
  const own = vars().COIN_MINT?.trim() ?? '';
  const override = vars().CHART_MINT?.trim() ?? '';
  const mint =
    override === 'auto' ? await borrow(now) : isAddress(override) ? override : own;
  return { mint, rehearsal: mint !== '' && mint !== own };
}
export async function GET(request: Request) {
  const now = Date.now();
  const { mint, rehearsal } = await subject(now);
  // A borrowed chart is for rehearsing the hosts, never for showing the audience: the price is
  // real but it is somebody else's coin. Refusing it here rather than hiding it in the page
  // keeps it off the wire and out of the shared cache, and means no future consumer of this
  // route has to remember. The studio runs on the operator's own machine, so it still sees it.
  if (rehearsal && !isLocalHost(new URL(request.url).hostname)) return reply({ launched: false });
  if (!isAddress(mint)) return reply({ launched: false });
  if (memo && memo.mint === mint && now - memo.at < FRESH_MS)
    return reply(memo.body, 200, true);
  try {
    const [raw, sol, fiveMinute, hourly] = await Promise.all([
      fetchJson(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, upstream) as Promise<
        Record<string, unknown>
      >,
      fetchJson('https://frontend-api-v3.pump.fun/sol-price', upstream).catch(() => ({
        solPrice: 0,
      })) as Promise<{ solPrice?: number }>,
      fetchJson(
        `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=5m&limit=60&currency=USD`,
        upstream,
      ).catch(() => []),
      fetchJson(
        `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=1h&limit=25&currency=USD`,
        upstream,
      ).catch(() => []),
    ]);
    const body = {
      launched: true,
      coin: normalizeCoin(raw, Number(sol?.solPrice) || 0, fiveMinute, hourly, now, mint),
    };
    memo = { at: now, mint, body };
    return reply(body, 200, true);
  } catch (e) {
    console.warn('[coin] failed', e instanceof Error ? e.message : e);
    return reply({ launched: true, error: e instanceof Error ? e.message : 'Chart unavailable' }, 502);
  }
}
