"""Recolours the KayKit character team colour into Sun gold and Moon blue.

Knight: the red swatches (cape, shield, emblem). Rogue: the green swatches
(tunic, cape). Skin, hair, leather and metal are untouched (hue bands are
chosen to skip skin and brown tones). Output: 512 px PNGs in
apps/web/public/assets/units/.

  python3 tools/make-unit-textures.py [path-to-adventurers-pack]
"""
import sys, os, colorsys
from PIL import Image
root = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/vendor/adv/addons/kaykit_character_pack_adventures'
out = os.path.join(os.path.dirname(__file__), '..', 'apps', 'web', 'public', 'assets', 'units')
os.makedirs(out, exist_ok=True)
TARGET = {'sun': (42 / 360, 0.80, 1.05), 'moon': (214 / 360, 0.72, 0.95)}  # hue, saturation scale, value scale
def is_team(char, h, s, v):
    deg = h * 360
    if char == 'knight':
        return s > 0.45 and (deg < 12 or deg > 330)
    return s > 0.3 and 85 < deg < 200  # rogue greens and the teal shade beneath them
for char in ('knight', 'rogue'):
    src = Image.open(os.path.join(root, 'Textures', f'{char}_texture.png')).convert('RGB')
    for side, (th, ss, vs) in TARGET.items():
        if char == 'rogue' and side == 'sun':
            ss, vs = 0.85, 1.55  # the rogue's green is dark; gold needs lifting to read as gold
        im = src.copy()
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                r, g, b = (c / 255 for c in px[x, y])
                h, s, v = colorsys.rgb_to_hsv(r, g, b)
                if is_team(char, h, s, v):
                    px[x, y] = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(th, min(1, s * ss), min(1, v * vs)))
        im.resize((512, 512), Image.LANCZOS).save(os.path.join(out, f'{char}_{side}.png'), optimize=True)
        print('wrote', f'{char}_{side}.png')
