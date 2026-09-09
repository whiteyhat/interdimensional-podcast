import { env } from 'cloudflare:workers';
import {
  uploadSponsorAsset,
  sponsorAssetHealth,
  type SponsorMediaVars,
} from '@/lib/sponsor-assets';
export const POST = (request: Request) =>
  uploadSponsorAsset(request, env as unknown as SponsorMediaVars);
export const GET = (request: Request) =>
  sponsorAssetHealth(request, env as unknown as SponsorMediaVars);
