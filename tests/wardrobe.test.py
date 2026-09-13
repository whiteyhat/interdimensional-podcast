"""scripts/wardrobe.py: the tailor's deterministic half, on synthetic logos and the committed stills."""
import hashlib, importlib.util, json, re, subprocess, sys, tempfile, unittest
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


class JudgeTest(unittest.TestCase):
    """Calibrated on the committed stills (their sha256 are pinned in lib/video-frames.ts)."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)
        self.base = ROOT / 'public/pepe-cartoon.png'
        # The still the tailor dresses is the one lib/video-frames.ts hashes (and fal holds);
        # a regenerated still must be re-pinned there first, which is where the studio reads it.
        frames = (ROOT / 'lib/video-frames.ts').read_text()
        pinned = re.search(r"host: \{[\s\S]*?originalSha256:\s*'([a-f0-9]{64})'", frames).group(1)
        self.assertEqual(hashlib.sha256(self.base.read_bytes()).hexdigest(), pinned)
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


if __name__ == '__main__':
    unittest.main()
