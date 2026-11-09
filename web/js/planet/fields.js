// planet/fields.js — per-date fields on the layout grid (no DOM).
// Everything is Σ_k coef_k · value_k over the precomputed soft memberships, so it is cheap to redo
// every frame while values lerp between days.

import { G, swirlField } from './layout.js';
import { BAND_EDGES } from './theme.js';
import { frameAt as frameOf } from './sphere.js';
import { hashStr, makeNoise2 } from './util.js';

const N2 = G * G;

/** out[c] = Σ_k coef[k][c] · vals[k]  (vals NaN → fallback) */
export function blendScalar(coef, vals, fallback, out, base = 0) {
  out.fill(base);
  for (let k = 0; k < coef.length; k++) {
    let v = vals[k];
    if (!Number.isFinite(v)) v = fallback;
    v -= base;
    if (v === 0) continue;
    const a = coef[k];
    for (let c = 0; c < N2; c++) out[c] += a[c] * v;
  }
  return out;
}

/** Band index per grid cell (0…BAND_EDGES.length) — drives wind-line colour (ink vs paper). */
export function bandGrid(T, out) {
  const E = BAND_EDGES, nE = E.length;
  for (let c = 0; c < N2; c++) {
    const t = T[c];
    let b = 0;
    while (b < nE && t >= E[b]) b++;
    out[c] = b;
  }
  return out;
}

/** Smooth closed rings from d3.contours into a Path2D in local coords (planet radius = 1). */
function ringsToPath(multi, path, minPts = 4) {
  const cs = 2 / G;
  for (const poly of multi.coordinates) {
    for (const ring of poly) {
      if (ring.length < minPts) continue;
      const pts = ring.map(([x, y]) => [-1 + x * cs, -1 + y * cs]);
      // two rounds of Chaikin corner cutting → soft paper-cut curves
      let P = pts;
      for (let it = 0; it < 2; it++) {
        const Q = [];
        const m = P.length - 1; // ring is closed (last = first)
        for (let i = 0; i < m; i++) {
          const a = P[i], b = P[i + 1];
          Q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
        }
        Q.push(Q[0]);
        P = Q;
      }
      path.moveTo(P[0][0], P[0][1]);
      for (let i = 1; i < P.length; i++) path.lineTo(P[i][0], P[i][1]);
      path.closePath();
    }
  }
  return path;
}

/** Filled isotherm bands: Path2D per edge (region where T ≥ edge), local coords. */
export function tempBandPaths(T) {
  const d3 = globalThis.d3;
  const res = d3.contours().size([G, G]).thresholds(BAND_EDGES)(T);
  return res.map((mp) => ringsToPath(mp, new Path2D(), 4));
}

// Wind tuning (local units: planet radius = 1, time in seconds)
export const WIND = {
  kGrad: 0.032, // velocity per unit potential gradient
  kSwirl: 0.07, // tangential speed per unit of (wind − 0.5) in strong inflow
  amb: 0.022, // ambient drift so calm planets still breathe
  vmax: 0.3, // soft cap (tanh)
};

/**
 * Wind vector field: gradient of the interpolated wind potential (money moves from outflow toward
 * inflow), plus a swirl inside strong inflow territories and a faint ambient drift.
 * Writes vx, vy, spd (local units / s). Returns the max speed.
 * aux (optional, filled in): {sinkOf: Int16Array(G²) cluster index of the cells around a small sink (−1 elsewhere),
 * sinkCap: Int16Array(n) how many wind lines that sink may hold at once} — particles.js keeps each sink calm.
 */
