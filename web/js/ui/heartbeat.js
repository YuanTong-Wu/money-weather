// heartbeat.js — 💓 the loop's heartbeat in the top bar (DESIGN.md §16) + the small kit shared by the
// ops feature modules (intel.js, scout.js, guess.js): DOM helper, icon set, API helper, the one
// drop-down sheet, time formatting, theme sync, and adapters for the §19 app object.
//
// Badge: green = data fresh & loop fine, amber = stale / small problems, red = broken,
// grey = the loop is not running (no heartbeat file). Click → sheet: status, next cycle, Claude calls
// today vs caps, last cycle's steps, what Claude was sent to do, open issues.
// Reads GET /api/heartbeat when the server has it, else data/heartbeat.json; polls every 60 s.

// ===================================================================== kit: DOM
const SVGNS = 'http://www.w3.org/2000/svg';

/** h('div.a.b#id', {onclick, title, style:{…}, dataset:{…}, html}, child, 'text', [more]) */
export function h(sel, attrs, ...kids) {
  const m = String(sel).match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const clear = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); return el; };

/** "钱从【债券】流向【美股】" → text with highlighted spans */
export function rich(str) {
  const frag = document.createDocumentFragment();
  String(str || '').split(/(【[^】]*】)/).forEach((p) => {
    if (!p) return;
    if (p.startsWith('【') && p.endsWith('】')) frag.append(h('b.ops-hl', p.slice(1, -1)));
    else frag.append(document.createTextNode(p));
  });
  return frag;
}

// ===================================================================== kit: icons
// One consistent line-icon set (24-unit grid, 1.6 stroke, round joins) — §17 "hand-drawn-but-precise".
const ICONS = {
  inbox: '<path d="M4 13.5 6.3 6.9A1.4 1.4 0 0 1 7.6 6H9M15 6h1.4a1.4 1.4 0 0 1 1.3.9L20 13.5"/><path d="M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5h-4.3l-1.4 2.2H9.7l-1.4-2.2H4Z"/><path d="M12 3.5v8M9 8.8l3 3 3-3"/>',
  scout: '<circle cx="7" cy="15.6" r="3.4"/><circle cx="17" cy="15.6" r="3.4"/><path d="M10.4 15.4h3.2M4.1 13.6 6 7.2A1.6 1.6 0 0 1 7.5 6H9l1 3.8M19.9 13.6 18 7.2A1.6 1.6 0 0 0 16.5 6H15l-1 3.8"/>',
  pulse: '<path d="M2.8 12.4h4l2.1-4.6 3.4 9.4 2.5-6.4 1.6 1.6h4.8"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><path d="m12 12 6.6-6.6M16 4.6l2.6.8.8 2.6"/>',
  sprout: '<path d="M12 20.5V12.8"/><path d="M12 13.2C12 9.6 9.6 7.2 5.6 7.2c0 3.7 2.5 6 6.4 6Z"/><path d="M12 11.2c0-3.1 2-5.3 5.6-5.3 0 3.2-2.1 5.3-5.6 5.3Z"/><path d="M8.2 20.5h7.6"/>',
  sun: '<circle cx="12" cy="12" r="3.9"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>',
  leaf: '<path d="m12 3.2 1.5 3.3 3-1.1-.7 3.4 3.4.7-2.6 2.5 1.5 1.3-3.9.9.3 2.6-2.5-1.2-2.5 1.2.3-2.6-3.9-.9 1.5-1.3-2.6-2.5 3.4-.7-.7-3.4 3 1.1Z"/><path d="M12 15.2v5.6"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.8 4.8 2.2 1.8 2.2-1.8M9.8 19.2l2.2-1.8 2.2 1.8M4.6 10.6l2.7-.5-1-2.6M19.4 13.4l-2.7.5 1 2.6M6.3 16.5l1-2.6-2.7-.5M17.7 7.5l-1 2.6 2.7.5"/>',
  calm: '<path d="M4 9.5h11.5a2.5 2.5 0 1 0-2.5-2.5M4 13h15a2.5 2.5 0 1 1-2.5 2.5M4 16.5h7"/>',
  check: '<path d="m5 12.6 4.4 4.4L19 7.4"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 12.2h8.4L17 7M10.3 10.5v5.5M13.7 10.5v5.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  up: '<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>',
  down: '<path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5"/>',
  bolt: '<path d="M13.2 3 6 13.2h5.2L10.4 21l7.2-10.2h-5.2Z"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3 2"/>',
  shuffle: '<path d="M4 7h3.2c2.4 0 3.6 1.2 4.8 5s2.4 5 4.8 5H20M4 17h3.2c1.3 0 2.2-.4 3-1.2M13.8 8.2c.8-.8 1.7-1.2 3-1.2H20"/><path d="m17.6 4.6 2.4 2.4-2.4 2.4M17.6 14.6l2.4 2.4-2.4 2.4"/>',
  send: '<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4Z"/>',
  ext: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 13.8V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5A1.5 1.5 0 0 1 6 6h4.2"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.6"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  replay: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.8h3.8"/><path d="M12 8.6V12l2.4 1.6"/>',
  flag: '<path d="M6 21V4M6 4.5h10.5l-2 3.5 2 3.5H6"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ops-i' + (cls ? ' ' + cls : ''));
  s.innerHTML = ICONS[name] || ICONS.dot;
  return s;
}

// ===================================================================== kit: seasons (§8.2)
export const SEASONS = {
  spring: { key: 'spring', icon: 'sprout', name: '春', now: '钱刚开始进来，还不挤', next: '可能进入夏天' },
  summer: { key: 'summer', icon: 'sun', name: '夏', now: '正热、人多', next: '小心入秋' },
  autumn: { key: 'autumn', icon: 'leaf', name: '秋', now: '钱从拥挤处撤离', next: '可能入冬' },
  winter: { key: 'winter', icon: 'snow', name: '冬', now: '冷清没人管', next: '等春天' },
  none: { key: 'none', icon: 'calm', name: '平稳', now: '没什么季节感', next: '平稳' },
};
const SEASON_ZH = { '春': 'spring', '夏': 'summer', '秋': 'autumn', '冬': 'winter' };
/** Season of (wind, 5-day wind change, crowding) — words.season if present, else the §8.2 table. */
export function seasonOf(W, w, dw, p) {
  if (W && typeof W.season === 'function') {
    try {
      const s = W.season(w, dw, p);
      const k = s && (SEASONS[s.key] ? s.key : SEASON_ZH[s.name] || (typeof s === 'string' ? (SEASONS[s] ? s : SEASON_ZH[s]) : null));
      if (k) return { ...SEASONS[k], ...(typeof s === 'object' ? { now: s.now || SEASONS[k].now, next: s.next || SEASONS[k].next } : {}) };
      if (s && (s.key === null || s.key === 'none')) return SEASONS.none;
    } catch (e) { /* fall through */ }
  }
  const ok = (x) => typeof x === 'number' && isFinite(x);
  if (!ok(w) || !ok(p)) return SEASONS.none;
  dw = ok(dw) ? dw : 0;
  if (w > 0.3 && dw > 0.3 && p < 65) return SEASONS.spring;
  if (w > 0.3 && p >= 65) return SEASONS.summer;
  if ((w < -0.3 && p >= 50) || (dw < -0.6 && p >= 65)) return SEASONS.autumn;
  if ((w < -0.3 && p < 50) || (Math.abs(w) <= 0.3 && p < 35)) return SEASONS.winter;
  return SEASONS.none;
}

