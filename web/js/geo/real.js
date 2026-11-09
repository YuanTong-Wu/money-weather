// geo/real.js — 地图：真实 (DESIGN §26 A + amendments 1–4). One real Earth, Google-Earth style: every node is a camera
// view of the same globe, companies sit at their real headquarters, a sector is "where its companies actually are",
// and money that is not a company (债券, 现金, 加密 ETFs, 商品, country / region funds) sits where it really ends up
// (web/data/geo/anchors.json: US Treasury → Washington, yen → Tokyo, oil → Permian / Gulf Coast / Persian Gulf …).
// Amendment 4: every territory outline is a REAL administrative border — a dissolved union of admin units owned by
// the child with the most money in them. No discs, no pie wedges, no Voronoi.
//
//   getLayout(node, childNodes, mapJson, opts) → Promise<{view, items, context, mode:'real', detail, front, lod, focus}>
//   opts: {map:'curated'|'full'|'global', parent, tree, detail:'50m'|'10m' (force), zoom (camera zoom: re-ask for
//          the unit level of that zoom — same view, same items), at ([lon, lat] camera centre, with zoom ≥ 40: the
//          admin3 files are loaded only within ~5° of it — one layout per 4° cell; without it, all of them),
//          focus ([id | {id, via}]: the shell's ①②③)}
//
//   view    {lon, lat, scale, radius}  where the camera looks. scale = zoom (1 = the whole globe fits the viewport,
//                                      s ⇒ the visible half-width is ≈ asin(1/s)); radius = that half-width in degrees.
//                                      A child's view is ≥ 1.8× its parent's zoom, centred on where its money is, holding
//                                      the money hubs of the children that carry ≥ 75 % of it (AI 算力: the Bay Area AND
//                                      Boise, not only Santa Clara), and
//                                      widened (≤ 1.7×) / turned so today's ①②③ are in it (a whole-globe view:
//                                      ① ≤ 60°, ② ≤ 65°, ③ ≤ 72° from the centre when all three fit, else ① + ②;
//                                      layout.focus[].inView says which made it, childAt says where the rest are).
//   lod     {level, zoomMin, zoomMax, territories, ladder, near?}  the unit level these territories are made of and the camera
//           zoom range they are meant for. Each node has its own ladder (its default view's countries): level 1 admin1
//           (state / province / prefecture, with the counties other children dominate carved out) until the typical
//           admin2 unit of the countries in view is ≥ 15 px across on a 1440×900 screen — US county ×8, DE NUTS3 / GB local
//           authority / JP 市区町村 ×10 (the cap), IN district ×5.7, CN 地级市 / FR département ×3.63 (the floor) —
//           then 2 admin2 (county / 地级市 / 市区町村 / NUTS3 …); ≥ 40 → 3 admin3 (Bay Area cities, 区/县, wards …)
//           where it exists. lod.ladder lists the node's thresholds; levelForZoom(z, node, map) / ladderFor(node, map)
//           give them once the node's default layout ran. level 0 = the world maps' whole countries (no re-ask). When the
//           free camera leaves [zoomMin, zoomMax) (zoomMax null = no upper bound), call getLayout(…, {zoom}) again and
//           swap the territories in place (camera unchanged; territories=false: only points here, nothing to swap).
//           lod.near {lon, lat, cell:4} (level 3 asked with opts.at): re-ask when the camera centre moves > ~4° away.
//           (item.center / offscreen of a zoomed re-ask are still worked out against the node's default view: pick
//           the label part on screen yourself — metros[].at holds one point + name per unit.)
//   items   [{id, kind:'land'|'sea'|'point', rings, polygons, center, area, …}] — one per child, never on top of
//           each other. rings: [[[lon,lat],…],…] (degrees, d3 winding: exteriors clockwise, holes counter-clockwise,
//           holes listed after their exterior; closed; planar-safe — no ring jumps the antimeridian);
//           polygons: the same as GeoJSON MultiPolygon coordinates.
//     land  — shape:'units' — a sector / region: the dissolved union of the admin units it owns (Santa Clara County,
//             Harris County, 海淀区 …). A unit belongs to the child with the most money (dv) in it (ties → the bigger
//             child). At level 1 a state is the union of its admin2 units; a sparse state (money density < ¼ of the
//             view's average) shows only the counties its companies are in; a county where another child dominates
//             is carved out of its state for that child (≥ 0.15 % of the view's money; or, for a child whose own land
//             holds < 30 % of its money, its heaviest such county when that holds ≥ 4 % of its money). Units with
//             < 0.4 / 0.08 / 0.04 % (level 1 / 2 / 3) of the view's money stay neutral when
//             their owner has a bigger one (dots instead); ≤ 260 polygons per view; islets without money dropped.
//             Home ground (refine, 2026-10-28 critics): a child whose own land holds < 25 % of its money — or whose
//             money hub (≥ 10 %) sits in a unit someone else owns — gets that unit split one level down: the admin3
//             区 / city / ward it dominates there is cut out for it (北京 → 西城区 for A股 金融, Santa Clara County →
//             San Jose for 网络连接; units[].level 3 + carved). Stray leftovers (< 3 % of its money at < 1/20 of the
//             median density of its land: 清远 for 金融, 崇明, Dubbo) go neutral with a dot. A child still without
//             its home — own land < 25 % (or its hub ≥ 45 % of its money), the hub not on its land, the hub ≥ 1.5 × its
//             own land — is drawn at its money hub (kind 'point', shape 'ticks'), never as a far-away stand-in county
//             (日本 通信传媒 → 东京, not 那霸; 美股 网络安全 → 圣克拉拉, not Monmouth / Waterloo).
//             Fallback when a country has no unit data: admin2 → admin1 → the whole country (coloured only where
//             the money is dense enough, else dots) → (last resort, counted in debug) a small land-clipped patch.
//             Offshore anchors (North Sea fields) stay small sea marks (units entry {offshore:true}).
//             Or a real country shape (shape:'country': 美股 = USA, gl country nodes, 海外股市 = the rest of the world).
//             Extra: units [{id, level (0 country | 1 | 2 | 3 | -1 sea mark / patch), w (share of this child's
//             money), name (中文 if known), est?, carved?, offshore?}] (heaviest first, ≤ 120);
//             metros [{id, level, at, label, members:[{id, w, n}]}] — per owned unit, who else is there, for hover
//             ('海淀区 · AI 算力 · 也有 金融 3 家': members[0] is the owner, w = share of the unit's money, n = companies);
//             ticks [{lon, lat, r, w, label, unit, level, owner}] — dots where this child has money in a unit someone
//             else owns (or left neutral), at its own HQ, fanned when several share a spot (≤ 8 per child);
//             tiny (true when its biggest part is < ~10 px at the default view: ring it); countries [a2], parts,
//             sites [{t, lon, lat, city, cityZh, w, why?}] (heaviest first, ≤ 12), est (mostly estimated places),
//             hub [lon, lat] + hubLabel + hubCC + hubShare (the money-weighted heaviest metro, in view or not),
//             place (the anchor's label when one anchor holds most of it: 华盛顿), offscreen {lon, lat, label}
//             (< 20 % of its money in view, or its labelled part is off-screen: where the edge chip points,
//             '→ 新竹 台积电'), listedAt [lon, lat] + listed (only a listing venue drawn as one small place by its
//             parent — 港股 → 香港 — whose companies sit in another country), childAt {grandchildId: [lon, lat]} (the
//             money hub of each grandchild, plus the deeper ①②③ under it: '海外股市 › 印度' → 孟买).
//             center = the label anchor: on the visible part that holds the most of its money (a speck's money —
//             Manhattan's — counts for the part beside it; room for a name only breaks near-ties; a part under ~8 px
//             wins only with clearly more money), aimed at its money hub when that part holds or touches it.
//     point — a company (or a fund) at its place. center = at = the true HQ / the fund's heaviest anchor (renderers
//             fan out crowds in screen space), r = marker radius (deg), rings = [that small disc] (pickable),
//             city, cityZh, cc, est, units [{id, level, w:1}] + unitName (the admin unit it is in), cityGroup
//             {key, n, rank, label:'旧金山 ×7'}, anchors? [{label, why, w, lon, lat}] (a fund: where its money goes),
//             offscreen {lon, lat, label:'→ 北京'} when its place is off the view.
//             shape:'ticks' — a sector that owns no unit at this level (a minority everywhere): a point at its money
//             hub, with its ticks / hub / units:[] / sites like a land item.
//     sea   — only money that still has no place at all (no anchor): a small '未定位' sea area (geo/seas.js).
//   context {states?: true, admin1?: ['CN', …], units?: {level, files:['admin2/US.json', …], countries, carved?}}
//           faint borders: US states / provinces of the countries in view; the unit files this layout used (draw
//           every unit border of them faintly when zoomed — units with no money are neutral land).
//   detail  '50m' | '10m'              the coastline to draw neutral land with (10 m from zoom 2.6 on; the unit
//                                      files themselves are cut to the app's 10 m coast).
//   focus   [{id, via, rank, at, label, inView}]  today's ①②③ (+ the 主航道's ends) and where they are.
//
//   layout  'country' | 'units' | 'metro' (fallback) | 'seas'  how this level was drawn; source: which HQ file.
//   debug.units.stats  {level, ladder, sites, units, owned, carved, split, dust, a1, a2, a3, country, patch, noUnit,
//                       lazy, src:{units.json, pip, near}, polys, θ, homeless, deep (区 cut one level down), stray,
//                       demoted (drawn at their hub), ms}
//
// Other exports: configure({base, fetchJSON, hqPaths, anchorsPath, admin1Index, admin2Index, admin3Index, unitsPath,
// vendorGeo, unitDust, unitCarve, unitDense, unitCap}), onChange(fn) (fires when the real hq.json / anchors.json /
// unit data arrive: reason 'hq' | 'anchors' | 'units'), levelForZoom(zoom, node?, map?), ladderFor(node, map),
// hqOf(ticker), anchorsOf(ticker),
// hqStatus(), unitsStatus(), registerTree(tree, 'curated'|'full'|'global'), clearCache(), _internals (tests only).
//
// Data: web/data/geo/hq.json (geodata/README.md: ticker → [lon, lat, city, country, est, kind?, cat?] + sub / zh /
// hints / regions); while that file is missing, web/fixture-geo/hq.json. web/data/geo/anchors.json (anchors[ticker] /
// nodes[curated id] = [{id, lon, lat, label, w, why, est, offshore?}]). Both re-checked at most every 30 s while
// missing. Units: vendor/geo/admin{1,2,3}/index.json + files, data/geo/units.json (geodata/build_admin2.py; see the
// "admin units" section below). Geography: earth.js (countries-50m, planar-safe, cached) and
// vendor/geo/{countries,land}-10m.json for close-ups. Deterministic. Needs globals d3 (v7) + topojson.

import * as earth from './earth.js';
import { isoForNode, normA2, byA2, zhName, COUNTRIES as ISO_ROWS } from './iso.js';
import { placeSeas, seaHints, seaPrefer } from './seas.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------------ config + data
const WEB = new URL('../../', import.meta.url);
let cfg = {
  base: WEB.href,
  hqPaths: ['data/geo/hq.json', 'fixture-geo/hq.json'],
  anchorsPath: 'data/geo/anchors.json',
  admin1Index: 'vendor/geo/admin1/index.json',
  admin2Index: 'vendor/geo/admin2/index.json',
  admin3Index: 'vendor/geo/admin3/index.json',
  unitsPath: 'data/geo/units.json',
  vendorGeo: 'vendor/geo/',
  briefPath: { curated: 'data/brief.json', full: 'data/fm/brief.json', global: 'data/gl/brief.json' },
  // unit layout tunables (§26 amendment 4): a unit holding less than dust[level] of the view's money stays neutral
  // (dots) when its owner has a bigger one; at level 1 a county where another child dominates is carved out of its
  // state when it holds ≥ carve of the view's money (or its child's own land holds < 30 % of its money); a state /
  // fallback province or country less dense than dense × the view's average is split / left neutral; ≤ cap polygons
  unitDust: { 1: 0.004, 2: 0.0008, 3: 0.0004 }, unitCarve: 0.0015, unitCap: 260, unitDense: 0.25,
  fetchJSON: async (url) => {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('real: ' + r.status + ' ' + url);
    return r.json();
  },
  now: () => (globalThis.performance || Date).now(),
};
/** Override loading (Node tests): {base, fetchJSON, hqPaths, anchorsPath}. Clears every cache. */
export function configure(o = {}) {
  cfg = Object.assign({}, cfg, o);
  clearCache(true);
}

const listeners = new Set();
/** fn({reason:'hq'|'anchors'}) when the real hq.json / anchors.json arrive (layouts are re-computed on the next call). */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(reason) { for (const fn of listeners) { try { fn({ reason }); } catch (e) { console.warn('[real]', e); } } }

let HQ = null;           // {map: Map(ticker → entry | NG), src, version}
let hqP = null;
let hqCheckAt = 0;
const NG = Object.freeze({ ng: true });

/** Country names (yfinance / GeoNames spellings) → alpha-2. */
const NAME_A2 = (() => {
  const m = new Map();
  for (const [, a2, en] of ISO_ROWS) if (a2) m.set(String(en).toLowerCase(), a2);
  const extra = {
    'united states': 'US', 'usa': 'US', 'united states of america': 'US', 'united kingdom': 'GB', 'uk': 'GB',
    'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'south korea': 'KR', 'korea': 'KR', 'republic of korea': 'KR',
    'korea, republic of': 'KR', 'russia': 'RU', 'russian federation': 'RU', 'czech republic': 'CZ', 'czechia': 'CZ',
    'taiwan': 'TW', 'hong kong': 'HK', 'macau': 'MO', 'macao': 'MO', 'china': 'CN', "people's republic of china": 'CN',
    'netherlands': 'NL', 'the netherlands': 'NL', 'switzerland': 'CH', 'germany': 'DE', 'france': 'FR', 'japan': 'JP',
    'india': 'IN', 'brazil': 'BR', 'canada': 'CA', 'australia': 'AU', 'singapore': 'SG', 'ireland': 'IE',
    'israel': 'IL', 'bermuda': 'BM', 'cayman islands': 'KY', 'british virgin islands': 'VG', 'luxembourg': 'LU',
    'jersey': 'JE', 'guernsey': 'GG', 'isle of man': 'IM', 'puerto rico': 'PR', 'monaco': 'MC', 'curacao': 'CW',
    'curaçao': 'CW', 'bahamas': 'BS', 'panama': 'PA', 'uruguay': 'UY', 'argentina': 'AR', 'mexico': 'MX', 'chile': 'CL',
    'peru': 'PE', 'colombia': 'CO', 'south africa': 'ZA', 'turkey': 'TR', 'türkiye': 'TR', 'turkiye': 'TR',
    'united arab emirates': 'AE', 'uae': 'AE', 'saudi arabia': 'SA', 'vietnam': 'VN', 'viet nam': 'VN', 'indonesia': 'ID',
    'malaysia': 'MY', 'thailand': 'TH', 'philippines': 'PH', 'new zealand': 'NZ', 'greece': 'GR', 'cyprus': 'CY',
    'gibraltar': 'GI', 'liechtenstein': 'LI', 'macedonia': 'MK', 'north macedonia': 'MK', 'kazakhstan': 'KZ',
  };
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
})();
/** Territories that world-atlas folds into another country's shape (Jersey → GB …). */
const CC_FOLD = { JE: 'GB', GG: 'GB', IM: 'GB', GI: 'GB', MO: 'CN', BM: 'BM', MC: 'FR', LI: 'CH', VG: 'VG', CW: 'CW' };

function normCC(c) {
  if (c == null || c === '') return null;
  const s = String(c).trim();
  const a = normA2(s);
  if (a) return a;
  const n = NAME_A2.get(s.toLowerCase());
  if (n) return CC_FOLD[n] && CC_FOLD[n] !== n ? CC_FOLD[n] : n;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return null;
}
const fin = (x) => typeof x === 'number' ? Number.isFinite(x) : x != null && x !== '' && Number.isFinite(+x);

// hq.json contract (geodata/README.md): [lon, lat, city, country, est, kind?, cat?]; kind omitted = exact HQ city;
// 'near' | 'state' | 'approx' = estimated company places; 'country' = a fund that IS a country (EWJ → Japan);
// 'region' = a several-country fund (VGK → Europe) and 'nongeo' (bonds, commodities, crypto, cash, sector, broad)
// have no place on land → sea areas (kept with their cat / region centre so the sea goes to a sensible ocean).
function normEntry(v) {
  if (v == null || v === false || v === 0) return NG;
  if (Array.isArray(v)) {
    const [lon, lat, city, cc, est, kind, cat] = v;
    if (kind === 'nongeo' || kind === 'region' || !fin(lon) || !fin(lat)) {
      return Object.freeze({ ng: true, kind: kind || 'nongeo', cat: cat || null, cc: normCC(cc), lon: fin(lon) ? +lon : null, lat: fin(lat) ? +lat : null });
    }
    return Object.freeze({ lon: +lon, lat: +lat, city: city || null, cc: normCC(cc), est: !!est, kind: kind || 'hq', cat: cat || null });
  }
  if (typeof v === 'object') {
    if (v.ng || v.nonGeo || v.kind === 'ng' || v.geo === false) return NG;
    const lon = v.lon ?? v.lng ?? (Array.isArray(v.ll) ? v.ll[0] : undefined);
    const lat = v.lat ?? (Array.isArray(v.ll) ? v.ll[1] : undefined);
    if (!fin(lon) || !fin(lat)) return NG;
    return Object.freeze({ lon: +lon, lat: +lat, city: v.city || null, cc: normCC(v.country ?? v.cc), est: !!(v.est ?? v.estimated) });
  }
  return NG;
}
function parseMeta(j) {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  return { sub: o.sub || {}, zh: o.zh || {}, hints: o.hints || {}, regions: o.regions || {}, countries: o.countries || {} };
}
function parseHQ(j) {
  let m = j && typeof j === 'object' ? (j.hq || j.items || j.tickers || j.data || j) : {};
  const out = new Map();
  if (Array.isArray(m)) {
    for (const r of m) if (r && (r.t || r.ticker)) out.set(String(r.t || r.ticker).toUpperCase(), normEntry(r.hq ?? r.at ?? r));
  } else {
    for (const [t, v] of Object.entries(m)) { if (t.startsWith('_')) continue; out.set(t.toUpperCase(), normEntry(v)); }
  }
  return out;
}

async function loadHQ() {
  if (HQ && HQ.src === cfg.hqPaths[0]) return HQ;
  const now = cfg.now();
  if (HQ && now - hqCheckAt < 30000) return HQ;
  if (hqP) return hqP;
  hqP = (async () => {
    hqCheckAt = cfg.now();
    for (const p of cfg.hqPaths) {
      if (HQ && HQ.src === p) return HQ;     // the fixture is already loaded and the real file is still missing
      try {
        const j = await cfg.fetchJSON(new URL(p, cfg.base).href);
        const map = parseHQ(j);
        if (!map.size) continue;
        const had = HQ;
        HQ = { map, meta: parseMeta(j), src: p, version: (had ? had.version : 0) + 1 };
        if (had) { layouts.clear(); lastByNode.clear(); ladders.clear(); console.info('[real] 总部数据换成了 ' + p + '（' + map.size + ' 只）'); emit('hq'); }
        return HQ;
      } catch (e) { /* try the next path */ }
    }
    if (!HQ) HQ = { map: new Map(), meta: parseMeta(null), src: null, version: 0 };
    return HQ;
  })().finally(() => { hqP = null; });
  return hqP;
}
/** The city's Chinese name from hq.json's zh table ("Santa Clara|US" → 圣克拉拉), or null. */
function zhCity(city, cc) { return (city && HQ && HQ.meta && HQ.meta.zh && HQ.meta.zh[city + '|' + (cc || '')]) || null; }
/** HQ entry for a ticker: {lon, lat, city, cc, est} | {ng:true} (non-geographic) | undefined (unknown). Sync. */
export function hqOf(ticker) { return HQ ? HQ.map.get(String(ticker).toUpperCase()) : undefined; }
export function hqStatus() { return HQ ? { src: HQ.src, n: HQ.map.size, version: HQ.version } : null; }

// ------------------------------------------------------------------------------------------------ anchors (§26 amendment 1)
// anchors.json: where non-company money really ends up. anchors[ticker] (every fund whose hq.json kind is nongeo /
// country / region, plus every curated member of 债券 / 商品 / 加密 / 现金) and nodes[curated id] (those continents and
// their regions: a weighted union of the members) = [{id, lon, lat, place, label, w, why, est, offshore?}].
let ANC = null;          // {ok, byTicker: Map, byNode: Map, version}
let ancP = null;
let ancCheckAt = 0;
function parseAnchorList(L) {
  if (!Array.isArray(L)) return null;
  const out = [];
  for (const a of L) {
    if (!a || !fin(a.lon) || !fin(a.lat) || !(+a.w > 0)) continue;
    out.push({ id: a.id || null, lon: +a.lon, lat: +a.lat, w: +a.w, label: a.label || null, place: a.place || null, why: a.why || null, est: a.est !== false, offshore: !!a.offshore });
  }
  if (!out.length) return null;
  const s = out.reduce((x, a) => x + a.w, 0) || 1;
  for (const a of out) a.w /= s;
  out.sort((a, b) => b.w - a.w);
  return Object.freeze(out.map((a) => Object.freeze(a)));
}
async function loadAnchors() {
  if (ANC && ANC.ok) return ANC;
  if (ANC && cfg.now() - ancCheckAt < 30000) return ANC;
  if (ancP) return ancP;
  ancP = (async () => {
    ancCheckAt = cfg.now();
    try {
      const j = await cfg.fetchJSON(new URL(cfg.anchorsPath, cfg.base).href);
      const byTicker = new Map(), byNode = new Map();
      for (const [t, L] of Object.entries((j && j.anchors) || {})) { const p = parseAnchorList(L); if (p) byTicker.set(String(t).toUpperCase(), p); }
      for (const [id, L] of Object.entries((j && j.nodes) || {})) { const p = parseAnchorList(L); if (p) byNode.set(id, p); }
      if (!byTicker.size && !byNode.size) throw new Error('empty anchors');
      const had = ANC;
      ANC = { ok: true, byTicker, byNode, version: (had ? had.version : 0) + 1 };
      if (had) { layouts.clear(); lastByNode.clear(); ladders.clear(); console.info('[real] 锚点数据到了（' + byTicker.size + ' 只 + ' + byNode.size + ' 个区域）'); emit('anchors'); }
    } catch (e) {
      if (!ANC) ANC = { ok: false, byTicker: new Map(), byNode: new Map(), version: 0 };
    }
    return ANC;
  })().finally(() => { ancP = null; });
  return ancP;
}
/** Where a fund's money ends up: [{lon, lat, label, w, why, est, offshore}] | null (sync; null until loaded). */
export function anchorsOf(ticker) { return ANC && ANC.ok ? ANC.byTicker.get(String(ticker).toUpperCase()) || null : null; }

// faint province / prefecture borders (§26 amendment 2): which countries have vendor/geo/admin1/<ISO2>.json
let adm1P = null;
function loadAdmin1Index() {
  if (!adm1P) {
    adm1P = cfg.fetchJSON(new URL(cfg.admin1Index, cfg.base).href)
      .then((j) => new Set(Object.keys(j || {}).filter((k) => /^[A-Z]{2}$/.test(k))))
      .catch(() => { const s = new Set(); setTimeout(() => { if (adm1P && !s.size) adm1P = null; }, 30000); return s; });
  }
  return adm1P;
}

// ------------------------------------------------------------------------------------------------ admin units (§26 amendment 4)
// Territories are dissolved unions of REAL administrative units (no discs, wedges or Voronoi). Data (geodata/, loaded
// lazily per country in the layout):
//   vendor/geo/admin2/index.json  {ISO2: {file, object:'units', level:2, unit_zh, units, bytes, bbox, source, license}}
//   vendor/geo/admin2/<ISO2>.json TopoJSON, object 'units', properties {id ('<ISO2>-<code>'), name, name_zh, a1, level:2}
//   vendor/geo/admin3/index.json  {key: {file, cc, object:'units', level:3, bbox, a2:[parent ids]}}   (metro detail)
//   vendor/geo/admin1/index.json  {ISO2: {file, object:'admin1', …}}  (feature id = unit id, properties.iso_3166_2)
//   data/geo/units.json           {version, t:{TICKER:[a1, a2, a3|null]}, a:{anchorId:[a1, a2, a3|null]}}
// Every lookup falls back: units.json → point-in-polygon in the loaded file → the nearest unit ≤ 8 km (a coastal HQ)
// → the next coarser level → the whole country → (last resort, counted in debug.units) a small land-clipped patch.
// The indices are re-read every 45 s (the data is landing country by country); a change re-lays everything out
// (onChange fires with reason 'units').
const UNIT_RECHECK_MS = 45000;
let UM = null, umP = null, umCheckAt = 0;
const unitFiles = new Map();     // 'a2:US|bytes' → Promise<UF>
function idxOf(j, pred) {
  const out = new Map();
  if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) if (v && typeof v === 'object' && v.file && pred(k, v)) out.set(k, v);
  return out;
}
function parseUnitsJson(j) {
  const t = new Map(), a = new Map(), fine = new Map();
  // fine[ticker] = [a1, a2, a3|null, lon, lat]: the street address names a finer unit than the hq.json point (a city
  // centre) — BIDU at 北京 centre → 海淀区. Its point and units win.
  if (j && j.fine && typeof j.fine === 'object') for (const [k, v] of Object.entries(j.fine)) if (Array.isArray(v) && fin(v[3]) && fin(v[4])) fine.set(k.toUpperCase(), [v[0] || null, v[1] || null, v[2] || null, +v[3], +v[4]]);
  const norm = (v) => (Array.isArray(v) ? [v[0] || null, v[1] || null, v[2] || null] : null);
  if (j && typeof j === 'object') {
    for (const [k, v] of Object.entries(j.t || {})) {
      // one place → [a1, a2, a3]; several (a region anchor listed unit by unit) → [[a1, a2, a3], …]
      if (Array.isArray(v) && Array.isArray(v[0])) t.set(k.toUpperCase(), v.map(norm).filter(Boolean)); else { const n = norm(v); if (n) t.set(k.toUpperCase(), n); }
    }
    for (const [k, v] of Object.entries(j.a || {})) {
      if (Array.isArray(v) && Array.isArray(v[0])) a.set(k, v.map(norm).filter(Boolean)); else { const n = norm(v); if (n) a.set(k, n); }
    }
  }
  return { t, a, fine, version: (j && j.version) || null, ok: !!j };
}
/** The street-address place of a company (units.json fine), or null. */
function fineOf(t) { return t && UM && UM.u && UM.u.fine ? UM.u.fine.get(String(t).toUpperCase()) || null : null; }
// A missing file is asked for again after 45 s, 3 min, 15 min, then once an hour (each miss is a 404 in the console);
// files that exist are re-read every 45 s (cheap revalidations) so a rebuilt country shows up without a reload.
const miss = new Map();   // path → {n, at}
async function getMaybe(p) {
  if (!p) return null;
  const m = miss.get(p);
  if (m && cfg.now() - m.at < [45e3, 180e3, 900e3, 3600e3][Math.min(3, m.n - 1)]) return m.last || null;
  try { const j = await cfg.fetchJSON(new URL(p, cfg.base).href); miss.delete(p); return j; } catch (e) { miss.set(p, { n: ((m && m.n) || 0) + 1, at: cfg.now(), last: null }); return null; }
}
async function loadUnitsMeta() {
  if (UM && cfg.now() - umCheckAt < UNIT_RECHECK_MS) return UM;
  if (umP) return umP;
  umP = (async () => {
    umCheckAt = cfg.now();
    const get = getMaybe;
    const [i1, i2, i3] = await Promise.all([get(cfg.admin1Index), get(cfg.admin2Index), get(cfg.admin3Index)]);
    const idx1 = idxOf(i1, (k) => /^[A-Z]{2}$/.test(k));
    const idx2 = idxOf(i2, (k) => /^[A-Z]{2}$/.test(k));
    const idx3 = idxOf(i3, (k, v) => !!v.cc);
    const sigOf = (m) => [...m].map(([k, v]) => k + ':' + (v.bytes || '') + ':' + (v.units || '') + ':' + (v.file || '')).sort().join(',');
    const sig = sigOf(idx1) + '|' + sigOf(idx2) + '|' + sigOf(idx3);
    // units.json is re-read when an index changed, while it is missing, and every few minutes
    let u = UM && UM.u;
    if (!u || !u.ok || !UM || UM.sig !== sig || cfg.now() - (UM.uAt || 0) > 5 * 60000) {
      const j = await get(cfg.unitsPath);
      u = parseUnitsJson(j);
    }
    const by3 = new Map();
    for (const [key, v] of idx3) for (const p of v.a2 || []) if (!by3.has(p)) by3.set(p, key);
    const had = UM;
    const changed = !had || had.sig !== sig || had.u.version !== u.version || had.u.ok !== u.ok || had.u.t.size !== u.t.size;
    if (!changed) { had.uAt = had.u === u ? had.uAt : cfg.now(); return had; }
    UM = { idx1, idx2, idx3, by3, u, sig, uAt: cfg.now(), version: (had ? had.version : 0) + 1 };
    if (had) {
      layouts.clear(); lastByNode.clear(); ladders.clear();
      console.info('[real] 行政区数据更新了：admin2 ' + idx2.size + ' 国，admin3 ' + idx3.size + ' 块，units.json ' + u.t.size + ' 只');
      emit('units');
    }
    return UM;
  })().finally(() => { umP = null; });
  return umP;
}
/** Which levels are available (sync; null until first loaded): {admin1:[ISO2], admin2:[ISO2], admin3:[keys], units}. */
export function unitsStatus() {
  return UM ? { admin1: [...UM.idx1.keys()], admin2: [...UM.idx2.keys()], admin3: [...UM.idx3.keys()], units: UM.u.t.size, version: UM.version } : null;
}

