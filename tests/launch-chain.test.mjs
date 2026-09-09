import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import BN from 'bn.js';
import { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, AccountState, AccountType, ExtensionType, MintLayout } from '@solana/spl-token';
import { pack as packTokenMetadata } from '@solana/spl-token-metadata';
import { buildPrepared } from '../scripts/launch/chain.mjs';
import { PUMP, TOKEN_2022, associated, decodeTx, pda, reviewPrepared } from '../lib/launch/artifact.mjs';
import { launchFixture } from './fixtures/launch.mjs';

const { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA } = createRequire(import.meta.url)('@pump-fun/pump-sdk');
const LOOKUP_TABLE = new PublicKey('7y3623xaVQzsLxHRyp1wQD4Pmer5JjgbaagGFAEqCjua');
const MINT_RENT = 3_000_000;
const ACCOUNT_RENT = 2_039_280;
const FEE = 10_000;

function encodedAccount(name, value) {
  // The pinned Global account is 1,045 bytes; Anchor's convenience encoder has
  // a 1,000-byte scratch buffer. Use that same IDL coder's layout with enough room.
  const { layout, discriminator } = PUMP_SDK.offlinePumpProgram.coder.accounts.accountLayouts.get(name);
  const buffer = Buffer.alloc(4096);
  const size = layout.encode(value, buffer);
  return Buffer.concat([Buffer.from(discriminator), buffer.subarray(0, size)]);
}
const accountInfo = (data, owner = SystemProgram.programId, lamports = 100_000_000) => ({ data, owner, lamports, executable: false, rentEpoch: 0 });

async function buildFixture() {
  const fixture = await launchFixture();
  const { artifact: base, creator, mint } = fixture;
  const config = { ...base, priorityMicroLamports: '0' };
  const state = { id: base.id, mint: base.mint, revision: 0, submissions: [] };
  const creatorAta = associated(mint.publicKey, creator.publicKey);
  const buy = fixture.instructions[4];
  const global = {
    initialized: true, authority: creator.publicKey, feeRecipient: buy.keys[1].pubkey,
    initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'),
    initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'),
    feeBasisPoints: new BN(100), withdrawAuthority: creator.publicKey, enableMigrate: true,
    poolMigrationFee: new BN(0), creatorFeeBasisPoints: new BN(50),
    feeRecipients: Array(7).fill(buy.keys[1].pubkey), setCreatorAuthority: creator.publicKey,
    adminSetCreatorAuthority: creator.publicKey, createV2Enabled: true, whitelistPda: PublicKey.default,
    reservedFeeRecipient: buy.keys[1].pubkey, mayhemModeEnabled: false,
    reservedFeeRecipients: Array(7).fill(buy.keys[1].pubkey), isCashbackEnabled: false,
    buybackFeeRecipients: Array(8).fill(buy.keys[17].pubkey), buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('30000000000'), whitelistedQuoteMints: [PublicKey.default],
  };
  const fees = { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) };
  const feeConfig = { bump: 1, admin: creator.publicKey, flatFees: fees,
    feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees }], stableFeeTiers: [] };
  const accounts = new Map([
    [GLOBAL_PDA.toBase58(), accountInfo(encodedAccount('global', global), PUMP)],
    [PUMP_FEE_CONFIG_PDA.toBase58(), accountInfo(encodedAccount('feeConfig', feeConfig), PUMP_SDK.offlinePumpFeeProgram.programId)],
  ]);
  const table = new AddressLookupTableAccount({ key: LOOKUP_TABLE, state: fixture.table.state });
  const calls = [];
  const simulationTransactions = [];
  const connection = {
    getGenesisHash: async () => base.genesisHash,
    getAccountInfo: async key => accounts.get(key.toBase58()) ?? null,
    getAccountInfoAndContext: async key => ({ context: { slot: 100 }, value: accounts.get(key.toBase58()) ?? null }),
    getLatestBlockhash: async () => ({ blockhash: base.blockhash, lastValidBlockHeight: base.lastValidBlockHeight }),
    getAddressLookupTable: async key => ({ value: key.equals(table.key) ? table : null }),
    isBlockhashValid: async () => ({ value: true }),
    getMultipleAccountsInfo: async keys => keys.map(key => key.equals(mint.publicKey) || key.equals(creatorAta) ? null : accountInfo(Buffer.alloc(8))),
    simulateTransaction: async (transaction, options) => {
      simulationTransactions.push(transaction);
      assert.equal(options.sigVerify, false);
      assert.equal(options.replaceRecentBlockhash, false);
      return { value: { err: null, accounts: options.accounts.addresses.map(address => {
        const size = address === base.mint ? 350 : address === creatorAta.toBase58() ? 165 : 8;
        return { data: [Buffer.alloc(size).toString('base64'), 'base64'], owner: TOKEN_2022.toBase58(), lamports: MINT_RENT, executable: false, rentEpoch: 0 };
      }) } };
    },
    getFeeForMessage: async () => ({ value: FEE }),
    getMinimumBalanceForRentExemption: async size => size === 350 ? MINT_RENT : size === 165 ? ACCOUNT_RENT : 946_560,
    getBalance: async () => 1_000_000_000,
  };
  for (const [name, implementation] of Object.entries(connection)) {
    connection[name] = async (...args) => { calls.push({ name, args }); return implementation(...args); };
  }
  const build = (kind = 'create') => buildPrepared(config, state, mint, base.metadataUri, connection, kind);
  return { ...fixture, config, state, global, accounts, table, creatorAta, connection, calls, simulationTransactions, build };
}

