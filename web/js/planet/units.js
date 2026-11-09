// planet/units.js — §26 amendment 4 in the renderers: the real administrative units a 真实 layout is made of
// (shared by the 3D and the 2D planet; no three.js).
//
//   unitModel(list, kids)     → M | null   (cached per layout list) who owns which admin unit (item.units / metros),
//                                         the ticks (dots of a child inside someone else's unit), tiny territories,
//                                         the hover lists, the unit files the layout used (context.units)
//   unitFiles(M)              → Promise<[F]>  those topologies, fetched lazily once per file for the session
//                                         (vendor/geo/admin{1,2,3}/…, the same files real.js read)
//   unitLines(M, Fs)          → {inner: [[k, Float64Array lon,lat,…], …], neutral: [Float64Array, …]}
//                                inner = a border between two units of the SAME territory (a faint fold line on it);
//                                neutral = a border between two unclaimed units (faint atlas line, level ≥ 2 only).
//                                Borders between territories / with unclaimed land are the territories' own
//                                paper-cut edges (drawn by the renderers from the territory rings) — never twice.
//   unitHit(M, Fs, lon, lat)  → {key, k, name, level, metro} | null — the unit under a point (finest level first)
//   unitText(M, hit, kids)    → {head, line} — '海淀区 · AI 算力' / '这里日成交约 4.5亿美元，AI 算力占 71% · 也有 金融 3 家'
//   tickText(M, tick, kids)   → {head, line} — a minority dot ('加利福尼亚州 · 金融也在这')
//   new UnitTag()             → tag.show(head, line, clientX, clientY) / tag.hide() / tag.destroy(): the small paper
//                                tag both planets show while the pointer rests on a unit (§17 look, §12 voice)
//   placeOfNode(node)         → {ll:[lon, lat], label, w} | null — §26 refine: where a tree node's money is (any depth:
//                                海外股市 › 新兴市场 › 巴西 → 圣保罗): the heaviest 60 km cluster of its leaves' HQs /
//                                fund anchors (geo/real.js hqOf / anchorsOf, weighted by dv20 — real.js hubOf's rule).
//                                Sync; null until geo/real.js and its data are loaded (it asks for them once).
//   deepPlace(child, ids, childAt) → {ll, id} | null — the place of the first of `ids` that lies under `child`
//                                (item.childAt first, else placeOfNode): where an intel tag / a cloud about a deeper
//                                node goes (卢拉连任 → 巴西, not 海外股市's label over Alaska)
//
// Ownership (real.js): a unit belongs to the child with the most money in it. At level 1 a state is the union of its
// counties (the file is admin2: a county is keyed by its own id when it was carved out, else by its state a1); at
// level 3 the admin3 places (Census places, 区/县, wards) replace their county where a file covers it.

import { money } from '../words.js';

const VENDOR = new URL('../../vendor/geo/', import.meta.url);
const files = new Map(); // rel → Promise<F | null>
const models = new WeakMap(); // layout list → M
const linesMemo = new WeakMap(); // M → {sig, out}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('units: ' + src));
    document.head.appendChild(s);
  });
}
async function topoLib() {
  if (!(globalThis.topojson && globalThis.topojson.feature) && typeof document !== 'undefined') await loadScript(new URL('topojson-client.min.js', VENDOR).href);
}

// ------------------------------------------------------------------------------------------------ the model
const isLL = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]);

