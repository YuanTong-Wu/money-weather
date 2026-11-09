// planet/seabed.js — §26 amendment 5: the 2D ground drawn like the 3D one (planet3d/core.js OCEAN_FS, PLATE_FS, GLSL_TOON).
//
// 2D is the 3D planet flattened, so its ground uses the 3D recipe: the sea goes from deep to shallow by its distance to
// the nearest coast, with two thin 等深線 rings, a soft foam band and a crisp foam line on every shore, and sparse
// two-crest wave marks on open water; the toon light gives a faint mid tone and a thin shadow crescent on the lower-right
// limb and a cream rim on the lit limb, and the light swings toward the camera as a real Earth zooms in (a map, no
// terminator); unclaimed land carries a faint dot screen. 3D measures the sea in (coast distance × zoom); on screen
// that is px / R0 (R0 = the porthole radius), so a coast reads the same at ×1 and at ×150. Line widths are 3D's own
// (fwidth-based: device pixels).
//
//   drawSeabed(g, o)           the sea into a cached layer drawn in local units (1 = R css px):
//                              o = {rect, R, R0, dpr, land: [[Path2D, rule], …], pal: seaLook(), proj: {v, e, n, Z, D?}, zoom, real}
//                              (the moving picture, refine-surface: o.off = [cx, cy] — g and the land paths in screen px,
//                              local units = css px from the globe's centre; o.cells = the grid's cell budget)
//   seaStrokes(ctx, path, pal, R0, dpr)   the light version for the moving picture (stacked offset strokes, screen px)
//   dotScreen(g, path, rule, pal, R0, devUnit, devCss)  the dot screen on unclaimed land (a cached tile, pitch fixed on screen)
//   toonLight(zoom, real)      3D's key light (screen space, y up) → {L, midMix, zt}
//   shadeLand(g, path, rule, Rw, light, day, mul?, reach?)  the land's toon shadow (≤ 6 % luma, as PLATE_FS), clipped to `path`
//   seaShadeMul(pal)           the multiply colour that turns the water into its toon shadow (the moving picture)
//   drawRim(ctx, cx, cy, Rw, light, day)  the cream rim on the lit limb (per frame: it sits on land and sea alike)
//   unitFade(A, pxR, f0, f1)   an admin-unit arc's fade by its own length on screen (3D world.js UNITLINE_FS), 8 steps

import { lensK, lensVis, lensTheta } from './persp.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hexRGB = (h) => { const n = parseInt(String(h).slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// 3D's sea in units of R0 (planet3d/core.js OCEAN_FS: dist × zoom)
const SHALLOW = 0.16, LINE1 = 0.04, LINE2 = 0.09, FOAM_LINE = 0.0125, FOAM0 = 0.0015, FOAM1 = 0.0075;
const WAVE_CELL = 0.085; // wave-mark cell (rad × zoom)
const DOT = 0.0125; // dot-screen pitch (rad × zoom)

/** 3D's key light (planet3d.js render: within 20° of the camera at globe scale, swinging to the camera as a real
 *  Earth zooms in) in screen space (x right, y up, z toward the viewer) + the toon mid-tone mix. */
export function toonLight(zoom = 1, real = false) {
  const zt = real ? clamp((zoom - 1.05) / 1.6, 0, 1) : 0;
  const lx = -0.62, ly = 0.55, ll = Math.hypot(lx, ly);
  const tilt = Math.tan((20 * Math.PI) / 180) + (0.12 - Math.tan((20 * Math.PI) / 180)) * zt;
  const x = (lx / ll) * tilt, y = (ly / ll) * tilt, l = Math.hypot(x, y, 1);
  return { L: [x / l, y / l, 1 / l], midMix: 0.88 + 0.06 * zt, zt };
}

let maskC = null, imgC = null;
const lite = { maskC: null, imgC: null }; // (the moving picture's own scratch canvases: no resize ping-pong with the rest frame)
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** Exact Euclidean distance (cells) from every sea cell to the nearest land cell: rows (two sweeps), then
 *  Felzenszwalb's lower envelope down every column. Returns squared distances. */
