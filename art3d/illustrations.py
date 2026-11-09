# illustrations.py — pre-rendered illustrations in the app's 3D look (§17 日式干净卡通，但不幼稚; §22):
# EEVEE + toon (Shader-to-RGB constant ramps) + a little Freestyle ink. Output → web/assets/3d/illustrations/.
#   hero_day.png / hero_night.png   1600×1000  loading screen: planet + clouds + 主航道 arc
#   tut_temp.png   颜色 = 温度             tut_wind.png   风线 = 钱在搬家
#   tut_pres.png   挤 / 空 = 人多人少        tut_storm.png  雨 = 风暴，锋线 = 风向刚变
#   tut_season.png 季节 春夏秋冬              tut_zoom.png   点进去 = 飞进去
# Run all:   /Applications/Blender.app/Contents/MacOS/Blender -b -P art3d/illustrations.py
# Run some:  ... -P art3d/illustrations.py -- hero_day tut_wind
#
# v2 grammar (same rules as the live planet, so the cards teach the object the owner actually sees):
# - each territory is ONE flat paper colour (its temperature band); 朱 / deep 藍 only for the true extremes;
# - plates stand up by |wind| (volume = money on the move, in OR out; the receiving plate tallest); the hero
#   shows the live globe exactly: a continent of plates on a cap of the sphere, a calm paper sea around it
#   (build_planet(sea=…)), real heights with no limb fade; close-up cards keep their limb fade (horizon views);
# - inner borders = one uniform ~1.3 px paper hairline with clean joints; ink ONLY on the planet silhouette;
# - shadows use the hand-picked band shadow table (PAL.band_shade): richer, never grey, never violet;
# - one canonical key light (mw_lib.LIGHT_VIEW, camera-relative) for planet, clouds and the glb bakes;
# - clouds: 2-tone per lobe from each lobe's own normal (no lobe-on-lobe cast-shadow "fans");
# - wind = a few long tapered strokes (thin tail, thick round head) that stop at the receiving plate's edge;
# - fronts = flat weather-map decals (若竹 semicircles = money starts flowing in, 臙脂 triangles = starts leaving);
# - bolt = the app's flat zig-zag (pale 山吹 + 1.5 px ink), rain = 12 short parallel strokes under the cloud.
import os, sys, math, random, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector, Matrix, Quaternion
import mw_lib as M

OUT = os.path.join(M.OUT3D, 'illustrations')        # final (post.py writes here)
RAW = os.path.join(M.SCRATCH, 'raw')                  # Blender's straight renders
os.makedirs(OUT, exist_ok=True)
os.makedirs(RAW, exist_ok=True)
FONT = '/System/Library/Fonts/STHeiti Medium.ttc'

LIGHT = Vector((-0.6, -0.6, 0.5)).normalized()       # world key light, set per scene from the camera (setup)
CHAN_KEY = Vector((-0.35, -0.80, 0.50)).normalized()  # 主航道's own soft key (camera-relative too)


# =============================================================================== building blocks
def setup(w, h, theme, cam_loc, target, lens, shift=(0, 0), samples=32):
    global LIGHT, CHAN_KEY
    M._TOON_CACHE.clear()
    M.reset(w, h, transparent=False, samples=samples)
    sc = bpy.context.scene
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.image_settings.compression = 100
    cam = M.add_camera(cam_loc, target, lens=lens, shift=shift)
    bpy.context.view_layer.update()
    P = M.PAL[theme]
    M.backdrop(cam, P['sky0'], P['sky1'])
    LIGHT = M.view_light(cam)
    CHAN_KEY = (cam.matrix_world.to_3x3() @ Vector((-0.3, 0.45, 0.85))).normalized()
    M.add_sun(-LIGHT, angle_deg=0.4)
    for n in ('planet', 'ink', 'chan', 'soft', 'fine', 'thermo', 'bolt'):
        M.coll(n)
    return cam


def ink_sets(theme, scale=1.0, extra=None):
    P = M.PAL[theme]
    sets = [
        dict(name='ink', collection=M.coll('ink'), color=P['ink'], thickness=2.0 * scale,
             types=('silhouette', 'border', 'crease'), calligraphy=(1.3 * scale, 2.4 * scale)),
        dict(name='fine', collection=M.coll('fine'), color=P['ink'], thickness=1.25 * scale,
             types=('silhouette', 'border', 'crease')),
        dict(name='bolt', collection=M.coll('bolt'), color=P['bolt_line'], thickness=1.5 * scale,
             types=('border', 'silhouette')),
    ]
    if extra:
        sets += extra
    M.freestyle_setup(sets)


def cam_vectors(cam=None):
    cam = cam or bpy.context.scene.camera
    R = cam.matrix_world.to_3x3()
    return R @ Vector((1, 0, 0)), R @ Vector((0, 1, 0)), R @ Vector((0, 0, 1))     # right, up, back


def screen_to_world(px, py, depth_pt):
    """pixel (x right, y down) → world point on the camera-facing plane through depth_pt."""
    sc = bpy.context.scene
    cam = sc.camera
    fr = cam.data.view_frame(scene=sc)
    tr, br, bl, tl = [cam.matrix_world @ p for p in fr]
    o = cam.matrix_world.translation
    u, v = px / sc.render.resolution_x, 1 - py / sc.render.resolution_y
    p = bl + (br - bl) * u + (tl - bl) * v
    d = (p - o).normalized()
    _, _, back = cam_vectors(cam)
    t = (Vector(depth_pt) - o).dot(-back) / d.dot(-back)
    return o + d * t


def band_of(t):
    return max(0, min(8, sum(1 for e in M.BAND_EDGES if t >= e)))


def plate_mats(theme, band):
    P = M.PAL[theme]
    base, sh = P['bands'][band], P['band_shade'][band]
    top = M.toon_mat('top%d' % band, base, theme, rim=True, shade=sh, bands=2, t_shadow=0.035,
                     rim_w=0.86, rim_strength=0.45)
    wall = M.toon_mat('wall%d' % band, M.mixs(base, sh, 0.6), theme, rim=False,
                      shade=M.mixs(sh, P['band_shade'][0], 0.10), bands=2, t_shadow=0.035)
    return top, wall


def weighted_seeds(n, seed, wmax=0.22, iters=2):
    rng = random.Random(seed)
    pts = M.lloyd(M.random_sphere(n, seed), iters)
    ws = [wmax * rng.random() ** 2.2 for _ in pts]
    return pts, ws


def build_planet(theme, cam_loc, seeds, weights, temp_fn, h_fn=None, loc=(0, 0, 0), radius=1.0, coll_name='planet',
                 line_px=1.3, outline_px=2.6, limb=(0.26, 0.46), overrides=None, r_fn=None, step=0.012, rings=6,
                 hairline=True, sea=None):
    """flat paper-plate planet. temp_fn(c, i) → temperature (−3…3); h_fn(c, i, t) → plate height (fraction of
    radius). overrides: {i: (temp, height)}. r_fn(dir) → base radius (relief, tut_pres). limb=None: no limb fade.
    sea=(pole, cap_rad): cells whose centre lies beyond the cap are calm paper sea (flush, no hairlines between
    them; a coast line where land meets sea) — the live globe's continent-on-a-sea look. Returns the cell info."""
    P = M.PAL[theme]
    col = M.coll(coll_name)
    loc, cam_loc = Vector(loc), Vector(cam_loc)
    base_fn = r_fn or (lambda d: 1.0)
    cells = M.sphere_voronoi(seeds, weights)
    # soft paper-cut borders like the live layout (shared edges stay shared); poly0 keeps the convex cell
    rmean = math.sqrt(4.0 / max(1, len(cells)))
    cells = M.wobble_cells(cells, amp=0.15 * rmean, freq=0.85 / rmean, step=0.016, seed=len(cells) % 17)

    def facing(d):
        p = loc + d * radius * base_fn(d)
        return Vector(d).dot((cam_loc - p).normalized())

    info = []
    for i, (c, poly, poly0) in enumerate(cells):
        x = dict(i=i, c=c, poly=poly, poly0=poly0, t=temp_fn(c, i))
        x['h'] = h_fn(c, i, x['t']) if h_fn else 0.0
        info.append(x)
    for i, (t, h) in (overrides or {}).items():
        info[i]['t'], info[i]['h'] = t, h
    if sea:
        pole, cap = Vector(sea[0]).normalized(), sea[1]
        for x in info:
            x['sea'] = x['c'].angle(pole) > cap
            if x['sea']:
                x['h'] = 0.0
    for x in info:
        x['band'] = band_of(x['t'])
        x['facing'] = facing(x['c'])
        x['fmin'] = min(facing(v) for v in x['poly'])
        x['h'] = x['h'] if abs(x['h']) > 0.0015 and (limb is None or x['facing'] > limb[0]) else 0.0
    if limb is None:
        fade = lambda d: 1.0
    else:
        fade = lambda d: M.smoothstep(limb[0], limb[1], facing(d))      # heights melt to 0 toward the limb
    for x in info:
        h = x['h']
        rf = (lambda d, h=h: base_fn(d) + h * fade(d))
        wall = ('up', 0.996) if h > 0 else (('down', 1.0) if h < 0 else None)
        if wall and r_fn:
            wall = None
        bm = M.cell_plate_bmesh(x['c'], x['poly'], rf, step=step, rings=rings(x) if callable(rings) else rings, wall=wall)
        ob = M.bm_to_obj(bm, 'plate%02d' % x['i'], col, smooth=None)
        bm.free()
        ob.location = loc
        ob.scale = (radius,) * 3
        if x.get('sea'):
            # a calm pale 水浅葱 paper sea (no rim: it must never read as a translucent shell over the globe)
            top = M.toon_mat('sea_' + theme, P['sea'], theme, rim=False, shade=P['sea_shade'], bands=2, t_shadow=0.035)
            wallm = top
        else:
            top, wallm = plate_mats(theme, x['band'])
        M.assign(ob, top)
        ob.data.materials.append(wallm)
        x['obj'] = ob
        x['fade'] = fade
    if not r_fn:          # (relief planets dip below any core sphere; their shared edges need no backing)
        lowest = min([0.0] + [x['h'] for x in info])
        core = M.uv_sphere(min(0.994, 1 + lowest - 0.006), 'core', col, seg=96, loc=loc)
        core.scale = (radius,) * 3
        M.assign(core, M.flat_mat('core_' + theme + coll_name, P['sea_shade'] if sea else P['band_shade'][4]))
    if hairline:
        hairlines(theme, info, loc, radius, cam_loc, line_px, base_fn, coll_name)
    # silhouette ink: the ONLY ink on the planet
    px = M.px_world(loc)
    ow = outline_px * px / radius
    M.hull_sphere(radius * (1 + ow), P['planet_outline'], loc=loc, name='planet_outline', collection=col)
    if sea:
        # the live globe's atmosphere band: a thin flat ring hugging the ink line, BEHIND the planet (back faces only)
        M.hull_sphere(radius * (1 + ow + 0.035), P['atmo'], loc=loc, name='atmo_ring', collection=col)
    return info


