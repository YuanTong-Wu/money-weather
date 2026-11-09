/* 钱的天气 · web.js — 关系网 (DESIGN.md §13 · §14 · §17 · §19)
 *
 * Click a company → who it is tied to, and which way the money runs.
 * Radial ego graph: focus in the centre; upstream suppliers (it pays them) on the LEFT, customers (they
 * pay it) on the RIGHT, competitors on TOP, partners / investments at the BOTTOM. ≤ 14 nodes by default,
 * "展开" per side on demand; click a node → smooth re-centre. Same grammar as the planet: colour =
 * temperature, particles = money moving (they run payer → payee), ring = today's wind, glyph = season.
 * Dashed = measured co-movement / lead-lag (no opinion) or an estimate (估). Private companies are hollow.
 *
 * Feature module (§19): `init(app)` sets `app.openWeb(ticker)` / `app.closeWeb()`; touches only its own DOM
 * (#mw-web) and css/web.css. Data: data/graph/index.json + data/graph/<T>.json (graph/build.py), the merged
 * edges.json loads in the background (second-degree ties); web/fixture-graph/ only if no graph was ever built.
 * A company nobody has researched still gets a picture (§14): its sector neighbours as estimated ties +
 * measured co-movement. Every id that leaves this file is canonical (GOOGL, p:openai — never 'GOOGLE').
 * 为什么？ per edge → app.why({kind:'edge', ids:[payer, payee]}) (ui/why.js). 侦察兵 asks show their queue
 * and answer in place; a finished gap job re-reads the company file so the new tie appears (marked 新 / 估).
 */

// the reason card / scout answer look is shared with the stock view (one style for 为什么, §21)
import { scoutAnswerEl, whyWaitEl, askWhy, hasAppWhy, openAppWhy, scoutCards, newScoutCard } from './stock.js';

const NS = 'http://www.w3.org/2000/svg';
const FIXTURE_BASE = new URL('../fixture-graph/', import.meta.url).href;
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_NEIGHBOURS = 13;                 // + the focus = 14 nodes
const ZONE_CAP = { left: 6, right: 6, top: 3, bottom: 3 };   // most a side shows before "展开"
const ZONE_MIN = { left: 3, right: 3, top: 2, bottom: 2 };   // seats each side is guaranteed
const EXPAND_STEP = 6;
const FOCUS_R = 31;
const TWEEN_MS = 680;

const REL = {
  'buys-from': '采购', 'sells-to': '供货', partner: '合作', 'invests-in': '投资', competes: '竞争',
  licenses: '授权', finances: '出资', comove: '同涨同跌', leadlag: '先动后动',
};
const PER = { year: '每年', once: '一次性', total: '累计', contract: '合同', deal: '交易', commitment: '承诺', stake: '持股', framework: '框架', quarter: '每季' };
const ZONES = {
  left:   { name: '上游', sub: '它掏钱买谁的', ang: 180, span: 52 },
  right:  { name: '下游', sub: '谁掏钱给它',   ang: 0,   span: 52 },
  top:    { name: '对手', sub: '抢同一碗饭',   ang: -90 },
  bottom: { name: '伙伴 · 投资', sub: '一起干活 / 钱投给谁', ang: 90 },
};
const SEASONS = {
  spring: { name: '春', now: '钱刚开始进来，还不挤', next: '可能进入夏天' },
  summer: { name: '夏', now: '正热、人多', next: '小心入秋' },
  autumn: { name: '秋', now: '钱从拥挤处撤离', next: '可能入冬' },
  winter: { name: '冬', now: '冷清没人管', next: '等春天' },
};
// temperature ramp (§17): 藍 → 浅葱 → 生成り → 山吹 → 柿 → 朱
// (when the shell's --t0…--t8 tokens exist, syncTheme() swaps them in so planet, stock view and web agree)
const RAMP0 = [[-3, '#2b4878'], [-1.7, '#4b8b9f'], [-0.6, '#a9cbc2'], [0, '#ebe1c8'], [0.6, '#efc97f'],
  [1.5, '#e0973f'], [2.3, '#cd673b'], [3, '#b0402e']];
let RAMP = RAMP0;