function edt(land, W, H) {
  const N = W * H, BIG = 1e12;
  const g = new Float64Array(N);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let last = -BIG;
    for (let x = 0; x < W; x++) { if (land[o + x]) last = x; g[o + x] = x - last; }
    last = BIG;
    for (let x = W - 1; x >= 0; x--) { if (land[o + x]) last = x; const d = last - x; if (d < g[o + x]) g[o + x] = d; }
    for (let x = 0; x < W; x++) { const d = g[o + x]; g[o + x] = d >= BIG / 2 ? BIG : d * d; }
  }
  const f = new Float64Array(H), v = new Int32Array(H), z = new Float64Array(H + 1);
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
    for (let q = 0; q < H; q++) { while (z[k + 1] < q) k++; const d = q - v[k]; g[q * W + x] = d * d + f[v[k]]; }
  }
  return g;
}

/** Iso-lines of field D (W×H, cell centres at (i + .5, j + .5)) at several levels in one pass (marching squares) →
 *  one path per level (segments; one stroke each, so overlaps never double the ink). */
function isoLines(D, W, H, levels, paths, mx, my) {
  const nL = levels.length;
  let lo = Infinity, hi = -Infinity;
  for (const L of levels) { lo = Math.min(lo, L); hi = Math.max(hi, L); }
  for (let j = 0; j + 1 < H; j++) {
    const o = j * W;
    for (let i = 0; i + 1 < W; i++) {
      const a = D[o + i], b = D[o + i + 1], c = D[o + W + i + 1], d = D[o + W + i];
      if ((a > hi && b > hi && c > hi && d > hi) || (a <= lo && b <= lo && c <= lo && d <= lo)) continue;
      for (let li = 0; li < nL; li++) {
        const L = levels[li];
        const m = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
        if (m === 0 || m === 15) continue;
        const path = paths[li];
        // edge points: top (a-b), right (b-c), bottom (d-c), left (a-d)
        const tx = i + (L - a) / (b - a), ry = j + (L - b) / (c - b), bx = i + (L - d) / (c - d), ly = j + (L - a) / (d - a);
        let x1, y1, x2, y2, x3 = null, y3, x4, y4;
        switch (m) {
          case 1: case 14: x1 = i; y1 = ly; x2 = tx; y2 = j; break;
          case 2: case 13: x1 = tx; y1 = j; x2 = i + 1; y2 = ry; break;
          case 3: case 12: x1 = i; y1 = ly; x2 = i + 1; y2 = ry; break;
          case 4: case 11: x1 = i + 1; y1 = ry; x2 = bx; y2 = j + 1; break;
          case 6: case 9: x1 = tx; y1 = j; x2 = bx; y2 = j + 1; break;
          case 7: case 8: x1 = i; y1 = ly; x2 = bx; y2 = j + 1; break;
          case 5: x1 = i; y1 = ly; x2 = tx; y2 = j; x3 = i + 1; y3 = ry; x4 = bx; y4 = j + 1; break;
          case 10: x1 = tx; y1 = j; x2 = i + 1; y2 = ry; x3 = i; y3 = ly; x4 = bx; y4 = j + 1; break;
          default: continue;
        }
        path.moveTo(mx(x1), my(y1)); path.lineTo(mx(x2), my(y2));
        if (x3 !== null) { path.moveTo(mx(x3), my(y3)); path.lineTo(mx(x4), my(y4)); }
      }
    }
  }
}

const fract = (x) => x - Math.floor(x);
const hash2 = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

/**
 * The sea of one cached layer (see the header). Returns {ms} (and leaves the clip / transform as it found them).
 * The layer must already be clipped to the window; land is drawn by the caller after this.
 */
