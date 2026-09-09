'use client';
import type { CoinSnapshot } from '@/lib/coin';
import { usePoll } from '@/hooks/use-poll';
export type CoinFeed = {
  coin: CoinSnapshot | null;
  /** null until the first answer; false means the coin has not launched yet. */
  launched: boolean | null;
  /** True when the chart belongs to a borrowed coin rather than the show's own. */
  rehearsal: boolean;
  error: string;
};
type Body = { launched?: boolean; rehearsal?: boolean; coin?: CoinSnapshot; error?: string };
/** Read the coin route's envelope; shared with the studio's engine service. */
export function readCoinBody(
  raw: unknown,
): { launched: boolean; rehearsal: boolean; coin: CoinSnapshot | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Body;
  return {
    launched: body.launched === true,
    rehearsal: body.rehearsal === true,
    coin: body.coin ?? null,
  };
}
/** The chart, refreshed every few seconds while the tab is visible. */
export function useCoin(intervalMs = 15000): CoinFeed {
  const { data, error } = usePoll('/api/coin', readCoinBody, {
    intervalMs,
    errorText: 'Chart unavailable',
  });
  return {
    coin: data?.coin ?? null,
    launched: data?.launched ?? null,
    rehearsal: data?.rehearsal === true,
    error,
  };
}
