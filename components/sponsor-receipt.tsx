'use client';
import { Check, ExternalLink, Radio, RotateCcw } from 'lucide-react';
import type { SponsorReceipt as Receipt } from '@/lib/sponsorship';
import {
  deliveryProgress,
  dollars,
  productCopy,
  receiptStage,
} from '@/lib/sponsor-client';
const labels = {
  payment: 'Confirming payment',
  queued: 'You’re in the queue',
  preparing: 'Your moment is being prepared',
  'on-air': 'Your sponsorship is on air',
  paused: 'Saved for the next live slot',
  delivered: 'That was your moment.',
  refund: 'Your refund',
};
export function SponsorReceipt({
  receipt,
  busy,
  onAction,
  onNew,
}: {
  receipt: Receipt;
  busy: boolean;
  onAction: (action: 'reschedule' | 'refund') => void;
  onNew: () => void;
}) {
  const stage = receiptStage(receipt);
  const attempt =
    receipt.attempts.find((a) => a.status === 'verified') ??
    receipt.attempts[0];
  const steps = ['Payment received', 'In the queue', 'On air', 'Delivered'];
  const current =
    stage === 'delivered'
      ? 3
      : stage === 'on-air'
        ? 2
        : stage === 'queued' || stage === 'preparing' || stage === 'paused'
          ? 1
          : 0;
  return (
    <section
      className={`sponsor-receipt ${stage}`}
      aria-label="Your sponsorship receipt"
    >
      <div className="sponsor-receipt-seal" aria-hidden="true">
        {stage === 'delivered' ? (
          <Check size={24} />
        ) : stage === 'paused' ? (
          <RotateCcw size={22} />
        ) : (
          <Radio size={22} />
        )}
      </div>
      <p className="sponsor-kicker">YOUR ON-AIR PASS</p>
      <h3 aria-live="polite" aria-atomic="true">
        {labels[stage]}
      </h3>
      <p>
        {stage === 'paused'
          ? 'Your remaining placement is safe. Resume it in the next live slot, or request a refund.'
          : stage === 'delivered'
            ? 'From your wallet to the conversation. Thanks for being part of the show.'
            : stage === 'refund'
              ? 'The amount you paid returns in the original asset. The studio covers the refund network fee.'
              : 'Keep watching. This receipt follows your placement through the studio.'}
      </p>
      <div className="sponsor-receipt-details">
        <span>{productCopy[receipt.draft.product].title}</span>
        <strong>
          {attempt
            ? `${attempt.amountUi} ${attempt.asset}`
            : dollars(receipt.priceCents)}
        </strong>
      </div>
      {receipt.queuePosition ? (
        <p className="sponsor-queue-position">
          Queue position <strong>{receipt.queuePosition}</strong> · We’ll update
          this as the show moves.
        </p>
      ) : null}
      {receipt.draft.product === 'cap' && (
        <div className="sponsor-delivery-progress">
          <progress max={100} value={deliveryProgress(receipt.fulfillment)} />
          <span>
            {Math.min(10, Math.floor(receipt.fulfillment.visibleMs / 60000))} /
            10 live minutes · {receipt.fulfillment.appearances} appearances
          </span>
        </div>
      )}
      {stage !== 'refund' && (
        <ol className="sponsor-receipt-steps">
          {steps.map((label, i) => (
            <li key={label} className={i <= current ? 'reached' : ''}>
              <span>
                {i < current || stage === 'delivered' ? (
                  <Check size={11} />
                ) : (
                  i + 1
                )}
              </span>
              {label}
            </li>
          ))}
        </ol>
      )}
      {receipt.refund && (
        <p className="sponsor-refund-state">
          Refund{' '}
          {receipt.refund.status === 'confirmed'
            ? 'confirmed'
            : receipt.refund.status === 'blocked'
              ? 'waiting for the studio to resolve'
              : 'in progress'}
          {receipt.refund.error ? `. ${receipt.refund.error}` : '.'}
        </p>
      )}
      <div className="sponsor-receipt-links">
        <a href={`/?receipt=${encodeURIComponent(receipt.token)}`}>
          Open receipt <ExternalLink size={12} />
        </a>
        {attempt?.verifiedSignature && (
          <a
            href={`https://solscan.io/tx/${encodeURIComponent(attempt.verifiedSignature)}`}
            target="_blank"
            rel="noreferrer"
          >
            Payment on Solana <ExternalLink size={12} />
          </a>
        )}
        {receipt.refund?.signature && (
          <a
            href={`https://solscan.io/tx/${encodeURIComponent(receipt.refund.signature)}`}
            target="_blank"
            rel="noreferrer"
          >
            Refund on Solana <ExternalLink size={12} />
          </a>
        )}
      </div>
      {receipt.canReschedule && (
        <button
          type="button"
          className="sponsor-button"
          disabled={busy}
          onClick={() => onAction('reschedule')}
        >
          Use the next live slot →
        </button>
      )}
      {receipt.canRefund && (
        <button
          type="button"
          className="sponsor-text-button"
          disabled={busy}
          onClick={() => onAction('refund')}
        >
          Request a full refund
        </button>
      )}
      {!['payment', 'refund'].includes(stage) ||
      receipt.status === 'refunded' ? (
        <button
          type="button"
          className="sponsor-button secondary"
          onClick={onNew}
        >
          Create another moment
        </button>
      ) : null}
      <small className="sponsor-receipt-id">
        PASS {receipt.id.slice(0, 8).toUpperCase()} · Keep your receipt link
        private.
      </small>
    </section>
  );
}
