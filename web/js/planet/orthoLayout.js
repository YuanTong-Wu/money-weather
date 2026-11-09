// planet/orthoLayout.js — the §25 sphere layout seen by the 2D planet: an orthographic view (d3.geoOrthographic's
// projection, centred on the land) turned into the disk-layout format of planet/layout.js, so 2D and 3D show the
// same landmasses. Cells outside every landmass are sea (owner −1); fields are built so that each landmass keeps
// one flat temperature colour and the wind potential reaches across the sea between them (money crossing water).
//
//   orthoLayout(S, key, viewDir?, zoom = 1, D?) → layout (same fields as computeLayout) + {sea: true, rings, neutralRings, view, zoom, D}
// §26 amendment 5: D = the 3D camera's distance (planet/persp.js lensD) — the view is the 3D camera's own vertical
// perspective (the limb still at radius `zoom`, the look point s/(D−1) ≈ 1.15× an orthographic map); no D = orthographic.
//
// §26 real Earth: zoom > 1 is d3.geoOrthographic's scale(R·zoom). Full-bleed (planet.js; §26 amendment 5: 抽象 too, it
// was a round porthole onto a magnified planet): the grid square [-1, 1]² is the screen, every cell on the visible
// hemisphere counts (the limb sits at radius `zoom`, past the square's corners once zoom ≥ √2).
// kinds: L.kind[k] 'land' | 'sea' | 'point'.

import { G } from './layout.js';
import { boxBlur, makeNoise2, hashStr, smoothstep } from './util.js';
import { frameAt } from './sphere.js';
import { lensK, lensInv } from './persp.js'; // §26 amendment 5: the 3D camera's lens
import { clipRing, ringSink } from './horizon.js'; // §26 amendment 5: rings cut at the horizon, closed along the limb

const cache = new Map();

