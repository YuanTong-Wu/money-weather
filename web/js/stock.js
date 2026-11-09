// 个股小星球 — the stock view (DESIGN.md §4 "Stock view", §6 attention, §7 contract, §8.2 seasons,
// §12 sharp voice, §13 关系网 entry, §14 估, §15 侦察兵 entry, §17 art direction).
//
//   openStockView(rootEl, ticker, {dateIndex, onClose, onPeer(ticker), words, onWeb, onAsk, theme})
//     → {setDate(i), close(), setTicker(t), setTheme(t), refresh()}
//
// rootEl   element the overlay is appended to (the overlay is position:fixed unless rootEl is itself
//          positioned, then it fills rootEl). rootEl's own content is never touched.
// dateIndex index into the 252 trading dates (meta.dates == stock.dates); default = latest day.
// onClose  called after the view closed itself (back button / Esc). close() is idempotent.
// onPeer   called with a peer ticker when a neighbour is clicked. Without onPeer the view switches itself.
// words    the js/words.js module namespace (optional). Any missing function falls back to a local copy
//          (windWord/tempWord/presWord/stormWord/frontWord/money/pct/season/caster).
// onWeb(ticker)               "关系网" button. Fallback: window.app.openWeb(ticker).
// onAsk(kind, target, question) "让 Claude 去查" button (kind 'ask', target 's:MU'). Fallback: window.app.ask.
// voice    'sharp' | 'mild' (§12, default: words.getVoice() or 'sharp'). handle.refresh() re-renders the words.
// app      the shell's app object (§19), optional: the view listens to its 'voice' event and refreshes itself;
//          window.app.openWeb / window.app.ask are the fallbacks when onWeb / onAsk are not given.
// theme    'day' | 'night' — forces a theme on this view. Without it the view follows
//          <html data-theme="…"> (day is the default; night when the root says night).
// Extra optional opts: dataBase ('data/'), apiBase (''), intradayMs (60000).
//
// Estimates (§14): a stock file may carry `est: true` or `est: {fields:[…], basis, conf, from, to}` (from/to =
// index or 'YYYY-MM-DD'), `profile.est`, and the view adds its own clearly-marked estimates: a missing weather
// value → last known value or the neighbours' average; < 60 days of history → "按同行类比"; a missing
// 筹码山 → rebuilt from daily high/low and volume. Every estimate gets the dashed look + a small 估 seal.
//
// Phase 3 (§21, §23): 为什么？ on the wind badge and on any day of the river (click a bar →
// app.why({kind:'day', ids:['s:T'], dateIndex})) — through the shell's ui/why.js when it is there, else the local
// runner below (POST /api/why, or the scout when that route is missing), answer always in place. 真钱: when
// data/flows/*.json carries the ticker (ETF creations/redemptions…, est:false) a 「实」 cell, dots on the river and
// a caster line say what really moved. Exports for web.js: whyCardEl, scoutAnswerEl, whyWaitEl, askWhy, hasAppWhy,
// openAppWhy, liftWhyCard, followScout, scoutCards/newScoutCard (one reason-card look across views).
//
// Needs the classic-script global `d3` (vendor/d3.min.js). All fetch URLs are relative to the document,
// so the page must live in web/ (the dev harness uses <base href="../">).

const SVGNS = 'http://www.w3.org/2000/svg';
const jsonCache = new Map();
let apiMissingAt = 0; // set when /api/intraday answered 404 (static server) → stop polling for a while
const d3g = () => globalThis.d3;

// ------------------------------------------------------------------------------------------------
// tiny helpers
// ------------------------------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}
// replaceChildren() that skips null/false (replaceChildren(null) would print "null")
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (isNum(v) ? v : d);

const CACHE_MS = 5 * 60e3;
async function fetchJSON(url, { cache = true, timeout = 20000 } = {}) {
  const hit = cache && jsonCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: cache ? 'default' : 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      try { return JSON.parse(text); } catch { throw new Error('不是 JSON'); }
    } finally { clearTimeout(timer); }
  })();
  if (cache) {
    jsonCache.set(url, { p, at: Date.now() });
    p.catch(() => jsonCache.delete(url));
  }
  return p;
}

function parseDay(s) {
  // 'YYYY-MM-DD' → local Date at noon (no TZ drift)
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
}
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dayLabel(s, withYear = false) {
  const d = parseDay(s);
  return (withYear ? `${d.getFullYear()}年` : '') + `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ------------------------------------------------------------------------------------------------
// icons (§17: one hand-drawn-but-precise set; stroke = currentColor, 24×24)
// ------------------------------------------------------------------------------------------------
function maplePath() {
  const cx = 12, cy = 11.2;
  const pts = [[-90, 9.4], [-57, 4.3], [-22, 9], [8, 4.7], [38, 7.2], [90, 2.6], [142, 7.2], [172, 4.7], [202, 9], [237, 4.3]];
  const xy = pts.map(([a, r]) => {
    const t = (a * Math.PI) / 180;
    return `${(cx + Math.cos(t) * r).toFixed(2)} ${(cy + Math.sin(t) * r).toFixed(2)}`;
  });
  return `M${xy.join('L')}Z`;
}
const ICONS = {
  back: '<path d="M19 12H5.5M11 6l-6 6 6 6"/>',
  web: '<circle cx="12" cy="12" r="2.6"/><circle cx="4.9" cy="6" r="1.9"/><circle cx="19.1" cy="6.4" r="1.9"/><circle cx="5.8" cy="18.8" r="1.9"/><circle cx="18.6" cy="18.4" r="1.9"/><path d="M10 10.4 6.4 7.3M14 10.6l3.6-2.9M10.1 13.8 7.2 17.5M13.9 13.8l3.3 3.3"/>',
  ask: '<circle cx="10" cy="10" r="5.8"/><path d="M14.3 14.3 20.5 20.5"/><path d="M8 10h4M10 8v4"/>',
  spring: '<path d="M12 21v-7.4"/><path d="M12 13.6C8 13.6 5.4 11 5.4 7c4 0 6.6 2.6 6.6 6.6z"/><path d="M12 11.6c0-3.7 2.4-6.2 6.6-6.2 0 3.9-2.7 6.2-6.6 6.2z"/><path d="M7.6 21h8.8"/>',
  summer: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.9v2.3M12 18.8v2.3M2.9 12h2.3M18.8 12h2.3M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>',
  autumn: `<path d="${maplePath()}"/><path d="M12 13.8V5.6M12 13.8v7.7"/>`,
  winter: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.7 4.7 12 6.7l2.3-2M9.7 19.3l2.3-2 2.3 2M4.6 10.4l2.9-.8-.5-3M19.4 13.6l-2.9.8.5 3M4.6 13.6l2.9.8-.5 3M19.4 10.4l-2.9-.8.5-3"/>',
  calm: '<path d="M3.5 10c2.2-1.6 4.3-1.6 6.5 0s4.3 1.6 6.5 0c1.4-1 2.7-1.2 4-.6"/><path d="M3.5 15c2.2-1.6 4.3-1.6 6.5 0s4.3 1.6 6.5 0"/>',
  wind: '<path d="M3 9h10.6a2.8 2.8 0 1 0-2.8-2.8"/><path d="M3 13.5h14.6a2.8 2.8 0 1 1-2.8 2.8"/><path d="M3 18h6"/>',
  rain: '<path d="M7 14.5h10a3.8 3.8 0 0 0 .4-7.6A5.3 5.3 0 0 0 7.2 8.2 3.2 3.2 0 0 0 7 14.5z"/><path d="M8.6 17.5l-1 2.6M12.6 17.5l-1 2.6M16.6 17.5l-1 2.6"/>',
  storm: '<path d="M7 14h10a3.8 3.8 0 0 0 .4-7.6A5.3 5.3 0 0 0 7.2 7.7 3.2 3.2 0 0 0 7 14z"/><path d="M12.9 14l-2.4 3.7h3.1l-2.3 3.6"/>',
  clear: '<path d="M7 15.5h10a3.4 3.4 0 0 0 .3-6.8A4.8 4.8 0 0 0 8 9.6a2.9 2.9 0 0 0-1 5.9z"/>',
  temp: '<path d="M10 14.2V5a2 2 0 1 1 4 0v9.2a3.6 3.6 0 1 1-4 0z"/><path d="M12 9.5v7"/>',
  crowd: '<path d="M12 4.5c4.7 0 8 3.2 8 7.5s-3.3 7.5-8 7.5-8-3.2-8-7.5 3.3-7.5 8-7.5z"/><path d="M12 8.3c2.6 0 4.3 1.6 4.3 3.7s-1.7 3.7-4.3 3.7-4.3-1.6-4.3-3.7 1.7-3.7 4.3-3.7z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  front: '<path d="M3 16C8 9 16 9 21 16"/><path d="M5.8 12.9 8.6 11.3 5.9 9.8z" fill="currentColor"/><path d="M10.4 10.8h3.2L12 8.1z" fill="currentColor"/><path d="M15.4 11.3l2.8 1.6.1-3.1z" fill="currentColor"/>',
  arrow: '<path d="M4.5 12h14M13.5 7l5 5-5 5"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2"/>',
  real: '<ellipse cx="12" cy="6.8" rx="6.8" ry="2.6"/><path d="M5.2 6.8v5.1c0 1.4 3 2.6 6.8 2.6s6.8-1.2 6.8-2.6V6.8"/><path d="M5.2 11.9V17c0 1.4 3 2.6 6.8 2.6s6.8-1.2 6.8-2.6v-5.1"/>',
};
function icon(name, cls = '') {
  const s = svgEl('svg', { viewBox: '0 0 24 24', class: `sv-ic ${cls}`.trim(), 'aria-hidden': 'true', focusable: 'false' });
  s.innerHTML = ICONS[name] || '';
  return s;
}

// ------------------------------------------------------------------------------------------------
// plain-language words (§5, §8.2, §12). words.js (if passed) wins; these are the fallbacks.
// ------------------------------------------------------------------------------------------------
function moneyFallback(m) {
  if (!isNum(m)) return '—';
  const a = Math.abs(m);
  const sign = m < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}万亿美元`;
  if (a >= 100) return `${sign}${a >= 9995 ? Math.round(a / 100) : (a / 100).toFixed(1)}亿美元`;
  const w = a * 100;
  return `${sign}${w >= 10 ? Math.round(w) : w.toFixed(1)}万美元`;
}
function pctFallback(x) {
  if (!isNum(x)) return '—';
  const v = x * 100;
  const s = Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return (v > 0 ? '+' : '') + s + '%';
}
const SEASONS = {
  spring: { key: 'spring', emoji: '🌱', name: '春', now: '钱刚开始进来，还不挤', next: '可能进入夏天' },
  summer: { key: 'summer', emoji: '☀️', name: '夏', now: '正热、人多', next: '小心入秋' },
  autumn: { key: 'autumn', emoji: '🍂', name: '秋', now: '钱从拥挤处撤离', next: '可能入冬' },
  winter: { key: 'winter', emoji: '❄️', name: '冬', now: '冷清没人管', next: '等春天' },
  none: { key: null, emoji: '', name: '平稳', now: '不冷不热，看不出季节', next: '等风来' },
};
function seasonLocal(w, dw, p, flow5, temp, crash) {
  if (!isNum(w) || !isNum(p)) return { ...SEASONS.none, na: true };
  const d = isNum(dw) ? dw : 0;
  let k = 'none';
  if (w > 0.3 && d > 0.3 && p < 65) k = 'spring';
  else if (w > 0.3 && p >= 65) k = 'summer';
  else if ((w < -0.3 && p >= 50) || (d < -0.6 && p >= 65)) k = 'autumn';
  else if ((w < -0.3 && p < 50) || (Math.abs(w) <= 0.3 && p < 35)) k = 'winter';
  // DESIGN §8 amendment (crash gate, words.crashAt): falling hard never reads 春 / 夏 / 平稳
  const lv = crash && crash.level ? crash.level : 0;
  if (lv && k !== 'autumn' && k !== 'winter') k = p >= 50 ? 'autumn' : 'winter';
  const r = { ...SEASONS[k] };
  if (lv) { r.now = lv >= 2 ? '暴跌，远超它平时的波动' : '急跌，比它平时的波动大得多'; r.crash = crash; return r; }
  // same idea as words.season(): the season is about attention; when the 5-day money or the temperature
  // says otherwise, say so instead of a word that fights the cells next to it (only used without words.js)
  const f = isNum(flow5) && Math.abs(flow5) >= 0.05 ? flow5 : null;
  const warm = isNum(temp) && temp >= 0.5, cool = isNum(temp) && temp <= -0.5;
  let now = null;
  if (k === 'spring' && f != null && f < 0) now = '人气先回来了，钱还没净流入';
  else if (k === 'summer' && f != null && f < 0) now = '人很多，但钱没真进来';
  else if (k === 'summer' && cool) now = '人很多，价格却跑不动';
  else if (k === 'autumn' && f != null && f > 0) now = '人气在退，钱倒还在进';
  else if (k === 'winter' && f != null && f > 0 && w < -0.3) now = warm ? '人气冷清，可钱在进、价格也暖' : '人气冷清，钱却还在进';
  else if (k === 'winter' && warm) now = '人气冷清，价格倒还暖';
  if (now) r.now = now;
  return r;
}
// words.season() may answer with key 'spring' / name '春' / emoji — map it onto our icon keys
function seasonKey(r) {
  if (!r) return null;
  const k = String(r.key || '').toLowerCase();
  if (SEASONS[k] && k !== 'none') return k;
  const n = String(r.name || '') + String(r.emoji || '');
  if (/春|🌱/.test(n)) return 'spring';
  if (/夏|☀/.test(n)) return 'summer';
  if (/秋|🍂|🍁/.test(n)) return 'autumn';
  if (/冬|❄/.test(n)) return 'winter';
  return null;
}
const LOCAL_WORDS = {
  windWord(w) {
    if (!isNum(w)) return { text: '暂无数据', emoji: '', level: 0, na: true };
    if (w > 1.5) return { text: '钱在狂涌进来', emoji: '', level: 2 };
    if (w >= 0.5) return { text: '钱在流进来', emoji: '', level: 1 };
    if (w > -0.5) return { text: '风平浪静', emoji: '', level: 0 };
    if (w >= -1.5) return { text: '钱在悄悄溜走', emoji: '', level: -1 };
    return { text: '钱在大逃离', emoji: '', level: -2 };
  },
  tempWord(t) {
    if (!isNum(t)) return { text: '暂无数据', emoji: '', level: 0, na: true };
    if (t > 1.5) return { text: '很热', emoji: '', level: 2 };
    if (t >= 0.5) return { text: '暖', emoji: '', level: 1 };
    if (t > -0.5) return { text: '常温', emoji: '', level: 0 };
    if (t >= -1.5) return { text: '凉', emoji: '', level: -1 };
    return { text: '很冷', emoji: '', level: -2 };
  },
  presWord(p) {
    if (!isNum(p)) return { text: '暂无数据', emoji: '', level: 0, na: true };
    if (p >= 85) return { text: '人挤人', emoji: '', level: 2 };
    if (p >= 65) return { text: '人多', emoji: '', level: 1 };
    if (p >= 35) return { text: '正常', emoji: '', level: 0 };
    if (p >= 15) return { text: '人少', emoji: '', level: -1 };
    return { text: '冷清洼地', emoji: '', level: -2 };
  },
  stormWord(s) {
    if (isNum(s) && s >= 1.5) return { text: '大风暴', emoji: '', level: 2 };
    if (isNum(s) && s >= 0.8) return { text: '有风暴', emoji: '', level: 1 };
    return { text: '天气平稳', emoji: '', level: 0 };
  },
  frontWord(f) {
    if (f > 0) return { text: '风向刚变：钱开始流入', emoji: '', level: 1 };
    if (f < 0) return { text: '风向刚变：钱开始撤离', emoji: '', level: -1 };
    return { text: '风向没变', emoji: '', level: 0 };
  },
  season: seasonLocal,
  confWord(c) {
    if (!isNum(c)) return '把握不详';
    return c >= 0.8 ? '比较有把握' : c >= 0.5 ? `把握${Math.round(c * 10)}成` : `把握不大（${Math.round(c * 10)}成）`;
  },
  money: moneyFallback,
  pct: pctFallback,
};
function makeWords(ext) {
  const W = {};
  for (const k of Object.keys(LOCAL_WORDS)) {
    const local = LOCAL_WORDS[k];
    const fn = ext && typeof ext[k] === 'function' ? ext[k] : null;
    W[k] = (...a) => {
      if (fn) {
        try {
          const r = fn(...a);
          if (r != null && (typeof r === 'string' || typeof r.text === 'string' || typeof r.name === 'string')) return r;
        } catch { /* fall back */ }
      }
      return local(...a);
    };
  }
  W.caster = ext && typeof ext.caster === 'function' ? ext.caster : null;
  // §12: a words.js that knows about voices exposes setVoice(); an older one only speaks the neutral voice
  W.voiceAware = !!(ext && typeof ext.setVoice === 'function');
  W.getVoice = () => {
    try { return (ext && typeof ext.getVoice === 'function' && ext.getVoice()) || null; } catch { return null; }
  };
  return W;
}
// §17: OS emojis stay out of the main glyphs — strip them from words we print large
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu;
const plain = (s) => String(s ?? '').replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
const wordOf = (w) => (w == null ? '' : typeof w === 'string' ? plain(w) : plain(w.text || ''));
const level5 = (v, a, b) => (!isNum(v) ? 0 : v > b ? 2 : v >= a ? 1 : v > -a ? 0 : v >= -b ? -1 : -2);

// temperature (§17, §6.5 "same grammar at every zoom"): the planet's flat isotherm bands — same edges as
// js/planet/theme.js BAND_EDGES, colours from the shared CSS tokens --t0…--t8 (read in readColors()).
const BAND_EDGES = [-2.6, -1.8, -1.05, -0.4, 0.4, 1.05, 1.8, 2.6];
const BANDS_DAY = ['#263e63', '#33628a', '#5895ab', '#a4c8c2', '#ece2cb', '#f1cf8e', '#e9a643', '#d96f3c', '#b43d2c'];
function tempBand(t) {
  if (!isNum(t)) return 4;
  let k = 0;
  while (k < BAND_EDGES.length && t >= BAND_EDGES[k]) k++;
  return k;
}
const tempColor = (t, bands = BANDS_DAY) => bands[tempBand(t)] || BANDS_DAY[tempBand(t)];
const windTone = (w) => (!isNum(w) ? 'calm' : w >= 0.5 ? 'in' : w <= -0.5 ? 'out' : 'calm');

function fmtPrice(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const dig = a >= 1000 ? 0 : a >= 1 ? 2 : 4;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dig, maximumFractionDigits: dig });
}
function fmtPriceRound(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const dig = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dig, maximumFractionDigits: dig });
}
function fmtPriceAxis(v, step) {
  if (!isNum(v)) return '';
  const dig = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dig, maximumFractionDigits: dig });
}
// short money for axes (USD millions in): 4709亿 / 850万 / 1.2万亿
function moneyShort(m) {
  if (!isNum(m) || m === 0) return '0';
  const a = Math.abs(m), s = m < 0 ? '−' : '+';
  if (a >= 1e6) return `${s}${+(a / 1e6).toFixed(1)}万亿`;
  if (a >= 100) return `${s}${a >= 1e4 ? Math.round(a / 100) : +(a / 100).toFixed(1)}亿`;
  return `${s}${Math.round(a * 100)}万`;
}
const signPct = (W, x) => (isNum(x) ? W.pct(x).replace(/^-/, '−') : '—');

// ------------------------------------------------------------------------------------------------
// data preparation
// ------------------------------------------------------------------------------------------------
// §14 estimate markers. pipeline/compute.py writes `est` (is the latest day an estimate?), `estUntil` (last
// estimated index, counted from the window start), `basis`, `conf` — they cover the weather fields only;
// prices and volumes are always measured. An object form {fields, from, to|until, basis, conf} is accepted too.
const WEATHER_FIELDS = ['wind', 'temp', 'pres', 'storm', 'front'];
function parseEst(s, n, dates) {
  const out = { any: false, declared: false, fields: new Set(), basis: null, conf: null, mask: null };
  const e = s.est;
  const obj = e && typeof e === 'object' ? e : null;
  const hasUntil = isNum(s.estUntil) && s.estUntil >= 0;
  out.declared = e != null || s.estUntil != null;
  if (!e && !hasUntil) return out;
  out.any = true;
  out.basis = (obj && obj.basis) || s.basis || s.estBasis || null;
  out.conf = obj && isNum(obj.conf) ? obj.conf : isNum(s.conf) ? s.conf : null;
  (obj && Array.isArray(obj.fields) ? obj.fields : WEATHER_FIELDS).forEach((f) => out.fields.add(f));
  const toIdx = (v, dflt) => {
    if (isNum(v)) return clamp(Math.round(v), 0, n - 1);
    if (typeof v === 'string') { const k = dates.findIndex((d) => d >= v); return k < 0 ? n - 1 : k; }
    return dflt;
  };
  let a = null, b = null;
  if (obj && (obj.from != null || obj.to != null || obj.until != null)) { a = toIdx(obj.from, 0); b = toIdx(obj.to ?? obj.until, n - 1); }
  else if (hasUntil) { a = 0; b = toIdx(s.estUntil, n - 1); }
  if (a != null) {
    out.mask = new Uint8Array(n);
    for (let j = a; j <= b; j++) out.mask[j] = 1;
  }
  return out;
}

