// Numbers the way the cards show them. Pure and tiny; the hosts get spoken forms from coin.ts.
/** Below this the chart reads as flat, so it is neither green nor red. */
const flat = 0.05;
/** '', 'up' or 'down' for a percentage move — the one place that decides what counts as flat. */
export function moveClass(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < flat) return '';
  return n > 0 ? 'up' : 'down';
}
export function formatUsd(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `$${trim(n / 1e9)}B`;
  if (n >= 1e6) return `$${trim(n / 1e6)}M`;
  if (n >= 1e3) return `$${trim(n / 1e3)}K`;
  return `$${n >= 100 ? Math.round(n) : trim(n)}`;
}
/** A meme-coin price is mostly zeros; show three meaningful digits and no more. */
export function formatPrice(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  const text = n.toPrecision(3);
  return `$${text.includes('e') ? n.toFixed(10).replace(/0+$/, '') : text}`;
}
export function formatPct(n: number | null) {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(1)}%`;
}
export function formatCount(n: number) {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}
export function formatTokens(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return n >= 100 ? String(Math.round(n)) : trim(n);
}
const trim = (x: number) => {
  const digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  return x.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
};
