// hovercard.js — card that follows the pointer over a territory: name, season, one line, ≤4 weather lines,
// idx sparkline (§4, §8.2, §14), and a 为什么？ (§21). Also the right-click / long-press menu (§18
// onContextMenu): 为什么？ / 飞进去 / 关系网 / 让 Claude 去查 / 关注.
// The card follows the pointer; when the pointer rests (~0.4 s) it settles and becomes clickable, and it
// stays while the pointer travels into it (a short grace for the territories crossed on the way) — so the
// 为什么？ button can actually be reached. Keyboard: W asks 为什么 for the territory under the pointer.
import { h, clear, sparkline, nowAt, clamp, icon, plainLine } from './dom.js';

const SEASON_NAME = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

export function initHoverCard(app) {
  const el = document.getElementById('hovercard');
  let cur = null, xy = null, raf = 0;
  let live = false, liveAt = null, restTimer = 0, graceTimer = 0, inCard = false;
  const REST_MS = 380, GRACE_MS = 420, FAR = 190;

  const targetOf = (n) => ({ kind: n.kind === 'stock' || String(n.id).startsWith('s:') ? 'stock' : 'node', ids: [n.id] });

  const lineText = plainLine;

  const render = () => {
    if (!cur) return;
    const n = cur, i = app.state.dateIndex;
    const series = app.currentMap?.children?.[n.id];
    const snap = nowAt(series, i, n.now);
    let lines = [];
    try { lines = (app.W.describe(snap, { id: n.id, i }) || []).slice(0, 4); } catch (e) { lines = []; }
    const isStock = n.kind === 'stock';
    const pinned = app.isPinned(n.id);
    const idx = series?.idx;
    let season = app.seasonAt(series, i);
    // words.describe may already speak the season: then say it once
    if (season && lines.some((l) => { const t = lineText(l); return (season.next && t.includes(season.next)) || t.includes(`${season.name}（`); })) season = null;
    const est = !!(n.est || n.now?.est || series?.est);
    // §23: when the real money points the other way from the estimate, that is the first thing to say here —
    // the estimate's lines below stay, but the card opens with the clash
    let clash = null;
    try {
      const rm = app.realMoney ? app.realMoney(n.id, i) : null;
      // (describe already opened with the real money → no second copy of the same sentence)
      if (rm && snap?.flow5 != null && app.realMoneyClash?.(rm, snap.flow5) && !lines.some((l) => /真钱/.test(lineText(l)))) {
        // name what was measured (an ETF / connect series may cover only part of the territory): literally true
        clash = snap.flow5 < 0 ? `按成交估是钱在出，可${rm.label}在进：5天 +${app.W.money(Math.abs(rm.flow5))}`
          : `按成交估是钱在进，可${rm.label}在出：5天 −${app.W.money(Math.abs(rm.flow5))}`;
      }
    } catch (e) { clash = null; }
    clear(el).append(...[
      h('div.hc-head',
        h('span.hc-name', n.name),
        isStock && n.ticker ? h('span.hc-ticker', n.ticker) : null,
        est ? h('span.est-badge', { title: n.basis || series?.basis || '估算值，等你补数据' }, '估') : null,
        pinned ? icon('star-fill', { size: 13, cls: 'hc-pin' }) : null),
      (n.desc || n.note) ? h('div.hc-desc', n.desc || n.note) : null,
      clash ? h('div.hc-clash', h('span.rm-badge', '真钱'), h('span', clash)) : null,
      season ? h('div.hc-season.' + season.key, icon(season.key, { size: 14 }),
        h('span.hc-season-name', `${season.name || SEASON_NAME[season.key]}天`),
        h('span.hc-season-next', [season.now, season.next].filter(Boolean).join(' → '))) : null,
      lines.length ? h('ul.hc-lines', lines.map((l) => h('li', lineText(l)))) : h('div.hc-desc', '这里还没有天气数据'),
      // the still-forming day's money is a full-day projection (meta.intraday): mark it 估 (§14)
      lines.length && i === app.lastIdx && app.partialInfo?.() ? h('div.hc-estday.est-day', { title: app.meta?.intraday?.method || '盘中的成交按全天折算' },
        h('span.est-badge', '估'), h('span', app.meta?.intraday?.scaled ? `今天的钱数按全天折算（截至美东 ${app.meta.intraday.etTime || '?'}）` : app.meta?.intraday?.open === false ? '刚收盘的快照，完整更新后再核一遍' : '今天还没收盘，钱数只算到现在')) : null,
      idx ? h('div.hc-spark', sparkline(idx, { w: 236, h: 32, mark: i, to: app.lastIdx }),
        h('div.hc-spark-cap', h('span', '过去一年'), h('span', snap?.ret20 != null ? `近20天 ${app.W.pct(snap.ret20)}` : ''))) : null,
      est ? h('div.hc-est', (n.basis || series?.basis || '估算') + ' · 等你补数据') : null,
      // §23 real money (ETF 申赎 / 稳定币 / 南向…) beside the estimate, when flows/ has it
      app.realMoneyBlock ? app.realMoneyBlock(n.id, i, snap?.flow5 ?? null) : null,
      h('div.hc-hint', h('span', isStock ? '点击看这只股票' : `点击飞进去${n.nStocks ? `（${n.nStocks} 只）` : ''}`, h('span.hc-hint-r', ' · 右键更多')),
        app.whyButton ? app.whyButton(() => targetOf(n), { cls: 'hc-why', title: '让老风上网查：这里为什么是这样的天气（停一下鼠标就能点，或按 W）' }) : null),
    ].filter(Boolean));
    place();
  };

  const place = () => {
    if (!cur || !xy) return;
    const r = el.getBoundingClientRect();
    const pad = 12, vw = innerWidth, vh = innerHeight;
    let x = xy.x + 18, y = xy.y + 18;
    if (x + r.width + pad > vw) x = xy.x - r.width - 18;
    if (y + r.height + pad > vh - 70) y = xy.y - r.height - 18;
    el.style.transform = `translate(${clamp(x, pad, vw - r.width - pad)}px, ${clamp(y, 56, Math.max(56, vh - r.height - 72))}px)`;
  };

  const setLive = (on) => {
    live = on;
    el.classList.toggle('live', on);
    if (on) liveAt = xy ? { ...xy } : null;
  };
  const armRest = () => {
    clearTimeout(restTimer);
    restTimer = setTimeout(() => { if (cur && !menuEl) setLive(true); }, REST_MS);
  };
  const far = (pos) => liveAt && pos && Math.hypot(pos.x - liveAt.x, pos.y - liveAt.y) > FAR;
  // is the pointer travelling toward the settled card? (then hold it; otherwise switch at once — no lag)
  let ptr = null, prevPtr = null;
  addEventListener('pointermove', (e) => { prevPtr = ptr; ptr = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
  const towardCard = () => {
    if (!ptr || !prevPtr) return false;
    const r = el.getBoundingClientRect();
    const d = (q) => Math.hypot(Math.max(r.left - q.x, 0, q.x - r.right), Math.max(r.top - q.y, 0, q.y - r.bottom));
    const a = d(prevPtr), b = d(ptr);
    return b < 8 || b < a - 0.5;
  };

  const show = (node, pos) => {
    if (!node) return hide();
    if (menuEl) return;                  // the menu is open: keep it the only card
    if (inCard) return;                  // the pointer is in the card: it stays put
    if (live && (node !== cur || far(pos))) {
      if (towardCard()) {
        // settled and the pointer is heading into the card: give it a moment to arrive
        if (!graceTimer) graceTimer = setTimeout(() => { graceTimer = 0; if (!inCard) { setLive(false); show(node, pos); } }, GRACE_MS);
        return;
      }
      clearTimeout(graceTimer); graceTimer = 0;
      setLive(false);
    }
    if (live) return;                    // settled on the same territory: stay where it is
    xy = pos || xy;
    if (node !== cur) { cur = node; render(); el.classList.add('on'); }
    else { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); }
    armRest();
  };
  const hide = (force = false) => {
    if (!force) {
      if (inCard) return;
      if (live && towardCard()) {          // settled and the pointer is on its way in: wait a moment
        if (!graceTimer) graceTimer = setTimeout(() => { graceTimer = 0; if (!inCard) hide(true); }, GRACE_MS);
        return;
      }
    }
    clearTimeout(restTimer); clearTimeout(graceTimer); graceTimer = 0;
    setLive(false);
    inCard = false;
    cur = null; el.classList.remove('on');
  };
  el.addEventListener('pointerenter', () => { inCard = true; clearTimeout(graceTimer); graceTimer = 0; });
  // 为什么？ opens the reason card right here; the hover card steps aside (after the anchor was measured)
  el.addEventListener('click', (e) => { if (e.target.closest?.('.hc-why')) setTimeout(() => hide(true), 0); }, true);
  el.addEventListener('pointerleave', () => { inCard = false; hide(); });
  // a click inside the settled card (not on a button) does what a click on the territory does
  el.addEventListener('click', (e) => {
    if (!cur || e.target.closest('button,a')) return;
    const n = cur;
    hide(true);
    if (n.kind === 'stock' || String(n.id).startsWith('s:')) app.openStock(n.ticker || String(n.id).slice(2));
    else if (n.children?.length) app.go(app.state.path.concat(n.id));
  });

  // ---------------------------------------------------------------- context menu
  let menuEl = null, menuAt = 0, lastNode = null;
  function closeMenu() {
    if (!menuEl) return false;
    menuEl.remove(); menuEl = null;
    return true;
  }
  function menu(node, pos) {
    closeMenu();
    hide();
    if (!node) return;
    lastNode = node;
    menuAt = performance.now();
    const isStock = node.kind === 'stock' || String(node.id).startsWith('s:');
    const ticker = node.ticker || (isStock ? String(node.id).slice(2) : null);
    const pinned = app.isPinned(node.id);
    const item = (ic, label, fn, sub) => h('button.menu-item', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); fn(); } },
      icon(ic, { size: 16 }), h('span', label), sub ? h('span.menu-sub', sub) : null);
    const whyItem = app.why ? h('button.menu-item', { type: 'button', role: 'menuitem', dataset: { why: '1' }, onclick: (e) => { const r = menuEl?.getBoundingClientRect(); closeMenu(); app.why(targetOf(node), null, { rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.top + 30 } : null }); e.stopPropagation(); } },
      icon('help', { size: 16 }), h('span', '为什么？'), h('span.menu-sub', '上网查原因')) : null;
    menuEl = h('div.ctxmenu', { role: 'menu', 'aria-label': node.name },
      h('div.menu-head', h('span', node.name), ticker ? h('span.hc-ticker', ticker) : null),
      whyItem,
      isStock ? item('arrow-right', '看这只股票', () => app.openStock(ticker))
        : (node.children?.length ? item('arrow-right', '飞进去', () => app.go(app.state.path.concat(node.id))) : null),
      isStock ? item('web', '关系网', () => app.openWeb(ticker), '它跟谁做生意') : null,
      item('scout', '让 Claude 去查', () => app.ask('ask', node.id, `${node.name}${ticker ? `（${ticker}）` : ''}最近为什么是这样的天气？`), '侦察兵'),
      item(pinned ? 'star-fill' : 'star', pinned ? '取消关注' : '关注', () => app.togglePin(node.id)));
    document.body.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    const x = clamp(pos.x + 4, 8, innerWidth - r.width - 8), y = clamp(pos.y + 4, 8, innerHeight - r.height - 8);
    menuEl.style.transform = `translate(${x}px, ${y}px)`;
    requestAnimationFrame(() => menuEl?.classList.add('on'));
    menuEl.querySelector('.menu-item')?.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  addEventListener('blur', closeMenu);

  app.on('date', () => { if (cur) render(); });
  app.on('nav', () => { hide(true); closeMenu(); });
  app.on('voice', () => { if (cur) render(); });
  /** W key: 为什么 for whatever is under the pointer (the card's own button as the anchor when visible). */
  const why = () => {
    if (!cur || !app.why) return false;
    const btn = el.querySelector('.hc-why');
    const r = el.classList.contains('on') ? el.getBoundingClientRect() : null;
    const n = cur;
    hide(true);
    app.why(targetOf(n), null, { rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.top + 40 } : (xy ? { left: xy.x, top: xy.y, right: xy.x, bottom: xy.y } : null) });
    return !!btn || true;
  };

  return {
    show, hide: () => hide(true), leave: () => hide(false), menu, closeMenu, why,
    current: () => cur,
    lastMenuNode: () => lastNode,
    menuOpenedWithin: (ms) => !!menuEl && performance.now() - menuAt < ms,
  };
}
