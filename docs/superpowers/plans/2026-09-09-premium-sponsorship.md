# Premium Sponsorship Implementation Plan

Approved September 9, 2026. Work in the current workspace preserves the existing broadcast, audio and deployment changes.

**Goal:** A premium public sponsorship journey with $5 messages, $25 spotlights, $100 cap placements; direct SOL/USDC/FROGCLENCH payment and a 30% FROGCLENCH discount.

**Architecture:** Shared catalog and immutable order/payment contracts in TypeScript; D1 persists attempts, delivery events and refunds; the clip studio leases work and reports playback. A dedicated media worker composites uploaded marks onto tracked cap templates. Public UI keeps a stable preview through wallet/QR checkout and durable receipts.

**Approved policy:** Instant self-service caps, one style per host; ten healthy broadcast minutes, six appearances, introduction and callback. Reschedule unfinished orders, with self-service original-asset refunds before airing or while paused/failed. Paid dialogue at most once per two minutes. Director is ineligible until it advertises compatible capabilities.

## Work and verification

- [x] Shared catalog, exact prices, validated drafts and persistent orders/attempts.
- [x] Direct multiasset transfers, Solana Pay transaction requests, settlement/recovery and refund executor.
- [x] Public panel, editable previews, delayed wallet loading, QR handoff and durable receipts.
- [x] Asset ingestion, canonical templates, deterministic logo composition and tracked video worker.
- [x] Studio scheduling, scoped sponsored dialogue, playback evidence and producer console.
- [x] Regression tests for legacy payment retry/signature recovery issues.
- [x] Meaningful unit/integration tests, browser/mobile/accessibility checks, cap qualification trial.
- [x] Operational configuration and [release documentation](../../SPONSORSHIP.md).
- [ ] Live staging rehearsal; requires selected environment, test tokens and funded refund wallet. Production remains disabled.

Verification evidence: [implementation audit](../../audits/2026-09-09-premium-sponsorship.md).

Baseline: 167 existing tests passed before implementation. Production payments and refunds are never used as test fixtures. New availability checks must reflect functioning dependencies, not decorative demo state.
