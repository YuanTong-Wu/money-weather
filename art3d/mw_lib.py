# mw_lib.py — shared helpers for the 钱的天气 Blender art workshop (DESIGN.md §17, §22).
# Imported by every art3d/*.py script. Blender 5.1, run headless:
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P art3d/<script>.py
#
# Look rules (§17): muted Japanese traditional palette, flat cel shading (2–3 bands, one crisp
# terminator), thin rim light, ink lines (Freestyle) — no glow, no bloom, no neon, no rainbow.
import bpy, bmesh, math, os, random, json, struct, sys
from mathutils import Vector, Matrix, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT3D = os.path.join(ROOT, 'web', 'assets', '3d')
SCRATCH = os.path.join(ROOT, '.scratch', 'art3d')
for _d in (OUT3D, SCRATCH):
    os.makedirs(_d, exist_ok=True)

# ----------------------------------------------------------------------------------- palette
# Same hex values as web/js/planet/theme.js so the 3D assets sit inside the 2D/3D app seamlessly.
PAL = {
    'day': dict(
        sky0='#f6f1e6', sky1='#ece4d3', ink='#1f2a44', paper='#fbf8f1', border='#fcf9f2',
        bands=['#263e63', '#33628a', '#5895ab', '#a4c8c2', '#ece2cb', '#f1cf8e', '#e9a643', '#d96f3c', '#b43d2c'],
        # hand-picked anime shadow per band (§17): ~12–18 % darker, a little MORE saturated, hue leaning to 藍 for
        # cool bands and to 弁柄 red for warm ones — never greyer, never violet. Same table as manifest.palette.
        band_shade=['#1a3053', '#234a73', '#3f7592', '#83aaa9', '#d3cbb1', '#e0ac68', '#d0862f', '#b5482a', '#922a22'],
        inflow='#4f8f5c', outflow='#a33d45', gold='#d9a23a',
        cloud='#ffffff', cloud_shade='#dfe4ec',
        storm='#8d96a7', storm_shade='#6c768a', storm_hi='#a9b1bf',
        bolt='#f2cf6b', bolt_shade='#d9a23a', bolt_line='#1f2a44',
        chan='#22304f', chan_case='#fbf8f1', planet_outline='#1f2a44',
        rain='#33507a', rim='#fffdf7', wind='#1f2a44', wind_a=0.58, halo='#fbf8f1', atmo='#b9d3d0',
        sea='#dde8e3', sea_shade='#c4d4d0', coast='#93a5ad',
    ),
    'night': dict(
        sky0='#1d2643', sky1='#121831', ink='#0d1226', paper='#1a2238', border='#d9d1bd',
        bands=['#1f3557', '#2b5579', '#41798f', '#7aa0a0', '#b4ac98', '#cdb07a', '#d2913e', '#c4603a', '#a33a2d'],
        band_shade=['#15284a', '#1e4368', '#2f5f7c', '#5e8689', '#9a937c', '#b8955a', '#b8742a', '#a4462a', '#86281f'],
        inflow='#7fbf8a', outflow='#e07c7f', gold='#e6b85a',
        cloud='#e9e6df', cloud_shade='#b9bdca',
        # storm body lifted (was #5d6680) so it separates from the navy/teal ground; lighter top lobes
        storm='#7a83a0', storm_shade='#5c6582', storm_hi='#98a0b8',
        bolt='#f2cf6b', bolt_shade='#c99630', bolt_line='#141a2e',
        chan='#f3ead6', chan_case='#141a2e', planet_outline='#9a958d',
        rain='#c4dcf0', rim='#faf0da', wind='#f6efe0', wind_a=0.82, halo='#141a2e',
        sea='#d0dad6', sea_shade='#aebdbb', coast='#8c9da5',
        atmo='#5f7f8f',
    ),
}

# ONE canonical key light for every asset (manifest.json "light_dir"): view space — +X right, +Y up, +Z toward
# the viewer (three.js camera space; Blender camera local space is the same). Upper-left and well off the view
# axis: the terminator crosses the continent as a crisp two-tone split, so the globe reads round (a light near
# the view axis flattens it into a disc). = planet3d/core.js LIGHT.
LIGHT_VIEW = (-0.62, 0.55, 0.28)


def view_light(cam=None):
    """canonical light → world direction (pointing TOWARD the light) for the scene camera."""
    cam = cam or bpy.context.scene.camera
    return (cam.matrix_world.to_3x3() @ Vector(LIGHT_VIEW)).normalized()


def hex2srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def l2s(c):
    c = max(0.0, c)
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def lin(h, a=1.0):
    """hex sRGB → linear RGBA tuple (Blender node colours are scene-linear)."""
    if isinstance(h, str):
        r, g, b = hex2srgb(h)
    else:
        r, g, b = h
    return (s2l(r), s2l(g), s2l(b), a)


def tint(h, mul):
    """multiply an sRGB hex colour by an sRGB-space multiplier → sRGB tuple."""
    r, g, b = hex2srgb(h) if isinstance(h, str) else h
    return (r * mul[0], g * mul[1], b * mul[2])


def shade_of(base, theme='day'):
    """anime shadow colour for any palette colour: the band table when it is a band, else the same rule
    (value −14 %, saturation +8 %, hue toward 藍 for cool colours / toward red for warm ones / toward a cool
    green-grey for cream). Never a grey multiply, never violet."""
    import colorsys
    P = PAL[theme]
    if isinstance(base, str):
        for i, b in enumerate(P['bands']):
            if b.lower() == base.lower():
                return hex2srgb(P['band_shade'][i])
        r, g, b = hex2srgb(base)
    else:
        r, g, b = base
    H, S, V = colorsys.rgb_to_hsv(r, g, b)
    Hd = H * 360
    if S < 0.06:
        tgt, amt = 214, 0          # white / grey: keep hue, just a cool value step
        return (r * 0.86, g * 0.875, b * 0.92)
    if S < 0.22 and 20 < Hd < 70:
        tgt, amt = 62, 10
    elif Hd < 60 or Hd > 330:
        tgt, amt = 4, 5
    else:
        tgt, amt = 214, 10
    d = ((tgt - Hd + 180) % 360) - 180
    Hd = (Hd + max(-amt, min(amt, d))) % 360
    S = min(1.0, S * 1.08 + 0.04)
    V = V * 0.86
    return colorsys.hsv_to_rgb(Hd / 360, S, V)


def mixs(a, b, t):
    a = hex2srgb(a) if isinstance(a, str) else a
    b = hex2srgb(b) if isinstance(b, str) else b
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


# ----------------------------------------------------------------------------------- node helpers
def SI(node, ident):
    return next(s for s in node.inputs if s.identifier == ident)


def SO(node, ident):
    return next(s for s in node.outputs if s.identifier == ident)


def _new_mat(name):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    mat.node_tree.nodes.clear()
    return mat


