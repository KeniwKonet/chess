"""Builds tools/atlas512.png from the KayKit atlas: downsized to 512px, with the
grass swatch shifted from yellow-olive toward a fresher green (art direction).
Only the grass swatch (x 0-127, y 512-767 in the 1024 atlas) is changed.

  python3 tools/make-atlas.py [path-to-hexagons_medieval.png]
"""
import sys, colorsys
from PIL import Image
src = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/vendor/hex/addons/kaykit_medieval_hexagon_pack/Textures/hexagons_medieval.png'
im = Image.open(src).convert('RGB')
px = im.load()
for y in range(512, 768):
    for x in range(0, 128):
        r, g, b = (c / 255 for c in px[x, y])
        h, s, v = colorsys.rgb_to_hsv(r, g, b)
        h = (h + 22 / 360) % 1.0
        s *= 0.78
        v = min(1.0, v * 1.02)
        px[x, y] = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h, s, v))
im.resize((512, 512), Image.LANCZOS).save(sys.argv[2] if len(sys.argv) > 2 else 'tools/atlas512.png', optimize=True)
print('ok')
