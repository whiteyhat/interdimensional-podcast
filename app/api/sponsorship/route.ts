import { env } from 'cloudflare:workers';
import { handleSponsorship, type SponsorMediaVars } from '@/lib/sponsor-server';
export const GET = (request: Request) =>
  handleSponsorship(request, env as unknown as SponsorMediaVars);
export const POST = GET;
