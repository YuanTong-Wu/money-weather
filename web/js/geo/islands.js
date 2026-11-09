// geo/islands.js — abstract continents & archipelagos for any planet (DESIGN §25).
//
// One landmass per child, organic seeded coastlines (a domain-warped noise field around an anisotropic blob,
// plus a peninsula or two and a bay or two — never a circle), area ∝ sqrt(dv20), total land ≈ 25–30 % of the
// sphere, spaced on the sphere by relaxation (each island keeps a strait of open water to its neighbours, its
// coastline profile interlocking with theirs), biggest tiers nearest the front. A leaf whose children are
// stocks becomes an archipelago (each stock an island, big names bigger, narrower straits).
// Deterministic: shapes are seeded by the child id (an island keeps its coast on every visit), positions by
// the node id and the size tiers, so the same planet looks the same every time.
//
// Contract (§25): islandsLayout(node, childNodes, mapJson, opts) → [{id, rings:[[[lon,lat],…],…], center:[lon,lat], area}]
// rings follow d3-geo's winding (exterior clockwise, < a hemisphere); area in steradians. The returned array
// also carries `.front = [lon, lat]` (the layout's front pole) and `.mode = 'abstract'`.

import { mulberry32, hashStr, makeNoise2 } from '../planet/util.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const FRONT = [0, 8]; // lon, lat (deg): where the layout is centred
const NB = 48; // directional extent bins

const shapeCache = new Map();
const layoutCache = new Map();

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const isStockNode = (c) => !!c && (c.kind === 'stock' || String(c.id || '').startsWith('s:'));

// ------------------------------------------------------------------------------------------ vectors
/** lon/lat (deg) → unit vector in the planet's object space (x east at lon 90, y north, z toward lon 0 lat 0). */
export function dirOf(lon, lat, out = [0, 0, 0]) {
  const a = lon / DEG, b = lat / DEG, c = Math.cos(b);
  out[0] = c * Math.sin(a); out[1] = Math.sin(b); out[2] = c * Math.cos(a);
  return out;
}
export function lonLatOf(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [Math.atan2(d[0], d[2]) * DEG, Math.asin(Math.max(-1, Math.min(1, d[1] / l))) * DEG];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; a[0] /= l; a[1] /= l; a[2] /= l; return a; };
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
/** Local tangent frame at c: east, north. */
function frame(c) {
  let e = [c[2], 0, -c[0]]; // Y × c
  if (Math.hypot(e[0], e[2]) < 1e-6) e = [1, 0, 0];
  norm(e);
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  return [e, norm(n)];
}
/** Point at local equidistant offset (x, y) radians (east, north) from c. */
function expMap(c, e, n, x, y) {
  const r = Math.hypot(x, y);
  if (r < 1e-12) return c.slice();
  const s = Math.sin(r) / r, k = Math.cos(r);
  return norm([k * c[0] + s * (x * e[0] + y * n[0]), k * c[1] + s * (x * e[1] + y * n[1]), k * c[2] + s * (x * e[2] + y * n[2])]);
}
/** Move a along the great circle away from b by delta radians. */
function pushAway(a, b, delta) {
  const d = dot(a, b);
  let t = [a[0] * d - b[0], a[1] * d - b[1], a[2] * d - b[2]]; // tangent at a, pointing away from b
  const tl = Math.hypot(t[0], t[1], t[2]);
  if (tl < 1e-9) { const [e] = frame(a); t = e; } else { t[0] /= tl; t[1] /= tl; t[2] /= tl; }
  const c = Math.cos(delta), s = Math.sin(delta);
  a[0] = a[0] * c + t[0] * s; a[1] = a[1] * c + t[1] * s; a[2] = a[2] * c + t[2] * s;
  norm(a);
}
/** Direction (angle in a's east/north frame) from a toward b. */
function bearing(a, fr, b) {
  const d = dot(a, b);
  const g = [b[0] - d * a[0], b[1] - d * a[1], b[2] - d * a[2]];
  return Math.atan2(dot(g, fr[1]), dot(g, fr[0]));
}

// ------------------------------------------------------------------------------------------ shapes
const planarArea = (r) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
function centroidOf(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n], f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  return Math.abs(a) < 1e-12 ? [0, 0] : [cx / (3 * a), cy / (3 * a)];
}
function chaikin(r) {
  const out = [];
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
  }
  return out;
}
function thin(r, minD) {
  const out = [];
  for (const p of r) { const l = out[out.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= minD) out.push(p); }
  if (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < minD) out.pop();
  return out;
}

/**
 * A unit-area organic landmass (area π, centroid at the origin) in local units, seeded by its id.
 * Returns {rings: [[[x,y],…]], ext: Float32Array(NB) (max radius per direction bin), emax}.
 */
