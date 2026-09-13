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
