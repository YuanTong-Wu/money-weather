// planet/streams.js — §26 amendment 5: the 2D wind in the same language as the 3D wind (planet3d/wind.js).
//
// One set of evenly spaced streamlines (Jobard–Lebret seed separation) is traced through the 2D wind field (fields.js:
// money moves from outflow toward inflow, turned into a spiral, every sink a small capped cyclone), and one to three
// tapered strokes slide along each line — thin faint tail, a rounded thicker head (anime wind-lines, §17). The same
// rules as 3D: lines exist only where the wind is real (sMin = max(3 % of the cap, 24 % of the strongest wind)), never
// start or end inside a mover's core, at most 8 run into one territory (6 into a company dot; fewer for a sink holding
// little of its money); a line that heads into an inflow territory is 若竹, one that leaves an outflow territory is
// 臙脂, ink on light ground, paper on dark ground; lines that run to a place nobody points at today stay quieter (§6).
// The field is 3D's own (fields.js coastWind): it fades a few σ off each territory's coast, so empty land far from any
// territory gets no lines and the sea keeps faint ones. Lengths are in 3D's view unit (opts.ws, local units) with the
// same pixel caps, so both renderers draw the same wind at every zoom.
//
// Interface = the old Particles (planet.js): n, target, alpha, setTarget(n), reset(st), step(dt, F, dimOf, darkOf, opts),
// draw(ctx, cx, cy, R, theme), plus ride(ctx, theme, mv) for the moving picture (planet/freecam2d.js).

import { G } from './layout.js';

// (lengths in the 3D view unit ws — the porthole radius on screen — exactly as planet3d/wind.js)
const DSEP = 0.066; // separation between lines
const DTEST = 0.5; // a line stops closer than DTEST·dsep to another
const STEP = 0.0065; // integration step
const MAXSTEP = 170;
const MINLEN = 0.11;
const STROKE = 0.24; // stroke length
const MAXLINES = 420;
const STROKE_PX = 60; // a stroke is never longer than this on screen (3D TRAIL_PX)
const NPS = 12; // points per stroke
const MAXSTROKES = 640;
const FADE = 0.55; // cross-fade when the weather changes (s)
const RETRACE = 0.38; // at most this often (s)
const PER_SINK = 8, PER_POINT = 6;
// §26 refine (critic art #5): a metro view (×30 and in: 3D ws ≲ 0.04 rad) is all cyclone — every sink sits within a few
// σ of the others and the lines hatch the whole map. There: half the lines per sink and a wider spacing (planet3d/wind.js
// has the same rule, on the same 3D view unit)
const metroCalm = (wsRad) => smoothstep(0.06, 0.025, wsRad);
const SLICE_MS = 5; // tracing budget per frame
// tail → head: four sections, thin and faint to thick and solid (3D: width 0.1…1 of 2.5 px, alpha 0.25…1)
const SEC_W = [0.4, 0.75, 1.15, 1.65];
const SEC_A = [0.3, 0.55, 0.8, 1];
const NL = 4; // alpha levels
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hexRGB = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return [79, 143, 92];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const cellOf = (x, y) => {
  const gx = Math.min(G - 1, Math.max(0, ((x + 1) / 2) * G | 0));
  const gy = Math.min(G - 1, Math.max(0, ((y + 1) / 2) * G | 0));
  return gy * G + gx;
};

export class Streams {
  constructor() {
    this.n = 0;
    this.target = 600;
    this.density = 1;
    this.alpha = 1; // global multiplier (scenario mode dims measured wind)
    this.lines = [];
    this.old = [];
    this.ver = -1;
    this.st = null;
    this.R = 0;
    this.lastTrace = -1e9;
    this.time = 0;
    this.strokes = []; // this frame's strokes: {l, s0, s1, tail, a, col} (draw / ride)
    this._pts = new Float32Array(NPS * 2);
  }

  setTarget(n) { this.target = Math.max(250, Math.round(n)); this.density = clamp(this.target / 600, 0.55, 1); }