function makeShape(id, arch) {
  const key = id + (arch ? '|a' : '|c');
  if (shapeCache.has(key)) return shapeCache.get(key);
  const d3 = globalThis.d3;
  const seed = hashStr('island:' + id);
  const rnd = mulberry32(seed);
  const nA = makeNoise2(seed ^ 0x9e3779b9), nB = makeNoise2(seed ^ 0x7f4a7c15);
  const N = arch ? 60 : 84, LX = 2.2, step = (2 * LX) / N;
  const rot = rnd() * TAU, asp = arch ? 1 + rnd() * 0.55 : 1.05 + rnd() * 0.75, sa = Math.sqrt(asp);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const pens = [], bays = [];
  const np = arch ? (rnd() < 0.45 ? 1 : 0) : 1 + (rnd() < 0.6 ? 1 : 0);
  for (let i = 0; i < np; i++) pens.push({ a: rnd() * TAU, len: 0.45 + rnd() * 0.55, w: 0.13 + rnd() * 0.12, h: 0.6 + rnd() * 0.35 });
  const nb = arch ? (rnd() < 0.55 ? 1 : 0) : 1 + (rnd() < 0.65 ? 1 : 0);
  for (let i = 0; i < nb; i++) bays.push({ a: rnd() * TAU, r: 0.6 + rnd() * 0.3, s: 0.2 + rnd() * 0.15, d: 0.5 + rnd() * 0.4 });
  const ox = rnd() * 97, oy = rnd() * 97;
  const warp = arch ? 0.28 : 0.36, big = arch ? 0.34 : 0.44;
  const vals = new Float64Array(N * N);
  for (let gy = 0; gy < N; gy++) {
    const y = -LX + (gy + 0.5) * step;
    for (let gx = 0; gx < N; gx++) {
      const x = -LX + (gx + 0.5) * step;
      const u = (x * cr + y * sr) / sa, v = (-x * sr + y * cr) * sa;
      let f = 1 - Math.hypot(u, v);
      const wx = x + warp * nB(x * 0.8 + ox, y * 0.8 - oy), wy = y + warp * nB(x * 0.8 - oy + 7.3, y * 0.8 + ox - 2.1);
      f += big * nA(wx * 0.95 + ox, wy * 0.95 + oy) + 0.17 * nA(wx * 2.3 - oy, wy * 2.3 + ox) + 0.075 * nA(wx * 5.2 + 3.1, wy * 5.2 - 7.7) + 0.018 * nA(wx * 9 + 1.3, wy * 9 - 4.4);
      for (const p of pens) {
        const c = Math.cos(p.a), s = Math.sin(p.a);
        const al = x * c + y * s, ac = -x * s + y * c;
        const mid = 0.7 + p.len * 0.5;
        f += p.h * Math.exp(-((al - mid) * (al - mid)) / (p.len * p.len * 0.32) - (ac * ac) / (p.w * p.w));
      }
      for (const b of bays) {
        const bx = Math.cos(b.a) * b.r, by = Math.sin(b.a) * b.r;
        f -= b.d * Math.exp(-((x - bx) * (x - bx) + (y - by) * (y - by)) / (b.s * b.s));
      }
      f -= 3 * smoothstep(LX * 0.78, LX * 0.98, Math.hypot(x, y));
      vals[gy * N + gx] = f;
    }
  }
  const mp = d3.contours().size([N, N]).thresholds([0])(vals)[0];
  const toLocal = (ring) => ring.slice(0, -1).map(([px, py]) => [-LX + px * step, -LX + py * step]);
  const comps = (mp ? mp.coordinates : []).map((poly) => toLocal(poly[0])).filter((r) => r.length >= 6);
  comps.sort((a, b) => Math.abs(planarArea(b)) - Math.abs(planarArea(a)));
  let rings = comps.length ? [comps[0]] : [Array.from({ length: 40 }, (_, i) => [Math.cos((i / 40) * TAU), Math.sin((i / 40) * TAU)])];
  const mainA = Math.abs(planarArea(rings[0]));
  if (!arch) for (const r of comps.slice(1, 4)) if (Math.abs(planarArea(r)) > 0.025 * mainA && rings.length < 3) rings.push(r);
  // centre on the main ring's centroid, normalise to area π, smooth once
  const [cx, cy] = centroidOf(rings[0]);
  let tot = 0;
  for (const r of rings) tot += Math.abs(planarArea(r));
  const k = Math.sqrt(Math.PI / Math.max(1e-6, tot));
  rings = rings.map((r) => thin(chaikin(r.map(([x, y]) => [(x - cx) * k, (y - cy) * k])), 0.018));
  // directional extent profile (max radius per bin, widened by ±1 bin)
  const raw = new Float32Array(NB);
  for (const r of rings) for (const [x, y] of r) {
    const b = Math.floor(((Math.atan2(y, x) + Math.PI) / TAU) * NB) % NB;
    raw[b] = Math.max(raw[b], Math.hypot(x, y));
  }
  const ext = new Float32Array(NB);
  let emax = 0;
  for (let b = 0; b < NB; b++) {
    ext[b] = Math.max(raw[b], raw[(b + 1) % NB], raw[(b + NB - 1) % NB], 0.3);
    emax = Math.max(emax, ext[b]);
  }
  const sh = { rings, ext, emax };
  shapeCache.set(key, sh);
  if (shapeCache.size > 600) shapeCache.delete(shapeCache.keys().next().value);
  return sh;
}
const extAt = (sh, a) => sh.ext[Math.floor(((a + Math.PI) / TAU) * NB) % NB];

