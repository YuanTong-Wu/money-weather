// planet/freecam2d.js — §26 amendment 3 for the 2D Planet: a free Google-Earth camera on the orthographic globe.
//
// The 2D planet draws a precomputed disk layout (orthoLayout: owner grid, fields, rings, anchors) for ONE view.
// While the camera moves (drag, inertia, wheel, pinch, keys, 回正) this module draws a light vector globe at the
// live camera instead (sea, every coast, the regions in their temperature colour, company dots — straight from the
// sphere geometry, ~2–6 ms a frame); once the camera rests (~80 ms) the planet rebuilds its full layout at that
// view — setNode(node, map, {direction:'none', cam:true}) — and labels / ①②③ / 主航道 / clouds / particles come back
// at their true places (while it moves, the rest frame's names, markers, cards and 主航道 ride on the moving picture,
// re-projected through the camera; wind, clouds and weather marks fade back in after the rebuild).
// 真实: the window's raster + 1:50m / 1:10m coasts follow the camera on that rebuild (planet.js setNode).
// §26 full-bleed: px/rad = R0·zoom (R0 = the porthole radius); on the real Earth the globe's own disc is the window
// (it grows past the screen ≈ ×1.7; §26 amendment 5: 抽象 too — it kept the porthole). The moving picture draws the resting map's style (sea,
// foam, land, region fills and edges, country borders) and keeps the resting names, company markers, ①②③ cards and
// the 主航道 riding on the map (re-projected from the rest frame), so nothing pops when the full map comes back.
//
// Camera = {lon, lat, zoom} (north up — a map does not tilt). Defaults: 真实 layout.view; 抽象 the 3D rest pose
// (planet/aim.js: 主航道 + ①②③ facing the viewer, settled once the shell's overlays arrive, then frozen) at zoom 1.
// §26 amendment 5 (2D = the 3D planet flattened): every projection here is the 3D camera's own lens (planet/persp.js),
// so the same {lon, lat, zoom} puts every place on the same pixel in 2D and 3D; getCamera / seed hand the camera over
// when the owner switches 2D ↔ 3D; faceChild turns a territory to the viewer (the tour); while the camera moves the
// rest frame's wind, fronts, storms, clouds and intel ride on the moving picture too (nothing important vanishes), and
// a rebuild at rest carries the wind over instead of re-seeding it. Zoom clamp: 真实 1 (whole globe) … 150 (a city's districts — §26 amendment 4: the rebuild at rest asks
// real.js for the admin-unit level of that zoom); 抽象 / 全球 1 … 4. A manual camera survives refreshes and date
// changes (setNode on the same node + reading keeps it); flying to another level takes that level's default.
// faceHero(k) (抽象): the shell's one-ended 主航道 pin sits near the rim → the default view turns toward it, once.

import { FreeControls } from './controls.js';
import { flightPlan, flightAt } from './flight.js'; // §26 amendment 5: 3D's level flight (planet3d.js 'fly')
import { dirOf, lonLatOf, frameAt, neutralPolys } from './sphere.js';
import { bandOf, seaLook } from './theme.js';
import { drawSeabed, dotScreen, shadeLand, toonLight } from './seabed.js'; // §26 amendment 5: the 3D ground
import { baseLand } from './realearth.js';
import { unitLines } from './units.js';
import { lensK, lensInv, lensVis, lensTheta } from './persp.js'; // §26 amendment 5: the 3D camera's lens
import { restAim, aimImp } from './aim.js'; // §26 amendment 5: the 3D rest pose
import { clipRing } from './horizon.js'; // §26 amendment 5: rings cut at the horizon (as orthoLayout)

const DEG = 180 / Math.PI;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth01 = (t) => { const u = t < 0 ? 0 : t > 1 ? 1 : t; return u * u * (3 - 2 * u); };
const ZMAX = { real: 150 };
const ZMAX_ABSTRACT = 4;
const capMemo = new WeakMap();
const AIM_GRACE = 1500; // (planet3d.js) overlays that arrive this soon after a flight may still steer the rest pose
const LIGHT = [-0.62, 0.55]; // (planet3d/core.js LIGHT: the key light's screen direction — the lit side)

const descMemo = new WeakMap();
/** Does node hold id somewhere below it (children / stocks)? (planet.js inSubtree) */
function hasDesc(node, id) {
  if (!node || typeof node !== 'object') return false;
  let set = descMemo.get(node);
  if (!set) {
    set = new Set();
    const walk = (x) => {
      for (const c of x.children || []) { if (c && c.id) set.add(c.id); walk(c); }
      for (const c of x.stocks || []) if (c) set.add(c.id || (c.t ? 's:' + c.t : null));
    };
    walk(node);
    descMemo.set(node, set);
  }
  return set.has(id);
}

/** Bounding cap (unit centre + angular radius) of an xyz ring — cheap horizon / window culling. */
function capOf(r) {
  let sx = 0, sy = 0, sz = 0;
  const m = r.length / 3;
  for (let i = 0; i < r.length; i += 3) { sx += r[i]; sy += r[i + 1]; sz += r[i + 2]; }
  const l = Math.hypot(sx, sy, sz);
  if (l < 1e-9 || m < 3) return [0, 0, 1, Math.PI];
  sx /= l; sy /= l; sz /= l;
  let mn = 1;
  for (let i = 0; i < r.length; i += 3) { const d = r[i] * sx + r[i + 1] * sy + r[i + 2] * sz; if (d < mn) mn = d; }
  return [sx, sy, sz, Math.acos(clamp(mn, -1, 1))];
}
const capPoly = (p) => ({ ext: p.ext, holes: p.holes || [], cap: capOf(p.ext) });
function capsOf(S) {
  let c = capMemo.get(S);
  if (c) return c;
  c = { terr: S.terr.map((T) => T.polys.map(capPoly)), neutral: (S.neutral || []).map(capPoly) };
  capMemo.set(S, c);
  return c;
}
function capsList(arr) {
  let c = capMemo.get(arr);
  if (!c) { c = arr.map(capPoly); capMemo.set(arr, c); }
  return c;
}
/** Does lon/lat box a sit inside box b? (deg; null a = the whole globe) */
function boxIn(a, b) {
  if (!b) return true;
  if (!a) return false;
  const e = 1e-6;
  return a.lat0 >= b.lat0 - e && a.lat1 <= b.lat1 + e && Math.abs(wrap180(a.lon - b.lon)) + a.span / 2 <= b.span / 2 + e;
}

export class FreeCam2D {
  constructor(planet) {
    this.p = planet;
    this.cam = null; // the live camera {lon, lat, zoom}
    this.def = null; // the layout's default view
    this.built = null; // the camera the planet's current layout was built for
    this.manual = false;
    this.nodeId = null; this.mode = null; this.S = null; this.st = null; this.zmax = ZMAX_ABSTRACT;
    this.tw = null; // 回正 tween
    this._nav = 0; this._navT = 0;
    this._memo = []; // 真实: prepared spheres {list, box, z, S} a camera view may reuse (no new raster / coast clip)
    // level flights (setNode without cam) block camera rebuilds until they land
    const orig = planet.setNode;
    const self = this;
    planet.setNode = async function setNodeFC(node, map, o = {}) {
      if (o && o.cam) return orig.call(this, node, map, o);
      self._nav++; self._navT = performance.now();
      try { return await orig.call(this, node, map, o); } finally { self._nav = Math.max(0, self._nav - 1); }
    };
    this.fc = new FreeControls(planet.canvas, this, { compass: false });
  }

  destroy() { clearTimeout(this._rbT); this.fc.destroy(); }
  moving() { return this.fc.moving() || this._differs(); }

  // ------------------------------------------------------------------------------------------ planet hooks
  /** setNode: the view to build at (a manual camera on the same node + reading), or null for the default. */
  viewFor(node, mode, camCall) {
    const same = node && this.nodeId === node.id && this.mode === mode;
    if (this._seed && !(same && this._seed.node === node.id)) this._seed = null; // (a hand-off from 3D: that node only)
    const held = this.manual;
    // (a camera rebuild is always built at the live camera — a faced / aimed default too, not only a manual view)
    if (camCall) return same && this.cam ? { lon: this.cam.lon, lat: this.cam.lat, scale: this.cam.zoom } : null;
    if (same && held && this.cam) return { lon: this.cam.lon, lat: this.cam.lat, scale: this.cam.zoom };
    this.manual = false; // a new level / reading: its own default view
    this.tw = null;
    return null;
  }

  /**
   * 抽象: the shell's one-ended 主航道 pin (territory k) — as 3D (planet3d.js setHeroAnchor): while the rest pose is not
   * settled it simply joins the aim; once settled, the globe turns only when the place sits near the rim (facing < 0.45)
   * and the owner has not turned it himself. 回正 comes back here.
   */
  faceHero(k) {
    const st = this.st, S = this.S, c = this.cam;
    if (!st || st.real || !S || !S.terr[k] || !c || this.manual || this.tw) return false;
    const A = this.aim;
    if (A && A.node === this.nodeId && A.mode === this.mode && performance.now() < A.lockAt) return this.reaim();
    const a = S.terr[k].anchor, C = dirOf(c.lon, c.lat);
    if (a[0] * C[0] + a[1] * C[1] + a[2] * C[2] >= 0.45) return false;
    if (A) A.lockAt = performance.now() + 250;
    return this.reaim();
  }

