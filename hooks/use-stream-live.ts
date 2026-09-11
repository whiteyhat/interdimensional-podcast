'use client';
import { usePoll } from '@/hooks/use-poll';

/**
 * Cloudflare Stream publishes each live input's own state at `/<uid>/lifecycle`, without a
 * token and open to any origin. It is the only thing that actually knows whether a picture
 * is arriving: the studio heartbeat says a producer is alive, which is a different question
 * and answers yes for a long minute before the encoder connects.
 */
export function lifecycleUrl(embed: string | null): string | null {
  if (!embed) return null;
  try {
    const url = new URL(embed);
    if (
      url.hostname !== 'cloudflarestream.com' &&
      !url.hostname.endsWith('.cloudflarestream.com')
    )
      return null;
    const uid = url.pathname.split('/').filter(Boolean)[0];
    return uid ? `${url.origin}/${uid}/lifecycle` : null;
  } catch {
    return null;
  }
}
/** True once the input is connected, false while it is not, null when nothing can tell us. */
export function useStreamLive(embed: string | null): boolean | null {
  const url = lifecycleUrl(embed);
  const { data } = usePoll(
    url,
    (raw, ok) =>
      ok && raw && typeof raw === 'object'
        ? {
            live:
              (raw as { live?: unknown }).live === true ||
              (raw as { status?: unknown }).status === 'connected',
          }
        : null,
    {
      // Waiting for a picture is the impatient state; watching one is not.
      intervalMs: (held) => (held?.live ? 30000 : 6000),
      errorText: '',
    },
  );
  // A player we cannot ask about is one we must not gamble on: an idle Cloudflare input
  // renders as a blank white rectangle, which reads as a broken site.
  return url ? !!data?.live : null;
}