export function computeWind(L, wind, pot, vx, vy, spd, div, aux = null) {
  blendScalar(L.coefW, wind, 0, pot);
  const inv2h = 1 / (2 * (2 / G));
  const kG = WIND.kGrad, amb = WIND.amb, ax = L.ambX, ay = L.ambY;
  for (let gy = 0; gy < G; gy++) {
    const row = gy * G;
    const up = (gy > 0 ? gy - 1 : gy) * G, dn = (gy < G - 1 ? gy + 1 : gy) * G;
    for (let gx = 0; gx < G; gx++) {
      const c = row + gx;
      const l = row + (gx > 0 ? gx - 1 : gx), r = row + (gx < G - 1 ? gx + 1 : gx);
      vx[c] = kG * (pot[r] - pot[l]) * inv2h + amb * ax[c];
      vy[c] = kG * (pot[dn + gx] - pot[up + gx]) * inv2h + amb * ay[c];
    }
  }
  // §17 streamlines spiral in, never radial spokes: the pull is turned 35° — one way into inflow (pot > 0, cyclonic),
  // the other way out of outflow (pot < 0, anticyclonic)
  {
    const C = 0.8192, S = 0.5736;
    for (let c = 0; c < N2; c++) {
      const p = pot[c], sg = p > 0.02 ? 1 : p < -0.02 ? -1 : 0;
      if (!sg) continue;
      const x = vx[c], y = vy[c];
      vx[c] = C * x - sg * S * y;
      vy[c] = sg * S * x + C * y;
    }
  }
  // §17 a single company (or a tiny county) is a dot, not a drain: around it the money circles in like a small cyclone
  // (out of a source like an anticyclone) instead of running in as straight spokes
  pointVortices(L, wind, pot, vx, vy, aux);
  for (let k = 0; k < L.n; k++) {
    const w = wind[k];
    if (!(w > 0.9)) continue;
    if (L.kind && L.kind[k] === 'point') continue; // (points have their own small cyclone above)
    const s = WIND.kSwirl * Math.min(2.2, w - 0.8);
    const { sx, sy } = swirlField(L, k);
    for (let c = 0; c < N2; c++) {
      const a = sx[c];
      if (a === 0 && sy[c] === 0) continue;
      vx[c] += s * a;
      vy[c] += s * sy[c];
    }
  }
  const vmax = WIND.vmax;
  let mx = 0;
  for (let c = 0; c < N2; c++) {
    const x = vx[c], y = vy[c];
    const m = Math.sqrt(x * x + y * y);
    if (m > 1e-9) {
      const m2 = vmax * Math.tanh(m / vmax);
      const f = m2 / m;
      vx[c] = x * f; vy[c] = y * f;
      spd[c] = m2;
      if (m2 > mx) mx = m2;
    } else spd[c] = 0;
  }
  // divergence (1/s): sinks (< 0) swallow particles, sources (> 0) emit them
  if (div) {
    for (let gy = 1; gy < G - 1; gy++) {
      for (let gx = 1; gx < G - 1; gx++) {
        const c = gy * G + gx;
        div[c] = (vx[c + 1] - vx[c - 1] + vy[c + G] - vy[c - G]) * inv2h;
      }
    }
  }
  return mx;
}

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let bestBuf = null, ownBuf = null;

/**
 * §17 every peak of the wind potential — a company dot, a cluster of them, a small
 * county, one part of a multi-part region (Micron's Boise next to the Bay Area) — becomes a small cyclone: within the
 * peak's reach the radial pull is damped near the middle and turned into a tangential swirl (the same turn as the 35°
 * spiral above, much stronger close in) — into a sink cyclonic, out of a source anticyclonic, never a hedgehog of
 * straight spokes. Peaks are found on the grid itself (local extrema of |pot| ≥ 12 % of the strongest, merged within
 * 6 cells); each cell follows its nearest peak. Inflow peaks also get a sink zone (aux.sinkOf) and a cap
 * (aux.sinkCap, particles.js). The same on 抽象 planets (a small island no longer collects spokes either).
 */