  /** §26 amendment 5: the 3D rest pose of this planet (planet/aim.js) with the overlays the planet holds now. */
  _aimNow(S, node) {
    const p = this.p, kids = node.children || [];
    const n = S.terr.length, ids = kids.map((c) => c && c.id);
    const anchors = S.terr.map((T) => { const a = T.anchor || T.center || [0, 0, 1], l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; });
    const kOf = (id) => {
      if (id == null) return null;
      const k = ids.indexOf(id);
      if (k >= 0) return k;
      for (let j = 0; j < kids.length; j++) if (hasDesc(kids[j], id)) return j;
      return null;
    };
    // (as Planet3D: the shell's channel only — an old one that does not resolve here means none yet)
    let chan = null;
    const ov = p.ov && p.ov.channel;
    if (ov && typeof ov === 'object') {
      const fk = kOf(ov.from), tk = kOf(ov.to);
      if (fk != null && tk != null && fk !== tk) {
        const t2 = ov.to2 != null ? kOf(ov.to2) : null;
        chan = { fk, tk, t2k: t2 != null && t2 !== fk && t2 !== tk ? t2 : null };
      }
    }
    const nov = p.ov && p.ov.numbers;
    const numOf = (k) => {
      const id = ids[k];
      if (Array.isArray(nov)) { const it = nov.find((x) => x && x.id === id); return it ? +it.n || nov.indexOf(it) + 1 : 0; }
      if (nov === 'auto' && Array.isArray(p.spot)) { const i = p.spot.findIndex((x) => x && x.id === id); return i >= 0 ? i + 1 : 0; }
      return 0;
    };
    const hero = !chan && p.heroId ? kOf(p.heroId) : null;
    const imp = aimImp({ n, chan, hero, numOf, anchors });
    return restAim({ anchors, areas: S.terr.map((T) => T.area || 0), front: S.front || [0, 0, 1], earth: S.mode === 'earth', light: LIGHT, imp });
  }

  /**
   * setNode (抽象, no manual view): the direction the default view looks at — the 3D rest pose. A new level / reading
   * starts a fresh aim (open until the flight lands + AIM_GRACE, or 250 ms after the shell's overlays arrive, as 3D);
   * a camera rebuild keeps the aim it has.
   */
  aimDir(S, node, mode, fresh = true) {
    if (!S || !S.terr || !S.terr.length || mode === 'real') return null;
    const A = this.aim;
    if (!fresh && A && A.node === node.id && A.mode === mode && A.S === S) return A.dir;
    const dir = this._aimNow(S, node);
    this.aim = { node: node.id, mode, S, dir, lockAt: Infinity };
    return dir;
  }

  /** The flight landed (planet.js _endTransition / a setNode without flight): the rest pose settles soon. */
  landed() { const A = this.aim; if (A && A.lockAt === Infinity) A.lockAt = performance.now() + (A.ov ? 250 : AIM_GRACE); }

  /**
   * The shell's 主航道 / ①②③ / hero pin arrived (planet.js setOverlay / setHeroAnchor): while the rest pose is open, aim
   * again and glide there (Planet3D slerps its rest pose the same way); the pose closes 250 ms after the overlays.
   */
  reaim() {
    const A = this.aim, S = this.S, st = this.st;
    if (!A || !S || !st || st.real || A.node !== this.nodeId || A.mode !== this.mode || A.S !== S) return false;
    const now = performance.now();
    if (now >= A.lockAt) return false;
    A.ov = true;
    if (A.lockAt === Infinity || this.p.transition) A.lockAt = Infinity; else A.lockAt = Math.min(A.lockAt, now + 250);
    const node = this.p._lastNav && this.p._lastNav.node;
    if (!node || node.id !== A.node) return false;
    const dir = this._aimNow(S, node);
    const moved = Math.acos(clamp(dir[0] * A.dir[0] + dir[1] * A.dir[1] + dir[2] * A.dir[2], -1, 1));
    A.dir = dir;
    if (moved < 0.004 || this.manual) return false;
    const [lon, lat] = lonLatOf(dir[0], dir[1], dir[2]);
    this.def = { lon: wrap180(lon), lat: clamp(lat, -84, 84), zoom: this.def ? this.def.zoom : 1 };
    if (!this.cam) return false;
    this.tw = { t: 0, dur: 0.6, a: { ...this.cam }, b: { ...this.def }, dl: wrap180(this.def.lon - this.cam.lon) };
    this.fc._startGesture();
    return true;
  }

  /**
   * Turn territory k to the viewer (the tour, search — Planet3D.faceChild): 真实 straight at it, north up; 抽象 a little
   * below-right of the middle (3D keeps a touch of the 3/4 view). It becomes the default view (回正 comes back here).
   */
  faceChild(k) {
    const S = this.S, st = this.st, c = this.cam;
    if (!S || !S.terr[k] || !st || !c) return false;
    if (this.p.transition && this.p.transition.fly) { this._faceAfter = k; return true; } // (once the flight lands)
    const a = S.terr[k].anchor;
    let d = a;
    if (!st.real) {
      // the look point sits ≈ 11° up-left of the place (3D: setFromUnitVectors(Z, (0.12, −0.16, 1)))
      const [e, n] = frameAt(a), om = Math.atan(Math.hypot(0.12, 0.16)), ue = -0.12 / Math.hypot(0.12, 0.16), un = 0.16 / Math.hypot(0.12, 0.16);
      d = [0, 1, 2].map((i) => a[i] * Math.cos(om) + (ue * e[i] + un * n[i]) * Math.sin(om));
    }
    const [lon, lat] = lonLatOf(d[0], d[1], d[2]);
    // (3D: the faced pose is the new rest pose — 回正 comes back here at the layout's zoom; the glide keeps the zoom)
    this.def = { lon: wrap180(lon), lat: clamp(lat, -84, 84), zoom: this.def ? this.def.zoom : c.zoom };
    if (this.aim && this.aim.node === this.nodeId) { this.aim.dir = dirOf(this.def.lon, this.def.lat); this.aim.lockAt = 0; }
    const b = { lon: this.def.lon, lat: this.def.lat, zoom: c.zoom };
    this.tw = { t: 0, dur: 0.6, a: { ...c }, b, dl: wrap180(b.lon - c.lon), manual: this.manual && Math.abs(c.zoom / this.def.zoom - 1) > 1e-4 };
    this.fc._startGesture();
    return true;
  }

  /** §26 amendment 5: the live camera for the 2D ↔ 3D hand-off (main.js setRender). */
  getCamera() {
    const c = this.cam;
    if (!c || !this.nodeId) return null;
    return { lon: c.lon, lat: c.lat, zoom: c.zoom, manual: !!this.manual, nodeId: this.nodeId, mode: this.mode };
  }

  /**
   * §26 amendment 5: a level change on the one real Earth flies the camera as Planet3D does (planet/flight.js: the same
   * turn, the same zoom out and in, the same timing). from = {cam, S, st} on screen now; real = the new view (planet.js
   * setNode). null = the camera stays (a refresh in place: the calm swap).
   */
  flyPlan(from, real) {
    const v = (real && real.view) || {};
    const F = flightPlan(from.cam, { lon: +v.lon || 0, lat: +v.lat || 0, zoom: real.zoom });
    if (F.th < 1e-3 && Math.abs(F.lb - F.la) < 0.01) return null;
    F.from = from;
    this.cam = { ...from.cam };
    return F;
  }

  /**
   * One frame of a level flight (planet.js transition with .fly): the camera on 3D's path and the moving picture drawn
   * there — the old level's regions sink back into the land (gone by 38 %, its company dots by 30 %), the new ones rise
   * from 55 % (planet3d.js uRise / rise), no words, no weather until it lands.
   */
  flyFrame(ctx, now, tr) {
    if (!this.S || !this.st) return false;
    const u = clamp((now - tr.t0) / Math.max(1, tr.dur), 0, 1), c = flightAt(tr.fly, u);
    this.cam = { lon: c.lon, lat: c.lat, zoom: clamp(c.zoom, 1, this.zmax) };
    const o = tr.fly.from || {};
    return this.preview(ctx, { S: o.S, st: o.st, aOld: 1 - smooth01(u / 0.38), aPts: 1 - smooth01(u / 0.3), aNew: smooth01((u - 0.55) / 0.45) });
  }

  /** The flight landed (planet.js _endTransition): the camera is the new view; a 巡航 turn asked mid-flight runs now. */
  flyEnd() {
    if (this.built) this.cam = { ...this.built };
    const k = this._faceAfter;
    this._faceAfter = null;
    if (k != null) this.faceChild(k);
  }

  /** Start the next setNode on cam.nodeId + cam.mode at this camera, held like a manual view (the 2D ↔ 3D switch). */
  seed(cam) {
    if (!cam || !cam.nodeId || !Number.isFinite(+cam.lon) || !Number.isFinite(+cam.lat)) return;
    const zmax = cam.mode === 'real' ? ZMAX.real : ZMAX_ABSTRACT;
    this.nodeId = cam.nodeId; this.mode = cam.mode;
    this.cam = { lon: wrap180(+cam.lon), lat: clamp(+cam.lat, -84, 84), zoom: clamp(+cam.zoom || 1, 1, zmax) };
    this.manual = true;
    this._seed = { node: cam.nodeId };
  }

