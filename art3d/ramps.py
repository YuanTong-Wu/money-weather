# ramps.py — toon gradient ramps, rim/atmosphere ramps and temperature band strips (§17, §22).
# All 1-pixel-high strips; sample with NearestFilter. Run:
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P art3d/ramps.py
#
# toon_ramp_{day,night}.png        3 bands (shadow / mid / lit), LINEAR multipliers, shadows lean cool 藍.
#                                  For THREE.MeshToonMaterial.gradientMap (u = N·L*0.5+0.5). Keep colorSpace = NoColorSpace.
# toon_ramp_cloud_{day,night}.png  2 bands (shade / lit) for clouds; shade ratio = cloud_shade / cloud of the theme.
# rim_{day,night}.png              RGBA, u = 1 − |N·V| on the planet surface: transparent → one crisp thin rim band.
# atmo_{day,night}.png             RGBA, u = 1 − |N·V| on a slightly larger BackSide shell: flat 2-step toon halo (no glow).
# temp_bands_{day,night}.png       9×1 sRGB band colours (藍→浅葱→生成り→山吹→柿→朱), same as planet/theme.js.
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import mw_lib as M

OUT = os.path.join(M.OUT3D, 'ramps')
os.makedirs(OUT, exist_ok=True)
W = 256
# Blender illustration thresholds (cosine of the light angle): shadow < 0.035 ≤ mid < 0.30 ≤ lit
T_SH, T_MID = 0.5 + 0.035 * 0.5, 0.5 + 0.30 * 0.5
T_CLOUD = 0.5 + 0.12 * 0.5


def save(name, px, w, h, alpha):
    img = bpy.data.images.new(name, w, h, alpha=alpha, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    flat = []
    for p in px:
        flat.extend(p)
    img.pixels.foreach_set(flat)
    path = os.path.join(OUT, name + '.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    print('RAMP', name, os.path.getsize(path))


def lin_ratio(mul_srgb):
    return tuple(m ** 2.2 for m in mul_srgb)


def ratio(base, shade):
    b, s = M.lin(base), M.lin(shade)
    return tuple(min(1.0, s[i] / max(b[i], 1e-6)) for i in range(3))


for th in ('day', 'night'):
    P = M.PAL[th]
    # (the palette dropped shade_tint / mid_tint for the per-band shadow table: derive the multipliers from the
    # neutral band, kinari 生成り, and its hand-picked shadow; mid = 72 % of the way back to lit, as in the planet)
    if 'shade_tint' in P:
        sh, md = lin_ratio(P['shade_tint']), lin_ratio(P['mid_tint'])
    else:
        sh = ratio(P['bands'][4], P['band_shade'][4])
        md = tuple(s + (1.0 - s) * 0.72 for s in sh)
    px = []
    for i in range(W):
        u = (i + 0.5) / W
        c = sh if u < T_SH else (md if u < T_MID else (1.0, 1.0, 1.0))
        px.append(c + (1.0,))
    save('toon_ramp_' + th, px, W, 1, False)

    cs = ratio(P['cloud'], P['cloud_shade'])
    px = [((cs if (i + 0.5) / W < T_CLOUD else (1.0, 1.0, 1.0)) + (1.0,)) for i in range(W)]
    save('toon_ramp_cloud_' + th, px, W, 1, False)

    # rim on the planet itself (straight alpha, sRGB colour)
    rc = M.hex2srgb(P['rim'])
    px = []
    for i in range(W):
        u = (i + 0.5) / W
        a = 0.0
        if 0.80 <= u < 0.93:
            a = 0.55 if th == 'day' else 0.45
        elif u >= 0.93:
            a = 0.30 if th == 'day' else 0.25
        px.append(rc + (a,))
    save('rim_' + th, px, W, 1, True)

    # flat toon atmosphere ring on a BackSide shell (radius ≈ 1.06 × planet)
    ac = M.hex2srgb('#cfe0dc' if th == 'day' else '#33466e')
    px = []
    for i in range(W):
        u = (i + 0.5) / W
        a = 0.0
        if 0.55 <= u < 0.86:
            a = 0.30 if th == 'day' else 0.34
        elif 0.86 <= u < 0.97:
            a = 0.15 if th == 'day' else 0.18
        px.append(ac + (a,))
    save('atmo_' + th, px, W, 1, True)

    save('temp_bands_' + th, [M.hex2srgb(h) + (1.0,) for h in P['bands']], 9, 1, False)
