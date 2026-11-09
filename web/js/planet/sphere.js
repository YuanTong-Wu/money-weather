// planet/sphere.js — the §25 geometry contract turned into what a renderer needs (no three.js).
//
//   prepareSphere(list, childNodes) → S
//
// list: [{id, rings:[[[lon,lat],…],…], center, area, neutral?}] from geo/index.js. S holds, in the planet's
// object space (unit sphere; x = east at lon 90°, y = north, z = toward lon 0° lat 0°):
//   S.terr[k]   {polys:[{ext: Float32Array xyz, holes:[Float32Array]}], area (sr), angR (rad), center, anchor, inR, cands}
//   S.neutral   [{ext, holes}]  (neutral land: drawn, never coloured by weather, never clickable)
//   S.owner     Int16Array(RW·RH) equirect raster: k ≥ 0 territory, −1 sea, −2 neutral land
//   S.coast     Float32Array(RW·RH) distance from the sea to the nearest coast, 0…DMAX rad (land = 0)
//   S.ownerAt(x, y, z), S.front (unit vector the planet faces by default), S.landFrac
//   S.terr[k].kind 'land' | 'sea' | 'point' (§26: a sea area on the ocean / a company at its HQ)
// Rasters are equirectangular: column = (lon + π) / 2π · RW, row = (π/2 − lat) / π · RH (row 0 = north).
//
// prepareSphere(list, childNodes, opts) options (§26 real Earth):
//   opts.box   {lon, lat0, lat1, span} (deg): rasterize only this window (a zoomed view: same pixel budget, much
//              finer cells); outside it ownerAt() says sea. S.grid describes the mapping (shaders / JS twins).
//   opts.coast false: skip the sea → coast distance (S.coast = null) — the real Earth's own sea has its own.
//   opts.pointR  (rad) radius of the little disc a 'point' item owns in the raster (hover / wind), default 0.01.
//   opts.neutral false: ignore neutral entries.   opts.segMin: drop ring points closer than this (rad; detail).

export const RW = 2048, RH = 1024;
export const DMAX = 0.3; // coast-distance range encoded in S.coast (rad)
const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const SEG_MAX = 0.016; // densify ring edges to this (rad) so tops and walls follow the sphere
const SEG_MIN = 0.0012;

/**
 * The raster's mapping. Global: lon −π…π × lat π/2…−π/2 (wraps in x). Window: a lon span centred on lonC (rotated,
 * so the antimeridian never splits it) × lat lat1…lat0, square pixels in radians, no wrap.
 */
export function makeGrid(W, H, box) {
  if (!box) return { W, H, lonC: 0, lon0: -Math.PI, dLon: TAU, lat1: Math.PI / 2, dLat: Math.PI, wrap: true, box: null };
  const R = Math.PI / 180;
  const lat0 = Math.max(-89.5, Math.min(box.lat0, box.lat1)) * R, lat1 = Math.min(89.5, Math.max(box.lat0, box.lat1)) * R;
  const dLon = Math.min(TAU, Math.max(0.002, box.span * R));
  return { W, H, lonC: box.lon * R, lon0: -dLon / 2, dLon, lat1, dLat: lat1 - lat0, wrap: dLon >= TAU - 1e-6, box };
}
const wrapPi = (a) => (a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a);
/** Unit vector → raster cell index (−1 outside a window). */
function cellOf(G, x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  const lon = wrapPi(Math.atan2(x, z) - G.lonC), lat = Math.asin(Math.max(-1, Math.min(1, y / l)));
  let cx = Math.floor(((lon - G.lon0) / G.dLon) * G.W), cy = Math.floor(((G.lat1 - lat) / G.dLat) * G.H);
  if (G.wrap) { if (cx >= G.W) cx -= G.W; if (cx < 0) cx += G.W; if (cy >= G.H) cy = G.H - 1; if (cy < 0) cy = 0; }
  else if (cx < 0 || cy < 0 || cx >= G.W || cy >= G.H) return -1;
  return cy * G.W + cx;
}
/** Pixel centre (raster of size w×h over grid G's extent) → unit vector. */
function gridDir(G, x, y, w, h, out) {
  const lon = G.lonC + G.lon0 + ((x + 0.5) / w) * G.dLon, lat = G.lat1 - ((y + 0.5) / h) * G.dLat;
  const c = Math.cos(lat);
  out[0] = c * Math.sin(lon); out[1] = Math.sin(lat); out[2] = c * Math.cos(lon);
  return out;
}
const rowLat = (G, y, h) => G.lat1 - ((y + 0.5) / h) * G.dLat;

