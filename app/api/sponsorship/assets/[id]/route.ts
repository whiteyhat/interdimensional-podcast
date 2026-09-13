import { env } from 'cloudflare:workers';
import {
  readSponsorAsset,
  receiveLook,
  type SponsorMediaVars,
} from '@/lib/sponsor-assets';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  return readSponsorAsset(
    request,
    env as unknown as SponsorMediaVars,
    (await params).id,
  );
}
/** The wardrobe desk reporting how a tailor round ended. */
export async function PUT(request: Request, { params }: Context) {
  return receiveLook(
    request,
    env as unknown as SponsorMediaVars,
    (await params).id,
  );
}