void test('real buildPrepared runs the pinned SDK and creates one atomic transaction with the exact creator purchase ceiling', async () => {
  const f = await buildFixture();
  const estimate = BigInt(f.config.buyLamports) + BigInt(MINT_RENT + ACCOUNT_RENT + FEE);
  f.config.maxTotalLamports = estimate.toString();
  const artifact = await f.build();
  assert.equal(artifact.buyLamports, f.config.buyLamports);
  assert.equal(artifact.estimatedTotalLamports, estimate.toString());
  assert.equal(artifact.maxTotalLamports, estimate.toString());
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.mint, f.state.mint);
  assert.equal(artifact.creator, f.config.creator);
  assert.ok(BigInt(artifact.quotedTokens) > 0n);
  const transaction = decodeTx(artifact.transaction);
  const instructions = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: [f.table] }).instructions;
  assert.equal(instructions.length, 5, 'compute budget, create, creator ATA and initial buy remain in one transaction');
  assert.equal(instructions[4].data.readBigUInt64LE(16), BigInt(f.config.buyLamports));
  assert.equal(instructions[4].data.readBigUInt64LE(8), BigInt(artifact.quotedTokens));
  assert.ok(instructions[4].keys[6].pubkey.equals(f.creator.publicKey), 'only the declared creator is the buyer');
  assert.ok(instructions[3].keys[2].pubkey.equals(f.creator.publicKey), 'initial tokens are sent to the creator ATA');
  assert.ok(transaction.serialize().length <= 1232);
  assert.ok(transaction.signatures[0].every(byte => byte === 0), 'creator approval is still required');
  assert.ok(transaction.signatures[1].some(byte => byte !== 0), 'persisted mint identity supplies its partial signature');
  await reviewPrepared(artifact, f.connection);
  assert.equal(f.simulationTransactions.length, 1);
  assert.equal(f.calls.filter(call => call.name === 'getAccountInfoAndContext').length, 2, 'real OnlinePumpSdk fetched and decoded both account fixtures');
  assert.deepEqual(f.state, { id: f.artifact.id, mint: f.artifact.mint, revision: 0, submissions: [] }, 'preparation does not mutate or submit launch state');
});

void test('real builder rejects a total budget one lamport below simulated purchase, fee and rent costs', async () => {
  const f = await buildFixture();
  f.config.maxTotalLamports = (BigInt(f.config.buyLamports) + BigInt(MINT_RENT + ACCOUNT_RENT + FEE) - 1n).toString();
  await assert.rejects(f.build(), /exceeds maxTotalLamports/);
  assert.equal(f.calls.some(call => call.name === 'getBalance'), false, 'budget failure stops before wallet funding is checked');
});

