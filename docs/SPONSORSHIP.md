# Sponsorship operations

The public sidebar sells Project spotlight ($25) and Dress the host ($100): the customer's logo printed on a T-shirt and a cap in the brand's colours, worn by Pepe or Chad for ten live minutes. Get on air, the $5 message, came off sale on 2026-09-13 because it read as a smaller spotlight: the site no longer lists it and the server refuses a new draft or a new charge for one, while an order already paid for one still airs. FROGCLENCH purchases cost exactly 70% of those USD prices. USDC is the default asset; SOL and FROGCLENCH require a fresh market price. Future mugs, audience debates, reactions, and scene packages remain outside checkout.

Checkout is **disabled by default**. The implementation and local rehearsal are complete; the live staging rehearsal and production rollout are separate remaining release gates. No production transfers or deployments were performed for this work.

## The wardrobe: promise and lifecycle

What a Dress the host order buys, and what the site does with it:

1. **Upload.** The customer picks Pepe or Chad, names the project, writes the message and uploads a logo (PNG, JPG or WebP, ≤ 4 MB). The site checks size and magic bytes, then forwards the bytes to the media desk's `POST /logo`, which normalises the logo (background knocked out, ≤ 1024 px on the long side, RGBA PNG) and reads its ink palette. A logo the desk can never print (empty, hair-thin, undecodable) is refused with the desk's reason under the upload field, before any money moves; nothing is stored. An accepted logo becomes a `sponsor_assets` row with `status = 'logo'`, one row per (normalised logo, host), shared by every order that buys that logo on that host. No look is generated before payment; the card shows an example look from a real order (Northwind's tee and cap on the chosen host, `public/looks/`) marked EXAMPLE, with the uploaded logo as a swatch.
2. **Payment.** The moment a payment settles, the site asks the desk to tailor (`POST /tailor`, round 1). The desk makes the look: one 1344×768 still of the host in a T-shirt with the logo printed large on the chest and a cap in the brand's colours, generated with fal from the host's uncropped original, judged by a pixel-drift check and a vision judge, up to three fits inside a 210-second job. Every settlement calls the site back (`PUT /api/sponsorship/assets/{id}?part=look`) with an outcome: `look`, `refused`, `deadline`, `shutdown` or `error`.
3. **Receipt.** Usually one to two minutes after paying, the receipt shows the look under YOUR ON-AIR PASS. Until then the card reads TAILORING with the host's own still and the logo as a swatch, and the copy follows the payment clock: "Tailoring your tee and cap · usually one to two minutes", past two minutes "Still tailoring — trying another fit", past ten minutes "This is taking longer than usual" with **Use a different logo**.
4. **On air.** The look is the start and end frame of every clip of that host while the sponsorship airs: ten live minutes, six clear appearances, an introduction and a callback. A take that cannot be dressed undresses that run of lines; the look returns at the next cut.
5. **Recovery.** The reconciler re-requests a round that has not landed after four minutes, up to three rounds the desk actually took: an answer that refuses the request (a desk that is full, unconfigured, down, or a request this site built wrong) never spends a round and never says anything about the logo, so a desk that was down does not end anybody's order. After three fits the judge refused, the desk falls back to the deterministic cap print (the logo baked into the blank cap's front panel) so the paid order airs; a job the queue starved or that fal never answered has judged nothing, so it reports `deadline` or `error` instead and the reconciler asks again; the receipt adds "We'll keep improving the fit" and offers a different logo, and one upgrade round is tried after ten minutes. Only a logo the fallback itself cannot print ends `refused`; the receipt says why and offers **Use a different logo** (`POST /api/sponsorship` with `{ action: 'replaceLogo', orderId, token, assetId }`, authenticated by the order token, allowed while the order is paid and its asset is refused, still `logo` after ten minutes, or a fallback look). That upload carries the receipt token in `x-sponsor-receipt`, which is what lets a buyer who has already paid change their logo even while checkout is closed; every other upload is refused until it is open. There are no refunds and the order is never lost.

Asset status moves `logo → qualified | refused`, and `refused → qualified` only through a replaced logo. `LOOK_VERSION = 'looks-v1'` is what the desk reports as `templateVersion`, what the studio heartbeats as `capTemplateVersion`, and what the lease gate compares. A round costs at most about $0.47 and an asset about $1.90 in the worst case, once per logo and host; a second order for the same logo shows the existing look at once and costs nothing to tailor.

