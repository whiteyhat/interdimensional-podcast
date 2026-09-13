// Real local checkout UI with mocked catalog, receipts, and quotes. No RPC or remote writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = process.env.SPONSOR_TEST_ORIGIN || 'http://127.0.0.1:3316';
const origin = new URL(base).origin;
const checkoutKey = 'pepe-chad:sponsorship:v1';
const assets = ['FROGCLENCH', 'USDC', 'SOL'];
const token = 'c'.repeat(64);
const draft = { product: 'spotlight', name: '', message: 'Builders are still shipping.', projectName: 'Trench Builders', style: 'intro' };
const fulfillment = { visibleMs: 0, appearances: 0, intro: false, callback: false, startedAt: null, completedAt: null };
const makeReceipt = () => ({ id: 'currency-test', token, status: 'draft', draft, priceCents: 2500, attempts: [], fulfillment, paidAt: null, payer: null, canReschedule: false, assetUrl: null });
const attempt = asset => ({ id: 'currency-attempt', asset, amountBase: '17500000', amountUi: '17.5', decimals: 6, priceCents: 1750, priceUsd: '1', reference: '11111111111111111111111111111111', recipient: '11111111111111111111111111111111', mint: asset === 'SOL' ? null : '11111111111111111111111111111111', issuedAt: Date.now(), expiresAt: Date.now() + 60000, lastValidBlockHeight: 100, status: 'issued', broadcastSignature: null, verifiedSignature: null, explorerUrl: null, solanaPayUrl: 'solana:' + encodeURIComponent('https://example.test/api/solana-pay/currency') });
let browser;
test.before(async () => {
  await mkdir('work/sponsor-currency', { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
});
test.after(async () => { await browser?.close(); });

async function setup({ saved, available = assets, receipt = null, holdCatalog = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { available: new Set(available), receipt, actions: [], catalogCalls: 0, priceCents: 2500, frogPriceCents: 1750, errors: [] };
  let releaseCatalog;
  const gate = holdCatalog ? new Promise(resolve => { releaseCatalog = resolve; }) : Promise.resolve();
  if (saved !== undefined) await context.addInitScript(({ key, saved }) => localStorage.setItem(key, saved), { key: checkoutKey, saved });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/sponsorship') {
      if (request.method() === 'GET') {
        if (url.searchParams.get('action') === 'catalog') {
          state.catalogCalls++;
          await gate;
          return route.fulfill({ json: {
            products: ['message', 'spotlight', 'cap'].map(id => ({ id, title: id, priceCents: state.priceCents, frogPriceCents: state.frogPriceCents, available: state.available.size > 0, reason: state.available.size ? null : 'Payment services are unavailable.' })),
            assets: ['USDC', 'SOL', 'FROGCLENCH'].map(id => ({ id, mint: id === 'SOL' || !state.available.has(id) ? null : '11111111111111111111111111111111', decimals: 6, available: state.available.has(id), reason: state.available.has(id) ? null : id === 'FROGCLENCH' ? 'FROGCLENCH mint is not configured.' : `${id} is temporarily unavailable.`, priceUsd: state.available.has(id) ? '1' : null })),
            studioOnline: true, capabilities: { message: true, spotlight: true, cap: true }, capQueue: { host: 0, guest: 0 }, treasury: '11111111111111111111111111111111', clientRpcUrl: '/api/rpc', now: Date.now(),
          } });
        }
        return route.fulfill({ json: url.searchParams.get('action') === 'activity' ? { orders: [] } : { receipt: state.receipt } });
      }
      const body = request.postDataJSON();
      state.actions.push(body);
      if (body.action === 'draft') state.receipt = { ...makeReceipt(), draft: body.draft };
      if (body.action === 'quote') {
        state.receipt = { ...state.receipt, status: 'payment-pending', attempts: [attempt(body.asset)] };
        return route.fulfill({ json: { receipt: state.receipt, attempt: state.receipt.attempts[0], solanaPayUrl: state.receipt.attempts[0].solanaPayUrl } });
      }
      return route.fulfill({ json: { receipt: state.receipt } });
    }
    if (url.pathname === '/api/interact') return route.fulfill({ json: { launched: false, ticker: 'FROGCLENCH', name: 'Frogclench', treasury: null, buyUrl: null, interactUsd: 5, studioOnline: true, streamEmbedUrl: null, links: { pumpfun: null, x: null }, queued: 0, recent: [], clientRpcUrl: '/api/rpc' } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.abort('blockedbyclient');
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.clock.install();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.sponsor-panel h2').waitFor();
  const panel = page.locator('.sponsor-panel');
  const radio = asset => panel.locator(`input[name="sponsor-asset"][value="${asset}"]`);
  const selected = async asset => {
    await page.waitForFunction(asset => document.querySelector(`input[name="sponsor-asset"][value="${asset}"]`)?.checked, asset);
    assert.equal(await radio(asset).isChecked(), true);
  };
  const ready = () => panel.locator('.sponsor-signal.online').waitFor();
  const poll = async () => {
    const request = page.waitForResponse(response => response.url().includes('/api/sponsorship?action=catalog'));
    await page.clock.fastForward(20001);
    await request;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const reflow = async filename => {
    const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(geometry.width <= geometry.viewport, JSON.stringify(geometry));
    assert.equal(await panel.locator('.sponsor-assets').count(), 1, 'only one currency selector appears per step');
    assert.deepEqual(await panel.locator('input[name="sponsor-asset"]').evaluateAll(inputs => inputs.map(input => input.value)), assets);
    assert.equal(await panel.locator('.sponsor-assets label').first().locator('span').innerText(), '$FROGCLENCH');
    const label = await panel.locator('.sponsor-assets label').first().locator('span').evaluate(span => {
      const range = document.createRange();
      range.selectNodeContents(span);
      const text = range.getBoundingClientRect(), box = span.getBoundingClientRect();
      return { textLeft: text.left, textRight: text.right, left: box.left, right: box.right };
    });
    assert.ok(label.textLeft >= label.left - 1 && label.textRight <= label.right + 1, JSON.stringify(label));
    if (filename) await page.screenshot({ path: `work/sponsor-currency/${filename}.png`, fullPage: true });
  };
  const writeDraft = async () => {
    await panel.getByRole('button', { name: 'Continue', exact: true }).click();
    await panel.locator('#sponsor-projectName').fill(draft.projectName);
    await panel.locator('#sponsor-message').fill(draft.message);
  };
  const close = async () => { releaseCatalog?.(); assert.deepEqual(state.errors, []); await context.close(); };
  return { page, panel, state, radio, selected, ready, poll, reflow, writeDraft, close, releaseCatalog };
}

void test('fresh checkout paints FROGCLENCH first before the catalog, retains it, and quotes its server-priced discount', async () => {
  const f = await setup({ holdCatalog: true });
  try {
    await f.selected('FROGCLENCH');
    await f.reflow();
    f.releaseCatalog();
    await f.ready();
    await f.radio('USDC').check({ force: true });
    await f.poll();
    await f.selected('USDC');
    await f.radio('FROGCLENCH').check({ force: true });
    f.state.priceCents = 4000;
    f.state.frogPriceCents = 2800;
    await f.poll();
    await f.selected('FROGCLENCH');
    await f.writeDraft();
    await f.panel.getByRole('button', { name: 'Continue to payment' }).click();
    await f.panel.locator('.sponsor-review-summary').waitFor();
    assert.match(await f.panel.locator('.sponsor-review-summary').innerText(), /30% FROGCLENCH discount/);
    assert.match(await f.panel.locator('.sponsor-review-summary strong').innerText(), /\$40.*\$28/s);
    await f.selected('FROGCLENCH');
    await f.reflow('ready-pay-320');
    await f.panel.getByRole('button', { name: 'Scan to pay' }).click();
    await f.panel.locator('.sponsor-qr svg').waitFor();
    assert.deepEqual(f.state.actions.filter(action => action.action === 'quote').map(action => action.asset), ['FROGCLENCH']);
  } finally { await f.close(); }
});

void test('unavailable FROGCLENCH stays selected while SOL remains an explicit, reachable alternative at 320px', async () => {
  const f = await setup({ available: ['SOL'] });
  try {
    await f.ready();
    await f.selected('FROGCLENCH');
    await f.poll();
    await f.selected('FROGCLENCH');
    assert.match(await f.panel.locator('.sponsor-checkout-note').innerText(), /FROGCLENCH mint is not configured/);
    await f.reflow('unavailable-choose-320');
    await f.writeDraft();
    await f.panel.getByRole('button', { name: 'Continue to payment' }).click();
    assert.match(await f.panel.locator('[role="alert"]').innerText(), /FROGCLENCH mint is not configured/);
    assert.equal(f.state.actions.length, 0, 'an unavailable asset cannot create a payable pass or quote');
    await f.radio('SOL').check({ force: true });
    await f.poll();
    await f.selected('SOL');
    await f.panel.getByRole('button', { name: 'Continue to payment' }).click();
    await f.panel.getByRole('button', { name: 'Scan to pay' }).click();
    await f.panel.locator('.sponsor-qr svg').waitFor();
    assert.deepEqual(f.state.actions.filter(action => action.action === 'quote').map(action => action.asset), ['SOL']);
  } finally { await f.close(); }
});

void test('a catalog with no payable assets does not replace the FROGCLENCH default or permit payment', async () => {
  const f = await setup({ available: [] });
  try {
    await f.ready();
    await f.poll();
    await f.selected('FROGCLENCH');
    await f.writeDraft();
    await f.panel.getByRole('button', { name: 'Continue to payment' }).click();
    assert.match(await f.panel.locator('[role="alert"]').innerText(), /Payment services are unavailable/);
    assert.equal(f.state.actions.length, 0);
  } finally { await f.close(); }
});

for (const asset of ['SOL', 'USDC']) {
  void test(`saved ${asset} survives catalog updates even when only FROGCLENCH is available`, async () => {
    const f = await setup({ saved: JSON.stringify({ version: 1, draft, asset }), available: ['FROGCLENCH'] });
    try {
      await f.ready();
      await f.selected(asset);
      await f.poll();
      await f.selected(asset);
      assert.equal(await f.page.evaluate(key => JSON.parse(localStorage.getItem(key)).asset, checkoutKey), asset);
    } finally { await f.close(); }
  });
}

for (const asset of assets) {
  void test(`recovered ${asset} quote owns the selected currency across catalog polls without requesting another quote`, async () => {
    const receipt = { ...makeReceipt(), status: 'payment-pending', attempts: [attempt(asset)] };
    const f = await setup({ saved: JSON.stringify({ version: 1, draft, asset: asset === 'SOL' ? 'USDC' : 'SOL', token }), receipt, available: assets.filter(id => id !== asset) });
    try {
      await f.ready();
      await f.selected(asset);
      await f.poll();
      await f.selected(asset);
      assert.equal(f.state.actions.filter(action => action.action === 'quote').length, 0);
      assert.equal(await f.panel.getByRole('button', { name: 'Scan to pay' }).isDisabled(), true);
      await f.panel.getByRole('button', { name: 'Connect wallet' }).waitFor();
      assert.equal(await f.panel.getByRole('button', { name: 'Connect wallet' }).isDisabled(), true);
      if (asset === 'FROGCLENCH') {
        assert.match(await f.panel.locator('.sponsor-checkout-note').innerText(), /FROGCLENCH mint is not configured/);
        await f.reflow('recovered-unavailable-320');
      }
    } finally { await f.close(); }
  });
}
