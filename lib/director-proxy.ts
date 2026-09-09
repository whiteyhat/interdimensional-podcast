const endpoint = 'minimax/h3-max/director';
const allowed = new Set([
  'https://wma.fal.run/session',
  'https://wma.fal.run/ice',
  'https://wma.fal.run/session/heartbeat',
  `https://fal.run/${endpoint}/ice`,
]);
const reply = (error: string, status: number) =>
  Response.json(
    { error },
    { status, headers: { 'cache-control': 'no-store' } },
  );
export function localDirector(request: Request) {
  const url = new URL(request.url);
  return (
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    (!request.headers.get('origin') ||
      request.headers.get('origin') === url.origin) &&
    request.headers.get('sec-fetch-site') !== 'cross-site'
  );
}
/** The producer runs on loopback. This is deliberately unavailable on the public deployment. */
export async function directorProxy(
  request: Request,
  secret?: string,
  fetcher = fetch,
) {
  if (!localDirector(request))
    return reply(
      'Director is available only in the local producer console.',
      403,
    );
  if (!secret) return reply('FAL_KEY is missing from .dev.vars.', 503);
  const target = request.headers.get('x-fal-target-url') ?? '';
  if (request.method !== 'POST' || !allowed.has(target))
    return reply('Director operation not allowed.', 400);
  const reader = request.body?.getReader();
  if (!reader) return reply('Expected JSON.', 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 131072) {
      await reader.cancel();
      return reply('Request too large.', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return reply('Expected JSON.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return reply('Invalid Director payload.', 400);
  let input: object;
  if (target.endsWith('/heartbeat')) {
    if (
      typeof body.session_id !== 'string' ||
      !/^[\w-]{1,200}$/.test(body.session_id)
    )
      return reply('Invalid session.', 400);
    input = { session_id: body.session_id };
  } else if (target.startsWith('https://fal.run/')) {
    if (Object.keys(body).length) return reply('Invalid ICE request.', 400);
    input = {};
  } else {
    if (body.app_id !== endpoint)
      return reply('Invalid Director endpoint.', 400);
    input = { app_id: endpoint };
    if (target.endsWith('/session')) {
      if (
        body.type !== 'offer' ||
        typeof body.sdp !== 'string' ||
        !body.sdp.startsWith('v=0')
      )
        return reply('Invalid SDP offer.', 400);
      input = { ...input, sdp: body.sdp, type: 'offer' };
    }
  }
  try {
    const response = await fetcher(target, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Key ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(target.endsWith('/session') ? 90000 : 8000),
      ]),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw Error('Signalling redirect refused.');
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.replaceAll(secret, '[redacted]').slice(0, 180)
        : 'Network failure';
    return reply(`Director signalling is unavailable: ${detail}`, 502);
  }
}