export function dirOf(lon, lat, out = [0, 0, 0]) {
  const a = lon / DEG, b = lat / DEG, c = Math.cos(b);
  out[0] = c * Math.sin(a); out[1] = Math.sin(b); out[2] = c * Math.cos(a);
  return out;
}
export function lonLatOf(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [Math.atan2(x, z) * DEG, Math.asin(Math.max(-1, Math.min(1, y / l))) * DEG];
}
/** Tangent frame at unit vector c: [east, north] (arrays). */
export function frameAt(c) {
  let ex = c[2], ez = -c[0];
  let l = Math.hypot(ex, ez);
  if (l < 1e-6) { ex = 1; ez = 0; l = 1; }
  const e = [ex / l, 0, ez / l];
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  return [e, [n[0] / nl, n[1] / nl, n[2] / nl]];
}
/** Point at local equidistant offset (x, y) (rad, east/north) from unit vector c. */
export function expMap(c, e, n, x, y, out = [0, 0, 0]) {
  const r = Math.hypot(x, y);
  if (r < 1e-12) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }
  const s = Math.sin(r) / r, k = Math.cos(r);
  out[0] = k * c[0] + s * (x * e[0] + y * n[0]);
  out[1] = k * c[1] + s * (x * e[1] + y * n[1]);
  out[2] = k * c[2] + s * (x * e[2] + y * n[2]);
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

// ------------------------------------------------------------------------------------------ rings
function openRing(r) {
  const out = [];
  for (const p of r || []) {
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
    const l = out[out.length - 1];
    if (l && Math.abs(l[0] - p[0]) < 1e-9 && Math.abs(l[1] - p[1]) < 1e-9) continue;
    out.push([+p[0], +p[1]]);
  }
  if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop(); }
  return out;
}
const closed = (r) => r.concat([r[0]]);

/**
 * Rings of one entry → polygons [{ext, holes}] in lon/lat, d3 winding (exterior clockwise / small side;
 * holes the other way). A ring inside a larger ring of the same entry is a hole (a lake / an enclave).
 */
function polygonsOf(rings) {
  const d3 = globalThis.d3;
  const rs = [];
  for (const r0 of rings || []) {
    let r = openRing(r0);
    if (r.length < 3) continue;
    let a = d3.geoArea({ type: 'Polygon', coordinates: [closed(r)] });
    if (a > TAU) { r = r.slice().reverse(); a = 4 * Math.PI - a; }
    if (a < 1e-9) continue;
    rs.push({ r, a, b: d3.geoBounds({ type: 'Polygon', coordinates: [closed(r)] }) });
  }
  rs.sort((x, y) => y.a - x.a);
  const polys = [];
  const inB = (b, B) => {
    // lon range check with wrap (bounds may straddle the antimeridian: b[0][0] > b[1][0])
    if (b[0][1] < B[0][1] - 1e-6 || b[1][1] > B[1][1] + 1e-6) return false;
    const wrapB = B[0][0] > B[1][0];
    const inLon = (x) => (wrapB ? x >= B[0][0] - 1e-6 || x <= B[1][0] + 1e-6 : x >= B[0][0] - 1e-6 && x <= B[1][0] + 1e-6);
    return inLon(b[0][0]) && inLon(b[1][0]);
  };
  for (const it of rs) {
    let host = null;
    for (const P of polys) {
      if (P.a <= it.a || !inB(it.b, P.b)) continue;
      const probe = it.r[0];
      if (d3.geoContains({ type: 'Polygon', coordinates: [closed(P.ext)] }, probe)) { host = P; break; }
    }
    if (host && !host.holes.some((h) => d3.geoContains({ type: 'Polygon', coordinates: [closed(h)] }, it.r[0]))) host.holes.push(it.r);
    else polys.push({ ext: it.r, holes: [], a: it.a, b: it.b });
  }
  return polys;
}

/** lon/lat ring → Float32Array xyz, densified to SEG_MAX and thinned below SEG_MIN. */
function ringXYZ(r, segMin = SEG_MIN) {
  const SEG_MIN = segMin;
  const out = [];
  const v = [0, 0, 0], w = [0, 0, 0];
  let last = null;
  const push = (p) => {
    if (last) { const d = Math.acos(Math.max(-1, Math.min(1, p[0] * last[0] + p[1] * last[1] + p[2] * last[2]))); if (d < SEG_MIN) return; }
    out.push(p[0], p[1], p[2]);
    last = p.slice();
  };
  for (let i = 0, n = r.length; i < n; i++) {
    dirOf(r[i][0], r[i][1], v);
    dirOf(r[(i + 1) % n][0], r[(i + 1) % n][1], w);
    const d = Math.acos(Math.max(-1, Math.min(1, v[0] * w[0] + v[1] * w[1] + v[2] * w[2])));
    const m = Math.max(1, Math.ceil(d / SEG_MAX));
    const sd = Math.sin(d);
    for (let s = 0; s < m; s++) {
      const t = s / m;
      if (s === 0 || sd < 1e-9) { push(v.slice()); continue; }
      const a = Math.sin((1 - t) * d) / sd, b = Math.sin(t * d) / sd;
      push([a * v[0] + b * w[0], a * v[1] + b * w[1], a * v[2] + b * w[2]]);
    }
  }
  // drop a closing duplicate
  const k = out.length;
  if (k >= 6 && Math.abs(out[0] - out[k - 3]) + Math.abs(out[1] - out[k - 2]) + Math.abs(out[2] - out[k - 1]) < SEG_MIN * 0.5) out.length = k - 3;
  return Float32Array.from(out);
}

