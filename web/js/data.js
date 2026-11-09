// data.js — loaders for web/data/*.json + /api, and tree helpers (DESIGN.md §3, §7, §19).
// Every loader returns a cached promise.
// Data root: `data/` (精选 curated map), `data/fm/` (全市场 full market) or `data/gl/` (全球, phase 4 §23)
// — setRoot() switches it.
// Shared feature files (intel.json, polymarket.json, heartbeat.json, scenarios/, graph/, …) always live in `data/`.
// Dev only: `?data=<folder>` in the page URL points the map loaders at another folder (e.g. a fixture).
// There is deliberately NO silent fallback to fixture data: made-up weather must never look real.

const params = new URLSearchParams(location.search);
const override = (params.get('data') || '').replace(/[^\w\-\/]/g, '');
const SHARED = 'data/';
let ROOT = override ? override.replace(/\/?$/, '/') : SHARED;

const cache = new Map();

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function cached(key, fn) {
  if (!cache.has(key)) {
    const p = fn().catch((e) => { cache.delete(key); throw e; });
    cache.set(key, p);
  }
  return cache.get(key);
}

// files that belong to the whole app, not to one map (so they do not move with the 精选/全市场 toggle)
const SHARED_RX = /^(intel|polymarket|kalshi|heartbeat|overrides|scout_log|scenarios|guess|holdings|liquidity|macro|claude_usage)\b|^(scenarios|graph|scout|intel|why|flows)\//;
const urlOf = (name) => (SHARED_RX.test(name) && !override ? SHARED : ROOT) + name;
const file = (name) => cached(ROOT + name, () => getJSON(ROOT + name));

/** Current map root ('data/' or 'data/fm/'). */
export const dataBase = () => ROOT;
export const isFullMarket = () => ROOT !== SHARED && /fm\/$/.test(ROOT);
export const isGlobal = () => ROOT !== SHARED && /gl\/$/.test(ROOT);
/** Switch the map root (clears every cache). */
export function setRoot(root) {
  if (override) return ROOT;
  ROOT = root || SHARED;
  clearCache();
  return ROOT;
}

export const loadMeta = () => file('meta.json');
export const loadBrief = () => file('brief.json');
export const loadSearch = () => file('search.json');
export const loadMap = (id) => file('maps/' + String(id).replace(/:/g, '_') + '.json');

/** Any JSON under data/ (shared files such as 'intel.json', 'polymarket.json', 'scenarios/x.json'
 *  resolve to data/ even in full-market mode; map files resolve to the current root). Cached until invalidate(). */
export const load = (name) => { const u = urlOf(name); return cached(u, () => getJSON(u)); };
/** Same as load() but always re-fetches. */
export const loadFresh = (name) => { invalidate(name); return load(name); };
/** Forget cached copies of these files (names as passed to load(), or 'maps/…'). No names = everything. */
export function invalidate(names) {
  if (!names) { clearCache(); return; }
  for (const n of [].concat(names)) { cache.delete(urlOf(n)); cache.delete(ROOT + n); cache.delete(SHARED + n); }
}

