// scout.js — 🔎 侦察兵 (DESIGN.md §15): the panel that shows what Claude was sent to find out (data/scout_log.json),
// the jobs still out in the field, and the app.ask(kind, target, question) entry point every "🔎 让 Claude 去查"
// button uses → POST /api/scout → poll GET /api/scout?id= → result.
//
// Phase 3 (owner's bug list): every job shows its live state — 排队中，前面还有 N 个 · 正在网上查… · 回来了 — and the
// answer is delivered WHERE THE OWNER CLICKED (a small card next to the button, or floating at the click point when
// the button lived in a menu that closed), not only in this panel. When a job comes back "invalid" (the answer
// failed validation: not Chinese, placeholder, no sources) the retry is shown automatically: we follow the
// server's own retry when it reports one (retryId / state "retrying"), else send exactly one retry ourselves.
// Every finished job is announced with app.emit('scoutDone', job) so other modules (关系网, stock view…) can land it.
//
// Server routes (scout/job.py): POST /api/scout {kind, target, question, force, retryOf?} → {id, state:'queued', ahead?} |
// {state:'cached', …answer} | {error, refused?:'budget'} · GET /api/scout?id= → {state, ahead?|position?, attempts?,
// retryId?, error?, say, answer, sources…} · GET /api/scout/log?limit= · GET /api/scout/usage → {queued, running, …}
import {
  h, icon, api, dataFile, every, A, nameOf, go, toast, onAny, syncTheme, topButton, openSheet, sheetCtl,
  store, clock, shq, touchesPart, budgetLine, budgetOutNote, refusedForBudget, budgetRefusal,
} from './heartbeat.js';

const KIND = { explain: '解释异动', gap: '补数据', verify: '核对', ask: '你问的' };
const DONE = new Set(['done', 'failed', 'invalid', 'cancelled', 'expired', 'cached', 'unknown', 'error', 'skipped', 'refused']);
const OK = new Set(['done', 'cached']);
const JOBS_KEY = 'mw.scout.jobs';
const POLL_MS = 2500;
const CLICK_FRESH_MS = 2500;       // a button press this recent is "where the owner clicked"
const MAX_AGE_MS = 40 * 60_000;
const VALIDATION_RE = /校验|不是中文|中文|placeholder|占位|JSON|格式|invalid|没有可靠来源|sources?/i;

