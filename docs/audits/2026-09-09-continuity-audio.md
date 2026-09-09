# Continuity audio audit — September 9, 2026

The reproduced problem is unscripted speech inside the generated soundtrack, including the supposedly silent part of a gesture. Playing a single affected MP4 reproduces it; mixing two player elements is not necessary.

## Evidence

- Four saved room-gesture previews (`final-headphones`, `final-watch`, `final-shoulders`, `final-beard`) contain additional speech-like vocals after the scripted “Of course.” Local transcription detected activity through roughly 4.8–6.8 seconds. The saved tea and cigar controls contain only their intended lines.
- Fresh 10-second “Neither” and tea renders also contain additional speech. Three controlled prompt revisions specifying an isolated voice and absolute silence still produce it. This does **not** establish that the “offscreen partner” wording alone caused the problem: the generator does not reliably honor silent tails.
- An independent hosted Whisper word-alignment/diarization run confirms the headphone take continues after the expected phrase, ending its scripted utterance at 1.15 seconds. The detector labels this entire example as one speaker; checking speaker count alone would not catch it.
- Decoded audio hashes of `native-fixed`, its local upscale, and its hosted upscale are identical. The scaler preserved the soundtrack in that comparison.
- The real Player and engine completed 20 audible transitions with no simultaneously playing, unmuted media sources. Previous handoff tests used muted video and checked picture presentation only.

The pipeline previously accepted any decodable video and broadcast its entire soundtrack. Instructions asking the model to stop speaking were the only audio-content control.

## Fix

1. After native rendering, run word-level transcription and speaker analysis alongside the existing upscale. Match the complete scripted utterance at the beginning of the transcript. Allow punctuation, acronym spacing, and numeric formatting differences, without fuzzy substitutions or guessed speaking durations.
2. Reject missing words, extra opening words, invalid timestamps, incomplete speaker attribution, multiple detected speakers during the line, and excluded words overlapping its ending. A rejected clip never reaches the ready queue. Manual retry uses a different take seed; network and download retries reuse successful jobs.
3. Carry the verified `speechEnd` into the decoded clip. The Player routes the current video through one Web Audio gain stage. Schedule a short fade ending at the verified boundary on the audio clock, rather than depending on throttled `timeupdate` events. The full video continues, including every gesture and its resting end frame.
4. Pause, seek, rate changes, buffering, and resume reschedule or cancel the gate. A separate reproduced autoplay race is fixed: an obsolete manual-play promise can no longer clear the next clip's recovery button. Inactive videos are muted and paused. Outdated play events cannot take audio ownership. Unmount releases the audio context.
5. Keep the clearer solo-voice prompts as an instruction to the generator; they are not treated as a guarantee.

## Validation

The original contaminated headphone clip was played through the updated **real Player**, and its Web Audio output was recorded. Independent local transcription returns only “Of course.” FFmpeg detects silence from approximately 1.244 seconds through the recording's 10.199-second end (about 8.95 seconds). The small recording offset includes browser/audio-output startup latency.

A fresh tea clip passed the complete browser service → native render → parallel upscale/Whisper → download/decode → Player path. It produced 10.144 seconds of footage, a verified speech end of 1.06 seconds, and a measured render pipeline time of 26.767 seconds. The recorded output independently transcribes to only “Of course.” Evidence and recordings are under ignored `work/audio-audit/`.

Final verification: 133 unit tests pass, TypeScript and the production build pass, and changed production files pass lint. All 13 real-audio browser checks pass under React StrictMode. The 20 handoff/autoplay checks pass with both native video-frame callbacks and the fallback; the added obsolete-click regression failed before its fix.

Run unit tests with `npm test`. Run `node tests/browser/serve.mjs` and open `/tests/browser/player-audio.html` for actual audio-decoder checks, or `/tests/browser/player-handoff.html` (also with `?fallback=1`) for visual handoff/autoplay checks. The audio fixture is a continuous tone; the test verifies that only the approved interval remains audible while the picture continues.

## Limits and operation

- Restart the studio transmission to replace clips buffered before speech metadata was introduced. Legacy clips without a verified boundary play silently; their unverified soundtrack is never enabled as a fallback.
- This controls the studio/broadcast Player's audio. Raw provider MP4 URLs retain the original generated soundtrack; downloading those URLs bypasses the playback gate.
- Transcription and diarization are model estimates, not source separation. Unclear slang can conservatively reject a take, and undetected simultaneous speech inside the approved utterance remains a possible limitation. This fix removes the reproduced trailing-vocal failure; it does not claim to repair arbitrary mixed audio.
- Each take adds a hosted speech-analysis job, concurrent with scaling. The measured pipeline remained below the existing three-worker/ten-second-per-clip average budget, but one sample is not a sustained throughput guarantee. Provider latency and retries still matter.

Provider contracts checked: [Whisper word timestamps and diarization](https://fal.ai/models/fal-ai/whisper/api), [H3 input schema](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api). H3's hosted image-to-video schema provides no separate deterministic speech track input.
