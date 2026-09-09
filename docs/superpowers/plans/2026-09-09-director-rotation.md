# Hourly Director rotation implementation plan

**Goal:** Run the local broadcast across one-hour fal Director sessions with early preparation, buffered opening playback, exclusive audio and recovery.

**Architecture:** An optional `/studio/director` console owns one on-air session and at most one replacement. Each incoming WebRTC stream is recorded into a bounded MediaSource buffer. The next opening is retained from its beginning, avoiding a mid-sentence cut into a live standby. Rotation starts preparing 90 seconds before a 3,600-second target; use a shorter reported provider limit when present. A quiet outgoing boundary in the last 30 seconds permits a handover, with a forced cut five seconds before the deadline if necessary. OBS keeps the same page and output throughout.

**Scope:** Local producer only; no fal credentials on the public site. Existing verified clip playback and paid-request engine remain available at `/studio`. Director's generated speech has no equivalent offline transcription gate, so this mode does not claim or acknowledge paid requests. Real news and dated historical story briefs guide Director, with bounded external topic context carried between sessions. Model memory itself is not transferable.

**Tech stack:** React/Vinext, pinned experimental fal client, WebRTC, MediaRecorder/WebM, MediaSource, Web Audio, Node test runner and isolated Chromium.

- [x] Test rotation at one hour, earlier reported limits, slow readiness, quiet and forced cuts, recovery/backoff, stop races and many simulated hours.
- [x] Implement independently testable rotation controller with a maximum of two sessions, clock injection and complete resource disposal.
- [x] Implement a local-only, allowlisted fal signalling proxy and test rejection of foreign origins, models, targets and redirects.
- [x] Implement bounded recorded playback, media readiness, exclusive audio, first-frame handover and cancellation.
- [x] Add the Director adapter, real-story programming context and operator console with manual start/stop, mute, status, and OBS autostart. Default session target: 3,600 seconds.
- [x] Exercise browser media with real audio/video fixtures, test adapters and run TypeScript, targeted lint, unit tests and production build.
- [x] Review implementation independently; document measured results and the unverified live/account assumptions. Do not launch an unattended paid stream.

## Verification limits

The requested one-hour target is implemented. A bounded live test subsequently reported a 7,200-second entitlement for both connections; the target remains 3,600 seconds. Public docs support account-specific extensions and publish `session_info.max_session_seconds`. A live overlap requires account capacity for two simultaneous sessions. Short, bounded live tests may check admission and media, but a complete hour or 24-hour soak is separate from deterministic clock tests. Quiet detection is energy-based; it cannot certify speaker identity or promise a complete sentence. Re-encoding adds latency and CPU load. Browser/OBS must remain running; this does not create a hosted broadcast worker.

Official contract checked September 9, 2026: https://fal.ai/models/minimax/h3-max/director/api and https://fal.ai/h3-max-director. SDK pinned after inspecting the alpha WMA transport.
