# Sponsorship operations

The public sidebar now supports Get on air ($5), Project spotlight ($25), and a cap on Pepe or Chad ($100). FROGCLENCH purchases cost exactly 70% of those USD prices. USDC is the default asset; SOL and FROGCLENCH require a fresh market price. Future mugs, audience debates, reactions, and scene packages remain outside checkout.

Checkout is **disabled by default**. The implementation and local rehearsal are complete; the live staging rehearsal and production rollout are separate remaining release gates. No production transfers or deployments were performed for this work.

## Services and configuration

| Service | Configuration | Purpose |
|---|---|---|
| Public Cloudflare Worker | D1 `DB`, R2 `SPONSOR_ASSETS`, `SITE_URL`, `SPONSOR_ENABLED` | Catalog, orders, receipts, uploads and payment endpoints |
| Payment RPC | `SOLANA_RPC_URL`, `TREASURY_WALLET`, `COIN_MINT`, optional `SPONSOR_USDC_MINT`, `JUPITER_API_KEY` | Chain verification and server-owned quotes |
| Clip producer | `STUDIO_TOKEN`, `STUDIO_ID`, `INTERACT_ORIGIN` | Exclusive delivery leases and actual playback evidence |
| Media service (`sponsor-media-<site>` on Railway) | `SPONSOR_MEDIA_TOKEN`, `MEDIA_CONCURRENCY`, `MEDIA_QUEUE`, `PORT`, optional `SPONSOR_SITE_ORIGIN` and `WEARABLE_PYTHON` | Normalize logos, preview caps and validate/composite footage |
| Worker → media | `SPONSOR_MEDIA_URL`, matching `SPONSOR_MEDIA_TOKEN`, `SITE_URL` | Authenticated media service access |
| Reconciler (`sponsor-reconcile-<site>` on Railway) | `SPONSOR_ORIGIN`, `SPONSOR_RECONCILE_TOKEN` | Independent payment recovery and rescheduling |
| Worker ← reconciler | matching `SPONSOR_RECONCILE_TOKEN` | Accepts the reconciler's passes |

Use distinct D1, R2, RPC and signer configuration for staging. Set the build-time `SPONSOR_ASSETS_BUCKET` to that environment's R2 bucket, alongside `D1_DATABASE_NAME` and `D1_DATABASE_ID`. Create the bucket before deploying the generated Worker configuration. Both deploy workflows check the built binding: Deploy devnet refuses a build whose `SPONSOR_ASSETS` is not the `DEVNET_SPONSOR_ASSETS_BUCKET` repository variable (or is `pepe-chad-sponsor-assets`), and the production deploy refuses anything but `pepe-chad-sponsor-assets`. Without the check, an unset variable silently falls back to the production bucket. Apply migrations `0001_requests.sql`, `0002_sponsorship.sql`, and `0003_legacy_payment_recovery.sql` in order; databases from earlier local previews also receive additive columns on startup. Existing request IDs and receipt references are preserved.

**There are no refunds.** Every placement is final once paid, and nothing in the service holds a signing key or a reserve to send money back. The buyer pays the checkout network fee. A paused placement keeps its verified progress and resumes in the next live slot.

`SPONSOR_USDC_MINT` is for a staging test mint only. SOL/FROGCLENCH quotes use actual Jupiter prices; an unpriced devnet token correctly stays unavailable. Rehearse its missing-price state on devnet and use the deterministic injected-chain integration suite for its priced, exact-amount settlement cases. On devnet, `SPONSOR_FLAT_PRICE_CENTS` and `SPONSOR_SOL_USD` price every placement at a flat amount in pinned SOL, refused unless the RPC is devnet or local. Do not silently substitute a fixed price on a production deployment. A fully live test-token pricing fixture remains part of staging setup if all three assets must transact on devnet.

The producer discovers media readiness and advertises compatible products. Director mode does not advertise sponsorship delivery and cannot sell this catalog. Cap sales require a qualified media worker, R2 storage, a live clip producer, payment readiness, and a free reservation for the selected host. There is one purchased or pending reservation per host. Existing attempts remain recoverable while inventory is full; a late discovered payment remains a recorded obligation and queues behind a newer reservation. Only one cap can air per host at a time.

Legacy requests and sponsorships share one atomic producer lease in the existing `meta.studio_id` row. Either queue renews its 60-second ownership window; each keeps a separate readiness heartbeat, so legacy polling cannot keep unavailable sponsorship products on sale. Both APIs normalize studio names identically. Keep `STUDIO_ID` distinct between the hosted producer and any local producer.

## The media and reconciliation services

Each site has its own pair of services on Railway, in the broadcast box's project. Neither is part of the broadcast container, and neither receives a payment key.

| Site | Media service | Reconciler | Origin both are given |
|---|---|---|---|
| devnet | `sponsor-media-devnet` | `sponsor-reconcile-devnet` | `https://interdimensional-podcast-staging.leonardo-chekup.workers.dev` |
| production | `sponsor-media-production` | `sponsor-reconcile-production` | `https://frogclench.fun` |