  /** setNode built `st` (from sphere S) — at camera view `cv` ({lon, lat, scale}) or at the layout's default. */
  adopt(st, node, mode, S, list, cv) {
    this.st = st; this.S = S && S.terr ? S : null; this.nodeId = node.id; this.mode = mode;
    const real = !!st.real;
    this.zmax = real ? ZMAX.real : ZMAX_ABSTRACT;
    if (real) {
      const v = (list && list.view) || { lon: 0, lat: 20, scale: 1 };
      this.def = { lon: +v.lon || 0, lat: +v.lat || 0, zoom: clamp(+v.scale || 1, 1, this.zmax) };
      if (!cv && S) this.sphereKeep(list, S.grid && S.grid.box, this.def.zoom, S, !!(S.grid && S.grid.box && this.p._realWin(v, this.def.zoom, list).ten));
      // a zoomed window holds only its own coasts: the moving preview falls back to every coast (1:50m) beyond it
      if (!this._gn && !this._gnP) {
        const p = this.p;
        if (!p._landPre) p._landPre = baseLand().then((x) => neutralPolys(x));
        this._gnP = p._landPre.then((x) => { this._gn = x && x.XYZ; }).catch(() => { this._gnP = null; });
      }
    } else if (this.S) {
      // §26 amendment 5: the 3D rest pose (planet/aim.js) at zoom 1 — the aim setNode built this view at
      const d = this.aimDir(this.S, node, mode, false) || this.S.front || [0, 0, 1];
      const [lon, lat] = lonLatOf(d[0], d[1], d[2]);
      this.def = { lon: wrap180(lon), lat: clamp(lat, -84, 84), zoom: 1 };
    } else this.def = null;
    this.built = cv ? { lon: cv.lon, lat: cv.lat, zoom: clamp(+cv.scale || 1, 1, this.zmax) } : this.def && { ...this.def };
    if (!this.manual || !this.cam) this.cam = this.built && { ...this.built };
  }

  /** 真实: a prepared sphere for `list` whose window still covers camera view v at zoom z, or null. */
  sphereFor(list, v, z) {
    const w = this.p._realWin(v, z, list, 1.04); // the screen at this zoom (setNode builds with a roomier margin)
    const want = w.box, ten = w.ten;
    for (const m of this._memo) {
      if (m.list !== list) continue;
      if (!m.box) { if (!ten) return m.S; continue; }
      // (§26 amendment 5: zoomed in past 2.2× the window it was built for → a fresh raster, as Planet3D._reask does —
      // a coarse reused raster gives small units such as 米尔皮塔斯 to their neighbour)
      if (!want || z / m.z > 2.2 || m.z / z > 1.6 || (ten && !m.ten)) continue;
      if (boxIn(want, m.box)) return m.S;
    }
    return null;
  }

  sphereKeep(list, box, z, S, ten = false) {
    if (!S || !list) return;
    this._memo = [{ list, box: box || null, z, S, ten: !!ten }].concat(this._memo.filter((m) => m.S !== S && m.list === list)).slice(0, 4);
  }

  /** The planet's window changed size (panel, resize): rebuild at the live camera once the camera rests. */
  refit() {
    this._refit = true;
    clearTimeout(this._rbT);
    this._rbT = setTimeout(() => this._rebuild(), 120);
  }

  _differs() {
    const c = this.cam, b = this.built;
    if (!c || !b || !this.S || this.p.cur !== this.st) return false;
    return Math.abs(wrap180(c.lon - b.lon)) > 1e-5 || Math.abs(c.lat - b.lat) > 1e-5 || Math.abs(c.zoom / b.zoom - 1) > 1e-5;
  }

  _navBusy() { return this._nav > 0 && performance.now() - this._navT < 6000; }

  // ------------------------------------------------------------------------------------------ FreeControls camera
  busy() { return !!this.p.transition || this._navBusy() || !this.S || !this.cam; }
  isDefault() { return !this.manual; }

  begin() {
    clearTimeout(this._rbT);
    this._airT = 0;
    if (this.p._camFade) this.p._camFade = null; // (a new gesture: the crossfade's old picture goes)
    if (this.p.hoverIdx >= 0) this.p._setHover(-1, null);
  }

  rotate(dx, dy) {
    const c = this.cam;
    if (!c || !this.S) return;
    this.tw = null;
    const k = DEG / (Math.max(40, this.p.view.R0 || this.p.view.R) * c.zoom);
    c.lon = wrap180(c.lon - (dx * k) / Math.max(0.25, Math.cos(c.lat / DEG)));
    c.lat = clamp(c.lat + dy * k, -84, 84);
    this.manual = true;
  }

  zoom(f, x, y) {
    const c = this.cam;
    if (!c || !this.S) return;
    this.tw = null;
    const z0 = c.zoom, z1 = clamp(z0 * f, 1, this.zmax);
    if (Math.abs(z1 - z0) < 1e-6) return;
    // §26 amendment 5: the globe point under the cursor stays exactly under it (Planet3D's ray pick): the new centre is
    // solved through the lens so that point projects back onto the cursor at z1, north kept up (the old bearing slide
    // drifted 20–90 px when zoomed out — meridians converge)
    const P = x != null && Number.isFinite(x) ? this._pickAt(c, x, y) : null;
    c.zoom = z1;
    if (P) this._pinAt(c, P, x, y);
    this.manual = true;
  }

  /** The globe point (unit xyz) under canvas px (x, y) at camera c, through the 3D lens — null off the globe. */
  _pickAt(c, x, y) {
    const p = this.p, { cx, cy } = p.view, RZ = (p.view.R0 || p.view.R) * c.zoom;
    const q = lensInv(p._lensD(), (x - cx) / RZ, (y - cy) / RZ);
    if (!q) return null;
    const C = dirOf(c.lon, c.lat), [e, n] = frameAt(C);
    return [0, 1, 2].map((i) => q[0] * e[i] - q[1] * n[i] + q[2] * C[i]);
  }

  /** Canvas px of globe point P at camera c (null over the horizon). */
  _scrOf(c, P) {
    const p = this.p, { cx, cy } = p.view, LD = p._lensD();
    const C = dirOf(c.lon, c.lat), [e, n] = frameAt(C), f = P[0] * C[0] + P[1] * C[1] + P[2] * C[2];
    if (f < lensVis(LD) + 1e-4) return null;
    const k = (p.view.R0 || p.view.R) * c.zoom * lensK(LD, f);
    return [cx + (P[0] * e[0] + P[1] * e[1] + P[2] * e[2]) * k, cy - (P[0] * n[0] + P[1] * n[1] + P[2] * n[2]) * k];
  }

  /**
   * Move camera c (north up, its zoom kept) so globe point P lands on canvas px (x, y): first Planet3D's own turn (the
   * point now under the cursor rotated onto P — setFromUnitVectors), then a few Newton steps on (lon, lat).
   */
  _pinAt(c, P, x, y) {
    const Q = this._pickAt(c, x, y);
    if (Q) {
      const ax = [Q[1] * P[2] - Q[2] * P[1], Q[2] * P[0] - Q[0] * P[2], Q[0] * P[1] - Q[1] * P[0]], s = Math.hypot(ax[0], ax[1], ax[2]);
      if (s > 1e-12) {
        const k = ax.map((v) => v / s), co = clamp(Q[0] * P[0] + Q[1] * P[1] + Q[2] * P[2], -1, 1), si = s;
        const C = dirOf(c.lon, c.lat), kc = k[0] * C[0] + k[1] * C[1] + k[2] * C[2];
        const kx = [k[1] * C[2] - k[2] * C[1], k[2] * C[0] - k[0] * C[2], k[0] * C[1] - k[1] * C[0]];
        const R = [0, 1, 2].map((i) => C[i] * co + kx[i] * si + k[i] * kc * (1 - co)); // (Rodrigues: C turned Q → P)
        const [lon, lat] = lonLatOf(R[0], R[1], R[2]);
        c.lon = wrap180(lon); c.lat = clamp(lat, -84, 84);
      }
    }
    for (let it = 0; it < 4; it++) {
      const s0 = this._scrOf(c, P);
      if (!s0) return;
      const ex = s0[0] - x, ey = s0[1] - y;
      if (Math.abs(ex) + Math.abs(ey) < 0.05) return;
      const h = 0.01 / c.zoom, sl = this._scrOf({ lon: c.lon + h, lat: c.lat, zoom: c.zoom }, P), sb = this._scrOf({ lon: c.lon, lat: c.lat + h, zoom: c.zoom }, P);
      if (!sl || !sb) return;
      const a = (sl[0] - s0[0]) / h, b = (sb[0] - s0[0]) / h, d = (sl[1] - s0[1]) / h, f = (sb[1] - s0[1]) / h, det = a * f - b * d;
      if (Math.abs(det) < 1e-9) return;
      const dl = (f * ex - b * ey) / det, dp = (a * ey - d * ex) / det;
      c.lon = wrap180(c.lon - clamp(dl, -20, 20)); c.lat = clamp(c.lat - clamp(dp, -20, 20), -84, 84);
    }
  }

  reset() {
    if (!this.cam || !this.def) return;
    const a = this.cam, b = this.def;
    this.tw = { t: 0, dur: 0.65, a: { ...a }, b: { ...b }, dl: wrap180(b.lon - a.lon) };
  }

