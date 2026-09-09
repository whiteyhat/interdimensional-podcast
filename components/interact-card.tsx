'use client';
import { useEffect, useState } from 'react';
import type { PublicConfig, PublicRequest } from '@/lib/interact';
import { readLegacyReceipt, legacyReceiptKey } from '@/lib/legacy-receipt';

type Props = {
  config: PublicConfig | null;
  request: PublicRequest | null;
  onReference?: (reference: string | null) => void;
};
/** Existing receipts remain recoverable without reconnecting a wallet or buying another seat. */
export function InteractCard({ request, onReference }: Props) {
  const [receipt, setReceipt] =
    useState<ReturnType<typeof readLegacyReceipt>>(null);
  const [status, setStatus] = useState('pending'),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const stored =
          localStorage.getItem(legacyReceiptKey) ||
          sessionStorage.getItem(legacyReceiptKey);
        const r = readLegacyReceipt(stored);
        setReceipt(r);
        if (r) localStorage.setItem(legacyReceiptKey, JSON.stringify(r));
      } catch {
        /* Storage is optional. */
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    onReference?.(receipt?.reference ?? null);
  }, [receipt?.reference, onReference]);
  useEffect(() => {
    if (!receipt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const response = await fetch('/api/interact', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'confirm',
            reference: receipt!.reference,
            ...(receipt!.signature ? { signature: receipt!.signature } : {}),
          }),
          signal: controller.signal,
        });
        const result = (await response.json()) as {
          status?: string;
          error?: string;
        };
        if (controller.signal.aborted) return;
        if (!response.ok)
          throw Error(
            result.error || 'Payment checking is temporarily unavailable.',
          );
        const next = ['paid', 'claimed', 'aired'].includes(result.status || '')
          ? result.status!
          : 'pending';
        setStatus(next);
        setError('');
        if (next !== 'pending') {
          try {
            localStorage.setItem(
              legacyReceiptKey,
              JSON.stringify({ ...receipt, paid: true }),
            );
          } catch {
            /* The server also keeps the receipt. */
          }
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : 'Your receipt will reconnect shortly.',
          );
      }
      if (!controller.signal.aborted) timer = setTimeout(check, 10000);
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [receipt, retry]);
  if (!receipt)
    return (
      <p className="muted">
        Your earlier payment has its own reference. New sponsorships are
        available above.
      </p>
    );
  const actual =
    request?.reference === receipt.reference &&
    ['paid', 'claimed', 'aired'].includes(request.status)
      ? request.status
      : status;
  return (
    <section
      className="sponsor-legacy-receipt"
      aria-label="Earlier payment receipt"
    >
      <output>
        {actual === 'aired'
          ? 'Your earlier message aired.'
          : actual === 'paid' || actual === 'claimed'
            ? 'Your earlier payment is confirmed.'
            : 'Checking your earlier payment.'}
      </output>
      {request?.position && actual !== 'aired' ? (
        <p>
          Queue position {request.position}. Timing follows the live broadcast.
        </p>
      ) : null}
      {actual === 'pending' && (
        <p>
          The quote timer has ended, but a payment may still arrive. Keep this
          receipt while we check the same reference.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="sponsor-text-button"
        onClick={() => setRetry((n) => n + 1)}
      >
        Check payment again
      </button>
      <small className="sponsor-receipt-id">
        REFERENCE {receipt.reference}
      </small>
    </section>
  );
}
