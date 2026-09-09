'use client';
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The Solana Pay library mounts a generated SVG QR into this image container. */
import { useEffect, useRef, useState } from 'react';
export function SponsorQR({ url }: { url: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    import('@solana/pay')
      .then(({ createQR }) => {
        if (!live || !root.current) return;
        root.current.replaceChildren();
        createQR(url, 204, '#efece4', '#171918').append(root.current);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <div className="sponsor-qr">
      <div ref={root} aria-label="Scan with a Solana wallet" role="img" />
      {error && (
        <p>The QR could not load. Open your wallet using the link below.</p>
      )}
      <a className="sponsor-button secondary" href={url}>
        Open in your wallet ↗
      </a>
      <p>
        Scan with a Solana Pay wallet. Keep this page open to follow
        confirmation.
      </p>
    </div>
  );
}