  animating() { return !!this.tw; }

  tick(dt) {
    const w = this.tw;
    if (!w) return;
    w.t += dt;
    const u = clamp(w.t / w.dur, 0, 1), e = ease(u);
    this.cam.lon = wrap180(w.a.lon + w.dl * e);
    this.cam.lat = w.a.lat + (w.b.lat - w.a.lat) * e;
    this.cam.zoom = Math.exp(Math.log(w.a.zoom) + (Math.log(w.b.zoom) - Math.log(w.a.zoom)) * e);
    if (u >= 1) { this.tw = null; this.cam = { ...w.b }; this.manual = !!w.manual; }
  }

  settle() {
    clearTimeout(this._rbT);
    this._rbT = setTimeout(() => this._rebuild(), 80);
  }

  _rebuild() {
    if (this.fc.moving() || this.tw || (!this._differs() && !this._refit)) return;
    if (this.p.transition || this._navBusy()) { this._rbT = setTimeout(() => this._rebuild(), 220); return; }
    const n = this.p._lastNav;
    if (!n) return;
    this._refit = false;
    Promise.resolve(this.p.setNode(n.node, n.mapJson, { direction: 'none', cam: true, geo: this.mode })).catch((e) => console.warn('[planet] camera', e));
  }

  // ------------------------------------------------------------------------------------------ the moving picture
  /**
   * Draws the moving picture at the live camera when it differs from the built layout (true = drawn): the resting
   * map's style from the sphere geometry (sea, foam, neutral land, region fills / edges, country borders), then the
   * rest frame's company markers, names, 主航道 and ①②③ cards re-projected onto the live camera.
   */
  preview(ctx, fl = null) {
    if (!fl && !this._differs()) return false; // (fl: a level flight — flyFrame)
    const p = this.p, st = p.cur, S = this.S, th = p.theme, c = this.cam;
    // §26 amendment 5 (a level flight): the new level's regions rise (aN), the old level's sink back into the land
    const aN = fl && fl.S !== S ? clamp(fl.aNew, 0, 1) : 1;
    const { cx, cy } = p.view, R0 = p.view.R0 || p.view.R;
    const day = th.name !== 'night';
    const real = !!st.real;
    const C = dirOf(c.lon, c.lat), [e, n] = frameAt(C), Z = c.zoom;
    const caps = capsOf(S);
    // the window: the globe's own disc (full-bleed once it passes the screen)
    const Rw = R0 * Z; // (§26 amendment 5: 抽象 grows as the real Earth does — it kept the porthole)
    const fa = p._freeArea();
    const reach = Math.max(Math.hypot(Math.max(cx, p.W - cx), Math.max(cy, p.H - cy)), 1) / (R0 * Z); // the screen's half-diagonal (rad·)
    const lim = Math.asin(Math.min(1, Math.max(reach, 0.02) * 1.04)) + 0.02;
    const vis = (cap) => Math.acos(clamp(cap[0] * C[0] + cap[1] * C[1] + cap[2] * C[2], -1, 1)) - cap[3] < (Z <= 1.02 ? Math.PI / 2 + 0.02 : lim);
    const RZ = R0 * Z, ex = e[0], ey = e[1], ez = e[2], nx = n[0], ny = n[1], nz = n[2], c0 = C[0], c1 = C[1], c2 = C[2];
    // §26 amendment 5: the 3D camera's lens (planet/persp.js) — a point of facing f lands at (east, north)·K(f) limb units
    const LD = p._lensD(), LV = lensVis(LD), K = (f) => lensK(LD, f);
    // (refine-surface: a ring behind the planet is cut at the horizon and closed along the limb on its own side,
    // planet/horizon.js — sliding its far points onto the limb swapped land and sea for rings bigger than the view)
    const front = Math.acos(clamp(LV, -1, 1)) - 0.005;
    const ring = (path, r, all = false) => clipRing(r, C, e, n, LV, K, path, RZ, cx, cy, 0.8, all);
    const add = (path, P) => {
      if (!vis(P.cap)) return false;
      ring(path, P.ext, Math.acos(clamp(P.cap[0] * C[0] + P.cap[1] * C[1] + P.cap[2] * C[2], -1, 1)) + P.cap[3] < front);
      for (const h of P.holes) ring(path, h);
      return true;
    };
    const land = new Path2D(), neutral = new Path2D();
    const box = S.grid && S.grid.box;
    const gn = box && this._gn && !boxIn(Z >= 1.02 ? (p._realWin({ lon: c.lon, lat: c.lat }, Z, null, 1).box || null) : null, box);
    for (const P of gn ? capsList(this._gn) : caps.neutral) add(neutral, P);
    const kind = st.kind || null, temp = st.cur && st.cur.temp;
    const terr = [], dots = [];
    for (let k = 0; k < caps.terr.length; k++) {
      const kd = kind ? kind[k] : 'land';
      if (kd === 'point') continue;
      const path = new Path2D();
      let any = false;
      for (const P of caps.terr[k]) any = add(path, P) || any;
      if (!any) continue;
      terr.push([k, path, kd]);
      if (kd !== 'sea') land.addPath(path);
    }
    const bandK = (k) => bandOf(clamp(temp && Number.isFinite(temp[k]) ? temp[k] : 0, -3, 3));
    const col = (k) => th.bandCSS[bandK(k)];
    const mid = Math.floor(th.bandCSS.length / 2);
    const old = fl && fl.S && fl.st && fl.S !== S && fl.aOld > 0.004 ? this._flyOld(fl, add) : null;
    ctx.save();
    // the paper drop (as _drawBody), then the window
    p._drawDrop(ctx, cx, cy, Rw);
    ctx.beginPath();
    ctx.arc(cx, cy, Rw, 0, Math.PI * 2);
    ctx.clip();
    // §26 amendment 5: the resting map's ground (planet/seabed.js) — refine-surface: the rest frame's own sea (deep →
    // shallow by coast distance, 等深線, wave marks, foam, its toon shadow) on a coarser grid (≈ 40k cells, a few ms);
    // the stacked offset strokes it replaces swapped the sea's look on every drag (banded shallows, no wave marks,
    // bead rings round small islands) — then the unclaimed land's paper, dot screen and coast hairline
    const pal = seaLook(th.name, real), dpr = p.dpr || 1;
    ctx.fillStyle = pal.deep;
    ctx.fillRect(Math.max(0, cx - Rw - 2), Math.max(0, cy - Rw - 2), Math.min(p.W, 2 * Rw + 4), Math.min(p.H, 2 * Rw + 4));
    const R0s = R0 * (real ? 1 : Z); // (an abstract planet's sea grows with it, as in 3D)
    const sx0 = Math.max(0, cx - Rw), sy0 = Math.max(0, cy - Rw), sx1 = Math.min(p.W, cx + Rw), sy1 = Math.min(p.H, cy + Rw);
    if (sx1 > sx0 + 1 && sy1 > sy0 + 1) {
      drawSeabed(ctx, {
        rect: [sx0 - cx, sy0 - cy, sx1 - cx, sy1 - cy], R: 1, R0: R0s, dpr, pal, light: toonLight(Z, real), zoom: real ? Z : 1, real,
        land: [[neutral, 'evenodd'], [land, 'evenodd']], proj: { v: C, e, n, Z: RZ, D: LD }, off: [cx, cy], cells: 40000,
      });
    }
    ctx.fillStyle = pal.land;
    ctx.fill(neutral, 'evenodd');
    dotScreen(ctx, neutral, 'evenodd', pal, R0s, dpr, dpr, { v: C, e, n, Z: RZ, D: LD, rect: [sx0 - cx, sy0 - cy, sx1 - cx, sy1 - cy], R: 1, off: [cx, cy], real });
    // (the land's toon shadow crescent, as the rest frame: the unclaimed land here, the regions after their fills)
    const lightZ = toonLight(Z, real), reachZ = Math.hypot(Math.max(cx, p.W - cx), Math.max(cy, p.H - cy));
    const shadeOn = lightZ.L[2] <= 0.9995 && reachZ >= lightZ.L[2] * Rw; // (shadeLand's own test: is the crescent on screen?)
    const shade = (path) => { if (!shadeOn) return; ctx.save(); ctx.clip(path, 'evenodd'); ctx.translate(cx, cy); shadeLand(ctx, null, null, Rw, lightZ, day, null, reachZ); ctx.restore(); };
    shade(neutral);
    ctx.lineWidth = 1 / dpr; ctx.strokeStyle = th.border; ctx.globalAlpha = 0.5; ctx.stroke(neutral); ctx.globalAlpha = 1;
    if (real) {
      // (the resting map's soft drop shadow under every region — planet.js _drawWeather)
      ctx.save();
      ctx.translate(0.45, 0.4);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.8; ctx.strokeStyle = th.ink; ctx.globalAlpha = 0.1 * aN;
      ctx.stroke(land);
      if (old) { ctx.globalAlpha = 0.1 * old.a; ctx.stroke(old.land); }
      ctx.restore();
    }
    if (old) this._flyOldPaint(ctx, old, real);
    for (const [k, path, kd] of aN > 0.004 ? terr : []) {
      if (kd === 'sea') { if (bandK(k) === mid) continue; ctx.globalAlpha = 0.25 * aN; } else ctx.globalAlpha = (st.est && st.est[k] && !real ? 0.8 : 1) * aN;
      ctx.fillStyle = col(k);
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = aN; // (a level flight: the new regions' toon crescent rises with them)
    shade(land);
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    if (!real) { ctx.globalAlpha = aN; ctx.lineWidth = 3; ctx.strokeStyle = th.borderShade; ctx.stroke(land); ctx.lineWidth = 1.3; ctx.strokeStyle = th.border; ctx.stroke(land); ctx.globalAlpha = 1; }
    if (real) {
      // (the resting map's paper-cut edge — 3D's EDGE ribbons: an off-white inner rim (1 px at α .88, fading over .5 px),
      // a firm ink edge 0.75 px outside every coast; where two regions meet a 1 px ink line stands in for the rest
      // frame's 1.5 px one (planet.js _sharedInk: an erosion too heavy for every frame))
      FreeCam2D._edges(ctx, land, th, aN);
      const outside = new Path2D(); outside.rect(-1e4, -1e4, 3e4, 3e4); outside.addPath(land);
      // the resting map's atlas lines: faint country borders, US states, provinces / prefectures (planet.js _drawEdges)
      const RAD = Math.PI / 180, maxD = Math.hypot(p.W, p.H);
      const lines = (arr) => {
        const bp = new Path2D();
        for (const Ln of arr) {
          let pen = false;
          for (const [lon, lat] of Ln) {
            const a2 = lon * RAD, b2 = lat * RAD, cb = Math.cos(b2), x = cb * Math.sin(a2), y = Math.sin(b2), z = cb * Math.cos(a2);
            const fz = x * c0 + y * c1 + z * c2, kz = RZ * K(fz);
            const sx = cx + (x * ex + y * ey + z * ez) * kz, sy = cy - (x * nx + y * ny + z * nz) * kz;
            if (fz < LV + 0.02 || Math.abs(sx - cx) > maxD || Math.abs(sy - cy) > maxD) { pen = false; continue; }
            if (pen) bp.lineTo(sx, sy); else bp.moveTo(sx, sy);
            pen = true;
          }
        }
        return bp;
      };
      const L0 = p._lines || {};
      // (§26 amendment 5: 3D's atlas lines — one device px in the outline ink, alphas by the zoom; planet.js _drawEdges;
      // on the ground, under the regions)
      ctx.save();
      ctx.clip(outside, 'evenodd');
      ctx.strokeStyle = th.atlas || th.inkFaint;
      ctx.lineWidth = 1 / dpr;
      if (L0.b) { ctx.globalAlpha = 0.1 + 0.08 * clamp((Z - 1) / 2, 0, 1); ctx.stroke(lines(L0.b)); }
      if (L0.s && st.real.context && st.real.context.states && Z > 1.3) { ctx.globalAlpha = 0.22 * clamp((Z - 1.3) / 0.8, 0, 1); ctx.stroke(lines(L0.s)); }
      if (Z >= 1.6 && p._a1 && p._a1.lines && p._a1.lines.length) { ctx.globalAlpha = 0.18 * clamp((Z - 1.5) / 0.8, 0, 1); ctx.stroke(lines(p._a1.lines)); }
      ctx.restore();
      ctx.globalAlpha = 1;
      // §26 refine: the admin-unit lines stay while the map moves (they used to pop back only at rest)
      const unitPass = (U, stU, aU) => { // (§26 amendment 5: aU / stU — a level flight fades the old level's lines out)
      if (U && aU > 0.004) {
        const lim2 = Math.asin(Math.min(1, Math.max(reach, 0.02) * 1.04)) + 0.01;
        const path = (arr) => {
          const bp = new Path2D();
          for (const L of arr) {
            const q = L.cap;
            if (Math.acos(clamp(q[0] * c0 + q[1] * c1 + q[2] * c2, -1, 1)) - q[3] > lim2) continue;
            const P = L.p;
            let pen = false;
            for (let i = 0; i < P.length; i += 3) {
              const x = P[i], y = P[i + 1], z = P[i + 2], fz = x * c0 + y * c1 + z * c2;
              if (fz < LV + 0.02) { pen = false; continue; }
              const kz = RZ * K(fz), sx = cx + (x * ex + y * ey + z * ez) * kz, sy = cy - (x * nx + y * ny + z * nz) * kz;
              if (pen) bp.lineTo(sx, sy); else bp.moveTo(sx, sy);
              pen = true;
            }
          }
          return bp;
        };
        // (§26 amendment 5: each border fades by its own length on screen, as at rest — 3D world.js UNITLINE_FS)
        const byFade = (arr, f0, f1) => {
          const m = new Map();
          for (const L of arr) {
            const t = clamp((L.len * RZ - f0) / (f1 - f0), 0, 1), f = Math.round(t * t * (3 - 2 * t) * 8) / 8;
            if (f > 0) { if (!m.has(f)) m.set(f, []); m.get(f).push(L); }
          }
          return m;
        };
        ctx.lineWidth = 1 / dpr;
        if (U.neutral.length) { ctx.strokeStyle = th.ink; for (const [f, arr] of byFade(U.neutral, 18, 46)) { ctx.globalAlpha = p._unitOutAlpha(stU, Z) * f * aU; ctx.stroke(path(arr)); } }
        if (U.inner.length) { ctx.strokeStyle = th.border; for (const [f, arr] of byFade(U.inner, 8, 22)) { ctx.globalAlpha = 0.5 * f * aU; ctx.stroke(path(arr)); } }
        ctx.globalAlpha = 1;
      }
      };
      if (old) unitPass(this._unitXYZ(old.st), old.st, old.a);
      unitPass(this._unitXYZ(st), st, aN);
    }
    // the rest frame's company markers (fanned positions kept), names, 主航道 and ①②③ cards ride on the map
    const rest = p._rest && p._rest.st === st ? p._rest : null;
    const mv = rest ? this._mover(rest, C, e, n, RZ) : null;
    const okXY = (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) < Rw * Rw && x > fa.x0 + 2 && x < fa.x1 - 2 && y > fa.y0 + 2 && y < fa.y1 - 2;
    if (fl && old && fl.aPts > 0.004 && fl.st.points && fl.st.points.length) this._flyDots(ctx, fl.st, fl.S, fl.aPts, okXY);
    ctx.globalAlpha = aN;
    if (mv && st.pt) {
      for (const q of st.pt) {
        if (!q.vis) continue;
        const m = mv(q.x, q.y);
        if (!m) continue;
        const tx = m[0] + (q.tx - q.x), ty = m[1] + (q.ty - q.y);
        if (!okXY(tx, ty)) continue;
        if (Math.hypot(q.tx - q.x, q.ty - q.y) > 2) { ctx.strokeStyle = th.inkFaint; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(m[0], m[1]); ctx.lineTo(tx, ty); ctx.stroke(); }
        const r = q.r - 1.6;
        ctx.beginPath(); ctx.arc(tx, ty, r + 1.6, 0, Math.PI * 2); ctx.fillStyle = th.paper; ctx.fill();
        ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.fillStyle = th.ink; ctx.fill();
        ctx.beginPath(); ctx.arc(tx, ty, Math.max(1.2, r - 1.3), 0, Math.PI * 2); ctx.fillStyle = col(q.k); ctx.fill();
      }
    } else if (st.points && st.points.length) {
      for (const k of st.points) {
        const a = S.terr[k].anchor, fa2 = a ? a[0] * c0 + a[1] * c1 + a[2] * c2 : -1;
        if (!a || fa2 < LV + 0.02) continue;
        const ka = RZ * K(fa2), sx = cx + (a[0] * ex + a[1] * ey + a[2] * ez) * ka, sy = cy - (a[0] * nx + a[1] * ny + a[2] * nz) * ka;
        if (!okXY(sx, sy)) continue;
        dots.push([sx, sy, k]);
      }
      for (const [sx, sy, k] of dots) {
        ctx.beginPath(); ctx.arc(sx, sy, 3.6, 0, Math.PI * 2); ctx.fillStyle = col(k); ctx.fill();
        ctx.lineWidth = 1.1; ctx.strokeStyle = th.ink; ctx.stroke();
      }
    }
    // §26 amendment 4: the minority dots ride along too (straight from their lon / lat at the live camera)
    if (real && st.um && st.um.ticks.length) {
      const RADt = Math.PI / 180;
      for (const t of st.um.ticks) {
        const a2 = t.lon * RADt, b2 = t.lat * RADt, cb = Math.cos(b2), x = cb * Math.sin(a2), y = Math.sin(b2), z = cb * Math.cos(a2);
        const ft = x * c0 + y * c1 + z * c2;
        if (ft < LV + 0.05) continue;
        const kt = RZ * K(ft), sx = cx + (x * ex + y * ey + z * ez) * kt, sy = cy - (x * nx + y * ny + z * nz) * kt;
        if (!okXY(sx, sy)) continue;
        const r = clamp(2.4 + 0.55 * Math.log10(Math.max(1e-3, t.w) * 1000), 2.2, 3.6);
        ctx.beginPath(); ctx.arc(sx, sy, r + 1.6, 0, Math.PI * 2); ctx.fillStyle = th.paper; ctx.fill();
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fillStyle = col(t.k); ctx.fill();
        ctx.lineWidth = 1.1; ctx.strokeStyle = th.ink; ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // §26 amendment 5: the rest frame's weather rides along too (wind keeps blowing, fronts / rims / clouds / storms / intel
    // move with their places) — nothing important vanishes while the map moves
    const air = mv ? this._airXf(rest, mv, okXY) : null;
    // (integrator: the ①②③ rims come from the live region paths — exact, as 3D keeps them; through the flat stand-in
    // they drifted 20–30 px off their region away from the middle of a wheel glide)
    this._rimsLive = !!mv && this._spotRims(ctx, terr, Rw, aN);
    if (air) this._rideAir(ctx, rest, mv, air, Rw, 0);
    // cel shading on a whole globe, fading as the real Earth comes close; always the ink limb
    p._drawShade(ctx, cx, cy, Rw, p._porthole(st, Z));
    p._drawVeil(ctx);
    if (air) this._rideAir(ctx, rest, mv, air, Rw, 1);
    if (mv && !p._bare) this._ridePicture(ctx, rest, mv, okXY);
    else if (mv && p._rideWeather) p._rideWeather(ctx, rest, mv, okXY); // (a crossfade's old picture: its weather, no words)
    return true;
  }

  /**
   * The moving picture's region edge (refine-surface's recipe, 3D's EDGE ribbons): an off-white inner rim (1 px at α .88,
   * fading over .5 px), a 1 px ink line inside (shared borders) and a firm ink edge 0.75 px outside every coast — all × a
   * (refine-motion: a level flight's rising / sinking regions).
   */
  static _edges(ctx, land, th, a = 1) {
    ctx.save(); ctx.clip(land, 'evenodd');
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 3; ctx.globalAlpha = 0.2 * a; ctx.stroke(land);
    ctx.lineWidth = 2; ctx.globalAlpha = 0.85 * a; ctx.stroke(land);
    ctx.lineWidth = 1; ctx.strokeStyle = th.ink; ctx.globalAlpha = 0.74 * a; ctx.stroke(land);
    ctx.restore();
    const outside = new Path2D(); outside.rect(-1e4, -1e4, 3e4, 3e4); outside.addPath(land);
    ctx.save();
    ctx.clip(outside, 'evenodd');
    ctx.lineWidth = 1.5; ctx.strokeStyle = th.ink; ctx.globalAlpha = 0.74 * a; ctx.stroke(land);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * The live camera as names2d's LF ({proj(d, r), vis}): the 3D lens at this.cam — for the 主航道 re-drawn from its
   * sphere ends while the map moves (planet.js _rideChannel → names2d _chanLive).
   */
  _liveLF() {
    const p = this.p, c = this.cam;
    if (!c) return null;
    const { cx, cy } = p.view, RZ = (p.view.R0 || p.view.R) * c.zoom, D = p._lensD();
    const v = dirOf(c.lon, c.lat), [e, n] = frameAt(v), sD = D ? Math.sqrt(D * D - 1) : 1;
    const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return {
      vis: (D ? lensVis(D) : 0) + 0.02,
      proj: (d, r = 1) => {
        const fz = dt(d, v), K = D ? sD / Math.max(1e-6, D - r * fz) : 1;
        return [cx + dt(d, e) * RZ * r * K, cy - dt(d, n) * RZ * r * K, fz];
      },
    };
  }

  /**
   * The ①②③ rims on the moving picture from the live region paths (planet.js _drawSpotOutlines' recipe in screen px:
   * a calm breathing paper rim 2.5 px inside, a 1.2 px ink hairline) — true = drawn (the flat stand-in's rims are skipped).
   */
  _spotRims(ctx, terr, Rw, a = 1) {
    const p = this.p, blink = p._blink, th = p.theme;
    if (!blink || !blink.size || !p.spot || !p.spot.length || a <= 0.004) return false;
    const byK = new Map();
    for (const [k, path] of terr) byK.set(k, path);
    const { cx, cy } = p.view, t = performance.now() / 1000, day = th.name === 'day';
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, Rw - 0.5), 0, Math.PI * 2);
    ctx.clip();
    ctx.lineJoin = 'round';
    for (const [k, i] of blink) {
      if (i >= 10) continue;
      const path = byK.get(k);
      if (!path) continue;
      const b = 0.5 + 0.5 * Math.sin(t * 2.0 + i * 2.1);
      ctx.save();
      ctx.clip(path, 'evenodd');
      ctx.lineWidth = 5;
      ctx.strokeStyle = th.rgba(day ? [255, 252, 244] : [250, 242, 224], ((0.35 + 0.35 * b) * a).toFixed(3));
      ctx.stroke(path);
      ctx.restore();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = th.rgba(day ? th.inkRGB : [250, 242, 224], ((0.3 + 0.25 * b) * a).toFixed(3));
      ctx.stroke(path);
    }
    ctx.restore();
    return true;
  }

  /** §26 amendment 5 (a level flight): the old level's regions at the live camera — {terr, land, st, a} for the preview. */
  _flyOld(fl, add) {
    const oc = capsOf(fl.S), kind = fl.st.kind || null, out = { terr: [], land: new Path2D(), st: fl.st, a: clamp(fl.aOld, 0, 1) };
    for (let k = 0; k < oc.terr.length; k++) {
      const kd = kind ? kind[k] : 'land';
      if (kd === 'point') continue;
      const path = new Path2D();
      let any = false;
      for (const P of oc.terr[k]) any = add(path, P) || any;
      if (!any) continue;
      out.terr.push([k, path, kd]);
      if (kd !== 'sea') out.land.addPath(path);
    }
    return out;
  }

  /** The old level's regions sinking back into the land (planet3d.js uRise): fills and edges at alpha old.a. */
  _flyOldPaint(ctx, old, real) {
    const th = this.p.theme, st = old.st, temp = st.cur && st.cur.temp, mid = Math.floor(th.bandCSS.length / 2);
    const bk = (k) => bandOf(clamp(temp && Number.isFinite(temp[k]) ? temp[k] : 0, -3, 3));
    ctx.save();
    for (const [k, path, kd] of old.terr) {
      if (kd === 'sea') { if (bk(k) === mid) continue; ctx.globalAlpha = 0.25 * old.a; } else ctx.globalAlpha = (st.est && st.est[k] && !real ? 0.8 : 1) * old.a;
      ctx.fillStyle = th.bandCSS[bk(k)];
      ctx.fill(path, 'evenodd');
    }
    ctx.lineJoin = 'round';
    if (real) FreeCam2D._edges(ctx, old.land, th, old.a); // (the same paper-cut edge as the new level, at old.a)
    else { ctx.globalAlpha = old.a; ctx.lineWidth = 1.3; ctx.strokeStyle = th.border; ctx.stroke(old.land); }
    ctx.restore();
  }

  /** The old level's company dots fading out during a flight (planet3d.js: its point material, gone by 30 %). */
  _flyDots(ctx, st, S, a, okXY) {
    const p = this.p, th = p.theme, c = this.cam, { cx, cy } = p.view, RZ = (p.view.R0 || p.view.R) * c.zoom;
    const C = dirOf(c.lon, c.lat), [e, n] = frameAt(C), LD = p._lensD(), LV = lensVis(LD), temp = st.cur && st.cur.temp;
    ctx.save();
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.lineWidth = 1.1; ctx.strokeStyle = th.ink;
    for (const k of st.points) {
      const A = S.terr[k] && S.terr[k].anchor;
      if (!A) continue;
      const f = A[0] * C[0] + A[1] * C[1] + A[2] * C[2];
      if (f < LV + 0.02) continue;
      const kz = RZ * lensK(LD, f), sx = cx + (A[0] * e[0] + A[1] * e[1] + A[2] * e[2]) * kz, sy = cy - (A[0] * n[0] + A[1] * n[1] + A[2] * n[2]) * kz;
      if (!okXY(sx, sy)) continue;
      ctx.beginPath(); ctx.arc(sx, sy, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = th.bandCSS[bandOf(clamp(temp && Number.isFinite(temp[k]) ? temp[k] : 0, -3, 3))];
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * §26 amendment 5: a flat stand-in for the mover around the middle of the map — scale + shift fitted from the rest
   * frame to the live camera (north stays up, so no turn) — for the weather that rides along (wind lines, fronts,
   * rims, storms, intel arrows, 挤 / 空). a = how well it holds across the visible map: a big turn of a whole globe
   * (curvature) thins those layers instead of drawing them in the wrong place.
   */
  _airXf(rest, mv, okXY) {
    const p = this.p, R = rest.R, x0 = rest.cx, y0 = rest.cy;
    const m0 = mv(x0, y0);
    if (!m0) return null;
    const h = Math.max(20, Math.min(R * 0.35, 140));
    let ks = 0, nk = 0;
    for (const [dx, dy] of [[h, 0], [-h, 0], [0, h], [0, -h]]) {
      const m = mv(x0 + dx, y0 + dy);
      if (m) { ks += Math.hypot(m[0] - m0[0], m[1] - m0[1]) / h; nk++; }
    }
    if (!nk) return null;
    const k = ks / nk, fa = p._freeArea();
    let err = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const x = fa.x0 + ((i + 0.5) / 4) * (fa.x1 - fa.x0), y = fa.y0 + ((j + 0.5) / 4) * (fa.y1 - fa.y0);
      const m = mv(x, y);
      if (!m || !okXY(m[0], m[1])) continue;
      err = Math.max(err, Math.hypot(m[0] - (m0[0] + (x - x0) * k), m[1] - (m0[1] + (y - y0) * k)));
    }
    return { k, tx: m0[0] - k * x0, ty: m0[1] - k * y0, a: clamp(1 - (err - 3) / 22, 0, 1) };
  }

  /**
   * The rest frame's weather on the moving picture: layer 0 under the shading (wind, fronts, ①②③ rims), 1 above it.
   * When planet.js has its own exact ride (_rideWeather: wind, fronts, storms, clouds, intel moved point by point) only
   * the ①②③ rims and the 挤 / 空 stamps ride here. A crossfade's old picture (planet._bare) carries no words.
   */
  _rideAir(ctx, rest, mv, A, Rw, layer) {
    const p = this.p, st = rest.st, th = p.theme, now = performance.now();
    const own = !p._rideWeather, bare = !!p._bare;
    const { cx, cy } = p.view;
    const fx = Math.min(smooth01((now - (st.revealT0 || 0)) / 650), smooth01((now - (st.fxT0 || st.revealT0 || 0)) / 520));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, Rw - 0.5), 0, Math.PI * 2);
    ctx.clip();
    try {
      if (layer === 0) {
        // the wind keeps blowing in the rest frame's field (it thins only where the flat stand-in stops holding)
        const dt = clamp((now - (this._airT || now)) / 1000, 0, 0.05);
        this._airT = now;
        const P = own ? p.particles : null;
        if (dt > 0 && P && st.L && st.aux) {
          const L = st.L, dim = st.dim, dark = th.bandDark, band = st.band, a = st.aux;
          P.alpha = st.scenOn ? 0.85 : 1;
          P.step(dt, st, p.lens ? (c) => { const o = L.owner[c]; return o >= 0 ? dim[o] : 0; } : null, (c) => dark[band[c]],
            { mask: p._partMask(st, rest.placed), sinkOf: a.sinkOf, sinkCap: a.sinkCap, nSink: a.nSink });
        }
        if (A.a > 0.01) {
          ctx.save();
          ctx.transform(A.k, 0, 0, A.k, A.tx, A.ty);
          ctx.globalAlpha = fx * A.a;
          if (P) P.draw(ctx, rest.cx, rest.cy, rest.R, th);
          ctx.globalAlpha = 1;
          const blink = p._blink || new Set();
          if (own) p._drawFronts(ctx, now, st, blink, fx * A.a);
          if (!this._rimsLive) p._drawSpotOutlines(ctx, now, st, blink, A.a, 1 / Math.max(1e-3, A.k)); // (constant screen width)
          ctx.restore();
        }
      } else {
        const blink = p._blink || new Set();
        if (A.a > 0.01) {
          ctx.save();
          ctx.transform(A.k, 0, 0, A.k, A.tx, A.ty);
          if (own) p._drawStorms(ctx, now, st, blink, fx * A.a);
          // (word stamps — intel tags, 挤 / 空 — ride a pan at their size; a zoom would blow them up, so they step back)
          const wk = bare ? 0 : A.a * clamp(1 - (Math.abs(Math.log(A.k)) - 0.06) / 0.18, 0, 1);
          if (wk > 0.01) {
            if (own) p._drawIntel(ctx, now, st, blink, rest.placed, fx * wk);
            p._drawMarkers(ctx, st, rest.placed, wk);
          }
          ctx.restore();
        }
        // clouds float at their own places (moved one by one, exactly)
        const moved = [];
        for (const b of own ? rest.placed || [] : []) {
          if (!b || !b.cloud) continue;
          const m = mv(b.x + b.w / 2, b.y + b.h / 2);
          if (m) moved.push(Object.assign({}, b, { x: m[0] - b.w / 2, y: m[1] - b.h / 2 }, bare ? { text: null } : {}));
        }
        if (moved.length) p._drawClouds(ctx, now, st, moved, fx);
      }
    } catch (e) { /* (a layer that cannot ride this frame is simply left out) */ }
    ctx.restore();
  }

  /**
   * §26 amendment 5: a camera rebuild at the same level carries the wind over (planet.js setNode): every line and its
   * trail moved from the old view into the new one, so the wind never re-seeds after a nudge. false = not possible.
   */
  carryWind(prev, st) {
    const p = this.p, P = p.particles, rest = p._rest, c = this.built; // (the camera the new view was built at)
    if (P && typeof P.carry === 'function' && rest && rest.st === prev && c) {
      // (§26 amendment 5, planet/streams.js: the streamlines themselves move onto the new view)
      const R0 = p.view.R0 || p.view.R, C = dirOf(c.lon, c.lat), [e, n] = frameAt(C);
      const mv = this._mover(rest, C, e, n, R0 * c.zoom);
      if (!mv) return false;
      const { cx, cy } = p.view, Rn = R0 * (st.ext || 1), Ro = rest.R;
      return P.carry(st, (x, y) => { const m = mv(rest.cx + x * Ro, rest.cy + y * Ro); return m ? [(m[0] - cx) / Rn, (m[1] - cy) / Rn] : null; });
    }
    if (!P || !rest || rest.st !== prev || !c || !(P.x && P.y && P.hx && P.hy && P.age && P.life) || !(P.n > 0)) return false;
    const H = Math.round(P.hx.length / P.x.length);
    if (!(H >= 1)) return false;
    const R0 = p.view.R0 || p.view.R, C = dirOf(c.lon, c.lat), [e, n] = frameAt(C);
    const mv = this._mover(rest, C, e, n, R0 * c.zoom);
    if (!mv) return false;
    const { cx, cy } = p.view, Rn = R0 * (st.ext || 1), Ro = rest.R;
    const to = (x, y) => { const m = mv(rest.cx + x * Ro, rest.cy + y * Ro); return m ? [(m[0] - cx) / Rn, (m[1] - cy) / Rn] : null; };
    for (let i = 0; i < P.n; i++) {
      const q = to(P.x[i], P.y[i]);
      if (!q || Math.abs(q[0]) > 1 || Math.abs(q[1]) > 1) { P.age[i] = P.life[i] + 1; continue; } // (respawned on the next step)
      P.x[i] = q[0]; P.y[i] = q[1];
      for (let j = i * H; j < i * H + H; j++) {
        const r = to(P.hx[j], P.hy[j]);
        if (r) { P.hx[j] = r[0]; P.hy[j] = r[1]; } else { P.hx[j] = q[0]; P.hy[j] = q[1]; }
      }
    }
    return true;
  }

  /**
   * §26 refine: a rest-frame canvas point → where it is under the live camera now (null: behind the globe / no rest
   * frame). Lets getChildScreenRect / placeCaption follow the map while it moves, so the shell's 主航道 pin (ring +
   * card) rides along instead of vanishing mid-drag (3D keeps it too).
   */
  liveXY(x, y, cut = null) {
    const p = this.p, rest = p._rest, c = this.cam;
    if (!rest || rest.st !== p.cur || !c || !this._differs()) return null;
    const R0 = p.view.R0 || p.view.R, C = dirOf(c.lon, c.lat), [e, n] = frameAt(C);
    const mv = this._mover(rest, C, e, n, R0 * c.zoom, cut);
    return mv ? mv(x, y) : null;
  }

  /** zoom of the live camera ÷ the zoom the resting picture was built at (1 when not moving). */
  liveScale() {
    const c = this.cam, b = this.built;
    return c && b && b.zoom > 0 && this._differs() ? c.zoom / b.zoom : 1;
  }

  /**
   * §26 refine: the resting map's admin-unit lines (fold lines inside a territory, faint unclaimed borders) for the
   * moving picture — xyz once per state (with a bounding cap per line for culling), projected per frame.
   */
  _unitXYZ(st) {
    if (!st || !st.um || !st.unitFs) return null;
    if (st._ulx && st._ulx.fs === st.unitFs) return st._ulx;
    const UL = unitLines(st.um, st.unitFs);
    const RAD = Math.PI / 180;
    const conv = (A) => {
      const m = A.length >> 1, out = new Float32Array(m * 3);
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < m; i++) {
        const a = A[2 * i] * RAD, b = A[2 * i + 1] * RAD, cb = Math.cos(b);
        out[3 * i] = cb * Math.sin(a); out[3 * i + 1] = Math.sin(b); out[3 * i + 2] = cb * Math.cos(a);
        sx += out[3 * i]; sy += out[3 * i + 1]; sz += out[3 * i + 2];
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      const cx = sx / l, cy = sy / l, cz = sz / l;
      let rad = 0, len = 0;
      for (let i = 0; i < m; i++) rad = Math.max(rad, Math.acos(clamp(out[3 * i] * cx + out[3 * i + 1] * cy + out[3 * i + 2] * cz, -1, 1)));
      for (let i = 1; i < m; i++) len += Math.hypot(out[3 * i] - out[3 * i - 3], out[3 * i + 1] - out[3 * i - 2], out[3 * i + 2] - out[3 * i - 1]);
      return { p: out, cap: [cx, cy, cz, rad], len }; // (len: the arc's chord sum, rad — its fade on screen)
    };
    st._ulx = { fs: st.unitFs, inner: UL.inner.map((x) => conv(x[1])), neutral: UL.neutral.map(conv) };
    return st._ulx;
  }

  /**
   * §26 amendment 5: the rest frame's ①②③ cards on the moving picture. A card rides with its place; when the place
   * leaves the free screen (or goes over the horizon) the card waits at the edge as its chip — dashed arrow toward the
   * place, on the ray from the free area's middle (3D labels.js _edgeSpot) — instead of blinking out until the camera
   * rests (3D keeps it). An edge chip at rest stays where it is.
   */
  _rideCards(rest, mv, okXY) {
    const p = this.p, fa = p._freeArea(), mx = (fa.x0 + fa.x1) / 2, my = (fa.y0 + fa.y1) / 2, out = [], m = 22;
    for (const c0 of rest.caps) {
      if (c0.edge) { out.push(c0); continue; }
      const q = mv(c0.ax, c0.ay);
      if (q && okXY(q[0], q[1])) { out.push(Object.assign({}, c0, { ax: q[0], ay: q[1], x: c0.x + q[0] - c0.ax, y: c0.y + q[1] - c0.ay })); continue; }
      const d = q ? [q[0] - mx, q[1] - my] : this._liveDir(rest, c0.ax, c0.ay);
      const l = d ? Math.hypot(d[0], d[1]) : 0;
      if (!(l > 1e-6)) continue;
      const dx = d[0] / l, dy = d[1] / l;
      const tx = dx > 0 ? (fa.x1 - m - mx) / dx : dx < 0 ? (fa.x0 + m - mx) / dx : Infinity;
      const ty = dy > 0 ? (fa.y1 - m - my) / dy : dy < 0 ? (fa.y0 + m - my) / dy : Infinity;
      const t = Math.max(0, Math.min(tx, ty)), ex = mx + dx * t, ey = my + dy * t;
      const xt = this._chipTo(rest.st, c0) || {}, cw = xt.w || c0.w, ch = xt.h || c0.h;
      const g = 20 + (Math.abs(dx) * cw) / 2 + (Math.abs(dy) * ch) / 2; // (the card stands 20 px inside its arrow)
      const x = clamp(ex - dx * g - cw / 2, fa.x0 + 6, Math.max(fa.x0 + 6, fa.x1 - 6 - cw));
      const y = clamp(ey - dy * g - ch / 2, fa.y0 + 6, Math.max(fa.y0 + 6, fa.y1 - 6 - ch));
      out.push(Object.assign({}, c0, xt, { ax: ex, ay: ey, x, y, edge: { dx, dy }, ride: true }));
    }
    // (chips that land on each other step apart along their edge)
    for (let it = 0; it < 4; it++) {
      let moved = false;
      for (let i = 0; i < out.length; i++) {
        const a = out[i];
        if (!a.ride) continue;
        for (let j = 0; j < out.length; j++) {
          const b = out[j];
          if (i === j || (b.ride && j > i)) continue;
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + 6, oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + 6;
          if (ox <= 6 || oy <= 6) continue;
          if (Math.abs(a.edge.dx) >= Math.abs(a.edge.dy)) { const sg = a.y + a.h / 2 >= b.y + b.h / 2 ? 1 : -1; a.y = clamp(a.y + sg * oy, fa.y0 + 6, Math.max(fa.y0 + 6, fa.y1 - 6 - a.h)); }
          else { const sg = a.x + a.w / 2 >= b.x + b.w / 2 ? 1 : -1; a.x = clamp(a.x + sg * ox, fa.x0 + 6, Math.max(fa.x0 + 6, fa.x1 - 6 - a.w)); }
          moved = true;
        }
      }
      if (!moved) break;
    }
    return out;
  }

  /** A riding chip says where its arrow points, as 3D's edge chips do: 「… → 地名」 (names2d.js _layoutCards: the same label). */
  _chipTo(st, c0) {
    const p = this.p, k = c0.k;
    if (!st.real || k == null || c0.to) return null;
    const deep = String(c0.key || '').split('|')[1] || '';
    const foc = deep && st.focus ? st.focus.get(deep) : null;
    const mo = !deep && !(st.kind && st.kind[k] === 'point') && st.money ? st.money.get(k) : null;
    const offL = st.where && st.where.get(k) ? String(st.where.get(k)).replace(/^→\s*/, '') : null;
    const lab = deep ? (foc && foc.label) || null : mo ? (offL && mo.label && offL.includes(mo.label) ? offL : mo.label) : null;
    if (!lab || String(c0.why || '').includes(lab) || !c0.fw || typeof p._tw !== 'function') return null;
    const to = '→ ' + lab, lines = (c0.lines || []).slice();
    if (lines.length) lines[lines.length - 1] += ' ' + to; else lines.push(to);
    const w = Math.max(c0.w, Math.ceil(p._tw(lines[lines.length - 1], c0.fw)) + 18);
    return { lines, to, w, h: c0.h + ((c0.lines || []).length ? 0 : 17) };
  }

  /** The screen direction (from the middle) toward a rest-frame point's place at the live camera — over the horizon too. */
  _liveDir(rest, x, y) {
    const st = rest.st, f = st.frame, c = this.cam;
    if (!f || !c) return null;
    const v = f.v, [e0, n0] = frameAt(v), Zl = f.Zl || 1;
    let px = (x - rest.cx) / rest.R / Zl, py = (y - rest.cy) / rest.R / Zl, pz;
    const r2 = px * px + py * py;
    if (f.D) { const q = lensInv(f.D, px, py); if (!q) return null; [px, py, pz] = q; } else { if (r2 > 1) return null; pz = Math.sqrt(1 - r2); }
    const d = [0, 1, 2].map((i) => px * e0[i] - py * n0[i] + pz * v[i]);
    const C = dirOf(c.lon, c.lat), [e, n] = frameAt(C);
    return [d[0] * e[0] + d[1] * e[1] + d[2] * e[2], -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2])];
  }