const hasJump = (r) => { for (let i = 1; i < r.length; i++) { const d = r[i][0] - r[i - 1][0]; if (d > 180 || d < -180) return true; } return false; };
/** A unit file (one country's admin2 / admin1, or one metro's admin3) → {rel, topo, list, byId, grid, cell}. */
function unitFile(level, key) {
  if (!UM) return Promise.resolve(null);
  const meta = level === 3 ? UM.idx3.get(key) : level === 2 ? UM.idx2.get(key) : UM.idx1.get(key);
  if (!meta) return Promise.resolve(null);
  const rel = 'admin' + level + '/' + meta.file;
  const k = rel + '|' + (meta.bytes || '') + '|' + (meta.units || '');
  if (!unitFiles.has(k)) {
    const p = cfg.fetchJSON(new URL(cfg.vendorGeo + rel, cfg.base).href).then((topo) => prepUnits(topo, meta.object || (level === 1 ? 'admin1' : 'units'), level, level === 3 ? meta.cc : key, rel, key));
    unitFiles.set(k, p);
    p.catch((e) => { unitFiles.delete(k); console.info('[real] 行政区文件读不到：' + rel + '（' + (e && e.message) + '）'); });
    if (unitFiles.size > 40) unitFiles.delete(unitFiles.keys().next().value);
  }
  return unitFiles.get(k).catch(() => null);
}
function prepUnits(topo, objName, level, cc, rel, key) {
  const T = globalThis.topojson;
  const obj = (topo.objects && (topo.objects[objName] || topo.objects.units || topo.objects[Object.keys(topo.objects)[0]])) || { geometries: [] };
  const list = [], byId = new Map();
  for (const g of obj.geometries || []) {
    if (!g || !g.arcs || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const p = g.properties || {};
    const id = String(p.id != null ? p.id : g.id != null ? g.id : '');
    if (!id || byId.has(id)) continue;
    const geom = T.feature(topo, g).geometry;
    if (!geom) continue;
    const polys = [];
    for (const P of geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates) {
      if (!P || !P[0] || P[0].length < 4) continue;
      if (P.some(hasJump)) { for (const pc of planarize(P)) polys.push(pc.coords); } else polys.push(P.map(closeRing));
    }
    if (!polys.length) continue;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    let A = 0;
    for (const P of polys) {
      const b = ringBBox(P[0]);
      if (b[0] < bb[0]) bb[0] = b[0]; if (b[1] < bb[1]) bb[1] = b[1]; if (b[2] > bb[2]) bb[2] = b[2]; if (b[3] > bb[3]) bb[3] = b[3];
      let a = Math.abs(planarArea(P[0]));
      for (let h = 1; h < P.length; h++) a -= Math.abs(planarArea(P[h]));
      A += a * Math.cos(((b[1] + b[3]) / 2) * RAD);
    }
    const U = { id, g, level, cc, file: rel, fkey: key, name: p.name || '', zh: p.name_zh || '', a1: p.a1 || p.iso_3166_2 || null, a2: p.a2 || null, polys, bbox: bb, A, ip: null, uf: null };
    list.push(U); byId.set(id, U);
  }
  // grid of unit indices for point-in-polygon: cells about twice a typical unit (0.05°–5°)
  const sizes = list.map((U) => Math.max(U.bbox[2] - U.bbox[0], U.bbox[3] - U.bbox[1])).sort((a, b) => a - b);
  const cell = Math.max(0.05, Math.min(5, 2 * (sizes[sizes.length >> 1] || 1)));
  const grid = new Map();
  list.forEach((U, i) => {
    // (part by part: a unit with islands on both sides of the antimeridian must not cover the whole globe)
    for (const P of U.polys) {
      const [a, b, c, d] = ringBBox(P[0]);
      for (let y = Math.floor((b + 90) / cell); y <= Math.floor((d + 90) / cell); y++) for (let x = Math.floor((a + 180) / cell); x <= Math.floor((c + 180) / cell); x++) {
        const k = y * 100000 + x;
        let L = grid.get(k);
        if (!L) grid.set(k, (L = []));
        if (L[L.length - 1] !== i) L.push(i);
      }
    }
  });
  const UF = { rel, key, level, cc, topo, list, byId, grid, cell };
  for (const U of list) U.uf = UF;
  return UF;
}
/** The unit of a file that holds lon/lat, else null. */
function unitAt(UF, lon, lat) {
  if (!UF) return null;
  const L = UF.grid.get(Math.floor((lat + 90) / UF.cell) * 100000 + Math.floor((wrapLon(lon) + 180) / UF.cell));
  if (!L) return null;
  for (const i of L) {
    const U = UF.list[i];
    const [w, s, e, n] = U.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    for (const P of U.polys) {
      const b = P.__bb || (P.__bb = ringBBox(P[0]));
      if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pipPoly(P, lon, lat)) return U;
    }
  }
  return null;
}
/** The unit nearest to lon/lat within km (a coastal HQ just off the simplified coast), else null. */
function unitNear(UF, lon, lat, km) {
  if (!UF) return null;
  const dLat = km / 111.2, dLon = dLat / Math.max(0.15, Math.cos(lat * RAD));
  const seen = new Set();
  let best = null, bd = Infinity;
  for (let y = Math.floor((lat - dLat + 90) / UF.cell); y <= Math.floor((lat + dLat + 90) / UF.cell); y++) {
    for (let x = Math.floor((lon - dLon + 180) / UF.cell); x <= Math.floor((lon + dLon + 180) / UF.cell); x++) {
      for (const i of UF.grid.get(y * 100000 + x) || []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const U = UF.list[i];
        if (U.bbox[0] > lon + dLon || U.bbox[2] < lon - dLon || U.bbox[1] > lat + dLat || U.bbox[3] < lat - dLat) continue;
        for (const P of U.polys) for (const r of P) for (let k = 0; k < r.length - 1; k++) {
          const d = segDistKm(lon, lat, r[k], r[k + 1]);
          if (d < bd) { bd = d; best = U; }
        }
      }
    }
  }
  return bd <= km ? best : null;
}
/** Distance (km, local equirectangular) from lon/lat to the segment a–b. */
function segDistKm(lon, lat, a, b) {
  const k = Math.cos(lat * RAD);
  const ax = (a[0] - lon) * k, ay = a[1] - lat, bx = (b[0] - lon) * k, by = b[1] - lat;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * 111.2;
}
/** A point well inside a unit (its largest part's pole of inaccessibility, coarse), cached. */
function unitInner(U) {
  if (!U.ip) {
    let best = U.polys[0], ba = -1;
    for (const P of U.polys) { const a = Math.abs(planarArea(P[0])); if (a > ba) { ba = a; best = P; } }
    U.ip = innerPoint(best);
  }
  return U.ip;
}
/**
 * Pole of inaccessibility of a planar polygon [outer, …holes] (closed rings), by grid refinement. With `target`
 * ([lon, lat]) and capKm: the best compromise between room (edge distance, capped at a label's size) and closeness
 * to the target — a territory of two states is named in the one its money is in, not in the middle of both.
 */
function innerPoint(P, target, capKm) {
  const [w, s, e, n] = ringBBox(P[0]);
  const k = Math.cos(((s + n) / 2) * RAD);
  // a thinned copy of the edges for the distance test
  const edges = [];
  for (const r of P) { const st = Math.max(1, Math.floor(r.length / 400)); for (let i = 0; i + st < r.length; i += st) edges.push([r[i], r[Math.min(r.length - 1, i + st)]]); }
  const dist0 = (x, y) => { let m = Infinity; for (const [a, b] of edges) { const d = segDistKm(x, y, a, b); if (d < m) m = d; } return m; };
  const dist = target ? (x, y) => Math.min(dist0(x, y), capKm) - 0.25 * Math.hypot((x - target[0]) * Math.cos(y * RAD), y - target[1]) * 111.2 : dist0;
  let best = null, bd = -Infinity;
  let cx = (w + e) / 2, cy = (s + n) / 2, hw = (e - w) / 2, hh = (n - s) / 2;
  for (let round = 0; round < 3; round++) {
    const N = round ? 6 : 14;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = cx - hw + (2 * hw * i) / N, y = cy - hh + (2 * hh * j) / N;
      if (!pipPoly(P, x, y)) continue;
      const d = dist(x, y);
      if (d > bd) { bd = d; best = [x, y]; }
    }
    if (!best) break;
    cx = best[0]; cy = best[1]; hw = (2 * hw) / (round ? 6 : 14); hh = (2 * hh) / (round ? 6 : 14);
  }
  void k;
  if (!best) { const r = P[0]; best = [r[0][0], r[0][1]]; }
  return [round6(best[0]), round6(best[1])];
}
/**
 * Dissolve units of one file into territory polygons: topojson.merge (shared arcs vanish: Santa Clara + San Mateo →
 * one shape), then d3 winding (exteriors clockwise, holes counter-clockwise), closed rings, planar-safe lon/lat.
 */
function dissolveUnits(UF, ids) {
  const T = globalThis.topojson;
  const Us = [];
  for (const id of ids) { const U = UF.byId.get(id); if (U) Us.push(U); }
  if (!Us.length) return [];
  if (Us.length === 1) return Us[0].polys.map((P) => orientPoly(P.map(openRing))).filter(Boolean).map((P) => P.map(closeRing));
  const m = T.merge(UF.topo, Us.map((U) => U.g));
  const out = [];
  for (const P of m.coordinates || []) {
    if (!P || !P[0] || P[0].length < 4) continue;
    if (P.some(hasJump)) { for (const pc of planarize(P)) out.push(pc.coords); continue; }
    const o = orientPoly(P.map(openRing));
    if (o) out.push(o.map(closeRing));
  }
  return out;
}
/** Region anchors (a basin, a belt, a plain: 'Permian Basin', '玉米带') spread over the units around them (km). */
function spreadKm(a) {
  if (!a || a.offshore) return 0;
  const s = String(a.place || '') + ' ' + String(a.label || '');
  if (/矿$/.test(String(a.label || ''))) return 0;          // one mine (雪茄湖铀矿) is a place, not a region
  return /盆地|页岩|矿带|玉米带|麦带|甘蔗带|大豆带|咖啡带|可可带|养猪带|养牛带|棉花带|炼油带|铜带|粮仓|平原|Basin|Shale|Belt|Trend|wheatbelt/i.test(s) ? 140 : 0;
}

// trees (parent lookup: an all-sea node is drawn where its parent put it)
const TREE_PATH = { curated: 'data/tree.json', full: 'data/fm/tree.json', global: 'data/gl/tree.json' };
const trees = new Map(); // key → {root, parent: Map(id → node), byId: Map}
const treeP = new Map();
function indexTree(root) {
  const parent = new Map(), byId = new Map();
  const walk = (n, p) => {
    if (!n || n.id == null) return;
    if (!byId.has(n.id)) byId.set(n.id, n);
    if (p && !parent.has(n.id)) parent.set(n.id, p);
    for (const c of n.children || []) walk(c, n);
  };
  walk(root, null);
  return { root, parent, byId };
}
/** Use the app's live tree objects for parent lookups (optional; otherwise the tree files are fetched). */
export function registerTree(tree, key) {
  if (!tree || !tree.id) return;
  const k = key || (tree.map === 'full' ? 'full' : tree.map === 'global' ? 'global' : 'curated');
  trees.set(k, indexTree(tree));
}
function treeKeyOf(node, opts) {
  if (opts && (opts.map === 'full' || opts.map === 'global' || opts.map === 'curated')) return opts.map;
  const id = String(node && node.id || '');
  if (id.startsWith('gl-')) return 'global';
  if (id.startsWith('fm-')) return 'full';
  if (id === 'world') return node.map === 'full' || node.name === '全市场' ? 'full' : node.map === 'global' || node.name === '全球' ? 'global' : 'curated';
  return 'curated';
}
async function getTree(key) {
  if (trees.has(key)) return trees.get(key);
  if (!treeP.has(key)) {
    treeP.set(key, cfg.fetchJSON(new URL(TREE_PATH[key], cfg.base).href).then((t) => {
      const T = indexTree(t);
      if (!trees.has(key)) trees.set(key, T);
      return trees.get(key);
    }).catch(() => { treeP.delete(key); return null; }));
  }
  return treeP.get(key);
}

// geography: countries (planar-safe polygons per alpha-2) at two details, land (spherical, for the sea raster)
const geos = new Map();
function ensureLibs() {
  if (globalThis.d3 && globalThis.d3.Delaunay && globalThis.topojson) return Promise.resolve();
  return earth.loadEarth({ detail: 'medium' }).then(() => {});
}
async function loadGeo(detail) {
  if (geos.has(detail)) return geos.get(detail);
  const p = (async () => {
    await ensureLibs();
    const d3 = globalThis.d3;
    const byCC = new Map();
    const all = [];
    let land;
    if (detail === '10m') {
      const [topo, landTopo] = await Promise.all([
        cfg.fetchJSON(new URL('vendor/geo/countries-10m.json', cfg.base).href),
        cfg.fetchJSON(new URL('vendor/geo/land-10m.json', cfg.base).href),
      ]);
      const T = globalThis.topojson;
      for (const g of topo.objects.countries.geometries) {
        const f = T.feature(topo, g);
        const iso = earthIsoForFeature(g);
        const cc = iso || 'X-' + (g.properties && g.properties.name || g.id);
        const geom = f.geometry;
        const list = !geom ? [] : geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        for (const poly of list) for (const pc of planarize(poly)) addPoly(byCC, all, cc, pc);
      }
      const lf = T.feature(landTopo, landTopo.objects.land);
      const geoms = lf.type === 'FeatureCollection' ? lf.features.map((f) => f.geometry) : [lf.geometry || lf];
      land = [];
      // (land-10m has three 4-point Maldives specks that d3 reads inside-out — whole-sphere polygons; skip them)
      for (const g of geoms) for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) {
        const a = d3.geoArea({ type: 'Polygon', coordinates: poly });
        if (a > 0 && a < TAU) land.push(poly);
      }
    } else {
      const ed = detail === '50m' ? 'high' : 'medium';
      const cs = await earth.countries({ detail: ed });
      for (const c of cs) {
        const cc = c.a2 || 'X-' + c.num;
        for (const coords of c.polygons) addPoly(byCC, all, cc, { coords, area: d3.geoArea({ type: 'Polygon', coordinates: coords }) });
      }
      land = await earth.landPolygons({ spherical: true, detail: ed });
    }
    // 5° grid of polygon indices for point-in-land tests
    const grid = new Map();
    all.forEach((P, i) => {
      const [w, s, e, n] = P.bbox;
      for (let y = Math.floor((s + 90) / 5); y <= Math.floor((n + 90) / 5); y++) {
        for (let x = Math.floor((w + 180) / 5); x <= Math.floor((e + 180) / 5); x++) {
          const k = y * 100 + x;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
      }
    });
    return { detail, byCC, all, land, grid };
  })();
  geos.set(detail, p);
  p.catch(() => geos.delete(detail));
  return p;
}
function earthIsoForFeature(g) {
  const id = g.id != null ? String(g.id) : null;
  if (id) { const r = ISO_ROWS.find((row) => row[0] === id.padStart(3, '0')); if (r && r[1]) return r[1]; }
  const name = g.properties && g.properties.name;
  if (name === 'Kosovo') return 'XK';
  return null;
}
function addPoly(byCC, all, cc, pc) {
  const P = { cc, coords: pc.coords, area: pc.area, bbox: ringBBox(pc.coords[0]) };
  all.push(P);
  if (!byCC.has(cc)) byCC.set(cc, []);
  byCC.get(cc).push(P);
}
/** Which country (alpha-2) a lon/lat falls in, using a loaded detail; null over the sea. */
function countryAtGeo(G, lon, lat) {
  const k = Math.floor((lat + 90) / 5) * 100 + Math.floor((wrapLon(lon) + 180) / 5);
  const cand = G.grid.get(k) || [];
  let best = null;
  for (const i of cand) {
    const P = G.all[i];
    const [w, s, e, n] = P.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (pipPoly(P.coords, lon, lat) && (!best || P.area < best.area)) best = P;
  }
  return best ? best.cc : null;
}
/**
 * The country of a coastal place that falls just off a coarse coastline (Miami, Starbase, Rio, 深圳 at 1:50m): the
 * country under the nearest of 8 probes at 2, 5, 9 and `km` km, else null. (Refine: the last-resort patch was drawn
 * at 迈阿密 for 加密 because the anchor's country was looked up on the 50 m coast only.)
 */
function countryNear(G, lon, lat, km = 15) {
  const c = vec(lon, lat);
  for (const d of [2, 5, 9, km]) {
    if (d > km) break;
    for (let k = 0; k < 8; k++) { const p = llOf(dest(c, (k / 8) * TAU, d / 6371)); const cc = countryAtGeo(G, p[0], p[1]); if (cc) return cc; }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ small math
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;
function vec(lon, lat) { const a = lon * RAD, b = lat * RAD, c = Math.cos(b); return [c * Math.cos(a), c * Math.sin(a), Math.sin(b)]; }
function llOf(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [Math.atan2(v[1], v[0]) * DEG, Math.asin(clamp(v[2] / l, -1, 1)) * DEG]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function ang(a, b) { const c = cross(a, b); return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b)); }
/** Tangent frame [east, north] at unit vector p. */
function frame(p) {
  let e = [-p[1], p[0], 0];
  let l = Math.hypot(e[0], e[1]);
  if (l < 1e-9) { e = [0, 1, 0]; l = 1; }
  e = [e[0] / l, e[1] / l, 0];
  return [e, cross(p, e)];
}
/** Point at bearing th (rad, 0 = north, clockwise) and angular distance d (rad) from unit vector p. */
function dest(p, th, d) {
  const [e, n] = frame(p);
  const s = Math.sin(d), c = Math.cos(d), ct = Math.cos(th), st = Math.sin(th);
  return unit([c * p[0] + s * (ct * n[0] + st * e[0]), c * p[1] + s * (ct * n[1] + st * e[1]), c * p[2] + s * (ct * n[2] + st * e[2])]);
}
function slerp(a, b, t) {
  const w = ang(a, b);
  if (w < 1e-12) return a.slice();
  const s = Math.sin(w), k0 = Math.sin((1 - t) * w) / s, k1 = Math.sin(t * w) / s;
  return [k0 * a[0] + k1 * b[0], k0 * a[1] + k1 * b[1], k0 * a[2] + k1 * b[2]];
}
function hash32(s) {
  let h = 0x811c9dc5;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const GOLD = Math.PI * (3 - Math.sqrt(5));

// planar (lon/lat) helpers
function ringBBox(r) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of r) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
  return [w, s, e, n];
}
function planarArea(r) { // > 0 counter-clockwise (lat up)
  let a = 0;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}
function pipRing(r, x, y) {
  let inside = false;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function pipPoly(coords, x, y) {
  if (!pipRing(coords[0], x, y)) return false;
  for (let i = 1; i < coords.length; i++) if (pipRing(coords[i], x, y)) return false;
  return true;
}
const closeRing = (r) => {
  if (!r.length) return r;
  const a = r[0], b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? r : r.concat([[a[0], a[1]]]);
};
const openRing = (r) => {
  const out = [];
  for (const p of r) { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - p[0]) > 1e-12 || Math.abs(l[1] - p[1]) > 1e-12) out.push(p); }
  if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) out.pop(); }
  return out;
};

/**
 * Spherical polygon [outer, …holes] (d3 semantics) → planar-safe pieces [{coords, area}] (cut at the antimeridian
 * by d3's own clip; exteriors clockwise, holes counter-clockwise). Same idea as earth.js, for the 10 m data.
 */
let eqProj = null;
function planarize(poly) {
  const d3 = globalThis.d3;
  const needsCut = poly.some((r) => { for (let i = 1; i < r.length; i++) { const d = r[i][0] - r[i - 1][0]; if (d > 180 || d < -180) return true; } return false; });
  let groups;
  if (!needsCut) groups = [poly.map((r) => openRing(r))];
  else {
    if (!eqProj) eqProj = d3.geoEquirectangular().scale(DEG).translate([0, 0]).precision(0);
    const rings = [];
    let cur = null;
    const sink = {
      point(x, y) { const p = [clamp(Math.round(x * 1e6) / 1e6, -180, 180), clamp(Math.round(-y * 1e6) / 1e6, -90, 90)]; const l = cur[cur.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) cur.push(p); },
      lineStart() { cur = []; }, lineEnd() { if (cur.length > 2) rings.push(openRing(cur)); cur = null; },
      polygonStart() {}, polygonEnd() {}, sphere() {},
    };
    d3.geoStream({ type: 'Polygon', coordinates: poly }, eqProj.stream(sink));
    groups = nestRings(rings).map((p) => p);
  }
  const out = [];
  for (const g of groups) {
    const P = orientPoly(g);
    if (!P) continue;
    const area = d3.geoArea({ type: 'Polygon', coordinates: P.map(closeRing) });
    if (!(area > 0) || area > TAU) continue;
    out.push({ coords: P.map(closeRing), area });
  }
  return out;
}
/** Even-odd nesting of planar rings → polygons [outer, …holes] (rings open). */
function nestRings(rings) {
  const items = rings.filter((r) => r.length >= 3).map((r) => ({ r, abs: Math.abs(planarArea(r)) })).filter((it) => it.abs > 1e-14);
  items.sort((a, b) => b.abs - a.abs);
  for (let i = 0; i < items.length; i++) {
    const v = items[i].r[0];
    let depth = 0, parent = -1;
    // probe with the midpoint of the first edge (vertices may touch the parent's boundary at a cut)
    const q = items[i].r[1] ? [(v[0] + items[i].r[1][0]) / 2, (v[1] + items[i].r[1][1]) / 2] : v;
    for (let j = 0; j < i; j++) if (pipRing(items[j].r, q[0], q[1])) { depth++; parent = j; }
    items[i].hole = depth % 2 === 1;
    items[i].parent = parent;
  }
  const out = [];
  const at = new Map();
  items.forEach((it, i) => { if (!it.hole) { at.set(i, out.length); out.push([it.r]); } });
  items.forEach((it) => {
    if (!it.hole) return;
    // a hole's polygon is its smallest containing exterior
    let p = it.parent;
    while (p >= 0 && items[p].hole) p = items[p].parent;
    if (p >= 0 && at.has(p)) out[at.get(p)].push(it.r);
  });
  return out;
}
/** Polygon [outer, …holes] (open rings) → d3 winding (outer clockwise, holes counter-clockwise), open rings. */
function orientPoly(g) {
  let outer = g[0];
  if (!outer || outer.length < 3) return null;
  const oa = planarArea(outer);
  if (Math.abs(oa) < 1e-14) return null;
  if (oa > 0) outer = outer.slice().reverse();
  const out = [outer];
  for (let i = 1; i < g.length; i++) {
    let h = g[i];
    if (h.length < 3) continue;
    const ha = planarArea(h);
    if (Math.abs(ha) < 1e-14) continue;
    if (ha < 0) h = h.slice().reverse();
    out.push(h);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ polygon overlay
// Intersection of a zone (rings in lon/lat, even-odd) with country polygons, Greiner–Hormann style with even-odd
// entry/exit toggling, so it works for non-convex zones, holes, many rings. Degenerate cases (a vertex exactly on
// the other polygon's edge) are made vanishingly unlikely by a fixed sub-millimetre offset of the zone.
const ZONE_EPS = [1.37e-9, 0.91e-9];

function segX(a1, a2, b1, b2) {
  const rx = a2[0] - a1[0], ry = a2[1] - a1[1], sx = b2[0] - b1[0], sy = b2[1] - b1[1];
  const d = rx * sy - ry * sx;
  if (d === 0) return null;
  const qx = b1[0] - a1[0], qy = b1[1] - a1[1];
  const t = (qx * sy - qy * sx) / d, u = (qx * ry - qy * rx) / d;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return [t, u];
}

/**
 * zone: [ring] (open rings, lon may run past ±180), polys: [{coords:[outer, …holes] closed, bbox}] ([-180, 180]).
 * → [[outer, …holes], …] (open rings, d3 winding) = zone ∩ polys.
 */
function clipZone(zone, polys) {
  if (!zone.length) return [];
  // zone bbox + candidate subject rings (shifted copies across the antimeridian)
  let zw = Infinity, zs = Infinity, ze = -Infinity, zn = -Infinity;
  for (const r of zone) for (const p of r) { if (p[0] < zw) zw = p[0]; if (p[0] > ze) ze = p[0]; if (p[1] < zs) zs = p[1]; if (p[1] > zn) zn = p[1]; }
  const A = [];
  for (const P of polys) {
    const [w, s, e, n] = P.bbox;
    if (s > zn || n < zs) continue;
    for (const k of [0, -360, 360]) {
      if (w + k > ze || e + k < zw) continue;
      for (const r of P.coords) {
        const o = openRing(r);
        if (o.length < 3) continue;
        A.push(k ? o.map((p) => [p[0] + k, p[1]]) : o);
      }
    }
  }
  const B = zone.map((r) => r.map((p) => [p[0] + ZONE_EPS[0], p[1] + ZONE_EPS[1]]));
  if (!A.length) return [];
  // grid of zone edges over the zone bbox
  const NG = 48, gw = (ze - zw) / NG || 1e-9, gh = (zn - zs) / NG || 1e-9;
  const grid = new Array(NG * NG);
  const bEdges = [];
  B.forEach((r, ri) => {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const id = bEdges.length;
      bEdges.push([ri, i]);
      const x0 = clamp(Math.floor((Math.min(p[0], q[0]) - zw) / gw), 0, NG - 1), x1 = clamp(Math.floor((Math.max(p[0], q[0]) - zw) / gw), 0, NG - 1);
      const y0 = clamp(Math.floor((Math.min(p[1], q[1]) - zs) / gh), 0, NG - 1), y1 = clamp(Math.floor((Math.max(p[1], q[1]) - zs) / gh), 0, NG - 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y * NG + x; (grid[k] || (grid[k] = [])).push(id); }
    }
  });
  const stamp = new Int32Array(bEdges.length).fill(-1);
  const nodes = [];
  const listA = A.map(() => []), listB = B.map(() => []);
  let stampId = 0;
  A.forEach((r, ri) => {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const ex0 = Math.min(p[0], q[0]), ex1 = Math.max(p[0], q[0]), ey0 = Math.min(p[1], q[1]), ey1 = Math.max(p[1], q[1]);
      if (ex0 > ze || ex1 < zw || ey0 > zn || ey1 < zs) continue;
      const x0 = clamp(Math.floor((ex0 - zw) / gw), 0, NG - 1), x1 = clamp(Math.floor((ex1 - zw) / gw), 0, NG - 1);
      const y0 = clamp(Math.floor((ey0 - zs) / gh), 0, NG - 1), y1 = clamp(Math.floor((ey1 - zs) / gh), 0, NG - 1);
      stampId++;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const cell = grid[y * NG + x];
        if (!cell) continue;
        for (const id of cell) {
          if (stamp[id] === stampId) continue;
          stamp[id] = stampId;
          const [bj, bi] = bEdges[id];
          const br = B[bj];
          const X = segX(p, q, br[bi], br[(bi + 1) % br.length]);
          if (!X) continue;
          const pt = [p[0] + X[0] * (q[0] - p[0]), p[1] + X[0] * (q[1] - p[1])];
          const nd = { pt, ar: ri, ae: i, at: X[0], br: bj, be: bi, bt: X[1], vis: false };
          nodes.push(nd);
          listA[ri].push(nd);
          listB[bj].push(nd);
        }
      }
    }
  });
  const out = [];
  const inB = (x, y) => { let c = false; for (const r of B) if (pipRing(r, x, y)) c = !c; return c; };
  const inA = (x, y) => { let c = false; for (const r of A) if (pipRing(r, x, y)) c = !c; return c; };
  // rings without crossings: wholly inside the other → kept as they are
  A.forEach((r, ri) => { if (!listA[ri].length && inB(r[0][0], r[0][1])) out.push(r); });
  B.forEach((r, ri) => { if (!listB[ri].length && inA(r[0][0], r[0][1])) out.push(r); });
  if (nodes.length) {
    const sortA = (a, b) => a.ae - b.ae || a.at - b.at;
    const sortB = (a, b) => a.be - b.be || a.bt - b.bt;
    listA.forEach((L, ri) => {
      if (!L.length) return;
      L.sort(sortA);
      let st = inB(A[ri][0][0], A[ri][0][1]);
      L.forEach((nd, k) => { nd.pa = k; nd.entA = !st; st = !st; });
    });
    listB.forEach((L, ri) => {
      if (!L.length) return;
      L.sort(sortB);
      let st = inA(B[ri][0][0], B[ri][0][1]);
      L.forEach((nd, k) => { nd.pb = k; nd.entB = !st; st = !st; });
    });
    for (const n0 of nodes) {
      if (n0.vis) continue;
      const ring = [];
      let cur = n0, onA = true;
      for (let guard = 0; guard < nodes.length * 2 + 4; guard++) {
        cur.vis = true;
        ring.push(cur.pt);
        let nxt;
        if (onA) {
          const L = listA[cur.ar], R = A[cur.ar];
          if (cur.entA) { nxt = L[(cur.pa + 1) % L.length]; emitFwd(R, cur.ae, cur.at, nxt.ae, nxt.at, ring); }
          else { nxt = L[(cur.pa - 1 + L.length) % L.length]; emitBack(R, cur.ae, cur.at, nxt.ae, nxt.at, ring); }
        } else {
          const L = listB[cur.br], R = B[cur.br];
          if (cur.entB) { nxt = L[(cur.pb + 1) % L.length]; emitFwd(R, cur.be, cur.bt, nxt.be, nxt.bt, ring); }
          else { nxt = L[(cur.pb - 1 + L.length) % L.length]; emitBack(R, cur.be, cur.bt, nxt.be, nxt.bt, ring); }
        }
        cur = nxt;
        onA = !onA;
        if (cur === n0) break;
      }
      const o = openRing(ring);
      if (o.length >= 3) out.push(o);
    }
  }
  return nestRings(out).map(orientPoly).filter(Boolean);
}
/** Ring vertices strictly after position (e1, t1) and strictly before (e2, t2), walking forward (cyclic). */
function emitFwd(R, e1, t1, e2, t2, out) {
  const n = R.length;
  let k = (e2 - e1 + n) % n;                  // vertices e1+1 … e2
  if (k === 0 && !(t2 > t1)) k = n;           // the next node is behind us on this edge: all the way round
  if (k === 0) return;
  if (!(t2 > 0)) k -= 1;                      // vertex e2 is the target node itself
  for (let q = 1; q <= k; q++) out.push(R[(e1 + q) % n]);
}
/** The same walking backward: vertices e1 (unless the node sits on it), e1−1, … e2+1. */
function emitBack(R, e1, t1, e2, t2, out) {
  const n = R.length;
  let k = (e1 - e2 + n) % n;
  if (k === 0 && !(t2 < t1)) k = n;
  if (k === 0) return;
  let v = e1;
  if (!(t1 > 0)) { k -= 1; v = e1 - 1; }
  for (let q = 0; q < k; q++) out.push(R[(((v - q) % n) + n) % n]);
}

