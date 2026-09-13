'use client';
/* oxlint-disable next/no-img-element -- Canonical wardrobe and broadcast artwork. */
import { useEffect, useRef } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';
import type { SponsorDraft } from '@/lib/sponsorship';
import {
  LOOK_COPY,
  baseStill,
  logoSwatchUrl,
  lookAlt,
  type LookView,
} from '@/lib/sponsor-client';

/** A preview is deliberately labeled: it never represents something currently on air. */
export function SponsorPreview({
  draft,
  artwork,
  paid = false,
  look = null,
}: {
  draft: SponsorDraft;
  /** A spotlight's stored logo. A cap never passes one: its card is the still or the look. */
  artwork?: string | null;
  paid?: boolean;
  /** A paid cap order's wardrobe state; null before payment and for every other product. */
  look?: LookView | null;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = panel.current;
    if (
      !node ||
      !matchMedia(
        '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)',
      ).matches
    )
      return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.hidden) return;
        const rect = node.getBoundingClientRect();
        node.style.setProperty('--cursor-x', `${e.clientX - rect.left}px`);
        node.style.setProperty('--cursor-y', `${e.clientY - rect.top}px`);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      node.style.removeProperty('--cursor-x');
      node.style.removeProperty('--cursor-y');
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', leave);
    return () => {
      leave();
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
    };
  }, []);
  const hostName = draft.target === 'guest' ? 'Chad' : 'Pepe';
  // The card image, in order: the look once it is ready, otherwise the host's own still
  // with the stored logo as a swatch. Never the asset URL (the logo while the tailor works)
  // and never a local upload: nothing is generated before payment.
  const lookUrl = look?.kind === 'ready' ? look.url : null;
  const swatch = lookUrl ? null : logoSwatchUrl(draft.assetId);
  return (
    <div
      ref={panel}
      className={`sponsor-preview ${draft.product}${
        look?.kind === 'tailoring' ? ' tailoring' : ''
      }`}
    >
      <div className="sponsor-preview-light" aria-hidden="true" />
      <div className="sponsor-preview-label">
        <Radio size={12} />
        <span>
          {look ? look.label : paid ? 'YOUR ON-AIR PASS' : 'PLACEMENT PREVIEW'}
        </span>
        <span>001</span>
      </div>
      {draft.product === 'cap' ? (
        <>
          <div className="sponsor-look-frame">
            {lookUrl ? (
              <img
                key={lookUrl}
                className="sponsor-host-art look"
                src={lookUrl}
                alt={lookAlt(draft.target)}
              />
            ) : (
              <img
                className="sponsor-host-art"
                src={baseStill(draft.target)}
                alt={`${hostName}, not yet dressed`}
              />
            )}
            {swatch ? (
              <img className="sponsor-logo-swatch" src={swatch} alt="Your logo" />
            ) : null}
          </div>
          <div className="sponsor-preview-caption">
            <span>WARDROBE / {hostName.toUpperCase()}</span>
            <b>{draft.projectName || 'Make the tee and cap yours.'}</b>
            <small>
              {look
                ? (look.line ?? '10 live minutes · 6+ appearances')
                : LOOK_COPY.previewCaption}
            </small>
          </div>
        </>
      ) : draft.product === 'spotlight' ? (
        <>
          {/* The cover shows the purchase itself: the card that sits on the
              broadcast while the hosts talk, drawn like the real one. */}
          <div className="sponsor-preview-stage">
            <div className="sponsor-preview-hosts" aria-hidden="true">
              <img src="/pepe-video.avif" alt="" loading="lazy" />
              <img src="/gigachad-video.avif" alt="" loading="lazy" />
            </div>
            <div className="sponsor-preview-banner">
              <span>SPONSORED</span>
              {artwork ? <img src={artwork} alt="" /> : null}
              <div>
                <b>{draft.projectName || 'Your project'}</b>
                <small>On screen for the whole exchange</small>
              </div>
              <ArrowUpRight size={15} />
            </div>
          </div>
          <div className="sponsor-cue">
            <span className="sponsor-cue-label">FOUR TURNS · SPONSORED</span>
            <p>
              {draft.message ||
                'A real conversation about what you’re building.'}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="sponsor-preview-hosts" aria-hidden="true">
            <img src="/pepe-video.avif" alt="" loading="lazy" />
            <img src="/gigachad-video.avif" alt="" loading="lazy" />
          </div>
          <div className="sponsor-cue">
            <span className="sponsor-cue-label">FROM THE TRENCHES</span>
            <div className="sponsor-cue-name">
              <b>Straight to the hosts.</b>
            </div>
            <p>
              {draft.message ||
                '“Chad, is holding still a strategy if I forgot my password?”'}
            </p>
          </div>
        </>
      )}
      <div className="sponsor-preview-footer">
        <span>PEPE & CHAD LIVE</span>
        <span>{paid ? 'RESERVED FOR YOU' : 'THIS COULD BE YOU ↗'}</span>
      </div>
    </div>
  );
}
