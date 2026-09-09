# Launch runbook

Two machines, three destinations, one coin. The studio generates the show on the operator's
Mac; the public site is a Cloudflare Worker; OBS pushes one stream to Cloudflare and
Cloudflare fans it out. Nothing generates video in production, ever.

```
/studio?broadcast=1&autostart=1  →  OBS  →  Cloudflare Stream live input
                                                 ├── X Live Studio
                                                 ├── pump.fun coin page
                                                 └── the player on the public site
```

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

## Going on air

```sh
node scripts/stream.mjs create            # first time only; prints OBS server + key
node scripts/stream.mjs add x <url> <key> # X Live Studio RTMP source
node scripts/stream.mjs status            # confirm video is arriving
```

Then, on the Mac:

1. `npm run dev`, open `http://127.0.0.1:3212/studio?broadcast=1&autostart=1`.
2. OBS browser source at 1920×1080, pointed at that URL. One output only, to Cloudflare.
3. **Let it buffer before you start the stream.** The first frame is 60–90s away while three
   shots render. Going live into an empty buffer is the one thing that looks amateur.
4. `node scripts/stream.mjs status` until the input reads `connected`.

Exactly one studio tab may run at a time. A second one spends fal credits twice, and nothing
in the code stops you.

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
| Workers + D1 | Effectively free at this scale |

Airtime is the only number that matters. It is charged per second of generated video, so the
minimum shot length drives it directly: raising the floor from five to ten seconds roughly
doubles what short reaction beats cost. Measure real spend on the first long broadcast before
planning to run the show for hours.
