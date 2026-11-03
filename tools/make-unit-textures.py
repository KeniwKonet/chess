"""Recolours the KayKit character team colour into Sun gold and Moon blue.

Knight: the red swatches (cape, shield, emblem). Rogue: the green swatches
(tunic, cape). Barbarian: the steel-blue swatches. Mage: the purple robe
(main team colour) and magenta trim (a second team accent). Skin, hair, leather and metal are untouched (hue bands are
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
# Mage trim (magenta) becomes a second, contrasting team accent.
ACCENT = {'sun': (8 / 360, 0.9, 1.0), 'moon': (188 / 360, 0.8, 1.0)}
def is_team(char, h, s, v):
    deg = h * 360
    if char == 'knight':
        return s > 0.45 and (deg < 12 or deg > 330)
    if char == 'barbarian':
        return s > 0.28 and v > 0.3 and 185 < deg < 225
    if char == 'mage':
        return s > 0.25 and v > 0.22 and 225 < deg < 285
    return s > 0.3 and 85 < deg < 200  # rogue greens and the teal shade beneath them
def is_accent(char, h, s, v):
    return char == 'mage' and s > 0.45 and 300 < h * 360 < 350
for char in ('knight', 'rogue', 'barbarian', 'mage'):
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
                    ns, nv = min(1, s * ss), min(1, v * vs)
                    if char in ('barbarian', 'mage'):
                        # Their team colours are muted; push them to a clear gold or royal blue.
                        ns = max(ns, 0.72 if side == 'sun' else 0.6)
                        nv = min(1, max(nv * (1.5 if side == 'sun' else 1.15), 0.62 if side == 'sun' else 0.42))
                    px[x, y] = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(th, ns, nv))
                elif is_accent(char, h, s, v):
                    ah, asat, av = ACCENT[side]
                    px[x, y] = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(ah, min(1, s * asat), min(1, v * av)))
        im.resize((512, 512), Image.LANCZOS).save(os.path.join(out, f'{char}_{side}.png'), optimize=True)
        print('wrote', f'{char}_{side}.png')
