// planet/overlays.js — §18 overlay layers drawn on top of the planet surface (screen space):
//   主航道 ribbon arrow (§8.1), classic weather-map front lines, 2-tone Polymarket clouds (§10),
//   intel dashed 预期风 arrows (§11), scenario ripples (§9). Pure drawing helpers; Planet owns state.

import { clamp, smoothstep, easeInOutCubic, wrapText, roundRect } from './util.js';
import { font, cloudSprite, drawBolt } from './glyphs.js';

// ============================================================================ 主航道 (main channel)
/** Ribbon width of the 主航道 for a planet radius. */
export const channelWidth = (R) => clamp(R * 0.054, 12, 22);

/** Quadratic Bézier helpers. */
const qb = (p0, c, p1, t) => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
};

/**
 * §26 amendment 5: the 3D arc's tube on screen — full width (px) at the head end for a planet of radius R0 px (the ×1
 * porthole) and a route Lpx long on screen (planet3d/fx.js: R0 = 0.019 · clamp(total / ½, 0.45, 1) · rf, a short hop
 * thinner, ≥ 45 %); rf 0.62 = a second destination's branch.
 */
export const chanTube = (R0, Lpx, rf = 1) => 2 * 0.019 * R0 * rf * clamp(chanLen(R0, Lpx) / (0.5 * R0), 0.45, 1);
/** The 3D arc's own length for a route Lpx long on screen: the lift up to its peak and back down counts too. */
export const chanLen = (R0, Lpx) => Lpx + 2 * R0 * (0.04 + 0.11 * Math.min(1, Lpx / (1.4 * R0)));
/** The 3D arc's head length (px) for a route Lpx long on screen (fx.js headLen, ≥ 2.5 tubes), capped at ≤ 45 % of L. */
export const chanHead = (R0, Lpx, L = Lpx) => {
  const T = chanLen(R0, Lpx);
  return Math.min(Math.max(clamp(T * 0.16, Math.min(0.07 * R0, T * 0.22), 0.12 * R0), chanTube(R0, Lpx) * 2.5) * 1.05, L * 0.45);
};

/**
 * §26 amendment 5: a 主航道 drawn along a screen polyline (the great circle between the two money places, as 3D) —
 * the same object shape as channelCurve ({A, B, C, apex, normal, len}) plus pts and their cumulative lengths.
 */
export function channelPoly(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const c = { pts, cum, A: pts[0], B: pts[pts.length - 1], len: cum[cum.length - 1] };
  c.apex = curvePt(c, 0.5);
  const mx = (c.A[0] + c.B[0]) / 2, my = (c.A[1] + c.B[1]) / 2;
  // (C: the quadratic through A, apex, B — for readers that still sample a quadratic)
  c.C = [2 * c.apex[0] - mx, 2 * c.apex[1] - my];
  let nx = c.apex[0] - mx, ny = c.apex[1] - my, l = Math.hypot(nx, ny);
  if (l < 2) { const dx = c.B[0] - c.A[0], dy = c.B[1] - c.A[1], d = Math.hypot(dx, dy) || 1; nx = -dy / d; ny = dx / d; if (ny > 0) { nx = -nx; ny = -ny; } l = 1; }
  c.normal = [nx / l, ny / l];
  return c;
}

