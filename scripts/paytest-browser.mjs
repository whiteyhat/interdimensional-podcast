// The exact hop a real viewer takes: the wallet broadcasts the payment itself, through the
// site's own /api/rpc, with the provider key never leaving the Worker. The paytest suite
// exercises the server-side `submit` fallback instead, so this is the path that stays unproven
// unless it is driven on its own.
import { readFile } from 'node:fs/promises';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signTransaction,
} from '@solana/kit';

const SITE = process.env.SITE;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const REPO = process.env.REPO ?? process.cwd();
const PROXY = `${SITE}/api/rpc`;

const api = (body, headers = {}) =>
  fetch(`${SITE}/api/interact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const viaProxy = (method, params) =>
  fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const seeds = JSON.parse(await readFile(`${REPO}/.devnet-keys.json`, 'utf8'));
const viewer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(seeds.viewer));
console.log(`viewer ${viewer.address}\n`);

// The studio has to be on air or quotes are refused.
await api({ action: 'pull' }, { 'x-studio-token': STUDIO_TOKEN });

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

const signed = await signTransaction(
  [viewer.keyPair],
  getTransactionDecoder().decode(getBase64Encoder().encode(q.body.tx)),
);
const wire = getBase64EncodedWireTransaction(signed);

// This is the call Phantom makes. It must reach mainnet/devnet through our Worker.
const sent = await viaProxy('sendTransaction', [
  wire,
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
let landed = false;
for (let i = 0; i < 30; i++) {
  const st = await viaProxy('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  const v = st.body?.result?.value?.[0];
  if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
    landed = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(landed ? '  ok   confirmed through /api/rpc' : '  FAIL never confirmed via proxy');

let paid = null;
for (let i = 0; i < 25; i++) {
  const c = await api({ action: 'confirm', reference: q.body.reference, signature });
  if (['paid', 'claimed', 'aired'].includes(c.body.status)) {
    paid = c.body.status;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(paid ? `  ok   site verified the payment — ${paid}` : '  FAIL site never verified it');

const pulled = await api({ action: 'pull' }, { 'x-studio-token': STUDIO_TOKEN });
const mine = (pulled.body.requests || []).find((r) => r.reference === q.body.reference);
console.log(mine ? `  ok   reached the studio queue — "${mine.text.slice(0, 40)}"` : '  FAIL not queued');
if (mine) await api({ action: 'aired', reference: q.body.reference }, { 'x-studio-token': STUDIO_TOKEN });

console.log(landed && paid && mine ? '\nthe browser payment path works end to end' : '\nBROKEN');
process.exit(landed && paid && mine ? 0 : 1);
