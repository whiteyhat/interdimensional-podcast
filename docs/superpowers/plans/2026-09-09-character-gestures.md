# Scheduled character gestures

**Goal:** GigaChad drinks tea about every 70 seconds of show playback; Pepe lights a cigar and takes a puff about every 90 seconds. Each performance returns to the original frame.

**Design:** Reserve gestures when submitting a short spoken turn (at most seven words). The character finishes the line before handling props. Use eight seconds for tea and ten for the cigar. A scheduler uses completed playback plus the current and buffered shots to estimate the next shot's start. Pauses and render delays do not advance this clock. Wait for preceding shots to decode before reserving a gesture, and reconcile its cooldown with the decoded duration. Keep an eligible due turn in the draft until those predecessors finish so a slow renderer cannot starve gestures. Wait for the character's next suitable turn and leave at least twelve seconds of ordinary conversation between gestures. Intervals are approximate, and a character without a short turn waits longer.

All generated shots use the existing reference as both `image_url` and `end_image_url`, at 1080P. Prompt the final second as a settled return to that pose. GigaChad's mug stays in its original location. Pepe retrieves and lowers props below the frame, and smoke clears before the ending. Reference images remain unchanged. Video generation can still introduce artifacts; rendered samples need visual inspection.

Gesture metadata is separate from spoken text, validated against the character and line length on the server, and included in the render cache key. A reserved slot keeps its gesture during retry; a new run resets the schedule. Paid request dialogue and ordering remain intact.

**Implementation and validation:**

- [x] Add failing tests in `tests/gestures.test.mjs` and `tests/engine.test.mjs`: timing, eligibility, spacing, playback accounting, retry and restart.
- [x] Add `lib/gestures.ts` for definitions, validation, and reservations; extend `lib/show.ts` for gesture metadata, duration, prompt choreography, and a shared provider input builder.
- [x] Wire reservation into `lib/engine.ts`, provider input into `app/api/podcast/route.ts`, and gesture-aware cache keys into `lib/services.ts`. Update studio duration estimates.
- [x] Run unit tests, TypeScript, lint, and whitespace checks. Review the implementation and document how to tune the intervals.
- [x] Generate and inspect one sample per action if the local provider is available. Report visual limitations honestly.

**Commands:** `node --test tests/gestures.test.mjs tests/engine.test.mjs`; `node --test tests/*.test.mjs`; `npx tsc --noEmit`; `npx oxlint`; `git diff --check`.

**Provider reference:** https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api (read 2026-09-09; supports `end_image_url` and `1080P`).

**Sample review:** Generated a tea shot and two cigar versions through the local API. Inspected frame sheets and final frames. The tea sample returns the mug to the desk; the revised cigar instructions improve hand/prop continuity and retain the wristwatch. Both return close to the character reference. These are generated performances, not a guarantee against artifacts in later shots. Local previews: `work/gesture-preview/tea.mp4` and `work/gesture-preview/cigar-v2.mp4`.

**Verification:** All 101 tests pass. The feature review also exercised normal and slow rendering with varying decoded durations. Project type checking currently reports unrelated hook export/call mismatches in the payment components during concurrent workspace edits; full repository lint also reports existing UI/test violations.