// ------------------------------------------------------------------------------------------------ the tree side
const isStock = (n) => !!n && (n.kind === 'stock' || String(n.id || '').startsWith('s:'));
const tickerOf = (n) => String(n.ticker || String(n.id).replace(/^s:/, '')).toUpperCase();

function leavesOf(node, out = new Map(), w = 1) {
  if (!node) return out;
  if (isStock(node)) { const t = tickerOf(node); out.set(t, (out.get(t) || 0) + w); return out; }
  const kids = node.children || [];
  for (const c of kids) leavesOf(c, out, w);
  return out;
}
function lastDV(series) {
  if (!series || !Array.isArray(series.dv)) return null;
  for (let i = series.dv.length - 1; i >= 0; i--) { const v = series.dv[i]; if (Number.isFinite(v) && v > 0) return v; }
  return null;
}
function nodeWeight(c, mapJson) {
  const s = mapJson && mapJson.children && mapJson.children[c.id];
  const v = lastDV(s);
  if (v) return v;
  if (c.now && c.now.dv20 > 0) return c.now.dv20;
  return null;
}
/** Leaf weights below a region child: dv20 where the tree has it (全市场 / 全球), else equal. Also collects names. */
function leafWeights(c, names) {
  const out = new Map();
  const walk = (n) => {
    if (isStock(n)) {
      const t = tickerOf(n);
      const w = n.now && n.now.dv20 > 0 ? n.now.dv20 : n.cap > 0 ? Math.sqrt(n.cap) : 0;
      out.set(t, Math.max(out.get(t) || 0, w));
      if (names && n.name && !names.has(t)) names.set(t, n.name);
      return;
    }
    for (const k of n.children || []) walk(k);
  };
  walk(c);
  const vals = [...out.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const med = vals.length ? vals[vals.length >> 1] : 1;
  for (const [t, v] of out) out.set(t, v > 0 ? v : med);
  return out;
}

/** Owner holdings (DESIGN §20) — the camera never frames them out. */
let holdP = null;
function loadHoldings() {
  if (!holdP) holdP = cfg.fetchJSON(new URL('data/holdings.json', cfg.base).href).then((j) => new Set((j.holdings || []).map((h) => String(h.t || '').toUpperCase()).filter(Boolean))).catch(() => new Set());
  return holdP;
}

/** Curated asset classes: inside them even companies sit where their money ends up (miners → their mines). */
const ASSET_CLASSES = new Set(['bonds', 'commod', 'crypto', 'cash']);
async function inAssetClass(node, tk) {
  if (tk !== 'curated' || !node) return false;
  if (ASSET_CLASSES.has(node.id)) return true;
  const T = await getTree(tk);
  for (let p = T ? T.parent.get(node.id) : null, k = 0; p && k < 12; p = T.parent.get(p.id), k++) if (ASSET_CLASSES.has(p.id)) return true;
  return false;
}

/**
 * Each child → {cls, sites:[{t, lon, lat, w (share of the child), city, cityZh, cc, est, anchor?, offshore?, why?}], …}.
 * cls: 'country' (ISO geography) | 'land' (a region with places) | 'point' (a company / fund) | 'sea' (no place at
 * all: no HQ, no anchor) | 'harbor' (a company we cannot place yet). placelessW = the share of its placed money that
 * is not a company or a country (bonds / cash / crypto / commodity anchors): those never decide country shapes.
 */
function classify(kids, mapJson, node, hq, anc, ctx) {
  const ws = kids.map((c) => nodeWeight(c, mapJson));
  const known = ws.filter((w) => w > 0).sort((a, b) => a - b);
  const med = known.length ? known[known.length >> 1] : 1;
  return kids.map((c, i) => {
    const w = ws[i] > 0 ? ws[i] : med;
    const info = { node: c, id: c.id, w, stock: isStock(c), sites: [], geoW: 0, ngW: 0, unkW: 0, ancW: 0, placelessW: 0, iso: [], cls: null, ngMeta: new Map(), names: new Map() };
    const noteNG = (t, h, share) => {
      // what kind of placeless money this is (bonds / oil / btc / a Europe fund …) → which ocean, which hints
      const sub = hq.meta && hq.meta.sub && hq.meta.sub[t];
      const key = h.kind === 'region' ? 'region:' + (h.cat || '') : (h.cat || 'nongeo') + (sub ? ':' + sub : '');
      const m = info.ngMeta.get(key) || { w: 0, kind: h.kind, cat: h.cat, sub: sub || null, ll: h.lon != null ? [h.lon, h.lat] : null };
      m.w += share;
      info.ngMeta.set(key, m);
    };
    const addAnchors = (L, share, t, placeless) => {
      for (const a of L) {
        info.sites.push({ t, aid: a.id, lon: a.lon, lat: a.lat, city: a.label, cityZh: a.label, cc: null, est: a.est, w: share * a.w, anchor: true, offshore: a.offshore, why: a.why, place: a.place, spread: spreadKm(a) });
      }
      info.geoW += share; info.ancW += share;
      if (placeless) info.placelessW += share;
    };
    const place = (t, share) => {
      const h = hq.map.get(t);
      const A = anc.byTicker.get(t);
      // a fund (nongeo / country / region) → its anchors; inside 债券/商品/加密/现金 a company too (miners → mines)
      if (A && (!h || h.ng || h.kind === 'country' || ctx.assetCtx)) {
        addAnchors(A, share, t, !h || (h.ng && h.kind !== 'region') || ctx.assetCtx);
        return;
      }
      if (h && !h.ng) {
        const f = fineOf(t);
        info.sites.push({ t, lon: f ? f[3] : h.lon, lat: f ? f[4] : h.lat, city: h.city, cityZh: zhCity(h.city, h.cc), cc: h.cc, est: h.est, w: share, fine: !!f });
        info.geoW += share;
      } else if (h) { info.ngW += share; noteNG(t, h, share); } else info.unkW += share;
    };
    if (!info.stock) info.iso = isoForNode(c);
    if (info.stock) {
      const t = tickerOf(c);
      if (c.name) info.names.set(t, c.name);
      place(t, 1);
    } else if (ctx.tk === 'curated' && anc.byNode.has(c.id)) {
      addAnchors(anc.byNode.get(c.id), 1, null, true);
      leafWeights(c, info.names);
    } else {
      const lw = leafWeights(c, info.names);
      let tot = 0;
      for (const v of lw.values()) tot += v;
      for (const [t, v] of lw) place(t, v / (tot || 1));
    }
    if (info.iso.length) info.cls = 'country';                       // ISO geography: the real country shape
    else if (info.stock && !info.geoW && !info.ngW) info.cls = 'harbor';   // a company we cannot place (yet)
    // a region is land when a real share of its money has a place (其他发达 = Canada + Australia + broad ETFs → land)
    else if (info.geoW > 0 && info.geoW >= 0.35 * (info.geoW + info.ngW)) info.cls = info.stock ? 'point' : 'land';
    else info.cls = 'sea';
    if (info.cls === 'sea' && info.geoW === 0 && info.ngW === 0) info.unplaced = true;
    return info;
  });
}
/** Mostly bonds / cash / crypto / commodity money (its places are anchors, not where companies or countries are). */
const isPlaceless = (i) => i.geoW > 0 && i.placelessW > 0.5 * i.geoW;

// ------------------------------------------------------------------------------------------------ view fitting
/**
 * Robust framing: the smallest cap holding `frac` of the weight (outliers — ARM in Cambridge for the chip
 * sector — stay on the globe but out of frame), padded. pts: [{v, w}]. Returns {c (unit), rho (deg)}.
 */
function fitCap(pts, frac = 0.8) {
  if (!pts.length) return null;
  let W = 0;
  for (const p of pts) W += p.w;
  // candidate centres: the heaviest points, midpoints of the heaviest pairs (a coast-to-coast core is centred in
  // Kansas, not on either coast), the weighted mean
  const heavy = pts.slice().sort((a, b) => b.w - a.w);
  const cand = heavy.slice(0, 60).map((p) => p.v);
  const top = heavy.slice(0, 18);
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const m2 = [top[i].v[0] + top[j].v[0], top[i].v[1] + top[j].v[1], top[i].v[2] + top[j].v[2]];
    if (Math.hypot(m2[0], m2[1], m2[2]) > 1e-6) cand.push(unit(m2));
  }
  const m = [0, 0, 0];
  for (const p of pts) { m[0] += p.w * p.v[0]; m[1] += p.w * p.v[1]; m[2] += p.w * p.v[2]; }
  if (Math.hypot(m[0], m[1], m[2]) > 1e-6) cand.push(unit(m));
  let best = null;
  const ds = pts.map(() => [0, 0]);
  for (const c of cand) {
    for (let i = 0; i < pts.length; i++) { ds[i][0] = -dot(c, pts[i].v); ds[i][1] = pts[i].w; }
    ds.sort((a, b) => a[0] - b[0]);
    let acc = 0, r = 0;
    for (const [d, w] of ds) { acc += w; r = d; if (acc >= frac * W - 1e-12) break; }
    r = Math.acos(clamp(-r, -1, 1));
    if (!best || r < best.r - 1e-9) best = { c, r };
  }
  // recentre on the weighted mean of what is inside, then the radius that holds it
  const inside = pts.filter((p) => ang(best.c, p.v) <= best.r + 1e-9);
  const s = [0, 0, 0];
  for (const p of inside) { s[0] += p.w * p.v[0]; s[1] += p.w * p.v[1]; s[2] += p.w * p.v[2]; }
  const cm = Math.hypot(s[0], s[1], s[2]) > 1e-9 ? unit(s) : best.c;
  // the money-weighted centre unless that needs a much wider frame (two coasts → keep the middle)
  let rm = 0;
  for (const p of inside) rm = Math.max(rm, ang(cm, p.v));
  if (rm <= best.r * 1.12) return { c: cm, rho: rm * DEG };
  // halfway: a little toward the money, still holding everything
  const ch = unit([best.c[0] + cm[0] * 0.35, best.c[1] + cm[1] * 0.35, best.c[2] + cm[2] * 0.35]);
  let rh = 0;
  for (const p of inside) rh = Math.max(rh, ang(ch, p.v));
  return rh <= best.r * 1.12 ? { c: ch, rho: rh * DEG } : { c: best.c, rho: best.r * DEG };
}
function viewOf(c, rhoDeg) {
  const [lon, lat] = llOf(c);
  const radius = clamp(rhoDeg, 0.9, 90);
  const scale = radius >= 80 ? 1 : clamp(1 / Math.sin(radius * RAD), 1, 60);
  return { lon: +lon.toFixed(4), lat: +lat.toFixed(4), scale: +scale.toFixed(3), radius: +(scale > 1 ? Math.asin(1 / scale) * DEG : 90).toFixed(3) };
}

/** The money-weighted heaviest metro: sites within `km` of a heavy site (greedy, no chaining), largest Σw. */
function hubOf(sites, km = 60) {
  if (!sites || !sites.length) return null;
  const S = sites.slice().sort((a, b) => b.w - a.w);
  const V = S.map((s) => vec(s.lon, s.lat));
  const cosR = Math.cos(km / 6371);
  let best = null, tot = 0;
  for (const s of S) tot += s.w;
  const used = new Uint8Array(S.length);
  for (let a = 0; a < S.length; a++) {
    if (used[a]) continue;
    let w = 0;
    for (let b = a; b < S.length; b++) if (!used[b] && dot(V[a], V[b]) >= cosR) { w += S[b].w; used[b] = 1; }
    if (!best || w > best.w + 1e-12) best = { w, s: S[a] };
  }
  return { lon: best.s.lon, lat: best.s.lat, w: best.w, share: tot ? best.w / tot : 0, label: best.s.cityZh || best.s.city || null, site: best.s };
}
/** The centre of a cap of fixed radius R (rad) holding the most weight, keeping `mustV` within `mustR` (rad). */
function fixedCap(pts, R, mustV, mustR) {
  const heavy = pts.slice().sort((a, b) => b.w - a.w).slice(0, 40);
  const cand = mustV ? [mustV] : [];
  for (const p of heavy) {
    cand.push(p.v);
    if (mustV) for (const t of [0.25, 0.5, 0.75]) { const q = slerp(mustV, p.v, t); if (Math.hypot(q[0], q[1], q[2]) > 1e-9) cand.push(unit(q)); }
  }
  const cosR = Math.cos(R);
  let best = null;
  for (const c of cand) {
    if (mustV && ang(c, mustV) > mustR + 1e-9) continue;
    let s = 0;
    for (const p of pts) if (dot(c, p.v) >= cosR) s += p.w;
    if (!best || s > best.s + 1e-12) best = { s, c };
  }
  return best ? best.c : mustV || (pts[0] && pts[0].v) || vec(0, 20);
}

