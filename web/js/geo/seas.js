// geo/seas.js — 海域: money that has no place at all, as a small sea area (DESIGN §26 A). Since §26 amendment 1
// (web/data/geo/anchors.json) bonds / cash / crypto / commodities sit where their money really ends up, so geo/real.js
// only falls back to this for money without any anchor (shown as '未定位'). Used by geo/real.js; no DOM,
// deterministic (seeded by ids), works in Node with globals d3.
//
//   placeSeas({view, seas, land, obstacles, landWeight, landAreas, isLand}) → Promise<[item]>
//     view        {lon, lat, radius}   the camera (seas stay inside its visible disc, away from the rim)
//     seas        [{id, name, weight, prefer?:[lon,lat], hint?, unplaced?}]  biggest money gets the best water
//     land        [[outer, …holes], …] spherical land polygons (d3-native winding) — never covered
//     obstacles   [[outer, …holes], …] already placed items (land regions, markers) — never covered
//     landWeight  money on land in this view (sizes seas relative to it); landAreas: their areas (sr)
//     isLand(lon, lat) → bool  exact vector test used for the final "never on land" check
//   item: {id, kind:'sea', rings:[outer], polygons:[[outer]], center, area, sea:'北大西洋' | null, hint?, unplaced?}
//         rings are closed, d3 winding (clockwise = the small side), organic but smooth, ≥ a coast gap from land.
//   A candidate that is a speck (< 1e-5 sr) or that sits on land (its centre, or > 1 % of its sample points, at the
//   drawn detail) is never returned: the result's `failed` lists those ids so the caller can widen the view.
//
//   seaPrefer(node) → [lon, lat] | null   the ocean a kind of money "belongs to" (bonds → off New York, oil → the
//                                          Gulf of Mexico, crypto → off California …), used when it is in view
//   seaHints(node)  → [[lon, lat, label]] | undefined   faint producing-region markers (oil → Permian / Gulf …)
//   seaNameAt(lon, lat) → '北大西洋' …     the real sea under a point
//
// Method: the view's disc is rasterised (azimuthal equidistant, 300²) with land + obstacles + the rim as walls;
// an exact Euclidean distance transform gives "open water"; each sea takes the most open spot near where it
// belongs, grows a seeded wobbly blob clipped by rays to the walls (minus a coast gap), Lipschitz-smoothed so it
// never spikes into a strait; then every vertex is checked against the vector land and pulled in if needed.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

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
function gdist(a, b) {
  const p1 = a[1] * RAD, p2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  const s = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) * DEG;
}

