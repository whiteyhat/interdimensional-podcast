# Pump.fun launch tool

This tool prepares one standard coin launch with an explicitly budgeted creator purchase,
checks a wallet's signature, and submits that exact transaction. Project wallets are declared
publicly. The tool does not generate trading wallets, distribute tokens, or trade after launch.

Run commands from the repository root with Node 22.13 or newer. Dependencies are pinned in
the lockfile. Pump SDK 1.36.0 is loaded through its CommonJS entry because its ESM entry has
an Anchor interoperability failure on Node 22. The optional bigint native binding may print
a warning and use its supported JavaScript fallback.

## Prepare configuration

```sh
npm run launch -- init
```

Edit `work/launch/config.json`. The generated file deliberately leaves the final description,
website, creator/treasury addresses, purchase amount, and total budget blank. `check` refuses
incomplete input. Name and ticker start as Frogclench / FROGCLENCH; confirm them before upload.

- `network`: `mainnet-beta` or `devnet`. The actual RPC genesis hash must agree.
- `name`, `symbol`, `description`, `imagePath`, `website`: final public branding. Name and
  symbol have 32/10 UTF-8 byte limits. Images can be PNG, JPEG, GIF, or WebP, up to 5 MB.
- `twitter`, `telegram`, `video`: optional public HTTPS links. Public links cannot contain
  credentials, query strings, or fragments. Leave unused fields empty.
- `creator`: the public key of the wallet that signs, pays fees, and receives the initial buy.
- `treasury`: the public wallet that receives podcast token payments; it may be the creator.
- `buyLamports`: initial creator purchase ceiling, as a positive integer **string**. One SOL
  is 1,000,000,000 lamports. No purchase amount is chosen automatically.
- `maxTotalLamports`: total budget including the purchase, transaction fees, and account rent.
  Preparation checks a conservative simulation-based estimate against this budget. The buy
  instruction separately enforces `buyLamports`; total account costs are estimates, not an
  additional on-chain spending-limit contract.
- `priorityMicroLamports`: explicit compute-unit price as an integer string; defaults to zero.
  One million microlamports equals one lamport. No automatic fee escalation is performed.
- `wallets`: public addresses with `label`, `purpose`, `plannedTokens` (decimal token string),
  and `maySell` (boolean). Include both creator and treasury, without duplicates. Planned
  quantities are declarations; this tool does not allocate or lock those tokens.
- `cashback`, `mayhemMode`, `tokenizedAgent`, `frontRunningProtection`: false in this version.

Put `SOLANA_RPC_URL` and `PINATA_JWT` in your local `.dev.vars` or process environment.
Use an authenticated HTTPS RPC with the needed read, simulation, and send methods. Keep it
server-side. The local signing page uses the same configured RPC through `/api/rpc`.
Never put creator private keys or seed phrases in any launch configuration or JSON artifact.

```sh
npm run launch -- check
```

`--config <file>` and `--workdir <directory>` select a different launch. The default durable
workspace is `work/launch/session`; keep it private and back it up. Once initialized, the
configuration is frozen for that workspace. Restore accidental edits rather than switching
to a new workspace to recover an uncertain launch.

## Publish declarations before launch

```sh
npm run launch -- report --prelaunch --out public/launch/report.json
# Deploy the site through the existing deployment workflow.
npm run launch -- check-site --prelaunch
```

The public `/allocations` page and coin-card link show common project ownership, intended
allocations, and the declared sale policy. Before minting, observed balances are unknown.
Only the sanitized `public/launch/report.json` is allowlisted for publication. Private state,
configuration, mint keys, and signed artifacts stay under ignored `work/`.

## Upload, prepare, and sign

```sh
npm run launch -- upload
npm run launch -- prepare
npm run dev:app
```

The upload command pins the image and JSON to IPFS using Pinata. Receipts and content hashes
let a retry reuse completed uploads. Preparation checks published metadata and declarations,
and freezes the metadata for this launch once a transaction is prepared. Later uploads cannot
replace the URI referenced by a pending or finalized transaction. Preparation then
generates one atomic create-and-buy transaction, simulates it, and saves a numbered artifact.
It never splits a too-large launch into separate purchases.