// ===================================================================== kit: time
const pad2 = (n) => String(n).padStart(2, '0');
export function cnDate(iso, withYear = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${withYear ? m[1] + '年' : ''}${+m[2]}月${+m[3]}日` : '';
}
const toDate = (iso) => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : d; };
/** local wall clock: "23:22", or "10月25日 23:22" when not today */
export function clock(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const now = new Date();
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? t : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}
export function ago(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 50) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
export const localISODate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a || ''), pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b || '');
  if (!pa || !pb) return null;
  return Math.round((Date.UTC(+pb[1], pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], pa[2] - 1, +pa[3])) / 86400000);
}
export const secs = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)} 秒` : `${Math.floor(s / 60)} 分 ${pad2(Math.round(s % 60))} 秒`);

// ===================================================================== kit: storage
export const store = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

// ===================================================================== kit: server API
/** fetch JSON from /api. Never throws. Missing route / static server → {error, missing:true};
 *  no server at all → {error, offline:true}. */
export async function api(path, { method = 'GET', body = null, timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(path, {
      method, cache: 'no-store', signal: ctl.signal,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (r.status === 404 && (!j || j.error === 'not found')) return { error: '服务器还没有这个功能', missing: true, status: 404 };
    if (r.status === 501 || (r.status === 405 && !j)) return { error: '现在是静态模式', missing: true, status: r.status };
    if (!j || typeof j !== 'object') return { error: `服务器返回 ${r.status}`, status: r.status };
    if (!r.ok && !j.error) j.error = `服务器返回 ${r.status}`;
    return j;
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? '服务器太久没回应' : '连不上服务器', offline: true };
  } finally { clearTimeout(timer); }
}

/** A generated file under data/ (curated map root, even when the full-market map is on). null if missing.
 *  Peeks at the folder listing first (when the server gives one) so a file that does not exist yet costs
 *  no 404 in the console. */
export async function dataFile(app, name) {
  const D = A(app).data;
  let root = 'data/';
  try { root = (D && (typeof D.dataBase === 'function' ? D.dataBase() : D.root)) || 'data/'; } catch (e) { /* default */ }
  root = String(root).replace(/fm\/?$/, '').replace(/\/?$/, '/');
  if (D && typeof D.listDir === 'function') {
    try {
      if (typeof D.forgetDir === 'function') D.forgetDir(root);
      const names = await D.listDir(root);
      if (names && !names.has(name)) return null;
    } catch (e) { /* just fetch */ }
  }
  try {
    const r = await fetch(root + name, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/** Run `fn` every `ms` while the page is visible (plus once now). Returns stop(). */
export function every(ms, fn, { now = true } = {}) {
  let t = 0, stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (document.visibilityState !== 'hidden') { try { await fn(); } catch (e) { console.warn('[ops]', e); } }
    if (!stopped) t = setTimeout(tick, ms);
  };
  const onVis = () => { if (document.visibilityState === 'visible') { clearTimeout(t); tick(); } };
  document.addEventListener('visibilitychange', onVis);
  if (now) tick(); else t = setTimeout(tick, ms);
  return () => { stopped = true; clearTimeout(t); document.removeEventListener('visibilitychange', onVis); };
}

// ===================================================================== kit: the §19 app, normalised
/** Accessors that work with both the §19 app (app.data / app.words / app.planet) and the older shell (app.D / app.W). */
export function A(app) {
  const data = app.data || app.D || null;
  const words = app.words || app.W || null;
  const meta = app.meta || null;
  const dates = (meta && meta.dates) || [];
  const lastIdx = typeof app.lastIdx === 'number' ? app.lastIdx : Math.max(0, dates.length - 1);
  const st = app.state || {};
  const nodeById = (id) => { try { return data && data.nodeById ? data.nodeById(id) : null; } catch (e) { return null; } };
  const node = () => {
    try { if (typeof app.currentNode === 'function') { const n = app.currentNode(); if (n) return n; } } catch (e) { /* ignore */ }
    return nodeById(st.nodeId || 'world');
  };
  const isRoot = (id) => {
    if (!id) return false;
    try { if (typeof app.isRoot === 'function') return app.isRoot(id); } catch (e) { /* fall through */ }
    return id === 'world';
  };
  return { data, words, meta, dates, lastIdx, state: st, nodeById, node, isRoot, planet: app.planet || null };
}

export function nameOf(app, id) {
  if (!id) return '';
  const n = A(app).nodeById(id);
  if (n) return n.name || n.ticker || id;
  return String(id).replace(/^s:/, '');
}

/** Fly to a node id (region → its planet, stock → stock view). */
export function go(app, id, pathIds) {
  if (!id) return;
  try {
    if (typeof app.goId === 'function') return app.goId(id, pathIds);
    if (String(id).startsWith('s:') && typeof app.openStock === 'function') return app.openStock(String(id).slice(2));
    if (typeof app.flyTo === 'function') return app.flyTo(pathIds || id);
  } catch (e) { console.warn('[ops] go', e); }
}

export function toast(app, msg, ms) {
  try { if (typeof app.toast === 'function') return app.toast(msg, ms); } catch (e) { /* fall through */ }
  console.info('[ops]', msg);
}

/** Subscribe to several event names at once (old + §19 names). */
export function onAny(app, names, fn) {
  if (typeof app.on !== 'function') return;
  for (const n of names) { try { app.on(n, fn); } catch (e) { /* ignore */ } }
}

/** The parts list of a dataReloaded payload (array, {parts}, or null = everything). */
export function reloadedParts(p) {
  if (Array.isArray(p)) return p.map(String);
  if (p && Array.isArray(p.parts)) return p.parts.map(String);
  return null;
}
export const touchesPart = (p, name) => { const l = reloadedParts(p); return !l || l.some((x) => x.replace(/\.json$/, '') === name); };

/** Keep [data-ops-theme] on <html> in step with app.state.theme ('day' default, 'night'). */
let themeSynced = false;
export function syncTheme(app) {
  if (themeSynced) return;
  themeSynced = true;
  const set = (t) => {
    const v = (typeof t === 'string' ? t : null) || (app.state && app.state.theme) || 'day';
    document.documentElement.setAttribute('data-ops-theme', v === 'night' ? 'night' : 'day');
  };
  set();
  onAny(app, ['theme'], (t) => set(t && typeof t === 'object' ? t.theme : t));
}

// ===================================================================== kit: top-bar buttons
/** §19 app.topbar.addButton when the shell has it (icon = a shell icon name); otherwise our own button.
 *  Returns {el, setBadge(text|null, tone?), setState(cls|null)}. tone: 'ok' | 'warn' | 'bad' | 'info'. */
export function topButton(app, { id, icon: ic, svg, label, title, order, onClick }) {
  let el = null, viaShell = false;
  const tb = app.topbar;
  if (tb && typeof tb.addButton === 'function') {
    try {
      const r = tb.addButton({ id, icon: ic || id, label, title, onClick, order });
      viaShell = true;
      el = r instanceof Element ? r : (typeof tb.button === 'function' ? tb.button(id) : null);
    } catch (e) { console.warn('[ops] addButton', e); viaShell = false; }
  }
  if (!viaShell) {
    const host = document.querySelector('#topbar .tb-right') || document.getElementById('topbar') || document.body;
    el = h('button.ops-tb-btn', { type: 'button', id: 'ops-tb-' + id, title, 'aria-label': title || label, onclick: onClick },
      icon(svg || 'dot'), label ? h('span.ops-tb-label', label) : null);
    if (order != null) el.style.order = String(order);
    host.prepend(el);
  }
  if (el) el.classList.add('ops-tb', 'ops-tb-' + id);
  let badgeEl = null;
  const setBadge = (text, tone = null) => {
    if (viaShell && typeof tb.setBadge === 'function') { try { tb.setBadge(id, text, tone); return; } catch (e) { /* own badge */ } }
    if (!el) return;
    if (!badgeEl) { badgeEl = h('span.ops-tb-badge'); el.append(badgeEl); }
    const show = text != null && text !== false;
    badgeEl.textContent = show ? String(text) : '';
    badgeEl.hidden = !show;
    badgeEl.className = 'ops-tb-badge' + (show && String(text).trim() === '' ? ' dot' : '') + (tone ? ' ' + tone : '');
  };
  const setState = (cls) => {
    if (!el) return;
    for (const c of [...el.classList]) if (c.startsWith('ops-st-')) el.classList.remove(c);
    if (cls) el.classList.add('ops-st-' + cls);
  };
  return { el, setBadge, setState, viaShell };
}

// ===================================================================== kit: panel sections
/** §19 app.panel.addSection({id, title, icon, order, render}). Our render always starts from an empty body;
 *  leaving it empty (or returning false) lets the shell hide the section. Returns {refresh()}. */
export function panelSection(app, spec) {
  let lastEl = null, lastCtx = null;
  const render = (el, ctx) => {
    lastEl = el; lastCtx = ctx;
    clear(el);
    let r;
    try { r = spec.render(el, ctx || {}); } catch (e) { console.error(`[ops] section ${spec.id}`, e); r = false; }
    return r === false || !el.childNodes.length ? false : undefined;
  };
  const refresh = () => {
    if (lastEl && lastEl.isConnected) {
      const r = render(lastEl, { ...(lastCtx || {}), ...freshCtx(app) });
      const sec = lastEl.closest('section');
      if (sec && sec !== lastEl) sec.hidden = r === false;
      return;
    }
    try { if (app.panel && typeof app.panel.refresh === 'function') app.panel.refresh(); } catch (e) { /* ignore */ }
  };
  if (app.panel && typeof app.panel.addSection === 'function') {
    try { app.panel.addSection({ id: spec.id, title: spec.title, icon: spec.icon, order: spec.order, render }); } catch (e) { console.warn('[ops] addSection', e); }
  }
  return { refresh };
}
function freshCtx(app) {
  const x = A(app);
  const node = x.node();
  const i = x.state.dateIndex ?? x.lastIdx;
  return { node, map: app.currentMap || null, dateIndex: i, date: x.dates[i], isLatest: i >= x.lastIdx, isRoot: x.isRoot(node && node.id) };
}

// ===================================================================== kit: the one drop-down sheet
let sheetEl = null, sheetCur = null, sheetKeyBound = false;
/** Open (or toggle) the ops sheet. spec: {id, title, icon, sub, render(body, ctl), onClose}.
 *  Only one ops sheet is open at a time. Returns the controller {body, rerender, close, id}. */
export function openSheet(spec, { toggle = true } = {}) {
  if (sheetCur && sheetCur.id === spec.id) {
    if (toggle) { closeSheet(); return null; }
    sheetCur.rerender();
    return sheetCur;
  }
  closeSheet(true);
  if (!sheetEl) {
    sheetEl = h('section#ops-sheet.ops.ops-sheet', { role: 'dialog', 'aria-modal': 'false', hidden: true });
    document.body.append(sheetEl);
    document.addEventListener('pointerdown', (e) => {
      if (!sheetCur || sheetEl.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.ops-tb, #toast, .ops-keep-sheet')) return;
      closeSheet();
    }, true);
  }
  if (!sheetKeyBound) {
    sheetKeyBound = true;
    // the shell skips its own shortcuts while a .mw-modal-open element exists, so Esc lands here
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !sheetCur || e.isComposing) return;
      e.preventDefault();
      closeSheet();
    });
  }
  const body = h('div.ops-sheet-body');
  const head = h('header.ops-sheet-head',
    h('span.ops-sheet-icon', icon(spec.icon || 'dot')),
    h('div.ops-sheet-titles', h('h2.ops-sheet-title', spec.title), spec.sub ? h('p.ops-sheet-sub', spec.sub) : null),
    h('button.ops-icon-btn.ops-sheet-close', { type: 'button', title: '关上（Esc）', 'aria-label': '关上', onclick: () => closeSheet() }, icon('close')));
  clear(sheetEl).append(head, body);
  sheetEl.setAttribute('aria-label', spec.title);
  sheetEl.dataset.sheet = spec.id;
  sheetEl.hidden = false;
  sheetEl.classList.add('mw-modal-open');
  requestAnimationFrame(() => sheetEl.classList.add('on'));
  const ctl = {
    id: spec.id, body, head,
    rerender: () => { if (sheetCur !== ctl) return; const st = body.scrollTop; clear(body); try { spec.render(body, ctl); } catch (e) { console.error('[ops] sheet', e); } body.scrollTop = st; },
    close: () => { if (sheetCur === ctl) closeSheet(); },
    onClose: spec.onClose,
  };
  sheetCur = ctl;
  try { spec.render(body, ctl); } catch (e) { console.error('[ops] sheet', e); }
  return ctl;
}
export function closeSheet(instant = false) {
  if (!sheetCur) return false;
  const cur = sheetCur;
  sheetCur = null;
  try { cur.onClose && cur.onClose(); } catch (e) { /* ignore */ }
  if (!sheetEl) return true;
  sheetEl.classList.remove('on', 'mw-modal-open');
  if (instant) { sheetEl.hidden = true; return true; }
  setTimeout(() => { if (!sheetCur) sheetEl.hidden = true; }, 200);
  return true;
}
export const sheetOpen = (id) => !!sheetCur && (!id || sheetCur.id === id);
export const sheetCtl = (id) => (sheetCur && sheetCur.id === id ? sheetCur : null);

/** Small meter bar: used / cap */
export function meter(used, cap, { label = '', warnAt = 0.8 } = {}) {
  const u = Math.max(0, +used || 0), c = Math.max(0, +cap || 0);
  const f = c ? Math.min(1, u / c) : 0;
  return h('div.ops-meter' + (!c ? '.nocap' : u >= c ? '.full' : f >= warnAt ? '.warn' : ''),
    h('span.ops-meter-label', label),
    h('span.ops-meter-bar', h('span.ops-meter-fill', { style: { width: (f * 100).toFixed(1) + '%' } })),
    h('span.ops-meter-num', c ? `${u}/${c}` : `${u} 次`));
}

// ===================================================================== kit: the Claude budget (§21, §24)
// One limit only: spend. All Claude calls together ≤ 6 weekly-quota points a day, automatic work ≤ 4
// (the last 2 are kept for the owner's clicks). Read from GET /api/budget (common/claude_gate.budget_status),
// else the loop's heartbeat.usage, else data/claude_usage.json. Points are "约" until calibrated.
export const OWNER_TZ = 'Australia/Sydney';
const KIND_ZH = {
  why: '为什么', scenario: '推演', intel: '情报投喂', scout: '侦察兵', 'scout:ask': '侦察兵 · 你派的',
  'scout:explain': '解释异动', 'scout:gap': '补数据', 'scout:verify': '核对故障', loop: '心跳诊断',
  polymarket: '预言市场翻译', pm: '预言市场翻译', 'polymarket:translate': '预言市场翻译', 'polymarket:map': '预言市场映射',
  kalshi: 'Kalshi 翻译', graph: '关系网', calibrate: '校准',
};
export const kindZh = (k) => KIND_ZH[k] || KIND_ZH[String(k).split(':')[0]] || String(k);
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && isFinite(+x) ? +x : null);
/** 2.53 → "2.5", 0.04 → "0.04", 0 → "0" */
export const ptsTxt = (x) => { const v = Math.max(0, +x || 0); return v === 0 ? '0' : v < 0.1 ? v.toFixed(2).replace(/0$/, '') : (Math.round(v * 10) / 10).toString(); };

