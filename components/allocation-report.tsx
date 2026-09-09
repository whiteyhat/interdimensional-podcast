'use client';
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Horizontal table scrollers must be reachable by keyboard. */
import { useEffect, useRef, useState } from 'react';

type RecentTransaction = {
  signature: string;
  slot: number;
  blockTime: number | null;
  status: 'confirmed' | 'finalized' | 'failed';
};
type AllocationWallet = {
  address: string;
  label: string;
  purpose: string;
  plannedTokens: string;
  maySell: boolean;
  balanceBase: string | null;
  balanceTokens: string | null;
  supplyPercent: string | null;
  transactions: RecentTransaction[];
};
type Snapshot = {
  schemaVersion: 1;
  generatedAt: string;
  network: 'mainnet-beta' | 'devnet';
  mint: string | null;
  name: string;
  symbol: string;
  disclosure: string;
  totalSupplyBase: string | null;
  decimals: number | null;
  historyLimit: 20;
  commitment: 'finalized';
  complete: boolean;
  errors: { address: string; message: string }[];
  wallets: AllocationWallet[];
};
const DISCLOSURE = 'The listed wallets are controlled by the project.';
const invalid = () => new Error('The allocation report could not be read. Its format is invalid.');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value;
}
function address(value: unknown): string {
  const result = text(value, 44);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result)) throw invalid();
  return result;
}
function amount(value: unknown, fractional = false): string {
  const result = text(value, 100);
  if (!(fractional ? /^(0|[1-9]\d*)(\.\d+)?$/ : /^(0|[1-9]\d*)$/).test(result)) throw invalid();
  return result;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
/** Project untrusted JSON into the public schema; extra fields are never retained. */
export function decodeSnapshot(value: unknown): Snapshot {
  const data = record(value);
  if (data.schemaVersion !== 1 || data.historyLimit !== 20 || data.commitment !== 'finalized' || data.disclosure !== DISCLOSURE) throw invalid();
  if (data.network !== 'devnet' && data.network !== 'mainnet-beta') throw invalid();
  const generatedAt = text(data.generatedAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) throw invalid();
  return {
    schemaVersion: 1, generatedAt, network: data.network,
    mint: data.mint === null ? null : address(data.mint),
    name: text(data.name, 100), symbol: text(data.symbol, 20), disclosure: DISCLOSURE,
    totalSupplyBase: data.totalSupplyBase === null ? null : amount(data.totalSupplyBase),
    decimals: data.decimals === null ? null : integer(data.decimals, 18),
    historyLimit: 20, commitment: 'finalized', complete: boolean(data.complete),
    errors: list(data.errors, 1000).map(value => {
      const error = record(value);
      return { address: address(error.address), message: text(error.message, 2000) };
    }),
    wallets: list(data.wallets, 200).map(value => {
      const wallet = record(value);
      return {
        address: address(wallet.address), label: text(wallet.label, 100), purpose: text(wallet.purpose, 1000),
        plannedTokens: amount(wallet.plannedTokens, true), maySell: boolean(wallet.maySell),
        balanceBase: wallet.balanceBase === null ? null : amount(wallet.balanceBase),
        balanceTokens: wallet.balanceTokens === null ? null : amount(wallet.balanceTokens, true),
        supplyPercent: wallet.supplyPercent === null ? null : amount(wallet.supplyPercent, true),
        transactions: list(wallet.transactions, 20).map(value => {
          const transaction = record(value);
          const signature = text(transaction.signature, 88);
          if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || !['confirmed', 'finalized', 'failed'].includes(String(transaction.status))) throw invalid();
          return {
            signature, slot: integer(transaction.slot),
            blockTime: transaction.blockTime === null ? null : integer(transaction.blockTime, 8640000000000),
            status: transaction.status as RecentTransaction['status'],
          };
        }),
      };
    }),
  };
}

