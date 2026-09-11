# Launch runbook

Two machines, three destinations, one coin. The studio generates the show on the operator's
Mac; the public site is a Cloudflare Worker; OBS pushes one stream to Cloudflare and
Cloudflare fans it out. Nothing generates video in production, ever.

```
/studio?broadcast=1&autostart=1  →  OBS or the box  →  Cloudflare Stream live input
                                                            ├── X Live Studio
                                                            ├── pump.fun coin page
                                                            └── the player on the public site
```

Two ways to make that first arrow. **The box** is a container on Railway running the studio, a
screen, a speaker, a browser and ffmpeg, so the show survives a closed laptop; it is the
default. **OBS on the Mac** still works, unchanged, and is the fallback when the box is down or
when you want to watch what you are broadcasting. Only one of them may be on air at a time,
and the site now enforces that rather than trusting you to remember.

## Accounts and one-time setup

| Thing | Where | Notes |
|---|---|---|
| Cloudflare account | `Buu` | The company account is not for this |
| D1 production | `pepe-chad-requests` | `b4a21bd4-5ba5-43f3-9f77-46c7745727f0` |
| D1 staging | `pepe-chad-requests-staging` | `6c07b691-cdbe-4681-82a8-4e14a7c85bcb` |
| Cloudflare Stream | Paid add-on | ~$5/mo minimum; live input costs ~$1/day |
| X | Premium, Live Studio | RTMP source, region nearest Cloudflare |

The API token needs **Account → Workers Scripts → Edit**, **Account → D1 → Edit**, and
**Account → Stream → Edit**. Put it in `.dev.vars` as `CF_STREAM_TOKEN`, and export it as
`CLOUDFLARE_API_TOKEN` alongside `CLOUDFLARE_ACCOUNT_ID` when running wrangler.

## Deploying the public site

`.env.production` carries the D1 id and is baked in at build time, so **a database change
needs a rebuild, not just a redeploy**.

```sh
npm test && npx tsc --noEmit          # never deploy red
npm run build
npm run deploy
```

Secrets, once each (`npx wrangler secret put NAME --config dist/server/wrangler.json`):

- `STUDIO_TOKEN` — 32 random bytes, the same value in the studio's `.dev.vars`
- `STREAM_EMBED_URL` — printed by `node scripts/stream.mjs create`
- `X_LIVE_URL` — the public link to the X broadcast
- `SOLANA_RPC_URL`, `CLIENT_RPC_URL` — a real provider. **Not the public Solana RPC:** both
  `api.mainnet-beta.solana.com` and `api.devnet.solana.com` return 403 Forbidden to Cloudflare
  Workers, which silently turns into "treasury not ready" and no price on the card. Confirmed
  against the deployed worker on both clusters. Helius is what we use.
- `COIN_MINT`, `TREASURY_WALLET` — **only once the coin exists**

**Never set `CLIENT_RPC_URL`.** The public config endpoint is unauthenticated, so whatever it
holds is served to every visitor; pointing it at a provider URL publishes the API key. Left
unset, the browser is handed this deployment's own `/api/rpc`, which proxies to the provider
with the key server-side and only forwards the calls a wallet needs to pay.

Never set on the deployed site: `FAL_KEY`, any `NEWSDESK_*`, `INTERACT_ORIGIN`, `CHART_MINT`.
Generation happens only in the studio, and a borrowed chart is never shown to the audience.

## Going on air, from the box

