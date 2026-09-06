export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('url');
  if (!raw) return new Response('Missing URL', { status: 400 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))
  )
    return new Response('Host not allowed', { status: 403 });
  const range = request.headers.get('range');
  const upstream = await fetch(url, {
    headers: range ? { range } : {},
    redirect: 'manual',
  });
  if(upstream.status>=300&&upstream.status<400)return new Response('Unexpected media redirect',{status:502});
  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
  ]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('Cache-Control', 'public,max-age=31536000,immutable');
  return new Response(upstream.body, { status: upstream.status, headers });
}
