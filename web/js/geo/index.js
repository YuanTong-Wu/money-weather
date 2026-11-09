// geo/index.js — one geometry contract for every planet (DESIGN §25 + §26).
//
//   getLayout(node, childNodes, mapJson, {mode: 'real'|'abstract'|'earth'}) → Promise<Layout>
//
// Layout (§26) is an ARRAY of items that also carries the §26 object fields, so both readings work:
//   layout.items  === layout                     [{id, kind:'land'|'sea'|'point', rings, center, area, neutral?}]
//   layout.view   {lon, lat, scale}              where the camera looks; scale = zoom (1 = the whole globe fits)
//   layout.context {states?: true}               extra context layers (US states, faint)
//   layout.mode   'real' | 'abstract' | 'earth'  what the layout actually IS (after any fallback)
//   layout.front  [lon, lat]                     (abstract / earth) where the planet should face by default
//   layout.detail '50m' | '10m'                  (real) the coastline the land items match
//   layout.lod    {level, zoomMin, zoomMax, …}   (real) the unit level of these territories and the camera zoom range
//                                                they are meant for — outside it, call getLayout(…, {mode, map, zoom})
//   layout.focus  [{id, via, rank, at, inView}]  (real) today's ①②③ (+ 主航道 ends) and where they are
// rings: [[[lon, lat], …], …] (degrees, d3-geo winding: exterior clockwise), center: [lon, lat], area: steradians.
// kind 'point' items may have no rings (a company at its headquarters). Whatever no ring covers is ocean. Entries
// whose id is not one of the children (or that carry `neutral: true`) are neutral land: drawn as land, never
// coloured by weather, never clickable.
//
// Providers (each optional; missing / broken / not covering every child → the next one):
//   'real'     → geo/real.js (one real Earth: companies at their HQs, sectors = where their companies are, money
//                that has no place = named sea areas) → 'earth' for gl-* (全球) nodes → the 'abstract' chain
//   'abstract' → geo/silhouettes.js (one landmass per child, real continent / island outlines) → geo/islands.js
//   'earth'    → geo/earth.js (real countries, the 全球 map) → the 'abstract' chain
// real.js / silhouettes.js may appear while the page is open: they are polled (a cheap HEAD every 30 s while
// missing, and again on demand); onProvidersChange(fn) tells the planets so they can redraw the current node.

import { getLayout as islandsLayout, isStockNode } from './islands.js';

const DEG = Math.PI / 180;
const POLL_MS = 30000;
const HERE = new URL('./', import.meta.url);

// ------------------------------------------------------------------------------------------ providers
/** A lazily imported provider module that may not exist yet (or be half-written): retried with a fresh URL. */
function provider(file, pick) {
  const P = { file, mod: null, p: null, failedAt: 0, tries: 0, gone: false };
  P.load = (force = false) => {
    if (P.mod) return Promise.resolve(P.mod);
    if (P.p) return P.p;
    if (!force && P.failedAt && performance.now() - P.failedAt < POLL_MS) return Promise.resolve(null);
    P.p = (async () => {
      const url = new URL(file, HERE);
      // a cheap existence check first (no module-map poisoning, no parse error while another agent is still typing)
      try {
        const r = await fetch(url.href, { method: 'HEAD', cache: 'no-store' });
        // (read the empty body to the end: an unread HEAD response is reported as an aborted request)
        await r.arrayBuffer().catch(() => null);
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) { P.failedAt = performance.now(); P.gone = true; return null; }
      P.tries++;
      try {
        // a failed dynamic import is cached by the browser for that exact URL: retries use a fresh one
        const m = await import(P.tries > 1 ? url.href + '?v=' + P.tries + '-' + Date.now() : url.href);
        const f = pick(m);
        if (typeof f !== 'function') throw new Error('no getLayout export');
        P.mod = m; P.fn = f; P.gone = false;
        // the provider's own data changed (real.js: the real hq.json replaced the fixture): forget layouts, redraw
        if (typeof m.onChange === 'function') {
          m.onChange((ev) => {
            memo.clear();
            for (const fn of listeners) { try { fn({ provider: file, reason: ev && ev.reason }); } catch (e) { console.warn('[geo] listener', e); } }
          });
        }
        if (P.tries > 1 || P.wasGone) console.info(`[geo] ${file} 到了`);
        return m;
      } catch (e) {
        console.info(`[geo] ${file} 还不能用（${e && e.message}），先用旧的画法`);
        P.failedAt = performance.now(); P.wasGone = true;
        return null;
      } finally { P.p = null; }
    })();
    return P.p;
  };
  return P;
}
const pickGL = (m) => m.getLayout || m.layout || m.default;
const REAL = provider('real.js', pickGL);
const SIL = provider('silhouettes.js', pickGL);
const EARTH = provider('earth.js', (m) => m.getLayout || m.earthLayout || m.default);

