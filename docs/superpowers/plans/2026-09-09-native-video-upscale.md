# Stable geometry at 1080P

The user identified vertical stretching inside the encoded MP4s. Full affine measurements isolate a nonuniform first/last-frame warp in H3's 1080P refinement, including a smaller residual with normalized references. Native 768P and a deterministic uniform upscale have stable geometry. The previous similarity-transform metric understated separate vertical motion; player handoff changes cannot correct these encoded pixels.

Generate at native 768P with the existing normalized start/end references, then scale once to height 1080 with fal's deterministic `workflow-utilities/scale-video` endpoint. Specify only height so width follows the source aspect ratio. Keep audio, frame count and end poses. The browser queues/caches the two jobs separately and only marks the final downloaded and decoded 1080P clip ready. Retrying a scaling/download failure must reuse completed native generation and the existing scaler job.

Validate the native/scale input contracts and job order with regression tests. Probe the hosted scaler for dimensions, frame count, audio preservation and first/last-frame affine geometry. Preserve the named old diagnostic examples as evidence and place replacement previews under `work/continuity/verified/`, with their exact inputs alongside them. A fresh studio run is needed to replace already-generated warped footage.

Implemented and verified: both stages have separate cache keys; only the scaled clip is downloaded and marked ready. All 108 tests and project TypeScript pass, as does targeted lint. A fresh browser call to the actual `createServices.render` completed both local API stages, download and decode in 17.7 seconds, yielding `verified/pipeline-1080.mp4` at 1890×1080, 175 frames at 24fps, with audio.

Full affine measurements of the hosted scaler output show maximum sampled axis variation 0.054%, compared with 0.702% for the fresh provider-1080 control, without the abrupt first/last-frame step. The hosted scaler preserves all 229 native AAC packets and their timestamps byte for byte. The scaling probe took 9.4 seconds before download; it adds a processing stage inside the existing two concurrent render slots. This is a uniform upscale of native footage, not generative high-resolution refinement. The new pipeline avoids the defective provider path rather than claiming to repair the provider's model.

Official contracts: https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api and https://fal.ai/models/fal-ai/workflow-utilities/scale-video/api. Full measurements and packet comparisons are saved in `work/continuity/verified/forensics/` and `hosted-upscale-probe.json`.

The separate final browser-pipeline render was also measured: maximum sampled axis variation 0.086%; at frame 2 (83ms), vertical change is only −0.0022% with 0.006px translation, instead of the earlier boundary step. Its evidence is in `verified/pipeline-forensics/`. Browser playback decoded the 1080P result without console errors.
