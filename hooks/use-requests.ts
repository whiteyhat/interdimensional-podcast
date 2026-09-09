'use client';
import { readPublicRequest, type PublicRequest } from '@/lib/interact';
import { usePoll } from '@/hooks/use-poll';
export type { PublicRequest, RowStatus } from '@/lib/interact';
export { readPublicRequest } from '@/lib/interact';
export type RequestsFeed = {
  /** The viewer's own request, when a reference was given and the server knows it. */
  request: PublicRequest | null;
  recent: PublicRequest[];
  error: string;
};
type Feed = { request: PublicRequest | null; recent: PublicRequest[] };
const settled = new Set(['aired', 'expired', 'failed']);
function readFeed(raw: unknown): Feed | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { request?: unknown; recent?: unknown };
  return {
    request: readPublicRequest(body.request),
    recent: Array.isArray(body.recent)
      ? body.recent.map(readPublicRequest).filter((r): r is PublicRequest => r !== null)
      : [],
  };
}
/**
 * Recent paid requests, and the viewer's own when a reference is given.
 * Polls every ten seconds, twice as often while the viewer's own request is still moving.
 */
export function useRequests(reference?: string): RequestsFeed {
  const { data, error } = usePoll(
    `/api/interact?action=status${reference ? `&reference=${encodeURIComponent(reference)}` : ''}`,
    readFeed,
    {
      intervalMs: (feed) =>
        reference && (!feed?.request || !settled.has(feed.request.status)) ? 5000 : 10000,
      errorText: 'Requests unavailable',
    },
  );
  return { request: data?.request ?? null, recent: data?.recent ?? [], error };
}