## Services and configuration

| Service | Configuration | Purpose |
|---|---|---|
| Public Cloudflare Worker | D1 `DB`, R2 `SPONSOR_ASSETS`, `SITE_URL`, `SPONSOR_ENABLED` | Catalog, orders, receipts, uploads and payment endpoints |
| Payment RPC | `SOLANA_RPC_URL`, `TREASURY_WALLET`, `COIN_MINT`, optional `SPONSOR_USDC_MINT`, `JUPITER_API_KEY` | Chain verification and server-owned quotes |
| Clip producer | `STUDIO_TOKEN`, `STUDIO_ID`, `INTERACT_ORIGIN` | Exclusive delivery leases and actual playback evidence |
| Media service (`sponsor-media-<site>` on Railway) | `SPONSOR_MEDIA_TOKEN`, `FAL_KEY`, `SPONSOR_SITE_ORIGIN`, `MEDIA_CONCURRENCY`, `MEDIA_QUEUE`, `PORT`, optional `WEARABLE_PYTHON` | Normalize logos at upload; tailor and judge the look after payment; post it back to the site |
| Worker → media | `SPONSOR_MEDIA_URL`, matching `SPONSOR_MEDIA_TOKEN`, `SITE_URL` | Authenticated media service access |
| Reconciler (`sponsor-reconcile-<site>` on Railway) | `SPONSOR_ORIGIN`, `SPONSOR_RECONCILE_TOKEN` | Independent payment recovery and rescheduling |
| Worker ← reconciler | matching `SPONSOR_RECONCILE_TOKEN` | Accepts the reconciler's passes |

Use distinct D1, R2, RPC and signer configuration for staging. Set the build-time `SPONSOR_ASSETS_BUCKET` to that environment's R2 bucket, alongside `D1_DATABASE_NAME` and `D1_DATABASE_ID`. Create the bucket before deploying the generated Worker configuration. Both deploy workflows check the built binding: Deploy devnet refuses a build whose `SPONSOR_ASSETS` is not the `DEVNET_SPONSOR_ASSETS_BUCKET` repository variable (or is `pepe-chad-sponsor-assets`), and the production deploy refuses anything but `pepe-chad-sponsor-assets`. Without the check, an unset variable silently falls back to the production bucket. Apply migrations `0001_requests.sql`, `0002_sponsorship.sql`, and `0003_legacy_payment_recovery.sql` in order; databases from earlier local previews also receive additive columns on startup. Existing request IDs and receipt references are preserved.

**There are no refunds.** Every placement is final once paid, and nothing in the service holds a signing key or a reserve to send money back. The buyer pays the checkout network fee. A paused placement keeps its verified progress and resumes in the next live slot.

`SPONSOR_USDC_MINT` is for a staging test mint only. SOL/FROGCLENCH quotes use actual Jupiter prices; an unpriced devnet token correctly stays unavailable. Rehearse its missing-price state on devnet and use the deterministic injected-chain integration suite for its priced, exact-amount settlement cases. On devnet, `SPONSOR_FLAT_PRICE_CENTS` and `SPONSOR_SOL_USD` price every placement at a flat amount in pinned SOL, refused unless the RPC is devnet or local. Do not silently substitute a fixed price on a production deployment. A fully live test-token pricing fixture remains part of staging setup if all three assets must transact on devnet.

The producer discovers media readiness and advertises compatible products. Director mode does not advertise sponsorship delivery and cannot sell this catalog. Cap sales require a media desk that reports `tailor: true` and `templateVersion: looks-v1`, R2 storage, a live clip producer and payment readiness. A cap is always for sale: nothing about a host is ever reserved. Caps for one host air one at a time, in the order they were paid, so a second cap for the same host is accepted and waits its turn, and a paused cap (in its retry cooldown) does not hold the next one back. The catalog carries `capQueue`, the number of paid, unfinished caps per host a new buyer would wait behind (unpaid quotes are not counted, the buyer never sees them), and a paid cap's receipt says how many caps on its host go on before it. A late discovered payment remains a recorded obligation and joins the same line.