function pointVortices(L, wind, pot, vx, vy, aux) {
  if (aux) { aux.nSink = 0; if (aux.sinkOf) aux.sinkOf.fill(-1); }
  if (!aux) return;
  let M = 0;
  const inside = L.inside;
  for (let c = 0; c < N2; c++) { const v = Math.abs(pot[c]); if (v > M && (!inside || inside[c])) M = v; }
  if (M < 0.02) return;
  const thr = Math.max(0.02, 0.12 * M);
  let peaks = [];
  for (let gy = 3; gy < G - 3; gy++) for (let gx = 3; gx < G - 3; gx++) {
    const c = gy * G + gx, v = pot[c], a = Math.abs(v);
    if (a < thr) continue;
    const sg = v > 0 ? 1 : -1, sv = sg * v;
    // a 3×3 extremum first (cheap), then 7×7
    if (sg * pot[c - 1] > sv || sg * pot[c + 1] > sv || sg * pot[c - G] > sv || sg * pot[c + G] > sv) continue;
    let ok = true;
    for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3; dx++) { if ((dx || dy) && sg * pot[c + dy * G + dx] > sv) { ok = false; break; } }
    if (ok) peaks.push({ gx, gy, a, sg });
  }
  if (!peaks.length) return;
  peaks.sort((p, q) => q.a - p.a);
  const kept = [];
  for (const p of peaks) if (!kept.some((q) => Math.abs(q.gx - p.gx) < 7 && Math.abs(q.gy - p.gy) < 7)) kept.push(p);
  peaks = kept.slice(0, 48);
  // §26 refine: a swirl's reach is capped on SCREEN (aux.cellPx = px per cell: ≤ ~34–70 px, ×1.3 at the fringe) and
  // scaled by the money at that peak (aux.kMoney[owner] 0…1, planet.js) — a leftover county holding 1.4 % of a sector
  // made a 250 px whirlpool over the Great Lakes
  const kM = aux.kMoney, cpx = aux.cellPx > 0 ? aux.cellPx : 0, lOwn = L.owner;
  const ownerNear = (gx, gy) => {
    if (!lOwn) return -1;
    const c0 = gy * G + gx;
    if (lOwn[c0] >= 0) return lOwn[c0];
    let best = -1, bd = 1e9;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= G || y >= G) continue;
      const o = lOwn[y * G + x], d = dx * dx + dy * dy;
      if (o >= 0 && d < bd) { bd = d; best = o; }
    }
    return best;
  };
  const cl = peaks.map((p) => {
    let RI = Math.max(26, Math.min(48, 26 + 22 * (p.a / M)));
    let mw = 1;
    if (kM) { const o = ownerNear(p.gx, p.gy); if (o >= 0 && o < kM.length) mw = Math.max(0.05, kM[o]); }
    RI *= 0.55 + 0.45 * mw;
    if (cpx) RI = Math.min(RI, (34 + 36 * mw) / cpx);
    RI = Math.max(4, RI);
    return { gx: p.gx, gy: p.gy, aw: (p.a / M) * 2 * (0.4 + 0.6 * mw), m: 1, sg: p.sg, RC: RI * 0.25, RI, cap: Math.round((10 + 14 * (p.a / M)) * (0.5 + 0.5 * mw)) };
  });
  if (!cl.length) return;
  // nearest centre (in units of its own reach) per cell
  if (!bestBuf) { bestBuf = new Float32Array(N2); ownBuf = new Int16Array(N2); }
  const best = bestBuf, own = ownBuf;
  best.fill(2); own.fill(-1);
  // (the turn reaches 1.3 × RI: a peak's whole pull swirls, it fades out only past it)
  const box = (q) => { const r = q.RI * 1.3; return [Math.max(1, Math.floor(q.gx - r)), Math.min(G - 2, Math.ceil(q.gx + r)), Math.max(1, Math.floor(q.gy - r)), Math.min(G - 2, Math.ceil(q.gy + r))]; };
  cl.forEach((q, i) => {
    const [x0, x1, y0, y1] = box(q);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const d = Math.hypot(gx - q.gx, gy - q.gy) / (q.RI * 1.3);
      const c = gy * G + gx;
      if (d < 1 && d < best[c]) { best[c] = d; own[c] = i; }
    }
  });
  cl.forEach((q, i) => {
    const [x0, x1, y0, y1] = box(q);
    const sg = q.sg, base = 0.012 * Math.min(2.5, q.aw);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const c = gy * G + gx;
      if (own[c] !== i) continue;
      const dx = gx - q.gx, dy = gy - q.gy, d = Math.hypot(dx, dy);
      if (d < 1e-3) continue;
      const rx = dx / d, ry = dy / d, tx = sg * ry, ty = -sg * rx;
      const u = vx[c], v = vy[c];
      // turn the flow further the closer it is (up to +55° on top of the 35° spiral: nearly round at the eye), the
      // speed kept; a little steady swirl at the eye where the pull itself fades
      const f = sstep(q.RI * 0.5, q.RI * 1.3, d);
      const th = sg * 0.96 * (1 - f), C = Math.cos(th), S = Math.sin(th);
      const prof = (d / q.RC) * Math.exp(1 - d / q.RC) * (1 - sstep(q.RI * 0.6, q.RI, d));
      vx[c] = C * u - S * v + tx * base * prof;
      vy[c] = S * u + C * v + ty * base * prof;
      if (aux && aux.sinkOf && sg > 0 && d < q.RC * 2.4 + 1.5) aux.sinkOf[c] = i;
    }
  });
  if (aux) {
    aux.nSink = cl.length;
    if (!aux.sinkCap || aux.sinkCap.length < cl.length) aux.sinkCap = new Int16Array(Math.max(16, cl.length * 2));
    cl.forEach((q, i) => { aux.sinkCap[i] = q.cap; });
    aux.peaks = cl; // (inspection: the swirl centres in grid cells)
  }
}

