# Sponsorship operations

The public sidebar now supports Get on air ($5), Project spotlight ($25), and a cap on Pepe or Chad ($100). FROGCLENCH purchases cost exactly 70% of those USD prices. USDC is the default asset; SOL and FROGCLENCH require a fresh market price. Future mugs, audience debates, reactions, and scene packages remain outside checkout.

Checkout is **disabled by default**. The implementation and local rehearsal are complete; the live staging rehearsal and production rollout are separate remaining release gates. No production transfers or deployments were performed for this work.

## Services and configuration

| Service | Configuration | Purpose |
|---|---|---|
| Public Cloudflare Worker | D1 `DB`, R2 `SPONSOR_ASSETS`, `SITE_URL`, `SPONSOR_ENABLED` | Catalog, orders, receipts, uploads and payment endpoints |
| Payment RPC | `SOLANA_RPC_URL`, `TREASURY_WALLET`, `COIN_MINT`, optional `SPONSOR_USDC_MINT`, `JUPITER_API_KEY` | Chain verification and server-owned quotes |
| Clip producer | `STUDIO_TOKEN`, `STUDIO_ID`, `INTERACT_ORIGIN` | Exclusive delivery leases and actual playback evidence |
| CPU media worker | `SPONSOR_MEDIA_TOKEN`, `SPONSOR_SITE_ORIGIN`, optional `WEARABLE_PYTHON` | Normalize logos, preview caps and validate/composite footage |
| Worker → media | `SPONSOR_MEDIA_URL`, matching `SPONSOR_MEDIA_TOKEN` | Authenticated media service access |
| Reconciliation service | `SPONSOR_ORIGIN`, `SPONSOR_RECONCILE_TOKEN` | Independent payment recovery and rescheduling |

Use distinct D1, R2, RPC and signer configuration for staging. Set the build-time `SPONSOR_ASSETS_BUCKET` to that environment's R2 bucket, alongside `D1_DATABASE_NAME` and `D1_DATABASE_ID`. Create the bucket before deploying the generated Worker configuration. Apply migrations `0001_requests.sql`, `0002_sponsorship.sql`, and `0003_legacy_payment_recovery.sql` in order; databases from earlier local previews also receive additive columns on startup. Existing request IDs and receipt references are preserved.

**There are no refunds.** Every placement is final once paid, and nothing in the service holds a signing key or a reserve to send money back. The buyer pays the checkout network fee. A paused placement keeps its verified progress and resumes in the next live slot.

`SPONSOR_USDC_MINT` is for a staging test mint only. SOL/FROGCLENCH quotes use actual Jupiter prices; an unpriced devnet token correctly stays unavailable. Rehearse its missing-price state on devnet and use the deterministic injected-chain integration suite for its priced, exact-amount settlement cases. On devnet, `SPONSOR_FLAT_PRICE_CENTS` and `SPONSOR_SOL_USD` price every placement at a flat amount in pinned SOL, refused unless the RPC is devnet or local. Do not silently substitute a fixed price on a production deployment. A fully live test-token pricing fixture remains part of staging setup if all three assets must transact on devnet.

The producer discovers media readiness and advertises compatible products. Director mode does not advertise sponsorship delivery and cannot sell this catalog. Cap sales require a qualified media worker, R2 storage, a live clip producer, payment readiness, and a free reservation for the selected host. There is one purchased or pending reservation per host. Existing attempts remain recoverable while inventory is full; a late discovered payment remains a recorded obligation and queues behind a newer reservation. Only one cap can air per host at a time.

Legacy requests and sponsorships share one atomic producer lease in the existing `meta.studio_id` row. Either queue renews its 60-second ownership window; each keeps a separate readiness heartbeat, so legacy polling cannot keep unavailable sponsorship products on sale. Both APIs normalize studio names identically. Keep `STUDIO_ID` distinct between the hosted producer and any local producer.

## Run the auxiliary services

The media service is independent of the broadcast container and receives no payment keys:

```sh
docker build -f broadcast/Dockerfile.sponsor-media -t pepe-chad-sponsor-media .
```

Configure `SPONSOR_MEDIA_TOKEN` (at least 24 characters) and `SPONSOR_SITE_ORIGIN` on that service. Its internal port is 4017; use HTTPS between deployed services. `/health` checks Python/OpenCV, FFmpeg, and the exact qualification artifacts. The container pins Python 3.12, OpenCV 5.0.0.93 and NumPy 2.5.3. The container image itself still needs a staging build and execution check.

Run reconciliation independently of the studio:

```sh
node scripts/sponsor-reconcile.mjs --watch
```

Or deploy `broadcast/Dockerfile.sponsor-reconcile` as an always-running service. The loop waits 20 seconds after each completed pass, uses a bounded HTTP request, and logs only counts/errors. Without `--watch`, it performs one pass for an external scheduler. Set the same `SPONSOR_RECONCILE_TOKEN` on the public Worker. Do not couple this process to studio polling or broadcast uptime.

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

Keep `SPONSOR_ENABLED=false` until the staging rehearsal below has passed. In that environment, build and run both service containers, apply migrations, and validate:

- Connected wallet and physical mobile QR handoff; rejection, insufficient token balance/SOL fees, slow confirmation, reload and duplicate submission.
- Exact amounts/discounts for all three assets, actual treasury accounts, missing prices, late payments and concurrent reconciliation.
- Message and four-turn spotlight playback, project cards, both cap inventory reservations, ten-minute completion, six appearances and both spoken mentions.
- Producer restart, stale heartbeat, stalled/decode-failed media, interrupted cap placement and rescheduling.
- Desktop/mobile, 320px reflow, keyboard checkout, reduced motion and long content on the deployed origin.

Use a rehearsal broadcast destination with no public simulcast targets. Production enablement follows these recorded results; this runbook does not deploy or enable anything automatically.
