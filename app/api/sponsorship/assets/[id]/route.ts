import { env } from 'cloudflare:workers';
import { readSponsorAsset, type SponsorMediaVars } from '@/lib/sponsor-assets';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return readSponsorAsset(
    request,
    env as unknown as SponsorMediaVars,
    (await params).id,
  );
}
