// A stand-in token on devnet, so the five-dollar seat can be exercised with a real browser
// wallet before the real coin exists. Six decimals, because that is what pump.fun mints use
// and rounding has to behave identically to launch day.
//
//   node scripts/testmint.mjs                        create mint + treasury, print the config
//   node scripts/testmint.mjs --fund <wallet>        mint test supply to a viewer wallet
//
// Devnet only, by design: it refuses to run against a mainnet RPC.
import { readFile, writeFile } from 'node:fs/promises';
import {
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

const RPC = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const WS = RPC.replace(/^http/, 'ws');
const DECIMALS = 6;
const KEYS = '.devnet-keys.json';
const SUPPLY = 1_000_000_000n; // whole tokens, before decimals

if (!/devnet|localhost|127\.0\.0\.1/.test(RPC))
  throw Error(`Refusing to run against ${RPC}. This script is for devnet only.`);

const rpc = createSolanaRpc(RPC);
const subs = createSolanaRpcSubscriptions(WS);
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });
const airdrop = airdropFactory({ rpc, rpcSubscriptions: subs });

/**
 * Seeds live in a gitignored file so repeated runs reuse the same mint and treasury rather
 * than stranding devnet SOL in a new payer every time. Thirty-two-byte seeds round-trip
 * cleanly; the CryptoKeyPairs kit builds from them are not extractable, so we never try.
 */
const seed = () => Array.from(crypto.getRandomValues(new Uint8Array(32)));

async function keys() {
  const saved = await readFile(KEYS, 'utf8').catch(() => '');
  const j = saved ? JSON.parse(saved) : { payer: seed(), treasury: seed(), mint: seed() };
  const from = (s) => createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(s));
  const [payer, treasury, mint] = await Promise.all([
    from(j.payer),
    from(j.treasury),
    from(j.mint),
  ]);
  return { payer, treasury, mint, seeds: j };
}

async function save({ seeds }) {
  await writeFile(KEYS, `${JSON.stringify(seeds, null, 2)}\n`);
}

async function fund(signer, sol = 2) {
  const balance = await rpc.getBalance(signer.address).send();
  if (Number(balance.value) >= sol * 1e9 * 0.5) return;
  try {
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(BigInt(sol * 1e9)),
      commitment: 'confirmed',
    });
  } catch (e) {
    throw Error(
      `Devnet airdrop failed for ${signer.address}: ${e?.message ?? e}\n` +
        'The public faucet rate-limits hard. Fund this address from https://faucet.solana.com ' +
        'or set DEVNET_RPC_URL to a provider endpoint, then run again.',
    );
  }
}

async function submit(payer, instructions) {
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

async function treasuryAta(mint, owner) {
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

async function main() {
  const target = process.argv.includes('--fund')
    ? process.argv[process.argv.indexOf('--fund') + 1]
    : null;
  const k = await keys();
  // Save before anything can fail. The faucet is unreliable, and an operator who funds the
  // payer by hand must find the same payer waiting on the next run.
  await save(k);
  console.log(`Payer ${k.payer.address}`);
  await fund(k.payer);

  const existing = k.mint ? await rpc.getAccountInfo(k.mint.address).send() : { value: null };
  if (!existing.value) {
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    await submit(k.payer, [
      getCreateAccountInstruction({
        payer: k.payer,
        newAccount: k.mint,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({
        mint: k.mint.address,
        decimals: DECIMALS,
        mintAuthority: k.payer.address,
        freezeAuthority: null,
      }),
    ]);
    console.log(`Created mint ${k.mint.address}`);
  } else {
    console.log(`Reusing mint ${k.mint.address}`);
  }

  // The treasury must already hold an initialised token account or every quote returns 409.
  await submit(k.payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: k.payer,
      mint: k.mint.address,
      owner: k.treasury.address,
    }),
  ]);
  const ata = await treasuryAta(k.mint.address, k.treasury.address);
  console.log(`Treasury ${k.treasury.address} token account ${ata} ready`);

  if (target) {
    const owner = address(target);
    await submit(k.payer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: k.payer,
        mint: k.mint.address,
        owner,
      }),
      getMintToInstruction({
        mint: k.mint.address,
        token: await treasuryAta(k.mint.address, owner),
        mintAuthority: k.payer,
        amount: SUPPLY * 10n ** BigInt(DECIMALS),
      }),
    ]);
    console.log(`Minted ${SUPPLY.toLocaleString()} test tokens to ${owner}`);
  }

  console.log(`\nKeys saved to ${KEYS} (gitignored). Staging configuration:\n`);
  console.log(`  COIN_MINT=${k.mint.address}`);
  console.log(`  TREASURY_WALLET=${k.treasury.address}`);
  console.log(`  SOLANA_RPC_URL=${RPC}`);
  console.log(`  CLIENT_RPC_URL=${RPC}`);
  console.log('  PRICE_FIXED=1000');
  console.log('  COIN_TICKER=TESTCLENCH');
  console.log('  COIN_NAME=Testclench');
  console.log(
    '\nPRICE_FIXED is required: neither Jupiter nor pump.fun price devnet tokens, so without\n' +
      'it every quote fails with code PRICE. 1000 means a thousand tokens to the dollar.',
  );
  console.log('\nFund a viewer wallet:  node scripts/testmint.mjs --fund <your-phantom-address>');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
