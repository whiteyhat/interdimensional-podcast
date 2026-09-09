import {
  assertSponsorStudio,
  handleSponsorship,
  type SponsorVars,
} from './sponsor-server';
import { SponsorError, type SponsorLease } from './sponsorship';
import type { SponsorReference } from './sponsor-program';
import { readStudioId } from './interact';

/** Fetch the purchased brief and immutable artwork from the active producer's lease. */
export async function resolveTrustedSponsor(
  request: Request,
  vars: SponsorVars,
  reference: SponsorReference,
): Promise<SponsorLease> {
  if (
    !reference ||
    typeof reference.orderId !== 'string' ||
    reference.orderId.length > 150 ||
    typeof reference.leaseToken !== 'string' ||
    reference.leaseToken.length > 150
  )
    throw new SponsorError(400, 'Invalid sponsorship reference.');
  const hostname = new URL(request.url).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new SponsorError(403, 'Origin not allowed.');
  if (local && site && !['same-origin', 'none'].includes(site))
    throw new SponsorError(
      403,
      'The studio bridge only serves its own machine.',
    );
  if (!local) assertSponsorStudio(request, vars);
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  if (local && vars.STUDIO_TOKEN) {
    headers.set('x-studio-token', vars.STUDIO_TOKEN);
    headers.set('x-studio-id', readStudioId(request.headers.get('x-studio-id')));
  }
  const response = await handleSponsorship(
    new Request(new URL('/api/sponsorship', request.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'context', ...reference }),
    }),
    vars,
  );
  const data = (await response.json()) as {
    order?: SponsorLease;
    error?: string;
    code?: string;
  };
  if (!response.ok || !data.order)
    throw new SponsorError(
      response.status,
      data.error || 'The sponsorship lease is unavailable.',
      data.code,
    );
  return data.order;
}