/** Who owns which unit in this layout (null when the layout has no admin units: abstract maps, the world map). */
export function unitModel(list, kids) {
  if (!list || list.mode !== 'real') return null;
  const hit = models.get(list);
  if (hit && hit.kids === kids) return hit.M;
  const cu = list.context && list.context.units;
  const idx = new Map((kids || []).map((c, k) => [c && c.id, k]));
  const own = new Map(), metro = new Map(), name = new Map(), share = new Map();
  const ticks = [], tiny = new Set(), point = new Map();
  for (const it of list) {
    if (!it || it.neutral) continue;
    const k = idx.get(it.id);
    if (k == null) continue;
    if (it.tiny && it.kind === 'land') tiny.add(k);
    if (it.kind === 'point') {
      // a company: the unit it sits in (hover: '海淀区 · 百度'), never an owner
      if (Array.isArray(it.units) && it.units[0] && it.units[0].id) point.set(k, { id: it.units[0].id, level: it.units[0].level, name: it.unitName || null });
    } else {
      for (const u of it.units || []) {
        if (!u || !u.id || !(u.level >= 1) || u.offshore) continue;
        if (!own.has(u.id)) own.set(u.id, k);
        if (u.name) name.set(u.id, String(u.name));
        share.set(k + '|' + u.id, { w: +u.w || 0, est: !!u.est });
      }
      for (const m of it.metros || []) {
        if (!m || !m.id || !(m.level >= 1)) continue;
        if (!own.has(m.id)) own.set(m.id, k);
        metro.set(m.id, { k, id: m.id, level: m.level, at: isLL(m.at) ? [+m.at[0], +m.at[1]] : null, label: m.label || null, members: Array.isArray(m.members) ? m.members : [] });
        if (m.label && !name.has(m.id)) name.set(m.id, String(m.label));
      }
    }
    for (const t of it.ticks || []) {
      if (!t || !Number.isFinite(+t.lon) || !Number.isFinite(+t.lat)) continue;
      ticks.push({ k, lon: +t.lon, lat: +t.lat, w: +t.w || 0, label: t.label || null, unit: t.unit || null, level: t.level, owner: t.owner || null });
    }
  }
  const level = cu && Number.isFinite(+cu.level) ? +cu.level : list.lod && Number.isFinite(+list.lod.level) ? +list.lod.level : 0;
  const M = {
    level, files: cu && Array.isArray(cu.files) ? cu.files.slice() : [], own, metro, name, share, ticks, tiny, point, idx,
    sig: (cu && Array.isArray(cu.files) ? cu.files.join(',') : '') + '|' + level,
  };
  models.set(list, { kids, M });
  return M;
}

// ------------------------------------------------------------------------------------------------ the files
/**
 * One unit file → F {rel, level, geoms:[{id, a1, a2, name, zh, b:[x0,y0,x1,y1]}], arcs:[Float64Array lon,lat,…],
 * use: Int32Array(2·arcs) (the ≤ 2 geometries on each arc), rings (lazy: per geometry, for point-in-polygon)}.
 */
function loadFile(rel) {
  if (files.has(rel)) return files.get(rel);
  const p = (async () => {
    await topoLib();
    const r = await fetch(new URL(rel, VENDOR).href);
    if (!r.ok) throw new Error('units: ' + r.status + ' ' + rel);
    const t = await r.json();
    return prepFile(t, rel);
  })();
  files.set(rel, p);
  p.catch((e) => { files.delete(rel); console.info('[units] 行政区边界读不到：' + rel + '（' + (e && e.message) + '）'); });
  return p;
}

