// geo/silhouettes.js — 抽象 map with REAL silhouettes (DESIGN §26 B).
//
// One landmass per child, but every landmass is a real continent / island outline (Eurasia, Africa, North America,
// South America, Australia, Greenland, New Guinea, Borneo, Madagascar, Honshu, Great Britain, Iceland, Sri Lanka,
// Taiwan, …: web/js/geo/silhouette-lib.json, built by geodata/build_silhouettes.py from world-atlas). Shapes keep
// their true relative shape: stored in Lambert azimuthal equal-area coordinates around their own centroid, north up,
// and put back on the sphere with the inverse projection (a shape at its real size is exactly the real coast, only
// moved; scaled shapes stay equal-area).
//
//   - ONE-HEMISPHERE WORLD: every landmass sits on the face you see (its centre within 65° of the front, its whole
//     coast within 80°); the back of the planet is open ocean. Land is ~10 % of the sphere, so the disc the camera
//     sees reads ≥ 65 % sea (§25: "四分之一是陆地"), and nothing is a foreshortened sliver on the limb;
//   - ATTENTION FIRST (§6/§8.1): today's ①②③ (words.attentionPicks; on the root the continents of brief.json's
//     spotlights, as the shell numbers them) and the 主航道's ends (brief.channel / words.mainChannel / the headline's
//     story) — or opts.focus when the shell passes them — are placed first, as close to the front as their size
//     allows (~35°), before the money-relatives packing; `front` is returned so the camera opens on them;
//   - sizes ∝ sqrt(dv20) (the root: dv20^0.4, at most 22 % of the land, so all six continents fit on the face), but
//     no silhouette is wider than 55° of arc: a long coast is shrunk, never swapped (日本 is always the Japan
//     archipelago, 韩国 Korea, 台湾 Taiwan); a leaf of stocks is an archipelago of real islands (land 7.5–9.5 %);
//   - children whose name says a geography keep their own coast: 美股 → the USA, 中国/A股 → China, 欧洲 → Europe,
//     英国 → Great Britain, 日本 → Japan, 印度 → India, 台股 → Taiwan, 澳洲 → Australia, 拉美 → South America,
//     东南亚 → Borneo …; one planet never shows a place twice (no Eurasia beside China, no North America beside the
//     USA: the library's `has` containment); under a geographic planet (欧洲, 中国, 日本 …) the other children get
//     shapes from that region (a Europe planet's sectors are European islands; a 日本 leaf's stocks the islands
//     nearest Japan), never a continent from elsewhere;
//   - straits: at least max(3°, 0.12 × the smaller coast's equivalent radius) of open sea between any two coasts (the
//     coast foam never closes a strait), wider between strangers, narrower between money relatives;
//   - placement: greedy (focus first, then biggest first), each next landmass beside a central one or its closest
//     money relative (correlation of daily returns over the last year with the planet's own day taken out), at the
//     best spot whose REAL coast clears every other coast; then a safe compaction toward the front (a step is only
//     taken if every strait stays open), a cleanup pass, and a final check that moves any landmass whose coast still
//     crosses another, or that left the visible hemisphere, to a free spot;
//   - deterministic: silhouettes by size rank + node id, positions by the same seed, inputs quantised (half-octave
//     size tiers, affinity in steps of ¼). The layout follows the latest day's ①②③ (they are part of the cache key).
//     Slow layouts (big archipelagos) are remembered in localStorage (mw.silhouettes.v2:<node>, at most 48).
//
// Exports
//   getLayout(node, childNodes, mapJson, opts) → Promise<{view:{lon,lat,scale}, items:[…], front, mode:'abstract', stats}>  (§26)
//   silhouetteLayout(node, childNodes, mapJson, opts) → Promise<[{id, kind:'land', rings, center, area, shape, shapeZh}]>
//       (the §25 array, a drop-in for islands.js: carries .front, .mode = 'abstract', .view, .stats)
//   loadSilhouettes() → Promise<lib>   (lib.shapes, lib.byId, lib.continents, lib.islands)
// Items: {id, kind:'land', rings:[[[lon,lat],…],…] (d3 winding: coasts clockwise, lakes counter-clockwise; a region
//         such as Japan or Europe has several coasts), center:[lon,lat], area (sr), shape: library id, shapeName, shapeZh}.
// stats: {land (fraction of the sphere), overlapsLeft (0), hidden (centres > 65° from the front), focus (ids),
//         shrunk (library ids drawn smaller than their share: too long for 55°, or squeezed), restored, ms}.
// If the library cannot be loaded, both layout functions fall back to geo/islands.js (procedural blobs).
//
// opts: {focus: [id | {id}] (the ①②③ + 主航道 ends; default: computed from mapJson for the latest day),
//        map: the shell's map key ('curated' | 'full' | 'global': which brief.json the root reads),
//        land: fraction of the sphere (default ≈ 0.1), ocean: strait-width factor (1),
//        strait: hard coast gap as a share of the strait (0.3), variety: false (always the top of the pool),
//        front: [lon, lat], cache: false (skip localStorage), squeeze: true (extra force pass)}

import { mulberry32, hashStr } from '../planet/util.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const FRONT = [0, 8]; // lon, lat (deg) — the same front as islands.js
const NB = 72; // directional extent bins
const LIB_URL = new URL('./silhouette-lib.json?v=2', import.meta.url);
const CAP_C = 65 / DEG, CAP_E = 80 / DEG, CAP_F = 35 / DEG; // centres / whole coasts / ①②③ within this of the front
const EXT_MAX = 55 / DEG; // no silhouette wider than this (great-circle reach, coast to coast)
const MIN_STRAIT = 3 / DEG; // open sea between two coasts, at least (the coast foam must not close it)
const ALGO = 'hemi2'; // part of the cache keys: a new placement never reuses an old one

export const isStockNode = (c) => !!c && (c.kind === 'stock' || String(c.id || '').startsWith('s:'));