def hairlines(theme, info, loc, radius, cam_loc, line_px, base_fn, tag=''):
    """one uniform paper hairline per Voronoi edge (shared by two plates), sitting on the higher plate's top,
    extended half a width past each corner → clean T/Y joints, no blobs; thins out toward the limb."""
    P = M.PAL[theme]
    key = lambda v: (round(v.x, 5), round(v.y, 5), round(v.z, 5))
    edges = {}
    for x in info:
        poly = x['poly']
        for k in range(len(poly)):
            a, b = poly[k], poly[(k + 1) % len(poly)]
            ka, kb = key(a), key(b)
            if ka == kb:
                continue
            e = (ka, kb) if ka < kb else (kb, ka)
            ent = edges.setdefault(e, dict(a=a if ka < kb else b, b=b if ka < kb else a, cells=[]))
            ent['cells'].append(x)
    bm = bmesh.new()
    coast = []
    for e in edges.values():
        cs = e['cells']
        if all(x.get('sea') for x in cs):
            continue                      # the sea is one calm surface
        if any(x.get('sea') for x in cs):
            coast.append(e)
            continue
        hi = max(cs, key=lambda x: x['h'])
        lo = min(cs, key=lambda x: x['h'])
        hh = max(hi['h'], 0.0)
        shift = hi['h'] - lo['h'] > 1e-4
        ds = M.arc_samples(e['a'], e['b'], 0.008) + [Vector(e['b']).normalized()]
        pts, nrms, hws = [], [], []
        for d in ds:
            r = base_fn(d) + hh * cs[0]['fade'](d)
            p = Vector(loc) + d * radius * r
            fac = d.dot((Vector(cam_loc) - p).normalized())
            hw = 0.5 * line_px * M.px_world(p) * M.smoothstep(0.04, 0.30, fac)
            if shift:
                tdir = (hi['c'] - d * d.dot(hi['c'])).normalized()
                d = (d + tdir * (hw / (radius * r))).normalized()
            pts.append(Vector(loc) + d * radius * (r + 0.0012 / max(radius, 1e-3) + 0.0006))
            nrms.append(d)
            hws.append(max(hw, 1e-5))
        if max(hws) < 2e-5:
            continue
        M.ribbon_bmesh(pts, nrms, hws, ext=(hws[0], hws[-1]), bm=bm)
    ob = M.bm_to_obj(bm, 'hairlines' + tag, M.coll('soft'), smooth=False)
    bm.free()
    M.assign(ob, M.toon_mat('hair_' + theme, P['border'], theme, rim=False, bands=2, t_shadow=0.035,
                            shade=M.mixs(P['border'], P['band_shade'][3], 0.35)))
    ob.visible_shadow = False
    if coast:
        # coast lines (等深線, as on the live globe): two thin rings in the sea, just beyond the land's shelf wall
        for li, (off, colmix, wmul) in enumerate(((0.03, 0.0, 2.0), (0.07, 0.45, 1.5))):
            bm = bmesh.new()
            for e in coast:
                land = next(x for x in e['cells'] if not x.get('sea'))
                ds = M.arc_samples(e['a'], e['b'], 0.008) + [Vector(e['b']).normalized()]
                pts, nrms, hws = [], [], []
                for d in ds:
                    p = Vector(loc) + d * radius * base_fn(d)
                    fac = d.dot((Vector(cam_loc) - p).normalized())
                    hw = 0.5 * wmul * line_px * M.px_world(p) * M.smoothstep(0.04, 0.30, fac)
                    away = -(land['c'] - d * d.dot(land['c'])).normalized()
                    d = (d + away * off).normalized()
                    pts.append(Vector(loc) + d * radius * (base_fn(d) + 0.0012 / max(radius, 1e-3)))
                    nrms.append(d)
                    hws.append(max(hw, 1e-5))
                M.ribbon_bmesh(pts, nrms, hws, ext=(hws[0], hws[-1]), bm=bm)
            oc = M.bm_to_obj(bm, 'coast%d' % li + tag, M.coll('soft'), smooth=False)
            bm.free()
            cc = M.mixs(P['coast'], P['sea'], colmix) if colmix else P['coast']
            M.assign(oc, M.flat_mat('coast%d_' % li + theme, cc))   # unlit: one steady line across lit and shade
            oc.visible_shadow = False
    return ob


def cell_at(cells, d):
    """index of the spherical (power) Voronoi cell that CONTAINS direction d (cells: [(c, poly)] or info)."""
    d = Vector(d).normalized()
    for k, x in enumerate(cells):
        poly = x.get('poly0', x['poly']) if isinstance(x, dict) else x[1]
        if all(poly[i].cross(poly[(i + 1) % len(poly)]).dot(d) >= -1e-9 for i in range(len(poly))):
            return k
    return max(range(len(cells)), key=lambda k: (cells[k]['c'] if isinstance(cells[k], dict) else cells[k][0]).dot(d))


def nearest_cell(info, d):
    d = Vector(d).normalized()
    return max(range(len(info)), key=lambda k: info[k]['c'].dot(d))


def arc_points(a, b, h0, h1, lift, n=96, radius=1.0, loc=(0, 0, 0), t_end=1.0, bulge=None, bulge_amt=0.0):
    """主航道 path: great circle a→b, lifted off the surface; `bulge` adds a sideways bow (e.g. screen-up)
    so the arc reads as a curve from the camera instead of a straight bar."""
    pts = []
    for k in range(n + 1):
        t = k / n * t_end
        d = M.slerp(a, b, t)
        r = 1 + h0 * (1 - t) + h1 * t + lift * math.sin(math.pi * t) ** 0.9
        p = d * r
        if bulge is not None:
            u = Vector(bulge) - d * d.dot(Vector(bulge))
            if u.length > 1e-6:
                p = p + u.normalized() * bulge_amt * math.sin(math.pi * t)
                p = p.normalized() * max(p.length, r)
        pts.append(Vector(loc) + p * radius)
    return pts


def channel(theme, pts, r_tube=0.02, head_len=0.13, taper=(0.35, 1.0), case_w=0.42):
    """主航道: ONE solid navy toon tube + 3D arrow head, wrapped in a paper casing (inverted hull, = the live
    chanCase). No EEVEE cast shadow (that read as a ghost second arc) — see arc_shadow()."""
    P = M.PAL[theme]
    col = M.coll('chan')
    tip = pts[-1]
    tangent = (pts[-1] - pts[-3]).normalized()
    cut = 0
    acc = 0.0
    for k in range(len(pts) - 1, 0, -1):
        acc += (pts[k] - pts[k - 1]).length
        if acc > head_len * 0.55:
            cut = k
            break
    body = pts[:cut + 1]
    radii = [taper[0] + (taper[1] - taper[0]) * M.smoothstep(0, 0.7, k / (len(body) - 1)) for k in range(len(body))]
    tube = M.curve_obj('chan_tube', body, bevel=r_tube, radii=radii, collection=col, res=3)
    tube.data.bevel_resolution = 6
    tube = M.to_mesh_obj(tube, 'chan_tube')
    cm = M.toon_mat('chan_' + theme, P['chan'], theme, rim=False, t_shadow=-0.25, t_mid=0.05, fake_light=CHAN_KEY)
    M.assign(tube, cm)
    case = M.curve_obj('chan_case', body, bevel=r_tube * (1 + case_w), radii=radii, collection=M.coll('soft'), res=3)
    case.data.bevel_resolution = 6
    case = M.to_mesh_obj(case, 'chan_case')
    me = case.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    M.assign(case, M.flat_mat('chan_case_' + theme, P['chan_case'], cull=True))
    bm = M.extrude_outline(M.arrow_outline(), 0.16, axis='Z', bevel=0.035)
    hb = M.hull_bmesh(bm, 0.07)
    head = M.bm_to_obj(bm, 'chan_head', col, smooth=False)
    hcase = M.bm_to_obj(hb, 'chan_head_case', M.coll('soft'), smooth=False)
    bm.free(); hb.free()
    M.assign(head, cm)
    M.assign(hcase, M.flat_mat('chan_case_' + theme + 'h', P['chan_case'], cull=True))
    s = head_len
    cam = bpy.context.scene.camera
    up = (tip.normalized() * 0.45 + (cam.location - tip).normalized() * 0.55).normalized()
    fwd = tangent
    x = fwd.cross(up).normalized()
    z = x.cross(fwd).normalized()
    rot = Matrix((x, -fwd, z)).transposed()
    mw = Matrix.Translation(body[-1]) @ rot.to_4x4() @ Matrix.Scale(s, 4)
    head.matrix_world = mw
    hcase.matrix_world = mw
    for o in (tube, case, head, hcase):
        o.visible_shadow = False
    return tube, head


