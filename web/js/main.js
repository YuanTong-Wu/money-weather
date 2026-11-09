// main.js — the shell (DESIGN.md §7, §18, §19): state, routing, navigation (fly in/out), attention
// (①②③ + 主航道 + seasons + estimates as planet overlays), theme / voice / map switches, and the `app`
// object every feature module receives in init(app). Feature modules are imported dynamically; a missing
// one is skipped silently.
import * as D from './data.js';
import { loadModules, loadPlanet3D } from './ui/modules.js';
import { store, clamp, cnDate, icon, ICONS, plainLine } from './ui/dom.js';
import { parseHash, planetHash, stockHash, setHash } from './ui/router.js';
import { initTopbar } from './ui/topbar.js';
import { prepareIndex } from './ui/search.js';
import { initGauges } from './ui/gauges.js';
import { initPanel } from './ui/panel.js';
import { initHoverCard } from './ui/hovercard.js';
import { initTimeMachine } from './ui/timemachine.js';
import { initTutorial } from './ui/tutorial.js';
import { initTour } from './ui/tour.js';
import { initSince } from './ui/since.js';
import { initPins, loadPins, savePins } from './ui/pins.js';
import { toast } from './ui/toast.js';
import { initWhy } from './ui/why.js';
import { initHoldings } from './ui/holdings.js';

// ===================================================================== app object (§19)
const listeners = new Map();
const providers = {};          // feature modules can provide openWeb / ask / … (app.provide)
const VOICES = ['sharp', 'mild'];
const THEMES = ['day', 'night'];

/** Public data API: data.js loaders + `root` (data/ or data/fm/). */
const data = Object.assign(Object.create(null), D);
Object.defineProperty(data, 'root', { get: () => D.dataBase(), enumerable: true });

const app = {
  state: {
    nodeId: 'world', path: ['world'], dateIndex: 0, lens: null, pins: [],
    theme: 'day', voice: 'sharp', map: 'curated', render: '3d',
    view: 'planet', ticker: null,
  },
  planet: null,
  data, D: data,
  words: null, W: null,
  meta: null, tree: null, brief: null, searchIndex: [],
  currentMap: null, currentPicks: [], channel: null, lastIdx: 0,
  panelOpen: true, touring: false, planetReady: false, playing: false, fullMarket: false, globalMap: false,
  icon, icons: Object.keys(ICONS),
  /** Subscribe; returns an unsubscribe function. Events: node, date, theme, voice, map, dataReloaded (+ shell-internal ones). */
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(fn);
    return () => app.off(evt, fn);
  },
  off(evt, fn) { const a = listeners.get(evt); if (a) { const k = a.indexOf(fn); if (k >= 0) a.splice(k, 1); } },
  emit(evt, ...args) {
    for (const fn of (listeners.get(evt) || []).slice()) {
      try { fn(...args); } catch (e) { console.error(`[shell] ${evt} handler`, e); }
    }
  },
  toast,
  /** A feature module offers a capability to the others: app.provide('openWeb', fn), app.provide('ask', fn). */
  provide(name, fn) { if (typeof fn === 'function') providers[name] = fn; },
  rootId: () => D.rootId(),
  /** Pick the text variant for the current voice: say(obj,'say') → obj.sayMild when the voice is 温和. */
  say(obj, key = 'say') {
    if (!obj) return '';
    if (app.state.voice === 'mild') {
      const m = obj[key + 'Mild'] ?? obj[key + '_mild'];
      if (m) return m;
    } else {
      const s = obj[key + 'Sharp'];
      if (s) return s;
    }
    return obj[key] || '';
  },
};
window.__mw = app; // handy for debugging in the console

let planet = null, openStockView = null;
const ui = {};

/** Call a Planet method defensively: the planet is built by another agent and may lack a method. */
function P(method, ...args) {
  if (!planet || typeof planet[method] !== 'function') return undefined;
  try { return planet[method](...args); } catch (e) { console.error(`[shell] planet.${method}`, e); return undefined; }
}

// ===================================================================== tree / path helpers
app.pathNodes = () => D.nodesOnPath(app.state.path) || [D.rootNodeOf()].filter(Boolean);
app.currentNode = () => { const ns = D.nodesOnPath(app.state.path); return ns ? ns[ns.length - 1] : D.rootNodeOf(); };
app.isRoot = (id = app.state.nodeId) => id === D.rootId();
/** opts for words.regionWeather / mainChannel on the planet on screen (latest day only): brief.singles (one stock
 *  carries a region's money → said as that stock, not a rotation) and the real-money check (§23: a place whose
 *  estimate the real money contradicts is never a channel end). Headline, 主航道 and 真钱流向 then agree. */
app.rwOpts = (i = app.state.dateIndex) => {
  const o = {};
  if (i !== app.lastIdx) return o;
  if (app.brief?.singles) o.singles = app.brief.singles;
  if (typeof app.realMoney === 'function') o.realOf = (id) => { try { return app.realMoney(id, i); } catch (e) { return null; } };
  return o;
};
/** Each map's brief carries its own measured 5-day season transitions (brief.seasonStats); words.js says
 *  「历史上 5 天后 …」 from them (curated measurement when a map has none). */
function useSeasonStats() {
  try { if (app.brief?.seasonStats) app.W?.setSeasonStats?.(app.brief.seasonStats); } catch (e) { console.warn('[shell] seasonStats', e); }
}
const eq = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
const isStockId = (id) => String(id).startsWith('s:');

function sanitizePath(path) {
  const root = D.rootId();
  if (Array.isArray(path) && path.length) {
    path = path.slice();
    if (path[0] === 'world' && root !== 'world') path[0] = root;
    if (path[0] !== root) path.unshift(root);
    if (D.nodesOnPath(path)) {
      const last = D.nodeById(path[path.length - 1]);
      if (last && last.kind !== 'stock') return path;
    }
  }
  const id = Array.isArray(path) ? path[path.length - 1] : path;
  const p = id ? D.pathIds(id) : null;
  if (p && D.nodeById(id)?.kind !== 'stock') return p;
  return [root];
}

// ===================================================================== navigation (fly in / out)
let navTarget = null, navPromise = null, navJump = false;

/** Fly the planet camera to `path` (array of region ids) without touching the URL. Latest call wins;
 *  resolves when it arrives. jump:true switches without the zoom (used behind the stock view). */
function navTo(path, { jump = false } = {}) {
  path = sanitizePath(path);
  navTarget = path;
  navJump = jump;
  if (!navPromise) navPromise = navLoop().finally(() => { navPromise = null; });
  return navPromise;
}
app.navTo = navTo;

async function navLoop() {
  while (navTarget) {
    const target = navTarget;
    const cur = app.state.path;
    if (app.planetReady && eq(cur, target)) { if (navTarget === target) navTarget = null; continue; }
    let next, dir, focus;
    if (!app.planetReady || navJump) { next = target; dir = 'none'; focus = null; }
    else {
      let k = 0;
      while (k < cur.length && k < target.length && cur[k] === target[k]) k++;
      // out: one zoom back to the common ancestor; in: one zoom through the child that leads to the target
      if (cur.length > k) { next = target.slice(0, Math.max(1, k)); dir = 'out'; focus = cur[k]; }
      else { next = target; dir = 'in'; focus = target[cur.length]; }
    }
    const ok = await showPlanet(next, dir, focus);
    if (!ok && navTarget === target) navTarget = null;
  }
}

async function showPlanet(path, direction, focusChildId, { swap = false } = {}) {
  const nodes = D.nodesOnPath(path);
  if (!nodes) return false;
  const node = nodes[nodes.length - 1];
  let map = null;
  try { map = await D.loadMap(node.id); } catch (e) { map = null; }
  if (!map) {
    toast(`「${node.name}」还没有天气数据`);
    setHash(planetHash(app.state.path), false);
    return false;
  }
  ui.hover?.hide();
  app.state.path = path.slice();
  app.state.nodeId = node.id;
  app.currentMap = map;
  computeAttention();
  applySpotlight();            // stored by the planet now, shown as the new planet appears
  // (a 2D ↔ 3D swap stays on this node and place: the shell's 主航道 card stays up and moves to the new planet's spot)
  if (!swap) heroHold(true);
  app.emit('nav');
  app.emit('node', { id: node.id, node, path: path.slice(), map });
  const t0 = performance.now();
  try {
    await Promise.race([
      Promise.resolve(planet.setNode(node, map, { direction, focusChildId })),
      new Promise((res) => setTimeout(res, 4000)),
    ]);
  } catch (e) {
    console.error('[shell] planet.setNode', e);
    if (app.state.render === '3d') setTimeout(() => autoFallback('error'), 0);
  }
  if (!app.planetReady) { app.planetReady = true; P('setDate', app.state.dateIndex); }
  P('setLens', app.state.lens);
  P('setPins', app.state.pins);
  applyOverlays();
  if (swap) renderHero(); else heroHold(false);
  app.emit('nav-done', { ms: performance.now() - t0 });
  return true;
}

/** User navigation to a planet path: goes through the URL so back/forward work. */
app.go = (path) => {
  path = sanitizePath(path);
  if (!setHash(planetHash(path), true)) applyRoute(parseHash());
};

/** §19: fly to a node id or a path of ids. Stocks open the stock view. Resolves when the camera arrives.
 *  opts.push=false replaces the URL instead of adding a history entry. */
app.flyTo = (x, { push = true, jump = false } = {}) => {
  if (x == null) return Promise.resolve(false);
  let path;
  if (Array.isArray(x)) {
    const last = x[x.length - 1];
    if (isStockId(last)) { app.openStock(String(last).slice(2)); return Promise.resolve(true); }
    path = x;
  } else {
    const n = D.nodeById(x);
    if (!n) { toast('找不到这个地方'); return Promise.resolve(false); }
    if (n.kind === 'stock') { app.openStock(n.ticker || n.id.slice(2)); return Promise.resolve(true); }
    path = D.pathIds(n.id);
  }
  path = sanitizePath(path);
  if (app.state.view === 'stock') { closeStockView(); stockPushed = false; }
  setHash(planetHash(path), !!push);
  return navTo(path, { jump });
};

/** Fly to any node id (region → its planet; stock → stock view). */
app.goId = (id, hintPath = null) => {
  if (!id) return;
  if (isStockId(id)) return app.openStock(String(id).slice(2));
  const p = Array.isArray(hintPath) && hintPath[hintPath.length - 1] === id && D.nodesOnPath(sanitizePath(hintPath)) ? hintPath : D.pathIds(id);
  if (p) app.go(p); else toast('找不到这个地方');
};

app.goSearch = (e) => {
  if (e.ticker || isStockId(e.id)) return app.openStock(e.ticker || String(e.id).slice(2));
  if (e.scope === 'fm') { app.setMap('full').then(() => app.goId(e.id)); return; }
  if (e.scope === 'gl') { app.setMap('global').then(() => app.goId(e.id)); return; }
  if (e.scope === 'curated') { app.setMap('curated').then(() => app.goId(e.id)); return; }
  app.goId(e.id, e.pathIds);
};

/** Esc / backspace / scroll-out: leave the stock view, or fly out one level. */
app.flyOut = () => {
  if (app.state.view === 'stock') return app.closeStock();
  if (app.state.path.length > 1) app.go(app.state.path.slice(0, -1));
};

// ===================================================================== stock view
let stockHandle = null, stockPushed = false, lastStockClose = 0, stockHideTimer = 0, stockBaseNow = null;

app.openStock = (ticker) => {
  ticker = String(ticker).replace(/^s:/, '').toUpperCase();
  if (app.touring) ui.tour?.stop();
  if (app.state.view === 'stock') { setHash(stockHash(ticker), false); applyRoute({ type: 'stock', ticker }); return; }
  stockPushed = true;
  if (!setHash(stockHash(ticker), true)) applyRoute({ type: 'stock', ticker });
};

app.closeStock = () => {
  if (app.state.view !== 'stock') return;
  closeStockView();
  if (stockPushed) { stockPushed = false; history.back(); }
  else setHash(planetHash(app.state.path), true);
};