function explorer(kind: 'address' | 'tx', value: string, network: Snapshot['network']) {
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}${network === 'devnet' ? '?cluster=devnet' : ''}`;
}
function number(value: string) {
  const [whole, fraction] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}
function displayDate(value: string | number) {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}
async function readSnapshot(): Promise<Snapshot | null> {
  const response = await fetch('/launch/report.json', { cache: 'no-store', credentials: 'same-origin' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('The allocation report is unavailable. Try reloading the page.');
  if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw invalid();
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024) throw invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  return decodeSnapshot(value);
}

export function AllocationReport() {
  const request = useRef<Promise<Snapshot | null> | null>(null);
  const [state, setState] = useState<{ snapshot?: Snapshot | null; error?: string }>({});
  useEffect(() => {
    let active = true;
    request.current ??= readSnapshot();
    request.current.then(
      snapshot => { if (active) setState({ snapshot }); },
      error => { if (active) setState({ error: error instanceof Error ? error.message : 'The allocation report could not be read.' }); },
    );
    return () => { active = false; };
  }, []);

  if (state.error) return <p className="launch-notice launch-error" role="alert">{state.error}</p>;
  if (state.snapshot === undefined) return <output className="launch-notice">Loading the published allocation snapshot…</output>;
  if (state.snapshot === null) return <div className="launch-empty"><h2>No allocation report published yet</h2><p>The project’s declared wallets, planned allocations and dated balances will appear here when a report is published.</p></div>;
  const report = state.snapshot;
  return (
    <>
      <section className="launch-disclosure" aria-label="Ownership disclosure">
        <p className="launch-kicker">PROJECT CONTROLLED WALLETS</p>
        <h2>{report.disclosure}</h2>
        <p>Sales permissions below are project declarations, not an on-chain lock or a restriction enforced by this page.</p>
      </section>
      <dl className="launch-facts allocation-facts">
        <div><dt>Snapshot published</dt><dd><time dateTime={report.generatedAt}>{displayDate(report.generatedAt)}</time></dd></div>
        <div><dt>Token / network</dt><dd>{report.name} · {report.symbol}<span className="launch-subvalue">{report.network}</span></dd></div>
        <div><dt>Observed balances</dt><dd>{report.complete ? 'Complete snapshot' : 'Partial snapshot'}<span className="launch-subvalue">Finalized · loaded once</span></dd></div>
        <div className="launch-fact-wide"><dt>Mint</dt><dd>{report.mint ? <a className="launch-address" href={explorer('address', report.mint, report.network)} target="_blank" rel="noreferrer">{report.mint} ↗</a> : 'Not launched'}</dd></div>
      </dl>
      {!report.complete ? <p className="launch-notice">Some observations are unavailable. Unknown values are not zero; this snapshot does not update live.</p> : null}
      <div className="launch-section-heading"><h2>Wallet allocations</h2><span>{report.wallets.length} declared {report.wallets.length === 1 ? 'wallet' : 'wallets'}</span></div>
      {report.wallets.length ? <section className="launch-table-scroll" aria-label="Wallet allocations" tabIndex={0}>
        <table className="launch-table">
          <caption>Planned allocations and observed token balances at the snapshot date.</caption>
          <thead><tr><th scope="col">Wallet / purpose</th><th scope="col">Planned tokens</th><th scope="col">Observed tokens</th><th scope="col">Supply share</th><th scope="col">Declared sales policy</th></tr></thead>
          <tbody>{report.wallets.map((wallet, index) => <tr key={`${wallet.address}-${index}`}>
            <th scope="row"><strong>{wallet.label}</strong><a className="launch-address" href={explorer('address', wallet.address, report.network)} target="_blank" rel="noreferrer">{wallet.address} ↗</a><span className="launch-subvalue">{wallet.purpose}</span></th>
            <td>{number(wallet.plannedTokens)}<span className="launch-subvalue">{report.symbol}</span></td>
            <td>{wallet.balanceTokens === null ? <span className="launch-unknown">Unknown</span> : <>{number(wallet.balanceTokens)}<span className="launch-subvalue">{report.symbol}</span></>}</td>
            <td>{wallet.supplyPercent === null ? <span className="launch-unknown">Unknown</span> : `${number(wallet.supplyPercent)}%`}</td>
            <td>{wallet.maySell ? 'Sales permitted' : 'Sales not permitted'}<span className="launch-subvalue">Project declaration</span></td>
          </tr>)}</tbody>
        </table>
      </section> : <p className="launch-notice">No project wallets have been declared in this snapshot.</p>}
      {report.errors.length ? <details className="launch-details"><summary>Unavailable observations ({report.errors.length})</summary><ul>{report.errors.map((error, index) => <li key={index}><span className="launch-address">{error.address}</span><p>{error.message}</p></li>)}</ul></details> : null}
      <div className="launch-section-heading"><h2>Recent wallet history</h2><span>Up to {report.historyLimit} transactions per wallet</span></div>
      <p className="launch-muted">A limited address history from the snapshot. Entries can include activity unrelated to this token; this is not a complete transaction history.</p>
      {report.wallets.map((wallet, index) => <details className="launch-details" key={`${wallet.address}-${index}`}>
        <summary>{wallet.label}<span>{wallet.transactions.length} recent {wallet.transactions.length === 1 ? 'entry' : 'entries'}</span></summary>
        {wallet.transactions.length ? <section className="launch-table-scroll" aria-label={`${wallet.label} recent history`} tabIndex={0}>
          <table className="launch-table launch-history"><caption>Recent transactions for {wallet.label}</caption><thead><tr><th scope="col">Transaction</th><th scope="col">Block time (UTC)</th><th scope="col">Slot</th><th scope="col">Status</th></tr></thead><tbody>{wallet.transactions.map((transaction, transactionIndex) => <tr key={`${transaction.signature}-${transactionIndex}`}>
            <th scope="row"><a className="launch-address" href={explorer('tx', transaction.signature, report.network)} target="_blank" rel="noreferrer">{transaction.signature} ↗</a></th>
            <td>{transaction.blockTime === null ? 'Unknown' : <time dateTime={new Date(transaction.blockTime * 1000).toISOString()}>{displayDate(transaction.blockTime * 1000)}</time>}</td>
            <td>{number(String(transaction.slot))}</td><td className={transaction.status === 'failed' ? 'launch-unknown' : undefined}>{transaction.status[0].toUpperCase() + transaction.status.slice(1)}</td>
          </tr>)}</tbody></table>
        </section> : <p className="launch-muted">No recent transactions reported.</p>}
      </details>)}
    </>
  );
}
