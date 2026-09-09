import type {
  SponsorAttempt,
  SponsorCatalog,
  SponsorReceipt,
} from './sponsorship';
export type SponsorResponse = {
  receipt?: SponsorReceipt;
  attempt?: SponsorAttempt;
  transaction?: string;
  solanaPayUrl?: string;
  error?: string;
};
export async function sponsorAction(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SponsorResponse> {
  const response = await fetch('/api/sponsorship', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(25000),
  });
  const data = (await response.json()) as SponsorResponse;
  if (!response.ok)
    throw Error(
      data.error || 'The studio could not complete that step. Try again.',
    );
  return data;
}
export async function loadSponsorReceipt(
  token: string,
  signal?: AbortSignal,
): Promise<SponsorReceipt> {
  const response = await fetch(
    `/api/sponsorship?action=receipt&token=${encodeURIComponent(token)}`,
    { cache: 'no-store', signal },
  );
  const data = (await response.json()) as SponsorResponse;
  if (!response.ok || !data.receipt)
    throw Error(data.error || 'Your receipt could not be loaded.');
  return data.receipt;
}
export async function loadSponsorCatalog(
  signal?: AbortSignal,
): Promise<SponsorCatalog> {
  const response = await fetch('/api/sponsorship?action=catalog', {
    cache: 'no-store',
    signal,
  });
  const data = (await response.json()) as SponsorCatalog & {
    catalog?: SponsorCatalog;
    error?: string;
  };
  if (!response.ok)
    throw Error(data.error || 'Sponsorship availability could not be loaded.');
  return data.catalog ?? data;
}
