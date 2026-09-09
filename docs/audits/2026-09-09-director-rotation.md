# Hourly Director rotation

The local producer has a separate Director console at `/studio/director`. Its default target is **3,600 seconds**, following the operator's request. This does not change the verified clip engine at `/studio`.

## Handover behavior

- Prepare one replacement 90 seconds before the current connection's target deadline. At most two sessions are owned, including pending creation and shutdown. Shorter reported limits reduce the schedule.
- Keep at least eight seconds of decoded opening footage before allowing a replacement on air. The incoming WebRTC stream is recorded into a MediaSource buffer so its opening is retained while the current session plays.
- Prefer a quiet outgoing reaction in the final 30 seconds. If necessary, transfer five seconds before the deadline when the replacement is ready. A late replacement leaves the outgoing picture available rather than switching to an unready player.
- Prime and rewind the replacement before transferring the output. Only one output gain is audible. A 12 ms incoming ramp reduces clicks. Incoming live consumers stay muted; they cannot bypass the output mixer.
- Track transport failure, stalled playback/video frames and audio/video tracks muted for ten seconds. Recover with another session and exponential backoff, while existing buffered footage can continue. Six failed preparations stop the run; terminal provider errors also stop it.
- Stop aborts pending work, closes both connections, stops recording/tracks and releases object URLs. Restart and the cross-tab Web Lock wait for actual asynchronous connection cleanup.
- Remove played footage, retaining roughly 15–25 seconds behind playback. Bound unplayed media to 150 seconds and queued recording data to 32 MiB. Exceeding a bound fails that feed and begins recovery.

The one-hour clock starts conservatively when a session is requested, including preparation. Normal cuts occur shortly before that hour. OBS keeps the same browser source, so it does not reconnect its public RTMP output during handover.

## Live evidence, September 9, 2026

A bounded test opened two real `minimax/h3-max/director` sessions with the configured local fal account:

| Observation | Result |
| --- | --- |
| Reported `max_session_seconds` | 7,200 on both connections |
| First session opening ready | 29.366 seconds from test start |
| Replacement opening ready | 29.576 seconds after its request |
| First take operation | 25 ms |
| Replacement take operation | 16 ms |
| Retained replacement opening | Playback started at the beginning |
| Played-buffer cleanup | Buffered start advanced to 12.715 s by 25.854 s of playback |
| Test termination | Both connections and their media resources closed |

Full local diagnostic evidence is in ignored `work/director-audit/live-result.json`. The entitlement is the server's report during this test, not proof of a complete two-hour run or a permanent account guarantee. The implementation deliberately retains the requested one-hour target. The handover timing is one observation, not an SLA or a measurement of semantic sentence continuity.

## Issues found during implementation

The Cloudflare Worker runtime rejected Fetch's `redirect: 'error'` option. The allowlisted signalling proxy now uses `manual` and refuses redirects before following any destination. It forwards only the required JSON and server-side fal authentication. The route accepts only loopback producer requests with a matching origin; it is unavailable on the public deployment.

Live remote tracks initially arrived and generated chunk events continued, but the direct recorder path did not produce playable media. The working path keeps a muted live video consumer and routes remote audio through Web Audio into a local recording stream. With loopback ICE connectivity verified, the direct-recorder control timed out while the consumer-only, audio-bridge-only and complete paths passed the same media assertions. The deployed implementation retains the complete path used in the real fal overlap test. This audio bridge does not connect to speakers. Only the decoded broadcast player connects through its controlled output gain.

A shifted-timestamp browser test also reproduced an indefinite startup wait when the first buffered timestamp was 0.4 seconds rather than zero. Off-air preparation now seeks to the first playable timestamp before testing readiness.

The independent review found cancellation, async cleanup and late-limit races. Regression checks now cover throwing or unresolved handovers, expired replacement limits, failed standby backoff, interrupted creation, repeated close calls, cleanup across Stop/Start, and prolonged audio-only track outages.

## Editorial and operating scope

Sourced news and dated historical Solana/memecoin briefs guide Director. Bounded external editorial context carries across connections. These briefs are not a transcript of what the model actually said, and fal does not document exporting its internal scene memory to a new session. Character and narrative continuity are therefore best efforts.

This experimental mode uses generated live speech. It does **not** have the verified utterance gate used by standard clips, cannot separate two voices already mixed inside one generated track, and does not claim or acknowledge paid requests. Use `/studio` for that existing workflow.

Keep one producer/OBS browser running. The public site continues receiving the single OBS/Cloudflare broadcast; viewers do not open fal sessions. Use Chrome or a compatible OBS browser supporting WebRTC, WebM MediaRecorder, MediaSource and Web Audio. Overlap and any admitted retries consume fal credits. No unattended paid broadcast was left running, and no full-hour or 24-hour media soak was performed.

## Validation

All 151 unit tests, TypeScript checks, targeted Director lint and the production build passed. The unit suite includes a simulated 24-hour rotation run, not 24 hours of live generation. Browser fixtures exercise real recording/playback, exclusive gains, retained openings, cancellation, provider lifecycle and audio mute recovery. `tests/browser/director-webrtc.html` additionally uses actual loopback peer connections; its runner needs numeric host candidates or fake-device microphone permission so local ICE connects. An ICE failure is not treated as recorder evidence.

Run `npm test`, `npx tsc --noEmit`, the targeted Director lint checks, and `npm run build`. Run `node tests/browser/serve.mjs` for browser fixtures. Browser tests must use an isolated test browser; live checks are separate and charge fal credits.

Contract sources: [fal Director API](https://fal.ai/models/minimax/h3-max/director/api), [fal Director overview and account extensions](https://fal.ai/h3-max-director). The client is pinned to `@fal-ai/client@1.11.0-alpha.3` because its realtime interface is experimental.