// ------------------------------------------------------------------------------------------------ ring helpers
/** A ring of unit vectors → lon/lat ring, longitudes unwrapped around `lon0` (no jumps across ±180). */
function toLL(ring, lon0) {
  const out = [];
  let prev = null;
  for (const v of ring) {
    let [lon, lat] = llOf(v);
    if (prev == null) { while (lon - lon0 > 180) lon -= 360; while (lon - lon0 < -180) lon += 360; }
    else { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
    prev = lon;
    out.push([lon, lat]);
  }
  return out;
}
/** Polygons with unwrapped longitudes → closed rings back in a tidy range (d3 is fine with lon > 180 too). */
function finishPolys(polys) {
  return polys.map((P) => {
    let s = 0, n = 0;
    for (const p of P[0]) { s += p[0]; n++; }
    const k = s / n > 180 ? -360 : s / n < -180 ? 360 : 0;
    return P.map((r) => closeRing(k ? r.map((p) => [round6(p[0] + k), round6(p[1])]) : r.map((p) => [round6(p[0]), round6(p[1])])));
  });
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function discRing(lon, lat, rDeg) {
  const c = globalThis.d3.geoCircle().center([lon, lat]).radius(rDeg).precision(Math.max(2, 360 / 40))();
  return c.coordinates[0];
}
function polysArea(polys) {
  const d3 = globalThis.d3;
  let a = 0;
  for (const P of polys) { const v = d3.geoArea({ type: 'Polygon', coordinates: P }); if (v < TAU) a += v; }
  return a;
}
/** A label point: weighted site centre if it lies on the item, else the heaviest site on it, else an inner point. */
function labelPoint(polys, sites, view) {
  const d3 = globalThis.d3;
  if (!polys.length) return sites.length ? [sites[0].lon, sites[0].lat] : null;
  // the part holding the most site weight (parts the camera can see count far more)
  let best = -1, bw = -1, ba = -1;
  const inView = (s) => !view || d3.geoDistance([s.lon, s.lat], [view.lon, view.lat]) < view.radius * RAD * 0.9;
  // polygons here are planar-safe lon/lat (no antimeridian jumps): a planar test with a bbox gate is exact enough
  const boxes = polys.map((P) => ringBBox(P[0]));
  const inP = (k, s) => {
    const b = boxes[k];
    let x = s.lon;
    if (x < b[0] - 1e-9) x += 360; else if (x > b[2] + 1e-9) x -= 360;
    return x >= b[0] && x <= b[2] && s.lat >= b[1] && s.lat <= b[3] && pipPoly(polys[k], x, s.lat);
  };
  polys.forEach((P, i) => {
    let w = 0;
    for (const s of sites) if (inP(i, s)) w += s.w * (inView(s) ? 1 : 0.03);
    const a = Math.abs(planarArea(P[0]));
    if (w > bw + 1e-12 || (Math.abs(w - bw) < 1e-12 && a > ba)) { bw = w; best = i; ba = a; }
  });
  const P = polys[best];
  const G = { type: 'Polygon', coordinates: P };
  const on = sites.filter((s) => inP(best, s));
  if (on.length) {
    const m = [0, 0, 0];
    for (const s of on) { const v = vec(s.lon, s.lat); m[0] += s.w * v[0]; m[1] += s.w * v[1]; m[2] += s.w * v[2]; }
    const c = llOf(unit(m));
    if (d3.geoContains(G, c)) return [round6(c[0]), round6(c[1])];
    const h = on.slice().sort((a, b) => b.w - a.w)[0];
    return [h.lon, h.lat];
  }
  const c = d3.geoCentroid(G);
  if (d3.geoContains(G, c)) return [round6(c[0]), round6(c[1])];
  // inner point: the bbox grid point farthest inside
  const [w, s, e, n] = ringBBox(P[0]);
  let bp = P[0][0], bd = -1;
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
    const q = [w + ((e - w) * i) / 12, s + ((n - s) * j) / 12];
    if (!pipPoly(P, q[0], q[1])) continue;
    let dmin = Infinity;
    for (const r of P) for (const p of r) { const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (dd < dmin) dmin = dd; }
    if (dmin > bd) { bd = dmin; bp = q; }
  }
  return [round6(bp[0]), round6(bp[1])];
}

/**
 * A coastal place just off a coarse country outline (Starbase, Rio, 深圳 on the 1:50m coast) moved onto that outline:
 * p itself when it is on one of the polygons, else the first of 8 probes at 3, 8, 15, 30 or 50 km that is — so the
 * 主航道 / ①②③ end at the hub lands on the country, not in the sea. Else p.
 */
function landOn(polys, p) {
  if (!polys || !polys.length || !p) return p;
  const bbs = polys.map((P) => ringBBox(P[0]));
  const inAny = (q) => polys.some((P, i) => { const b = bbs[i]; return q[0] >= b[0] && q[0] <= b[2] && q[1] >= b[1] && q[1] <= b[3] && pipPoly(P, q[0], q[1]); });
  if (inAny(p)) return p;
  const c = vec(p[0], p[1]);
  for (const km of [3, 8, 15, 30, 50]) for (let k = 0; k < 8; k++) { const q = llOf(dest(c, (k / 8) * TAU, km / 6371)); if (inAny(q)) return [round6(q[0]), round6(q[1])]; }
  return p;
}
/** A point on the item near p: p itself when it is on one of the polygons, else an inner point of the closest one. */
function snapOnto(polys, p) {
  if (!polys.length || !p) return p;
  const d3 = globalThis.d3;
  let best = -1, bd = Infinity;
  for (let k = 0; k < polys.length; k++) {
    const P = polys[k];
    const b = ringBBox(P[0]);
    let x = p[0];
    if (x < b[0] - 1e-9) x += 360; else if (x > b[2] + 1e-9) x -= 360;
    if (x >= b[0] && x <= b[2] && p[1] >= b[1] && p[1] <= b[3] && pipPoly(P, x, p[1])) return [round6(p[0]), round6(p[1])];
    for (const q of P[0]) { const d = d3.geoDistance(q, p); if (d < bd) { bd = d; best = k; } }
  }
  return labelPoint([polys[best]], [], null);
}
/**
 * The label anchor of a region after the final view: its heaviest in-view metro (snapped onto the item); when less
 * than 20 % of its money is in view, the hub — off-screen — plus an edge chip naming the place ('→ 新竹 台积电').
 */
function centerOf(polys, sites, view, hub, names) {
  const out = { center: null, offscreen: null };
  if (!sites.length || !hub) { out.center = polys.length ? labelPoint(polys, [], null) : null; return out; }
  const cv = vec(view.lon, view.lat), lim = Math.cos(Math.min(89, view.radius * 0.92) * RAD);
  const inV = sites.filter((s) => dot(cv, vec(s.lon, s.lat)) >= lim);
  const tot = sites.reduce((a, s) => a + s.w, 0) || 1;
  const share = inV.reduce((a, s) => a + s.w, 0) / tot;
  let p;
  if (share >= 0.2) { const h = hubOf(inV); p = [h.lon, h.lat]; }
  else {
    p = [hub.lon, hub.lat];
    const t = hub.site && (hub.site.t || (hub.site.ts && hub.site.ts[0]));
    const who = t && names && names.get(t) ? names.get(t) : hub.site && hub.site.why ? hub.site.why : '';
    out.offscreen = { lon: round6(hub.lon), lat: round6(hub.lat), label: ('→ ' + (hub.label || '') + (who ? ' ' + who : '')).trim() };
  }
  out.center = snapOnto(polys, p);
  return out;
}

// ------------------------------------------------------------------------------------------------ layouts
const layouts = new Map();
const lastByNode = new Map();   // treeKey|nodeId → the layout most recently asked for by the app
/** Forget every computed layout (and, with `all`, the loaded data). */
export function clearCache(all = false) {
  layouts.clear();
  lastByNode.clear();
  ladders.clear();
  if (all) {
    HQ = null; hqP = null; hqCheckAt = 0; ANC = null; ancP = null; ancCheckAt = 0; adm1P = null;
    UM = null; umP = null; umCheckAt = 0; unitFiles.clear(); miss.clear(); briefC.clear();
    geos.clear(); trees.clear(); treeP.clear(); holdP = null;
  }
}

/**
 * The §26 provider for mode 'real'.
 * @param node       tree node (any map: 精选 / 全市场 / 全球)
 * @param childNodes its children (defaults to node.children)
 * @param mapJson    the node's map json (children dv weights; optional)
 * @param opts       {map:'curated'|'full'|'global', parent, tree, detail:'50m'|'10m' (force)}
 */
export async function getLayout(node, childNodes, mapJson, opts = {}) {
  const kids = (Array.isArray(childNodes) && childNodes.length ? childNodes : (node && node.children) || []).filter((c) => c && c.id != null);
  if (opts.tree) registerTree(opts.tree, opts.map);
  const [hq, anc, um] = await Promise.all([loadHQ(), loadAnchors(), loadUnitsMeta()]);
  const tk = treeKeyOf(node, opts);
  // (a zoomed re-ask — opts.zoom — only changes the unit level, never the camera: one layout per level; the level
  // comes from the node's own ladder, which its default layout works out — computed first when not known yet)
  let zl = 0, lad = null;
  if (+opts.zoom > 0) {
    const nk = tk + '|' + (node && node.id);
    lad = ladders.get(nk) || null;
    if (!lad && !opts._depth) {
      try { await getLayout(node, kids, mapJson, Object.assign({}, opts, { zoom: undefined, at: undefined })); } catch (e) { /* the default ladder */ }
      lad = ladders.get(nk) || null;
    }
    zl = levelBy(+opts.zoom, lad);
  }
  // (level 3 with a camera centre: the admin3 detail is loaded around it, one layout per 4° cell)
  const atCell = zl === 3 && Array.isArray(opts.at) && fin(opts.at[0]) && fin(opts.at[1]) ? atCellOf(opts.at) : null;
  const key = tk + '|' + (node && node.id) + '|' + hq.version + '.' + anc.version + '.' + um.version + '|z' + zl + (atCell ? '@' + atCell.join(',') : '') + '|' + (opts.detail || '') + '|' + kids.map((c) => c.id + ':' + Math.round(Math.log2(nodeWeight(c, mapJson) || 1) * 2)).join(',');
  if (layouts.has(key)) { if (!opts._depth && !zl) lastByNode.set(tk + '|' + (node && node.id), layouts.get(key)); return layouts.get(key); }
  const p = build(node, kids, mapJson, Object.assign({}, opts, { zoomLevel: zl, atCell, ladder: lad }), hq, anc, tk);
  layouts.set(key, p);
  // what the camera last showed for this node (with the app's real weights): children anchor to it
  if (!zl && (!opts._depth || !lastByNode.has(tk + '|' + (node && node.id)))) lastByNode.set(tk + '|' + (node && node.id), p);
  p.catch(() => layouts.delete(key));
  if (layouts.size > 120) layouts.delete(layouts.keys().next().value);
  return p;
}
export default getLayout;

async function build(node, kids, mapJson, opts, hq, anc, tk) {
  const t0 = cfg.now();
  await ensureLibs();
  const d3 = globalThis.d3;
  const assetCtx = await inAssetClass(node, tk);
  const infos = classify(kids, mapJson, node, hq, anc, { tk, assetCtx });
  const holdings = await loadHoldings();
  // anchors come without a country: look it up (offshore anchors stay at sea)
  if (infos.some((i) => i.sites.some((s) => !s.cc && !s.offshore))) {
    const G50 = await loadGeo('50m');
    for (const i of infos) for (const s of i.sites) if (!s.cc && !s.offshore) s.cc = countryAtGeo(G50, s.lon, s.lat) || countryNear(G50, s.lon, s.lat, 15) || null;
  }
  const land = infos.filter((i) => i.cls === 'land' || i.cls === 'point');
  const countryKids = infos.filter((i) => i.cls === 'country');
  const seaKids = infos.filter((i) => i.cls === 'sea');
  const harborKids = infos.filter((i) => i.cls === 'harbor');
  const items = new Map();
  let view = null, detail = '50m', mode = 'metro', unitsCtx = null, lod = null;
  const debug = { kids: infos.map((i) => ({ id: i.id, cls: i.cls, geo: +i.geoW.toFixed(3), anc: +i.ancW.toFixed(3), ng: +i.ngW.toFixed(3), unk: +i.unkW.toFixed(3), n: i.sites.length })) };
  const par = await parentPlacement(node, opts, tk);
  // the share of this node's money that has no place at all (the camera does not dive onto the little that has one)
  const allW = infos.reduce((a, i) => a + i.w, 0) || 1;
  const unsited = infos.reduce((a, i) => a + (i.cls === 'country' ? 0 : i.w * Math.max(0, 1 - i.geoW)), 0) / allW;
  // today's ①②③ (+ the 主航道's ends): the camera shows where they are (issue 2: ③ 海外股市 · 印度 points at India)
  let focus = [];
  try { focus = await focusOf(node, kids, mapJson, opts, tk, infos, hq, anc); } catch (e) { focus = []; }
  debug.focus = focus.map((f) => f.id + (f.via && f.via !== f.id ? '@' + f.via : ''));

  // ---- country distribution of the geographic land children: separable → real country shapes (美股 = USA …).
  // Bonds / cash / crypto / commodities (anchors, not companies) never decide which country is whose.
  const geoLand = land.filter((i) => !isPlaceless(i));
  const dist = new Map();
  for (const i of geoLand) {
    const m = new Map();
    for (const s of i.sites) { const cc = s.cc || 'XX'; m.set(cc, (m.get(cc) || 0) + s.w); }
    dist.set(i.id, m);
  }
  let countryMode = false;
  if (geoLand.length >= 2 && !geoLand.some((i) => i.stock)) {
    const tot = new Map(), top = new Map();
    for (const i of geoLand) for (const [cc, w] of dist.get(i.id)) {
      const share = w / (i.geoW || 1) * i.w;
      tot.set(cc, (tot.get(cc) || 0) + share);
      top.set(cc, Math.max(top.get(cc) || 0, share));
    }
    let num = 0, den = 0;
    for (const [cc, t] of tot) { if (cc === 'XX') continue; num += top.get(cc); den += t; }
    const homes = new Set(geoLand.map((i) => { let b = null, bw = -1; for (const [cc, w] of dist.get(i.id)) if (w > bw) { bw = w; b = cc; } return b; }));
    debug.separable = den ? +(num / den).toFixed(3) : 0;
    countryMode = den > 0 && num / den >= 0.8 && homes.size >= 2;
  }

  if (countryMode || countryKids.length) {
    mode = 'country';
    const assign = new Map();   // cc → info id
    // Google-Earth consistency: inside 海外股市 only 海外股市's own countries are handed out (Coupang's Seattle HQ
    // must not paint the USA into 亚洲发达)
    const allowed = countryMode && par && par.countries && par.countries.length ? new Set(par.countries) : null;
    if (countryMode) {
      const dom = new Map();
      for (const i of geoLand) {
        const m = dist.get(i.id);
        let b = null, bw = 0;
        for (const [cc, w] of m) if (w > bw) { bw = w; b = cc; }
        if (b && bw / (i.geoW || 1) >= 0.8) dom.set(i.id, b);
      }
      const ccs = new Set();
      for (const i of geoLand) for (const cc of dist.get(i.id).keys()) if (cc !== 'XX') ccs.add(cc);
      for (const cc of ccs) {
        if (allowed && !allowed.has(cc)) continue;
        let b = null, bs = -1;
        for (const i of geoLand) {
          const w = dist.get(i.id).get(cc) || 0;
          if (!w) continue;
          let s = w / (i.geoW || 1);
          // a one-country child (美股 = USA) does not drag its few foreign listings' countries along
          if (dom.has(i.id) && dom.get(i.id) !== cc) { if (s < 0.1) continue; s *= 0.15; }
          if (s > bs) { bs = s; b = i.id; }
        }
        if (b && bs > 0) assign.set(cc, b);
      }
    }
    const shapeKids = countryMode ? geoLand : [];
    const shapes = [];
    const markers = land.filter((i) => !shapeKids.includes(i));
    const ed = 'medium';
    for (const i of countryKids) {
      const s = await earth.shapeOf({ id: i.id, a2: i.iso }, { detail: ed });
      if (s) shapes.push({ info: i, s, a2: i.iso });
    }
    for (const i of shapeKids) {
      const a2 = [...assign].filter(([, id]) => id === i.id).map(([cc]) => cc).filter((cc) => byA2(cc));
      const s = a2.length ? await earth.shapeOf({ id: i.id, a2 }, { detail: ed }) : null;
      if (s) shapes.push({ info: i, s, a2 });
      else markers.push(i);
    }
    // view: where each child's money is (a spread-out child pulls less: its mean vector is short), lightly
    // weighted by size of money — the 精选 world faces the North Atlantic (USA left, Europe right)
    const m = [0, 0, 0];
    const moneyVec = (info, s, a2) => {
      const set = new Set(a2);
      const a = [0, 0, 0];
      let W = 0;
      for (const st of info.sites) {
        if (st.cc && !set.has(st.cc)) continue;
        const u = vec(st.lon, st.lat);
        a[0] += st.w * u[0]; a[1] += st.w * u[1]; a[2] += st.w * u[2]; W += st.w;
      }
      if (W > 0) return [a[0] / W, a[1] / W, a[2] / W];
      return vec(s.center[0], s.center[1]);
    };
    for (const { info, s, a2 } of shapes) { const v = moneyVec(info, s, a2); const w = Math.pow(info.w, 0.3); m[0] += w * v[0]; m[1] += w * v[1]; m[2] += w * v[2]; }
    for (const i of markers) for (const st of i.sites) { const v = vec(st.lon, st.lat); m[0] += 0.02 * st.w * v[0]; m[1] += 0.02 * st.w * v[1]; m[2] += 0.02 * st.w * v[2]; }
    let c = Math.hypot(m[0], m[1], m[2]) > 1e-9 ? unit(m) : vec(-40, 30);
    let rho = 0;
    for (const { s } of shapes) rho = Math.max(rho, ang(c, vec(s.center[0], s.center[1])) * DEG + (s.coreRadius || s.radius || 5));
    if (!shapes.length) for (const i of markers) for (const st of i.sites) rho = Math.max(rho, ang(c, vec(st.lon, st.lat)) * DEG + 2);
    if (rho * 1.08 + 2 >= 80) {
      // a whole-globe view: face the side that shows the most of every child's money (not just the biggest one's)
      const probes = shapes.map(({ info, s, a2 }) => {
        const set = new Set(a2);
        const P = info.sites.filter((st) => !st.cc || set.has(st.cc)).map((st) => ({ v: vec(st.lon, st.lat), w: st.w }));
        if (!P.length) for (const mb of s.members || [{ center: s.center, area: 1 }]) P.push({ v: vec(mb.center[0], mb.center[1]), w: Math.sqrt(mb.area || 1) });
        const W = P.reduce((a, p) => a + p.w, 0) || 1;
        return { P, W, k: Math.pow(info.w, 0.2) };
      });
      // …with today's ①②③ where they can be read: ① ≤ 60° from the centre, ② ≤ 65°, ③ ≤ 72° — all three if they
      // fit, else ① and ② (③ is then marked inView:false in layout.focus and its card points over the horizon via
      // childAt: squeezing the USA onto the rim to catch India at 80° shows neither), else ①
      const fv = focus.filter((f) => f.rank < 3 && f.ll).map((f) => vec(f.ll[0], f.ll[1]));
      const lim = [60, 65, 72].map((d) => Math.cos(d * RAD));
      let best = null;
      for (let need = fv.length; need >= 0 && !best; need--) {
        // (≤ 50° N: a view tilted any further turns the USA on its side to reach Asia over the pole)
        for (let la = -20; la <= (need ? 40 : 60); la += 5) for (let lo = -180; lo < 180; lo += 5) {
          const cv = vec(lo, la);
          let ok = true;
          for (let q = 0; q < need && ok; q++) if (dot(cv, fv[q]) < lim[q]) ok = false;
          if (!ok) continue;
          let sc = 0;
          for (const pr of probes) { let v = 0; for (const p of pr.P) { const d = dot(cv, p.v); if (d > 0) v += p.w * Math.pow(d, 1.5); } sc += pr.k * v / pr.W; }
          // (…and not squeezed toward the rim: a ①②③ 50° from the centre is read easily, one at 70° less so)
          for (let q = 0; q < need; q++) sc *= 0.75 + 0.25 * clamp((dot(cv, fv[q]) - lim[q]) / (Math.cos(50 * RAD) - lim[q]), 0, 1);
          if (!best || sc > best.sc + 1e-9) best = { sc, cv, need };
        }
      }
      if (best) { c = best.cv; debug.focusOnFace = best.need; }
    }
    view = viewOf(c, rho * 1.08 + 2);
    for (const { info, s, a2 } of shapes) {
      let polys = s.polygons.map((P) => P.map((r) => closeRing(r)));
      // (a whole-globe view does not need the hundreds of skerries of the Arctic or Indonesia: islets under ~600 km²
      // that hold none of this child's money go, the island countries and every place with money stay)
      if (polys.length > 20) {
        const ar = polys.map((P) => { const b = ringBBox(P[0]); return { P, b, A: Math.abs(planarArea(P[0])) * Math.cos(((b[1] + b[3]) / 2) * RAD) }; });
        const big = Math.max(...ar.map((x) => x.A));
        const cut = Math.min(Math.pow(0.0025 * view.radius, 2), 0.002 * big);
        polys = ar.filter((x) => x.A >= cut || x.A === big || info.sites.some((st) => st.lon >= x.b[0] && st.lon <= x.b[2] && st.lat >= x.b[1] && st.lat <= x.b[3] && pipPoly(x.P, st.lon, st.lat))).map((x) => x.P);
      }
      // label: a several-country child is named on its heaviest country that the camera can see
      let center = s.center;
      if (a2.length > 1 && info.sites.length) {
        const byCC = new Map();
        for (const st of info.sites) if (st.cc && a2.includes(st.cc)) byCC.set(st.cc, (byCC.get(st.cc) || 0) + st.w);
        let bc = null, bs = 0;
        for (const [cc, w] of byCC) {
          const cs = await earth.shapeOf({ id: cc, a2: [cc] }, { detail: ed });
          if (!cs || cs.tiny) continue;
          const vis = Math.cos(Math.min(Math.PI / 2, ang(c, vec(cs.center[0], cs.center[1]))));
          const sc = w * vis * vis * Math.pow(cs.area, 0.25);
          if (sc > bs) { bs = sc; bc = cs.center; }
        }
        if (bc) center = bc;
      }
      const it = { id: info.id, kind: 'land', shape: 'country', polygons: polys, rings: [].concat(...polys), center, area: s.area, countries: a2 };
      // the real units this territory is made of (here: whole countries, level 0), with the child's money share in each
      {
        const byCC = new Map();
        let W = 0;
        for (const st of info.sites) if (st.cc && a2.includes(st.cc)) { byCC.set(st.cc, (byCC.get(st.cc) || 0) + st.w); W += st.w; }
        it.units = a2.map((cc) => ({ id: cc, level: 0, w: +((byCC.get(cc) || 0) / (W || 1)).toFixed(4) })).sort((a, b) => b.w - a.w);
      }
      if (info.sites.length) { const h = hubOf(info.sites.filter((st) => !st.cc || a2.includes(st.cc))); if (h) { it.hub = landOn(polys, [round6(h.lon), round6(h.lat)]); it.hubLabel = h.label; } }
      if (s.tiny || Math.sqrt(s.area / Math.PI) * DEG < view.radius * 0.012) {
        // too small to see or pick at this zoom (香港, 新加坡): a pickable dot on top of the real shape
        const r = Math.max(view.radius * 0.012, 0.25);
        Object.assign(it, { kind: 'point', at: s.center, r, shapePolygons: polys, rings: [discRing(s.center[0], s.center[1], r)], polygons: undefined });
      }
      items.set(info.id, it);
    }
    // the rest — 债券 / 现金 / 加密 / 商品 at the world view, or anything without its own country — is a marker at
    // its hub (the heaviest place its money goes: 华盛顿, 纽约 …), never a sea
    const mk = markers.map((i) => ({ i, h: hubOf(i.sites) })).filter((x) => x.h);
    const wmax = Math.max(1e-12, ...mk.map((x) => x.i.w));
    for (const { i, h } of mk) {
      const r = clamp(view.radius * 0.018 * Math.pow(i.w / wmax, 0.2), view.radius * 0.011, view.radius * 0.024);
      const at = [round6(h.lon), round6(h.lat)];
      const top = i.sites.slice().sort((a, b) => b.w - a.w);
      const it = { id: i.id, kind: 'point', at, center: at.slice(), r, rings: [closeRing(discRing(at[0], at[1], r))], area: Math.PI * (r * RAD) ** 2, city: h.site.city, cityZh: h.label, cc: h.site.cc, est: !!h.site.est, place: h.label, hub: at.slice(), hubLabel: h.label, hubShare: +h.share.toFixed(3) };
      if (i.ancW > 0) it.anchors = top.slice(0, 8).map((q) => ({ label: q.city, why: q.why || null, w: +q.w.toFixed(4), lon: round6(q.lon), lat: round6(q.lat), est: !!q.est }));
      {
        const byCC = new Map();
        for (const q of i.sites) if (q.cc) byCC.set(q.cc, (byCC.get(q.cc) || 0) + q.w);
        const W = [...byCC.values()].reduce((a, b) => a + b, 0) || 1;
        it.units = [...byCC].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([cc, w]) => ({ id: cc, level: 0, w: +(w / W).toFixed(4) }));
      }
      items.set(i.id, it);
    }
    debug.assign = Object.fromEntries(assign);
    unitsCtx = { level: 0, files: [] };
    lod = lodOf(0, true);
  } else if (land.length) {
    // ---- metros: companies at their HQs, funds at their anchors, sectors = where their money is
    // a country node (日本, 德国 — or 美股, which its parent drew as the USA) is framed as that country, not as
    // the one city where most of its money sits
    let frame = null;
    try {
      let a2 = isoForNode(node);
      // (only the 精选 tree draws whole countries below the root; 全市场 / 全球 sectors never are one)
      if (!a2.length && tk === 'curated' && par && par.shape === 'country' && par.countries && par.countries.length === 1) a2 = par.countries;
      if (a2.length) {
        const sh = await earth.shapeOf({ id: node.id, a2 }, { detail: 'medium' });
        if (sh && sh.polygons && sh.polygons.length) {
          const P = sh.polygons[0];
          const c0 = d3.geoCentroid({ type: 'Polygon', coordinates: P });
          let r = 0;
          const ring = P[0], st = Math.max(1, Math.floor(ring.length / 300));
          for (let k = 0; k < ring.length; k += st) r = Math.max(r, d3.geoDistance(c0, ring[k]));
          frame = { c: vec(c0[0], c0[1]), r: r * DEG };
        }
      }
    } catch (e) { frame = null; }
    // §26 amendment 4: territories = dissolved real administrative units (the old city-patch layout only if that
    // throws — counted in debug.fallback, never silently)
    let lay = null;
    mode = 'units';
    try { lay = await unitLayout(land, holdings, Object.assign({}, opts, { frame, par, unsited, focus })); } catch (e) { console.warn('[real] 行政区画法出错，这一层先用旧的城市色块：', e && e.stack || e); debug.fallback = 'metro: ' + (e && e.message); }
    if (!lay) { lay = await metroLayout(land, holdings, Object.assign({}, opts, { frame, par, unsited })); mode = 'metro'; }
    view = lay.view; detail = lay.detail;
    for (const it of lay.items) items.set(it.id, it);
    debug.units = lay.debug;
    if (lay.unitsCtx) unitsCtx = lay.unitsCtx;
    if (lay.lod) lod = lay.lod;
    // (the node's zoom ladder, from its default view: zoomed re-asks pick their unit level by it)
    if (lay.ladder && !opts.zoomLevel) ladders.set(tk + '|' + node.id, lay.ladder);
  }

  // ---- seas: only money that has no place at all (no HQ, no anchor) — a small '未定位' sea, never a named ocean
  // area pretending to be a place — plus one harbour holding the companies we cannot place yet
  if (seaKids.length || harborKids.length) {
    if (!view) {
      // nothing on land: look at where the parent put this node, else the usual ocean of this money
      const pref = par && par.center ? par.center : seaPrefer(node, dominantNG({ ngMeta: mergeNG(seaKids) })) || [-45, 33];
      const r0 = par ? clamp(par.radius * 2.4, 9, 42) : 26;
      view = viewOf(vec(pref[0], pref[1]), r0);
    }
    const obstaclesOf = () => {
      const obstacles = [];
      for (const it of items.values()) {
        if (it.polygons) for (const P of it.polygons) obstacles.push(P);
        else if (it.rings) for (const r of it.rings) obstacles.push([r]);
      }
      return obstacles;
    };
    const seaIn = seaKids.map((i) => {
      const meta = dominantNG(i);
      return {
        id: i.id, name: i.node.name, weight: i.w, node: i.node,
        prefer: seaPrefer(i.node, meta) || (par && par.kind === 'sea' ? par.center : null),
        hint: (meta && meta.sub && hq.meta.hints && hq.meta.hints[meta.sub]) || seaHints(i.node, meta),
        unplaced: true,
      };
    });
    if (harborKids.length) seaIn.push({ id: '__harbor', name: '未定位', weight: harborKids.reduce((a, i) => a + i.w, 0), prefer: null, unplaced: true });
    const landW = land.reduce((s, i) => s + (items.has(i.id) ? i.w : 0), 0) + countryKids.reduce((s, i) => s + i.w, 0);
    const place = async (v) => {
      const G = await loadGeo(v.radius < 6 ? '10m' : v.radius < 25 ? '50m' : 'medium');
      return placeSeas({
        view: v, seas: seaIn, land: G.land, obstacles: obstaclesOf(), landWeight: landW,
        landAreas: [...items.values()].filter((it) => it.kind !== 'point').map((it) => it.area),
        isLand: (lon, lat) => countryAtGeo(G, lon, lat) != null,
      });
    };
    let seas = await place(view);
    // too little water in view (a land-locked view, a pond on the Highveld): step back until there is real water
    const worstOf = (S) => S.length < seaIn.length ? 0 : Math.min(...S.map((x) => (x.id === '__harbor' ? 1 : x.fill || 1)));
    for (let k = 0; k < 4 && view.radius < 60; k++) {
      const worst = worstOf(seas);
      if (worst >= 0.4) break;
      const wider = viewOf(vec(view.lon, view.lat), view.radius * 1.35);
      const again = await place(wider);
      if (worstOf(again) <= worst && again.length >= seas.length) break;
      view = wider; seas = again;
    }
    for (const s of seas) if (s.id !== '__harbor') items.set(s.id, Object.assign(s, { unplaced: true, seaName: s.sea || null, sea: '未定位' }));
    const hb = seas.find((x) => x.id === '__harbor');
    if (hb && harborKids.length) {
      // a tidy sunflower of markers inside the harbour sea, heaviest in the middle
      const hk = harborKids.slice().sort((a, b) => b.w - a.w);
      const R = Math.sqrt(hb.area / Math.PI);
      const r = clamp(R / (1.25 * Math.sqrt(hk.length) + 1), view.radius * 0.004 * RAD, view.radius * 0.02 * RAD);
      const c = vec(hb.center[0], hb.center[1]);
      hk.forEach((i, k) => {
        const p = llOf(k === 0 ? c : dest(c, k * GOLD, 2.1 * r * Math.sqrt(k)));
        const rd = r * DEG;
        items.set(i.id, { id: i.id, kind: 'point', center: [round6(p[0]), round6(p[1])], at: null, r: rd, rings: [closeRing(discRing(p[0], p[1], rd))], area: Math.PI * r * r, est: true, unplaced: true, sea: '未定位', cell: [] });
      });
    }
  }

  if (!view) view = viewOf(vec(-40, 30), 90);
  // context: US states when the camera is inside the US; province / prefecture lines of the countries in view
  const context = {};
  try {
    const Gm = await loadGeo('medium');
    if (view.radius < 40 && countryAtGeo(Gm, view.lon, view.lat) === 'US') context.states = true;
    if (view.radius < 25) {
      const avail = await loadAdmin1Index();
      if (avail.size) {
        const seen = new Map();
        const cv = vec(view.lon, view.lat);
        const add = (lon, lat, w) => { const cc = countryAtGeo(Gm, lon, lat); if (cc && avail.has(cc)) seen.set(cc, (seen.get(cc) || 0) + w); };
        add(view.lon, view.lat, 1000);
        for (let k = 0; k < 64; k++) { const p = llOf(dest(cv, k * GOLD, view.radius * 0.9 * RAD * Math.sqrt((k + 0.5) / 64))); add(p[0], p[1], 1); }
        let list = [...seen].sort((a, b) => b[1] - a[1]).map(([cc]) => cc);
        if (context.states) list = list.filter((cc) => cc !== 'US');
        if (list.length) context.admin1 = list.slice(0, 6);
      }
    }
  } catch (e) { /* no context */ }
  // every child gets a place, whatever happened above (the renderer falls back to the old planet otherwise)
  for (const c of kids) {
    if (items.has(c.id)) continue;
    const p = llOf(dest(vec(view.lon, view.lat), (hash32(c.id) % 360) * RAD, view.radius * 0.7 * RAD));
    const r = Math.max(view.radius * 0.012, 0.05);
    items.set(c.id, { id: c.id, kind: 'point', at: null, center: [round6(p[0]), round6(p[1])], r, rings: [closeRing(discRing(p[0], p[1], r))], area: Math.PI * (r * RAD) ** 2, unplaced: true, sea: '未定位', est: true });
  }
  // 上市地 (issue 7): only a listing venue the parent drew as one small place (港股 → 香港) whose companies sit in
  // another country (深圳, 北京 …) — never 海外股市 / 债券 / 加密, whose 'place' is not where they are listed
  const venue = isoForNode(node);
  if (par && par.kind === 'point' && Array.isArray(par.center) && venue.length === 1) {
    for (const it of items.values()) {
      if (it.unplaced || it.kind === 'sea') continue;
      const h = it.hub || it.at || it.center;
      if (!h) continue;
      const cc = it.kind === 'point' ? it.cc : it.hubCC;
      const far = d3.geoDistance(h, par.center) * DEG > Math.max(1.2, Math.min(par.radius || 0, 12));
      if (far && cc && cc !== venue[0]) {
        it.listedAt = [round6(par.center[0]), round6(par.center[1])];
        it.listed = (node.name || '') + '上市' + (it.hubLabel || it.cityZh || it.city ? ' · 总部在' + (it.hubLabel || it.cityZh || it.city) : '');
      }
    }
  }
  // a single company / fund whose place is off the view gets an edge chip too ('→ 北京'), like the regions (issue 3)
  {
    const cv = vec(view.lon, view.lat), lim = Math.cos(Math.min(89, view.radius * 0.92) * RAD);
    for (const it of items.values()) {
      if (it.kind !== 'point' || it.unplaced || it.offscreen || !Array.isArray(it.at)) continue;
      if (dot(cv, vec(it.at[0], it.at[1])) >= lim) continue;
      const where = it.cityZh || it.place || it.city || it.hubLabel || null;
      if (where) it.offscreen = { lon: it.at[0], lat: it.at[1], label: '→ ' + where };
    }
  }
  // childAt: where each grandchild's money is (a card '海外股市 › 印度' points at India, not at Canada)
  try {
    const ca = await childAtFor(node, kids, items, focus, hq, anc, tk);
    for (const [id, m] of ca) { const it = items.get(id); if (it && m.size) it.childAt = Object.fromEntries(m); }
  } catch (e) { debug.childAtError = e && e.message; }
  const out = [];
  for (const c of kids) { const it = items.get(c.id); if (it) out.push(it); }
  if (!land.length && !countryKids.length) mode = 'seas';
  if (!lod) lod = lodOf(levelBy(view.scale, null));
  // (a level drawn without units — whole countries, seas — keeps the default ladder, so zoomed re-asks of it are keyed
  // by level and not by every zoom step)
  if (!opts.zoomLevel && node && node.id != null && !ladders.has(tk + '|' + node.id)) ladders.set(tk + '|' + node.id, { a2: ZOOM_A2, a3: ZOOM_A3 });
  if (unitsCtx) context.units = unitsCtx;
  const res = { mode: 'real', view, items: out, context, detail, front: [view.lon, view.lat], layout: mode, source: hq.src, anchors: anc.ok, lod };
  {
    const cv = vec(view.lon, view.lat), lim = Math.cos(Math.min(89, view.radius * 0.95) * RAD);
    res.focus = focus.map((f) => ({ id: f.id, via: f.via, rank: f.rank, at: f.ll ? [round6(f.ll[0]), round6(f.ll[1])] : null, label: f.label || null, inView: !!f.ll && dot(cv, vec(f.ll[0], f.ll[1])) >= lim }));
  }
  res.debug = Object.assign(debug, { ms: Math.round(cfg.now() - t0), hq: hq.src, n: out.length });
  return res;
}

/** The heaviest kind of placeless money in a child: {kind, cat, sub, ll, w} | null. */
function dominantNG(info) {
  let best = null;
  for (const m of (info.ngMeta || new Map()).values()) if (!best || m.w > best.w) best = m;
  return best;
}
function mergeNG(infos) {
  const out = new Map();
  for (const i of infos) for (const [k, m] of i.ngMeta || []) {
    const o = out.get(k) || Object.assign({}, m, { w: 0 });
    o.w += m.w * (i.w || 1);
    out.set(k, o);
  }
  return out;
}

/** Where the parent's real layout put this node: {kind, shape, center, hub, radius (deg), countries, view} | null. */
async function parentPlacement(node, opts, tk) {
  if (!node || node.id == null || (opts._depth || 0) > 6) return null;
  let parent = opts.parent || null;
  if (!parent) {
    const T = await getTree(tk);
    parent = T ? T.parent.get(node.id) : null;
  }
  if (!parent || !parent.children) return null;
  try {
    const seen = lastByNode.get(tk + '|' + parent.id);
    const L = seen ? await seen : await getLayout(parent, parent.children, null, Object.assign({}, opts, { parent: undefined, _depth: (opts._depth || 0) + 1, map: tk }));
    const it = L.items.find((x) => x.id === node.id);
    if (!it || !it.center) return null;
    const r = Math.sqrt((it.area || 0) / Math.PI) * DEG;
    return { kind: it.kind, shape: it.shape || null, center: it.center, hub: it.hub || null, radius: r || 5, countries: it.countries || (it.cc ? [it.cc] : null), view: L.view || null };
  } catch (e) { return null; }
}

// ------------------------------------------------------------------------------------------------ unit levels
// The unit ladder (§26 amendment 4) by camera zoom (view.scale; span across ≈ 2·asin(1/zoom)):
//   zoom ≤ 3.63 (≥ 32° across: world / continent)  → level 1: admin1 (state / province / prefecture)
//   3.63 < zoom < 40 (country / region)             → level 2: admin2 (US county, CN 地级市, JP 市区町村, EU NUTS3 …)
//   zoom ≥ 40 (≤ 2.9° across: a metro)              → level 3: admin3 where it exists (Bay Area cities, 区/县, wards …)
// (the world map's own children are countries — level 0 — whatever the zoom). A layout is computed for its node's
// default view; a renderer whose free camera leaves [lod.zoomMin, lod.zoomMax) asks getLayout(…, {zoom}) again: same
// view, same items, the territories rebuilt from the units of that zoom.
const ZOOM_A2 = 3.63, ZOOM_A3 = 40;
// Refine (critics 2026-10-28 17:00: "one wheel notch from ×3.5 to ×3.8 turns the coloured USA into a grey county
// mesh with confetti specks"): a view switches to admin2 only once its typical county is ≥ UNIT_PX pixels across on
// screen — the money-weighted median admin2 unit of the countries in view (US county ≈ 0.37° → ×8, IN district ×5.7,
// DE NUTS3 / GB local authority / JP 市区町村 ×10 (A2_MAX), CN 地级市 / FR département stay at ×3.63). Until then states / provinces /
// prefectures are painted with the dominated counties carved out (level 1), which is what keeps the colour on the
// map. One ladder per node (its default view's countries): layout.lod / levelForZoom(z, node, map) / ladderFor().
// (the renderers draw the globe at zoom 1 with a radius of 0.84 × half the free map height — ≈ 294 px on a 1440 × 900
// window, ≈ 5.1 px per degree at the centre — and zoom multiplies it)
const UNIT_PX = 15, PX_PER_DEG = 5.1;
const A2_MAX = 10;
const ladders = new Map();     // treeKey|nodeId → {a2, a3} of its default view
/** The 4° cell a camera centre falls in ([lon, lat] of the cell centre). */
function atCellOf(at) { return [Math.floor(wrapLon(+at[0]) / 4) * 4 + 2, Math.floor(clamp(+at[1], -89.9, 89.9) / 4) * 4 + 2]; }
function levelBy(z, lad) {
  const a2 = lad && lad.a2 > 0 ? lad.a2 : ZOOM_A2, a3 = lad && lad.a3 > 0 ? lad.a3 : ZOOM_A3;
  return !(z > 0) ? 1 : z >= a3 ? 3 : z >= a2 ? 2 : 1;
}
/**
 * The unit level for a camera zoom (1 | 2 | 3). With a node (and its map): that node's own ladder once its default
 * layout has been computed (ladderFor), else the default ladder (admin2 from ×3.63, admin3 from ×40).
 */
