// The real wallet adapter and checkout UI, with an isolated fake wallet and no chain calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import {
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  PublicKey,
} from '@solana/web3.js';
const buyer = Keypair.generate(),
  cosigner = Keypair.generate(),
  treasury = Keypair.generate();
const tx = new Transaction({
  feePayer: buyer.publicKey,
  blockhash: Keypair.generate().publicKey.toBase58(),
  lastValidBlockHeight: 200,
}).add(
  SystemProgram.transfer({
    fromPubkey: buyer.publicKey,
    toPubkey: treasury.publicKey,
    lamports: 50000000,
  }),
  new TransactionInstruction({
    programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    keys: [{ pubkey: cosigner.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from('sponsorship-test'),
  }),
);
tx.partialSign(cosigner);
const wire = tx.serialize({ requireAllSignatures: false }).toString('base64');
tx.partialSign(buyer);
const signed = Array.from(tx.serialize());
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
let drafts = 0,
  attempts = 0,
  submits = 0,
  confirms = 0,
  receipt = null;
try {
  await context.addInitScript(
    ({ walletBytes, signed }) => {
      window.__walletReject = true;
      window.__signCalls = 0;
      window.isPhantomInstalled = true;
      const provider = {
        isPhantom: true,
        isConnected: false,
        publicKey: { toBytes: () => Uint8Array.from(walletBytes) },
        on() {},
        off() {},
        removeListener() {},
        async connect() {
          this.isConnected = true;
          return { publicKey: this.publicKey };
        },
        async disconnect() {
          this.isConnected = false;
        },
        async signTransaction() {
          window.__signCalls++;
          if (window.__walletReject) throw Error('User rejected approval');
          return { serialize: () => Uint8Array.from(signed) };
        },
      };
      window.phantom = { solana: provider };
      window.solana = provider;
    },
    { walletBytes: Array.from(buyer.publicKey.toBytes()), signed },
  );
  await context.route('**/api/interact?*', (r) =>
    r.fulfill({
      json: {
        launched: false,
        ticker: 'FROGCLENCH',
        studioOnline: true,
        clientRpcUrl: '/api/rpc',
        links: {},
      },
    }),
  );
  await context.route('**/api/sponsorship*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    let data;
    if (request.method() === 'GET')
      data =
        url.searchParams.get('action') === 'catalog'
          ? {
              products: [
                {
                  id: 'message',
                  priceCents: 500,
                  frogPriceCents: 350,
                  available: true,
                },
              ],
              assets: [
                { id: 'USDC', available: true },
                { id: 'SOL', available: true },
                { id: 'FROGCLENCH', available: true },
              ],
              studioOnline: true,
              capabilities: { message: true, spotlight: true, cap: false },
              clientRpcUrl: '/api/rpc',
            }
          : url.searchParams.get('action') === 'activity'
            ? { orders: [] }
            : { receipt };
    else {
      const b = request.postDataJSON();
      if (b.action === 'draft') {
        drafts++;
        receipt = {
          id: 'wallet-test',
          token: 'b'.repeat(64),
          status: 'draft',
          draft: b.draft,
          priceCents: 500,
          attempts: [],
          fulfillment: {
            visibleMs: 0,
            appearances: 0,
            intro: false,
            callback: false,
            startedAt: null,
            completedAt: null,
          },
          paidAt: null,
          payer: null,
          canReschedule: false,
          assetUrl: null,
        };
        data = { receipt };
      } else if (b.action === 'quote') {
        assert.equal(b.token, receipt.token, 'retries keep the original order');
        attempts++;
        const attempt = {
          id: `attempt-${attempts}`,
          asset: 'SOL',
          amountBase: '50000000',
          amountUi: '0.05',
          decimals: 9,
          priceCents: 500,
          priceUsd: '100',
          reference: cosigner.publicKey.toBase58(),
          recipient: treasury.publicKey.toBase58(),
          mint: null,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          lastValidBlockHeight: 200,
          status: 'issued',
          broadcastSignature: null,
          verifiedSignature: null,
          solanaPayUrl: 'solana:https%3A%2F%2Fexample.test%2Fpay',
        };
        receipt.status = 'payment-pending';
        receipt.attempts = [attempt, ...receipt.attempts];
        data = { receipt, attempt, transaction: wire };
      } else if (b.action === 'submit') {
        submits++;
        const sent = Transaction.from(Buffer.from(b.signedTx, 'base64'));
        assert.equal(
          sent.verifySignatures(),
          true,
          'wallet preserves the server cosignature',
        );
        assert.equal(sent.signatures.length, 2);
        return route.abort('failed');
      } else {
        if (b.action === 'confirm') confirms++;
        data = { receipt };
      }
    }
    return route.fulfill({ json: data });
  });
  const page = await context.newPage();
  await page.goto(process.env.SPONSOR_TEST_ORIGIN || 'http://127.0.0.1:3316', {
    waitUntil: 'networkidle',
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .locator('#sponsor-message')
    .fill('Ask Chad about builders in the trenches.');
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page
    .locator('input[name="sponsor-asset"][value="SOL"]')
    .check({ force: true });
  await page.getByRole('button', { name: 'Select Wallet' }).click();
  // Choosing the wallet is the whole gesture. A second "Connect" click used to be required,
  // and a viewer who did not know it saw a checkout where nothing happened.
  await page.getByRole('button', { name: /Phantom/ }).click();
  await page.getByRole('button', { name: 'Review wallet payment' }).click();
  await page.getByRole('button', { name: 'Approve and pay' }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.sponsor-wallet output')
      ?.textContent.includes('rejected'),
  );
  assert.equal(submits, 0);
  assert.equal(attempts, 1);
  await page.evaluate(() => {
    window.__walletReject = false;
  });
  await page.getByRole('button', { name: 'Approve and pay' }).click();
  await page
    .getByText('Your wallet may have sent this payment.')
    .waitFor({ timeout: 10000 });
  assert.equal(submits, 1);
  assert.equal(attempts, 1);
  assert.equal(await page.evaluate(() => window.__signCalls), 2);
  assert.ok(confirms > 0);
  assert.equal(
    await page.getByRole('button', { name: 'Approve and pay' }).count(),
    0,
  );
  await page.clock.setFixedTime(Date.now() + 61000);
  await page.waitForTimeout(1100);
  receipt.attempts[0].expiresAt = Date.now() - 1000;
  assert.equal(
    await page.getByRole('button', { name: 'Review wallet payment' }).count(),
    0,
    'an elapsed quote window does not resolve an ambiguous payment',
  );
  await page.clock.setFixedTime(Date.now());
  receipt.attempts[0].status = 'expired';
  await page.getByRole('button', { name: 'Check again' }).click();
  await page
    .getByRole('button', { name: 'Review wallet payment' })
    .waitFor({ timeout: 3000 });
  assert.equal(
    attempts,
    1,
    'verified expiry never creates an automatic payment',
  );
  await page.getByRole('button', { name: 'Review wallet payment' }).click();
  await page.getByRole('button', { name: 'Approve and pay' }).click();
  await page
    .getByText('Your wallet may have sent this payment.')
    .waitFor({ timeout: 10000 });
  assert.equal(attempts, 2);
  assert.equal(drafts, 1);
  assert.equal(
    await page.getByRole('button', { name: 'Review wallet payment' }).count(),
    0,
    'an expired older attempt must not unlock the current payment',
  );
  receipt.attempts[0].status = 'expired';
  receipt.attempts[0].expiresAt = Date.now() - 1000;
  await page
    .getByRole('button', { name: 'Review wallet payment' })
    .waitFor({ timeout: 8000 });
  assert.equal(attempts, 2, 'receipt polling also recovers verified expiry');
  await page.getByRole('button', { name: 'Review wallet payment' }).click();
  await page.getByRole('button', { name: 'Approve and pay' }).click();
  await page
    .getByText('Your wallet may have sent this payment.')
    .waitFor({ timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    attempts,
    3,
    'reload must recover before asking for a new transaction',
  );
  assert.equal(drafts, 1);
  assert.equal(submits, 3);
  receipt.attempts[0].status = 'expired';
  receipt.attempts[1].status = 'verified';
  receipt.status = 'paid';
  receipt.paidAt = Date.now();
  await page
    .getByRole('region', { name: 'Your sponsorship receipt' })
    .waitFor({ timeout: 8000 });
  assert.equal(await page.locator('.sponsor-wallet').count(), 0);
  assert.equal(attempts, 3, 'a paid order never reopens checkout');
  console.log(
    'Wallet browser rehearsal passed: rejection sends nothing; lost relay responses retain the current attempt; verified expiry recovers the same order through confirmation and polling; older expiry cannot unlock a current payment; paid receipts win; reload creates no payment.',
  );
} catch (e) {
  for (const p of context.pages())
    console.error(
      (
        await p
          .locator('.sponsor-panel')
          .innerText()
          .catch(() => '')
      )?.slice(0, 2500),
    );
  throw e;
} finally {
  await context.close();
  await browser.close();
}