// ------------------------------------------------------------------------------------------ rasters
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
const code = (i) => [i, 255 - i, (i * 97 + 31) & 255];
const NEUTRAL_CODE = 250;

/** Anisotropic chamfer distance on the equirect grid (wraps in x), in radians. d: Float32Array, modified in place. */
function chamfer(d, W, H, G) {
  const px = G ? G.dLon / W : TAU / W;
  const wrap = !G || G.wrap;
  const hx = new Float32Array(H), dg = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const c = Math.max(0.02, Math.cos(G ? rowLat(G, y, H) : Math.PI / 2 - ((y + 0.5) / H) * Math.PI));
    hx[y] = c * px; dg[y] = Math.hypot(c, 1) * px;
  }
  const v = px;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      const row = y * W, up = (y - 1) * W, h = hx[y], g = dg[y];
      for (let x = 0; x < W; x++) {
        const i = row + x;
        let m = d[i];
        const xl = x === 0 ? (wrap ? W - 1 : 0) : x - 1, xr = x === W - 1 ? (wrap ? 0 : W - 1) : x + 1;
        let t = d[row + xl] + h; if (t < m) m = t;
        if (y > 0) {
          t = d[up + x] + v; if (t < m) m = t;
          t = d[up + xl] + g; if (t < m) m = t;
          t = d[up + xr] + g; if (t < m) m = t;
        }
        d[i] = m;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      const row = y * W, dn = (y + 1) * W, h = hx[y], g = dg[y];
      for (let x = W - 1; x >= 0; x--) {
        const i = row + x;
        let m = d[i];
        const xl = x === 0 ? (wrap ? W - 1 : 0) : x - 1, xr = x === W - 1 ? (wrap ? 0 : W - 1) : x + 1;
        let t = d[row + xr] + h; if (t < m) m = t;
        if (y < H - 1) {
          t = d[dn + x] + v; if (t < m) m = t;
          t = d[dn + xl] + g; if (t < m) m = t;
          t = d[dn + xr] + g; if (t < m) m = t;
        }
        d[i] = m;
      }
    }
  }
  return d;
}

/**
 * Distance (rad) from every sea pixel to the nearest land pixel's edge: an exact separable EDT (rows with wrap,
 * then Felzenszwalb's lower envelope down each column), with the seed row's cos(lat) as the x metric. O(N).
 */
export function seaDistance(owner, W, H, G) {
  const N = W * H, px = G ? G.dLon / W : TAU / W, BIG = 1e20;
  const wrap = !G || G.wrap, T = wrap ? 2 * W : W;
  const g = new Float64Array(N);
  const row = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    const c = Math.max(0.02, Math.cos(G ? rowLat(G, y, H) : Math.PI / 2 - ((y + 0.5) / H) * Math.PI)), c2 = c * c, o = y * W;
    // 1D distance to the nearest land pixel in this row (wraps on a whole globe): two sweeps over 2W
    let any = false;
    for (let x = 0; x < W; x++) if (owner[o + x] !== -1) { any = true; break; }
    if (!any) { for (let x = 0; x < W; x++) g[o + x] = BIG; continue; }
    let last = -1e9;
    for (let t = 0; t < T; t++) { const x = t % W; if (owner[o + x] !== -1) last = t; if (t >= W) row[x] = t - last; else row[x] = t - last; }
    last = 1e9;
    for (let t = T - 1; t >= 0; t--) { const x = t % W; if (owner[o + x] !== -1) last = t; const dd = last - t; if (dd < row[x]) row[x] = dd; }
    for (let x = 0; x < W; x++) g[o + x] = row[x] * row[x] * c2;
  }
  // columns: d²(y) = min_y' g(y') + (y − y')²
  const f = new Float64Array(H), dd = new Float64Array(H), v = new Int32Array(H), z = new Float64Array(H + 1);
  const out = new Float32Array(N);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    let k = 0;
    v[0] = 0; z[0] = -BIG; z[1] = BIG;
    for (let q = 1; q < H; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
    }
    k = 0;
    for (let q = 0; q < H; q++) { while (z[k + 1] < q) k++; dd[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    for (let y = 0; y < H; y++) {
      const p = y * W + x;
      out[p] = owner[p] !== -1 ? 0 : Math.max(0, Math.sqrt(dd[y]) - 0.5) * px; // the coast is the land pixel's edge
    }
  }
  return out;
}