void test('real builder rejects insufficient creator funding even when the configured total budget is sufficient', async () => {
  const f = await buildFixture();
  const estimate = Number(f.config.buyLamports) + MINT_RENT + ACCOUNT_RENT + FEE;
  f.connection.getBalance = async key => { assert.ok(key.equals(f.creator.publicKey)); return estimate - 1; };
  await assert.rejects(f.build(), /insufficient SOL/);
  assert.equal(f.simulationTransactions.length, 1);
});

void test('missing or inactive lookup tables reject an oversized atomic launch before simulation', async context => {
  for (const tableState of ['missing', 'inactive']) {
    await context.test(tableState, async () => {
      const f = await buildFixture();
      // Short names/URIs can fit without an ALT. These are still valid metadata
      // lengths, but force the atomic transaction over the wire-size ceiling.
      f.config.name = 'N'.repeat(32);
      f.config.symbol = 'S'.repeat(10);
      f.artifact.metadataUri = 'https://example.com/' + 'a'.repeat(180);
      const inactive = new AddressLookupTableAccount({ key: f.table.key, state: { ...f.table.state, deactivationSlot: 1n } });
      f.connection.getAddressLookupTable = async () => ({ value: tableState === 'missing' ? null : inactive });
      await assert.rejects(f.build(), /Atomic launch transaction exceeds Solana size limits/, tableState);
      assert.equal(f.simulationTransactions.length, 0, tableState);
    });
  }
});

void test('unresolved submissions stop the real builder before any RPC or SDK account lookup', async () => {
  for (const status of ['unknown', 'processed', 'confirmed']) {
    const f = await buildFixture();
    f.state.submissions.push({ status });
    await assert.rejects(f.build(), /earlier submission is unresolved/);
    assert.deepEqual(f.calls, [], status);
  }
});

async function addVerifiedTreasury(f, owner = new PublicKey(f.config.treasury)) {
  const metadata = Buffer.from(packTokenMetadata({ mint: f.mint.publicKey, updateAuthority: f.creator.publicKey,
    name: f.config.name, symbol: f.config.symbol, uri: f.artifact.metadataUri, additionalMetadata: [] }));
  const mintData = Buffer.alloc(ACCOUNT_SIZE + 1 + 4 + metadata.length);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  mintData[ACCOUNT_SIZE] = AccountType.Mint;
  mintData.writeUInt16LE(ExtensionType.TokenMetadata, ACCOUNT_SIZE + 1);
  mintData.writeUInt16LE(metadata.length, ACCOUNT_SIZE + 3);
  metadata.copy(mintData, ACCOUNT_SIZE + 5);
  f.accounts.set(f.mint.publicKey.toBase58(), accountInfo(mintData, TOKEN_2022));
  f.accounts.set(pda(PUMP, 'bonding-curve', f.mint.publicKey).toBase58(), accountInfo(encodedAccount('bondingCurve', {
    virtualTokenReserves: f.global.initialVirtualTokenReserves, virtualQuoteReserves: f.global.initialVirtualSolReserves,
    realTokenReserves: f.global.initialRealTokenReserves, realQuoteReserves: new BN(0), tokenTotalSupply: f.global.tokenTotalSupply,
    complete: false, creator: f.creator.publicKey, isMayhemMode: false, isCashbackCoin: false, quoteMint: PublicKey.default,
  }), PUMP));
  const treasuryData = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: f.mint.publicKey, owner, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default }, treasuryData);
  const treasuryAta = associated(f.mint.publicKey, new PublicKey(f.config.treasury));
  f.accounts.set(treasuryAta.toBase58(), accountInfo(treasuryData, TOKEN_2022));
  return treasuryAta;
}

void test('a verified existing treasury ATA does not produce a redundant transaction', async () => {
  const f = await buildFixture();
  await addVerifiedTreasury(f);
  await assert.rejects(f.build('treasury'), /already ready; no transaction is needed/);
  assert.equal(f.calls.some(call => call.name === 'getLatestBlockhash'), false);
  assert.equal(f.simulationTransactions.length, 0);
});

void test('treasury readiness rejects an existing token account with a different owner', async () => {
  const f = await buildFixture();
  await addVerifiedTreasury(f, PublicKey.default);
  await assert.rejects(f.build('treasury'), /Treasury token account does not match/);
  assert.equal(f.simulationTransactions.length, 0);
});
