// The show's own chart: snapshots from pump.fun and the events the hosts react to.
// Pure: no network, no clock reads. The route normalizes, the studio derives events.
import type { TopicDraft } from './topics';
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type CoinSnapshot = {
  at: number;
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
  mcapUsd: number;
  mcapSol: number;
  athMcapUsd: number;
  /** Percent moves; null when the chart is too young to say. */
  change5m: number | null;
  change1h: number | null;
  change24h: number | null;
  volume24h: number | null;
  /** Bonding-curve progress, 0-100; 100 once graduated. */
  progress: number;
  graduated: boolean;
  replies: number;
  live: boolean;
  viewers?: number;
  createdAt: number;
  /** Five-minute candles, oldest first, for the sparkline. */
  candles: Candle[];
};
export type Mood = 'celebrate' | 'mourn' | 'deadpan';
export type CoinEventKind =
  | 'move5m'
  | 'move1h'
  | 'ath'
  | 'milestone'
  | 'graduated'
  | 'viewers'
  | 'quiet';
export type CoinEvent = {
  kind: CoinEventKind;
  mood: Mood;
  title: string;
  brief: string;
  angle: string;
  score: number;
};
/** What the studio remembers between snapshots so the same move is not celebrated twice. */
export type CoinMemory = {
  lastEventAt: number;
  lastMoveAt: number;
  lastMilestone: number;
  lastViewerMark: number;
  athUsd: number;
  seen: boolean;
};
export const coinConfig = {
  // A fresh pump.fun coin starts with 793.1M tokens on the curve; zero means graduated.
  initialRealTokenReserves: 793_100_000_000_000,
  supply: 1_000_000_000,
  decimals: 6,
  thresholds: {
    move5m: 8,
    move1h: 20,
    athPct: 2,
    quietMs: 10 * 60000,
    moveGapMs: 5 * 60000,
    hourGapMs: 15 * 60000,
    viewerMarks: [25, 50, 100, 250, 500, 1000, 2500],
    milestones: [25, 50, 75, 90],
  },
  maxCandles: 60,
} as const;
export type RawCandle = {
  timestamp: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
};
export const createCoinMemory = (): CoinMemory => ({
  lastEventAt: 0,
  lastMoveAt: 0,
  lastMilestone: 0,
  lastViewerMark: 0,
  athUsd: 0,
  seen: false,
});

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) => {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
};
const pct = (from: number, to: number) =>
  from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : null;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function parseCandles(
  raw: unknown,
  max: number = coinConfig.maxCandles,
): Candle[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: RawCandle) => ({
      t: num(c?.timestamp),
      o: num(c?.open),
      h: num(c?.high),
      l: num(c?.low),
      c: num(c?.close),
      v: num(c?.volume),
    }))
    .filter((c) => c.t > 0 && c.c > 0)
    .sort((a, b) => a.t - b.t)
    .slice(-max);
}
/** Turn the pump.fun coin payload plus candles into one snapshot the UI and the engine share. */
export function normalizeCoin(
  raw: Record<string, unknown>,
  solPrice: number,
  fiveMinute: unknown,
  hourly: unknown,
  now: number,
  mint: string,
): CoinSnapshot {
  const candles = parseCandles(fiveMinute);
  const hours = parseCandles(hourly, 25);
  const graduated = raw.complete === true;
  const virtualSol = num(raw.virtual_sol_reserves) / 1e9;
  const virtualTokens = num(raw.virtual_token_reserves) / 10 ** coinConfig.decimals;
  const supply =
    num(raw.total_supply) / 10 ** coinConfig.decimals || coinConfig.supply;
  const mcapUsd = num(raw.usd_market_cap ?? raw.market_cap_usd);
  const mcapSol = num(raw.market_cap);
  let priceUsd = 0;
  if (!graduated && virtualTokens > 0 && solPrice > 0)
    priceUsd = (virtualSol / virtualTokens) * solPrice;
  else if (mcapUsd > 0) priceUsd = mcapUsd / supply;
  else if (candles.length) priceUsd = candles[candles.length - 1].c;
  const real = num(raw.real_token_reserves);
  const progress = graduated
    ? 100
    : clamp(100 * (1 - real / coinConfig.initialRealTokenReserves), 0, 100);
  const last = candles.at(-1)?.c ?? priceUsd;
  const back = (n: number) => candles.at(-1 - n)?.c;
  const hourBack = hours.length >= 25 ? hours[hours.length - 25].c : hours[0]?.c;
  return {
    at: now,
    mint,
    name: str(raw.name) || 'the coin',
    symbol: str(raw.symbol) || 'coin',
    priceUsd,
    mcapUsd,
    mcapSol,
    athMcapUsd: Math.max(num(raw.ath_market_cap), mcapUsd),
    change5m: back(1) !== undefined ? pct(back(1)!, last) : null,
    change1h: back(12) !== undefined ? pct(back(12)!, last) : hours.length >= 2 ? pct(hours[hours.length - 2].c, last) : null,
    change24h: hourBack !== undefined && hours.length >= 2 ? pct(hourBack, last) : null,
    volume24h: hours.length ? hours.slice(-24).reduce((sum, c) => sum + c.v, 0) : null,
    progress: Math.round(progress * 10) / 10,
    graduated,
    replies: num(raw.reply_count),
    live: raw.is_currently_live === true,
    createdAt: num(raw.created_timestamp),
    candles,
  };
}

