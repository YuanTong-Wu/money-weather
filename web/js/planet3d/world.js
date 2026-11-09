// planet3d/world.js — one planet in 3D (§22 + §25): the node's weather values (the same date lerp, §14 estimate
// and §9 scenario rules as planet.js), a wind field on the sphere, and the toon body — a small Earth: every
// child is a landmass (spherical polygons from geo/index.js, prepared by planet/sphere.js) raised as a paper-cut
// plate (a shelf + |wind|: money has volume), in a calm sea that covers the rest of the globe.
//
// All positions are unit vectors in the planet's object space (see core.js). Territory k:
//   anchorDir[k] (label / arc anchor, deep inside), angR[k] (equivalent angular radius), areas[k] (sr).

import { BAND_EDGES as EDGES, bandOf } from '../planet/theme.js';
import { hashStr, makeNoise2 } from '../planet/util.js';
import { unitFiles, unitLines } from '../planet/units.js'; // §26 amendment 4: admin-unit borders, ticks, tiny rings
import {
  THREE, MAXT, BASE_R, BAND_EDGES, frame3, offsetDir, PLATE_VS, PLATE_FS, HULL_VS, FLAT_FS, OCEAN_VS, OCEAN_FS, PLATE_HULL_VS, BORDER_VS, BORDER_FS,
  SEAAREA_VS, SEAAREA_FS, SEALINE_VS, SEALINE_FS, POINT_VS, POINT_FS, HINT_VS, HINT_FS, EDGE_VS, EDGE_FS,
} from './core.js';

const KEYS = ['wind', 'temp', 'pres', 'storm'];
export const LAGS = ['now', '1-3m', '3-12m', '1y+'];
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// wind grid (equirect cell centres) and tuning (radians, seconds)
export const WW = 192, WH = 96, WN = WW * WH;
export const WIND = { kGrad: 0.11, kSwirl: 0.05, amb: 0.016, vmax: 0.26 };

export function valAt(series, key, i) {
  const a = series && series[key];
  if (!a || !a.length || i == null) return NaN;
  const v = a[Math.max(0, Math.min(i, a.length - 1))];
  return v == null ? NaN : +v;
}
export function seriesLen(map) {
  if (!map) return 0;
  const s = map.self && map.self.wind;
  if (s && s.length) return s.length;
  for (const k in map.children || {}) {
    const w = map.children[k] && map.children[k].wind;
    if (w && w.length) return w.length;
  }
  return 0;
}
/** §8.2 season rule → 0 spring, 1 summer, 2 autumn, 3 winter, -1 none. */
export function seasonRule(w, dw, p) {
  if (!Number.isFinite(w) || !Number.isFinite(p)) return -1;
  if (!Number.isFinite(dw)) dw = 0;
  if (w > 0.3 && dw > 0.3 && p < 65) return 0;
  if ((w < -0.3 && p >= 50) || (dw < -0.6 && p >= 65)) return 2;
  if (w > 0.3 && p >= 65) return 1;
  if ((w < -0.3 && p < 50) || (Math.abs(w) <= 0.3 && p < 35)) return 3;
  return -1;
}
/**
 * Plate height above the sea (planet radius = 1) for a wind value: a low shelf for every landmass, then
 * |wind| — the real movers (in OR out) stand up: |w| 1 → ≈ 0.03, 2 → ≈ 0.055, 3 → 0.08.
 */
export const SHELF = 0.009;
export const NEUTRAL_H = 0.0025;
export const heightOf = (w) => {
  if (!Number.isFinite(w)) return SHELF;
  const a = Math.min(3, Math.abs(w));
  return SHELF + 0.072 * Math.pow(clamp((a - 0.25) / 2.75, 0, 1), 1.1);
};
export const limbFade = () => 1;

const GLOBAL_GW = { lonC: 0, lon0: -Math.PI, dLon: TAU, lat1: Math.PI / 2, dLat: Math.PI, wrap: true, W: WW, H: WH };
/** The wind grid: the whole globe (equirect, wraps) or — §26, a zoomed real Earth — a lon/lat window around the view. */
function windGrid(box) {
  if (!box) return GLOBAL_GW;
  const R = Math.PI / 180;
  const lat0 = Math.max(-88, Math.min(box.lat0, box.lat1)) * R, lat1 = Math.min(88, Math.max(box.lat0, box.lat1)) * R;
  const dLon = Math.min(TAU, Math.max(0.01, box.span * R));
  const W = WW, H = Math.max(24, Math.min(160, Math.round(WW * (lat1 - lat0) / (dLon * Math.max(0.2, Math.cos((lat0 + lat1) / 2))))));
  return { lonC: box.lon * R, lon0: -dLon / 2, dLon, lat1, dLat: lat1 - lat0, wrap: dLon >= TAU - 1e-6, W, H };
}
const wrapPi = (a) => (a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a);
const cellDirG = (G, i, j, out) => {
  const lon = G.lonC + G.lon0 + ((i + 0.5) / G.W) * G.dLon, lat = G.lat1 - ((j + 0.5) / G.H) * G.dLat;
  const c = Math.cos(lat);
  out[0] = c * Math.sin(lon); out[1] = Math.sin(lat); out[2] = c * Math.cos(lon);
  return out;
};
const rowLatG = (G, j) => G.lat1 - ((j + 0.5) / G.H) * G.dLat;

// ================================================================================================ World
export class World {
  /**
   * @param ctx  {U (shared uniforms), look, D, Rpx}
   * @param S    prepared sphere layout (planet/sphere.js prepareSphere) for node's children
   */
  constructor(ctx, node, map, dateIndex, ov, S, opts = {}) {
    this.ctx = ctx;
    // §26 real Earth: no sea / globe of its own (planet3d/globe.js draws the Earth), a windowed wind grid, sizes ×ws
    this.real = !!opts.real;
    this.ws = opts.ws || 1;
    this.hintsIn = opts.hints || null; // Map(k → [[lon, lat, label], …]) — sea areas' producing regions
    // §26 amendment 4: the layout's admin units (planet/units.js unitModel) — fold lines, unclaimed borders, ticks
    this.um = opts.units || null;
    this.unitBox = opts.windBox || null; // (unit borders are kept to the camera's window)
    this.gw = windGrid(opts.windBox || null);
    this.node = node;
    this.map = map || null;
    this.children = Array.isArray(node.children) ? node.children : [];
    const n = (this.n = this.children.length);
    this.S = S;
    this.idxOf = new Map(this.children.map((c, k) => [c.id, k]));
    const F32 = () => new Float32Array(n);
    this.cur = { wind: F32(), temp: F32(), pres: F32(), storm: F32() };
    this.from = { wind: F32(), temp: F32(), pres: F32(), storm: F32() };
    this.to = { wind: F32(), temp: F32(), pres: F32(), storm: F32() };
    this.front = new Int8Array(n);
    this.season = new Int8Array(n).fill(-1);
    this.est = new Uint8Array(n);
    this.scen = new Array(n).fill(null);
    this.self = { cur: 0, from: 0, to: 0 };
    this.lerpS = null;
    this.bandK = new Uint8Array(n);
    const GN = this.gw.W * this.gw.H;
    this.vel = new Float32Array(GN * 3);
    this.spdG = new Float32Array(GN);
    this.Hg = new Float32Array(GN);
    this.maxSpd = 0;
    this.dim = F32(); this.dimTarget = F32();
    this.h = F32();
    this.lift = F32();
    this.liftTarget = F32();
    this.estOv = new Set();
    this.camObj = new THREE.Vector3(0, 0, 1);
    this.scenOn = false;
    const T = (k) => (S && S.terr[k]) || { anchor: [0, 0, 1], center: [0, 0, 1], angR: 0.1, area: 0.03, inR: 0.05, cands: [[0, 0, 1]], polys: [], kind: 'land' };
    this.kind = this.children.map((c, k) => T(k).kind || 'land');
    this.flat = this.kind.map((kd) => kd !== 'land'); // sea areas and points never stand up as plates
    this.anchorDir = this.children.map((c, k) => new THREE.Vector3(...T(k).anchor).normalize());
    // §26 where the money is (real.js hub, else the anchor): 主航道 ends and ①②③ leaders aim here
    this.hubDir = this.children.map((c, k) => new THREE.Vector3(...(T(k).hub || T(k).anchor)).normalize());
    // §26 the landmass pieces of each territory (zoomed-in labels: '金融 · 纽约'), biggest first
    this.parts = this.children.map((c, k) => (T(k).parts || []).map((p) => Object.assign({}, p, { d: new THREE.Vector3(...p.dir).normalize() })));
    this.city = this.children.map((c, k) => T(k).city || null);
    this.off = this.children.map((c, k) => T(k).off || null); // §26 '→ 新竹 台积电' (real.js offscreen)
    this.centerDir = this.children.map((c, k) => new THREE.Vector3(...T(k).center).normalize());
    this.angR = this.children.map((c, k) => T(k).angR);
    this.partR = this.children.map((c, k) => T(k).partR || T(k).angR); // the size of the piece the anchor sits on
    this.areas = this.children.map((c, k) => T(k).area);
    this.inR = this.children.map((c, k) => T(k).inR);
    this._cands = this.children.map((c, k) => (T(k).cands || []).map((p) => new THREE.Vector3(...p)));
    this.frontDir = new THREE.Vector3(...((S && S.front) || [0, 0, 1])).normalize();
    // compatibility with code that still reads w.L.* (areas, rEq in "radians")
    this.L = { n, areas: this.areas, rEq: this.angR, anchors: this.anchorDir };
    // low-res owner grid (wind relief + seeding)
    const G = this.gw;
    this.ownLo = new Int16Array(GN);
    const v = [0, 0, 0];
    for (let j = 0; j < G.H; j++) for (let i = 0; i < G.W; i++) { cellDirG(G, i, j, v); this.ownLo[j * G.W + i] = S ? S.ownerAt(v[0], v[1], v[2]) : -1; }
    // a company (point) is smaller than a wind cell: give it its own cell so money can flow to it
    if (this.real) for (let k = 0; k < n; k++) if (this.kind[k] === 'point') { const c = this._cellOf(this.anchorDir[k]); if (c >= 0) this.ownLo[c] = k; }
    this.applyDate(dateIndex, false, ov);
    this.recompute();
    for (let k = 0; k < n; k++) this.h[k] = this._hTarget(k);
    this._build();
  }

