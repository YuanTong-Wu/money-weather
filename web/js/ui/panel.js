// panel.js — right side panel (§4, §6, §8.1, §19).
// Opens with ONE headline, the 主航道 line, the tour button and ①②③ (the same three the map numbers),
// then feature-module sections (app.panel.addSection), then everything else folded under 「更多天气」.
// World + today: 今日天气预报 from brief.json. Any other planet / day: words.regionWeather on the map file.
// Every flow gets a 为什么？ (§21): ①②③ and the 主航道 line always show it; list rows show it on hover/focus.
import { h, clear, richText, cnDate, nowAt, clamp, icon, numBadge, store, plainLine } from './dom.js';

const SEASON_ICON = { spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter' };
const SEASON_KEY = { 春: 'spring', 夏: 'summer', 秋: 'autumn', 冬: 'winter', spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter' };
const SEASON_NAME = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

export function initPanel(app) {
  const panel = document.getElementById('panel');
  const body = panel.querySelector('.panel-scroll');
  const toggle = panel.querySelector('.panel-toggle');
  const expanded = new Set();
  let lastKey = '';
  let moreOpen = store.get('mw.moreOpen', false) === true;

  // persistent slots: head + more are rebuilt; module sections keep their DOM (half-typed text survives)
  const headEl = h('div.p-head');
  const modsA = h('div.p-mods.a');
  const moreEl = h('div.p-more');
  const modsB = h('div.p-mods.b');
  clear(body).append(headEl, modsA, moreEl, modsB);

  toggle.replaceChildren(icon('chev-r', { size: 16, cls: 'pt-open' }), h('span.pt-closed', icon('chev-l', { size: 14 }), h('span', '预报')));
  toggle.addEventListener('click', () => app.setPanelOpen(!app.panelOpen));

  // ---------------------------------------------------------------- helpers
  const nameOf = (it) => it.name || app.D.nodeById(it.id)?.name || it.ticker || it.id;
  const emojiOf = (it) => it.emoji || app.D.nodeById(it.id)?.emoji || '';
  /** where it lives, without the root and without its own name: "美股 › AI 算力" */
  const pathOf = (it) => {
    let parts;
    if (typeof it.path === 'string') parts = it.path.split(/\s*›\s*/);
    else if (Array.isArray(it.path)) parts = it.path.slice();
    else parts = (app.D.pathIds(it.id) || []).map((id) => app.D.nodeById(id)?.name || id);
    const rootName = app.D.rootNodeOf()?.name;
    parts = parts.filter((x) => x && x !== '地球' && x !== rootName);
    if (parts.length && parts[parts.length - 1] === nameOf(it)) parts.pop();
    return parts.join(' › ');
  };
  const sayOf = (it) => app.say(it, 'say') || app.say(it, 'why') || it.text || '';
  const seasonTag = (key) => {
    const k = SEASON_KEY[key?.key || key];
    const tip = key && typeof key === 'object' && (key.now || key.next) ? `${SEASON_NAME[k]}天：${[key.now, key.next].filter(Boolean).join(' → ')}` : `${SEASON_NAME[k]}天`;
    return k ? h('span.season-tag.' + k, { title: tip }, icon(SEASON_ICON[k], { size: 13 }), h('span', SEASON_NAME[k])) : null;
  };
  const seasonOfChild = (id) => {
    const s = app.currentMap?.children?.[id];
    return s ? app.seasonAt(s, app.state.dateIndex) : null;
  };

  function windBar(w) {
    const v = clamp(w ?? 0, -3, 3) / 3;
    return h('span.wbar', { title: app.W.windWord(w).text },
      h('span.wbar-mid'),
      h('span.wbar-fill' + (v >= 0 ? '.in' : '.out'), { style: v >= 0 ? { left: '50%', width: v * 50 + '%' } : { right: '50%', width: -v * 50 + '%' } }));
  }

  const why = (target, opts) => (app.whyButton ? app.whyButton(target, opts) : null);

  function itemRow(it, { bar = false, showPath = false, metric = null, season = false } = {}) {
    const isStock = (it.id || '').startsWith('s:') || !!it.ticker;
    const ticker = it.ticker || (isStock ? it.id.slice(2) : null);
    const path = showPath ? pathOf(it) : '';
    const s = season ? (it.season || seasonOfChild(it.id)) : null;
    return h('li.item', {
      tabindex: 0, role: 'button',
      title: isStock ? '点击看这只股票' : '点击飞过去',
      onclick: () => app.goId(it.id, it.pathIds),
      onkeydown: (e) => { if (e.key === 'Enter') app.goId(it.id, it.pathIds); },
    },
    h('span.item-emoji', emojiOf(it) || ''),
    h('span.item-main',
      h('span.item-name', nameOf(it), ticker && nameOf(it) !== ticker ? h('span.item-ticker', ticker) : null, s ? seasonTag(s) : null),
      path ? h('span.item-path', path) : null,
      sayOf(it) ? h('span.item-say', sayOf(it)) : null),
    bar ? windBar(it.wind) : metric ? h('span.item-metric', metric(it)) : null,
    it.id ? why(() => ({ ids: [it.id] }), { cls: 'item-why', iconOnly: true, title: `为什么？让老风上网查「${nameOf(it)}」` }) : null);
  }

  function section(key, ic, title, items, opts = {}) {
    if (!items || !items.length) return null;
    const open = expanded.has(key);
    const shown = open ? items : items.slice(0, 3);
    const more = items.length - 3;
    return h('section.psec',
      h('h3.psec-title', ic ? icon(ic, { size: 14 }) : null, h('span', title), opts.hint ? h('span.psec-hint', opts.hint) : null),
      h('ul.items', shown.map((it) => itemRow(it, opts))),
      more > 0 ? h('button.more', {
        type: 'button', onclick: () => { open ? expanded.delete(key) : expanded.add(key); renderMore(); },
      }, open ? '收起' : `展开更多（还有 ${more} 个）`) : null);
  }

  const flowMetric = (it) => (it.flow5 != null ? (it.flow5 >= 0 ? '+' : '') + app.W.money(it.flow5) : '');
  const presMetric = (it) => (it.pres != null ? `拥挤 ${Math.round(it.pres)}` : '');

  /** ①②③ — exactly the picks the map numbers (app.currentPicks). */
  function spotRows(picks) {
    return h('ol.spots', picks.slice(0, 3).map((p, k) => {
      const node = app.D.nodeById(p.id);
      const deep = p.deepId && p.deepId !== p.id ? p.deepId : null;
      const target = deep || p.id;
      const go = () => app.goId(target, deep ? p.deepPathIds : null);
      // the chip belongs to whoever the sentence is about: the deep spot's own season (none while unknown),
      // never the container's (天然气 is 夏 even when 美股 is 冬)
      const s = deep ? (p.deepSeason || null) : seasonOfChild(p.id);
      return h('li.spot', { tabindex: 0, role: 'button', title: '点击飞过去', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
        numBadge(k + 1),
        h('span.spot-body',
          h('span.spot-name',
            h('span', node?.name || p.name || p.id),
            deep ? h('span.spot-deep', icon('chev-r', { size: 11 }), p.deepName || app.D.nodeById(deep)?.name || '') : null,
            s ? seasonTag(s) : null,
            why(() => ({ ids: [target] }), { cls: 'spot-whybtn', title: `为什么？让老风上网查「${(deep ? app.D.nodeById(deep)?.name || p.deepName : node?.name) || ''}」` })),
          p.why ? h('span.spot-why', richText(p.why)) : null));
    }));
  }

  /** The panel says exactly what the map's hero says (same qualifier, same ends). */
  function channelLine() {
    const ch = app.channel;
    if (!ch) return null;
    const nm = (id) => app.D.nodeById(id)?.name || id;
    if (ch.hero === 'inner' && ch.inner) {
      const inn = ch.inner, par = app.D.nodeById(inn.parent);
      const go = () => { const p = app.D.pathIds(inn.parent); if (p) app.go(p); };
      return h('div.channel-wrap',
        h('div.channel-row',
          h('button.channel.inner', { type: 'button', title: `飞进「${par?.name || ''}」看这条主航道`, onclick: go },
            h('span.channel-k', icon('channel', { size: 14 }), '主航道'),
            h('span.channel-in', `在${par?.name || ''}里`),
            h('span.channel-flow', h('span.channel-from', inn.fromName), h('span.channel-arrow', '→'), h('span.channel-to', inn.to2 ? `${inn.toName}、${nm(inn.to2)}` : inn.toName))),
          why(() => ({ kind: 'channel', ids: [inn.from, inn.to] }), { cls: 'channel-why', title: `为什么钱从「${inn.fromName}」流向「${inn.toName}」？让老风上网查` })),
        ch.outerSay ? h('div.channel-note', richText(ch.outerSay)) : null);
    }
    if (ch.hero === 'sink' || ch.hero === 'source') {
      const id = ch.anchor, n = app.D.nodeById(id);
      if (!n) return null;
      const say = String(ch.say || '').replace(/^\s*(今天的)?主航道[：:]?\s*/, '');
      return h('div.channel-row',
        h('button.channel.one', { type: 'button', title: `飞去「${n.name}」看看`, onclick: () => app.goId(id) },
          h('span.channel-k', icon('channel', { size: 14 }), '主航道'),
          h('span.channel-say', richText(say))),
        why(() => ({ ids: [id] }), { cls: 'channel-why', title: `为什么「${n.name}」${ch.hero === 'sink' ? '在吸钱' : '在失血'}？让老风上网查` }));
    }
    const a = app.D.nodeById(ch.from), b = app.D.nodeById(ch.to);
    if (!a || !b) return null;
    return h('div.channel-row',
      h('button.channel', { type: 'button', title: `飞去「${b.name}」看看`, onclick: () => app.goId(b.id) },
        h('span.channel-k', icon('channel', { size: 14 }), '主航道'),
        h('span.channel-from', a.name), h('span.channel-arrow', '→'), h('span.channel-to', b.name)),
      why(() => ({ kind: 'channel', ids: [a.id, b.id] }), { cls: 'channel-why', title: `为什么钱从「${a.name}」流向「${b.name}」？让老风上网查` }));
  }

  /** 估: the still-forming day is scaled to a full day (meta.intraday) — say so where its money shows. */
  function estDayNote() {
    const it = app.meta?.intraday;
    const t = it?.etTime ? `截至美东 ${it.etTime}` : '盘中';
    return h('div.est-day', { title: it?.method || '盘中的成交按全天折算' }, h('span.est-badge', '估'),
      h('span', it?.scaled ? `今天的钱数是按全天折算的估计（${t}）` : it?.open === false ? `刚收盘的快照（美东 ${it.etTime || '16:00'} 抓的），收盘后的完整更新再核一遍` : `今天还没收盘（${t}），钱数只算到现在`));
  }
  app.estDayNote = estDayNote;

  const tourBtn = () => h('button.tour-btn', { type: 'button', onclick: () => app.startTour() },
    icon('play', { size: 15 }), h('span', '60 秒看懂今天'));

  // ---------------------------------------------------------------- head (always visible)
  function renderHead() {
    const node = app.currentNode();
    const map = app.currentMap;
    const i = app.state.dateIndex, latest = i === app.lastIdx;
    const isRoot = app.isRoot(node.id);
    const useBrief = isRoot && latest && app.brief && app.brief.headline;
    const picks = app.currentPicks || [];
    const leaf = (node.children || []).some((c) => c.kind === 'stock');
    let headline = '', lines = [];
    if (useBrief) headline = app.say(app.brief, 'headline');
    else {
      try { const rw = app.W.regionWeather(map, node, node.children || [], i, app.rwOpts ? app.rwOpts(i) : {}); headline = rw?.headline || ''; } catch (e) { console.warn('[panel] regionWeather', e); }
      if (!isRoot) { try { lines = (app.W.describe(nowAt(map?.self, i, node.now), { id: node.id, i }) || []).slice(0, 3); } catch (e) { lines = []; } }
    }
    const selfSeason = !isRoot ? app.seasonAt(map?.self, i) : null;
    // a map whose last day is behind the newest market day (全市场 refreshes nightly) never says 今日
    const behind = latest && app.latestAsOf && app.meta.asOf && app.meta.asOf < app.latestAsOf;
    const live = latest && app.partialInfo ? app.partialInfo() : null;
    const day = cnDate(app.meta.dates[i], true);
    const fill = !live && app.filledInfo ? app.filledInfo(app.meta.dates[i]) : null;   // (收盘价是补的: topbar.js filledInfo)
    const kicker = useBrief ? (behind ? `最近收盘 · ${day}` : `今日天气预报 · ${day}${live ? (live.closed ? ' · 刚收盘' : ' · 盘中') : fill ? ' · 收盘价暂用补的' : ''}`)
      : isRoot ? (latest ? (behind ? `最近收盘 · ${day}` : '今天的天气') : `${cnDate(app.meta.dates[i])}的天气`) : '这里的天气';
    clear(headEl).append(...[
      !latest ? h('div.timetravel', icon('since', { size: 14 }), h('span', `这是 ${cnDate(app.meta.dates[i], true, true)} 的天气`),
        h('button.link', { type: 'button', onclick: () => app.setDate(app.lastIdx) }, '回到今天')) : null,
      h('div.p-kicker', kicker),
      !isRoot ? h('div.p-title', h('span', node.name), node.nStocks ? h('span.p-count', `${node.nStocks} 只`) : null, selfSeason ? seasonTag(selfSeason) : null) : null,
      !isRoot && node.desc ? h('p.p-desc', node.desc) : null,
      headline ? h('h1.headline', richText(headline)) : null,
      lines.length ? h('ul.selfwx', lines.map((l) => h('li', plainLine(l)))) : null,
      lines.length && live ? estDayNote() : null,
      channelLine(),
      isRoot && latest ? tourBtn() : null,
      picks.length ? h('div.p-label', h('span', isRoot ? '先看这里' : leaf ? '这几只先看' : '先看这里'), h('span.p-label-hint', '地图上的 ①②③')) : null,
      picks.length ? spotRows(picks) : null,
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- 更多天气 (folded)
  function moreContent() {
    const node = app.currentNode();
    const i = app.state.dateIndex, latest = i === app.lastIdx;
    const isRoot = app.isRoot(node.id);
    const b = app.brief;
    if (isRoot && latest && b && b.headline) {
      return [
        section('big', 'wind', '各大陆的风', (b.big || []).map((x) => ({ ...x })), { bar: true, season: true }),
        section('inflow', 'arrow-up', '钱在涌进来', b.inflow, { showPath: true, metric: flowMetric }),
        section('outflow', 'arrow-down', '钱在溜走', b.outflow, { showPath: true, metric: flowMetric }),
        section('fronts', 'front', '风向刚变', b.fronts, { showPath: true }),
        section('crowded', 'crowd', '人挤人', b.crowded, { showPath: true, metric: presMetric, hint: '小心踩踏' }),
        section('quiet', 'winter', '冷清洼地', b.quiet, { showPath: true, metric: presMetric, hint: '没人要' }),
        section('storms', 'storm', '风暴', b.storms, { showPath: true }),
        section('stocksIn', 'arrow-up', '个股 · 钱流入最多', b.stocksIn, { metric: flowMetric }),
        section('stocksOut', 'arrow-down', '个股 · 钱流出最多', b.stocksOut, { metric: flowMetric }),
      ];
    }
    let rw = null;
    try { rw = app.W.regionWeather(app.currentMap, node, node.children || [], i, app.rwOpts ? app.rwOpts(i) : {}); } catch (e) { rw = null; }
    rw = rw || {};
    return [
      section('r-in', 'arrow-up', '谁在吸钱', rw.inflow, { bar: true, season: true }),
      section('r-out', 'arrow-down', '谁在失血', rw.outflow, { bar: true, season: true }),
      section('r-front', 'front', '风向刚变', rw.fronts),
      section('r-crowd', 'crowd', '人挤人', rw.crowded, { metric: presMetric, hint: '小心踩踏' }),
      section('r-storm', 'storm', '风暴', rw.storms),
      section('r-quiet', 'winter', '冷清洼地', rw.quiet, { metric: presMetric, hint: '没人要' }),
    ];
  }
  function renderMore() {
    const parts = moreContent().filter(Boolean);
    clear(moreEl);
    if (!parts.length) return;
    const node = app.currentNode();
    const label = app.isRoot(node.id) && app.state.dateIndex === app.lastIdx && app.brief ? '更多天气' : '这里的更多天气';
    moreEl.append(
      h('button.more-toggle' + (moreOpen ? '.open' : ''), {
        type: 'button', 'aria-expanded': moreOpen ? 'true' : 'false',
        onclick: () => { moreOpen = !moreOpen; store.set('mw.moreOpen', moreOpen); renderMore(); },
      }, h('span', label), h('span.more-count', `${parts.length} 组`), icon(moreOpen ? 'chev-u' : 'chev-d', { size: 14 })),
      ...(moreOpen ? [h('div.more-body', parts)] : []));
  }

  // ---------------------------------------------------------------- feature-module sections (§19)
  const sections = new Map();   // id -> {spec, el, bodyEl}
  function ctx() {
    const node = app.currentNode();
    const i = app.state.dateIndex;
    return {
      app, node, map: app.currentMap, dateIndex: i, date: app.meta?.dates?.[i], isLatest: i === app.lastIdx,
      isRoot: app.isRoot(node?.id), picks: app.currentPicks || [], channel: app.channel, brief: app.brief,
      voice: app.state.voice, theme: app.state.theme, view: app.state.view,
    };
  }
  // The shell owns the panel's first screen (§6): a few module sections get a calmer place / shape here.
  // 今日一猜 is a one-line teaser below 真钱流向 until the owner opens it (it is a game, not news).
  const LAYOUT = {
    guess: { order: 57, teaser: { icon: 'guess', text: guessTeaser } },
  };
  function guessTeaser() {
    const d = app.meta?.dates?.[app.state.dateIndex];
    const db = store.get('mw.guess.v1', null);
    const mine = d && db && Array.isArray(db.live) ? db.live.find((r) => r && r.date === d && r.pick) : null;
    const nm = mine ? app.D.nodeById(mine.pick)?.name || '' : '';
    return mine && nm ? `今日一猜 · 你押了「${nm}」` : '今日一猜 · 3 选 1';
  }
  function addSection(spec) {
    if (!spec || !spec.id || typeof spec.render !== 'function') throw new Error('panel.addSection needs {id, render}');
    removeSection(spec.id);
    const lay = LAYOUT[spec.id] || {};
    const bodyEl = h('div.msec-body');
    const head = h('h3.psec-title.msec-title', spec.icon ? icon(spec.icon, { size: 14 }) : null, h('span', spec.title || ''));
    let teaserEl = null;
    if (lay.teaser) {
      const key = 'mw.open.' + spec.id;
      teaserEl = h('button.msec-teaser', { type: 'button', 'aria-expanded': 'false', onclick: () => { store.set(key, !store.get(key, false)); renderSection(entry); } });
    }
    const el = h('section.psec.msec' + (lay.teaser ? '.has-teaser' : ''), { dataset: { id: spec.id } }, teaserEl, spec.title ? head : null, bodyEl);
    const entry = { spec: { order: 50, ...spec, ...(lay.order != null ? { order: lay.order } : {}) }, el, bodyEl, head, teaserEl, lay };
    sections.set(spec.id, entry);
    el.hidden = true;
    placeSections();
    // first render after the module's init() has finished (its own state may not exist yet)
    setTimeout(() => { if (sections.get(spec.id) === entry) renderSection(entry); }, 0);
    return el;
  }
  function removeSection(id) {
    const s = sections.get(id);
    if (!s) return;
    s.el.remove();
    sections.delete(id);
  }
  function placeSections() {
    const all = [...sections.values()].sort((a, b) => a.spec.order - b.spec.order);
    clear(modsA).append(...all.filter((s) => s.spec.order < 100).map((s) => s.el));
    clear(modsB).append(...all.filter((s) => s.spec.order >= 100).map((s) => s.el));
  }
  function renderSection(s, c = ctx()) {
    if (!c.node) return;
    let r;
    // every render starts from an empty body (§19); a module that wants to keep DOM (a half-typed box)
    // can hold on to its own element and append it again
    clear(s.bodyEl);
    try { r = s.spec.render(s.bodyEl, c); } catch (e) { console.error(`[panel] section ${s.spec.id}`, e); r = false; }
    const settle = (v) => {
      s.el.hidden = v === false || !s.bodyEl.childNodes.length;
      // a module that draws its own heading with the same words: do not say it twice
      const t = (s.spec.title || '').trim();
      if (s.head) s.head.hidden = !!t && s.bodyEl.textContent.trim().slice(0, t.length + 2).includes(t);
      if (s.teaserEl) {
        const open = !!store.get('mw.open.' + s.spec.id, false);
        const tz = s.lay.teaser;
        s.teaserEl.setAttribute('aria-expanded', open ? 'true' : 'false');
        s.teaserEl.classList.toggle('open', open);
        s.teaserEl.replaceChildren(icon(tz.icon || 'more', { size: 14 }), h('span.msec-teaser-text', typeof tz.text === 'function' ? tz.text() : tz.text), icon(open ? 'chev-u' : 'chev-r', { size: 13, cls: 'msec-teaser-chev' }));
        s.bodyEl.hidden = !open;
        if (s.head) s.head.hidden = s.head.hidden || !open;
      }
    };
    if (r instanceof Promise) r.then(settle).catch((e) => { console.error(`[panel] section ${s.spec.id}`, e); s.el.hidden = true; });
    else settle(r);
  }
  function renderSections() {
    const c = ctx();
    for (const s of sections.values()) renderSection(s, c);
  }

  // ---------------------------------------------------------------- 接下来 7 天
  // Dated catalysts merged from: 为什么 cards' 接下来盯 (watch), saved scenarios' 认错线 due within 14 days,
  // and prediction markets settling within 7 days that touch the 主航道 / ①②③ / holdings (or are big macro).
  // Deduped by date + topic, sorted by date, times in the owner's local time (AEDT).
  let nextCache = null;          // {at, items}
  const NY = 'America/New_York';
  const nyParts = (ts) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts));
    const g = (k) => +p.find((x) => x.type === k).value;
    return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour'), mm: g('minute') };
  };
  const nyToday = () => { const q = nyParts(Date.now()); return `${q.y}-${String(q.m).padStart(2, '0')}-${String(q.d).padStart(2, '0')}`; };
  const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
  /** New-York wall time → the instant (ms). */
  function nyInstant(iso, hh, mm) {
    const [y, m, d] = iso.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const off = (ts) => { const q = nyParts(ts); return Date.UTC(q.y, q.m - 1, q.d, q.hh, q.mm) - ts; };
    let u = guess - off(guess);
    u = guess - off(u);
    return u;
  }
  const WK = ['日', '一', '二', '三', '四', '五', '六'];
  function whenLabel(it) {
    if (it.ts) {
      const t = new Date(it.ts);
      return { day: `${t.getMonth() + 1}月${t.getDate()}日 周${WK[t.getDay()]}`, time: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` };
    }
    return { day: cnDate(it.date, true), time: '' };
  }
  const TOPICS = [[/美联储|联储|FOMC|议息|Fed\b/i, 'fed'], [/非农|就业报告|payroll/i, 'nfp'], [/CPI|通胀/i, 'cpi'], [/选举|大选|election/i, 'election'], [/财报|earnings/i, 'earn']];
  const topicOf = (t) => { for (const [rx, k] of TOPICS) if (rx.test(t)) return k; return String(t).replace(/\s+/g, '').slice(0, 10); };
  const shorten = (t, n = 46) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  async function gatherNext() {
    const D = app.D;
    const today = nyToday(), end7 = addDays(today, 7), end14 = addDays(today, 14);
    const items = [];
    const kids = (D.rootNodeOf()?.children || []).map((c) => c.id);
    const kidOf = (id) => { const p = D.pathIds(id); return p ? p.find((x) => kids.includes(x)) || null : null; };
    // why cards / scenarios / markets name curated ids: on 全市场 / 全球 those are not in this map's tree, so the
    // curated search index names them (never a raw id like 「bonds、ai-compute」 on screen)
    let curated = null;
    try { const s = await D.loadSharedSearch('search.json'); curated = new Map((Array.isArray(s) ? s : []).map((r) => [r.id, r.name])); } catch (e) { curated = null; }
    // 为什么 cards from the 全球 map name gl-… nodes (「动：gl-fr」 → 法国); the search bar loads this index anyway
    try {
      const g = await D.loadSharedSearch('gl/search.json');
      if (Array.isArray(g)) { curated = curated || new Map(); for (const r of g) if (r && r.id && r.name && !curated.has(r.id)) curated.set(r.id, r.name); }
    } catch (e) { /* no 全球 map */ }
    const nameOf_ = (id) => D.nodeById(id)?.name || D.nodeById('s:' + id)?.name || curated?.get(id) || curated?.get('s:' + id) || id;
    // 1) 为什么 cards (latest data day first): their watch lines
    try {
      const idx = await D.load('why/index.json');
      const cards = Object.entries(idx?.cards || {}).filter(([, c]) => c && c.date && c.date >= addDays(app.meta.asOf || today, -6));
      cards.sort((a, b) => String(b[1].date).localeCompare(String(a[1].date)));
      const files = await Promise.all(cards.slice(0, 16).map(([k]) => D.load('why/' + k + '.json').catch(() => null)));
      for (const c of files) {
        if (!c || !Array.isArray(c.watch)) continue;
        for (const w of c.watch) {
          const by = String(w?.by || '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(by) || by < today || by > end7) continue;
          const what = String(w.what || '');
          const tm = what.match(/(\d{1,2})[:：](\d{2})\s*[（(]?\s*美东/);
          const ids = (c.ids || []).map(String);
          items.push({
            // (the time column shows the owner's own clock, so the text keeps saying whose 14:00 it is: 美东 14:00)
            date: by, ts: tm ? nyInstant(by, +tm[1], +tm[2]) : null,
            what: shorten(what.replace(/(\d{1,2}[:：]\d{2})\s*[（(]\s*美东\s*[）)]/, '美东 $1').replace(/[（(]\s*美东\s*[）)]/, '')), topic: topicOf(what),
            where: c.kind === 'channel' && ids.length === 2 ? `${nameOf_(ids[0])} → ${nameOf_(ids[1])}` : ids.map(nameOf_).join('、'),
            why: { kind: c.kind || 'node', ids: c.ids, map: c.map || undefined }, src: 'why',
          });
        }
      }
    } catch (e) { /* no 为什么 cards yet */ }
    // 2) saved scenarios: 认错线 that fall due within 14 days
    try {
      const sx = await D.load('scenarios/index.json');
      const list = (sx?.scenarios || []).slice(0, 12);
      const full = await Promise.all(list.map((x) => D.load('scenarios/' + x.id + '.json').catch(() => null)));
      full.forEach((sc, k) => {
        for (const ks of sc?.killSignals || []) {
          const by = String(ks?.by || '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(by) || by < today || by > end14) continue;
          const ep = (sc.epicenters || [])[0];
          items.push({ date: by, what: shorten(`认错线：${ks.signal}`), topic: topicOf(ks.signal), where: `推演「${list[k].title}」${ep ? ' · ' + nameOf_(ep) : ''}`, why: null, src: 'scenario' });
        }
      });
    } catch (e) { /* no scenarios */ }
    // 3) prediction markets settling within 7 days that touch what the map lights today (or big macro)
    try {
      const pm = await D.load('polymarket.json');
      const byId = new Map((pm?.markets || []).map((m) => [String(m.id), m]));
      const ch = app.channel || {};
      const lit = new Set([ch.from, ch.to, ch.anchor, ch.inner?.from, ch.inner?.to, ...(app.currentPicks || []).flatMap((p) => [p.id, p.deepId]),
        ...(app.holdings || []).map((x) => x.id)].filter(Boolean));
      const touches = (nid) => { const p = D.pathIds(nid); return !!p && p.some((x) => lit.has(x)); };
      const evs = [];
      for (const ev of pm?.events || []) {
        const ms = (ev.markets || []).map((id) => byId.get(String(id))).filter(Boolean);
        // the date of the outcome the title speaks for (a ladder of dates lists its earliest rung first)
        const endDate = byId.get(String(ev.fav?.id))?.endDate || ms.map((m) => m.endDate).filter(Boolean).sort()[0];
        if (!endDate || endDate < today || endDate > end7) continue;
        const nodes = [...new Set(ms.flatMap((m) => (m.nodes || []).map((n) => n.id)))];
        const hit = nodes.filter(touches);
        const macro = ev.cat === 'rates' && (ev.volume || 0) >= 5e6;
        if (!hit.length && !macro) continue;
        const terr = [...new Set((hit.length ? hit : nodes).map(kidOf).filter(Boolean))].slice(0, 2);
        const fav = ev.fav || {};
        let title = String(ev.titleZh || ev.title || '');
        if (/……|\.\.\./.test(title)) title = String(byId.get(String(fav.id))?.qZh || ms[0].qZh || title);   // a template title: the market's own question
        title = title.replace(/[？?]\s*$/, '');
        const pct = Number.isFinite(+fav.prob) ? Math.round(+fav.prob * 100) : null;
        const lab = String(fav.labelZh || '').trim();
        const odds = pct == null ? '' : lab && !/^(是|否|yes|no)$/i.test(lab) ? `最可能${lab}（${pct}%）` : `概率 ${pct}%`;
        evs.push({ date: endDate, what: shorten(title), topic: topicOf(title), where: terr.map(nameOf_).join('、') || (macro ? nameOf_('bonds') : ''),
          why: terr.length ? { kind: 'market', ids: [String(fav.id || ms[0].id)] } : null, src: 'market', vol: ev.volume || 0, odds });
      }
      evs.sort((a, b) => b.vol - a.vol);
      items.push(...evs.slice(0, 4));
    } catch (e) { /* no polymarket */ }
    // dedupe: same topic within a day → one row (the dated 为什么 line wins; it borrows the market's odds)
    items.sort((a, b) => (a.src === 'why' ? 0 : 1) - (b.src === 'why' ? 0 : 1));
    const out = [];
    for (const it of items) {
      const dup = out.find((o) => o.topic === it.topic && Math.abs(Date.parse(o.date) - Date.parse(it.date)) <= 864e5);
      if (dup) {
        if (it.ts && !dup.ts) Object.assign(dup, { ts: it.ts, date: it.date, what: it.what, why: it.why || dup.why });   // the line with a clock time wins
        if (!dup.odds && it.odds) dup.odds = it.odds;
        // the market names the territory it moves most directly: it goes first
        const ws = [...new Set((it.src === 'market' ? [it.where, dup.where] : [dup.where, it.where]).join('、').split('、').filter(Boolean))].slice(0, 2);
        dup.where = ws.join('、');
        continue;
      }
      out.push(it);
    }
    out.sort((a, b) => (a.ts || Date.parse(a.date + 'T12:00:00Z')) - (b.ts || Date.parse(b.date + 'T12:00:00Z')));
    return out;
  }

  function renderNext(el, c) {
    if (!c.isRoot || !c.isLatest) return false;
    const draw = (items) => {
      clear(el);
      if (!items.length) { el.append(h('p.next-empty', '这几天没有排上日程的大事：看风，不看日历。')); return; }
      const open = expanded.has('next7');
      const shown = open ? items : items.slice(0, 3);
      el.append(h('ul.next7', shown.map((it) => {
        const w = whenLabel(it);
        return h('li.next-item',
          h('span.next-when', h('b', w.day), w.time ? h('span.next-time', w.time) : null),
          h('span.next-main', h('span.next-what', it.what), (it.where || it.odds) ? h('span.next-where', [it.where ? `动：${it.where}` : '', it.odds ? `预言市场：${it.odds}` : ''].filter(Boolean).join(' · ')) : null),
          it.why && app.whyButton ? app.whyButton(() => it.why, { cls: 'item-why next-why', iconOnly: true, title: '为什么？这件事会怎么动钱' }) : null);
      })));
      if (items.length > 3) {
        el.append(h('button.more', { type: 'button', onclick: () => { open ? expanded.delete('next7') : expanded.add('next7'); draw(items); } }, open ? '收起' : `展开更多（还有 ${items.length - 3} 件）`));
      }
    };
    if (nextCache && Date.now() - nextCache.at < 5 * 60_000) { draw(nextCache.items); return undefined; }
    return gatherNext().then((items) => { nextCache = { at: Date.now(), items }; if (el.isConnected) draw(items); return items.length ? undefined : undefined; })
      .catch((e) => { console.warn('[panel] next7', e); return false; });
  }

  // ---------------------------------------------------------------- render
  function render(keepScroll = false) {
    const node = app.currentNode();
    if (!node) return;
    const key = node.id + '|' + app.state.path.join('/');
    if (key !== lastKey) { expanded.clear(); lastKey = key; keepScroll = false; }
    const st = body.scrollTop;
    renderHead();
    renderMore();
    renderSections();
    body.scrollTop = keepScroll ? st : 0;
  }

  // ---------------------------------------------------------------- 接下来 7 天 (what decides the next move)
  addSection({ id: 'next7', title: '接下来 7 天', icon: 'since', order: 20, render: renderNext });
  app.on('dataReloaded', () => { nextCache = null; });

  app.on('nav', () => render(true));
  app.on('date-settled', () => render(true));
  app.on('picks', () => render(true));
  app.on('voice', () => render(true));
  app.on('data', () => render());
  const refresh = () => render(true);
  return { render, addSection, removeSection, refresh, rerender: refresh, sections: () => [...sections.keys()] };
}
