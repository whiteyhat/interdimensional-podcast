'use client';
import { readConfig, type PublicConfig } from '@/lib/interact';
import { usePoll } from '@/hooks/use-poll';
export type { PublicConfig } from '@/lib/interact';
export { browserFallbackRpc } from '@/lib/interact';
/** Public site configuration, refreshed every half minute while the tab is visible. */
export function useConfig(intervalMs = 30000): { config: PublicConfig | null; error: string } {
  const { data, error } = usePoll('/api/interact?action=config', readConfig, {
    intervalMs,
    errorText: 'Cannot reach the studio server.',
  });
  return { config: data, error };
}