  /** Wind-grid cell of a direction (−1 outside a window). */
  _cellOf(d) {
    const G = this.gw;
    const x = d.x !== undefined ? d.x : d[0], y = d.y !== undefined ? d.y : d[1], z = d.z !== undefined ? d.z : d[2];
    const l = Math.hypot(x, y, z) || 1;
    const lon = wrapPi(Math.atan2(x, z) - G.lonC), lat = Math.asin(clamp(y / l, -1, 1));
    let i = Math.floor(((lon - G.lon0) / G.dLon) * G.W), j = Math.floor(((G.lat1 - lat) / G.dLat) * G.H);
    if (G.wrap) { i = ((i % G.W) + G.W) % G.W; j = clamp(j, 0, G.H - 1); } else if (i < 0 || j < 0 || i >= G.W || j >= G.H) return -1;
    return j * G.W + i;
  }
  /** Plate height target for territory k (sea areas / points stay flat; ×ws so a zoomed Earth keeps its proportions). */
  _hTarget(k) { return this.flat[k] ? 0 : Math.min(this.hCap(), heightOf(this.cur.wind[k]) * this.hs()); }
  /** Height scale: plates keep their on-screen size when the camera zooms (√ so a zoomed view still has relief). */
  hs() { return this.real ? 0.42 * Math.sqrt(this.ws) : 1; }
  /**
   * Cap on plate height (planet radius = 1): at globe scale a plate is a paper cut, not a brick — 0.5 % of the
   * radius on the real Earth while the whole globe shows (zoom ≤ 1.5), easing back to the money relief by zoom 2.5;
   * the abstract planets keep a gentle relief (≤ 3.5 %).
   */
  hCap() {
    if (!this.real) return 0.035;
    const z = this.zoomNow || 1 / Math.max(1e-3, this.ws);
    const t = Math.min(1, Math.max(0, (z - 1.5) / 1.0));
    return 0.005 + t * 0.06;
  }

  // ------------------------------------------------------------------------------------------ values
  applyDate(i, animate, ov) {
    const map = this.map, n = this.n;
    const useNow = !map;
    const sc = ov && ov.scenario && ov.scenario.nodes ? ov.scenario : null;
    const stageIdx = sc ? (LAGS.indexOf(sc.stage) >= 0 ? LAGS.indexOf(sc.stage) : LAGS.length - 1) : 0;
    const selfS = map ? map.self : null;
    for (let k = 0; k < n; k++) {
      const ch = this.children[k];
      const s = map && map.children ? map.children[ch.id] : null;
      for (const key of KEYS) this.to[key][k] = useNow ? (ch.now && ch.now[key] != null ? +ch.now[key] : NaN) : valAt(s, key, i);
      let missing = false;
      if (!Number.isFinite(this.to.wind[k]) && !Number.isFinite(this.to.temp[k])) {
        missing = true; // §14: inherit the parent's weather, dimmed, marked as an estimate
        const pw = useNow ? (this.node.now ? +this.node.now.wind : NaN) : valAt(selfS, 'wind', i);
        const pt = useNow ? (this.node.now ? +this.node.now.temp : NaN) : valAt(selfS, 'temp', i);
        const pp = useNow ? (this.node.now ? +this.node.now.pres : NaN) : valAt(selfS, 'pres', i);
        this.to.wind[k] = Number.isFinite(pw) ? pw * 0.6 : 0;
        this.to.temp[k] = Number.isFinite(pt) ? pt * 0.6 : 0;
        this.to.pres[k] = Number.isFinite(pp) ? pp : 50;
        this.to.storm[k] = 0;
      }
      if (!Number.isFinite(this.to.wind[k])) this.to.wind[k] = 0;
      if (!Number.isFinite(this.to.temp[k])) this.to.temp[k] = 0;
      if (!Number.isFinite(this.to.pres[k])) this.to.pres[k] = 50;
      if (!Number.isFinite(this.to.storm[k])) this.to.storm[k] = 0;
      this.est[k] = missing ? 1 : 0;
      const f = useNow ? (ch.now && ch.now.front) || 0 : valAt(s, 'front', i);
      this.front[k] = !missing && Number.isFinite(f) ? Math.sign(f) : 0;
      const w = this.to.wind[k];
      const w5 = useNow ? NaN : valAt(s, 'wind', i - 5);
      this.season[k] = missing ? -1 : seasonRule(w, Number.isFinite(w5) ? w - w5 : 0, this.to.pres[k]);
      if (sc) {
        const info = sc.nodes[ch.id] || null;
        let on = false, imp = 0;
        if (info) {
          const li = LAGS.indexOf(info.lag);
          on = (li < 0 ? 0 : li) <= stageIdx;
          const rawI = Number.isFinite(+info.impact) ? +info.impact : (info.dir || 0) * (+info.strength || 1);
          imp = on ? clamp(rawI, -3, 3) : 0;
        }
        this.scen[k] = info ? Object.assign({}, info, { on, value: imp }) : null;
        this.to.temp[k] = imp; this.to.wind[k] = imp; this.to.pres[k] = 50; this.to.storm[k] = 0; this.front[k] = 0;
      } else this.scen[k] = null;
    }
    if (sc) {
      const si = sc.nodes[this.node.id];
      this.self.to = si && Number.isFinite(+si.impact) ? clamp(+si.impact, -3, 3) : 0;
    } else {
      this.self.to = map ? valAt(map.self, 'temp', i) : this.node.now ? +this.node.now.temp : NaN;
      if (!Number.isFinite(this.self.to)) this.self.to = 0;
    }
    this.scenOn = !!sc;
    if (animate) {
      for (const key of KEYS) {
        const c = this.cur[key], f = this.from[key];
        for (let k = 0; k < n; k++) f[k] = c[k];
      }
      this.self.from = this.self.cur;
      this.lerpS = { t0: performance.now(), dur: sc ? 650 : 320 };
    } else {
      for (const key of KEYS) this.cur[key].set(this.to[key]);
      this.self.cur = this.self.to;
      this.lerpS = null;
    }
  }

  /** 0 idle, 1 lerping, 2 just finished. */
  stepLerp(now) {
    const ls = this.lerpS;
    if (!ls) return 0;
    const u = clamp((now - ls.t0) / ls.dur, 0, 1);
    const e = this.scenOn ? easeInOutCubic(u) : easeOutCubic(u);
    for (const key of KEYS) {
      const c = this.cur[key], f = this.from[key], t = this.to[key];
      for (let k = 0; k < this.n; k++) c[k] = lerp(f[k], t[k], e);
    }
    this.self.cur = lerp(this.self.from, this.self.to, e);
    if (u >= 1) { this.lerpS = null; return 2; }
    return 1;
  }

