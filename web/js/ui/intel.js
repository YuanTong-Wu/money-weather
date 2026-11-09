// intel.js — 📥 投喂 (DESIGN.md §11): paste text or a link → POST /api/intel → progress → the map gets a
// separate "你投喂的情报" layer (planet.setOverlay('intel')) within about a minute. Measured weather is
// never changed. Also the side-panel section "📥 情报" (recent intel, delete).
//
// Server routes (intel/job.py): POST /api/intel {text,url,force} → {started,id} · GET /api/intel?id= →
// {state,stage,elapsed,events,warnings,error,dup} · GET /api/intel/list · DELETE /api/intel?id=
// (POST /api/intel/delete?id= as fallback). The layer itself is data/intel.json (newest first).
import {
  h, icon, api, dataFile, every, A, nameOf, go, toast, onAny, syncTheme, topButton, panelSection,
  openSheet, sheetCtl, store, ago, cnDate, secs, daysBetween, localISODate, copyBtn, shq, touchesPart,
  refusedForBudget, budgetRefusal,
} from './heartbeat.js';

const KIND = { news: '新闻', data: '数据', rumor: '传闻', opinion: '观点', earnings: '财报', policy: '政策' };
const NOVELTY = { new: '新消息', 'probably-known': '市场可能已知道', old: '旧闻' };
const SIGNAL = { noise: '噪音', minor: '小事', major: '大事' };
const SIGNAL_W = { noise: 0.25, minor: 0.6, major: 1 };
const SOURCE = { paste: '你投喂的', url: '你投喂的链接', claude: '你告诉 Claude 的', scout: '侦察兵找到的' };
const LAG = { now: '马上', '1-3m': '1–3 个月', '3-12m': '3–12 个月', '1y+': '1 年以上' };
const MAX_AGE = 7;                 // days an event keeps weather on the map (fading)
const POLL_MS = 1500;
const JOB_KEY = 'mw.intel.job', DRAFT_KEY = 'mw.intel.draft';
const STEPS = ['排队', '读内容', 'Claude 分析', '对上地图'];