export function drawSeabed(g, o) {
  const t0 = performance.now();
  const { rect, R, R0, pal } = o;
  const ox = o.off ? o.off[0] : 0, oy = o.off ? o.off[1] : 0;
  const dpx = Math.max(1, o.dpr || 1); // device px per css px on the SCREEN (3D's fwidth-based widths)
  const wC = (rect[2] - rect[0]) * R, hC = (rect[3] - rect[1]) * R;
  const s = Math.max(1.25, Math.sqrt((wC * hC) / (o.cells || 260000))); // cell size, css px (≈ 260k cells: ~25 ms a view)
  const W = Math.max(2, Math.ceil(wC / s) + 1), H = Math.max(2, Math.ceil(hC / s) + 1);
  const deep = hexRGB(pal.deep), shal = hexRGB(pal.shal), deepSh = hexRGB(pal.deepSh), shalSh = hexRGB(pal.shalSh);
  const scr = o.cells ? lite : null;
  // ---- land mask (the coverage of every coast at the cell size)
  let mC = scr ? scr.maskC : maskC;
  if (!mC) { mC = canvas(W, H); if (scr) scr.maskC = mC; else maskC = mC; }
  if (mC.width !== W || mC.height !== H) { mC.width = W; mC.height = H; }
  const mg = mC.getContext('2d', { willReadFrequently: true });
  mg.setTransform(1, 0, 0, 1, 0, 0);
  mg.clearRect(0, 0, W, H);
  const ks = R / s;
  mg.setTransform(ks, 0, 0, ks, -(rect[0] * R + ox) / s, -(rect[1] * R + oy) / s);
  mg.fillStyle = '#fff';
  for (const [p, rule] of o.land) if (p) mg.fill(p, rule || 'nonzero');
  const md = mg.getImageData(0, 0, W, H).data;
  const N = W * H, land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = md[4 * i + 3] >= 128 ? 1 : 0;
  // ---- coast distance (css px), the land pixel's edge = the coast (as sphere.js seaDistance)
  const g2 = edt(land, W, H), D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = land[i] ? 0 : Math.max(0, Math.sqrt(g2[i]) - 0.5) * s;
  // ---- the water: deep → shallow, and the toon light per cell (3D toon(): lit / mid / shadow by N·L)
  const lt = o.light || toonLight(o.zoom, o.real);
  const L = lt.L, Zl = (o.proj && o.proj.Z) || 1, mm = lt.midMix;
  let iC = scr ? scr.imgC : imgC;
  if (!iC) { iC = canvas(W, H); if (scr) scr.imgC = iC; else imgC = iC; }
  if (iC.width !== W || iC.height !== H) { iC.width = W; iC.height = H; }
  const ig = iC.getContext('2d');
  const im = ig.createImageData(W, H), px = im.data;
  const fw = (s / R) / Zl * 1.2; // one cell in N·L units (≈ 3D's fwidth)
  for (let j = 0; j < H; j++) {
    const ly = rect[1] + ((j + 0.5) * s) / R, ny = -ly / Zl;
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      const u = D[p] / R0, sh = 1 - sstep(0, SHALLOW, u);
      let r = deep[0] + (shal[0] - deep[0]) * sh, gg = deep[1] + (shal[1] - deep[1]) * sh, b = deep[2] + (shal[2] - deep[2]) * sh;
      const lx = rect[0] + ((i + 0.5) * s) / R, nx = lx / Zl, q = 1 - nx * nx - ny * ny;
      if (q > 0) {
        const ndl = L[0] * nx + L[1] * ny + L[2] * Math.sqrt(q);
        if (ndl < 0.28 + fw) {
          const lit = sstep(-fw, fw, ndl), mid = sstep(0.28 - fw, 0.28 + fw, ndl);
          const k = 1 - (lit * (mm + (1 - mm) * mid)); // share of the shadow colour
          if (k > 0.002) {
            const sr = deepSh[0] + (shalSh[0] - deepSh[0]) * sh, sg = deepSh[1] + (shalSh[1] - deepSh[1]) * sh, sb = deepSh[2] + (shalSh[2] - deepSh[2]) * sh;
            r += (sr - r) * k; gg += (sg - gg) * k; b += (sb - b) * k;
          }
        }
      }
      px[4 * p] = r; px[4 * p + 1] = gg; px[4 * p + 2] = b; px[4 * p + 3] = 255;
    }
  }
  ig.putImageData(im, 0, 0);
  g.save();
  if (ox || oy) g.translate(ox, oy);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(iC, rect[0], rect[1], (W * s) / R, (H * s) / R);
  // ---- 等深線 (two thin rings fading out to sea) and the foam line, from the same coast distance
  const mx = (x) => rect[0] + ((x + 0.5) * s) / R, my = (y) => rect[1] + ((y + 0.5) * s) / R;
  g.lineCap = 'round';
  const line = hexRGB(pal.line), foam = hexRGB(pal.foam);
  const iso = [new Path2D(), new Path2D(), new Path2D()];
  isoLines(D, W, H, [LINE2 * R0, LINE1 * R0, FOAM_LINE * R0], iso, mx, my);
  for (const [k, a, w] of [[0, 0.16, 1.9], [1, 0.32, 2.0]]) { g.lineWidth = w / dpx / R; g.strokeStyle = rgba(line, a); g.stroke(iso[k]); }
  // ---- wave marks (open water only): two small crests in sparse cells of the sphere (3D waveMarks)
  if (o.proj && o.waves !== false) waveMarks(g, o, D, W, H, s, hexRGB(pal.wave), dpx);
  // ---- foam: a crisp line just off the shore, a soft band on it (the band as two vector strokes: exact at any zoom)
  g.lineWidth = 2.3 / dpx / R; g.strokeStyle = rgba(foam, 0.7); g.stroke(iso[2]);
  g.lineJoin = 'round';
  if (ox || oy) g.translate(-ox, -oy); // (the land paths: screen px)
  for (const [w, a] of [[(FOAM0 + FOAM1) * 0.62 * R0, 0.42], [(FOAM0 + FOAM1) * 0.3 * R0, 0.55]]) {
    g.lineWidth = (2 * Math.max(0.6, w)) / R; g.strokeStyle = rgba(foam, a);
    for (const [p] of o.land) if (p) g.stroke(p);
  }
  g.restore();
  return { ms: performance.now() - t0, cells: N, s };
}

