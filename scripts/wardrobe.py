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


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['normalize', 'judge', 'zones'])
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--base')
    parser.add_argument('--candidate')
    parser.add_argument('--target', choices=['host', 'guest'])
    parser.add_argument('--palette')
    args = parser.parse_args(argv)
    try:
        if args.mode == 'zones':
            result = {'ok': True, 'zones': ZONES, 'wearers': WEARERS, 'pad': ZONE_PAD}
        elif args.mode == 'judge':
            result = judge(args.base, args.candidate, args.target, json.loads(Path(args.palette).read_text()), args.output)
        else:
            image = normalize(args.input)
            data = encode_png(image, args.output)
            result = {'ok': True, 'sha256': sha256(data), 'width': int(image.shape[1]), 'height': int(image.shape[0]), 'palette': palette(image)}
    except Refusal as refusal:
        result = {'ok': False, 'code': refusal.code, 'message': refusal.message}
    except Exception as error:  # a crash is this machine's fault, never a verdict on the logo
        print(json.dumps({'ok': False, 'code': 'CRASH', 'message': str(error)[:300]}))
        return 2
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
