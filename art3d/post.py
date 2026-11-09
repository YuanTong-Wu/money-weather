#!/usr/bin/env python3
# post.py — final pass for the Blender renders (system Python 3 + Pillow, not Blender's Python).
# raw renders (.scratch/art3d/raw/*.png) → web/assets/3d/illustrations/<name>.png (opaque: 256-colour palette PNG,
# no dither — flat toon art survives it unchanged, ~50% smaller; *_cut RGBA: full-colour optimised PNG)
# + <name>.webp (q90, ~10× smaller again).
#   python3 art3d/post.py [name ...]
import os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, '.scratch', 'art3d', 'raw')
OUT = os.path.join(ROOT, 'web', 'assets', '3d', 'illustrations')
os.makedirs(OUT, exist_ok=True)

names = sys.argv[1:] or sorted(f[:-4] for f in os.listdir(RAW) if f.endswith('.png'))
for n in names:
    src = os.path.join(RAW, n + '.png')
    if not os.path.exists(src):
        print('skip (no raw render):', n)
        continue
    im = Image.open(src)
    if im.mode == 'RGBA':
        # transparent cut-outs: keep full colour (octree palettes shift the toon colours), just optimise
        q = im
        im.save(os.path.join(OUT, n + '.webp'), 'WEBP', quality=90, method=6)
    else:
        im = im.convert('RGB')
        q = im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        im.save(os.path.join(OUT, n + '.webp'), 'WEBP', quality=90, method=6)
    q.save(os.path.join(OUT, n + '.png'), optimize=True)
    print('POST %-16s png %7d  webp %7d' % (n, os.path.getsize(os.path.join(OUT, n + '.png')),
                                           os.path.getsize(os.path.join(OUT, n + '.webp'))))


# ---- refresh the manifest's illustration + ramp sections (glb section is owned by assets_glb.py)
import json
MAN = os.path.join(ROOT, 'web', 'assets', '3d', 'manifest.json')
try:
    man = json.load(open(MAN))
except Exception:
    man = {}
ill = {}
for f in sorted(os.listdir(OUT)):
    n, ext = os.path.splitext(f)
    if ext not in ('.png', '.webp'):
        continue
    e = ill.setdefault(n, {})
    e[ext[1:]] = 'illustrations/' + f
    e[ext[1:] + '_bytes'] = os.path.getsize(os.path.join(OUT, f))
    if ext == '.png':
        with Image.open(os.path.join(OUT, f)) as im:
            e['size'] = list(im.size)
            e['alpha'] = im.mode in ('RGBA', 'LA') or 'transparency' in im.info
    e['theme'] = 'night' if '_night' in n else 'day'
    e['use'] = 'loading screen' if n.startswith('hero') else 'tutorial card: ' + n.split('_')[1]
man['illustrations'] = ill
RD = os.path.join(ROOT, 'web', 'assets', '3d', 'ramps')
if os.path.isdir(RD):
    man['ramps'] = {f: os.path.getsize(os.path.join(RD, f)) for f in sorted(os.listdir(RD)) if f.endswith('.png')}
json.dump(man, open(MAN, 'w'), ensure_ascii=False, indent=1)
print('manifest: %d illustrations, %d ramps' % (len(ill), len(man.get('ramps', {}))))