const listeners = new Set();
/** fn({provider: 'real.js'|'silhouettes.js'}) when a provider that was missing becomes available. */
export function onProvidersChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Which providers are loaded right now (for the UI / tests). */
export function providers() { return { real: !!REAL.mod, silhouettes: !!SIL.mod, earth: !!EARTH.mod }; }

let pollT = 0;
function schedulePoll() {
  if (pollT || typeof window === 'undefined') return;
  pollT = setTimeout(async () => {
    pollT = 0;
    for (const P of [REAL, SIL]) {
      if (P.mod || !P.used) continue;
      const had = !!P.mod;
      const m = await P.load(true).catch(() => null);
      if (m && !had) {
        memo.clear();
        for (const fn of listeners) { try { fn({ provider: P.file }); } catch (e) { console.warn('[geo] listener', e); } }
      }
    }
    if ((REAL.used && !REAL.mod) || (SIL.used && !SIL.mod)) schedulePoll();
  }, POLL_MS);
}

// ------------------------------------------------------------------------------------------ helpers
/** A small round point-island (a market too small to see on a whole planet, e.g. 港股), nudged off the coast. */
function pointIsland(lon, lat, rDeg) {
  const ring = [];
  for (let i = 0; i <= 48; i++) {
    const a = (-i / 48) * Math.PI * 2; // clockwise (d3 winding)
    ring.push([lon + (Math.cos(a) * rDeg) / Math.max(0.2, Math.cos(lat * DEG)), lat + Math.sin(a) * rDeg]);
  }
  return ring;
}
const okLL = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]);
const okRing = (r) => Array.isArray(r) && r.length >= 4 && okLL(r[0]);

/** earth.js entries → contract entries (exact polygons with holes; tiny markets as point-islands) + neutral land. */
async function earthEntries(E, list) {
  const out = [];
  for (const e of list) {
    let rings = [];
    if (Array.isArray(e.polygons) && e.polygons.length) for (const p of e.polygons) for (const r of p) rings.push(r);
    else rings = (e.rings || []).slice();
    if (e.tiny) {
      const m = e.marker || e.center || [0, 0];
      // a pickable island just off the coast (south-east: open water for 港股), ~1° across
      rings = [pointIsland(m[0] + 0.85, m[1] - 0.75, 0.62)];
    }
    out.push({ id: e.id, kind: 'land', rings, center: e.center, area: e.area });
  }
  // neutral land: every coast on the planet, under the coloured countries (uncut, d3-native)
  try {
    const land = typeof E.landPolygons === 'function' ? await E.landPolygons({ spherical: true }) : [];
    for (const poly of land || []) out.push({ id: '__land', kind: 'land', neutral: true, rings: poly });
  } catch (e) { console.warn('[geo] neutral land', e && e.message); }
  return out;
}

/** Any provider answer (array, or {view, items, context}) → a normalized item array + its fields. */
function normalize(ans, kids, mode) {
  const raw = Array.isArray(ans) ? ans : ans && Array.isArray(ans.items) ? ans.items : [];
  const kidSet = new Set(kids.map((c) => c.id));
  const items = [];
  for (const it of raw) {
    if (!it || it.id == null) continue;
    let rings = [];
    if (Array.isArray(it.polygons) && it.polygons.length && !Array.isArray(it.rings)) for (const p of it.polygons) for (const r of p) rings.push(r);
    else if (Array.isArray(it.rings)) rings = it.rings.filter(okRing);
    const center = okLL(it.center) ? [+it.center[0], +it.center[1]] : okLL(it.at) ? [+it.at[0], +it.at[1]] : null;
    let kind = it.kind === 'sea' || it.kind === 'point' || it.kind === 'land' ? it.kind : rings.length ? 'land' : center ? 'point' : 'land';
    if (kind !== 'point' && !rings.length && center) kind = 'point';
    const neutral = !!it.neutral || !kidSet.has(it.id);
    const o = Object.assign({}, it, { id: it.id, kind, rings, center, area: +it.area || 0, neutral });
    items.push(o);
  }
  const src = Array.isArray(ans) ? ans : ans || {};
  items.mode = mode;
  items.items = items;
  items.view = normView(src.view) || null;
  items.context = src.context && typeof src.context === 'object' ? Object.assign({}, src.context) : {};
  if (okLL(src.front)) items.front = [+src.front[0], +src.front[1]];
  if (src.__sphereKey) items.__sphereKey = src.__sphereKey;
  // real.js extras the renderers read: coastline detail the land was cut with, the unit level and the zoom range it
  // is meant for (lod), today's ①②③ places (focus), which layout ran
  if (src.detail) items.detail = src.detail;
  if (src.lod && typeof src.lod === 'object') items.lod = src.lod;
  if (Array.isArray(src.focus)) items.focus = src.focus;
  if (src.layout) items.layout = src.layout;
  if (!items.view) items.view = viewOf(items, mode);
  return items;
}

