// scenario.js — 推演模式 (DESIGN §9) + its Polymarket cards (§10). A §19 feature module: `init(app)`.
//
// 推演 button → one dated judgment (sentence · month · 弱/中/强) → POST /api/scenario → progress →
// the planet switches to *future weather* (planet.setOverlay('scenario', …)) with a stage bar
// 现在 → 1–3 个月 → 3–12 个月 → 1 年以上 in place of the time machine, and a story drawer in place of
// the side panel: headline · 老风的结论 · the chain as a numbered story · 落点 by 时间差 (bet kind, ⏳ / 已抢跑,
// what the price already demands) · the market's dates vs the owner's · 认错线 · tracking · saved list.
//
// Owns only this file, css/scenario.css and the DOM it creates. Everything it needs from the shell is
// reached defensively (shell, planet and server are built in parallel): a missing method means the
// matching piece quietly does less, never an error.

const LAGS = ['now', '1-3m', '3-12m', '1y+'];
const LAG_ZH = { now: '现在', '1-3m': '1–3 个月', '3-12m': '3–12 个月', '1y+': '1 年以上' };
const LAG_HINT = {
  now: '消息一出就动的地方',
  '1-3m': '一个季度内跟上的',
  '3-12m': '要等财报、订单落地的',
  '1y+': '慢慢改写生意的',
};
const TIERS = [
  { k: '弱', name: '只赌方向', sub: 'AI 的话：照现在这样涨' },
  { k: '中', name: '比市场快', sub: 'AI 的话：两年内明显跑到预期前面' },
  { k: '强', name: '原话带日期', sub: '一字不让，按你写的日子算' },
];
const EXAMPLES = [
  { text: '2026 年 11 月基本实现 RSI，AI 开始自己做 AI 研究', date: '2026-11', tier: '强' },
  { text: '美联储 12 月降息 50 个基点', date: '2026-12', tier: '强' },
  { text: '中美关税在 11 月休战到期后大幅升级', date: '2026-11', tier: '中' },
];
const STAGES_TEXT = ['排队', '读地图', '找预言市场', '正在推演', '算时间差', '完成'];
const SEASON = {
  spring: { name: '春' }, summer: { name: '夏' }, autumn: { name: '秋' }, winter: { name: '冬' },
};
const CAT_ZH = { rates: '利率', macro: '宏观', ai: 'AI', crypto: '加密', energy: '能源', tech: '科技', politics: '政治', stocks: '股市',
  geo: '地缘', trade: '贸易', commod: '商品', health: '医疗' };
const REL = {
  supports: { t: '站你这边', c: 'sup' },
  contradicts: { t: '跟你唱反调', c: 'con' },
  timing: { t: '管时间', c: 'tim' },
  root: { t: '就是你的根', c: 'root' },
  weak: { t: '关联弱', c: 'weak' },
};

// ============================================================================ market titles: leftover English
// The translators (polymarket/translate.py, predict/kzh.py) leave option labels and some phrases in English
// ("2026年底经济状况如何｜Overheating", "美联储会在December 2026 Meeting前降息吗？"). Until they are re-run, the
// cards read the common ones in Chinese here; names (people, models) stay as they are.
const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON_RE = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const ZH_FIX = [
  [new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{4})\\s+Meeting\\b`, 'gi'), (_, mo, y) => `${y}年${MON[mo.toLowerCase()]}月议息会议`],
  [new RegExp(`\\b(?:Before|By)\\s+(${MON_RE})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'), (_, mo, d, y) => `${y}年${MON[mo.toLowerCase()]}月${+d}日前`],
  [new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'), (_, mo, d, y) => `${y}年${MON[mo.toLowerCase()]}月${+d}日`],
  [new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{4})\\b`, 'gi'), (_, mo, y) => `${y}年${MON[mo.toLowerCase()]}月`],
  [/\bOverheating\b/gi, '过热'], [/\bStagflation\b/gi, '滞胀'], [/\bRecession\b/gi, '衰退'], [/\bSoft landing\b/gi, '软着陆'],
  [/\bHard landing\b/gi, '硬着陆'], [/\bGoldilocks\b/gi, '不冷不热'], [/\bReflation\b/gi, '再通胀'], [/\bDeflation\b/gi, '通缩'], [/\bExpansion\b/gi, '扩张'],
  [/\bNo change\b/gi, '按兵不动'], [/\bHike\s+(\d+)\s*[-–]\s*(\d+)\s*bps\b/gi, '加息 $1–$2 个基点'], [/\bCut\s+(\d+)\s*[-–]\s*(\d+)\s*bps\b/gi, '降息 $1–$2 个基点'],
  [/\bHike\s+(\d+)\+?\s*bps\b/gi, '加息 $1 个基点'], [/\bCut\s+(\d+)\+?\s*bps\b/gi, '降息 $1 个基点'], [/\b(\d+)\s*bps\b/gi, '$1 个基点'],
  [/\bExactly\s+(\d+)\b/gi, '正好 $1 次'], [/\bAt least\s+(\d+)\b/gi, '至少 $1 次'], [/\b(\d+)\s+or more\b/gi, '$1 次或更多'],
  [/\$\s*([\d.,]+)\s*\u200e?\s*trillion\b/gi, (_, v) => `${+String(v).replace(/,/g, '')}万亿美元`],
  [/\$\s*([\d.,]+)\s*\u200e?\s*billion\b/gi, (_, v) => `${Math.round(+String(v).replace(/,/g, '') * 10)}亿美元`],
  [/\bInformation Technology\b/g, '信息技术'], [/\bCommunication Services\b/g, '通信服务'], [/\bConsumer Discretionary\b/g, '可选消费'],
  [/\bFinancials\b/g, '金融'], [/\bHealth Care\b/g, '医疗'], [/\bIndustrials\b/g, '工业'],
  [/\ba personal AI agent\b/gi, '个人 AI 助理'], [/\bAbove\b/g, '高于'], [/\bBelow\b/g, '低于'], [/\bBetween\b/g, '介于'],
  [/\bYes\b/g, '是'], [/\bNo\b/g, '否'],
];
// ---- do two markets ask the same thing? (English question words, dates and filler dropped; polarity must match)
const Q_STOP = new Set(('will the a an of in on by before after at to be is are was any officially announce announces announced '
  + 'release released releases achieve achieves achieved have has had than more less above below between or and for its it this that '
  + 'what who when which how many much end year meeting next new us publicly happen happens').split(' '));
const Q_MON = new RegExp(`^(${MON_RE})$`, 'i');
const NEG_RE = /\b(no|not|never|without|fails?)\b/i;
function qTokens(q) {
  return new Set(String(q || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9+]+/)
    .filter((w) => w && w.length > 1 && !Q_STOP.has(w) && !Q_MON.test(w) && !/^\d+$/.test(w)));
}
/** Kalshi "When will Anthropic announce an IPO: before Dec 1" ≈ Polymarket "Will Anthropic IPO by Nov 30" (not "OpenAI or
 *  Anthropic IPO first"): ≥ 2 shared words and ≥ 60% overlap, same polarity. */
export function sameQuestion(a, b) {
  const A = qTokens(a), B = qTokens(b);
  if (!A.size || !B.size || NEG_RE.test(a) !== NEG_RE.test(b)) return false;
  let k = 0;
  for (const x of A) if (B.has(x)) k++;
  return k >= 2 && k / new Set([...A, ...B]).size >= 0.6;
}

/** "2026年底经济状况如何｜Overheating" → "2026年底经济状况如何｜过热" (only the common leftovers; names stay) */
export function zhFix(q) {
  let s = String(q || '');
  if (!/[A-Za-z]{2,}/.test(s) || !/[\u4e00-\u9fa5]/.test(s)) return s;      // all-English titles are shown as they are
  for (const [re, to] of ZH_FIX) s = s.replace(re, to);
  return s.replace(/\u200e/g, '').replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1');
}
const BET = {
  base: { t: '打底', c: 'base', tip: '弱/中档的根就成立，价格要的和对了多大都算得出' },
  punt: { t: '去搏', c: 'punt', tip: '能赢，但有一处没把握' },
  paid: { t: '已付过钱', c: 'paid', tip: '钱和价格已经按这件事走了' },
  hurt: { t: '受损的一边', c: 'hurt', tip: '钱会从这里流出去' },
};
const VERDICT_ICON = { gap: 'hourglass', 'unpriced-damage': 'down', taken: 'ahead', factors: 'chain', base: 'anchor' };
const LS = {
  seen: 'mw.scn.seen',          // ids opened/created here (fallback list when the server can't list)
  caveat: 'mw.pm.caveatSeen',   // the honest Polymarket caveat, shown once (shared with clouds.js)
  last: 'mw.scn.last',          // last tier the owner picked
};

// ============================================================================ icons (one line-art set)
// 20×20 grid, 1.6 stroke, round caps — the same hand as the shell's set (ui/dom.js). currentColor.
const I = {
  // one judgment → its consequences: a root dot that forks into three
  foresee: '<circle cx="4.2" cy="10" r="1.9"/><path d="M6.1 10h2.4c2.2 0 2.6-5.2 5.4-5.2h.6M8.5 10h5.9M8.5 10c2.2 0 2.6 5.2 5.4 5.2h.6"/><circle cx="16.3" cy="4.8" r="1.5"/><circle cx="16.3" cy="10" r="1.5"/><circle cx="16.3" cy="15.2" r="1.5"/>',
  hourglass: '<path d="M6 3.2h8M6 16.8h8"/><path d="M7 3.2c0 3.4 6 3.6 6 6.8s-6 3.4-6 6.8M13 3.2c0 3.4-6 3.6-6 6.8s6 3.4 6 6.8"/>',
  ahead: '<path d="M4.5 5.5 9 10l-4.5 4.5M10.5 5.5 15 10l-4.5 4.5"/>',
  half: '<circle cx="10" cy="10" r="5.8"/><path d="M10 4.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" stroke="none"/>',
  chain: '<path d="M8.4 11.6a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2l-.9.9"/><path d="M11.6 8.4a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l.9-.9"/>',
  target: '<circle cx="10" cy="10" r="6.2"/><circle cx="10" cy="10" r="2.4"/><path d="M10 1.8v3M10 15.2v3M1.8 10h3M15.2 10h3"/>',
  flag: '<path d="M5.5 17.5V3"/><path d="M5.5 3.6h8.2l-1.8 3 1.8 3H5.5"/>',
  market: '<path d="M3.5 16.5h13"/><path d="M5.5 13.5V9.8M9 13.5V6.8M12.5 13.5V8.6M16 13.5V4.5" />',
  calendar: '<rect x="3.5" y="4.6" width="13" height="11.9" rx="1.6"/><path d="M3.5 8.4h13M7 3v3M13 3v3"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  play: '<path d="M7 5.2v9.6l7.6-4.8z" fill="currentColor"/>',
  pause: '<path d="M7.4 5.4v9.2M12.6 5.4v9.2"/>',
  up: '<path d="M10 15.5v-11M5.8 8.6 10 4.4l4.2 4.2"/>',
  down: '<path d="M10 4.5v11M5.8 11.4 10 15.6l4.2-4.2"/>',
  ext: '<path d="M8 4.5H4.5v11h11V12"/><path d="M11 3.8h5.2V9M16 4 9.5 10.5"/>',
  chev: '<path d="M7.5 4.8 12.7 10l-5.2 5.2"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  back: '<path d="M12.5 4.8 7.3 10l5.2 5.2"/>',
  clock: '<circle cx="10" cy="10" r="6.6"/><path d="M10 6.2V10l2.6 1.8"/>',
  track: '<path d="M3.5 14.5 7.5 10l3 2.6 6-7"/><path d="M12.6 5.6h3.9v3.9"/>',
  anchor: '<path d="M3.5 16.5h13"/><path d="M5 16.5v-4h10v4M7.5 12.5v-4h5v4"/>',
  quote: '<path d="M4.5 10.5c0-3 1.5-4.6 3.8-5.2M4.5 10.5h3v4h-3zM11.5 10.5c0-3 1.5-4.6 3.8-5.2M11.5 10.5h3v4h-3z"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.8 10h6.4L14 6"/>',
  spring: '<path d="M10 17.2V9.8"/><path d="M10 11.4C10 8 7.6 6 4 6c0 3.4 2.4 5.4 6 5.4z"/><path d="M10 9.6c0-2.9 2.1-4.8 5.6-4.8 0 2.9-2.1 4.8-5.6 4.8z"/><path d="M6.4 17.2h7.2"/>',
  summer: '<circle cx="10" cy="10" r="3.3"/><path d="M10 2.4v1.9M10 15.7v1.9M2.4 10h1.9M15.7 10h1.9M4.6 4.6l1.35 1.35M14.05 14.05l1.35 1.35M4.6 15.4l1.35-1.35M14.05 5.95l1.35-1.35"/>',
  autumn: '<path d="M10 2.6l1.3 2.9 2.3-1.2-.4 3.4 2.9-.8-1.1 2.5 2.4 1-3.4 1.6.7 1.6-3.7-.6.3 2.7h-2.6l.3-2.7-3.7.6.7-1.6-3.4-1.6 2.4-1-1.1-2.5 2.9.8-.4-3.4 2.3 1.2z"/><path d="M10 15.7v2.4"/>',
  winter: '<path d="M10 2.8v14.4M3.8 6.4l12.4 7.2M3.8 13.6l12.4-7.2"/><path d="M8.2 4 10 5.6 11.8 4M8.2 16 10 14.4 11.8 16"/>',
  why: '<circle cx="10" cy="10" r="7"/><path d="M7.9 8.2a2.2 2.2 0 1 1 3.1 2c-.7.35-1 .85-1 1.5v.3"/><circle cx="10" cy="14.3" r=".6" fill="currentColor" stroke="none"/>',
  replay: '<path d="M4.2 10a5.8 5.8 0 1 0 1.7-4.1"/><path d="M4.2 3.6v3.2h3.2"/>',
};
function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', ('scn-i ' + cls).trim());
  s.innerHTML = I[name] || '';
  return s;
}

// ============================================================================ tiny DOM helper
function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
/** append, skipping null/false (Element.append would print "null") */
function add(el, ...kids) {
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c);
  return el;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const svgEl = (vb, cls, inner) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', vb);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ============================================================================ formatting
const pctProb = (p) => {
  if (p == null || !Number.isFinite(+p)) return '—';
  const v = +p * 100;
  if (v > 0 && v < 1) return v.toFixed(1) + '%';
  if (v > 99 && v < 100) return v.toFixed(1) + '%';
  return Math.round(v) + '%';
};
const pts = (d) => {
  if (d == null || !Number.isFinite(+d)) return null;
  const v = +d * 100;
  const a = Math.abs(v);
  const s = a < 1 ? a.toFixed(1) : String(Math.round(a));
  return (v > 0.05 ? '+' : v < -0.05 ? '−' : '±') + s;
};
function parseDay(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: m[3] ? +m[3] : null };
}
function dayDate(s, end = false) {
  const p = parseDay(s);
  if (!p) return null;
  if (p.d) return new Date(p.y, p.m - 1, p.d);
  return end ? new Date(p.y, p.m, 0) : new Date(p.y, p.m - 1, 1);
}
function cnDay(s, withYear = false) {
  const p = parseDay(s);
  if (!p) return s || '';
  const thisYear = new Date().getFullYear();
  const y = withYear || p.y !== thisYear ? `${p.y}年` : '';
  return p.d ? `${y}${p.m}月${p.d}日` : `${p.y}年${p.m}月`;
}
const today0 = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const daysTo = (d) => Math.round((d - today0()) / 864e5);
function ago(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  const d = Math.floor((today0() - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return cnDay(String(iso).slice(0, 10));
}
function tagKind(tag, pricedIn) {
  const s = String(tag || '');
  if (s.includes('时间差')) return 'gap';
  if (s.includes('抢跑')) return 'priced';
  if (s.includes('一部分')) return 'part';
  if (pricedIn == null) return 'gap';
  return pricedIn >= 0.7 ? 'priced' : pricedIn >= 0.4 ? 'part' : 'gap';
}
const TAG_TEXT = { gap: '时间差', part: '算进去一部分', priced: '已抢跑' };
const TAG_ICON = { gap: 'hourglass', part: 'half', priced: 'ahead' };
const stripEmoji = (s) => String(s || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?/gu, '').replace(/\s{2,}/g, ' ');

// ============================================================================ 为什么？ (§21, §24)
// One small button on every flow. It calls app.why(target, anchorEl) — ui/why.js shows the cached card at
// once or "老风派人去查了… 排队第 N" and then the reason card, in place. Without ui/why.js this file asks
// the server itself (POST /api/why → GET /api/why?id=) and draws the card in place; without that route it
// sends the scout (app.ask), whose answer lands at the same spot.
const whyStates = new Map();     // fallback only: target key → {state, card, error, ahead, id, at}
const whyKey = (t) => JSON.stringify(t);
const hostName = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
function agoShort(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  return s < 90 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : s < 86400 ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 86400)} 天前`;
}

/** §21 refusal words shared by every Claude button (ui/heartbeat.js app.budgetRefusal): {main, extra}. */
function refusalWords(app, r) {
  if (typeof app.budgetRefusal === 'function') { try { const t = app.budgetRefusal(r); if (t && t.main) return t; } catch (e) { /* fall through */ } }
  const main = String((r && r.error) || '').trim() || (app.budget?.outNote?.()) || '今天的额度用完了';
  return { main, extra: '' };
}

/** The one "为什么？" button. target = §24 why target ({kind, ids, …}); opts.host = the element the card goes
 *  into (default: right after the button's row); opts.question = what the scout asks when /api/why is missing. */
export function whyButton(app, target, { host = null, question = '', label = '为什么？', title = '' } = {}) {
  // the shell's own button (ui/why.js) is THE consistent one (§21): use it whenever it is there
  if (typeof app.whyButton === 'function') {
    try {
      const sb = app.whyButton(target, { label, title: title || undefined, cls: 'scn-why-shell' });
      if (sb instanceof Element) return sb;
    } catch (e) { console.warn('[why] app.whyButton', e); }
  }
  const b = h('button.scn-why', {
    type: 'button',
    title: title || '让老风派 Claude 去查原因（带来源；花今天的额度，查过的直接看）',
    onclick: (e) => { e.stopPropagation(); e.preventDefault(); askWhy(app, target, b, { host, question }); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); },
  }, label);
  b.dataset.whyKey = whyKey(target);
  // a re-rendered drawer/panel gets its fallback card back
  const st = whyStates.get(whyKey(target));
  if (st && typeof app.why !== 'function') requestAnimationFrame(() => { if (b.isConnected) drawWhy(app, target, b, host, st); });
  return b;
}