// ------------------------------------------------------------------------------------------ vectors
/** lon/lat (deg) → unit vector (x east at lon 90, y north, z toward lon 0 lat 0) — same space as islands.js / sphere.js. */
function dirOf(lon, lat) {
  const a = lon / DEG, b = lat / DEG, c = Math.cos(b);
  return [c * Math.sin(a), Math.sin(b), c * Math.cos(a)];
}
function lonLatOf(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [Math.atan2(d[0], d[2]) * DEG, Math.asin(Math.max(-1, Math.min(1, d[1] / l))) * DEG];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; a[0] /= l; a[1] /= l; a[2] /= l; return a; };
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
/** Local tangent frame at c: [east, north]. */
function frame(c) {
  let e = [c[2], 0, -c[0]];
  if (Math.hypot(e[0], e[2]) < 1e-6) e = [1, 0, 0];
  norm(e);
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  return [e, norm(n)];
}
/** Point at azimuthal-equidistant offset (x, y) rad from c. */
function expMap(c, e, n, x, y) {
  const r = Math.hypot(x, y);
  if (r < 1e-12) return c.slice();
  const s = Math.sin(r) / r, k = Math.cos(r);
  return norm([k * c[0] + s * (x * e[0] + y * n[0]), k * c[1] + s * (x * e[1] + y * n[1]), k * c[2] + s * (x * e[2] + y * n[2])]);
}
/** Inverse Lambert azimuthal equal-area: planar (x, y) on the unit sphere's tangent plane at c → unit vector. */
function invLaea(c, e, n, x, y) {
  const rho = Math.hypot(x, y);
  if (rho < 1e-12) return c.slice();
  const cc = 2 * Math.asin(Math.min(1, rho / 2));
  const s = Math.sin(cc) / rho, k = Math.cos(cc);
  return norm([k * c[0] + s * (x * e[0] + y * n[0]), k * c[1] + s * (x * e[1] + y * n[1]), k * c[2] + s * (x * e[2] + y * n[2])]);
}
/** Forward LAEA of unit vector p around c (planar, unit sphere). */
function laea(c, e, n, p) {
  const d = dot(p, c);
  const k = Math.sqrt(2 / Math.max(1e-9, 1 + d));
  return [k * dot(p, e), k * dot(p, n)];
}
const angOfRho = (rho) => 2 * Math.asin(Math.min(1, rho / 2));
/** Move a along the great circle away from b by delta rad (negative: toward b). */
function pushAway(a, b, delta) {
  const d = dot(a, b);
  let t = [a[0] * d - b[0], a[1] * d - b[1], a[2] * d - b[2]];
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

// ------------------------------------------------------------------------------------------ library
// Recognisability tiers: 1 = anyone knows it, 2 = clean and readable, 3 = fjord-ragged Arctic coasts (used last).
const TIER3 = new Set(['ellesmere', 'devon-island', 'melville-island-ca', 'axel-heiberg', 'prince-of-wales-ca', 'somerset-island',
  'spitsbergen', 'novaya-zemlya-n', 'novaya-zemlya-s', 'kodiak', 'east-falkland', 'cape-breton', 'graham-island', 'south-georgia',
  'zealand-dk', 'southampton', 'banks-island', 'victoria-island']);
const TIER1 = new Set(['new-guinea', 'borneo', 'madagascar', 'sumatra', 'honshu', 'great-britain', 'sulawesi', 'south-island-nz', 'java',
  'north-island-nz', 'luzon', 'cuba', 'iceland', 'mindanao', 'ireland', 'hokkaido', 'hispaniola', 'sakhalin', 'sri-lanka', 'tasmania',
  'taiwan', 'kyushu', 'hainan', 'sicily', 'sardinia', 'corsica', 'crete', 'cyprus', 'jamaica', 'shikoku',
  'tierra-del-fuego', 'vancouver-island', 'timor', 'bali', 'jeju', 'puerto-rico', 'long-island', 'mallorca', 'palawan', 'new-caledonia',
  'trinidad', 'hawaii', 'okinawa']);
// baffin / newfoundland are famous but fjord-ragged: tier 2 (default)

function decodeShape(s) {
  const pts = (flat) => {
    const o = [];
    for (let i = 0; i + 1 < flat.length; i += 2) o.push([flat[i] / 1e4, flat[i + 1] / 1e4]);
    return o;
  };
  // parts: [[coast, lake…], …] (part 0 = the main landmass); old single-part libraries: rings = [coast, lake…]
  const parts = (s.parts || (s.rings ? [s.rings] : [])).map((p) => p.map(pts).filter((r) => r.length >= 3)).filter((p) => p.length);
  const rings = [], hole = [];
  for (const p of parts) p.forEach((r, k) => { rings.push(r); hole.push(k > 0); });
  // directional extent profile (max radius per bin over every coast, edges sampled), widened ±1 bin
  const raw = new Float32Array(NB);
  let per = 0;
  for (const p of parts) {
    const outer = p[0];
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], q = outer[(i + 1) % outer.length];
      const L = Math.hypot(q[0] - a[0], q[1] - a[1]);
      per += L;
      const steps = Math.max(1, Math.ceil(L / 0.04));
      for (let t = 0; t < steps; t++) {
        const x = a[0] + ((q[0] - a[0]) * t) / steps, y = a[1] + ((q[1] - a[1]) * t) / steps;
        const b = Math.floor(((Math.atan2(y, x) + Math.PI) / TAU) * NB) % NB;
        const r = Math.hypot(x, y);
        if (r > raw[b]) raw[b] = r;
      }
    }
  }
  const ext = new Float32Array(NB);
  let emax = 0;
  for (let b = 0; b < NB; b++) {
    ext[b] = Math.max(raw[b], raw[(b + 1) % NB], raw[(b + NB - 1) % NB], 0.25);
    emax = Math.max(emax, ext[b]);
  }
  // evenly spaced coast samples for the exact no-touch pass (≤ ~360 per shape)
  const sp = Math.max(0.035, per / 360);
  const samp = [];
  for (const p of parts) {
    const outer = p[0];
    let acc = sp;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], q = outer[(i + 1) % outer.length];
      const L = Math.hypot(q[0] - a[0], q[1] - a[1]);
      let t = sp - acc;
      while (t <= L) { const f = L > 0 ? t / L : 0; samp.push(a[0] + (q[0] - a[0]) * f, a[1] + (q[1] - a[1]) * f); t += sp; }
      acc = L - (t - sp);
    }
  }
  // per-part bounding boxes for the planar point-in-polygon pre-test
  const boxes = parts.map((p) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  });
  const tier = s.kind === 'continent' ? 0 : s.kind !== 'island' ? 4 : TIER1.has(s.id) ? 1 : TIER3.has(s.id) ? 3 : 2;
  const core = Array.isArray(s.core) && s.core.length === 2 ? [+s.core[0], +s.core[1]] : [0, 0]; // well inside the main part
  // reach: the farthest two coast points (normalised; older libraries: the diameter of the extent profile)
  let diam = +s.d;
  if (!(diam > 0)) { diam = 0; for (let b = 0; b < NB / 2; b++) diam = Math.max(diam, raw[b] + raw[b + NB / 2]); diam = diam || 2 * emax; }
  const c = Array.isArray(s.c) ? s.c : [0, 0];
  const reg = s.reg || regionOf(s.id, +c[0], +c[1]);
  const has = new Set(Array.isArray(s.has) ? s.has : HAS_V1[s.id] || []);
  return { id: s.id, name: s.name, zh: s.zh, kind: s.kind, km2: s.km2, sr: s.sr, c, tier, parts, rings, hole, ext, emax, diam, reg, has, samp: Float64Array.from(samp), sp, boxes, core };
}

/** Coarse world region of a real centroid (same rule as build_silhouettes.py; Eurasia spans two). */
function regionOf(id, lon, lat) {
  if (id === 'eurasia') return 'eurasia';
  if (lon <= -30) return lon < -150 && lat < 30 ? 'oceania' : 'americas';
  if ((lat < -11 && lon >= 100) || (lon >= 130 && lat < 0) || lon >= 160) return 'oceania';
  if (lon > -30 && lon < 45 && lat >= 35) return 'europe';
  if (lon < 60 && lat < 35 && !(lon > 34 && lat > 12)) return 'africa';
  return 'asia';
}
const sameRegion = (a, b) => !!a && !!b && (a === b || (a === 'eurasia' && (b === 'europe' || b === 'asia')) || (b === 'eurasia' && (a === 'europe' || a === 'asia')));
// containment for a version-1 library (no `has`): the continents and the regions only
const HAS_V1 = {
  eurasia: ['europe', 'italy', 'denmark', 'c-china', 'c-india', 'c-south-korea', 'c-hong-kong', 'c-france', 'c-germany', 'c-switzerland', 'c-netherlands', 'c-sweden', 'c-norway', 'c-finland', 'c-spain', 'c-saudi-arabia', 'c-russia', 'c-turkey', 'c-vietnam', 'c-thailand', 'c-israel', 'c-poland'],
  'north-america': ['c-usa', 'c-canada', 'c-mexico'], 'south-america': ['c-brazil', 'c-argentina'], africa: ['c-south-africa'],
  europe: ['great-britain', 'ireland', 'sicily', 'sardinia', 'british-isles', 'italy', 'denmark', 'c-france', 'c-germany', 'c-switzerland', 'c-netherlands', 'c-sweden', 'c-norway', 'c-finland', 'c-spain', 'c-poland'],
  japan: ['honshu', 'hokkaido', 'kyushu', 'shikoku'], 'new-zealand': ['south-island-nz', 'north-island-nz'], 'british-isles': ['great-britain', 'ireland'],
  italy: ['sicily', 'sardinia'], denmark: ['zealand-dk'], philippines: ['luzon', 'mindanao', 'samar', 'negros', 'palawan', 'panay', 'mindoro'],
};
/** The same place twice on one planet? (one contains the other's centre: Eurasia ∋ China, Japan ∋ Honshu …) */
const overlaps = (a, b) => a === b || a.id === b.id || a.has.has(b.id) || b.has.has(a.id);

