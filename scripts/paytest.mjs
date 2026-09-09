// End-to-end exercise of the five-dollar seat against the DEPLOYED staging worker, on devnet.
// Happy path first, then the adversarial cases that must keep failing.
import { readFile, writeFile } from 'node:fs/promises';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

const SITE = process.env.SITE;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN;
const RPC_URL = process.env.RPC_URL;
const MINT = address(process.env.MINT);
const REPO = process.env.REPO ?? process.cwd();

const rpc = createSolanaRpc(RPC_URL);
const subs = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, 'ws'));
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });

const pass = [];
const fail = [];
const check = (name, ok, detail = '') => {
  (ok ? pass : fail).push(name + (detail ? ` — ${detail}` : ''));
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const api = async (body, headers = {}) => {
  const r = await fetch(`${SITE}/api/interact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const studio = (body) => api(body, { 'x-studio-token': STUDIO_TOKEN });
const heartbeat = () => studio({ action: 'pull' });

async function submitTx(payer, instructions) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  await send(signed, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signed);
}

// ---- setup: a viewer wallet with SOL for fees and test tokens to spend
const seeds = JSON.parse(await readFile(`${REPO}/.devnet-keys.json`, 'utf8'));
const payer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(seeds.payer));
// Persist the test wallets so a funded viewer survives between runs and other scripts can
// reuse it; a fresh viewer every run means re-funding and re-minting every run.
const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32)));
let dirty = false;
if (!seeds.viewer) { seeds.viewer = rand(); dirty = true; }
if (!seeds.stranger) { seeds.stranger = rand(); dirty = true; }
if (dirty) await writeFile(`${REPO}/.devnet-keys.json`, `${JSON.stringify(seeds, null, 2)}\n`);
const viewer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(seeds.viewer));
const stranger = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(seeds.stranger));
console.log(`viewer   ${viewer.address}`);
console.log(`stranger ${stranger.address}\n`);

const bal = await rpc.getBalance(viewer.address).send();
if (Number(bal.value) < 2e7) {
  await submitTx(payer, [
    getTransferSolInstruction({ source: payer, destination: viewer.address, amount: lamports(50_000_000n) }),
  ]);
  console.log('funded viewer with SOL');
}
const [viewerAta] = await findAssociatedTokenPda({
  mint: MINT,
  owner: viewer.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const tokBal = await rpc.getTokenAccountBalance(viewerAta).send().catch(() => null);
if (!tokBal || Number(tokBal.value.amount) < 20_000_000_000) {
  await submitTx(payer, [
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

const wire = getBase64Encoder().encode(q.body.tx);
const decoded = getTransactionDecoder().decode(wire);
const signedTx = await signTransaction([viewer.keyPair], decoded);
const signedB64 = getBase64EncodedWireTransaction(signedTx);

const sub = await api({ action: 'submit', reference, signedTx: signedB64 });
check('submit relays the signed transaction', sub.status === 200, `status ${sub.status} ${JSON.stringify(sub.body).slice(0, 120)}`);

let confirmed = null;
for (let i = 0; i < 30; i++) {
  const c = await api({ action: 'confirm', reference });
  if (c.body.status === 'paid' || c.body.status === 'claimed' || c.body.status === 'aired') {
    confirmed = c.body;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
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

// Rate limit: a fourth quote inside a minute for one wallet.
let limited = 0;
for (let i = 0; i < 5; i++) {
  const r = await api({ action: 'quote', wallet: viewer.address, name: 'x', message: `Rate limit probe number ${i} here` });
  if (r.status === 429) limited++;
}
check('a wallet cannot spam quotes', limited > 0, `${limited} of 5 rejected with 429`);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log('\nFAILURES:');
  for (const f of fail) console.log('  -', f);
  process.exit(1);
}
