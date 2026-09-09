import { env } from 'cloudflare:workers';
import { isAddress } from '@solana/kit';
import { normalizeCoin } from '@/lib/coin';
import { fetchJson } from '@/lib/http';
type Vars = { COIN_MINT?: string };
const vars = () => env as unknown as Vars;
// pump.fun's data endpoints are CORS-protected, so the browser reads them through here.
// One isolate remembers the last answer for a few seconds and the subrequest cache lets the
// other isolates in the colo share it, so a crowd of viewers costs pump.fun one call.
const FRESH_MS = 12000;
const upstream = { cacheTtl: FRESH_MS / 1000 };
let memo: { at: number; body: unknown } | null = null;
const reply = (body: unknown, status = 200, cache = false) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': cache ? 'public, max-age=12' : 'no-store' },
  });
export async function GET() {
  const mint = vars().COIN_MINT?.trim() ?? '';
  if (!isAddress(mint)) return reply({ launched: false });
  const now = Date.now();
  if (memo && now - memo.at < FRESH_MS) return reply(memo.body, 200, true);
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
    memo = { at: now, body };
    return reply(body, 200, true);
  } catch (e) {
    console.warn('[coin] failed', e instanceof Error ? e.message : e);
    return reply(
      { launched: true, error: e instanceof Error ? e.message : 'Chart unavailable' },
      502,
    );
  }
}