function waveMarks(g, o, D, W, H, s, wave, dpx) {
  const { rect, R, R0 } = o, { v, e, n, Z } = o.proj, LD = o.proj.D || 0; // (LD: the 3D lens, persp.js)
  const zoom = Math.max(1, o.zoom || 1), WS = WAVE_CELL / zoom, PI = Math.PI;
  // the lat / lon range on screen: every cell centre when the globe is whole, else the screen's own box
  let lat0 = -PI / 2, lat1 = PI / 2, lonC = 0, half = PI;
  const toLL = (x, y) => {
    const a = x / Z, b = y / Z, q = 1 - a * a - b * b;
    if (q < 0) return null;
    const zq = Math.sqrt(q);
    const dx = a * e[0] - b * n[0] + zq * v[0], dy = a * e[1] - b * n[1] + zq * v[1], dz = a * e[2] - b * n[2] + zq * v[2];
    return [Math.atan2(dx, dz), Math.asin(clamp(dy, -1, 1))];
  };
  const reach = Math.hypot(Math.max(Math.abs(rect[0]), Math.abs(rect[2])), Math.max(Math.abs(rect[1]), Math.abs(rect[3])));
  if (reach < Z * 0.98) {
    const c = toLL(0, 0);
    let a0 = Infinity, a1 = -Infinity, d0 = Infinity, d1 = -Infinity;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const ll = toLL(rect[0] + ((rect[2] - rect[0]) * i) / 8, rect[1] + ((rect[3] - rect[1]) * j) / 8);
      if (!ll) continue;
      a0 = Math.min(a0, ll[1]); a1 = Math.max(a1, ll[1]);
      let dl = ll[0] - c[0];
      dl = dl > PI ? dl - 2 * PI : dl < -PI ? dl + 2 * PI : dl;
      d0 = Math.min(d0, dl); d1 = Math.max(d1, dl);
    }
    const pad = 2 * WS;
    lat0 = Math.max(-PI / 2, a0 - pad); lat1 = Math.min(PI / 2, a1 + pad);
    if (lat1 < 1.4 && lat0 > -1.4) { lonC = c[0] + (d0 + d1) / 2; half = (d1 - d0) / 2 + pad / Math.max(0.15, Math.cos(Math.max(Math.abs(lat0), Math.abs(lat1)))); }
  }
  const rows0 = Math.max(0, Math.floor((lat0 + PI / 2) / WS)), rows1 = Math.min(Math.ceil(PI / WS), Math.ceil((lat1 + PI / 2) / WS));
  if ((rows1 - rows0) * (half / WS) > 60000) return; // (never: the box above keeps it to the screen)
  const P = [new Path2D(), new Path2D()];
  let nMarks = 0;
  for (let row = rows0; row <= rows1; row++) {
    const latc = (row + 0.5) * WS - PI / 2;
    if (Math.abs(latc) > 1.35) continue;
    const cl = Math.cos(latc), nc = Math.max(3, Math.floor((2 * PI * cl) / WS));
    let c0 = 0, c1 = nc - 1;
    if (half < PI) { c0 = Math.floor(((lonC - half + PI) / (2 * PI)) * nc); c1 = Math.ceil(((lonC + half + PI) / (2 * PI)) * nc); }
    for (let cc = c0; cc <= c1; cc++) {
      const col = ((cc % nc) + nc) % nc;
      const h = hash2(col, row);
      if (h > 0.16) continue;
      const h2 = hash2(col + 17.3, row + 17.3), h3 = hash2(col + 41.9, row + 41.9);
      const lonc = ((col + 0.5) / nc) * 2 * PI - PI;
      const lat = latc + (h3 - 0.5) * 0.3 * WS, lon = lonc + ((h2 - 0.5) * 0.3 * WS) / Math.max(0.05, Math.cos(lat));
      const cb = Math.cos(lat), x = cb * Math.sin(lon), y = Math.sin(lat), z = cb * Math.cos(lon);
      const fz = x * v[0] + y * v[1] + z * v[2];
      if (fz < 0.08) continue;
      const kz = LD ? Z * lensK(LD, fz) : Z; // (refine-surface: through the 3D lens, as the land — marks stay on their sea)
      const mxl = (x * e[0] + y * e[1] + z * e[2]) * kz, myl = -(x * n[0] + y * n[1] + z * n[2]) * kz;
      if (mxl < rect[0] || mxl > rect[2] || myl < rect[1] || myl > rect[3]) continue;
      // open water only (3D: smoothstep(0.06, 0.1, dist × zoom))
      const gi = Math.round(((mxl - rect[0]) * R) / s - 0.5), gj = Math.round(((myl - rect[1]) * R) / s - 0.5);
      if (gi < 0 || gj < 0 || gi >= W || gj >= H) continue;
      const f = sstep(0.06, 0.1, D[gj * W + gi] / R0);
      if (f < 0.25) continue;
      // the local east / north at the mark (projected: foreshortened toward the limb, as on the 3D sphere)
      const ex = cb > 1e-6 ? Math.cos(lon) : 1, ez = cb > 1e-6 ? -Math.sin(lon) : 0; // east = (cos lon, 0, −sin lon)
      const nx3 = -Math.sin(lat) * Math.sin(lon), ny3 = Math.cos(lat), nz3 = -Math.sin(lat) * Math.cos(lon);
      const Ex = (ex * e[0] + ez * e[2]) * kz, Ey = -(ex * n[0] + ez * n[2]) * kz;
      const Nx = (nx3 * e[0] + ny3 * e[1] + nz3 * e[2]) * kz, Ny = -(nx3 * n[0] + ny3 * n[1] + nz3 * n[2]) * kz;
      const r = (0.12 + 0.03 * h3) * WS, path = P[f > 0.75 ? 0 : 1];
      for (const sgn of [-1, 1]) {
        const ox = sgn * r * 0.98;
        for (let t = 0; t <= 8; t++) {
          const th = Math.PI * (1 - t / 8), ax = ox + r * Math.cos(th), ay = r * Math.sin(th);
          const X = mxl + ax * Ex + ay * Nx, Y = myl + ax * Ey + ay * Ny;
          if (t) path.lineTo(X, Y); else path.moveTo(X, Y);
        }
      }
      nMarks++;
    }
  }
  if (!nMarks) return;
  g.lineWidth = 3 / dpx / R;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = rgba(wave, 0.55); g.stroke(P[0]);
  g.strokeStyle = rgba(wave, 0.3); g.stroke(P[1]);
}