// stocks: on the 全市场 / 全球 maps a stock file may only exist in the curated folder — try the root, then
// (全球) the lazy builder GET /api/gl/stock?t=, then data/
const stockBase = new Map();
/** A listing outside the US (yfinance suffix: 600519.SS, 7203.T, 0700.HK …) — its file lives on the 全球 map. */
export const isGlobalTicker = (t) => /\.[A-Z]{1,3}$/i.test(String(t || ''));
export function loadStock(ticker) {
  const t = String(ticker).replace(/^s:/, '');
  const name = 'stocks/' + t + '.json';
  return cached(ROOT + name, async () => {
    if (!override && !isGlobal() && isGlobalTicker(t) && !nodeById('s:' + t)) {
      // a 全球 listing opened from 精选 / 全市场 (search covers every map): straight to data/gl/ (server builds it lazily)
      const j = await getJSON(SHARED + 'gl/' + name); stockBase.set(t, SHARED + 'gl/'); return j;
    }
    if (!override && isGlobal() && !isGlobalTicker(t) && !nodeById('s:' + t)) {
      // a US ticker (a configured holding, or a search hit) while the 全球 map is up: its curated / 全市场 file —
      // straight to the one the search index names, so no 404 is ever probed for (console stays clean)
      const sc = scopeOf(t);
      if (sc !== 'fm') {
        try { const j = await getJSON(SHARED + name); stockBase.set(t, SHARED); return j; } catch (e) { if (sc === 'curated') throw e; }
      }
      const j = await getJSON(SHARED + 'fm/' + name); stockBase.set(t, SHARED + 'fm/'); return j;
    }
    if (!override && ROOT === SHARED && !isGlobalTicker(t) && rootNode && !nodeById('s:' + t)) {
      // §20: a 全市场 ticker opened on 精选 (search, peers): its file is data/fm/stocks/<T>.json (built lazily by
      // server.py) — the curated folder only holds the curated tree's stocks, so do not probe it (no 404 noise)
      const j = await getJSON(SHARED + 'fm/' + name); stockBase.set(t, SHARED + 'fm/'); return j;
    }
    try { const j = await getJSON(ROOT + name); stockBase.set(t, ROOT); return j; } catch (e) {
      if (ROOT === SHARED) {
        // §20: search covers every 全市场 ticker — a stock outside the curated map reads its 全市场 file
        // (server.py builds data/fm/stocks/<T>.json lazily when it is not on disk)
        if (override) throw e;
        const j = await getJSON(SHARED + 'fm/' + name); stockBase.set(t, SHARED + 'fm/'); return j;
      }
      if (isGlobal()) {
        try {
          const j = await getJSON('api/gl/stock?t=' + encodeURIComponent(t));
          if (j && !j.error) { stockBase.set(t, ROOT); return j; }
        } catch (e2) { /* fall through to the curated copy */ }
      }
      const j = await getJSON(SHARED + name); stockBase.set(t, SHARED); return j;
    }
  });
}
/** Which map's search index lists a ticker: 'curated' | 'fm' | 'gl' | null (main.js wires the merged search). */
let scopeHint = () => null;
export function setScopeHint(fn) { if (typeof fn === 'function') scopeHint = fn; }
const scopeOf = (t) => { try { return scopeHint(t) || null; } catch (e) { return null; } };
/** The folder the stock view should read <T>.json from (resolves after a probe in full-market mode). */
export async function stockBaseFor(ticker) {
  const t = String(ticker).replace(/^s:/, '');
  if (nodeById('s:' + t)) return ROOT;
  try { await loadStock(t); } catch (e) { /* the stock view shows its own message */ }
  return stockBase.get(t) || ROOT;
}
/** The 全市场 search index (data/fm/search.json), whatever map is showing — merged into search on 精选 (§20). */
export const loadFmSearch = () => cached(SHARED + 'fm/search.json', () => getJSON(SHARED + 'fm/search.json'));
/** Another map's search index by its path under data/ ('search.json' = 精选, 'gl/search.json' = 全球). */
export const loadSharedSearch = (name) => cached(SHARED + name + '#search', () => getJSON(SHARED + name));

/** The tree of the current map root. A tree that arrives after the root moved on (a quick 精选 ⇄ 全球 switch)
 *  never replaces the index of the map that is showing now. */
export function loadTree() {
  const root = ROOT;
  return cached(root + 'tree.json', async () => {
    const tree = await getJSON(root + 'tree.json');
    if (root === ROOT) indexTree(tree);
    return tree;
  });
}
/** The curated map's meta (data/meta.json) whatever map is showing: the newest market day for the 今日 wording. */
export const loadSharedMeta = () => (ROOT === SHARED ? loadMeta() : cached(SHARED + 'meta.json#shared', () => getJSON(SHARED + 'meta.json')));

/** Drop every cached file (after a data refresh) so the next load reads fresh JSON. */
export function clearCache() {
  cache.clear();
  stockBase.clear();
  index.clear();
  paths.clear();
  parents.clear();
}

/** Names inside a served folder (python's directory listing), or null when the server does not list folders.
 *  Used to discover optional files without 404 noise in the console. */
