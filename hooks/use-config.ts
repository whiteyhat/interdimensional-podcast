'use client';
import { readConfig, type PublicConfig } from '@/lib/interact';
import { usePoll } from '@/hooks/use-poll';
export type { PublicConfig } from '@/lib/interact';
export { browserFallbackRpc } from '@/lib/interact';
/**
 * Public site configuration, refreshed while the tab is visible. Off air it asks often:
 * that is the only moment the page is waiting for news, and half a minute of staleness is
 * half a minute of a visitor looking at OFF AIR over a show that has already started.
 * Once the studio is up there is nothing to hurry for.
 */
export function useConfig(
  intervalMs?: number | ((data: PublicConfig | null) => number),
): {
  config: PublicConfig | null;
  error: string;
} {
  const { data, error } = usePoll('/api/interact?action=config', readConfig, {
    intervalMs: intervalMs ?? ((held) => (held?.studioOnline ? 30000 : 6000)),
    errorText: 'Cannot reach the studio server.',
  });
  return { config: data, error };
}