def surface_r(info, d):
    """top radius of the plate under direction d (unit-radius planet)."""
    x = info[nearest_cell(info, d)]
    return 1.0 + max(0.0, x['h']) * x['fade'](d)


def arc_shadow(theme, pts, info, loc, radius, width, cam_loc, alpha=0.11):
    """crisp narrow offset band under the 主航道 (~10 % ink), cast by a light close to the view axis — reads as
    'it floats just above', never as a second arc."""
    P = M.PAL[theme]
    V = (Vector(cam_loc) - Vector(loc)).normalized()
    Ls = (V * 0.82 + LIGHT * 0.35).normalized()
    out_p, out_n = [], []
    for p in pts[:-6]:
        q = (Vector(p) - Vector(loc)) / radius
        # march toward the planet along −Ls until we hit the surface (plates included)
        hit = None
        for k in range(1, 240):
            s = q - Ls * (k * 0.004)
            d = s.normalized()
            if s.length <= surface_r(info, d) + 0.004:
                hit = d
                break
        if hit is None:
            continue
        out_p.append(Vector(loc) + hit * radius * (surface_r(info, hit) + 0.0035))
        out_n.append(hit)
    if len(out_p) < 3:
        return None
    n = len(out_p)
    hws = [0.5 * width * (0.35 + 0.65 * M.smoothstep(0, 0.25, k / (n - 1))) for k in range(n)]
    bm = M.ribbon_bmesh(out_p, out_n, hws)
    ob = M.bm_to_obj(bm, 'chan_shadow', M.coll('soft'), smooth=False)
    bm.free()
    M.assign(ob, M.flat_mat('chan_shadow_' + theme, P['ink'] if theme == 'day' else '#000000', alpha=alpha))
    ob.visible_shadow = False
    return ob


# ------------------------------------------------------------------------------ wind
def wind_stroke(theme, dirs, loc, radius, alt=0.012, head_px=8.0, colour=None, alpha=None, name='wind',
                edge_px=0.0, edge_alpha=0.55):
    """anime wind-line: one tapered stroke — hair-thin tail, thick front, round head cap. Lies on the surface.
    edge_px > 0: paper-white stroke with a hairline ink edge (風線), else a translucent ink stroke."""
    P = M.PAL[theme]
    n = len(dirs)
    pts, nrms, hws, pxs = [], [], [], []
    alts = alt if isinstance(alt, (list, tuple)) else [alt] * n      # per-point altitude (rides over relief)
    for k, d in enumerate(dirs):
        d = Vector(d).normalized()
        p = Vector(loc) + d * radius * (1 + alts[k])
        u = k / (n - 1)
        w = 0.06 + 0.94 * M.smoothstep(0.0, 0.92, u) ** 0.85
        px = M.px_world(p)
        pts.append(p); nrms.append(d); pxs.append(px)
        hws.append(0.5 * head_px * px * w)
    obs = []
    if edge_px > 0:
        ink = P['ink'] if theme == 'day' else '#0d1226'
        bm = M.ribbon_bmesh(pts, nrms, [h + edge_px * q for h, q in zip(hws, pxs)], head_cap=True,
                            ext=(edge_px * pxs[0], 0.0))
        ob = M.bm_to_obj(bm, name + '_edge', M.coll('soft'), smooth=False)
        bm.free()
        M.assign(ob, M.flat_mat('wind_edge_' + theme, ink, alpha=edge_alpha))
        obs.append(ob)
        lift = [Vector(loc) + Vector(d).normalized() * radius * (1 + alts[k] + 0.0012) for k, d in enumerate(dirs)]
        bm = M.ribbon_bmesh(lift, nrms, hws, head_cap=True)
        ob = M.bm_to_obj(bm, name, M.coll('soft'), smooth=False)
        bm.free()
        M.assign(ob, M.flat_mat('wind_paper_' + theme, colour or '#fffcf4'))
        obs.append(ob)
    else:
        bm = M.ribbon_bmesh(pts, nrms, hws, head_cap=True)
        ob = M.bm_to_obj(bm, name, M.coll('soft'), smooth=False)
        bm.free()
        M.assign(ob, M.flat_mat('wind_' + theme, colour or P['wind'], alpha=P['wind_a'] if alpha is None else alpha))
        obs.append(ob)
    for o in obs:
        o.visible_shadow = False
    return obs


def P_in(theme):
    """the wind's inflow tint (若竹), a touch deeper by day so it reads on cream plates."""
    return '#4a8757' if theme == 'day' else '#8fcf9a'


def short_stroke(path, frac, back=0.0):
    """the last `frac` of a stroke path, ending `back` (fraction) short of its end: one short anime wind line."""
    n = len(path)
    e = max(2, int(round((n - 1) * (1 - back))))
    s = max(0, min(e - 2, int(round(e - (n - 1) * frac))))
    return path[s:e + 1]


def ride_alts(info, path, alt, win=6):
    """altitudes for a wind stroke riding over the plates (like the live planet's windPos): the plate under each
    point, widened (max over a window) and smoothed, so the stroke glides over walls instead of cutting into them."""
    hs = [max(0.0, info[cell_at(info, d)]['h']) for d in path]
    n = len(hs)
    mx = [max(hs[max(0, k - win):min(n, k + win + 1)]) for k in range(n)]
    sm = [sum(mx[max(0, k - win):min(n, k + win + 1)]) / len(mx[max(0, k - win):min(n, k + win + 1)]) for k in range(n)]
    return [max(h, m) + alt for h, m in zip(hs, sm)]


def edge_point(cell, tdir):
    """where the ray from the cell centre along tangent direction tdir leaves the cell (unit sphere)."""
    c, e1, e2 = M.tangent_frame(cell['c'])
    dx, dy = tdir.dot(e1), tdir.dot(e2)
    P2 = [(q.dot(e1) / q.dot(c), q.dot(e2) / q.dot(c)) for q in cell.get('poly0', cell['poly'])]
    best = None
    for k in range(len(P2)):
        (ax, ay), (bx, by) = P2[k], P2[(k + 1) % len(P2)]
        ex, ey = bx - ax, by - ay
        den = dx * (-ey) - dy * (-ex)
        if abs(den) < 1e-12:
            continue
        s = (ax * (-ey) - ay * (-ex)) / den
        u = (dx * ay - dy * ax) / den
        if s > 0 and -1e-6 <= u <= 1 + 1e-6 and (best is None or s < best):
            best = s
    best = best or 0.05
    return (c + e1 * dx * best + e2 * dy * best).normalized()


def streams_from(starts, cell, bow=0.12, gap=0.02, samples=40):
    """one stroke per start direction (pick them evenly spaced on screen), each ending just outside `cell`'s
    border where the line from the cell centre toward the start leaves the plate; all bend the same way."""
    c = cell['c']
    out = []
    for S in starts:
        if S is None:
            continue
        S = Vector(S).normalized()
        tdir = (S - c * c.dot(S)).normalized()
        E = edge_point(cell, tdir)
        axis = c.cross(E).normalized()
        E = (Quaternion(axis, gap) @ E).normalized()
        mid = (S + E).normalized()
        side = mid.cross((E - S).normalized()).normalized()
        Lg = math.acos(max(-1, min(1, S.dot(E))))
        C = (mid + side * (bow * Lg)).normalized()
        out.append([(S * (1 - t) ** 2 + C * 2 * t * (1 - t) + E * t * t).normalized()
                    for t in [k / samples for k in range(samples + 1)]])
    return out


def streams_parallel(info, target, starts_px, dir_px, R=1.0, loc=(0, 0, 0), gap_px=8, bow=0.06, samples=40,
                     max_px=900, aim_px=None, aim=0.0):
    """evenly spaced, parallel-on-screen strokes: from each start pixel walk along dir_px until the next step would
    enter the target plate, stop gap_px short of its border. Returns lists of unit directions (from loc)."""
    sc = bpy.context.scene
    Wd, Hd = sc.render.resolution_x, sc.render.resolution_y
    dx, dy = dir_px
    ln = math.hypot(dx, dy)
    dx, dy = dx / ln, dy / ln
    tk = info[target]['i'] if isinstance(target, int) is False else target
    out = []
    base_dx, base_dy = dx, dy
    for (x0, y0) in starts_px:
        S = screen_dir(x0 / Wd, 1 - y0 / Hd, R, loc)
        if S is None:
            continue
        dx, dy = base_dx, base_dy
        if aim_px is not None and aim > 0:
            ax, ay = aim_px[0] - x0, aim_px[1] - y0
            al = math.hypot(ax, ay)
            dx, dy = dx * (1 - aim) + ax / al * aim, dy * (1 - aim) + ay / al * aim
            ln2 = math.hypot(dx, dy)
            dx, dy = dx / ln2, dy / ln2
        hist = [S]
        E = None
        for k in range(1, int(max_px / 3)):
            x, y = x0 + dx * 3 * k, y0 + dy * 3 * k
            d = screen_dir(x / Wd, 1 - y / Hd, R, loc)
            if d is None:
                break
            if cell_at(info, d) == tk:
                back = max(0, len(hist) - 1 - int(gap_px / 3))
                E = hist[back]
                break
            hist.append(d)
        if E is None or (E - S).length < 1e-4:
            continue
        mid = (S + E).normalized()
        side = mid.cross((E - S).normalized()).normalized()
        Lg = math.acos(max(-1, min(1, S.dot(E))))
        C = (mid + side * (bow * Lg)).normalized()
        out.append([(S * (1 - t) ** 2 + C * 2 * t * (1 - t) + E * t * t).normalized()
                    for t in [q / samples for q in range(samples + 1)]])
    return out


