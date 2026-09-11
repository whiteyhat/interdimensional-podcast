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
/** Hex SHA-256, the identity every stored artwork and take is filed and checked under. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
function decode(base64: string) {
  if (base64.length > 12 * 1024 * 1024)
    throw new SponsorError(502, 'Artwork response is too large.');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
/**
 * Where the media service lives and the secret its /preview and /render calls carry. Those
 * two are all this side needs: the logo now travels inside each render request, so nothing
 * here depends on the service being able to reach this site.
 */
export function sponsorMediaConfig(v: SponsorMediaVars) {
  let url: URL | undefined;
  try {
    url = v.SPONSOR_MEDIA_URL ? new URL(v.SPONSOR_MEDIA_URL) : undefined;
  } catch {
    throw new SponsorError(
      503,
      'The wardrobe service URL is invalid.',
      'MEDIA',
    );
  }
  if (!url || !v.SPONSOR_MEDIA_TOKEN || v.SPONSOR_MEDIA_TOKEN.length < 24)
    throw new SponsorError(
      503,
      'The wardrobe desk is not connected yet.',
      'MEDIA',
    );
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
type MediaHealth = {
  ready: boolean;
  capQualified: boolean;
  templateVersion?: string;
};
const notReady = (): MediaHealth => ({ ready: false, capQualified: false });
// GET /api/sponsorship/assets is public. Without a memory here every hit on it would make
// the media service run its readiness checks, so a crowd refreshing the page would be a
// crowd of probes. An answer is reused by this isolate for 15 seconds, and callers who
// arrive while a probe is still out wait on that same probe instead of starting another.
const HEALTH_TTL_MS = 15000;
const HEALTH_PROBE_MS = 5000;
// The studio heartbeats cap:true or cap:false from this answer, and a lease whose producer
// stops reporting cap:true is refused mid-take: the verified take is thrown away and the paid
// order pauses. One lost or slow probe must not read as the desk going down, so the last
// answer the service actually gave stands for 75 seconds after it arrived. Only a service
// that has stayed out of reach that long, or that says itself it is not ready, is reported
// not ready.
const HEALTH_STALE_MS = 75000;
// A caller that already holds a standing answer waits this long for a fresher one, then takes
// the standing one. The studio gives its whole health round trip 5 s, so waiting out the
// probe's own 5 s timeout would lose the very answer the stale window keeps.
const HEALTH_PATIENCE_MS = 2500;
// A Worker drops what a finished request left running, so a probe can be lost with the
// request that started it and never settle. One still out well past its own timeout is not
// waited on again; the next caller starts another.
const HEALTH_ABANDON_MS = HEALTH_PROBE_MS + 1000;
type HealthEntry = {
  /** The last answer the service gave on purpose, and when it arrived. */
  answer?: { health: MediaHealth; at: number };
  /** When the last probe settled, answered or not. The quiet period runs from here. */
  checkedAt?: number;
  probe?: { started: number; done: Promise<void> };
};
// Keyed by media URL. One is configured at a time; the bound only stops a changed one leaking.
const healthByUrl = new Map<string, HealthEntry>();
function healthEntry(key: string) {
  let entry = healthByUrl.get(key);
  if (!entry) {
    const oldest = healthByUrl.keys().next();
    if (healthByUrl.size >= 8 && !oldest.done) healthByUrl.delete(oldest.value);
    entry = {};
    healthByUrl.set(key, entry);
  }
  return entry;
}
/** A small JSON object from a body, or null. A health answer is a few hundred bytes; a wrong
 * host can send anything, so its body is never read whole. */
async function smallJson(response: Response) {
  if (!response.body) return null;
  try {
    const data: unknown = JSON.parse(
      new TextDecoder().decode(
        await readBounded(response.body, 64 * 1024, 'Health answer too large.'),
      ),
    );
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
/** A health answer, when the body is one: it has to say whether the desk is ready. */
function healthFrom(data: Record<string, unknown> | null): MediaHealth | null {
  if (!data || typeof data.ready !== 'boolean') return null;
  return {
    ready: data.ready,
    capQualified: data.capQualified === true,
    templateVersion:
      typeof data.templateVersion === 'string'
        ? data.templateVersion
        : undefined,
  };
}
/** What the service says about itself, or null when nothing it said can be trusted. */
async function probeMediaHealth(url: URL): Promise<MediaHealth | null> {
  try {
    // /health is unauthenticated, so the render secret stays off this request.
    // Workers refuse the 'error' redirect mode outright, so every call to the media service asks for
    // the redirect back unfollowed. Nothing then reaches another host, and each caller already
    // treats anything but a 2xx as a failure.
    const r = await fetch(new URL('/health', url), {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_PROBE_MS),
    });
    const data = await smallJson(r);
    // A 503 the service wrote itself is it saying it is not ready, whatever its body goes on
    // to claim. A proxy's error page in front of a restarting service says nothing about it.
    if (r.status === 503) return data ? notReady() : null;
    return r.ok ? healthFrom(data) : null;
  } catch {
    return null;
  }
}
function startProbe(entry: HealthEntry, url: URL) {
  const probe = {
    started: Date.now(),
    done: probeMediaHealth(url).then((health) => {
      // The 15 seconds start when the probe settles, not when it was sent, so a slow probe
      // still buys the full quiet period afterwards.
      const at = Date.now();
      if (health) entry.answer = { health, at };
      entry.checkedAt = at;
      if (entry.probe === probe) entry.probe = undefined;
    }),
  };
  return probe;
}
const standing = (entry: HealthEntry, now: number) =>
  entry.answer && now - entry.answer.at <= HEALTH_STALE_MS
    ? entry.answer.health
    : undefined;
/** Wait for the probe, but never past ms: a lost one would otherwise hold the caller forever. */
async function settledWithin(done: Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
}
/**
 * Whether this site can carry a cap order through to broadcast. The service being up is not
 * enough: without the storage bucket or the render secret on this side, a buyer could pay
 * for a cap the site has no way to render, so either one missing means not ready, and
 * nothing is probed.
 */
export async function sponsorMediaHealth(
  v: SponsorMediaVars,
): Promise<MediaHealth> {
  let url: URL;
  try {
    url = sponsorMediaConfig(v).url;
  } catch {
    return notReady();
  }
  if (!v.SPONSOR_ASSETS) return notReady();
  const entry = healthEntry(url.href),
    now = Date.now();
  if (entry.probe && now - entry.probe.started >= HEALTH_ABANDON_MS)
    entry.probe = undefined;
  if (
    !entry.probe &&
    (entry.checkedAt === undefined || now - entry.checkedAt >= HEALTH_TTL_MS)
  )
    entry.probe = startProbe(entry, url);
  if (entry.probe)
    await settledWithin(
      entry.probe.done,
      standing(entry, now)
        ? HEALTH_PATIENCE_MS
        : entry.probe.started + HEALTH_ABANDON_MS - now,
    );
  return standing(entry, Date.now()) ?? notReady();
}
// The local studio bridge relays the site's answer, and one lost hop to the site would flip
// the studio's heartbeat to cap:false as surely as a lost probe. The site's last answer stands
// here for the same 75 seconds, and one the site gives passes straight through. The bridge
// gives up on the site after 4 s because the studio waits 5 s for the bridge.
const HEALTH_RELAY_MS = 4000;
let relayed: { origin: string; health: MediaHealth; at: number } | undefined;
export async function sponsorAssetHealth(
  request: Request,
  v: SponsorMediaVars,
) {
  const url = new URL(request.url);
  if (
    v.INTERACT_ORIGIN &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    const origin = v.INTERACT_ORIGIN;
    let health: MediaHealth | null = null;
    try {
      const response = await fetch(
        new URL('/api/sponsorship/assets?action=health', origin),
        { redirect: 'manual', signal: AbortSignal.timeout(HEALTH_RELAY_MS) },
      );
      if (response.ok) health = healthFrom(await smallJson(response));
      else await response.body?.cancel().catch(() => {});
    } catch {}
    const now = Date.now();
    if (health) relayed = { origin, health, at: now };
    else if (relayed?.origin === origin && now - relayed.at <= HEALTH_STALE_MS)
      health = relayed.health;
    return json(health ?? notReady());
  }
  return json(await sponsorMediaHealth(v));
}
/**
 * Read a body into memory, refusing it the moment it passes max bytes. Checking the size
 * only after buffering would let one oversized answer claim the isolate's memory first.
 * When the sender declared its length, the bytes land in one buffer of exactly that size, so
 * a 40 MiB take costs 40 MiB rather than its chunks and then their copy. A body that runs past
 * or stops short of the length it declared is not the body that was sent, and is refused.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array>,
  max: number,
  tooLarge: string,
  declared?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  try {
    if (declared !== undefined && declared > max)
      throw new SponsorError(413, tooLarge);
    if (
      declared !== undefined &&
      Number.isSafeInteger(declared) &&
      declared >= 0
    ) {
      const bytes = new Uint8Array(declared);
      let offset = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value.length > declared - offset)
          throw new Error('The body ran past the length it declared.');
        bytes.set(r.value, offset);
        offset += r.value.length;
      }
      if (offset !== declared)
        throw new Error('The body ended short of the length it declared.');
      return bytes;
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw new SponsorError(413, tooLarge);
      parts.push(r.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get('content-length')) > max)
    throw new SponsorError(413, 'Use an image under 4 MB.');
  if (!request.body) throw new SponsorError(400, 'Choose an image.');
  return readBounded(request.body, max, 'Use an image under 4 MB.');
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
      redirect: 'manual',
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
      sha256Hex(preview),
      sha256Hex(logo),
    ]);
    if (previewHash !== result.sha256 || logoHash !== result.logoSha256)
      throw new SponsorError(502, 'Artwork integrity check failed.');
    // Bind the canonical image, original normalized mark, target and qualification revision.
    // A later upload or qualification must never rewrite an already purchased design.
    const id = await sha256Hex(
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
