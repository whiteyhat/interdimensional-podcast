'use client';
import type { PublicRequest, RowStatus } from '@/hooks/use-requests';
const CHIP: Record<RowStatus, string> = {
  quoted: 'PAYING',
  submitted: 'PAYING',
  paid: 'IN LINE',
  claimed: 'IN LINE',
  aired: 'AIRED',
  expired: 'EXPIRED',
  failed: 'FAILED',
};
/** The last paid requests, newest first; the viewer's own row is outlined. */
export function RequestsList({
  recent,
  highlight,
}: {
  recent: PublicRequest[];
  highlight?: string | null;
}) {
  const rows = [...recent].sort((a, b) => b.at - a.at);
  return (
    <section className="requests-list" aria-label="Paid requests">
      <div className="requests-head">
        <span className="eyebrow">PAID REQUESTS</span>
        {rows.length > 0 && <span className="eyebrow">LAST {rows.length}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="empty-note">No paid messages yet. Send one for Pepe and Chad to answer.</p>
      ) : (
        <ol className="requests-rows">
          {rows.map((r, i) => (
            <li
              key={r.reference}
              className={`requests-row${r.reference === highlight ? ' mine' : ''}`}
              style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
            >
              <div className="requests-meta">
                <b>{r.from}</b>
                <span>{r.wallet}</span>
                <span className={`badge ${r.status}`}>{CHIP[r.status]}</span>
              </div>
              <p>{r.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
