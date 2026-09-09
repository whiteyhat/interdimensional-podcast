import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['requests', 'sponsorship', 'sponsor-pay']);
const p = await import('../work/tests/sponsor-pay.js');
const expect = {
  asset: 'SOL',
  recipient: 'treasury',
  reference: '11111111111111111111111111111111',
  amount_base: '500',
  mint: null,
  issued_at: 100000,
};
function native() {
  return {
    blockTime: 101,
    meta: { err: null, preBalances: [1000, 0, 0], postBalances: [400, 500, 0] },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: 'payer', signer: true },
          { pubkey: 'treasury', signer: false },
          { pubkey: '11111111111111111111111111111111', signer: false },
        ],
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: { source: 'payer', destination: 'treasury', lamports: 500 },
            },
          },
        ],
      },
    },
  };
}
void test('native SOL transfer verifies actual signed payer and exact amount', () => {
  assert.deepEqual(p.checkSponsorTransfer(native(), expect), {
    payer: 'payer',
    blockTime: 101,
  });
  const wrong = native();
  wrong.transaction.message.instructions[0].parsed.info.lamports = 499;
  assert.equal(p.checkSponsorTransfer(wrong, expect), null);
});
void test('a reference or treasury balance delta alone never proves payment', () => {
  const wrong = native();
  wrong.transaction.message.instructions = [];
  assert.equal(p.checkSponsorTransfer(wrong, expect), null);
  const old = native();
  old.blockTime = 50;
  assert.equal(p.checkSponsorTransfer(old, expect), null);
  const failed = native();
  failed.meta.err = { InstructionError: [0, 'fail'] };
  assert.equal(p.checkSponsorTransfer(failed, expect), null);
});
void test('recovery scans past malicious earlier signatures and paginates', async () => {
  const calls = [];
  const rpc = {
    async getSignaturesForAddress(_ref, opts) {
      calls.push(opts.before);
      return opts.before
        ? [{ signature: 'valid', err: null }]
        : [
            { signature: 'invalid', err: null },
            { signature: 'failed', err: { error: 1 } },
          ];
    },
    async getParsedTransaction(sig) {
      if (sig === 'valid') return native();
      const invalid = native();
      invalid.transaction.message.instructions = [];
      return invalid;
    },
  };
  const r = await p.scanSponsorReference(
    rpc,
    {
      ...expect,
      reference: '11111111111111111111111111111111',
      scan_before: null,
    },
    { pageSize: 2, maxPages: 2 },
  );
  assert.equal(r.payments[0].signature, 'valid');
  assert.equal(r.complete, true);
  assert.deepEqual(calls, [undefined, 'failed']);
});
void test('a finalized reference whose transaction body is unavailable keeps recovery ambiguous', async () => {
  const rpc = {
    async getSignaturesForAddress() {
      return [{ signature: 'unavailable', err: null }];
    },
    async getParsedTransaction() {
      return null;
    },
  };
  const r = await p.scanSponsorReference(rpc, { ...expect, scan_before: null });
  assert.equal(r.complete, false);
  assert.equal(r.before, null);
});
const { Keypair, PublicKey } = await import('@solana/web3.js');
function splFixture(asset = 'USDC') {
  const wallet = Keypair.generate().publicKey.toBase58(),
    treasury = Keypair.generate().publicKey.toBase58(),
    mint =
      asset === 'USDC' ? p.USDC_MINT : Keypair.generate().publicKey.toBase58(),
    reference = Keypair.generate().publicKey.toBase58();
  const source = p.ata(wallet, mint).toBase58(),
    destination = p.ata(treasury, mint).toBase58();
  return {
    fields: {
      asset,
      recipient: treasury,
      reference,
      amount_base: '500',
      mint,
      issued_at: 100000,
    },
    tx: {
      blockTime: 101,
      meta: {
        err: null,
        preBalances: [1000, 0, 0, 0],
        postBalances: [500, 0, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: treasury,
            uiTokenAmount: { amount: '100' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: treasury,
            uiTokenAmount: { amount: '600' },
          },
        ],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: wallet, signer: true },
            { pubkey: source, signer: false },
            { pubkey: destination, signer: false },
            { pubkey: reference, signer: false },
          ],
          instructions: [
            {
              programId: p.TOKEN_PROGRAM.toBase58(),
              parsed: {
                type: 'transferChecked',
                info: {
                  source,
                  destination,
                  mint,
                  authority: wallet,
                  tokenAmount: { amount: '500', decimals: 6 },
                },
              },
            },
          ],
        },
      },
    },
  };
}
void test('USDC and FROG accept only the exact mint, direct authority, canonical source and credited amount', () => {
  for (const asset of ['USDC', 'FROGCLENCH']) {
    const f = splFixture(asset);
    assert.ok(p.checkSponsorTransfer(f.tx, f.fields));
    for (const field of ['mint', 'authority', 'source', 'destination']) {
      const wrong = structuredClone(f.tx);
      wrong.transaction.message.instructions[0].parsed.info[field] =
        Keypair.generate().publicKey.toBase58();
      assert.equal(p.checkSponsorTransfer(wrong, f.fields), null);
    }
    const short = structuredClone(f.tx);
    short.meta.postTokenBalances[0].uiTokenAmount.amount = '599';
    assert.equal(p.checkSponsorTransfer(short, f.fields), null);
  }
});
void test('spendable rejects frozen accounts and requires SOL separately from token funds', async () => {
  const wallet = Keypair.generate().publicKey.toBase58(),
    recipient = Keypair.generate().publicKey.toBase58(),
    mint = Keypair.generate().publicKey.toBase58();
  let frozen = false;
  const c = {
    async getBalance() {
      return 500;
    },
    async getAccountInfo(key) {
      const owner = p.ata(wallet, mint).equals(key) ? wallet : recipient;
      const data = Buffer.alloc(165);
      new PublicKey(mint).toBuffer().copy(data, 0);
      new PublicKey(owner).toBuffer().copy(data, 32);
      data.writeBigUInt64LE(BigInt(10000), 64);
      data[108] = frozen ? 2 : 1;
      return { owner: p.TOKEN_PROGRAM, data };
    },
    async getLatestBlockhash() {
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      };
    },
    async getFeeForMessage() {
      return { value: 11000 };
    },
  };
  assert.equal((await p.spendable(c, wallet, mint)).tokens, BigInt(10000));
  await assert.rejects(
    p.buildSponsorTransaction(c, {
      wallet,
      recipient,
      mint,
      amountBase: '500',
      decimals: 6,
      reference: Keypair.generate().publicKey.toBase58(),
    }),
    (e) => e.code === 'SOL_FEE',
  );
  frozen = true;
  await assert.rejects(
    p.spendable(c, wallet, mint),
    (e) => e.code === 'ACCOUNT',
  );
});
void test('a custom referenced transfer without the immutable cosigner cannot cross-credit a legacy purchase', () => {
  const f = native();
  assert.equal(
    p.checkSponsorTransfer(f, { ...expect, unsigned_tx: null }),
    null,
  );
});