def streams_to(cell, src, n, spread_deg, length, bow=0.25, gap=0.012, fan=0.55, samples=40, stagger=0.15):
    """n evenly spaced streamlines from a wide front toward `cell`, each ending just outside the plate's border
    (spread along the facing side), all bending the same way. Returns lists of unit directions."""
    c = cell['c']
    u0 = (Vector(src) - c * c.dot(Vector(src))).normalized()
    v0 = c.cross(u0).normalized()
    out = []
    for i in range(n):
        f = (i - (n - 1) / 2) / max(1, (n - 1) / 2)          # −1 … 1
        th = math.radians(spread_deg) * f
        tdir = (u0 * math.cos(th) + v0 * math.sin(th)).normalized()
        E = edge_point(cell, tdir)
        axis = c.cross(E).normalized()
        E = (Quaternion(axis, gap) @ E).normalized()
        L = length * (1 - stagger * abs(f) - stagger * 0.5 * (i % 2))
        # start: back along the flow, spread wider than the ends (gentle convergence, not a radial sink)
        S = (E + u0 * L + v0 * (math.sin(th) * L * fan)).normalized()
        mid = (S + E).normalized()
        side = (mid.cross((E - S).normalized())).normalized()
        C = (mid + side * (bow * L)).normalized()
        pts = []
        for k in range(samples + 1):
            t = k / samples
            q = S * (1 - t) ** 2 + C * 2 * t * (1 - t) + E * t * t
            pts.append(q.normalized())
        out.append(pts)
    return out


# ------------------------------------------------------------------------------ clouds, storm, symbols
def cloud(theme, kind, direction, alt, scale, cam_loc, spin=0.0, storm=False, radius=1.0, loc=(0, 0, 0),
          coll_name='ink', seed=0, upright=0.55):
    """2-tone toon cloud lit by the canonical light from each lobe's OWN normal (explicit N·L, no lobe-on-lobe
    cast shadows → one clean lower-right crescent per lobe + a flat underside). Still casts a crisp shadow."""
    P = M.PAL[theme]
    ob = M.cloud_obj(kind, 'cloud_' + kind, M.coll(coll_name), seg=40, rings=22, seed=seed)
    if storm:
        mat = M.toon_mat('storm_' + theme, P['storm_hi'], theme, rim=False, bands=3, shade=P['storm_shade'],
                         mid=P['storm'], t_shadow=0.06, t_mid=0.62, fake_light=LIGHT)
    else:
        mat = M.toon_mat('cloud_' + theme, P['cloud'], theme, rim=False, bands=2, shade=P['cloud_shade'],
                         t_shadow=0.10, fake_light=LIGHT)
    M.assign(ob, mat)
    ob.scale = (scale,) * 3
    M.place_on_sphere(ob, direction, alt, radius=radius, spin=spin, face=cam_loc, upright=upright)
    ob.location += Vector(loc)
    ob.visible_shadow = alt < 0.2 * max(radius, 1.0) or storm
    return ob


def screen_bbox(ob):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    mw = ev.matrix_world
    pts = [M.world_to_px(mw @ v.co) for v in ev.data.vertices]
    return pts


def storm_kit(theme, cl, n_rows=2, per_row=6, rain_px=40, rain_w=4.6, slant=0.36, bolt_h=118, bolt_dx=0.20):
    """rain + bolt in SCREEN space under the storm cloud's visible base (never hidden behind the cloud):
    12 short parallel diagonals, evenly spaced; one flat zig-zag (the app's own bolt) emerging from the base."""
    P = M.PAL[theme]
    pts = screen_bbox(cl)
    xs = [p[0] for p in pts]
    x0, x1 = min(xs), max(xs)
    wpx = x1 - x0
    # visible base: lowest silhouette point within the central 70 %
    base_y = max(p[1] for p in pts if x0 + 0.15 * wpx <= p[0] <= x1 - 0.15 * wpx)
    depth = cl.location
    _, _, back = cam_vectors()
    s = 1.0
    # rain
    bm = bmesh.new()
    rx0, rx1 = x0 + 0.20 * wpx, x1 - 0.30 * wpx
    for r in range(n_rows):
        for k in range(per_row):
            fx = (k + 0.5 + (0.5 if r % 2 else 0) - 0.25) / per_row
            px = rx0 + (rx1 - rx0) * fx - r * rain_px * slant * 0.9
            py = base_y + 18 + r * rain_px * 1.3
            a = screen_to_world(px, py, depth)
            b = screen_to_world(px - rain_px * slant, py + rain_px, depth)
            hw = 0.5 * rain_w * M.px_world(a)
            M.ribbon_bmesh([a, b], [back, back], [hw, hw], bm=bm)
    rob = M.bm_to_obj(bm, 'rain', M.coll('soft'), smooth=False)
    bm.free()
    M.assign(rob, M.flat_mat('rain_' + theme, P['rain']))
    rob.visible_shadow = False
    # bolt (SVG path of the live app: M15 1 3 22h8l-4 17 15-24h-8.5z, 24×40 box)
    svg = [(15, 1), (3, 22), (11, 22), (7, 39), (22, 15), (13.5, 15)]
    k = bolt_h / 38.0
    bx = x0 + wpx * (0.5 + bolt_dx) - 12 * k
    by = base_y - 0.10 * bolt_h
    vs = [screen_to_world(bx + x * k, by + y * k, depth + back * 0.05) for (x, y) in svg]
    bm = bmesh.new()
    vv = [bm.verts.new(v) for v in vs]
    f = bm.faces.new(vv)
    bm.normal_update()
    if f.normal.dot(back) < 0:
        f.normal_flip()
    bolt = M.bm_to_obj(bm, 'bolt', M.coll('bolt'), smooth=False)
    bm.free()
    M.assign(bolt, M.flat_mat('bolt_' + theme, P['bolt']))
    bolt.visible_shadow = False
    return rob, bolt


def cell_boundary(cell, step=0.008):
    B = []
    poly = cell['poly']
    for k in range(len(poly)):
        B += M.arc_samples(poly[k], poly[(k + 1) % len(poly)], step)
    return B