  /** Rest-frame screen point → live camera screen point (null when it went behind the globe). */
  _mover(rest, C, e, n, RZ, cut = null) {
    const st = rest.st, f = st.frame;
    if (!f) return null;
    const v = f.v, [e0, n0] = frameAt(v), Zl = f.Zl || 1, D0 = f.D || 0;
    const { cx, cy } = this.p.view, R = rest.R;
    const LD = this.p._lensD(), LV = lensVis(LD);
    return (x, y) => {
      let px = (x - rest.cx) / R / Zl, py = (y - rest.cy) / R / Zl;
      const r2 = px * px + py * py;
      if (r2 > 1) return null;
      let pz;
      if (D0) { const q = lensInv(D0, px, py); if (!q) return null; px = q[0]; py = q[1]; pz = q[2]; } else pz = Math.sqrt(1 - r2); // (the rest frame's lens)
      const d0 = px * e0[0] - py * n0[0] + pz * v[0], d1 = px * e0[1] - py * n0[1] + pz * v[1], d2 = px * e0[2] - py * n0[2] + pz * v[2];
      const fz = d0 * C[0] + d1 * C[1] + d2 * C[2];
      if (fz < (cut != null ? cut : LV + 0.04)) return null; // (cut: a caller's own horizon — the shell's pin, 3D's)
      const k = RZ * lensK(LD, fz);
      return [cx + (d0 * e[0] + d1 * e[1] + d2 * e[2]) * k, cy - (d0 * n[0] + d1 * n[1] + d2 * n[2]) * k];
    };
  }

