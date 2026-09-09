// A stand-in token on devnet, so the five-dollar seat can be exercised with a real browser
// wallet before the real coin exists. Six decimals, because that is what pump.fun mints use
// and rounding has to behave identically to launch day.
//
//   node scripts/testmint.mjs                        create mint + treasury, print the config
//   node scripts/testmint.mjs --fund <wallet>        mint test supply to a viewer wallet
//
// Devnet only, by design: it refuses to run against a mainnet RPC.
import {
  address,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  lamports,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { ataFor, KEYS, loadKeys, submitTx } from './devnet.mjs';

const RPC = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const WS = RPC.replace(/^http/, 'ws');
const DECIMALS = 6;
const SUPPLY = 1_000_000_000n; // whole tokens, before decimals
const AIRDROP = 2_000_000_000n; // lamports

if (!/devnet|localhost|127\.0\.0\.1/.test(RPC))
  throw Error(`Refusing to run against ${RPC}. This script is for devnet only.`);

const rpc = createSolanaRpc(RPC);
const subs = createSolanaRpcSubscriptions(WS);
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });
const airdrop = airdropFactory({ rpc, rpcSubscriptions: subs });
const submit = (payer, ix) => submitTx(rpc, send, payer, ix);

async function fund(signer) {
  const balance = await rpc.getBalance(signer.address).send();
  if (BigInt(balance.value) >= AIRDROP / 2n) return;
  try {
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(AIRDROP),
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

async function main() {
  const target = process.argv.includes('--fund')
    ? process.argv[process.argv.indexOf('--fund') + 1]
    : null;
  // Seeds are written before anything can fail: the faucet is unreliable, and an operator who
  // funds the payer by hand must find the same payer waiting on the next run.
  const { signers } = await loadKeys(['payer', 'treasury', 'mint']);
  const { payer, treasury, mint } = signers;
  console.log(`Payer ${payer.address}`);
  await fund(payer);

  const existing = await rpc.getAccountInfo(mint.address).send();
  // The treasury must hold an initialised token account for the mint or every quote answers
  // 409 TREASURY.
  const openTreasury = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    mint: mint.address,
    owner: treasury.address,
  });
  if (!existing.value) {
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    // The treasury account rides along with the mint, so a fresh run costs one confirmation
    // rather than two.
    await submit(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: DECIMALS,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
      openTreasury,
    ]);
    console.log(`Created mint ${mint.address}`);
  } else {
    console.log(`Reusing mint ${mint.address}`);
    // Idempotent on chain, but still a signature and a confirmation, so only send it if the
    // account is genuinely missing.
    const ata = await ataFor(mint.address, treasury.address);
    if (!(await rpc.getAccountInfo(ata).send()).value) await submit(payer, [openTreasury]);
  }
  const treasuryAta = await ataFor(mint.address, treasury.address);
  console.log(`Treasury ${treasury.address} token account ${treasuryAta} ready`);

  if (target) {
    const owner = address(target);
    await submit(payer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, mint: mint.address, owner }),
      getMintToInstruction({
        mint: mint.address,
        token: await ataFor(mint.address, owner),
        mintAuthority: payer,
        amount: SUPPLY * 10n ** BigInt(DECIMALS),
      }),
    ]);
    console.log(`Minted ${SUPPLY.toLocaleString()} test tokens to ${owner}`);
  }

  console.log(`\nKeys saved to ${KEYS} (gitignored). Staging configuration:\n`);
  console.log(`  COIN_MINT=${mint.address}`);
  console.log(`  TREASURY_WALLET=${treasury.address}`);
  console.log(`  SOLANA_RPC_URL=${RPC}`);
  console.log('  PRICE_FIXED=1000');
  console.log('  COIN_TICKER=TESTCLENCH');
  console.log('  COIN_NAME=Testclench');
  console.log(
    '\nPRICE_FIXED is required: neither Jupiter nor pump.fun price devnet tokens, so without\n' +
      'it every quote fails with code PRICE. 1000 means a thousand tokens to the dollar.\n' +
      'Leave CLIENT_RPC_URL unset: the site hands the browser its own /api/rpc, and anything\n' +
      'set there is published to every visitor.',
  );
  console.log('\nFund a viewer wallet:  node scripts/testmint.mjs --fund <your-phantom-address>');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