Open `http://127.0.0.1:3212/studio/launch` and import the prepared JSON path printed by the
script. Review the decoded mint, creator, network, metadata, initial buy, and budget. Connect
the matching Phantom, Solflare, or compatible Wallet Standard wallet. The wallet must support
version 0 transactions and **signing without sending**. Sign and download the signed JSON.
The page verifies the message and signatures and does not broadcast. It returns 404 in a
production build and rejects non-loopback hosts during development.

```sh
npm run launch -- submit --signed /absolute/path/to/downloaded.signed.json
npm run launch -- status
```

Only `submit` broadcasts. It accepts the current stored revision, checks the reviewed intent
digest, exact message bytes, and signatures, then refreshes estimated costs against the reviewed
budget. It records the deterministic signature before sending. Run `status` until
the creation is finalized and the on-chain mint, creator, coin mode, and metadata are verified.

If a blockhash expires before submission, run `prepare` in the **same workspace**, then review
and sign the new revision. The mint address stays the same. An unresolved submitted signature
blocks new preparation until reconciliation proves its outcome. A timeout is not a failed
launch. Never delete the workspace or initialize a replacement to recover a timeout.
If signature history is unavailable after expiry but the mint exists, `status` verifies the
finalized mint against the stored launch intent. A matching mint is marked `recovered`,
distinct from a confirmed transaction signature; a mismatch keeps the outcome unresolved.

The workspace lock prevents overlapping commands. After a crash, inspect the PID in `.lock`
and verify the process is gone before removing that lock. Do not remove mint-keypair.json or
state.json. The mint key is created with mode 0600; all durable state is private.

## Finish the site handoff

```sh
npm run launch -- prepare-treasury
# If a transaction was prepared, sign it through the same local page, then submit and check status.
npm run launch -- export-config --out work/launch/site.env
npm run launch -- report --out public/launch/report.json
# Apply site.env's public addresses/names through the existing deployment workflow and deploy.
npm run launch -- check-site
```

If the treasury already has the correct associated token account, `prepare-treasury` reports
that no transaction is needed. Creating this account does not require buying a dust amount.
`export-config` never changes `.dev.vars`, worker secrets, or deployments automatically.

Reports use finalized chain reads performed sequentially; they are dated observations rather
than an atomic snapshot at a single slot. They include all configured wallets' accounts for
this mint and up to 20 recent signatures gathered from each wallet and its current token
accounts. Wallet history can include unrelated activity and omits closed token accounts;
it is not complete trade history or profit accounting. Failed reads appear as unavailable,
never as zero. An incomplete generated report exits with code 2 for operator review.
Regenerate and redeploy the report when publishing updated balances.

## Verification

```sh
node --test tests/launch-*.test.mjs tests/solana.test.mjs tests/rpcproxy.test.mjs
node --test tests/browser/launch-route.test.mjs
npx tsc --noEmit
npm run build
# In a separate terminal, serve the browser regression fixtures:
node tests/browser/launch-serve.mjs
```

The launch tests use real SDK instruction construction and simulated RPC responses; they
do not spend SOL. Open `http://127.0.0.1:3315/tests/browser/launch-report.html` and
`http://127.0.0.1:3315/tests/browser/launch-sign.html`; `await window.launchChecks` in the
browser console returns their assertions. These fixtures use a mock wallet and no RPC. A devnet
Pump integration test requires the actual Pump programs and lookup table to be available;
the repository's ordinary SPL test mint is not proof of a Pump launch. No mainnet transaction
is part of the automated verification.

References: [Create Coin skill](https://github.com/pump-fun/pump-fun-skills/blob/main/create-coin/SKILL.md),
[metadata format](https://github.com/pump-fun/pump-fun-skills/blob/main/create-coin/references/METADATA.md),
[Pinata file API](https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-file-to-ipfs).
