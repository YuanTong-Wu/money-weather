// since.js — "自你上次来（10月21日）以来：…" one quiet line with the 2–3 biggest wind flips.
// Remembers the last-seen data date in localStorage; uses words.changesSince when present.
import { h, clear, cnDate, store, richText, icon } from './dom.js';

const KEY = 'mw.lastSeen';

// local fallback with the same output shape as words.changesSince → [{id, name, from, to, say, score}]
function localChanges(map, kids, a, b, k) {
  const rows = [];
  for (const c of kids) {
    const s = map?.children?.[c.id];
    if (!s?.wind) continue;
    const w0 = s.wind[a], w1 = s.wind[b];
    if (w0 == null || w1 == null) continue;
    const flip = (w0 <= -0.5 && w1 >= 0.5) || (w0 >= 0.5 && w1 <= -0.5);
    const score = Math.abs(w1 - w0) + (flip ? 1 : 0);
    if (score < 0.8) continue;
    const nm = `【${c.name}】`;
    const say = w0 <= -0.5 && w1 >= 0.5 ? `${nm}掉头进钱` : w0 >= 0.5 && w1 <= -0.5 ? `${nm}开始撤钱`
      : w1 > w0 ? (w1 >= 0.5 ? `${nm}进钱更猛了` : `${nm}不再流出`) : (w1 <= -0.5 ? `${nm}流出更猛了` : `${nm}不再进钱`);
    rows.push({ id: c.id, name: c.name, from: w0, to: w1, say, score });
  }
  return rows.sort((x, y) => y.score - x.score).slice(0, k);
}

export async function initSince(app, { onChange } = {}) {
  const el = document.getElementById('since');
  const dates = app.meta.dates || [];
  const L = dates.length - 1;
  const asOf = app.meta.asOf || dates[L];
  const last = store.get(KEY);
  store.set(KEY, asOf);
  if (!last || !asOf || last >= asOf || L < 1) return;

  let j = -1;
  for (let k = L; k >= 0; k--) if (dates[k] <= last) { j = k; break; }
  if (j < 0) j = 0;
  if (j >= L) return;

  // continents (world's children) + the US themes: the level where a flip is worth one sentence
  const ids = [app.rootId()].concat(app.D.nodeById('us')?.children?.length ? ['us'] : []);
  const rows = [];
  for (const id of ids) {
    const node = app.D.nodeById(id);
    let map = null;
    try { map = await app.D.loadMap(id); } catch (e) { map = null; }
    if (!map || !node) continue;
    const kids = (node.children || []).filter((c) => c.kind !== 'stock');
    let got;
    try { got = typeof app.W.changesSince === 'function' ? app.W.changesSince(map, kids, j, L, 3) : null; } catch (e) { got = null; }
    rows.push(...(got || localChanges(map, kids, j, L, 3)));
  }
  const seen = new Set();
  const top = rows.filter((r) => r.id !== 'us' && !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3);
  if (!top.length) return;

  clear(el).append(
    icon('since', { size: 15, cls: 'since-icon' }),
    h('span.since-lead', `自你上次来（${cnDate(dates[j])}）以来：`),
    ...top.map((x, k) => h('button.since-item' + ((x.to ?? 0) > (x.from ?? 0) ? '.in' : '.out'), {
      type: 'button', title: '飞过去看看', onclick: () => app.goId(x.id),
    }, k ? h('span.since-sep', '·') : null, richText(x.say || x.name))),
    h('button.since-close', {
      type: 'button', title: '知道了', 'aria-label': '关闭',
      onclick: () => { el.classList.remove('on'); setTimeout(() => { el.hidden = true; onChange?.(); }, 260); },
    }, icon('close', { size: 13 })));
  el.hidden = false;
  // never cut a sentence in half: drop the least important item while the line does not fit
  const fit = () => {
    const items = el.querySelectorAll('.since-item');
    if (items.length > 1 && el.scrollWidth > el.clientWidth + 1) { items[items.length - 1].remove(); fit(); }
  };
  fit();
  requestAnimationFrame(() => { el.classList.add('on'); onChange?.(); });
}
