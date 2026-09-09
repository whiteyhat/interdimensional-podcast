# Pump.fun launch tooling implementation plan

Approved scope: reusable metadata/minting CLI, local wallet signing, declared project-wallet
allocations, dated public reports, and verified site handoff. No automated market trading or
wallet-fleet generation. Operator-selected metadata, addresses, network, and budgets remain
required launch-time inputs.

- [x] Validate explicit configuration and project-wallet declarations.
- [x] Persist a private mint identity, locked workspace, upload receipts, and numbered transactions.
- [x] Use pinned Pump SDK instructions for atomic creation and an explicitly capped creator buy.
- [x] Verify decoded instructions, account roles, signatures, network, and expiry in shared code.
- [x] Add a development-only local signing page using the existing wallet provider.
- [x] Record signatures before submission and reconcile uncertain outcomes without replacing mint identity.
- [x] Export dated wallet reports and display them at /allocations.
- [x] Add treasury-account preparation, configuration export, site checks, and an operator runbook.
- [x] Complete final automated checks, production build, and independent review.

Verification: 40 launch/Solana/RPC/route checks and 30 browser assertions passed, along with
TypeScript, scoped lint, whitespace checks, and the production build. Independent review
findings have regression coverage. RPC responses were simulated; no launch was broadcast.

The detailed operator flow and limitations are documented in docs/PUMP_LAUNCH.md.