/**
 * The moving picture's sea (screen px, ctx untransformed): deep water, the shallows as stacked offset strokes of the
 * coast (a stroke of width 2d covers everything within d of a shore), the two 等深線 rings and the foam — 10 strokes.
 */
export function seaStrokes(ctx, path, pal, R0, dpr = 1) {
  const deep = hexRGB(pal.deep), shal = hexRGB(pal.shal), line = hexRGB(pal.line), foam = hexRGB(pal.foam);
  const col = (u) => mix(deep, shal, 1 - sstep(0, SHALLOW, u));
  const dpx = Math.max(1, dpr);
  ctx.lineJoin = 'round';
  const st = (d, c) => { ctx.lineWidth = 2 * Math.max(0.5, d); ctx.strokeStyle = rgba(c); ctx.stroke(path); };
  const w1 = 1 / dpx, w2 = 0.95 / dpx;
  st(0.14 * R0, col(0.122));
  st(0.112 * R0, col(0.1));
  st(LINE2 * R0 + w2, mix(col(LINE2), line, 0.16));
  st(LINE2 * R0 - w2, col(0.077));
  st(0.065 * R0, col(0.054));
  st(LINE1 * R0 + w1, mix(col(LINE1), line, 0.32));
  st(LINE1 * R0 - w1, col(0.022));
  st(FOAM_LINE * R0 + 1.15 / dpx, mix(col(FOAM_LINE), foam, 0.7));
  st(FOAM_LINE * R0 - 1.15 / dpx, mix(col(0.006), foam, 0.25));
  st((FOAM0 + FOAM1) * 0.3 * R0, mix(col(0), foam, 0.62));
}