# ----------------------------------------------------------------------------------- scene
def reset(w=1200, h=700, transparent=True, samples=24):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = transparent
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'Standard'   # exact palette hex out, no filmic desaturation
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0
    sc.view_settings.gamma = 1
    sc.eevee.taa_render_samples = samples
    sc.eevee.use_shadows = True
    sc.eevee.shadow_ray_count = 1
    sc.eevee.shadow_step_count = 6
    sc.eevee.shadow_resolution_scale = 1.0
    world = bpy.data.worlds.new('world')
    sc.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs['Color'].default_value = (0, 0, 0, 1)
        bg.inputs['Strength'].default_value = 0.0
    return sc


def coll(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def mesh_obj(name, verts, faces, collection=None, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate()
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    return link(ob, collection)


def bm_to_obj(bm, name, collection=None, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    if smooth is not None:
        for p in me.polygons:
            p.use_smooth = smooth
    me.update()
    ob = bpy.data.objects.new(name, me)
    return link(ob, collection)


def look_rot(direction, up=Vector((0, 0, 1))):
    """rotation (Euler) so that an object's -Z axis points along `direction` (lamps, cameras)."""
    return Vector(direction).to_track_quat('-Z', 'Y').to_euler()


SUN_UNIT = 3.93     # Blender 5.1 EEVEE: Shader-to-RGB(white diffuse) = 0.254·cosθ per unit strength


def add_sun(direction, strength=SUN_UNIT, angle_deg=0.6, name='sun'):
    ld = bpy.data.lights.new(name, 'SUN')
    ld.energy = strength
    ld.angle = math.radians(angle_deg)
    ld.use_shadow = True
    try:
        ld.shadow_filter_radius = 0.5
        ld.shadow_maximum_resolution = 0.001
    except Exception:
        pass
    ob = bpy.data.objects.new(name, ld)
    ob.rotation_euler = look_rot(direction)
    return link(ob)


def add_camera(loc, target=(0, 0, 0), lens=50, ortho=None, name='cam', shift=(0, 0)):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_start, cd.clip_end = 0.05, 200
    cd.shift_x, cd.shift_y = shift
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    ob = bpy.data.objects.new(name, cd)
    ob.location = Vector(loc)
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    link(ob)
    bpy.context.scene.camera = ob
    return ob


# ----------------------------------------------------------------------------------- materials
_TOON_CACHE = {}


def toon_mat(name, base, theme='day', rim=True, shade=None, mid=None, bands=3,
             t_shadow=0.035, t_mid=0.30, rim_w=0.80, rim_strength=0.55, rim_col=None, fake_light=None):
    """Cel material (EEVEE): Diffuse → Shader-to-RGB → constant ramp of 2–3 flat colours → Emission.
    Exact palette colours come out (Standard view transform), shadows lean cool, a thin rim light."""
    key = (name, theme)
    if key in _TOON_CACHE:
        return _TOON_CACHE[key]
    P = PAL[theme]
    base_s = hex2srgb(base) if isinstance(base, str) else base
    shade_s = hex2srgb(shade) if isinstance(shade, str) else (shade or shade_of(base, theme))
    mid_s = hex2srgb(mid) if isinstance(mid, str) else (mid or mixs(base_s, shade_s, 0.45))
    mat = _new_mat(name)
    nt = mat.node_tree
    N = nt.nodes.new
    out = N('ShaderNodeOutputMaterial'); out.location = (900, 0)
    diff = N('ShaderNodeBsdfDiffuse'); diff.location = (-600, 0)
    diff.inputs['Color'].default_value = (1, 1, 1, 1)
    s2r = N('ShaderNodeShaderToRGB'); s2r.location = (-400, 0)
    ramp = N('ShaderNodeValToRGB'); ramp.location = (-200, 0)
    cr = ramp.color_ramp
    cr.interpolation = 'CONSTANT'
    # Shader-to-RGB is never < 0, so thresholds are clamped ≥ 0 (a negative stop would reorder the ramp);
    # explicit N·L (fake_light) runs −1…1, so its first stop sits at −1.
    lo = -1.0 if fake_light is not None else 0.0
    ts = max(t_shadow, lo + 0.0005)
    tm = max(t_mid, ts + 0.0005)
    cr.elements[0].position = lo
    cr.elements[0].color = lin(shade_s)
    if bands >= 3:
        cr.elements[1].position = ts
        cr.elements[1].color = lin(mid_s)
        e = cr.elements.new(tm)
        e.color = lin(base_s)
    else:
        cr.elements[1].position = ts
        cr.elements[1].color = lin(base_s)
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    if fake_light is not None:
        # N·L from the shading normal, no cast shadows (used for the paper borders between plates)
        geo = N('ShaderNodeNewGeometry')
        dot = N('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
        nt.links.new(geo.outputs['Normal'], dot.inputs[0])
        dot.inputs[1].default_value = tuple(Vector(fake_light).normalized())
        nt.links.new(dot.outputs['Value'], ramp.inputs['Fac'])
        nt.links.new(dot.outputs['Value'], s2r.inputs[0]) if False else None
    else:
        nt.links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    col_out = ramp.outputs['Color']
    if rim:
        lw = N('ShaderNodeLayerWeight'); lw.location = (-400, -260)
        lw.inputs['Blend'].default_value = 0.5
        rr = N('ShaderNodeValToRGB'); rr.location = (-200, -260)
        rr.color_ramp.interpolation = 'CONSTANT'
        rr.color_ramp.elements[0].color = (0, 0, 0, 1)
        rr.color_ramp.elements[1].position = rim_w
        rr.color_ramp.elements[1].color = (rim_strength,) * 3 + (1,)
        nt.links.new(lw.outputs['Facing'], rr.inputs['Fac'])
        # rim only where the surface is in shadow (a back-light edge, not a glassy halo)
        sh = N('ShaderNodeValToRGB'); sh.location = (-200, -480)
        sh.color_ramp.interpolation = 'CONSTANT'
        sh.color_ramp.elements[0].color = (1, 1, 1, 1)
        sh.color_ramp.elements[1].position = t_shadow
        sh.color_ramp.elements[1].color = (0, 0, 0, 1)
        nt.links.new(s2r.outputs['Color'], sh.inputs['Fac'])
        mul = N('ShaderNodeMath'); mul.location = (60, -300)
        mul.operation = 'MULTIPLY'
        nt.links.new(rr.outputs['Color'], mul.inputs[0])
        nt.links.new(sh.outputs['Color'], mul.inputs[1])
        mix = N('ShaderNodeMix'); mix.location = (300, 0)
        mix.data_type = 'RGBA'
        mix.blend_type = 'MIX'
        nt.links.new(mul.outputs[0], SI(mix, 'Factor_Float'))
        nt.links.new(col_out, SI(mix, 'A_Color'))
        SI(mix, 'B_Color').default_value = lin(rim_col or P['rim'])
        col_out = SO(mix, 'Result_Color')
    em = N('ShaderNodeEmission'); em.location = (600, 0)
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(col_out, em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    _TOON_CACHE[key] = mat
    return mat


def flat_mat(name, col, alpha=1.0, cull=False):
    """Unlit flat colour (ink hulls, wind lines, rain, backdrop shapes)."""
    mat = _new_mat(name)
    nt = mat.node_tree
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = lin(col)
    em.inputs['Strength'].default_value = 1.0
    if alpha < 1.0:
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        mx.inputs['Fac'].default_value = alpha
        nt.links.new(tr.outputs[0], mx.inputs[1])
        nt.links.new(em.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], out.inputs['Surface'])
        mat.surface_render_method = 'BLENDED'
    else:
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    mat.use_backface_culling = cull
    return mat


def unlit_export_mat(name, base, use_vcol=True, cull=True):
    """glTF-export material: Background shader → KHR_materials_unlit; base × COLOR_0 tone multiplier."""
    mat = _new_mat(name)
    nt = mat.node_tree
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bg = nt.nodes.new('ShaderNodeBackground')
    if use_vcol:
        ca = nt.nodes.new('ShaderNodeVertexColor')
        ca.layer_name = 'Col'
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        SI(mix, 'Factor_Float').default_value = 1.0
        SI(mix, 'B_Color').default_value = lin(base)
        nt.links.new(ca.outputs['Color'], SI(mix, 'A_Color'))
        nt.links.new(SO(mix, 'Result_Color'), bg.inputs['Color'])
    else:
        bg.inputs['Color'].default_value = lin(base)
    nt.links.new(bg.outputs[0], out.inputs['Surface'])
    mat.use_backface_culling = cull
    return mat


def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return ob


# ----------------------------------------------------------------------------------- Freestyle ink
def freestyle_setup(sets, crease_deg=134):
    """sets: list of dict(name, collection, color, thickness, types=('silhouette','border',...),
    calligraphy=(min,max) or None). One lineset per collection so each family has its own ink."""
    sc = bpy.context.scene
    sc.render.use_freestyle = True
    sc.render.line_thickness_mode = 'ABSOLUTE'
    sc.render.line_thickness = 1.0
    vl = sc.view_layers[0]
    vl.use_freestyle = True
    fs = vl.freestyle_settings
    fs.crease_angle = math.radians(crease_deg)
    fs.use_smoothness = True
    fs.as_render_pass = False
    for ls in list(fs.linesets):
        fs.linesets.remove(ls)
    for spec in sets:
        ls = fs.linesets.new(spec['name'])
        ls.select_by_visibility = True
        ls.visibility = 'VISIBLE'
        ls.select_by_edge_types = True
        ls.select_by_face_marks = False
        ls.select_by_collection = True
        ls.collection = spec['collection']
        types = spec.get('types', ('silhouette', 'border'))
        for t in ('silhouette', 'border', 'crease', 'ridge_valley', 'suggestive_contour',
                  'material_boundary', 'contour', 'external_contour', 'edge_mark'):
            setattr(ls, 'select_' + t, t in types)
        st = ls.linestyle
        st.color = lin(spec['color'])[:3]
        st.thickness = spec.get('thickness', 2.0)
        st.thickness_position = spec.get('position', 'CENTER')
        st.caps = 'ROUND'
        st.alpha = spec.get('alpha', 1.0)
        st.use_chaining = True
        st.chaining = 'PLAIN'
        st.use_same_object = True
        cal = spec.get('calligraphy')
        if cal:
            m = st.thickness_modifiers.new('cal', 'CALLIGRAPHY')
            m.orientation = 40
            m.thickness_min, m.thickness_max = cal
            m.blend = 'MIX'
            m.influence = 1.0
        if spec.get('taper'):
            m = st.thickness_modifiers.new('taper', 'ALONG_STROKE')
            m.blend = 'MULTIPLY'
            m.mapping = 'CURVE'
            cm = m.curve
            pts = cm.curves[0].points
            pts[0].location = (0.0, 0.35)
            pts[1].location = (1.0, 0.35)
            pts.new(0.12, 1.0)
            pts.new(0.88, 1.0)
            cm.update()
    return fs


# ----------------------------------------------------------------------------------- geometry
def fib_sphere(n, seed=0, jitter=0.25):
    rng = random.Random(seed)
    pts = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - 2 * (i + 0.5) / n
        r = math.sqrt(max(0.0, 1 - y * y))
        th = ga * i + rng.uniform(-jitter, jitter)
        v = Vector((math.cos(th) * r, math.sin(th) * r, y))
        v += Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))) * (jitter / math.sqrt(n))
        pts.append(v.normalized())
    return pts


def tangent_frame(c):
    c = Vector(c).normalized()
    e1 = c.orthogonal().normalized()
    e2 = c.cross(e1).normalized()
    return c, e1, e2


def sphere_voronoi(seeds, weights=None):
    """Spherical Voronoi via convex hull (Delaunay) → list of (centre, [cell vertices CCW from outside]).
    weights (≥0, ~0…0.3) lift seeds off the sphere → a spherical power diagram: bigger weight = bigger cell
    (like the app's weighted Voronoi, area ∝ sqrt(dv20)). Seeds swallowed by the hull get no cell."""
    bm = bmesh.new()
    vs = [bm.verts.new(Vector(s).normalized() * (1 + (weights[i] if weights else 0))) for i, s in enumerate(seeds)]
    bmesh.ops.convex_hull(bm, input=vs)
    cells = []
    for v in vs:
        if not v.is_valid or not v.link_faces:
            continue
        c, e1, e2 = tangent_frame(v.co)
        cc = []
        for f in v.link_faces:
            p = [x.co for x in f.verts]
            n = (p[1] - p[0]).cross(p[2] - p[0]).normalized()
            if n.dot(p[0]) < 0:
                n = -n
            cc.append(n)
        cc.sort(key=lambda q: math.atan2(q.dot(e2), q.dot(e1)))
        # centre = normalised mean of the cell corners (the seed may sit off-centre in a power cell)
        m = Vector((0, 0, 0))
        for q in cc:
            m += q
        cells.append((m.normalized() if m.length > 1e-6 else c, cc))
    bm.free()
    return cells


def random_sphere(n, seed=0):
    rng = random.Random(seed)
    pts = []
    while len(pts) < n:
        v = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)))
        if v.length > 1e-6:
            pts.append(v.normalized())
    return pts