function prep(s) {
  const n = Array.isArray(s.dates) ? s.dates.length : 0;
  const arr = (k) => {
    const a = Array.isArray(s[k]) ? s[k] : [];
    return Array.from({ length: n }, (_, i) => (isNum(a[i]) ? a[i] : null));
  };
  const P = {
    raw: s, n, t: s.t, name: s.name || s.t, note: s.note || '', dates: s.dates || [],
    o: arr('o'), h: arr('h'), l: arr('l'), c: arr('c'), v: arr('v'),
    flow: arr('flow'), cum: arr('cumFlow'), wind: arr('wind'), temp: arr('temp'), pres: arr('pres'),
    storm: arr('storm'), front: arr('front'),
  };
  P.first = P.c.findIndex(isNum);
  if (P.first < 0) P.first = 0;
  P.dateIdx = new Map(P.dates.map((d, k) => [d, k]));
  // cumFlow may be missing → rebuild from flow
  if (!P.cum.some(isNum)) {
    let acc = 0;
    P.cum = P.flow.map((f) => (isNum(f) ? (acc += f) : null));
  }
  P.dv = P.c.map((c, i) => (isNum(c) && isNum(P.v[i]) ? (c * P.v[i]) / 1e6 : null));
  P.ret = P.c.map((c, i) => (i > 0 && isNum(c) && isNum(P.c[i - 1]) && P.c[i - 1] ? c / P.c[i - 1] - 1 : null));
  P.est = parseEst(s, n, P.dates);
  P.div = findDivergences(P);
  return P;
}

/** Is the stock's newest bar today's unfinished one? → {et:'13:30'} | null (stock file `intraday`, else meta.partial). */
function partialOf(P, app) {
  const d = P.dates[P.n - 1];
  const it = P.raw && P.raw.intraday;
  if (it && it.date === d) return { et: it.etTime || null };
  // a 全球 listing keeps its own exchange's calendar: the US map's partial bar says nothing about it
  if ((P.raw && (P.raw.map === 'global' || (P.raw.ccy && P.raw.ccy !== 'USD'))) || /\.[A-Z]{1,3}$/i.test(String(P.t || ''))) return null;
  const m = app && app.meta;
  const pa = m && m.partial;
  if (pa && pa.date === d) {
    const et = (m.intraday && m.intraday.date === d && m.intraday.etTime) || (String(pa.fetchedAt || '').match(/T(\d\d:\d\d)/) || [])[1] || null;
    return { et };
  }
  return null;
}

// Non-US listings (全球 map, §23): the exchange's session in its own clock, so 今天盘中 is not drawn on a
// 9:30–16:00 New York axis (a Tokyo day sits at 20:00–02:30 ET and would fall off the chart).
const SESS = {
  SS: ['Asia/Shanghai', '09:30', '15:00', '上海'], SZ: ['Asia/Shanghai', '09:30', '15:00', '深圳'],
  HK: ['Asia/Hong_Kong', '09:30', '16:00', '香港'], TW: ['Asia/Taipei', '09:00', '13:30', '台北'], TWO: ['Asia/Taipei', '09:00', '13:30', '台北'],
  T: ['Asia/Tokyo', '09:00', '15:30', '东京'], KS: ['Asia/Seoul', '09:00', '15:30', '首尔'], KQ: ['Asia/Seoul', '09:00', '15:30', '首尔'],
  NS: ['Asia/Kolkata', '09:15', '15:30', '孟买'], BO: ['Asia/Kolkata', '09:15', '15:30', '孟买'], AX: ['Australia/Sydney', '10:00', '16:00', '悉尼'],
  L: ['Europe/London', '08:00', '16:30', '伦敦'], DE: ['Europe/Berlin', '09:00', '17:30', '法兰克福'], F: ['Europe/Berlin', '09:00', '17:30', '法兰克福'],
  PA: ['Europe/Paris', '09:00', '17:30', '巴黎'], AS: ['Europe/Amsterdam', '09:00', '17:30', '阿姆斯特丹'], SW: ['Europe/Zurich', '09:00', '17:30', '苏黎世'],
  ST: ['Europe/Stockholm', '09:00', '17:30', '斯德哥尔摩'], MC: ['Europe/Madrid', '09:00', '17:30', '马德里'], MI: ['Europe/Rome', '09:00', '17:30', '米兰'],
  CO: ['Europe/Copenhagen', '09:00', '17:00', '哥本哈根'], OL: ['Europe/Oslo', '09:00', '16:20', '奥斯陆'], HE: ['Europe/Helsinki', '10:00', '18:30', '赫尔辛基'],
  BR: ['Europe/Brussels', '09:00', '17:30', '布鲁塞尔'], VI: ['Europe/Vienna', '09:00', '17:30', '维也纳'], IR: ['Europe/Dublin', '08:00', '16:30', '都柏林'],
  LS: ['Europe/Lisbon', '08:00', '16:30', '里斯本'], WA: ['Europe/Warsaw', '09:00', '17:00', '华沙'],
  TO: ['America/Toronto', '09:30', '16:00', '多伦多'], V: ['America/Toronto', '09:30', '16:00', '多伦多'], SA: ['America/Sao_Paulo', '10:00', '17:00', '圣保罗'],
};
const US_SESS = ['America/New_York', '09:30', '16:00', '美东'];
function sessionOf(ticker) {
  const m = String(ticker || '').match(/\.([A-Z]{1,3})$/i);
  return (m && SESS[m[1].toUpperCase()]) || US_SESS;
}
const tzDay = (tz, d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const tzHM = (tz, d) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24/, '00');
/** The instant of wall-clock `day hh:mm` in `tz`. */
function zonedAt(day, hhmm, tz) {
  const [H, M] = hhmm.split(':').map(Number);
  const guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), H, M);
  const off = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - t;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t);
}

function meanOf(a, i0, i1) {
  let s = 0, k = 0;
  for (let j = Math.max(0, i0); j <= i1; j++) if (isNum(a[j])) { s += a[j]; k++; }
  return k ? s / k : null;
}
function stdOf(a, i0, i1) {
  const m = meanOf(a, i0, i1);
  if (m == null) return null;
  let s = 0, k = 0;
  for (let j = Math.max(0, i0); j <= i1; j++) if (isNum(a[j])) { s += (a[j] - m) ** 2; k++; }
  return k > 1 ? Math.sqrt(s / (k - 1)) : null;
}
function chg(P, i, k) {
  const a = P.c[i], b = P.c[i - k];
  return isNum(a) && isNum(b) && b ? a / b - 1 : null;
}
function sumFlow(P, i0, i1) {
  let s = 0, k = 0;
  for (let j = Math.max(0, i0); j <= i1; j++) if (isNum(P.flow[j])) { s += P.flow[j]; k++; }
  return k ? s : null;
}

// Divergence = over the last 10 trading days, price and the money river went opposite ways.
// p: 10-day price change in units of its usual 10-day move; f: 10-day net flow in "days of trading money".
const DIV_L = 10;
function findDivergences(P) {
  const flag = new Array(P.n).fill(0);
  for (let t = Math.max(P.first + 30, DIV_L); t < P.n; t++) {
    const p = chg(P, t, DIV_L);
    const vol = stdOf(P.ret, t - 59, t);
    const adv = meanOf(P.dv, t - 59, t);
    if (!isNum(p) || !vol || !adv || !isNum(P.cum[t]) || !isNum(P.cum[t - DIV_L])) continue;
    const pz = p / (vol * Math.sqrt(DIV_L));
    const f = (P.cum[t] - P.cum[t - DIV_L]) / adv;
    if (pz < -0.3 && f > 0.3) flag[t] = 1; // price down, money in
    else if (pz > 0.3 && f < -0.3) flag[t] = -1; // price up, money out
  }
  const spans = [];
  for (let t = 0; t < P.n; t++) {
    if (!flag[t]) continue;
    const last = spans[spans.length - 1];
    if (last && last.dir === flag[t] && t - last.end <= 3) last.end = t;
    else spans.push({ dir: flag[t], start: t, end: t });
  }
  return spans.filter((s) => s.end - s.start >= 1 || s.end === P.n - 1);
}

// "is the selected day inside a divergence?" → caption (plain words)
function divergenceCaption(P, i, W) {
  const cur = P.div.find((s) => s.start <= i && s.end >= i - 1);
  if (cur) {
    const days = i - cur.start + 1;
    return cur.dir > 0
      ? { tone: 'in', text: `最近 ${days} 天：价格在跌，钱却在偷偷进来（斜线区）` }
      : { tone: 'out', text: `最近 ${days} 天：价格在涨，钱却在悄悄撤走（斜线区）` };
  }
  const past = P.div.filter((s) => s.end < i && i - s.end <= 60).pop();
  const p = chg(P, i, DIV_L), f = sumFlow(P, i - DIV_L + 1, i);
  let now = '';
  if (isNum(p) && isNum(f)) {
    const same = (p >= 0) === (f >= 0);
    now = same
      ? `最近10天：价格 ${signPct(W, p)}，钱也在${f >= 0 ? '流入' : '流出'}，同一个方向`
      : `最近10天：价格 ${signPct(W, p)}，钱却在${f >= 0 ? '流入' : '流出'}（还不算明显的背离）`;
  }
  if (past) {
    const txt = past.dir > 0 ? '价格在跌，钱却偷偷进来' : '价格在涨，钱却悄悄撤走';
    return { tone: 'calm', text: `${dayLabel(P.dates[past.end])}前后出现过背离：${txt}（斜线区）。${now ? now.replace(/（.*）$/, '') : ''}` };
  }
  return { tone: 'calm', text: now || '价格和钱的方向基本一致' };
}

// typical |5-day flow| over the trailing ~120 days (for "是平时的 2 倍")
function typical5(P, i) {
  const vals = [];
  for (let k = Math.max(P.first + 5, i - 125); k <= i - 5; k++) {
    const s = sumFlow(P, k - 4, k);
    if (isNum(s)) vals.push(Math.abs(s));
  }
  if (vals.length < 10) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)] || null;
}

// §12 老风 — the sharp fallback caster (words.caster wins when present). Opinion first, numbers after.
function localCaster(P, i, W, season) {
  const f5 = sumFlow(P, i - 4, i);
  const p5 = chg(P, i, 5);
  const w = P.wind[i], pr = P.pres[i], st = num(P.storm[i]), fr = num(P.front[i]);
  const cur = P.div.find((s) => s.start <= i && s.end >= i - 1);
  const k = season && season.key;
  let lead;
  if (cur && cur.dir > 0) lead = '价格在跌，钱却在偷偷进场——有人在低头捡筹码。';
  else if (cur && cur.dir < 0) lead = '价格还在涨，钱已经在往外溜，别当最后一棒。';
  else if (num(w) >= 0.5 && isNum(f5) && f5 < 0) lead = '关注度在升，钱却没真进来——热闹多半是换手。';
  else if (num(w) <= -0.5 && isNum(f5) && f5 > 0) lead = '人在散场，钱倒没真走——别急着唱衰。';
  else if (fr > 0) lead = '风向刚掉头：钱开始回来了，值得多看一眼。';
  else if (fr < 0) lead = '风向刚掉头：钱开始往外撤，先别恋战。';
  else if (st >= 1.5) lead = `波动炸了，是平时的 ${(st + 1).toFixed(1)} 倍，系好安全带。`;
  else if (k === 'spring') lead = '钱刚开始进场，人还不多——最像春天的样子。';
  else if (k === 'summer') lead = num(pr) >= 85 ? '挤成罐头了还往里冲的，多半是来接最后一棒的。' : '正当夏天：钱多人也多，热闹，但不便宜了。';
  else if (k === 'autumn') lead = '人还挤着，钱已经在撤——入秋了，跑慢的买单。';
  else if (k === 'winter') lead = num(w) <= -1.5 ? '钱在大逃离，冷得没人要。' : '冷清得像冰窖，没人管——可冬天之后才是春天。';
  else if (num(w) > 1.5) lead = '钱在狂涌进来，这阵风不小。';
  else if (num(w) >= 0.5) lead = '钱在慢慢流进来，还没到疯的时候。';
  else if (num(w) <= -1.5) lead = '钱在大逃离，别站在门口挡路。';
  else if (num(w) <= -0.5) lead = '钱在悄悄溜走，没人敲锣，但门是开着的。';
  else lead = '风平浪静，钱在别处热闹，它在原地发呆。';
  const out = [lead];
  if (isNum(f5)) {
    const typ = typical5(P, i);
    const ratio = typ ? Math.abs(f5) / typ : null;
    let s = `5天${f5 >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(f5))}`;
    if (ratio != null && ratio >= 1.6) s += `（平时的 ${ratio.toFixed(ratio >= 10 ? 0 : 1)} 倍）`;
    if (isNum(p5)) s += Math.abs(p5) < 0.003 ? '，价格几乎没动' : `，价格${p5 >= 0 ? '涨' : '跌'} ${W.pct(Math.abs(p5)).replace('+', '')}`;
    out.push(s + '。');
  }
  if (isNum(pr)) {
    if (pr >= 85) out.push(`拥挤度 ${Math.round(pr)}，人挤人，小心踩踏。`);
    else if (pr < 15) out.push(`拥挤度 ${Math.round(pr)}，没人看它。`);
  }
  return out.slice(0, 3);
}

// rebuild a 120-day volume profile from daily high/low/volume when the pipeline has none (§14 估)
function estimateProfile(P) {
  const i1 = P.n - 1, i0 = Math.max(P.first, i1 - 119);
  let lo = Infinity, hi = -Infinity;
  for (let j = i0; j <= i1; j++) {
    const a = isNum(P.l[j]) ? P.l[j] : P.c[j], b = isNum(P.h[j]) ? P.h[j] : P.c[j];
    if (isNum(a)) lo = Math.min(lo, a);
    if (isNum(b)) hi = Math.max(hi, b);
  }
  if (!isFinite(lo) || !(hi > lo)) return null;
  const NB = 40, step = (hi - lo) / NB;
  const bins = Array.from({ length: NB }, (_, k) => lo + step * (k + 0.5));
  const buy = new Array(NB).fill(0), sell = new Array(NB).fill(0);
  for (let j = i0; j <= i1; j++) {
    const dv = P.dv[j];
    if (!isNum(dv) || dv <= 0) continue;
    const a = isNum(P.l[j]) ? P.l[j] : P.c[j], b = isNum(P.h[j]) ? P.h[j] : P.c[j];
    const tgt = isNum(P.flow[j]) && P.flow[j] < 0 ? sell : buy;
    const k0 = clamp(Math.floor((a - lo) / step), 0, NB - 1), k1 = clamp(Math.floor((b - lo) / step), 0, NB - 1);
    const share = dv / (k1 - k0 + 1);
    for (let k = k0; k <= k1; k++) tgt[k] += share;
  }
  return { lo, hi, bins, buy, sell };
}

// ------------------------------------------------------------------------------------------------
// 真钱 (§23/§24 real-money layer): data/flows/{etf,china,stablecoins,ici,cot}.json — items
// {id|ticker, date[], usd[] (USD m), source, asOf}, est:false. Loaded once per page, only when the folder
// listing says the files exist (no 404 noise). Re-read after a data reload (resetRealFlows()).
// ------------------------------------------------------------------------------------------------
let realFlowsP = null;
export function resetRealFlows() { realFlowsP = null; }
function flowItems(raw, file) {
  if (!raw) return [];
  let list = Array.isArray(raw) ? raw : null;
  if (!list) for (const k of ['items', 'series', 'flows', 'etfs', 'data', 'list']) if (Array.isArray(raw[k])) { list = raw[k]; break; }
  if (!list && typeof raw === 'object') {
    list = Object.entries(raw).filter(([, v]) => v && typeof v === 'object' && Array.isArray(v.usd)).map(([k, v]) => ({ ticker: k, ...v }));
  }
  return (list || []).filter((x) => x && Array.isArray(x.usd) && Array.isArray(x.date || x.dates))
    .map((x) => ({ ...x, date: x.date || x.dates, file, source: x.source || raw.source || null, asOf: x.asOf || raw.asOf || null }));
}
function loadRealFlows(app) {
  if (realFlowsP) return realFlowsP;
  realFlowsP = (async () => {
    const idx = new Map();
    const D = app && app.data;
    if (!D || typeof D.listDir !== 'function') return idx;
    const top = await D.listDir('data/').catch(() => null);
    if (!top || !top.has('flows/')) return idx;
    const names = await D.listDir('data/flows/').catch(() => null);
    const files = names ? [...names].filter((n) => /^[\w-]+\.json$/.test(n)) : [];
    await Promise.all(files.map(async (f) => {
      try {
        const raw = await fetchJSON('data/flows/' + f, { cache: false });
        for (const it of flowItems(raw, f.replace(/\.json$/, ''))) {
          for (const k of [it.ticker, it.id, it.t]) {
            if (!k) continue;
            const key = String(k).replace(/^s:/i, '').toUpperCase();
            if (!idx.has(key)) idx.set(key, it);
          }
        }
      } catch { /* one bad file never blanks the rest */ }
    }));
    return idx;
  })();
  return realFlowsP;
}
const REAL_KIND = { etf: 'ETF 申购赎回', china: '北向 / 南向资金', stablecoins: '稳定币净发行', ici: '基金周度申赎（ICI）', cot: '期货持仓（CFTC）' };

// ------------------------------------------------------------------------------------------------
// 为什么？(§21, §24) — every view calls app.why(target, anchorEl). Until the shell's ui/why.js provides
// app.why, askWhy() does the same in place: POST /api/why → "老风派人去查了… 排队第 N" → the reason card
// right where the owner clicked. With no why backend at all (old server) it sends the scout instead
// (app.ask 'ask') and lands that answer in the same spot. Exported: web.js uses it for graph edges.
// ------------------------------------------------------------------------------------------------
const WHY_TYPES = { news: '新闻', earnings: '财报', macro: '宏观', policy: '政策', 'flow-mechanics': '资金机制', rumor: '传闻' };
const ago = (at) => {
  const t = at ? new Date(at).getTime() : NaN;
  if (!isFinite(t)) return '';
  const m = Math.max(0, (Date.now() - t) / 60000);
  return m < 1.5 ? '刚刚查的' : m < 60 ? `${Math.round(m)} 分钟前查的` : m < 48 * 60 ? `${Math.round(m / 60)} 小时前查的` : `${Math.round(m / 1440)} 天前查的`;
};
async function apiCall(app, path, { method = 'GET', body = null } = {}) {
  const D = app && app.data;
  if (D && typeof D.api === 'function') return D.api(path, { method, body });
  try {
    const r = await fetch('api/' + path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) return { error: r.status === 404 || r.status === 501 ? 'no-server' : `服务器返回 ${r.status}`, status: r.status };
    return await r.json();
  } catch { return { error: 'no-server' }; }
}
const isBudget = (r) => !!r && (r.refused === 'budget' || r.state === 'refused' || /额度|budget/i.test(String(r.error || '')));
function budgetLine(r) {
  const at = r && (r.resetsAtLocal || r.resetsAt || (r.budget && r.budget.resetsAtLocal));
  return `今天的额度用完了（${at ? `明天 ${String(at).replace(/^.*T/, '').slice(0, 5)} 恢复` : '明天恢复'}）`;
}
function linkEl(url, text) {
  const ok = /^https?:\/\//i.test(String(url || ''));
  return ok ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: text || '出处' }) : h('span', { text: text || '' });
}

// 量到的: one labelled row per fact (怎么了 / 多少钱 / 从哪天 / 比邻居), first two shown, the rest behind 展开.
// Text is cleaned for the card: no OS emoji (§17), a real minus sign, raw weather scores folded into their word
// (「温度 -1.99（很冷）」→「温度很冷」), and number + unit never split across lines.
const FACT_ROWS = [['what', '怎么了'], ['howMuch', '多少钱'], ['since', '从哪天'], ['vsNeighbours', '比邻居']];
const NOWRAP_RX = /((?:[\u3400-\u9fff]{1,2}\s?)?[+\-−–~约]?\d[\d.,]*\s*(?:%|％|亿美元|万美元|美元|亿|万|天|个交易日|个点|个|倍|年|月|日|号|bp)?)/g;
function factText(x) {
  const s = typeof x === 'string' ? x : x && typeof x === 'object' ? (x.text || x.say || '') : x == null ? '' : String(x);
  return plain(s)
    .replace(/(风|温度)\s*[+\-−]?\d+(?:\.\d+)?\s*[（(]([^）)]{1,8})[）)]/g, '$1$2')
    .replace(/(^|[^\d\w])-(?=\d)/g, '$1−')
    .trim();
}
function nowrapNodes(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(NOWRAP_RX)) {
    if (!/\d/.test(m[1])) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { class: 'svw-nw', text: m[1] }));
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function factsEl(f) {
  const rows = FACT_ROWS.map(([k, label]) => {
    let v = factText(f[k]);
    if (k === 'since' && v && !/起|以来|从/.test(v)) v = `从${v}起`;
    return v ? h('div', { class: 'svw-fact' }, h('span', { class: 'svw-fact-k', text: label }), h('span', { class: 'svw-fact-v' }, nowrapNodes(v))) : null;
  }).filter(Boolean);
  if (!rows.length) return null;
  const box = h('div', { class: 'svw-facts' }, h('div', { class: 'svw-facts-h', text: '量到的' }), rows.slice(0, 2));
  if (rows.length > 2) {
    const rest = rows.slice(2);
    rest.forEach((r) => { r.hidden = true; });
    box.append(...rest, h('button', { class: 'svw-link svw-facts-more', type: 'button', text: `展开（还有 ${rest.length} 条）`,
      onclick: (e) => { e.stopPropagation(); rest.forEach((r) => { r.hidden = false; }); e.currentTarget.remove(); } }));
  }
  return box;
}