  // ------------------------------------------------------------------------------------------ wind field
  /**
   * Per-territory pull kernels (lazy), built on the real coastline: K_k points from the open sea straight at k's
   * nearest coast, strongest right at the shore and fading out over a stretch of open water (wider for big
   * landmasses), weak inland (lines that reach land soon stop) — so money visibly crosses the water from outflow
   * coasts toward inflow coasts, and nothing converges on a landmass's centre.
   */
  _kernels() {
    if (this._K) return this._K;
    const n = this.n;
    const K = new Array(n);
    const v = [0, 0, 0];
    const G = this.gw, WW = G.W, WH = G.H, WN = WW * WH, wrap = G.wrap;
    const px = G.dLon / WW, py = G.dLat / WH;
    const cs = new Float32Array(WH);
    for (let j = 0; j < WH; j++) cs[j] = Math.max(0.05, Math.cos(rowLatG(G, j)));
    const D = new Float32Array(WN);
    const ws = this.ws;
    for (let k = 0; k < n; k++) {
      // distance (rad) from every cell to territory k's land (two-pass chamfer, wraps in longitude)
      for (let c = 0; c < WN; c++) D[c] = this.ownLo[c] === k ? 0 : 1e9;
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < WH; j++) for (let i = 0; i < WW; i++) {
          const c = j * WW + i; let m = D[c];
          const h = cs[j] * px, g = Math.hypot(cs[j] * px, py), il = wrap ? (i + WW - 1) % WW : Math.max(0, i - 1), ir = wrap ? (i + 1) % WW : Math.min(WW - 1, i + 1);
          m = Math.min(m, D[j * WW + il] + h);
          if (j > 0) m = Math.min(m, D[c - WW] + py, D[(j - 1) * WW + il] + g, D[(j - 1) * WW + ir] + g);
          D[c] = m;
        }
        for (let j = WH - 1; j >= 0; j--) for (let i = WW - 1; i >= 0; i--) {
          const c = j * WW + i; let m = D[c];
          const h = cs[j] * px, g = Math.hypot(cs[j] * px, py), il = wrap ? (i + WW - 1) % WW : Math.max(0, i - 1), ir = wrap ? (i + 1) % WW : Math.min(WW - 1, i + 1);
          m = Math.min(m, D[j * WW + ir] + h);
          if (j < WH - 1) m = Math.min(m, D[c + WW] + py, D[(j + 1) * WW + il] + g, D[(j + 1) * WW + ir] + g);
          D[c] = m;
        }
      }
      const a3 = new Float32Array(WN * 3);
      const c0 = this.anchorDir[k];
      // (§26 amendment 5, one wind with 2D — planet/fields.js coastWind: a cyclone is capped in screen size — σ ≤ 0.2 view
      // units, so the swirl round a big territory at ×30 no longer fills the whole screen)
      const sig = 0.1 * ws + 0.4 * Math.min(Math.max(this.angR[k], 0.012 * ws), 0.25 * ws);
      let any = false;
      for (let j = 0; j < WH; j++) for (let i = 0; i < WW; i++) {
        const c = j * WW + i, d = D[c];
        if (d > 3.2 * sig) continue;
        cellDirG(G, i, j, v);
        let gx, gy, gz, mag;
        if (d <= 0) {
          // inland: a weak pull toward the middle (lines that come ashore slow down and stop)
          const dd = clamp(v[0] * c0.x + v[1] * c0.y + v[2] * c0.z, -1, 1);
          gx = c0.x - dd * v[0]; gy = c0.y - dd * v[1]; gz = c0.z - dd * v[2];
          const l = Math.hypot(gx, gy, gz);
          if (l < 1e-6) continue;
          gx /= l; gy /= l; gz /= l;
          mag = 0.08;
        } else {
          // toward the coast: minus the gradient of the distance (east / north finite differences)
          const il = wrap ? (i + WW - 1) % WW : Math.max(0, i - 1), ir = wrap ? (i + 1) % WW : Math.min(WW - 1, i + 1);
          const dE = (D[j * WW + ir] - D[j * WW + il]) / (Math.max(1, ir - il + (ir < il ? WW : 0)) * cs[j] * px);
          const dN = j > 0 && j < WH - 1 ? (D[c - WW] - D[c + WW]) / (2 * py) : 0;
          const ex = v[2], ez = -v[0], el = Math.hypot(ex, ez) || 1;
          const nx = -v[1] * v[0], ny = v[0] * v[0] + v[2] * v[2], nz = -v[1] * v[2], nl = Math.hypot(nx, ny, nz) || 1;
          gx = -(dE * ex / el + dN * nx / nl); gy = -(dN * ny / nl); gz = -(dE * ez / el + dN * nz / nl);
          const l = Math.hypot(gx, gy, gz);
          if (l < 1e-6) continue;
          gx /= l; gy /= l; gz /= l;
          mag = Math.exp(-d / sig) * (0.55 + 0.45 * Math.min(1, d / (0.4 * sig)));
        }
        // §17 streamlines spiral in (never radial spokes into a city): rotate the pull 35° about the local up —
        // times the signed wind this is cyclonic for inflow and anticyclonic for outflow (mirrored south of the equator)
        if (d > 0) {
          const hem = v[1] < 0 ? -1 : 1;
          const tx = (gy * v[2] - gz * v[1]) * hem, ty = (gz * v[0] - gx * v[2]) * hem, tz = (gx * v[1] - gy * v[0]) * hem;
          // (refine #5: the same wind language as 2D — the turn grows toward the coast, up to ~78° right at it, so the
          // lines curl round a sink like a small cyclone instead of running in as straight pins)
          // (§26 amendment 5, one wind with 2D — planet/fields.js coastWind: 50° out at sea, ~82° at the coast, so even the
          // far lines spiral in instead of reading as a ring of spokes round a city at ×60)
          const th = (50 + 32 * Math.exp(-d / (0.55 * sig))) * (Math.PI / 180);
          const C = Math.cos(th), Sn = Math.sin(th);
          const rx = C * gx + Sn * tx, ry = C * gy + Sn * ty, rz = C * gz + Sn * tz;
          gx = rx; gy = ry; gz = rz;
        }
        a3[3 * c] = gx * mag; a3[3 * c + 1] = gy * mag; a3[3 * c + 2] = gz * mag;
        any = true;
      }
      K[k] = any ? a3 : null;
    }
    // ambient drift: a gentle curl-noise breeze + trade-wind-like zonal flow (calm planets still breathe)
    const amb = new Float32Array(WN * 3);
    const nz = makeNoise2(hashStr('amb:' + this.node.id));
    for (let j = 0; j < WH; j++) for (let i = 0; i < WW; i++) {
      cellDirG(G, i, j, v);
      const lat = rowLatG(G, j);
      const e = [v[2], 0, -v[0]], el = Math.hypot(e[0], e[2]) || 1;
      const zon = Math.cos(3 * lat) * 0.6;
      const nf = 2.2 / Math.sqrt(ws), t1 = nz(v[0] * nf + 5, v[1] * nf + v[2] * 1.3 * nf / 2.2), t2 = nz(v[2] * nf - 3, v[1] * nf - v[0] * 1.3 * nf / 2.2);
      const q = (j * WW + i) * 3;
      // east and north at this cell
      const nrt = [-(v[1] * v[0]), v[0] * v[0] + v[2] * v[2], -(v[1] * v[2])];
      const nl = Math.hypot(nrt[0], nrt[1], nrt[2]) || 1;
      amb[q] = (zon + 0.5 * t1) * (e[0] / el) + 0.5 * t2 * (nrt[0] / nl);
      amb[q + 1] = 0.5 * t2 * (nrt[1] / nl);
      amb[q + 2] = (zon + 0.5 * t1) * (e[2] / el) + 0.5 * t2 * (nrt[2] / nl);
    }
    this._amb = amb;
    return (this._K = K);
  }

  recompute() {
    const n = this.n;
    for (let k = 0; k < n; k++) this.bandK[k] = bandOf(clamp(this.cur.temp[k], -3, 3));
    const K = this._kernels(), vel = this.vel, amb = this._amb;
    const G = this.gw, WW = G.W, WH = G.H, WN = WW * WH, ws = this.ws;
    const kG = WIND.kGrad * ws;
    for (let q = 0; q < WN * 3; q++) vel[q] = WIND.amb * ws * amb[q];
    for (let k = 0; k < n; k++) {
      const w = this.cur.wind[k];
      if (!w || !K[k]) continue;
      const s = kG * w, a = K[k];
      for (let q = 0; q < WN * 3; q++) vel[q] += s * a[q];
    }
    // strong inflow: a gentle swirl over the landmass (money circling in, never a point sink)
    const v = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const w = this.cur.wind[k];
      if (!(w > 0.9)) continue;
      const c = this.anchorDir[k], rc = Math.max(0.05 * ws, 0.55 * this.angR[k]);
      const st = WIND.kSwirl * ws * Math.min(2.2, w - 0.8);
      for (let j = 0; j < WH; j++) for (let i = 0; i < WW; i++) {
        cellDirG(G, i, j, v);
        const d = clamp(v[0] * c.x + v[1] * c.y + v[2] * c.z, -1, 1);
        const a = Math.acos(d);
        if (a > 3 * rc || a < 1e-4) continue;
        const prof = (a / rc) * Math.exp(1 - a / rc) * st;
        // tangential: c × p (counter-clockwise seen from outside), slight inward spiral
        const tx = c.y * v[2] - c.z * v[1], ty = c.z * v[0] - c.x * v[2], tz = c.x * v[1] - c.y * v[0];
        const tl = Math.hypot(tx, ty, tz) || 1;
        const ix = c.x - d * v[0], iy = c.y - d * v[1], iz = c.z - d * v[2];
        const il = Math.hypot(ix, iy, iz) || 1;
        const q = (j * WW + i) * 3;
        vel[q] += prof * (tx / tl + 0.35 * ix / il); vel[q + 1] += prof * (ty / tl + 0.35 * iy / il); vel[q + 2] += prof * (tz / tl + 0.35 * iz / il);
      }
    }
    const vmax = WIND.vmax * ws;
    let mx = 0;
    for (let c = 0; c < WN; c++) {
      const q = c * 3, x = vel[q], y = vel[q + 1], z = vel[q + 2];
      const m = Math.sqrt(x * x + y * y + z * z);
      if (m > 1e-9) {
        const m2 = vmax * Math.tanh(m / vmax), f = m2 / m;
        vel[q] = x * f; vel[q + 1] = y * f; vel[q + 2] = z * f;
        this.spdG[c] = m2;
        if (m2 > mx) mx = m2;
      } else this.spdG[c] = 0;
    }
    this.maxSpd = mx;
    this.fieldVer = (this.fieldVer || 0) + 1;
  }

  /** Wind (tangent velocity, rad/s) at unit vector d → out [x, y, z, speed]. Bilinear on the grid. */
  sampleWind(d, out) {
    const G = this.gw, WW = G.W, WH = G.H;
    const lon = wrapPi(Math.atan2(d[0], d[2]) - G.lonC), lat = Math.asin(clamp(d[1], -1, 1));
    const fx = ((lon - G.lon0) / G.dLon) * WW - 0.5, fy = ((G.lat1 - lat) / G.dLat) * WH - 0.5;
    if (!G.wrap && (fx < -0.5 || fx > WW - 0.5 || fy < -0.5 || fy > WH - 0.5)) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    let x0 = Math.floor(fx);
    let tx = fx - x0;
    let y0 = Math.floor(fy);
    let ty = fy - y0;
    if (y0 < 0) { y0 = 0; ty = 0; } else if (y0 > WH - 2) { y0 = WH - 2; ty = 1; }
    let x1;
    if (G.wrap) { x1 = (x0 + 1 + WW) % WW; x0 = (x0 + WW) % WW; }
    else { if (x0 < 0) { x0 = 0; tx = 0; } else if (x0 > WW - 2) { x0 = WW - 2; tx = 1; } x1 = x0 + 1; }
    const v = this.vel;
    const a = (y0 * WW + x0) * 3, b = (y0 * WW + x1) * 3, c = ((y0 + 1) * WW + x0) * 3, e = ((y0 + 1) * WW + x1) * 3;
    const wa = (1 - tx) * (1 - ty), wb = tx * (1 - ty), wc = (1 - tx) * ty, we = tx * ty;
    let x = v[a] * wa + v[b] * wb + v[c] * wc + v[e] * we;
    let y = v[a + 1] * wa + v[b + 1] * wb + v[c + 1] * wc + v[e + 1] * we;
    let z = v[a + 2] * wa + v[b + 2] * wb + v[c + 2] * wc + v[e + 2] * we;
    const dd = x * d[0] + y * d[1] + z * d[2]; // keep it tangent
    x -= dd * d[0]; y -= dd * d[1]; z -= dd * d[2];
    out[0] = x; out[1] = y; out[2] = z; out[3] = Math.sqrt(x * x + y * y + z * z);
    return out;
  }

  /** Smooth relief (wind lines ride over the plates like air over hills); refreshed when heights move. */
  heightGrid() {
    if (this._hgVer && (this._fc || 0) % 3 !== 1) return this.Hg;
    let moved = !this._hgVer;
    if (!this._hgH) this._hgH = new Float32Array(this.n);
    for (let k = 0; k < this.n && !moved; k++) if (Math.abs(this._hgH[k] - this.h[k] * this.uRise.value) > 0.0015) moved = true;
    if (!moved) return this.Hg;
    for (let k = 0; k < this.n; k++) this._hgH[k] = this.h[k] * this.uRise.value;
    const G = this.gw, WW = G.W, WH = G.H, WN = WW * WH;
    const a = this._hgA || (this._hgA = new Float32Array(WN)), b = this._hgB || (this._hgB = new Float32Array(WN));
    const nH = this.neutralH();
    for (let c = 0; c < WN; c++) { const o = this.ownLo[c]; a[c] = o >= 0 ? this._hgH[o] : o === -2 ? nH : 0; }
    // max-ish blur: a 1-cell dilation then a small box blur (lines rise before they reach a coast)
    for (let j = 0; j < WH; j++) for (let i = 0; i < WW; i++) {
      let m = 0;
      for (let dj = -1; dj <= 1; dj++) { const jj = clamp(j + dj, 0, WH - 1); for (let di = -1; di <= 1; di++) m = Math.max(m, a[jj * WW + (i + di + WW) % WW]); }
      b[j * WW + i] = m;
    }
    for (let j = 0; j < WH; j++) for (let i = 0; i < WW; i++) {
      let s = 0;
      for (let dj = -1; dj <= 1; dj++) { const jj = clamp(j + dj, 0, WH - 1); for (let di = -1; di <= 1; di++) s += b[jj * WW + (i + di + WW) % WW]; }
      this.Hg[j * WW + i] = s / 9;
    }
    this._hgVer = (this._hgVer || 0) + 1;
    return this.Hg;
  }
  _hgAt(d) {
    const G = this.gw, WW = G.W, WH = G.H;
    const lon = wrapPi(Math.atan2(d.x, d.z) - G.lonC), lat = Math.asin(clamp(d.y / (d.length() || 1), -1, 1));
    const fx0 = ((lon - G.lon0) / G.dLon) * WW - 0.5, fy = clamp(((G.lat1 - lat) / G.dLat) * WH - 0.5, 0, WH - 1.001);
    if (!G.wrap && (fx0 < -0.5 || fx0 > WW - 0.5)) return 0;
    const fx = G.wrap ? fx0 : clamp(fx0, 0, WW - 1.001);
    let x0 = Math.floor(fx); const tx = fx - x0; const y0 = Math.floor(fy), ty = fy - y0;
    let x1 = (x0 + 1 + WW) % WW; x0 = (x0 + WW) % WW; if (!G.wrap) x1 = Math.min(WW - 1, x0 + 1);
    const H = this.Hg, y1 = Math.min(WH - 1, y0 + 1);
    return (H[y0 * WW + x0] * (1 - tx) + H[y0 * WW + x1] * tx) * (1 - ty) + (H[y1 * WW + x0] * (1 - tx) + H[y1 * WW + x1] * tx) * ty;
  }

  // ------------------------------------------------------------------------------------------ geometry queries
  /** Owner of a direction: k ≥ 0 territory, −1 sea, −2 neutral land. */
  ownerAt(d) { return this.S ? this.S.ownerAt(d.x, d.y, d.z) : -1; }
  ownerAtXYZ(x, y, z) { return this.S ? this.S.ownerAt(x, y, z) : -1; }
  /** Neutral land height (the real Earth's land under the items is the globe's: same shelf, scaled). */
  neutralH() { return NEUTRAL_H * this.hs(); }
  /** Ground height (above r = 1) under a direction. */
  groundH(d) {
    const o = this.ownerAt(d);
    if (o >= 0) return this.flat[o] ? (this.kind[o] === 'point' && this.globeLand && this.globeLand(d) ? this.neutralH() : 0) : this.hAt(o);
    if (o === -2) return this.neutralH() * this.uRise.value;
    return this.globeLand && this.globeLand(d) ? this.neutralH() : 0;
  }
  /** Surface point for any direction (object space), riding the plates; extra lifts it. */
  surfPos(d, extra = 0, out = new THREE.Vector3()) {
    out.copy(d).normalize();
    return out.multiplyScalar(1 + this.groundH(out) + extra);
  }
  /** Point for a wind stroke: above the plate under it and above the smoothed relief (no wall jumps). */
  windPos(d, alt, out) {
    out.copy(d).normalize();
    return out.multiplyScalar(1 + Math.max(this.groundH(out), this._hgAt(out)) + alt);
  }
  /** Temperature band of the ground under a direction (−1: sea / neutral land). */
  bandAt(d) { const o = this.ownerAt(d); return o >= 0 ? this.bandK[o] : -1; }

  applyLens(tag, hasTag, immediate) {
    for (let k = 0; k < this.n; k++) {
      this.dimTarget[k] = tag && !hasTag(this.children[k], tag) ? 1 : 0;
      if (immediate) this.dim[k] = this.dimTarget[k];
    }
  }

  isEst(k) {
    if (this.est[k]) return true;
    if (this.estOv.has(this.children[k].id)) return true;
    const sc = this.scen[k];
    return !!(sc && sc.inferred && sc.on);
  }

  /** Per-frame smoothing of heights / lens / lift → uniforms. */
  tick(dt, rise) {
    const a = 1 - Math.exp(-dt * 7), b = 1 - Math.exp(-dt * 9);
    const info = this.uInfo.value, info2 = this.uInfo2.value;
    for (let k = 0; k < this.n && k < MAXT; k++) {
      this.dim[k] += (this.dimTarget[k] - this.dim[k]) * b;
      this.lift[k] += (this.liftTarget[k] - this.lift[k]) * b;
      const cap = this.hCap();
      const target = this.flat[k] ? 0 : Math.min(cap, heightOf(this.cur.wind[k]) * this.hs()) * (1 - 0.65 * this.dim[k]) + Math.min(0.006 * this.hs(), cap * 0.4) * this.lift[k];
      this.h[k] += (target - this.h[k]) * a;
      info[k].set(this.h[k], this.dim[k], this.isEst(k) ? 1 : 0, this.lift[k]);
      info2[k].set(this.cur.temp[k], 0, 0, 0);
      if (this.pointInfo) this.pointInfo(k, info[k], info2[k]);
    }
    this.uRise.value = rise;
    this._fc = (this._fc || 0) + 1;
  }

  hAt(k) {
    if (k < 0) return 0;
    return Math.max(0, this.h[k] || 0) * this.uRise.value;
  }
  facingOf(k) { return this.anchorDir[k].dot(this.camObj); }
  anchorPos(k, out = new THREE.Vector3(), extra = 0) { return out.copy(this.anchorDir[k]).multiplyScalar(1 + this.hAt(k) + extra); }
  /** Candidate points inside territory k (labels, clouds, card leaders): anchor first. */
  cands(k) { return this._cands[k] || [this.anchorDir[k]]; }

  /**
   * End point of the 主航道 inside territory k: the candidate closest to the anchor that lies within maxR of the
   * planet's centre on screen for rotation q (else the most central one).
   */
  chanEnd(k, q, maxR = 0.8, D = 5, zoom = 1) {
    const sil = 1 / Math.sqrt(Math.max(1.01, D * D - 1));
    const t = new THREE.Vector3();
    const scr = (p) => { t.copy(p).applyQuaternion(q); return t.z > 0 ? (Math.hypot(t.x, t.y) / (D - t.z) / sil) * zoom : 2; };
    const a = this.hubDir ? this.hubDir[k] : this.anchorDir[k];
    let best = null, bestD = Infinity, alt = a, altR = Infinity;
    for (const p of [a].concat(this.cands(k))) {
      const r = scr(p), dd = p.angleTo(a);
      if (r <= maxR && dd < bestD) { bestD = dd; best = p; }
      if (r < altR) { altR = r; alt = p; }
    }
    return (best || alt).clone();
  }
  /** Point of territory k that best faces the viewer (the anchor unless it sits near the limb). */
  visibleAnchor(k, camObj) {
    const a = this.anchorDir[k];
    let best = a, bf = a.dot(camObj);
    if (bf > 0.6) { this._vaFacing = bf; return a; }
    for (const p of this.cands(k)) { const f = p.dot(camObj); if (f > bf + 0.02) { bf = f; best = p; } }
    this._vaFacing = bf;
    return best;
  }

  // ------------------------------------------------------------------------------------------ meshes
  _build() {
    const { U } = this.ctx;
    this.root = new THREE.Group();
    this.root.name = 'world:' + this.node.id;
    this.uInfo = { value: Array.from({ length: MAXT }, () => new THREE.Vector4()) };
    this.uInfo2 = { value: Array.from({ length: MAXT }, () => new THREE.Vector4()) };
    this.uCS = { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 1, 0.01)) };
    this.uNCS = { value: 0 };
    this.uRise = { value: 1 };
    this.uRip = { value: Array.from({ length: 4 }, () => new THREE.Vector4()) };
    this.uNRip = { value: 0 };
    this.uNeutralH = { value: NEUTRAL_H * this.hs() };
    // the sea: distance-to-coast texture (equirect) + the toon water shader
    const S = this.S;
    if (S && S.coast) {
      if (!S.coastHalf) { const h = new Uint16Array(S.coast.length); for (let i = 0; i < h.length; i++) h[i] = THREE.DataUtils.toHalfFloat(S.coast[i]); S.coastHalf = h; }
      this.texCoast = new THREE.DataTexture(S.coastHalf, S.W, S.H, THREE.RedFormat, THREE.HalfFloatType);
      this.texCoast.minFilter = this.texCoast.magFilter = THREE.LinearFilter;
      this.texCoast.wrapS = THREE.RepeatWrapping; this.texCoast.wrapT = THREE.ClampToEdgeWrapping;
      this.texCoast.generateMipmaps = false;
      this.texCoast.needsUpdate = true;
    }
    if (!this.real) this._buildSea(U);
    // land
    if (S && (this.n || S.neutral.length)) {
      const { geo, lines, edges } = buildLand(S, this.n, (k) => this.kind[k] === 'land', { neutral: !this.real, edges: this.real, cull: this._cullCap() });
      if (geo.index.count) this._buildPlates(geo, lines, U, edges);
      else { geo.dispose(); lines.dispose(); if (edges) edges.dispose(); }
    }
    if (this.real && S) { this._buildSeaAreas(U); this._buildPoints(U); this._buildHints(U); }
    if (this.real && S && this.um) { this._buildTicks(U); this._buildTiny(U); this._loadUnitLines(U); }
    this.tick(1, 1);
  }

  /** The reach of a zoomed world's window: 2.5 × its half-diagonal around its centre (null: the whole globe). */
  _cullCap() {
    const B = this.unitBox;
    if (!this.real || !B || !(B.span < 120)) return null;
    const RAD = Math.PI / 180, latC = (B.lat0 + B.lat1) / 2;
    const hy = (B.lat1 - B.lat0) / 2, hx = (B.span / 2) * Math.cos(Math.min(80, Math.abs(latC)) * RAD);
    const r = Math.min(Math.PI * 0.45, 2.5 * Math.hypot(hx, hy) * RAD);
    const a = B.lon * RAD, b = latC * RAD, c = Math.cos(b);
    return { c: new THREE.Vector3(c * Math.sin(a), Math.sin(b), c * Math.cos(a)), r };
  }

  _buildSea(U) {
    const seaGeo = new THREE.SphereGeometry(1, 160, 100);
    this.seaMat = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS,
      uniforms: {
        uCoastT: { value: this.texCoast || null }, uSeaDeep: U.uSeaDeep, uSeaShal: U.uSeaShal, uSeaDeepSh: U.uSeaDeepSh, uSeaShalSh: U.uSeaShalSh,
        uSeaLine: U.uSeaLine, uSeaWave: U.uSeaWave, uFoam: U.uFoam, uTime: U.uTime, uWaveA: { value: 1 },
        uDS: { value: 1 }, uWS: { value: 1 }, uLodOn: { value: 0 }, uCoastL: { value: null }, uLodBox: { value: new THREE.Vector4() }, uLodBox2: { value: new THREE.Vector4() }, uSeaK: { value: 1 },
        uL: U.uL, uMidMix: U.uMidMix, uRimCol: U.uRimCol, uRimAmt: U.uRimAmt,
      },
    });
    this.base = new THREE.Mesh(seaGeo, this.seaMat);
    this.base.renderOrder = 0;
    this.base.userData.body = true;
    this.root.add(this.base);
    this.baseHullMat = new THREE.ShaderMaterial({
      vertexShader: HULL_VS, fragmentShader: FLAT_FS, side: THREE.BackSide,
      uniforms: { uW: U.uHullW, uRes: U.uRes, uGrow: { value: BASE_R - 1 - 0.003 }, uCol: U.uOutline, uA: { value: 1 } },
    });
    this.baseHull = new THREE.Mesh(seaGeo, this.baseHullMat);
    this.baseHull.renderOrder = 1;
    this.root.add(this.baseHull);
  }

  _buildPlates(geo, lines, U, edges) {
    {
      const common = { uInfo: this.uInfo, uInfo2: this.uInfo2, uRise: this.uRise, uNeutralH: this.uNeutralH };
      this.plateMat = new THREE.ShaderMaterial({
        vertexShader: PLATE_VS, fragmentShader: PLATE_FS,
        uniforms: Object.assign({}, common, {
          uWallMix: U.uWallMix, uBands: U.uBands, uBandsSh: U.uBandsSh, uEdges: { value: BAND_EDGES.slice() }, uHatch: U.uHatch, uHatchA: U.uHatchA,
          uDimCol: U.uDimCol, uInk: U.uInk, uNeutral: U.uNeutral, uNeutralSh: U.uNeutralSh, uScen: { value: 0 }, uTime: U.uTime, uPR: U.uPR,
          uRip: this.uRip, uNRip: this.uNRip, uCS: this.uCS, uNCS: this.uNCS,
          uWS: { value: this.ws }, uHide: { value: 0 }, uHideBox: { value: new THREE.Vector4() }, uNeutralDot: { value: 1 },
          uL: U.uL, uMidMix: U.uMidMix, uRimCol: U.uRimCol, uRimAmt: U.uRimAmt,
        }),
      });
      this.plates = new THREE.Mesh(geo, this.plateMat);
      this.plates.renderOrder = 0;
      this.root.add(this.plates);
      this.plateHullMat = new THREE.ShaderMaterial({
        vertexShader: PLATE_HULL_VS, fragmentShader: FLAT_FS, side: THREE.BackSide,
        uniforms: Object.assign({}, common, { uW: U.uHullW, uRes: U.uRes, uCol: U.uOutline, uA: { value: 1 } }),
      });
      this.plateHull = new THREE.Mesh(geo, this.plateHullMat);
      this.plateHull.userData.sharedGeo = true;
      this.plateHull.renderOrder = 1;
      this.root.add(this.plateHull);
      this.borderMat = new THREE.ShaderMaterial({
        vertexShader: BORDER_VS, fragmentShader: BORDER_FS, transparent: true, depthWrite: false,
        // §26 on the real Earth a region sits on paper land of almost the same tone: a faint ink edge, not a cream one
        uniforms: Object.assign({}, common, this.real ? { uCol: U.uInk, uA: { value: 0.3 } } : { uCol: U.uBorder, uA: { value: 0.55 } }),
      });
      this.borders = new THREE.LineSegments(lines, this.borderMat);
      this.borders.renderOrder = 2;
      this.root.add(this.borders);
      if (edges && edges.index && edges.index.count) {
        // §17 the real Earth's regions as paper cuts: off-white inner rim, a fine ink edge, a soft drop shadow
        this.edgeMat = new THREE.ShaderMaterial({
          vertexShader: EDGE_VS, fragmentShader: EDGE_FS, transparent: true, depthWrite: false,
          uniforms: Object.assign({}, common, {
            uRes: U.uRes, uPR: U.uPR, uL: U.uL, uRimC: U.uBorder, uInk: U.uInk, uA: { value: 1 },
            // (refine: a firmer ink edge + drop shadow — a 常温 cream region on pale paper land still reads as a cut-out)
            uRimA: { value: 0.88 }, uInkA: { value: 0.74 }, uShA: { value: 0.22 },
          }),
        });
        this.edges = new THREE.Mesh(edges, this.edgeMat);
        this.edges.renderOrder = 2;
        this.edges.frustumCulled = false;
        this.root.add(this.edges);
        this.borders.visible = false; // the ribbons replace the hairline
      } else if (edges) edges.dispose();
    }
  }

  /** §26 sea areas (bonds, cash, crypto …): a tinted patch of the ocean in their weather colour + a dashed chart line. */
  _buildSeaAreas(U) {
    const S = this.S;
    const ks = [];
    for (let k = 0; k < this.n && k < MAXT; k++) if (this.kind[k] === 'sea' && S.terr[k].polys.length) ks.push(k);
    if (!ks.length) return;
    const { geo, lines } = buildLand(S, this.n, (k) => this.kind[k] === 'sea', { walls: false, steiner: 0.03 * Math.max(0.15, this.ws) });
    const common = { uInfo: this.uInfo, uInfo2: this.uInfo2, uRise: this.uRise, uNeutralH: this.uNeutralH };
    this.seaAreaMat = new THREE.ShaderMaterial({
      vertexShader: SEAAREA_VS, fragmentShader: SEAAREA_FS, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      uniforms: Object.assign({}, common, {
        uBands: U.uBands, uBandsSh: U.uBandsSh, uEdges: { value: BAND_EDGES.slice() }, uDimCol: U.uDimCol, uSeaShal: U.uSeaShal, uFoam: U.uFoam,
        uInk: U.uInk, uPR: U.uPR, uTime: U.uTime, uWS: { value: this.ws }, uA: { value: 1 }, uHatch: U.uHatch,
        uL: U.uL, uMidMix: U.uMidMix, uRimCol: U.uRimCol, uRimAmt: U.uRimAmt,
      }),
    });
    this.seaAreas = new THREE.Mesh(geo, this.seaAreaMat);
    this.seaAreas.renderOrder = 1;
    this.root.add(this.seaAreas);
    // dashed chart line along every sea area's edge
    const pos = lines.attributes.position.array, ter = lines.attributes.aTerr.array;
    const dist = new Float32Array(ter.length);
    let acc = 0;
    for (let i = 0; i < ter.length; i += 2) {
      dist[i] = acc;
      acc += Math.hypot(pos[3 * i + 3] - pos[3 * i], pos[3 * i + 4] - pos[3 * i + 1], pos[3 * i + 5] - pos[3 * i + 2]);
      dist[i + 1] = acc;
    }
    lines.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
    this.seaLineMat = new THREE.ShaderMaterial({
      vertexShader: SEALINE_VS, fragmentShader: SEALINE_FS, transparent: true, depthWrite: false,
      uniforms: Object.assign({}, common, { uCol: U.uInk, uA: { value: 0.42 }, uDash: { value: 0.012 * this.ws }, uRiseA: { value: 1 } }),
    });
    this.seaLines = new THREE.LineSegments(lines, this.seaLineMat);
    this.seaLines.renderOrder = 2;
    this.root.add(this.seaLines);
  }

  /** §26 where a sea area's money comes from on land (real.js `hint`): faint dashed rings for the hovered / ①②③ one. */
  _buildHints(U) {
    const H = this.hintsIn;
    if (!H || !H.size) return;
    const dirs = [], ks = [];
    this.hintList = new Map();
    for (const [k, list] of H) {
      const arr = [];
      for (const h of list) {
        if (!Array.isArray(h) || !Number.isFinite(+h[0]) || !Number.isFinite(+h[1])) continue;
        const a = (+h[0] * Math.PI) / 180, b = (+h[1] * Math.PI) / 180, c = Math.cos(b);
        const d = new THREE.Vector3(c * Math.sin(a), Math.sin(b), c * Math.cos(a));
        dirs.push(d.x, d.y, d.z); ks.push(k);
        arr.push({ d, name: String(h[2] || '') });
      }
      if (arr.length) this.hintList.set(k, arr);
    }
    if (!ks.length) return;
    const base = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(dirs), 3));
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(new Float32Array(ks), 1));
    g.instanceCount = ks.length;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
    this.hintMat = new THREE.ShaderMaterial({
      vertexShader: HINT_VS, fragmentShader: HINT_FS, transparent: true, depthWrite: false, depthTest: false,
      uniforms: { uInfo: this.uInfo, uRes: U.uRes, uPR: U.uPR, uInk: U.uInk, uA: { value: 1 }, uGround: { value: NEUTRAL_H * this.hs() } },
    });
    this.hints = new THREE.Mesh(g, this.hintMat);
    this.hints.frustumCulled = false;
    this.hints.renderOrder = 4;
    this.root.add(this.hints);
  }

  /** §26 companies at their HQs: small crisp markers (screen-space discs: a weather-coloured dot in an ink ring). */
  _buildPoints(U) {
    const ks = [];
    for (let k = 0; k < this.n && k < MAXT; k++) if (this.kind[k] === 'point') ks.push(k);
    this.pointKs = ks;
    if (!ks.length) return;
    const base = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    const dir = new Float32Array(ks.length * 3), kk = new Float32Array(ks.length), sz = new Float32Array(ks.length), off = new Float32Array(ks.length * 2);
    // size by money (dv20): the big names a little bigger
    const dv = ks.map((k) => +((this.children[k].now || {}).dv20) || 0);
    const sorted = dv.filter((x) => x > 0).sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1] : 1;
    ks.forEach((k, i) => {
      const d = this.anchorDir[k];
      dir[3 * i] = d.x; dir[3 * i + 1] = d.y; dir[3 * i + 2] = d.z;
      kk[i] = k;
      const r = dv[i] > 0 ? dv[i] / med : 0.6;
      sz[i] = clamp(4.2 + 1.9 * Math.log2(Math.max(0.25, r)), 3.2, 8.2) * clamp(1 + 0.11 * Math.log2(1 / this.ws), 1, 1.4); // a little bigger when close
    });
    this.pointSize = sz;
    this.pointOff = off;
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 3));
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(kk, 1));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(sz, 1));
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = ks.length;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, depthTest: true,
      uniforms: {
        uInfo: this.uInfo, uInfo2: this.uInfo2, uRes: U.uRes, uPR: U.uPR, uBands: U.uBands, uEdges: { value: BAND_EDGES.slice() },
        uInk: U.uInk, uPaper: U.uFoam, uDimCol: U.uDimCol, uA: { value: 1 }, uLift: { value: 0.003 }, uGround: { value: NEUTRAL_H },
      },
    });
    this.points = new THREE.Mesh(g, this.pointMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.root.add(this.points);
  }

  // ------------------------------------------------------------------------------------------ §26 amendment 4
  /**
   * Admin-unit borders, once the unit files are in (planet/units.js): a faint off-white fold line between two units
   * of the same territory (riding its plate), and — level ≥ 2 — a faint ink line between two unclaimed units (on the
   * neutral land). The territory's own outer edge is the paper-cut ribbon (never drawn twice).
   */
  _loadUnitLines(U) {
    const M = this.um;
    if (!M || !M.files.length) return;
    unitFiles(M).then((Fs) => {
      if (this._disposed || !Fs.length) return;
      this.unitFs = Fs;
      const t0 = performance.now();
      this._buildUnitLines(U, unitLines(M, Fs));
      this.unitMs = performance.now() - t0;
    }).catch((e) => console.info('[planet3d] 行政区边界', e && e.message));
  }

  _buildUnitLines(U, L) {
    const RAD = Math.PI / 180;
    const B = this.unitBox;
    // keep to the camera's window (+ a margin): a county line on the far side of the globe costs, shows nothing
    const inB = B ? (lon, lat) => {
      if (lat < B.lat0 - 2 || lat > B.lat1 + 2) return false;
      const d = ((((lon - B.lon) % 360) + 540) % 360) - 180;
      return Math.abs(d) <= B.span / 2 + 2;
    } : () => true;
    const mk = (arcs, terrOf) => {
      const P = [], T = [], Lw = [];
      for (const it of arcs) {
        const A = terrOf ? it[1] : it, k = terrOf ? it[0] : -1;
        if (k >= MAXT) continue;
        const n = A.length >> 1;
        if (n < 2 || !(inB(A[0], A[1]) || inB(A[2 * (n - 1)], A[2 * n - 1]) || inB(A[2 * (n >> 1)], A[2 * (n >> 1) + 1]))) continue;
        let px = 0, py = 0, pz = 0, len = 0;
        const p0 = P.length;
        for (let i = 0; i < n; i++) {
          const a = A[2 * i] * RAD, b = A[2 * i + 1] * RAD, c = Math.cos(b);
          const x = c * Math.sin(a), y = Math.sin(b), z = c * Math.cos(a);
          if (i) { P.push(px, py, pz, x, y, z); T.push(k, k); len += Math.hypot(x - px, y - py, z - pz); }
          px = x; py = y; pz = z;
        }
        // (refine: every vertex of an arc knows the arc's length — the shader fades borders of units too small on
        // screen to read, so a county mesh never turns the map into a spreadsheet)
        for (let i = p0; i < P.length; i += 3) Lw.push(len);
      }
      if (!P.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('aTerr', new THREE.Float32BufferAttribute(T, 1));
      g.setAttribute('aLen', new THREE.Float32BufferAttribute(Lw, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
      return g;
    };
    const common = { uInfo: this.uInfo, uInfo2: this.uInfo2, uRise: this.uRise, uNeutralH: this.uNeutralH };
    // px per radian on screen (the planet sets it every frame) and the fade range of an arc's on-screen length
    this.uPxR = this.uPxR || { value: 300 };
    const gi = mk(L.inner, true);
    if (gi) {
      this.unitInnerMat = new THREE.ShaderMaterial({ vertexShader: UNITLINE_VS, fragmentShader: UNITLINE_FS, transparent: true, depthWrite: false,
        uniforms: Object.assign({}, common, { uCol: U.uBorder, uA: { value: 0.5 }, uPxR: this.uPxR, uFade: { value: new THREE.Vector2(8, 22) } }) });
      this.unitInner = new THREE.LineSegments(gi, this.unitInnerMat);
      this.unitInner.renderOrder = 2;
      this.root.add(this.unitInner);
    }
    const gn = mk(L.neutral, false);
    if (gn) {
      this.unitNeutralMat = new THREE.ShaderMaterial({ vertexShader: UNITLINE_VS, fragmentShader: UNITLINE_FS, transparent: true, depthWrite: false,
        uniforms: Object.assign({}, common, { uCol: U.uInk, uA: { value: this.ctx.look && this.ctx.look.day === false ? 0.2 : 0.13 }, uPxR: this.uPxR, uFade: { value: new THREE.Vector2(18, 46) } }) });
      this.unitNeutral = new THREE.LineSegments(gn, this.unitNeutralMat);
      this.unitNeutral.renderOrder = 1;
      this.root.add(this.unitNeutral);
    }
  }

  /** Ticks: a child's money inside a unit someone else owns (or left unclaimed) — a small dot in its own colour. */
  _buildTicks(U) {
    const T = (this.um.ticks || []).filter((t) => t.k < MAXT);
    this.tickList = T;
    if (!T.length) return;
    const RAD = Math.PI / 180;
    const base = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    const dir = new Float32Array(T.length * 3), kk = new Float32Array(T.length), sz = new Float32Array(T.length);
    this.tickDir = [];
    T.forEach((t, i) => {
      const a = t.lon * RAD, b = t.lat * RAD, c = Math.cos(b);
      dir[3 * i] = c * Math.sin(a); dir[3 * i + 1] = Math.sin(b); dir[3 * i + 2] = c * Math.cos(a);
      this.tickDir.push(new THREE.Vector3(dir[3 * i], dir[3 * i + 1], dir[3 * i + 2]));
      kk[i] = t.k;
      sz[i] = clamp(2.4 + 0.55 * Math.log10(Math.max(1e-3, t.w) * 1000), 2.2, 3.6);
    });
    this.tickSize = sz;
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 3));
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(kk, 1));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(sz, 1));
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(T.length * 2), 2));
    g.instanceCount = T.length;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
    this.tickMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, depthTest: true,
      uniforms: {
        uInfo: this.uInfo, uInfo2: this.uInfo2, uRes: U.uRes, uPR: U.uPR, uBands: U.uBands, uEdges: { value: BAND_EDGES.slice() },
        uInk: U.uInk, uPaper: U.uFoam, uDimCol: U.uDimCol, uA: { value: 1 }, uLift: { value: 0.0035 }, uGround: { value: NEUTRAL_H },
      },
    });
    this.ticks = new THREE.Mesh(g, this.tickMat);
    this.ticks.frustumCulled = false;
    this.ticks.renderOrder = 4;
    this.root.add(this.ticks);
  }

  /** A territory whose biggest part is a speck at this zoom (DC in 债券): an ink ring around it, so it is seen. */
  _buildTiny(U) {
    const ks = [...(this.um.tiny || [])].filter((k) => k < this.n && k < MAXT && this.kind[k] === 'land');
    if (!ks.length) return;
    const base = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    const dir = new Float32Array(ks.length * 3), kk = new Float32Array(ks.length);
    // (integrator, one rule with 2D planet._tinyXY: the ring circles the territory's money — hubDir, real.js item.hub — not
    // the raster's deepest speck, which could sit on empty land: 债券 公司债 over Pennsylvania, its money in Manhattan)
    ks.forEach((k, i) => { const d = this.hubDir[k] || this.anchorDir[k]; dir[3 * i] = d.x; dir[3 * i + 1] = d.y; dir[3 * i + 2] = d.z; kk[i] = k; });
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 3));
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(kk, 1));
    g.instanceCount = ks.length;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
    this.tinyMat = new THREE.ShaderMaterial({
      vertexShader: TINY_VS, fragmentShader: TINY_FS, transparent: true, depthWrite: false, depthTest: false,
      uniforms: { uInfo: this.uInfo, uRes: U.uRes, uPR: U.uPR, uInk: U.uInk, uPaper: U.uFoam, uA: { value: 1 }, uRpx: { value: 11 }, uGround: { value: NEUTRAL_H * this.hs() } },
    });
    this.tiny = new THREE.Mesh(g, this.tinyMat);
    this.tiny.frustumCulled = false;
    this.tiny.renderOrder = 4;
    this.root.add(this.tiny);
  }

  setScenarioUniforms(on, epis) {
    if (this.plateMat) this.plateMat.uniforms.uScen.value = on ? 1 : 0;
    let m = 0;
    for (const id of epis || []) {
      const k = this.idxOf.get(id);
      if (k == null || m >= 4) continue;
      const d = this.anchorDir[k];
      this.uRip.value[m++].set(d.x, d.y, d.z, m * 0.37);
    }
    this.uNRip.value = m;
  }

  dispose() {
    this._disposed = true;
    this.root.traverse((o) => {
      if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose();
      if (o.material && !o.userData.sharedMat) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    if (this.texCoast) this.texCoast.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

// ================================================================================================ refine: unit borders
/** An admin-unit border (BORDER_VS + the arc's length): it fades out while its arc is shorter than uFade px on screen. */
const UNITLINE_VS = BORDER_VS.replace('varying float vFace;', 'varying float vFace;\nattribute float aLen;\nuniform float uPxR;\nvarying float vPx;')
  .replace('gl_Position = projectionMatrix * mv;', 'vPx = aLen * uPxR;\n  gl_Position = projectionMatrix * mv;');
const UNITLINE_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
uniform vec2 uFade;
varying float vFace;
varying float vPx;
void main() { gl_FragColor = vec4(uCol, uA * smoothstep(0.08, 0.3, vFace) * smoothstep(uFade.x, uFade.y, vPx)); }
`;

// ================================================================================================ §26 tiny rings
/** A screen-space ink ring (uRpx px) with a paper halo around a direction: a territory too small to see at this zoom. */
const TINY_VS = /* glsl */ `
attribute vec3 aDir;
attribute float aK;
uniform vec4 uInfo[${MAXT}];
uniform vec2 uRes;
uniform float uPR;
uniform float uGround;
uniform float uRpx;
varying vec2 vUv;
varying float vFace;
varying float vLift;
void main() {
  int k = int(aK + 0.5);
  vLift = clamp(uInfo[k].w, 0.0, 1.0);
  vec3 d = normalize(aDir);
  vec4 mv = modelViewMatrix * vec4(d * (1.0 + uGround + 0.002), 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFace = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  vec4 clip = projectionMatrix * mv;
  vUv = position.xy;
  clip.xy += position.xy * (uRpx + 4.0) * uPR * 2.0 / uRes * clip.w;
  if (vFace < 0.06) clip = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = clip;
}
`;
const TINY_FS = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uA;
uniform float uRpx;
uniform float uPR;
varying vec2 vUv;
varying float vFace;
varying float vLift;
void main() {
  float R = (uRpx + 4.0) * uPR;
  float d = length(vUv) * R;
  float r0 = (uRpx + 1.5 * vLift) * uPR;
  float e = abs(d - r0);
  float ring = 1.0 - smoothstep(0.55 * uPR, 1.25 * uPR, e);
  float halo = 1.0 - smoothstep(1.4 * uPR, 2.6 * uPR, e);
  vec3 col = mix(uPaper, uInk, ring);
  float a = max(ring * 0.85, halo * 0.6) * uA * smoothstep(0.06, 0.2, vFace);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

// ================================================================================================ land mesh
const STEINER = 0.038; // interior point spacing (tangent-plane units ≈ rad)

/** Planar point-in-polygon (even-odd) over several rings (flat [x0,y0,x1,y1,…] arrays). */
function pip(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-30) + xi) inside = !inside;
    }
  }
  return inside;
}
/**
 * The same even-odd test over THIS polygon's own rings, with the edges bucketed in y-bands (CSR): exact and fast for
 * continent-sized coasts. (The old owner-raster test for big polygons accepted any land — so a Delaunay triangle of
 * France whose centroid fell on England was kept, and pale land wedges crossed the Channel and the North Sea.)
 */
function bandPip(flat) {
  let y0 = Infinity, y1 = -Infinity, nE = 0;
  for (const r of flat) { nE += r.length >> 1; for (let i = 1; i < r.length; i += 2) { if (r[i] < y0) y0 = r[i]; if (r[i] > y1) y1 = r[i]; } }
  if (!(y1 > y0)) return () => false;
  const NB = Math.max(1, Math.min(8192, Math.ceil(nE / 6)));
  const h = (y1 - y0) / NB;
  const band = (y) => { const b = Math.floor((y - y0) / h); return b < 0 ? 0 : b >= NB ? NB - 1 : b; };
  const cnt = new Uint32Array(NB + 1);
  for (const r of flat) {
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) { const a = r[2 * i + 1], b = r[2 * j + 1]; if (a === b) continue; for (let t = band(Math.min(a, b)), t1 = band(Math.max(a, b)); t <= t1; t++) cnt[t + 1]++; }
  }
  for (let t = 0; t < NB; t++) cnt[t + 1] += cnt[t];
  const E = new Float64Array(cnt[NB] * 4), fill = cnt.slice(0, NB);
  for (const r of flat) {
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if (yi === yj) continue;
      for (let t = band(Math.min(yi, yj)), t1 = band(Math.max(yi, yj)); t <= t1; t++) { const o = 4 * fill[t]++; E[o] = xi; E[o + 1] = yi; E[o + 2] = xj; E[o + 3] = yj; }
    }
  }
  return (x, y) => {
    if (!(y >= y0 && y <= y1)) return false;
    const t = band(y);
    let inside = false;
    for (let o = 4 * cnt[t], e = 4 * cnt[t + 1]; o < e; o += 4) {
      const xi = E[o], yi = E[o + 1], xj = E[o + 2], yj = E[o + 3];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}
function signedArea(r) {
  let a = 0;
  const m = r.length >> 1;
  for (let i = 0, j = m - 1; i < m; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

/**
 * Plates for every territory (and neutral land): a top surface (ring points + interior Steiner points,
 * Delaunay in a tangent projection, triangles kept inside the coast) and walls along every ring (exterior and
 * holes) down to sea level. Also the hairline borders (LineSegments) along the same rings.
 */
export function buildLand(S, n, use = null, opt = {}) {
  const ownerAt = S.ownerAt;
  const walls = opt.walls !== false;
  const d3 = globalThis.d3;
  const P = [], PR = [], WA = [], O = [], T = [], I = [];
  const LP = [], LT = [];
  // §17 paper-cut edge ribbons (opt.edges): per ring vertex three bands (rim, ink, shadow), two verts each
  const EP = [], EO = [], ET = [], EF = [], EB = [], ETT = [], EI = [[], [], []];
  const BANDS = [[-1.5, 0], [-0.15, 0.75], [0.2, 1.4]];
  const addEdgeRing = (r, outs, k) => {
    const m = r.length / 3;
    if (m < 3) return;
    const base = EP.length / 3;
    for (let i = 0; i < m; i++) {
      for (let b = 0; b < 3; b++) for (let t = 0; t < 2; t++) {
        EP.push(r[3 * i], r[3 * i + 1], r[3 * i + 2]);
        EO.push(outs[3 * i], outs[3 * i + 1], outs[3 * i + 2]);
        ET.push(k); EF.push(BANDS[b][t]); EB.push(b); ETT.push(t);
      }
    }
    for (let i = 0; i < m; i++) {
      const a = base + i * 6, c = base + ((i + 1) % m) * 6;
      for (let b = 0; b < 3; b++) { const a0 = a + 2 * b, c0 = c + 2 * b; EI[b].push(a0, c0, a0 + 1, a0 + 1, c0, c0 + 1); }
    }
  };
  const c = new THREE.Vector3(), e = new THREE.Vector3(), nn = new THREE.Vector3(), v = new THREE.Vector3(), w = new THREE.Vector3();
  const addV = (x, y, z, prof, wall, ox, oy, oz, k) => { P.push(x, y, z); PR.push(prof); WA.push(wall); O.push(ox, oy, oz); T.push(k); return P.length / 3 - 1; };
  const doPoly = (poly, k) => {
    const rings = [poly.ext, ...poly.holes].filter((r) => r && r.length >= 9);
    if (!rings.length) return;
    let nPts = 0;
    for (const r of rings) nPts += r.length / 3;
    // tangent frame at the exterior's mean direction
    c.set(0, 0, 0);
    const ext = rings[0];
    for (let i = 0; i < ext.length; i += 3) c.x += ext[i], c.y += ext[i + 1], c.z += ext[i + 2];
    if (c.lengthSq() < 1e-12) c.set(ext[0], ext[1], ext[2]);
    c.normalize();
    frame3(c, e, nn);
    let minDot = 1;
    for (const r of rings) for (let i = 0; i < r.length; i += 3) minDot = Math.min(minDot, r[i] * c.x + r[i + 1] * c.y + r[i + 2] * c.z);
    const gnom = minDot > 0.3;
    const proj = (x, y, z, out, o) => {
      const dd = x * c.x + y * c.y + z * c.z;
      const px = x * e.x + y * e.y + z * e.z, py = x * nn.x + y * nn.y + z * nn.z;
      if (gnom) { out[o] = px / dd; out[o + 1] = py / dd; return; }
      const a = Math.acos(clamp(dd, -1, 1)), l = Math.hypot(px, py) || 1;
      out[o] = (px / l) * a; out[o + 1] = (py / l) * a;
    };
    const unproj = (x, y, out) => {
      if (gnom) return out.set(c.x + x * e.x + y * nn.x, c.y + x * e.y + y * nn.y, c.z + x * e.z + y * nn.z).normalize();
      return offsetDir(c, e, nn, x, y, out);
    };
    const flat = rings.map((r) => { const f = new Float64Array((r.length / 3) * 2); for (let i = 0, j = 0; i < r.length; i += 3, j += 2) proj(r[i], r[i + 1], r[i + 2], f, j); return f; });
    // inside test: exact, against this polygon's own rings only (never "any land" — see bandPip)
    const inside = nPts < 400 ? (x, y) => pip(flat, x, y) : bandPip(flat);
    // ---- top surface
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const f0 = flat[0];
    for (let i = 0; i < f0.length; i += 2) { x0 = Math.min(x0, f0[i]); x1 = Math.max(x1, f0[i]); y0 = Math.min(y0, f0[i + 1]); y1 = Math.max(y1, f0[i + 1]); }
    const pts = [];
    const dirs = [];
    for (let ri = 0; ri < rings.length; ri++) {
      const f = flat[ri], r = rings[ri];
      for (let i = 0, j = 0; i < f.length; i += 2, j += 3) { pts.push(f[i], f[i + 1]); dirs.push([r[j], r[j + 1], r[j + 2]]); }
    }
    const nRing = dirs.length;
    // interior Steiner points on a jittered grid, kept away from the coast (so ring edges stay Delaunay edges)
    const sp = opt.steiner || (k < 0 ? 0.06 : STEINER), min2 = (sp * 0.6) * (sp * 0.6);
    const cellR = new Map(); // ring points bucketed for the clearance test
    const key = (ix, iy) => ix * 73856093 ^ iy * 19349663;
    for (let i = 0; i < nRing; i++) { const ix = Math.floor(pts[2 * i] / sp), iy = Math.floor(pts[2 * i + 1] / sp); const kk = key(ix, iy); (cellR.get(kk) || cellR.set(kk, []).get(kk)).push(i); }
    let jit = 0;
    for (let y = y0 + sp * 0.5; y < y1; y += sp * 0.866) {
      jit++;
      for (let x = x0 + sp * 0.5 + (jit % 2) * sp * 0.5; x < x1; x += sp) {
        if (!inside(x, y)) continue;
        const ix = Math.floor(x / sp), iy = Math.floor(y / sp);
        let ok = true;
        for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) {
          const l = cellR.get(key(ix + a, iy + b));
          if (l) for (const i of l) { const dx = pts[2 * i] - x, dy = pts[2 * i + 1] - y; if (dx * dx + dy * dy < min2) { ok = false; break; } }
        }
        if (!ok) continue;
        pts.push(x, y);
        dirs.push(null);
      }
    }
    // conforming Delaunay: a coast segment that is not a triangle edge gets its midpoint inserted (on the segment),
    // a few rounds — so no triangle straddles the coast (no land wedges over a strait, no filled bays)
    let ringIdx = [];
    { let o = 0; for (const f of flat) { const m = f.length >> 1, l = new Array(m); for (let i = 0; i < m; i++) l[i] = o + i; ringIdx.push(l); o += m; } }
    let del, tri;
    const ekey = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
    for (let round = 0; ; round++) {
      del = new d3.Delaunay(Float64Array.from(pts));
      tri = del.triangles;
      if (round >= 6 || pts.length / 2 > 4000000) break;
      // is a–b a triangulation edge? walk a's half-edges (Delaunator: inedges / halfedges / triangles)
      const { halfedges: he, inedges: ie } = del;
      const hasEdge = (a, b) => {
        const e0 = ie[a];
        if (e0 === -1) return false;
        let e = e0;
        do {
          if (tri[e] === b) return true;
          const o = e % 3 === 2 ? e - 2 : e + 1; // the next half-edge in e's triangle starts at a
          if (tri[o % 3 === 2 ? o - 2 : o + 1] === b) return true;
          e = he[o];
        } while (e !== -1 && e !== e0);
        return false;
      };
      let added = 0;
      ringIdx = ringIdx.map((l) => {
        const m = l.length, out = [];
        for (let i = 0; i < m; i++) {
          const a = l[i], b = l[(i + 1) % m];
          out.push(a);
          if (hasEdge(a, b)) continue;
          const dx = pts[2 * b] - pts[2 * a], dy = pts[2 * b + 1] - pts[2 * a + 1];
          if (dx * dx + dy * dy < 1e-14) continue;
          out.push(pts.length / 2);
          pts.push(pts[2 * a] + dx / 2, pts[2 * a + 1] + dy / 2);
          dirs.push(null);
          added++;
        }
        return out;
      });
      if (!added) break;
    }
    const ringE = new Set();
    for (const l of ringIdx) for (let i = 0, m = l.length; i < m; i++) ringE.add(ekey(l[i], l[(i + 1) % m]));
    const base = P.length / 3;
    for (let i = 0; i < dirs.length; i++) {
      if (dirs[i]) v.set(dirs[i][0], dirs[i][1], dirs[i][2]);
      else unproj(pts[2 * i], pts[2 * i + 1], v);
      addV(v.x, v.y, v.z, 1, 0, 0, 0, 0, k);
    }
    const midIn = (a, b) => ringE.has(ekey(a, b)) || inside((pts[2 * a] + pts[2 * b]) / 2, (pts[2 * a + 1] + pts[2 * b + 1]) / 2);
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t], b = tri[t + 1], cc = tri[t + 2];
      const mx = (pts[2 * a] + pts[2 * b] + pts[2 * cc]) / 3, my = (pts[2 * a + 1] + pts[2 * b + 1] + pts[2 * cc + 1]) / 3;
      if (!inside(mx, my)) continue;
      // a chord across water (its midpoint outside) — the triangle spans a bay or a strait: drop it
      if (!midIn(a, b) || !midIn(b, cc) || !midIn(cc, a)) continue;
      // outward-facing winding (normal along the surface direction)
      const ax = pts[2 * a], ay = pts[2 * a + 1];
      const cr = (pts[2 * b] - ax) * (pts[2 * cc + 1] - ay) - (pts[2 * b + 1] - ay) * (pts[2 * cc] - ax);
      if (cr > 0) I.push(base + a, base + b, base + cc); else I.push(base + a, base + cc, base + b);
    }
    // ---- walls (exterior + holes) and hairlines
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri], m = r.length / 3;
      if (!walls) {
        for (let i = 0; i < m; i++) { const inx = (i + 1) % m; LP.push(r[3 * i], r[3 * i + 1], r[3 * i + 2], r[3 * inx], r[3 * inx + 1], r[3 * inx + 2]); LT.push(k, k); }
        continue;
      }
      const ccw = signedArea(flat[ri]) > 0;
      const s = (ri === 0) === ccw ? 1 : -1; // outward = right side for a CCW exterior / a CW hole
      const wb = P.length / 3;
      const outs = opt.edges && k >= 0 ? new Float32Array(m * 3) : null;
      for (let i = 0; i < m; i++) {
        const ip = (i + m - 1) % m, inx = (i + 1) % m;
        v.set(r[3 * i], r[3 * i + 1], r[3 * i + 2]);
        w.set(r[3 * inx] - r[3 * ip], r[3 * inx + 1] - r[3 * ip + 1], r[3 * inx + 2] - r[3 * ip + 2]);
        const o = new THREE.Vector3().crossVectors(w, v).normalize().multiplyScalar(s);
        if (outs) { outs[3 * i] = o.x; outs[3 * i + 1] = o.y; outs[3 * i + 2] = o.z; }
        addV(v.x, v.y, v.z, 1, 1, o.x, o.y, o.z, k);
        addV(v.x, v.y, v.z, 0, 1, o.x, o.y, o.z, k);
        LP.push(v.x, v.y, v.z, r[3 * inx], r[3 * inx + 1], r[3 * inx + 2]);
        LT.push(k, k);
      }
      // winding: front faces outward
      const t0 = new THREE.Vector3(r[0], r[1], r[2]), t1 = new THREE.Vector3(r[3], r[4], r[5]);
      const top0 = t0.clone().multiplyScalar(1.05), bot0 = t0.clone(), bot1 = t1.clone();
      const nrm = new THREE.Vector3().subVectors(bot0, top0).cross(new THREE.Vector3().subVectors(bot1, top0));
      const o0 = new THREE.Vector3(O[(wb) * 3], O[wb * 3 + 1], O[wb * 3 + 2]);
      const flip = nrm.dot(o0) < 0;
      for (let i = 0; i < m; i++) {
        const a = wb + 2 * i, b = wb + 2 * ((i + 1) % m);
        if (!flip) { I.push(a, a + 1, b + 1); I.push(a, b + 1, b); } else { I.push(a, b + 1, a + 1); I.push(a, b, b + 1); }
      }
      if (outs) addEdgeRing(r, outs, k);
    }
  };
  // (refine #13: a zoomed world draws only the pieces within reach of its window — Shenzhen's districts are not
  // triangulated while the camera rests over Beijing; the world is rebuilt anyway once the camera leaves)
  const cull = opt.cull || null;
  const near = (poly) => {
    if (!cull) return true;
    const r = poly.ext, m = r.length / 3, st = Math.max(1, m >> 5), cd = Math.cos(cull.r);
    for (let i = 0; i < m; i += st) if (r[3 * i] * cull.c.x + r[3 * i + 1] * cull.c.y + r[3 * i + 2] * cull.c.z > cd) return true;
    return false;
  };
  for (let k = 0; k < n && k < MAXT; k++) if (!use || use(k)) for (const poly of S.terr[k].polys) if (near(poly)) doPoly(poly, k);
  if (!use || opt.neutral) for (const poly of S.neutral) doPoly(poly, -1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('aProf', new THREE.Float32BufferAttribute(PR, 1));
  geo.setAttribute('aWall', new THREE.Float32BufferAttribute(WA, 1));
  geo.setAttribute('aOut', new THREE.Float32BufferAttribute(O, 3));
  geo.setAttribute('aTerr', new THREE.Float32BufferAttribute(T, 1));
  geo.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3));
  lines.setAttribute('aTerr', new THREE.Float32BufferAttribute(LT, 1));
  lines.setAttribute('aProf', new THREE.Float32BufferAttribute(new Float32Array(LT.length).fill(1), 1));
  lines.setAttribute('aWall', new THREE.Float32BufferAttribute(new Float32Array(LT.length), 1));
  lines.setAttribute('aOut', new THREE.Float32BufferAttribute(new Float32Array(LT.length * 3), 3));
  lines.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  let edges = null;
  if (opt.edges) {
    edges = new THREE.BufferGeometry();
    edges.setAttribute('position', new THREE.Float32BufferAttribute(EP, 3));
    edges.setAttribute('aOut', new THREE.Float32BufferAttribute(EO, 3));
    edges.setAttribute('aTerr', new THREE.Float32BufferAttribute(ET, 1));
    edges.setAttribute('aOff', new THREE.Float32BufferAttribute(EF, 1));
    edges.setAttribute('aBand', new THREE.Float32BufferAttribute(EB, 1));
    edges.setAttribute('aT', new THREE.Float32BufferAttribute(ETT, 1));
    edges.setAttribute('aProf', new THREE.Float32BufferAttribute(new Float32Array(ET.length).fill(1), 1));
    edges.setAttribute('aWall', new THREE.Float32BufferAttribute(new Float32Array(ET.length), 1));
    // draw order inside the one call: shadows, then rims, then ink on top
    const idx = EI[2].concat(EI[0], EI[1]);
    edges.setIndex(EP.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    edges.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  }
  return { geo, lines, edges };
}

export { EDGES };
