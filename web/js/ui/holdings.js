// holdings.js — 我的持仓 (DESIGN.md §20): the owner's money comes first. A small strip on the first screen
// (bottom-left dock, above the radar) with each holding's weather on the day the time machine shows:
// season glyph, one sharp line (§12, words.take — it already says "成交热闹，可钱没进来" when the wind and the
// 5-day money disagree, phase-3 must-fix #3), the measured facts as quiet numbers, and a 为什么？ (§21).
// Click → the stock view. Data: data/holdings.json (main.js loadHoldings → app.holdings) + stocks/<T>.json.
import { h, clear, icon, cnDate } from './dom.js';

const SEASON_NAME = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const isNum = (x) => typeof x === 'number' && isFinite(x);

export function initHoldings(app) {
  const el = document.getElementById('holdings');
  if (!el) return { render() {} };
  const D = app.data || app.D;
  const W = () => app.W || app.words || {};
  const series = new Map();          // ticker → stock json (or null when it cannot be read)
  let token = 0;

  async function stockOf(t) {
    if (series.has(t)) return series.get(t);
    let j = null;
    try { j = await D.loadStock(t); } catch (e) { j = null; }
    series.set(t, j);
    return j;
  }

  /** Index into a stock file for the app's day i (matched by date: the 全市场 / 全球 calendars may differ). */
  function idxIn(j, i) {
    const len = (j?.wind || []).length;
    const d = app.meta?.dates?.[i];
    const k = d && Array.isArray(j?.dates) ? j.dates.lastIndexOf(d) : -1;
    if (k >= 0) return k;
    return i >= app.lastIdx ? len - 1 : Math.min(i, len - 1);
  }

  /** nowLike for day i: from the stock file (has dw / flow5 → seasons + contradictions), else tree `now`. */
  function nowFor(hd, j, i) {
    const w = W();
    if (j && typeof w.nowAt === 'function') {
      const n = idxIn(j, i);
      try { const x = w.nowAt(j, n); if (x) return x; } catch (e) { /* fall back */ }
    }
    return D.nodeById(hd.id)?.now || null;
  }

  function seasonOf(j, i, now) {
    const w = W();
    try {
      if (j && typeof w.seasonAt === 'function') { const s = w.seasonAt(j, idxIn(j, i)); if (s?.key) return s; }
      if (now && typeof w.season === 'function') { const s = w.season(now.wind, now.dw, now.pres, now.flow5); if (s?.key) return s; }
    } catch (e) { /* none */ }
    return null;
  }

  function sentence(now) {
    const w = W();
    try { if (typeof w.take === 'function') return w.take(now); } catch (e) { /* */ }
    try { return (w.describe?.(now) || [])[0] || ''; } catch (e) { return ''; }
  }

  function facts(now, j, i) {
    const w = W();
    const out = [];
    const money = (x) => (typeof w.money === 'function' ? w.money(Math.abs(x)) : Math.abs(x).toFixed(1) + '百万美元');
    // the day's own move first: a holding up 12% today must not read like a quiet day (brief.holdingsLine.facts)
    if (j && Array.isArray(j.c)) {
      const n = idxIn(j, i);
      const c1 = j.c[n], c0 = j.c[n - 1];
      if (isNum(c1) && isNum(c0) && c0 > 0) {
        const r = c1 / c0 - 1;
        const live = i === app.lastIdx && app.meta?.intraday && app.meta.intraday.open !== false && app.meta?.partial?.date === app.meta?.dates?.[i];
        out.push(`${live ? '今天盘中' : i === app.lastIdx ? '今天' : '当天'} ${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`);
      }
    }
    if (isNum(now.flow5)) out.push(Math.abs(now.flow5) < 0.05 ? '5天进出打平' : `5天净${now.flow5 > 0 ? '流入' : '流出'} ${money(now.flow5)}（估）`);
    if (isNum(now.pres)) out.push(`拥挤 ${Math.round(now.pres)}`);
    if (isNum(now.ret20)) out.push(`20天 ${now.ret20 >= 0 ? '+' : '−'}${Math.abs(now.ret20 * 100).toFixed(1)}%`);
    return out;
  }

  function row(hd, j, i) {
    const now = nowFor(hd, j, i) || {};
    const node = D.nodeById(hd.id);
    const name = node?.name && node.name !== hd.t ? node.name : hd.name;
    const s = seasonOf(j, i, now);
    const wv = now.wind;
    const dir = isNum(wv) && wv >= 0.5 ? 'in' : isNum(wv) && wv <= -0.5 ? 'out' : '';
    const loud = !!(now.front || (now.storm >= 0.8) || Math.abs(wv || 0) >= 1.5);
    const alert = now.front ? (now.front > 0 ? '风向刚变：钱开始流入' : '风向刚变：钱开始撤离')
      : now.storm >= 0.8 ? (now.storm >= 1.5 ? '大风暴' : '有风暴') : Math.abs(wv || 0) >= 1.5 ? (wv > 0 ? '钱在狂涌' : '钱在大逃离') : '';
    const say = sentence(now);
    const go = () => app.openStock(hd.t);
    return h('div.hold' + (dir ? '.' + dir : '') + (loud ? '.loud' : ''), {
      role: 'button', tabindex: 0, title: `看 ${name}（${hd.t}）的天气`,
      onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); },
    },
    h('div.hold-top',
      h('span.hold-t', hd.t),
      h('span.hold-name', name),
      s?.key ? h('span.season-tag.' + s.key, { title: `${s.name}天：${[s.now, s.next].filter(Boolean).join(' → ')}` }, icon(s.key, { size: 12 }), h('span', s.name || SEASON_NAME[s.key])) : null,
      dir ? icon(dir === 'in' ? 'arrow-up' : 'arrow-down', { size: 13, cls: 'hold-arrow ' + dir, title: dir === 'in' ? '风：钱在流进来' : '风：钱在流出去' }) : null,
      alert ? h('span.hold-alert', icon(now.front ? 'front' : now.storm >= 0.8 ? 'storm' : 'wind', { size: 12 }), alert) : null,
      app.whyButton ? app.whyButton(() => ({ kind: 'stock', ids: [hd.id], dateIndex: app.state.dateIndex }), { cls: 'hold-why', title: `为什么 ${hd.t} 是这样的天气？让老风上网查（带日期和出处）` }) : null),
    say ? h('div.hold-say', say.replace(/。$/, '')) : null,
    h('div.hold-foot', h('span.hold-facts', facts(now, j, i).join(' · '))));
  }

  async function render() {
    const my = ++token;
    const list = app.holdings || [];
    if (!list.length) { el.hidden = true; clear(el); return; }
    const i = app.state.dateIndex;
    const js = await Promise.all(list.map((hd) => stockOf(hd.t)));
    if (my !== token) return;
    const past = i !== app.lastIdx;
    clear(el).append(
      h('div.hold-k', icon('star-fill', { size: 12 }), h('span', '我的持仓'),
        past ? h('span.hold-when', cnDate(app.meta.dates[i])) : null),
      ...list.map((hd, k) => row(hd, js[k], i)));
    el.hidden = false;
    app.emit('layout-dock');
  }

  let settle = 0;
  app.on('date', () => { clearTimeout(settle); settle = setTimeout(render, app.playing ? 400 : 60); });
  app.on('data', () => { series.clear(); render(); });
  app.on('dataReloaded', () => { series.clear(); render(); });
  app.on('voice', render);
  app.on('pins', render);
  render();
  return { render };
}