// ───────────────────────────────────────────────────────────── small helpers
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const isPriv = (id) => String(id).startsWith('p:');
const fname = (id) => String(id).replace(/:/g, '_') + '.json';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (r) => '#' + r.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, k) => lerp(v, y[k], t))); };
const lum = (h) => { const [r, g, b] = hexRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

function tempColor(t) {
  if (!isNum(t)) return null;
  t = clamp(t, -3, 3);
  for (let k = 1; k < RAMP.length; k++) {
    if (t <= RAMP[k][0]) {
      const [t0, c0] = RAMP[k - 1], [t1, c1] = RAMP[k];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** usd billions → "232亿" / "7500万" / "1.2万亿" */
function yi(usdB) {
  if (!isNum(usdB)) return '';
  const v = usdB * 10;
  if (v >= 10000) return +(v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万亿';
  if (v >= 1) return (v >= 100 ? Math.round(v) : +v.toFixed(1)) + '亿';
  return Math.round(usdB * 1e5) + '万';
}
const perShort = (per) => (per === 'year' ? '/年' : per === 'quarter' ? '/季' : per === 'month' ? '/月' : '');
const perLong = (per) => (per == null ? '' : PER[per] ?? String(per));

// ───────────────────────────────────────────────────────────── money is only comparable per year (§13)
// A 20-year lease total or a one-off acquisition must never be drawn as if it were yearly money, nor be added
// to yearly flows. Every tie's money becomes ONE of:
//   rec  — recurring: year ×1, quarter ×4, month ×12                         → counts in the band, as /年
//   term — a multi-year total (total / contract / commitment / framework):   → ÷ its term in years when the
//          text gives one (「20 年租约」「分 4–5 年」「2026H2–2029」「购电至 2042 年」), else ÷ 5 (= graph/build.py _size)
//   one  — one-off (once / deal / stake, an acquisition or an equity stake written as a total) → never in the
//          band: a dashed tick on the line + its own label; ranks at a fifth of its size (build.py _size)
const RECUR_K = { year: 1, quarter: 4, month: 12 };
const TERM_PER = new Set(['total', 'contract', 'commitment', 'framework']);
const ONE_PER = new Set(['once', 'deal', 'stake']);
const ONE_RX = /收购|买下|并购|入股|首付|领投|跟投|认购|定增|增资|赔偿|和解|买断|一次性/;
const TERM_DEFAULT = 5;
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnInt(s) {
  if (!s) return null;
  if (s === '十') return 10;
  const m = /^([一两二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  return s.length === 1 && CN_NUM[s] ? CN_NUM[s] : null;
}
const yearOf = (x) => { const m = /(19|20)\d\d/.exec(String(x ?? '')); return m ? +m[0] : null; };
/** the term (years) a contract total runs, read from its own words — null when the text does not say */
function termYears(text, refYear) {
  const s = String(text || '');
  if (!s) return null;
  let m;
  // 「分 4–5 年」「3-5 年」
  if ((m = /(?<![\d.])(\d{1,2})\s*[–—\-~～至到]\s*(\d{1,2})\s*(?:个)?年(?![代底初末中级前])/.exec(s))) {
    const a = +m[1], b = +m[2];
    if (a >= 1 && b >= a && b <= 99) return (a + b) / 2;
  }
  // 「20 年租约」「约 15 年」「10 年」（four-digit years like 「2023 年」 never match）
  if ((m = /(?<![\d.]|\d\s*[–—\-~～/]\s*)(\d{1,2}(?:\.\d+)?)\s*(?:个)?年(?![代底初末中级前])/.exec(s)) && +m[1] >= 1 && +m[1] <= 99) return +m[1];
  // 「五年约 600 亿」「二十年」
  if ((m = /(?<![今明去前后每当同半上下第几多])((?:[一两二三四五六七八九]?十[一二三四五六七八九]?)|[一两二三四五六七八九])\s*(?:个)?年(?![代底初末中级前])/.exec(s))) {
    const n = cnInt(m[1]);
    if (n && n >= 1 && n <= 99) return n;
  }
  // 「18 个月」
  if ((m = /(?<![\d.])(\d{1,3})\s*个月/.exec(s)) && +m[1] >= 1) return Math.max(1, +m[1] / 12);
  // 「2026H2–2029」「2026–2030 年」
  if ((m = /(20\d\d)\s*年?\s*(H[12]|Q[1-4]|上半年|下半年)?\s*[–—\-~～至到]\s*(20\d\d)/.exec(s))) {
    const a = +m[1] + (m[2] === 'H2' || m[2] === '下半年' ? 0.5 : /^Q/.test(m[2] || '') ? (+m[2].slice(1) - 1) / 4 : 0);
    const b = +m[3] + 1;
    if (b - a >= 1 && b - a <= 99) return b - a;
  }
  // 「购电至 2042 年」「到 2035」（「截至」= as of, not an end date）
  if ((m = /(?<!截)(?:至|到|直到)\s*(20\d\d)/.exec(s)) && refYear) {
    const n = +m[1] - refYear;
    if (n >= 1 && n <= 99) return n;
  }
  return null;
}
/** a tie's money, made comparable: {kind:'rec'|'term'|'one', usdB (as written), yearB (per year; 0 for one-offs),
 *  years (term; null when assumed), assumed (true when the ÷5 default was used), per, tag (one-off word)} | null */
function moneyOf(e) {
  const m = e && e.money;
  if (!m || !isNum(m.usdB) || m.usdB <= 0) return null;
  const per = m.per ?? null;
  const usdB = m.usdB;
  if (RECUR_K[per]) return { kind: 'rec', usdB, yearB: usdB * RECUR_K[per], per };
  const what = `${m.what || ''}`;
  const finTag = () => (/兜底/.test(what) || (/担保/.test(what) && !/贷款/.test(what)) ? '担保' : /贷款|债|授信/.test(what) ? '贷款' : '出资');
  const oneTag = () => (per === 'stake' ? '持股' : e.type === 'invests-in' ? '投资' : e.type === 'finances' ? finTag() : per === 'deal' ? '交易' : '一次性');
  const one = (tag = oneTag()) => ({ kind: 'one', usdB, yearB: 0, per, tag });
  // a loan book / holding written as a total is a stock of money, not a yearly flow
  if (/存量/.test(what)) return one('存量');
  // equity bought, a loan or a guarantee given: money (or a promise) that moves once, not every year
  if (ONE_PER.has(per) || e.type === 'invests-in' || e.type === 'finances') return one();
  const ref = yearOf(e.since) || yearOf(m.asOf || e.asOf) || 2026;
  const years = termYears(what, ref) || termYears(m.basis || e.basis, ref);
  // a total that is really a single payment: an acquisition, an upfront fee, a settlement
  if ((per === 'total' || per == null) && !years && ONE_RX.test(what)) return one();
  if (TERM_PER.has(per) || per == null) {
    const y = years || TERM_DEFAULT;
    return { kind: 'term', usdB, yearB: usdB / y, years: years || null, assumed: !years, per };
  }
  return one();                                             // anything else we cannot read as a rhythm
}
/** comparable size for ranking: money per year; a one-off counts a fifth (same as graph/build.py _size) */
const sizeOf = (mk) => (!mk ? null : mk.kind === 'one' ? mk.usdB / TERM_DEFAULT : mk.yearB);
const fmtYears = (y) => (Number.isInteger(y) ? String(y) : (+y.toFixed(1)).toString());
/** one tie's own number with its own unit, never mixed with another: 「8亿/年」「190亿/20年」「21亿 一次性」 */
function amtShort(mk, unit = '') {
  if (!mk) return '';
  const v = yi(mk.usdB) + unit;
  if (mk.kind === 'rec') return `${v}${perShort(mk.per)}`;
  if (mk.kind === 'term') return mk.years ? `${v}/${fmtYears(mk.years)}年` : `${v}${mk.per && PER[mk.per] ? '（' + PER[mk.per] + '）' : ''}`;
  return `${v}（${mk.tag}）`;
}
/** the yearly figure of a flow (Σ of its yearly + annualised ties): 「8亿/年」, or 「年均 9.5亿」 when part of it is
 *  a contract spread over its term */
const yearText = (f) => (f.term ? `年均${yi(f.yearB)}` : `${yi(f.yearB)}/年`);

/** rough rendered width (px) of a label: CJK ≈ 1em, latin ≈ .56em */
function textW(str, px) {
  let w = 0;
  for (const ch of String(str ?? '')) w += /[\u2E80-\uFFFF]/.test(ch) ? px : px * 0.56;
  return w;
}
/** map labels stay short: drop parentheticals, then cut with … (the full name lives in the hover card) */
function shortName(str, maxPx = 120, px = 13) {
  let s = String(str ?? '').replace(/\s*[（(][^）)]*[）)]\s*/g, ' ').trim() || String(str ?? '');
  const m = s.match(/^([\u2E80-\u9FFF\uF900-\uFFEF·]+)\s+[A-Za-z]/);
  if (m) s = m[1];
  if (textW(s, px) <= maxPx) return s;
  let out = '';
  for (const ch of s) { if (textW(out + ch + '…', px) > maxPx) break; out += ch; }
  return out.trim() + '…';
}

function sentences(take) {
  if (!take) return [];
  if (Array.isArray(take)) return take.filter(Boolean).map(String);
  return String(take).split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
}

function svg(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function h(tag, cls, html, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

// cubic bézier
function bz(g, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * g[0] + b * g[2] + c * g[4] + d * g[6], a * g[1] + b * g[3] + c * g[5] + d * g[7]];
}
function bzTan(g, t) {
  const u = 1 - t;
  const x = 3 * u * u * (g[2] - g[0]) + 6 * u * t * (g[4] - g[2]) + 3 * t * t * (g[6] - g[4]);
  const y = 3 * u * u * (g[3] - g[1]) + 6 * u * t * (g[5] - g[3]) + 3 * t * t * (g[7] - g[5]);
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
/** arc-length table so particles move at an even speed */
function lut(g, n = 28) {
  const L = [0];
  let [px, py] = bz(g, 0), s = 0;
  for (let k = 1; k <= n; k++) {
    const [x, y] = bz(g, k / n);
    s += Math.hypot(x - px, y - py); L.push(s); px = x; py = y;
  }
  return { L, len: s, n };
}
function tAt(T, u) {           // u = 0..1 of arc length → bézier t
  const s = clamp(u, 0, 1) * T.len, L = T.L;
  let lo = 0, hi = T.n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m] < s) lo = m; else hi = m; }
  const seg = L[hi] - L[lo] || 1;
  return (lo + (s - L[lo]) / seg) / T.n;
}
const gPath = (g) => `M${g[0].toFixed(1)},${g[1].toFixed(1)} C${g[2].toFixed(1)},${g[3].toFixed(1)} ${g[4].toFixed(1)},${g[5].toFixed(1)} ${g[6].toFixed(1)},${g[7].toFixed(1)}`;
const squircle = (th, e = 2.7) => {
  const c = Math.cos(th), s = Math.sin(th);
  return [Math.sign(c) * Math.abs(c) ** (2 / e), Math.sign(s) * Math.abs(s) ** (2 / e)];
};

// statistics for the in-browser measured ties (only used when the graph file carries none)
function rets(c, n) {
  if (!Array.isArray(c) || c.length < n + 1) return null;
  const x = c.slice(-n - 1), r = [];
  for (let k = 1; k < x.length; k++) r.push(x[k - 1] ? x[k] / x[k - 1] - 1 : 0);
  return r;
}
function corr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 30) return null;
  x = x.slice(-n); y = y.slice(-n);
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += x[k]; my += y[k]; }
  mx /= n; my /= n;
  let sxy = 0, sx = 0, sy = 0;
  for (let k = 0; k < n; k++) { const a = x[k] - mx, b = y[k] - my; sxy += a * b; sx += a * a; sy += b * b; }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : null;
}

// ───────────────────────────────────────────────────────────── icons (one hand-drawn-but-precise set, §17)
const ICONS = `
<symbol id="wb-i-spring" viewBox="0 0 16 16"><path d="M8 14.4V8.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7.9 9.3C7.9 6.5 6 4.7 2.9 4.8 2.9 7.7 4.9 9.4 7.9 9.3Z" fill="currentColor"/><path d="M8.1 7.9C8.1 5 10 3.1 13.2 3.2 13.2 6.1 11.2 8 8.1 7.9Z" fill="currentColor"/></symbol>
<symbol id="wb-i-summer" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><path d="M8 1.5v1.9M8 12.6v1.9M1.5 8h1.9M12.6 8h1.9M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
<symbol id="wb-i-autumn" viewBox="0 0 16 16"><path d="M8 1.4 9.3 4.5 11.8 3.4 11.2 6.5 14.5 6.1 12.6 8.6 13.9 9.6 10.4 10.7 10.8 12.2 8.6 11.3V14.6H7.4V11.3L5.2 12.2 5.6 10.7 2.1 9.6 3.4 8.6 1.5 6.1 4.8 6.5 4.2 3.4 6.7 4.5Z" fill="currentColor" stroke="currentColor" stroke-width=".5" stroke-linejoin="round"/></symbol>
<symbol id="wb-i-winter" viewBox="0 0 16 16"><path d="M8 1.6v12.8M2.5 4.8l11 6.4M2.5 11.2l11-6.4M6.3 2.6 8 4.2l1.7-1.6M6.3 13.4 8 11.8l1.7 1.6M2.2 7.1l2.2.7-.5 2.3M13.8 7.1l-2.2.7.5 2.3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="wb-i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.4 10.4 3.6 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="wb-i-back" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="wb-i-close" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
<symbol id="wb-i-web" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.3" fill="currentColor"/><circle cx="2.6" cy="4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="13.4" cy="4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="14" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 4.8 6.2 6.8M12 4.8 9.8 6.8M8 10.3v2.2" stroke="currentColor" stroke-width="1.2"/></symbol>
<symbol id="wb-i-planet" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" opacity=".35"/></symbol>`;
const icon = (name, cls = '') => `<svg class="wb-ico ${cls}" viewBox="0 0 16 16" aria-hidden="true"><use href="#wb-i-${name}"/></svg>`;

// ───────────────────────────────────────────────────────────── module entry (§19)
let singleton = null;

export function init(app) {
  if (!app) return null;
  if (!singleton || singleton.app !== app) singleton = createWeb(app);
  const web = singleton;
  // the shell routes app.openWeb(t) to whoever app.provide()s it; without that hook, set it directly
  if (typeof app.provide === 'function') app.provide('openWeb', (t, opts) => web.open(t, opts));
  else app.openWeb = (t, opts) => web.open(t, opts);
  app.closeWeb = () => web.close();
  app.resolveCompany = (t) => web.resolve(t);     // 'GOOGLE' / 'Ginkgo Bioworks (DNA)' → 'GOOGL' / 'DNA'
  app.on?.('theme', () => web.syncTheme());
  app.on?.('date', () => web.onDate());
  app.on?.('voice', () => web.onDate());
  // only what the web reads: graph files, stock weather, the tree (names / sizes)
  const touches = (x) => { const parts = x?.parts; return !parts || [].concat(parts).some((q) => /graph|stocks|tree|meta|overrides/.test(String(q))); };
  app.on?.('dataReloaded', (x) => { if (touches(x)) web.reload(); });
  return web;
}
export default init;
/** Same as app.openWeb(ticker) — the shell may call it directly as the module's provider. */
export function openWeb(ticker, opts) {
  if (!singleton && globalThis.__mw) init(globalThis.__mw);
  return singleton ? singleton.open(ticker, opts) : null;
}

// ───────────────────────────────────────────────────────────── the view
function createWeb(app) {
  const S = {
    open: false, focus: null, hist: [], doc: null, model: null, layout: null,
    nodes: new Map(),          // id → node view {id, x, y, r, a, el…}
    edges: new Map(),          // other id → edge view
    expanded: { left: 0, right: 0, top: 0, bottom: 0 },
    hot: null, pinned: null, tip: null,
    W: 0, H: 0, dpr: 1, raf: 0, last: 0, tween: null, theme: 'day',
    stocks: new Map(), stockP: new Map(), docs: new Map(), srcP: null, src: null,
    colors: {}, seq: 0, pausedPlanet: false, overrides: loadLocalOverrides(), shared: [],
  };
  const E = {};   // DOM

  const D = () => app.data || app.D || {};
  const W = () => app.words || app.W || {};
  const toast = (s, ms) => (app.toast ? app.toast(s, ms) : console.info('[web]', s));
  const sayOf = (obj, key = 'say') => {
    if (!obj) return '';
    if (typeof app.say === 'function') { try { const v = app.say(obj, key); if (v) return v; } catch { /* fall through */ } }
    return obj[key] || '';
  };

  // ─────────── data
  const dataRoot = () => {
    const d = D();
    const r = d.root || (typeof d.dataBase === 'function' ? d.dataBase() : null) || 'data/';
    return String(r).replace(/\/?$/, '/');
  };
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  function normAll(raw) {
    const all = Array.isArray(raw) ? { edges: raw } : (raw || {});
    const nodes = new Map();
    const addNodes = (o) => {
      if (!o) return;
      if (Array.isArray(o)) { for (const n of o) if (n && (n.id || n.t)) nodes.set(n.id || n.t, { ...n }); }
      else for (const k in o) nodes.set(k, { id: k, ...(o[k] || {}) });
    };
    addNodes(all.nodes); addNodes(all.privateNodes);
    const companies = new Map();
    const cs = all.companies;
    if (Array.isArray(cs)) for (const c of cs) { if (c && c.t) companies.set(c.t, c); }
    else if (cs) for (const k in cs) companies.set(k, { t: k, ...cs[k] });
    const edges = [], measured = [];
    for (const e of all.edges || []) (e && (e.type === 'comove' || e.type === 'leadlag') ? measured : edges).push(e);
    for (const k of ['measured', 'comove', 'leadlag']) for (const e of all[k] || []) measured.push(k === 'measured' ? e : { type: k, ...e });
    const adj = new Map();
    const put = (id, e) => { if (!adj.has(id)) adj.set(id, []); adj.get(id).push(e); };
    for (const e of edges) { if (e && e.a && e.b) { put(e.a, e); put(e.b, e); } }
    const madj = new Map();
    for (const m of measured.map(normMeasured).filter(Boolean)) {
      for (const id of [m.a, m.b]) { if (!madj.has(id)) madj.set(id, []); madj.get(id).push(m); }
    }
    return { nodes, companies, edges, adj, madj, asOf: all.asOf || null };
  }

  function normMeasured(m) {
    if (!m) return null;
    if (m.type === 'leadlag') {
      const lead = m.lead || m.a, lag = m.lag || m.follow || m.b;
      if (!lead || !lag) return null;
      return { ...m, type: 'leadlag', a: lead, b: lag, lead, lag, days: m.days ?? m.lagDays ?? m.k ?? null, corr: m.corr ?? m.r ?? null };
    }
    if (!m.a || !m.b) return null;
    return { ...m, type: 'comove', corr: m.corr ?? m.r ?? m.rho ?? null };
  }

  /** Where the company web lives: data/graph/ (graph/build.py: index.json + one file per company +
   *  edges.json) — the fixture only when no graph was ever built. index.json (≈ 0.3 MB) is enough to draw any
   *  company at once; the merged edges.json (≈ 3.6 MB, second-degree ties + names) follows in the background. */
  function graphSource() {
    if (S.srcP) return S.srcP;
    S.srcP = (async () => {
      const bases = ['data/graph/'];
      const r0 = dataRoot();
      if (r0 !== 'data/' && /^[\w./-]+$/.test(r0) && !/fm\/$/.test(r0)) bases.unshift(r0 + 'graph/');   // dev ?data= override
      for (const b of bases) {
        const parent = b.replace(/graph\/$/, '');
        let listed = null;                       // ask the folder listing first: no 404 noise before build.py ran
        if (typeof D().listDir === 'function') {
          const names = await D().listDir(parent).catch(() => null);
          if (names) listed = names.has('graph/');
        } else {
          try {
            const r = await fetch(parent, { cache: 'no-cache' });
            const txt = r.ok && /text\/html/.test(r.headers.get('content-type') || '') ? await r.text() : '';
            if (/Directory listing/i.test(txt)) listed = /href="graph\/"/.test(txt);
          } catch { listed = null; }
        }
        if (listed === false) continue;
        const idx = await getJSON(b + 'index.json').catch(() => null);
        if (idx && Array.isArray(idx.companies) && idx.companies.length) {
          const s = { base: b, kind: 'data', index: idx, all: normAll({ nodes: indexNodes(idx), companies: idx.companies, asOf: idx.asOf }), files: indexFiles(idx) };
          s.genAt = idx.generatedAt || null;
          return s;
        }
        // an older build without index.json: the merged file, or whatever per-company files the listing shows
        const names = typeof D().listDir === 'function' ? await D().listDir(b).catch(() => null) : null;
        if (names && !names.has('edges.json')) {
          const files = new Set([...names].filter((n) => /\.json$/.test(n)));
          if (files.size) return { base: b, kind: 'data', all: normAll(null), files };
          continue;
        }
        try { const all = normAll(await getJSON(b + 'edges.json')); return { base: b, kind: 'data', all, edgesLoaded: true }; } catch { /* next */ }
      }
      try { return { base: FIXTURE_BASE, kind: 'fixture', all: normAll(await getJSON(FIXTURE_BASE + 'edges.json')), edgesLoaded: true }; } catch { /* none */ }
      return { base: null, kind: 'none', all: normAll(null), edgesLoaded: true };
    })().then(async (s) => { s.shared = await loadSharedOverrides(); S.src = s; S.resolver = null; return s; });
    return S.srcP;
  }
  function indexNodes(idx) {
    const out = {};
    for (const c of idx.companies || []) {
      if (!c || !c.t) continue;
      out[c.t] = { name: c.name, private: !!c.private, listed: c.listed, researched: !!c.researched, inUniverse: !!c.inUniverse, n: c.n || 0 };
    }
    return out;
  }
  const indexFiles = (idx) => new Set((idx.companies || []).filter((c) => c && c.t).map((c) => fname(c.t)));
  /** the merged edges.json, after the first picture: second-degree ties on hover + every node's name */
  function loadEdgesBg() {
    const src = S.src;
    if (!src || src.edgesLoaded || src.edgesP || !src.base) return;
    src.edgesP = new Promise((res) => setTimeout(res, REDUCED ? 0 : 1200))
      .then(() => getJSON(src.base + 'edges.json'))
      .then((raw) => {
        if (S.src !== src) return;
        const all = normAll(raw);
        for (const [k, v] of all.nodes) src.all.nodes.set(k, { ...v, ...(src.all.nodes.get(k) || {}) });
        src.all.adj = all.adj; src.all.madj = all.madj; src.all.edges = all.edges;
        for (const [k, v] of all.companies) if (!src.all.companies.has(k)) src.all.companies.set(k, v);
        src.edgesLoaded = true;
        S.resolver = null;
      })
      .catch(() => { src.edgesLoaded = true; });
  }

  function loadDoc(id) {
    if (S.docs.has(id)) return S.docs.get(id);
    const p = (async () => {
      const src = await graphSource();
      const inAll = src.all.adj.has(id) || src.all.madj.has(id);
      let raw = null;
      const hasFile = src.files ? src.files.has(fname(id)) : src.all.adj.has(id);
      if (src.base && hasFile) { try { raw = await getJSON(src.base + fname(id)); } catch { raw = null; } }
      if (!raw && inAll) {
        raw = { t: id, edges: src.all.adj.get(id) || [], measured: src.all.madj.get(id) || [] };
        const c = src.all.companies.get(id);
        if (c) Object.assign(raw, { take: c.take, asOf: c.asOf, name: c.name });
      }
      if (!raw) return synthDoc(id, src);
      const doc = normDoc(raw, id, src);
      if (doc.edges.length < 2 || (!doc.researched && doc.edges.length < 5)) {
        // §14 宁可估不可空: hardly any researched ties → the map neighbours fill in, marked 估
        const syn = await synthDoc(id, src);
        const have = new Set(doc.edges.map((e) => (e.a === id ? e.b : e.a)));
        doc.edges.push(...syn.edges.filter((e) => !have.has(e.b)));
        doc.synth = doc.edges.length > 0 && syn.edges.length > 0 && !doc.researched;
      }
      return doc;
    })().catch((e) => { S.docs.delete(id); throw e; });
    S.docs.set(id, p);
    return p;
  }

  function normDoc(raw, id, src) {
    const nodes = new Map(src.all.nodes);
    const one = normAll({ nodes: raw.nodes, privateNodes: raw.privateNodes });
    for (const [k, v] of one.nodes) nodes.set(k, { ...(nodes.get(k) || {}), ...v });
    const edges = [], measured = [];
    for (const e of raw.edges || []) (e && (e.type === 'comove' || e.type === 'leadlag') ? measured : edges).push(e);
    for (const k of ['measured', 'comove', 'leadlag']) for (const e of raw[k] || []) measured.push(k === 'measured' ? e : { type: k, ...e });
    const c = src.all.companies.get(id) || {};
    return {
      id, src: src.kind, nodes,
      name: raw.name || c.name || null, note: raw.note || null,
      take: sentences(raw.take ?? c.take), takeMild: sentences(raw.takeMild ?? c.takeMild), asOf: raw.asOf || c.asOf || src.all.asOf || null,
      researched: raw.researched ?? !!(raw.take || c.take), genAt: raw.generatedAt || null,
      edges: applyOverrides(edges.filter((e) => e && e.a && e.b && (e.a === id || e.b === id)), [...(src.shared || []), ...S.overrides])
        .map((e) => (S.freshSigs && S.freshSigs.has(edgeSig(e)) ? { ...e, _new: true } : e)),
      measured: measured.map(normMeasured).filter((m) => m && (m.a === id || m.b === id)),
      synth: false,
    };
  }

  /** §14: nobody has researched this company yet → its sector neighbours as estimated ties. */
  async function synthDoc(id, src) {
    const s = isPriv(id) ? null : await loadStock(id);
    const peers = (s?.peers || []).map((p) => String(p).replace(/^s:/, '')).filter((p) => p && p !== id).slice(0, 8);
    const edges = peers.map((p) => ({
      a: id, b: p, type: 'competes', money: null, share: null, strength: 1, conf: 0.3, est: true, inferred: true,
      basis: '按同板块推断：还没人研究过它的上下游，先拿地图上的邻居凑个样子',
      say: '同一块地上的邻居，抢的多半是同一拨钱。', source: '地图分区（板块邻居）', asOf: null,
    }));
    return {
      id, src: src.kind, nodes: new Map(src.all.nodes), name: null, note: null, take: [], asOf: null,
      researched: false, edges, measured: [], synth: true,
    };
  }

  function stockKnown(id) {
    if (!id || isPriv(id)) return false;
    const d = D();
    if (typeof d.nodeById === 'function') return !!d.nodeById('s:' + id);
    return !/\.[A-Z]{1,3}$/.test(id);
  }
  function loadStock(id) {
    if (S.stockP.has(id)) return S.stockP.get(id);
    let p;
    if (!stockKnown(id)) p = Promise.resolve(null);
    else {
      const d = D();
      p = (typeof d.loadStock === 'function' ? d.loadStock(id) : getJSON(dataRoot() + 'stocks/' + fname(id)))
        .catch(() => null);
    }
    p = p.then((j) => { S.stocks.set(id, j || null); return j || null; });
    S.stockP.set(id, p);
    return p;
  }

  // owner corrections (§14 "我来补"). The shared file is web/data/overrides.json — entries
  // {target:"edge:A>B", field:"money.usdB", value, source:"owner"|"scout"…}, written through POST /api/overrides
  // (pipeline/owner_overrides.py). Owner entries always win; anyone else only fills an estimated or missing
  // number. Without a server the correction is kept in this browser (localStorage) and still applied.
  function loadLocalOverrides() {
    try { const v = JSON.parse(localStorage.getItem('mw.web.overrides') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function saveLocalOverrides() { try { localStorage.setItem('mw.web.overrides', JSON.stringify(S.overrides)); } catch { /* private mode */ } }
  async function loadSharedOverrides() {
    const d = D();
    try {
      if (typeof d.listDir === 'function') { const names = await d.listDir('data/'); if (names && !names.has('overrides.json')) return []; }
      const raw = await getJSON('data/overrides.json');
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.overrides) ? raw.overrides : [];
      return list.filter((o) => o && /^edge:/.test(String(o.target)) && o.field);
    } catch { return []; }
  }
  const edgeKey = (e) => `edge:${e.a}>${e.b}`;
  const MONEY_FIELDS = new Set(['money.usdB', 'usdB', 'money']);
  /** newest entry per target wins; an owner's beats anyone else's; each lands on ONE edge of the pair
   *  (exact a>b first, the estimated one first) so a correction never leaks onto a sibling tie */
  function applyOverrides(edges, list) {
    const by = new Map();
    for (const x of list || []) {
      if (!x || !MONEY_FIELDS.has(x.field) || !/^edge:/.test(String(x.target))) continue;
      const owner = !x.source || x.source === 'owner' || x.local;
      const cur = by.get(x.target);
      if (!cur || (owner && !cur.owner) || (owner === cur.owner && String(x.at || '') >= String(cur.x.at || ''))) by.set(x.target, { x, owner });
    }
    if (!by.size) return edges;
    const out = edges.slice();
    for (const [target, { x, owner }] of by) {
      const m = /^edge:(.+?)>(.+)$/.exec(target);
      if (!m) continue;
      let idx = -1;
      for (const [a, b] of [[m[1], m[2]], [m[2], m[1]]]) {
        const hits = out.map((e, k) => [e, k]).filter(([e]) => e.a === a && e.b === b && (!x.type || x.type === e.type) && e.type !== 'competes');
        const best = hits.find(([e]) => isEst(e)) || hits.find(([e]) => e.money) || hits[0];
        if (best) { idx = best[1]; break; }
      }
      if (idx < 0) continue;
      const e = out[idx];
      if (!owner && !(isEst(e) || !isNum(e.money?.usdB))) continue;     // scout / loop only fill estimates
      const v = typeof x.value === 'object' && x.value ? x.value.usdB : x.value;
      if (!isNum(+v)) continue;
      const [from, to] = payerPayee(e);
      const who = owner ? '你补的' : x.source === 'scout' ? '侦察兵查到的' : '修正';
      const money = { ...(e.money || {}), from: e.money?.from || from, to: e.money?.to || to, usdB: +v, est: false, source: `${who}：${x.note || '（没写出处）'}` };
      delete money.usdBLow; delete money.usdBHigh;
      out[idx] = { ...e, money, est: false, inferred: false, basis: null, owner, fixedBy: who, fixKey: target, conf: Math.max(e.conf || 0, 0.9) };
    }
    return out;
  }

  // ─────────── 侦察兵, in place (phase-3 "没查询" fix): every ask shows its queue / answer right where it was
  // asked (edge card, side panel, empty sides), survives closing the web or reloading the page, and a finished
  // gap job re-reads that company's graph file so the new tie appears (marked 新, 估 until verified).
  const JOBS_KEY = 'mw.web.jobs';
  const LIVE = new Set(['asking', 'queued', 'running']);
  const isLive = (j) => !!j && LIVE.has(j.state);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let jobTimer = 0, jobTick = 0;
  S.jobs = loadJobs();
  for (const j of S.jobs.values()) {
    // a page reload while the tie was being drawn: if that was long ago, say so instead of watching forever
    if (j.landed === 'waiting' && Date.now() - Date.parse(j.startedAt) > 10 * 60e3) j.landed = 'later';
  }
  setTimeout(() => pollJobs(500), 0);
  function loadJobs() {
    try {
      const v = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]');
      return new Map((Array.isArray(v) ? v : [])
        .filter((j) => j && j.key && j.id && Date.now() - Date.parse(j.startedAt || 0) < 6 * 3600e3)
        .map((j) => [j.key, { ...j, state: LIVE.has(j.state) || j.state === 'done' ? (j.state === 'done' ? 'done' : 'queued') : j.state, res: null, resumed: true }]));
    } catch { return new Map(); }
  }
  function saveJobs() {
    try {
      const keep = [...S.jobs.values()].filter((j) => j.id && Date.now() - Date.parse(j.startedAt) < 6 * 3600e3)
        .map(({ key, id, kind, focus, ids, label, startedAt, state, landed, newTies }) => ({ key, id, kind, focus, ids, label, startedAt, state, landed, newTies }));
      localStorage.setItem(JOBS_KEY, JSON.stringify(keep.slice(-30)));
    } catch { /* private mode */ }
  }
  /** dispatch through app.ask (keeps the 🔎 panel in the loop) and follow the job here */
  async function sendScout({ key, kind, target, question, focus, ids, label }) {
    const cur = S.jobs.get(key);
    if (isLive(cur)) { renderJobs(key); return cur; }
    const job = { key, kind, focus, ids, label, id: null, state: 'asking', startedAt: new Date().toISOString(), res: null, landed: null,
      retry: { key, kind, target, question, focus, ids, label } };
    S.jobs.set(key, job);
    renderJobs(key);
    let r;
    const before = scoutCards();
    try {
      r = typeof app.ask === 'function' ? await app.ask(kind, target, question)
        : typeof D().api === 'function' ? await D().api('scout', { method: 'POST', body: { kind, target, question } }) : { error: 'no-server' };
    } catch (e) { r = { error: e?.message || String(e) }; }
    if (S.jobs.get(key) !== job) return job;
    // ui/scout.js landed its own live card right where the owner clicked: ours stays quiet while it is on screen
    job.extCard = r && !r.error ? newScoutCard(before) : null;
    if (!r || r.error || !(r.id || r.state === 'cached' || r.cached)) {
      job.state = 'error';
      job.error = r?.error === 'no-server' ? '要用 server.py 打开本页，侦察兵才能出发' : r?.error ? `没派出去：${r.error}` : '没派出去';
    } else if (r.state === 'cached' || r.cached || r.state === 'done') { job.id = r.id || 'cached'; job.state = 'done'; job.res = r; job.cached = true; }
    else { job.id = r.id; job.state = r.state === 'running' ? 'running' : 'queued'; }
    saveJobs();
    renderJobs(key);
    if (job.state === 'done') onJobDone(job); else if (isLive(job)) pollJobs(1500);
    return job;
  }
  function pollJobs(delay = 3000) {
    clearTimeout(jobTimer);
    const anyLive = () => [...S.jobs.values()].some((j) => (isLive(j) && j.id) || (j.state === 'done' && !j.res && j.id && j.id !== 'cached'));
    if (!anyLive()) return;
    jobTimer = setTimeout(async () => {
      const api = D().api;
      if (typeof api !== 'function') return;
      const live = [...S.jobs.values()].filter((j) => (isLive(j) && j.id) || (j.state === 'done' && !j.res && j.id && j.id !== 'cached'));
      let usage = null;
      if (live.some((j) => j.state === 'queued')) { const u = await api('scout'); usage = u && !u.error ? u.usage || u : null; }
      for (const j of live) {
        const r = await api('scout?id=' + encodeURIComponent(j.id));
        if (!r || r.error === 'no-server') continue;
        const wasDone = j.state === 'done';
        if (r.state === 'done' || r.state === 'cached') { j.state = 'done'; j.res = r; if (!wasDone || !j.landed) onJobDone(j); }
        else if (/fail|error|expired|unknown/.test(String(r.state))) { j.state = 'error'; j.error = r.error ? `没查成：${r.error}` : '侦察兵空手回来'; }
        else {
          j.state = r.state === 'running' ? 'running' : 'queued';
          j.ahead = j.state === 'queued' && usage ? Math.max(0, (usage.queued || 0) - 1) + (usage.running || 0) : 0;
        }
        if (isLive(j) && Date.now() - Date.parse(j.startedAt) > 40 * 60e3) { j.state = 'error'; j.error = '等太久了，可能卡住了'; }
        renderJobs(j.key);
      }
      saveJobs();
      pollJobs(4000);
    }, delay);
  }
  function onJobDone(job) {
    saveJobs();
    renderJobs(job.key);
    const touchesGraph = job.kind === 'gap' || (job.res?.changes || []).some((c) => /graph/.test(String(c?.file || c)));
    if (!touchesGraph || job.landed === 'drawn' || job.watching) return;
    if (!job.landed || job.landed === 'later') job.landed = 'waiting';
    renderJobs(job.key);
    watchGraph(job);
  }
  /** the job is done; the graph build that draws its tie runs right after — watch the company file(s) */
  async function watchGraph(job) {
    job.watching = true;
    const ids = (job.ids && job.ids.length ? job.ids : [job.focus]).filter(Boolean);
    const src = await graphSource().catch(() => null);
    if (!src || !src.base) { job.watching = false; return; }
    // what each company's file looked like before: its build stamp + its ties
    const before = new Map();
    for (const id of ids) {
      const d = S.docs.get(id);
      const doc = d ? await d.catch(() => null) : null;
      before.set(id, { gen: doc?.genAt || src.genAt || null, sigs: doc ? new Set(doc.edges.map(edgeSig)) : null });
    }
    const t0 = Date.now();
    let rebuilt = false;
    for (let k = 0; Date.now() - t0 < 4 * 60e3; k++) {
      await sleep(k ? 5000 : 700);
      if (S.jobs.get(job.key) !== job) { job.watching = false; return; }
      if (k % 3 === 0) await refreshIndex();
      for (const id of ids) {
        if (!S.src?.files?.has(fname(id))) continue;
        const raw = await getJSON(S.src.base + fname(id)).catch(() => null);
        const b = before.get(id);
        if (!raw || !raw.generatedAt || raw.generatedAt === b.gen) continue;
        rebuilt = true;
        // the graph was rebuilt: is OUR tie in it? (build.py stamps scout ties with the task id)
        const fresh = mine(job, raw, b.sigs);
        if (fresh.length) { job.watching = false; await landJob(job, id, fresh); return; }
        b.gen = raw.generatedAt;                     // an unrelated rebuild: keep watching
      }
    }
    job.watching = false;
    job.landed = rebuilt ? 'none' : 'later';
    saveJobs();
    renderJobs(job.key);
  }
  /** ties in a freshly built company file that this job put there */
  function mine(job, raw, sigs) {
    const edges = (raw.edges || []).filter((e) => e && e.a && e.b && e.type !== 'comove' && e.type !== 'leadlag');
    return edges.filter((e) => (e.scout && e.scout.taskId && e.scout.taskId === job.id)
      || (sigs && !sigs.has(edgeSig(e)) && (e.batch === 'scout' || e.source === 'scout' || !!e.scout)));
  }
  async function refreshIndex() {
    const src = S.src;
    if (!src || !src.base || src.kind !== 'data') return;
    const idx = await getJSON(src.base + 'index.json').catch(() => null);
    if (!idx || !Array.isArray(idx.companies) || S.src !== src) return;
    src.index = idx;
    src.files = indexFiles(idx);
    src.genAt = idx.generatedAt || src.genAt;
    for (const [k, v] of Object.entries(indexNodes(idx))) src.all.nodes.set(k, { ...(src.all.nodes.get(k) || {}), ...v });
    S.resolver = null;
  }
  const edgeSig = (e) => `${e.a}>${e.b}:${e.type}:${isNum(e.money?.usdB) ? e.money.usdB : ''}:${e.est ? 1 : 0}`;
  async function landJob(job, id, fresh) {
    S.docs.delete(id);
    const keys = new Set(fresh.map(edgeSig));
    job.landed = 'drawn';
    job.newTies = fresh.length;
    S.freshSigs = new Set([...(S.freshSigs || []), ...keys]);   // marked 新 wherever these ties show up
    if (S.open && S.focus === id) {
      S.focus = null;
      await focusOn(id, { push: false });
    } else if (S.open && S.focus) {
      // the tie may touch the company on screen too (the other end of a gap): redraw it as well
      const f = S.focus;
      if (fresh.some((e) => e.a === f || e.b === f)) { S.docs.delete(f); S.focus = null; await focusOn(f, { push: false }); }
    }
    saveJobs();
    renderJobs(job.key);
    toast(`侦察兵查到的 ${job.newTies} 条关系已经画上（标着「新」${fresh.some((e) => e.est || e.money?.est) ? '，没核实的带「估」' : ''}）`, 3600);
  }
  /** paint one job into every place that shows it */
  function jobEl(job) {
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000));
    const t = secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${String(secs % 60).padStart(2, '0')} 秒`;
    if (job.state === 'asking') return whyWaitEl('正在派侦察兵…', '');
    if (job.state === 'queued') return whyWaitEl('侦察兵在查…', `排队中${job.ahead ? `，前面还有 ${job.ahead} 个` : ''} · 已等 ${t}`);
    if (job.state === 'running') return whyWaitEl('侦察兵在查…', `${t} · 通常 30–90 秒`);
    if (job.state === 'error') {
      const el = h('div', 'svw-fail', `<span>${esc(job.error || '没查成')}</span>`);
      const b = h('button', 'svw-link', '再试一次', el);
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); S.jobs.delete(job.key); retryJob(job); });
      return el;
    }
    // done
    const box = h('div', 'wb-job-done');
    if (job.res) box.append(scoutAnswerEl(job.res, {}));
    else box.append(h('div', 'svw-wait', `<span class="svw-wait-t">侦察兵查完了</span><span class="svw-wait-s">${esc(job.cached ? '3 天内查过，没再花额度' : '正在取回答案…')}</span>`));
    const land = landEl(job);
    if (land) box.append(land);
    return box;
  }
  function landEl(job) {
    const L = job.landed && {
      waiting: ['live', '查完了，正在等关系网把它画上…'],
      drawn: ['ok', job.newTies ? `已画上：${job.newTies} 条关系（图上标「新」，没核实的带「估」）` : '关系网已经按它更新'],
      later: ['', '查完了，关系网还没重建——下次刷新数据会画上'],
      none: ['', '关系网重建了，但这次没画出新线（侦察兵的数没对上公司，或把握不如已有的数）——答案见上'],
    }[job.landed];
    return L ? h('div', `wb-job-land ${L[0]}`, (L[0] === 'live' ? '<i class="svw-dot"></i>' : '') + `<span>${esc(L[1])}</span>`) : null;
  }
  /** what a [data-job] slot shows: everything — or, while the scout panel's own card is on screen, only 画上 */
  function slotKids(job) {
    if (!job) return [];
    if (extShown(job)) { const l = landEl(job); return l ? [l] : []; }
    return [jobEl(job)];
  }
  function renderJobs(key) {
    if (!E.root) return;
    const job = S.jobs.get(key);
    for (const el of E.root.querySelectorAll('[data-job]')) {
      if (el.dataset.job !== key) continue;
      el.replaceChildren(...slotKids(job));
    }
    if (job && job.focus === S.focus && S.model?.F === S.focus && (key.startsWith('co:') || job.kind === 'gap')) {
      renderZones();
      renderEmpty();
      const btn = E.side?.querySelector('[data-ask-gap]');
      if (btn) btn.hidden = isLive(job) || job.landed === 'waiting';
    }
    // the edge card's own ask button follows the job (在查… → 再查一次)
    if (job && S.tip?.kind === 'edge' && !E.tip.hidden && edgeFacts(S.tip.id).key === key) {
      const b = E.tip.querySelector('[data-act="ask"]');
      if (b) { b.disabled = isLive(job); const sp = b.querySelector('span'); if (sp) sp.textContent = isLive(job) ? '侦察兵在查…' : job.state === 'error' ? '再派一次' : '再查一次'; }
    }
    if (E.tip && !E.tip.hidden) placeTipKeep();
    // a ticking clock only while something visible is waiting
    clearInterval(jobTick);
    if ([...S.jobs.values()].some((j) => isLive(j) || j.landed === 'waiting')) {
      jobTick = setInterval(() => {
        if (!S.open) return;
        for (const el of E.root.querySelectorAll('[data-job]')) { const j = S.jobs.get(el.dataset.job); if (j && isLive(j)) el.replaceChildren(...slotKids(j)); }
      }, 1000);
    }
  }
  function fillJobs(scope) {
    for (const el of scope.querySelectorAll('[data-job]')) { const j = S.jobs.get(el.dataset.job); if (j) el.replaceChildren(...slotKids(j)); }
  }
  /** the scout panel's own in-place card for this job is still on screen (then we show only the 画上 status) */
  const extShown = (j) => !!(j.extCard && j.extCard.isConnected && j.extCard.offsetParent !== null);
  // the scout panel announces every finished job: land ours at once instead of waiting for the next poll
  app.on?.('scoutDone', (x) => {
    for (const j of S.jobs.values()) {
      if (!x || j.id !== x.id || j.state === 'done') continue;
      j.state = 'done';
      j.res = x;
      onJobDone(j);
    }
  });
  const coBusy = (id) => { const j = S.jobs.get('co:' + id); return isLive(j) || j?.landed === 'waiting'; };
  function retryJob(job) {
    if (job.key.startsWith('co:')) askGap(job.focus);
    else if (job.retry) sendScout(job.retry);
  }

  // ─────────── ids: anything typed or handed over → the graph's own id (ticker or p:slug)
  // (phase-3 "没查询" fix: the scout was sent 's:GOOGLE' and company names; the graph only knows GOOGL / p:openai)
  const ALIAS = {
    google: 'GOOGL', alphabet: 'GOOGL', googlecloud: 'GOOGL', apple: 'AAPL', facebook: 'META', microsoft: 'MSFT',
    amazon: 'AMZN', aws: 'AMZN', nvidia: 'NVDA', tsmc: 'TSM', softbank: ['SFTBY', '9984.T'], softbankgroup: ['SFTBY', '9984.T'],
    openai: 'p:openai', anthropic: 'p:anthropic', xai: 'p:xai', spacex: 'SPCX', ginkgo: 'DNA', ginkgobioworks: 'DNA',
    oracle: 'ORCL', broadcom: 'AVGO', crowdstrike: 'CRWD', tesla: 'TSLA', intel: 'INTC', amd: 'AMD', netflix: 'NFLX',
    berkshire: 'BRK-B', jpmorgan: 'JPM', samsung: '005930.KS', skhynix: '000660.KS', asml: 'ASML', twist: 'TWST',
    twistbioscience: 'TWST', bayer: 'BAYN.DE', novonordisk: 'NVO', lilly: 'LLY', elililly: 'LLY',
  };
  const STOP = /\b(inc|corp|corporation|co|company|group|holdings?|ltd|plc|sa|ag|nv|the|class [a-c])\b\.?/g;
  const keyOf = (s) => String(s || '').toLowerCase().replace(STOP, '').replace(/[^\p{L}\p{N}]+/gu, '');
  const normTicker = (s) => {
    let t = String(s || '').trim().replace(/^s:/i, '').toUpperCase().replace(/\s+/g, '');
    const m = /^([A-Z]{1,5})\.([A-C])$/.exec(t);                 // BRK.B → BRK-B (BA.L / 2702.T stay)
    if (m) t = `${m[1]}-${m[2]}`;
    return t;
  };
  function resolver() {
    if (S.resolver) return S.resolver;
    const ids = new Set(), byKey = new Map(), tickers = [];
    const add = (id, name) => {
      if (!id) return;
      ids.add(id);
      if (!isPriv(id) && !/\./.test(id)) tickers.push(id);
      const ks = new Set([keyOf(name), keyOf(String(name || '').replace(/[（(][^）)]*[）)]/g, ''))]);
      const latin = (String(name || '').match(/[A-Za-z][A-Za-z0-9&.'-]*/g) || []).join(' ');
      if (latin) ks.add(keyOf(latin));
      const cjk = (String(name || '').match(/[\u2E80-\u9FFF]+/g) || []).join('');
      if (cjk) ks.add(cjk);
      if (isPriv(id)) ks.add(keyOf(id.slice(2)));
      for (const k of ks) { if (k && k.length >= 2) { if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(id); } }
    };
    for (const [id, n] of S.src?.all.nodes || []) add(id, n?.name);
    for (const x of app.searchIndex || []) {
      const t = x.ticker || (String(x.id).startsWith('s:') ? String(x.id).slice(2) : null);
      if (t) add(t, x.name);
    }
    S.resolver = { ids, byKey, tickers };
    return S.resolver;
  }
  const knownId = (id) => !!id && (resolver().ids.has(id) || stockKnown(id));
  /** text → canonical id or null. 'GOOGLE' → GOOGL · 'S:DNA' → DNA · 'GINKGO BIOWORKS (DNA)' → DNA ·
   *  'Twist Bioscience' → TWST · 'p:OpenAI' → p:openai · '谷歌' → GOOGL */
  function resolveId(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const R = resolver();
    const uniq = (k) => { const hit = R.byKey.get(k); return hit && hit.size === 1 ? [...hit][0] : null; };
    if (/^p:/i.test(s)) {
      const p = 'p:' + s.slice(2).trim().toLowerCase().replace(/\s+/g, '-');
      if (R.ids.has(p)) return p;
      return resolveId(s.slice(2)) || null;
    }
    const t = normTicker(s);
    if (knownId(t)) return t;
    for (const m of s.matchAll(/[(（]([A-Za-z0-9.\-]{1,12})[)）]/g)) { const x = normTicker(m[1]); if (knownId(x)) return x; }
    for (const piece of [s, ...s.split(/[/（）()·,，、|]/)]) {
      const p = piece.trim();
      if (!p) continue;
      const x = normTicker(p);
      if (/^[A-Z0-9.\-]{1,12}$/.test(x) && knownId(x)) return x;
      const k = keyOf(p);
      const hit = uniq(k) || alias(k);
      if (hit) return hit;
    }
    // a ticker with one letter too many: GOOGLE → GOOGL (only for real-looking tickers, never 'XYZZY' → XYZ)
    if (/^[A-Z]{5,7}$/.test(t)) {
      const near = R.tickers.filter((x) => x.length >= 4 && t.length - x.length === 1 && t.startsWith(x)).sort((a, b) => b.length - a.length)[0];
      if (near) return near;
    }
    // a known multi-word name that starts the text ('Ginkgo Bioworks Holdings' → DNA)
    const k = keyOf(s);
    let best = null;
    for (const [n, set] of R.byKey) if (n.length >= 5 && set.size === 1 && k.startsWith(n) && (!best || n.length > best[0].length)) best = [n, [...set][0]];
    if (best) return best[1];
    for (const a of Object.keys(ALIAS)) if (a.length >= 5 && k.startsWith(a) && alias(a)) return alias(a);
    return null;
  }
  function alias(k) {
    const v = ALIAS[k];
    for (const id of [].concat(v || [])) if (knownId(id)) return id;
    return null;
  }

  // ─────────── naming / weather
  function info(id) {
    const tn = !isPriv(id) && typeof D().nodeById === 'function' ? D().nodeById('s:' + id) : null;
    const gn = S.doc?.nodes.get(id) || S.src?.all.nodes.get(id) || {};
    const priv = isPriv(id) || gn.private === true;
    const name = tn?.name || gn.name || (id === S.doc?.id ? S.doc?.name : null) || String(id).replace(/^p:/, '');
    return {
      id, name, note: tn?.note || gn.note || '', priv, tree: !!tn,
      abroad: !priv && !tn, dv20: tn?.now?.dv20 ?? null, ticker: priv ? null : id,
    };
  }

  function dateIdx(n) {
    const L = app.meta?.dates?.length || n;
    const i = isNum(app.state?.dateIndex) ? app.state.dateIndex : L - 1;
    return clamp(i - (L - n), 0, n - 1);
  }
  // flow5 + temp only choose the words (words.season): the season line never says 钱在撤 while the 5-day
  // money is coming in, nor 冷清没人管 next to a 暖 temperature. crash = words.crashAt(stockFile, i) — the
  // 暴跌闸门 (DESIGN §8 amendment): a company falling hard never reads 春 / 夏, the line says 崩 / 急跌 and the drop
  function seasonOf(w, dw, p, f5, t, crash) {
    const fn = W().season;
    if (typeof fn === 'function') {
      try {
        const r = fn(w, dw, p, f5, t, crash);
        if (r && r.key && SEASONS[r.key]) return { key: r.key, ...SEASONS[r.key], ...r };
        if (r === null || (r && !r.key)) return null;
      } catch { /* fall back */ }
    }
    if (!isNum(w) || !isNum(p)) return null;
    dw = isNum(dw) ? dw : 0;
    let k = null;
    if (w > 0.3 && dw > 0.3 && p < 65) k = 'spring';
    else if (w > 0.3 && p >= 65) k = 'summer';
    else if ((w < -0.3 && p >= 50) || (dw < -0.6 && p >= 65)) k = 'autumn';
    else if ((w < -0.3 && p < 50) || (Math.abs(w) <= 0.3 && p < 35)) k = 'winter';
    // only reached if words.season threw: keep the crash gate anyway (same split as words.seasonKey)
    if (crash && crash.level && k !== 'autumn' && k !== 'winter') k = p >= 50 ? 'autumn' : 'winter';
    return k ? { key: k, ...SEASONS[k] } : null;
  }
  function wx(id) {
    const s = S.stocks.get(id);
    if (!s || !Array.isArray(s.wind) || !s.wind.length) return null;
    const n = s.wind.length, i = dateIdx(n);
    const v = (a, j = i) => (Array.isArray(a) && isNum(a[j]) ? a[j] : null);
    const w = v(s.wind), t = v(s.temp), p = v(s.pres), w5 = v(s.wind, Math.max(0, i - 5));
    const dw = isNum(w) && isNum(w5) ? w - w5 : null;
    let f5 = null;
    if (Array.isArray(s.flow)) for (let j = Math.max(0, i - 4); j <= i; j++) if (isNum(s.flow[j])) f5 = (f5 || 0) + s.flow[j];
    // words on one card must never fight (phase-3 fix): season vs temperature vs the 5-day money, wind vs the 5-day number
    let crash = null;
    try { crash = typeof W().crashAt === 'function' ? W().crashAt(s, i) : null; } catch { crash = null; }
    const season = seasonOf(w, dw, p, f5, t, crash);
    const mixed = isNum(w) && isNum(f5) ? (w >= 0.5 && f5 < 0 ? 1 : w <= -0.5 && f5 > 0 ? -1 : 0) : 0;
    return { wind: w, temp: t, pres: p, storm: v(s.storm), dw, season, last: v(s.c), i, f5, mixed };
  }
  /** the wind word, unless the 5-day money says the opposite: then say that plainly */
  const windTxt = (w) => (w && w.mixed === 1 ? '关注在升，钱没真进' : w && w.mixed === -1 ? '关注在退，钱没真走' : windW(w?.wind).text);
  const word = (fn, v, fb) => {
    const f = W()[fn];
    if (typeof f === 'function') { try { const r = f(v); if (r && r.text) return r; } catch { /* fallback */ } }
    return fb(v);
  };
  const tempW = (t) => word('tempWord', t, (x) => ({ text: !isNum(x) ? '暂无' : x > 1.5 ? '很热' : x >= 0.5 ? '暖' : x > -0.5 ? '常温' : x >= -1.5 ? '凉' : '很冷' }));
  const windW = (w) => word('windWord', w, (x) => ({ text: !isNum(x) ? '暂无' : x > 1.5 ? '钱在狂涌进来' : x >= 0.5 ? '钱在流进来' : x > -0.5 ? '风平浪静' : x >= -1.5 ? '钱在悄悄溜走' : '钱在大逃离' }));
  const presW = (p) => word('presWord', p, (x) => ({ text: !isNum(x) ? '暂无' : x >= 85 ? '人挤人' : x >= 65 ? '人多' : x >= 35 ? '正常' : x >= 15 ? '人少' : '冷清洼地' }));

  // ─────────── model: who sits where
  function payerPayee(e) {
    const m = e.money;
    if (m && m.from && m.to) return [m.from, m.to];
    switch (e.type) {
      case 'buys-from': case 'finances': case 'invests-in': return [e.a, e.b];
      case 'sells-to': case 'licenses': return [e.b, e.a];
      default: return [null, null];
    }
  }
  const isEst = (e) => !!(e.est || e.inferred || e.money?.est);

  function buildModel(doc) {
    const F = doc.id;
    const pairs = new Map();
    const pair = (o) => {
      if (!pairs.has(o)) pairs.set(o, { id: o, rels: [], measured: [], flows: [], zone: null, score: 0 });
      return pairs.get(o);
    };
    for (const e of doc.edges) { const o = e.a === F ? e.b : e.a; if (o && o !== F) pair(o).rels.push(e); }
    for (const m of doc.measured) { const o = m.a === F ? m.b : m.a; if (o && o !== F) pair(o).measured.push(m); }
    for (const p of pairs.values()) classify(p, F);
    const list = [...pairs.values()].sort((a, b) => b.score - a.score);
    return { F, pairs, list, visible: [], hidden: {} };
  }

  function classify(p, F) {
    let best = null, bestRank = -1, sum = 0, maxStr = 0, maxConf = 0;
    const flowMap = new Map();
    for (const e of p.rels) {
      const [payer, payee] = payerPayee(e);
      // money made comparable (moneyOf): yearly ties add up per year; a contract total counts per year of its
      // term; one-off deals never join the yearly figure — they keep their own list (dashed tick + own label)
      const mk = moneyOf(e);
      e._mk = mk;
      const usd = sizeOf(mk);
      let role;
      if (e.type === 'competes') role = 'top';
      else if (e.type === 'partner' && !(payer && payee)) role = 'bottom';
      else if (e.type === 'invests-in' || e.type === 'finances' || e.type === 'partner') role = 'bottom';
      else if (payer === F) role = 'left';
      else if (payee === F) role = 'right';
      else role = 'bottom';
      e._role = role;
      if (payer && payee && (payer === F || payee === F)) {
        const dir = payer === F ? 1 : -1;                // +1: focus → other
        const k = dir + ':' + role;
        // usdB = yearB: the yearly figure (band width, labels, ledger); ones: one-off money, never summed into it
        const f = flowMap.get(k) || { dir, usdB: 0, yearB: 0, yearly: false, term: false, ones: [], known: false, est: true, rels: [], role };
        if (mk && mk.kind !== 'one') { f.yearB += mk.yearB; f.usdB = f.yearB; f.yearly = true; if (mk.kind === 'term') f.term = true; }
        else if (mk) f.ones.push({ e, mk });
        if (mk) f.known = true;
        f.est = f.est && isEst(e);
        f.rels.push(e);
        flowMap.set(k, f);
      }
      if (usd != null) sum += usd;
      maxStr = Math.max(maxStr, e.strength || 1);
      maxConf = Math.max(maxConf, e.conf || 0);
      // the pair sits where its most important tie belongs: money first (per year — a contract total per year
      // of its term, a one-off at a fifth), then supply chain, then the rest
      const rank = (usd != null ? 100 + Math.min(usd, 900) / 10 : 0) + ({ left: 30, right: 30, bottom: 12, top: 6 }[role]) + (e.strength || 1) * 2 + (e.conf || 0);
      if (rank > bestRank) { bestRank = rank; best = role; }
    }
    if (!best) best = 'top';                                  // measured-only ties sit with the rivals / look-alikes
    p.zone = best;
    p.flows = [...flowMap.values()].filter((f) => f.role === best || f.known);
    for (const f of p.flows) f.ones.sort((a, b) => b.mk.usdB - a.mk.usdB);
    p.usdB = sum || null;                                     // comparable size (per year), for ranking only
    p.est = p.rels.length ? p.rels.every(isEst) : false;
    p.anyEst = p.rels.some(isEst);
    const mc = Math.max(0, ...p.measured.map((m) => (m.type === 'comove' && isNum(m.corr) ? m.corr : 0)));
    p.score = 3.2 * Math.log1p(sum) + maxStr * 1.4 + maxConf + (best === 'left' || best === 'right' ? 0.8 : 0) + (mc >= 0.6 ? 1 + mc : 0) + (p.measured.some((m) => m.type === 'leadlag') ? 0.6 : 0);
    p.fresh = p.rels.some((e) => e._new);
    if (p.fresh) p.score += 100;                              // what the scout just found is always on screen
  }

  function choose(model) {
    const count = {}, total = {};
    for (const z in ZONE_CAP) { count[z] = 0; total[z] = 0; }
    for (const p of model.list) total[p.zone]++;
    const chosen = new Set();
    const take = (p) => { chosen.add(p); count[p.zone]++; };
    // 1) every side gets a few seats (the money axis left ↔ right matters most)
    for (const p of model.list) if (count[p.zone] < ZONE_MIN[p.zone]) take(p);
    // 2) the best of the rest up to each side's cap, 3) a lopsided company lets one side run long
    for (const p of model.list) { if (chosen.size >= MAX_NEIGHBOURS) break; if (!chosen.has(p) && count[p.zone] < ZONE_CAP[p.zone]) take(p); }
    for (const p of model.list) { if (chosen.size >= MAX_NEIGHBOURS) break; if (!chosen.has(p) && count[p.zone] < ZONE_CAP[p.zone] + 4) take(p); }
    // 4) "展开" only ever adds to its own side — nothing else on screen moves out
    for (const z in ZONE_CAP) {
      let more = S.expanded[z] * EXPAND_STEP;
      for (const p of model.list) { if (more <= 0) break; if (p.zone === z && !chosen.has(p)) { take(p); more--; } }
    }
    model.visible = model.list.filter((p) => chosen.has(p));
    model.hidden = {};
    for (const z in ZONE_CAP) model.hidden[z] = total[z] - count[z];
    model.total = total;
  }

  function nodeR(id) {
    const i = info(id);
    if (i.priv) return 10.5;
    if (!isNum(i.dv20)) return 11;
    return 9.5 + 10.5 * Math.sqrt(clamp(i.dv20, 0, 20000) / 20000);
  }
  const bandW = (usdB) => (isNum(usdB) && usdB > 0 ? clamp(1.8 + 2.25 * Math.sqrt(usdB), 2, 15) : 0);

  function computeLayout(model) {
    const Wd = S.W, Ht = S.H;
    const cx = Wd / 2, cy = Ht / 2 + 2;
    const rx = Math.max(150, Math.min(Wd / 2 - 150, 470));
    const ry = Math.max(120, Math.min(Ht / 2 - 100, 340));
    const pos = new Map();
    pos.set(model.F, { x: cx, y: cy, r: FOCUS_R, zone: 'focus' });
    // the side arcs stop short of the top / bottom rows so a long column never runs into a row
    const limFor = (row) => (row ? Math.max(0.5, 1 - 70 / ry) : 0.96);   // as a fraction of ry
    const limUp = limFor(model.visible.some((p) => p.zone === 'top'));
    const limDown = limFor(model.visible.some((p) => p.zone === 'bottom'));
    const E2 = 2.7;                                                         // superellipse |x/rx|^e + |y/ry|^e = 1
    for (const z of Object.keys(ZONES)) {
      const list = model.visible.filter((p) => p.zone === z);
      const n = list.length;
      if (!n) continue;
      const Z = ZONES[z];
      if (z === 'top' || z === 'bottom') {
        // rivals / partners: a straight row (staggered when crowded), most important in the middle
        const two = n > 5;
        const gap = Math.min(150, (2 * rx * (two ? 0.8 : 0.62)) / Math.max(1, n - 1));
        const slots = [];
        for (let k = 0; k < n; k++) slots.push({ a: (k - (n - 1) / 2) * gap, k });
        const order = slots.slice().sort((u, v) => Math.abs(u.a) - Math.abs(v.a) || u.a - v.a);
        const s = z === 'top' ? -1 : 1;
        list.forEach((p, j) => {
          const sl = order[j];
          const dy = two && sl.k % 2 === 1 ? -s * 34 : 0;
          pos.set(p.id, { x: cx + sl.a, y: cy + s * ry + dy, r: nodeR(p.id), zone: z });
        });
        continue;
      }
      // sides: nodes evenly spaced DOWN the screen (labels never bunch), x following the orbit; the column
      // may run longer on the side that has no row; most important nearest the money axis
      const two = n > 9;                                  // one arc holds 9; more → a staggered inner ring
      const want = n === 1 ? 0 : Math.min(1, 0.2 + 0.135 * (n - 1));
      let up = Math.min(limUp, want), down = Math.min(limDown, want);
      const spare = 2 * want - up - down;
      if (spare > 0) { up = Math.min(limUp, up + spare / 2); down = Math.min(limDown, down + spare / 2); }
      const slots = [];
      for (let k = 0; k < n; k++) slots.push({ a: n === 1 ? 0 : -up + ((up + down) * k) / (n - 1), k });
      const order = slots.slice().sort((u, v) => Math.abs(u.a) - Math.abs(v.a) || u.a - v.a);
      const side = z === 'left' ? -1 : 1;
      list.forEach((p, j) => {
        const s = order[j];
        const ring = two && s.k % 2 === 1 ? 0.72 : 1;
        const ux = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s.a), E2)), 1 / E2);
        pos.set(p.id, { x: cx + side * rx * ring * ux, y: cy + ry * s.a, r: nodeR(p.id), zone: z, inner: ring < 1 });
      });
    }
    return { cx, cy, rx, ry, pos };
  }

  // ─────────── DOM
  function ensureDom() {
    if (E.root) return;
    const root = h('div', 'mw-web', null, document.body);
    root.id = 'mw-web';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '关系网：公司之间谁付钱给谁');
    root.innerHTML = `
      <svg class="wb-defs" width="0" height="0" aria-hidden="true"><defs>${ICONS}</defs></svg>
      <header class="wb-head">
        <button class="wb-btn wb-back" type="button" title="回到刚才的地方（Esc）">${icon('back')}<span>返回</span></button>
        <div class="wb-id">
          <div class="wb-crumbs"></div>
          <div class="wb-title"><h1 class="wb-name"></h1><span class="wb-tk"></span><span class="wb-note"></span></div>
        </div>
        <div class="wb-tools">
          <label class="wb-search">${icon('search')}<input type="search" placeholder="换一家：名字或代码" autocomplete="off" spellcheck="false" aria-label="换一家公司"><ul class="wb-sugg" hidden></ul></label>
          <button class="wb-btn wb-stock" type="button" title="看这家公司自己的天气">${icon('planet')}<span>个股天气</span></button>
          <button class="wb-btn wb-x" type="button" title="关闭关系网（Esc）" aria-label="关闭">${icon('close')}</button>
        </div>
      </header>
      <main class="wb-main">
        <section class="wb-stage" aria-label="关系图">
          <svg class="wb-back-svg"><g class="wb-bg"></g><g class="wb-edges"></g></svg>
          <canvas class="wb-canvas" aria-hidden="true"></canvas>
          <svg class="wb-front-svg"><g class="wb-cross"></g><g class="wb-eseals"></g><g class="wb-nodes"></g></svg>
          <div class="wb-zones"></div>
          <div class="wb-legend"></div>
          <div class="wb-empty" hidden></div>
          <div class="wb-tip" hidden></div>
        </section>
        <aside class="wb-side"></aside>
      </main>`;
    E.root = root;
    E.stage = root.querySelector('.wb-stage');
    E.back = root.querySelector('.wb-back-svg');
    E.bg = root.querySelector('.wb-bg');
    E.edges = root.querySelector('.wb-edges');
    E.canvas = root.querySelector('.wb-canvas');
    E.ctx = E.canvas.getContext('2d');
    E.front = root.querySelector('.wb-front-svg');
    E.cross = root.querySelector('.wb-cross');
    E.eseals = root.querySelector('.wb-eseals');
    E.nodes = root.querySelector('.wb-nodes');
    E.zones = root.querySelector('.wb-zones');
    E.legend = root.querySelector('.wb-legend');
    E.empty = root.querySelector('.wb-empty');
    E.tip = root.querySelector('.wb-tip');
    E.side = root.querySelector('.wb-side');
    E.name = root.querySelector('.wb-name');
    E.tk = root.querySelector('.wb-tk');
    E.note = root.querySelector('.wb-note');
    E.crumbs = root.querySelector('.wb-crumbs');
    E.input = root.querySelector('.wb-search input');
    E.sugg = root.querySelector('.wb-sugg');
    E.stockBtn = root.querySelector('.wb-stock');
    E.backBtn = root.querySelector('.wb-back');

    E.backBtn.addEventListener('click', () => (S.hist.length > 1 ? goBack() : close()));
    root.querySelector('.wb-x').addEventListener('click', () => close());
    E.stockBtn.addEventListener('click', () => {
      const t = S.focus;
      if (!t || !stockKnown(t)) return;
      close();
      app.openStock?.(t);
    });
    E.legend.innerHTML = hintHTML();
    wireSearch();
    wireStage();
    // cards grow when an answer lands in them (ours or the scout panel's): keep them on screen
    new ResizeObserver(() => placeTipKeep()).observe(E.tip);
    document.addEventListener('keydown', onKey);
    new ResizeObserver(() => onResize()).observe(E.stage);
    const mo = new MutationObserver(() => syncTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.open) kick(); });
    syncTheme();
  }

  function hintHTML() {
    return `<svg width="30" height="10" aria-hidden="true"><path d="M2 5H28" class="lg-band"/><path d="M9 5H13" class="lg-dash"/><path d="M19 5H23" class="lg-dash"/></svg><span>线越粗，每年的钱越多，光点顺着钱跑</span>
      <svg width="16" height="14" aria-hidden="true"><path d="M2 7H14" class="lg-line"/><path d="M8 1.5V12.5" class="lg-tick"/></svg><span>一次性的钱</span>
      <svg width="24" height="10" aria-hidden="true"><path d="M2 5H22" class="lg-meas"/></svg><span>价格测量</span>
      <span class="wb-seal-i sm">估</span><span>估算</span>
      <svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" class="lg-hollow"/></svg><span>未上市</span>`;
  }
  function legendHTML() {
    const ramp = RAMP.map(([t, c]) => `<i style="background:${c}"></i>`).join('');
    const row = (ic, txt) => `<div class="wb-key-row"><span class="wb-key-ic">${ic}</span><span>${txt}</span></div>`;
    return `<section class="wb-sec wb-key"><div class="wb-sec-h">怎么看这张图</div>
      ${row('<svg width="38" height="14" aria-hidden="true"><path d="M3 7H35" class="lg-band"/><path d="M11 7H16" class="lg-dash"/><path d="M24 7H29" class="lg-dash"/></svg>', '线越粗，<b>每年</b>的钱越多（多年合同按年限摊开）；光点顺着<b>钱流的方向</b>跑。左边是它付钱的上游，右边是付钱给它的下游。')}
      ${row('<svg width="38" height="14" aria-hidden="true"><path d="M3 7H35" class="lg-line"/><path d="M19 1.5V12.5" class="lg-tick"/></svg>', '线上的虚线短杠：一次性的钱（收购、入股、贷款、担保），不算进线的粗细。')}
      ${row('<svg width="38" height="14" aria-hidden="true"><path d="M3 7H35" class="lg-line"/></svg>', '细线：有生意往来，但金额没公开。')}
      ${row('<svg width="38" height="14" aria-hidden="true"><path d="M3 7H35" class="lg-meas"/></svg>', '浅葱色点线：价格测出来的同涨同跌 / 先动后动，不是观点。')}
      ${row('<span class="wb-seal-i">估</span>', '虚线带「估」：按占比、同行或产业链推算的，等你补数据。')}
      ${row(`<span class="wb-lg-ramp">${ramp}</span>`, '圆点颜色 = 温度：冷 → 热（跟它自己过去一年比）。')}
      ${row('<svg width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="6.4" class="lg-track"/><path d="M9 2.6A6.4 6.4 0 0 1 15.1 11" class="lg-in"/></svg>', '外圈 = 今天的风：绿弧钱在进，红弧钱在出。')}
      ${row(`<span class="wb-key-seasons">${['spring', 'summer', 'autumn', 'winter'].map((k) => `<span class="s-${k}">${icon(k)}</span>`).join('')}</span>`, '小徽章 = 季节：春 钱刚进来 · 夏 正热 · 秋 在撤 · 冬 没人管。')}
      ${row('<svg width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="6" class="lg-hollow"/></svg>', '空心圆 = 未上市公司（没有股价，也就没有天气）。')}
    </section>`;
  }

  // ─────────── theme
  function themeNow() {
    const s = app.state?.theme;
    if (s === 'night' || s === 'day') return s;
    const de = document.documentElement, b = document.body;
    const a = de.dataset.theme || b.dataset.theme;
    if (a === 'night' || a === 'dark') return 'night';
    if (a === 'day' || a === 'light') return 'day';
    if (de.classList.contains('theme-night') || b.classList.contains('theme-night') || b.classList.contains('night')) return 'night';
    return 'day';
  }
  function syncTheme() {
    if (!E.root) return;
    const t = themeNow();
    E.root.dataset.theme = t;
    if (t === S.theme && S.colors.ink && !S.forceColors) return;
    S.forceColors = false;
    S.theme = t;
    const cs = getComputedStyle(E.root);
    const g = (k, fb) => (cs.getPropertyValue(k).trim() || fb);
    const ts = [];
    for (let k = 0; k <= 8; k++) { const v = cs.getPropertyValue('--t' + k).trim(); if (/^#[0-9a-f]{6}$/i.test(v)) ts.push([-3 + (6 * k) / 8, v]); }
    RAMP = ts.length === 9 ? ts : RAMP0;
    S.colors = {
      ink: g('--wb-ink', '#1f2b45'), particle: g('--wb-particle', '#1f2b45'), sky: g('--wb-sky', '#f3eee2'),
      shade: g('--wb-shade', '#2a3350'), paper: g('--wb-paper', '#fbf8f1'), nodata: g('--wb-nodata', '#ddd5c4'),
      kinari: g('--wb-kinari', '#ebe1c8'),
    };
    for (const n of S.nodes.values()) paintNode(n, true);
    if (S.doc && S.open) renderSide();
    kick();
  }

  // ─────────── open / close
  async function open(t, opts = {}) {
    t = String(t || '').trim().replace(/^s:/i, '');
    if (!t) t = lastTicker();
    // whatever came in ('GOOGLE', '谷歌', 'Ginkgo Bioworks (DNA)') → the graph's own id
    await graphSource().catch(() => null);
    const hit = resolveId(t);
    if (hit) t = hit;
    else if (/^p:/i.test(t)) t = t.toLowerCase();
    else if (/^[A-Za-z0-9.\-]{1,12}$/.test(t)) t = t.toUpperCase();     // an unknown ticker still gets a (估) picture
    else { toast(`没找到「${t}」——试试中文名或股票代码`, 3200); if (S.open) return api; t = lastTicker(); }
    ensureDom();
    if (!S.open) {
      S.open = true;
      S.hist = [];
      // a fresh picture each time (no ghost of the last company animating away)
      for (const n of S.nodes.values()) n.el.remove();
      for (const e of [...S.edges.values(), ...(S.dying || [])]) { e.el.remove(); e.seal.remove(); }
      S.nodes.clear(); S.edges.clear(); S.dying = []; S.tween = null; S.focus = null; S.model = null; S.doc = null;
      E.cross.replaceChildren(); E.zones.replaceChildren(); E.side.replaceChildren(); E.empty.hidden = true;
      S.expanded = { left: 0, right: 0, top: 0, bottom: 0 };
      S.from = app.state?.view === 'stock' ? 'stock' : 'planet';

      E.root.hidden = false;
      E.root.classList.remove('wb-out');
      requestAnimationFrame(() => E.root.classList.add('wb-in'));
      syncTheme();
      onResize(true);
      E.root.classList.add('mw-modal-open');
      if (app.state?.view !== 'stock' && app.planet?.pause) { try { app.planet.pause(); S.pausedPlanet = true; } catch { /* ignore */ } }
      document.body.classList.add('in-web');
      app.emit?.('web', { open: true, ticker: t });
    }
    try { localStorage.setItem('mw.web.last', t); } catch { /* ignore */ }
    await focusOn(t, { push: true, from: opts.from || null });
    return api;
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    hideTip(true);
    S.whyRun?.stop?.();
    if (E.root.querySelector('.why-card') && typeof app.whyClose === 'function') { try { app.whyClose(); } catch { /* ignore */ } }
    E.root.classList.remove('wb-in');
    E.root.classList.add('wb-out');
    E.root.classList.remove('mw-modal-open');
    document.body.classList.remove('in-web');
    setTimeout(() => { if (!S.open) { E.root.hidden = true; cancelAnimationFrame(S.raf); S.raf = 0; } }, 240);
    if (S.pausedPlanet && app.state?.view !== 'stock') { try { app.planet?.resume?.(); } catch { /* ignore */ } }
    S.pausedPlanet = false;
    app.emit?.('web', { open: false });
  }

  function lastTicker() {
    try { const v = localStorage.getItem('mw.web.last'); if (v) return v; } catch { /* ignore */ }
    return 'GOOGL';
  }

  // While open, the root carries .mw-modal-open: the shell's keyboard handler then stands aside and the
  // keys are ours (Esc closes a card, then the web; Backspace steps back through the re-centres).
  function onKey(e) {
    if (!S.open || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { e.preventDefault(); if (S.pinned || !E.tip.hidden) hideTip(true); else close(); }
    else if (e.key === 'Backspace') { e.preventDefault(); if (S.hist.length > 1) goBack(); else close(); }
  }

  function goBack() {
    if (S.hist.length < 2) return;
    S.hist.pop();
    const prev = S.hist[S.hist.length - 1];
    focusOn(prev, { push: false });
  }

  // ─────────── focus / re-centre
  async function focusOn(id, { push = true } = {}) {
    const seq = ++S.seq;
    hideTip(true);
    const prevFocus = S.focus;
    if (push && S.hist[S.hist.length - 1] !== id) S.hist.push(id);
    if (S.hist.length > 12) S.hist.splice(0, S.hist.length - 12);
    if (prevFocus !== id) S.expanded = { left: 0, right: 0, top: 0, bottom: 0 };
    S.focus = id;
    renderHeader(id, null);
    E.root.classList.add('wb-loading');
    let doc;
    try { doc = await loadDoc(id); } catch (e) { console.warn('[web] load', id, e); doc = null; }
    if (seq !== S.seq) return;
    E.root.classList.remove('wb-loading');
    if (!doc) { toast('关系数据读不出来'); return; }
    S.doc = doc;
    S.model = buildModel(doc);
    choose(S.model);
    renderHeader(id, doc);
    const ids = [id, ...S.model.visible.map((p) => p.id)];
    renderEmpty();
    transitionTo(prevFocus);
    renderSide();
    loadEdgesBg();
    // weather for every visible company, then the measured ties if the file carried none
    Promise.all(ids.map(loadStock)).then(() => {
      if (seq !== S.seq) return;
      for (const n of S.nodes.values()) paintNode(n, true);
      renderHeader(id, doc);
      renderSide();
      if (!doc.measured.length && !doc._measuredClient) measureClient(doc, seq);
    });
  }

  async function measureClient(doc, seq) {
    doc._measuredClient = true;
    const F = doc.id, fs = await loadStock(F);
    const rf = rets(fs?.c, 125);
    if (!rf) return;
    const peers = (fs?.peers || []).map((p) => String(p).replace(/^s:/, ''));
    const cand = [...new Set([...S.model.list.map((p) => p.id), ...peers])].filter((x) => x !== F && stockKnown(x)).slice(0, 24);
    await Promise.all(cand.map(loadStock));
    if (seq !== S.seq) return;
    const out = [];
    for (const o of cand) {
      const ro = rets(S.stocks.get(o)?.c, 125);
      if (!ro) continue;
      const r0 = corr(rf.slice(-120), ro.slice(-120));
      if (isNum(r0) && r0 >= 0.6) out.push({ a: F, b: o, type: 'comove', corr: +r0.toFixed(2), window: 120, est: false, source: '价格测量：近 120 个交易日的日涨跌相关（页面现算）' });
      let best = null;
      for (let k = 1; k <= 5; k++) {
        const a = corr(rf.slice(-120 - k, -k), ro.slice(-120)), b = corr(ro.slice(-120 - k, -k), rf.slice(-120));
        for (const [lead, lag, v] of [[F, o, a], [o, F, b]]) if (isNum(v) && v >= 0.3 && (!best || v > best[2])) best = [lead, lag, v, k];
      }
      if (best) out.push({ a: best[0], b: best[1], lead: best[0], lag: best[1], type: 'leadlag', days: best[3], corr: +best[2].toFixed(2), window: 120, est: false, source: `价格测量：${best[0]} 的涨跌常领先 ${best[1]} 约 ${best[3]} 天（页面现算）` });
    }
    if (!out.length) return;
    doc.measured = out;
    // add to the current picture without pushing anyone out: measured-only ties just fill empty seats
    const before = new Set(S.model.visible.map((p) => p.id));
    const room = MAX_NEIGHBOURS + Object.values(S.expanded).reduce((a, b) => a + b, 0) * EXPAND_STEP - before.size;
    S.model = buildModel(doc);
    const extra = S.model.list.filter((p) => !before.has(p.id) && p.rels.length === 0).slice(0, Math.max(0, room));
    const vis = new Set([...before, ...extra.map((p) => p.id)]);
    S.model.visible = S.model.list.filter((p) => vis.has(p.id));
    S.model.total = {}; S.model.hidden = {};
    for (const z in ZONE_CAP) {
      S.model.total[z] = S.model.list.filter((p) => p.zone === z).length;
      S.model.hidden[z] = S.model.total[z] - S.model.visible.filter((p) => p.zone === z).length;
    }
    if (extra.length) transitionTo(F, { soft: true });
    else { syncEdges(); layoutEdges(); kick(); }
    renderSide();
  }

  function transitionTo(prevFocus, { soft = false } = {}) {
    const model = S.model;
    const L = computeLayout(model);
    S.layout = L;
    const origin = S.nodes.get(model.F);
    const ox = origin ? origin.x : L.cx, oy = origin ? origin.y : L.cy;
    const keepIds = new Set(L.pos.keys());
    for (const [id, t] of L.pos) {
      let n = S.nodes.get(id);
      if (!n) {
        n = makeNode(id);
        n.x = ox; n.y = oy; n.r = t.r * 0.4; n.a = 0;
        if (id === model.F) { n.x = t.x; n.y = t.y; n.r = t.r * 0.7; }
      }
      n.from = { x: n.x, y: n.y, r: n.r, a: n.a };
      n.to = { x: t.x, y: t.y, r: t.r, a: 1 };
      const zoneChanged = n.zone !== t.zone || !!n.flip !== !!t.inner;
      n.zone = t.zone;
      n.flip = !!t.inner;                 // inner-ring labels sit on the inward side, clear of the outer ring
      n.focus = id === model.F;
      n.labelSwap = zoneChanged && n.from.a > 0.2;
      n.leaving = false;
      n.el.classList.toggle('wb-focus', n.focus);
      buildLabel(n);
      paintNode(n, true);
    }
    for (const [id, n] of S.nodes) {
      if (keepIds.has(id)) continue;
      n.from = { x: n.x, y: n.y, r: n.r, a: n.a };
      const dx = n.x - L.cx, dy = n.y - L.cy, d = Math.hypot(dx, dy) || 1;
      n.to = { x: n.x + (dx / d) * 40, y: n.y + (dy / d) * 40, r: n.r * 0.6, a: 0 };
      n.leaving = true;
      n.labelSwap = false;
    }
    syncEdges(prevFocus !== model.F);       // same focus (展开 / new measured ties): edges stay and glide
    renderZones();
    drawBackdrop();
    // weather for anyone new on screen (expand / measured-only arrivals) — painted when it lands
    const need = [...L.pos.keys()].filter((id) => !S.stocks.has(id) && stockKnown(id));
    if (need.length) {
      const seq = S.seq;
      Promise.all(need.map(loadStock)).then(() => {
        if (seq !== S.seq) return;
        for (const id of need) { const n = S.nodes.get(id); if (n) paintNode(n, true); }
      });
    }
    S.tween = { t0: performance.now(), dur: REDUCED ? 1 : soft ? 420 : TWEEN_MS };
    kick();
  }

  // ─────────── nodes
  function makeNode(id) {
    const g = svg('g', { class: 'wb-node', 'data-id': id }, E.nodes);
    const body = svg('g', { class: 'wb-nb' }, g);
    const n = { id, el: g, body, x: 0, y: 0, r: 10, a: 0, zone: null };
    n.hit = svg('circle', { class: 'wb-hit' }, body);
    n.halo1 = svg('circle', { class: 'wb-halo' }, body);
    n.halo2 = svg('circle', { class: 'wb-halo wb-halo2' }, body);
    n.drop = svg('circle', { class: 'wb-drop' }, body);
    n.track = svg('circle', { class: 'wb-track' }, body);
    n.ring = svg('path', { class: 'wb-ring' }, body);
    const cid = 'wbc-' + Math.random().toString(36).slice(2, 9);
    const cp = svg('clipPath', { id: cid }, body);
    n.clip = svg('circle', { cx: 0, cy: 0 }, cp);
    const cg = svg('g', { 'clip-path': `url(#${cid})` }, body);
    n.shade = svg('circle', { class: 'wb-shade' }, cg);
    n.lit = svg('circle', { class: 'wb-lit' }, cg);
    n.rim = svg('circle', { class: 'wb-rim' }, body);
    n.inner = svg('text', { class: 'wb-inner', 'text-anchor': 'middle' }, body);
    n.season = svg('g', { class: 'wb-season' }, body);
    n.seasonBg = svg('circle', { r: 8.6 }, n.season);
    n.seasonUse = svg('use', { x: -6, y: -6, width: 12, height: 12 }, n.season);
    n.label = svg('g', { class: 'wb-label' }, body);
    S.nodes.set(id, n);
    g.addEventListener('pointerenter', (ev) => onNodeEnter(n, ev));
    g.addEventListener('pointermove', (ev) => { if (S.hot?.node === n.id && !S.pinned) placeTip(ev); });
    g.addEventListener('pointerleave', () => onNodeLeave(n));
    g.addEventListener('click', (ev) => { ev.stopPropagation(); onNodeClick(n); });
    return n;
  }

  function buildLabel(n) {
    const lab = n.label;
    lab.replaceChildren();
    const i = info(n.id);
    if (n.focus) {
      // name inside the disc (the header repeats it big); ticker as a small second line
      const t1 = svg('text', { class: 'wb-fname', 'text-anchor': 'middle' }, lab);
      t1.textContent = i.name;
      const t2 = svg('text', { class: 'wb-ftk', 'text-anchor': 'middle' }, lab);
      t2.textContent = i.priv ? '未上市' : i.name === n.id ? '' : n.id;
      n.t1 = t1; n.t2 = t2; n.fit = 0;
      n.inner.textContent = '';
      return;
    }
    n.inner.textContent = '';
    const p = S.model?.pairs.get(n.id);
    const out = n.zone === 'left' ? -1 : n.zone === 'right' ? 1 : 0;
    const side = n.flip ? -out : out;
    const anchor = side < 0 ? 'end' : side > 0 ? 'start' : 'middle';
    const t1 = svg('text', { class: 'wb-nm', 'text-anchor': anchor }, lab);
    t1.textContent = shortName(i.name);
    const t2 = svg('text', { class: 'wb-sub', 'text-anchor': anchor }, lab);
    const tk = svg('tspan', { class: 'wb-sub-tk' }, t2);
    tk.textContent = i.priv ? '未上市' : i.name === n.id ? '' : n.id;
    const known = p?.flows?.filter((x) => x.known) || [];
    const fy = known.filter((x) => x.yearly).sort((a, b) => b.yearB - a.yearB)[0];
    const fo = known.flatMap((x) => x.ones).sort((a, b) => b.mk.usdB - a.mk.usdB)[0];
    if (fy || fo) {
      // the yearly money (what the band width shows) and a one-off deal each keep their own label
      if (fy) {
        const m = svg('tspan', { class: 'wb-sub-money' + (fy.est ? ' est' : '') }, t2);
        m.textContent = `  ${fy.est ? '≈' : ''}${yearText(fy)}`;
      }
      if (fo && (!fy || sizeOf(fo.mk) > fy.yearB)) {      // a smaller deal stays on the tick / hover / ledger
        const m = svg('tspan', { class: 'wb-sub-once' + (isEst(fo.e) ? ' est' : '') }, t2);
        m.textContent = `${fy ? ' · ' : '  '}${isEst(fo.e) ? '≈' : ''}${fo.mk.tag}${yi(fo.mk.usdB)}`;
      }
    } else if (p && !p.rels.length && p.measured.length) {
      const c = p.measured.find((m) => m.type === 'comove');
      const ll = p.measured.find((m) => m.type === 'leadlag');
      const m = svg('tspan', { class: 'wb-sub-meas' }, t2);
      m.textContent = c ? `  同涨同跌 ${c.corr?.toFixed?.(2) ?? ''}` : ll ? (ll.lead === n.id ? `  先动 ${ll.days ?? ''} 天` : `  晚 ${ll.days ?? ''} 天跟`) : '';
    }
    if (p && p.fresh) {
      const nw = svg('tspan', { class: 'wb-sub-new' }, t2);
      nw.textContent = '  新';
    }
    if (p && p.est) {
      const sg = svg('g', { class: 'wb-nseal' }, lab);
      svg('rect', { x: -7, y: -7, width: 14, height: 14, rx: 2.5 }, sg);
      const st = svg('text', { 'text-anchor': 'middle', y: 3.6 }, sg);
      st.textContent = '估';
      n.seal = sg;
    } else n.seal = null;
    n.t1 = t1; n.t2 = t2;
  }

  /** geometry + colours; cheap enough to run every frame of a tween */
  function paintNode(n, colours) {
    const r = Math.max(1, n.r);
    n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    n.el.style.opacity = n.a.toFixed(3);
    n.hit.setAttribute('r', r + 9);
    n.drop.setAttribute('r', r); n.drop.setAttribute('cx', 1.4); n.drop.setAttribute('cy', 2.2);
    n.clip.setAttribute('r', r);
    n.shade.setAttribute('r', r);
    n.lit.setAttribute('r', r); n.lit.setAttribute('cx', -r * 0.24); n.lit.setAttribute('cy', -r * 0.27);
    n.rim.setAttribute('r', r);
    n.track.setAttribute('r', r + 4.6);
    n.halo1.setAttribute('r', n.focus ? r + 11 : 0);
    n.halo2.setAttribute('r', n.focus ? r + 17 : 0);
    n.inner.setAttribute('y', 4);
    const w = wx(n.id);
    // wind ring: an arc from 12 o'clock, clockwise = money in (若竹), anticlockwise = out (臙脂)
    const rr = r + 4.6;
    if (w && isNum(w.wind) && Math.abs(w.wind) >= 0.5) {
      const frac = clamp(Math.abs(w.wind) / 3, 0.12, 0.999);
      const ang = frac * 2 * Math.PI * (w.wind > 0 ? 1 : -1);
      const x = rr * Math.sin(ang), y = -rr * Math.cos(ang);
      const large = frac > 0.5 ? 1 : 0, sweep = w.wind > 0 ? 1 : 0;
      n.ring.setAttribute('d', `M0,${-rr} A${rr},${rr} 0 ${large} ${sweep} ${x.toFixed(2)},${y.toFixed(2)}`);
      n.ring.setAttribute('class', 'wb-ring ' + (w.wind > 0 ? 'in' : 'out'));
    } else n.ring.setAttribute('d', '');
    // season glyph
    const sz = n.focus ? 0.78 : 0.76;
    const sa = n.zone === 'top' ? Math.PI / 4 : -Math.PI / 4;
    if (w && w.season) {
      n.season.style.display = '';
      n.season.setAttribute('transform', `translate(${(Math.cos(sa) * r * sz + (n.focus ? 4 : 2)).toFixed(1)},${(Math.sin(sa) * r * sz + (n.zone === 'top' ? 2 : -2)).toFixed(1)})${n.focus ? ' scale(1.25)' : ''}`);
      n.seasonUse.setAttribute('href', '#wb-i-' + w.season.key);
      n.season.setAttribute('class', 'wb-season s-' + w.season.key);
    } else n.season.style.display = 'none';
    // labels
    placeLabel(n, r);
    if (!colours) return;
    const i = info(n.id);
    let base;
    if (i.priv) base = null;
    else if (w && isNum(w.temp)) base = tempColor(w.temp);
    else base = S.colors.nodata || '#ddd5c4';
    n.el.classList.toggle('wb-priv', !!i.priv);
    n.el.classList.toggle('wb-nowx', !i.priv && !(w && isNum(w.temp)));
    if (base) {
      n.lit.style.fill = base;
      n.shade.style.fill = mix(base, S.colors.shade || '#2a3350', S.theme === 'night' ? 0.32 : 0.2);
      const dark = lum(base) > 0.6;
      n.inner.style.fill = dark ? (S.theme === 'night' ? '#16213a' : S.colors.ink) : '#fbf7ee';
      if (n.focus && n.t1) {
        const ink = dark ? '#1b2640' : '#fbf7ee';
        n.t1.style.fill = ink; n.t2.style.fill = ink;
        n.label.classList.toggle('on-dark', !dark);
      }
    } else {
      n.lit.style.fill = ''; n.shade.style.fill = ''; n.inner.style.fill = '';
    }
  }

  function placeLabel(n, r) {
    const lab = n.label;
    if (n.focus) {
      const t1 = n.t1, t2 = n.t2;
      if (!t1 || !t2) return;
      if (!n.fit) {
        // shrink the name until it sits inside the disc; give up on it (ticker only) when it can't
        let fs = 16, w = 0;
        for (; fs >= 11; fs--) { t1.style.fontSize = fs + 'px'; try { w = t1.getComputedTextLength(); } catch { w = 0; } if (w && w <= FOCUS_R * 1.7) break; }
        n.fit = w && w <= FOCUS_R * 1.75 ? fs : -1;
        t1.style.display = n.fit > 0 ? '' : 'none';
        t2.classList.toggle('solo', n.fit < 0);
      }
      const k = r / FOCUS_R;
      if (n.fit > 0) { t1.setAttribute('x', 0); t1.setAttribute('y', (t2.textContent ? 3 : 5.5) * k); t2.setAttribute('x', 0); t2.setAttribute('y', 16 * k); }
      else { t2.setAttribute('x', 0); t2.setAttribute('y', 4); }
      n.label.setAttribute('transform', k < 0.98 ? `scale(${k.toFixed(3)})` : '');
      return;
    }
    n.label.removeAttribute('transform');
    const gap = 10;
    let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    const out = n.zone === 'left' ? -1 : n.zone === 'right' ? 1 : 0;
    const side = n.flip ? -out : out;
    if (side < 0) { x1 = x2 = -(r + gap); y1 = -2; y2 = 12.5; }
    else if (side > 0) { x1 = x2 = r + gap; y1 = -2; y2 = 12.5; }
    else if (n.zone === 'top') { y1 = -(r + 22); y2 = -(r + 8.5); }
    else { y1 = r + 18; y2 = r + 31.5; }
    if (n.t1) { n.t1.setAttribute('x', x1); n.t1.setAttribute('y', y1); }
    if (n.t2) { n.t2.setAttribute('x', x2); n.t2.setAttribute('y', y2); }
    if (n.seal) {
      let len = 0;
      try { len = n.t1.getComputedTextLength(); } catch { len = 40; }
      let sx, sy = y1 - 4.5;
      if (side < 0) sx = x1 - len - 11;
      else if (side > 0) sx = x1 + len + 11;
      else sx = len / 2 + 11;
      n.seal.setAttribute('transform', `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
    }
  }

  // ─────────── edges
  function syncEdges(fresh = false) {
    const model = S.model;
    const want = new Map(model.visible.map((p) => [p.id, p]));
    for (const [id, e] of S.edges) {
      if (!want.has(id) || fresh) {
        e.leaving = true; e.from = e.a; e.to = 0;
        S.edges.delete(id);
        S.dying = S.dying || [];
        S.dying.push(e);
      }
    }
    for (const [id, p] of want) {
      let e = S.edges.get(id);
      if (!e) { e = makeEdge(p); S.edges.set(id, e); e.a = 0; }
      e.p = p;
      e.from = e.a; e.to = 1;
      styleEdge(e);
    }
    layoutEdges();
  }

  function makeEdge(p) {
    const g = svg('g', { class: 'wb-edge', 'data-id': p.id }, E.edges);
    const e = { id: p.id, el: g, p, a: 0, parts: [] };
    e.hitp = svg('path', { class: 'wb-ehit' }, g);
    e.band = svg('path', { class: 'wb-band' }, g);
    e.line = svg('path', { class: 'wb-line' }, g);
    e.meas = svg('path', { class: 'wb-meas' }, g);
    e.chev = svg('path', { class: 'wb-chev', d: 'M-3.2,-3.6 L1.4,0 L-3.2,3.6' }, g);
    e.tick = svg('path', { class: 'wb-tick' }, g);         // a one-off deal: a dashed cross-tick, outside the band
    e.mchev = svg('path', { class: 'wb-mchev', d: 'M-2.8,-3.2 L1.2,0 L-2.8,3.2' }, g);
    e.seal = svg('g', { class: 'wb-eseal' }, E.eseals);
    svg('rect', { x: -7, y: -7, width: 14, height: 14, rx: 2.5 }, e.seal);
    svg('text', { 'text-anchor': 'middle', y: 3.6 }, e.seal).textContent = '估';
    for (const el of [e.hitp, e.band, e.line, e.meas]) {
      el.addEventListener('pointerenter', (ev) => onEdgeEnter(e, ev));
      el.addEventListener('pointermove', (ev) => { if (S.hot?.edge === e.id && !S.pinned) placeTip(ev); });
      el.addEventListener('pointerleave', () => onEdgeLeave(e));
      el.addEventListener('click', (ev) => { ev.stopPropagation(); pinEdge(e, ev); });
    }
    return e;
  }

  function styleEdge(e) {
    const p = e.p;
    const known = p.flows.filter((f) => f.known);
    // band = money per year only (contract totals spread over their term); one-off deals never widen it
    const usd = known.reduce((s, f) => s + (f.yearly ? f.yearB : 0), 0);
    e.w = bandW(usd);
    e.once = known.reduce((s, f) => s + f.ones.reduce((t, o) => t + o.mk.usdB, 0), 0);
    e.hasBand = e.w > 0;
    e.hasLine = !e.hasBand && p.rels.length > 0;
    e.hasMeas = p.measured.length > 0;
    e.lead = p.measured.find((m) => m.type === 'leadlag') || null;
    e.est = p.rels.length > 0 && known.length ? known.every((f) => f.est) : p.est;
    e.dirs = p.flows.map((f) => ({ dir: f.dir, w: f.yearly ? bandW(f.yearB) : 0, est: f.est, known: f.yearly }));
    e.el.classList.toggle('est', !!e.est);
    e.el.classList.toggle('both', e.hasMeas && (e.w > 0 || p.rels.length > 0));
    e.el.classList.toggle('flow', p.flows.length > 0);
    e.el.classList.toggle('rival', p.zone === 'top' && !p.flows.length);
    e.el.classList.toggle('fresh', !!p.fresh);
    e.band.style.strokeWidth = e.w ? e.w.toFixed(1) : '0';
    e.band.style.display = e.hasBand ? '' : 'none';
    e.line.style.display = e.hasLine ? '' : 'none';
    e.meas.style.display = e.hasMeas ? '' : 'none';
    e.mchev.style.display = e.lead ? '' : 'none';
    e.chev.style.display = p.flows.length && (e.hasBand || e.hasLine) ? '' : 'none';
    e.hasTick = e.once > 0 && (e.hasBand || e.hasLine);
    e.tick.style.display = e.hasTick ? '' : 'none';
    e.tick.classList.toggle('est', known.some((f) => f.ones.some((o) => isEst(o.e))) && !known.some((f) => f.ones.some((o) => !isEst(o.e))));
    e.seal.style.display = e.est && !p.est && (e.hasBand || e.hasLine) ? '' : 'none';
    e.hitp.style.strokeWidth = Math.max(14, (e.w || 2) + 10);
  }

  /** recompute every edge path from the nodes' current positions (Sankey-style ports on the focus) */
  function layoutEdges() {
    const F = S.nodes.get(S.model?.F);
    if (!F) return;
    const R = F.r;
    const byZone = { left: [], right: [], top: [], bottom: [] };
    for (const e of S.edges.values()) { const z = e.p.zone; if (byZone[z]) byZone[z].push(e); }
    for (const z in byZone) {
      const list = byZone[z];
      const vert = z === 'left' || z === 'right';
      list.sort((a, b) => { const na = S.nodes.get(a.id), nb = S.nodes.get(b.id); return vert ? na.y - nb.y : na.x - nb.x; });
      const m = list.length, span = Math.min(R * 1.1, 7 * (m - 1));
      list.forEach((e, k) => { e.port = m === 1 ? 0 : -span / 2 + (span * k) / (m - 1); });
    }
    const all = [...S.edges.values(), ...(S.dying || [])];
    for (const e of all) geomEdge(e, F);
  }

  function geomEdge(e, F) {
    const n = S.nodes.get(e.id);
    if (!n) return;
    const z = e.p.zone, R = F.r, o = clamp(e.port || 0, -R * 0.8, R * 0.8), rn = n.r;
    const off = Math.sqrt(Math.max(0, R * R - o * o));
    let g;
    if (z === 'left' || z === 'right') {
      const s = z === 'left' ? -1 : 1;
      const p0 = [F.x + s * off, F.y + o], p1 = [n.x - s * rn, n.y];
      const mx = (p0[0] + p1[0]) / 2;
      g = [p0[0], p0[1], mx, p0[1], mx, p1[1], p1[0], p1[1]];
    } else {
      const s = z === 'top' ? -1 : 1;
      const p0 = [F.x + o, F.y + s * off], p1 = [n.x, n.y - s * rn];
      const my = (p0[1] + p1[1]) / 2;
      g = [p0[0], p0[1], p0[0], my, p1[0], my, p1[0], p1[1]];
    }
    e.g = g;
    e.T = lut(g);
    const d = gPath(g);
    e.band.setAttribute('d', d); e.line.setAttribute('d', d); e.hitp.setAttribute('d', e.hasMeas && !e.hasBand && !e.hasLine ? '' : d);
    // measured tie: a straight dashed chord, nudged aside when it would sit on top of the band
    if (e.hasMeas) {
      const dx = n.x - F.x, dy = n.y - F.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const nudge = e.hasBand || e.hasLine ? (e.w || 2) / 2 + 6 : 0;
      const nx = -uy * nudge, ny = ux * nudge;
      const a = [F.x + ux * (R + 3) + nx, F.y + uy * (R + 3) + ny], b = [n.x - ux * (rn + 5) + nx, n.y - uy * (rn + 5) + ny];
      e.meas.setAttribute('d', `M${a[0].toFixed(1)},${a[1].toFixed(1)} L${b[0].toFixed(1)},${b[1].toFixed(1)}`);
      if (!e.hasBand && !e.hasLine) e.hitp.setAttribute('d', `M${a[0].toFixed(1)},${a[1].toFixed(1)} L${b[0].toFixed(1)},${b[1].toFixed(1)}`);
      e.mchord = [a, b];
      if (e.lead) {
        const toOther = e.lead.lag === e.id;        // arrow points at whoever follows
        const t = 0.5, px = lerp(a[0], b[0], t), py = lerp(a[1], b[1], t);
        const ang = Math.atan2(toOther ? uy : -uy, toOther ? ux : -ux) * 180 / Math.PI;
        e.mchev.setAttribute('transform', `translate(${px.toFixed(1)},${py.toFixed(1)}) rotate(${ang.toFixed(1)})`);
      }
    }
    // direction chevron (static cue) + 估 seal
    if (e.p.flows.length) {
      const fsz = (f) => (f.yearly ? f.yearB : f.ones.length ? f.ones[0].mk.usdB / 5 : 0);
      const main = e.p.flows.slice().sort((a, b) => fsz(b) - fsz(a))[0];
      const u = 0.6, t = tAt(e.T, main.dir > 0 ? u : 1 - u);
      const [x, y] = bz(g, t), [tx, ty] = bzTan(g, t);
      const ang = Math.atan2(main.dir > 0 ? ty : -ty, main.dir > 0 ? tx : -tx) * 180 / Math.PI;
      e.chev.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${ang.toFixed(1)})`);
    }
    if (e.hasTick) {
      // across the line near the neighbour (clear of the chevron and the 估 seal); longer = bigger deal
      const [x, y] = bz(g, tAt(e.T, 0.8)), [tx, ty] = bzTan(g, tAt(e.T, 0.8));
      const L0 = Math.hypot(tx, ty) || 1, nx = -ty / L0, ny = tx / L0;
      const L = (e.w || 1.5) / 2 + clamp(4 + 1.6 * Math.sqrt(e.once), 5, 11);
      e.tick.setAttribute('d', `M${(x - nx * L).toFixed(1)},${(y - ny * L).toFixed(1)} L${(x + nx * L).toFixed(1)},${(y + ny * L).toFixed(1)}`);
    }
    if (e.seal.style.display !== 'none') {
      const [x, y] = bz(g, tAt(e.T, 0.36));
      e.seal.setAttribute('transform', `translate(${x.toFixed(1)},${(y - (e.w || 2) / 2 - 9).toFixed(1)})`);
    }
  }

  // ─────────── zones (headings + expand)
  function renderZones() {
    const L = S.layout, model = S.model;
    if (!L) return;
    E.zones.replaceChildren();
    for (const z of Object.keys(ZONES)) {
      const tot = model.total?.[z] || 0;
      const Z = ZONES[z];
      if (!tot) {
        if ((z === 'left' || z === 'right') && model.list.length) {
          const busy = coBusy(model.F);
          const say = busy ? '侦察兵在查…' : z === 'left' ? '还没查到它付钱给谁' : '还没查到谁付钱给它';
          const d = h('div', 'wb-zone-empty' + (busy ? ' busy' : ''), `<i>${busy ? '<em class="svw-dot"></em>' : ''}</i><b>${esc(Z.name)}</b><span>${say}</span>`, E.zones);
          d.style.left = (L.cx + (z === 'left' ? -1 : 1) * L.rx * 0.82) + 'px';
          d.style.top = L.cy + 'px';
        }
        continue;
      }
      const shown = tot - (model.hidden?.[z] || 0);
      const ps = [...L.pos.entries()].filter(([, p]) => p.zone === z);
      let x, y, cls;
      if (z === 'left') { x = Math.max(18, L.cx - L.rx - 128); y = 16; cls = 'l'; }
      else if (z === 'right') { x = Math.min(S.W - 18, L.cx + L.rx + 128); y = 16; cls = 'r'; }
      else {
        // a row header just left of its row, clear of the leftmost label
        let edge = L.cx;
        for (const [id, p] of ps) {
          const i = info(id), nd = S.nodes.get(id);
          const l1 = nd?.t1?.textContent || shortName(i.name), l2 = nd?.t2?.textContent || (i.priv ? '未上市 000亿' : id + ' 000亿');
          const half = Math.max(p.r + 4, textW(l1, 13) / 2 + (nd?.seal ? 18 : 0), textW(l2, 10.5) / 2);
          edge = Math.min(edge, p.x - half);
        }
        const rowY = ps.length ? ps.reduce((s2, [, p]) => s2 + p.y, 0) / ps.length : (z === 'top' ? L.cy - L.ry : L.cy + L.ry);
        x = Math.max(150, edge - 18); y = rowY + (z === 'top' ? -14 : 12); cls = 'r row';
      }
      const more = shown < tot ? `展开其余 ${tot - shown} 家` : S.expanded[z] ? '收起' : '';
      const d = h('div', `wb-zone ${cls} z-${z}`, `
        <div class="wb-zt"><b>${esc(Z.name)}</b><span>${esc(Z.sub)}</span></div>
        <div class="wb-zc">${shown < tot ? `显示 ${shown} / ${tot} 家` : `${tot} 家`}${more ? ` · <button type="button" class="wb-more">${more}</button>` : ''}</div>`, E.zones);
      d.querySelector('.wb-more')?.addEventListener('click', () => {
        if (shown < tot) S.expanded[z]++; else S.expanded[z] = 0;
        choose(S.model);
        transitionTo(S.model.F, { soft: true });
        renderSide();
      });
      d.style.left = x + 'px';
      d.style.top = y + 'px';
      if (cls.includes('row')) d.style.transform = 'translate(-100%, -50%)';
    }
  }

  // ─────────── render loop
  function kick() {
    if (!S.open || S.raf) return;
    S.last = performance.now();
    S.raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    S.raf = 0;
    if (!S.open || document.hidden) return;
    const dt = Math.min(0.05, (now - S.last) / 1000);
    S.last = now;
    if (S.tween) {
      const k = clamp((now - S.tween.t0) / S.tween.dur, 0, 1), p = ease(k);
      for (const n of S.nodes.values()) {
        if (!n.from) continue;
        n.x = lerp(n.from.x, n.to.x, p); n.y = lerp(n.from.y, n.to.y, p);
        n.r = lerp(n.from.r, n.to.r, p); n.a = lerp(n.from.a, n.to.a, p);
        if (n.labelSwap) n.label.style.opacity = Math.abs(1 - 2 * p).toFixed(2);
        else n.label.style.opacity = '';
        paintNode(n, false);
      }
      for (const e of S.edges.values()) e.a = lerp(e.from, e.to, smooth(0.55, 1, k));
      for (const e of S.dying || []) e.a = lerp(e.from, 0, smooth(0, 0.3, k));
      layoutEdges();
      for (const e of [...S.edges.values(), ...(S.dying || [])]) { e.el.style.opacity = e.a.toFixed(3); e.seal.style.opacity = e.a.toFixed(3); }
      if (k >= 1) {
        S.tween = null;
        for (const [id, n] of S.nodes) {
          if (n.leaving) { n.el.remove(); S.nodes.delete(id); continue; }
          n.from = null; n.label.style.opacity = '';
          paintNode(n, true);
        }
        for (const e of S.dying || []) { e.el.remove(); e.seal.remove(); }
        S.dying = [];
        layoutEdges();
        if (S.hot) applyHot();
      }
    }
    drawParticles(dt);
    if (!REDUCED || S.tween) S.raf = requestAnimationFrame(frame);
  }

  // particles: short tapered ink strokes with a round head, running payer → payee (anime wind-lines, §17)
  function drawParticles(dt) {
    const ctx = E.ctx, dpr = S.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S.W, S.H);
    ctx.lineCap = 'round';
    ctx.strokeStyle = S.colors.particle || '#1f2b45';
    ctx.fillStyle = S.colors.particle || '#1f2b45';
    const hot = S.hot;
    for (const e of S.edges.values()) {
      if (!e.T || !e.dirs?.length || !(e.hasBand || e.hasLine) || e.a < 0.02) continue;
      const len = e.T.len;
      if (len < 8) continue;
      const dim = hot && hot.edge !== e.id && hot.node !== e.id ? 0.2 : 1;
      if (!e.parts.length || e.partsLen !== e.dirs.length) seedParticles(e);
      for (const q of e.parts) {
        const d = e.dirs[q.lane];
        if (!d) continue;
        q.u += (q.v * dt) / len;
        if (q.u > 1) q.u -= 1;
        const w = d.w || 1.2;
        const lw = clamp(1.2 + w * 0.15, 1.2, 3);
        const tailPx = 7 + w * 0.9;
        const fade = smooth(0, 0.07, q.u) * (1 - smooth(0.88, 1, q.u));
        const alpha = e.a * fade * dim * (d.est ? 0.42 : d.known ? 0.7 : 0.45);
        if (alpha < 0.02) continue;
        const lane = (e.dirs.length > 1 ? (q.lane === 0 ? -1 : 1) * Math.max(1.5, w * 0.22) : 0) + q.off * Math.max(0, w - 3.5) * 0.3;
        // three segments, thinner and fainter towards the tail
        let prev = null;
        for (let s2 = 0; s2 <= 3; s2++) {
          const uu = clamp(q.u - (tailPx / len) * (1 - s2 / 3), 0, 1);
          const t = tAt(e.T, d.dir > 0 ? uu : 1 - uu);
          const [x, y] = bz(e.g, t), [tx, ty] = bzTan(e.g, t);
          const pt = [x - ty * lane, y + tx * lane];
          if (prev) {
            ctx.globalAlpha = alpha * (0.18 + 0.27 * s2);
            ctx.lineWidth = lw * (0.45 + 0.18 * s2);
            ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(pt[0], pt[1]); ctx.stroke();
          }
          prev = pt;
        }
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(prev[0], prev[1], lw * 0.62, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  function seedParticles(e) {
    e.parts = [];
    e.partsLen = e.dirs.length;
    const len = e.T.len;
    e.dirs.forEach((d, lane) => {
      const spacing = d.known ? clamp(86 - d.w * 3.2, 36, 86) : 130;
      const n = Math.max(1, Math.round(len / spacing));
      for (let k = 0; k < n; k++) {
        e.parts.push({ lane, u: (k + Math.random() * 0.6) / n, v: (d.known ? 46 + d.w * 1.6 : 38) * (0.85 + Math.random() * 0.3), off: Math.random() * 2 - 1 });
      }
    });
  }

  // ─────────── interaction
  function wireStage() {
    E.stage.addEventListener('click', () => { if (S.pinned) hideTip(true); });
    E.tip.addEventListener('pointerenter', () => { clearTimeout(S.tipT); });
    E.tip.addEventListener('pointerleave', () => { if (!S.pinned) scheduleHide(); });
    E.tip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const b = ev.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'why') whyEdge(S.tip, b);
      else if (act === 'ask') {
        const j = S.jobs.get(edgeFacts(S.tip.id).key);
        if (j && !isLive(j)) S.jobs.delete(j.key);              // 再查一次: a fresh job
        askAbout(S.tip, b); b.disabled = true; const sp = b.querySelector('span'); if (sp) sp.textContent = '侦察兵在查…';
      }
      else if (act === 'go') { hideTip(true); focusOn(b.dataset.id); }
      else if (act === 'fix') openFix(S.tip);
      else if (act === 'fix-save') saveFix(S.tip);
      else if (act === 'unfix') unfix(S.tip);
    });
  }

  function onNodeEnter(n, ev) {
    if (S.pinned || S.tween) return;
    S.hot = { node: n.id };
    applyHot();
    showTip({ kind: 'node', id: n.id }, ev);
  }
  function onNodeLeave(n) {
    if (S.pinned) return;
    if (S.hot?.node === n.id) { S.hot = null; applyHot(); }
    scheduleHide();
  }
  function onNodeClick(n) {
    if (S.tween) return;
    if (n.focus) { if (stockKnown(n.id)) { showTip({ kind: 'node', id: n.id }, null); } return; }
    hideTip(true);
    S.hot = null; applyHot();
    focusOn(n.id);
  }
  function onEdgeEnter(e, ev) {
    if (S.pinned || S.tween) return;
    S.hot = { edge: e.id };
    applyHot();
    showTip({ kind: 'edge', id: e.id }, ev);
  }
  function onEdgeLeave(e) {
    if (S.pinned) return;
    if (S.hot?.edge === e.id) { S.hot = null; applyHot(); }
    scheduleHide();
  }
  function pinEdge(e, ev) {
    S.hot = { edge: e.id };
    applyHot();
    showTip({ kind: 'edge', id: e.id }, ev);
    S.pinned = true;
    E.tip.classList.add('pinned');
  }

  function applyHot() {
    const hot = S.hot;
    E.stage.classList.toggle('wb-dim', !!hot);
    for (const n of S.nodes.values()) {
      const on = hot && (hot.node === n.id || hot.edge === n.id || n.focus);
      n.el.classList.toggle('wb-hot', !!on);
    }
    for (const e of S.edges.values()) {
      const on = hot && (hot.edge === e.id || hot.node === e.id);
      e.el.classList.toggle('wb-hot', !!on);
      e.seal.classList.toggle('wb-hot', !!on);
    }
    drawCross(hot?.node && hot.node !== S.model?.F ? hot.node : null);
  }

  /** second-degree: while hovering a neighbour, faint ties between it and the others on screen */
  function drawCross(id) {
    E.cross.replaceChildren();
    if (!id || !S.src) return;
    const on = new Set(S.edges.keys());
    const a = S.nodes.get(id);
    if (!a) return;
    const seen = new Set();
    for (const e of S.src.all.adj.get(id) || []) {
      const o = e.a === id ? e.b : e.a;
      if (!on.has(o) || seen.has(o)) continue;
      seen.add(o);
      const b = S.nodes.get(o);
      if (!b) continue;
      const mx = (a.x + b.x) / 2 + (S.layout.cx - (a.x + b.x) / 2) * 0.25, my = (a.y + b.y) / 2 + (S.layout.cy - (a.y + b.y) / 2) * 0.25;
      svg('path', { class: 'wb-xl', d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}` }, E.cross);
      b.el.classList.add('wb-hot');
    }
  }

  // ─────────── tips
  function scheduleHide() {
    clearTimeout(S.tipT);
    S.tipT = setTimeout(() => { if (!S.pinned) hideTip(); }, 260);
  }
  function hideTip(force) {
    clearTimeout(S.tipT);
    if (S.pinned && !force) return;
    S.whyRun?.stop?.();
    S.pinned = false;
    S.tip = null;
    if (E.tip) { E.tip.hidden = true; E.tip.classList.remove('pinned'); }
    if (force && S.hot) { S.hot = null; applyHot(); }
  }
  function showTip(tip, ev) {
    clearTimeout(S.tipT);
    S.tip = tip;
    E.tip.classList.remove('pinned');
    S.whyRun?.stop?.();
    E.tip.innerHTML = tip.kind === 'edge' ? edgeTipHTML(tip.id) : nodeTipHTML(tip.id);
    fillJobs(E.tip);
    E.tip.hidden = false;
    placeTip(ev);
  }
  function placeTip(ev) {
    const sr = E.stage.getBoundingClientRect();
    let x, y;
    if (ev) { x = ev.clientX - sr.left; y = ev.clientY - sr.top; }
    else { const n = S.nodes.get(S.tip?.id); x = n ? n.x : S.W / 2; y = n ? n.y : S.H / 2; }
    const tw = E.tip.offsetWidth || 320, th = E.tip.offsetHeight || 160;
    let left = x + 18, top = y + 16;
    if (left + tw > S.W - 10) left = x - tw - 18;
    if (top + th > S.H - 10) top = y - th - 16;
    E.tip.style.left = clamp(left, 8, Math.max(8, S.W - tw - 8)) + 'px';
    E.tip.style.top = clamp(top, 8, Math.max(8, S.H - th - 8)) + 'px';
    S.tipAt = { x, y };
  }
  /** the card grew (an answer landed in it): keep its corner, only pull it back on screen */
  function placeTipKeep() {
    if (!E.tip || E.tip.hidden) return;
    const tw = E.tip.offsetWidth, th = E.tip.offsetHeight;
    const left = parseFloat(E.tip.style.left) || 8, top = parseFloat(E.tip.style.top) || 8;
    E.tip.style.left = clamp(left, 8, Math.max(8, S.W - tw - 8)) + 'px';
    E.tip.style.top = clamp(top, 8, Math.max(8, S.H - th - 8)) + 'px';
  }

  function relLine(e, F) {
    const [payer, payee] = payerPayee(e);
    const nmA = info(payer || e.a).name, nmB = info(payee || e.b).name;
    const head = payer && payee
      ? `<b>${esc(nmA)}</b><span class="wb-arrow">付钱给</span><b>${esc(nmB)}</b>`
      : `<b>${esc(info(e.a).name)}</b><span class="wb-arrow">${e.type === 'competes' ? '对' : '和'}</span><b>${esc(info(e.b).name)}</b>`;
    const m = e.money;
    let money = '';
    if (m && isNum(m.usdB)) {
      const est = isEst(e);
      const range = isNum(m.usdBLow) && isNum(m.usdBHigh) ? `（${yi(m.usdBLow)}–${yi(m.usdBHigh)}）` : '';
      // the number as written, then what it is per year — the line's width only ever shows the per-year part
      const mk = e._mk || moneyOf(e);
      const yr = !mk ? ''
        : mk.kind === 'rec' ? (mk.per === 'year' ? '' : `折合每年约 ${yi(mk.yearB)} 美元`)
        : mk.kind === 'term' ? (mk.years ? `按 ${fmtYears(mk.years)} 年摊，每年约 ${yi(mk.yearB)} 美元 —— 线按这个粗细画`
          : `没写年限，先按 ${TERM_DEFAULT} 年摊：每年约 ${yi(mk.yearB)} 美元（线按这个画）`)
        : `${{ 存量: '存量，不是每年流过的钱', 担保: '担保，不是真付出去的钱', 贷款: '一笔贷款', 持股: '持股的市值', 投资: '一笔投资' }[mk.tag] || '一次性的钱'}：不算进线的粗细（线上那道虚线短杠）`;
      money = `<div class="wb-t-money">${est ? '<span class="wb-seal-i">估</span>约 ' : ''}<b>${yi(m.usdB)}</b> 美元${esc(perLong(m.per) ? ' · ' + perLong(m.per) : '')}${range}${m.what ? `<span class="wb-t-what">${esc(m.what)}</span>` : ''}${yr ? `<span class="wb-t-yr${mk.kind === 'one' ? ' once' : ''}">${esc(yr)}</span>` : ''}</div>`;
    } else if (payer && payee) {
      money = `<div class="wb-t-money muted">金额没有公开披露 —— 线画得细</div>`;
    }
    const share = [e.share?.ofTo, e.share?.ofFrom].filter(Boolean).map((s) => `<div class="wb-t-share">${esc(s)}</div>`).join('');
    const basis = isEst(e) ? `<div class="wb-t-basis">估算依据：${esc(e.money?.basis || e.basis || '产业链逻辑推断')} · 等你补数据</div>` : '';
    const owner = e.owner ? `<div class="wb-t-basis owner">这条是你补的数 <button type="button" class="wb-lnk" data-act="unfix">撤销</button></div>`
      : e.fixedBy ? `<div class="wb-t-basis owner">${esc(e.fixedBy)}的数</div>` : '';
    // provenance stays visible (§14): what the scout found, and the other numbers that were on the table
    const scout = e.scout ? `<div class="wb-t-basis scout">${e.est || e.money?.est ? '侦察兵估的数' : '侦察兵核实过'}${e.scout.at ? ` · ${esc(String(e.scout.at).slice(0, 10))}` : ''}${isNum(e.scout.conf) ? ` · 把握 ${Math.round(e.scout.conf * 10)} 成` : ''}</div>` : '';
    const alts = (Array.isArray(e.alt) ? e.alt : []).filter((x) => x && isNum(x.usdB)).slice(0, 2)
      .map((x) => `<div class="wb-t-alt">另一个说法：${x.est ? '约 ' : ''}${yi(x.usdB)} 美元${esc(perLong(x.per) ? ' · ' + perLong(x.per) : '')}${x.source ? `<span>${esc(String(x.source).slice(0, 60))}</span>` : ''}</div>`).join('');
    const src = [e.fixedBy ? e.money?.source : e.source || e.money?.source, e.asOf ? `截至 ${e.asOf}` : null, isNum(e.conf) ? `可信度 ${Math.round(e.conf * 100)}%` : null].filter(Boolean).map(esc).join(' · ');
    return `<div class="wb-t-rel"><div class="wb-t-h">${head}<span class="wb-chip">${esc(REL[e.type] || e.type)}</span>${e._new ? '<span class="wb-chip new">新</span>' : ''}</div>
      ${money}${share}${sayOf(e) ? `<p class="wb-t-say">${esc(sayOf(e))}</p>` : ''}${basis}${scout}${alts}${owner}
      ${src ? `<div class="wb-t-src">${src}</div>` : ''}</div>`;
  }
  function measLine(m) {
    if (m.type === 'leadlag') {
      return `<div class="wb-t-rel meas"><div class="wb-t-h"><b>${esc(info(m.lead).name)}</b><span class="wb-arrow">先动，</span><b>${esc(info(m.lag).name)}</b><span class="wb-arrow">${m.days ? `约 ${m.days} 天后跟` : '随后跟'}</span><span class="wb-chip meas">测量</span></div>
        <div class="wb-t-src">${esc(m.source || '价格测量')}${isNum(m.corr) ? ` · 相关 ${m.corr.toFixed(2)}` : ''}</div></div>`;
    }
    return `<div class="wb-t-rel meas"><div class="wb-t-h"><span>近 ${m.window || 120} 天<b>同涨同跌</b></span><span class="wb-num">${isNum(m.corr) ? m.corr.toFixed(2) : ''}</span><span class="wb-chip meas">测量</span></div>
      <div class="wb-t-src">${esc(m.source || '价格测量')} · 只是一起动，不代表有生意往来</div></div>`;
  }
  function edgeTipHTML(id) {
    const p = S.model.pairs.get(id);
    if (!p) return '';
    const F = S.model.F;
    const sz = (e) => sizeOf(e._mk || moneyOf(e)) || 0;
    const rels = p.rels.slice().sort((a, b) => sz(b) - sz(a) || (b.strength || 0) - (a.strength || 0));
    const shown = rels.slice(0, 3).map((e) => relLine(e, F)).join('');
    const more = rels.length > 3 ? `<div class="wb-t-more">还有 ${rels.length - 3} 条关系</div>` : '';
    const meas = p.measured.map(measLine).join('');
    const est = rels.find(isEst);
    const { key } = edgeFacts(id);
    const job = S.jobs.get(key);
    const money = rels.some((e) => payerPayee(e)[0]);
    const askLabel = est ? '让侦察兵核实金额' : money && !rels.some((e) => isNum(e.money?.usdB)) ? '让侦察兵查金额' : '让 Claude 去查';
    return `${shown}${more}${meas}
      <div class="wb-t-actions">
        <button type="button" class="wb-btn sm why" data-act="why" data-why="1" title="让老风上网查：这条钱最近为什么值得看（带日期和出处）"><b>为什么？</b></button>
        <button type="button" class="wb-btn sm" data-act="ask"${isLive(job) ? ' disabled' : ''}>${icon('search')}<span>${isLive(job) ? '侦察兵在查…' : job?.state === 'done' ? '再查一次' : askLabel}</span></button>
        ${est ? '<button type="button" class="wb-btn sm ghost" data-act="fix">我来补</button>' : ''}
        <button type="button" class="wb-btn sm ghost" data-act="go" data-id="${esc(id)}">以「${esc(shortName(info(id).name, 96, 12.5))}」为中心</button>
      </div>
      ${job ? `<div class="wb-job" data-job="${esc(key)}"></div>` : ''}`;
  }
  function nodeTipHTML(id) {
    const i = info(id), w = wx(id), p = S.model.pairs.get(id);
    const isF = id === S.model.F;
    const wxl = w ? `<div class="wb-t-wx">
        <span class="t" style="--c:${tempColor(w.temp) || 'transparent'}"><i></i>${esc(tempW(w.temp).text)}</span>
        <span>${esc(windTxt(w))}</span><span>拥挤：${esc(presW(w.pres).text)}</span></div>
        ${w.season ? `<div class="wb-t-season s-${w.season.key}">${icon(w.season.key)}<b>${esc(w.season.name)}</b>${esc(w.season.now)} → ${esc(w.season.next)}</div>` : ''}`
      : `<div class="wb-t-wx muted">${i.priv ? '未上市公司：没有股价，也就没有天气' : i.abroad ? '海外上市：地图上暂时没有它的天气' : '天气数据还在路上'}</div>`;
    let rel = '';
    if (p) {
      const bits = p.rels.slice(0, 3).map((e) => {
        const mk = e._mk || moneyOf(e);
        const m = mk ? ` ${isEst(e) ? '≈' : ''}${amtShort(mk, '美元')}` : '';
        return `${REL[e.type] || e.type}${m}`;
      });
      for (const m of p.measured) bits.push(m.type === 'comove' ? `同涨同跌 ${isNum(m.corr) ? m.corr.toFixed(2) : ''}` : `${info(m.lead).name}先动`);
      rel = `<div class="wb-t-tie">和${esc(info(S.model.F).name)}：${esc(bits.join(' · '))}</div>`;
    }
    const cross = S.src && !isF ? [...new Set((S.src.all.adj.get(id) || []).map((e) => (e.a === id ? e.b : e.a)))].filter((o) => o !== S.model.F && S.edges.has(o)).map((o) => info(o).name) : [];
    return `<div class="wb-t-h"><b class="big">${esc(i.name)}</b>${i.ticker ? `<span class="wb-tk sm">${esc(i.ticker)}</span>` : '<span class="wb-chip">未上市</span>'}</div>
      ${i.note ? `<div class="wb-t-note">${esc(i.note)}</div>` : ''}${wxl}${rel}
      ${cross.length ? `<div class="wb-t-cross">它和图上的 ${esc(cross.slice(0, 4).join('、'))} 也有关系（虚线）</div>` : ''}
      <div class="wb-t-hint">${isF ? (stockKnown(id) ? '右上角「个股天气」看它自己的资金河流' : '') : '点一下：以它为中心重新画'}</div>`;
  }

  /** the edge an ask / 为什么 is about, with clean ids: payer → payee when money runs, else focus → other */
  function edgeFacts(otherId) {
    const p = S.model?.pairs.get(otherId);
    const F = S.model?.F;
    const est = p?.rels.find(isEst);
    const e = est || p?.rels.find((r) => r.money) || p?.rels[0] || null;
    const [payer, payee] = e ? payerPayee(e) : [null, null];
    const canon = (x) => (knownId(x) ? x : resolveId(x) || x);     // graph ids stay as they are
    const a = canon(payer || F), b = canon(payee || otherId);
    return { p, e, F, a, b, est: !!est, key: `edge:${a}>${b}` };
  }
  function askAbout(tip, btn) {
    if (!tip) return;
    const { e, F, a, b, est, key } = edgeFacts(tip.id);
    const nf = info(F).name, no = info(tip.id).name;
    let q, kind = 'ask';
    const target = { type: 'edge', a, b, what: e?.money?.what || (e ? REL[e.type] : null) || null, edgeType: e?.type || null };
    if (e) {
      const m = e.money;
      target.current = { money: m ? { usdB: m.usdB ?? null, per: m.per ?? null, what: m.what ?? null } : null, est: isEst(e), conf: e.conf ?? null, basis: e.money?.basis || e.basis || null };
      const amt = m && isNum(m.usdB) ? `，目前记的是 ${yi(m.usdB)} 美元${perLong(m.per) ? '（' + perLong(m.per) + '）' : ''}${isEst(e) ? '（估算）' : ''}` : '，金额未知';
      const [pa, pb] = payerPayee(e);
      const dir = pa && pb ? `${info(pa).name}（${a}）付给 ${info(pb).name}（${b}）` : `「${nf}」（${a}）和「${no}」（${b}）之间`;
      q = `核实 ${dir} 的${REL[e.type] || ''}关系${m?.what ? '（' + m.what + '）' : ''}${amt}。最新金额（美元/年）、占比、出处链接？公司请用股票代码，未上市的写英文名。`;
      kind = est || !(m && isNum(m.usdB)) ? 'gap' : 'ask';
      if (kind === 'gap' && !(pa && pb)) kind = 'ask';                 // a rivalry has no money to fill in
    } else {
      q = `「${nf}」（${a}）和「${no}」（${b}）价格经常一起动，背后有没有真实的生意往来？有的话金额多少、谁付给谁、出处？`;
    }
    pinTip();
    sendScout({ key, kind, target, question: q, focus: F, ids: [...new Set([F, tip.id])], label: `${nf} ↔ ${no}` });
    ensureJobSlot(key);
  }
  /** 为什么？ on an edge (§21): why does this money run / this tie matter now */
  function whyEdge(tip, btn) {
    if (!tip) return;
    const { a, b, F } = edgeFacts(tip.id);
    const target = { kind: 'edge', ids: [a, b], dateIndex: isNum(app.state?.dateIndex) ? app.state.dateIndex : undefined, map: app.state?.map || 'curated' };
    pinTip();
    if (hasAppWhy(app)) {
      // the reason card sits beside the edge card (not on top of the facts it explains)
      const tr = E.tip.getBoundingClientRect(), need = 384 + 16;
      const x = innerWidth - tr.right >= need + 8 ? tr.right + 12 : tr.left >= need + 8 ? tr.left - need + 4 : null;
      const rect = x == null ? null : { left: x + 8, right: x + 9, top: tr.top - 9, bottom: tr.top - 8 };
      openAppWhy(app, target, rect ? { rect, lift: E.root } : { anchor: btn, lift: E.root });
      return;
    }
    // no shell reason card: answer inside the edge card
    let slot = E.tip.querySelector('.wb-why-slot');
    if (!slot) { slot = h('div', 'wb-why-slot', null, E.tip); }
    const q = `为什么「${info(a).name}」（${a}）和「${info(b).name}」（${b}）这条关系最近值得看？钱有没有变多/变少，最近有什么新闻、合同、财报提到它？带日期和出处。`;
    S.whyRun?.stop?.();
    S.whyRun = askWhy(app, target, slot, { question: q, scoutTarget: { type: 'edge', a, b }, onChange: () => placeTipKeep() });
    void F;
  }
  /** 让侦察兵补全 X 的上下游 (company-level gap) */
  function askGap(F) {
    const fi = info(F);
    const id = knownId(F) ? F : resolveId(F) || F;
    const q = `补全「${fi.name}」（${id}）的上下游：最大的供应商、最大的客户、主要对手和投资，各自的金额（美元/年）、占比和出处。每家公司请写股票代码（如 GOOGL、NVDA、2330.TW），未上市的写英文名。`;
    const target = isPriv(id) || !stockKnown(id) ? id : 's:' + id;
    sendScout({ key: 'co:' + id, kind: 'gap', target, question: q, focus: id, ids: [id], label: fi.name });
  }
  function ensureJobSlot(key) {
    if (!E.tip || E.tip.hidden) return;
    let slot = E.tip.querySelector(`[data-job="${CSS.escape(key)}"]`);
    if (!slot) { slot = h('div', 'wb-job', null, E.tip); slot.dataset.job = key; }
    const j = S.jobs.get(key);
    if (j) slot.replaceChildren(...slotKids(j));
    placeTipKeep();
  }
  function pinTip() {
    if (!S.tip) return;
    S.pinned = true;
    E.tip.classList.add('pinned');
    if (S.tip.kind === 'edge') { S.hot = { edge: S.tip.id }; applyHot(); }
  }

  function openFix(tip) {
    const p = S.model?.pairs.get(tip?.id);
    const e = p?.rels.find(isEst);
    if (!e) return;
    S.fixEdge = e;
    const box = h('div', 'wb-fix', `
      <div class="wb-fix-h">我来补：${esc(info(e.a).name)} ↔ ${esc(info(e.b).name)}</div>
      <label>金额（亿美元）<input type="number" min="0" step="0.1" class="wb-fix-v" value="${isNum(e.money?.usdB) ? +(e.money.usdB * 10).toFixed(1) : ''}"></label>
      <label>出处<input type="text" class="wb-fix-s" placeholder="例如：10-K 2026 第 34 页"></label>
      <div class="wb-t-actions"><button type="button" class="wb-btn sm" data-act="fix-save">记下</button></div>`);
    E.tip.querySelector('.wb-fix')?.remove();
    E.tip.appendChild(box);
    S.pinned = true;
    E.tip.classList.add('pinned');
    box.querySelector('input')?.focus();
  }
  async function saveFix() {
    const e = S.fixEdge;
    if (!e) return;
    const v = parseFloat(E.tip.querySelector('.wb-fix-v')?.value);
    const src = (E.tip.querySelector('.wb-fix-s')?.value || '').trim();
    if (!isNum(v) || v < 0) { toast('金额要是一个数字（亿美元）'); return; }
    const entry = { target: edgeKey(e), field: 'money.usdB', value: +(v / 10).toFixed(4), note: src || '主人自己补的', type: e.type };
    const d = D();
    let r = { error: 'no-server' };
    if (typeof d.api === 'function') r = await d.api('overrides', { method: 'POST', body: entry });
    if (r && r.ok) {
      S.srcP = null;                              // re-read data/overrides.json with the new entry
      toast(r.say || '记下了：这条线现在用你的数。', 2600);
    } else {
      S.overrides.push({ ...entry, source: 'owner', local: true, at: new Date().toISOString() });
      saveLocalOverrides();
      toast(r?.error === 'no-server' ? '记在这台电脑上了（服务器没开，等开了再同步）' : `没写进服务器（${r?.error || '未知'}），先记在这台电脑上`, 3200);
    }
    app.emit?.('override', { ...entry, from: 'web' });
    refocus();
  }
  async function unfix(tip) {
    const p = S.model?.pairs.get(tip?.id);
    const keys = new Set((p?.rels || []).filter((e) => e.fixKey).map((e) => e.fixKey));
    S.overrides = S.overrides.filter((o) => !keys.has(o.target));
    saveLocalOverrides();
    const d = D();
    if (typeof d.api === 'function') {
      for (const k of keys) {
        if ((S.src?.shared || []).some((o) => o.target === k && (!o.source || o.source === 'owner'))) {
          await d.api('overrides', { method: 'DELETE', query: { target: k, field: 'money.usdB' } });
        }
      }
      S.srcP = null;
    }
    toast('撤销了，回到原来的估算。', 2000);
    refocus();
  }
  function refocus() {
    hideTip(true);
    S.docs.clear();
    if (!S.srcP) S.src = null;
    const f = S.focus;
    S.focus = null;
    focusOn(f, { push: false });
  }

  /** nothing at all to draw: say so plainly and offer the scout (the focus still shows its weather) */
  function renderEmpty() {
    if (!S.model) return;
    const none = !S.model.list.length;
    E.empty.hidden = !none;
    if (!none) return;
    const F = S.model.F, nm = info(F).name;
    const job = S.jobs.get('co:' + F);
    const busy = coBusy(F);
    E.empty.innerHTML = busy
      ? `<p>侦察兵在查${esc(nm)}的上下游，查到了这里会自己画出来。</p><div class="wb-job" data-job="co:${esc(F)}"></div>`
      : `<p>还没有${esc(nm)}的关系数据，地图上也找不到它的邻居。</p>
      <button type="button" class="wb-btn sm">${icon('search')}<span>派侦察兵去查它的上下游</span></button>${job ? `<div class="wb-job" data-job="co:${esc(F)}"></div>` : ''}`;
    E.empty.querySelector('button')?.addEventListener('click', () => askGap(F));
    fillJobs(E.empty);
  }

  // ─────────── header + side panel
  function renderHeader(id, doc) {
    const i = info(id);
    E.name.textContent = i.name || doc?.name || id;
    E.tk.textContent = i.priv ? '未上市' : id;
    E.tk.hidden = !i.priv && i.name === id;
    E.note.textContent = i.note || doc?.note || '';
    E.stockBtn.hidden = !stockKnown(id);
    const prev = S.hist.length > 1 ? S.hist[S.hist.length - 2] : null;
    E.backBtn.querySelector('span').textContent = prev ? `回到${shortName(info(prev).name, 84, 14)}` : S.from === 'stock' ? '回到个股' : '回到地图';
    E.backBtn.title = prev ? '退一步（Backspace）' : '关掉关系网（Esc）';
    const trail = S.hist.slice(-5);
    E.crumbs.innerHTML = `<span class="wb-crumb-root">${icon('web')}关系网</span>` + trail.map((t, k) => {
      const cur = k === trail.length - 1;
      return `<span class="wb-sep">›</span>${cur ? `<span class="wb-crumb cur">${esc(info(t).name)}</span>` : `<button type="button" class="wb-crumb" data-k="${S.hist.length - trail.length + k}">${esc(info(t).name)}</button>`}`;
    }).join('');
    E.crumbs.querySelectorAll('button.wb-crumb').forEach((b) => b.addEventListener('click', () => {
      const k = +b.dataset.k;
      S.hist = S.hist.slice(0, k + 1);
      focusOn(S.hist[k], { push: false });
    }));
  }

  function renderSide() {
    const doc = S.doc, model = S.model;
    if (!doc || !model) return;
    const F = model.F, fi = info(F), w = wx(F);
    const mild = app.state?.voice === 'mild' && doc.takeMild?.length;
    const take = mild ? doc.takeMild : doc.take.length ? doc.take : autoTake(doc, model);
    const takeHTML = take.length
      ? `<section class="wb-sec wb-take"><div class="wb-sec-h">老风说</div><p class="wb-lead">${esc(take[0])}</p>${take.slice(1).map((s) => `<p>${esc(s)}</p>`).join('')}</section>`
      : '';
    // money ledger (all ties, not only the ones drawn)
    // per-year money (yearly ties + contract totals spread over their term) and one-off money are two lists
    // with two scales — never one figure
    const out = [], inn = [], inv = [], once = [];
    for (const p of model.list) {
      for (const f of p.flows) {
        if (!f.known) continue;
        if (f.yearly) {
          const mr = f.rels.find((r) => r._mk && r._mk.kind !== 'one') || f.rels[0];
          const row = { id: p.id, v: f.yearB, text: yearText(f), est: f.est, what: mr?.money?.what, type: mr?.type, dir: f.dir };
          if (p.zone === 'bottom' || f.role === 'bottom') inv.push(row);
          else if (f.dir > 0) out.push(row);
          else inn.push(row);
        }
        for (const o of f.ones) once.push({ id: p.id, v: o.mk.usdB, text: `${yi(o.mk.usdB)}`, tag: o.mk.tag, est: isEst(o.e), what: o.e.money?.what, type: o.e.type, dir: f.dir });
      }
    }
    const mx = Math.max(1e-9, ...[...out, ...inn, ...inv].map((r) => r.v));
    const mxOnce = Math.max(1e-9, ...once.map((r) => r.v));
    const rows = (list, verb, M = mx, cls = '') => list.sort((a, b) => b.v - a.v).slice(0, 6).map((r) => `
      <button type="button" class="wb-row${cls}" data-go="${esc(r.id)}" title="${esc(r.what || '')}">
        <span class="wb-row-n">${esc(info(r.id).name)}${verb ? `<em>${esc(verb(r))}</em>` : ''}</span>
        <span class="wb-row-bar${r.est ? ' est' : ''}"><i style="width:${Math.max(3, Math.sqrt(r.v / M) * 100).toFixed(1)}%"></i></span>
        <span class="wb-row-v">${r.est ? '<span class="wb-seal-i sm">估</span>' : ''}${esc(r.text)}</span>
      </button>`).join('');
    const invVerb = (r) => (r.type === 'finances' ? (r.dir > 0 ? '它出资' : '资助它') : r.type === 'invests-in' ? (r.dir > 0 ? '它投' : '投它') : (r.dir > 0 ? '它付' : '付它'));
    const onceVerb = (r) => (r.tag === '担保' ? (r.dir > 0 ? '它担保' : '担保它')
      : `${r.tag} · ${r.type === 'invests-in' ? (r.dir > 0 ? '它投' : '投它') : r.type === 'finances' ? (r.dir > 0 ? '它出资' : '资助它') : (r.dir > 0 ? '它付' : '付它')}`);
    const nUnknown = model.list.filter((p) => p.flows.length && !p.flows.some((f) => f.known)).length;
    let ledger = '';
    if (out.length || inn.length || inv.length || once.length) {
      ledger = `<section class="wb-sec"><div class="wb-sec-h">钱从哪来，到哪去 <span class="wb-unit">美元 · 按年</span></div>
        ${inn.length ? `<div class="wb-sub-h"><span class="wb-dot in"></span>谁付钱给${esc(fi.name)}</div>${rows(inn)}` : ''}
        ${out.length ? `<div class="wb-sub-h"><span class="wb-dot out"></span>${esc(fi.name)}付钱给谁</div>${rows(out)}` : ''}
        ${inv.length ? `<div class="wb-sub-h"><span class="wb-dot inv"></span>投资 · 出资</div>${rows(inv, invVerb)}` : ''}
        ${out.length || inn.length || inv.length ? `<div class="wb-foot">「年均」= 多年合同总额按年限摊开（没写年限按 ${TERM_DEFAULT} 年）</div>` : ''}
        ${once.length ? `<div class="wb-sub-h"><span class="wb-dot once"></span>一次性的钱 <span class="wb-unit">不按年算，不算进线的粗细</span></div>${rows(once, onceVerb, mxOnce, ' once')}` : ''}
        ${nUnknown ? `<div class="wb-foot">另有 ${nUnknown} 条买卖关系没披露金额（图上细线）</div>` : ''}</section>`;
    } else if (model.list.length) {
      ledger = `<section class="wb-sec"><div class="wb-sec-h">钱从哪来，到哪去</div><div class="wb-foot">这些关系都还没有公开金额——线都画成细线。${doc.synth ? '' : ''}</div></section>`;
    }
    const wxHTML = w ? `<section class="wb-sec"><div class="wb-sec-h">${esc(fi.name)}今天的天气</div>
        ${w.season ? `<div class="wb-season-line s-${w.season.key}">${icon(w.season.key, 'lg')}<div><b>${esc(w.season.name)}</b> ${esc(w.season.now)}<span>接下来：${esc(w.season.next)}</span></div></div>` : `<div class="wb-season-line none"><div><b>平稳</b> · 没有明显的季节信号</div></div>`}
        <div class="wb-wx3">
          <div><span>温度</span><b style="--c:${tempColor(w.temp) || 'transparent'}"><i></i>${esc(tempW(w.temp).text)}</b></div>
          <div><span>风</span><b class="${w.mixed ? 'mixed' : isNum(w.wind) && w.wind >= 0.5 ? 'in' : isNum(w.wind) && w.wind <= -0.5 ? 'out' : ''}" title="${w.mixed ? esc(`风偏${w.mixed > 0 ? '进' : '出'}（成交占比在${w.mixed > 0 ? '升' : '降'}），可 5 天按价量算是净${w.f5 < 0 ? '流出' : '流入'}`) : ''}">${esc(w.mixed ? (w.mixed > 0 ? '关注在升' : '关注在退') : windW(w.wind).text)}</b></div>
          <div><span>拥挤</span><b>${esc(presW(w.pres).text)}${isNum(w.pres) ? `<small>${Math.round(w.pres)}</small>` : ''}</b></div>
        </div><div class="wb-foot">都是跟它自己过去一年比</div></section>` : '';
    // measured
    const co = [], ll = [];
    for (const p of model.list) for (const m of p.measured) (m.type === 'comove' ? co : ll).push({ m, id: p.id });
    co.sort((a, b) => (b.m.corr || 0) - (a.m.corr || 0));
    const measHTML = co.length || ll.length ? `<section class="wb-sec"><div class="wb-sec-h">价格测出来的关系 <span class="wb-unit">近 120 天</span></div>
        ${co.slice(0, 5).map(({ m, id }) => `<button type="button" class="wb-row meas" data-go="${esc(id)}"><span class="wb-row-n">${esc(info(id).name)}<em>同涨同跌</em></span><span class="wb-row-bar meas"><i style="width:${(clamp(((m.corr || 0) - 0.4) / 0.6, 0.05, 1) * 100).toFixed(0)}%"></i></span><span class="wb-row-v">${isNum(m.corr) ? m.corr.toFixed(2) : ''}</span></button>`).join('')}
        ${ll.slice(0, 3).map(({ m, id }) => `<button type="button" class="wb-row meas ll" data-go="${esc(id)}"><span class="wb-row-n">${esc(shortName(info(m.lead).name, 70))} → ${esc(shortName(info(m.lag).name, 70))}<em>领先 ${m.days ?? '?'} 天${isNum(m.corr) && m.corr < 0 ? '，反向' : ''}</em></span><span class="wb-row-v">${isNum(m.corr) ? m.corr.toFixed(2) : ''}</span></button>`).join('')}
        <div class="wb-foot">只说明价格一起动，不代表有生意往来</div></section>` : '';
    const nE = model.list.reduce((s, p) => s + p.rels.length, 0), nEst = model.list.reduce((s, p) => s + p.rels.filter(isEst).length, 0);
    const nM = model.list.reduce((s, p) => s + p.measured.length, 0);
    const srcNote = doc.src === 'fixture' ? '预览数据（研究批次直接合并，等正式整理）' : doc.src === 'data' ? '关系数据' : '';
    const dataHTML = `<section class="wb-sec wb-data">
        ${doc.synth && model.list.length ? `<p class="wb-warn">还没人研究过${esc(fi.name)}的上下游。图上先放了地图上同板块的邻居（都标了估），等侦察兵或你来补。</p>` : ''}
        <div class="wb-foot">${esc(srcNote)}${doc.asOf ? ` · 截至 ${esc(doc.asOf)}` : ''} · ${nE} 条生意关系${nEst ? `，其中 ${nEst} 条是估算` : ''}${nM ? ` · ${nM} 条价格测量` : ''}</div>
        <button type="button" class="wb-btn sm" data-ask-gap${coBusy(F) ? ' hidden' : ''}>${icon('search')}<span>${S.jobs.get('co:' + F)?.state === 'done' ? '再让侦察兵补一次' : `让侦察兵补全${esc(shortName(fi.name, 120, 12.5))}的上下游`}</span></button>
        ${S.jobs.get('co:' + F) ? `<div class="wb-job" data-job="co:${esc(F)}"></div>` : ''}</section>`;
    E.side.innerHTML = takeHTML + wxHTML + ledger + measHTML + dataHTML + legendHTML();
    E.side.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => focusOn(b.dataset.go)));
    E.side.querySelectorAll('[data-go]').forEach((b) => {
      b.addEventListener('pointerenter', () => { if (S.edges.has(b.dataset.go)) { S.hot = { edge: b.dataset.go }; applyHot(); } });
      b.addEventListener('pointerleave', () => { if (S.hot?.edge === b.dataset.go && !S.pinned) { S.hot = null; applyHot(); } });
    });
    E.side.querySelector('[data-ask-gap]')?.addEventListener('click', () => {
      const j = S.jobs.get('co:' + F);
      if (j && !isLive(j)) S.jobs.delete('co:' + F);          // 再补一次: a fresh job
      askGap(F);
      if (!E.side.querySelector(`[data-job="co:${CSS.escape(F)}"]`)) renderSide();
    });
    fillJobs(E.side);
  }

  /** when nobody wrote a take: one plain, data-backed sentence (never invents facts) */
  function autoTake(doc, model) {
    const nm = info(model.F).name;
    const flows = [];
    for (const p of model.list) for (const f of p.flows) if (f.known && (f.role === 'left' || f.role === 'right')) flows.push({ id: p.id, ...f });
    // per year first (that is what the lines show); a one-off deal only when there is no yearly money at all
    const fsz = (f) => (f.yearly ? f.yearB : f.ones.length ? f.ones[0].mk.usdB / 5 : 0);
    flows.sort((a, b) => (b.yearly - a.yearly) || fsz(b) - fsz(a));
    const amt = (f) => {
      if (f.yearly) return f.term ? `每年约 ${yi(f.yearB)}美元（合同按年摊）` : `一年${f.est ? '约 ' : ' '}${yi(f.yearB)}美元`;
      const o = f.ones[0];
      return `一笔${isEst(o.e) ? '约 ' : ' '}${yi(o.mk.usdB)}美元（${o.mk.tag}）`;
    };
    const out = [];
    const inn = flows.find((f) => f.dir < 0), pay = flows.find((f) => f.dir > 0);
    if (inn) out.push(`${nm}最大的金主是${info(inn.id).name}：${amt(inn)}往它这流。`);
    if (pay) out.push(`它最大的一笔开销给了${info(pay.id).name}：${amt(pay)}。`);
    if (!out.length && model.list.length) {
      const top = model.list.find((p) => p.rels.some((e) => e.type === 'competes' && !isEst(e)));
      out.push(doc.synth ? `${nm}的关系网还没人画过，先看地图上的邻居。` : `${nm}的关系大多没披露金额${top ? `，最直接的对手是${info(top.id).name}` : ''}。`);
    }
    return out;
  }

  // ─────────── search (switch company)
  function wireSearch() {
    let items = [], sel = -1;
    const index = () => {
      const seen = new Map();
      for (const [id, n] of S.src?.all.nodes || []) seen.set(id, { id, name: info(id).name, n: n?.n || (S.src.all.adj.get(id) || []).length });
      const si = app.searchIndex || [];
      for (const x of si) {
        const t = x.ticker || (String(x.id).startsWith('s:') ? String(x.id).slice(2) : null);
        if (t && !seen.has(t)) seen.set(t, { id: t, name: x.name, n: 0 });
      }
      return [...seen.values()];
    };
    const render = () => {
      E.sugg.innerHTML = items.map((x, k) => `<li class="${k === sel ? 'sel' : ''}" data-id="${esc(x.id)}"><b>${esc(x.name)}</b><span>${esc(isPriv(x.id) ? '未上市' : x.id)}</span>${x.n ? `<em>${x.n} 条关系</em>` : ''}</li>`).join('');
      E.sugg.hidden = !items.length;
    };
    const go = (id) => {
      const q = String(id || '').trim();
      const r = resolveId(q);
      E.input.value = ''; items = []; render(); E.input.blur();
      if (!r && !/^[A-Za-z0-9.\-]{1,12}$/.test(q)) { toast(`没找到「${q}」——试试中文名或股票代码`, 3200); return; }
      open(r || q);
    };
    E.input.addEventListener('input', async () => {
      await graphSource();
      const q = E.input.value.trim().toLowerCase();
      if (!q) { items = []; render(); return; }
      const all = index();
      items = all.map((x) => {
        const id = x.id.toLowerCase(), nm = String(x.name).toLowerCase();
        let s = 0;
        if (id === q || id === 'p:' + q) s = 100; else if (nm === q) s = 95;
        else if (id.startsWith(q)) s = 70; else if (nm.startsWith(q)) s = 65;
        else if (nm.includes(q)) s = 40; else if (id.includes(q)) s = 30;
        return { ...x, s: s ? s + Math.min(10, x.n) : 0 };
      }).filter((x) => x.s).sort((a, b) => b.s - a.s).slice(0, 8);
      // English names / typos the list cannot see ('google', 'GOOGLE', 'Ginkgo Bioworks') → the resolver's pick on top
      const r = resolveId(E.input.value.trim());
      if (r && !items.some((x) => x.id === r)) {
        items.unshift({ id: r, name: info(r).name, n: S.src?.all.nodes.get(r)?.n || 0, s: 99 });
        items = items.slice(0, 8);
      }
      sel = items.length ? 0 : -1;
      render();
    });
    E.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); const x = items[sel] || null; if (x) go(x.id); else if (E.input.value.trim()) go(E.input.value.trim()); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); E.input.value = ''; items = []; render(); E.input.blur(); }
    });
    E.input.addEventListener('blur', () => setTimeout(() => { items = []; render(); }, 150));
    E.sugg.addEventListener('pointerdown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); go(li.dataset.id); } });
  }

  // ─────────── resize / date / reload
  function onResize(force) {
    if (!E.stage) return;
    const r = E.stage.getBoundingClientRect();
    const Wd = Math.round(r.width), Ht = Math.round(r.height);
    if (!Wd || !Ht) return;
    if (!force && Wd === S.W && Ht === S.H) return;
    S.W = Wd; S.H = Ht; S.dpr = Math.min(2, window.devicePixelRatio || 1);
    E.canvas.width = Math.round(Wd * S.dpr); E.canvas.height = Math.round(Ht * S.dpr);
    E.canvas.style.width = Wd + 'px'; E.canvas.style.height = Ht + 'px';
    for (const s of [E.back, E.front]) { s.setAttribute('width', Wd); s.setAttribute('height', Ht); s.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`); }
    if (S.model) {
      S.layout = computeLayout(S.model);
      for (const [id, t] of S.layout.pos) {
        const n = S.nodes.get(id);
        if (!n) continue;
        n.x = t.x; n.y = t.y; n.r = t.r;
        if (n.from) { n.to = { ...n.to, x: t.x, y: t.y, r: t.r }; }
        paintNode(n, false);
      }
      layoutEdges();
      for (const e of S.edges.values()) e.parts = [];
      renderZones();
    }
    drawBackdrop();
    kick();
  }

  function drawBackdrop() {
    E.bg.replaceChildren();
    const L = S.layout || { cx: S.W / 2, cy: S.H / 2 + 2, rx: Math.min(S.W / 2 - 150, 470), ry: Math.min(S.H / 2 - 100, 340) };
    const ring = (f, cls) => {
      const pts = [];
      for (let k = 0; k <= 96; k++) { const [x, y] = squircle((k / 96) * 2 * Math.PI); pts.push(`${(L.cx + L.rx * f * x).toFixed(1)},${(L.cy + L.ry * f * y).toFixed(1)}`); }
      svg('polyline', { points: pts.join(' '), class: cls }, E.bg);
    };
    ring(1, 'wb-orbit');
    ring(0.55, 'wb-orbit faint');
    svg('line', { x1: L.cx - L.rx - 60, y1: L.cy, x2: L.cx + L.rx + 60, y2: L.cy, class: 'wb-axis' }, E.bg);
    svg('line', { x1: L.cx, y1: L.cy - L.ry - 30, x2: L.cx, y2: L.cy + L.ry + 30, class: 'wb-axis' }, E.bg);
  }

  let dateRaf = 0;
  function onDate() {
    if (!S.open || dateRaf) return;
    dateRaf = requestAnimationFrame(() => {
      dateRaf = 0;
      for (const n of S.nodes.values()) paintNode(n, true);
      renderSide();
    });
  }

  function reload({ stocksOnly = false } = {}) {
    if (!stocksOnly) { S.srcP = null; S.src = null; S.docs.clear(); S.overrides = loadLocalOverrides(); }
    S.stockP.clear(); S.stocks.clear();
    if (S.open && S.focus) { const f = S.focus; S.focus = null; focusOn(f, { push: false }); }
  }

  /** any name / ticker / messy scout id → the graph's id (or null). Other modules may use it to normalise. */
  async function resolve(t) { await graphSource().catch(() => null); return resolveId(t); }
  const api = { app, open, close, syncTheme, onDate, reload, lastTicker, resolve, get state() { return S; } };
  return api;
}
