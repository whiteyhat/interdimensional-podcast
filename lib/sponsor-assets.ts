import type { SponsorVars } from './sponsor-server';
import { sponsorDatabase, sponsorFailure } from './sponsor-server';
import { SponsorError } from './sponsorship';
import { allowSponsorRequest } from './sponsor-db';
import { perMinuteCounter } from './throttle';
const tooMany = perMinuteCounter();
export type SponsorMediaVars = SponsorVars & {
  SPONSOR_ASSETS?: R2Bucket;
  SPONSOR_MEDIA_URL?: string;
  SPONSOR_MEDIA_TOKEN?: string;
  SITE_URL?: string;
};
const MAX_UPLOAD = 4 * 1024 * 1024;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
function decode(base64: string) {
  if (base64.length > 12 * 1024 * 1024)
    throw new SponsorError(502, 'Artwork response is too large.');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
export function sponsorMediaConfig(v: SponsorMediaVars) {
  if (
    !v.SPONSOR_MEDIA_URL ||
    !v.SPONSOR_MEDIA_TOKEN ||
    v.SPONSOR_MEDIA_TOKEN.length < 24
  )
    throw new SponsorError(
      503,
      'The wardrobe desk is not connected yet.',
      'MEDIA',
    );
  const url = new URL(v.SPONSOR_MEDIA_URL);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new SponsorError(
      503,
      'The wardrobe service URL is invalid.',
      'MEDIA',
    );
  return { url, token: v.SPONSOR_MEDIA_TOKEN };
}
export async function sponsorMediaHealth(v: SponsorMediaVars): Promise<{
  ready: boolean;
  capQualified: boolean;
  templateVersion?: string;
}> {
  try {
    const { url, token } = sponsorMediaConfig(v);
    const r = await fetch(new URL('/health', url), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ready: false, capQualified: false };
    const data = (await r.json()) as {
      ready?: boolean;
      capQualified?: boolean;
      templateVersion?: string;
    };
    return {
      ready: data.ready === true && !!v.SPONSOR_ASSETS,
      capQualified: data.capQualified === true && !!v.SPONSOR_ASSETS,
      templateVersion: data.templateVersion,
    };
  } catch {
    return { ready: false, capQualified: false };
  }
}
export async function sponsorAssetHealth(
  request: Request,
  v: SponsorMediaVars,
) {
  const url = new URL(request.url);
  if (
    v.INTERACT_ORIGIN &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    try {
      const response = await fetch(
        new URL('/api/sponsorship/assets?action=health', v.INTERACT_ORIGIN),
        { redirect: 'error', signal: AbortSignal.timeout(6000) },
      );
      return new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return json({ ready: false, capQualified: false });
    }
  }
  return json(await sponsorMediaHealth(v));
}
async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get('content-length')) > max)
    throw new SponsorError(413, 'Use an image under 4 MB.');
  const reader = request.body?.getReader();
  if (!reader) throw new SponsorError(400, 'Choose an image.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw new SponsorError(413, 'Use an image under 4 MB.');
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export async function uploadSponsorAsset(
  request: Request,
  v: SponsorMediaVars,
) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      throw new SponsorError(403, 'Origin not allowed.');
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (tooMany(`sponsor-art:${ip}`, 6, Date.now()))
      throw new SponsorError(
        429,
        'Give the wardrobe desk a moment, then try again.',
      );
    if (!v.SPONSOR_ASSETS)
      throw new SponsorError(
        503,
        'Artwork storage is not connected yet.',
        'ASSETS',
      );
    const d = await sponsorDatabase(v);
    if (!(await allowSponsorRequest(d, `artwork:${ip}`, 6, Date.now())))
      throw new SponsorError(
        429,
        'Give the wardrobe desk a moment, then try again.',
      );
    const { url, token } = sponsorMediaConfig(v);
    const bytes = await boundedBody(request, MAX_UPLOAD + 16384);
    const form = await new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || '' },
      body: bytes,
    }).formData();
    const image = form.get('image');
    const rawKind = form.get('kind'),
      rawTarget = form.get('target');
    const kind = typeof rawKind === 'string' ? rawKind : '',
      target = typeof rawTarget === 'string' ? rawTarget : '';
    if (
      !(image instanceof File) ||
      image.size > MAX_UPLOAD ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.type) ||
      !['logo', 'cap'].includes(String(kind)) ||
      !['host', 'guest'].includes(String(target))
    )
      throw new SponsorError(
        400,
        'Choose a PNG, JPG, or WebP image and a supported placement.',
      );
    const endpoint = new URL('/preview', url);
    endpoint.searchParams.set('kind', String(kind));
    endpoint.searchParams.set('target', String(target));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': image.type },
      body: image,
      redirect: 'error',
      signal: AbortSignal.timeout(40000),
    });
    const result = (await response.json()) as {
      error?: string;
      preview?: string;
      logo?: string;
      sha256?: string;
      logoSha256?: string;
      templateId?: string;
      templateVersion?: string;
      qualificationVersion?: string | null;
    };
    if (!response.ok || !result.preview || !result.logo)
      throw new SponsorError(
        response.status === 422 ? 422 : 503,
        result.error || 'Artwork could not be prepared.',
      );
    const preview = decode(result.preview),
      logo = decode(result.logo);
    const [previewHash, logoHash] = await Promise.all([
      hash(preview),
      hash(logo),
    ]);
    if (previewHash !== result.sha256 || logoHash !== result.logoSha256)
      throw new SponsorError(502, 'Artwork integrity check failed.');
    // Bind the canonical image, original normalized mark, target and qualification revision.
    // A later upload or qualification must never rewrite an already purchased design.
    const id = await hash(
      new TextEncoder().encode(
        JSON.stringify([
          previewHash,
          logoHash,
          kind,
          target,
          result.templateId ?? null,
          result.templateVersion ?? null,
          result.qualificationVersion ?? null,
        ]),
      ),
    );
    const publicOrigin = new URL(v.SITE_URL || request.url).origin;
    const previewUrl = new URL(`/api/sponsorship/assets/${id}`, publicOrigin)
        .href,
      logoUrl = new URL(`/api/sponsorship/assets/${id}?part=logo`, publicOrigin)
        .href;
    await Promise.all([
      v.SPONSOR_ASSETS.put(`${id}/preview.png`, preview, {
        httpMetadata: { contentType: 'image/png' },
      }),
      v.SPONSOR_ASSETS.put(`${id}/logo.png`, logo, {
        httpMetadata: { contentType: 'image/png' },
      }),
    ]);
    const status =
      kind === 'logo' || result.qualificationVersion ? 'qualified' : 'preview';
    const metadata = {
      kind,
      target,
      sha256: previewHash,
      logoSha256: logoHash,
      logoUrl,
      templateId: result.templateId,
      templateVersion: result.templateVersion,
      qualificationVersion: result.qualificationVersion,
      sourceUrl: result.templateId
        ? new URL(`/wearables/${result.templateId}.png`, publicOrigin).href
        : null,
    };
    await d
      .prepare(
        'INSERT OR IGNORE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        id,
        status,
        previewUrl,
        'image/png',
        Date.now(),
        JSON.stringify(metadata),
      )
      .run();
    return json({ id, url: previewUrl, logoUrl, status });
  } catch (e) {
    return sponsorFailure(e);
  }
}
export async function readSponsorAsset(
  request: Request,
  v: SponsorMediaVars,
  id: string,
) {
  if (!/^[a-f0-9]{64}$/.test(id) || !v.SPONSOR_ASSETS)
    return new Response('Artwork not found', { status: 404 });
  const part = new URL(request.url).searchParams.get('part');
  const key =
    part === 'video'
      ? `${id}/video.mp4`
      : `${id}/${part === 'logo' ? 'logo' : 'preview'}.png`;
  const object = await v.SPONSOR_ASSETS.get(key, { range: request.headers });
  if (!object) return new Response('Artwork not found', { status: 404 });
  const headers: Record<string, string> = {
    'content-type': part === 'video' ? 'video/mp4' : 'image/png',
    'cache-control': 'public,max-age=31536000,immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    etag: object.httpEtag,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
  };
  let status = 200;
  if (
    object.range &&
    'offset' in object.range &&
    object.range.offset !== undefined &&
    object.range.length !== undefined
  ) {
    status = 206;
    headers['content-range'] =
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`;
    headers['content-length'] = String(object.range.length);
  } else headers['content-length'] = String(object.size);
  return new Response(object.body, { status, headers });
}