function prepFile(t, rel) {
  const key = Object.keys(t.objects || {})[0];
  const obj = (t.objects && (t.objects.units || t.objects.admin1 || t.objects[key])) || { geometries: [] };
  const level = /^admin3\//.test(rel) ? 3 : /^admin1\//.test(rel) ? 1 : 2;
  // arcs: quantized + delta-encoded (topojson transform) → absolute lon/lat
  const tr = t.transform;
  const arcs = (t.arcs || []).map((a) => {
    const out = new Float64Array(a.length * 2);
    let x = 0, y = 0;
    for (let i = 0; i < a.length; i++) {
      if (tr) { x += a[i][0]; y += a[i][1]; out[2 * i] = x * tr.scale[0] + tr.translate[0]; out[2 * i + 1] = y * tr.scale[1] + tr.translate[1]; }
      else { out[2 * i] = a[i][0]; out[2 * i + 1] = a[i][1]; }
    }
    return out;
  });
  const use = new Int32Array(arcs.length * 2).fill(-1);
  const geoms = [];
  for (const g of obj.geometries || []) {
    if (!g || !g.arcs || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const p = g.properties || {};
    const id = String(p.id != null ? p.id : p.iso_3166_2 != null ? p.iso_3166_2 : g.id != null ? g.id : '');
    if (!id) continue;
    const gi = geoms.length;
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of polys) for (let ri = 0; ri < P.length; ri++) for (const ai of P[ri]) {
      const a = ai < 0 ? ~ai : ai;
      if (use[2 * a] === -1) use[2 * a] = gi; else if (use[2 * a] !== gi && use[2 * a + 1] === -1) use[2 * a + 1] = gi;
      if (ri) continue; // the bbox from exteriors
      const A = arcs[a];
      if (!A) continue;
      for (let i = 0; i < A.length; i += 2) { const x = A[i], y = A[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    geoms.push({ id, a1: p.a1 || p.iso_3166_2 || null, a2: p.a2 || null, name: p.name || '', zh: p.name_zh || '', b: [x0, y0, x1, y1], polys, rings: null });
  }
  const byId = new Map(geoms.map((g, i) => [g.id, i]));
  return { rel, level, geoms, arcs, use, byId };
}

/** The topologies of a model's files (the ones that load; a missing file is skipped, retried next time). */
export function unitFiles(M) {
  if (!M || !M.files.length) return Promise.resolve([]);
  return Promise.all(M.files.map((f) => loadFile(f).catch(() => null))).then((a) => a.filter(Boolean));
}

// ------------------------------------------------------------------------------------------------ borders
/** The ownership key of a unit geometry at this layout's level ('n:' + … = unclaimed). */
function keyOf(M, F, g) {
  if (M.own.has(g.id)) return g.id;
  if (F.level >= 2 && g.a1 && M.own.has(g.a1) && M.level <= 2) return g.a1; // a state owned whole (level 1 / fallback)
  return M.level === 1 && F.level >= 2 && g.a1 ? 'n:' + g.a1 : 'n:' + g.id;
}

/** Inner fold lines per territory + faint unclaimed borders (see the header). Cached per model and file set. */
export function unitLines(M, Fs) {
  if (!M) return { inner: [], neutral: [] };
  const sig = Fs.map((F) => F.rel).join(',');
  const memo = linesMemo.get(M);
  if (memo && memo.sig === sig) return memo.out;
  const inner = [], neutral = [];
  // at level 3 an admin3 file replaces the counties it covers: their admin2 borders are not drawn twice
  const covered = new Set();
  if (M.level >= 3) for (const F of Fs) if (F.level === 3) for (const g of F.geoms) if (g.a2) covered.add(g.a2);
  for (const F of Fs) {
    if (F.level === 2 && M.level >= 3 && !covered.size) { /* nothing replaced */ }
    const keys = F.geoms.map((g) => keyOf(M, F, g));
    const owners = keys.map((k) => (k.startsWith('n:') ? -1 : M.own.get(k)));
    for (let a = 0; a < F.arcs.length; a++) {
      const ga = F.use[2 * a], gb = F.use[2 * a + 1];
      if (ga < 0 || gb < 0) continue; // a coast (or the file's own edge)
      if (keys[ga] === keys[gb]) continue; // inside one unit (counties of one owned state)
      if (F.level === 2 && covered.size && (covered.has(F.geoms[ga].id) || covered.has(F.geoms[gb].id))) continue;
      const ka = owners[ga], kb = owners[gb];
      if (ka >= 0 && ka === kb) inner.push([ka, F.arcs[a]]);
      else if (ka < 0 && kb < 0 && M.level >= 2) neutral.push(F.arcs[a]);
    }
  }
  const out = { inner, neutral };
  linesMemo.set(M, { sig, out });
  return out;
}

// ------------------------------------------------------------------------------------------------ hover
function ringsOf(F, g) {
  if (g.rings) return g.rings;
  const out = [];
  for (const P of g.polys) for (const R of P) {
    const pts = [];
    for (let j = 0; j < R.length; j++) {
      const ai = R[j], A = F.arcs[ai < 0 ? ~ai : ai];
      if (!A) continue;
      const n = A.length / 2;
      for (let s = 0; s < n; s++) {
        const i = ai < 0 ? n - 1 - s : s;
        if (s === 0 && pts.length) continue; // arcs share their end points
        pts.push(A[2 * i], A[2 * i + 1]);
      }
    }
    if (pts.length >= 6) out.push(Float64Array.from(pts));
  }
  g.rings = out;
  return out;
}
/** Even-odd point-in-polygon over a unit's rings (lon/lat plane; units never jump the antimeridian here). */
function inside(F, g, x, y) {
  if (x < g.b[0] || x > g.b[2] || y < g.b[1] || y > g.b[3]) return false;
  let c = false;
  for (const r of ringsOf(F, g)) {
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-30) + xi) c = !c;
    }
  }
  return c;
}

