// planet/particles.js — money as clean thin streamlines with rounded heads (anime wind-lines, §17),
// advected through the planet's wind field. Positions live in planet-local coords (radius 1). Every
// particle keeps a short position history; each frame its trail is drawn as a tapering polyline
// (faint tail → solid head) plus a slightly heavier round head. No trail canvas, no glow.
// Line colour adapts to the ground: ink lines on light bands, paper lines on dark bands.
// The window is the layout's own: F.L.inside (the round porthole of 抽象, the full-bleed square of 真实) — particles
// are born and live only there. step()'s opts: mask (Uint8Array G²: 1 = near a name / marker → faint, 2 = on it →
// hidden), sinkOf / sinkCap / nSink (fields.js: a small sink holds at most sinkCap lines; the rest fade out).

import { G } from './layout.js';
import { mulberry32 } from './util.js';

const MAX = 3200;
const H = 16; // history points per particle
const SAMPLE = 1 / 22; // seconds between history samples (trail ≈ 0.7 s of motion)
const NL = 3; // intensity levels (speed × life fade)
const LEVEL_A = [0.13, 0.42, 0.78];
const SEC_A = [1, 0.55, 0.22]; // head, middle, tail
const SEC_W = [1.3, 1.05, 0.85];

export class Particles {
  constructor() {
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.age = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.hx = new Float32Array(MAX * H);
    this.hy = new Float32Array(MAX * H);
    this.hc = new Uint8Array(MAX);
    this.hh = new Uint8Array(MAX);
    this.lvl = new Int8Array(MAX);
    this.col = new Uint8Array(MAX);
    this.n = 0;
    this.target = 1400;
    this.acc = 0;
    this.alpha = 1; // global multiplier (scenario mode dims measured wind)
    this.rnd = mulberry32(12345);
    this.buckets = [];
    for (let b = 0; b < 2 * NL; b++) this.buckets.push(new Int32Array(MAX));
    this.bucketN = new Int32Array(2 * NL);
  }

  setTarget(n) { this.target = Math.max(250, Math.min(MAX, Math.round(n))); }

  /** Re-seed every particle (e.g. on a new planet). */
  reset(F) {
    this.n = this.target;
    for (let i = 0; i < this.n; i++) {
      this._spawn(i, F);
      this.age[i] = this.rnd() * this.life[i] * 0.6;
    }
  }

  _spawn(i, F) {
    const rnd = this.rnd;
    const inside = F && F.L && F.L.inside;
    let x = 0, y = 0;
    for (let tries = 0; tries < 6; tries++) {
      if (inside) {
        // anywhere in the window (a few draws to land inside it; the square of a full-bleed map takes one)
        for (let t = 0; t < 8; t++) { x = (rnd() * 2 - 1) * 0.985; y = (rnd() * 2 - 1) * 0.985; if (inside[cellOf(x, y)]) break; }
      } else {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.975;
        x = r * Math.cos(a); y = r * Math.sin(a);
      }
      if (!F) break;
      // prefer places where money is moving; keep a little ambient everywhere
      const c = cellOf(x, y);
      if (F.sinkOf && F.sinkOf[c] >= 0 && rnd() < 0.85) continue; // not born inside a small sink's eye
      const s = F.spd[c] / Math.max(0.04, F.maxSpd);
      const src = F.div ? Math.max(0, F.div[c]) * 0.6 : 0;
      if (rnd() < (F.real ? 0.07 : 0.16) + (F.real ? 0.93 : 0.84) * Math.min(1, Math.pow(Math.min(1, s), 0.6) + src)) break;
    }
    this.x[i] = x; this.y[i] = y;
    this.age[i] = 0;
    this.life[i] = 1.8 + rnd() * 2.6;
    this.hc[i] = 0;
  }

