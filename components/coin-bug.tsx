'use client';
import type { CoinSnapshot } from '@/lib/coin';
import { formatPct, formatPrice, formatUsd, moveClass } from '@/lib/format';
/** The on-stage price bug: ticker, price and the five-minute move, for the stream. */
export function CoinBug({ coin }: { coin: CoinSnapshot }) {
  const move = coin.change5m;
  const cls = moveClass(move);
  return (
    <div className="coin-bug" aria-hidden="true">
      <b>{coin.symbol.toUpperCase()}</b>
      <span key={coin.priceUsd} className={cls}>{formatPrice(coin.priceUsd)}</span>
      <span className={cls}>{formatPct(move)}</span>
      <span className="coin-bug-cap">MC {formatUsd(coin.mcapUsd)}</span>
    </div>
  );
}