def front_decal(theme, cell, kind, loc, radius, cam_loc, frac=0.55, sym_px=10, gap_px=34, line_px=3.0):
    """classic weather-map front lying FLAT on part of a territory border (live grammar):
    kind 'in'  → 若竹 line + semicircles bulging into the territory (钱开始流入);
    kind 'out' → 臙脂 line + triangles pointing out of it (钱开始撤离). Paper halo under the line."""
    P = M.PAL[theme]
    col = P['inflow'] if kind == 'in' else P['outflow']
    B = cell_boundary(cell)
    r = 1.0 + max(0.0, cell['h']) + 0.0016
    W = (Vector(cam_loc) - Vector(loc)).normalized()
    n = len(B)
    win = max(4, int(n * frac))
    best = max(range(n), key=lambda s: sum(B[(s + j) % n].dot(W) for j in range(win)))
    ds = [B[(best + j) % n] for j in range(win)]
    pts = [Vector(loc) + d * radius * r for d in ds]
    px = M.px_world(pts[len(pts) // 2])
    halo = M.ribbon_bmesh(pts, ds, [0.5 * line_px * 2.3 * px] * len(pts))
    ho = M.bm_to_obj(halo, 'front_halo', M.coll('soft'), smooth=False); halo.free()
    M.assign(ho, M.flat_mat('front_halo_' + theme, P['halo'], alpha=0.8))
    lifted = [Vector(loc) + d * radius * (r + 0.0008) for d in ds]
    bm = M.ribbon_bmesh(lifted, ds, [0.5 * line_px * px] * len(pts))
    # symbols
    cum = [0.0]
    for i in range(1, len(lifted)):
        cum.append(cum[-1] + (lifted[i] - lifted[i - 1]).length)
    gap, sz = gap_px * px, sym_px * px
    s = gap * 0.5
    j = 1
    c = cell['c']
    while s < cum[-1] - gap * 0.3:
        while j < len(cum) - 1 and cum[j] < s:
            j += 1
        u = (s - cum[j - 1]) / max(1e-9, cum[j] - cum[j - 1])
        p = lifted[j - 1].lerp(lifted[j], u)
        nn_ = ds[j - 1].lerp(ds[j], u).normalized()
        t = (lifted[j] - lifted[j - 1]).normalized()
        inward = (c - nn_ * nn_.dot(c)).normalized()
        side = nn_.cross(t).normalized()
        if side.dot(inward) < 0:
            side = -side
        if kind == 'out':
            side = -side
        if kind == 'in':
            K = 10
            cv = bm.verts.new(p)
            ring = [bm.verts.new(p + t * (sz * math.cos(math.pi * q / K)) + side * (sz * math.sin(math.pi * q / K)))
                    for q in range(K + 1)]
            for q in range(K):
                bm.faces.new((cv, ring[q], ring[q + 1]))
        else:
            a = bm.verts.new(p - t * sz)
            b = bm.verts.new(p + t * sz)
            tip = bm.verts.new(p + side * sz * 1.45)
            bm.faces.new((a, b, tip))
        s += gap
    bm.normal_update()
    for f in bm.faces:
        cc = f.calc_center_median()
        if f.normal.dot(cc - Vector(loc)) < 0:
            f.normal_flip()
    ob = M.bm_to_obj(bm, 'front_' + kind, M.coll('soft'), smooth=False)
    bm.free()
    M.assign(ob, M.flat_mat('front_' + kind + theme, col))
    for o in (ho, ob):
        o.visible_shadow = False
    return ob


def text_badge(theme, ch, pos, size, fg, bg, face=None, coll_name='fine'):
    """flat round badge with one CJK glyph (挤 / 空), facing the camera — a paper token, not a map pin."""
    col = M.coll(coll_name)
    font = bpy.data.fonts.load(FONT, check_existing=True)
    cu = bpy.data.curves.new('glyph', 'FONT')
    cu.body = ch
    cu.font = font
    cu.size = size * 1.12
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.extrude = 0.0
    t = bpy.data.objects.new('glyph', cu)
    M.coll('soft').objects.link(t)
    t = M.to_mesh_obj(t, 'glyph')
    M.assign(t, M.flat_mat('glyph_' + fg, fg))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=72, radius1=size, radius2=size, depth=size * 0.03)
    disc = M.bm_to_obj(bm, 'badge', col, smooth=False)
    bm.free()
    M.assign(disc, M.flat_mat('badge_' + bg + theme, bg))
    disc.rotation_euler = (math.pi / 2, 0, 0)
    t.rotation_euler = (math.pi / 2, 0, 0)
    t.location = (0, -size * 0.03, -size * 0.04)
    root = bpy.data.objects.new('badge_root', None)
    col.objects.link(root)
    t.parent = root
    disc.parent = root
    root.location = Vector(pos)
    if face is not None:
        d = (Vector(face) - Vector(pos))
        flat = Vector((d.x, d.y, 0))
        yaw = math.atan2(flat.x, -flat.y) if flat.length > 0 else 0
        pitch = math.atan2(d.z, flat.length)
        root.rotation_euler = (-pitch * 0.85, 0, yaw)
    for o in (t, disc):
        o.visible_shadow = False
    return root


def far_clouds(theme, cam, specs):
    """flat, ink-less background clouds (Ghibli depth layer), one tone a hair darker than the sky."""
    P = M.PAL[theme]
    col = M.mixs(P['sky0'], P['sky1'], 0.9) if theme == 'day' else M.mixs(P['sky1'], '#ffffff', 0.035)
    mat = M.flat_mat('far_' + theme, col)
    for (kind, pos, scale) in specs:
        ob = M.cloud_obj(kind, 'far', M.coll('far'), seg=32, rings=16)
        M.assign(ob, mat)
        ob.scale = (scale,) * 3
        ob.location = Vector(pos)
        d = cam.location - ob.location
        ob.rotation_euler = (0, 0, math.atan2(d.x, -d.y) if abs(d.x) > 1e-6 else 0)
        ob.visible_shadow = False


def save(name):
    path = os.path.join(RAW, name + '.png')
    t0 = time.time()
    M.render(path)
    print('RENDER', name, '%.1fs' % (time.time() - t0), os.path.getsize(path), 'bytes')
    return path


# =============================================================================== hero
def hero(theme='day', transparent=False):
    W, H = 1600, 1000
    cam_loc = Vector((0.0, -7.2, 2.0))
    cam = setup(W, H, theme, cam_loc, (0, 0, 0.12), lens=50, shift=(0.0, -0.03), samples=48)
    rng = random.Random(11)
    seeds, ws = weighted_seeds(64, 9, wmax=0.14, iters=1)
    cells = M.sphere_voronoi(seeds, ws)
    # pick the 主航道 ends by where they land on screen: both well inside the disc (≤ ~0.6 R from its centre)
    sd = lambda u, v: screen_dir(u, v, 1.0, (0, 0, 0))
    ia, ib = cell_at(cells, sd(0.375, 0.47)), cell_at(cells, sd(0.625, 0.46))
    risers = [k for k in (cell_at(cells, sd(0.60, 0.66)), cell_at(cells, sd(0.66, 0.36))) if k not in (ia, ib)]
    A, B = cells[ia][0], cells[ib][0]

    def temp(c, i):
        # most territories are ordinary weather (浅葱 … 山吹); only the two ends of the 主航道 are extremes
        return max(-1.6, min(1.7, 1.5 * c.dot(B) - 1.4 * c.dot(A) + rng.uniform(-0.22, 0.22) + 0.1))

    def height(c, i, t):
        # every territory stands on a low shelf; the movers (in OR out) stand up — |wind| is volume
        return 0.04 if i in risers else 0.012

    # the continent: a cap turned ~0.3 rad off the view axis toward the light (the live globe's 3/4 rest pose)
    vd = (cam_loc - Vector((0, 0, 0.12))).normalized()
    upleft = (cam.matrix_world.to_3x3() @ Vector((-0.7, 0.5, 0.0))).normalized()
    pole = (vd * math.cos(0.3) + upleft * math.sin(0.3)).normalized()
    info = build_planet(theme, cam_loc, seeds, ws, temp, height, overrides={ia: (-2.2, 0.04), ib: (2.8, 0.085)},
                        line_px=1.3, outline_px=2.8, limb=None, sea=(pole, 1.08))
    src, dst = info[ia], info[ib]
    pts = arc_points(A, B, 0.02, dst['h'] + 0.03, 0.10, t_end=0.90, bulge=Vector((0, 0.25, 1)), bulge_amt=0.36)
    channel(theme, pts, r_tube=0.032, head_len=0.23)
    arc_shadow(theme, pts, info, (0, 0, 0), 1.0, 0.034 * 1.6, cam_loc)
    # 6 short tapered wind strokes with round heads, staggered, heading into the inflow plate (若竹, like the live
    # strokes that go where money goes) and stopping at its edge
    starts = [(560 + 18 * k, 560 + 30 * k) for k in range(6)]
    for k, path in enumerate(streams_parallel(info, ib, starts, (1.0, -0.10), gap_px=12, bow=-0.05)):
        path = short_stroke(path, (0.42, 0.55, 0.36, 0.5, 0.4, 0.58)[k % 6])
        wind_stroke(theme, path, (0, 0, 0), 1.0, alt=ride_alts(info, path, 0.006), head_px=8.5,
                    colour=P_in(theme), alpha=0.9)
    if not transparent:
        far_clouds(theme, cam, [('stratus_b', (-4.6, 8.0, -1.9), 1.7), ('drift_e', (4.9, 9.0, 2.7), 1.5)])
    cloud(theme, 'cumulus_a', M.sph(50, 46), 0.12, 0.40, cam_loc, seed=1, upright=0.85)
    cloud(theme, 'drift_e', M.sph(-34, -58), 0.30, 0.42, cam_loc, seed=2, upright=0.95)
    cloud(theme, 'puff_d', M.sph(48, -44), 0.10, 0.15, cam_loc, seed=3, upright=0.7)
    if transparent:
        bpy.context.scene.render.film_transparent = True
        bpy.context.scene.render.image_settings.color_mode = 'RGBA'
        bpy.data.objects.remove(bpy.data.objects['backdrop'], do_unlink=True)
    ink_sets(theme, scale=W / 1600)
    save('hero_' + theme + ('_cut' if transparent else ''))


# =============================================================================== glyphs & symbols
def circle_pts(r, n=48, cx=0.0, cy=0.0, a0=0.0, a1=2 * math.pi):
    return [(cx + r * math.cos(a0 + (a1 - a0) * k / n), cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n)]


def leaf_pts(L=1.0, W=0.42, n=18):
    up = [(L * k / n, W * math.sin(math.pi * k / n) ** 0.85 * (1 - 0.25 * k / n)) for k in range(n + 1)]
    lo = [(L * k / n, -W * 0.55 * math.sin(math.pi * k / n) ** 0.85) for k in range(n - 1, 0, -1)]
    return up + lo


MAPLE_R = [(0.0, 1.0), (0.11, 0.70), (0.30, 0.80), (0.25, 0.50), (0.56, 0.62), (0.47, 0.40), (0.80, 0.33),
           (0.56, 0.17), (0.64, 0.02), (0.35, 0.08), (0.30, -0.08), (0.10, 0.02), (0.05, -0.10)]


def maple_pts():
    right = MAPLE_R
    left = [(-x, y) for (x, y) in reversed(MAPLE_R[1:])]
    return right + [(0.0, -0.06)] + left


def prism(name, outline, thick, mat, collection, bevel=0.0):
    bm = M.extrude_outline(outline, thick, axis='Z', bevel=bevel)
    ob = M.bm_to_obj(bm, name, collection, smooth=False)
    bm.free()
    M.assign(ob, mat)
    return ob


def join(objs, name):
    """join mesh objects into one (keeps materials)."""
    bm = bmesh.new()
    mats = []
    for o in objs:
        me = o.data.copy()
        me.transform(o.matrix_world)
        off = len(mats)
        for m in o.data.materials:
            mats.append(m)
        tmp = bmesh.new(); tmp.from_mesh(me)
        for f in tmp.faces:
            f.material_index += off
        me2 = bpy.data.meshes.new('t'); tmp.to_mesh(me2); tmp.free()
        bm.from_mesh(me2)
        bpy.data.meshes.remove(me2); bpy.data.meshes.remove(me)
    col = objs[0].users_collection[0]
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    ob = M.bm_to_obj(bm, name, col, smooth=None)
    bm.free()
    for m in mats:
        ob.data.materials.append(m)
    return ob


def glyph(kind, theme, collection, size=1.0, th=0.06, colour=None):
    """season / weather glyphs as THIN flat toon cut-outs in the XY plane (thickness along Z), ~unit size."""
    P = M.PAL[theme]
    T = lambda nm, hx: M.toon_mat(nm + theme, hx, theme, rim=False, bands=2, t_shadow=-0.2, fake_light=LIGHT)
    parts = []
    if kind == 'sun':
        m = T('g_sun', colour or P['bands'][6])
        parts.append(prism('sun_disc', circle_pts(0.40, 48), th, m, collection))
        for k in range(8):
            a = k * math.pi / 4
            ca, sa = math.cos(a), math.sin(a)
            tri = [(0.53 * ca - 0.08 * sa, 0.53 * sa + 0.08 * ca), (0.84 * ca, 0.84 * sa),
                   (0.53 * ca + 0.08 * sa, 0.53 * sa - 0.08 * ca)]
            parts.append(prism('sun_ray', tri, th, m, collection))
    elif kind == 'snow':
        m = T('g_snow', colour or P['bands'][2])
        for k in range(6):
            a = k * math.pi / 3 + math.pi / 2
            ca, sa = math.cos(a), math.sin(a)
            w = 0.06
            arm = [(-w * sa, w * ca), (0.86 * ca - w * sa, 0.86 * sa + w * ca), (0.86 * ca + w * sa, 0.86 * sa - w * ca), (w * sa, -w * ca)]
            parts.append(prism('snow_arm', arm, th, m, collection))
            for sgn in (-1, 1):
                b = a + sgn * math.pi / 4
                bx, by = 0.52 * ca, 0.52 * sa
                cb, sb = math.cos(b), math.sin(b)
                w2 = 0.045
                br = [(bx - w2 * sb, by + w2 * cb), (bx + 0.26 * cb - w2 * sb, by + 0.26 * sb + w2 * cb),
                      (bx + 0.26 * cb + w2 * sb, by + 0.26 * sb - w2 * cb), (bx + w2 * sb, by - w2 * cb)]
                parts.append(prism('snow_br', br, th, m, collection))
        parts.append(prism('snow_hub', circle_pts(0.13, 24), th, m, collection))
    elif kind == 'maple':
        m = T('g_maple', colour or P['bands'][7])
        pts = [(x * 0.95, y * 0.95 - 0.1) for x, y in maple_pts()]
        parts.append(prism('maple', pts, th, m, collection))
        stem = [(-0.03, -0.22), (0.03, -0.22), (0.045, -0.58), (-0.015, -0.58)]
        parts.append(prism('maple_stem', stem, th, m, collection))
    elif kind == 'sprout':
        mg = T('g_sprout', colour or P['inflow'])
        mg2 = T('g_sprout2', M.mixs(colour or P['inflow'], '#ffffff', 0.22))
        stem = [(-0.04, -0.70), (0.04, -0.70), (0.045, 0.0), (-0.045, 0.0)]
        parts.append(prism('sprout_stem', stem, th, mg, collection))
        l1 = prism('leaf_r', [(x * 0.66, y * 0.66) for x, y in leaf_pts(W=0.5)], th, mg2, collection)
        l1.rotation_euler = (0, 0, math.radians(28))
        l1.location = (0.0, -0.02, 0)
        l2 = prism('leaf_l', [(-x * 0.56, y * 0.56) for x, y in leaf_pts(W=0.5)], th, mg, collection)
        l2.rotation_euler = (0, 0, math.radians(-30))
        l2.location = (0.0, -0.10, 0)
        parts += [l1, l2]
    ob = join(parts, 'glyph_' + kind)
    ob.scale = (size,) * 3
    return ob


def stand_up(ob, pos, face_cam, tilt=0.0):
    """glyph lying in XY → stand it up (XZ plane) at pos, turned to face the camera."""
    ob.location = Vector(pos)
    d = Vector(face_cam) - Vector(pos)
    yaw = math.atan2(d.x, -d.y)
    ob.rotation_euler = (math.pi / 2 - tilt, 0, yaw)
    return ob


def ripple(theme, centre_dir, radius_planet, loc, rings=(0.07, 0.12, 0.17), lift=0.05, colour=None, line_px=2.2):
    P = M.PAL[theme]
    c, e1, e2 = M.tangent_frame(centre_dir)
    bm = bmesh.new()
    for k, r in enumerate(rings):
        ds = [(c + e1 * r * math.cos(a) + e2 * r * math.sin(a)).normalized() for a in [2 * math.pi * q / 96 for q in range(97)]]
        pts = [Vector(loc) + d * radius_planet * (1 + lift) for d in ds]
        px = M.px_world(pts[0])
        M.ribbon_bmesh(pts, ds, [0.5 * line_px * px * (1.0 - 0.18 * k)] * len(pts), bm=bm)
    ob = M.bm_to_obj(bm, 'ripple', M.coll('soft'), smooth=False)
    bm.free()
    M.assign(ob, M.flat_mat('ripple_' + theme, colour or P['chan']))
    ob.visible_shadow = False
    return ob


def dashed(theme, pts, dash=0.08, gap=0.06, r=0.012, colour=None):
    P = M.PAL[theme]
    mat = M.flat_mat('dash_' + theme + (colour or ''), colour or P['chan'])
    col = M.coll('soft')
    on, cur = True, [pts[0]]
    budget = dash
    out = []
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        seg = (b - a).length
        pos = 0.0
        while seg - pos > budget:
            pos += budget
            q = a.lerp(b, pos / seg)
            if on:
                cur.append(q)
                if len(cur) >= 2:
                    ob = M.curve_obj('dash', cur, bevel=r, collection=col, res=1)
                    M.assign(ob, mat); ob.visible_shadow = False
                    out.append(ob)
                cur = []
            else:
                cur = [q]
            on = not on
            budget = dash if on else gap
        budget -= (seg - pos)
        if on:
            cur.append(b)
    return out


# =============================================================================== tutorial cards (1200 × 700)
CARD_W, CARD_H = 1200, 700


def screen_dir(u, v, R, loc):
    """direction (from the planet centre) of the surface point seen at screen (u, v); u→right, v→up, 0..1."""
    sc = bpy.context.scene
    cam = sc.camera
    bpy.context.view_layer.update()
    fr = cam.data.view_frame(scene=sc)          # tr, br, bl, tl in camera space
    tr, br, bl, tl = [cam.matrix_world @ p for p in fr]
    o = cam.matrix_world.translation
    p = bl + (br - bl) * u + (tl - bl) * v
    d = (p - o).normalized()
    oc = o - Vector(loc)
    b = oc.dot(d)
    c = oc.dot(oc) - R * R
    disc = b * b - c
    if disc < 0:
        return None
    t = -b - math.sqrt(disc)
    hit = o + d * t
    return (hit - Vector(loc)).normalized()


def tut_temp(theme='day'):
    """颜色 = 温度: a planet whose territories run cold (藍) → hot (朱), beside a 9-step paper thermometer."""
    cam_loc = Vector((0.0, -7.6, 1.6))
    cam = setup(CARD_W, CARD_H, theme, cam_loc, (0.55, 0, 0.1), lens=50, samples=40)
    P = M.PAL[theme]
    rng = random.Random(3)
    seeds, ws = weighted_seeds(70, 31, wmax=0.06, iters=1)
    L0 = Vector((-1, -0.25, 0)).normalized()

    def temp(c, i):
        return max(-2.95, min(2.95, -3.4 * c.dot(L0) + rng.uniform(-0.22, 0.22)))

    build_planet(theme, cam_loc, seeds, ws, temp, None, line_px=1.4, outline_px=2.6)
    cloud(theme, 'puff_d', M.sph(48, -34), 0.10, 0.24, cam_loc, seed=2, upright=0.85)
    cloud(theme, 'drift_e', M.sph(40, 52), 0.08, 0.28, cam_loc, seed=5, upright=0.85)
    # thermometer: 9 thin paper tiles stacked bottom (cold) → top (hot)
    col = M.coll('thermo')
    x0, y0, z0 = 2.05, -0.2, -0.86
    tile = M.round_convex([(-0.14, -0.08), (0.14, -0.08), (0.14, 0.08), (-0.14, 0.08)], 0.05, seg=4)
    step = 0.215
    for b in range(9):
        m = M.toon_mat('tile%d' % b, P['bands'][b], theme, rim=False, bands=2, t_shadow=-0.2, fake_light=LIGHT)
        ob = prism('tile', [(x * 0.85, y * 0.85) for x, y in tile], 0.035, m, col)
        ob.rotation_euler = (math.pi / 2, 0, math.radians(-14))
        ob.location = (x0, y0, z0 + b * step)
    gs = glyph('snow', theme, col, size=0.20, colour=None if theme == 'day' else '#8fc4c9')
    stand_up(gs, (x0, y0, z0 - 0.36), cam_loc)
    gh = glyph('sun', theme, col, size=0.22)
    stand_up(gh, (x0, y0, z0 + 8 * step + 0.38), cam_loc)
    # night: a light kinari keyline so the coldest tiles never merge into the navy sky
    key = P['ink'] if theme == 'day' else '#e8e0cc'
    extra = [dict(name='thermo', collection=col, color=key, thickness=1.5 * 1.1, types=('silhouette', 'border'))]
    ink_sets(theme, scale=1.1, extra=extra)
    save('tut_temp' + ('' if theme == 'day' else '_night'))


def close_planet(theme, R, n, seed, temp, height, cam_loc, wmax=0.06, overrides=None):
    loc = Vector((0, 0, -R))
    seeds, ws = weighted_seeds(n, seed, wmax=wmax, iters=2)
    info = build_planet(theme, cam_loc, seeds, ws, temp, height, loc=loc, radius=R, overrides=overrides,
                        line_px=1.5, outline_px=2.6, step=0.010)
    return info, loc


def tut_wind(theme='day'):
    """风线 = 钱在搬家: a 3/4 top-down patch of the planet; a few long wind strokes leave a cold plate (it stands up a
    region, bend, and stop at the edge of a warm plate that rises as a block — money has volume."""
    R = 2.4
    cam_loc = Vector((0.0, -2.15, 2.75))
    cam = setup(CARD_W, CARD_H, theme, cam_loc, (0.08, 0.38, -0.25), lens=36, samples=40)
    P = M.PAL[theme]
    loc0 = Vector((0, 0, -R))
    A = screen_dir(0.18, 0.40, R, loc0)
    B = screen_dir(0.64, 0.30, R, loc0)
    rng = random.Random(5)

    def temp(c, i):
        return max(-2.5, min(2.5, 5.0 * (c.dot(B) - c.dot(A)) + rng.uniform(-0.25, 0.25)))

    seeds, ws = weighted_seeds(120, 17, wmax=0.06, iters=2)
    cells = M.sphere_voronoi(seeds, ws)
    ib = max(range(len(cells)), key=lambda k: cells[k][0].dot(B))
    ia = max(range(len(cells)), key=lambda k: cells[k][0].dot(A))
    loc = Vector((0, 0, -R))
    info = build_planet(theme, cam_loc, seeds, ws, temp, None, loc=loc, radius=R,
                        overrides={ib: (2.8, 0.075), ia: (-2.8, 0.026)}, line_px=1.5, outline_px=2.6, step=0.010)
    x = info[ib]
    # the receiving plate is a solid block of money: its sides take the hot colour
    x['obj'].data.materials[1] = M.toon_mat('wall_hot_' + theme, M.mixs(P['bands'][8], P['band_shade'][8], 0.45),
                                            theme, rim=False, bands=2, shade=P['band_shade'][8], t_shadow=0.035)
    bx, by = M.world_to_px(loc + x['c'] * R)
    starts = [(150 + 16 * k, 345 + 50 * k) for k in range(6)]
    for k, path in enumerate(streams_parallel(info, ib, starts, (1.0, 0.0), R=R, loc=loc, gap_px=12, bow=-0.06,
                                              aim_px=(bx, by), aim=0.45)):
        # short, staggered strokes with round heads (not long parallel strings): 若竹 = money heading in
        path = short_stroke(path, (0.34, 0.46, 0.3, 0.42, 0.36, 0.5)[k % 6], back=(0.0, 0.12, 0.05, 0.18, 0.08, 0.0)[k % 6])
        wind_stroke(theme, path, loc, R, alt=0.004, head_px=11.0, colour=P_in(theme), alpha=0.92)
    cloud(theme, 'puff_d', screen_dir(0.80, 0.52, R, loc), 0.14, 0.42, cam_loc, radius=R, loc=loc,
          seed=1, upright=1.0)
    ink_sets(theme, scale=1.1)
    save('tut_wind' + ('' if theme == 'day' else '_night'))


def tut_pres(theme='day'):
    """挤 / 空: a crowded high (tight isobar rings, 挤) beside an empty low (loose rings, 空), like H/L on a
    weather map — the same flat paper plates, with real relief."""
    R = 3.2
    cam_loc = Vector((0.0, -3.7, 1.75))
    cam = setup(CARD_W, CARD_H, theme, cam_loc, (0.0, 0.25, -0.05), lens=42, samples=40)
    P = M.PAL[theme]
    loc = Vector((0, 0, -R))
    up = Vector((0, 0, 1))
    H = (up + Vector((-0.24, 0.06, 0))).normalized()
    Lw = (up + Vector((0.25, -0.03, 0))).normalized()
    sH, sL, aH, aL = 0.075, 0.105, 0.30, -0.16

    def relief(d):
        gh = math.exp(-((d - H).length ** 2) / (2 * sH ** 2))
        gl = math.exp(-((d - Lw).length ** 2) / (2 * sL ** 2))
        return aH * gh + aL * gl

    def r_fn(d):
        return 1 + relief(d) / R

    rng = random.Random(8)

    def temp(c, i):
        gh = math.exp(-((c - H).length ** 2) / (2 * (sH * 1.6) ** 2))
        gl = math.exp(-((c - Lw).length ** 2) / (2 * (sL * 1.4) ** 2))
        return max(-2.4, min(2.4, 2.2 * gh - 2.0 * gl + 0.35 + rng.uniform(-0.35, 0.35)))

    seeds, ws = weighted_seeds(150, 21, wmax=0.05, iters=2)
    fine = lambda x: 40 if min(x['c'].dot(H), x['c'].dot(Lw)) > -1 and max(x['c'].dot(H), x['c'].dot(Lw)) > math.cos(0.42) else 6
    build_planet(theme, cam_loc, seeds, ws, temp, None, loc=loc, radius=R, r_fn=r_fn, line_px=1.4, outline_px=2.6,
                 step=0.005, rings=fine)
    # isobars: rings of equal relief around each centre (tight around 挤, loose around 空)
    ink = M.flat_mat('iso_' + theme, P['ink'] if theme == 'day' else '#141a2e')
    bm = bmesh.new()
    for (C, s_, a_, levels) in ((H, sH, aH, (0.85, 0.6, 0.38, 0.2, 0.08)), (Lw, sL, aL, (0.8, 0.5, 0.25))):
        c, e1, e2 = M.tangent_frame(C)
        for lv in levels:
            dd = s_ * math.sqrt(2 * math.log(1 / lv))
            ds, pts = [], []
            for q in range(145):
                a = 2 * math.pi * q / 144
                d = (c + e1 * dd * math.cos(a) + e2 * dd * math.sin(a)).normalized()
                ds.append(d)
                pts.append(loc + d * (R + relief(d) + 0.006))
            px = M.px_world(pts[0])
            M.ribbon_bmesh(pts, ds, [0.5 * 2.6 * px] * len(pts), bm=bm)
    o = M.bm_to_obj(bm, 'isobars', M.coll('soft'), smooth=False)
    bm.free()
    M.assign(o, ink)
    o.visible_shadow = False
    # flat badges floating just above the hill top / basin centre, with a short hairline leader
    for (C, ch, bg, hgt) in ((H, '挤', P['bands'][8], 0.26), (Lw, '空', P['bands'][1], 0.30)):
        p_s = loc + C * (R + relief(C))
        p_b = p_s + Vector((0, 0, hgt))
        size = 0.15
        text_badge(theme, ch, p_b, size, '#fbf8f1', bg, face=cam_loc)
        a = p_b - Vector((0, 0, size * 1.02))
        b = p_s + Vector((0, 0, 0.01))
        _, _, back = cam_vectors()
        hw = 0.5 * 1.6 * M.px_world(a)
        lb = M.ribbon_bmesh([a, b], [back, back], [hw, hw])
        lo = M.bm_to_obj(lb, 'leader', M.coll('soft'), smooth=False)
        lb.free()
        M.assign(lo, M.flat_mat('leader_' + theme, P['ink'] if theme == 'day' else '#e8e0cc'))
        lo.visible_shadow = False
    cl = cloud(theme, 'drift_e', (up + Vector((0.82, 0.80, 0))).normalized(), 0.16, 0.50, cam_loc, radius=R, loc=loc,
               seed=4, upright=1.0)
    cl.visible_shadow = False
    ink_sets(theme, scale=1.1)
    save('tut_pres' + ('' if theme == 'day' else '_night'))


def tut_storm(theme='day'):
    """雨 = 风暴，锋线 = 风向刚变: a dark storm cloud with 12 neat rain strokes and one flat bolt over a territory;
    two separate fronts lie flat on territory borders — 若竹 semicircles (钱开始流入) and 臙脂 triangles (钱开始撤离),
    exactly the live planet's grammar."""
    R = 2.4
    cam_loc = Vector((0.0, -2.15, 2.75))
    cam = setup(CARD_W, CARD_H, theme, cam_loc, (0.08, 0.38, -0.25), lens=36, samples=40)
    P = M.PAL[theme]
    loc0 = Vector((0, 0, -R))
    S = screen_dir(0.36, 0.48, R, loc0)
    Wm = screen_dir(0.78, 0.40, R, loc0)
    rng = random.Random(4)

    def temp(c, i):
        return max(-2.4, min(2.4, 3.6 * (c.dot(Wm) - c.dot(S)) + rng.uniform(-0.4, 0.4)))

    seeds, ws = weighted_seeds(110, 23, wmax=0.06, iters=2)
    loc = loc0
    info = build_planet(theme, cam_loc, seeds, ws, temp, None, loc=loc, radius=R, line_px=1.5, outline_px=2.6,
                        step=0.010)
    sc = cloud(theme, 'storm', S, 0.34, 0.50, cam_loc, radius=R, loc=loc, storm=True, seed=7, upright=1.0)
    sc.visible_shadow = False          # its shadow read as a dark hole under the rain
    storm_kit(theme, sc)
    # fronts on two foreground territories (inflow: warm side; outflow: cool side)
    fin = info[cell_at(info, screen_dir(0.72, 0.14, R, loc))]
    fout = info[cell_at(info, screen_dir(0.16, 0.06, R, loc))]
    front_decal(theme, fin, 'in', loc, R, cam_loc, frac=0.50, sym_px=13, gap_px=40, line_px=3.4)
    front_decal(theme, fout, 'out', loc, R, cam_loc, frac=0.50, sym_px=13, gap_px=40, line_px=3.4)
    ink_sets(theme, scale=1.1)
    save('tut_storm' + ('' if theme == 'day' else '_night'))


def tut_season(theme='day'):
    """季节: four flat paper discs on a ring — 春 sprout → 夏 sun → 秋 maple → 冬 snowflake → back to 春."""
    cam_loc = Vector((0.0, -5.6, 3.9))
    cam = setup(CARD_W, CARD_H, theme, cam_loc, (0, 0.0, 0.22), lens=45, samples=40)
    P = M.PAL[theme]
    Rr = 1.55
    col = M.coll('fine')
    tints = {
        'sprout': M.mixs(P['bands'][4], P['inflow'], 0.30),
        'sun': P['bands'][5],
        'maple': M.mixs(P['bands'][4], P['bands'][7], 0.42),
        'snow': P['bands'][3],
    }
    order = ['sprout', 'sun', 'maple', 'snow']
    angles = [math.radians(a) for a in (180, 90, 0, -90)]      # 春 left, 夏 top(back), 秋 right, 冬 front
    for k, (kind, a) in enumerate(zip(order, angles)):
        cx, cy = Rr * math.cos(a), Rr * 0.72 * math.sin(a)
        m = M.toon_mat('disc_' + kind + theme, tints[kind], theme, rim=False, bands=2, t_shadow=0.035)
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=96, radius1=0.46, radius2=0.46, depth=0.012)
        disc = M.bm_to_obj(bm, 'disc', M.coll('fine'), smooth=False)
        bm.free()
        M.assign(disc, m)
        disc.location = (cx, cy, 0)
        gs = {'sprout': 0.40, 'sun': 0.32, 'maple': 0.34, 'snow': 0.28}[kind]
        g = glyph(kind, theme, col, size=gs, th=0.05, colour='#8fc4c9' if (kind == 'snow' and theme == 'night') else None)
        stand_up(g, (cx, cy, 0.01 + gs * 0.86), cam_loc, tilt=0.0)
    # ring arrows between discs (clockwise as seen from above: 春 → 夏 → 秋 → 冬)
    mat = M.toon_mat('ring_' + theme, P['chan'], theme, rim=False, t_shadow=-0.3, t_mid=0.1)
    for k in range(4):
        a0 = angles[k] - math.radians(24)
        a1 = angles[(k + 1) % 4] + math.radians(30)
        if a1 > a0:
            a1 -= 2 * math.pi
        pts = []
        for q in range(41):
            a = a0 + (a1 - a0) * q / 40
            pts.append(Vector((Rr * math.cos(a), Rr * 0.72 * math.sin(a), 0.03)))
        tube = M.curve_obj('ring', pts, bevel=0.02, collection=M.coll('chan'), res=3)
        M.assign(tube, mat)
        bm = M.extrude_outline(M.arrow_outline(), 0.06, axis='Z', bevel=0.0)
        head = M.bm_to_obj(bm, 'ring_head', M.coll('fine'), smooth=False)
        bm.free()
        M.assign(head, mat)
        t = (pts[-1] - pts[-3]).normalized()
        z = Vector((0, 0, 1))
        x = t.cross(z).normalized()
        rot = Matrix((x, -t, z)).transposed()
        head.matrix_world = Matrix.Translation(pts[-1]) @ rot.to_4x4() @ Matrix.Scale(0.17, 4)
    sets = [dict(name='chan', collection=M.coll('chan'), color=P['ink'], thickness=1.3, types=('silhouette', 'border'))]
    ink_sets(theme, scale=1.1, extra=sets)
    save('tut_season' + ('' if theme == 'day' else '_night'))