def lloyd(seeds, iters=3):
    for _ in range(iters):
        cells = sphere_voronoi(seeds)
        seeds = []
        for c, poly in cells:
            s = Vector((0, 0, 0))
            for p in poly:
                s += p
            seeds.append(s.normalized() if s.length > 1e-6 else c)
    return seeds


def _clip_halfplane(poly, n, d):
    """keep points p with n·p >= d (Sutherland–Hodgman, 2D tuples)."""
    out = []
    L = len(poly)
    for i in range(L):
        a, b = poly[i], poly[(i + 1) % L]
        da = n[0] * a[0] + n[1] * a[1] - d
        db = n[0] * b[0] + n[1] * b[1] - d
        if da >= 0:
            out.append(a)
        if (da >= 0) != (db >= 0):
            t = da / (da - db)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def inset_convex(poly, d):
    """inset a CCW convex polygon by distance d (half-plane intersection, robust to short edges)."""
    res = list(poly)
    L = len(poly)
    for i in range(L):
        a, b = poly[i], poly[(i + 1) % L]
        ex, ey = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(ex, ey)
        if ln < 1e-9:
            continue
        n = (-ey / ln, ex / ln)              # inward normal for CCW
        res = _clip_halfplane(res, n, n[0] * a[0] + n[1] * a[1] + d)
        if len(res) < 3:
            return []
    return res


