'use client';
/* oxlint-disable next/no-img-element -- Canonical wardrobe and broadcast artwork. */
import { useEffect, useRef } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';
import type { SponsorDraft } from '@/lib/sponsorship';

/** A preview is deliberately labeled: it never represents something currently on air. */
export function SponsorPreview({
  draft,
  artwork,
  paid = false,
}: {
  draft: SponsorDraft;
  artwork?: string | null;
  paid?: boolean;
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
  const target = draft.target === 'guest' ? 'gigachad' : 'pepe';
  const hostName = draft.target === 'guest' ? 'Chad' : 'Pepe';
  return (
    <div ref={panel} className={`sponsor-preview ${draft.product}`}>
      <div className="sponsor-preview-light" aria-hidden="true" />
      <div className="sponsor-preview-label">
        <Radio size={12} />
        <span>{paid ? 'YOUR ON-AIR PASS' : 'PLACEMENT PREVIEW'}</span>
        <span>001</span>
      </div>
      {draft.product === 'cap' ? (
        <>
          <img
            className="sponsor-host-art"
            src={artwork || `/wearables/${target}-cap-v1.png`}
            alt={`${hostName} wearing the selected cap${artwork ? ' with your design' : ''}`}
          />
          <div className="sponsor-preview-caption">
            <span>WARDROBE / {hostName.toUpperCase()}</span>
            <b>{draft.projectName || 'Make the cap yours.'}</b>
            <small>10 live minutes · 6+ appearances</small>
          </div>
        </>
      ) : (
        <>
          <div className="sponsor-preview-hosts" aria-hidden="true">
            <img src="/pepe-video.png" alt="" />
            <img src="/gigachad-video.png" alt="" />
          </div>
          <div className="sponsor-cue">
            <span className="sponsor-cue-label">
              {draft.product === 'spotlight'
                ? 'SPONSORED SPOTLIGHT'
                : 'FROM THE TRENCHES'}
            </span>
            <div className="sponsor-cue-name">
              {draft.product === 'spotlight' && artwork ? (
                <img src={artwork} alt="Project logo" />
              ) : null}
              <b>
                {draft.product === 'spotlight'
                  ? draft.projectName || 'Your project, on the mic.'
                  : draft.name || 'Your name, in the room.'}
              </b>
            </div>
            <p>
              {draft.message ||
                (draft.product === 'spotlight'
                  ? 'A real conversation about what you’re building.'
                  : '“Chad, is holding still a strategy if I forgot my password?”')}
            </p>
            {draft.product === 'spotlight' && draft.projectUrl ? (
              <span className="sponsor-preview-link">
                {(() => {
                  try {
                    return new URL(draft.projectUrl).hostname;
                  } catch {
                    return 'Your project link';
                  }
                })()}
                <ArrowUpRight size={12} />
              </span>
            ) : null}
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
