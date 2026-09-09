// End-to-end exercise of the five-dollar seat against the DEPLOYED staging worker, on devnet.
// Happy path first, then the adversarial cases that must keep failing.
//
//   SITE=... STUDIO_TOKEN=... RPC_URL=... MINT=... node scripts/paytest.mjs
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  lamports,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToInstruction } from '@solana-program/token';
import { apiFor, ataFor, loadKeys, signQuote, submitTx, until } from './devnet.mjs';

const SITE = process.env.SITE;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const RPC_URL = process.env.RPC_URL;
const MINT = address(process.env.MINT);

const rpc = createSolanaRpc(RPC_URL);
const subs = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, 'ws'));
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });
const submit = (payer, ix) => submitTx(rpc, send, payer, ix);
const api = apiFor(SITE);
const studio = (body) => api(body, { 'x-studio-token': STUDIO_TOKEN });
const heartbeat = () => studio({ action: 'pull' });

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  const line = name + (detail ? ` — ${detail}` : '');
  if (ok) passed++;
  else failures.push(line);
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${line}`);
};

// ---- setup: a viewer wallet with SOL for fees and test tokens to spend
const { signers } = await loadKeys(['payer', 'viewer', 'stranger']);
const { payer, viewer, stranger } = signers;
console.log(`viewer   ${viewer.address}`);
console.log(`stranger ${stranger.address}\n`);

const viewerAta = await ataFor(MINT, viewer.address);
const [sol, tokens] = await Promise.all([
  rpc.getBalance(viewer.address).send(),
  rpc.getTokenAccountBalance(viewerAta).send().catch(() => null),
]);
if (Number(sol.value) < 2e7) {
  await submit(payer, [
    getTransferSolInstruction({ source: payer, destination: viewer.address, amount: lamports(50_000_000n) }),
  ]);
  console.log('funded viewer with SOL');
}
if (!tokens || Number(tokens.value.amount) < 20_000_000_000) {
  await submit(payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, mint: MINT, owner: viewer.address }),
    getMintToInstruction({ mint: MINT, token: viewerAta, mintAuthority: payer, amount: 50_000_000_000n }),
  ]);
  console.log('minted 50,000 TESTCLENCH to viewer\n');
}

// ---- happy path
console.log('--- happy path ---');
await heartbeat();
const q = await api({
  action: 'quote',
  wallet: viewer.address,
  name: 'Carlos',
  message: 'Do Pepe and Chad think the chart is cooked?',
});
check('quote returns a signable transaction', q.status === 200 && q.body.ok && q.body.hasEnough, `status ${q.status}`);
check('quote prices the seat server-side', q.body.amountUi === 5000, `amountUi=${q.body.amountUi}`);
const reference = q.body.reference;

const sub = await api({ action: 'submit', reference, signedTx: await signQuote(q.body.tx, viewer) });
check('submit relays the signed transaction', sub.status === 200, `status ${sub.status} ${JSON.stringify(sub.body).slice(0, 120)}`);

const confirmed = await until(async () => {
  const c = await api({ action: 'confirm', reference });
  return ['paid', 'claimed', 'aired'].includes(c.body.status) && c.body;
});
check('payment verifies on chain', !!confirmed, confirmed ? `status=${confirmed.status}` : 'never reached paid');

const pulled = await studio({ action: 'pull' });
const mine = (pulled.body.requests || []).find((r) => r.reference === reference);
check('studio pulls the paid request', !!mine, mine ? `text="${mine.text.slice(0, 40)}"` : 'not in queue');
check('pulled request carries the payer name', mine?.from === 'Carlos', `from=${mine?.from}`);

const aired = await studio({ action: 'aired', reference });
check('studio marks it aired', aired.status === 200);
const after = await studio({ action: 'pull' });
check(
  'an aired request is never delivered twice',
  !(after.body.requests || []).some((r) => r.reference === reference),
);

// ---- adversarial: these must all be refused
console.log('\n--- adversarial (each must be refused) ---');
await heartbeat();

const link = await api({ action: 'quote', wallet: viewer.address, name: 'x', message: 'buy at https://scam.example.com now' });
check('a message containing a link is rejected', link.status === 400, `status ${link.status}`);

const addr = await api({ action: 'quote', wallet: viewer.address, name: 'x', message: `send to ${MINT} for a prize` });
check('a message containing an address is rejected', addr.status === 400, `status ${addr.status}`);

const empty = await api({ action: 'quote', wallet: stranger.address, name: 'x', message: 'I have no tokens at all here' });
check('an empty wallet is told it cannot pay', empty.status === 200 && empty.body.hasEnough === false, `hasEnough=${empty.body.hasEnough}`);

// Replay: reuse the already-spent signature against a brand-new quote.
const fresh = await api({ action: 'quote', wallet: viewer.address, name: 'x', message: 'A second, different question for them' });
const replay = await api({ action: 'confirm', reference: fresh.body.reference, signature: confirmed?.signature });
check(
  'a spent signature cannot pay for a new request',
  replay.body.status !== 'paid' && replay.body.status !== 'aired',
  `status=${replay.body.status}`,
);

// Rate limit: these are deliberately sequential, since they share one per-wallet counter.
let limited = 0;
for (let i = 0; i < 5; i++) {
  const r = await api({ action: 'quote', wallet: viewer.address, name: 'x', message: `Rate limit probe number ${i} here` });
  if (r.status === 429) limited++;
}
check('a wallet cannot spam quotes', limited > 0, `${limited} of 5 rejected with 429`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