let libP = null;
/** The silhouette library (fetched once). */
export function loadSilhouettes() {
  return (libP ||= fetch(LIB_URL).then((r) => {
    if (!r.ok) throw new Error('silhouette-lib.json ' + r.status);
    return r.json();
  }).then((j) => {
    const shapes = (j.shapes || []).map(decodeShape).filter((s) => s.rings.length);
    if (shapes.length < 20) throw new Error('silhouette library too small');
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const sig = (j.v || 1) + ':' + shapes.length + ':' + shapes.reduce((a, s) => (a + s.km2) % 1e9, 0);
    const bySize = (a, b) => b.sr - a.sr;
    const continents = shapes.filter((s) => s.kind === 'continent').sort(bySize);
    const isl = (t) => shapes.filter((s) => s.kind === 'island' && s.tier === t).sort(bySize);
    const islands = [...isl(1), ...isl(2), ...isl(3)]; // regions / countries: only for children with that geography
    return { shapes, byId, sig, continents, islands, pools: { land: [...continents, ...islands], arch: islands } };
  }).catch((e) => { libP = null; throw e; }));
}

const extAt = (sh, a) => sh.ext[Math.floor(((a + Math.PI) / TAU) * NB) % NB];
function pipFlat(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Is (planar, normalised) point inside the shape's land (any part's coast, minus its lakes)? */
function insideShape(sh, x, y) {
  for (let k = 0; k < sh.parts.length; k++) {
    const b = sh.boxes[k], p = sh.parts[k];
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (!pipFlat(p[0], x, y)) continue;
    let lake = false;
    for (let h = 1; h < p.length; h++) if (pipFlat(p[h], x, y)) { lake = true; break; }
    if (!lake) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------ geography hints
// Children with an obvious geography keep their own coast (first free candidate wins, biggest child first; a hinted
// coast is never swapped for another, only shrunk to fit). Rows: [name pattern, candidates, region?] — region
// undefined: the place's own region (a literal place: its siblings may get shapes from there); null: a metaphor
// (海外股市 → Eurasia), no regional rule for its children. Exact names first, then names that contain a place.
const HINTS = [
  [/^(美股|美国|美国股市|美国市场)$/, ['c-usa', 'north-america']],
  [/^(美洲|北美|北美洲)$/, ['north-america', 'c-usa']],
  [/^(加拿大|加股)$/, ['c-canada', 'north-america', 'vancouver-island', 'newfoundland']],
  [/^(巴西)$/, ['c-brazil', 'south-america']],
  [/^(拉美|南美|南美洲|拉丁美洲)$/, ['south-america', 'c-mexico', 'c-argentina']],
  [/^(墨西哥)$/, ['c-mexico']],
  [/^(阿根廷)$/, ['c-argentina']],
  [/^(海外股市|海外|欧亚|全球除美国)$/, ['eurasia'], null],
  [/^(亚洲)$/, ['eurasia']],
  [/^(大中华|中国|中国股市|A股|中概|中国大盘)$/, ['c-china', 'eurasia', 'hainan']],
  [/^(港股|香港)$/, ['c-hong-kong', 'hainan']],
  [/^(台股|台湾)$/, ['taiwan']],
  [/^(欧洲|欧洲股市|欧股)$/, ['europe', 'british-isles', 'great-britain']],
  [/^(英国|英股)$/, ['great-britain', 'british-isles']],
  [/^(爱尔兰)$/, ['ireland']],
  [/^(法国)$/, ['c-france', 'corsica']],
  [/^(德国)$/, ['c-germany']],
  [/^(瑞士)$/, ['c-switzerland']],
  [/^(荷兰)$/, ['c-netherlands']],
  [/^(瑞典)$/, ['c-sweden', 'gotland']],
  [/^(挪威)$/, ['c-norway']],
  [/^(芬兰)$/, ['c-finland']],
  [/^(丹麦)$/, ['denmark', 'zealand-dk']],
  [/^(西班牙)$/, ['c-spain', 'mallorca']],
  [/^(意大利)$/, ['italy', 'sicily']],
  [/^(波兰)$/, ['c-poland']],
  [/^(俄罗斯)$/, ['c-russia']],
  [/^(土耳其)$/, ['c-turkey']],
  [/^(以色列)$/, ['c-israel']],
  [/^(沙特|沙特阿拉伯)$/, ['c-saudi-arabia']],
  [/^(南非)$/, ['c-south-africa']],
  [/^(非洲)$/, ['africa']],
  [/^(印度)$/, ['c-india', 'sri-lanka']],
  [/^(韩国|韩股)$/, ['c-south-korea', 'jeju']],
  [/^(日本|日股)$/, ['japan', 'honshu']],
  [/^(亚洲发达)$/, ['japan', 'honshu'], 'asia'],
  [/^(澳洲|澳大利亚)$/, ['australia', 'tasmania']],
  [/^(亚太)$/, ['australia', 'new-zealand'], null],
  [/^(新兴市场)$/, ['south-america', 'africa'], null],
  [/^(其他发达)$/, ['australia', 'c-canada'], null],
  [/^(海外大篮子|发达市场|海外发达)$/, ['eurasia', 'europe'], null],
  [/^(新兴大篮子)$/, ['africa', 'south-america'], null],
  [/^(新西兰)$/, ['new-zealand', 'north-island-nz']],
  [/^(新加坡)$/, ['c-singapore']],
  [/^(越南)$/, ['c-vietnam']],
  [/^(泰国)$/, ['c-thailand']],
  [/^(印尼|印度尼西亚)$/, ['java', 'sumatra', 'borneo']],
  [/^(菲律宾)$/, ['philippines', 'luzon']],
  [/^(冰岛)$/, ['iceland']],
  [/^(古巴)$/, ['cuba']],
  [/^(斯里兰卡)$/, ['sri-lanka']],
  [/^(格陵兰)$/, ['greenland']],
  [/^(马达加斯加)$/, ['madagascar']],
  // names that contain a place: 澳洲东南亚, 拉美其他, 中国网娱, 中国智能车 …
  [/澳洲|澳大利亚/, ['australia', 'tasmania']],
  [/东南亚/, ['borneo', 'sumatra', 'java']],
  [/拉美|拉丁美洲|墨西哥/, ['south-america', 'c-mexico', 'c-argentina']],
  [/中国|中概|A股/, ['c-china', 'hainan']],
  [/日本/, ['japan', 'honshu']],
  [/印度/, ['c-india', 'sri-lanka']],
  [/韩国/, ['c-south-korea', 'jeju']],
  [/香港|港股/, ['c-hong-kong', 'hainan']],
  [/台湾|台股/, ['taiwan']],
];
// coasts that only a child named for that place may use (besides every region and country outline)
const HINT_ONLY = new Set(['taiwan']);
/** {ids, region} for a node / child whose name says a geography, else null. */
function hintFor(c) {
  const nm = String((c && c.name) || '').trim();
  for (const [re, ids, region] of HINTS) if (re.test(nm)) return { ids, region };
  return null;
}

// ------------------------------------------------------------------------------------------ relations
/**
 * Money relatives among siblings → affinity 0…1: correlation of daily returns over the last year after taking out
 * what the whole planet does that day (so "everything rises with the market" does not make everyone a relative),
 * quantised so the layout stays put from one day to the next.
 */
function affinities(kids, mapJson) {
  const n = kids.length;
  const A = Array.from({ length: n }, () => new Float32Array(n));
  const ch = mapJson && mapJson.children;
  if (!ch || n < 3) return { A, key: '' };
  const T = 252;
  const R = kids.map((c) => {
    const s = ch[c.id];
    const idx = s && Array.isArray(s.idx) ? s.idx : null;
    if (!idx || idx.length < 60) return null;
    const v = idx.slice(-(T + 1)).map(Number);
    const r = new Float64Array(T).fill(NaN);
    for (let i = 1; i < v.length; i++) if (v[i - 1] > 0 && v[i] > 0) r[T - v.length + i] = Math.log(v[i] / v[i - 1]);
    return r;
  });
  // the planet's own day (cross-sectional mean of the siblings that have data)
  const mkt = new Float64Array(T);
  for (let t = 0; t < T; t++) { let s = 0, k = 0; for (const r of R) if (r && Number.isFinite(r[t])) { s += r[t]; k++; } mkt[t] = k ? s / k : 0; }
  const Z = R.map((r) => {
    if (!r) return null;
    const z = new Float64Array(T);
    let m = 0, k = 0;
    for (let t = 0; t < T; t++) if (Number.isFinite(r[t])) { z[t] = r[t] - mkt[t]; m += z[t]; k++; }
    if (k < 50) return null;
    m /= k;
    let sd = 0;
    for (let t = 0; t < T; t++) { z[t] = Number.isFinite(r[t]) ? z[t] - m : 0; sd += z[t] * z[t]; }
    sd = Math.sqrt(sd);
    if (sd < 1e-12) return null;
    for (let t = 0; t < T; t++) z[t] /= sd;
    return z;
  });
  let key = '';
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let q = 0;
    if (Z[i] && Z[j]) {
      let c = 0;
      for (let t = 0; t < T; t++) c += Z[i][t] * Z[j][t];
      q = Math.round(Math.max(0, Math.min(1, (c - 0.08) / 0.42)) * 4) / 4; // 0, .25, .5, .75, 1
    }
    A[i][j] = A[j][i] = q;
    key += q * 4;
  }
  return { A, key };
}

// ------------------------------------------------------------------------------------------ layout
const layoutCache = new Map();
// placements survive reloads (a 60-island archipelago takes a few hundred ms to settle; a revisit should be
// instant): only layouts that were slow to compute, at most 48 planets (oldest dropped), in this viewer's browser
const STORE = 'mw.silhouettes.v2:', STORE_IDX = 'mw.silhouettes.v2', STORE_MAX = 48;
function stored(nodeId, sig) {
  try {
    const j = JSON.parse(localStorage.getItem(STORE + nodeId) || 'null');
    return j && j.sig === sig && Array.isArray(j.p) ? j : null;
  } catch (e) { return null; }
}
let droppedV1 = false;
function store(nodeId, rec) {
  try {
    if (!droppedV1) {
      // the one-hemisphere placement replaced v1: its remembered layouts are dead weight
      droppedV1 = true;
      const old = JSON.parse(localStorage.getItem('mw.silhouettes.v1') || '[]');
      if (Array.isArray(old)) for (const id of old) localStorage.removeItem('mw.silhouettes.v1:' + id);
      localStorage.removeItem('mw.silhouettes.v1');
    }
    let idx = JSON.parse(localStorage.getItem(STORE_IDX) || '[]');
    if (!Array.isArray(idx)) idx = [];
    idx = idx.filter((x) => x !== nodeId);
    idx.push(nodeId);
    while (idx.length > STORE_MAX) localStorage.removeItem(STORE + idx.shift());
    localStorage.setItem(STORE + nodeId, JSON.stringify(rec));
    localStorage.setItem(STORE_IDX, JSON.stringify(idx));
  } catch (e) { /* private mode / storage full: the layout is just recomputed next time */ }
}

const isRoot = (node) => !node || node.depth === 0 || node.id === 'world';

function sharesOf(kids, arch, root) {
  const n = kids.length;
  const raw = kids.map((c) => (c.now && c.now.dv20 > 0 ? +c.now.dv20 : null));
  const known = raw.filter((v) => v != null).sort((a, b) => a - b);
  const med = known.length ? known[known.length >> 1] : 1;
  // ∝ sqrt(dv20); the root's six continents are compressed harder (dv20^0.4) so all of them fit on the face
  const pw = root ? 0.4 : 0.5;
  const w = raw.map((v) => Math.pow(Math.max(1e-6, v != null ? v : med * 0.5), pw));
  let share = w.map((x) => x / (w.reduce((a, b) => a + b, 0) || 1));
  if (n > 1) {
    const floor = (arch ? 0.24 : 0.3) / n, cap = Math.max(root ? 0.22 : 0.3, 1.15 / n);
    for (let p = 0; p < 8; p++) { share = share.map((s) => Math.min(cap, Math.max(floor, s))); const s = share.reduce((a, b) => a + b, 0); share = share.map((x) => x / s); }
  } else share = [1];
  return share.map((s) => Math.round(s * 150) / 150 || 1 / 300); // stable to small daily changes
}

/** The node's own place (its hinted coast) and — on a geographic map (海外股市 / 全球 trees) — its region. */
function placeOf(lib, node) {
  const h = hintFor(node);
  if (!h) return { sh: null, reg: null };
  const sh = h.ids.map((x) => lib.byId.get(x)).find(Boolean) || null;
  const geoTree = /^(intl|gl-)/.test(String((node && node.id) || ''));
  const reg = sh && geoTree && h.region !== null ? h.region || sh.reg : null;
  return { sh, reg };
}

/**
 * Choose and assign silhouettes: geography hints first (never swapped), then biggest child → biggest silhouette.
 * One planet never shows a place twice (Eurasia beside China, North America beside the USA, Honshu beside Japan),
 * nor a coast that swallows the planet's own place (no North America inside the 美股 planet); under a geographic
 * planet the others come from its region (欧洲 → European islands), never a continent from elsewhere.
 */
function assignShapes(lib, node, kids, share, arch, opts, A) {
  const n = kids.length;
  const out = new Array(n).fill(null);
  const taken = [];
  const clash = (s) => taken.some((t) => overlaps(s, t));
  const { sh: P, reg: preg } = placeOf(lib, node);
  // a coast that contains the planet's own place and is bigger than it (Eurasia on the 中国 planet)
  const swallows = (s) => !!P && s.id !== P.id && s.has.has(P.id) && s.sr > P.sr * 1.5;
  // rank: half-octave size tiers, then a stable hash (a child keeps its coast unless its size really changes)
  const tier = (s) => Math.round(Math.log2(s) * 2);
  const order = kids.map((_, i) => i).sort((a, b) => tier(share[b]) - tier(share[a]) || hashStr(String(kids[a].id)) - hashStr(String(kids[b].id)));
  // a long thin coast (Crete, Cuba, Java…) at a big territory's size would be wider than EXT_MAX and shrink far below
  // its share: freely handed-out coasts must (nearly) fit at their target size (a hinted coast is shrunk instead)
  const kExt = 4 * Math.sin(EXT_MAX / 4);
  const fits = (i, s) => Math.sqrt(A[i] / Math.PI) * s.diam <= kExt * 1.15;
  // first choices first (中国 → China before 大中华 settles for Eurasia), then second choices
  if (!arch) {
    const hints = kids.map(hintFor);
    for (let round = 0; round < 4; round++) for (const i of order) {
      if (out[i] || !hints[i]) continue;
      const s = lib.byId.get(hints[i].ids[round]);
      if (s && !clash(s) && !swallows(s)) { out[i] = s; taken.push(s); }
    }
  }
  const rest = order.filter((i) => !out[i]);
  if (!rest.length) return out;
  let pool = (arch ? lib.pools.arch : lib.pools.land).filter((s) => !HINT_ONLY.has(s.id) && !clash(s) && !swallows(s));
  if (preg) {
    // a geographic planet: its own region first (an archipelago: the nearest islands first), no foreign continent
    const pc = P ? dirOf(+P.c[0], +P.c[1]) : null;
    const dist = (s) => (pc ? ang(pc, dirOf(+s.c[0], +s.c[1])) : 0);
    const inR = (s) => (sameRegion(s.reg, preg) ? 0 : 1);
    pool = pool.filter((s) => s.kind !== 'continent' || !inR(s));
    pool.sort((a, b) => inR(a) - inR(b) || a.tier - b.tier || (arch ? dist(a) - dist(b) : b.sr - a.sr));
  }
  // no two free choices may be the same place either (Great Britain and the British Isles)
  const pickable = [];
  for (const s of pool) if (!pickable.some((t) => overlaps(s, t))) pickable.push(s);
  let avail = pickable;
  while (avail.length < rest.length) avail = avail.concat(pickable.length ? pickable : lib.pools.arch); // more children than shapes: reuse
  // variety below the top: inner planets pick from a slightly wider window at the front of the pool (seeded by the node)
  // (a geographic planet keeps the top of its region: Great Britain and Iceland, not the fifth-best islet)
  const extra = opts.variety === false || isRoot(node) || preg ? 0 : Math.min(6, Math.max(2, Math.round(rest.length * 0.6)));
  const win = avail.slice(0, Math.min(avail.length, rest.length + extra));
  const rnd = mulberry32(hashStr('sil:' + (node && node.id)));
  const chosen = [];
  const cand = win.map((s, k) => ({ s, w: 1 / (1 + 0.22 * k) }));
  while (chosen.length < rest.length && cand.length) {
    const tot = cand.reduce((a, c) => a + c.w, 0);
    let u = rnd() * tot, k = 0;
    while (k < cand.length - 1 && (u -= cand[k].w) > 0) k++;
    chosen.push(cand.splice(k, 1)[0].s);
  }
  // continents before islands, the most recognisable first, then by real size: the biggest child gets the biggest
  // silhouette that suits it (a long thin coast only goes to a territory small enough not to wrap the planet)
  chosen.sort((a, b) => a.tier - b.tier || b.sr - a.sr);
  const left = chosen.slice();
  const used = new Set([...taken.map((t) => t.id), ...chosen.map((s) => s.id)]);
  for (const i of rest) {
    let k = left.findIndex((s) => fits(i, s));
    if (k < 0) {
      const alt = avail.find((s) => !used.has(s.id) && fits(i, s));
      if (alt) { used.add(alt.id); out[i] = alt; continue; }
      k = 0;
    }
    out[i] = left.splice(k, 1)[0];
  }
  return out;
}

/**
 * Today's ①②③ and the 主航道's two ends (opts.focus when the shell passes them), most important first (≤ 5). On the
 * root the shell lights the continents that hold brief.json's (deep) spotlights and draws brief.channel, so those
 * come first when the brief is at hand.
 */
function focusOf(node, kids, mapJson, opts, brief, W) {
  const ids = new Set(kids.map((c) => c.id));
  const out = [];
  const add = (x) => { const id = x && typeof x === 'object' ? x.id : x; if (id != null && ids.has(id) && !out.includes(id)) out.push(id); };
  if (Array.isArray(opts.focus)) { opts.focus.forEach(add); return out.slice(0, 5); }
  if (brief && Array.isArray(brief.spotlight)) {
    for (const s of brief.spotlight) {
      if (out.length >= 3) break;
      const p = Array.isArray(s && s.pathIds) ? s.pathIds : [];
      add(ids.has(s && s.id) ? s.id : p.find((x) => ids.has(x)));
    }
  }
  if (W && mapJson && mapJson.children && kids.length > 1) {
    // (k = 6, the first three: exactly what the shell numbers)
    try { for (const p of W.attentionPicks(mapJson, kids, undefined, 6) || []) { if (out.length >= 3) break; add(p.id); } } catch (e) { /* no picks */ }
    let ch = brief && brief.channel && (ids.has(brief.channel.from) || ids.has(brief.channel.to)) ? brief.channel : null;
    if (!ch) try { ch = W.mainChannel(mapJson, kids, undefined); } catch (e) { ch = null; }
    // no two-ended channel: the shell rings the one end the headline names (words.regionWeather's story)
    if (!ch) try { const st = W.regionWeather(mapJson, node, kids, undefined).story; if (st) ch = { from: st.src, to: st.dst }; } catch (e) { ch = null; }
    if (ch) { add(ch.to); add(ch.from); }
  }
  return out.slice(0, 5);
}

const briefP = new Map();
let wordsP = null;
/** brief.json of the map on screen (root only; the browser page's data/ folder), or null. */
function briefFor(node, opts) {
  if (!isRoot(node) || Array.isArray(opts.focus) || typeof document === 'undefined' || typeof fetch !== 'function') return Promise.resolve(null);
  const dir = opts.map === 'full' ? 'data/fm/' : opts.map === 'global' ? 'data/gl/' : 'data/';
  let url;
  try { url = new URL(dir + 'brief.json', document.baseURI).href; } catch (e) { return Promise.resolve(null); }
  if (!briefP.has(url)) briefP.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return briefP.get(url);
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function computeLayout(lib, node, kids, mapJson, opts, brief, W) {
  const d3 = globalThis.d3;
  const n = kids.length;
  const out = [];
  const front = Array.isArray(opts.front) ? opts.front.slice(0, 2) : FRONT.slice();
  out.front = front;
  out.mode = 'abstract';
  out.view = { lon: front[0], lat: front[1], scale: 1 };
  if (!n) return out;
  const arch = kids.every(isStockNode);
  const root = isRoot(node);
  const share = sharesOf(kids, arch, root);
  // the land, all of it on the face you see: ~10 % of the sphere ≈ 30–34 % of the disc the camera shows (it aims at
  // the land); every stock of an archipelago stays island-sized
  // (a big archipelago a little less again: 40–60 islands need their straits too)
  // (the root's continents are the biggest shapes and the camera centres on them: a touch less again)
  const land = opts.land || (n === 1 ? 0.06 : n === 2 ? 0.08 : n === 3 ? 0.09 : arch ? 0.095 - 0.02 * Math.max(0, Math.min(1, (n - 16) / 24)) : n <= 6 ? 0.095 : 0.105) * (root ? 0.93 : 1);
  const focusIds = focusOf(node, kids, mapJson, opts, brief, W);
  const { A: aff, key: affKey } = affinities(kids, mapJson);
  const key = ALGO + '|' + (node && node.id) + '|' + kids.map((c, i) => c.id + ':' + share[i]).join(',') + '|' + land + '|' + affKey + '|' + front + '|' + (opts.variety === false ? 0 : 1) + '|' + focusIds.join(',');
  if (layoutCache.has(key)) return layoutCache.get(key);

  const t00 = clock();
  const A = share.map((s) => s * land * 4 * Math.PI); // target area (sr)
  const sig = hashStr(key + '|' + lib.sig).toString(36);
  const rec = node && node.id != null && opts.cache !== false ? stored(node.id, sig) : null;
  const shapes = rec && rec.p.length === n && rec.p.every((q) => lib.byId.has(q[0])) ? rec.p.map((q) => lib.byId.get(q[0])) : assignShapes(lib, node, kids, share, arch, opts, A);
  const K = A.map((a) => Math.sqrt(a / Math.PI)); // normalised coords → LAEA units
  // no silhouette wider than EXT_MAX of arc: a long coast (Japan, Chile, Norway…) is shrunk, never swapped
  const kExt = 4 * Math.sin(EXT_MAX / 4);
  for (let i = 0; i < n; i++) { const km = kExt / Math.max(0.5, shapes[i].diam); if (K[i] > km) { K[i] = km; A[i] = Math.PI * km * km; } }
  const req = K.map((k) => angOfRho(k)); // equivalent angular radius
  const radAt = (i, a) => angOfRho(K[i] * extAt(shapes[i], a));
  const radMax = (i) => angOfRho(K[i] * shapes[i].emax);
  const seed = hashStr('silhouettes:' + (node && node.id));
  const rnd = mulberry32(seed);
  // straits: proportional to the two coasts, narrower between money-related siblings
  const gap0 = arch ? 0.03 : 0.05, gapK = (opts.ocean || 1) * (arch ? 0.22 : 0.26);
  const gapOf = (i, j) => (gap0 + gapK * (req[i] + req[j])) * (1.25 - 0.8 * aff[i][j]) * (0.9 + 0.2 * ((hashStr(kids[i].id + '~' + kids[j].id) % 1000) / 1000));
  // the face: every centre within CAP_C of the front, every coast within CAP_E, today's ①②③ within CAP_F
  const O = dirOf(front[0], front[1]);
  const isF = new Uint8Array(n), fRank = new Int8Array(n).fill(-1);
  focusIds.forEach((id, r) => { const i = kids.findIndex((c) => c.id === id); if (i >= 0) { isF[i] = 1; fRank[i] = r; } });
  /** > 1 when landmass i centred at c leaves the face (its centre or its coast); capOut: also a focus off the middle
   *  (a preference: four big continents cannot all sit within 35°). */
  const faceOut = (i, c) => { const d = ang(c, O); return Math.max(d / CAP_C, (d + radMax(i)) / CAP_E); };
  const capOut = (i, c) => Math.max(faceOut(i, c), isF[i] ? ang(c, O) / CAP_F : 0);
  const C = new Array(n), fr = new Array(n);
  // focus first (①, ②, ③, the 主航道's ends), then biggest first
  const order = kids.map((_, i) => i).sort((a, b) => isF[b] - isF[a] || (isF[a] ? fRank[a] - fRank[b] : 0) || A[b] - A[a] || hashStr(String(kids[a].id)) - hashStr(String(kids[b].id)));

  let exactBad = 0, narrowLeft = 0;
  const prof = {};
  const restored = !!rec && rec.p.length === n && shapes.every((sh, i) => sh && sh.id === rec.p[i][0]);
  if (restored) {
    rec.p.forEach((q, i) => { K[i] = q[1]; A[i] = Math.PI * q[1] * q[1]; C[i] = norm([q[2], q[3], q[4]]); fr[i] = frame(C[i]); });
    exactBad = rec.bad || 0;
  } else {
    const tG = clock();
    // the real coasts as samples on the sphere + an exact coast-to-coast check (used by every step below)
    const STRAIT = opts.strait || 0.3;
    // the hard minimum: open sea the coast foam cannot close; the compaction stops at half the nominal strait
    const sepOf = (i, j) => Math.max(MIN_STRAIT, 0.12 * Math.min(req[i], req[j]), gapOf(i, j) * STRAIT);
    const cgapOf = (i, j) => Math.max(sepOf(i, j), gapOf(i, j) * 0.5);
    // coast samples on the sphere, thinned for small landmasses but always finer than half the narrowest strait
    let minSep = Infinity;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) minSep = Math.min(minSep, sepOf(i, j));
    const spacing = Math.max(0.0025, Math.min(n > 24 ? 0.011 : 0.008, minSep * 0.45));
    const stride = shapes.map((sh, i) => Math.max(1, Math.floor(spacing / Math.max(1e-6, sh.sp * K[i]))));
    const ptsAt = (i, c, f) => {
      const s = shapes[i].samp, k = K[i], o = [];
      for (let q = 0; q < s.length; q += 2 * stride[i]) o.push(invLaea(c, f[0], f[1], s[q] * k, s[q + 1] * k));
      return o;
    };
    const insideAt = (j, p) => { const [x, y] = laea(C[j], fr[j][0], fr[j][1], p); return insideShape(shapes[j], x / K[j], y / K[j]); };
    const insideOf = (c, f, j, p) => { const [x, y] = laea(c, f[0], f[1], p); return insideShape(shapes[j], x / K[j], y / K[j]); };
    const PT = new Array(n);
    const coreAt = (i, c, f) => invLaea(c, f[0], f[1], shapes[i].core[0] * K[i], shapes[i].core[1] * K[i]);
    /** Coast-to-coast check of i (at c, f, samples pi) against j: {minD, overl} (overl = samples inside the other). */
    const pairCheck = (i, c, f, pi, j, g, depth) => {
      const ri = radMax(i), rj = radMax(j);
      if (ang(c, C[j]) >= ri + rj + g) return null;
      const ci = Math.cos(Math.min(Math.PI, rj + g * 1.2)), cj = Math.cos(Math.min(Math.PI, ri + g * 1.2));
      let mx = -1;
      const Pi = pi.filter((p) => dot(p, C[j]) > ci), Pj = PT[j].filter((p) => dot(p, c) > cj);
      for (const a of Pi) for (const b of Pj) { const dd = dot(a, b); if (dd > mx) mx = dd; }
      const minD = Pi.length && Pj.length ? Math.acos(Math.min(1, mx)) : Infinity;
      let overl = 0;
      if (minD < g && depth) {
        for (const a of Pi) if (insideAt(j, a)) overl++;
        for (const b of Pj) if (insideOf(c, f, i, b)) overl++;
      }
      // a landmass swallowed whole shows by its core (a point well inside it — a crescent's centroid may be at sea)
      if (!overl && (insideAt(j, coreAt(i, c, f)) || insideOf(c, f, i, coreAt(j, C[j], fr[j])))) overl = 1;
      return { minD, overl, n: Pi.length + Pj.length };
    };

    // 1. greedy, focus first then biggest: the first one in the middle of the face, each next one against the coast
    //    of a landmass already placed, a strait away, where it stays most central and closest to its relatives
    const phi0 = rnd() * TAU;
    const placed = [];
    const needFrom = (i, ci, fi, m) => radAt(i, bearing(ci, fi, C[m])) + radAt(m, bearing(C[m], fr[m], ci)) + gapOf(i, m);
    /** The best free spot for i against the coasts of `others`: beside one of them (the most central ones, i's closest
     *  relatives, + `extra` anchors), a strait away, on the face, as central as possible and close to its relatives. */
    const spotFor = (i, others, extra, all) => {
      const byC = others.slice().sort((a, b) => ang(C[a], O) - ang(C[b], O)).slice(0, 7);
      const byR = others.filter((m) => aff[i][m] > 0).sort((a, b) => aff[i][b] - aff[i][a]).slice(0, 3);
      const anchors = [...new Set([...byC, ...byR, ...extra])];
      let best = null, bestS = Infinity;
      const cands = all ? [] : null;
      for (const j of anchors) {
        for (let t = 0; t < 28; t++) {
          const th = phi0 + (t * TAU) / 28 + (hashStr(kids[j].id) % 100) * 0.01;
          const dist = radAt(j, th) + radAt(i, th + Math.PI) + gapOf(i, j) * 1.02;
          const ci = expMap(C[j], fr[j][0], fr[j][1], Math.cos(th) * dist, Math.sin(th) * dist);
          const fi = frame(ci);
          let pen = 0;
          for (const m of others) {
            if (m === j) continue;
            const d = ang(ci, C[m]);
            if (d > radMax(i) + radMax(m) + gapOf(i, m)) continue;
            const need = needFrom(i, ci, fi, m);
            if (d < need) pen += 4 + (need - d) * 20;
          }
          if (pen >= bestS && !cands) continue;
          // on the face (the focus in its middle), central, near relatives
          const e = capOut(i, ci);
          pen += ang(ci, O) * (isF[i] ? 2 : 1) + Math.max(0, e - 1) * 8;
          for (const m of others) if (aff[i][m] > 0) pen += aff[i][m] * 0.25 * Math.min(1.5, ang(ci, C[m]));
          if (cands) cands.push([pen, ci]);
          if (pen < bestS) { bestS = pen; best = ci; }
        }
      }
      if (cands) return cands.sort((a, b) => a[0] - b[0]).map((c) => c[1]);
      // nothing free next to the usual anchors: look around every landmass (the open frontier)
      if (bestS >= 4 && extra !== others && others.length > anchors.length) return spotFor(i, others, others, false);
      return best;
    };
    for (const i of order) {
      if (!placed.length) {
        const off = n > 1 ? Math.min(0.1, req[i] * 0.3) : 0;
        const [e, nn] = frame(O);
        C[i] = expMap(O, e, nn, Math.cos(phi0) * off, Math.sin(phi0) * off);
        fr[i] = frame(C[i]);
        PT[i] = ptsAt(i, C[i], fr[i]);
        placed.push(i);
        continue;
      }
      // the best candidate whose real coast keeps every strait open (else the least bad one)
      const clearAt = (c) => {
        const fc = frame(c), pc = ptsAt(i, c, fc);
        for (const j of placed) { const r = pairCheck(i, c, fc, pc, j, sepOf(i, j), false); if (r && (r.overl || r.minD < sepOf(i, j))) return null; }
        return [fc, pc];
      };
      let best = null, got = null;
      for (const pass of [0, 1]) {
        // on the face first (a spot off it only when there is no other)
        const all = spotFor(i, placed, pass ? placed : n > 24 ? placed.slice(-4) : [], true);
        const list = all.filter((c) => faceOut(i, c) <= 1).concat(all.filter((c) => faceOut(i, c) > 1));
        for (const c of list.slice(0, pass ? 80 : 24)) { got = clearAt(c); if (got) { best = c; break; } }
        if (best) break;
        if (pass) best = list[0];
      }
      C[i] = best;
      fr[i] = got ? got[0] : frame(best);
      PT[i] = got ? got[1] : ptsAt(i, best, fr[i]);
      placed.push(i);
    }

    // 2. on the real coasts. (a) open every strait (pairwise pushes, applied together); (b) pull the landmasses toward
    //    the front one small step at a time, focus and bigger ones first, a step being taken only if no coast comes
    //    closer than half its strait (coasts nest into each other's bays, as on Earth, but the sea between them stays
    //    open and nothing ever jams or overlaps); (c) check once more.
    const scale = new Float64Array(n).fill(1); // last resort: a landmass that cannot be freed shrinks a little
    const Amax = Math.max(...A);
    /** Pairwise separation passes; with `pull`, every pass first pulls everyone toward the front (a force
     *  simulation that lets landmasses squeeze past each other), without it, it stops as soon as the straits are open. */
    const stuckN = new Int16Array(n), moves = new Int16Array(n);
    const cleanup = (maxIt, shrink, pull) => {
      let hard = 0;
      stuckN.fill(0);
      for (let it = 0; it < maxIt && n > 1; it++) {
        if (pull) {
          const cool = 1 - it / maxIt;
          for (let i = 0; i < n; i++) {
            const d = ang(C[i], O);
            if (d < 1e-3) continue;
            const e = capOut(i, C[i]);
            const w = 0.25 + 0.75 * (A[i] / Amax);
            pushAway(C[i], O, -Math.min(0.02, (e > 1 ? (1 - 1 / e) * d * 0.2 : 0) + d * 0.035 * (0.3 + 0.7 * cool) * w));
            fr[i] = frame(C[i]);
            PT[i] = ptsAt(i, C[i], fr[i]);
          }
        }
        let bad = 0, worst = 1;
        hard = 0;
        const D = C.map(() => [0, 0, 0]); // accumulated moves (applied together: no ping-pong between neighbours)
        const stuck = [];
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const g = sepOf(i, j);
          const r = pairCheck(i, C[i], fr[i], PT[i], j, g, !pull); // squeezing: no depth counting (cheap)
          if (!r || (!r.overl && r.minD >= g * 0.92)) continue;
          bad++;
          if (!r.overl) worst = Math.min(worst, r.minD / g);
          if (r.overl) { hard++; stuck.push([i, j]); }
          const depth = r.overl ? Math.min(0.25, (r.overl / Math.max(1, r.n)) * (req[i] + req[j]) * 0.6) : 0;
          const push = (r.overl ? g + depth + 0.006 : g - r.minD + 0.002) * 0.55;
          // the bigger one barely moves (today's ①②③ count triple: they keep their place in the middle)
          const ai = A[i] * (isF[i] ? 3 : 1), aj = A[j] * (isF[j] ? 3 : 1);
          const wi = (aj * aj) / (ai * ai + aj * aj);
          const cd = dot(C[i], C[j]);
          const t = [C[i][0] - C[j][0] * cd, C[i][1] - C[j][1] * cd, C[i][2] - C[j][2] * cd];
          const tl = Math.hypot(t[0], t[1], t[2]) || 1;
          for (let q = 0; q < 3; q++) { D[i][q] += (t[q] / tl) * push * wi; D[j][q] -= (t[q] / tl) * push * (1 - wi); }
        }
        if (!pull && (!bad || (!hard && (worst > 0.9 || it > 12) && it > 2))) return 0; // only near-wide-enough straits left
        for (let i = 0; i < n; i++) {
          const L = Math.hypot(D[i][0], D[i][1], D[i][2]);
          if (L < 1e-9) continue;
          const m = Math.min(L, 0.1);
          for (let q = 0; q < 3; q++) C[i][q] += (D[i][q] / L) * Math.tan(m);
          norm(C[i]);
          fr[i] = frame(C[i]);
          PT[i] = ptsAt(i, C[i], fr[i]);
        }
        if (shrink && hard) {
          // wedged between neighbours (pushes from both sides cancel)? move the smaller one to a free spot
          for (const [i, j] of stuck) { const k = A[i] < A[j] ? i : j; stuckN[k]++; }
          for (let k = 0; k < n; k++) {
            if (stuckN[k] < 6 || moves[k] >= 2) continue;
            const c = spotFor(k, C.map((_, m) => m).filter((m) => m !== k), []);
            if (c) { C[k] = c; fr[k] = frame(c); PT[k] = ptsAt(k, c, fr[k]); moves[k]++; stuckN[k] = 0; }
          }
          if (it >= maxIt * 0.6) for (const [i, j] of stuck) {
            const k = A[i] < A[j] ? i : j;
            if (scale[k] > 0.7) { scale[k] *= 0.93; K[k] *= 0.93; A[k] *= 0.93 * 0.93; PT[k] = ptsAt(k, C[k], fr[k]); }
          }
        }
      }
      return hard;
    };
    if (n > 1) {
      let t = clock();
      prof.greedy = Math.round(t - tG);
      const lap = (k) => { const t2 = clock(); prof[k] = Math.round(t2 - t); t = t2; };
      cleanup(24, true); lap('open');
      if (n <= 24 && opts.squeeze) { // optional: a force squeeze first (slower, rarely tighter)
        cleanup(28, false, true); lap('squeeze'); // squeeze together (temporary overlaps allowed)…
        cleanup(30, true); lap('reopen'); // …open every strait again
      }
      // (b) safe compaction toward the front (focus first, then the biggest)
      const PULL = n > 24 ? 30 : 36;
      const ord = order.slice();
      const SLIDES = n > 24 ? [[0, 1], [0.6, 0.7], [-0.6, 0.7], [0, 0.4]] : [[0, 1], [0.5, 0.8], [-0.5, 0.8], [1.0, 0.6], [-1.0, 0.6], [0, 0.35], [1.4, 0.4], [-1.4, 0.4]];
      const rest = new Int16Array(n); // blocked last time: wait a few rounds before trying again
      for (let it = 0; it < PULL; it++) {
        const cool = 1 - it / PULL;
        let movedAny = 0;
        for (const i of ord) {
          const d = ang(C[i], O);
          if (d < 0.01) continue;
          if (rest[i] > 0) { rest[i]--; continue; }
          const e = capOut(i, C[i]);
          const w = 0.3 + 0.7 * Math.sqrt(A[i] / Amax) + (isF[i] ? 0.4 : 0);
          const step = Math.min(0.05, Math.max(0.004, d * (0.08 * cool + 0.02) * w + (e > 1 ? (1 - 1 / e) * d * 0.2 : 0)));
          // toward the front, else slide a little to either side of the obstacle
          const bO = bearing(C[i], fr[i], O);
          let ok = false;
          for (const [db, f] of SLIDES) {
            const st = step * f;
            const c = expMap(C[i], fr[i][0], fr[i][1], Math.cos(bO + db) * st, Math.sin(bO + db) * st);
            if (ang(c, O) >= d) continue;
            const fc = frame(c);
            const pc = ptsAt(i, c, fc);
            let clear = true;
            for (let j = 0; j < n && clear; j++) {
              if (j === i) continue;
              const g = cgapOf(i, j);
              const r = pairCheck(i, c, fc, pc, j, g, false);
              if (r && (r.overl || r.minD < g)) clear = false;
            }
            if (clear) { C[i] = c; fr[i] = fc; PT[i] = pc; ok = true; break; }
          }
          if (ok) movedAny++;
          else rest[i] = 3;
        }
        if (!movedAny && it > 4) break;
      }
      lap('compact');
      cleanup(50, true); lap('final');
      // the truth: pairs whose coasts actually cross (a sample of one inside the other's land), and landmasses that
      // left the face; the smaller one of a crossing pair / the one off the face moves to a free spot on the face
      const offFace = (k) => faceOut(k, C[k]) > 1.005;
      const crossing = () => {
        const bad = [];
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const g = sepOf(i, j), r = pairCheck(i, C[i], fr[i], PT[i], j, g, true);
          // coasts that cross, or a strait the coast foam would close: the smaller one moves (else the bigger)
          const hard = !!r && r.overl > 0 && r.minD < g;
          if (r && (hard || r.minD < g * 0.8)) bad.push({ k: A[i] < A[j] ? i : j, o: A[i] < A[j] ? j : i, hard });
        }
        for (let k = 0; k < n; k++) if (offFace(k)) bad.push({ k, o: -1, hard: false });
        return bad;
      };
      // every free point of the face, nearest the front first (a Fibonacci net over the CAP_C cap)
      const NET = [];
      {
        const [e0, n0] = frame(O), NN = 420;
        for (let q = 0; q < NN; q++) {
          const t = (q + 0.5) / NN, th = Math.acos(1 - t * (1 - Math.cos(CAP_C))), ph = q * 2.39996323 + phi0;
          NET.push(expMap(O, e0, n0, Math.cos(ph) * th, Math.sin(ph) * th));
        }
      }
      const tryAt = (k, others, c) => {
        if (faceOut(k, c) > 1) return false;
        for (const j of others) if (ang(c, C[j]) < (req[k] + req[j]) * 0.7) return false; // surely on top of j
        const fc = frame(c), pc = ptsAt(k, c, fc);
        for (const j of others) { const r = pairCheck(k, c, fc, pc, j, sepOf(k, j), false); if (r && (r.overl || r.minD < sepOf(k, j) * 0.9)) return false; }
        C[k] = c; fr[k] = fc; PT[k] = pc;
        return true;
      };
      /** The best spot on the face whose real coast keeps every strait open: beside a coast, else anywhere free. */
      const relocate = (k) => {
        const others = C.map((_, m) => m).filter((m) => m !== k);
        for (const c of spotFor(k, others, others, true).slice(0, 80)) if (tryAt(k, others, c)) return true;
        for (const c of NET) if (tryAt(k, others, c)) return true;
        return false;
      };
      let bad = crossing();
      for (let round = 0; round < 4 && bad.length; round++) {
        const moved = new Set();
        for (const b of bad) {
          if (moved.has(b.k) || (b.o >= 0 && moved.has(b.o))) continue; // that pair already changed
          // (today's ①②③ stay where they are when the other one can move instead)
          const [p, q] = b.o >= 0 && isF[b.k] && !isF[b.o] ? [b.o, b.k] : [b.k, b.o];
          if (relocate(p)) moved.add(p);
          else if (q >= 0 && relocate(q)) moved.add(q);
        }
        bad = crossing();
        // still no room on the face: the stragglers shrink a little and try again
        if (bad.length && round < 3) for (const k of new Set(bad.map((b) => b.k))) if (scale[k] > 0.6) { scale[k] *= 0.88; K[k] *= 0.88; A[k] *= 0.88 * 0.88; PT[k] = ptsAt(k, C[k], fr[k]); }
      }
      exactBad = bad.filter((b) => b.hard).length;
      narrowLeft = bad.filter((b) => !b.hard && b.o >= 0).length;
      lap('fix');
    }
  }

  // 3. rings on the sphere (d3 winding: coast clockwise, lakes counter-clockwise; each smaller than a hemisphere)
  for (let i = 0; i < n; i++) {
    const sh = shapes[i], [e, nn] = fr[i], k = K[i];
    const rings = sh.rings.map((ring, ri) => {
      const ll = ring.map(([x, y]) => lonLatOf(invLaea(C[i], e, nn, x * k, y * k)));
      ll.reverse(); // library rings: coast ccw (x east, y north) → d3 clockwise; lakes the other way round
      ll.push(ll[0].slice());
      if (d3 && !sh.hole[ri] && d3.geoArea({ type: 'Polygon', coordinates: [ll] }) > TAU) ll.reverse();
      return ll;
    });
    let area = A[i];
    if (d3) {
      area = 0;
      rings.forEach((rg, ri) => { const a = d3.geoArea({ type: 'Polygon', coordinates: [rg] }); area += (sh.hole[ri] ? -1 : 1) * Math.min(a, 4 * Math.PI - a); });
    }
    out.push({ id: kids[i].id, kind: 'land', rings, center: lonLatOf(C[i]), area, shape: sh.id, shapeName: sh.name, shapeZh: sh.zh });
  }
  const tookMs = clock() - t00;
  if (!restored && tookMs > 40 && node && node.id != null && opts.cache !== false) {
    store(node.id, { sig, bad: exactBad, p: shapes.map((sh, i) => [sh.id, +K[i].toFixed(6), +C[i][0].toFixed(6), +C[i][1].toFixed(6), +C[i][2].toFixed(6)]) });
  }
  // the camera opens on today's ①②③ and the land around them
  const m = [0, 0, 0];
  const nf = isF.reduce((a, b) => a + b, 0);
  const landNow = A.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < n; i++) {
    const wt = A[i] / landNow + (isF[i] ? (fRank[i] < 3 ? 1.2 : 0.6) / Math.max(1, nf) : 0);
    for (let a = 0; a < 3; a++) m[a] += C[i][a] * wt;
  }
  const ml = Math.hypot(m[0], m[1], m[2]);
  if (ml > 0.15) {
    // at most half way from O (the land was laid out around it), and never so far that a coast leaves the face
    const far = (f) => Math.max(...C.map((c) => ang(c, f)));
    const lim = Math.max(CAP_C, far(O)) + 0.01;
    for (const t of [1, 0.6, 0.3, 0]) {
      const f = norm([O[0] + (t * m[0]) / ml, O[1] + (t * m[1]) / ml, O[2] + (t * m[2]) / ml]);
      if (t > 0 && far(f) > lim) continue;
      const ll = lonLatOf(f);
      out.front = [Math.round(ll[0] * 100) / 100, Math.round(ll[1] * 100) / 100];
      out.view = { lon: out.front[0], lat: out.front[1], scale: 1 };
      break;
    }
  }
  const F = dirOf(out.front[0], out.front[1]);
  out.stats = {
    land: out.reduce((a, it) => a + it.area, 0) / (4 * Math.PI), overlapsLeft: exactBad, narrowLeft, arch, restored, ms: prof,
    hidden: C.filter((c) => ang(c, F) > CAP_C).length, focus: focusIds,
    shrunk: shapes.map((sh, i) => (K[i] < Math.sqrt((share[i] * land * 4 * Math.PI) / Math.PI) * 0.97 ? sh.id : null)).filter(Boolean),
  };
  layoutCache.set(key, out);
  if (layoutCache.size > 40) layoutCache.delete(layoutCache.keys().next().value);
  return out;
}