export function init(app) {
  syncTheme(app);
  const X = () => A(app);
  let log = [];
  let usage = null;
  const jobs = new Map();            // id → job (live / just finished)
  let filter = 'all';
  let target = null;                 // the ask box's subject: node id / "s:MU" / null (whole market)
  let targetTouched = false;
  let draft = '';
  let pollTimer = 0;
  let serverless = false;
  const openDetails = new Set();     // ids whose 「看它找到的」 is open (survives re-renders)
  const landedIds = new Set();       // finished this session → highlighted in the log
  let refs = null;                   // {usage, jobs, log, note} containers of the open sheet
  let askNote = null;                // the last dispatch from the sheet that did not go out: {main, extra, bad} (shown under 派出去)

  const btn = topButton(app, { id: 'scout', icon: 'scout', svg: 'scout', label: '', title: '侦察兵：派 Claude 去网上查，带回来源', order: 50, onClick: () => open() });

  // ---------------------------------------------------------------- where the owner clicked
  let lastClick = null;
  const markClick = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    lastClick = { el, x: e.clientX || r.left + r.width / 2, y: e.clientY || r.top + r.height / 2, t: performance.now() };
  };
  document.addEventListener('pointerdown', markClick, true);
  document.addEventListener('click', (e) => { if (!lastClick || performance.now() - lastClick.t > 400) markClick(e); }, true);

  // ---------------------------------------------------------------- data
  async function loadLog() {
    let j = await dataFile(app, 'scout_log.json');
    if (j && !Array.isArray(j) && Array.isArray(j.log)) j = j.log;
    if (!Array.isArray(j)) {
      const r = await api('api/scout/log?limit=40', { timeout: 8000 });
      j = Array.isArray(r) ? r : r && Array.isArray(r.log) ? r.log : r && Array.isArray(r.entries) ? r.entries : [];
    }
    log = j.filter((e) => e && (e.id || e.question));
  }
  async function loadUsage() {
    const r = await api('api/scout/usage', { timeout: 6000 });
    usage = r && !r.error ? r : usage;
  }
  const saveJobs = () => store.set(JOBS_KEY, [...jobs.values()].filter((j) => !DONE.has(j.state) && !j.replacedBy)
    .map(({ id, kind, target: t, question, startedAt, retryOf, retries }) => ({ id, kind, target: t, question, startedAt, retryOf, retries })));

  // ---------------------------------------------------------------- app.ask
  /** Send the scout. kind: explain|gap|verify|ask. target: node id ("security", "s:MU"), ticker, {type:'edge',…} or null.
   *  With no question for an 'ask', opens the panel with the subject filled in so the owner types the question.
   *  opts: {force, open, anchor: Element | {x, y}, inline: false} — anchor defaults to the button just clicked.
   *  Resolves as soon as the scout is dispatched with {id, state, kind, question, done} — `done` is a promise of
   *  the final job ({state, say, answer, sources, …}, after an automatic retry if the first answer was invalid). */
  async function ask(kind = 'ask', tgt = null, question = '', opts = {}) {
    const { force = false, inline = true } = opts || {};
    kind = KIND[kind] ? kind : 'ask';
    if (kind === 'ask' && !String(question || '').trim()) {
      target = normTarget(tgt); targetTouched = true;
      open({ toggle: false, focus: true });
      return { state: 'waiting-for-question' };
    }
    const spot = inline ? landingSpot(opts && opts.anchor) : null;
    // no spot to answer in (a programmatic call): the panel shows it, except over the stock view
    const openPanel = opts && typeof opts.open === 'boolean' ? opts.open : (!spot && inline && X().state.view !== 'stock');
    const job = { id: 'tmp-' + Date.now(), kind, target: tgt, question, state: 'sending', startedAt: new Date().toISOString(), views: new Set() };
    if (spot) attachView(job, spot);
    renderViews(job);
    const r = await post(job, { force });
    if (r.error && !r.id) {
      job.state = r.refused ? 'refused' : 'error';
      job.error = r.error;
      job.extra = r.extra || '';
      renderViews(job);
      finishLater(job, 30_000);
      if (!job.views.size) toast(app, job.state === 'refused' ? `🔎 ${r.error}` : `侦察兵没派出去：${r.error}`, 4200);
      if (openPanel) open({ toggle: false });
      return r;
    }
    if (openPanel) open({ toggle: false });
    const done = new Promise((resolve) => { job._resolve = resolve; });
    if (job.state === 'cached') {
      await land(job);
      return { ...pub(job), done };
    }
    if (!job.views.size) toast(app, r.duplicate ? '🔎 这个问题侦察兵已经在查了' : `🔎 侦察兵出发了${queueText(job, true)}`, 3200);
    poll();
    return { ...pub(job), duplicate: !!r.duplicate, done };
  }

  /** POST one dispatch for `job` (first try or retry). Fills job.id/state/ahead. Returns the server reply. */
  async function post(job, { force = false, retryOf = null } = {}) {
    const body = { kind: job.kind, target: job.target == null ? null : job.target, question: job.question || null, force: !!force };
    if (retryOf) body.retryOf = retryOf;
    const r = await api('api/scout', { method: 'POST', body, timeout: 20000 });
    if (r.missing || r.offline) {
      const cmd = cliCmd(job.kind, job.target, job.question);
      // connection refused = the server is down for a moment (often a restart): not "static mode" for the rest of the visit
      if (r.offline) return { error: '服务器暂时连不上（可能在重启），过几秒再派一次。', cmd };
      serverless = true;
      return { error: '派侦察兵要用 server.py 打开本页。也可以在终端运行：' + cmd, cmd };
    }
    if (refusedForBudget(r)) {
      const b = app.budget && app.budget.get ? app.budget.get() : null;
      try { app.budget && app.budget.refresh && app.budget.refresh(); } catch (e) { /* ignore */ }
      // the same words on every Claude button (heartbeat.js budgetRefusal): server's sentence + one budget line
      const t = typeof app.budgetRefusal === 'function' ? app.budgetRefusal(r) : budgetRefusal(r, b);
      return { error: t.main, extra: t.extra, refused: 'budget' };
    }
    if (r.error && !r.id) return r;
    const oldId = job.id;
    Object.assign(job, strip(r), { id: r.id || job.id });
    job.state = r.state === 'cached' || r.cached ? 'cached' : (r.state || 'queued');
    if (oldId !== job.id) jobs.delete(oldId);
    // the server handed back a job we already watch (same question still out): one job, every spot it was asked from
    const prev = jobs.get(job.id);
    if (prev && prev !== job) {
      for (const v of prev.views || []) job.views.add(v);
      job._prevResolve = prev._resolve || prev._prevResolve || null;
      job.startedAt = prev.startedAt || job.startedAt;
    }
    jobs.set(job.id, job);
    saveJobs();
    paintBadge();
    renderJobs();
    renderViews(job);
    return r;
  }
  const strip = (r) => { const o = { ...r }; delete o.views; delete o.done; return o; };
  const pub = (j) => ({ id: j.id, state: j.state, kind: j.kind, question: j.question, target: j.target });

  function cliCmd(kind, tgt, q) {
    const t = tgt == null ? '' : typeof tgt === 'object' ? ` --target ${shq(JSON.stringify(tgt))}` : ` --target ${shq(tgt)}`;
    return `python3 scout/job.py start --kind ${kind}${t}${q ? ' --question ' + shq(q) : ''}`;
  }

  // ---------------------------------------------------------------- polling + retry
  function poll() {
    clearTimeout(pollTimer);
    const live = [...jobs.values()].filter((j) => !DONE.has(j.state) && !j.replacedBy && !String(j.id).startsWith('tmp-'));
    if (!live.length) return;
    pollTimer = setTimeout(async () => {
      for (const j of live) {
        const r = await api('api/scout?id=' + encodeURIComponent(j.id), { timeout: 8000 });
        if (r.offline || r.missing) continue;
        const prev = j.state;
        Object.assign(j, strip(r));
        if (r.state === 'unknown' && prev === 'queued' && Date.now() - new Date(j.startedAt).getTime() < 15_000) j.state = prev; // not on disk yet
        if (Date.now() - new Date(j.startedAt).getTime() > MAX_AGE_MS && !DONE.has(j.state)) j.state = 'expired';
        const retryId = r.retryId || (r.retry && r.retry.id) || r.retriedAs || null;
        if (retryId && retryId !== j.id) { follow(j, retryId, r); continue; }
        if (DONE.has(j.state)) {
          if (await maybeRetry(j)) continue;
          await land(j);
        }
        renderViews(j);
      }
      saveJobs();
      paintBadge();
      renderJobs();
      poll();
    }, POLL_MS);
  }

  /** The server retried on its own under a new id: keep the same views, follow the new job. */
  function follow(j, retryId, r) {
    const nj = { id: retryId, kind: j.kind, target: j.target, question: j.question, state: 'queued', startedAt: new Date().toISOString(),
      retryOf: j.id, retries: (j.retries || 0) + 1, firstError: j.error || r.error || '答案没过校验', views: j.views, _resolve: j._resolve, _prevResolve: j._prevResolve };
    j.replacedBy = retryId; j._resolve = null; j.views = new Set();
    jobs.delete(j.id);
    jobs.set(retryId, nj);
    renderViews(nj);
    saveJobs();
  }

  /** First answer failed validation → show it and retry once (the server's dedupe hands back its own retry if it made one). */
  async function maybeRetry(j) {
    const invalid = j.state === 'invalid' || (j.state === 'failed' && VALIDATION_RE.test(String(j.error || '')));
    const already = (j.retries || 0) >= 1 || j.retryOf || (+j.attempts || 0) >= 2 || j.retried === true || j.noRetry;
    if (!invalid || already) return false;
    const firstError = j.error || '答案没过校验';
    const nj = { id: 'tmp-' + Date.now(), kind: j.kind, target: j.target, question: j.question, state: 'sending', startedAt: new Date().toISOString(),
      retryOf: j.id, retries: 1, firstError, views: j.views, _resolve: j._resolve, _prevResolve: j._prevResolve };
    j.replacedBy = nj.id; j._resolve = null; j.views = new Set();
    jobs.delete(j.id);
    jobs.set(nj.id, nj);
    renderViews(nj);
    const r = await post(nj, { force: true, retryOf: j.id });
    if (r.error && !r.id) {
      nj.state = r.refused ? 'refused' : 'failed';
      nj.error = r.error;
      nj.extra = r.extra || '';
      await land(nj);
      return true;
    }
    if (nj.state === 'cached') { await land(nj); return true; }
    return true;
  }

  async function land(j) {
    if (j.landed) return;
    j.landed = true;
    j.finishedAt = j.finishedAt || new Date().toISOString();
    await loadLog();
    if (log.some((e) => e.id === j.id)) { landedIds.add(j.id); openDetails.add(j.id); }
    loadUsage().then(renderUsage);
    renderLog();
    const ok = OK.has(j.state);
    for (const c of [...j.views]) if (!c.isConnected) j.views.delete(c);   // its panel was re-rendered away
    if (!j.views.size) {
      toast(app, ok ? `🔎 侦察兵回来了：${j.say || shortLine(j.line) || '找到了，看面板'}`
        : j.state === 'refused' ? `🔎 ${j.error}` : `🔎 这次没查成：${failText(j)}`, 5200);
    }
    if (ok && (j.kind === 'explain' || (j.changes || []).some((c) => /intel/.test(c.file || '')))) {
      try { if (app.intel && app.intel.reload) await app.intel.reload(); else if (typeof app.reloadData === 'function') await app.reloadData(['intel', 'scout']); } catch (e) { /* ignore */ }
    }
    renderViews(j);
    const out = { ...pub(j), ok, say: j.say || shortLine(j.line) || null, answer: j.answer || j.found || null, sources: j.sources || [],
      changes: j.changes || [], conf: j.conf ?? null, error: ok ? null : failText(j), retryOf: j.retryOf || null, line: j.line || null };
    try { app.emit && app.emit('scoutDone', out); } catch (e) { console.warn('[scout] scoutDone', e); }
    if (j._resolve) { j._resolve(out); j._resolve = null; }
    if (j._prevResolve) { j._prevResolve(out); j._prevResolve = null; }
    finishLater(j, 90_000);
  }
  // keep the finished job visible at the top of the panel for a while, then let the log show it
  const finishLater = (j, ms) => setTimeout(() => { if (jobs.get(j.id) === j) { jobs.delete(j.id); renderJobs(); saveJobs(); } }, ms);
  const shortLine = (s) => String(s || '').split('→').pop().replace(/^\s*找到了[:：]\s*/, '').trim();
  const failText = (j) => {
    const e = j.error || (j.state === 'invalid' ? '答案没过校验（没有可靠来源或不是中文）' : j.state === 'expired' ? '等太久，放弃了' : j.state);
    return j.retryOf ? `重查了一次还是不行：${e}` : e;
  };

  function paintBadge() {
    const n = [...jobs.values()].filter((j) => !DONE.has(j.state)).length;
    btn.setBadge(n ? String(n) : null);
    btn.setState(n ? 'busy' : null);
  }

  // ---------------------------------------------------------------- live state words
  const aheadOf = (j) => {
    for (const k of ['ahead', 'queueAhead', 'before']) if (typeof j[k] === 'number') return Math.max(0, j[k]);
    for (const k of ['position', 'queuePos', 'pos']) if (typeof j[k] === 'number') return Math.max(0, j[k] - 1);
    return null;
  };
  /** "，前面还有 2 个" / "，下一个就是它" / "" */
  function queueText(j, lead = false) {
    if (j.state !== 'queued') return '';
    const a = aheadOf(j);
    if (a == null) return lead ? '' : '';
    return a === 0 ? (lead ? '，下一个就轮到它' : '，下一个就是它') : `，前面还有 ${a} 个`;
  }
  const secsSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)) : 0);
  /** → {tone:'live'|'ok'|'bad'|'retry', text} */
  function stateWords(j) {
    const again = j.retryOf ? '自动重查：' : '';
    switch (j.state) {
      case 'sending': return { tone: j.retryOf ? 'retry' : 'live', text: j.retryOf ? `第一次的答案没过校验（${cut(j.firstError, 26)}），自动再查一次…` : '正在派出去…' };
      case 'queued': {
        const a = aheadOf(j);
        const waiting = j.waiting ? `（${cut(j.waiting, 24)}）` : '';
        return { tone: j.retryOf ? 'retry' : 'live', text: `${again}排队中${a == null ? '' : a === 0 ? '，下一个就是它' : `，前面还有 ${a} 个`}${waiting}` };
      }
      case 'retrying': return { tone: 'retry', text: `第一次的答案没过校验（${cut(j.error || j.firstError, 26)}），正在自动重查…` };
      case 'running': {
        const n = +j.attempts >= 2 && !j.retryOf ? `（第 ${j.attempts} 次）` : '';
        return { tone: j.retryOf ? 'retry' : 'live', text: `${again}正在网上查${n}… ${secsSince(j.startedAtServer || j.startedAt)} 秒` };
      }
      case 'cached': return { tone: 'ok', text: '3 天内查过，直接用上次的结果（没花额度）' };
      case 'done': return { tone: 'ok', text: j.retryOf ? '重查后回来了' : '回来了' };
      case 'refused': return { tone: 'bad', text: j.error || budgetOutNote(app.budget && app.budget.get && app.budget.get()), extra: j.extra || '' };
      default: return { tone: 'bad', text: `没查成：${failText(j)}` };
    }
  }
  const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ---------------------------------------------------------------- in-place delivery
  const TRANSIENT = '.ctxmenu, .menu, [role="menu"], [role="tooltip"], .hovercard, #hovercard, .hc, #toast, .toast, canvas, .p3-lab';
  const FLOW_DISPLAYS = new Set(['block', 'list-item', 'flow-root', 'table-cell']);
  /** Where the answer for this ask should appear: {mode:'inline', after: Element} | {mode:'float', x, y} | null. */
  function landingSpot(anchor) {
    let el = null, x = null, y = null;
    if (anchor instanceof Element) { el = anchor; const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.bottom; }
    else if (anchor && typeof anchor.x === 'number') { x = anchor.x; y = anchor.y; }
    else if (lastClick && performance.now() - lastClick.t < CLICK_FRESH_MS) ({ el, x, y } = lastClick);
    if (el && el.closest && el.closest('#ops-sheet[data-sheet="scout"]')) return null;   // the panel itself shows the job
    if (el && el.isConnected && !el.closest(TRANSIENT)) {
      // the nearest ancestor that sits in normal (vertical) flow and is wide enough to carry a small card
      let c = el.closest('button, a, [role="button"]') || el;
      for (let k = 0; k < 7 && c && c !== document.body; k++) {
        const p = c.parentElement;
        if (!p) break;
        const ps = getComputedStyle(p);
        const vertical = FLOW_DISPLAYS.has(ps.display) || (/flex/.test(ps.display) && /column/.test(ps.flexDirection));
        if (vertical && (c.getBoundingClientRect().width >= 200 || k >= 3)) return { mode: 'inline', after: c };
        c = p;
      }
    }
    if (x == null) return null;
    return { mode: 'float', x, y };
  }

  let floatN = 0;
  function attachView(job, spot) {
    const card = h('div.ops.ops-scard', { role: 'status', 'aria-live': 'polite' });
    card._close = () => { job.views && job.views.delete(card); card.classList.remove('on'); setTimeout(() => card.remove(), 200); };
    if (spot.mode === 'inline') {
      card.classList.add('inline');
      spot.after.after(card);
    } else {
      card.classList.add('float');
      const k = floatN++ % 4;
      document.body.append(card);
      const W = Math.min(320, innerWidth - 24);
      card.style.width = W + 'px';
      // stay on the map: never over the open side panel
      const pr = document.getElementById('panel')?.getBoundingClientRect();
      const right = pr && pr.width && pr.left > W + 40 && getComputedStyle(document.getElementById('panel')).visibility !== 'hidden' ? pr.left - 10 : innerWidth - 12;
      card.style.left = Math.round(Math.max(12, Math.min(right - W, spot.x + 14 + k * 10))) + 'px';
      card.style.top = Math.round(Math.max(64, Math.min(innerHeight - 180, spot.y + 12 + k * 14))) + 'px';
      card.addEventListener('pointerenter', () => { card._hover = true; });
      card.addEventListener('pointerleave', () => { card._hover = false; });
    }
    requestAnimationFrame(() => card.classList.add('on'));
    job.views.add(card);
  }

  function renderViews(job) {
    if (!job.views || !job.views.size) return;
    for (const card of [...job.views]) {
      if (!card.isConnected) { job.views.delete(card); continue; }
      card.replaceChildren(...cardKids(job, card));
      card.dataset.tone = stateWords(job).tone;
      // a floating card fades away a while after the answer landed (unless the owner is reading it)
      if (card.classList.contains('float') && DONE.has(job.state) && !card._timer) {
        card._timer = setInterval(() => { if (!card._hover && card.isConnected) { clearInterval(card._timer); card._close(); } }, 60_000);
      }
    }
  }

  function cardKids(j, card) {
    const w = stateWords(j);
    const finished = DONE.has(j.state);
    const ok = OK.has(j.state);
    const subject = targetLabel(j.target);
    const head = h('div.ops-scard-head',
      finished ? h('span.ops-state-ico', icon(ok ? 'check' : 'cross')) : h('span.ops-spinner', { 'aria-hidden': 'true' }),
      h('span.ops-scard-k', '侦察兵'),
      subject && j.target != null ? h('span.ops-scard-subj', subject) : null,
      h('button.ops-icon-btn.ops-scard-x', { type: 'button', title: '收起', 'aria-label': '收起', onclick: (e) => { e.stopPropagation(); card._close(); } }, icon('close')));
    const kids = [head];
    if (!ok) kids.push(h('p.ops-scard-state.' + w.tone, w.text));
    if (w.extra) kids.push(h('p.ops-note.ops-refuse-extra', w.extra));
    if (j.retryOf && !finished) kids.push(h('div.ops-scard-retry', h('span.ops-retry-dot'), `第一次的答案没过校验（${cut(j.firstError || '不合格', 22)}），已作废、不写进数据`));
    if (ok) {
      const say = j.say || shortLine(j.line);
      if (say) kids.push(h('p.ops-scard-say', say));
      const found = j.answer || j.found;
      if (found) kids.push(h('p.ops-scard-found', cut(found, 150)));
      const srcs = (j.sources || []).filter((x) => x && x.url).slice(0, 3);
      const foot = h('div.ops-scard-foot',
        srcs.length ? h('span.ops-scard-srcs', srcs.map((x) => h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.url }, host(x.url)))) : null,
        h('span.ops-scard-meta', j.state === 'cached' ? '上次查的' : j.retryOf ? '重查后' : '', typeof j.conf === 'number' ? ` · 可信度 ${Math.round(j.conf * 100)}%` : ''),
        h('button.ops-more', { type: 'button', onclick: () => open({ toggle: false }) }, '看全部', icon('chev')));
      kids.push(foot);
      if (j.state === 'cached') {
        kids.push(h('div.ops-row', h('button.ops-btn.ghost.small', { type: 'button', onclick: () => { card._close(); ask(j.kind, j.target, j.question, { force: true }); } }, '重新查（花额度）')));
      }
    } else if (finished && j.state !== 'refused') {
      kids.push(h('div.ops-row', h('button.ops-btn.ghost.small', { type: 'button', onclick: () => { card._close(); ask(j.kind, j.target, j.question, { force: true }); } }, icon('replay'), '再派一次')));
    }
    return kids;
  }
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };

  // a tick for the "正在网上查… 42 秒" counters (cards and panel)
  setInterval(() => {
    for (const j of jobs.values()) if (j.state === 'running' || j.state === 'queued') renderViews(j);
    if (live() && [...jobs.values()].some((j) => j.state === 'running')) renderJobs();
  }, 1000);

  // ---------------------------------------------------------------- helpers
  function normTarget(t) {
    if (t == null) return null;
    if (typeof t === 'object') return t.type === 'node' && t.id ? t.id : t;
    const s = String(t);
    if (X().nodeById(s)) return X().nodeById(s).id;
    if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) && X().nodeById('s:' + s)) return 's:' + s;
    return s;
  }
  function targetLabel(t) {
    if (t == null) return '整个市场';
    if (typeof t === 'object') {
      if (t.type === 'node' && t.id) return nameOf(app, t.id);
      if (t.type === 'edge') return `${t.a} → ${t.b}${t.what ? ' · ' + t.what : ''}`;
      if (t.type === 'tickers') return (t.tickers || []).slice(0, 4).join(' ');
      if (t.type === 'error') return `故障：${t.step || ''}`;
      return t.id || t.ticker || '一个目标';
    }
    const n = X().nodeById(t) || X().nodeById('s:' + t);
    return n ? (n.name || n.ticker) + (n.ticker && n.name !== n.ticker ? ` ${n.ticker}` : '') : String(t).replace(/^s:/, '');
  }
  const targetId = (t) => (t == null ? null : typeof t === 'object' ? (t.type === 'node' ? t.id : null) : (X().nodeById(t) ? X().nodeById(t).id : X().nodeById('s:' + t) ? 's:' + t : null));
  function defaultTarget() {
    const st = X().state;
    if (st.view === 'stock' && st.ticker) return 's:' + st.ticker;
    const n = X().node();
    return n && !X().isRoot(n.id) ? n.id : null;
  }
  function suggestions(t) {
    const n = t ? (X().nodeById(t)) : null;
    const now = (n && n.now) || {};
    const nm = n ? (n.name || n.ticker) : '市场';
    const out = [];
    if (now.front > 0) out.push(`${nm}的风向为什么突然变成流入？`);
    else if (now.front < 0) out.push(`钱为什么突然开始撤出${nm}？`);
    if (now.wind > 1) out.push(`为什么钱在涌进${nm}？`);
    else if (now.wind < -1) out.push(`钱为什么在逃离${nm}？`);
    if (now.storm >= 0.8) out.push(`${nm}的波动为什么突然变大？`);
    if (now.pres >= 85) out.push(`${nm}是不是挤过头了？谁在买？`);
    else if (now.pres != null && now.pres <= 15) out.push(`${nm}为什么没人要？有没有转机？`);
    out.push(n ? `${nm}最近一周发生了什么？` : '这周市场最大的新闻是什么？');
    return [...new Set(out)].slice(0, 3);
  }

  // ---------------------------------------------------------------- sheet
  function open({ toggle = true, focus = false } = {}) {
    if (!targetTouched) target = defaultTarget();
    const ctl = openSheet({
      id: 'scout', title: '侦察兵', icon: 'scout',
      sub: '哪里不对劲，就派你的 Claude 去网上查，带着来源回来',
      render, onClose: () => { targetTouched = false; },
    }, { toggle });
    if (ctl) {
      loadLog().then(() => { renderLog(); renderJobs(); loadUsage().then(renderUsage); });
      if (focus) requestAnimationFrame(() => { const i = ctl.body.querySelector('.ops-scout-q-input'); if (i) i.focus(); });
    }
  }
  const rerender = () => { const c = sheetCtl('scout'); if (c) c.rerender(); };

  function render(body) {
    refs = { usage: h('div.ops-usage'), jobs: h('div.ops-jobs'), log: h('div.ops-logwrap') };
    body.append(refs.usage);

    // ask box (built once per open / subject change, so typing is never interrupted by polling)
    const input = h('input.ops-input.ops-scout-q-input', {
      type: 'text', placeholder: '让 Claude 去查点什么…', value: draft, maxlength: 300,
      oninput: (e) => { draft = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fire(); } },
    });
    const fire = async () => {
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      askNote = null;
      paintNote();
      const r = await ask('ask', target, q, { inline: false });
      if (r && r.error && !r.id) {
        // not sent: keep the question in the box and say why under the button (the same words as everywhere)
        draft = q;
        if (input.isConnected) input.value = q;
        askNote = { main: r.error, extra: r.extra || '', bad: true };
        paintNote();
        return;
      }
      draft = '';
      input.value = '';
    };
    const subj = h('div.ops-subject',
      h('span.ops-sub', '关于'),
      h('span.ops-chip.subject', targetLabel(target),
        target != null ? h('button.ops-chip-x', { type: 'button', title: '改成问整个市场', 'aria-label': '去掉', onclick: () => { target = null; targetTouched = true; rerender(); } }, icon('close')) : null),
      target == null && defaultTarget() ? h('button.ops-more', { type: 'button', onclick: () => { target = defaultTarget(); targetTouched = true; rerender(); } }, `改成「${targetLabel(defaultTarget())}」`) : null);
    const b = app.budget && app.budget.get ? app.budget.get() : null;
    refs.note = h('div.ops-ask-note', { role: 'status', 'aria-live': 'polite' });
    body.append(h('div.ops-ask', subj,
      h('div.ops-ask-row', input, h('button.ops-btn.primary', { type: 'button', onclick: fire, disabled: !!(b && b.over) }, '派出去', icon('send'))),
      refs.note,
      h('div.ops-chips.sugg', suggestions(target).map((q) => h('button.ops-sugg', { type: 'button', onclick: () => { input.value = q; draft = q; input.focus(); } }, q))),
      serverless ? h('p.ops-note.bad', '现在是静态模式（没用 server.py 打开），派不出去；可以在终端跑 scout/job.py。') : null));
    paintNote();

    body.append(refs.jobs, refs.log);
    renderUsage(); renderJobs(); renderLog();
  }

  const live = () => !!(refs && refs.jobs.isConnected);
  /** under 派出去: why the last dispatch did not go out, or (over budget) why it can't — else the plain cost note */
  function paintNote() {
    if (!refs || !refs.note || !refs.note.isConnected) return;
    const b = app.budget && app.budget.get ? app.budget.get() : null;
    let t = askNote;
    if (!t && b && b.over) { const x = budgetRefusal(null, b); t = { main: x.main, extra: x.extra, bad: true }; }
    refs.note.replaceChildren(...(t
      ? [h('p.ops-note.bad', t.main), t.extra ? h('p.ops-note.ops-refuse-extra', t.extra) : null].filter(Boolean)
      : [h('p.ops-note', '只上网查、不改代码，花的是 Claude 额度。3 天内问过同样的问题，直接给上次的结果，不花额度。')]));
  }
  function renderUsage() {
    if (!live()) return;
    const b = app.budget && app.budget.get ? app.budget.get() : null;
    const q = usage ? (usage.queued || 0) : 0, run = usage ? (usage.running || 0) : 0;
    refs.usage.replaceChildren(h('div.ops-scout-status',
      b ? h('span.ops-scout-bud' + (b.over ? '.bad' : ''), { title: b.unlimited ? '不设上限，花费照样记账（详情在 💓 心跳里）' : '只限花费，不限次数（详情在 💓 心跳里）' }, budgetLine(b), b.calibrated || b.unlimited ? '' : h('span.ops-chip.ops-est', '约')) : null,
      h('span.ops-sub', run || q ? `${run} 个在查 · ${q} 个排队` : '队里是空的')));
  }
  function renderJobs() {
    if (!live()) return;
    const list = [...jobs.values()].filter((j) => !j.replacedBy && !(DONE.has(j.state) && j.state !== 'cached' && log.some((e) => e.id === j.id) && !j.retryOf))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    refs.jobs.replaceChildren(...(list.length ? [h('section.ops-sec', h('h3.ops-sec-title', '在路上'), h('ul.ops-scout-list', list.map((j) => jobRow(j))))] : []));
  }
  function renderLog() {
    if (!live()) return;
    const tabs = [['all', '全部'], ['owner', '你派的'], ['auto', '自动巡逻']];
    const list = log.filter((e) => filter === 'all' || (filter === 'owner' ? e.source === 'owner' : e.source !== 'owner'));
    refs.log.replaceChildren(h('section.ops-sec',
      h('div.ops-sec-head', h('h3.ops-sec-title', '侦察兵日志'),
        h('div.ops-tabs', { role: 'tablist' }, tabs.map(([k, l]) => h('button.ops-tab' + (filter === k ? '.on' : ''), {
          type: 'button', role: 'tab', 'aria-selected': filter === k ? 'true' : 'false', onclick: () => { filter = k; renderLog(); },
        }, l)))),
      list.length ? h('ul.ops-scout-list', list.slice(0, 30).map((e) => logRow(e)))
        : h('p.ops-empty', log.length ? '这一类还没有记录。' : '侦察兵还没出过门。自动巡逻在每天收盘后跑；你也可以在上面直接问。')));
  }

  function jobRow(j) {
    const ok = OK.has(j.state);
    const finished = DONE.has(j.state);
    const w = stateWords(j);
    return h('li.ops-scout-item.job' + (ok ? '.ok' : finished ? '.bad' : '.live') + (j.retryOf ? '.retry' : ''),
      h('div.ops-scout-head',
        finished ? h('span.ops-state-ico', icon(ok ? 'check' : 'cross')) : h('span.ops-spinner', { 'aria-hidden': 'true' }),
        h('span.ops-chip', KIND[j.kind] || j.kind), targetEl(j.target),
        j.retryOf ? h('span.ops-tag.retry', '自动重查') : null),
      h('p.ops-scout-q', j.question || ''),
      ok ? null : h('p.ops-scout-state.' + w.tone, w.text),
      !ok && w.extra ? h('p.ops-note.ops-refuse-extra', w.extra) : null,
      j.retryOf && !finished ? h('div.ops-scard-retry', h('span.ops-retry-dot'), `第一次的答案没过校验（${cut(j.firstError || '不合格', 22)}），已作废、不写进数据`) : null,
      ok && (j.say || j.line) ? h('p.ops-scout-say', j.say || shortLine(j.line)) : null,
      ok && j.answer ? details(j.answer, j.sources, j.changes, null, j.id) : null,
      j.state === 'cached' ? h('div.ops-row', h('button.ops-btn.ghost.small', { type: 'button', onclick: () => { jobs.delete(j.id); ask(j.kind, j.target, j.question, { force: true, inline: false }); } }, '重新查（花额度）')) : null,
      finished && !ok && j.state !== 'refused' ? h('div.ops-row', h('button.ops-btn.ghost.small', { type: 'button', onclick: () => { jobs.delete(j.id); ask(j.kind, j.target, j.question, { force: true, inline: false }); } }, icon('replay'), '再派一次')) : null);
  }

  function logRow(e) {
    const ok = e.ok !== false && e.state !== 'failed' && e.state !== 'invalid';
    return h('li.ops-scout-item' + (ok ? '.ok' : '.bad') + (landedIds.has(e.id) ? '.fresh' : ''),
      h('div.ops-scout-head',
        h('span.ops-chip' + (e.source === 'owner' ? '.owner' : ''), KIND[e.kind] || e.kind || '查'),
        targetEl(e.target),
        landedIds.has(e.id) ? h('span.ops-tag.up', '刚回来') : null,
        h('span.ops-sub.right', { title: e.finishedAt || e.askedAt || '' }, clock(e.finishedAt || e.askedAt)),
        typeof e.conf === 'number' && ok ? h('span.ops-conf', { title: `可信度 ${Math.round(e.conf * 100)}%` }, confDots(e.conf)) : null),
      h('p.ops-scout-q', e.question || ''),
      ok ? h('p.ops-scout-say', e.say || shortLine(e.line) || '') : h('p.ops-scout-state.bad', `没查成：${e.error || (e.state === 'invalid' ? '答案没过校验（没有可靠来源）' : '失败')}`),
      ok && (e.found || (e.sources || []).length) ? details(e.found, e.sources, e.changes, e) : null);
  }

  function targetEl(t) {
    const id = targetId(t);
    const label = targetLabel(t);
    return id ? h('button.ops-target', { type: 'button', title: '飞过去', onclick: () => go(app, id) }, label) : h('span.ops-target.static', label);
  }
  function confDots(c) {
    const n = c >= 0.8 ? 3 : c >= 0.6 ? 2 : 1;
    return [0, 1, 2].map((k) => h('span.ops-conf-dot' + (k < n ? '.on' : '')));
  }
  function details(found, sources, changes, e, id = e && e.id) {
    const srcs = (sources || []).filter((x) => x && x.url);
    return h('details.ops-details', {
      open: !!(id && openDetails.has(id)),
      ontoggle: (ev) => { if (!id) return; if (ev.target.open) openDetails.add(id); else openDetails.delete(id); },
    },
      h('summary', '看它找到的', srcs.length ? h('span.ops-sub', ` · ${srcs.length} 个来源`) : null),
      found ? h('p.ops-found', found) : null,
      srcs.length ? h('ul.ops-sources', srcs.slice(0, 8).map((x) => h('li',
        h('span.ops-src-dot' + (x.ok === true ? '.ok' : x.ok === false ? '.bad' : ''), { title: x.ok === true ? '链接打得开' : x.ok === false ? '链接打不开了' : '没验证' }),
        h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.url }, host(x.url))))) : null,
      (changes || []).length ? h('ul.ops-plain.muted', changes.map((c) => h('li', `改动：${c.what || c.file}`))) : null,
      e && (e.webSearches || e.ms) ? h('p.ops-sub', [e.webSearches ? `搜了 ${e.webSearches} 次` : '', e.ms ? `用了 ${Math.round(e.ms / 1000)} 秒` : '', e.model || ''].filter(Boolean).join(' · ')) : null);
  }

  // ---------------------------------------------------------------- boot
  for (const j of store.get(JOBS_KEY, []) || []) {
    if (j && j.id && !String(j.id).startsWith('tmp-') && Date.now() - new Date(j.startedAt).getTime() < MAX_AGE_MS) jobs.set(j.id, { ...j, state: 'queued', views: new Set() });
  }
  if (jobs.size) { paintBadge(); poll(); }
  loadLog();
  every(120_000, async () => { if (sheetCtl('scout')) { await loadLog(); await loadUsage(); renderLog(); renderUsage(); } }, { now: false });
  onAny(app, ['dataReloaded'], (p) => { if (touchesPart(p, 'scout_log') || touchesPart(p, 'scout')) loadLog().then(renderLog); });
  onAny(app, ['nav', 'node'], () => { if (!targetTouched && sheetCtl('scout')) { target = defaultTarget(); rerender(); } });
  onAny(app, ['budget'], () => { renderUsage(); paintNote(); });

  // §19: app.ask(kind, target, question) is implemented here (the shell forwards 3 args; the click spot is
  // found from the last button press, so answers still land where the owner clicked)
  if (typeof app.provide === 'function') app.provide('ask', (kind, tgt, question, opts) => ask(kind, tgt, question, opts));
  else app.ask = (kind, tgt, question, opts) => ask(kind, tgt, question, opts);
  const out = { ask, open, reload: loadLog, jobs: () => [...jobs.values()].map((j) => ({ ...pub(j), ahead: aheadOf(j), retryOf: j.retryOf || null })) };
  app.scout = out;
  return out;
}