/** When today's budget comes back, in the owner's own clock: "明天 00:00" (+ "AEDT"). */
export function resetLabel(b) {
  if (b && typeof b.resetWord === 'string' && b.resetWord.trim()) return { text: b.resetWord.trim(), tz: '' };   // the gateway's own words
  const raw = b && (b.resetsAtLocal || b.resetsAt);
  let d = raw ? new Date(raw) : null;
  if (raw && (!d || isNaN(d))) return { text: String(raw), tz: '' };        // the server already worded it
  if (!d) {
    // owner's next local midnight
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date()).map((p) => [p.type, p.value]));
    const mins = (+parts.hour % 24) * 60 + +parts.minute;
    d = new Date(Date.now() + (24 * 60 - mins) * 60000);
  }
  const fmt = (o) => new Intl.DateTimeFormat('zh-CN', { timeZone: OWNER_TZ, ...o }).format(d);
  const dayOf = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TZ }).format(x);
  const hm = fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24/, '00');
  const today = dayOf(new Date()), tomorrow = dayOf(new Date(Date.now() + 86400000));
  const day = dayOf(d) === today ? '今天' : dayOf(d) === tomorrow ? '明天' : fmt({ month: 'numeric', day: 'numeric' });
  let tz = '';
  try { tz = new Intl.DateTimeFormat('en-AU', { timeZone: OWNER_TZ, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || ''; } catch (e) { /* ignore */ }
  return { text: `${day} ${hm}`, tz: /^[A-Z]{3,5}$/.test(tz) ? tz : '' };
}

/** Any of the three shapes → {used, cap, autoUsed, autoCap, usd, usdPerPt, calibrated, byKind:[{kind,label,pts,usd,calls,auto}],
 *  over, autoOver, reset:{text,tz}, src}. null when nothing is known. */
export function normBudget(raw, src) {
  if (!raw || typeof raw !== 'object' || raw.error) return null;
  const usdPerPt = num(raw.usdPerPt) ?? num(raw.usdPerPct) ?? num(raw.usd_per_weekly_pct) ?? null;
  const ptsOf = (v) => {
    if (num(v) != null) return num(v);
    if (!v || typeof v !== 'object') return 0;
    return num(v.pts) ?? num(v.usedPts) ?? num(v.pct) ?? (usdPerPt && num(v.usd) != null ? num(v.usd) / usdPerPt : 0);
  };
  const used = num(raw.usedPts) ?? num(raw.pct) ?? (usdPerPt && num(raw.usd) != null ? num(raw.usd) / usdPerPt : null);
  if (used == null) return null;
  const cap = num(raw.capPts) ?? num(raw.capPct) ?? 6;
  const autoUsed = num(raw.autoUsedPts) ?? num(raw.autoPct) ?? (usdPerPt && num(raw.autoUsd) != null ? num(raw.autoUsd) / usdPerPt : 0);
  const autoCap = num(raw.autoCapPts) ?? num(raw.autoCapPct) ?? 4;
  // one row per thing the owner recognises: every why:<target> is "为什么"; test calls are left out
  const groups = new Map();
  for (const [k, v] of Object.entries(raw.byKind || {})) {
    if (/^(gate|test)\b/.test(k)) continue;
    const g = /^why\b/.test(k) ? 'why' : /^(scenario|intel)\b/.test(k) ? k.split(':')[0] : k;
    // "自动" only when the ledger says so (a gap/explain can be the owner's own click too)
    const cur = groups.get(g) || { kind: g, label: kindZh(g), pts: 0, usd: 0, calls: 0, auto: false };
    cur.pts += ptsOf(v);
    if (v && typeof v === 'object') {
      cur.usd += num(v.usd) || 0;
      cur.calls += num(v.calls) ?? num(v.n) ?? 0;
      if (typeof v.auto === 'boolean') cur.auto = v.auto;
    }
    groups.set(g, cur);
  }
  const byKind = [...groups.values()].filter((x) => x.pts >= 0.005 || x.calls).sort((a, b) => b.pts - a.pts);
  const boost = raw.boost && typeof raw.boost === 'object' && num(raw.boost.extraPts) ? raw.boost : null;
  const calibrated = raw.calibrated === true || (raw.estimate === false && raw.calibrated !== false);
  // §21 amendment 2: unlimited:true → no cap at all; spend is still logged and shown in dollars
  const unlimited = raw.unlimited === true;
  return {
    used, cap, autoUsed, autoCap, usd: num(raw.usd), usdPerPt, calibrated, byKind, unlimited,
    calls: num(raw.calls), model: raw.model || null, effort: raw.effort || null, say: typeof raw.say === 'string' ? raw.say : '',
    over: !unlimited && (raw.over === true || used >= cap - 1e-9), autoOver: !unlimited && (raw.autoOver === true || autoUsed >= autoCap - 1e-9),
    left: num(raw.leftPts) ?? Math.max(0, cap - used), reset: resetLabel(raw), day: raw.day || null, src,
    boost: boost ? { extra: num(boost.extraPts), say: boost.say || '' } : null,
    inflight: num(raw.inflight) || 0, inflightPts: num(raw.inflightPts) || 0,
    weekly: raw.weekly && num(raw.weekly.pct) != null ? { pct: num(raw.weekly.pct), readAt: raw.weekly.readAt || null } : null,
  };
}
/** "$24.78" */
export const usdTxt = (x) => { const v = Math.max(0, +x || 0); return '$' + (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)); };
/** "今天已用 ≈ 2.5 / 6 个点（自动 0.8/4）" — or, while unlimited, "不限额度 · 今天已花 ≈ $24.78" (never x / 6 个点) */
export const budgetLine = (b) => (b && b.unlimited
  ? `不限额度 · 今天已花 ≈ ${usdTxt(b.usd != null ? b.usd : b.used * (b.usdPerPt || 0))}`
  : `今天已用 ≈ ${ptsTxt(b.used)} / ${ptsTxt(b.cap)} 个点（自动 ${ptsTxt(b.autoUsed)}/${ptsTxt(b.autoCap)}）`);
