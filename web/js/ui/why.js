// why.js — 为什么？ (DESIGN.md §21, §24). Every flow gets a reason, on click, in place.
//
//   app.why(target, anchorEl?, opts?)      → opens the reason card next to anchorEl (or a sensible spot)
//   app.whyButton(target, {label, cls, title}) → the one consistent small "为什么？" button (§17), for any module
//
// target: {kind:'node'|'stock'|'edge'|'channel'|'day'|'landing'|'market', ids:[…], dateIndex?, map?}
//         or shorthand: a node id ('ai-memory', 's:MU') / a node object. dateIndex + map default to the app's.
//         target may also be a function returning one (evaluated on click).
//
// Flow (§24): the same target on the same data day is cached by the server — reopening is free:
//   1. this page already has the answer → shown at once;
//   2. we know the server key from an earlier answer → GET /api/why/peek?key= (cache only, free);
//   3. POST /api/why {target} → {state:'cached', card} | {id, state:'queued', pos} → GET /api/why?id= until done.
// While waiting the card says so in place — "老风派人去查了… 排队第 N" / "正在网上查…" — never a silent nothing.
// Closing the card does not cancel anything: when the answer lands, a toast offers to open it.
// Facts carry dates + source links; the opinion is only the one sharp sentence on top (§12).
import { h, clear, icon, richText, cnDate, store, clamp } from './dom.js';
import { toast } from './toast.js';

const KEYS = 'mw.whyKeys';                  // target signature → server cache key (peek after a reload)
const TYPE = { news: '新闻', earnings: '财报', macro: '宏观', policy: '政策', 'flow-mechanics': '资金面', flow: '资金面', rumor: '传闻', data: '数据', filing: '公告' };
const KIND_LABEL = { node: '这块地', stock: '这只股票', edge: '这条关系', channel: '主航道', day: '那一天', landing: '这个落点', market: '这个预言市场' };
const W = 384;                              // card width (px)
const SLOW_MS = 8 * 60_000;                 // after this: "查得有点久"; polling continues (slower) until 25 min
const GIVE_UP_MS = 25 * 60_000;

