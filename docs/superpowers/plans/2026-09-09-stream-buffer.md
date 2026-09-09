# Keep generation ahead of playback

The stream exhausted its upcoming footage even when every provider request succeeded.
A measured native render, uniform 1080P upscale, download, and decode took 17.707
seconds for 7.296 seconds of playable video (`work/continuity/verified/pipeline-result.json`).
With two concurrent pipelines, 5–7 second clips could consume footage faster than
it arrived. Starting after three clips and limiting preparation to four slots left
little protection. The gesture scheduler also stopped submitting ordinary dialogue
while it waited for preceding clips to decode.

## Changes

- Keep clips at least 10 seconds long, allowing 11 for longer speech. Short lines
  finish normally and leave an animated listening tail.
- Run up to three complete render pipelines concurrently.
- Start only after 40 seconds of contiguous downloaded, decoded footage exists.
  A finished clip beyond an unfinished predecessor cannot satisfy this threshold.
- Prepare toward 60 seconds ahead, including outstanding jobs, with a hard cap of
  eight slots. Use actual decoded durations as they become available.
- After an underrun, rebuild 30 seconds before resuming. Keep the existing last-frame
  hold and never replay dialogue.
- Defer a due gesture to a later suitable short turn when preceding renders are
  outstanding and fewer than 40 playable seconds remain. With a healthy reserve,
  wait for decoded predecessors to preserve exact gesture spacing.
- Show startup progress in playable seconds in the producer console.

This trades additional warmup, prepared footage, and audience-request delay for
more consistent playback. The native 768P generation and uniform 1080P scaling
remain unchanged. Sustained provider failures still need the existing retry path.

## Verification

`tests/buffering.test.mjs` runs the real engine against a virtual provider clock:

- Fifteen minutes at an 18-second full-pipeline latency. The old implementation
  stalled 49 times; the new policy has no stalls and all six gestures still air.
- Fifteen minutes with 16–22 second renders and an occasional 45-second render.
  The old implementation stalled 44 times; the new policy has no stalls.
- Fifteen minutes with eight-second writing delays, 18–24 second renders, and
  decoded durations varying around the request also has no stalls.
- Out-of-order completions cannot prematurely start playback. Recovery waits for
  30 seconds and resumes the next unplayed clip.

The measured latency motivates the policy; simulations do not guarantee provider
throughput under every load. Existing scheduling, request ordering, stop/retry,
native-frame, upscale, and browser handoff tests cover related behavior.

## Tune for live interaction

The initial conservative policy used a 60-second startup and 90-second preparation
horizon. Reduce these to 40 and 60 seconds, respectively, retaining the three
pipelines, ten-second clip floor, and 30-second recovery reserve. The slot cap is
now eight. A 40-second target stalled in jitter tests; a 50-second target either
stalled or starved gestures depending on the startup threshold. The chosen policy
passes all three delay scenarios and preserves the six actions.

A regression test injects a real chat comment or paid request after 200 seconds
of operation and observes when the engine marks the response on air. Compare
against the former 60/90 policy; require at least a 20-second improvement with no
stalls. This measures engine queue delay, excluding chat transport and broadcast
delivery. Chat still waits for a dialogue batch and its topic-selection cadence.
