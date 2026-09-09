import { env } from 'cloudflare:workers';
import { handleSolanaPay, type SponsorVars } from '@/lib/sponsor-server';
type Context = { params: Promise<{ capability: string }> };
export const GET = async (request: Request, context: Context) =>
  handleSolanaPay(
    request,
    env as unknown as SponsorVars,
    (await context.params).capability,
  );
export const POST = GET;
export const OPTIONS = GET;
