// dom.js — tiny DOM + formatting helpers shared by the shell UI.
import { crashAt, realOfSeries } from '../words.js';   // DESIGN §8 amendment (season crash gate) · §23 real money

/** h('div.card#x', {onclick, title, style:{…}, dataset:{…}}, child, 'text', [more]) */
export function h(sel, attrs, ...kids) {
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const $ = (s, root = document) => root.querySelector(s);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/** Render a headline string, turning 【xxx】 into highlighted spans. */
export function richText(str) {
  const frag = document.createDocumentFragment();
  String(str || '').split(/(【[^】]*】)/).forEach((part) => {
    if (!part) return;
    if (part.startsWith('【') && part.endsWith('】')) frag.append(h('span.hl', part.slice(1, -1)));
    else frag.append(document.createTextNode(part));
  });
  return frag;
}

const WEEK = '日一二三四五六';
/** "2026-10-26" → "10月26日" (+ " 周一" if withWeek) */
export function cnDate(iso, withWeek = false, withYear = false) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${withYear ? y + '年' : ''}${m}月${d}日${withWeek ? ' 周' + WEEK[wd] : ''}`;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k) el.append(k);
  return el;
}

/** Small sparkline SVG of `values` (nulls skipped). Marks index `mark` with a dot. */
export function sparkline(values, { w = 120, h = 28, mark = null, cls = 'spark', from = 0, to = null, pad = 2 } = {}) {
  const v = (values || []).slice(from, to == null ? undefined : to + 1);
  const pts = v.map((y, i) => [i, y]).filter((p) => p[1] != null && isFinite(p[1]));
  const s = svg('svg', { class: cls, width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  if (pts.length < 2) return s;
  let lo = Infinity, hi = -Infinity;
  for (const [, y] of pts) { if (y < lo) lo = y; if (y > hi) hi = y; }
  if (hi === lo) { hi += 1; lo -= 1; }
  const X = (i) => pad + (i / Math.max(1, v.length - 1)) * (w - 2 * pad);
  const Y = (y) => pad + (1 - (y - lo) / (hi - lo)) * (h - 2 * pad);
  const d = pts.map(([i, y], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join('');
  const first = pts[0][1], last = pts[pts.length - 1][1];
  const up = last >= first;
  s.append(svg('path', { d: d + `L${X(pts[pts.length - 1][0]).toFixed(1)},${h}L${X(pts[0][0]).toFixed(1)},${h}Z`, class: 'spark-area' + (up ? ' up' : ' down') }));
  s.append(svg('path', { d, class: 'spark-line' + (up ? ' up' : ' down') }));
  const mi = mark == null ? null : mark - from;
  if (mi != null && mi >= 0 && mi < v.length && v[mi] != null) s.append(svg('circle', { cx: X(mi), cy: Y(v[mi]), r: 2.4, class: 'spark-dot' }));
  return s;
}

// ===================================================================== icon set (§17)
// One hand-drawn-but-precise line set: 20×20, 1.6 stroke, round caps. Colour = currentColor.
// Feature modules: app.icon('name') or app.topbar.addButton({icon:'name'}). Names: see ICONS keys.
function snowflake() {
  let d = '';
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 - Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const P = (r, s) => `${(10 + ux * r + px * s).toFixed(2)} ${(10 + uy * r + py * s).toFixed(2)}`;
    d += `M10 10L${P(7.3, 0)}M${P(6.9, 1.9)}L${P(5.0, 0)}L${P(6.9, -1.9)}`;
  }
  return `<path d="${d}"/>`;
}
const SUN = '<circle cx="10" cy="10" r="3.3"/><path d="M10 2.4v1.9M10 15.7v1.9M2.4 10h1.9M15.7 10h1.9M4.6 4.6l1.35 1.35M14.05 14.05l1.35 1.35M4.6 15.4l1.35-1.35M14.05 5.95l1.35-1.35"/>';
const CLOUD_UP = '<path d="M6.3 12.6h8.2a3.1 3.1 0 0 0 .3-6.2 4.4 4.4 0 0 0-8.4 1.2 2.5 2.5 0 0 0-.1 5z"/>';
export const ICONS = {
  search: '<circle cx="8.8" cy="8.8" r="5.3"/><path d="M12.8 12.8 17 17"/>',
  lens: '<path d="M3.5 4.5h13l-5 6.2v4.9l-3 1.6v-6.5z"/>',
  help: '<circle cx="10" cy="10" r="7.4"/><path d="M7.9 7.9a2.2 2.2 0 1 1 3.1 2c-.6.3-1 .8-1 1.5v.4"/><circle cx="10" cy="14.1" r=".55" fill="currentColor"/>',
  refresh: '<path d="M16.2 9.6a6.2 6.2 0 1 1-1.9-4.3"/><path d="M15.6 2.8v3.4h-3.4"/>',
  sun: SUN,
  moon: '<path d="M15.8 12.6A6.6 6.6 0 0 1 7.4 4.2a6.6 6.6 0 1 0 8.4 8.4z"/>',
  sliders: '<path d="M3.5 6.5h13M3.5 13.5h13"/><circle cx="7.5" cy="6.5" r="1.9" fill="var(--paper)"/><circle cx="12.5" cy="13.5" r="1.9" fill="var(--paper)"/>',
  play: '<path d="M7.2 4.9v10.2l8-5.1z" fill="currentColor" stroke-width="1.2"/>',
  pause: '<path d="M7.3 5v10M12.7 5v10" stroke-width="2.3"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  'chev-r': '<path d="M8 5l5 5-5 5"/>', 'chev-l': '<path d="M12 5l-5 5 5 5"/>',
  'chev-d': '<path d="M5 8l5 5 5-5"/>', 'chev-u': '<path d="M5 12l5-5 5 5"/>',
  star: '<path d="M10 3.2l2 4.3 4.6.5-3.4 3.1 1 4.6L10 13.4l-4.2 2.3 1-4.6L3.4 8l4.6-.5z"/>',
  'star-fill': '<path d="M10 3.2l2 4.3 4.6.5-3.4 3.1 1 4.6L10 13.4l-4.2 2.3 1-4.6L3.4 8l4.6-.5z" fill="currentColor"/>',
  tour: '<circle cx="10" cy="10" r="7.4"/><path d="M8.5 7.1v5.8l4.6-2.9z" fill="currentColor" stroke-width="1.1"/>',
  spring: '<path d="M10 17.2V9.8"/><path d="M10 11.4C10 8 7.6 6 4 6c0 3.4 2.4 5.4 6 5.4z"/><path d="M10 9.6c0-2.9 2.1-4.8 5.6-4.8 0 2.9-2.1 4.8-5.6 4.8z"/><path d="M6.4 17.2h7.2"/>',
  summer: SUN,
  autumn: '<path d="M10 2.6l1.3 2.9 2.3-1.2-.4 3.4 2.9-.8-1.1 2.5 2.4 1-3.4 1.6.7 1.6-3.7-.6.3 2.7h-2.6l.3-2.7-3.7.6.7-1.6-3.4-1.6 2.4-1-1.1-2.5 2.9.8-.4-3.4 2.3 1.2z"/><path d="M10 15.7v2.4"/>',
  winter: snowflake(),
  wind: '<path d="M3 7.5h8.6a2.4 2.4 0 1 0-2.4-2.4"/><path d="M3 11h11.6a2.6 2.6 0 1 1-2.6 2.6"/><path d="M3 14.5h4.6"/>',
  cloud: '<path d="M6.2 15.2h8.3a3.3 3.3 0 0 0 .4-6.6 4.6 4.6 0 0 0-8.8 1.3 2.7 2.7 0 0 0 .1 5.3z"/>',
  rain: CLOUD_UP + '<path d="M7.4 15.2l-.9 2M10.6 15.2l-.9 2M13.8 15.2l-.9 2"/>',
  storm: CLOUD_UP + '<path d="M10.9 13.6 9.3 16h2.3l-1.5 2.4"/>',
  front: '<path d="M2.5 14.6c3.4-4.6 11.6-4.6 15 0"/><path d="M5.2 11.7l.4-2.9 2.3 1.6z" fill="currentColor" stroke-width="1"/><path d="M11.4 9.6a1.5 1.5 0 0 1 2.9.9" />',
  thermo: '<path d="M8.4 11.6V4.4a1.6 1.6 0 0 1 3.2 0v7.2a3.2 3.2 0 1 1-3.2 0z"/><path d="M10 7.6v6"/>',
  crowd: '<circle cx="7" cy="7" r="2.3"/><circle cx="13.4" cy="7.6" r="1.9"/><path d="M2.8 16c.5-2.9 2.2-4.4 4.2-4.4s3.7 1.5 4.2 4.4M11.8 11.9c.5-.3 1-.4 1.6-.4 1.7 0 3.2 1.3 3.7 3.9"/>',
  pulse: '<path d="M2.5 10.5h3.2l1.8-4.6 3 9 2-5.4h5"/>',
  percent: '<path d="M15 5 5 15"/><circle cx="6.4" cy="6.4" r="1.9"/><circle cx="13.6" cy="13.6" r="1.9"/>',
  dollar: '<path d="M10 3v14"/><path d="M13.4 6.6c-.6-1-1.8-1.6-3.4-1.6-2 0-3.4 1-3.4 2.5 0 3.6 7 1.8 7 5.3 0 1.6-1.5 2.6-3.6 2.6-1.7 0-3-.7-3.6-1.8"/>',
  since: '<path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4.4 3v3.3h3.3"/><path d="M10 6.8V10l2.2 1.5"/>',
  'arrow-up': '<path d="M10 16V4.5M5.5 9 10 4.5 14.5 9"/>',
  'arrow-down': '<path d="M10 4v11.5M5.5 11 10 15.5 14.5 11"/>',
  'arrow-right': '<path d="M3.5 10h12M11 5.5l4.5 4.5-4.5 4.5"/>',
  channel: '<path d="M3 15.5C5.6 8.6 11 5.8 16.2 6.6"/><path d="M12.6 4.1l3.6 2.5-2.4 3.4"/>',
  radar: '<circle cx="10" cy="10" r="1.4" fill="currentColor"/><path d="M6.2 13.8a5.4 5.4 0 0 1 0-7.6M13.8 6.2a5.4 5.4 0 0 1 0 7.6M3.6 16.4a9 9 0 0 1 0-12.8M16.4 3.6a9 9 0 0 1 0 12.8"/>',
  map: '<path d="M3 5.2l4.6-1.6 4.8 1.6 4.6-1.6v11.2l-4.6 1.6-4.8-1.6L3 16.4z"/><path d="M7.6 3.6v11.2M12.4 5.2v11.2"/>',
  voice: '<path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9.5L6 16.5v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M6.5 8.2h7M6.5 10.8h4.5"/>',
  scenario: '<circle cx="10" cy="8.6" r="5.4"/><path d="M6 17h8M7.5 13.6 6.8 17M12.5 13.6l.7 3.4"/><path d="M7.9 7a2.6 2.6 0 0 1 2.1-1.2"/>',
  intel: '<path d="M3 11.2 5.4 4.6h9.2L17 11.2v4.4a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8z"/><path d="M3 11.2h4l1 2h4l1-2h4"/>',
  scout: '<circle cx="6" cy="13.2" r="3"/><circle cx="14" cy="13.2" r="3"/><path d="M8.9 12.6h2.2M3.4 11.6 5.2 5h2.6v6M16.6 11.6 14.8 5h-2.6v6"/>',
  web: '<circle cx="10" cy="10" r="2.1"/><circle cx="4" cy="5" r="1.5"/><circle cx="16" cy="5.2" r="1.5"/><circle cx="4.6" cy="15.6" r="1.5"/><circle cx="15.6" cy="15" r="1.5"/><path d="M5.2 6l3.2 2.6M14.8 6.2l-3.2 2.4M5.8 14.6l2.6-3M14.4 14l-2.8-2.6"/>',
  target: '<circle cx="10" cy="10" r="7.2"/><circle cx="10" cy="10" r="4"/><circle cx="10" cy="10" r="1" fill="currentColor"/>',
  heart: '<path d="M10 16.4S3.2 12.4 3.2 7.8A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6.8 1.5c0 4.6-6.8 8.6-6.8 8.6z"/>',
  more: '<circle cx="5" cy="10" r=".9" fill="currentColor"/><circle cx="10" cy="10" r=".9" fill="currentColor"/><circle cx="15" cy="10" r=".9" fill="currentColor"/>',
  layers: '<path d="M10 3.5 17 7.2l-7 3.7-7-3.7z"/><path d="M3 10.6l7 3.7 7-3.7M3 13.9l7 3.7 7-3.7"/>',
  check: '<path d="M4.5 10.5 8.2 14l7.3-8"/>',
  ext: '<path d="M8 4.5H5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-3"/><path d="M11 3.5h5.5V9M16.5 3.5 9.5 10.5"/>',
};
// feature ids → icon (so the top bar stays one consistent set even when a module passes an emoji)
const ICON_ALIASES = {
  scenario: 'scenario', whatif: 'scenario', '推演': 'scenario', '🔮': 'scenario',
  intel: 'intel', feed: 'intel', '投喂': 'intel', '📥': 'intel',
  scout: 'scout', '侦察': 'scout', '🔎': 'scout',
  heartbeat: 'pulse', heart: 'pulse', '💓': 'pulse', loop: 'pulse',
  guess: 'target', '🎯': 'target',
  web: 'web', graph: 'web', '🕸': 'web', '🕸️': 'web',
  clouds: 'cloud', polymarket: 'cloud', '☁️': 'cloud',
};
/** Icon name for a key/id/emoji, or null. */
export function iconName(x) {
  if (!x) return null;
  const s = String(x);
  if (ICONS[s]) return s;
  if (ICON_ALIASES[s]) return ICON_ALIASES[s];
  const low = s.toLowerCase();
  for (const k of Object.keys(ICON_ALIASES)) if (/^[a-z]+$/.test(k) && low.includes(k)) return ICON_ALIASES[k];
  return null;
}
/** <span class="ic"> with the inline SVG icon (or the text itself when it is not a known icon). */
export function icon(name, { size = 18, cls = '', title = null } = {}) {
  const key = typeof name === 'string' && name.trim().startsWith('<') ? null : iconName(name);
  const span = document.createElement('span');
  span.className = 'ic' + (cls ? ' ' + cls : '') + (key ? '' : ' ic-text');
  if (title) span.title = title;
  const raw = typeof name === 'string' ? name.trim() : '';
  if (key) {
    span.innerHTML = `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[key]}</svg>`;
  } else if (/^<svg[\s>]/i.test(raw) && !/<script|\son\w+=/i.test(raw)) {
    // a module's own SVG (same line style expected): sized like the rest of the set
    span.className = 'ic' + (cls ? ' ' + cls : '');
    span.innerHTML = raw;
    const svgEl = span.querySelector('svg');
    if (svgEl) { svgEl.setAttribute('width', size); svgEl.setAttribute('height', size); svgEl.setAttribute('aria-hidden', 'true'); }
  } else span.textContent = name == null ? '' : String(name);
  return span;
}

/** The brand mark: a cel-shaded planet with one wind-line (colours from CSS tokens). */
let logoN = 0;
export function logo(size = 22) {
  const id = 'lg' + (++logoN);
  const span = document.createElement('span');
  span.className = 'logo';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <defs><clipPath id="${id}"><circle cx="12" cy="12" r="8.4"/></clipPath></defs>
    <circle cx="12" cy="12" r="8.4" fill="var(--logo-a)"/>
    <g clip-path="url(#${id})"><path d="M2 2h20v20H2z M0.6 9.8a8.6 8.6 0 1 0 17.2 0a8.6 8.6 0 1 0-17.2 0z" fill="var(--logo-b)" fill-rule="evenodd"/></g>
    <circle cx="12" cy="12" r="8.4" fill="none" stroke="var(--ink)" stroke-width="1.3"/>
    <path d="M1.6 14.6c4.4-2.4 9.6-3 15.4-1.6" fill="none" stroke="var(--paper)" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M1.6 14.6c4.4-2.4 9.6-3 15.4-1.6" fill="none" stroke="var(--ink)" stroke-width="1.1" stroke-linecap="round"/>
    <circle cx="17.6" cy="13.1" r="1.25" fill="var(--ink)"/></svg>`;
  return span;
}