// ------------------------------------------------------------------------------------------------ names
/** [name, lon, lat, radius°] — smallest containing one wins, so bays beat oceans. */
export const SEA_NAMES = [
  ['北大西洋', -40, 38, 30], ['南大西洋', -15, -25, 32], ['北太平洋', -160, 30, 40], ['北太平洋', 165, 30, 30],
  ['南太平洋', -130, -30, 42], ['印度洋', 75, -20, 32], ['南冰洋', 0, -62, 25], ['北冰洋', 0, 82, 16],
  ['墨西哥湾', -90, 25.5, 6.5], ['加勒比海', -75, 15, 9], ['马尾藻海', -62, 30, 9], ['缅因湾', -68, 43, 2.6],
  ['切萨皮克湾', -76.2, 37.8, 1.1], ['长岛海峡', -73, 41.1, 0.6], ['纽约湾', -73.8, 40.4, 0.45],
  ['阿拉斯加湾', -145, 56, 8], ['加利福尼亚湾', -111, 27.5, 4.5], ['旧金山湾', -122.25, 37.65, 0.35],
  ['蒙特雷湾', -122, 36.8, 0.3], ['圣塔芭芭拉海峡', -119.7, 34.2, 0.6], ['普吉特湾', -122.45, 47.6, 0.5],
  ['哈德逊湾', -85, 60, 8], ['拉布拉多海', -55, 58, 7], ['圣劳伦斯湾', -62, 48, 3.5], ['白令海', -178, 58, 9],
  ['北海', 3, 56, 4.8], ['波罗的海', 19, 58, 5], ['地中海', 18, 36, 10], ['比斯开湾', -4, 45.5, 3],
  ['英吉利海峡', -1.5, 50.2, 1.6], ['挪威海', 3, 67, 7], ['黑海', 34, 43.3, 4], ['红海', 38, 20, 6],
  ['波斯湾', 51.5, 27, 3.5], ['阿拉伯海', 64, 15, 9], ['孟加拉湾', 88, 14, 8], ['安达曼海', 96, 10, 4],
  ['南海', 114, 14, 9], ['东海', 125.5, 29, 4.5], ['黄海', 123, 35.5, 3.5], ['渤海', 120, 38.8, 1.6],
  ['日本海', 135, 40, 6], ['台湾海峡', 119.6, 24, 1.6], ['菲律宾海', 132, 18, 10], ['鄂霍次克海', 150, 54, 7],
  ['爪哇海', 111, -5, 5], ['珊瑚海', 155, -17, 8], ['塔斯曼海', 160, -38, 8], ['大澳大利亚湾', 130, -35, 6],
  ['几内亚湾', 3, 2, 7], ['莫桑比克海峡', 41, -18, 6], ['东京湾', 139.8, 35.4, 0.35], ['大阪湾', 135.2, 34.5, 0.3],
  ['濑户内海', 133, 34.2, 1.6], ['珠江口', 113.7, 22.3, 0.45], ['杭州湾', 121.3, 30.4, 0.6], ['长江口', 121.8, 31.4, 0.45],
  ['马六甲海峡', 100, 3.5, 3.5], ['新加坡海峡', 104, 1.2, 0.4], ['里约外海', -43, -23.5, 1.2], ['拉普拉塔河口', -57.5, -35, 1.8],
  ['阿拉伯海东岸', 72.5, 18.8, 1.2], ['波士顿湾', -70.8, 42.35, 0.35], ['特拉华湾', -75.1, 39, 0.6],
];
export function seaNameAt(lon, lat) {
  let best = null, br = Infinity, near = null, nd = Infinity;
  for (const [name, x, y, r] of SEA_NAMES) {
    const d = gdist([lon, lat], [x, y]);
    if (d <= r && r < br) { br = r; best = name; }
    if (d - r < nd) { nd = d - r; near = name; }
  }
  return best || near;
}

// ------------------------------------------------------------------------------------------------ where money lives
const NAME_HINTS = [
  [/原油|石油|汽油|布伦特|oil|USO|BNO|UGA/i, [[-102.5, 31.8, '二叠纪盆地'], [50.5, 26.5, '波斯湾'], [2.5, 57.5, '北海油田']]],
  [/天然气|UNG|FCG/i, [[-77.5, 41.2, '马塞勒斯页岩'], [-92.5, 32.3, '海恩斯维尔'], [51.5, 25.8, '卡塔尔北方气田']]],
  [/黄金|金矿|淘金|gold|GLD|IAU|GDX/i, [[27.9, -26.2, '南非兰德'], [-116.5, 40.5, '内华达金矿'], [121.5, -30.7, '西澳卡尔古利']]],
  [/白银|银矿|silver|SLV|SIL/i, [[-102.6, 22.8, '墨西哥萨卡特卡斯'], [-76.3, -10.7, '秘鲁银矿']]],
  [/铂|钯|PPLT|PALL/i, [[27.3, -25.2, '南非布什维尔德'], [88.2, 69.3, '诺里尔斯克']]],
  [/铜|copper|CPER|COPX/i, [[-69.1, -24.3, '智利阿塔卡马'], [27.5, -11.7, '刚果铜带'], [-110.9, 32.6, '亚利桑那铜矿']]],
  [/铀|uranium|URA|URNM|NLR/i, [[-105.5, 57.6, '阿萨巴斯卡盆地'], [67.5, 44.5, '哈萨克斯坦铀矿']]],
  [/锂|稀土|小金属|lithium|rare|REMX/i, [[-68.2, -23.5, '锂三角'], [118.8, -21.2, '西澳皮尔巴拉'], [109.9, 41.8, '白云鄂博稀土'], [-115.5, 35.5, '芒廷帕斯']]],
  [/粮食|玉米|小麦|化肥|农业|CORN|WEAT|DBA|MOO/i, [[-93.5, 42, '美国玉米带'], [-55.5, -12.5, '巴西马托格罗索'], [-98, 38.5, '堪萨斯麦田']]],
];
const SUB_WORD = { oil: '原油', gas: '天然气', gold: '黄金', silver: '白银', platinum: '铂', palladium: '钯', copper: '铜',
  uranium: '铀', lithium: '锂', rare: '稀土', agri: '粮食', ag: '粮食', grains: '粮食', corn: '玉米', wheat: '小麦' };