function normView(v) {
  if (!v || typeof v !== 'object') return null;
  const lon = +v.lon, lat = +v.lat;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  let s = +v.scale;
  if (!Number.isFinite(s) || s <= 0) s = 1;
  return { lon, lat: Math.max(-89, Math.min(89, lat)), scale: Math.max(1, Math.min(60, s)) };
}

/** Where to look when the provider did not say: the items' centre, zoomed so every item fits (scale 1 = globe). */
function viewOf(items, mode) {
  const own = items.filter((it) => !it.neutral);
  if (mode !== 'real' || !own.length) {
    const f = items.front || [0, 8];
    return { lon: f[0], lat: f[1], scale: 1 };
  }
  const v = (lon, lat) => { const a = lon * DEG, b = lat * DEG, c = Math.cos(b); return [c * Math.sin(a), Math.sin(b), c * Math.cos(a)]; };
  // every item counts once (≤ 24 samples each), so one sprawling region does not outvote twenty companies
  const groups = [];
  for (const it of own) {
    if (it.kind === 'sea') continue; // sea areas follow the land, not the other way round
    const g = [];
    if (it.rings.length) {
      const all = it.rings.reduce((n, r) => n + r.length, 0), step = Math.max(1, Math.floor(all / 24));
      let i = 0;
      for (const r of it.rings) for (const p of r) { if (i++ % step === 0) g.push(v(p[0], p[1])); }
    } else if (it.center) g.push(v(it.center[0], it.center[1]));
    if (g.length) groups.push(g);
  }
  if (!groups.length) for (const it of own) if (it.center) groups.push([v(it.center[0], it.center[1])]);
  if (!groups.length) return { lon: 0, lat: 20, scale: 1 };
  const c = [0, 0, 0];
  for (const g of groups) for (const p of g) { c[0] += p[0] / g.length; c[1] += p[1] / g.length; c[2] += p[2] / g.length; }
  const l = Math.hypot(c[0], c[1], c[2]);
  if (l < 1e-6) return { lon: 0, lat: 20, scale: 1 };
  c[0] /= l; c[1] /= l; c[2] /= l;
  // the bulk in view (85 % of the items whole), a far outlier may sit off-screen
  const far = groups.map((g) => Math.max(...g.map((p) => Math.acos(Math.max(-1, Math.min(1, p[0] * c[0] + p[1] * c[1] + p[2] * c[2])))))).sort((a, b) => a - b);
  const q = far[Math.min(far.length - 1, Math.floor(far.length * 0.85))];
  const rho = Math.min(far[far.length - 1], q * 1.12);
  const scale = rho >= Math.PI / 2 * 0.95 ? 1 : Math.max(1, Math.min(24, 0.86 / Math.sin(Math.max(rho, 0.035) * 1.12)));
  return { lon: Math.atan2(c[0], c[2]) / DEG, lat: Math.asin(c[1]) / DEG, scale };
}

/** Does a provider's answer cover every child with something drawable (rings, or a point for 'real')? */
function covers(items, kids, mode) {
  if (!Array.isArray(items) || !items.length) return false;
  const have = new Set();
  for (const it of items) {
    if (!it || it.neutral) continue;
    if (it.rings && it.rings.some(okRing)) have.add(it.id);
    else if (mode === 'real' && it.center) have.add(it.id);
  }
  return kids.every((c) => have.has(c.id));
}

// ------------------------------------------------------------------------------------------ layouts
const memo = new Map();
const isGl = (node, kids) => String((node && node.id) || '').startsWith('gl-') || kids.some((c) => String(c.id || '').startsWith('gl-'));

