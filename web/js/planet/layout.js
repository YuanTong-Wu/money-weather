// planet/layout.js — deterministic territory layout for one planet (no DOM).
//
// Territories are a weighted Voronoi (power diagram) inside the unit circle, built with the
// Voronoi-treemap iteration (Lloyd relaxation of sites + weight adaptation) so that each territory's
// area ∝ sqrt(dv20). The initial unweighted relaxation uses d3.Delaunay; the weighted cells are exact
// power cells clipped to the circle. Borders get a gentle, seeded "coastline" wobble.
//
// The layout is then rasterised on a G×G grid covering [-1,1]²: ownership, distance-to-border and
// soft (blurred) membership coefficients. Every per-date field (temperature, pressure, wind potential)
// is then just Σ_k coef_k · value_k, which is cheap enough to recompute every frame while lerping.

import { mulberry32, hashStr, makeNoise2, boxBlur, clamp, smoothstep } from './util.js';

export const G = 200; // field grid resolution (cells per diameter)
const CIRCLE_SEGS = 180;
const CIRCLE = Array.from({ length: CIRCLE_SEGS }, (_, i) => {
  const a = (i / CIRCLE_SEGS) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
});

const cache = new Map();

// ------------------------------------------------------------------------------------------ geometry
function clipHalf(poly, a, b, c) {
  // keep points with a*x + b*y <= c
  const out = [];
  const n = poly.length;
  if (!n) return out;
  let P = poly[n - 1];
  let dp = a * P[0] + b * P[1] - c;
  for (let i = 0; i < n; i++) {
    const Q = poly[i];
    const dq = a * Q[0] + b * Q[1] - c;
    if (dq <= 0) {
      if (dp > 0) {
        const t = dp / (dp - dq);
        out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]);
      }
      out.push(Q);
    } else if (dp <= 0) {
      const t = dp / (dp - dq);
      out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]);
    }
    P = Q; dp = dq;
  }
  return out;
}

function powerCells(sites, W) {
  const n = sites.length;
  const cells = new Array(n);
  for (let i = 0; i < n; i++) {
    const [xi, yi] = sites[i];
    let poly = CIRCLE;
    for (let j = 0; j < n && poly.length >= 3; j++) {
      if (j === i) continue;
      const [xj, yj] = sites[j];
      poly = clipHalf(poly, 2 * (xj - xi), 2 * (yj - yi), xj * xj + yj * yj - xi * xi - yi * yi - W[j] + W[i]);
    }
    cells[i] = poly.length >= 3 ? poly : [];
  }
  return cells;
}

const area = (p) => (p.length >= 3 ? Math.abs(globalThis.d3.polygonArea(p)) : 0);
const centroid = (p) => globalThis.d3.polygonCentroid(p);

// ---------------------------------------------------------------------------------------- treemap
function voronoiTreemap(targets, rnd) {
  const d3 = globalThis.d3;
  const n = targets.length;
  const total = area(CIRCLE);
  const T = targets.map((t) => t * total);
  // seeded sunflower placement, biggest near the middle
  const order = targets.map((t, i) => i).sort((a, b) => targets[b] - targets[a] || a - b);
  const rot = rnd() * Math.PI * 2;
  const sites = new Array(n);
  order.forEach((idx, r) => {
    const rad = 0.78 * Math.sqrt((r + 0.35) / n);
    const ang = rot + r * 2.39996323 + (rnd() - 0.5) * 0.6;
    sites[idx] = [rad * Math.cos(ang) + (rnd() - 0.5) * 0.05, rad * Math.sin(ang) + (rnd() - 0.5) * 0.05];
  });
  if (n === 1) return { sites: [[0, 0]], W: [0], cells: [CIRCLE] };

  // a few unweighted Lloyd steps with d3.Delaunay to spread the seeds evenly
  for (let it = 0; it < 4; it++) {
    const vor = d3.Delaunay.from(sites).voronoi([-1, -1, 1, 1]);
    for (let i = 0; i < n; i++) {
      let poly = vor.cellPolygon(i);
      if (!poly) continue;
      // clip square cell to the circle
      for (let s = 0; s < CIRCLE_SEGS && poly.length >= 3; s++) {
        const [x0, y0] = CIRCLE[s], [x1, y1] = CIRCLE[(s + 1) % CIRCLE_SEGS];
        // inside of circle edge: normal points outward = (x0+x1)/2,(y0+y1)/2
        const nx = (x0 + x1) / 2, ny = (y0 + y1) / 2;
        poly = clipHalf(poly, nx, ny, nx * x0 + ny * y0);
      }
      if (poly.length >= 3) {
        const c = centroid(poly);
        sites[i] = [sites[i][0] * 0.3 + c[0] * 0.7, sites[i][1] * 0.3 + c[1] * 0.7];
      }
    }
  }

  // weighted iteration (Nocaj & Brandes style, as in d3-voronoi-map)
  const W = T.map((t) => (t / Math.PI) * 0.3 + 1e-4);
  const EPS = 1e-6;
  const fixOverweight = () => {
    let fixes = 0, applied;
    do {
      applied = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = sites[i][0] - sites[j][0], dy = sites[i][1] - sites[j][1];
          const d2 = dx * dx + dy * dy;
          const [h, l] = W[i] > W[j] ? [i, j] : [j, i];
          const over = W[h] - W[l] - d2;
          if (over > 0) { W[h] -= over + EPS; applied = true; }
        }
      }
      fixes++;
    } while (applied && fixes < 50);
    for (let i = 0; i < n; i++) W[i] = Math.max(W[i], EPS);
  };
  let cells = powerCells(sites, W);
  let flick = 0.5, prevErr = Infinity;
  for (let iter = 0; iter < 260; iter++) {
    // adapt positions (Lloyd)
    for (let i = 0; i < n; i++) {
      if (cells[i].length >= 3) {
        const c = centroid(cells[i]);
        sites[i] = [c[0], c[1]];
      }
    }
    fixOverweight();
    cells = powerCells(sites, W);
    // adapt weights
    let err = 0;
    for (let i = 0; i < n; i++) {
      const a = area(cells[i]);
      err += Math.abs(a - T[i]);
      let ratio = a > 1e-9 ? T[i] / a : 1 + flick;
      ratio = clamp(ratio, 1 - flick, 1 + flick);
      W[i] = Math.max(W[i] * ratio, EPS);
    }
    err /= 2 * total;
    fixOverweight();
    cells = powerCells(sites, W);
    if (err < 0.004 && iter > 12) break;
    if (err > prevErr * 0.999) flick = Math.max(0.05, flick * 0.92);
    prevErr = err;
  }
  return { sites, W, cells };
}

