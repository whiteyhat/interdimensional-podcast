import {
  readBounded,
  sha256Hex,
  sponsorMediaConfig,
  type SponsorMediaVars,
} from './sponsor-assets';
import { sponsorFailure } from './sponsor-server';
import { SponsorError, type SponsorLease } from './sponsorship';
import { resolveTrustedSponsor } from './sponsor-context';
import { readStudioId } from './interact';

const MAX_VIDEO = 40 * 1024 * 1024;
// The media service accepts a /render body of at most 8 MiB, and base64 grows the logo by a
// third on the way. 5 MiB of PNG leaves the rest of the body room, and is more than a
// normalized mark can weigh: the normalizer holds it to 1024 pixels a side.
const MAX_LOGO = 5 * 1024 * 1024;
// The timeout ladder, from the inside out: the media service finishes or fails a render
// within 95 s, this site gives it 105 s, the studio bridge waits 115 s and the browser 120 s.
// Each rung outlasts the one it calls, so a failure arrives as an answer, never a hang-up.
const RENDER_BUDGET_MS = 105000;
// A retry that starts with less than this left could not finish a render. It would only hold
// a slot some other take could have used.
const RETRY_FLOOR_MS = 40000;
const HEX64 = /^[a-f0-9]{64}$/;

type SponsorQuality = Record<string, unknown> & {
  accepted: true;
  audioVerified: true;
  frames: number;
  durationMs: number;
  outputSha256: string;
};
type QualifiedCap = {
  assetId: string;
  target: 'host' | 'guest';
  logoSha256: string;
  templateVersion: string;
};
const positive = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The quality summary, only when it vouches for fully tracked footage with byte-identical
 * audio and names the exact bytes it describes. Anything less is not a take we can air. */