def round_convex(poly, r, seg=5):
    """outset convex polygon by r with round joins → smooth rounded polygon."""
    out = []
    L = len(poly)
    for i in range(L):
        p0, p1, p2 = poly[i - 1], poly[i], poly[(i + 1) % L]
        a0 = math.atan2(-(p1[0] - p0[0]), (p1[1] - p0[1]))      # outward normal of edge p0→p1
        a1 = math.atan2(-(p2[0] - p1[0]), (p2[1] - p1[1]))      # outward normal of edge p1→p2
        while a1 < a0:
            a1 += 2 * math.pi
        if a1 - a0 > math.pi:
            a1 -= 2 * math.pi
        n = max(1, int(seg * abs(a1 - a0) / (math.pi / 2)) + 1)
        for k in range(n + 1):
            a = a0 + (a1 - a0) * k / n
            out.append((p1[0] + r * math.cos(a), p1[1] + r * math.sin(a)))
    # dedupe close points
    ded = []
    for p in out:
        if not ded or math.hypot(p[0] - ded[-1][0], p[1] - ded[-1][1]) > 1e-5:
            ded.append(p)
    return ded


def resample_closed(poly, step):
    out = []
    L = len(poly)
    for i in range(L):
        a, b = poly[i], poly[(i + 1) % L]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(ln / step))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def cell_outline_2d(c, poly, gap=0.012, rr=0.03):
    """cell polygon (on unit sphere) → rounded, inset outline in the gnomonic tangent plane at c."""
    c, e1, e2 = tangent_frame(c)
    P2 = []
    for v in poly:
        q = v / v.dot(c)
        P2.append((q.dot(e1), q.dot(e2)))
    q = inset_convex(P2, gap + rr)
    if len(q) < 3:
        q = inset_convex(P2, gap)
        if len(q) < 3:
            return None, (c, e1, e2)
        return q, (c, e1, e2)
    return round_convex(q, rr), (c, e1, e2)


def plate_bmesh(frame, outline, top_r, bot_r=0.985, rings=5, step=0.02, scale=1.0):
    """a raised paper-cut plate on the sphere: smooth curved top + vertical walls (separate verts)."""
    c, e1, e2 = frame
    B = resample_closed(outline, step)
    ox = sum(p[0] for p in B) / len(B)
    oy = sum(p[1] for p in B) / len(B)
    bm = bmesh.new()

    def P(x, y, r):
        return (c + e1 * x + e2 * y).normalized() * r * scale

    rings_v = []
    for j in range(1, rings + 1):
        t = j / rings
        t = 1 - (1 - t) ** 1.35        # denser near the edge (curvature + crisp rim)
        rings_v.append([bm.verts.new(P(ox + (x - ox) * t, oy + (y - oy) * t, top_r)) for x, y in B])
    cv = bm.verts.new(P(ox, oy, top_r))
    M = len(B)
    top_faces = []
    for i in range(M):
        top_faces.append(bm.faces.new((cv, rings_v[0][i], rings_v[0][(i + 1) % M])))
    for j in range(rings - 1):
        A, Bn = rings_v[j], rings_v[j + 1]
        for i in range(M):
            top_faces.append(bm.faces.new((A[i], Bn[i], Bn[(i + 1) % M], A[(i + 1) % M])))
    # walls (own verts → crisp edge, no smoothing across)
    wt = [bm.verts.new(P(x, y, top_r)) for x, y in B]
    wb = [bm.verts.new(P(x, y, bot_r)) for x, y in B]
    wall_faces = []
    for i in range(M):
        k = (i + 1) % M
        wall_faces.append(bm.faces.new((wb[i], wb[k], wt[k], wt[i])))
    bm.normal_update()
    # outward check
    f0 = top_faces[0]
    if f0.normal.dot(f0.calc_center_median()) < 0:
        bmesh.ops.reverse_faces(bm, faces=top_faces)
    fw = wall_faces[0]
    cen = fw.calc_center_median()
    if fw.normal.dot(cen - c * cen.dot(c)) < 0:
        bmesh.ops.reverse_faces(bm, faces=wall_faces)
    for f in top_faces:
        f.smooth = True
        f.material_index = 0
    for f in wall_faces:
        f.smooth = False
        f.material_index = 1
    return bm


def slerp(a, b, t):
    a, b = Vector(a).normalized(), Vector(b).normalized()
    om = math.acos(max(-1.0, min(1.0, a.dot(b))))
    if om < 1e-6:
        return a.copy()
    so = math.sin(om)
    return (a * math.sin((1 - t) * om) + b * math.sin(t * om)) / so


def sph(lat, lon):
    """unit vector from latitude/longitude in degrees; lon 0 faces the camera (−Y), +lon to the right."""
    la, lo = math.radians(lat), math.radians(lon)
    return Vector((math.cos(la) * math.sin(lo), -math.cos(la) * math.cos(lo), math.sin(la)))


def curve_obj(name, pts, bevel=0.01, radii=None, collection=None, res=2, caps=True):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = bevel
    cu.bevel_resolution = 4
    cu.resolution_u = res
    cu.use_fill_caps = caps
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p[0], p[1], p[2], 1)
        if radii:
            sp.points[i].radius = radii[i]
    ob = bpy.data.objects.new(name, cu)
    return link(ob, collection)


