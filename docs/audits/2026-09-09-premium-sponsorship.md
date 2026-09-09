# Premium sponsorship verification — September 9, 2026

Implemented the approved public sponsorship catalog, stable preview/checkout, three payment assets, durable receipts, delivery console, scoped sponsored dialogue and cap compositor. Details and remaining deployment configuration are in [the operations runbook](../SPONSORSHIP.md).

## Evidence

- **296 Node tests passed**, including payment amount/rounding, signature separation, native versus SPL validation, reference pagination, duplicate/late settlement, refund idempotency/liquidity, capacity, immutable artwork, playback recovery, shared producer ownership and broadcast deadline extension. Baseline before this implementation was 167 tests; the current workspace also contains parallel launch/broadcast work.
- TypeScript passed. Targeted lint of sponsorship, changed playback and recovery files passed. The production build passed; Vite reports its existing large-chunk warning.
- The real Chrome checkout rehearsal passed: USDC default, saved draft/asset, 30% discount, validation focus, QR receipt recovery without another quote, actual queue position, paused refund flow, 320px layout, 16px mobile inputs, native keyboard navigation and reduced motion.
- The real wallet adapter with an isolated simulated wallet passed rejection, lost-broadcast-response and verified-expiry recovery tests. Rejection sent nothing; signing preserved both signatures; confirmation and polling restored checkout on the same order after verified expiry. An elapsed frontend timer and older expired attempts did not release an ambiguous current payment; paid receipts took precedence and reload created no payment. No chain transactions were submitted.
- Real Chrome media checks passed four recovery checks and all 13 existing audio checks: one audible source, approved speech interval, silent tails, seeking, handoff and unmount cleanup.
- Seven Python media tests passed, including difficult/malformed uploads, ambiguous panels, hand-like occlusions, tracking rejection and actual FFmpeg audio/timing preservation.
- **12 real generated/composited qualification clips passed: 2,916 frames.** Both hosts used graphic and text marks across three accepted takes, including held-out footage. A held-out Chad take with a hand touching the cap failed tracking and produced no admitted output; one bounded replacement passed. Seven ten-second source generations were used in total. Original audio packets and timestamps matched exactly on every accepted composite. Contact sheets were visually reviewed for both hosts and marks.

Qualification is tied to [the public artifact proof](../../public/wearables/caps-v1-qualification.json). Source clips, reports and browser screenshots remain under `work/wearable-qualification/` and `work/sponsor-browser/`.

## Audit fixes

The work fixed lost payment-response retries, conflated broadcast/verified signatures, legacy scans stopping at failed reference transactions, unresolved receipts disappearing on frontend expiry, and fulfillment being inferred before actual playback. New attempt/fulfillment/refund records keep these states separate.

The final review found and fixed failed playback gates leaving orders locked, incomplete compensation when multiple order references share a clip, lease renewal during an ambiguous pause, stale pause/resume authorization, late play promises reviving revoked footage, and recovery deadlocking after the producer heartbeat expired. API and actual-player tests cover these cases. Authenticated pause invalidation can outlive the producer heartbeat without bypassing exact lease ownership.

The follow-up review fixes unify legacy and sponsorship queue ownership through one atomic producer lease, while retaining separate delivery-readiness heartbeats. Direct requests, bridges and media/context requests now normalize producer identities consistently, including absent or noncanonical names. Checkout releases an ambiguous payment only when the server confirms the attempt expired and the order is unpaid, then quotes against the same receipt. Extending a broadcast preserves any longer deadline already accepted at startup, including a 48-hour run beyond the default daily cap.

Cap reservations are enforced atomically at payment-attempt insertion. Paused placements and ambiguous payments retain the reservation; a browser timer cannot free it. Verified expiry, completed delivery or atomic refund cancellation releases it. Late payment evidence is always preserved, even if a later reservation requires it to queue.

## Release status

Local implementation and verification are complete. Production checkout is disabled by default. The live staging environment/refund wallet was not selected during this run; service-container execution, physical mobile wallet handoff and the full live staging catalog/refund rehearsal remain release gates. No production payment, refund or deployment was performed. The completed local browser tests deliberately simulated chain responses and are not represented as live staging transactions.