export function init(app) {
  syncTheme(app);
  const X = () => A(app);
  // §12 voice: 'say' / 'nowSay' have *Mild twins written by the backend
  const sayOf = (o, k) => { if (!o) return ''; try { if (typeof app.say === 'function') return app.say(o, k) || o[k] || ''; } catch (e) { /* plain */ } return o[k] || ''; };
  let events = [];
  let job = null;               // {id, state, stage, elapsed, events, error, dup, warnings, at, input}
  let pollTimer = 0, pollUntil = 0;
  let serverless = false;
  const expanded = { list: false };
  let confirmDel = null;

  // ---------------------------------------------------------------- top-bar button + panel section
  const btn = topButton(app, { id: 'intel', icon: 'intel', svg: 'inbox', label: '投喂', title: '投喂情报：贴新闻、传闻或链接，一分钟内上图', order: 40, onClick: () => openFeed() });
  let section = { refresh() {} };     // set at the end of init (addSection renders at once)

  // ---------------------------------------------------------------- data
  async function loadEvents() {
    let j = await dataFile(app, 'intel.json');
    if (j && !Array.isArray(j) && Array.isArray(j.events)) j = j.events;
    if (!Array.isArray(j)) {
      const r = await api('api/intel/list?limit=60', { timeout: 8000 });
      j = r && Array.isArray(r.events) ? r.events : [];
    }
    events = j.filter((e) => e && e.id && (e.title || e.summary));
    events.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  }

  /** the day the time machine shows (today when at the latest date) */
  function refDate() {
    const x = X();
    const i = x.state.dateIndex ?? x.lastIdx;
    const d = x.dates[i] || localISODate();
    if (i >= x.lastIdx) { const today = localISODate(); return today > d ? today : d; }
    return d;
  }
  const evDate = (e) => e.eventDate || String(e.addedAt || '').slice(0, 10);
  const ageOf = (e) => daysBetween(evDate(e), refDate());

  /** signed push of one event on node id → {v, why} (reach map first, then impacts up the path) */
  function pushMap(e) {
    if (e.reach && typeof e.reach === 'object') return e.reach;
    const out = {};
    for (const im of e.impacts || []) {
      const v = (im.dir || 0) * (im.strength || 1);
      const ids = X().data && X().data.pathIds ? (X().data.pathIds(im.id) || [im.id]) : [im.id];
      ids.slice().reverse().forEach((id, k) => {
        const vv = Math.max(-3, Math.min(3, v * Math.pow(0.6, k)));
        if (Math.abs(vv) > Math.abs(out[id] || 0)) out[id] = vv;
      });
    }
    return out;
  }

  /** §18 overlay for the planet now on screen: [{id, dir, strength, ageDays, title}] */
  function overlayItems() {
    const node = X().node();
    if (!node) return [];
    const kids = new Set((node.children || []).map((c) => c.id));
    const best = new Map();
    for (const e of events) {
      const age = ageOf(e);
      if (age == null || age < 0 || age > MAX_AGE) continue;
      if (e.signal === 'noise' || e.novelty === 'old') continue;   // listed in the panel, but not worth map attention
      // the backend's weight = credibility × signal × novelty (old news whispers); else our own estimate
      const w = typeof e.weight === 'number' ? e.weight : (SIGNAL_W[e.signal] ?? 0.6) * (typeof e.credibility === 'number' ? e.credibility : 0.6);
      const reach = pushMap(e);
      for (const [id, v] of Object.entries(reach)) {
        if (!kids.has(id) || !v) continue;
        const s = Math.min(3, Math.abs(v) * w);
        if (s < 0.12) continue;
        const cur = best.get(id);
        if (cur) { cur.count++; cur.titles.push(e.title); }
        if (!cur || s > cur.strength) {
          // (§26 amendment 5: the deeper places the story is about — both planets put its tag there, 卢拉连任 → 巴西)
          const deep = (e.impacts || []).map((im) => im && im.id).filter((x) => x != null && x !== id);
          best.set(id, { id, dir: v > 0 ? 1 : -1, strength: +s.toFixed(2), ageDays: age, title: e.title, eventId: e.id, deep,
            source: e.source || 'paste', count: cur ? cur.count : 1, titles: cur ? cur.titles : [e.title] });
        }
      }
    }
    return [...best.values()].map(({ titles, ...r }) => ({ ...r, title: titles.length > 1 ? `${r.title}（另有 ${titles.length - 1} 条）` : r.title }));
  }

  function applyOverlay() {
    const p = app.planet;
    if (!p || typeof p.setOverlay !== 'function') return;
    try { const items = overlayItems(); p.setOverlay('intel', items.length ? items : null); } catch (e) { console.warn('[intel] overlay', e); }
  }

  let selfReload = false;
  async function reloadAll(extra = []) {
    selfReload = true;
    try { if (typeof app.reloadData === 'function') await app.reloadData(['intel']); } catch (e) { console.warn('[intel] reloadData', e); }
    selfReload = false;
    await loadEvents();
    for (const e of extra) if (e && e.id && !events.some((x) => x.id === e.id)) events.unshift(e);
    applyOverlay();
    section.refresh();
  }

  // ---------------------------------------------------------------- relevance to the planet on screen
  function touches(e, node) {
    if (!node || X().isRoot(node.id)) return true;
    const reach = pushMap(e);
    if (reach[node.id]) return true;
    const kids = (node.children || []).map((c) => c.id);
    if (kids.some((k) => reach[k])) return true;
    const D = X().data;
    return (e.impacts || []).some((im) => { try { return (D.pathIds(im.id) || []).includes(node.id); } catch (er) { return false; } });
  }

  // ---------------------------------------------------------------- shared item card
  function impactChips(e, { max = 4 } = {}) {
    const ims = (e.impacts || []).slice().sort((a, b) => (b.strength || 0) - (a.strength || 0)).slice(0, max);
    if (!ims.length) return null;
    return h('div.ops-chips', ims.map((im) => {
      const gap = typeof im.gap === 'number' && im.gap >= 1.2;
      const priced = typeof im.pricedIn === 'number' && im.pricedIn >= 0.7;
      return h('button.ops-impact' + (im.dir > 0 ? '.up' : im.dir < 0 ? '.down' : ''), {
        type: 'button',
        title: [im.why, sayOf(im, 'nowSay'), im.lag ? `时间：${LAG[im.lag] || im.lag}` : '', '点击飞过去'].filter(Boolean).join('\n'),
        onclick: (ev) => { ev.stopPropagation(); go(app, im.id); },
      }, icon(im.dir > 0 ? 'up' : 'down'), h('span', im.name || nameOf(app, im.id)),
      im.strength >= 2 ? h('span.ops-impact-str', im.strength >= 3 ? '强' : '中') : null,
      gap ? h('span.ops-tag.gap', '时间差') : priced ? h('span.ops-tag.priced', '已抢跑') : null);
    }), (e.impacts || []).length > max ? h('span.ops-sub', `+${e.impacts.length - max}`) : null);
  }

  function metaLine(e) {
    const bits = [SOURCE[e.source] || '你投喂的', KIND[e.kind], typeof e.credibility === 'number' ? `可信 ${Math.round(e.credibility * 100)}%` : null,
      NOVELTY[e.novelty], ago(e.addedAt) || cnDate(evDate(e))];
    return h('div.ops-intel-meta', bits.filter(Boolean).join(' · '));
  }

  function eventCard(e, { del = true, compact = false } = {}) {
    const dirs = (e.impacts || []).map((i) => Math.sign(i.dir || 0));
    const dir = dirs.length && dirs.every((d) => d > 0) ? 'up' : dirs.length && dirs.every((d) => d < 0) ? 'down' : 'mixed';
    const age = ageOf(e);
    const live = age != null && age >= 0 && age <= MAX_AGE;
    const asking = confirmDel === e.id;
    return h('li.ops-intel-item.' + dir + '.sig-' + (e.signal || 'minor') + (live ? '.live' : ''),
      h('div.ops-intel-top',
        h('span.ops-intel-bolt', { title: live ? '这条正在地图上（虚线、闪电）' : '太旧了，地图上已经不画了' }, icon('bolt')),
        h('strong.ops-intel-title', e.title || '（没有标题）'),
        e.signal ? h('span.ops-tag.sig-' + e.signal, SIGNAL[e.signal] || e.signal) : null,
        del ? h('button.ops-icon-btn.ops-del', { type: 'button', title: '删掉这条情报', 'aria-label': '删掉', onclick: (ev) => { ev.stopPropagation(); confirmDel = asking ? null : e.id; section.refresh(); } }, icon('trash')) : null),
      asking ? h('div.ops-confirm', h('span', '删掉这条？地图上的情报层会一起撤掉。'),
        h('button.ops-btn.danger.small', { type: 'button', onclick: () => removeEvent(e) }, '删掉'),
        h('button.ops-btn.ghost.small', { type: 'button', onclick: () => { confirmDel = null; section.refresh(); } }, '算了')) : null,
      e.say ? h('p.ops-intel-say', sayOf(e, 'say')) : null,
      !compact && e.summary && e.summary !== e.say ? h('p.ops-intel-sum', e.summary) : null,
      impactChips(e, { max: compact ? 3 : 5 }),
      (e.scenarios || []).length ? h('div.ops-intel-scen', e.scenarios.slice(0, 2).map((s) => h('span.ops-tag.' + (s.effect === 'supports' ? 'up' : 'down'),
        { title: s.say || '' }, `${s.effect === 'supports' ? '支持' : s.effect === 'hits-kill-signal' ? '碰到认错线' : '削弱'}推演「${s.title || s.id}」`))) : null,
      metaLine(e),
      e.url ? h('a.ops-link', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), hostOf(e.url)) : null);
  }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return '原文'; } };

  async function removeEvent(e) {
    confirmDel = null;
    let r = await api('api/intel?id=' + encodeURIComponent(e.id), { method: 'DELETE' });
    if (r.missing && !r.offline) r = await api('api/intel/delete?id=' + encodeURIComponent(e.id), { method: 'POST' });
    if (r.missing || r.offline) {
      toast(app, `删除要用 server.py 打开本页。也可以在终端运行：python3 intel/ingest.py --delete ${e.id}`, 6000);
      section.refresh();
      return;
    }
    if (r.error && !r.deleted) { toast(app, `没删掉：${r.error}`); section.refresh(); return; }
    events = events.filter((x) => x.id !== e.id);
    toast(app, '删掉了，地图上的这条情报也撤了');
    await reloadAll();
  }

  // ---------------------------------------------------------------- panel section
  function renderSection(el) {
    el.classList.add('ops', 'ops-intel-sec');
    const node = X().node();
    const live = (e) => { const a = ageOf(e); return a != null && a >= -1 && a <= 30; };
    const list = events.filter((e) => live(e) && touches(e, node));
    if (!list.length) return false;            // nothing here → the shell hides the section (calm by default)
    // the owner's own feed first, then what the scout found by itself — never one label for both (§11 vs §15)
    const mine = (e) => String(e.source || '') !== 'scout';
    list.sort((a, b) => (mine(b) ? 1 : 0) - (mine(a) ? 1 : 0));
    const shown = expanded.list ? list.slice(0, 12) : list.slice(0, 2);
    const groups = [['你投喂的', shown.filter(mine)], ['侦察兵查到的', shown.filter((e) => !mine(e))]].filter((g) => g[1].length);
    for (const [label, items] of groups) {
      el.append(h('div.ops-sub.ops-intel-k', label), h('ul.ops-intel-list', items.map((e) => eventCard(e, { compact: true }))));
    }
    const more = Math.min(list.length, 12) - shown.length;
    el.append(h('div.ops-row.split',
      more > 0 || expanded.list ? h('button.ops-more', { type: 'button', onclick: () => { expanded.list = !expanded.list; section.refresh(); } },
        expanded.list ? '收起' : `展开更多（还有 ${more} 条）`) : h('span'),
      h('button.ops-btn.ghost.small', { type: 'button', onclick: () => openFeed() }, icon('inbox'), '再投一条')));
  }

  // ---------------------------------------------------------------- feed sheet
  function openFeed() {
    openSheet({
      id: 'intel', title: '投喂情报', icon: 'inbox',
      sub: '贴新闻、传闻、财报金句或链接。Claude 读完，一分钟内上图。',
      render: renderFeed,
      onClose: () => { if (job && (job.state === 'done' || job.state === 'cancelled')) job = null; },
    });
  }

  function renderFeed(body, ctl) {
    const running = job && (job.state === 'queued' || job.state === 'running' || job.state === 'starting');
    if (running) return renderProgress(body);
    if (job && job.state === 'done') return renderResult(body);

    const draft = store.get(DRAFT_KEY, { text: '', url: '' }) || { text: '', url: '' };
    const ta = h('textarea.ops-input.ops-ta', {
      rows: 6, maxlength: 60000, spellcheck: false,
      placeholder: '贴一段新闻、传闻、财报电话会里的一句话、一条帖子…\n\n例：美光说 2027 年的 HBM 已经卖光了',
      oninput: () => saveDraft(),
      onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } },
    });
    ta.value = draft.text || '';
    const url = h('input.ops-input.ops-url', {
      type: 'url', placeholder: '或者贴一个链接（可选）', spellcheck: false, value: draft.url || '',
      oninput: () => saveDraft(),
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } },
    });
    const count = h('span.ops-sub.ops-count');
    const sendBtn = h('button.ops-btn.primary', { type: 'button', onclick: () => send() }, '投喂', icon('send'));
    function saveDraft() {
      store.set(DRAFT_KEY, { text: ta.value, url: url.value });
      const n = ta.value.trim().length;
      count.textContent = n ? `${n} 字` : '';
      sendBtn.disabled = !ta.value.trim() && !url.value.trim();
    }
    async function send() {
      const text = ta.value.trim(), u = url.value.trim();
      if (!text && !u) { ta.focus(); return; }
      if (u && !/^https?:\/\//i.test(u)) { toast(app, '链接要以 http:// 或 https:// 开头'); url.focus(); return; }
      await start({ text, url: u });
    }

    if (job && (job.state === 'error' || job.state === 'cancelled')) {
      body.append(h('div.ops-callout.bad',
        job.refused ? h('p', h('strong', job.error)) : h('p', h('strong', job.state === 'cancelled' ? '已取消。' : '没成功：'), job.state === 'cancelled' ? '' : job.error || '不知道哪里出了问题'),
        job.refused && job.extra ? h('p.ops-sub', job.extra) : null,
        job.serverless ? [
          h('p.ops-sub', '投喂要用 server.py 打开本页（python3 server.py）。现在也可以在终端里跑这条命令，或者直接把内容丢给 Claude Code：'),
          h('code.ops-code', cliCmd(job.input)),
          h('div.ops-row', copyBtn(app, cliCmd(job.input))),
        ] : h('p.ops-sub', '内容还在下面，可以再试一次。')));
    }

    body.append(h('div.ops-form',
      h('label.ops-label', { for: 'ops-intel-ta' }, '内容'), Object.assign(ta, { id: 'ops-intel-ta' }),
      h('div.ops-url-row', icon('link'), url),
      h('div.ops-row.split', h('span.ops-sub', h('kbd.ops-kbd', '⌘'), h('kbd.ops-kbd', '↵'), ' 投喂 · 通常 10–40 秒 ', count), sendBtn),
      h('p.ops-note', icon('bolt'), '测到的天气不会被改。情报单独一层，用虚线和闪电画出来，标着「你投喂的情报」，随时可以删。')));

    const recent = events.slice(0, 3);
    if (recent.length) {
      body.append(h('section.ops-sec', h('h3.ops-sec-title', '最近投喂'),
        h('ul.ops-mini', recent.map((e) => h('li', h('span.ops-mini-dot.' + ((e.impacts || [])[0]?.dir > 0 ? 'up' : 'down')),
          h('span.ops-mini-t', e.title), h('span.ops-sub', ago(e.addedAt)))))));
    }
    saveDraft();
    requestAnimationFrame(() => { if (ctl && ctl.body.isConnected && !ta.value) ta.focus(); });
  }

  function stepOf(j) {
    if (!j) return 0;
    if (j.state === 'done') return 4;
    const s = String(j.stage || '');
    if (/排队|queued|准备/.test(s) || j.state === 'queued' || j.state === 'starting') return 0;
    if (/链接|网页|抓|读取|下载|fetch|打开/.test(s)) return 1;
    if (/核对|对上|检查|写|存|保存|上图|整理|校验|补/.test(s)) return 3;
    return 2;
  }

  function renderProgress(body) {
    const k = stepOf(job);
    body.append(h('div.ops-progress',
      h('ol.ops-steps-track', STEPS.map((s, i) => h('li' + (i < k ? '.done' : i === k ? '.cur' : ''), h('span.ops-track-dot', i < k ? icon('check') : null), h('span', s)))),
      h('div.ops-progress-bar', h('span')),
      h('p.ops-progress-stage', job.stage || '正在投喂…'),
      h('p.ops-sub', `${job.elapsed != null ? '已经 ' + secs(job.elapsed) : ''}${job.input && job.input.text ? ' · ' + excerpt(job.input.text, 40) : job.input && job.input.url ? ' · ' + job.input.url : ''}`),
      h('div.ops-row', h('button.ops-btn.ghost.small', { type: 'button', onclick: () => cancel() }, '取消'),
        h('span.ops-sub', '可以关掉这个窗口，好了会提醒你'))));
  }

  function renderResult(body) {
    const evs = job.events || [];
    const warn0 = (job.warnings || [])[0];
    if (!evs.length && !job.dup) {
      // irrelevant / noise: nothing was drawn — say so plainly, with the backend's one-line reason
      body.append(h('div.ops-callout',
        h('p', h('strong', '没上地图'), job.irrelevant ? '：这条跟钱的流向关系不大。' : '：没找到能落到地图上的东西。'),
        warn0 ? h('p.ops-sub', String(warn0)) : null));
    } else body.append(h('div.ops-callout.ok',
      h('p', h('strong', job.dup ? '这条之前投过' : `上图了：${evs.length} 条情报`),
        job.dup ? '，给你看上次的结果（没再花额度）。' : '。地图上用虚线和闪电标出来了。')));
    if (evs.length) body.append(h('ul.ops-intel-list', evs.map((e) => eventCard(e, { del: false }))));
    const warn = job.warnings || [];
    if (warn.length && (evs.length || job.dup)) body.append(h('ul.ops-plain.muted', warn.slice(0, 4).map((w) => h('li', String(w)))));
    else if (warn.length > 1) body.append(h('ul.ops-plain.muted', warn.slice(1, 4).map((w) => h('li', String(w)))));
    const top = bestImpact(evs);
    body.append(h('div.ops-row.split',
      h('div.ops-row', job.dup ? h('button.ops-btn.ghost.small', { type: 'button', onclick: () => start({ ...(job.input || {}), force: true }) }, '强制重新分析') : null,
        h('button.ops-btn.ghost.small', { type: 'button', onclick: () => { job = null; store.del(JOB_KEY); rerenderFeed(); } }, '再投一条')),
      top ? h('button.ops-btn.primary', { type: 'button', onclick: () => showOnMap(top) }, '去地图上看', icon('chev')) : null));
  }

  function bestImpact(evs) {
    let best = null, bs = -1;
    for (const e of evs) for (const im of e.impacts || []) {
      const s = (im.strength || 1) * (e.credibility ?? 0.6) * (SIGNAL_W[e.signal] ?? 0.6);
      if (s > bs) { bs = s; best = im; }
    }
    return best;
  }
  function showOnMap(im) {
    const D = X().data;
    const p = D && D.pathIds ? D.pathIds(im.id) : null;
    if (p && p.length > 1) {
      const parent = p.slice(0, -1);
      try {
        if (typeof app.go === 'function') app.go(parent);
        else if (typeof app.flyTo === 'function') app.flyTo(parent);
        else go(app, parent[parent.length - 1], parent);
      } catch (e) { go(app, im.id); }
    } else go(app, im.id);
    sheetCtl('intel') && sheetCtl('intel').close();
  }

  const excerpt = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  function cliCmd(input) {
    const parts = ['python3 intel/ingest.py'];
    if (input && input.url) parts.push('--url ' + shq(input.url));
    if (input && input.text) parts.push('--text ' + shq(input.text.length > 4000 ? input.text.slice(0, 4000) : input.text));
    return parts.join(' ');
  }
  const rerenderFeed = () => { const c = sheetCtl('intel'); if (c) c.rerender(); };

  // ---------------------------------------------------------------- job lifecycle
  async function start(input) {
    job = { state: 'starting', stage: '正在交给服务器…', input, at: Date.now() };
    btn.setBadge('…'); btn.setState('busy');
    rerenderFeed();
    const r = await api('api/intel', { method: 'POST', body: { text: input.text || '', url: input.url || '', force: !!input.force }, timeout: 20000 });
    if (r.missing || r.offline) {
      // connection refused is usually a restart: say so and keep the text; only a missing route means static mode
      if (r.missing) serverless = true;
      job = { state: 'error', error: r.offline ? '服务器暂时连不上（可能在重启），过几秒再投一次' : '这个服务器还不会接情报', serverless: !!r.missing, input };
      btn.setBadge(null); btn.setState(null);
      rerenderFeed();
      return;
    }
    if (r.error || r.started === false || !r.id) {
      // §21: over today's Claude budget → the server's own sentence + one line from /api/budget (same words on every button)
      const out = refusedForBudget(r) ? (typeof app.budgetRefusal === 'function' ? app.budgetRefusal(r) : budgetRefusal(r, app.budget && app.budget.get ? app.budget.get() : null)) : null;
      job = { state: 'error', error: out ? out.main : r.error || '服务器没接这条', extra: out ? out.extra : '', refused: !!out, input };
      btn.setBadge(null); btn.setState(null);
      rerenderFeed();
      return;
    }
    job = { id: r.id, state: 'queued', stage: '排队中…', input, at: Date.now() };
    store.set(JOB_KEY, { id: r.id, at: job.at, input: { text: excerpt(input.text, 300), url: input.url || '' } });
    rerenderFeed();
    poll(true);
  }

  function poll(fresh = false) {
    clearTimeout(pollTimer);
    if (fresh) pollUntil = Date.now() + 6 * 60_000;
    pollTimer = setTimeout(async () => {
      if (!job || !job.id) return;
      const r = await api('api/intel?id=' + encodeURIComponent(job.id), { timeout: 10000 });
      if (!job) return;
      if (r.offline || r.missing) {
        if (Date.now() < pollUntil) { job.stage = '服务器暂时没回应，继续等…'; rerenderFeed(); return poll(); }
        return finish({ state: 'error', error: '服务器没回应了' });
      }
      if (r.state === 'unknown' || (r.error && !r.state)) return finish({ state: 'error', error: r.error || '找不到这个任务' });
      // live queue position when the server gives one (§24 gateway: "排队中，前面还有 N 个")
      const ahead = typeof r.ahead === 'number' ? r.ahead : typeof r.position === 'number' ? r.position - 1 : null;
      const qStage = r.state === 'queued' && ahead != null ? (ahead > 0 ? `排队中，前面还有 ${ahead} 个` : '排队中，下一个就是它') : null;
      Object.assign(job, { state: r.state, stage: qStage || r.stage || job.stage, elapsed: r.elapsed, warnings: r.warnings, dup: !!r.dup, error: r.error, irrelevant: !!r.irrelevant });
      if (r.state === 'done') return finish({ ...job, events: Array.isArray(r.events) ? r.events : [] });
      if (r.state === 'error' || r.state === 'cancelled') return finish(job);
      rerenderFeed();
      if (Date.now() < pollUntil) poll();
      else finish({ state: 'error', error: '等太久了，后台可能卡住了' });
    }, fresh ? 600 : POLL_MS);
  }

  async function finish(j) {
    clearTimeout(pollTimer);
    job = { ...job, ...j };
    store.del(JOB_KEY);
    try { if (job.id) app.emit && app.emit('claudeSpent', { kind: 'intel', id: job.id }); } catch (e) { /* the 💓 budget refreshes */ }
    btn.setBadge(null); btn.setState(null);
    if (job.state === 'done') {
      store.set(DRAFT_KEY, { text: '', url: '' });   // the text is on the map now; a failed try keeps it
      const evs = job.events || [];
      await reloadAll(evs);
      if (!sheetCtl('intel')) toast(app, evs.length ? `📥 上图了：${evs[0].title}${evs.length > 1 ? ` 等 ${evs.length} 条` : ''}` : '📥 读完了，但没找到能上图的东西', 4200);
    } else if (!sheetCtl('intel') && job.state === 'error') {
      toast(app, `📥 投喂没成功：${job.error || ''}`, 4200);
    }
    rerenderFeed();
  }

  async function cancel() {
    if (!job || !job.id) { job = null; rerenderFeed(); return; }
    const id = job.id;
    await api('api/intel?id=' + encodeURIComponent(id), { method: 'DELETE' });
    finish({ state: 'cancelled' });
  }

  // ---------------------------------------------------------------- boot
  section = panelSection(app, { id: 'intel', title: '情报', icon: 'intel', order: 70, render: renderSection });
  (async () => {
    await loadEvents();
    applyOverlay();
    section.refresh();
    const saved = store.get(JOB_KEY);
    if (saved && saved.id && Date.now() - (saved.at || 0) < 6 * 60_000) {
      job = { id: saved.id, state: 'queued', stage: '接着等上次的投喂…', input: saved.input || {}, at: saved.at };
      btn.setBadge('…'); btn.setState('busy');
      poll(true);
    }
  })();

  onAny(app, ['node', 'nav', 'nav-done'], () => applyOverlay());
  let dateT = 0;
  onAny(app, ['date-settled', 'date'], () => { clearTimeout(dateT); dateT = setTimeout(applyOverlay, 180); });
  onAny(app, ['dataReloaded'], async (p) => {
    if (selfReload) return;                      // our own reloadAll() reads the file right after
    if (!touchesPart(p, 'intel')) { applyOverlay(); return; }
    await loadEvents(); applyOverlay(); section.refresh();
  });
  onAny(app, ['theme', 'map'], () => applyOverlay());
  onAny(app, ['voice'], () => section.refresh());
  // pick up intel added from the terminal ("tell Claude") or by the scout, without a page reload
  every(120_000, async () => {
    const before = events.map((e) => e.id).join();
    await loadEvents();
    if (events.map((e) => e.id).join() !== before) { applyOverlay(); section.refresh(); }
  }, { now: false });

  const api_ = { open: openFeed, reload: reloadAll, events: () => events.slice(), overlay: overlayItems };
  app.intel = api_;
  return api_;
}
