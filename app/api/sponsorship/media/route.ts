import { env } from 'cloudflare:workers';
import { renderSponsorMedia } from '@/lib/sponsor-media';
import type { SponsorMediaVars } from '@/lib/sponsor-assets';
export const POST = (request: Request) =>
  renderSponsorMedia(request, env as unknown as SponsorMediaVars);
