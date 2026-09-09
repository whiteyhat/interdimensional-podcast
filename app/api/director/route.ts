import { env } from 'cloudflare:workers';
import { directorProxy, localDirector } from '@/lib/director-proxy';
export async function GET(request: Request) {
  const vars = env as unknown as {
    FAL_KEY?: string;
    DIRECTOR_SESSION_SECONDS?: string;
  };
  const seconds = Number(vars.DIRECTOR_SESSION_SECONDS || 3600);
  return Response.json(
    {
      configured: localDirector(request) && !!vars.FAL_KEY,
      sessionSeconds: Number.isFinite(seconds)
        ? Math.max(120, Math.min(3600, seconds))
        : 3600,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
export async function POST(request: Request) {
  return directorProxy(
    request,
    (env as unknown as { FAL_KEY?: string }).FAL_KEY,
  );
}