`node scripts/media.mjs setup|deploy|status|health <devnet|production>` creates, configures, deploys and checks both; [the launch runbook](LAUNCH.md#sponsorship-services) has the steps. The script finds each service by name and never reuses the broadcast box's ids. It points each service at its own config file (`broadcast/railway.sponsor-media.json`, `broadcast/railway.sponsor-reconcile.json`), so the repository's `railway.json`, which describes the box, is never read for them. It uploads only the files each Dockerfile copies: about 2.6 MB for the media service and three files for the reconciler. It merges variables into a service and never replaces them.

Settings on each side:

| Where | Setting | Value |
|---|---|---|
| Media service | `SPONSOR_MEDIA_TOKEN` | 64 hex characters, generated once by `setup` and kept in `.dev.vars` as `SPONSOR_MEDIA_TOKEN_<SITE>` (the service requires 24 or more) |
| | `SPONSOR_SITE_ORIGIN` | Optional. The site's origin, needed only by the legacy `/render` form that names a logo URL instead of sending the logo |
| | `MEDIA_CONCURRENCY`, `MEDIA_QUEUE` | `2` renders at once, `6` waiting |
| | `PORT`, `SPONSOR_MEDIA_PORT` | `4017`. The service listens on it, and Railway's healthcheck and public address both aim at it |
| Reconciler | `SPONSOR_ORIGIN` | The site's origin |
| | `SPONSOR_RECONCILE_TOKEN` | 64 hex characters, generated once by `setup` and kept as `SPONSOR_RECONCILE_TOKEN_<SITE>` |
| Worker | `SPONSOR_MEDIA_URL` | The media service's `https://…up.railway.app` address |
| | `SPONSOR_MEDIA_TOKEN` | The media service's token |
| | `SPONSOR_RECONCILE_TOKEN` | The reconciler's token (the worker requires 16 or more characters) |
| | `SITE_URL` | The site's public origin. Rendered takes and stored artwork are addressed from it |

The media service's config file sets a `/health` healthcheck with a 120-second timeout, always restarts, never sleeps, keeps one replica, and gives a replaced deployment 120 seconds to finish in-flight renders before it is killed. The reconciler's config has no healthcheck, because it has no HTTP port. It always restarts and never sleeps.

How the site uses the media service. The site sends `Authorization: Bearer <SPONSOR_MEDIA_TOKEN>` on every call and refuses redirects; only `/health` answers without the token:

- `GET /health` answers 200 only when the service is ready (a usable token and the Python/OpenCV/FFmpeg runtime), and 503 otherwise. `capQualified` means the exact renderer, templates and masks the qualification proof binds are in place *and* this machine decodes video the way the proof did. The site asks at most once every 15 seconds per isolate, and the cap stays off sale unless it reads `capQualified: true`.
- `POST /preview?kind=cap|logo&target=host|guest` takes the uploaded image (4 MB at most). It returns the normalized logo, the cap composited on the host's template, and their hashes. The site stores both in R2.
- `POST /render` takes a JSON body: the fal clip URL, the buyer's logo itself (base64, read by the site from R2 and checked against the qualified hash), that hash, the host, the template version, and a key, the SHA-256 of `videoUrl|logoSha256|target|templateVersion`. The service rechecks the logo hash and the template's qualification, tracks and composites every frame, and returns the MP4 with an `x-sponsor-quality` header that summarizes the tracking and audio checks, including the output's hash. The site keeps the take only if the body matches that hash and the producer still holds the lease, and records it under the key in R2 so the same shot is never rendered twice. The service finishes or fails every render within 95 seconds and kills the renderer's whole process group on that deadline or when the caller hangs up. `MEDIA_CONCURRENCY` renders run at once and up to `MEDIA_QUEUE` wait; a render that cannot start in time is answered busy (503 `BUSY` with `retryAfterMs`), and the site retries once. A second request for a key already rendering joins it, and a finished key is served from a ten-minute cache.
- Decoding is part of the proof. OpenCV's bundled FFmpeg converts colour differently on Linux than on the Mac the caps were qualified on, which made real takes lose tracking in the container. At boot the service decodes a probe frame and compares it with the qualified result: it either decodes directly, or has FFmpeg convert each take with plain C arithmetic (`-cpuflags 0`), which reproduces the qualified decode bit for bit on arm64 and amd64. If neither matches, `capQualified` is false and `/render` refuses with 409 `NOT_QUALIFIED`, so a cap is never sold on a machine that cannot deliver it.

`.github/workflows/media.yml` runs on every change to the service, renderer, templates or bridge. One job runs `tests/wearable-render.test.py` and the media tests with the exact OpenCV and NumPy the Dockerfile pins, and fails if any test skips. The other builds the image for linux/amd64 from exactly the files `deploy` uploads, then checks that `/health` is 200 with `capQualified: true`, that `/preview` without the token is 401, and that `/preview` with it is 200.

To build and run the media image by hand:

```sh
docker build -f broadcast/Dockerfile.sponsor-media -t pepe-chad-sponsor-media .
```

The container pins Python 3.12, OpenCV 5.0.0.93 and NumPy 2.5.3. Use HTTPS between deployed services.

Reconciliation can also run by hand, independently of the studio:

```sh
node scripts/sponsor-reconcile.mjs --watch
```

The loop waits 20 seconds after each completed pass, uses a bounded HTTP request, and logs only counts/errors. Without `--watch`, it performs one pass for an external scheduler. Do not couple this process to studio polling or broadcast uptime.

## Delivery and recovery

The private `/?receipt=<capability>` URL survives reloads and wallet handoffs. Never publish receipt links. Solana Pay QR/mobile links contain a separate transaction-request capability. Each attempt freezes the `sponsorship-v1` product version, recipient, reference, asset, exact integer amount and conversion rate. Broadcast evidence and verified payment signatures occupy separate fields.

A frontend timer never cancels a possible on-chain payment. Recovery scans beyond failed reference transactions, retains incomplete scan cursors, and records duplicate or late payments for reconciliation. An ambiguous broadcast keeps the same signed transaction and attempt. A second transfer to an order that is already paid never buys a second placement; it stays recorded in `sponsor_payments` with `is_late=1`.

The studio console shows orders, active wardrobe and delivery failures. A placement completes from playback, never merely from successful generation. Caps start their ten-minute clock at the first verified appearance, accrue only healthy broadcast time, and need at least six clear appearances plus introduction and callback. The wardrobe revision is pinned into each render/cache identity; gestures that obstruct the cap are deferred. Paid dialogue, including wearable mentions and legacy requests, reserves at most one exchange per 120 seconds of program time.

On playback failure, the producer revokes the affected media, sends durable pause intents, and withholds lease renewal until invalidation is acknowledged. A delayed play promise cannot restart revoked media. Pauses can be acknowledged even after heartbeat expiry, with exact lease ownership still enforced. Unfinished orders automatically reschedule with a bounded retry policy; customers can also reschedule a paused placement themselves.

Inspect `sponsor_payments` with `is_late=1` during operations: each is money that arrived for an order already paid. There is no automatic return; any goodwill gesture is an operator decision made outside the service. Databases created before refunds were removed keep an unused `sponsor_refunds` table; nothing reads or writes it.

## Qualification and local verification

The qualification proof is [caps-v1-qualification.json](../public/wearables/caps-v1-qualification.json). It binds renderer hashes, exact manifests, masks, images, graphic/text trials and the real rejected occlusion sample. Changing any qualified artifact closes paid cap eligibility until qualification is repeated. The runtime also validates every frame of every purchased take; uncertain tracking never falls back to a guessed transform. Accepted composition copies audio packets and checks their hashes/timestamps, video duration, frame count and timing.

Prepare the local computer-vision dependencies once:

```sh
python3.12 -m venv work/vision-venv
work/vision-venv/bin/python -m pip install opencv-python-headless==5.0.0.93 numpy==2.5.3
```

FFmpeg and ffprobe must be on PATH. `WEARABLE_PYTHON` can select another equivalent environment. Then run:

```sh
npm test
npx tsc --noEmit
work/vision-venv/bin/python tests/wearable-render.test.py
npm run build
```

The existing real-footage trial artifacts remain in `work/wearable-qualification/`. Re-audit them with `work/vision-venv/bin/python scripts/qualify-wearables.py --visual-reviewed`; use `--finalize` only after reviewing the composited visuals. Do not run `scripts/wearable-qualify.mjs --run` casually: it buys four new ten-second provider clips. `--heldout --run` buys two more; `--retry-rejected --run` buys one bounded replacement for each failed held-out host. These commands generate trial sources, which must then be composited with both trial logos and audited before eligibility can reopen.

For the local UI rehearsal, start the app on port 3316 (or set `SPONSOR_TEST_ORIGIN`) and run:

```sh
node tests/browser/sponsor-experience.mjs
node tests/browser/sponsor-wallet-recovery.mjs
```

These use the real browser components with explicitly simulated wallets and payment responses; they send no chain transactions. Set `CHROME_PATH` outside macOS. `node tests/browser/serve.mjs` serves `/tests/browser/player-recovery.html` and `/tests/browser/player-audio.html` for real media decoder checks.

## Remaining staging release gate

Keep `SPONSOR_ENABLED=false` until the staging rehearsal below has passed. In that environment, deploy both services (`node scripts/media.mjs setup devnet`, `deploy devnet`, then `health devnet`), give the worker their four values, apply migrations, and validate:

- Connected wallet and physical mobile QR handoff; rejection, insufficient token balance/SOL fees, slow confirmation, reload and duplicate submission.
- Exact amounts/discounts for all three assets, actual treasury accounts, missing prices, late payments and concurrent reconciliation.
- Message and four-turn spotlight playback, project cards, both cap inventory reservations, ten-minute completion, six appearances and both spoken mentions.
- Producer restart, stale heartbeat, stalled/decode-failed media, interrupted cap placement and rescheduling.
- Desktop/mobile, 320px reflow, keyboard checkout, reduced motion and long content on the deployed origin.

Use a rehearsal broadcast destination with no public simulcast targets. Production enablement follows these recorded results; this runbook does not deploy or enable anything automatically.