// ---------------------------------------------------------------- small formatting helpers
function fmtDay(s) {
  if (!s) return '';
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const thisYear = String(new Date().getFullYear());
    return cnDate(`${m[1]}-${m[2]}-${m[3]}`, false, m[1] !== thisYear);
  }
  m = str.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[1] !== String(new Date().getFullYear()) ? m[1] + '年' : ''}${+m[2]}月`;
  return str.length > 16 ? str.slice(0, 16) : str;
}
function ago(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 120) return '刚查的';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前查的`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} 小时前查的`;
  return `${Math.round(s / 86400)} 天前查的`;
}
function secs(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}
function safeUrl(u) {
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; }
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
/** Chinese text with ASCII punctuation from the model ("冲到18.22:收在", "Twist(TWST)也是") → full-width where it sits
 *  between Chinese characters. Numbers and times ("13:30", "1,055") are left alone. */
const CJK = '\\u3400-\\u9fff';
const zhPunct = (t) => String(t)
  .replace(new RegExp(`([${CJK}）】」])\\s*:\\s*`, 'g'), '$1：')
  .replace(new RegExp(`:\\s*(?=[${CJK}【「])`, 'g'), '：')
  .replace(new RegExp(`([${CJK}])\\s*,\\s*(?=[${CJK}])`, 'g'), '$1，')
  .replace(new RegExp(`([${CJK}A-Za-z])\\(([^()]{1,40})\\)([${CJK}，。；、]?)`, 'g'), (m, a, b, c) => (CJK_RX.test(a + b + c) ? `${a}（${b}）${c}` : m));
const CJK_RX = new RegExp(`[${CJK}]`);
const asText = (x) => zhPunct(x == null ? '' : typeof x === 'string' ? x : x.text || x.say || x.what || '');
const byDateDesc = (a, b) => String(b?.date || '').localeCompare(String(a?.date || ''));

// 量到的: one column of labelled rows (怎么了 / 多少钱 / 从哪天 / 比邻居), first 2 shown, the rest behind 展开;
// a number keeps its unit on one line; ASCII '-' before a digit → '−'; no colour emoji; raw z-scores folded to words
const FACT_ROWS = [['what', '怎么了'], ['howMuch', '多少钱'], ['since', '从哪天'], ['vsNeighbours', '比邻居']];
const NOWRAP_RX = /((?:[\u3400-\u9fff]{1,2}\s?)?[+\-−–~约]?\d[\d.,]*\s*(?:%|％|亿美元|万美元|美元|亿|万|天|个交易日|个点|个|倍|年|月|日|号|bp)?)/g;
const EMOJI_RX = /\p{Extended_Pictographic}\uFE0F?/gu;
function factText(x) {
  return asText(x)
    .replace(EMOJI_RX, '')
    .replace(/(温度)\s*[+\-−]?\d+(?:\.\d+)?\s*[（(]([^）)]{1,8})[）)]/g, '$1$2')
    .replace(/(^|[^\d\w.])-(?=\d)/g, '$1−')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function nowrapNodes(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(NOWRAP_RX)) {
    if (!/\d/.test(m[1])) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span.why-nw', m[1]));
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function factsBox(f) {
  const rows = FACT_ROWS.map(([k, label]) => {
    let v = factText(f?.[k]);
    if (k === 'since' && v && !/起|以来|从/.test(v)) v = `从${v}起`;
    return v ? h('div.why-fact', h('span.why-fact-k', label), h('span.why-fact-v', nowrapNodes(v))) : null;
  }).filter(Boolean);
  if (!rows.length) return null;
  const box = h('div.why-facts', h('span.why-facts-k', '量到的'), rows.slice(0, 2));
  if (rows.length > 2) {
    const rest = rows.slice(2);
    rest.forEach((r) => { r.hidden = true; });
    box.append(...rest, h('button.why-facts-more', { type: 'button', onclick: (e) => { e.stopPropagation(); rest.forEach((r) => { r.hidden = false; }); e.currentTarget.remove(); } }, `展开（还有 ${rest.length} 条）`));
  }
  return box;
}

/** "明天 0 点" / "今天 18 点" from an ISO reset time, in the owner's local time. */
function resetWords(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return '明天';
  const d = new Date(t), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const hh = d.getHours(), mm = d.getMinutes();
  const at = `${hh} 点${mm ? ` ${mm} 分` : ''}`;
  return `${diff <= 0 ? '今天' : diff === 1 ? '明天' : `${d.getMonth() + 1}月${d.getDate()}日`} ${at}`;
}

export function initWhy(app) {
  const D = app.data || app.D;
  const jobs = new Map();          // sig → job
  let pop = null;                  // {el, body, sig, rect, inPanel}
  let hb = null, hbAt = 0;         // heartbeat (budget: usdPerPct, leftPct, resetsAt)
  let tick = 0;

  // ---------------------------------------------------------------- targets
  function nodeOf(id) { return id ? D.nodeById(id) : null; }
  function normTarget(t) {
    if (typeof t === 'function') t = t();
    if (t == null) return null;
    if (typeof t === 'string') t = { ids: [t] };
    else if (t.id && !t.ids && !t.kind) t = { ids: [t.id] };
    const ids = (Array.isArray(t.ids) ? t.ids : t.id ? [t.id] : []).filter((x) => x != null && x !== '').map(String);
    if (!ids.length && t.kind !== 'channel') return null;
    const kind = t.kind || (ids[0]?.startsWith('s:') ? 'stock' : 'node');
    // stocks travel as tree ids ("s:MU"); a bare ticker for a stock target gets the prefix
    const normIds = kind === 'stock' ? ids.map((x) => (x.startsWith('s:') ? x : 's:' + x.toUpperCase())) : ids;
    const dateIndex = Number.isInteger(t.dateIndex) ? t.dateIndex : app.state.dateIndex;
    const out = { ...t, kind, ids: normIds, dateIndex, map: t.map || app.state.map || 'curated' };
    out.date = t.date || app.meta?.dates?.[dateIndex] || null;
    if (!out.name) out.name = labelOf(out);
    return out;
  }
  function labelOf(t) {
    const nm = (id) => {
      const n = nodeOf(id);
      if (!n) return String(id).replace(/^s:/, '');
      return n.kind === 'stock' && n.ticker && n.name !== n.ticker ? `${n.name}（${n.ticker}）` : n.name;
    };
    if (t.label) return t.label;
    if (t.kind === 'channel') return t.ids.length >= 2 ? `主航道：${nm(t.ids[0])} → ${nm(t.ids[1])}` : '今天的主航道';
    if (t.kind === 'edge' && t.ids.length >= 2) return `${nm(t.ids[0])} ↔ ${nm(t.ids[1])}`;
    if (t.kind === 'day') return `${nm(t.ids[0])} · ${fmtDay(t.date)}`;
    return t.ids.map(nm).join(' · ') || KIND_LABEL[t.kind] || '这里';
  }
  const sigOf = (t) => [t.kind, t.ids.join('+'), t.date || t.dateIndex, t.map].join('|');
  /** what goes over the wire (§24 shape + a few helpful extras the server may use) */
  function wire(t) {
    const out = { kind: t.kind, ids: t.ids, dateIndex: t.dateIndex, map: t.map };
    if (t.date) out.date = t.date;
    if (t.name) out.name = t.name;
    for (const k of ['ticker', 'edge', 'day', 'market', 'scenario', 'extra']) if (t[k] != null) out[k] = t[k];
    if (t.kind === 'stock' && !out.ticker) out.ticker = t.ids[0].slice(2);
    return out;
  }

  const savedKeys = () => { const v = store.get(KEYS, {}); return v && typeof v === 'object' ? v : {}; };
  function rememberKey(sig, key) {
    if (!key) return;
    const all = savedKeys();
    all[sig] = key;
    const ks = Object.keys(all);
    if (ks.length > 300) for (const k of ks.slice(0, ks.length - 300)) delete all[k];
    store.set(KEYS, all);
  }

  // ---------------------------------------------------------------- budget (from the 💓 heartbeat / gateway)
  let budgetApi = true;
  async function budget() {
    if (hb && Date.now() - hbAt < 60_000) return hb;
    hbAt = Date.now();
    // the gateway's own status first (common/claude_gate.budget_status via GET /api/budget), then the 💓 heartbeat
    if (budgetApi) {
      const b = await D.api('budget');
      if (b && !b.error && (b.capPts != null || b.usedPts != null)) {
        hb = {
          usdPerPct: b.usdPerPt ?? null, usedPct: b.usedPts ?? null, capPct: b.capPts ?? 6,
          leftPct: b.capPts != null && b.usedPts != null ? b.capPts - b.usedPts : null,
          resetsAt: b.resetsAtLocal || b.resetsAt || null, estimate: !b.calibrated,
        };
        return hb;
      }
      if (b?.error === 'no-server') budgetApi = false;
    }
    const r = await D.api('heartbeat');
    if (r && !r.error) {
      const u = r.usage || r.budgetStatus || r.gate || {};
      hb = {
        usdPerPct: u.usdPerPct ?? u.usdPerPt ?? null,
        usedPct: u.pct ?? u.usedPts ?? null,
        capPct: u.capPct ?? u.capPts ?? 6,
        leftPct: u.leftPct ?? (u.capPts != null && u.usedPts != null ? u.capPts - u.usedPts : null),
        resetsAt: u.resetsAt || u.resetsAtLocal || null,
        estimate: u.estimate ?? !u.calibrated,
      };
    }
    return hb;
  }
  function costWords(usd) {
    if (usd == null || !isFinite(usd)) return '';
    if (usd <= 0) return '没花额度（老风的笔记里有）';
    const per = hb?.usdPerPct;
    if (per > 0) {
      const pts = usd / per;
      return `花了约 ${pts < 0.1 ? pts.toFixed(2) : pts.toFixed(1)} 个点`;
    }
    return `花了约 $${usd.toFixed(2)}`;
  }

  // ---------------------------------------------------------------- jobs
  function getJob(t) {
    const sig = sigOf(t);
    let j = jobs.get(sig);
    if (!j) { j = { sig, target: t, state: 'idle', id: null, pos: null, card: null, error: null, startedAt: 0, timer: 0, watched: false }; jobs.set(sig, j); }
    else j.target = t;
    return j;
  }
  function update(j) {
    if (pop && pop.sig === j.sig) render();
  }
  function done(j, card, { cached = false } = {}) {
    clearTimeout(j.timer);
    j.state = 'done';
    j.card = card;
    j.cached = cached;
    j.error = null;
    if (card?.key) rememberKey(j.sig, card.key);
    update(j);
    if (!(pop && pop.sig === j.sig) && j.watched) {
      toast(`老风查到了：「${j.target.name}」为什么会这样`, 8000, { action: { label: '看看', fn: () => app.why(j.target) } });
    }
    j.watched = false;
    app.emit?.('why', { target: j.target, card, cached });
  }
  function fail(j, state, error) {
    clearTimeout(j.timer);
    j.state = state;
    j.error = error;
    update(j);
    if (!(pop && pop.sig === j.sig) && j.watched && state === 'error') toast(`「${j.target.name}」没查成：${error || '出错了'}`, 5200);
    j.watched = false;
  }
  function isBudget(r) {
    const e = String(r?.error || r?.refused || r?.reason || '');
    return r?.refused === 'budget' || r?.state === 'refused' || /budget|额度/.test(e);
  }
  const posOf = (r) => {
    const p = r?.pos ?? r?.position ?? r?.queuePos ?? r?.queue?.pos ?? (r?.ahead != null ? r.ahead + 1 : null);
    return Number.isFinite(+p) && p != null ? +p : null;
  };

  async function start(j, { force = false } = {}) {
    clearTimeout(j.timer);
    j.state = 'asking'; j.error = null; j.pos = null; j.startedAt = Date.now(); j.id = null;
    if (force) j.card = null;
    update(j);
    // free first: a key from an earlier answer → peek the server's cache
    if (!force) {
      const key = savedKeys()[j.sig];
      if (key) {
        const r = await D.whyPeek(key);
        const card = r?.card || (r?.say || r?.reasons ? r : null);
        if (card && !r.error) { done(j, card, { cached: true }); return; }
      }
    }
    const r = await D.whyAsk(wire(j.target), { force });
    if (r.error) {
      if (isBudget(r)) return fail(j, 'budget', r.error);
      if (r.error === 'no-server') {
        const st = await D.getStatus();
        return fail(j, st && !st.error ? 'nobackend' : 'noserver', r.error);
      }
      return fail(j, 'error', typeof r.error === 'string' ? r.error : '服务器没回应');
    }
    if (isBudget(r)) return fail(j, 'budget', r.error || r.reason);
    if (r.card && (r.state === 'cached' || r.state === 'stale' || r.state === 'done' || !r.id)) { done(j, r.card, { cached: r.state === 'cached' || r.state === 'stale' }); return; }
    if (!r.id) return fail(j, 'error', '服务器没给排队号');
    j.id = r.id;
    j.state = r.state === 'running' ? 'running' : 'queued';
    j.pos = posOf(r);
    j.concurrent = Number.isFinite(+r.concurrent) ? +r.concurrent : null;
    j.watched = true;
    update(j);
    poll(j, 0);
  }

  function poll(j, n) {
    clearTimeout(j.timer);
    const age = Date.now() - j.startedAt;
    if (age > GIVE_UP_MS) return fail(j, 'error', '查了 25 分钟还没回来，先放弃。可以再点一次重新查。');
    const wait = age > SLOW_MS ? 10_000 : [1200, 1500, 2000, 2500, 3000][n] || 4000;
    j.timer = setTimeout(async () => {
      const r = await D.whyJob(j.id);
      if (r.error && !r.state) {
        if (isBudget(r)) return fail(j, 'budget', r.error);
        if (r.status === 404) return fail(j, 'error', '排队号丢了（服务器可能重启了）。再点一次重新查。');
        // connection refused / no answer: the server is most likely restarting — the job lives on disk
        // (why/out/jobs), so keep asking for about 2 minutes before giving up
        if (!j.downSince) j.downSince = Date.now();
        if (Date.now() - j.downSince > 120_000) return fail(j, 'error', '服务器两分钟都没回来。等它起来以后再点一次（查过的答案不会丢）。');
        j.stage = '服务器在重启，继续等…';
        update(j);
        return poll(j, Math.min(n + 1, 5));
      }
      j.downSince = 0;
      if (r.state === 'unknown') return fail(j, 'error', '排队号丢了（服务器可能重启了）。再点一次重新查。');
      const st = String(r.state || '');
      if ((st === 'done' || st === 'cached') && r.card) return done(j, r.card, { cached: st === 'cached' });
      if (st === 'error' || st === 'failed' || st === 'refused') return fail(j, isBudget(r) ? 'budget' : 'error', r.error || r.reason || '没查成');
      j.state = st === 'running' || st === 'searching' ? 'running' : 'queued';
      j.pos = posOf(r);
      j.concurrent = Number.isFinite(+r.concurrent) ? +r.concurrent : null;
      j.stage = r.stage || null;
      update(j);
      poll(j, n + 1);
    }, wait);
  }

  // ---------------------------------------------------------------- the card
  function head(t) {
    return h('div.why-head',
      h('span.why-k', icon('help', { size: 14 }), '为什么？'),
      h('span.why-title', { title: t.name }, t.name),
      t.date ? h('span.why-date', fmtDay(t.date)) : null,
      h('button.why-x', { type: 'button', title: '关上（Esc）。正在查的不会停。', 'aria-label': '关闭', onclick: () => close() }, icon('close', { size: 14 })));
  }

  function waiting(j) {
    const el = [];
    const age = Date.now() - (j.startedAt || Date.now());
    if (j.state === 'asking') {
      el.push(h('p.why-wait', h('span.why-dot'), '先翻翻老风的笔记…'));
    } else if (j.state === 'queued') {
      // no count / concurrency limit (owner's rule): nothing waits in line, others may be searching at once
      el.push(h('p.why-wait', h('span.why-dot'), j.stage || '老风派人去查了…'));
      el.push(h('p.why-sub', j.concurrent > 0 ? `同时在查的还有 ${j.concurrent} 个，不用排队 · 已等 ${secs(age)}` : `已等 ${secs(age)}`));
    } else {
      el.push(h('p.why-wait', h('span.why-dot.live'), j.stage && /重启/.test(j.stage) ? j.stage : '正在网上查…', h('span.why-elapsed', secs(age))));
      el.push(h('p.why-sub', age > SLOW_MS ? '查得有点久——新闻少的时候会这样。答案到了会出现在这里。' : '照量到的日期去搜新闻、财报和公告，一般 1–3 分钟。'));
    }
    el.push(h('div.why-bar', h('i')));
    el.push(h('p.why-note', '关掉也没关系，查到了会在下面提醒你。'));
    return el;
  }

  function problem(j) {
    const t = j.target;
    if (j.state === 'budget') {
      if (typeof app.budgetRefusal === 'function') {
        const m = app.budgetRefusal({ error: j.error });
        return [h('p.why-say.muted', m.main), m.extra ? h('p.why-sub', m.extra) : null].filter(Boolean);
      }
      const when = resetWords(hb?.resetsAt);
      return [h('p.why-say.muted', j.error && /额度/.test(j.error) ? j.error : `今天的额度用完了（${when}恢复）`)];
    }
    if (j.state === 'noserver') {
      return [h('p.why-say.muted', '「为什么」要用 server.py 打开本页才能查'),
        h('p.why-sub', '在项目目录运行 python3 server.py，再从 http://localhost:8765 打开。')];
    }
    if (j.state === 'nobackend') {
      return [h('p.why-say.muted', '「为什么」的后台还没装好'),
        h('p.why-sub', 'server.py 还没有 /api/why（why/ 模块）。装好以后这个按钮就能用了。'),
        h('div.why-actions', h('button.why-btn', { type: 'button', onclick: () => { close(); app.ask?.('ask', t.ids[0], `${t.name}最近为什么是这样的天气？`); } }, icon('scout', { size: 14 }), '先派侦察兵去查'))];
    }
    return [h('p.why-say.muted', '没查成'),
      h('p.why-sub', String(j.error || '出了点问题')),
      h('div.why-actions', h('button.why-btn', { type: 'button', onclick: () => start(j, { force: true }) }, icon('refresh', { size: 14 }), '再查一次'))];
  }

  function answer(j) {
    const c = j.card || {};
    const out = [];
    const say = zhPunct((app.say ? app.say(c, 'say') : c.say) || '');
    if (say) out.push(h('p.why-say', richText(say)));
    // what was measured (numbers stay separate from the opinion, §12)
    // live flags from the server (why/job.py annotate): researched mid-session / numbers moved / old model / old day
    const flags = [c.stale?.say || (c.snapshot?.partial ? c.snapshot.say : null), c.old?.say, c.recheck?.say].filter(Boolean);
    if (flags.length) out.push(h('div.why-flags', flags.map((x) => h('p.why-flag', icon('since', { size: 12 }), h('span', x)))));
    if (c.stale?.ask) {
      out.push(h('p.why-ask', h('span', `现在该问的是：${zhPunct(String(c.stale.ask).replace(/[【】]/g, ''))}`),
        h('button.why-btn.small', { type: 'button', onclick: () => start(j, { force: true }) }, icon('refresh', { size: 13 }), '按今天重新查')));
    }
    const fb = factsBox(c.facts || {});
    if (fb) out.push(fb);
    // reasons, newest first
    const reasons = (Array.isArray(c.reasons) ? c.reasons.slice() : []).filter((r) => asText(r)).sort(byDateDesc);
    if (reasons.length) {
      out.push(h('div.why-sec', '原因'));
      out.push(h('ol.why-reasons', reasons.map((r) => reasonRow(r))));
    } else if (!c.honest) {
      out.push(h('p.why-sub', '没找到能对上日期的新闻。'));
    }
    const counter = (Array.isArray(c.counter) ? c.counter : c.counter ? [c.counter] : []).filter((x) => asText(x));
    if (counter.length) {
      out.push(h('div.why-sec', '反方'));
      out.push(h('ul.why-list.counter', counter.map((x) => h('li', h('span', asText(x)), sourceBits(x)))));
    }
    const watch = (Array.isArray(c.watch) ? c.watch : []).filter((x) => asText(x) || x?.what);
    if (watch.length) {
      out.push(h('div.why-sec', '接下来盯'));
      out.push(h('ul.why-list.watch', watch.map((x) => h('li', x.by ? h('span.why-by', fmtDay(x.by) + (/^\d{4}-\d{2}/.test(String(x.by)) ? ' 前' : '')) : null, h('span', asText(x) || x.what)))));
    }
    if (c.honest) out.push(h('p.why-honest', icon('check', { size: 13 }), h('span', h('b', '老实说：'), asText(c.honest))));
    // footer: age · cost · 重新查
    const bits = [ago(c.at), j.cached ? '没花额度（缓存）' : costWords(c.usd)].filter(Boolean);
    const left = hb?.leftPct;
    out.push(h('div.why-foot',
      h('span.why-meta', bits.join(' · ')),
      h('button.why-again', {
        type: 'button',
        title: `重新上网查一遍（会再花一点额度${left != null ? `，今天还剩约 ${(+left).toFixed(1)} 个点` : ''}）`,
        onclick: () => start(j, { force: true }),
      }, icon('refresh', { size: 13 }), '重新查')));
    return out;
  }

  function sourceBits(r) {
    if (!r || typeof r !== 'object') return null;
    const url = safeUrl(r.url);
    const src = r.source || (url ? host(url) : '');
    const bits = [];
    if (r.date) bits.push(h('span.why-when', fmtDay(r.date)));
    if (src || url) {
      bits.push(url
        ? h('a.why-src', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, src || host(url), icon('ext', { size: 11 }))
        : h('span.why-src', src));
    }
    if (r.type && TYPE[r.type]) bits.push(h('span.why-type.' + String(r.type).replace(/[^a-z-]/g, ''), TYPE[r.type]));
    if (r.conf != null && +r.conf < 0.5 && r.type !== 'rumor') bits.push(h('span.why-type.weak', { title: `可信度 ${Math.round(+r.conf * 100)}%` }, '存疑'));
    return bits.length ? h('span.why-meta-row', bits) : null;
  }
  function reasonRow(r) {
    return h('li.why-reason' + (r.type === 'rumor' || (r.conf != null && +r.conf < 0.5) ? '.weak' : ''),
      h('span.why-text', asText(r)), sourceBits(r));
  }

  function render() {
    if (!pop) return;
    const j = jobs.get(pop.sig);
    if (!j) return;
    const body = j.state === 'done' ? answer(j)
      : ['asking', 'queued', 'running'].includes(j.state) ? waiting(j)
        : problem(j);
    clear(pop.el).append(head(j.target), h('div.why-body', body));
    pop.el.classList.toggle('busy', ['asking', 'queued', 'running'].includes(j.state));
    pop.el.setAttribute('aria-busy', String(['asking', 'queued', 'running'].includes(j.state)));
    place();
  }

  // ---------------------------------------------------------------- placement (in place, never off-screen)
  function place() {
    if (!pop) return;
    const el = pop.el, vw = innerWidth, vh = innerHeight;
    const top0 = (document.getElementById('topbar')?.getBoundingClientRect().bottom || 56) + 8;
    const tm = document.getElementById('timebar')?.getBoundingClientRect();
    const bottom0 = (tm && tm.height ? tm.top : vh) - 8;
    const w = Math.min(W, vw - 24);
    el.style.width = w + 'px';
    el.style.maxHeight = Math.max(160, bottom0 - top0) + 'px';
    const H = el.offsetHeight;
    const r = pop.rect;
    let x, y;
    if (!r) {                                    // no anchor: beside the panel, upper middle
      const pr = document.getElementById('panel')?.getBoundingClientRect();
      x = app.panelOpen && pr?.width ? pr.left - w - 12 : vw - w - 24;
      y = top0 + 40;
    } else if (pop.side === 'left') {            // anchor in the side panel: sit just left of the panel
      const pr = document.getElementById('panel').getBoundingClientRect();
      x = pr.left - w - 12;
      y = r.top - 14;
    } else {
      x = r.left - 8;
      const below = r.bottom + 8, above = r.top - H - 8;
      y = below + H <= bottom0 ? below : above >= top0 ? above : below;
      if (below + H > bottom0 && above < top0 && r.right - r.left >= 3) {
        // too tall for above / below (a small screen): beside the anchor on the roomier side, never on top of
        // what was clicked (a day's bar in the river must stay visible next to its reasons)
        const right = r.right + 14, left = r.left - w - 14;
        x = right + w <= vw - 12 ? right : left >= 12 ? left : (vw - r.right > r.left ? right : left);
        y = r.top - 60;
      }
    }
    x = clamp(x, 12, vw - w - 12);
    y = clamp(y, top0, Math.max(top0, bottom0 - H));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function open(target, anchorEl = null, opts = {}) {
    const t = normTarget(target);
    if (!t) { toast('这里没有可以查的东西'); return null; }
    const j = getJob(t);
    let rect = null, side = 'below';
    const a = anchorEl && anchorEl.getBoundingClientRect ? anchorEl : null;
    if (a && a.isConnected) {
      const rr = a.getBoundingClientRect();
      if (rr.width || rr.height) rect = { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom };
      if (a.closest('#panel')) side = 'left';
    } else if (opts.rect) rect = opts.rect;
    if (!pop) {
      const el = h('div.why-card', { role: 'dialog', 'aria-label': '为什么' });
      document.body.append(el);
      pop = { el };
      requestAnimationFrame(() => pop?.el.classList.add('on'));
    }
    pop.sig = j.sig; pop.rect = rect; pop.side = side;
    budget().then(() => { if (pop && pop.sig === j.sig) render(); });
    if (j.state === 'idle' || (j.state !== 'done' && !['asking', 'queued', 'running'].includes(j.state) && opts.retry !== false)) start(j);
    render();
    clearInterval(tick);
    tick = setInterval(() => { const jj = pop && jobs.get(pop.sig); if (jj && ['queued', 'running', 'asking'].includes(jj.state)) render(); }, 1000);
    pop.el.querySelector('.why-x')?.focus({ preventScroll: true });
    return { close, target: t };
  }

  function close() {
    if (!pop) return false;
    clearInterval(tick);
    const el = pop.el;
    pop = null;
    el.classList.remove('on');
    setTimeout(() => el.remove(), 180);
    return true;
  }

  // outside click closes (another 为什么 button just re-targets the card)
  document.addEventListener('pointerdown', (e) => {
    if (!pop) return;
    const t = e.target;
    if (pop.el.contains(t) || (t.closest && t.closest('[data-why]'))) return;
    if (t.closest && t.closest('#toast')) return;
    close();
  }, true);
  addEventListener('resize', () => place());

  /** The one consistent "为什么？" affordance (§17/§21). target may be a function (evaluated on click). */
  function button(target, { label = '为什么？', cls = '', title = '让老风上网查：为什么会这样（带日期和出处）', iconOnly = false } = {}) {
    const b = h('button.why-link' + (cls ? '.' + cls.split(/\s+/).join('.') : ''), {
      type: 'button', title, 'aria-label': '为什么？', dataset: { why: '1' },
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); app.why(typeof target === 'function' ? target() : target, b); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); },
      onpointerdown: (e) => e.stopPropagation(),
    }, iconOnly ? icon('help', { size: 14 }) : label);
    return b;
  }

  app.why = open;
  app.whyButton = button;
  app.whyClose = close;
  return { open, close, button, isOpen: () => !!pop, jobs: () => [...jobs.values()] };
}
