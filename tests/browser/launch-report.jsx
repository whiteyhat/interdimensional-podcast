import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AllocationReport, decodeSnapshot } from '../../components/allocation-report';
import '../../app/launch.css';

const address = '11111111111111111111111111111111';
const snapshot = {
  schemaVersion: 1, generatedAt: '2026-09-09T12:00:00.000Z', network: 'devnet',
  mint: address, name: 'Pepe & Chad', symbol: 'INTER',
  disclosure: 'The listed wallets are controlled by the project.',
  totalSupplyBase: '1000000000', decimals: 6, historyLimit: 20, commitment: 'finalized',
  complete: false, errors: [{ address, message: 'Balance lookup unavailable.' }],
  wallets: [{ address, label: 'Production treasury', purpose: 'Fund the show.',
    plannedTokens: '1000000', maySell: true, balanceBase: null, balanceTokens: null,
    supplyPercent: null, transactions: [{ signature: '1'.repeat(64), slot: 123,
      blockTime: null, status: 'failed' }] }],
};
const checks = [];
const check = (ok, message) => { checks.push({ pass: !!ok, message }); if (!ok) throw Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(10); }
  throw Error('Timed out waiting for report state.');
};
const host = document.getElementById('root');
let root;
const mount = () => { root = createRoot(host); flushSync(() => root.render(<React.StrictMode><AllocationReport /></React.StrictMode>)); };
const unmount = () => { flushSync(() => root.unmount()); };
window.launchChecks = (async () => {
  const decoded = decodeSnapshot({ ...snapshot, privateKey: 'must-never-render', wallets: snapshot.wallets.map(wallet => ({ ...wallet, secretKey: [1, 2, 3] })) });
  check(!JSON.stringify(decoded).includes('privateKey') && !JSON.stringify(decoded).includes('secretKey'), 'Snapshot decoder projects only public allowlisted fields');
  for (const malformed of [null, { ...snapshot, generatedAt: 'yesterday' }, { ...snapshot, disclosure: 'Independent wallets' }, { ...snapshot, network: 'https://evil.test' }, { ...snapshot, wallets: [{ ...snapshot.wallets[0], address: 'javascript:alert(1)' }] }]) {
    let rejected = false; try { decodeSnapshot(malformed); } catch { rejected = true; }
    check(rejected, 'Malformed or misleading snapshot is rejected');
  }
  let requests = 0;
  window.fetch = async url => { check(url === '/launch/report.json', 'Only the published snapshot is fetched'); requests++; return new Response(JSON.stringify(snapshot)); };
  mount(); await until(() => host.textContent.includes('Production treasury'));
  check(requests === 1, 'A mounted report loads exactly once, including Strict Mode');
  check(host.textContent.includes(snapshot.disclosure), 'Common ownership is visible');
  check(host.textContent.includes('Unknown') && !host.textContent.includes('0 INTER'), 'An unavailable balance is unknown, not zero');
  check(host.textContent.includes('Sales permitted') && host.textContent.includes('not an on-chain lock'), 'Sale policy is identified as a declaration');
  check(host.querySelector('time[datetime="2026-09-09T12:00:00.000Z"]'), 'The snapshot carries its exact publication timestamp');
  check([...host.querySelectorAll('a')].filter(a => a.href.includes('explorer.solana.com')).every(a => a.search === '?cluster=devnet'), 'Explorer links use the report network');
  check(host.textContent.includes('Failed') && host.textContent.includes('20'), 'Limited transaction history and failures are visible');
  unmount();
  window.fetch = async () => new Response('', { status: 404 });
  mount(); await until(() => host.textContent.includes('No allocation report published yet'));
  check(!host.querySelector('[role="alert"]'), 'A missing report has a neutral unpublished state');
  unmount();
  window.fetch = async () => new Response('{broken');
  mount(); await until(() => host.querySelector('[role="alert"]'));
  check(host.textContent.includes('could not be read'), 'Invalid JSON produces an accessible error');
  unmount();
  window.fetch = async () => new Response(JSON.stringify(snapshot));
  mount(); await until(() => host.textContent.includes('Production treasury'));
  return checks;
})().catch(error => ({ error: error.message, checks }));
window.launchChecks.then(result => document.getElementById('results').textContent = JSON.stringify(result, null, 2));
