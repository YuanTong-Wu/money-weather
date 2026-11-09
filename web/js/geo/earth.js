// geo/earth.js — the real Earth for the 全球 map (DESIGN §25). Owner: "真实的地球大概只有四分之一是陆地，其他都是海。"
//
// Geometry contract (§25), shared with geo/islands.js:
//   provider → Promise<[{id, rings:[[[lon,lat],…],…], center:[lon,lat], area}, …]>; whatever is not covered is ocean.
//
// Exports
//   getLayout(node, childNodes, mapJson, opts)  → Promise<entries | null>
//        world (gl root)  → one entry per region  (大中华 / 亚太 / 欧洲 / 美洲 = union of member countries)
//        gl region        → one entry per country (A股 = China, 港股 = Hong Kong, 欧洲其他 = BE+AT+PT+IE+PL …)
//        anything else    → null (no real geography: a country's sectors are islands, see geo/islands.js)
//        Children without geography are left out; the array carries `.unmapped = [ids]`.
//   shapeOf(nodeOrId | {a2:[…]}, opts)            → Promise<entry | null>  (a node's own shape, e.g. the focus
//                                                    country when flying in)
//   landRings(opts)    → Promise<ring[]>   every land exterior ring (neutral land under the coloured countries)
//   lakeRings(opts)    → Promise<ring[]>   holes in the land (Caspian Sea …) — paint them as water over land
//   landPolygons(opts) → Promise<[[outer, …holes], …]>  the same, as GeoJSON MultiPolygon coordinates
//                        ({spherical:true}: uncut d3-native polygons, the best input for d3.geoPath fills)
//   coastlines(opts) / borders(opts) → Promise<lines>  seam-free strokes (shoreline foam, country borders)
//   countries(opts)    → Promise<[{num, a2, en, zh, gl, region, rings, center, area}]>  every country (neutral too)
//   countryAt(lon, lat, {snapTiny}) → {num, a2, en, zh, gl, region, core} | null (sync; null until loadEarth resolves)
//   loadEarth(opts)    → Promise<stats>   preload / warm the cache; resolves {detail, points, rings, ms, landFrac}
//   configure({fetchJSON, baseUrl})       → for non-browser tests
//
// Entry fields (beyond the contract):
//   kind:'earth'; a2:['CN',…]; num:['156',…]; polygons:[[outer,…holes],…] (exact, with holes); geometry (the
//   same as a GeoJSON MultiPolygon); outline (lines: the shape's coast + outer border — STROKE THIS, never the rings,
//   whose antimeridian cut would show as a seam); borders (lines between the member countries of a region);
//   centroid (area-weighted, may sit in the sea); bbox [[w,s],[e,n]] (d3.geoBounds);
//   radius (deg, max angular distance center → any vertex) and coreRadius (the same over the largest pieces holding
//   90% of the area — use this one for camera framing); km2;
//   tiny (true when too small to see on a whole-planet view — Hong Kong) + marker:[lon,lat] + markerRing (a small
//   0.35° disc the renderer may draw as a pickable point-island); members (regions: [{id, a2, center, area, tiny}]).
//
// Conventions
//   - lon ∈ [-180, 180], lat ∈ [-90, 90]; every ring is closed (first point == last point).
//   - Rings are "planar-safe": world-atlas keeps Chukotka, Fiji and Antarctica as spherical rings across the
//     antimeridian / around the pole; this module cuts them there with d3's own clip (Antarctica becomes "south of
//     the coast" with an edge along lat −90), so no ring edge jumps more than 180° of longitude and no edge is longer
//     than 3° — rings can be triangulated in lon/lat space (earcut) and lifted onto the sphere, or drawn by d3.
//     Fill the rings, stroke `outline` / coastlines() / borders(): the cut edges are part of the rings, not the lines.
//   - Winding follows d3-geo (exterior clockwise in lon/lat with north up, as in world-atlas): every exterior ring
//     satisfies d3.geoArea({type:'Polygon', coordinates:[ring]}) < 2π. Holes are only in `polygons`.
//   - area = spherical area in steradians (d3.geoArea; the whole sphere = 4π). km2 = area × 6371².
//   - Far-flung overseas parts (French Guiana, Réunion, the Dutch Caribbean …) are not part of a gl country's shape
//     (they stay neutral land); pass {overseas:true} to keep them.
//   - Returned objects are shared cache entries — treat them as read-only.
//
// opts.detail: 'low' (≈0.2° tolerance, tiny islands dropped) | 'medium' (default, ≈0.06°) | 'high' (raw 1:50m).
// Simplification runs on the TopoJSON arcs, so shared borders and coastlines stay watertight at every detail level;
// small countries are simplified proportionally less so Hong Kong / Switzerland keep their outline.
//
// Needs globals d3 (v7, d3-geo) and topojson (topojson-client 3); loads vendor/d3.min.js and
// vendor/geo/topojson-client.min.js by <script> injection when they are missing.

