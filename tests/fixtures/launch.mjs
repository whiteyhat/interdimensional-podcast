import { createRequire } from 'node:module';
import BN from 'bn.js';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
const { PUMP_SDK } = createRequire(import.meta.url)('@pump-fun/pump-sdk');
export async function launchFixture() {
  const creator = Keypair.generate(), mint = Keypair.generate();
  const a = { schemaVersion: 1, id: 'test-launch', revision: 1, kind: 'create', network: 'devnet',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', creator: creator.publicKey.toBase58(), treasury: creator.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(), name: 'Test', symbol: 'TEST', metadataUri: 'https://ipfs.io/ipfs/test',
    buyLamports: '1000000', maxTotalLamports: '50000000', quotedTokens: '1000', estimatedTotalLamports: '11000000',
    blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 390000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }),
    await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, creator: creator.publicKey, user: creator.publicKey, name: a.name, symbol: a.symbol, uri: a.metadataUri, mayhemMode: false, cashback: false }),
    createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey, true, TOKEN_2022_PROGRAM_ID), creator.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    await PUMP_SDK.getBuyInstructionRaw({ user: creator.publicKey, mint: mint.publicKey, creator: creator.publicKey, amount: new BN(a.quotedTokens), solAmount: new BN(a.buyLamports), tokenProgram: TOKEN_2022_PROGRAM_ID, feeRecipient: Keypair.generate().publicKey, buybackFeeRecipient: Keypair.generate().publicKey }),
  ];
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [...new Map(instructions.flatMap(x => x.keys).filter(k => !k.isSigner).map(k => [k.pubkey.toBase58(), k.pubkey])).values()] } });
  const build = (ix = instructions) => {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: a.blockhash, instructions: ix }).compileToV0Message([table]));
    tx.sign([mint]); return tx;
  };
  const tx = build();
  a.transaction = Buffer.from(tx.serialize()).toString('base64');
  a.messageHash = Buffer.from(await crypto.subtle.digest('SHA-256', tx.message.serialize())).toString('hex');
  const connection = { getGenesisHash: async () => a.genesisHash, isBlockhashValid: async () => ({ value: true }), getAddressLookupTable: async key => ({ value: key.equals(table.key) ? table : null }) };
  return { artifact: a, creator, mint, instructions, tx, build, table, connection, PublicKey };
}
