// End-to-end exercise of a SPONSORSHIP purchase against the DEPLOYED devnet worker.
// scripts/paytest.mjs covers the five-dollar seat; nothing covered the sponsorship money
// path, which is a different route and a different table.
//
//   SITE=... STUDIO_TOKEN=... RPC_URL=... node scripts/sponsorpay.mjs
//   SITE=... STUDIO_TOKEN=...            node scripts/sponsorpay.mjs --hold
//
// PRODUCT picks the placement (message, the default; spotlight; cap). A spotlight takes
// PROJECT and STYLE (intro, debate or gentle-roast). A cap takes PROJECT, TARGET (host or
// guest) and LOGO, a PNG, JPG or WebP path the site qualifies against the cap template
// before anything is quoted; ASSET_ID reuses a design that is already qualified.
// MESSAGE overrides the buyer's text for any of them.
//
// --hold sends the studio heartbeat every twenty seconds and nothing else, so a person can
// buy from a real browser wallet on the devnet site without running the whole show.
//
// Devnet only: the deployment must be priced by SPONSOR_SOL_USD, which the worker refuses
// to read unless it is itself on devnet.
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  holdAir,
  loadKeys,
  signQuote,
  studioHeartbeat,
  until,
} from './devnet.mjs';

const SITE = process.env.SITE;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const RPC_URL = process.env.RPC_URL;
const HOLD = process.argv.includes('--hold');
const PRODUCT = process.env.PRODUCT || 'message';
if (!['message', 'spotlight', 'cap'].includes(PRODUCT))
  throw Error(`PRODUCT must be message, spotlight or cap, not ${PRODUCT}.`);
if (PRODUCT === 'cap' && !process.env.LOGO && !process.env.ASSET_ID && !HOLD)
  throw Error(
    'A cap needs LOGO (an image path) or ASSET_ID (a qualified design).',
  );
// The stand-in studio offers what a real one would: a cap only when one is being bought, and
// then with the template version the media service qualifies against. The site refuses to
// quote a placement the producer has not said it can deliver, and checks the design against
// that version.
const capabilities = { message: true, spotlight: true, cap: PRODUCT === 'cap' };
if (PRODUCT === 'cap') {
  const health = await fetch(`${SITE}/api/sponsorship/assets`)
    .then((r) => r.json())
    .catch(() => ({}));
  if (!health.capQualified)
    throw Error(
      `${SITE} cannot sell a cap right now: ${JSON.stringify(health)}`,
    );
  capabilities.capTemplateVersion = health.templateVersion;
}
if (!SITE || !STUDIO_TOKEN || (!HOLD && !RPC_URL))
  throw Error(
    HOLD
      ? 'SITE and STUDIO_TOKEN are required.'
      : 'SITE, STUDIO_TOKEN and RPC_URL are all required.',
  );
if (!HOLD && !/devnet|localhost|127\.0\.0\.1/.test(RPC_URL))
  throw Error(
    `Refusing to run against ${RPC_URL}. This script is for devnet only.`,
  );

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  const line = name + (detail ? ` — ${detail}` : '');
  if (ok) passed++;
  else failures.push(line);
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${line}`);
};

/** POST to the deployed site's sponsorship route. */
async function api(body, headers = {}) {
  const r = await fetch(`${SITE}/api/sponsorship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function catalog() {
  const r = await fetch(`${SITE}/api/sponsorship?action=catalog`);
  return r.json();
}
const heartbeat = () => studioHeartbeat(SITE, STUDIO_TOKEN, capabilities);

// Holding the air is the whole job in --hold: a person buys from a real wallet while this
// keeps the producer lease warm. Nothing is written, generated or delivered. For a picture
// as well, see scripts/rehearsal.mjs.
if (HOLD) {
  await holdAir(SITE, STUDIO_TOKEN, {
    capabilities,
    onRefused: (status) => console.error(`heartbeat refused: ${status}`),
  });
  console.log(
    `Holding the air on ${SITE}\nBuy from the browser now. Ctrl-C to let go.`,
  );
  await new Promise(() => {});
}

// ---- a cap's design is qualified against the template before it can be sold. Qualifying takes
// up to forty seconds, so it starts now, before the stand-in studio claims its thirty-second
// producer window, and is awaited only when the draft needs it.
const TARGET = process.env.TARGET === 'guest' ? 'guest' : 'host';
async function qualifyLogo(path) {
  const type = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extname(path).toLowerCase()];
  if (!type) throw Error('LOGO must be a PNG, JPG or WebP file.');
  const form = new FormData();
  form.set('image', new File([await readFile(path)], basename(path), { type }));
  form.set('kind', 'cap');
  form.set('target', TARGET);
  const started = Date.now();
  const r = await fetch(`${SITE}/api/sponsorship/assets`, {
    method: 'POST',
    body: form,
  });
  const uploaded = await r.json().catch(() => ({}));
  check(
    'the cap design is qualified',
    r.ok && uploaded.status === 'qualified',
    r.ok
      ? `asset ${uploaded.id} (${uploaded.status}) in ${Date.now() - started} ms`
      : `${r.status} ${JSON.stringify(uploaded)}`,
  );
  return uploaded.id;
}
const qualified =
  PRODUCT === 'cap' && !process.env.ASSET_ID
    ? qualifyLogo(process.env.LOGO)
    : Promise.resolve(process.env.ASSET_ID);