import { COUNTRIES as ISO_ROWS, NULL_ID, byNum, normA2, glOf, isoForNode, registerTree, glCountriesOf } from './iso.js';

const VENDOR = new URL('../../vendor/', import.meta.url);
const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const R_KM2 = 6371 * 6371;

const DETAIL = {
  //        arc tolerance (deg) · drop islands below (sr) · countries below this main-polygon area get less simplification
  low: { tol: 0.2, minArea: 4e-6, refArea: 2.5e-3 },
  medium: { tol: 0.06, minArea: 6e-7, refArea: 2.5e-3 },
  high: { tol: 0, minArea: 0, refArea: 1 },
};
/** Below this area (sr) a shape is "tiny": invisible on a whole-planet view (Hong Kong ≈ 2.7e-5, Taiwan ≈ 9e-4). */
const TINY_AREA = 2.5e-4;
const TINY_MARKER_DEG = 0.35;   // suggested point-island disc (markerRing)
const TINY_SNAP_DEG = 0.25;     // countryAt default snap radius around a tiny gl market
/** Longest edge (deg of lon or lat) the simplifier may leave — d3 (great circles) and earcut-in-lon/lat agree. */
const MAX_SEG = 3;

let cfg = {
  baseUrl: VENDOR.href,
  fetchJSON: async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('earth: ' + r.status + ' ' + url);
    return r.json();
  },
};
/** Override how vendored files are fetched (tests in Node, or a different vendor path). */
export function configure(o = {}) {
  cfg = Object.assign({}, cfg, o);
  rawPromise = null;
  earths.clear();
  built.clear();
  lastEarth = null;
}

// ---------------------------------------------------------------------------------------------------------------
// library + file loading

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('earth: failed to load ' + src));
    document.head.appendChild(s);
  });
}
let libPromise = null;
function ensureLibs() {
  if (globalThis.d3 && globalThis.d3.geoArea && globalThis.topojson && globalThis.topojson.feature) return Promise.resolve();
  if (!libPromise) {
    libPromise = (async () => {
      if (typeof document === 'undefined') throw new Error('earth: globals d3 + topojson are required outside a browser');
      if (!(globalThis.d3 && globalThis.d3.geoArea)) await loadScript(new URL('d3.min.js', cfg.baseUrl).href);
      if (!(globalThis.topojson && globalThis.topojson.feature)) await loadScript(new URL('geo/topojson-client.min.js', cfg.baseUrl).href);
    })().catch((e) => { libPromise = null; throw e; });
  }
  return libPromise;
}

let rawPromise = null;
function loadRawTopology() {
  if (!rawPromise) {
    rawPromise = cfg.fetchJSON(new URL('geo/countries-50m.json', cfg.baseUrl).href).catch((e) => { rawPromise = null; throw e; });
  }
  return rawPromise;
}

// ---------------------------------------------------------------------------------------------------------------
// arc decoding + topology-preserving simplification (Douglas–Peucker per arc, endpoints kept)

function decodeArcs(topo) {
  const tf = topo.transform;
  const sx = tf ? tf.scale[0] : 1, sy = tf ? tf.scale[1] : 1, tx = tf ? tf.translate[0] : 0, ty = tf ? tf.translate[1] : 0;
  return topo.arcs.map((arc) => {
    const out = new Array(arc.length);
    let x = 0, y = 0;
    for (let i = 0; i < arc.length; i++) {
      let lon, lat;
      if (tf) { x += arc[i][0]; y += arc[i][1]; lon = x * sx + tx; lat = y * sy + ty; } else { lon = arc[i][0]; lat = arc[i][1]; }
      lon = Math.round(lon * 1e5) / 1e5;
      lat = Math.round(lat * 1e5) / 1e5;
      if (lon > 179.9995) lon = 180; else if (lon < -179.9995) lon = -180;
      if (lat > 90) lat = 90; else if (lat < -90) lat = -90;
      out[i] = [lon, lat];
    }
    return out;
  });
}

// squared distance from p to segment ab in a local equirectangular frame (lon scaled by cos lat)
function segDist2(p, a, b, k) {
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  let dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  dx = ax + t * dx - px; dy = ay + t * dy - py;
  return dx * dx + dy * dy;
}