def to_mesh_obj(ob, name=None):
    """evaluate any object (curve/text/metaball/modifiers) into a plain mesh object in place."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    new = bpy.data.objects.new(name or ob.name, me)
    new.matrix_world = ob.matrix_world.copy()
    cols = ob.users_collection
    for c in cols:
        c.objects.link(new)
    bpy.data.objects.remove(ob, do_unlink=True)
    return new


# ----------------------------------------------------------------------------------- clouds
CLOUD_SPECS = {
    # lobes (x, y, z, r); base plane z=0, width ≈ 2. Lobes stay distinct (anime cumulus), not a merged blob.
    'cumulus_a': [(-0.66, 0.00, 0.10, 0.28), (-0.30, 0.04, 0.30, 0.38), (0.14, -0.02, 0.40, 0.46),
                  (0.56, 0.03, 0.22, 0.34), (0.86, 0.00, 0.06, 0.22), (0.02, 0.22, 0.24, 0.38),
                  (-0.08, -0.20, 0.08, 0.30)],
    'stratus_b': [(-1.02, 0.00, 0.04, 0.17), (-0.72, 0.03, 0.10, 0.23), (-0.38, -0.02, 0.15, 0.27),
                  (0.00, 0.02, 0.17, 0.29), (0.38, -0.02, 0.13, 0.26), (0.70, 0.02, 0.08, 0.22),
                  (0.98, 0.00, 0.03, 0.16), (-0.18, 0.16, 0.08, 0.24), (0.30, 0.15, 0.06, 0.22)],
    'tower_c': [(-0.46, 0.00, 0.08, 0.26), (-0.06, 0.02, 0.20, 0.40), (0.40, -0.02, 0.10, 0.30),
                (-0.16, 0.00, 0.58, 0.32), (0.18, 0.02, 0.50, 0.30), (0.02, -0.02, 0.86, 0.27),
                (0.70, 0.00, 0.02, 0.18), (0.04, 0.20, 0.30, 0.34)],
    'puff_d': [(-0.36, 0.00, 0.10, 0.30), (0.10, 0.02, 0.24, 0.42), (0.52, -0.02, 0.08, 0.28),
               (0.06, 0.18, 0.10, 0.30)],
    'drift_e': [(-0.92, 0.00, 0.03, 0.16), (-0.64, 0.02, 0.10, 0.24), (-0.26, -0.02, 0.22, 0.34),
                (0.20, 0.02, 0.32, 0.40), (0.62, -0.02, 0.18, 0.30), (0.92, 0.00, 0.06, 0.20),
                (0.04, 0.20, 0.14, 0.32), (-0.40, -0.16, 0.04, 0.22)],
    'storm': [(-1.14, 0.00, 0.08, 0.28), (-0.76, 0.02, 0.26, 0.42), (-0.24, 0.00, 0.42, 0.54),
              (0.36, -0.02, 0.38, 0.50), (0.88, 0.02, 0.20, 0.38), (1.18, 0.00, 0.05, 0.24),
              (-0.40, 0.00, 0.80, 0.36), (0.12, 0.02, 0.90, 0.40), (0.56, 0.00, 0.70, 0.30),
              (0.00, 0.26, 0.30, 0.52), (0.10, -0.24, 0.10, 0.36), (-0.70, -0.16, 0.06, 0.28)],
}


def cloud_bmesh(kind, seg=16, rings=9, depth_scale=0.78, cut=0.0, seed=0, cull=True, adaptive=False):
    """overlapping lobes, each a UV sphere clipped flat at the base plane (cartoon cumulus).
    Lobes stay separate shells (crisp notches + inner lobe lines); faces buried inside other lobes are
    dropped (they can never be seen). Returns a bmesh with base at z=0, centred on x/y."""
    bm = bmesh.new()
    lid = bm.faces.layers.int.new('lobe')
    rng = random.Random(seed)
    lobes = []
    spec = CLOUD_SPECS[kind]
    rmax = max(r for *_, r in spec)
    for k, (x, y, z, r) in enumerate(spec):
        r *= 1 + rng.uniform(-0.02, 0.02)
        c = Vector((x, y * depth_scale, z))
        lobes.append((c, r))
        sg, rg = seg, rings
        if adaptive:
            f = max(0.62, (r / rmax) ** 0.6)
            sg, rg = max(10, int(round(seg * f))), max(6, int(round(rings * f)))
        lob = bmesh.new()
        bmesh.ops.create_uvsphere(lob, u_segments=sg, v_segments=rg, radius=r)
        bmesh.ops.rotate(lob, verts=lob.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rng.uniform(0, 6.28), 3, 'Z'))
        for v in lob.verts:
            v.co.y *= depth_scale
            v.co += c
        if z - r < cut:
            res = bmesh.ops.bisect_plane(lob, geom=lob.verts[:] + lob.edges[:] + lob.faces[:],
                                         plane_co=(0, 0, cut), plane_no=(0, 0, 1), clear_inner=True)
            cut_edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
            if cut_edges:
                bmesh.ops.holes_fill(lob, edges=cut_edges, sides=0)
        bmesh.ops.triangulate(lob, faces=lob.faces)
        me = bpy.data.meshes.new('lobe')
        lob.to_mesh(me)
        lob.free()
        n0 = len(bm.faces)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        bm.faces.ensure_lookup_table()
        for i in range(n0, len(bm.faces)):
            bm.faces[i][lid] = k
    bm.normal_update()

    def inside(p, k, margin=0.015):
        if p.z <= cut + margin:
            return False
        for j, (c, r) in enumerate(lobes):
            if j == k:
                continue
            d = p - c
            if (d.x / r) ** 2 + (d.y / (r * depth_scale)) ** 2 + (d.z / r) ** 2 < (1 - margin / r) ** 2:
                return True
        return False

    if cull:
        dead = [f for f in bm.faces if all(inside(v.co, f[lid]) for v in f.verts)]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    off = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, 0))
    for v in bm.verts:
        v.co -= off
    bm.normal_update()
    return bm


def cloud_obj(kind, name, collection=None, scale=1.0, seg=40, rings=22, seed=0):
    bm = cloud_bmesh(kind, seg=seg, rings=rings, seed=seed)
    for f in bm.faces:
        f.smooth = abs(f.normal.z) < 0.999 or f.normal.z > 0
    ob = bm_to_obj(bm, name, collection, smooth=True)
    bm.free()
    ob.scale = (scale, scale, scale)
    return ob


def place_on_sphere(ob, direction, alt, radius=1.0, spin=0.0, up_hint=Vector((0, 0, 1)), face=None, upright=0.0):
    """put an object above the sphere surface at `direction`, local +Z along the surface normal.
    `face`: optional camera position — rotate about the normal so local −Y faces the camera."""
    n0 = Vector(direction).normalized()
    ob.location = n0 * (radius + alt)
    n = n0.lerp(Vector(up_hint), upright).normalized()
    q = Vector((0, 0, 1)).rotation_difference(n)
    if face is not None:
        fwd = Vector(face) - ob.location
        fwd = (fwd - n * fwd.dot(n)).normalized()
        ly = q @ Vector((0, -1, 0))
        ang = math.atan2(n.dot(ly.cross(fwd)), ly.dot(fwd))
        q = Quaternion(n, ang) @ q
    q = Quaternion(n, spin) @ q
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = q
    return ob


# ----------------------------------------------------------------------------------- symbol shapes
def bolt_outline():
    """classic crisp zig-zag bolt (one stroke, §17), top at y=0, pointing down, height 1."""
    return [(0.10, 0.0), (0.34, 0.0), (0.16, -0.38), (0.36, -0.38), (-0.12, -1.0),
            (0.02, -0.52), (-0.18, -0.52), (0.10, 0.0)][:-1]


def arrow_outline():
    """主航道 arrow head, pointing −Y (glTF +Z), base at origin: a dart with a shallow notch."""
    return [(0.0, -1.0), (0.52, 0.0), (0.0, -0.22), (-0.52, 0.0)]


def extrude_outline(outline, thick, axis='Z', bevel=0.0, name='ext', collection=None, mat_faces=None):
    """extrude a 2D outline (list of (x,y), CCW or CW) into a prism; axis = thickness axis.
    Returns bmesh with face layer tags: 'front' / 'back' / 'side'."""
    bm = bmesh.new()
    tag = bm.faces.layers.int.new('tag')
    pts = outline
    # ensure CCW
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    if area < 0:
        pts = pts[::-1]

    def V(x, y, z):
        if axis == 'Z':
            return Vector((x, y, z))
        return Vector((x, z, y))     # axis == 'Y': outline in XZ plane, thickness along Y

    top = [bm.verts.new(V(x, y, thick / 2)) for x, y in pts]
    bot = [bm.verts.new(V(x, y, -thick / 2)) for x, y in pts]
    ftop = bm.faces.new(top)
    fbot = bm.faces.new(bot[::-1])
    sides = []
    n = len(pts)
    for i in range(n):
        k = (i + 1) % n
        sides.append(bm.faces.new((bot[i], bot[k], top[k], top[i])))
    bm.normal_update()
    ftop[tag] = 1
    fbot[tag] = 2
    for f in sides:
        f[tag] = 3
    if bevel > 0:
        edges = [e for e in bm.edges if any(f[tag] in (1, 2) for f in e.link_faces) and len(e.link_faces) == 2]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=1, profile=0.5, affect='EDGES')
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    return bm


# ----------------------------------------------------------------------------------- glb export
def export_glb(objs, path):
    sc = bpy.context.scene
    for o in sc.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_vertex_color='ACTIVE', export_texcoords=False, export_normals=True,
                              export_apply=True, export_yup=True, export_extras=False,
                              export_cameras=False, export_lights=False, export_animations=False)
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    return len(b), j


def tone_cut(bm, L, t, layer_val=None, normal_fn=None):
    """split mesh faces along the iso-line n·L = t (smooth vertex normals, or normal_fn(v) — e.g. each cloud
    lobe's own analytic sphere normal) so a 2-tone split is a clean curve, then return {face: lit_bool}."""
    bm.normal_update()
    L = Vector(L).normalized()
    nrm = {v: (normal_fn(v) if normal_fn else v.normal.copy()) for v in bm.verts}
    val = {v: nrm[v].dot(L) - t for v in bm.verts}
    for v in list(val):
        if abs(val[v]) < 1e-4:
            val[v] = 1e-4
    newv = set()
    for e in [e for e in bm.edges if (val[e.verts[0]] > 0) != (val[e.verts[1]] > 0)]:
        a, b = e.verts
        fa, fb = val[a], val[b]
        fac = fa / (fa - fb)
        na, nb = nrm[a], nrm[b]
        _, nv = bmesh.utils.edge_split(e, a, fac)
        nrm[nv] = na.lerp(nb, fac).normalized()
        val[nv] = 0.0
        newv.add(nv)
    for f in list(bm.faces):
        iso = [v for v in f.verts if v in newv]
        if len(iso) == 2:
            a, b = iso
            # skip if already adjacent
            if any(b in e.verts for e in a.link_edges if e in f.edges):
                continue
            try:
                bmesh.utils.face_split(f, a, b)
            except Exception:
                pass
    bmesh.ops.triangulate(bm, faces=bm.faces)
    lit = {}
    for f in bm.faces:
        vs = [val[v] for v in f.verts if val.get(v, 0) != 0.0]
        lit[f] = (sum(vs) / len(vs) > 0) if vs else True
    return lit, nrm


def hull_bmesh(bm_src, width):
    """inverted-hull ink outline: push along normals, reverse winding (single-sided material)."""
    bm = bm_src.copy()
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * width
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.normal_update()
    return bm


def set_corner_colors(me, colors_per_poly, name='Col'):
    attr = me.color_attributes.new(name, 'FLOAT_COLOR', 'CORNER')
    for p in me.polygons:
        c = colors_per_poly[p.index]
        for li in p.loop_indices:
            attr.data[li].color = c
    me.color_attributes.active_color = attr
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:
        pass
    return attr


# ----------------------------------------------------------------------------------- render
def render(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def world_to_px(co):
    from bpy_extras.object_utils import world_to_camera_view
    sc = bpy.context.scene
    v = world_to_camera_view(sc, sc.camera, Vector(co))
    return (v.x * sc.render.resolution_x, (1 - v.y) * sc.render.resolution_y)


def arg_list():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def backdrop(cam, top_hex, bottom_hex, dist=60.0, mid=None, name='backdrop'):
    """camera-parented emission card: vertical paper-sky gradient (exact hex, no lighting, no shadows)."""
    sc = bpy.context.scene
    cd = cam.data
    w = sc.render.resolution_x
    h = sc.render.resolution_y
    if cd.type == 'ORTHO':
        fw = cd.ortho_scale
    else:
        fw = 2 * dist * math.tan(cd.angle / 2)
    fh = fw * h / w if w >= h else fw
    if w < h:
        fw = fw * w / h
    pad = 1.3
    verts = [(-fw / 2 * pad, -fh / 2 * pad, -dist), (fw / 2 * pad, -fh / 2 * pad, -dist),
             (fw / 2 * pad, fh / 2 * pad, -dist), (-fw / 2 * pad, fh / 2 * pad, -dist)]
    ob = mesh_obj(name, verts, [(0, 1, 2, 3)])
    ob.parent = cam
    sx, sy = cd.shift_x * (fw if w >= h else fh), cd.shift_y * (fw if w >= h else fh)
    ob.location = (sx, sy, 0)
    me = ob.data
    uv = me.uv_layers.new(name='UV')
    for li, l in enumerate(me.loops):
        co = me.vertices[l.vertex_index].co
        uv.data[li].uv = (co.x / (fw * pad) + 0.5, co.y / (fh * pad) + 0.5)
    mat = _new_mat(name + '_mat')
    nt = mat.node_tree
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(tc.outputs['UV'], sep.inputs[0])
    nt.links.new(sep.outputs['Y'], ramp.inputs['Fac'])
    cr = ramp.color_ramp
    lo, hi = 0.5 - 0.5 / pad, 0.5 + 0.5 / pad
    cr.elements[0].position = lo
    cr.elements[0].color = lin(bottom_hex)
    cr.elements[1].position = hi
    cr.elements[1].color = lin(top_hex)
    if mid:
        e = cr.elements.new(0.5)
        e.color = lin(mid)
    nt.links.new(ramp.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    assign(ob, mat)
    ob.visible_shadow = False
    return ob


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def hull_sphere(radius, ink_hex, loc=(0, 0, 0), name='outline', collection=None, seg=128):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=radius)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    ob = bm_to_obj(bm, name, collection, smooth=True)
    bm.free()
    ob.location = loc
    assign(ob, flat_mat(name + '_mat', ink_hex, cull=True))
    ob.visible_shadow = False
    return ob


def uv_sphere(radius, name, collection=None, seg=96, loc=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=radius)
    ob = bm_to_obj(bm, name, collection, smooth=True)
    bm.free()
    ob.location = loc
    return ob


# ----------------------------------------------------------------------------------- temperature field
BAND_EDGES = [-2.6, -1.8, -1.05, -0.4, 0.4, 1.05, 1.8, 2.6]      # = planet/theme.js


def field_toon_mat(name, theme, centres_temps, sharp=22.0, warp=0.06, warp_scale=2.2, rim=True,
                   t_shadow=0.035, t_mid=0.30, rim_w=0.80, rim_strength=0.55, override=None):
    """Toon material whose base colour is the app's temperature field: inverse-distance (gaussian) blend of
    territory temperatures on the sphere, cut into the 9 flat isotherm bands (藍 → 朱). Uses object-space
    direction, so every plate + the base share one continuous field. override: (lo, hi, hex) extra band."""
    P = PAL[theme]
    mat = _new_mat(name)
    nt = mat.node_tree
    N = nt.nodes.new
    L = nt.links.new
    out = N('ShaderNodeOutputMaterial')
    tc = N('ShaderNodeTexCoord')
    nrm = N('ShaderNodeVectorMath'); nrm.operation = 'NORMALIZE'
    L(tc.outputs['Object'], nrm.inputs[0])
    p = nrm.outputs[0]
    if warp > 0:
        nz = N('ShaderNodeTexNoise')
        nz.inputs['Scale'].default_value = warp_scale
        nz.inputs['Detail'].default_value = 1.0
        L(p, nz.inputs['Vector'])
        sub = N('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'
        L(nz.outputs['Color'], sub.inputs[0])
        sub.inputs[1].default_value = (0.5, 0.5, 0.5)
        sc = N('ShaderNodeVectorMath'); sc.operation = 'SCALE'
        L(sub.outputs[0], sc.inputs[0])
        sc.inputs['Scale'].default_value = warp * 2
        add = N('ShaderNodeVectorMath'); add.operation = 'ADD'
        L(p, add.inputs[0]); L(sc.outputs[0], add.inputs[1])
        n2 = N('ShaderNodeVectorMath'); n2.operation = 'NORMALIZE'
        L(add.outputs[0], n2.inputs[0])
        p = n2.outputs[0]
    num = den = None
    for (c, t) in centres_temps:
        d = N('ShaderNodeVectorMath'); d.operation = 'DOT_PRODUCT'
        L(p, d.inputs[0]); d.inputs[1].default_value = tuple(Vector(c).normalized())
        e = N('ShaderNodeMath'); e.operation = 'MULTIPLY_ADD'
        L(d.outputs['Value'], e.inputs[0]); e.inputs[1].default_value = sharp; e.inputs[2].default_value = -sharp
        w = N('ShaderNodeMath'); w.operation = 'EXPONENT'
        L(e.outputs[0], w.inputs[0])
        wt = N('ShaderNodeMath'); wt.operation = 'MULTIPLY'
        L(w.outputs[0], wt.inputs[0]); wt.inputs[1].default_value = float(t)
        if num is None:
            num, den = wt.outputs[0], w.outputs[0]
        else:
            a1 = N('ShaderNodeMath'); a1.operation = 'ADD'
            L(num, a1.inputs[0]); L(wt.outputs[0], a1.inputs[1]); num = a1.outputs[0]
            a2 = N('ShaderNodeMath'); a2.operation = 'ADD'
            L(den, a2.inputs[0]); L(w.outputs[0], a2.inputs[1]); den = a2.outputs[0]
    dv = N('ShaderNodeMath'); dv.operation = 'DIVIDE'
    L(num, dv.inputs[0]); L(den, dv.inputs[1])
    fac = N('ShaderNodeMath'); fac.operation = 'MULTIPLY_ADD'
    L(dv.outputs[0], fac.inputs[0]); fac.inputs[1].default_value = 1 / 6; fac.inputs[2].default_value = 0.5
    pos = [0.0] + [(e + 3) / 6 for e in BAND_EDGES]

    def band_ramp(cols):
        ramp = N('ShaderNodeValToRGB')
        cr = ramp.color_ramp
        cr.interpolation = 'CONSTANT'
        cr.elements[0].position = 0.0
        cr.elements[0].color = lin(cols[0])
        cr.elements[1].position = pos[1]
        cr.elements[1].color = lin(cols[1])
        for k in range(2, 9):
            el = cr.elements.new(pos[k])
            el.color = lin(cols[k])
        L(fac.outputs[0], ramp.inputs['Fac'])
        return ramp.outputs['Color']
    lit_c = band_ramp(P['bands'])
    shd_c = band_ramp(P['band_shade'])          # hand-picked shadow table, not a grey multiply
    diff = N('ShaderNodeBsdfDiffuse'); diff.inputs['Color'].default_value = (1, 1, 1, 1)
    s2r = N('ShaderNodeShaderToRGB')
    L(diff.outputs[0], s2r.inputs[0])
    step = N('ShaderNodeMath'); step.operation = 'GREATER_THAN'
    L(s2r.outputs['Color'], step.inputs[0]); step.inputs[1].default_value = t_shadow
    mx0 = N('ShaderNodeMix'); mx0.data_type = 'RGBA'; mx0.blend_type = 'MIX'
    L(step.outputs[0], SI(mx0, 'Factor_Float'))
    L(shd_c, SI(mx0, 'A_Color')); L(lit_c, SI(mx0, 'B_Color'))
    col_out = SO(mx0, 'Result_Color')
    if rim:
        lw = N('ShaderNodeLayerWeight'); lw.inputs['Blend'].default_value = 0.5
        rr = N('ShaderNodeValToRGB'); rr.color_ramp.interpolation = 'CONSTANT'
        rr.color_ramp.elements[0].color = (0, 0, 0, 1)
        rr.color_ramp.elements[1].position = rim_w
        rr.color_ramp.elements[1].color = (rim_strength,) * 3 + (1,)
        L(lw.outputs['Facing'], rr.inputs['Fac'])
        sh = N('ShaderNodeValToRGB'); sh.color_ramp.interpolation = 'CONSTANT'
        sh.color_ramp.elements[0].color = (1, 1, 1, 1)
        sh.color_ramp.elements[1].position = t_shadow
        sh.color_ramp.elements[1].color = (0, 0, 0, 1)
        L(s2r.outputs['Color'], sh.inputs['Fac'])
        m2 = N('ShaderNodeMath'); m2.operation = 'MULTIPLY'
        L(rr.outputs['Color'], m2.inputs[0]); L(sh.outputs['Color'], m2.inputs[1])
        mix = N('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MIX'
        L(m2.outputs[0], SI(mix, 'Factor_Float'))
        L(col_out, SI(mix, 'A_Color'))
        SI(mix, 'B_Color').default_value = lin(P['rim'])
        col_out = SO(mix, 'Result_Color')
    em = N('ShaderNodeEmission')
    L(col_out, em.inputs['Color'])
    L(em.outputs[0], out.inputs['Surface'])
    return mat


# ----------------------------------------------------------------------------------- flat plates & ribbons (v2)
def px_world(p, cam=None):
    """world size of one output pixel at point p (perspective camera, landscape frame)."""
    sc = bpy.context.scene
    cam = cam or sc.camera
    fwd = -(cam.matrix_world.to_3x3() @ Vector((0, 0, 1)))
    depth = max(0.05, (Vector(p) - cam.matrix_world.translation).dot(fwd))
    if cam.data.type == 'ORTHO':
        return cam.data.ortho_scale / sc.render.resolution_x
    return 2 * depth * math.tan(cam.data.angle / 2) / max(sc.render.resolution_x, sc.render.resolution_y)


def wobble_cells(cells, amp=0.03, freq=3.2, step=0.02, seed=0):
    """soft paper-cut borders (the live layout's coastline wobble, on the sphere): every cell edge is densified and
    pushed sideways by a smooth position-only noise field, so shared borders stay shared (no gaps), straight
    Voronoi edges become gentle curves and the planet stops reading as a soccer ball. Centres are unchanged."""
    from mathutils import noise
    off = Vector((1.7 * seed + 0.3, -2.3 * seed + 1.1, 0.9 * seed - 0.7))
    key = lambda v: (round(v.x, 6), round(v.y, 6), round(v.z, 6))
    cache = {}

    def disp(d):
        k = key(d)
        if k in cache:
            return cache[k]
        q = Vector(d).normalized()
        v = (noise.noise_vector(q * freq + off) + noise.noise_vector(q * freq * 2.3 - off * 1.3) * 0.45
             + noise.noise_vector(q * freq * 5.1 + off * 0.7) * 0.2)
        v = v - q * q.dot(v)
        cache[k] = (q + v * amp).normalized()
        return cache[k]

    out = []
    for c, poly in cells:
        P = []
        for k in range(len(poly)):
            a, b = Vector(poly[k]).normalized(), Vector(poly[(k + 1) % len(poly)]).normalized()
            if key(a) <= key(b):
                pts = arc_samples(a, b, step)
            else:                                  # same samples whichever cell walks the edge
                pts = list(reversed(arc_samples(b, a, step) + [a]))[:-1]
            P += [disp(p) for p in pts]
        out.append((c, P, poly))
    return out


def arc_samples(a, b, step=0.012):
    """great-circle samples a→b (excluding b); identical points whichever cell walks the edge."""
    ang = math.acos(max(-1.0, min(1.0, Vector(a).normalized().dot(Vector(b).normalized()))))
    n = max(1, int(math.ceil(ang / step)))
    return [slerp(a, b, q / n) for q in range(n)]


def cell_plate_bmesh(c, poly, r_fn, step=0.012, rings=6, wall=None):
    """one territory as a paper plate lying exactly on its spherical Voronoi cell (shared great-circle edges
    with its neighbours → no gaps, no overlaps). r_fn(dir) → radius of the top. wall = None | ('up', r_bot) for a
    raised plate (outward walls down to r_bot) | ('down', r_rim) for a sunken basin (inward walls up to r_rim).
    Faces: material 0 = top, 1 = wall."""
    c = Vector(c).normalized()
    B = []
    for k in range(len(poly)):
        B += arc_samples(poly[k], poly[(k + 1) % len(poly)], step)
    bm = bmesh.new()
    rings_v = []
    for j in range(1, rings + 1):
        t = j / rings
        t = 1 - (1 - t) ** 1.3
        ring = []
        for b in B:
            d = slerp(c, b, t)
            ring.append(bm.verts.new(d * r_fn(d)))
        rings_v.append(ring)
    cv = bm.verts.new(c * r_fn(c))
    M_ = len(B)
    top = [bm.faces.new((cv, rings_v[0][i], rings_v[0][(i + 1) % M_])) for i in range(M_)]
    for j in range(rings - 1):
        A_, Bn = rings_v[j], rings_v[j + 1]
        for i in range(M_):
            top.append(bm.faces.new((A_[i], Bn[i], Bn[(i + 1) % M_], A_[(i + 1) % M_])))
    walls = []
    if wall:
        kind, r2 = wall
        wt = [bm.verts.new(b * r_fn(b)) for b in B]
        wb = [bm.verts.new(b * r2) for b in B]
        for i in range(M_):
            k = (i + 1) % M_
            walls.append(bm.faces.new((wb[i], wb[k], wt[k], wt[i])))
    bm.normal_update()
    f0 = top[len(top) // 2]
    if f0.normal.dot(f0.calc_center_median()) < 0:
        bmesh.ops.reverse_faces(bm, faces=top)
    if walls:
        fw = walls[0]
        cen = fw.calc_center_median()
        out = (cen - c * cen.dot(c))
        want_out = wall[0] == 'up'
        if (fw.normal.dot(out) < 0) == want_out:
            bmesh.ops.reverse_faces(bm, faces=walls)
    for f in top:
        f.smooth = True
        f.material_index = 0
    for f in walls:
        f.smooth = False
        f.material_index = 1
    bm.normal_update()
    return bm


def ribbon_bmesh(pts, nrms, hws, head_cap=False, ext=(0.0, 0.0), bm=None):
    """flat strip lying in the tangent plane: pts (world), nrms (surface normals), hws (half widths per point).
    head_cap: round cap at the last point (anime wind-line head). ext: extend start/end by these lengths (clean
    T-joints for hairlines). Faces point along +normal."""
    bm = bm or bmesh.new()
    n = len(pts)
    if n < 2:
        return bm
    pts = [Vector(p) for p in pts]
    tans = []
    for i in range(n):
        a, b = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
        tans.append((b - a).normalized())
    if ext[0] > 0:
        pts[0] = pts[0] - tans[0] * ext[0]
    if ext[1] > 0:
        pts[-1] = pts[-1] + tans[-1] * ext[1]
    L_, R_ = [], []
    for i in range(n):
        nn = Vector(nrms[i]).normalized()
        side = nn.cross(tans[i]).normalized()
        L_.append(bm.verts.new(pts[i] + side * hws[i]))
        R_.append(bm.verts.new(pts[i] - side * hws[i]))
    faces = []
    for i in range(n - 1):
        faces.append(bm.faces.new((R_[i], R_[i + 1], L_[i + 1], L_[i])))
    if head_cap and hws[-1] > 0:
        nn = Vector(nrms[-1]).normalized()
        t = tans[-1]
        side = nn.cross(t).normalized()
        K = 10
        cen = bm.verts.new(pts[-1])
        ring = [L_[-1]] + [bm.verts.new(pts[-1] + side * hws[-1] * math.cos(math.pi * q / K) + t * hws[-1] * math.sin(math.pi * q / K)) for q in range(1, K)] + [R_[-1]]
        for q in range(K):
            faces.append(bm.faces.new((cen, ring[q + 1], ring[q])))
    bm.normal_update()
    for f in faces:
        c = f.calc_center_median()
        # orient along the local surface normal (nearest sample)
        k = min(range(n), key=lambda j: (pts[j] - c).length_squared)
        if f.normal.dot(Vector(nrms[k])) < 0:
            f.normal_flip()
    bm.normal_update()
    return bm