/** Point at parameter t (0…1) on a channel curve: by length along its polyline, else on its quadratic. */
export function curvePt(c, t) {
  if (!c.pts) return qb(c.A, c.C, c.B, t);
  const P = c.pts, cum = c.cum, s = clamp(t, 0, 1) * cum[cum.length - 1];
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
  const a = P[lo - 1], b = P[lo], u = (s - cum[lo - 1]) / Math.max(1e-9, cum[lo] - cum[lo - 1]);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/**
 * Channel geometry in screen space: from anchor A to anchor B, bowing away from the planet centre.
 * Returns {A, B, C (control), apex, normal (unit, outward side), len}.
 */
export function channelCurve(A, B, cx, cy, R) {
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
  // short hops arc more, so even neighbours get a readable, elegant sweep
  const bow = clamp(len * (len < R * 0.6 ? 0.42 : 0.26), 26, R * 0.42);
  // prefer bowing away from the planet centre; if that pushes the arc against the rim, bow inwards
  const ox = mx - cx, oy = my - cy;
  const d = ox * nx + oy * ny;
  if (Math.abs(d) < R * 0.06) { if (ny > 0) { nx = -nx; ny = -ny; } } else if (d < 0) { nx = -nx; ny = -ny; }
  const apexR = (sx) => Math.hypot(mx + sx * nx * bow - cx, my + sx * ny * bow - cy);
  if (apexR(1) > R * 0.84 && apexR(-1) < apexR(1)) { nx = -nx; ny = -ny; }
  const C = [mx + nx * bow * 2, my + ny * bow * 2]; // quadratic: apex sits at half the control offset
  const apex = qb(A, C, B, 0.5);
  return { A, B, C, apex, normal: [nx, ny], len };
}

/** Parameter t on the curve where it leaves a box around A (start) / enters a box around B (end). */
function trimT(curve, boxA, boxB, padA, padB) {
  const inBox = (p, b, pad) => b && p[0] > b.x - pad && p[0] < b.x + b.w + pad && p[1] > b.y - pad && p[1] < b.y + b.h + pad;
  let t0 = 0, t1 = 1;
  for (let i = 0; i <= 60; i++) { const t = i / 60; if (!inBox(curvePt(curve, t), boxA, padA)) { t0 = t; break; } }
  for (let i = 60; i >= 0; i--) { const t = i / 60; if (!inBox(curvePt(curve, t), boxB, padB)) { t1 = t; break; } }
  if (t1 - t0 < 0.25) { t0 = Math.min(t0, 0.15); t1 = Math.max(t1, 0.85); }
  return [t0, t1];
}

/**
 * Draw the 主航道 ribbon arrow. prog 0…1 draws it in (tail → head). Flow chevrons move tail → head.
 * boxA/boxB: label boxes of the source / target territories (the ribbon starts and stops outside them).
 */
export function drawChannel(ctx, curve, theme, R, now, prog, boxA, boxB, wCap = Infinity, tube = null) {
  if (prog <= 0.001) return null;
  const [t0, t1full] = trimT(curve, boxA, boxB, 4, 8);
  const t1 = t0 + (t1full - t0) * prog;
  const N = curve.pts ? 72 : 56;
  const pts = [];
  for (let i = 0; i <= N; i++) pts.push(curvePt(curve, t0 + ((t1 - t0) * i) / N));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  if (L < 12) return null;
  // a short hop (two places in one country: A股, Japan, 能源) keeps an arrow, never just an oversized head —
  // the ribbon thins with the whole route's length on screen (as in 3D)
  let Lfull = 0;
  for (let i = 1, q = curvePt(curve, t0); i <= 24; i++) {
    const r = curvePt(curve, t0 + ((t1full - t0) * i) / 24);
    Lfull += Math.hypot(r[0] - q[0], r[1] - q[1]);
    q = r;
  }
  // (wCap: §26 refine — a city close-up keeps a slim arrow, never a 60 px band sweeping across the frame)
  let wMax = Math.min(channelWidth(R), Math.max(6, Lfull * 0.11), wCap);
  let hl = Math.min(wMax * 2.0, L * 0.4), hw = wMax * 1.2;
  if (tube && tube.R0) {
    // §26 amendment 5 (tube = {R0, rf}): the 3D arc's proportions (planet3d/fx.js) — tube 2·0.019·R0 at the head end
    // (+ its casing), half that at the tail, a flat head 3.2× the tube wide and ~0.12·R0 long
    const R0 = tube.R0, wt = chanTube(R0, Lfull, tube.rf || 1);
    wMax = wt + 1.5;
    hw = wt * 1.6;
    hl = chanHead(R0, Lfull, L);
  }
  const tang = (i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const left = [], right = [];
  let hb = pts.length - 1;
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > L - hl) { hb = i; break; }
    const s = cum[i] / L;
    const w = wMax * (tube ? 0.5 + 0.5 * smoothstep(0, 0.62, s) : 0.3 + 0.7 * smoothstep(0, 0.32, s)) / 2;
    const [tx, ty] = tang(i);
    left.push([pts[i][0] - ty * w, pts[i][1] + tx * w]);
    right.push([pts[i][0] + ty * w, pts[i][1] - tx * w]);
  }
  const [htx, hty] = tang(hb);
  const base = pts[hb], tip = pts[pts.length - 1];
  const wb = wMax / 2;
  const poly = new Path2D();
  const all = left.concat([[base[0] - hty * wb, base[1] + htx * wb], [base[0] - hty * hw, base[1] + htx * hw], tip,
    [base[0] + hty * hw, base[1] - htx * hw], [base[0] + hty * wb, base[1] - htx * wb]], right.reverse());
  all.forEach(([x, y], i) => (i ? poly.lineTo(x, y) : poly.moveTo(x, y)));
  poly.closePath();

  ctx.save();
  ctx.lineJoin = 'round';
  if (tube && tube.R0) {
    // refine-names: 3D's tube only — a crisp ≤ 1 px drop, a ~2.6 px paper casing (uChanCaseW), the ink body; no wake
    // lane and no offset ghost band beside it
    ctx.save();
    ctx.translate(0.5, 1);
    ctx.fillStyle = theme.chanShadow;
    ctx.fill(poly);
    ctx.restore();
    ctx.lineWidth = 5.2;
    ctx.strokeStyle = theme.chanCase;
    ctx.stroke(poly);
  } else {
    // paper-cut shadow, paper casing, ink body
    ctx.save();
    ctx.translate(2, 3);
    ctx.fillStyle = theme.chanShadow;
    ctx.fill(poly);
    ctx.restore();
    // a soft cleared lane under the ribbon keeps it legible over busy wind lines
    ctx.lineWidth = Math.min(14, 4 + wMax * 0.6);
    ctx.strokeStyle = theme.chanWake;
    ctx.stroke(poly);
    ctx.lineWidth = 4;
    ctx.strokeStyle = theme.chanCase;
    ctx.stroke(poly);
  }
  ctx.fillStyle = theme.chan;
  ctx.fill(poly);
  // flow chevrons (money moving along the channel), clipped to the body
  ctx.save();
  ctx.clip(poly);
  if (tube && tube.R0) {
    // §26 amendment 5: as the 3D arc — 2–3 slow light comets running tail → head, never a zebra of chevrons
    const run = Math.max(1, L - hl * 0.9), nC = run > 0.9 * tube.R0 ? 3 : 2, cl = Math.min(46, run * 0.2);
    const at = (s) => {
      let j = 1;
      while (j < cum.length - 1 && cum[j] < s) j++;
      const u = (s - cum[j - 1]) / Math.max(1e-6, cum[j] - cum[j - 1]);
      return [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * u, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * u];
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.6, wMax * 0.42);
    const a0 = ctx.globalAlpha;
    for (let i = 0; i < nC; i++) {
      // (refine-names: each comet is ONE stroke along the arc, its light fading in from the tail — never a row of beads)
      const head = ((((now / 1000) / 3.2 + i / nC) % 1) + 1) % 1 * (run + cl);
      const s0 = clamp(head - cl, 0, run), s1 = clamp(head, 0, run);
      if (s1 - s0 < 1) continue;
      const p0 = at(s0), p1 = at(s1);
      const g = ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
      g.addColorStop(0, String(theme.chanFlow).replace(/^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,)]+).*$/, 'rgba($1,$2,$3,0)'));
      g.addColorStop(1, theme.chanFlow);
      ctx.strokeStyle = g;
      ctx.globalAlpha = a0 * 0.85 * clamp((s1 - s0) / Math.max(1, cl) * 1.4, 0, 1);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      for (let j = 1; j < cum.length && cum[j] < s1; j++) if (cum[j] > s0) ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
    }
    ctx.globalAlpha = a0;
    ctx.restore();
    ctx.restore();
    return poly;
  }
  const gap = Math.max(18, wMax * 2.2);
  const off = ((now / 1000) * 34) % gap;
  ctx.strokeStyle = theme.chanFlow;
  ctx.lineWidth = Math.max(1.4, wMax * 0.16);
  ctx.lineCap = 'round';
  ctx.beginPath();
  let j = 1;
  for (let s = off + gap * 0.6; s < L - hl * 0.9; s += gap) {
    while (j < cum.length - 1 && cum[j] < s) j++;
    const u = (s - cum[j - 1]) / Math.max(1e-6, cum[j] - cum[j - 1]);
    const p = [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * u, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * u];
    const [tx, ty] = tang(j);
    const w = wMax * (0.3 + 0.7 * smoothstep(0, 0.32, s / L)) * 0.3;
    const a = w * 0.9;
    ctx.moveTo(p[0] - tx * a - ty * w, p[1] - ty * a + tx * w);
    ctx.lineTo(p[0], p[1]);
    ctx.lineTo(p[0] - tx * a + ty * w, p[1] - ty * a - tx * w);
  }
  ctx.stroke();
  ctx.restore();
  ctx.restore();
  return poly;
}