/** Isobars from the pressure grid → Path2D in local coords (planet radius = 1). */
export const ISO_LEVELS = [20, 40, 60, 80];
export function isobarPaths(P) {
  const d3 = globalThis.d3;
  const res = d3.contours().size([G, G]).thresholds(ISO_LEVELS)(P);
  const lo = new Path2D(), mid = new Path2D(), hi = new Path2D();
  for (const mp of res) ringsToPath(mp, mp.value >= 80 ? hi : mp.value <= 20 ? lo : mid, 5);
  return { lo, mid, hi };
}

// ============================================================================ §26 amendment 5: the 3D wind field in 2D
/**
 * The same wind field as the 3D planet (planet3d/world.js _kernels + recompute), on the 2D layout grid, so both renderers
 * draw one wind (streams.js traces it the way planet3d/wind.js does): every territory k pulls the air toward its own
 * nearest coast — strongest right at the shore, fading over a stretch of open water (σ = 0.1·ws + 0.4·clamp(r_k, 0.012·ws, 0.25·ws),
 * cut at 3.2σ — a cyclone is capped in screen size), a weak pull toward its middle inland — times its signed wind; the pull is turned 50° about the local up,
 * growing to ~82° right at the coast, so lines curl round a sink like a small cyclone (cyclonic into inflow, anticyclonic
 * out of outflow, mirrored south of the equator) and never run in as straight spokes. Strong inflow (wind > 0.9) adds a
 * gentle swirl over its land; a faint ambient breeze keeps calm water breathing (below the line threshold).
 * Units: local (planet radius = 1); ws = the 3D view unit in local units (R0 / R on the real Earth, the porthole's zoom
 * in 抽象). opts: {R (px per local unit), ws, angR / partR (rad, sphere.js S.terr), zoom (L.zoom)}.
 * Writes vx, vy, spd; returns the max speed. Kernels are built once per layout and size (cached on L).
 */