async function showStock(ticker) {
  const node = D.nodeById('s:' + ticker);
  if (!node) {
    // not on this map: a 全市场 ticker (§20 search covers them all) still opens, on its 全市场 file
    const ok = await D.loadStock(ticker).then(() => true, () => false);
    if (!ok) {
      toast(`没找到 ${ticker}`);
      setHash(planetHash(app.state.path), false);
      if (!app.planetReady) await navTo([D.rootId()]);
      return;
    }
    if (!app.planetReady) await navTo([D.rootId()]);
  }
  if (node && app.state.view !== 'stock') {
    // make sure the planet behind is the stock's home (or one that already shows it)
    const cur = app.planetReady ? app.currentNode() : null;
    if (!cur || !(cur.children || []).some((c) => c.id === node.id)) {
      // the planet behind switches to the stock's home without being waited for (nobody sees it)
      const p = D.pathIds(node.id);
      if (p) { P('pause'); navTo(p.slice(0, -1), { jump: true }).then(() => { if (app.state.view === 'stock') P('pause'); }); }
    }
  }
  const root = document.getElementById('stock-root');
  const base = await D.stockBaseFor(ticker);
  if (stockHandle && typeof stockHandle.setTicker === 'function' && app.state.view === 'stock' && base === stockBaseNow) {
    app.state.ticker = ticker;
    try { stockHandle.setTicker(ticker); stockHandle.setDate?.(app.state.dateIndex); } catch (e) { console.error(e); }
    loadTrackStock(ticker);
    app.emit('nav');
    app.emit('stock', ticker);
    return;
  }
  if (stockHandle) { const h = stockHandle; stockHandle = null; try { h.close(); } catch (e) { console.error(e); } }
  app.state.view = 'stock';
  app.state.ticker = ticker;
  document.body.classList.add('in-stock');
  renderHero();
  ui.hover?.hide();
  ui.tm?.stop();
  P('pause');
  clearTimeout(stockHideTimer);
  root.hidden = false;
  loadTrackStock(ticker);
  if (app.state.view !== 'stock' || app.state.ticker !== ticker) return;
  stockBaseNow = base;
  try {
    stockHandle = openStockView(root, ticker, {
      dateIndex: app.state.dateIndex,
      onClose: () => app.closeStock(),
      onPeer: (t) => app.openStock(t),
      onWeb: (t) => app.openWeb(t),
      onAsk: (kind, target, q) => app.ask(kind, target, q),
      words: app.W,
      dataBase: base,
      theme: app.state.theme,
      app,
    });
  } catch (e) {
    console.error('[shell] openStockView', e);
    toast('这只股票的页面打不开');
  }
  app.emit('nav');
  app.emit('stock', ticker);
}

function closeStockView() {
  if (app.state.view !== 'stock' && !stockHandle) return;
  app.state.view = 'planet';
  app.state.ticker = null;
  lastStockClose = performance.now();
  const h = stockHandle; stockHandle = null;
  try { h?.close(); } catch (e) { console.error(e); }
  const root = document.getElementById('stock-root');
  clearTimeout(stockHideTimer);
  stockHideTimer = setTimeout(() => { if (app.state.view !== 'stock') { root.hidden = true; root.replaceChildren(); } }, 260);
  document.body.classList.remove('in-stock');
  P('resume');
  renderHero();
  app.stockJson = null;
  app.emit('nav');
  app.emit('track');
  app.emit('stock', null);
}

/** The time machine draws the open stock's own price + fronts behind the slider. */
function loadTrackStock(ticker) {
  app.stockJson = null;
  app.emit('track');
  D.loadStock(ticker).then((j) => {
    if (app.state.view === 'stock' && app.state.ticker === ticker) { app.stockJson = j; app.emit('track'); }
  }).catch(() => { /* the stock view shows its own message */ });
}
app.trackSource = () => {
  if (app.state.view === 'stock') {
    const j = app.stockJson;
    return j ? { idx: j.c, front: j.front, kids: [] } : { idx: null, front: null, kids: [] };
  }
  const m = app.currentMap;
  return { idx: m?.self?.idx, front: m?.self?.front, kids: m?.children ? Object.values(m.children) : [] };
};

/** §19: open the 关系网 (company web) for a ticker — provided by web.js. */
app.openWeb = async (ticker) => {
  const t = String(ticker || '').replace(/^s:/, '').toUpperCase();
  if (!t) return;
  if (!providers.openWeb) await mountOne('web', './web.js', { quiet: true });
  if (providers.openWeb) { try { return await providers.openWeb(t); } catch (e) { console.error('[shell] openWeb', e); } }
  toast('关系网还在搭建中，过一会儿再来');
};

/** §19: send Claude (the scout) to find something out. Provided by ui/scout.js; falls back to POST /api/scout. */
app.ask = async (kind = 'ask', target = null, question = '') => {
  if (providers.ask) { try { return await providers.ask(kind, target, question); } catch (e) { console.error('[shell] ask', e); } }
  const r = await D.api('scout', { method: 'POST', body: { kind, target, question } });
  if (r.error) { toast(r.error === 'no-server' ? '侦察兵要用 server.py 打开本页才能出发' : `侦察兵没能出发：${r.error}`, 3600); return r; }
  const nm = target ? (D.nodeById(target)?.name || target) : '';
  toast(`老风派侦察兵去查了${nm ? '：' + nm : ''}。查到了会出现在侦察兵面板里。`, 4200);
  app.emit('ask', { kind, target, question, job: r });
  return r;
};

// ===================================================================== routing
async function applyRoute(r) {
  if (r.type === 'planet' && isStockId(r.path[r.path.length - 1])) {
    r = { type: 'stock', ticker: r.path[r.path.length - 1].slice(2) };
  }
  if (r.type === 'stock') return showStock(r.ticker);
  if (app.state.view === 'stock') { closeStockView(); stockPushed = false; }
  const path = sanitizePath(r.path);
  if (!eq(path, r.path) || planetHash(path) !== location.hash) setHash(planetHash(path), false);   // a cleaned-up URL
  if (app.touring) ui.tour?.stop();
  return navTo(path);
}
addEventListener('hashchange', () => {
  Promise.resolve().then(() => applyRoute(parseHash())).catch((e) => {
    console.warn('[shell] route', e);
    setHash(planetHash([D.rootId()]), false);
    navTo([D.rootId()]).catch(() => {});
  });
});

// ===================================================================== attention (§6, §8): ①②③ + 主航道 + seasons
/** Season of one territory at day i (§8.2) → {key:'spring'|'summer'|'autumn'|'winter', emoji, name, now, next} | null. */
const SEASON_KEYS = { 春: 'spring', 夏: 'summer', 秋: 'autumn', 冬: 'winter', spring: 'spring', summer: 'summer', autumn: 'autumn', fall: 'autumn', winter: 'winter' };
const SEASON_FALLBACK = {
  spring: { emoji: '🌱', name: '春', now: '钱刚开始进来，还不挤', next: '可能进入夏天' },
  summer: { emoji: '☀️', name: '夏', now: '正热、人多', next: '小心入秋' },
  autumn: { emoji: '🍂', name: '秋', now: '钱从拥挤处撤离', next: '可能入冬' },
  winter: { emoji: '❄️', name: '冬', now: '冷清没人管', next: '等春天' },
};
function seasonRule(w, dw, p) {
  if (w > 0.3 && dw > 0.3 && p < 65) return 'spring';
  if (w > 0.3 && p >= 65) return 'summer';
  if ((w < -0.3 && p >= 50) || (dw < -0.6 && p >= 65)) return 'autumn';
  if ((w < -0.3 && p < 50) || (Math.abs(w) <= 0.3 && p < 35)) return 'winter';
  return null;
}
app.seasonAt = (series, i = app.state.dateIndex) => {
  if (!series?.wind || !series?.pres) return null;
  const n = series.wind.length;
  i = clamp(i, 0, n - 1);
  const w = series.wind[i], p = series.pres[i], w5 = series.wind[Math.max(0, i - 5)];
  if (w == null || p == null) return null;
  const dw = w5 == null ? 0 : w - w5;
  // the season's words follow the same money + temperature the card's lines use (words.season mixes them),
  // so a header never says 「钱开始摸进来」 above 「5天净流出」
  let flow5 = null;
  if (Array.isArray(series.flow)) {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - 4); j <= i; j++) if (Number.isFinite(series.flow[j])) { s += series.flow[j]; k++; }
    flow5 = k ? s : null;
  }
  const temp = Array.isArray(series.temp) && Number.isFinite(series.temp[i]) ? series.temp[i] : null;
  if (typeof app.W?.season === 'function') {
    try {
      // DESIGN §8 amendment: the season crash gate needs the series itself (words.crashAt reads its idx)
      const cr = typeof app.W.crashAt === 'function' ? app.W.crashAt(series, i) : null;
      const s = app.W.season(w, dw, p, flow5, temp, cr);
      if (!s) return null;
      const key = SEASON_KEYS[s.key] || SEASON_KEYS[s.name] || null;
      return key ? { ...SEASON_FALLBACK[key], ...s, key } : null;
    } catch (e) { /* fall through */ }
  }
  const key = seasonRule(w, dw, p);
  return key ? { key, ...SEASON_FALLBACK[key] } : null;
};

function computeAttention() {
  computePicks();
  computeChannel();
}

function computePicks() {
  const node = app.currentNode(), map = app.currentMap, i = app.state.dateIndex;
  if (!node || !map) { app.currentPicks = []; return; }
  const kids = node.children || [];
  const kidIds = new Set(kids.map((c) => c.id));
  let picks = [];
  let auto = [];
  try { auto = (app.W.attentionPicks(map, kids, i, 6, { pins: app.state.pins }) || []).map((p) => ({ ...p })); } catch (e) { console.warn('[shell] attentionPicks', e); auto = []; }
  if (app.isRoot(node.id) && i === app.lastIdx && app.brief?.spotlight?.length) {
    // brief spotlights are deep (region / stock); light up the continent each lives in, one number per continent
    for (const s of app.brief.spotlight) {
      const ids = s.pathIds || D.pathIds(s.id) || [];
      const cid = ids[1] || s.id;
      if (!kidIds.has(cid) || picks.some((p) => p.id === cid)) continue;
      const deep = cid !== s.id ? (D.nodeById(s.id) || { name: s.name }) : null;
      picks.push({ id: cid, why: app.say(s, 'why'), score: s.score ?? 1, kind: s.kind, deepId: deep ? s.id : null, deepName: deep?.name || s.name, deepPathIds: ids, src: s });
      if (picks.length >= 3) break;
    }
    // fewer than 3 distinct continents: top up with the planet's own picks
    for (const p of auto) { if (picks.length >= 3) break; if (!picks.some((x) => x.id === p.id)) picks.push(p); }
  } else {
    picks = auto.slice(0, 3);
  }
  // pinned territories that have a front / storm today join the candidates
  for (const id of app.state.pins) {
    if (!kidIds.has(id)) continue;
    const s = map.children?.[id];
    if (!s) continue;
    const fr = s.front?.[i], st = s.storm?.[i];
    if (!fr && !(st >= 0.8)) continue;
    const nm = D.nodeById(id)?.name || id;
    const why = `你关注的${nm}：${fr ? app.W.frontWord(fr).text : app.W.stormWord(st).text}`;
    let score = 1;
    try { score = (app.W.surprise(s, i) || 0) + 0.5; } catch (e) { /* keep 1 */ }
    const ex = picks.find((p) => p.id === id);
    if (ex) { ex.why = why; ex.score = Math.max(ex.score ?? 0, score); ex.pinned = true; } else picks.push({ id, why, score, pinned: true });
  }
  const keepOrder = app.isRoot(node.id) && i === app.lastIdx && app.brief?.spotlight?.length;
  picks = picks.filter((p) => kidIds.has(p.id));
  if (!keepOrder) picks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  picks = picks.slice(0, 3);
  // the owner's money comes first (§20): a loud holding takes a slot (③ if it is not already lit)
  for (const hp of holdingPicks(node, kidIds, i)) {
    const ex = picks.find((p) => p.id === hp.id);
    if (ex) { ex.holding = true; ex.why = hp.why; continue; }
    if (picks.length >= 3) picks[picks.length - 1] = hp; else picks.push(hp);
  }
  for (const p of picks) Object.assign(p, deepInfo(p, i) || {});
  app.currentPicks = picks;
  resolveDeep(picks, i);
}