// ------------------------------------------------------------------------------------------ layout
/**
 * @param {string} key   stable seed key (node id)
 * @param {Array<{id:string, weight:number}>} items  children with raw weights (sqrt(dv20) applied here)
 */
export function computeLayout(key, items) {
  const n = items.length;
  const wraw = items.map((it) => Math.sqrt(Math.max(1e-6, +it.weight || 0)));
  const sumw = wraw.reduce((a, b) => a + b, 0) || 1;
  // shares with a floor (keeps tiny territories clickable) and a cap
  let share = wraw.map((w) => w / sumw);
  if (n > 1) {
    const floor = 0.42 / n, cap = 0.6;
    for (let pass = 0; pass < 4; pass++) {
      share = share.map((s) => clamp(s, floor, cap));
      const s = share.reduce((a, b) => a + b, 0);
      share = share.map((x) => x / s);
    }
  } else share = [1];
  const cacheKey = key + '|' + items.map((it, i) => it.id + ':' + share[i].toFixed(3)).join(',');
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const seed = hashStr(key);
  const rnd = mulberry32(seed);
  const t0 = performance.now();
  const tm = n ? voronoiTreemap(share, rnd) : { sites: [], W: [], cells: [] };
  const tTreemap = performance.now() - t0;

  // seeded coastline wobble, fading to zero at the rim so the planet edge stays round
  const nA = makeNoise2(seed ^ 0x9e3779b9), nB = makeNoise2(seed ^ 0x85ebca6b);
  const amp = n > 1 ? 0.05 / Math.sqrt(Math.max(1, n / 5)) : 0;
  const f = 2.4;
  const wob = (x, y) => {
    const r = Math.hypot(x, y);
    const k = amp * (1 - smoothstep(0.8, 0.975, r));
    if (k <= 0) return [0, 0];
    return [
      k * (nA(x * f + 3.1, y * f - 1.7) + 0.45 * nA(x * f * 2.6 - 5.2, y * f * 2.6 + 2.3)),
      k * (nB(x * f - 4.4, y * f + 6.1) + 0.45 * nB(x * f * 2.6 + 1.9, y * f * 2.6 - 3.3)),
    ];
  };

  // display polygons: densify + wobble
  const polys = tm.cells.map((cell) => {
    const out = [];
    for (let i = 0; i < cell.length; i++) {
      const a = cell[i], b = cell[(i + 1) % cell.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 0.018));
      for (let s = 0; s < steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps, y = a[1] + ((b[1] - a[1]) * s) / steps;
        const d = wob(x, y);
        out.push([x + d[0], y + d[1]]);
      }
    }
    return out;
  });

  // ---- rasterise ownership
  const N2 = G * G;
  const owner = new Int16Array(N2);
  const inside = new Uint8Array(N2);
  const cs = 2 / G;
  const { sites, W } = tm;
  for (let gy = 0; gy < G; gy++) {
    const y = -1 + (gy + 0.5) * cs;
    for (let gx = 0; gx < G; gx++) {
      const x = -1 + (gx + 0.5) * cs;
      const c = gy * G + gx;
      inside[c] = x * x + y * y <= 1 ? 1 : 0;
      if (!n) { owner[c] = -1; continue; }
      const d = wob(x, y);
      const qx = x - d[0], qy = y - d[1];
      let best = 0, bv = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = qx - sites[i][0], dy = qy - sites[i][1];
        const v = dx * dx + dy * dy - W[i];
        if (v < bv) { bv = v; best = i; }
      }
      owner[c] = best;
    }
  }

  // ---- distance to border (chamfer), in grid cells
  const INF = 1e9;
  const dist = new Float32Array(N2);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const c = gy * G + gx;
      const o = owner[c];
      let edge = !inside[c] || gx === 0 || gy === 0 || gx === G - 1 || gy === G - 1;
      if (!edge) edge = owner[c - 1] !== o || owner[c + 1] !== o || owner[c - G] !== o || owner[c + G] !== o;
      dist[c] = edge ? 0 : INF;
    }
  }
  const D1 = 1, D2 = Math.SQRT2;
  for (let gy = 1; gy < G - 1; gy++) {
    for (let gx = 1; gx < G - 1; gx++) {
      const c = gy * G + gx;
      let v = dist[c];
      v = Math.min(v, dist[c - 1] + D1, dist[c - G] + D1, dist[c - G - 1] + D2, dist[c - G + 1] + D2);
      dist[c] = v;
    }
  }
  for (let gy = G - 2; gy > 0; gy--) {
    for (let gx = G - 2; gx > 0; gx--) {
      const c = gy * G + gx;
      let v = dist[c];
      v = Math.min(v, dist[c + 1] + D1, dist[c + G] + D1, dist[c + G + 1] + D2, dist[c + G - 1] + D2);
      dist[c] = v;
    }
  }

  // ---- per territory stats: cells, pole (label anchor), max depth
  const maxDepth = new Float32Array(n);
  const pole = new Array(n).fill(null);
  const cellCount = new Int32Array(n);
  const bestScore = new Float32Array(n).fill(-1);
  const cent = tm.cells.map((c) => (c.length >= 3 ? centroid(c) : [0, 0]));
  for (let c = 0; c < N2; c++) {
    const o = owner[c];
    if (o < 0 || !inside[c]) continue;
    cellCount[o]++;
    if (dist[c] > maxDepth[o]) maxDepth[o] = dist[c];
  }
  for (let c = 0; c < N2; c++) {
    const o = owner[c];
    if (o < 0 || !inside[c]) continue;
    const gx = c % G, gy = (c / G) | 0;
    const x = -1 + (gx + 0.5) * cs, y = -1 + (gy + 0.5) * cs;
    // prefer deep points, mildly prefer the centroid and the planet's middle (labels read better there)
    const dc = Math.hypot(x - cent[o][0], y - cent[o][1]);
    const score = dist[c] / Math.max(1, maxDepth[o]) - 0.35 * dc - 0.1 * Math.hypot(x, y);
    if (score > bestScore[o]) { bestScore[o] = score; pole[o] = [x, y]; }
  }
  for (let i = 0; i < n; i++) if (!pole[i]) pole[i] = sites[i].slice();

  const areasEarly = tm.cells.map(area);
  const L_area = (k) => areasEarly[k];

  // ---- soft membership coefficients
  const tmp = new Float32Array(N2);
  const sT = Math.max(2, Math.round(G * 0.024));
  const sP = Math.max(3, Math.round(G * 0.035));
  const sW = Math.max(4, Math.round(G * 0.06));
  const coefT = [], coefP = [], coefW = [];
  for (let k = 0; k < n; k++) {
    const md = Math.max(1, maxDepth[k]);
    const a = new Float32Array(N2), b = new Float32Array(N2), w = new Float32Array(N2);
    for (let c = 0; c < N2; c++) {
      if (owner[c] !== k) continue;
      const d01 = Math.min(1, dist[c] / md);
      a[c] = 0.5 + 0.5 * smoothstep(0, 1, Math.pow(d01, 0.75));
      b[c] = 1;
      w[c] = 0.22 + 0.78 * Math.pow(d01, 0.85);
    }
    coefT.push(boxBlur(a, G, sT, 3, tmp));
    coefP.push(boxBlur(b, G, sP, 3, tmp));
    coefW.push(boxBlur(w, G, sW, 3, tmp));
  }

  // ---- temperature = own-territory-dominant kernel blend (above) + a gentle inverse-distance (IDW)
  // blend between territory poles, so neighbouring weather systems bleed into each other a little
  // ("no hard edge but has volume").
  if (n > 1) {
    const IDW = 0.2, eps = 0.07 * 0.07;
    const inv = new Float32Array(n);
    for (let gy = 0; gy < G; gy++) {
      const y = -1 + (gy + 0.5) * cs;
      for (let gx = 0; gx < G; gx++) {
        const x = -1 + (gx + 0.5) * cs;
        const c = gy * G + gx;
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const dx = x - pole[k][0], dy = y - pole[k][1];
          // weight by territory size so big systems reach further
          const v = (L_area(k) + 0.02) / (dx * dx + dy * dy + eps);
          inv[k] = v; sum += v;
        }
        for (let k = 0; k < n; k++) coefT[k][c] = (1 - IDW) * coefT[k][c] + (IDW * inv[k]) / sum;
      }
    }
  }

  // ---- static textures: grain (colour variation) + ambient curl drift
  const nG = makeNoise2(seed ^ 0x27d4eb2f), nC = makeNoise2(seed ^ 0x165667b1);
  const grain = new Float32Array(N2);
  const psi = new Float32Array(N2);
  for (let gy = 0; gy < G; gy++) {
    const y = -1 + (gy + 0.5) * cs;
    for (let gx = 0; gx < G; gx++) {
      const x = -1 + (gx + 0.5) * cs;
      const c = gy * G + gx;
      grain[c] = 0.6 * nG(x * 4.2, y * 4.2) + 0.3 * nG(x * 11 + 9, y * 11 - 4) + 0.15 * nG(x * 23, y * 23);
      psi[c] = nC(x * 1.7 + 11, y * 1.7 - 7) + 0.5 * nC(x * 3.9 - 2, y * 3.9 + 5);
    }
  }
  const ambX = new Float32Array(N2), ambY = new Float32Array(N2);
  let amax = 1e-6;
  for (let gy = 1; gy < G - 1; gy++) {
    for (let gx = 1; gx < G - 1; gx++) {
      const c = gy * G + gx;
      const vx = (psi[c + G] - psi[c - G]) * 0.5;
      const vy = -(psi[c + 1] - psi[c - 1]) * 0.5;
      ambX[c] = vx; ambY[c] = vy;
      amax = Math.max(amax, Math.hypot(vx, vy));
    }
  }
  for (let c = 0; c < N2; c++) { ambX[c] /= amax; ambY[c] /= amax; }

  const areas = areasEarly;
  const bbox = polys.map((p) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) {
      const r = Math.hypot(x, y), s = r > 1 ? 1 / r : 1; // clip to circle
      x0 = Math.min(x0, x * s); y0 = Math.min(y0, y * s); x1 = Math.max(x1, x * s); y1 = Math.max(y1, y * s);
    }
    return [x0, y0, x1, y1];
  });

  const layout = {
    key, n, ids: items.map((it) => it.id), share, sites: tm.sites, weights: tm.W, cells: tm.cells, polys,
    areas, rEq: areas.map((a) => Math.sqrt(a / Math.PI)), bbox, anchors: pole, maxDepth,
    G, owner, inside, dist, coefT, coefP, coefW, grain, ambX, ambY, swirl: new Array(n).fill(null),
    stats: { treemapMs: tTreemap, totalMs: performance.now() - t0 },
  };
  cache.set(cacheKey, layout);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return layout;
}

