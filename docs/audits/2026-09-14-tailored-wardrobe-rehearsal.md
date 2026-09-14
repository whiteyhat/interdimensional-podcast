# Devnet rehearsal: the tailored tee and cap, end to end

Date: 2026-09-14 (00:05–01:30 CEST). Branch `codex/pump-launch-tooling` at `12946b5`
(a merge of `main` at `0943e7d` plus the tailored-wardrobe work). Site:
`https://interdimensional-podcast-staging.leonardo-chekup.workers.dev` deployed by the
"Deploy devnet" workflow (run 34786413791, green). Desk: `sponsor-media-devnet` on Railway,
image `f21d5a2d882f`. Payer: the devnet `viewer` wallet `8S2c…MLSz`, $1 per placement in SOL.

Every purchase below was made by `scripts/sponsorpay.mjs` (the stand-in studio that heartbeats
as the producer, uploads the logo, drafts, quotes, pays on devnet and waits for the look). The
logos are synthetic PNGs made for the rehearsal (a dark wordmark, a white mark, a three-colour
mark, an eight-letter wordmark), not customer files; Carlos's real logos are still to be tried.

## 1. The desk reports it can tailor

`node scripts/media.mjs setup devnet` put `FAL_KEY` and `SPONSOR_SITE_ORIGIN` on the service;
`node scripts/media.mjs deploy devnet media` built and shipped it. `/health`:

```text
ready: true, tailor: true, templateVersion: "looks-v1", decoder: "convert", version: "f21d5a2d882f"
```

`media.mjs health devnet` prints "Ready to tailor looks". Through the site,
`GET /api/sponsorship/assets` answers `{"ready":true,"tailor":true,"templateVersion":"looks-v1"}`.

## 2. The devnet catalog

Two placements on sale (the $5 message is off sale), both at 100 cents, SOL pinned at $150;
`capabilities.cap: true`. The workflow's price check was widened to accept two placements.
`capTemplateVersion` in the catalog is whatever the last studio heartbeated, so it reads
`looks-v1` only while a studio that advertises it is on air.

## 3. Eight looks, four logos on each host

| Host | Logo | Asset | Order | Look ready after | Fallback |
| --- | --- | --- | --- | --- | --- |
| Pepe | dark wordmark NORTHWIND | `012676d1…` | `4aa4fe23…` | 32 s | no |
| Pepe | white mark (circle-plus) | `d6b14613…` | `6fdd0b4d…` | 38 s | no |
| Pepe | three-colour mark TRIO | `87d3caa7…` | `5a75bbd9…` | 32 s | no |
| Pepe | eight-letter wordmark FROGCAST | `83cb9f86…` | `b6554d7b…` | 32 s | no |
| GigaChad | dark wordmark NORTHWIND | `adf2e134…` | `82d43e1e…` | 85 s | no |
| GigaChad | white mark (circle-plus) | `922dde33…` | `ca7c2235…` | 58 s | no |
| GigaChad | three-colour mark TRIO | `1af2d432…` | `99faebee…` | 37 s | no |
| GigaChad | eight-letter wordmark FROGCAST | `73c660e6…` | `3383cd25…` | 32 s | no |

Every purchase passed all 16 of the script's checks. Each look was reviewed by eye at
1344×768: the logo is printed large and legible on the chest, the cap carries the same mark on
its front panel in a colour taken from the logo (white cap with a black brim for the dark
wordmark, grey for the white mark and for FROGCAST, white for TRIO), the tee is in a colour
that contrasts with the print (grey, navy, purple, white), and the scene, pose, headphones,
lamp, microphone, poster, plant and mug are unchanged. The wordmarks were reproduced as text
in a similar typeface, not as the exact glyphs. The three-colour mark kept its colours and its
proportions on both hosts. 32 s is one fit; 58 s and 85 s were second fits.

## 4. On air: three minutes of box, one real take

The rehearsal box went on at 00:28 CEST with eleven paid cap orders queued. Carlos capped the
run at three minutes ("max 3 min, we must act cost efficient"), so it was taken off by hand at
00:31:38 while still warming up: `phase: buffering`, 10 s of footage, nothing aired, one
speech-check retry ("Incomplete speaker coverage for scripted speech"). A ten-minute airing
with six appearances, the intro and the callback was therefore not observed in this run; the
delivery counters stay at zero for every order. Note that `on --minutes N` does not shorten a
running window; only `off` does.

To show the look in motion at the cost of a single take, one dressed shot was generated the
way the studio does it (`shotInput()` from `lib/show.ts` with the NORTHWIND look as first and
last frame, `minimax/h3-max-turbo/image-to-video` on fal, 10 s at 768p, seed 78193): Pepe
speaks the line in the grey NORTHWIND tee and the white cap, the scene and headphones hold,
and the cap stays legible throughout. In one gesture his hand covers part of the chest print
for about a second, although the prompt asks for hands below the chest; across six
appearances the print reads clearly. The clip and every look are in the artifact
"Vestuario a medida en devnet" shared with Carlos.

## 5. A second purchase of the same logo reuses the look

Order `f0577628…` bought the NORTHWIND logo on Pepe again (`ASSET_ID=012676d1…`). The receipt
showed the look ready after 0 s, and the asset's tailor record afterwards was unchanged
(`round 1, outcome look, at 1789337957799`): the desk was not asked again. The order queued
behind the first NORTHWIND order on the same host.

## 6. Refusal, fallback and replacement

- **Refused at upload.** A 1×1 PNG posted to `/api/sponsorship/assets` answered
  `422 {"error":"Use artwork at least 8 pixels per side.","code":"LOGO_TOO_SMALL"}` at once;
  nothing was stored and no money moved.
- **Fallback.** A 900×600 photo of noise with twelve lines of fine text (asset `f2d3d8b6…`,
  order `2f37e5fb…` on Pepe) was accepted at upload, paid, and came back
  `ready (cap-v1 fallback) after 95 s`: the judge refused the generative fits and the
  deterministic cap print aired instead (Pepe in the plain blue tee, the noise patch baked into
  the blank cap's front panel). The receipt carries `look.fallback: "cap-v1"`, which the panel
  shows as "We'll keep improving the fit" with **Use a different logo**.
- **Replacement.** The same noisy photo on GigaChad (asset `2a456c80…`, order `0d7c33f1…`)
  came back `ready (cap-v1 fallback) after 80 s`. `scripts/sponsorpay.mjs` then did what the
  receipt's **Use a different logo** does: it uploaded the TRIO mark, posted
  `{ action: 'replaceLogo', orderId, token, assetId }`, and the site answered 200 with the
  order pointed at the new logo. Because that logo was already qualified on GigaChad, the
  replacement look was ready after 0 s with no fallback; the order kept its place in the queue
  (19 of 19 checks passed).

## 7. Production untouched

`https://frogclench.fun/api/sponsorship?catalog=1` still answers three products at
500/2500/10000 cents, all `available: false` with "Sponsorship checkout is not enabled."; the
only production deploys today were `main` pushes by the other session (`0943e7d` at 21:58
UTC). Nothing in this rehearsal touched the production worker, database or live input.

## What still needs a decision or a hand

- Carlos's real logos have not been through the tailor yet; the four synthetic ones have.
- The engine changes that keep one wardrobe per run (a refused take undresses the run-mate,
  a stale dressed take is dropped) live in the shared working tree with another session's
  engine rewrite and are not in this branch's HEAD yet; the box therefore aired with the
  committed engine.
- The working tree's `tests/launch-network.test.mjs` fails against uncommitted `lib/coin.ts`
  and `scripts/launch.mjs`; HEAD passes.