export function levelForZoom(z, node, map) { return levelBy(z, node ? ladderFor(node, map) : null); }
/** The zoom ladder of a node's layouts ({a2, a3}: admin2 from zoom a2, admin3 from a3), or null until it is known. */
export function ladderFor(node, map) {
  if (!node || node.id == null) return null;
  return ladders.get(treeKeyOf(node, { map }) + '|' + node.id) || null;
}
function lodOf(level, territories = true, lad = null) {
  const a2 = lad && lad.a2 > 0 ? lad.a2 : ZOOM_A2, a3 = lad && lad.a3 > 0 ? lad.a3 : ZOOM_A3;
  const lo = level === 3 ? a3 : level === 2 ? a2 : 0;
  const hi = level === 3 ? null : level === 2 ? a3 : level === 1 ? a2 : null;
  return { level, zoomMin: level === 0 ? 0 : lo, zoomMax: level === 0 ? null : hi, territories, ladder: [{ level: 1, zoomMin: 0 }, { level: 2, zoomMin: +a2.toFixed(3) }, { level: 3, zoomMin: +a3.toFixed(3) }] };
}
/**
 * The ladder of a view: admin2 from the zoom at which the money-weighted median admin2 unit of the countries in view
 * (≥ 10 % of its money each) is UNIT_PX across, clamped to [×3.63, ×A2_MAX]; admin3 from ×40 (or 2.5× that, if later).
 */
async function ladderOf(view, raw, um) {
  const cv = vec(view.lon, view.lat), cosR = Math.cos(Math.min(89, view.radius) * RAD);
  const byCC = new Map();
  let W = 0;
  for (const s of raw) {
    if (!s.cc || s.offshore || s.info.stock || dot(cv, s.v) < cosR) continue;
    byCC.set(s.cc, (byCC.get(s.cc) || 0) + s.w); W += s.w;
  }
  let lw = 0, ww = 0;
  for (const [cc, w] of [...byCC].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    if (w < 0.1 * W || !um.idx2.has(cc)) continue;
    const F2 = await unitFile(2, cc);
    if (!F2 || !F2.list.length) continue;
    if (F2.medSide == null) { const s = F2.list.map((U) => Math.sqrt(Math.max(U.A, 1e-9))).sort((a, b) => a - b); F2.medSide = s[s.length >> 1]; }
    lw += w * Math.log(F2.medSide); ww += w;
  }
  if (!ww) return { a2: ZOOM_A2, a3: ZOOM_A3 };
  const a2 = clamp(UNIT_PX / (PX_PER_DEG * Math.exp(lw / ww)), ZOOM_A2, A2_MAX);
  return { a2: +a2.toFixed(2), a3: Math.max(ZOOM_A3, +(a2 * 2.5).toFixed(2)) };
}

// ------------------------------------------------------------------------------------------------ attention (①②③)
// Today's ①②③ and the 主航道's ends, computed like geo/silhouettes.js (words.js + brief.json), so every view shows
// them: on the root the deep spotlights of brief.json (债券, 特斯拉, 海外股市 › 印度 …), elsewhere words.attentionPicks.
let wordsP = null;
const briefC = new Map();
function loadWords() { return wordsP || (wordsP = import('../words.js').catch(() => null)); }
function loadBrief(tk) {
  const p = cfg.briefPath && cfg.briefPath[tk];
  if (!p) return Promise.resolve(null);
  const c = briefC.get(tk);
  if (c && cfg.now() - c.at < 5 * 60000) return c.p;
  const q = cfg.fetchJSON(new URL(p, cfg.base).href).catch(() => null);
  briefC.set(tk, { at: cfg.now(), p: q });
  return q;
}
/** → [{id (any depth), via (the child it lives in), rank, ll:[lon,lat]|null, label}] (≤ 5, most important first). */
async function focusOf(node, kids, mapJson, opts, tk, infos, hq, anc) {
  const ids = new Set(kids.map((c) => c.id));
  const want = [];
  const add = (id, via) => { if (id != null && via != null && ids.has(via) && !want.some((w) => w.id === id)) want.push({ id, via, rank: want.length }); };
  if (Array.isArray(opts.focus)) {
    for (const f of opts.focus) { const id = f && typeof f === 'object' ? f.id : f; add(id, (f && typeof f === 'object' && f.via) || id); }
  } else {
    const isRoot = node && node.id === 'world';
    const brief = isRoot ? await loadBrief(tk) : null;
    if (brief && Array.isArray(brief.spotlight)) {
      for (const s of brief.spotlight) {
        if (want.length >= 3) break;
        const p = Array.isArray(s && s.pathIds) ? s.pathIds : [];
        add(s && s.id, ids.has(s && s.id) ? s.id : p.find((x) => ids.has(x)));
      }
    }
    if (mapJson && mapJson.children && kids.length > 1) {
      const W = await loadWords();
      if (W) {
        try { for (const p of W.attentionPicks(mapJson, kids, undefined, 6) || []) { if (want.length >= 3) break; add(p.id, p.id); } } catch (e) { /* no picks */ }
        let ch = brief && brief.channel && (ids.has(brief.channel.from) || ids.has(brief.channel.to)) ? brief.channel : null;
        if (!ch) try { ch = W.mainChannel(mapJson, kids, undefined); } catch (e) { ch = null; }
        if (ch) { add(ch.to, ch.to); add(ch.from, ch.from); }
      }
    }
  }
  const T = await getTree(tk);
  const out = [];
  for (const f of want.slice(0, 5)) {
    let info = f.id === f.via ? infos.find((i) => i.id === f.id) : null;
    if (!info) {
      const n = (T && T.byId.get(f.id)) || null;
      if (n) info = classify([n], null, null, hq, anc, { tk, assetCtx: await inAssetClass(n, tk) })[0];
    }
    const pl = info ? await placeOfInfo(info) : null;
    out.push(Object.assign(f, { ll: pl ? pl.ll : null, label: pl ? pl.label : null }));
  }
  return out;
}
/** Where a node's money is: its money hub (heaviest metro), else its country's centre. */
async function placeOfInfo(i) {
  const S = (i.sites || []).filter((s) => fin(s.lon) && fin(s.lat));
  if (S.length) { const h = hubOf(S); return { ll: [round6(h.lon), round6(h.lat)], label: h.label }; }
  if (i.iso && i.iso.length) {
    const sh = await earth.shapeOf({ id: i.id, a2: i.iso }, { detail: 'medium' }).catch(() => null);
    if (sh && sh.center) return { ll: [round6(sh.center[0]), round6(sh.center[1])], label: null };
  }
  return null;
}
/**
 * item.childAt for every child: {grandchildId: [lon, lat]} — the money hub of each grandchild (≤ 400), plus deeper
 * nodes the brief / focus names below it (③ 海外股市 › 新兴市场 › 印度 → 孟买).
 */
async function childAtFor(node, kids, items, focus, hq, anc, tk) {
  const out = new Map();
  const T = await getTree(tk);
  const brief = node && node.id === 'world' ? await loadBrief(tk) : null;
  for (const c of kids) {
    if (!c || !c.children || !c.children.length || !items.has(c.id)) continue;
    const m = new Map();
    const actx = await inAssetClass(c, tk);
    const gk = c.children.filter((g) => g && g.id != null).slice(0, 400);
    for (const i of classify(gk, null, c, hq, anc, { tk, assetCtx: actx })) {
      const pl = await placeOfInfo(i);
      if (pl) m.set(i.id, pl.ll);
    }
    const deep = new Set();
    for (const f of focus || []) if (f.via === c.id && f.id !== c.id && !m.has(f.id)) deep.add(f.id);
    if (brief && Array.isArray(brief.spotlight)) for (const s of brief.spotlight) if (s && Array.isArray(s.pathIds) && s.pathIds.includes(c.id) && s.id !== c.id && !m.has(s.id)) deep.add(s.id);
    for (const id of deep) {
      const f = (focus || []).find((x) => x.id === id && x.ll);
      if (f) { m.set(id, f.ll.slice()); continue; }
      const n = T && T.byId.get(id);
      if (!n) continue;
      const pl = await placeOfInfo(classify([n], null, null, hq, anc, { tk, assetCtx: await inAssetClass(n, tk) })[0]);
      if (pl) m.set(id, pl.ll);
    }
    out.set(c.id, m);
  }
  return out;
}
/** Widen (and nudge) a view so today's ①②③ sit in it — only when that costs ≤ 1.7× the money frame (else edge chips). */
function focusView(view, focus) {
  const F = (focus || []).filter((f) => f.ll && f.rank < 3);
  if (!F.length || view.radius >= 80) return view;
  let c = vec(view.lon, view.lat), rho = view.radius;
  const rho0 = rho, keep = [];
  for (const f of F) {
    const p = vec(f.ll[0], f.ll[1]);
    if (ang(c, p) * DEG <= 0.85 * rho) { keep.push(p); continue; }
    const c2 = unit(slerp(c, p, 0.15));
    let need = rho + ang(c, c2) * DEG;
    for (const q of keep.concat([p])) need = Math.max(need, (ang(c2, q) * DEG) / 0.85);
    if (need <= 1.7 * rho0) { c = c2; rho = need; keep.push(p); }
  }
  return rho === view.radius && keep.length === F.length && ang(c, vec(view.lon, view.lat)) < 1e-9 ? view : viewOf(c, rho);
}

// ------------------------------------------------------------------------------------------------ unit layout
/**
 * §26 amendment 4. Companies at their HQs and funds at their anchors → each sits in a real administrative unit of the
 * level for this zoom; each unit belongs to the child with the most money in it (ties → the bigger child); a
 * territory = the dissolved union of its units (topojson.merge: Santa Clara County, Harris County, 海淀区…). At
 * level 1 a state / province is the union of its admin2 units (one topology, no slivers), and a county where another
 * child dominates is carved out of it for that child (when it holds ≥ 0.2 % of the view's money, or that child would
 * otherwise have no land at all). Other children present in a unit → `ticks` (dots) + `metros[].members` (hover).
 * A child that owns no unit at all is a point (its money hub) with ticks. Units holding < 0.04 % of the view's
 * money are left neutral when their owner has bigger ones (dots instead), and that threshold rises until the view
 * has ≤ 260 polygons. Stock children are markers at their place, as before.
 */