// ------------------------------------------------------------------------------------------ layout
/**
 * @param node        the planet (tree node)
 * @param childNodes  its children (territories)
 * @param mapJson     unused (sizes come from now.dv20, like the old Voronoi)
 * @param opts        {land: fraction of the sphere (default 0.27, archipelagos 0.23)}
 */
export function islandsLayout(node, childNodes, mapJson, opts = {}) {
  const d3 = globalThis.d3;
  const kids = (childNodes || []).filter((c) => c && c.id != null);
  const n = kids.length;
  const out = [];
  out.front = FRONT.slice();
  out.mode = 'abstract';
  if (!n || !d3) return out;
  const arch = kids.every(isStockNode);
  // sizes: sqrt(dv20) shares with a floor (tiny ones stay clickable) and a cap
  const raw = kids.map((c) => (c.now && c.now.dv20 > 0 ? +c.now.dv20 : null));
  const known = raw.filter((v) => v != null).sort((a, b) => a - b);
  const med = known.length ? known[known.length >> 1] : 1;
  const w = raw.map((v) => Math.sqrt(Math.max(1e-6, v != null ? v : med * 0.5)));
  let share = w.map((x) => x / (w.reduce((a, b) => a + b, 0) || 1));
  if (n > 1) {
    const floor = (arch ? 0.24 : 0.32) / n, cap = arch ? 0.34 : 0.3;
    for (let p = 0; p < 5; p++) { share = share.map((s) => Math.min(cap, Math.max(floor, s))); const s = share.reduce((a, b) => a + b, 0); share = share.map((x) => x / s); }
  } else share = [1];
  share = share.map((s) => Math.round(s * 150) / 150 || 1 / 300); // stable to small daily changes (same planet every visit)
  const land = opts.land || (n === 1 ? 0.15 : arch ? 0.2 : 0.22);
  const A = share.map((s) => s * land * 4 * Math.PI);
  const r = A.map((a) => Math.acos(Math.max(-1, 1 - a / TAU))); // geodesic radius of a cap of that area
  const key = node.id + '|' + kids.map((c, i) => c.id + ':' + share[i]).join(',') + '|' + land;
  if (layoutCache.has(key)) return layoutCache.get(key);

  const shapes = kids.map((c) => makeShape(String(c.id), arch));
  const seed = hashStr('layout:' + node.id);
  const rnd = mulberry32(seed);
  const P = dirOf(FRONT[0], FRONT[1]);
  const [Pe, Pn] = frame(P);
  // order: size tiers (biggest nearest the front), then a stable hash
  const tier = (a) => Math.round(Math.log2(a) * 1.5);
  const order = kids.map((c, i) => i).sort((a, b) => tier(A[b]) - tier(A[a]) || hashStr(String(kids[a].id)) - hashStr(String(kids[b].id)));
  // seas: a strait proportional to the two coasts (wide oceans between big continents, narrow straits in an
  // archipelago), spread over a cap where land is ~40 % (the visible face reads mostly sea), pulled in only
  // beyond it
  const gap0 = arch ? 0.03 : 0.05;
  const gapOf = (i, j) => (gap0 + (arch ? 0.11 : 0.115) * (r[i] + r[j])) * (0.8 + 0.45 * ((hashStr(kids[i].id + '~' + kids[j].id) % 1000) / 1000));
  const landA = A.reduce((a, b) => a + b, 0);
  const Th = Math.min(2.5, Math.acos(Math.max(-1, 1 - landA / (arch ? 0.62 : 0.58) / TAU)));
  const C = new Array(n);
  const phi0 = rnd() * TAU;
  order.forEach((i, rank) => {
    if (n === 1) { C[i] = P.slice(); return; }
    const th = 0.85 * Th * Math.sqrt((rank + 0.3) / n);
    const ph = phi0 + rank * 2.39996323 + (rnd() - 0.5) * 0.5;
    C[i] = expMap(P, Pe, Pn, Math.cos(ph) * th, Math.sin(ph) * th);
  });
  const fr = C.map((c) => frame(c));
  const needOf = (i, j, gk) => r[i] * extAt(shapes[i], bearing(C[i], fr[i], C[j])) + r[j] * extAt(shapes[j], bearing(C[j], fr[j], C[i])) + gapOf(i, j) * gk;
  const ITER = n > 30 ? 240 : 320;
  for (let it = 0; it < ITER && n > 1; it++) {
    const cool = 1 - it / ITER;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = ang(C[i], C[j]);
        const g = gapOf(i, j);
        if (d >= r[i] * shapes[i].emax + r[j] * shapes[j].emax + g * 1.6) continue;
        const need = needOf(i, j, 1);
        // hard: keep the strait; soft (a little further): spread evenly over the cap
        const push = d < need ? (need - d) * 0.55 : d < need + g * 0.8 ? (need + g * 0.8 - d) * 0.05 * cool : 0;
        if (push <= 0) continue;
        const wi = A[j] / (A[i] + A[j]), wj = 1 - wi;
        pushAway(C[i], C[j], push * wi + 1e-5);
        pushAway(C[j], C[i], push * wj + 1e-5);
        moved += push;
      }
    }
    // gravity: only islands drifting beyond the cap come back (and a whisper toward the front for the rest)
    for (let i = 0; i < n; i++) {
      const d = ang(C[i], P);
      if (d < 1e-4) continue;
      const lim = Th - r[i] * 0.5;
      const pull = d > lim ? (d - lim) * 0.25 + 0.002 : 0.0015 * cool * d;
      pushAway(C[i], P, -Math.min(d, pull));
    }
    if (it % 4 === 0) for (let i = 0; i < n; i++) fr[i] = frame(C[i]);
    if (it > 80 && moved < 1e-5) break;
  }
  for (let i = 0; i < n; i++) fr[i] = frame(C[i]);
  // exact pass: real coastlines never touch — every pair keeps ≥ a third of its strait between actual coast points
  const pts = (i) => {
    const [e, nn] = fr[i], out = [];
    for (const ring of shapes[i].rings) for (let q = 0; q < ring.length; q += 2) out.push(expMap(C[i], e, nn, ring[q][0] * r[i], ring[q][1] * r[i]));
    return out;
  };
  for (let it = 0; it < 40 && n > 1; it++) {
    let bad = 0;
    const P3 = C.map((_, i) => pts(i));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const g = gapOf(i, j) * 0.34;
      if (ang(C[i], C[j]) >= r[i] * shapes[i].emax + r[j] * shapes[j].emax + g) continue;
      const cg = Math.cos(g);
      let mx = -1;
      for (const a of P3[i]) for (const b of P3[j]) { const dd = dot(a, b); if (dd > mx) mx = dd; }
      // also catch a coast swallowed whole (centre of i inside j's reach)
      const minD = Math.acos(Math.min(1, mx));
      if (mx > cg || ang(C[i], C[j]) < needOf(i, j, 0) * 0.6) {
        bad++;
        const push = Math.max(0.004, g - minD) * 0.7 + 0.002;
        const wi = A[j] / (A[i] + A[j]);
        pushAway(C[i], C[j], push * wi);
        pushAway(C[j], C[i], push * (1 - wi));
      }
    }
    for (let i = 0; i < n; i++) fr[i] = frame(C[i]);
    if (!bad) break;
  }
  // rings on the sphere (d3 winding: exterior clockwise, smaller than a hemisphere)
  for (let i = 0; i < n; i++) {
    const sh = shapes[i], [e, nn] = fr[i];
    const rings = sh.rings.map((ring) => {
      const ll = ring.map(([x, y]) => lonLatOf(expMap(C[i], e, nn, x * r[i], y * r[i])));
      ll.push(ll[0].slice());
      if (d3.geoArea({ type: 'Polygon', coordinates: [ll] }) > TAU) ll.reverse();
      return ll;
    });
    const area = rings.reduce((a, rg) => a + d3.geoArea({ type: 'Polygon', coordinates: [rg] }), 0);
    out.push({ id: kids[i].id, rings, center: lonLatOf(C[i]), area });
  }
  layoutCache.set(key, out);
  if (layoutCache.size > 40) layoutCache.delete(layoutCache.keys().next().value);
  return out;
}

export const getLayout = (node, childNodes, mapJson, opts) => Promise.resolve(islandsLayout(node, childNodes, mapJson, opts));
export default getLayout;