export function orthoLayout(S, key, viewDir, zoom = 1, lens = 0) {
  const n = S.n;
  const Z = Math.max(1, +zoom || 1);
  const D = lens > 1 ? +lens : 0; // (0: orthographic)
  const VIS = D ? 1 / D : 0; // the limb's facing
  let v = viewDir;
  if (!v) {
    // the land's area-weighted centre (2D shows one hemisphere: face the land)
    const s = [0, 0, 0];
    for (const T of S.terr) { s[0] += T.center[0] * T.area; s[1] += T.center[1] * T.area; s[2] += T.center[2] * T.area; }
    const l = Math.hypot(s[0], s[1], s[2]);
    v = l > 1e-6 ? [s[0] / l, s[1] / l, s[2] / l] : S.front || [0, 0, 1];
  }
  const ck = key + '|' + v.map((x) => x.toFixed(3)).join(',') + '|' + Z.toFixed(3) + '|' + D.toFixed(3);
  if (cache.has(ck) && cache.get(ck).S === S) return cache.get(ck).L;
  const t0 = performance.now();
  const [e, nn] = frameAt(v);
  const proj = (x, y, z) => {
    const f = x * v[0] + y * v[1] + z * v[2], k = D ? Z * lensK(D, f) : Z;
    return [(x * e[0] + y * e[1] + z * e[2]) * k, -(x * nn[0] + y * nn[1] + z * nn[2]) * k, f - VIS];
  };
  const N2 = G * G, cs = 2 / G;
  const real = S.mode === 'real';
  const owner = new Int16Array(N2).fill(-1);
  const inside = new Uint8Array(N2);
  const neutral = new Uint8Array(N2);
  for (let gy = 0; gy < G; gy++) {
    const y = -1 + (gy + 0.5) * cs;
    for (let gx = 0; gx < G; gx++) {
      const x0 = -1 + (gx + 0.5) * cs, c = gy * G + gx;
      // (§26 amendment 5: 抽象 is full-bleed too — the limb test below is the window; it was the unit porthole here)
      const x = x0 / Z, yy = y / Z;
      const r2 = x * x + yy * yy;
      if (r2 > 1) continue;
      inside[c] = 1;
      const q = D ? lensInv(D, x, yy) : [x, yy, Math.sqrt(1 - r2)]; // (§26 amendment 5: through the 3D lens)
      if (!q) continue;
      const dx = q[0] * e[0] - q[1] * nn[0] + q[2] * v[0], dy = q[0] * e[1] - q[1] * nn[1] + q[2] * v[1], dz = q[0] * e[2] - q[1] * nn[2] + q[2] * v[2];
      const o = S.ownerAt(dx, dy, dz);
      if (o >= 0) owner[c] = o; else if (o === -2) neutral[c] = 1;
    }
  }
  const visible = (r) => {
    let m = 0;
    for (let i = 0; i < r.length; i += 3) { const p = proj(r[i], r[i + 1], r[i + 2]); if (p[2] > 0 && (Z <= 1 || Math.abs(p[0]) < 3 && Math.abs(p[1]) < 3)) m++; }
    return m;
  };
  // rings in disk coords (§26 amendment 5: cut at the horizon and closed along the limb on their own side,
  // planet/horizon.js — far-side points slid onto the limb closed the 1:50m Eurasia the wrong way round seen from
  // 大中华 / 亚太 / 印度, and 'evenodd' swapped land and sea)
  const lensOf = D ? (f) => lensK(D, f) : () => 1;
  const clipXY = (r) => { const k = ringSink(); clipRing(r, v, e, nn, VIS, lensOf, k, Z, 0, 0, 0.004); return k.rings; };
  const rings = [], polys = [], exts = [];
  for (let k = 0; k < n; k++) {
    const rs = [], es = [];
    let best = null, bv = 0;
    for (const p of S.terr[k].polys) {
      const vis = visible(p.ext);
      if (!vis) continue;
      const xys = clipXY(p.ext);
      if (!xys.length) continue;
      let xy = xys[0];
      for (const q of xys) { rs.push(q); es.push(q); if (q.length > xy.length) xy = q; }
      for (const h of p.holes) if (visible(h)) rs.push(...clipXY(h));
      if (vis > bv) { bv = vis; best = xy; }
    }
    rings.push(rs);
    polys.push(best || []);
    exts.push(es);
  }
  const neutralRings = [];
  for (const p of S.neutral) { if (!visible(p.ext)) continue; neutralRings.push(...clipXY(p.ext)); for (const h of p.holes) if (visible(h)) neutralRings.push(...clipXY(h)); }
  // distance to border (chamfer, grid cells)
  const INF = 1e9, dist = new Float32Array(N2);
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const c = gy * G + gx, o = owner[c];
    let edge = !inside[c] || gx === 0 || gy === 0 || gx === G - 1 || gy === G - 1;
    if (!edge) edge = owner[c - 1] !== o || owner[c + 1] !== o || owner[c - G] !== o || owner[c + G] !== o;
    dist[c] = edge ? 0 : INF;
  }
  const D2 = Math.SQRT2;
  for (let gy = 1; gy < G - 1; gy++) for (let gx = 1; gx < G - 1; gx++) { const c = gy * G + gx; dist[c] = Math.min(dist[c], dist[c - 1] + 1, dist[c - G] + 1, dist[c - G - 1] + D2, dist[c - G + 1] + D2); }
  for (let gy = G - 2; gy > 0; gy--) for (let gx = G - 2; gx > 0; gx--) { const c = gy * G + gx; dist[c] = Math.min(dist[c], dist[c + 1] + 1, dist[c + G] + 1, dist[c + G + 1] + D2, dist[c + G - 1] + D2); }
  // per territory: cells, depth, anchor (projected sphere anchor when visible, else the deepest visible cell)
  const cnt = new Int32Array(n), maxDepth = new Float32Array(n), deep = new Int32Array(n).fill(-1);
  for (let c = 0; c < N2; c++) { const o = owner[c]; if (o < 0) continue; cnt[o]++; if (dist[c] > maxDepth[o]) { maxDepth[o] = dist[c]; deep[o] = c; } }
  const anchors = [];
  for (let k = 0; k < n; k++) {
    // (refine-names: the sphere's own anchor — 3D's anchorDir. The 2D sphere now has 3D's window and raster, so the
    // anchor sits on the money's own part as in 3D; the old pull toward item.center put 债券's tiny ring and name on
    // empty land between its pieces)
    const a = S.terr[k].anchor;
    const [x, y, zv] = proj(a[0], a[1], a[2]);
    const z = zv + VIS; // (the facing)
    const gx = Math.floor(((x + 1) / 2) * G), gy = Math.floor(((y + 1) / 2) * G);
    const c = gx >= 0 && gy >= 0 && gx < G && gy < G ? gy * G + gx : -1;
    if (S.terr[k].kind === 'point' && zv > 0) anchors.push([x, y]); // a company: exactly at its HQ (even off the window)
    else if (z > 0.25 && c >= 0 && owner[c] === k) anchors.push([x, y]);
    // §26 the real Earth: the money's own place even when its piece is thinner than a grid cell (a metro wedge) —
    // never the deepest blob somewhere else (2D and 3D put a name / ①②③ / 主航道 end on the same spot)
    else if (real && z > 0.25 && x * x + y * y < 1.1 * Z * Z && Math.abs(x) < 1.05 && Math.abs(y) < 1.05) anchors.push([x, y]);
    else if (deep[k] >= 0) anchors.push([-1 + ((deep[k] % G) + 0.5) * cs, -1 + (((deep[k] / G) | 0) + 0.5) * cs]);
    else { const l = Math.hypot(x, y) || 1, f = real || Z > 1.001 ? Math.max(1.2, 1.5 * Z) : 1.2; anchors.push([(x / l) * f, (y / l) * f]); } // behind the planet
  }
  const areas = Array.from(cnt, (c) => c * cs * cs);
  // memberships: temperature / pressure normalised over land (one flat colour per landmass), wind potential wide
  const tmp = new Float32Array(N2);
  const sT = Math.max(1, Math.round(G * 0.012)), sP = Math.max(2, Math.round(G * 0.02)), sW = Math.max(6, Math.round(G * 0.075));
  const coefT = [], coefP = [], coefW = [];
  const sumT = new Float32Array(N2), sumP = new Float32Array(N2);
  for (let k = 0; k < n; k++) {
    const a = new Float32Array(N2), b = new Float32Array(N2), w = new Float32Array(N2);
    const isPt = S.terr[k].kind === 'point';
    for (let c = 0; c < N2; c++) if (owner[c] === k) { a[c] = 1; b[c] = 1; w[c] = 0.4 + 0.6 * Math.min(1, dist[c] / Math.max(1, maxDepth[k])); }
    // §26 a company is a dot: its pull is gentle and local (fields.js turns it into a small cyclone around the dot —
    // a wide pull made the whole screen's wind run at one pixel)
    if (isPt) { const [ax, ay] = [anchors[k][0], anchors[k][1]], gx = Math.floor(((ax + 1) / 2) * G), gy = Math.floor(((ay + 1) / 2) * G); if (gx >= 0 && gy >= 0 && gx < G && gy < G) w[gy * G + gx] = 1; }
    boxBlur(a, G, sT, 2, tmp); boxBlur(b, G, sP, 2, tmp); boxBlur(w, G, isPt ? Math.round(sW * 0.9) : sW, 3, tmp);
    for (let c = 0; c < N2; c++) { sumT[c] += a[c]; sumP[c] += b[c]; }
    coefT.push(a); coefP.push(b); coefW.push(w);
  }
  for (let k = 0; k < n; k++) {
    const a = coefT[k], b = coefP[k];
    for (let c = 0; c < N2; c++) {
      a[c] = owner[c] >= 0 ? (owner[c] === k ? 1 : 0) : sumT[c] > 1e-4 ? a[c] / sumT[c] : 0;
      b[c] = sumP[c] > 1e-4 ? b[c] / sumP[c] : 0;
    }
    // wind potential: normalise each landmass's reach so small islands still pull
    let m = 0;
    for (let c = 0; c < N2; c++) if (coefW[k][c] > m) m = coefW[k][c];
    const top = S.terr[k].kind === 'point' ? 0.5 : 1;
    if (m > 0) for (let c = 0; c < N2; c++) coefW[k][c] *= top / m;
  }
  // grain + ambient curl (as computeLayout)
  const seed = hashStr(key);
  const nG = makeNoise2(seed ^ 0x27d4eb2f), nC = makeNoise2(seed ^ 0x165667b1);
  const grain = new Float32Array(N2), psi = new Float32Array(N2);
  for (let gy = 0; gy < G; gy++) {
    const y = -1 + (gy + 0.5) * cs;
    for (let gx = 0; gx < G; gx++) {
      const x = -1 + (gx + 0.5) * cs, c = gy * G + gx;
      grain[c] = 0.6 * nG(x * 4.2, y * 4.2) + 0.3 * nG(x * 11 + 9, y * 11 - 4) + 0.15 * nG(x * 23, y * 23);
      psi[c] = nC(x * 1.7 + 11, y * 1.7 - 7) + 0.5 * nC(x * 3.9 - 2, y * 3.9 + 5);
    }
  }
  const ambX = new Float32Array(N2), ambY = new Float32Array(N2);
  let amax = 1e-6;
  for (let gy = 1; gy < G - 1; gy++) for (let gx = 1; gx < G - 1; gx++) {
    const c = gy * G + gx, vx = (psi[c + G] - psi[c - G]) * 0.5, vy = -(psi[c + 1] - psi[c - 1]) * 0.5;
    ambX[c] = vx; ambY[c] = vy; amax = Math.max(amax, Math.hypot(vx, vy));
  }
  for (let c = 0; c < N2; c++) { ambX[c] /= amax; ambY[c] /= amax; }
  const bbox = polys.map((p) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
  });
  const L = {
    key, n, ids: S.ids.slice(), share: areas.map((a) => a / (areas.reduce((s, b) => s + b, 0) || 1)), sites: anchors, weights: new Array(n).fill(0),
    cells: polys, polys, rings, exts, neutralRings, areas, rEq: areas.map((a) => Math.sqrt(a / Math.PI)), bbox, anchors, maxDepth,
    G, owner, inside, neutral, dist, coefT, coefP, coefW, grain, ambX, ambY, swirl: new Array(n).fill(null),
    sea: true, view: v, zoom: Z, D, kind: S.terr.map((T) => T.kind || 'land'), stats: { totalMs: performance.now() - t0 },
  };
  cache.set(ck, { S, L });
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return L;
}
