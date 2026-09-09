import { sponsorMediaConfig, type SponsorMediaVars } from './sponsor-assets';
import { sponsorFailure } from './sponsor-server';
import { SponsorError } from './sponsorship';
import { resolveTrustedSponsor } from './sponsor-context';
import { readStudioId } from './interact';

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
          redirect: 'error',
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
    const body = (await request.json()) as {
      orderId?: string;
      leaseToken?: string;
      videoUrl?: string;
    };
    if (
      typeof body.orderId !== 'string' ||
      typeof body.leaseToken !== 'string' ||
      typeof body.videoUrl !== 'string' ||
      body.videoUrl.length > 3000
    )
      throw new SponsorError(400, 'A valid wardrobe render is required.');
    const reference = { orderId: body.orderId, leaseToken: body.leaseToken };
    const order = await resolveTrustedSponsor(request, v, reference);
    const meta = order.assetMetadata;
    if (
      order.draft.product !== 'cap' ||
      !meta ||
      typeof meta.logoUrl !== 'string' ||
      typeof meta.logoSha256 !== 'string' ||
      meta.qualificationVersion !== 'caps-v1'
    )
      throw new SponsorError(
        409,
        'This cap has not passed broadcast qualification.',
      );
    const video = new URL(body.videoUrl);
    if (
      video.protocol !== 'https:' ||
      video.username ||
      video.password ||
      video.hash ||
      !(video.hostname === 'fal.media' || video.hostname.endsWith('.fal.media'))
    )
      throw new SponsorError(400, 'The rendered video host is not allowed.');
    const { url: worker, token } = sponsorMediaConfig(v);
    const response = await fetch(new URL('/render', worker), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        videoUrl: video.href,
        logoUrl: meta.logoUrl,
        logoSha256: meta.logoSha256,
        target: order.draft.target,
        templateVersion: meta.templateVersion,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(110000),
    });
    if (!response.ok) {
      const failure = (await response.json()) as { error?: string };
      throw new SponsorError(
        response.status === 422 ? 422 : 503,
        failure.error || 'The wardrobe take could not be verified.',
        response.status === 422 ? 'INVALID_WEARABLE' : 'WARDROBE',
      );
    }
    const quality = JSON.parse(
      atob(response.headers.get('x-sponsor-quality') || ''),
    ) as {
      accepted?: boolean;
      audioVerified?: boolean;
      frames?: number;
      durationMs?: number;
      outputSha256?: string;
    };
    if (
      !quality.accepted ||
      !quality.audioVerified ||
      !quality.frames ||
      !quality.durationMs ||
      !quality.outputSha256?.match(/^[a-f0-9]{64}$/)
    )
      throw new SponsorError(
        422,
        'The wardrobe take did not supply verified timing.',
        'INVALID_WEARABLE',
      );
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 40 * 1024 * 1024)
      throw new SponsorError(413, 'The wardrobe take is too large.');
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== quality.outputSha256)
      throw new SponsorError(
        422,
        'The wardrobe video integrity check failed.',
        'INVALID_WEARABLE',
      );
    await resolveTrustedSponsor(request, v, reference);
    await v.SPONSOR_ASSETS.put(`${digest}/video.mp4`, bytes, {
      httpMetadata: { contentType: 'video/mp4' },
      customMetadata: {
        orderId: order.id,
        designId: order.draft.assetId!,
        quality: JSON.stringify(quality),
      },
    });
    return Response.json(
      {
        url: new URL(
          `/api/sponsorship/assets/${digest}?part=video`,
          v.SITE_URL || request.url,
        ).href,
        quality,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return sponsorFailure(e);
  }
}