/** Faint producing-region markers for commodity money (only as hints — the sea itself stays in the ocean). */
export function seaHints(node, meta) {
  if (!node) return undefined;
  const s = [node.id, node.name, node.desc, ...(node.tags || []), ...(node.children || []).slice(0, 12).map((c) => c.ticker || c.name || ''),
    meta && meta.sub ? SUB_WORD[meta.sub] || meta.sub : ''].join(' ');
  for (const [re, h] of NAME_HINTS) if (re.test(s)) return h.map((x) => x.slice());
  return undefined;
}
/**
 * The ocean a kind of money belongs to (used only when it is inside the current view). meta (from hq.json):
 * {kind:'nongeo'|'region', cat:'bonds'|'commodities'|'crypto'|'cash'|'sector'|'broad'|<region key>, sub:'oil'|'gold'|…,
 * ll:[lon,lat] (a region fund's centre)} — wins over the node's words.
 */
export function seaPrefer(node, meta) {
  if (meta) {
    const sub = meta.sub || '';
    if (meta.kind === 'region' && meta.ll) return meta.ll;            // VGK → near Europe (the sea finds the closest water)
    if (/oil|gas|petrol|gasoline/.test(sub)) return [-90, 25.5];
    if (/copper/.test(sub)) return [-75, -25];
    if (/gold|silver|platinum|palladium|precious|miners/.test(sub)) return [-25, 5];
    if (/uranium/.test(sub)) return [-58, 56];
    if (/agri|grain|corn|wheat|soy|ag$/.test(sub)) return [-88, 27];
    if (meta.cat === 'crypto' || /btc|eth|sol|xrp|crypto/.test(sub)) return [-130, 31];
    if (meta.cat === 'bonds' && /world|intl|em|global/.test(sub)) return [-30, 42];
    if (meta.cat === 'bonds' || meta.cat === 'cash') return /fx|curr/.test(sub) ? [-25, 46] : [-63, 37];
    if (meta.cat === 'commodities') return [-40, 18];
  }
  if (!node) return null;
  const id = String(node.id || '');
  const tags = new Set(node.tags || []);
  const s = [id, node.name || '', node.desc || '', ...tags].join(' ');
  if (/原油|石油|天然气|汽油|oil|gas/i.test(s)) return [-90, 25.5];          // Gulf of Mexico
  if (/铜|copper/i.test(s)) return [-75, -25];                                // off Chile
  if (/黄金|白银|贵金属|铂|钯|gold|silver|precious|miners/i.test(s)) return [-25, 5]; // the open Atlantic
  if (/铀|uranium/i.test(s)) return [-58, 56];                                 // Labrador Sea (→ Athabasca)
  if (/粮食|玉米|小麦|化肥|ag\b|commod-ag/i.test(s)) return [-88, 27];
  if (/crypto|加密|比特币|以太坊|btc|eth/i.test(s)) return [-130, 31];          // off California
  if (/海外债|bonds-world|新兴市场债/i.test(s)) return [-30, 42];
  if (/避险货币|fx|cash-fx/i.test(s)) return [-25, 46];
  if (/bonds|cash|rates|国债|债|现金|利率/i.test(s) || tags.has('rates')) return [-63, 37]; // off New York
  if (/商品|commod/i.test(s)) return [-40, 18];
  if (tags.has('europe') || /欧洲|europe/i.test(s)) return [3, 56];
  if (tags.has('china') || /中国|china|港股/i.test(s)) return [124, 28];
  if (tags.has('japan') || /日本|japan/i.test(s)) return [142, 33];
  if (/新兴|emerging|\bem\b/i.test(s)) return [70, -5];
  return null;
}

