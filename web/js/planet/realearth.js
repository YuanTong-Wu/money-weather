// planet/realearth.js — the §26 real Earth's own geography, shared by the 3D and 2D planets (no three.js).
//
//   baseLand()                 → Promise<[[ring, …holes], …]>  every coast on Earth (1:50m, gently simplified —
//                                via geo/earth.js when it is there, else vendor/geo/land-50m.json), d3-native winding
//   windowLand(box)            → Promise<[[ring, …], …]>       1:10m land clipped to a lon/lat window (zoomed views)
//   borderLines()              → Promise<[[[lon,lat],…],…]>    country borders (1:50m), for a faint atlas line
//   stateLines()               → Promise<[[[lon,lat],…],…]>    US state borders (1:10m), faint context in the US
//   admin1Index()              → Promise<{ISO2: {file, bbox, …}}> which countries have province / prefecture borders
//   admin1Lines(cc)            → Promise<[[[lon,lat],…],…]>    that country's inner province / state / prefecture borders
//   admin1For(box, {skip})     → Promise<[ISO2…]>              countries with admin1 borders whose bbox meets a window
//   cities(box?)               → Promise<[{name, en, lon, lat, pop (k), cc, cap}]> the biggest cities (an atlas's faint
//                                context when zoomed in; Chinese names from GeoNames), optionally inside a window
//   lodBox(view, aspect)       → {lon, lat0, lat1, span} the detailed window for a zoomed view (deg), or null
//   boxContains(box, lon, lat) → boolean
// Everything is fetched lazily, once, from web/vendor/geo/ (vendored, local).

const VENDOR = new URL('../../vendor/', import.meta.url);
const DEG = 180 / Math.PI;
const once = new Map();
const memo = (key, f) => { if (!once.has(key)) { const p = f(); once.set(key, p); p.catch(() => once.delete(key)); } return once.get(key); };

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('realearth: ' + src));
    document.head.appendChild(s);
  });
}
async function libs() {
  if (!(globalThis.d3 && globalThis.d3.geoArea)) await loadScript(new URL('d3.min.js', VENDOR).href);
  if (!(globalThis.topojson && globalThis.topojson.feature)) await loadScript(new URL('geo/topojson-client.min.js', VENDOR).href);
}
const json = (f) => memo('json:' + f, async () => { const r = await fetch(new URL('geo/' + f, VENDOR).href); if (!r.ok) throw new Error('realearth: ' + r.status + ' ' + f); return r.json(); });

const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

/** Every coast on Earth as d3-native polygons (1:50m). */
export function baseLand() {
  return memo('base', async () => {
    try {
      const E = await import('../geo/earth.js');
      if (typeof E.landPolygons === 'function') {
        const p = await E.landPolygons({ spherical: true });
        if (Array.isArray(p) && p.length) return p;
      }
    } catch (e) { /* earth.js missing: the raw 1:50m file */ }
    await libs();
    const t = await json('land-50m.json');
    const f = globalThis.topojson.feature(t, t.objects.land);
    const out = [];
    for (const g of f.type === 'FeatureCollection' ? f.features.map((x) => x.geometry) : [f.geometry || f]) out.push(...polysOf(g));
    return out;
  });
}

