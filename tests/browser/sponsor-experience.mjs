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
  quotes = 0,
  uploads = 0,
  refuseUpload = false;
// One stored logo for the whole rehearsal: the desk's id is the sha of (logo, host, version).
const assetId = 'b'.repeat(64);
const logoUrl = `/api/sponsorship/assets/${assetId}?part=logo`;
const lookUrl = `/api/sponsorship/assets/${assetId}?part=look&v=${'c'.repeat(64)}`;
const replacements = [];
/** True once an <img> has loaded real pixels; false for a broken image. */
const loaded = (img) =>
  img.evaluate((el) =>
    el.complete
      ? el.naturalWidth > 0
      : new Promise((done) => {
          el.addEventListener('load', () => done(el.naturalWidth > 0), {
            once: true,
          });
          el.addEventListener('error', () => done(false), { once: true });
        }),
  );
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
    available: online,
    reason: !online ? 'The studio is offline.' : null,
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
  capabilities: {
    message: true,
    spotlight: true,
    cap: true,
    capTemplateVersion: 'looks-v1',
  },
  capQueue: { host: 0, guest: 0 },
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
  // The mock desk: the upload is checked and stored (or refused with a reason), the stored
  // logo and the finished look are real PNGs, so nothing on the card is ever a broken image.
  await context.route(/\/api\/sponsorship\/assets(\/|$)/, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === 'POST') {
      uploads++;
      if (refuseUpload)
        return route.fulfill({
          status: 422,
          json: { error: 'This logo is too thin to print.', code: 'LOGO_TOO_THIN' },
        });
      return route.fulfill({
        json: { id: assetId, status: 'logo', url: logoUrl, logoUrl },
      });
    }
    return route.fulfill({
      path:
        url.searchParams.get('part') === 'look'
          ? 'public/pepe-video.png'
          : 'public/logo.png',
    });
  });
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
          priceCents: body.draft.product === 'cap' ? 10000 : 2500,
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
      } else if (body.action === 'replaceLogo') {
        replacements.push(body);
        receipt.draft.assetId = body.assetId;
        receipt.look = { status: 'tailoring' };
        result = { receipt };
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
  // The wallet walk is one button. With no wallet in this browser it asks to connect;
  // the adapter's own "Select Wallet" control never shares the desk with it.
  await panel.getByRole('button', { name: 'Connect wallet' }).waitFor();
  assert.equal(
    await panel.locator('.sponsor-wallet .sponsor-button').count(),
    1,
  );
  assert.equal(
    await panel.getByRole('button', { name: 'Select Wallet' }).count(),
    0,
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
  // ---- Dress the host. The logo is checked at upload; the tee and cap are tailored after payment.
  receipt = null;
  refuseUpload = false;
  const fitting = await setup({ width: 1440, height: 1100 });
  const cap = fitting.page.locator('.sponsor-panel');
  await cap
    .locator('input[name="sponsor-product"][value="cap"]')
    .check({ force: true });
  await cap.getByRole('button', { name: 'Continue', exact: true }).click();
  await fitting.page.locator('#sponsor-projectName').fill('Canvas');
  // Before any logo: the host's own still, no swatch, and the promise of what happens after payment.
  const card = fitting.page.locator('.sponsor-preview.cap');
  assert.match(
    await card.locator('.sponsor-preview-caption').innerText(),
    /Your tee and cap are tailored right after payment · usually one to two minutes/,
  );
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.avif$/,
  );
  assert.equal(await card.locator('.sponsor-logo-swatch').count(), 0);
  // A logo the desk cannot print is refused under the upload field, before any money moves.
  refuseUpload = true;
  await fitting.page
    .locator('#sponsor-logo-file')
    .setInputFiles('public/logo.png');
  await cap.locator('#sponsor-assetId-error').waitFor();
  assert.equal(
    await cap.locator('#sponsor-assetId-error').innerText(),
    'This logo is too thin to print.',
  );
  assert.equal(await card.locator('.sponsor-logo-swatch').count(), 0);
  refuseUpload = false;
  await fitting.page
    .locator('#sponsor-logo-file')
    .setInputFiles('public/logo.png');
  await card.locator('.sponsor-logo-swatch').waitFor();
  assert.equal(await cap.locator('#sponsor-assetId-error').count(), 0);
  assert.equal(uploads, 2);
  assert.match(
    await card.locator('.sponsor-logo-swatch').getAttribute('src'),
    new RegExp(`/api/sponsorship/assets/${assetId}\\?part=logo$`),
  );
  assert.ok(
    await loaded(card.locator('.sponsor-logo-swatch')),
    'the swatch is the stored logo, not a broken image',
  );
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.avif$/,
    'no look exists before payment',
  );
  assert.equal(
    await cap.getByRole('button', { name: 'Change your logo' }).count(),
    1,
  );
  await fitting.page
    .locator('#sponsor-message')
    .fill('Canvas is where trench builders keep their receipts.');
  await cap.getByRole('button', { name: 'Continue to payment' }).click();
  await cap.getByRole('button', { name: 'Scan to pay' }).waitFor();
  assert.equal(receipt.draft.assetId, assetId, 'the order carries the logo');
  // Payment lands; the desk starts tailoring. The card keeps the still and the swatch.
  receipt.status = 'paid';
  receipt.paidAt = Date.now();
  receipt.queuePosition = 1;
  receipt.look = { status: 'tailoring' };
  await cap
    .getByRole('heading', { name: 'Your tee and cap are being tailored' })
    .waitFor({ timeout: 10000 });
  assert.match(await card.locator('.sponsor-preview-label').innerText(), /TAILORING/);
  assert.match(
    await cap.locator('.sponsor-receipt > .sponsor-kicker').innerText(),
    /TAILORING/,
  );
  assert.equal(
    await cap.locator('.sponsor-receipt > p:not(.sponsor-kicker)').first().innerText(),
    'Tailoring your tee and cap · usually one to two minutes',
  );
  assert.ok(await card.evaluate((el) => el.classList.contains('tailoring')));
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.avif$/,
    'the still, never the stored asset URL, while the tailor works',
  );
  assert.equal(
    await card.locator('.sponsor-preview-caption small').innerText(),
    'Tailoring your tee and cap · usually one to two minutes',
  );
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  // A reload during tailoring shows the still and the swatch, never a broken image.
  await fitting.page.reload({ waitUntil: 'networkidle' });
  await cap
    .getByRole('heading', { name: 'Your tee and cap are being tailored' })
    .waitFor({ timeout: 10000 });
  await card.locator('.sponsor-logo-swatch').waitFor();
  for (const img of await card.locator('img').all())
    assert.ok(await loaded(img), 'every image on the card after a reload is real');
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.avif$/,
  );
  // The receipt's clock, not the desk, drives the waiting copy.
  receipt.paidAt = Date.now() - 130000;
  await card
    .locator('.sponsor-preview-caption small', {
      hasText: 'Still tailoring — trying another fit',
    })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  receipt.paidAt = Date.now() - 11 * 60000;
  await card
    .locator('.sponsor-preview-caption small', {
      hasText: 'This is taking longer than usual',
    })
    .waitFor({ timeout: 10000 });
  await cap.getByRole('button', { name: 'Use a different logo' }).waitFor();
  // A different logo goes through the same check; the order points at it and the clock restarts.
  await cap.locator('#sponsor-replace-logo').setInputFiles('public/logo.png');
  await card
    .locator('.sponsor-preview-caption small', {
      hasText: 'Tailoring your tee and cap · usually one to two minutes',
    })
    .waitFor({ timeout: 10000 });
  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0], {
    action: 'replaceLogo',
    orderId: 'order-browser-rehearsal',
    token: 'a'.repeat(64),
    assetId,
  });
  assert.equal(uploads, 3);
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  // The look lands: it replaces the still, the swatch goes, the label becomes the pass.
  receipt.look = { status: 'ready', url: lookUrl };
  await card.locator('.sponsor-host-art.look').waitFor({ timeout: 10000 });
  assert.match(
    await card.locator('.sponsor-host-art.look').getAttribute('src'),
    /part=look&v=/,
  );
  assert.equal(
    await card.locator('.sponsor-host-art.look').getAttribute('alt'),
    'Pepe wearing your tee and cap',
  );
  assert.ok(await loaded(card.locator('.sponsor-host-art.look')));
  // Premium motion: the look rises 12 px over 400 ms on one curve, its shadow 50 ms behind.
  assert.deepEqual(
    await card.locator('.sponsor-host-art.look').evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        s.animationName,
        s.animationDuration,
        s.animationDelay,
        s.animationTimingFunction,
        s.position,
      ];
    }),
    [
      'sponsor-look-in, sponsor-look-shadow',
      '0.4s, 0.4s',
      '0s, 0.05s',
      'cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1)',
      'relative',
    ],
  );
  assert.match(
    await card.locator('.sponsor-preview-label').innerText(),
    /YOUR ON-AIR PASS/,
  );
  assert.equal(await card.locator('.sponsor-logo-swatch').count(), 0);
  assert.equal(await card.evaluate((el) => el.classList.contains('tailoring')), false);
  await cap
    .getByRole('heading', { name: 'You’re in the queue' })
    .waitFor({ timeout: 10000 });
  assert.match(
    await cap.locator('.sponsor-receipt > .sponsor-kicker').innerText(),
    /YOUR ON-AIR PASS/,
  );
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  // A fallback look airs, says so, and still offers a better fit.
  receipt.look = { status: 'ready', url: lookUrl, fallback: 'cap-v1' };
  await cap
    .locator('.sponsor-look-replace', { hasText: "We'll keep improving the fit" })
    .waitFor({ timeout: 10000 });
  await cap.getByRole('button', { name: 'Use a different logo' }).waitFor();
  assert.match(
    await card.locator('.sponsor-host-art.look').getAttribute('src'),
    /part=look&v=/,
  );
  // A refused logo says why and asks for another; nothing pulses.
  receipt.look = {
    status: 'refused',
    reason: 'This logo could not be dressed. Use a different logo.',
  };
  await cap
    .locator('.sponsor-look-replace', { hasText: 'This logo could not be dressed.' })
    .waitFor({ timeout: 10000 });
  assert.match(await card.locator('.sponsor-preview-label').innerText(), /TAILORING/);
  assert.equal(await card.evaluate((el) => el.classList.contains('tailoring')), false);
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.avif$/,
  );
  // While the tailor works the card's label breathes and the swatch sits on the still;
  // with reduced motion nothing on the card moves, and the state still reads.
  receipt.look = { status: 'tailoring' };
  receipt.paidAt = Date.now();
  await fitting.page
    .locator('.sponsor-preview.cap.tailoring')
    .waitFor({ timeout: 10000 });
  const pulse = () =>
    fitting.page
      .locator('.sponsor-preview.cap .sponsor-preview-label svg')
      .evaluate((el) => getComputedStyle(el).animationName);
  const swatchStyle = () =>
    card.locator('.sponsor-logo-swatch').evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.animationName, s.position, s.objectFit];
    });
  assert.equal(await pulse(), 'sponsor-tailoring');
  assert.deepEqual(await swatchStyle(), [
    'sponsor-swatch-in',
    'absolute',
    'contain',
  ]);
  assert.equal(
    await card
      .locator('.sponsor-host-art')
      .evaluate((el) => getComputedStyle(el).filter),
    'saturate(0.72) brightness(0.94)',
  );
  await fitting.page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await pulse(), 'none');
  assert.equal((await swatchStyle())[0], 'none');
  receipt.look = { status: 'ready', url: lookUrl };
  await card.locator('.sponsor-host-art.look').waitFor({ timeout: 10000 });
  assert.equal(
    await card
      .locator('.sponsor-host-art.look')
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await fitting.page.emulateMedia({ reducedMotion: 'no-preference' });
  await fitting.page.evaluate(() =>
    window.scrollTo({ top: 0, behavior: 'instant' }),
  );
  await fitting.page.screenshot({
    path: 'work/sponsor-browser/desktop-fitting.png',
    fullPage: true,
  });
  await fitting.context.close();
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