/**
 * §26 refine — a 主航道 whose two ends sit in one place at this zoom (A股: 原材料 → 金融, both banked in 北京): one calm
 * ring on the place (paper casing, ink line, two chevrons turning slowly: money changing hands right there) and a
 * hairline to its caption box `cap` ({x, y, w, h}) — never a pile of arrowhead + rings + dots.
 */
export function drawRouteRing(ctx, x, y, r, theme, now, alpha, cap = null) {
  if (alpha <= 0.01) return;
  r = Math.max(9, r);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (cap) {
    const ex = clamp(x, cap.x, cap.x + cap.w), ey = clamp(y, cap.y, cap.y + cap.h), d = Math.hypot(ex - x, ey - y);
    if (d > r + 8) {
      const ux = (ex - x) / d, uy = (ey - y) / d;
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.inkFaint;
      ctx.beginPath(); ctx.moveTo(x + ux * (r + 4), y + uy * (r + 4)); ctx.lineTo(ex, ey); ctx.stroke();
    }
  }
  ctx.beginPath(); ctx.arc(x + 1.5, y + 2.2, r, 0, Math.PI * 2);
  ctx.lineWidth = 3; ctx.strokeStyle = theme.chanShadow; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 5.5; ctx.strokeStyle = theme.chanCase; ctx.stroke();
  ctx.lineWidth = 2.4; ctx.strokeStyle = theme.chan; ctx.stroke();
  // two chevrons riding the ring (clockwise), slow
  const a0 = (now / 1000) * 0.9;
  ctx.fillStyle = theme.chan;
  for (const a of [a0, a0 + Math.PI]) {
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r, tx = -Math.sin(a), ty = Math.cos(a), s = 4.2;
    ctx.beginPath();
    ctx.moveTo(px + tx * s * 1.2, py + ty * s * 1.2);
    ctx.lineTo(px - tx * s * 0.6 + Math.cos(a) * s, py - ty * s * 0.6 + Math.sin(a) * s);
    ctx.lineTo(px - tx * s * 0.6 - Math.cos(a) * s, py - ty * s * 0.6 - Math.sin(a) * s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fillStyle = theme.chan; ctx.fill();
  ctx.restore();
}

/** Rich one-liner: text inside 【】 is drawn bold. Returns runs [{text, bold, w}]. */
function richRuns(measure, text, fs) {
  const runs = [];
  const re = /【([^】]*)】/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  for (const r of runs) r.w = measure(r.text, font(fs, r.bold ? 700 : 600)); // (refine-names: 3D .p3-cin is 13 px / 600)
  return runs;
}

/** Size the channel caption: a tag "主航道" + the sentence (≤ 2 lines). */
export function channelCaptionSpec(measure, ctx, say) {
  const fs = 13; // (refine-names: 3D's caption — 13 px / 600, padding 6 11 7 8, a 1.5 px ink border)
  const text = String(say || '').replace(/^(今天的)?主航道[：:]\s*/, '');
  const tagW = measure('主航道', font(11, 700)) + 12;
  const runs = richRuns(measure, text, fs);
  const total = runs.reduce((a, r) => a + r.w, 0);
  // (final, one picture with 3D's .p3-chan card: max-width 300 px border-box, the words wrapping greedily inside it — a
  // wrapped card is the full 300 px, as the CSS box is)
  const maxW = 300;
  if (total + tagW + 30 <= maxW) return { text, runs, tagW, lines: null, w: tagW + total + 30, h: 32, fs };
  ctx.font = font(fs, 600);
  const plain = text.replace(/[【】]/g, '');
  const lines = wrapText(ctx, plain, maxW - tagW - 30, 3);
  return { text, runs, tagW, lines, w: maxW, h: 16 + lines.length * 19, fs };
}

export function drawChannelCaption(ctx, spec, x, y, theme, alpha, at = null) {
  // light paper card, ink text, a 1.5 px ink border (3D .p3-chan): the arrow, not this box, is the heaviest element on
  // the planet. at = [x, y]: refine-names — the point on the arc it hangs from (3D: a 1.3 px leader and a 3 px dot)
  const ink = theme.chanInk || theme.cardText;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (at) {
    const ox = x + spec.w / 2 - at[0], oy = y + spec.h / 2 - at[1];
    const ex = Math.abs(ox) > 1e-3 ? (spec.w / 2) / Math.abs(ox) : Infinity, ey = Math.abs(oy) > 1e-3 ? (spec.h / 2) / Math.abs(oy) : Infinity;
    const f = Math.max(0, 1 - Math.min(ex, ey));
    if (f > 0) {
      ctx.globalAlpha = alpha * 0.7; ctx.lineWidth = 1.3; ctx.lineCap = 'round'; ctx.strokeStyle = ink;
      ctx.beginPath(); ctx.moveTo(at[0], at[1]); ctx.lineTo(at[0] + ox * f, at[1] + oy * f); ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    ctx.beginPath(); ctx.arc(at[0], at[1], 3, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = theme.card; ctx.stroke();
    ctx.fillStyle = ink; ctx.fill();
  }
  roundRect(ctx, x, y + 1, spec.w, spec.h, 7);
  ctx.fillStyle = theme.cardShadow;
  ctx.fill();
  roundRect(ctx, x, y, spec.w, spec.h, 7);
  ctx.fillStyle = theme.card;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ink;
  ctx.stroke();
  // tag: navy outline, no fill
  const tx = x + 9, tyc = y + (spec.lines ? 17 : spec.h / 2);
  roundRect(ctx, tx + 0.65, tyc - 8.35, spec.tagW - 1.3, 16.7, 4);
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = ink;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.font = font(11, 700);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('主航道', tx + 6, tyc + 0.5);
  let px = tx + spec.tagW + 8;
  if (!spec.lines) {
    for (const r of spec.runs) {
      ctx.font = font(spec.fs, r.bold ? 700 : 600);
      ctx.fillText(r.text, px, tyc + 0.5);
      px += r.w;
    }
  } else {
    ctx.font = font(spec.fs, 600);
    spec.lines.forEach((l, i) => ctx.fillText(l, px, y + 17 + i * 19));
  }
  ctx.restore();
}

// ============================================================================ fronts
/**
 * Front line geometry for territory k (local coords): one of its outlines pulled towards that outline's own middle,
 * minus the stretch that hugs the planet rim (an open line, like a weather-map front).
 * §26 refine: a real territory has many parts (Palm Beach + Dallas + …) — the front is built from the part that holds
 * the label anchor (else the nearest part big enough to carry it: ≥ 34 px on screen, R = px per local unit) and
 * shrinks toward THAT part's centroid; it used to shrink the biggest-vertex ring toward the anchor of another part,
 * which floated AI 电力基建's front in the Gulf of Mexico. No part big enough → no front (the label says it).
 */
export function frontGeometry(L, k, win = 1, R = 0) {
  let poly = L.polys[k];
  const [ax, ay] = L.anchors[k];
  if (L.exts && L.exts[k] && L.exts[k].length) {
    let pick = null, pd = Infinity;
    for (const r of L.exts[k]) {
      if (!r || r.length < 6) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (R > 0 && Math.max(x1 - x0, y1 - y0) * R < 34) continue;
      if (ringHas(r, ax, ay)) { pick = r; break; }
      const d = Math.hypot((x0 + x1) / 2 - ax, (y0 + y1) / 2 - ay);
      if (d < pd) { pd = d; pick = r; }
    }
    poly = pick;
  }
  if (!poly || poly.length < 6) return null;
  const [gx, gy] = ringCentroid(poly);
  const shrink = 0.74;
  const pts = poly.map(([x, y]) => [gx + (x - gx) * shrink, gy + (y - gy) * shrink]);
  // (the rim: the porthole's, or a full-bleed real map's — the globe's limb and the grid square)
  const ok = poly.map(([x, y]) => Math.hypot(x, y) < 0.94 * win && Math.abs(x) < 0.97 && Math.abs(y) < 0.97);
  const n = pts.length;
  let run = [];
  if (ok.every(Boolean)) {
    // closed: keep 62% of the ring, centred on the side that faces the planet centre
    let best = 0, bd = Infinity;
    pts.forEach(([x, y], i) => { const d = Math.hypot(x, y); if (d < bd) { bd = d; best = i; } });
    const half = Math.floor(n * 0.31);
    for (let i = -half; i <= half; i++) run.push(pts[(best + i + n) % n]);
  } else {
    // longest circular run of interior points
    let start = ok.findIndex((v) => !v);
    let bestS = 0, bestL = 0, curS = -1, curL = 0;
    for (let s = 1; s <= n; s++) {
      const i = (start + s) % n;
      if (ok[i]) { if (curS < 0) curS = i; curL++; if (curL > bestL) { bestL = curL; bestS = curS; } } else { curS = -1; curL = 0; }
    }
    for (let s = 0; s < bestL; s++) run.push(pts[(bestS + s) % n]);
    // trim the ends a little so the line does not touch the rim
    const cut = Math.floor(run.length * 0.08);
    run = run.slice(cut, run.length - cut);
  }
  if (run.length < 4) return null;
  return { pts: run, anchor: [gx, gy] };
}

/** Even-odd point-in-ring test (local coords). */
function ringHas(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Area centroid of a ring (local coords); the vertex mean for a degenerate one. */
function ringCentroid(r) {
  let a = 0, cx = 0, cy = 0, mx = 0, my = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j], f = xj * yi - xi * yj;
    a += f; cx += (xj + xi) * f; cy += (yj + yi) * f; mx += xi; my += yi;
  }
  if (Math.abs(a) < 1e-12) return [mx / r.length, my / r.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Classic weather-map front: inflow just started → semicircles pointing into the territory (warm
 * front shape, 若竹 green); outflow → triangles pointing outward (cold front shape, 臙脂).
 */
export function drawFront(ctx, geo, dir, cx, cy, R, theme, now, alpha, active) {
  if (!geo || alpha <= 0.01) return;
  const P = geo.pts.map(([x, y]) => [cx + x * R, cy + y * R]);
  const A = [cx + geo.anchor[0] * R, cy + geo.anchor[1] * R];
  const col = dir > 0 ? theme.in : theme.out;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  // §26 amendment 5: the 3D front (planet3d/fx.js) — a 2.2 px line on a 4.6 px halo, a symbol every 22 px (semicircle
  // r 5 / triangle 6 px) on the outward side for both kinds
  ctx.globalAlpha = alpha * 0.7;
  ctx.lineWidth = 4.6;
  ctx.strokeStyle = theme.surfHalo;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = col;
  ctx.stroke();
  // symbols every `gap` px along the line
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const Lt = cum[cum.length - 1];
  const gap = 22, sz = 5, th = 6;
  const off = active ? ((now / 1000) * 6) % gap : gap * 0.5;
  ctx.fillStyle = col;
  let j = 1;
  for (let s = off; s < Lt - sz; s += gap) {
    if (s < sz) continue;
    while (j < cum.length - 1 && cum[j] < s) j++;
    const u = (s - cum[j - 1]) / Math.max(1e-6, cum[j] - cum[j - 1]);
    const p = [P[j - 1][0] + (P[j][0] - P[j - 1][0]) * u, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * u];
    const tl = Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]) || 1;
    const tx = (P[j][0] - P[j - 1][0]) / tl, ty = (P[j][1] - P[j - 1][1]) / tl;
    let nx = -ty, ny = tx;
    const toA = (A[0] - p[0]) * nx + (A[1] - p[1]) * ny;
    // outward: away from the territory's middle (as 3D)
    if (toA > 0) { nx = -nx; ny = -ny; }
    ctx.beginPath();
    if (dir > 0) {
      const ang = Math.atan2(ny, nx);
      ctx.arc(p[0], p[1], sz, ang - Math.PI / 2, ang + Math.PI / 2);
    } else {
      const hw = th * 0.62;
      ctx.moveTo(p[0] - tx * hw, p[1] - ty * hw);
      ctx.lineTo(p[0] + nx * th, p[1] + ny * th);
      ctx.lineTo(p[0] + tx * hw, p[1] + ty * hw);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ============================================================================ Polymarket clouds
/**
 * §26 amendment 5: the 3D cloud (planet3d/fx.js) — an opaque 2-tone cel cloud with a crisp ink hull, its base on its
 * ground spot (bx, by), and a flat hard-edged round shadow on the ground nudged away from the light (upper left);
 * strength changes the size (w), never the opacity. kind 'sky' | 'storm'. alpha: the 3D fade (0.16 under a label).
 */
const CEL = {
  day: { sky: { line: '#5b6680', shade: '#dbe0e6' }, storm: { base: '#8d96a7', line: '#2a3450', shade: '#6c768a' } },
  night: { sky: { line: '#0b1020', shade: '#c3c5cb' }, storm: { base: '#8790ab', line: '#090d1a', shade: '#6b7491' } },
};
const celThemes = new Map();
function celTheme(theme) {
  let t = celThemes.get(theme);
  if (!t) {
    const c = CEL[theme.name === 'night' ? 'night' : 'day'];
    t = { name: theme.name + '·cel', skyCloud: Object.assign({}, theme.skyCloud, c.sky), stormCloud: Object.assign({}, theme.stormCloud, c.storm) };
    celThemes.set(theme, t);
  }
  return t;
}
/** The 3D cumulus (planet3d props: a tall middle puff on a flat base, ~0.75 as tall as wide), 2-tone + ink hull. */
const cumuli = new Map();
function cumulusSprite(theme, w, dpr) {
  const wq = Math.max(12, Math.round(w / 4) * 4);
  const key = theme.name + '|' + wq + '|' + dpr;
  let c = cumuli.get(key);
  if (c) return c;
  const day = theme.name !== 'night';
  const lit = theme.skyCloud.base, shade = day ? '#dbe0e6' : '#c3c5cb', line = day ? '#5b6680' : '#0b1020';
  const lw = Math.max(1.4, wq / 26), pad = lw + 2, h = wq * 0.76;
  c = document.createElement('canvas');
  c.width = Math.ceil((wq + 2 * pad) * dpr); c.height = Math.ceil((h + 2 * pad) * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x0 = pad, base = pad + h;
  const path = (dx = 0, dy = 0) => {
    g.beginPath();
    const rb = wq * 0.11, bt = base - wq * 0.3; // (tall enough that every puff overlaps it: no hole)
    g.moveTo(x0 + rb + dx, bt + dy);
    g.lineTo(x0 + wq - rb + dx, bt + dy);
    g.arc(x0 + wq - rb + dx, base - rb + dy, rb, -Math.PI / 2, Math.PI / 2, false);
    g.lineTo(x0 + rb + dx, base + dy);
    g.arc(x0 + rb + dx, base - rb + dy, rb, Math.PI / 2, Math.PI * 1.5, false);
    g.closePath();
    for (const [u, v, r] of [[0.21, 0.2, 0.17], [0.39, 0.42, 0.2], [0.58, 0.5, 0.245], [0.8, 0.24, 0.17]]) {
      g.moveTo(x0 + u * wq + r * wq + dx, base - v * wq + dy);
      g.arc(x0 + u * wq + dx, base - v * wq + dy, r * wq, 0, Math.PI * 2, false);
    }
  };
  path();
  g.lineJoin = 'round';
  g.lineWidth = lw * 2;
  g.strokeStyle = line;
  g.stroke();
  g.fillStyle = shade;
  g.fill();
  g.save();
  path();
  g.clip();
  path(-wq * 0.04, -wq * 0.09);
  g.fillStyle = lit;
  g.fill();
  g.restore();
  c.cssW = wq + 2 * pad; c.cssH = h + 2 * pad; c.pad = pad;
  if (cumuli.size > 120) cumuli.delete(cumuli.keys().next().value);
  cumuli.set(key, c);
  return c;
}
export function drawCelCloud(ctx, theme, dpr, kind, bx, by, w, seed, alpha, shadow = true) {
  if (alpha <= 0.01) return null;
  const spr = kind === 'sky' ? cumulusSprite(theme, w, dpr) : cloudSprite(celTheme(theme), kind, w, dpr, seed);
  const x = bx - spr.cssW / 2, y = by - spr.cssH + (spr.pad || 2);
  ctx.save();
  if (shadow && alpha >= 0.5) {
    // (3D castShadow: radius 0.3 × size, ≤ 0.25 × size away from the light; a soft tint of the ground's own shade)
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(bx + w * 0.12, by + w * 0.13, w * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = theme.name === 'night' ? 'rgba(12,10,6,0.14)' : 'rgba(80,58,24,0.08)';
    ctx.fill();
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(spr, x, y, spr.cssW, spr.cssH);
  ctx.restore();
  return { x, y, w: spr.cssW, h: spr.cssH };
}

/** High-altitude 2-tone cloud above a territory; brightness/size = this week's probability swing. */
export function drawSkyCloud(ctx, theme, dpr, x, y, w, strength, seed, now, alpha) {
  const spr = cloudSprite(theme, 'sky', w, dpr, seed);
  const drift = Math.sin(now / 4200 + seed) * 4;
  ctx.save();
  ctx.globalAlpha = alpha * (0.5 + 0.45 * clamp(strength, 0, 1));
  ctx.drawImage(spr, x - spr.cssW / 2 + drift, y - spr.cssH / 2, spr.cssW, spr.cssH);
  ctx.restore();
  return { x: x - spr.cssW / 2 + drift, y: y - spr.cssH / 2, w: spr.cssW, h: spr.cssH };
}

export function drawStormCloud(ctx, theme, dpr, x, y, w, seed, now, alpha) {
  const spr = cloudSprite(theme, 'storm', w, dpr, seed);
  const drift = Math.sin(now / 3100 + seed * 1.7) * 3;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(spr, x - spr.cssW / 2 + drift, y - spr.cssH / 2, spr.cssW, spr.cssH);
  ctx.restore();
  return { x: x - spr.cssW / 2 + drift, y: y - spr.cssH / 2, w: spr.cssW, h: spr.cssH };
}

// ============================================================================ intel 预期风
/**
 * Dashed "expected wind" arrow for one intel impact: dir > 0 curls into the territory (money expected
 * to arrive), dir < 0 curls out of it. Returns the tail point (for the tag).
 */
export function intelArrowGeom(A, cx, cy, R, strength, rot = 0.52) {
  let ux = A[0] - cx, uy = A[1] - cy;
  const ul = Math.hypot(ux, uy);
  if (ul < R * 0.12) { ux = 0.7; uy = -0.7; } else { ux /= ul; uy /= ul; }
  const len = clamp(R * 0.3, 54, 130) * (0.75 + 0.12 * clamp(strength, 1, 3));
  // outward direction rotated by `rot` for a curl
  const vx = ux * Math.cos(rot) - uy * Math.sin(rot), vy = ux * Math.sin(rot) + uy * Math.cos(rot);
  const far = [A[0] + vx * len, A[1] + vy * len];
  const near = [A[0] + vx * 16, A[1] + vy * 16];
  const bend = rot >= 0 ? 1 : -1;
  const ctrl = [(far[0] + near[0]) / 2 - vy * len * 0.22 * bend, (far[1] + near[1]) / 2 + vx * len * 0.22 * bend];
  return { far, near, ctrl };
}

export function drawIntelArrow(ctx, geo, dir, fresh, theme, now) {
  const { far, near, ctrl } = geo;
  const [p0, p1] = dir > 0 ? [far, near] : [near, far];
  const col = dir > 0 ? theme.in : theme.out;
  ctx.save();
  ctx.globalAlpha *= 0.35 + 0.6 * fresh;
  ctx.lineCap = 'round';
  ctx.setLineDash([7, 5]);
  ctx.lineDashOffset = -((now / 1000) * 14) % 12;
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.quadraticCurveTo(ctrl[0], ctrl[1], p1[0], p1[1]);
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = theme.surfHalo;
  ctx.stroke();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.setLineDash([]);
  // arrowhead
  const hx = p1[0] - ctrl[0], hy = p1[1] - ctrl[1], hl = Math.hypot(hx, hy) || 1;
  const tx = hx / hl, ty = hy / hl, s = 7;
  ctx.beginPath();
  ctx.moveTo(p1[0] + tx * 2, p1[1] + ty * 2);
  ctx.lineTo(p1[0] - tx * s * 1.5 - ty * s, p1[1] - ty * s * 1.5 + tx * s);
  ctx.lineTo(p1[0] - tx * s * 1.5 + ty * s, p1[1] - ty * s * 1.5 - tx * s);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();
}

/**
 * §26 amendment 5: the 3D 预期风 arc (planet3d/fx.js) — from the place A out toward open sea (away from the middle of
 * the visible map), turned 0.55 rad, length (0.12 + 0.05·strength) view units; same {far, near, ctrl} as above.
 */
export function intelArcGeom(A, cx, cy, wsPx, strength) {
  // (east, north) frame: screen y is down
  let ux = A[0] - cx, uy = -(A[1] - cy);
  const ul = Math.hypot(ux, uy);
  if (ul < 1e-3 * Math.max(1, wsPx)) { ux = 0.7; uy = -0.7; } else { ux /= ul; uy /= ul; }
  const rot = 0.55, len = (0.12 + 0.05 * clamp(strength || 1, 1, 3)) * wsPx;
  const rx = ux * Math.cos(rot) - uy * Math.sin(rot), ry = ux * Math.sin(rot) + uy * Math.cos(rot);
  const far = [A[0] + rx * len, A[1] - ry * len];
  const near = [A[0] + rx * 0.025 * wsPx, A[1] - ry * 0.025 * wsPx];
  const ctrl = [A[0] + ux * len * 0.75, A[1] - uy * len * 0.75];
  return { far, near, ctrl };
}

/** An intel title for the map (planet3d/fx.js shortTitle): no trailing bracket aside, cut at a comma (≤ 16). */
export function shortTitle(title) {
  let t = String(title || '').replace(/[（(].*$/, '').trim();
  if (t.length > 16) { const c = t.lastIndexOf('，', 15); t = (c > 6 ? t.slice(0, c) : t.slice(0, 15)) + '…'; }
  return t || String(title || '').slice(0, 15);
}

/** The quiet 3D intel tag: a small ⚡ (+ its words in halo text when it may talk), centred at (x, y). */
export function intelBoltSpec(measure, title, talk) {
  const text = talk ? shortTitle(title) || '情报' : '';
  const f = font(10.5, 550);
  return { text, f, w: 9 + (text ? 3 + measure(text, f) : 0), h: 14 };
}
export function drawIntelBolt(ctx, spec, x, y, theme, alpha) {
  const bx = x - spec.w / 2, by = y - spec.h / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  drawBolt(ctx, bx + 4.5, by + 1, 12, theme);
  if (spec.text) {
    ctx.font = spec.f;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.surfHalo;
    ctx.strokeText(spec.text, bx + 12, by + spec.h / 2 + 0.5);
    ctx.fillStyle = theme.surfInkSoft;
    ctx.fillText(spec.text, bx + 12, by + spec.h / 2 + 0.5);
  }
  ctx.restore();
  return { x: bx, y: by, w: spec.w, h: spec.h };
}

/** Tag text + size for an intel title. */
export function intelTagSpec(measure, title) {
  const t = String(title || '').trim();
  const short = t.length > 12 ? t.slice(0, 11) + '…' : t;
  const text = short ? '情报 · ' + short : '你投喂的情报';
  const f = font(11.5, 600);
  return { text, f, w: measure(text, f) + 30, h: 21 };
}

/** Small paper tag "⚡ 情报 · 标题" centred at (x, y) (always says it is the owner's intel). */
export function drawIntelTag(ctx, spec, x, y, theme, alpha) {
  const { text, f, w, h } = spec;
  const bx = x - w / 2, by = y - h / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, bx, by, w, h, 5);
  ctx.fillStyle = theme.card;
  ctx.fill();
  ctx.setLineDash([3, 2]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.cardLine;
  ctx.stroke();
  ctx.setLineDash([]);
  drawBolt(ctx, bx + 11, by + 3.5, 14, theme);
  ctx.fillStyle = theme.cardText;
  ctx.font = f;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, bx + 21, by + h / 2 + 0.5);
  ctx.restore();
  return { x: bx, y: by, w, h };
}

// ============================================================================ scenario ripples
/** Thin rings expanding from an epicentre (2 in flight, gentle). */
export function drawRipple(ctx, x, y, maxR, theme, now, phase0, alpha) {
  ctx.save();
  for (let j = 0; j < 2; j++) {
    const ph = ((now / 3400 + phase0 + j * 0.5) % 1);
    const e = easeInOutCubic(ph);
    const r = 10 + e * maxR;
    const a = (1 - ph) * 0.55 * alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = theme.rgba(theme.inkRGB, a);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = theme.ink;
  ctx.globalAlpha = alpha;
  ctx.fill();
  ctx.restore();
}