/** The words every Claude button shows once today's points are gone. */
export const budgetOutNote = (b) => `今天的额度用完了（${b && b.reset ? b.reset.text : '明天 00:00'}${b && b.reset && b.reset.tz ? ' ' + b.reset.tz : ''} 恢复）`;
/** Does a server reply say "refused: over budget"? */
export const refusedForBudget = (r) => !!r && (r.refused === 'budget' || r.state === 'refused' || /额度用完|over budget|budget/i.test(String(r.error || '')));
/**
 * ONE wording for every Claude button the gateway turned away (为什么 · 推演 · 投喂 · 🔎): the server's own sentence
 * is the main text (it carries the exact numbers and reset time); one extra line is built only from /api/budget —
 * the owner's own cap, the before-reset boost labelled 「重置前多给的」, and when it comes back — never hard-coded.
 * → {main, extra, text}  (text = main + "\n" + extra)
 */
export function budgetRefusal(r, b) {
  const srv = String((r && (r.error || r.reason || r.say)) || '').trim();
  const main = srv && /额度|budget|点/i.test(srv) ? srv.replace(/[。.]\s*$/, '') + '。' : budgetOutNote(b) + '。';
  let extra = '';
  if (b && !b.unlimited) {
    const boost = b.boost && b.boost.extra > 0 ? b.boost.extra : 0;
    const own = Math.max(0, b.cap - boost);
    const parts = [`你定的上限每天 ${ptsTxt(own)} 个点`];
    if (boost) parts[0] += `，今天另有重置前多给的 ${ptsTxt(boost)} 个点`;
    if (!/\/\s*[\d.]+\s*个点/.test(main)) parts.push(`已用 ≈ ${ptsTxt(b.used)} 个点`);   // the server's sentence may already say it
    // the reset time only when the server's sentence did not already say it
    if (!/恢复|\d{1,2}:\d{2}/.test(main) && b.reset && b.reset.text) parts.push(`${b.reset.text}${b.reset.tz ? ' ' + b.reset.tz : ''} 恢复`);
    extra = parts.join('；') + '。';
  }
  return { main, extra, text: extra ? `${main}\n${extra}` : main };
}

