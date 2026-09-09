// The exact hop a real viewer takes: the wallet broadcasts the payment itself, through the
// site's own /api/rpc, with the provider key never leaving the Worker. paytest.mjs exercises
// the server-side `submit` fallback instead, so this is the path that stays unproven unless it
// is driven on its own.
//
//   SITE=... STUDIO_TOKEN=... node scripts/paytest-browser.mjs
//
// paytest.mjs spends its own quote allowance, so running this straight afterwards hits the
// per-wallet 429. Wait out the minute.
import { apiFor, loadKeys, signQuote, until } from './devnet.mjs';

const SITE = process.env.SITE;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const api = apiFor(SITE);
const studio = (body) => api(body, { 'x-studio-token': STUDIO_TOKEN });

/** The browser never touches the provider; every call goes through the site's own proxy. */
const viaProxy = async (method, params) => {
  const r = await fetch(`${SITE}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const { signers } = await loadKeys(['viewer']);
const { viewer } = signers;
console.log(`viewer ${viewer.address}\n`);

// The studio has to be on air or quotes are refused.
await studio({ action: 'pull' });

const q = await api({
  action: 'quote',
  wallet: viewer.address,
  name: 'Carlos',
  message: 'Broadcasting this one through the site proxy',
});
if (!q.body.ok || !q.body.hasEnough) {
  console.log('could not get a quote:', q.status, JSON.stringify(q.body).slice(0, 200));
  process.exit(1);
}
console.log(`  ok   quote issued, ${q.body.amountUi} tokens`);

// This is the call Phantom makes.
const sent = await viaProxy('sendTransaction', [
  await signQuote(q.body.tx, viewer),
  { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 },
]);
const signature = sent.body.result;
console.log(
  signature
    ? `  ok   wallet broadcast through /api/rpc — ${signature.slice(0, 24)}…`
    : `  FAIL broadcast rejected: ${JSON.stringify(sent.body).slice(0, 300)}`,
);
if (!signature) process.exit(1);

// And the wallet polls its own status through the proxy too.
const landed = await until(async () => {
  const st = await viaProxy('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  const v = st.body?.result?.value?.[0];
  return !!v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized');
});
console.log(landed ? '  ok   confirmed through /api/rpc' : '  FAIL never confirmed via proxy');

const paid = await until(async () => {
  const c = await api({ action: 'confirm', reference: q.body.reference, signature });
  return ['paid', 'claimed', 'aired'].includes(c.body.status) && c.body.status;
}, { tries: 25 });
console.log(paid ? `  ok   site verified the payment — ${paid}` : '  FAIL site never verified it');

const pulled = await studio({ action: 'pull' });
const mine = (pulled.body.requests || []).find((r) => r.reference === q.body.reference);
console.log(mine ? `  ok   reached the studio queue — "${mine.text.slice(0, 40)}"` : '  FAIL not queued');
if (mine) await studio({ action: 'aired', reference: q.body.reference });

const ok = landed && paid && mine;
console.log(ok ? '\nthe browser payment path works end to end' : '\nBROKEN');
process.exit(ok ? 0 : 1);
