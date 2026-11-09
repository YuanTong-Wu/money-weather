// topbar.js — brand, breadcrumb (+☆), search, feature buttons (app.topbar.addButton), lens, map switch
// (精选 / 全市场 / 全球 — each lights up when its data exists), 地图：真实 | 抽象 (§26), 2D / 3D planet, date (+ 盘中 · 截至 HH:MM 美东
// while the last bar is still forming) + refresh, 日/夜, settings (语气 · 地图 · 星球 · 主题 · 刷新 · 怎么看), help.
import { h, clear, cnDate, icon, logo } from './dom.js';
import { mountSearch } from './search.js';

// feature buttons that keep their label visible (the big modes); the rest are icon-only below 1680px
const PRIMARY = new Set(['scenario']);

export function initTopbar(app) {
  const root = document.getElementById('topbar');
  clear(root);

  // ---- left: brand + breadcrumb
  const crumbs = h('nav.crumbs', { 'aria-label': '位置' });
  const brand = h('a.brand', { href: '#/', title: '回到地球', onclick: (e) => { e.preventDefault(); app.go([app.rootId()]); } },
    logo(24), h('span.brand-name', '钱的天气'));

  // ---- center: search
  const input = h('input#search', {
    type: 'search', placeholder: '搜：英伟达 / NVDA / 存储 / 核电', autocomplete: 'off', spellcheck: false,
    'aria-label': '搜索板块或股票', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'search-results',
  });
  const results = h('ul#search-results.search-results', { role: 'listbox', hidden: true });
  const searchBox = h('div.search', icon('search', { size: 16, cls: 'search-icon' }), input, h('kbd.search-kbd', '/'), results);
  mountSearch(input, results, { getIndex: () => app.searchIndex || [], onPick: (e) => app.goSearch(e) });

  // ---- right cluster
  const mods = h('div.tb-mods');
  const lensBtn = h('button.tb-btn.lens-btn', { type: 'button', title: '镜片：只看带某个标签的地方', 'aria-haspopup': 'true' });
  const lensPop = h('div.pop.lens-pop', { hidden: true, role: 'menu' });
  const lensWrap = h('div.pop-wrap', lensBtn, lensPop);

  const mapSeg = h('div.seg.tb-mapseg', { role: 'group', 'aria-label': '地图' });
  // §26 地图：真实 | 抽象 — one real Earth (companies at their HQs) or continents with real silhouettes
  const geoSeg = h('div.seg.tb-mapseg.tb-geoseg', { role: 'group', 'aria-label': '地图：真实 或 抽象', title: '真实地理 / 抽象大陆', style: { marginLeft: '2px' } });
  // (its own few rules: a small globe + "地图" always in front, so it never reads as a data filter; when the bar is
  // narrow it is 2D | 3D that moves into the settings popover, never the map toggle)
  if (!document.getElementById('tb-geoseg-style')) {
    document.head.append(h('style#tb-geoseg-style', '.tb-geoseg .seg-opt{padding:0 7px}'
      + '.tb-geoseg .tb-geolab{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--ink-3, var(--ink-4));padding:0 3px 0 6px;white-space:nowrap;cursor:default}'
      + '.tb-geoseg .tb-geolab svg{flex:none;opacity:.8}'
      + '@media (max-width:1280px){.tb-dimseg{display:none}}'));
  }
  const GLOBE_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">'
    + '<circle cx="10" cy="10" r="7"/><path d="M3 10h14"/><path d="M10 3c2.2 2.1 3.2 4.4 3.2 7s-1 4.9-3.2 7c-2.2-2.1-3.2-4.4-3.2-7s1-4.9 3.2-7z"/></svg>';
  const dimSeg = h('div.seg.tb-dimseg', { role: 'group', 'aria-label': '星球：2D 或 3D' });
  const dateEl = h('button.tb-date', { type: 'button', title: '数据日期', onclick: () => { if (app.state.dateIndex !== app.lastIdx) app.setDate(app.lastIdx); } });
  const refreshBtn = h('button.tb-icon.refresh-btn', { type: 'button', title: '刷新到最新收盘', 'aria-label': '刷新数据', onclick: () => app.refresh({ quick: true }) },
    icon('refresh', { size: 17 }));
  const themeBtn = h('button.tb-icon.theme-btn', { type: 'button', onclick: () => app.toggleTheme() });
  const setBtn = h('button.tb-icon', { type: 'button', title: '设置：语气、地图、主题', 'aria-label': '设置', 'aria-haspopup': 'true' }, icon('sliders', { size: 17 }));
  const setPop = h('div.pop.set-pop', { hidden: true, role: 'dialog', 'aria-label': '设置' });
  const setWrap = h('div.pop-wrap', setBtn, setPop);
  const helpBtn = h('button.tb-icon', { type: 'button', title: '怎么看这张图（?）', 'aria-label': '怎么看这张图', onclick: () => app.openTutorial() }, icon('help', { size: 18 }));

  // new data arrived while the page was open and the owner was busy: one quiet chip, one click reloads it all
  const freshBtn = h('button.tb-fresh', { type: 'button', hidden: true, title: '数据又更新了：点一下读进来（地图、预报一起换）', onclick: () => app.applyFresh?.() }, h('span.tb-fresh-dot'), h('span', '有新数据 · 更新'));
  app.on('fresh', (g) => { freshBtn.hidden = !g; });
  const right = h('div.tb-right', mods, lensWrap, mapSeg, geoSeg, dimSeg, h('span.tb-sep'), h('div.tb-dategroup', dateEl, freshBtn, refreshBtn), themeBtn, setWrap, helpBtn);
  root.append(h('div.tb-left', brand, crumbs), searchBox, right);

  // ---- popovers (one open at a time)
  const pops = [[lensWrap, lensPop, lensBtn], [setWrap, setPop, setBtn]];
  const closePopovers = () => {
    let closed = false;
    for (const [, pop, btn] of pops) if (!pop.hidden) { pop.hidden = true; btn.classList.remove('open'); closed = true; }
    return closed;
  };
  const togglePop = (pop, btn, render) => {
    const willOpen = pop.hidden;
    closePopovers();
    if (willOpen) { render?.(); pop.hidden = false; btn.classList.add('open'); }
  };
  lensBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePop(lensPop, lensBtn, renderLens); });
  setBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePop(setPop, setBtn, renderSettings); });
  document.addEventListener('pointerdown', (e) => { if (!pops.some(([w]) => w.contains(e.target))) closePopovers(); });

  // ---- segmented control helper
  function seg(el, options, value, onPick, { disabled = {}, always = false } = {}) {
    clear(el);
    for (const [v, label, title] of options) {
      el.append(h('button.seg-opt' + (v === value ? '.on' : ''), {
        type: 'button', 'aria-pressed': v === value ? 'true' : 'false', title: title || label,
        disabled: !!disabled[v], onclick: () => { if (v !== value || always) onPick(v); },
      }, label));
    }
    return el;
  }

  // ---- lens menu
  function renderLens() {
    const tag = app.state.lens;
    clear(lensBtn).append(icon('lens', { size: 16 }), h('span.tb-label', tag ? (app.meta.tags?.[tag] || tag) : '镜片'));
    lensBtn.classList.toggle('on', !!tag);
    clear(lensPop);
    lensPop.append(h('div.pop-title', '只看这一类，其他地方变暗'));
    const chips = h('div.chips');
    chips.append(h('button.chip' + (!tag ? '.on' : ''), { type: 'button', onclick: () => pickLens(null) }, '全部'));
    for (const [k, label] of Object.entries(app.meta.tags || {})) {
      chips.append(h('button.chip' + (tag === k ? '.on' : ''), { type: 'button', onclick: () => pickLens(k) }, label));
    }
    lensPop.append(chips);
  }
  const pickLens = (k) => { app.setLens(k); closePopovers(); renderLens(); };

  // ---- map switch: 精选 always; 全市场 / 全球 light up when data/fm/ · data/gl/ exist (§19, §23)
  const MAPS = () => [
    ['curated', '精选', '精选地图：按主题分的大陆'],
    ['full', '全市场', app.fullMarket ? '全市场：按行业分的全部美股' : '全市场地图还没生成（data/fm/）'],
    ['global', '全球', app.globalMap ? '全球：亚洲 → 欧洲 → 美国，跟着太阳更新的全世界' : '全球地图还在建（data/gl/ 生成后自动亮起）'],
  ];
  const mapDisabled = () => ({ full: !app.fullMarket, global: !app.globalMap });
  // the map the owner asked for last (a switch may still be loading): a quick second click always counts
  const pickMap = (v) => { const p = app.setMap(v); renderMapSeg(); return p; };
  function renderMapSeg() {
    seg(mapSeg, MAPS(), app.state.wantMap || app.state.map, pickMap, { disabled: mapDisabled(), always: true });
  }

  // ---- 地图：真实 | 抽象 (§26; default 真实, remembered)
  const GEOS = [
    ['real', '真实', '真实地理：一个真实的地球——公司在总部所在的城市，板块就是它的公司所在的地方；点进去镜头会飞过去、放大'],
    ['abstract', '抽象', '抽象大陆：每个板块一块大陆（用真实大陆和岛屿的轮廓），按钱的关系摆在海里'],
  ];
  function renderGeoSeg() {
    seg(geoSeg, GEOS, app.state.geoMode === 'abstract' ? 'abstract' : 'real', (v) => { app.setGeoMode?.(v); renderGeoSeg(); });
    const lab = h('span.tb-geolab', { 'aria-hidden': 'true', title: '真实地理 / 抽象大陆' });
    lab.innerHTML = GLOBE_SVG + '<span>地图</span>';
    geoSeg.prepend(lab);
  }

  // ---- 2D / 3D planet (§22)
  function renderDimSeg() {
    const note = app.renderNote && app.state.render === '2d' ? `（${app.renderNote}）` : '';
    seg(dimSeg, [
      ['2d', '2D', `平面天气图${note}`],
      ['3d', '3D', app.state.render === '3d' ? '立体星球（太卡会自动换回 2D）' : `换成立体星球${note ? '，再试一次' : ''}`],
    ], app.state.render, (v) => { app.setRender(v); });
  }

  // ---- settings popover
  function renderSettings() {
    clear(setPop);
    const row = (label, hint, control) => h('div.set-row', h('div.set-label', h('span', label), hint ? h('span.set-hint', hint) : null), control);
    setPop.append(
      h('div.pop-title', '设置'),
      row('语气', '老风说话的口气', seg(h('div.seg'), [['sharp', '犀利'], ['mild', '温和']], app.state.voice, (v) => { app.setVoice(v); renderSettings(); })),
      row('地图', app.globalMap ? '精选主题 / 全部美股 / 全世界' : app.fullMarket ? '精选主题 / 全部美股（全球在建）' : '全市场数据还没生成',
        seg(h('div.seg'), MAPS().map(([v, l]) => [v, l]), app.state.wantMap || app.state.map, (v) => { pickMap(v).then(renderSettings); renderSettings(); }, { disabled: mapDisabled(), always: true })),
      row('地图形状', app.state.geoMode === 'abstract' ? '每个板块一块大陆' : '真实地球：公司在总部，板块在它们所在的地方',
        seg(h('div.seg'), GEOS.map(([v, l]) => [v, l]), app.state.geoMode === 'abstract' ? 'abstract' : 'real', (v) => { app.setGeoMode?.(v); renderSettings(); })),
      row('星球', app.state.render === '3d' ? '立体，太卡会自动换回 2D' : (app.renderNote || '平面天气图'),
        seg(h('div.seg'), [['2d', '2D'], ['3d', '3D']], app.state.render, (v) => { app.setRender(v).then(renderSettings); })),
      row('主题', '纸面白天 / 藏青夜晚', seg(h('div.seg'), [['day', '日'], ['night', '夜']], app.state.theme, (v) => { app.setTheme(v); renderSettings(); })),
      h('div.pop-sep'),
      h('button.pop-item', { type: 'button', onclick: () => { closePopovers(); app.refresh({ quick: true }); } },
        icon('refresh', { size: 16 }), h('span', '刷新到最新收盘'), h('span.pop-item-sub', `现在：${cnDate(app.meta.asOf, true)}`)),
      h('button.pop-item', { type: 'button', onclick: () => { closePopovers(); app.refresh(); } },
        icon('layers', { size: 16 }), h('span', '完整更新数据'), h('span.pop-item-sub', '几分钟')),
      h('button.pop-item', { type: 'button', onclick: () => { closePopovers(); app.openTutorial(); } },
        icon('help', { size: 16 }), h('span', '怎么看这张图')),
      h('div.pop-keys',
        h('span', h('kbd', '/'), '搜索'), h('span', h('kbd', '空格'), '播放'),
        h('span', h('kbd', '←'), h('kbd', '→'), '换一天'), h('span', h('kbd', 'Esc'), '飞回')));
  }

  // ---- theme toggle
  function renderTheme() {
    const night = app.state.theme === 'night';
    clear(themeBtn).append(icon(night ? 'sun' : 'moon', { size: 17 }));
    themeBtn.title = night ? '换成白天（纸面）' : '换成夜晚（藏青）';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }

  // ---- breadcrumb
  function renderCrumbs() {
    clear(crumbs);
    const nodes = app.pathNodes();
    const stock = app.state.view === 'stock' && app.state.ticker
      ? app.D.nodeById('s:' + app.state.ticker) || { id: 's:' + app.state.ticker, name: app.stockJson?.name || app.state.ticker, ticker: app.state.ticker, offMap: true }
      : null;
    // long paths: root › … › parent › current (the hidden middle is one click away)
    const items = nodes.map((n, k) => ({ n, path: app.state.path.slice(0, k + 1) }));
    const total = items.length + (stock ? 1 : 0);
    let shown = items, hidden = [];
    if (total > 4) {
      const keep = stock ? 1 : 2;              // the root + the last `keep` planet levels stay visible
      hidden = items.slice(1, items.length - keep);
      shown = [items[0], ...items.slice(items.length - keep)];
    }
    shown.forEach((it, j) => {
      const last = j === shown.length - 1 && !stock;
      if (j) crumbs.append(icon('chev-r', { size: 12, cls: 'crumb-sep' }));
      if (j === 1 && hidden.length) {
        const up = hidden[hidden.length - 1];
        crumbs.append(h('a.crumb.more', {
          href: '#/' + up.path.join('/'), title: '飞回「' + hidden.map((x) => x.n.name).join(' › ') + '」',
          onclick: (e) => { e.preventDefault(); app.go(up.path); },
        }, '…'), icon('chev-r', { size: 12, cls: 'crumb-sep' }));
      }
      crumbs.append(h(last ? 'span.crumb.cur' : 'a.crumb', last ? {} : {
        href: '#/' + it.path.join('/'),
        title: `飞回「${it.n.name}」`,
        onclick: (e) => { e.preventDefault(); app.go(it.path); },
      }, h('span.crumb-name', it.n.name)));
    });
    if (stock) {
      crumbs.append(icon('chev-r', { size: 12, cls: 'crumb-sep' }),
        h('span.crumb.cur', h('span.crumb-name', stock.name || app.state.ticker), stock.name !== app.state.ticker ? h('span.crumb-ticker', app.state.ticker) : null));
    }
    const pinId = stock ? (stock.offMap ? null : stock.id) : app.state.nodeId;
    if (pinId && !app.isRoot(pinId)) {
      const on = app.isPinned(pinId);
      crumbs.append(h('button.pin-btn' + (on ? '.on' : ''), {
        type: 'button', title: on ? '取消关注' : '关注这里（放进我的雷达）', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => app.togglePin(pinId),
      }, icon(on ? 'star-fill' : 'star', { size: 15 })));
    }
  }

  // ---- date (+ 盘中 · 截至 HH:MM 美东 when meta.partial says the last bar is still forming)
  /** {hm:'10:36', local:'01:36', when:Date} when the newest day is an intraday bar, else null. */
  function partialInfo() {
    const pt = app.meta?.partial;
    const last = app.meta?.dates?.[app.lastIdx];
    if (!pt || !pt.date || pt.date !== last) return null;
    const iso = String(pt.fetchedAt || pt.at || '');
    const m = iso.match(/T(\d{2}):(\d{2})/);
    if (!m) return { hm: null, local: null };
    const t = Date.parse(iso);
    const local = isFinite(t) ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : null;
    // the 16:00 snapshot right after the bell: the day is done, only the full after-close update is still to come
    const closed = app.meta?.intraday?.date === pt.date && app.meta.intraday.open === false;
    return { hm: `${m[1]}:${m[2]}`, local, closed };
  }
  app.partialInfo = partialInfo;
  /** meta.filled entry for day d: Yahoo had not sent its close yet, pipeline/fetch.py rebuilt it from 60-minute bars. */
  function filledInfo(d) {
    return (Array.isArray(app.meta?.filled) ? app.meta.filled : []).find((f) => f && f.date === d) || null;
  }
  app.filledInfo = filledInfo;
  function renderDate() {
    const i = app.state.dateIndex, d = app.meta.dates[i];
    const latest = i === app.lastIdx;
    const live = latest ? partialInfo() : null;
    const fill = live ? null : filledInfo(d);
    clear(dateEl).append(
      latest ? h('span.date-dot' + (live ? '.live' : staleDays() >= 4 ? '.stale' : '')) : icon('since', { size: 14 }),
      h('span', cnDate(d), h('span.date-wd', cnDate(d, true).replace(cnDate(d), ''))),
      live ? h('span.date-live', h('b', live.closed ? '刚收盘' : '盘中'), live.hm && !live.closed ? h('span.date-live-t', ` · 截至 ${live.hm} 美东`) : null)
        : latest ? h('span.date-sub', '收盘') : h('span.date-sub', '回到今天'),
      ...(fill ? [h('span.date-fill', '补')] : []));
    dateEl.classList.toggle('past', !latest);
    dateEl.classList.toggle('live', !!live);
    const it = app.meta?.intraday;
    dateEl.title = live
      ? (it?.say && it.date === d
        ? `${it.say}${it.scaled && !/折算/.test(it.say) ? ' 最后一天的钱数是按全天折算的估计。' : ' 地图上最后一天的钱数都是估计（估）。'}`
        : `${cnDate(d, true, true)} 还没收盘：数据截至美东 ${live.hm || '?'}${live.local ? `（你那边 ${live.local}）` : ''}。今天的成交还没走完，${it?.scaled ? '最后一天的钱数是按全天折算的估计' : '风和拥挤度会偏小'}，收盘后自动换成真数。`)
      : latest ? `最新数据：${cnDate(d, true, true)} 收盘` : `你在看过去：${cnDate(d, true, true)}（点击回到最新）`;
    // (「补」: the day's real close is not in yet — say what is real and what stands in for it)
    if (fill) dateEl.title += `\n${cnDate(d, true, true)} 的正式收盘价 Yahoo 还没给：${fill.n ? `${fill.n} 只` : '这些'}股票的收盘价先用当天最后一小时的成交价补上（和正式收盘价通常只差几分钱），${fill.ohlc60 ? `开盘、最高、最低价除 ${fill.ohlc60} 只也用分时数据补以外都是真数，成交量是真数` : '开盘、最高、最低价和成交量都是真数'}。正式收盘价一到会自动换掉。`;
  }

  // ---- refresh state (+ a quiet dot when the data is several days old)
  const staleDays = () => {
    const asOf = app.meta.asOf;
    if (!asOf) return 0;
    return Math.floor((Date.now() - new Date(asOf + 'T23:59:00').getTime()) / 86400000);
  };
  function setRefresh(mode, text) {
    const stale = mode !== 'busy' && staleDays() >= 4;
    refreshBtn.classList.toggle('busy', mode === 'busy');
    refreshBtn.classList.toggle('stale', !!stale);
    refreshBtn.title = text || (stale ? `数据停在 ${cnDate(app.meta.asOf, true)}，点一下抓最新的` : `刷新到最新收盘（现在是 ${cnDate(app.meta.asOf, true)}）`);
  }

  // ---- feature buttons (§19)
  const modBtns = new Map();   // id -> {el, order, badge}
  function addButton({ id, icon: ic, label = '', title = '', onClick, order = 50, primary = false } = {}) {
    if (!id) throw new Error('topbar.addButton needs an id');
    removeButton(id);
    const badge = h('span.tb-badge', { hidden: true });
    if (PRIMARY.has(id)) primary = true;
    const el = h('button.tb-btn.tb-mod' + (primary ? '.primary' : ''), {
      type: 'button', title: title || label, 'aria-label': title || label, dataset: { id },
      onclick: (e) => { closePopovers(); try { onClick?.(e, el); } catch (err) { console.error(`[topbar] ${id}`, err); } },
    }, icon(ic || id, { size: 17 }), label ? h('span.tb-label', label) : null, badge);
    modBtns.set(id, { el, order, badge });
    const sorted = [...modBtns.values()].sort((a, b) => a.order - b.order);
    clear(mods).append(...sorted.map((b) => b.el));
    return el;
  }
  function removeButton(id) {
    const b = modBtns.get(id);
    if (!b) return;
    b.el.remove();
    modBtns.delete(id);
  }
  /** setBadge(id, text|null, tone?) — tone: 'ok' | 'warn' | 'bad' | 'info' (colour of the badge). */
  function setBadge(id, text, tone = null) {
    const b = modBtns.get(id);
    if (!b) return;
    const show = text != null && text !== false;
    b.badge.hidden = !show;
    b.badge.textContent = show ? String(text) : '';
    b.badge.className = 'tb-badge' + (show && String(text).trim() === '' ? ' dot' : '') + (tone ? ' ' + tone : '');
  }

  app.on('nav', renderCrumbs);
  app.on('track', renderCrumbs);
  app.on('pins', renderCrumbs);
  app.on('date', renderDate);
  app.on('lens', renderLens);
  app.on('theme', () => { renderTheme(); if (!setPop.hidden) renderSettings(); });
  app.on('voice', () => { if (!setPop.hidden) renderSettings(); });
  app.on('map', () => { renderMapSeg(); renderLens(); });
  app.on('maps', () => { renderMapSeg(); if (!setPop.hidden) renderSettings(); });
  app.on('render', () => { renderDimSeg(); if (!setPop.hidden) renderSettings(); });
  app.on('geoMode', () => { renderGeoSeg(); if (!setPop.hidden) renderSettings(); });
  app.on('data', () => { renderLens(); renderDate(); renderCrumbs(); setRefresh('idle'); renderMapSeg(); });
  renderLens(); renderDate(); renderCrumbs(); renderTheme(); renderMapSeg(); renderGeoSeg(); renderDimSeg(); setRefresh('idle');

  return {
    focusSearch: () => input.focus(), setRefresh, renderCrumbs, renderDate, closePopovers,
    addButton, removeButton, setBadge, button: (id) => modBtns.get(id)?.el || null,
  };
}
