"""
Fixtures for test/qr.test.ts — QR codes made by an INDEPENDENT encoder
(segno 1.6.6, https://github.com/heuer/segno), so the decoder is tested
against someone else's reading of ISO/IEC 18004, not against itself.

    pip install segno==1.6.6 pillow numpy
    python test/fixtures/qr/generate.py

writes:
  symbols.json   — module matrices (hex rows) with their text, version and
                   level: every version 1–10 at every level, then 15, 20, 25,
                   30, 35, 40; numeric, alphanumeric, byte (UTF-8) and mixed
  receipt-*.png  — one Austrian till receipt code (RKSV, as tests build it),
                   photographed badly on purpose: rotated, in perspective,
                   under a shadow, and small and blurred
"""
import json
import math
import os

import numpy as np
import segno
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SIG = 'k2lVUXZ6/9WC/YIM3gl1n3z2YljGcJKuvufYvCUiiYdpCo8LWGdNdPMIhQP4D4bt+oGDdRwwrFjYzPMfxYTK8g=='
RECEIPT = '_R1-AT1_GASTHAUS-1_4711_2026-10-05T12:31:05_23,40_4,80_0,00_0,00_0,00_lHZnU+ICvLM=_-3667961875706356849_cg8hNU5ihto=_' + SIG


def matrix(qr):
    return [[1 if v else 0 for v in row] for row in qr.matrix]


def hexrows(m):
    out = []
    for row in m:
        bits = ''.join(str(b) for b in row)
        bits += '0' * (-len(bits) % 4)
        out.append(''.join('%x' % int(bits[i:i + 4], 2) for i in range(0, len(bits), 4)))
    return out


def texts(version):
    return [
        '0815' * (version * 3),
        'MOD-11 TIME TRACKING ' * version,
        'Grüße aus Wien — Spesen %d ' % version * version,
    ]


symbols = []
levels = 'LMQH'
plan = [(v, lv) for v in range(1, 11) for lv in levels] + [(15, 'M'), (20, 'Q'), (25, 'L'), (30, 'H'), (35, 'M'), (40, 'L')]
for n, (version, level) in enumerate(plan):
    # Fill the symbol: the longest text of this kind that still fits the version.
    base = texts(version)[n % 3]
    text = base
    while True:
        try:
            qr = segno.make_qr(text, version=version, error=level.lower(), boost_error=False)
            break
        except segno.DataOverflowError:
            text = text[: max(1, int(len(text) * 0.8))]
    symbols.append({'text': text, 'version': qr.version, 'level': qr.error.upper(), 'mask': qr.mask, 'rows': hexrows(matrix(qr))})

with open(os.path.join(HERE, 'symbols.json'), 'w', encoding='utf-8') as f:
    json.dump({'generator': 'segno ' + segno.__version__, 'symbols': symbols}, f, ensure_ascii=False, separators=(',', ':'))

# ── The receipt, photographed ────────────────────────────────────────────
qr = segno.make_qr(RECEIPT, error='m')
m = np.array(matrix(qr), dtype=np.uint8)
quiet = 4
scale = 6
size = (m.shape[0] + 2 * quiet) * scale
clean = np.full((size, size), 255, dtype=np.uint8)
for y in range(m.shape[0]):
    for x in range(m.shape[1]):
        if m[y, x]:
            clean[(y + quiet) * scale:(y + quiet + 1) * scale, (x + quiet) * scale:(x + quiet + 1) * scale] = 30
paper = Image.fromarray(clean, 'L')


def canvas(img, pad=60):
    out = Image.new('L', (img.width + 2 * pad, img.height + 2 * pad), 236)
    out.paste(img, (pad, pad))
    return out


def save(img, name):
    img.save(os.path.join(HERE, name), optimize=True)


save(canvas(paper), 'receipt-clean.png')
save(canvas(paper).rotate(17, resample=Image.BICUBIC, fillcolor=236, expand=True).filter(ImageFilter.GaussianBlur(0.8)), 'receipt-rotated.png')

w, h = canvas(paper).size
# Taken from below and to the left: the far edge shrinks.
src = [(0, 0), (w, 0), (w, h), (0, h)]
dst = [(w * 0.12, h * 0.05), (w * 0.95, h * 0.16), (w * 0.88, h * 0.9), (w * 0.02, h * 0.98)]


def coeffs(source, target):
    a = []
    for (x, y), (u, v) in zip(target, source):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    return np.linalg.solve(np.array(a, dtype=float), np.array(source, dtype=float).reshape(8))


persp = canvas(paper).transform((w, h), Image.PERSPECTIVE, tuple(coeffs(src, dst)), Image.BICUBIC, fillcolor=236)
save(persp.filter(ImageFilter.GaussianBlur(0.6)), 'receipt-perspective.png')

# A shadow from the left: the darkest light is darker than the lightest dark.
arr = np.asarray(canvas(paper), dtype=float)
ramp = np.linspace(0.35, 1.0, arr.shape[1])[None, :]
shade = Image.fromarray(np.clip(arr * ramp + 10, 0, 255).astype(np.uint8), 'L')
save(shade.filter(ImageFilter.GaussianBlur(1.0)), 'receipt-shadow.png')

# Small: about 2.6 pixels a module, softened.
small = canvas(paper).resize((int(w * 0.44), int(h * 0.44)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(0.5))
save(small, 'receipt-small.png')

print('symbols:', len(symbols), 'receipt version:', qr.version, qr.error)
