import { env } from 'cloudflare:workers';
import { isAddress } from '@solana/kit';
import { chartPickConfig, normalizeCoin, pickChartCoin } from '@/lib/coin';
import { fetchJson } from '@/lib/http';
type Vars = { COIN_MINT?: string; CHART_MINT?: string };
const vars = () => env as unknown as Vars;
// pump.fun's data endpoints are CORS-protected, so the browser reads them through here.
// One isolate remembers the last answer for a few seconds and the subrequest cache lets the
// other isolates in the colo share it, so a crowd of viewers costs pump.fun one call.
const FRESH_MS = 12000;
const upstream = { cacheTtl: FRESH_MS / 1000 };
let memo: { at: number; mint: string; body: unknown } | null = null;
// The borrowed coin is held for a while: re-picking every twelve seconds would move the
// subject out from under a conversation the hosts are still having.
let borrowed: { at: number; mint: string } | null = null;
const reply = (body: unknown, status = 200, cache = false) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': cache ? 'public, max-age=12' : 'no-store' },
  });
/** Whichever live coin is trading hardest right now, remembered for twenty minutes. */
async function borrow(now: number): Promise<string> {
  if (borrowed && now - borrowed.at < chartPickConfig.holdMs) return borrowed.mint;
  const live = await fetchJson(
    'https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=48&sort=currently_live&order=DESC&includeNsfw=false',
    { cacheTtl: 60 },
  ).catch(() => null);
  const pick = pickChartCoin(live, now);
  // Nothing qualified: keep whatever we were already watching rather than going dark.
  if (!pick) return borrowed?.mint ?? '';
  if (pick.mint !== borrowed?.mint)
    console.log(`[coin] borrowing ${pick.symbol || pick.mint} for the chart lane`);
  borrowed = { at: now, mint: pick.mint };
  return pick.mint;
}
/**
 * The coin the hosts talk about. Normally the show's own, but CHART_MINT overrides it so the
 * chart lane can be rehearsed against a live coin before the show's own token exists.
 * CHART_MINT never touches the payment path, which reads COIN_MINT and only COIN_MINT.
 */
async function subject(now: number): Promise<{ mint: string; rehearsal: boolean }> {
  const own = vars().COIN_MINT?.trim() ?? '';
  const override = vars().CHART_MINT?.trim() ?? '';
  if (override === 'auto') {
    const mint = await borrow(now);
    return { mint, rehearsal: mint !== '' && mint !== own };
  }
  if (isAddress(override)) return { mint: override, rehearsal: override !== own };
  return { mint: own, rehearsal: false };
}
export async function GET() {
  const now = Date.now();
  const { mint, rehearsal } = await subject(now);
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
      rehearsal,
      coin: normalizeCoin(raw, Number(sol?.solPrice) || 0, fiveMinute, hourly, now, mint),
    };
    memo = { at: now, mint, body };
    return reply(body, 200, true);
  } catch (e) {
    console.warn('[coin] failed', e instanceof Error ? e.message : e);
    return reply(
      { launched: true, rehearsal, error: e instanceof Error ? e.message : 'Chart unavailable' },
      502,
    );
  }
}