// ------------------------------------------------------------------------------------------------ raster helpers
/** d3.geoPath context that collects projected rings. */
function ringSink() {
  const rings = [];
  let cur = null;
  return {
    rings,
    moveTo(x, y) { if (cur && cur.length > 2) rings.push(cur); cur = [[x, y]]; },
    lineTo(x, y) { if (cur) cur.push([x, y]); },
    closePath() { if (cur && cur.length > 2) rings.push(cur); cur = null; },
    arc() {},
    flush() { if (cur && cur.length > 2) rings.push(cur); cur = null; },
  };
}
/** Even-odd scanline fill of one polygon's rings (pixel coords) into mask (1 = wall). */
function fillRings(mask, N, rings) {
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(N - 1, Math.ceil(y1));
  const xs = [];
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const r of rings) {
      for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
        const a = r[i], b = r[j];
        if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(N - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) mask[y * N + x] = 1;
    }
  }
}
/** Exact Euclidean distance transform (Felzenszwalb): distance in px from every pixel to the nearest wall. */
function edt(mask, N) {
  const INF = 1e20;
  const f = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = mask[i] ? 0 : INF;
  const d = new Float64Array(N), v = new Int32Array(N), z = new Float64Array(N + 1), g = new Float64Array(N);
  const pass = (get, set) => {
    for (let q = 0; q < N; q++) g[q] = get(q);
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < N; q++) {
      let s;
      for (;;) {
        const p = v[k];
        s = ((g[q] + q * q) - (g[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k] && k > 0) { k--; continue; }
        break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < N; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + g[p]; }
    for (let q = 0; q < N; q++) set(q, d[q]);
  };
  for (let x = 0; x < N; x++) pass((q) => f[q * N + x], (q, val) => { f[q * N + x] = val; });
  for (let y = 0; y < N; y++) pass((q) => f[y * N + q], (q, val) => { f[y * N + q] = val; });
  const out = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = Math.sqrt(f[i]);
  return out;
}

// ------------------------------------------------------------------------------------------------ placement
export async function placeSeas({ view, seas, land = [], obstacles = [], landWeight = 0, landAreas = [], isLand = null } = {}) {
  const d3 = globalThis.d3;
  if (!seas || !seas.length) return [];
  const N = 300;
  const rho = clamp(view.radius || 90, 0.5, 89.5);
  const k = (N / 2 - 1) / (rho * RAD);
  const proj = d3.geoAzimuthalEquidistant().rotate([-view.lon, -view.lat]).scale(k).translate([N / 2, N / 2])
    .clipAngle(Math.min(rho * 1.04, 175)).precision(0.4);
  const mask = new Uint8Array(N * N);
  const fillGeo = (coords) => {
    const sink = ringSink();
    d3.geoPath(proj, sink)({ type: 'Polygon', coordinates: coords });
    sink.flush();
    if (sink.rings.length) fillRings(mask, N, sink.rings);
  };
  for (const P of land) fillGeo(P);
  for (const P of obstacles) fillGeo(P);
  // the rim: seas keep inside ~92 % of the visible disc
  const rim = (N / 2) * (rho > 60 ? 0.72 : 0.92);  // a whole-globe view: keep off the foreshortened limb
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) > rim) mask[y * N + x] = 1;
  const gap = Math.max(1.6, N * 0.013);  // coast gap (px)

  // target sizes: share of the view's disc by money (sqrt), relative to what is on land here
  const capArea = TAU * (1 - Math.cos(rho * RAD));
  const ref = Math.max(landWeight || 0, ...seas.map((s) => s.weight || 0), 1);
  // seas that have a home in view (oil → the Gulf of Mexico) choose first, then by money
  const homeInView = (s) => !!(s.prefer && gdist([view.lon, view.lat], s.prefer) < rho * 0.95);
  const order = seas.map((s, i) => ({ s, i, h: homeInView(s) })).sort((a, b) => (b.h - a.h) || (b.s.weight || 0) - (a.s.weight || 0) || String(a.s.id).localeCompare(String(b.s.id)));
  const nS = seas.length;
  const maxShare = clamp(0.5 / nS, 0.05, 0.13);
  const out = [];
  const failed = [];
  out.failed = failed;
  let D = edt(mask, N);
  const placed = [];
  for (const { s } of order) {
    const share = clamp(0.2 * Math.sqrt((s.weight || 0) / ref), 0.022, maxShare);
    const A = share * capArea;
    const rt = Math.sqrt(A / Math.PI) * k * (rho > 40 ? 0.92 : 1);
    // preferred spot: its own ocean if visible, else near the middle of the view
    let pref = null;
    if (s.prefer) {
      const d = gdist([view.lon, view.lat], s.prefer);
      if (d < rho * 0.95) pref = proj(s.prefer);
    }
    const mid = [N / 2, N / 2];
    let best = null;
    for (let y = 2; y < N - 2; y += 2) for (let x = 2; x < N - 2; x += 2) {
      const dd = D[y * N + x] - gap;
      if (dd < Math.max(2, rt * 0.3)) continue;
      const cap = Math.min(dd, rt) / rt;
      const dp = pref ? Math.hypot(x - pref[0], y - pref[1]) / (N / 2) : 0;
      const dm = Math.hypot(x - mid[0], y - mid[1]) / (N / 2);
      // spread out from seas already placed (a little)
      let crowd = 0;
      for (const q of placed) crowd += Math.exp(-Math.hypot(x - q[0], y - q[1]) / (N * 0.12));
      const sc = 1.4 * cap - (pref ? 1.0 * dp : 0) - 0.3 * dm - 0.15 * crowd;
      if (!best || sc > best.sc) best = { x: x + 0.5, y: y + 0.5, sc, dd };
    }
    if (!best) {
      // no water left in view: the most open pixel at all (a small pond is better than no place)
      let bi = -1, bv = -1;
      for (let i = 0; i < N * N; i++) if (!mask[i] && D[i] > bv) { bv = D[i]; bi = i; }
      if (bi < 0) for (let i = 0; i < N * N; i++) if (D[i] > bv) { bv = D[i]; bi = i; }
      best = { x: (bi % N) + 0.5, y: Math.floor(bi / N) + 0.5, dd: bv - gap };
    }
    let ring = blob(best, rt, mask, N, gap, hash32(s.id), D);
    // pixel ring → lon/lat
    let ll = ring.map((p) => proj.invert(p)).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (ll.length < 8) {
      ring = [];
      for (let i = 0; i < 24; i++) ring.push([best.x + Math.cos((i / 24) * TAU) * 2, best.y + Math.sin((i / 24) * TAU) * 2]);
      ll = ring.map((p) => proj.invert(p)).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (ll.length < 8) continue;
    }
    const c = proj.invert([best.x, best.y]);
    if (isLand) ll = keepOffLand(ll, c, isLand);
    let closed = ll.concat([ll[0]]);
    let a = d3.geoArea({ type: 'Polygon', coordinates: [closed] });
    if (a > TAU) { closed = closed.slice().reverse(); a = 4 * Math.PI - a; }
    closed = closed.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
    // never a speck, never a "sea" on land (a pond on the Highveld named 南大西洋)
    if (!(a >= 1e-5) || (isLand && onLandShare(closed, c, isLand) > 0.01)) { failed.push(s.id); continue; }
    const item = {
      id: s.id, kind: 'sea', rings: [closed], polygons: [[closed]], center: [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4],
      area: a, sea: isLand && isLand(c[0], c[1]) ? null : seaNameAt(c[0], c[1]),
    };
    if (s.hint) item.hint = s.hint;
    if (s.unplaced) item.unplaced = true;
    item.fill = +(a / A).toFixed(3);   // achieved / wanted area (≪ 1: squeezed into a corner — the caller may widen the view)
    out.push(item);
    placed.push([best.x, best.y]);
    // the new sea (+ gap) becomes a wall for the next ones
    fillRings(mask, N, [ring]);
    D = edt(mask, N);
    for (let i = 0; i < N * N; i++) if (!mask[i] && D[i] < gap * 0.9) mask[i] = 1;
    D = edt(mask, N);
  }
  return out;
}