function verifiedQuality(raw: unknown): SponsorQuality | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  return q.accepted === true &&
    q.audioVerified === true &&
    positive(q.frames) &&
    positive(q.durationMs) &&
    typeof q.outputSha256 === 'string' &&
    HEX64.test(q.outputSha256)
    ? (q as SponsorQuality)
    : null;
}
function qualityHeader(value: string | null) {
  if (!value) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return verifiedQuality(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}
function qualifiedCap(order: SponsorLease): QualifiedCap {
  const meta = order.assetMetadata,
    { assetId, target } = order.draft;
  if (
    order.draft.product !== 'cap' ||
    !meta ||
    !assetId ||
    (target !== 'host' && target !== 'guest') ||
    typeof meta.logoSha256 !== 'string' ||
    !HEX64.test(meta.logoSha256) ||
    typeof meta.templateVersion !== 'string' ||
    !meta.templateVersion ||
    meta.qualificationVersion !== 'caps-v1'
  )
    throw new SponsorError(
      409,
      'This cap has not passed broadcast qualification.',
      'ASSET',
    );
  return {
    assetId,
    target,
    logoSha256: meta.logoSha256,
    templateVersion: meta.templateVersion,
  };
}
function falVideo(raw: string) {
  let video: URL | undefined;
  try {
    video = new URL(raw);
  } catch {}
  if (
    !video ||
    video.protocol !== 'https:' ||
    video.username ||
    video.password ||
    video.hash ||
    !(video.hostname === 'fal.media' || video.hostname.endsWith('.fal.media'))
  )
    throw new SponsorError(400, 'The rendered video host is not allowed.');
  return video;
}
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * A take this site has already verified and stored for exactly this video, logo, host and
 * template. A studio retrying after a lost answer then costs the media service nothing. A
 * pointer that cannot be read counts as absent: rendering again costs time, not correctness.
 */
async function storedTake(assets: R2Bucket, key: string) {
  try {
    const pointer = await assets.get(`renders/${key}.json`);
    if (!pointer) return null;
    const saved = JSON.parse(await pointer.text()) as {
      sha?: unknown;
      quality?: unknown;
    } | null;
    const quality = verifiedQuality(saved?.quality);
    if (!quality || saved?.sha !== quality.outputSha256) return null;
    return (await assets.head(`${quality.outputSha256}/video.mp4`))
      ? quality
      : null;
  } catch {
    return null;
  }
}

/**
 * The buyer's normalized mark, read from this site's own storage. The media service used to
 * download it back from the public site, which broke whenever the two disagreed about the
 * site's origin and put a datacenter fetch in front of the zone's bot protection. The bytes
 * must still be the ones qualification hashed, or no take is made from them.
 */
async function qualifiedLogo(assets: R2Bucket, cap: QualifiedCap) {
  const object = await assets.get(`${cap.assetId}/logo.png`);
  if (!object)
    throw new SponsorError(
      409,
      'The artwork for this cap is missing from storage.',
      'ASSET',
    );
  if (object.size > MAX_LOGO) {
    await object.body.cancel().catch(() => {});
    throw new SponsorError(
      409,
      'The artwork for this cap is too large to render.',
      'ASSET',
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== cap.logoSha256)
    throw new SponsorError(
      409,
      'The artwork for this cap no longer matches what was qualified.',
      'ASSET',
    );
  return bytes;
}

function mediaFailure(status: number, error: unknown) {
  const message =
    typeof error === 'string' && error ? error.slice(0, 300) : undefined;
  if (status === 422)
    return new SponsorError(
      422,
      message || 'The wardrobe take could not be verified.',
      'INVALID_WEARABLE',
    );
  if (status === 409)
    return new SponsorError(
      409,
      message || 'This cap artwork did not match its qualification.',
      'ASSET',
    );
  return new SponsorError(
    503,
    message || 'The wardrobe desk could not finish this take.',
    'WARDROBE',
  );
}

/**
 * POST the render, trying once more when the service is only busy or out of reach. The
 * second try waits what the service asked for (never more than 5 s) plus jitter, so studios
 * turned away together do not return together, and it happens only while 40 s of the budget
 * would still remain. A timeout is never retried: the budget it ran out of is this one.
 */
async function requestRender(endpoint: URL, token: string, body: string) {
  const deadline = Date.now() + RENDER_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    let retryAfterMs = 1000,
      reason = 'The wardrobe desk could not be reached.';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body,
        // Workers refuse 'error'; a redirect comes back unfollowed and fails as a non-2xx.
        redirect: 'manual',
        signal,
      });
      if (response.ok) return response;
      const failure = (await response.json().catch(() => null)) as {
        code?: unknown;
        error?: unknown;
        retryAfterMs?: unknown;
      } | null;
      if (response.status !== 503 || failure?.code !== 'BUSY')
        throw mediaFailure(response.status, failure?.error);
      if (typeof failure.retryAfterMs === 'number' && failure.retryAfterMs >= 0)
        retryAfterMs = failure.retryAfterMs;
      reason =
        typeof failure.error === 'string' && failure.error
          ? failure.error.slice(0, 300)
          : 'The wardrobe desk is busy.';
    } catch (e) {
      if (e instanceof SponsorError) throw e;
      if (
        signal.aborted ||
        (e instanceof Error &&
          (e.name === 'TimeoutError' || e.name === 'AbortError'))
      )
        throw new SponsorError(
          503,
          'The wardrobe desk ran out of time on this take.',
          'WARDROBE',
        );
    }
    const wait = Math.min(retryAfterMs, 5000) + Math.random() * 500;
    if (attempt > 1 || deadline - Date.now() - wait < RETRY_FLOOR_MS)
      throw new SponsorError(503, reason, 'WARDROBE');
    await pause(wait);
  }
}

/**
 * The take's bytes, once they prove to be what the quality summary describes. A declared size
 * over the cap is refused before a byte is read, and an undeclared one is cut off as it
 * crosses it. A missing or unreadable summary is a take nobody vouched for, not an outage.
 * An echoed key naming some other render means the service mixed two jobs up; a service
 * that echoes no key is still held to the digest.
 */
async function verifiedTake(response: Response, key: string) {
  const refuse = async (error: SponsorError): Promise<never> => {
    await response.body?.cancel().catch(() => {});
    throw error;
  };
  if (Number(response.headers.get('content-length')) > MAX_VIDEO)
    return refuse(new SponsorError(413, 'The wardrobe take is too large.'));
  const quality = qualityHeader(response.headers.get('x-sponsor-quality'));
  if (!quality)
    return refuse(
      new SponsorError(
        422,
        'The wardrobe take did not supply verified timing.',
        'INVALID_WEARABLE',
      ),
    );
  const echoed = response.headers.get('x-sponsor-key');
  if (echoed && echoed !== key)
    return refuse(
      new SponsorError(
        422,
        'The wardrobe desk answered for a different take.',
        'INVALID_WEARABLE',
      ),
    );
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = response.body
      ? await readBounded(
          response.body,
          MAX_VIDEO,
          'The wardrobe take is too large.',
        )
      : new Uint8Array(0);
  } catch (e) {
    if (e instanceof SponsorError) throw e;
    throw new SponsorError(
      503,
      'The wardrobe take was cut off on its way here.',
      'WARDROBE',
    );
  }
  if ((await sha256Hex(bytes)) !== quality.outputSha256)
    throw new SponsorError(
      422,
      'The wardrobe video integrity check failed.',
      'INVALID_WEARABLE',
    );
  return { bytes, quality };
}

