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
      // The builder reads the mint itself now, to learn which token program owns it and to
      // check the decimals the quote was denominated in still match the chain.
      if (new PublicKey(mint).equals(key)) {
        const record = Buffer.alloc(82);
        record[44] = 6;
        record[45] = 1;
        return { owner: p.TOKEN_PROGRAM, data: record };
      }
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

// ---- Token-2022. The show's own coin is one: pump.fun issues mints under that program, so a
// rule that only knew the older Token program refused the very asset the site discounts.
/** A mint record: 82 bytes of base, then, for Token-2022, the padding, kind byte and entries. */
function mintAccount(program, decimals, extensions) {
  const base = Buffer.alloc(82);
  base[44] = decimals;
  base[45] = 1;
  if (!extensions) return { owner: program, data: base };
  const tlv = Buffer.concat(
    extensions.map((type) => {
      const entry = Buffer.alloc(4);
      entry.writeUInt16LE(type, 0);
      entry.writeUInt16LE(0, 2);
      return entry;
    }),
  );
  const padded = Buffer.alloc(166);
  base.copy(padded, 0);
  padded[165] = 1;
  return { owner: program, data: Buffer.concat([padded, tlv]) };
}
const mintReader = (account) => ({
  async getAccountInfo() {
    return account;
  },
});

void test('a Token-2022 mint carrying only metadata is payable, and says which program owns it', async () => {
  const metadata = mintAccount(p.TOKEN_2022_PROGRAM, 6, [18, 19]);
  assert.deepEqual(await p.tokenInfo(mintReader(metadata), p.USDC_MINT), {
    decimals: 6,
    program: p.TOKEN_2022_PROGRAM,
  });
  // A Token-2022 mint that declared no extensions at all is the plain 82-byte record.
  assert.deepEqual(
    await p.tokenInfo(mintReader(mintAccount(p.TOKEN_2022_PROGRAM, 9, null)), p.USDC_MINT),
    { decimals: 9, program: p.TOKEN_2022_PROGRAM },
  );
  assert.deepEqual(
    await p.tokenInfo(mintReader(mintAccount(p.TOKEN_PROGRAM, 6, null)), p.USDC_MINT),
    { decimals: 6, program: p.TOKEN_PROGRAM },
  );
});

void test('a mint that can take a cut, redirect or halt a transfer stays closed', async () => {
  // 1 transfer fee, 14 transfer hook, 12 permanent delegate, 26 pausable, 25 scaled UI amount,
  // 6 default account state, 4 confidential transfers.
  for (const extension of [1, 14, 12, 26, 25, 6, 4]) {
    await assert.rejects(
      p.tokenInfo(
        mintReader(mintAccount(p.TOKEN_2022_PROGRAM, 6, [18, 19, extension])),
        p.USDC_MINT,
      ),
      (e) => e.code === 'MINT',
      `extension ${extension} must not be payable`,
    );
  }
  // An entry running off the end of the record, and a mint owned by neither token program.
  const truncated = mintAccount(p.TOKEN_2022_PROGRAM, 6, [18]);
  truncated.data.writeUInt16LE(400, 168);
  await assert.rejects(p.tokenInfo(mintReader(truncated), p.USDC_MINT), (e) => e.code === 'MINT');
  await assert.rejects(
    p.tokenInfo(mintReader(mintAccount(Keypair.generate().publicKey, 6, null)), p.USDC_MINT),
    (e) => e.code === 'MINT',
  );
  // The older program never carries extensions: a longer record under it is not a mint.
  await assert.rejects(
    p.tokenInfo(mintReader(mintAccount(p.TOKEN_PROGRAM, 6, [18])), p.USDC_MINT),
    (e) => e.code === 'MINT',
  );
});

void test('the token program is one of the account seeds, so each program addresses its own', () => {
  const owner = Keypair.generate().publicKey.toBase58(),
    mint = Keypair.generate().publicKey.toBase58();
  assert.notEqual(
    p.ata(owner, mint, p.TOKEN_PROGRAM).toBase58(),
    p.ata(owner, mint, p.TOKEN_2022_PROGRAM).toBase58(),
  );
  assert.equal(p.ata(owner, mint).toBase58(), p.ata(owner, mint, p.TOKEN_PROGRAM).toBase58());
});

void test('a Token-2022 balance is read from that program’s account, extensions and all', async () => {
  const owner = Keypair.generate().publicKey.toBase58(),
    mint = Keypair.generate().publicKey.toBase58();
  // What a Token-2022 associated account looks like on chain: 165 bytes, the kind byte, then
  // ImmutableOwner. The same wallet has nothing at the older program's address.
  const data = Buffer.alloc(170);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(4200), 64);
  data[108] = 1;
  data[165] = 2;
  data.writeUInt16LE(7, 166);
  const at = p.ata(owner, mint, p.TOKEN_2022_PROGRAM);
  const c = {
    async getBalance() {
      return 500;
    },
    async getAccountInfo(key) {
      return at.equals(key) ? { owner: p.TOKEN_2022_PROGRAM, data } : null;
    },
  };
  assert.deepEqual(await p.spendable(c, owner, mint, p.TOKEN_2022_PROGRAM), {
    sol: BigInt(500),
    tokens: BigInt(4200),
    hasAta: true,
  });
  assert.equal((await p.spendable(c, owner, mint)).hasAta, false);
});

void test('a Token-2022 payment verifies against that program’s accounts and no other', () => {
  const f = splFixture('FROGCLENCH');
  const payer = f.tx.transaction.message.accountKeys[0].pubkey;
  const ix = f.tx.transaction.message.instructions.find(
    (i) => i.parsed?.type === 'transferChecked',
  );
  ix.programId = p.TOKEN_2022_PROGRAM.toBase58();
  ix.parsed.info.source = p.ata(payer, f.fields.mint, p.TOKEN_2022_PROGRAM).toBase58();
  const destination = p.ata(f.fields.recipient, f.fields.mint, p.TOKEN_2022_PROGRAM).toBase58();
  ix.parsed.info.destination = destination;
  f.tx.transaction.message.accountKeys[2].pubkey = destination;
  assert.deepEqual(p.checkSponsorTransfer(f.tx, f.fields), {
    payer,
    blockTime: 101,
  });
  // The older program's addresses for the same wallet and mint must not settle it.
  const crossed = JSON.parse(JSON.stringify(f.tx));
  crossed.transaction.message.instructions.find(
    (i) => i.parsed?.type === 'transferChecked',
  ).parsed.info.destination = p.ata(f.fields.recipient, f.fields.mint).toBase58();
  assert.equal(p.checkSponsorTransfer(crossed, f.fields), null);
});