function simplifyArc(pts, tol) {
  const n = pts.length;
  if (tol <= 0 || n <= 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const k = Math.cos(((pts[a][1] + pts[b][1]) / 2) * RAD) || 1e-6;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i], pts[a], pts[b], k);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push(a, idx, idx, b); continue; }
    // never leave a long edge: in lon/lat a straight run along a parallel (the 49th-parallel border, the
    // polar edge of Antarctica) is not a great circle, so a long chord would bow on the sphere
    const span = Math.max(Math.abs(pts[b][0] - pts[a][0]), Math.abs(pts[b][1] - pts[a][1]));
    if (span > MAX_SEG) { const m = (a + b) >> 1; keep[m] = 1; stack.push(a, m, m, b); }
  }
  // a closed arc (an island on its own) needs at least 3 distinct points to stay a ring
  const closed = pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1];
  if (closed) {
    let c = 0;
    for (let i = 0; i < n; i++) c += keep[i];
    if (c < 4) { keep[Math.floor(n / 3)] = 1; keep[Math.floor((2 * n) / 3)] = 1; }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// small geometry helpers

const ringClosed = (r) => {
  if (!r.length) return r;
  const a = r[0], b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? r : r.concat([[a[0], a[1]]]);
};

function distinctCount(ring) {
  const s = new Set();
  for (const p of ring) s.add(p[0] + ',' + p[1]);
  return s.size;
}
// shoelace area in lon/lat (lat up): > 0 counter-clockwise
function planarArea(r) {
  let a = 0;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}
function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
// a ring "needs a cut" when an edge jumps across the antimeridian (world-atlas keeps Russia's Chukotka, Fiji and
// the polar ring of Antarctica as spherical rings)
function ringNeedsCut(r) {
  for (let i = 1; i < r.length; i++) { const d = r[i][0] - r[i - 1][0]; if (d > 180 || d < -180) return true; }
  return false;
}
const snap5 = (v) => Math.round(v * 1e5) / 1e5;
let eqProj = null;

/**
 * Spherical polygon [outer, …holes] (d3 semantics) → planar-safe polygons [{coords:[outer, …holes], area}], cut
 * at the antimeridian by d3's own clip (Antarctica becomes "everything south of the coast" with an edge along
 * lat −90). Rings closed, exteriors clockwise / holes counter-clockwise (= d3 winding), degenerate rings dropped,
 * polygons below minArea dropped unless keepTiny.
 */
function planarize(poly, minArea, keepTiny) {
  const d3 = globalThis.d3;
  if (!poly || !poly.length) return [];
  let groups; // [[outer, …holes]]
  if (!poly.some(ringNeedsCut)) {
    groups = [poly.map(ringClosed)];
  } else {
    if (!eqProj) eqProj = d3.geoEquirectangular().scale(DEG).translate([0, 0]).precision(0);
    const rings = [];
    let cur = null;
    const sink = {
      point(x, y) {
        let lon = snap5(x), lat = snap5(-y);
        lon = lon > 180 ? 180 : lon < -180 ? -180 : lon;
        lat = lat > 90 ? 90 : lat < -90 ? -90 : lat;
        const last = cur[cur.length - 1];
        if (!last || last[0] !== lon || last[1] !== lat) cur.push([lon, lat]);
      },
      lineStart() { cur = []; },
      lineEnd() { if (cur && cur.length > 2) rings.push(ringClosed(cur)); cur = null; },
      polygonStart() {}, polygonEnd() {}, sphere() {},
    };
    d3.geoStream({ type: 'Polygon', coordinates: poly }, eqProj.stream(sink));
    // nesting by containment: even depth = exterior, odd = hole of its smallest container
    const items = rings.map((r) => ({ r, abs: Math.abs(planarArea(r)) })).filter((it) => it.abs > 1e-12);
    items.sort((a, b) => b.abs - a.abs);
    for (let i = 0; i < items.length; i++) {
      const r = items[i].r;
      const v = r.find((q) => Math.abs(q[0]) < 179.999 && Math.abs(q[1]) < 89.999) || r[0];
      let parent = -1, depth = 0;
      for (let j = 0; j < i; j++) if (pointInRing(v[0], v[1], items[j].r)) { depth++; parent = j; }
      items[i].hole = depth % 2 === 1;
      items[i].parent = parent;
    }
    groups = [];
    const at = new Map();
    items.forEach((it, i) => { if (!it.hole) { at.set(i, groups.length); groups.push([it.r]); } });
    items.forEach((it) => { if (it.hole && at.has(it.parent)) groups[at.get(it.parent)].push(it.r); });
  }
  const out = [];
  for (const g of groups) {
    let outer = g[0];
    if (distinctCount(outer) < 3) continue;
    const oa = planarArea(outer);
    if (Math.abs(oa) < 1e-12) continue;
    if (oa > 0) outer = outer.slice().reverse();              // exterior: clockwise
    const rings = [outer];
    for (let i = 1; i < g.length; i++) {
      let h = g[i];
      if (distinctCount(h) < 3) continue;
      const ha = planarArea(h);
      if (Math.abs(ha) < 1e-12) continue;
      if (ha < 0) h = h.slice().reverse();                    // hole: counter-clockwise
      rings.push(h);
    }
    const area = d3.geoArea({ type: 'Polygon', coordinates: rings });
    if (!(area > 0) || area > TAU) continue;
    if (!keepTiny && area < minArea) continue;
    out.push({ coords: rings, area });
  }
  return out;
}

function ringBBox(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}

// polylabel (pole of inaccessibility) in a local azimuthal-equidistant plane → a label point that is always on land
function polylabelPlanar(rings, precision) {
  const outer = rings[0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const w = maxX - minX, h = maxY - minY;
  const size = Math.min(w, h);
  if (!(size > 0)) return [(minX + maxX) / 2, (minY + maxY) / 2];
  const dist = (x, y) => {
    let inside = false, min2 = Infinity;
    for (const ring of rings) {
      for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const L = dx * dx + dy * dy;
        let t = L > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        dx = a[0] + t * dx - x; dy = a[1] + t * dy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < min2) min2 = d2;
      }
    }
    return (inside ? 1 : -1) * Math.sqrt(min2);
  };
  const cell = (x, y, hh) => { const d = dist(x, y); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
  // binary max-heap on .max
  const heap = [];
  const push = (c) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].max >= heap[i].max) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l;
        if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  const half = size / 2;
  for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) push(cell(x + half, y + half, half));
  // start from the area centroid of the outer ring
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, len = outer.length, j = len - 1; i < len; j = i++) {
    const a = outer[i], b = outer[j], f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f; A += f * 3;
  }
  let best = A ? cell(cx / A, cy / A, 0) : cell(minX + w / 2, minY + h / 2, 0);
  const bb = cell(minX + w / 2, minY + h / 2, 0);
  if (bb.d > best.d) best = bb;
  let guard = 0;
  while (heap.length && guard++ < 4000) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const hh = c.h / 2;
    push(cell(c.x - hh, c.y - hh, hh)); push(cell(c.x + hh, c.y - hh, hh));
    push(cell(c.x - hh, c.y + hh, hh)); push(cell(c.x + hh, c.y + hh, hh));
  }
  return [best.x, best.y];
}