let islandsP = null;
async function fallback(node, kids, mapJson, opts, why) {
  console.info('[geo] 真实轮廓库不可用，用抽象群岛：', why && (why.message || why));
  islandsP ||= import('./islands.js');
  const m = await islandsP;
  const out = await m.getLayout(node, kids, mapJson, opts);
  out.view = { lon: (out.front || FRONT)[0], lat: (out.front || FRONT)[1], scale: 1 };
  out.fallback = 'islands';
  return out;
}

/** §25 array form (drop-in for islands.js): [{id, kind, rings, center, area, shape…}] with .front/.mode/.view. */
export async function silhouetteLayout(node, childNodes, mapJson, opts = {}) {
  const kids = (childNodes || (node && node.children) || []).filter((c) => c && c.id != null);
  let lib;
  try { lib = await loadSilhouettes(); } catch (e) { return fallback(node, kids, mapJson, opts, e); }
  const brief = await briefFor(node, opts).catch(() => null);
  // words.js (the attention formulas the shell uses) — optional: without it the layout simply has no focus
  const W = Array.isArray(opts.focus) ? null : await (wordsP ||= import('../words.js').catch(() => null));
  try { return computeLayout(lib, node, kids, mapJson, opts, brief, W); } catch (e) { console.warn('[geo] silhouettes', e); return fallback(node, kids, mapJson, opts, e); }
}

/** §26 contract: {view:{lon,lat,scale}, items:[{id, kind:'land', rings, center, area}], front, mode:'abstract'}. */
export async function getLayout(node, childNodes, mapJson, opts = {}) {
  const arr = await silhouetteLayout(node, childNodes, mapJson, opts);
  return { view: arr.view, items: arr.slice(), front: arr.front, mode: 'abstract', stats: arr.stats, fallback: arr.fallback };
}

export default getLayout;