/** The reason card (§21 原因卡): opinion line, the measured facts, reasons newest first with date + linked
 *  source, the other side, what to watch, the honest note, age + 重新查. */
export function whyCardEl(card, { onRequery } = {}) {
  const c = card || {};
  const f = c.facts || {};
  const byDate = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
  const item = (r, cls) => h('li', { class: cls },
    h('span', { class: 'svw-type t-' + String(r.type || 'news').replace(/[^\w-]/g, '') , text: WHY_TYPES[r.type] || '线索' }),
    h('span', { class: 'svw-text', text: plain(r.text) }),
    h('span', { class: 'svw-meta' },
      r.date ? h('span', { class: 'svw-date', text: String(r.date).slice(0, 10) }) : null,
      r.source || r.url ? linkEl(r.url, r.source || '出处') : null,
      isNum(r.conf) ? h('span', { class: 'svw-conf', text: r.conf >= 0.8 ? '把握大' : r.conf >= 0.5 ? `把握${Math.round(r.conf * 10)}成` : '把握不大' }) : null));
  const reasons = (Array.isArray(c.reasons) ? c.reasons : []).filter((r) => r && r.text).slice().sort(byDate);
  const counter = (Array.isArray(c.counter) ? c.counter : []).map((r) => (typeof r === 'string' ? { text: r } : r)).filter((r) => r && r.text);
  const watch = (Array.isArray(c.watch) ? c.watch : []).filter((w) => w && (w.what || typeof w === 'string'));
  const re = onRequery ? h('button', { class: 'svw-link', type: 'button', text: '重新查', title: '再派一次（会再用一点额度）', onclick: (e) => { e.stopPropagation(); onRequery(); } }) : null;
  return h('div', { class: 'svw-card' },
    c.say ? h('p', { class: 'svw-say' }, h('b', { class: 'svw-who', text: '老风' }), plain(c.say)) : null,
    factsEl(f),
    reasons.length ? h('ol', { class: 'svw-reasons' }, reasons.map((r) => item(r, 'svw-r'))) : null,
    counter.length ? h('div', { class: 'svw-sec' }, h('div', { class: 'svw-sec-h', text: '反方' }), h('ol', { class: 'svw-reasons' }, counter.map((r) => item(r, 'svw-r counter')))) : null,
    watch.length ? h('div', { class: 'svw-sec' }, h('div', { class: 'svw-sec-h', text: '接下来盯' }),
      h('ul', { class: 'svw-watch' }, watch.map((w) => h('li', {}, typeof w === 'string' ? w : [w.by ? h('b', { text: String(w.by).slice(0, 10) }) : null, plain(w.what)])))) : null,
    c.honest ? h('p', { class: 'svw-honest', text: plain(c.honest) }) : null,
    h('div', { class: 'svw-foot' }, h('span', { text: [ago(c.at), c.asOf ? `数据截至 ${c.asOf}` : null].filter(Boolean).join(' · ') }), re));
}

/** A scout answer ({say, answer, line, sources, changes, conf}) in the same card look. */
export function scoutAnswerEl(r, { onRequery } = {}) {
  const src = (Array.isArray(r.sources) ? r.sources : []).map((s) => (typeof s === 'string' ? { url: s } : s)).filter((s) => s && (s.url || s.title));
  const changes = (Array.isArray(r.changes) ? r.changes : []).map((c) => (typeof c === 'string' ? c : c && c.what)).filter(Boolean);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '出处'; } };
  return h('div', { class: 'svw-card' },
    r.say ? h('p', { class: 'svw-say' }, h('b', { class: 'svw-who', text: '侦察兵' }), plain(r.say)) : null,
    r.answer && r.answer !== r.say ? h('p', { class: 'svw-answer', text: plain(String(r.answer)).slice(0, 600) }) : null,
    !r.say && !r.answer && r.line ? h('p', { class: 'svw-answer', text: plain(r.line) }) : null,
    changes.length ? h('div', { class: 'svw-sec' }, h('div', { class: 'svw-sec-h', text: '改动了什么' }), h('ul', { class: 'svw-watch' }, changes.slice(0, 4).map((c) => h('li', { text: c })))) : null,
    src.length ? h('div', { class: 'svw-srcs' }, h('span', { text: '出处：' }), src.slice(0, 4).map((s) => linkEl(s.url, s.title || host(s.url)))) : null,
    h('div', { class: 'svw-foot' }, h('span', { text: [ago(r.finishedAt) || '刚查完', isNum(r.conf) ? (r.conf >= 0.8 ? '把握大' : `把握${Math.round(r.conf * 10)}成`) : null].filter(Boolean).join(' · ') }),
      onRequery ? h('button', { class: 'svw-link', type: 'button', text: '重新查', onclick: (e) => { e.stopPropagation(); onRequery(); } }) : null));
}

/** "老风派人去查了… 排队第 N" / "侦察兵在查… 42 秒" — one status line with a quiet ticking dot. */
export function whyWaitEl(text, sub) {
  return h('div', { class: 'svw-wait', role: 'status' }, h('i', { class: 'svw-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'svw-wait-t', text }), sub ? h('span', { class: 'svw-wait-s', text: sub }) : null);
}

class WhyRun {
  constructor(app, target, slot, opts) {
    this.app = app; this.target = target; this.slot = slot; this.opts = opts || {};
    this.timer = 0; this.tick = 0; this.dead = false; this.t0 = Date.now(); this.lost = 0;
  }
  stop() { this.dead = true; clearTimeout(this.timer); clearInterval(this.tick); }
  alive() {
    if (this.dead) return false;
    if (!this.slot.isConnected) { if (++this.lost > 3) { this.stop(); return false; } } else this.lost = 0;
    return true;
  }
  show(...kids) { if (!this.dead) put(this.slot, ...kids); if (typeof this.opts.onChange === 'function') this.opts.onChange(); }
  wait(state, pos) {
    this.state = state; this.pos = pos;
    const paint = () => {
      if (!this.alive()) return;
      const s = Math.round((Date.now() - this.t0) / 1000);
      if (this.state === 'queued') this.show(whyWaitEl('老风派人去查了…', isNum(this.pos) && this.pos > 0 ? `排队第 ${this.pos}` : '排队中'));
      else this.show(whyWaitEl(this.via === 'scout' ? '侦察兵在查…' : '老风派人去查了…', `${s} 秒 · 通常 30–90 秒`));
    };
    paint();
    clearInterval(this.tick);
    this.tick = setInterval(paint, 1000);
  }
  fail(text, retry = true) {
    clearInterval(this.tick);
    this.show(h('div', { class: 'svw-fail' }, h('span', { text }),
      retry ? h('button', { class: 'svw-link', type: 'button', text: '再试一次', onclick: (e) => { e.stopPropagation(); this.start(true); } }) : null));
  }
  async start(force = false) {
    this.dead = false; this.t0 = Date.now(); this.via = 'why';
    this.wait('queued', null);
    const r = await apiCall(this.app, 'why', { method: 'POST', body: { target: this.target, ...(force ? { force: true } : {}) } });
    if (!this.alive()) return;
    if (r && r.error === 'no-server') return this.viaScout(force);
    if (isBudget(r)) { clearInterval(this.tick); return this.show(h('div', { class: 'svw-fail budget', text: budgetLine(r) })); }
    if (!r || r.error) return this.fail(`没派出去：${(r && r.error) || '服务器没回应'}`);
    if (r.card && (r.state === 'cached' || r.state === 'done')) return this.done(r.card);
    this.id = r.id;
    if (!this.id) return this.peekPoll();           // already being asked elsewhere: wait for its card
    this.wait(r.state === 'running' ? 'running' : 'queued', r.position ?? (isNum(r.ahead) ? r.ahead + 1 : null));
    this.poll();
  }
  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.alive()) return;
      const r = await apiCall(this.app, 'why?id=' + encodeURIComponent(this.id));
      if (!this.alive()) return;
      if (r && r.card && (r.state === 'done' || r.state === 'cached')) return this.done(r.card);
      if (isBudget(r)) { clearInterval(this.tick); return this.show(h('div', { class: 'svw-fail budget', text: budgetLine(r) })); }
      if (r && (r.state === 'error' || r.state === 'failed' || r.state === 'unknown')) return this.fail(`没查成：${r.error || '侦察兵空手回来'}`);
      if (Date.now() - this.t0 > 15 * 60e3) return this.fail('等太久了，可能卡住了');
      if (r && !r.error) { this.state = r.state === 'running' ? 'running' : 'queued'; this.pos = r.position ?? (isNum(r.ahead) ? r.ahead + 1 : this.pos); }
      this.poll();
    }, Date.now() - this.t0 < 20000 ? 2000 : 4000);
  }
  peekPoll() {
    this.wait('running', null);
    const step = async () => {
      if (!this.alive()) return;
      const r = await apiCall(this.app, 'why/peek', { method: 'POST', body: { target: this.target } });
      if (!this.alive()) return;
      if (r && r.card) return this.done(r.card);
      if (r && r.id && r.state !== 'none') { this.id = r.id; return this.poll(); }
      if (Date.now() - this.t0 > 15 * 60e3 || (r && r.state === 'none' && Date.now() - this.t0 > 20000)) return this.fail('没等到结果');
      this.timer = setTimeout(step, 4000);
    };
    this.timer = setTimeout(step, 2500);
  }
  done(card) {
    clearInterval(this.tick);
    this.show(whyCardEl(card, { onRequery: () => this.start(true) }));
    if (typeof this.opts.onDone === 'function') this.opts.onDone(card);
  }
  // no /api/why on this server: the scout answers the same question (shows up in the 🔎 panel too)
  async viaScout(force) {
    this.via = 'scout';
    const app = this.app;
    const q = this.opts.question;
    if (!app || typeof app.ask !== 'function' || !q) return this.fail('「为什么」还没接上服务器，过一会儿再来', false);
    let r;
    const before = scoutCards();
    try { r = await app.ask('ask', this.opts.scoutTarget ?? null, force ? q + '（重新查）' : q); } catch (e) { r = { error: e && e.message }; }
    if (!this.alive()) return;
    // the scout panel already put its own live card right here: let it speak, say nothing twice
    if (r && !r.error && newScoutCard(before)) { clearInterval(this.tick); this.show(h('div', { class: 'svw-wait' }, h('span', { class: 'svw-wait-s', text: '侦察兵出发了，进度和答案在下面这张卡里。' }))); return; }
    this.follow(r);
  }
  /** follow a scout job that is already dispatched (r = what app.ask / POST /api/scout answered) */
  follow(r) {
    const app = this.app;
    this.via = 'scout';
    this.t0 = Date.now();
    if (!r || r.error) return this.fail(r && r.error === 'no-server' ? '要用 server.py 打开本页，老风才能派人去查' : `没派出去：${(r && r.error) || '未知'}`, !!this.opts.question && !(r && r.error === 'no-server'));
    if (isBudget(r)) { clearInterval(this.tick); return this.show(h('div', { class: 'svw-fail budget', text: budgetLine(r) })); }
    if (r.state === 'cached' || r.cached || r.state === 'done') return this.scoutDone(r);
    if (!r.id) return this.fail('没派出去', false);
    this.id = r.id;
    this.wait(r.state === 'running' ? 'running' : 'queued', null);
    const step = async () => {
      if (!this.alive()) return;
      const s = await apiCall(app, 'scout?id=' + encodeURIComponent(this.id));
      if (!this.alive()) return;
      if (s && (s.state === 'done' || s.state === 'cached')) return this.scoutDone(s);
      if (s && /fail|error|expired|unknown/.test(String(s.state))) return this.fail(`没查成：${s.error || '侦察兵空手回来'}`);
      if (Date.now() - this.t0 > 30 * 60e3) return this.fail('等太久了，可能卡住了');
      if (s && s.state) this.state = s.state === 'running' ? 'running' : 'queued';
      this.timer = setTimeout(step, 3000);
    };
    this.timer = setTimeout(step, 1500);
  }
  scoutDone(r) {
    clearInterval(this.tick);
    const again = this.target ? () => this.start(true) : this.opts.onRequery || null;
    this.show(scoutAnswerEl(r, { onRequery: again }));
    if (typeof this.opts.onDone === 'function') this.opts.onDone(r);
  }
}
/** ui/scout.js lands its own answer card (.ops-scard) where the owner clicked; views that also track a job
 *  snapshot the cards before dispatch and stay quiet while that card is on screen (never two of the same). */
export const scoutCards = () => new Set(document.querySelectorAll('.ops-scard'));
export function newScoutCard(before) {
  for (const c of document.querySelectorAll('.ops-scard')) if (!before.has(c)) return c;
  return null;
}
/** Land an already-dispatched scout job (app.ask's answer) in `slot`: queue → 在查… → the answer. */
export function followScout(app, r, slot, opts = {}) {
  const run = new WhyRun(app || globalThis.__mw || null, null, slot, opts);
  run.follow(r);
  return run;
}

/** Does the shell's ui/why.js own the reason card? (then every view just calls app.why) */
export const hasAppWhy = (app) => !!(app && typeof app.why === 'function');

/** Open the shell's reason card (app.why) next to `anchor` or at `rect`, and make sure it is not hidden
 *  under the overlay that asked (the card is appended to <body>; the 关系网 sits at z 45). */
export function openAppWhy(app, target, { anchor = null, rect = null, lift = null } = {}) {
  let r = null;
  try { r = app.why(target, anchor && anchor.isConnected ? anchor : null, rect ? { rect } : {}); } catch (e) { console.warn('[why] app.why', e); return null; }
  if (lift) requestAnimationFrame(() => liftWhyCard(lift));
  return r;
}
/** Re-home a body-level .why-card into `host` when it would otherwise render beneath it. */
export function liftWhyCard(host) {
  if (!host || !host.isConnected) return;
  const zHost = parseInt(getComputedStyle(host).zIndex, 10);
  for (const card of document.querySelectorAll('body > .why-card')) {
    const z = parseInt(getComputedStyle(card).zIndex, 10);
    if (!isFinite(z) || (isFinite(zHost) && z <= zHost)) host.append(card);
  }
}

/** Ask "为什么？" about target {kind, ids, dateIndex, map} and land the answer in `slot` with the local
 *  runner (used when app.why is not there). opts: {question, scoutTarget} for the scout fallback,
 *  onDone(card), onChange(). Returns {stop()}. */
export function askWhy(app, target, slot, opts = {}) {
  app = app || globalThis.__mw || null;
  const run = new WhyRun(app, target, slot, opts);
  run.start();
  return run;
}

// ------------------------------------------------------------------------------------------------
// the view
// ------------------------------------------------------------------------------------------------
export function openStockView(rootEl, ticker, opts = {}) {
  const view = new StockView(rootEl, ticker, opts);
  globalThis.__mwStock = view;      // debugging / headless walkthroughs only (like window.__mw)
  return {
    setDate: (i) => view.setDate(i),
    close: () => view.close(),
    setTicker: (t) => view.load(t),
    setTheme: (t) => view.setTheme(t),
    refresh: () => view.refresh(),
  };
}

class StockView {
  constructor(rootEl, ticker, opts) {
    this.root = rootEl || document.body;
    this.opts = opts || {};
    this.app = this.opts.app || globalThis.__mw || null;
    this.W = makeWords(this.opts.words);
    this.base = this.opts.dataBase ?? 'data/';
    this.apiBase = this.opts.apiBase ?? '';
    this.intradayMs = this.opts.intradayMs ?? 60000;
    this.dateIndex = isNum(this.opts.dateIndex) ? this.opts.dateIndex : null;
    this.closed = false;
    this.token = 0;
    this.peers = [];
    this.intra = null;
    this.reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build();
    this.load(ticker);
  }

