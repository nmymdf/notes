"""Generate the Android launcher icons and splash screens for DeskNotes.

Draws the same icon as build/icon.png (orange rounded square with a note page)
at every density, without external dependencies. Run from the repo root:
    python3 scripts/android-icons.py
"""
import os
import struct
import zlib

RES = 'android/app/src/main/res'
ORANGE = (255, 176, 32, 255)
PAGE = (245, 245, 245, 255)
DARK = (40, 40, 40, 255)
LINE = (90, 90, 90, 255)
CLEAR = (0, 0, 0, 0)
BLACK = (0, 0, 0, 255)


def write_png(path, w, h, pixel):
    raw = b''.join(b'\x00' + bytes(c for x in range(w) for c in pixel(x, y)) for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    return struct.unpack('>II', head[16:24])


def page(u, v):
    """The note page in unit coords (0..1 of the icon), or None outside it."""
    if 0.22 <= u < 0.78 and 0.17 <= v < 0.83:
        if 0.31 <= u < 0.59 and 0.23 <= v < 0.28:
            return DARK
        for top, right in ((0.36, 0.69), (0.48, 0.69), (0.60, 0.55)):
            if top <= v < top + 0.04 and 0.31 <= u < right:
                return LINE
        return PAGE
    return None


def icon_pixel(u, v, round_shape):
    """Full icon: rounded (or circular) orange background with the page."""
    if round_shape:
        if (u - 0.5) ** 2 + (v - 0.5) ** 2 > 0.25:
            return CLEAR
    else:
        r, m = 0.19, 0.03
        cu, cv = min(max(u, m + r), 1 - m - r), min(max(v, m + r), 1 - m - r)
        if u < m or v < m or u >= 1 - m or v >= 1 - m or (u - cu) ** 2 + (v - cv) ** 2 > r * r:
            return CLEAR
    return page(u, v) or ORANGE


DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}

for name, k in DENSITIES.items():
    d = f'{RES}/mipmap-{name}'
    s = round(48 * k)
    write_png(f'{d}/ic_launcher.png', s, s, lambda x, y: icon_pixel(x / s, y / s, False))
    write_png(f'{d}/ic_launcher_round.png', s, s, lambda x, y: icon_pixel(x / s, y / s, True))
    # Adaptive icon foreground: 108dp canvas, artwork inside the 72dp safe zone.
    f = round(108 * k)
    scale = 72 / 108
    off = (1 - scale) / 2
    write_png(f'{d}/ic_launcher_foreground.png', f, f,
              lambda x, y: page((x / f - off) / scale, (y / f - off) / scale) or CLEAR)

with open(f'{RES}/values/ic_launcher_background.xml', 'w') as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
             '    <color name="ic_launcher_background">#FFB020</color>\n</resources>\n')

# Splash screens: black with the icon in the middle (keeps each file's size).
for root, _, files in os.walk(RES):
    for fn in files:
        if fn == 'splash.png':
            p = os.path.join(root, fn)
            w, h = png_size(p)
            size = min(w, h) * 0.28
            x0, y0 = (w - size) / 2, (h - size) / 2

            def splash(x, y):
                u, v = (x - x0) / size, (y - y0) / size
                if 0 <= u < 1 and 0 <= v < 1:
                    px = icon_pixel(u, v, False)
                    if px[3]:
                        return px
                return BLACK
            write_png(p, w, h, splash)
print('icons and splash screens written')