async function abstractChain(node, kids, mapJson, opts) {
  SIL.used = true;
  const S = await SIL.load();
  if (!S) schedulePoll();
  if (S) {
    try {
      const ans = await SIL.fn(node, kids, mapJson, Object.assign({}, opts, { mode: 'abstract' }));
      const items = normalize(ans, kids, 'abstract');
      if (covers(items, kids, 'abstract')) return items;
      if (items.length) console.info('[geo] silhouettes.js 没覆盖所有子区域，这一层用抽象群岛：', node && node.id);
    } catch (e) { console.warn('[geo] silhouettes.js 出错，用抽象群岛：', e && e.message); }
  }
  const list = await islandsLayout(node, kids, mapJson, opts);
  return normalize(list, kids, 'abstract');
}

async function earthChain(node, kids, mapJson, opts) {
  const E = await EARTH.load(true).catch(() => null);
  if (E) {
    try {
      const list = await EARTH.fn(node, kids, mapJson, Object.assign({}, opts, { mode: 'earth' }));
      if (covers(normalize(list, kids, 'earth'), kids, 'earth')) {
        const items = normalize(await earthEntries(E, list), kids, 'earth');
        if (Array.isArray(list) && list.front) items.front = list.front;
        return items;
      }
      if (list && list.length) console.info('[geo] earth.js 没覆盖所有子区域，这一层用抽象群岛：', node && node.id);
    } catch (e) { console.warn('[geo] earth.js 出错，用抽象群岛：', e && e.message); }
  }
  return abstractChain(node, kids, mapJson, opts);
}

async function realChain(node, kids, mapJson, opts) {
  REAL.used = true;
  const M = await REAL.load();
  if (!M) schedulePoll();
  if (M) {
    try {
      const ans = await REAL.fn(node, kids, mapJson, Object.assign({}, opts, { mode: 'real' }));
      const items = normalize(ans, kids, 'real');
      if (covers(items, kids, 'real')) return items;
      if (items.length) console.info('[geo] real.js 没覆盖所有子区域，这一层先用旧画法：', node && node.id);
    } catch (e) { console.warn('[geo] real.js 出错，这一层先用旧画法：', e && e.message); }
  }
  return isGl(node, kids) ? earthChain(node, kids, mapJson, opts) : abstractChain(node, kids, mapJson, opts);
}

export async function getLayout(node, childNodes, mapJson, opts = {}) {
  const kids = (childNodes || (node && node.children) || []).filter((c) => c && c.id != null);
  const mode = opts.mode === 'earth' || opts.mode === 'real' ? opts.mode : 'abstract';
  // (a zoomed re-ask — opts.zoom, §26 amendment 4 — is a different layout only when it lands on another unit level;
  // each node has its own ladder — real.js ladderFor: the US switches to counties at ×8, Japan at ×10 — known once
  // its default layout ran; until then the zoom itself (¼-octave steps) keys it, so two levels never share a key)
  let zk = '';
  if (mode === 'real' && +opts.zoom > 0) {
    const R = REAL.mod;
    const lad = R && typeof R.ladderFor === 'function' ? R.ladderFor(node, opts.map) : null;
    const lvl = lad && typeof R.levelForZoom === 'function' ? R.levelForZoom(+opts.zoom, node, opts.map) : null;
    zk = lvl != null ? '|z' + lvl : '|q' + Math.round(Math.log2(+opts.zoom) * 4);
    // (metro detail — level 3 — is loaded around the camera centre: one layout per 4° cell)
    const a3 = lad && lad.a3 > 0 ? lad.a3 : 40;
    if (+opts.zoom >= a3 && Array.isArray(opts.at) && Number.isFinite(+opts.at[0]) && Number.isFinite(+opts.at[1])) zk += '@' + Math.floor(+opts.at[0] / 4) + ',' + Math.floor(+opts.at[1] / 4);
  }
  const key = mode + '|' + (opts.map || '') + '|' + (node && node.id) + zk + '|' + kids.map((c) => c.id + ':' + (c.now && c.now.dv20 ? Math.round(Math.log2(c.now.dv20) * 4) : '')).join(',');
  if (memo.has(key)) return memo.get(key);
  const p = (mode === 'real' ? realChain : mode === 'earth' ? earthChain : abstractChain)(node, kids, mapJson, opts);
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  if (memo.size > 80) memo.delete(memo.keys().next().value);
  return p;
}

/** Clear cached layouts (e.g. after hq.json changed). */
export function clearLayouts() { memo.clear(); }

export { isStockNode };
export default getLayout;