// ---- a deep spotlight (天然气 lit on 美股) speaks for the deep spot only: its own season, ▲▼ and 挤/空, never the
// container's (phase3-notes #3: one card, one subject). The deep spot's series lives in its parent's map file.
const deepCache = new Map();           // `${root}|${deepId}|${i}` -> {deepSeason, deepDir, deepCrowd} (null fields = unknown)
const deepKey = (p, i) => `${D.dataBase()}|${p.deepId}|${i}`;
function deepInfo(p, i) {
  if (!p.deepId || p.deepId === p.id) return null;
  return deepCache.get(deepKey(p, i)) || { deepSeason: null, deepDir: 0, deepCrowd: null, deepPending: true };
}
async function resolveDeep(picks, i) {
  const todo = picks.filter((p) => p.deepId && p.deepId !== p.id && !deepCache.has(deepKey(p, i)));
  if (!todo.length) return;
  const nodeId = app.state.nodeId;
  await Promise.all(todo.map(async (p) => {
    const key = deepKey(p, i);
    const ids = Array.isArray(p.deepPathIds) && p.deepPathIds[p.deepPathIds.length - 1] === p.deepId ? p.deepPathIds : D.pathIds(p.deepId);
    const parent = ids && ids.length >= 2 ? ids[ids.length - 2] : D.parentOf(p.deepId)?.id;
    let series = null;
    if (parent && D.nodeById(parent)) { try { series = (await D.loadMap(parent))?.children?.[p.deepId] || null; } catch (e) { series = null; } }
    let season = null, dir = 0, crowd = null;
    if (series) {
      season = app.seasonAt(series, i);
      const w = series.wind?.[i], pr = series.pres?.[i];
      dir = w >= 0.5 ? 1 : w <= -0.5 ? -1 : 0;
      crowd = pr >= 80 ? 'hi' : pr <= 20 ? 'lo' : null;
    } else if (i === app.lastIdx && D.nodeById(p.deepId)?.now) {
      const n = D.nodeById(p.deepId).now;
      dir = n.wind >= 0.5 ? 1 : n.wind <= -0.5 ? -1 : 0;
      crowd = n.pres >= 80 ? 'hi' : n.pres <= 20 ? 'lo' : null;
    }
    // the brief's own season for the spot wins (its sentence was written with it)
    const bk = SEASON_KEYS[p.src?.season?.key] || SEASON_KEYS[p.src?.season?.name] || null;
    if (bk && season?.key !== bk) season = { key: bk, ...SEASON_FALLBACK[bk] };
    deepCache.set(key, { deepSeason: season, deepDir: dir, deepCrowd: crowd });
  }));
  if (deepCache.size > 200) for (const k of [...deepCache.keys()].slice(0, 100)) deepCache.delete(k);
  // still the same planet and day: refresh the picks in place (no re-ranking), then the map and the panel
  if (app.state.nodeId !== nodeId || app.state.dateIndex !== i || app.currentPicks !== picks) return;
  for (const p of picks) Object.assign(p, deepInfo(p, i) || {});
  applySpotlight();
  applyOverlays();
  app.emit('picks');
}

/** 主航道 (§8.1): the hero element, and it must be the most certain thing on screen.
 *  app.channel = {from, to, say, hero, …} | null, where hero is
 *   'arrow' — a real two-ended channel (both ends' wind AND 5-day money agree): the planet draws the arc;
 *   'inner' — the continents' channel is weak but one continent holds a clear one (brief.channel.inner):
 *             a pin on that continent 「主航道在美股里：消费 → 机器人汽车」, click flies in (anchor = parent);
 *   'sink' / 'source' — only one end is honest: a ring on it 「钱涌进债券，来处还不明显」 (anchor = that end).
 *  Pins are drawn by the shell (#hero-pin) because the planets only know two-ended arcs; a weak arc is never
 *  drawn at full weight. One honest arrow or none beats a wrong one. */
function computeChannel() {
  const node = app.currentNode(), map = app.currentMap, i = app.state.dateIndex;
  app.channel = null;
  if (!node || !map) return;
  const kids = (node.children || []);
  const kidIds = new Set(kids.map((c) => c.id));
  const toKid = (id) => { if (kidIds.has(id)) return id; const p = D.pathIds(id); const k = p ? p.find((x) => kidIds.has(x)) : null; return k || null; };
  const nm = (id) => D.nodeById(id)?.name || id;
  const mild = app.state.voice === 'mild';
  let ch = null;
  const bch = app.isRoot(node.id) && i === app.lastIdx ? app.brief?.channel : null;
  if (bch && bch.hero && ['arrow', 'inner', 'sink', 'source'].includes(bch.hero)) {
    // brief.py picks the hero with the same rules (pipeline/brief.py build_spine) and writes the headline's own
    // first beat as heroSay: the map, the panel and the headline then say one thing
    const b = bch, inn = b.inner;
    ch = { from: b.from ? toKid(b.from) : null, to: b.to ? toKid(b.to) : null, to2: b.to2 ? toKid(b.to2) : null, say: app.say(b, 'say'), weak: !!b.weak, src: 'brief', hero: b.hero };
    if (b.hero === 'inner' && inn && (inn.from || inn.to)) {
      const parent = toKid(inn.parent || inn.to || inn.from);
      if (parent) {
        ch.inner = { from: inn.from || null, to: inn.to || null, to2: inn.to2 || null, parent, fromName: inn.fromName || nm(inn.from), toName: inn.toName || nm(inn.to), say: app.say(inn, 'say') };
        ch.anchor = parent;
      } else ch = null;
    } else if (b.hero === 'sink') ch.anchor = ch.to;
    else if (b.hero === 'source') ch.anchor = ch.from;
    else if (b.hero === 'arrow' && (!ch.from || !ch.to || ch.from === ch.to)) ch = null;
    if (ch && (ch.hero === 'sink' || ch.hero === 'source') && !ch.anchor) ch = null;
    if (ch && b.heroSay) ch.heroSay = app.say(b, 'heroSay');
  } else if (bch?.from && bch?.to) {
    const b = bch;
    ch = { from: toKid(b.from), to: toKid(b.to), say: app.say(b, 'say'), weak: !!b.weak, src: 'brief' };
    const inn = b.inner;
    if (ch.weak && inn && !inn.weak && !inn.single && inn.from && inn.to) {
      const parent = toKid(inn.parent || inn.to);
      if (parent) ch.inner = { from: inn.from, to: inn.to, to2: inn.to2 || null, parent, fromName: inn.fromName || nm(inn.from), toName: inn.toName || nm(inn.to), say: app.say(inn, 'say') };
    }
  }
  const open_ = () => !ch || (!ch.hero && (!ch.from || !ch.to || ch.from === ch.to));
  if (open_() && typeof app.W.mainChannel === 'function') {
    try {
      const c = app.W.mainChannel(map, kids, i, app.rwOpts(i));
      if (c?.from && c?.to) ch = { ...c, say: app.say(c, 'say') || c.say, from: toKid(c.from), to: toKid(c.to), weak: !!c.weak, src: 'words' };
    } catch (e) { console.warn('[shell] mainChannel', e); }
  }
  // the panel headline's own story (words.regionWeather: same rows, same real-money check) — the ring on the map
  // and the headline must never point at two different places
  let st = null;
  try { st = app.W.regionWeather?.(map, node, kids, i, app.rwOpts(i))?.story || null; } catch (e) { st = null; }
  if (open_()) {
    // no two-ended channel: the one sure end is the one the headline names
    const okEnd = (id) => !!id && kidIds.has(id) && !isEst(kids.find((c) => c.id === id)) && !isEst(map.children?.[id]);
    if (st && okEnd(st.dst)) {
      const x = nm(st.dst);
      ch = { from: null, to: st.dst, hero: 'sink', anchor: st.dst, src: 'auto',
        say: mild ? `钱在流进【${x}】，来处比较分散` : `钱在往【${x}】${st.dstWind > 1.5 ? '狂灌' : '灌'}，源头很散` };
    } else if (st && okEnd(st.src)) {
      const x = nm(st.src);
      ch = { from: st.src, to: null, hero: 'source', anchor: st.src, src: 'auto',
        say: mild ? `钱在离开【${x}】，去向比较分散` : `钱在${st.srcWind < -1.5 ? '夺门逃离' : '撤出'}【${x}】，去向很散` };
    }
  }
  if (open_() && !st) {
    // (only when words could not tell a story at all — with a story and no end, the headline says it is calm, and
    // so does the map) nobody named a channel: an arrow only when BOTH ends are honest — the source loses wind AND money over
    // 5 days, the sink gains both (the money sign must agree, like words.mainChannel / brief.py channel_for);
    // otherwise one end, or nothing
    let lo = null, hi = null;
    const rm = app.rwOpts(i).realOf;
    for (const c of kids) {
      const s = map.children?.[c.id];
      const w = s?.wind?.[i];
      if (w == null || isEst(c) || isEst(s)) continue;
      const f5 = sumBack(s.flow, i, 5);
      if (rm && f5 != null && app.realMoneyClash?.(rm(c.id), f5)) continue;   // the real money says otherwise
      if (w < -0.3 && f5 != null && f5 < 0 && (!lo || w < lo.w)) lo = { id: c.id, w, f5, name: c.name };
      if (w > 0.3 && f5 != null && f5 > 0 && (!hi || w > hi.w)) hi = { id: c.id, w, f5, name: c.name };
    }
    if (lo && hi && lo.id !== hi.id) {
      ch = { from: lo.id, to: hi.id, auto: true, src: 'auto', say: mild ? `主航道：钱从【${lo.name}】流向【${hi.name}】` : `今天的主航道：钱从【${lo.name}】流向【${hi.name}】` };
    } else if (hi) {
      ch = { from: null, to: hi.id, hero: 'sink', anchor: hi.id, src: 'auto', say: mild ? `钱在流进【${hi.name}】，来处比较分散` : `钱在往【${hi.name}】灌，源头很散` };
    } else if (lo) {
      ch = { from: lo.id, to: null, hero: 'source', anchor: lo.id, src: 'auto', say: mild ? `钱在离开【${lo.name}】，去向比较分散` : `钱在逃离【${lo.name}】，去向很散` };
    } else ch = null;
  }
  if (ch && !ch.hero) {
    if (ch.from && ch.to && ch.from !== ch.to && !ch.weak) ch.hero = 'arrow';
    else if (ch.inner) { ch.hero = 'inner'; ch.anchor = ch.inner.parent; }
    else if (ch.weak && ch.from && ch.to) {
      // one end is sure (it named the channel), the other a guess: say so, ring the sure end only
      const f = (id) => Math.abs(sumBack(map.children?.[id]?.flow, i, 5) || 0);
      // the sure end is the one the headline's story named (the other was filled in to make a channel)
      const sinkSure = st && st.dst === ch.to && !st.src ? true : st && st.src === ch.from && !st.dst ? false : f(ch.to) >= f(ch.from);
      if (sinkSure) {
        ch.hero = 'sink'; ch.anchor = ch.to; ch.weakEnd = ch.from;
        ch.say = mild ? `钱在流进【${nm(ch.to)}】，来处还不太明显` : `钱在流进【${nm(ch.to)}】，来处还不明显`;
      } else {
        ch.hero = 'source'; ch.anchor = ch.from; ch.weakEnd = ch.to;
        ch.say = mild ? `钱在离开【${nm(ch.from)}】，去向还不太明显` : `钱在逃离【${nm(ch.from)}】，去向还不明显`;
      }
    } else ch = null;
  }
  if (ch && ch.hero === 'arrow' && !ch.say) ch.say = `今天的主航道：钱从【${nm(ch.from)}】流向【${nm(ch.to)}】`;
  if (ch && (ch.hero === 'sink' || ch.hero === 'source') && ch.src === 'brief' && !ch.heroSay) {
    ch.say = ch.hero === 'sink' ? (mild ? `钱在流进【${nm(ch.anchor)}】，来处还不太明显` : `钱在流进【${nm(ch.anchor)}】，来处还不明显`)
      : (mild ? `钱在离开【${nm(ch.anchor)}】，去向还不太明显` : `钱在逃离【${nm(ch.anchor)}】，去向还不明显`);
  }
  if (ch && ch.heroSay && ch.hero !== 'inner') ch.say = ch.heroSay;
  if (ch && ch.hero === 'inner' && (!ch.inner?.from || !ch.inner?.to)) {
    // only one end inside the continent is sure: a ring on it, in the headline's words
    const inn = ch.inner || {};
    const end = inn.to || inn.from;
    ch.hero = inn.to ? 'sink' : 'source';
    ch.anchor = toKid(end) || ch.anchor;
    ch.say = ch.heroSay || (inn.to ? `美股里钱在涌进【${nm(end)}】` : `美股里钱在撤出【${nm(end)}】`);
    if (!ch.anchor) ch = null;
  }
  if (ch && ch.hero === 'inner') {
    const inn = ch.inner;
    const to = inn.to2 ? `${inn.toName}、${nm(inn.to2)}` : inn.toName;
    // the continents' own story is weak: one sure end, said as such (the panel's quieter second line)
    const f = (id) => Math.abs(sumBack(map.children?.[id]?.flow, i, 5) || 0);
    ch.outerSay = !ch.from && !ch.to ? null : (ch.to && f(ch.to) >= f(ch.from)) || !ch.from
      ? (mild ? `大陆之间：钱在流进【${nm(ch.to)}】，来处还不太明显` : `大陆之间：钱在流进【${nm(ch.to)}】，来处还不明显`)
      : (mild ? `大陆之间：钱在离开【${nm(ch.from)}】，去向还不太明显` : `大陆之间：钱在逃离【${nm(ch.from)}】，去向还不明显`);
    ch.say = `主航道在${nm(inn.parent)}里：${inn.fromName} → ${to}`;
  }
  app.channel = ch;
}
const sumBack = (arr, i, n) => {
  if (!Array.isArray(arr)) return null;
  let s = 0, k = 0;
  for (let j = Math.max(0, i - n + 1); j <= i && j < arr.length; j++) if (Number.isFinite(arr[j])) { s += arr[j]; k++; }
  return k ? s : null;
};