/** The dot screen on unclaimed land (PLATE_FS neutral: a dot 0.15 of a cell + one device px every 0.0125 rad × zoom →
 *  0.0125 · R0 css px, mixed 40 % · pal.dot toward the land's shadow tone). devUnit = device px per unit of g's
 *  transform, devCss = device px per css px. */
const dotMemo = new Map();
export function dotScreen(g, path, rule, pal, R0, devUnit, devCss, sph = null) {
  if (!(pal.dot > 0) || !path) return;
  // (refine-surface: once the dots are big enough to show their shape — an abstract planet zoomed in — they sit on
  // 3D's own sphere lattice, not a screen grid; sph = {v, e, n, Z, D, rect, R, off?, real}, see sphereDots)
  if (sph && !sph.real && DOT * R0 >= 6 && sphereDots(g, path, rule, pal, R0, sph)) return;
  const P = Math.max(3, Math.round(DOT * R0 * devCss));
  const key = `${P}|${pal.landSh}|${pal.dot}`;
  let tile = dotMemo.get(key);
  if (!tile) {
    tile = canvas(P, P);
    const tg = tile.getContext('2d');
    tg.fillStyle = rgba(hexRGB(pal.landSh), 0.4 * pal.dot);
    tg.beginPath();
    tg.arc(P / 2, P / 2, Math.max(0.55, 0.15 * P + 0.5), 0, Math.PI * 2);
    tg.fill();
    if (dotMemo.size > 8) dotMemo.clear();
    dotMemo.set(key, tile);
  }
  const pat = g.createPattern(tile, 'repeat');
  if (!pat) return;
  if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([1 / devUnit, 0, 0, 1 / devUnit, 0, 0]));
  g.save();
  g.fillStyle = pat;
  g.fill(path, rule || 'nonzero');
  g.restore();
}

/**
 * 3D's dot screen on the sphere (PLATE_FS neutral): cells of q = (lon·cos lat, lat) / dsz, a dot where |fract(q) − .5|
 * < 0.15 — round at lon 0, sheared away from it (q.x leans with lon·sin lat), anchored to the planet. Drawn as blocks of
 * whole cells (≈ 48 px): each block is the quad its q-rectangle projects to, filled with a one-cell dot pattern carried
 * by the projection's local affine map at the block's centre — block edges run between dots, so no dot is ever cut,
 * and a few hundred fills cost a few ms (a path of tens of thousands of dot polygons cost ~0.7 s). dsz = DOT rad (an
 * abstract planet's dots grow with it). g in local units (o.off: g and path in screen px, local = css px from the
 * centre), o.rect = the visible local rect, o.Z = the limb radius (local), o.D = the 3D lens. Returns false when the
 * view is too wide (the caller falls back to the screen tile).
 */