async function unitLayout(land, holdings, opts) {
  const d3 = globalThis.d3;
  const t0 = cfg.now();
  const st = { level: 0, sites: 0, units: 0, owned: 0, carved: 0, dust: 0, patch: 0, country: 0, a1: 0, a2: 0, a3: 0, noUnit: 0, src: {}, polys: 0, θ: 0 };
  const debug = { stats: st };
  // ---- sites: one per (child, place); co-located leaves of one child merge
  const raw = [];
  for (const i of land) {
    const m = new Map();
    for (const s of i.sites) {
      const k = Math.round(s.lon * 50) + ',' + Math.round(s.lat * 50) + (s.offshore ? 'o' : '') + (s.spread ? 's' : '');
      let q = m.get(k);
      if (!q) m.set(k, (q = { group: i.id, info: i, lon: s.lon, lat: s.lat, cc: s.cc, est: true, city: s.city, cityZh: s.cityZh || null, anchor: !!s.anchor, offshore: !!s.offshore, spread: s.spread || 0, why: s.why || null, w: 0, ts: [], aids: [], hold: false }));
      q.w += s.w * i.w;
      if (s.t && !q.ts.includes(s.t)) q.ts.push(s.t);
      if (s.aid && !q.aids.includes(s.aid)) q.aids.push(s.aid);
      if (!s.est) q.est = false;
      if (s.t && holdings.has(s.t)) q.hold = true;
      if (!q.why && s.why) q.why = s.why;
    }
    for (const q of m.values()) { q.v = vec(q.lon, q.lat); q.t = q.ts[0] || null; raw.push(q); }
  }
  const allStocks = land.every((i) => i.stock);
  // each child's money hub (the camera of a sector shows where its children are, not only its richest town)
  const kidHubs = [];
  if (!allStocks) {
    const by = new Map();
    for (const s of raw) { if (s.offshore || s.info.stock) continue; if (!by.has(s.group)) by.set(s.group, []); by.get(s.group).push(s); }
    for (const [g, L] of by) { const h = hubOf(L); const i = land.find((x) => x.id === g); if (h && i) kidHubs.push({ v: vec(h.lon, h.lat), w: i.w, id: g }); }
  }
  let view = chooseView(raw, Object.assign({}, opts, { kidHubs }), allStocks);
  view = focusView(view, opts.focus);
  const vr = view.radius;
  const zoomNow = +opts.zoom > 0 ? +opts.zoom : view.scale;
  const detail = opts.detail || (zoomNow >= 2.6 ? '10m' : '50m');     // issue 9: 10 m coast from ×2.6 on
  const G = await loadGeo(detail === '10m' ? '10m' : vr < 25 ? '50m' : 'medium');
  for (const s of raw) if (!s.cc && !s.offshore) s.cc = countryAtGeo(G, s.lon, s.lat) || countryNear(G, s.lon, s.lat, 15) || null;
  const um = UM || (await loadUnitsMeta());
  // the unit level: by this node's ladder (admin2 once its typical county is big enough on screen)
  const lad = opts.ladder || (await ladderOf(view, raw, um));
  const level = opts.zoomLevel || levelBy(view.scale, lad);
  st.level = level;
  st.ladder = lad;
  const rawBy = new Map();
  for (const s of raw) { if (!rawBy.has(s.group)) rawBy.set(s.group, []); rawBy.get(s.group).push(s); }
  for (const L of rawBy.values()) L.sort((a, b) => b.w - a.w);

  // ---- where every place sits on the unit ladder
  // a region anchor (Permian Basin, 玉米带 …) spreads over the units within its reach (37 probes on land)
  const probesOf = (s) => {
    const pts = [[s.lon, s.lat]];
    for (const [f, n] of [[0.35, 6], [0.7, 12], [1, 18]]) for (let k = 0; k < n; k++) pts.push(llOf(dest(s.v, ((k + (n === 12 ? 0.5 : 0)) / n) * TAU, (f * s.spread) / 6371)));
    return pts.map(([lo, la]) => ({ lon: lo, lat: la, cc: countryAtGeo(G, lo, la) })).filter((p) => p.cc);
  };
  // (companies / funds that are children themselves are points: they own no land, their unit comes from units.json)
  const placeList = [];   // {s, parts:[{f, lon, lat, cc}]}
  for (const s of raw) {
    if (s.offshore || s.info.stock) continue;
    if (s.spread > 0 && !s.info.stock) {
      const P = probesOf(s);
      if (P.length) { placeList.push({ s, parts: P.map((p) => ({ f: 1 / P.length, lon: p.lon, lat: p.lat, cc: p.cc, probe: true })) }); continue; }
    }
    placeList.push({ s, parts: [{ f: 1, lon: s.lon, lat: s.lat, cc: s.cc }] });
  }
  const needCC = new Set();
  for (const pl of placeList) for (const p of pl.parts) if (p.cc) needCC.add(p.cc);
  // lazy: a country's admin2 file (≤ 1.5 MB) is fetched only when the country is in or near the view, or holds ≥ 8 %
  // of this view's money; a far-away minor country uses its small admin1 file, else its whole shape
  const ccW = new Map();
  let Wpl = 0;
  const cvv = vec(view.lon, view.lat), cosNear = Math.cos(Math.min(90, vr * 1.6 + 1) * RAD);
  const nearCC = new Set();
  for (const pl of placeList) for (const p of pl.parts) {
    if (!p.cc) continue;
    ccW.set(p.cc, (ccW.get(p.cc) || 0) + pl.s.w * p.f); Wpl += pl.s.w * p.f;
    if (dot(cvv, vec(p.lon, p.lat)) >= cosNear) nearCC.add(p.cc);
  }
  const F = new Map();
  st.lazy = 0;
  const centreCC = countryAtGeo(G, view.lon, view.lat);
  await Promise.all([...needCC].map(async (cc) => {
    const share = (ccW.get(cc) || 0) / (Wpl || 1);
    // (a continent-wide view needs counties only where it carves or splits: its main countries)
    const want2 = level === 1 ? share >= 0.08 || cc === centreCC : nearCC.has(cc) || share >= 0.08;
    if (um.idx2.has(cc) && (want2 || cfg.unitEager)) { const f = await unitFile(2, cc); if (f && f.list.length) { F.set('2:' + cc, f); return; } }
    else if (um.idx2.has(cc)) st.lazy++;
    if (um.idx1.has(cc) && (nearCC.has(cc) || share >= 0.01 || cfg.unitEager)) { const f = await unitFile(1, cc); if (f && f.list.length) F.set('1:' + cc, f); }
  }));
  const ujOf = (s, p) => {
    if (p.probe) return null;
    if (s.t) { const f = um.u.fine && um.u.fine.get(String(s.t).toUpperCase()); if (f && Math.abs(f[3] - s.lon) < 1e-6 && Math.abs(f[4] - s.lat) < 1e-6) return f; }
    if (s.t) { const u = um.u.t.get(String(s.t).toUpperCase()); if (u && !Array.isArray(u[0])) return u; }
    for (const a of s.aids) { const u = um.u.a.get(a); if (u && !Array.isArray(u[0])) return u; }
    return null;
  };
  const chainAt = (lon, lat, cc, u) => {
    const c = { cc, l1: null, l2: null, U1: null, U2: null, U3: null, sub3: null, src: null };
    if (!cc) return c;
    const F2 = F.get('2:' + cc);
    if (F2) {
      let U = u && u[1] ? F2.byId.get(u[1]) : null;
      if (U) c.src = 'units.json'; else if ((U = unitAt(F2, lon, lat))) c.src = 'pip'; else if ((U = unitNear(F2, lon, lat, 8))) c.src = 'near';
      if (U) { c.U2 = U; c.l2 = U.id; c.l1 = U.a1 || (u && u[0]) || null; }
      return c;
    }
    const F1 = F.get('1:' + cc);
    if (F1) {
      let U = u && u[0] ? F1.byId.get(u[0]) : null;
      if (U) c.src = 'units.json'; else if ((U = unitAt(F1, lon, lat))) c.src = 'pip'; else if ((U = unitNear(F1, lon, lat, 8))) c.src = 'near';
      if (U) { c.U1 = U; c.l1 = U.id; }
    }
    return c;
  };
  for (const pl of placeList) for (const p of pl.parts) { p.c = chainAt(p.lon, p.lat, p.cc, ujOf(pl.s, p)); if (p.c.src) st.src[p.c.src] = (st.src[p.c.src] || 0) + 1; }
  // level 1 in a country with admin2: states are unions of their counties — their names come from the admin1 file
  if (level === 1) {
    await Promise.all([...F.entries()].filter(([k]) => k.startsWith('2:')).map(async ([k, F2]) => {
      if (F2.a1Names) return;
      const cc = k.slice(2);
      const F1 = um.idx1.has(cc) ? await unitFile(1, cc) : null;
      const names = new Map();
      for (const U of (F1 && F1.list) || []) { const n = U.zh || U.name; if (n) { names.set(U.id, n); if (U.a1 && !names.has(U.a1)) names.set(U.a1, n); } }
      F2.a1Names = names;
    }));
  }
  // metro detail: the admin3 files of the counties / cities in play
  if (level >= 3 && um.by3.size) {
    const keys = new Set();
    // with a camera centre (opts.at), only the metro files within ~5° of it: elsewhere the counties stay whole
    const near3 = opts.atCell ? (k) => { const m = um.idx3.get(k); if (!m || !m.bbox) return true; const c = opts.atCell; const dx = Math.max(m.bbox[0] - c[0], 0, c[0] - m.bbox[2]) * Math.cos(c[1] * RAD), dy = Math.max(m.bbox[1] - c[1], 0, c[1] - m.bbox[3]); return Math.hypot(dx, dy) <= 5; } : () => true;
    for (const pl of placeList) for (const p of pl.parts) if (p.c.l2 && um.by3.has(p.c.l2) && near3(um.by3.get(p.c.l2))) keys.add(um.by3.get(p.c.l2));
    await Promise.all([...keys].map(async (k) => { const f = await unitFile(3, k); if (f && f.list.length) F.set('3:' + k, f); }));
    for (const pl of placeList) for (const p of pl.parts) {
      if (!p.c.l2 || !um.by3.has(p.c.l2)) continue;
      const F3 = F.get('3:' + um.by3.get(p.c.l2));
      if (!F3) continue;
      p.c.sub3 = F3;
      const u = ujOf(pl.s, p);
      p.c.U3 = (u && u[2] && F3.byId.get(u[2])) || unitAt(F3, p.lon, p.lat) || unitNear(F3, p.lon, p.lat, 3) || null;
    }
  }
  // the unit of a place at this level ('2|US|US-06085' county, 'g|US|US-CA' a state built from its counties,
  // '1|CN|CN-GD' an admin1 unit, '3|key|id' a city / ward, '0|FI' a whole country, 'p|…' the last-resort patch)
  const keyOf = (c, lon, lat, group) => {
    if (level >= 3 && c.sub3) return c.U3 ? '3|' + c.sub3.key + '|' + c.U3.id : null;
    if (c.U2) return level >= 2 || !c.l1 ? '2|' + c.cc + '|' + c.U2.id : 'g|' + c.cc + '|' + c.l1;
    if (c.U1) return '1|' + c.cc + '|' + c.U1.id;
    if (c.cc && G.byCC.has(c.cc)) return '0|' + c.cc;
    return 'p|' + group + '|' + lon.toFixed(2) + ',' + lat.toFixed(2);
  };
  const kidW = new Map(land.map((i) => [i.id, i.w]));
  const units = new Map();
  const unplacedSites = [];
  const sitesIn = new Map();     // site → [{key, f}]
  for (const pl of placeList) {
    const s = pl.s;
    const list = [];
    for (const p of pl.parts) {
      const k = keyOf(p.c, p.lon, p.lat, s.group);
      if (!k) continue;
      let U = units.get(k);
      if (!U) {
        const [type] = k.split('|');
        U = { key: k, type, cc: p.c.cc, unit: type === '3' ? p.c.U3 : type === '2' ? p.c.U2 : type === '1' ? p.c.U1 : null, l1: p.c.l1, F2: type === 'g' || type === '2' ? F.get('2:' + p.c.cc) : null, by: new Map(), est: new Map(), ts: new Map(), sites: [], W: 0, sub: type === 'g' ? new Map() : null, at: [p.lon, p.lat] };
        if (type === '3') U.F3 = p.c.sub3;
        units.set(k, U);
      }
      const w = s.w * p.f;
      U.by.set(s.group, (U.by.get(s.group) || 0) + w);
      if (s.est) U.est.set(s.group, (U.est.get(s.group) || 0) + w);
      if (!U.ts.has(s.group)) U.ts.set(s.group, new Set());
      for (const t of s.ts.length ? s.ts : s.aids.length ? s.aids : [s.city || 'x']) U.ts.get(s.group).add(t);
      if (!U.sites.includes(s)) U.sites.push(s);
      U.W += w;
      if (U.sub && p.c.U2) {
        let S = U.sub.get(p.c.U2.id);
        if (!S) U.sub.set(p.c.U2.id, (S = { id: p.c.U2.id, U: p.c.U2, by: new Map(), est: new Map(), ts: new Map(), W: 0, sites: [], at: [p.lon, p.lat] }));
        S.by.set(s.group, (S.by.get(s.group) || 0) + w);
        if (s.est) S.est.set(s.group, (S.est.get(s.group) || 0) + w);
        if (!S.ts.has(s.group)) S.ts.set(s.group, new Set());
        for (const t of s.ts.length ? s.ts : s.aids.length ? s.aids : [s.city || 'x']) S.ts.get(s.group).add(t);
        S.W += w;
        if (!S.sites.includes(s)) S.sites.push(s);
      }
      list.push({ key: k, f: p.f, a2: p.c.U2 ? p.c.U2.id : null, p });
    }
    if (!list.length) unplacedSites.push(s);
    sitesIn.set(s, list);
  }
  st.noUnit = unplacedSites.length;
  st.sites = placeList.length;
  st.units = units.size;
  const ownerOf = (by) => {
    let b = null, bw = -1;
    for (const [g, w] of by) if (w > bw + 1e-12 || (Math.abs(w - bw) <= 1e-12 && ((kidW.get(g) || 0) > (kidW.get(b) || 0) || ((kidW.get(g) || 0) === (kidW.get(b) || 0) && String(g) < String(b))))) { b = g; bw = w; }
    return b;
  };
  for (const U of units.values()) U.owner = ownerOf(U.by);
  // level 1: a state / province is painted whole only where its money is dense enough (≥ ¼ of the average density
  // of the states in play); a sparse one (Ontario for one company, Montana) shows just the counties its companies
  // are in — real borders either way, and the colour stays where the money is
  st.split = 0;
  if (level === 1) {
    const gs = [...units.values()].filter((U) => U.type === 'g' && U.F2 && U.sub && U.sub.size);
    let SA = 0, SW = 0;
    for (const U of gs) { U.A = groupArea(U.F2, U.l1); SA += U.A; SW += U.W; }
    const dref = SW / (SA || 1), rho = cfg.unitDense != null ? cfg.unitDense : 0.25;
    for (const U of gs) {
      if (U.W / (U.A || 1e-9) >= rho * dref) continue;
      units.delete(U.key);
      st.split++;
      for (const S of U.sub.values()) {
        const k = '2|' + U.cc + '|' + S.id;
        const V = { key: k, type: '2', cc: U.cc, unit: S.U, l1: U.l1, F2: U.F2, by: S.by, est: S.est, ts: S.ts, sites: S.sites, W: S.W, sub: null, at: S.at, fromSplit: U.l1 };
        V.owner = ownerOf(V.by);
        units.set(k, V);
      }
      for (const L of sitesIn.values()) for (const e of L) if (e.key === U.key) { const s0 = U.sites.find((x) => (sitesIn.get(x) || []).includes(e)); const S = s0 && [...U.sub.values()].find((q) => q.sites.includes(s0)); if (S) e.key = '2|' + U.cc + '|' + S.id; }
    }
  }
  // a coarse fallback unit (a whole province or country where no finer data exists) is coloured only where the money
  // is dense enough for its size, or when it is its owner's main place; otherwise it stays neutral with dots
  {
    const areaOf = (U) => U.type === 'g' ? groupArea(U.F2, U.l1) : U.unit ? U.unit.A : U.type === '0' ? (G.byCC.get(U.cc) || []).reduce((a, P) => a + P.area, 0) * DEG * DEG : 0;
    const ref = [...units.values()].filter((U) => (level === 1 ? U.type === 'g' || U.type === '1' : level === 2 ? U.type === '2' : U.type === '3' || U.type === '2'));
    let SA = 0, SW = 0;
    for (const U of ref) { SA += areaOf(U); SW += U.W; }
    const dref = SA > 0 ? SW / SA : 0, rho = cfg.unitDense != null ? cfg.unitDense : 0.25;
    for (const U of units.values()) if ((U.type === '1' || U.type === '0') && dref > 0) { const A = areaOf(U); if (A > 0 && U.W / A < rho * dref) U.sparse = true; }
  }
  const Wv = [...units.values()].reduce((a, U) => a + U.W, 0) || 1;
  const regionIds = land.filter((i) => !i.stock).map((i) => i.id);

  // ---- ownership with a dust threshold that rises until the view stays within the polygon budget
  const CAP = cfg.unitCap || 260;
  let theta = (cfg.unitDust && cfg.unitDust[level]) || 0.0004, plan = null, geom = null;
  for (let round = 0; round < 5; round++) {
    plan = planUnits(units, theta, Wv, regionIds, level, st);
    geom = territoryGeometry(plan, G, vr, view, st);
    st.polys = geom.nPolys;
    st.θ = theta;
    if (geom.nPolys <= CAP) break;
    theta *= 2.5;
  }
  const { owned, carved, dust } = plan;

  // ---- home ground (refine, critics 2026-10-28 17:00: "A股 金融 is drawn only as 清远市 — 1.1 % of its money —
  // and the ② card leads there"). The one-owner-per-unit rule leaves a sector whose money sits where a richer one
  // dominates (北京, 千代田区, the Santa Clara County) with stray leftover units far away. So, for a child whose own
  // land holds < HOME of its money:
  //   1. one level down (§26 amendment 4: "a dense unit with several sectors is split by going one level down"):
  //      in its heaviest units owned by others (≥ HOME_TRY of its money each, ≤ 3), the county it dominates (inside a
  //      state) or the admin3 区 / city / ward it dominates (inside an admin2 unit that has admin3 data: 北京 → 西城区,
  //      Santa Clara County → Sunnyvale) is carved for it (≥ HOME_CUT of its money) — real borders, at its money;
  //   2. stray leftovers go neutral (dots instead): any owned unit but a child's heaviest that holds < STRAY of its
  //      money at < 1/20 of the median money density of its pieces of land (清远 for 金融 once it has 西城区, 崇明 for
  //      房地产, Dubbo for 工业);
  //   3. still homeless — own land < HOME, its money hub not on it, the hub ≥ 1.5 × its own land: it is drawn at its
  //      money hub (kind 'point', shape 'ticks': a marker + dots, like a child that owns nothing) and its leftovers go
  //      neutral — never a far-away stand-in county as its home (日本 通信传媒 → 东京, not 那霸).
  const HOME = 0.25, HOME_TRY = 0.04, HOME_CUT = 0.02, STRAY = 0.03;
  const deep = new Map();          // admin2 id → {X, F3, cut: Map(admin3 id → {id, owner, U, by, ts, W, sites})}
  const demoted = new Set();
  const totG = new Map();
  for (const U of units.values()) for (const [g, w] of U.by) totG.set(g, (totG.get(g) || 0) + w);
  const cutFor = (g, a2id) => { const D = deep.get(a2id); let w = 0; if (D) for (const E of D.cut.values()) if (E.owner === g) w += E.by.get(g) || 0; return w; };
  const cutAway = (g, a2id) => { const D = deep.get(a2id); let w = 0; if (D) for (const E of D.cut.values()) if (E.owner !== g) w += E.by.get(g) || 0; return w; };
  /** Money of g on its own land: owned units (less what is carved away for others), its carved counties and 区. */
  const ownMoney = (g) => {
    let w = 0;
    for (const U of owned.get(g) || []) {
      w += U.by.get(g) || 0;
      if (U.sub) for (const S of U.sub.values()) { const C = carved.get(S.id); if (C && C.owner !== g) w -= S.by.get(g) || 0; else w -= cutAway(g, S.id); }
      else if (U.type === '2' && U.unit) w -= cutAway(g, U.unit.id);
    }
    for (const C of carved.values()) if (C.owner === g) w += (C.by.get(g) || 0) - cutAway(g, C.id);
    for (const D of deep.values()) for (const E of D.cut.values()) if (E.owner === g) w += E.by.get(g) || 0;
    return Math.max(0, w);
  };
  const partsByA2 = new Map();
  for (const pl of placeList) for (const p of pl.parts) if (p.c.U2 && !p.probe) { if (!partsByA2.has(p.c.U2.id)) partsByA2.set(p.c.U2.id, []); partsByA2.get(p.c.U2.id).push({ s: pl.s, p }); }
  const homeless = regionIds.filter((g) => (totG.get(g) || 0) > 0 && ownMoney(g) < HOME * totG.get(g));
  st.homeless = homeless.length;
  // (a child with land of its own whose money hub still sits in someone else's unit — 半导体设备 at 北京, its 北方华创 in
  // a city 半导体设计 dominates — gets the same one-level-down look at that one unit when it holds ≥ HUB_TRY of its money)
  const HUB_TRY = 0.1;
  for (const g of regionIds) {
    const tot = totG.get(g) || 0;
    if (!tot) continue;
    const isHomeless = homeless.includes(g);
    // its heaviest places someone else owns (or left neutral): a county of a state, or an admin2 unit
    const cand = [];
    for (const U of units.values()) {
      const w = U.by.get(g) || 0;
      if (!w) continue;
      const eo = dust.has(U.key) ? null : U.owner;
      if (U.type === 'g' && U.sub) {
        for (const S of U.sub.values()) {
          const sw = S.by.get(g) || 0;
          if (!sw) continue;
          const C = carved.get(S.id);
          if ((C ? C.owner : eo) === g) continue;
          cand.push({ X: S.U, by: S.by, w: sw, carvable: !C && eo !== null, S, U });
        }
      } else if (U.type === '2' && U.unit && eo !== g && U.owner !== g) cand.push({ X: U.unit, by: U.by, w });
    }
    cand.sort((a, b) => b.w - a.w);
    // a county of a state where it is the richest child (墨田区 for 日本 必需消费): carve it, whatever its size
    if (isHomeless) for (const c of cand) {
      if (c.w < HOME_CUT * tot) break;
      if (c.S && c.carvable && ownerOf(c.S.by) === g) carved.set(c.S.id, { id: c.S.id, owner: g, U: c.S.U, by: c.S.by, W: c.S.W, sites: c.S.sites, parent: c.U.key, cc: c.U.cc, home: true });
    }
    for (const c of cand.filter((x) => !(x.S && carved.has(x.S.id))).slice(0, isHomeless ? 3 : 1)) {
      if (c.w < (isHomeless ? HOME_TRY : HUB_TRY) * tot) break;
      // one level down: the admin3 units of that county / city
      // (at level 3 only a county / city whose 区 the camera did not load — 北京 seen from 上海 ×45)
      const k3 = um.by3.get(c.X.id);
      if (!k3 || (level >= 3 && F.has('3:' + k3))) continue;
      const F3 = await unitFile(3, k3);
      if (!F3 || !F3.list.length) continue;
      if (!F.has('3:' + k3)) F.set('3:' + k3, F3);
      const by3 = new Map();
      for (const { s, p } of partsByA2.get(c.X.id) || []) {
        const u = ujOf(s, p);
        const A = (u && u[2] && F3.byId.get(u[2])) || unitAt(F3, p.lon, p.lat) || unitNear(F3, p.lon, p.lat, 3);
        if (!A || (A.a2 && A.a2 !== c.X.id)) continue;
        let E = by3.get(A.id);
        if (!E) by3.set(A.id, (E = { id: A.id, U: A, by: new Map(), ts: new Map(), W: 0, sites: [], owner: null }));
        const w = s.w * p.f;
        E.by.set(s.group, (E.by.get(s.group) || 0) + w); E.W += w;
        if (!E.sites.includes(s)) E.sites.push(s);
        if (!E.ts.has(s.group)) E.ts.set(s.group, new Set());
        for (const t of s.ts.length ? s.ts : s.aids.length ? s.aids : [s.city || 'x']) E.ts.get(s.group).add(t);
      }
      for (const E of by3.values()) {
        if (ownerOf(E.by) !== g || (E.by.get(g) || 0) < HOME_CUT * tot) continue;
        if (!deep.has(c.X.id)) deep.set(c.X.id, { X: c.X, F3, cut: new Map() });
        const D = deep.get(c.X.id);
        if (!D.cut.has(E.id)) D.cut.set(E.id, Object.assign(E, { owner: g }));
      }
    }
  }
  // stray leftovers → neutral (dots)
  {
    const areaU = (U) => U.type === 'g' ? groupArea(U.F2, U.l1) : U.unit ? U.unit.A : U.type === '0' ? (G.byCC.get(U.cc) || []).reduce((a, P) => a + P.area, 0) * DEG * DEG : 0;
    st.stray = 0;
    for (const g of regionIds) {
      const tot = totG.get(g) || 0;
      const L = owned.get(g) || [];
      if (!tot) continue;
      // the median money density of its pieces of land (units, carved counties, 区) — and its heaviest piece stays
      let topW = 0;
      const dens = [];
      const look = (w, A) => { if (w > 0 && A > 0) { dens.push(w / A); if (w > topW) topW = w; } };
      for (const U of L) look(U.by.get(g) || 0, areaU(U));
      for (const C of carved.values()) if (C.owner === g) look(C.by.get(g) || 0, C.U.A);
      for (const D of deep.values()) for (const E of D.cut.values()) if (E.owner === g) look(E.by.get(g) || 0, E.U.A);
      if (dens.length < 2) continue;
      dens.sort((a, b) => a - b);
      const ref = dens[dens.length >> 1] / 20;
      const stray = (w, A) => w > 0 && w < topW && w < STRAY * tot && A > 0 && w / A < ref;
      for (const U of L) if (stray(U.by.get(g) || 0, areaU(U))) { dust.add(U.key); st.stray++; }
      owned.set(g, L.filter((U) => !dust.has(U.key)));
      for (const [id, C] of carved) if (C.owner === g && !C.home && stray(C.by.get(g) || 0, C.U.A)) { carved.delete(id); st.stray++; }
    }
  }
  // still homeless: drawn at its money hub (also a child whose one metro holds about half of its money on someone
  // else's ground while its own land holds less than ⅔ of that: 交易所评级 at 纽约, not at Chicago)
  for (const g of regionIds) {
    const tot = totG.get(g) || 0;
    if (!tot) continue;
    const own = ownMoney(g);
    const ss = rawBy.get(g) || [];
    const h = hubOf(ss);
    if (!h || (own >= HOME * tot && h.share < 0.45)) continue;
    // (its own land near the hub — 墨田区 / 中野区 for 日本 必需消费 at 东京 — counts as being at its money)
    const hv = vec(h.lon, h.lat), cosH = Math.cos(60 / 6371);
    let near = 0, nearOwn = 0;
    for (const s of ss) {
      if (dot(hv, s.v) < cosH) continue;
      near += s.w;
      for (const e of sitesIn.get(s) || []) if (effOwner(e) === g) nearOwn += s.w * e.f;
    }
    if (near > 0 && nearOwn >= Math.max(0.1 * near, HOME_CUT * tot)) continue;
    if (h.share < 1.5 * (own / tot)) continue;
    demoted.add(g);
    if (cfg.debugHome) console.log('[real] home: ' + g + ' → hub ' + h.label + ' (own ' + (own / tot).toFixed(3) + ', hub ' + h.share.toFixed(3) + ', near own ' + (near ? (nearOwn / near).toFixed(3) : '-') + ', cuts ' + [...deep.values()].map((D) => [...D.cut.values()].filter((E) => E.owner === g).map((E) => E.U.name + ':' + ((E.by.get(g) || 0) / tot).toFixed(3)).join(',')).filter(Boolean).join(';') + ')');
    for (const U of owned.get(g) || []) dust.add(U.key);
    owned.set(g, []);
    for (const [id, C] of carved) if (C.owner === g) carved.delete(id);
    for (const [id, D] of deep) { for (const [aid, E] of D.cut) if (E.owner === g) D.cut.delete(aid); if (!D.cut.size) deep.delete(id); }
  }
  st.deep = [...deep.values()].reduce((a, D) => a + D.cut.size, 0);
  st.demoted = demoted.size;
  /** Who owns the ground under one placed part of a site (after carving, 区 cuts and demotions); null = neutral. */
  function effOwner(e) {
    const U = units.get(e.key);
    if (!U) return null;
    const p = e.p;
    if (e.a2 && deep.has(e.a2) && p) {
      const D = deep.get(e.a2);
      const A = p.__a3 !== undefined ? p.__a3 : (p.__a3 = (unitAt(D.F3, p.lon, p.lat) || unitNear(D.F3, p.lon, p.lat, 3) || null));
      if (A && D.cut.has(A.id)) return D.cut.get(A.id).owner;
    }
    if (U.type === 'g' && e.a2 && carved.has(e.a2)) return carved.get(e.a2).owner;
    if (dust.has(U.key)) return null;
    return U.owner;
  }
  if (deep.size || demoted.size || st.stray) {
    geom = territoryGeometry(plan, G, vr, view, st, deep);
    st.polys = geom.nPolys;
  }

  // ---- offshore fields: small sea marks at the field (deliberately at sea, §26 amendment 1)
  const isLand = (lon, lat) => countryAtGeo(G, lon, lat) != null;
  const seaMarks = new Map();    // group → [{polys, w, id, label}]
  {
    const fields = new Map();
    for (const s of raw) {
      if (!s.offshore || s.info.stock) continue;
      const k = s.lon.toFixed(2) + ',' + s.lat.toFixed(2);
      let f = fields.get(k);
      if (!f) fields.set(k, (f = { s, by: new Map(), W: 0, k }));
      f.by.set(s.group, (f.by.get(s.group) || 0) + s.w);
      f.W += s.w;
    }
    for (const f of fields.values()) {
      const g = ownerOf(f.by);
      const C = f.s.v;
      const R = clamp(0.02 * vr, 0.05, 0.8) * RAD;
      let sc = 1;
      for (let k = 0; k < 8; k++) {
        let wet = !isLand(f.s.lon, f.s.lat);
        for (let q = 0; q < 16 && wet; q++) { const p = llOf(dest(C, (q / 16) * TAU, sc * R * 1.1)); if (isLand(p[0], p[1])) wet = false; }
        if (wet) break;
        sc *= 0.75;
      }
      const ring = organicRing(C, (th) => sc * R * (1 + 0.05 * Math.sin(3 * th + (hash32(f.k) % 7))), 40, 1);
      const P = orientPoly([openRing(ring)]);
      if (!P) continue;
      if (!seaMarks.has(g)) seaMarks.set(g, []);
      seaMarks.get(g).push({ polys: [P.map(closeRing)], w: f.by.get(g), id: 'sea:' + (f.s.aids[0] || f.k), label: f.s.cityZh || f.s.city || null, by: f.by, W: f.W, s: f.s });
    }
  }

  const items = [];
  // ---- stock children: a marker exactly at its place (renderers fan crowds out in screen space)
  const stockKids = land.filter((i) => i.stock && rawBy.has(i.id));
  const unitOfSite = (s) => {
    // a company's admin unit at this level, straight from units.json (no file needed): [a1, a2, a3]
    let u = s.t ? (um.u.fine && um.u.fine.get(String(s.t).toUpperCase())) || um.u.t.get(String(s.t).toUpperCase()) : null;
    if (!u) for (const a of s.aids) { u = um.u.a.get(a); if (u) break; }
    if (!u || Array.isArray(u[0])) return null;
    for (let l = Math.min(level, 3); l >= 1; l--) if (u[l - 1]) {
      const id = u[l - 1];
      const UF = F.get((l === 3 ? '3:' + (um.by3.get(u[1]) || '') : l + ':' + (s.cc || ''))) || null;
      const U = UF && UF.byId.get(id);
      return { id, level: l, label: U ? U.zh || U.name || null : null };
    }
    return null;
  };
  if (stockKids.length) {
    const wmax = Math.max(...stockKids.map((i) => i.w));
    for (const i of stockKids) {
      const ss = rawBy.get(i.id);
      const h = hubOf(ss);
      const s = h.site;
      const r = clamp(vr * 0.02 * Math.pow(i.w / wmax, 0.18), vr * 0.011, vr * 0.026);
      const at = [round6(s.lon), round6(s.lat)];
      const it = { id: i.id, kind: 'point', at, center: at.slice(), r, rings: [closeRing(discRing(at[0], at[1], r))], area: Math.PI * (r * RAD) ** 2, city: s.city, cityZh: s.cityZh || zhCity(s.city, s.cc), cc: s.cc, est: !!s.est, cell: [] };
      const ref = unitOfSite(s);
      it.units = ref ? [{ id: ref.id, level: ref.level, w: 1 }] : [];
      if (ref && ref.label) it.unitName = ref.label;
      if (s.anchor) {
        it.anchors = ss.slice(0, 8).map((q) => ({ label: q.city, why: q.why || null, w: +(q.w / i.w).toFixed(4), lon: round6(q.lon), lat: round6(q.lat), est: !!q.est, offshore: q.offshore || undefined }));
        it.place = h.label; it.hubShare = +h.share.toFixed(3);
      }
      items.push(it);
    }
    // a city's companies share one group key (a renderer may merge them into '旧金山 ×7' at low zoom)
    const byCity = new Map();
    for (const it of items) { const k = Math.round(it.at[0] * 20) + ',' + Math.round(it.at[1] * 20); if (!byCity.has(k)) byCity.set(k, []); byCity.get(k).push(it); }
    for (const [k, L] of byCity) if (L.length > 1) L.forEach((it, j) => { it.cityGroup = { key: k, n: L.length, rank: j, label: (L[0].cityZh || L[0].city || '') + ' ×' + L.length }; });
  }

  // ---- region children: territories, ticks, hover lists, labels
  const tickBudget = { n: 0 };
  for (const i of land) {
    if (i.stock) continue;
    const srcSites = (rawBy.get(i.id) || []).map((r) => ({ t: r.t, ts: r.ts, lon: round6(r.lon), lat: round6(r.lat), city: r.city, cityZh: r.cityZh || zhCity(r.city, r.cc), w: r.w, cc: r.cc, est: r.est, why: r.why || undefined, offshore: r.offshore || undefined }));
    if (!srcSites.length) continue;
    const tot = srcSites.reduce((a, s) => a + s.w, 0) || 1;
    let polys = (geom.polys.get(i.id) || []).slice();
    const uref = [];
    // (w: its money on this unit's own ground — what a county carved out of the state, or a 区 cut out of the city,
    // for another child holds is not counted here)
    const awayIn = (U) => {
      let a = 0;
      if (U.sub) for (const S of U.sub.values()) { const C = carved.get(S.id); if (C && C.owner !== i.id) a += S.by.get(i.id) || 0; else a += cutAway(i.id, S.id); }
      else if (U.unit) a += cutAway(i.id, U.unit.id);
      return a;
    };
    for (const U of owned.get(i.id) || []) { const ref = unitRef(U, carved); const w = Math.max(0, (U.by.get(i.id) || 0) - awayIn(U)); uref.push({ id: ref.id, level: ref.level, w: +(w / tot).toFixed(4), name: ref.label || undefined, est: (U.est.get(i.id) || 0) > 0.5 * (U.by.get(i.id) || 0) || undefined }); }
    for (const C of carved.values()) if (C.owner === i.id) uref.push({ id: C.id, level: 2, w: +((C.by.get(i.id) || 0) / tot).toFixed(4), name: C.U.zh || C.U.name || undefined, carved: true });
    for (const D of deep.values()) for (const E of D.cut.values()) if (E.owner === i.id) uref.push({ id: E.id, level: 3, w: +((E.by.get(i.id) || 0) / tot).toFixed(4), name: E.U.zh || E.U.name || undefined, carved: true });
    for (const m of seaMarks.get(i.id) || []) { for (const P of m.polys) polys.push(P); uref.push({ id: m.id, level: -1, w: +(m.w / tot).toFixed(4), name: m.label || undefined, offshore: true }); }
    uref.sort((a, b) => b.w - a.w);
    const hub = hubOf(srcSites);
    const estW = srcSites.filter((s) => s.est).reduce((a, s) => a + s.w, 0);
    const base = {
      id: i.id, countries: [...new Set(srcSites.map((s) => s.cc).filter(Boolean))], sites: srcSites.slice(0, 12), est: estW > tot / 2,
      hub: [round6(hub.lon), round6(hub.lat)], hubLabel: hub.label, hubCC: hub.site.cc || null, hubShare: +hub.share.toFixed(3), units: uref.slice(0, 120),
    };
    if (i.ancW > 0.5 * (i.geoW || 1) && hub.share >= 0.5) base.place = hub.label;
    // hover: per owned unit, who else is there ('海淀区 · AI 算力 · 也有 金融 3 家')
    const metros = [];
    const memb = (by, ts, W) => [...by].sort((a, b) => b[1] - a[1]).map(([id, w]) => ({ id, w: +(w / (W || 1)).toFixed(3), n: ts && ts.get(id) ? ts.get(id).size : undefined }));
    for (const U of (owned.get(i.id) || []).slice().sort((a, b) => (b.by.get(i.id) || 0) - (a.by.get(i.id) || 0)).slice(0, 30)) {
      const ref = unitRef(U, carved);
      metros.push({ id: ref.id, level: ref.level, at: atOf(U, i.id), label: ref.label || U.sites[0].cityZh || U.sites[0].city || null, members: memb(U.by, U.ts, U.W) });
    }
    for (const C of carved.values()) if (C.owner === i.id) metros.push({ id: C.id, level: 2, at: atOfSub(C, i.id), label: C.U.zh || C.U.name || null, members: memb(C.by, null, C.W) });
    for (const D of deep.values()) for (const E of D.cut.values()) if (E.owner === i.id) metros.push({ id: E.id, level: 3, at: atOfSub(E, i.id), label: E.U.zh || E.U.name || null, members: memb(E.by, E.ts, E.W) });
    for (const m of seaMarks.get(i.id) || []) metros.push({ id: m.id, level: -1, at: [round6(m.s.lon), round6(m.s.lat)], label: m.label, members: memb(m.by, null, m.W) });
    if (metros.length) base.metros = metros;
    // ticks: where this child has money in a unit someone else owns (or one left neutral) — a dot at its own place
    const ticks = [];
    const mine = [];
    for (const U of units.values()) {
      const w = U.by.get(i.id) || 0;
      if (!w) continue;
      const ownsIt = U.owner === i.id && !dust.has(U.key);
      // (a 区 / city of this unit cut out for another child — home ground — where this one has money: a dot there)
      const cutDots = (a2id) => {
        const D = deep.get(a2id);
        if (D) for (const E of D.cut.values()) {
          const w3 = E.owner !== i.id ? E.by.get(i.id) || 0 : 0;
          if (!w3) continue;
          const own = E.sites.filter((x) => x.group === i.id).sort((a, b) => b.w - a.w)[0];
          if (own) mine.push({ w: w3, lon: own.lon, lat: own.lat, label: E.U.zh || E.U.name || own.cityZh || own.city || null, unit: E.id, level: 3, owner: E.owner });
        }
      };
      if (ownsIt) {
        // a state it owns: its colour — except in a county of it carved out for someone else, where it gets a dot
        if (U.sub) for (const S of U.sub.values()) {
          const C = carved.get(S.id), w2 = S.by.get(i.id) || 0;
          if (!C || C.owner === i.id) { if (w2) cutDots(S.id); continue; }
          if (!w2) continue;
          const own = S.sites.filter((x) => x.group === i.id).sort((a, b) => b.w - a.w)[0];
          if (own) mine.push({ w: w2, lon: own.lon, lat: own.lat, label: S.U.zh || S.U.name || own.cityZh || own.city || null, unit: S.id, level: 2, owner: C.owner });
        }
        else if (U.unit) cutDots(U.unit.id);
        continue;
      }
      const carvedHere = U.sub ? [...U.sub.values()].filter((S) => carved.has(S.id) && carved.get(S.id).owner === i.id) : [];
      let cutHere = 0;
      if (U.sub) { for (const S of U.sub.values()) if (!carvedHere.includes(S)) cutHere += cutFor(i.id, S.id); }
      else if (U.unit) cutHere = cutFor(i.id, U.unit.id);
      const left = w - carvedHere.reduce((a, S) => a + (S.by.get(i.id) || 0), 0) - cutHere;
      if (left <= 1e-12 * w) continue;
      const own = U.sites.filter((s) => s.group === i.id).sort((a, b) => b.w - a.w)[0];
      const ref = unitRef(U, carved, own);
      mine.push({ w: left, lon: own.lon, lat: own.lat, label: ref.label || own.cityZh || own.city || null, unit: ref.id, level: ref.level, owner: dust.has(U.key) ? null : U.owner });
    }
    for (const s of unplacedSites) if (s.group === i.id) mine.push({ w: s.w, lon: s.lon, lat: s.lat, label: s.cityZh || s.city || null, unit: null, level: null, owner: null });
    mine.sort((a, b) => b.w - a.w);
    const rt = clamp(0.012 * vr, 0.006 * vr, 0.02 * vr);
    let nT = 0;
    for (const m of mine) {
      const must = nT === 0 && !polys.length;
      if (!must && (nT >= 8 || tickBudget.n >= 140 || (m.w < 0.02 * tot && nT >= 3))) continue;
      ticks.push({ lon: round6(m.lon), lat: round6(m.lat), r: +(rt * clamp(Math.sqrt(m.w / tot) * 1.6, 0.6, 1.4)).toFixed(4), w: +(m.w / tot).toFixed(3), label: m.label, unit: m.unit, level: m.level, owner: m.owner });
      nT++; tickBudget.n++;
    }
    if (ticks.length) base.ticks = ticks;
    if (!polys.length) {
      // owns no unit at all (a minority everywhere at this level): a point at its money hub, plus its ticks
      const r = clamp(vr * 0.016, vr * 0.011, vr * 0.024);
      const at = [round6(hub.lon), round6(hub.lat)];
      const it = Object.assign(base, { kind: 'point', shape: 'ticks', at, center: at.slice(), r, rings: [closeRing(discRing(at[0], at[1], r))], area: Math.PI * (r * RAD) ** 2, city: hub.site.city, cityZh: hub.label, cc: hub.site.cc || null, parts: 0 });
      const cv = vec(view.lon, view.lat), lim = Math.cos(Math.min(89, view.radius * 0.92) * RAD);
      if (dot(cv, vec(at[0], at[1])) < lim && hub.label) it.offscreen = { lon: at[0], lat: at[1], label: '→ ' + hub.label };
      items.push(it);
      continue;
    }
    const it = Object.assign(base, { kind: 'land', shape: 'units', polygons: polys, rings: [].concat(...polys), area: polysArea(polys), parts: polys.length });
    const { center, offscreen, part } = unitCenter(polys, srcSites, view, hub, i.names, uref.length ? uref[0].name : null);
    it.center = center || [round6(hub.lon), round6(hub.lat)];
    if (offscreen) it.offscreen = offscreen;
    // a real unit too small to see at this zoom (District of Columbia at a 15°-wide view, 西城区 at the A股 view):
    // renderers ring it — judged on the part its name sits on (where its money is), else its biggest part
    {
      const sizeOf = (P) => { const b = ringBBox(P[0]); return Math.hypot((b[2] - b[0]) * Math.cos(((b[1] + b[3]) / 2) * RAD), b[3] - b[1]); };
      let big = 0;
      if (part) big = sizeOf(part); else for (const P of polys) big = Math.max(big, sizeOf(P));
      const px = big * (370 / Math.max(vr, 1e-3));
      if (px < 10) it.tiny = true;
    }
    items.push(it);
  }
  // dots that would sit on one spot (a city where four children have a company) fan out around it, inside the unit
  {
    const byPt = new Map();
    for (const it of items) for (const t of it.ticks || []) { const k = Math.round(t.lon * 200) + ',' + Math.round(t.lat * 200); if (!byPt.has(k)) byPt.set(k, []); byPt.get(k).push(t); }
    for (const L of byPt.values()) {
      if (L.length < 2) continue;
      L.sort((a, b) => b.w - a.w);
      const c = vec(L[0].lon, L[0].lat);
      const rr = Math.max(...L.map((t) => t.r)) * 2.3 * RAD;
      const Uu = L[0].unit ? [...units.values()].find((U) => U.unit && U.unit.id === L[0].unit) : null;
      L.forEach((t, k) => {
        if (k === 0) return;
        for (const f of [1, 0.6, 0.35]) {
          const p = llOf(dest(c, (k - 1) * (TAU / Math.max(3, L.length - 1)) + 0.4, rr * f));
          if (!Uu || !Uu.unit || Uu.unit.polys.some((P) => pipPoly(P, p[0], p[1]))) { t.lon = round6(p[0]); t.lat = round6(p[1]); break; }
        }
      });
    }
  }
  // context: which unit files this view used (faint borders of every unit, coloured or not, when zoomed)
  // (below level 3 an admin3 file is named only when a 区 / city of it was cut out for a child — the hover finds it
  // there; the files only looked into stay out, so renderers do not fetch half a megabyte of Census places for nothing)
  const usedF3 = new Set([...deep.values()].map((D) => D.F3));
  const files = [...new Set([...F.entries()].filter(([k, f]) => level >= 3 || !k.startsWith('3:') || usedF3.has(f)).map(([, f]) => f.rel))];
  // (a level of companies loads no unit file: name the ones of the countries in view, for faint borders)
  if (!placeList.length) {
    const cvz = vec(view.lon, view.lat), cz = Math.cos(Math.min(90, vr * 1.2) * RAD);
    for (const s of raw) if (s.cc && dot(cvz, s.v) >= cz) {
      if (level >= 3) for (const [k, m] of um.idx3) if (m.cc === s.cc && m.bbox && s.lon >= m.bbox[0] && s.lon <= m.bbox[2] && s.lat >= m.bbox[1] && s.lat <= m.bbox[3]) files.push('admin3/' + m.file);
      if (um.idx2.has(s.cc)) files.push('admin2/' + um.idx2.get(s.cc).file); else if (um.idx1.has(s.cc)) files.push('admin1/' + um.idx1.get(s.cc).file);
    }
  }
  files.splice(0, files.length, ...[...new Set(files)].sort());
  const unitsCtx = { level, files, countries: [...needCC].sort(), carved: carved.size || undefined };
  st.ms = Math.round(cfg.now() - t0);
  st.dust = dust.size; st.carved = carved.size;
  const hasLand = items.some((it) => it.kind === 'land');
  const lod = lodOf(level, hasLand, lad);
  if (level === 3 && opts.atCell) lod.near = { lon: opts.atCell[0], lat: opts.atCell[1], cell: 4 };
  return { view, detail, items, debug, unitsCtx, lod, ladder: lad };
}