const short = (x: number) =>
  String(x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
/** Money the way a person says it on air: rounded, no symbols. */
export function spokenUsd(n: number) {
  if (!Number.isFinite(n) || n <= 0) return 'nothing';
  if (n >= 1e9) return `${short(n / 1e9)} billion dollars`;
  if (n >= 1e6) return `${short(n / 1e6)} million dollars`;
  if (n >= 1e3) return `${short(n / 1e3)} thousand dollars`;
  return `${Math.round(n)} dollars`;
}
const spokenPct = (n: number) => `${Math.round(Math.abs(n))} percent`;
const crowd = (coin: CoinSnapshot) =>
  coin.viewers && coin.viewers > 1
    ? ` About ${coin.viewers} people are watching the stream right now.`
    : coin.live
      ? ' The stream is live.'
      : '';
const ANGLE: Record<Mood, string> = {
  celebrate:
    'Celebrate like it is personal: Pepe takes credit and immediately wonders if he sold too early, GigaChad calls it destiny and discipline. Somewhere in there one host tells everyone to buy and the other undercuts it at once with a fresh not-financial-advice joke.',
  mourn:
    'Hold a funeral: Pepe narrates from inside the coffin with an exact number he should not share, GigaChad calls it a discount for people with character. Somewhere in there one host tells everyone to buy the dip and the other undercuts it at once with a fresh not-financial-advice joke.',
  deadpan:
    'Deadpan: Pepe is refreshing the app every nine seconds and describes the flat line like a hostage situation, GigaChad says patience is a position. If anyone says buy, undercut it at once with a fresh not-financial-advice joke.',
};
/** One chart event. `lead` is the half that differs; the rest of the brief is shared. */
type EventSpec = {
  kind: CoinEventKind;
  mood: Mood;
  title: string;
  lead: string;
  score: number;
  chart?: 'green' | 'red' | 'flat';
  /** The viewer-count event already names the crowd, so it does not say it twice. */
  crowd?: boolean;
};
/**
 * Compare two snapshots and say what, if anything, the hosts should react to.
 * Returns the events strongest first, and the memory to keep for next time.
 */
export function pumpEvents(input: {
  prev?: CoinSnapshot;
  next: CoinSnapshot;
  memory: CoinMemory;
  now: number;
}): { events: CoinEvent[]; memory: CoinMemory } {
  const { prev, next, now } = input;
  const t = coinConfig.thresholds;
  const spoken = next.symbol.replace(/^\$/, '').toLowerCase();
  const memory: CoinMemory = { ...input.memory };
  const events: CoinEvent[] = [];
  const cap = spokenUsd(next.mcapUsd);
  // Every event ends the same way: the market cap, the state of the chart, and the room.
  const add = (spec: EventSpec) => {
    events.push({
      kind: spec.kind,
      mood: spec.mood,
      title: spec.title,
      brief:
        `${spec.lead} at a market cap of about ${cap}.` +
        (spec.chart ? ` The chart is ${spec.chart}.` : '') +
        (spec.crowd === false ? '' : crowd(next)),
      angle: ANGLE[spec.mood],
      score: spec.score,
    });
  };
  if (!memory.seen) {
    // First look: learn the baseline, celebrate nothing yet.
    memory.seen = true;
    memory.lastEventAt = now;
    memory.athUsd = Math.max(next.athMcapUsd, next.mcapUsd);
    memory.lastMilestone = Math.max(0, ...t.milestones.filter((m) => next.progress >= m));
    memory.lastViewerMark = Math.max(
      0,
      ...t.viewerMarks.filter((m) => (next.viewers ?? 0) >= m),
    );
    return { events, memory };
  }
  if (prev && !prev.graduated && next.graduated) {
    add({
      kind: 'graduated',
      mood: 'celebrate',
      title: `${spoken} graduated off the bonding curve`,
      lead: `The show's own coin, ${spoken}, filled its whole bonding curve and graduated to a real trading pool`,
      score: 95,
    });
    memory.lastMilestone = 100;
  }
  if (!next.graduated) {
    const crossed = t.milestones.filter(
      (m) => next.progress >= m && m > memory.lastMilestone,
    );
    if (crossed.length) {
      const m = Math.max(...crossed);
      memory.lastMilestone = m;
      add({
        kind: 'milestone',
        mood: 'celebrate',
        title: `${spoken} is ${m} percent of the way to graduating`,
        lead: `The show's own coin, ${spoken}, is now ${m} percent of the way along its bonding curve,`,
        score: 80,
      });
    }
  }
  if (memory.athUsd > 0 && next.mcapUsd > memory.athUsd * (1 + t.athPct / 100)) {
    memory.athUsd = next.mcapUsd;
    add({
      kind: 'ath',
      mood: 'celebrate',
      title: `${spoken} just hit a new all-time-high market cap`,
      lead: `The show's own coin, ${spoken}, just printed a new all-time high`,
      score: 90,
      chart: 'green',
    });
  } else if (next.mcapUsd > memory.athUsd) memory.athUsd = next.mcapUsd;
  const move5 = next.change5m ?? 0;
  const move1 = next.change1h ?? 0;
  const moveOpen = now - memory.lastMoveAt >= t.moveGapMs;
  if (moveOpen && Math.abs(move5) >= t.move5m) {
    memory.lastMoveAt = now;
    const up = move5 > 0;
    add({
      kind: 'move5m',
      mood: up ? 'celebrate' : 'mourn',
      title: `${spoken} is ${up ? 'up' : 'down'} ${spokenPct(move5)} in five minutes`,
      lead: `The show's own coin, ${spoken}, moved ${up ? 'up' : 'down'} ${spokenPct(move5)} in the last five minutes and sits`,
      score: 70 + Math.min(25, Math.round(Math.abs(move5) / 2)),
      chart: up ? 'green' : 'red',
    });
  } else if (
    now - memory.lastMoveAt >= t.hourGapMs &&
    Math.abs(move1) >= t.move1h
  ) {
    memory.lastMoveAt = now;
    const up = move1 > 0;
    add({
      kind: 'move1h',
      mood: up ? 'celebrate' : 'mourn',
      title: `${spoken} is ${up ? 'up' : 'down'} ${spokenPct(move1)} in the last hour`,
      lead: `The show's own coin, ${spoken}, is ${up ? 'up' : 'down'} ${spokenPct(move1)} over the last hour and sits`,
      score: 65 + Math.min(25, Math.round(Math.abs(move1) / 4)),
      chart: up ? 'green' : 'red',
    });
  }
  const viewers = next.viewers ?? 0;
  const marks = t.viewerMarks.filter((m) => viewers >= m && m > memory.lastViewerMark);
  if (marks.length) {
    const m = Math.max(...marks);
    memory.lastViewerMark = m;
    add({
      kind: 'viewers',
      mood: 'celebrate',
      title: `${viewers} people are watching the ${spoken} stream right now`,
      lead: `The live stream for the show's own coin, ${spoken}, just passed ${m} viewers; ${viewers} people are watching right now,`,
      score: 60,
      crowd: false,
    });
  }
  if (!events.length && now - memory.lastEventAt >= t.quietMs && Math.abs(move5) < 2) {
    add({
      kind: 'quiet',
      mood: 'deadpan',
      title: `the ${spoken} chart has done nothing for ten minutes`,
      lead: `The show's own coin, ${spoken}, has barely moved in ten minutes and sits`,
      score: 45,
      chart: 'flat',
    });
  }
  if (events.length) memory.lastEventAt = now;
  events.sort((a, b) => b.score - a.score);
  return { events, memory };
}
/** Chart events as topics for the wire; the strongest first. */
export function coinDrafts(events: CoinEvent[]): TopicDraft[] {
  return events.map((e) => ({
    title: e.title,
    brief: e.brief,
    angle: e.angle,
    source: 'coin' as const,
    score: e.score,
    category: 'crypto' as const,
  }));
}