/** 1:10m land polygons with their planar bounding boxes (decoded once, ~400k points). */
function land10() {
  return memo('land10', async () => {
    await libs();
    const t = await json('land-10m.json');
    const f = globalThis.topojson.feature(t, t.objects.land);
    const out = [];
    for (const g of f.type === 'FeatureCollection' ? f.features.map((x) => x.geometry) : [f.geometry || f]) {
      for (const poly of polysOf(g)) {
        let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
        for (const [x, y] of poly[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        out.push({ poly, b: [x0, y0, x1, y1] });
      }
    }
    return out;
  });
}

/** Planar-lon distance helper (deg): is lon within ±half of c (with wrap)? */
const lonIn = (lon, c, half) => { let d = lon - c; d = ((d + 540) % 360) - 180; return Math.abs(d) <= half; };
export function boxContains(box, lon, lat) { return !!box && lat >= box.lat0 && lat <= box.lat1 && lonIn(lon, box.lon, box.span / 2); }

/**
 * 1:10m land inside a window (deg box {lon, lat0, lat1, span}), clipped exactly at the window's edges (d3 clip in
 * a rotated equirectangular plane — no resampling), returned as lon/lat polygons [[ring, …holes], …].
 */
export function windowLand(box) {
  const key = 'win:' + [box.lon, box.lat0, box.lat1, box.span].map((x) => (+x).toFixed(2)).join(',');
  return memo(key, async () => {
    const L = await land10();
    const d3 = globalThis.d3;
    const half = box.span / 2;
    const hit = (b) => {
      if (b[3] < box.lat0 || b[1] > box.lat1) return false;
      if (b[2] - b[0] > 300) return true; // wraps (Antarctica, the cut pieces): let the clip decide
      // any overlap in lon (with wrap)
      for (const lon of [b[0], b[2], (b[0] + b[2]) / 2]) if (lonIn(lon, box.lon, half)) return true;
      return lonIn(box.lon, (b[0] + b[2]) / 2, (b[2] - b[0]) / 2);
    };
    const proj = d3.geoEquirectangular().rotate([-box.lon, 0]).scale(DEG).translate([0, 0]).precision(0)
      .clipExtent([[-half, -box.lat1], [half, -box.lat0]]);
    const out = [];
    let poly = null, ring = null;
    const sink = {
      polygonStart() { poly = []; }, polygonEnd() { if (poly && poly.length) out.push(poly); poly = null; },
      lineStart() { ring = []; }, lineEnd() { if (ring && ring.length >= 3 && poly) { const a = ring[0], b = ring[ring.length - 1]; if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a.slice()); poly.push(ring); } ring = null; },
      point(x, y) { if (ring) ring.push([x + box.lon, -y]); }, sphere() {},
    };
    const stream = proj.stream(sink);
    for (const it of L) if (hit(it.b)) d3.geoStream({ type: 'Polygon', coordinates: it.poly }, stream);
    // the clipped rings are planar-wound; split polygons into separate exterior rings (holes found by containment downstream)
    return out;
  });
}

/** The biggest cities (planet/cities.json, built from geodata/cities15000.txt), optionally inside a window. */
export async function cities(box = null) {
  const all = await memo('cities', async () => {
    const r = await fetch(new URL('./cities.json', import.meta.url).href);
    if (!r.ok) throw new Error('realearth: cities ' + r.status);
    return (await r.json()).map(([name, en, lon, lat, pop, cc, cap]) => ({ name: name || en, zh: name || '', en, lon, lat, pop, cc, cap: !!cap }));
  });
  return box ? all.filter((c) => boxContains(box, c.lon, c.lat)) : all;
}

/** Country borders (lines), 1:50m. */
export function borderLines() {
  return memo('borders', async () => {
    try {
      const E = await import('../geo/earth.js');
      if (typeof E.borders === 'function') { const b = await E.borders(); if (Array.isArray(b) && b.length) return b; }
    } catch (e) { /* fall through */ }
    await libs();
    const t = await json('countries-50m.json');
    const m = globalThis.topojson.mesh(t, t.objects.countries, (a, b) => a !== b);
    return m.type === 'MultiLineString' ? m.coordinates : [m.coordinates];
  });
}

/** §26 amendment 2: which countries have admin1 (province / state / prefecture) borders vendored. */
export function admin1Index() {
  return memo('admin1:index', async () => {
    const r = await fetch(new URL('geo/admin1/index.json', VENDOR).href);
    if (!r.ok) throw new Error('realearth: admin1 index ' + r.status);
    return r.json();
  });
}

/** One country's inner admin1 borders (lines shared by two units), lon/lat. */
export function admin1Lines(cc) {
  return memo('admin1:' + cc, async () => {
    await libs();
    const idx = await admin1Index();
    const meta = idx[cc];
    if (!meta) return [];
    const r = await fetch(new URL('geo/admin1/' + (meta.file || cc + '.json'), VENDOR).href);
    if (!r.ok) throw new Error('realearth: admin1 ' + cc + ' ' + r.status);
    const t = await r.json();
    const obj = t.objects[meta.object || 'admin1'] || t.objects[Object.keys(t.objects)[0]];
    const m = globalThis.topojson.mesh(t, obj, (a, b) => a !== b);
    return m.type === 'MultiLineString' ? m.coordinates : [m.coordinates];
  });
}

/** Countries (ISO2) with admin1 borders whose bbox meets a lon/lat window {lon, lat0, lat1, span}. */
export async function admin1For(box, { skip = [] } = {}) {
  if (!box) return [];
  const idx = await admin1Index().catch(() => null);
  if (!idx) return [];
  const out = [];
  for (const [cc, m] of Object.entries(idx)) {
    if (skip.includes(cc) || !m || !Array.isArray(m.bbox)) continue;
    const [x0, y0, x1, y1] = m.bbox;
    if (y1 < box.lat0 || y0 > box.lat1) continue;
    // lon overlap with wrap (a bbox wider than 300° — US / RU across the antimeridian — always counts)
    if (x1 - x0 > 300 || lonIn(box.lon, (x0 + x1) / 2, (x1 - x0) / 2 + box.span / 2)) out.push(cc);
  }
  return out;
}

/** US state borders (inner lines only), 1:10m. */
export function stateLines() {
  return memo('states', async () => {
    await libs();
    const t = await json('us-states-10m.json');
    const m = globalThis.topojson.mesh(t, t.objects.states, (a, b) => a !== b);
    return m.type === 'MultiLineString' ? m.coordinates : [m.coordinates];
  });
}

/**
 * The detailed (1:10m) window for a view {lon, lat, scale}: about 1.9× what the screen shows (the seam stays
 * off-screen while the owner drags a little), or null when the globe is small enough for 1:50m.
 */
export function lodBox(view, aspect = 1.6, minScale = 2.6) {
  if (!view || !(view.scale >= minScale)) return null;
  return viewWindow(view, aspect, 1.3);
}

/**
 * A lon/lat window (deg) that holds what a view {lon, lat, scale} shows (× margin): the visible half-height is
 * ≈ asin(1/scale); in longitude the poleward edge is the widest. Never wider than 200° (then it is not a close-up).
 */
export function viewWindow(view, aspect = 1.6, margin = 1.3) {
  const half = Math.asin(Math.min(1, 1.05 / Math.max(1, view.scale))) * DEG;
  const lat0 = Math.max(-85, view.lat - half * margin), lat1 = Math.min(85, view.lat + half * margin);
  const pole = Math.min(82, Math.abs(view.lat) + half);
  const c = Math.max(0.18, Math.cos((pole * Math.PI) / 180));
  const span = Math.min(200, (2 * half * Math.max(1.2, aspect) * margin) / c);
  return { lon: view.lon, lat0, lat1, span };
}