/** Persist only fully tracked footage with byte-identical audio. Cancellation is checked again
 * after processing, and the engine must acquire a playback start before showing these bytes. */
export async function renderSponsorMedia(
  request: Request,
  v: SponsorMediaVars,
) {
  try {
    const origin = request.headers.get('origin'),
      url = new URL(request.url),
      site = request.headers.get('sec-fetch-site');
    if (origin && origin !== url.origin)
      throw new SponsorError(403, 'Origin not allowed.');
    if (v.INTERACT_ORIGIN) {
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        (site && site !== 'same-origin' && site !== 'none')
      )
        throw new SponsorError(
          403,
          'The media bridge only serves the local studio.',
        );
      if (!v.STUDIO_TOKEN)
        throw new SponsorError(503, 'Studio authorization is unavailable.');
      const response = await fetch(
        new URL('/api/sponsorship/media', v.INTERACT_ORIGIN),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-studio-token': v.STUDIO_TOKEN,
            'x-studio-id': readStudioId(v.STUDIO_ID),
          },
          body: await request.text(),
          redirect: 'manual',
          signal: AbortSignal.timeout(115000),
        },
      );
      return new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });
    }
    if (!v.SPONSOR_ASSETS)
      throw new SponsorError(503, 'Wardrobe media storage is unavailable.');
    const assets = v.SPONSOR_ASSETS;
    const body = (await request.json().catch(() => null)) as {
      orderId?: unknown;
      leaseToken?: unknown;
      videoUrl?: unknown;
    } | null;
    if (
      !body ||
      typeof body.orderId !== 'string' ||
      typeof body.leaseToken !== 'string' ||
      typeof body.videoUrl !== 'string' ||
      body.videoUrl.length > 3000
    )
      throw new SponsorError(400, 'A valid wardrobe render is required.');
    const reference = { orderId: body.orderId, leaseToken: body.leaseToken };
    const order = await resolveTrustedSponsor(request, v, reference);
    const cap = qualifiedCap(order);
    const video = falVideo(body.videoUrl);
    // The same video, logo, host and template always make the same take. Naming the render by
    // them lets the media service join a render already running for them, and lets this site
    // hand back one it has already stored.
    const key = await sha256Hex(
      new TextEncoder().encode(
        [video.href, cap.logoSha256, cap.target, cap.templateVersion].join('|'),
      ),
    );
    const delivered = (quality: SponsorQuality) =>
      Response.json(
        {
          url: new URL(
            `/api/sponsorship/assets/${quality.outputSha256}?part=video`,
            v.SITE_URL || request.url,
          ).href,
          quality,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    const stored = await storedTake(assets, key);
    if (stored) return delivered(stored);
    const logo = await qualifiedLogo(assets, cap);
    const { url: service, token } = sponsorMediaConfig(v);
    const response = await requestRender(
      new URL('/render', service),
      token,
      JSON.stringify({
        videoUrl: video.href,
        logo: base64(logo),
        logoSha256: cap.logoSha256,
        target: cap.target,
        templateVersion: cap.templateVersion,
        key,
      }),
    );
    const { bytes, quality } = await verifiedTake(response, key);
    await resolveTrustedSponsor(request, v, reference);
    await assets.put(`${quality.outputSha256}/video.mp4`, bytes, {
      httpMetadata: { contentType: 'video/mp4' },
      customMetadata: {
        orderId: order.id,
        designId: cap.assetId,
        quality: JSON.stringify(quality),
      },
    });
    // The pointer is written after the video, so it never names footage that is not there. It
    // only saves a repeat render, so failing to write it must not throw away a stored take.
    await assets
      .put(
        `renders/${key}.json`,
        JSON.stringify({ sha: quality.outputSha256, quality }),
        { httpMetadata: { contentType: 'application/json' } },
      )
      .catch((e: unknown) =>
        console.warn(
          '[sponsorship] render pointer',
          e instanceof Error ? e.message : 'write failed',
        ),
      );
    return delivered(quality);
  } catch (e) {
    return sponsorFailure(e);
  }
}
