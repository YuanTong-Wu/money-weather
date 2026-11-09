// pins.js — 我的雷达 (§6.8): pinned territories/stocks (localStorage) shown as a small strip; pushes ids to
// Planet.setPins. A pin with a front / storm today gets a quiet mark (and joins the spotlight candidates).
// Holdings (§20) stay pinned but are shown in their own 我的持仓 strip (holdings.js), not twice.
import { h, clear, store, icon } from './dom.js';

const KEY = 'mw.pins';

export function loadPins() {
  const v = store.get(KEY, []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
export function savePins(ids) { store.set(KEY, ids); }

export function initPins(app) {
  const el = document.getElementById('pins');

  const render = () => {
    clear(el);
    const ids = app.state.pins.filter((id) => app.D.nodeById(id) && !(app.isHolding?.(id) && document.getElementById('holdings')));
    if (!ids.length) { el.hidden = true; return; }
    el.hidden = false;
    el.append(h('span.pins-label', { title: '你关注的地方。起风暴或风向突变时会被点亮。' }, icon('radar', { size: 14 }), h('span', '我的雷达')));
    for (const id of ids) {
      const n = app.D.nodeById(id);
      const now = n.now || {};
      const alert = now.front ? 'front' : now.storm >= 0.8 ? 'rain' : null;
      const w = now.wind;
      const dir = w > 0.5 ? 'in' : w < -0.5 ? 'out' : '';
      el.append(h('span.pin-chip' + (alert ? '.alert' : ''),
        h('button.pin-go', { type: 'button', title: `${n.name}：${app.W.windWord(w).text}${alert ? '（今天有动静）' : ''}`, onclick: () => app.goId(id) },
          h('span.pin-name', n.kind === 'stock' ? n.ticker || n.name : n.name),
          dir ? icon(dir === 'in' ? 'arrow-up' : 'arrow-down', { size: 12, cls: 'pin-arrow ' + dir }) : null,
          alert ? icon(alert, { size: 13, cls: 'pin-alert' }) : null),
        h('button.pin-x', { type: 'button', title: '取消关注', 'aria-label': '取消关注', onclick: () => app.togglePin(id) }, icon('close', { size: 12 }))));
    }
  };
  app.on('pins', render);
  app.on('data', render);
  render();
  return { render };
}