  /**
   * Advance by dt seconds through field F = {vx, vy, spd, div, maxSpd}.
   * dimOf(cell) → 0..1 lens dim; darkOf(cell) → 1 when the ground under the cell is dark.
   */
  step(dt, F, dimOf, darkOf, opts = null) {
    if (this.n < this.target) {
      const add = Math.min(this.target - this.n, 50);
      for (let i = this.n; i < this.n + add; i++) this._spawn(i, F);
      this.n += add;
    } else if (this.n > this.target) {
      this.n = Math.max(this.target, this.n - 100);
    }
    this.acc += dt;
    let sample = false;
    if (this.acc >= SAMPLE) { sample = true; this.acc = this.acc > 3 * SAMPLE ? 0 : this.acc - SAMPLE; }
    const { vx, vy } = F;
    const ref = Math.max(0.05, F.maxSpd);
    const xs = this.x, ys = this.y, age = this.age, life = this.life;
    const hx = this.hx, hy = this.hy, hc = this.hc, hh = this.hh, lvl = this.lvl, col = this.col;
    const inside = F.L && F.L.inside;
    const mask = opts && opts.mask, sinkOf = opts && opts.sinkOf, cap = opts && opts.sinkCap;
    const nS = sinkOf && cap ? opts.nSink || 0 : 0;
    if (nS) { if (!this.sinkN || this.sinkN.length < nS) this.sinkN = new Int32Array(Math.max(16, nS * 2)); this.sinkN.fill(0, 0, nS); }
    for (let i = 0; i < this.n; i++) {
      const x = xs[i], y = ys[i];
      const fx = ((x + 1) / 2) * G - 0.5, fy = ((y + 1) / 2) * G - 0.5;
      let ix = fx | 0, iy = fy | 0;
      if (ix < 0) ix = 0; else if (ix > G - 2) ix = G - 2;
      if (iy < 0) iy = 0; else if (iy > G - 2) iy = G - 2;
      const tx = fx - ix, ty = fy - iy;
      const c = iy * G + ix;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const u = vx[c] * w00 + vx[c + 1] * w10 + vx[c + G] * w01 + vx[c + G + 1] * w11;
      const v = vy[c] * w00 + vy[c + 1] * w10 + vy[c + G] * w01 + vy[c + G + 1] * w11;
      const nx = x + u * dt, ny = y + v * dt;
      age[i] += dt;
      const sp = Math.sqrt(u * u + v * v);
      const dv = F.div ? F.div[c] : 0;
      const out = inside
        ? nx < -0.995 || ny < -0.995 || nx > 0.995 || ny > 0.995 || !inside[cellOf(nx, ny)]
        : nx * nx + ny * ny > 0.965;
      if (age[i] > life[i] || out || (sp < 0.004 && age[i] > 0.8) ||
          (dv < -0.4 && this.rnd() < -dv * dt * 0.55)) {
        this._spawn(i, F);
        lvl[i] = -1;
        continue;
      }
      if (sample) {
        const h = (hh[i] + 1) % H;
        hh[i] = h;
        hx[i * H + h] = x; hy[i * H + h] = y;
        if (hc[i] < H) hc[i]++;
      }
      xs[i] = nx; ys[i] = ny;
      const a = age[i], l = life[i];
      const lifeK = Math.min(1, a * 2.5, (l - a) * 2);
      let b = Math.floor(Math.pow(Math.min(1, sp / ref), 0.6) * lifeK * NL * 1.15);
      if (b >= NL) b = NL - 1;
      if (dimOf && dimOf(c) > 0.5) b = 0;
      // a zoomed real map: the pure ambient drift (no money moving there) is not drawn — no dust on empty land
      if (F.real && sp < 0.02) b = -1;
      // a small sink holds only so many lines: the late-comers fade out quickly (no hedgehog around a dot)
      if (nS) { const s = sinkOf[c]; if (s >= 0 && s < nS && ++this.sinkN[s] > cap[s]) { age[i] += dt * 2.6; if (b > 0) b--; } }
      // near a name or a company marker the lines step back (faint), on it they are not drawn
      if (mask) { const m = mask[c]; if (m === 2) b = -1; else if (m === 1 && b > 0) b = 0; }
      lvl[i] = hc[i] >= 3 ? b : -1;
      col[i] = darkOf ? darkOf(c) : 0;
    }
  }

  /** Draw the streamlines onto ctx (CSS-px transform applied), mapping local → screen. */
  draw(ctx, cx, cy, R, theme) {
    const n = this.n;
    const bn = this.bucketN;
    bn.fill(0);
    for (let i = 0; i < n; i++) {
      const l = this.lvl[i];
      if (l < 0) continue;
      const b = this.col[i] * NL + l;
      this.buckets[b][bn[b]++] = i;
    }
    const xs = this.x, ys = this.y, hx = this.hx, hy = this.hy, hc = this.hc, hh = this.hh;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const base = theme.windAlpha * this.alpha;
    for (let b = 0; b < 2 * NL; b++) {
      const cnt = bn[b];
      if (!cnt) continue;
      const list = this.buckets[b];
      const rgb = b >= NL ? theme.windPaper : theme.windInk;
      const lv = b % NL;
      for (let sec = 2; sec >= 0; sec--) {
        ctx.beginPath();
        for (let q = 0; q < cnt; q++) {
          const i = list[q];
          const k = hc[i];
          const s0 = sec === 0 ? 0 : sec === 1 ? Math.ceil(k / 3) : Math.ceil((2 * k) / 3);
          const s1 = sec === 0 ? Math.ceil(k / 3) : sec === 1 ? Math.ceil((2 * k) / 3) : k;
          if (s1 <= s0) continue;
          // point j: 0 = current position, j ≥ 1 = history (newest first)
          const o = i * H, h = hh[i];
          let j = s0;
          let px, py;
          if (j === 0) { px = xs[i]; py = ys[i]; } else { const m = o + ((h - (j - 1) + H) % H); px = hx[m]; py = hy[m]; }
          ctx.moveTo(cx + px * R, cy + py * R);
          for (j = s0 + 1; j <= s1; j++) {
            const m = o + ((h - (j - 1) + H) % H);
            ctx.lineTo(cx + hx[m] * R, cy + hy[m] * R);
          }
        }
        ctx.lineWidth = SEC_W[sec];
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(base * LEVEL_A[lv] * SEC_A[sec]).toFixed(3)})`;
        ctx.stroke();
      }
      if (lv === 0) continue;
      // rounded heads: a short, slightly heavier stub at the front of each line
      ctx.beginPath();
      for (let q = 0; q < cnt; q++) {
        const i = list[q];
        const m = i * H + hh[i];
        const x0 = xs[i], y0 = ys[i];
        const x1 = x0 + (hx[m] - x0) * 0.5, y1 = y0 + (hy[m] - y0) * 0.5;
        ctx.moveTo(cx + x0 * R, cy + y0 * R);
        ctx.lineTo(cx + x1 * R + 0.01, cy + y1 * R);
      }
      ctx.lineWidth = 1.9;
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(base * LEVEL_A[lv]).toFixed(3)})`;
      ctx.stroke();
    }
  }
}

function cellOf(x, y) {
  const gx = Math.min(G - 1, Math.max(0, ((x + 1) / 2) * G | 0));
  const gy = Math.min(G - 1, Math.max(0, ((y + 1) / 2) * G | 0));
  return gy * G + gx;
}