const dotTiles = new Map();
function sphereDots(g, path, rule, pal, R0, o) {
  const { v, e, n, Z, rect } = o, D = o.D || 0, VIS = D ? lensVis(D) : 0, ox = o.off ? o.off[0] : 0, oy = o.off ? o.off[1] : 0;
  const dsz = DOT, PI = Math.PI;
  const K = (f) => (D ? Z * lensK(D, f) : Z);
  const pitch = dsz * R0; // css px per cell at the look point
  const nb = Math.max(2, Math.round(48 / Math.max(1, pitch))); // cells per block side
  // the visible cap: the screen's farthest corner from the centre, as an angle from the look point
  const reach = Math.hypot(Math.max(-rect[0], rect[2]), Math.max(-rect[1], rect[3])) / Z;
  const th = D ? lensTheta(D, Math.min(1, reach)) : Math.asin(Math.min(1, reach));
  const latV = Math.asin(clamp(v[1], -1, 1)), lonV = Math.atan2(v[0], v[2]);
  const lat0 = Math.max(-PI / 2, latV - th), lat1 = Math.min(PI / 2, latV + th);
  const cosT = Math.cos(th), sV = Math.sin(latV), cV = Math.cos(latV);
  // q → local (x, y) through the lens; null behind the horizon or across lon ±π (3D's own seam)
  const at = (qx, qy, out) => {
    const lat = qy * dsz, cl = Math.cos(lat);
    if (cl < 1e-4) return null;
    const lon = (qx * dsz) / cl;
    if (lon > PI || lon < -PI) return null;
    const x = cl * Math.sin(lon), y = Math.sin(lat), z = cl * Math.cos(lon), f = x * v[0] + y * v[1] + z * v[2];
    if (f < VIS + 0.01) return null;
    const k = K(f);
    out[0] = (x * e[0] + y * e[1] + z * e[2]) * k; out[1] = -(x * n[0] + y * n[1] + z * n[2]) * k;
    return out;
  };
  // the blocks: rows of nb cells, each row's q.x span inside the cap (|Δlon| ≤ acos((cos θ − sin φ sin φv)/(cos φ cos φv)))
  const jb0 = Math.floor(lat0 / dsz / nb) - 1, jb1 = Math.ceil(lat1 / dsz / nb) + 1;
  const blocks = [];
  for (let jb = jb0; jb <= jb1; jb++) {
    let span = null;
    for (const lat of [jb * nb * dsz, (jb + 0.5) * nb * dsz, (jb + 1) * nb * dsz]) {
      if (Math.abs(lat) >= PI / 2) continue;
      const cl = Math.cos(lat), den = cl * cV;
      let half = PI;
      if (den > 1e-9) { const q = (cosT - Math.sin(lat) * sV) / den; if (q >= 1) continue; if (q > -1) half = Math.acos(q); }
      const runs = half >= PI - 1e-9 ? [[-PI, PI]] : (() => { const l0 = lonV - half, l1 = lonV + half; return l0 < -PI ? [[-PI, l1], [l0 + 2 * PI, PI]] : l1 > PI ? [[l0, PI], [-PI, l1 - 2 * PI]] : [[l0, l1]]; })();
      for (const [la, lb] of runs) {
        const a = Math.floor((la * cl) / dsz / nb) - 1, b = Math.ceil((lb * cl) / dsz / nb) + 1;
        (span || (span = [])).push([a, b]);
      }
    }
    if (!span) continue;
    const seen = new Set();
    for (const [a, b] of span) for (let ib = a; ib <= b; ib++) if (!seen.has(ib)) { seen.add(ib); blocks.push([ib, jb]); }
  }
  if (blocks.length > 6000) return false;
  // the one-cell tile: a dot of radius 0.15 cell (+ half a screen px of antialiasing, as 3D's fwidth edge)
  const T = Math.max(8, Math.min(64, Math.round(pitch)));
  const tkey = `${T}|${pal.landSh}|${pal.dot}`;
  let tile = dotTiles.get(tkey);
  if (!tile) {
    tile = canvas(T, T);
    const tg = tile.getContext('2d');
    tg.fillStyle = rgba(hexRGB(pal.landSh), 0.4 * pal.dot);
    tg.beginPath(); tg.arc(T / 2, T / 2, 0.15 * T + 0.5 * (T / Math.max(1, pitch)), 0, 2 * PI); tg.fill();
    if (dotTiles.size > 8) dotTiles.clear();
    dotTiles.set(tkey, tile);
  }
  const pat = g.createPattern(tile, 'repeat');
  if (!pat || !pat.setTransform || typeof DOMMatrix === 'undefined') return false;
  const mx = Math.max(rect[2] - rect[0], rect[3] - rect[1]) * 0.03;
  const c0 = [0, 0], c1 = [0, 0], c2 = [0, 0], c3 = [0, 0], m0 = [0, 0], mX = [0, 0], mY = [0, 0];
  g.save();
  g.clip(path, rule || 'nonzero');
  if (ox || oy) g.translate(ox, oy); // (the dots in local units, the land path in screen px)
  for (const [ib, jb] of blocks) {
    const qx0 = ib * nb, qy0 = jb * nb, qx1 = qx0 + nb, qy1 = qy0 + nb;
    if (!at(qx0, qy0, c0) || !at(qx1, qy0, c1) || !at(qx1, qy1, c2) || !at(qx0, qy1, c3)) continue;
    const x0 = Math.min(c0[0], c1[0], c2[0], c3[0]), x1 = Math.max(c0[0], c1[0], c2[0], c3[0]);
    const y0 = Math.min(c0[1], c1[1], c2[1], c3[1]), y1 = Math.max(c0[1], c1[1], c2[1], c3[1]);
    if (x1 < rect[0] - mx || x0 > rect[2] + mx || y1 < rect[1] - mx || y0 > rect[3] + mx) continue;
    // the local affine map at the block's centre: local = m0 + A·(q − qc)
    const qcx = qx0 + nb / 2, qcy = qy0 + nb / 2;
    if (!at(qcx, qcy, m0) || !at(qcx + 0.5, qcy, mX) || !at(qcx, qcy + 0.5, mY)) continue;
    const axx = (mX[0] - m0[0]) * 2, ayx = (mX[1] - m0[1]) * 2, axy = (mY[0] - m0[0]) * 2, ayy = (mY[1] - m0[1]) * 2;
    // pattern px → q = p / T → local
    pat.setTransform(new DOMMatrix([axx / T, ayx / T, axy / T, ayy / T, m0[0] - axx * qcx - axy * qcy, m0[1] - ayx * qcx - ayy * qcy]));
    g.fillStyle = pat;
    g.beginPath();
    g.moveTo(c0[0], c0[1]); g.lineTo(c1[0], c1[1]); g.lineTo(c2[0], c2[1]); g.lineTo(c3[0], c3[1]); g.closePath();
    g.fill();
  }
  g.restore();
  return true;
}