/** "复制命令" button — the fallback when the page runs without server.py. */
export function copyBtn(app, text, label = '复制命令') {
  return h('button.ops-btn.ghost.small', {
    type: 'button', title: text,
    onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast(app, '命令已复制：粘到终端，或者直接丢给 Claude Code'); }
      catch (e) { window.prompt('复制这条命令：', text); }
    },
  }, icon('copy'), label);
}
export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// ===================================================================== heartbeat feature
const STALE_HB_MIN = 90;          // the loop writes at least hourly; older than this → it has stopped
const POLL_MS = 60_000;
const COLORS = { green: '心跳正常', amber: '有点小毛病', red: '出问题了', grey: '没心跳' };
const CYCLE_ZH = { market: '盘中轮', close: '收盘轮', nightly: '夜间轮', health: '体检轮' };
const CAP_ZH = { global: '全部', scout: '侦察兵', explain: '解释异动', gap: '补估算', verify: '故障诊断', map: '预言市场映射', ask: '你问的' };
const LEVEL_ZH = { code: '要改代码', env: '环境问题', data: '数据问题', transient: '临时故障', unknown: '还没查清' };

/** What the market clock says without a heartbeat: the last close that should be in the data. */
function expectedClose(now = new Date()) {
  // New York wall clock
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = new Date(ny);
  const afterClose = ny.getHours() * 60 + ny.getMinutes() >= 16 * 60 + 30;
  if (!afterClose) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return localISODate(d);
}