Legacy requests and sponsorships share one atomic producer lease in the existing `meta.studio_id` row. Either queue renews its 60-second ownership window; each keeps a separate readiness heartbeat, so legacy polling cannot keep unavailable sponsorship products on sale. Both APIs normalize studio names identically. Keep `STUDIO_ID` distinct between the hosted producer and any local producer.

## The media and reconciliation services

Each site has its own pair of services on Railway, in the broadcast box's project. Neither is part of the broadcast container, and neither receives a payment key.

| Site | Media service | Reconciler | Origin both are given |
|---|---|---|---|
| devnet | `sponsor-media-devnet` | `sponsor-reconcile-devnet` | `https://interdimensional-podcast-staging.leonardo-chekup.workers.dev` |
| production | `sponsor-media-production` | `sponsor-reconcile-production` | `https://frogclench.fun` |

`node scripts/media.mjs setup|deploy|status|health <devnet|production>` creates, configures, deploys and checks both; [the launch runbook](LAUNCH.md#sponsorship-services) has the steps. The script finds each service by name and never reuses the broadcast box's ids. Each service's settings live in its own file (`broadcast/railway.sponsor-media.json`, `broadcast/railway.sponsor-reconcile.json`). Railway no longer lets a service point at such a file, so setup writes the file's Dockerfile path and deploy settings onto the service itself, and the upload never carries the repository's `railway.json`, which describes the box. It uploads only the files each Dockerfile copies: about 2.6 MB for the media service and three files for the reconciler. It merges variables into a service and never replaces them.

Settings on each side:

| Where | Setting | Value |
|---|---|---|
| Media service | `SPONSOR_MEDIA_TOKEN` | 64 hex characters, generated once by `setup` and kept in `.dev.vars` as `SPONSOR_MEDIA_TOKEN_<SITE>` (the service requires 24 or more) |
| | `SPONSOR_SITE_ORIGIN` | Required. The site's origin: the desk fetches the stored logo from it and posts the finished look back to it, and refuses a `/tailor` whose logo URL is anywhere else |
| | `FAL_KEY` | The desk's own fal key for tailoring; `setup` copies it from `.dev.vars`. The Worker never holds one |
| | `MEDIA_CONCURRENCY`, `MEDIA_QUEUE` | `2` renders at once, `6` waiting |
| | `PORT`, `SPONSOR_MEDIA_PORT` | `4017`. The service listens on it, and Railway's healthcheck and public address both aim at it |
| Reconciler | `SPONSOR_ORIGIN` | The site's origin |
| | `SPONSOR_RECONCILE_TOKEN` | 64 hex characters, generated once by `setup` and kept as `SPONSOR_RECONCILE_TOKEN_<SITE>` |
| Worker | `SPONSOR_MEDIA_URL` | The media service's `https://…up.railway.app` address |
| | `SPONSOR_MEDIA_TOKEN` | The media service's token |
| | `SPONSOR_RECONCILE_TOKEN` | The reconciler's token (the worker requires 16 or more characters) |
| | `SITE_URL` | The site's public origin. Rendered takes and stored artwork are addressed from it |

The media service's settings set a `/health` healthcheck with a 120-second timeout, always restarts, never sleeps, keeps one replica, and gives a replaced deployment 120 seconds (`drainingSeconds`) before it is killed. The service uses that window to drain. On SIGTERM it stops taking work: `/health` answers 503, and a new or queued take is answered 503 `BUSY` with `retryAfterMs`, which the site retries on the replacement. Renders already running are takes someone paid for, so they finish, each by its own 95-second deadline, and their answers go out before the process exits. Whatever is left, it stops itself 105 seconds after the signal. The reconciler's have no healthcheck, because it has no HTTP port. It always restarts and never sleeps.

How the site uses the media service. The site sends `Authorization: Bearer <SPONSOR_MEDIA_TOKEN>` on every call and refuses redirects; only `/health` answers without the token:

- `GET /health` answers 200 only when the service is ready: a usable token, the Python/OpenCV/FFmpeg runtime, and a decoder that sees video the way the qualification did (see decoding, below). Otherwise it answers 503, so a build with a broken runtime or decoder fails Railway's healthcheck and the deployment it was meant to replace keeps serving. It answers from what the service measured at boot and never runs a probe itself, so it stays instant while renders load the CPU. A check that failed runs again in the background until it passes (the tools every 10 seconds, the decoder every 60); one that passed is not repeated, since neither can change inside a running container. The body says `starting: true` until the first measurements are in, and `draining: true` during shutdown. `templateVersion` is `looks-v1`, and `tailor` is true only when `FAL_KEY` and `SPONSOR_SITE_ORIGIN` are set and fal answered a HEAD within 5 seconds at boot without refusing the key (a 401 or 403 keeps the cap off sale and is probed again). The site asks at most once every 15 seconds per isolate, and the cap stays off sale unless it reads `tailor: true` with that version.
- `POST /logo?target=host|guest` takes the raw image (PNG, JPEG or WebP, 4 MiB at most) and answers within 10 seconds with the normalised RGBA PNG (base64), its SHA-256, its size and its ink palette. It is the only image codec in the system and costs nothing: no fal, no money. A logo that cannot be printed is 422 with a customer-readable code (`INVALID_IMAGE`, `EMPTY_IMAGE`, `LOGO_TOO_THIN`, `LOGO_TOO_SMALL`, `LOGO_TOO_LARGE`), which the site returns verbatim so the customer fixes the file before paying.
- `POST /tailor` takes `{ assetId, round, target, logoUrl, logoSha256, palette, projectName }`. `logoUrl` must be on `SPONSOR_SITE_ORIGIN` under `/api/sponsorship/assets/` (400 `HOST` otherwise); a body that is not JSON, a `palette` that is not the one `/logo` returned, a malformed `assetId`, `round` or `target`, or a `logoSha256` that is not hex64 are 400 `JSON | PALETTE | ASSET_ID | ROUND | TARGET | LOGO_HASH`; `round` is 1–3; without `SPONSOR_SITE_ORIGIN` and `FAL_KEY` it is 503 `TAILOR_UNAVAILABLE`. It answers 202 `{ key, queued: true }`, 200 `{ key, cached: true }` when a finished outcome for that key is in the ten-minute cache (the desk re-posts it to the site), or 409 `BUSY` with `retryAfterMs`. The key is the SHA-256 of `logoSha256|target|looks-v1|round`, so a new round uses new seeds and a repeat of an in-flight key joins the running job. Tailor jobs run in their own lane (`tailorConcurrency 2`, `tailorQueue 6`, `tailorDeadlineMs 210000`, `tailorFitMs 65000`); a fit starts only while a full fit budget remains, so a job settles inside its deadline by construction.
- The desk calls the site back itself, never a caller-supplied URL: `PUT ${SPONSOR_SITE_ORIGIN}/api/sponsorship/assets/${assetId}?part=look` with `Authorization: Bearer <SPONSOR_MEDIA_TOKEN>`, `x-look-round` and `x-look-outcome: look | refused | deadline | shutdown | error`. For `look` the body is the 1344×768 PNG with `x-look-sha256` and `x-look-verdict` (base64 JSON: model, fit, palette, garment plan, judge outputs, `candidateUrl`, `fallback?`); otherwise there is no body and `x-look-reason` says why. 20 seconds per attempt, three attempts, five seconds apart; on SIGTERM pending callbacks get 3 seconds. The site accepts `logo → qualified`, `logo → refused` and `refused → qualified`; a `qualified` asset never changes, except that a fallback look may be upgraded while no order on it is leased, prepared or playing. A `deadline`, `shutdown` or `error` outcome leaves the asset at `logo` for the reconciler to re-request.
- `POST /preview` and `POST /render` (the tracker composite) are still served but nothing calls them; they, their decoder probe and their tests are removed once the tailored path has aired on devnet.
- Decoding is part of the proof. OpenCV's bundled FFmpeg converts colour differently on Linux than on the Mac the caps were qualified on, which made real takes lose tracking in the container. At boot the service decodes a probe frame and compares it with the qualified result: it either decodes directly, or has FFmpeg convert each take with plain C arithmetic (`-cpuflags 0`), which reproduces the qualified decode bit for bit on arm64 and amd64. If neither matches, the service is not ready: `/health` answers 503 and `/render` refuses with 409 `NOT_QUALIFIED`, so the desk is never deployed on a machine that cannot decode the way the caps were qualified. The probe runs again every 60 seconds until it matches, so a probe that failed only because boot was slow heals without a restart.

`.github/workflows/media.yml` runs on every change to the service, renderer, templates or bridge. One job runs `tests/wearable-render.test.py` and the media tests with the exact OpenCV and NumPy the Dockerfile pins, and fails if any test skips. The other builds the image for linux/amd64 from exactly the files `deploy` uploads, then checks that `/health` is 200 with `templateVersion: looks-v1` (and `tailor: true` when the `FAL_KEY` secret is present), that `/logo` without the token is 401, and that `/logo` with it is 200.

To build and run the media image by hand:

```sh
docker build -f broadcast/Dockerfile.sponsor-media -t pepe-chad-sponsor-media .
```

The container pins Python 3.12, OpenCV 5.0.0.93 and NumPy 2.5.3. Use HTTPS between deployed services.

Reconciliation can also run by hand, independently of the studio:

```sh
node scripts/sponsor-reconcile.mjs --watch
```

The loop waits 60 seconds after each completed pass, uses a bounded HTTP request, and logs only counts/errors. A pass reads first and writes only for what has moved: an open quote, an expired quote still inside its day of grace (rechecked at most every ten minutes), a lapsed lease, a paused order whose cooldown is over, or stale rate-limit rows. A verified payment is never re-checked. An idle pass costs four reads and no writes, which matters on a database with a daily write allowance. Without `--watch`, it performs one pass for an external scheduler. Do not couple this process to studio polling or broadcast uptime.

## Delivery and recovery

The private `/?receipt=<capability>` URL survives reloads and wallet handoffs. Never publish receipt links. Solana Pay QR/mobile links contain a separate transaction-request capability. Each attempt freezes the `sponsorship-v1` product version, recipient, reference, asset, exact integer amount and conversion rate. Broadcast evidence and verified payment signatures occupy separate fields.

A frontend timer never cancels a possible on-chain payment. Recovery scans beyond failed reference transactions, retains incomplete scan cursors, and records duplicate or late payments for reconciliation. An ambiguous broadcast keeps the same signed transaction and attempt. A second transfer to an order that is already paid never buys a second placement; it stays recorded in `sponsor_payments` with `is_late=1`.

The studio console shows orders, active wardrobe and delivery failures. A placement completes from playback, never merely from successful generation. Caps start their ten-minute clock at the first verified appearance, accrue only healthy broadcast time, and need at least six clear appearances plus introduction and callback. Every clip of a dressed host starts and ends on the look; the look's revision is pinned into each render, a changed look drops the placement from that shot rather than retrying it, and a take that cannot be dressed undresses that run of lines until the next cut. Gestures are dropped on dressed lines. Paid dialogue, including wearable mentions and legacy requests, reserves at most one exchange per 120 seconds of program time.

On playback failure, the producer revokes the affected media, sends durable pause intents, and withholds lease renewal until invalidation is acknowledged. A delayed play promise cannot restart revoked media. Pauses can be acknowledged even after heartbeat expiry, with exact lease ownership still enforced. Unfinished orders automatically reschedule with a bounded retry policy; customers can also reschedule a paused placement themselves.

Inspect `sponsor_payments` with `is_late=1` during operations: each is money that arrived for an order already paid. There is no automatic return; any goodwill gesture is an operator decision made outside the service. Databases created before refunds were removed keep an unused `sponsor_refunds` table; nothing reads or writes it.

## Qualification and local verification

The tracker and its qualification now serve only the fallback: `scripts/wearable-render.py preview` bakes the logo into the blank cap's front panel when three generative fits fail, so a paid order still airs. Qualification is not a release gate for the tailored look, and nothing below needs to be repeated to ship it; it stays here for the fallback and until `/render` and `/preview` are removed.

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
- Message and four-turn spotlight playback, project cards, two caps bought for the same host airing one after the other, ten-minute completion, six appearances and both spoken mentions.
- Producer restart, stale heartbeat, stalled/decode-failed media, interrupted cap placement and rescheduling.
- Desktop/mobile, 320px reflow, keyboard checkout, reduced motion and long content on the deployed origin.

Use a rehearsal broadcast destination with no public simulcast targets. Production enablement follows these recorded results; this runbook does not deploy or enable anything automatically.
