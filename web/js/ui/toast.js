// toast.js — one quiet message at a time, bottom-centre above the time machine.
// toast(text, ms?, {action:{label, fn}}?) — an optional action button (e.g. 为什么 answered → 看看).
import { h } from './dom.js';

let timer = 0;
export function toast(msg, ms = 3200, { action = null } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  const act = action && typeof action.fn === 'function'
    ? h('button.toast-act', { type: 'button', onclick: () => { hide(el); try { action.fn(); } catch (e) { console.error(e); } } }, action.label || '看看')
    : null;
  el.replaceChildren(...[h('span', msg), act].filter(Boolean));
  el.classList.toggle('has-act', !!act);
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(timer);
  timer = setTimeout(() => hide(el), ms);
}
function hide(el) {
  clearTimeout(timer);
  el.classList.remove('on');
  setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 260);
}
