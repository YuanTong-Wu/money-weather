// planet/names2d.js — §26 amendment 5 ("先统一 2D"): the 2D map's words are the 3D planet's (planet3d/labels.js), seen
// flat. Mixed into Planet (planet.js installs it with installNames). One rule in both renderers for:
// - names: 3D's style (12.5 px / 600 in full ink, minor 11.5, tiny 10.5; dimmed only under a lens) and contents (挤 / 空
//   stamp or season mark, name, ticker, ▲▼, 估, ★, 推演 badges inline); above ×3.5 a territory's name stands on the unit
//   it owns that holds the most money on screen (「科技 · 海淀区」); a ①②③ card that points away leaves a plain twin name
//   on its own land; names whose places share one metro stand as a column (money first); a name with no room moves out
//   with a leader (never alone at sea); never on far-side land; the 主航道's ends named behind its tail / beyond its head;
// - company clusters (≥ 3 markers fanned within 70 px → one callout, money first, ①②③ inline);
// - part names (「金融 · 纽约」, zoomed in > ×3) and faint city names (realearth.cities, ≥ ×1.7) — the same lists,
//   thresholds and budgets as 3D;
// - ①②③ cards: 3D's title row and why line; aimed at layout focus[].at → item.hub (or the deeper place); off the
//   screen / over the horizon / under the shell's UI → an edge chip 「→ 地名」 with a dashed arrow; units it owns on
//   screen hold ≥ 50 % of its money → its own land; placed by 3D's score (open water, 60–160 px, off the 主航道);
// - the 主航道: the great circle between the money places (bowed and lifted as 3D's arc), ends < 36 px apart → one
//   64 px arrow 「都在<地名>：A → B」, a second destination's thinner branch.

import { frameAt, dirOf, expMap } from './sphere.js';
import { cities, viewWindow } from './realearth.js';
import { font, numFont, drawNumber, drawTri, drawSeasonLine } from './glyphs.js';
import { channelPoly, chanTube, chanHead, curvePt } from './overlays.js';
import { clamp, roundRect, wrapText } from './util.js';

const SHOW_FACING = 0.4; // names only where the ground faces the viewer (3D labels.js)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const ang = (a, b) => Math.acos(clamp(dot(a, b), -1, 1));
function slerp(a, b, t) {
  const om = ang(a, b), so = Math.sin(om);
  if (om < 1e-7 || so < 1e-9) return a.slice();
  const ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
  return norm([ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2]]);
}
/** refine-names: 3D's words carry CSS letter-spacing (.p3-in .02em, .p3-tk .03em) — the same px after every character. */
const LS = (fs, em = 0.02) => +(fs * em).toFixed(3);
const setLS = (ctx, px) => { if ('letterSpacing' in ctx) ctx.letterSpacing = (px || 0) + 'px'; };
const ovl = (a, q) => a.x < q.x + q.w && a.x + a.w > q.x && a.y < q.y + q.h && a.y + a.h > q.y;
const area2 = (a, q) => Math.max(0, Math.min(a.x + a.w, q.x + q.w) - Math.max(a.x, q.x)) * Math.max(0, Math.min(a.y + a.h, q.y + q.h) - Math.max(a.y, q.y));
const HOT = { day: '#b8452c', night: '#e78a5c' }, COLD = { day: '#33628a', night: '#8fc4c9' };
const CC_ZH = { US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', NL: '荷兰', BE: '比利时',
  CH: '瑞士', IT: '意大利', ES: '西班牙', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', AT: '奥地利', LU: '卢森堡', IL: '以色列',
  CN: '中国', HK: '香港', TW: '台湾', JP: '日本', KR: '韩国', SG: '新加坡', IN: '印度', AU: '澳大利亚', NZ: '新西兰', ZA: '南非' };

/** The money unit nearest a money place (its label without '（…）'), as 3D's unitNear. */
function unitNear(m) {
  if (!m || !m.ll || !m.units) return null;
  let best = null, bd = 0.03;
  for (const u of m.units) { const d = Math.hypot(u.ll[0] - m.ll[0], u.ll[1] - m.ll[1]); if (d < bd && u.label) { bd = d; best = u.label; } }
  return best ? String(best).replace(/（[^）]*）$/, '') : null;
}
/** §26 a ①②③ card whose money is mostly off the view says where: '钱杀回来 → 新竹 台积电'. */
function withWhere(why, where) {
  const a = String(why || '').trim(), b = String(where || '').trim();
  if (!b || a.includes(b.replace(/^→\s*/, ''))) return a;
  return a ? `${a} ${b}` : b;
}

export function installNames(Planet) {
  Object.assign(Planet.prototype, NAMES);
}