/** Circled number glyph for the attention budget (①②③) as a styled element. */
export const numBadge = (n, cls = '') => {
  const s = document.createElement('span');
  s.className = 'num' + (cls ? ' ' + cls : '');
  s.textContent = String(n);
  s.setAttribute('aria-label', `第 ${n}`);
  return s;
};

/** A words.describe line as plain text without its leading OS emoji (§17: emoji never carries the reading). */
const EMOJI_LEAD = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\u2190-\u21ff\u2600-\u27bf\u2b00-\u2bff][\ufe0f\u200d\p{Extended_Pictographic}]*\s*)+/u;
export function plainLine(l) {
  const t = typeof l === 'string' ? l : (l && (l.text || [l.label, l.value].filter(Boolean).join(' '))) || '';
  return t.replace(EMOJI_LEAD, '').trim();
}

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);

/** Read/write localStorage safely (private windows can throw). */
export const store = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

/** Weather snapshot of one SERIES at day i (same shape as tree.json `now`). */
export function nowAt(series, i, fallback = null) {
  if (!series || !series.wind) return fallback;
  const n = series.wind.length;
  i = clamp(i, 0, n - 1);
  const g = (k) => (series[k] ? series[k][i] : null);
  const idx = series.idx || [];
  const ret = (k) => (idx[i] != null && idx[i - k] ? idx[i] / idx[i - k] - 1 : null);
  const win = (arr, k) => (arr ? arr.slice(Math.max(0, i - k + 1), i + 1) : []);
  const fl5 = win(series.flow, 5), dv20 = win(series.dv, 20);
  // wind5 / dw: words.describe / take / season need the 5-day wind change (春, a fast 秋), the same as words.nowAt
  const wind = g('wind'), wind5 = series.wind[Math.max(0, i - 5)];
  return {
    wind, wind5: wind5 ?? null, dw: wind != null && wind5 != null ? Math.round((wind - wind5) * 100) / 100 : null,
    temp: g('temp'), pres: g('pres'), storm: g('storm'), front: g('front'),
    ret1: ret(1), ret5: ret(5), ret20: ret(20),
    flow: g('flow'), dv: g('dv'),
    flow5: fl5.length ? +sum(fl5).toFixed(1) : null,
    dv20: dv20.length ? +(sum(dv20) / dv20.length).toFixed(1) : null,
    // DESIGN §8 amendment: words.describe/take need to know whether the node is falling hard (null = no)
    crash: crashAt(series, i),
    // §23 amendment: the series' own real money (curated maps carry realFlow[] / realEst[]) → describe / take say it
    real: realOfSeries ? realOfSeries(series, i) : null,
  };
}