/** The unit under lon/lat in this layout: an owned unit (metro) when there is one, finest file level first. */
export function unitHit(M, Fs, lon, lat) {
  if (!M || !Fs || !Fs.length) return null;
  const order = Fs.slice().sort((a, b) => b.level - a.level);
  let best = null;
  for (const F of order) {
    for (const g of F.geoms) {
      if (!inside(F, g, lon, lat)) continue;
      const key = keyOf(M, F, g);
      const k = key.startsWith('n:') ? -1 : M.own.get(key);
      const id = key.startsWith('n:') ? (M.level === 1 && F.level >= 2 && g.a1 ? g.a1 : g.id) : key;
      const nm = M.name.get(id) || (id === g.id ? g.zh || g.name : null) || g.zh || g.name || id;
      const h = { key, id, k, name: nm, level: F.level, metro: M.metro.get(key) || null, feature: g };
      if (k >= 0) return h; // an owned unit wins at once
      if (!best) best = h;
      break; // one hit per file is enough
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ words
const nameOf = (kids, id, idx) => {
  const k = idx.get(id);
  const c = k != null ? kids[k] : null;
  return c ? c.name || c.ticker || c.id : null;
};
const pct = (x) => (x >= 0.995 ? '全部' : x >= 0.095 ? Math.round(x * 100) + '%' : x >= 0.0095 ? (x * 100).toFixed(1).replace(/\.0$/, '') + '%' : '不到 1%');

/** The hover words for a unit: head '海淀区 · AI 算力', line '这里日成交约 4.5亿美元，AI 算力占 71% · 也有 金融 3 家'. */
export function unitText(M, hit, kids) {
  if (!M || !hit) return null;
  const k = hit.k;
  if (!(k >= 0)) return { head: hit.name, line: '没被哪个板块占下（钱太少）' };
  const owner = kids[k] ? kids[k].name || kids[k].id : '';
  const head = `${hit.name} · ${owner}`;
  const parts = [];
  const m = hit.metro;
  const sh = M.share.get(k + '|' + hit.key);
  const dv = kids[k] && kids[k].now && +kids[k].now.dv20;
  const mem = m && m.members && m.members.length ? m.members : null;
  const w0 = mem && mem[0] && mem[0].id === kids[k].id ? +mem[0].w : null;
  if (sh && dv > 0 && sh.w > 0) {
    const mine = dv * sh.w;
    const all = w0 > 0 ? mine / w0 : null;
    const est = sh.est ? '（估）' : '';
    if (all != null && w0 < 0.995) parts.push(`这里日成交约 ${money(all)}${est}，${owner}占 ${pct(w0)}`);
    else parts.push(`${owner}在这里日成交约 ${money(mine)}${est}`);
  } else if (w0 != null && w0 < 0.995) parts.push(`${owner}占这里的钱 ${pct(w0)}`);
  if (mem) {
    const others = mem.slice(1).filter((x) => x && (+x.w >= 0.004 || +x.n >= 1));
    if (others.length) {
      const say = others.slice(0, 3).map((x) => {
        const nm = nameOf(kids, x.id, M.idx) || x.id;
        return x.n ? `${nm} ${x.n} 家` : `${nm} ${pct(+x.w)}`;
      });
      parts.push('也有 ' + say.join('、') + (others.length > 3 ? ' 等' : ''));
    } else parts.push('只有它');
  }
  return { head, line: parts.join(' · ') };
}

/** A minority dot: '加利福尼亚州 · 金融也在这' / '日成交约 6.3亿美元，地盘归 AI 算力'. */
export function tickText(M, t, kids) {
  if (!M || !t) return null;
  const c = kids[t.k];
  const nm = c ? c.name || c.id : '';
  const where = t.label || (t.unit && M.name.get(t.unit)) || '';
  const dv = c && c.now && +c.now.dv20;
  const ownK = t.owner != null ? M.idx.get(t.owner) : null;
  const owner = ownK != null && kids[ownK] ? kids[ownK].name || kids[ownK].id : null;
  const parts = [];
  if (dv > 0 && t.w > 0) parts.push(`${nm}在这里日成交约 ${money(dv * t.w)}`);
  parts.push(owner ? `地盘归${owner}（它的钱更多）` : '钱太少，没占下地盘');
  return { head: where ? `${where} · ${nm}也在这` : `${nm}也在这`, line: parts.join(' · ') };
}

// ------------------------------------------------------------------------------------------------ the tag
const STYLE_ID = 'mw-unit-tag-style';
function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.mw-unit-tag{position:fixed;left:0;top:0;z-index:31;pointer-events:none;max-width:300px;padding:5px 9px 6px;
  background:var(--paper,#fbf8f1);border:1px solid var(--line-2,rgba(31,42,68,.2));border-radius:var(--radius-sm,7px);
  box-shadow:var(--shadow,0 4px 14px rgba(92,74,40,.07));color:var(--ink,#1f2a44);font:500 12px/1.45 var(--font,system-ui);
  opacity:0;transition:opacity .18s ease-in-out;white-space:normal}
.mw-unit-tag.on{opacity:1}
.mw-unit-tag b{display:block;font-weight:650;font-size:12.5px;letter-spacing:.01em}
.mw-unit-tag span{display:block;color:var(--ink-2,#464f66);font-size:11.5px}
`;
  document.head.appendChild(s);
}

/** The hover tag (one per planet). It sits above the pointer, never under the shell's hover card. */
export class UnitTag {
  constructor() {
    injectStyle();
    this.el = null;
    this.key = '';
  }
  _el() {
    if (!this.el && typeof document !== 'undefined') {
      this.el = document.createElement('div');
      this.el.className = 'mw-unit-tag';
      this.el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.el);
    }
    return this.el;
  }
  /** avoid: extra client rects ({left, top, right, bottom}) the tag must not cover (a canvas planet's own cards). */
  show(head, line, x, y, avoid = null) {
    const el = this._el();
    if (!el) return;
    const key = head + '|' + (line || '');
    if (key !== this.key) {
      this.key = key;
      el.replaceChildren();
      const b = document.createElement('b'); b.textContent = head;
      el.append(b);
      if (line) { const s = document.createElement('span'); s.textContent = line; el.append(s); }
      this.size = null;
    }
    if (!this.size) { const r = el.getBoundingClientRect(); this.size = { w: r.width || 180, h: r.height || 40 }; }
    const { w, h } = this.size;
    // near the pointer, never under the shell's hover card / top bar / panel: above it first, then below, left, right
    const boxes = (avoid || []).slice();
    // the 3D planet's cards / 主航道 caption and the shell's own 主航道 card are DOM: read them here
    for (const el2 of document.querySelectorAll('.p3-spot, .p3-chan, #hero-cap.in')) {
      if (el2.classList.contains('p3-off')) continue;
      const r = (el2.querySelector('.p3-in, .p3-cin, .hp-main') || el2).getBoundingClientRect();
      if (r.width > 2 && r.height > 2) boxes.push(r);
    }
    for (const id of ['hovercard', 'topbar', 'panel', 'timebar']) {
      const el2 = document.getElementById(id);
      if (!el2 || el2.hidden) continue;
      if (id === 'hovercard' && !el2.classList.contains('on')) continue;
      if (id === 'panel' && document.body.classList.contains('panel-closed')) continue;
      const r = el2.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) boxes.push(r);
    }
    const W = innerWidth, H = innerHeight;
    const cands = [[x - w / 2, y - h - 16], [x - w / 2, y + 22], [x - w - 18, y - h / 2], [x + 18, y - h / 2], [x - w - 18, y - h - 12], [x + 18, y + 18]];
    let best = null;
    for (const [cx0, cy0] of cands) {
      const tx = Math.max(8, Math.min(W - w - 8, cx0)), ty = Math.max(8, Math.min(H - h - 8, cy0));
      let c = Math.hypot(tx - cx0, ty - cy0) * 2;
      for (const r of boxes) {
        const ox = Math.min(tx + w, r.right + 4) - Math.max(tx, r.left - 4), oy = Math.min(ty + h, r.bottom + 4) - Math.max(ty, r.top - 4);
        if (ox > 0 && oy > 0) c += ox * oy;
      }
      if (tx < x + 6 && tx + w > x - 6 && ty < y + 6 && ty + h > y - 6) c += 1e5; // never under the pointer itself
      if (!best || c < best.c) best = { tx, ty, c };
      if (c === 0) break;
    }
    el.style.transform = `translate(${best.tx.toFixed(1)}px, ${best.ty.toFixed(1)}px)`;
    el.classList.add('on');
  }
  hide() { if (this.el) this.el.classList.remove('on'); }
  destroy() { if (this.el) this.el.remove(); this.el = null; }
}

// ------------------------------------------------------------------------------------------------ §26 refine: deep places
let REAL = null, realP = null;
function realMod() {
  if (!realP) realP = import('../geo/real.js').then((m) => { REAL = m; return m; }).catch(() => { realP = null; return null; });
  return REAL;
}
const placeMemo = new WeakMap();
const nodeIdx = new WeakMap(); // child node → Map(id → node) of its subtree
function subtreeIndex(child) {
  let m = nodeIdx.get(child);
  if (m) return m;
  m = new Map();
  const stack = [child];
  let guard = 0;
  while (stack.length && guard++ < 20000) {
    const n = stack.pop();
    if (!n || n.id == null) continue;
    if (!m.has(n.id)) m.set(n.id, n);
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
  }
  nodeIdx.set(child, m);
  return m;
}
const tickerOf = (n) => (n && (n.ticker || (typeof n.id === 'string' && n.id.startsWith('s:') ? n.id.slice(2) : null))) || null;

/** Where a tree node's money is (see the header). */
export function placeOfNode(node) {
  const R = realMod();
  if (!R || !node || typeof R.hqOf !== 'function') return null;
  const hit = placeMemo.get(node);
  if (hit) return hit;
  const sites = [];
  const stack = [node];
  let leaves = 0;
  while (stack.length && leaves < 400) {
    const n = stack.pop();
    if (!n) continue;
    const kids = Array.isArray(n.children) ? n.children : null;
    const t = tickerOf(n);
    if (t && (!kids || !kids.length)) {
      leaves++;
      const w = Math.max(1e-6, +((n.now || {}).dv20) || 0) || 1e-6;
      const h = R.hqOf(t);
      if (h && !h.ng && Number.isFinite(h.lon) && Number.isFinite(h.lat)) sites.push({ lon: h.lon, lat: h.lat, w, label: h.city || null });
      else {
        const A = typeof R.anchorsOf === 'function' ? R.anchorsOf(t) : null;
        if (A) for (const a of A) sites.push({ lon: a.lon, lat: a.lat, w: w * a.w, label: a.place || a.label || null });
      }
    }
    if (kids) for (const c of kids) stack.push(c);
  }
  if (!sites.length) return null;
  // the heaviest 60 km cluster (real.js hubOf): its heaviest member's place
  const RAD = Math.PI / 180, cosR = Math.cos(60 / 6371);
  const V = sites.map((s) => { const a = s.lon * RAD, b = s.lat * RAD, cb = Math.cos(b); return [cb * Math.sin(a), Math.sin(b), cb * Math.cos(a)]; });
  const order = sites.map((_, i) => i).sort((a, b) => sites[b].w - sites[a].w);
  const used = new Uint8Array(sites.length);
  let best = null;
  for (const a of order) {
    if (used[a]) continue;
    let w = 0;
    for (const b of order) if (!used[b] && V[a][0] * V[b][0] + V[a][1] * V[b][1] + V[a][2] * V[b][2] >= cosR) { w += sites[b].w; used[b] = 1; }
    if (!best || w > best.w) best = { w, s: sites[a] };
  }
  const out = { ll: [best.s.lon, best.s.lat], label: best.s.label, w: best.w };
  placeMemo.set(node, out);
  return out;
}

/** The place of the first of `ids` that lies under `child` (see the header). */
export function deepPlace(child, ids, childAt = null) {
  if (!child || !ids || !ids.length) return null;
  const idx = subtreeIndex(child);
  for (const id of ids) {
    if (id == null || id === child.id || !idx.has(id)) continue;
    const ll = childAt && childAt.get ? childAt.get(id) : null;
    if (ll) return { ll, id };
    const p = placeOfNode(idx.get(id));
    if (p) return { ll: p.ll, id };
  }
  return null;
}