/** {id, level, label} of a unit table entry (a state built from counties is reported as the state). */
function unitRef(U, carved, s) {
  void carved; void s;
  if (U.type === 'g') {
    const a1 = U.l1;
    // a name for the state: the admin1 file has it when loaded; else the code
    // (a territory whose admin1 lives in another country's file — 香港 is CN-HK — is named after its own country)
    const n = (UM && U.F2 && U.F2.a1Names && U.F2.a1Names.get(a1)) || (a1 && U.cc && !String(a1).startsWith(U.cc + '-') ? zhName(U.cc) : null) || null;
    return { id: a1, level: 1, label: n || a1 };
  }
  if (U.type === '0') return { id: U.cc, level: 0, label: zhName(U.cc) || U.cc };
  if (U.type === 'p') return { id: 'patch:' + U.key.split('|')[2], level: -1, label: null };
  const u = U.unit;
  return { id: u ? u.id : U.key, level: U.type === '3' ? 3 : U.type === '2' ? 2 : 1, label: u ? u.zh || u.name || u.id : null };
}
/** A point for a unit's hover entry: the owner's money-weighted place inside it, else the unit's inner point. */
function atOf(U, g) {
  const own = U.sites.filter((s) => s.group === g).sort((a, b) => b.w - a.w)[0];
  if (U.unit) {
    const ip = unitInner(U.unit);
    if (own && U.unit.polys.some((P) => pipPoly(P, own.lon, own.lat))) return [round6(own.lon), round6(own.lat)];
    return ip;
  }
  return own ? [round6(own.lon), round6(own.lat)] : [round6(U.at[0]), round6(U.at[1])];
}
function atOfSub(C, g) {
  const own = C.sites.filter((s) => s.group === g).sort((a, b) => b.w - a.w)[0];
  if (own && C.U.polys.some((P) => pipPoly(P, own.lon, own.lat))) return [round6(own.lon), round6(own.lat)];
  return unitInner(C.U);
}

/**
 * Who owns what: owned (child → [unit entries]), carved (admin2 id → {owner, U, by, W, parent}), dust (unit keys left
 * neutral). Dust = < theta of the view's money while its owner has a bigger unit; carving only at level 1.
 */
function planUnits(units, theta, Wv, regionIds, level, st) {
  const owned = new Map(), dust = new Set(), carved = new Map();
  const byOwner = new Map();
  for (const U of units.values()) { if (!byOwner.has(U.owner)) byOwner.set(U.owner, []); byOwner.get(U.owner).push(U); }
  for (const [g, L] of byOwner) {
    L.sort((a, b) => (b.by.get(g) || 0) - (a.by.get(g) || 0));
    L.forEach((U, k) => { if (k > 0 && (U.W < theta * Wv || U.sparse)) dust.add(U.key); });
    owned.set(g, L.filter((U) => !dust.has(U.key)));
  }
  if (level === 1) {
    // carve counties out of states for the children that dominate them (enough money, or no land otherwise)
    const cand = [];
    for (const U of units.values()) {
      if (U.type !== 'g' || dust.has(U.key) || !U.sub) continue;
      for (const S of U.sub.values()) {
        const d = [...S.by].sort((a, b) => b[1] - a[1])[0][0];
        if (d !== U.owner) cand.push({ S, d, U });
      }
    }
    // a child whose own land holds < 30 % of its money (软件应用: all of it in California's AI counties, its only
    // own unit Ireland) gets its heaviest dominated county carved even when that is small
    const tot = new Map(), ownW = new Map();
    for (const U of units.values()) for (const [g, w] of U.by) tot.set(g, (tot.get(g) || 0) + w);
    for (const [g, L] of owned) ownW.set(g, L.reduce((a, U) => a + (U.by.get(g) || 0), 0));
    const needLand = (g) => (ownW.get(g) || 0) < 0.3 * (tot.get(g) || 1);
    cand.sort((a, b) => b.S.W - a.S.W || (b.S.by.get(b.d) || 0) - (a.S.by.get(a.d) || 0));
    const forced = new Set();
    // (the forced ones: its own heaviest dominated county first)
    const forcedOrder = cand.slice().sort((a, b) => (b.S.by.get(b.d) || 0) - (a.S.by.get(a.d) || 0));
    for (const c of forcedOrder) {
      // (refine: only a county holding ≥ 4 % of its money — a stand-in county for 0.4 % of it reads as its home;
      // the home-ground step in unitLayout looks one level down or draws it at its money hub instead)
      if (carved.size >= 120 || forced.has(c.d) || !needLand(c.d) || c.S.W >= (cfg.unitCarve || 0.0015) * Wv || (c.S.by.get(c.d) || 0) < 0.04 * (tot.get(c.d) || 1)) continue;
      carved.set(c.S.id, { id: c.S.id, owner: c.d, U: c.S.U, by: c.S.by, W: c.S.W, sites: c.S.sites, parent: c.U.key, cc: c.U.cc });
      forced.add(c.d);
    }
    for (const c of cand) {
      if (carved.size >= 120) break;
      if (carved.has(c.S.id)) continue;
      if (c.S.W >= (cfg.unitCarve || 0.0015) * Wv) carved.set(c.S.id, { id: c.S.id, owner: c.d, U: c.S.U, by: c.S.by, W: c.S.W, sites: c.S.sites, parent: c.U.key, cc: c.U.cc });
    }
  }
  for (const id of regionIds) if (!owned.has(id)) owned.set(id, []);
  st.owned = [...owned.values()].reduce((a, L) => a + L.length, 0);
  return { owned, dust, carved };
}

/** Territory polygons per child from a plan: one topojson.merge per (child, unit file), whole countries, patches. */
function territoryGeometry(plan, G, vr, view, st, deep = null) {
  const { owned, carved } = plan;
  const polys = new Map();
  let nPolys = 0;
  const tinyA = Math.pow(0.004 * vr, 2);    // deg² (cos-corrected): islets smaller than this, with no HQ on them, go
  const counts = { a1: 0, a2: 0, a3: 0, country: 0, patch: 0 };
  const ids = new Set(owned.keys());
  if (deep) for (const D of deep.values()) for (const E of D.cut.values()) ids.add(E.owner);
  for (const g of ids) {
    const L = owned.get(g) || [];
    const sets = new Map();    // UF → Set(ids)
    const add = (UF, id) => { if (!UF) return; if (!sets.has(UF)) sets.set(UF, new Set()); sets.get(UF).add(id); };
    // an admin2 unit split one level down (home ground): its owner keeps every admin3 piece not cut for another child
    const addA2 = (UF, id) => {
      const D = deep && deep.get(id);
      if (!D) { add(UF, id); return; }
      for (const aid of groupMembers3(D.F3, id)) { const E = D.cut.get(aid); if (!E || E.owner === g) add(D.F3, aid); }
    };
    const out = [];
    const sitePts = [];
    for (const U of L) {
      for (const s of U.sites) if (s.group === g) sitePts.push(s);
      if (U.type === '2') { addA2(U.F2, U.unit.id); counts.a2++; }
      else if (U.type === 'g') {
        for (const id of groupMembers(U.F2, U.l1)) if (!carved.has(id)) addA2(U.F2, id);
        counts.a1++;
      } else if (U.type === '1') { add(U.unit.uf, U.unit.id); counts.a1++; }
      else if (U.type === '3') { add(U.F3, U.unit.id); counts.a3++; }
      else if (U.type === '0') { for (const P of G.byCC.get(U.cc) || []) out.push(P.coords.map((r) => r.slice())); counts.country++; }
      else if (U.type === 'p') {
        // last resort (no unit data at all for this place): a small land-clipped patch at the place, counted
        const s = U.sites[0];
        const r = clamp(0.02 * vr, 0.03, 0.4) * RAD;
        const ring = organicRing(s.v, (th) => r * (1 + 0.05 * Math.sin(3 * th + (hash32(g) % 7))), 32, 1);
        const cc = s.cc && G.byCC.get(s.cc) ? s.cc : null;
        const clipped = clipZone([openRing(ring)], cc ? G.byCC.get(cc) : G.all);
        for (const P of clipped.length ? clipped : [orientPoly([openRing(ring)])].filter(Boolean)) out.push(P.map(closeRing));
        counts.patch++;
      }
    }
    for (const C of carved.values()) if (C.owner === g) { addA2(C.U.uf, C.id); for (const s of C.sites) if (s.group === g) sitePts.push(s); }
    // its 区 / cities cut out of someone else's county (home ground)
    if (deep) for (const D of deep.values()) for (const E of D.cut.values()) if (E.owner === g && !(owned.get(g) || []).some((U) => U.unit && U.unit.id === D.X.id)) { add(D.F3, E.id); counts.a3++; for (const s of E.sites) if (s.group === g) sitePts.push(s); }
    for (const [UF, ids] of sets) for (const P of dissolveUnits(UF, [...ids])) out.push(P);
    // drop islets (a county's offshore rocks) that are tiny at this zoom and hold none of this child's places
    const keep = [];
    let big = -1, bigA = -1;
    out.forEach((P, k) => {
      const b = ringBBox(P[0]);
      const A = Math.abs(planarArea(P[0])) * Math.cos(((b[1] + b[3]) / 2) * RAD);
      P.__a = A; P.__b = b;
      if (A > bigA) { bigA = A; big = k; }
    });
    const cut = Math.max(tinyA, 0.001 * bigA);   // (a whole-country fallback brings hundreds of skerries along)
    out.forEach((P, k) => {
      if (k === big || P.__a >= cut) { keep.push(P); return; }
      const b = P.__b;
      if (sitePts.some((s) => s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3] && pipPoly(P, s.lon, s.lat))) keep.push(P);
    });
    for (const P of keep) { delete P.__a; delete P.__b; }
    polys.set(g, keep);
    nPolys += keep.length;
  }
  Object.assign(st, counts);
  void view;
  return { polys, nPolys };
}
/** The admin3 ids of an admin3 file that lie in one admin2 unit (their a2). */
function groupMembers3(F3, a2) {
  if (!F3) return [];
  if (!F3.groups3) {
    F3.groups3 = new Map();
    for (const U of F3.list) { const k = U.a2 || '?'; if (!F3.groups3.has(k)) F3.groups3.set(k, []); F3.groups3.get(k).push(U.id); }
  }
  return F3.groups3.get(a2) || [];
}
function groupArea(UF, a1) {
  if (!UF.groupA) UF.groupA = new Map();
  if (!UF.groupA.has(a1)) { let A = 0; for (const id of groupMembers(UF, a1)) { const U = UF.byId.get(id); if (U) A += U.A; } UF.groupA.set(a1, A); }
  return UF.groupA.get(a1);
}
function groupMembers(UF, a1) {
  if (!UF) return [];
  if (!UF.groups) {
    UF.groups = new Map();
    for (const U of UF.list) { const k = U.a1 || '?'; if (!UF.groups.has(k)) UF.groups.set(k, []); UF.groups.get(k).push(U.id); }
  }
  return UF.groups.get(a1) || [];
}

/**
 * The label anchor of a territory: inside its biggest visible part (money-weighted a little), snapped inside; when
 * < 20 % of its money is in view, the hub — off-screen — plus an edge chip naming the place ('→ 新竹 台积电').
 */
function unitCenter(polys, sites, view, hub, names, placeName) {
  const out = { center: null, offscreen: null };
  const cv = vec(view.lon, view.lat), lim = Math.cos(Math.min(89, view.radius * 0.92) * RAD);
  const tot = sites.reduce((a, s) => a + s.w, 0) || 1;
  const inV = sites.filter((s) => dot(cv, vec(s.lon, s.lat)) >= lim);
  const share = inV.reduce((a, s) => a + s.w, 0) / tot;
  if (share < 0.2 && hub) {
    const t = hub.site && (hub.site.t || (hub.site.ts && hub.site.ts[0]));
    const who = t && names && names.get(t) ? names.get(t) : hub.site && hub.site.why ? hub.site.why : '';
    out.offscreen = { lon: round6(hub.lon), lat: round6(hub.lat), label: ('→ ' + (hub.label || '') + (who ? ' ' + who : '')).trim() };
    out.center = snapOnto(polys, [hub.lon, hub.lat]);
    return out;
  }
  // the part where its money is (refine: money first — 美股 金融 is named in New York, not on the roomier North
  // Carolina; 澳洲 金融 in Sydney, not Newcastle), room for a name only breaking near-ties (it saturates at about a
  // label's size; a speck still wins when it holds the money: the renderers ring it, item.tiny)
  const Alab = Math.pow(0.06 * view.radius, 2);
  const room = (A) => Math.sqrt(A / (A + Alab));
  // (a part under ~8 px at this view cannot hold the renderers' anchor — their raster does not see it, and they
  // fall back to the roomiest part — so a speck wins only when it holds clearly more of the money)
  const pxOf = (b) => Math.hypot((b[2] - b[0]) * Math.cos(((b[1] + b[3]) / 2) * RAD), b[3] - b[1]) * (370 / Math.max(view.radius, 1e-3));
  const score = (vis, A, m, px) => (vis ? 1 : 0.02) * (px >= 8 ? 1 : 0.35) * (0.4 + 0.6 * room(A)) * (0.02 + m / tot);
  const parts = polys.map((P, k) => {
    const b = ringBBox(P[0]);
    const A = Math.abs(planarArea(P[0])) * Math.cos(((b[1] + b[3]) / 2) * RAD);
    let m = 0;
    for (const s of sites) if (s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3] && pipPoly(P, s.lon, s.lat)) m += s.w;
    const mid = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const vis = dot(cv, vec(mid[0], mid[1])) >= lim;
    return { k, P, b, A, m, vis, px: pxOf(b) };
  });
  // (a speck's money counts for the part right beside it — Manhattan's for the rest of New York state — so the name
  // goes next to the money, not to the roomiest far-away part)
  const near = Math.max(0.25, 0.012 * view.radius);
  for (const c of parts) {
    c.mr = c.m;
    if (c.px < 8) continue;
    for (const d of parts) if (d !== c && d.px < 8 && d.m > 0 && d.b[0] <= c.b[2] + near && c.b[0] <= d.b[2] + near && d.b[1] <= c.b[3] + near && c.b[1] <= d.b[3] + near) c.mr += 0.8 * d.m;
  }
  const cand = parts.map((c) => Object.assign(c, { sc: score(c.vis, c.A, c.mr, c.px) })).sort((a, b) => b.sc - a.sc).slice(0, 3);
  let best = null;
  const capKm = 0.06 * view.radius * 111.2;
  // the part holding its money hub (a 区 split off one level down sits beside the rest of its province: 深圳 next to
  // 广东) — a part touching it aims its name at the hub
  const hubPart = hub ? polys.find((P) => { const b = ringBBox(P[0]); return hub.lon >= b[0] && hub.lon <= b[2] && hub.lat >= b[1] && hub.lat <= b[3] && pipPoly(P, hub.lon, hub.lat); }) : null;
  const touches = (P, Q) => { const a = ringBBox(P[0]), b = ringBBox(Q[0]), e = 0.05; return a[0] <= b[2] + e && b[0] <= a[2] + e && a[1] <= b[3] + e && b[1] <= a[3] + e; };
  for (const c of cand) {
    // (aim at its heaviest town inside this part — 深圳 in a 科技 that spans half of China — not at the middle of it)
    const b = ringBBox(c.P[0]);
    const on = sites.filter((s) => s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3] && pipPoly(c.P, s.lon, s.lat));
    let tg = null;
    if (hubPart && (hubPart === c.P || touches(hubPart, c.P))) tg = [hub.lon, hub.lat];
    else if (on.length) { const h = hubOf(on, 60); tg = [h.lon, h.lat]; }
    const ip = innerPoint(c.P, tg, capKm);
    const vis = dot(cv, vec(ip[0], ip[1])) >= lim;
    const sc = score(vis, c.A, c.mr, c.px);
    if (!best || sc > best.sc) best = { sc, ip, P: c.P, A: c.A };
  }
  // the town its money is in, on that part (for the edge chip)
  if (best) {
    const b = ringBBox(best.P[0]);
    const on = sites.filter((s) => s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3] && pipPoly(best.P, s.lon, s.lat)).sort((a, x) => x.w - a.w)[0];
    if (on && (on.cityZh || on.city)) placeName = on.cityZh || on.city;
  }
  out.center = best ? best.ip : snapOnto(polys, [hub.lon, hub.lat]);
  out.part = best ? best.P : null;
  // the money is partly in view but none of its land is: the name sits off-screen — say where
  if (out.center && dot(cv, vec(out.center[0], out.center[1])) < lim) {
    out.offscreen = { lon: out.center[0], lat: out.center[1], label: ('→ ' + (placeName || hub && hub.label || '')).trim() };
  }
  return out;
}
const d3dist = (a, b) => globalThis.d3.geoDistance(a, b) * DEG;

// ------------------------------------------------------------------------------------------------ view choice
/**
 * The camera for a metro level. Flying in zooms: ≥ 1.8× the parent's zoom; the frame is the smallest circle holding
 * ≈ 58 % of the money (the rest: edge chips and hover), centred on the money; when that is wider than the zoom
 * allows, the circle of that radius holding the most money with the hub well inside. A country node shows its
 * country, the place the parent drew this node stays in frame, the owner's holdings always stay in frame.
 */
function chooseView(raw, opts, allStocks) {
  const pts = raw.map((s) => ({ v: s.v, w: s.w }));
  const hub = hubOf(raw);
  const hv = vec(hub.lon, hub.lat);
  const pv = opts.par && opts.par.view;
  let maxR = 90;
  if (pv && pv.scale > 0 && !opts.frame) { const s = 1.8 * pv.scale; if (s > 1) maxR = Math.asin(1 / s) * DEG; }
  // sectors: the core of the money; companies / funds (the leaves): most of them — each marker is an item
  const fit = fitCap(pts, allStocks ? 0.72 : 0.58);
  // a sector keeps a little context around its core (AI 算力 → the Bay Area, 债券 → Washington–New York)
  const minRho = allStocks ? 0.45 : Math.max(1.2, pv && pv.scale > 0 ? 0.07 * Math.asin(Math.min(1, 1 / pv.scale)) * DEG : 3);
  let c = fit.c;
  let rho = Math.max(fit.rho * 1.22 + (allStocks ? 0.15 : 0.8), minRho);
  // a level of companies / funds: at least ~60 % of the markers themselves in frame, not just the heaviest town
  if (allStocks && pts.length > 2) {
    const ds = pts.map((p) => ang(c, p.v) * DEG).sort((a, b) => a - b);
    rho = Math.max(rho, ds[Math.min(ds.length - 1, Math.ceil(ds.length * 0.6) - 1)] * 1.15 + 0.15);
  }
  // lean toward the hub (AI 算力 looks at the Bay Area, not at the desert between it and Phoenix)
  if (!opts.frame && ang(c, hv) * DEG < rho * 0.8) { const c2 = unit(slerp(c, hv, 0.35)); rho += ang(c, c2) * DEG; c = c2; }
  // refine (critics 2026-10-28: "AI 算力 at ×32.6 shows 2 of its 7 children"): a sector's camera holds the money hubs
  // of the children that carry ≥ 75 % of its money (weights^0.7, so the small ones count a little more) — the
  // smallest such circle (the main hub inside) within the zoom the fly-in allows; else the circle there holding most
  if (!allStocks && !opts.frame && Array.isArray(opts.kidHubs) && opts.kidHubs.length >= 3) {
    const H = opts.kidHubs, kw = (w) => Math.pow(Math.max(w, 1e-12), 0.7);
    const W = H.reduce((a, h) => a + kw(h.w), 0) || 1;
    const cov = (cc, R) => H.reduce((a, h) => a + (ang(cc, h.v) * DEG <= 0.85 * R ? kw(h.w) : 0), 0) / W;
    const need0 = 0.75;
    if (cov(c, rho) < need0 - 1e-9) {
      const Rmax = Math.min(maxR, 80);
      const cands = [c, hv, ...H.map((h) => h.v)];
      const hs = H.slice().sort((a, b) => b.w - a.w).slice(0, 8);
      for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) { const m = [hs[i].v[0] + hs[j].v[0], hs[i].v[1] + hs[j].v[1], hs[i].v[2] + hs[j].v[2]]; if (Math.hypot(m[0], m[1], m[2]) > 1e-6) cands.push(unit(m)); }
      let best = null, most = null;
      for (const cc of cands) {
        const Rh = (ang(cc, hv) * DEG) / 0.85;
        if (Rh > Rmax) continue;
        const need = H.map((h) => ({ R: (ang(cc, h.v) * DEG) / 0.85, w: kw(h.w) })).sort((a, b) => a.R - b.R);
        let acc = 0;
        for (const n of need) {
          acc += n.w;
          const R = Math.max(n.R, Rh, rho);
          if (R > Rmax) break;
          const cv = acc / W;
          if (!most || cv > most.cv + 1e-9 || (Math.abs(cv - most.cv) <= 1e-9 && R < most.R)) most = { cc, R, cv };
          if (cv >= need0 - 1e-9) { if (!best || R < best.R) best = { cc, R, cv }; break; }
        }
      }
      const pick = best || (most && most.cv > cov(c, rho) + 0.1 ? most : null);
      if (pick) { c = pick.cc; rho = pick.R + 0.3; }
    }
  }
  if (rho > maxR) {
    const R = Math.max(maxR, minRho);
    const c2 = fixedCap(pts, R * 0.85 * RAD, hv, R * 0.55 * RAD);
    // zoom in only while that still shows a real part of the money (a leaf of five currencies is not one city)
    let W = 0, Win = 0, nIn = 0;
    const cosR = Math.cos(R * 0.92 * RAD);
    for (const p of pts) { W += p.w; if (dot(c2, p.v) >= cosR) { Win += p.w; nIn++; } }
    if (allStocks ? Win >= 0.6 * W && nIn >= 0.5 * pts.length : Win >= 0.4 * W) { rho = R; c = c2; }
  }
  if (opts.frame && rho < opts.frame.r * 1.3) {
    // a country node shows its whole country (the parent drew it as that country)
    c = opts.frame.c;
    rho = opts.frame.r * 1.04;
  }
  // where the parent drew this node stays in the inner 80 % (flying into 港股 keeps 香港 on screen)
  const L = opts.par && (opts.par.hub || opts.par.center);
  if (L && !opts.frame) {
    const lv = vec(L[0], L[1]);
    const d = ang(c, lv) * DEG;
    if (d > 0.8 * rho) {
      const t = clamp((d - 0.8 * rho) / d * 0.5, 0, 0.5);
      c = unit(slerp(c, lv, t));
      rho = Math.max(rho, (ang(c, lv) * DEG) / 0.8);
    }
  }
  // keep the owner's holdings in frame
  for (const s of raw) if (s.hold) rho = Math.max(rho, ang(c, s.v) * DEG * 1.15 + 0.2);
  // mostly placeless money: do not dive onto the little that has a place
  if (opts.unsited > 0.5) rho = Math.max(rho, Math.asin(1 / 8) * DEG);
  return viewOf(c, rho);
}

// ------------------------------------------------------------------------------------------------ metro layout
/** Radial outline factor f(θ) ≈ 1 of a metro patch: seeded wobble + a stretch along the metro's own spread. */
function outlineOf(C, places, seed) {
  const r = rng(seed);
  const ph = [r() * TAU, r() * TAU, r() * TAU, r() * TAU];
  let phi = 0, k = 0;
  if (places.length > 1) {
    const [e, n] = frame(C);
    let sxx = 0, syy = 0, sxy = 0, sw = 0;
    for (const P of places) { const x = dot(P.v, e), y = dot(P.v, n); sxx += P.w * x * x; syy += P.w * y * y; sxy += P.w * x * y; sw += P.w; }
    if (sw > 0) {
      const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);           // principal axis, counter-clockwise from east
      phi = Math.PI / 2 - a;                                      // as a bearing (clockwise from north)
      const l1 = (sxx + syy) / 2 / sw + Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy) / sw;
      k = Math.sqrt(Math.max(0, l1));                             // rad: the spread along that axis
    }
  }
  const f = (th, kk) => (1 + 0.06 * Math.sin(2 * th + ph[0]) + 0.045 * Math.sin(3 * th + ph[1]) + 0.028 * Math.sin(5 * th + ph[2]) + 0.014 * Math.sin(8 * th + ph[3])) * (1 + kk * Math.cos(2 * (th - phi)));
  const O = { spread: k, kk: 0, f: (th) => f(th, O.kk) };
  O.set = (Rdeg) => { O.kk = clamp((O.spread * DEG) / Math.max(Rdeg, 1e-6) * 0.35, 0, 0.16); return O; };
  /** the reach toward bearing th (± 25°), as a factor */
  O.toward = (th) => { let m = 0; for (let q = -3; q <= 3; q++) m = Math.max(m, O.f(th + (q * 25 * RAD) / 3)); return m; };
  return O;
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** A closed organic outline (open lon/lat ring, clockwise) around C: radius(θ) in rad; Chaikin-smoothed. */
function organicRing(C, radius, n = 72, passes = 2) {
  let pts = [];
  for (let i = 0; i < n; i++) { const th = (i / n) * TAU; pts.push(dest(C, th, radius(th))); }
  for (let p = 0; p < passes; p++) {
    const q = [];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; q.push(unit(lerp3(a, b, 0.25)), unit(lerp3(a, b, 0.75))); }
    pts = q;
  }
  return toLL(pts, llOf(C)[0]);
}
/** Bearing of u seen from C (rad, clockwise from north); null when they coincide. */
function bearing(C, u) {
  if (ang(C, u) < 1e-7) return null;
  const [e, n] = frame(C);
  return Math.atan2(dot(u, e), dot(u, n));
}

/**
 * Companies at their HQs and funds at their anchors → items. Stock children are points at their place. Region
 * children: places (everything at one city point) → metros (greedy around the heaviest, link 0.8·R0, no chaining)
 * → one organic, land-clipped patch per metro coloured by its heaviest child (or, zoomed in, a core disc + ring
 * wedges), radius ∝ √money on a geographic scale; the other children of a metro get ticks on its rim.
 */