const rpc = createSolanaRpc(RPC_URL);
const subs = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, 'ws'));
void sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });

const { signers } = await loadKeys(['viewer']);
const { viewer } = signers;
console.log(`Buyer ${viewer.address}\nSite  ${SITE}\n`);

const balance = await rpc.getBalance(viewer.address).send();
check(
  'the buyer holds SOL for the placement and its fees',
  BigInt(balance.value) > 20_000_000n,
  `${Number(balance.value) / 1e9} SOL — fund it with scripts/testmint.mjs --fund ${viewer.address}`,
);

// ---- the studio has to be on air before anything can be quoted. This harness stands in
// for one: the same heartbeat the real studio sends, with the same token, claiming the
// producer lease for the thirty seconds a rehearsal needs. A studio already on air keeps
// its lease, and the claim is refused instead.
const onAir = await heartbeat();
check(
  'the rehearsal can stand in for the studio',
  onAir.status === 200,
  `${onAir.status} ${JSON.stringify(onAir.body)}`,
);
const shown = await catalog();
check('the catalog answers', !shown.error, shown.error);
check(
  'the studio is on air',
  shown.studioOnline === true,
  'run the studio against this origin, or every quote answers 409 OFFAIR',
);
const sol = shown.assets?.find((a) => a.id === 'SOL');
check(
  'SOL is payable',
  sol?.available === true,
  sol?.available ? `pinned at $${sol.priceUsd}` : (sol?.reason ?? 'missing'),
);
check(
  'every placement costs a dollar',
  shown.products?.every((p) => p.priceCents === 100),
  JSON.stringify(shown.products?.map((p) => [p.id, p.priceCents])),
);

// ---- the happy path: draft, quote, sign, submit, confirm
const PROJECT = process.env.PROJECT || 'Frog Labs';
const pitch = {
  message: 'Chad, does a devnet dollar still count as conviction?',
  spotlight: `${PROJECT} is a web3 marketplace for indie games.`,
  cap: `${PROJECT} makes caps for frogs who touch grass.`,
};
const drafted = await api({
  action: 'draft',
  draft: {
    product: PRODUCT,
    name: '',
    message: process.env.MESSAGE || pitch[PRODUCT],
    ...(PRODUCT !== 'message' && { projectName: PROJECT }),
    ...(PRODUCT === 'spotlight' && { style: process.env.STYLE || 'intro' }),
    ...(PRODUCT === 'cap' && { target: TARGET, assetId: await qualified }),
  },
});
check(
  'the order is drafted',
  !!drafted.body.receipt,
  drafted.body.receipt
    ? `order ${drafted.body.receipt.id}`
    : JSON.stringify(drafted.body),
);
const token = drafted.body.receipt?.token;

const quoted = token
  ? await api({ action: 'quote', token, asset: 'SOL', wallet: viewer.address })
  : { body: {} };
const attempt = quoted.body.attempt;
check(
  'the placement is quoted',
  !!attempt,
  attempt ? `attempt ${attempt.id}` : JSON.stringify(quoted.body),
);
check(
  'it is priced at a dollar',
  attempt?.priceCents === 100,
  String(attempt?.priceCents),
);
check(
  'the amount matches the pinned SOL price',
  attempt?.amountBase ===
    String(Math.ceil((100 * 10 ** 9) / (100 * Number(attempt?.priceUsd ?? 0)))),
  `${attempt?.amountUi} SOL at $${attempt?.priceUsd}`,
);

const submitted = quoted.body.transaction
  ? await api({
      action: 'submit',
      token,
      attemptId: attempt.id,
      signedTx: await signQuote(quoted.body.transaction, viewer),
    })
  : { body: {} };
const accepted =
  submitted.body.receipt?.status === 'paid' ||
  !!submitted.body.receipt?.attempts?.some((a) => a.status !== 'expired');
check(
  'the signed placement is accepted',
  accepted,
  accepted
    ? submitted.body.receipt.status
    : JSON.stringify(submitted.body).slice(0, 300),
);

// Reading the receipt never verifies anything. The browser asks the site to confirm,
// which is what looks the reference up on chain and marks the order paid, so the
// harness asks the same way. Without an attempt id it sweeps every open attempt.
const paid = await until(async () => {
  const r = await api({ action: 'confirm', token });
  return r.body.receipt?.paidAt ? r.body.receipt : null;
});
check(
  'the placement is paid and verified on chain',
  !!paid,
  paid
    ? `${paid.status}, paid by ${paid.payer}, signature ${paid.attempts.find((a) => a.verifiedSignature)?.verifiedSignature ?? '?'}`
    : 'timed out',
);

// ---- what must keep failing
const stranger = await api({
  action: 'quote',
  token: 'x'.repeat(40),
  asset: 'SOL',
});
check(
  'an unknown order cannot be quoted',
  stranger.status >= 400,
  String(stranger.status),
);
const unpriced = await api({ action: 'quote', token, asset: 'FROGCLENCH' });
check(
  'an asset with no devnet price stays unbuyable',
  unpriced.status >= 400,
  String(unpriced.status),
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
