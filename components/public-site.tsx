'use client';
/* oxlint-disable next/no-img-element -- The studio logo is a static asset, shown without an image optimizer. */
import { Suspense, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CoinCard } from '@/components/coin-card';
import { RequestsList } from '@/components/requests-list';
import { StreamEmbed } from '@/components/stream-embed';
import { SponsorPanel } from '@/components/sponsor-panel';
import { SponsorActivity } from '@/components/sponsor-activity';
import { useCoin } from '@/hooks/use-coin';
import { useConfig } from '@/hooks/use-config';
import { useRequests } from '@/hooks/use-requests';
import { cast, show } from '@/lib/show';
// The wallet layer is browser-only and heavy; it arrives after the page has painted.
const InteractCard = dynamic(
  () => import('@/components/interact-card').then((m) => m.InteractCard),
  {
    ssr: false,
    loading: () => (
      <p className="muted interact-loading">Loading the wallet…</p>
    ),
  },
);
const NO_LINKS = { pumpfun: null, x: null };
/** A way back into the studio for the operator; invisible to everyone else. */
function StudioLink() {
  const params = useSearchParams();
  if (params?.get('studio') !== '1') return null;
  return (
    <Link className="quiet details-toggle" href="/studio">
      Studio
    </Link>
  );
}
/** The public site: the stream, the chart, the $5 seat and who has paid for one. */
export function PublicSite() {
  const { config, error } = useConfig();
  const chart = useCoin();
  const [reference, setReference] = useState<string | null>(null);
  const { request, recent } = useRequests(reference ?? undefined);
  const ticker = config?.ticker ?? show.ticker.replace(/^\$/, '');
  const [legacyReceipt, setLegacyReceipt] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setLegacyReceipt(
          !!(
            localStorage.getItem('interact:receipt') ||
            sessionStorage.getItem('interact:receipt')
          ),
        );
      } catch {
        /* Storage is optional. */
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const online = !!config?.studioOnline;
  return (
    <main className="podcast public-site">
      <header>
        <Link className="brand" href="/">
          <img className="brand-mark" src="/logo.webp" alt="" />
          {show.name.toUpperCase()}
          <span className="edition">{show.edition}</span>
        </Link>
        <span className="strap">{show.strap}</span>
        <Suspense fallback={null}>
          <StudioLink />
        </Suspense>
      </header>
      <div className="topline">
        <span className="eyebrow">
          {show.kicker} / {cast.host.name.toUpperCase()} +{' '}
          {cast.guest.name.toUpperCase()}
        </span>
        <span className={`pill ${online ? 'live' : 'off'}`}>
          <i />
          {!config ? 'TUNING IN' : online ? 'LIVE' : 'OFF AIR'}
        </span>
      </div>
      {error && !config && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <div className="studio">
        <section className="broadcast">
          <StreamEmbed
            url={config?.streamEmbedUrl ?? null}
            links={config?.links ?? NO_LINKS}
            live={online}
            poster={cast.host.image}
          />
          <SponsorActivity />
        </section>
        <aside className="sponsor-rail">
          <SponsorPanel />
          <details className="sponsor-coin-details">
            <summary>
              <span>THE SHOW’S COIN</span>
              <b>
                ${ticker} <span aria-hidden="true">↗</span>
              </b>
            </summary>
            <CoinCard
              coin={chart.coin}
              launched={chart.launched}
              error={chart.error}
              buyUrl={config?.buyUrl ?? undefined}
              ticker={ticker}
            />
          </details>
          {legacyReceipt && (
            <details className="sponsor-legacy" open>
              <summary>Your earlier payment</summary>
              <InteractCard
                config={config}
                request={request}
                onReference={setReference}
              />
            </details>
          )}
          {recent.length > 0 && (
            <RequestsList recent={recent} highlight={reference} />
          )}
        </aside>
      </div>
      <footer>
        <span>
          This show is a parody. Sponsored placements are labeled. Nothing here
          is financial advice.
        </span>
        <span>{show.strap}</span>
      </footer>
    </main>
  );
}