const NAMES = {
  /** This frame's projection of the state's sphere: unit vector → [x, y (canvas px), facing]; null without a frame. */
  _lf(st) {
    const f = st && st.frame;
    if (!f) return null;
    const { cx, cy, R } = this.view;
    const R0 = this.view.R0 || R, v = f.v, [e, n] = frameAt(v), k = R * (f.Zl || 1);
    // (a frame with a lens — f.D, the 3D camera's distance in globe radii — is seen in perspective, as _llScreen does:
    // a point at height r and facing z lands at sqrt(D² − 1) / (D − r·z) of its orthographic offset)
    const D = f.D || 0, sD = D ? Math.sqrt(D * D - 1) : 1;
    return {
      v, e, n, k, cx, cy, R0, Rpx: k, z: st.real ? st.real.zoom : f.Zl || 1, win: R * (st.win || 1),
      proj: (d, r = 1) => {
        const fz = dot(d, v), K = D ? sD / Math.max(1e-6, D - r * fz) : 1;
        return [cx + dot(d, e) * k * r * K, cy - dot(d, n) * k * r * K, fz];
      },
    };
  },

  /**
   * refine-names: the unit vector under canvas px (x, y) — this frame's projection (lens included) run backwards, as
   * 3D's labels._groundAt casts a ray from its camera; null off the globe (the sky).
   */
  _unproj(st, x, y) {
    const f = st && st.frame;
    if (!f) return null;
    const { cx, cy, R } = this.view;
    let c = this._unC;
    if (!c || c.f !== f || c.cx !== cx || c.cy !== cy || c.R !== R) {
      const [e, n] = frameAt(f.v), D = f.D || 0;
      c = this._unC = { f, cx, cy, R, v: f.v, e, n, k: R * (f.Zl || 1), D, sD: D ? Math.sqrt(D * D - 1) : 1 };
    }
    const a = (x - c.cx) / c.k, b = (c.cy - y) / c.k;
    let z, de, dn;
    if (c.D) {
      // perspective: x = de·sD / (D − z) → with s = |(a, b)|² / sD², s·(D − z)² + z² = 1 (the near root)
      const u = a / c.sD, w = b / c.sD, s = u * u + w * w, disc = 1 - s * (c.D * c.D - 1);
      if (disc < 0) return null;
      z = (s * c.D + Math.sqrt(disc)) / (s + 1);
      de = u * (c.D - z); dn = w * (c.D - z);
    } else {
      const s = a * a + b * b;
      if (s > 1) return null;
      z = Math.sqrt(1 - s); de = a; dn = b;
    }
    const { v, e, n } = c;
    return [de * e[0] + dn * n[0] + z * v[0], de * e[1] + dn * n[1] + z * v[1], de * e[2] + dn * n[2] + z * v[2]];
  },

  /** What lies under canvas px (x, y) (3D labels._groundAt): k ≥ 0 a territory, −1 sea, −2 unclaimed land, −3 sky. */
  _groundAt(st, x, y) {
    const d = this._unproj(st, x, y);
    if (!d) return -3;
    const o = st.S.ownerAt(d[0], d[1], d[2]);
    return o >= 0 ? o : o === -2 ? -2 : -1;
  },

  /**
   * Does territory k own the ground at unit vector d? The sphere's raster — or, on the real Earth, the raster within
   * ~4 px of it (a money place on the very coast: 星港). refine-names: one rule with 3D labels._ownsNear (the same raster
   * now, the same tolerance), where 2D had tested its exact rings instead.
   */
  _owns(st, LF, k, d) {
    const S = st.S;
    if (!S) return false;
    if (S.ownerAt(d[0], d[1], d[2]) === k) return true;
    if (!LF || !st.real) return false;
    const [e, n] = frameAt(d), a = 4 / Math.max(60, LF.Rpx), q = [0, 0, 0];
    for (let i = 0; i < 8; i++) {
      const t = (i * Math.PI) / 4;
      expMap(d, e, n, Math.cos(t) * a, Math.sin(t) * a, q);
      if (S.ownerAt(q[0], q[1], q[2]) === k) return true;
    }
    return false;
  },

  // ============================================================================== name contents (3D labels.sync)
  /** Per territory: what its name carries (3D planet3d.js _sync spec) and its placing priority. */
  _nameSpecs(st, chan) {
    const n = st.n, S = st.S, kind = st.kind || [];
    const areaOf = (k) => (S && S.terr[k] ? S.terr[k].area : st.L.areas[k]) || 0;
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => areaOf(b) - areaOf(a));
    const major = new Set(order.slice(0, Math.max(5, Math.ceil(n * 0.5))));
    let ptMajor = null;
    const pts = st.points && st.points.length ? this._ptLayout(st) : null;
    if (st.real && pts && pts.length) {
      const z = st.real.zoom;
      const budget = z < 1.4 ? 4 : z < 2.5 ? 7 : z < 5 ? 12 : z < 10 ? 20 : 40;
      ptMajor = new Set(pts.slice().sort((a, b) => b.r - a.r).slice(0, budget).map((p) => p.k));
      for (const k of st.points) major.delete(k);
      for (const k of ptMajor) major.add(k);
      for (let k = 0; k < n; k++) if (kind[k] !== 'point') major.add(k);
    }
    // 挤 / 空 (like 高 / 低 on a weather chart): the top 3, inline before the name
    const crowd = new Map();
    if (!st.scenOn) {
      const cand = [];
      for (let k = 0; k < n; k++) {
        const p = st.cur.pres[k];
        if (!st.est[k] && Number.isFinite(p) && (p >= 80 || p <= 20)) cand.push([k, Math.abs(p - 50), p >= 80 ? 'hi' : 'lo']);
      }
      cand.sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([k, , c]) => crowd.set(k, c));
    }
    const dvOf = (k) => +((st.children[k].now || {}).dv20) || 0;
    const dvRank = new Map();
    if (st.points && st.points.length) st.points.slice().sort((a, b) => dvOf(b) - dvOf(a)).forEach((k, i, arr) => dvRank.set(k, i / Math.max(1, arr.length - 1)));
    // (refine-names, one rule with 3D: ★ marks the child that holds a pinned holding anywhere below it — 合成生物 at 医疗
    // for a configured stock — so the map leads to its level step by step)
    const pinK = new Set();
    for (const id of this.pins || []) { const k = this._resolveK(st, id); if (k != null) pinK.add(k); }
    const specs = [];
    for (let k = 0; k < n; k++) {
      const c = st.children[k];
      const num = this._capK && this._capK.has(k) ? this._numberOf(st, k) || 1 : 0;
      const sc = st.scen[k];
      const w = st.scenOn ? (sc && sc.on ? sc.value : NaN) : st.cur.wind[k];
      const badges = [];
      if (sc && sc.on) {
        if (+sc.gap >= 1.2) badges.push({ text: '时间差', cls: 'gap' });
        else if (+sc.pricedIn >= 0.65) badges.push({ text: '已抢跑' });
      }
      const isStock = c.kind === 'stock' || String(c.id || '').startsWith('s:');
      const chanEnd = !!(chan && (chan.fk === k || chan.tk === k));
      const s = {
        k, name: c.name || c.ticker || c.id, ticker: isStock ? c.ticker || String(c.id).slice(2) : null,
        season: this._seasonOf(st, k), dir: Number.isFinite(w) && Math.abs(w) >= 0.5 ? (w > 0 ? 1 : -1) : 0, num,
        est: this._isEst(st, k), pin: pinK.has(k), dim: st.dimTarget[k] > 0.5, badges, major: major.has(k), chanEnd,
        crowd: crowd.get(k) || null, point: kind[k] === 'point', dv: dvOf(k),
        hideName: !!(ptMajor && kind[k] === 'point' && !ptMajor.has(k) && !num && !pinK.has(k) && !chanEnd),
      };
      s.prio = (s.num ? 1000 - s.num * 10 : 0) + (chanEnd ? 300 : 0) + (s.major ? 100 : 0) + (s.pin ? 60 : 0) + (s.crowd ? 40 : 0) + areaOf(k) * 50 +
        (s.dim ? -200 : 0) + (s.point ? 60 * (dvRank.has(k) ? 1 - dvRank.get(k) : 0) : 0);
      specs.push(s);
    }
    return specs;
  },

  /** A name's row (3D .p3-in): runs + size. cls 'major' | 'minor' | 'tiny' | 'part'; sfx '· 海淀区'. */
  _nameRuns(s, cls, sfx = '') {
    const fs = cls === 'tiny' || cls === 'part' ? 10.5 : cls === 'minor' ? 11.5 : 12.5;
    const fw = cls === 'major' ? 600 : 500;
    const runs = [];
    let x = 0;
    const add = (r, ml = 0) => { if (runs.length) x += 3; x += ml; r.x = x; runs.push(r); x += r.w; };
    const text = (t, f, role, ml = 0, alpha = 1, ls = LS(fs)) => add({ type: 'text', text: t, f, role, alpha, ls, w: this._tw(t, f) + ls * [...t].length }, ml);
    if (s.crowd) { add({ type: 'crowd', hi: s.crowd === 'hi', w: 16 }); x += 2; }
    // one weather mark per name: the 挤 / 空 stamp wins over the season glyph
    const sea = s.season && !(s.crowd && !s.num && !s.twin) ? s.season : null; // (3D: a ①②③ twin keeps both)
    if (sea) { add({ type: 'season', key: sea, w: 13 }); x += 1; }
    text(s.name, font(fs, fw), 'name');
    if (s.ticker && s.ticker !== s.name) { const f = numFont(+(fs * 0.86).toFixed(2), 500), ls = LS(fs * 0.86, 0.03); x += 2; runs.push({ type: 'text', text: s.ticker, f, role: 'ticker', alpha: 0.72, x, ls, w: this._tw(s.ticker, f) + ls * [...s.ticker].length }); x += runs[runs.length - 1].w; }
    if (sfx) text(sfx, font(fs, 400), 'sfx', 1, 0.78);
    if (s.dir) add({ type: 'tri', up: s.dir > 0, w: 8 }, 2);
    if (s.est) add({ type: 'est', w: 17 }, 2);
    if (s.pin) text('★', font(10, 500), 'gold', 1, 1, LS(10));
    for (const b of s.badges || []) { const f = font(10.5, 600); add({ type: 'badge', text: b.text, gap: b.cls === 'gap', f, w: this._tw(b.text, f) + 12 }, 3); }
    const h = Math.max(Math.round(fs * 1.2), s.crowd ? 16 : 0, s.est ? 15 : 0);
    return { runs, w: x, h, fs };
  },

  /** Draw a row of runs (name / card title) left-aligned at x0, centred on yc. pal: {ink, halo, dark, card}. */
  _drawRuns(ctx, runs, x0, yc, pal, a) {
    const th = this.theme, night = th.name === 'night';
    for (const r of runs) {
      const x = x0 + r.x;
      ctx.globalAlpha = a * (r.alpha == null ? 1 : r.alpha);
      if (r.type === 'num') { drawNumber(ctx, r.n, x + r.w / 2, yc, 8.5, th); continue; }
      if (r.type === 'season') {
        const col = pal.dark ? th.surfInkDark : r.key === 'spring' ? th.in : r.key === 'summer' ? th.gold : r.key === 'autumn' ? (night ? HOT.night : HOT.day) : (night ? COLD.night : COLD.day);
        drawSeasonLine(ctx, r.key, x + r.w / 2, yc, r.w, col);
        continue;
      }
      if (r.type === 'crowd') {
        const col = r.hi ? (night ? HOT.night : HOT.day) : (night ? COLD.night : COLD.day);
        ctx.beginPath(); ctx.arc(x + 8, yc, 7.3, 0, Math.PI * 2);
        ctx.fillStyle = th.card; ctx.fill();
        ctx.lineWidth = 1.4; ctx.strokeStyle = col; ctx.stroke();
        ctx.font = font(10.5, 700); ctx.fillStyle = col; ctx.textAlign = 'center';
        ctx.fillText(r.hi ? '挤' : '空', x + 8, yc + 0.5);
        ctx.textAlign = 'left';
        continue;
      }
      if (r.type === 'tri') { if (!pal.card) drawTri(ctx, r.up, x + 4, yc, 9.5, pal.halo); drawTri(ctx, r.up, x + 4, yc, 7, r.up ? th.in : th.out); continue; }
      if (r.type === 'est') {
        roundRect(ctx, x + 0.5, yc - 7, r.w - 1, 14, 3);
        ctx.fillStyle = pal.card ? th.card : pal.halo; ctx.fill();
        ctx.setLineDash([2, 1.6]); ctx.lineWidth = 1; ctx.strokeStyle = pal.ink; ctx.globalAlpha = a * 0.85; ctx.stroke(); ctx.setLineDash([]);
        ctx.font = font(10, 600); ctx.fillStyle = pal.ink; ctx.textAlign = 'center';
        ctx.fillText('估', x + r.w / 2, yc + 0.5);
        ctx.textAlign = 'left';
        continue;
      }
      if (r.type === 'badge') {
        roundRect(ctx, x, yc - 8, r.w, 16, 8);
        ctx.fillStyle = r.gap ? th.gold : th.card; ctx.fill();
        if (!r.gap) { ctx.lineWidth = 1; ctx.strokeStyle = th.cardLine; ctx.stroke(); }
        ctx.font = r.f; ctx.fillStyle = r.gap ? '#1f2a44' : th.cardText;
        ctx.fillText(r.text, x + 6, yc + 0.5);
        continue;
      }
      ctx.font = r.f;
      if (r.ls) setLS(ctx, r.ls);
      if (!pal.card && r.role !== 'gold') {
        ctx.lineWidth = pal.dark ? 3 : 3.2;
        ctx.strokeStyle = pal.halo;
        const a1 = ctx.globalAlpha;
        ctx.globalAlpha = a; // (the halo stays whole under a softer word)
        ctx.strokeText(r.text, x, yc + 0.5);
        ctx.globalAlpha = a1;
      }
      ctx.fillStyle = r.role === 'gold' ? th.gold : pal.ink;
      ctx.fillText(r.text, x, yc + 0.5);
      if (r.ls) setLS(ctx, 0);
    }
    ctx.globalAlpha = a;
  },

  // ============================================================================== 主航道 geometry (3D planet3d.js _sync + fx.js _arcGeom)
  /**
   * The 主航道 on screen: ends at the money places (layout focus.at → item.hub; 抽象 / no money: the territory's point
   * nearest its hub that sits well inside the disc), an end off the view pulled along the great circle into view; ends
   * < 36 px apart → one 64 px arrow on the place (「都在北京：原材料 → 金融」); the route itself = 3D's arc (great circle,
   * bowed 0.09·ω toward the planet's front, lifted to its peak). Sets chan.curve / branch / pts / halfW / tip / tail;
   * nothing of the route in view → no arc (and no caption).
   */
  _chanGeom(st, chan, LF) {
    chan.curve = null; chan.branch = null; chan.pts = null; chan.single = null; chan.arcF = null;
    this._chanPull = null;
    const S = st.S;
    if (!LF || !S) return;
    const { cx, cy, R0 } = LF;
    const isPt = (k) => !!(st.kind && st.kind[k] === 'point');
    // (refine-names: 抽象 measures "well inside the disc" on the globe at ×1, as 3D's world.chanEnd does at its rest
    // zoom — a zoomed 抽象 planet keeps its ends where 3D has them, not pulled to the screen's middle)
    const scr = (d) => { const p = LF.proj(d); return p[2] > 0 ? Math.hypot(p[0] - cx, p[1] - cy) / (st.real ? R0 : Math.max(1, LF.Rpx)) : 2; };
    const chanEnd = (k, maxR) => {
      const T = S.terr[k], a = T.hub || T.anchor;
      let best = null, bestD = Infinity, alt = a, altR = Infinity;
      for (const p of [a].concat(T.cands || [])) {
        const r = scr(p), dd = ang(p, a);
        if (r <= maxR && dd < bestD) { bestD = dd; best = p; }
        if (r < altR) { altR = r; alt = p; }
      }
      return (best || alt).slice();
    };
    let a = chanEnd(chan.fk, 0.78), b = chanEnd(chan.tk, 0.76);
    if (st.real) {
      const ma = st.money && st.money.get(chan.fk), mb = st.money && st.money.get(chan.tk);
      if (ma && !isPt(chan.fk)) a = ma.d.slice();
      if (mb && !isPt(chan.tk)) b = mb.d.slice();
      // the real Earth does not turn to suit the arc: an end off the view is pulled along the route into view
      const inView = (d) => { const p = LF.proj(d); return p[2] > 0.3 && Math.hypot(p[0] - cx, p[1] - cy) < 0.86 * R0 && this._visXY(st, p[0], p[1], 10); };
      const pull = (p, q) => {
        if (inView(p)) return p;
        if (ang(p, q) < 1e-4) return p;
        for (let i = 1; i <= 60; i++) { const d = slerp(p, q, i / 60); if (inView(d)) return d; }
        return p;
      };
      const a0 = a, b0 = b;
      a = pull(a0, b0); b = pull(b0, a0);
      this._chanPull = pull;
      if (!inView(a) && !inView(b)) return; // no part of the route on the map: no arc, no orphan caption
      const pxR = Math.max(60, LF.Rpx), om = ang(a, b);
      if (om * pxR < 36 && !isPt(chan.fk) && !isPt(chan.tk)) {
        // both ends in one city at this zoom: one short readable arrow (64 px) centred on the place, from → to bearing
        const mid = norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
        let ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const q = dot(ax, mid);
        ax = [ax[0] - mid[0] * q, ax[1] - mid[1] * q, ax[2] - mid[2] * q];
        if (Math.hypot(ax[0], ax[1], ax[2]) < 1e-7) ax = frameAt(mid)[0]; // the same point: west → east
        ax = norm(ax);
        const h = 64 / pxR / 2, c = Math.cos(h), s = Math.sin(h);
        a = norm([mid[0] * c - ax[0] * s, mid[1] * c - ax[1] * s, mid[2] * c - ax[2] * s]);
        b = norm([mid[0] * c + ax[0] * s, mid[1] * c + ax[1] * s, mid[2] * c + ax[2] * s]);
        const place = (ma && ma.label) || (mb && mb.label) || null;
        const uA = unitNear(ma), uB = unitNear(mb);
        const nm = (c2) => c2.name || c2.ticker || c2.id;
        chan.local = place;
        if (place) chan.say = `都在${place}：${nm(st.children[chan.fk])} → ${nm(st.children[chan.tk])}` + (uA && uB && uA !== uB ? `（${uA} → ${uB}）` : '');
      }
    }
    // a company target: the head stops at its marker ring + 4 px
    if (isPt(chan.tk)) {
      const p = st.ptOf && st.ptOf.get(chan.tk);
      const px = ((p ? p.r : 6) + 4) / Math.max(60, LF.Rpx), om = ang(a, b);
      if (om > px * 1.5) b = slerp(a, b, 1 - px / om);
    }
    // a second destination (§23 "…跑去欧洲和美洲"): a thinner branch, only when it faces the viewer
    let b2 = null;
    if (chan.t2k != null && S.terr[chan.t2k]) {
      if (dot(S.terr[chan.t2k].anchor, LF.v) > 0.45) b2 = chanEnd(chan.t2k, 0.76);
      else chan.t2k = null;
      // (refine-names: on the real Earth the second destination is its money place too — 金融 in 北京, never whichever
      // of its pieces sits mid-screen — pulled into view along the route like the main ends)
      const m2 = b2 && st.real && st.money && !isPt(chan.t2k) ? st.money.get(chan.t2k) : null;
      if (m2 && this._chanPull) b2 = this._chanPull(m2.d.slice(), a);
    }
    const ws = st.real ? 1 / Math.max(1, st.real.zoom) : 1;
    // (refine-names: the bow's side as 3D's world.frontDir — on the real Earth the node's own default view (list.view),
    // which a free camera keeps; else the sphere's front)
    const lv = st.real && st.list && st.list.view;
    const front = lv ? dirOf(+lv.lon || 0, +lv.lat || 0) : S.front || [0, 0, 1];
    const arc = (da, db) => {
      const om = Math.max(1e-4, ang(da, db)), so = Math.sin(om);
      let nrm = norm(cross(da, db));
      if (dot(nrm, front) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
      const bow = 0.09 * om, peak = ws * (0.04 + 0.11 * Math.min(1, om / (1.4 * ws)));
      const out = [];
      for (let i = 0; i <= 64; i++) {
        const t = i / 64, sb = Math.sin(Math.PI * t);
        const ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
        const d = norm([ka * da[0] + kb * db[0] + nrm[0] * bow * sb, ka * da[1] + kb * db[1] + nrm[1] * bow * sb, ka * da[2] + kb * db[2] + nrm[2] * bow * sb]);
        const p = LF.proj(d, 1 + 0.006 * ws + peak * Math.pow(sb, 0.85));
        out.push([p[0], p[1]]);
      }
      return out;
    };
    const c = channelPoly(arc(a, b));
    // (integrator: two places in one spot — two companies on one HQ, NVDA → AMD in 圣克拉拉 — keep the route and its
    // caption, as 3D does; the arc itself is drawn only once it is ≥ 12 px on screen)
    if (!Number.isFinite(c.len)) return;
    chan.curve = c;
    chan.ends = [a, b];
    if (b2) { const br = channelPoly(arc(a, b2)); if (br.len > 20) chan.branch = br; else chan.t2k = null; }
    chan.arcF = { front, ws, b2: chan.branch ? b2 : null, real: !!st.real }; // (integrator: the arc's shape, for the moving picture — _chanLive)
    chan.pts = [];
    for (let i = 0; i <= 24; i++) chan.pts.push(curvePt(c, i / 24));
    const wt = chanTube(R0, c.len);
    chan.tube = wt;
    chan.halfW = Math.max(3, wt * 0.6) + 6;
    chan.headPx = wt * 1.7;
    const hl = chanHead(R0, c.len);
    // (final: the head's base and the tail's first tenth measured as 3D's _arcGeom does — along the lifted arc on the
    // globe, then projected — so an end diving toward the limb foreshortens its name direction exactly as in 3D)
    const g3 = arc3(a, b, front, ws, LF);
    const base = g3 ? g3.base : curvePt(c, c.len > 0 ? Math.max(0, (c.len - hl) / c.len) : 0), s1 = g3 ? g3.s1 : curvePt(c, 0.1);
    const u2 = (p, q) => { const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    chan.tipS = c.B; chan.tipDir = u2(c.B, base); chan.baseS = base;
    chan.tailS = c.A; chan.tailDir = u2(c.A, s1);
  },

  /**
   * integrator: the 主航道 at another camera — the moving picture's live lens (LF-shaped: {proj, vis}) — from its sphere
   * ends, with the same great-circle bow and lift as _chanGeom at rest (3D's arc is a world-space object: a glide never
   * stretches it). The rest frame's polyline moved point by point folded into a long V on an 抽象 wheel zoom (its lifted
   * points unprojected onto the ground). → {curve, branch} (channelPoly, the longest run on the near side) | null.
   */
  _chanLive(chan, LF) {
    const F = chan && chan.arcF;
    if (!F || !chan.ends || !LF) return null;
    const { front, ws } = F;
    const arc = (da, db) => {
      const om = Math.max(1e-4, ang(da, db)), so = Math.sin(om);
      let nrm = norm(cross(da, db));
      if (dot(nrm, front) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
      const bow = 0.09 * om, peak = ws * (0.04 + 0.11 * Math.min(1, om / (1.4 * ws)));
      let run = [], best = [];
      for (let i = 0; i <= 64; i++) {
        const t = i / 64, sb = Math.sin(Math.PI * t);
        const ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
        const d = norm([ka * da[0] + kb * db[0] + nrm[0] * bow * sb, ka * da[1] + kb * db[1] + nrm[1] * bow * sb, ka * da[2] + kb * db[2] + nrm[2] * bow * sb]);
        const p = LF.proj(d, 1 + 0.006 * ws + peak * Math.pow(sb, 0.85));
        if (p[2] > LF.vis) run.push([p[0], p[1]]);
        else { if (run.length > best.length) best = run; run = []; }
      }
      if (run.length > best.length) best = run;
      return best.length >= 2 ? channelPoly(best) : null;
    };
    const [a, b] = chan.ends;
    return { curve: arc(a, b), branch: F.b2 ? arc(a, F.b2) : null };
  },

  /** The arc's own boxes (3D labels.update): tube samples, the head, the tail — words keep off them. */
  _chanBoxes(chan) {
    const out = [];
    if (!chan || !chan.curve) return out;
    const tube = Math.max(3, (chan.tube || 8) * 0.6);
    for (const c of [chan.curve, chan.branch].filter(Boolean)) {
      for (let i = 1; i <= 9; i++) { const [x, y] = curvePt(c, i / 10); out.push({ x: x - tube - 6, y: y - tube - 6, w: 2 * tube + 12, h: 2 * tube + 12, arc: true }); }
    }
    const [tx, ty] = chan.tipS, [bx, by] = chan.baseS, hw = Math.max(8, chan.headPx || 8);
    out.push({ x: Math.min(tx, bx) - hw - 24, y: Math.min(ty, by) - hw - 24, w: Math.abs(tx - bx) + 2 * hw + 48, h: Math.abs(ty - by) + 2 * hw + 48, arc: true });
    out.push({ x: chan.tailS[0] - 10, y: chan.tailS[1] - 10, w: 20, h: 20, arc: true });
    if (chan.branch) { const [x, y] = chan.branch.B; out.push({ x: x - hw - 10, y: y - hw - 10, w: 2 * hw + 20, h: 2 * hw + 20, arc: true }); }
    return out;
  },

  /**
   * refine-names: the 主航道 caption where 3D hangs it (labels.update): on the arc's top point — or, when that is off the
   * free screen / under the shell's UI, the visible arc point nearest to it — out on the arc's convex side by 3D's
   * _callout (gap 22), a leader back to a dot on the arc. Call after the arc's own boxes are in env.hard.
   */
  _placeChanCap(st, chan, sp, LF, env) {
    const c = chan.curve;
    if (!c || !LF || !chan.ends) return null;
    const { fits, cost, ui, E } = env;
    const facing = (t) => dot(slerp(chan.ends[0], chan.ends[1], t), LF.v);
    if (facing(0.5) <= 0.22) return null;
    const freeAt = (qx, qy, m) => qx > E.x0 + m && qx < E.x1 - m && qy > E.y0 + m && qy < E.y1 - m &&
      !ui.some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && qx > q.x - 8 && qx < q.x + q.w + 8 && qy > q.y - 8 && qy < q.y + q.h + 8);
    let at = null;
    const [x0, y0] = c.apex;
    if (freeAt(x0, y0, 30)) at = [x0, y0];
    else {
      let bd = Infinity;
      for (let i = 0; i <= 12; i++) {
        if (facing(i / 12) < 0.22) continue;
        const q = curvePt(c, i / 12);
        if (!freeAt(q[0], q[1], 60)) continue;
        const d = Math.hypot(q[0] - x0, q[1] - y0);
        if (d < bd) { bd = d; at = q; }
      }
    }
    if (!at) return null;
    const [x, y] = at;
    let px = x - (c.A[0] + c.B[0]) / 2, py = y - (c.A[1] + c.B[1]) / 2;
    // (a nearly straight arc — its bow and its lift about cancel, and 3D's toon relief tips the balance — hangs it
    // outward from the planet's centre, so both renderers agree; 3D labels.js has the same rule)
    if (Math.hypot(px, py) < Math.max(6, 0.08 * Math.hypot(c.B[0] - c.A[0], c.B[1] - c.A[1]))) { px = x - LF.cx; py = y - LF.cy; }
    const pick = this._callout(sp, x, y, fits, 22, [px, py], cost);
    if (!pick) return null;
    return { x: x + pick.ox - sp.w / 2, y: y + pick.oy - sp.h / 2, w: sp.w, h: sp.h, ax: x, ay: y };
  },

  // ============================================================================== placing (3D labels.js _callout / _calloutScored)
  /** Callout spots around (x, y): the preferred direction first; the first that fits, else the least bad. */
  _callout(sz, x, y, fits, gap, pref, cost) {
    let dx = pref[0], dy = pref[1];
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
    const rot = (a) => [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
    const cands = [[dx, dy], rot(0.5), rot(-0.5), rot(1.0), rot(-1.0), [0, -1], [0, 1], rot(1.6), rot(-1.6), [1, 0], [-1, 0]];
    let best = null;
    for (const g of [gap, gap * 1.8, gap * 2.8]) {
      for (const [ux, uy] of cands) {
        const ext = Math.abs(ux) * sz.w / 2 + Math.abs(uy) * sz.h / 2;
        const ox = ux * (g + ext), oy = uy * (g + ext);
        const r = { x: x + ox - sz.w / 2 - 3, y: y + oy - sz.h / 2 - 3, w: sz.w + 6, h: sz.h + 6 };
        if (fits(r)) { best = { ox, oy, r }; break; }
        const c = cost ? cost(r) : 0;
        if (!best || (best.bad && c < best.c)) best = { ox, oy, r, bad: true, c };
      }
      if (best && !best.bad) break;
    }
    return best;
  },

  /**
   * ①②③ card / cluster callout by score (3D _calloutScored): 16 directions × 60 / 90 / 125 / 160 / 34 px, never on the
   * shell's UI or another word, its leader never across the UI, softly off territories (open water / sky win), toward
   * pref; the previous spot (key) wins ties.
   */
  _calloutScored(st, sz, x, y, fits, pref, cost, key, ui) {
    let dx = pref[0], dy = pref[1];
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
    // (refine-names: 3D's segHits tests every obstacle — the shell's 主航道 card and ring too)
    const segHits = (x0, y0, x1, y1) => ui.some((q) => {
      let t0 = 0, t1 = 1;
      const ddx = x1 - x0, ddy = y1 - y0;
      for (const [pp, qq] of [[-ddx, x0 - q.x], [ddx, q.x + q.w - x0], [-ddy, y0 - q.y], [ddy, q.y + q.h - y0]]) {
        if (Math.abs(pp) < 1e-9) { if (qq < 0) return false; continue; }
        const t = qq / pp;
        if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
      return t0 <= t1;
    });
    const prev = key ? this._sticky.get(key) : null;
    const rectAt = (i, g) => {
      const a = (i * Math.PI) / 8, ux = Math.cos(a), uy = Math.sin(a);
      const ext = Math.abs(ux) * sz.w / 2 + Math.abs(uy) * sz.h / 2;
      const ox = ux * (g + ext), oy = uy * (g + ext);
      return { ox, oy, ux, uy, r: { x: x + ox - sz.w / 2 - 3, y: y + oy - sz.h / 2 - 3, w: sz.w + 6, h: sz.h + 6 } };
    };
    let best = null;
    // (refine-names, 3D _calloutScored: the last pick stays while it fits — for 1.5 s after the camera rests, then the
    // spot is re-scored, the old one winning ties — so a card does not hop between two nearly equal spots)
    const now = performance.now();
    if (prev && prev.length > 2 && prev[2] >= (this._settleT || 0) && now - prev[2] < 1500) {
      const c = rectAt(prev[0], prev[1]);
      if (fits(c.r)) best = Object.assign(c, { i: prev[0], g: prev[1], kept: true });
    }
    if (!best) {
      for (const g of [60, 90, 125, 160, 34]) {
        for (let i = 0; i < 16; i++) {
          const c = rectAt(i, g), { ux, uy, ox, oy, r } = c;
          let sc = fits(r) ? 0 : 1e5 + cost(r);
          if (segHits(x, y, x + ox, y + oy)) sc += 5e4;
          sc += this._groundPen(st, r);
          sc += g < 60 ? (60 - g) * 0.05 : g > 125 ? (g - 125) * 0.025 : 0;
          sc += 0.006 * g + (1 - (ux * dx + uy * dy)) * 0.45;
          if (prev && prev[0] === i && prev[1] === g) sc -= 0.8; // hysteresis
          if (!best || sc < best.sc) best = Object.assign(c, { sc, i, g });
        }
      }
      if (key) { this._sticky.delete(key); this._sticky.set(key, [best.i, best.g, performance.now()]); if (this._sticky.size > 200) this._sticky.delete(this._sticky.keys().next().value); }
    }
    return best;
  },

  /**
   * Where a ①②③ card waits when its place is off the free screen (or under the shell's UI, or over the horizon): on
   * the ray from the free area's middle toward the place, 22 px inside its edge, stepped off the shell's UI (3D
   * labels.js _edgeSpot). pos: the place on screen ({x, y}) when known. Returns {x, y, dx, dy} or null (on screen).
   */
  _edgeAt(st, LF, pos, dir, E, ui) {
    const facing = dot(dir, LF.v) > 0.03;
    const obsAt = (x, y, m) => ui.some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && x > q.x - m && x < q.x + q.w + m && y > q.y - m && y < q.y + q.h + m);
    let x = 0, y = 0;
    if (facing) {
      if (pos) { x = pos.x; y = pos.y; } else { const p = LF.proj(dir); x = p[0]; y = p[1]; }
      if (x >= E.x0 && x <= E.x1 && y >= E.y0 && y <= E.y1 && !obsAt(x, y, 6) && this._visXY(st, x, y, 0)) return null;
    }
    const mx = (E.x0 + E.x1) / 2, my = (E.y0 + E.y1) / 2;
    let dx, dy;
    if (facing) { dx = x - mx; dy = y - my; } else { dx = dot(dir, LF.e); dy = -dot(dir, LF.n); }
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return null;
    dx /= l; dy /= l;
    const m = 22;
    const tx = dx > 0 ? (E.x1 - m - mx) / dx : dx < 0 ? (E.x0 + m - mx) / dx : Infinity;
    const ty = dy > 0 ? (E.y1 - m - my) / dy : dy < 0 ? (E.y0 + m - my) / dy : Infinity;
    const t = Math.max(0, Math.min(tx, ty));
    let ex = mx + dx * t, ey = my + dy * t;
    const inObs = (px, py) => obsAt(px, py, 12);
    if (inObs(ex, ey)) {
      let best = null;
      for (const q of ui) {
        if (!(ex > q.x - 12 && ex < q.x + q.w + 12 && ey > q.y - 12 && ey < q.y + q.h + 12)) continue;
        for (const [px, py] of [[ex, q.y + q.h + 16], [ex, q.y - 16], [q.x + q.w + 16, ey], [q.x - 16, ey]]) {
          if (px < E.x0 + m || px > E.x1 - m || py < E.y0 + m || py > E.y1 - m || inObs(px, py)) continue;
          const d = Math.hypot(px - ex, py - ey);
          if (!best || d < best.d) best = { x: px, y: py, d };
        }
      }
      if (best) { ex = best.x; ey = best.y; }
    }
    return { x: ex, y: ey, dx, dy };
  },

  // ============================================================================== ①②③ cards
  /** A card's content as 3D draws it: number, season, name (+ ticker, 估, ★, badges); the why line (+ '→ 地名' at the edge). */
  _cardSpec(st, s, n, why, to) {
    const runs = [];
    let x = 0;
    const add = (r, ml = 0) => { if (runs.length) x += 4; x += ml; r.x = x; runs.push(r); x += r.w; };
    add({ type: 'num', n, w: 17 }); x += 1;
    if (s.season) add({ type: 'season', key: s.season, w: 14 });
    const f = font(13, 650), ls = LS(13);
    add({ type: 'text', text: s.name, f, role: 'name', ls, w: this._tw(s.name, f) + ls * [...s.name].length });
    if (s.ticker && s.ticker !== s.name) { const ft = numFont(11.2, 500), lt = LS(11.2, 0.03); x += 2; runs.push({ type: 'text', text: s.ticker, f: ft, role: 'ticker', alpha: 0.72, x, ls: lt, w: this._tw(s.ticker, ft) + lt * [...s.ticker].length }); x += runs[runs.length - 1].w; }
    if (s.est) add({ type: 'est', w: 17 });
    if (s.pin) add({ type: 'text', text: '★', f: font(10, 500), role: 'gold', ls: LS(10), w: this._tw('★', font(10, 500)) + LS(10) });
    for (const b of s.badges || []) { const fb = font(10.5, 600); add({ type: 'badge', text: b.text, gap: b.cls === 'gap', f: fb, w: this._tw(b.text, fb) + 12 }); }
    const rowW = x;
    const fw = font(11.5, 400), ft2 = font(11.5, 600);
    const toTxt = to ? (why ? ' ' : '') + '→ ' + to : '';
    let lines = [];
    const lsw = LS(11.5);
    if (why || toTxt) {
      const ctx = this.ctx;
      ctx.font = fw;
      setLS(ctx, lsw);
      const full = why + toTxt;
      lines = wrapText(ctx, full, 210, 4);
      // no orphans: a last line of 1–2 characters gets a wider card instead
      if (lines.length > 1 && Array.from(lines[lines.length - 1]).length <= 2) lines = wrapText(ctx, full, 232, 4);
      setLS(ctx, 0);
    }
    const lw = lines.map((l) => this._tw(l, fw) + lsw * [...l].length);
    const w = Math.ceil(Math.max(rowW, ...lw, 0)) + 16 + 2;
    const h = 5 + 17 + (lines.length ? 1 + lines.length * 16 : 0) + 6 + 2;
    return { runs, lines, why, to: toTxt ? toTxt.trim() : '', fw, ft2, w, h, rowW, lsw };
  },

  /**
   * ①②③ cards for this frame (3D labels.update nums): aimed at the money (or the deeper place); off the screen →
   * edge chip; placed by score. Pushes their boxes into `hard`; returns the set of territories whose plain twin name
   * stays on their own land (the card points away).
   */
  _layoutCards(st, capList, specs, LF, env) {
    const { hard, fits, cost, ui, E, arcPx } = env;
    const caps = [];
    const twin = new Set();
    const S = st.S;
    this._caps = caps;
    if (!capList.length) return twin;
    const { cx, cy } = this.view;
    if (!LF || !S) {
      // (no sphere — the disk fallback after a layout error: each card aims at its label anchor)
      for (const { s: sp0, k } of capList) {
        const ax = cx + st.L.anchors[k][0] * this.view.R, ay = cy + st.L.anchors[k][1] * this.view.R;
        if (!this._visXY(st, ax, ay, -4)) continue;
        const n = this._numberOf(st, k) || caps.length + 1, card = this._cardSpec(st, specs[k], n, String(sp0.why || ''), null);
        const pick = this._calloutScored(st, card, ax, ay, fits, [ax - cx, ay - cy], cost, 'cap:' + k, ui);
        hard.push(Object.assign({ cap: true, k }, pick.r));
        caps.push(Object.assign(card, { k, n, title: specs[k].name, key: 'cap:' + k, ax, ay, x: ax + pick.ox - card.w / 2, y: ay + pick.oy - card.h / 2, side: 'scored', edge: null }));
      }
      return twin;
    }
    const isPt = (k) => !!(st.kind && st.kind[k] === 'point');
    const obsAt = (x, y, m) => ui.some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && x > q.x - m && x < q.x + q.w + m && y > q.y - m && y < q.y + q.h + m);
    const onScreen = (d) => {
      const p = LF.proj(d);
      if (p[2] < 0.25) return null;
      if (p[0] < E.x0 || p[0] > E.x1 || p[1] < E.y0 || p[1] > E.y1 || obsAt(p[0], p[1], 6) || !this._visXY(st, p[0], p[1], 0)) return null;
      return p;
    };
    const distArc = (x, y) => {
      let m = Infinity;
      for (let i = 0; i < arcPx.length; i++) {
        const [ax, ay] = arcPx[i];
        m = Math.min(m, Math.hypot(ax - x, ay - y));
        if (i + 1 < arcPx.length) {
          const [bx, by] = arcPx[i + 1], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
          if (l2 > 1 && l2 < 900 * 900) { const t = clamp(((x - ax) * vx + (y - ay) * vy) / l2, 0, 1); m = Math.min(m, Math.hypot(ax + vx * t - x, ay + vy * t - y)); }
        }
      }
      return m;
    };
    // (refine-names, one rule with 3D: placed ① ② ③ — the first number gets the best spot)
    const ordered = capList.slice().sort((a, b) => (this._numberOf(st, a.k) || 9) - (this._numberOf(st, b.k) || 9));
    for (const { s: sp0, k } of ordered) {
      const s = specs[k], T = S.terr[k];
      if (!T) continue;
      const n = this._numberOf(st, k) || caps.length + 1;
      // §26 amendment 4: a card about a deeper place (海外股市 › 印度) points at that place (item.childAt)
      const deepLL = sp0.deep && st.childAt ? st.childAt.get(sp0.deep) : null;
      const deepDir = deepLL ? dirOf(deepLL[0], deepLL[1]) : null;
      const foc = deepDir && st.focus ? st.focus.get(sp0.deep) : null;
      // refine (#6): on the real Earth a card points where the sector's MONEY is (layout focus[].at = item.hub): on the
      // screen → there (nudged ≤ 26 px off the 主航道); off it → the edge chip toward it, unless the units it owns on
      // screen hold ≥ half of its money (then its own land on screen is the honest place)
      const mo = !deepDir && st.real && !isPt(k) && st.money ? st.money.get(k) || null : null;
      let targets = null, edgeDir = deepDir;
      if (mo) {
        if (onScreen(mo.d)) {
          targets = [mo.d];
          const [e1, n1] = frameAt(mo.d), a26 = 26 / Math.max(60, LF.Rpx);
          // (refine-names: a dot nudged off the 主航道 stays on land — its own territory first, never out at sea)
          const own = [], land = [];
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2, q = expMap(mo.d, e1, n1, Math.cos(a) * a26, Math.sin(a) * a26, [0, 0, 0]), o = S.ownerAt(q[0], q[1], q[2]);
            if (o === k) own.push(q); else if (o >= 0 || o === -2) land.push(q);
          }
          targets.push(...own, ...land);
        } else {
          let vis = 0;
          for (const u of mo.units) if (u.w > 0 && onScreen(u.d)) vis += u.w;
          if (vis < 0.5) { targets = [mo.d]; edgeDir = mo.d; }
        }
      }
      const pp = isPt(k) && st.ptOf ? st.ptOf.get(k) : null;
      let best = null, bestFree = null, farthest = null;
      let list = deepDir ? [deepDir] : targets || T.cands || [T.anchor];
      if (!st.real && !deepDir) {
        // (refine-names, one rule with 3D: a zoomed 抽象 planet has no edge chips — the card points at a piece of its
        // land that is on the free screen, never at one past the screen's edge, which left 抽象 全球 ×4 without its ②)
        const vis = list.filter((d) => { const q = LF.proj(d); return q[2] > 0.25 && this._visXY(st, q[0], q[1], 0); });
        if (vis.length) list = vis;
      }
      for (const d of list) {
        const p = LF.proj(d);
        const cand = { d, f: p[2], x: p[0], y: p[1] };
        if (pp && !deepDir) { cand.x = pp.tx; cand.y = pp.ty; }
        if (!best || cand.f > best.f + 0.02) best = cand;
        if (cand.f > 0.25 && arcPx.length) {
          cand.dA = distArc(cand.x, cand.y);
          if (cand.dA >= 18 && (!bestFree || cand.f > bestFree.f + 0.02)) bestFree = cand;
          if (!farthest || cand.dA > farthest.dA) farthest = cand;
        }
        if (cand.f > 0.6 && !arcPx.length) break;
      }
      if (bestFree) best = bestFree;
      else if (farthest && farthest.f > 0.25) best = farthest;
      let ok = !!(best && best.f > 0.25);
      if (ok && !st.real && !this._visXY(st, best.x, best.y, -4)) ok = false; // (抽象 zoomed in: outside the porthole)
      const edge = st.real ? this._edgeAt(st, LF, ok && !(mo && edgeDir) ? best : null, edgeDir || (ok ? best.d : T.anchor), E, ui) : null;
      // the territory's own name stays on its land when the card points elsewhere (a deeper place, money in another
      // sector's unit, or the edge)
      if (st.real && (edge || deepDir || (mo && !this._owns(st, LF, k, mo.d)))) twin.add(k);
      const where = deepDir || mo ? null : st.where && st.where.get(k);
      const why = withWhere(sp0.why, where);
      const offL = st.where && st.where.get(k) ? String(st.where.get(k)).replace(/^→\s*/, '') : null;
      const toLab = deepDir ? (foc && foc.label) || null : mo ? (offL && mo.label && offL.includes(mo.label) ? offL : mo.label) : null;
      const to = edge && toLab && !why.includes(toLab) ? toLab : null;
      const card = this._cardSpec(st, s, n, why, to);
      const key = 'cap:' + k + '|' + (sp0.deep || '');
      let pick = null, ax = 0, ay = 0;
      if (edge) {
        ax = edge.x; ay = edge.y;
        pick = this._callout(card, ax, ay, fits, 20, [-edge.dx, -edge.dy], cost);
        hard.push({ x: ax - 8, y: ay - 8, w: 16, h: 16 });
      } else if (ok) {
        ax = best.x; ay = best.y;
        pick = this._calloutScored(st, card, ax, ay, fits, [ax - cx, ay - cy], cost, key, ui);
        hard.push({ x: ax - 6, y: ay - 6, w: 12, h: 12 });
      }
      if (!pick) continue;
      hard.push(Object.assign({ cap: true, k }, pick.r));
      caps.push(Object.assign(card, {
        k, n, title: s.name, key, ax, ay, x: ax + pick.ox - card.w / 2, y: ay + pick.oy - card.h / 2, side: 'scored',
        edge: edge ? { dx: edge.dx, dy: edge.dy } : null,
      }));
    }
    return twin;
  },

  /** Paint ①②③ cards (+ leaders, 3D style). move(x, y) → [x', y'] | null re-projects the anchors (the moving picture). */
  _paintCards(ctx, st, caps, a, move = null) {
    const th = this.theme, night = th.name === 'night';
    const shadow = night ? 'rgba(0,0,0,0.22)' : 'rgba(31,42,68,0.08)';
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const c0 of caps) {
      let c = c0, ax = c.ax, ay = c.ay;
      if (move) {
        const q = move(c.ax, c.ay);
        if (!q && !c.edge) continue;
        if (q && !c.edge) { c = Object.assign({}, c0, { x: c0.x + q[0] - c0.ax, y: c0.y + q[1] - c0.ay }); ax = q[0]; ay = q[1]; }
      }
      ctx.globalAlpha = a;
      // the leader: from the place to the card's edge (an edge chip: dashed, an arrowhead pointing at the place)
      const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2, ox = ccx - ax, oy = ccy - ay;
      const ex = Math.abs(ox) > 1e-3 ? (c.w / 2) / Math.abs(ox) : Infinity, ey = Math.abs(oy) > 1e-3 ? (c.h / 2) / Math.abs(oy) : Infinity;
      const f = Math.max(0, 1 - Math.min(ex, ey));
      ctx.strokeStyle = th.cardText;
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      if (f > 0) {
        ctx.globalAlpha = a * 0.55;
        if (c.edge) ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + ox * f, ay + oy * f); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = a;
      }
      if (c.edge) {
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(Math.atan2(c.edge.dy, c.edge.dx));
        ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-3, -5); ctx.lineTo(-1, 0); ctx.lineTo(-3, 5); ctx.closePath();
        ctx.lineJoin = 'round'; ctx.lineWidth = 1.5; ctx.strokeStyle = th.card; ctx.stroke();
        ctx.fillStyle = th.cardText; ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(ax, ay, 3.2, 0, Math.PI * 2);
        ctx.lineWidth = 2; ctx.strokeStyle = th.card; ctx.stroke();
        ctx.fillStyle = th.cardText; ctx.fill();
      }
      // the card: paper, hairline border, a 1 px drop (3D .p3-spot)
      roundRect(ctx, c.x, c.y + 1, c.w, c.h, 7);
      ctx.fillStyle = shadow; ctx.fill();
      roundRect(ctx, c.x, c.y, c.w, c.h, 7);
      ctx.fillStyle = th.card; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = th.cardLine; ctx.stroke();
      const x0 = c.x + 8, yRow = c.y + 1 + 5 + 8.5;
      ctx.fillStyle = th.cardText;
      this._drawRuns(ctx, c.runs, x0, yRow, { ink: th.cardText, halo: th.card, card: true, dark: false }, a);
      if (c.lines.length) {
        ctx.font = c.fw;
        setLS(ctx, c.lsw);
        const toAt = c.to ? c.lines[c.lines.length - 1].lastIndexOf(c.to.slice(0, 2)) : -1;
        c.lines.forEach((l, i) => {
          const y = yRow + 8.5 + 1 + 8 + i * 16;
          if (c.to && i === c.lines.length - 1 && toAt >= 0) {
            // '→ 地名' in the card ink (it says where the edge arrow points)
            const head = l.slice(0, toAt);
            ctx.font = c.fw; ctx.fillStyle = th.cardMuted; ctx.fillText(head, x0, y);
            ctx.font = c.ft2; ctx.fillStyle = th.cardText; ctx.fillText(l.slice(toAt), x0 + this._tw(head, c.fw) + (c.lsw || 0) * [...head].length, y);
            ctx.font = c.fw;
          } else { ctx.fillStyle = th.cardMuted; ctx.fillText(l, x0, y); }
        });
        setLS(ctx, 0);
      }
    }
    ctx.restore();
  },

  // ============================================================================== company clusters (3D _clusters)
  _layoutClusters(st, specs, LF, env) {
    const inClu = new Set();
    const { placed, hard, fits, cost, ui } = env;
    const S = st.S;
    if (!st.real || !st.pt || !S || !LF) return inClu;
    const P = st.pt.filter((q) => q.vis);
    const n = P.length, par = P.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (Math.hypot(P[a].tx - P[b].tx, P[a].ty - P[b].ty) < P[a].r + P[b].r + 9) par[find(a)] = find(b);
    const groups = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(P[i]); }
    const clus = [...groups.values()].filter((g) => {
      if (g.length < 3) return false;
      const xs = g.map((q) => q.tx), ys = g.map((q) => q.ty);
      return Math.max(...xs) - Math.min(...xs) <= 70 && Math.max(...ys) - Math.min(...ys) <= 70;
    });
    if (st._homeCC === undefined) {
      // the map's own country (most of its companies): a cluster there needs no country word
      const cnt = new Map();
      for (let k = 0; k < st.n; k++) { const c = S.terr[k] && S.terr[k].cc; if (c) cnt.set(c, (cnt.get(c) || 0) + 1); }
      let hc = null, hn = 0;
      for (const [c, m] of cnt) if (m > hn) { hn = m; hc = c; }
      st._homeCC = hn >= 3 ? hc : null;
    }
    const { cx, cy } = this.view;
    for (const g of clus) {
      const mem = g.filter((q) => specs[q.k]).map((q) => ({ q, s: specs[q.k] }));
      if (mem.length < 3) continue;
      mem.sort((a, b) => (b.s.dv || 0) - (a.s.dv || 0));
      const cityOf = (k) => (S.terr[k] && S.terr[k].city) || null;
      const cs = new Set(mem.map((m) => cityOf(m.q.k) || '?'));
      const ccs = new Set(mem.map((m) => (S.terr[m.q.k] && S.terr[m.q.k].cc) || '?'));
      const cc1 = ccs.size === 1 && !ccs.has('?') ? [...ccs][0] : null;
      let spread = 0;
      for (let a = 0; a < mem.length && spread < 0.012; a++) for (let b = a + 1; b < mem.length; b++) spread = Math.max(spread, ang(S.terr[mem[a].q.k].anchor, S.terr[mem[b].q.k].anchor));
      const town = mem.map((m) => cityOf(m.q.k)).find(Boolean) || '';
      const city = cs.size === 1 && !cs.has('?') ? [...cs][0] : spread < 0.0105 && town ? town : cc1 && cc1 !== st._homeCC ? CC_ZH[cc1] || '' : '';
      const top = mem.slice(0, 5);
      const short = (t) => { const a = [...String(t)]; return a.length > 13 ? a.slice(0, 12).join('') + '…' : String(t); };
      // items (each kept on one line), wrapped into ≤ 244 px lines
      const fN = font(11.5, 500), fB = font(11.5, 650);
      // (refine-names: 3D .p3-clu — letter-spacing .02em, the town 3 px apart, lines up to 260 px)
      const ls = LS(11.5), tw = (t, f) => this._tw(t, f) + ls * [...t].length;
      const items = [];
      if (city) items.push({ runs: [{ type: 'text', text: city, f: fB, ls, w: tw(city, fB) + 3 }] });
      for (const m of top) {
        const t = short(m.s.name), f = m.s.num ? fB : fN;
        const runs = [{ type: 'text', text: t, f, ls, w: tw(t, f) }];
        if (m.s.num) runs.push({ type: 'cnum', n: m.s.num, w: 15 });
        items.push({ runs });
      }
      if (mem.length > top.length) { const t = `等 ${mem.length} 家`; items.push({ runs: [{ type: 'text', text: t, f: fN, ls, w: tw(t, fN) }] }); }
      const sepW = tw('·', fN) + 6;
      const lines = [];
      let line = null;
      for (const itm of items) {
        const w = itm.runs.reduce((a, r) => a + r.w, 0);
        if (!line || line.w + sepW + w > 260) { line = { items: [], w: 0 }; lines.push(line); } else line.w += sepW;
        line.items.push({ x: line.w, runs: itm.runs, sep: line.items.length > 0 });
        line.w += w;
      }
      const w = Math.ceil(Math.max(...lines.map((l) => l.w))) + 18, h = Math.round(lines.length * 16.7) + 11;
      const k0 = mem[0].q.k;
      const [ax, ay] = LF.proj(S.terr[k0].anchor);
      const mx = g.reduce((a, q) => a + q.tx, 0) / g.length, my = g.reduce((a, q) => a + q.ty, 0) / g.length;
      // the fan itself is taken (no card on the markers)
      hard.push({ x: Math.min(...g.map((q) => q.tx - q.r)) - 3, y: Math.min(...g.map((q) => q.ty - q.r)) - 3, w: Math.max(...g.map((q) => q.tx + q.r)) - Math.min(...g.map((q) => q.tx - q.r)) + 6, h: Math.max(...g.map((q) => q.ty + q.r)) - Math.min(...g.map((q) => q.ty - q.r)) + 6 });
      const pick = this._calloutScored(st, { w, h }, ax, ay, fits, [mx - cx, my - cy], cost, 'clu:' + k0, ui);
      const text = (city ? city + ' · ' : '') + top.map((m) => short(m.s.name) + (m.s.num ? ['', '①', '②', '③'][m.s.num] || '' : '')).join(' · ') + (mem.length > top.length ? ` · 等 ${mem.length} 家` : '');
      const box = { x: ax + pick.ox - w / 2, y: ay + pick.oy - h / 2, w, h };
      placed.push(Object.assign(box, { spec: { kind: 'clu', lines, sepW, fN, tier: 'clu' }, it: { k: k0, ax, ay }, text, clu: true }));
      for (const m of mem) inClu.add(m.q.k);
    }
    return inClu;
  },

  // ============================================================================== names (3D labels.update names)
  /**
   * Every name for this frame: metro columns first, then each by priority — the 主航道's ends behind its tail / beyond
   * its head, the money unit on screen (zoom ≥ 3.5, with its suffix), the territory's own candidate points; a smaller
   * style next; on the real Earth no room → out to the nearest empty ground with a leader; else hidden.
   */
  _layoutNames(st, specs, LF, env) {
    const { placed, fits, ui, twin, inClu, chan } = env;
    const S = st.S;
    if (!LF || !S) {
      // (no sphere — the disk fallback after a layout error: each name on its label anchor, else just above / below)
      const { cx, cy, R } = this.view;
      for (const s of specs.slice().sort((a, b) => b.prio - a.prio)) {
        if (s.num && !twin.has(s.k)) continue;
        const x = cx + st.L.anchors[s.k][0] * R, y = cy + st.L.anchors[s.k][1] * R, nr = this._nameRuns(s, s.major ? 'major' : 'minor');
        for (const oy of [0, -(nr.h + 2), nr.h + 2]) {
          const r = { x: x - nr.w / 2 - 3, y: y + oy - nr.h / 2 - 2, w: nr.w + 6, h: nr.h + 4 };
          if (!fits(r) || !this._visBox(st, r, -4)) continue;
          placed.push(Object.assign(r, { spec: { kind: 'name', runs: nr.runs, w: nr.w, h: nr.h, fs: nr.fs, tier: 'norm', dim: s.dim }, it: { k: s.k, ax: x, ay: y } }));
          break;
        }
      }
      return;
    }
    const z = LF.z, real = !!st.real;
    const smallPlanet = LF.Rpx < 230;
    const Rw = LF.win;
    const inDisc = (r, m = 0.975) => {
      const R2 = (Rw * m) * (Rw * m);
      for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) if ((x - LF.cx) * (x - LF.cx) + (y - LF.cy) * (y - LF.cy) > R2) return false;
      return true;
    };
    const fa = this._freeArea();
    const E = { x0: fa.x0 + 10, y0: fa.y0 + 10, x1: fa.x1 - 10, y1: fa.y1 - 10 };
    const obsAt = (x, y, m) => ui.some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && x > q.x - m && x < q.x + q.w + m && y > q.y - m && y < q.y + q.h + m);
    const onScreen = (d) => {
      const p = LF.proj(d);
      if (p[2] < 0.25 || p[0] < E.x0 || p[0] > E.x1 || p[1] < E.y0 || p[1] > E.y1 || obsAt(p[0], p[1], 6)) return null;
      return p;
    };
    const hover = this.hoverIdx;
    const list = [];
    for (let k = 0; k < st.n; k++) {
      const s = specs[k];
      if (s.num && !twin.has(k)) continue; // its ①②③ card names it
      if (s.point && inClu.has(k) && k !== hover) continue;
      // (a twin name comes after every other name, ①②③ order — 3D appends them to the name pass with prio 0)
      list.push(s.num ? Object.assign({}, s, { num: 0, twin: true, major: true, prio: -1e5 - s.num }) : s);
    }
    list.sort((a, b) => b.prio - a.prio);
    const clsOf = (s, tiny) => (tiny ? 'tiny' : s.major || s.twin ? 'major' : 'minor');
    const done = new Set();
    const namedAt = (st._namedAt = []);
    const put = (s, c, ox, oy, r, tiny, moved, sfx) => {
      const nr = this._nameRuns(s, clsOf(s, tiny), sfx);
      const dark = !moved && this._darkAt(st, c.x + ox, c.y + oy);
      placed.push(Object.assign(r, { spec: { kind: 'name', runs: nr.runs, w: nr.w, h: nr.h, fs: nr.fs, tier: 'norm', dim: s.dim }, it: { k: s.k, ax: c.x, ay: c.y }, lead: moved && Math.hypot(ox, oy) > 6, dark, tx: c.x + ox, ty: c.y + oy }));
      done.add(s.k);
    };
    // ---- metro columns (the real Earth): names whose places share one metro stand beside it, money first
    if (real) {
      const pts = [];
      for (const s of list) {
        if (s.point || (smallPlanet && !s.major) || (s.hideName && s.k !== hover)) continue;
        if (chan && (s.k === chan.fk || s.k === chan.tk) && chan.curve) continue;
        const d = S.terr[s.k] && S.terr[s.k].anchor;
        if (!d) continue;
        const p = LF.proj(d);
        if (p[2] < SHOW_FACING) continue;
        pts.push({ s, x: p[0], y: p[1], d });
      }
      const n = pts.length, par = pts.map((_, i) => i);
      const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      // (refine-names, one rule with 3D: one metro means ≤ ~65 km on the ground too — at continent zoom 德国 and 荷兰 a few
      // px closer than 30 are two countries, each named on its own land)
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y) < 30 && ang(pts[a].d, pts[b].d) < 0.0105) par[find(a)] = find(b);
      const groups = new Map();
      for (let i = 0; i < n; i++) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(pts[i]); }
      const order = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => Math.max(...b.map((q) => q.s.prio)) - Math.max(...a.map((q) => q.s.prio)));
      for (const g of order) {
        g.sort((a, b) => b.s.dv - a.s.dv || b.s.prio - a.s.prio);
        const tiny = g.length > 4;
        const sizes = g.map((q) => this._nameRuns(q.s, clsOf(q.s, tiny)));
        const cw = Math.max(...sizes.map((zz) => zz.w)), gap = 2;
        const chH = sizes.reduce((a, zz) => a + zz.h + gap, -gap);
        const gy = g.reduce((a, q) => a + q.y, 0) / g.length;
        const gx0 = Math.min(...g.map((q) => q.x)), gx1 = Math.max(...g.map((q) => q.x));
        let best = null;
        for (const side of [1, -1]) for (const dxp of [30, 52, 80]) for (const va of [0, -0.5, 0.5, -1, 1]) {
          const left = side > 0 ? gx1 + dxp : gx0 - dxp - cw;
          let top = gy - chH / 2 + va * chH * 0.5;
          const rows = [];
          let ok = true;
          for (let i = 0; i < g.length; i++) {
            const zz = sizes[i];
            const r = { x: left - 3, y: top - 2, w: zz.w + 6, h: zz.h + 4 };
            if (!fits(r) || r.x < 6 || r.x + r.w > this.W - 6) { ok = false; break; }
            rows.push(r);
            top += zz.h + gap;
          }
          if (!ok) continue;
          const col = { x: left, y: rows[0].y, w: cw, h: rows[rows.length - 1].y + rows[rows.length - 1].h - rows[0].y };
          const sc = this._groundPen(st, col, 2.2, 0.3, 0.3) + 0.03 * dxp + Math.abs(va) * 0.4 + (side < 0 ? 0.15 : 0);
          if (!best || sc < best.sc) best = { rows, sc, left };
        }
        if (!best) continue;
        g.forEach((q, i) => {
          const r = best.rows[i], zz = sizes[i];
          const ox = best.left + zz.w / 2 - q.x, oy = r.y + r.h / 2 - q.y;
          put(q.s, { x: q.x, y: q.y }, ox, oy, r, tiny, true, '');
        });
      }
    }
    // ---- each name
    for (const s of list) {
      if (done.has(s.k)) continue;
      const k = s.k, T = S.terr[k];
      if (!T) continue;
      const minorHidden = (smallPlanet && !s.major) || (s.hideName && k !== hover);
      if (minorHidden) continue;
      const cands = [];
      const isTo = chan && chan.curve && k === chan.tk && chan.tipS, isFrom = chan && chan.curve && k === chan.fk && chan.tailS;
      // (final: the end's own facing, as 3D's chanGeo.tip·cam — an end pulled to the limb is no place for a name, so a
      // twin goes on its own land instead of beyond a head on the horizon)
      const endF = (i) => (chan.ends && chan.ends[i] ? LF.proj(chan.ends[i])[2] : 1);
      if (isTo) cands.push({ x: chan.tipS[0], y: chan.tipS[1], f: endF(1), dir: chan.tipDir });
      if (isFrom) cands.push({ x: chan.tailS[0], y: chan.tailS[1], f: endF(0), dir: chan.tailDir });
      // zoomed in (county / district level), the name stands on the unit it owns that holds the most of its money on
      // screen, and says which ('科技 · 海淀区')
      let unitC = null;
      const mo = real && !s.point && st.money ? st.money.get(k) : null;
      if (mo && z >= 3.5) {
        let bu = null, bp = null;
        for (const u of mo.units) {
          if (!(u.w > 0) || (bu && u.w <= bu.w)) continue;
          const p = onScreen(u.d);
          if (!p || !this._owns(st, LF, k, u.d)) continue;
          bu = u; bp = p;
        }
        if (bu) { unitC = { x: bp[0], y: bp[1], f: bp[2], unit: bu }; cands.push(unitC); }
      }
      const sfx0 = unitC && unitC.unit.label ? '· ' + String(unitC.unit.label).replace(/（[^）]*）$/, '') : '';
      const pp = s.point && st.ptOf ? st.ptOf.get(k) : null;
      if (s.point) {
        if (!pp || !pp.vis) continue;
        const f = dot(T.anchor, LF.v);
        cands.push({ x: pp.tx, y: pp.ty, f, pr: pp.r + 4 });
      } else if (!unitC) for (const d of T.cands && T.cands.length ? T.cands : [T.anchor]) { const p = LF.proj(d); cands.push({ x: p[0], y: p[1], f: p[2] }); }
      // (refine-names, one rule with 3D: a money unit on screen is THE place of the name — no room there → it moves out
      // from that unit with a leader, keeping '· 海淀区'; never a plain name on some other, poorer piece far away)
      let chosen = null, fallback = null;
      for (const tiny of [false, true]) {
        for (const c of cands) {
          if (c.f < SHOW_FACING) continue;
          const sfx = c === unitC ? sfx0 : '';
          const sz = this._nameRuns(s, clsOf(s, tiny), sfx);
          let offs;
          if (c.dir) {
            const ext = Math.abs(c.dir[0]) * sz.w / 2 + Math.abs(c.dir[1]) * sz.h / 2;
            const d0 = (chan.headPx || 12) + 28 + ext;
            offs = [];
            for (const a of [0, 0.6, -0.6, 1.2, -1.2]) {
              const ux = c.dir[0] * Math.cos(a) - c.dir[1] * Math.sin(a), uy = c.dir[0] * Math.sin(a) + c.dir[1] * Math.cos(a);
              offs.push([ux * d0, uy * d0]);
            }
          } else if (c.pr) {
            // beside the marker, right first like an atlas
            const pr = c.pr;
            offs = [[pr + sz.w / 2, 0], [-pr - sz.w / 2, 0], [0, -pr - sz.h / 2], [0, pr + sz.h / 2], [pr + sz.w / 2, -sz.h * 0.7], [-pr - sz.w / 2, sz.h * 0.7]];
          } else offs = [[0, 0], [0, -(sz.h + 2)], [0, sz.h + 2]];
          let endBest = null;
          for (let oi = 0; oi < offs.length; oi++) {
            const [ox, oy] = offs[oi];
            const r = { x: c.x + ox - sz.w / 2 - 3, y: c.y + oy - sz.h / 2 - 2, w: sz.w + 6, h: sz.h + 4 };
            if (!inDisc(r, c.dir ? 1.1 : 0.975)) continue;
            if (c.dir && real) {
              if (!fits(r)) continue;
              const sc = this._groundPen(st, r, 1.6, 0.3, 0.6, k) + 0.15 * oi;
              if (!endBest || sc < endBest.sc) endBest = { c, ox, oy, r, tiny, sc, moved: true, sfx };
              continue;
            }
            if (fits(r)) { chosen = { c, ox, oy, r, tiny, sfx }; break; }
            if (tiny && !c.dir && !fallback && !real && r.x >= fa.x0 + 6 && r.y >= fa.y0 + 6 && r.x + r.w <= fa.x1 - 6 && r.y + r.h <= fa.y1 - 6) {
              // only grazing other names (never a card, caption, the arc or the shell's UI)?
              let bad = false, ov = 0;
              for (const q of placed) { if (!ovl(r, q)) continue; if (!q.spec || q.spec.kind !== 'name') { bad = true; break; } ov += area2(r, q); }
              if (!bad && (env.hard.some((q) => ovl(r, q)) || ui.some((q) => ovl(r, q)))) bad = true;
              if (!bad && ov < r.w * r.h * 0.07 && c.f >= 0.55) fallback = { c, ox, oy, r, tiny, sfx };
            }
          }
          if (!chosen && endBest) chosen = endBest;
          if (chosen) break;
        }
        if (chosen) break;
      }
      // the real Earth: no room on its place → out to the nearest empty ground, with a leader (never hidden)
      if (!chosen && real && !s.point) {
        // (3D _displace: from the first own candidate — the money unit when there is one, keeping its suffix)
        const c = cands.find((q) => !q.dir && q.f >= SHOW_FACING);
        if (c) {
          let best = null;
          const sfx = c === unitC ? sfx0 : '';
          for (const tiny of [false, true]) {
            const sz = this._nameRuns(s, clsOf(s, tiny), sfx);
            for (const g of [28, 44, 64, 90, 120]) {
              for (let i = 0; i < 12; i++) {
                const a = (i * Math.PI) / 6, ux = Math.cos(a), uy = Math.sin(a);
                const ext = Math.abs(ux) * sz.w / 2 + Math.abs(uy) * sz.h / 2;
                const ox = ux * (g + ext), oy = uy * (g + ext);
                const r = { x: c.x + ox - sz.w / 2 - 3, y: c.y + oy - sz.h / 2 - 2, w: sz.w + 6, h: sz.h + 4 };
                if (!inDisc(r, 1.02) || !fits(r)) continue;
                // (neither out at sea — it would read as a sea area — nor on another territory: the nearest free spot)
                const sc = this._groundPen(st, r, 2.2, 0.3, 0.3) + 0.03 * g + Math.abs(uy) * 0.25 + (tiny ? 0.6 : 0);
                if (!best || sc < best.sc) best = { c, ox, oy, r, tiny, sc, moved: true, sfx };
              }
            }
            if (best) break;
          }
          chosen = best;
        }
      }
      if (!chosen && fallback) chosen = fallback;
      if (!chosen) continue;
      if (chosen.c === unitC && chosen.sfx) namedAt.push({ k, d: unitC.unit.d });
      put(s, chosen.c, chosen.ox, chosen.oy, chosen.r, chosen.tiny, !!chosen.moved, chosen.sfx || '');
    }
  },

  /** §26 zoomed in (> ×3): quiet names for the other big pieces of each region ('金融 · 纽约'), biggest first (3D _partNames). */
  _layoutParts(st, specs, LF, env) {
    const { placed, fits } = env;
    const S = st.S;
    const z = LF ? LF.z : 1;
    if (!st.real || !S || !LF || z <= 3 || LF.Rpx < 230) return;
    const list = [];
    for (let k = 0; k < st.n; k++) {
      const s = specs[k];
      if (!s || s.point || s.dim) continue;
      for (const pt of (S.terr[k] && S.terr[k].parts) || []) {
        if (pt.main) continue;
        if ((st._namedAt || []).some((q) => q.k === k && ang(q.d, pt.dir) < Math.max(0.0005, 1.3 * Math.sqrt(pt.area / Math.PI)))) continue;
        const dpx = 2 * Math.sqrt(pt.area / Math.PI) * LF.Rpx;
        if (dpx < 40) continue;
        if (dot(pt.dir, LF.v) < 0.5) continue;
        list.push({ k, pt, dpx, name: s.name });
      }
    }
    list.sort((a, b) => b.dpx - a.dpx);
    // (refine-names, one rule with 3D: only pieces on the free screen compete, at most 2 per region, ≤ 3 + 1.2·√zoom of
    // them — a zoomed map never reads as a wall of the same sector word)
    const fa = this._freeArea(), E = { x0: fa.x0 + 10, y0: fa.y0 + 10, x1: fa.x1 - 10, y1: fa.y1 - 10 }, per = new Map();
    const budget = Math.min(10, 3 + Math.round(1.2 * Math.sqrt(z)));
    let shown = 0;
    for (const L of list) {
      if (shown >= budget) break;
      { const [qx, qy] = LF.proj(L.pt.dir); if (qx < E.x0 || qx > E.x1 || qy < E.y0 || qy > E.y1 || (per.get(L.k) || 0) >= 2) continue; }
      per.set(L.k, (per.get(L.k) || 0) + 1);
      const city = this._zhCity(st, L.pt);
      const fN = font(10.5, 500), fC = font(10.5, 400), ls = LS(10.5);
      const runs = [{ type: 'text', text: L.name, f: fN, role: 'name', x: 0, ls, w: this._tw(L.name, fN) + ls * [...L.name].length }];
      if (city) { const t = '· ' + city; runs.push({ type: 'text', text: t, f: fC, role: 'pc', alpha: 0.8, x: runs[0].w + 4, ls, w: this._tw(t, fC) + ls * [...t].length }); }
      const w = runs.reduce((a, r) => Math.max(a, r.x + r.w), 0), h = 13;
      const [x, y] = LF.proj(L.pt.dir);
      for (const [ox, oy] of [[0, 0], [0, -(h + 2)], [0, h + 2]]) {
        const r = { x: x + ox - w / 2 - 2, y: y + oy - h / 2 - 1, w: w + 4, h: h + 2 };
        if (!fits(r)) continue;
        placed.push(Object.assign(r, { spec: { kind: 'part', runs, w, h, fs: 10.5, tier: 'part' }, it: { k: L.k, ax: x, ay: y }, dark: this._darkAt(st, x + ox, y + oy), tx: x + ox, ty: y + oy }));
        shown++;
        break;
      }
    }
  },

  /** A part's town in Chinese: the nearest sizeable city with a Chinese name (≤ ~45 km), else the HQ file's name. */
  _zhCity(st, pt) {
    if (!pt || !pt.cityLL) return pt ? pt.city : null;
    if (pt._zh !== undefined) return pt._zh || pt.city;
    const idx = st.cityIndex;
    if (!idx) return pt.city;
    const [lon, lat] = pt.cityLL, cl = Math.cos((lat * Math.PI) / 180);
    let best = null, bd = 0.42 * 0.42;
    for (const c of idx) {
      const dx = (((c.lon - lon + 540) % 360) - 180) * cl, dy = c.lat - lat, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
    pt._zh = best ? best.zh : /[㐀-鿿]/.test(pt.city || '') ? pt.city : null;
    return pt._zh || pt.city;
  },

  /** §26 the faint atlas layer for a zoomed real view (3D planet3d.js _realLive + labels.setCities): loaded once per state. */
  _loadCities(st) {
    st.cities = null;
    const r = st.real;
    if (!r || !(r.zoom >= 1.7)) return;
    const z = r.zoom, aspect = this.W / Math.max(1, this.H);
    const box = viewWindow({ lon: r.view.lon, lat: r.view.lat, scale: z }, aspect, 1.6);
    cities(box).then((cs) => {
      if (this.cur !== st || !cs.length) return;
      const ZH = new Set(['CN', 'JP', 'TW', 'KR', 'HK', 'MO']);
      const top = cs.filter((c) => c.pop >= (z < 3 ? 900 : z < 6 ? 350 : z < 30 ? 120 : 40) && (!ZH.has(c.cc) || /[㐀-鿿]/.test(c.zh || ''))).slice(0, 24);
      st.cities = top.map((c) => ({ d: dirOf(c.lon, c.lat), name: c.name, pop: c.pop }));
      st.cityBudget = z < 3 ? 5 : z < 6 ? 8 : 12;
      st.cityIndex = cs.filter((c) => /[㐀-鿿]/.test(c.zh || '') && c.pop >= 150); // Chinese names for '金融 · 纽约'
    }).catch(() => {});
  },

  /** §26 city names: the faintest layer — placed last, only where nothing else is, inside the free screen. */
  _layoutCities(st, LF, env) {
    const { placed, fits } = env;
    if (!st.cities || !LF) return;
    const fa = this._freeArea();
    const E = { x0: fa.x0 + 10, y0: fa.y0 + 10, x1: fa.x1 - 10, y1: fa.y1 - 10 };
    const f = font(10.5, 500);
    let shown = 0;
    for (const c of st.cities) {
      if (shown >= (st.cityBudget || 0)) break;
      const [x, y, fz] = LF.proj(c.d);
      if (fz < 0.35) continue;
      const tw = this._tw(c.name, f) + c.name.length * 0.63; // (letter-spacing .06em)
      const w = 3 + 4 + tw, h = 13;
      for (const left of [false, true]) {
        const ox = left ? -(w / 2 - 1.5) : w / 2 - 1.5;
        const r = { x: x + ox - w / 2 - 2, y: y - h / 2 - 2, w: w + 4, h: h + 4 };
        if (r.x < E.x0 || r.x + r.w > E.x1 || r.y < E.y0 || r.y + r.h > E.y1 || !fits(r)) continue;
        placed.push(Object.assign(r, { spec: { kind: 'city', left, f, tw, tier: 'city' }, it: { k: -1, ax: x, ay: y }, text: c.name, dark: this._darkAt(st, x + ox, y) }));
        shown++;
        break;
      }
    }
  },

  /** Draw one placed word box of the name layer (names, parts, cities, cluster callouts) at its (moved) place. */
  _drawWord(ctx, st, b, it, a) {
    const th = this.theme, spec = b.spec, kind = spec.kind;
    const dark = !!b.dark;
    const ink = dark ? th.surfInkDark : th.surfInk, halo = dark ? th.surfHaloDark : th.surfHalo;
    const cxb = b.x + b.w / 2, cyb = b.y + b.h / 2;
    if (kind === 'clu') {
      // a compact card: '纽约 · 高盛 · 摩根士丹利① · …', a hairline back to the heaviest member's place
      const ox = cxb - it.ax, oy = cyb - it.ay;
      const ex = Math.abs(ox) > 1e-3 ? (b.w / 2) / Math.abs(ox) : Infinity, ey = Math.abs(oy) > 1e-3 ? (b.h / 2) / Math.abs(oy) : Infinity;
      const f = Math.max(0, 1 - Math.min(ex, ey));
      if (f > 0) { ctx.globalAlpha = a * 0.5; ctx.strokeStyle = th.cardText; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(it.ax, it.ay); ctx.lineTo(it.ax + ox * f, it.ay + oy * f); ctx.stroke(); }
      ctx.globalAlpha = a;
      roundRect(ctx, b.x, b.y + 1, b.w, b.h, 6); ctx.fillStyle = th.name === 'night' ? 'rgba(0,0,0,0.22)' : 'rgba(31,42,68,0.08)'; ctx.fill();
      roundRect(ctx, b.x, b.y, b.w, b.h, 6); ctx.fillStyle = th.card; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = th.cardLine; ctx.stroke();
      spec.lines.forEach((ln, li) => {
        const y = b.y + 5.5 + 8.35 + li * 16.7;
        for (const itm of ln.items) {
          let x = b.x + 9 + itm.x;
          if (itm.sep) { ctx.globalAlpha = a * 0.45; ctx.font = spec.fN; ctx.fillStyle = th.cardText; ctx.fillText('·', x - spec.sepW + 3, y + 0.5); ctx.globalAlpha = a; }
          for (const r of itm.runs) {
            if (r.type === 'cnum') {
              ctx.beginPath(); ctx.arc(x + 2 + 6.5, y, 6.5, 0, Math.PI * 2); ctx.fillStyle = th.badge; ctx.fill();
              ctx.fillStyle = th.badgeText; ctx.font = numFont(9, 700); ctx.textAlign = 'center'; ctx.fillText(String(r.n), x + 8.5, y + 0.5); ctx.textAlign = 'left';
            } else { ctx.font = r.f; ctx.fillStyle = th.cardText; setLS(ctx, r.ls); ctx.fillText(r.text, x, y + 0.5); setLS(ctx, 0); }
            x += r.w;
          }
        }
      });
      return;
    }
    if (kind === 'city') {
      const dotX = spec.left ? b.x + b.w - 2 - 1.5 : b.x + 2 + 1.5;
      const tx = spec.left ? b.x + 2 : b.x + 2 + 3 + 4;
      ctx.globalAlpha = a * 0.56 * 0.8;
      ctx.fillStyle = ink;
      ctx.beginPath(); ctx.arc(dotX, cyb, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = a * 0.56;
      ctx.font = spec.f;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0.63px';
      ctx.lineWidth = dark ? 3 : 3.2; ctx.strokeStyle = halo; ctx.strokeText(b.text, tx, cyb + 0.5);
      ctx.fillStyle = ink; ctx.fillText(b.text, tx, cyb + 0.5);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      return;
    }
    // a name / a part name; a moved name keeps a leader to its place (> 24 px away, + a dot)
    if (b.lead) {
      const ox = cxb - it.ax, oy = cyb - it.ay;
      const ex = Math.abs(ox) > 1e-3 ? ((b.w - 6) / 2) / Math.abs(ox) : Infinity, ey = Math.abs(oy) > 1e-3 ? ((b.h - 4) / 2) / Math.abs(oy) : Infinity;
      const f = Math.max(0, 1 - Math.min(ex, ey));
      if (Math.hypot(ox * f, oy * f) > 24) {
        ctx.globalAlpha = a * 0.62; ctx.strokeStyle = th.surfInk; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(it.ax, it.ay); ctx.lineTo(it.ax + ox * f, it.ay + oy * f); ctx.stroke();
        ctx.globalAlpha = a * 0.7; ctx.fillStyle = th.surfInk;
        ctx.beginPath(); ctx.arc(it.ax, it.ay, 1.8, 0, Math.PI * 2); ctx.fill();
      }
    }
    const da = kind === 'part' ? 0.78 : spec.dim ? 0.38 : 1;
    this._drawRuns(ctx, spec.runs, cxb - spec.w / 2, cyb, { ink, halo, dark, card: false }, a * da);
  },

  /**
   * final (§26 amendment 5, one 主航道 drawing): 3D fx.js's marks on the ground at the route's ends — the take-off pad
   * (an ink disc 0.022·sc, 18 %, soft rim) and, once the arc has arrived, the landing ripple (two 若竹 rings growing
   * 0.02 → 0.09·sc, 0.55 → 0) plus the branch's single ring. sc = 3D's uChanScale: the real Earth's view unit, 抽象 1/zoom.
   * Each mark is a small circle in the ground's tangent plane, through LF's lens (an affine patch: exact for its size).
   */
  _chanRipples(ctx, chan, LF, now, a, headOn, brOn, zoom) {
    if (!chan || !chan.ends || !LF || !(a > 0.01)) return;
    const real = !!(chan.arcF && chan.arcF.real);
    const sc = real ? chan.arcF.ws : Math.exp(-Math.round(Math.log(Math.max(1, zoom || 1)) * 40) / 40);
    const vis = LF.vis != null ? LF.vis : 0.02;
    const th = this.theme;
    // the patch at direction d: centre and the two half-axes (screen px) of a tangent circle of radius rr (globe units)
    const patch = (d, rr) => {
      const P0 = [d[0] * (1 + 0.002 * sc), d[1] * (1 + 0.002 * sc), d[2] * (1 + 0.002 * sc)];
      const [ex, ey] = frameAt(d);
      const at = (u, w) => { const q = [P0[0] + ex[0] * u + ey[0] * w, P0[1] + ex[1] * u + ey[1] * w, P0[2] + ex[2] * u + ey[2] * w], l = Math.hypot(q[0], q[1], q[2]); return LF.proj([q[0] / l, q[1] / l, q[2] / l], l); };
      const c = LF.proj(d, 1 + 0.002 * sc);
      if (!(c[2] > vis)) return null;
      const px = at(rr, 0), mx = at(-rr, 0), py = at(0, rr), my = at(0, -rr);
      return { x: c[0], y: c[1], a: [(px[0] - mx[0]) / 2, (px[1] - mx[1]) / 2], b: [(py[0] - my[0]) / 2, (py[1] - my[1]) / 2] };
    };
    const ring = (d, r, wdt, al) => {
      if (al <= 0.01) return;
      const P = patch(d, r);
      if (!P) return;
      ctx.save();
      ctx.transform(P.a[0], P.a[1], P.b[0], P.b[1], P.x, P.y);
      ctx.beginPath();
      ctx.arc(0, 0, (r + wdt) / r, 0, Math.PI * 2);
      ctx.arc(0, 0, Math.max(0, (r - wdt) / r), 0, Math.PI * 2, true);
      ctx.fillStyle = th.rgba(th.inRGB, al.toFixed(3));
      ctx.fill();
      ctx.restore();
    };
    ctx.save();
    // take-off pad: solid inside 45 %, fading to nothing at its rim (fx.js sketch.disc)
    const pad = patch(chan.ends[0], 0.022 * sc);
    if (pad) {
      ctx.save();
      ctx.transform(pad.a[0], pad.a[1], pad.b[0], pad.b[1], pad.x, pad.y);
      const g = ctx.createRadialGradient(0, 0, 0.45, 0, 0, 1);
      const cr = th.rgba(hexRGB(th.chan), (0.18 * a).toFixed(3));
      g.addColorStop(0, cr);
      g.addColorStop(1, th.rgba(hexRGB(th.chan), 0));
      ctx.fillStyle = cr;
      ctx.beginPath(); ctx.arc(0, 0, 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.arc(0, 0, 0.45, 0, Math.PI * 2, true); ctx.fill();
      ctx.restore();
    }
    if (headOn) for (let r = 0; r < 2; r++) {
      const ph = (now / 1600 + r * 0.5) % 1;
      ring(chan.ends[1], (0.02 + ph * 0.07) * sc, 0.0035 * sc, (1 - ph) * 0.55 * a);
    }
    const b2 = chan.arcF && chan.arcF.b2;
    if (brOn && b2 && chan.branch) {
      const ph = (now / 1600 + 0.25) % 1;
      ring(b2, (0.016 + ph * 0.05) * sc, 0.003 * sc, (1 - ph) * 0.45 * a);
    }
    ctx.restore();
  },
};

/**
 * final: 3D fx.js _arcGeom's own head base and first tenth for the arc a → b (great circle bowed 0.09·ω toward front,
 * lifted peak·sin^0.85, 200 steps; head length clamp(0.16·T, min(0.07·ws, 0.22·T), 0.12·ws) in globe units) → screen
 * {base, s1} through LF, or null.
 */
function arc3(a, b, front, ws, LF) {
  const om = Math.max(1e-4, ang(a, b)), so = Math.sin(om);
  let nrm = norm(cross(a, b));
  if (dot(nrm, front) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
  const bow = 0.09 * om, peak = ws * (0.04 + 0.11 * Math.min(1, om / (1.4 * ws)));
  const N = 200, P = [], cum = [0];
  for (let i = 0; i <= N; i++) {
    const t = i / N, sb = Math.sin(Math.PI * t);
    const ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
    const d = norm([ka * a[0] + kb * b[0] + nrm[0] * bow * sb, ka * a[1] + kb * b[1] + nrm[1] * bow * sb, ka * a[2] + kb * b[2] + nrm[2] * bow * sb]);
    const r = 1 + 0.006 * ws + peak * Math.pow(sb, 0.85);
    P.push([d[0] * r, d[1] * r, d[2] * r]);
    if (i) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
  }
  const T = cum[N];
  if (!(T > 0)) return null;
  const at = (s) => {
    let j = 1;
    while (j < N && cum[j] < s) j++;
    const u = (s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
    const q = [0, 1, 2].map((m) => P[j - 1][m] + (P[j][m] - P[j - 1][m]) * u), l = Math.hypot(q[0], q[1], q[2]);
    const sp = LF.proj([q[0] / l, q[1] / l, q[2] / l], l);
    return [sp[0], sp[1]];
  };
  const headLen = clamp(T * 0.16, Math.min(0.07 * ws, T * 0.22), 0.12 * ws);
  return { base: at(T - headLen), s1: at(T / 10) };
}

/** '#22304f' → [34, 48, 79] (theme colours are hex strings). */
function hexRGB(h) {
  const s = String(h || '#000').replace('#', ''), f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(f.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
