'use client';
import { ArrowUpRight } from 'lucide-react';
import type { CoinSnapshot } from '@/lib/coin';
import { formatCount, formatPct, formatPrice, formatUsd, moveClass } from '@/lib/format';
import { buyUrlFor } from '@/lib/interact';
function Spark({ candles }: { candles: CoinSnapshot['candles'] }) {
  const closes = candles.map((c) => c.c);
  if (closes.length < 2) return null;
  const width = 280;
  const height = 48;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || max || 1;
  const points = closes.map((c, i) => [
    (i / (closes.length - 1)) * width,
    height - 3 - ((c - min) / span) * (height - 6),
  ]);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const down = closes[closes.length - 1] < closes[0];
  return (
    <svg
      className={`coin-spark${down ? ' down' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="area" d={area} />
      <path className="line" d={line} />
    </svg>
  );
}
/** The show's own coin: price, cap, the last few hours, and how far it is from graduating. */
export function CoinCard({
  coin,
  launched,
  error,
  buyUrl,
  ticker,
}: {
  coin: CoinSnapshot | null;
  launched: boolean | null;
  error?: string;
  buyUrl?: string;
  ticker: string;
}) {
  const buy = buyUrl || buyUrlFor(coin?.mint ?? null);
  return (
    <section className="coin-card" aria-label="The coin">
      <div className="coin-head">
        <span className="eyebrow">THE COIN</span>
        {coin?.live && (
          <span className="coin-live">
            <i />
            LIVE{coin.viewers ? ` · ${formatCount(coin.viewers)} WATCHING` : ''}
          </span>
        )}
      </div>
      {launched === false ? (
        <p className="coin-empty">
          {ticker} launches on pump.fun with the show. You’ll see the chart here once it launches.
        </p>
      ) : !coin ? (
        <p className="coin-empty">
          {error ? 'We couldn’t load the chart. Trying again…' : 'Loading the chart…'}
        </p>
      ) : (
        <>
          <div className="coin-name">
            <b>{coin.name}</b>
            <span>{coin.symbol.toUpperCase()}</span>
          </div>
          <span key={coin.priceUsd} className={`coin-price ${moveClass(coin.change5m)}`}>
            {formatPrice(coin.priceUsd)}
          </span>
          <div className="coin-chips">
            <span className="coin-chip">MCAP {formatUsd(coin.mcapUsd)}</span>
            <span className={`coin-chip ${moveClass(coin.change5m)}`}>5M {formatPct(coin.change5m)}</span>
            <span className={`coin-chip ${moveClass(coin.change1h)}`}>1H {formatPct(coin.change1h)}</span>
            <span className={`coin-chip ${moveClass(coin.change24h)}`}>24H {formatPct(coin.change24h)}</span>
          </div>
          <Spark candles={coin.candles} />
          <div className="coin-progress">
            <div className="coin-progress-label">
              <span>{coin.graduated ? 'GRADUATED · TRADING ON PUMPSWAP' : 'BONDING CURVE'}</span>
              <span>{coin.graduated ? 'ATH ' + formatUsd(coin.athMcapUsd) : `${Math.round(coin.progress)}% TO GRADUATION`}</span>
            </div>
            <div className="coin-progress-track" aria-hidden="true">
              <i style={{ width: `${coin.progress}%` }} />
            </div>
          </div>
          <div className="coin-foot">
            <span>
              {coin.volume24h !== null ? `24H VOL ${formatUsd(coin.volume24h)} · ` : ''}
              {formatCount(coin.replies)} REPLIES
            </span>
            {buy && (
              <a className="quiet" href={buy} target="_blank" rel="noreferrer">
                Buy on pump.fun <ArrowUpRight size={12} />
              </a>
            )}
          </div>
          {error && <p className="coin-note">CHART PAUSED · SHOWING THE LAST READING</p>}
        </>
      )}
    </section>
  );
}
