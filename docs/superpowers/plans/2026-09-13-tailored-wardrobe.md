# Tailored Wardrobe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paid sponsorship dresses Pepe or GigaChad in a T-shirt printed with the sponsor's logo and a cap in the brand's colours — one tailored still per logo and character, made after payment, judged twice, used as the start and end frame of every dressed clip — replacing the per-clip safe-zone composite and its tracker.

**Architecture:** The media desk on Railway (Node 22 + Python cv2) gains two routes: `POST /logo` normalises a logo and reads its palette at upload time, and `POST /tailor` runs a bounded job (garment plan → up to three `fal-ai/nano-banana-pro/edit` fits → pixel judge → `openrouter/router/vision` judge → deterministic cap-v1 fallback) that pushes every outcome back to the site with a bearer. The site stores the look in R2 under the asset, gates orders by stage (`order` before payment, `air` after), triggers the tailor once when a payment settles, recovers with a reads-first reconciler probe and bounded rounds, and serves the look at a content-addressed URL that `lib/show.ts` `shotInput` already feeds to MiniMax. The show side removes the composite branch, pins the look on every dressed shot, keeps one wardrobe per run, and tells the writer about both garments. The panel and receipt show the logo swatch before payment and the look after, with honest timing copy.

**Tech Stack:** Cloudflare Workers (vinext) + D1 + R2; Railway media desk (Node 22, Python 3.12, opencv-python-headless, numpy); fal.ai queue API (`fal-ai/nano-banana-pro/edit`, `openrouter/router/vision`, `minimax/h3-max-turbo/image-to-video`); React panel; node:test + assert/strict (`tests/build.mjs` transpiles lib/*.ts), Python unittest, Playwright browser suites.

**Spec:** `docs/superpowers/specs/2026-09-13-tailored-wardrobe-design.md` — the plan argues from it; read both.

## Global Constraints

- `LOOK_VERSION = 'looks-v1'` — exported from `lib/sponsorship.ts` (site-1, the single owner); the desk keeps its own literal `LOOK_VERSION = 'looks-v1'` in `broadcast/sponsor-media.mjs`, pinned to the site's by a desk test.
- Asset id = `sha256Hex(JSON.stringify([logoSha256, target, LOOK_VERSION]))`; R2 keys `${id}/logo.png` and `${id}/look-${lookSha256}.png`; look URL `/api/sponsorship/assets/${id}?part=look&v=${lookSha256}`; logo URL `/api/sponsorship/assets/${id}?part=logo`.
- Desk lane knobs: `tailorDeadlineMs 210_000`, `tailorFitMs 65_000`, `tailorConcurrency 2`, `tailorQueue 6`; `/render` keeps `deadlineMs 95_000`; drain stays `drainMs 100 s`, `SHUTDOWN_MS 105 s`, Railway `drainingSeconds 120`.
- Callback: `PUT ${SPONSOR_SITE_ORIGIN}/api/sponsorship/assets/${assetId}?part=look`, `Authorization: Bearer ${SPONSOR_MEDIA_TOKEN}`, `x-look-round`, `x-look-outcome: look|refused|deadline|shutdown|error`; the site answers 200/400/401/404/503 and the desk treats 4xx as final, 5xx as retryable. The desk never takes a caller-supplied callback URL.
- Copy (verbatim): title "Dress the host"; card line "Your logo on the tee, a cap in your colours"; description "Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad for 10 live minutes. Six clear appearances, an introduction and a callback."; preview caption "Your tee and cap are tailored right after payment · usually one to two minutes"; receipt "Tailoring your tee and cap · usually one to two minutes" / "Still tailoring — trying another fit" / "This is taking longer than usual" / "Use a different logo" / "We'll keep improving the fit"; labels "TAILORING" → "YOUR ON-AIR PASS"; alt "Pepe wearing your tee and cap" / "Chad wearing your tee and cap"; draft error "Add your logo first."; refusal reasons are stored bare and "Use a different logo." is appended once by the `order` gate and the receipt.
- Never `git add -A`; add named files only. Never run oxfmt/prettier on `lib/engine.ts`, `lib/show.ts`, `lib/services.ts`, `app/api/podcast/route.ts`, `components/player.tsx`, `components/sponsor-wallet.tsx`, `components/sponsor-panel.tsx`, `broadcast/supervisor.mjs`, `tests/sponsor-program.test.mjs`, `tests/engine.test.mjs` (other sessions' uncommitted hunks): edit them with exact-string replacements and hand-format the hunk. Stage only your own hunks of such a file (build the blob from `git show HEAD:<path>` plus your edits and `git update-index --cacheinfo`, as done for `components/sponsor-wallet.tsx` in commit 028e6ca).
- Do not modify `scripts/wearable-render.py`, `scripts/wearable_panel.py`, `public/wearables/*` (qualification-bound); the fallback calls the renderer's `preview` mode unchanged.
- Tests: `node --test tests/<file>`; Python `python3 -m unittest tests/wardrobe.test.py` with a cv2 environment (`work/vision-venv` if present, else the media image); browser suites via `tests/browser/serve.mjs` on 3314 and the Playwright runner. Every task ends green: `npx tsc --noEmit` (ignore `work/**`), `npx oxlint <touched files>`, the named test files.
- Commit messages: a plain sentence describing the user-visible outcome, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Order of work and prerequisites

Four parts, each independently testable; tasks are numbered `desk-N`, `site-N`, `show-N`, `ui-N` and a closing `verify-1`.

1. **site-1 first** (types, `LOOK_VERSION`, `SponsorReceipt.look`, copy): desk-5 and ui-2 depend on it.
2. **Desk** (desk-1 … desk-13) and **site-2 … site-16** can proceed in parallel after site-1.
3. **Show** (show-1 … show-9) after site-5 (the `air` gate) so the route pin and lease agree; show-5 (removing the composite client) must land **before** site-17 (retiring the media route).
4. **UI** (ui-1 … ui-9) after site-6 (receipt `look`) and site-14 (`replaceLogo`).
5. **verify-1** last, on devnet.

Notes from the consistency review that every implementer should know: the `/render` and `/preview` desk tests stay until the follow-up that deletes those routes (spec Out of scope); `tests/sponsor-playback-recovery.test.mjs:42` keeps mocking `{ ready: false, capQualified: false }` and stays correct; between site-10 (drops `?part=video`) and site-17 the live media route would 404 for a composite, harmless once show-5 lands; test helpers named `insertAsset`/`PALETTE`/`ASSET`/`LOOK_SHA` are defined per test file on purpose (separate builds) — sharing them through `tests/fixtures/looks.mjs` is welcome but not required; a fit whose logo URL fal cannot fetch counts as a failed fit and moves to the next seed (desk-9), which is the only handling the spec's last error-table row needs.

---

## Part A: Media desk — `/logo`, `/tailor`, `scripts/wardrobe.py` (desk-1 … desk-13)

Spec: `docs/superpowers/specs/2026-09-13-tailored-wardrobe-design.md` §1 (components 1.1–1.3, `/health`, files shipped). Names come from `CONTRACT.md` and are never reshaped here.

## File map for this section

| File | Responsibility |
| --- | --- |
| `scripts/wardrobe.py` (new) | The tailor's deterministic half: `normalize` (decode, refuse, knock out, scale, palette), `judge` (geometry, crop, drift, ink), `zones` (prints the zone/wearer constants). One JSON object on stdout, exit 0; exit 2 on a crash. |
| `tests/wardrobe.test.py` (new) | unittest suite on synthetic logos and the committed stills. Runs as `work/vision-venv/bin/python tests/wardrobe.test.py` (also under `python3 -m pytest tests/wardrobe.test.py` where pytest is installed). |
| `broadcast/sponsor-media.mjs` | New routes `POST /logo`, `POST /tailor`; the tailor lane and job; the in-desk fal client; the callback sender; `/health` `tailor` + `templateVersion`; `DEFAULTS`; `configFromEnv`; `serviceVersion`; `garmentPlan`, `tailorPrompt`, `judgePrompt`, `judgePasses`, `WEARERS`, `BASE_STILLS`, `tailorKey`, `falClient`, `sendLook` exported for tests. |
| `tests/sponsor-media.test.mjs` | Additions: `/logo`, health, garment table + prompt snapshot, fal client, callback sender, `/tailor` (validation, lane, dedupe, cache, fits, judges, fallback, refused, deadline, shutdown, retries), CLI stdout. Existing `capQualified` assertions rewritten. |
| `broadcast/Dockerfile.sponsor-media` | COPY `scripts/wardrobe.py` and the two uncropped stills; the drain/tailor collision comment. |
| `scripts/media.mjs` | `FAL_KEY` written by `setup`, shown by `status`; `health` reads `tailor`. |
| `tests/railway.test.mjs` | Every Python path and still the desk names is in `uploadFiles('media')`; `FAL_KEY` in the media variables; health wording. |

Base facts the tasks rely on (all measured on this checkout on 2026-09-13):
- `public/pepe-cartoon.png` and `public/gigachad-cartoon.png` are 1376×768; cropping columns 16..1360 reproduces `public/pepe-video.png` / `public/gigachad-video.png` pixel for pixel (`np.array_equal` true). Their sha256 are the `originalSha256` values in `lib/video-frames.ts`.
- fal already hosts those exact bytes: `character-assets.json` `sources['pepe-cartoon']` = `https://v3b.fal.media/files/b/0aa99e7e/ViWtBAcKK0DXjM7kBLIvD_eid12yRD.png` (sha256 `a0a82631…`), `sources['gigachad-cartoon']` = `https://v3b.fal.media/files/b/0aa99e9a/UUct9hv94FEzgs2dz2H26_JZaGMdjK.png` (sha256 `dd9ed2c8…`). The desk holds these two URLs as `BASE_STILLS` (the image ships no `lib/`); a test pins them to `character-assets.json`, and `lib/video-frames.ts` `originalUrl` (show section) copies the same values.
- Wearer colours sampled from the stills: Pepe head `#537631`, headphones `#23231C`; Chad hair/beard `#2C281D`, skin `#C18C5F`, headphones `#141510`.
- Wardrobe zones on the 1344×768 crop, `[x0, y0, x1, y1]`: host torso `[270, 380, 880, 690]`, host cap `[400, 40, 790, 260]`; guest torso `[420, 290, 1160, 700]`, guest cap `[590, 20, 890, 250]`; padded 24 px when judged.
- The desk's test file already has `config`, `needsRuntime`, `desk(t, options)`, `post(media, body, { path, type, token })`, `until`, `pause`, `freePort`, `fakeRenderer`, the `fal` loopback file server (`files` map, `FAL` origin), `scratch`, `TOKEN`, `LOGO`, `sha`. `desk()` marks a stand-in interpreter with `decoder: 'direct', broadcastHeight: 0` when `options.python` differs from `config.python`.

Test-helper index (each defined once, consumed by later tasks):
- desk-4 adds `PNG_HEADER`, `fakeWardrobe(name, plan)` to `tests/sponsor-media.test.mjs`.
- desk-5 adds the loopback stand-ins `site` (`SITE`, `logos`, `looks`, `siteAnswers`) and `falQueue` (`FALQ`, `falPlan`, `submissions`, `statusPolls`, `cancels`, `PASS_JUDGE`).
- desk-9 adds `PALETTE`, `tailorDesk(t, plan, options)`, `tailorOrder(extra)`, `landed(assetId, count)`.

Integrator notes (outside this section's files): `.github/workflows/media.yml` currently gates on `capQualified === true`; spec §2.5 moves that gate to `ready && templateVersion === 'looks-v1'` (site section). `docs/SPONSORSHIP.md` "media contract" moves to `/logo` + `/tailor` (docs section).

---

### Task desk-1: `scripts/wardrobe.py normalize` — decode, refuse, knock out the background, scale

**Files:**
- Create: `scripts/wardrobe.py`
- Create: `tests/wardrobe.test.py`

**Interfaces:**
- Consumes: nothing from other tasks (cv2 5.0.0.93, numpy 2.5.3 as pinned in the Dockerfile).
- Produces: CLI `python3 scripts/wardrobe.py normalize --input <file> --output <png>` → stdout `{"ok":true,"sha256","width","height"}` (desk-2 adds `"palette"`) or `{"ok":false,"code","message"}`, exit 0; exit 2 with `{"ok":false,"code":"CRASH"}` on an exception. `python3 scripts/wardrobe.py zones` → `{"ok":true,"zones":ZONES,"wearers":WEARERS,"pad":24}`. Module constants `ZONES`, `ZONE_PAD`, `WEARERS`, `FRAME`, `CROP`; functions `decode(path) -> (bgra, transparent)`, `knock_out(image, transparent)`, `normalize(path)`, `encode_png(image, output) -> bytes`, `lab_distance(bgr, colour)`, `to_lab(bgr_u8)`, `lab_to_hex(lab)`, `hex_to_bgr(hex)`, `sha256(bytes)`, class `Refusal(code, message)`.

- [x] **Step 1: Write the failing tests**

`tests/wardrobe.test.py`:

```python
"""scripts/wardrobe.py: the tailor's deterministic half, on synthetic logos and the committed stills."""
import hashlib, importlib.util, json, subprocess, sys, tempfile, unittest
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('wardrobe', ROOT / 'scripts/wardrobe.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def run(*argv):
    """The CLI as the desk drives it: the last stdout line is one JSON object."""
    done = subprocess.run([sys.executable, str(ROOT / 'scripts/wardrobe.py'), *argv], capture_output=True, text=True, cwd=ROOT)
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    return done.returncode, (json.loads(lines[-1]) if lines else None)


def wordmark():
    """A dark wordmark on a transparent canvas: the common case."""
    logo = np.zeros((120, 400, 4), np.uint8)
    cv2.putText(logo, 'CANVAS', (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 2.6, (30, 30, 30, 255), 8)
    return logo


def blue_circle_on_white():
    """An opaque white box with a blue disc and a white X inside it: the border goes, the X stays."""
    box = np.full((200, 200, 3), 255, np.uint8)
    cv2.circle(box, (100, 100), 70, (200, 40, 40), -1)
    cv2.putText(box, 'X', (62, 138), cv2.FONT_HERSHEY_SIMPLEX, 3, (255, 255, 255), 14)
    return box


def white_mark_on_navy():
    box = np.full((160, 160, 3), (100, 40, 20), np.uint8)
    cv2.circle(box, (80, 80), 50, (255, 255, 255), -1)
    return box


class NormalizeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def write(self, name, pixels):
        path = self.path / name
        cv2.imwrite(str(path), pixels)
        return path

    def normalize(self, name, pixels):
        source = self.write(name, pixels)
        output = self.path / ('out-' + name)
        code, report = run('normalize', '--input', str(source), '--output', str(output))
        self.assertEqual(code, 0, report)
        return report, output

    def test_wordmark_on_transparent_keeps_its_ink_size_and_hash(self):
        logo = wordmark()
        report, output = self.normalize('wordmark.png', logo)
        self.assertTrue(report['ok'], report)
        self.assertEqual((report['width'], report['height']), (400, 120))
        self.assertEqual(report['sha256'], hashlib.sha256(output.read_bytes()).hexdigest())
        out = cv2.imread(str(output), cv2.IMREAD_UNCHANGED)
        self.assertEqual(out.shape, (120, 400, 4))
        self.assertEqual(int(out[0, 0, 3]), 0)
        ys, xs = np.where(logo[:, :, 3] == 255)
        self.assertEqual(int(out[ys[len(ys) // 2], xs[len(xs) // 2], 3]), 255)

    def test_opaque_white_box_is_knocked_out_but_the_white_inside_the_mark_survives(self):
        report, output = self.normalize('box.png', blue_circle_on_white())
        self.assertTrue(report['ok'], report)
        out = cv2.imread(str(output), cv2.IMREAD_UNCHANGED)
        self.assertEqual(int(out[2, 2, 3]), 0, 'the white border was kept')
        self.assertEqual(int(out[100, 100, 3]), 255, 'the white X inside the disc was flooded away')
        self.assertEqual(int(out[100, 40, 3]), 255, 'the blue disc was lost')

    def test_a_jpeg_without_alpha_is_flooded_from_its_border(self):
        report, output = self.normalize('mark.jpg', white_mark_on_navy())
        self.assertTrue(report['ok'], report)
        out = cv2.imread(str(output), cv2.IMREAD_UNCHANGED)
        self.assertEqual(int(out[3, 3, 3]), 0)
        self.assertEqual(int(out[80, 80, 3]), 255)

    def test_a_large_logo_is_scaled_to_1024_on_its_long_side(self):
        big = np.zeros((512, 2048, 4), np.uint8)
        big[:, :] = (200, 60, 20, 255)
        big[200:300, :] = (255, 255, 255, 255)
        report, output = self.normalize('big.png', big)
        self.assertTrue(report['ok'], report)
        self.assertEqual((report['width'], report['height']), (1024, 256))
        self.assertEqual(cv2.imread(str(output), cv2.IMREAD_UNCHANGED).shape, (256, 1024, 4))

    def test_refusals_carry_the_customer_readable_code(self):
        junk = np.zeros((8, 8, 4), np.uint8)
        junk[4, 4] = (0, 0, 0, 255)
        thin = np.zeros((8, 400, 4), np.uint8)
        thin[3:5, :] = (0, 0, 0, 255)
        cases = [
            ('junk.png', junk, 'EMPTY_IMAGE'),
            ('tiny.png', np.full((4, 4, 3), 90, np.uint8), 'LOGO_TOO_SMALL'),
            ('wide.png', np.full((8, 4097, 3), 90, np.uint8), 'LOGO_TOO_LARGE'),
            ('thin.png', thin, 'LOGO_TOO_THIN'),
            ('clear.png', np.zeros((32, 32, 4), np.uint8), 'EMPTY_IMAGE'),
        ]
        for name, pixels, expected in cases:
            with self.subTest(name=name):
                source = self.write(name, pixels)
                code, report = run('normalize', '--input', str(source), '--output', str(self.path / ('o-' + name)))
                self.assertEqual(code, 0)
                self.assertFalse(report['ok'])
                self.assertEqual(report['code'], expected, report)
                self.assertTrue(report['message'])
        svg = self.path / 'vector.svg'
        svg.write_text('<svg>not a raster logo</svg>')
        code, report = run('normalize', '--input', str(svg), '--output', str(self.path / 'o-vector.png'))
        self.assertEqual((code, report['ok'], report['code']), (0, False, 'INVALID_IMAGE'))

    def test_normalize_is_deterministic(self):
        a, _ = self.normalize('a.png', wordmark())
        b, _ = self.normalize('b.png', wordmark())
        self.assertEqual(a['sha256'], b['sha256'])


class ZonesTest(unittest.TestCase):
    def test_zones_lie_inside_the_broadcast_frame_and_wearers_are_hex(self):
        code, report = run('zones')
        self.assertEqual(code, 0)
        self.assertTrue(report['ok'])
        self.assertEqual(report['pad'], 24)
        for target in ('host', 'guest'):
            for name in ('torso', 'cap'):
                x0, y0, x1, y1 = report['zones'][target][name]
                self.assertTrue(0 <= x0 < x1 <= 1344 and 0 <= y0 < y1 <= 768, (target, name))
            for colour in report['wearers'][target].values():
                self.assertRegex(colour, r'^#[0-9A-F]{6}$')
        self.assertEqual(report['zones'], w.ZONES)
        self.assertEqual(report['wearers'], w.WEARERS)


if __name__ == '__main__':
    unittest.main()
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `work/vision-venv/bin/python tests/wardrobe.test.py`
Expected: FAIL at import — `FileNotFoundError` / `AttributeError` because `scripts/wardrobe.py` does not exist.

- [x] **Step 3: Write the script**

`scripts/wardrobe.py`:

```python
#!/usr/bin/env python3
"""The tailor's deterministic half. One JSON object on stdout, exit 0; exit 2 only when it crashes.

  wardrobe.py normalize --input <file> --output <png>
  wardrobe.py judge --base <png> --candidate <png> --target host|guest --palette <json> --output <png>
  wardrobe.py zones

broadcast/sponsor-media.mjs drives it; the codes it prints are the ones the customer's screen shows.
"""
import argparse, hashlib, json, sys
from pathlib import Path
import cv2
import numpy as np

# Wardrobe zones on the 1344x768 broadcast frame, [x0, y0, x1, y1], measured on the base stills:
# the tee from shoulder to desk, the cap from the crown down through the headphone band, since a
# cap sits under the band and the band's shading moves with it. Padded by ZONE_PAD when judged.
ZONES = {
    'host': {'torso': [270, 380, 880, 690], 'cap': [400, 40, 790, 260]},
    'guest': {'torso': [420, 290, 1160, 700], 'cap': [590, 20, 890, 250]},
}
ZONE_PAD = 24
# The wearer's own colours, sampled from the same stills. A cap or tee in one of these would vanish
# into him; broadcast/sponsor-media.mjs keeps the same table for its garment plan, pinned by a test.
WEARERS = {
    'host': {'head': '#537631', 'headphones': '#23231C'},
    'guest': {'hair': '#2C281D', 'skin': '#C18C5F', 'headphones': '#141510'},
}
FRAME = (768, 1376)  # rows, columns: the uncropped stills, and what fal returns for 16:9 at 1K
CROP = (16, 1360)  # the columns scripts/video-frames.mjs keeps: 1344 wide, no resampling
MAX_SIDE = 1024
MIN_INK = 64
MIN_PRINT = 12  # the ink's short side in pixels, below which no print reads
BORDER_DE = 8.0
BORDER_FLAT = 0.8
INK_SHARE = 0.10
CHROMA_MIN = 15.0
DRIFT_PIXEL = 12
DRIFT_AGREEMENT = 0.90
DRIFT_MEAN = 6.0
INK_DE = 12.0
INK_PIXELS = 32


class Refusal(Exception):
    """A verdict on the input, with the code the customer's screen shows."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def to_lab(bgr_u8):
    """Real L*a*b* (L 0..100) for uint8 BGR pixels of any shape ending in 3, as an Nx3 float32."""
    flat = np.asarray(bgr_u8, np.uint8).reshape(-1, 1, 3).astype(np.float32) / 255
    return cv2.cvtColor(flat, cv2.COLOR_BGR2Lab).reshape(-1, 3)


def lab_to_hex(lab):
    bgr = cv2.cvtColor(np.asarray(lab, np.float32).reshape(1, 1, 3), cv2.COLOR_Lab2BGR).reshape(3)
    b, g, r = np.clip(np.rint(bgr * 255), 0, 255).astype(int)
    return '#%02X%02X%02X' % (r, g, b)


def hex_to_bgr(hex_colour):
    value = int(hex_colour.lstrip('#'), 16)
    return np.array([value & 255, (value >> 8) & 255, (value >> 16) & 255], np.uint8)


def lab_distance(bgr, colour):
    """ΔE76 of every pixel of an HxWx3 uint8 image from one BGR colour, on OpenCV's 8-bit Lab
    (cheap enough for a 4096x4096 upload; a and b are whole numbers there, fine for these thresholds)."""
    lab = cv2.cvtColor(np.ascontiguousarray(bgr, np.uint8), cv2.COLOR_BGR2LAB).astype(np.int16)
    ref = cv2.cvtColor(np.asarray(colour, np.uint8).reshape(1, 1, 3), cv2.COLOR_BGR2LAB).astype(np.int16).reshape(3)
    diff = (lab - ref).astype(np.float32)
    diff[..., 0] *= 100 / 255
    return np.sqrt((diff * diff).sum(axis=-1))


def decode(path):
    """The upload as 8-bit BGRA, and whether it used transparency."""
    try:
        image = cv2.imdecode(np.frombuffer(Path(path).read_bytes(), np.uint8), cv2.IMREAD_UNCHANGED)
    except cv2.error:
        image = None
    if image is None:
        raise Refusal('INVALID_IMAGE', 'Use a color PNG, JPG, or WebP image.')
    if image.dtype == np.uint16:
        image = (image // 257).astype(np.uint8)
    if image.dtype != np.uint8 or image.ndim not in (2, 3):
        raise Refusal('INVALID_IMAGE', 'Use a color PNG, JPG, or WebP image.')
    channels = 1 if image.ndim == 2 else image.shape[2]
    if channels == 1:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
    elif channels == 2:
        image = np.dstack([cv2.cvtColor(image[:, :, 0], cv2.COLOR_GRAY2BGR), image[:, :, 1]])
    elif channels == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    elif channels != 4:
        raise Refusal('INVALID_IMAGE', 'Use a color PNG, JPG, or WebP image.')
    h, w = image.shape[:2]
    if h < 8 or w < 8:
        raise Refusal('LOGO_TOO_SMALL', 'Use artwork at least 8 pixels per side.')
    if max(h, w) > 4096 or h * w > 16777216:
        raise Refusal('LOGO_TOO_LARGE', 'Use artwork no larger than 4096 pixels per side.')
    transparent = channels in (2, 4) and bool((image[:, :, 3] < 128).any())
    return image, transparent


def knock_out(image, transparent):
    """Drop the background: transparent pixels first, then the border colour when the border is flat.
    Only background connected to the border goes, so the same colour inside the mark survives."""
    keep = image[:, :, 3] >= 128
    if not keep.any():
        raise Refusal('EMPTY_IMAGE', 'The image is transparent. Add a visible logo.')
    ring = np.concatenate([image[0], image[-1], image[:, 0], image[:, -1]])
    solid = ring[ring[:, 3] >= 128][:, :3]
    if len(solid):
        border = np.median(solid, axis=0).astype(np.uint8)
        flat = float((lab_distance(solid.reshape(-1, 1, 3), border) <= BORDER_DE).mean()) >= BORDER_FLAT
        # An opaque file is flooded from its border; a transparent one only when its border is
        # itself nearly all opaque and one colour (a box someone forgot to knock out), never
        # when a few opaque pixels merely touch the edge.
        if not transparent or (len(solid) >= BORDER_FLAT * len(ring) and flat):
            near = ((lab_distance(image[:, :, :3], border) <= BORDER_DE) & keep).astype(np.uint8)
            _, labels = cv2.connectedComponents(near, connectivity=8)
            edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
            keep &= ~np.isin(labels, edge[edge != 0])
    if int(keep.sum()) < MIN_INK:
        raise Refusal('EMPTY_IMAGE', 'Too little of the image is visible. Add a visible logo.')
    out = image.copy()
    out[:, :, 3] = np.where(keep, out[:, :, 3], 0)
    return out


def normalize(path):
    image, transparent = decode(path)
    image = knock_out(image, transparent)
    ys, xs = np.where(image[:, :, 3] >= 128)
    h, w = image.shape[:2]
    ratio = min(1.0, MAX_SIDE / max(h, w))
    if min(int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)) * ratio < MIN_PRINT:
        raise Refusal('LOGO_TOO_THIN', 'This artwork is too thin to print. Use a compact mark.')
    if ratio < 1:
        image = cv2.resize(image, (round(w * ratio), round(h * ratio)), interpolation=cv2.INTER_AREA)
    return image


def encode_png(image, output):
    ok, encoded = cv2.imencode('.png', image)
    if not ok:
        raise RuntimeError('PNG encoding failed')
    data = encoded.tobytes()
    Path(output).write_bytes(data)
    return data


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['normalize', 'zones'])
    parser.add_argument('--input')
    parser.add_argument('--output')
    args = parser.parse_args(argv)
    try:
        if args.mode == 'zones':
            result = {'ok': True, 'zones': ZONES, 'wearers': WEARERS, 'pad': ZONE_PAD}
        else:
            image = normalize(args.input)
            data = encode_png(image, args.output)
            result = {'ok': True, 'sha256': sha256(data), 'width': int(image.shape[1]), 'height': int(image.shape[0])}
    except Refusal as refusal:
        result = {'ok': False, 'code': refusal.code, 'message': refusal.message}
    except Exception as error:  # a crash is this machine's fault, never a verdict on the logo
        print(json.dumps({'ok': False, 'code': 'CRASH', 'message': str(error)[:300]}))
        return 2
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `work/vision-venv/bin/python tests/wardrobe.test.py`
Expected: `Ran 7 tests … OK`.

- [x] **Step 5: Commit**

```bash
git add scripts/wardrobe.py tests/wardrobe.test.py
git commit -m "A logo is cleaned up for printing: background knocked out, junk refused before any money moves

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-2: `scripts/wardrobe.py` palette — k-means in L\*a\*b\* over the ink

**Files:**
- Modify: `scripts/wardrobe.py` (add `chroma`, `palette`; extend `main`'s normalize result)
- Test: `tests/wardrobe.test.py` (add `PaletteTest`)

**Interfaces:**
- Consumes: `normalize`, `to_lab`, `lab_to_hex`, `INK_SHARE`, `CHROMA_MIN` (desk-1).
- Produces: `palette(bgra) -> LookPalette` = `{'clusters': [{'hex', 'share'}], 'primary', 'secondary', 'accent', 'monochrome'}`; the normalize JSON gains `"palette"`. Rules: k = min(5, distinct colours); clusters ordered by share desc; ink clusters = share ≥ 0.10 (the largest cluster when none); `primary` = largest ink cluster; `secondary` = the second, else primary; `accent` = the ink cluster with the highest chroma C\*; `monochrome` = no ink cluster with C\* ≥ 15.

- [x] **Step 1: Write the failing tests** (append to `tests/wardrobe.test.py`, above `if __name__`)

```python
def close_hex(a, b, tolerance=2):
    return all(abs(int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) <= tolerance for i in (1, 3, 5))


class PaletteTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def palette_of(self, name, pixels):
        source = self.path / name
        cv2.imwrite(str(source), pixels)
        code, report = run('normalize', '--input', str(source), '--output', str(self.path / ('o-' + name)))
        self.assertEqual(code, 0, report)
        self.assertTrue(report['ok'], report)
        return report['palette']

    def chroma(self, hex_colour):
        lab = w.to_lab(w.hex_to_bgr(hex_colour))[0]
        return float(np.hypot(lab[1], lab[2]))

    def test_flat_colours_come_back_exactly_with_their_shares(self):
        # A transparent margin all round, so the border rule leaves the three blocks alone.
        logo = np.zeros((320, 320, 4), np.uint8)
        logo[10:160, 10:310] = (48, 48, 224, 255)    # #E03030, half the ink
        logo[160:250, 10:310] = (192, 80, 32, 255)   # #2050C0, 30 %
        logo[250:310, 10:310] = (0, 215, 255, 255)   # #FFD700, 20 %
        palette = self.palette_of('flat.png', logo)
        self.assertEqual(len(palette['clusters']), 3)
        hexes = [c['hex'] for c in palette['clusters']]
        shares = [c['share'] for c in palette['clusters']]
        for expected, share, got, got_share in zip(['#E03030', '#2050C0', '#FFD700'], [0.5, 0.3, 0.2], hexes, shares):
            self.assertTrue(close_hex(expected, got), (expected, got))
            self.assertAlmostEqual(share, got_share, delta=0.01)
        self.assertTrue(close_hex(palette['primary'], '#E03030'))
        self.assertTrue(close_hex(palette['secondary'], '#2050C0'))
        self.assertTrue(close_hex(palette['accent'], '#FFD700'), 'the most saturated ink is the accent')
        self.assertFalse(palette['monochrome'])

    def test_a_dark_wordmark_is_monochrome(self):
        palette = self.palette_of('wordmark.png', wordmark())
        self.assertTrue(palette['monochrome'])
        inks = [c for c in palette['clusters'] if c['share'] >= 0.10]
        self.assertTrue(inks)
        for cluster in inks:
            self.assertLess(self.chroma(cluster['hex']), 15)
            self.assertLess(w.to_lab(w.hex_to_bgr(cluster['hex']))[0][0], 30, 'the ink is dark')
        self.assertEqual(palette['primary'], palette['secondary'])
        self.assertEqual(palette['accent'], palette['primary'])

    def test_a_white_mark_on_a_dark_box_is_a_white_monochrome(self):
        palette = self.palette_of('mark.png', white_mark_on_navy())
        self.assertTrue(palette['monochrome'])
        self.assertGreater(w.to_lab(w.hex_to_bgr(palette['primary']))[0][0], 95, 'the navy border was counted as ink')

    def test_a_coloured_disc_with_a_white_mark_has_two_inks(self):
        palette = self.palette_of('disc.png', blue_circle_on_white())
        inks = [c for c in palette['clusters'] if c['share'] >= 0.10]
        self.assertGreaterEqual(len(inks), 2, palette)
        self.assertGreaterEqual(self.chroma(palette['primary']), 15)
        self.assertGreater(inks[0]['share'], 0.6)
        self.assertFalse(palette['monochrome'])
        self.assertGreater(sum(c['share'] for c in palette['clusters']), 0.99)

    def test_the_palette_is_the_same_twice(self):
        a = self.palette_of('a.png', blue_circle_on_white())
        b = self.palette_of('b.png', blue_circle_on_white())
        self.assertEqual(a, b)
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `work/vision-venv/bin/python tests/wardrobe.test.py PaletteTest`
Expected: FAIL with `KeyError: 'palette'` in every `PaletteTest`.

- [x] **Step 3: Add the palette**

In `scripts/wardrobe.py`, after `encode_png` add:

```python
def chroma(lab):
    return float(np.hypot(lab[1], lab[2]))


def palette(image):
    """The ink's colours: k-means in L*a*b* over the visible pixels, largest share first. Seeded,
    subsampled on a fixed stride and sorted stably, so the same logo always gets the same plan."""
    ink = image[:, :, :3][image[:, :, 3] >= 128]
    if len(ink) > 20000:
        ink = ink[np.linspace(0, len(ink) - 1, 20000).astype(int)]
    k = int(min(5, len(np.unique(ink, axis=0))))
    cv2.setRNGSeed(7)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, centres = cv2.kmeans(to_lab(ink), k, None, criteria, 5, cv2.KMEANS_PP_CENTERS)
    shares = np.bincount(labels.ravel(), minlength=k) / len(labels)
    order = np.argsort(-shares, kind='stable')
    clusters = [{'hex': lab_to_hex(centres[i]), 'share': round(float(shares[i]), 4), 'chroma': chroma(centres[i])} for i in order]
    inks = [c for c in clusters if c['share'] >= INK_SHARE] or clusters[:1]
    accent = max(inks, key=lambda c: c['chroma'])
    return {
        'clusters': [{'hex': c['hex'], 'share': c['share']} for c in clusters],
        'primary': inks[0]['hex'],
        'secondary': (inks[1] if len(inks) > 1 else inks[0])['hex'],
        'accent': accent['hex'],
        'monochrome': all(c['chroma'] < CHROMA_MIN for c in inks),
    }
```

In `main`, replace

```python
            result = {'ok': True, 'sha256': sha256(data), 'width': int(image.shape[1]), 'height': int(image.shape[0])}
```

with

```python
            result = {'ok': True, 'sha256': sha256(data), 'width': int(image.shape[1]), 'height': int(image.shape[0]), 'palette': palette(image)}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `work/vision-venv/bin/python tests/wardrobe.test.py`
Expected: `Ran 12 tests … OK`.

- [x] **Step 5: Commit**

```bash
git add scripts/wardrobe.py tests/wardrobe.test.py
git commit -m "A logo's ink colours are read once at upload, so the tee and cap can be chosen from them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-3: `scripts/wardrobe.py judge` — geometry, the broadcast crop, drift outside the wardrobe zones, ink on the chest

**Files:**
- Modify: `scripts/wardrobe.py` (add `padded`, `judge`; extend `main`)
- Test: `tests/wardrobe.test.py` (add `JudgeTest`)

**Interfaces:**
- Consumes: `FRAME`, `CROP`, `ZONES`, `ZONE_PAD`, `encode_png`, `lab_distance`, `hex_to_bgr`, `sha256` (desk-1).
- Produces: CLI `judge --base <png 1376x768> --candidate <png 1376x768> --target host|guest --palette <json file> --output <png>` → `{"ok":true,"pixelAgreement":float,"meanDrift":float,"inkPresent":bool,"sha256":<sha of the written 1344x768 PNG>,"width":1344,"height":768}` or `{"ok":false,"code":"GEOMETRY"|"DRIFT"|"INK",…same numbers when measured}`. `GEOMETRY` never resizes. The desk reads `ok`, `code`, `sha256`, `pixelAgreement`, `meanDrift`, `inkPresent`.

- [x] **Step 1: Write the failing tests** (append to `tests/wardrobe.test.py`)

```python
class JudgeTest(unittest.TestCase):
    """Calibrated on the committed stills (their sha256 are pinned in lib/video-frames.ts)."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)
        self.base = ROOT / 'public/pepe-cartoon.png'
        self.assertEqual(hashlib.sha256(self.base.read_bytes()).hexdigest(), 'a0a82631870c4ae63d3f1091e1cd4c9342950bbbc7ac23d0f25b1528fae80e99')
        self.pixels = cv2.imread(str(self.base))
        self.assertEqual(self.pixels.shape, (768, 1376, 3))

    def tearDown(self):
        self.dir.cleanup()

    def judge(self, candidate, palette_hex='#294CA0', target='host', base=None):
        cand = self.path / 'candidate.png'
        cv2.imwrite(str(cand), candidate)
        palette = self.path / 'palette.json'
        palette.write_text(json.dumps({'clusters': [{'hex': palette_hex, 'share': 1.0}], 'primary': palette_hex, 'secondary': palette_hex, 'accent': palette_hex, 'monochrome': False}))
        output = self.path / 'look.png'
        code, report = run('judge', '--base', str(base or self.base), '--candidate', str(cand), '--target', target, '--palette', str(palette), '--output', str(output))
        self.assertEqual(code, 0, report)
        return report, output

    def dressed(self, zones=w.ZONES['host'], print_colour=(107, 42, 27)):
        """The base with only the tee and cap zones changed, and a flat print on the chest."""
        cand = self.pixels.copy()
        x0, y0, x1, y1 = zones['torso']
        cand[y0:y1, 16 + x0:16 + x1] = (cand[y0:y1, 16 + x0:16 + x1] * 0.5).astype(np.uint8)
        cand[y0 + 120:y0 + 220, 16 + x0 + 230:16 + x0 + 380] = print_colour
        x0, y0, x1, y1 = zones['cap']
        cand[y0:y1, 16 + x0:16 + x1] = (cand[y0:y1, 16 + x0:16 + x1] * 0.6).astype(np.uint8)
        return cand

    def test_the_untouched_still_passes_and_its_crop_is_the_video_frame(self):
        report, output = self.judge(self.pixels)
        self.assertTrue(report['ok'], report)
        self.assertEqual(report['pixelAgreement'], 1.0)
        self.assertEqual(report['meanDrift'], 0.0)
        self.assertTrue(report['inkPresent'])
        self.assertEqual((report['width'], report['height']), (1344, 768))
        self.assertEqual(report['sha256'], hashlib.sha256(output.read_bytes()).hexdigest())
        video = cv2.imread(str(ROOT / 'public/pepe-video.png'))
        self.assertTrue(np.array_equal(cv2.imread(str(output)), video), 'the crop is not the one video-frames.mjs made')

    def test_a_dressed_still_passes_when_the_print_carries_the_ink(self):
        report, _ = self.judge(self.dressed(), palette_hex='#1B2A6B')
        self.assertTrue(report['ok'], report)
        self.assertGreaterEqual(report['pixelAgreement'], 0.9)
        self.assertLessEqual(report['meanDrift'], 6)

    def test_a_dressed_still_without_the_ink_on_the_chest_fails_ink(self):
        report, _ = self.judge(self.dressed(), palette_hex='#FF00FF')
        self.assertEqual((report['ok'], report['code']), (False, 'INK'))
        self.assertFalse(report['inkPresent'])
        self.assertGreaterEqual(report['pixelAgreement'], 0.9)

    def test_a_frame_that_changed_everywhere_fails_drift(self):
        brighter = np.clip(self.pixels.astype(int) + 20, 0, 255).astype(np.uint8)
        report, _ = self.judge(brighter)
        self.assertEqual((report['ok'], report['code']), (False, 'DRIFT'))
        self.assertLess(report['pixelAgreement'], 0.5)
        self.assertGreater(report['meanDrift'], 6)

    def test_the_wrong_geometry_is_refused_never_resized(self):
        report, output = self.judge(cv2.imread(str(ROOT / 'public/pepe-video.png')))
        self.assertEqual((report['ok'], report['code']), (False, 'GEOMETRY'))
        self.assertIn('1344x768', report['message'])
        self.assertFalse(output.exists())

    def test_the_guest_still_passes_against_its_own_zones(self):
        guest = ROOT / 'public/gigachad-cartoon.png'
        pixels = cv2.imread(str(guest))
        self.pixels = pixels
        report, _ = self.judge(self.dressed(zones=w.ZONES['guest']), palette_hex='#1B2A6B', target='guest', base=guest)
        self.assertTrue(report['ok'], report)
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `work/vision-venv/bin/python tests/wardrobe.test.py JudgeTest`
Expected: FAIL — `argparse` exits 2 on `invalid choice: 'judge'`, so `run()` returns `(2, None)` and `assertEqual(code, 0)` fails.

- [x] **Step 3: Add the judge**

In `scripts/wardrobe.py`, after `palette` add:

```python
def padded(zone):
    x0, y0, x1, y1 = zone
    return max(0, x0 - ZONE_PAD), max(0, y0 - ZONE_PAD), min(FRAME[1] - 2 * CROP[0], x1 + ZONE_PAD), min(FRAME[0], y1 + ZONE_PAD)


def judge(base_path, candidate_path, target, palette, output):
    """A gross-failure veto on one fit, on the broadcast crop of both pictures: outside the wardrobe
    zones the frame must be the still it was edited from, and the logo's inks must be on the chest.
    The cropped candidate is written whatever the verdict, so a refused fit can still be looked at."""
    base = cv2.imread(str(base_path), cv2.IMREAD_COLOR)
    if base is None or base.shape[:2] != FRAME:
        raise Refusal('GEOMETRY', 'The base still is not 1376x768.')
    candidate = cv2.imread(str(candidate_path), cv2.IMREAD_COLOR)
    if candidate is None or candidate.shape[:2] != FRAME:
        shape = 'undecodable' if candidate is None else '%dx%d' % (candidate.shape[1], candidate.shape[0])
        raise Refusal('GEOMETRY', 'The fit is %s, not 1376x768 (1344x768 after the crop).' % shape)
    base = base[:, CROP[0]:CROP[1]]
    candidate = candidate[:, CROP[0]:CROP[1]]
    data = encode_png(candidate, output)
    drift = np.abs(candidate.astype(np.int16) - base.astype(np.int16)).mean(axis=2)
    outside = np.ones(drift.shape, bool)
    for zone in ZONES[target].values():
        x0, y0, x1, y1 = padded(zone)
        outside[y0:y1, x0:x1] = False
    agreement = float((drift[outside] <= DRIFT_PIXEL).mean())
    mean_drift = float(drift[outside].mean())
    x0, y0, x1, y1 = padded(ZONES[target]['torso'])
    torso = candidate[y0:y1, x0:x1]
    present = True
    for cluster in palette['clusters']:
        if cluster['share'] < INK_SHARE:
            continue
        if int((lab_distance(torso, hex_to_bgr(cluster['hex'])) <= INK_DE).sum()) < INK_PIXELS:
            present = False
    result = {
        'pixelAgreement': round(agreement, 4),
        'meanDrift': round(mean_drift, 3),
        'inkPresent': present,
        'sha256': sha256(data),
        'width': int(candidate.shape[1]),
        'height': int(candidate.shape[0]),
    }
    if agreement < DRIFT_AGREEMENT or mean_drift > DRIFT_MEAN:
        return {'ok': False, 'code': 'DRIFT', 'message': 'The frame changed outside the tee and cap.', **result}
    if not present:
        return {'ok': False, 'code': 'INK', 'message': "The logo's colours are not on the chest.", **result}
    return {'ok': True, **result}
```

In `main`, replace the parser lines

```python
    parser.add_argument('mode', choices=['normalize', 'zones'])
    parser.add_argument('--input')
    parser.add_argument('--output')
```

with

```python
    parser.add_argument('mode', choices=['normalize', 'judge', 'zones'])
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--base')
    parser.add_argument('--candidate')
    parser.add_argument('--target', choices=['host', 'guest'])
    parser.add_argument('--palette')
```

and replace

```python
        else:
            image = normalize(args.input)
```

with

```python
        elif args.mode == 'judge':
            result = judge(args.base, args.candidate, args.target, json.loads(Path(args.palette).read_text()), args.output)
        else:
            image = normalize(args.input)
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `work/vision-venv/bin/python tests/wardrobe.test.py`
Expected: `Ran 18 tests … OK`.

- [x] **Step 5: Commit**

```bash
git add scripts/wardrobe.py tests/wardrobe.test.py
git commit -m "A fit that changed the scene, or lost the logo from the chest, is refused by pixels before any model is asked

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-4: `POST /logo` — the desk's one image codec, synchronous, ≤ 10 s

**Files:**
- Modify: `broadcast/sponsor-media.mjs:51-80` (DEFAULTS), `:514-560` (after `spawnGroup`: add `spawnCapture`), `:1023` (next to `renderer`: add `wardrobe`), `:1383` (before `handlePreview`: add `handleLogo`), `:1499-1512` (`handle` routing)
- Test: `tests/sponsor-media.test.mjs` (add `PNG_HEADER`, `fakeWardrobe`, two tests)

**Interfaces:**
- Consumes: `scripts/wardrobe.py normalize` (desk-1/2).
- Produces: `POST /logo?target=host|guest` (bearer, raw PNG/JPEG/WebP body ≤ 4 MiB) → 200 `{ logo: <base64 PNG>, logoSha256, width, height, palette }`; 422 `{ code, error }` with code ∈ `INVALID_IMAGE | EMPTY_IMAGE | LOGO_TOO_THIN | LOGO_TOO_SMALL | LOGO_TOO_LARGE`; 413 `TOO_LARGE`; 400 `TARGET`; 401; 503 `RENDERER` (machine fault), 503 `DEADLINE` (past `logoMs`), 503 `BUSY` while draining. Desk internals: `spawnCapture(command, args, signal, onSpawn) -> { code, signal, stdout, stderr }`, `wardrobe(args, signal, dir) -> parsed JSON` (throws 503 `RENDERER` on exit ≠ 0 or no JSON). `DEFAULTS.logoMs = 10_000`. Test helpers `PNG_HEADER`, `fakeWardrobe(name, plan)` (stands in for both Python scripts; `plan.codeFile`, `plan.judgeFile`, `plan.countFile`, `plan.previewDelayMs`, `plan.fallback: 'refuse' | 'crash'`).

- [x] **Step 1: Write the failing tests**

Add after the `TOOLS` constant in `tests/sponsor-media.test.mjs`:

```js
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Stands in for both Python scripts when a desk is driven without OpenCV. scripts/wardrobe.py
// answers on stdout; scripts/wearable-render.py through its report file. What the judge says
// about each fit is read from plan.judgeFile at run time (comma-separated: pass | DRIFT | INK |
// GEOMETRY, one per call, the last one repeating), a refusal for normalize from plan.codeFile.
async function fakeWardrobe(name, plan = {}) {
  const path = join(scratch, `${name}.cjs`);
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const plan = ${JSON.stringify(plan)};
const argv = process.argv.slice(2);
const mode = argv[1];
const arg = (name) => argv[argv.indexOf(name) + 1];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const told = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PALETTE = { clusters: [{ hex: '#1B2A6B', share: 0.8 }, { hex: '#F5F5F5', share: 0.2 }], primary: '#1B2A6B', secondary: '#F5F5F5', accent: '#1B2A6B', monochrome: false };
const say = (value) => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0); };
// The desk's boot probe (`python -c PROBE`) must see the tools it expects, or `ready` is false.
if (argv[0] === '-c') say({ python: '3.12', cv2: '5.0.0', numpy: '2.5.3' });
if (argv[0] === 'scripts/wardrobe.py') {
  if (mode === 'zones') say({ ok: true, zones: {}, wearers: {}, pad: 24 });
  if (mode === 'normalize') {
    const code = told(plan.codeFile);
    if (code) say({ ok: false, code, message: 'refused by the stand-in' });
    const bytes = fs.readFileSync(arg('--input'));
    fs.writeFileSync(arg('--output'), bytes);
    say({ ok: true, sha256: sha(bytes), width: 512, height: 512, palette: PALETTE });
  }
  if (mode === 'judge') {
    const verdicts = told(plan.judgeFile).split(',').filter(Boolean);
    const n = Number(told(plan.countFile) || 0);
    if (plan.countFile) fs.writeFileSync(plan.countFile, String(n + 1));
    const verdict = verdicts[n] || verdicts[verdicts.length - 1] || 'pass';
    if (verdict === 'GEOMETRY') say({ ok: false, code: 'GEOMETRY', message: 'The fit is 1024x576, not 1376x768.' });
    const bytes = Buffer.concat([PNG, Buffer.from('look:'), fs.readFileSync(arg('--candidate'))]);
    fs.writeFileSync(arg('--output'), bytes);
    if (verdict !== 'pass') say({ ok: false, code: verdict, message: verdict, pixelAgreement: 0.5, meanDrift: 20, inkPresent: verdict !== 'INK', sha256: sha(bytes) });
    say({ ok: true, pixelAgreement: 0.97, meanDrift: 2.1, inkPresent: true, sha256: sha(bytes), width: 1344, height: 768 });
  }
  process.exit(3);
}
if (argv[0] !== 'scripts/wearable-render.py') process.exit(3);
const report = (value) => fs.writeFileSync(arg('--report'), JSON.stringify(value));
function preview() {
  if (plan.fallback === 'refuse') { report({ accepted: false, code: 'LOGO_TOO_THIN', error: 'This artwork is too thin to read on the cap.' }); process.exit(2); }
  if (plan.fallback === 'crash') process.exit(1);
  const bytes = Buffer.concat([PNG, Buffer.from('cap:'), fs.readFileSync(arg('--asset'))]);
  fs.writeFileSync(arg('--output'), bytes);
  report({ accepted: true, sha256: sha(bytes), templateId: 'pepe-cap-v1' });
  process.exit(0);
}
if (mode === 'preview') setTimeout(preview, plan.previewDelayMs || 0);
else process.exit(3);
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
```

Add after the existing `'/health answers 200 with tool versions…'` test:

```js
void test(
  '/logo normalizes an upload and answers with the print, its hash, its size and its palette',
  { skip: needsRuntime },
  async (t) => {
    const media = await desk(t);
    const r = await post(media, LOGO, { path: '/logo?target=host', type: 'image/png' });
    assert.equal(r.status, 200, r.bytes.toString().slice(0, 200));
    const data = r.json();
    const logo = Buffer.from(data.logo, 'base64');
    assert.ok(logo.subarray(0, 8).equals(PNG_HEADER), 'the print is a PNG');
    assert.equal(data.logoSha256, sha(logo));
    assert.ok(data.width > 0 && data.width <= 1024 && data.height > 0 && data.height <= 1024);
    assert.ok(Array.isArray(data.palette.clusters) && data.palette.clusters.length >= 1);
    for (const c of data.palette.clusters) {
      assert.match(c.hex, /^#[0-9A-F]{6}$/);
      assert.ok(c.share >= 0 && c.share <= 1);
    }
    for (const name of ['primary', 'secondary', 'accent'])
      assert.match(data.palette[name], /^#[0-9A-F]{6}$/);
    assert.equal(typeof data.palette.monochrome, 'boolean');
    assert.equal(data.target, 'host');
    assert.ok(media.spawns.some((s) => s.mode === 'wardrobe-normalize'));
    const bad = await post(media, 'bad PNG', { path: '/logo?target=host', type: 'image/png' });
    assert.equal(bad.status, 422);
    assert.equal(bad.json().code, 'INVALID_IMAGE');
    const crowd = await post(media, LOGO, { path: '/logo?target=crowd', type: 'image/png' });
    assert.equal(crowd.status, 400);
    assert.equal(crowd.json().code, 'TARGET');
    const anon = await post(media, LOGO, { path: '/logo?target=host', type: 'image/png', token: 'wrong' });
    assert.equal(anon.status, 401);
    const before = media.spawns.length;
    const huge = await post(media, Buffer.concat([PNG_HEADER, Buffer.alloc(4 * 1024 * 1024)]), { path: '/logo?target=host', type: 'image/png' });
    assert.equal(huge.status, 413);
    assert.equal(huge.json().code, 'TOO_LARGE');
    assert.equal(media.spawns.length, before, 'an oversized upload reached the decoder');
  },
);

void test('/logo relays the script’s refusal as 422 and hides a machine fault as 503', async (t) => {
  const codeFile = join(scratch, 'logo-code.txt');
  const python = await fakeWardrobe('logo-codes', { codeFile });
  const media = await desk(t, { python });
  await writeFile(codeFile, 'LOGO_TOO_THIN');
  const thin = await post(media, LOGO, { path: '/logo?target=guest', type: 'image/png' });
  assert.equal(thin.status, 422);
  assert.equal(thin.json().code, 'LOGO_TOO_THIN');
  assert.match(thin.json().error, /stand-in/);
  await writeFile(codeFile, 'SOMETHING_ELSE');
  const odd = await post(media, LOGO, { path: '/logo?target=guest', type: 'image/png' });
  assert.equal(odd.status, 503);
  assert.equal(odd.json().code, 'RENDERER');
  await writeFile(codeFile, '');
  const ok = await post(media, LOGO, { path: '/logo?target=guest', type: 'image/png' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().logoSha256, sha(LOGO));
  assert.equal(ok.json().palette.primary, '#1B2A6B');
  assert.equal(ok.json().target, 'guest');
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: the two new tests FAIL with `404` (`NOT_FOUND`) instead of 200/422; everything else still passes.

- [x] **Step 3: Implement the route**

In `broadcast/sponsor-media.mjs`:

1. In `DEFAULTS`, after `previewConcurrency: 2,` add:

```js
  // A logo is normalized while the buyer waits at the upload field; the site gives it 10 s.
  logoMs: 10_000,
```

2. After the `spawnGroup` function (ends at line 560, `});` + `}`), add:

```js
// Like spawnGroup, but the script answers on stdout: scripts/wardrobe.py prints one JSON object
// as its last line. 'close', not 'exit', so that line has been read before the answer is parsed.
function spawnCapture(command, args, signal, onSpawn) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: rendererEnv(),
      });
    } catch {
      done({ code: null, signal: null, stdout: '', stderr: 'spawn failed' });
      return;
    }
    let stdout = '',
      stderr = '',
      finished = false;
    const group = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    };
    const finish = (code, exitSignal) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', group);
      group();
      done({ code, signal: exitSignal, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-65536);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.once('error', () => finish(null, null));
    child.once('close', finish);
    signal.addEventListener('abort', group, { once: true });
    if (signal.aborted) group();
    if (child.pid) onSpawn(child.pid);
  });
}
```

3. Inside `createMediaService`, directly after the `renderer` function (line 1023 onwards; add after its closing `}`), add:

```js
  // scripts/wardrobe.py: normalize, judge or zones. A verdict ({ ok: false, code }) is the
  // caller's to act on; anything else that is not { ok: true } is this machine failing.
  async function wardrobe(args, signal, dir) {
    const outcome = await spawnCapture(
      cfg.python || 'python3',
      ['scripts/wardrobe.py', ...args],
      signal,
      (pid) => cfg.onSpawn?.({ pid, mode: `wardrobe-${args[0]}`, dir }),
    );
    if (signal.aborted) throw stopped(String(signal.reason));
    let result = null;
    try {
      result = JSON.parse(outcome.stdout.trim().split('\n').pop());
    } catch {
      /* No JSON: the script died before it could explain itself. */
    }
    if (outcome.code === 0 && result && typeof result.ok === 'boolean')
      return result;
    log({
      level: 'error',
      event: 'wardrobe',
      mode: args[0],
      exit: outcome.code,
      signal: outcome.signal,
      code: result?.code,
      stderr: outcome.stderr.slice(-600) || undefined,
    });
    throw new MediaError(
      503,
      'RENDERER',
      'The media worker could not process this file.',
    );
  }
```

4. Before `async function handlePreview(request, url) {` add:

```js
  const LOGO_CODES = new Set([
    'INVALID_IMAGE',
    'EMPTY_IMAGE',
    'LOGO_TOO_THIN',
    'LOGO_TOO_SMALL',
    'LOGO_TOO_LARGE',
  ]);
  // The only image codec in the system. The site forwards the raw upload and stores what comes
  // back: a knocked-out PNG, its hash and its palette. No fal, no money, no verdict on the look.
  async function handleLogo(request, url) {
    const target = url.searchParams.get('target') || 'host';
    if (!templates[target])
      throw new MediaError(400, 'TARGET', 'Choose a supported host.');
    if (previews >= cfg.previewConcurrency) throw busy(1_000);
    previews++;
    const clock = new AbortController(),
      timer = setTimeout(() => clock.abort('deadline'), cfg.logoMs);
    const signal = AbortSignal.any([clock.signal, request.signal]);
    let dir;
    try {
      const upload = await bytesLimited(request, MAX_UPLOAD);
      if (!imageKind(upload))
        throw new MediaError(
          422,
          'INVALID_IMAGE',
          'Use a color PNG, JPG, or WebP image.',
        );
      await prepared;
      dir = await mkdtemp(join(workdir, 'job-'));
      const input = join(dir, 'upload'),
        normalized = join(dir, 'logo.png');
      await writeFile(input, upload);
      const result = await wardrobe(
        ['normalize', '--input', input, '--output', normalized],
        signal,
        dir,
      );
      if (!result.ok) {
        if (LOGO_CODES.has(result.code))
          throw new MediaError(
            422,
            result.code,
            String(result.message || result.code).slice(0, 300),
          );
        log({ level: 'error', event: 'wardrobe', mode: 'normalize', code: result.code });
        throw new MediaError(
          503,
          'RENDERER',
          'The media worker could not process this file.',
        );
      }
      const logo = await readFile(normalized);
      if (logo.length > MAX_LOGO)
        throw new MediaError(
          422,
          'LOGO_TOO_LARGE',
          `This artwork is too detailed to print; use a simpler PNG under ${MAX_LOGO / 1024 / 1024} MB.`,
        );
      if (hash(logo) !== result.sha256)
        throw new MediaError(
          503,
          'RENDERER',
          'The normalized logo failed its integrity check.',
        );
      return reply({
        logo: logo.toString('base64'),
        logoSha256: result.sha256,
        width: result.width,
        height: result.height,
        palette: result.palette,
        target,
      });
    } catch (error) {
      if (clock.signal.aborted && error?.status === 503)
        throw new MediaError(
          503,
          'DEADLINE',
          'Artwork took too long to prepare.',
        );
      throw error;
    } finally {
      clearTimeout(timer);
      previews--;
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
```

5. In `handle`, replace

```js
      const known =
        request.method === 'POST' &&
        (url.pathname === '/preview' || url.pathname === '/render');
```

with

```js
      const known =
        request.method === 'POST' &&
        ['/preview', '/render', '/logo'].includes(url.pathname);
```

and replace

```js
      // A preview in progress is a buyer choosing artwork; a drain lets it finish too.
      const work = handlePreview(request, url);
```

with

```js
      // A preview or a logo in progress is a buyer choosing artwork; a drain lets it finish too.
      const work =
        url.pathname === '/logo'
          ? handleLogo(request, url)
          : handlePreview(request, url);
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass (the runtime-bound `/logo` test skips on a box without cv2, like its neighbours).

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "The desk cleans up a logo at upload and tells the buyer at once when it cannot be printed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-5: `looks-v1` on `/health`, the tailor lane's clock in DEFAULTS, `FAL_KEY` in config, the fal probe at boot, `capQualified` leaves

**Files:**
- Modify: `broadcast/sponsor-media.mjs:33` (constants), `:51-80` (DEFAULTS), `:282-295` (`serviceVersion`), `:608-640` (service state), `:698-727` (boot checks), `:729-754` (`health`), `:1563-1572` (`status`), `:1583-1600` (`configFromEnv`), `:1725-1740` (boot log)
- Test: `tests/sponsor-media.test.mjs` (stand-in servers; rewrite `capQualified` asserts at lines 119, 382, 500, 524, 542, 553, 1046; two new tests)

**Interfaces:**
- Consumes: `fakeWardrobe` (desk-4).
- Produces: desk constants `LOOK_VERSION = 'looks-v1'`, `FAL_ORIGIN = 'https://queue.fal.run'`, `TAILOR_MODEL = 'fal-ai/nano-banana-pro/edit'`, `JUDGE_ENDPOINT = 'openrouter/router/vision'`, `JUDGE_MODEL = 'google/gemini-2.5-flash'`, `FITS = 3`, exported `BASE_STILLS = { host: { path, url }, guest: { path, url } }`. `DEFAULTS` gains `tailorDeadlineMs: 210_000, tailorFitMs: 65_000, tailorSubmitMs: 40_000, judgeMs: 25_000, tailorTailMs: 15_000, tailorConcurrency: 2, tailorQueue: 6, logoFetchMs: 15_000, callbackMs: 20_000, callbackAttempts: 3, callbackRetryMs: 5_000, falProbeMs: 5_000, falPollMs: 2_000`. Config: `cfg.falKey`, `cfg.falOriginForTests` (loopback, `NODE_ENV=test` only; env `SPONSOR_MEDIA_TEST_FAL_HOST`); inside the service `falOrigin`. `/health` → `{ ready, tailor, templateVersion: 'looks-v1', templates, tools, decoder, version, starting, draining }` (no `capQualified`). `status()` gains `tailoring, tailorQueued, callbacks` (filled by desk-9; 0 here). Boot log line carries `tailor` and `templateVersion`. Test stand-ins: `SITE`, `logos` (Map path → bytes), `looks` (array of `{ id, url, headers, body }`), `siteAnswers` (array of statuses), `FALQ`, `falPlan`, `submissions`, `statusPolls`, `cancels`, `PASS_JUDGE`.

- [x] **Step 1: Write the failing tests**

Add to `tests/sponsor-media.test.mjs` after the `FAL` file server block (after `function take(...)`):

```js
// A stand-in for the site: it serves the normalized logo the desk fetches, and it receives the
// look. `siteAnswers` are the statuses the next PUTs get, in order; then 200.
const logos = new Map();
const looks = [];
let siteAnswers = [];
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://site');
  const id = url.pathname.split('/').pop();
  if (req.method === 'GET' && url.searchParams.get('part') === 'logo') {
    const body = logos.get(url.pathname);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length });
    res.end(body);
    return;
  }
  if (req.method === 'PUT' && url.searchParams.get('part') === 'look') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      looks.push({ id, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const status = siteAnswers.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: status === 200 ? 'qualified' : 'refused' }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((ready) => site.listen(0, '127.0.0.1', ready));
const SITE = `http://127.0.0.1:${site.address().port}`;
after(() => new Promise((done) => site.close(done)));

// A stand-in for queue.fal.run: submit, status, response and cancel, for the edit and for the
// vision judge. Each edit answers with a fresh picture on the fal.media stand-in above.
const PASS_JUDGE = {
  shirtLogo: true,
  logoFidelity: 9,
  legibility: 8,
  capPresent: true,
  capColourMatchesPlan: true,
  capExtraText: false,
  identityUnchanged: true,
  sceneUnchanged: true,
  extraText: false,
};
const falPlan = { hang: false, fail: false, foreign: false, head: 200, judgeAnswers: [] };
const submissions = [];
let statusPolls = 0,
  cancels = 0;
const falQueue = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fal');
  const json = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'HEAD') {
    res.writeHead(falPlan.head);
    res.end();
    return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = `req-${submissions.push({ endpoint: url.pathname.slice(1), input, authorization: req.headers.authorization, url: req.url })}`;
      const origin = falPlan.foreign ? 'http://127.0.0.1:1' : FALQ;
      json({
        request_id: id,
        status_url: `${origin}/requests/${id}/status`,
        response_url: `${FALQ}/requests/${id}`,
        cancel_url: `${FALQ}/requests/${id}/cancel`,
      });
    });
    return;
  }
  const found = /^\/requests\/(req-\d+)(\/status|\/cancel)?$/.exec(url.pathname);
  if (!found) {
    res.writeHead(404);
    res.end();
    return;
  }
  const { endpoint, input } = submissions[Number(found[1].slice(4)) - 1];
  if (found[2] === '/cancel') {
    cancels++;
    json({});
    return;
  }
  if (found[2] === '/status') {
    statusPolls++;
    json({ status: falPlan.hang ? 'IN_QUEUE' : falPlan.fail ? 'FAILED' : 'COMPLETED' });
    return;
  }
  if (endpoint === 'openrouter/router/vision') {
    const answer = falPlan.judgeAnswers.shift() ?? PASS_JUDGE;
    json({ output: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, usage: {} });
    return;
  }
  const bytes = Buffer.concat([PNG_HEADER, Buffer.from(`fit:${input.seed}:${submissions.length}`)]);
  const path = `/files/fit-${submissions.length}.png`;
  files.set(path, bytes);
  json({ images: [{ url: `${FAL}${path}`, width: 1376, height: 768, content_type: 'image/png' }], description: '' });
});
await new Promise((ready) => falQueue.listen(0, '127.0.0.1', ready));
const FALQ = `http://127.0.0.1:${falQueue.address().port}`;
after(() => new Promise((done) => falQueue.close(done)));
```

(`PNG_HEADER` from desk-4 is a top-level const of the same test file, read when a test runs, so this block sees it wherever it sits.)

Rewrite the existing assertions:
- line 119 `assert.equal(unavailable.capQualified, false);` → `assert.equal(unavailable.tailor, false);`
- lines 382–383 → `assert.equal(state.tailor, false);` and `assert.equal(state.templateVersion, 'looks-v1');`
- line 500 `assert.equal(state.capQualified, false);` → `assert.equal(state.tailor, false);`
- line 524 `assert.equal(healed.capQualified, true);` → `assert.equal(healed.templateVersion, 'looks-v1');`
- line 542 `assert.equal(state.capQualified, true);` → `assert.equal(state.tailor, false, 'no FAL_KEY on this desk');` and add `assert.equal('capQualified' in state, false);`
- line 553 `assert.equal(closedState.capQualified, false);` → `assert.equal(closedState.tailor, false);`
- line 1046 `assert.equal(state.capQualified, false);` → `assert.equal(state.templateVersion, 'looks-v1');`

Add new tests after the `'/logo relays…'` test:

```js
void test('/health says whether this desk can tailor, and which look version it makes', async (t) => {
  const python = await fakeWardrobe('health-tailor');
  const bare = await desk(t, { python });
  const state = await (await fetch(`${bare.url}/health`)).json();
  assert.equal(state.templateVersion, 'looks-v1');
  assert.equal(state.tailor, false, 'no FAL_KEY, no tailor');
  assert.equal('capQualified' in state, false);
  // The site compares this literal in leaseOrders and the asset gate: the two must never drift.
  const sponsorship = await readFile('lib/sponsorship.ts', 'utf8');
  assert.equal(
    /export const LOOK_VERSION = '([\w-]+)' as const;/.exec(sponsorship)?.[1],
    state.templateVersion,
    'lib/sponsorship.ts LOOK_VERSION and the desk disagree',
  );
  const dressed = await desk(t, { python, siteOrigin: SITE, falKey: 'fal-test-key', falOriginForTests: FALQ });
  const ready = await (await fetch(`${dressed.url}/health`)).json();
  assert.equal(ready.ready, true);
  assert.equal(ready.tailor, true);
  const keyOnly = await desk(t, { python, falKey: 'fal-test-key', falOriginForTests: FALQ });
  assert.equal(keyOnly.service.health().tailor, false, 'nowhere to call back, no tailor');
  const unreachable = await desk(t, { python, siteOrigin: SITE, falKey: 'fal-test-key', falOriginForTests: 'http://127.0.0.1:1' });
  assert.equal(unreachable.service.health().tailor, false, 'fal never answered');
  assert.ok(unreachable.logs.some((l) => l.event === 'fal-probe' && l.level === 'warn'));
  assert.ok(!JSON.stringify(unreachable.logs).includes('fal-test-key'), 'the key was logged');
});

void test('the base stills the tailor shows fal are the uncropped originals fal already holds', async () => {
  const assets = JSON.parse(await readFile('character-assets.json', 'utf8'));
  assert.equal(BASE_STILLS.host.url, assets.sources['pepe-cartoon']);
  assert.equal(BASE_STILLS.guest.url, assets.sources['gigachad-cartoon']);
  const frames = await readFile('lib/video-frames.ts', 'utf8');
  for (const [target, still] of Object.entries(BASE_STILLS)) {
    assert.equal(still.path, `public/${target === 'host' ? 'pepe' : 'gigachad'}-cartoon.png`);
    const pinned = new RegExp(`${target}: \\{[\\s\\S]*?originalSha256:\\s*'([a-f0-9]{64})'`).exec(frames)?.[1];
    assert.equal(sha(await readFile(still.path)), pinned, `${still.path} is not the still lib/video-frames.ts hashes`);
  }
});
```

Add `BASE_STILLS` to the import list at the top of the test file (`import { BASE_STILLS, createMediaService, … } from '../broadcast/sponsor-media.mjs';`).

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: FAIL — `BASE_STILLS` is not exported (SyntaxError at import). After a temporary `export const BASE_STILLS = {}` the health test fails on `templateVersion` (`'caps-v1'` ≠ `'looks-v1'`).

- [x] **Step 3: Implement**

In `broadcast/sponsor-media.mjs`:

1. Replace line 33 `const TEMPLATE_VERSION = 'caps-v1';` with:

```js
// The tracker's template, now only what /render and /preview validate against.
const TEMPLATE_VERSION = 'caps-v1';
// The look the tailor makes. lib/sponsorship.ts exports the same literal as LOOK_VERSION; the site
// compares it in leaseOrders and the asset gate, and a desk test pins the two together.
const LOOK_VERSION = 'looks-v1';
const FAL_ORIGIN = 'https://queue.fal.run';
const TAILOR_MODEL = 'fal-ai/nano-banana-pro/edit';
const JUDGE_ENDPOINT = 'openrouter/router/vision';
const JUDGE_MODEL = 'google/gemini-2.5-flash';
const FITS = 3;
const MAX_TAILOR_BODY = 16 * 1024;
// The stills the model dresses: the uncropped 1376×768 originals, byte for byte what fal already
// hosts (character-assets.json `sources`) and what lib/video-frames.ts hashes as originalSha256.
// The judge crops the answer the way scripts/video-frames.mjs crops these, so a look lines up
// pixel for pixel with the frame every other shot is conditioned on.
export const BASE_STILLS = {
  host: {
    path: 'public/pepe-cartoon.png',
    url: 'https://v3b.fal.media/files/b/0aa99e7e/ViWtBAcKK0DXjM7kBLIvD_eid12yRD.png',
  },
  guest: {
    path: 'public/gigachad-cartoon.png',
    url: 'https://v3b.fal.media/files/b/0aa99e9a/UUct9hv94FEzgs2dz2H26_JZaGMdjK.png',
  },
};
```

2. In `DEFAULTS`, after the `broadcastHeight: BROADCAST_HEIGHT,` line add:

```js
  // The tailor's own lane; /render keeps its 95 s lane. A fit is one nano-banana edit (submit,
  // queue and download inside tailorSubmitMs) judged inside judgeMs. Three fits and the tail
  // (fetching the logo, the fallback print and the callback) make the deadline: 3 × 65 + 15 =
  // 210 s, so a job settles inside it by construction. The site asks again after four minutes.
  tailorDeadlineMs: 210_000,
  tailorFitMs: 65_000,
  tailorSubmitMs: 40_000,
  judgeMs: 25_000,
  tailorTailMs: 15_000,
  tailorConcurrency: 2,
  tailorQueue: 6,
  logoFetchMs: 15_000,
  // Every settlement is told to the site: three attempts of 20 s, 5 s apart.
  callbackMs: 20_000,
  callbackAttempts: 3,
  callbackRetryMs: 5_000,
  // fal is asked once at boot whether it answers at all; a desk it does not answer sells no cap.
  falProbeMs: 5_000,
  falPollMs: 2_000,
```

3. In `serviceVersion`, replace

```js
    for (const path of [
      'broadcast/sponsor-media.mjs',
      'scripts/wearable-render.py',
      'scripts/wearable_panel.py',
    ])
```

with

```js
    for (const path of [
      'broadcast/sponsor-media.mjs',
      'scripts/wearable-render.py',
      'scripts/wearable_panel.py',
      'scripts/wardrobe.py',
    ])
```

4. In `createMediaService`, replace

```js
  const siteOrigin = originOf(cfg.siteOrigin),
    testOrigin = testVideoOrigin(cfg.videoOriginForTests);
```

with

```js
  const siteOrigin = originOf(cfg.siteOrigin),
    testOrigin = testVideoOrigin(cfg.videoOriginForTests),
    // Tests stand in for fal's queue on loopback, through the same test-only door as takes.
    falOrigin = testVideoOrigin(cfg.falOriginForTests) || FAL_ORIGIN;
```

In the `machine` object, after `decoder: { mode: null },` add `fal: false,`. Replace `const checks = { tools: 0, decoder: 0 },` with `const checks = { tools: 0, decoder: 0, fal: 0 },`.

After `async function checkDecoder() { … }` add:

```js
  // Whether fal answers at all, asked once at boot with the key it will be asked with. A desk
  // without a key or a site to call back has no tailor and sells no cap; one fal will not answer
  // is measured again until it does. The key goes in the header and nowhere else.
  async function checkFal() {
    checks.fal++;
    if (!cfg.falKey || !siteOrigin) {
      machine.fal = false;
      return;
    }
    try {
      const response = await fetch(`${falOrigin}/${TAILOR_MODEL}`, {
        method: 'HEAD',
        headers: { authorization: `Key ${cfg.falKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(cfg.falProbeMs),
      });
      await response.body?.cancel().catch(() => {});
      machine.fal = true;
    } catch (error) {
      machine.fal = false;
      log({
        level: 'warn',
        event: 'fal-probe',
        attempt: checks.fal,
        error: String(error?.message || error).slice(0, 120),
      });
      again(checkFal, cfg.toolRetryMs);
    }
  }
```

Replace

```js
  const toolsChecked = checkTools();
  const decoding = prepared.then(checkDecoder);
  const booted = Promise.all([
    prepared,
    qualification,
    version,
    toolsChecked,
    decoding,
  ]).then(() => {
```

with

```js
  const toolsChecked = checkTools();
  const decoding = prepared.then(checkDecoder);
  const falChecked = checkFal();
  const booted = Promise.all([
    prepared,
    qualification,
    version,
    toolsChecked,
    decoding,
    falChecked,
  ]).then(() => {
```

5. In `health()`, replace

```js
      // No refunds means no selling a cap this desk cannot deliver: the qualification holds
      // only where the renderer sees the pixels it was qualified on.
      capQualified:
        ready && states.length > 0 && states.every((t) => t.qualified),
      templateVersion: TEMPLATE_VERSION,
```

with

```js
      // No refunds means no selling a cap this desk cannot deliver: a look needs a key for
      // fal, a site to call back, and fal answering. The tracker's trials no longer gate a sale.
      tailor: ready && !!cfg.falKey && !!siteOrigin && machine.fal === true,
      templateVersion: LOOK_VERSION,
```

6. In `status: () => ({`, after `previews,` add `tailoring: 0, tailorQueued: 0, callbacks: 0,` (desk-9 replaces these with the lane's counters).

7. In `configFromEnv`, after `siteOrigin: env.SPONSOR_SITE_ORIGIN || undefined,` add:

```js
    // The tailor's key. Only this desk holds it; the Cloudflare Worker never does.
    falKey: env.FAL_KEY || undefined,
```

and after the `videoOriginForTests:` entry add:

```js
    falOriginForTests:
      env.NODE_ENV === 'test' ? env.SPONSOR_MEDIA_TEST_FAL_HOST : undefined,
```

8. In the boot log at the bottom, replace `capQualified: state.capQualified,` with

```js
      tailor: state.tailor,
      templateVersion: state.templateVersion,
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass. Prerequisite: site-1 has landed (`lib/sponsorship.ts` exports `LOOK_VERSION`); never add that line here.

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "The desk reports whether it can tailor a look, and the cap sells only when it can

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-6: the garment plan and the prompt — pure functions, table-tested

**Files:**
- Modify: `broadcast/sponsor-media.mjs` (module level, after `BASE_STILLS`: colour maths, `WEARERS`, `NEUTRALS`, `garmentPlan`, `tailorPrompt`)
- Test: `tests/sponsor-media.test.mjs` (three tests)

**Interfaces:**
- Consumes: `scripts/wardrobe.py zones` (desk-1) for the cross-check.
- Produces: exported `WEARERS` (same table as the Python), `NEUTRALS = { offWhite: '#F2EFE8', charcoal: '#23262B', heather: '#8B8F96' }`, `deltaE76(hexA, hexB) -> number`, `mutedHex(hex) -> hex`, `garmentPlan(palette, target) -> { shirt: { hex, candidate, inkDeltaE, forced }, cap: { hex, candidate, inkDeltaE, wearerDeltaE, shirtDeltaE, forced, brim } }`, `tailorPrompt(plan) -> string`. Plan rules (spec §1.3 step 2): tee candidates in order muted secondary, muted primary, off-white, charcoal, heather — first with ΔE76 ≥ 25 against every ink cluster (share ≥ 0.10); cap candidates primary, secondary, accent, charcoal, off-white, heather — first with ΔE ≥ 25 against every ink cluster, ≥ 20 against every wearer colour and ≥ 15 from the tee; dark brim (charcoal) when the cap's L\* > 80; when nothing passes, the candidate with the largest minimum ΔE wins and `forced` is true. `mutedHex` = L\* clamped to 38..78, chroma × 0.55.

- [x] **Step 1: Write the failing tests** (append; add `garmentPlan, tailorPrompt, WEARERS, NEUTRALS, deltaE76` to the import)

```js
const PALETTES = {
  black: { clusters: [{ hex: '#111111', share: 1 }], primary: '#111111', secondary: '#111111', accent: '#111111', monochrome: true },
  white: { clusters: [{ hex: '#FFFFFF', share: 1 }], primary: '#FFFFFF', secondary: '#FFFFFF', accent: '#FFFFFF', monochrome: true },
  colourful: { clusters: [{ hex: '#E03030', share: 0.55 }, { hex: '#2050C0', share: 0.35 }, { hex: '#FFD700', share: 0.1 }], primary: '#E03030', secondary: '#2050C0', accent: '#FFD700', monochrome: false },
  pepeGreen: { clusters: [{ hex: '#537631', share: 1 }], primary: '#537631', secondary: '#537631', accent: '#537631', monochrome: false },
  chadSkin: { clusters: [{ hex: '#C18C5F', share: 0.7 }, { hex: '#141510', share: 0.3 }], primary: '#C18C5F', secondary: '#141510', accent: '#C18C5F', monochrome: false },
  navyWhite: { clusters: [{ hex: '#1B2A6B', share: 0.8 }, { hex: '#F5F5F5', share: 0.2 }], primary: '#1B2A6B', secondary: '#F5F5F5', accent: '#1B2A6B', monochrome: false },
  everyNeutral: { clusters: [{ hex: '#F2EFE8', share: 0.3 }, { hex: '#23262B', share: 0.3 }, { hex: '#8B8F96', share: 0.2 }, { hex: '#595959', share: 0.2 }], primary: '#F2EFE8', secondary: '#23262B', accent: '#8B8F96', monochrome: true },
};

void test('the garment plan keeps the print readable and the cap visible on the wearer, and never refuses', () => {
  const table = [
    // name, target, tee, cap, brim, why
    ['black', 'host', '#595959', '#F2EFE8', '#23262B', 'dark grey tee under black ink; an off-white cap with a dark brim'],
    ['white', 'host', '#23262B', '#8B8F96', '#8B8F96', 'charcoal tee under white ink; the off-white cap would hide the tee’s contrast, heather wins'],
    ['colourful', 'guest', '#4E5492', '#F2EFE8', '#23262B', 'a muted secondary tee; the off-white cap clears every ink'],
    ['pepeGreen', 'host', '#F2EFE8', '#8B8F96', '#8B8F96', 'wearer camouflage: his own green fails, charcoal hides in his headphones, heather stands out'],
    ['chadSkin', 'guest', '#595A57', '#F2EFE8', '#23262B', 'skin-toned ink: a muted dark tee, an off-white cap clear of his skin and hair'],
    ['navyWhite', 'host', '#57567D', '#8B8F96', '#8B8F96', 'the test palette every /tailor test sends'],
  ];
  for (const [name, target, tee, cap, brim, why] of table) {
    const plan = garmentPlan(PALETTES[name], target);
    assert.equal(plan.shirt.hex, tee, `${name}/${target} tee: ${why}`);
    assert.equal(plan.cap.hex, cap, `${name}/${target} cap: ${why}`);
    assert.equal(plan.cap.brim, brim, `${name}/${target} brim`);
    assert.equal(plan.shirt.forced, false);
    assert.equal(plan.cap.forced, false);
    assert.ok(plan.shirt.inkDeltaE >= 25, `${name} tee clears the ink`);
    assert.ok(plan.cap.inkDeltaE >= 25 && plan.cap.wearerDeltaE >= 20 && plan.cap.shirtDeltaE >= 15, `${name} cap clears ink, wearer and tee`);
    for (const wearer of Object.values(WEARERS[target]))
      assert.ok(deltaE76(plan.cap.hex, wearer) >= 20, `${name} cap vanishes into the ${target}`);
  }
  // Every candidate is in the ink: the plan still answers, marked forced, with the widest margin left.
  const forced = garmentPlan(PALETTES.everyNeutral, 'host');
  assert.equal(forced.shirt.forced, true);
  assert.equal(forced.cap.forced, true);
  assert.equal(forced.shirt.hex, '#C2C1BD');
  assert.equal(forced.cap.hex, '#F2EFE8');
  assert.deepEqual(NEUTRALS, { offWhite: '#F2EFE8', charcoal: '#23262B', heather: '#8B8F96' });
  assert.equal(Math.round(deltaE76('#FFFFFF', '#000000')), 100);
  assert.equal(deltaE76('#537631', '#537631'), 0);
});

void test('the tailor’s prompt is a fixed template with only the garment colours filled in', () => {
  const plan = garmentPlan(PALETTES.black, 'host');
  assert.equal(
    tailorPrompt(plan),
    'Edit this 2D animated podcast frame. The scene, camera angle, framing, lighting, colours, line weight, pose, expression, hands, headphones, microphone, desk and background stay exactly as in the first image. ' +
      "Replace the character's T-shirt with a plain #595959 crew-neck T-shirt and print the second image large and centred on its chest, reproduced exactly: the same shapes, the same colours and the same proportions, nothing added and nothing left out, sitting on the fabric like a real screen print. " +
      "Add a #F2EFE8 baseball cap with a #23262B brim on the character's head, worn under the headphones so the headphone band still crosses over it, with a small simplified version of the same mark centred on the cap's front panel. " +
      'No other lettering, logos, patches or accessories anywhere in the picture. Nothing else changes.',
  );
  const plain = tailorPrompt(garmentPlan(PALETTES.white, 'guest'));
  assert.match(plain, /Add a #8B8F96 baseball cap on the character's head/);
  assert.doesNotMatch(plain, /brim/);
});

void test(
  'the desk and scripts/wardrobe.py agree on the wearer colours',
  { skip: needsRuntime },
  async () => {
    const { stdout } = await run(config.python, ['scripts/wardrobe.py', 'zones']);
    const zones = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(zones.wearers, WEARERS);
    assert.deepEqual(Object.keys(zones.zones), ['host', 'guest']);
  },
);
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: SyntaxError — `garmentPlan` is not exported.

- [x] **Step 3: Implement** — after the `BASE_STILLS` export add:

```js
// ---- the garment plan: colours for the tee and the cap, from the logo's ink ------------------
// The wearer's own colours, sampled from the base stills; scripts/wardrobe.py keeps the same table
// beside its wardrobe zones and a test pins the two together.
export const WEARERS = {
  host: { head: '#537631', headphones: '#23231C' },
  guest: { hair: '#2C281D', skin: '#C18C5F', headphones: '#141510' },
};
export const NEUTRALS = {
  offWhite: '#F2EFE8',
  charcoal: '#23262B',
  heather: '#8B8F96',
};
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (rgb) =>
  `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
function rgbToLab([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116,
    fx = fy + a / 500,
    fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047,
    y = inv(fy),
    z = inv(fz) * 1.08883;
  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  const gamma = (c) => {
    c = Math.max(0, Math.min(1, c));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return [gamma(R), gamma(G), gamma(B)];
}
/** CIE76 colour difference between two #RRGGBB colours. */
export function deltaE76(a, b) {
  const [l1, a1, b1] = rgbToLab(hexToRgb(a)),
    [l2, a2, b2] = rgbToLab(hexToRgb(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
/** A garment shade of a logo colour: mid-range lightness, a little over half the chroma. */
export function mutedHex(hex) {
  const [L, a, b] = rgbToLab(hexToRgb(hex));
  return rgbToHex(labToRgb([Math.max(38, Math.min(78, L)), a * 0.55, b * 0.55]));
}
const tenth = (n) => Math.round(n * 10) / 10;
/**
 * Colours for the tee and the cap. The tee must clear every ink so the print reads; the cap must
 * clear the ink, the wearer (a green cap on Pepe vanishes) and the tee. Candidates are tried in
 * the spec's order and the first that passes wins; when none does the widest margin wins and the
 * plan says so with `forced`. It never refuses: a plan is always made, the judge decides later.
 */
export function garmentPlan(palette, target) {
  const ink = palette.clusters
    .filter((c) => c.share >= 0.1)
    .map((c) => c.hex.toUpperCase());
  if (!ink.length) ink.push(palette.primary.toUpperCase());
  const wearer = Object.values(WEARERS[target]);
  const least = (hex, others) => Math.min(...others.map((o) => deltaE76(hex, o)));
  const pick = (candidates, rules) => {
    const scored = candidates.map((hex, index) => ({
      hex,
      index,
      margins: rules.map((rule) => least(hex, rule.against)),
    }));
    const passing = scored.find((c) =>
      c.margins.every((m, i) => m >= rules[i].atLeast),
    );
    const chosen =
      passing ??
      scored.reduce((best, c) =>
        Math.min(...c.margins) > Math.min(...best.margins) ? c : best,
      );
    return { ...chosen, forced: !passing };
  };
  const tee = pick(
    [
      mutedHex(palette.secondary),
      mutedHex(palette.primary),
      NEUTRALS.offWhite,
      NEUTRALS.charcoal,
      NEUTRALS.heather,
    ],
    [{ against: ink, atLeast: 25 }],
  );
  const cap = pick(
    [
      palette.primary.toUpperCase(),
      palette.secondary.toUpperCase(),
      palette.accent.toUpperCase(),
      NEUTRALS.charcoal,
      NEUTRALS.offWhite,
      NEUTRALS.heather,
    ],
    [
      { against: ink, atLeast: 25 },
      { against: wearer, atLeast: 20 },
      { against: [tee.hex], atLeast: 15 },
    ],
  );
  const capLightness = rgbToLab(hexToRgb(cap.hex))[0];
  return {
    shirt: {
      hex: tee.hex,
      candidate: tee.index,
      inkDeltaE: tenth(tee.margins[0]),
      forced: tee.forced,
    },
    cap: {
      hex: cap.hex,
      candidate: cap.index,
      inkDeltaE: tenth(cap.margins[0]),
      wearerDeltaE: tenth(cap.margins[1]),
      shirtDeltaE: tenth(cap.margins[2]),
      forced: cap.forced,
      // A pale cap gets a dark brim, so it reads as a cap and not as a bald patch.
      brim: capLightness > 80 ? NEUTRALS.charcoal : cap.hex,
    },
  };
}
/** The fixed instruction the tailor gives the model; only the two garment colours vary. */
export function tailorPrompt(plan) {
  const brim = plan.cap.brim === plan.cap.hex ? '' : ` with a ${plan.cap.brim} brim`;
  return [
    'Edit this 2D animated podcast frame. The scene, camera angle, framing, lighting, colours, line weight, pose, expression, hands, headphones, microphone, desk and background stay exactly as in the first image.',
    `Replace the character's T-shirt with a plain ${plan.shirt.hex} crew-neck T-shirt and print the second image large and centred on its chest, reproduced exactly: the same shapes, the same colours and the same proportions, nothing added and nothing left out, sitting on the fabric like a real screen print.`,
    `Add a ${plan.cap.hex} baseball cap${brim} on the character's head, worn under the headphones so the headphone band still crosses over it, with a small simplified version of the same mark centred on the cap's front panel.`,
    'No other lettering, logos, patches or accessories anywhere in the picture. Nothing else changes.',
  ].join(' ');
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass (the zones cross-check skips without the runtime).

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "The tee and cap colours come from the logo's ink, chosen so the print reads and the cap shows on the host

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-7: the in-desk fal client — submit, poll, fetch; abortable; the key only in the header

**Files:**
- Modify: `broadcast/sponsor-media.mjs` (module level, after `settledWithin`: `wait`, `falClient`)
- Test: `tests/sponsor-media.test.mjs` (one test)

**Interfaces:**
- Consumes: the `falQueue` stand-in (`FALQ`, `falPlan`, `submissions`, `statusPolls`, `cancels`) from desk-5; `MediaError`.
- Produces: exported `falClient({ origin, key, log = () => {}, pollMs = 2_000 })` → `{ run(endpoint, input, { signal, budgetMs }) -> Promise<{ requestId: string | null, output: object }> }`. Hops: `POST ${origin}/${endpoint}` (JSON), `GET status_url` every `pollMs` until `COMPLETED`, `GET response_url`; each hop `redirect: 'error'`, bounded by `AbortSignal.any([budget, timeout])` where `budget = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])`; every URL fal hands back must be on `origin` (else 502 `FAL` "foreign URL"); on any failure after submit a best-effort `PUT cancel_url`. Errors are `MediaError(502, 'FAL' | 'FAL_TIMEOUT', …)`. `scripts/fal.mjs` is not imported.

- [x] **Step 1: Write the failing test** (append; add `falClient` to the import)

```js
void test('the fal client makes three hops, stops polling the moment it is abandoned, and cancels the job', async () => {
  const client = falClient({ origin: FALQ, key: 'fal-test-key', pollMs: 50 });
  const before = submissions.length;
  const done = await client.run(
    'fal-ai/nano-banana-pro/edit',
    { prompt: 'x', seed: 1, image_urls: [] },
    { signal: new AbortController().signal, budgetMs: 5_000 },
  );
  assert.equal(done.output.images[0].width, 1376);
  assert.match(done.requestId, /^req-\d+$/);
  assert.equal(submissions.length, before + 1);
  assert.equal(submissions.at(-1).authorization, 'Key fal-test-key');
  assert.equal(submissions.at(-1).url.includes('fal-test-key'), false, 'the key was in a URL');

  // Abandoned mid-poll: no more polls, the job is cancelled.
  falPlan.hang = true;
  const controller = new AbortController();
  const polled = statusPolls,
    cancelled = cancels;
  const running = client.run(
    'fal-ai/nano-banana-pro/edit',
    { prompt: 'x', seed: 2, image_urls: [] },
    { signal: controller.signal, budgetMs: 5_000 },
  );
  assert.ok(await until(() => statusPolls >= polled + 2));
  controller.abort('deadline');
  await assert.rejects(running, (e) => e.code === 'FAL');
  const seen = statusPolls;
  await pause(200);
  assert.equal(statusPolls, seen, 'kept polling after it was abandoned');
  assert.ok(await until(() => cancels === cancelled + 1), 'the job was not cancelled');

  // Out of budget: the same, in its own words.
  await assert.rejects(
    client.run('fal-ai/nano-banana-pro/edit', { prompt: 'x', seed: 3, image_urls: [] }, { signal: new AbortController().signal, budgetMs: 300 }),
    (e) => e.code === 'FAL_TIMEOUT' || e.code === 'FAL',
  );
  falPlan.hang = false;

  // fal's own answers are checked: a status URL off fal's origin is never followed.
  falPlan.foreign = true;
  await assert.rejects(
    client.run('fal-ai/nano-banana-pro/edit', { prompt: 'x', seed: 4, image_urls: [] }, { signal: new AbortController().signal, budgetMs: 5_000 }),
    /foreign/,
  );
  falPlan.foreign = false;
  falPlan.fail = true;
  await assert.rejects(
    client.run('fal-ai/nano-banana-pro/edit', { prompt: 'x', seed: 5, image_urls: [] }, { signal: new AbortController().signal, budgetMs: 5_000 }),
    /failed/,
  );
  falPlan.fail = false;
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: SyntaxError — `falClient` is not exported.

- [x] **Step 3: Implement** — after `async function settledWithin(…) { … }` add:

```js
/** Settles after `ms`, or rejects at once when `signal` aborts. */
function wait(ms, signal) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      done();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      fail(new MediaError(502, 'FAL', 'The fal job was abandoned.'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/**
 * fal's queue in three hops: submit, poll, fetch. Each hop is bounded by its own timeout and by
 * the caller's signal, the polling by the budget, and every URL fal hands back has to be fal's
 * own before it is followed. The key travels in the Authorization header and nowhere else: not
 * in a URL, not in a log line. A job nobody waits for any more is cancelled, best effort, so it
 * neither holds fal's queue nor runs up the bill.
 */
export function falClient({ origin, key, log = () => {}, pollMs = 2_000 }) {
  const headers = (json) => ({
    authorization: `Key ${key}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  });
  const own = (raw) => {
    let url = null;
    try {
      url = new URL(String(raw));
    } catch {
      /* Not a URL at all. */
    }
    if (!url || url.origin !== origin)
      throw new MediaError(502, 'FAL', 'fal answered with a foreign URL.');
    return url;
  };
  async function hop(url, init, signal, ms, what) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      });
    } catch {
      throw new MediaError(
        502,
        'FAL',
        signal.aborted ? `fal ${what} was abandoned.` : `fal ${what} did not answer in time.`,
      );
    }
    const text = await response.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* Not JSON; handled below. */
    }
    if (!response.ok || !data || typeof data !== 'object') {
      log({
        level: 'warn',
        event: 'fal',
        what,
        status: response.status,
        detail: String(data?.detail ?? text).slice(0, 200),
      });
      throw new MediaError(502, 'FAL', `fal ${what} returned ${response.status}.`);
    }
    return data;
  }
  return {
    async run(endpoint, input, { signal, budgetMs }) {
      const end = Date.now() + budgetMs;
      const left = (cap) => Math.max(1, Math.min(cap, end - Date.now()));
      const budget = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
      const job = await hop(
        `${origin}/${endpoint}`,
        { method: 'POST', headers: headers(true), body: JSON.stringify(input) },
        budget,
        left(20_000),
        'submit',
      );
      const statusUrl = own(job.status_url),
        responseUrl = own(job.response_url),
        cancelUrl = job.cancel_url ? own(job.cancel_url) : null;
      try {
        for (;;) {
          const state = await hop(
            statusUrl,
            { method: 'GET', headers: headers(false) },
            budget,
            left(10_000),
            'status',
          );
          if (state.status === 'COMPLETED') break;
          if (state.status === 'FAILED')
            throw new MediaError(502, 'FAL', 'fal reported the job failed.');
          if (Date.now() + pollMs >= end)
            throw new MediaError(502, 'FAL_TIMEOUT', 'fal took longer than the fit allows.');
          await wait(pollMs, budget);
        }
        const output = await hop(
          responseUrl,
          { method: 'GET', headers: headers(false) },
          budget,
          left(15_000),
          'response',
        );
        return {
          requestId: typeof job.request_id === 'string' ? job.request_id : null,
          output,
        };
      } catch (error) {
        if (cancelUrl)
          void fetch(cancelUrl, {
            method: 'PUT',
            headers: headers(false),
            redirect: 'error',
            signal: AbortSignal.timeout(3_000),
          }).then((r) => r.body?.cancel().catch(() => {}), () => {});
        throw error;
      }
    },
  };
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "The desk talks to fal itself, stops the moment a fit is abandoned, and never lets its key out of the header

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-8: `sendLook` — every settlement reaches the site, three attempts, a 4xx is final

**Files:**
- Modify: `broadcast/sponsor-media.mjs` (module level, after `falClient`)
- Test: `tests/sponsor-media.test.mjs` (one test)

**Interfaces:**
- Consumes: the `site` stand-in (`SITE`, `looks`, `siteAnswers`) from desk-5.
- Produces: exported `sendLook(url, { headers, body }, { attempts = 3, timeoutMs = 20_000, retryMs = 5_000 } = {}) -> Promise<number>` — the last HTTP status, `0` when the site never answered; `PUT`, `redirect: 'error'`; a 2xx or any 4xx ends the attempts, anything else is retried after `retryMs`.

- [x] **Step 1: Write the failing test** (append; add `sendLook` to the import)

```js
void test('a look callback is retried through outages, accepted once, and never retried after the site’s verdict', async () => {
  const id = sha('callback-asset');
  const url = `${SITE}/api/sponsorship/assets/${id}?part=look`;
  const body = Buffer.concat([PNG_HEADER, Buffer.from('look-bytes')]);
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'image/png',
    'x-look-round': '1',
    'x-look-outcome': 'look',
    'x-look-sha256': sha(body),
  };
  const before = looks.length;
  siteAnswers = [503, 503];
  assert.equal(await sendLook(url, { headers, body }, { retryMs: 20, timeoutMs: 2_000 }), 200);
  const mine = looks.slice(before).filter((l) => l.id === id);
  assert.equal(mine.length, 3, 'two outages, then the answer');
  assert.ok(mine[2].body.equals(body));
  assert.equal(mine[2].headers['x-look-sha256'], sha(body));
  assert.equal(mine[2].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(mine[2].url, `/api/sponsorship/assets/${id}?part=look`);
  siteAnswers = [401];
  assert.equal(await sendLook(url, { headers, body }, { retryMs: 20, timeoutMs: 2_000 }), 401);
  assert.equal(looks.slice(before).filter((l) => l.id === id).length, 4, 'a 4xx was retried');
  siteAnswers = [];
  const started = Date.now();
  assert.equal(await sendLook('http://127.0.0.1:1/api/sponsorship/assets/x?part=look', { headers, body }, { retryMs: 20, timeoutMs: 500 }), 0);
  assert.ok(Date.now() - started < 3_000, 'a dead site held the desk');
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: SyntaxError — `sendLook` is not exported.

- [x] **Step 3: Implement** — after `falClient` add:

```js
/**
 * Every settlement of a tailor job is told to the site: one PUT to the asset's look URL, three
 * attempts about half a minute apart at most. A 4xx is the site's verdict on the callback and is
 * not retried; an outage or a timeout is. Returns the last status, 0 when nothing ever answered.
 */
export async function sendLook(
  url,
  { headers, body },
  { attempts = 3, timeoutMs = 20_000, retryMs = 5_000 } = {},
) {
  let status = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => {});
      status = response.status;
      if (response.ok || (status >= 400 && status < 500)) return status;
    } catch {
      status = 0;
    }
    if (attempt < attempts) await new Promise((done) => setTimeout(done, retryMs));
  }
  return status;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "A finished look reaches the site even through a short outage, and a refused callback is not repeated

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-9: `POST /tailor` — validation, the tailor lane, the job (logo, plan, fits, pixel judge, vision judge), the look callback, the outcome cache

**Files:**
- Modify: `broadcast/sponsor-media.mjs` (module level after `sendLook`: `checkedPalette`, `tailorKey`, `seedFor`, `JUDGE_SYSTEM`, `judgePrompt`, `judgePasses`; inside `createMediaService`: lane state, `settledOutcome`, `rememberOutcome`, `admitTailor`, `startTailor`, `pumpTailor`, `tailor`, `attemptFit`, `visionJudge`, `deliver`, `handleTailor`; `checkedUrl` kind `'fal'`; `handle` routing; `status()`; `close()`)
- Test: `tests/sponsor-media.test.mjs` (helpers `PALETTE`, `tailorDesk`, `tailorOrder`, `landed`; six tests)

**Interfaces:**
- Consumes: `wardrobe` (desk-4), `BASE_STILLS`, `LOOK_VERSION`, `TAILOR_MODEL`, `JUDGE_ENDPOINT`, `JUDGE_MODEL`, `FITS`, `MAX_TAILOR_BODY`, DEFAULTS (desk-5), `garmentPlan`, `tailorPrompt` (desk-6), `falClient` (desk-7), `sendLook` (desk-8), existing `download`, `cached`, `remember`, `checkedUrl`, `bytesLimited`, `busy`.
- Produces: `POST /tailor` per CONTRACT (202 `{ key, queued: true }` | 200 `{ key, cached: true }` | 409 `{ code: 'BUSY', retryAfterMs }` | 400 `ASSET_ID | ROUND | TARGET | LOGO_HASH | HOST | PALETTE | JSON` | 503 `TAILOR_UNAVAILABLE`); exported `tailorKey(logoSha256, target, round) = sha256(`${logoSha256}|${target}|${LOOK_VERSION}|${round}`)`, `judgePrompt({ plan, pixels })`, `judgePasses(judge)`; the callback per CONTRACT with `x-look-verdict` = base64 JSON `{ model, fit, round, seed, requestId, palette, plan, judge, pixels, candidateUrl, fits }` (`fallback` added by desk-10); `status()` counters `tailoring, tailorQueued, callbacks`; log events `tailor` (per settlement) and `fal`. The vision request is `POST ${falOrigin}/openrouter/router/vision` with body `{ model: 'google/gemini-2.5-flash', prompt: judgePrompt(...), system_prompt: JUDGE_SYSTEM, image_urls: [baseStillUrl, logoUrl, candidateUrl], temperature: 0, max_tokens: 400 }`; the edit is `POST ${falOrigin}/fal-ai/nano-banana-pro/edit` with `{ prompt, image_urls: [baseStillUrl, logoUrl], aspect_ratio: '16:9', resolution: '1K', output_format: 'png', num_images: 1, seed }`. Test helpers `PALETTE`, `tailorDesk(t, plan, options)`, `tailorOrder(extra)`, `landed(assetId, count)`.

- [x] **Step 1: Write the failing tests** (append; add `tailorKey, judgePasses, judgePrompt` to the import)

```js
// The palette every /tailor test sends (its plan: a #57567D tee and a #8B8F96 cap, see desk-6).
const PALETTE = {
  clusters: [{ hex: '#1B2A6B', share: 0.8 }, { hex: '#F5F5F5', share: 0.2 }],
  primary: '#1B2A6B',
  secondary: '#F5F5F5',
  accent: '#1B2A6B',
  monochrome: false,
};
/** A desk with a tailor: a stand-in interpreter steered by `plan`, the site and fal stand-ins. */
async function tailorDesk(t, plan = {}, options = {}) {
  const countFile = join(scratch, `judge-count-${randomBytes(4).toString('hex')}.txt`);
  const judgeFile = join(scratch, `judge-${randomBytes(4).toString('hex')}.txt`);
  await writeFile(judgeFile, plan.judge ?? 'pass');
  const python = await fakeWardrobe(`tailor-${randomBytes(4).toString('hex')}`, { ...plan, judgeFile, countFile });
  const media = await desk(t, {
    python,
    siteOrigin: SITE,
    falKey: 'fal-test-key',
    falOriginForTests: FALQ,
    falPollMs: 20,
    callbackRetryMs: 20,
    ...options,
  });
  return { ...media, python, judgeFile, countFile };
}
let orders = 0;
/** A tailor request for a fresh logo, served by the site stand-in. */
function tailorOrder(extra = {}) {
  const logo = Buffer.concat([LOGO, Buffer.from(`order-${++orders}`)]);
  const logoSha256 = sha(logo);
  const assetId = sha(`asset-${logoSha256}`);
  logos.set(`/api/sponsorship/assets/${assetId}`, logo);
  return {
    assetId,
    round: 1,
    target: 'host',
    logoUrl: `${SITE}/api/sponsorship/assets/${assetId}?part=logo`,
    logoSha256,
    palette: PALETTE,
    projectName: 'Canvas',
    ...extra,
  };
}
const landed = (assetId, count = 1) =>
  until(() => looks.filter((l) => l.id === assetId).length >= count, 15_000);
const verdictOf = (look) => JSON.parse(Buffer.from(look.headers['x-look-verdict'], 'base64').toString('utf8'));

void test('/tailor refuses what it cannot tailor before queueing anything', async (t) => {
  const media = await tailorDesk(t);
  const before = submissions.length;
  const cases = [
    [{ assetId: 'nope' }, 400, 'ASSET_ID'],
    [{ round: 4 }, 400, 'ROUND'],
    [{ round: '1' }, 400, 'ROUND'],
    [{ target: 'crowd' }, 400, 'TARGET'],
    [{ logoSha256: 'abc' }, 400, 'LOGO_HASH'],
    [{ logoUrl: 'https://attacker.example/api/sponsorship/assets/x?part=logo' }, 400, 'HOST'],
    [{ logoUrl: `${SITE}/somewhere/else` }, 400, 'HOST'],
    [{ palette: { clusters: 'no' } }, 400, 'PALETTE'],
    [{ palette: { ...PALETTE, primary: 'blue' } }, 400, 'PALETTE'],
  ];
  for (const [patch, status, code] of cases) {
    const r = await post(media, tailorOrder(patch), { path: '/tailor' });
    assert.equal(r.status, status, `${code}: ${r.bytes}`);
    assert.equal(r.json().code, code);
  }
  assert.equal((await post(media, 'not json', { path: '/tailor' })).status, 400);
  assert.equal((await post(media, tailorOrder(), { path: '/tailor', token: 'wrong' })).status, 401);
  assert.equal(submissions.length, before, 'a refused request reached fal');
  assert.equal(media.spawns.length, 0);
  const noSite = await tailorDesk(t, {}, { siteOrigin: undefined });
  const unavailable = await post(noSite, tailorOrder(), { path: '/tailor' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json().code, 'TAILOR_UNAVAILABLE');
  const noKey = await tailorDesk(t, {}, { falKey: undefined });
  assert.equal((await post(noKey, tailorOrder(), { path: '/tailor' })).json().code, 'TAILOR_UNAVAILABLE');
});

void test('a tailor job fits, judges by pixels and by eye, and puts the look on the site with its verdict', async (t) => {
  const media = await tailorDesk(t);
  const order = tailorOrder();
  const before = submissions.length;
  const r = await post(media, order, { path: '/tailor' });
  assert.equal(r.status, 202, r.bytes.toString());
  const key = tailorKey(order.logoSha256, 'host', 1);
  assert.deepEqual(r.json(), { key, queued: true });
  assert.equal(key, sha(`${order.logoSha256}|host|looks-v1|1`));
  assert.ok(await landed(order.assetId), 'no look reached the site');
  const look = looks.find((l) => l.id === order.assetId);
  assert.equal(look.url, `/api/sponsorship/assets/${order.assetId}?part=look`);
  assert.equal(look.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(look.headers['x-look-outcome'], 'look');
  assert.equal(look.headers['x-look-round'], '1');
  assert.equal(look.headers['content-type'], 'image/png');
  assert.equal(look.headers['x-look-sha256'], sha(look.body));
  assert.ok(look.body.subarray(0, 8).equals(PNG_HEADER));
  const verdict = verdictOf(look);
  assert.equal(verdict.model, 'fal-ai/nano-banana-pro/edit');
  assert.equal(verdict.fit, 1);
  assert.equal(verdict.round, 1);
  assert.equal(verdict.plan.shirt.hex, '#57567D');
  assert.equal(verdict.plan.cap.hex, '#8B8F96');
  assert.deepEqual(verdict.palette, PALETTE);
  assert.equal(verdict.judge.shirtLogo, true);
  assert.equal(verdict.pixels.pixelAgreement, 0.97);
  assert.ok(verdict.candidateUrl.startsWith(`${FAL}/files/`));
  assert.equal(verdict.fallback, undefined);
  assert.equal(typeof verdict.seed, 'number');
  // The two fal calls: the edit with the still and the logo, the judge with all three pictures.
  const mine = submissions.slice(before);
  const edit = mine.find((s) => s.endpoint === 'fal-ai/nano-banana-pro/edit');
  assert.deepEqual(edit.input.image_urls, [BASE_STILLS.host.url, order.logoUrl]);
  assert.equal(edit.input.aspect_ratio, '16:9');
  assert.equal(edit.input.resolution, '1K');
  assert.equal(edit.input.output_format, 'png');
  assert.equal(edit.input.seed, verdict.seed);
  assert.match(edit.input.prompt, /#57567D crew-neck T-shirt/);
  assert.match(edit.input.prompt, /#8B8F96 baseball cap/);
  assert.equal(edit.authorization, 'Key fal-test-key');
  const judge = mine.find((s) => s.endpoint === 'openrouter/router/vision');
  assert.equal(judge.input.model, 'google/gemini-2.5-flash');
  assert.equal(judge.input.temperature, 0);
  assert.deepEqual(judge.input.image_urls, [BASE_STILLS.host.url, order.logoUrl, verdict.candidateUrl]);
  assert.match(judge.input.prompt, /97\.0% of pixels unchanged/);
  assert.match(judge.input.prompt, /"logoFidelity"/);
  assert.ok(media.spawns.some((s) => s.mode === 'wardrobe-judge'));
  const line = await until(() => media.logs.find((l) => l.event === 'tailor' && l.outcome === 'look'));
  assert.ok(line, 'no tailor line was logged');
  assert.equal(media.logs.find((l) => l.event === 'tailor').callback, 200);
  assert.ok(!JSON.stringify(media.logs).includes('fal-test-key'));
  assert.equal(media.service.status().tailoring, 0);
});

void test('the same key in flight is joined, and a settled key is re-told from the cache without a new fit', async (t) => {
  const media = await tailorDesk(t);
  const order = tailorOrder();
  const before = submissions.length;
  const [a, b] = await Promise.all([
    post(media, order, { path: '/tailor' }),
    post(media, order, { path: '/tailor' }),
  ]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(a.json().key, b.json().key);
  assert.ok(await landed(order.assetId));
  await pause(300);
  assert.equal(looks.filter((l) => l.id === order.assetId).length, 1, 'one job, one callback');
  assert.equal(submissions.slice(before).filter((s) => s.endpoint === 'fal-ai/nano-banana-pro/edit').length, 1);
  const again = await post(media, order, { path: '/tailor' });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json(), { key: a.json().key, cached: true });
  assert.ok(await landed(order.assetId, 2), 'the cached look was not re-sent');
  const [first, second] = looks.filter((l) => l.id === order.assetId);
  assert.equal(second.headers['x-look-sha256'], first.headers['x-look-sha256']);
  assert.equal(submissions.slice(before).filter((s) => s.endpoint === 'fal-ai/nano-banana-pro/edit').length, 1, 'a cached key bought a fit');
  // A second round is a different key with different seeds.
  const round2 = await post(media, { ...order, round: 2 }, { path: '/tailor' });
  assert.equal(round2.status, 202);
  assert.notEqual(round2.json().key, a.json().key);
  assert.ok(await landed(order.assetId, 3));
  assert.notEqual(verdictOf(looks.filter((l) => l.id === order.assetId)[2]).seed, verdictOf(first).seed);
});

void test('a fit the pixels refuse, or the eye refuses, is followed by another seed inside the same job', async (t) => {
  const media = await tailorDesk(t, { judge: 'DRIFT,pass' });
  const order = tailorOrder();
  const before = submissions.length;
  assert.equal((await post(media, order, { path: '/tailor' })).status, 202);
  assert.ok(await landed(order.assetId));
  const verdict = verdictOf(looks.find((l) => l.id === order.assetId));
  assert.equal(verdict.fit, 2);
  assert.equal(verdict.fits.length, 2);
  assert.equal(verdict.fits[0].reason, 'DRIFT');
  assert.equal(verdict.fits[1].pass, true);
  const edits = submissions.slice(before).filter((s) => s.endpoint === 'fal-ai/nano-banana-pro/edit');
  assert.equal(edits.length, 2);
  assert.notEqual(edits[0].input.seed, edits[1].input.seed);
  assert.equal(submissions.slice(before).filter((s) => s.endpoint === 'openrouter/router/vision').length, 1, 'the eye was asked about a fit the pixels had refused');

  // The eye: the cap's letters fail a fit; a garbled cap mark alone does not.
  falPlan.judgeAnswers = [{ ...PASS_JUDGE, capExtraText: true }, { ...PASS_JUDGE, capColourMatchesPlan: false }];
  const byEye = await tailorDesk(t);
  const second = tailorOrder();
  assert.equal((await post(byEye, second, { path: '/tailor' })).status, 202);
  assert.ok(await landed(second.assetId));
  const eyed = verdictOf(looks.find((l) => l.id === second.assetId));
  assert.equal(eyed.fit, 2);
  assert.equal(eyed.fits[0].reason, 'JUDGE');
  assert.equal(eyed.fits[0].judge.capExtraText, true);
  assert.equal(eyed.judge.capColourMatchesPlan, false);
  falPlan.judgeAnswers = [];
});

void test('the vision judge’s thresholds: chest print and scene decide, the cap mark never refuses', () => {
  assert.equal(judgePasses(PASS_JUDGE), true);
  assert.equal(judgePasses({ ...PASS_JUDGE, capColourMatchesPlan: false, logoFidelity: 7, legibility: 7 }), true, 'a garbled cap mark passes');
  assert.equal(judgePasses({ ...PASS_JUDGE, capExtraText: true }), false, 'letters on the cap fail');
  assert.equal(judgePasses({ ...PASS_JUDGE, sceneUnchanged: false }), false, 'a changed scene fails');
  assert.equal(judgePasses({ ...PASS_JUDGE, identityUnchanged: false }), false);
  assert.equal(judgePasses({ ...PASS_JUDGE, logoFidelity: 6 }), false);
  assert.equal(judgePasses({ ...PASS_JUDGE, legibility: 6 }), false);
  assert.equal(judgePasses({ ...PASS_JUDGE, capPresent: false }), false);
  assert.equal(judgePasses({ ...PASS_JUDGE, shirtLogo: false }), false);
  assert.equal(judgePasses({ ...PASS_JUDGE, extraText: true }), false);
  assert.equal(judgePasses(null), false);
  const prompt = judgePrompt({ plan: garmentPlan(PALETTE, 'host'), pixels: { pixelAgreement: 0.923, meanDrift: 4.25 } });
  assert.match(prompt, /92\.3% of pixels unchanged \(mean drift 4\.3\/255\)/);
  assert.match(prompt, /#57567D T-shirt/);
  assert.match(prompt, /#8B8F96 baseball cap/);
});

void test('the tailor has its own lane: BUSY when it is full, /render untouched, and a clock that adds up', async (t) => {
  falPlan.hang = true;
  const media = await tailorDesk(t, {}, { tailorConcurrency: 1, tailorQueue: 0, tailorDeadlineMs: 1_500, tailorFitMs: 400, tailorTailMs: 100, tailorSubmitMs: 300, judgeMs: 50 });
  const first = tailorOrder();
  assert.equal((await post(media, first, { path: '/tailor' })).status, 202);
  const second = await post(media, tailorOrder(), { path: '/tailor' });
  assert.equal(second.status, 409, second.bytes.toString());
  assert.equal(second.json().code, 'BUSY');
  assert.ok(second.json().retryAfterMs >= 1000);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
  const state = media.service.status();
  assert.equal(state.tailoring, 1);
  assert.equal(state.running, 0, 'the render lane was touched');
  assert.equal((await fetch(`${media.url}/health`)).status, 200, 'a busy tailor is not an unready desk');
  assert.ok(await landed(first.assetId), 'the hung job never settled');
  falPlan.hang = false;
  assert.equal((await post(media, tailorOrder(), { path: '/tailor' })).status, 202, 'the lane never freed');

  const { tailorDeadlineMs, tailorFitMs, tailorSubmitMs, judgeMs, tailorTailMs, logoFetchMs, drainMs } = MEDIA_DEFAULTS;
  assert.equal(3 * tailorFitMs + tailorTailMs, tailorDeadlineMs, 'three fits and the tail make the deadline');
  assert.ok(tailorSubmitMs + judgeMs <= tailorFitMs, 'a fit holds its two hops');
  assert.ok(logoFetchMs <= tailorTailMs);
  assert.ok(tailorDeadlineMs < 4 * 60_000, 'the site’s four-minute probe must outlast a job');
  assert.ok(drainMs < tailorDeadlineMs, 'a deploy cuts a running tailor; the shutdown callback is the recovery signal');
  assert.ok(SHUTDOWN_MS >= drainMs + 3_000, 'the callback wait at close fits before the hard stop');
});
```

Add `randomBytes` to the `node:crypto` import at the top of the test file.

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: SyntaxError — `tailorKey` is not exported.

- [x] **Step 3: Implement**

In `broadcast/sponsor-media.mjs`, module level, after `sendLook` add:

```js
const HEX6 = /^#[0-9A-Fa-f]{6}$/;
/** The palette /logo produced, checked field by field; the plan is computed from it. */
function checkedPalette(raw) {
  const bad = () => new MediaError(400, 'PALETTE', 'A palette from /logo is required.');
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.clusters) ||
    raw.clusters.length < 1 ||
    raw.clusters.length > 8
  )
    throw bad();
  const clusters = raw.clusters.map((c) => {
    if (
      !c ||
      typeof c.hex !== 'string' ||
      !HEX6.test(c.hex) ||
      typeof c.share !== 'number' ||
      !(c.share >= 0 && c.share <= 1)
    )
      throw bad();
    return { hex: c.hex.toUpperCase(), share: c.share };
  });
  for (const name of ['primary', 'secondary', 'accent'])
    if (typeof raw[name] !== 'string' || !HEX6.test(raw[name])) throw bad();
  return {
    clusters,
    primary: raw.primary.toUpperCase(),
    secondary: raw.secondary.toUpperCase(),
    accent: raw.accent.toUpperCase(),
    monochrome: raw.monochrome === true,
  };
}
/** One tailor job per logo, host, look version and round; a new round means new seeds. */
export function tailorKey(logoSha256, target, round) {
  return hash(`${logoSha256}|${target}|${LOOK_VERSION}|${round}`);
}
const seedFor = (key, fit) =>
  parseInt(hash(`${key}|${fit}`).slice(0, 8), 16) % 2147483647;

const JUDGE_SYSTEM =
  'You are a strict quality inspector for a broadcast wardrobe. Answer with one JSON object and nothing else.';
/** What the vision judge is asked about one fit; the pixel numbers go in rather than deciding alone. */
export function judgePrompt({ plan, pixels }) {
  return [
    'Three images: (1) the ORIGINAL frame, (2) the LOGO, (3) the CANDIDATE frame edited to dress the character.',
    `The candidate should show the character in a ${plan.shirt.hex} T-shirt with the LOGO printed large and centred on the chest, and a ${plan.cap.hex} baseball cap under the headphones with a small version of the same mark on its front.`,
    `A pixel comparison outside the tee and cap found ${(Math.round(pixels.pixelAgreement * 1000) / 10).toFixed(1)}% of pixels unchanged (mean drift ${pixels.meanDrift.toFixed(1)}/255).`,
    'Judge logoFidelity and legibility on the chest print only; the cap mark may be simplified. Report JSON with exactly these keys:',
    '{"shirtLogo": boolean (the LOGO is printed on the T-shirt chest), "logoFidelity": 0-10 (how exactly the chest print reproduces the LOGO: shapes, colours, proportions), "legibility": 0-10 (how readable the chest print is at a glance), "capPresent": boolean, "capColourMatchesPlan": boolean, "capExtraText": boolean (the cap carries letters or words that are not part of the mark), "identityUnchanged": boolean (same character, face, expression, pose, hands and headphones), "sceneUnchanged": boolean (same background, desk, microphone, lighting and camera), "extraText": boolean (any new lettering, logo or watermark anywhere other than the chest print and the cap mark)}',
  ].join('\n');
}
/** Pass = the chest print is the logo, readable, on the same character in the same scene; the cap
 * is there and carries no letters. How well the cap mark came out never refuses a fit. */
export function judgePasses(judge) {
  return (
    !!judge &&
    typeof judge === 'object' &&
    judge.shirtLogo === true &&
    typeof judge.logoFidelity === 'number' &&
    judge.logoFidelity >= 7 &&
    typeof judge.legibility === 'number' &&
    judge.legibility >= 7 &&
    judge.capPresent === true &&
    judge.capExtraText !== true &&
    judge.identityUnchanged === true &&
    judge.sceneUnchanged === true &&
    judge.extraText !== true
  );
}
```

Inside `createMediaService`:

1. After `let previews = 0, closing = false, expectedRunMs = cfg.minRunMs;` add:

```js
  // The tailor's lane: in flight by key, queued, running, the promises of the running ones, and
  // the callbacks still leaving. Non-look outcomes are remembered here; looks in the file cache.
  const tailoring = new Map(),
    tailorQueue = [],
    tailorActive = new Set(),
    tailorRuns = new Set(),
    callbacks = new Set(),
    refusals = new Map();
  const fal = falClient({
    origin: falOrigin,
    key: cfg.falKey || '',
    log,
    pollMs: cfg.falPollMs,
  });
```

2. In `checkedUrl`, replace `kind === 'video'` with `kind === 'video' || kind === 'fal'` (the fal.media rule serves both the take and the candidate picture).

3. After the `wardrobe` function (desk-4) add:

```js
  // ---- the tailor -----------------------------------------------------------------------
  const tailorBusy = (retry) =>
    new MediaError(409, 'BUSY', 'The tailor is busy. Try again shortly.', {
      retryAfterMs: retry,
    });
  function tailorRetryAfterMs() {
    const now = Date.now();
    let soonest = Infinity;
    for (const job of tailorActive)
      soonest = Math.min(soonest, job.startedAt + cfg.tailorFitMs - now);
    return Math.min(
      60_000,
      Math.max(1_000, Math.round(Number.isFinite(soonest) ? soonest : 1_000)),
    );
  }
  async function settledOutcome(key) {
    const hit = await cached(key);
    if (hit)
      return {
        kind: 'look',
        bytes: hit.bytes,
        sha256: hit.summary.outputSha256,
        verdict: hit.summary.verdict,
      };
    const other = refusals.get(key);
    if (other && Date.now() - other.at <= cfg.cacheTtlMs) return other.outcome;
    refusals.delete(key);
    return null;
  }
  function rememberOutcome(key, outcome) {
    if (outcome.kind === 'look')
      return remember(key, outcome.bytes, {
        outputSha256: outcome.sha256,
        outcome: 'look',
        verdict: outcome.verdict,
      }).catch((error) =>
        log({
          level: 'warn',
          event: 'cache',
          error: String(error?.message || error).slice(0, 200),
        }),
      );
    refusals.set(key, { at: Date.now(), outcome });
    while (refusals.size > cfg.cacheMax)
      refusals.delete(refusals.keys().next().value);
    return Promise.resolve();
  }
  function admitTailor(order, arrivedAt) {
    if (closing) throw tailorBusy(2_000);
    const free = tailorActive.size < cfg.tailorConcurrency && !tailorQueue.length;
    if (!free && tailorQueue.length >= cfg.tailorQueue)
      throw tailorBusy(tailorRetryAfterMs());
    const job = {
      ...order,
      arrivedAt,
      deadlineAt: arrivedAt + cfg.tailorDeadlineMs,
      state: 'queued',
      controller: new AbortController(),
      stages: {},
      fits: [],
    };
    tailoring.set(job.key, job);
    job.clock = setTimeout(
      () => job.controller.abort('deadline'),
      cfg.tailorDeadlineMs,
    );
    if (free) startTailor(job);
    else tailorQueue.push(job);
    return job;
  }
  function startTailor(job) {
    job.state = 'running';
    job.startedAt = Date.now();
    tailorActive.add(job);
    const work = tailor(job)
      .catch((error) =>
        log({
          level: 'error',
          event: 'tailor',
          key: job.key.slice(0, 12),
          outcome: 'internal',
          error: String(error?.message || error).slice(0, 300),
        }),
      )
      .finally(() => {
        clearTimeout(job.clock);
        tailorActive.delete(job);
        if (tailoring.get(job.key) === job) tailoring.delete(job.key);
        tailorRuns.delete(work);
        pumpTailor();
      });
    tailorRuns.add(work);
  }
  function pumpTailor() {
    while (
      !closing &&
      tailorActive.size < cfg.tailorConcurrency &&
      tailorQueue.length
    )
      startTailor(tailorQueue.shift());
  }
  const summarize = (verdict) => ({
    fit: verdict.fit,
    seed: verdict.seed,
    pass: verdict.pass,
    reason: verdict.reason,
    error: verdict.error,
    ms: verdict.ms,
    candidateUrl: verdict.candidateUrl,
    requestId: verdict.requestId,
    pixels: verdict.pixels,
    judge: verdict.judge,
  });

  // Ask the eye about one fit; the answer is JSON, fenced or not, kept in full for audit.
  async function visionJudge({ base, logo, candidate, plan, pixels }, signal) {
    const { output } = await fal.run(
      JUDGE_ENDPOINT,
      {
        model: JUDGE_MODEL,
        prompt: judgePrompt({ plan, pixels }),
        system_prompt: JUDGE_SYSTEM,
        image_urls: [base, logo, candidate],
        temperature: 0,
        max_tokens: 400,
      },
      { signal, budgetMs: cfg.judgeMs },
    );
    const text = String(output?.output ?? '');
    let parsed = null;
    try {
      parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {
      /* Not JSON. */
    }
    if (!parsed || typeof parsed !== 'object')
      throw new MediaError(502, 'JUDGE', 'The judge did not answer in JSON.');
    return { ...parsed, text: text.slice(0, 600) };
  }

  // One fit: the edit, the download, the pixel judge, the eye. A verdict, never a throw, unless
  // the whole job was abandoned.
  async function attemptFit(job, dir, { fit, seed, plan, prompt, base }) {
    const signal = job.controller.signal;
    const started = Date.now();
    const within = AbortSignal.any([signal, AbortSignal.timeout(cfg.tailorFitMs)]);
    const verdict = { fit, seed, pass: false };
    try {
      const { requestId, output } = await fal.run(
        TAILOR_MODEL,
        {
          prompt,
          image_urls: [base.url, job.logoUrl.href],
          aspect_ratio: '16:9',
          resolution: '1K',
          output_format: 'png',
          num_images: 1,
          seed,
        },
        { signal: within, budgetMs: cfg.tailorSubmitMs },
      );
      verdict.requestId = requestId;
      const candidateUrl = checkedUrl(output?.images?.[0]?.url, 'fal').href;
      verdict.candidateUrl = candidateUrl;
      const candidate = join(dir, `fit-${fit}.png`);
      await download(
        candidateUrl,
        candidate,
        MAX_RENDER_BODY,
        AbortSignal.any([
          within,
          AbortSignal.timeout(Math.max(1, started + cfg.tailorSubmitMs - Date.now())),
        ]),
        signal,
      );
      const cropped = join(dir, `fit-${fit}-look.png`),
        palette = join(dir, 'palette.json');
      await writeFile(palette, JSON.stringify(job.palette));
      const judged = await wardrobe(
        [
          'judge',
          '--base',
          base.path,
          '--candidate',
          candidate,
          '--target',
          job.target,
          '--palette',
          palette,
          '--output',
          cropped,
        ],
        within,
        dir,
      );
      verdict.pixels = {
        ok: judged.ok,
        code: judged.code,
        pixelAgreement: judged.pixelAgreement,
        meanDrift: judged.meanDrift,
        inkPresent: judged.inkPresent,
      };
      if (!judged.ok) {
        verdict.reason = judged.code;
        return verdict;
      }
      verdict.judge = await visionJudge(
        {
          base: base.url,
          logo: job.logoUrl.href,
          candidate: candidateUrl,
          plan,
          pixels: judged,
        },
        within,
      );
      if (!judgePasses(verdict.judge)) {
        verdict.reason = 'JUDGE';
        return verdict;
      }
      verdict.bytes = await readFile(cropped);
      verdict.sha256 = judged.sha256;
      verdict.pass = hash(verdict.bytes) === judged.sha256;
      if (!verdict.pass) verdict.reason = 'INTEGRITY';
      return verdict;
    } catch (error) {
      if (signal.aborted) throw error;
      verdict.reason = error?.code || 'FIT';
      verdict.error = String(error?.message || error).slice(0, 200);
      return verdict;
    } finally {
      verdict.ms = Date.now() - started;
    }
  }

  // Every settlement is told to the site, on the URL this desk builds from SPONSOR_SITE_ORIGIN and
  // the asset id: the request never names a callback address. The promise is registered before
  // anything is awaited, so close() can wait for it.
  function deliver(job, outcome) {
    const url = `${siteOrigin}/api/sponsorship/assets/${job.assetId}?part=look`;
    const headers = {
      authorization: `Bearer ${cfg.token}`,
      'x-look-round': String(job.round),
      'x-look-outcome': outcome.kind,
    };
    let body;
    if (outcome.kind === 'look') {
      headers['content-type'] = 'image/png';
      headers['x-look-sha256'] = outcome.sha256;
      headers['x-look-verdict'] = Buffer.from(
        JSON.stringify(outcome.verdict),
      ).toString('base64');
      body = outcome.bytes;
    } else
      headers['x-look-reason'] = String(outcome.reason || outcome.kind)
        .replace(/[^\x20-\x7e]/g, ' ')
        .slice(0, 300);
    const sending = sendLook(
      url,
      { headers, body },
      {
        attempts: cfg.callbackAttempts,
        timeoutMs: cfg.callbackMs,
        retryMs: cfg.callbackRetryMs,
      },
    )
      .then((status) => {
        log({
          level: status >= 200 && status < 300 ? 'info' : 'warn',
          event: 'tailor',
          key: job.key.slice(0, 12),
          outcome: outcome.kind,
          round: job.round,
          fits: job.fits?.length ?? 0,
          fallback: outcome.verdict?.fallback,
          callback: status,
          ms: Date.now() - job.arrivedAt,
          ...job.stages,
        });
        return status;
      })
      .finally(() => callbacks.delete(sending));
    callbacks.add(sending);
    return sending;
  }

  // The job: fetch the logo, plan the garments, fit up to three times, judge each, then settle
  // with a look or (desk-10) the fallback. Whatever happens, the site hears one outcome.
  async function tailor(job) {
    const signal = job.controller.signal;
    const abandoned = () => new MediaError(503, 'ABANDONED', String(signal.reason));
    let outcome = null,
      dir = null;
    try {
      await prepared;
      dir = await mkdtemp(join(workdir, 'job-'));
      if (signal.aborted) throw abandoned();
      const logo = join(dir, 'logo.png');
      const fetching = AbortSignal.any([
        signal,
        AbortSignal.timeout(
          Math.max(1, Math.min(cfg.logoFetchMs, job.deadlineAt - Date.now())),
        ),
      ]);
      const logoSha256 = await download(job.logoUrl.href, logo, MAX_LOGO, fetching, signal);
      if (logoSha256 !== job.logoSha256)
        throw new MediaError(409, 'LOGO_HASH', 'The logo at the site is not the one this order bought.');
      job.stages.fetchMs = Date.now() - job.startedAt;
      const plan = garmentPlan(job.palette, job.target),
        prompt = tailorPrompt(plan),
        base = BASE_STILLS[job.target];
      for (let fit = 1; fit <= FITS; fit++) {
        if (signal.aborted) throw abandoned();
        // A fit that could not finish with the tail still free for the fallback and the callback
        // is not started; the job settles inside its deadline by construction.
        if (job.deadlineAt - Date.now() < cfg.tailorFitMs + cfg.tailorTailMs) break;
        const verdict = await attemptFit(job, dir, {
          fit,
          seed: seedFor(job.key, fit),
          plan,
          prompt,
          base,
        });
        job.fits.push(verdict);
        if (verdict.pass) {
          outcome = {
            kind: 'look',
            bytes: verdict.bytes,
            sha256: verdict.sha256,
            verdict: {
              model: TAILOR_MODEL,
              fit,
              round: job.round,
              seed: verdict.seed,
              requestId: verdict.requestId,
              palette: job.palette,
              plan,
              judge: verdict.judge,
              pixels: verdict.pixels,
              candidateUrl: verdict.candidateUrl,
              fits: job.fits.map(summarize),
            },
          };
          break;
        }
      }
      if (!outcome) {
        if (signal.aborted) throw abandoned();
        outcome = await fallbackLook(job, dir, logo, plan);
      }
    } catch (error) {
      outcome = signal.aborted
        ? {
            kind: signal.reason === 'shutdown' ? 'shutdown' : 'deadline',
            reason:
              signal.reason === 'shutdown'
                ? 'The desk was restarting.'
                : 'The tailor ran out of time.',
          }
        : { kind: 'error', reason: String(error?.message || error).slice(0, 300) };
      if (!signal.aborted)
        log({
          level: 'error',
          event: 'tailor',
          key: job.key.slice(0, 12),
          stage: 'job',
          code: error?.code,
          error: outcome.reason,
        });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await rememberOutcome(job.key, outcome);
    await deliver(job, outcome);
  }
  // Until desk-10 lands the cap print, three failed fits are an error the site re-requests.
  async function fallbackLook(job) {
    return {
      kind: 'error',
      reason: `No fit passed in ${job.fits.length} attempts.`,
    };
  }

  async function handleTailor(request, url, meta, arrivedAt) {
    let payload;
    try {
      payload = JSON.parse(
        (await bytesLimited(request, MAX_TAILOR_BODY)).toString('utf8'),
      );
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError(400, 'JSON', 'A JSON tailor request is required.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new MediaError(400, 'JSON', 'A JSON tailor request is required.');
    if (typeof payload.assetId !== 'string' || !HEX64.test(payload.assetId))
      throw new MediaError(400, 'ASSET_ID', 'An asset id is required.');
    if (![1, 2, 3].includes(payload.round))
      throw new MediaError(400, 'ROUND', 'A tailor round is 1, 2 or 3.');
    if (!BASE_STILLS[payload.target])
      throw new MediaError(400, 'TARGET', 'Choose a supported host.');
    if (typeof payload.logoSha256 !== 'string' || !HEX64.test(payload.logoSha256))
      throw new MediaError(400, 'LOGO_HASH', 'A logo hash is required.');
    if (!siteOrigin || !cfg.falKey)
      throw new MediaError(
        503,
        'TAILOR_UNAVAILABLE',
        'This desk has no tailor: it needs FAL_KEY and SPONSOR_SITE_ORIGIN.',
      );
    const logoUrl = checkedUrl(payload.logoUrl, 'logo');
    const palette = checkedPalette(payload.palette);
    const projectName =
      typeof payload.projectName === 'string' ? payload.projectName.slice(0, 80) : '';
    const key = tailorKey(payload.logoSha256, payload.target, payload.round);
    meta.key = key.slice(0, 12);
    const order = {
      key,
      assetId: payload.assetId,
      round: payload.round,
      target: payload.target,
      logoUrl,
      logoSha256: payload.logoSha256,
      palette,
      projectName,
    };
    // A key in flight is joined, checked before and after the cache read so two requests that
    // arrive together never make two jobs. A settled key is re-told rather than remade: the site
    // lost a callback, not the look.
    if (tailoring.has(key)) {
      meta.cache = 'join';
      return reply({ key, queued: true }, 202);
    }
    const done = await settledOutcome(key);
    if (done) {
      meta.cache = 'hit';
      void deliver({ ...order, arrivedAt, fits: [], stages: {} }, done);
      return reply({ key, cached: true });
    }
    if (tailoring.has(key)) {
      meta.cache = 'join';
      return reply({ key, queued: true }, 202);
    }
    meta.cache = 'miss';
    admitTailor(order, arrivedAt);
    return reply({ key, queued: true }, 202);
  }
```

4. In `handle`, replace

```js
      const known =
        request.method === 'POST' &&
        ['/preview', '/render', '/logo'].includes(url.pathname);
      if (!known) throw new MediaError(404, 'NOT_FOUND', 'Unknown operation.');
      // A draining desk takes nothing new. BUSY is what the site retries, and by then Railway
      // routes the retry to the replacement.
      if (closing) throw busy(2_000);
```

with

```js
      const known =
        request.method === 'POST' &&
        ['/preview', '/render', '/logo', '/tailor'].includes(url.pathname);
      if (!known) throw new MediaError(404, 'NOT_FOUND', 'Unknown operation.');
      // The tailor answers 409 BUSY in its own words, drain included.
      if (url.pathname === '/tailor')
        return await handleTailor(request, url, meta, arrivedAt);
      // A draining desk takes nothing new. BUSY is what the site retries, and by then Railway
      // routes the retry to the replacement.
      if (closing) throw busy(2_000);
```

5. In `status: () => ({`, replace `tailoring: 0, tailorQueued: 0, callbacks: 0,` with

```js
      tailoring: tailorActive.size,
      tailorQueued: tailorQueue.length,
      callbacks: callbacks.size,
```

6. In `close()`, replace

```js
      // A copy, because settling a job takes it out of the queue.
      for (const job of queue.slice()) abort(job, 'shutdown');
    }
    await settledWithin([...runs, ...previewing], cfg.drainMs);
    for (const job of Array.from(active)) abort(job, 'shutdown');
    await settledWithin([...runs], 2_000);
```

with

```js
      // A copy, because settling a job takes it out of the queue.
      for (const job of queue.slice()) abort(job, 'shutdown');
      // A queued tailor job has cost nothing: the site hears `shutdown` now and asks the
      // replacement desk. A running one gets the drain, then the same word.
      for (const job of tailorQueue.splice(0)) {
        clearTimeout(job.clock);
        tailoring.delete(job.key);
        void rememberOutcome(job.key, { kind: 'shutdown', reason: 'The desk was restarting.' });
        void deliver(job, { kind: 'shutdown', reason: 'The desk was restarting.' });
      }
    }
    await settledWithin([...runs, ...previewing, ...tailorRuns], cfg.drainMs);
    for (const job of Array.from(active)) abort(job, 'shutdown');
    for (const job of Array.from(tailorActive)) job.controller.abort('shutdown');
    // The cut jobs settle at once; their callbacks, and any still leaving, get three seconds.
    await settledWithin([...runs, ...tailorRuns, ...callbacks], 3_000);
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass. Then `npx oxlint broadcast/sponsor-media.mjs` clean.

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "After payment the desk dresses the host: up to three fits, each checked by pixels and by eye, and the look is sent to the site

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-10: the fallback cap print, `refused`, and the other outcomes — every settlement calls back and is remembered

**Files:**
- Modify: `broadcast/sponsor-media.mjs` (inside `createMediaService`: replace the desk-9 stub `fallbackLook`)
- Test: `tests/sponsor-media.test.mjs` (five tests)

**Interfaces:**
- Consumes: `renderer(args, report, signal, dir)` (existing; its `preview` mode is the unmodified qualification-bound `scripts/wearable-render.py preview`), `templates`, `job.fits`, `summarize`, `deliver`, `rememberOutcome` (desk-9); `fakeWardrobe` plans `fallback: 'refuse' | 'crash'`, `previewDelayMs` (desk-4).
- Produces: `fallbackLook(job, dir, logo, plan)` → `{ kind: 'look', bytes, sha256, verdict: { model: 'cap-v1', fit: 0, round, palette, plan, judge: null, candidateUrl: null, fallback: 'cap-v1', fits } }` from `scripts/wearable-render.py preview --manifest public/wearables/<template>.json --asset <logo> --output <png> --report <json>` (blank cap + logo in the front panel, identity matrix, no judge); `{ kind: 'refused', reason }` when the renderer's verdict on the artwork is a 422; a machine fault (503) becomes the `error` outcome. Outcomes `deadline | shutdown | error` carry `x-look-reason` and no body; all of them are cached by key for `cacheTtlMs`.

- [x] **Step 1: Write the failing tests** (append)

```js
void test('three failed fits fall back to the cap print, so the paid order still airs dressed', async (t) => {
  const media = await tailorDesk(t, { judge: 'DRIFT,INK,GEOMETRY' });
  const order = tailorOrder();
  const before = submissions.length;
  assert.equal((await post(media, order, { path: '/tailor' })).status, 202);
  assert.ok(await landed(order.assetId));
  const look = looks.find((l) => l.id === order.assetId);
  assert.equal(look.headers['x-look-outcome'], 'look');
  assert.equal(look.headers['x-look-sha256'], sha(look.body));
  assert.equal(look.body.subarray(8, 12).toString(), 'cap:', 'the fallback is the cap print');
  const verdict = verdictOf(look);
  assert.equal(verdict.fallback, 'cap-v1');
  assert.equal(verdict.model, 'cap-v1');
  assert.equal(verdict.fit, 0);
  assert.equal(verdict.judge, null);
  assert.deepEqual(verdict.fits.map((f) => f.reason), ['DRIFT', 'INK', 'GEOMETRY']);
  assert.equal(submissions.slice(before).filter((s) => s.endpoint === 'fal-ai/nano-banana-pro/edit').length, 3);
  assert.equal(submissions.slice(before).filter((s) => s.endpoint === 'openrouter/router/vision').length, 0, 'the eye was asked about a fit the pixels refused');
  const preview = media.spawns.find((s) => s.mode === 'preview');
  assert.ok(preview, 'the cap renderer was never called');
  const line = media.logs.find((l) => l.event === 'tailor' && l.outcome === 'look');
  assert.equal(line.fallback, 'cap-v1');
  assert.equal(line.fits, 3);
});

void test('a logo the fallback cannot print is refused; a broken renderer is an error the site asks about again', async (t) => {
  const refusing = await tailorDesk(t, { judge: 'DRIFT', fallback: 'refuse' });
  const order = tailorOrder();
  assert.equal((await post(refusing, order, { path: '/tailor' })).status, 202);
  assert.ok(await landed(order.assetId));
  const refused = looks.find((l) => l.id === order.assetId);
  assert.equal(refused.headers['x-look-outcome'], 'refused');
  assert.equal(refused.headers['x-look-round'], '1');
  assert.match(refused.headers['x-look-reason'], /LOGO_TOO_THIN/);
  assert.match(refused.headers['x-look-reason'], /different logo/);
  assert.equal(refused.body.length, 0);
  assert.equal('x-look-sha256' in refused.headers, false);
  // Remembered: the same key is re-told without a fit.
  const before = submissions.length;
  const again = await post(refusing, order, { path: '/tailor' });
  assert.deepEqual(again.json(), { key: tailorKey(order.logoSha256, 'host', 1), cached: true });
  assert.ok(await landed(order.assetId, 2));
  assert.equal(looks.filter((l) => l.id === order.assetId)[1].headers['x-look-outcome'], 'refused');
  assert.equal(submissions.length, before);

  const broken = await tailorDesk(t, { judge: 'DRIFT', fallback: 'crash' });
  const other = tailorOrder();
  assert.equal((await post(broken, other, { path: '/tailor' })).status, 202);
  assert.ok(await landed(other.assetId));
  const errored = looks.find((l) => l.id === other.assetId);
  assert.equal(errored.headers['x-look-outcome'], 'error');
  assert.ok(errored.headers['x-look-reason'].length > 0);
  assert.ok(broken.logs.some((l) => l.event === 'renderer' && l.level === 'error'));
});

void test('a job that runs out of time says deadline, starts no fit it cannot finish, and kills what it was running', async (t) => {
  falPlan.hang = true;
  const media = await tailorDesk(t, { previewDelayMs: 10_000 }, { tailorDeadlineMs: 1_200, tailorFitMs: 300, tailorTailMs: 100, tailorSubmitMs: 250, judgeMs: 50 });
  const order = tailorOrder();
  const started = Date.now();
  assert.equal((await post(media, order, { path: '/tailor' })).status, 202);
  assert.ok(await landed(order.assetId));
  const look = looks.find((l) => l.id === order.assetId);
  assert.equal(look.headers['x-look-outcome'], 'deadline');
  assert.match(look.headers['x-look-reason'], /out of time/);
  assert.ok(Date.now() - started < 4_000, 'the deadline did not cut the fallback');
  const preview = media.spawns.find((s) => s.mode === 'preview');
  assert.ok(preview, 'the fallback never started');
  assert.ok(await until(() => !alive(preview.pid)), 'the renderer outlived the job');
  assert.equal(media.logs.find((l) => l.event === 'tailor').outcome, 'deadline');
  falPlan.hang = false;
  // No scratch left behind.
  assert.ok(await until(async () => !(await readdir(media.workdir)).some((n) => n.startsWith('job-') && !n.startsWith('job-probe-'))));
});

void test('a drain cuts a running tailor with a shutdown callback, hands a queued one back at once, and waits for the callbacks', async (t) => {
  falPlan.hang = true;
  const media = await tailorDesk(t, {}, { tailorConcurrency: 1, tailorQueue: 2, drainMs: 500 });
  const running = tailorOrder(),
    queued = tailorOrder();
  assert.equal((await post(media, running, { path: '/tailor' })).status, 202);
  assert.equal((await post(media, queued, { path: '/tailor' })).status, 202);
  assert.deepEqual(
    [media.service.status().tailoring, media.service.status().tailorQueued],
    [1, 1],
  );
  const started = Date.now();
  await media.close();
  assert.ok(Date.now() - started < 4_000, 'close waited past the drain and the callback window');
  for (const order of [running, queued]) {
    const look = looks.find((l) => l.id === order.assetId);
    assert.ok(look, `${order === running ? 'the running' : 'the queued'} job never called back`);
    assert.equal(look.headers['x-look-outcome'], 'shutdown');
    assert.match(look.headers['x-look-reason'], /restarting/);
  }
  assert.equal(media.service.status().callbacks, 0);
  falPlan.hang = false;
  // The server has stopped listening; the desk itself still answers a late request with BUSY.
  const turnedAway = await media.service.handle(
    new Request('http://desk/tailor', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(tailorOrder()),
    }),
  );
  assert.equal(turnedAway.status, 409);
  assert.equal((await turnedAway.json()).code, 'BUSY');
});

void test('the callback lands only on SPONSOR_SITE_ORIGIN, survives a short outage, and every outcome is remembered', async (t) => {
  const media = await tailorDesk(t);
  // The request may name a callback; the desk ignores it and builds its own from the origin.
  const order = tailorOrder({ callbackUrl: 'http://127.0.0.1:1/steal' });
  siteAnswers = [503];
  assert.equal((await post(media, order, { path: '/tailor' })).status, 202);
  assert.ok(await landed(order.assetId, 2));
  const [first, second] = looks.filter((l) => l.id === order.assetId);
  assert.equal(first.url, `/api/sponsorship/assets/${order.assetId}?part=look`);
  assert.equal(second.headers['x-look-sha256'], first.headers['x-look-sha256']);
  assert.ok(await until(() => media.logs.some((l) => l.event === 'tailor' && l.callback === 200)));
  // A logo the site serves under another id, or from another host, is not fetched.
  const foreign = tailorOrder({ logoUrl: `${FAL}/files/logo.png` });
  const r = await post(media, foreign, { path: '/tailor' });
  assert.equal(r.status, 400);
  assert.equal(r.json().code, 'HOST');
  // A logo whose bytes are not the promised hash is an error, never a look.
  const swapped = tailorOrder();
  logos.set(`/api/sponsorship/assets/${swapped.assetId}`, Buffer.from('not the logo'));
  assert.equal((await post(media, swapped, { path: '/tailor' })).status, 202);
  assert.ok(await landed(swapped.assetId));
  const wrong = looks.find((l) => l.id === swapped.assetId);
  assert.equal(wrong.headers['x-look-outcome'], 'error');
  assert.match(wrong.headers['x-look-reason'], /not the one this order bought/);
  const before = submissions.length;
  assert.deepEqual((await post(media, swapped, { path: '/tailor' })).json(), { key: tailorKey(swapped.logoSha256, 'host', 1), cached: true });
  assert.ok(await landed(swapped.assetId, 2));
  assert.equal(submissions.length, before, 'a remembered error bought a fit');
  siteAnswers = [];
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: the fallback test FAILS (`x-look-outcome` is `'error'`, no `preview` spawn); the refused test FAILS the same way; deadline, drain and callback tests pass or fail on the fallback path only.

- [x] **Step 3: Implement** — replace the desk-9 stub

```js
  // Until desk-10 lands the cap print, three failed fits are an error the site re-requests.
  async function fallbackLook(job) {
    return {
      kind: 'error',
      reason: `No fit passed in ${job.fits.length} attempts.`,
    };
  }
```

with

```js
  // Three fits failed: the deterministic cap print, exactly as /preview makes it today (the blank
  // cap, the logo in its front panel, identity matrix; an unmodified call into the renderer the
  // trials qualified). The order still airs dressed; the site offers a better logo. The renderer's
  // verdict on the artwork (422) is final for this logo; a fault of this machine is not.
  async function fallbackLook(job, dir, logo, plan) {
    const signal = job.controller.signal;
    const output = join(dir, 'fallback.png'),
      report = join(dir, 'report.json');
    const started = Date.now();
    try {
      await renderer(
        [
          'preview',
          '--manifest',
          `public/wearables/${templates[job.target]}.json`,
          '--asset',
          logo,
          '--output',
          output,
          '--report',
          report,
        ],
        report,
        signal,
        dir,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (error?.status === 422)
        return {
          kind: 'refused',
          reason: `This logo could not be printed on the cap (${error.code}).`,
        };
      throw error;
    } finally {
      job.stages.fallbackMs = Date.now() - started;
    }
    const bytes = await readFile(output);
    return {
      kind: 'look',
      bytes,
      sha256: hash(bytes),
      verdict: {
        model: 'cap-v1',
        fit: 0,
        round: job.round,
        palette: job.palette,
        plan,
        judge: null,
        candidateUrl: null,
        fallback: 'cap-v1',
        fits: job.fits.map(summarize),
      },
    };
  }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: all pass, on a box with or without cv2 (these desks use the stand-in). Then `npx oxlint broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs`.

- [x] **Step 5: Commit**

```bash
git add broadcast/sponsor-media.mjs tests/sponsor-media.test.mjs
git commit -m "A logo the tailor cannot fit three times still airs on the cap, and every outcome reaches the site

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-11: the image ships `scripts/wardrobe.py` and the two uncropped stills; the upload test proves every path the desk names is uploaded

**Files:**
- Modify: `broadcast/Dockerfile.sponsor-media:8-23`
- Test: `tests/railway.test.mjs:452-462` (the "named outright" list), plus one new test

**Interfaces:**
- Consumes: `media.uploadFiles('media')` (`scripts/media.mjs`), `BASE_STILLS` paths and the `'scripts/….py'` literals in the desk (desk-5).
- Produces: the media image contains `scripts/wardrobe.py`, `public/pepe-cartoon.png`, `public/gigachad-cartoon.png` beside what it had.

- [x] **Step 1: Write the failing test**

In `tests/railway.test.mjs`, in the test `'the media upload is exactly what its Dockerfile copies…'`, extend the list

```js
  for (const needed of [
    'broadcast/sponsor-media.mjs',
    'scripts/wearable-render.py',
    'scripts/wearable_panel.py',
```

to

```js
  for (const needed of [
    'broadcast/sponsor-media.mjs',
    'scripts/wearable-render.py',
    'scripts/wearable_panel.py',
    'scripts/wardrobe.py',
    'public/pepe-cartoon.png',
    'public/gigachad-cartoon.png',
```

and add after that test:

```js
void test('every Python script the desk spawns, and every still it judges against, is in the media upload', async () => {
  const desk = await readFile(join(REPO, 'broadcast/sponsor-media.mjs'), 'utf8');
  const scripts = new Set([...desk.matchAll(/'(scripts\/[\w-]+\.py)'/g)].map((m) => m[1]));
  const stills = new Set([...desk.matchAll(/'(public\/[\w-]+\.png)'/g)].map((m) => m[1]));
  assert.ok(scripts.has('scripts/wardrobe.py') && scripts.has('scripts/wearable-render.py'));
  assert.ok(stills.has('public/pepe-cartoon.png') && stills.has('public/gigachad-cartoon.png'));
  const files = await media.uploadFiles('media');
  for (const path of [...scripts, ...stills])
    assert.ok(files.includes(path), `${path} is named by the desk but not uploaded`);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/railway.test.mjs`
Expected: FAIL — `scripts/wardrobe.py is uploaded` and `scripts/wardrobe.py is named by the desk but not uploaded`.

- [x] **Step 3: Update the Dockerfile**

Replace

```
COPY broadcast/sponsor-media.mjs broadcast/sponsor-media.mjs
COPY scripts/wearable-render.py scripts/wearable_panel.py scripts/
COPY public/wearables public/wearables
```

with

```
COPY broadcast/sponsor-media.mjs broadcast/sponsor-media.mjs
COPY scripts/wearable-render.py scripts/wearable_panel.py scripts/wardrobe.py scripts/
COPY public/wearables public/wearables
# The tailor judges every fit against the uncropped stills fal is shown; they ship beside the caps.
COPY public/pepe-cartoon.png public/gigachad-cartoon.png public/
```

and after the tini comment block (before `RUN apt-get update`) add:

```
# A tailor job may run 210 s, longer than the drain (100 s; SHUTDOWN_MS 105 s; drainingSeconds
# 120 in broadcast/railway.sponsor-media.json). A deploy that lands mid-fit aborts that fit, the
# desk sends the site a `shutdown` callback, and the site asks again within a minute. At most one
# fit (about $0.15) is lost per collision; the paid order is never lost.
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/railway.test.mjs`
Expected: all pass (`names.length < 40` still holds: 19 files).

- [x] **Step 5: Commit**

```bash
git add broadcast/Dockerfile.sponsor-media tests/railway.test.mjs
git commit -m "The media image carries the tailor's script and the stills it judges against

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-12: `scripts/media.mjs` — `setup` gives the desk `FAL_KEY`, `status` shows it, `health` reads `tailor`

**Files:**
- Modify: `scripts/media.mjs:1-15` (header), `:210-223` (`mediaVariables`), `:293-301` (`setup`), `:440-453` (`status`), `:487-496` (`health`)
- Test: `tests/railway.test.mjs:578-605` (setup variables), `:782-804` (health), one new test

**Interfaces:**
- Consumes: `devVar('FAL_KEY')` (`scripts/devvars.mjs`); desk `/health` `{ ready, tailor, templateVersion }` (desk-5).
- Produces: `mediaVariables(env, token, falKey)` adds `FAL_KEY`; `setup` throws `FAL_KEY is missing from .dev.vars…` before touching Railway; `status` prints `tailor     FAL_KEY set|not set`; `health` prints `Ready to tailor looks.` or `Up, but FAL_KEY is missing or fal did not answer, so the cap stays off sale.` and still returns `ready`.

- [x] **Step 1: Write the failing tests**

In `tests/railway.test.mjs`, in `'setup gives both devnet services their own tokens…'`, replace

```js
    {
      SPONSOR_MEDIA_TOKEN: 'x',
      SPONSOR_SITE_ORIGIN: STAGING,
      MEDIA_CONCURRENCY: '2',
```

with

```js
    {
      SPONSOR_MEDIA_TOKEN: 'x',
      SPONSOR_SITE_ORIGIN: STAGING,
      FAL_KEY: 'fal-keep-me',
      MEDIA_CONCURRENCY: '2',
```

Replace the test `'health reads the media service report and says whether a cap can sell'` with:

```js
void test('health reads the media service report and says whether a look can be tailored', async () => {
  const vars = `${BOX_VARS}SPONSOR_MEDIA_URL_DEVNET=https://media.example\n`;
  const report = { ready: true, tailor: true, templateVersion: 'looks-v1' };
  await fresh({ vars, mediaHealth: { status: 200, body: report } });
  const ok = await quietly(() => media.health('devnet', { reconciler: false }));
  assert.equal(ok.result, true);
  assert.match(ok.printed, /Ready to tailor looks/);
  assert.equal(calls[0].media, 'https://media.example/health');

  await fresh({ vars, mediaHealth: { status: 200, body: { ...report, tailor: false } } });
  const noKey = await quietly(() => media.health('devnet', { reconciler: false }));
  assert.equal(noKey.result, true, 'the desk is up; only the cap is off sale');
  assert.match(noKey.printed, /FAL_KEY is missing or fal did not answer/);

  await fresh({ vars, mediaHealth: { status: 200, body: { ...report, ready: false } } });
  const down = await quietly(() => media.health('devnet', { reconciler: false }));
  assert.equal(down.result, false);
  assert.match(down.printed, /Not ready/);
});

void test('setup refuses to make a desk without the tailor’s key, and creates nothing', async () => {
  await fresh({ vars: BOX_VARS.replace('FAL_KEY=fal-keep-me\n', '') });
  await assert.rejects(quietly(() => media.setup('devnet')), /FAL_KEY is missing/);
  assert.equal(gqlCalls(/serviceCreate/).length, 0);
  assert.equal(gqlCalls(/variableCollectionUpsert/).length, 0);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/railway.test.mjs`
Expected: the setup deepEqual FAILS (no `FAL_KEY`), the health test FAILS on `/Ready to tailor looks/`, the refusal test FAILS (setup resolves).

- [x] **Step 3: Implement**

In `scripts/media.mjs`:

1. Header lines 12–15: replace

```js
// sponsor-media-<env> normalizes logos, previews caps and composites the paid take; the site
// calls it with a shared token and stores what it returns. sponsor-reconcile-<env> asks the site
```

with

```js
// sponsor-media-<env> normalizes logos and, once an order is paid, tailors the host's look with
// fal (it alone holds FAL_KEY; the Worker never does); the site calls it with a shared token and
// stores what it sends back. sponsor-reconcile-<env> asks the site
```

2. `mediaVariables`:

```js
/** What the media service is told. MEDIA_CONCURRENCY and MEDIA_QUEUE bound its render desk. */
export function mediaVariables(env, token, falKey) {
  const port = String(MEDIA_PORT);
  return {
    SPONSOR_MEDIA_TOKEN: token,
    SPONSOR_SITE_ORIGIN: SITES[checkEnv(env)].origin,
    // The tailor's key: the desk dresses the host with fal. Only the desk holds it.
    FAL_KEY: falKey,
    MEDIA_CONCURRENCY: '2',
    MEDIA_QUEUE: '6',
    // Railway's healthcheck and the public address both go to PORT. The image has always read
    // SPONSOR_MEDIA_PORT, so both names carry the one number and can never disagree.
    PORT: port,
    SPONSOR_MEDIA_PORT: port,
  };
}
```

3. In `setup`, replace

```js
  // Secrets first: a bad value in .dev.vars stops setup before Railway has anything half-made.
  const mediaVars = mediaVariables(
    env,
    await secret(`SPONSOR_MEDIA_TOKEN_${key}`),
  );
```

with

```js
  // Secrets first: a bad value in .dev.vars stops setup before Railway has anything half-made.
  const falKey = await devVar('FAL_KEY');
  if (!falKey)
    throw Error(
      `FAL_KEY is missing from ${VARS}. The media desk tailors looks with it; add the studio's key and run setup again.`,
    );
  const mediaVars = mediaVariables(
    env,
    await secret(`SPONSOR_MEDIA_TOKEN_${key}`),
    falKey,
  );
```

4. In `status`, after the `token` console.log block (ends `);` after the ternary) add:

```js
    if (role === 'media')
      console.log(
        `  tailor     ${vars.FAL_KEY ? 'FAL_KEY set' : 'FAL_KEY not set: run setup'}`,
      );
```

5. In `health`, replace

```js
  else if (report.capQualified !== true)
    console.error(
      '\nUp, but no cap has passed qualification, so the cap stays off sale.',
    );
  else console.log('\nReady to sell caps.');
```

with

```js
  else if (report.tailor !== true)
    console.error(
      '\nUp, but FAL_KEY is missing or fal did not answer, so the cap stays off sale.',
    );
  else console.log('\nReady to tailor looks.');
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/railway.test.mjs`
Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add scripts/media.mjs tests/railway.test.mjs
git commit -m "Setting up the media desk hands it the tailor's key, and health says whether looks can be made

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task desk-13: the CLI stays one JSON object per line through a tailor, boot says `tailor`, SIGTERM still exits 0

**Files:**
- Test: `tests/sponsor-media.test.mjs` (one test; no source change expected — this pins the process contract)

**Interfaces:**
- Consumes: `configFromEnv` (`FAL_KEY`, `SPONSOR_MEDIA_TEST_FAL_HOST`), the boot log line (desk-5), `/tailor` (desk-9/10), the `site`/`falQueue` stand-ins.
- Produces: nothing new; a regression guard that the tailor writes to stdout only through `log()`.

- [x] **Step 1: Write the test** (append)

```js
void test('the desk process tailors a look with every stdout line a JSON object, and never prints its key', async (t) => {
  const port = await freePort();
  const workdir = await mkdtemp(join(scratch, 'cli-tailor-'));
  const judgeFile = join(scratch, 'cli-judge.txt');
  await writeFile(judgeFile, 'pass');
  const python = await fakeWardrobe('cli-wardrobe', { judgeFile });
  const child = spawn(process.execPath, ['broadcast/sponsor-media.mjs'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      SPONSOR_MEDIA_WORKDIR: workdir,
      SPONSOR_MEDIA_TOKEN: TOKEN,
      SPONSOR_SITE_ORIGIN: SITE,
      FAL_KEY: 'fal-cli-key',
      WEARABLE_PYTHON: python,
      NODE_ENV: 'test',
      SPONSOR_MEDIA_TEST_VIDEO_HOST: FAL,
      SPONSOR_MEDIA_TEST_FAL_HOST: FALQ,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill('SIGKILL'));
  const raw = [],
    lines = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    raw.push(line);
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push({ event: 'NOT_JSON', line });
    }
  });
  const exited = new Promise((done) => child.once('close', done));
  assert.ok(await until(() => lines.some((l) => l.event === 'boot'), 20_000), 'the desk never booted');
  const boot = lines.find((l) => l.event === 'boot');
  assert.equal(boot.ready, true);
  assert.equal(boot.tailor, true);
  assert.equal(boot.templateVersion, 'looks-v1');
  assert.equal('capQualified' in boot, false);
  const media = { url: `http://127.0.0.1:${port}` };
  const order = tailorOrder();
  const r = await post(media, order, { path: '/tailor' });
  assert.equal(r.status, 202, r.bytes.toString());
  assert.ok(await landed(order.assetId), 'the process never called the site back');
  assert.ok(await until(() => lines.some((l) => l.event === 'tailor' && l.outcome === 'look'), 10_000));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(lines.some((l) => l.event === 'stopped'));
  assert.deepEqual(lines.filter((l) => l.event === 'NOT_JSON'), [], 'something wrote to stdout past log()');
  for (const line of raw) {
    assert.ok(!line.includes('fal-cli-key'), 'the key was printed');
    assert.ok(!line.includes(TOKEN), 'the token was printed');
  }
  const request = lines.find((l) => l.event === 'request' && l.path === '/tailor');
  assert.equal(request.status, 202);
  assert.equal(request.key, tailorKey(order.logoSha256, 'host', 1).slice(0, 12));
});
```

- [x] **Step 2: Run the test to verify it passes**

Run: `node --test tests/sponsor-media.test.mjs`
Expected: PASS. If `NOT_JSON` lines appear, some path in the tailor writes to stdout directly (a `console.log`, or a stand-in that inherited stdout): route it through `log()` and rerun — that is the point of this guard.

- [x] **Step 3: Run the whole suite and the linter**

Run: `npm test && npx oxlint broadcast/sponsor-media.mjs scripts/media.mjs tests/sponsor-media.test.mjs tests/railway.test.mjs && work/vision-venv/bin/python tests/wardrobe.test.py`
Expected: every suite green; the runtime-bound tests skip on a box without cv2 and run on the studio machine and in CI.

- [x] **Step 4: Commit**

```bash
git add tests/sponsor-media.test.mjs
git commit -m "The desk's log stays machine-readable through a tailor, with no key on it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Section self-review

- Spec §1.1 `/logo`: desk-1, desk-2, desk-4 (codes, 4 MiB, target, ≤ 10 s via `logoMs`, no fal).
- Spec §1.2 `/tailor`: desk-9 (validation codes, 202/200/409, key formula, join in flight, the desk builds the callback URL itself — the `callbackUrl` field in a request is ignored, desk-10 test).
- Spec §1.3 steps 1–8: logo fetch + hash (desk-9), garment plan table incl. monochrome and wearer camouflage (desk-6), fit request shape and fixed prompt (desk-6/9), geometry never resized (desk-3), deterministic judge (desk-3), vision judge request and pass rule (desk-9), fallback via `preview` unmodified (desk-10), callback headers/retries/close bound (desk-8/9/10).
- `/health` `tailor` + `templateVersion`, `capQualified` gone, boot log (desk-5). Files shipped + `serviceVersion` + upload test (desk-5, desk-11). `FAL_KEY` as a desk variable (desk-12). Drain comment (desk-11). CLI stdout (desk-13). Fit budget arithmetic (desk-9 test).
- Not touched: `scripts/wearable-render.py`, `scripts/wearable_panel.py`, `public/wearables/*`. `/render` and `/preview` untouched and their tests keep running; deleting them is the follow-up named in the spec's Out of scope, once the new path has aired on devnet.
- Type consistency: the verdict shape `{ model, fit, round, seed, requestId, palette, plan, judge, pixels, candidateUrl, fits, fallback? }` is produced in desk-9/10 and read by the same names in every test; `LookPalette` field names match CONTRACT; `pixels` carries `pixelAgreement`/`meanDrift`/`inkPresent` from the Python.


---

## Part B: Site — gates, upload, settle trigger, callback, reconciler, serving, receipt (site-1 … site-17)

**Spec:** `docs/superpowers/specs/2026-09-13-tailored-wardrobe-design.md` §2 (the site), §2.5 health plumbing, "Tests → Site", "Retired". **Contract:** `scratchpad/plan/CONTRACT.md` — every name below is copied from it.

**What this section builds.** After payment the site asks the media desk to tailor one look per (logo, character), records what each round came to, serves the logo and the looks for good, gates every stage of a cap order on where its look stands, and hands the studio a look it can pin every dressed shot to. Before payment the site only normalises the logo through the desk's `/logo`. The tracker-era `renderSponsorMedia` path is retired last.

**File map (this section only).**

| File | Responsibility after this section |
| --- | --- |
| `lib/sponsorship.ts` | `LOOK_VERSION`, `LookPalette`, `LookTailorState`, `LookAssetMetadata`, `SponsorLook`; `SponsorReceipt.look`; draft copy "Add your logo first." |
| `lib/sponsor-db.ts` | `settlePayment` → `{ orderId, orderPaidNow }`; `markTailorRequested`, `applyLook`, `assetOnAir`, `tailorProbe`; lease SQL untouched |
| `lib/sponsor-server.ts` | `SponsorMediaVars` + `sponsorMediaConfig` (moved here); `qualifiedSponsorAsset(d, draft, caps, stage)`; `requestTailor`; `replaceLogo` action; receipt `look`; reconciler tailor probe; `recoverAttempt` calls the tailor once |
| `lib/sponsor-assets.ts` | upload through desk `/logo`; `readSponsorAsset` parts `logo` / `look&v=` + bare 302 / JSON; `receiveLook` (PUT); `MediaHealth.tailor` |
| `app/api/sponsorship/assets/[id]/route.ts` | `GET` + `PUT` |
| `app/api/sponsorship/route.ts`, `app/api/sponsorship/reconcile/route.ts` | cast `env` to `SponsorMediaVars` |
| `lib/sponsor-delivery-client.ts` | heartbeat `cap: ready && tailor`, `capTemplateVersion` |
| `scripts/sponsorpay.mjs` | gates on `health.tailor`; accepts a `logo` upload; waits for the look |
| `.github/workflows/media.yml` | gates on `ready && templateVersion === 'looks-v1'` (+ `tailor` with `FAL_KEY`); smoke-tests `/logo` |
| Retired | `lib/sponsor-media.ts`, `app/api/sponsorship/media/route.ts`, `tests/sponsor-render.test.mjs` (its live `ASSET` assertions move first, site-5) |

**Test conventions used throughout.** `node:test` + `node:assert/strict`, `.mjs`, built through `tests/build.mjs`. `tests/sponsorship-server.test.mjs` and `tests/sponsorship-db.test.mjs` carry their own `database()` fake; `tests/sponsor-assets.test.mjs` uses `tests/fixtures/d1.mjs`. New tests are **appended at the end of each file** unless a task says otherwise (the server test's `rowsWritten`/`quoted` helpers are defined mid-file at line 828, so anything using them must come after). Run one file with `node --test tests/<file>`.

**Concurrent edits.** Another session was editing `lib/sponsor-db.ts`, `lib/sponsor-server.ts`, `tests/sponsorship-db.test.mjs`, `tests/sponsorship-server.test.mjs` and `scripts/sponsorpay.mjs` while this section was written (it added `tests/fixtures/sponsor-orders.mjs` with `capDraft`/`capAttempt`/`capOrder`/`paidCap`, replaced `capAhead` with `queueStanding`, and restructured `reconcileSponsorships`). Line numbers below are from 2026-09-13 and will drift: **anchor every edit on the quoted code, re-read the file first, never rewrite a file whole, and never run a formatter on it.** The snippets match the tree as of the last read; if a quoted anchor is gone, stop and re-anchor on the same function by name.

**Two decisions the spec leaves to the implementer, taken here.**
1. The reconciler's fallback-upgrade rule and the callback's upgrade relaxation both use the same guard: *no order wearing the asset is `leased`/`prepared`/`playing`* (`assetOnAir`). A `fulfilled` earlier order therefore does not block an upgrade for a later buyer of the same logo.
2. A spotlight logo (`kind: 'logo'`) also goes through the desk's `/logo` (the only image codec left) and is stored `qualified` at once, id `sha256(JSON.stringify([logoSha256, 'logo', LOOK_VERSION]))`; the cap id is exactly the contract's `[logoSha256, target, LOOK_VERSION]`.

**Task order.** site-1 → site-2 → site-3 → site-4 → site-5 → site-6 → site-7 → site-8 → site-9 → site-10 → site-11 → site-12 → site-13 → site-14 → site-15 → site-16 → site-17. site-17 (retirement) additionally waits for the show section's `lib/services.ts` change (the studio stops posting to `/api/sponsorship/media`).

---

### Task site-1: One wardrobe version and the look types

**Files:**
- Modify: `lib/sponsorship.ts:6` (insert after), `lib/sponsorship.ts:56-71` (`SponsorReceipt`), `lib/sponsorship.ts:296-297` (draft copy)
- Test: `tests/sponsorship.test.mjs:13-24` (existing assertion) + append

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `lib/sponsorship.ts`):
  - `export const LOOK_VERSION = 'looks-v1' as const;`
  - `export type LookPalette = { clusters: { hex: string; share: number }[]; primary: string; secondary: string; accent: string; monochrome: boolean };`
  - `export type LookTailorState = { round: number; requestedAt: number; outcome?: 'look' | 'refused' | 'deadline' | 'shutdown' | 'error'; at?: number; reasons?: string[] };`
  - `export type LookAssetMetadata = { kind: 'cap'; target: 'host' | 'guest'; templateVersion: typeof LOOK_VERSION; logoSha256: string; logoUrl: string; palette: LookPalette; sourceUrl?: string; sha256?: string; look?: { sha256: string; model: string; fit: number; round: number; verdict: unknown; fallback?: 'cap-v1' }; tailor?: LookTailorState; reason?: string };`
  - `export type SponsorLook = { status: 'tailoring' | 'ready' | 'refused'; url?: string; reason?: string; fallback?: 'cap-v1'; round?: number };`
  - `SponsorReceipt.look?: SponsorLook`
  - `validateSponsorDraft` cap-without-asset error text: `'Add your logo first.'`

- [x] **Step 1: Write the failing test**

In `tests/sponsorship.test.mjs`, change the first assertion of the existing test `'validates immutable drafts before money movement'` (line 23) from `/asset/i` to the new copy, and append a test for the constant:

```js
// line 23, inside the first assert.throws of 'validates immutable drafts before money movement':
    /Add your logo first\./,
```

```js
void test('the wardrobe has one version string, and a cap draft asks for a logo in plain words', () => {
  assert.equal(s.LOOK_VERSION, 'looks-v1');
  assert.throws(
    () =>
      s.validateSponsorDraft({
        product: 'cap',
        projectName: 'Game',
        message: 'Hello everyone',
        name: 'Joe',
        target: 'host',
      }),
    /Add your logo first\./,
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship.test.mjs`
Expected: FAIL — `validates immutable drafts before money movement` (message is still "Upload and qualify a cap asset first.") and the new test (`s.LOOK_VERSION` is `undefined`).

- [x] **Step 3: Write minimal implementation**

In `lib/sponsorship.ts`, insert after line 6 (`export type SponsorTarget = 'host' | 'guest';`):

```ts
/** The wardrobe revision every look, asset id and studio heartbeat is pinned to. */
export const LOOK_VERSION = 'looks-v1' as const;
export type LookPalette = {
  clusters: { hex: string; share: number }[];
  primary: string;
  secondary: string;
  accent: string;
  monochrome: boolean;
};
export type LookTailorState = {
  round: number;
  requestedAt: number;
  outcome?: 'look' | 'refused' | 'deadline' | 'shutdown' | 'error';
  at?: number;
  reasons?: string[];
};
/** `sponsor_assets.metadata` for a cap asset: one row per (normalised logo, character). */
export type LookAssetMetadata = {
  kind: 'cap';
  target: SponsorTarget;
  templateVersion: typeof LOOK_VERSION;
  logoSha256: string;
  logoUrl: string;
  palette: LookPalette;
  /** Present once qualified: the look URL and the look's sha256. */
  sourceUrl?: string;
  sha256?: string;
  look?: {
    sha256: string;
    model: string;
    fit: number;
    round: number;
    verdict: unknown;
    fallback?: 'cap-v1';
  };
  tailor?: LookTailorState;
  reason?: string;
};
/** Where a cap order's look stands, as the receipt tells the buyer. */
export type SponsorLook = {
  status: 'tailoring' | 'ready' | 'refused';
  url?: string;
  reason?: string;
  fallback?: 'cap-v1';
  round?: number;
};
```

In `SponsorReceipt` (lines 56-71), add after `capAhead?: number | null;`:

```ts
  /** For a cap order: tailoring, ready (fallback or not), or refused. */
  look?: SponsorLook;
```

At lines 296-297 replace the cap error:

```ts
    if (typeof d.assetId !== 'string' || !d.assetId)
      throw new SponsorError(400, 'Add your logo first.');
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship.test.mjs`
Expected: PASS (all tests in the file).

- [x] **Step 5: Commit**

```bash
git add lib/sponsorship.ts tests/sponsorship.test.mjs
git commit -m "Name the tailored look: one wardrobe version, and a cap draft asks for a logo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-2: A settled payment says whether it is the one that paid the order

**Files:**
- Modify: `tests/fixtures/d1.mjs:26-37`, `tests/sponsorship-db.test.mjs:37-48`, `tests/sponsorship-server.test.mjs:43-54` (the three `batch` fakes: report `meta.changes` per statement, as D1 does)
- Modify: `lib/sponsor-db.ts:283-323` (`settlePayment`)
- Test: `tests/sponsorship-db.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `settlePayment(d: D1Database, attemptId: string, p: { signature: string; payer: string; blockTime: number }, now: number): Promise<{ orderId: string; orderPaidNow: boolean }>` — `orderPaidNow` is `meta.changes === 1` on the order UPDATE (second statement of the batch). Test fakes' `batch()` now returns `{ results, meta: { changes } }` per statement.

- [x] **Step 1: Write the failing test**

Append to `tests/sponsorship-db.test.mjs`:

```js
void test('settlement says whether this is the payment that paid the order', async () => {
  const d = await fixture();
  const first = await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  assert.deepEqual(first, { orderId: 'order', orderPaidNow: true });
  // The same proof again, and a late second transfer: recorded, but they paid nothing new.
  const again = await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  assert.deepEqual(again, { orderId: 'order', orderPaidNow: false });
  const late = await db.settlePayment(
    d,
    'a1',
    { signature: 'sig2', payer: 'payer', blockTime: 151 },
    301,
  );
  assert.deepEqual(late, { orderId: 'order', orderPaidNow: false });
  assert.equal(
    d.sql.prepare('SELECT count(*) n FROM sponsor_payments').get().n,
    2,
    'both transfers are still on record',
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-db.test.mjs`
Expected: FAIL — `settlement says whether this is the payment that paid the order`: `deepEqual(undefined, { orderId: 'order', orderPaidNow: true })`.

- [x] **Step 3: Write minimal implementation**

Replace the `batch` method in all three fakes with this (same text in `tests/fixtures/d1.mjs`, `tests/sponsorship-db.test.mjs`, `tests/sponsorship-server.test.mjs`):

```js
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) {
          const result = await s.all();
          // D1 reports the rows each statement changed; settlePayment reads it.
          out.push({
            ...result,
            meta: { changes: sql.prepare('SELECT changes() AS n').get().n },
          });
        }
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
```

In `lib/sponsor-db.ts` replace `settlePayment` (lines 283-323) with:

```ts
export async function settlePayment(
  d: D1Database,
  attemptId: string,
  p: { signature: string; payer: string; blockTime: number },
  now: number,
): Promise<{ orderId: string; orderPaidNow: boolean }> {
  const rows = await d.batch([
    d
      .prepare(
        `INSERT OR IGNORE INTO sponsor_payments(signature,attempt_id,order_id,payer,block_time,verified_at) SELECT ?,id,order_id,?,?,? FROM sponsor_payment_attempts WHERE id=?`,
      )
      .bind(p.signature, p.payer, p.blockTime, now, attemptId),
    d
      .prepare(
        `UPDATE sponsor_orders SET paid_attempt_id=?,paid_signature=?,payer=?,paid_at=?,status='paid',updated_at=? WHERE paid_attempt_id IS NULL AND status IN ('draft','payment-pending') AND id=(SELECT order_id FROM sponsor_payment_attempts WHERE id=?) AND EXISTS(SELECT 1 FROM sponsor_payments WHERE signature=? AND attempt_id=?)`,
      )
      .bind(
        attemptId,
        p.signature,
        p.payer,
        now,
        now,
        attemptId,
        p.signature,
        attemptId,
      ),
    d
      .prepare(
        `UPDATE sponsor_payments SET is_late=0 WHERE signature=? AND attempt_id=? AND EXISTS(SELECT 1 FROM sponsor_orders WHERE paid_signature=? AND paid_attempt_id=?)`,
      )
      .bind(p.signature, attemptId, p.signature, attemptId),
    d
      .prepare(
        `UPDATE sponsor_payment_attempts SET status='verified',verified_signature=COALESCE(verified_signature,?) WHERE id=? AND EXISTS(SELECT 1 FROM sponsor_payments WHERE signature=? AND attempt_id=?)`,
      )
      .bind(p.signature, attemptId, p.signature, attemptId),
    // A second transfer to an order that is already paid never delivers a second placement,
    // and there are no refunds: it stays recorded in sponsor_payments with is_late=1, which is
    // the whole record of it.
  ]);
  // The order UPDATE changes one row the first time a proof pays the order, and none for a
  // replay or a late second transfer. That one moment is what starts the tailor.
  const attempt = await d
    .prepare('SELECT order_id FROM sponsor_payment_attempts WHERE id=?')
    .bind(attemptId)
    .first<{ order_id: string }>();
  return {
    orderId: attempt?.order_id ?? '',
    orderPaidNow: rows[1]?.meta?.changes === 1,
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-db.test.mjs tests/sponsorship-server.test.mjs tests/sponsor-assets.test.mjs tests/sponsor-context.test.mjs`
Expected: PASS (the three fakes still satisfy every existing test).

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-db.ts tests/sponsorship-db.test.mjs tests/sponsorship-server.test.mjs tests/fixtures/d1.mjs
git commit -m "A settled payment says whether it is the one that paid the order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-3: Record what each tailor round came to

**Files:**
- Modify: `lib/sponsor-db.ts:3-12` (imports), append after `getAsset` (line 179)
- Test: `tests/sponsorship-db.test.mjs` (append helpers + tests)

**Interfaces:**
- Consumes: `LookAssetMetadata`, `LookTailorState` from `lib/sponsorship.ts` (site-1); `getAsset`, `SponsorError`.
- Produces (exported from `lib/sponsor-db.ts`):
  - `markTailorRequested(d: D1Database, assetId: string, tailor: LookTailorState): Promise<void>` — one UPDATE, writes `metadata.tailor` whole.
  - `assetOnAir(d: D1Database, assetId: string): Promise<boolean>` — an order naming the asset is `leased`/`prepared`/`playing`.
  - `export type LookOutcome = { kind: 'look'; sha256: string; url: string; sourceUrl: string; look: NonNullable<LookAssetMetadata['look']>; round: number } | { kind: 'refused'; reason: string; round: number } | { kind: 'deferred'; outcome: 'deadline' | 'shutdown' | 'error'; round: number };`
  - `applyLook(d: D1Database, id: string, outcome: LookOutcome): Promise<string>` — returns the resulting `status`. Transitions: `logo → qualified`, `logo → refused`, `refused → qualified`, fallback look → real fit (while `!assetOnAir`); a `qualified` asset otherwise never changes; idempotent per sha256 and per round.

- [x] **Step 1: Write the failing test**

Append to `tests/sponsorship-db.test.mjs`:

```js
// ---- looks: one sponsor_assets row per (logo, character), moved along by the tailor's callbacks.
const ASSET = 'a'.repeat(64);
const LOOK_SHA = 'b'.repeat(64);
const PALETTE = {
  clusters: [{ hex: '#112233', share: 1 }],
  primary: '#112233',
  secondary: '#112233',
  accent: '#112233',
  monochrome: false,
};
const logoMeta = (extra = {}) => ({
  kind: 'cap',
  target: 'host',
  templateVersion: 'looks-v1',
  logoSha256: 'c'.repeat(64),
  logoUrl: `https://show.test/api/sponsorship/assets/${ASSET}?part=logo`,
  palette: PALETTE,
  ...extra,
});
function insertAsset(d, status, meta, createdAt = 100) {
  d.sql
    .prepare(
      'INSERT OR REPLACE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
    )
    .run(ASSET, status, meta.logoUrl, 'image/png', createdAt, JSON.stringify(meta));
}
const readAsset = (d) => {
  const row = d.sql.prepare('SELECT * FROM sponsor_assets WHERE id=?').get(ASSET);
  return { ...row, metadata: JSON.parse(row.metadata) };
};
const lookUrl = (sha) =>
  `https://show.test/api/sponsorship/assets/${ASSET}?part=look&v=${sha}`;
const look = (sha, extra = {}) => ({
  kind: 'look',
  sha256: sha,
  url: lookUrl(sha),
  sourceUrl: lookUrl(sha),
  look: {
    sha256: sha,
    model: 'fal-ai/nano-banana-pro/edit',
    fit: 1,
    round: 1,
    verdict: { judge: 'ok' },
    ...extra,
  },
  round: 1,
});

void test('a tailor request is written whole, once per round', async () => {
  const d = await fixture();
  insertAsset(d, 'logo', logoMeta());
  await db.markTailorRequested(d, ASSET, { round: 1, requestedAt: 500 });
  assert.deepEqual(readAsset(d).metadata.tailor, { round: 1, requestedAt: 500 });
  await db.markTailorRequested(d, ASSET, {
    round: 2,
    requestedAt: 900,
    reasons: ['blurry'],
  });
  const { metadata } = readAsset(d);
  assert.deepEqual(metadata.tailor, {
    round: 2,
    requestedAt: 900,
    reasons: ['blurry'],
  });
  assert.equal(metadata.kind, 'cap', 'the rest of the metadata is untouched');
});

void test('a look moves the asset through the allowed transitions and never downgrades a finished one', async () => {
  const d = await fixture();
  insertAsset(d, 'logo', logoMeta({ tailor: { round: 1, requestedAt: 500 } }));
  // A deadline is not a verdict on the logo: the status stays logo, the outcome is recorded.
  assert.equal(
    await db.applyLook(d, ASSET, { kind: 'deferred', outcome: 'deadline', round: 1 }),
    'logo',
  );
  let a = readAsset(d);
  assert.equal(a.status, 'logo');
  assert.equal(a.metadata.tailor.outcome, 'deadline');
  assert.equal(typeof a.metadata.tailor.at, 'number');
  // logo -> refused: the reason is kept for the receipt and appended for the audit.
  assert.equal(
    await db.applyLook(d, ASSET, { kind: 'refused', reason: 'Too thin.', round: 2 }),
    'refused',
  );
  a = readAsset(d);
  assert.equal(a.status, 'refused');
  assert.equal(a.metadata.reason, 'Too thin.');
  assert.deepEqual(a.metadata.tailor.reasons, ['Too thin.']);
  assert.equal(a.metadata.tailor.round, 2);
  // The same refusal again changes nothing.
  const refusedRow = d.sql.prepare('SELECT metadata FROM sponsor_assets WHERE id=?').get(ASSET);
  await db.applyLook(d, ASSET, { kind: 'refused', reason: 'Too thin.', round: 2 });
  assert.deepEqual(d.sql.prepare('SELECT metadata FROM sponsor_assets WHERE id=?').get(ASSET), refusedRow);
  // refused -> qualified: a later round that lands a look rescues the asset.
  assert.equal(await db.applyLook(d, ASSET, { ...look(LOOK_SHA), round: 3 }), 'qualified');
  a = readAsset(d);
  assert.equal(a.status, 'qualified');
  assert.equal(a.url, lookUrl(LOOK_SHA), 'the public URL is now the look');
  assert.equal(a.metadata.sourceUrl, lookUrl(LOOK_SHA));
  assert.equal(a.metadata.sha256, LOOK_SHA);
  assert.equal(a.metadata.look.sha256, LOOK_SHA);
  assert.equal(a.metadata.reason, undefined, 'a rescued asset carries no refusal');
  assert.equal(a.metadata.tailor.outcome, 'look');
  assert.equal(a.metadata.tailor.round, 3);
  // A finished asset never changes: not for a new look, a refusal, or a deadline.
  const before = d.sql
    .prepare('SELECT status,url,metadata FROM sponsor_assets WHERE id=?')
    .get(ASSET);
  assert.equal(await db.applyLook(d, ASSET, { ...look('d'.repeat(64)), round: 3 }), 'qualified');
  assert.equal(
    await db.applyLook(d, ASSET, { kind: 'refused', reason: 'Late verdict.', round: 3 }),
    'qualified',
  );
  assert.equal(
    await db.applyLook(d, ASSET, { kind: 'deferred', outcome: 'error', round: 3 }),
    'qualified',
  );
  assert.deepEqual(
    d.sql.prepare('SELECT status,url,metadata FROM sponsor_assets WHERE id=?').get(ASSET),
    before,
  );
});

void test('a fallback look is replaced by a real fit, but not while the cap is on air', async () => {
  const d = await fixture();
  insertAsset(d, 'logo', logoMeta());
  assert.equal(
    await db.applyLook(d, ASSET, { ...look(LOOK_SHA, { fallback: 'cap-v1' }), round: 1 }),
    'qualified',
  );
  assert.equal(readAsset(d).metadata.look.fallback, 'cap-v1');
  // Another fallback for the same asset is no improvement: nothing changes.
  const other = 'e'.repeat(64);
  assert.equal(
    await db.applyLook(d, ASSET, { ...look(other, { fallback: 'cap-v1' }), round: 2 }),
    'qualified',
  );
  assert.equal(readAsset(d).metadata.look.sha256, LOOK_SHA);
  // An order wearing this asset is on air: the look must not change under it.
  await paidCap(d, 'wearing', 'host', 300);
  d.sql
    .prepare(
      "UPDATE sponsor_orders SET draft=json_set(draft,'$.assetId',?),status='playing',lease_owner='studio',lease_token='t',lease_until=? WHERE id='wearing'",
    )
    .run(ASSET, Date.now() + 45000);
  assert.equal(await db.assetOnAir(d, ASSET), true);
  assert.equal(await db.applyLook(d, ASSET, { ...look(other), round: 2 }), 'qualified');
  assert.equal(readAsset(d).metadata.look.sha256, LOOK_SHA, 'kept while playing');
  d.sql.prepare("UPDATE sponsor_orders SET status='fulfilled' WHERE id='wearing'").run();
  assert.equal(await db.assetOnAir(d, ASSET), false);
  assert.equal(await db.applyLook(d, ASSET, { ...look(other), round: 2 }), 'qualified');
  const a = readAsset(d);
  assert.equal(a.metadata.look.sha256, other, 'the real fit replaced the fallback');
  assert.equal(a.metadata.look.fallback, undefined);
  assert.equal(a.metadata.sha256, other);
  assert.equal(a.url, lookUrl(other));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-db.test.mjs`
Expected: FAIL — the three new tests: `db.markTailorRequested is not a function`, `db.applyLook is not a function`.

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-db.ts`, extend the import from `'./sponsorship'` (lines 3-12):

```ts
import {
  SponsorError,
  sponsorLimits,
  fulfillmentComplete,
  type SponsorDraft,
  type SponsorAsset,
  type SponsorStatus,
  type SponsorFulfillment,
  type SponsorCapabilities,
  type LookAssetMetadata,
  type LookTailorState,
} from './sponsorship';
```

Append after `getAsset` (after line 179):

```ts
/** The tailor state on an asset, written whole: a new round starts clean and the caller passes on the audit of earlier refusals. */
export async function markTailorRequested(
  d: D1Database,
  assetId: string,
  tailor: LookTailorState,
) {
  await d
    .prepare(
      `UPDATE sponsor_assets SET metadata=json_set(metadata,'$.tailor',json(?)) WHERE id=?`,
    )
    .bind(JSON.stringify(tailor), assetId)
    .run();
}
/** Whether an order wearing this asset is on air now: its look must not change under it. */
export async function assetOnAir(
  d: D1Database,
  assetId: string,
): Promise<boolean> {
  const row = await d
    .prepare(
      `SELECT 1 AS n FROM sponsor_orders WHERE json_extract(draft,'$.assetId')=? AND status IN ('leased','prepared','playing') LIMIT 1`,
    )
    .bind(assetId)
    .first();
  return !!row;
}
export type LookOutcome =
  | {
      kind: 'look';
      sha256: string;
      url: string;
      sourceUrl: string;
      look: NonNullable<LookAssetMetadata['look']>;
      round: number;
    }
  | { kind: 'refused'; reason: string; round: number }
  | {
      kind: 'deferred';
      outcome: 'deadline' | 'shutdown' | 'error';
      round: number;
    };
/**
 * Record what a tailor round came to. Allowed: logo → qualified, logo → refused,
 * refused → qualified, and a fallback look replaced by a real fit while nothing wears it. A
 * qualified asset otherwise never changes, and a deadline, shutdown or error is not a verdict
 * on the logo. Read, then one UPDATE guarded by what was read, so a callback racing the
 * reconciler loses nothing and a repeat of the same outcome writes nothing.
 */
export async function applyLook(
  d: D1Database,
  id: string,
  outcome: LookOutcome,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const asset = await getAsset(d, id);
    if (!asset) throw new SponsorError(404, 'Artwork not found.');
    let meta: LookAssetMetadata;
    try {
      meta = JSON.parse(asset.metadata);
    } catch {
      throw new SponsorError(
        409,
        'Artwork qualification is unavailable.',
        'ASSET',
      );
    }
    const now = Date.now();
    const prior: LookTailorState = meta.tailor ?? {
      round: outcome.round,
      requestedAt: now,
    };
    let status = asset.status,
      url = asset.url,
      next: LookAssetMetadata;
    if (outcome.kind === 'look') {
      const upgrade =
        asset.status === 'qualified' &&
        !!meta.look?.fallback &&
        !outcome.look.fallback &&
        !(await assetOnAir(d, id));
      if (asset.status === 'qualified' && !upgrade) return 'qualified';
      status = 'qualified';
      url = outcome.url;
      const kept = { ...meta };
      delete kept.reason;
      next = {
        ...kept,
        sourceUrl: outcome.sourceUrl,
        sha256: outcome.sha256,
        look: outcome.look,
        tailor: { ...prior, round: outcome.round, outcome: 'look', at: now },
      };
    } else if (outcome.kind === 'refused') {
      if (asset.status === 'qualified') return 'qualified';
      if (prior.round === outcome.round && prior.outcome === 'refused')
        return 'refused';
      status = 'refused';
      next = {
        ...meta,
        reason: outcome.reason,
        tailor: {
          ...prior,
          round: outcome.round,
          outcome: 'refused',
          at: now,
          reasons: [...(prior.reasons ?? []), outcome.reason],
        },
      };
    } else {
      if (asset.status !== 'logo') return asset.status;
      if (prior.round === outcome.round && prior.outcome === outcome.outcome)
        return 'logo';
      next = {
        ...meta,
        tailor: {
          ...prior,
          round: outcome.round,
          outcome: outcome.outcome,
          at: now,
        },
      };
    }
    const r = await d
      .prepare(
        'UPDATE sponsor_assets SET status=?,url=?,metadata=? WHERE id=? AND status=? AND metadata=?',
      )
      .bind(status, url, JSON.stringify(next), id, asset.status, asset.metadata)
      .run();
    if (r.meta.changes === 1) return status;
  }
  throw new SponsorError(
    409,
    'The look changed while it was being recorded.',
    'ASSET',
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-db.test.mjs && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-db.ts tests/sponsorship-db.test.mjs
git commit -m "The site records what each tailor round came to, and a finished look is never undone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-4: The reconciler can see which logos are stuck, spent, or wearing a fallback

**Files:**
- Modify: `lib/sponsor-db.ts` (append after `applyLook`)
- Test: `tests/sponsorship-db.test.mjs` (append; uses `ASSET`, `logoMeta`, `insertAsset`, `paidCap`, `LOOK_SHA` from site-3)

**Interfaces:**
- Consumes: `markTailorRequested` (site-3), `paidCap` test helper.
- Produces (exported from `lib/sponsor-db.ts`):
  - `export const TAILOR_RETRY_MS = 240000;` `export const LOOK_UPGRADE_MS = 600000;`
  - `tailorProbe(d: D1Database, now: number): Promise<{ orderId: string; assetId: string; nextRound: number; upgrade: boolean }[]>` — reads only, `LIMIT 5`. `nextRound = tailor.round + 1` (a `logo` asset with `nextRound > 3` is for the caller to refuse); `upgrade` is true for a `qualified` asset with `look.fallback`, `tailor.round < 2`, `tailor.at < now − 10 min`, and nothing wearing it on air.
- Also pins (no code change): `leaseOrders` refuses `logo` / `refused` assets and an older `capTemplateVersion`.

- [x] **Step 1: Write the failing test**

Append to `tests/sponsorship-db.test.mjs`:

```js
void test('the tailor probe names stuck logos, spent rounds and fallback upgrades, and reads only', async () => {
  const d = await fixture();
  const MIN = 60000,
    now = 10 * MIN;
  insertAsset(d, 'logo', logoMeta(), now - 5 * MIN);
  await paidCap(d, 'buyer', 'host', now - 5 * MIN);
  d.sql
    .prepare("UPDATE sponsor_orders SET draft=json_set(draft,'$.assetId',?) WHERE id='buyer'")
    .run(ASSET);
  const written = () => d.sql.prepare('SELECT total_changes() AS n').get().n;
  // Paid five minutes ago and never requested: round 1 is due, and asking writes nothing.
  const before = written();
  assert.deepEqual(await db.tailorProbe(d, now), [
    { orderId: 'buyer', assetId: ASSET, nextRound: 1, upgrade: false },
  ]);
  assert.equal(written(), before, 'the probe writes nothing');
  // Requested a minute ago: in flight, left alone. Four minutes without an answer: next round.
  await db.markTailorRequested(d, ASSET, { round: 1, requestedAt: now - MIN });
  assert.deepEqual(await db.tailorProbe(d, now), []);
  assert.deepEqual(await db.tailorProbe(d, now + 4 * MIN), [
    { orderId: 'buyer', assetId: ASSET, nextRound: 2, upgrade: false },
  ]);
  // A deadline callback dates the wait from its own moment; after round 3 the caller refuses.
  d.sql
    .prepare("UPDATE sponsor_assets SET metadata=json_set(metadata,'$.tailor',json(?)) WHERE id=?")
    .run(
      JSON.stringify({ round: 3, requestedAt: now, outcome: 'deadline', at: now + 3 * MIN }),
      ASSET,
    );
  assert.deepEqual(await db.tailorProbe(d, now + 6 * MIN), [], 'three minutes after the deadline');
  assert.deepEqual(await db.tailorProbe(d, now + 7 * MIN + 1), [
    { orderId: 'buyer', assetId: ASSET, nextRound: 4, upgrade: false },
  ]);
  // A refused asset is never re-tailored.
  d.sql.prepare("UPDATE sponsor_assets SET status='refused' WHERE id=?").run(ASSET);
  assert.deepEqual(await db.tailorProbe(d, now + 60 * MIN), []);
  // A first-round fallback earns one upgrade, ten minutes on, while nothing wears it on air.
  d.sql
    .prepare(
      "UPDATE sponsor_assets SET status='qualified',metadata=json_set(metadata,'$.tailor',json(?),'$.look',json(?)) WHERE id=?",
    )
    .run(
      JSON.stringify({ round: 1, requestedAt: now, outcome: 'look', at: now + MIN }),
      JSON.stringify({ sha256: LOOK_SHA, model: 'm', fit: 3, round: 1, verdict: {}, fallback: 'cap-v1' }),
      ASSET,
    );
  assert.deepEqual(await db.tailorProbe(d, now + 10 * MIN), [], 'not yet');
  assert.deepEqual(await db.tailorProbe(d, now + 11 * MIN + 1), [
    { orderId: 'buyer', assetId: ASSET, nextRound: 2, upgrade: true },
  ]);
  d.sql.prepare("UPDATE sponsor_orders SET status='leased' WHERE id='buyer'").run();
  assert.deepEqual(await db.tailorProbe(d, now + 11 * MIN + 1), [], 'not while the cap is leased');
  d.sql.prepare("UPDATE sponsor_orders SET status='paid' WHERE id='buyer'").run();
  d.sql
    .prepare("UPDATE sponsor_assets SET metadata=json_set(metadata,'$.tailor.round',2) WHERE id=?")
    .run(ASSET);
  assert.deepEqual(await db.tailorProbe(d, now + 60 * MIN), [], 'one upgrade only');
});

// The lease SQL is unchanged; this pins it to the new status vocabulary.
void test('the lease refuses a cap whose logo is still tailoring or was refused, and takes it once the look lands', async () => {
  const d = await fixture();
  insertAsset(d, 'logo', logoMeta());
  await paidCap(d, 'cap1', 'host', 300);
  d.sql
    .prepare("UPDATE sponsor_orders SET draft=json_set(draft,'$.assetId',?) WHERE id='cap1'")
    .run(ASSET);
  const caps = { message: false, spotlight: false, cap: true, capTemplateVersion: 'looks-v1' };
  assert.equal((await db.leaseOrders(d, 'studio', 400, 3, caps)).length, 0, 'tailoring');
  d.sql.prepare("UPDATE sponsor_assets SET status='refused' WHERE id=?").run(ASSET);
  assert.equal((await db.leaseOrders(d, 'studio', 400, 3, caps)).length, 0, 'refused');
  d.sql.prepare("UPDATE sponsor_assets SET status='qualified' WHERE id=?").run(ASSET);
  assert.equal(
    (await db.leaseOrders(d, 'studio', 400, 3, { ...caps, capTemplateVersion: 'caps-v1' })).length,
    0,
    'a studio still on the old wardrobe',
  );
  assert.deepEqual(
    (await db.leaseOrders(d, 'studio', 400, 3, caps)).map((o) => o.id),
    ['cap1'],
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-db.test.mjs`
Expected: FAIL — `the tailor probe …`: `db.tailorProbe is not a function`. The lease pin PASSES already (unchanged SQL); that is expected.

- [x] **Step 3: Write minimal implementation**

Append to `lib/sponsor-db.ts` after `applyLook`:

```ts
/** How long a tailor round may go unanswered before the reconciler asks again: past the desk's 210 s job deadline. */
export const TAILOR_RETRY_MS = 240000;
/** How long a first-round fallback look stands before one upgrade fit is tried. */
export const LOOK_UPGRADE_MS = 600000;
/**
 * What the reconciler should ask the tailor for, reading only. A `logo` asset whose last
 * activity (callback, request, or payment) is older than TAILOR_RETRY_MS gets its next round;
 * past round 3 the caller refuses it. A `qualified` asset wearing a first-round fallback gets
 * one upgrade after LOOK_UPGRADE_MS, while no order wearing it is on air. The order named is
 * the earliest paid cap on the asset, whose project name the tailor prompt uses.
 */
export async function tailorProbe(
  d: D1Database,
  now: number,
): Promise<
  { orderId: string; assetId: string; nextRound: number; upgrade: boolean }[]
> {
  const rows = await d
    .prepare(
      `SELECT o.id AS order_id,a.id AS asset_id,a.status,COALESCE(json_extract(a.metadata,'$.tailor.round'),0) AS round FROM sponsor_assets a JOIN sponsor_orders o ON o.id=(SELECT c.id FROM sponsor_orders c WHERE c.product='cap' AND c.paid_attempt_id IS NOT NULL AND json_extract(c.draft,'$.assetId')=a.id ORDER BY c.paid_at,c.id LIMIT 1) WHERE (a.status='logo' AND COALESCE(json_extract(a.metadata,'$.tailor.at'),json_extract(a.metadata,'$.tailor.requestedAt'),MAX(o.paid_at,a.created_at),a.created_at)<?) OR (a.status='qualified' AND json_extract(a.metadata,'$.look.fallback') IS NOT NULL AND COALESCE(json_extract(a.metadata,'$.tailor.round'),0)<2 AND COALESCE(json_extract(a.metadata,'$.tailor.at'),0)<? AND NOT EXISTS(SELECT 1 FROM sponsor_orders w WHERE json_extract(w.draft,'$.assetId')=a.id AND w.status IN ('leased','prepared','playing'))) ORDER BY o.paid_at,o.id LIMIT 5`,
    )
    .bind(now - TAILOR_RETRY_MS, now - LOOK_UPGRADE_MS)
    .all<{
      order_id: string;
      asset_id: string;
      status: string;
      round: number;
    }>();
  return rows.results.map((r) => ({
    orderId: r.order_id,
    assetId: r.asset_id,
    nextRound: r.round + 1,
    upgrade: r.status === 'qualified',
  }));
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-db.test.mjs && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-db.ts tests/sponsorship-db.test.mjs
git commit -m "The reconciler can see which logos are stuck, spent or wearing a fallback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-5: A cap order is checked twice — that its logo can be dressed, and that the look is on before it airs

**Files:**
- Modify: `lib/sponsor-server.ts` — import block from `'./sponsorship'`; insert after `export type SponsorVars = {…};`; replace `export async function qualifiedSponsorAsset` whole; the five call sites (`quote`, `sponsorContext`, `pull`, `draft`, `reschedule`)
- Modify: `lib/sponsor-assets.ts:1-12` (imports/type) and `:28-65` (delete `sponsorMediaConfig`; it moves to the server module)
- Test: `tests/sponsorship-server.test.mjs` (append; these include the live `ASSET` assertions moved from `tests/sponsor-render.test.mjs`)

**Interfaces:**
- Consumes: `LOOK_VERSION`, `LookAssetMetadata` (site-1); `db.getAsset`.
- Produces:
  - `export type SponsorMediaVars = SponsorVars & { SPONSOR_ASSETS?: R2Bucket; SPONSOR_MEDIA_URL?: string; SPONSOR_MEDIA_TOKEN?: string; SITE_URL?: string }` in `lib/sponsor-server.ts`; `lib/sponsor-assets.ts` re-exports it and `sponsorMediaConfig`.
  - `export function sponsorMediaConfig(v: SponsorMediaVars): { url: URL; token: string }` in `lib/sponsor-server.ts` (same body and messages as before).
  - `export async function qualifiedSponsorAsset(d: D1Database, draft: ReturnType<typeof validateSponsorDraft>, caps?: SponsorCapabilities, stage: 'order' | 'air' = 'order'): Promise<db.AssetRow | null>`.
  - Error copy: missing row → 409 `ASSET` "Add your logo first."; `refused` → 409 `ASSET` "This logo could not be dressed (<reason>). Use a different logo."; wrong host/version/kind → 409 `ASSET` "This logo is not ready for this host on the current wardrobe."; `air` on a look not in place → 409 `ASSET` "This look is still being tailored."

- [x] **Step 1: Write the failing test**

Append to `tests/sponsorship-server.test.mjs`:

```js
// ---- looks. One sponsor_assets row per (logo, character); the order gate and the air gate.
const ASSET = 'a'.repeat(64);
const LOOK_SHA = 'b'.repeat(64);
const logoUrl = `https://show.test/api/sponsorship/assets/${ASSET}?part=logo`;
const lookUrl = `https://show.test/api/sponsorship/assets/${ASSET}?part=look&v=${LOOK_SHA}`;
const PALETTE = {
  clusters: [{ hex: '#112233', share: 1 }],
  primary: '#112233',
  secondary: '#112233',
  accent: '#112233',
  monochrome: false,
};
const capMeta = (extra = {}) => ({
  kind: 'cap',
  target: 'host',
  templateVersion: 'looks-v1',
  logoSha256: 'c'.repeat(64),
  logoUrl,
  palette: PALETTE,
  ...extra,
});
const qualifiedMeta = () =>
  capMeta({
    sourceUrl: lookUrl,
    sha256: LOOK_SHA,
    look: { sha256: LOOK_SHA, model: 'm', fit: 1, round: 1, verdict: {} },
    tailor: { round: 1, requestedAt: 100, outcome: 'look', at: 200 },
  });
function insertAsset(f, status, meta, id = ASSET) {
  f.DB.sql
    .prepare(
      'INSERT OR REPLACE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
    )
    .run(
      id,
      status,
      status === 'qualified' ? lookUrl : logoUrl,
      'image/png',
      100,
      JSON.stringify(meta),
    );
}
const CAP_DRAFT = {
  product: 'cap',
  target: 'host',
  name: 'Joe',
  projectName: 'Canvas',
  message: 'Builders ship',
  assetId: ASSET,
};
const CAPS = {
  message: true,
  spotlight: true,
  cap: true,
  capTemplateVersion: 'looks-v1',
};

void test('the order gate takes a logo that is tailoring or done, and refuses one the tailor gave up on', async () => {
  const f = await fixture();
  try {
    await db.heartbeat(f.DB, 'studio', CAPS, Date.now());
    insertAsset(f, 'logo', capMeta());
    const tailoring = await post(f.v, { action: 'draft', draft: CAP_DRAFT });
    assert.equal(tailoring.status, 200, JSON.stringify(await tailoring.clone().json()));
    insertAsset(f, 'qualified', qualifiedMeta());
    assert.equal((await post(f.v, { action: 'draft', draft: CAP_DRAFT })).status, 200);
    insertAsset(f, 'refused', capMeta({ reason: 'Too thin to print.' }));
    const refused = await post(f.v, { action: 'draft', draft: CAP_DRAFT });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.code, 'ASSET');
    assert.match(body.error, /Too thin to print/);
    assert.match(body.error, /Use a different logo/);
    // The wrong host, or a logo from an older wardrobe, is not this order's.
    insertAsset(f, 'logo', capMeta({ target: 'guest' }));
    assert.equal((await post(f.v, { action: 'draft', draft: CAP_DRAFT })).status, 409);
    insertAsset(f, 'logo', capMeta({ templateVersion: 'caps-v1' }));
    assert.equal((await post(f.v, { action: 'draft', draft: CAP_DRAFT })).status, 409);
    // A studio still heartbeating the old wardrobe cannot be quoted a cap; the new one can.
    insertAsset(f, 'logo', capMeta());
    const { receipt } = await (
      await post(f.v, { action: 'draft', draft: CAP_DRAFT })
    ).json();
    await db.heartbeat(f.DB, 'studio', { ...CAPS, capTemplateVersion: 'caps-v1' }, Date.now());
    const old = await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' });
    assert.equal(old.status, 409);
    assert.equal((await old.json()).code, 'ASSET');
    await db.heartbeat(f.DB, 'studio', CAPS, Date.now());
    const quoted = await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' });
    assert.equal(quoted.status, 200, JSON.stringify(await quoted.clone().json()));
  } finally {
    f.restore();
  }
});

/** A paid cap order leased to the heartbeating studio by hand, whatever its asset says; then the studio asks for its context. */
async function leasedCapContext(f, status, meta) {
  const now = Date.now();
  await db.heartbeat(f.DB, 'studio', CAPS, now);
  insertAsset(f, status, meta);
  await db.createOrder(f.DB, { id: 'cap-order', tokenHash: 'cap-order', draft: CAP_DRAFT, now });
  f.DB.sql
    .prepare(
      "UPDATE sponsor_orders SET status='leased',paid_attempt_id='paid',paid_at=?,lease_owner='studio',lease_token='lease',lease_until=? WHERE id='cap-order'",
    )
    .run(now, now + 45000);
  return post(
    f.v,
    { action: 'context', orderId: 'cap-order', leaseToken: 'lease' },
    { 'x-studio-id': 'studio', 'x-studio-token': f.v.STUDIO_TOKEN },
  );
}
// Moved from tests/sponsor-render.test.mjs, where a take was refused 409 ASSET when the design
// was not what the lease promised. The air gate makes the same refusal before any clip is made.
void test('the air gate refuses a cap whose look is not in place, even when the order is leased by hand', async (t) => {
  const without = (key) => {
    const m = qualifiedMeta();
    delete m[key];
    return m;
  };
  for (const [name, status, meta] of [
    ['still tailoring', 'logo', capMeta({ tailor: { round: 1, requestedAt: 100 } })],
    ['refused by the tailor', 'refused', capMeta({ reason: 'Too thin.' })],
    ['qualified without a wardrobe version', 'qualified', without('templateVersion')],
    ['qualified but the look and the source disagree', 'qualified', { ...qualifiedMeta(), sha256: 'f'.repeat(64) }],
    ['qualified without a source image', 'qualified', without('sourceUrl')],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        const r = await leasedCapContext(f, status, meta);
        assert.equal(r.status, 409);
        assert.equal((await r.json()).code, 'ASSET');
      } finally {
        f.restore();
      }
    });
  }
  await t.test('a finished look is handed to the studio with what the route pins', async () => {
    const f = await fixture();
    try {
      const r = await leasedCapContext(f, 'qualified', qualifiedMeta());
      assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
      const { order } = await r.json();
      assert.equal(order.assetUrl, lookUrl);
      assert.equal(order.assetMetadata.sourceUrl, lookUrl);
      assert.equal(order.assetMetadata.sha256, LOOK_SHA);
      assert.equal(order.assetMetadata.templateVersion, 'looks-v1');
    } finally {
      f.restore();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-server.test.mjs`
Expected: FAIL — `the order gate …` (a `logo` asset is refused today: "This artwork is not qualified for broadcast."), and in `the air gate …` the sub-tests `still tailoring`/`refused by the tailor` happen to pass while `qualified but the look and the source disagree` and `qualified without a source image` FAIL (today's gate does not read `look`/`sourceUrl`) and `a finished look …` FAILS (today's gate demands `qualificationVersion`).

- [x] **Step 3: Write minimal implementation**

`lib/sponsor-server.ts` — extend the `'./sponsorship'` import:

```ts
import {
  SponsorError,
  LOOK_VERSION,
  sponsorOffers,
  sponsorProducts,
  sponsorLimits,
  sponsorPriceCents,
  flatPriceCents,
  amountBaseForCents,
  amountUi,
  validateSponsorDraft,
  type LookAssetMetadata,
  type SponsorAsset,
  type SponsorCatalog,
  type SponsorCapabilities,
  type SponsorReceipt,
  type SponsorAttempt,
  type SponsorLease,
} from './sponsorship';
```

Insert directly after the closing `};` of `export type SponsorVars = {…}`:

```ts
/** The site's media-side bindings: the asset bucket, and where the wardrobe desk is and its secret. */
export type SponsorMediaVars = SponsorVars & {
  SPONSOR_ASSETS?: R2Bucket;
  SPONSOR_MEDIA_URL?: string;
  SPONSOR_MEDIA_TOKEN?: string;
  SITE_URL?: string;
};
/**
 * Where the media desk lives and the secret its /logo and /tailor calls carry, and that its
 * look callbacks must present. Those are all this side needs.
 */
export function sponsorMediaConfig(v: SponsorMediaVars) {
  let url: URL | undefined;
  try {
    url = v.SPONSOR_MEDIA_URL ? new URL(v.SPONSOR_MEDIA_URL) : undefined;
  } catch {
    throw new SponsorError(
      503,
      'The wardrobe service URL is invalid.',
      'MEDIA',
    );
  }
  if (!url || !v.SPONSOR_MEDIA_TOKEN || v.SPONSOR_MEDIA_TOKEN.length < 24)
    throw new SponsorError(
      503,
      'The wardrobe desk is not connected yet.',
      'MEDIA',
    );
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new SponsorError(
      503,
      'The wardrobe service URL is invalid.',
      'MEDIA',
    );
  return { url, token: v.SPONSOR_MEDIA_TOKEN };
}
```

Replace `export async function qualifiedSponsorAsset(...) {...}` whole:

```ts
/**
 * The asset an order names, checked for the stage it is at. `order` (draft, quote,
 * replaceLogo): the logo is this host's, on the current wardrobe, and the tailor has not
 * given up on it. `air` (context, pull, reschedule): the look is in place, so the studio
 * gets a `sourceUrl`, `sha256` and `templateVersion` the route can pin every dressed shot to.
 */
export async function qualifiedSponsorAsset(
  d: D1Database,
  draft: ReturnType<typeof validateSponsorDraft>,
  caps?: SponsorCapabilities,
  stage: 'order' | 'air' = 'order',
) {
  if (!draft.assetId) return null;
  const asset = await db.getAsset(d, draft.assetId);
  if (!asset) throw new SponsorError(409, 'Add your logo first.', 'ASSET');
  let meta: Partial<LookAssetMetadata> & { kind?: string };
  try {
    meta = JSON.parse(asset.metadata);
  } catch {
    throw new SponsorError(
      409,
      'Artwork qualification is unavailable.',
      'ASSET',
    );
  }
  if (draft.product === 'spotlight') {
    if (meta.kind !== 'logo' || asset.status !== 'qualified')
      throw new SponsorError(
        409,
        'Choose a project logo for the spotlight.',
        'ASSET',
      );
    return asset;
  }
  if (draft.product !== 'cap') return asset;
  if (asset.status === 'refused')
    throw new SponsorError(
      409,
      `This logo could not be dressed${meta.reason ? ` (${meta.reason})` : ''}. Use a different logo.`,
      'ASSET',
    );
  if (
    meta.kind !== 'cap' ||
    meta.target !== draft.target ||
    meta.templateVersion !== LOOK_VERSION ||
    (caps && meta.templateVersion !== caps.capTemplateVersion) ||
    !['logo', 'qualified'].includes(asset.status)
  )
    throw new SponsorError(
      409,
      'This logo is not ready for this host on the current wardrobe.',
      'ASSET',
    );
  if (
    stage === 'air' &&
    (asset.status !== 'qualified' ||
      typeof meta.sourceUrl !== 'string' ||
      !meta.look?.sha256 ||
      meta.look.sha256 !== meta.sha256)
  )
    throw new SponsorError(409, 'This look is still being tailored.', 'ASSET');
  return asset;
}
```

The five call sites (exact-text edits):

```ts
// in quote():
    await qualifiedSponsorAsset(d, JSON.parse(o.draft), live.capabilities, 'order');
// in sponsorContext():
  const asset = await qualifiedSponsorAsset(d, draft, caps, 'air');
// in handleSponsorship, the pull branch — replace
//            asset = draft.assetId
//              ? await db.getAsset(d, draft.assetId)
//              : null;
// with
            asset = await qualifiedSponsorAsset(d, draft, currentCaps, 'air');
// in the draft branch:
      await qualifiedSponsorAsset(d, draft, undefined, 'order');
// in the reschedule branch:
      await qualifiedSponsorAsset(
        d,
        JSON.parse(order.draft),
        live.capabilities,
        'air',
      );
```

`lib/sponsor-assets.ts` — replace lines 1-12 with:

```ts
import {
  sponsorDatabase,
  sponsorFailure,
  sponsorMediaConfig,
  type SponsorMediaVars,
} from './sponsor-server';
export { sponsorMediaConfig, type SponsorMediaVars } from './sponsor-server';
import { SponsorError } from './sponsorship';
import { allowSponsorRequest } from './sponsor-db';
import { perMinuteCounter } from './throttle';
const tooMany = perMinuteCounter();
```

and delete the whole `sponsorMediaConfig` function and its doc comment from `lib/sponsor-assets.ts` (the block starting `/**\n * Where the media service lives and the secret its /preview and /render calls carry.` through `return { url, token: v.SPONSOR_MEDIA_TOKEN };\n}`). `lib/sponsor-media.ts` keeps importing both names from `./sponsor-assets` through the re-export until site-17 deletes it.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-server.test.mjs tests/sponsor-assets.test.mjs tests/sponsor-render.test.mjs tests/sponsor-context.test.mjs && npx tsc --noEmit`
Expected: PASS. (`tests/sponsor-render.test.mjs` still passes: its fixture inserts a `qualified` row with `sourceUrl`/`sha256`/`templateVersion`, and `renderSponsorMedia` reads `qualificationVersion` itself, not through the gate.)

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-server.ts lib/sponsor-assets.ts tests/sponsorship-server.test.mjs
git commit -m "A cap order is checked twice: that its logo can be dressed, and that the look is on before it airs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-6: The receipt says whether the tee and cap are tailoring, ready or refused

**Files:**
- Modify: `lib/sponsor-server.ts` — import `type SponsorLook`; add `lookState()` above `export async function sponsorReceipt`; add `look` to the object `sponsorReceipt` returns
- Test: `tests/sponsorship-server.test.mjs` (append; uses `insertAsset`, `capMeta`, `qualifiedMeta`, `CAP_DRAFT`, `logoUrl`, `lookUrl` from site-5)

**Interfaces:**
- Consumes: `SponsorLook`, `LookAssetMetadata` (site-1); `db.AssetRow`.
- Produces: `receipt.look?: SponsorLook` on cap orders: `{ status: 'tailoring', round? }` while the asset is `logo`; `{ status: 'ready', url, round?, fallback? }` when `qualified`; `{ status: 'refused', reason?, round? }` when `refused`. `assetUrl` stays `asset.url`.

- [x] **Step 1: Write the failing test**

```js
void test('a cap receipt says where its look stands', async () => {
  const f = await fixture();
  try {
    const site = { origin: 'https://show.test', cluster: 'devnet' };
    await db.createOrder(f.DB, { id: 'cap-look', tokenHash: 'cap-look', draft: CAP_DRAFT, now: 100 });
    const receipt = async () =>
      server.sponsorReceipt(f.DB, await db.getOrder(f.DB, 'cap-look'), 't', site);
    insertAsset(f, 'logo', capMeta({ tailor: { round: 2, requestedAt: 100 } }));
    let r = await receipt();
    assert.deepEqual(r.look, { status: 'tailoring', round: 2 });
    assert.equal(r.assetUrl, logoUrl, 'the swatch until the look lands');
    insertAsset(f, 'logo', capMeta());
    assert.deepEqual((await receipt()).look, { status: 'tailoring' }, 'paid, not yet requested');
    const fallback = qualifiedMeta();
    fallback.look.fallback = 'cap-v1';
    insertAsset(f, 'qualified', fallback);
    r = await receipt();
    assert.deepEqual(r.look, { status: 'ready', url: lookUrl, round: 1, fallback: 'cap-v1' });
    assert.equal(r.assetUrl, lookUrl);
    insertAsset(f, 'qualified', qualifiedMeta());
    assert.deepEqual((await receipt()).look, { status: 'ready', url: lookUrl, round: 1 });
    insertAsset(
      f,
      'refused',
      capMeta({
        reason: 'Too thin.',
        tailor: { round: 3, requestedAt: 100, outcome: 'refused', at: 200, reasons: ['Too thin.'] },
      }),
    );
    assert.deepEqual((await receipt()).look, { status: 'refused', reason: 'Too thin.', round: 3 });
    // A spotlight has no look.
    const { receipt: spotlight } = await (await post(f.v, { action: 'draft', draft: DRAFT })).json();
    assert.equal(spotlight.look, undefined);
  } finally {
    f.restore();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-server.test.mjs`
Expected: FAIL — `a cap receipt says where its look stands`: `deepEqual(undefined, { status: 'tailoring', round: 2 })`.

- [x] **Step 3: Write minimal implementation**

Add `type SponsorLook,` to the `'./sponsorship'` import in `lib/sponsor-server.ts`. Insert above `export async function sponsorReceipt(`:

```ts
/** Where a cap order's look stands, for the receipt: tailoring, ready (fallback or not), or refused. */
function lookState(asset: db.AssetRow): SponsorLook {
  let meta: Partial<LookAssetMetadata> = {};
  try {
    meta = JSON.parse(asset.metadata);
  } catch {}
  const round = meta.look?.round ?? meta.tailor?.round;
  const withRound = round === undefined ? {} : { round };
  if (asset.status === 'qualified')
    return {
      status: 'ready',
      url: asset.url,
      ...withRound,
      ...(meta.look?.fallback ? { fallback: meta.look.fallback } : {}),
    };
  if (asset.status === 'refused')
    return {
      status: 'refused',
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...withRound,
    };
  return { status: 'tailoring', ...withRound };
}
```

In the object `sponsorReceipt` returns, after `capAhead,` add:

```ts
    ...(o.product === 'cap' && asset ? { look: lookState(asset) } : {}),
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-server.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-server.ts tests/sponsorship-server.test.mjs
git commit -m "The receipt says whether the tee and cap are tailoring, ready or refused

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-7: A logo is checked and normalised at upload, before any money moves

**Files:**
- Modify: `lib/sponsor-assets.ts` — imports; replace `export async function uploadSponsorAsset` whole; add `imageType()` and `DESK_DOWN` above it
- Test: `tests/sponsor-assets.test.mjs:19-99` (replace the fixtures, the first test and the cross-origin test)

**Interfaces:**
- Consumes: desk `POST /logo?target=host|guest` (contract: raw body, `content-type` image/*, 200 `{ logo, logoSha256, width, height, palette }`, 422 `{ error, code }`); `LOOK_VERSION`, `LookPalette` (site-1); `sponsorMediaConfig` (site-5); `db.getAsset`.
- Produces: `uploadSponsorAsset(request, v): Promise<Response>` answering `{ id, status, url, logoUrl }` — `status: 'logo'` and `url === logoUrl` for a new cap asset; the standing row's `status`/`url` for a repeat upload; `kind=logo` (spotlight) rows are `qualified` at once. R2 key `${id}/logo.png`; metadata `{ kind, target, logoSha256, logoUrl, palette, templateVersion: LOOK_VERSION }`. 422 from the desk relayed verbatim; desk unreachable / malformed → 503 "Artwork is not available right now; try again in a minute."; wrong magic bytes → 422 `INVALID_IMAGE` without a desk call.

- [x] **Step 1: Write the failing test**

Replace lines 19-99 of `tests/sponsor-assets.test.mjs` (from `const png = …` through the end of the cross-origin test) with:

```js
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('an uploaded mark'),
]);
const normalised = Buffer.from('normalised-rgba-png');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const PALETTE = {
  clusters: [{ hex: '#112233', share: 1 }],
  primary: '#112233',
  secondary: '#112233',
  accent: '#112233',
  monochrome: false,
};
function request({
  ip = 'asset-test',
  origin = 'https://show.test',
  bytes = PNG,
  kind = 'cap',
  target = 'host',
} = {}) {
  const form = new FormData();
  form.set('image', new File([bytes], 'logo.png', { type: 'image/png' }));
  form.set('kind', kind);
  form.set('target', target);
  return new Request('https://show.test/api/sponsorship/assets', {
    method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip },
    body: form,
  });
}
/** A site with a desk address, a token, a database and an in-memory bucket. */
function siteVars() {
  const DB = d1(),
    objects = new Map();
  return {
    DB,
    objects,
    v: {
      DB,
      SITE_URL: 'https://show.test',
      SPONSOR_MEDIA_URL: 'https://media.test',
      SPONSOR_MEDIA_TOKEN: 'a'.repeat(32),
      SPONSOR_ASSETS: {
        async put(key, bytes) {
          objects.set(key, Buffer.from(bytes));
        },
      },
    },
  };
}
const ASSET_ID = hash(JSON.stringify([hash(normalised), 'host', 'looks-v1']));
const LOGO_URL = `https://show.test/api/sponsorship/assets/${ASSET_ID}?part=logo`;
void test('an upload is normalised by the desk and stored as a logo waiting for its look', async (t) => {
  const { DB, objects, v } = siteVars();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      logo: normalised.toString('base64'),
      logoSha256: hash(normalised),
      width: 640,
      height: 200,
      palette: PALETTE,
    });
  });
  const response = await uploadSponsorAsset(request(), v);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { id: ASSET_ID, status: 'logo', url: LOGO_URL, logoUrl: LOGO_URL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://media.test/logo?target=host');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${'a'.repeat(32)}`);
  assert.equal(calls[0].init.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(calls[0].init.body), PNG, 'the raw upload travels to the desk');
  assert.deepEqual(objects.get(`${ASSET_ID}/logo.png`), normalised);
  assert.equal(objects.size, 1, 'nothing but the normalised logo is stored');
  const row = DB.sql.prepare('SELECT * FROM sponsor_assets WHERE id=?').get(ASSET_ID);
  assert.equal(row.status, 'logo');
  assert.equal(row.url, LOGO_URL);
  assert.equal(row.mime, 'image/png');
  assert.deepEqual(JSON.parse(row.metadata), {
    kind: 'cap',
    target: 'host',
    logoSha256: hash(normalised),
    logoUrl: LOGO_URL,
    palette: PALETTE,
    templateVersion: 'looks-v1',
  });
  // The same logo again is the same asset, and a look already made for it is answered at once.
  DB.sql
    .prepare("UPDATE sponsor_assets SET status='qualified',url=? WHERE id=?")
    .run('https://show.test/look', ASSET_ID);
  const again = await (await uploadSponsorAsset(request({ ip: 'asset-test-2' }), v)).json();
  assert.equal(again.id, ASSET_ID);
  assert.equal(again.status, 'qualified');
  assert.equal(again.url, 'https://show.test/look');
  assert.equal(DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n, 1);
  // A spotlight logo is its own asset and is ready at once: nothing to tailor.
  const spotlight = await (await uploadSponsorAsset(request({ ip: 'spot', kind: 'logo' }), v)).json();
  assert.equal(spotlight.status, 'qualified');
  assert.notEqual(spotlight.id, ASSET_ID);
  assert.equal(JSON.parse(DB.sql.prepare('SELECT metadata FROM sponsor_assets WHERE id=?').get(spotlight.id).metadata).kind, 'logo');
});
void test('what the desk refuses is relayed to the buyer, and nothing is stored', async (t) => {
  const { DB, objects, v } = siteVars();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: 'This logo is too thin to print.', code: 'LOGO_TOO_THIN' },
      { status: 422 },
    ),
  );
  const r = await uploadSponsorAsset(request({ ip: 'thin' }), v);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), {
    error: 'This logo is too thin to print.',
    code: 'LOGO_TOO_THIN',
  });
  assert.equal(objects.size, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n, 0);
});
void test('a file that is not an image never reaches the desk, and a desk that is down says so', async (t) => {
  const { v } = siteVars();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('fetch failed');
  });
  const junk = await uploadSponsorAsset(
    request({ ip: 'junk', bytes: Buffer.from('not an image at all') }),
    v,
  );
  assert.equal(junk.status, 422);
  assert.equal(calls, 0, 'the magic bytes are checked here');
  const down = await uploadSponsorAsset(request({ ip: 'down' }), v);
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /try again in a minute/);
  assert.equal(calls, 1);
});
void test('a desk answer that does not hash to what it says is refused', async (t) => {
  const { DB, objects, v } = siteVars();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      logo: normalised.toString('base64'),
      logoSha256: 'corrupted',
      width: 1,
      height: 1,
      palette: PALETTE,
    }),
  );
  const r = await uploadSponsorAsset(request({ ip: 'corrupt' }), v);
  assert.equal(r.status, 502);
  assert.equal(objects.size, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n, 0);
});
void test('cross-origin artwork requests fail before storage or worker calls', async () => {
  const response = await uploadSponsorAsset(
    request({ ip: 'other', origin: 'https://attacker.test' }),
    {},
  );
  assert.equal(response.status, 403);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-assets.test.mjs`
Expected: FAIL — the four new upload tests (today's upload posts to `/preview`, demands `preview` in the answer, and stores `preview.png`); the cross-origin test and the health tests still pass.

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-assets.ts` change the two imports:

```ts
import { LOOK_VERSION, SponsorError, type LookPalette } from './sponsorship';
import * as db from './sponsor-db';
```

and the one use of the old named import: `if (!(await allowSponsorRequest(d, ...` → `if (!(await db.allowSponsorRequest(d, ...`.

Replace `export async function uploadSponsorAsset(...) {...}` whole, adding the two helpers above it:

```ts
/** The image the buyer chose, by its first bytes. The desk decodes it; the site only names it. */
function imageType(bytes: Uint8Array) {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG')
    return 'image/png';
  if (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}
const DESK_DOWN = 'Artwork is not available right now; try again in a minute.';
/**
 * POST /api/sponsorship/assets: the buyer's logo, checked and normalised by the desk before
 * any money moves. A cap logo is stored as an asset waiting for its look (tailored after
 * payment); a spotlight logo is ready at once. The desk's verdict on the file is relayed
 * as it is, and nothing is stored for a file it refuses.
 */
export async function uploadSponsorAsset(
  request: Request,
  v: SponsorMediaVars,
) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      throw new SponsorError(403, 'Origin not allowed.');
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (tooMany(`sponsor-art:${ip}`, 6, Date.now()))
      throw new SponsorError(
        429,
        'Give the wardrobe desk a moment, then try again.',
      );
    if (!v.SPONSOR_ASSETS)
      throw new SponsorError(
        503,
        'Artwork storage is not connected yet.',
        'ASSETS',
      );
    const d = await sponsorDatabase(v);
    if (!(await db.allowSponsorRequest(d, `artwork:${ip}`, 6, Date.now())))
      throw new SponsorError(
        429,
        'Give the wardrobe desk a moment, then try again.',
      );
    const { url, token } = sponsorMediaConfig(v);
    const bytes = await boundedBody(request, MAX_UPLOAD + 16384);
    const form = await new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || '' },
      body: bytes,
    }).formData();
    const image = form.get('image');
    const rawKind = form.get('kind'),
      rawTarget = form.get('target');
    const kind = typeof rawKind === 'string' ? rawKind : '',
      target = typeof rawTarget === 'string' ? rawTarget : '';
    if (
      !(image instanceof File) ||
      image.size > MAX_UPLOAD ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.type) ||
      !['logo', 'cap'].includes(kind) ||
      !['host', 'guest'].includes(target)
    )
      throw new SponsorError(
        400,
        'Choose a PNG, JPG, or WebP image and a supported placement.',
      );
    const raw = new Uint8Array(await image.arrayBuffer());
    const type = imageType(raw);
    if (!type)
      throw new SponsorError(
        422,
        'That file is not a PNG, JPG or WebP image.',
        'INVALID_IMAGE',
      );
    const endpoint = new URL('/logo', url);
    endpoint.searchParams.set('target', target);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': type },
        body: raw,
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new SponsorError(503, DESK_DOWN, 'MEDIA');
    }
    const result = (await response.json().catch(() => null)) as {
      logo?: string;
      logoSha256?: string;
      palette?: LookPalette;
      error?: string;
      code?: string;
    } | null;
    // The desk's verdict on the file is the buyer's to act on, before any money moves.
    if (response.status === 422 && result?.error)
      throw new SponsorError(422, result.error, result.code ?? 'INVALID_IMAGE');
    if (
      !response.ok ||
      !result?.logo ||
      typeof result.logoSha256 !== 'string' ||
      !result.palette
    )
      throw new SponsorError(503, DESK_DOWN, 'MEDIA');
    const logo = decode(result.logo);
    if ((await sha256Hex(logo)) !== result.logoSha256)
      throw new SponsorError(502, 'Artwork integrity check failed.');
    // One asset per (normalised logo, character) on this wardrobe, shared by every order that
    // buys that logo on that character. A spotlight logo is its own kind of asset.
    const id = await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify(
          kind === 'cap'
            ? [result.logoSha256, target, LOOK_VERSION]
            : [result.logoSha256, 'logo', LOOK_VERSION],
        ),
      ),
    );
    const publicOrigin = new URL(v.SITE_URL || request.url).origin;
    const logoUrl = new URL(`/api/sponsorship/assets/${id}?part=logo`, publicOrigin)
      .href;
    await v.SPONSOR_ASSETS.put(`${id}/logo.png`, logo, {
      httpMetadata: { contentType: 'image/png' },
    });
    const metadata = {
      kind,
      target,
      logoSha256: result.logoSha256,
      logoUrl,
      palette: result.palette,
      templateVersion: LOOK_VERSION,
    };
    await d
      .prepare(
        'INSERT OR IGNORE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        id,
        kind === 'cap' ? 'logo' : 'qualified',
        logoUrl,
        'image/png',
        Date.now(),
        JSON.stringify(metadata),
      )
      .run();
    // The row that stands is answered: the same logo uploaded again may already have its look.
    const row = await db.getAsset(d, id);
    return json({ id, status: row?.status ?? 'logo', url: row?.url ?? logoUrl, logoUrl });
  } catch (e) {
    return sponsorFailure(e);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-assets.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-assets.ts tests/sponsor-assets.test.mjs
git commit -m "A logo is checked and normalised at upload, before any money moves

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-8: The site reads whether the desk can tailor, and passes the wardrobe version through

**Files:**
- Modify: `lib/sponsor-assets.ts` — `type MediaHealth`, `notReady`, `healthFrom`
- Test: `tests/sponsor-assets.test.mjs` (the health fixtures: `readyBody`, the `deepEqual` expectations, `ready`/`notReady` constants)

**Interfaces:**
- Consumes: desk `GET /health` now reporting `{ ready, tailor, templateVersion: 'looks-v1', … }` (contract); `capQualified` is gone.
- Produces: `MediaHealth = { ready: boolean; tailor: boolean; templateVersion?: string }`; `notReady()` → `{ ready: false, tailor: false }`; `healthFrom(data)` keeps `tailor: data.tailor === true`. Same JSON out of `GET /api/sponsorship/assets?action=health`.

- [x] **Step 1: Write the failing test**

In `tests/sponsor-assets.test.mjs` replace every health fixture that mentions the tracker:

```js
// readyBody (the desk's whole answer):
const readyBody = {
  ready: true,
  tailor: true,
  templateVersion: 'looks-v1',
  tools: { python: true, cv2: true, numpy: true, ffmpeg: true, node: true },
  version: 'test',
};
// every `assert.deepEqual(await checkHealth(v), { ready: true, capQualified: true, templateVersion: 'caps-v1' })`
// becomes
{ ready: true, tailor: true, templateVersion: 'looks-v1' }
// 'health checks that arrive together share one probe': the mock answers
Response.json({ ...readyBody, tailor: false })
// and expects
{ ready: true, tailor: false, templateVersion: 'looks-v1' }
// the 503 case and 'a site that cannot render reports not ready without probing' expect
{ ready: false, tailor: false }
// the two shared constants:
const ready = { ready: true, tailor: true, templateVersion: 'looks-v1' },
  notReady = { ready: false, tailor: false };
// 'a 503 the service writes itself takes caps off sale at once': the mock body is
{ ...readyBody, ready: false, tailor: false }
```

Add one test:

```js
void test('a desk that is up but cannot tailor is reported as such, on the current wardrobe', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ...readyBody, tailor: false }),
  );
  assert.deepEqual(await checkHealth(healthVars('https://media-no-key.test')), {
    ready: true,
    tailor: false,
    templateVersion: 'looks-v1',
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-assets.test.mjs`
Expected: FAIL — every health test that expects `tailor` (the answer still carries `capQualified: false`).

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-assets.ts`:

```ts
type MediaHealth = {
  ready: boolean;
  /** The desk has FAL_KEY and SPONSOR_SITE_ORIGIN and fal answered at boot: it can tailor a look. */
  tailor: boolean;
  templateVersion?: string;
};
const notReady = (): MediaHealth => ({ ready: false, tailor: false });
```

and in `healthFrom`:

```ts
  return {
    ready: data.ready,
    tailor: data.tailor === true,
    templateVersion:
      typeof data.templateVersion === 'string'
        ? data.templateVersion
        : undefined,
  };
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-assets.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-assets.ts tests/sponsor-assets.test.mjs
git commit -m "The site reads whether the desk can tailor, and passes the wardrobe version through

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-9: The studio offers the cap only when the desk can tailor a look

**Files:**
- Modify: `lib/sponsor-delivery-client.ts:106-110` (the `health` shape) and `:145` (the heartbeat's `cap`)
- Test: `tests/sponsor-heartbeat.test.mjs:18-22, 58-62` (fixtures) + one assertion

**Interfaces:**
- Consumes: the health JSON of site-8.
- Produces: heartbeat `capabilities: { message: true, spotlight: true, cap: health.ready === true && health.tailor === true, capTemplateVersion: health.templateVersion }`.

- [x] **Step 1: Write the failing test**

In `tests/sponsor-heartbeat.test.mjs`, both mocked health answers become the desk's new shape, and the second test also records the version the heartbeat carries:

```js
// first test, the health answer:
      return Response.json({
        ready: true,
        tailor: true,
        templateVersion: 'looks-v1',
      });
// second test:
    if (String(url).startsWith('/api/sponsorship/assets'))
      return Response.json({
        ready,
        tailor: ready,
        templateVersion: 'looks-v1',
      });
    const body = JSON.parse(options.body);
    if (body.action === 'heartbeat')
      offered.push([body.capabilities.cap, body.capabilities.capTemplateVersion]);
    …
  assert.deepEqual(offered, [
    [true, 'looks-v1'],
    [false, 'looks-v1'],
  ]);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-heartbeat.test.mjs`
Expected: FAIL — both tests offer `cap: false` (the client still keys on `capQualified`).

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-delivery-client.ts`:

```ts
  let health: {
    tailor?: boolean;
    templateVersion?: string;
    ready?: boolean;
  } = {};
```

and in the heartbeat call:

```ts
          cap: health.ready === true && health.tailor === true,
```

(`capTemplateVersion: health.templateVersion` is already sent when present; leave it.)

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-heartbeat.test.mjs tests/sponsor-playback-recovery.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-delivery-client.ts tests/sponsor-heartbeat.test.mjs
git commit -m "The studio offers the cap only when the desk can tailor a look

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-10: A logo and every look are served for good; a bare address follows the asset

**Files:**
- Modify: `lib/sponsor-assets.ts` — replace `export async function readSponsorAsset` whole; add `assetStatus()` and `HEX64`
- Test: `tests/sponsor-assets.test.mjs` (append; extend the module import)

**Interfaces:**
- Consumes: `db.getAsset`, `sponsorDatabase`, `LookAssetMetadata`.
- Produces: `readSponsorAsset(request, v, id)`:
  - `?part=logo` → `${id}/logo.png`; `?part=look&v=<hex64>` → `${id}/look-<v>.png`; both `image/png`, `public,max-age=31536000,immutable`, `access-control-allow-origin: *`, range-aware as before. Any other `part`, or `look` without a hex64 `v` → 404.
  - no `part`: row missing → 404; `accept` containing `application/json` → 200 `{ status, url, lookUrl?, reason?, tailor? }` no-store; otherwise `302` to `asset.url` with `cache-control: no-store`.

- [x] **Step 1: Write the failing test**

Change the module import at the top of `tests/sponsor-assets.test.mjs` to:

```js
const { uploadSponsorAsset, sponsorAssetHealth, readSponsorAsset } =
  await import('../work/tests/sponsor-assets.js');
```

Append:

```js
// ---- serving: the logo and every look are immutable; a bare address follows the asset.
/** A bucket holding what was put, answering get() the way R2 does for whole objects. */
function bucket(entries = {}) {
  const objects = new Map(
    Object.entries(entries).map(([key, bytes]) => [key, Buffer.from(bytes)]),
  );
  return {
    objects,
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes
        ? {
            body: new Blob([bytes]).stream(),
            size: bytes.length,
            httpEtag: '"etag"',
            range: undefined,
          }
        : null;
    },
  };
}
function assetRow(DB, status, url, metadata) {
  DB.sql
    .prepare(
      'INSERT OR REPLACE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
    )
    .run(ASSET_ID, status, url, 'image/png', 100, JSON.stringify(metadata));
}
const LOOK_SHA = 'b'.repeat(64);
const LOOK_URL = `https://show.test/api/sponsorship/assets/${ASSET_ID}?part=look&v=${LOOK_SHA}`;
void test('the logo and each look are served immutable and cross-origin; a bare address follows the asset', async () => {
  const DB = d1();
  const assets = bucket({
    [`${ASSET_ID}/logo.png`]: normalised,
    [`${ASSET_ID}/look-${LOOK_SHA}.png`]: Buffer.from('the look'),
  });
  const v = { DB, SITE_URL: 'https://show.test', SPONSOR_ASSETS: assets };
  const get = (query, headers = {}) =>
    readSponsorAsset(
      new Request(`https://show.test/api/sponsorship/assets/${ASSET_ID}${query}`, { headers }),
      v,
      ASSET_ID,
    );
  const logo = await get('?part=logo');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal(logo.headers.get('cache-control'), 'public,max-age=31536000,immutable');
  assert.equal(logo.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), normalised);
  const look = await get(`?part=look&v=${LOOK_SHA}`);
  assert.equal(look.status, 200);
  assert.equal(await look.text(), 'the look');
  assert.equal((await get('?part=look')).status, 404, 'a look is named by its hash');
  assert.equal((await get('?part=preview')).status, 404, 'the preview is gone');
  assert.equal((await get('?part=video')).status, 404);
  // Bare: 404 for no row; the logo while tailoring; the look once qualified; never cached.
  assert.equal((await get('')).status, 404, 'no such asset');
  assetRow(DB, 'logo', LOGO_URL, { kind: 'cap', tailor: { round: 1, requestedAt: 5 } });
  let bare = await get('', { accept: 'image/*' });
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), LOGO_URL);
  assert.equal(bare.headers.get('cache-control'), 'no-store');
  assetRow(DB, 'qualified', LOOK_URL, { kind: 'cap', look: { sha256: LOOK_SHA } });
  bare = await get('', { accept: 'image/*' });
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), LOOK_URL);
  const status = await get('', { accept: 'application/json' });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { status: 'qualified', url: LOOK_URL, lookUrl: LOOK_URL });
  const tailor = { round: 3, requestedAt: 5, outcome: 'refused', at: 9, reasons: ['Too thin.'] };
  assetRow(DB, 'refused', LOGO_URL, { kind: 'cap', reason: 'Too thin.', tailor });
  assert.deepEqual(await (await get('', { accept: 'application/json' })).json(), {
    status: 'refused',
    url: LOGO_URL,
    reason: 'Too thin.',
    tailor,
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-assets.test.mjs`
Expected: FAIL — `?part=look&v=` answers 404 (today's key is `preview.png`), `?part=preview` answers 200, the bare address answers 200 with `preview.png` or 404.

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-assets.ts` add near the top (after `const MAX_UPLOAD`):

```ts
const HEX64 = /^[a-f0-9]{64}$/;
```

Add `type LookAssetMetadata` to the `'./sponsorship'` import. Replace `export async function readSponsorAsset(...) {...}` whole:

```ts
/** The asset's standing for a bare GET: a redirect to whatever image stands for it now, or JSON on request. */
async function assetStatus(request: Request, v: SponsorMediaVars, id: string) {
  try {
    const d = await sponsorDatabase(v);
    const asset = await db.getAsset(d, id);
    if (!asset) throw new SponsorError(404, 'Artwork not found.');
    if (!/application\/json/.test(request.headers.get('accept') ?? ''))
      return new Response(null, {
        status: 302,
        headers: { location: asset.url, 'cache-control': 'no-store' },
      });
    let meta: Partial<LookAssetMetadata> = {};
    try {
      meta = JSON.parse(asset.metadata);
    } catch {}
    return json({
      status: asset.status,
      url: asset.url,
      ...(asset.status === 'qualified' ? { lookUrl: asset.url } : {}),
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.tailor ? { tailor: meta.tailor } : {}),
    });
  } catch (e) {
    return sponsorFailure(e);
  }
}
/**
 * GET /api/sponsorship/assets/{id}: `?part=logo` is the normalised logo, `?part=look&v=<sha>`
 * one look; both are named by content, so they are cached for good and readable from any
 * origin (fal fetches both). A bare address follows the asset to the image that stands for
 * it now, and says where it stands to a caller that asks for JSON.
 */
export async function readSponsorAsset(
  request: Request,
  v: SponsorMediaVars,
  id: string,
) {
  if (!HEX64.test(id) || !v.SPONSOR_ASSETS)
    return new Response('Artwork not found', { status: 404 });
  const url = new URL(request.url),
    part = url.searchParams.get('part');
  if (part === null) return assetStatus(request, v, id);
  const version = url.searchParams.get('v') ?? '';
  const key =
    part === 'logo'
      ? `${id}/logo.png`
      : part === 'look' && HEX64.test(version)
        ? `${id}/look-${version}.png`
        : null;
  if (!key) return new Response('Artwork not found', { status: 404 });
  const object = await v.SPONSOR_ASSETS.get(key, { range: request.headers });
  if (!object) return new Response('Artwork not found', { status: 404 });
  const headers: Record<string, string> = {
    'content-type': 'image/png',
    'cache-control': 'public,max-age=31536000,immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    etag: object.httpEtag,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
  };
  let status = 200;
  if (
    object.range &&
    'offset' in object.range &&
    object.range.offset !== undefined &&
    object.range.length !== undefined
  ) {
    status = 206;
    headers['content-range'] =
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`;
    headers['content-length'] = String(object.range.length);
  } else headers['content-length'] = String(object.size);
  return new Response(object.body, { status, headers });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-assets.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-assets.ts tests/sponsor-assets.test.mjs
git commit -m "A logo and every look are served for good; a bare address follows the asset to its look

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-11: The desk hands the site a finished look, and the site files it under its hash

**Files:**
- Modify: `lib/sponsor-assets.ts` — add `receiveLook` (+ `LOOK_OUTCOMES`, `MAX_LOOK`, `verdictHeader`); import `sameSponsorToken`
- Modify: `app/api/sponsorship/assets/[id]/route.ts` (add `PUT`)
- Test: `tests/sponsor-assets.test.mjs` (append; extend the module import)

**Interfaces:**
- Consumes: the desk callback (contract): `PUT …/assets/{id}?part=look`, `authorization: Bearer ${SPONSOR_MEDIA_TOKEN}`, `x-look-round`, `x-look-outcome: look|refused|deadline|shutdown|error`; for `look`: `content-type: image/png`, body, `x-look-sha256`, `x-look-verdict` (base64 JSON `{ model, fit, round, palette, plan, judge, candidateUrl, fallback? }`); otherwise `x-look-reason`. `db.applyLook`, `db.assetOnAir`, `db.getAsset` (site-3), `readBounded`, `sha256Hex`, `sameSponsorToken`.
- Produces: `receiveLook(request: Request, v: SponsorMediaVars, id: string): Promise<Response>` — 200 `{ status }`; 401 without/with a wrong bearer or when `SPONSOR_MEDIA_TOKEN` is unset; 400 for a bad round/outcome or a sha256 that is not the body's; 404 unknown id. Stores `${id}/look-<sha256>.png` then records via `applyLook`; a `qualified` asset is not touched (log `look-superseded`) except the fallback → real-fit upgrade while nothing wears it. Route `PUT` on `app/api/sponsorship/assets/[id]/route.ts`.

- [x] **Step 1: Write the failing test**

Extend the module import at the top of `tests/sponsor-assets.test.mjs`:

```js
const { uploadSponsorAsset, sponsorAssetHealth, readSponsorAsset, receiveLook } =
  await import('../work/tests/sponsor-assets.js');
const { ensureSponsorSchema } = await import('../work/tests/sponsor-db.js');
```

Append:

```js
// ---- the desk's callback: every tailor round ends in one PUT.
const MEDIA_TOKEN = 'm'.repeat(32);
const lookBytes = Buffer.from('a tailored look png');
const LOOK = hash(lookBytes);
const verdict = {
  model: 'fal-ai/nano-banana-pro/edit',
  fit: 2,
  round: 1,
  palette: PALETTE,
  plan: { shirtHex: '#F2EFE8', capHex: '#112233' },
  judge: { shirtLogo: true, logoFidelity: 9 },
  candidateUrl: 'https://v3.fal.media/files/candidate.png',
};
function callback({
  token = MEDIA_TOKEN,
  outcome = 'look',
  round = 1,
  bytes = lookBytes,
  sha = hash(bytes),
  verdictBody = verdict,
  reason = 'The tailor ran out of time.',
  headers = {},
} = {}) {
  const h = {
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    'x-look-outcome': outcome,
    'x-look-round': String(round),
  };
  if (outcome === 'look')
    Object.assign(h, {
      'content-type': 'image/png',
      'x-look-sha256': sha,
      'x-look-verdict': Buffer.from(JSON.stringify(verdictBody)).toString('base64'),
    });
  else h['x-look-reason'] = reason;
  Object.assign(h, headers);
  return new Request(`https://show.test/api/sponsorship/assets/${ASSET_ID}?part=look`, {
    method: 'PUT',
    headers: h,
    body: outcome === 'look' ? bytes : null,
  });
}
async function tailoringSite() {
  const DB = d1(),
    assets = bucket();
  await ensureSponsorSchema(DB);
  const v = {
    DB,
    SITE_URL: 'https://show.test',
    SPONSOR_MEDIA_URL: 'https://media.test',
    SPONSOR_MEDIA_TOKEN: MEDIA_TOKEN,
    SPONSOR_ASSETS: assets,
  };
  const row = () => {
    const r = DB.sql.prepare('SELECT * FROM sponsor_assets WHERE id=?').get(ASSET_ID);
    return r && { ...r, metadata: JSON.parse(r.metadata) };
  };
  return { DB, assets, v, row };
}
const logoMeta = (extra = {}) => ({
  kind: 'cap',
  target: 'host',
  templateVersion: 'looks-v1',
  logoSha256: hash(normalised),
  logoUrl: LOGO_URL,
  palette: PALETTE,
  tailor: { round: 1, requestedAt: 5 },
  ...extra,
});
const lookUrlFor = (sha) =>
  `https://show.test/api/sponsorship/assets/${ASSET_ID}?part=look&v=${sha}`;

void test('a look callback must carry the desk secret and the hash of what it sends', async (t) => {
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  for (const [name, request, vars, status] of [
    ['no token', callback({ token: undefined }), site.v, 401],
    ['the wrong token', callback({ token: 'x'.repeat(32) }), site.v, 401],
    ['no secret configured on the site', callback(), { ...site.v, SPONSOR_MEDIA_TOKEN: undefined }, 401],
    ['a hash that is not the body', callback({ sha: 'f'.repeat(64) }), site.v, 400],
    ['no hash', callback({ headers: { 'x-look-sha256': '' } }), site.v, 400],
    ['an outcome the site does not know', callback({ outcome: 'maybe' }), site.v, 400],
    ['a round outside 1..3', callback({ round: 7 }), site.v, 400],
  ]) {
    await t.test(name, async () => {
      assert.equal((await receiveLook(request, vars, ASSET_ID)).status, status);
      assert.equal(site.row().status, 'logo', 'nothing changed');
      assert.equal(site.assets.objects.size, 0, 'nothing stored');
    });
  }
});

void test('a look lands: stored under its hash, the asset qualified and its address rewritten', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  const r = await receiveLook(callback(), site.v, ASSET_ID);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { status: 'qualified' });
  assert.deepEqual(site.assets.objects.get(`${ASSET_ID}/look-${LOOK}.png`), lookBytes);
  const row = site.row();
  assert.equal(row.status, 'qualified');
  assert.equal(row.url, lookUrlFor(LOOK));
  assert.equal(row.metadata.sourceUrl, row.url);
  assert.equal(row.metadata.sha256, LOOK);
  assert.deepEqual(row.metadata.look, { sha256: LOOK, model: verdict.model, fit: 2, round: 1, verdict });
  assert.equal(row.metadata.tailor.outcome, 'look');
  assert.equal(row.metadata.logoUrl, LOGO_URL, 'the logo stays where it was');
  // The same look again is a no-op; a different look for a finished asset is superseded.
  assert.deepEqual(await (await receiveLook(callback(), site.v, ASSET_ID)).json(), { status: 'qualified' });
  const other = Buffer.from('another fit');
  assert.deepEqual(
    await (await receiveLook(callback({ bytes: other, round: 2 }), site.v, ASSET_ID)).json(),
    { status: 'qualified' },
  );
  assert.equal(site.assets.objects.has(`${ASSET_ID}/look-${hash(other)}.png`), false, 'not stored');
  assert.equal(site.row().metadata.sha256, LOOK);
  // Nor does a late refusal or deadline touch it.
  await receiveLook(callback({ outcome: 'refused', round: 2, reason: 'Late.' }), site.v, ASSET_ID);
  await receiveLook(callback({ outcome: 'deadline', round: 2 }), site.v, ASSET_ID);
  assert.equal(site.row().status, 'qualified');
  assert.equal(site.row().metadata.reason, undefined);
});

void test('refusals and non-verdicts are recorded without touching the logo', async () => {
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  assert.deepEqual(
    await (await receiveLook(callback({ outcome: 'deadline' }), site.v, ASSET_ID)).json(),
    { status: 'logo' },
  );
  let row = site.row();
  assert.equal(row.status, 'logo');
  assert.equal(row.metadata.tailor.outcome, 'deadline');
  assert.equal(row.url, LOGO_URL);
  assert.deepEqual(
    await (
      await receiveLook(
        callback({ outcome: 'refused', round: 2, reason: 'Too thin to print.' }),
        site.v,
        ASSET_ID,
      )
    ).json(),
    { status: 'refused' },
  );
  row = site.row();
  assert.equal(row.status, 'refused');
  assert.equal(row.metadata.reason, 'Too thin to print.');
  assert.deepEqual(row.metadata.tailor.reasons, ['Too thin to print.']);
  // A later round that lands a look rescues a refused asset.
  assert.deepEqual(await (await receiveLook(callback({ round: 3 }), site.v, ASSET_ID)).json(), {
    status: 'qualified',
  });
  assert.equal(site.row().metadata.reason, undefined);
  assert.equal(site.assets.objects.size, 1);
});

void test('a fallback look is upgraded by a real fit once', async () => {
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  await receiveLook(callback({ verdictBody: { ...verdict, fallback: 'cap-v1' } }), site.v, ASSET_ID);
  assert.equal(site.row().metadata.look.fallback, 'cap-v1');
  const fit = Buffer.from('a real fit');
  await receiveLook(callback({ bytes: fit, round: 2 }), site.v, ASSET_ID);
  const row = site.row();
  assert.equal(row.metadata.sha256, hash(fit), 'the real fit replaced the fallback');
  assert.equal(row.metadata.look.fallback, undefined);
  assert.equal(row.url, lookUrlFor(hash(fit)));
  assert.ok(site.assets.objects.has(`${ASSET_ID}/look-${hash(fit)}.png`));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-assets.test.mjs`
Expected: FAIL — `receiveLook is not a function` in the four new tests.

- [x] **Step 3: Write minimal implementation**

`lib/sponsor-assets.ts` — add `sameSponsorToken` to the import from `'./sponsor-server'`, then append:

```ts
const LOOK_OUTCOMES = ['look', 'refused', 'deadline', 'shutdown', 'error'] as const;
const MAX_LOOK = 8 * 1024 * 1024;
/** The desk's verdict header: base64 JSON, kept whole for the audit; only model, fit and fallback are read here. */
function verdictHeader(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
      ),
    );
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
/**
 * PUT /api/sponsorship/assets/{id}?part=look: the desk reporting how a tailor round ended.
 * Only the desk may call it (its bearer), and a look must hash to what the desk says it
 * sent. A look is stored under its hash and then recorded; nothing is stored for a look
 * that would not be recorded (a finished asset keeps its look, except the fallback →
 * real-fit upgrade while no order wearing it is on air).
 */
export async function receiveLook(
  request: Request,
  v: SponsorMediaVars,
  id: string,
) {
  try {
    if (!HEX64.test(id)) throw new SponsorError(404, 'Artwork not found.');
    const bearer = (request.headers.get('authorization') ?? '').replace(
      /^Bearer\s+/i,
      '',
    );
    if (!v.SPONSOR_MEDIA_TOKEN || !sameSponsorToken(bearer, v.SPONSOR_MEDIA_TOKEN))
      throw new SponsorError(401, 'Wardrobe desk token rejected.');
    if (!v.SPONSOR_ASSETS)
      throw new SponsorError(
        503,
        'Artwork storage is not connected yet.',
        'ASSETS',
      );
    const outcome = request.headers.get('x-look-outcome') ?? '';
    const round = Number(request.headers.get('x-look-round'));
    if (
      !(LOOK_OUTCOMES as readonly string[]).includes(outcome) ||
      !Number.isInteger(round) ||
      round < 1 ||
      round > 3
    )
      throw new SponsorError(400, 'A look callback names its round and outcome.');
    const d = await sponsorDatabase(v);
    if (outcome === 'refused') {
      const reason =
        (request.headers.get('x-look-reason') ?? '').trim().slice(0, 300) ||
        'The tailor could not dress this logo.';
      return json({
        status: await db.applyLook(d, id, { kind: 'refused', reason, round }),
      });
    }
    if (outcome !== 'look')
      return json({
        status: await db.applyLook(d, id, {
          kind: 'deferred',
          outcome: outcome as 'deadline' | 'shutdown' | 'error',
          round,
        }),
      });
    const declared = request.headers.get('x-look-sha256') ?? '';
    if (!HEX64.test(declared) || !request.body)
      throw new SponsorError(400, 'A look names its bytes by their hash.');
    const bytes = await readBounded(request.body, MAX_LOOK, 'The look is too large.');
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== declared)
      throw new SponsorError(400, 'The look does not hash to what the desk says.');
    const current = await db.getAsset(d, id);
    if (!current) throw new SponsorError(404, 'Artwork not found.');
    const verdict = verdictHeader(request.headers.get('x-look-verdict'));
    const fallback = verdict.fallback === 'cap-v1' ? ('cap-v1' as const) : undefined;
    let meta: Partial<LookAssetMetadata> = {};
    try {
      meta = JSON.parse(current.metadata);
    } catch {}
    if (
      current.status === 'qualified' &&
      (!meta.look?.fallback || fallback || (await db.assetOnAir(d, id)))
    ) {
      console.warn('[sponsorship] look-superseded', id, round);
      return json({ status: 'qualified' });
    }
    const lookUrl = new URL(
      `/api/sponsorship/assets/${id}?part=look&v=${sha256}`,
      v.SITE_URL || request.url,
    ).href;
    await v.SPONSOR_ASSETS.put(`${id}/look-${sha256}.png`, bytes, {
      httpMetadata: { contentType: 'image/png' },
    });
    const status = await db.applyLook(d, id, {
      kind: 'look',
      sha256,
      url: lookUrl,
      sourceUrl: lookUrl,
      round,
      look: {
        sha256,
        model: typeof verdict.model === 'string' ? verdict.model : 'unknown',
        fit: typeof verdict.fit === 'number' ? verdict.fit : 0,
        round,
        verdict,
        ...(fallback ? { fallback } : {}),
      },
    });
    return json({ status });
  } catch (e) {
    return sponsorFailure(e);
  }
}
```

`app/api/sponsorship/assets/[id]/route.ts` whole:

```ts
import { env } from 'cloudflare:workers';
import {
  readSponsorAsset,
  receiveLook,
  type SponsorMediaVars,
} from '@/lib/sponsor-assets';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  return readSponsorAsset(
    request,
    env as unknown as SponsorMediaVars,
    (await params).id,
  );
}
/** The wardrobe desk reporting how a tailor round ended. */
export async function PUT(request: Request, { params }: Context) {
  return receiveLook(
    request,
    env as unknown as SponsorMediaVars,
    (await params).id,
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-assets.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-assets.ts "app/api/sponsorship/assets/[id]/route.ts" tests/sponsor-assets.test.mjs
git commit -m "The desk hands the site a finished look, and the site files it under its hash

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-12: Paying for a cap starts its tailoring at once

**Files:**
- Modify: `lib/sponsor-server.ts` — add `requestTailor` (exported) above `async function recoverAttempt`; `recoverAttempt` ORs `orderPaidNow` and calls it once; widen `recoverAttempt`, `quote`, `handleSponsorship`, `reconcileSponsorships` to `SponsorMediaVars`; import `type SponsorDraft`
- Modify: `app/api/sponsorship/route.ts`, `app/api/sponsorship/reconcile/route.ts` (cast `env` to `SponsorMediaVars`)
- Test: `tests/sponsorship-server.test.mjs` (append; uses `insertAsset`, `capMeta`, `qualifiedMeta`, `CAP_DRAFT`, `CAPS`, `ASSET`, `PALETTE`, `logoUrl`, `lookUrl` from site-5)

**Interfaces:**
- Consumes: `settlePayment(...).orderPaidNow` (site-2); `db.markTailorRequested`, `db.applyLook` (site-3); `sponsorMediaConfig` (site-5); desk `POST /tailor` JSON `{ assetId, round, target, logoUrl, logoSha256, palette, projectName }` → 202/200 ok, 409 BUSY, other 4xx = a verdict on the request, 503 unavailable (contract).
- Produces: `export async function requestTailor(d: D1Database, v: SponsorMediaVars, orderId: string, round: number): Promise<void>` — never throws. Returns unless the order is a cap with `assetId` and `target`, and unless the asset is `logo` (or `qualified` wearing `look.fallback` with `round === 2`, the upgrade). Writes `metadata.tailor = { round, requestedAt, reasons? }` (one UPDATE) then POSTs `/tailor` with a 5 s timeout. Non-409 4xx → `applyLook(refused)` with the desk's `error`. Any throw / 409 / 5xx / missing config → `console.warn('[sponsorship] tailor deferred', …)` and return.

- [x] **Step 1: Write the failing test**

Append to `tests/sponsorship-server.test.mjs`:

```js
// ---- paying starts the tailor.
/** Pay a quote on the fixture's fake chain the way a wallet does, then confirm it: the real settle path. */
async function payOnChain(f, v, receipt, q) {
  const tx = Transaction.from(Buffer.from(q.transaction, 'base64'));
  tx.partialSign(f.wallet);
  const { getBase58Decoder } = await import('@solana/kit');
  const sig = getBase58Decoder().decode(tx.signature),
    msg = tx.compileMessage();
  const keys = msg.accountKeys.map((pubkey, i) => ({
      pubkey: pubkey.toBase58(),
      signer: i < msg.header.numRequiredSignatures,
    })),
    index = keys.findIndex((k) => k.pubkey === f.v.TREASURY_WALLET),
    lamports = Number(q.attempt.amountBase),
    pre = keys.map(() => 0),
    after = keys.map(() => 0);
  pre[0] = 3000000000;
  after[0] = pre[0] - lamports - 5000;
  after[index] = lamports;
  f.c.getParsedTransaction = async () => ({
    blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, preBalances: pre, postBalances: after },
    transaction: {
      signatures: tx.signatures.map((s) => getBase58Decoder().decode(s.signature)),
      message: {
        accountKeys: keys,
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: f.wallet.publicKey.toBase58(),
                destination: f.v.TREASURY_WALLET,
                lamports,
              },
            },
          },
        ],
      },
    },
  });
  return (
    await post(v, { action: 'confirm', token: receipt.token, attemptId: q.attempt.id, signature: sig })
  ).json();
}
/** The fixture with a wardrobe desk: /tailor answers are scripted, everything else is the price oracle. */
function withDesk(f, answer = () => Response.json({ key: 'k', queued: true }, { status: 202 })) {
  const tailors = [];
  const oracle = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/tailor')) {
      tailors.push({ url: String(url), init, body: JSON.parse(init.body) });
      return answer();
    }
    return oracle(url, init);
  };
  return {
    tailors,
    v: {
      ...f.v,
      SPONSOR_MEDIA_URL: 'https://media.test',
      SPONSOR_MEDIA_TOKEN: 'm'.repeat(32),
      SITE_URL: 'https://show.test',
    },
  };
}
/** Draft a cap on the asset, quote it for the fixture wallet, pay it: the paid receipt. */
async function buyCap(f, v) {
  await db.heartbeat(f.DB, 'studio', CAPS, Date.now());
  const { receipt } = await (await post(v, { action: 'draft', draft: CAP_DRAFT })).json();
  const q = await (
    await post(v, { action: 'quote', token: receipt.token, asset: 'SOL', wallet: f.wallet.publicKey.toBase58() })
  ).json();
  assert.ok(q.attempt, JSON.stringify(q));
  const paid = await payOnChain(f, v, receipt, q);
  assert.equal(paid.receipt.status, 'paid', JSON.stringify(paid));
  return { receipt, q, paid };
}
const assetMeta = (f) =>
  JSON.parse(f.DB.sql.prepare('SELECT metadata FROM sponsor_assets WHERE id=?').get(ASSET).metadata);

void test('the first proof that pays a cap asks the desk for its look exactly once', async () => {
  const f = await fixture();
  try {
    const desk = withDesk(f);
    insertAsset(f, 'logo', capMeta());
    const { receipt, q, paid } = await buyCap(f, desk.v);
    assert.equal(desk.tailors.length, 1);
    assert.equal(desk.tailors[0].url, 'https://media.test/tailor');
    assert.equal(desk.tailors[0].init.headers.authorization, `Bearer ${'m'.repeat(32)}`);
    assert.deepEqual(desk.tailors[0].body, {
      assetId: ASSET,
      round: 1,
      target: 'host',
      logoUrl,
      logoSha256: 'c'.repeat(64),
      palette: PALETTE,
      projectName: 'Canvas',
    });
    const meta = assetMeta(f);
    assert.equal(meta.tailor.round, 1);
    assert.equal(typeof meta.tailor.requestedAt, 'number');
    assert.deepEqual(paid.receipt.look, { status: 'tailoring', round: 1 });
    // Confirming again, and a late second transfer, ask for nothing.
    await post(desk.v, { action: 'confirm', token: receipt.token, attemptId: q.attempt.id });
    await db.settlePayment(f.DB, q.attempt.id, { signature: 'late', payer: 'payer', blockTime: 150 }, Date.now());
    await post(desk.v, { action: 'confirm', token: receipt.token });
    assert.equal(desk.tailors.length, 1);
  } finally {
    f.restore();
  }
});

void test('a site without a desk still takes the payment, and warns', async (t) => {
  const f = await fixture();
  try {
    const warned = t.mock.method(console, 'warn', () => {});
    insertAsset(f, 'logo', capMeta());
    await buyCap(f, f.v);
    assert.ok(
      warned.mock.calls.some((c) => c.arguments[0] === '[sponsorship] tailor deferred'),
      'the deferral is logged',
    );
    assert.equal(assetMeta(f).tailor.round, 1, 'the reconciler will ask again');
  } finally {
    f.restore();
  }
});

void test('a second order for a logo whose look exists asks the desk for nothing and reads ready', async () => {
  const f = await fixture();
  try {
    const desk = withDesk(f);
    insertAsset(f, 'qualified', qualifiedMeta());
    const { paid } = await buyCap(f, desk.v);
    assert.equal(desk.tailors.length, 0);
    assert.equal(paid.receipt.look.status, 'ready');
    assert.equal(paid.receipt.look.url, lookUrl);
  } finally {
    f.restore();
  }
});

void test('a desk that refuses the request outright refuses the logo; a busy or absent one is asked again later', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [name, answer, status] of [
    [
      'bad hash',
      () => Response.json({ code: 'LOGO_HASH', error: 'The logo does not match its hash.' }, { status: 400 }),
      'refused',
    ],
    ['busy', () => Response.json({ code: 'BUSY', retryAfterMs: 5000 }, { status: 409 }), 'logo'],
    ['down', () => Promise.reject(new TypeError('fetch failed')), 'logo'],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        const desk = withDesk(f, answer);
        insertAsset(f, 'logo', capMeta());
        await buyCap(f, desk.v);
        const row = f.DB.sql.prepare('SELECT status,metadata FROM sponsor_assets WHERE id=?').get(ASSET);
        assert.equal(row.status, status);
        if (status === 'refused') assert.match(JSON.parse(row.metadata).reason, /does not match/);
        assert.equal(JSON.parse(row.metadata).tailor.round, 1);
      } finally {
        f.restore();
      }
    });
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-server.test.mjs`
Expected: FAIL — `the first proof …` (`desk.tailors.length` is 0), `a site without a desk …` (no warning), `a desk that refuses …` (`tailor` is undefined). `a second order …` passes already (nothing is called); that is fine.

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-server.ts` add `type SponsorDraft,` to the `'./sponsorship'` import. Insert above `async function recoverAttempt(`:

```ts
/**
 * Ask the desk for the look of the asset an order names. Called the one time a payment
 * settles an order, by the reconciler for a round that went unanswered, and by replaceLogo.
 * The look is made once per asset: a `qualified` asset is reused as it is (a later order for
 * the same logo shows the existing look at once), except one wearing the fallback print,
 * which gets its single upgrade fit at round 2. Never throws: the confirm response and the
 * reconciler's counters are the same whatever the desk does. A request the desk refuses
 * outright (a non-409 4xx) is a verdict on the logo and refuses the asset at once.
 */
export async function requestTailor(
  d: D1Database,
  v: SponsorMediaVars,
  orderId: string,
  round: number,
): Promise<void> {
  try {
    const order = await db.getOrder(d, orderId);
    if (!order || order.product !== 'cap') return;
    const draft = JSON.parse(order.draft) as SponsorDraft;
    if (!draft.assetId || !draft.target) return;
    const asset = await db.getAsset(d, draft.assetId);
    if (!asset) return;
    const meta = JSON.parse(asset.metadata) as LookAssetMetadata;
    const upgrade =
      asset.status === 'qualified' && !!meta.look?.fallback && round === 2;
    if (asset.status !== 'logo' && !upgrade) return;
    await db.markTailorRequested(d, asset.id, {
      round,
      requestedAt: Date.now(),
      ...(meta.tailor?.reasons ? { reasons: meta.tailor.reasons } : {}),
    });
    const { url, token } = sponsorMediaConfig(v);
    const response = await fetch(new URL('/tailor', url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        assetId: asset.id,
        round,
        target: draft.target,
        logoUrl: meta.logoUrl,
        logoSha256: meta.logoSha256,
        palette: meta.palette,
        projectName: draft.projectName ?? '',
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
    };
    if (response.status >= 400 && response.status < 500 && response.status !== 409) {
      await db.applyLook(d, asset.id, {
        kind: 'refused',
        reason:
          body.error ||
          `The tailor refused this logo (${body.code ?? response.status}).`,
        round,
      });
      return;
    }
    console.warn(
      '[sponsorship] tailor deferred',
      asset.id,
      response.status,
      body.code ?? '',
    );
  } catch (e) {
    console.warn(
      '[sponsorship] tailor deferred',
      orderId,
      e instanceof Error ? e.message : 'request failed',
    );
  }
}
```

In `recoverAttempt`: change the signature's `v: SponsorVars` to `v: SponsorMediaVars`; change `let broadcastAmbiguous = false;` to

```ts
    let broadcastAmbiguous = false,
      paidNow = false;
```

change the three settle sites (once under `if (offered)`, once under `if (a.broadcast_signature)`):

```ts
      if (proof)
        paidNow =
          (await db.settlePayment(d, a.id, proof, now)).orderPaidNow || paidNow;
```

and the loop:

```ts
    for (const proof of scan.payments)
      paidNow =
        (await db.settlePayment(d, a.id, proof, now)).orderPaidNow || paidNow;
```

After the attempt bookkeeping `.run();`, before `return db.getAttempt(d, a.id);`:

```ts
    // The one moment this order became paid, still under the attempt lock: ask for its look.
    if (paidNow) await requestTailor(d, v, a.order_id, 1);
```

Widen the other three: `async function quote(d: D1Database, v: SponsorMediaVars, …`, `export async function reconcileSponsorships(v: SponsorMediaVars)`, `export async function handleSponsorship(request: Request, v: SponsorMediaVars)`.

`app/api/sponsorship/route.ts` whole:

```ts
import { env } from 'cloudflare:workers';
import { handleSponsorship, type SponsorMediaVars } from '@/lib/sponsor-server';
export const GET = (request: Request) =>
  handleSponsorship(request, env as unknown as SponsorMediaVars);
export const POST = GET;
```

`app/api/sponsorship/reconcile/route.ts`: in the import replace `type SponsorVars,` with `type SponsorMediaVars,` and `const v = env as unknown as SponsorVars;` with `const v = env as unknown as SponsorMediaVars;`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-server.test.mjs tests/sponsor-context.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-server.ts app/api/sponsorship/route.ts app/api/sponsorship/reconcile/route.ts tests/sponsorship-server.test.mjs
git commit -m "Paying for a cap starts its tailoring at once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-13: The reconciler keeps a stuck look moving

**Files:**
- Modify: `lib/sponsor-server.ts` — `reconcileSponsorships` (the `attempts` read, the idle short-circuit, the loop's tail)
- Test: `tests/sponsorship-server.test.mjs` (append; uses `withDesk`, `insertAsset`, `capMeta`, `qualifiedMeta`, `CAP_DRAFT`, `ASSET`, `assetMeta`, `rowsWritten`)

**Interfaces:**
- Consumes: `db.tailorProbe` (site-4), `db.applyLook` (site-3), `requestTailor` (site-12).
- Produces: `reconcileSponsorships` runs the probe as one more read; an idle pass (no attempts, no probe rows) still returns `{ ok: true, idle: true, checked: 0, errors: 0 }` and writes nothing; otherwise `{ ok: true, checked, errors, tailored }`. `nextRound ≤ 3` → `requestTailor(orderId, nextRound)`; `nextRound > 3` → `applyLook(refused)` with `"We couldn't finish tailoring this logo."`.

- [x] **Step 1: Write the failing test**

```js
void test('the reconciler re-requests a stuck look with the next round, gives up after the third, and upgrades a fallback', async (t) => {
  const f = await fixture();
  try {
    t.mock.method(console, 'warn', () => {});
    const desk = withDesk(f);
    const MIN = 60000;
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    await db.createOrder(f.DB, { id: 'stuck', tokenHash: 'stuck', draft: CAP_DRAFT, now: clock });
    f.DB.sql
      .prepare("UPDATE sponsor_orders SET status='paid',paid_attempt_id='paid',paid_at=? WHERE id='stuck'")
      .run(clock);
    insertAsset(f, 'logo', capMeta({ tailor: { round: 1, requestedAt: clock } }));
    // Inside the round's four minutes: idle, and not one row written.
    const before = rowsWritten(f);
    assert.deepEqual(await server.reconcileSponsorships(desk.v), { ok: true, idle: true, checked: 0, errors: 0 });
    assert.equal(rowsWritten(f), before);
    assert.equal(desk.tailors.length, 0);
    clock += 4 * MIN + 1;
    let result = await server.reconcileSponsorships(desk.v);
    assert.equal(result.tailored, 1, JSON.stringify(result));
    assert.equal(desk.tailors.length, 1);
    assert.equal(desk.tailors[0].body.round, 2);
    assert.equal(assetMeta(f).tailor.round, 2);
    assert.equal((await server.reconcileSponsorships(desk.v)).idle, true, 'round 2 is in flight');
    clock += 4 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    assert.equal(desk.tailors.length, 2);
    assert.equal(desk.tailors[1].body.round, 3);
    clock += 4 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    assert.equal(desk.tailors.length, 2, 'no fourth round');
    const row = f.DB.sql.prepare('SELECT status,metadata FROM sponsor_assets WHERE id=?').get(ASSET);
    assert.equal(row.status, 'refused');
    assert.match(JSON.parse(row.metadata).reason, /couldn't finish tailoring/);
    clock += 60 * MIN;
    assert.equal((await server.reconcileSponsorships(desk.v)).idle, true, 'a refused logo is left alone');
    // A first-round fallback gets one upgrade after ten minutes.
    const fallback = qualifiedMeta();
    fallback.look.fallback = 'cap-v1';
    fallback.tailor = { round: 1, requestedAt: clock, outcome: 'look', at: clock };
    insertAsset(f, 'qualified', fallback);
    clock += 10 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    assert.equal(desk.tailors.length, 3);
    assert.equal(desk.tailors[2].body.round, 2);
    clock += 60 * MIN;
    assert.equal((await server.reconcileSponsorships(desk.v)).idle, true, 'one upgrade only');
  } finally {
    f.restore();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-server.test.mjs`
Expected: FAIL — `result.tailored` is `undefined` (the pass is idle: the reconciler does not look at assets yet).

- [x] **Step 3: Write minimal implementation**

In `reconcileSponsorships` replace the `attempts` read and its idle check:

```ts
  // Open quotes always; an expired one only while a late payment could still arrive, and
  // then no more than every few minutes; a verified one never. And the looks the tailor
  // still owes: a round that went unanswered, a spent logo, a fallback due its upgrade.
  const [attempts, tailoring] = await Promise.all([
    d
      .prepare(
        `SELECT * FROM sponsor_payment_attempts WHERE status IN ('issued','submitted') OR (status='expired' AND issued_at>? AND last_checked_at<?) ORDER BY CASE WHEN status IN ('issued','submitted') THEN 0 ELSE 1 END,last_checked_at ASC LIMIT 10`,
      )
      .bind(
        now - interactLimits.recoverWindowMs,
        now - interactLimits.recoverRecheckMs,
      )
      .all<db.AttemptRow>(),
    db.tailorProbe(d, now),
  ]);
  if (!attempts.results.length && !tailoring.length)
    return { ok: true, idle: true, checked: 0, errors: 0 };
```

and replace `    return { ok: true, checked, errors };` at the end of the `try` block with:

```ts
    let tailored = 0;
    for (const job of tailoring) {
      if (Date.now() - now > 40000) break;
      if (job.nextRound > 3) {
        // Three rounds without a look: the logo is refused, and the receipt offers a new one.
        await db.applyLook(d, job.assetId, {
          kind: 'refused',
          reason:
            "We couldn't finish tailoring this logo.",
          round: 3,
        });
        continue;
      }
      await requestTailor(d, v, job.orderId, job.nextRound);
      tailored++;
    }
    return { ok: true, checked, errors, tailored };
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-server.test.mjs && npx tsc --noEmit`
Expected: PASS, including the two existing reconciler tests (`a reconcile pass with nothing to do reads, and writes nothing` still deep-equals the idle result).

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-server.ts tests/sponsorship-server.test.mjs
git commit -m "The reconciler keeps a stuck look moving: next round, then a fresh logo, and one better fit for a fallback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-14: A paid buyer can hand the tailor a different logo

**Files:**
- Modify: `lib/sponsor-server.ts` — add `replaceLogo()` above `export async function handleSponsorship`; one new branch in the action chain
- Test: `tests/sponsorship-server.test.mjs` (append; uses `withDesk`, `insertAsset`, `capMeta`, `qualifiedMeta`, `CAP_DRAFT`, `ASSET`)

**Interfaces:**
- Consumes: `qualifiedSponsorAsset(…, 'order')` (site-5), `requestTailor` (site-12), `db.getAsset`.
- Produces: `POST /api/sponsorship { action: 'replaceLogo', token, assetId }` (order-token authenticated, like `quote`; the panel also sends `orderId`, which the handler ignores — never add an `orderId !== order.id` check). Allowed while the order is `paid` and its current asset is `refused`, `logo` for more than ten minutes since the order last paid or changed its logo (`MAX(paid_at, updated_at)`), or `qualified` wearing `look.fallback`. The new asset must pass the `order` gate for the same target (its message is the response otherwise). Writes `draft.assetId` + `updated_at` (one UPDATE, guarded on `status='paid'`), resets `metadata.tailor` when the id is unchanged, then `requestTailor(round 1)`. Answers the receipt.

- [x] **Step 1: Write the failing test**

```js
void test('a paid buyer may swap the logo when the tailor gave up, stalled, or fell back', async (t) => {
  const f = await fixture();
  try {
    t.mock.method(console, 'warn', () => {});
    const desk = withDesk(f);
    const MIN = 60000;
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const OTHER = 'e'.repeat(64),
      THIRD = 'a'.repeat(63) + 'b';
    const metaFor = (id, extra = {}) =>
      capMeta({
        logoSha256: id.slice(0, 1).repeat(64),
        logoUrl: `https://show.test/api/sponsorship/assets/${id}?part=logo`,
        ...extra,
      });
    const token = 'f'.repeat(64);
    await db.createOrder(f.DB, {
      id: 'swap',
      tokenHash: await server.hashSponsorToken(token),
      draft: CAP_DRAFT,
      now: clock,
    });
    const swap = (assetId) => post(desk.v, { action: 'replaceLogo', token, assetId });
    const current = () =>
      JSON.parse(f.DB.sql.prepare('SELECT draft FROM sponsor_orders WHERE id=?').get('swap').draft).assetId;
    insertAsset(f, 'refused', capMeta({ reason: 'Too thin.' }));
    insertAsset(f, 'logo', metaFor(OTHER), OTHER);
    insertAsset(f, 'logo', metaFor(THIRD), THIRD);
    // 1. Not before it is paid.
    assert.equal((await swap(OTHER)).status, 409);
    f.DB.sql
      .prepare("UPDATE sponsor_orders SET status='paid',paid_attempt_id='paid',paid_at=?,updated_at=? WHERE id='swap'")
      .run(clock, clock);
    // 2. A refused logo is swapped at once; the new one starts its rounds fresh.
    const swapped = await swap(OTHER);
    assert.equal(swapped.status, 200, JSON.stringify(await swapped.clone().json()));
    const { receipt } = await swapped.json();
    assert.equal(receipt.draft.assetId, OTHER);
    assert.deepEqual(receipt.look, { status: 'tailoring', round: 1 });
    assert.deepEqual(desk.tailors.map((c) => [c.body.assetId, c.body.round]), [[OTHER, 1]]);
    // 3. A logo that is tailoring stays put for ten minutes, then may go.
    const early = await swap(THIRD);
    assert.equal(early.status, 409);
    assert.match((await early.json()).error, /still being tailored/);
    clock += 10 * MIN + 1;
    assert.equal((await swap(THIRD)).status, 200);
    assert.equal(current(), THIRD);
    assert.equal(desk.tailors.length, 2);
    // 4. The new logo must itself be dressable for this host: the tailor's reason comes back.
    clock += 10 * MIN + 1;
    const bad = await swap(ASSET);
    assert.equal(bad.status, 409);
    assert.match((await bad.json()).error, /Too thin/);
    assert.equal(current(), THIRD);
    // 5. A fallback look may be improved on; a real look may not be swapped away.
    const fallback = { ...qualifiedMeta(), ...metaFor(THIRD) };
    fallback.look = { ...qualifiedMeta().look, fallback: 'cap-v1' };
    insertAsset(f, 'qualified', fallback, THIRD);
    assert.equal((await swap(OTHER)).status, 200, 'a fallback can be improved on');
    assert.equal(current(), OTHER);
    assert.equal(desk.tailors.length, 3);
    clock += 10 * MIN + 1;
    insertAsset(f, 'qualified', { ...qualifiedMeta(), ...metaFor(THIRD) }, THIRD);
    const ready = await swap(THIRD);
    assert.equal(ready.status, 200, 'a finished look is taken as it is');
    assert.equal((await ready.json()).receipt.look.status, 'ready');
    assert.equal(desk.tailors.length, 3, 'nothing to tailor for a finished look');
    assert.equal((await swap(OTHER)).status, 409, 'a real look is not swapped away');
    // 6. The same logo again resets its rounds instead of changing the order.
    insertAsset(
      f,
      'logo',
      metaFor(THIRD, { tailor: { round: 3, requestedAt: clock - 30 * MIN, outcome: 'deadline', at: clock - 20 * MIN } }),
      THIRD,
    );
    clock += 10 * MIN + 1;
    assert.equal((await swap(THIRD)).status, 200);
    assert.equal(current(), THIRD);
    assert.equal(desk.tailors.length, 4);
    assert.equal(desk.tailors[3].body.assetId, THIRD);
    assert.equal(desk.tailors[3].body.round, 1);
  } finally {
    f.restore();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsorship-server.test.mjs`
Expected: FAIL — the first `swap` answers 400 "Unknown action." where 409 is expected.

- [x] **Step 3: Write minimal implementation**

Insert above `export async function handleSponsorship(`:

```ts
/** How long a logo may keep tailoring before the buyer may swap it for another. */
const REPLACE_AFTER_MS = 600000;
/**
 * A paid buyer picks a different logo when the tailor gave up on theirs, has been at it for
 * more than ten minutes, or could only manage the fallback cap print. The new logo must pass
 * the order gate for the same host; the order's draft then names it and round 1 starts. The
 * same logo again resets its rounds instead.
 */
async function replaceLogo(
  d: D1Database,
  v: SponsorMediaVars,
  order: db.OrderRow,
  assetId: string,
) {
  const draft = JSON.parse(order.draft) as SponsorDraft;
  if (order.product !== 'cap' || order.status !== 'paid')
    throw new SponsorError(
      409,
      'A logo can be changed on a paid cap that is not on air yet.',
    );
  if (!/^[a-f0-9]{64}$/.test(assetId))
    throw new SponsorError(400, 'Choose a logo to use instead.');
  await qualifiedSponsorAsset(d, { ...draft, assetId }, undefined, 'order');
  const current = draft.assetId ? await db.getAsset(d, draft.assetId) : null;
  let meta: Partial<LookAssetMetadata> = {};
  try {
    meta = current ? JSON.parse(current.metadata) : {};
  } catch {}
  const now = Date.now();
  const since = Math.max(order.paid_at ?? 0, order.updated_at);
  const swappable =
    !current ||
    current.status === 'refused' ||
    (current.status === 'logo' && now - since > REPLACE_AFTER_MS) ||
    (current.status === 'qualified' && !!meta.look?.fallback);
  if (!swappable)
    throw new SponsorError(
      409,
      'This logo is still being tailored. Give it a few more minutes.',
    );
  const changed = await d
    .prepare(
      `UPDATE sponsor_orders SET draft=json_set(draft,'$.assetId',?),updated_at=? WHERE id=? AND status='paid'`,
    )
    .bind(assetId, now, order.id)
    .run();
  if (changed.meta.changes !== 1)
    throw new SponsorError(409, 'This cap just went on air.', 'LEASE');
  if (current && current.id === assetId)
    await d
      .prepare(
        `UPDATE sponsor_assets SET metadata=json_remove(metadata,'$.tailor') WHERE id=? AND status='logo'`,
      )
      .bind(assetId)
      .run();
  await requestTailor(d, v, order.id, 1);
}
```

In `handleSponsorship`, replace the line `    if (action === 'confirm' && !body.attemptId) {` with:

```ts
    if (action === 'replaceLogo') {
      await replaceLogo(d, v, order, string(body.assetId, 100));
    } else if (action === 'confirm' && !body.attemptId) {
```

(The chain's tail already answers with the fresh receipt.)

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsorship-server.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-server.ts tests/sponsorship-server.test.mjs
git commit -m "A paid buyer can hand the tailor a different logo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-15: The devnet purchase rehearsal waits for the look

**Files:**
- Modify: `scripts/sponsorpay.mjs` — the header comment (lines 8-11), the cap health gate (`if (!health.capQualified)` block), `qualifyLogo` (accept a `logo` upload), and a new check after `the placement is paid and verified on chain`
- Test: none automated (the script runs against the deployed devnet worker). Verify with `node --check` and one devnet run.

**Interfaces:**
- Consumes: `GET /api/sponsorship/assets` health `{ ready, tailor, templateVersion }` (site-8); upload answer `{ id, status: 'logo' | 'qualified', url, logoUrl }` (site-7); `receipt.look` (site-6); `until(check, { tries, everyMs })` from `scripts/devnet.mjs`.
- Produces: the script refuses to run a cap purchase unless `health.ready && health.tailor`; accepts an upload answered `logo` or `qualified`; after payment polls `confirm` until `receipt.look.status !== 'tailoring'` (up to 7.5 minutes) and reports the outcome.

- [x] **Step 1: Edit the script**

Header comment lines 8-11 become:

```js
// PRODUCT picks the placement (spotlight, the default; cap). A spotlight takes
// PROJECT and STYLE (intro, debate or gentle-roast). A cap takes PROJECT, TARGET (host or
// guest) and LOGO, a PNG, JPG or WebP path the site has the desk normalise before anything is
// quoted; the tee and cap are tailored after payment. ASSET_ID reuses a logo already uploaded.
```

The cap health gate:

```js
// The stand-in studio offers what a real one would: a cap only when one is being bought, and
// then with the wardrobe version the desk tailors on. The site refuses to quote a placement
// the producer has not said it can deliver, and checks the logo against that version.
const capabilities = { message: true, spotlight: true, cap: PRODUCT === 'cap' };
if (PRODUCT === 'cap') {
  const health = await fetch(`${SITE}/api/sponsorship/assets`)
    .then((r) => r.json())
    .catch(() => ({}));
  if (health.ready !== true || health.tailor !== true)
    throw Error(
      `${SITE} cannot tailor a look right now: ${JSON.stringify(health)}`,
    );
  capabilities.capTemplateVersion = health.templateVersion;
}
```

`qualifyLogo` becomes `uploadLogo` (and the `qualified` promise `uploaded`); only the comment, the check and the names change:

```js
// ---- a cap's logo is normalised by the desk before it can be sold; the look comes after
// payment. The upload takes a few seconds, so it starts now, before the stand-in studio claims
// its thirty-second producer window, and is awaited only when the draft needs it.
const TARGET = process.env.TARGET === 'guest' ? 'guest' : 'host';
async function uploadLogo(path) {
  const type = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extname(path).toLowerCase()];
  if (!type) throw Error('LOGO must be a PNG, JPG or WebP file.');
  const form = new FormData();
  form.set('image', new File([await readFile(path)], basename(path), { type }));
  form.set('kind', 'cap');
  form.set('target', TARGET);
  const started = Date.now();
  const r = await fetch(`${SITE}/api/sponsorship/assets`, {
    method: 'POST',
    body: form,
  });
  const uploaded = await r.json().catch(() => ({}));
  check(
    'the logo is accepted',
    r.ok && ['logo', 'qualified'].includes(uploaded.status),
    r.ok
      ? `asset ${uploaded.id} (${uploaded.status}) in ${Date.now() - started} ms`
      : `${r.status} ${JSON.stringify(uploaded)}`,
  );
  return uploaded.id;
}
const uploaded =
  PRODUCT === 'cap' && !process.env.ASSET_ID
    ? uploadLogo(process.env.LOGO)
    : Promise.resolve(process.env.ASSET_ID);
```

and in the draft body: `...(PRODUCT === 'cap' && { target: TARGET, assetId: await uploaded }),`.

After the `check('the placement is paid and verified on chain', …)` call add:

```js
// ---- a cap's look is tailored after payment: usually one to two minutes, three fits at most
// inside the desk's 210 s job, and a second round from the reconciler four minutes on.
if (PRODUCT === 'cap' && paid) {
  const started = Date.now();
  const look = await until(
    async () => {
      const r = await api({ action: 'confirm', token });
      const l = r.body.receipt?.look;
      return l && l.status !== 'tailoring' ? l : null;
    },
    { tries: 90, everyMs: 5000 },
  );
  check(
    'the tee and cap are tailored',
    look?.status === 'ready',
    look
      ? `${look.status}${look.fallback ? ` (${look.fallback} fallback)` : ''} after ${Math.round((Date.now() - started) / 1000)} s — ${look.url ?? look.reason ?? ''}`
      : 'no look after 7.5 minutes',
  );
}
```

- [x] **Step 2: Check the script parses**

Run: `node --check scripts/sponsorpay.mjs`
Expected: no output, exit 0.

- [x] **Step 3: Rehearse once the desk reports `tailor: true` (spec "Verification on devnet" step 4)**

Run: `SITE=https://<devnet site> STUDIO_TOKEN=… RPC_URL=https://api.devnet.solana.com PRODUCT=cap LOGO=public/logo.png node scripts/sponsorpay.mjs`
Expected: `ok  the logo is accepted — asset … (logo) in … ms`, `ok  the placement is paid and verified on chain`, `ok  the tee and cap are tailored — ready after … s — https://…?part=look&v=…`.

- [x] **Step 4: Commit**

```bash
git add scripts/sponsorpay.mjs
git commit -m "The devnet purchase rehearsal waits for the tailored look

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task site-16: The media workflow gates on a desk that can tailor

**Files:**
- Modify: `.github/workflows/media.yml` — `paths` (both triggers), the runtime job's pip line and test list, the image job's container run and smoke test
- Test: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/media.yml','utf8'))"` (parses) + the workflow's own run on the PR

**Interfaces:**
- Consumes: desk `/health` `{ ready, tailor, templateVersion: 'looks-v1' }`; desk `POST /logo?target=host` → 401 without the bearer, 200 `{ logo, logoSha256, width, height, palette }` with it (contract); `scripts/wardrobe.py` + `tests/wardrobe.test.py` from the desk section; the `FAL_KEY` repository secret (optional).
- Produces: a workflow that fails unless `/health` says `ready: true` and `templateVersion: 'looks-v1'` (and `tailor: true` when `FAL_KEY` is set), that smoke-tests `/logo` instead of `/preview`, and that no longer runs the retired `tests/sponsor-render.test.mjs`.

- [x] **Step 1: Edit the workflow**

In both `paths:` lists: remove `- 'lib/sponsor-media.ts'` and `- 'tests/sponsor-render.test.mjs'`; add `- 'scripts/wardrobe.py'` and `- 'tests/wardrobe.test.py'`.

Runtime job — the pip line becomes `python -m pip install --no-cache-dir $PINS pytest`; after the `Renderer` step add:

```yaml
      - name: Tailor scripts
        run: python -m pytest -q tests/wardrobe.test.py
```

and the media test list becomes:

```yaml
          WEARABLE_PYTHON="$(which python)" node --test --test-reporter=tap \
            tests/sponsor-media.test.mjs tests/sponsor-assets.test.mjs \
            | tee media-tests.tap
```

Image job — the smoke-test step whole:

```yaml
      # The service is given what Railway gives it (scripts/media.mjs mediaVariables), with a
      # throwaway token, then asked the two things the site depends on: /health and /logo.
      - name: Smoke-test the container
        shell: bash
        env:
          FAL_KEY: ${{ secrets.FAL_KEY }}
        run: |
          TOKEN=$(openssl rand -hex 24)
          echo "::add-mask::$TOKEN"
          docker run -d --name media -p 4017:4017 \
            -e SPONSOR_MEDIA_TOKEN="$TOKEN" \
            -e SPONSOR_SITE_ORIGIN=https://interdimensional-podcast-staging.leonardo-chekup.workers.dev \
            -e FAL_KEY="$FAL_KEY" \
            -e MEDIA_CONCURRENCY=2 -e MEDIA_QUEUE=6 \
            -e PORT=4017 -e SPONSOR_MEDIA_PORT=4017 \
            sponsor-media:ci

          # Ready on the tailored wardrobe; and able to tailor when there is a key to try with.
          for i in $(seq 1 60); do
            CODE=$(curl -s -o health.json -w '%{http_code}' http://127.0.0.1:4017/health || true)
            if [ "$CODE" = 200 ] && node -e "
              const h = require('./health.json');
              const ok = h.ready === true && h.templateVersion === 'looks-v1' && (!process.env.FAL_KEY || h.tailor === true);
              process.exit(ok ? 0 : 1);
            " 2>/dev/null; then
              echo "health: $(cat health.json)"
              break
            fi
            if [ "$i" = 60 ]; then
              echo "::error::/health never answered 200 with ready on looks-v1 (last answer: $CODE)."
              cat health.json 2>/dev/null || true
              exit 1
            fi
            sleep 2
          done

          LOGO='http://127.0.0.1:4017/logo?target=host'
          CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: image/png' \
            --data-binary @public/logo.png "$LOGO")
          if [ "$CODE" != 401 ]; then
            echo "::error::/logo without the token answered $CODE, not 401."
            exit 1
          fi

          CODE=$(curl -s -o logo.json -w '%{http_code}' -X POST -H 'content-type: image/png' \
            -H "authorization: Bearer $TOKEN" --data-binary @public/logo.png "$LOGO")
          if [ "$CODE" != 200 ]; then
            echo "::error::/logo with the token answered $CODE, not 200."
            head -c 500 logo.json || true
            exit 1
          fi
          node -e "
            const p = require('./logo.json');
            const ok = /^[a-f0-9]{64}$/.test(p.logoSha256) && p.logo?.length > 100 &&
              p.width > 0 && p.height > 0 && typeof p.palette?.primary === 'string';
            console.log(JSON.stringify({ ...p, logo: p.logo?.length }));
            process.exit(ok ? 0 : 1);
          "
```

Update the file's opening comment to say the first job runs "the renderer, the tailor scripts and the media tests" and the second "makes the calls the site makes: `/health` and `/logo`".

- [x] **Step 2: Check the workflow parses**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/media.yml','utf8')); console.log('ok')"`
Expected: `ok`.

- [x] **Step 3: Commit**

```bash
git add .github/workflows/media.yml
git commit -m "The media workflow checks the desk can tailor, and smoke-tests the logo route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The workflow itself runs on the pull request; its `image` job is the real verification.)

---

### Task site-17: Retire the tracker-era render path

**Precondition:** the show section's `lib/services.ts` change has landed (the studio no longer posts to `/api/sponsorship/media`). Until then the route must stay.

**Files:**
- Delete: `lib/sponsor-media.ts`, `app/api/sponsorship/media/route.ts`, `tests/sponsor-render.test.mjs` (its live `ASSET` assertions were moved in site-5)
- Modify: `tests/sponsor-context.test.mjs` — the build list, the `renderSponsorMedia` import, and the last test
- Test: `tests/sponsor-context.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing; `renderSponsorMedia` no longer exists. `sponsorMediaConfig`/`SponsorMediaVars` stay re-exported from `lib/sponsor-assets.ts` (harmless; the routes import them from there).

- [x] **Step 1: Delete the files and fix the context test**

```bash
git rm lib/sponsor-media.ts app/api/sponsorship/media/route.ts tests/sponsor-render.test.mjs
```

In `tests/sponsor-context.test.mjs`: remove `  'sponsor-media',` from the `build([...])` list; delete the line `const { renderSponsorMedia } = await import('../work/tests/sponsor-media.js');`; replace the last test (`'context and media bridges forward the canonical legacy producer identity'`) with:

```js
void test('the context bridge forwards the canonical legacy producer identity', async (t) => {
  for (const [name, id, expected] of [
    ['absent', undefined, 'studio'],
    ['trimmed', '  studio-a  ', 'studio-a'],
    ['invalid', 'studio/a', 'studio'],
    ['long', 'a'.repeat(40), 'a'.repeat(32)],
  ]) {
    await t.test(name, async (t) => {
      const calls = [];
      t.mock.method(globalThis, 'fetch', (url, options) => {
        calls.push(new URL(url).pathname);
        assert.equal(options.headers['x-studio-token'], vars.STUDIO_TOKEN);
        assert.equal(options.headers['x-studio-id'], expected);
        return Promise.resolve(Response.json({ order: { id: 'order' } }));
      });
      const order = await resolveTrustedSponsor(
        new Request('http://127.0.0.1:3212/api/podcast'),
        { ...vars, STUDIO_ID: id },
        reference,
      );
      assert.equal(order.id, 'order');
      assert.deepEqual(calls, ['/api/sponsorship']);
    });
  }
});
```

- [x] **Step 2: Run the tests and the type check**

Run: `node --test tests/sponsor-context.test.mjs tests/sponsor-assets.test.mjs tests/sponsorship-server.test.mjs && npx tsc --noEmit && grep -rn "sponsor-media'" lib app tests --include='*.ts' --include='*.tsx' --include='*.mjs'`
Expected: PASS; tsc clean; the grep prints nothing.

- [x] **Step 3: Commit**

```bash
git add tests/sponsor-context.test.mjs
git commit -m "Retire the per-clip cap render: the look is made once, before the first clip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`git rm` already staged the three deletions.)

---

## Section self-review (site)

- **Spec coverage.** §2.0 asset gate → site-5; §2.1 upload → site-7; §2.2 settle/requestTailor/`SponsorMediaVars` → site-2, site-12; §2.3 callback → site-3, site-11; §2.4 reconciler → site-4, site-13; §2.5 lease gate (unchanged SQL, pinned in site-4), `MediaHealth.tailor` → site-8, heartbeat → site-9, `sponsorpay.mjs` → site-15, `media.yml` → site-16; §2.6 serving → site-10; §2.7 replaceLogo → site-14; §2.8 receipt → site-1, site-6; draft copy → site-1; retirement + moved `ASSET` assertions → site-5, site-17. **Not in this section:** `scripts/media.mjs health` copy ("Ready to tailor looks" / "Up, but FAL_KEY is missing…") and its assertion in `tests/railway.test.mjs` (`/Ready to sell caps/`, health fixture `capQualified`) — the desk section owns `scripts/media.mjs`; `docs/SPONSORSHIP.md`, `docs/LAUNCH.md`, `.dev.vars.example`, `README.md` — the docs/UI section; `tests/sponsor-playback-recovery.test.mjs:42` still mocks `{ ready: false, capQualified: false }`, which stays correct (`tailor` absent reads as false).
- **Type consistency.** `LookOutcome` (site-3) is what `receiveLook` (site-11), `requestTailor` (site-12) and the reconciler (site-13) pass; `qualifiedSponsorAsset(d, draft, caps, stage)` (site-5) is called with `'order'`/`'air'` in site-5 and site-14; `SponsorMediaVars` is defined once (site-5) and consumed by site-7/10/11/12/13/14; `tailorProbe` rows `{ orderId, assetId, nextRound, upgrade }` (site-4) are read as such in site-13; `receipt.look` (site-1/6) is what site-12/14/15 read.


---

## Part C: Show — clip contract, services, route pin, one wardrobe per run, writer (show-1 … show-9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this section task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is one section of the tailored-wardrobe plan; it shares every name in `CONTRACT.md` with the desk, site and UI sections.

**Goal:** The studio renders a dressed line from the tailored look (host already in the tee and cap) with no per-clip compositing, drops the dressing for a whole run of a host's lines the moment one dressed take is refused, and tells the writer about both garments.

**Architecture:** `shotInput` already conditions both frames on `wardrobe.sourceUrl`; only its prompt suffix changes. `lib/services.ts` loses the cap-only branch (no scaler skip, no `/api/sponsorship/media`, no direct download), so a dressed clip is scaled, audited and downloaded like any other. The route turns a wardrobe-pin mismatch into `SponsorError(409, …, 'ASSET')`, which the studio already maps to `PlacementLostError`. "One wardrobe per run" is split between `SponsorProgram.undressed()` (a note that keeps not-yet-decorated lines undressed until the next cut) and `Podcast.rejectPlacement` (which undresses the committed run-mate and counts a `wardrobe-flip` when the earlier half already aired). The writer's placement line, duties and judge wording name the tee and the cap. `lib/video-frames.ts` gains `originalUrl` (the uncropped 1376×768 still the tailor edits), written by `scripts/video-frames.mjs` from `character-assets.json`.

**Tech Stack:** TypeScript (Cloudflare Worker route + browser engine), Node 22 `node:test` + `node:assert/strict` `.mjs` tests transpiling `lib/*.ts` through `tests/build.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-13-tailored-wardrobe-design.md` §3 "The show", plus the "Tests → Show" bullet. Shared names: `scratchpad/plan/CONTRACT.md` → "Show".

## Global constraints (every task in this section)

- `LOOK_VERSION = 'looks-v1'` (exported from `lib/sponsorship.ts` by the site section); fixtures in this section use the literal `'looks-v1'`.
- Wardrobe suffix (exact, spec §3): `Keep the cap and the printed T-shirt exactly as in the reference: no new lettering, logos or accessories. Hands stay below the chest so the print stays visible. Headphones keep their exact placement; the camera stays fixed.`
- `sponsorshipRules` sentence (exact): `A wardrobe introduction names its sponsor and the host wearing its tee and cap; a callback names the same sponsor again naturally.`
- Writer wording (exact): intro `This is the introduction of {project}'s tee and cap on {wearer}; the first cut to {wearer} shows the logo printed on his T-shirt and cap.`; callback `the callback for {project}'s tee and cap on {wearer}`; duties `Mention the {project} tee and cap you are wearing.` / `Mention the {project} tee and cap {wearer} is wearing.`; judge TASK 1 `including the tee and cap he is wearing and how they feel`, TASK 2 `its pitch or the tee and cap`. `checkSponsoredDialogue` and its labels are unchanged.
- Route pin mismatch: `throw new SponsorError(409, 'The wardrobe revision does not match this purchased cap.', 'ASSET')`.
- `SponsorProgram.undressed(orderId: string, shotId: number): void`; `Podcast` calls `this.diagnose('wardrobe-flip', …)`.
- **Shared WIP files** (`lib/engine.ts`, `lib/show.ts`, `lib/services.ts`, `app/api/podcast/route.ts`, and the listed test files): other sessions hold uncommitted hunks in them. Edit ONLY by exact-string replacement of the snippets below, hand-format the hunk, never run oxfmt/prettier on them, never rewrite the file.
- Never `git add -A`; add the named files only. Commit messages are one plain sentence about the user-visible outcome and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Do not modify `scripts/wearable-render.py`, `scripts/wearable_panel.py`, `public/wearables/*`.
- Tests: `node --test tests/<file>`; type check: `npx tsc --noEmit`; lint touched files: `npx oxlint <files>`.
- Retiring `lib/sponsor-media.ts`, `app/api/sponsorship/media/route.ts`, `tests/sponsor-render.test.mjs` and the `/render`/`/preview` desk tests belongs to the site and desk sections, not here. `lib/services.ts` simply stops calling that route.

## File map

| File | Responsibility after this section |
| --- | --- |
| `scripts/video-frames.mjs` | Generates `lib/video-frames.ts`; now also copies and hash-checks `originalUrl` from `character-assets.json` |
| `lib/video-frames.ts` | Generated; gains `originalUrl` per host (hand-added once, matching what the script writes) |
| `lib/show.ts` | `shotInput` wardrobe suffix; `sponsorshipRules` wording |
| `lib/sponsor-writer.ts` | `placementLine`, `obligations`, `judgePrompt` name the tee and cap |
| `lib/services.ts` | A dressed clip takes the ordinary shot → scale → speech → `/api/media` path |
| `app/api/podcast/route.ts` | Pin mismatch is a `SponsorError` 409 `ASSET` |
| `lib/sponsor-program.ts` | `undressed()` note; `decorate` skips the rest of the run; note clears at a cut, on a played appearance, and on `beginRun` |
| `lib/engine.ts` | `rejectPlacement` undresses the committed run-mate, calls `undressed()`, diagnoses `wardrobe-flip`; `launch` ignores a stale dressed take |
| Tests | `tests/video-render.test.mjs`, `tests/cap-render-source.test.mjs` (rewritten), `tests/sponsor-wardrobe.test.mjs`, `tests/engine.test.mjs`, `tests/sponsor-program.test.mjs`, `tests/sponsor-writer.test.mjs`, `tests/podcast-route-refusals.test.mjs` |

## Task order

`show-1`, `show-2`, `show-3`, `show-4`, `show-5`, `show-6` are independent of each other. `show-7` (program note) must land before `show-8` (engine calls it). `show-9` extends `show-8`'s test helpers and engine hunk. A reviewer can reject any one of `show-1`…`show-7` without touching its neighbours.

---

### show-1: `originalUrl` — the uncropped still the tailor edits, pinned to its fal upload

**Files:**
- Modify: `scripts/video-frames.mjs:1-70` (whole script; not a shared-WIP file)
- Modify: `lib/video-frames.ts:10-13` and `:21-24` (hand-add the field the script now writes)
- Test: `tests/video-render.test.mjs` (header imports; one new test after the first test)

**Interfaces:**
- Consumes: `character-assets.json` → `sources['pepe-cartoon']`, `sources['gigachad-cartoon']` (fal CDN URLs of the branded 1376×768 originals; the local copies are `public/pepe-cartoon.png` and `public/gigachad-cartoon.png`, whose sha256 the frames module already pins as `originalSha256`).
- Produces: `videoFrames.host.originalUrl === 'https://v3b.fal.media/files/b/0aa99e7e/ViWtBAcKK0DXjM7kBLIvD_eid12yRD.png'` and `videoFrames.guest.originalUrl === 'https://v3b.fal.media/files/b/0aa99e9a/UUct9hv94FEzgs2dz2H26_JZaGMdjK.png'` (type: string literal members of the `as const` object exported from `lib/video-frames.ts`). The desk keeps the same two URLs in its own `BASE_STILLS` table (the media image ships no `lib/`); a desk test pins them to `character-assets.json`, and this task pins `lib/video-frames.ts` to the same file, so the two cannot drift apart.

- [x] **Step 1: Write the failing test**

In `tests/video-render.test.mjs`, replace the header import block

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';

await build([
```

with

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from './build.mjs';

await build([
```

and replace

```js
const show = await import('../work/tests/show.js');
const { createServices } = await import('../work/tests/services.js');
```

with

```js
const show = await import('../work/tests/show.js');
const { videoFrames } = await import('../work/tests/video-frames.js');
const { createServices } = await import('../work/tests/services.js');
```

Then replace the end of the first test (this exact text occurs once)

```js
    assert.throws(() => show.scaleInput(url), /video URL/i);
});
```

with

```js
    assert.throws(() => show.scaleInput(url), /video URL/i);
});

// The tailor edits the uncropped 1376×768 original of each host, so the model's 16:9 1K
// answer lines up pixel for pixel with the still it was handed. That original was uploaded
// to fal once, when the stills were branded (character-assets.json); the generated frames
// module is where the show and the desk read it, so it is pinned to that source here.
void test('each host carries the fal URL of its uncropped original, the still the tailor edits', async () => {
  const { sources } = JSON.parse(await readFile('character-assets.json', 'utf8'));
  assert.equal(videoFrames.host.originalUrl, sources['pepe-cartoon']);
  assert.equal(videoFrames.guest.originalUrl, sources['gigachad-cartoon']);
  for (const role of ['host', 'guest']) {
    const url = new URL(videoFrames[role].originalUrl);
    assert.equal(url.protocol, 'https:');
    assert.ok(
      url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'),
      url.href,
    );
    assert.notEqual(
      videoFrames[role].originalUrl,
      videoFrames[role].source,
      'the original is not the cropped 1344×768 conditioning frame',
    );
    assert.equal(videoFrames[role].width, 1344);
  }
  // The next regeneration must keep writing the field from the same source.
  const generator = await readFile('scripts/video-frames.mjs', 'utf8');
  assert.match(generator, /character-assets\.json/);
  assert.match(generator, /\boriginalUrl\b/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/video-render.test.mjs`
Expected: FAIL — `each host carries the fal URL of its uncropped original…` with `AssertionError [ERR_ASSERTION]: undefined !== 'https://v3b.fal.media/files/b/0aa99e7e/…'` (no `originalUrl` yet). Every other test in the file still passes.

- [x] **Step 3: Teach the generator, then hand-add the field it would write**

Replace the whole of `scripts/video-frames.mjs` with:

```js
#!/usr/bin/env node
// Prepare both conditioning images on H3 Turbo's native canvas before uniform 1080P scaling.
// Requires ffmpeg. Uploads the prepared stills to fal; does not generate video.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fal, falKey } from './fal.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = await falKey();
// The uncropped originals were uploaded to fal once, when the stills were branded
// (character-assets.json). The tailor edits that same 1376×768 still, so its URL travels
// with the frames; the hash check proves the URL is this file and not an older cut.
const { sources } = JSON.parse(await readFile('character-assets.json', 'utf8'));
const frames = {};
for (const [role, name] of [
  ['host', 'pepe'],
  ['guest', 'gigachad'],
]) {
  const original = `public/${name}-cartoon.png`;
  const originalSha256 = sha256(await readFile(original));
  const originalUrl = sources[`${name}-cartoon`];
  if (typeof originalUrl !== 'string' || !originalUrl.startsWith('https://'))
    throw Error(`No fal URL for ${name}-cartoon in character-assets.json`);
  const remote = await fetch(originalUrl, { signal: AbortSignal.timeout(30000) });
  if (!remote.ok) throw Error(`Could not fetch ${originalUrl}: ${remote.status}`);
  const remoteSha256 = sha256(Buffer.from(await remote.arrayBuffer()));
  if (remoteSha256 !== originalSha256)
    throw Error(
      `${originalUrl} is not ${original}: sha256 ${remoteSha256} vs ${originalSha256}`,
    );
  const image = `/${name}-video.png`;
  // Fit without stretching, then center-crop. Current stills lose only 16 pixels on each side.
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    original,
    '-vf',
    'scale=1344:768:force_original_aspect_ratio=increase,crop=1344:768',
    '-frames:v',
    '1',
    '-y',
    `public${image}`,
  ]);
  // The same frame as WebP, for the pages that merely display it. The PNG below is the one
  // fal conditions on, so it must stay a pixel-exact PNG; the poster is ~20x smaller and is
  // what a phone downloads when someone opens a pasted link.
  const poster = `/${name}-video.webp`;
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', `public${image}`, '-quality', '82', '-y', `public${poster}`,
  ]);
  const bytes = await readFile(`public${image}`);
  const upload = await fal(
    'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
    key,
    {
      file_name: `${name}-video.png`,
      content_type: 'image/png',
    },
  );
  if (!upload.upload_url || !upload.file_url)
    throw Error(`No upload URL for ${role}`);
  const result = await fetch(upload.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
  });
  if (!result.ok) throw Error(`Upload failed for ${role}: ${result.status}`);
  frames[role] = {
    image,
    poster,
    source: upload.file_url,
    width: 1344,
    height: 768,
    original,
    originalUrl,
    originalSha256,
  };
  console.log(`${role}: prepared and uploaded 1344×768 frame`);
}
await writeFile(
  'lib/video-frames.ts',
  `// Generated by node scripts/video-frames.mjs. Keep conditioning and native video geometry identical.\nexport const videoFrames = ${JSON.stringify(frames, null, 2)} as const;\n`,
);
```

The script needs ffmpeg and a fal key and re-uploads the conditioning frames, so do NOT run it; hand-add the field it now writes. In `lib/video-frames.ts` replace

```ts
    original: 'public/pepe-cartoon.png',
    originalSha256:
```

with

```ts
    original: 'public/pepe-cartoon.png',
    originalUrl:
      'https://v3b.fal.media/files/b/0aa99e7e/ViWtBAcKK0DXjM7kBLIvD_eid12yRD.png',
    originalSha256:
```

and replace

```ts
    original: 'public/gigachad-cartoon.png',
    originalSha256:
```

with

```ts
    original: 'public/gigachad-cartoon.png',
    originalUrl:
      'https://v3b.fal.media/files/b/0aa99e9a/UUct9hv94FEzgs2dz2H26_JZaGMdjK.png',
    originalSha256:
```

- [x] **Step 4: Run the test to verify it passes, and prove the URLs are the files on disk**

Run: `node --test tests/video-render.test.mjs`
Expected: PASS (all tests).

Run (one-off, needs network; this is the same check the generator now makes):

```bash
node --input-type=module -e "
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const { sources } = JSON.parse(await readFile('character-assets.json', 'utf8'));
for (const name of ['pepe', 'gigachad']) {
  const local = createHash('sha256').update(await readFile('public/' + name + '-cartoon.png')).digest('hex');
  const res = await fetch(sources[name + '-cartoon']);
  const remote = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  console.log(name, local === remote ? 'matches' : 'MISMATCH local ' + local + ' remote ' + remote);
}"
```

Expected: `pepe matches` and `gigachad matches` (the local hashes are the `originalSha256` values already in `lib/video-frames.ts`: `a0a826…` and `dd9ed2…`). If either prints MISMATCH, stop and report it: the URL in `character-assets.json` is not the still on disk, and the tailor must not be pointed at it. If the network is unavailable, note that the check was skipped.

Run: `npx tsc --noEmit`
Expected: no errors.

- [x] **Step 5: Commit**

```bash
git add scripts/video-frames.mjs lib/video-frames.ts tests/video-render.test.mjs
git commit -m "$(cat <<'EOF'
Each host knows the uncropped still the tailor dresses, pinned to its upload

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-2: `shotInput` keeps the printed tee and cap in frame

**Files:**
- Modify: `lib/show.ts:231-238` (`shotInput` prompt suffix; shared-WIP file — exact replacement only)
- Test: `tests/video-render.test.mjs:48-69` (replace the "pinned cap" test)

**Interfaces:**
- Consumes: `shotInput(line: Line)` → `{ image_url, end_image_url, prompt, duration, resolution, prompt_expansion_mode, seed }` (unchanged shape); `Wardrobe = { orderId, leaseToken, target, assetId, designHash, sourceUrl, templateVersion }` from `lib/sponsor-program.ts`.
- Produces: for a line with `wardrobe`, `prompt` ends with the exact suffix in Global constraints; `image_url === end_image_url === wardrobe.sourceUrl`; the gesture is dropped (prompt and duration identical to the same line without a gesture).

- [x] **Step 1: Write the failing test**

In `tests/video-render.test.mjs` replace this whole test

```js
void test('a pinned cap keeps its canonical reference and defers obstructing gestures', () => {
  const sourceUrl = 'https://show.test/wearables/pepe-cap.png';
  const input = show.shotInput({
    id: 0,
    speaker: 'host',
    text: 'Of course.',
    gesture: 'tea',
    wardrobe: {
      orderId: 'order',
      leaseToken: 'lease',
      target: 'host',
      assetId: 'design',
      designHash: 'hash',
      sourceUrl,
      templateVersion: 'caps-v1',
    },
  });
  assert.equal(input.image_url, sourceUrl);
  assert.equal(input.end_image_url, sourceUrl);
  assert.match(input.prompt, /cap front unobstructed and blank/);
  assert.doesNotMatch(input.prompt, /takes a sip|lifts the mug/);
});
```

with

```js
// A dressed line is conditioned, at both ends, on the look: the host already wearing the tee
// with the logo printed on the chest and the cap in the brand's colours. The prompt keeps that
// print visible and invents nothing on it; a gesture would put a hand or a mug over the chest,
// so it is dropped on a dressed line and the shot is timed as plain speech.
void test('a dressed line conditions both frames on the look, keeps the print in shot and drops the gesture', () => {
  const sourceUrl =
    'https://show.test/api/sponsorship/assets/asset1?part=look&v=look1';
  const line = {
    id: 0,
    speaker: 'guest',
    text: 'Of course.',
    gesture: 'tea',
    wardrobe: {
      orderId: 'order',
      leaseToken: 'lease',
      target: 'guest',
      assetId: 'asset1',
      designHash: 'look1',
      sourceUrl,
      templateVersion: 'looks-v1',
    },
  };
  const input = show.shotInput(line);
  assert.equal(input.image_url, sourceUrl, 'the look is the start frame');
  assert.equal(input.end_image_url, sourceUrl, 'and the end frame');
  assert.ok(
    input.prompt.endsWith(
      ' Keep the cap and the printed T-shirt exactly as in the reference: no new lettering, logos or accessories. Hands stay below the chest so the print stays visible. Headphones keep their exact placement; the camera stays fixed.',
    ),
    input.prompt.slice(-320),
  );
  assert.doesNotMatch(input.prompt, /blank cap|cap front unobstructed|cap scale/);
  const plain = show.shotInput({ ...line, gesture: undefined });
  assert.equal(input.prompt, plain.prompt, 'the gesture is dropped on a dressed line');
  assert.equal(input.duration, plain.duration, 'and the shot is timed as plain speech');
  assert.match(
    show.shotInput({ ...line, wardrobe: undefined }).prompt,
    /unhurried sip/,
    'the same line undressed would have performed the gesture',
  );
  assert.doesNotMatch(input.prompt, /unhurried sip/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/video-render.test.mjs`
Expected: FAIL — `a dressed line conditions both frames on the look…` at `input.prompt.endsWith(…)` (the prompt still ends with `The camera and cap scale remain fixed.`). Other tests pass.

- [x] **Step 3: Replace the suffix**

In `lib/show.ts` replace exactly

```ts
/** One render contract for the server and the browser's job cache. */
export function shotInput(line: Line) {
  const wardrobe = line.wardrobe;
  const prompt =
    shotPrompt(line.speaker, line.text, wardrobe ? undefined : line.gesture) +
    (wardrobe
      ? ' Preserve the supplied blank cap exactly. Keep the cap front unobstructed and blank: no invented lettering or logos. Hands remain below the chest, head turns stay within four degrees, and headphones keep their exact placement. The camera and cap scale remain fixed.'
      : '');
```

with

```ts
/** One render contract for the server and the browser's job cache. A dressed line is
 * conditioned at both ends on the look (the host already in the tee and cap), so the prompt
 * only has to keep the print in shot and invent nothing on it. */
export function shotInput(line: Line) {
  const wardrobe = line.wardrobe;
  const prompt =
    shotPrompt(line.speaker, line.text, wardrobe ? undefined : line.gesture) +
    (wardrobe
      ? ' Keep the cap and the printed T-shirt exactly as in the reference: no new lettering, logos or accessories. Hands stay below the chest so the print stays visible. Headphones keep their exact placement; the camera stays fixed.'
      : '');
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tests/video-render.test.mjs`
Expected: PASS. Then `npx tsc --noEmit` → no errors.

- [x] **Step 5: Commit**

```bash
git add lib/show.ts tests/video-render.test.mjs
git commit -m "$(cat <<'EOF'
A dressed shot keeps the printed tee and cap in frame instead of guarding a blank cap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-3: the writer's sponsorship rules describe a tee and a cap

**Files:**
- Modify: `lib/show.ts:510` (`sponsorshipRules`; shared-WIP file — exact replacement only)
- Test: `tests/sponsor-writer.test.mjs` (one new test inserted before `an exchange that is not four spoken turns fails`)

**Interfaces:**
- Consumes: `export const sponsorshipRules: string` (`lib/show.ts`), `sponsoredWriterSystem(): string` and `writerSystemFor(brand?: CoinBrand): string`, which both join it into their system prompts.
- Produces: `sponsorshipRules` contains the exact sentence `A wardrobe introduction names its sponsor and the host wearing its tee and cap; a callback names the same sponsor again naturally.` and no longer `A cap introduction`.

- [x] **Step 1: Write the failing test**

In `tests/sponsor-writer.test.mjs` replace the line (occurs once)

```js
void test('an exchange that is not four spoken turns fails', () => {
```

with

```js
// The system prompt tells the writer what a wardrobe placement is. Both garments are named,
// so an introduction can say what the wearer has on without inventing it.
void test('the sponsorship rules describe a wardrobe introduction as a tee and a cap', () => {
  assert.match(
    S.sponsorshipRules,
    /A wardrobe introduction names its sponsor and the host wearing its tee and cap; a callback names the same sponsor again naturally\./,
  );
  assert.doesNotMatch(S.sponsorshipRules, /A cap introduction/);
  assert.ok(
    W.sponsoredWriterSystem().includes(S.sponsorshipRules),
    'the sponsored system prompt carries the same rules',
  );
  assert.ok(
    S.writerSystemFor().includes(S.sponsorshipRules),
    'and so does the free writer, which must refuse an unverified one',
  );
});

void test('an exchange that is not four spoken turns fails', () => {
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/sponsor-writer.test.mjs`
Expected: FAIL — `the sponsorship rules describe a wardrobe introduction…` at the first `assert.match` (`The input did not match the regular expression`).

- [x] **Step 3: Change the sentence**

In `lib/show.ts` replace exactly (this fragment occurs once, inside the `sponsorshipRules` template string)

```
A cap introduction names its sponsor and the host wearing it; a callback names the same sponsor again naturally.
```

with

```
A wardrobe introduction names its sponsor and the host wearing its tee and cap; a callback names the same sponsor again naturally.
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tests/sponsor-writer.test.mjs`
Expected: PASS. `npx tsc --noEmit` → no errors.

- [x] **Step 5: Commit**

```bash
git add lib/show.ts tests/sponsor-writer.test.mjs
git commit -m "$(cat <<'EOF'
The writer is told a wardrobe introduction is a tee and a cap, not a cap alone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-4: placement line, duties and judge name the tee and cap

**Files:**
- Modify: `lib/sponsor-writer.ts:157-168` (`placementLine`), `:201-212` (`obligations`), `:670-672` (`judgePrompt` TASK 1 and TASK 2)
- Test: `tests/sponsor-writer.test.mjs:739-766`, `:910-915`, `:1297-1301`

**Interfaces:**
- Consumes: `SponsorBrief = { orderId, product: 'message' | 'spotlight' | 'cap', buyer, project?, advertiserClaim, tone, wearingHost?, mention?: 'intro' | 'callback' }` (unchanged: no garment field); `sponsoredWriterRequest(brief, plan, opts?)`, `sponsorTurnPlan(prev?, brief?)`, `judgePrompt(lines, brief, previousLine?)`.
- Produces: the exact strings in Global constraints, reachable through `sponsoredWriterRequest(...)` (placement line + numbered duties) and `judgePrompt(...).prompt`.

- [x] **Step 1: Write the failing tests**

In `tests/sponsor-writer.test.mjs` replace this whole test

```js
void test('the cap is mentioned on the wearer’s first turn, and a callback is still disclosed', () => {
  const cap = {
    ...elixir,
    product: 'cap',
    wearingHost: 'GigaChad',
    mention: 'intro',
  };
  const lines = (brief, prev) =>
    W.sponsoredWriterRequest(brief, W.sponsorTurnPlan(prev)).split('\n');
  const chad = lines(cap);
  assert.match(
    chad.find((line) => line.startsWith('2. ')),
    /^2\. GigaChad, .*Mention the Elixir Games cap you are wearing/,
  );
  assert.equal(
    chad.filter((line) => /cap you are wearing/.test(line)).length,
    1,
  );
  const pepe = lines({ ...cap, wearingHost: 'Pepe' });
  assert.match(
    pepe.find((line) => line.startsWith('1. ')),
    /^1\. Pepe, .*Mention the Elixir Games cap you are wearing/,
  );
  const callback = lines({ ...cap, mention: 'callback' }).join('\n');
  assert.match(callback, /callback for Elixir Games's cap on GigaChad/);
  assert.match(callback, /still disclosed in turn 1/);
  assert.doesNotMatch(callback, /cap you are wearing/);
});
```

with

```js
void test('the tee and cap are mentioned on the wearer’s first turn, and a callback is still disclosed', () => {
  const cap = {
    ...elixir,
    product: 'cap',
    wearingHost: 'GigaChad',
    mention: 'intro',
  };
  const lines = (brief, prev) =>
    W.sponsoredWriterRequest(brief, W.sponsorTurnPlan(prev)).split('\n');
  const chad = lines(cap);
  assert.match(
    chad.find((line) => line.startsWith('2. ')),
    /^2\. GigaChad, .*Mention the Elixir Games tee and cap you are wearing/,
  );
  assert.equal(
    chad.filter((line) => /tee and cap you are wearing/.test(line)).length,
    1,
  );
  assert.match(
    chad.join('\n'),
    /This is the introduction of Elixir Games's tee and cap on GigaChad; the first cut to GigaChad shows the logo printed on his T-shirt and cap\./,
  );
  assert.doesNotMatch(chad.join('\n'), /Games cap you are wearing|shows the cap\./);
  const pepe = lines({ ...cap, wearingHost: 'Pepe' });
  assert.match(
    pepe.find((line) => line.startsWith('1. ')),
    /^1\. Pepe, .*Mention the Elixir Games tee and cap you are wearing/,
  );
  // A wearer the plan does not seat (a name the cast does not know) is still mentioned, in turn 1.
  const unseated = lines({ ...cap, wearingHost: 'Nobody' });
  assert.match(
    unseated.find((line) => line.startsWith('1. ')),
    /Mention the Elixir Games tee and cap Nobody is wearing\./,
  );
  const callback = lines({ ...cap, mention: 'callback' }).join('\n');
  assert.match(
    callback,
    /This is the callback for Elixir Games's tee and cap on GigaChad: a natural second mention/,
  );
  assert.match(callback, /still disclosed in turn 1/);
  assert.doesNotMatch(callback, /tee and cap you are wearing/);
});
```

Replace, inside `the judge sees the advertiser text and the dialogue as data`,

```js
  // On devnet the judge rejected "I touch grass. Is that why my cap feels so good?": a host
  // talking about himself and his cap is never a claim about the sponsor.
  assert.match(prompt, /Never list what a host says about himself/);
  assert.match(prompt, /When unsure, do not list it/);
  assert.match(prompt, /only if it has left "Elixir Games" entirely/);
  assert.match(prompt, /a maxim or verdict/);
```

with

```js
  // On devnet the judge rejected "I touch grass. Is that why my cap feels so good?": a host
  // talking about himself and what he is wearing is never a claim about the sponsor, and
  // what he wears is now a tee and a cap.
  assert.match(prompt, /Never list what a host says about himself/);
  assert.match(prompt, /including the tee and cap he is wearing and how they feel/);
  assert.doesNotMatch(prompt, /the cap he is wearing/);
  assert.match(prompt, /When unsure, do not list it/);
  assert.match(prompt, /only if it has left "Elixir Games" entirely/);
  assert.match(prompt, /its product, its pitch or the tee and cap\./);
  assert.match(prompt, /a maxim or verdict/);
```

Replace, inside `a cap introduction opens on the host not wearing it, and the wearer mentions the cap`,

```js
  // The cap is Pepe's to mention, on his first turn, which is turn 2.
  assert.match(
    request,
    /2\. Pepe[^\n]*Mention the Frog Labs cap you are wearing/,
  );
```

with

```js
  // The tee and cap are Pepe's to mention, on his first turn, which is turn 2.
  assert.match(
    request,
    /2\. Pepe[^\n]*Mention the Frog Labs tee and cap you are wearing/,
  );
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-writer.test.mjs`
Expected: FAIL in three tests — `the tee and cap are mentioned on the wearer’s first turn…` (turn 2 regex), `the judge sees the advertiser text…` (`including the tee and cap he is wearing`), and `a cap introduction opens on the host not wearing it…` (turn 2 regex). Everything else passes.

- [x] **Step 3: Change the wording**

In `lib/sponsor-writer.ts` replace exactly

```ts
  return brief.mention === 'callback'
    ? `This is the callback for ${project}'s cap on ${wearer}: a natural second mention of the same sponsor, still disclosed in turn 1. ${stay}`
    : `This is the introduction of ${project}'s cap on ${wearer}; the first cut to ${wearer} shows the cap. ${stay}`;
```

with

```ts
  return brief.mention === 'callback'
    ? `This is the callback for ${project}'s tee and cap on ${wearer}: a natural second mention of the same sponsor, still disclosed in turn 1. ${stay}`
    : `This is the introduction of ${project}'s tee and cap on ${wearer}; the first cut to ${wearer} shows the logo printed on his T-shirt and cap. ${stay}`;
```

replace exactly

```ts
    if (wearer >= 0 && wearer < duties.length)
      duties[wearer].push(`Mention the ${project} cap you are wearing.`);
    else if (brief.wearingHost)
      duties[0].push(
        `Mention the ${project} cap ${brief.wearingHost} is wearing.`,
      );
```

with

```ts
    if (wearer >= 0 && wearer < duties.length)
      duties[wearer].push(
        `Mention the ${project} tee and cap you are wearing.`,
      );
    else if (brief.wearingHost)
      duties[0].push(
        `Mention the ${project} tee and cap ${brief.wearingHost} is wearing.`,
      );
```

and, inside `judgePrompt`, replace the fragment (occurs once)

```
(what he does, owns, wears or feels, including the cap he is wearing and how it feels)
```

with

```
(what he does, owns, wears or feels, including the tee and cap he is wearing and how they feel)
```

and the fragment (occurs once)

```
its product, its pitch or the cap. A turn that riffs on the pitch
```

with

```
its product, its pitch or the tee and cap. A turn that riffs on the pitch
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-writer.test.mjs`
Expected: PASS (all). `npx tsc --noEmit` → no errors. `npx oxlint lib/sponsor-writer.ts` → no warnings.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-writer.ts tests/sponsor-writer.test.mjs
git commit -m "$(cat <<'EOF'
The hosts introduce and call back a sponsor's tee and cap, and the judge allows talk of both

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-5: a dressed clip is scaled, audited and downloaded like any other clip

**Files:**
- Modify: `lib/services.ts:39`, `:54`, `:103-104`, `:172-174`, `:202-211`, `:238-285` (shared-WIP file — exact replacements only)
- Test: `tests/cap-render-source.test.mjs` (rewritten in full), `tests/video-render.test.mjs:71-198` (two obsolete compositor tests deleted)

**Interfaces:**
- Consumes: `createServices(): Services`; `Services.render(line: Line, report?: (stage) => void): Promise<Clip>`; `PlacementLostError(message: string, code: string)` with `placementLostCodes = new Set(['LEASE', 'CAPABILITY', 'ASSET'])` (`lib/requests.ts`); the studio route actions `shot` → `scale` → `speech` → `poll`, and the media proxy `/api/media?url=<encoded fal URL>`.
- Produces: for a line with `wardrobe`, `render` issues exactly `shot`, `scale`, `speech` (no `/api/sponsorship/media` call, no direct download), downloads `/api/media?url=…scaled…`, and returns a `Clip` that still carries `line.wardrobe`. `WearableError`, `wardrobeRetries` and the `media` cache are gone; `INVALID_WEARABLE` is no longer a recognised code.

- [x] **Step 1: Write the failing tests**

Replace the whole of `tests/cap-render-source.test.mjs` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';

await build(['services']);
const { createServices } = await import('../work/tests/services.js');

// A dressed shot used to skip fal's scaler and go to the media desk to have a cap composited
// onto the take, per clip, behind a tracker that refused two takes in three. The look is now
// in the frames the model is conditioned on, so a dressed clip is scaled, audited and
// downloaded exactly like any other clip, and nothing is ever posted to a media route.
const wardrobe = {
  orderId: 'order',
  leaseToken: 'lease',
  target: 'host',
  assetId: 'asset1',
  designHash: 'look1',
  sourceUrl: 'https://show.test/api/sponsorship/assets/asset1?part=look&v=look1',
  templateVersion: 'looks-v1',
};
/** A browser that decodes any blob as ten seconds of playable video. */
function decodable(t) {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement: () => ({
        duration: 10,
        src: '',
        muted: false,
        preload: '',
        removeAttribute() {
          this.src = '';
        },
        load() {
          if (this.src) queueMicrotask(() => this.onloadeddata?.());
        },
      }),
    },
  });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
}

void test('a dressed clip is scaled and audited like any other clip, and nothing is composited', async (t) => {
  decodable(t);
  const actions = [];
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/podcast') {
      const body = JSON.parse(options.body);
      if (body.action !== 'poll') actions.push(body.action);
      if (body.action === 'shot') {
        assert.ok(body.line.wardrobe, 'the take is bought dressed');
        return Response.json({ token: 'shot-job' });
      }
      if (body.action === 'scale') {
        assert.equal(
          body.url,
          'https://fal.media/native.mp4',
          'the scaler gets the take the model made',
        );
        return Response.json({ token: 'scale-job' });
      }
      if (body.action === 'speech')
        return Response.json({ token: 'speech-job' });
      if (body.action === 'poll')
        return Response.json({
          status: 'COMPLETED',
          ...(body.token === 'speech-job'
            ? { speechEnd: 0.8, hasExtraSpeech: false }
            : {}),
          url:
            body.token === 'shot-job'
              ? 'https://fal.media/native.mp4'
              : 'https://fal.media/scaled.mp4',
        });
      throw Error(`unexpected action ${body.action}`);
    }
    assert.ok(
      !String(url).includes('/api/sponsorship/media'),
      'no compositor is called for a dressed clip',
    );
    downloads.push(url);
    return new Response(new Blob(['video']));
  });
  const services = createServices();
  const clip = await services.render({
    id: 0,
    speaker: 'host',
    text: 'Of course.',
    wardrobe,
  });
  assert.deepEqual(actions, ['shot', 'scale', 'speech']);
  assert.deepEqual(
    downloads,
    ['/api/media?url=https%3A%2F%2Ffal.media%2Fscaled.mp4'],
    'the scaled take is downloaded through the media proxy, like any clip',
  );
  assert.equal(clip.rawUrl, 'https://fal.media/scaled.mp4');
  assert.equal(
    clip.wardrobe.designHash,
    'look1',
    'the clip still carries the look it was made with',
  );
  assert.equal(clip.speechEnd, 0.8);
  assert.equal(clip.mediaDuration, 10);
  assert.equal(clip.playbackEnd, 10, 'a clean dressed take keeps its complete native ending');
  assert.equal(clip.duration, clip.playbackEnd);
  services.release(clip.url);
});

// The route answers a lost lease or a replaced look with its own status and code; the studio
// drops the placement at once instead of buying takes that can only be refused the same way.
for (const code of ['LEASE', 'ASSET'])
  void test(`a placement the site refuses with ${code} is dropped at once, not retaken`, async (t) => {
    const shots = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, '/api/podcast');
      const body = JSON.parse(options.body);
      if (body.action === 'shot') {
        shots.push(body);
        return Response.json(
          {
            code,
            error:
              code === 'LEASE'
                ? 'The delivery lease ended.'
                : 'The wardrobe revision does not match this purchased cap.',
          },
          { status: 409 },
        );
      }
      throw Error(`unexpected action ${body.action}`);
    });
    await assert.rejects(
      createServices().render({
        id: 0,
        speaker: 'host',
        text: 'Of course.',
        wardrobe,
      }),
      (e) => e.code === code && e.constructor.name === 'PlacementLostError',
    );
    assert.equal(
      shots.length,
      1,
      'no new take is bought for a placement that is gone',
    );
  });
```

Then delete the two compositor tests from `tests/video-render.test.mjs`. Replace this exact block (from `void test('uncertain cap tracking` through the `});` that closes `a successful compositor…`) with nothing, and collapse the blank line left behind so one blank line separates the neighbouring tests:

```js
void test('uncertain cap tracking retries a bounded number of takes and never downloads the failed result', async (t) => {
  const shots = [];
  let composites = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/sponsorship/media') {
      composites++;
      return Response.json(
        { code: 'INVALID_WEARABLE', error: 'Tracking could not be verified.' },
        { status: 422 },
      );
    }
    assert.equal(url, '/api/podcast', 'a failed cap never reaches the player');
    if (body.action === 'shot') {
      shots.push(body);
      return Response.json({ token: `native-${body.attempt}` });
    }
    if (body.action === 'scale')
      return Response.json({ token: `scale-${shots.length}` });
    if (body.action === 'speech')
      return Response.json({ token: `speech-${shots.length}` });
    return Response.json({
      status: 'COMPLETED',
      speechEnd: 0.8,
      hasExtraSpeech: false,
      url: `https://fal.media/${body.token}.mp4`,
    });
  });
  const wardrobe = {
    orderId: 'order',
    leaseToken: 'lease',
    target: 'host',
    assetId: 'design',
    designHash: 'hash',
    sourceUrl: 'https://show.test/cap.png',
    templateVersion: 'caps-v1',
  };
  await assert.rejects(
    createServices().render({
      id: 0,
      speaker: 'host',
      text: 'Of course.',
      wardrobe,
    }),
    /Tracking could not/,
  );
  assert.deepEqual(
    shots.map((s) => s.attempt),
    [0, 1, 2],
  );
  assert.equal(composites, 3);
});

void test('a successful compositor preserves the verified speech boundary and decoded timing', async (t) => {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement: () => ({
        duration: 10,
        src: '',
        muted: false,
        preload: '',
        removeAttribute() {
          this.src = '';
        },
        load() {
          if (this.src) queueMicrotask(() => this.onloadeddata?.());
        },
      }),
    },
  });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://show.test/api/sponsorship/assets/composed?part=video')
      return new Response(new Blob(['video']));
    const body = JSON.parse(options.body);
    if (url === '/api/sponsorship/media')
      return Response.json({
        url: 'https://show.test/api/sponsorship/assets/composed?part=video',
        quality: {
          accepted: true,
          audioVerified: true,
          duration: 10,
          frames: 250,
        },
      });
    assert.equal(url, '/api/podcast');
    if (body.action !== 'poll')
      return Response.json({ token: `${body.action}-job` });
    return Response.json({
      status: 'COMPLETED',
      speechEnd: 0.8,
      hasExtraSpeech: false,
      url: 'https://fal.media/video.mp4',
    });
  });
  const services = createServices();
  const wardrobe = {
    orderId: 'order',
    leaseToken: 'lease',
    target: 'host',
    assetId: 'design',
    designHash: 'hash',
    sourceUrl: 'https://show.test/cap.png',
    templateVersion: 'caps-v1',
  };
  const clip = await services.render({
    id: 0,
    speaker: 'host',
    text: 'Of course.',
    wardrobe,
  });
  assert.equal(clip.speechEnd, 0.8);
  assert.equal(clip.mediaDuration, 10);
  assert.equal(clip.playbackEnd, 10, 'a clean capped take preserves its complete native ending');
  assert.equal(
    clip.duration,
    clip.playbackEnd,
    'buffering and paid cap visibility count only the portion shown',
  );
  assert.equal(clip.wardrobe.designHash, 'hash');
  services.release(clip.url);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cap-render-source.test.mjs`
Expected: FAIL — `a dressed clip is scaled and audited like any other clip…` at `no compositor is called for a dressed clip` (the old branch posts to `/api/sponsorship/media`) or at `actions` (`['shot', 'speech']` without `scale`). The two refusal tests pass already (the route-level refusal path is unchanged).

Run: `node --test tests/video-render.test.mjs`
Expected: PASS (the deleted tests are gone; the rest is unaffected).

- [x] **Step 3: Remove the cap branch**

In `lib/services.ts` make these six exact replacements.

(a) Delete the line

```ts
class WearableError extends Error {}
```

(b) Delete the line

```ts
    if (data.code === 'INVALID_WEARABLE') throw new WearableError(data.error);
```

(c) Replace

```ts
  const speechRetries = new Map<string, number>();
  const wardrobeRetries = new Map<string, number>();
  const media = new Map<string, string>();
  const corrections = new Map<string, { output?: string; failures: number }>();
```

with

```ts
  const speechRetries = new Map<string, number>();
  const corrections = new Map<string, { output?: string; failures: number }>();
```

(d) Replace

```ts
      const attempt =
        (speechRetries.get(identity) ?? 0) +
        (wardrobeRetries.get(identity) ?? 0);
```

with

```ts
      const attempt = speechRetries.get(identity) ?? 0;
```

(e) Replace

```ts
      // A cap shot is composited on the take as the model made it, the only frame the cap's
      // qualification covers, and the media desk scales the verified composite to 1080 itself.
      // Fal's scaler would hand the tracker a frame it was never proven on: twice the pixels,
      // every tracking error grown by the scale, and real takes lost or out of time.
      const [result, speech] = await Promise.all([
        line.wardrobe
          ? ({ url: native.url } as Result)
          : job(scaleKey, { action: 'scale', url: native.url }),
        job(speechKey, { action: 'speech', url: native.url, line }),
      ]).catch(rejectSpeech);
```

with

```ts
      // A dressed take is scaled and audited like any other: the look is in the frames the
      // model was conditioned on, so there is nothing to composite afterwards.
      const [result, speech] = await Promise.all([
        job(scaleKey, { action: 'scale', url: native.url }),
        job(speechKey, { action: 'speech', url: native.url, line }),
      ]).catch(rejectSpeech);
```

(f) Replace the whole block from `if (!result.url)` through the download `fetch(` call

```ts
      if (!result.url) throw Error('No scaled video returned');
      let finalUrl = result.url;
      if (line.wardrobe) {
        const mediaKey = JSON.stringify([result.url, line.wardrobe]);
        finalUrl = media.get(mediaKey) || '';
        if (!finalUrl) {
          try {
            const composed = (await api(
              {
                orderId: line.wardrobe.orderId,
                leaseToken: line.wardrobe.leaseToken,
                videoUrl: result.url,
              },
              '/api/sponsorship/media',
              AbortSignal.timeout(120000),
            )) as Result & {
              quality?: { accepted?: boolean; audioVerified?: boolean };
            };
            if (
              !composed.url ||
              composed.quality?.accepted !== true ||
              composed.quality?.audioVerified !== true
            )
              throw new WearableError(
                'The cap placement did not pass its visual and audio checks.',
              );
            finalUrl = composed.url;
            media.set(mediaKey, finalUrl);
          } catch (error) {
            if (error instanceof WearableError) {
              // Every refusal advances the counter, so the take is never sent back to the
              // desk to be refused again: two more are tried here, and a retry the engine
              // makes after that arrives with a fresh take of its own.
              const refused = (wardrobeRetries.get(identity) ?? 0) + 1;
              wardrobeRetries.set(identity, refused);
              if (refused <= 2) return this.render(line, report);
            }
            throw error;
          }
        }
      }
      report?.('downloading');
      const response = await fetch(
        line.wardrobe
          ? finalUrl
          : `/api/media?url=${encodeURIComponent(finalUrl)}`,
        { signal: AbortSignal.timeout(60000) },
      );
```

with

```ts
      if (!result.url) throw Error('No scaled video returned');
      const finalUrl = result.url;
      report?.('downloading');
      const response = await fetch(
        `/api/media?url=${encodeURIComponent(finalUrl)}`,
        { signal: AbortSignal.timeout(60000) },
      );
```

Leave `const identity = JSON.stringify([input, line.wardrobe]);` and the `key` tuple as they are: a look is still part of the job's identity, so a re-dressed line never reuses an undressed take.

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cap-render-source.test.mjs tests/video-render.test.mjs`
Expected: PASS (all). `npx tsc --noEmit` → no errors (no unused `Result` cast, no `WearableError` reference left). `grep -n "WearableError\|wardrobeRetries\|sponsorship/media\|INVALID_WEARABLE" lib/services.ts` → no output.

- [x] **Step 5: Commit**

```bash
git add lib/services.ts tests/cap-render-source.test.mjs tests/video-render.test.mjs
git commit -m "$(cat <<'EOF'
A dressed clip is scaled, audited and downloaded like every other clip; nothing is composited

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-6: a stale wardrobe pin is the site's own refusal: 409 `ASSET`

**Files:**
- Modify: `app/api/podcast/route.ts:359-361` (shared-WIP file — exact replacement only)
- Test: `tests/podcast-route-refusals.test.mjs` (one test appended)

**Interfaces:**
- Consumes: `SponsorError(status: number, message: string, code?: string)` (already imported in the route from `@/lib/sponsorship`); the route's catch already answers a `SponsorError` through `sponsorFailure(e)` as `{ error, code }` with its status; `resolveTrustedSponsor(request, vars, reference): Promise<SponsorLease>` where `SponsorLease.assetMetadata: Record<string, unknown> | null` carries `sourceUrl`, `sha256`, `templateVersion` (site section, `air` stage).
- Produces: a `shot` whose `line.wardrobe` does not match the lease's asset answers `409 { error: 'The wardrobe revision does not match this purchased cap.', code: 'ASSET' }`; `lib/services.ts` turns that into `PlacementLostError` (code `ASSET` is in `placementLostCodes`), which `Podcast` handles without retries.

- [x] **Step 1: Write the failing test**

Append to the end of `tests/podcast-route-refusals.test.mjs`:

```js

// A look the site has since replaced (a new tailor round, an upgrade from the fallback) is
// the site's own refusal, with a status and a code, so the studio drops the dressing at once
// instead of buying four takes that can only be refused the same way.
void test('a stale wardrobe pin is refused as 409 ASSET, and a current one buys the take', async (t) => {
  const look = (sha) =>
    `https://sponsor.test/api/sponsorship/assets/asset1?part=look&v=${sha}`;
  const order = {
    id: 'order',
    leaseToken: 'lease',
    leaseUntil: Date.now() + 45000,
    draft: {
      product: 'cap',
      name: 'alice',
      message: 'We make tools for artists.',
      projectName: 'Canvas',
      target: 'host',
      assetId: 'asset1',
    },
    assetUrl: look('look2'),
    assetMetadata: {
      kind: 'cap',
      target: 'host',
      templateVersion: 'looks-v1',
      sourceUrl: look('look2'),
      sha256: 'look2',
    },
    fulfillment: {
      visibleMs: 0,
      appearances: 0,
      intro: false,
      callback: false,
      startedAt: null,
      completedAt: null,
    },
  };
  const bought = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://sponsor.test/api/sponsorship')
      return Response.json({ order });
    if (String(url).startsWith('https://queue.fal.run/')) {
      bought.push(JSON.parse(options.body));
      return Response.json({
        status_url: 'https://queue.fal.run/requests/r1/status',
        response_url: 'https://queue.fal.run/requests/r1',
        request_id: 'r1',
      });
    }
    throw Error(`unexpected fetch ${url}`);
  });
  const shot = (sha) =>
    POST(
      new Request('http://127.0.0.1:3212/api/podcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'shot',
          attempt: 0,
          line: {
            id: 8,
            speaker: 'host',
            text: 'Of course.',
            wardrobe: {
              orderId: 'order',
              leaseToken: 'lease',
              target: 'host',
              assetId: 'asset1',
              designHash: sha,
              sourceUrl: look(sha),
              templateVersion: 'looks-v1',
            },
          },
        }),
      }),
    );
  const stale = await shot('look1');
  assert.equal(stale.status, 409);
  const refused = await stale.json();
  assert.equal(refused.code, 'ASSET');
  assert.match(refused.error, /wardrobe revision does not match/);
  assert.equal(bought.length, 0, 'no take is bought for a stale look');
  const current = await shot('look2');
  assert.equal(current.status, 200, JSON.stringify(await current.clone().json()));
  assert.equal(bought.length, 1, 'the current look buys the take');
  assert.equal(bought[0].image_url, look('look2'));
  assert.equal(bought[0].end_image_url, look('look2'));
  assert.match(bought[0].prompt, /Headphones keep their exact placement/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/podcast-route-refusals.test.mjs`
Expected: FAIL — `a stale wardrobe pin is refused as 409 ASSET…` at `assert.equal(stale.status, 409)` with `400 !== 409` (a plain `Error` is answered as a 400 with no code).

- [x] **Step 3: Throw the site's refusal**

In `app/api/podcast/route.ts` replace exactly

```ts
          throw Error(
            'The wardrobe revision does not match this purchased cap.',
          );
```

with

```ts
          // A replaced look is the site's refusal, not a generation failure: the studio
          // drops the dressing at once instead of buying takes that can only fail the same way.
          throw new SponsorError(
            409,
            'The wardrobe revision does not match this purchased cap.',
            'ASSET',
          );
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tests/podcast-route-refusals.test.mjs`
Expected: PASS (both tests). `npx tsc --noEmit` → no errors.

- [x] **Step 5: Commit**

```bash
git add app/api/podcast/route.ts tests/podcast-route-refusals.test.mjs
git commit -m "$(cat <<'EOF'
A replaced look is refused as the site's own 409, so the studio undresses instead of retrying

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-7: `SponsorProgram.undressed()` — the rest of a host's run stays undressed until the next cut

**Files:**
- Modify: `lib/sponsor-program.ts:72-73` (new field), `:84-86` (`beginRun`), `:206-210` (`decorate` rule), `:236` (new method after `decorate`), `:407` (`ended` clears)
- Test: `tests/fixtures/sponsor-lease.mjs` (the shared lease → `looks-v1`), `tests/sponsor-wardrobe.test.mjs` (two tests appended)

**Interfaces:**
- Consumes: `SponsorProgram.decorate(line: Line, previousSpeaker?: Speaker): Line`, `failedRender(line, error)`, `ended(line & { duration })`, `WARDROBE_STRIKES`, the `strikes` map it already keeps per order.
- Produces: `undressed(orderId: string, shotId: number): void` — after it, `decorate` leaves a line of that order's target undressed while `previousSpeaker === line.speaker && line.id > shotId`; the note clears on the first cut back to that host (a line of his whose previous speaker is not him), on a played dressed appearance in `ended`, and in `beginRun()`. Unknown `orderId` is a no-op. `show-8` calls it from `Podcast.rejectPlacement`.

- [x] **Step 1: Write the failing tests**

In `tests/fixtures/sponsor-lease.mjs` (the one lease both `tests/sponsor-wardrobe.test.mjs` and `tests/fixtures/sponsor-lease.mjs` import) replace the fixture lines

```js
  assetUrl: 'https://site.test/preview.png',
  assetMetadata: {
    sourceUrl: 'https://site.test/cap.png',
    sha256: 'design1',
    templateVersion: 'caps-v1',
  },
```

with

```js
  assetUrl:
    'https://site.test/api/sponsorship/assets/design1?part=look&v=design1',
  assetMetadata: {
    sourceUrl:
      'https://site.test/api/sponsorship/assets/design1?part=look&v=design1',
    sha256: 'design1',
    templateVersion: 'looks-v1',
  },
```

and replace the end of the last test (this exact text occurs once)

```js
  await p.failedRender(first, Error('bad take'));
  assert.equal(paused(), true);
});
```

with

```js
  await p.failedRender(first, Error('bad take'));
  assert.equal(paused(), true);
});

// One wardrobe per run. A dressed take that fails for good used to be made again undressed
// while the same host's next line aired dressed: the tee and cap flipped off and back on
// between two adjacent lines of his. The engine tells the program which shot failed; every
// later line of that host, until the next cut to him, is left undressed, and the look
// returns at that cut.
void test('after a dressed take fails, the rest of that host’s run airs undressed and the look returns at the next cut', async () => {
  const { p, paused } = program();
  await onAir(p);
  const free = p.decorate({ id: 10, speaker: 'host', text: 'free' }, 'guest');
  assert.ok(free.wardrobe, 'the cap is on the free line');
  await p.failedRender(free, Error('bad take'));
  p.undressed('cap1', 10);
  assert.equal(
    p.decorate({ id: 11, speaker: 'host', text: 'still his turn' }, 'host')
      .wardrobe,
    undefined,
    'the same host’s next line airs undressed',
  );
  assert.equal(
    p.decorate({ id: 12, speaker: 'guest', text: 'the other host' }, 'host')
      .wardrobe,
    undefined,
    'the other host was never dressed',
  );
  assert.ok(
    p.decorate({ id: 13, speaker: 'host', text: 'back to him' }, 'guest')
      .wardrobe,
    'the look returns at the cut back to him',
  );
  assert.ok(
    p.decorate({ id: 14, speaker: 'host', text: 'and stays on' }, 'host')
      .wardrobe,
    'the note is gone, not merely skipped: his second line in the new run is dressed',
  );
  p.undressed('no-such-order', 14);
  assert.ok(
    p.decorate({ id: 15, speaker: 'host', text: 'unknown orders' }, 'host')
      .wardrobe,
    'a note for an unknown order changes nothing',
  );
  assert.equal(paused(), false, 'none of this pauses the order');
});

void test('a played dressed appearance clears the undressed note, like the strikes', async () => {
  const { p } = program();
  await onAir(p);
  const free = p.decorate({ id: 10, speaker: 'host', text: 'free' }, 'guest');
  p.undressed('cap1', 10);
  assert.equal(
    p.decorate({ id: 11, speaker: 'host', text: 'undressed' }, 'host').wardrobe,
    undefined,
  );
  await p.ended({ ...free, duration: 5 });
  assert.ok(
    p.decorate({ id: 12, speaker: 'host', text: 'dressed again' }, 'host')
      .wardrobe,
    'an appearance that played clears the note',
  );
});
```


- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sponsor-wardrobe.test.mjs`
Expected: FAIL — both new tests with `TypeError: p.undressed is not a function`. The two existing tests pass.

Run: `node --test tests/fixtures/sponsor-lease.mjs`
Expected: PASS (the fixture change is cosmetic for the program).

- [x] **Step 3: Add the note**

In `lib/sponsor-program.ts` make these five exact replacements.

(a) Replace

```ts
  /** Dressed free lines that failed in a row, per cap order; a played appearance clears it. */
  private strikes = new Map<string, number>();
```

with

```ts
  /** Dressed free lines that failed in a row, per cap order; a played appearance clears it. */
  private strikes = new Map<string, number>();
  /** Per cap order, the shot after which its host airs undressed until the next cut to him. */
  private undressedAfter = new Map<string, number>();
```

(b) Replace

```ts
  beginRun() {
    this.lastPaidAt = -Infinity;
  }
```

with

```ts
  beginRun() {
    this.lastPaidAt = -Infinity;
    // Shot ids start over with the run, so a note about an old shot means nothing now.
    this.undressedAfter.clear();
  }
```

(c) In `decorate`, replace

```ts
      if (
        order.firstAppliedShot === undefined &&
        previousSpeaker === line.speaker
      )
        continue;
      const metadata = order.assetMetadata;
```

with

```ts
      if (
        order.firstAppliedShot === undefined &&
        previousSpeaker === line.speaker
      )
        continue;
      // One wardrobe per run: after a dressed take of his failed for good, the rest of this
      // host's turn airs undressed, and the look returns at the next cut to him.
      const undressedShot = this.undressedAfter.get(order.id);
      if (undressedShot !== undefined && previousSpeaker === line.speaker) {
        if (line.id > undressedShot) continue;
      } else this.undressedAfter.delete(order.id);
      const metadata = order.assetMetadata;
```

(d) Replace

```ts
    return line;
  }
  private required(ref: SponsorReference) {
```

with

```ts
    return line;
  }
  /**
   * A dressed take of this order's host failed for good, at this shot. Every later line of
   * his before a cut airs undressed, so the look never flips mid-run: the engine makes the
   * run-mate it already holds again undressed, and this note covers the lines not yet
   * decorated. Cleared at the next cut to him, by a played appearance, and by a new run.
   */
  undressed(orderId: string, shotId: number) {
    if (!this.orders.has(orderId)) return;
    const noted = this.undressedAfter.get(orderId);
    if (noted === undefined || shotId < noted)
      this.undressedAfter.set(orderId, shotId);
  }
  private required(ref: SponsorReference) {
```

(e) In `ended`, replace

```ts
          this.played.add(eventId);
          if (line.wardrobe?.orderId === id) this.strikes.delete(id);
```

with

```ts
          this.played.add(eventId);
          if (line.wardrobe?.orderId === id) {
            this.strikes.delete(id);
            this.undressedAfter.delete(id);
          }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sponsor-wardrobe.test.mjs tests/fixtures/sponsor-lease.mjs`
Expected: PASS (all). `npx tsc --noEmit` → no errors. `npx oxlint lib/sponsor-program.ts` → clean.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-program.ts tests/sponsor-wardrobe.test.mjs tests/fixtures/sponsor-lease.mjs
git commit -m "$(cat <<'EOF'
Once a dressed take fails, the rest of that host's turn airs undressed until the next cut

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-8: the engine undresses the committed run-mate and counts a flip it cannot avoid

**Files:**
- Modify: `lib/engine.ts:896-916` (`rejectPlacement` wardrobe branch and its doc comment; shared-WIP file — exact replacements only)
- Test: `tests/engine.test.mjs` (helper block + two tests appended at the end), `tests/sponsor-program.test.mjs` (one integration test appended at the end)

**Interfaces:**
- Consumes: `SponsorProgram.undressed(orderId: string, shotId: number): void` (show-7); `Podcast.diagnose(event: string, reason?: string, detail?: Record<string, unknown>)` and `getDiagnostics()`; `Slot = Line & { status: 'rendering' | 'ready'; clip?; stage?; startedAt?; attempt?; retryAt? }`; `PlacementLostError` (`lib/requests.ts`).
- Produces: in `rejectPlacement(first)` for a wardrobe line: calls `this.sponsorProgram?.undressed(first.wardrobe.orderId, first.id)`; every slot adjacent to `first` in `state.slots` with the same speaker and `wardrobe.orderId` is released and re-rendered undressed with `attempt: undefined, retryAt: now` (at most one such neighbour on each side; a run never exceeds two turns); when `first` is the head slot and `state.history.at(-1)` is a dressed line of the same host and order, `this.diagnose('wardrobe-flip', <reason>, { shot: first.id, airedShot })` is recorded. Test helpers appended to `tests/engine.test.mjs` and reused by show-9: `stalePin()`, `capLease()`, `capService()`, `runsWriter`, `wardrobePolicy`, `rendering(h, id)`, `dressedFree(line)`, `aired(h, id)`, `dressedPair(h)`, `drive(h, condition, hold?, rounds?)`, `dressedHarness(extra?)`.

- [x] **Step 1: Write the failing tests**

Append to the very end of `tests/engine.test.mjs`:

```js

// ---- Tailored wardrobe: one wardrobe per run ---------------------------------------------
// A dressed take that fails for good used to be made again undressed on its own, while the
// same host's next line, already committed dressed, aired dressed: the tee and cap flipped
// off and back on between two adjacent lines of his. The engine now undresses the run-mate
// it already holds (one extra render at most), the program keeps lines not yet decorated
// undressed until the next cut, and a flip that cannot be avoided (the earlier line of the
// run already aired) is counted for devnet rehearsal.
const { PlacementLostError } = await import('../work/tests/requests.js');
const stalePin = () =>
  new PlacementLostError(
    'The wardrobe revision does not match this purchased cap.',
    'ASSET',
  );
const capLease = () => ({
  id: 'cap1',
  leaseToken: 'lease1',
  leaseUntil: Date.now() + 45000,
  draft: {
    product: 'cap',
    name: 'alice',
    message: 'We make tools for artists.',
    projectName: 'Canvas',
    target: 'host',
    assetId: 'asset1',
  },
  assetUrl: 'https://site.test/api/sponsorship/assets/asset1?part=look&v=look1',
  assetMetadata: {
    sourceUrl: 'https://site.test/api/sponsorship/assets/asset1?part=look&v=look1',
    sha256: 'look1',
    templateVersion: 'looks-v1',
  },
  fulfillment: {
    visibleMs: 0,
    appearances: 0,
    intro: false,
    callback: false,
    startedAt: null,
    completedAt: null,
  },
});
/** A delivery service that leases one cap on Pepe and accepts every event. */
function capService() {
  const events = [];
  const order = capLease();
  return {
    events,
    sync: async () => [order],
    event: async (event) => {
      events.push(event);
      return { status: event.type === 'paused' ? 'paused' : 'playing' };
    },
  };
}
/** Paid exchanges alternate; free batches let a host hold the floor for two turns, so a dressed host line has a run-mate. */
const runsWriter = async (recent, start, cue, topic, from, sponsorship) => {
  const first = recent.at(-1)?.speaker === 'host' ? 'guest' : 'host';
  const second = first === 'host' ? 'guest' : 'host';
  const speakers = sponsorship
    ? [first, second, first, second]
    : [first, first, second, second];
  return speakers.map((speaker, i) => ({
    id: start + i,
    speaker,
    text: 'A perfectly ordinary spoken line for this shot.',
  }));
};
const wardrobePolicy = {
  targetSeconds: 48,
  maxSlots: 6,
  recoverySeconds: 0,
  attempts: 2,
  paidAttempts: 4,
  retryDelaysMs: [0],
  outageSkips: 99,
};
const rendering = (h, id) =>
  h.engine.getSnapshot().slots.some((s) => s.id === id && s.status === 'rendering');
const dressedFree = (line) => !!line.wardrobe && !line.sponsorship;
const aired = (h, id) => h.engine.getSnapshot().history.find((c) => c.id === id);
/** A dressed free line in flight whose run-mate, the next shot by the same host, is committed dressed. */
function dressedPair(h) {
  const { slots } = h.engine.getSnapshot();
  for (const [id, job] of h.jobs) {
    if (!dressedFree(job.line) || !rendering(h, id)) continue;
    const mate = slots.find(
      (slot) => slot.id === id + 1 && slot.speaker === job.line.speaker && slot.wardrobe,
    );
    if (mate) return { id, mate: mate.id };
  }
}
/** Rounds of finishing every render not held back, then ending the clip on air, until the condition holds. */
async function drive(h, condition, hold = () => false, rounds = 80) {
  for (let i = 0; i < rounds && !condition(); i++) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Finishing appends entries; iterate this finite snapshot.
    for (const [id, job] of [...h.jobs])
      if (!hold(job.line) && rendering(h, id)) await h.finish(id);
    const s = h.engine.getSnapshot();
    if (s.phase === 'playing' && s.current) h.engine.clipEnded(s.current.id);
    await tick();
  }
  return condition();
}
/** The engine harness with a cap on air, counting every render by shot and dressing. */
function dressedHarness(extra = {}) {
  const renders = [];
  const service = capService();
  const h = harness(
    {
      render: (line) => {
        renders.push({ id: line.id, dressed: !!line.wardrobe });
        return new Promise((resolve, reject) =>
          h.jobs.set(line.id, { line, resolve, reject }),
        );
      },
      write: runsWriter,
      sponsors: service,
      ...extra,
    },
    wardrobePolicy,
  );
  return { ...h, renders, events: service.events };
}

void test('a dressed take refused for its pin undresses its committed run-mate too, with one extra render', async () => {
  const h = dressedHarness();
  try {
    h.engine.start();
    let pair;
    assert.ok(
      await drive(h, () => !!(pair = dressedPair(h)), dressedFree),
      'a dressed host line and its dressed run-mate were committed together',
    );
    await h.finish(pair.mate);
    const mate = () => h.engine.getSnapshot().slots.find((s) => s.id === pair.mate);
    assert.equal(mate().status, 'ready');
    assert.ok(mate().clip.wardrobe, 'the run-mate was ready, dressed');
    await h.fail(pair.id, stalePin());
    await tick();
    for (const id of [pair.id, pair.mate]) {
      const slot = h.engine.getSnapshot().slots.find((s) => s.id === id);
      assert.equal(slot.status, 'rendering', `shot ${id} is being made again`);
      assert.equal(slot.wardrobe, undefined, `shot ${id} is made again undressed`);
      assert.equal(slot.clip, undefined);
      assert.equal(h.jobs.get(id).line.wardrobe, undefined, `the retake of ${id} was sent undressed`);
    }
    assert.ok(h.released.includes(`blob:${pair.mate}`), 'the dressed run-mate clip is released');
    assert.deepEqual(
      h.renders.filter((r) => r.id === pair.mate).map((r) => r.dressed),
      [true, false],
      'the run-mate costs exactly one extra render',
    );
    assert.deepEqual(
      h.renders.filter((r) => r.id === pair.id).map((r) => r.dressed),
      [true, false],
    );
    assert.ok(await drive(h, () => !!aired(h, pair.mate)), 'the run aired');
    assert.equal(aired(h, pair.id).wardrobe, undefined);
    assert.equal(aired(h, pair.mate).wardrobe, undefined, 'the whole run aired undressed');
    assert.ok(
      await drive(h, () =>
        h.engine
          .getSnapshot()
          .history.some((c) => c.id > pair.mate && c.speaker === 'host' && c.wardrobe),
      ),
      'the look returns at the next cut to him',
    );
    assert.ok(!h.events.some((e) => e.type === 'paused'), 'one refused pin never pauses the order');
    assert.ok(
      !h.engine.getDiagnostics().some((d) => d.event === 'wardrobe-flip'),
      'nothing flipped: the run never aired dressed',
    );
  } finally {
    h.engine.dispose();
  }
});

void test('a refused pin whose run-mate already aired dressed is counted as a wardrobe flip', async () => {
  const h = dressedHarness();
  try {
    h.engine.start();
    let pair;
    assert.ok(await drive(h, () => !!(pair = dressedPair(h)), dressedFree));
    // The first half of the run finishes and airs while the second is still in the works.
    await h.finish(pair.id);
    assert.ok(await drive(h, () => !!aired(h, pair.id), dressedFree), 'the earlier line aired');
    assert.ok(aired(h, pair.id).wardrobe, 'and it aired dressed');
    assert.ok(rendering(h, pair.mate), 'while its run-mate is still being made');
    await h.fail(pair.mate, stalePin());
    await tick();
    const flips = h.engine.getDiagnostics().filter((d) => d.event === 'wardrobe-flip');
    assert.equal(flips.length, 1, 'the flip is counted once');
    assert.equal(flips[0].shot, pair.mate);
    assert.equal(flips[0].airedShot, pair.id);
    const slot = h.engine.getSnapshot().slots.find((s) => s.id === pair.mate);
    assert.equal(slot.status, 'rendering');
    assert.equal(slot.wardrobe, undefined, 'the retake is undressed; a cutaway before it is a follow-up');
    assert.deepEqual(
      h.renders.filter((r) => r.id === pair.id).map((r) => r.dressed),
      [true],
      'an aired line is never made again',
    );
    assert.deepEqual(
      h.renders.filter((r) => r.id === pair.mate).map((r) => r.dressed),
      [true, false],
    );
  } finally {
    h.engine.dispose();
  }
});
```

Append to the very end of `tests/sponsor-program.test.mjs` (after the `a cap whose lease is gone…` test):

```js

// The route answers a replaced look with 409 ASSET on the first take. The engine drops the
// dressing for that whole run of the host's lines at once, spends no strike budget on
// retries, and dresses him again at the next cut. This runs the real program and engine.
void test('a pin mismatch undresses the host’s run on the first failure, and the look returns at the next cut', async () => {
  const { PlacementLostError } = await import('../work/tests/requests.js');
  const h = harness(lease('cap'));
  const renders = [];
  let refused;
  const { engine } = engineHarness(
    h,
    {
      // Free batches hold the floor for two turns, so a dressed host line has a run-mate.
      write: async (recent, start, cue, topic, from, sponsorship) => {
        const first = recent.at(-1)?.speaker === 'host' ? 'guest' : 'host';
        const second = first === 'host' ? 'guest' : 'host';
        const speakers = sponsorship
          ? [first, second, first, second]
          : [first, first, second, second];
        return speakers.map((speaker, i) => ({
          id: start + i,
          speaker,
          text: 'This is a fully spoken turn for the run.',
        }));
      },
      render: async (line) => {
        renders.push({ id: line.id, dressed: !!line.wardrobe });
        if (line.wardrobe && !line.sponsorship && refused === undefined) {
          refused = line.id;
          throw new PlacementLostError(
            'The wardrobe revision does not match this purchased cap.',
            'ASSET',
          );
        }
        return rendered(line);
      },
    },
    { attempts: 2, paidAttempts: 4, retryDelaysMs: [0], outageSkips: 99 },
  );
  const aired = (id) => engine.getSnapshot().history.find((c) => c.id === id);
  const lookBack = () =>
    refused !== undefined &&
    engine
      .getSnapshot()
      .history.some((c) => c.id > refused + 1 && c.speaker === 'host' && c.wardrobe);
  try {
    engine.start();
    for (let step = 0; step < 200 && !lookBack(); step++) {
      await tick();
      const s = engine.getSnapshot();
      if (s.phase === 'playing' && s.current) engine.clipEnded(s.current.id);
    }
    assert.ok(refused !== undefined, 'a dressed free line was refused');
    const mate = refused + 1;
    assert.ok(aired(refused) && aired(mate), 'the run aired');
    assert.equal(aired(mate).speaker, 'host', 'the run-mate is the same host');
    assert.equal(aired(refused).wardrobe, undefined, 'the refused line aired undressed');
    assert.equal(aired(mate).wardrobe, undefined, 'and so did its run-mate');
    assert.deepEqual(
      renders.filter((r) => r.id === refused).map((r) => r.dressed),
      [true, false],
      'one dressed try, then the undressed retake',
    );
    assert.ok(renders.filter((r) => r.id === mate).length <= 2, 'the run-mate costs at most one extra render');
    assert.equal(renders.filter((r) => r.id === mate).at(-1).dressed, false);
    assert.ok(lookBack(), 'the look returns at the next cut to him');
    assert.ok(!h.events.some((e) => e.type === 'paused'), 'no pause: no strike budget was spent on retries');
    assert.ok(!engine.getDiagnostics().some((d) => d.event === 'wardrobe-flip'), 'nothing flipped');
  } finally {
    engine.dispose();
    await tick();
  }
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/engine.test.mjs`
Expected: FAIL — `a dressed take refused for its pin undresses its committed run-mate too…` at `shot <mate> is being made again` (`'ready' !== 'rendering'`: the run-mate keeps its dressed clip), and `a refused pin whose run-mate already aired dressed…` at `the flip is counted once` (`0 !== 1`). Every earlier test in the file passes.

Run: `node --test tests/sponsor-program.test.mjs`
Expected: FAIL — `a pin mismatch undresses the host’s run…` at `and so did its run-mate` (the run-mate aired dressed).

- [x] **Step 3: Undress the run-mate**

In `lib/engine.ts` replace exactly

```ts
  /** Cancelled ads never air; ordinary dialogue with an obsolete cap is rendered again without it. */
```

with

```ts
  /** Cancelled ads never air; dialogue whose cap is refused is made again without it, and so
   * is the rest of that host's run, so the tee and cap never flip between two lines of his. */
```

and replace exactly

```ts
    } else if (first.wardrobe) {
      if (first.clip) this.services.release(first.clip.url);
      // A fresh shot in the same slot: due now, with a clean attempt count.
      const line: Slot = {
        ...first,
        wardrobe: undefined,
        clip: undefined,
        status: 'rendering',
        attempt: undefined,
        retryAt: Date.now(),
      };
      this.set({
        slots: this.state.slots.map((slot) =>
          slot.id === first.id ? line : slot,
        ),
      });
    }
```

with

```ts
    } else if (first.wardrobe) {
      const worn = first.wardrobe;
      // One wardrobe per run. The program keeps this host's lines not yet decorated
      // undressed until the next cut to him; the run-mate the show already holds (the
      // adjacent shot by the same host, in the same order's wardrobe) is made again here.
      this.sponsorProgram?.undressed(worn.orderId, first.id);
      const at = this.state.slots.findIndex((slot) => slot.id === first.id);
      const runMate = (line?: Line): line is Line =>
        !!line &&
        line.speaker === first.speaker &&
        line.wardrobe?.orderId === worn.orderId;
      const undress = new Set([first.id]);
      if (at >= 0)
        for (const neighbour of [
          this.state.slots[at - 1],
          this.state.slots[at + 1],
        ])
          if (runMate(neighbour)) undress.add(neighbour.id);
      // The earlier half of the run already aired dressed: this retake flips the look
      // mid-run. Counted so a devnet rehearsal can see it; a cutaway before the retake is
      // a follow-up, not part of this change.
      const last = this.state.history.at(-1);
      if (at === 0 && runMate(last))
        this.diagnose(
          'wardrobe-flip',
          'The earlier line of this run aired dressed; its retake airs undressed.',
          { shot: first.id, airedShot: last.id },
        );
      const now = Date.now();
      for (const slot of this.state.slots)
        if (undress.has(slot.id) && slot.clip)
          this.services.release(slot.clip.url);
      this.set({
        slots: this.state.slots.map((slot) => {
          if (!undress.has(slot.id)) return slot;
          // A fresh shot in the same slot: due now, with a clean attempt count.
          const retake: Slot = {
            ...slot,
            wardrobe: undefined,
            clip: undefined,
            status: 'rendering',
            stage: undefined,
            startedAt: undefined,
            attempt: undefined,
            retryAt: now,
          };
          return retake;
        }),
      });
    }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/engine.test.mjs tests/sponsor-program.test.mjs tests/sponsor-wardrobe.test.mjs`
Expected: PASS (all, including the older `a cap whose lease is gone is undressed at once…` test, whose alternating writer has no run-mates). `npx tsc --noEmit` → no errors. `npx oxlint lib/engine.ts` → no new warnings.

- [x] **Step 5: Commit**

```bash
git add lib/engine.ts tests/engine.test.mjs tests/sponsor-program.test.mjs
git commit -m "$(cat <<'EOF'
A refused dressed take undresses the rest of that host's run at once, and a flip it cannot avoid is counted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### show-9: a dressed take that lands after its slot was undressed is discarded, not aired

**Files:**
- Modify: `lib/engine.ts:222-223` (new `wornBy` helper after `span`), `:1475-1478` (`launch` success handler), `:1496-1498` (`launch` failure handler); shared-WIP file — exact replacements only
- Test: `tests/engine.test.mjs` (two tests appended after show-8's block)

**Interfaces:**
- Consumes: from show-8's helper block in `tests/engine.test.mjs`: `stalePin()`, `dressedFree(line)`, `dressedPair(h)`, `drive(h, condition, hold?, rounds?)`, `rendering(h, id)`, `dressedHarness(extra?)` (if show-8 was rejected, apply its Step 1 helper block unchanged first; the tests below only need the helpers, not show-8's engine hunk to pass their first assertion, but they do need it to pass in full); `SpeechError` (already imported at the top of the file).
- Produces: module-level `const wornBy = (line: Line) => string` (`''` undressed, else `${orderId}:${designHash}`); in `launch`, a finished clip is released and ignored when its slot is gone or now wears something else (`wornBy(slot) !== wornBy(line)`), and a failure of a dressed take whose slot now wears something else returns before any retry, strike or note.

- [x] **Step 1: Write the failing tests**

Append to the very end of `tests/engine.test.mjs` (after show-8's second test):

```js

// The run-mate is usually still in the works when the failure lands. Its dressed take then
// arrives for a slot that has already been undressed and re-queued: it must be discarded,
// not aired, and its own failure must not be counted against the undressed retake.
function inflightHarness() {
  const pending = new Map();
  const h = dressedHarness({
    render: (line) => {
      h.renders.push({ id: line.id, dressed: !!line.wardrobe });
      return new Promise((resolve, reject) => {
        const list = pending.get(line.id) ?? [];
        list.push({ line, resolve, reject });
        pending.set(line.id, list);
        h.jobs.set(line.id, { line, resolve, reject });
      });
    },
  });
  return { ...h, pending };
}
const finished = (job, url) => ({
  ...job.line,
  url,
  rawUrl: `https://fal.media/${job.line.id}.mp4`,
  duration: 8,
  renderMs: 0,
});

void test('a dressed take that lands after its slot was undressed is discarded, and the undressed retake airs', async () => {
  const h = inflightHarness();
  try {
    h.engine.start();
    let pair;
    assert.ok(await drive(h, () => !!(pair = dressedPair(h)), dressedFree));
    assert.ok(rendering(h, pair.mate), 'the run-mate is still in flight, dressed');
    const stale = h.pending.get(pair.mate)[0];
    assert.ok(stale.line.wardrobe);
    await h.fail(pair.id, stalePin());
    await tick();
    const slot = () => h.engine.getSnapshot().slots.find((s) => s.id === pair.mate);
    assert.equal(slot().wardrobe, undefined, 'the run-mate slot was undressed while its dressed take was in flight');
    // The dressed take lands now.
    stale.resolve(finished(stale, `blob:${pair.mate}-dressed`));
    await tick();
    assert.ok(h.released.includes(`blob:${pair.mate}-dressed`), 'the stale dressed clip is released, never kept');
    assert.equal(slot().status, 'rendering', 'the slot still waits for its undressed retake');
    assert.equal(slot().clip, undefined);
    await tick();
    const retake = h.pending.get(pair.mate).find((job) => !job.line.wardrobe);
    assert.ok(retake, 'the undressed retake was sent');
    retake.resolve(finished(retake, `blob:${pair.mate}`));
    await tick();
    assert.equal(slot().status, 'ready');
    assert.equal(slot().clip.wardrobe, undefined, 'the run-mate airs undressed');
    assert.equal(slot().clip.url, `blob:${pair.mate}`);
    assert.equal(h.pending.get(pair.mate).length, 2, 'one extra render, no more');
  } finally {
    h.engine.dispose();
  }
});

void test('a dressed take that fails after its slot was undressed is ignored: no retry, no strike, no note', async () => {
  const h = inflightHarness();
  try {
    h.engine.start();
    let pair;
    assert.ok(await drive(h, () => !!(pair = dressedPair(h)), dressedFree));
    const stale = h.pending.get(pair.mate)[0];
    await h.fail(pair.id, stalePin());
    await tick();
    const before = h.engine.getSnapshot().error;
    stale.reject(new SpeechError('Generated speech does not match the scripted line'));
    await tick();
    const slot = h.engine.getSnapshot().slots.find((s) => s.id === pair.mate);
    assert.equal(slot.wardrobe, undefined);
    assert.equal(slot.status, 'rendering');
    assert.ok(!(slot.attempt >= 1), 'the stale failure is not counted against the retake');
    assert.equal(h.engine.getSnapshot().error, before, 'and it leaves no recovery note');
    assert.equal(
      h.pending.get(pair.mate).filter((job) => job.line.wardrobe).length,
      1,
      'the dressed take is never made again',
    );
    assert.ok(!h.events.some((e) => e.type === 'paused'), 'nor does it cost the order a strike');
    await tick();
    const retake = h.pending.get(pair.mate).find((job) => !job.line.wardrobe);
    assert.ok(retake, 'the undressed retake goes ahead');
    retake.resolve(finished(retake, `blob:${pair.mate}`));
    await tick();
    const ready = h.engine.getSnapshot().slots.find((s) => s.id === pair.mate);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.clip.wardrobe, undefined);
  } finally {
    h.engine.dispose();
  }
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/engine.test.mjs`
Expected: FAIL — `a dressed take that lands after its slot was undressed is discarded…` at `the stale dressed clip is released, never kept` (the dressed clip is set on the undressed slot and marked ready), and `a dressed take that fails after its slot was undressed is ignored…` at `the stale failure is not counted against the retake` or `the dressed take is never made again` (the stale failure re-queues the slot with `attempt: 1` and a second dressed retake). All earlier tests pass.

- [x] **Step 3: Guard `launch` against stale dressed takes**

In `lib/engine.ts` replace exactly

```ts
const span = (ms: number) =>
  ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`;
```

with

```ts
const span = (ms: number) =>
  ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`;
/** What a line wears, for telling a stale dressed take from the retake that replaced it. */
const wornBy = (line: Line) =>
  line.wardrobe ? `${line.wardrobe.orderId}:${line.wardrobe.designHash}` : '';
```

In the `launch` success handler replace exactly

```ts
          if (!this.state.slots.some((slot) => slot.id === line.id)) {
            this.services.release(clip.url);
            return;
          }
```

with

```ts
          // A slot undressed while this take was in flight takes only its undressed retake;
          // a dressed clip landing on it now would flip the look mid-run.
          const slot = this.state.slots.find((s) => s.id === line.id);
          if (!slot || wornBy(slot) !== wornBy(line)) {
            this.services.release(clip.url);
            return;
          }
```

In the `launch` failure handler replace exactly

```ts
          const present = this.state.slots.some((s) => s.id === line.id);
          const paid = !!(line.sponsorship || line.wardrobe);
          if (!present && !paid) return;
```

with

```ts
          const slot = this.state.slots.find((s) => s.id === line.id);
          const present = !!slot;
          const paid = !!(line.sponsorship || line.wardrobe);
          if (!present && !paid) return;
          // The slot was undressed while this dressed take was in flight: its retake is
          // already on its way, and this result has nothing left to say about it.
          if (line.wardrobe && slot && wornBy(slot) !== wornBy(line)) return;
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/engine.test.mjs tests/sponsor-program.test.mjs tests/buffering.test.mjs tests/proactive-continuity.test.mjs tests/sponsor-playback-recovery.test.mjs`
Expected: PASS (all; the guard is a no-op for undressed lines, so the older engine suites are unaffected). `npx tsc --noEmit` → no errors. `npx oxlint lib/engine.ts` → no new warnings.

Then the whole suite: `npm test` → all green (the desk/site sections may have their own in-progress failures; anything under `tests/engine*`, `tests/sponsor-program*`, `tests/sponsor-wardrobe*`, `tests/sponsor-writer*`, `tests/video-render*`, `tests/cap-render-source*`, `tests/podcast-route-refusals*` must be green).

- [x] **Step 5: Commit**

```bash
git add lib/engine.ts tests/engine.test.mjs
git commit -m "$(cat <<'EOF'
A dressed take that finishes after its line was undressed is dropped, never aired

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Section self-check against spec §3 and "Tests → Show"

| Spec requirement | Task |
| --- | --- |
| `shotInput`: both frames are the look; new suffix; gesture dropped on dressed lines | show-2 (`tests/video-render.test.mjs`) |
| `lib/video-frames.ts` gains `originalUrl` from `character-assets.json` via `scripts/video-frames.mjs` | show-1 |
| `lib/services.ts`: cap-only branch removed (scaler skip, `/api/sponsorship/media`, direct download, `wardrobeRetries`, `WearableError`); dressed clip scaled and audited like any clip; `tests/cap-render-source.test.mjs` rewritten | show-5 |
| Route pin mismatch → `SponsorError(409, …, 'ASSET')` → `PlacementLostError` path | show-6 (+ the `ASSET` refusal case in show-5's services test) |
| `SponsorProgram.undressed(orderId, shotId)`; decorate skips while `previousSpeaker === line.speaker && line.id > undressedShot`; clears at the first cut and on a played appearance in `ended` | show-7 (`tests/sponsor-wardrobe.test.mjs`) |
| `Engine.rejectPlacement` undresses the adjacent same-speaker slot of the same order with a fresh attempt count, at most one extra render; `diagnose('wardrobe-flip')` when the earlier line already aired dressed | show-8 (`tests/engine.test.mjs`, `tests/sponsor-program.test.mjs`) |
| A dressed take landing on an undressed slot cannot flip the look (implied by "one wardrobe per run") | show-9 |
| Writer wording: placement intro/callback, duties, judge TASK 1/TASK 2; `checkSponsoredDialogue` unchanged | show-4 (`tests/sponsor-writer.test.mjs`) |
| `sponsorshipRules` wording | show-3 |
| Fixtures move to `looks-v1` | show-2, show-5, show-6, show-7, show-8 |

Type consistency: `undressed(orderId: string, shotId: number)` is defined in show-7 and called with `(worn.orderId, first.id)` in show-8; `wornBy(line: Line)` is defined and used only in show-9; the `wardrobe-flip` detail keys `shot` and `airedShot` are asserted by show-8's flip test. Nothing here renames or reshapes any CONTRACT name.


---

## Part D: Product and UI — copy, panel, receipt, motion, docs (ui-1 … ui-9)

**Spec:** `docs/superpowers/specs/2026-09-13-tailored-wardrobe-design.md` §4 "Product and UI", §2.7 (replace the logo), §2.8 (receipt `look`), the Tests list ("Browser: …").
**Contract:** `CONTRACT.md` — UI copy block (every string below is copied from it verbatim), receipt `look` shape, asset URL shapes.

## What this section builds

Before payment the panel takes a logo, shows the desk's refusal under the upload field, and previews the host's own still with the logo as a swatch plus the promise "Your tee and cap are tailored right after payment · usually one to two minutes". After payment the card reads TAILORING and breathes; its copy follows the payment clock (0–120 s, past 120 s, past 10 min); when the look lands it rises into the card as YOUR ON-AIR PASS; a fallback or refused look offers "Use a different logo", which uploads a new logo and calls `replaceLogo` with the order token. No look is ever generated before payment, and the card never shows `assetUrl` or the local upload for a cap order.

## Motion personality (decided with the `motion-design` skill; ui-6 implements it)

- **Premium.** One signature curve for every wardrobe moment: `cubic-bezier(0.4, 0, 0.2, 1)`. No overshoot.
- **Duration palette:** reveal 400 ms (the look and the swatch rise 12 px from below while fading in); follow-through: the look's shadow lands 50 ms behind it (same 400 ms, `animation-delay: 50ms`); ambient: a 1600 ms breathe on the card's label icon while the tailor works (`--dur-breathe` / `--ease-breathe`, already in `app/globals.css`).
- **Three layers on the reveal:** primary = the image rising, secondary = the shadow arriving late, ambient = the existing cursor light on the card and the label pulse that stops the moment the look is in.
- **Reduced motion:** the existing `@media (prefers-reduced-motion: reduce) .sponsor-panel * { animation: none !important }` rule covers all of it; ui-6 also names the three new selectors inside that block so a future narrowing cannot bring them back. The still keeps a static desaturation while tailoring, so the state still reads without motion.
- Nothing else in the panel changes its motion (`--ease-cut` stays on the step and receipt entrances).

## Working-tree facts every task must respect

- `components/sponsor-panel.tsx`, `lib/sponsor-client.ts`, `lib/sponsorship.ts`, `app/sponsor.css`, `tests/sponsor-client.test.mjs`, `tests/browser/sponsor-experience.mjs`, `docs/SPONSORSHIP.md` and `README.md` carry **uncommitted hunks from another session** (the "$5 message off sale" work: `sponsorOffers`, `LINES`, "Sponsor the podcast"; and, as of this writing, `lib/sponsor-client.ts` gained `import { cast } from './show'` with `hostName` reading `cast[target ?? 'host'].name`). That session is still editing, so **line numbers below are a guide only — match on the quoted old text**, and leave the `cast` import and `hostName` body exactly as you find them. Before ui-1 run `git status`; if those hunks are still uncommitted, stage only yours with `git add -p <file>` — never `git add -A`, never oxfmt/prettier on these files.
- The receipt type gains `look` from the site section (`SponsorReceipt.look?: { status: 'tailoring' | 'ready' | 'refused'; url?; reason?; fallback?: 'cap-v1'; round? }`). ui-2 adds exactly that field to `lib/sponsorship.ts` **only if it is not there yet**, so this section compiles whichever section lands first.
- `receipt.assetUrl` stays on the receipt (the site keeps it); this section stops using it for cap orders.
- Unit tests: `node --test tests/sponsor-client.test.mjs` (builds `lib/sponsor-client.ts` through `tests/build.mjs` into `work/tests/`).
- Browser suite: `node tests/browser/sponsor-experience.mjs` against the app on port 3316. Start it in a second terminal with `npx vinext dev --hostname 127.0.0.1 --port 3316` (or set `SPONSOR_TEST_ORIGIN`). Trap from memory: a second vinext server on the same `node_modules/.vite` 504s dynamic chunks — stop the 3212 server first or run from a checkout with its own `.vite`. Screenshots land in `work/sponsor-browser/`.
- Type check after every component task: `npx tsc --noEmit`. Lint the touched files: `npx oxlint components/sponsor-panel.tsx components/sponsor-preview.tsx components/sponsor-receipt.tsx lib/sponsor-client.ts`.
- Playwright's `**/api/sponsorship*` glob in the suite does **not** match `/api/sponsorship/assets` (`*` stops at `/`), so ui-4 adds a regex route for the asset desk.

---

### Task ui-1: The product is a tee and a cap — copy in one place

**Files:**
- Modify: `lib/sponsor-client.ts:142-164` (`productCopy.cap`), append `LOOK_COPY` after it
- Modify: `components/sponsor-panel.tsx:58-61` (`LINES.cap`), `:475` (lead), `:626` (upload hint)
- Modify: `tests/browser/sponsor-experience.mjs:167` (the tile regex)
- Test: `tests/sponsor-client.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `productCopy.cap = { title: 'Dress the host', short: 'Your logo on the tee, a cap in your colours', description: 'Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad for 10 live minutes. Six clear appearances, an introduction and a callback.', icon: 'cap' } as const`
  - `export const LOOK_COPY = { previewCaption, tailoring, anotherFit, slow, replace, improving, refused } as const` (exact strings in Step 1; ui-2, ui-4, ui-5 read them).

- [x] **Step 1: Write the failing test**

Append to `tests/sponsor-client.test.mjs`:

```js
void test('the cap sells as a tee and a cap made for the brand, and every waiting line is pinned', () => {
  assert.deepEqual(C.productCopy.cap, {
    title: 'Dress the host',
    short: 'Your logo on the tee, a cap in your colours',
    description:
      'Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad for 10 live minutes. Six clear appearances, an introduction and a callback.',
    icon: 'cap',
  });
  assert.deepEqual(C.LOOK_COPY, {
    previewCaption:
      'Your tee and cap are tailored right after payment · usually one to two minutes',
    tailoring: 'Tailoring your tee and cap · usually one to two minutes',
    anotherFit: 'Still tailoring — trying another fit',
    slow: 'This is taking longer than usual',
    replace: 'Use a different logo',
    improving: "We'll keep improving the fit",
    refused: 'This logo could not be dressed.',
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-client.test.mjs`
Expected: FAIL — `AssertionError [ERR_ASSERTION]: Expected values to be loosely deep-equal` on `productCopy.cap` (actual title `'Sponsor the podcast'`).

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-client.ts` replace lines 157-164 (the `cap` entry of `productCopy` and the closing `} as const;`):

```ts
  cap: {
    title: 'Sponsor the podcast',
    short: 'Your brand. Their very big heads.',
    description:
      'A branded cap on Pepe or Chad for 10 live minutes. Six clear appearances, an introduction, and a callback.',
    icon: 'cap',
  },
} as const;
```

with:

```ts
  cap: {
    title: 'Dress the host',
    short: 'Your logo on the tee, a cap in your colours',
    description:
      'Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad for 10 live minutes. Six clear appearances, an introduction and a callback.',
    icon: 'cap',
  },
} as const;
/**
 * Every line the wardrobe card and the receipt say while a tee and cap are made, pinned
 * here so the panel, the preview and the receipt cannot drift apart. The look is tailored
 * after payment only, so the pre-payment caption is a promise and the rest is a clock.
 */
export const LOOK_COPY = {
  previewCaption:
    'Your tee and cap are tailored right after payment · usually one to two minutes',
  tailoring: 'Tailoring your tee and cap · usually one to two minutes',
  anotherFit: 'Still tailoring — trying another fit',
  slow: 'This is taking longer than usual',
  replace: 'Use a different logo',
  improving: "We'll keep improving the fit",
  refused: 'This logo could not be dressed.',
} as const;
```

In `components/sponsor-panel.tsx` replace lines 58-61:

```tsx
const LINES = {
  spotlight: 'Four turns. Your project.',
  cap: 'Your logo on Pepe or Chad',
};
```

with:

```tsx
const LINES = {
  spotlight: 'Four turns. Your project.',
  cap: productCopy.cap.short,
};
```

Replace line 475:

```tsx
      <p className="sponsor-lead">A project. A cap with your name on it.</p>
```

with:

```tsx
      <p className="sponsor-lead">
        A project. A tee and cap with your name on it.
      </p>
```

Replace line 626:

```tsx
                        <small>Preview it on the actual cap</small>
```

with:

```tsx
                        <small>Tailored onto the tee and cap after payment</small>
```

In `tests/browser/sponsor-experience.mjs` replace line 167:

```js
  assert.match(await tile('cap').innerText(), /Sponsor the podcast/);
```

with:

```js
  assert.match(await tile('cap').innerText(), /Dress the host/);
  assert.match(
    await tile('cap').innerText(),
    /Your logo on the tee, a cap in your colours/,
  );
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-client.test.mjs && npx tsc --noEmit`
Expected: PASS (5 tests), tsc silent.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-client.ts components/sponsor-panel.tsx tests/sponsor-client.test.mjs tests/browser/sponsor-experience.mjs
git commit -m "The sponsorship is sold as a tee and a cap made for the brand

Dress the host: your logo printed on the tee and a cap in your colours, worn by
Pepe or Chad for ten live minutes. Every line the card says while the look is
tailored lives in one table so the panel, preview and receipt cannot drift.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-2: `lookView` — what the card shows, from the receipt and the clock

**Files:**
- Prerequisite: site-1 (adds `look` to `SponsorReceipt` in `lib/sponsorship.ts`); never add it here.
- Modify: `lib/sponsor-client.ts` (append after `LOOK_COPY`)
- Test: `tests/sponsor-client.test.mjs`

**Interfaces:**
- Consumes: `SponsorReceipt.look` (contract shape), `LOOK_COPY` (ui-1), `SponsorTarget`.
- Produces:
  - `export type LookView = { kind: 'tailoring' | 'ready' | 'refused'; label: 'TAILORING' | 'YOUR ON-AIR PASS'; line: string | null; replace: boolean; url: string | null }`
  - `export function lookView(receipt: Pick<SponsorReceipt, 'status' | 'draft' | 'paidAt' | 'look'>, now: number, replacedAt?: number | null): LookView | null` — `null` for non-cap orders and before payment.
  - `export const lookAlt: (target: SponsorTarget | undefined) => string` → `"Pepe wearing your tee and cap"` / `"Chad wearing your tee and cap"`.
  - `export const logoSwatchUrl: (assetId: string | undefined) => string | null` → `/api/sponsorship/assets/${encodeURIComponent(id)}?part=logo`.
  - `export const baseStill: (target: SponsorTarget | undefined) => string` → `/pepe-video.webp` / `/gigachad-video.webp`.

- [x] **Step 1: Write the failing test**

Append to `tests/sponsor-client.test.mjs`:

```js
void test('the wardrobe card follows the order: the payment clock while tailoring, then the look, never the stored asset', () => {
  const paid = {
    status: 'paid',
    draft: {
      product: 'cap',
      name: '',
      message: 'gm',
      target: 'host',
      assetId: 'asset-1',
    },
    paidAt: 1_000_000,
    look: { status: 'tailoring' },
  };
  assert.equal(
    C.lookView(
      { ...paid, draft: { ...paid.draft, product: 'spotlight' } },
      1_000_000,
    ),
    null,
  );
  assert.equal(
    C.lookView({ ...paid, status: 'draft', paidAt: null }, 1_000_000),
    null,
  );
  assert.equal(
    C.lookView(
      { ...paid, status: 'payment-pending', paidAt: null },
      1_000_000,
    ),
    null,
  );
  assert.deepEqual(C.lookView(paid, 1_000_000 + 119_000), {
    kind: 'tailoring',
    label: 'TAILORING',
    line: 'Tailoring your tee and cap · usually one to two minutes',
    replace: false,
    url: null,
  });
  assert.deepEqual(C.lookView(paid, 1_000_000 + 120_000), {
    kind: 'tailoring',
    label: 'TAILORING',
    line: 'Still tailoring — trying another fit',
    replace: false,
    url: null,
  });
  assert.deepEqual(C.lookView(paid, 1_000_000 + 600_000), {
    kind: 'tailoring',
    label: 'TAILORING',
    line: 'This is taking longer than usual',
    replace: true,
    url: null,
  });
  // A missing look on a paid cap is a tailor that has not reported yet, not a finished pass.
  assert.equal(C.lookView({ ...paid, look: undefined }, 1_000_000).kind, 'tailoring');
  // A replaced logo restarts the clock from the replacement, not from the payment.
  assert.equal(
    C.lookView(paid, 1_000_000 + 700_000, 1_000_000 + 650_000).line,
    'Tailoring your tee and cap · usually one to two minutes',
  );
  const url = '/api/sponsorship/assets/asset-1?part=look&v=' + 'c'.repeat(64);
  assert.deepEqual(
    C.lookView({ ...paid, look: { status: 'ready', url } }, 1_000_000 + 900_000),
    { kind: 'ready', label: 'YOUR ON-AIR PASS', line: null, replace: false, url },
  );
  assert.deepEqual(
    C.lookView(
      { ...paid, look: { status: 'ready', url, fallback: 'cap-v1' } },
      1_000_000,
    ),
    {
      kind: 'ready',
      label: 'YOUR ON-AIR PASS',
      line: "We'll keep improving the fit",
      replace: true,
      url,
    },
  );
  assert.deepEqual(
    C.lookView(
      {
        ...paid,
        look: {
          status: 'refused',
          reason: 'This logo could not be dressed. Use a different logo.',
        },
      },
      1_000_000,
    ),
    {
      kind: 'refused',
      label: 'TAILORING',
      line: 'This logo could not be dressed. Use a different logo.',
      replace: true,
      url: null,
    },
  );
  assert.equal(
    C.lookView({ ...paid, look: { status: 'refused' } }, 1_000_000).line,
    'This logo could not be dressed.',
  );
  assert.equal(C.lookAlt('host'), 'Pepe wearing your tee and cap');
  assert.equal(C.lookAlt('guest'), 'Chad wearing your tee and cap');
  assert.equal(C.lookAlt(undefined), 'Pepe wearing your tee and cap');
  assert.equal(
    C.logoSwatchUrl('asset/1'),
    '/api/sponsorship/assets/asset%2F1?part=logo',
  );
  assert.equal(C.logoSwatchUrl(undefined), null);
  assert.equal(C.logoSwatchUrl(''), null);
  assert.equal(C.baseStill('host'), '/pepe-video.webp');
  assert.equal(C.baseStill('guest'), '/gigachad-video.webp');
  assert.equal(C.baseStill(undefined), '/pepe-video.webp');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-client.test.mjs`
Expected: FAIL — `TypeError: C.lookView is not a function`.

- [x] **Step 3: Write minimal implementation**

First, in `lib/sponsorship.ts`, run `grep -n "look?:" lib/sponsorship.ts`. If it prints nothing (the site section has not landed), replace lines 69-71:

```ts
  /** For a paid cap still waiting: how many earlier caps on the same host go on before it. */
  capAhead?: number | null;
};
```

with:

```ts
  /** For a paid cap still waiting: how many earlier caps on the same host go on before it. */
  capAhead?: number | null;
  /** A cap order's wardrobe: tailored after payment, once per logo and host. */
  look?: {
    status: 'tailoring' | 'ready' | 'refused';
    url?: string;
    reason?: string;
    fallback?: 'cap-v1';
    round?: number;
  };
};
```

If the grep printed a line, leave `lib/sponsorship.ts` alone (and do not add it to the commit).

Then append to `lib/sponsor-client.ts`, after the `LOOK_COPY` table:

```ts
/** What the wardrobe card and the receipt show for a paid cap order at one moment. */
export type LookView = {
  kind: 'tailoring' | 'ready' | 'refused';
  label: 'TAILORING' | 'YOUR ON-AIR PASS';
  /** The sentence under the card: the waiting copy, the fallback note, or the refusal. */
  line: string | null;
  /** Offer "Use a different logo". */
  replace: boolean;
  /** The look, once it is ready; the card shows the host's own still until then. */
  url: string | null;
};
/**
 * The sub-states are driven by the clock, not by the desk: the tailor usually answers in
 * one to two minutes, a second fit past two, and past ten the customer is offered a way
 * out. `replacedAt` restarts that clock after "Use a different logo", because the payment
 * time no longer says when this logo's tailoring began. Null before payment and for every
 * other product, so the card stays a preview.
 */
export function lookView(
  receipt: Pick<SponsorReceipt, 'status' | 'draft' | 'paidAt' | 'look'>,
  now: number,
  replacedAt: number | null = null,
): LookView | null {
  if (receipt.draft.product !== 'cap') return null;
  if (receipt.status === 'draft' || receipt.status === 'payment-pending')
    return null;
  const look = receipt.look;
  if (look?.status === 'ready' && look.url)
    return {
      kind: 'ready',
      label: 'YOUR ON-AIR PASS',
      line: look.fallback ? LOOK_COPY.improving : null,
      replace: !!look.fallback,
      url: look.url,
    };
  if (look?.status === 'refused')
    return {
      kind: 'refused',
      label: 'TAILORING',
      line: look.reason || LOOK_COPY.refused,
      replace: true,
      url: null,
    };
  const since = Math.max(receipt.paidAt ?? now, replacedAt ?? 0);
  const elapsed = now - since;
  return {
    kind: 'tailoring',
    label: 'TAILORING',
    line:
      elapsed < 120_000
        ? LOOK_COPY.tailoring
        : elapsed < 600_000
          ? LOOK_COPY.anotherFit
          : LOOK_COPY.slow,
    replace: elapsed >= 600_000,
    url: null,
  };
}
/** The look's alt text: the host, dressed. The card names Chad the way its caption does. */
export const lookAlt = (target: SponsorTarget | undefined) =>
  `${target === 'guest' ? 'Chad' : 'Pepe'} wearing your tee and cap`;
/** The stored, normalised logo, shown as a swatch on the card until the look replaces it. */
export const logoSwatchUrl = (assetId: string | undefined) =>
  assetId
    ? `/api/sponsorship/assets/${encodeURIComponent(assetId)}?part=logo`
    : null;
/** The host's own still: what the card shows before the look exists. */
export const baseStill = (target: SponsorTarget | undefined) =>
  target === 'guest' ? '/gigachad-video.webp' : '/pepe-video.webp';
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-client.test.mjs && npx tsc --noEmit`
Expected: PASS (6 tests), tsc silent.

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-client.ts tests/sponsor-client.test.mjs
git commit -m "The wardrobe card knows what to show from the receipt and the clock

While the tailor works the card reads the payment clock (usually one to two
minutes, another fit past two, a way out past ten); once the look is ready it
shows the look; a fallback or a refusal offers a different logo. Nothing before
payment, nothing for other products.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-3: A paid cap is "being tailored" before it is "in the queue"

**Files:**
- Modify: `lib/sponsor-client.ts:69-86` (`receiptStage`)
- Modify: `components/sponsor-receipt.tsx:2, 11-18, 35-42, 48-56` (label, step index, seal)
- Test: `tests/sponsor-client.test.mjs`

**Interfaces:**
- Consumes: `SponsorReceipt.look` (ui-2).
- Produces: `receiptStage(receipt: Pick<SponsorReceipt, 'status'> & Partial<Pick<SponsorReceipt, 'draft' | 'look'>>): 'payment' | 'tailoring' | 'queued' | 'preparing' | 'on-air' | 'paused' | 'delivered'` — `'tailoring'` only for `status === 'paid'`, `draft.product === 'cap'`, and `look` missing or `look.status === 'tailoring'`.

- [x] **Step 1: Write the failing test**

Append to `tests/sponsor-client.test.mjs`:

```js
void test('a paid cap waits on its tailor before it is in the queue; every other paid order is queued', () => {
  const cap = {
    status: 'paid',
    draft: { product: 'cap', name: '', message: 'gm', target: 'host' },
    attempts: [],
  };
  assert.equal(C.receiptStage({ ...cap, look: { status: 'tailoring' } }), 'tailoring');
  assert.equal(C.receiptStage(cap), 'tailoring');
  assert.equal(
    C.receiptStage({ ...cap, look: { status: 'ready', url: '/look' } }),
    'queued',
  );
  assert.equal(
    C.receiptStage({ ...cap, look: { status: 'refused', reason: 'no' } }),
    'queued',
  );
  assert.equal(
    C.receiptStage({ ...cap, status: 'leased', look: { status: 'tailoring' } }),
    'queued',
  );
  assert.equal(
    C.receiptStage({ ...cap, draft: { ...cap.draft, product: 'spotlight' } }),
    'queued',
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sponsor-client.test.mjs`
Expected: FAIL — `AssertionError: 'queued' == 'tailoring'` on the first assertion.

- [x] **Step 3: Write minimal implementation**

In `lib/sponsor-client.ts` replace lines 69-77 (the head of `receiptStage`):

```ts
export function receiptStage(receipt: Pick<SponsorReceipt, 'status'>) {
  switch (receipt.status) {
    case 'draft':
    case 'payment-pending':
      return 'payment';
    case 'paid':
    case 'leased':
      return 'queued';
```

with:

```ts
export function receiptStage(
  receipt: Pick<SponsorReceipt, 'status'> &
    Partial<Pick<SponsorReceipt, 'draft' | 'look'>>,
) {
  switch (receipt.status) {
    case 'draft':
    case 'payment-pending':
      return 'payment';
    case 'paid':
      // A paid cap cannot be leased until its look exists; the receipt says what it is
      // waiting for. A refused look is back in the queue with a request for a new logo.
      return receipt.draft?.product === 'cap' &&
        (!receipt.look || receipt.look.status === 'tailoring')
        ? 'tailoring'
        : 'queued';
    case 'leased':
      return 'queued';
```

In `components/sponsor-receipt.tsx` replace line 2:

```tsx
import { Check, ExternalLink, Radio, RotateCcw } from 'lucide-react';
```

with:

```tsx
import { Check, ExternalLink, Radio, RotateCcw, Shirt } from 'lucide-react';
```

Replace lines 11-18:

```tsx
const labels = {
  payment: 'Confirming payment',
  queued: 'You’re in the queue',
  preparing: 'Your moment is being prepared',
  'on-air': 'Your sponsorship is on air',
  paused: 'Saved for the next live slot',
  delivered: 'That was your moment.',
};
```

with:

```tsx
const labels = {
  payment: 'Confirming payment',
  tailoring: 'Your tee and cap are being tailored',
  queued: 'You’re in the queue',
  preparing: 'Your moment is being prepared',
  'on-air': 'Your sponsorship is on air',
  paused: 'Saved for the next live slot',
  delivered: 'That was your moment.',
};
```

Replace lines 35-42:

```tsx
  const current =
    stage === 'delivered'
      ? 3
      : stage === 'on-air'
        ? 2
        : stage === 'queued' || stage === 'preparing' || stage === 'paused'
          ? 1
          : 0;
```

with:

```tsx
  const current =
    stage === 'delivered'
      ? 3
      : stage === 'on-air'
        ? 2
        : ['tailoring', 'queued', 'preparing', 'paused'].includes(stage)
          ? 1
          : 0;
```

Replace lines 48-56:

```tsx
      <div className="sponsor-receipt-seal" aria-hidden="true">
        {stage === 'delivered' ? (
          <Check size={24} />
        ) : stage === 'paused' ? (
          <RotateCcw size={22} />
        ) : (
          <Radio size={22} />
        )}
      </div>
```

with:

```tsx
      <div className="sponsor-receipt-seal" aria-hidden="true">
        {stage === 'delivered' ? (
          <Check size={24} />
        ) : stage === 'paused' ? (
          <RotateCcw size={22} />
        ) : stage === 'tailoring' ? (
          <Shirt size={22} />
        ) : (
          <Radio size={22} />
        )}
      </div>
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sponsor-client.test.mjs && npx tsc --noEmit`
Expected: PASS (7 tests), tsc silent (the `labels[stage]` index now covers `'tailoring'`).

- [x] **Step 5: Commit**

```bash
git add lib/sponsor-client.ts components/sponsor-receipt.tsx tests/sponsor-client.test.mjs
git commit -m "A paid cap's receipt says its tee and cap are being tailored

Before the look exists the order cannot be leased, so the receipt names the wait
instead of calling it the queue; the queue heading returns once the look is in
or a new logo is asked for.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-4: Before payment — the logo is checked, the card shows the host's still and a swatch

**Files:**
- Modify: `components/sponsor-preview.tsx` (whole file; it has no uncommitted hunks)
- Modify: `components/sponsor-panel.tsx:22-31, 84, 96-99, 143-149, 211-214, 254-255, 279-283, 288-333, 342-343, 786-790`
- Modify: `tests/browser/sponsor-experience.mjs:12-46, 66-73, 316-317`
- Test: `tests/browser/sponsor-experience.mjs`

**Interfaces:**
- Consumes: `lookView`, `LookView`, `LOOK_COPY`, `lookAlt`, `logoSwatchUrl`, `baseStill` (ui-1/ui-2); the site's upload response `{ id, status: 'logo', url, logoUrl }` (spec §2.1) and its verbatim 422 `{ error, code }`.
- Produces:
  - `SponsorPreview({ draft, artwork?, paid?, look?: LookView | null })` — card image precedence for cap orders: `look.url` when `look.kind === 'ready'`, else `baseStill(draft.target)` with the swatch from `draft.assetId`; label `look?.label ?? (paid ? 'YOUR ON-AIR PASS' : 'PLACEMENT PREVIEW')`; root class gains `tailoring` while `look.kind === 'tailoring'`. DOM hooks ui-5/ui-6 rely on: `.sponsor-look-frame`, `img.sponsor-host-art` (still) / `img.sponsor-host-art.look` (the look, keyed by URL), `img.sponsor-logo-swatch`, `.sponsor-preview-caption small` (the line).
  - Panel: `uploadLogo(file: File, target: SponsorDraft['target']): Promise<{ id: string; logoUrl: string }>` (throws `Error(message)` with the desk's reason); `clock` state bumped in `updateReceipt`; `look` computed as `lookView(receipt, clock)`; the `artwork` state is gone.

- [x] **Step 1: Write the failing test**

In `tests/browser/sponsor-experience.mjs` replace lines 12-14:

```js
let online = true,
  receipt = null,
  quotes = 0;
```

with:

```js
let online = true,
  receipt = null,
  quotes = 0,
  uploads = 0,
  refuseUpload = false;
const replacements = [];
// One stored logo for the whole rehearsal: the desk's id is the sha of (logo, host, version).
const assetId = 'b'.repeat(64);
const logoUrl = `/api/sponsorship/assets/${assetId}?part=logo`;
const lookUrl = `/api/sponsorship/assets/${assetId}?part=look&v=${'c'.repeat(64)}`;
/** True once an <img> has loaded real pixels; false for a broken image. */
const loaded = (img) =>
  img.evaluate((el) =>
    el.complete
      ? el.naturalWidth > 0
      : new Promise((done) => {
          el.addEventListener('load', () => done(el.naturalWidth > 0), {
            once: true,
          });
          el.addEventListener('error', () => done(false), { once: true });
        }),
  );
```

Replace lines 25-31 (inside `catalog()`):

```js
    available: online && id !== 'cap',
    reason: !online
      ? 'The studio is offline.'
      : id === 'cap'
        ? 'Caps are completing their broadcast trial.'
        : null,
  })),
```

with:

```js
    available: online,
    reason: !online ? 'The studio is offline.' : null,
  })),
```

Replace line 41:

```js
  capabilities: { message: true, spotlight: true, cap: false },
```

with:

```js
  capabilities: {
    message: true,
    spotlight: true,
    cap: true,
    capTemplateVersion: 'looks-v1',
  },
```

Replace lines 66-73 (the start of the sponsorship route) :

```js
  await context.route('**/api/sponsorship*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname !== '/api/sponsorship')
      return route.fulfill({
        status: 503,
        json: { error: 'Artwork is not connected in this browser rehearsal.' },
      });
```

with:

```js
  // The mock desk: the upload is checked and stored (or refused with a reason), the stored
  // logo and the finished look are real PNGs, so nothing on the card is ever a broken image.
  await context.route(/\/api\/sponsorship\/assets(\/|$)/, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === 'POST') {
      uploads++;
      if (refuseUpload)
        return route.fulfill({
          status: 422,
          json: { error: 'This logo is too thin to print.', code: 'LOGO_TOO_THIN' },
        });
      return route.fulfill({
        json: { id: assetId, status: 'logo', url: logoUrl, logoUrl },
      });
    }
    return route.fulfill({
      path:
        url.searchParams.get('part') === 'look'
          ? 'public/pepe-video.png'
          : 'public/logo.png',
    });
  });
  await context.route('**/api/sponsorship*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname !== '/api/sponsorship')
      return route.fulfill({
        status: 503,
        json: { error: 'Artwork is not connected in this browser rehearsal.' },
      });
```

In the same route, the draft handler sets `priceCents: 2500`; replace line 91:

```js
          priceCents: 2500,
```

with:

```js
          priceCents: body.draft.product === 'cap' ? 10000 : 2500,
```

Then insert the cap flow between line 316 `  await context.close();` and line 317 `  online = false;`:

```js
  // ---- Dress the host. The logo is checked at upload; the tee and cap are tailored after payment.
  receipt = null;
  refuseUpload = false;
  const fitting = await setup({ width: 1440, height: 1100 });
  const cap = fitting.page.locator('.sponsor-panel');
  await cap
    .locator('input[name="sponsor-product"][value="cap"]')
    .check({ force: true });
  await cap.getByRole('button', { name: 'Continue', exact: true }).click();
  await fitting.page.locator('#sponsor-projectName').fill('Canvas');
  // Before any logo: the host's own still, no swatch, and the promise of what happens after payment.
  const card = fitting.page.locator('.sponsor-preview.cap');
  assert.match(
    await card.locator('.sponsor-preview-caption').innerText(),
    /Your tee and cap are tailored right after payment · usually one to two minutes/,
  );
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.webp$/,
  );
  assert.equal(await card.locator('.sponsor-logo-swatch').count(), 0);
  // A logo the desk cannot print is refused under the upload field, before any money moves.
  refuseUpload = true;
  await fitting.page
    .locator('#sponsor-logo-file')
    .setInputFiles('public/logo.png');
  await cap.locator('#sponsor-assetId-error').waitFor();
  assert.equal(
    await cap.locator('#sponsor-assetId-error').innerText(),
    'This logo is too thin to print.',
  );
  assert.equal(await card.locator('.sponsor-logo-swatch').count(), 0);
  refuseUpload = false;
  await fitting.page
    .locator('#sponsor-logo-file')
    .setInputFiles('public/logo.png');
  await card.locator('.sponsor-logo-swatch').waitFor();
  assert.equal(await cap.locator('#sponsor-assetId-error').count(), 0);
  assert.equal(uploads, 2);
  assert.match(
    await card.locator('.sponsor-logo-swatch').getAttribute('src'),
    new RegExp(`/api/sponsorship/assets/${assetId}\\?part=logo$`),
  );
  assert.ok(
    await loaded(card.locator('.sponsor-logo-swatch')),
    'the swatch is the stored logo, not a broken image',
  );
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.webp$/,
    'no look exists before payment',
  );
  assert.equal(
    await cap.getByRole('button', { name: 'Change your logo' }).count(),
    1,
  );
  await fitting.context.close();
```

- [x] **Step 2: Run test to verify it fails**

Run (app on 3316 in another terminal): `node tests/browser/sponsor-experience.mjs`
Expected: FAIL — `AssertionError` on the caption match: actual `WARDROBE / PEPE\nMake the cap yours.\n10 live minutes · 6+ appearances` does not match `/Your tee and cap are tailored right after payment/`.

- [x] **Step 3: Write minimal implementation**

Replace the whole of `components/sponsor-preview.tsx` with:

```tsx
'use client';
/* oxlint-disable next/no-img-element -- Canonical wardrobe and broadcast artwork. */
import { useEffect, useRef } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';
import type { SponsorDraft } from '@/lib/sponsorship';
import {
  LOOK_COPY,
  baseStill,
  logoSwatchUrl,
  lookAlt,
  type LookView,
} from '@/lib/sponsor-client';

/** A preview is deliberately labeled: it never represents something currently on air. */
export function SponsorPreview({
  draft,
  artwork,
  paid = false,
  look = null,
}: {
  draft: SponsorDraft;
  /** A spotlight's stored logo. A cap never passes one: its card is the still or the look. */
  artwork?: string | null;
  paid?: boolean;
  /** A paid cap order's wardrobe state; null before payment and for every other product. */
  look?: LookView | null;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = panel.current;
    if (
      !node ||
      !matchMedia(
        '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)',
      ).matches
    )
      return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.hidden) return;
        const rect = node.getBoundingClientRect();
        node.style.setProperty('--cursor-x', `${e.clientX - rect.left}px`);
        node.style.setProperty('--cursor-y', `${e.clientY - rect.top}px`);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      node.style.removeProperty('--cursor-x');
      node.style.removeProperty('--cursor-y');
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', leave);
    return () => {
      leave();
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
    };
  }, []);
  const hostName = draft.target === 'guest' ? 'Chad' : 'Pepe';
  // The card image, in order: the look once it is ready, otherwise the host's own still
  // with the stored logo as a swatch. Never the asset URL (the logo while the tailor works)
  // and never a local upload: nothing is generated before payment.
  const lookUrl = look?.kind === 'ready' ? look.url : null;
  const swatch = lookUrl ? null : logoSwatchUrl(draft.assetId);
  return (
    <div
      ref={panel}
      className={`sponsor-preview ${draft.product}${
        look?.kind === 'tailoring' ? ' tailoring' : ''
      }`}
    >
      <div className="sponsor-preview-light" aria-hidden="true" />
      <div className="sponsor-preview-label">
        <Radio size={12} />
        <span>
          {look ? look.label : paid ? 'YOUR ON-AIR PASS' : 'PLACEMENT PREVIEW'}
        </span>
        <span>001</span>
      </div>
      {draft.product === 'cap' ? (
        <>
          <div className="sponsor-look-frame">
            {lookUrl ? (
              <img
                key={lookUrl}
                className="sponsor-host-art look"
                src={lookUrl}
                alt={lookAlt(draft.target)}
              />
            ) : (
              <img
                className="sponsor-host-art"
                src={baseStill(draft.target)}
                alt={`${hostName}, not yet dressed`}
              />
            )}
            {swatch ? (
              <img className="sponsor-logo-swatch" src={swatch} alt="Your logo" />
            ) : null}
          </div>
          <div className="sponsor-preview-caption">
            <span>WARDROBE / {hostName.toUpperCase()}</span>
            <b>{draft.projectName || 'Make the tee and cap yours.'}</b>
            <small>
              {look
                ? (look.line ?? '10 live minutes · 6+ appearances')
                : LOOK_COPY.previewCaption}
            </small>
          </div>
        </>
      ) : draft.product === 'spotlight' ? (
        <>
          {/* The cover shows the purchase itself: the card that sits on the
              broadcast while the hosts talk, drawn like the real one. */}
          <div className="sponsor-preview-stage">
            <div className="sponsor-preview-hosts" aria-hidden="true">
              <img src="/pepe-video.webp" alt="" loading="lazy" />
              <img src="/gigachad-video.webp" alt="" loading="lazy" />
            </div>
            <div className="sponsor-preview-banner">
              <span>SPONSORED</span>
              {artwork ? <img src={artwork} alt="" /> : null}
              <div>
                <b>{draft.projectName || 'Your project'}</b>
                <small>On screen for the whole exchange</small>
              </div>
              <ArrowUpRight size={15} />
            </div>
          </div>
          <div className="sponsor-cue">
            <span className="sponsor-cue-label">FOUR TURNS · SPONSORED</span>
            <p>
              {draft.message ||
                'A real conversation about what you’re building.'}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="sponsor-preview-hosts" aria-hidden="true">
            <img src="/pepe-video.webp" alt="" loading="lazy" />
            <img src="/gigachad-video.webp" alt="" loading="lazy" />
          </div>
          <div className="sponsor-cue">
            <span className="sponsor-cue-label">FROM THE TRENCHES</span>
            <div className="sponsor-cue-name">
              <b>Straight to the hosts.</b>
            </div>
            <p>
              {draft.message ||
                '“Chad, is holding still a strategy if I forgot my password?”'}
            </p>
          </div>
        </>
      )}
      <div className="sponsor-preview-footer">
        <span>PEPE & CHAD LIVE</span>
        <span>{paid ? 'RESERVED FOR YOU' : 'THIS COULD BE YOU ↗'}</span>
      </div>
    </div>
  );
}
```

Then, in `components/sponsor-panel.tsx`, apply these exact replacements (hand-format; do not run a formatter on this file):

(a) lines 22-31 —

```tsx
import {
  capQueueLabel,
  catalogPriceCents,
  checkoutKey,
  dollars,
  emptyDraft,
  hostName,
  productCopy,
  readCheckout,
} from '@/lib/sponsor-client';
```

→

```tsx
import {
  capQueueLabel,
  catalogPriceCents,
  checkoutKey,
  dollars,
  emptyDraft,
  hostName,
  lookView,
  productCopy,
  readCheckout,
} from '@/lib/sponsor-client';
```

(b) line 84 —

```tsx
  const [artwork, setArtwork] = useState<string | null>(null);
```

→

```tsx
  // The clock the tailoring copy reads. It moves with every receipt poll (4 s while an
  // order is live), which is as often as the copy needs to advance.
  const [clock, setClock] = useState(() => Date.now());
```

(c) lines 96-99 —

```tsx
  const updateReceipt = useCallback((next: Receipt) => {
    receiptRef.current = next;
    setReceipt(next);
    setToken(next.token);
```

→

```tsx
  const updateReceipt = useCallback((next: Receipt) => {
    receiptRef.current = next;
    setReceipt(next);
    setToken(next.token);
    setClock(Date.now());
```

(d) lines 143-149 —

```tsx
      setDraft(saved.draft);
      setAsset(saved.asset);
      setArtwork(
        saved.draft.assetId
          ? `/api/sponsorship/assets/${encodeURIComponent(saved.draft.assetId)}`
          : null,
      );
      setToken(
```

→

```tsx
      setDraft(saved.draft);
      setAsset(saved.asset);
      setToken(
```

(e) lines 211-214 —

```tsx
        if (touchedToken.current !== token) {
          setDraft(next.draft);
          setArtwork(next.assetUrl);
          setStep(3);
```

→

```tsx
        if (touchedToken.current !== token) {
          setDraft(next.draft);
          setStep(3);
```

(f) lines 254-255 —

```tsx
  const received =
    !!receipt && !['draft', 'payment-pending'].includes(receipt.status);
```

→

```tsx
  const received =
    !!receipt && !['draft', 'payment-pending'].includes(receipt.status);
  const look = receipt ? lookView(receipt, clock) : null;
```

(g) lines 279-283 —

```tsx
    if (patch.product || patch.target) {
      assetEpoch.current++;
      setArtwork(null);
      patch.assetId = undefined;
    }
```

→

```tsx
    if (patch.product || patch.target) {
      assetEpoch.current++;
      patch.assetId = undefined;
    }
```

(h) lines 288-333, the whole `upload` function —

```tsx
  async function upload(selected: File | undefined) {
    if (!selected || uploading || locked) return;
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) ||
      selected.size > 4 * 1024 * 1024
    ) {
      setFieldErrors({ assetId: 'Use a PNG, JPG, or WebP image under 4 MB.' });
      return;
    }
    setUploading(true);
    setError('');
    const epoch = ++assetEpoch.current;
    try {
      const data = new FormData();
      data.set('image', selected);
      data.set('kind', draft.product === 'cap' ? 'cap' : 'logo');
      data.set('target', draft.target || 'host');
      const response = await fetch('/api/sponsorship/assets', {
        method: 'POST',
        body: data,
        signal: AbortSignal.timeout(45000),
      });
      const result = (await response.json()) as {
        id?: string;
        url?: string;
        error?: string;
      };
      if (!response.ok || !result.id || !result.url)
        throw Error(result.error || 'Your artwork could not be prepared.');
      if (epoch !== assetEpoch.current) return;
      setDraft((d) => ({ ...d, assetId: result.id }));
      setArtwork(result.url);
      setFieldErrors({});
    } catch (e) {
      if (epoch === assetEpoch.current)
        setFieldErrors({
          assetId:
            e instanceof Error
              ? e.message
              : 'Your artwork could not be prepared.',
        });
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  }
```

→

```tsx
  /**
   * The desk normalises the logo and refuses one it could never print (empty, hair-thin,
   * undecodable) before any money moves; its reason comes back verbatim. Nothing is
   * generated here: the tee and cap are tailored after payment, from the stored logo.
   */
  async function uploadLogo(
    selected: File,
    target: SponsorDraft['target'],
  ): Promise<{ id: string; logoUrl: string }> {
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) ||
      selected.size > 4 * 1024 * 1024
    )
      throw Error('Use a PNG, JPG, or WebP image under 4 MB.');
    const data = new FormData();
    data.set('image', selected);
    data.set('kind', 'cap');
    data.set('target', target || 'host');
    const response = await fetch('/api/sponsorship/assets', {
      method: 'POST',
      body: data,
      signal: AbortSignal.timeout(45000),
    });
    const result = (await response.json()) as {
      id?: string;
      logoUrl?: string;
      error?: string;
    };
    if (!response.ok || !result.id || !result.logoUrl)
      throw Error(result.error || 'Your logo could not be prepared.');
    return { id: result.id, logoUrl: result.logoUrl };
  }
  async function upload(selected: File | undefined) {
    if (!selected || uploading || locked) return;
    setUploading(true);
    setError('');
    const epoch = ++assetEpoch.current;
    try {
      const uploaded = await uploadLogo(selected, draft.target);
      if (epoch !== assetEpoch.current) return;
      setDraft((d) => ({ ...d, assetId: uploaded.id }));
      setFieldErrors({});
    } catch (e) {
      if (epoch === assetEpoch.current)
        setFieldErrors({
          assetId:
            e instanceof Error ? e.message : 'Your logo could not be prepared.',
        });
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  }
```

(i) lines 342-343 —

```tsx
    if (draft.product === 'cap' && !draft.assetId)
      fields.assetId = 'Add your logo to preview the cap.';
```

→

```tsx
    if (draft.product === 'cap' && !draft.assetId)
      fields.assetId = 'Add your logo first.';
```

(j) lines 786-790 —

```tsx
      <SponsorPreview
        draft={draft}
        artwork={artwork || receipt?.assetUrl}
        paid={received}
      />
```

→

```tsx
      {/* A cap's stored asset is the logo until the look lands, so it is never the card
          image; only a spotlight's stored logo is artwork for the card. */}
      <SponsorPreview
        draft={draft}
        artwork={
          draft.product === 'spotlight' ? (receipt?.assetUrl ?? null) : null
        }
        paid={received}
        look={look}
      />
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx oxlint components/sponsor-panel.tsx components/sponsor-preview.tsx lib/sponsor-client.ts && node tests/browser/sponsor-experience.mjs`
Expected: tsc and oxlint silent; the suite prints `Browser rehearsal passed: …` (the cap block runs after the desktop spotlight flow and before the 320 px flow).

- [x] **Step 5: Commit**

```bash
git add components/sponsor-preview.tsx components/sponsor-panel.tsx tests/browser/sponsor-experience.mjs
git commit -m "The logo is checked at upload; the card promises the tee and cap after payment

The upload stores the normalised logo and shows the desk's refusal under the
field before any money moves. The card shows the host's own still with the logo
as a swatch and says the tee and cap are tailored right after payment; no look
is generated first, and the stored asset URL is never the card image.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-5: After payment — tailoring sub-states, the look, and "Use a different logo"

**Files:**
- Modify: `components/sponsor-receipt.tsx` (whole file, on top of ui-3)
- Modify: `components/sponsor-panel.tsx` (the `clock` line from ui-4, the poll effect, `act`, `newOrder`, the `<SponsorReceipt>` call)
- Modify: `tests/browser/sponsor-experience.mjs` (the sponsorship route's POST branch; the cap flow from ui-4)
- Test: `tests/browser/sponsor-experience.mjs`

**Interfaces:**
- Consumes: `lookView(receipt, now, replacedAt)`, `LookView`, `LOOK_COPY.replace` (ui-1/2), `receiptStage` `'tailoring'` (ui-3), `uploadLogo` (ui-4), `sponsorAction` (`lib/sponsor-browser.ts`), the site's `POST /api/sponsorship { action: 'replaceLogo', orderId, token, assetId }` (spec §2.7; site section).
- Produces:
  - `SponsorReceipt({ receipt, busy, look: LookView | null, onAction: (action: 'reschedule') => void, onReplaceLogo: (file: File) => void, onNew })`. Kicker = `look?.label ?? 'YOUR ON-AIR PASS'`; under a `tailoring` heading the sentence is `look.line`; when `look.replace` a `.sponsor-look-replace` block shows `look.line` (unless the heading already carries it) and the button "Use a different logo" (`#sponsor-replace-logo` is its hidden file input).
  - Panel: `replaceLogo(file: File): Promise<void>` — upload, then `sponsorAction({ action: 'replaceLogo', orderId: receipt.id, token: receipt.token, assetId })`, then `setReplacedAt(Date.now())`; `replacedAt` resets on a new order and on a different receipt token.

- [x] **Step 1: Write the failing test**

In `tests/browser/sponsor-experience.mjs`, in the sponsorship route's POST branch, replace:

```js
      } else result = { receipt };
    }
    return route.fulfill({ json: result });
```

with:

```js
      } else if (body.action === 'replaceLogo') {
        replacements.push(body);
        receipt.draft.assetId = body.assetId;
        receipt.look = { status: 'tailoring' };
        result = { receipt };
      } else result = { receipt };
    }
    return route.fulfill({ json: result });
```

Then, in the cap flow from ui-4, replace its last two lines:

```js
  assert.equal(
    await cap.getByRole('button', { name: 'Change your logo' }).count(),
    1,
  );
  await fitting.context.close();
```

with:

```js
  assert.equal(
    await cap.getByRole('button', { name: 'Change your logo' }).count(),
    1,
  );
  await fitting.page
    .locator('#sponsor-message')
    .fill('Canvas is where trench builders keep their receipts.');
  await cap.getByRole('button', { name: 'Continue to payment' }).click();
  await cap.getByRole('button', { name: 'Scan to pay' }).waitFor();
  assert.equal(receipt.draft.assetId, assetId, 'the order carries the logo');
  // Payment lands; the desk starts tailoring. The card keeps the still and the swatch.
  receipt.status = 'paid';
  receipt.paidAt = Date.now();
  receipt.queuePosition = 1;
  receipt.look = { status: 'tailoring' };
  await cap
    .getByRole('heading', { name: 'Your tee and cap are being tailored' })
    .waitFor({ timeout: 10000 });
  assert.match(await card.locator('.sponsor-preview-label').innerText(), /TAILORING/);
  assert.match(
    await cap.locator('.sponsor-receipt > .sponsor-kicker').innerText(),
    /TAILORING/,
  );
  assert.equal(
    await cap.locator('.sponsor-receipt > p:not(.sponsor-kicker)').first().innerText(),
    'Tailoring your tee and cap · usually one to two minutes',
  );
  assert.ok(await card.evaluate((el) => el.classList.contains('tailoring')));
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.webp$/,
    'the still, never the stored asset URL, while the tailor works',
  );
  assert.equal(
    await card.locator('.sponsor-preview-caption small').innerText(),
    'Tailoring your tee and cap · usually one to two minutes',
  );
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  // A reload during tailoring shows the still and the swatch, never a broken image.
  await fitting.page.reload({ waitUntil: 'networkidle' });
  await cap
    .getByRole('heading', { name: 'Your tee and cap are being tailored' })
    .waitFor({ timeout: 10000 });
  await card.locator('.sponsor-logo-swatch').waitFor();
  for (const img of await card.locator('img').all())
    assert.ok(await loaded(img), 'every image on the card after a reload is real');
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.webp$/,
  );
  // The receipt's clock, not the desk, drives the waiting copy.
  receipt.paidAt = Date.now() - 130000;
  await card
    .locator('.sponsor-preview-caption small', {
      hasText: 'Still tailoring — trying another fit',
    })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  receipt.paidAt = Date.now() - 11 * 60000;
  await card
    .locator('.sponsor-preview-caption small', {
      hasText: 'This is taking longer than usual',
    })
    .waitFor({ timeout: 10000 });
  await cap.getByRole('button', { name: 'Use a different logo' }).waitFor();
  // A different logo goes through the same check; the order points at it and the clock restarts.
  await cap.locator('#sponsor-replace-logo').setInputFiles('public/logo.png');
  await card
    .locator('.sponsor-preview-caption small', {
      hasText: 'Tailoring your tee and cap · usually one to two minutes',
    })
    .waitFor({ timeout: 10000 });
  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0], {
    action: 'replaceLogo',
    orderId: 'order-browser-rehearsal',
    token: 'a'.repeat(64),
    assetId,
  });
  assert.equal(uploads, 3);
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  // The look lands: it replaces the still, the swatch goes, the label becomes the pass.
  receipt.look = { status: 'ready', url: lookUrl };
  await card.locator('.sponsor-host-art.look').waitFor({ timeout: 10000 });
  assert.match(
    await card.locator('.sponsor-host-art.look').getAttribute('src'),
    /part=look&v=/,
  );
  assert.equal(
    await card.locator('.sponsor-host-art.look').getAttribute('alt'),
    'Pepe wearing your tee and cap',
  );
  assert.ok(await loaded(card.locator('.sponsor-host-art.look')));
  assert.match(
    await card.locator('.sponsor-preview-label').innerText(),
    /YOUR ON-AIR PASS/,
  );
  assert.equal(await card.locator('.sponsor-logo-swatch').count(), 0);
  assert.equal(await card.evaluate((el) => el.classList.contains('tailoring')), false);
  await cap
    .getByRole('heading', { name: 'You’re in the queue' })
    .waitFor({ timeout: 10000 });
  assert.match(
    await cap.locator('.sponsor-receipt > .sponsor-kicker').innerText(),
    /YOUR ON-AIR PASS/,
  );
  assert.equal(
    await cap.getByRole('button', { name: 'Use a different logo' }).count(),
    0,
  );
  // A fallback look airs, says so, and still offers a better fit.
  receipt.look = { status: 'ready', url: lookUrl, fallback: 'cap-v1' };
  await cap
    .locator('.sponsor-look-replace', { hasText: "We'll keep improving the fit" })
    .waitFor({ timeout: 10000 });
  await cap.getByRole('button', { name: 'Use a different logo' }).waitFor();
  assert.match(
    await card.locator('.sponsor-host-art.look').getAttribute('src'),
    /part=look&v=/,
  );
  // A refused logo says why and asks for another; nothing pulses.
  receipt.look = {
    status: 'refused',
    reason: 'This logo could not be dressed. Use a different logo.',
  };
  await cap
    .locator('.sponsor-look-replace', { hasText: 'This logo could not be dressed.' })
    .waitFor({ timeout: 10000 });
  assert.match(await card.locator('.sponsor-preview-label').innerText(), /TAILORING/);
  assert.equal(await card.evaluate((el) => el.classList.contains('tailoring')), false);
  assert.match(
    await card.locator('.sponsor-host-art').getAttribute('src'),
    /\/pepe-video\.webp$/,
  );
  await fitting.page.evaluate(() =>
    window.scrollTo({ top: 0, behavior: 'instant' }),
  );
  await fitting.page.screenshot({
    path: 'work/sponsor-browser/desktop-fitting.png',
    fullPage: true,
  });
  await fitting.context.close();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node tests/browser/sponsor-experience.mjs`
Expected: FAIL — `TimeoutError: locator.waitFor: Timeout 10000ms exceeded` waiting for the heading "Your tee and cap are being tailored" is **not** the first failure (ui-3 already renders it); the first failure is `AssertionError` on the receipt kicker: `'YOUR ON-AIR PASS'` does not match `/TAILORING/`.

- [x] **Step 3: Write minimal implementation**

Replace the whole of `components/sponsor-receipt.tsx` with:

```tsx
'use client';
import { useRef } from 'react';
import {
  Check,
  ExternalLink,
  Radio,
  RotateCcw,
  Shirt,
  Upload,
} from 'lucide-react';
import type { SponsorReceipt as Receipt } from '@/lib/sponsorship';
import {
  LOOK_COPY,
  capAheadCopy,
  deliveryProgress,
  dollars,
  productCopy,
  receiptStage,
  type LookView,
} from '@/lib/sponsor-client';
const labels = {
  payment: 'Confirming payment',
  tailoring: 'Your tee and cap are being tailored',
  queued: 'You’re in the queue',
  preparing: 'Your moment is being prepared',
  'on-air': 'Your sponsorship is on air',
  paused: 'Saved for the next live slot',
  delivered: 'That was your moment.',
};
export function SponsorReceipt({
  receipt,
  busy,
  look,
  onAction,
  onReplaceLogo,
  onNew,
}: {
  receipt: Receipt;
  busy: boolean;
  /** The wardrobe state of a paid cap order; null for every other order. */
  look: LookView | null;
  onAction: (action: 'reschedule') => void;
  onReplaceLogo: (file: File) => void;
  onNew: () => void;
}) {
  const replaceFile = useRef<HTMLInputElement>(null);
  const stage = receiptStage(receipt);
  const attempt =
    receipt.attempts.find((a) => a.status === 'verified') ??
    receipt.attempts[0];
  const steps = ['Payment received', 'In the queue', 'On air', 'Delivered'];
  const current =
    stage === 'delivered'
      ? 3
      : stage === 'on-air'
        ? 2
        : ['tailoring', 'queued', 'preparing', 'paused'].includes(stage)
          ? 1
          : 0;
  return (
    <section
      className={`sponsor-receipt ${stage}`}
      aria-label="Your sponsorship receipt"
    >
      <div className="sponsor-receipt-seal" aria-hidden="true">
        {stage === 'delivered' ? (
          <Check size={24} />
        ) : stage === 'paused' ? (
          <RotateCcw size={22} />
        ) : stage === 'tailoring' ? (
          <Shirt size={22} />
        ) : (
          <Radio size={22} />
        )}
      </div>
      <p className="sponsor-kicker">{look?.label ?? 'YOUR ON-AIR PASS'}</p>
      <h3 aria-live="polite" aria-atomic="true">
        {labels[stage]}
      </h3>
      <p>
        {stage === 'tailoring' && look?.line
          ? look.line
          : stage === 'paused'
            ? 'Your remaining placement is safe. It resumes in the next live slot.'
            : stage === 'delivered'
              ? 'From your wallet to the conversation. Thanks for being part of the show.'
              : 'Keep watching. This receipt follows your placement through the studio.'}
      </p>
      <div className="sponsor-receipt-details">
        <span>{productCopy[receipt.draft.product].title}</span>
        <strong>
          {attempt
            ? `${attempt.amountUi} ${attempt.asset}`
            : dollars(receipt.priceCents)}
        </strong>
      </div>
      {receipt.queuePosition ? (
        <p className="sponsor-queue-position">
          Queue position <strong>{receipt.queuePosition}</strong> · We’ll update
          this as the show moves.
        </p>
      ) : null}
      {/* Caps for one host go on one at a time: a paid cap can be next in the queue and
          still be waiting for an earlier cap on the same host. Say so. */}
      {receipt.status === 'paid' && receipt.capAhead ? (
        <p className="sponsor-cap-ahead">
          {capAheadCopy(receipt.capAhead, receipt.draft.target)}
        </p>
      ) : null}
      {/* A slow, fallback or refused fit offers a way out: a different logo goes through the
          same check and the order keeps its place. The order is never lost. */}
      {look?.replace ? (
        <div className="sponsor-look-replace">
          {stage !== 'tailoring' && look.line ? <p>{look.line}</p> : null}
          <input
            className="sr-only"
            ref={replaceFile}
            id="sponsor-replace-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              if (chosen) onReplaceLogo(chosen);
            }}
          />
          <button
            type="button"
            className="sponsor-button secondary"
            disabled={busy}
            onClick={() => replaceFile.current?.click()}
          >
            <Upload size={15} />
            {LOOK_COPY.replace}
          </button>
        </div>
      ) : null}
      {receipt.draft.product === 'cap' && (
        <div className="sponsor-delivery-progress">
          <progress max={100} value={deliveryProgress(receipt.fulfillment)} />
          <span>
            {Math.min(10, Math.floor(receipt.fulfillment.visibleMs / 60000))} /
            10 live minutes · {receipt.fulfillment.appearances} appearances
          </span>
        </div>
      )}
      <ol className="sponsor-receipt-steps">
        {steps.map((label, i) => (
          <li key={label} className={i <= current ? 'reached' : ''}>
            <span>
              {i < current || stage === 'delivered' ? (
                <Check size={11} />
              ) : (
                i + 1
              )}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <div className="sponsor-receipt-links">
        <a href={`/?receipt=${encodeURIComponent(receipt.token)}`}>
          Open receipt <ExternalLink size={12} />
        </a>
        {attempt?.explorerUrl && (
          <a
            href={attempt.explorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            Payment on Solana <ExternalLink size={12} />
          </a>
        )}
      </div>
      {receipt.canReschedule && (
        <button
          type="button"
          className="sponsor-button"
          disabled={busy}
          onClick={() => onAction('reschedule')}
        >
          Use the next live slot →
        </button>
      )}
      {/* Every paid pass leads somewhere: a way back to the placements is always one tap. */}
      {stage !== 'payment' ? (
        <button
          type="button"
          className="sponsor-button secondary"
          onClick={onNew}
        >
          Create another moment
        </button>
      ) : null}
      <small className="sponsor-receipt-id">
        PASS {receipt.id.slice(0, 8).toUpperCase()} · Keep your receipt link
        private.
      </small>
    </section>
  );
}
```

Then in `components/sponsor-panel.tsx` apply these exact replacements:

(a) the `clock` state from ui-4 —

```tsx
  const [clock, setClock] = useState(() => Date.now());
```

→

```tsx
  const [clock, setClock] = useState(() => Date.now());
  // When the customer swaps the logo after paying, tailoring starts again from now, not
  // from the payment; the receipt has no field for that, so the page keeps the moment.
  const [replacedAt, setReplacedAt] = useState<number | null>(null);
```

(b) the `look` line from ui-4 —

```tsx
  const look = receipt ? lookView(receipt, clock) : null;
```

→

```tsx
  const look = receipt ? lookView(receipt, clock, replacedAt) : null;
```

(c) in the receipt poll effect —

```tsx
        if (touchedToken.current !== token) {
          setDraft(next.draft);
          setStep(3);
```

→

```tsx
        if (touchedToken.current !== token) {
          setDraft(next.draft);
          setReplacedAt(null);
          setStep(3);
```

(d) the end of `act()` — after

```tsx
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function goStep(next: 1 | 2 | 3) {
```

insert `replaceLogo` so the block reads:

```tsx
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  /**
   * After payment the order keeps its place; only its logo changes. The new logo goes
   * through the same desk check, then the order is pointed at it and tailoring starts
   * again. The desk's refusal, or the site's, lands in the panel's alert.
   */
  async function replaceLogo(selected: File) {
    if (!receipt || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const uploaded = await uploadLogo(selected, receipt.draft.target);
      const result = await sponsorAction({
        action: 'replaceLogo',
        orderId: receipt.id,
        token: receipt.token,
        assetId: uploaded.id,
      });
      setReplacedAt(Date.now());
      if (result.receipt) updateReceipt(result.receipt);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Your logo could not be replaced.',
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function goStep(next: 1 | 2 | 3) {
```

(e) in `newOrder()` —

```tsx
    setToken(null);
    setQr('');
    navigated.current = true;
```

→

```tsx
    setToken(null);
    setQr('');
    setReplacedAt(null);
    navigated.current = true;
```

(f) the `<SponsorReceipt>` call —

```tsx
        <SponsorReceipt
          receipt={receipt}
          busy={busy}
          onAction={act}
          onNew={() => newOrder(1)}
        />
```

→

```tsx
        <SponsorReceipt
          receipt={receipt}
          busy={busy}
          look={look}
          onAction={act}
          onReplaceLogo={(chosen) => void replaceLogo(chosen)}
          onNew={() => newOrder(1)}
        />
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx oxlint components/sponsor-panel.tsx components/sponsor-receipt.tsx && node tests/browser/sponsor-experience.mjs`
Expected: tsc and oxlint silent; `Browser rehearsal passed: …`; `work/sponsor-browser/desktop-fitting.png` shows the refused state with the button.

- [x] **Step 5: Commit**

```bash
git add components/sponsor-receipt.tsx components/sponsor-panel.tsx tests/browser/sponsor-experience.mjs
git commit -m "The receipt follows the tailor: waiting copy, the look, a way to change the logo

After paying, the card reads TAILORING with the host's still and the logo swatch,
its copy follows the clock (one to two minutes, another fit past two, a way out
past ten), and the look replaces the still as YOUR ON-AIR PASS. A fallback or a
refused fit offers Use a different logo, which checks the new logo the same way
and points the paid order at it. A reload while tailoring shows the still, never
a broken image.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-6: Motion — the tailoring breathe and the Premium look reveal

**Files:**
- Modify: `app/sponsor.css` (append after the `.sponsor-queue-position, .sponsor-cap-ahead { … }` rule, ~line 1252; extend the `@media (prefers-reduced-motion: reduce)` block, lines 1176-1188)
- Modify: `tests/browser/sponsor-experience.mjs` (the cap flow from ui-5)
- Test: `tests/browser/sponsor-experience.mjs`

**Interfaces:**
- Consumes: the DOM hooks from ui-4/ui-5: `.sponsor-preview.tailoring`, `.sponsor-preview-label svg`, `.sponsor-look-frame`, `.sponsor-host-art.look`, `.sponsor-logo-swatch`, `.sponsor-look-replace`; tokens `--dur-breathe`, `--ease-breathe` from `app/globals.css`.
- Produces: keyframes `sponsor-look-in`, `sponsor-look-shadow`, `sponsor-swatch-in`, `sponsor-tailoring`. Personality Premium: `cubic-bezier(0.4, 0, 0.2, 1)`, reveal 400 ms with a 12 px rise, shadow 50 ms behind, breathe 1600 ms; all off under reduced motion.

- [x] **Step 1: Write the failing test**

In the cap flow (ui-5), right after

```js
  assert.ok(await loaded(card.locator('.sponsor-host-art.look')));
```

insert:

```js
  // Premium motion: the look rises 12 px over 400 ms on one curve, its shadow 50 ms behind.
  assert.deepEqual(
    await card.locator('.sponsor-host-art.look').evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        s.animationName,
        s.animationDuration,
        s.animationDelay,
        s.animationTimingFunction,
        s.position,
      ];
    }),
    [
      'sponsor-look-in, sponsor-look-shadow',
      '0.4s, 0.4s',
      '0s, 0.05s',
      'cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1)',
      'relative',
    ],
  );
```

And right before

```js
  await fitting.page.evaluate(() =>
    window.scrollTo({ top: 0, behavior: 'instant' }),
  );
  await fitting.page.screenshot({
    path: 'work/sponsor-browser/desktop-fitting.png',
```

insert:

```js
  // While the tailor works the card's label breathes and the swatch sits on the still;
  // with reduced motion nothing on the card moves, and the state still reads.
  receipt.look = { status: 'tailoring' };
  receipt.paidAt = Date.now();
  await fitting.page
    .locator('.sponsor-preview.cap.tailoring')
    .waitFor({ timeout: 10000 });
  const pulse = () =>
    fitting.page
      .locator('.sponsor-preview.cap .sponsor-preview-label svg')
      .evaluate((el) => getComputedStyle(el).animationName);
  const swatchStyle = () =>
    card.locator('.sponsor-logo-swatch').evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.animationName, s.position, s.objectFit];
    });
  assert.equal(await pulse(), 'sponsor-tailoring');
  assert.deepEqual(await swatchStyle(), [
    'sponsor-swatch-in',
    'absolute',
    'contain',
  ]);
  assert.equal(
    await card
      .locator('.sponsor-host-art')
      .evaluate((el) => getComputedStyle(el).filter),
    'saturate(0.72) brightness(0.94)',
  );
  await fitting.page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await pulse(), 'none');
  assert.equal((await swatchStyle())[0], 'none');
  receipt.look = { status: 'ready', url: lookUrl };
  await card.locator('.sponsor-host-art.look').waitFor({ timeout: 10000 });
  assert.equal(
    await card
      .locator('.sponsor-host-art.look')
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await fitting.page.emulateMedia({ reducedMotion: 'no-preference' });
```

- [x] **Step 2: Run test to verify it fails**

Run: `node tests/browser/sponsor-experience.mjs`
Expected: FAIL — `AssertionError` on the reveal `deepEqual`: actual `['none', '0s', '0s', 'ease', 'static']`.

- [x] **Step 3: Write minimal implementation**

In `app/sponsor.css`, after

```css
.sponsor-queue-position,
.sponsor-cap-ahead {
  font-size: 12px;
  color: #bdc7ae;
}
```

insert:

```css
/* ---- The wardrobe card. Premium motion: one curve, cubic-bezier(0.4, 0, 0.2, 1), no
   overshoot. The look and the swatch rise 12px over 400ms; the look's shadow lands 50ms
   behind it; the label breathes for 1600ms cycles while the tailor works and stops the
   moment the look is in. Reduced motion turns all three off in the block below. */
.sponsor-look-frame {
  position: relative;
}
.sponsor-logo-swatch {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 58px;
  height: 58px;
  padding: 7px;
  object-fit: contain;
  border: 1px solid #ffffff2e;
  border-radius: 8px;
  background: #f2efe8;
  box-shadow: 0 6px 16px #0007;
  z-index: 2;
  animation: sponsor-swatch-in 400ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
/* Not yet dressed: the still sits back a little so the finished look reads as the event. */
.sponsor-preview.tailoring .sponsor-host-art {
  filter: saturate(0.72) brightness(0.94);
}
.sponsor-preview.tailoring .sponsor-preview-label svg {
  color: #e2b98a;
  animation: sponsor-tailoring var(--dur-breathe) var(--ease-breathe) infinite;
}
.sponsor-host-art.look {
  position: relative;
  z-index: 1;
  box-shadow: 0 10px 24px #0007;
  animation:
    sponsor-look-in 400ms cubic-bezier(0.4, 0, 0.2, 1) both,
    sponsor-look-shadow 400ms cubic-bezier(0.4, 0, 0.2, 1) 50ms both;
}
.sponsor-look-replace {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}
.sponsor-look-replace p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #bdc7ae;
}
.sponsor-look-replace .sponsor-button {
  margin-top: 0;
}
@keyframes sponsor-look-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes sponsor-look-shadow {
  from {
    box-shadow: 0 0 0 #0000;
  }
  to {
    box-shadow: 0 10px 24px #0007;
  }
}
@keyframes sponsor-swatch-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes sponsor-tailoring {
  50% {
    opacity: 0.3;
  }
}
```

Then extend the reduced-motion block. Replace lines 1176-1188:

```css
@media (prefers-reduced-motion: reduce) {
  .sponsor-panel *,
  .sponsor-panel *::before,
  .sponsor-panel *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
  .sponsor-preview-light {
    display: none;
  }
  .sponsor-button:active {
    transform: none;
  }
}
```

with:

```css
@media (prefers-reduced-motion: reduce) {
  .sponsor-panel *,
  .sponsor-panel *::before,
  .sponsor-panel *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
  /* Covered by the rule above; named so a narrowing of it cannot bring these back. The
     look keeps its resting shadow and the still its desaturation, so the state still reads. */
  .sponsor-host-art.look,
  .sponsor-logo-swatch,
  .sponsor-preview.tailoring .sponsor-preview-label svg {
    animation: none !important;
  }
  .sponsor-preview-light {
    display: none;
  }
  .sponsor-button:active {
    transform: none;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node tests/browser/sponsor-experience.mjs`
Expected: `Browser rehearsal passed: …`. Open `work/sponsor-browser/desktop-fitting.png` and check the swatch sits bottom-right on the still and the replace block reads as one group.

- [x] **Step 5: Commit**

```bash
git add app/sponsor.css tests/browser/sponsor-experience.mjs
git commit -m "The look rises into the card; the card breathes while the tailor works

Premium motion on one curve: the look and the logo swatch rise twelve pixels
over 400 ms, the look's shadow lands 50 ms behind, the label breathes until the
look is in. Reduced motion turns all of it off and the state still reads.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-7: `docs/SPONSORSHIP.md` — promise, lifecycle, media contract

**Files:**
- Modify: `docs/SPONSORSHIP.md:3, 5 (insert after), 14, 25, 45 (+ new row), 59-63, 65, 89, 95`
- Test: grep assertions (docs have no unit test; each step names what must and must not appear)

**Interfaces:**
- Consumes: desk routes and callback headers from `CONTRACT.md`; the receipt sub-state copy from ui-1.
- Produces: nothing code-facing.

- [x] **Step 1: Write the failing check**

Run: `grep -c "POST /logo\|POST /tailor\|Dress the host\|looks-v1" docs/SPONSORSHIP.md`
Expected now: `0`.

- [x] **Step 2: Apply the exact replacements**

(a) Line 3, replace the first sentence:

```
The public sidebar sells Project spotlight ($25) and Sponsor the podcast ($100), a cap on Pepe or Chad.
```

→

```
The public sidebar sells Project spotlight ($25) and Dress the host ($100): the customer's logo printed on a T-shirt and a cap in the brand's colours, worn by Pepe or Chad for ten live minutes.
```

(b) After line 5 (`Checkout is **disabled by default**. …`) insert a blank line and this section:

```markdown
## The wardrobe: promise and lifecycle

What a Dress the host order buys, and what the site does with it:

1. **Upload.** The customer picks Pepe or Chad, names the project, writes the message and uploads a logo (PNG, JPG or WebP, ≤ 4 MB). The site checks size and magic bytes, then forwards the bytes to the media desk's `POST /logo`, which normalises the logo (background knocked out, ≤ 1024 px on the long side, RGBA PNG) and reads its ink palette. A logo the desk can never print (empty, hair-thin, undecodable) is refused with the desk's reason under the upload field, before any money moves; nothing is stored. An accepted logo becomes a `sponsor_assets` row with `status = 'logo'`, one row per (normalised logo, host), shared by every order that buys that logo on that host. No look is generated before payment.
2. **Payment.** The moment a payment settles, the site asks the desk to tailor (`POST /tailor`, round 1). The desk makes the look: one 1344×768 still of the host in a T-shirt with the logo printed large on the chest and a cap in the brand's colours, generated with fal from the host's uncropped original, judged by a pixel-drift check and a vision judge, up to three fits inside a 210-second job. Every settlement calls the site back (`PUT /api/sponsorship/assets/{id}?part=look`) with an outcome: `look`, `refused`, `deadline`, `shutdown` or `error`.
3. **Receipt.** Usually one to two minutes after paying, the receipt shows the look under YOUR ON-AIR PASS. Until then the card reads TAILORING with the host's own still and the logo as a swatch, and the copy follows the payment clock: "Tailoring your tee and cap · usually one to two minutes", past two minutes "Still tailoring — trying another fit", past ten minutes "This is taking longer than usual" with **Use a different logo**.
4. **On air.** The look is the start and end frame of every clip of that host while the sponsorship airs: ten live minutes, six clear appearances, an introduction and a callback. A take that cannot be dressed undresses that run of lines; the look returns at the next cut.
5. **Recovery.** The reconciler re-requests a round that has not landed after four minutes, up to three rounds. After three failed fits the desk falls back to the deterministic cap print (the logo baked into the blank cap's front panel) so the paid order airs; the receipt adds "We'll keep improving the fit" and offers a different logo, and one upgrade round is tried after ten minutes. Only a logo the fallback itself cannot print ends `refused`; the receipt says why and offers **Use a different logo** (`POST /api/sponsorship` with `{ action: 'replaceLogo', orderId, token, assetId }`, authenticated by the order token, allowed while the order is paid and its asset is refused, still `logo` after ten minutes, or a fallback look). There are no refunds and the order is never lost.

Asset status moves `logo → qualified | refused`, and `refused → qualified` only through a replaced logo. `LOOK_VERSION = 'looks-v1'` is what the desk reports as `templateVersion`, what the studio heartbeats as `capTemplateVersion`, and what the lease gate compares. A round costs at most about $0.47 and an asset about $1.90 in the worst case, once per logo and host; a second order for the same logo shows the existing look at once and costs nothing to tailor.
```

(c) Line 14 (the media service row):

```
| Media service (`sponsor-media-<site>` on Railway) | `SPONSOR_MEDIA_TOKEN`, `MEDIA_CONCURRENCY`, `MEDIA_QUEUE`, `PORT`, optional `SPONSOR_SITE_ORIGIN` and `WEARABLE_PYTHON` | Normalize logos, preview caps and validate/composite footage |
```

→

```
| Media service (`sponsor-media-<site>` on Railway) | `SPONSOR_MEDIA_TOKEN`, `FAL_KEY`, `SPONSOR_SITE_ORIGIN`, `MEDIA_CONCURRENCY`, `MEDIA_QUEUE`, `PORT`, optional `WEARABLE_PYTHON` | Normalize logos at upload; tailor and judge the look after payment; post it back to the site |
```

(d) Line 25, the sentence:

```
Cap sales require a qualified media worker, R2 storage, a live clip producer and payment readiness.
```

→

```
Cap sales require a media desk that reports `tailor: true` and `templateVersion: looks-v1`, R2 storage, a live clip producer and payment readiness.
```

(e) Line 45, the `SPONSOR_SITE_ORIGIN` row:

```
| | `SPONSOR_SITE_ORIGIN` | Optional. The site's origin, needed only by the legacy `/render` form that names a logo URL instead of sending the logo |
```

→

```
| | `SPONSOR_SITE_ORIGIN` | Required. The site's origin: the desk fetches the stored logo from it and posts the finished look back to it, and refuses a `/tailor` whose logo URL is anywhere else |
| | `FAL_KEY` | The desk's own fal key for tailoring; `setup` copies it from `.dev.vars`. The Worker never holds one |
```

(f) In the `GET /health` bullet (line 59), replace its last two sentences:

```
`capQualified` means the service is ready *and* the exact renderer, templates and masks the qualification proof binds are in place. The site asks at most once every 15 seconds per isolate, and the cap stays off sale unless it reads `capQualified: true`.
```

→

```
`templateVersion` is `looks-v1`, and `tailor` is true only when `FAL_KEY` and `SPONSOR_SITE_ORIGIN` are set and fal answered a HEAD within 5 seconds at boot. The site asks at most once every 15 seconds per isolate, and the cap stays off sale unless it reads `tailor: true` with that version.
```

(g) Replace the three bullets that begin ``- `POST /preview?kind=cap|logo&target=host|guest` ``, ``- `POST /render` takes a JSON body`` and `- The status of a failed render says whose fault it is` (lines 60-62) with:

```markdown
- `POST /logo?target=host|guest` takes the raw image (PNG, JPEG or WebP, 4 MiB at most) and answers within 10 seconds with the normalised RGBA PNG (base64), its SHA-256, its size and its ink palette. It is the only image codec in the system and costs nothing: no fal, no money. A logo that cannot be printed is 422 with a customer-readable code (`INVALID_IMAGE`, `EMPTY_IMAGE`, `LOGO_TOO_THIN`, `LOGO_TOO_SMALL`, `LOGO_TOO_LARGE`), which the site returns verbatim so the customer fixes the file before paying.
- `POST /tailor` takes `{ assetId, round, target, logoUrl, logoSha256, palette, projectName }`. `logoUrl` must be on `SPONSOR_SITE_ORIGIN` under `/api/sponsorship/assets/` (400 `HOST` otherwise); a body that is not JSON, a `palette` that is not the one `/logo` returned, a malformed `assetId`, `round` or `target`, or a `logoSha256` that is not hex64 are 400 `JSON | PALETTE | ASSET_ID | ROUND | TARGET | LOGO_HASH`; `round` is 1–3; without `SPONSOR_SITE_ORIGIN` and `FAL_KEY` it is 503 `TAILOR_UNAVAILABLE`. It answers 202 `{ key, queued: true }`, 200 `{ key, cached: true }` when a finished outcome for that key is in the ten-minute cache (the desk re-posts it to the site), or 409 `BUSY` with `retryAfterMs`. The key is the SHA-256 of `logoSha256|target|looks-v1|round`, so a new round uses new seeds and a repeat of an in-flight key joins the running job. Tailor jobs run in their own lane (`tailorConcurrency 2`, `tailorQueue 6`, `tailorDeadlineMs 210000`, `tailorFitMs 65000`); a fit starts only while a full fit budget remains, so a job settles inside its deadline by construction.
- The desk calls the site back itself, never a caller-supplied URL: `PUT ${SPONSOR_SITE_ORIGIN}/api/sponsorship/assets/${assetId}?part=look` with `Authorization: Bearer <SPONSOR_MEDIA_TOKEN>`, `x-look-round` and `x-look-outcome: look | refused | deadline | shutdown | error`. For `look` the body is the 1344×768 PNG with `x-look-sha256` and `x-look-verdict` (base64 JSON: model, fit, palette, garment plan, judge outputs, `candidateUrl`, `fallback?`); otherwise there is no body and `x-look-reason` says why. 20 seconds per attempt, three attempts, five seconds apart; on SIGTERM pending callbacks get 3 seconds. The site accepts `logo → qualified`, `logo → refused` and `refused → qualified`; a `qualified` asset never changes, except that a fallback look may be upgraded while no order on it is leased, prepared or playing. A `deadline`, `shutdown` or `error` outcome leaves the asset at `logo` for the reconciler to re-request.
- `POST /preview` and `POST /render` (the tracker composite) are still served but nothing calls them; they, their decoder probe and their tests are removed once the tailored path has aired on devnet.
```

(h) Line 65 (the workflow paragraph):

```
then checks that `/health` is 200 with `capQualified: true`, that `/preview` without the token is 401, and that `/preview` with it is 200.
```

→

```
then checks that `/health` is 200 with `templateVersion: looks-v1` (and `tailor: true` when the `FAL_KEY` secret is present), that `/logo` without the token is 401, and that `/logo` with it is 200.
```

(i) Line 89, the sentence:

```
The wardrobe revision is pinned into each render/cache identity; gestures that obstruct the cap are deferred.
```

→

```
Every clip of a dressed host starts and ends on the look; the look's revision is pinned into each render, a changed look drops the placement from that shot rather than retrying it, and a take that cannot be dressed undresses that run of lines until the next cut. Gestures are dropped on dressed lines.
```

(j) Before the sentence that begins `The qualification proof is …` (under `## Qualification and local verification`), insert this paragraph and a blank line:

```
The tracker and its qualification now serve only the fallback: `scripts/wearable-render.py preview` bakes the logo into the blank cap's front panel when three generative fits fail, so a paid order still airs. Qualification is not a release gate for the tailored look, and nothing below needs to be repeated to ship it; it stays here for the fallback and until `/render` and `/preview` are removed.
```

- [x] **Step 3: Verify**

Run: `grep -c "POST /logo\|POST /tailor\|Dress the host\|looks-v1" docs/SPONSORSHIP.md; grep -n "capQualified" docs/SPONSORSHIP.md`
Expected: the first prints a number ≥ 8; the second prints nothing.

- [x] **Step 4: Commit**

```bash
git add docs/SPONSORSHIP.md
git commit -m "Sponsorship operations describe the tailored tee and cap

What the customer is promised, how an asset moves from logo to look, and the
media desk contract: /logo at upload, /tailor after payment, the callback that
lands the look, and the fallback that keeps a paid order on air.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-8: `docs/LAUNCH.md` — the desk needs `FAL_KEY`; qualification is no longer a gate

**Files:**
- Modify: `docs/LAUNCH.md:61-62, 304-306, 310-311, 321, 336-339, 359-369`
- Test: grep assertions

**Interfaces:** none code-facing.

- [x] **Step 1: Write the failing check**

Run: `grep -c "tailor" docs/LAUNCH.md`
Expected now: `0`.

- [x] **Step 2: Apply the exact replacements**

(a) Lines 61-62:

```
Never set on the deployed site: `FAL_KEY`, any `NEWSDESK_*`, `INTERACT_ORIGIN`, `CHART_MINT`.
Generation happens only in the studio, and a borrowed chart is never shown to the audience.
```

→

```
Never set on the deployed site: `FAL_KEY`, any `NEWSDESK_*`, `INTERACT_ORIGIN`, `CHART_MINT`.
Generation happens only in the studio and, for a sponsor's tee and cap, on the media desk
(which holds its own `FAL_KEY`); a borrowed chart is never shown to the audience.
```

(b) Lines 304-306:

```
A cap on devnet needs three things: the devnet media service running and known to the devnet
site (see [Sponsorship services](#sponsorship-services)), a qualified logo uploaded before
payment, and ten verified minutes on air.
```

→

```
A cap on devnet needs three things: the devnet media desk running with `FAL_KEY` and
`SPONSOR_SITE_ORIGIN` and known to the devnet site (see
[Sponsorship services](#sponsorship-services)), a logo uploaded before payment (the tee and
cap are tailored right after payment, usually within one to two minutes), and ten verified
minutes on air. The tracker qualification in `public/wearables` is no longer a release gate:
it serves only the fallback print when three fits fail.
```

(c) Lines 310-311:

```
Two small services per site run next to the box on Railway. `sponsor-media-<site>` normalizes
logos, draws the cap previews and composites the paid take. `sponsor-reconcile-<site>` asks the
```

→

```
Two small services per site run next to the box on Railway. `sponsor-media-<site>` normalizes
logos at upload and, once an order is paid, tailors the look: one still of the host in the tee
and cap, judged before it airs, posted back to the site. `sponsor-reconcile-<site>` asks the
```

(d) Line 321:

```
node scripts/media.mjs health devnet   # ready and capQualified, plus the reconciler's last passes
```

→

```
node scripts/media.mjs health devnet   # ready and tailor, plus the reconciler's last passes
```

(e) Lines 337-339:

```
worker has its token, and the devnet catalog offers the cap once the site reads
`capQualified: true`. A missing value makes the workflow warn, not fail. A value that is set but
unusable (a media address that is not https, or a token too short for the worker) fails it.
```

→

```
worker has its token, and the devnet catalog offers the cap once the site reads `tailor: true`
with `templateVersion: looks-v1` ("Ready to tailor looks" from `media.mjs health`; "Up, but
FAL_KEY is missing or fal did not answer, so the cap stays off sale" otherwise). A missing value
makes the workflow warn, not fail. A value that is set but unusable (a media address that is
not https, or a token too short for the worker) fails it.
```

(f) In "Worth knowing" (lines 359-369), after the bullet that ends `To rotate a token, delete
  its line from `.dev.vars`, run `setup` and `deploy`, then give the worker the new value.` insert:

```
- `setup` also copies this machine's `FAL_KEY` and the site's origin onto the media desk as
  `FAL_KEY` and `SPONSOR_SITE_ORIGIN`. Both are required for tailoring; without them `/health`
  reports `tailor: false` and the cap stays off sale. A deploy aborts a running tailor at 100 s
  of drain; the desk's `shutdown` callback is the recovery signal and the site re-requests
  within a minute, so a collision costs at most about $0.15.
```

- [x] **Step 3: Verify**

Run: `grep -c "tailor" docs/LAUNCH.md; grep -n "capQualified" docs/LAUNCH.md`
Expected: first ≥ 8; second prints nothing.

- [x] **Step 4: Commit**

```bash
git add docs/LAUNCH.md
git commit -m "Launch runbook: the media desk needs FAL_KEY; qualification is not a gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task ui-9: `README.md` and `.dev.vars.example`

**Files:**
- Modify: `README.md:66, 118-120`
- Modify: `.dev.vars.example:113-115`
- Test: grep assertions

**Interfaces:** none code-facing.

- [x] **Step 1: Write the failing check**

Run: `grep -c "tee and cap\|tailor" README.md .dev.vars.example`
Expected now: `README.md:0` and `.dev.vars.example:0`.

- [x] **Step 2: Apply the exact replacements**

(a) `README.md` line 66, the sentence:

```
`lib/video-frames.ts` points to prepared 1344×768 references, matching the native generation canvas.
```

→

```
`lib/video-frames.ts` points to prepared 1344×768 references, matching the native generation canvas, and to the uncropped 1376×768 original of each host (`originalUrl`), which the media desk tailors a sponsor's tee and cap onto.
```

(b) `README.md` lines 118-120:

```
The premium sponsorship catalog, payment/recovery services, cap qualification and staging release
checks are documented in [Sponsorship operations](docs/SPONSORSHIP.md). New sponsorship checkout
is opt-in; keep `SPONSOR_ENABLED=false` until the staging rehearsal passes.
```

→

```
The premium sponsorship catalog, payment/recovery services, the tailored tee and cap (one still
per logo and host, made after payment and judged before it airs) and staging release checks are
documented in [Sponsorship operations](docs/SPONSORSHIP.md). New sponsorship checkout is opt-in;
keep `SPONSOR_ENABLED=false` until the staging rehearsal passes.
```

(c) `.dev.vars.example` lines 113-115:

```
# Reconciler service only: SPONSOR_ORIGIN and SPONSOR_RECONCILE_TOKEN.
# Media service only: SPONSOR_MEDIA_TOKEN, WEARABLE_PYTHON, and SPONSOR_SITE_ORIGIN for the
# legacy logo-URL render form (the site now sends the logo itself).
```

→

```
# Reconciler service only: SPONSOR_ORIGIN and SPONSOR_RECONCILE_TOKEN.
# Media service only: SPONSOR_MEDIA_TOKEN; FAL_KEY (the desk tailors a sponsor's tee and cap
# with fal, `node scripts/media.mjs setup` copies this file's FAL_KEY onto it, the Worker never
# holds one); SPONSOR_SITE_ORIGIN (required: the desk fetches the stored logo from the site and
# posts the finished look back to it); and optionally WEARABLE_PYTHON.
```

- [x] **Step 3: Verify**

Run: `grep -c "tee and cap\|tailor" README.md .dev.vars.example`
Expected: `README.md:2` (or more) and `.dev.vars.example:1` (or more).

- [x] **Step 4: Commit**

```bash
git add README.md .dev.vars.example
git commit -m "README and .dev.vars.example name the tailored tee and cap and the desk's FAL_KEY

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Section self-review against spec §4

- Copy: title, card line, description, badge (unchanged "Most value"), price (unchanged) — ui-1.
- Panel before payment: pick the character → upload (handler requires `id` and `logoUrl`; `artwork` state and the reload rebuild removed; swatch from `draft.assetId` as `?part=logo`) → card = base still + swatch + "Your tee and cap are tailored right after payment · usually one to two minutes"; refusal under the field; no look before payment — ui-4 (+ browser test).
- Receipt after payment: sub-states from `paidAt` (0–120 s / past 120 s / past 10 min with "Use a different logo"), label TAILORING with a pulse, the look fading in at 400 ms `cubic-bezier(0.4, 0, 0.2, 1)` with a 12 px rise and the shadow 50 ms behind, label YOUR ON-AIR PASS, alt "{Host} wearing your tee and cap", fallback note "We'll keep improving the fit" with the same control; card image precedence (look URL when ready, else base still + swatch, never `assetUrl` or a local upload); then the existing stages — ui-2, ui-3, ui-5, ui-6.
- `replaceLogo` with `{ action: 'replaceLogo', orderId, token, assetId }` — ui-5.
- Motion via the motion-design skill; personality and timings stated above and in ui-6.
- Docs: SPONSORSHIP.md (promise, lifecycle, media contract `/logo` + `/tailor`, `SPONSOR_SITE_ORIGIN` required), LAUNCH.md (`FAL_KEY` on the desk; qualification not a gate), README.md, .dev.vars.example — ui-7, ui-8, ui-9.
- Browser tests: base still during tailoring, look once ready (mock desk), reload during tailoring shows still + swatch, not a broken image — ui-4/ui-5/ui-6.
- Unit tests pin every new string — ui-1, ui-2, ui-3.


---

## Part E: Verification on devnet (`verify-1`)

### verify-1: The tailored wardrobe airs on devnet end to end

**Files:**
- No code. Uses `scripts/media.mjs`, `scripts/rehearsal-box.mjs`, `scripts/sponsorpay.mjs`, the devnet site `https://interdimensional-podcast-staging.leonardo-chekup.workers.dev`, and Railway service `sponsor-media-devnet`.
- Create: `docs/audits/<date>-tailored-wardrobe-rehearsal.md`

**Interfaces:**
- Consumes: everything above, deployed; `FAL_KEY` and `SPONSOR_SITE_ORIGIN` set on the desk (desk-12); the devnet site deployed from `main` with `SPONSOR_MEDIA_URL`/`SPONSOR_MEDIA_TOKEN` (already set).
- Produces: the rehearsal audit with the eight checks below, each with the order id, look sha256 and what was seen.

- [ ] **Step 1: Deploy the desk and read its health**

Run: `node scripts/media.mjs deploy` (devnet), then `node scripts/media.mjs health`
Expected: "Ready to tailor looks"; raw `/health` shows `tailor: true`, `templateVersion: 'looks-v1'`, `ready: true`.

- [ ] **Step 2: Deploy the devnet site and confirm the catalog**

Run: `gh workflow run deploy-devnet.yml --ref main -R whiteyhat/interdimensional-podcast`, wait for success, then `curl -s "$SITE/api/sponsorship?catalog=1"`
Expected: `capabilities.cap === true`, `capabilities.capTemplateVersion === 'looks-v1'`, product `cap` available at 100 cents (devnet flat price).

- [ ] **Step 3: Tailor four logos for both hosts by hand**

Upload, through the devnet panel, four PNGs (a dark wordmark on a transparent background, a light mark, a colourful mark, an 8-letter text-only wordmark) for Pepe and for GigaChad; pay each with `node scripts/sponsorpay.mjs` or a devnet Phantom.
Expected: each receipt shows "Tailoring your tee and cap" then the look within ~90 s (single fit) or within 210 s; every look reviewed by eye — the logo reads on the chest, the cap is in a brand colour, the scene is unchanged; the wordmark passes on both hosts. Record `look.sha256`, fit number and `fallback` for each.

- [ ] **Step 4: Air one dressed sponsorship for ten minutes**

Run: `node scripts/rehearsal-box.mjs on --minutes 60`, watch the devnet stream.
Expected: the character wears the tee and cap in every clip of theirs; the receipt reaches "on air" then "delivered" with 6+ appearances, intro and callback; the box log's `wardrobe-flip` count is 0 or each flip is explained in the audit.

- [ ] **Step 5: A second purchase of the same logo reuses the look**

Buy the same logo on the same host again.
Expected: the receipt shows the look immediately (`look.status: 'ready'`), the desk log shows no `/tailor` request for it, and the second order airs after the first (`capAhead` copy).

- [ ] **Step 6: Refusal, fallback and replacement**

Upload a 1-px PNG → expected: refused at upload with the desk's reason; nothing stored. Upload a logo built to fail the judge (a photo with fine text) and pay → expected: after three fits the fallback cap-v1 look airs, the receipt says "We'll keep improving the fit" and offers "Use a different logo"; use it with a clean logo → expected: the replacement look airs.

- [ ] **Step 7: Production untouched**

Run: `curl -s https://frogclench.fun/api/sponsorship?catalog=1`
Expected: `SPONSOR_ENABLED` still off (products unavailable with the existing reason), prices 500/2500/10000, no `looks-v1` anywhere on production; production D1 row counts unchanged.

- [ ] **Step 8: Write the audit and commit it**

```bash
git add docs/audits/<date>-tailored-wardrobe-rehearsal.md
git commit -m "Devnet rehearsal: the tailored wardrobe airs end to end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