/** A point inside the polygon [outer, …holes], as far from its coast as possible. */
function labelPoint(poly) {
  const d3 = globalThis.d3;
  const c = d3.geoCentroid({ type: 'Polygon', coordinates: poly });
  const proj = d3.geoAzimuthalEquidistant().rotate([-c[0], -c[1]]).translate([0, 0]).scale(1).clipAngle(null).precision(0);
  const planar = poly.map((ring) => ring.map((p) => proj(p)));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of planar[0]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const p = polylabelPlanar(planar, Math.max(maxX - minX, maxY - minY) / 160);
  const ll = proj.invert(p);
  return [Math.round(ll[0] * 1e4) / 1e4, Math.round(ll[1] * 1e4) / 1e4];
}

// lines (coastlines, borders, outlines): split where an edge jumps the antimeridian, drop polar artefacts
function splitLine(line) {
  const out = [];
  let cur = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], d = b[0] - a[0];
    if (d > 180 || d < -180) {
      const edge = a[0] > 0 ? 180 : -180;
      const bx = b[0] + (d > 0 ? -360 : 360);
      const t = bx === a[0] ? 0 : (edge - a[0]) / (bx - a[0]);
      const lat = snap5(a[1] + t * (b[1] - a[1]));
      cur.push([edge, lat]);
      out.push(cur);
      cur = [[-edge, lat], b];
    } else cur.push(b);
  }
  out.push(cur);
  return out.filter((l) => l.length > 1 && l.some((p) => Math.abs(p[1]) < 89.9));
}
function meshLines(topo, obj, filter) {
  const m = globalThis.topojson.mesh(topo, obj, filter);
  const out = [];
  for (const line of m.coordinates || []) for (const l of splitLine(line)) out.push(l);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// building one detail level

const earths = new Map(); // detail → Promise<Earth>
const built = new Map();  // detail → Earth (resolved), for the sync countryAt
let lastEarth = null;      // most recently used Earth

function geomPolygons(g) {
  if (!g || !g.arcs) return [];
  if (g.type === 'Polygon') return [g.arcs];
  if (g.type === 'MultiPolygon') return g.arcs;
  return [];
}

async function buildEarth(detail) {
  const t0 = (globalThis.performance || Date).now();
  await ensureLibs();
  const d3 = globalThis.d3, topojson = globalThis.topojson;
  const raw = await loadRawTopology();
  const D = DETAIL[detail] || DETAIL.medium;
  const rawArcs = decodeArcs(raw);
  const rawTopo = { type: 'Topology', objects: raw.objects, arcs: rawArcs };
  const geoms = raw.objects.countries.geometries;

  // per country: main-polygon area from the raw shapes → per-arc tolerance (small countries simplified less)
  const arcTol = new Float64Array(rawArcs.length).fill(D.tol);
  if (D.tol > 0) {
    for (const g of geoms) {
      let mainA = 0;
      for (const pa of geomPolygons(g)) {
        const f = topojson.feature(rawTopo, { type: 'Polygon', arcs: pa });
        const a = d3.geoArea(f);
        if (a < TAU && a > mainA) mainA = a;
      }
      const scale = Math.max(0.06, Math.min(1, Math.sqrt(mainA / D.refArea)));
      const tol = D.tol * scale;
      for (const pa of geomPolygons(g)) for (const ring of pa) for (const ai of ring) {
        const i = ai < 0 ? ~ai : ai;
        if (tol < arcTol[i]) arcTol[i] = tol;
      }
    }
  }
  const arcs = D.tol > 0 ? rawArcs.map((a, i) => simplifyArc(a, arcTol[i])) : rawArcs;
  const topo = { type: 'Topology', objects: raw.objects, arcs };

  // countries (world-atlas has 2 features with id '036': Australia + Ashmore and Cartier Is. → merged)
  const byKey = new Map();
  for (const g of geoms) {
    const name = g.properties && g.properties.name;
    const key = g.id != null ? String(g.id) : (NULL_ID[name] ? NULL_ID[name].key : 'x-' + String(name).toLowerCase().replace(/[^a-z]+/g, '-'));
    const iso = byNum(key) || { num: key, a2: null, en: name, zh: name };
    let c = byKey.get(key);
    if (!c) { c = { key, num: iso.num, a2: iso.a2, en: iso.en, zh: iso.zh, src: [] }; byKey.set(key, c); }
    for (const pa of geomPolygons(g)) {
      const sph = topojson.feature(topo, { type: 'Polygon', arcs: pa }).geometry.coordinates;
      const area = d3.geoArea({ type: 'Polygon', coordinates: sph });
      if (!(area > 0) || area > TAU) continue;  // a speck turned inside out by simplification
      c.src.push({ arcs: pa, sph, area, centroid: d3.geoCentroid({ type: 'Polygon', coordinates: sph }) });
    }
  }
  let points = 0, ringCount = 0;
  const all = [];
  for (const c of byKey.values()) {
    // main polygon (largest), far-flung parts, then planar-safe pieces
    let main = null;
    for (const sp of c.src) if (!main || sp.area > main.area) main = sp;
    c.polys = [];
    c.main = null;
    c.area = 0;
    if (!main) continue;
    const rMain = Math.sqrt(main.area / Math.PI) * DEG;      // equal-area radius of the main polygon, degrees
    const reach = Math.max(18, 3 * rMain) * RAD;
    for (const sp of c.src) {
      sp.main = sp === main;
      sp.core = sp.main || d3.geoDistance(sp.centroid, main.centroid) < reach;
      if (!sp.main && sp.area < D.minArea) continue;
      for (const pc of planarize(sp.sph, D.minArea, true)) {
        const piece = { coords: pc.coords, area: pc.area, src: sp, core: sp.core, main: false, bbox: ringBBox(pc.coords[0]), country: c };
        c.polys.push(piece);
        if (sp.main && (!c.main || piece.area > c.main.area)) c.main = piece;
      }
      sp.sph = null;
    }
    if (c.main) c.main.main = true;
    c.area = c.polys.reduce((sum, p) => sum + p.area, 0);
    for (const p of c.polys) {
      all.push(p);
      for (const r of p.coords) { points += r.length; ringCount++; }
    }
  }

  // land (same arcs → coastlines coincide exactly with the countries)
  const landF = topojson.feature(topo, raw.objects.land);
  const landGeoms = landF.type === 'FeatureCollection' ? landF.features.map((f) => f.geometry) : [landF.geometry || landF];
  const landPolys = [], landSph = [];
  for (const g of landGeoms) {
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of list) {
      const pcs = planarize(poly, D.minArea, false);
      for (const pc of pcs) landPolys.push(pc);
      if (pcs.length) landSph.push(poly.map(ringClosed));
    }
  }
  landPolys.sort((a, b) => b.area - a.area);
  const landArea = landPolys.reduce((s, p) => s + p.area, 0);

  // countryAt grid index: 5° cells
  const CELL = 5, NX = 72, NY = 36;
  const grid = Array.from({ length: NX * NY }, () => []);
  all.forEach((p, idx) => {
    const [w, s, e, n] = p.bbox;
    const x0 = Math.max(0, Math.floor((w + 180) / CELL)), x1 = Math.min(NX - 1, Math.floor((e + 180) / CELL));
    const y0 = Math.max(0, Math.floor((s + 90) / CELL)), y1 = Math.min(NY - 1, Math.floor((n + 90) / CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * NX + x].push(idx);
  });

  const E = {
    detail, topo, D, byKey, polys: all, landPolys, landSph, landArea, grid, CELL, NX, NY, landObj: raw.objects.land,
    countriesObj: raw.objects.countries, shapes: new Map(), tinyMarkers: null, meshes: new Map(),
    stats: { detail, points, rings: ringCount, countries: byKey.size, landFrac: +(landArea / (4 * Math.PI)).toFixed(4), ms: 0 },
  };
  E.stats.ms = Math.round((globalThis.performance || Date).now() - t0);
  return E;
}

function getEarth(opts = {}) {
  const detail = DETAIL[opts.detail] ? opts.detail : 'medium';
  if (!earths.has(detail)) {
    const p = buildEarth(detail).then((E) => { built.set(detail, E); lastEarth = E; return E; });
    p.catch(() => earths.delete(detail));
    earths.set(detail, p);
  }
  return earths.get(detail);
}

/** Preload (and warm) one detail level. Resolves with build stats. */
export async function loadEarth(opts = {}) {
  const E = await getEarth(opts);
  lastEarth = E;
  return Object.assign({}, E.stats);
}

// ---------------------------------------------------------------------------------------------------------------
// shapes for a set of countries

function countryRecs(E, a2s) {
  const out = [];
  for (const code of a2s) {
    const a = normA2(code);
    if (!a) continue;
    for (const c of E.byKey.values()) if (c.a2 === a) { out.push(c); break; }
  }
  return out;
}

function buildShape(E, a2s, opts) {
  const d3 = globalThis.d3, topojson = globalThis.topojson;
  const recs = countryRecs(E, a2s);
  if (!recs.length) return null;
  const overseas = !!opts.overseas;
  const parts = [];
  for (const c of recs) for (const p of c.polys) if (overseas || p.core) parts.push(p);
  if (!parts.length) return null;

  let polygons = [];
  const srcs = [...new Set(parts.map((p) => p.src))];
  if (recs.length === 1) {
    polygons = parts.map((p) => p.coords);
  } else {
    // dissolve internal borders (大中华 = China + Hong Kong + Taiwan, 欧洲 = 16 countries …) on the topology
    const merged = topojson.merge(E.topo, [{ type: 'MultiPolygon', arcs: srcs.map((sp) => sp.arcs) }]);
    for (const poly of merged.coordinates) for (const pc of planarize(poly, E.D.minArea, true)) polygons.push(pc.coords);
  }
  if (!polygons.length) return null;
  const withArea = polygons.map((coords) => ({ coords, area: d3.geoArea({ type: 'Polygon', coordinates: coords }) }));
  withArea.sort((a, b) => b.area - a.area);
  polygons = withArea.map((x) => x.coords);
  const geometry = { type: 'MultiPolygon', coordinates: polygons };
  const area = d3.geoArea(geometry);
  const centroid = d3.geoCentroid(geometry);
  // label point: a single country → its pole of inaccessibility (always on land, never in a bay); a group of
  // countries → the area centroid when it falls on the group's land (欧洲 → central Europe), else the biggest piece
  const center = recs.length > 1 && d3.geoContains(geometry, centroid)
    ? [Math.round(centroid[0] * 1e4) / 1e4, Math.round(centroid[1] * 1e4) / 1e4]
    : labelPoint(polygons[0]);
  const bbox = d3.geoBounds(geometry);
  // radius: every vertex; coreRadius: only the largest pieces holding 90% of the area (camera framing — the
  // Canaries, Svalbard or the Azores should not zoom 欧洲 out)
  let radius = 0, coreRadius = 0, cum = 0;
  withArea.forEach(({ coords, area: a }) => {
    const inCore = cum < 0.9 * withArea.reduce((t, x) => t + x.area, 0);
    cum += a;
    const ring = coords[0];
    const step = Math.max(1, Math.floor(ring.length / 400));
    for (let i = 0; i < ring.length; i += step) {
      const d = d3.geoDistance(center, ring[i]);
      if (d > radius) radius = d;
      if (inCore && d > coreRadius) coreRadius = d;
    }
  });
  // strokes come from the topology, one line per arc: the shape's outline (coast + outer borders) and, for a group,
  // the borders between its members — never the antimeridian / pole cut that the fill rings carry
  const owner = new Map();
  srcs.forEach((sp) => { for (const r of recs) if (r.src.includes(sp)) owner.set(sp, r.key); });
  const coll = { type: 'GeometryCollection', geometries: srcs.map((sp) => ({ type: 'Polygon', arcs: sp.arcs, properties: { k: owner.get(sp) } })) };
  const outline = meshLines(E.topo, coll, (a, b) => a === b);
  const innerBorders = recs.length > 1 ? meshLines(E.topo, coll, (a, b) => a !== b && a.properties.k !== b.properties.k) : [];
  const tiny = area < TINY_AREA;
  const shape = {
    kind: 'earth',
    a2: recs.map((c) => c.a2),
    num: recs.map((c) => c.num),
    rings: polygons.map((p) => p[0]),
    polygons,
    geometry,
    outline,
    borders: innerBorders,
    center,
    centroid,
    bbox,
    radius: +(radius * DEG).toFixed(3),
    coreRadius: +(coreRadius * DEG).toFixed(3),
    area,
    km2: Math.round(area * R_KM2),
    tiny,
  };
  if (tiny) {
    shape.marker = center;
    shape.markerRing = d3.geoCircle().center(center).radius(TINY_MARKER_DEG).precision(10)().coordinates[0];
  }
  return shape;
}

function shapeFor(E, a2s, opts = {}) {
  const key = a2s.map((a) => normA2(a)).filter(Boolean).sort().join('+') + (opts.overseas ? '|o' : '');
  if (!key) return null;
  if (!E.shapes.has(key)) E.shapes.set(key, buildShape(E, a2s, opts));
  return E.shapes.get(key);
}

function nodeChildren(node, childNodes) {
  if (Array.isArray(childNodes) && childNodes.length) return childNodes;
  return (node && node.children) || [];
}

function membersOf(E, regionNode, opts) {
  const kids = regionNode && Array.isArray(regionNode.children) && regionNode.children.some((c) => c.markets)
    ? regionNode.children
    : glCountriesOf(regionNode && regionNode.id).map((id) => ({ id }));
  const out = [];
  for (const k of kids) {
    const a2 = isoForNode(k);
    const s = a2.length ? shapeFor(E, a2, opts) : null;
    if (s) out.push({ id: k.id, a2: s.a2, center: s.center, area: s.area, tiny: s.tiny });
  }
  return out;
}

/**
 * The §25 provider. Real shapes for the children of a 全球 node; null when the node has no real geography.
 * @param node        tree node (data/gl/tree.json)
 * @param childNodes  its children (defaults to node.children)
 * @param mapJson     unused (signature shared with islands.js)
 * @param opts        {detail, overseas, tree}
 */
export async function getLayout(node, childNodes, mapJson, opts = {}) {
  if (opts.tree) registerTree(opts.tree);
  const kids = nodeChildren(node, childNodes);
  if (!kids.length) return null;
  // cheap bail-out before touching any file: does at least one child map to a country?
  const isoKids = kids.map((c) => isoForNode(c));
  if (!isoKids.some((l) => l.length)) return null;
  const E = await getEarth(opts);
  lastEarth = E;
  const out = [];
  const unmapped = [];
  kids.forEach((c, i) => {
    const s = isoKids[i].length ? shapeFor(E, isoKids[i], opts) : null;
    if (!s) { unmapped.push(c.id); return; }
    const entry = Object.assign({ id: c.id }, s);
    // a child that groups several gl countries (a region seen from the world) lists them, for per-country
    // plates / labels inside the region
    const isGroup = (c.children || []).some((g) => Array.isArray(g.markets)) || glCountriesOf(c.id).length > 0;
    if (isGroup) entry.members = membersOf(E, c, opts);
    out.push(entry);
  });
  if (!out.length) return null;
  out.unmapped = unmapped;
  return out;
}

/** A node's own real shape (the focus country / region when flying in), or a raw {a2:[…]} set. */
export async function shapeOf(nodeOrId, opts = {}) {
  if (opts.tree) registerTree(opts.tree);
  const a2 = nodeOrId && Array.isArray(nodeOrId.a2) ? nodeOrId.a2 : isoForNode(nodeOrId);
  if (!a2.length) return null;
  const E = await getEarth(opts);
  lastEarth = E;
  const s = shapeFor(E, a2, opts);
  if (!s) return null;
  const id = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId.id || a2.join('+');
  return Object.assign({ id }, s);
}

/** Every land exterior ring (largest first) — neutral land under the coloured countries. */
export async function landRings(opts = {}) {
  const E = await getEarth(opts);
  return E.landPolys.map((p) => p.coords[0]);
}
/** Holes in the land (Caspian Sea, a few big lakes cut by world-atlas): paint as water on top of landRings. */
export async function lakeRings(opts = {}) {
  const E = await getEarth(opts);
  const out = [];
  for (const p of E.landPolys) for (let i = 1; i < p.coords.length; i++) out.push(p.coords[i]);
  return out;
}
/**
 * Land as GeoJSON MultiPolygon coordinates [[outer, …holes], …] (planar-safe, cut at the antimeridian).
 * {spherical:true} returns the uncut d3-native polygons instead — best for d3.geoPath fills (no hairline slit
 * where Antarctica / Chukotka meet the antimeridian); same area, same coastline.
 */
export async function landPolygons(opts = {}) {
  const E = await getEarth(opts);
  return opts.spherical ? E.landSph : E.landPolys.map((p) => p.coords);
}

/** Coastlines as lines [[lon,lat],…] (one per topology arc; planar-safe; no cut seams) — the shoreline foam. */
export async function coastlines(opts = {}) {
  const E = await getEarth(opts);
  if (!E.meshes.has('coast')) E.meshes.set('coast', meshLines(E.topo, E.landObj));
  return E.meshes.get('coast');
}
/** Land borders between countries as lines (each shared border once). */
export async function borders(opts = {}) {
  const E = await getEarth(opts);
  if (!E.meshes.has('borders')) E.meshes.set('borders', meshLines(E.topo, E.countriesObj, (a, b) => a !== b));
  return E.meshes.get('borders');
}

/** Every country (neutral ones too) with its own shape: for borders, hover cards, a neutral-country layer. */
export async function countries(opts = {}) {
  const E = await getEarth(opts);
  const out = [];
  for (const c of E.byKey.values()) {
    if (!c.polys.length) continue;
    const gl = c.a2 ? glOf(c.a2) : null;
    const main = c.main || c.polys[0];
    out.push({
      num: c.num, a2: c.a2, en: c.en, zh: c.zh,
      gl: gl ? gl.country : null, region: gl ? gl.region : null,
      rings: c.polys.map((p) => p.coords[0]),
      polygons: c.polys.map((p) => p.coords),
      center: main.centerCache || (main.centerCache = labelPoint(main.coords)),
      area: c.area,
    });
  }
  return out;
}

function tinyMarkers(E) {
  if (!E.tinyMarkers) {
    E.tinyMarkers = [];
    for (const c of E.byKey.values()) {
      if (!c.a2 || !c.main || c.area >= TINY_AREA) continue;
      const gl = glOf(c.a2);
      if (!gl) continue;
      const s = shapeFor(E, [c.a2], {});
      if (s) E.tinyMarkers.push({ c, center: s.center });
    }
  }
  return E.tinyMarkers;
}

function info(c, core) {
  const gl = c.a2 ? glOf(c.a2) : null;
  return {
    num: c.num, a2: c.a2, en: c.en, zh: c.zh,
    gl: gl && core ? gl.country : null,
    region: gl && core ? gl.region : null,
    core: !!core,
  };
}

/**
 * The country under a lon/lat, or null for the ocean (sync — returns null until loadEarth/getLayout resolved).
 * Tiny gl markets (Hong Kong): by default a point over the sea within 0.25° of one returns it. A renderer that draws
 * point-island markers passes {snapTiny: <marker radius in degrees at the current zoom>} so the marker wins over the
 * land underneath it (Shenzhen); {snapTiny:false} turns snapping off.
 * {detail} picks a loaded detail level; otherwise the most recently used one.
 */
export function countryAt(lon, lat, opts = {}) {
  const E = (opts.detail && built.get(opts.detail)) || lastEarth;
  if (!E || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const d3 = globalThis.d3;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  lat = Math.max(-90, Math.min(90, lat));
  const pt = [lon, lat];
  const nearTiny = (deg) => {
    for (const m of tinyMarkers(E)) if (d3.geoDistance(pt, m.center) < deg * RAD) return info(m.c, true);
    return null;
  };
  // the renderer drew point-island markers and says how big: they win over the land underneath
  if (typeof opts.snapTiny === 'number' && opts.snapTiny > 0) { const hit = nearTiny(opts.snapTiny); if (hit) return hit; }
  const x = Math.min(E.NX - 1, Math.floor((lon + 180) / E.CELL)), y = Math.min(E.NY - 1, Math.floor((lat + 90) / E.CELL));
  const cand = E.grid[y * E.NX + x];
  let best = null;
  for (const idx of cand) {
    const p = E.polys[idx];
    const [w, s, e, n] = p.bbox;
    if (lon < w - 1e-9 || lon > e + 1e-9 || lat < s - 1e-9 || lat > n + 1e-9) continue;
    if (d3.geoContains({ type: 'Polygon', coordinates: p.coords }, pt)) {
      // nested shapes (an enclave inside its host): the smaller one wins
      if (!best || p.area < best.area) best = p;
    }
  }
  if (best) return info(best.country, best.core);
  // over the sea right next to a tiny gl market (Victoria Harbour, the Pearl River mouth): that market
  return opts.snapTiny === false ? null : nearTiny(TINY_SNAP_DEG);
}

/** The ISO table (re-exported for renderers that only import earth.js). */
export { ISO_ROWS as ISO_COUNTRIES };