  /** A new planet / camera rebuild: retrace on the next step (the new lines fade in). */
  reset(st) { this.old = []; this.lines = []; this.ver = -1; this.st = st || null; this.lastTrace = -1e9; this.strokes = []; this.n = 0; this.job = null; }

  /**
   * A camera rebuild at the same level (planet/freecam2d.js carryWind): the lines keep blowing, moved onto the new view
   * (to: old local → new local, or null off the view); the new trace then cross-fades over them as after a weather
   * change, so a rest never blanks the wind. → false when nothing was carried (then it is a plain reset).
   */
  carry(st, to) {
    const keep = [];
    for (const l of this.lines) {
      if (l.dying != null) continue;
      const np = l.P.length / 2, P = new Float32Array(l.P.length);
      let ok = true;
      for (let i = 0; i < np && ok; i++) { const q = to(l.P[2 * i], l.P[2 * i + 1]); if (q) { P[2 * i] = q[0]; P[2 * i + 1] = q[1]; } else ok = false; }
      if (!ok) continue;
      const cum = new Float32Array(np);
      for (let i = 1; i < np; i++) cum[i] = cum[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]);
      const len = cum[np - 1];
      if (!(len > 0)) continue;
      const s = len / Math.max(1e-9, l.len), f = to(l.fx, l.fy);
      // (the strokes keep their phase: span / speed is unchanged when both scale with the view)
      keep.push(Object.assign({}, l, { P, cum, len, ls: l.ls * s, v: l.v * s, fr: l.fr * s, fx: f ? f[0] : l.fx, fy: f ? f[1] : l.fy }));
    }
    this.reset(st);
    if (!keep.length) return false;
    this.lines = keep;
    this.ver = -2; // (not -1: the first trace on the new view cross-fades over these instead of replacing them)
    return true;
  }

  // ------------------------------------------------------------------------------------------ tracing
  _sample(F, x, y, out) {
    const fx = ((x + 1) / 2) * G - 0.5, fy = ((y + 1) / 2) * G - 0.5;
    let ix = fx | 0, iy = fy | 0;
    if (ix < 0) ix = 0; else if (ix > G - 2) ix = G - 2;
    if (iy < 0) iy = 0; else if (iy > G - 2) iy = G - 2;
    const tx = clamp(fx - ix, 0, 1), ty = clamp(fy - iy, 0, 1);
    const c = iy * G + ix, vx = F.vx, vy = F.vy;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out[0] = vx[c] * w00 + vx[c + 1] * w10 + vx[c + G] * w01 + vx[c + G + 1] * w11;
    out[1] = vy[c] * w00 + vy[c + 1] * w10 + vy[c + G] * w01 + vy[c + G + 1] * w11;
    out[2] = Math.sqrt(out[0] * out[0] + out[1] * out[1]);
    return out;
  }

  /** The whole trace at once (inspection / tests); the frame loop runs _traceG a few ms per frame instead. */
  _trace(F, R, opts) {
    const g = this._traceG(F, R, opts);
    let r;
    do { r = g.next(); } while (!r.done);
    return r.value;
  }

  /** As 3D: a calm-ish planet with a real mover gets a denser, lower-threshold retry (time-sliced: a generator). */
  *_traceG(F, R, opts) {
    const strong = (() => { const w = F.cur && F.cur.wind; if (!w) return false; for (let k = 0; k < w.length; k++) if (Math.abs(w[k]) > 0.5) return true; return false; })();
    const count = (ls) => ls.reduce((a, l) => a + l.strokes.length, 0);
    // (a metro view wants fewer lines: the denser retries start lower there too)
    const few = 110 * (1 - 0.6 * metroCalm(((opts && opts.ws) || 1) / ((opts && opts.zoom) || 1)));
    let lines = yield* this._trace1(F, R, opts, 1, 1);
    if (strong && count(lines) < few) lines = yield* this._trace1(F, R, opts, 0.82, 0.62);
    if (strong && count(lines) < few) lines = yield* this._trace1(F, R, opts, 0.7, 0.42);
    return lines;
  }

  *_trace1(F, R, opts, dsepMul, sMinMul) {
    const ws = opts && opts.ws > 0 ? opts.ws : 1;
    const L = F.L, inside = L.inside, owner = L.owner, kind = L.kind || null;
    const wind = (opts && opts.wind) || (F.cur && F.cur.wind) || new Float32Array(F.n || 0);
    const n = F.n || 0;
    const ms = Math.max(0.03 * ws, F.maxSpd || 0);
    const sMin = Math.max(0.03 * ws * sMinMul, 0.24 * ms * sMinMul);
    const metro = metroCalm(ws / ((opts && opts.zoom) || 1)); // (local units → 3D's radians: ÷ the layout's zoom)
    const dsep = (DSEP * ws * dsepMul * (1 + 0.45 * metro)) / Math.sqrt(this.density);
    const dtest = dsep * DTEST;
    const step = STEP * ws;
    // the cores of real movers (in or out): lines never start or end in a territory's middle; a small sink's eye
    // (fields.js peaks): lines curl round it and stop before they reach the dot
    const mover = new Uint8Array(Math.max(1, n));
    for (let k = 0; k < n; k++) mover[k] = Math.abs(wind[k]) > 0.45 ? 1 : 0;
    const anc = L.anchors, rEq = L.rEq;
    const peaks = (F.aux && F.aux.peaks) || [];
    const cs = 2 / G;
    const eyes = [];
    for (let i = 0; i < peaks.length; i++) {
      const q = peaks[i];
      const x = -1 + (q.gx + 0.5) * cs, y = -1 + (q.gy + 0.5) * cs;
      eyes.push({ x, y, r: Math.max(q.RC * cs * 0.9, 7 / R), reach: q.RI * cs * 1.3, sg: q.sg, i });
    }
    const inCore = (c, x, y) => {
      const o = owner[c];
      if (o >= 0 && mover[o] && (!kind || kind[o] !== 'point')) {
        const a = anc[o];
        if (a && Math.hypot(x - a[0], y - a[1]) < 0.5 * rEq[o]) return true;
      }
      for (const e of eyes) if (Math.abs(x - e.x) < e.r && Math.abs(y - e.y) < e.r && Math.hypot(x - e.x, y - e.y) < e.r) return true;
      return false;
    };
    // unclaimed land beyond every territory's pull (fields.js coastWind 'reach'): no lines there (§26 amendment 5)
    const neutral = L.neutral || null, reach = L._coast && L._coast.reach;
    const blocked = (x, y) => {
      if (x < -0.995 || y < -0.995 || x > 0.995 || y > 0.995) return true;
      const c = cellOf(x, y);
      if (inside && !inside[c]) return true;
      if (neutral && reach && neutral[c] && !reach[c]) return true;
      return false;
    };
    // occupancy grid (local coords, cell = dsep)
    const NC = Math.ceil(2 / dsep) + 2;
    const occ = new Map();
    const key = (x, y) => Math.floor((x + 1) / dsep) * NC + Math.floor((y + 1) / dsep);
    const addOcc = (x, y) => { const k = key(x, y); let l = occ.get(k); if (!l) occ.set(k, (l = [])); l.push(x, y); };
    const near = (x, y, dd) => {
      const ix = Math.floor((x + 1) / dsep), iy = Math.floor((y + 1) / dsep), d2 = dd * dd;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const l = occ.get((ix + a) * NC + (iy + b));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 2) { const dx = l[q] - x, dy = l[q + 1] - y; if (dx * dx + dy * dy < d2) return true; }
      }
      return false;
    };
    // seeds: a jittered grid over the window, strongest wind first
    const rnd = rng(4271 + ((n * 131) % 997));
    const sp = dsep * 0.62;
    const s3 = [0, 0, 0];
    const seeds = [];
    for (let y = -0.99 + sp * 0.5; y < 0.99 && seeds.length < 30000; y += sp * 0.866) {
      for (let x = -0.99 + sp * rnd(); x < 0.99; x += sp) {
        const px = x + (rnd() - 0.5) * sp * 0.4, py = y + (rnd() - 0.5) * sp * 0.4;
        if (blocked(px, py)) continue;
        this._sample(F, px, py, s3);
        if (s3[2] < sMin) continue;
        if (inCore(cellOf(px, py), px, py)) continue;
        seeds.push([px, py, s3[2]]);
      }
    }
    seeds.sort((a, b) => b[2] - a[2]);
    const sA = [0, 0, 0], sB = [0, 0, 0];
    // (a line running onto the land of a sink that already holds its lines is dropped at once — it would end there)
    let capped = null;
    const half = (x0, y0, dir) => {
      const out = [];
      let x = x0, y = y0;
      for (let i = 0; i < MAXSTEP; i++) {
        this._sample(F, x, y, sA);
        if (sA[2] < sMin * 0.6) break;
        let f = (dir * step * 0.5) / sA[2];
        const mx = x + sA[0] * f, my = y + sA[1] * f;
        this._sample(F, mx, my, sB);
        if (sB[2] < 1e-6) break;
        f = (dir * step) / sB[2];
        const nx = x + sB[0] * f, ny = y + sB[1] * f;
        if (blocked(nx, ny)) break;
        const cn = cellOf(nx, ny);
        if (capped && dir > 0) { const o = owner[cn]; if (o >= 0 && capped.has(o)) return null; }
        if (inCore(cn, nx, ny)) break;
        if (near(nx, ny, dtest)) break;
        // a curl that closes on itself (an eye's orbit): stop after one turn
        if (i > 40 && out.length >= 80) { const ox = out[out.length - 80], oy = out[out.length - 79]; if (Math.hypot(nx - ox, ny - oy) < dtest) break; }
        x = nx; y = ny;
        out.push(x, y);
      }
      return out;
    };
    // the territory (or small sink) a line runs into / comes out of: the owner there, else the nearest mover whose anchor
    // is within ~2 radii of its anchor's own piece (3D: rOf = max(partR, 26 px))
    const rOf = (k) => Math.max((opts && opts.partR && opts.partR[k]) || rEq[k] || 0.01, 26 / R);
    const sinkAt = (x, y, sign) => {
      for (const e of eyes) if (e.sg === sign && Math.hypot(x - e.x, y - e.y) < e.reach) return 'e' + e.i;
      const o = owner[cellOf(x, y)];
      if (o >= 0 && sign * wind[o] > 0.45) return 'k' + o;
      let best = null, bd = Infinity;
      for (let k = 0; k < n; k++) {
        if (!(sign * wind[k] > 0.45) || !anc[k]) continue;
        const d = Math.hypot(x - anc[k][0], y - anc[k][1]) / rOf(k);
        if (d < 2.2 && d < bd) { bd = d; best = 'k' + k; }
      }
      return best;
    };
    const kOfSink = (s) => (s && s[0] === 'k' ? +s.slice(1) : s && s[0] === 'e' ? (() => { const e = eyes[+s.slice(1)]; return e ? owner[cellOf(e.x, e.y)] : -1; })() : -1);
    const capOf = (s) => {
      const k = kOfSink(s);
      return s[0] === 'e' || (k >= 0 && kind && kind[k] === 'point') ? PER_POINT - Math.round(3 * metro) : PER_SINK - Math.round(4 * metro);
    };
    const nSink = new Map(), nSrc = new Map();
    const lines = [];
    const spot = opts && opts.spotKs && opts.spotKs.size ? opts.spotKs : null;
    capped = new Set();
    let nSeed = 0;
    for (const [sx, sy] of seeds) {
      if (lines.length >= MAXLINES) break;
      if ((++nSeed & 7) === 0) yield;
      if (near(sx, sy, dsep)) continue;
      // forward first: a line into a sink that already holds its lines is not traced any further
      const f = half(sx, sy, 1);
      if (!f) continue;
      const fx0 = f.length ? f[f.length - 2] : sx, fy0 = f.length ? f[f.length - 1] : sy;
      const skF = sinkAt(fx0, fy0, 1);
      if (skF && (nSink.get(skF) || 0) >= capOf(skF)) continue;
      const b = half(sx, sy, -1) || [];
      const nb = b.length / 2, nf = f.length / 2, np = nb + 1 + nf;
      if (np < 4) continue;
      const P = new Float32Array(np * 2);
      for (let i = 0; i < nb; i++) { const s = 2 * (nb - 1 - i); P[2 * i] = b[s]; P[2 * i + 1] = b[s + 1]; }
      P[2 * nb] = sx; P[2 * nb + 1] = sy;
      for (let i = 0; i < nf; i++) { P[2 * (nb + 1 + i)] = f[2 * i]; P[2 * (nb + 1 + i) + 1] = f[2 * i + 1]; }
      const cum = new Float32Array(np);
      for (let i = 1; i < np; i++) cum[i] = cum[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]);
      const len = cum[np - 1];
      if (len < MINLEN * ws) continue;
      const ex = P[2 * np - 2], ey = P[2 * np - 1];
      const sk = sinkAt(ex, ey, 1), so = sinkAt(P[0], P[1], -1);
      if (sk && (nSink.get(sk) || 0) >= capOf(sk)) continue;
      if (so && (nSrc.get(so) || 0) >= capOf(so)) continue;
      if (sk) { nSink.set(sk, (nSink.get(sk) || 0) + 1); if (sk[0] === 'k' && nSink.get(sk) >= capOf(sk)) capped.add(+sk.slice(1)); }
      if (so) nSrc.set(so, (nSrc.get(so) || 0) + 1);
      let avg = 0, cnt = 0;
      for (let i = 0; i < np; i += 3) { this._sample(F, P[2 * i], P[2 * i + 1], sA); avg += sA[2]; cnt++; }
      avg /= cnt || 1;
      for (let i = 0; i < np; i++) addOcc(P[2 * i], P[2 * i + 1]);
      const oE = owner[cellOf(ex, ey)], oS = owner[cellOf(P[0], P[1])];
      const tint = oE >= 0 && wind[oE] > 0.5 ? 2 : oS >= 0 && wind[oS] < -0.5 ? 3 : 0;
      const nS = clamp(Math.round(len / (STROKE * ws)), 1, 3);
      const strokes = [];
      const ph0 = rnd();
      for (let j = 0; j < nS; j++) strokes.push((ph0 + j / nS + rnd() * 0.08) % 1);
      const fk = sk ? kOfSink(sk) : so ? kOfSink(so) : -1;
      // (3D: a line fades out inside 1.5× its target's radius — never a spike converging on a city or a dot)
      const ek = sk ? kOfSink(sk) : -1, sk0 = so ? kOfSink(so) : -1;
      const eye = sk && sk[0] === 'e' ? eyes[+sk.slice(1)] : null;
      lines.push({
        P, cum, len, strokes, tint,
        ls: Math.min(STROKE * ws, len * 0.8, STROKE_PX / R),
        fx: eye ? eye.x : ek >= 0 && anc[ek] ? anc[ek][0] : sk0 >= 0 && anc[sk0] ? anc[sk0][0] : 0,
        fy: eye ? eye.y : ek >= 0 && anc[ek] ? anc[ek][1] : sk0 >= 0 && anc[sk0] ? anc[sk0][1] : 0,
        fr: Math.min(80 / R, eye ? Math.max(eye.r * 1.5, 39 / R) : ek >= 0 ? 1.5 * rOf(ek) : sk0 >= 0 ? 1.2 * rOf(sk0) : 0),
        quiet: spot && fk >= 0 && !spot.has(fk) ? 0.6 : 1,
        // speed along the line (local / s): the field's own, kept readable (3D: 0.05…0.24 of the view)
        v: clamp(avg * 1.05, 0.05 * ws, 0.24 * ws),
        a: 0.35 + 0.65 * smoothstep(sMin, ms * 0.8, avg),
        pause: 0.1 + rnd() * 0.3,
      });
    }
    return lines;
  }

  // ------------------------------------------------------------------------------------------ frame
  step(dt, F, dimOf, darkOf, opts = null) {
    const R = (opts && opts.R) || this.R || 300;
    this.R = R;
    if (F !== this.st) this.reset(F);
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const now = this.time;
    const ver = F.fieldVer;
    if (!this.job && (ver !== this.ver || Math.abs(R - (this.traceR || R)) > 0.5) && (now - this.lastTrace > RETRACE || !this.lines.length)) {
      this.job = { gen: this._traceG(F, R, opts), first: this.ver === -1 };
      this.ver = ver;
      this.traceR = R;
      this.lastTrace = now;
    }
    if (this.job) {
      // (time-sliced: a few ms a frame, never a hitch; the old lines keep blowing until the new set is ready)
      const t0 = performance.now();
      let r;
      do { r = this.job.gen.next(); } while (!r.done && performance.now() - t0 < SLICE_MS);
      if (r.done) {
        this.old = this.job.first ? [] : this.lines.map((l) => Object.assign(l, { dying: now }));
        this.lines = r.value.map((l) => Object.assign(l, { born: now }));
        this.job = null;
        this.lastTrace = now;
      }
    }
    if (this.old.length && now - this.lastTrace > FADE) this.old = [];
    const mask = opts && opts.mask;
    const out = this.strokes;
    out.length = 0;
    for (const set of [this.old, this.lines]) {
      for (const l of set) {
        if (out.length >= MAXSTROKES) break;
        const fade = l.dying != null ? 1 - smoothstep(0, FADE, now - l.dying) : smoothstep(0, FADE, now - l.born);
        if (fade <= 0.01) continue;
        const ls = l.ls, span = l.len + ls * 0.35, T = span / l.v + l.pause;
        for (const ph of l.strokes) {
          if (out.length >= MAXSTROKES) break;
          const u = ((now / T + ph) % 1) * (T / (span / l.v));
          if (u >= 1) continue;
          const head = u * span, tail = head - ls;
          const s0 = Math.max(0, tail), s1 = Math.min(l.len, head);
          if (s1 - s0 < ls * 0.06) continue;
          const env = smoothstep(0, ls * 0.35, head) * smoothstep(0, ls * 0.45, s1 - s0);
          // the head's ground: names / markers (planet.js mask: 1 faint, 2 hidden), lens dim, dark ground → paper
          const hp = this._at(l, s1);
          const c = cellOf(hp[0], hp[1]);
          let a = env * l.a * fade * l.quiet;
          if (l.fr > 0) a *= smoothstep(l.fr * 0.45, l.fr, Math.hypot(hp[0] - l.fx, hp[1] - l.fy));
          if (mask) { const m = mask[c]; if (m === 2) continue; if (m === 1) a *= 0.35; }
          if (dimOf) a *= 1 - 0.7 * dimOf(c);
          if (a < 0.02) continue;
          const col = darkOf && darkOf(c) ? 1 : l.tint;
          out.push({ l, s0, s1, tail, a, col });
        }
      }
    }
    this.n = out.length;
  }

  _at(l, s) {
    const cum = l.cum, P = l.P;
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
    const j = Math.max(1, lo);
    const f = clamp((s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]), 0, 1);
    return [P[2 * j - 2] + (P[2 * j] - P[2 * j - 2]) * f, P[2 * j - 1] + (P[2 * j + 1] - P[2 * j - 1]) * f];
  }

  /** NPS points of a stroke (local coords) into this._pts. */
  _strokePts(o) {
    const l = o.l, cum = l.cum, P = l.P, pts = this._pts;
    let j = 1;
    for (let i = 0; i < NPS; i++) {
      const sa = o.s0 + ((o.s1 - o.s0) * i) / (NPS - 1);
      while (j < cum.length - 1 && cum[j] < sa) j++;
      const f = clamp((sa - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]), 0, 1);
      pts[2 * i] = P[2 * j - 2] + (P[2 * j] - P[2 * j - 2]) * f;
      pts[2 * i + 1] = P[2 * j - 1] + (P[2 * j + 1] - P[2 * j - 1]) * f;
    }
    return pts;
  }

  /**
   * Draw this frame's strokes. map(x, y) → [sx, sy] | null (optional): local → screen; default cx + x·R. Strokes are
   * bucketed by colour × alpha level × section (tail → head), one path each.
   */
  draw(ctx, cx, cy, R, theme, map = null, k = 1) {
    const S = this.strokes;
    if (!S.length) return;
    const paths = new Array(4 * NL * 4).fill(null);
    const pt = (x, y) => (map ? map(cx + x * R, cy + y * R) : [cx + x * R, cy + y * R]);
    for (const o of S) {
      const lv = clamp(Math.ceil(o.a * NL) - 1, 0, NL - 1);
      const pts = this._strokePts(o);
      // the stroke's head fraction: a stroke still entering at the line's start has no thin tail yet
      const LS = o.l.ls, f0 = clamp((o.s0 - o.tail) / LS, 0, 1);
      const scr = [];
      for (let i = 0; i < NPS; i++) { const q = pt(pts[2 * i], pts[2 * i + 1]); if (!q) { scr.length = 0; break; } scr.push(q); }
      if (scr.length < 2) continue;
      for (let sec = 0; sec < 4; sec++) {
        // section sec covers uu ∈ [sec/4, (sec+1)/4] of the full stroke length (tail 0 → head 1)
        const u0 = sec / 4, u1 = (sec + 1) / 4;
        const a0 = clamp((u0 - f0) / Math.max(1e-6, 1 - f0), 0, 1), a1 = clamp((u1 - f0) / Math.max(1e-6, 1 - f0), 0, 1);
        if (a1 - a0 < 1e-3) continue;
        const i0 = Math.floor(a0 * (NPS - 1)), i1 = Math.ceil(a1 * (NPS - 1));
        if (i1 <= i0) continue;
        const bi = (o.col * NL + lv) * 4 + sec;
        let p = paths[bi];
        if (!p) p = paths[bi] = new Path2D();
        p.moveTo(scr[i0][0], scr[i0][1]);
        for (let i = i0 + 1; i <= i1; i++) p.lineTo(scr[i][0], scr[i][1]);
      }
    }
    const day = theme.name !== 'night';
    // (3D's windAlpha; × 0.85: a canvas line reads a touch heavier than 3D's thin ribbon at the same alpha)
    const base = (day ? 0.62 : 0.66) * 0.85 * this.alpha * k;
    const cols = [theme.windInk, theme.windPaper, this._rgb(theme, 'in'), this._rgb(theme, 'out')];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let col = 0; col < 4; col++) for (let lv = 0; lv < NL; lv++) for (let sec = 0; sec < 4; sec++) {
      const p = paths[(col * NL + lv) * 4 + sec];
      if (!p) continue;
      const rgb = cols[col];
      const a = Math.min(0.92, base * ((lv + 1) / NL) * SEC_A[sec] * (col === 1 ? 1.45 : 1));
      ctx.lineWidth = SEC_W[sec];
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
      ctx.stroke(p);
    }
    ctx.restore();
  }

  _rgb(theme, key) {
    const memo = this._cm || (this._cm = {});
    const k = theme.name + key;
    if (!memo[k]) memo[k] = hexRGB(theme[key]);
    return memo[k];
  }
}