/** Pixel centre → unit vector. */
function pixDir(x, y, W, H, out) {
  const lon = ((x + 0.5) / W) * TAU - Math.PI, lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
  const c = Math.cos(lat);
  out[0] = c * Math.sin(lon); out[1] = Math.sin(lat); out[2] = c * Math.cos(lon);
  return out;
}

// ------------------------------------------------------------------------------------------ prepare
const cache = new Map();

/** A small clockwise disc ring (lon/lat deg) of angular radius r (rad) around [lon, lat]: a point item's footprint. */
function discRing(lon, lat, r) {
  const c = dirOf(lon, lat), [e, n] = frameAt(c), out = [], q = [0, 0, 0];
  for (let i = 0; i < 24; i++) {
    const a = (-i / 24) * TAU;
    expMap(c, e, n, Math.cos(a) * r, Math.sin(a) * r, q);
    out.push(lonLatOf(q[0], q[1], q[2]));
  }
  return out;
}

export function prepareSphere(list, childNodes, opts = {}) {
  const d3 = globalThis.d3;
  const kids = (childNodes || []).filter((c) => c && c.id != null);
  const n = kids.length;
  const idxOf = new Map(kids.map((c, k) => [c.id, k]));
  const box = opts.box || null;
  const ck = (list && list.__sphereKey) ? list.__sphereKey + (box ? '|' + JSON.stringify(box) : '') + (opts.rasterW ? '|w' + opts.rasterW : '') : null;
  if (ck && cache.has(ck)) return cache.get(ck);
  const t0 = performance.now();
  const terr = kids.map(() => ({ polysLL: [], area: 0, kind: 'land', mark: null }));
  const neutralLL = [];
  const pointR = opts.pointR || 0.01;
  const segMin = opts.segMin || SEG_MIN;
  const pre = opts.neutralPre || null; // {LL, XYZ}: neutral land already converted (neutralPolys) — reused per node
  if (pre) neutralLL.push(...pre.LL);
  for (const it of list || []) {
    if (!it) continue;
    const k = it.neutral ? undefined : idxOf.get(it.id);
    if (k == null && (opts.neutral === false || pre)) continue;
    if (k != null && (it.kind === 'sea' || it.kind === 'point')) terr[k].kind = it.kind;
    if (k != null && it.kind === 'point') {
      // a company at its HQ: a little disc in the raster (hover, wind), never a plate
      const c = Array.isArray(it.center) ? it.center : null;
      if (c) { terr[k].mark = c; terr[k].polysLL.push({ ext: discRing(c[0], c[1], pointR), holes: [], a: Math.PI * pointR * pointR, b: null }); }
      continue;
    }
    if (!Array.isArray(it.rings)) continue;
    const polys = polygonsOf(it.rings);
    if (k == null) neutralLL.push(...polys);
    else terr[k].polysLL.push(...polys);
  }
  // ---- owner raster (canvas: one colour code per territory; antialiased pixels resolved below)
  // (refine #13: a zoomed window's raster can be smaller — opts.rasterW — the window is ~1.6 screens wide at most)
  const WMAX = box && opts.rasterW ? Math.max(256, Math.min(RW, opts.rasterW | 0)) : RW, HMAX = Math.round((RH * WMAX) / RW);
  let W = WMAX, H = HMAX;
  if (box) {
    // square cells (the canvas projection below draws with one scale): a tall window (the 2D planet's square screen
    // window) gets fewer columns instead of rows squeezed to RH — squeezed rows put every anchor / owner lookup south
    // of its drawn shape (the 2D labels sat ~250 px under AI 算力's counties at ×32)
    const ar = Math.max(0.05, Math.abs(box.lat1 - box.lat0)) / Math.max(0.05, box.span);
    H = Math.round(W * ar);
    if (H > HMAX) { H = HMAX; W = Math.max(64, Math.round(HMAX / ar)); }
    else if (H < 64) { H = 64; W = Math.min(4096, Math.round(64 / ar)); }
  }
  const G = makeGrid(W, H, box);
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, W, H);
  const proj = box
    ? d3.geoEquirectangular().rotate([-box.lon, 0]).scale(W / G.dLon).translate([W / 2, (G.lat1 * W) / G.dLon]).precision(0.1)
    : d3.geoEquirectangular().scale(W / TAU).translate([W / 2, H / 2]).precision(0.15);
  const path = d3.geoPath(proj, g);
  const fillPolys = (polys, i) => {
    if (!polys.length) return;
    const [r, gg, b] = code(i);
    g.fillStyle = `rgb(${r},${gg},${b})`;
    g.beginPath();
    path({ type: 'MultiPolygon', coordinates: polys.map((p) => [closed(p.ext), ...p.holes.map((h) => closed(h.slice().reverse()))]) });
    g.fill('evenodd');
  };
  fillPolys(neutralLL, NEUTRAL_CODE);
  // sea areas first, land over them, points (little discs) on top
  const order = [];
  for (const kind of ['sea', 'land', 'point']) for (let k = 0; k < n && k < 249; k++) if (terr[k].kind === kind) order.push(k);
  for (const k of order) fillPolys(terr[k].polysLL, k + 1);
  const img = g.getImageData(0, 0, W, H).data;
  const N = W * H;
  const owner = new Int16Array(N);
  const alpha = new Uint8Array(N);
  const UNRES = -3;
  for (let p = 0, q = 0; p < N; p++, q += 4) {
    const a = img[q + 3];
    alpha[p] = a;
    if (a < 128) { owner[p] = -1; continue; }
    const r = img[q], gg = img[q + 1], b = img[q + 2];
    if (gg === 255 - r && b === ((r * 97 + 31) & 255)) owner[p] = r === NEUTRAL_CODE ? -2 : r >= 1 && r <= n ? r - 1 : -1;
    else owner[p] = UNRES;
  }
  for (let p = 0; p < N; p++) {
    if (owner[p] !== UNRES) continue;
    const x = p % W, y = (p / W) | 0;
    let best = -1;
    for (let r = 1; r <= 2 && best === -1; r++) {
      for (let dy = -r; dy <= r && best === -1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = G.wrap ? (x + dx + W) % W : x + dx;
          if (xx < 0 || xx >= W) continue;
          const o = owner[yy * W + xx];
          if (o >= 0 || o === -2) { best = o; break; }
        }
      }
    }
    owner[p] = best;
  }
  const tR = performance.now();
  // ---- sea → coast distance (sub-pixel start from the antialiased coverage)
  let coast = null;
  if (opts.coast !== false) {
    const dist = seaDistance(owner, W, H, G);
    coast = new Float32Array(N); // rad, clamped (a float texture: smooth iso-lines, no 8-bit terraces)
    for (let p = 0; p < N; p++) coast[p] = Math.min(DMAX, dist[p]);
  }
  const tC = performance.now();
  // ---- inner distance (half resolution) → anchors (poles of inaccessibility), centroids, areas
  const W2 = W >> 1, H2 = H >> 1, N2 = W2 * H2;
  const own2 = new Int16Array(N2);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) own2[y * W2 + x] = owner[(2 * y + 1) * W + 2 * x + 1];
  const inner = new Float32Array(N2);
  const px2 = G.dLon / W2;
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const i = y * W2 + x, o = own2[i];
    if (o < 0) { inner[i] = 0; continue; }
    const l = own2[y * W2 + (x + W2 - 1) % W2], r = own2[y * W2 + (x + 1) % W2];
    const u = y > 0 ? own2[i - W2] : o, dn = y < H2 - 1 ? own2[i + W2] : o;
    inner[i] = l !== o || r !== o || u !== o || dn !== o ? 0.5 * px2 : 1e9;
  }
  chamfer(inner, W2, H2, G);
  const cen = Array.from({ length: n }, () => [0, 0, 0]);
  const v = [0, 0, 0];
  for (let y = 0; y < H2; y++) {
    const wgt = Math.cos(rowLat(G, y, H2));
    for (let x = 0; x < W2; x++) {
      const o = own2[y * W2 + x];
      if (o < 0) continue;
      gridDir(G, x, y, W2, H2, v);
      const c = cen[o];
      c[0] += v[0] * wgt; c[1] += v[1] * wgt; c[2] += v[2] * wgt;
    }
  }
  const out = {
    n, ids: kids.map((c) => c.id), idxOf, W, H, owner, coast, terr: [], neutral: [], grid: G,
    mode: (list && list.mode) || 'abstract',
  };
  let landA = 0, fs = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const T = terr[k];
    const isPt = T.kind === 'point';
    const area = isPt ? 0 : T.polysLL.reduce((a, p) => a + p.a - p.holes.reduce((s2, h) => s2 + d3.geoArea({ type: 'Polygon', coordinates: [closed(h)] }), 0), 0);
    const c = cen[k];
    const cl = Math.hypot(c[0], c[1], c[2]);
    let center;
    if (isPt && T.mark) center = dirOf(T.mark[0], T.mark[1]);
    else if (cl > 1e-9) center = [c[0] / cl, c[1] / cl, c[2] / cl];
    else {
      const it = (list || []).find((x) => x && x.id === kids[k].id);
      center = it && it.center ? dirOf(it.center[0], it.center[1]) : [0, 0, 1];
    }
    const angR = isPt ? pointR : Math.acos(Math.max(-1, 1 - Math.max(area, 1e-6) / TAU));
    if (T.kind === 'land') landA += area;
    fs[0] += center[0] * Math.max(area, 1e-4); fs[1] += center[1] * Math.max(area, 1e-4); fs[2] += center[2] * Math.max(area, 1e-4);
    out.terr.push({
      kind: T.kind, polys: isPt ? [] : T.polysLL.map((p) => ({ ext: ringXYZ(p.ext, segMin), holes: p.holes.map((h) => ringXYZ(h, segMin)) })),
      area, angR, center, anchor: center.slice(), inR: 0, cands: [],
    });
  }
  if (pre) out.neutral = pre.XYZ;
  else for (const p of neutralLL) out.neutral.push({ ext: ringXYZ(p.ext, segMin), holes: p.holes.map((h) => ringXYZ(h, segMin)) });
  // ---- connected parts (half resolution): one id per landmass piece of one territory (AI 算力 = Bay Area + Taiwan …)
  const comp = new Int32Array(N2).fill(-1);
  const cTerr = [], cCnt = [], cArea = [], cMax = [], cMaxI = [];
  {
    const queue = new Int32Array(N2);
    const px2a = G.dLon / W2, py2a = G.dLat / H2;
    for (let s0 = 0; s0 < N2; s0++) {
      const o = own2[s0];
      if (o < 0 || comp[s0] >= 0) continue;
      const id = cTerr.length;
      let qh = 0, qt = 0, cnt = 0, area = 0, mx = -1, mxi = s0;
      queue[qt++] = s0; comp[s0] = id;
      while (qh < qt) {
        const i = queue[qh++], x = i % W2, y = (i / W2) | 0;
        cnt++;
        area += Math.cos(rowLat(G, y, H2)) * px2a * py2a;
        if (inner[i] > mx) { mx = inner[i]; mxi = i; }
        const nb = [y > 0 ? i - W2 : -1, y < H2 - 1 ? i + W2 : -1, x > 0 ? i - 1 : G.wrap ? i + W2 - 1 : -1, x < W2 - 1 ? i + 1 : G.wrap ? i - W2 + 1 : -1];
        for (const j of nb) if (j >= 0 && comp[j] < 0 && own2[j] === o) { comp[j] = id; queue[qt++] = j; }
      }
      cTerr.push(o); cCnt.push(cnt); cArea.push(area); cMax.push(mx); cMaxI.push(mxi);
    }
  }
  const nComp = cTerr.length;
  // cells of every part, grouped (counting sort) — the anchor search walks one part only
  const cStart = new Int32Array(nComp + 1);
  for (let i = 0; i < N2; i++) if (comp[i] >= 0) cStart[comp[i] + 1]++;
  for (let c = 0; c < nComp; c++) cStart[c + 1] += cStart[c];
  const cCells = new Int32Array(cStart[nComp]);
  { const fill = cStart.slice(0, nComp); for (let i = 0; i < N2; i++) if (comp[i] >= 0) cCells[fill[comp[i]]++] = i; }
  const cellOf2 = (ll) => {
    const lon = wrapPi(ll[0] / DEG - G.lonC), lat = ll[1] / DEG;
    let cx = Math.floor(((lon - G.lon0) / G.dLon) * W2), cy = Math.floor(((G.lat1 - lat) / G.dLat) * H2);
    if (G.wrap) { cx = ((cx % W2) + W2) % W2; cy = Math.max(0, Math.min(H2 - 1, cy)); } else if (cx < 0 || cy < 0 || cx >= W2 || cy >= H2) return -1;
    return cy * W2 + cx;
  };
  /** the nearest half-res cell of territory k to a lon/lat (≤ 6 cells away), −1 if none */
  const nearCell = (ll, k) => {
    const c0 = cellOf2(ll);
    if (c0 < 0) return -1;
    if (own2[c0] === k) return c0;
    const x0 = c0 % W2, y0 = (c0 / W2) | 0;
    let best = -1, bd = Infinity;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const yy = y0 + dy; let xx = x0 + dx;
      if (yy < 0 || yy >= H2) continue;
      if (G.wrap) xx = (xx + W2) % W2; else if (xx < 0 || xx >= W2) continue;
      const j = yy * W2 + xx;
      if (own2[j] !== k) continue;
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = j; }
    }
    return best;
  };
  const itemOf = new Map();
  for (const it of list || []) if (it && !it.neutral && idxOf.has(it.id)) itemOf.set(it.id, it);
  const isReal = out.mode === 'real';
  const okLL = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]);
  // anchors: §26 on the real Earth a region's name / ①②③ / 主航道 sit where its MONEY is (real.js item.center, a
  // money-weighted point on the heaviest part), inside the part that holds it; elsewhere deep inside, mildly
  // preferring the area centroid (a point's anchor is its HQ)
  const best = new Float32Array(n).fill(-1e9), bestI = new Int32Array(n).fill(-1), maxIn = new Float32Array(n);
  const moneyDone = new Uint8Array(n), anchorComp = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const T = out.terr[k], it = itemOf.get(kids[k].id);
    if (T.kind === 'point' || !isReal || !it || !okLL(it.center)) continue;
    const money = [+it.center[0], +it.center[1]];
    T.center = dirOf(money[0], money[1]);
    const c0 = nearCell(money, k);
    if (c0 < 0) continue;
    const cc = comp[c0], cap = Math.max(1e-6, 0.5 * cMax[cc]), compR = Math.max(2 * cMax[cc], 2 * G.dLon / W2);
    let bs = -1e9, bi = c0;
    for (let q = cStart[cc]; q < cStart[cc + 1]; q++) {
      const i = cCells[q];
      gridDir(G, i % W2, (i / W2) | 0, W2, H2, v);
      const d = Math.acos(Math.max(-1, Math.min(1, v[0] * T.center[0] + v[1] * T.center[1] + v[2] * T.center[2])));
      const sc = Math.min(inner[i], cap) / cap - 0.8 * d / compR;
      if (sc > bs) { bs = sc; bi = i; }
    }
    bestI[k] = bi; moneyDone[k] = 1; anchorComp[k] = cc;
  }
  for (let i = 0; i < N2; i++) { const o = own2[i]; if (o >= 0 && inner[i] > maxIn[o]) maxIn[o] = inner[i]; }
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const i = y * W2 + x, o = own2[i];
    if (o < 0 || moneyDone[o] || out.terr[o].kind === 'point') continue;
    gridDir(G, x, y, W2, H2, v);
    const T = out.terr[o];
    const dc = Math.acos(Math.max(-1, Math.min(1, v[0] * T.center[0] + v[1] * T.center[1] + v[2] * T.center[2])));
    const sc = inner[i] / Math.max(1e-6, maxIn[o]) - 0.3 * dc / Math.max(0.02, T.angR);
    if (sc > best[o]) { best[o] = sc; bestI[o] = i; }
  }
  for (let k = 0; k < n; k++) {
    const T = out.terr[k];
    if (T.kind === 'point') { T.inR = T.angR * 0.5; continue; }
    if (bestI[k] >= 0) {
      T.anchor = gridDir(G, bestI[k] % W2, (bestI[k] / W2) | 0, W2, H2, [0, 0, 0]);
      T.inR = inner[bestI[k]];
      if (anchorComp[k] < 0) anchorComp[k] = comp[bestI[k]];
    } else T.inR = T.angR * 0.5;
    // the part the anchor sits on: its own size (not the whole multi-part territory's) bounds the label candidates
    T.partR = anchorComp[k] >= 0 ? Math.sqrt(cArea[anchorComp[k]] / Math.PI) : T.angR;
  }
  // hub (planet3d 主航道 ends, ①②③ leaders): real.js item.hub when given, else the anchor; per-part info for labels
  for (let k = 0; k < n; k++) {
    const T = out.terr[k], it = itemOf.get(kids[k].id);
    T.hub = it && okLL(it.hub) ? dirOf(+it.hub[0], +it.hub[1]) : T.anchor.slice();
    if (it) { T.city = it.cityZh || it.city || null; T.cc = it.cc || null; }
    // real.js: most of this place's money is off the view ('→ 新竹 台积电') — the ①②③ card says where it points
    T.off = it && it.offscreen && it.offscreen.label ? String(it.offscreen.label) : null;
    T.parts = [];
  }
  if (isReal) {
    const byT = Array.from({ length: n }, () => []);
    for (let c = 0; c < nComp; c++) if (cTerr[c] >= 0 && out.terr[cTerr[c]].kind === 'land') byT[cTerr[c]].push(c);
    for (let k = 0; k < n; k++) {
      if (!byT[k].length) continue;
      const it = itemOf.get(kids[k].id);
      const cs = byT[k].sort((a, b) => cArea[b] - cArea[a]).slice(0, 24);
      const parts = cs.map((c) => ({
        comp: c, dir: c === anchorComp[k] ? out.terr[k].anchor.slice() : gridDir(G, cMaxI[c] % W2, (cMaxI[c] / W2) | 0, W2, H2, [0, 0, 0]),
        inR: cMax[c], area: cArea[c], city: null, cityLL: null, w: 0, main: c === anchorComp[k],
      }));
      // name each part after its heaviest company town (real.js sites are heaviest first)
      for (const s of (it && Array.isArray(it.sites) ? it.sites : [])) {
        if (!s || !Number.isFinite(+s.lon) || !Number.isFinite(+s.lat)) continue;
        const ci = nearCell([+s.lon, +s.lat], k);
        if (ci < 0) continue;
        const p = parts.find((q) => q.comp === comp[ci]);
        if (!p) continue;
        p.w += +s.w || 0;
        if (!p.city) { p.city = s.cityZh || s.city || null; p.cityLL = [+s.lon, +s.lat]; }
      }
      out.terr[k].parts = parts;
    }
  }
  const ownerAt = G.wrap && !box
    ? (x, y, z) => {
      const l = Math.hypot(x, y, z) || 1;
      let cx = Math.floor(((Math.atan2(x, z) + Math.PI) / TAU) * W);
      let cy = Math.floor(((Math.PI / 2 - Math.asin(Math.max(-1, Math.min(1, y / l)))) / Math.PI) * H);
      if (cx >= W) cx -= W; if (cx < 0) cx += W;
      if (cy >= H) cy = H - 1; if (cy < 0) cy = 0;
      return owner[cy * W + cx];
    }
    : (x, y, z) => { const c = cellOf(G, x, y, z); return c < 0 ? -1 : owner[c]; };
  out.ownerAt = ownerAt;
  // candidate points inside each territory (labels, clouds): anchor first, then rings around it
  const q = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const T = out.terr[k];
    if (T.kind === 'point') { T.cands = [T.anchor.slice()]; continue; }
    const [e, nn] = frameAt(T.anchor);
    const cands = [T.anchor.slice()];
    const rr = Math.max(T.inR, Math.min(T.angR, T.partR || T.angR) * 0.35);
    for (const [f, ph, cnt] of [[0.45, 0.3, 8], [0.8, 0.69, 10], [1.15, 0.1, 12]]) {
      for (let i = 0; i < cnt; i++) {
        const a = ph + (i / cnt) * TAU;
        expMap(T.anchor, e, nn, Math.cos(a) * rr * f, Math.sin(a) * rr * f, q);
        if (ownerAt(q[0], q[1], q[2]) !== k) continue;
        // keep a margin from the coast
        let ok = true;
        for (const s2 of [0.18, -0.18]) { const q2 = expMap(T.anchor, e, nn, Math.cos(a + s2) * rr * f * 1.12, Math.sin(a + s2) * rr * f * 1.12, [0, 0, 0]); if (ownerAt(q2[0], q2[1], q2[2]) !== k) ok = false; }
        if (ok) cands.push(q.slice());
      }
    }
    T.cands = cands;
  }
  const fl = Math.hypot(fs[0], fs[1], fs[2]);
  out.front = list && Array.isArray(list.front) ? dirOf(list.front[0], list.front[1]) : fl > 1e-6 ? [fs[0] / fl, fs[1] / fl, fs[2] / fl] : [0, 0, 1];
  out.landFrac = landA / (4 * Math.PI);
  out.stats = { rasterMs: tR - t0, coastMs: tC - tR, totalMs: performance.now() - t0 };
  if (ck) { cache.set(ck, out); if (cache.size > 6) cache.delete(cache.keys().next().value); }
  return out;
}