/** A seeded, smooth, wobbly blob around c (px), each ray stopped `gap` px before the first wall. */
function blob(c, rt, mask, N, gap, seed, D) {
  const r = rng(seed);
  const M = 120;
  const ph = [r() * TAU, r() * TAU, r() * TAU, r() * TAU];
  const sq = 0.82 + r() * 0.3, rot = r() * Math.PI;   // a little elongation, like a real sea basin
  const R = new Float64Array(M), H = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const th = (i / M) * TAU;
    const el = 1 / Math.sqrt((Math.cos(th - rot) / sq) ** 2 + (Math.sin(th - rot) * sq) ** 2);
    const wob = 1 + 0.13 * Math.sin(2 * th + ph[0]) + 0.08 * Math.sin(3 * th + ph[1]) + 0.05 * Math.sin(5 * th + ph[2]) + 0.025 * Math.sin(8 * th + ph[3]);
    R[i] = rt * el * wob;
    // ray to the first wall
    const dx = Math.cos(th), dy = Math.sin(th);
    let h = 0;
    for (let t = 0.5; t < N; t += 0.5) {
      const x = Math.floor(c.x + dx * t), y = Math.floor(c.y + dy * t);
      if (x < 0 || y < 0 || x >= N || y >= N || mask[y * N + x]) { h = t; break; }
      h = t;
    }
    H[i] = Math.max(0.8, h - gap);
    R[i] = Math.min(R[i], H[i]);
  }
  // Lipschitz smoothing (only ever shrinks): no spikes into straits, no sudden notches
  const L = rt * 0.9 * (TAU / M);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 2 * M; i++) { const a = i % M, b = (i + 1) % M; if (R[b] > R[a] + L) R[b] = R[a] + L; }
    for (let i = 2 * M; i > 0; i--) { const a = i % M, b = (i - 1 + M) % M; if (R[b] > R[a] + L) R[b] = R[a] + L; }
  }
  // gentle average, never past the walls
  const S = new Float64Array(M);
  for (let i = 0; i < M; i++) S[i] = Math.min(H[i], (R[(i - 1 + M) % M] + 2 * R[i] + R[(i + 1) % M]) / 4);
  const ring = [];
  for (let i = 0; i < M; i++) {
    const th = (i / M) * TAU;
    ring.push([c.x + Math.cos(th) * S[i], c.y + Math.sin(th) * S[i]]);
  }
  return ring;
}

