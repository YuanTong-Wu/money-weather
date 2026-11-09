# assets_glb.py — low-poly toon meshes for the live three.js planet (§22):
#   5 toon clouds, 1 storm cloud, 1 lightning bolt, 1 主航道 arrow head  →  web/assets/3d/*.glb
# Each glb holds two meshes: "<name>" (unlit body, 2-tone baked as a COLOR_0 multiplier × material colour)
# and "<name>_ink" (inverted-hull outline: reversed winding, single-sided, unlit ink).
# Run:  /Applications/Blender.app/Contents/MacOS/Blender -b -P art3d/assets_glb.py
import os, sys, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector
import mw_lib as M

D, N = M.PAL['day'], M.PAL['night']
# the one canonical key light (mw_lib.LIGHT_VIEW = planet3d/core.js LIGHT), view space → Blender world
# (x right, view-up = +Z, toward the viewer = −Y)
LIGHT = Vector((M.LIGHT_VIEW[0], -M.LIGHT_VIEW[2], M.LIGHT_VIEW[1])).normalized()
manifest = {'generated_by': 'art3d/assets_glb.py', 'units': 'glTF metres, +Y up',
            'light_dir_baked': [LIGHT.x, LIGHT.z, -LIGHT.y], 'assets': {}}


def ratio(base, shade):
    b, s = M.lin(base), M.lin(shade)
    return tuple(min(1.0, s[i] / max(b[i], 1e-6)) for i in range(3)) + (1.0,)


def finish(bm, name, tones, base, ink, hull_w, coll):
    """bm already tone-tagged; tones: {face_index: rgba multiplier}"""
    ob = M.bm_to_obj(bm, name, coll, smooth=True)
    M.set_corner_colors(ob.data, [tones[i] for i in range(len(ob.data.polygons))])
    M.assign(ob, M.unlit_export_mat(name + '_mat', base, use_vcol=True, cull=True))
    return ob


def make_cloud(kind, name, base, shade, t=0.30, seg=14, rings=8, hull_w=0.014, seed=0):
    coll = M.coll(name)
    bm = M.cloud_bmesh(kind, seg=seg, rings=rings, seed=seed, adaptive=True)
    # normalise: width 1.0, base at y=0 (glTF)
    xs = [v.co.x for v in bm.verts]
    s = 1.0 / (max(xs) - min(xs))
    for v in bm.verts:
        v.co *= s
    bm.normal_update()
    hull = M.hull_bmesh(bm, hull_w)
    lit, _ = M.tone_cut(bm, LIGHT, t)
    shade_mul = ratio(base, shade)
    tones = {}
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        tones[f.index] = (1, 1, 1, 1) if (lit[f] and f.normal.z > -0.99) else shade_mul
    body = finish(bm, name, tones, base, None, hull_w, coll)
    ink = M.bm_to_obj(hull, name + '_ink', coll, smooth=True)
    M.assign(ink, M.unlit_export_mat(name + '_ink_mat', D['ink'], use_vcol=False, cull=True))
    dims = [body.dimensions.x, body.dimensions.z, body.dimensions.y]
    return body, ink, dims, len(body.data.polygons) + len(ink.data.polygons)


def make_prism(name, outline, thick, base, mids, axis, bevel, hull_w, case_col, classify):
    coll = M.coll(name)
    bm = M.extrude_outline(outline, thick, axis=axis, bevel=bevel)
    hull = M.hull_bmesh(bm, hull_w)
    # flat shading for crisp facets on the body
    tones = {}
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        tones[f.index] = classify(f.normal, mids)
    ob = M.bm_to_obj(bm, name, coll, smooth=False)
    M.set_corner_colors(ob.data, [tones[i] for i in range(len(ob.data.polygons))])
    M.assign(ob, M.unlit_export_mat(name + '_mat', base, use_vcol=True, cull=True))
    ink = M.bm_to_obj(hull, name + '_ink', coll, smooth=False)
    M.assign(ink, M.unlit_export_mat(name + '_ink_mat', case_col, use_vcol=False, cull=True))
    dims = [ob.dimensions.x, ob.dimensions.z, ob.dimensions.y]
    return ob, ink, dims, len(ob.data.polygons) + len(ink.data.polygons)