function seasonsFor(map, kids, i, picks = []) {
  const out = {};
  for (const c of kids) out[c.id] = app.seasonAt(map?.children?.[c.id], i)?.key || null;
  // a territory lit for a deeper spot wears that spot's season (or none while it is unknown), never its own:
  // its label IS the ①②③ card, and the card speaks for the deep spot
  for (const p of picks) if (p.deepId && p.deepId !== p.id && p.id in out) out[p.id] = p.deepSeason?.key || null;
  return out;
}
const isEst = (o) => !!(o && (o.est === true || o.now?.est === true));
function estimatesFor(node, map) {
  return (node.children || []).filter((c) => isEst(c) || isEst(map?.children?.[c.id])).map((c) => c.id);
}

/** The map caption already wears a 主航道 tag: drop the "今天的主航道：" lead-in and the 【】 marks. */
const capSay = (t) => String(t || '').replace(/^\s*(今天的)?主航道[：:]?\s*/, '').replace(/[【】]/g, '');

/** Push channel / numbers / seasons / estimates into the planet (§18). */
function applyOverlays() {
  const node = app.currentNode(), map = app.currentMap, i = app.state.dateIndex;
  if (!node || !map || !app.planetReady) { renderHero(); return; }
  // 推演 on screen: its own channel / ①②③ / seasons stay (scenario.js); never paint today's over them
  if (overlayMemo.get('scenario')) { P('setOverlay', 'liquidity', liqOverlay()); renderHero(); return; }
  const kids = node.children || [];
  const quiet = app.playing;
  const ch = app.channel;
  // the planet draws only an honest two-ended arc; a tour stop that is not about the channel keeps it off (§6)
  const tourOk = !app.touring || app.tourStage?.kind === 'channel' || app.tourStage?.kind === 'intro';
  P('setOverlay', 'channel', quiet || !tourOk || app.state.view === 'stock' || !ch || ch.hero !== 'arrow' ? null
    : { from: ch.from, to: ch.to, ...(ch.to2 && ch.to2 !== ch.to && ch.to2 !== ch.from ? { to2: ch.to2 } : {}), say: capSay(ch.say) });
  // a one-ended 主航道 (the shell's pin): the planet turns so its place faces the viewer too (§26 open item 6)
  P('setHeroAnchor', !quiet && tourOk && ch && ch.hero !== 'arrow' && ch.anchor ? ch.anchor : null);
  P('setOverlay', 'numbers', quiet ? [] : app.touring ? tourNumbers(kids) : app.currentPicks.map((p, k) => numberOf(p, k)));
  P('setOverlay', 'seasons', seasonsFor(map, kids, i, app.touring ? [] : app.currentPicks));
  P('setOverlay', 'estimates', estimatesFor(node, map));
  P('setOverlay', 'liquidity', liqOverlay());
  renderHero();
}
app.applyOverlays = applyOverlays;

/** One ①②③ card: territory name on the card's first row (the planet draws it), then ONE short tag —
 *  the full sentence lives in the panel and the hover card (§6.4). A deep spot names itself first and
 *  carries its own season / ▲▼ / 挤空 (planets that read `deep` show those instead of the territory's). */
function numberOf(p, k) {
  const deep = !!(p.deepId && p.deepId !== p.id);
  const tag = cardTag(p);
  const nm = deep ? shortName(p.deepName || D.nodeById(p.deepId)?.name || '') : '';
  const o = { id: p.id, n: k + 1, why: deep && nm ? (tag ? `${nm} · ${tag}` : nm) : tag, full: deepWhy(p) };
  if (deep) Object.assign(o, { deep: true, deepId: p.deepId, season: p.deepSeason?.key || null, dir: p.deepDir || 0, crowd: p.deepCrowd || null });
  return o;
}
const shortName = (s) => String(s || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
/** ≤ 10 characters that say what is happening: 「前几天还在撤，今天钱杀回来了：5天…」 → 「钱杀回来」. */
function cardTag(p) {
  let w = plainLine(String(p.why || ''));
  if (p.holding || p.pinned) { const k = w.indexOf('：'); if (k >= 0 && k < 24) w = plainLine(w.slice(k + 1)); }
  const head = w.split(/[：:]/)[0].replace(/[（(][^）)]*[）)]/g, '');
  const parts = head.split(/[，,；;。]/).map((s) => s.trim()).filter(Boolean);
  const clean = (s) => s.replace(/^(今天|今日|这周|这几天|最近)/, '').replace(/[了。！!…]+$/, '').trim();
  let t = clean(parts[parts.length - 1] || head).replace(/[【】]/g, '');
  if (t.length > 10) {
    const short = parts.map((x) => clean(x).replace(/[【】]/g, '')).filter((x) => x && x.length <= 10);
    t = short.length ? short[short.length - 1] : kindTag(p, w);
  }
  return t;
}
/** When the sentence has no short clause: a tag from the spot's kind and the money's direction. */
function kindTag(p, w) {
  const out = /净流出|流出|撤|跑/.test(w) && !/净流入/.test(w);
  const K = { front: out ? '风向掉头，钱在撤' : '风向掉头，钱进来', inflow: '钱在涌进来', outflow: '钱在溜走', storm: '起了风暴', crowded: '人挤人',
    quiet: '冷清没人要', spring: '刚冒芽', hot: '突然变热', cold: '突然变冷' };
  return K[p.kind] || (out ? '钱在出去' : '钱在进来');
}
/** While the tour talks, the only number on the map is the stop's own territory (§6.6). */
function tourNumbers(kids) {
  const st = app.tourStage;
  if (!st || !st.id || !st.n) return [];
  const ids = new Set(kids.map((c) => c.id));
  let id = ids.has(st.id) ? st.id : null;
  if (!id) { const p = D.pathIds(st.id); id = p ? p.find((x) => ids.has(x)) : null; }
  return id ? [{ id, n: st.n, why: '' }] : [];
}