/** Neutral land (d3 polygons [[ring, …holes], …]) converted once for prepareSphere(…, {neutralPre}).
 *  segMin (rad, optional): the detail kept — a zoomed 1:10m window passes the territories' own (a metro coast). */
export function neutralPolys(polys, segMin = SEG_MIN) {
  const LL = [];
  for (const p of polys || []) LL.push(...polygonsOf(p));
  return { LL, XYZ: LL.map((p) => ({ ext: ringXYZ(p.ext, segMin), holes: p.holes.map((h) => ringXYZ(h, segMin)) })) };
}

/** Bilinear coast distance (rad) at a unit vector (JS twin of the ocean shader's lookup). */
export function coastDistAt(S, x, y, z) {
  const G = S.grid || makeGrid(S.W, S.H, null);
  const l = Math.hypot(x, y, z) || 1;
  const lon = wrapPi(Math.atan2(x, z) - G.lonC), lat = Math.asin(Math.max(-1, Math.min(1, y / l)));
  const fx = ((lon - G.lon0) / G.dLon) * S.W - 0.5, fy = ((G.lat1 - lat) / G.dLat) * S.H - 0.5;
  const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(S.H - 2, Math.floor(fy)));
  const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
  const W = S.W, c = S.coast;
  if (!c) return DMAX;
  const a = (xx, yy) => c[yy * W + (G.wrap ? ((xx % W) + W) % W : Math.max(0, Math.min(W - 1, xx)))];
  const v = (a(x0, y0) * (1 - tx) + a(x0 + 1, y0) * tx) * (1 - ty) + (a(x0, y0 + 1) * (1 - tx) + a(x0 + 1, y0 + 1) * tx) * ty;
  return v;
}