const dirCache = new Map();
export function listDir(dir) {
  dir = dir.replace(/\/?$/, '/');
  if (!dirCache.has(dir)) {
    dirCache.set(dir, (async () => {
      try {
        const r = await fetch(dir, { cache: 'no-store' });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('html')) return null;
        const html = await r.text();
        if (!/Directory listing/i.test(html)) return null;
        const names = new Set();
        for (const m of html.matchAll(/href="([^"?#]+)"/g)) names.add(decodeURIComponent(m[1]));
        return names;
      } catch (e) { return null; }
    })());
  }
  return dirCache.get(dir);
}
export const forgetDir = (dir) => dirCache.delete(dir.replace(/\/?$/, '/'));

/** Does the 全球 map exist (data/gl/tree.json)? (phase 4, §23) */
export async function hasGlobal() {
  forgetDir(SHARED); forgetDir(SHARED + 'gl/');
  const top = await listDir(SHARED);
  if (top) {
    if (!top.has('gl/')) return false;
    const gl = await listDir(SHARED + 'gl/');
    return !!(gl && gl.has('tree.json'));
  }
  try { const r = await fetch(SHARED + 'gl/tree.json', { method: 'HEAD', cache: 'no-store' }); return r.ok; } catch (e) { return false; }
}

/** Does the full-market map exist (data/fm/tree.json)? */
export async function hasFullMarket() {
  forgetDir(SHARED); forgetDir(SHARED + 'fm/');
  const top = await listDir(SHARED);
  if (top) {
    if (!top.has('fm/')) return false;
    const fm = await listDir(SHARED + 'fm/');
    return !!(fm && fm.has('tree.json'));
  }
  try { const r = await fetch(SHARED + 'fm/tree.json', { method: 'HEAD', cache: 'no-store' }); return r.ok; } catch (e) { return false; }
}

// ---------------------------------------------------------------- tree helpers
const index = new Map();   // id -> node (first occurrence)
const paths = new Map();   // id -> [ [ids…], … ] every path from the root
const parents = new Map(); // id -> parent node (first path)
let rootNode = null;

function indexTree(root) {
  index.clear(); paths.clear(); parents.clear();
  rootNode = root;
  const walk = (n, trail, parent) => {
    const p = trail.concat(n.id);
    if (!index.has(n.id)) { index.set(n.id, n); if (parent) parents.set(n.id, parent); }
    if (!paths.has(n.id)) paths.set(n.id, []);
    paths.get(n.id).push(p);
    for (const c of n.children || []) walk(c, p, n);
  };
  walk(root, [], null);
}

/** Id of the tree's root ('world' for the curated map, 'fm-world' for the full market). */
export const rootId = () => (rootNode ? rootNode.id : 'world');
export const rootNodeOf = () => rootNode;

/** Node from tree.json by id (tree must be loaded). Stocks may be passed as "s:MU" or "MU". */
export function nodeById(id) {
  if (id == null) return null;
  if (id === 'world' && rootNode && !index.has('world')) return rootNode;
  return index.get(id) || (index.get('s:' + id) || null);
}

/** First path from the root to `id`, as an array of ids (["world","us","ai-compute"]). */
export function pathIds(id) {
  const n = nodeById(id);
  const ps = n ? paths.get(n.id) : null;
  return ps && ps.length ? ps[0].slice() : null;
}

/** Every path to `id` (a ticker can live in two places). */
export function allPaths(id) {
  const n = nodeById(id);
  return n ? (paths.get(n.id) || []).map((p) => p.slice()) : [];
}

/** Parent node along the first path. */
export function parentOf(id) {
  const n = nodeById(id);
  return n ? parents.get(n.id) || null : null;
}

/** Walk a path of ids from the root; returns the nodes along it or null if it is broken. */
export function nodesOnPath(ids) {
  const root = rootNode;
  if (!root || !ids || !ids.length) return null;
  if (ids[0] !== root.id && !(ids[0] === 'world')) return null;
  const out = [root];
  let cur = root;
  for (const id of ids.slice(1)) {
    const next = (cur.children || []).find((c) => c.id === id);
    if (!next) return null;
    out.push(next); cur = next;
  }
  return out;
}

// ---------------------------------------------------------------- server API
const apiCache = new Map();

/** 5-minute flow for one ticker. Never throws: returns {error} on failure. Cached 60 s. */
export async function fetchIntraday(ticker) {
  const t = String(ticker).replace(/^s:/, '');
  const hit = apiCache.get(t);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  try {
    const r = await fetch('api/intraday?t=' + encodeURIComponent(t), { cache: 'no-store' });
    if (!r.ok) return { error: r.status === 404 ? '盘中数据要用 server.py 启动才有' : `服务器返回 ${r.status}` };
    const data = await r.json();
    if (!data.error) apiCache.set(t, { at: Date.now(), data });
    return data;
  } catch (e) {
    return { error: '连不上服务器' };
  }
}

/** Generic JSON call to server.py: api('scout', {method:'POST', body:{…}}) → parsed JSON or {error}. Never throws. */
export async function api(path, { method = 'GET', body = null, query = null } = {}) {
  let url = 'api/' + String(path).replace(/^\/?(api\/)?/, '');
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
  try {
    const r = await fetch(url, {
      method, cache: 'no-store',
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return { error: r.status === 404 || r.status === 501 ? 'no-server' : `服务器返回 ${r.status}`, status: r.status };
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : { ok: true, text: await r.text() };
  } catch (e) {
    return { error: 'no-server' };
  }
}

/** POST /api/refresh (quick=1 → only the last few days). Returns {started:true} or {error}. */
export async function refreshData({ quick = false } = {}) {
  return api('refresh' + (quick ? '?quick=1' : ''), { method: 'POST' });
}

/** GET /api/status → {running, asOf, log} or {error}. */
export const getStatus = () => api('status');

// ---------------------------------------------------------------- 为什么 (§21, §24) — never throw, {error} on failure
/** POST /api/why {target, force?} → {id, state:'queued'|'running'|'cached', card?, pos?} */
export const whyAsk = (target, { force = false } = {}) => api('why', { method: 'POST', body: force ? { target, force: true } : { target } });
/** GET /api/why?id= → {state, card?, error?, pos?} */
export const whyJob = (id) => api('why', { query: { id } });
/** GET /api/why/peek?key= → cached card only (free), or {state:'none'} */
export const whyPeek = (key) => api('why/peek', { query: { key } });