  // ---------------------------------------------------------------- skeleton
  build() {
    const contained = this.root !== document.body && getComputedStyle(this.root).position !== 'static';
    this.el = {};
    const E = this.el;
    E.backLabel = h('span', { class: 'sv-back-label', text: '返回地图' });
    E.back = h('button', { class: 'sv-back', type: 'button', title: '回到地图（Esc）', onclick: () => this.requestClose() }, icon('back'), E.backLabel);
    E.planet = h('canvas', { class: 'sv-planet', 'aria-hidden': 'true' });
    E.name = h('h2', { class: 'sv-name' });
    E.ticker = h('span', { class: 'sv-ticker' });
    E.season = h('div', { class: 'sv-season', tabindex: 0 });
    E.note = h('div', { class: 'sv-note' });
    E.px = h('div', { class: 'sv-px' });
    E.when = h('div', { class: 'sv-when' });
    E.chg = h('div', { class: 'sv-chg' });
    E.webBtn = h('button', { class: 'sv-act', type: 'button', title: '看它和谁做生意、钱往哪边走（关系网）', onclick: () => this.openWeb() },
      icon('web'), h('span', { text: '关系网' }));
    E.askBtn = h('button', { class: 'sv-act sv-act-ask', type: 'button', title: '派 Claude 上网查原因，带出处回来', 'aria-haspopup': 'dialog', onclick: () => this.toggleAsk() },
      icon('ask'), h('span', { text: '让 Claude 去查' }));
    E.strip = h('div', { class: 'sv-strip', role: 'list', 'aria-label': '今天的天气' });
    E.caster = h('div', { class: 'sv-caster-body' });
    E.riverCap = h('div', { class: 'sv-cap' });
    E.riverSvg = svgEl('svg', { class: 'sv-river-svg', role: 'img' });
    E.mtnCap = h('div', { class: 'sv-cap' });
    E.mtnSvg = svgEl('svg', { class: 'sv-mtn-svg', role: 'img' });
    E.mtnFoot = h('div', { class: 'sv-mtn-foot' });
    E.mtnEst = h('span', { class: 'sv-card-est' });

    E.intraHead = h('div', { class: 'sv-intra-head' });
    E.intraSub = h('span', { class: 'sv-card-sub' });
    E.intraLine = h('div', { class: 'sv-intra-line' });
    E.intraSvg = svgEl('svg', { class: 'sv-intra-svg', role: 'img' });
    E.intraBox = h('div', { class: 'sv-intra-body' }, E.intraLine, h('div', { class: 'sv-intra-chart' }, E.intraSvg));
    E.peers = h('div', { class: 'sv-peer-list' });
    E.peersWhere = h('span', { class: 'sv-peers-where' });
    E.tip = h('div', { class: 'sv-tip', role: 'tooltip' });
    E.msg = h('div', { class: 'sv-msg' });
    E.note2 = h('div', { class: 'sv-toast', role: 'status', 'aria-live': 'polite' });

    const legend = h('div', { class: 'sv-legend' },
      h('span', { class: 'sv-lg sv-lg-price' }, h('i'), '价格'),
      h('span', { class: 'sv-lg sv-lg-cum' }, h('i'), '累计流入'),
      h('span', { class: 'sv-lg sv-lg-bar' }, h('i', { class: 'in' }), h('i', { class: 'out' }), '每天进 / 出'),
      E.realLegend = h('span', { class: 'sv-lg sv-lg-real', title: '小圆点 = 实测的真钱（申购赎回等公开披露），和柱子同一把尺，不是估算', style: { display: 'none' } }, h('i'), '真钱'),
      E.bandLegend = h('span', { class: 'sv-lg sv-lg-band', title: '斜线区 = 价格和钱反着走（背离）：绿 = 价格跌但钱在进，红 = 价格涨但钱在出' }, h('i'), '背离'));
    const mtnLegend = h('div', { class: 'sv-legend' },
      h('span', { class: 'sv-lg sv-lg-buy' }, h('i'), '买盘多'),
      h('span', { class: 'sv-lg sv-lg-sell' }, h('i'), '卖盘多'));

    E.river = h('section', { class: 'sv-card sv-river' },
      h('div', { class: 'sv-card-head' },
        h('div', { class: 'sv-card-row' }, h('h3', { class: 'sv-card-title', text: '资金河流' }), h('span', { class: 'sv-card-sub', text: '一年 · 每根柱子是一天' }), legend),
        E.riverCap),
      h('div', { class: 'sv-chart' }, E.riverSvg));
    E.mtn = h('section', { class: 'sv-card sv-mtn' },
      h('div', { class: 'sv-card-head' },
        h('div', { class: 'sv-card-row' }, h('h3', { class: 'sv-card-title', text: '筹码山' }), h('span', { class: 'sv-card-sub', text: '最近120天' }), E.mtnEst, mtnLegend),
        E.mtnCap),
      h('div', { class: 'sv-chart sv-chart-mtn' }, E.mtnSvg), E.mtnFoot);
    E.intra = h('section', { class: 'sv-card sv-intra' },
      h('div', { class: 'sv-card-head sv-card-head-1' },
        h('div', { class: 'sv-card-row' }, h('h3', { class: 'sv-card-title', text: '今天盘中' }), E.intraSub, E.intraHead)),
      E.intraBox);

    E.main = h('div', { class: 'sv-main' }, E.river, h('div', { class: 'sv-side' }, E.mtn, E.intra));
    E.peerBar = h('section', { class: 'sv-peers', 'aria-label': '邻居' },
      h('div', { class: 'sv-peers-title' },
        h('b', { text: '邻居' }), E.peersWhere,
        h('span', { class: 'sv-peers-key', text: '点一下换过去' })),
      E.peers);

    E.head = h('header', { class: 'sv-head' },
      E.back,
      E.planet,
      h('div', { class: 'sv-id' },
        h('div', { class: 'sv-name-row' }, E.name, E.ticker, E.season),
        E.note),
      h('div', { class: 'sv-price' }, h('div', { class: 'sv-px-row' }, E.px, E.when), E.chg),
      h('div', { class: 'sv-actions' }, E.webBtn, E.askBtn));
    E.casterBox = h('section', { class: 'sv-caster', 'aria-live': 'polite' },
      h('div', { class: 'sv-seal', title: '老风：看过太多轮回的天气播报员，说话直，不负责安慰。', 'aria-label': '老风说' }, h('span', { text: '老' }), h('span', { text: '风' })),
      E.caster);
    E.row2 = h('div', { class: 'sv-row2' }, E.casterBox, E.strip);

    E.inner = h('div', { class: 'sv-inner' }, E.head, E.row2, E.main, E.peerBar);
    E.overlay = h('div', { class: 'sv' + (contained ? ' sv--contained' : ''), role: 'dialog', 'aria-modal': contained ? null : 'true', 'aria-label': '个股小星球' },
      h('div', { class: 'sv-paper', 'aria-hidden': 'true' }), E.inner, E.msg, E.tip, E.note2);
    if (this.opts.theme === 'day' || this.opts.theme === 'night') E.overlay.dataset.theme = this.opts.theme;
    this.root.append(E.overlay);
    this.readColors();
    requestAnimationFrame(() => E.overlay.classList.add('sv-in'));

    this.onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (this.popEl) this.closePop(true);
      else if (this.askEl) this.closeAsk(true);
      else this.requestClose();
    };
    window.addEventListener('keydown', this.onKey);
    this.onDown = (e) => {
      if (this.askEl && !this.askEl.contains(e.target) && !E.askBtn.contains(e.target)) this.closeAsk();
      // a reason card stays while the owner reads / scrolls it; any other click (except the thing that opens one) shuts it
      if (this.popEl && !this.popEl.contains(e.target) && !e.target.closest?.('.sv-why, .sv-hit')) this.closePop();
      else if (!this.popEl && this.dayPin != null && !e.target.closest?.('.sv-hit, .why-card')) { this.dayPin = null; this.paintDayPin(); }
    };
    E.overlay.addEventListener('pointerdown', this.onDown);
    this.ro = new ResizeObserver(() => this.scheduleDraw());
    this.ro.observe(E.main);
    this.onVis = () => { if (!document.hidden && this.P) this.refreshIntraday(true); };
    document.addEventListener('visibilitychange', this.onVis);
    // follow <html data-theme> (the shell's day/night toggle)
    this.mo = new MutationObserver(() => this.readColors());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    // the shell's 语气 toggle (§12): re-speak in the new voice
    const app = this.opts.app;
    if (app && typeof app.on === 'function') {
      try { this.offVoice = app.on('voice', () => this.refresh()); } catch { /* optional */ }
      // ui/realmoney.js loads after a deep link straight to #/stock/…: re-speak once its rule is there (no old sign test)
      try { this.offRealMoney = app.on('realmoney', () => { if (this.P && !this.closed) { this.renderWeather(); this.renderCaster(); } }); } catch { /* optional */ }
      // new real-money files (§23) show up without a page reload
      try {
        this.offData = app.on('dataReloaded', (x) => {
          const parts = x && x.parts;
          if (parts && ![].concat(parts).some((q) => /flows|all|meta/.test(String(q)))) return;
          resetRealFlows();
          try { app.data?.forgetDir?.('data/'); app.data?.forgetDir?.('data/flows/'); } catch { /* optional */ }
          if (this.P && !this.closed) this.loadReal(this.token);
        });
      } catch { /* optional */ }
    }
    E.overlay.tabIndex = -1;
    E.overlay.focus({ preventScroll: true });
  }

  readColors() {
    const cs = getComputedStyle(this.el.overlay);
    const g = (k, d) => (cs.getPropertyValue(k) || '').trim() || d;
    this.colors = {
      ink: g('--sv-ink', '#1f2a44'), ink3: g('--sv-ink3', '#8b8778'), in: g('--sv-in', '#4f9468'), out: g('--sv-out', '#a6434a'),
      gold: g('--sv-gold', '#d9992c'), card: g('--sv-card', '#fbf8f1'), rim: g('--sv-rim', 'rgba(255,255,255,.75)'),
      bands: BANDS_DAY.map((d, k) => g(`--sv-t${k}`, d)),
    };
    // recolour the bits that carry a temperature colour inline
    if (this.P && this.el.strip.childElementCount) { this.renderWeather(); this.updatePeers(); }
    if (this.planetFrame && (this.reduceMotion || !this.planetRaf)) this.planetFrame(performance.now());
  }

  setTheme(t) {
    if (t === 'day' || t === 'night') this.el.overlay.dataset.theme = t;
    else delete this.el.overlay.dataset.theme;
    this.readColors();
  }

  refresh() {
    if (!this.P || this.closed) return;
    this.applyDate(true);
  }

  requestClose() {
    if (this.closed) return;
    this.close();
    if (typeof this.opts.onClose === 'function') this.opts.onClose();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('visibilitychange', this.onVis);
    this.ro?.disconnect();
    this.mo?.disconnect();
    if (typeof this.offVoice === 'function') { try { this.offVoice(); } catch { /* ignore */ } }
    if (typeof this.offData === 'function') { try { this.offData(); } catch { /* ignore */ } }
    if (typeof this.offRealMoney === 'function') { try { this.offRealMoney(); } catch { /* ignore */ } }
    clearInterval(this.intraTimer);
    clearTimeout(this.noteTimer);
    cancelAnimationFrame(this.planetRaf);
    cancelAnimationFrame(this.drawRaf);
    this.closePop();
    this.askRun?.stop?.();
    // a reason card we lifted into our root goes away with us (ui/why.js must not keep a detached card)
    if (this.app && typeof this.app.whyClose === 'function' && (this.root.querySelector('.why-card') || this.el.overlay.querySelector('.why-card'))) {
      try { this.app.whyClose(); } catch { /* ignore */ }
    }
    const o = this.el.overlay;
    o.classList.remove('sv-in');
    o.classList.add('sv-out');
    const rm = () => o.remove();
    if (this.reduceMotion) rm(); else setTimeout(rm, 240);
  }

  // ---------------------------------------------------------------- loading
  async load(ticker) {
    const T = String(ticker || '').trim().replace(/^s:/, '').toUpperCase();
    const tok = ++this.token;
    this.T = T;
    clearInterval(this.intraTimer);
    this.intra = null;
    this.closeAsk();
    this.closePop();
    this.dayPin = null;
    this.el.overlay.classList.add('sv-loading');
    this.el.overlay.classList.toggle('sv-first', !this.P);
    this.showMsg(`正在把 ${T} 的小星球拉近…`);
    if (!d3g()) { this.showMsg('图表库 d3 没有加载，画不出来。', true); return; }
    let s;
    try {
      s = await fetchJSON(`${this.base}stocks/${encodeURIComponent(T)}.json`);
    } catch (e) {
      if (tok !== this.token || this.closed) return;
      const why = /404/.test(e.message) ? '可能它还没被收进地图，或者数据还在生成。' : '可能是网络不通，稍后再试一次。';
      this.showMsg(`没找到 ${T} 的天气数据。${why}`, true);
      return;
    }
    if (tok !== this.token || this.closed) return;
    try {
      this.P = prep(s);
      if (!this.P.n) throw new Error('空数据');
    } catch (e) {
      this.showMsg(`${T} 的数据格式不对：${e.message}`, true);
      return;
    }
    this.i = this.clampIndex(this.dateIndex ?? this.P.n - 1);
    this.el.overlay.setAttribute('aria-label', `个股小星球：${this.P.name} ${T}`);
    this.hideMsg();
    this.el.overlay.classList.remove('sv-loading', 'sv-first');
    this.el.inner.classList.remove('sv-swap');
    void this.el.inner.offsetWidth;
    this.el.inner.classList.add('sv-swap');
    this.pathLabel = null;
    this.renderStatic();
    this.drawCharts();
    this.peers = [];
    this.applyDate(true);
    this.startPlanet();
    this.loadPeers(tok);
    this.loadPathLabel(tok);
    this.loadReal(tok);
    this.refreshIntraday(true);
    this.intraTimer = setInterval(() => { if (!document.hidden) this.refreshIntraday(false); }, this.intradayMs);
  }

  showMsg(text, isError = false) {
    const E = this.el;
    put(E.msg,
      h('div', { class: 'sv-msg-card' + (isError ? ' err' : '') },
        h('div', { class: 'sv-msg-orb', 'aria-hidden': 'true' }),
        h('p', { text }),
        isError ? h('button', { class: 'sv-btn', type: 'button', text: '← 回到地图', onclick: () => this.requestClose() }) : null));
    E.msg.classList.add('on');
  }
  hideMsg() { this.el.msg.classList.remove('on'); }

  note(text) {
    const n = this.el.note2;
    n.textContent = text;
    n.classList.add('on');
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => n.classList.remove('on'), 2600);
  }

  clampIndex(i) {
    const n = this.P ? this.P.n : 252;
    if (!isNum(i)) return n - 1;
    return clamp(Math.round(i), Math.min(this.P ? this.P.first : 0, n - 1), n - 1);
  }

  setDate(i) {
    this.dateIndex = i;
    if (!this.P || this.closed) return;
    const j = this.clampIndex(i);
    if (j === this.i) return;
    this.i = j;
    this.applyDate(false);
  }

  // ---------------------------------------------------------------- header
  renderStatic() {
    const P = this.P, E = this.el;
    E.name.textContent = P.name;
    E.ticker.textContent = P.t;
    E.ticker.hidden = P.name === P.t;
    put(E.note,
      P.note ? h('span', { class: 'sv-note-what', text: P.note }) : null,
      this.pathLabel ? h('span', { class: 'sv-note-path', text: this.pathLabel }) : null);
    E.peersWhere.textContent = this.regionName ? `同在「${this.regionName}」` : '同一片区域';
  }

  async loadPathLabel(tok) {
    try {
      const list = await fetchJSON(`${this.base}search.json`);
      if (tok !== this.token || this.closed || !Array.isArray(list)) return;
      const hit = list.find((x) => x && (x.id === `s:${this.T}` || x.ticker === this.T));
      if (!hit || !Array.isArray(hit.path)) return;
      const path = hit.path.filter((p) => p && p !== '地球' && p !== hit.name);
      if (!path.length) return;
      this.pathLabel = path.join(' › ');
      this.regionName = path[path.length - 1];
      this.el.backLabel.textContent = `回到 ${this.regionName}`;
      this.renderStatic();
    } catch { /* optional */ }
  }

  // ---------------------------------------------------------------- 真钱 (real money, est:false)
  async loadReal(tok) {
    const had = !!(this.P && this.P.real);
    const redraw = () => { this.renderWeather(); this.renderCaster(); this.scheduleDraw(); };
    // §23: the stock file's own realFlow[] (flows/realflow.py --apply: issuer shares × NAV, T+1 already aligned to the
    // TRADE day, on this chart's dates) beats the issuer-dated flows/etf.json (whose dates run 1–3 days late)
    const raw = this.P && this.P.raw;
    if (raw && Array.isArray(raw.realFlow) && Array.isArray(raw.dates) && raw.realFlow.some(isNum)) {
      const byDay = new Map(raw.dates.map((d, k) => [String(d).slice(0, 10), raw.realFlow[k]]));
      const arr = this.P.dates.map((d) => { const v = byDay.get(String(d).slice(0, 10)); return isNum(v) ? v : null; });
      if (arr.some(isNum)) {
        this.P.real = { arr, kind: 'etf', src: raw.realSource || '发行商每日份额 × 净值', asOf: raw.realThrough || null, etf: true, tradeDated: true };
        redraw();
        return;
      }
    }
    let idx;
    try { idx = await loadRealFlows(this.app); } catch { return; }
    if (tok !== this.token || this.closed || !this.P) return;
    const it = idx.get(this.T);
    if (!it) { this.P.real = null; if (had) redraw(); return; }
    const map = new Map();
    it.date.forEach((d, k) => { const v = Number(it.usd[k]); if (d && isNum(v)) map.set(String(d).slice(0, 10), v); });
    const arr = this.P.dates.map((d) => (map.has(d) ? map.get(d) : null));
    if (!arr.some(isNum)) { this.P.real = null; if (had) redraw(); return; }
    this.P.real = { arr, kind: it.file, src: it.source || REAL_KIND[it.file] || '公开披露', asOf: it.asOf || null, etf: it.file === 'etf' };
    redraw();
  }
  /** the map's real-money verdict for this stock on day i (ui/realmoney.js, asked by the chart's own date) | null */
  realMoneyAt(i) {
    const app = this.opts && this.opts.app;
    if (!app || typeof app.realMoney !== 'function' || !this.P) return null;
    try { return app.realMoney('s:' + this.T, String(this.P.dates[i] || '')) || null; } catch { return null; }
  }
  /** real money over the 5 days ending at i (or at the last day it covers before i) → {sum, end, stale} */
  realAt(i) {
    const R = this.P && this.P.real;
    if (!R) return null;
    let end = -1;
    for (let j = i; j >= Math.max(0, i - 30); j--) if (isNum(R.arr[j])) { end = j; break; }
    if (end < 0) return null;
    let s = 0, k = 0;
    for (let j = Math.max(0, end - 4); j <= end; j++) if (isNum(R.arr[j])) { s += R.arr[j]; k++; }
    return k ? { sum: s, end, stale: end !== i, day: R.arr[i] } : null;
  }

  // ---------------------------------------------------------------- 为什么？ (§21) — reason cards in place
  /** global index into meta.dates for the stock's day j (the why API speaks the time machine's index) */
  gIdx(j) {
    const dates = this.app && this.app.meta && this.app.meta.dates;
    if (Array.isArray(dates) && dates.length) {
      const k = dates.indexOf(this.P.dates[j]);
      if (k >= 0) return k;
      return clamp(j - (this.P.n - dates.length), 0, dates.length - 1);
    }
    return j;
  }
  whyTarget(kind, j) {
    const t = { kind, ids: [`s:${this.T}`], dateIndex: this.gIdx(j) };
    const map = this.app && this.app.state && this.app.state.map;
    if (map) t.map = map;
    return t;
  }
  /** a small card anchored under `anchor` (or at a point), with a header + a slot for the reason card */
  openPop({ title, sub, anchor, at, cls = '', body = null }) {
    this.closePop();
    const E = this.el;
    const slot = h('div', { class: 'sv-pop-slot' });
    const x = h('button', { class: 'sv-pop-x', type: 'button', title: '关上（Esc）', 'aria-label': '关上', onclick: () => this.closePop(true) }, '×');
    const box = h('div', { class: 'sv-pop ' + cls, role: 'dialog', 'aria-label': title },
      h('div', { class: 'sv-pop-head' }, h('b', { class: 'sv-pop-title', text: title }), x),
      sub ? h('div', { class: 'sv-pop-sub', text: sub }) : null,
      body, slot);
    E.overlay.append(box);
    this.popEl = box;
    this.popAnchor = anchor || null;
    this.popAt = at || null;
    this.popKeep = null;
    this.placePop();
    requestAnimationFrame(() => box.classList.add('on'));
    return slot;
  }
  placePop() {
    const box = this.popEl;
    if (!box) return;
    const E = this.el;
    const R = E.overlay.getBoundingClientRect();
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let left, top;
    if (this.popAnchor && this.popAnchor.isConnected) {
      const b = this.popAnchor.getBoundingClientRect();
      left = b.left - R.left - 12;
      top = b.bottom - R.top + 8;
      this.popKeep = { left, top };
    } else if (this.popAnchor && this.popKeep) {
      // the strip re-rendered under us (date changed): stay where the owner clicked
      ({ left, top } = this.popKeep);
    } else if (this.popAt) {
      left = this.popAt.x - R.left - bw / 2;
      top = this.popAt.y - R.top + 14;
      if (top + bh > R.height - 8) top = this.popAt.y - R.top - bh - 14;   // no room below the bar: sit above it
    } else { left = (R.width - bw) / 2; top = 80; }
    left = clamp(left, 8, Math.max(8, R.width - bw - 8));
    top = clamp(top, 8, Math.max(8, R.height - bh - 8));
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top + E.overlay.scrollTop)}px`;
  }
  closePop(refocus = false) {
    if (!this.popEl) return;
    const box = this.popEl;
    this.popEl = null;
    this.whyRun?.stop?.();
    this.whyRun = null;
    box.classList.remove('on');
    setTimeout(() => box.remove(), this.reduceMotion ? 0 : 160);
    if (this.dayPin != null) { this.dayPin = null; this.paintDayPin(); }
    if (refocus && this.popAnchor && this.popAnchor.isConnected) this.popAnchor.focus({ preventScroll: true });
  }
  /** the shell's reason card lives in <body>; keep it above this overlay (see liftWhyCard) */
  whyHost() { return this.root !== document.body ? this.root : this.el.overlay; }
  /** header wind badge → 为什么钱在流进来 / 溜走 (target kind 'stock' at the time machine's day) */
  openWindWhy(anchor) {
    if (!this.P) return;
    if (hasAppWhy(this.app)) {
      this.closePop();
      openAppWhy(this.app, this.whyTarget('stock', this.i), { anchor, lift: this.whyHost() });
      return;
    }
    const P = this.P, i = this.i, W = this.W;
    const wd = this.metricAt('wind', i), f5 = sumFlow(P, i - 4, i), p5 = chg(P, i, 5);
    const word = this.windLabel(wd.v, f5, i).word;
    const sub = [`截至${dayLabel(P.dates[i], true)}`, isNum(f5) ? `5天${f5 >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(f5))}` : null, isNum(p5) ? `价格 ${signPct(W, p5)}` : null].filter(Boolean).join(' · ');
    const slot = this.openPop({ title: /^钱/.test(word) ? `为什么${P.name}的${word}？` : `${P.name}为什么${word}？`, sub, anchor, cls: 'sv-pop-why' });
    const q = `${P.name}（${P.t}）截至${dayLabel(P.dates[i], true)}：${word}，${sub.replace(/^截至[^·]+· /, '')}。为什么？找出这几天的新闻、财报、评级、资金动向，带日期和出处。`;
    this.whyRun = askWhy(this.app, this.whyTarget('stock', i), slot, { question: q, scoutTarget: `s:${this.T}`, onChange: () => this.placePop() });
  }
  /** click a day's flow bar (anywhere in that day's column) → 那天为什么？ (§21: one click, Claude searches
   *  the news around that exact date; the same day is cached, so a second click is free) */
  openDay(j, ev) {
    const P = this.P, W = this.W;
    if (!P) return;
    this.closePop();
    this.dayPin = j;
    this.paintDayPin();
    if (hasAppWhy(this.app)) {
      const pin = this.lay && this.lay.pin && this.lay.pin.node();
      const pr = pin && pin.style.display !== 'none' ? pin.getBoundingClientRect() : null;
      const rect = pr && pr.width ? { left: pr.left, top: pr.top, right: pr.right, bottom: pr.bottom }
        : { left: ev.clientX - 4, top: ev.clientY - 4, right: ev.clientX + 4, bottom: ev.clientY + 4 };
      openAppWhy(this.app, this.whyTarget('day', j), { rect, lift: this.whyHost() });
      return;
    }
    // no shell reason card: our own, with the day's numbers on top
    const f = P.flow[j], r1 = chg(P, j, 1);
    const real = P.real && isNum(P.real.arr[j]) ? P.real.arr[j] : null;
    const d = parseDay(P.dates[j]);
    const facts = [
      isNum(f) ? `${f >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(f))}` : null,
      isNum(r1) ? `价格 ${signPct(W, r1)}` : null,
      isNum(real) ? `${P.real.etf ? '实际申赎' : '真钱'} ${real >= 0 ? '+' : '−'}${W.money(Math.abs(real))}` : null,
    ].filter(Boolean).join(' · ');
    const slot = this.openPop({ title: `${dayLabel(P.dates[j], true)} ${WEEK[d.getDay()]} · 那天为什么？`, sub: facts || '这天没有资金数据', at: { x: ev.clientX, y: ev.clientY }, cls: 'sv-pop-day' });
    this.dayPin = j;
    this.paintDayPin();
    const q = `${P.name}（${P.t}）在${dayLabel(P.dates[j], true)}：${facts}。那天为什么？找当天和前一天的新闻、公告、评级、期权/指数调仓，带日期和出处。`;
    this.whyRun = askWhy(this.app, this.whyTarget('day', j), slot, { question: q, scoutTarget: `s:${this.T}`, onChange: () => this.placePop() });
  }
  paintDayPin() {
    const lay = this.lay;
    if (!lay || !lay.pin) return;
    const j = this.dayPin;
    if (j == null || !isNum(this.P.flow[j])) { lay.pin.style('display', 'none'); return; }
    const f = this.P.flow[j], bw = lay.bw;
    const ya = lay.yF(Math.max(0, f)), yb = lay.yF(Math.min(0, f));
    lay.pin.style('display', null).attr('x', lay.x(j) - bw / 2 - 2).attr('width', bw + 4).attr('y', ya - 2).attr('height', Math.max(0.8, yb - ya) + 4);
  }
  /** wind word that never contradicts the 5-day number next to it (phase-3 fix: DNA 钱在流进来 vs 5天净流出) */
  windLabel(w, f5, i) {
    // DESIGN §8 amendment: a crash wins over the wind word (no 风平浪静 next to 崩了 49%)
    const cr = isNum(i) ? this.crashAt(i) : null;
    if (cr) return { word: wordOf(this.W.windWord(w, f5, cr)), mixed: 0 };
    const word = wordOf(this.W.windWord(w));
    if (isNum(w) && isNum(f5) && w >= 0.5 && f5 < 0) return { word: '关注在升', mixed: 1, why: '风偏「进」，是因为它在板块里的成交占比在升（人来了）；可这 5 天按价量算其实是净流出——关注度在升，钱没真进来。' };
    if (isNum(w) && isNum(f5) && w <= -0.5 && f5 > 0) return { word: '关注在退', mixed: -1, why: '风偏「出」，是因为它在板块里的成交占比在降（人走了）；可这 5 天按价量算还是净流入——人在散，钱没真走。' };
    return { word, mixed: 0 };
  }

  // §14: is this value an estimate? → {basis, conf} | null
  estFor(field, i) {
    const P = this.P, e = P.est;
    if (e.any && e.fields.has(field) && (!e.mask || e.mask[i])) return { basis: e.basis || '数据不全，按逻辑补的', conf: e.conf };
    if (!e.declared && (field === 'wind' || field === 'temp' || field === 'pres') && i - P.first < 60) {
      return { basis: `上市才 ${i - P.first + 1} 个交易日，跟自己比的样本太少，拿同行当参照估的`, conf: 0.5 };
    }
    return null;
  }

  // value for a weather field on day i; never empty if anything reasonable exists (§14 宁可估不可空)
  metricAt(k, i) {
    const P = this.P;
    const v = P[k][i];
    if (isNum(v)) return { v, est: this.estFor(k, i) };
    for (let j = i - 1; j >= Math.max(P.first, i - 10); j--) {
      if (isNum(P[k][j])) return { v: P[k][j], est: { basis: `${dayLabel(P.dates[j])}之后没有新数，先沿用那天的`, conf: 0.6 } };
    }
    const vals = [];
    for (const pe of this.peers || []) {
      if (!pe.s) continue;
      const j = this.peerIndex(pe.s);
      if (j != null && isNum(pe.s[k][j])) vals.push(pe.s[k][j]);
    }
    if (vals.length >= 2) {
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { v: k === 'pres' ? Math.round(m) : m, est: { basis: `它自己没有这个数，按 ${vals.length} 个邻居的平均估的`, conf: 0.4 } };
    }
    return { v: null, est: null };
  }

  /** DESIGN §8 amendment: is the stock falling hard on day i? (words.crashAt on the stock file's prices) */
  crashAt(i) {
    const ext = this.opts && this.opts.words;
    try { return ext && typeof ext.crashAt === 'function' && this.P && this.P.raw ? ext.crashAt(this.P.raw, i) : null; } catch { return null; }
  }
  seasonAt(i) {
    const P = this.P;
    const w = this.metricAt('wind', i), p = this.metricAt('pres', i);
    const w5 = P.wind[Math.max(0, i - 5)];
    const dw = isNum(w.v) && isNum(w5) ? w.v - w5 : 0;
    // flow5 + temp only pick the words (words.season): the stamp can never say 钱在撤 while the 5-day
    // money is coming in, or 冷清 while the temperature cell next to it says 暖
    const t = this.metricAt('temp', i), f5 = sumFlow(P, i - 4, i), cr = this.crashAt(i);
    const r = this.W.season(w.v, dw, p.v, f5, t.v, cr) || seasonLocal(w.v, dw, p.v, f5, t.v, cr);
    const key = seasonKey(r);
    return { ...r, key, est: w.est || p.est || null, na: r.na || !isNum(w.v) || !isNum(p.v) };
  }
  // that day's season sentence from raw values, worded so it agrees with that day's 5-day money and temperature
  seasonNowAt(i) {
    const P = this.P;
    const w = P.wind[i], p = P.pres[i], w5 = P.wind[Math.max(0, i - 5)];
    if (!isNum(w) || !isNum(p)) return '';
    const dw = isNum(w5) ? w - w5 : 0, f5 = sumFlow(P, i - 4, i), t = P.temp[i], cr = this.crashAt(i);
    const r = this.W.season(w, dw, p, f5, t, cr) || seasonLocal(w, dw, p, f5, t, cr);
    return r ? plain(r.nowMild || r.now || '') : '';
  }
  // cheap season for every day (chart strip): raw values only, no estimates
  seasonKeyAt(i) {
    const P = this.P;
    const w = P.wind[i], p = P.pres[i], w5 = P.wind[Math.max(0, i - 5)];
    if (!isNum(w) || !isNum(p)) return null;
    return seasonKey(seasonLocal(w, isNum(w5) ? w - w5 : 0, p, null, null, this.crashAt(i)));
  }

  applyDate(first) {
    const P = this.P, E = this.el, W = this.W, i = this.i;
    // price
    E.px.textContent = fmtPrice(P.c[i]);
    const latest = i === P.n - 1;
    // the newest bar can still be forming (stock file `intraday` / meta.partial): never call it 收盘 then
    const live = latest ? partialOf(P, this.app) : null;
    put(E.when, latest
      ? (live ? h('span', { class: 'sv-when-live', title: '这根K线还在走：收盘后换成真数' }, `${dayLabel(P.dates[i])} 盘中${live.et ? ` · 截至 ${live.et} 美东` : ''}`)
        : h('span', { text: `${dayLabel(P.dates[i])} 收盘` }))
      : h('span', {}, icon('clock'), ` 时间机器 · ${dayLabel(P.dates[i], true)}`));
    E.when.classList.toggle('past', !latest);
    const chgEl = (label, x) => h('span', { class: 'sv-chg-i ' + (isNum(x) ? (x > 0.0005 ? 'up' : x < -0.0005 ? 'down' : '') : '') },
      h('em', { text: label }), signPct(W, x));
    put(E.chg, chgEl('1天', chg(P, i, 1)), chgEl('5天', chg(P, i, 5)), chgEl('20天', chg(P, i, 20)));

    this.renderWeather();
    this.renderCaster();

    // chart pieces that depend on the date
    const cap = divergenceCaption(P, i, W);
    E.riverCap.className = 'sv-cap sv-cap-' + cap.tone;
    E.riverCap.textContent = cap.text;
    this.updateMarker(first);
    this.drawMountainPrice();
    this.updatePeers();
  }

  renderWeather() {
    const P = this.P, E = this.el, W = this.W, i = this.i;
    const wd = this.metricAt('wind', i), tp = this.metricAt('temp', i), pr = this.metricAt('pres', i);
    const st = num(P.storm[i]), fr = num(P.front[i]);
    const f5 = sumFlow(P, i - 4, i);

    // season stamp (§8.2): a short label in the header; the full (sharp) sentence lives in the tooltip
    const se = this.seasonAt(i);
    const key = se.key || 'none';
    // short header label: the longest clause-prefix that still fits (「人气冷清，可钱在进」, not just 「人气冷清」),
    // so the money half of a mixed season never drops out of the stamp
    const shortOf = (t, max = 10) => {
      const x = plain(t);
      if (x.length <= max) return x;
      let best = '';
      const re = /[：，、；]/g;
      let m;
      while ((m = re.exec(x))) { if (m.index <= max) best = x.slice(0, m.index); else break; }
      return best.length >= 2 ? best : x.slice(0, max) + '…';
    };
    // 「历史上 5 天后 38% 入秋，41% 还是夏」 → 「5 天后 38% 入秋」 (never cut through a number)
    const nextShort = (t) => {
      const x = plain(t);
      const m = x.match(/(\d+)\s*天后\s*(?:只有\s*)?(\d+)%\s*([^，。；、\d\s]{1,4})/);
      return m ? `${m[1]} 天后 ${m[2]}% ${m[3]}` : shortOf(x);
    };
    // the season stamp, the temperature cell and the wind cell sit side by side: their words must never fight.
    // seasonAt() hands words.season() the 5-day flow and the temperature, so its now/next already agree with
    // both (MSFT: 冬 + 5 天净流入 + 暖 → 「人气冷清，可钱在进、价格也暖」) — no local override here.
    const sNow = se.key ? shortOf(se.nowMild || se.now) : '看不出季节';
    const sNext = se.key ? nextShort(se.nextMild || se.next) : '';
    E.season.className = `sv-season sv-season--${key}` + (se.est ? ' is-est' : '');
    put(E.season,
      icon(se.key || 'calm', 'sv-season-ic'),
      h('b', { text: se.key ? plain(se.name) : '平稳' }),
      h('span', { class: 'sv-season-now', text: sNow }),
      sNext ? h('span', { class: 'sv-season-next' }, h('i', { text: '→' }), sNext) : null,
      se.est ? this.estTag() : null);
    this.bindTip(E.season, () => [
      h('div', { class: 'sv-tip-main', text: se.key ? `${plain(se.name)}：${plain(se.now)}` : `平稳：${plain(se.now) || '不冷不热'}` }),
      se.next ? h('div', { class: 'sv-tip-say', text: `接下来：${plain(se.next)}` }) : null,
      h('div', { class: 'sv-tip-sub', text: '钱在四季里轮转：春 = 钱刚进来还不挤 → 夏 = 又热又挤 → 秋 = 挤着却在撤 → 冬 = 冷清没人管。' }),
      h('div', { class: 'sv-tip-sub', text: '图下方那条彩色细带 = 它这一年走过的季节。' }),
      ...this.estTipLines(se.est)]);

    // the instrument strip
    const cells = [];
    const tl = level5(tp.v, 0.5, 1.5);
    cells.push(this.cell({
      cls: `temp t${tl}`, label: '温度', icon: 'temp', value: wordOf(W.tempWord(tp.v)), est: tp.est,
      gauge: this.rampGauge(tp.v),
      tip: ['温度 = 最近涨得比它平时快不快、比邻居快不快。', '热 = 跑得快，冷 = 跑得慢（跟它自己过去一年比）。'],
    }));
    const wl = level5(wd.v, 0.5, 1.5);
    const wlab = this.windLabel(wd.v, f5, i);
    const tone = wlab.mixed ? 'mixed' : windTone(wd.v);
    cells.push(this.cell({
      cls: `wind w${wl} ${tone}`, label: '风 · 钱的流向', icon: tone === 'in' || tone === 'out' ? 'arrow' : 'calm', iconRot: tone === 'in' ? -40 : tone === 'out' ? 40 : 0,
      value: wlab.word, est: wd.est,
      sub: isNum(f5) ? `${wlab.mixed ? '但' : ''}5天${f5 >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(f5))}` : '',
      tip: ['风 = 钱在流进还是流出（跟它自己过去一年比）：一半看它在板块里的成交占比，一半看 5 天净流入。', wlab.why || '箭头朝上 = 钱进来，朝下 = 钱出去。', '点「为什么？」派 Claude 去查原因。'],
      why: { title: '为什么？', onClick: (btn) => this.openWindWhy(btn) },
    }));
    const pl = !isNum(pr.v) ? 0 : pr.v >= 85 ? 2 : pr.v >= 65 ? 1 : pr.v >= 35 ? 0 : pr.v >= 15 ? -1 : -2;
    cells.push(this.cell({
      cls: `pres p${pl}`, label: '拥挤度', icon: 'crowd', value: wordOf(W.presWord(pr.v)), num: isNum(pr.v) ? String(Math.round(pr.v)) : null, est: pr.est,
      gauge: this.barGauge(pr.v),
      tip: ['拥挤度 0–100：价格离平时多远、涨得多猛、成交有没有突然放大。', '越高越挤，挤的地方容易踩踏（跟它自己过去一年比）。'],
    }));
    const stl = st >= 1.5 ? 2 : st >= 0.8 ? 1 : 0;
    cells.push(this.cell({
      cls: `storm s${stl}`, label: '风暴', icon: stl === 2 ? 'storm' : stl === 1 ? 'rain' : 'clear',
      value: stl ? (stl === 2 ? '大风暴' : '有风暴') : '天气平稳',
      sub: stl ? `波动是平时的 ${(st + 1).toFixed(1)} 倍` : '',
      tip: ['风暴 = 最近5天的波动比平时（60天）大了多少。', stl ? '现在波动明显变大了。' : '现在波动正常。'],
    }));
    if (fr) {
      cells.push(this.cell({
        cls: `front ${fr > 0 ? 'in' : 'out'}`, label: '风向刚变', icon: 'front',
        value: fr > 0 ? '钱开始流入' : '钱开始撤离',
        tip: ['风向刚变 = 前几天钱还在往反方向走，现在掉头了。', '这种转折值得多看一眼。'],
      }));
    }
    // 真钱 (§23): disclosed creations / redemptions etc. — measured money, never an estimate
    const ra = this.realAt(i);
    if (ra) {
      const R = P.real, inn = ra.sum >= 0;
      const word = R.etf ? (inn ? '净申购' : '净赎回') : (inn ? '净流入' : '净流出');
      const rmc = this.realMoneyAt(i);
      const agree = rmc ? !this.opts.app.realMoneyClash(rmc, f5) && !rmc.blind : !isNum(f5) || Math.abs(f5) < 1e-9 || (f5 >= 0) === inn;
      cells.push(this.cell({
        cls: `real ${inn ? 'in' : 'out'}`, label: R.etf ? '真钱 · 申购赎回' : '真钱', icon: 'real', real: true,
        value: word, sub: `${ra.stale ? `截至${dayLabel(P.dates[ra.end])} ` : ''}5天 ${W.money(Math.abs(ra.sum))}`,
        tip: [`真钱 = ${REAL_KIND[R.kind] || '公开披露的资金'}，真实发生的钱，不是按价格和成交量估的。`,
          `来源：${R.src}${R.asOf ? `，截至 ${R.asOf}` : ''}。`,
          rmc && rmc.blind ? '这只按价量估看不出方向（净值天天涨，估算几乎永远说在进）——以真钱为准。'
            : agree ? '和「风」那格估的方向不打架。' : `和按价量估的方向相反（估的是${f5 >= 0 ? '净流入' : '净流出'}）——以真钱为准。`],
      }));
    }
    put(E.strip, ...cells);
    this.planetState = { temp: num(tp.v), wind: num(wd.v), storm: st, front: fr };
    if (this.reduceMotion && this.planetFrame) this.planetFrame(performance.now());
  }

  renderCaster() {
    const P = this.P, E = this.el, i = this.i;
    let lines = null;
    // sharp (default) → words.caster only if it is voice-aware; otherwise 老风's own sharp lines below.
    // mild → words.caster (its neutral voice) when available.
    const voice = (this.opts.app && this.opts.app.state && this.opts.app.state.voice) || this.W.getVoice() || this.opts.voice || 'sharp';
    if (this.W.caster && (this.W.voiceAware || voice === 'mild')) {
      try {
        const r = this.W.caster(P.raw, i);
        if (Array.isArray(r) && r.length && r.every((x) => typeof x === 'string')) lines = r.map(plain).filter(Boolean).slice(0, 3);
      } catch { /* fall back */ }
    }
    if (!lines || !lines.length) lines = localCaster(P, i, this.W, this.seasonAt(i));
    // 真钱 gets the last word when it exists: measured beats estimated (§23)
    let real = null;
    const ra = this.realAt(i);
    if (ra) {
      const f5 = sumFlow(P, i - 4, i), inn = ra.sum >= 0, R = P.real;
      const what = R.etf ? (inn ? '实际净申购' : '实际净赎回') : (inn ? '真钱净流入' : '真钱净流出');
      // 反 only when the real money and the estimate genuinely disagree (ui/realmoney.js: same ETF, same trade days,
      // both material) — else the old sign test
      const app = this.opts && this.opts.app;
      const rm = this.realMoneyAt(i);
      const clash = rm && typeof rm.clash === 'boolean' ? !!app.realMoneyClash(rm, f5) : isNum(f5) && Math.abs(f5) > 1e-9 && (f5 >= 0) !== inn;
      real = h('p', { class: 'sv-say-real' + (clash ? ' clash' : '') },
        h('i', { class: 'sv-real-tag', text: '实' }),
        `${ra.stale ? `截至${dayLabel(P.dates[ra.end])}，` : ''}5天${what} ${this.W.money(Math.abs(ra.sum))}` +
        (rm && rm.blind ? '——这只按价量估看不出方向，以真钱为准。'
          : clash ? `——和按价量估的${f5 >= 0 ? '流入' : '流出'}反着，以真钱为准。`
          : isNum(f5) && Math.abs(f5) > 1e-9 && (f5 >= 0) !== inn
            ? `——按价量估是${f5 >= 0 ? '流入' : '流出'}，可${rm && rm.realMat === false ? '真钱这点量不算大' : '同一批份额估的量不大'}，算不上唱反调。`
            : '，和估的方向一致。'));
    }
    put(E.caster,
      h('p', { class: 'sv-say-1', text: lines[0] || '' }),
      lines.length > 1 ? h('p', { class: 'sv-say-2', text: lines.slice(1).join(' ') }) : null,
      real);
  }

  // one cell of the instrument strip
  cell({ cls, label, icon: ic, iconRot = 0, value, num: n, sub, gauge, est, tip, why, real }) {
    const ico = icon(ic, 'sv-cell-ic');
    if (iconRot) ico.style.transform = `rotate(${iconRot}deg)`;
    let whyBtn = null;
    if (why) {
      whyBtn = h('button', { class: 'sv-why', type: 'button', title: '派 Claude 上网查原因（带日期和出处），答案就出现在旁边', text: why.title || '为什么？', 'data-why': '1' });
      // the shell's one consistent 为什么？ style (§21) rides along when ui/why.js is there
      if (hasAppWhy(this.app) && typeof this.app.whyButton === 'function') whyBtn.classList.add('why-link');
      whyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.hideTip(); why.onClick(whyBtn); });
      whyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      whyBtn.addEventListener('pointerenter', (e) => { e.stopPropagation(); this.hideTip(); });
      whyBtn.addEventListener('focus', (e) => e.stopPropagation());
    }
    const el = h('div', { class: `sv-cell sv-cell-${cls}` + (est ? ' is-est' : '') + (why ? ' has-why' : ''), role: 'listitem', tabindex: 0 },
      h('div', { class: 'sv-cell-k' }, h('span', { text: label }), est ? this.estTag() : null,
        real ? h('i', { class: 'sv-real-tag', 'aria-label': '实测值', title: '实测：真实发生的钱，不是估的', text: '实' }) : null, whyBtn),
      h('div', { class: 'sv-cell-v' }, ico, h('span', { class: 'sv-cell-word', text: value || '暂无' }), n != null ? h('span', { class: 'sv-cell-num', text: n }) : null),
      gauge || (sub ? h('div', { class: 'sv-cell-sub', text: sub }) : h('div', { class: 'sv-cell-sub' })));
    if (gauge && sub) el.append(h('div', { class: 'sv-cell-sub', text: sub }));
    this.bindTip(el, () => [
      ...tip.filter(Boolean).map((t, j) => h('div', { class: j ? 'sv-tip-sub' : 'sv-tip-main', text: t })),
      sub && gauge ? h('div', { class: 'sv-tip-say', text: sub }) : null,
      ...this.estTipLines(est)]);
    return el;
  }
  rampGauge(t) {
    // the planet's nine isotherm bands, each as wide as its temperature span on −3…3
    const g = h('div', { class: 'sv-gauge sv-gauge-ramp', 'aria-hidden': 'true' });
    const ed = [-3, ...BAND_EDGES, 3];
    this.colors.bands.forEach((c, k) => g.append(h('i', { style: { background: c, flexGrow: (ed[k + 1] - ed[k]).toFixed(2) } })));
    if (isNum(t)) g.append(h('b', { style: { left: `${((clamp(t, -3, 3) + 3) / 6) * 100}%` } }));
    return g;
  }
  barGauge(p) {
    // five zones in the §5 bands: 冷清 <15 · 人少 <35 · 正常 <65 · 人多 <85 · 人挤人
    const g = h('div', { class: 'sv-gauge sv-gauge-bar', 'aria-hidden': 'true' },
      ...[15, 20, 30, 20, 15].map((w) => h('i', { style: { flexGrow: w } })));
    if (isNum(p)) g.append(h('b', { style: { left: `${clamp(p, 0, 100)}%` } }));
    return g;
  }
  estTag() { return h('i', { class: 'sv-est-tag', 'aria-label': '估算值', text: '估' }); }
  estTipLines(est) {
    if (!est) return [];
    return [h('div', { class: 'sv-tip-est' },
      h('i', { class: 'sv-est-tag', text: '估' }),
      h('span', { text: `估算：${est.basis}${isNum(est.conf) ? `，${this.W.confWord(est.conf)}` : ''}。等你补数据，或让 Claude 去查。` }))];
  }
  bindTip(el, make) {
    el._tipMake = make;
    if (el._tipBound) return;
    el._tipBound = true;
    const show = () => {
      const r = el.getBoundingClientRect();
      this.showTip(el._tipMake().filter(Boolean), r.left + r.width / 2, r.bottom + 8, 'below');
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerleave', () => this.hideTip());
    el.addEventListener('blur', () => this.hideTip());
  }

  // ---------------------------------------------------------------- 关系网 / 让 Claude 去查
  openWeb() {
    const app = this.opts.app || globalThis.app;
    const fn = typeof this.opts.onWeb === 'function' ? this.opts.onWeb : app && typeof app.openWeb === 'function' ? app.openWeb.bind(app) : null;
    if (!fn) { this.note('关系网还没接上，过一阵再来。'); return; }
    try { fn(this.T); } catch (e) { console.error('[stock] openWeb', e); this.note('关系网打不开。'); }
  }

  askQuestion() {
    const P = this.P, i = this.i, W = this.W;
    if (!P) return '';
    const w = wordOf(W.windWord(this.metricAt('wind', i).v));
    const pr = this.metricAt('pres', i).v;
    const day = dayLabel(P.dates[i], true);
    return `${P.name}（${P.t}）截至${day}：${w}，价格5天 ${signPct(W, chg(P, i, 5))}、20天 ${signPct(W, chg(P, i, 20))}${isNum(pr) ? `，拥挤度 ${Math.round(pr)}` : ''}。为什么？最近有什么新闻、财报、评级或资金动向？`;
  }

  toggleAsk() { if (this.askEl) this.closeAsk(true); else this.openAsk(); }

  openAsk() {
    if (!this.P) return;
    const E = this.el;
    const ta = h('textarea', { class: 'sv-ask-q', rows: 4, maxlength: 400, 'aria-label': '要查的问题' });
    ta.value = this.askQuestion();
    const status = h('div', { class: 'sv-ask-status' });
    const send = h('button', { class: 'sv-btn sv-btn-primary', type: 'button', text: '派出去查' });
    const cancel = h('button', { class: 'sv-btn', type: 'button', text: '算了', onclick: () => this.closeAsk(true) });
    const box = h('div', { class: 'sv-ask', role: 'dialog', 'aria-label': '让 Claude 去查' },
      h('div', { class: 'sv-ask-title' }, icon('ask'), h('b', { text: '派侦察兵去查' })),
      h('p', { class: 'sv-ask-hint', text: 'Claude 会上网找原因，带出处回来，答案就出现在这里。问题可以改：' }),
      ta,
      h('div', { class: 'sv-ask-foot' }, h('span', { class: 'sv-ask-cost', text: '会用掉一次 Claude 额度' }), cancel, send),
      status);
    send.addEventListener('click', async () => {
      if (box.classList.contains('sv-ask-sent')) {          // 「再问一个」: back to an editable question
        this.askRun?.stop?.();
        ta.readOnly = false;
        box.classList.remove('sv-ask-sent');
        send.textContent = '派出去查';
        put(status);
        ta.focus();
        return;
      }
      const q = ta.value.trim();
      if (!q) { ta.focus(); return; }
      const app = this.opts.app || globalThis.app;
      const fn = typeof this.opts.onAsk === 'function' ? this.opts.onAsk : app && typeof app.ask === 'function' ? app.ask.bind(app) : null;
      if (!fn) { status.className = 'sv-ask-status err'; status.textContent = '侦察兵还没接上，这个按钮暂时用不了。'; return; }
      send.disabled = true;
      status.className = 'sv-ask-status';
      status.textContent = '正在派出…';
      try {
        const before = scoutCards();
        const r = await fn('ask', `s:${this.T}`, q);
        if (this.askEl !== box) return;
        const ext = r && !r.error ? newScoutCard(before) : null;
        // the answer lands right here (phase-3 fix: no more "go look in the scout panel")
        status.className = 'sv-ask-status live';
        box.classList.add('sv-ask-sent');
        ta.readOnly = true;
        send.textContent = '再问一个';
        send.disabled = false;
        this.askRun?.stop?.();
        // ui/scout.js shows its own live card where the button was: then this box just steps aside
        if (ext) { put(status); status.className = 'sv-ask-status'; this.askRun = null; return; }
        this.askRun = followScout(this.app, r && typeof r === 'object' ? r : { error: '没有回执' }, status, {});
      } catch (e) {
        send.disabled = false;
        status.className = 'sv-ask-status err';
        status.textContent = `没派出去：${e && e.message ? e.message : e}`;
      }
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send.click(); });
    E.overlay.append(box);
    this.askEl = box;
    E.askBtn.classList.add('on');
    E.askBtn.setAttribute('aria-expanded', 'true');
    // anchor under the button, right-aligned to it
    const R = E.overlay.getBoundingClientRect(), b = E.askBtn.getBoundingClientRect();
    const bw = box.offsetWidth;
    const left = clamp(b.right - R.left - bw, 8, R.width - bw - 8);
    box.style.left = `${left}px`;
    box.style.top = `${b.bottom - R.top + E.overlay.scrollTop + 8}px`;
    requestAnimationFrame(() => box.classList.add('on'));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  closeAsk(refocus = false) {
    if (!this.askEl) return;
    const box = this.askEl;
    this.askEl = null;
    this.askRun?.stop?.();
    this.askRun = null;
    this.el.askBtn.classList.remove('on');
    this.el.askBtn.setAttribute('aria-expanded', 'false');
    box.classList.remove('on');
    setTimeout(() => box.remove(), this.reduceMotion ? 0 : 180);
    if (refocus) this.el.askBtn.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- tooltip
  showTip(nodes, x, y, mode = 'auto') {
    const tip = this.el.tip;
    put(tip, ...nodes);
    tip.classList.add('on');
    const R = this.el.overlay.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let lx, ly;
    if (mode === 'below') { lx = x - tw / 2; ly = y; }
    else {
      lx = x + 16; ly = y - th - 12;
      if (lx + tw > R.right - 8) lx = x - tw - 16;
      if (ly < R.top + 8) ly = y + 18;
    }
    lx = clamp(lx, R.left + 8, R.right - tw - 8);
    ly = clamp(ly, R.top + 8, R.bottom - th - 8);
    const st = this.el.overlay.scrollTop;
    tip.style.transform = `translate(${Math.round(lx - R.left)}px, ${Math.round(ly - R.top + st)}px)`;
  }
  hideTip() { this.el.tip.classList.remove('on'); }

  // ---------------------------------------------------------------- charts
  scheduleDraw() {
    if (!this.P || this.closed) return;
    cancelAnimationFrame(this.drawRaf);
    this.drawRaf = requestAnimationFrame(() => {
      this.drawCharts();
      this.updateMarker(true);
      this.drawMountainPrice();
      this.drawIntraday();
      this.placePop();
      if (this.el.planet.clientWidth !== this.planetSize) this.startPlanet();
    });
  }

  drawCharts() {
    this.drawRiver();
    this.drawMountain();
  }

  drawRiver() {
    const d3 = d3g(), P = this.P, E = this.el;
    const svg = d3.select(E.riverSvg);
    const W = E.riverSvg.clientWidth, H = E.riverSvg.clientHeight;
    svg.selectAll('*').remove();
    if (W < 80 || H < 120) { this.lay = null; return; }
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const m = { l: 6, r: 60, t: 24, b: 34 };
    const gap = 16;
    const plotH = H - m.t - m.b - gap * 2;
    const ph = Math.round(plotH * 0.5), ch = Math.round(plotH * 0.26), bh = plotH - ph - ch;
    const y0 = m.t, y1 = y0 + ph + gap, y2 = y1 + ch + gap, yB = y2 + bh;
    const x = d3.scaleLinear().domain([-0.5, P.n - 0.5]).range([m.l, W - m.r]);
    const step = x(1) - x(0);
    const lay = this.lay = { W, H, m, ph, ch, bh, y0, y1, y2, yB, x, step };

    // price scale (shared with 筹码山)
    let lo = Infinity, hi = -Infinity;
    for (let j = P.first; j < P.n; j++) {
      const a = isNum(P.l[j]) ? P.l[j] : P.c[j], b = isNum(P.h[j]) ? P.h[j] : P.c[j];
      if (isNum(a)) lo = Math.min(lo, a);
      if (isNum(b)) hi = Math.max(hi, b);
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const prof = P.raw.profile;
    if (prof && isNum(prof.lo) && isNum(prof.hi)) { lo = Math.min(lo, prof.lo); hi = Math.max(hi, prof.hi); }
    const pad = (hi - lo) * 0.09 || hi * 0.05 || 1;
    const yP = d3.scaleLinear().domain([lo - pad, hi + pad]).range([y0 + ph, y0]);
    lay.yP = yP;

    const cumVals = P.cum.filter(isNum);
    const cLo = Math.min(0, d3.min(cumVals) ?? 0), cHi = Math.max(0, d3.max(cumVals) ?? 1);
    const cpad = (cHi - cLo) * 0.08 || 1;
    const yC = d3.scaleLinear().domain([cLo - (cLo < 0 ? cpad : 0), cHi + cpad]).range([y1 + ch, y1]);
    const realArr = P.real ? P.real.arr : null;
    const fMax = Math.max(d3.max(P.flow, (f) => (isNum(f) ? Math.abs(f) : 0)) || 0,
      realArr ? d3.max(realArr, (f) => (isNum(f) ? Math.abs(f) : 0)) || 0 : 0) || 1;
    const yF = d3.scaleLinear().domain([-fMax, fMax]).range([yB, y2]);
    lay.yC = yC; lay.yF = yF;

    const uid = 'sv' + Math.random().toString(36).slice(2, 8);
    lay.uid = uid;
    const defs = svg.append('defs');
    // screen-tone hatching for divergence bands (manga 網点 feel instead of a glow)
    for (const dir of ['in', 'out']) {
      const pat = defs.append('pattern').attr('id', `${uid}h${dir}`).attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
      pat.append('line').attr('class', `sv-hatch ${dir}`).attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6);
    }

    const panels = svg.append('g').attr('class', 'sv-panels');
    const panelTitle = (y, text, sub) => {
      const t = panels.append('text').attr('class', 'sv-ptitle sv-ptitle-halo').attr('x', m.l + 4).attr('y', y + 11).text(text);
      if (sub) t.append('tspan').attr('class', 'sv-ptitle-sub').attr('dx', 6).text(sub);
    };

    // divergence bands (price + cum panels)
    const gBands = svg.append('g').attr('class', 'sv-bands');
    for (const s of P.div) {
      const xa = x(s.start) - step / 2, xb = x(s.end) + step / 2;
      const dir = s.dir > 0 ? 'in' : 'out';
      gBands.append('rect').attr('class', 'sv-band ' + dir).attr('fill', `url(#${uid}h${dir})`)
        .attr('x', xa).attr('width', Math.max(2, xb - xa)).attr('y', y0).attr('height', y1 + ch - y0);
      gBands.append('line').attr('class', 'sv-band-edge ' + dir).attr('x1', xa).attr('x2', xa + Math.max(2, xb - xa)).attr('y1', y0).attr('y2', y0);
    }

    // grid + axes (hairlines)
    const grid = svg.append('g').attr('class', 'sv-grid');
    const pTicks = lay.pTicks = yP.ticks(ph > 200 ? 5 : 4);
    const pstep = pTicks.length > 1 ? Math.abs(pTicks[1] - pTicks[0]) : 1;
    for (const t of pTicks) {
      grid.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yP(t)).attr('y2', yP(t));
      grid.append('text').attr('class', 'sv-axis').attr('x', W - m.r + 8).attr('y', yP(t) + 4).text(fmtPriceAxis(t, pstep));
    }
    grid.append('line').attr('class', 'sv-zero').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yC(0)).attr('y2', yC(0));
    const cTicks = yC.ticks(ch < 90 ? 2 : 3).filter((t) => t !== 0 && Math.abs(yC(t) - yC(0)) >= 13);
    for (const t of cTicks) {
      grid.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yC(t)).attr('y2', yC(t));
      grid.append('text').attr('class', 'sv-axis').attr('x', W - m.r + 8).attr('y', yC(t) + 4).text(moneyShort(t));
    }
    grid.append('text').attr('class', 'sv-axis').attr('x', W - m.r + 8).attr('y', yC(0) + 4).text('0');
    grid.append('line').attr('class', 'sv-zero').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yF(0)).attr('y2', yF(0));
    grid.append('text').attr('class', 'sv-axis').attr('x', W - m.r + 8).attr('y', y2 + 9).text(moneyShort(fMax));
    grid.append('text').attr('class', 'sv-axis').attr('x', W - m.r + 8).attr('y', yB).text(moneyShort(-fMax));

    // season strip (§8.2) — the rotation cycle of this stock over the year
    const yS = yB + 8, hS = 5;
    lay.yS = yS;
    const gS = svg.append('g').attr('class', 'sv-season-strip');
    gS.append('rect').attr('class', 'sv-ss-track').attr('x', m.l).attr('y', yS).attr('width', W - m.r - m.l).attr('height', hS);
    // runs of the same season; runs shorter than 3 days fold into the run before (no flicker)
    const runs = [];
    for (let j = P.first; j < P.n; j++) {
      const k = this.seasonKeyAt(j), est = !!this.estFor('wind', j);
      const last = runs[runs.length - 1];
      if (last && last.k === k && last.est === est) last.b = j;
      else runs.push({ k, est, a: j, b: j });
    }
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && (r.b - r.a < 2 || last.k === r.k) && last.est === r.est) last.b = r.b;
      else merged.push({ ...r });
    }
    let anyEstS = false;
    for (const r of merged) {
      if (r.est) anyEstS = true;
      if (!r.k) continue;
      gS.append('rect').attr('class', `sv-ss ${r.k}${r.est ? ' is-est' : ''}`).attr('x', x(r.a) - step / 2).attr('y', yS)
        .attr('width', Math.max(1, x(r.b) - x(r.a) + step)).attr('height', hS);
    }
    gS.append('text').attr('class', 'sv-axis').attr('x', W - m.r + 8).attr('y', yS + hS + 1).text(anyEstS ? '季节 · 估' : '季节');

    // months along the bottom
    const xa = svg.append('g').attr('class', 'sv-xaxis');
    // labels never overlap: each one needs its own text width (CJK ≈ 10.5px, digits ≈ 6px) plus a gap
    const textW = (t) => [...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 10.5 : 6), 0);
    let lastM = -1, lastEnd = -999;
    for (let j = 0; j < P.n; j++) {
      const d = parseDay(P.dates[j]);
      const mo = d.getMonth();
      if (mo !== lastM) {
        lastM = mo;
        const xx = x(j);
        const label = mo === 0 ? `${d.getFullYear()}年1月` : `${mo + 1}月`;
        if (j > 0 && xx + 3 > lastEnd + 8 && xx + 3 + textW(label) < W - m.r + 4) {
          xa.append('line').attr('x1', xx).attr('x2', xx).attr('y1', yS + hS + 2).attr('y2', yS + hS + 6);
          xa.append('text').attr('class', 'sv-axis').attr('x', xx + 3).attr('y', H - 3).text(label);
          lastEnd = xx + 3 + textW(label);
        }
      }
    }

    // estimated stretches (§14): drawn dashed + a small 估 seal
    const estP = (j) => !!(P.est.any && P.est.fields.has('price') && (!P.est.mask || P.est.mask[j]));
    const estF = (j) => !!(P.est.any && P.est.fields.has('flow') && (!P.est.mask || P.est.mask[j]));
    const idx = d3.range(P.n);
    // solid where measured; dashed where estimated (plus one neighbour each side so the two join up)
    const solidOrDash = (defd, isEst) => [
      (j) => defd(j) && !isEst(j),
      (j) => defd(j) && (isEst(j) || isEst(j - 1) || isEst(j + 1)),
    ];

    // price
    const defP = (j) => isNum(P.c[j]);
    const [pSolid, pDash] = solidOrDash(defP, estP);
    const area = d3.area().defined(defP).x((j) => x(j)).y0(y0 + ph).y1((j) => yP(P.c[j])).curve(d3.curveMonotoneX);
    const line = (def) => d3.line().defined(def).x((j) => x(j)).y((j) => yP(P.c[j])).curve(d3.curveMonotoneX);
    svg.append('path').attr('class', 'sv-price-area').attr('d', area(idx));
    svg.append('path').attr('class', 'sv-price-line').attr('d', line(pSolid)(idx));
    if (idx.some(estP)) svg.append('path').attr('class', 'sv-price-line is-est').attr('d', line(pDash)(idx));

    // 52w high / low (selective direct labels)
    let jh = -1, jl = -1;
    for (let j = P.first; j < P.n; j++) {
      if (!isNum(P.c[j])) continue;
      if (jh < 0 || P.c[j] > P.c[jh]) jh = j;
      if (jl < 0 || P.c[j] < P.c[jl]) jl = j;
    }
    const ext = svg.append('g').attr('class', 'sv-ext');
    const extLabel = (j, above, txt) => {
      if (j < 0) return;
      const xx = x(j), yy = yP(P.c[j]);
      ext.append('circle').attr('cx', xx).attr('cy', yy).attr('r', 2.6);
      // a max has only lower prices around it → label above; a min → label below (the line never goes there)
      const anchor = xx < m.l + 60 ? 'start' : xx > W - m.r - 60 ? 'end' : 'middle';
      let lx = anchor === 'start' ? Math.max(xx - 4, m.l + 2) : anchor === 'end' ? Math.min(xx + 4, W - m.r - 2) : xx;
      const ty = above ? yy - 9 : yy + 16;
      if (above && ty < y0 + 12 && lx < m.l + 44) lx = m.l + 44;
      if (!above && ty > y0 + ph + 2 && lx < m.l + 290) return;
      ext.append('text').attr('x', lx).attr('y', ty).attr('text-anchor', anchor).text(`${txt} ${fmtPrice(P.c[j])}`);
    };
    const young = P.first > 20;
    if (jh !== P.n - 1) extLabel(jh, true, young ? '最高' : '一年最高');
    if (young) {
      const xf = x(P.first);
      ext.append('line').attr('class', 'sv-listed').attr('x1', xf).attr('x2', xf).attr('y1', y0 + 4).attr('y2', yB);
      ext.append('text').attr('class', 'sv-listed-t').attr('x', xf - 6).attr('y', y0 + ph - 6).attr('text-anchor', 'end')
        .text(`${dayLabel(P.dates[P.first])} 才开始交易 →`);
    }
    if (jl !== P.n - 1 && jl !== P.first) extLabel(jl, false, '最低');

    // cumulative flow (the river level)
    const defC = (j) => isNum(P.cum[j]);
    const [cSolid, cDash] = solidOrDash(defC, estF);
    const base0 = yC(Math.max(cLo, Math.min(0, cHi)));
    const cArea = d3.area().defined(defC).x((j) => x(j)).y0(base0).y1((j) => yC(P.cum[j])).curve(d3.curveMonotoneX);
    const cLine = (def) => d3.line().defined(def).x((j) => x(j)).y((j) => yC(P.cum[j])).curve(d3.curveMonotoneX);
    svg.append('path').attr('class', 'sv-cum-area').attr('d', cArea(idx));
    svg.append('path').attr('class', 'sv-cum-line').attr('d', cLine(cSolid)(idx));
    if (idx.some(estF)) svg.append('path').attr('class', 'sv-cum-line is-est').attr('d', cLine(cDash)(idx));

    // daily flow bars
    const bw = Math.max(1, Math.min(6, step * 0.66));
    lay.bw = bw;
    const gb = svg.append('g').attr('class', 'sv-bars');
    for (let j = 0; j < P.n; j++) {
      const f = P.flow[j];
      if (!isNum(f) || f === 0) continue;
      const ya = yF(Math.max(0, f)), yb = yF(Math.min(0, f));
      gb.append('rect').attr('class', (f > 0 ? 'in' : 'out') + (estF(j) ? ' is-est' : ''))
        .attr('x', x(j) - bw / 2).attr('width', bw).attr('y', ya).attr('height', Math.max(0.8, yb - ya))
        .attr('fill-opacity', (0.38 + 0.6 * Math.sqrt(Math.abs(f) / fMax)).toFixed(2));
    }
    // 真钱 (measured creations / redemptions): one ink dot per day on the same scale as the bars
    if (realArr) {
      const gr = svg.append('g').attr('class', 'sv-real-ticks');
      const tw = Math.max(3, Math.min(9, step * 0.9));
      for (let j = 0; j < P.n; j++) {
        const v = realArr[j];
        if (!isNum(v)) continue;
        gr.append('circle').attr('class', v >= 0 ? 'in' : 'out').attr('cx', x(j)).attr('cy', yF(v)).attr('r', Math.max(1.1, Math.min(1.8, tw / 4)));
      }
    }
    E.realLegend.style.display = realArr ? '' : 'none';
    // the day the owner clicked (its 那天为什么？ card is open)
    lay.pin = svg.append('rect').attr('class', 'sv-daypin').style('display', 'none');
    this.paintDayPin();

    // 估 seal on the first estimated stretch
    const firstEst = idx.find((j) => estP(j) || estF(j));
    if (firstEst != null) {
      const gx = clamp(x(firstEst) + 6, m.l + 50, W - m.r - 30);
      const ge = svg.append('g').attr('class', 'sv-est-seal').attr('transform', `translate(${gx},${y0 + 4})`);
      ge.append('rect').attr('width', 15).attr('height', 15).attr('rx', 2);
      ge.append('text').attr('x', 7.5).attr('y', 11.5).attr('text-anchor', 'middle').text('估');
      ge.append('title').text(`估算：${P.est.basis || '数据不全，按逻辑补的'}`);
    }

    panelTitle(y0 - 18, '价格');
    panelTitle(y1 - 2, '钱的水位', `${young ? '上市以来' : '一年来'}累计净流入，往上 = 钱在进来`);
    panelTitle(y2 - 2, '每天进出', '绿 = 流入，红 = 流出');
    svg.select('.sv-panels').raise();

    // future veil + date marker (updated by setDate)
    lay.veil = svg.append('rect').attr('class', 'sv-veil').attr('y', y0 - 4).attr('height', yS + hS - y0 + 6);
    const mk = lay.marker = svg.append('g').attr('class', 'sv-marker');
    mk.append('line').attr('class', 'sv-marker-line').attr('y1', y0 - 6).attr('y2', yS + hS + 2);
    mk.append('circle').attr('class', 'sv-marker-dot sv-marker-p').attr('r', 3.8);
    mk.append('circle').attr('class', 'sv-marker-dot sv-marker-c').attr('r', 3.2);
    const pill = mk.append('g').attr('class', 'sv-marker-pill');
    pill.append('rect').attr('rx', 3).attr('height', 18).attr('y', y0 - 24);
    pill.append('text').attr('y', y0 - 11);

    // hover layer
    const cross = svg.append('g').attr('class', 'sv-cross').style('display', 'none');
    cross.append('line').attr('y1', y0 - 4).attr('y2', yS + hS + 2);
    cross.append('circle').attr('class', 'p').attr('r', 3.5);
    cross.append('circle').attr('class', 'c').attr('r', 3);
    cross.append('rect').attr('class', 'b');
    const hit = svg.append('rect').attr('class', 'sv-hit').attr('data-why', '1').attr('x', m.l).attr('y', y0 - 6).attr('width', W - m.l - m.r).attr('height', yS + hS - y0 + 10);
    hit.on('pointermove', (ev) => {
      const [px] = d3.pointer(ev);
      const j = clamp(Math.round(x.invert(px)), P.first, P.n - 1);
      cross.style('display', null);
      cross.select('line').attr('x1', x(j)).attr('x2', x(j));
      cross.select('circle.p').attr('cx', x(j)).attr('cy', isNum(P.c[j]) ? yP(P.c[j]) : -99);
      cross.select('circle.c').attr('cx', x(j)).attr('cy', isNum(P.cum[j]) ? yC(P.cum[j]) : -99);
      const f = P.flow[j];
      if (isNum(f)) {
        const ya = yF(Math.max(0, f)), yb = yF(Math.min(0, f));
        cross.select('rect.b').attr('x', x(j) - bw / 2 - 1.5).attr('width', bw + 3).attr('y', ya - 1.5).attr('height', Math.max(0.8, yb - ya) + 3);
      }
      this.showTip(this.riverTip(j), ev.clientX, ev.clientY);
    });
    hit.on('pointerleave', () => { cross.style('display', 'none'); this.hideTip(); });
    // click a day (any bar) → that day's card with 那天为什么？ (§21)
    hit.style('cursor', 'pointer').on('click', (ev) => {
      const [px] = d3.pointer(ev);
      const j = clamp(Math.round(x.invert(px)), P.first, P.n - 1);
      this.hideTip();
      this.openDay(j, ev);
    });
    E.riverSvg.setAttribute('aria-label', `${P.name} 一年的价格和资金流向图`);
    E.bandLegend.style.display = P.div.length ? '' : 'none';
  }

  riverTip(j) {
    const P = this.P, W = this.W;
    const d = parseDay(P.dates[j]);
    const r1 = chg(P, j, 1), f = P.flow[j];
    const nodes = [h('div', { class: 'sv-tip-date', text: `${dayLabel(P.dates[j], true)} ${WEEK[d.getDay()]}` })];
    nodes.push(h('div', { class: 'sv-tip-row' },
      h('i', { class: 'k k-price' }),
      h('b', { text: fmtPrice(P.c[j]) }),
      h('span', { class: 'sv-tip-dim', text: isNum(r1) ? `当天 ${signPct(W, r1)}` : '' })));
    if (isNum(f)) {
      // vs a usual day: median |net flow| over the 60 days before
      const past = [];
      for (let k = Math.max(P.first, j - 60); k < j; k++) if (isNum(P.flow[k])) past.push(Math.abs(P.flow[k]));
      past.sort((a, b) => a - b);
      const typ = past.length >= 15 ? past[Math.floor(past.length / 2)] : null;
      const ratio = typ ? Math.abs(f) / typ : null;
      nodes.push(h('div', { class: 'sv-tip-row' },
        h('i', { class: 'k ' + (f >= 0 ? 'k-in' : 'k-out') }),
        h('b', { text: `${f >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(f))}` }),
        h('span', { class: 'sv-tip-dim', text: ratio == null ? '当天' : ratio >= 1.8 ? `当天 · 约平常的 ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} 倍` : ratio <= 0.4 ? '当天 · 比平常小' : '当天' })));
    }
    const rv = P.real && P.real.arr[j];
    if (isNum(rv)) {
      nodes.push(h('div', { class: 'sv-tip-row' }, h('i', { class: 'k k-real' }),
        h('b', { text: `${P.real.etf ? (rv >= 0 ? '实际申购' : '实际赎回') : (rv >= 0 ? '真钱流入' : '真钱流出')} ${W.money(Math.abs(rv))}` }),
        h('span', { class: 'sv-tip-dim', text: '真钱 · 实测' })));
    }
    if (isNum(P.cum[j])) {
      nodes.push(h('div', { class: 'sv-tip-row' }, h('i', { class: 'k k-cum' }),
        h('b', { text: moneyShort(P.cum[j]) + '美元' }), h('span', { class: 'sv-tip-dim', text: `从${dayLabel(P.dates[P.first], true)}累计到这天` })));
    }
    // a plain sentence about the day
    let say = '';
    if (isNum(f) && isNum(r1)) {
      if (f >= 0 && r1 >= 0) say = '钱进来，价格也涨。';
      else if (f >= 0 && r1 < 0) say = '价格跌了，但钱是净流入的。';
      else if (f < 0 && r1 >= 0) say = '价格涨了，但钱在往外走。';
      else say = '钱出去，价格也跌。';
    }
    const sk = this.seasonKeyAt(j);
    const sn = sk ? `${SEASONS[sk].name}（${this.seasonNowAt(j) || SEASONS[sk].now}）` : '平稳';
    nodes.push(h('div', { class: 'sv-tip-say', text: `${say} 那时的风：${wordOf(this.W.windWord(P.wind[j]))}；季节：${sn}。` }));
    const span = P.div.find((s) => s.start <= j && s.end >= j);
    if (span) nodes.push(h('div', { class: 'sv-tip-sub ' + (span.dir > 0 ? 'in' : 'out'), text: span.dir > 0 ? '斜线区：价格在跌，钱却在进来' : '斜线区：价格在涨，钱却在出去' }));
    nodes.push(h('div', { class: 'sv-tip-hint', text: '点一下：问老风「那天为什么？」' }));
    return nodes;
  }

  updateMarker(instant) {
    const lay = this.lay, P = this.P;
    if (!lay || !lay.marker) return;
    const i = this.i, x = lay.x;
    const xx = x(i);
    const latest = i === P.n - 1;
    const dur = instant || this.reduceMotion ? 0 : 180;
    const veilX = xx + lay.step / 2;
    lay.veil.transition().duration(dur).ease(d3g().easeCubicInOut).attr('x', veilX).attr('width', Math.max(0, lay.W - lay.m.r - veilX + 2));
    const mk = lay.marker;
    mk.classed('latest', latest);
    mk.select('.sv-marker-line').transition().duration(dur).attr('x1', xx).attr('x2', xx);
    mk.select('.sv-marker-p').transition().duration(dur).attr('cx', xx).attr('cy', isNum(P.c[i]) ? lay.yP(P.c[i]) : -99);
    mk.select('.sv-marker-c').transition().duration(dur).attr('cx', xx).attr('cy', isNum(P.cum[i]) ? lay.yC(P.cum[i]) : -99);
    const label = latest ? `最新 ${dayLabel(P.dates[i])} · ${fmtPrice(P.c[i])}` : `${dayLabel(P.dates[i])} · ${fmtPrice(P.c[i])}`;
    const t = mk.select('.sv-marker-pill text').text(label);
    const tw = (t.node().getComputedTextLength?.() || label.length * 7) + 16;
    let px = xx - tw / 2;
    px = clamp(px, lay.m.l, lay.W - tw - 2);
    mk.select('.sv-marker-pill rect').transition().duration(dur).attr('x', px).attr('width', tw);
    t.transition().duration(dur).attr('x', px + 8);
  }

  drawMountain() {
    const d3 = d3g(), P = this.P, E = this.el, lay = this.lay;
    const svg = d3.select(E.mtnSvg);
    svg.selectAll('*').remove();
    let prof = P.raw.profile;
    let est = prof && prof.est ? { basis: prof.basis || '数据不全，按逻辑补的', conf: isNum(prof.conf) ? prof.conf : null } : null;
    if (!prof || !Array.isArray(prof.bins) || !prof.bins.length) {
      prof = estimateProfile(P);
      est = prof ? { basis: '没有现成的筹码数据，按每天的最高价、最低价和成交额粗算', conf: 0.5 } : null;
    }
    if (P.est.any && P.est.fields.has('profile') && !est) est = { basis: P.est.basis || '数据不全，按逻辑补的', conf: P.est.conf };
    E.mtn.classList.toggle('is-est', !!est);
    put(E.mtnEst, est ? this.estTag() : '');
    if (est) this.bindTip(E.mtnEst, () => this.estTipLines(est));
    const box = E.mtnSvg.parentNode;
    if (!lay) return;
    const Hm = lay.y0 + lay.ph + 10;
    box.style.height = `${Hm}px`;
    const W = E.mtnSvg.clientWidth || box.clientWidth;
    svg.attr('viewBox', `0 0 ${W} ${Hm}`).attr('height', Hm);
    this.mlay = null;
    if (!prof) {
      svg.append('text').attr('class', 'sv-empty').attr('x', W / 2).attr('y', Hm / 2).attr('text-anchor', 'middle').text('暂时没有筹码数据');
      E.mtnCap.textContent = '';
      return;
    }
    const bins = prof.bins.map(Number), buy = prof.buy.map((v) => num(v)), sell = prof.sell.map((v) => num(v));
    const tot = bins.map((_, k) => buy[k] + sell[k]);
    const maxT = d3.max(tot) || 1;
    const yP = lay.yP;
    const stepP = bins.length > 1 ? Math.abs(bins[1] - bins[0]) : (prof.hi - prof.lo) || 1;
    const thick = Math.max(1.2, Math.abs(yP(0) - yP(stepP)) - 1);
    const xl = 6, xr = W - 8;
    const xm = d3.scaleLinear().domain([0, maxT]).range([0, xr - xl]);
    // the river's price gridlines, so the eye sees both charts share one price axis
    const mg = svg.append('g').attr('class', 'sv-grid');
    for (const t of lay.pTicks || []) mg.append('line').attr('x1', 0).attr('x2', W).attr('y1', yP(t)).attr('y2', yP(t));
    const g = svg.append('g').attr('class', 'sv-mtn');
    // paper-cut ridge silhouette behind the bars
    const ridge = d3.area().x0(xl).x1((k) => xl + xm(tot[k]) + 3).y((k) => yP(bins[k])).curve(d3.curveBasis);
    g.append('path').attr('class', 'sv-mtn-ridge').attr('d', ridge(d3.range(bins.length)));
    const peak = tot.indexOf(maxT);
    bins.forEach((b, k) => {
      const yy = yP(b) - thick / 2;
      const wb = xm(buy[k]), ws = xm(sell[k]);
      const row = g.append('g').attr('class', 'sv-mtn-row' + (k === peak ? ' peak' : ''));
      if (wb > 0.3) row.append('rect').attr('class', 'buy').attr('x', xl).attr('y', yy).attr('width', Math.max(0.5, wb - (ws > 0.3 ? 1 : 0))).attr('height', thick);
      if (ws > 0.3) row.append('rect').attr('class', 'sell').attr('x', xl + wb + (wb > 0.3 ? 1 : 0)).attr('y', yy).attr('width', Math.max(0.5, ws - 1)).attr('height', thick);
      row.append('rect').attr('class', 'hit').attr('x', 0).attr('y', yP(b) - Math.max(thick, 8) / 2).attr('width', W).attr('height', Math.max(thick + 1.5, 8))
        .on('pointerenter pointermove', (ev) => {
          row.classed('hover', true);
          const lo = b - stepP / 2, hi = b + stepP / 2;
          const share = tot[k] / (d3.sum(tot) || 1);
          this.showTip([
            h('div', { class: 'sv-tip-date', text: `${fmtPrice(lo)} – ${fmtPrice(hi)}` }),
            h('div', { class: 'sv-tip-row' }, h('i', { class: 'k k-in' }), h('b', { text: this.W.money(buy[k]) }), h('span', { class: 'sv-tip-dim', text: '买盘多的日子成交' })),
            h('div', { class: 'sv-tip-row' }, h('i', { class: 'k k-out' }), h('b', { text: this.W.money(sell[k]) }), h('span', { class: 'sv-tip-dim', text: '卖盘多的日子成交' })),
            h('div', { class: 'sv-tip-say', text: `最近120天里 ${(share * 100).toFixed(1)}% 的钱在这个价位换手。` }),
            ...this.estTipLines(est),
          ], ev.clientX, ev.clientY);
        })
        .on('pointerleave', () => { row.classed('hover', false); this.hideTip(); });
    });
    // peak label (hidden later if it collides with the price line label)
    if (peak >= 0) {
      const yy = yP(bins[peak]);
      const xx = xl + xm(tot[peak]);
      const anchorEnd = xx > W - 110;
      g.append('text').attr('class', 'sv-mtn-peak').attr('x', anchorEnd ? Math.max(xl + 4, xx - 6) : xx + 6).attr('y', yy + 4)
        .attr('text-anchor', anchorEnd ? 'end' : 'start').text(`成交最多 ≈ ${fmtPriceRound(bins[peak])}`);
    }
    // value area (≈ half of the money around the peak) for the caption
    const order = d3.range(bins.length).sort((a, b) => tot[b] - tot[a]);
    const total = d3.sum(tot) || 1;
    let acc = 0, vlo = Infinity, vhi = -Infinity;
    for (const k of order) { acc += tot[k]; vlo = Math.min(vlo, bins[k]); vhi = Math.max(vhi, bins[k]); if (acc / total >= 0.5) break; }
    const va = { lo: vlo - stepP / 2, hi: vhi + stepP / 2 };
    const vy0 = yP(va.hi), vy1 = yP(va.lo);
    const band = svg.insert('g', ':first-child').attr('class', 'sv-mtn-va');
    band.append('rect').attr('x', 0).attr('width', W).attr('y', vy0).attr('height', Math.max(1, vy1 - vy0));
    band.append('line').attr('x1', 0).attr('x2', W).attr('y1', vy0).attr('y2', vy0);
    band.append('line').attr('x1', 0).attr('x2', W).attr('y1', vy1).attr('y2', vy1);
    this.mlay = { W, Hm, bins, tot, total, stepP, svg, vlo: va.lo, vhi: va.hi, vy0, vy1, peakY: peak >= 0 ? yP(bins[peak]) : null };
    E.mtnCap.className = 'sv-cap sv-cap-calm';
    put(E.mtnCap, h('span', { text: '大家在 ' }), h('b', { text: `${fmtPriceRound(va.lo)}–${fmtPriceRound(va.hi)}` }), h('span', { text: ' 买得最多（浅色带）' }));
    E.mtnCap.title = '最近120天里，一半的钱是在这个价格区间里换手的。';
    svg.append('g').attr('class', 'sv-mtn-now');
    E.mtnSvg.setAttribute('aria-label', '最近120天各个价位的成交量');
  }

  drawMountainPrice() {
    const ml = this.mlay, lay = this.lay, P = this.P, E = this.el;
    if (!ml || !lay) return;
    const c = P.c[this.i];
    const g = ml.svg.select('.sv-mtn-now');
    g.selectAll('*').remove();
    if (!isNum(c)) { put(E.mtnFoot); return; }
    // share of the last-120-day money that changed hands below the selected price
    let below = 0;
    ml.bins.forEach((b, k) => {
      const lo = b - ml.stepP / 2, hi = b + ml.stepP / 2;
      if (hi <= c) below += ml.tot[k];
      else if (lo < c) below += ml.tot[k] * (c - lo) / (hi - lo);
    });
    const share = below / ml.total;
    const latest = this.i === P.n - 1;
    const lbl = latest ? '现价' : dayLabel(P.dates[this.i]);
    const sayShare = share >= 0.8 ? '大部分买家在赚钱' : share >= 0.55 ? '多数买家在赚钱' : share >= 0.45 ? '一半一半' : share >= 0.2 ? '多数买家被套着' : '大部分买家被套着';
    put(E.mtnFoot,
      h('b', { text: `${lbl}高于 ${Math.round(share * 100)}% 的成交` }),
      h('span', { text: ` → ${sayShare}` }));
    E.mtnFoot.title = `最近120天里，有 ${Math.round(share * 100)}% 的钱是在比${lbl}（${fmtPrice(c)}）更低的价位成交的。`;
    const yy = lay.yP(c);
    if (yy < 0 || yy > ml.Hm) return;
    g.append('line').attr('x1', 0).attr('x2', ml.W).attr('y1', yy).attr('y2', yy);
    const txt = `${lbl} ${fmtPrice(c)}`;
    const above = !(yy - 6 < 14);
    g.append('text').attr('x', ml.W - 6).attr('y', above ? yy - 6 : yy + 15).attr('text-anchor', 'end').text(txt);
    const peakTxt = ml.svg.select('.sv-mtn-peak');
    if (ml.peakY != null) {
      const pb = ml.peakY + 4, lb = above ? yy - 6 : yy + 15; // baselines
      peakTxt.style('display', Math.abs(pb - lb) < 15 || Math.abs(pb - 4 - yy) < 9 ? 'none' : null);
    }
  }

  // ---------------------------------------------------------------- 今天盘中
  async refreshIntraday(first) {
    const T = this.T, tok = this.token;
    const E = this.el;
    if (first) {
      E.intraSub.textContent = '';
      E.intraHead.textContent = '';
      E.intraLine.textContent = '正在看盘中…';
      E.intraLine.className = 'sv-intra-line dim';
    }
    let data = null, err = null;
    if (apiMissingAt && Date.now() - apiMissingAt < 10 * 60e3) err = new Error('HTTP 404');
    else try {
      data = await fetchJSON(`${this.apiBase}api/intraday?t=${encodeURIComponent(T)}`, { cache: false, timeout: 25000 });
      if (!data || data.error || !Array.isArray(data.bars) || !data.bars.length) throw new Error(data?.error || '没有盘中数据');
    } catch (e) { err = e; }
    if (err && /HTTP (404|405|501)/.test(err.message)) {
      apiMissingAt = Date.now();
      clearInterval(this.intraTimer);
    } else if (!err) apiMissingAt = 0;
    if (tok !== this.token || this.closed) return;
    if (err) {
      if (this.intra && !first) {
        E.intraHead.textContent = '更新失败，稍后再试';
        return;
      }
      this.intra = null;
      this.intraErr = err;
      this.drawIntradayFallback();
      return;
    }
    this.intra = data;
    this.intraAt = new Date();
    this.drawIntraday();
  }

  drawIntradayFallback() {
    const d3 = d3g(), E = this.el, P = this.P;
    E.intraSub.textContent = '';
    E.intraHead.textContent = '';
    E.intraLine.className = 'sv-intra-line dim';
    put(E.intraLine,
      h('span', { text: '盘中数据现在拿不到' }),
      h('span', { class: 'sv-intra-hint', text: apiMissingAt ? '（用 server.py 启动才有）。先看最近 5 天每天的进出：' : '（网络或数据源暂时不通，60 秒后再试）。先看最近 5 天每天的进出：' }));
    const svg = d3.select(E.intraSvg);
    svg.selectAll('*').remove();
    const Wd = E.intraSvg.clientWidth, Hd = E.intraSvg.clientHeight;
    if (!P || Wd < 60 || Hd < 30) return;
    svg.attr('viewBox', `0 0 ${Wd} ${Hd}`);
    const i = P.n - 1;
    const ks = d3.range(Math.max(P.first, i - 4), i + 1);
    const vals = ks.map((k) => num(P.flow[k]));
    const mx = d3.max(vals, Math.abs) || 1;
    const x = d3.scaleBand().domain(ks).range([4, Wd - 4]).padding(0.38);
    const y = d3.scaleLinear().domain([-mx, mx]).range([Hd - 16, 14]);
    svg.append('line').attr('class', 'sv-zero').attr('x1', 0).attr('x2', Wd).attr('y1', y(0)).attr('y2', y(0));
    ks.forEach((k, n) => {
      const f = vals[n];
      svg.append('rect').attr('class', f >= 0 ? 'sv-fb in' : 'sv-fb out').attr('x', x(k)).attr('width', x.bandwidth())
        .attr('y', y(Math.max(0, f))).attr('height', Math.max(1, Math.abs(y(f) - y(0))));
      svg.append('text').attr('class', 'sv-axis').attr('x', x(k) + x.bandwidth() / 2).attr('y', Hd - 3).attr('text-anchor', 'middle').text(dayLabel(P.dates[k]));
      svg.append('text').attr('class', 'sv-fb-v').attr('x', x(k) + x.bandwidth() / 2).attr('y', f >= 0 ? y(f) - 4 : y(f) + 11).attr('text-anchor', 'middle').text(moneyShort(f));
    });
  }

  drawIntraday() {
    const d3 = d3g(), E = this.el, W = this.W;
    const data = this.intra;
    if (!data) { if (this.intraErr) this.drawIntradayFallback(); return; }
    const bars = data.bars.filter((b) => b && b.ts && isNum(b.c));
    if (!bars.length) { this.drawIntradayFallback(); return; }
    // the exchange's own session and clock (New York for US listings); local-currency bars → USD (§23)
    const [tz, sOpen, sClose, place] = sessionOf(this.T);
    const us = tz === US_SESS[0];
    const raw = this.P && this.P.raw;
    const fxs = raw && raw.ccy && raw.ccy !== 'USD' && Array.isArray(raw.fx) ? raw.fx.filter(isNum) : null;
    const fx = fxs && fxs.length ? fxs[fxs.length - 1] : 1;
    const dayOf = (ts) => (us ? ts.slice(0, 10) : tzDay(tz, new Date(ts)));
    const lastDay = us && /^\d{4}-\d{2}-\d{2}$/.test(String(data.session || '')) && bars.some((b) => b.ts.slice(0, 10) === data.session)
      ? data.session : dayOf(bars[bars.length - 1].ts);
    const today = bars.filter((b) => dayOf(b.ts) === lastDay);
    const off = today[0].ts.slice(19) || '';
    let t0 = us ? new Date(`${lastDay}T09:30:00${off}`) : zonedAt(lastDay, sOpen, tz);
    let t1 = us ? new Date(`${lastDay}T16:00:00${off}`) : zonedAt(lastDay, sClose, tz);
    const tFirst = new Date(today[0].ts), tLast = new Date(today[today.length - 1].ts);
    if (tFirst < t0 || tLast > t1) { t0 = new Date(Math.min(+t0, +tFirst)); t1 = new Date(Math.max(+t1, +tLast)); }
    let acc = 0;
    const pts = today.map((b) => ({ t: new Date(b.ts), c: b.c * fx, f: (acc += num(b.flow) * fx), ff: num(b.flow) * fx }));
    const dayRec = (data.days || []).find((d) => d.date === lastDay);
    const prevBars = bars.filter((b) => dayOf(b.ts) < lastDay);
    const prevClose = isNum(data.prevClose) && data.prevClose > 0 ? data.prevClose * fx : prevBars.length ? prevBars[prevBars.length - 1].c * fx : null;
    const open0 = isNum(prevClose) ? prevClose : today[0].c; // reference line: yesterday's close (else the open)
    const refName = isNum(prevClose) ? '昨收' : '开盘';
    const ret = isNum(prevClose) ? pts[pts.length - 1].c / prevClose - 1 : dayRec && isNum(dayRec.ret) ? dayRec.ret : (pts[pts.length - 1].c / open0 - 1);
    // is it live? (NY date == lastDay and within session)
    let live = false;
    try {
      const now = new Date();
      live = tzDay(tz, now) === lastDay && now >= t0 && now <= new Date(t1.getTime() + 5 * 60000);
    } catch { /* ignore */ }
    E.intraSub.textContent = live ? `直播中 · 每5分钟${us ? '' : ` · ${place}时间`}` : `${place} ${dayLabel(lastDay)} 收盘`;
    E.intraSub.title = (live ? `${us ? '美股' : place}正在交易，每 5 分钟一根` : `这是最近一个交易日（${place} ${dayLabel(lastDay, true)}）的盘中走势`)
      + (fx !== 1 ? `；价格和钱已按 ${raw.ccy} 兑美元折成美元` : '');
    E.intraSub.classList.toggle('live', live);
    const at = this.intraAt;
    E.intraHead.textContent = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 更新` : '';
    E.intraHead.title = '打开时每 60 秒自动刷新一次';
    E.intraLine.className = 'sv-intra-line';
    put(E.intraLine,
      h('span', { class: acc >= 0 ? 'in' : 'out', text: `${acc >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(acc))}` }),
      h('span', { class: 'sv-intra-sep', text: '·' }),
      h('span', { text: `价格 ${signPct(W, ret)}` }),
      h('span', { class: 'sv-intra-hint', text: acc >= 0 && ret <= -0.002 ? '价格跌，钱却在进' : acc < 0 && ret >= 0.002 ? '价格涨，钱却在出' : '' }));

    // chart: price (top) + cumulative flow (bottom), shared time axis, separate y
    const svg = d3.select(E.intraSvg);
    svg.selectAll('*').remove();
    const Wd = E.intraSvg.clientWidth, Hd = E.intraSvg.clientHeight;
    if (Wd < 60 || Hd < 40) return;
    svg.attr('viewBox', `0 0 ${Wd} ${Hd}`);
    const m = { l: 4, r: 54, t: 6, b: 16 };
    const ih = Hd - m.t - m.b - 6;
    const hp = Math.round(ih * 0.5), hf = ih - hp;
    const ya0 = m.t, yb0 = m.t + hp + 6;
    const x = d3.scaleTime().domain([t0, t1]).range([m.l, Wd - m.r]);
    const [pl, pmx] = d3.extent([...pts.map((p) => p.c), open0]);
    const pp = (pmx - pl) * 0.1 || pmx * 0.002 || 1;
    const yp = d3.scaleLinear().domain([pl - pp, pmx + pp]).range([ya0 + hp, ya0]);
    const [fl, fh] = d3.extent(pts, (p) => p.f);
    const flo = Math.min(0, fl), fhi = Math.max(0, fh);
    const fp = (fhi - flo) * 0.1 || 1;
    const yf = d3.scaleLinear().domain([flo - fp, fhi + fp]).range([yb0 + hf, yb0]);
    const grid = svg.append('g').attr('class', 'sv-grid');
    grid.append('line').attr('class', 'sv-zero').attr('x1', m.l).attr('x2', Wd - m.r).attr('y1', yf(0)).attr('y2', yf(0));
    grid.append('text').attr('class', 'sv-axis').attr('x', Wd - m.r + 6).attr('y', yp(open0) + 4).text(`${refName} ${fmtPriceRound(open0)}`);
    grid.append('line').attr('class', 'sv-ref').attr('x1', m.l).attr('x2', Wd - m.r).attr('y1', yp(open0)).attr('y2', yp(open0));
    grid.append('text').attr('class', 'sv-axis').attr('x', Wd - m.r + 6).attr('y', yf(0) + 4).text('0');
    if (Math.abs(yf(acc) - yf(0)) > 12 && hf >= 30) grid.append('text').attr('class', 'sv-axis').attr('x', Wd - m.r + 6).attr('y', yf(acc) + 4).text(moneyShort(acc));
    const tMid = new Date((+t0 + +t1) / 2);
    for (const [tt, anchor] of [[t0, 'start'], [tMid, 'middle'], [t1, 'end']]) {
      svg.append('text').attr('class', 'sv-axis').attr('x', x(tt)).attr('y', Hd - 3)
        .attr('text-anchor', anchor).text(tzHM(tz, tt).replace(/^0(\d)/, '$1'));
    }
    const dir = acc >= 0 ? 'in' : 'out';
    svg.append('path').attr('class', 'sv-intra-area ' + dir)
      .attr('d', d3.area().x((p) => x(p.t)).y0(yf(0)).y1((p) => yf(p.f)).curve(d3.curveMonotoneX)(pts));
    svg.append('path').attr('class', 'sv-intra-flow ' + dir)
      .attr('d', d3.line().x((p) => x(p.t)).y((p) => yf(p.f)).curve(d3.curveMonotoneX)(pts));
    svg.append('path').attr('class', 'sv-intra-price').attr('d', d3.line().x((p) => x(p.t)).y((p) => yp(p.c)).curve(d3.curveMonotoneX)(pts));
    if (hp >= 44) {
      svg.append('text').attr('class', 'sv-ptitle sv-ptitle-halo').attr('x', m.l + 2).attr('y', ya0 + 10).text('价格');
      svg.append('text').attr('class', 'sv-ptitle sv-ptitle-halo').attr('x', m.l + 2).attr('y', yb0 + 10).text('累计进出');
    }
    const lastP = pts[pts.length - 1];
    svg.append('circle').attr('class', 'sv-intra-dot').attr('cx', x(lastP.t)).attr('cy', yp(lastP.c)).attr('r', live ? 3.5 : 2.8).classed('live', live);

    const cross = svg.append('g').attr('class', 'sv-cross').style('display', 'none');
    cross.append('line').attr('y1', ya0).attr('y2', yb0 + hf);
    cross.append('circle').attr('class', 'p').attr('r', 3);
    cross.append('circle').attr('class', 'c').attr('r', 3);
    const bis = d3.bisector((p) => p.t).center;
    svg.append('rect').attr('class', 'sv-hit').attr('x', m.l).attr('y', 0).attr('width', Wd - m.l - m.r).attr('height', Hd)
      .on('pointermove', (ev) => {
        const [px] = d3.pointer(ev);
        const k = bis(pts, x.invert(px));
        const p = pts[clamp(k, 0, pts.length - 1)];
        cross.style('display', null);
        cross.select('line').attr('x1', x(p.t)).attr('x2', x(p.t));
        cross.select('.p').attr('cx', x(p.t)).attr('cy', yp(p.c));
        cross.select('.c').attr('cx', x(p.t)).attr('cy', yf(p.f));
        const hm = tzHM(tz, p.t);
        this.showTip([
          h('div', { class: 'sv-tip-date', text: `${place} ${hm}` }),
          h('div', { class: 'sv-tip-row' }, h('i', { class: 'k k-price' }), h('b', { text: fmtPrice(p.c) }), h('span', { class: 'sv-tip-dim', text: `比${refName} ${signPct(W, p.c / open0 - 1)}` })),
          h('div', { class: 'sv-tip-row' }, h('i', { class: 'k ' + (p.f >= 0 ? 'k-in' : 'k-out') }), h('b', { text: `${p.f >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(p.f))}` }), h('span', { class: 'sv-tip-dim', text: '开盘到这时' })),
          h('div', { class: 'sv-tip-say', text: `这5分钟：${p.ff >= 0 ? '进' : '出'} ${W.money(Math.abs(p.ff))}` }),
        ], ev.clientX, ev.clientY);
      })
      .on('pointerleave', () => { cross.style('display', 'none'); this.hideTip(); });
  }

  // ---------------------------------------------------------------- 邻居
  peerIndex(s) {
    const P = this.P;
    const d = P.dates[this.i];
    let j = s.dateIdx.get(d);
    if (j == null) j = this.i - (P.n - s.n);
    if (j < s.first) return null;
    return clamp(j, 0, s.n - 1);
  }

  async loadPeers(tok) {
    const P = this.P;
    const ids = (Array.isArray(P.raw.peers) ? P.raw.peers : []).map((p) => String(p).replace(/^s:/, '')).filter((t) => t && t !== P.t).slice(0, 10);
    this.peers = ids.map((t) => ({ t, s: null, failed: false }));
    this.renderPeers();
    if (!ids.length) return;
    await Promise.all(this.peers.map(async (pe) => {
      try { pe.s = prep(await fetchJSON(`${this.base}stocks/${encodeURIComponent(pe.t)}.json`)); } catch { pe.failed = true; }
      if (tok === this.token && !this.closed) this.updatePeers();
    }));
    // a value that had to be estimated from the neighbours can now be filled in (§14)
    if (tok === this.token && !this.closed) {
      const i = this.i;
      if (['wind', 'temp', 'pres'].some((k) => !isNum(this.P[k][i]))) { this.renderWeather(); this.renderCaster(); }
    }
  }

  renderPeers() {
    const E = this.el;
    if (!this.peers.length) {
      put(E.peers, h('span', { class: 'sv-peer-empty', text: '它没有登记的邻居。' }));
      return;
    }
    put(E.peers, ...this.peers.map((pe) => {
      const el = h('button', { class: 'sv-peer', type: 'button', 'data-t': pe.t, onclick: () => this.goPeer(pe.t) });
      pe.el = el;
      return el;
    }));
    this.updatePeers();
  }

  updatePeers() {
    const W = this.W, P = this.P;
    if (!P) return;
    for (const pe of this.peers || []) {
      const el = pe.el;
      if (!el) continue;
      const s = pe.s;
      if (!s) {
        el.className = 'sv-peer is-empty';
        put(el,
          h('span', { class: 'sv-peer-top' }, h('i', { class: 'sv-peer-dot' }), h('b', { class: 'sv-peer-name', text: pe.t })),
          h('span', { class: 'sv-peer-wind calm' }, h('span', { text: pe.failed ? '还没收进地图' : '正在看天气…' })));
        continue;
      }
      const j = this.peerIndex(s);
      if (j == null) {
        el.className = 'sv-peer is-empty';
        put(el,
          h('span', { class: 'sv-peer-top' }, h('i', { class: 'sv-peer-dot' }), h('b', { class: 'sv-peer-name', text: s.name }), h('em', { text: s.t })),
          h('span', { class: 'sv-peer-wind calm' }, h('span', { text: '那时还没上市' })));
        continue;
      }
      const w = s.wind[j], tp = s.temp[j], pr = s.pres[j];
      const r20 = chg(s, j, 20);
      const f5 = sumFlow(s, j - 4, j);
      const tone = windTone(w);
      const w5 = s.wind[Math.max(0, j - 5)];
      // same words as the header stamp: the 5-day money and the temperature pick the sentence (words.season)
      const ext = this.opts && this.opts.words;
      let pcr = null;
      try { pcr = ext && typeof ext.crashAt === 'function' ? ext.crashAt(s, j) : null; } catch { pcr = null; }
      const sr = isNum(w) && isNum(pr) ? (this.W.season(w, isNum(w5) ? w - w5 : 0, pr, f5, tp, pcr) || seasonLocal(w, isNum(w5) ? w - w5 : 0, pr, f5, tp, pcr)) : null;
      const sk = seasonKey(sr);
      const sNow = sk ? plain(sr.nowMild || sr.now || SEASONS[sk].now) : '';
      const arrow = icon(tone === 'calm' ? 'calm' : 'arrow', 'sv-peer-arrow');
      if (tone !== 'calm') arrow.style.transform = `rotate(${tone === 'in' ? -40 : 40}deg)`;
      // 60-day price sparkline up to j
      const spark = svgEl('svg', { class: 'sv-peer-spark', viewBox: '0 0 60 20', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      const a0 = Math.max(s.first, j - 59);
      const vals = s.c.slice(a0, j + 1).filter(isNum);
      if (vals.length > 2) {
        const mn = Math.min(...vals), mx = Math.max(...vals);
        const pts = vals.map((v, k) => [k / (vals.length - 1) * 58 + 1, 18 - (v - mn) / ((mx - mn) || 1) * 16]);
        spark.append(svgEl('polyline', { points: pts.map((p) => p.map((q) => q.toFixed(1)).join(',')).join(' '), 'vector-effect': 'non-scaling-stroke' }));
        const lp = pts[pts.length - 1];
        spark.append(svgEl('circle', { cx: lp[0].toFixed(1), cy: lp[1].toFixed(1), r: 1.6 }));
      }
      el.className = `sv-peer ${tone}`;
      put(el,
        h('span', { class: 'sv-peer-top' },
          h('i', { class: 'sv-peer-dot', style: { background: tempColor(tp, this.colors.bands) }, title: `温度：${wordOf(W.tempWord(tp))}` }),
          h('b', { class: 'sv-peer-name', text: s.name }),
          s.name !== s.t ? h('em', { text: s.t }) : null,
          sk ? h('span', { class: `sv-peer-season sv-season--${sk}`, title: `季节：${SEASONS[sk].name}（${sNow}）` }, icon(sk), SEASONS[sk].name) : null),
        h('span', { class: `sv-peer-wind ${tone}` }, arrow, h('span', { text: wordOf(W.windWord(w, f5, pcr)) })),
        h('span', { class: 'sv-peer-foot' },
          h('span', { class: 'sv-peer-r' }, h('em', { text: '近20天' }), h('b', { class: isNum(r20) ? (r20 >= 0 ? 'up' : 'down') : '', text: signPct(W, r20) })),
          spark));
      const sayF = isNum(f5) ? `5天${f5 >= 0 ? '净流入' : '净流出'} ${W.money(Math.abs(f5))}` : '';
      el.title = `${s.name}（${s.t}）\n风：${wordOf(W.windWord(w, f5, pcr))}${sayF ? `（${sayF}）` : ''}\n温度：${wordOf(W.tempWord(tp))}　拥挤度：${isNum(pr) ? Math.round(pr) : '—'}\n近20个交易日价格 ${signPct(W, r20)}；小曲线 = 近60天价格\n点一下换过去`;
      el.setAttribute('aria-label', el.title.replace(/\n/g, '，'));
    }
  }

  goPeer(t) {
    if (typeof this.opts.onPeer === 'function') this.opts.onPeer(t);
    else this.load(t);
  }

  // ---------------------------------------------------------------- the little planet (header)
  // §17: flat cel-shaded disc, one crisp terminator, thin rim light, anime wind-lines with rounded heads.
  startPlanet() {
    cancelAnimationFrame(this.planetRaf);
    this.planetRaf = 0;
    const cv = this.el.planet;
    const S = cv.clientWidth || 60;
    this.planetSize = cv.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(S * dpr); cv.height = Math.round(S * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lines = Array.from({ length: 4 }, (_, k) => ({ a: (k * Math.PI) / 2 + 0.4 * k, t: k / 4, s: 0.85 + 0.1 * k }));
    const d3 = d3g();
    let last = performance.now(), flash = 0, nextFlash = 0.8;
    const frame = (now) => {
      if (this.closed) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const C = this.colors;
      const st = this.planetState || { temp: 0, wind: 0, storm: 0, front: 0 };
      const tc = tempColor(st.temp, C.bands);
      const shade = d3.interpolateRgb(tc, C.ink)(0.32);
      ctx.clearRect(0, 0, S, S);
      const cx = S / 2, cy = S / 2, R = S * 0.25;
      const w = clamp(st.wind, -3, 3);
      const tone = windTone(w);
      const wc = tone === 'in' ? C.in : tone === 'out' ? C.out : C.ink3;
      const speed = 0.35 + Math.abs(w) * 0.3;
      // wind lines: inflow drifts inward, outflow drifts outward, calm just circles
      ctx.lineCap = 'round';
      for (const L of lines) {
        if (!this.reduceMotion) { L.t += dt * speed * 0.32 * L.s; L.a += dt * speed * 0.8 * L.s; }
        if (L.t > 1) L.t -= 1;
        const k = tone === 'in' ? 1 - L.t : tone === 'out' ? L.t : 0.55 + 0.25 * Math.sin(L.t * Math.PI * 2);
        const r = R + 4 + k * (S / 2 - R - 6);
        const fade = tone === 'calm' ? 0.55 : Math.sin(Math.PI * L.t);
        const len = 0.5 + 0.35 * Math.min(1, Math.abs(w) / 2);
        // tapered stroke: hair-thin tail → full width at the rounded head (anime wind-line)
        ctx.globalAlpha = 0.2 + 0.7 * fade;
        ctx.strokeStyle = wc;
        const SEG = 7;
        for (let q = 0; q < SEG; q++) {
          ctx.lineWidth = 0.35 + (1.35 * (q + 1)) / SEG;
          ctx.beginPath(); ctx.arc(cx, cy, r, L.a - len + (len * q) / SEG, L.a - len + (len * (q + 1)) / SEG + 0.01); ctx.stroke();
        }
        ctx.fillStyle = wc;
        ctx.beginPath(); ctx.arc(cx + Math.cos(L.a) * r, cy + Math.sin(L.a) * r, 1.45, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      // body: shadow colour first, lit disc offset to the top-left → one crisp terminator
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = shade; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      ctx.fillStyle = tc; ctx.beginPath(); ctx.arc(cx - R * 0.26, cy - R * 0.22, R * 0.98, 0, Math.PI * 2); ctx.fill();
      // one paper-cut band (a territory edge) for a hint of geography
      ctx.strokeStyle = C.card; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx - R, cy + R * 0.18); ctx.bezierCurveTo(cx - R * 0.3, cy - R * 0.25, cx + R * 0.2, cy + R * 0.45, cx + R, cy - R * 0.05); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
      // rim light (top-left) + ink outline
      ctx.strokeStyle = C.rim; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(cx, cy, R - 2, Math.PI * 1.06, Math.PI * 1.44); ctx.stroke();
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      // front: a short weather-map front arc above the planet (semicircles = 流入, triangles = 撤离)
      if (st.front) {
        const col = st.front > 0 ? C.in : C.out, rr = R + 3.5;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, cy, rr, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
        for (const a of [1.3, 1.5, 1.7]) {
          const ang = Math.PI * a, px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
          ctx.beginPath();
          if (st.front > 0) ctx.arc(px, py, 2.4, ang - Math.PI / 2, ang + Math.PI / 2, false);
          else { const nx = Math.cos(ang), ny = Math.sin(ang), tx = -ny, ty = nx; ctx.moveTo(px + tx * 2.6, py + ty * 2.6); ctx.lineTo(px - tx * 2.6, py - ty * 2.6); ctx.lineTo(px + nx * 3.4, py + ny * 3.4); }
          ctx.fill();
        }
      }
      // storm: one crisp zig-zag + three neat rain strokes
      if (st.storm >= 0.8) {
        if (!this.reduceMotion) {
          nextFlash -= dt;
          if (nextFlash <= 0) { flash = 1; nextFlash = 1.6 + Math.random() * 2.2; }
          flash = Math.max(0, flash - dt * 3);
        }
        const lx = cx + R * 0.95, ly = cy - R * 1.05;
        ctx.globalAlpha = this.reduceMotion ? 1 : 0.55 + 0.45 * flash;
        ctx.fillStyle = C.gold; ctx.strokeStyle = C.ink; ctx.lineWidth = 0.9; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(lx + 1.5, ly - 6); ctx.lineTo(lx - 3, ly + 1); ctx.lineTo(lx + 0.2, ly + 1); ctx.lineTo(lx - 1.8, ly + 7);
        ctx.lineTo(lx + 4, ly - 1); ctx.lineTo(lx + 0.8, ly - 1); ctx.lineTo(lx + 3.6, ly - 6); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 0.8; ctx.strokeStyle = C.ink3; ctx.lineWidth = 1.1;
        for (let q = 0; q < 3; q++) {
          const rx = cx - R * 1.15 + q * 4, ry = cy + R * 0.55 + (q % 2) * 3;
          ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 2, ry + 4.5); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (!this.reduceMotion) this.planetRaf = requestAnimationFrame(frame);
    };
    this.planetFrame = frame;
    this.planetRaf = requestAnimationFrame(frame);
  }
}

export default openStockView;
