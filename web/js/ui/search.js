// search.js — fuzzy search over search.json: Chinese substring, ticker, path, note. Enter flies there.
import { h, clear } from './dom.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[\s·›>_\-]+/g, '');

function subseq(hay, q) {
  let j = 0;
  for (let k = 0; k < hay.length && j < q.length; k++) if (hay[k] === q[j]) j++;
  return j === q.length;
}

function tokenScore(e, q) {
  let s = 0;
  if (e._t) {
    if (e._t === q) s = 100;
    else if (e._t.startsWith(q)) s = 84 - Math.min(10, e._t.length - q.length);
  }
  if (e._n === q) s = Math.max(s, 96);
  else if (e._n.startsWith(q)) s = Math.max(s, 78);
  else if (e._n.includes(q)) s = Math.max(s, 64);
  if (s) return s;
  if (e._note && e._note.includes(q)) return 40;
  if (e._p.includes(q)) return 34;
  if (q.length >= 2 && subseq(e._n, q)) return 24;
  if (q.length >= 2 && e._t && subseq(e._t, q)) return 18;
  return 0;
}

export function prepareIndex(entries, nodeById, { scope = null, scopeLabel = '' } = {}) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    if (!e || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    const node = nodeById(e.id);
    const names = (e.path || []).slice();
    if (names[0] === '地球') names.shift();
    if (names.length && names[names.length - 1] === e.name) names.pop();
    out.push({
      ...e,
      emoji: node?.emoji || (e.ticker ? '' : '•'),
      isStock: e.id.startsWith('s:') || !!e.ticker || e.kind === 'stock',
      _t: e.ticker ? e.ticker.toLowerCase() : '',
      _n: norm(e.name),
      _p: norm((e.path || []).join('')),
      _note: norm(e.note || node?.note || ''),
      depth: (e.pathIds || e.path || []).length,
      where: e.id === 'world' ? '整个世界' : names.join(' › ') || '大陆',
      scope, scopeLabel,
    });
  }
  return out;
}

export function searchIndex(index, query, limit = 8) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
  if (!tokens.length) return [];
  const whole = norm(query);
  const res = [];
  for (const e of index) {
    let total = 0, ok = true;
    for (const t of tokens) { const s = tokenScore(e, t); if (!s) { ok = false; break; } total += s; }
    if (!ok && tokens.length > 1) { const s = tokenScore(e, whole); if (s) { ok = true; total = s * tokens.length; } }
    if (!ok) continue;
    total += e.isStock ? 0 : 3;             // regions first on ties
    total -= Math.min(4, e.depth) * 0.2;    // shallower first
    if (e.scope) total -= 2;                 // the map you are on first; 全市场 extras after
    res.push([total, e]);
  }
  res.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
  return res.slice(0, limit).map((r) => r[1]);
}

/** Wires an <input> + results list. onPick(entry) is called on Enter / click. */
export function mountSearch(input, list, { getIndex, onPick }) {
  let results = [], sel = 0;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    clear(list);
    if (!input.value.trim()) { close(); return; }
    if (!results.length) {
      list.append(h('li.sr-empty', '没找到。试试中文名、代码（如 NVDA）或板块名'));
    }
    results.forEach((e, k) => {
      list.append(h('li.sr-item' + (k === sel ? '.sel' : ''), {
        role: 'option', 'aria-selected': k === sel ? 'true' : 'false',
        onmousedown: (ev) => { ev.preventDefault(); pick(e); },
        onmousemove: () => { if (sel !== k) { sel = k; render(); } },
      },
      h('span.sr-emoji', e.emoji || (e.isStock ? '◦' : '•')),
      h('span.sr-name', e.name),
      e.ticker ? h('span.sr-ticker', e.ticker) : null,
      e.scopeLabel ? h('span.sr-scope', { title: e.scope === 'gl' ? '在全球地图上：打开它自己的天气（价格按美元算）' : e.scope === 'curated' ? '在精选（美股）地图上：打开它自己的天气' : '不在精选地图上：打开它在全市场里的天气' }, e.scopeLabel) : null,
      h('span.sr-path', e.where)));
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const pick = (e) => { if (!e) return; input.value = ''; results = []; close(); input.blur(); onPick(e); };
  input.addEventListener('input', () => { results = searchIndex(getIndex(), input.value); sel = 0; render(); });
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(results[sel] || results[0]); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); input.value = ''; results = []; close(); input.blur(); }
    ev.stopPropagation();
  });
  return { close };
}