// ===================================================================== the hero pin (§8.1)
// When the 主航道 is not an honest two-ended arc (app.channel.hero 'inner' | 'sink' | 'source'), the shell draws
// the hero itself: a ring on the anchor territory and one caption card. It follows the planet (drag, resize,
// fly) through getChildScreenRect, and steps aside for the tour, ▶ play, the stock view, a scenario and dialogs.
const hero = { on: false, key: '', raf: 0, hold: false, frame: 0 };
function heroEls() {
  if (!hero.ring) {
    hero.ring = document.getElementById('hero-ring');
    hero.cap = document.getElementById('hero-cap');
  }
  return hero.ring && hero.cap;
}
function heroWanted() {
  const ch = app.channel;
  if (!ch || ch.hero === 'arrow' || !ch.anchor || !app.planetReady || hero.hold) return null;
  if (app.playing || app.state.view === 'stock' || document.body.classList.contains('in-stock')) return null;
  if (app.touring && !(app.tourStage?.kind === 'channel' || app.tourStage?.kind === 'intro')) return null;
  if (overlayMemo.get('scenario')) return null;
  return ch;
}
function renderHero() {
  if (!heroEls()) return;
  const ch = heroWanted();
  if (!ch) { heroOff(); return; }
  const key = [ch.hero, ch.anchor, ch.say, app.state.theme].join('|');
  if (key !== hero.key) {
    hero.key = key;
    const { cap, ring } = hero;
    cap.replaceChildren();
    const go = () => { const p = D.pathIds(ch.anchor); if (p && D.nodeById(ch.anchor)?.children?.length) app.go(p); };
    const tag = document.createElement('span'); tag.className = 'hp-tag'; tag.textContent = '主航道';
    const txt = document.createElement('span'); txt.className = 'hp-say';
    // names never break mid-word: 「机器人汽车」 stays on one line
    for (const part of capSay(ch.say).split(/([：:，、→]\s*)/)) {
      if (!part) continue;
      const sp = document.createElement('span');
      if (!/^[：:，、→]/.test(part)) sp.className = 'hp-nw';
      sp.textContent = part;
      txt.append(sp);
    }
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'hp-main';
    btn.title = ch.hero === 'inner' ? `飞进「${D.nodeById(ch.anchor)?.name || ''}」看这条主航道` : `飞进「${D.nodeById(ch.anchor)?.name || ''}」看看`;
    btn.append(tag, txt);
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (!app.touring) go(); });
    cap.append(btn);
    if (app.whyButton) {
      const target = ch.hero === 'inner' ? { kind: 'channel', ids: [ch.inner.from, ch.inner.to] } : { ids: [ch.anchor] };
      const wb = app.whyButton(() => target, { cls: 'hp-why', title: '为什么？让老风上网查' });
      if (wb) cap.append(wb);
    }
    ring.className = 'hero-ring ' + ch.hero;
    ring.innerHTML = heroRingSvg(ch.hero);
  }
  if (!hero.on) {
    hero.on = true;
    hero.ring.hidden = false; hero.cap.hidden = false;
    hero.ring.classList.remove('in'); hero.cap.classList.remove('in');
    cancelAnimationFrame(hero.raf);
    hero.raf = requestAnimationFrame(heroTick);
  }
}
function heroOff() {
  if (!hero.on) return;
  hero.on = false;
  cancelAnimationFrame(hero.raf);
  hero.ring.classList.remove('in'); hero.cap.classList.remove('in');
  hero.ring.hidden = true; hero.cap.hidden = true;
}
function heroRingSvg(kind) {
  // a whirlpool ring: chevrons pointing in (money arriving) or out (money leaving); 'inner' = a double ring
  const ch = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3, c = Math.cos(a), s = Math.sin(a);
    const r0 = kind === 'source' ? 41 : 47, r1 = kind === 'source' ? 47 : 41;
    const P = (r, d) => `${(50 + c * r - s * d).toFixed(1)} ${(50 + s * r + c * d).toFixed(1)}`;
    ch.push(`M${P(r0, -3.2)}L${P(r1, 0)}L${P(r0, 3.2)}`);
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <circle class="hr-a" cx="50" cy="50" r="36"/>${kind === 'inner' ? '<circle class="hr-b" cx="50" cy="50" r="30"/>' : ''}
    <path class="hr-c" d="${ch.join('')}"/></svg>`;
}
function heroTick() {
  if (!hero.on) return;
  hero.raf = requestAnimationFrame(heroTick);
  if ((hero.frame = (hero.frame + 1) % 2)) return;          // ~30 Hz is plenty for a pin
  if (swapping || stillUp) return; // (2D ↔ 3D: the card holds its spot over the still picture until the new one shows)
  const ch = app.channel;
  const r = ch?.anchor ? P('getChildScreenRect', ch.anchor) : null;
  const { ring, cap } = hero;
  if (!r || !Number.isFinite(r.cx) || !Number.isFinite(r.cy) || r.cx < 0 || r.cy < 0 || r.cx > innerWidth || r.cy > innerHeight) {
    ring.classList.remove('in'); cap.classList.remove('in');
    return;
  }
  const R = clamp(Math.min((r.r || 60) * 0.42, r.width * 0.32, r.height * 0.32), 22, 46);
  ring.style.transform = `translate(${(r.cx - R).toFixed(1)}px, ${(r.cy - R).toFixed(1)}px)`;
  ring.style.width = ring.style.height = (2 * R).toFixed(1) + 'px';
  const cw = cap.offsetWidth || 220, chh = cap.offsetHeight || 34;
  const tb = document.getElementById('topbar').getBoundingClientRect().bottom + 8;
  const tm = document.getElementById('timebar').getBoundingClientRect().top - 8;
  const pr = app.panelOpen ? document.getElementById('panel').getBoundingClientRect().left - 8 : innerWidth - 8;
  let x = r.cx - cw / 2, y = r.cy - R - 14 - chh;
  if (y < tb) y = r.cy + R + 14;
  if (y + chh > tm) y = Math.max(tb, r.cy - chh / 2);
  x = clamp(x, 8, Math.max(8, pr - cw));
  // §26: the planet scores the card's spot off its own ①②③ cards / names / markers (and draws a hairline to it);
  // null = its cards are not final yet (a flight, the rest pose settling): the card waits instead of covering one
  const spot = P('placeCaption', ch.anchor, { w: cw, h: chh }, { ring: R });
  if (spot === null) { ring.classList.add('in'); cap.classList.remove('in'); return; }
  if (spot) { x = spot.x; y = spot.y; }
  cap.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  ring.classList.add('in'); cap.classList.add('in');
}
let heroHoldTimer = 0;
/** The pin steps aside while the camera flies (showPlanet), and comes back once the new planet has settled. */
function heroHold(on) {
  clearTimeout(heroHoldTimer);
  if (on) { hero.hold = true; heroOff(); return; }
  heroHoldTimer = setTimeout(() => { hero.hold = false; renderHero(); }, 450);
}

// ===================================================================== liquidity (§23/§24): the planet's air pressure
/** data/liquidity.json (shared by every map). Loaded in the background; the band appears when it arrives. */
async function loadLiquidity(fresh = false) {
  try { app.liquidity = await (fresh ? D.loadFresh('liquidity.json') : D.load('liquidity.json')); } catch (e) { app.liquidity = null; }
  applyOverlays();
  return app.liquidity;
}
/** 'liquidity' overlay for the root planet on the time machine's day ({pressure, state, say}); deeper planets: null. */
function liqOverlay() {
  const L = app.liquidity;
  if (!L || !app.isRoot() || app.touring || overlayMemo.get('scenario')) return null;
  const tm = L.tm || {};
  const dates = Array.isArray(tm.dates) ? tm.dates : [];
  const d = app.meta?.dates?.[app.state.dateIndex];
  let k = d ? dates.lastIndexOf(d) : -1;
  if (k < 0 && d) for (let j = dates.length - 1; j >= 0; j--) if (dates[j] <= d) { k = j; break; }
  const latest = !dates.length || k === dates.length - 1 || app.state.dateIndex === app.lastIdx;
  const pressure = latest ? (L.overlay?.pressure ?? L.pressure) : tm.pressure?.[k];
  const state = latest ? (L.overlay?.state || L.regime?.state) : tm.state?.[k];
  if (pressure == null && !state) return null;
  // one short sentence: the 4-week change of net liquidity (Fed balance sheet − TGA − RRP)
  // latest: the file's own 4-week change (FRED calendar); a past day: 20 rows back on the time machine's calendar
  const nl = Array.isArray(tm.netliq) ? tm.netliq : [];
  const unit = String(L.units?.netliq || '$B');
  const toM = unit.includes('M') ? 1 : unit.includes('T') ? 1e6 : 1000;
  const d20 = latest && Number.isFinite(L.chg?.netliq?.d20) ? L.chg.netliq.d20 * toM
    : k >= 20 && nl[k] != null && nl[k - 20] != null ? (nl[k] - nl[k - 20]) * toM : null;
  const tail = state === '放水' ? '美联储在放水' : state === '收水' ? '水在往外抽' : '没放也没收';
  const mild = app.state.voice === 'mild';
  const say = d20 != null && app.W?.money
    ? `四周${d20 >= 0 ? '多了' : '少了'} ${app.W.money(Math.abs(d20))}，${mild ? (state === '平稳' ? '基本持平' : state) : tail}`
    : (latest ? (mild ? L.regime?.sayMild : L.overlay?.say) || '' : tail);
  return { pressure: +pressure || 0, state, say };
}

/** A spotlight that lives deeper than the territory it lights (brief spotlight → its continent) says whose story
 *  it tells: "道富高收益债：前几天还在撤…" on the 债券 card, not an unnamed sentence under 债券. */
function deepWhy(p) {
  const w = p.why || '';
  if (!p.deepId || !p.deepName || !w) return w;
  const nm = String(p.deepName).replace(/[（(][^）)]*[）)]\s*$/, '');
  return w.includes(nm) ? w : `${nm}：${w}`;
}
function applySpotlight() {
  if (app.touring) return;
  P('setSpotlight', app.playing ? [] : app.currentPicks.map((p, k) => ({ id: p.id, why: numberOf(p, k).why, kind: p.kind })));
}
app.setTourSpotlight = (list) => P('setSpotlight', (list || []).slice(0, 3));   // (kept for modules; the tour uses setTourStage)
app.childRect = (id) => P('getChildScreenRect', id);

// ===================================================================== date / lens / pins / panel
let settleTimer = 0, lastPlaySettle = 0;
app.setDate = (i, { playing = false } = {}) => {
  i = clamp(Math.round(i), 0, app.lastIdx);
  const wasPlaying = app.playing;
  app.playing = playing;
  if (playing && !wasPlaying) { P('setSpotlight', []); P('setOverlay', 'numbers', []); P('setOverlay', 'channel', null); renderHero(); }
  if (i === app.state.dateIndex) return;
  app.state.dateIndex = i;
  if (app.planetReady) P('setDate', i);
  try { stockHandle?.setDate?.(i); } catch (e) { console.error(e); }
  app.emit('date', i);
  clearTimeout(settleTimer);
  if (playing) {
    const t = performance.now();
    if (t - lastPlaySettle > 450) {
      lastPlaySettle = t; computePicks();
      P('setOverlay', 'seasons', seasonsFor(app.currentMap, app.currentNode()?.children || [], i));
    }
  } else settleTimer = setTimeout(app.settleDate, 160);
};
app.settleDate = () => {
  clearTimeout(settleTimer);
  app.playing = false;
  computeAttention();
  applySpotlight();
  applyOverlays();
  app.emit('date-settled', app.state.dateIndex);
};

app.setLens = (tag) => {
  app.state.lens = tag || null;
  P('setLens', app.state.lens);
  app.emit('lens');
  if (tag) toast(`镜片：只看「${app.meta.tags?.[tag] || tag}」，其他地方变暗`, 2200);
};

app.isPinned = (id) => app.state.pins.includes(id);
app.togglePin = (id) => {
  const pins = app.state.pins.slice();
  const k = pins.indexOf(id);
  if (k >= 0) pins.splice(k, 1); else pins.push(id);
  app.state.pins = pins;
  savePins(pins);
  P('setPins', pins);
  computePicks();
  applySpotlight();
  applyOverlays();
  app.emit('pins');
  app.emit('picks');
  const n = D.nodeById(id);
  toast(k >= 0 ? `不再关注「${n?.name || id}」` : `已关注「${n?.name || id}」：它起风暴或风向突变时会被点亮`, 2400);
};

app.setPanelOpen = (open) => {
  app.panelOpen = !!open;
  document.body.classList.toggle('panel-closed', !open);
  store.set('mw.panelOpen', app.panelOpen);
  requestAnimationFrame(() => app.emit('layout'));
};

// ===================================================================== theme / voice / map (§17, §12, §19)
app.setTheme = (theme) => {
  theme = THEMES.includes(theme) ? theme : 'day';
  const changed = theme !== app.state.theme;
  app.state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'night' ? '#1d2643' : '#f6f1e6';
  store.set('mw.theme', theme);
  P('setTheme', theme);
  try { stockHandle?.setTheme?.(theme); } catch (e) { console.error(e); }
  if (changed) app.emit('theme', theme);
};
app.toggleTheme = () => app.setTheme(app.state.theme === 'night' ? 'day' : 'night');

app.setVoice = (voice) => {
  voice = VOICES.includes(voice) ? voice : 'sharp';
  const changed = voice !== app.state.voice;
  app.state.voice = voice;
  store.set('mw.voice', voice);
  try { app.W?.setVoice?.(voice); } catch (e) { console.warn('[shell] setVoice', e); }
  if (!changed) return;
  if (app.currentMap) { computeAttention(); applySpotlight(); applyOverlays(); }
  app.emit('voice', voice);
  toast(voice === 'mild' ? '语气：温和。老风收着点说。' : '语气：犀利。老风不客气了。', 2000);
};

/** §26 地图：真实 | 抽象 — redraw the current node in the other reading (the planet keeps every overlay). */
app.setGeoMode = async (mode) => {
  mode = mode === 'abstract' ? 'abstract' : 'real';
  if (mode === app.state.geoMode) return;
  app.state.geoMode = mode;
  store.set('mw.geoMode', mode);
  app.emit('geoMode', mode);
  if (app.touring) ui.tour?.stop();
  const node = app.currentNode?.();
  if (planet && node && app.currentMap) {
    try { await planet.setNode(node, app.currentMap, { direction: 'none' }); } catch (e) { console.error('[shell] geoMode', e); }
    applySpotlight();
    applyOverlays();
  }
  toast(mode === 'abstract' ? '抽象地图：每个板块一块大陆' : '真实地图：公司在总部所在的地方', 2200);
};

/** The three maps (§19, §24): 精选 (data/), 全市场 (data/fm/), 全球 (data/gl/, phase 4). */
const MAP_ROOT = { curated: 'data/', full: 'data/fm/', global: 'data/gl/' };
const mapRoot = (m) => MAP_ROOT[m] || MAP_ROOT.curated;
app.mapRoot = mapRoot;
/** Re-check which optional maps exist (cheap directory listing). Emits 'maps' when that changed. */
app.checkMaps = async () => {
  const [fm, gl] = await Promise.all([D.hasFullMarket().catch(() => false), D.hasGlobal().catch(() => false)]);
  const changed = fm !== app.fullMarket || gl !== app.globalMap;
  app.fullMarket = fm; app.globalMap = gl;
  if (changed) app.emit('maps', { full: fm, global: gl });
  return { full: fm, global: gl };
};

/** Latest call wins: every switch takes a token before its first await and gives up as soon as a newer one
 *  started (quick clicks 全球 → 精选, or four calls in a row, always end on the last one asked for). */
let mapSeq = 0;
app.setMap = async (map) => {
  map = MAP_ROOT[map] ? map : 'curated';
  if (map === (app.state.wantMap || app.state.map)) return;
  const seq = ++mapSeq;
  app.state.wantMap = map;
  const stale = () => seq !== mapSeq;
  const done = () => { if (!stale()) app.state.wantMap = null; };
  if (map === 'full' && !(await D.hasFullMarket())) { if (!stale()) { done(); toast('全市场地图还没生成（data/fm/），先用精选地图。', 3600); app.emit('map', app.state.map); } return; }
  if (map === 'global' && !(await D.hasGlobal())) { if (!stale()) { done(); toast('全球地图还在建（data/gl/ 生成后这里会自动亮起），先用精选地图。', 3600); app.emit('map', app.state.map); } return; }
  if (stale()) return;
  if (app.touring) ui.tour?.stop();
  if (app.state.view === 'stock') { closeStockView(); stockPushed = false; }
  const prev = app.state.map;
  app.state.map = map;
  D.setRoot(mapRoot(map));
  try {
    if (!(await loadAll(seq))) return;           // a newer switch took over
  } catch (e) {
    if (stale()) return;
    console.error('[shell] setMap', e);
    toast('这张地图读不出来，换回原来的');
    app.state.map = prev;
    D.setRoot(mapRoot(prev));
    if (!(await loadAll(seq))) return;
  }
  if (stale()) return;
  store.set('mw.map', app.state.map);
  app.state.dateIndex = app.lastIdx;
  const root = [D.rootId()];
  app.state.path = root;
  app.planetReady = false;
  setHash(planetHash(root), false);
  await navTo(root);
  if (stale()) return;
  done();
  P('setDate', app.state.dateIndex);
  app.emit('map', app.state.map);
  app.emit('data');
  app.emit('dataReloaded', { parts: null, map: app.state.map });
  const n = app.meta.nStocks ? `${app.meta.nStocks} 只` : '';
  toast(app.state.map === 'full' ? `全市场：${n}股票，按行业分`
    : app.state.map === 'global' ? `全球：${n}标的，亚洲 → 欧洲 → 美国，跟着太阳更新` : '精选地图：按主题分的大陆', 2600);
};

// ===================================================================== planet: 3D ⇄ 2D (§22)
// Default 3D (planet3d.js, same API as Planet). Falls back to the 2D planet when WebGL is missing, the 3D
// planet throws, the GL context dies, or it stays below 30 fps at its lowest quality. Both planets draw into
// #planet; a swap gives the new one a fresh <canvas> (a canvas keeps whichever context it got first).
const RENDERS = ['3d', '2d'];
const AVOID = ['gauges', 'dock', 'holdings', 'pins', 'since', 'hero-cap', 'hero-ring', 'mw-camctl'];   // (§26 free camera: ＋－回正)
const AUTO2D_KEY = 'mw.render.auto2d';
const AUTO2D_DAYS = 3;
let Planet2D = null, swapping = false, stillUp = false, fpsTimer = 0, slowRun = 0, glErrors = [], lostTimer = 0;
const overlayMemo = new Map();      // overlay name -> last data any module set (replayed after a swap)
const SHELL_OVERLAYS = new Set(['channel', 'numbers', 'seasons', 'estimates', 'liquidity']);

function planetOpts() {
  return {
    theme: app.state.theme,
    avoidIds: AVOID,
    onHover: (child, xy) => {
      if (app.touring || app.state.view === 'stock') return ui.hover?.hide();
      if (!child) return ui.hover?.leave ? ui.hover.leave() : ui.hover?.hide();
      ui.hover?.show(child, xy);
    },
    onClick: (child) => {
      if (app.touring || !child) return;
      ui.hover?.closeMenu();
      if (child.kind === 'stock' || isStockId(child.id)) return app.openStock(child.ticker || String(child.id).slice(2));
      if (child.children && child.children.length) return app.go(app.state.path.concat(child.id));
      toast('这里已经是最细的一层了');
    },
    onBack: () => { if (!app.touring) app.flyOut(); },
    onContextMenu: (child, xy) => { if (!app.touring && child) ui.hover?.menu(child, xy); },
    onSlow: (stats) => autoFallback('slow', stats),
    // §26 地图：真实 | 抽象 — 真实 (default): one real Earth (geo/real.js); 抽象: continents with real silhouettes
    // (the 全球 map keeps its real countries, geo/earth.js). geo/index.js falls back by itself while a provider is missing.
    geoMode: () => (app.state.geoMode === 'abstract' ? (app.state.map === 'global' ? 'earth' : 'abstract') : 'real'),
    mapKey: () => app.state.map,
  };
}

/** Planet methods keep working for every module: setOverlay is remembered so a 2D⇄3D swap can replay it. */
function adopt(inst) {
  if (typeof inst.setOverlay === 'function' && !inst.__mwWrapped) {
    const orig = inst.setOverlay.bind(inst);
    inst.setOverlay = (name, data) => {
      overlayMemo.set(name, data);
      if (quietSet.has(name)) return undefined;                // held back while the tour talks (replayed after)
      // §26 amendment 5: both planets get the same intel list and pick from it by the same rule (Planet._intelMap =
      // Planet3D._intelMap: the owner's feed, or a scout find on a ①②③ / pinned territory — at most 2, one per territory)
      const r = orig(name, name === 'clouds' ? cloudNodes(data) : data);
      // imagined weather: only the measured air pressure steps aside — scenario.js owns channel / ①②③ meanwhile
      // (both planets); when 推演 closes, the measured overlays come back in full
      if (name === 'scenario') {
        // intel bolts are today's news, not the imagined future: off while 推演 is on (both planets)
        if (data) quietLayers(true, ['intel']); else if (!app.touring) quietLayers(false, ['intel']);
        setTimeout(data ? () => P('setOverlay', 'liquidity', liqOverlay()) : applyOverlays, 0);
      }
      return r;
    };
    inst.__mwRaw = orig;
    inst.__mwWrapped = true;
  }
  planet = inst;
  app.planet = inst;
  return inst;
}

/** refine (§26 real Earth): each cloud carries its market's own nodes (polymarket.json markets[].nodes), so a planet
 *  can float it over the place the story is about (中印冲突 → India) instead of its territory's biggest piece. */
function cloudNodes(list) {
  if (!Array.isArray(list)) return list;
  let ms = null;
  try { ms = app.clouds && typeof app.clouds.markets === 'function' ? app.clouds.markets() : null; } catch (e) { ms = null; }
  const arr = ms && Array.isArray(ms.markets) ? ms.markets : null;
  if (!arr) return list;
  const byId = cloudNodes.memo && cloudNodes.memo.arr === arr ? cloudNodes.memo.map : new Map(arr.map((m) => [String(m.id), m]));
  cloudNodes.memo = { arr, map: byId };
  return list.map((c) => {
    if (!c || c.nodes || c.marketId == null) return c;
    const m = byId.get(String(c.marketId));
    const nodes = m && Array.isArray(m.nodes) ? m.nodes.map((n) => (n && typeof n === 'object' ? n.id : n)).filter(Boolean) : null;
    return nodes && nodes.length ? { ...c, nodes } : c;
  });
}

/** The tour quiets the feature layers (Polymarket clouds, intel bolts) so its caption is the only voice on the
 *  map (§6.6); their last data is kept and put back when it ends. */
const quietSet = new Set();
function quietLayers(on, names = ['clouds', 'intel']) {
  const raw = (n, d) => { try { (planet?.__mwRaw || planet?.setOverlay?.bind(planet))?.(n, d); } catch (e) { console.error('[shell] quiet', n, e); } };
  for (const n of names) {
    if (on) { if (!quietSet.has(n)) { quietSet.add(n); raw(n, null); } }
    else if (quietSet.has(n)) { quietSet.delete(n); const d = overlayMemo.has(n) ? overlayMemo.get(n) : null; raw(n, n === 'clouds' ? cloudNodes(d) : d); }
  }
}

function bindCanvas(canvas) {
  // right-click on the planet canvas when the planet does not emit onContextMenu itself
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setTimeout(() => {               // let the planet's own onContextMenu go first
      if (ui.hover?.menuOpenedWithin(80)) return;
      const hit = ui.hover?.current();
      if (hit && !app.touring) ui.hover.menu(hit, { x: e.clientX, y: e.clientY });
    }, 0);
  });
  canvas.addEventListener('webglcontextlost', () => {
    if (app.state.render !== '3d') return;
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => autoFallback('lost'), 3000);   // restored within 3 s → keep 3D
  });
  canvas.addEventListener('webglcontextrestored', () => clearTimeout(lostTimer));
}

/** A clean #planet canvas (no context yet) in place of the old one. */
function freshCanvas() {
  const old = document.getElementById('planet');
  const c = old.cloneNode(false);
  old.replaceWith(c);
  bindCanvas(c);
  return c;
}

/**
 * §26 amendment 5: switching 2D ↔ 3D is one picture. The one on screen stays as a still (not clickable) while the
 * other renderer builds under it, then fades out once the new one stands complete — not a blank globe, then the boot
 * intro, then the words fading in (≈ 2 s). Call before old.destroy(): 3D's words are DOM in its own layer, which
 * destroy() removes, so a copy stands in for them. Returns { canvas: the new #planet (under the still), fade, drop }.
 */
function stillPicture(old) {
  const c = document.getElementById('planet');
  if (!c) return null;
  stillUp = true;
  const fresh = c.cloneNode(false);
  c.before(fresh);
  bindCanvas(fresh);
  c.removeAttribute('id');
  Object.assign(c.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', display: 'block', pointerEvents: 'none' });
  const els = [c];
  if (old && old.layer && old.layer.isConnected) { const w = old.layer.cloneNode(true); old.layer.before(w); els.push(w); }
  for (const e of els) e.inert = true;
  let gone = false;
  const drop = () => { if (gone) return; gone = true; stillUp = false; clearTimeout(safety); for (const e of els) e.remove(); };
  const safety = setTimeout(drop, 10000); // (a swap that never finishes must not leave a frozen picture on top)
  return {
    canvas: fresh, drop,
    fade(ms = 360) {
      if (gone) return;
      // (two frames: the new renderer has painted under the still before it starts to go)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const e of els) { e.style.transition = `opacity ${ms}ms ease`; e.style.opacity = '0'; }
        stillUp = false;
        setTimeout(drop, ms + 40);
      }));
    },
  };
}

/** Resolves once a just-shown planet's words stand still: 3D lays its DOM cards and names out over a few frames
 *  (and fades them in), so the still over it waits until none has moved or faded for ~8 frames (≤ 1.6 s). 2D paints
 *  its words in the first frame. */
function wordsSettled(inst, maxMs = 1600) {
  const lay = inst && inst.layer;
  if (!lay || !lay.isConnected) return Promise.resolve();
  const t0 = performance.now();
  let last = '', same = 0;
  return new Promise((resolve) => {
    const tick = () => {
      let sig = '';
      for (const e of lay.querySelectorAll('.p3-lab:not(.p3-off), .p3-chan:not(.p3-off)')) {
        const r = e.getBoundingClientRect();
        sig += `${Math.round(r.left)},${Math.round(r.top)},${(+getComputedStyle(e).opacity).toFixed(1)};`;
      }
      same = sig === last ? same + 1 : 0;
      last = sig;
      const t = performance.now() - t0;
      if ((same >= 8 && t > 200) || t > maxMs || !lay.isConnected) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function makePlanet(kind, canvas) {
  if (kind === '3d') {
    const C = await loadPlanet3D();
    return new C(canvas, planetOpts());
  }
  return new Planet2D(canvas, planetOpts());
}

/** A 3D failure in plain words (no stack traces / English URLs in the owner's face). */
function why3d(e) {
  const m = String(e?.message || e || '').replace(/^Planet3D:\s*/, '');
  if (/WebGL2|webgl/i.test(m) && /[\u4e00-\u9fff]/.test(m)) return m.slice(0, 40);
  if (/import|module|fetch|Failed to load/i.test(m)) return '3D 的程序文件没读出来';
  if (/WebGL|context/i.test(m)) return '显卡画布开不了';
  return /[\u4e00-\u9fff]/.test(m) ? m.slice(0, 40) : '出了点错';
}

/** Build the boot planet: 3D unless the owner chose 2D (or 3D fell over recently). Never throws for 3D. */
async function createPlanet(canvas, want) {
  if (want === '3d') {
    try {
      const inst = await makePlanet('3d', canvas);
      app.state.render = '3d';
      return inst;
    } catch (e) {
      console.warn('[shell] 3D planet unavailable → 2D', e);
      app.renderNote = `3D 星球画不出来（${why3d(e)}），先用 2D`;
      canvas = freshCanvas();
    }
  }
  app.state.render = '2d';
  return makePlanet('2d', canvas);
}

/** Switch the planet renderer. opts.auto marks a fallback (remembered for a few days). */
async function setRender(kind, { auto = false, why = '' } = {}) {
  kind = RENDERS.includes(kind) ? kind : '3d';
  if (swapping || !planet || (kind === app.state.render && !auto)) return app.state.render;
  swapping = true;
  if (app.touring) ui.tour?.stop();
  ui.tm?.stop();
  if (!auto) {
    store.set('mw.render', kind);
    if (kind === '3d') store.set(AUTO2D_KEY, null);
  }
  const prev = app.state.render;
  const old = planet;
  ui.hover?.hide();
  // §26 amendment 5: 2D and 3D are one picture — the new renderer opens at the old one's camera (place + zoom)
  let cam = null;
  try { cam = old.getCamera ? old.getCamera() : null; } catch (e) { cam = null; }
  const still = stillPicture(old);
  try { old.destroy ? old.destroy() : old.pause?.(); } catch (e) { console.warn('[shell] planet.destroy', e); }
  let inst = null, canvas = still ? still.canvas : freshCanvas(), used = kind;
  try { inst = await makePlanet(kind, canvas); } catch (e) {
    console.warn(`[shell] ${kind} planet failed`, e);
    if (kind === '3d') { app.renderNote = `3D 星球画不出来（${why3d(e)}）`; toast(`${app.renderNote}，留在 2D`, 4200); }
    canvas = freshCanvas(); used = '2d';
    inst = await makePlanet('2d', canvas);
  }
  // (paused, a planet shows its node at once — the whole picture, words and all — instead of its boot intro; it runs
  // again below, once the node and overlays are in)
  inst.pause?.();
  adopt(inst);
  app.state.render = used;
  if (cam && cam.manual && cam.nodeId === app.state.nodeId) P('seedCamera', cam);
  P('setTheme', app.state.theme);
  updateInsets();
  P('setDate', app.state.dateIndex);
  app.planetReady = false;
  const ok = await showPlanet(app.state.path, 'none', null, { swap: true }).catch((e) => { console.error(e); return false; });
  if (!ok) await showPlanet([D.rootId()], 'none', null).catch(() => false);
  for (const [name, data] of overlayMemo) if (!SHELL_OVERLAYS.has(name)) P('setOverlay', name, data);
  applySpotlight();
  if (app.state.view === 'stock' || document.querySelector('.mw-modal-open')) P('pause'); else P('resume');
  if (still) wordsSettled(inst).then(() => still.fade());
  swapping = false;
  watchFps();
  app.emit('render', used, { from: prev, auto, why });
  app.emit('planet', app.planet);
  return used;
}
app.setRender = (kind) => setRender(kind);

function autoFallback(why, stats = null) {
  if (app.state.render !== '3d' || swapping) return;
  const fps = stats?.fps || (stats?.steadyMs ? 1000 / stats.steadyMs : null);
  store.set(AUTO2D_KEY, { at: Date.now(), why, fps: fps ? Math.round(fps) : null });
  app.renderNote = why === 'slow' ? `3D 太卡了${fps ? `（约 ${Math.round(fps)} 帧/秒）` : ''}，先换成 2D` : why === 'lost' ? '3D 画面丢了，先换成 2D' : '3D 星球出错了，先换成 2D';
  toast(app.renderNote + '。右上角「3D」可以再试。', 4600);
  setRender('2d', { auto: true, why });
}

/** < 30 fps for ~6 s while 3D is already at its lowest quality → 2D. Only while the planet is on screen. */
function watchFps() {
  clearInterval(fpsTimer);
  slowRun = 0;
  if (app.state.render !== '3d') return;
  const t0 = performance.now();
  let lastFrames = -1;
  fpsTimer = setInterval(() => {
    if (app.state.render !== '3d' || !planet || swapping) return;
    const s = P('getStats') || {};
    const frames = s.frames ?? -1;
    const moving = frames !== lastFrames;
    lastFrames = frames;
    if (document.hidden || app.state.view !== 'planet' || !moving || performance.now() - t0 < 6000) { slowRun = Math.max(0, slowRun - 1); return; }
    const ms = s.steadyMs || s.frameMs;
    if (!ms) return;
    const fps = 1000 / ms;
    const floor = s.quality == null || s.quality >= 3;      // planet3d already dropped to its lowest quality
    if (fps < 30 && floor) slowRun++; else slowRun = Math.max(0, slowRun - 2);
    if (slowRun >= 6) autoFallback('slow', { fps });
  }, 1000);
}
document.addEventListener('visibilitychange', () => { slowRun = 0; });

// runtime errors from the 3D stack (three.js / planet3d) → 2D after a few in a row
addEventListener('error', (e) => {
  if (app.state.render !== '3d') return;
  const f = String(e.filename || '') + ' ' + String(e.error?.stack || '');
  if (!/planet3d|three\.module|three-addons/.test(f)) return;
  const now = performance.now();
  glErrors = glErrors.filter((t) => now - t < 8000).concat(now);
  if (glErrors.length >= 3) autoFallback('error');
});

// ===================================================================== tour hooks
app.startTour = () => ui.tour?.start();
app.openTutorial = () => ui.tutorial?.open(0);
app.beforeTour = () => {
  ui.tm?.stop();
  if (app.state.view === 'stock') closeStockView();
  stockPushed = false;
  ui.hover?.hide();
  document.activeElement?.blur?.();
  if (app.state.dateIndex !== app.lastIdx) app.setDate(app.lastIdx);
  app.settleDate();
  app.tourStage = { kind: 'intro' };
  quietLayers(true);                        // the tour's captions are the only words on the map (§6)
  P('setSpotlight', []);
  applyOverlays();
};
/** tour.js: what the tour is showing now — {kind:'intro'|'channel'|<stop kind>, id, n} — so only that stop's
 *  territory carries a number (and pulses), the camera turns it to the viewer, and the 主航道 shows only when
 *  the stop is about it. */
app.setTourStage = (st) => {
  app.tourStage = st || null;
  if (!app.touring) return;
  P('setSpotlight', st?.id ? [{ id: tourNumbers(app.currentNode()?.children || [])[0]?.id || st.id, why: '', kind: st.kind || null }] : []);
  applyOverlays();
  if (st?.id) {
    const kid = tourNumbers(app.currentNode()?.children || [])[0]?.id;
    if (kid) P('faceChild', kid);
  }
};
app.afterTour = () => {
  app.tourStage = null;
  quietLayers(false);
  setHash(planetHash(app.state.path), false);
  computeAttention();
  applySpotlight();
  applyOverlays();
  app.emit('picks');
};

// ===================================================================== refresh (POST /api/refresh + poll /api/status)
let refreshing = false;
app.refresh = async ({ quick = false } = {}) => {
  if (refreshing) { toast('正在更新，请稍等…'); return; }
  const r = await D.refreshData({ quick });
  if (r.error) {
    toast(r.error === 'no-server' ? '一键刷新要用 server.py 打开本页（python3 server.py），现在是静态模式。' : `刷新没能启动：${r.error}`, 4200);
    return;
  }
  if (r.started === false && !r.running) { toast(r.reason || '刷新没能启动', 3600); return; }
  refreshing = true;
  app.topbar.setRefresh('busy', '正在抓取最新数据…');
  toast(quick ? '正在刷新到最新收盘，大约一分钟。' : '开始抓取最新数据，通常要几分钟。你可以继续看。', 3600);
  setTimeout(pollStatus, 1500);
};
async function pollStatus() {
  const s = await D.getStatus();
  if (s.error) { refreshing = false; app.topbar.setRefresh('idle'); toast('看不到更新进度了（服务器没回应）'); return; }
  if (s.running) {
    const line = String(s.log || '').trim().split('\n').filter(Boolean).pop() || '正在抓取…';
    app.topbar.setRefresh('busy', line);
    setTimeout(pollStatus, 2500);
    return;
  }
  refreshing = false;
  app.topbar.setRefresh('idle');
  const before = app.meta.asOf;
  try { await reloadAll(); } catch (e) { console.error(e); toast('更新完了，但读新数据时出错'); return; }
  toast(app.meta.asOf !== before ? `数据已更新到 ${cnDate(app.meta.asOf, true)}` : '已经是最新数据了', 3600);
}

/** Re-read every map file (after a refresh) and redraw where we are. */
async function reloadAll() {
  const wasLatest = app.state.dateIndex === app.lastIdx;
  const oldDate = app.meta?.dates?.[app.state.dateIndex];
  D.clearCache();
  deepCache.clear();
  if (!(await loadAll())) return;                 // a map switch took over
  // a past day stays the same calendar day (a new day shifts every index by one)
  const k = oldDate ? app.meta.dates.indexOf(oldDate) : -1;
  app.state.dateIndex = wasLatest ? app.lastIdx : k >= 0 ? k : clamp(app.state.dateIndex, 0, app.lastIdx);
  fresh.pending = null;
  const path = sanitizePath(app.state.path);
  app.state.path = path;
  const node = app.currentNode();
  const map = await D.loadMap(node.id);
  app.currentMap = map;
  try { await planet.setNode(node, map, { direction: 'none' }); } catch (e) { console.error(e); }
  P('setDate', app.state.dateIndex);
  computeAttention();
  applySpotlight();
  applyOverlays();
  app.emit('data');
  app.emit('dataReloaded', { parts: null });
}

// ===================================================================== new data while the page stays open
// The loop rewrites data/ every 15 min in market hours. A page left open notices (meta.generatedAt), and reloads
// everything at once when the owner is idle on today's planet — never half old dates with half new series.
// Otherwise a 「有新数据 · 更新」 chip waits in the top bar.
const fresh = { at: 0, busy: false, pending: null };
async function checkFresh(force = false) {
  if (fresh.busy || document.hidden || !app.meta || !app.booted || refreshing) return;
  if (!force && Date.now() - fresh.at < 20_000) return;
  fresh.at = Date.now();
  fresh.busy = true;
  try {
    const base = D.dataBase();
    const r = await fetch(base + 'meta.json', { cache: 'no-store' });
    if (!r.ok || base !== D.dataBase()) return;
    const m = await r.json();
    const g = m?.generatedAt, cur = app.meta?.generatedAt;
    if (!g || !cur || g <= cur) return;
    if (idleForReload()) await applyFresh();
    else if (fresh.pending !== g) { fresh.pending = g; app.emit('fresh', g); }
  } catch (e) { /* offline / mid-write: next round */ } finally { fresh.busy = false; }
}
function idleForReload() {
  return !app.touring && !refreshing && !swapping && app.planetReady && app.state.view === 'planet' && !app.playing
    && app.state.dateIndex === app.lastIdx && !document.querySelector('.mw-modal-open') && !ui.tutorial?.isOpen?.()
    && !overlayMemo.get('scenario') && !ui.hover?.current?.();
}
async function applyFresh() {
  const was = app.meta?.generatedAt;
  try { await reloadAll(); } catch (e) { console.error('[shell] fresh data', e); return; }
  fresh.pending = null;
  app.emit('fresh', null);
  if (app.meta?.generatedAt !== was) {
    const live = app.partialInfo?.();
    toast(`数据更新到 ${cnDate(app.meta.asOf)}${live?.hm ? ` 盘中 · 截至 ${live.hm} 美东` : ' 收盘'}`, 2600);
  }
}
app.freshPending = () => fresh.pending;
app.applyFresh = applyFresh;
setInterval(() => { if (fresh.pending && idleForReload()) applyFresh(); else checkFresh(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFresh(true); });
app.on('nav-done', () => checkFresh());

/** §19: re-fetch JSON without a page reload. parts: e.g. ['intel'] or ['intel.json','polymarket.json'];
 *  omitted / containing a map file (meta, tree, brief, search, maps) → everything is re-read. */
const CORE = /^(meta|tree|brief|search|maps|stocks|all)\b/;
app.reloadData = async (parts) => {
  const list = parts == null ? null : [].concat(parts).map(String);
  if (!list || list.some((p) => CORE.test(p))) {
    if (list && list.length === 1 && /^brief/.test(list[0])) {
      D.invalidate('brief.json');
      const b = await D.loadBrief().catch(() => null);
      app.brief = b && (!b.asOf || b.asOf === app.meta.asOf) ? b : null;
      useSeasonStats();
      computeAttention(); applySpotlight(); applyOverlays();
      app.emit('data');
      app.emit('dataReloaded', { parts: list });
      return;
    }
    await reloadAll();
    return;
  }
  D.invalidate(list.map((p) => (/\.json$|\//.test(p) ? p : p + '.json')));
  if (list.some((p) => /^liquidity/.test(p))) await loadLiquidity(true);
  app.emit('dataReloaded', { parts: list });
};

// ===================================================================== keyboard
addEventListener('keydown', (e) => {
  if (ui.tutorial?.isOpen()) { ui.tutorial.onKey(e); return; }   // the tutorial owns the keyboard while open
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (t?.dataset?.mwCam && e.key.startsWith('Arrow') && !app.touring) return;   // §26 free camera: arrows turn the focused map
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && (ui.why?.close() || ui.hover?.closeMenu() || app.topbar?.closePopovers())) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (document.querySelector('.mw-modal-open')) return;          // a feature module's own dialog is up
  if (app.touring) {
    if (e.key === 'Escape') { e.preventDefault(); ui.tour.stop(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ui.tour.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); ui.tour.prev(); }
    else if (e.key === ' ') e.preventDefault();
    return;
  }
  const i = app.state.dateIndex;
  switch (e.key) {
    case 'Escape':
      if (performance.now() - lastStockClose < 120) return;   // the stock view already closed itself on this key
      e.preventDefault();
      app.flyOut(); break;
    case 'Backspace':
      e.preventDefault(); app.flyOut(); break;
    case ' ':
      if (t && t.tagName === 'BUTTON') return;                 // let Space press a focused button
      e.preventDefault(); ui.tm.toggle(); break;
    case 'ArrowLeft':
      e.preventDefault(); ui.tm.stop(); app.setDate(i - (e.shiftKey ? 5 : 1)); break;
    case 'ArrowRight':
      e.preventDefault(); ui.tm.stop(); app.setDate(i + (e.shiftKey ? 5 : 1)); break;
    case 'Home':
      e.preventDefault(); ui.tm.stop(); app.setDate(0); break;
    case 'End':
      e.preventDefault(); ui.tm.stop(); app.setDate(app.lastIdx); break;
    case '/':
      e.preventDefault(); app.topbar.focusSearch(); break;
    case '?':
      e.preventDefault(); app.openTutorial(); break;
    case 'w': case 'W':
      if (app.state.view === 'planet' && ui.hover?.why()) e.preventDefault();
      break;
    default:
  }
}, true);

// ===================================================================== 为什么 on the 3D planet's own captions (§21)
// planet3d draws the 主航道 caption and the ①②③ cards as DOM labels; style.css makes them clickable.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t?.closest || app.touring || !app.why) return;
  const chan = t.closest('.p3-layer .p3-chan .p3-cin');
  const spot = chan ? null : t.closest('.p3-layer .p3-lab.p3-spot .p3-in');
  if (!chan && !spot) return;
  e.preventDefault(); e.stopPropagation();
  if (chan) {
    const ch = app.channel;
    if (ch?.from && ch?.to) app.why({ kind: 'channel', ids: [ch.from, ch.to] }, chan);
    return;
  }
  const n = parseInt(spot.querySelector('.p3-num')?.textContent || '', 10);
  const p = app.currentPicks?.[n - 1];
  if (p) app.why({ ids: [p.deepId && p.deepId !== p.id ? p.deepId : p.id] }, spot);
}, true);

// ===================================================================== feature modules (§19)
const FEATURES = [
  ['scenario', './scenario.js', 'scenario.css'],
  ['web', './web.js', 'web.css'],
  ['clouds', './ui/clouds.js', null],
  ['intel', './ui/intel.js', null],
  ['scout', './ui/scout.js', null],
  ['heartbeat', './ui/heartbeat.js', null],
  ['guess', './ui/guess.js', null],
  ['realmoney', './ui/realmoney.js', null],
];
const EXTRA_CSS = ['ops.css'];
const mounted = new Map();   // id -> module namespace (or null when absent)
let listings = null;

async function moduleListings() {
  if (!listings) listings = Promise.all([D.listDir('js/'), D.listDir('js/ui/'), D.listDir('css/')]);
  return listings;
}
async function exists(rel) {
  const [js, jsui, css] = await moduleListings();
  if (rel.startsWith('./ui/')) return jsui ? jsui.has(rel.slice(5)) : null;
  if (rel.startsWith('./')) return js ? js.has(rel.slice(2)) : null;
  if (rel.startsWith('css/')) return css ? css.has(rel.slice(4)) : null;
  return null;
}
function addCss(href) {
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.getAttribute('href') === href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = href;
  document.head.append(link);
}

async function mountOne(id, rel, { quiet = false } = {}) {
  if (mounted.has(id)) return mounted.get(id);
  const ok = await exists(rel);
  if (ok === false) { if (!quiet) mounted.set(id, null); return null; }
  let mod = null;
  try { mod = await import(rel); } catch (e) {
    if (ok === true) console.error(`[shell] ${rel} failed to load`, e);   // present but broken: say so
    mounted.set(id, null);
    return null;
  }
  mounted.set(id, mod);
  if (typeof mod.openWeb === 'function' && !providers.openWeb) providers.openWeb = mod.openWeb;
  if (typeof mod.ask === 'function' && !providers.ask) providers.ask = mod.ask;
  if (typeof mod.init === 'function') {
    try { await mod.init(app); } catch (e) { console.error(`[shell] ${rel} init(app) failed`, e); }
  }
  return mod;
}

async function mountFeatures() {
  for (const [, , css] of FEATURES) if (css && (await exists('css/' + css))) addCss('css/' + css);
  for (const css of EXTRA_CSS) if (await exists('css/' + css)) addCss('css/' + css);
  await Promise.allSettled(FEATURES.map(([id, rel]) => mountOne(id, rel)));
  app.features = Object.fromEntries([...mounted].map(([k, v]) => [k, !!v]));
  app.panel.render(true);
  app.emit('features', app.features);
}

// ===================================================================== boot
/** Read meta / tree / brief / search for the current map root. With a map-switch token: returns false (and
 *  changes nothing) when a newer switch started meanwhile. */
async function loadAll(seq = mapSeq) {
  const base = D.dataBase();
  const [meta, tree, brief, search] = await Promise.all([
    D.loadMeta(), D.loadTree(),
    D.loadBrief().catch(() => null),
    D.loadSearch().catch(() => []),
  ]);
  if (seq !== mapSeq || base !== D.dataBase() || D.rootNodeOf() !== tree) return false;
  app.meta = meta;
  // the newest market day any map knows (全市场 refreshes nightly; it never says 今日 for an older day)
  app.latestAsOf = meta.asOf;
  try { const cm = await D.loadSharedMeta(); if (cm?.asOf && cm.asOf > (app.latestAsOf || '')) app.latestAsOf = cm.asOf; } catch (e) { /* only the curated map */ }
  if (seq !== mapSeq || base !== D.dataBase()) return false;
  app.tree = tree;
  // a brief written for another day would tell today's story wrong: ignore it
  app.brief = brief && (!brief.asOf || !meta.asOf || brief.asOf === meta.asOf) ? brief : null;
  if (brief && !app.brief) console.info('[shell] brief.json is for', brief.asOf, '— data is', meta.asOf);
  useSeasonStats();
  app.lastIdx = Math.max(0, (meta.dates || []).length - 1);
  app.searchIndex = prepareIndex(search, D.nodeById);
  if (app.planetReady || app.booted) mergeFmSearch();
  return true;
}

/** §20: on the 精选 map the search also covers every 全市场 ticker (labelled 全市场), and on every map the
 *  other maps' stocks (全球 listings such as 贵州茅台 on 精选/全市场; US tickers such as DNA on 全球), loaded in the
 *  background. A picked stock opens its own stock page without switching maps. */
async function mergeFmSearch() {
  const map = app.state.map;
  const have = new Set((app.searchIndex || []).map((e) => e.id));
  const add = (list, scope, label) => {
    if (app.state.map !== map || !Array.isArray(list)) return;
    const extra = list.filter((e) => e && e.ticker && !have.has(e.id)).map((e) => ({ ...e, path: (e.path || []).slice(1), pathIds: null }));
    for (const e of extra) have.add(e.id);
    app.searchIndex = app.searchIndex.concat(prepareIndex(extra, () => null, { scope, scopeLabel: label }));
  };
  if (map === 'global') {
    try { add(await D.loadSharedSearch('search.json'), 'curated', '美股'); } catch (e) { /* optional */ }
    if (app.fullMarket || (await D.hasFullMarket().catch(() => false))) { try { add(await D.loadFmSearch(), 'fm', '全市场'); } catch (e) { /* optional */ } }
    return;
  }
  if (map === 'curated' && (app.fullMarket || (await D.hasFullMarket().catch(() => false)))) {
    try { add(await D.loadFmSearch(), 'fm', '全市场'); } catch (e) { /* optional */ }
  }
  if (app.globalMap || (await D.hasGlobal().catch(() => false))) {
    try { add(await D.loadSharedSearch('gl/search.json'), 'gl', '全球'); } catch (e) { /* optional */ }
  }
}

/** §20 我的持仓: data/holdings.json (copied from universe/holdings.json by update.sh). Each holding is
 *  auto-pinned once (un-pinning it later is respected) and shown as 持仓 in the radar strip. */
async function loadHoldings() {
  let j = null;
  try { j = await D.load('holdings.json'); } catch (e) { j = null; }
  const list = (j && Array.isArray(j.holdings) ? j.holdings : []).map((x) => {
    const t = String(x.t || x.ticker || '').toUpperCase();
    return t ? { t, id: 's:' + t, name: x.name || t, note: x.note || '' } : null;
  }).filter((x) => x && D.nodeById(x.id));
  app.holdings = list;
  const done = store.get('mw.holdingsPinned', []);
  const seen = Array.isArray(done) ? done.slice() : [];
  let changed = false;
  for (const hd of list) {
    if (seen.includes(hd.id)) continue;
    seen.push(hd.id);
    if (!app.state.pins.includes(hd.id)) { app.state.pins = app.state.pins.concat(hd.id); changed = true; }
  }
  store.set('mw.holdingsPinned', seen);
  if (changed) savePins(app.state.pins);
}
app.isHolding = (id) => (app.holdings || []).some((x) => x.id === id);
// data.js asks the merged search which folder a ticker off this map lives in (no 404 probing)
D.setScopeHint((t) => {
  const id = 's:' + String(t).toUpperCase();
  const e = (app.searchIndex || []).find((x) => x.id === id || x.ticker === t);
  return e ? e.scope || (app.state.map === 'global' ? 'gl' : app.state.map === 'full' ? 'fm' : 'curated') : null;
});

/** §20: a front / storm / |wind| ≥ 1.5 on a holding (today) always takes one of the ①②③ slots. */
function holdingPicks(node, kidIds, i) {
  const out = [];
  if (i !== app.lastIdx) return out;              // tree `now` is the latest day only
  for (const hd of app.holdings || []) {
    const n = D.nodeById(hd.id);
    const now = n?.now;
    if (!now) continue;
    const loud = now.front || (now.storm >= 0.8) || Math.abs(now.wind || 0) >= 1.5;
    if (!loud) continue;
    const p = D.pathIds(hd.id) || [];
    const at = p.indexOf(node.id);
    const kid = at >= 0 ? p[at + 1] : null;
    if (!kid || !kidIds.has(kid)) continue;
    const what = now.front ? app.W.frontWord(now.front).text : now.storm >= 0.8 ? app.W.stormWord(now.storm).text : app.W.windWord(now.wind).text;
    out.push({ id: kid, why: `你的持仓${hd.name}：${what}`, score: 99, holding: true, deepId: kid !== hd.id ? hd.id : null, deepName: hd.name });
  }
  return out;
}

function showFatal(msg, detail) {
  const el = document.getElementById('loading');
  el.classList.add('error');
  el.hidden = false;
  el.replaceChildren();
  const box = document.createElement('div');
  box.className = 'loading-box';
  box.append(icon('cloud', { size: 40, cls: 'loading-icon' }));
  const p = document.createElement('p'); p.className = 'loading-title'; p.textContent = msg;
  const s = document.createElement('p'); s.className = 'loading-sub'; s.textContent = detail || '';
  box.append(p, s);
  el.append(box);
}

async function boot() {
  // preferences first, so the very first frame is in the right theme
  app.state.theme = THEMES.includes(store.get('mw.theme')) ? store.get('mw.theme') : 'day';
  app.state.voice = VOICES.includes(store.get('mw.voice')) ? store.get('mw.voice') : 'sharp';
  app.state.geoMode = store.get('mw.geoMode') === 'abstract' ? 'abstract' : 'real';     // §26 default 真实
  document.documentElement.dataset.theme = app.state.theme;
  if (store.get('mw.render') !== '2d') loadPlanet3D().catch(() => null);   // warm three.js while the data loads
  const wantMap = store.get('mw.map');
  const fullP = D.hasFullMarket().catch(() => false);
  const globalP = D.hasGlobal().catch(() => false);
  if (wantMap === 'full' && (await fullP)) { app.state.map = 'full'; D.setRoot(mapRoot('full')); }
  else if (wantMap === 'global' && (await globalP)) { app.state.map = 'global'; D.setRoot(mapRoot('global')); }

  let mods;
  try {
    [mods] = await Promise.all([loadModules(), loadAll()]);
  } catch (e) {
    console.error('[shell] boot', e);
    if (app.state.map !== 'curated') { store.set('mw.map', 'curated'); location.reload(); return; }
    showFatal('还没有天气数据', '先在项目目录运行 ./update.sh 生成数据，再用 python3 server.py 打开本页。');
    return;
  }
  app.W = app.words = mods.W;
  try { app.W.setVoice?.(app.state.voice); } catch (e) { /* words may not support voices yet */ }
  useSeasonStats();   // loadAll() ran before app.W existed: the brief's own season odds never reached words.js on boot
  openStockView = mods.openStockView;
  app.stubbed = mods.stubbed;
  app.fullMarket = await fullP;
  app.globalMap = await globalP;
  setInterval(() => app.checkMaps().catch(() => {}), 5 * 60_000);    // 全球 lights up by itself once data/gl/ exists

  app.state.dateIndex = app.lastIdx;
  app.state.pins = loadPins();
  await loadHoldings();
  app.panelOpen = store.get('mw.panelOpen', true) !== false;
  document.body.classList.toggle('panel-closed', !app.panelOpen);

  // the planet: 3D by default (§22), 2D when the owner chose it or 3D fell over in the last few days
  Planet2D = mods.Planet;
  const chosen = store.get('mw.render') === '2d' ? '2d' : '3d';
  const auto2d = store.get(AUTO2D_KEY);
  const recentAuto = chosen === '3d' && auto2d && Date.now() - (auto2d.at || 0) < AUTO2D_DAYS * 864e5;
  if (recentAuto) app.renderNote = auto2d.why === 'slow' ? `3D 上次太卡${auto2d.fps ? `（约 ${auto2d.fps} 帧/秒）` : ''}，先用 2D` : '3D 上次出错了，先用 2D';
  const canvas = document.getElementById('planet');
  bindCanvas(canvas);
  try {
    adopt(await createPlanet(canvas, recentAuto ? '2d' : chosen));
  } catch (e) {
    console.error('[shell] Planet', e);
    showFatal('地图画不出来', String(e && e.message || e));
    return;
  }
  P('setTheme', app.state.theme);

  ui.why = initWhy(app);                 // first: every other piece may draw a 为什么？ button
  app.topbar = initTopbar(app);
  ui.gauges = initGauges(app);
  app.panel = initPanel(app);
  ui.hover = initHoverCard(app);
  ui.tm = initTimeMachine(app);
  ui.tutorial = initTutorial(app);
  ui.tour = initTour(app);
  ui.pins = initPins(app);
  ui.holdings = initHoldings(app);
  app.timemachine = ui.tm;
  app.hover = ui.hover;

  let rz = 0;
  addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { P('resize'); updateInsets(); }); });
  app.on('layout', updateInsets);
  updateInsets();
  P('setDate', app.state.dateIndex);

  if (!location.hash || location.hash === '#' || location.hash === '#/') setHash(planetHash([D.rootId()]), false);
  // a bad URL can never block boot: anything that throws here lands on the world
  try {
    const first = parseHash();
    if (first.type === 'stock') { await navTo(D.pathIds('s:' + first.ticker)?.slice(0, -1) || [D.rootId()]); }
    await applyRoute(first);
  } catch (e) {
    console.warn('[shell] boot route', e);
    setHash(planetHash([D.rootId()]), false);
  }
  if (!app.planetReady) await navTo([D.rootId()]);

  watchFps();
  if (app.renderNote && !recentAuto) setTimeout(() => toast(app.renderNote, 4200), 1200);
  const loading = document.getElementById('loading');
  loading.classList.add('done');
  setTimeout(() => { loading.hidden = true; }, 600);
  document.body.classList.add('ready');

  if (ui.tutorial.firstVisit()) setTimeout(() => { if (!app.touring) ui.tutorial.open(0); }, 900);
  initSince(app, { onChange: updateInsets }).catch((e) => console.warn('[shell] since', e));
  app.booted = true;
  loadLiquidity().catch(() => {});
  setTimeout(() => mergeFmSearch().catch(() => {}), 2500);
  mountFeatures().catch((e) => console.error('[shell] features', e));
}

/** Keep the planet clear of the overlaid UI (top bar / since line, side panel, time machine). */
function updateInsets() {
  const tb = document.getElementById('topbar').getBoundingClientRect();
  const since = document.getElementById('since');
  let top = tb.bottom + 6;
  if (!since.hidden && since.classList.contains('on')) top = Math.max(top, since.getBoundingClientRect().bottom + 8);
  const tm = document.getElementById('timebar').getBoundingClientRect();
  const bottom = Math.max(0, innerHeight - tm.top + 8);
  const panel = document.getElementById('panel');
  const pr = panel.getBoundingClientRect();
  const right = app.panelOpen && pr.width ? Math.max(0, innerWidth - pr.left) + 6 : 0;
  P('setInsets', { top, right, bottom, left: 0 });
}

boot();
