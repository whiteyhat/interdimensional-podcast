// Browser rehearsal against local UI with deterministic payment responses. No chain calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
const base = process.env.SPONSOR_TEST_ORIGIN || 'http://127.0.0.1:3316';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
let online = true,
  receipt = null,
  quotes = 0;
const assetList = ['USDC', 'SOL', 'FROGCLENCH'];
const catalog = () => ({
  products: [
    ['message', 500],
    ['spotlight', 2500],
    ['cap', 10000],
  ].map(([id, priceCents]) => ({
    id,
    title: id,
    priceCents,
    frogPriceCents: priceCents * 0.7,
    available: online && id !== 'cap',
    reason: !online
      ? 'The studio is offline.'
      : id === 'cap'
        ? 'Caps are completing their broadcast trial.'
        : null,
  })),
  assets: assetList.map((id) => ({
    id,
    mint: id === 'SOL' ? null : '11111111111111111111111111111111',
    decimals: 6,
    available: true,
    reason: null,
    priceUsd: '1',
  })),
  studioOnline: online,
  capabilities: { message: true, spotlight: true, cap: false },
  treasury: '11111111111111111111111111111111',
  clientRpcUrl: '/api/rpc',
  now: Date.now(),
});
async function setup(viewport, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport, reducedMotion });
  await context.route('**/api/interact?*', (r) =>
    r.fulfill({
      json: {
        launched: false,
        ticker: 'FROGCLENCH',
        name: 'Frogclench',
        treasury: null,
        buyUrl: null,
        interactUsd: 5,
        studioOnline: online,
        streamEmbedUrl: null,
        links: { pumpfun: null, x: null },
        queued: 0,
        clientRpcUrl: '/api/rpc',
      },
    }),
  );
  await context.route('**/api/sponsorship*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname !== '/api/sponsorship')
      return route.fulfill({
        status: 503,
        json: { error: 'Artwork is not connected in this browser rehearsal.' },
      });
    let result;
    if (request.method() === 'GET')
      result =
        url.searchParams.get('action') === 'catalog'
          ? catalog()
          : url.searchParams.get('action') === 'activity'
            ? { orders: [] }
            : { receipt };
    else {
      const body = request.postDataJSON();
      if (body.action === 'draft') {
        receipt = {
          id: 'order-browser-rehearsal',
          token: 'a'.repeat(64),
          status: 'draft',
          draft: body.draft,
          priceCents: 2500,
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
          queuePosition: null,
        };
        result = { receipt };
      } else if (body.action === 'quote') {
        quotes++;
        receipt.status = 'payment-pending';
        const attempt = {
          id: 'attempt-one',
          asset: body.asset,
          amountBase: '17500000',
          amountUi: '17.5',
          decimals: 6,
          priceCents: 1750,
          priceUsd: '1',
          reference: '11111111111111111111111111111111',
          recipient: '11111111111111111111111111111111',
          mint: '11111111111111111111111111111111',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          lastValidBlockHeight: 100,
          status: 'issued',
          broadcastSignature: null,
          verifiedSignature: null,
          solanaPayUrl:
            'solana:' +
            encodeURIComponent(
              'https://staging.example.test/api/solana-pay/test-capability',
            ),
        };
        receipt.attempts = [attempt];
        result = { receipt, attempt, solanaPayUrl: attempt.solanaPayUrl };
      } else result = { receipt };
    }
    return route.fulfill({ json: result });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('Browser error:', e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.sponsor-panel h2').waitFor();
  return { context, page };
}
try {
  await mkdir('work/sponsor-browser', { recursive: true });
  const { context, page } = await setup({ width: 1440, height: 1100 });
  const panel = page.locator('.sponsor-panel');
  const noTyping =
    '.sponsor-form input:not([type=radio]):not([type=file]), .sponsor-form textarea';
  assert.equal(
    await panel.locator(noTyping).count(),
    0,
    'the first step asks the customer to type nothing',
  );
  const tile = (value) =>
    panel.locator('.sponsor-product', {
      has: page.locator(`input[value="${value}"]`),
    });
  assert.match(await tile('spotlight').innerText(), /Top seller/i);
  assert.match(await tile('cap').innerText(), /Most value/i);
  // Choosing a product may never move what the customer is aiming at.
  const anchors = () =>
    page.evaluate(() => {
      const top = (s) =>
        Math.round(document.querySelector(s).getBoundingClientRect().top);
      return [top('.sponsor-products'), top('.sponsor-form .sponsor-button')];
    });
  const resting = await anchors();
  for (const value of ['cap', 'message', 'spotlight']) {
    await panel
      .locator(`input[name="sponsor-product"][value="${value}"]`)
      .check({ force: true });
    assert.deepEqual(
      await anchors(),
      resting,
      `choosing ${value} moved the cards or the button`,
    );
  }
  await panel
    .locator('input[name="sponsor-product"][value="spotlight"]')
    .check({ force: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: 'work/sponsor-browser/desktop-choose.png',
    fullPage: true,
  });
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.equal(
    await panel.locator('#sponsor-name').count(),
    0,
    'the on-air name is never asked for',
  );
  await panel.getByRole('button', { name: 'Continue to payment' }).click();
  assert.equal(
    await page
      .locator('#sponsor-projectName')
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.locator('#sponsor-projectName').fill('Trench Builders');
  await panel.getByRole('button', { name: 'Continue to payment' }).click();
  assert.equal(
    await page
      .locator('#sponsor-message')
      .evaluate((e) => e === document.activeElement),
    true,
    'the second step points at the only field still missing',
  );
  await page
    .locator('#sponsor-message')
    .fill(
      'Tell the room about the builders still shipping through the bear market.',
    );
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: 'work/sponsor-browser/desktop-write.png',
    fullPage: true,
  });
  await page.reload({ waitUntil: 'networkidle' });
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.equal(
    await page.locator('#sponsor-projectName').inputValue(),
    'Trench Builders',
    'a reload keeps what was already written',
  );
  await panel.getByRole('button', { name: 'Continue to payment' }).click();
  assert.equal(
    await panel
      .locator('input[name="sponsor-asset"][value="USDC"]')
      .isChecked(),
    true,
  );
  await panel
    .locator('input[name="sponsor-asset"][value="FROGCLENCH"]')
    .check({ force: true });
  assert.match(
    await panel.locator('.sponsor-review-summary').innerText(),
    /17\.50/,
  );
  await panel.getByRole('button', { name: 'Scan to pay' }).click();
  await panel.locator('.sponsor-qr svg').waitFor();
  assert.equal(quotes, 1);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: 'work/sponsor-browser/desktop-pay.png',
    fullPage: true,
  });
  await page.reload({ waitUntil: 'networkidle' });
  await panel.getByRole('button', { name: 'Scan to pay' }).waitFor();
  assert.equal(quotes, 1, 'reload resumes without creating a second attempt');
  assert.match(
    await panel.locator('.sponsor-review-summary').innerText(),
    /17\.50/,
  );
  receipt.status = 'paid';
  receipt.paidAt = Date.now();
  receipt.queuePosition = 2;
  receipt.attempts[0].status = 'verified';
  receipt.attempts[0].verifiedSignature = '2'.repeat(88);
  await panel
    .getByRole('heading', { name: 'You’re in the queue' })
    .waitFor({ timeout: 10000 });
  // The payment the viewer just watched confirm is celebrated, once.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('canvas')].some(
        (c) => c.style.zIndex === '1000' && c.style.pointerEvents === 'none',
      ),
    null,
    { timeout: 3000 },
  );
  assert.match(await panel.locator('.sponsor-queue-position').innerText(), /2/);
  receipt.status = 'paused';
  receipt.canReschedule = true;
  await panel
    .getByRole('heading', { name: 'Saved for the next live slot' })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await panel.getByRole('button', { name: /refund/i }).count(),
    0,
    'every placement is final once paid',
  );
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: 'work/sponsor-browser/desktop-receipt.png',
    fullPage: true,
  });
  // A paid pass is never a dead end: the placements are always one tap away.
  await panel.getByRole('button', { name: 'Create another moment' }).click();
  await panel
    .locator('input[name="sponsor-product"]')
    .first()
    .waitFor({ state: 'attached', timeout: 5000 });
  assert.match(
    await panel.locator('.sponsor-stepper-item.active').innerText(),
    /choose/i,
  );
  await context.close();
  online = false;
  receipt = null;
  const mobile = await setup({ width: 320, height: 850 }, 'reduce');
  const mobilePanel = mobile.page.locator('.sponsor-panel');
  await mobilePanel
    .locator('input[name="sponsor-product"][value="cap"]')
    .check({ force: true });
  await mobile.page
    .locator('input[name="sponsor-product"][value="cap"]')
    .focus();
  await mobile.page.keyboard.press('ArrowLeft');
  assert.equal(
    await mobilePanel
      .locator('input[name="sponsor-product"][value="spotlight"]')
      .isChecked(),
    true,
    'native radio keyboard navigation',
  );
  assert.match(
    await mobilePanel.locator('.sponsor-checkout-note').innerText(),
    /offline|off air/i,
  );
  await mobilePanel
    .locator('input[name="sponsor-product"][value="cap"]')
    .check({ force: true });
  await mobilePanel
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await mobile.page
    .locator('#sponsor-projectName')
    .fill('A deliberately long project title');
  const metrics = await mobile.page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    inputs: [
      ...document.querySelectorAll(
        '.sponsor-form input:not([type=radio]):not([type=file]),.sponsor-form textarea,.sponsor-form select',
      ),
    ].map((e) => getComputedStyle(e).fontSize),
    motion: getComputedStyle(document.querySelector('.sponsor-preview-light'))
      .display,
  }));
  assert.ok(metrics.width <= metrics.viewport, JSON.stringify(metrics));
  assert.ok(
    metrics.inputs.every((n) => parseFloat(n) >= 16),
    JSON.stringify(metrics),
  );
  assert.equal(metrics.motion, 'none');
  assert.ok(
    await mobile.page.evaluate(
      () =>
        document.querySelector('.stream-soon').getBoundingClientRect().bottom <=
        document.querySelector('.stream-embed').getBoundingClientRect().bottom,
    ),
    'the off-air message fits at 320px',
  );
  await mobile.page.evaluate(() =>
    window.scrollTo({ top: 0, behavior: 'instant' }),
  );
  await mobile.page.screenshot({
    path: 'work/sponsor-browser/mobile-320.png',
    fullPage: true,
  });
  await mobile.context.close();
  console.log(
    'Browser rehearsal passed: three steps with no typing on the first, a layout that never moves when a product is chosen, value badges, draft reload, discount, validation focus, QR recovery, payment confetti, receipts that always lead back, no refunds, 320px reflow, 16px inputs, native keyboard, reduced motion.',
  );
} catch (e) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      console.error(
        (
          await page
            .locator('[data-vinext-dev-error-overlay]')
            .textContent()
            .catch(() => '')
        )?.slice(0, 4500),
      );
      await page
        .screenshot({
          path: 'work/sponsor-browser/failure.png',
          fullPage: true,
        })
        .catch(() => {});
    }
  throw e;
} finally {
  await browser.close();
}
