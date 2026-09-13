# Tailored wardrobe: a sponsorship dresses the host in a tee and a cap made for the brand

Decided 2026-09-13 with Carlos: sponsorship = cap + T-shirt as one product at $100; the look is
tailored after payment. Revised the same day after a four-lens adversarial review (23 confirmed
findings folded in; the digest is in the session scratchpad `spec-review.md`).

## Why

The $100 "Sponsor the podcast" placement pastes the customer's logo into a small safe zone of
a pre-rendered blank cap, per clip, with an OpenCV tracker (`broadcast/sponsor-media.mjs` →
`scripts/wearable-render.py`). QA on devnet found the logo imperceptible — the tracker's safe
zone is ~105×54 px on Pepe and ~84×34 px on GigaChad, and the whole crown front is only about
230×85 px under a fixed headphone band, versus a ~545×285 px chest — the tracker refuses about
two thirds of real takes, and every dressed clip pays a 95–105 s media-desk round trip that
delays a paid order's arrival on air.

The deliverable is rebuilt around one still per logo and character: the character already
wearing a new T-shirt with the logo printed large on the chest and a cap in the brand's
colours, generated once, judged automatically, and used as the start and end frame of every
clip the character appears in while the sponsorship is on air. The show's clip contract
already takes that still: `lib/show.ts` `shotInput` sets `image_url` and `end_image_url` to
`wardrobe?.sourceUrl ?? character.source` on `minimax/h3-max-turbo/image-to-video`. Today that
URL is a static blank-cap template; after this change it is the look. No per-clip
compositing, no tracker, no safe zone.

## What the customer gets

1. Chooses Pepe or GigaChad, names the project, writes the message, uploads a logo (PNG, JPG
   or WebP, ≤ 4 MB). A logo that cannot be printed at all (empty, hair-thin, undecodable) is
   refused at upload, before any money moves. Pays $100 (or the FROGCLENCH price).
2. Usually one to two minutes after paying, the receipt shows their look: the character in a
   T-shirt with the logo printed large and centred on the chest, and a cap in the brand's
   colour with a small version of the mark on the front. That image is the "YOUR ON-AIR PASS"
   card; the tee is the readable print, the cap is the colour accent.
3. The sponsorship then airs as before: ten live minutes, six clear appearances, an
   introduction and a callback, with the character dressed in every clip of theirs. A take
   that cannot be dressed undresses that run of lines; the look returns at the next cut.
