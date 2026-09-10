'use client';
import { Check } from 'lucide-react';

/** Checkout wears its progress: one decision per step, and what is already done stays done. */
export function SponsorStepper({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) {
  return (
    <ol className="sponsor-stepper" aria-label="Checkout steps">
      {steps.map((label, i) => {
        const index = i + 1;
        const state =
          index < current ? 'done' : index === current ? 'active' : 'next';
        return (
          <li
            key={label}
            className={`sponsor-stepper-item ${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="sponsor-stepper-dot" aria-hidden="true">
              {state === 'done' ? <Check size={11} strokeWidth={3} /> : index}
            </span>
            <span className="sponsor-stepper-label">
              <span className="sr-only">
                {`Step ${index} of ${steps.length}${state === 'done' ? ', done' : ''}: `}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