// (planet3d/world.js WIND — the 3D field's own constants, kept identical here)
const WIND3 = { kGrad: 0.11, kSwirl: 0.05, amb: 0.016, vmax: 0.26 };
export function coastWind(L, wind, vx, vy, spd, opts = {}) {
  const ws = opts.ws > 0 ? opts.ws : 1;
  const WIND = WIND3;
  const K = coastKernels(L, opts);
  const amb = WIND.amb * ws, ax = K.ambX || L.ambX, ay = K.ambY || L.ambY;
  for (let c = 0; c < N2; c++) { vx[c] = amb * ax[c]; vy[c] = amb * ay[c]; }
  const kG = WIND.kGrad * ws;
  for (let k = 0; k < L.n; k++) {
    const w = wind[k], Kk = K.K[k];
    if (!w || !Kk) continue;
    const s = kG * w, idx = Kk.idx, kx = Kk.kx, ky = Kk.ky;
    for (let i = 0; i < idx.length; i++) { const c = idx[i]; vx[c] += s * kx[i]; vy[c] += s * ky[i]; }
  }
  // strong inflow: a gentle swirl over the landmass (money circling in, never a point sink)
  const cs = 2 / G;
  for (let k = 0; k < L.n; k++) {
    const w = wind[k];
    if (!(w > 0.9) || !L.anchors[k]) continue;
    const [ax0, ay0] = L.anchors[k];
    const rc = Math.max(0.05 * ws, 0.55 * K.r[k]);
    const st = WIND.kSwirl * ws * Math.min(2.2, w - 0.8);
    const gx0 = Math.max(0, Math.floor(((ax0 - 3 * rc) + 1) / cs)), gx1 = Math.min(G - 1, Math.ceil(((ax0 + 3 * rc) + 1) / cs));
    const gy0 = Math.max(0, Math.floor(((ay0 - 3 * rc) + 1) / cs)), gy1 = Math.min(G - 1, Math.ceil(((ay0 + 3 * rc) + 1) / cs));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const x = -1 + (gx + 0.5) * cs, y = -1 + (gy + 0.5) * cs, dx = x - ax0, dy = y - ay0, a = Math.hypot(dx, dy);
      if (a > 3 * rc || a < 1e-5) continue;
      const prof = (a / rc) * Math.exp(1 - a / rc) * st, c = gy * G + gx;
      // tangential (counter-clockwise seen from outside, as 3D's c × p) with a slight inward spiral
      vx[c] += prof * (dy / a - 0.35 * dx / a);
      vy[c] += prof * (-dx / a - 0.35 * dy / a);
    }
  }
  const vmax = WIND.vmax * ws;
  let mx = 0;
  for (let c = 0; c < N2; c++) {
    const x = vx[c], y = vy[c];
    const m = Math.sqrt(x * x + y * y);
    if (m > 1e-12) {
      const m2 = vmax * Math.tanh(m / vmax), f = m2 / m;
      vx[c] = x * f; vy[c] = y * f;
      spd[c] = m2;
      if (m2 > mx) mx = m2;
    } else spd[c] = 0;
  }
  return mx;
}