/** Tangential swirl field around territory k's pole (lazy, cached on the layout). */
export function swirlField(L, k) {
  if (L.swirl[k]) return L.swirl[k];
  const N2 = G * G, cs = 2 / G;
  const sx = new Float32Array(N2), sy = new Float32Array(N2);
  const [ax, ay] = L.anchors[k];
  const rc = Math.max(0.05, 0.42 * L.rEq[k]);
  const m = L.coefP[k];
  for (let gy = 0; gy < G; gy++) {
    const y = -1 + (gy + 0.5) * cs;
    for (let gx = 0; gx < G; gx++) {
      const c = gy * G + gx;
      const mm = m[c];
      if (mm < 0.02) continue;
      const x = -1 + (gx + 0.5) * cs;
      const dx = x - ax, dy = y - ay;
      const d = Math.hypot(dx, dy) + 1e-6;
      const prof = (d / rc) * Math.exp(1 - d / rc);
      // counter-clockwise on screen (y down) + slight inward spiral
      sx[c] = mm * prof * (dy / d - 0.35 * dx / d);
      sy[c] = mm * prof * (-dx / d - 0.35 * dy / d);
    }
  }
  return (L.swirl[k] = { sx, sy });
}

/** Grid cell index for local coords, or -1 outside the grid. */
export function cellAt(x, y) {
  const gx = Math.floor(((x + 1) / 2) * G), gy = Math.floor(((y + 1) / 2) * G);
  if (gx < 0 || gy < 0 || gx >= G || gy >= G) return -1;
  return gy * G + gx;
}