/** The land's toon shadow (PLATE_FS: the terminator never splits a landmass — ≤ 6 % luma): the crescent on the
 *  anti-light limb where N·L < 0, darkened by multiply. g in local units, the globe's limb at radius Rw (local). */
export function shadeLand(g, path, rule, Rw, light, day, mul = null, reach = Infinity) {
  const L = light.L, l2 = Math.hypot(L[0], L[1]);
  if (l2 < 1e-4 || Rw <= 0) return;
  const lz = L[2];
  if (lz > 0.9995 || reach < lz * Rw) return; // (the crescent is off the visible area)
  const th = Math.atan2(-L[1], L[0]); // the light's direction on screen (y down)
  g.save();
  if (path) g.clip(path, rule || 'nonzero');
  g.beginPath();
  g.arc(0, 0, Rw, th + Math.PI / 2, th + 1.5 * Math.PI);
  g.ellipse(0, 0, lz * Rw, Rw, th, 1.5 * Math.PI, Math.PI / 2, true);
  g.closePath();
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = mul || (day ? 'rgb(240,240,238)' : 'rgb(236,236,236)');
  g.fill();
  g.restore();
}

/** The cream rim light on the lit limb (GLSL_TOON: N·V < 0.28, × smoothstep(0, 0.3, N·L)), screen px. */
export function drawRim(ctx, cx, cy, Rw, light, day) {
  const L = light.L, ll = Math.hypot(L[0], L[1]);
  if (ll < 1e-3 || Rw < 8) return;
  const ux = L[0] / ll, uy = -L[1] / ll; // screen (y down)
  const nz = 0.14, a0 = (-nz * L[2]) / ll, a1 = (0.3 - nz * L[2]) / ll; // N·L = ℓ·a + Lz·nz across the band
  const amt = day ? 0.48 : 0.42, rc = day ? [255, 253, 246] : [251, 242, 220];
  const gr = ctx.createLinearGradient(cx + ux * a0 * Rw, cy + uy * a0 * Rw, cx + ux * a1 * Rw, cy + uy * a1 * Rw);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) gr.addColorStop(t, rgba(rc, amt * t * t * (3 - 2 * t)));
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, Rw, 0, Math.PI * 2);
  ctx.arc(cx, cy, Rw * 0.96, 0, Math.PI * 2, true);
  ctx.fillStyle = gr;
  ctx.fill('evenodd');
  ctx.restore();
}

/** §26 amendment 5: an admin-unit arc's fade by its length on screen — flat lon,lat pairs; 3D world.js: the arc's chord
 *  sum (aLen) × px per rad (uPxR), smoothstep(f0, f1) px — in 8 steps (0 = not drawn). */
export function unitFade(A, pxR, f0, f1) {
  let len = 0, px = 0, py = 0, pz = 0;
  const RAD = Math.PI / 180;
  for (let i = 0; i + 1 < A.length; i += 2) {
    const a = A[i] * RAD, b = A[i + 1] * RAD, cb = Math.cos(b), x = cb * Math.sin(a), y = Math.sin(b), z = cb * Math.cos(a);
    if (i) len += Math.hypot(x - px, y - py, z - pz);
    px = x; py = y; pz = z;
  }
  return Math.round(sstep(f0, f1, len * pxR) * 8) / 8;
}

/** The multiply colour that turns open water into its toon shadow tone (deepSh ÷ deep), for the moving picture. */
export function seaShadeMul(pal) {
  const a = hexRGB(pal.deep), b = hexRGB(pal.deepSh);
  return `rgb(${b.map((v, i) => Math.round(Math.min(255, (255 * v) / Math.max(1, a[i])))).join(',')})`;
}
