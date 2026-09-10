'use client';
/* oxlint-disable next/no-img-element -- Immutable buyer artwork is served by its content identity. */
import './sponsor-console.css';
import { useEffect, useState } from 'react';
import {
  Radio,
  Clock3,
  Check,
  Shirt,
  AlertCircle,
  ArrowUpRight,
} from 'lucide-react';
import {
  readSponsorConsole,
  type SponsorConsoleOrder,
} from '@/lib/sponsor-delivery-client';
import type { SponsorDelivery } from '@/lib/sponsor-program';
import type { PaidRequest } from '@/lib/requests';

export function SponsorConsole({
  orders,
  requests,
  error,
  running,
}: {
  orders: SponsorDelivery[];
  requests: PaidRequest[];
  error: string;
  running: boolean;
}) {
  const [remote, setRemote] = useState<SponsorConsoleOrder[]>([]);
  useEffect(() => {
    let alive = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const rows = await readSponsorConsole();
        if (alive) setRemote(rows);
      } catch {
        /* The engine reports delivery outages; this list keeps its last receipt states. */
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const combined = new Map(
    orders.map((order) => [
      order.id,
      {
        ...order,
        displayStatus: order.phase as string,
        refunds: [] as SponsorConsoleOrder['refunds'],
      },
    ]),
  );
  for (const row of remote) {
    const local = combined.get(row.id);
    if (
      local &&
      !['fulfilled', 'refunded', 'refund-pending', 'paused'].includes(
        row.status,
      )
    ) {
      local.refunds = row.refunds;
      continue;
    }
    combined.set(row.id, {
      id: row.id,
      draft: row.draft,
      fulfillment: row.fulfillment,
      phase:
        row.status === 'playing'
          ? 'playing'
          : row.status === 'fulfilled' || row.status === 'refunded'
            ? 'fulfilled'
            : row.status === 'paused'
              ? 'paused'
              : 'queued',
      displayStatus: row.status,
      refunds: row.refunds,
      leaseToken: '',
      leaseUntil: 0,
      assetUrl: null,
      assetMetadata: null,
    });
  }
  const entries = [...combined.values()];
  const active = entries.filter((order) => order.phase === 'playing');
  const queued = entries.filter(
    (order) => !['fulfilled', 'playing'].includes(order.phase),
  );
  return (
    <section
      className="sponsor-console"
      aria-label="Sponsorship delivery console"
    >
      <div className="sponsor-console-heading">
        <span className="eyebrow">DELIVERY DESK</span>
        <span
          className={
            running ? 'sponsor-console-signal active' : 'sponsor-console-signal'
          }
        >
          <Radio size={12} />
          {running ? 'STUDIO ACTIVE' : 'OFF AIR'}
        </span>
      </div>
      <h2>In the show.</h2>
      <p className="muted">
        Paid exchanges are separated by two minutes of conversation. Delivery
        counts when footage plays.
      </p>
      {error && (
        <output className="sponsor-console-alert">
          <AlertCircle size={14} />
          {error}
        </output>
      )}
      <div className="sponsor-console-summary">
        <span>
          <b>
            {queued.length +
              requests.filter((r) => !['aired', 'on-air'].includes(r.status))
                .length}
          </b>{' '}
          waiting
        </span>
        <span>
          <b>{active.filter((o) => o.draft.product === 'cap').length}</b> caps
          on air
        </span>
        <span>
          <b>{orders.filter((o) => o.phase === 'fulfilled').length}</b>{' '}
          delivered
        </span>
      </div>
      {entries.length === 0 && (
        <div className="sponsor-console-empty">
          <Clock3 size={18} />
          <p>
            The delivery queue is clear.
            <br />
            <small>Paid orders appear here automatically.</small>
          </p>
        </div>
      )}
      <ol className="sponsor-console-orders">
        {[
          ...active,
          ...queued,
          ...entries.filter((o) => o.phase === 'fulfilled'),
        ]
          .slice(0, 8)
          .map((order) => (
            <li key={order.id}>
              <div className="sponsor-console-order-title">
                {order.draft.product === 'cap' ? (
                  <Shirt size={15} />
                ) : order.phase === 'fulfilled' ? (
                  <Check size={15} />
                ) : (
                  <Radio size={15} />
                )}
                <b>
                  {order.draft.projectName ||
                    order.draft.name ||
                    'An anonymous viewer'}
                </b>
                <span>{order.displayStatus}</span>
              </div>
              <p>
                {order.draft.product === 'cap'
                  ? `Dress ${order.draft.target === 'host' ? 'Pepe' : 'Chad'}`
                  : order.draft.product === 'spotlight'
                    ? 'Project spotlight'
                    : 'Get on air'}
                {order.draft.name ? ` · ${order.draft.name}` : ''}
              </p>
              {order.draft.product === 'cap' && (
                <>
                  <progress
                    value={Math.min(600000, order.fulfillment.visibleMs)}
                    max={600000}
                    aria-label="Verified cap broadcast time"
                  />
                  <small>
                    {Math.floor(order.fulfillment.visibleMs / 60000)}:
                    {String(
                      Math.floor(order.fulfillment.visibleMs / 1000) % 60,
                    ).padStart(2, '0')}{' '}
                    / 10:00 · {order.fulfillment.appearances} / 6 appearances ·{' '}
                    {Number(order.fulfillment.intro) +
                      Number(order.fulfillment.callback)}{' '}
                    / 2 mentions
                  </small>
                </>
              )}
              {order.error && (
                <small className="sponsor-console-alert">{order.error}</small>
              )}
              {order.refunds.map((refund, i) => (
                <small
                  key={i}
                  className={refund.error ? 'sponsor-console-alert' : undefined}
                >
                  Refund {refund.status}
                  {refund.error ? ` · ${refund.error}` : ''}
                </small>
              ))}
            </li>
          ))}
      </ol>
      {requests.filter((r) => r.status !== 'aired').length > 0 && (
        <details>
          <summary>Earlier paid requests</summary>
          {requests
            .filter((r) => r.status !== 'aired')
            .map((r) => (
              <p key={r.id}>
                <b>{r.from}</b> · {r.status}
                <br />
                {r.text}
              </p>
            ))}
        </details>
      )}
      <p className="sponsor-console-policy">
        Interrupted placements resume with their verified progress. Refund
        status stays on each buyer’s receipt.
      </p>
    </section>
  );
}

/** This overlay is captured in the actual stream, so commercial placements remain disclosed. */
export function SponsorOnAir({
  sponsor,
}: {
  sponsor?: import('@/lib/sponsor-program').SponsorTurn;
}) {
  if (!sponsor) return null;
  return (
    <div className="sponsor-on-air" aria-label="Paid sponsorship">
      <span>SPONSORED</span>
      {sponsor.assetUrl && sponsor.product === 'spotlight' && (
        <img src={sponsor.assetUrl} alt="" />
      )}
      <div>
        <b>{sponsor.projectName || sponsor.name}</b>
        <small>With support from {sponsor.name}</small>
      </div>
      {sponsor.projectUrl && (
        <a
          href={sponsor.projectUrl}
          target="_blank"
          rel="noopener noreferrer sponsored"
          aria-label={`Visit ${sponsor.projectName || 'the project'}`}
        >
          <ArrowUpRight size={17} />
        </a>
      )}
    </div>
  );
}