def tut_zoom(theme='day'):
    """点进去 = 飞进去: click a territory (ripple) and its own planet rises out of it; keep going down to a
    single stock. Big → medium → small planet on one diagonal, dashed flight paths between them."""
    cam_loc = Vector((0.0, -9.0, 1.2))
    cam = setup(CARD_W, CARD_H, theme, cam_loc, (0.0, 0, 0.0), lens=50, samples=40)
    rng = random.Random(2)
    big_loc, big_r = Vector((-2.15, 0.6, -1.25)), 1.75
    mid_loc, mid_r = Vector((0.75, -0.2, 0.42)), 0.62
    sml_loc, sml_r = Vector((2.35, -0.5, 1.12)), 0.27
    W1 = Vector((1, -0.3, 0.2)).normalized()

    def t1(c, i):
        return max(-2.5, min(2.5, 2.6 * c.dot(W1) - 0.6 + rng.uniform(-0.7, 0.7)))

    seeds, ws = weighted_seeds(30, 41, wmax=0.12, iters=1)
    pick_dir = Vector((0.55, -0.62, 0.55)).normalized()
    cells = M.sphere_voronoi(seeds, ws)
    ip = max(range(len(cells)), key=lambda k: cells[k][0].dot(pick_dir))
    info = build_planet(theme, cam_loc, seeds, ws, t1, None, loc=big_loc, radius=big_r,
                        overrides={ip: (2.8, 0.035)}, coll_name='planet', line_px=1.4, outline_px=2.6)
    picked = info[ip]
    ripple(theme, picked['c'], big_r, big_loc, rings=(0.16, 0.22, 0.28), lift=0.04)
    seeds2, ws2 = weighted_seeds(16, 43, wmax=0.12, iters=1)
    W2 = Vector((-0.6, -0.5, 0.5)).normalized()
    build_planet(theme, cam_loc, seeds2, ws2,
                 lambda c, i: max(-2.5, min(2.5, 2.4 * c.dot(W2) - 0.3 + rng.uniform(-0.7, 0.7))),
                 None, loc=mid_loc, radius=mid_r, coll_name='planet2', line_px=1.3, outline_px=2.4)
    seeds3, ws3 = weighted_seeds(9, 47, wmax=0.10, iters=1)
    W3 = Vector((0.6, -0.6, 0.4)).normalized()
    build_planet(theme, cam_loc, seeds3, ws3,
                 lambda c, i: max(-2.5, min(2.5, 2.6 * c.dot(W3) - 0.4 + rng.uniform(-0.6, 0.6))),
                 None, loc=sml_loc, radius=sml_r, coll_name='planet3', line_px=1.2, outline_px=2.2)
    # dashed flights: territory → medium planet → small planet
    p0 = big_loc + picked['c'] * big_r * 1.09
    p1 = mid_loc + (p0 - mid_loc).normalized() * mid_r * 1.25
    ctrl = (p0 + p1) / 2 + Vector((0, -0.3, 0.55))
    bez = [p0 * (1 - t) ** 2 + ctrl * 2 * t * (1 - t) + p1 * t * t for t in [q / 40 for q in range(41)]]
    dashed(theme, bez, dash=0.09, gap=0.07, r=0.016)
    q0 = mid_loc + Vector((0.55, -0.3, 0.55)).normalized() * mid_r * 1.12
    q1 = sml_loc + (q0 - sml_loc).normalized() * sml_r * 1.45
    ctrl2 = (q0 + q1) / 2 + Vector((0, -0.2, 0.32))
    bez2 = [q0 * (1 - t) ** 2 + ctrl2 * 2 * t * (1 - t) + q1 * t * t for t in [q / 30 for q in range(31)]]
    dashed(theme, bez2, dash=0.07, gap=0.055, r=0.012)
    cloud(theme, 'puff_d', Vector((-0.2, -0.5, 1)).normalized(), 0.10, 0.36, cam_loc, radius=big_r, loc=big_loc,
          seed=5, upright=0.8)
    ink_sets(theme, scale=1.1)
    save('tut_zoom' + ('' if theme == 'day' else '_night'))


SCENES = {
    'hero_day': lambda: hero('day'),
    'hero_night': lambda: hero('night'),
    'hero_day_cut': lambda: hero('day', True),
    'hero_night_cut': lambda: hero('night', True),
}
for _n, _f in (('tut_temp', tut_temp), ('tut_wind', tut_wind), ('tut_pres', tut_pres),
               ('tut_storm', tut_storm), ('tut_season', tut_season), ('tut_zoom', tut_zoom)):
    SCENES[_n] = (lambda f: (lambda: f('day')))(_f)
    SCENES[_n + '_night'] = (lambda f: (lambda: f('night')))(_f)

if __name__ == '__main__':
    want = M.arg_list() or list(SCENES)
    for n in want:
        SCENES[n]()
    # final pass with the system Python (palette PNG + WebP twin); falls back to the raw PNG if Pillow is missing
    import subprocess, shutil
    if os.environ.get('MW_NO_POST'):
        sys.exit(0)
    try:
        subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'post.py')] + want, check=True)
    except Exception as ex:
        print('post.py failed (%s) — copying raw renders' % ex)
        for n in want:
            shutil.copy(os.path.join(RAW, n + '.png'), os.path.join(OUT, n + '.png'))