export async function askWhy(app, target, anchor, { host = null, question = '', force = false } = {}) {
  if (typeof app.why === 'function' && !force) {
    try { return await app.why(target, anchor); } catch (e) { console.warn('[why] app.why', e); }
  }
  const key = whyKey(target);
  let st = whyStates.get(key);
  if (st && !force && (st.state === 'queued' || st.state === 'running' || st.state === 'done' || st.state === 'cached')) {
    st.open = true;
    drawWhy(app, target, anchor, host, st);
    return st;
  }
  st = { state: 'sending', open: true, at: null, card: st && st.card };
  whyStates.set(key, st);
  drawWhy(app, target, anchor, host, st);
  let r = null;
  try {
    const res = await fetch('api/why', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, force: !!force }) });
    r = await res.json().catch(() => null);
    if ((res.status === 404 || res.status === 501) && (!r || /not found|没有这个接口/.test(String(r.error || '')))) r = { missing: true };
    else if (!r) r = { error: `服务器返回 ${res.status}` };
  } catch (e) { r = { offline: true, error: '连不上服务器' }; }
  if (r.missing || r.offline) {
    // no 为什么 engine: the scout goes instead, and its answer lands right here
    whyStates.delete(key);
    clearWhy(anchor, host);
    if (typeof app.ask === 'function' && question) { app.ask('ask', (target.ids || [])[0] || null, question); return null; }
    app.toast?.(r.offline ? '要用 python3 server.py 打开本页才能查原因' : '「为什么」还没接到服务器上');
    return null;
  }
  if (r.refused === 'budget' || r.state === 'refused' || /额度/.test(String(r.error || ''))) {
    const t = refusalWords(app, r);
    Object.assign(st, { state: 'refused', error: t.main, extra: t.extra });
  } else if (r.error && !r.id) {
    Object.assign(st, { state: 'error', error: r.error });
  } else {
    Object.assign(st, { id: r.id, state: r.state || 'queued', card: r.card || null, ahead: r.ahead ?? r.position ?? null, t0: Date.now() });
    if (st.card) st.state = 'done';
  }
  drawWhy(app, target, anchor, host, st);
  if (st.state === 'queued' || st.state === 'running') pollWhy(app, target, anchor, host, st);
  return st;
}

async function pollWhy(app, target, anchor, host, st) {
  while (st.state === 'queued' || st.state === 'running') {
    await new Promise((r) => setTimeout(r, document.hidden ? 6000 : 2500));
    if (whyStates.get(whyKey(target)) !== st) return;
    let r = null;
    try { r = await (await fetch('api/why?id=' + encodeURIComponent(st.id), { cache: 'no-store' })).json(); } catch (e) { r = null; }
    if (!r) continue;
    st.ahead = r.ahead ?? r.position ?? st.ahead;
    if (r.card) { st.card = r.card; st.state = 'done'; }
    else if (r.state === 'error' || r.state === 'failed' || r.state === 'invalid' || r.error) { st.state = 'error'; st.error = r.error || '没查成'; }
    else if (r.state) st.state = r.state;
    if (Date.now() - st.t0 > 15 * 60_000 && st.state !== 'done') { st.state = 'error'; st.error = '等太久了'; }
    // the latest button for this target (the drawer may have re-rendered)
    const live = anchor.isConnected ? anchor : document.querySelector(`.scn-why[data-why-key="${CSS.escape(whyKey(target))}"]`) || anchor;
    drawWhy(app, target, live, host && host.isConnected ? host : null, st);
  }
  if (st.state === 'done') app.emit?.('whyDone', { target, card: st.card });
}

function clearWhy(anchor, host) {
  const box = whyBoxOf(anchor, host, false);
  if (box) box.remove();
}
/** The card lives at the end of the button's [data-why-host] (a landing row, a market card), else right
 *  after the button's own row. */
function whyBoxOf(anchor, host, create = true) {
  const mk = () => h('div.scn-whycard', { role: 'status', 'aria-live': 'polite' });
  const hostEl = (host && host.isConnected ? host : null) || anchor.closest('[data-why-host]');
  if (hostEl) {
    let box = [...hostEl.children].find((c) => c.classList.contains('scn-whycard'));
    if (!box && create) { box = mk(); hostEl.append(box); }
    return box || null;
  }
  const row = anchor.parentElement;
  if (!row) return null;
  const nx = row.nextElementSibling;
  let box = nx && nx.classList.contains('scn-whycard') ? nx : null;
  if (!box && create) { box = mk(); row.after(box); }
  return box;
}

function drawWhy(app, target, anchor, host, st) {
  anchor.dataset.whyKey = whyKey(target);
  anchor.classList.toggle('on', !!st.open);
  const box = whyBoxOf(anchor, host);
  if (!box) return;
  if (!st.open) { box.remove(); return; }
  const close = h('button.scn-whycard-x', { type: 'button', title: '收起', 'aria-label': '收起', onclick: (e) => { e.stopPropagation(); st.open = false; anchor.classList.remove('on'); box.remove(); } }, icon('close'));
  const kids = [];
  if (st.state === 'sending' || st.state === 'queued' || st.state === 'running') {
    const q = st.state === 'queued' && st.ahead != null ? (st.ahead > 0 ? ` 排队第 ${st.ahead + 1}` : ' 下一个就是它') : '';
    kids.push(h('div.scn-whycard-wait', h('span.scn-dots', h('i'), h('i'), h('i')),
      h('span', st.state === 'running' ? '老风派人去查了… 正在翻新闻' : `老风派人去查了…${q}`), close));
  } else if (st.state === 'refused' || st.state === 'error') {
    kids.push(h('div.scn-whycard-wait.bad', h('span', st.state === 'refused' ? st.error : `没查成：${st.error || ''}`), close));
    if (st.state === 'refused' && st.extra) kids.push(h('p.scn-whycard-honest', st.extra));
    if (st.state === 'error') kids.push(h('button.scn-link', { type: 'button', onclick: (e) => { e.stopPropagation(); askWhy(app, target, anchor, { host, force: true }); } }, '再查一次'));
  } else if (st.card) {
    const c = st.card;
    const reasons = (c.reasons || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    kids.push(h('div.scn-whycard-top', h('p.scn-whycard-say', (app.say ? app.say(c, 'say') : c.say) || c.say || ''), close));
    if (reasons.length) {
      kids.push(h('ol.scn-reasons', reasons.slice(0, 4).map((x) => h('li',
        h('p', x.text),
        h('div.scn-reason-meta',
          x.date ? h('span', cnDay(x.date)) : null,
          x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.url }, x.source || hostName(x.url)) : x.source ? h('span', x.source) : null,
          x.type === 'rumor' ? h('span.scn-reason-rumor', '传闻') : null,
          typeof x.conf === 'number' ? h('span.scn-reason-conf', { title: `把握约 ${Math.round(x.conf * 100)}%` }, [0, 1, 2].map((k) => h('i' + (k < (x.conf >= 0.75 ? 3 : x.conf >= 0.5 ? 2 : 1) ? '.on' : '')))) : null)))));
    }
    if (c.honest && (!reasons.length || /没有|不明|找不到/.test(c.honest))) kids.push(h('p.scn-whycard-honest', c.honest));
    if ((c.counter || []).length) kids.push(h('div.scn-whycard-kv', h('span', '反方'), h('p', c.counter.slice(0, 2).map((x) => (typeof x === 'string' ? x : x.text)).join('；'))));
    if ((c.watch || []).length) kids.push(h('div.scn-whycard-kv', h('span', '接下来盯'), h('p', c.watch.slice(0, 2).map((x) => (typeof x === 'string' ? x : `${x.by ? cnDay(x.by) + '前' : ''}${x.what || ''}`)).join('；'))));
    kids.push(h('div.scn-whycard-foot',
      h('span', `${agoShort(c.at) || ''}查的${c.asOf ? ' · 数据 ' + cnDay(c.asOf) : ''}`),
      h('button.scn-link', { type: 'button', title: '重新派人去查（花额度）', onclick: (e) => { e.stopPropagation(); askWhy(app, target, anchor, { host, force: true }); } }, icon('replay'), '重新查')));
  }
  box.replaceChildren(...kids);
}

