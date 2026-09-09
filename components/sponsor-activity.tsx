'use client';
/* oxlint-disable next/no-img-element -- Immutable buyer artwork. */
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
type Placement = {
  id: string;
  product: string;
  from: string;
  projectName?: string;
  projectUrl?: string;
  message: string;
  status: string;
  assetUrl: string | null;
};
export function SponsorActivity() {
  const [orders, setOrders] = useState<Placement[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/api/sponsorship?action=activity', {
          signal: controller.signal,
        });
        if (response.ok) {
          const data = (await response.json()) as { orders: Placement[] };
          if (!controller.signal.aborted)
            setOrders(
              data.orders
                .filter((o) => ['playing', 'fulfilled'].includes(o.status))
                .sort(
                  (a, b) =>
                    Number(b.status === 'playing') -
                    Number(a.status === 'playing'),
                )
                .slice(0, 3),
            );
        }
      } catch {
        /* The broadcast stays available if the activity feed is briefly offline. */
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  if (!orders.length) return null;
  return (
    <section
      className="sponsor-activity"
      aria-label="Sponsored moments from the show"
    >
      <p className="sponsor-kicker">IN THE CONVERSATION</p>
      {orders.map((o) => (
        <article key={o.id} className="sponsor-project-card">
          {o.assetUrl && o.product === 'spotlight' ? (
            <img src={o.assetUrl} alt="" />
          ) : (
            <span className="sponsor-project-monogram" aria-hidden="true">
              {(o.projectName || o.from || 'GM').slice(0, 2).toUpperCase()}
            </span>
          )}
          <div>
            <span className="sponsor-kicker">
              SPONSORED · {o.status === 'fulfilled' ? 'AIRED' : 'ON AIR'}
            </span>
            <h3>{o.projectName || o.from || 'A voice from the trenches'}</h3>
            <p>{o.message}</p>
            {o.projectUrl && (
              <a href={o.projectUrl} target="_blank" rel="noreferrer sponsored">
                Explore the project <ArrowUpRight size={13} />
              </a>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