def save(objs, fname, kind, dims, tris, day, night, note):
    path = os.path.join(M.OUT3D, fname)
    size, j = M.export_glb(objs, path)
    manifest['assets'][fname] = dict(kind=kind, bytes=size, tris=tris,
                                      nodes={'body': objs[0].name, 'ink': objs[1].name},
                                      size=[round(x, 3) for x in dims], day=day, night=night, note=note)
    print('GLB', fname, size, 'bytes', tris, 'tris', j.get('extensionsUsed'))


M.reset()
clouds = [('cumulus_a', 'cloud_1'), ('stratus_b', 'cloud_2'), ('tower_c', 'cloud_3'),
          ('puff_d', 'cloud_4'), ('drift_e', 'cloud_5')]
SEGS = {'stratus_b': (12, 7), 'drift_e': (13, 8)}
for i, (kind, name) in enumerate(clouds):
    sg, rg = SEGS.get(kind, (14, 8))
    b, k, dims, tris = make_cloud(kind, name, D['cloud'], D['cloud_shade'], seg=sg, rings=rg, seed=i)
    save([b, k], name + '.glb', 'cloud', dims, tris,
         {'body': D['cloud'], 'ink': D['ink']}, {'body': N['cloud'], 'ink': N['ink']},
         'Polymarket / sky cloud. Origin = centre of the flat base; width 1. Place base slightly above the surface, +Y along the normal.')

b, k, dims, tris = make_cloud('storm', 'storm_cloud', D['storm'], D['storm_shade'], t=0.36, seg=11, rings=7, hull_w=0.010, seed=7)
save([b, k], 'storm_cloud.glb', 'storm', dims, tris,
     {'body': D['storm'], 'ink': D['ink']}, {'body': N['storm'], 'ink': N['ink']},
     'Storm (storm>=0.8). Origin = base centre; hang bolt_*.glb under the base, rain strokes from the base down.')


def classify_bolt(n, mids):
    return (1, 1, 1, 1) if abs(n.y) > 0.7 else mids


bolt_shade = ratio(D['bolt'], D['bolt_shade'])
b, k, dims, tris = make_prism('bolt', [(x * 1.0, y * 1.0) for x, y in M.bolt_outline()], 0.10, D['bolt'],
                              bolt_shade, 'Y', 0.0, 0.028, D['ink'], classify_bolt)
save([b, k], 'bolt.glb', 'lightning', dims, tris,
     {'body': D['bolt'], 'ink': D['ink']}, {'body': N['bolt'], 'ink': N['ink']},
     'One crisp zig-zag. Origin at the top of the bolt, points down (−Y), faces +Z. Billboard it (face the camera).')


def classify_arrow(n, mids):
    top, mid, side = mids
    if n.z > 0.9:
        return top
    if n.z > 0.2:
        return mid
    return side


chan_mid = ratio(D['chan'], M.tint(D['chan'], (0.86, 0.88, 0.92)))
chan_side = ratio(D['chan'], M.tint(D['chan'], (0.62, 0.66, 0.74)))
b, k, dims, tris = make_prism('arrow_head', M.arrow_outline(), 0.16, D['chan'],
                              ((1, 1, 1, 1), chan_mid, chan_side), 'Z', 0.035, 0.045, D['chan_case'], classify_arrow)
save([b, k], 'arrow_head.glb', 'channel', dims, tris,
     {'body': D['chan'], 'ink': D['chan_case']}, {'body': N['chan'], 'ink': N['chan_case']},
     '主航道 head. Origin = middle of the back edge; tip at +Z (length 1, width 1.04, thickness 0.16); +Y = up '
     '(surface normal). Fits a tube of radius ~0.13 (scale both together). "_ink" is the paper casing (chanCase).')

mp = os.path.join(M.OUT3D, 'manifest.json')
try:
    old = json.load(open(mp))
    for k in ('ramps', 'illustrations'):         # written by ramps.py / post.py — keep them
        if k in old:
            manifest[k] = old[k]
except Exception:
    pass
json.dump(manifest, open(mp, 'w'), ensure_ascii=False, indent=1)
print('MANIFEST written')
