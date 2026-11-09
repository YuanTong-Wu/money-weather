// planet3d/wind.js — money as anime wind-lines over a small Earth (§4 layer 3, §17, §22, §25).
//
// A set of evenly spaced streamlines (Jobard–Lebret seed separation, on the sphere) is traced through the
// world's wind field (money moves from outflow landmasses toward inflow ones — across the open sea), and one or
// two tapered strokes slide along each line — thin tail, thick front, round cap — like the wind lines of an
// anime background. Lines exist only where the wind is real (calm water stays calm), never start inside an
// inflow landmass and end at its core instead of converging to a point. Ink on light ground, paper on dark
// ground; a line that heads into an inflow landmass (wind > 0.5) is 若竹, one that leaves an outflow landmass
// (wind < −0.5) is 臙脂. Retraced (with a short cross-fade) when the weather changes.

import { THREE, WIND_VS, WIND_FS } from './core.js';

const DSEP = 0.066; // separation between lines (rad)
const DTEST = 0.5; // a line stops when it comes closer than DTEST·DSEP to another
const STEP = 0.0065; // integration step (rad)
const MAXSTEP = 170;
const MINLEN = 0.11;
const MAXLINES = 420;
const STROKE = 0.24; // stroke length (rad)
const NPS = 18; // ribbon points per stroke
const CAP = 12;
const MAXSTROKES = 640;
const VPS = NPS * 2 + 1 + CAP + 1;
const IPS = (NPS - 1) * 6 + CAP * 3;
const ALT = 0.009;
const FADE = 0.55;
// §17 calm, not a hedgehog: at most this many lines run into (or out of) one landmass / one company
const PER_SINK = 8, PER_POINT = 6;
const TRAIL_PX = 60; // a stroke is never longer than this on screen
// §26 refine (critic art #5, one rule with planet/streams.js): a metro view (×30 and in, ws ≲ 0.04 rad) is all cyclone —
// half the lines per sink and a wider spacing there, so the lines no longer hatch the whole map
const metroCalm = (ws) => smoothstep(0.06, 0.025, ws);

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
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
/** The wind grid's cell for unit vector (x, y, z) (as World.sampleWind maps it). */
function cellOfDir(G, x, y, z) {
  let lon = Math.atan2(x, z) - G.lonC;
  lon = lon - 2 * Math.PI * Math.floor((lon + Math.PI) / (2 * Math.PI));
  const lat = Math.asin(clamp(y, -1, 1));
  let i = Math.round(((lon - G.lon0) / G.dLon) * G.W - 0.5), j = Math.round(((G.lat1 - lat) / G.dLat) * G.H - 0.5);
  if (G.wrap) i = ((i % G.W) + G.W) % G.W; else i = clamp(i, 0, G.W - 1);
  j = clamp(j, 0, G.H - 1);
  return j * G.W + i;
}
/** Cells some territory's pull reaches (or its own land), once per kernel set: lines stop on unclaimed land beyond. */
function reachMask(w) {
  const K = w._K, G = w.gw;
  if (!K || !G) return null;
  if (w._reachOf === K && w._reach) return w._reach;
  const WN = G.W * G.H, m = new Uint8Array(WN);
  for (let c = 0; c < WN; c++) if (w.ownLo && w.ownLo[c] >= 0) m[c] = 1;
  for (const a of K) if (a) for (let c = 0; c < WN; c++) if (!m[c] && (a[3 * c] !== 0 || a[3 * c + 1] !== 0 || a[3 * c + 2] !== 0)) m[c] = 1;
  w._reachOf = K; w._reach = m;
  return m;
}
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Wind {
  constructor(ctx, world) {
    this.ctx = ctx;
    this.w = world;
    this.n = 0;
    this.target = 1;
    this.density = 1;
    this.lines = [];
    this.old = [];
    this.ver = -1;
    this.lastTrace = -1e9;
    this.time = 0;
    this.pos = new Float32Array(MAXSTROKES * VPS * 3);
    this.aA = new Float32Array(MAXSTROKES * VPS);
    this.aC = new Float32Array(MAXSTROKES * VPS);
    const idx = new Uint32Array(MAXSTROKES * IPS);
    let q = 0;
    for (let s = 0; s < MAXSTROKES; s++) {
      const b = s * VPS;
      for (let j = 0; j < NPS - 1; j++) {
        const a0 = b + j * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
        idx[q++] = a0; idx[q++] = b0; idx[q++] = a1;
        idx[q++] = a1; idx[q++] = b0; idx[q++] = b1;
      }
      const c = b + NPS * 2;
      for (let j = 0; j < CAP; j++) { idx[q++] = c; idx[q++] = c + 1 + j; idx[q++] = c + 2 + j; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.aA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aC', new THREE.BufferAttribute(this.aC, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
    const U = ctx.U;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: WIND_VS, fragmentShader: WIND_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uInkC: U.uWindInk, uPaperC: U.uWindPaper, uInC: U.uWindIn, uOutC: U.uWindOut, uAlpha: { value: 1 } },
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._tmp = new Float32Array(NPS * 3);
    this._pts = new Float32Array(NPS * 3);
  }

  setTarget(n) { this.target = n; this.density = clamp(n / 600, 0.55, 1); }
  reset() { this.lines = []; this.old = []; this.ver = -1; this.lastTrace = -1e9; }

  // ------------------------------------------------------------------------------------------ tracing
  _trace() {
    const w = this.w;
    let strong = false;
    for (let k = 0; k < w.n; k++) if (Math.abs(w.cur.wind[k]) > 0.5) { strong = true; break; }
    const strokes = (ls) => ls.reduce((a, l) => a + l.strokes.length, 0);
    // (a metro view wants fewer lines: the denser retries start lower there too — planet/streams.js the same)
    const few = 110 * (1 - 0.6 * metroCalm(w.ws || 1));
    let lines = this._trace1(1, 1);
    if (strong && strokes(lines) < few) lines = this._trace1(0.82, 0.62);
    if (strong && strokes(lines) < few) lines = this._trace1(0.7, 0.42);
    return lines;
  }

  _trace1(dsepMul, sMinMul) {
    const w = this.w;
    const ws = w.ws || 1; // §26: a zoomed real Earth — every length in radians shrinks with the view
    // (§26 amendment 5: the floors scale with the view like every speed in the field — at ×10 the field is ~10× slower
    // in rad / s and an absolute 0.03 left the AI 算力 coast without a single line)
    const ms = Math.max(0.03 * ws, w.maxSpd || 0);
    const sMin = Math.max(0.03 * ws * sMinMul, 0.24 * ms * sMinMul);
    // the cores of real movers (in or out): lines never start or end in a landmass's middle
    const sink = new Uint8Array(Math.max(1, w.n));
    for (let k = 0; k < w.n; k++) sink[k] = Math.abs(w.cur.wind[k]) > 0.45 ? 1 : 0;
    const A = w.anchorDir, R = w.angR;
    const inCore = (o, x, y, z) => o >= 0 && sink[o] && (x * A[o].x + y * A[o].y + z * A[o].z) > Math.cos(0.5 * (R[o] || 0.1));
    // §26 amendment 5 (one wind language with 2D, planet/streams.js): no lines over unclaimed land beyond every
    // territory's pull — the sea keeps its faint lines, empty land far from any territory stays clear
    const reach = reachMask(w);
    const offLand = (o, x, y, z) => o === -2 && reach && !reach[cellOfDir(w.gw, x, y, z)];
    const metro = metroCalm(ws);
    const dsep = (DSEP * ws * dsepMul * (1 + 0.45 * metro)) / Math.sqrt(this.density);
    const dtest = dsep * DTEST;
    const NC = Math.ceil(2 / dsep) + 2;
    const occ = new Map();
    const cellKey = (x, y, z) => (Math.floor((x + 1) / dsep) * NC + Math.floor((y + 1) / dsep)) * NC + Math.floor((z + 1) / dsep);
    const addOcc = (x, y, z) => { const k = cellKey(x, y, z); let l = occ.get(k); if (!l) occ.set(k, (l = [])); l.push(x, y, z); };
    const near = (x, y, z, dd) => {
      const ix = Math.floor((x + 1) / dsep), iy = Math.floor((y + 1) / dsep), iz = Math.floor((z + 1) / dsep);
      const d2 = dd * dd;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const l = occ.get(((ix + a) * NC + (iy + b)) * NC + (iz + c));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 3) { const dx = l[q] - x, dy = l[q + 1] - y, dz = l[q + 2] - z; if (dx * dx + dy * dy + dz * dz < d2) return true; }
      }
      return false;
    };
    // seeds: a jittered Fibonacci sphere, strongest wind first
    const rnd = rng(4271 + ((w.n * 131) % 997));
    const sp = dsep * 0.62;
    const s4 = [0, 0, 0, 0], p3 = [0, 0, 0];
    const seeds = [];
    const trySeed = () => {
      const l = Math.hypot(p3[0], p3[1], p3[2]); p3[0] /= l; p3[1] /= l; p3[2] /= l;
      w.sampleWind(p3, s4);
      if (s4[3] < sMin) return;
      const o = w.ownerAtXYZ(p3[0], p3[1], p3[2]);
      if (inCore(o, p3[0], p3[1], p3[2]) || offLand(o, p3[0], p3[1], p3[2])) return;
      seeds.push([p3[0], p3[1], p3[2], s4[3]]);
    };
    const G = w.gw;
    if (G && !G.wrap) {
      // a window (zoomed real Earth): a jittered lon/lat grid over it
      const lat0 = G.lat1 - G.dLat;
      for (let lat = lat0 + sp * 0.5; lat < G.lat1 && seeds.length < 26000; lat += sp * 0.866) {
        const c = Math.max(0.05, Math.cos(lat)), st = sp / c;
        for (let lo = G.lon0 + st * rnd(); lo < G.lon0 + G.dLon; lo += st) {
          const la = lat + (rnd() - 0.5) * sp * 0.4, ln = G.lonC + lo, cl = Math.cos(la);
          p3[0] = cl * Math.sin(ln); p3[1] = Math.sin(la); p3[2] = cl * Math.cos(ln);
          trySeed();
        }
      }
    } else {
      const N = Math.min(26000, Math.round((4 * Math.PI) / (sp * sp * 0.866)));
      for (let i = 0; i < N; i++) {
        const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(Math.max(0, 1 - y * y));
        const ph = i * 2.39996323 + (rnd() - 0.5) * 0.5;
        p3[0] = Math.cos(ph) * r; p3[1] = y + (rnd() - 0.5) * sp * 0.4; p3[2] = Math.sin(ph) * r;
        trySeed();
      }
    }
    seeds.sort((a, b) => b[3] - a[3]);
    const lines = [];
    const sA = [0, 0, 0, 0], sB = [0, 0, 0, 0], m3 = [0, 0, 0];
    const half = (x0, y0, z0, dir) => {
      const out = [];
      let x = x0, y = y0, z = z0;
      for (let i = 0; i < MAXSTEP; i++) {
        p3[0] = x; p3[1] = y; p3[2] = z;
        w.sampleWind(p3, sA);
        if (sA[3] < sMin * 0.6) break;
        let f = (dir * STEP * ws * 0.5) / sA[3];
        m3[0] = x + sA[0] * f; m3[1] = y + sA[1] * f; m3[2] = z + sA[2] * f;
        let l = Math.hypot(m3[0], m3[1], m3[2]); m3[0] /= l; m3[1] /= l; m3[2] /= l;
        w.sampleWind(m3, sB);
        if (sB[3] < 1e-6) break;
        f = (dir * STEP * ws) / sB[3];
        let nx = x + sB[0] * f, ny = y + sB[1] * f, nz = z + sB[2] * f;
        l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
        const o = w.ownerAtXYZ(nx, ny, nz);
        if (inCore(o, nx, ny, nz) || offLand(o, nx, ny, nz)) break;
        if (near(nx, ny, nz, dtest)) break;
        x = nx; y = ny; z = nz;
        out.push(x, y, z);
      }
      return out;
    };
    // the territory a line runs into (its end) / comes out of (its start): the owner there, else the nearest
    // mover whose anchor is within ~2 of its radii (lines stop at the coast or just off a company's marker)
    const nSink = new Int16Array(Math.max(1, w.n)), nSrc = new Int16Array(Math.max(1, w.n));
    const px = 1 / Math.max(60, this.Rpx || 300);
    const rOf = (k) => Math.max((w.partR && w.partR[k]) || R[k] || 0.01, 26 * px);
    const moverAt = (x, y, z, sign) => {
      const o = w.ownerAtXYZ(x, y, z);
      if (o >= 0 && sign * w.cur.wind[o] > 0.45) return o;
      let best = -1, bd = Infinity;
      for (let k = 0; k < w.n; k++) {
        if (!(sign * w.cur.wind[k] > 0.45)) continue;
        const a = Math.acos(clamp(x * A[k].x + y * A[k].y + z * A[k].z, -1, 1)) / rOf(k);
        if (a < 2.2 && a < bd) { bd = a; best = k; }
      }
      return best;
    };
    for (const [sx, sy, sz] of seeds) {
      if (lines.length >= MAXLINES) break;
      if (near(sx, sy, sz, dsep)) continue;
      const b = half(sx, sy, sz, -1), f = half(sx, sy, sz, 1);
      const nb = b.length / 3, nf = f.length / 3, np = nb + 1 + nf;
      if (np < 4) continue;
      const P = new Float32Array(np * 3);
      for (let i = 0; i < nb; i++) { const s = 3 * (nb - 1 - i); P[3 * i] = b[s]; P[3 * i + 1] = b[s + 1]; P[3 * i + 2] = b[s + 2]; }
      P[3 * nb] = sx; P[3 * nb + 1] = sy; P[3 * nb + 2] = sz;
      for (let i = 0; i < nf; i++) { P[3 * (nb + 1 + i)] = f[3 * i]; P[3 * (nb + 1 + i) + 1] = f[3 * i + 1]; P[3 * (nb + 1 + i) + 2] = f[3 * i + 2]; }
      const cum = new Float32Array(np);
      for (let i = 1; i < np; i++) cum[i] = cum[i - 1] + Math.hypot(P[3 * i] - P[3 * i - 3], P[3 * i + 1] - P[3 * i - 2], P[3 * i + 2] - P[3 * i - 1]);
      const len = cum[np - 1];
      if (len < MINLEN * ws) continue;
      const sk = moverAt(P[3 * np - 3], P[3 * np - 2], P[3 * np - 1], 1), so = moverAt(P[0], P[1], P[2], -1);
      const capOf = (k) => (w.kind && w.kind[k] === 'point' ? PER_POINT - Math.round(3 * metro) : PER_SINK - Math.round(4 * metro));
      if (sk >= 0 && nSink[sk] >= capOf(sk)) continue;
      if (so >= 0 && nSrc[so] >= capOf(so)) continue;
      if (sk >= 0) nSink[sk]++;
      if (so >= 0) nSrc[so]++;
      let avg = 0, cnt = 0;
      for (let i = 0; i < np; i += 3) { p3[0] = P[3 * i]; p3[1] = P[3 * i + 1]; p3[2] = P[3 * i + 2]; w.sampleWind(p3, sA); avg += sA[3]; cnt++; }
      avg /= cnt || 1;
      for (let i = 0; i < np; i++) addOcc(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      const ls = Math.min(STROKE * ws, len * 0.8);
      const oE = w.ownerAtXYZ(P[3 * np - 3], P[3 * np - 2], P[3 * np - 1]), oS = w.ownerAtXYZ(P[0], P[1], P[2]);
      const tint = oE >= 0 && w.cur.wind[oE] > 0.5 ? 2 : oS >= 0 && w.cur.wind[oS] < -0.5 ? 3 : 0;
      const nS = clamp(Math.round(len / (0.24 * ws)), 1, 3);
      const strokes = [];
      const ph0 = rnd();
      for (let j = 0; j < nS; j++) strokes.push((ph0 + j / nS + rnd() * 0.08) % 1);
      const mid = Math.floor(np / 2);
      lines.push({
        P, cum, len, ls, strokes, tint, mid: [P[3 * mid], P[3 * mid + 1], P[3 * mid + 2]], sk, so,
        fr: sk >= 0 ? 1.5 * rOf(sk) : so >= 0 ? 1.2 * rOf(so) : 0, fk: sk >= 0 ? sk : so,
        v: clamp(avg * 1.05, 0.05 * ws, 0.24 * ws),
        a: 0.35 + 0.65 * smoothstep(sMin, ms * 0.8, avg),
        pause: 0.1 + rnd() * 0.3,
      });
    }
    return lines;
  }

  // ------------------------------------------------------------------------------------------ frame
  update(dt, play, Rpx = 300) {
    const w = this.w;
    this.Rpx = Rpx;
    dt = Math.min(dt, 0.05);
    if (play) this.time += dt;
    const now = this.time;
    if (w.fieldVer !== this.ver && (now - this.lastTrace > 0.38 || !this.lines.length)) {
      const first = this.ver === -1;
      this.ver = w.fieldVer;
      this.lastTrace = now;
      this.old = first ? [] : this.lines.map((l) => Object.assign(l, { dying: now }));
      this.lines = this._trace().map((l) => Object.assign(l, { born: first ? -1e9 : now }));
    }
    if (this.old.length && now - this.lastTrace > FADE) this.old = [];
    const px = 1 / Math.max(60, Rpx);
    const hw = 1.25 * px; // (refine #5: thin anime wind-lines, like 2D — not 3 px pins)
    const dark = this.ctx.bandDark;
    const cam = w.camObj;
    const lsMax = TRAIL_PX * px;
    const spot = this.spotKs && this.spotKs.size ? this.spotKs : null;
    let s = 0;
    for (const set of [this.old, this.lines]) {
      for (const l of set) {
        if (s >= MAXSTROKES) break;
        // far side of the globe: nothing to draw
        if (l.mid[0] * cam.x + l.mid[1] * cam.y + l.mid[2] * cam.z < -0.25) continue;
        const fade = l.dying != null ? 1 - smoothstep(0, FADE, now - l.dying) : smoothstep(0, FADE, now - l.born);
        if (fade <= 0.01) continue;
        const ls = Math.min(l.ls, lsMax);
        const span = l.len + ls * 0.35;
        const T = span / l.v + l.pause;
        // lines that run to a place nobody is pointing at today stay quieter (§6: the ①②③ keep the attention)
        const quiet = spot && l.fk >= 0 && !spot.has(l.fk) ? 0.6 : 1;
        for (const ph of l.strokes) {
          if (s >= MAXSTROKES) break;
          const u = ((now / T + ph) % 1) * (T / (span / l.v));
          if (u >= 1) continue;
          const head = u * span, tail = head - ls;
          const vis0 = Math.max(0, tail), vis1 = Math.min(l.len, head);
          if (vis1 - vis0 < ls * 0.06) continue;
          const env = smoothstep(0, ls * 0.35, head) * smoothstep(0, ls * 0.45, vis1 - vis0);
          const a = env * l.a * fade * quiet;
          if (a < 0.01) continue;
          if (this._stroke(s, l, tail, vis0, vis1, hw, a, dark, ls)) s++;
        }
      }
    }
    this.n = s;
    const g = this.mesh.geometry;
    g.setDrawRange(0, s * IPS);
    g.attributes.position.needsUpdate = true;
    g.attributes.aA.needsUpdate = true;
    g.attributes.aC.needsUpdate = true;
  }

  _stroke(s, l, tail, vis0, vis1, hw, a, dark, lsE) {
    const w = this.w, P = l.P, cum = l.cum;
    const LS = lsE || l.ls;
    // fade out inside 1.5× the target's radius (lines never converge into a spike on a city) — at most 80 px on screen
    // (§26 amendment 5: at ×10 a county-sized piece made that 390 px and every line round the Bay Area was invisible)
    const fa = l.fr > 0 ? w.anchorDir[l.fk] : null, fr = Math.min(l.fr, 80 / Math.max(60, this.Rpx || 300));
    const pts = this._pts, tmp = this._tmp, v = this._v, d = this._d;
    let j = 1;
    for (let i = 0; i < NPS; i++) {
      const sa = vis0 + ((vis1 - vis0) * i) / (NPS - 1);
      while (j < cum.length - 1 && cum[j] < sa) j++;
      const f = clamp((sa - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]), 0, 1);
      d.set(P[3 * j - 3] + (P[3 * j] - P[3 * j - 3]) * f, P[3 * j - 2] + (P[3 * j + 1] - P[3 * j - 2]) * f, P[3 * j - 1] + (P[3 * j + 2] - P[3 * j - 1]) * f);
      pts[3 * i] = d.x; pts[3 * i + 1] = d.y; pts[3 * i + 2] = d.z;
      w.windPos(d, ALT * Math.sqrt(w.ws || 1), v);
      tmp[3 * i] = v.x; tmp[3 * i + 1] = v.y; tmp[3 * i + 2] = v.z;
    }
    const cam = w.camObj;
    // the whole stroke on the far side: skip
    const hx = pts[3 * NPS - 3], hy = pts[3 * NPS - 2], hz = pts[3 * NPS - 1];
    if (hx * cam.x + hy * cam.y + hz * cam.z < 0.05 && pts[0] * cam.x + pts[1] * cam.y + pts[2] * cam.z < 0.05) return false;
    d.set(hx, hy, hz);
    const band = w.bandAt(d);
    const col = band >= 0 && dark[band] ? 1 : l.tint || 0;
    const base = s * VPS;
    const Pp = this.pos, A = this.aA, C = this.aC;
    let sx = 0, sy = 0, sz = 0, wl = 0;
    for (let i = 0; i < NPS; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(NPS - 1, i + 1);
      const tx = tmp[3 * i1] - tmp[3 * i0], ty = tmp[3 * i1 + 1] - tmp[3 * i0 + 1], tz = tmp[3 * i1 + 2] - tmp[3 * i0 + 2];
      const qx = tmp[3 * i], qy = tmp[3 * i + 1], qz = tmp[3 * i + 2];
      sx = ty * qz - tz * qy; sy = tz * qx - tx * qz; sz = tx * qy - ty * qx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const sa = vis0 + ((vis1 - vis0) * i) / (NPS - 1);
      const uu = clamp((sa - tail) / LS, 0, 1);
      wl = hw * (0.1 + 0.9 * Math.pow(uu, 1.35));
      sx = (sx / sl) * wl; sy = (sy / sl) * wl; sz = (sz / sl) * wl;
      const vi = base + i * 2;
      Pp[vi * 3] = qx + sx; Pp[vi * 3 + 1] = qy + sy; Pp[vi * 3 + 2] = qz + sz;
      Pp[vi * 3 + 3] = qx - sx; Pp[vi * 3 + 4] = qy - sy; Pp[vi * 3 + 5] = qz - sz;
      const len = Math.hypot(qx, qy, qz) || 1;
      const face = (qx * cam.x + qy * cam.y + qz * cam.z) / len;
      let aa = a * (0.25 + 0.75 * Math.min(1, uu * 1.6)) * smoothstep(0.18, 0.42, face);
      if (fa) { const dd = Math.acos(clamp((qx * fa.x + qy * fa.y + qz * fa.z) / len, -1, 1)); aa *= smoothstep(fr * 0.45, fr, dd); }
      A[vi] = A[vi + 1] = aa;
      C[vi] = C[vi + 1] = col;
    }
    const hi = NPS - 1;
    const qx = tmp[3 * hi], qy = tmp[3 * hi + 1], qz = tmp[3 * hi + 2];
    let tx = qx - tmp[3 * hi - 3], ty = qy - tmp[3 * hi - 2], tz = qz - tmp[3 * hi - 1];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const sl = Math.hypot(sx, sy, sz) || 1;
    const nx = sx / sl, ny = sy / sl, nz = sz / sl;
    const c = base + NPS * 2;
    const ah = A[base + hi * 2];
    Pp[c * 3] = qx; Pp[c * 3 + 1] = qy; Pp[c * 3 + 2] = qz; A[c] = ah; C[c] = col;
    const cr = wl * 1.05; // a rounded tip, not a knob
    for (let k = 0; k <= CAP; k++) {
      const ang = (k / CAP) * Math.PI * 2;
      const ca = Math.sin(ang) * cr, cb = Math.cos(ang) * cr;
      const vi = c + 1 + k;
      Pp[vi * 3] = qx + nx * ca + tx * cb; Pp[vi * 3 + 1] = qy + ny * ca + ty * cb; Pp[vi * 3 + 2] = qz + nz * ca + tz * cb;
      A[vi] = ah; C[vi] = col;
    }
    return true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