// ============================================================================ the module
export function init(app) {
  ensureCss();
  const D = () => app.data || app.D || {};
  const planet = () => app.planet || null;
  const nodeById = (id) => { try { return D().nodeById?.(id) || null; } catch (e) { return null; } };
  const pathIds = (id) => { try { return D().pathIds?.(id) || null; } catch (e) { return null; } };
  const nameOf = (id) => nodeById(id)?.name || String(id).replace(/^s:/, '');
  const theme = () => (app.state && app.state.theme) || document.documentElement.dataset.theme || 'day';
  const voice = () => (app.state && app.state.voice) || 'sharp';
  /** voice-aware text: sharp → obj[key], mild → obj[key + 'Mild'] when there is one */
  const say = (o, k = 'say') => {
    if (!o) return '';
    if (typeof app.say === 'function') { try { return app.say(o, k) || ''; } catch (e) { /* fall through */ } }
    return (voice() === 'mild' && o[k + 'Mild']) || o[k] || '';
  };
  const refreshPanel = () => { try { (app.panel?.refresh || app.panel?.rerender)?.(); } catch (e) { /* optional */ } };

  const S = {
    result: null,      // the scenario being shown
    stage: 'now',
    playing: 0,
    job: null,         // {id, text, date, tier, stage, state, error, t0}
    pollT: 0,
    saved: null,       // list from the server (or fallback)
    expanded: new Set(),
    openLanding: null,
    factor: null,      // landing filter by 因子
    lastNodeId: null,
  };
  const roots = new Set();   // my top-level elements (theme attribute lives on them)
  const scoped = (el) => { el.classList.add('scn-scope'); el.dataset.theme = theme(); roots.add(el); return el; };

  // ------------------------------------------------------------------ entry point in the top bar
  let tbBtn = null;
  const tbSpec = {
    id: 'scenario', icon: 'scenario', label: '推演', order: 30,
    title: '推演：如果我的判断成真，天气图会怎么变？',
    onClick: () => onTopbar(),
  };
  if (app.topbar && typeof app.topbar.addButton === 'function') {
    try {
      tbBtn = app.topbar.addButton(tbSpec);
      // our own glyph (a judgment forking into consequences) in the shell's line style
      const sv = tbBtn instanceof Element ? tbBtn.querySelector('svg') : null;
      if (sv) { sv.setAttribute('viewBox', '0 0 20 20'); sv.innerHTML = I.foresee; }
      else if (tbBtn instanceof Element) { tbBtn.querySelector('.ic')?.replaceChildren(icon('foresee')); }
    } catch (e) { console.warn('[scenario] topbar.addButton', e); }
  } else {
    const host = document.getElementById('topbar');
    if (host) {
      tbBtn = h('button.scn-tb-fallback', { type: 'button', title: tbSpec.title, onclick: tbSpec.onClick }, icon('foresee'), h('span', '推演'));
      host.append(scoped(tbBtn));
    }
  }
  const setBadge = (txt, tone = null) => { try { app.topbar?.setBadge?.('scenario', txt, tone); } catch (e) { /* optional */ } };
  const syncBadge = () => {
    if (S.job && (S.job.state === 'queued' || S.job.state === 'running' || S.job.state === 'starting')) return setBadge(' ', 'info');
    if (S.job && S.job.state === 'done' && S.job.result) return setBadge(' ', 'ok');
    if (S.job && S.job.state === 'error') return setBadge('!', 'bad');
    const due = (S.saved || []).reduce((n, x) => n + (typeof x.due === 'number' ? x.due : (x.track?.due || []).length || 0), 0);
    setBadge(due ? String(due) : null, due ? 'warn' : null);
  };

  function onTopbar() {
    if (S.job && S.job.state === 'done' && S.job.result && !S.result) { const r = S.job.result; S.job = null; syncBadge(); enter(r, { fly: true }); return; }
    openComposer();
  }

  // ================================================================== composer + progress dialog
  let dlg = null;
  const onDlgKey = (e) => {
    if (!dlg || e.key !== 'Escape') return;
    e.preventDefault();
    closeComposer();
  };
  function closeComposer() {
    if (!dlg) return;
    const d = dlg; dlg = null;
    d.classList.remove('on', 'mw-modal-open');
    removeEventListener('keydown', onDlgKey);
    setTimeout(() => d.remove(), 220);
    roots.delete(d);
  }

  function openComposer(prefill = null) {
    if (dlg) { renderDialog(prefill); return; }
    // .mw-modal-open: the shell leaves the keyboard alone while it is up
    dlg = scoped(h('div.scn-modal.mw-modal-open', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '推演',
      onmousedown: (e) => { if (e.target === dlg) closeComposer(); } }));
    document.body.append(dlg);
    addEventListener('keydown', onDlgKey);
    renderDialog(prefill);
    requestAnimationFrame(() => dlg && dlg.classList.add('on'));
    loadSaved().then(() => { if (dlg && !(S.job && S.job.state !== 'done')) renderDialog(null, true); });
  }

  const form = { text: '', date: '', tier: store.get(LS.last, '') || '' };

  function renderDialog(prefill = null, keep = false) {
    if (!dlg) return;
    if (prefill) Object.assign(form, prefill);
    if (keep) {
      // only refresh the saved list, keep whatever the owner is typing
      const old = dlg.querySelector('.scn-saved-host');
      if (old) old.replaceWith(savedBlock('dialog'));
      return;
    }
    const busy = S.job && (S.job.state === 'queued' || S.job.state === 'running' || S.job.state === 'starting');
    const card = h('div.scn-sheet', busy || (S.job && S.job.state === 'error') ? progressView() : composerView());
    dlg.replaceChildren(card);
    const ta = dlg.querySelector('textarea');
    if (ta) setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 60);
    else setTimeout(() => dlg?.querySelector('.scn-sheet button')?.focus({ preventScroll: true }), 60);
  }

  function composerView() {
    const ta = h('textarea.scn-input', {
      rows: 3, maxlength: 600, spellcheck: 'false',
      placeholder: '写一句带日期、到时候能核对的话。\n例：2026 年 11 月基本实现 RSI，AI 开始自己做 AI 研究',
      oninput: (e) => { form.text = e.target.value; go.disabled = !form.text.trim(); },
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      },
    });
    ta.value = form.text || '';
    const now = new Date();
    const minMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = h('input.scn-month', { type: 'month', min: minMonth, value: (form.date || '').slice(0, 7),
      onchange: (e) => { form.date = e.target.value; clr.hidden = !form.date; } });
    const clr = h('button.scn-link.scn-clear', { type: 'button', onclick: () => { form.date = ''; month.value = ''; clr.hidden = true; } }, '清空');
    clr.hidden = !form.date;
    const hintFor = (k) => { const t = TIERS.find((x) => x.k === k); return t ? t.sub : '不选＝让老风按你的原话判断档位'; };
    const tierHint = h('div.scn-hint', hintFor(form.tier));
    const tiers = h('div.scn-seg', { role: 'radiogroup', 'aria-label': '强度' },
      TIERS.map((t) => h('button.scn-seg-b' + (form.tier === t.k ? '.on' : ''), {
        type: 'button', role: 'radio', 'aria-checked': String(form.tier === t.k), title: t.sub,
        onclick: (e) => {
          form.tier = form.tier === t.k ? '' : t.k;
          for (const b of tiers.children) { const on = b.dataset.k === form.tier; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
          tierHint.textContent = hintFor(form.tier);
          e.currentTarget.blur();
        },
        dataset: { k: t.k },
      }, h('b', t.k), h('span', t.name))));
    const go = h('button.scn-primary', { type: 'button', onclick: () => submit(), disabled: !form.text.trim() },
      icon('foresee'), h('span', '开始推演'));

    return [
      h('header.scn-sheet-h',
        h('div.scn-kicker', icon('foresee'), '推演'),
        h('h2.scn-sheet-title', '如果你的判断成真，天气图会怎么变？'),
        h('button.scn-x', { type: 'button', title: '关掉（Esc）', 'aria-label': '关掉', onclick: closeComposer }, icon('close'))),
      h('p.scn-lede', '老风按四个问题往下推：', h('b', '谁要多买什么 · 谁省了钱 · 谁收到钱 · 谁的生意没了'),
        '，再找出', h('em', '市场还没按你的日期算'), '的地方。'),
      h('label.scn-field', h('span.scn-label', '你的判断'), ta),
      h('div.scn-examples', h('span.scn-label-s', '试试'),
        EXAMPLES.map((x) => h('button.scn-chip', { type: 'button', title: '填进去',
          onclick: () => { form.text = x.text; form.date = x.date; form.tier = x.tier; renderDialog(); } }, x.text))),
      h('div.scn-row',
        h('label.scn-field.scn-field-date', h('span.scn-label', '日期', h('span.scn-label-opt', '可不填')), h('div.scn-inline', month, clr),
          h('div.scn-hint', '不填，老风会从原话里找')),
        h('div.scn-field.scn-field-tier', h('span.scn-label', '强度'), tiers, tierHint)),
      h('footer.scn-sheet-f',
        h('div.scn-cost', icon('clock'), '大约 1–2 分钟 · 用你自己的 Claude 额度'),
        h('div.scn-actions', h('button.scn-ghost', { type: 'button', onclick: closeComposer }, '取消'), go)),
      savedBlock('dialog'),
    ];
  }

  function progressView() {
    const j = S.job;
    const err = j.state === 'error';
    const stageText = String(j.stage || '排队');
    let k = STAGES_TEXT.findIndex((s) => stageText.startsWith(s));
    if (k < 0) k = j.state === 'running' ? 3 : 0;
    const steps = [
      { t: '读地图', d: '今天每块地的季节、风和拥挤度' },
      { t: '找预言市场', d: '有没有人在 Polymarket 上押同一件事' },
      { t: '推演', d: '四个问题往下推，AI 在想，约 1–2 分钟' },
      { t: '算时间差', d: '每个落点已经被算进去多少、价格要了多少' },
    ];
    const cur = clamp(k - 1, 0, 4);  // 排队 → before step 0
    return [
      h('header.scn-sheet-h',
        h('div.scn-kicker', icon('foresee'), err ? (j.refused ? '额度不够，没开始推演' : '推演没成') : '正在推演…'),
        h('h2.scn-sheet-title.scn-quote', `「${j.text}」`),
        h('button.scn-x', { type: 'button', title: err ? '关掉' : '放到后台', 'aria-label': '关掉', onclick: closeComposer }, icon('close'))),
      (j.date || j.tier || (j.state === 'queued' && j.ahead != null)) ? h('div.scn-meta-row',
        j.date ? h('span.scn-pill', cnDay(j.date, true)) : null, j.tier ? h('span.scn-pill', j.tier + '档') : null,
        j.state === 'queued' && j.ahead != null ? h('span.scn-pill.fuji', j.ahead > 0 ? `排队中，前面还有 ${j.ahead} 个` : '下一个就轮到它') : null) : null,
      err ? (j.refused ? h('div.scn-error.refused', h('b', j.error), j.extra ? h('small.scn-error-extra', j.extra) : null)
        : h('div.scn-error', h('b', '出错了：'), j.error || '推演中断了')) : h('div.scn-wind', windLines()),
      h('ol.scn-steps', steps.map((s, i) => h('li' + (i < cur || (k >= 5) ? '.done' : i === cur && !err ? '.now' : ''),
        h('span.scn-step-dot'), h('span.scn-step-t', s.t), h('span.scn-step-d', s.d)))),
      h('footer.scn-sheet-f',
        h('div.scn-cost', icon('clock'), err ? '' : h('span.scn-elapsed', elapsedText(j))),
        h('div.scn-actions',
          err ? h('button.scn-ghost', { type: 'button', onclick: () => { S.job = null; syncBadge(); renderDialog(); } }, '改一改再试')
            : h('button.scn-ghost', { type: 'button', onclick: closeComposer }, '放到后台，好了告诉我'),
          err ? h('button.scn-primary', { type: 'button', onclick: () => { const t = S.job; S.job = null; form.text = t.text; form.date = t.date || ''; form.tier = t.tier || ''; submit(); } }, '再推一次') : null)),
    ];
  }
  const elapsedText = (j) => {
    const s = Math.max(0, Math.round(j.elapsed != null ? j.elapsed + (Date.now() - j.seenAt) / 1000 : (Date.now() - j.t0) / 1000));
    return s < 60 ? `已经 ${s} 秒` : `已经 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  };
  const windLines = () => svgEl('0 0 240 44', 'scn-windsvg',
    '<path d="M8 14h120c14 0 18-10 10-12" /><path d="M30 26h150c16 0 20 12 10 14" /><path d="M70 36h90" /><path d="M150 18h70c10 0 12-8 6-10" />');

  async function submit() {
    const text = (form.text || '').trim();
    if (!text) return;
    store.set(LS.last, form.tier || '');
    S.job = { id: null, text, date: form.date || null, tier: form.tier || null, state: 'starting', stage: '排队', t0: Date.now(), seenAt: Date.now() };
    renderDialog();
    syncBadge();
    let r;
    try {
      const res = await fetch('api/scenario', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, date: form.date || null, tier: form.tier || null }),
      });
      if (res.status === 404 || res.status === 501) throw Object.assign(new Error('no-route'), { code: 'no-route' });
      r = await res.json().catch(() => ({}));
      if (!res.ok && !r.error) r.error = res.status === 503 ? '推演模块还没装好' : `服务器返回 ${res.status}`;
    } catch (e) {
      r = { error: e.code === 'no-route' ? '推演引擎还没接到服务器上（重启一下 python3 server.py）。下面以前的推演可以先看。'
        : '连不上服务器：推演要用 python3 server.py 打开本页。' };
    }
    const id = r && (r.id || r.jobId);
    if (!id || r.error || r.started === false) {
      const out = r.refused === 'budget' || r.state === 'refused' || /额度/.test(String(r.error || ''));
      // §21: the gateway's own sentence + one line from /api/budget — the same words as every other Claude button
      const t = out ? refusalWords(app, r) : null;
      S.job = { ...S.job, state: 'error', error: t ? t.main : r.error || '没拿到推演编号', extra: t ? t.extra : '', refused: out };
      syncBadge();
      renderDialog();
      return;
    }
    S.job.id = id;
    S.job.state = 'queued';
    remember(id);
    poll();
  }

  async function poll() {
    clearTimeout(S.pollT);
    const j = S.job;
    if (!j || !j.id) return;
    let st = null;
    try {
      const res = await fetch('api/scenario?id=' + encodeURIComponent(j.id), { cache: 'no-store' });
      st = await res.json();
    } catch (e) { st = null; }
    if (S.job !== j) return;
    if (st) {
      j.state = st.state || j.state;
      j.stage = st.stage || j.stage;
      if (st.elapsed != null) { j.elapsed = st.elapsed; j.seenAt = Date.now(); }
      j.ahead = typeof st.ahead === 'number' ? st.ahead : typeof st.position === 'number' ? st.position - 1 : null;
      if (st.state === 'error') j.error = st.error || '推演中断了';
    }
    if (j.state === 'done') {
      let res = st && st.result;
      if (!res) res = await fetchResult(j.id);
      if (!res) { j.state = 'error'; j.error = '推演完成了，但读不到结果'; renderDialog(); syncBadge(); return; }
      S.saved = null; savedP = null;
      app.emit?.('claudeSpent', { kind: 'scenario', id: j.id });
      if (dlg) { closeComposer(); S.job = null; syncBadge(); enter(res, { fly: true }); }
      else { j.result = res; syncBadge(); app.toast?.(`推演好了：${res.title || j.text}。点「推演」看。`, 5000); }
      loadSaved(true).then(syncBadge);
      return;
    }
    if (j.state === 'error') { syncBadge(); renderDialog(); return; }
    if (dlg) {
      const el = dlg.querySelector('.scn-elapsed');
      // re-render the steps only when the stage moved, keep the elapsed clock ticking
      const k = `${j.stage}|${j.state}|${j.ahead ?? ''}`;
      if (dlg.dataset.stage !== k) { dlg.dataset.stage = k; renderDialog(); }
      else if (el) el.textContent = elapsedText(j);
    }
    S.pollT = setTimeout(poll, document.hidden ? 5000 : 1500);
  }
  // keep the clock alive between polls
  setInterval(() => { if (dlg && S.job && S.job.state !== 'error') { const el = dlg.querySelector('.scn-elapsed'); if (el) el.textContent = elapsedText(S.job); } }, 1000);

  async function fetchResult(id) {
    try {
      const res = await fetch('api/scenario?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (res.ok) { const st = await res.json(); if (st && st.result) return st.result; if (st && st.landing) return st; }
    } catch (e) { /* try the file */ }
    try {
      const res = await fetch('data/scenarios/' + encodeURIComponent(id) + '.json', { cache: 'no-cache' });
      if (res.ok) return await res.json();
    } catch (e) { /* none */ }
    return null;
  }

  // ================================================================== saved scenarios
  function remember(id) {
    const seen = store.get(LS.seen, []).filter((x) => x !== id);
    seen.unshift(id);
    store.set(LS.seen, seen.slice(0, 30));
  }
  function forget(id) { store.set(LS.seen, store.get(LS.seen, []).filter((x) => x !== id)); }
  let savedP = null;
  function loadSaved(force = false) {
    if (savedP && !force) return savedP;
    savedP = (async () => {
      let list = null;
      try {
        const res = await fetch('api/scenarios', { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          list = Array.isArray(j) ? j : (j.scenarios || j.items || null);
        }
      } catch (e) { list = null; }
      if (!list) {
        // static mode: the engine keeps an index next to the results
        try {
          const res = await fetch('data/scenarios/index.json', { cache: 'no-cache' });
          if (res.ok) { const j = await res.json(); list = Array.isArray(j) ? j : j.scenarios || null; }
        } catch (e) { list = null; }
      }
      if (!list) {
        const ids = store.get(LS.seen, []);
        const got = await Promise.all(ids.slice(0, 12).map((id) => fetchResult(id).catch(() => null)));
        list = got.filter(Boolean).map((r) => ({ id: r.id, state: 'done', title: r.title, headline: r.headline, root: r.root,
          createdAt: r.createdAt, asOf: r.asOf, track: r.track, landing: (r.landing || []).slice(0, 3) }));
      }
      S.saved = list;
      syncBadge();
      return list;
    })().catch(() => (S.saved = []));
    setTimeout(() => { savedP = null; }, 30_000);
    return savedP;
  }

  /** trading days the tracking really covers. A 盘中 (partial) last bar is not a finished day: while meta.partial
   *  is the tracking's last day it does not count (unless track.py already left it out). → {days, partial} */
  const TRACK_MIN_DAYS = 5;
  function trackDays(t) {
    if (!t || t.days == null) return null;
    const p = (app.meta && app.meta.partial) || null;
    const skipped = t.partialSkipped === true || t.skipPartial === true || t.partialExcluded === true || (t.partial && typeof t.partial === 'object');
    const partial = !!(p && p.date && t.asOf && t.asOf === p.date && !skipped);
    return { days: Math.max(0, (+t.days || 0) - (partial ? 1 : 0)), partial: partial ? p.date : null };
  }

  function trackPill(t, due = 0) {
    if (due) return h('span.scn-track.due', { title: '认错线到日子了，去核对' }, icon('flag'), `${due} 条到期`);
    if (!t) return h('span.scn-track.none', { title: '数据更新后会自动核对' }, '待核对');
    if (t.days == null) return h('span.scn-track.none', { title: t.say || '' }, '太老了');
    const td = trackDays(t);
    if (!td.days || td.days < TRACK_MIN_DAYS || t.rate == null) return h('span.scn-track.none', { title: t.say || '' }, td.days ? `${td.days} 天 · 太早` : td.partial ? '盘中 · 太早' : '刚推演');
    const r = Math.round(t.rate * 100);
    return h('span.scn-track' + (r >= 60 ? '.good' : r <= 40 ? '.bad' : '.mid'), { title: t.say || '' },
      icon('track'), `${r}%`, h('small', ` · ${t.days} 天`));
  }

  function savedBlock(where) {
    const list = (S.saved || []).filter((x) => !S.result || x.id !== S.result.id);
    const host = h('div.scn-saved-host');
    if (!list.length) return host;
    const max = where === 'panel' ? 3 : 4;
    const open = S.expanded.has('saved-' + where);
    const shown = open ? list : list.slice(0, max);
    add(host,
      where === 'panel' ? null : h('div.scn-sub-h', h('span', where === 'drawer' ? '别的推演' : '我的推演'), h('span.scn-sub-hint', '跟踪：自推演那天起，落点有没有按方向走')),
      h('ul.scn-saved', shown.map((x) => {
        const running = x.state === 'queued' || x.state === 'running';
        const rt = x.root || {};
        const land = x.landing || x.top || [];
        const due = typeof x.due === 'number' ? x.due : (x.track?.due || []).length;
        return h('li.scn-saved-i' + (running ? '.running' : x.state === 'error' ? '.err' : ''), {
          tabindex: 0, role: 'button', title: running ? '还在推演' : '打开这个推演',
          onclick: () => openSaved(x), onkeydown: (e) => { if (e.key === 'Enter') openSaved(x); },
        },
        h('div.scn-saved-top',
          h('span.scn-saved-title', x.title || (rt.text || '').slice(0, 20)),
          running ? h('span.scn-track.none', '推演中…') : x.state === 'error' ? h('span.scn-track.bad', '没成') : trackPill(x.track, due)),
        h('div.scn-saved-root', rt.text || say(x, 'headline') || ''),
        h('div.scn-saved-meta',
          rt.date ? h('span', cnDay(rt.date, true)) : null, rt.tier ? h('span', rt.tier + '档') : null,
          x.createdAt ? h('span', ago(x.createdAt)) : null,
          land.length ? h('span.scn-saved-land', '落点：' + land.slice(0, 3).map((l) => l.name).join('、')) : null));
      })),
      list.length > max ? h('button.scn-more', { type: 'button', onclick: () => { open ? S.expanded.delete('saved-' + where) : S.expanded.add('saved-' + where); rerenderSaved(where); } },
        open ? '收起' : `展开更多（还有 ${list.length - max} 个）`) : null);
    return host;
  }
  function rerenderSaved(where) {
    if (where === 'dialog') renderDialog(null, true);
    else if (where === 'drawer') renderDrawerSaved();
    else refreshPanel();
  }

  async function openSaved(x) {
    if (x.state === 'queued' || x.state === 'running') {
      S.job = { id: x.id, text: x.root?.text || x.title || '', date: x.root?.date, tier: x.root?.tier, state: x.state, stage: x.stage, t0: Date.now(), seenAt: Date.now() };
      openComposer(); poll(); return;
    }
    const r = await fetchResult(x.id);
    if (!r) { app.toast?.('这个推演读不出来了'); return; }
    closeComposer();
    enter(r, { fly: true });
  }

  async function removeScenario(r) {
    if (!r || !window.confirm(`删掉推演「${r.title || r.id}」？删了就看不到它的跟踪了。`)) return;
    let ok = false;
    try {
      const res = await fetch('api/scenario?id=' + encodeURIComponent(r.id), { method: 'DELETE', cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      ok = res.ok && (j.deleted > 0 || j.ok);
      if (!ok) app.toast?.(j.error || '没删掉（要用 server.py 打开本页）');
    } catch (e) { app.toast?.('没删掉：连不上服务器'); }
    if (!ok) return;
    forget(r.id);
    exit();
    S.saved = null;
    loadSaved(true).then(() => refreshPanel());
    app.toast?.('删掉了');
  }

  // ================================================================== scenario mode
  let bar = null, drawer = null, badgeLayer = null, badgeRaf = 0;

  function enter(result, { fly = false, stage = null, autoplay = !stage } = {}) {
    if (!result || !result.nodes) { app.toast?.('这个推演的结果不完整'); return; }
    stopPlay();
    S.result = result;
    S.stage = stage || firstStage(result);
    S.openLanding = null;
    S.factor = null;
    S.expanded.clear();
    remember(result.id);
    document.body.classList.add('scn-mode');
    if (document.body.classList.contains('panel-closed')) { try { app.setPanelOpen?.(true); } catch (e) { /* optional */ } }
    try { if (app.state?.view === 'stock') app.closeStock?.(); } catch (e) { /* optional */ }
    // the future weather starts from today's map: leave a time-machine date in the past behind
    try {
      if (app.lastIdx != null && app.state?.dateIndex !== app.lastIdx && typeof app.setDate === 'function') {
        app.setDate(app.lastIdx); app.settleDate?.();
      }
    } catch (e) { /* optional */ }
    buildBar();
    buildDrawer();
    applyOverlay();
    app.emit?.('scenario', { active: true, result, stage: S.stage });
    // a fresh result reads best where its top landing spots meet: their deepest common planet
    // (e.g. all three inside 美股 → fly into 美股; spread over continents → the world)
    if (fly) {
      const target = focusPath(result);
      const cur = app.state?.path || [];
      const same = target && target.length === cur.length && target.every((x, k) => x === cur[k]);
      if (target && !same) { try { app.flyTo?.(target); } catch (e) { /* ignore */ } }
    }
    loadSaved().then(() => drawer && renderDrawerSaved());
    // walk through the stages once, so the order (what moves first, what follows) is seen, ending on everything lit
    if (autoplay) setTimeout(() => { if (S.result === result && !S.playing) play(LAGS.indexOf(S.stage)); }, 1600);
  }

  function exit() {
    if (!S.result) return;
    stopPlay();
    S.result = null;
    document.body.classList.remove('scn-mode');
    try { planet()?.setOverlay?.('scenario', null); } catch (e) { console.warn('[scenario] setOverlay', e); }
    for (const el of [bar, drawer]) if (el) { el.classList.remove('on'); const e2 = el; setTimeout(() => e2.remove(), 300); roots.delete(el); }
    bar = drawer = null;
    clearBadges();
    try {
      if (typeof app.settleDate === 'function') app.settleDate();
      else { app.applyOverlays?.(); planet()?.setOverlay?.('channel', 'auto'); planet()?.setOverlay?.('numbers', 'auto'); planet()?.setOverlay?.('seasons', 'auto'); }
    } catch (e) { console.warn('[scenario] restore', e); }
    app.emit?.('scenario', { active: false });
    refreshPanel();
  }

  function focusPath(r) {
    const rootId = typeof app.rootId === 'function' ? app.rootId() : 'world';
    const tops = (r.landing || []).slice(0, 3).map((l) => l.pathIds || pathIds(l.id)).filter((p) => Array.isArray(p) && p.length > 1);
    if (!tops.length) return [rootId];
    let common = tops[0].slice(0, -1);
    for (const p of tops.slice(1)) {
      let k = 0;
      while (k < common.length && k < p.length - 1 && common[k] === p[k]) k++;
      common = common.slice(0, k);
    }
    if (!common.length || common[0] !== rootId) return [rootId];
    return common;
  }

  function firstStage(r) {
    // open on the first stage that has something to show
    for (const k of LAGS) if ((r.stages?.[k] || []).length) return k;
    return 'now';
  }

  function currentNode() {
    try { if (typeof app.currentNode === 'function') return app.currentNode(); } catch (e) { /* fall through */ }
    const id = app.state?.nodeId || (app.state?.path || []).slice(-1)[0] || 'world';
    return nodeById(id);
  }

  function epicenters(r) {
    if (Array.isArray(r.epicenters) && r.epicenters.length) return r.epicenters.slice(0, 4);
    const first = new Set((r.chain?.[0]?.nodes) || []);
    return Object.entries(r.nodes)
      .filter(([id, n]) => n.source === 'direct' && (n.order === 1 || first.has(id)))
      .sort((a, b) => Math.abs(b[1].impact) - Math.abs(a[1].impact))
      .slice(0, 4).map(([id]) => id);
  }

  function overlayData() {
    const r = S.result;
    const nodes = {};
    for (const [id, n] of Object.entries(r.nodes)) {
      nodes[id] = { impact: n.impact, dir: n.dir, lag: n.lag, order: n.order, pricedIn: n.pricedIn, gap: n.gap,
        inferred: !!n.inferred || n.source === 'inferred', source: n.source, tag: TAG_TEXT[tagKind(n.tag, n.pricedIn)] };
    }
    // down to the stocks: inside a landing region every stock carries the region's impact; its own
    // 抢跑度 when the engine measured it, else the region's (then marked inferred — an estimate, §14)
    for (const [id, n] of Object.entries(r.nodes)) {
      if (n.source === 'aggregated') continue;
      const kids = (nodeById(id)?.children || []).filter((c) => c.kind === 'stock' || String(c.id).startsWith('s:'));
      if (!kids.length) continue;
      const land = (r.landing || []).find((l) => l.id === id);
      const known = new Map((land?.stocks || []).map((st) => [st.id || 's:' + st.ticker, st]));
      for (const c of kids) {
        if (nodes[c.id]) continue;
        const st = known.get(c.id);
        const imp = +(n.impact * 0.9).toFixed(2);
        const pi = st && st.pricedIn != null ? st.pricedIn : n.pricedIn;
        nodes[c.id] = { impact: imp, dir: n.dir, lag: n.lag, order: (n.order || 1) + 1, pricedIn: pi,
          gap: +(Math.abs(imp) * (1 - (pi || 0))).toFixed(2), inferred: !st || !!n.inferred, source: st ? 'stock' : 'inherited',
          tag: TAG_TEXT[tagKind(st?.tag, pi)] };
      }
    }
    return { nodes, stage: S.stage, epicenters: epicenters(r), stages: LAGS, title: r.title, id: r.id };
  }

  function applyOverlay() {
    if (!S.result) return;
    const p = planet();
    let drawn = false;
    if (p && typeof p.setOverlay === 'function') {
      try { p.setOverlay('scenario', overlayData()); drawn = true; } catch (e) { console.warn('[scenario] setOverlay', e); }
    }
    if (!drawn) startBadges(); else clearBadges();
    applyAttention();
  }

  /** In the future-weather mode the measured ①②③, captions, 主航道 and seasons would tell today's story:
   *  swap them for the scenario's own — the (up to) 3 landing spots on this planet with the biggest 时间差
   *  that have arrived by the current stage, and the planet's own scenario channel ('auto'). */
  function scenarioPicks() {
    const r = S.result, node = currentNode();
    if (!r || !node) return [];
    const si = LAGS.indexOf(S.stage);
    const kids = new Set((node.children || []).map((c) => c.id));
    const best = new Map();
    for (const l of r.landing || []) {
      if (LAGS.indexOf(l.lag) > si) continue;
      const path = l.pathIds || pathIds(l.id) || [];
      const cid = kids.has(l.id) ? l.id : path.find((x) => kids.has(x));
      if (!cid) continue;
      const cur = best.get(cid);
      if (!cur || (l.gap || 0) > (cur.l.gap || 0)) best.set(cid, { l, deep: cid !== l.id });
    }
    if (!best.size) {
      // a landing region's own planet: its stocks, the least priced-in first
      const land = (r.landing || []).find((l) => l.id === node.id && LAGS.indexOf(l.lag) <= si);
      if (land) {
        return (land.stocks || []).filter((st) => kids.has(st.id || 's:' + st.ticker))
          .sort((a, b) => (a.pricedIn ?? 1) - (b.pricedIn ?? 1)).slice(0, 3)
          .map((st) => {
            const v = st.val ? stripEmoji(say(st.val)) : '';
            const line = `已算进去 ${Math.round((st.pricedIn || 0) * 100)}%` + (v ? `；${v}` : '');
            return { id: st.id || 's:' + st.ticker, why: line.length > 34 ? line.slice(0, 33) + '…' : line, kind: 'scenario' };
          });
      }
    }
    return [...best.entries()].sort((a, b) => (b[1].l.gap || 0) - (a[1].l.gap || 0)).slice(0, 3).map(([id, { l, deep }]) => {
      const tag = TAG_TEXT[tagKind(l.tag, l.pricedIn)];
      const line = stripEmoji(say(l) || l.why || '');
      const short = line.length > 26 ? line.slice(0, 25) + '…' : line;
      return { id, why: `${deep ? l.name + ' · ' : ''}${l.dir > 0 ? '钱会进来' : '钱会出去'}，${tag}：${short}`, kind: 'scenario' };
    });
  }
  function applyAttention() {
    const p = planet();
    if (!S.result || !p) return;
    const picks = scenarioPicks();
    try {
      p.setOverlay?.('channel', 'auto');
      p.setOverlay?.('numbers', picks.map((x, k) => ({ id: x.id, n: k + 1, why: x.why })));
      p.setOverlay?.('seasons', null);
      p.setSpotlight?.(picks);
    } catch (e) { console.warn('[scenario] attention', e); }
  }

  function setStage(k) {
    if (!LAGS.includes(k) || !S.result) return;
    S.stage = k;
    applyOverlay();
    updateBar();
    markDrawerStage();
    app.emit?.('scenario-stage', k);
  }

  // ------------------------------------------------------------------ fallback badges (planet without setOverlay)
  function startBadges() {
    if (!badgeLayer) { badgeLayer = scoped(h('div.scn-badges', { 'aria-hidden': 'true' })); document.body.append(badgeLayer); }
    cancelAnimationFrame(badgeRaf);
    let last = 0;
    const tick = (t) => {
      badgeRaf = requestAnimationFrame(tick);
      if (t - last < 90) return;
      last = t;
      layoutBadges();
    };
    badgeRaf = requestAnimationFrame(tick);
  }
  function clearBadges() {
    cancelAnimationFrame(badgeRaf); badgeRaf = 0;
    if (badgeLayer) { badgeLayer.remove(); roots.delete(badgeLayer); badgeLayer = null; }
  }
  function layoutBadges() {
    const r = S.result, p = planet();
    if (!r || !badgeLayer || !p || typeof p.getChildScreenRect !== 'function') return;
    if (document.body.classList.contains('in-stock')) { badgeLayer.replaceChildren(); return; }
    const node = currentNode();
    const si = LAGS.indexOf(S.stage);
    const want = [];
    for (const c of node?.children || []) {
      const n = r.nodes[c.id];
      if (!n || Math.abs(n.impact) < 0.12 || LAGS.indexOf(n.lag) > si) continue;
      const rc0 = p.getChildScreenRect(c.id);
      if (!rc0) continue;
      const rc = { cx: rc0.cx ?? (rc0.left ?? rc0.x) + (rc0.width ?? rc0.w ?? 0) / 2, cy: rc0.cy ?? (rc0.top ?? rc0.y) + (rc0.height ?? rc0.h ?? 0) / 2,
        r: rc0.r ?? Math.min(rc0.width ?? rc0.w ?? 0, rc0.height ?? rc0.h ?? 0) / 2 };
      if (!Number.isFinite(rc.cx) || !Number.isFinite(rc.cy) || rc.r < 14) continue;
      want.push({ id: c.id, n, rc });
    }
    const key = want.map((w) => w.id + w.n.lag).join('|') + si;
    if (badgeLayer.dataset.key !== key) {
      badgeLayer.dataset.key = key;
      badgeLayer.replaceChildren(...want.map((w) => {
        const kind = tagKind(w.n.tag, w.n.pricedIn);
        return h('div.scn-badge.' + kind + (w.n.dir > 0 ? '.in' : '.out'), { dataset: { id: w.id } },
          icon(w.n.dir > 0 ? 'up' : 'down', 'scn-badge-dir'),
          kind === 'priced' ? h('span', '已抢跑') : kind === 'gap' ? [icon('hourglass'), h('span', '时间差')] : h('span', '算进一半'));
      }));
    }
    for (const el of badgeLayer.children) {
      const w = want.find((x) => x.id === el.dataset.id);
      if (!w) continue;
      el.style.transform = `translate(${Math.round(w.rc.cx)}px, ${Math.round(w.rc.cy + Math.min(28, w.rc.r * 0.42))}px) translate(-50%, 0)`;
    }
  }

  // ------------------------------------------------------------------ stage bar (in place of the time machine)
  function buildBar() {
    if (bar) bar.remove();
    const r = S.result;
    const counts = Object.fromEntries(LAGS.map((k) => [k, (r.stages?.[k] || []).length]));
    // a real range input carries pointer + keyboard (the shell leaves INPUT keys alone); the stops are its face
    const range = h('input.scn-range', { type: 'range', min: 0, max: LAGS.length - 1, step: 1, value: LAGS.indexOf(S.stage),
      'aria-label': '推演时间：现在、1–3 个月、3–12 个月、1 年以上',
      oninput: (e) => { stopPlay(); setStage(LAGS[+e.target.value]); } });
    const root = r.input?.text || r.root?.original || r.root?.text || r.title;
    bar = scoped(h('div.scn-bar', { role: 'group', 'aria-label': '推演时间轴' },
      h('div.scn-bar-l',
        h('span.scn-mode-tag', icon('foresee'), '推演'),
        h('div.scn-bar-txt',
          h('div.scn-bar-root', { title: root }, `如果「${root}」成真`),
          h('div.scn-bar-sub', '地图上是想象中的未来天气，不是实测'))),
      h('div.scn-stepper',
        h('div.scn-track-line', h('div.scn-track-fill')),
        LAGS.map((k) => h('div.scn-stop', { dataset: { k }, title: LAG_HINT[k] },
          h('span.scn-stop-dot'),
          h('span.scn-stop-t', LAG_ZH[k]),
          h('span.scn-stop-n', counts[k] ? `${counts[k]} 处` : '—'))),
        range),
      h('div.scn-bar-r',
        h('button.scn-play', { type: 'button', title: '按时间顺序播一遍', 'aria-label': '播放', onclick: () => (S.playing ? stopPlay() : play()) }, icon('play')),
        h('button.scn-exit', { type: 'button', title: '回到今天的实测天气', onclick: exit }, icon('close'), h('span', '退出推演')))));
    document.body.append(bar);
    updateBar();
    requestAnimationFrame(() => bar && bar.classList.add('on'));
  }
  function updateBar() {
    if (!bar) return;
    const i = LAGS.indexOf(S.stage);
    for (const b of bar.querySelectorAll('.scn-stop')) {
      const j = LAGS.indexOf(b.dataset.k);
      b.classList.toggle('past', j < i);
      b.classList.toggle('on', j === i);
    }
    const range = bar.querySelector('.scn-range');
    if (range && +range.value !== i) range.value = String(i);
    const fill = bar.querySelector('.scn-track-fill');
    if (fill) fill.style.width = (i / (LAGS.length - 1)) * 100 + '%';
    const pb = bar.querySelector('.scn-play');
    if (pb) { pb.replaceChildren(icon(S.playing ? 'pause' : 'play')); pb.classList.toggle('on', !!S.playing); }
  }
  function play(from = 0) {
    stopPlay();
    let i = clamp(from, 0, LAGS.length - 1);
    if (i >= LAGS.length - 1) i = 0;
    setStage(LAGS[i]);
    S.playing = setInterval(() => {
      i++;
      if (i >= LAGS.length) { stopPlay(); return; }
      setStage(LAGS[i]);
      if (i === LAGS.length - 1) stopPlay();
    }, 2600);
    updateBar();
  }
  function stopPlay() { if (S.playing) { clearInterval(S.playing); S.playing = 0; updateBar(); } }

  // ------------------------------------------------------------------ the story drawer (in place of the side panel)
  function buildDrawer() {
    if (drawer) drawer.remove();
    drawer = scoped(h('aside.scn-drawer', { 'aria-label': '推演结果' }));
    document.body.append(drawer);
    renderDrawer();
    requestAnimationFrame(() => drawer && drawer.classList.add('on'));
  }

  function renderDrawer() {
    if (!drawer || !S.result) return;
    const r = S.result;
    const scrollTop = drawer.querySelector('.scn-scroll')?.scrollTop || 0;
    const body = h('div.scn-scroll',
      headerBlock(r),
      verdictBlock(r),
      chainBlock(r),
      landingBlock(r),
      marketBlock(r),
      killBlock(r),
      betBlock(r),
      trackBlock(r),
      h('div.scn-saved-slot', savedBlock('drawer')),
      h('div.scn-new',
        h('button.scn-ghost.scn-wide', { type: 'button', onclick: () => openComposer({ text: '', date: '', tier: form.tier }) }, icon('plus'), '换一个判断推演')),
      h('div.scn-foot',
        r.meta?.pricedInNote ? h('p', r.meta.pricedInNote) : null,
        h('button.scn-link.scn-del', { type: 'button', onclick: () => removeScenario(r) }, icon('trash'), '删掉这个推演')));
    const tab = h('button.scn-drawer-tab', { type: 'button', title: '收起 / 展开推演', 'aria-label': '收起或展开推演',
      onclick: () => {
        const closed = document.body.classList.contains('panel-closed');
        if (typeof app.setPanelOpen === 'function') app.setPanelOpen(closed);
        else document.body.classList.toggle('panel-closed', !closed);
      } }, h('span.scn-tab-open', icon('chev')), h('span.scn-tab-closed', icon('back'), '推演'));
    drawer.replaceChildren(tab, body);
    body.scrollTop = scrollTop;
    markDrawerStage();
  }
  function renderDrawerSaved() {
    const slot = drawer?.querySelector('.scn-saved-slot');
    if (slot) slot.replaceChildren(savedBlock('drawer'));
  }

  /** "…【存储】、【网络连接】…" → text with the bracketed names as small fly-to links. */
  function richNames(text, ids = []) {
    const out = [];
    const re = /【([^】]+)】/g;
    let last = 0, m, k = 0;
    const str = String(text || '');
    while ((m = re.exec(str))) {
      if (m.index > last) out.push(str.slice(last, m.index));
      const nm = m[1];
      const id = ids.find((x) => nameOf(x) === nm) || ids[k] || null;
      k++;
      out.push(id ? h('button.scn-inl', { type: 'button', title: '飞过去看', onclick: (e) => { e.stopPropagation(); fly(id); } }, nm) : h('b', nm));
      last = re.lastIndex;
    }
    if (last < str.length) out.push(str.slice(last));
    return out;
  }

  function estBadge(o, extra = '') {
    if (!o || !o.est) return null;
    const tip = [o.basis, o.conf != null ? `把握约 ${Math.round(o.conf * 100)}%` : '', '等你补数据'].filter(Boolean).join(' · ');
    return h('span.scn-est' + (extra ? '.' + extra : ''), { title: tip }, '估');
  }

  function headerBlock(r) {
    const root = r.root || {};
    const odds = r.rootOdds;
    const headline = say(r, 'headline');
    const take = voice() !== 'mild' ? r.take : (r.takeMild || null);
    return h('header.scn-head',
      h('div.scn-head-k',
        h('span.scn-mode-tag.small', icon('foresee'), '推演'),
        h('span.scn-head-date', r.createdAt ? `${ago(r.createdAt)}做的 · 数据 ${cnDay(r.asOf)}` : ''),
        h('button.scn-x', { type: 'button', title: '退出推演', 'aria-label': '退出推演', onclick: exit }, icon('close'))),
      h('h1.scn-title', r.title || '推演'),
      h('blockquote.scn-root',
        h('p', root.original || r.input?.text || root.text),
        h('div.scn-root-meta',
          root.date ? h('span.scn-pill.fuji', '你的日期 ' + cnDay(root.date, true)) : h('span.scn-pill', '没写日期'),
          root.tier ? h('span.scn-pill', { title: (TIERS.find((t) => t.k === root.tier) || {}).sub || '' }, root.tier + '档') : null),
        root.note ? h('p.scn-root-note', root.note) : null),
      h('p.scn-headline', headline),
      take && take !== headline ? h('p.scn-take', icon('quote'), h('span', take)) : null,
      odds && odds.prob != null ? oddsStrip(odds) : null);
  }

  function oddsStrip(odds) {
    const p = clamp(+odds.prob, 0, 1);
    return h('div.scn-odds' + (odds.est ? '.est' : ''),
      h('div.scn-odds-top',
        h('span.scn-odds-l', icon('market'), odds.est ? '市场大概给这件事' : '预言市场给这件事', estBadge(odds)),
        h('span.scn-odds-v', pctProb(p))),
      h('div.scn-odds-bar', h('div.scn-odds-fill', { style: { width: Math.max(0.6, p * 100) + '%' } }),
        h('div.scn-odds-you', { title: '你押它会发生' })),
      h('div.scn-odds-legend', h('span', '0'), h('span.scn-odds-youl', '你：押它成真'), h('span', '100%')),
      say(odds) ? h('p.scn-odds-say', say(odds)) : null,
      odds.est && odds.basis ? h('p.scn-odds-basis', '怎么估的：', odds.basis) : null);
  }

  function verdictBlock(r) {
    const vs = (r.verdict || []).filter((v) => say(v));
    if (!vs.length) return null;
    return h('section.scn-sec.scn-verdict',
      secHead('quote', '老风的结论', null),
      h('ul.scn-vlist', vs.slice(0, 5).map((v) => h('li.scn-v.' + (v.kind || 'x'),
        h('span.scn-v-i', icon(VERDICT_ICON[v.kind] || 'chev')),
        h('p', richNames(say(v), v.ids || []))))));
  }

  function nodeChip(id, r, { small = false } = {}) {
    const n = r.nodes?.[id];
    const dir = n ? (n.dir > 0 ? 'in' : 'out') : '';
    return h('button.scn-node' + (dir ? '.' + dir : '') + (small ? '.small' : '') + (n && n.inferred ? '.inf' : ''), {
      type: 'button', title: '飞过去看',
      onclick: (e) => { e.stopPropagation(); fly(id); },
    }, n ? icon(n.dir > 0 ? 'up' : 'down', 'scn-node-dir') : null, nameOf(id));
  }

  function fly(id) {
    const node = nodeById(id);
    if (!node) return;
    if (node.kind === 'stock' || String(id).startsWith('s:')) { app.openStock?.(node.ticker || String(id).slice(2)); return; }
    const p = pathIds(id);
    if (!p) return;
    try { app.flyTo?.(p); } catch (e) { console.warn('[scenario] flyTo', e); }
  }

  function secHead(ic, title, hint) {
    return h('div.scn-sec-h', icon(ic), h('h3', title), hint ? h('span.scn-sec-hint', hint) : null);
  }

  function chainBlock(r) {
    const chain = r.chain || [];
    if (!chain.length) return null;
    const open = S.expanded.has('chain');
    const shown = open ? chain : chain.slice(0, 4);
    return h('section.scn-sec',
      secHead('chain', '怎么传下去', `${chain.length} 步 · 链越短越靠谱`),
      h('ol.scn-chain', shown.map((c, i) => h('li.scn-chain-i',
        h('span.scn-chain-n', String(c.step || i + 1)),
        h('div.scn-chain-b',
          h('div.scn-chain-q', c.q),
          h('p.scn-chain-say', say(c)),
          (c.nodes || []).length ? h('div.scn-chips', c.nodes.map((id) => nodeChip(id, r, { small: true }))) : null)))),
      chain.length > 4 ? h('button.scn-more', { type: 'button', onclick: () => { open ? S.expanded.delete('chain') : S.expanded.add('chain'); renderDrawer(); } },
        open ? '收起' : `再往下一层（还有 ${chain.length - 4} 步）`) : null);
  }

  function landingBlock(r) {
    const all = r.landing || [];
    if (!all.length) return null;
    const facs = (r.factors || []).filter((f) => (f.landing || []).length);
    const land = S.factor ? all.filter((l) => l.factor === S.factor) : all;
    const open = S.expanded.has('landing') || !!S.factor;
    const shown = open ? land : land.slice(0, 3);
    return h('section.scn-sec.scn-land-sec',
      secHead('target', '落点 · 按时间差排', S.factor ? `只看「${S.factor}」` : '先看前三'),
      facs.length > 1 ? h('div.scn-facs',
        h('div.scn-facs-t', `${all.length} 个落点其实只押了 ${facs.length} 件事`),
        h('div.scn-facs-list', facs.map((f) => h('button.scn-fac' + (S.factor === f.name ? '.on' : ''), {
          type: 'button', 'aria-pressed': String(S.factor === f.name), title: (f.names || []).join('、'),
          onclick: () => { S.factor = S.factor === f.name ? null : f.name; S.openLanding = null; renderDrawer(); },
        },
        h('span.scn-fac-n', f.name),
        h('span.scn-fac-c', f.up ? h('span.in', icon('up'), f.up) : null, f.down ? h('span.out', icon('down'), f.down) : null))))) : null,
      h('div.scn-legend',
        h('span.scn-lg', h('i.scn-lg-gap'), '还没被算进去'),
        h('span.scn-lg', h('i.scn-lg-priced'), '已经被算进去'),
        h('span.scn-lg.scn-lg-r', '条长＝影响多大')),
      h('ol.scn-land', shown.map((l) => landingRow(l, all.indexOf(l), all.indexOf(l) < 3 || !!S.factor))),
      !S.factor && land.length > 3 ? h('button.scn-more', { type: 'button', onclick: () => { open ? S.expanded.delete('landing') : S.expanded.add('landing'); renderDrawer(); } },
        open ? '收起' : `展开更多（还有 ${land.length - 3} 个）`) : null);
  }

  function landingRow(l, i, showSay) {
    const kind = tagKind(l.tag, l.pricedIn);
    const isOpen = S.openLanding === l.id;
    const imp = Math.abs(l.impact || 0);
    const w = clamp(imp / 3, 0.04, 1) * 100;
    const pricedW = clamp(l.pricedIn || 0, 0, 1) * 100;
    const wx = l.weather || {};
    const seasonKey = wx.season && SEASON[wx.season] ? wx.season : null;
    const bet = l.bet && BET[l.bet.kind] ? l.bet : null;
    const toggle = () => { S.openLanding = isOpen ? null : l.id; renderDrawer(); };
    const sayTxt = stripEmoji(say(l) || l.why || '');
    const r = S.result || {};
    const rootText = r.root?.text || r.input?.text || r.title || '';
    const why = whyButton(app, { kind: 'landing', ids: [l.id], scenario: r.id || null, dir: l.dir, lag: l.lag || null, map: 'curated' }, {
      question: `如果「${rootText}」成真，${l.name}为什么会${l.dir > 0 ? '有钱流进来' : '被抽走钱'}？市场现在算进去多少了？`,
      title: `为什么${l.name}是落点、市场算进去多少了：派 Claude 去查新闻和来源（花今天的额度）`,
    });
    return h('li.scn-land-i' + (isOpen ? '.open' : '') + (l.est ? '.est' : ''), { dataset: { lag: l.lag || 'now', id: l.id, whyHost: '' } },
      h('div.scn-land-main', {
        tabindex: 0, role: 'button', 'aria-expanded': String(isOpen), title: '展开：为什么、对了多大、价格要了多少、认错的数、下面的股票',
        onclick: toggle,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
      },
      h('span.scn-rank', String(i + 1)),
      h('div.scn-land-b',
        h('div.scn-land-top',
          h('span.scn-land-name', l.name),
          h('span.scn-dir.' + (l.dir > 0 ? 'in' : 'out'), icon(l.dir > 0 ? 'up' : 'down'), l.dir > 0 ? '钱进' : '钱出'),
          h('span.scn-lag', LAG_ZH[l.lag] || l.lag),
          l.inferred ? h('span.scn-inferred', { title: '没被点名，是从相关地块的连带推断的' }, '推断') : null,
          estBadge(l),
          h('span.scn-tag.' + kind, icon(TAG_ICON[kind]), TAG_TEXT[kind])),
        h('div.scn-land-path', (l.path || '').replace(/\s*›\s*[^›]*$/, '') || '', bet ? h('span.scn-bet.' + BET[bet.kind].c, { title: bet.why || BET[bet.kind].tip }, bet.zh || BET[bet.kind].t) : null),
        h('div.scn-gapbar', { title: `影响 ${imp.toFixed(2)} / 3 · 已算进去 ${Math.round((l.pricedIn || 0) * 100)}% · 时间差 ${(l.gap || 0).toFixed(2)}` },
          h('div.scn-gapbar-imp.' + (l.dir > 0 ? 'in' : 'out'), { style: { width: w + '%' } },
            h('div.scn-gapbar-priced', { style: { width: pricedW + '%' } }))),
        h('div.scn-land-nums',
          h('span', '时间差 ', h('b', (l.gap || 0).toFixed(2))),
          h('span', '已算进去 ', h('b', Math.round((l.pricedIn || 0) * 100) + '%')),
          seasonKey ? h('span.scn-season.' + seasonKey, icon(seasonKey), SEASON[seasonKey].name) : null,
          wx.pres != null ? h('span', '拥挤 ', h('b', Math.round(wx.pres))) : null,
          why),
        showSay || isOpen ? h('p.scn-land-say', sayTxt) : null)),
      isOpen ? landingDetail(l) : null);
  }

  function landingDetail(l) {
    const stocks = (l.stocks || []).slice(0, 6);
    const needs = l.needs ? { 弱: '弱档也成立', 中: '要到中档', 强: '要强档才成立' }[l.needs] : null;
    const v = l.valuation || null;
    return h('div.scn-land-detail',
      l.facts ? h('div.scn-facts', stripEmoji(l.facts)) : null,
      l.why ? h('div.scn-kv', h('span.scn-k', '为什么'), h('p', l.why)) : null,
      l.upside ? h('div.scn-kv', h('span.scn-k', '对了多大'), h('p', l.upside)) : null,
      v && say(v) ? h('div.scn-kv', h('span.scn-k', '价格已经要了多少', estBadge(v, 'mini')), h('p', say(v))) : null,
      l.check ? h('div.scn-kv', h('span.scn-k', '认错的数'), h('p', l.check)) : null,
      l.bet && l.bet.why ? h('div.scn-kv', h('span.scn-k', '为什么算「' + (l.bet.zh || '') + '」'), h('p', l.bet.why)) : null,
      (needs || l.robust) ? h('div.scn-chips', needs ? h('span.scn-pill', needs) : null, l.robust ? h('span.scn-pill', { title: '不靠猜某一条具体路径也能赢' }, '不挑路径') : null) : null,
      l.est && l.basis ? h('p.scn-est-note', h('span.scn-est', '估'), l.basis, '。等你补数据。') : null,
      stocks.length ? h('div.scn-kv',
        h('span.scn-k', '下面的股票', h('small', '（还没被算进去的排前面；灰条＝已算进去）')),
        h('ul.scn-stocks', stocks.map((s) => {
          const k2 = tagKind(s.tag, s.pricedIn);
          const vs = s.val ? say(s.val) : '';
          return h('li.scn-stock', { tabindex: 0, role: 'button', title: [s.note, vs].filter(Boolean).join(' · ') || '看这只股票',
            onclick: () => app.openStock?.(s.ticker), onkeydown: (e) => { if (e.key === 'Enter') app.openStock?.(s.ticker); } },
          h('span.scn-stock-t', s.ticker),
          h('span.scn-stock-n', s.name && s.name !== s.ticker ? s.name : (s.note || '')),
          s.season && SEASON[s.season] ? h('span.scn-season.' + s.season, icon(s.season)) : h('span'),
          h('span.scn-stock-p', { title: `已算进去 ${Math.round((s.pricedIn || 0) * 100)}%` }, h('i', { style: { width: clamp(s.pricedIn || 0, 0, 1) * 100 + '%' } })),
          h('span.scn-tag.mini.' + k2, TAG_TEXT[k2]),
          vs ? h('span.scn-stock-v', vs, s.val?.est ? h('span.scn-est.mini', { title: s.val.basis || '' }, '估') : null) : null);
        }))) : null,
      h('div.scn-detail-act',
        h('button.scn-ghost.small', { type: 'button', onclick: () => fly(l.id) }, '飞过去看', icon('chev'))));
  }

  function markDrawerStage() {
    if (!drawer || !S.result) return;
    const si = LAGS.indexOf(S.stage);
    for (const li of drawer.querySelectorAll('.scn-land-i')) {
      li.classList.toggle('later', LAGS.indexOf(li.dataset.lag) > si);
    }
  }

  // ------------------------------------------------------------------ the market's dates vs the owner's + cards
  // Kalshi (§24 kalshi.json, same shape as polymarket.json): the engine only reads Polymarket, so the drawer adds
  // the Kalshi markets that land on this scenario's impacted territories (deterministic, no LLM). §12: the card's
  // sentence must follow from data, so each one says only what its basis supports —
  //   echo  · the same question as a market the 推演 itself cited (or the root's own odds) → the engine's relation
  //   macro · rates / inflation / growth markets: which way YES pushes rates vs which way the root pushes them
  //   rule  · a confident curated rule on a few territories incl. an epicenter → 同向 / 反向 by the mapping's sign
  //   weak  · anything else (a broad theme basket): 「关联弱，只当背景」, shown only when the list is expanded
  let KS = null, ksP = null;
  const MACRO_TAGS = new Set(['fed', 'rates', 'inflation', 'recession', 'jobs', 'gdp', 'economy', 'macro', 'cpi', 'unemployment', 'yields']);
  // territories that move with interest rates (+1 = rises when rates fall) — the yardstick for macro markets
  const RATE_AXIS = { bonds: 1, 'bonds-gov': 1, 'bonds-long': 1, 'bonds-mid': 1, 'bonds-short': 1, 'bonds-agg': 1, 'bonds-ig': 1,
    'cash-float': -1, 's:UUP': -1, 'realestate-builders': 1, realestate: 1 };
  /** Σ sign·axis over the rate-sensitive territories → + = pushes rates down, − = up; null when it says nothing clear */
  function rateLean(list) {
    let sum = 0, tot = 0;
    for (const x of list) { const ax = RATE_AXIS[x.id]; if (!ax || !x.s) continue; sum += x.s * ax * (x.w || 1); tot += Math.abs(x.w || 1); }
    return tot >= 1 && Math.abs(sum) / tot >= 0.5 ? Math.sign(sum) : null;
  }
  const RATE_WORD = { 1: '利率往下走', '-1': '利率降不下来' };

  function kalshiFor(r) {
    if (!KS) {
      if (!ksP) ksP = Promise.resolve(D().load?.('kalshi.json')).then((j) => { KS = j && Array.isArray(j.markets) ? j : { markets: [] }; if (S.result) renderDrawer(); }).catch(() => { KS = { markets: [] }; });
      return [];
    }
    const nodes = r.nodes || {};
    if ((r.polymarket || []).some((m) => m.source === 'kalshi' || m.src === 'kalshi')) return [];
    const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    // what the engine itself cited: its markets (with its relation) and the root's own odds
    // (the root's own odds first: a Kalshi market on the root itself is the most useful second opinion)
    const cited = ((r.rootOdds && r.rootOdds.markets) || []).map((m) => ({ q: m.question || '', zh: m.qZh || m.question || '', prob: m.prob, rel: 'root', say: '' }))
      .concat((r.polymarket || []).map((m) => ({ q: m.question || '', zh: m.qZh || m.question || '', prob: m.prob, rel: m.relation || null, say: m.say || '' })));
    const epic = new Set(r.epicenters || Object.keys(nodes).filter((id) => nodes[id] && nodes[id].order === 1 && !nodes[id].inferred));
    // the root's own lean on rates, from its impacts (inferred ones count half)
    const rootRate = rateLean(Object.entries(nodes).map(([id, n]) => ({ id, s: Math.sign(n.dir || 0), w: Math.abs(n.impact || 0) * (n.inferred ? 0.5 : 1) })));
    const out = [];
    for (const m of KS.markets) {
      if (!m || !(m.prob > 0.02 && m.prob < 0.98) || !Array.isArray(m.nodes) || !m.nodes.length) continue;
      if (m.endDate && m.endDate < soon) continue;
      let score = 0;
      const hits = [], same = [], diff = [];
      for (const x of m.nodes) {
        const n = nodes[x.id];
        if (!n || n.inferred || !n.impact || !x.sign) continue;
        const w = Math.abs(n.impact) * (n.order === 1 ? 1.2 : 1);
        const sg = Math.sign(x.sign * (n.dir || 0));
        score += w; hits.push(x.id);
        if (sg > 0) same.push(x.id); else if (sg < 0) diff.push(x.id);
      }
      const qFull = `${m.q || ''} ${m.group || ''}`;
      const echo = cited.find((c) => c.q && sameQuestion(qFull, c.q));
      if ((!score || !hits.length) && !echo) continue;
      const tags = new Set([...(m.tags || []), m.cat || '']);
      const macro = m.cat === 'rates' || m.cat === 'macro' || [...tags].some((t) => MACRO_TAGS.has(t));
      let basis = 'weak', relation = 'weak', lean = '关联弱，只当背景：规则表只是把它粗粗挂到这几块地上。';
      if (echo) {
        basis = 'echo';
        relation = echo.rel === 'root' ? 'root' : echo.rel || 'timing';
        const other = echo.prob != null ? `（Polymarket 那边 ${pctProb(echo.prob)}）` : '';
        lean = echo.rel === 'root' ? `这就是你的根本身${other}：两个市场一起看，别只信一家。`
          : `跟推演里引用的「${zhFix(echo.zh)}」是同一件事${other}；推演判它${REL[relation] ? REL[relation].t : '相关'}。`;
      } else if (macro) {
        const mk = rateLean(m.nodes.map((x) => ({ id: x.id, s: Math.sign(x.sign || 0), w: x.w || 1 })));
        if (mk && rootRate) {
          basis = 'macro';
          relation = mk === rootRate ? 'supports' : 'contradicts';
          lean = mk === rootRate ? `YES 意味着${RATE_WORD[mk]}，跟你的根同向。`
            : `YES 意味着${RATE_WORD[mk]}，你的根要的是${RATE_WORD[rootRate]}：跟你的根唱反调。`;
        } else lean = '宏观盘，但看不出它跟你的根往哪边：关联弱，只当背景。';
      } else if ((m.mapBy === 'owner' || (m.mapBy === 'rules' && m.conf === 'hi')) && m.nodes.length <= 4 && hits.some((id) => epic.has(id))) {
        const nm = (ids) => ids.slice(0, 2).map(nameOf).join('、');
        if (same.length && !diff.length) { basis = 'rule'; relation = 'supports'; lean = `按规则表，YES 会把【${nm(same)}】往你推的方向推。`; }
        else if (diff.length && !same.length) { basis = 'rule'; relation = 'contradicts'; lean = `按规则表，YES 会把【${nm(diff)}】往你推的反方向推。`; }
        else lean = `YES 对【${nm(same)}】同向、对【${nm(diff)}】反向：算不上支持，只当背景。`;
      }
      const vol = Math.log10(Math.max(10, +m.volume || 0));
      const prio = { echo: relation === 'root' ? 4 : 3, macro: 2, rule: 1, weak: 0 }[basis];
      out.push({ m, prio, basis, relation, lean, echoQ: echo ? echo.q : null, score: (score || 1) * vol * (0.6 + Math.min(1, Math.abs(+m.d7 || 0) * 4)), hits });
    }
    out.sort((a, b) => b.prio - a.prio || b.score - a.score);
    const seen = new Set();
    const pick = [];
    for (const o of out) {
      // one card per Kalshi event, and one per market the 推演 cited (two Kalshi phrasings of one question say it once)
      const keys = ['e:' + (o.m.event || o.m.series || o.m.id), o.m.series ? 's:' + o.m.series : null, o.echoQ ? 'q:' + o.echoQ : null].filter(Boolean);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k)); pick.push(o);
      if (pick.length >= 3) break;
    }
    return pick.map(({ m, hits, basis, relation, lean }) => ({
      id: m.id, question: m.q, qZh: m.zhOk === false ? null : m.qZh, prob: m.prob, d7: m.d7, volume: m.volume, endDate: m.endDate, url: m.url,
      // chips = the territories the sentence is about (for a macro card: the rate-sensitive ones it was judged on)
      source: 'kalshi', cat: m.cat || null, basis, relation, say: lean, sayMild: lean,
      nodes: basis === 'weak' ? [] : basis === 'macro' && hits.some((id) => RATE_AXIS[id]) ? hits.filter((id) => RATE_AXIS[id]) : hits,
    }));
  }

  function marketBlock(r) {
    const pm = r.polymarket || [];
    const ks = kalshiFor(r);
    const ladders = (r.marketDates || []).filter((x) => (x.ladder || []).length);
    if (!pm.length && !ks.length && !ladders.length) return null;
    const root = r.root || {};
    const open = S.expanded.has('pm');
    const k = open ? 12 : ladders.length ? 1 : 2;
    // Kalshi beside Polymarket: the best-founded card always shows; 「关联弱」 ones only when the list is expanded
    const kk = open ? ks.length : Math.min(1, ks.filter((x) => x.basis !== 'weak').length);
    const ms = pm.slice(0, k).concat(ks.slice(0, kk));
    const hidden = Math.max(0, pm.length - k) + (ks.length - kk) + Math.max(0, ladders.length - (open ? 6 : 2));
    return h('section.scn-sec',
      secHead('market', '预言市场怎么看', '它押的日子 vs 你的日子'),
      caveat(),
      ladders.length ? h('div.scn-ladders', ladders.slice(0, open ? 6 : 2).map((x) => ladderCard(x, root))) : null,
      ms.length ? h('div.scn-pm-list', ms.map((m) => pmCard(m, root, r))) : null,
      (hidden > 0 || open) && (pm.length > 1 || ks.length > 1 || ladders.length > 2) ? h('button.scn-more', { type: 'button', onclick: () => { open ? S.expanded.delete('pm') : S.expanded.add('pm'); renderDrawer(); } },
        open ? '收起' : `展开更多（还有 ${hidden} 个盘口）`) : null);
  }

  function caveat() {
    if (store.get(LS.caveat, false)) return null;
    const el = h('div.scn-caveat',
      h('p', '提醒一次：预言市场盘子小，也会错；你自己的记录显示，它们常把 AI 里程碑定得', h('b', '太早'), '。拿它当一种感觉，不是答案。'),
      h('button.scn-link', { type: 'button', onclick: () => { store.set(LS.caveat, true); el.remove(); app.emit?.('pm-caveat-seen'); } }, '知道了'));
    return el;
  }

  /** A date ladder: the market's cumulative odds by date as a step line, the owner's month as a band. */
  function ladderCard(x, root) {
    const rel = REL[x.relation] || null;
    const steps = (x.ladder || []).map((s) => ({ ...s, t: dayDate(s.date) })).filter((s) => s.t).sort((a, b) => a.t - b.t);
    const ownS = x.ownerDate || root.date;
    const own0 = dayDate(ownS, false), own1 = dayDate(ownS, true);
    const t0 = today0();
    let tEnd = new Date(Math.max(...steps.map((s) => +s.t), own1 ? +own1 : 0, +t0 + 60 * 864e5));
    tEnd = new Date(+t0 + (tEnd - t0) * 1.08);
    const X = (d) => 12 + clamp((d - t0) / (tEnd - t0), 0, 1) * 276;
    const Y = (p) => 54 - clamp(p, 0, 1) * 42;
    let path = `M${X(t0).toFixed(1)} ${Y(0)}`;
    let area = path;
    for (const s of steps) {
      const xs = X(s.t).toFixed(1), ys = Y(s.prob).toFixed(1);
      path += `H${xs}V${ys}`; area += `H${xs}V${ys}`;
    }
    path += `H288`; area += `H288V54H${X(t0).toFixed(1)}Z`;
    let g = '';
    if (own0) {
      const a = X(own0), b = Math.max(X(own1), a + 4);
      g += `<rect class="ld-own" x="${a.toFixed(1)}" y="8" width="${(b - a).toFixed(1)}" height="46" rx="2"/>`;
      const anchor = a > 230 ? 'end' : 'start';
      g += `<text class="ld-own-l" x="${(anchor === 'end' ? b : a).toFixed(1)}" y="5" text-anchor="${anchor}">你 · ${esc(cnDay(ownS))}</text>`;
    }
    g += `<line class="ld-axis" x1="12" y1="54" x2="288" y2="54"/>`;
    g += `<line class="ld-grid" x1="12" y1="${Y(0.5)}" x2="288" y2="${Y(0.5)}"/><text class="ld-gl" x="290" y="${Y(0.5) + 3}">50%</text>`;
    g += `<path class="ld-area" d="${area}"/><path class="ld-line" d="${path}"/>`;
    // "今天" only when the first rung is not sitting on top of it
    const firstX = steps.length ? X(steps[0].t) : 300;
    let lastX = -99;
    if (firstX > 58) { g += `<text class="ld-d" x="12" y="67" text-anchor="start">今天</text>`; lastX = 12; }
    steps.forEach((s, i) => {
      const xs = X(s.t), ys = Y(s.prob);
      g += `<circle class="ld-dot" cx="${xs.toFixed(1)}" cy="${ys.toFixed(1)}" r="3"/>`;
      const pa = xs < 40 ? 'start' : 'end';
      g += `<text class="ld-p" x="${(pa === 'start' ? xs + 5 : xs - 4).toFixed(1)}" y="${(ys - 5).toFixed(1)}" text-anchor="${pa}">${esc(pctProb(s.prob))}</text>`;
      if (xs - lastX > 44 || i === steps.length - 1) {
        const da = xs > 250 ? 'end' : xs < 40 ? 'start' : 'middle';
        g += `<text class="ld-d" x="${(da === 'start' ? Math.max(4, xs - 4) : xs).toFixed(1)}" y="67" text-anchor="${da}">${esc(shortDate(s))}</text>`;
        lastX = xs;
      }
    });
    const s = svgEl('0 0 300 72', 'scn-ladder-svg', g);
    const early = x.monthsEarly != null && x.monthsEarly > 0;
    // 为什么 on the rung nearest the owner's date (the market that speaks to their timing)
    const rung = steps.find((st) => own1 && st.t >= own0) || steps[steps.length - 1];
    const why = whyButton(app, { kind: 'market', ids: [String((rung && rung.id) || x.id)], source: x.source === 'kalshi' ? 'kalshi' : 'polymarket', scenario: S.result?.id || null }, {
      question: `预言市场「${zhFix(x.titleZh || x.title || '').replace(/……/g, '…')}」为什么只给这个概率？最近有什么新闻？`,
      title: '市场为什么押这个日子：派 Claude 去查新闻和来源（花今天的额度）',
    });
    return h('article.scn-ladder', { dataset: { whyHost: '' } },
      h('div.scn-ladder-top',
        h('div.scn-pm-q', zhFix(x.titleZh || x.title)),
        rel ? h('span.scn-rel.' + rel.c, rel.t) : null),
      s,
      h('div.scn-ladder-meta',
        x.probByOwner != null ? h('span', '到你的日子，市场给 ', h('b', pctProb(x.probByOwner))) : null,
        early ? h('span.scn-early', icon('calendar'), `你比市场早约 ${x.monthsEarly} 个月`) : null,
        why),
      say(x) ? h('p.scn-pm-say', say(x)) : null);
  }
  const shortDate = (s) => {
    const p = parseDay(s.date);
    if (!p) return s.label || '';
    // ladder dates are "by" dates (2027-01-01 = by 2026-12-31): show the label's own month/day when given
    const lab = String(s.label || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (lab) return (+lab[1] !== new Date().getFullYear() ? `${lab[1].slice(2)}年` : '') + `${+lab[2]}月${+lab[3]}日`;
    return cnDay(s.date);
  };

  function pmCard(m, root, r) {
    const rel = REL[m.relation] || null;
    const p = m.prob != null ? clamp(+m.prob, 0, 1) : null;
    const d7 = pts(m.d7);
    const zh = !!(m.qZh && m.qZh !== m.question);
    const q = zh ? zhFix(m.qZh) : m.question;
    const src = m.source === 'kalshi' || m.src === 'kalshi' ? 'kalshi' : 'polymarket';
    const why = whyButton(app, { kind: 'market', ids: [String(m.id)], source: src, scenario: r?.id || null }, {
      question: `预言市场「${q}」现在 ${pctProb(p)}${d7 ? `，一周 ${d7} 个点` : ''}：为什么？最近有什么新闻？`,
      title: '这个盘口为什么这样走：派 Claude 去查新闻和来源（花今天的额度）',
    });
    return h('article.scn-pm', { dataset: { whyHost: '' } },
      h('div.scn-pm-top',
        h('div.scn-pm-q' + (zh ? '' : '.en'), { title: m.question || '' }, q),
        h('div.scn-pm-prob', h('b', pctProb(p)), h('small', 'YES'))),
      h('div.scn-pm-meta',
        // the source as its own chip (never glued onto the title)
        src === 'kalshi' ? h('span.scn-pm-src', { title: 'Kalshi：美国受监管的预言市场' }, 'Kalshi' + (CAT_ZH[m.cat] ? ` · ${CAT_ZH[m.cat]}` : '')) : null,
        rel ? h('span.scn-rel.' + rel.c, rel.t) : null,
        d7 ? h('span.scn-d7' + (m.d7 > 0.005 ? '.up' : m.d7 < -0.005 ? '.down' : ''), `一周 ${d7} 个点`) : null,
        m.volume ? h('span.scn-vol', '成交 ' + money(m.volume)) : null),
      timeline(m, root),
      m.ownerVsEndSay ? h('div.scn-pm-vs', m.ownerVsEndSay) : null,
      say(m) ? h('p.scn-pm-say', say(m)) : null,
      (m.nodes || []).length ? h('div.scn-chips', m.nodes.slice(0, 4).map((id) => nodeChip(id, r, { small: true }))) : null,
      h('div.scn-pm-foot', why,
        m.url ? h('a.scn-pm-link', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, src === 'kalshi' ? '在 Kalshi 看' : '在 Polymarket 看', icon('ext')) : null));
  }

  function money(usd) {
    const v = +usd;
    if (!Number.isFinite(v)) return '';
    if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿美元';
    if (v >= 1e4) return Math.round(v / 1e4) + '万美元';
    return Math.round(v) + '美元';
  }

  /** The time difference made visible: 今天 · 你的日期 · 市场截止 on one line. */
  function timeline(m, root) {
    const t0 = today0();
    const own0 = dayDate(root.date, false), own1 = dayDate(root.date, true);
    const end = dayDate(m.endDate, false);
    if (!end && !own0) return null;
    const pts2 = [t0, own0, own1, end].filter(Boolean);
    let t1 = new Date(Math.max(...pts2.map(Number)));
    const span = Math.max(30 * 864e5, t1 - t0);
    t1 = new Date(+t0 + span * 1.12);
    const X = (d) => 10 + ((d - t0) / (t1 - t0)) * 280;
    let g = `<line class="tl-base" x1="10" y1="23" x2="290" y2="23"/>`;
    g += `<line class="tl-tick" x1="10" y1="18" x2="10" y2="28"/>`;
    const endX = end ? X(end) : null;
    if (!(endX != null && endX < 70)) g += `<text class="tl-lab" x="10" y="42" text-anchor="start">今天</text>`;
    if (own0) {
      const a = X(own0), b = Math.max(X(own1), a + 4);
      g += `<rect class="tl-own" x="${a.toFixed(1)}" y="19" width="${(b - a).toFixed(1)}" height="8" rx="4"/>`;
      const mid = (a + b) / 2;
      g += `<text class="tl-lab tl-own-l" x="${clamp(mid, 40, 260).toFixed(1)}" y="11" text-anchor="middle">你 · ${esc(cnDay(root.date))}</text>`;
    }
    if (end) {
      g += `<path class="tl-end" d="M${endX.toFixed(1)} 17.5l5.5 5.5-5.5 5.5-5.5-5.5z"/>`;
      const anchor = endX > 230 ? 'end' : endX < 60 ? 'start' : 'middle';
      g += `<text class="tl-lab tl-end-l" x="${endX.toFixed(1)}" y="42" text-anchor="${anchor}">市场截止 ${esc(cnDay(m.endDate))}</text>`;
    }
    return svgEl('0 0 300 46', 'scn-tl', g);
  }

  // ------------------------------------------------------------------ 认错线
  function killBlock(r) {
    const ks = (r.killSignals || []).slice().sort((a, b) => String(a.by).localeCompare(String(b.by)));
    if (!ks.length) return null;
    const due = new Set((r.track?.due || []).map((k) => (k.by || '') + (k.signal || '')));
    return h('section.scn-sec',
      secHead('flag', '认错线', '到日子还没看到，就把判断降一档'),
      h('ol.scn-kill', ks.map((k) => {
        const d = dayDate(k.by, true);
        const left = d ? daysTo(d) : null;
        const isDue = (left != null && left < 0) || due.has((k.by || '') + (k.signal || ''));
        return h('li.scn-kill-i' + (isDue ? '.due' : left != null && left <= 14 ? '.soon' : ''),
          h('div.scn-kill-when',
            h('b', cnDay(k.by)),
            h('span', left == null ? '' : isDue ? '到期了 · 去核对' : left === 0 ? '就是今天' : `还有 ${left} 天`)),
          h('div.scn-kill-b',
            h('p.scn-kill-sig', k.signal),
            k.ifMissing ? h('p.scn-kill-if', h('span', '没出现 →'), ' ', k.ifMissing) : null));
      })));
  }

  function betBlock(r) {
    const up = say(r, 'upside'), risk = say(r, 'risk');
    if (!up && !risk) return null;
    return h('section.scn-sec.scn-bet',
      up ? h('div.scn-bet-i.up', h('span.scn-k', '对了有多大'), h('p', up)) : null,
      risk ? h('div.scn-bet-i.risk', h('span.scn-k', '最大的风险'), h('p', risk)) : null);
  }

  function trackBlock(r) {
    const t = r.track;
    if (!t || !t.days) return h('section.scn-sec.scn-trackbox', secHead('track', '跟踪', null),
      h('p.scn-muted', (t && t.say) ? t.say + '。' : '', '每次数据更新都会核对：从推演那天起，这些落点的钱和价格有没有按你说的方向走（扣掉大盘的涨跌）。'));
    const td = trackDays(t);
    // a hit rate after a day or two (or one half-finished intraday bar) is noise: no big % before 5 full days
    const early = !td || td.days < TRACK_MIN_DAYS;
    const rate = !early && t.rate != null ? Math.round(t.rate * 100) : null;
    return h('section.scn-sec.scn-trackbox',
      secHead('track', '跟踪', t.since ? `从 ${cnDay(t.since)} 起` : null),
      h('div.scn-track-row',
        rate != null ? h('div.scn-track-big' + (rate >= 60 ? '.good' : rate <= 40 ? '.bad' : ''), h('b', rate + '%'), h('small', '按影响加权的命中'))
          : h('div.scn-track-big.early', { title: `命中率要攒够 ${TRACK_MIN_DAYS} 个完整交易日才有意义` },
            h('b', td && td.days ? `才 ${td.days} 天` : '刚开始'), h('small', td && td.partial ? `${cnDay(td.partial)} 还是盘中数据，先别看命中率` : '先别看命中率')),
        h('div.scn-track-nums',
          td ? h('span', h('b', td.days), ' 个完整交易日') : null,
          h('span', '命中 ', h('b', t.hit ?? 0), ' · 失手 ', h('b', t.miss ?? 0)),
          t.flowHit != null ? h('span', '钱的方向对了 ', h('b', t.flowHit)) : null)),
      say(t) ? h('p.scn-track-say', say(t)) : null);
  }

  // ================================================================== side-panel section (outside the mode)
  if (app.panel && typeof app.panel.addSection === 'function') {
    try {
      app.panel.addSection({
        id: 'scenario', title: '推演', order: 120,
        render(el) {
          const wrap = h('div.scn-scope.scn-psec');
          if (S.result) {
            wrap.append(h('div.scn-psec-active',
              h('span', '正在看推演：', h('b', S.result.title || '')),
              h('button.scn-link', { type: 'button', onclick: exit }, '退出')));
          } else {
            wrap.append(h('button.scn-psec-cta', { type: 'button', onclick: () => openComposer() },
              icon('foresee'),
              h('span.scn-psec-cta-t', h('b', '如果你的判断成真…'), h('small', '写一句带日期的话，看钱会从哪流到哪、市场还没算到哪')),
              icon('chev', 'scn-psec-chev')));
            if (S.saved && S.saved.length) wrap.append(savedBlock('panel'));
            else if (!S.saved) loadSaved().then((l) => { if (l && l.length) refreshPanel(); });
          }
          el.append(wrap);
        },
      });
    } catch (e) { console.warn('[scenario] panel.addSection', e); }
  }

  // ================================================================== events from the shell
  const onNode = () => {
    if (!S.result) return;
    const id = app.state?.nodeId;
    if (id === S.lastNodeId) return;
    S.lastNodeId = id;
    applyOverlay();   // a planet may drop overlays on setNode; giving it again is cheap
  };
  app.on?.('node', onNode);
  app.on?.('nav-done', () => { onNode(); if (S.result) applyAttention(); });
  app.on?.('date-settled', () => { if (S.result) applyAttention(); });
  app.on?.('picks', () => { if (S.result) applyAttention(); });
  app.on?.('theme', (t) => {
    const th = typeof t === 'string' ? t : theme();
    for (const el of roots) el.dataset.theme = th;
  });
  app.on?.('map', () => {
    // a 推演 is computed on the curated map's ids: leave it before the full-market map comes up
    if (S.result && app.state?.map && app.state.map !== 'curated') { exit(); app.toast?.('推演是按精选地图算的，切到全市场时先退出推演'); }
  });
  app.on?.('voice', () => { if (drawer) renderDrawer(); });
  app.on?.('dataReloaded', () => { S.saved = null; savedP = null; loadSaved().then(syncBadge); });
  app.on?.('scenario-open', (id) => { if (id) fetchResult(id).then((r) => r && enter(r, { fly: true })); });

  // a planet that arrives later (or is swapped) gets the overlay again
  const t0 = performance.now();
  const late = setInterval(() => {
    if (performance.now() - t0 > 20_000) { clearInterval(late); return; }
    if (S.result && planet() && typeof planet().setOverlay === 'function' && badgeLayer) applyOverlay();
  }, 1000);

  // deep link for sharing / screenshots: ?scenario=<id>[&stage=1-3m]
  const qs = new URLSearchParams(location.search);
  const want = qs.get('scenario');
  if (want) {
    fetchResult(want).then((r) => {
      if (!r) return;
      const st = qs.get('stage');
      enter(r, { fly: false, stage: LAGS.includes(st) ? st : null });
    });
  }
  loadSaved().then((list) => {
    // a 推演 still running from before a reload: keep watching it in the background
    const run = (list || []).find((x) => x.state === 'queued' || x.state === 'running');
    if (run && !S.job) {
      S.job = { id: run.id, text: run.root?.text || run.title || '', date: run.root?.date, tier: run.root?.tier, state: run.state,
        stage: run.stage, t0: Date.now(), seenAt: Date.now() };
      poll();
    }
    syncBadge();
  });

  // a small handle for other modules (intel badges, scout) — read-only use
  app.scenario = {
    open: (id) => fetchResult(id).then((r) => r && enter(r, { fly: true })),
    compose: (prefill) => openComposer(prefill || null),
    exit,
    current: () => S.result,
    stage: () => S.stage,
    setStage,
    list: () => loadSaved(true),
  };
  return app.scenario;
}

// ============================================================================ stylesheet
function ensureCss() {
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /(^|\/)css\/scenario\.css(\?|$)/.test(l.getAttribute('href') || ''));
  if (has || document.querySelector('link[data-mw="scenario-css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../css/scenario.css', import.meta.url).href;
  l.dataset.mw = 'scenario-css';
  document.head.append(l);
}
