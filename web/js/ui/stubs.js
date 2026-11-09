// stubs.js — small stand-ins for planet.js / stock.js / words.js, used ONLY when a real module is missing
// or incomplete (other agents build those in parallel). ui/modules.js imports this file on demand.
/* global d3 */

// =================================================================== words (DESIGN.md §5, §6)
const lv = (x, cuts) => { let l = -2; for (const c of cuts) if (x >= c) l++; return l; };
export function windWord(w) {
  if (w == null) return { text: '没有数据', emoji: '·', level: 0 };
  const l = w > 1.5 ? 2 : w > 0.5 ? 1 : w >= -0.5 ? 0 : w >= -1.5 ? -1 : -2;
  return { level: l, ...[{ text: '钱在大逃离', emoji: '🏃' }, { text: '钱在悄悄溜走', emoji: '↘️' }, { text: '风平浪静', emoji: '〰️' },
    { text: '钱在流进来', emoji: '↗️' }, { text: '钱在狂涌进来', emoji: '🌊' }][l + 2] };
}
export function tempWord(t) {
  if (t == null) return { text: '没有数据', emoji: '·', level: 0 };
  const l = t > 1.5 ? 2 : t > 0.5 ? 1 : t >= -0.5 ? 0 : t >= -1.5 ? -1 : -2;
  return { level: l, ...[{ text: '很冷', emoji: '🧊' }, { text: '凉', emoji: '🌥️' }, { text: '常温', emoji: '🌤️' },
    { text: '暖', emoji: '☀️' }, { text: '很热', emoji: '🔥' }][l + 2] };
}
export function presWord(p) {
  if (p == null) return { text: '没有数据', emoji: '·', level: 0 };
  const l = lv(p, [15, 35, 65, 85]);
  return { level: l, ...[{ text: '冷清洼地', emoji: '🏜️' }, { text: '人少', emoji: '🙂' }, { text: '正常', emoji: '👥' },
    { text: '人多', emoji: '👥' }, { text: '人挤人', emoji: '🧑‍🤝‍🧑' }][l + 2] };
}
export function stormWord(s) {
  if (s >= 1.5) return { text: '大风暴（波动突然变得很大）', emoji: '⛈️', level: 2 };
  if (s >= 0.8) return { text: '有风暴', emoji: '🌧️', level: 1 };
  return { text: '', emoji: '', level: 0 };
}
export function frontWord(f) {
  if (f > 0) return { text: '风向刚变：钱开始流入', emoji: '🌀', level: 1 };
  if (f < 0) return { text: '风向刚变：钱开始撤离', emoji: '🌀', level: -1 };
  return { text: '', emoji: '', level: 0 };
}
export function money(m) {
  if (m == null || !isFinite(m)) return '—';
  const usd = m * 1e6, a = Math.abs(usd), s = usd < 0 ? '-' : '';
  if (a >= 1e8) return s + (a / 1e8).toFixed(1) + '亿美元';
  return s + Math.max(0, a / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '万美元';
}
export function pct(x) {
  if (x == null || !isFinite(x)) return '—';
  return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
}
export function describe(n) {
  if (!n) return [];
  const out = [];
  const w = windWord(n.wind), t = tempWord(n.temp), p = presWord(n.pres);
  out.push(`${w.emoji} ${w.text}` + (n.flow5 != null ? `：5天净${n.flow5 >= 0 ? '流入' : '流出'} ${money(Math.abs(n.flow5))}` : ''));
  out.push(`${t.emoji} ${t.text}` + (n.ret20 != null ? `：20天 ${pct(n.ret20)}` : ''));
  out.push(`👥 ${p.text}（拥挤度 ${n.pres ?? '—'}）`);
  if (n.front) out.push(`🌀 ${frontWord(n.front).text}`);
  else if (n.storm >= 0.8) out.push(`${stormWord(n.storm).emoji} ${stormWord(n.storm).text}`);
  return out.slice(0, 4);
}
export function surprise(s, i) {
  if (!s || !s.wind) return 0;
  const g = (k, j) => (s[k] && s[k][j] != null ? s[k][j] : 0);
  const j = Math.max(0, i - 5);
  const p = g('pres', i);
  return 0.45 * Math.abs(g('wind', i) - g('wind', j)) + 0.25 * Math.abs(g('wind', i)) + 0.15 * Math.abs(g('temp', i) - g('temp', j)) +
    0.6 * Math.abs(g('front', i)) + 0.3 * (g('storm', i) >= 0.8 ? 1 : 0) + 0.2 * (p >= 90 || p <= 10 ? 1 : 0);
}
function why(s, i, name) {
  const w = s.wind[i], w5 = s.wind[Math.max(0, i - 5)];
  if (s.front && s.front[i]) return `${name}${frontWord(s.front[i]).text}`;
  if (s.storm && s.storm[i] >= 0.8) return `${name}下起了雨：波动突然变大`;
  if (s.pres && s.pres[i] >= 90) return `${name}人挤人（拥挤度 ${s.pres[i]}）`;
  if (w - w5 > 1) return `${name}的钱一下子多了起来`;
  if (w - w5 < -1) return `${name}的钱突然往外跑`;
  return `${name}：${windWord(w).text}`;
}
export function attentionPicks(map, childNodes, i, k = 3) {
  if (!map || !map.children) return [];
  const byId = new Map((childNodes || []).map((c) => [c.id, c]));
  return Object.entries(map.children).map(([id, s]) => ({ id, score: +surprise(s, i).toFixed(2), why: why(s, i, byId.get(id)?.name || id) }))
    .sort((a, b) => b.score - a.score).slice(0, k);
}
export function regionWeather(map, node, childNodes, i) {
  const items = (childNodes || []).map((c) => {
    const s = map?.children?.[c.id];
    if (!s) return null;
    return { id: c.id, name: c.name, emoji: c.emoji || '', wind: s.wind[i], pres: s.pres[i], storm: s.storm[i], front: s.front[i],
      flow5: s.flow.slice(Math.max(0, i - 4), i + 1).reduce((a, b) => a + (b || 0), 0) };
  }).filter(Boolean);
  const inflow = items.filter((x) => x.wind > 0.5).sort((a, b) => b.wind - a.wind).map((x) => ({ ...x, say: windWord(x.wind).text }));
  const outflow = items.filter((x) => x.wind < -0.5).sort((a, b) => a.wind - b.wind).map((x) => ({ ...x, say: windWord(x.wind).text }));
  const crowded = items.filter((x) => x.pres >= 80).sort((a, b) => b.pres - a.pres).map((x) => ({ ...x, say: `${presWord(x.pres).text}（${x.pres}）` }));
  const storms = items.filter((x) => x.storm >= 0.8).sort((a, b) => b.storm - a.storm).map((x) => ({ ...x, say: stormWord(x.storm).text }));
  const fronts = items.filter((x) => x.front).map((x) => ({ ...x, say: frontWord(x.front).text }));
  let headline = `${node?.name || ''}这里${windWord(map?.self?.wind?.[i]).text}。`;
  if (inflow[0] && outflow[0]) headline = `钱正从【${outflow[0].name}】流向【${inflow[0].name}】。`;
  else if (inflow[0]) headline = `【${inflow[0].name}】最吸钱。`;
  else if (outflow[0]) headline = `钱在离开【${outflow[0].name}】。`;
  return { headline, inflow, outflow, crowded, storms, fronts };
}
export function caster(sj, i) {
  if (!sj) return [];
  const f5 = sj.flow.slice(Math.max(0, i - 4), i + 1).reduce((a, b) => a + b, 0);
  const r5 = sj.c[i] / sj.c[Math.max(0, i - 5)] - 1;
  return [`过去5天大约有 ${money(Math.abs(f5))} 净${f5 >= 0 ? '流入' : '流出'}；价格${r5 >= 0 ? '涨' : '跌'}了 ${Math.abs(r5 * 100).toFixed(1)}%。`,
    `${presWord(sj.pres[i]).text}（拥挤度 ${sj.pres[i]}）。`];
}
export const tutorialCards = [
  { emoji: '🌡️', title: '颜色 = 温度', body: '越红越热：涨得比平时快、比邻居快。越蓝越冷。（跟它自己过去一年比）', demo: 'temp' },
  { emoji: '💨', title: '粒子 = 钱在流动', body: '小亮点从钱流出的地方飘向钱流入的地方。越快，钱动得越猛。', demo: 'wind' },
  { emoji: '👥', title: '挤 / 空 = 拥挤度', body: '“挤”是人挤人，小心踩踏；“空”是没人关注的洼地。', demo: 'pres' },
  { emoji: '⛈️', title: '下雨 = 风暴', body: '波动突然变得比平时大很多，就会下雨打雷。波纹表示风向刚变。', demo: 'storm' },
  { emoji: '👆', title: '点一下 = 飞进去', body: '每块陆地都能飞进去，一直飞到单只股票。按 Esc 或往外滚飞出来。', demo: 'click' },
  { emoji: '⏳', title: '时间机器', body: '拖动底部的时间条，看过去一年天气怎么变。按空格播放。', demo: 'time' },
];
export const TERMS = {
  wind: '风：钱的流向。往里吹 = 钱在流进来（跟它自己过去一年比）',
  temp: '温度：最近涨得比平时、比邻居快就热（跟它自己过去一年比）',
  pres: '拥挤度 0–100：越高越挤（跟它自己过去一年比）',
  storm: '风暴：波动突然变得比平时大很多',
  front: '风向刚变：钱的方向刚刚掉头',
};

// =================================================================== Planet stub
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rand(seed) { let s = seed || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296; }
const tempColor = (t) => {
  if (t == null) return '#1b2333';
  const x = Math.max(-3, Math.min(3, t)) / 3;
  return x >= 0 ? d3.interpolateRgbBasis(['#1e2738', '#a0522d', '#e8542f', '#ffd9b0'])(x) : d3.interpolateRgbBasis(['#1e2738', '#1d5b74', '#123a8a'])(-x);
};

export class Planet {
  constructor(canvas, cb = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.cb = cb;
    this.node = null; this.map = null; this.i = 0; this.lens = null; this.spot = []; this.pins = new Set();
    this.cells = []; this.zoom = null; this.alpha = 1; this.hover = null; this.running = true;
    this.resize();
    canvas.addEventListener('mousemove', (e) => this._move(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; cb.onHover?.(null, null); });
    canvas.addEventListener('click', (e) => { const c = this._hit(e); if (c) cb.onClick?.(c.node); });
    canvas.addEventListener('wheel', (e) => { if (e.deltaY < -30) { e.preventDefault(); this._wheelT = this._wheelT || 0; if (Date.now() - this._wheelT > 900) { this._wheelT = Date.now(); cb.onBack?.(); } } }, { passive: false });
    const loop = () => { if (this.running) this._draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.canvas.width = this.w * d; this.canvas.height = this.h * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.cx = this.w / 2; this.cy = this.h / 2; this.R = Math.min(this.w, this.h) * 0.4;
    if (this.node) this._layout();
  }
  _layout() {
    const kids = this.node.children || [];
    const rnd = rand(hash(this.node.id));
    let pts = kids.map(() => { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * this.R * 0.8; return [this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r]; });
    const box = [this.cx - this.R, this.cy - this.R, this.cx + this.R, this.cy + this.R];
    for (let k = 0; k < 6 && pts.length > 2; k++) {
      const v = d3.Delaunay.from(pts).voronoi(box);
      pts = pts.map((p, j) => { const poly = v.cellPolygon(j); return poly ? d3.polygonCentroid(poly) : p; });
    }
    const v = pts.length > 1 ? d3.Delaunay.from(pts).voronoi(box) : null;
    this.delaunay = pts.length > 1 ? d3.Delaunay.from(pts) : null;
    this.cells = kids.map((n, j) => ({ node: n, p: pts[j], poly: v ? v.cellPolygon(j) : [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] }));
  }
  async setNode(node, map, opt = {}) {
    const dir = opt.direction || 'none';
    if (this.node && dir !== 'none') {
      const c = this.cells.find((x) => x.node.id === opt.focusChildId);
      const target = c ? c.p : [this.cx, this.cy];
      await this._anim(450, (k) => { this.zoom = { p: target, s: dir === 'in' ? 1 + k * 3 : 1 - k * 0.5 }; this.alpha = 1 - k; });
    }
    this.node = node; this.map = map; this.hover = null; this._layout();
    await this._anim(300, (k) => { this.zoom = null; this.alpha = k; });
    this.alpha = 1;
  }
  _anim(ms, f) { return new Promise((res) => { const t0 = performance.now(); const tick = (t) => { const k = Math.min(1, (t - t0) / ms); f(k); if (k < 1) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); }); }
  setDate(i) { this.i = i; }
  setLens(tag) { this.lens = tag; }
  setSpotlight(list) { this.spot = (list || []).slice(0, 3); }
  setPins(ids) { this.pins = new Set(ids || []); }
  pause() { this.running = false; }
  resume() { this.running = true; }
  getChildScreenRect(id) {
    const c = this.cells.find((x) => x.node.id === id); if (!c || !c.poly) return null;
    const r = this.canvas.getBoundingClientRect();
    const xs = c.poly.map((p) => p[0]), ys = c.poly.map((p) => p[1]);
    const x0 = Math.max(Math.min(...xs), this.cx - this.R), x1 = Math.min(Math.max(...xs), this.cx + this.R);
    const y0 = Math.max(Math.min(...ys), this.cy - this.R), y1 = Math.min(Math.max(...ys), this.cy + this.R);
    return { x: r.left + x0, y: r.top + y0, w: x1 - x0, h: y1 - y0, cx: r.left + c.p[0], cy: r.top + c.p[1] };
  }
  _hit(e) {
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.hypot(x - this.cx, y - this.cy) > this.R || !this.cells.length) return null;
    return this.delaunay ? this.cells[this.delaunay.find(x, y)] : this.cells[0];
  }
  _move(e) {
    const c = this._hit(e);
    this.canvas.style.cursor = c ? 'pointer' : 'default';
    if ((c && c.node) !== this.hover) this.hover = c ? c.node : null;
    this.cb.onHover?.(c ? c.node : null, { x: e.clientX, y: e.clientY });
  }
  _draw() {
    const { ctx, w, h, cx, cy, R } = this;
    ctx.clearRect(0, 0, w, h);
    if (!this.node) return;
    ctx.save();
    if (this.zoom) { ctx.translate(this.zoom.p[0], this.zoom.p[1]); ctx.scale(this.zoom.s, this.zoom.s); ctx.translate(-this.zoom.p[0], -this.zoom.p[1]); }
    ctx.globalAlpha = this.alpha;
    const g = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.25);
    g.addColorStop(0, 'rgba(120,150,255,0.18)'); g.addColorStop(1, 'rgba(120,150,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, 7); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
    const i = this.i, spotIds = new Set(this.spot.map((s) => s.id));
    for (const c of this.cells) {
      const s = this.map?.children?.[c.node.id];
      ctx.beginPath(); c.poly.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      ctx.fillStyle = tempColor(s ? s.temp[i] : c.node.now?.temp);
      const dim = this.lens && !(c.node.tags || []).includes(this.lens);
      ctx.globalAlpha = this.alpha * (dim ? 0.25 : 0.9); ctx.fill();
      ctx.globalAlpha = this.alpha * 0.5; ctx.strokeStyle = this.hover === c.node ? '#fff' : 'rgba(255,255,255,0.12)'; ctx.lineWidth = this.hover === c.node ? 2 : 1; ctx.stroke();
    }
    ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of this.cells) {
      const s = this.map?.children?.[c.node.id], wv = s ? s.wind[i] : 0;
      const lit = spotIds.has(c.node.id);
      ctx.globalAlpha = this.alpha * (lit ? 1 : 0.62);
      ctx.font = `${lit ? 600 : 400} ${lit ? 15 : 12}px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillStyle = '#e8ecf6';
      ctx.fillText(`${c.node.emoji || ''} ${c.node.name}${this.pins.has(c.node.id) ? ' ★' : ''}`, c.p[0], c.p[1]);
      if (Math.abs(wv) > 0.5) { ctx.fillStyle = wv > 0 ? '#5fd39a' : '#ef6b6b'; ctx.font = '11px sans-serif'; ctx.fillText(wv > 0 ? '↑ 钱流入' : '↓ 流出', c.p[0], c.p[1] + 16); }
      if (lit) {
        const t = performance.now() / 1000, rr = 26 + 6 * Math.sin(t * 3);
        ctx.strokeStyle = 'rgba(170,180,255,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(c.p[0], c.p[1], rr, 0, 7); ctx.stroke();
        const sp = this.spot.find((x) => x.id === c.node.id);
        if (sp?.why) { ctx.font = '12px -apple-system, "PingFang SC", sans-serif'; ctx.fillStyle = 'rgba(220,225,255,0.95)'; ctx.fillText(sp.why.slice(0, 22), c.p[0], c.p[1] - 30); }
      }
    }
    ctx.restore();
  }
}

// =================================================================== stock view stub
export function openStockView(root, ticker, opt = {}) {
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'stub-stock';
  el.innerHTML = `<button class="stub-close">← 返回</button><div class="stub-body">正在加载 ${ticker}…</div>`;
  root.appendChild(el);
  el.querySelector('.stub-close').onclick = () => opt.onClose?.();
  let sj = null, i = opt.dateIndex ?? 0;
  const render = () => {
    if (!sj) return;
    const c = sj.c, W = 900, H = 260, lo = Math.min(...c), hi = Math.max(...c);
    const x = (k) => (k / (c.length - 1)) * W, y = (v) => H - ((v - lo) / (hi - lo || 1)) * H;
    const line = c.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const sent = (opt.words?.caster || caster)(sj, i);
    el.querySelector('.stub-body').innerHTML = `<h2>${sj.name} <small>${sj.t}</small></h2><p>${sj.note || ''}</p>
      <p class="stub-caster">${(Array.isArray(sent) ? sent : []).join(' ')}</p>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"><path d="${line}" fill="none" stroke="#a5b4fc" stroke-width="1.5"/>
      <line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${H}" stroke="rgba(255,255,255,.35)"/></svg>
      <div class="stub-peers">${(sj.peers || []).map((p) => `<button data-t="${p.replace(/^s:/, '')}">${p.replace(/^s:/, '')}</button>`).join('')}</div>`;
    el.querySelectorAll('.stub-peers button').forEach((b) => (b.onclick = () => opt.onPeer?.(b.dataset.t)));
  };
  import('../data.js').then((D) => D.loadStock(ticker)).then((j) => { sj = j; render(); })
    .catch(() => { el.querySelector('.stub-body').textContent = `没有 ${ticker} 的数据`; });
  return { setDate(k) { i = k; render(); }, close() { root.innerHTML = ''; } };
}