/** Per-territory pull kernels (sparse: the cells within 3.2σ of its land), cached on L for this size. */
function coastKernels(L, opts) {
  const R = opts.R || 300, ws = opts.ws > 0 ? opts.ws : 1, zl = opts.zoom || L.zoom || 1;
  const key = R.toFixed(1) + '|' + ws.toFixed(4) + '|' + (opts.angR ? 's' : 'l') + '|' + (opts.seed || '');
  if (L._coast && L._coast.key === key) return L._coast;
  const n = L.n, owner = L.owner, cs = 2 / G;
  // r_k: the equivalent radius (3D angR, rad → local: × the layout's zoom); 2D's own rEq when no sphere is at hand
  const r = new Float32Array(n), pr = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    r[k] = opts.angR && Number.isFinite(opts.angR[k]) ? opts.angR[k] * zl : L.rEq[k] || 0.01;
    pr[k] = opts.partR && Number.isFinite(opts.partR[k]) ? opts.partR[k] * zl : r[k];
  }
  // the local up's handedness: mirrored south of the equator (as 3D's hem); and 3D's ambient breeze (zonal trade-wind
  // flow + curl noise seeded by the node, on the sphere) projected onto the map, so calm water breathes the same way
  const hem = new Int8Array(N2).fill(1);
  let ambX = null, ambY = null;
  if (L.view) {
    const v = L.view, [e, nn] = frameOf(v), Z = L.zoom || 1;
    const nz = opts.seed ? makeNoise2(hashStr(opts.seed)) : null;
    const ws3 = ws / Z, nf = 2.2 / Math.sqrt(Math.max(1e-4, ws3));
    if (nz) { ambX = new Float32Array(N2); ambY = new Float32Array(N2); }
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      const x = (-1 + (gx + 0.5) * cs) / Z, y = (-1 + (gy + 0.5) * cs) / Z, r2 = x * x + y * y;
      if (r2 > 1) continue;
      const z = Math.sqrt(1 - r2);
      const d0 = x * e[0] - y * nn[0] + z * v[0], d1 = x * e[1] - y * nn[1] + z * v[1], d2 = x * e[2] - y * nn[2] + z * v[2];
      const c = gy * G + gx;
      if (d1 < 0) hem[c] = -1;
      if (!nz) continue;
      const lat = Math.asin(Math.max(-1, Math.min(1, d1)));
      const el = Math.hypot(d2, d0) || 1, ex = d2 / el, ez = -d0 / el;
      const zon = Math.cos(3 * lat) * 0.6;
      const t1 = nz(d0 * nf + 5, d1 * nf + (d2 * 1.3 * nf) / 2.2), t2 = nz(d2 * nf - 3, d1 * nf - (d0 * 1.3 * nf) / 2.2);
      const n0 = -(d1 * d0), n1 = d0 * d0 + d2 * d2, n2 = -(d1 * d2), nl = Math.hypot(n0, n1, n2) || 1;
      const a0 = (zon + 0.5 * t1) * ex + (0.5 * t2 * n0) / nl, a1 = (0.5 * t2 * n1) / nl, a2 = (zon + 0.5 * t1) * ez + (0.5 * t2 * n2) / nl;
      // onto the screen: east = e, north = nn (screen y down)
      ambX[c] = a0 * e[0] + a1 * e[1] + a2 * e[2];
      ambY[c] = -(a0 * nn[0] + a1 * nn[1] + a2 * nn[2]);
    }
  }
  // the sphere seen orthographically: a step across the map near the limb covers more of the globe (radially ÷ z). Each
  // cell's step costs (E, S, SE, SW) measure that, so distances are on the globe as in 3D (else the US's pull in the
  // mid-Atlantic pointed at a sliver of its land on the far limb)
  const ZL = L.zoom || 1;
  const RX = new Float32Array(N2), RY = new Float32Array(N2), ZZ = new Float32Array(N2);
  const cE = new Float32Array(N2), cS = new Float32Array(N2), cSE = new Float32Array(N2), cSW = new Float32Array(N2);
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const c = gy * G + gx, x = -1 + (gx + 0.5) * cs, y = -1 + (gy + 0.5) * cs, l = Math.hypot(x, y);
    const rx = l > 1e-6 ? x / l : 1, ry = l > 1e-6 ? y / l : 0, q = (l / ZL) * (l / ZL);
    const z = Math.max(0.1, Math.sqrt(Math.max(0, 1 - q))), iz = 1 / z;
    RX[c] = rx; RY[c] = ry; ZZ[c] = z;
    const cost = (dx, dy) => { const a = dx * rx + dy * ry, b = -dx * ry + dy * rx; return Math.hypot(b, a * iz); };
    cE[c] = cost(1, 0); cS[c] = cost(0, 1); cSE[c] = cost(1, 1); cSW[c] = cost(-1, 1);
  }
  const D = new Float32Array(N2);
  const K = new Array(n).fill(null);
  for (let k = 0; k < n; k++) {
    const sig = 0.1 * ws + 0.4 * Math.min(Math.max(r[k], 0.012 * ws), 0.25 * ws), cut = 3.2 * sig; // (capped: ≤ 0.2 ws, as 3D)
    // the territory's cells (a company dot with no cell of its own: its anchor's cell)
    let x0 = G, x1 = -1, y0 = G, y1 = -1, any = false;
    for (let c = 0; c < N2; c++) if (owner[c] === k) { const gx = c % G, gy = (c / G) | 0; if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy; any = true; }
    let seedC = -1;
    if (!any) {
      const a = L.anchors[k];
      if (!a) continue;
      const gx = Math.floor(((a[0] + 1) / 2) * G), gy = Math.floor(((a[1] + 1) / 2) * G);
      if (gx < 0 || gy < 0 || gx >= G || gy >= G) continue;
      seedC = gy * G + gx; x0 = x1 = gx; y0 = y1 = gy;
    }
    const m = Math.ceil(cut / cs) + 1;
    const bx0 = Math.max(0, x0 - m), bx1 = Math.min(G - 1, x1 + m), by0 = Math.max(0, y0 - m), by1 = Math.min(G - 1, y1 + m);
    for (let gy = by0; gy <= by1; gy++) for (let gx = bx0; gx <= bx1; gx++) { const c = gy * G + gx; D[c] = owner[c] === k || c === seedC ? 0 : 1e9; }
    // two-pass chamfer distance (cells)
    for (let gy = by0; gy <= by1; gy++) for (let gx = bx0; gx <= bx1; gx++) {
      const c = gy * G + gx; let d = D[c];
      if (gx > bx0) d = Math.min(d, D[c - 1] + cE[c]);
      if (gy > by0) { d = Math.min(d, D[c - G] + cS[c]); if (gx > bx0) d = Math.min(d, D[c - G - 1] + cSE[c]); if (gx < bx1) d = Math.min(d, D[c - G + 1] + cSW[c]); }
      D[c] = d;
    }
    for (let gy = by1; gy >= by0; gy--) for (let gx = bx1; gx >= bx0; gx--) {
      const c = gy * G + gx; let d = D[c];
      if (gx < bx1) d = Math.min(d, D[c + 1] + cE[c]);
      if (gy < by1) { d = Math.min(d, D[c + G] + cS[c]); if (gx < bx1) d = Math.min(d, D[c + G + 1] + cSE[c]); if (gx > bx0) d = Math.min(d, D[c + G - 1] + cSW[c]); }
      D[c] = d;
    }
    const a0 = L.anchors[k] || [0, 0];
    const idx = [], kx = [], ky = [];
    for (let gy = by0; gy <= by1; gy++) for (let gx = bx0; gx <= bx1; gx++) {
      const c = gy * G + gx, dc = D[c], d = dc * cs;
      if (d > cut) continue;
      const x = -1 + (gx + 0.5) * cs, y = -1 + (gy + 0.5) * cs;
      let gxv, gyv, mag;
      if (dc <= 0) {
        // inland: a weak pull toward the middle (lines that come ashore slow down and stop)
        gxv = a0[0] - x; gyv = a0[1] - y;
        const l = Math.hypot(gxv, gyv);
        if (l < 1e-6) continue;
        gxv /= l; gyv /= l;
        mag = 0.08;
      } else {
        // toward the coast: minus the distance's gradient, on the globe (radial derivative × z), turned in the globe's
        // tangent plane, then seen on the map (radial component × z)
        const l1 = gx > bx0 ? D[c - 1] : dc, r1 = gx < bx1 ? D[c + 1] : dc, u1 = gy > by0 ? D[c - G] : dc, d1 = gy < by1 ? D[c + G] : dc;
        const px = Math.min(r1, 1e6) - Math.min(l1, 1e6), py = Math.min(d1, 1e6) - Math.min(u1, 1e6);
        const rx0 = RX[c], ry0 = RY[c], z = ZZ[c];
        const pr = px * rx0 + py * ry0, pt = -px * ry0 + py * rx0;
        let ur = -pr * z, ut = -pt;
        const l = Math.hypot(ur, ut);
        if (l < 1e-9) continue;
        ur /= l; ut /= l;
        gxv = ur * rx0 - ut * ry0; gyv = ur * ry0 + ut * rx0;
        mag = Math.exp(-d / sig) * (0.55 + 0.45 * Math.min(1, d / (0.4 * sig)));
        // the turn: 50° out at sea, up to ~82° right at the coast (t = g × up on screen: (−gy, gx); as planet3d/world.js)
        const th = (50 + 32 * Math.exp(-d / (0.55 * sig))) * (Math.PI / 180), C = Math.cos(th), S = Math.sin(th) * hem[c];
        const vx0 = C * gxv - S * gyv, vy0 = C * gyv + S * gxv;
        const vr = (vx0 * rx0 + vy0 * ry0) * z, vt = -vx0 * ry0 + vy0 * rx0;
        gxv = vr * rx0 - vt * ry0; gyv = vr * ry0 + vt * rx0;
      }
      idx.push(c); kx.push(gxv * mag); ky.push(gyv * mag);
    }
    if (idx.length) K[k] = { idx: Int32Array.from(idx), kx: Float32Array.from(kx), ky: Float32Array.from(ky) };
  }
  // where some territory's pull reaches (or its own land): lines never run over unclaimed land beyond it (§26 amendment 5)
  const reach = new Uint8Array(N2);
  for (let c = 0; c < N2; c++) if (owner[c] >= 0) reach[c] = 1;
  for (const Kk of K) if (Kk) for (let i = 0; i < Kk.idx.length; i++) reach[Kk.idx[i]] = 1;
  L._coast = { key, K, r, pr, ambX, ambY, reach };
  return L._coast;
}
