// gauges.js — atmosphere gauges (top-left, quiet): 恐慌指数 / 10年美债利率 / 美元指数, each with one word
// and a tiny 60-day line. Drawn on the paper sky without cards, so they never compete with the planet.
import { h, clear, sparkline, icon } from './dom.js';

const ICON = { vix: 'pulse', tnx: 'percent', dxy: 'dollar' };
const SHORT = { vix: '恐慌', tnx: '美债10年', dxy: '美元' };

// One threshold table for every day: the same cut-points as pipeline/compute.py atmosphere_say (today's `say`
// comes from there), so a past day with the same value never gets a different word.
function sayFor(a, i) {
  const s = a.series || [];
  const v = s[i], v5 = s[Math.max(0, i - 5)];
  if (v == null) return { word: '没数据', mood: 'calm' };
  const d = v5 != null ? v - v5 : 0;
  if (a.key === 'vix') {
    let w, mood;
    if (v < 13) { w = '非常放松'; mood = 'calm'; }
    else if (v < 17) { w = '市场很平静'; mood = 'calm'; }
    else if (v < 21) { w = '有点紧张'; mood = 'tense'; }
    else if (v < 26) { w = '大家紧张了'; mood = 'tense'; }
    else if (v < 32) { w = '很紧张'; mood = 'alarm'; }
    else { w = '恐慌！'; mood = 'alarm'; }
    if (d >= 3) w += '，在升温'; else if (d <= -3) w += '，在降温';
    return { word: w, mood };
  }
  if (a.key === 'tnx') {
    if (d >= 0.12) return { word: '快速上升，股票逆风', mood: 'tense' };
    if (d >= 0.05) return { word: '在慢慢上升', mood: 'tense' };
    if (d <= -0.12) return { word: '快速下降，股票顺风', mood: 'calm' };
    if (d <= -0.05) return { word: '在慢慢下降', mood: 'calm' };
    return { word: '很稳', mood: 'calm' };
  }
  if (a.key === 'dxy') {
    const pc = v5 ? d / v5 : 0;
    if (pc >= 0.01) return { word: '明显走强', mood: 'tense' };
    if (pc >= 0.004) return { word: '在慢慢走强', mood: 'tense' };
    if (pc <= -0.01) return { word: '明显走弱', mood: 'calm' };
    if (pc <= -0.004) return { word: '在慢慢走弱', mood: 'calm' };
    return { word: '很稳', mood: 'calm' };
  }
  return { word: d > 0 ? '在升' : d < 0 ? '在降' : '稳', mood: 'calm' };
}

/** Days in a row (ending at i) the value sat still at its displayed precision: 「这三天钉在 4.99%」. */
function flatRun(a, i) {
  const s = a.series || [];
  const r = (x) => (x == null ? null : a.key === 'tnx' ? Math.round(x * 100) : Math.round(x * 10));
  const v = r(s[i]);
  if (v == null) return 0;
  let n = 1;
  for (let j = i - 1; j >= 0 && r(s[j]) === v; j--) n++;
  return n;
}
const CN_N = ['', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

const fmt = (a, v) => (v == null ? '—' : a.key === 'tnx' ? v.toFixed(2) + '%' : v.toFixed(1));

export function initGauges(app) {
  const root = document.getElementById('gauges');
  const render = () => {
    clear(root);
    const atm = app.meta.atmosphere || [];
    const i = app.state.dateIndex, latest = i === app.lastIdx;
    for (const a of atm) {
      const s = a.series || [];
      const j = Math.min(i, s.length - 1);
      const v = latest && a.last != null ? a.last : s[j];
      const auto = sayFor(a, j);
      // a value nailed in place for ≥ 3 days is the story, whatever the 5-day change says
      const run = flatRun(a, j);
      const flat = run >= 3 ? `这${CN_N[Math.min(run, 10)] || run}天钉在 ${fmt(a, s[j])}` : '';
      const word = flat ? (a.key === 'vix' ? auto.word : '钉住不动') : latest && a.say ? a.say : auto.word;
      const d5 = s[j] != null && s[j - 5] != null ? s[j] - s[j - 5] : null;
      root.append(h('div.gauge.mood-' + auto.mood, {
        title: `${a.name} ${fmt(a, v)}：${flat ? (a.key === 'vix' ? word + '，' + flat : flat) : word}${d5 != null ? `（5天${d5 >= 0 ? '升' : '降'}了 ${Math.abs(d5).toFixed(a.key === 'tnx' ? 2 : 1)}）` : ''}`,
      },
      icon(ICON[a.key] || 'pulse', { size: 14, cls: 'g-icon' }),
      h('span.g-name', SHORT[a.key] || a.name),
      h('span.g-val', fmt(a, v)),
      h('span.g-word', word),
      sparkline(s, { w: 44, h: 14, from: Math.max(0, j - 59), to: j, mark: j, cls: 'spark g-spark' })));
    }
  };
  app.on('date', render);
  app.on('data', render);
  render();
}
