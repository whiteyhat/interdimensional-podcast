'use client';
import { useRef } from 'react';
import {
  Check,
  ExternalLink,
  Radio,
  RotateCcw,
  Shirt,
  Upload,
} from 'lucide-react';
import type { SponsorReceipt as Receipt } from '@/lib/sponsorship';
import {
  LOOK_COPY,
  capAheadCopy,
  deliveryProgress,
  dollars,
  productCopy,
  receiptStage,
  type LookView,
} from '@/lib/sponsor-client';
const labels = {
  payment: 'Confirming payment',
  tailoring: 'Your tee and cap are being tailored',
  queued: 'You’re in the queue',
  preparing: 'Your moment is being prepared',
  'on-air': 'Your sponsorship is on air',
  paused: 'Saved for the next live slot',
  delivered: 'That was your moment.',
};
export function SponsorReceipt({
  receipt,
  busy,
  look,
  onAction,
  onReplaceLogo,
  onNew,
}: {
  receipt: Receipt;
  busy: boolean;
  /** The wardrobe state of a paid cap order; null for every other order. */
  look: LookView | null;
  onAction: (action: 'reschedule') => void;
  onReplaceLogo: (file: File) => void;
  onNew: () => void;
}) {
  const replaceFile = useRef<HTMLInputElement>(null);
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
        : ['tailoring', 'queued', 'preparing', 'paused'].includes(stage)
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
        ) : stage === 'tailoring' ? (
          <Shirt size={22} />
        ) : (
          <Radio size={22} />
        )}
      </div>
      <p className="sponsor-kicker">{look?.label ?? 'YOUR ON-AIR PASS'}</p>
      <h3 aria-live="polite" aria-atomic="true">
        {look?.kind === 'refused' ? 'Your logo needs a change' : labels[stage]}
      </h3>
      <p>
        {(stage === 'tailoring' || look?.kind === 'refused') && look?.line
          ? look.line
          : stage === 'paused'
            ? 'Your remaining placement is safe. It resumes in the next live slot.'
            : stage === 'delivered'
              ? 'From your wallet to the conversation. Thanks for being part of the show.'
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
      {/* Caps for one host go on one at a time: a paid cap can be next in the queue and
          still be waiting for an earlier cap on the same host. Say so. */}
      {receipt.capAhead ? (
        <p className="sponsor-cap-ahead">
          {capAheadCopy(receipt.capAhead, receipt.draft.target)}
        </p>
      ) : null}
      {/* A slow, fallback or refused fit offers a way out: a different logo goes through the
          same check and the order keeps its place. The order is never lost. */}
      {look?.replace ? (
        <div className="sponsor-look-replace">
          {look.kind === 'ready' && look.line ? <p>{look.line}</p> : null}
          <input
            className="sr-only"
            ref={replaceFile}
            id="sponsor-replace-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              if (chosen) onReplaceLogo(chosen);
            }}
          />
          <button
            type="button"
            className="sponsor-button secondary"
            disabled={busy}
            onClick={() => replaceFile.current?.click()}
          >
            <Upload size={15} />
            {LOOK_COPY.replace}
          </button>
        </div>
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
      <div className="sponsor-receipt-links">
        <a href={`/?receipt=${encodeURIComponent(receipt.token)}`}>
          Open receipt <ExternalLink size={12} />
        </a>
        {attempt?.explorerUrl && (
          <a
            href={attempt.explorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            Payment on Solana <ExternalLink size={12} />
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
      {/* Every paid pass leads somewhere: a way back to the placements is always one tap. */}
      {stage !== 'payment' ? (
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
