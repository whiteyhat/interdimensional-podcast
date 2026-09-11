// Shared devnet plumbing for the launch scripts, the way scripts/fal.mjs is shared by the
// asset scripts. testmint.mjs owns the key file's format; everything else reads it from here,
// so the shape is assumed in one place rather than three.
import { readFile, writeFile } from 'node:fs/promises';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

export const KEYS = '.devnet-keys.json';
/** Thirty-two-byte seeds round-trip cleanly; the CryptoKeyPairs kit builds are not extractable. */
export const seed = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)));

/** Read the seed file, minting any names that are missing, and return signers by name. */
export async function loadKeys(names, repo = process.cwd()) {
  const path = `${repo}/${KEYS}`;
  const saved = await readFile(path, 'utf8').catch(() => '');
  const seeds = saved ? JSON.parse(saved) : {};
  let added = false;
  for (const n of names)
    if (!seeds[n]) {
      seeds[n] = seed();
      added = true;
    }
  if (added) await writeFile(path, `${JSON.stringify(seeds, null, 2)}\n`);
  const signers = Object.fromEntries(
    await Promise.all(
      names.map(async (n) => [
        n,
        await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(seeds[n])),
      ]),
    ),
  );
  return { signers, seeds, path };
}

/** The associated token account for any owner, not only the treasury. */
export async function ataFor(mint, owner) {
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

/** Build, sign, send and confirm one transaction; returns its signature. */
export async function submitTx(rpc, send, payer, instructions) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await send(signed, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signed);
}

/** Sign a quote's base64 wire transaction in Node, the way a browser wallet would. */
export async function signQuote(base64, signer) {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(base64),
  );
  return getBase64EncodedWireTransaction(
    await signTransaction([signer.keyPair], decoded),
  );
}

/** POST to a deployed site's interact route and return status plus parsed body. */
export function apiFor(site) {
  return async (body, headers = {}) => {
    const r = await fetch(`${site}/api/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

/** Poll until `check` returns something truthy, or give up. Returns the truthy value or null. */
export async function until(check, { tries = 30, everyMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const hit = await check();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/** POST to a deployed site's sponsorship route as the studio: the heartbeat the real one sends. */
export async function studioHeartbeat(
  site,
  token,
  capabilities = { message: true, spotlight: true, cap: false },
) {
  const r = await fetch(`${site}/api/sponsorship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-studio-token': token },
    body: JSON.stringify({ action: 'heartbeat', capabilities }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/**
 * Keep the producer lease warm without running a show. The first refusal is fatal, because
 * a wrong token would otherwise fail quietly every twenty seconds while the operator waits
 * for a LIVE that never comes. Returns a function that lets go.
 */
export async function holdAir(
  site,
  token,
  { everyMs = 20_000, onRefused = () => {} } = {},
) {
  const first = await studioHeartbeat(site, token);
  if (first.status !== 200)
    throw Error(
      `${site} refused the studio token: ${first.status} ${JSON.stringify(first.body)}`,
    );
  const timer = setInterval(() => {
    void studioHeartbeat(site, token).then((r) => {
      if (r.status !== 200) onRefused(r.status);
    });
  }, everyMs);
  return () => clearInterval(timer);
}
