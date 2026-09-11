import { StudioBusyError } from './requests';
import type { SponsorServices, SponsorEvent } from './sponsor-program';
import type { SponsorLease } from './sponsorship';
import type {
  SponsorDraft,
  SponsorFulfillment,
  SponsorStatus,
} from './sponsorship';
export type SponsorConsoleOrder = {
  id: string;
  draft: SponsorDraft;
  status: SponsorStatus;
  fulfillment: SponsorFulfillment;
};

async function call<T>(body: unknown) {
  const response = await fetch('/api/sponsorship', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as T & { error?: string; code?: string };
  if (!response.ok) {
    if (data.code === 'STUDIO_BUSY') throw new StudioBusyError(data.error);
    const error = new Error(
      data.error || 'Sponsorship delivery is unavailable.',
    );
    Object.assign(error, {
      retryable: response.status >= 500,
      code: data.code,
    });
    throw error;
  }
  return data;
}
/** How long a studio trusts its last cap health answer when a fresh check fails. */
export const HEALTH_GRACE_MS = 75000;
export function createSponsorServices(): SponsorServices {
  const pauseKey = 'podcast:sponsor-pause-intents:v1';
  const pauses = new Map<string, SponsorEvent>();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(pauseKey) || '[]');
    if (Array.isArray(saved))
      for (const event of saved.slice(0, 20)) {
        if (
          event?.type === 'paused' &&
          ['orderId', 'leaseToken', 'eventId'].every(
            (key) => typeof event[key] === 'string' && event[key].length <= 150,
          )
        )
          pauses.set(event.leaseToken, event);
      }
  } catch {
    /* Server acknowledgment still owns recovery when browser storage is unavailable. */
  }
  const persistPauses = () => {
    try {
      localStorage.setItem(pauseKey, JSON.stringify([...pauses.values()]));
    } catch {}
  };
  async function sendEvent(event: SponsorEvent) {
    if (event.type === 'paused') {
      pauses.set(event.leaseToken, event);
      persistPauses();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await call<
          Awaited<ReturnType<SponsorServices['event']>>
        >({ action: 'event', ...event });
        if (event.type === 'paused' && result.status === 'paused') {
          pauses.delete(event.leaseToken);
          persistPauses();
        }
        return result;
      } catch (error) {
        if (
          event.type === 'paused' &&
          (error as { code?: string }).code === 'LEASE'
        ) {
          pauses.delete(event.leaseToken);
          persistPauses();
        }
        const retryable =
          error instanceof TypeError ||
          (error as { retryable?: boolean }).retryable ||
          (error as Error).name === 'TimeoutError';
        if (!retryable || attempt >= 2) throw error;
      }
    }
  }
  async function recoverPauses() {
    for (const event of pauses.values()) {
      try {
        await sendEvent(event);
      } catch (error) {
        if ((error as { code?: string }).code !== 'LEASE') throw error;
      }
    }
    if (pauses.size)
      throw Error(
        'Waiting for the server to acknowledge interrupted delivery. Leases are not being renewed.',
      );
  }
  let health: {
    capQualified?: boolean;
    templateVersion?: string;
    ready?: boolean;
  } = {};
  let checked = 0,
    answeredAt = 0;
  return {
    async sync() {
      await recoverPauses();
      if (Date.now() - checked > 20000) {
        // A check that fails or runs slow keeps the last answer the site gave, for a while. One
        // missed probe used to heartbeat cap:false, and the site then refused the lease of a
        // cap already on air and threw away its finished take. An answer the site does give,
        // not ready included, always counts at once.
        let answer: typeof health | null = null;
        try {
          const response = await fetch(
            '/api/sponsorship/assets?action=health',
            { cache: 'no-store', signal: AbortSignal.timeout(5000) },
          );
          const body: unknown = await response.json().catch(() => null);
          if (body && typeof body === 'object' && 'ready' in body)
            answer = body as typeof health;
        } catch {
          /* Kept below: the last answer stands until it is too old to trust. */
        }
        if (answer) {
          health = answer;
          answeredAt = Date.now();
        } else if (Date.now() - answeredAt > HEALTH_GRACE_MS) health = {};
        checked = Date.now();
      }
      await recoverPauses();
      await call({
        action: 'heartbeat',
        capabilities: {
          message: true,
          spotlight: true,
          cap: health.ready === true && health.capQualified === true,
          ...(health.templateVersion
            ? { capTemplateVersion: health.templateVersion }
            : {}),
        },
      });
      return (await call<{ orders: SponsorLease[] }>({ action: 'pull' }))
        .orders;
    },
    event: sendEvent,
    async offline() {
      await recoverPauses();
      await call({
        action: 'heartbeat',
        capabilities: { message: false, spotlight: false, cap: false },
      });
    },
  };
}
export async function readSponsorConsole() {
  return (await call<{ orders: SponsorConsoleOrder[] }>({ action: 'console' }))
    .orders;
}