export function init(app) {
  syncTheme(app);
  const X = () => A(app);
  let hb = null, src = null, apiMissing = false, fetchedAt = 0;
  let budget = null, budgetApiMissing = false, budgetAt = 0;

  const btn = topButton(app, { id: 'heartbeat', icon: 'pulse', svg: 'pulse', label: '', title: '心跳：数据和后台循环的健康状况', order: 90, onClick: () => toggle() });
  if (btn.el) btn.el.classList.add('ops-hb');

  async function load() {
    let j = null;
    if (!apiMissing) {
      const r = await api('api/heartbeat', { timeout: 8000 });
      if (r && !r.error && (r.status || r.updatedAt)) { j = r; src = r.source === 'file' ? 'file' : 'api'; }
      else if (r && r.missing) apiMissing = true;
    }
    if (!j) { j = await dataFile(app, 'heartbeat.json'); if (j) src = 'file'; }
    hb = j && typeof j === 'object' ? j : null;
    fetchedAt = Date.now();
    await loadBudget(false);
    paint();
    const ctl = sheetCtl('heartbeat');
    if (ctl) ctl.rerender();
  }

  /** §21/§24 spend: /api/budget → heartbeat.usage → data/claude_usage.json (today's day only). */
  // ask the server's route list first, so a server without /api/budget costs no 404 in the console
  let routesAt = 0, routesSay = null;
  async function budgetRouteKnown() {
    if (Date.now() - routesAt > 10 * 60_000) {
      routesAt = Date.now();
      const r = await api('api/routes', { timeout: 5000 });
      routesSay = r && Array.isArray(r.routes) ? r.routes.join('\n') : null;
      if (routesSay != null) budgetApiMissing = !/\/api\/budget\b/.test(routesSay);
    }
    return !budgetApiMissing;
  }
  async function loadBudget(repaint = true) {
    let b = null;
    if (await budgetRouteKnown()) {
      const r = await api('api/budget', { timeout: 6000 });
      if (r && r.missing) budgetApiMissing = true;
      else b = normBudget(r, 'api');
    }
    if (!b && hb && hb.usage) b = normBudget(hb.usage, 'heartbeat');
    if (!b) {
      const f = await dataFile(app, 'claude_usage.json');
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TZ }).format(new Date());
      const d = f && f.days && f.days[day];
      const cfg = (f && f.config) || {};
      const per = +cfg.usdPerWeeklyPct || +cfg.usd_per_weekly_pct || 1;
      if (f) {
        b = normBudget({
          day, usd: d ? d.usd : 0, autoUsd: d ? d.autoUsd : 0, usdPerPct: per,
          capPct: +cfg.dailyWeeklyPct || 6, autoCapPct: +cfg.autoWeeklyPct || 4, calibrated: cfg.calibrated === true,
          byKind: d ? d.byKind : {},
        }, 'file');
      }
    }
    const prev = budget ? JSON.stringify([budget.used, budget.autoUsed, budget.over]) : '';
    budget = b;
    budgetAt = Date.now();
    if (JSON.stringify(b ? [b.used, b.autoUsed, b.over] : '') !== prev) { try { app.emit && app.emit('budget', budget); } catch (e) { /* ignore */ } }
    if (repaint) {
      paint();
      const ctl = sheetCtl('heartbeat');
      if (ctl) ctl.rerender();
    }
    return budget;
  }
  // other modules: app.budget.get() → the normalised status (or null), .refresh(), .outNote()
  app.budget = {
    get: () => budget,
    refresh: () => loadBudget(true),
    over: (auto = false) => !!budget && (auto ? budget.autoOver || budget.over : budget.over),
    outNote: () => budgetOutNote(budget),
    line: () => (budget ? budgetLine(budget) : ''),
    refusal: (r) => budgetRefusal(r, budget),
  };
  // §21: every Claude button says the same thing when the gateway turns it away (server's words + one budget line)
  app.budgetRefusal = (r) => { try { loadBudget(true); } catch (e) { /* ignore */ } return budgetRefusal(r, budget); };
  app.budgetRefusalText = (r) => app.budgetRefusal(r).text;

  /** the loop is not running at all (no heartbeat, or the server's "none" stand-in) */
  const noLoop = () => !hb || hb.source === 'none' || (hb.state === 'stopped' && !hb.lastCycle && !(hb.steps || []).length);

  /** {color, say, detail} from the heartbeat (or from meta alone when the loop isn't running) */
  function status() {
    const meta = X().meta;
    const asOf = meta && meta.asOf;
    const lag = asOf ? daysBetween(asOf, expectedClose()) : null;
    const stale = lag != null && lag > 0;
    if (noLoop()) {
      return {
        color: 'amber',
        say: stale ? `心跳循环没在跑，数据停在 ${cnDate(asOf)}` : '心跳循环没在跑（数据目前还是新的）',
        detail: (hb && hb.statusSay && hb.source === 'none' ? hb.statusSay + '。' : '后台循环没开：') + '数据不会自己更新，出了问题也没人去查。',
      };
    }
    let color = ['green', 'amber', 'red'].includes(hb.status) ? hb.status : 'amber';
    let say = hb.statusSay || COLORS[color];
    const age = hb.updatedAt ? (Date.now() - new Date(hb.updatedAt).getTime()) / 60000 : null;
    if (hb.state === 'stopped') { color = color === 'red' ? 'red' : 'amber'; }
    else if (age != null && age > STALE_HB_MIN) {
      color = color === 'red' ? 'red' : 'amber';
      say = `心跳 ${age > 120 ? Math.round(age / 60) + ' 小时' : Math.round(age) + ' 分钟'}没跳了：循环可能停了` + (stale ? `，数据停在 ${cnDate(asOf)}` : '');
    }
    if (color === 'green' && stale) { color = 'amber'; say = `数据停在 ${cnDate(asOf)}，比该有的晚了 ${lag} 天`; }
    return { color, say };
  }

  function paint() {
    const s = status();
    btn.setState(s.color);
    if (btn.el) {
      btn.el.dataset.opsHb = s.color;
      btn.el.title = `心跳：${s.say}` + (budget ? `\nClaude：${budgetLine(budget)}${budget.calibrated || budget.unlimited ? '' : '（约）'}` : '') + '\n（点开看详情）';
      btn.el.setAttribute('aria-label', btn.el.title);
      btn.el.dataset.opsBudget = budget ? (budget.unlimited ? 'ok' : budget.over ? 'out' : budget.used / Math.max(budget.cap, 0.01) >= 0.8 ? 'low' : 'ok') : '';
    }
    const open = noLoop() ? 0 : (hb.issues || []).length;
    if (s.color === 'red') btn.setBadge('!', 'bad');
    else if (open) btn.setBadge(String(open), s.color === 'green' ? 'info' : 'warn');
    else if (s.color === 'amber') btn.setBadge('', 'warn');
    else if (budget && budget.over) btn.setBadge('', 'warn');     // today's Claude points are gone: every 为什么/推演 waits
    else btn.setBadge(null);
  }

  // ---------------------------------------------------------------- the sheet
  function toggle() {
    openSheet({
      id: 'heartbeat', title: '心跳', icon: 'pulse',
      sub: '后台循环有没有在帮你盯着：数据新不新、哪一步坏了、派 Claude 查了什么',
      render: renderSheet,
    });
    if (Date.now() - fetchedAt > 15000) load();
  }

  function renderSheet(body) {
    const s = status();
    body.append(h('div.ops-hb-status.' + s.color,
      h('span.ops-hb-big', h('span.ops-hb-ring')),
      h('div.ops-hb-say', h('strong', s.say),
        h('span.ops-sub', !noLoop() ? [hb.updatedAt ? `更新于 ${clock(hb.updatedAtLocal || hb.updatedAt)}` : '', hb.mode ? ` · ${hb.mode === 'thread' || hb.mode === 'server' ? '跟着服务器跑' : hb.mode === 'launchd' ? '后台服务' : '独立运行'}` : '', src === 'file' ? ' · 读的是 heartbeat.json' : ''].join('')
          : (s.detail || '')))));

    if (noLoop()) {
      body.append(h('div.ops-callout',
        h('p', '让它活起来：在项目目录运行'),
        h('code.ops-code', 'python3 loop/runner.py'),
        h('p.ops-sub', '它会盘中每 15 分钟刷新、收盘后完整更新、夜里补数据；坏了先自己重试，再派 Claude 去查。页面关着也能跑的后台服务要你说「装」才会装（见 loop/README.md）。'),
        h('div.ops-row', copyBtn(app, 'python3 loop/runner.py'))));
      body.append(budgetBlock(budget));
      return;
    }

    // next cycle + market
    const nx = hb.nextCycle, mk = hb.market || {};
    const running = hb.running;
    body.append(h('div.ops-facts',
      fact('下一轮', running ? `正在跑：${running.title || running.step || ''}` : nx ? (nx.say || '').replace(/^下一轮：/, '') : '—'),
      fact('美股', mk.open ? '开盘中' : [mk.reason || '休市', mk.opensAtLocal ? ` · 你那边 ${mk.opensAtLocal} 开盘` : ''].join('')),
      hb.health && hb.health.facts && hb.health.facts.asOf ? fact('数据', `${cnDate(hb.health.facts.asOf)} 收盘` + (hb.health.facts.lagDays ? ` · 落后 ${hb.health.facts.lagDays} 天` : '')) : null));

    // Claude budget (§21): spend is the only limit — no count caps anywhere
    const sc = hb.scout || {};
    body.append(budgetBlock(budget, sc));

    // last cycle
    const lc = hb.lastCycle;
    if (lc || (hb.steps && hb.steps.length)) {
      const steps = (hb.steps || []).map((st) => h('li.ops-step' + (st.skipped ? '.skip' : st.ok ? '.ok' : '.bad'),
        h('span.ops-step-mark', icon(st.skipped ? 'dot' : st.ok ? 'check' : 'cross')),
        h('span.ops-step-name', st.title || st.name),
        h('span.ops-step-note', st.error ? String(st.error).slice(0, 80) : st.note ? String(st.note).slice(0, 80) : st.skipped ? '跳过' : ''),
        h('span.ops-step-ms', st.ms != null ? (st.ms >= 1000 ? (st.ms / 1000).toFixed(st.ms >= 10000 ? 0 : 1) + 's' : st.ms + 'ms') : '')));
      body.append(sec(lc ? `上一轮：${lc.nameZh || CYCLE_ZH[lc.name] || lc.name}` : '上一轮',
        lc ? `${clock(lc.endedAt || lc.startedAt)} 跑完 · ${lc.ok ? '全部通过' : '有步骤失败'}${lc.say ? ' · ' + lc.say : ''}` : '',
        steps.length ? h('ul.ops-steps', steps) : null,
        recentStrip(hb.recent)));
    }

    // what Claude was sent to do
    const cl = hb.claude || [];
    if (cl.length) {
      body.append(sec('派 Claude 去查了什么', null, h('ul.ops-claude', cl.slice(0, 6).map((c) => h('li',
        h('div.ops-claude-head', h('span.ops-chip', CAP_ZH[c.kind] || c.kind || 'Claude'), h('span.ops-sub', clock(c.at)),
          c.ok === false ? h('span.ops-chip.bad', '没查成') : null),
        h('div.ops-claude-ask', c.ask || c.target || ''),
        c.found ? h('div.ops-claude-found', '→ ' + c.found) : null)))));
    }

    // open issues
    const iss = hb.issues || [];
    body.append(sec(`待处理问题（${iss.length}）`, iss.length ? '代码层的问题 Claude 不会自己改，写在 loop/out/issues.md' : null,
      iss.length ? h('ul.ops-issues', iss.map((i) => h('li.ops-issue',
        h('div.ops-issue-head', h('span.ops-chip' + (i.level === 'code' || i.level === 'env' ? '.bad' : ''), LEVEL_ZH[i.level] || i.level || '问题'),
          h('strong', i.title || i.step || i.id), i.count > 1 ? h('span.ops-sub', `×${i.count}`) : null),
        i.statusText ? h('div.ops-sub', i.statusText) : null,
        i.diagnosis ? h('div.ops-issue-diag', typeof i.diagnosis === 'string' ? i.diagnosis : (i.diagnosis.say || i.diagnosis.summary || '')) : null,
        h('div.ops-issue-foot', h('code.ops-code.small', `python3 loop/runner.py --resolve ${i.id}`), copyBtn(app, `python3 loop/runner.py --resolve ${i.id}`, '复制')))))
        : h('p.ops-empty', '没有。系统自己扛得住。')));

    const probs = (hb.health && hb.health.problems) || [];
    if (probs.length) {
      body.append(sec('体检看到的', null, h('ul.ops-plain', probs.slice(0, 6).map((p) => h('li.' + (p.level === 'fail' ? 'bad' : 'warn'), p.say || p.what || String(p))))));
    }
  }

  /** 今天已用 ≈ x / 6 个点（自动 y/4） · a 6-point bar with the auto zone · per-kind breakdown · reset time. */
  function budgetBlock(b, sc = {}) {
    const queue = sc.queued || sc.running ? h('p.ops-sub', `侦察兵：${sc.running || 0} 个在跑，${sc.queued || 0} 个排队`) : null;
    if (!b) {
      return sec('Claude 额度 · 今天', null,
        h('p.ops-empty', '还没有花费记录：今天还没调用过 Claude，或者服务器还没接上账本。'), queue);
    }
    if (b.unlimited) return unlimitedBlock(b, queue);
    const cap = Math.max(b.cap, 0.01);
    const pc = (x) => (Math.max(0, Math.min(cap, x)) / cap * 100).toFixed(2) + '%';
    const ownerUsed = Math.max(0, b.used - b.autoUsed);
    const est = !b.calibrated ? h('span.ops-chip.ops-est', { title: '点数是按美元折算周额度得来的，还没用真实的周额度校准过' }, '约') : null;
    const ticks = [];
    for (let k = 1; k < Math.round(cap); k++) ticks.push(h('i.ops-bud-tick' + (k === Math.round(b.autoCap) ? '.auto' : ''), { style: { left: pc(k) } }));
    const bar = h('div.ops-bud-bar', { role: 'img', 'aria-label': budgetLine(b) },
      h('span.ops-bud-reserve', { style: { left: pc(b.autoCap), width: `calc(100% - ${pc(b.autoCap)})` }, title: `最后 ${ptsTxt(cap - b.autoCap)} 个点只留给你自己点的按钮` }),
      h('span.ops-bud-fill.auto', { style: { width: pc(b.autoUsed) } }),
      h('span.ops-bud-fill.owner', { style: { left: pc(b.autoUsed), width: pc(Math.min(ownerUsed, cap - Math.min(b.autoUsed, cap))) } }),
      ticks,
      h('span.ops-bud-mark', { style: { left: pc(b.autoCap) } }, `自动到 ${ptsTxt(b.autoCap)}`));
    const kinds = b.byKind.slice(0, 8);
    const maxPts = Math.max(...kinds.map((k) => k.pts), 0.01);
    const state = b.over ? h('div.ops-callout.bad', h('p', h('strong', budgetOutNote(b)), '。为什么、推演、投喂、侦察兵都先停，到点自动恢复。'))
      : b.autoOver ? h('div.ops-callout', h('p', h('strong', `自动任务的 ${ptsTxt(b.autoCap)} 个点用完了`), `，后台先停；你自己点的按钮还能用 ${ptsTxt(b.left)} 个点。`))
        : null;
    return h('section.ops-sec.ops-budget',
      h('div.ops-sec-head', h('h3.ops-sec-title', 'Claude 额度 · 今天'), est),
      h('div.ops-bud-head',
        h('strong.ops-bud-line', `今天已用 ≈ ${ptsTxt(b.used)} / ${ptsTxt(b.cap)} 个点`),
        h('span.ops-bud-auto', `（自动 ${ptsTxt(b.autoUsed)}/${ptsTxt(b.autoCap)}）`)),
      bar,
      h('div.ops-bud-legend',
        h('span', h('i.ops-bud-sw.auto'), `自动 ${ptsTxt(b.autoUsed)}`),
        h('span', h('i.ops-bud-sw.owner'), `你点的 ${ptsTxt(ownerUsed)}`),
        b.inflight ? h('span', { title: '还在跑的调用按估计先占着额度，跑完按实际花费记账' }, h('i.ops-bud-sw.busy'), `${b.inflight} 个在跑 ≈ ${ptsTxt(b.inflightPts)}`) : null,
        h('span.ops-bud-left', `还剩 ${ptsTxt(b.left)}`)),
      // the owner's "能把额度用完就用完": before the weekly reset the gateway lends the soon-to-expire quota
      b.boost ? h('p.ops-bud-boost', h('span.ops-bud-boost-k', `+${ptsTxt(b.boost.extra)} 点`),
        b.boost.say || `周额度重置前多给 ${ptsTxt(b.boost.extra)} 个点，反正要作废，用掉它`) : null,
      state,
      kinds.length ? h('ul.ops-bud-kinds', kinds.map((k) => h('li',
        h('span.ops-bud-k', k.label, k.auto ? h('span.ops-bud-autotag', '自动') : null),
        h('span.ops-bud-kbar', h('i' + (k.auto ? '.auto' : '.owner'), { style: { width: (k.pts / maxPts * 100).toFixed(1) + '%' } })),
        h('span.ops-bud-kn', k.calls != null ? `${k.calls} 次` : ''),
        h('span.ops-bud-kp', `${ptsTxt(k.pts)} 点`)))) : h('p.ops-empty', '今天还没花。'),
      h('p.ops-sub', `额度在${b.reset.text}${b.reset.tz ? ' ' + b.reset.tz : ''} 恢复。不限次数，只限花费：自动任务最多 ${ptsTxt(b.autoCap)} 个点，最后 ${ptsTxt(b.cap - b.autoCap)} 个点留给你点的「为什么 · 推演 · 投喂 · 侦察兵」。`
        + (b.calibrated ? '' : '点数按美元折算周额度，还没校准，是约数。')),
      queue);
  }

  /** §21 amendment 2 (unlimited:true): no ruler, no points, no "用完" — today's dollars, who spent them, which model. */
  function unlimitedBlock(b, queue) {
    const usd = b.usd != null ? b.usd : 0;
    const kinds = b.byKind.filter((k) => k.usd > 0 || k.calls).sort((a, c) => c.usd - a.usd).slice(0, 8);
    const maxUsd = Math.max(...kinds.map((k) => k.usd), 0.01);
    const autoUsd = kinds.filter((k) => k.auto).reduce((a, k) => a + k.usd, 0);
    const model = [b.model ? String(b.model).replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/^sonnet/, 'Sonnet').replace(/^opus/, 'Opus').replace(/^haiku/, 'Haiku') : '', b.effort ? `${b.effort} 推理` : ''].filter(Boolean).join(' · ');
    return h('section.ops-sec.ops-budget.unlimited',
      h('div.ops-sec-head', h('h3.ops-sec-title', 'Claude 花费 · 今天'), h('span.ops-chip', { title: '主人设的：不设每天上限，花费照样记账' }, '不限额度')),
      h('div.ops-bud-head',
        h('strong.ops-bud-line', `不限额度 · 今天已花 ≈ ${usdTxt(usd)}`),
        b.calls != null ? h('span.ops-bud-auto', `（${b.calls} 次${autoUsd > 0 ? `，自动任务 ≈ ${usdTxt(autoUsd)}` : ''}）`) : null),
      b.inflight ? h('p.ops-sub', `${b.inflight} 个调用还在跑，跑完按实际花费记账`) : null,
      // the server says which part came after the weekly reset (「…；06:00 周额度重置后 $1.58」): the new week's own spend
      (() => { const m = String(b.say || '').match(/(\d{1,2}:\d\d)\s*周额度重置后\s*\$?\s*([\d.]+)/); return m ? h('p.ops-sub', `其中 ${m[1]} 周额度重置后 ≈ $${(+m[2]).toFixed(2)}（算新的一周）`) : null; })(),
      kinds.length ? h('ul.ops-bud-kinds', kinds.map((k) => h('li',
        h('span.ops-bud-k', k.label, k.auto ? h('span.ops-bud-autotag', '自动') : null),
        h('span.ops-bud-kbar', h('i' + (k.auto ? '.auto' : '.owner'), { style: { width: (k.usd / maxUsd * 100).toFixed(1) + '%' } })),
        h('span.ops-bud-kn', k.calls != null ? `${k.calls} 次` : ''),
        h('span.ops-bud-kp', usdTxt(k.usd))))) : h('p.ops-empty', '今天还没花。'),
      h('p.ops-sub', `不设上限：为什么 · 推演 · 投喂 · 侦察兵和后台任务都不会被拦。${model ? `全部用 ${model}。` : ''}花费是 Claude 自己报的美元数，想恢复每天的上限，把 common/budget.json 的 unlimited 改成 false。`),
      queue);
  }

  function fact(k, v) { return h('div.ops-fact', h('span.ops-fact-k', k), h('span.ops-fact-v', v)); }
  function recentStrip(list) {
    if (!list || !list.length) return null;
    return h('div.ops-recent', h('span.ops-sub', '最近几轮'),
      h('span.ops-recent-dots', list.slice(0, 12).reverse().map((r) => h('span.ops-recent-dot.' + (r.ok ? 'ok' : 'bad'),
        { title: `${CYCLE_ZH[r.name] || r.name} · ${clock(r.startedAt)} · ${r.ok ? '通过' : '失败'}${r.say ? ' · ' + r.say : ''}` }))));
  }

  every(POLL_MS, load);
  onAny(app, ['data', 'dataReloaded'], () => { paint(); });
  // a Claude job just finished somewhere: today's spend moved
  onAny(app, ['scoutDone', 'whyDone', 'claudeSpent'], () => { setTimeout(() => loadBudget(true), 800); });
  return { reload: load, status, budget: () => budget };
}

/** Section block used by all ops sheets. */
export function sec(title, sub, ...kids) {
  return h('section.ops-sec', h('h3.ops-sec-title', title), sub ? h('p.ops-sec-sub', sub) : null, ...kids);
}