  /** The rest frame's names, 主航道 and ①②③ cards, moved with their places (planet.js draws them). */
  _ridePicture(ctx, rest, mv, okXY) {
    const p = this.p, st = rest.st;
    if (p._rideWeather) p._rideWeather(ctx, rest, mv, okXY); // §26 amendment 5: the weather rides along too (planet.js)
    if (rest.chan && !rest.chan.curve) p._rideChannel(ctx, st, rest.chan, null, null, mv); // (a one-place route: its ring)
    else if (rest.chan) {
      // an end that slid off the window: pulled along the route to where it is still on the map (as at rest), so the
      // arc and its caption stay while the globe turns
      const c = rest.chan.curve;
      let A = mv(c.A[0], c.A[1]), B = mv(c.B[0], c.B[1]);
      if (!A || !B) {
        const at = (t) => { const u = 1 - t; return [u * u * c.A[0] + 2 * u * t * c.C[0] + t * t * c.B[0], u * u * c.A[1] + 2 * u * t * c.C[1] + t * t * c.B[1]]; };
        const find = (t0, dt) => { for (let t = t0; t >= 0 && t <= 1; t += dt) { const q = at(t), m = mv(q[0], q[1]); if (m && okXY(m[0], m[1])) return m; } return null; };
        if (!A) A = find(0, 0.04);
        if (!B) B = find(1, -0.04);
      }
      // (integrator: a short route rides too — _rideChannel draws its arc only when it is long enough, its caption always)
      if (A && B) p._rideChannel(ctx, st, rest.chan, A, B, mv, this._liveLF());
    }
    p._drawLabels(ctx, st, rest.placed, 1, (b) => {
      const m = mv(b.it.ax, b.it.ay);
      if (!m || !okXY(m[0], m[1])) return null;
      return [m[0] - b.it.ax, m[1] - b.it.ay];
    });
    if (rest.caps && rest.caps.length) p._paintCaptions(ctx, st, this._rideCards(rest, mv, okXY), 1);
    p._drawExtLeader(ctx, performance.now(), 1, mv); // (the shell's 主航道 card rides along through placeCaption)
  }
}