Once, per machine. Put a Railway workspace token from
[railway.com/account/tokens](https://railway.com/account/tokens) in `.dev.vars` as
`RAILWAY_TOKEN`, then:

```sh
node scripts/air.mjs setup --no-queue   # create the project, service, variables and URL
node scripts/air.mjs deploy             # upload the source and build the image
```

`setup` creates the Railway project and service if they do not exist yet and remembers their
ids in `.dev.vars`, the same way `stream.mjs` remembers the live input. It sends only the
variables the studio worker is allowed to see: `CF_ACCOUNT_ID`, `CF_STREAM_TOKEN` and
`CLIENT_RPC_URL` are refused by the allowlist in `broadcast/air-policy.mjs`, so the box cannot
publish a key it was never given.

`--no-queue` leaves `INTERACT_ORIGIN` off the box. Use it until you have watched a full
rehearsal: without it the box claims paid requests from the deployed site the moment it goes on
air, which opens the five-dollar seat to real viewers. Drop the flag and run `setup` again when
you want the box to carry the queue.

Note the scripts talk to Railway's API, not its CLI. A workspace token has no user attached, so
`railway login` and every CLI command reject it; the API accepts it for everything the box
needs. `node scripts/air.mjs logs` and `logs build` read the box's output without the CLI too.

Rehearse on an input nothing is simulcast from, so a first run cannot reach X or pump.fun:

```sh
node scripts/stream.mjs create rehearsal   # a second live input with no destinations
# put its uid in .dev.vars as AIR_RTMP_INPUT, then re-run setup
node scripts/air.mjs setup --no-queue
```

Clear `AIR_RTMP_INPUT` and run `setup` again to put the box back on the show's own input.

Then, per broadcast:

```sh
node scripts/air.mjs on            # on air; the first frame is ~90s away
node scripts/air.mjs status        # the box, the show, the encoder, and Cloudflare's ingest
node scripts/air.mjs frame         # save the picture currently going out
node scripts/air.mjs off           # off air; generation stops
```

The box refuses to go on air at all without a stream destination: generating a show nobody can
watch costs exactly as much as broadcasting one. It also refuses if it would answer to the same
`STUDIO_ID` as this machine, because two studios with one name is a guard that never fires.

The box goes off air on its own after `AIR_MAX_MINUTES` (24 hours by default). `air on
--minutes 720` sets a shorter run, and running it again while on air extends the deadline
without interrupting the show. It also stands down by itself if playback wedges twice in a row,
if the show stops itself, if the encoder cannot hold a connection, if the worker or the screen
dies, or if another studio takes the air — every one of those costs generation credits to keep
running blind. The end-of-broadcast stop runs on its own timer, so a page that stops answering
cannot defer it.

If the container restarts, for any reason, the box comes back **off air** and stays there. That
is deliberate: a box that restarts itself back into a paid broadcast is a box that can spend all
night on its own. Set `AIR_ALERT_WEBHOOK` and you get a line every time it starts, so a restart
in the middle of a long show is visible rather than silent.

What the box does while on air, in order: a 1920×1080 virtual screen, a virtual speaker
(Chrome's audio has to go somewhere real or the Web Audio graph stays silent), the studio worker
on loopback, Chrome with autoplay allowed and muting disabled, and ffmpeg pushing screen and
speaker to Cloudflare. It starts the encoder only once the page is actually playing, so a
warming-up poster never goes out, and it encodes the region the page reports rather than the
whole screen, so a kiosk window that lands a pixel short cannot put a black edge on air.

The box opens the studio with `hosted=1`, which hides the two surfaces meant for an operator
sitting at the machine: the control strip (the pointer rests on the stage forever on a virtual
screen, so it would otherwise be permanently visible) and the error notice. Errors reach you
through `air status` instead of the audience.

Drop `AIR_HEIGHT` to 720 if the encoder cannot keep up; it moves the screen, the window and the
encode together.

## Going on air, from the Mac

```sh
node scripts/stream.mjs create            # first time only; prints OBS server + key
node scripts/stream.mjs ingest            # the same server + key again, later
node scripts/stream.mjs add x <url> <key> # X Live Studio RTMP source
node scripts/stream.mjs status            # confirm video is arriving
```

Then, on the Mac:

1. `npm run dev`, open `http://127.0.0.1:3212/studio?broadcast=1&autostart=1`.
2. OBS browser source at 1920×1080, pointed at that URL. One output only, to Cloudflare.
3. **Let it buffer before you start the stream.** The first frame is 60–90s away while three
   shots render. Going live into an empty buffer is the one thing that looks amateur.
4. `node scripts/stream.mjs status` until the input reads `connected`.

Exactly one studio may be on air at a time: a second one writes the same show again and pays
for the same generation twice. The site enforces this now. Whichever studio is pulling paid
requests holds the air, and a second one is refused with `STUDIO_BUSY` and takes itself off air
saying "Another studio is on air." A studio that stops pulling gives up the air after a minute,
so switching between the box and the Mac only means stopping one and starting the other.
Studios are told apart by `STUDIO_ID`, so keep the box and the laptop on different names.

## Rehearsing the chart lane

Before the coin exists the hosts have nothing to react to, so borrow a chart. Studio only.

```sh
# .dev.vars
CHART_MINT=auto
```

`auto` follows whichever live pump.fun coin is trading hardest, re-picked at most every
twenty minutes. It also points the pump.fun chat reader at that coin's room, so the chat lane
gets exercised against real traffic at the same time. The hosts will say the show's own ticker
over borrowed numbers — that is the point, it is exactly what launch day sounds like.

The public site refuses to render a borrowed chart no matter what, and `CHART_MINT` never
touches the payment path.

## Testing the money path without spending money

```sh
node scripts/testmint.mjs                       # devnet mint + treasury token account
node scripts/testmint.mjs --fund <wallet>       # test supply to a Phantom wallet
```

Fund the payer it prints from https://faucet.solana.com if the built-in airdrop is
rate-limited, then run it again — the seeds are saved, so the address does not change.

Staging build and deploy:

```sh
npm run deploy:staging
```

That script rebuilds for staging, deploys, then **rebuilds for production again**. The database
id is baked in at build time, so leaving `dist/` on the staging build is how you accidentally
point production at the staging database. The trailing rebuild is what stops that.

Staging secrets: the devnet `COIN_MINT` and `TREASURY_WALLET`, `SOLANA_RPC_URL` on devnet, and
`PRICE_FIXED=1000`. Leave `CLIENT_RPC_URL` unset here too.

Two traps worth knowing:

- The browser and the server must be on the same cluster. They are now, by construction: the
  browser goes through `/api/rpc`, which forwards to `SOLANA_RPC_URL`. Setting `CLIENT_RPC_URL`
  to a different cluster would break that, which is one more reason to leave it unset.
- `PRICE_FIXED` is not optional on devnet. Neither Jupiter nor pump.fun price a devnet token,
  so without it every quote fails with code `PRICE`.

Two scripts drive the whole thing against the deployed staging site. Rerun both after any
change to `app/api/interact`, `lib/solana.ts`, `lib/db.ts` or `app/api/rpc`:

```sh
export SITE=https://interdimensional-podcast-staging.leonardo-chekup.workers.dev
export STUDIO_TOKEN=$(grep '^STUDIO_TOKEN=' .dev.vars | cut -d= -f2-)
export MINT=<devnet mint>  RPC_URL='https://devnet.helius-rpc.com/?api-key=<key>'

node scripts/paytest.mjs          # quote -> sign -> submit -> confirm -> pull -> aired,
                                  # then every adversarial case (13 assertions)
node scripts/paytest-browser.mjs  # the hop a real viewer takes: the wallet broadcasts and
                                  # confirms through /api/rpc, not the server-side fallback
```

`paytest.mjs` spends its quote allowance on purpose, so `paytest-browser.mjs` run straight
afterwards will hit the per-wallet 429. Wait out the minute.

These must keep failing: underpayment, transfer to another wallet, a replayed signature, an
empty wallet, a message containing a link or an address, a fourth quote inside a minute, and
any quote while the studio heartbeat is more than 60s old.

### Sponsorships on devnet

Sponsorship is a separate money path from the five-dollar seat, and it cannot be priced on
devnet the way that one can. `PRICE_FIXED` does not reach it. Jupiter prices mainnet only,
and then dates its answer by a mainnet block a devnet RPC has never seen, so every SOL quote
fails with code `PRICE`. Two variables fix that, and both are refused unless `SOLANA_RPC_URL`
is devnet or local:

| Variable | Meaning |
|---|---|
| `SPONSOR_FLAT_PRICE_CENTS` | One price for every placement, in cents. `100` makes each a dollar. |
| `SPONSOR_SOL_USD` | Dollars per SOL. Note the inverted units against `PRICE_FIXED`, which is tokens per dollar. |

`node scripts/testmint.mjs` prints both, along with a funded `SPONSOR_REFUND_SECRET_KEY`.
That reserve has to hold SOL and must not be the treasury, or every quote answers `REFUNDS`.
Set them on the devnet worker, then:

```sh
npm run deploy:devnet             # or run the "Deploy devnet" workflow by hand
export SITE=https://interdimensional-podcast-staging.leonardo-chekup.workers.dev
export STUDIO_TOKEN=$(grep '^STUDIO_TOKEN=' .dev.vars | cut -d= -f2-)
export RPC_URL='https://devnet.helius-rpc.com/?api-key=<key>'
node scripts/sponsorpay.mjs       # catalog -> draft -> quote -> sign -> submit -> paid
```

Sponsorship quotes require a live producer heartbeat and answer 409 `OFFAIR` without one.
To buy by hand from a browser wallet, hold the air instead of running the whole show:

```sh
SITE=... STUDIO_TOKEN=... node scripts/sponsorpay.mjs --hold      # LIVE, checkout open, no picture
SITE=... STUDIO_TOKEN=... node scripts/rehearsal.mjs              # the same, plus a picture
```

Both send the heartbeat the studio sends and nothing else, so the site reports LIVE and
checkout opens; a studio genuinely on air keeps its lease and the harness is refused.
`rehearsal.mjs` also loops the hosts' idle footage from `public/continuity` into the live
input named by `AIR_RTMP_INPUT` (make one with `node scripts/stream.mjs create rehearsal`;
the devnet worker's `STREAM_EMBED_URL` should point at that same input, never the show's).
It refuses the show's own input and any input with simulcast outputs. Nothing is generated.

A picture only arrives if Cloudflare Stream accepts the ingest. On 2026-09-11 every ingest
on this account (RTMPS, RTMP, SRT, four inputs, recording on or off, a real clip unmodified)
was accepted at `publish` and dropped a second later, no live input had ever produced a
recording, and `stream/storage-usage` reported a storage limit of 0 minutes. That is the
shape of `ERR_MISSING_SUBSCRIPTION` / `ERR_STORAGE_QUOTA_EXHAUSTED` in Cloudflare's live
input error codes: check the Stream subscription in the dashboard, and read the exact code
under Stream → Live Inputs → the input → events. Only SOL is payable on devnet: USDC needs a
devnet mint and a treasury token account, and the test token has no price anywhere, so both
report themselves unavailable with a reason.

## Launch day

The optional [launch tool](PUMP_LAUNCH.md) prepares metadata and a wallet-approved mint
transaction, publishes declared project wallets, and verifies the site handoff. It can create
the treasury token account directly, so the dust purchase in the manual flow below is unnecessary
when using `prepare-treasury`.

1. Create the coin on pump.fun.
2. Buy a dust amount into the treasury wallet — it needs a token account for the mint or every
   quote answers 409 `TREASURY`.
3. Set `COIN_MINT` and `TREASURY_WALLET` as production secrets. Redeploy.
4. **Remove `CHART_MINT`** from the studio's `.dev.vars` so the hosts follow the real coin.
5. `node scripts/stream.mjs add pump <url> <key>` with the key from the coin page. Outputs can
   be added mid-broadcast, so this does not interrupt the show.
6. Watch `status` until pump.fun reads connected.

## Cost

| | |
|---|---|
| Airtime | ~$22/hr promo, ~$90/hr list — dominated by video generation |
| Cloudflare Stream | ~$5/mo + ~$1/day live input + ~$1 per 1,000 viewer-minutes |
| The box | ~$0.25/hr on air, ~$1/mo parked, on a $5/mo Railway plan |
| Workers + D1 | Effectively free at this scale |

Airtime is the only number that matters. It is charged per second of generated video, so the
minimum shot length drives it directly: raising the floor from five to ten seconds roughly
doubles what short reaction beats cost. Measure real spend on the first long broadcast before
planning to run the show for hours.