async function metroLayout(land, holdings, opts) {
  const d3 = globalThis.d3;
  const debug = {};
  // ---- sites: one per (child, place); co-located leaves of one child merge
  const raw = [];
  for (const i of land) {
    const m = new Map();
    for (const s of i.sites) {
      const k = Math.round(s.lon * 50) + ',' + Math.round(s.lat * 50) + (s.offshore ? 'o' : '');
      let q = m.get(k);
      if (!q) m.set(k, (q = { group: i.id, info: i, lon: s.lon, lat: s.lat, cc: s.cc, est: true, city: s.city, cityZh: s.cityZh || null, anchor: !!s.anchor, offshore: !!s.offshore, why: s.why || null, w: 0, ts: [], hold: false }));
      q.w += s.w * i.w;
      if (s.t && !q.ts.includes(s.t)) q.ts.push(s.t);
      if (!s.est) q.est = false;
      if (s.t && holdings.has(s.t)) q.hold = true;
      if (!q.why && s.why) q.why = s.why;
    }
    for (const q of m.values()) { q.v = vec(q.lon, q.lat); q.t = q.ts[0] || null; raw.push(q); }
  }
  const allStocks = land.every((i) => i.stock);
  const view = chooseView(raw, opts, allStocks);
  const vr = view.radius;
  const detail = opts.detail || (vr < 7 ? '10m' : '50m');
  const G = await loadGeo(detail === '10m' ? '10m' : vr < 25 ? '50m' : 'medium');
  debug.detail = G.detail;
  const isLand = (lon, lat) => countryAtGeo(G, lon, lat) != null;
  for (const s of raw) if (!s.cc && !s.offshore) s.cc = countryAtGeo(G, s.lon, s.lat) || null;
  const rawBy = new Map();
  for (const s of raw) { if (!rawBy.has(s.group)) rawBy.set(s.group, []); rawBy.get(s.group).push(s); }
  for (const L of rawBy.values()) L.sort((a, b) => b.w - a.w);
  const items = [];
  const t2 = cfg.now();

  // ---- stock children: a marker exactly at its place (renderers fan crowds out in screen space)
  const stockKids = land.filter((i) => i.stock && rawBy.has(i.id));
  if (stockKids.length) {
    const wmax = Math.max(...stockKids.map((i) => i.w));
    for (const i of stockKids) {
      const ss = rawBy.get(i.id);
      const h = hubOf(ss);
      const s = h.site;
      const r = clamp(vr * 0.02 * Math.pow(i.w / wmax, 0.18), vr * 0.011, vr * 0.026);
      const at = [round6(s.lon), round6(s.lat)];
      const it = { id: i.id, kind: 'point', at, center: at.slice(), r, rings: [closeRing(discRing(at[0], at[1], r))], area: Math.PI * (r * RAD) ** 2, city: s.city, cityZh: s.cityZh || zhCity(s.city, s.cc), cc: s.cc, est: !!s.est, cell: [] };
      if (s.anchor) {
        it.anchors = ss.slice(0, 8).map((q) => ({ label: q.city, why: q.why || null, w: +(q.w / i.w).toFixed(4), lon: round6(q.lon), lat: round6(q.lat), est: !!q.est, offshore: q.offshore || undefined }));
        it.place = h.label; it.hubShare = +h.share.toFixed(3);
      }
      items.push(it);
    }
    // a city's companies share one group key (a renderer may merge them into '旧金山 ×7' at low zoom)
    const byCity = new Map();
    for (const it of items) { const k = Math.round(it.at[0] * 20) + ',' + Math.round(it.at[1] * 20); if (!byCity.has(k)) byCity.set(k, []); byCity.get(k).push(it); }
    for (const [k, L] of byCity) if (L.length > 1) L.forEach((it, j) => { it.cityGroup = { key: k, n: L.length, rank: j, label: (L[0].cityZh || L[0].city || '') + ' ×' + L.length }; });
  }

  // ---- region children: metros
  const regionKids = land.filter((i) => !i.stock);
  const rs = raw.filter((s) => !s.info.stock);
  const pieceOf = new Map();          // child id → [{polys, w, kind, est}]
  const metroOf = new Map();          // child id → [{at, label, members}]
  const tickOf = new Map();           // child id → [{lon, lat, r, w, label}]
  if (regionKids.length && rs.length) {
    const R0 = 0.075 * vr;                                         // deg
    // a big metro's reach: ≤ ~200 km at country zoom (exaggerated to stay readable), its real ~50 km close up
    const Rmax = Math.max(Math.min(Math.max(1.8, 0.03 * vr), R0), Math.min(0.45, 0.25 * vr));
    const Rmin = Math.max(0.02 * vr, Math.min(0.65, 0.35 * Rmax));  // a one-company town, still readable
    const PX = 370 / vr;                                           // ≈ screen px per degree (the view's radius ≈ 370 px)
    const W = rs.reduce((a, s) => a + s.w, 0) || 1;
    // places: everything at one city point
    const places = new Map();
    for (const s of rs) {
      const k = Math.round(s.lon * 50) + ',' + Math.round(s.lat * 50) + (s.offshore ? 'o' : '');
      let P = places.get(k);
      if (!P) places.set(k, (P = { k, lon: s.lon, lat: s.lat, v: s.v, w: 0, by: new Map(), sites: [], offshore: s.offshore, est: true, vague: true, ccs: new Set(), city: s.city, cityZh: s.cityZh }));
      P.w += s.w;
      P.by.set(s.group, (P.by.get(s.group) || 0) + s.w);
      P.sites.push(s);
      if (s.cc) P.ccs.add(s.cc);
      if (!s.est) P.est = false;
      if (!(s.est && !s.city)) P.vague = false;
    }
    const PL = [...places.values()].sort((a, b) => b.w - a.w || a.k.localeCompare(b.k));
    // metros: greedy around the heaviest places (no chaining); offshore fields only with offshore fields
    const cosLink = Math.cos(0.6 * R0 * RAD);
    const used = new Uint8Array(PL.length);
    const metros = [];
    for (let a = 0; a < PL.length; a++) {
      if (used[a]) continue;
      used[a] = 1;
      const M = { places: [PL[a]], c: PL[a].v, lon: PL[a].lon, lat: PL[a].lat, offshore: PL[a].offshore, key: PL[a].k };
      for (let b = a + 1; b < PL.length; b++) if (!used[b] && PL[b].offshore === M.offshore && dot(PL[a].v, PL[b].v) >= cosLink) { used[b] = 1; M.places.push(PL[b]); }
      metros.push(M);
    }
    const sumUp = (M) => {
      M.w = 0; M.by = new Map(); M.ccs = new Set(); M.est = true; M.vague = true; M.ext = 0;
      for (const P of M.places) {
        M.w += P.w;
        for (const [g, w] of P.by) M.by.set(g, (M.by.get(g) || 0) + w);
        for (const cc of P.ccs) M.ccs.add(cc);
        if (!P.est) M.est = false;
        if (!P.vague) M.vague = false;
        M.ext = Math.max(M.ext, ang(M.c, P.v) * DEG);
      }
      M.owner = [...M.by].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0];
    };
    metros.forEach(sumUp);
    // reach: geographic, ∝ √money (money itself shows as plate height and marker size, §22)
    const cv = vec(view.lon, view.lat), cosView = Math.cos(Math.min(89.9, vr) * RAD);
    const inV = metros.filter((M) => dot(M.c, cv) >= cosView);
    const Wmax = Math.max(...(inV.length ? inV : metros).map((M) => M.w));
    for (const M of metros) {
      let R = clamp(Rmax * Math.pow(M.w / Wmax, 0.28), Rmin, Rmax);
      R = Math.max(R, Math.min(Rmax, 0.7 * M.ext));
      if (M.vague) R = Math.min(R, 0.6);              // a state / country estimate: a small hatched disc
      if (M.offshore) R = Math.min(R, 1.5);           // an offshore field: a small sea patch, never a basin
      M.R = R;
      M.O = outlineOf(M.c, M.places, hash32(M.key)).set(R);
    }
    // neighbours never overlap: a lighter metro shrinks, or joins the heavier one when too little would be left
    const gapDeg = Math.max(0.004 * vr, 0.008);
    metros.sort((a, b) => b.w - a.w || a.key.localeCompare(b.key));
    const kept = [];
    for (const M of metros) {
      let R = M.R, host = null, drop = false;
      for (const K of kept) {
        const d = ang(M.c, K.c) * DEG;
        const fK = K.O.toward(bearing(K.c, M.c) ?? 0), fM = M.O.toward(bearing(M.c, K.c) ?? 0);
        if (d >= K.R * fK + R * fM + gapDeg) continue;
        const R2 = (d - gapDeg - K.R * fK) / fM;
        if (R2 < Math.max(0.6 * Rmin, 0.4 * M.R)) {
          if (M.offshore !== K.offshore) { drop = true; break; }
          host = K; break;
        }
        R = R2;
      }
      if (host) { host.places.push(...M.places); host.absorbed = true; continue; }
      if (drop) { M.tickOnly = true; }
      M.R = R; M.O.set(R);
      kept.push(M);
    }
    for (const M of kept) if (M.absorbed) sumUp(M);
    // split (core + wedges) only when the metro is big on screen; otherwise one patch, owner = heaviest child
    for (const M of kept) {
      const px = M.R * PX;
      M.split = !M.offshore && !M.tickOnly && M.by.size >= 2 && (px >= 60 || (vr < 8 && px >= 40));
      M.claims = [];
      if (M.tickOnly) { for (const [g, w] of M.by) M.claims.push({ g, w, role: 'tick', M, atCentre: g === M.owner }); M.demoted = true; continue; }
      if (M.split) {
        const P0 = M.places[0];
        M.core = [...P0.by].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0];
        const others = [...M.by].filter(([g]) => g !== M.core).sort((a, b) => b[1] - a[1]);
        let nW = 0;
        for (const [g, w] of others) {
          if (w >= 0.03 * M.w && nW < 6) { M.claims.push({ g, w, role: 'wedge', M }); nW++; }
          else M.claims.push({ g, w, role: 'tick', M });
        }
        M.claims.push({ g: M.core, w: M.by.get(M.core), role: 'core', M });
      } else {
        for (const [g, w] of M.by) M.claims.push({ g, w, role: g === M.owner ? 'patch' : 'tick', M });
      }
    }
    // per child: ≤ 4 land pieces, each ≥ 4 % of its money (the first always); the rest become ticks
    const childTot = new Map();
    for (const s of rs) childTot.set(s.group, (childTot.get(s.group) || 0) + s.w);
    const claimsOf = () => {
      const by = new Map();
      for (const M of kept) for (const c of M.claims) { if (!by.has(c.g)) by.set(c.g, []); by.get(c.g).push(c); }
      return by;
    };
    const demote = (M) => {
      M.demoted = true;
      for (const c of M.claims) { c.role = 'tick'; if (c.g === M.owner || c.g === M.core) c.atCentre = true; }
    };
    for (const [g, L] of claimsOf()) {
      const landC = L.filter((c) => c.role !== 'tick').sort((a, b) => b.w - a.w);
      let n = 0;
      for (const c of landC) {
        if (c.M.demoted) continue;
        if (c.role === 'core' || (n < 4 && (n === 0 || c.w >= 0.04 * childTot.get(g)))) { n++; continue; }
        if (c.role === 'patch') demote(c.M); else c.role = 'tick';
      }
    }
    // ≤ 60 land polygons per view: the lightest metros become ticks (never a child's last patch)
    const nPieces = (M) => (M.demoted ? 0 : M.split ? 1 + M.claims.filter((c) => c.role === 'wedge').length : 1);
    let total = kept.reduce((a, M) => a + nPieces(M), 0);
    if (total > 60) {
      const landCount = new Map();
      for (const M of kept) if (!M.demoted) for (const c of M.claims) if (c.role !== 'tick') landCount.set(c.g, (landCount.get(c.g) || 0) + 1);
      for (const M of kept.filter((x) => !x.demoted).sort((a, b) => a.w - b.w)) {
        if (total <= 60) break;
        const mine = M.claims.filter((c) => c.role !== 'tick');
        if (mine.some((c) => (landCount.get(c.g) || 0) <= 1)) continue;
        total -= nPieces(M);
        for (const c of mine) landCount.set(c.g, landCount.get(c.g) - 1);
        demote(M);
      }
    }
    debug.metros = kept.length; debug.pieces = total;
    // ticks wanted: the heaviest ones; a child without any land piece always keeps its heaviest presence
    const hasLand = new Set();
    for (const M of kept) if (!M.demoted) for (const c of M.claims) if (c.role !== 'tick') hasLand.add(c.g);
    const ticks = [];
    for (const M of kept) for (const c of M.claims) if (c.role === 'tick') ticks.push(c);
    ticks.sort((a, b) => b.w - a.w || String(a.g).localeCompare(String(b.g)));
    const perChild = new Map();
    const want = [];
    for (const c of ticks) {
      const n = perChild.get(c.g) || 0;
      // (a place holding ≥ 10 % of a child's own money always shows: 避险货币 → 东京, however small the child)
      const must = (!hasLand.has(c.g) && n === 0) || (n < 3 && c.w >= 0.1 * (childTot.get(c.g) || 1));
      if (!must && (n >= 6 || want.length >= 100 || c.w < 0.002 * W)) { debug.skippedTicks = (debug.skippedTicks || 0) + 1; continue; }
      perChild.set(c.g, n + 1);
      want.push(c);
      (c.M.ticks || (c.M.ticks = [])).push(c);
    }
    const rtMin = Math.max(0.0065 * vr, 0.5 * Rmin), rtMax = Math.max(rtMin, 0.45 * Rmax);
    const gapRad = gapDeg * RAD;
    const noteTick = (c, pos, rt) => {
      const [lo, la] = llOf(pos);
      if (!tickOf.has(c.g)) tickOf.set(c.g, []);
      tickOf.get(c.g).push({ lon: round6(lo), lat: round6(la), r: +(rt * DEG).toFixed(4), w: +(c.w / (childTot.get(c.g) || 1)).toFixed(3), label: c.M.places[0].cityZh || c.M.places[0].city || null });
    };
    /** where a child's companies sit inside metro M (unit vector) */
    const prefOf = (M, g) => {
      const m = [0, 0, 0];
      for (const P of M.places) { const w = P.by.get(g) || 0; m[0] += w * P.v[0]; m[1] += w * P.v[1]; m[2] += w * P.v[2]; }
      return Math.hypot(m[0], m[1], m[2]) > 1e-12 ? unit(m) : M.c;
    };

    // ---- geometry
    const countryPolys = (ccs) => { const out = []; for (const cc of ccs) { const L = cc && G.byCC.get(cc); if (L) for (const P of L) out.push(P); } return out; };
    const clipLand = (ring, ccs, holes = []) => {
      const subj = ccs && ccs.size ? countryPolys(ccs) : [];
      return clipZone([ring, ...holes], subj.length ? subj : G.all);
    };
    const tickRing = (pos, rt, g) => organicRing(pos, (th) => rt * (1 + 0.05 * Math.sin(3 * th + (hash32(g) % 7))), 28, 1);
    const tickPolys = (pos, rt, g, ccs) => {
      const [lo, la] = llOf(pos);
      const cc = countryAtGeo(G, lo, la);
      const polys = clipLand(tickRing(pos, rt, g), cc ? new Set([cc]) : ccs);
      return polys.length ? polys : asPolys(organicRing(pos, () => rt, 24, 0));
    };
    const asPolys = (ring) => { const P = orientPoly([openRing(ring)]); return P ? [P] : []; };
    const addPiece = (g, polys, w, kind, est) => {
      if (!polys.length) return;
      if (!pieceOf.has(g)) pieceOf.set(g, []);
      pieceOf.get(g).push({ polys, w, kind, est });
    };
    const avoid = [];   // placed shapes as discs {v, r (rad)} — ticks keep clear of them
    for (const M of kept) {
      if (M.demoted) continue;
      const C = M.c, O = M.O, Rr = M.R * RAD;
      const prof = (th) => Rr * O.f(th);
      let rmax = 0;
      for (let q = 0; q < 36; q++) rmax = Math.max(rmax, prof((q / 36) * TAU));
      avoid.push({ v: C, r: rmax });
      const label = M.places[0].cityZh || M.places[0].city || null;
      const members = [...M.by].sort((a, b) => b[1] - a[1]).map(([id, w]) => ({ id, w: +(w / M.w).toFixed(3) }));
      const note = (g) => { if (!metroOf.has(g)) metroOf.set(g, []); metroOf.get(g).push({ at: [round6(M.lon), round6(M.lat)], label, members }); };
      if (M.offshore) {
        // an offshore field: a small sea patch at the field, shrunk until it is clear of the coast
        let s = 1;
        for (let k = 0; k < 8; k++) {
          let wet = !isLand(M.lon, M.lat);
          for (let q = 0; q < 16 && wet; q++) { const p = llOf(dest(C, (q / 16) * TAU, s * prof((q / 16) * TAU) * 1.1)); if (isLand(p[0], p[1])) wet = false; }
          if (wet) break;
          s *= 0.75;
        }
        addPiece(M.owner, asPolys(organicRing(C, (th) => s * prof(th), 48, 1)), M.by.get(M.owner), 'sea', true);
        note(M.owner);
        continue;
      }
      const wedges = M.split ? M.claims.filter((c) => c.role === 'wedge') : [];
      if (!wedges.length) {
        const g = M.split ? M.core : M.owner;
        // the other children of this metro: small discs inside the patch, at their own part of town (a round hole
        // cut around each), as long as the patch is big enough on screen to hold them
        const holes = [];
        if (M.ticks && M.R * PX >= 22) {
          const inside = [];
          for (const c of M.ticks) {
            if (inside.length >= 5) break;
            const rt = clamp(M.R * 0.45 * Math.sqrt(c.w / M.w), Math.max(0.11 * M.R, 4.5 / PX), 0.2 * M.R) * RAD;
            const pref = prefOf(M, c.g);
            const b0 = bearing(C, pref) ?? ((hash32(c.g) % 360) * RAD);
            const dp = ang(C, pref);
            const cand = [];
            // (the middle stays the owner's: a solid core where its name goes)
            if (dp - rt * 1.4 >= 0.5 * Rr && dp + rt * 1.4 <= 0.9 * prof(b0)) cand.push(pref);
            for (const f of [0.74, 0.86, 0.64]) for (let q = 0; q < 15; q++) {
              const th = b0 + (q % 2 ? 1 : -1) * Math.ceil(q / 2) * (24 * RAD);
              const d = Math.min(f * prof(th), 0.92 * prof(th) - rt * 1.4);
              if (d - rt * 1.4 < 0.5 * Rr) continue;
              cand.push(dest(C, th, d));
            }
            let pos = null;
            for (const p of cand) {
              if (inside.some((t) => ang(t.v, p) < (t.r + rt) * 1.35 + gapRad)) continue;
              let ok = isLand(...llOf(p));
              for (let q = 0; q < 6 && ok; q++) { const e = llOf(dest(p, (q / 6) * TAU, rt * 1.4)); ok = isLand(e[0], e[1]); }
              if (ok) { pos = p; break; }
            }
            if (!pos) continue;
            inside.push({ v: pos, r: rt });
            c.placed = true;
            holes.push(organicRing(pos, () => rt * 1.32, 28, 0));
            addPiece(c.g, tickPolys(pos, rt, c.g, M.ccs), c.w, 'tick', M.est);
            noteTick(c, pos, rt);
          }
        }
        let polys = clipLand(organicRing(C, prof, 72, 2), M.ccs, holes);
        if (!polys.length) polys = asPolys(organicRing(C, (th) => prof(th) * 0.6, 48, 1));   // an HQ on a speck the coastline data drops
        addPiece(g, polys, M.by.get(g), 'patch', M.est);
        note(g);
        continue;
      }
      // zoomed in: the heaviest child at the city point keeps a core disc (plus its own sector of the ring); the
      // others get ring sectors that point toward their own companies, sharing the metro's LAND in proportion to
      // money (a coastal metro's sea side is clipped away, so the sectors are laid out on the land arc)
      const coreF = clamp(0.62 * Math.sqrt(M.by.get(M.core) / M.w), 0.32, 0.56);
      const inner = (th) => prof(th) * coreF;
      const list = [...wedges, { g: M.core, w: M.by.get(M.core), role: 'core', M }].map((c) => {
        const m = [0, 0, 0];
        for (const P of M.places) { const w = P.by.get(c.g) || 0; m[0] += w * P.v[0]; m[1] += w * P.v[1]; m[2] += w * P.v[2]; }
        const b = Math.hypot(m[0], m[1], m[2]) > 1e-12 ? bearing(C, unit(m)) : null;
        return { c, th: b == null ? ((hash32(c.g) % 3600) / 3600) * TAU : b, w: c.w };
      }).sort((a, b) => a.th - b.th || String(a.c.g).localeCompare(String(b.c.g)));
      let shares = list.map((k) => k.w);
      const ssum = shares.reduce((a, b) => a + b, 0) || 1;
      shares = shares.map((x) => Math.max(x / ssum, 0.08));
      const s2 = shares.reduce((a, b) => a + b, 0);
      shares = shares.map((x) => x / s2);
      const NB = 72;
      const landBin = new Float64Array(NB);
      for (let b = 0; b < NB; b++) {
        let n = 0;
        const th = ((b + 0.5) / NB) * TAU;
        for (const f of [0.6, 0.92]) { const p = llOf(dest(C, th, inner(th) + (prof(th) - inner(th)) * f)); if (isLand(p[0], p[1])) n++; }
        landBin[b] = n / 2;
      }
      let landTot = 0;
      for (let b = 0; b < NB; b++) landTot += landBin[b];
      const wb = new Float64Array(NB);
      for (let b = 0; b < NB; b++) wb[b] = (landTot < NB * 0.08 ? 1 : landBin[b]) + 0.015;
      let start = 0;
      if (landTot < NB * 0.97 && landTot >= NB * 0.08) {
        let best = -1, bestAt = 0;
        for (let b = 0; b < NB; b++) {
          if (landBin[b] > 0.34 || landBin[(b - 1 + NB) % NB] <= 0.34) continue;
          let len = 0;
          while (len < NB && landBin[(b + len) % NB] <= 0.34) len++;
          if (len > best) { best = len; bestAt = b; }
        }
        if (best > 0) start = ((bestAt + best / 2) / NB) * TAU;
      } else {
        let sx = 0, sy = 0, acc = 0;
        list.forEach((k, j) => { const mid = acc + (shares[j] * TAU) / 2; acc += shares[j] * TAU; const d = k.th - mid; sx += k.w * Math.cos(d); sy += k.w * Math.sin(d); });
        start = Math.atan2(sy, sx);
      }
      const wtot = wb.reduce((a, b) => a + b, 0);
      const step = TAU / NB;
      const angleAt = (F) => {
        let acc = 0, a = start;
        for (let q = 0; q < NB * 2; q++) {
          const b = ((Math.floor((a + 1e-9) / step) % NB) + NB) % NB;
          const next = (Math.floor((a + 1e-9) / step) + 1) * step;
          const seg = next - a, m = (wb[b] * seg) / step;
          if (acc + m >= F * wtot) return a + ((F * wtot - acc) / (m || 1e-12)) * seg;
          acc += m; a = next;
        }
        return start + TAU * F;
      };
      const bounds = [start];
      let F = 0;
      for (let j = 0; j < list.length; j++) { F += shares[j]; bounds.push(j === list.length - 1 ? start + TAU : angleAt(F)); }
      // a gently curved side between two wedges (shared exactly by both)
      const side = (a) => {
        const out = [];
        const bend = hash32(M.key + ':' + (((a % TAU) + TAU) % TAU).toFixed(4)) % 2 ? 1 : -1;
        for (const t of [1 / 3, 2 / 3]) { const th = a + 0.035 * Math.sin(Math.PI * t) * bend; out.push(dest(C, th, inner(a) + (prof(a) - inner(a)) * t)); }
        return out;   // inner → outer
      };
      const arc = (a0, a1, fn) => {
        const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (3 * RAD)));
        const out = [];
        for (let q = 0; q <= n; q++) { const th = a0 + ((a1 - a0) * q) / n; out.push(dest(C, th, fn(th))); }
        return out;
      };
      // the core child: one star-shaped piece — the core disc and its own sector out to the rim
      const lon0 = llOf(C)[0];
      const coreRing = [];
      list.forEach((k, j) => {
        const a0 = bounds[j], a1 = bounds[j + 1];
        if (k.c.g === M.core) {
          coreRing.push(...side(a0), ...arc(a0, a1, prof), ...side(a1).reverse());
          return;
        }
        const ring = [...arc(a0, a1, prof), ...side(a1).reverse(), ...arc(a1, a0, inner), ...side(a0)];
        addPiece(k.c.g, clipLand(openRing(toLL(ring, lon0)), M.ccs), k.w, 'wedge', M.est);
        note(k.c.g);
        coreRing.push(...arc(a0, a1, inner));
      });
      let polys = clipLand(openRing(toLL(coreRing, lon0)), M.ccs);
      if (!polys.length) polys = asPolys(organicRing(C, (th) => inner(th) * 0.8, 48, 1));
      addPiece(M.core, polys, M.by.get(M.core), 'core', M.est);
      note(M.core);
    }
    // ---- the remaining ticks: just outside the rim of their metro's patch (or, for a metro without a patch, at
    // the city point itself and around it)
    const freeAt = (p, r) => avoid.every((a) => ang(a.v, p) >= a.r + r + gapRad * 0.5);
    for (const c of want) {
      if (c.placed) continue;
      const M = c.M;
      const rt = clamp(Rmax * Math.sqrt(c.w / Wmax) * 0.8, rtMin, rtMax) * RAD;
      const pref = prefOf(M, c.g);
      let pos = null;
      if ((c.atCentre || M.demoted) && freeAt(pref, rt) && isLand(...llOf(pref))) pos = pref;
      if (!pos) {
        const b0 = bearing(M.c, pref) ?? ((hash32(c.g) % 360) * RAD);
        const base = M.demoted ? 0 : (avoid.find((a) => a.v === M.c) || { r: M.R * RAD }).r;
        let fallback = null;
        for (let ring = 0; ring < 3 && !pos; ring++) {
          const d = base + rt * (1.25 + ring * 2.2) + gapRad;
          for (let q = 0; q < 18 && !pos; q++) {
            const th = b0 + (q % 2 ? 1 : -1) * Math.ceil(q / 2) * (20 * RAD);
            const p = dest(M.c, th, d);
            if (!freeAt(p, rt)) continue;
            if (isLand(...llOf(p))) pos = p; else if (!fallback && !hasLand.has(c.g)) fallback = p;
          }
        }
        if (!pos) pos = fallback;
      }
      if (!pos) { debug.lostTicks = (debug.lostTicks || 0) + 1; continue; }
      avoid.push({ v: pos, r: rt });
      addPiece(c.g, tickPolys(pos, rt, c.g, M.ccs), c.w, 'tick', M.est);
      noteTick(c, pos, rt);
    }
    debug.ticks = want.length;
  }

  // ---- region items
  for (const i of regionKids) {
    const srcSites = (rawBy.get(i.id) || []).map((r) => ({ t: r.t, ts: r.ts, lon: round6(r.lon), lat: round6(r.lat), city: r.city, cityZh: r.cityZh || zhCity(r.city, r.cc), w: r.w, cc: r.cc, est: r.est, why: r.why || undefined, offshore: r.offshore || undefined }));
    if (!srcSites.length) continue;
    const ps = pieceOf.get(i.id) || [];
    let polys = [];
    for (const p of ps) for (const P of p.polys) polys.push(P);
    polys = finishPolys(polys).filter((P) => { const a = d3.geoArea({ type: 'Polygon', coordinates: P }); return a > 0 && a < TAU; });
    const hub = hubOf(srcSites);
    const estW = srcSites.filter((s) => s.est).reduce((a, s) => a + s.w, 0), allW = srcSites.reduce((a, s) => a + s.w, 0);
    if (!polys.length) {
      const r = vr * 0.012;
      polys = [[closeRing(discRing(hub.lon, hub.lat, r))]];
    }
    const it = {
      id: i.id, kind: 'land', shape: 'metro', polygons: polys, rings: [].concat(...polys), area: polysArea(polys), parts: polys.length,
      countries: [...new Set(srcSites.map((s) => s.cc).filter(Boolean))], sites: srcSites.slice(0, 12), est: estW > allW / 2,
      hub: [round6(hub.lon), round6(hub.lat)], hubLabel: hub.label, hubCC: hub.site.cc || null, hubShare: +hub.share.toFixed(3),
    };
    if (i.ancW > 0.5 * (i.geoW || 1) && hub.share >= 0.5) it.place = hub.label;
    if (metroOf.has(i.id)) it.metros = metroOf.get(i.id);
    if (tickOf.has(i.id)) it.ticks = tickOf.get(i.id);
    const { center, offscreen } = centerOf(polys, srcSites, view, hub, i.names);
    it.center = center || [round6(hub.lon), round6(hub.lat)];
    if (offscreen) it.offscreen = offscreen;
    items.push(it);
  }
  debug.clipMs = Math.round(cfg.now() - t2);
  return { view, detail: G.detail === '10m' ? '10m' : '50m', items, debug };
}

/** Internals, for the dev harness / tests only. */
export const _internals = { clipZone, nestRings, toLL, fitCap, countryAtGeo, loadGeo, hubOf, chooseView, organicRing, loadUnitsMeta, unitFile, unitAt, dissolveUnits, innerPoint };