4. If the generative tailor fails three fits, the order still airs: the desk falls back to the
   deterministic cap print (logo on the blank cap's front panel, baked into the still) so the
   paid order is delivered, and the receipt offers "Use a different logo" for a better fit.
   Only a logo the fallback itself cannot print ends up `refused`, and that logo was already
   refused at upload. No refunds; the order is never lost.

## Vocabulary

- **Look** — the tailored 1344×768 PNG of one character wearing the tee and cap for one logo.
  Identified by its SHA-256. `LOOK_VERSION = 'looks-v1'` (exported from `lib/sponsorship.ts`;
  the desk keeps its own literal, pinned by a test).
- **Tailor** — the media desk job that makes and judges a look. A **fit** is one generative
  attempt inside a tailor job; a **round** is one tailor job for an asset.
- **Garment plan** — the colours chosen for tee and cap from the logo's ink palette.
- **Asset** — one `sponsor_assets` row per (normalised logo, character): id =
  `sha256(JSON.stringify([logoSha256, target, LOOK_VERSION]))`, shared by every order that
  buys that logo on that character.

## Components

### 1. The tailor (media desk, `broadcast/sponsor-media.mjs`, Railway, Node 22 + Python cv2)

The desk already runs a bounded job queue with deadlines, dedupe, `BUSY`/`retryAfterMs`,
drain on SIGTERM and a bearer token. Two new routes ride on it; nothing else in the desk
changes for them.

**1.1 `POST /logo`** (bearer, ≤ 4 MiB raw image body, `?target=host|guest`, synchronous,
≤ 10 s): the only image codec in the system. Runs `scripts/wardrobe.py normalize`:
decode PNG/JPEG/WebP with cv2; refuse with the existing customer-readable codes
(`INVALID_IMAGE`, `EMPTY_IMAGE`, `LOGO_TOO_THIN`, out of 8–4096 px) as 422; knock out the
background by alpha (alpha < 128 dropped), and when there is no alpha or the opaque border is
≥ 80 % one colour, flood-fill from the border every pixel within ΔE76 8 of the border colour
(border-connected only, so interior ink of that colour survives); fewer than 64 ink pixels →
`EMPTY_IMAGE`; scale to ≤ 1024 px on the long side; encode RGBA PNG. Then `palette` (same
script, same process): k-means in L\*a\*b\* over the ink pixels, k = min(5, distinct colours);
ink clusters = share ≥ 10 %; `{ clusters: [{hex, share}], primary, secondary, accent,
monochrome }` where `monochrome` = no ink cluster with chroma C\* ≥ 15. Reply
`{ logo: <base64 PNG>, logoSha256, width, height, palette }`. No fal, no money.

**1.2 `POST /tailor`** (bearer, JSON ≤ 16 KiB):

```json
{ "assetId": "<hex64>", "round": 1, "target": "host",
  "logoUrl": "https://<site>/api/sponsorship/assets/<assetId>?part=logo",
  "logoSha256": "<hex64>", "palette": { … }, "projectName": "Canvas" }
```

Validation before queueing: `assetId` hex64 (400 `ASSET_ID`); `round` 1–3; `logoUrl` passes
the existing `checkedUrl(raw, 'logo')` (origin = `SPONSOR_SITE_ORIGIN`, path under
`/api/sponsorship/assets/`, no credentials; 400 `HOST` otherwise); `SPONSOR_SITE_ORIGIN` and
`FAL_KEY` set (503 `TAILOR_UNAVAILABLE` otherwise). Reply `202 { key, queued: true }`,
`200 { key, cached: true }` when a finished outcome for that key is in the ten-minute cache
(the desk re-posts it to the site), or `409 BUSY` + `retryAfterMs`. Key =
`sha256(logoSha256|target|LOOK_VERSION|round)`; the per-fit seed base derives from the key,
so a new round truly uses new seeds. Repeats of an in-flight key join the running job.

The desk never takes a callback URL: it builds
`${SPONSOR_SITE_ORIGIN}/api/sponsorship/assets/${assetId}?part=look` itself.

**1.3 The job** runs in its own lane: `tailorDeadlineMs 210_000`, `tailorFitMs 65_000`
(fal submit + queue + download ≤ 40 s, judge ≤ 25 s), `tailorConcurrency 2`,
`tailorQueue 6`; `/render` keeps its 95 s lane untouched. A fit starts only while
`deadlineAt − now ≥ tailorFitMs`; the remaining 15 s cover fetch, palette reuse, fallback and
callback (3 × 65 + 15 = 210), so a job settles inside its deadline by construction.

1. Fetch the normalised logo from `logoUrl` (`redirect: 'error'`, 15 s), verify it hashes
   to `logoSha256`.
2. Garment plan (pure function, tested with a table). Inputs: ink clusters, the wearer's
   colours (Pepe: head green, headphone black; Chad: hair/beard black, skin tan, headphone
   black — defined next to the wardrobe zones from the base stills), neutrals off-white
   `#F2EFE8`, charcoal `#23262B`, heather `#8B8F96`. Tee candidates in order: muted
   secondary, muted primary, off-white, charcoal, heather — first with ΔE76 ≥ 25 against
   every ink cluster. Cap candidates: primary, secondary, accent, charcoal, off-white,
   heather — first with ΔE76 ≥ 25 against every ink cluster, ≥ 20 against every wearer
   colour and ≥ 15 from the tee; dark neutral brim when the cap's L\* > 80. If nothing
   passes a list, the candidate with the largest minimum ΔE wins; the plan never refuses.
   The chosen ΔEs go into the verdict.
3. Fit (up to 3): `fal-ai/nano-banana-pro/edit`, `image_urls: [baseStillUrl, logoUrl]`,
   `aspect_ratio: '16:9'`, `resolution: '1K'`, `output_format: 'png'`, `seed`. The base still
   is the **uncropped 1376×768 original** (`videoFrames[target].originalUrl`, added to
   `lib/video-frames.ts` by `scripts/video-frames.mjs` from `character-assets.json`), so the
   model's 16:9 1K answer lines up pixel-for-pixel. Prompt (fixed template, snapshot-tested):
   scene, camera, lighting, pose, expression, headphones and background stay identical;
   replace the T-shirt with a `{shirtHex}` tee with the second image printed large and
   centred on the chest, reproduced exactly (shapes, colours, proportions); add a `{capHex}`
   baseball cap under the headphones with a small simplified version of the same mark
   centred on the front panel; no other lettering or logos anywhere.
   The fal client is written inside the desk (three hops: submit to `queue.fal.run`, status
   every 2 s, response; each `redirect: 'error'` with `AbortSignal.any([job signal,
   timeout])`; poll bounded by the fit budget, best-effort cancel on abort; the key only in
   the Authorization header, never logged; nothing written to stdout except through `log()`).
   `scripts/fal.mjs` is not imported (it prints dots to stdout and has no signal).
4. Geometry: the output must be exactly 1376×768 (`GEOMETRY` failure otherwise, never
   resized); centre-crop columns 16..1360 to 1344×768 — the same crop
   `scripts/video-frames.mjs` applies. No resampling anywhere in the tailor.
5. Deterministic judge (`scripts/wardrobe.py judge`, gross-failure veto only): per-pixel
   drift = mean of |ΔR|,|ΔG|,|ΔB| against the cropped base; outside the wardrobe zones
   (fixed rectangles per character, padded 24 px, the cap zone including the headphone
   band) drift ≤ 12 on ≥ 90 % of pixels and mean drift ≤ 6; every ink cluster with share
   ≥ 10 % present inside the torso zone. `pixelAgreement` and `meanDrift` are passed to the
   vision judge rather than refusing a 90–95 % result outright.
6. Vision judge (`openrouter/router/vision`, `google/gemini-2.5-flash`, temperature 0,
   ≤ 25 s, `image_urls: [baseStillUrl, logoUrl, candidateUrl]` where `candidateUrl` is fal's
   output URL): JSON `{ shirtLogo, logoFidelity 0-10, legibility 0-10 (both judged on the
   chest print only), capPresent, capColourMatchesPlan, capExtraText, identityUnchanged,
   sceneUnchanged, extraText }`. Pass = `shirtLogo && logoFidelity ≥ 7 && legibility ≥ 7 &&
   capPresent && !capExtraText && identityUnchanged && sceneUnchanged && !extraText`. Cap
   mark quality never refuses a fit. The judge text and `candidateUrl` are kept for audit.
7. Fallback after three failed fits: `scripts/wearable-render.py preview` against the
   caps-v1 manifest for the target (blank cap + logo in the front panel, identity matrix;
   an unmodified call into the qualification-bound renderer) → a still that airs with the
   logo baked into the cap. Pushed as a look with `fallback: 'cap-v1'` and the three failing
   verdicts; no judge. `refused` only when the fallback itself throws (a property of the
   logo bytes, already screened at upload).
8. Callback — every settlement, no exceptions: `PUT` to the constructed URL with
   `Authorization: Bearer <SPONSOR_MEDIA_TOKEN>`, `redirect: 'error'`, 20 s per attempt,
   3 attempts over 30 s; on SIGTERM `close()` awaits pending callbacks bounded to 3 s.
   Headers: `x-look-round`, `x-look-outcome: look | refused | deadline | shutdown | error`;
   for `look`: body = the 1344×768 PNG, `x-look-sha256`, `x-look-verdict` (base64 JSON:
   model, fit, palette, garment plan with ΔEs, judge outputs, `candidateUrl`, `fallback?`);
   for the others: no body, `x-look-reason`. Refusals and non-look outcomes are cached by
   key for the same ten minutes so a lost callback is recovered without a new job.

`/health` reports `templateVersion: LOOK_VERSION` (the value the studio heartbeats as
`capTemplateVersion` and the site compares in `leaseOrders` and the asset gate) and
`tailor: true|false` (true only when `FAL_KEY` and `SPONSOR_SITE_ORIGIN` are set and fal
answered a HEAD within 5 s at boot); `capQualified` leaves `/health`. The tracker's
`TEMPLATE_VERSION = 'caps-v1'` stays private to `/render` and `/preview` request validation
until they are deleted. Boot log prints `tailor`.

Files shipped: `scripts/wardrobe.py` (normalize + palette + judge, one file) is added to
`broadcast/Dockerfile.sponsor-media`'s COPY list and to `serviceVersion()`'s hash; a test
asserts every Python path the desk spawns appears in `uploadFiles('media')`. `FAL_KEY`
becomes a desk variable (`scripts/media.mjs setup` writes it; the Cloudflare Worker still
never holds it). Drain stays as is: `drainMs 100 s`, `SHUTDOWN_MS 105 s`, Railway
`drainingSeconds 120` — a deploy aborts a running tailor at 100 s, the `shutdown` callback is
the recovery signal and the site re-requests within a minute; ≤ $0.15 lost per collision.
Written into the Dockerfile comment.

Not touched: `scripts/wearable-render.py`, `scripts/wearable_panel.py`, `public/wearables/*`
(the fallback calls the renderer's `preview` mode as it is). `/render` and `/preview` stay but
nothing calls them; they and their tests are removed once the new path has aired on devnet.

### 2. The site (`lib/sponsor-assets.ts`, `lib/sponsor-server.ts`, `lib/sponsor-db.ts`)

**2.0 Asset gate.** `qualifiedSponsorAsset` (lib/sponsor-server.ts) takes a stage:

- `order` — used by `draft`, `quote` and `replaceLogo`: the row exists, `metadata.kind ===
  'cap'`, `metadata.target === draft.target`, `metadata.templateVersion === LOOK_VERSION`
  (and `=== caps.capTemplateVersion` when capabilities are passed), `status IN ('logo',
  'qualified')`. `refused` → 409 `ASSET` with the stored reason ("This logo could not be
  dressed. Use a different logo."). No `qualificationVersion` check anywhere any more; no
  `mime` check.
- `air` — used by `context` (every dressed shot), `pull`/lease resolve and `reschedule`:
  `order` plus `status === 'qualified'`, `metadata.look.sha256` present and equal to
  `metadata.sha256`, `metadata.sourceUrl` present. Returns the asset so `assetMetadata`
  carries `sourceUrl`/`sha256`/`templateVersion` for `decorate` and the route pin.
- `spotlight` assets keep today's `kind = 'logo'` rule. `lib/sponsorship.ts` draft error
  text becomes "Add your logo first."

**2.1 Upload** `POST /api/sponsorship/assets` (kind `cap`, target): same-origin and rate
limits as today; check size ≤ 4 MiB and PNG/JPEG/WebP magic bytes (no decoding on the
site); forward the raw bytes to the desk's `POST /logo` (10 s); a 422 from the desk is
returned verbatim (the customer fixes the file before paying; nothing stored); store the
normalised PNG as `${id}/logo.png`; insert `sponsor_assets` with `status: 'logo'`,
`url = /api/sponsorship/assets/{id}?part=logo` (NOT NULL column), `mime: 'image/png'`,
metadata `{ kind: 'cap', target, logoSha256, logoUrl, palette, templateVersion:
LOOK_VERSION }`. Response `{ id, status: 'logo', url, logoUrl }` (`url === logoUrl` until
the look lands). Desk unreachable → 503 "Artwork is not available right now; try again in a
minute", as today.

**2.2 Payment settles.** `settlePayment` returns `{ orderId, orderPaidNow }` where
`orderPaidNow = meta.changes === 1` on the order UPDATE of its existing batch (the test
fake's `batch` returns `meta.changes` per statement). `recoverAttempt` ORs `orderPaidNow`
across its three settle sites and, after the attempt bookkeeping UPDATE and still inside the
attempt lock, calls `requestTailor(d, v, orderId, 1)` exactly once when true. Late or
duplicate payments never trigger; nothing keys on `order.status === 'paid'`.
`requestTailor(d, v: SponsorMediaVars, orderId, round)`: `getOrder`; return unless
`product === 'cap'` with `assetId` and `target`; return unless the asset is `status =
'logo'` (a `qualified` asset is reused as is — the look is made once per asset; a later
order for the same logo shows the existing look immediately); write `metadata.tailor =
{ round, requestedAt }` (one UPDATE); POST `/tailor` with a 5 s timeout, `logoUrl`,
`logoSha256`, `palette`, `projectName`; on any throw or non-2xx (missing config, 409 BUSY,
network) `console.warn('[sponsorship] tailor deferred', …)` and return — it never rethrows,
so the confirm response and the reconciler's counters are unchanged by the desk. A non-409
4xx from `/tailor` (bad hash, host) sets `status: 'refused'` with the reason at once.
`SponsorMediaVars` is defined in `lib/sponsor-server.ts` (re-exported by
`lib/sponsor-assets.ts`) and `recoverAttempt`, `quote`, `handleSponsorship`,
`reconcileSponsorships` and the two route casts widen to it.

**2.3 Look callback** `PUT /api/sponsorship/assets/{id}?part=look`: accept only when
`v.SPONSOR_MEDIA_TOKEN` is set and `sameSponsorToken(bearer, v.SPONSOR_MEDIA_TOKEN)` — 401
otherwise; body via `readBounded(8 MiB)`; `x-look-sha256` hex64 and equal to the body hash
(400 otherwise). Allowed transitions: `logo → qualified`, `logo → refused`,
`refused → qualified`; a `qualified` asset never changes (200 no-op, logged
`look-superseded`, R2 and metadata untouched; `x-look-outcome: refused` never downgrades it).
On `look`: store `${id}/look-<sha256>.png`; one UPDATE sets `status: 'qualified'`,
`url = <look URL>`, metadata `look: { sha256, model, fit, round, verdict, fallback? }`,
`sourceUrl: <look URL>`, `sha256: <look sha256>`, `tailor.outcome: 'look'`, `tailor.at`.
On `refused`: `status: 'refused'`, `metadata.reason`, `tailor: { round, outcome, at,
reasons: [...appended] }`. On `deadline | shutdown | error`: status stays `logo`,
`tailor.outcome/at` recorded (not a verdict on the logo; the customer never sees "did not
print"). Idempotent per sha256 and per round.

**2.4 Reconciler** (`reconcileSponsorships`, reads-first; an idle probe writes nothing). One
added read, bounded to 5 rows:

- `status = 'logo' AND tailor.round < 3 AND coalesce(tailor.at, tailor.requestedAt,
  MAX(o.paid_at, a.created_at)) < now − 4 min` → `requestTailor(round + 1)`. Four minutes
  exceeds the 210 s deadline, so the probe never relies on in-flight dedupe. When the third
  round also fails to land a look, the probe sets `status: 'refused'` with "We couldn't
  finish tailoring this logo. A different logo is tailored right away." (one UPDATE).
- `look.fallback` set AND `tailor.round < 2` AND `tailor.at < now − 10 min` AND every order
  on the asset is still `paid` → one upgrade round; a passing fit replaces the look, a
  failing one leaves the fallback. (The callback's no-op rule for `qualified` is relaxed for
  this one case: an upgrade may replace a `fallback` look while no order on the asset is
  `leased`/`prepared`/`playing`.)
- `refused` is re-tailored zero times; the only exit is 2.7.

The probe's non-empty result joins the idle short-circuit.

**2.5 Lease gate**: `leaseOrders` keeps `a.status = 'qualified' AND
json_extract(a.metadata,'$.templateVersion') = ?` bound to the heartbeat's
`capTemplateVersion`, which is `looks-v1` once the desk reports it. `capQueue`/`capAhead`
unchanged. Health plumbing: `MediaHealth` gains `tailor: boolean`; `healthFrom` keeps it,
`notReady()` sets it false; the heartbeat sends `cap: health.ready === true &&
health.tailor === true` and `capTemplateVersion: health.templateVersion` unchanged.
`scripts/sponsorpay.mjs` gates on `health.tailor`; `scripts/media.mjs health` prints "Ready
to tailor looks" / "Up, but FAL_KEY is missing or fal did not answer, so the cap stays off
sale"; `.github/workflows/media.yml` gates on `ready && templateVersion === 'looks-v1'` (and
`tailor` when the `FAL_KEY` secret is present).

**2.6 Serving** (`readSponsorAsset`): `?part=look&v=<sha256>` serves `${id}/look-<sha256>.png`
and `?part=logo` serves `${id}/logo.png`, both `public,max-age=31536000,immutable`, CORS `*`
(fal fetches both). A bare `GET …/assets/{id}` with an image accept answers `302` to the look
URL when `qualified`, else to the logo URL, with `cache-control: no-store`; with
`accept: application/json` it returns `{ status, url, lookUrl?, reason?, tailor? }`. The
`preview` part and fallback are deleted.

**2.7 Replace the logo after payment**: `POST /api/sponsorship` `{ action: 'replaceLogo',
orderId, token, assetId }` — order-token authenticated; allowed while the order is `paid`
and its asset is `refused`, `logo` for more than 10 minutes, or `qualified` with
`look.fallback`; the new asset must pass the `order` gate for the same target; sets
`draft.assetId` and calls `requestTailor(round 1)` (a fresh asset starts its rounds fresh;
the same logo re-uploaded maps to the same id and resets `metadata.tailor`). The receipt
exposes it as "Use a different logo".

**2.8 Receipt** (`sponsorReceipt`): `assetUrl` stays and equals `asset.url` (logo URL while
tailoring, look URL once ready); adds `look: { status: 'tailoring' | 'ready' | 'refused',
url?, reason?, fallback?, round? }` for cap orders.

D1: no new columns; `sponsor_assets.status` uses `logo | qualified | refused`; `metadata`
carries `palette`, `look` and `tailor`. `sponsor_orders` unchanged.

### 3. The show (`lib/show.ts`, `lib/services.ts`, `lib/engine.ts`, `lib/sponsor-program.ts`, route)

- `shotInput`: for a dressed line both frames are the look (already); the prompt suffix
  becomes "Keep the cap and the printed T-shirt exactly as in the reference: no new
  lettering, logos or accessories. Hands stay below the chest so the print stays visible.
  Headphones keep their exact placement; the camera stays fixed." Gesture is still dropped
  on dressed lines.
- `lib/services.ts`: the cap-only branch (skip the fal scaler, POST `/api/sponsorship/media`,
  direct R2 download, `wardrobeRetries`, `WearableError`) is removed; a dressed clip is
  scaled and audited like any other clip. `lib/sponsor-media.ts` (`renderSponsorMedia`) and
  `app/api/sponsorship/media/route.ts` are retired with their tests.
- Route wardrobe pinning (`app/api/podcast/route.ts` ~343-362) compares the line's wardrobe
  with the asset's `sourceUrl`, `sha256` and `templateVersion`; on mismatch it throws
  `new SponsorError(409, 'The wardrobe revision does not match this purchased cap.',
  'ASSET')` so a changed look takes the `PlacementLostError` path (one undressed retake, one
  strike) instead of four timed retries per line.
- **One wardrobe per run.** A host's wardrobe changes only at a cut. `SponsorProgram` gains
  `undressed(orderId, shotId)`: after a terminal dressed failure the engine calls it;
  `decorate` skips dressing that order's target while `previousSpeaker === line.speaker` and
  `line.id > undressedShot`; the note clears at the first cut for that target and on a
  played appearance in `ended`, next to `strikes`. `Engine.rejectPlacement` for a wardrobe
  line also undresses its run-mate: a slot still in `state.slots` adjacent to the failed
  slot with the same speaker and the same order's wardrobe is released and re-rendered
  undressed with a fresh attempt count (at most one extra render; a run never exceeds two
  turns). When the run's earlier line already aired dressed, the engine logs
  `diagnose('wardrobe-flip')` so devnet rehearsal can count flips; a continuity cutaway
  before the retake is a follow-up, not part of this change.
- The writer is told about both garments where it reads them; `SponsorBrief` stays a data
  struct with no garment field. `lib/sponsor-writer.ts`: `placementLine` intro "This is the
  introduction of {project}'s tee and cap on {wearer}; the first cut to {wearer} shows the
  logo printed on his T-shirt and cap.", callback "the callback for {project}'s tee and cap
  on {wearer}"; `obligations` duties "Mention the {project} tee and cap you are wearing." /
  "Mention the {project} tee and cap {wearer} is wearing."; `judgePrompt` TASK 1 allowance
  "including the tee and cap he is wearing and how they feel", TASK 2 "its pitch or the tee
  and cap". `lib/show.ts` `sponsorshipRules`: "A wardrobe introduction names its sponsor and
  the host wearing its tee and cap; a callback names the same sponsor again naturally."
  `checkSponsoredDialogue` and its labels are unchanged.

Paid → on air gets faster: no 95–105 s composite per clip and no `TRACK_LOST` retakes; one
fit takes ~60–90 s (up to three inside the 210 s job) and runs while the order is anyway
waiting for its lease and the 120 s paid-exchange spacing.

### 4. Product and UI

- Product id stays `cap`. Copy (`lib/sponsor-client.ts` `productCopy.cap`, panel `LINES`):
  title "Dress the host", card line "Your logo on the tee, a cap in your colours",
  description "Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad
  for 10 live minutes. Six clear appearances, an introduction and a callback." Badge "Most
  value". Price $100 unchanged.
- Panel, before payment: pick the character → upload the logo (the upload handler requires
  `id` and `logoUrl`; the `artwork` state and the reload rebuild go away — the swatch is
  derived from `draft.assetId` as `?part=logo`) → the PLACEMENT PREVIEW card shows the
  character's base still with the logo as a swatch and the caption "Your tee and cap are
  tailored right after payment · usually one to two minutes". An upload the desk refuses
  shows the reason under the upload field. No look is generated before payment.
- Receipt, after payment, sub-states driven client-side from `paidAt`: 0–120 s "Tailoring
  your tee and cap · usually one to two minutes" (ambient pulse on the card, label
  TAILORING); past 120 s "Still tailoring — trying another fit"; past 10 min "This is taking
  longer than usual" with "Use a different logo" shown. When `look.status === 'ready'` the
  look fades in (Premium personality: 400 ms, `cubic-bezier(0.4, 0, 0.2, 1)`, 12 px rise,
  shadow 50 ms behind), label "YOUR ON-AIR PASS", alt "{Host} wearing your tee and cap"; a
  `fallback` look adds "We'll keep improving the fit" and the same control. Card image
  precedence for cap orders: `receipt.look.url` when ready, otherwise the base still with
  the swatch — never `assetUrl` or the local upload artwork. Then the existing stages (queue,
  preparing, on air, delivered). Motion work invokes the motion-design skill first.
- Docs: `docs/SPONSORSHIP.md` (promise, lifecycle, media contract → `/logo` + `/tailor`,
  `SPONSOR_SITE_ORIGIN` required), `docs/LAUNCH.md` (the desk needs `FAL_KEY`; the tracker
  qualification is no longer a release gate), `.dev.vars.example`, `README.md`.

## Error handling

| Where | Failure | Behaviour |
| --- | --- | --- |
| Upload | bad mime/size, desk 422 (undecodable, empty, hair-thin) | 4xx with the message; nothing stored; fixed before paying |
| Upload | desk unreachable | 503 "try again in a minute", as today |
| Draft / quote | asset `refused` | 409 with the tailor's reason under the upload field |
| Settle → tailor | desk unreachable / BUSY / not configured | warned; reconciler re-requests within 4 min |
| Settle → tailor | desk non-409 4xx | asset `refused` + reason; "Use a different logo" |
| Fit | fal error / hop timeout / GEOMETRY / judge fail | one failed fit; next seed within the job budget |
| Tailor | three fits fail | fallback cap-v1 look airs; upgrade round after 10 min; receipt offers a new logo |
| Tailor | fallback throws | `refused` + reason (logo bytes); "Use a different logo" |
| Tailor | deadline / shutdown / error | callback with the outcome; status stays `logo`; reconciler re-requests; ≤ $0.15 lost |
| Callback | site unreachable | desk retries 3×; outcome cached 10 min; reconciler re-requests |
| Pull / lease | asset `logo`/`refused` or heartbeat version mismatch | 409 `ASSET`; order stays `paid`; queue copy unchanged |
| Clip | dressed take fails audit | run undressed at once (one wardrobe per run); look returns at the next cut |
| Clip | route pin mismatch | 409 `ASSET` → `PlacementLostError` path |
| Look/logo URL | fal cannot fetch the site | generation error → existing retry; fal must reach the site origin (already true for `/wearables/*`) |

## Cost and limits

≤ 3 × $0.15 (nano-banana-pro 1K) + ≤ 3 judge calls (~$0.005) ≈ $0.47 per round; at most
three rounds for a stuck logo and one upgrade round for a fallback, so ≤ ~$1.90 per asset
worst case, once per logo and character; a second order for the same logo costs nothing.
Tailoring only after payment, so no unpaid generative exposure; upload validation is
deterministic and free.

## Tests

- Desk: `/logo` normalise/knock-out/palette on fixture logos (dark wordmark on transparent,
  white mark, colourful, opaque white box, 1-px junk → 422); garment-plan table (including
  monochrome and wearer-camouflage cases); prompt snapshot; `/tailor` validation
  (assetId, round, logoUrl host, 503 without origin/key), 202/200/409, key dedupe, own lane
  and deadline, fit budget arithmetic; fal client aborts mid-poll at the deadline (loopback
  stand-in counts GETs); geometry refusal; deterministic judge calibration on committed
  fixture pairs (pass set and fail set pinned by sha256); vision-judge threshold cases
  ("chest good, cap mark garbled" → pass; "cap carries letters" → fail; scene changed →
  fail); fallback path; every outcome calls back, callback lands only on
  `SPONSOR_SITE_ORIGIN`, retries, close() bound; `/health.tailor` and `templateVersion`;
  the CLI stdout stays one JSON object per line through a tailor; every spawned Python path
  is in `uploadFiles('media')`.
- Site: upload stores the normalised PNG and returns `logo` with `url === logoUrl`; desk
  422 is relayed and nothing is stored; asset gate `order` accepts `logo`/`qualified`,
  refuses `refused` with reason, and `air` refuses `logo` even when leased by hand; confirm
  on a cap order makes exactly one `/tailor` POST (with `metadata.tailor` written), a second
  confirm and a late payment make none, no media vars → 200 + warning; a second paid order
  for the same logo makes no `/tailor` call and its receipt reads `ready`; callback: 401
  without/with wrong token or unset var, bad hash 400, transitions table, `qualified`
  never replaced (except the fallback upgrade rule), `url` rewritten to the look URL;
  reconciler probe: idle writes nothing, re-requests bounded with rounds, flips to
  `refused` after round 3, upgrade rule; lease refuses `logo`/`refused`; `?part=look&v=` and
  `?part=logo` serving, bare GET 302 with no-store, JSON status; `replaceLogo`
  authorisation and effect; receipt `look` field. Move the live `ASSET` assertions from
  `tests/sponsor-render.test.mjs` into `tests/sponsorship-server.test.mjs` before retiring it.
- Show: `shotInput` dressed line uses the look for both frames with the new suffix and no
  gesture (`tests/video-render.test.mjs`); `lib/services.ts` scales dressed clips and never
  calls the media route (`tests/cap-render-source.test.mjs` rewritten); route pin mismatch
  is 409 `ASSET` and the engine undresses on the first failure; one wardrobe per run
  (`tests/sponsor-wardrobe.test.mjs`: failed dressed line → next same-host line undressed →
  dressed again after a guest line; a played appearance clears the note;
  `tests/engine.test.mjs`: a dressed slot's run-mate loses its wardrobe with exactly one
  extra render); writer wording (`tests/sponsor-writer.test.mjs` duty/placement cases; intro
  request carries "tee" and "cap" in the duty and placement line).
- Retired: `tests/sponsor-render.test.mjs`; the `/render`/`/preview` parts of
  `tests/sponsor-media.test.mjs` (queue/deadline/drain tests stay — they cover the shared
  machinery); fixtures in `tests/sponsor-heartbeat.test.mjs` and `tests/sponsor-assets.test.mjs`
  move from `caps-v1`/`capQualified` to `looks-v1`/`tailor`.
- Browser: sponsor-experience flow through payment to a receipt that shows the base still
  during tailoring and the look once ready (mock desk); reload during tailoring shows the
  still + swatch, not a broken image.

## Verification on devnet

1. `npm test`, `npx tsc --noEmit`, `npx oxlint` on touched files; Python suite for
   `scripts/wardrobe.py`.
2. `node scripts/media.mjs deploy` with `FAL_KEY` and `SPONSOR_SITE_ORIGIN` set on the desk;
   `/health` → `tailor: true`, `templateVersion: 'looks-v1'`.
3. Four logos (dark wordmark, light mark, colourful, an 8-letter text-only PNG) tailored for
   both hosts; each look reviewed by eye; the wordmark must pass on both hosts.
4. One real devnet purchase ($1 flat price); the receipt shows the look within ~90 s (single
   fit target); the rehearsal box airs the character dressed in every clip of theirs for ten
   minutes, six appearances, intro and callback; `wardrobe-flip` count is zero or explained.
5. A second purchase of the same logo shows the look immediately and makes no tailor call.
6. A junk logo (1 px) is refused at upload; a hard logo that fails three fits airs with the
   fallback and the receipt offers "Use a different logo"; the replacement airs.
7. Production untouched: `SPONSOR_ENABLED` off; catalog still 500/2500/10000.

## Out of scope

Pre-payment look previews; a continuity cutaway before an undressed retake; a second
garment style per character; migrating `caps-v1` orders (devnet test orders only, retired);
removing the tracker files and `/render`/`/preview` from the media image (a follow-up once
the new path has aired on devnet).