/** The share of a ring's sample points (centre, vertices, points halfway in) that are on land; the centre counts 100 %. */
function onLandShare(ring, c, isLand) {
  if (isLand(c[0], c[1])) return 1;
  let n = 0, k = 0;
  const step = Math.max(1, Math.floor(ring.length / 40));
  for (let i = 0; i < ring.length - 1; i += step) {
    const p = ring[i];
    if (Math.abs(p[0] - c[0]) > 180) continue;
    for (const t of [1, 0.5]) { const q = [c[0] + (p[0] - c[0]) * t, c[1] + (p[1] - c[1]) * t]; n++; if (isLand(q[0], q[1])) k++; }
  }
  return n ? k / n : 0;
}

/** Pull any vertex that the raster missed but the vector land says is on land back toward the centre. */
function keepOffLand(ll, c, isLand) {
  const out = ll.map((p) => p.slice());
  const lerp = (p, t) => [c[0] + (p[0] - c[0]) * t, c[1] + (p[1] - c[1]) * t];
  for (let i = 0; i < out.length; i++) {
    let p = ll[i];
    const dl = p[0] - c[0];
    if (dl > 180 || dl < -180) continue; // crossing the antimeridian: trust the raster
    let t = 1;
    for (let k = 0; k < 8 && isLand(p[0], p[1]); k++) { t *= 0.85; p = lerp(ll[i], t); }
    out[i] = p;
  }
  // edge midpoints too
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    if (Math.abs(b[0] - a[0]) > 180) continue;
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (isLand(m[0], m[1])) { out[i] = lerp(a, 0.9); out[(i + 1) % out.length] = lerp(b, 0.9); }
  }
  return out;
}
