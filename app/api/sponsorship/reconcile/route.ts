import { env } from 'cloudflare:workers';
import { reconcileLegacy } from '@/lib/legacy-recovery';
import {
  reconcileSponsorships,
  sameSponsorToken,
  sponsorFailure,
  type SponsorVars,
} from '@/lib/sponsor-server';
export async function POST(request: Request) {
  const v = env as unknown as SponsorVars;
  if (
    !sameSponsorToken(
      request.headers.get('x-reconcile-token') ?? '',
      v.SPONSOR_RECONCILE_TOKEN ?? '',
    )
  )
    return Response.json(
      { error: 'Reconciler token rejected.' },
      { status: 401 },
    );
  try {
    const result = await reconcileSponsorships(v);
    const legacy = await reconcileLegacy(v);
    return Response.json(
      { ...result, legacy },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (e) {
    return sponsorFailure(e);
  }
}
