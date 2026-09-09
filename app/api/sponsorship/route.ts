import { env } from 'cloudflare:workers';
import { handleSponsorship, type SponsorVars } from '@/lib/sponsor-server';
export const GET = (request: Request) =>
  handleSponsorship(request, env as unknown as SponsorVars);
export const POST = GET;
