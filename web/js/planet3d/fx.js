// planet3d/fx.js — the 3D weather on one planet: 主航道 arc (the hero, §8.1), Polymarket toon clouds
// (§10), storms (dark cloud + rain + one crisp bolt), weather-map fronts (§4.5), intel 预期风 arrows (§11),
// and a "surface sketch" layer (arc shadow, front ribbons, arrows) drawn as one dynamic mesh.
// The arc lives on render layer ARC_LAYER and is drawn in its own pass after everything else, so no
// cloud or storm ever cuts through it; clouds cast flat, hard-edged shadows (in the ground's own shadow
// colour) through the plate shader (world.uCS); props fade out before their territory turns away.

import { THREE, PROP_VS, PROP_FS, HULL_VS, FLAT_FS, HULL_UV_VS, HULL_UV_FS, RAIN_VS, RAIN_FS, frame3, offsetDir } from './core.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const ARC_LAYER = 1;
const smooth = (t) => t * t * (3 - 2 * t);
const V = () => new THREE.Vector3();

// ------------------------------------------------------------------------------------------ sketch
const SK_MAX = 60000;
const SK_VS = /* glsl */ `
attribute vec4 aCol;
varying vec4 vCol;
void main() { vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SK_FS = /* glsl */ `
varying vec4 vCol;
void main() { if (vCol.a < 0.004) discard; gl_FragColor = vCol; }
`;
class Sketch {
  constructor() {
    this.p = new Float32Array(SK_MAX * 3);
    this.c = new Float32Array(SK_MAX * 4);
    this.n = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(V(), 1.4);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SK_VS, fragmentShader: SK_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }
  begin() { this.n = 0; }
  v(p, col, a) {
    if (this.n >= SK_MAX) return;
    const i = this.n++;
    this.p[i * 3] = p.x; this.p[i * 3 + 1] = p.y; this.p[i * 3 + 2] = p.z;
    this.c[i * 4] = col.x; this.c[i * 4 + 1] = col.y; this.c[i * 4 + 2] = col.z; this.c[i * 4 + 3] = a;
  }
  tri(a, b, c, col, aa, ab = aa, ac = aa) { this.v(a, col, aa); this.v(b, col, ab); this.v(c, col, ac); }
  /** Flat ribbon lying on the surface. pts: Vector3[]; hw: half width (number or fn(i)); alpha fn(i). soft: soft edges */
  ribbon(pts, hw, col, alpha, soft = false) {
    const n = pts.length;
    if (n < 2) return;
    const L = [], R = [], C = [];
    const t = V(), s = V();
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      t.subVectors(b, a);
      s.crossVectors(t, pts[i]).normalize();
      const w = typeof hw === 'function' ? hw(i) : hw;
      L.push(pts[i].clone().addScaledVector(s, w));
      R.push(pts[i].clone().addScaledVector(s, -w));
      C.push(pts[i]);
    }
    for (let i = 0; i < n - 1; i++) {
      const a0 = alpha(i), a1 = alpha(i + 1);
      if (a0 <= 0.003 && a1 <= 0.003) continue;
      if (soft) {
        this.tri(L[i], C[i], C[i + 1], col, 0, a0, a1); this.tri(L[i], C[i + 1], L[i + 1], col, 0, a1, 0);
        this.tri(C[i], R[i], R[i + 1], col, a0, 0, 0); this.tri(C[i], R[i + 1], C[i + 1], col, a0, 0, a1);
      } else {
        this.tri(L[i], R[i], R[i + 1], col, a0, a0, a1); this.tri(L[i], R[i + 1], L[i + 1], col, a0, a1, a1);
      }
    }
  }
  /** Soft disc on the surface around p (unit normal = p dir), radii in object units. */
  disc(p, rx, ry, col, a, up) {
    const nrm = p.clone().normalize();
    const ax = V().crossVectors(up, nrm);
    if (ax.lengthSq() < 1e-8) ax.set(1, 0, 0); else ax.normalize();
    const ay = V().crossVectors(nrm, ax).normalize();
    const N = 22;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const q = p.clone().addScaledVector(ax, Math.cos(ang) * rx).addScaledVector(ay, Math.sin(ang) * ry);
      const qi = p.clone().addScaledVector(ax, Math.cos(ang) * rx * 0.45).addScaledVector(ay, Math.sin(ang) * ry * 0.45);
      if (prev) {
        this.tri(p, prev[1], qi, col, a, a, a);
        this.tri(prev[1], prev[0], q, col, a, 0, 0);
        this.tri(prev[1], q, qi, col, a, 0, a);
      }
      prev = [q, qi];
    }
  }
  end() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.n);
    g.attributes.position.needsUpdate = true;
    g.attributes.aCol.needsUpdate = true;
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ------------------------------------------------------------------------------------------ materials
function propMat(U, lit, shade, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: PROP_VS, fragmentShader: PROP_FS,
    uniforms: Object.assign({
      uLit: { value: lit }, uShade: { value: shade }, uA: { value: 1 }, uFlow: { value: 0 }, uFlowCol: { value: V() },
      uTime: U.uTime, uProg: { value: 1 }, uFlash: { value: 0 }, uL: U.uL, uRimCol: U.uRimCol, uRimAmt: U.uRimAmt,
    }, extra),
  });
}
function hullMat(U, col, w) {
  return new THREE.ShaderMaterial({
    vertexShader: HULL_VS, fragmentShader: FLAT_FS, side: THREE.BackSide,
    uniforms: { uW: w || U.uHullW, uRes: U.uRes, uGrow: { value: 0 }, uCol: { value: col }, uA: { value: 1 } },
  });
}

/** Toon prop + ink hull sharing one geometry. */
function toonProp(U, geo, lit, shade, line, lineW) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, propMat(U, lit, shade));
  const h = new THREE.Mesh(geo, hullMat(U, line, lineW));
  m.material.transparent = h.material.transparent = true; // a cloud under a label fades (planet3d _cloudFade)
  m.userData.sharedGeo = h.userData.sharedGeo = true;
  m.renderOrder = 4; h.renderOrder = 4;
  g.add(m, h);
  g.userData.mat = m.material;
  g.userData.hull = h.material;
  return g;
}

// ------------------------------------------------------------------------------------------ arc tube
const AS = 110, ARS = 14;
class Tube {
  constructor() {
    const nv = (AS + 1) * (ARS + 1);
    this.pos = new Float32Array(nv * 3);
    this.nrm = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const idx = [];
    for (let i = 0; i <= AS; i++) for (let j = 0; j <= ARS; j++) { const v = i * (ARS + 1) + j; uv[v * 2] = i / AS; uv[v * 2 + 1] = j / ARS; }
    for (let i = 0; i < AS; i++) for (let j = 0; j < ARS; j++) {
      const a = i * (ARS + 1) + j, b = a + ARS + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.geo.boundingSphere = new THREE.Sphere(V(), 2);
  }
  /** pts: AS+1 points; rad(t) */
  update(pts, rad) {
    let N = V();
    const T = V(), B = V(), tmp = V();
    for (let i = 0; i <= AS; i++) {
      T.subVectors(pts[Math.min(AS, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      if (i === 0) {
        N.crossVectors(T, pts[0]).normalize();
        if (N.lengthSq() < 1e-8) N.set(1, 0, 0);
      } else {
        N.addScaledVector(T, -N.dot(T)).normalize();
      }
      B.crossVectors(T, N).normalize();
      const r = rad(i / AS);
      for (let j = 0; j <= ARS; j++) {
        const a = (j / ARS) * Math.PI * 2;
        tmp.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
        const v = i * (ARS + 1) + j;
        this.nrm[v * 3] = tmp.x; this.nrm[v * 3 + 1] = tmp.y; this.nrm[v * 3 + 2] = tmp.z;
        this.pos[v * 3] = pts[i].x + tmp.x * r; this.pos[v * 3 + 1] = pts[i].y + tmp.y * r; this.pos[v * 3 + 2] = pts[i].z + tmp.z * r;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }
}

// ================================================================================================ Fx
export class Fx {
  constructor(ctx, world, props) {
    this.ctx = ctx;
    this.w = world;
    this.props = props;
    this.group = new THREE.Group();
    this.sketch = new Sketch();
    this.group.add(this.sketch.mesh);
    this.clouds = new Map(); // key → {obj, k, strength, born}
    this.storms = new Map();
    this.intelObjs = new Map();
    this.chan = null;
    this.state = { channel: null, clouds: [], storms: [], fronts: [], intel: [], blink: new Map() };
    this._q = new THREE.Quaternion();
    this.chanApex = null;
  }

  // ---------------------------------------------------------------------------- sync (data → objects)
  sync(s) {
    this.state = s;
    // channel
    const dk = (d) => (d ? d.x.toFixed(3) + ',' + d.y.toFixed(3) + ',' + d.z.toFixed(3) : '');
    const ck = s.channel ? s.channel.fk + '>' + s.channel.tk + '@' + dk(s.channel.aDir) + '/' + dk(s.channel.bDir) + (s.channel.t2k != null ? '+' + s.channel.t2k + '@' + dk(s.channel.b2Dir) : '') : '';
    if (ck !== (this.chan ? this.chan.key : '')) {
      this._dropChannel();
      if (s.channel) this._makeChannel(s.channel, ck);
    }
    // clouds
    const seen = new Set();
    s.clouds.forEach((c, i) => {
      const key = 'c' + c.k;
      seen.add(key);
      let o = this.clouds.get(key);
      if (!o) {
        const geos = this.props.clouds;
        const L = this.ctx.look;
        const obj = toonProp(this.ctx.U, geos[(c.k * 7 + i) % geos.length], L.cloud.lit, L.cloud.shade, L.cloud.line);
        obj.userData.kind = 'cloud';
        this.group.add(obj);
        o = { obj, born: performance.now(), seed: (c.k * 0.731) % 1 };
        this.clouds.set(key, o);
      }
      Object.assign(o, c);
    });
    for (const [key, o] of this.clouds) if (!seen.has(key)) { this._kill(o.obj); this.clouds.delete(key); }
    // storms (measured only: rain = 风暴)
    const seenS = new Set();
    for (const st of s.storms) {
      const key = 's' + st.k;
      seenS.add(key);
      let o = this.storms.get(key);
      if (!o) o = this._makeStorm(st, key);
      Object.assign(o, st);
    }
    for (const [key, o] of this.storms) if (!seenS.has(key)) { this._kill(o.obj); this.storms.delete(key); }
    // intel tags
    const seenI = new Set();
    for (const it of s.intel) {
      const key = 'i' + it.k + ':' + it.dir;
      seenI.add(key);
      let o = this.intelObjs.get(key);
      if (!o) {
        const el = document.createElement('div');
        el.className = 'p3-intel';
        const obj = new CSS2DObject(el);
        this.group.add(obj);
        o = { obj, el };
        this.intelObjs.set(key, o);
      }
      Object.assign(o, it);
      const title = it.title ? shortTitle(it.title) : '情报';
      const html = `<svg viewBox="0 0 12 16" width="9" height="12"><path d="M7.5 0.8 1.6 9h3.8L3.6 15.2 10.4 6.4H6.5z" fill="var(--p3-bolt)" stroke="var(--p3-bolt-line)" stroke-width="1.1" stroke-linejoin="round"/></svg><span class="p3-iw">${esc(title)}</span>`;
      if (o.html !== html) { o.el.innerHTML = html; o.html = html; o.sz = o.szQ = null; }
    }
    for (const [key, o] of this.intelObjs) if (!seenI.has(key)) { this._kill(o.obj); this.intelObjs.delete(key); }
  }

  _kill(obj) {
    obj.traverse((o) => {
      if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
      if (o.material && !o.userData.sharedMat) o.material.dispose();
      if (o.geometry && o.userData.ownGeo) o.geometry.dispose();
    });
    if (obj.parent) obj.parent.remove(obj);
  }

  _makeStorm(st, key) {
    const L = this.ctx.look, U = this.ctx.U;
    const obj = new THREE.Group();
    const cloud = toonProp(U, this.props.storm, L.storm.lit, L.storm.shade, L.storm.line);
    obj.add(cloud);
    // rain: 6 neat strokes of equal length in 2 staggered rows, directly under the base
    const ROWS = [[-0.22, 0, 0.22], [-0.11, 0.11, 0.33]];
    const pos = [], seed = [], idx = [];
    for (let i = 0; i < 6; i++) {
      const row = i < 3 ? 0 : 1;
      const sx = ROWS[row][i % 3] - 0.05, sz = 0.06, ph = row * 0.5, sp = 0.4;
      const b = i * 4;
      pos.push(-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0);
      for (let q = 0; q < 4; q++) seed.push(sx, sz, ph, sp);
      idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 4));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(V(), 3);
    const rainMat = new THREE.ShaderMaterial({
      // no depth test: near the limb the ground under a cloud rises toward the viewer and would swallow it
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      uniforms: {
        // slanted 18° the same way the cloud shadows fall (away from the light, on screen)
        uTime: U.uTime, uDown: { value: new THREE.Vector3(0, -1, 0) }, uSide: { value: new THREE.Vector3(L.light.x <= 0 ? 1 : -1, 0, 0) },
        uFall: { value: 0.9 }, uLen: { value: 0.17 }, uWid: { value: 0.028 }, uCol: { value: L.rain.c }, uA: { value: L.rain.a },
      },
    });
    const rain = new THREE.Mesh(g, rainMat);
    rain.userData.ownGeo = true;
    rain.renderOrder = 5;
    rain.frustumCulled = false;
    obj.add(rain);
    // bolt (CSS2D: one crisp zig-zag)
    const el = document.createElement('div');
    el.className = 'p3-bolt';
    el.innerHTML = '<svg viewBox="0 0 24 40" width="17" height="28"><path d="M15 1 3 22h8l-4 17 15-24h-8.5z" fill="var(--p3-bolt)" stroke="var(--p3-bolt-line)" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const bolt = new CSS2DObject(el);
    bolt.position.set(0.08, -0.25, 0.05);
    obj.add(bolt);
    this.group.add(obj);
    const o = { obj, cloud, rain, bolt, el, next: performance.now() + 900 + Math.random() * 2500, flashUntil: 0, born: performance.now() };
    this.storms.set(key, o);
    return o;
  }

  /** One arc (tube + ink casing + flat head), on ARC_LAYER. rf: radius factor (the branch is thinner). */
  _makeArc(fk, tk, aDir, bDir, rf) {
    const L = this.ctx.look, U = this.ctx.U;
    const tube = new Tube();
    const body = new THREE.Mesh(tube.geo, propMat(U, L.chan, L.chanShade, { uFlow: { value: 2 }, uFlowCol: { value: L.chanFlow } }));
    const hull = new THREE.Mesh(tube.geo, new THREE.ShaderMaterial({
      vertexShader: HULL_UV_VS, fragmentShader: HULL_UV_FS, side: THREE.BackSide,
      uniforms: { uW: U.uChanCaseW, uRes: U.uRes, uCol: { value: L.chanCase }, uA: { value: 1 }, uProg: body.material.uniforms.uProg },
    }));
    body.renderOrder = 6; hull.renderOrder = 6;
    hull.userData.sharedGeo = true;
    const headGeo = this.props.arrowHead;
    const head = new THREE.Mesh(headGeo, propMat(U, L.chan, L.chanShade));
    const headHull = new THREE.Mesh(headGeo, hullMat(U, L.chanCase, U.uChanCaseW));
    head.userData.sharedGeo = headHull.userData.sharedGeo = true;
    head.renderOrder = 6; headHull.renderOrder = 6;
    const g = new THREE.Group();
    g.add(hull, body, head, headHull);
    for (const o of [hull, body, head, headHull]) o.layers.set(ARC_LAYER);
    this.group.add(g);
    tube.geo.userData.own = true;
    const arc = { fk, tk, aDir: aDir || null, bDir: bDir || null, rf, tube, body, hull, head, headHull, g, hA: -1, hB: -1, pts: [], flat: !!this.props.arrowFlat };
    for (let i = 0; i <= AS; i++) arc.pts.push(V());
    return arc;
  }

  _makeChannel(ch, key) {
    const old = this._lastChan;
    this.chan = Object.assign(this._makeArc(ch.fk, ch.tk, ch.aDir, ch.bDir, 1), { key, t0: performance.now(), shadow: [] });
    // a second destination: a thinner branch from the same take-off
    this.chan.branch = ch.t2k != null && ch.b2Dir ? this._makeArc(ch.fk, ch.t2k, ch.aDir, ch.b2Dir, 0.62) : null;
    // same channel, endpoints merely nudged: no second draw-in; a channel that replaces another one a moment
    // ago (▶ playback, date scrubbing) arrives mostly drawn and finishes in ~0.25 s instead of vanishing
    if (old && old.fk === ch.fk && old.tk === ch.tk) this.chan.t0 = old.t0;
    else if (old && performance.now() - old.at < 1500) this.chan.t0 = performance.now() - 780;
  }
  _dropChannel() {
    if (!this.chan) return;
    this._lastChan = { fk: this.chan.fk, tk: this.chan.tk, t0: this.chan.t0, at: performance.now() };
    for (const a of [this.chan, this.chan.branch].filter(Boolean)) { a.tube.geo.dispose(); this._kill(a.g); }
    this.chan = null;
    this.chanApex = null;
  }

  /** Geometry, tube, head and draw-in of one arc for this frame. */
  _updArc(c, ep, sc, rq, hA, hB) {
    if (Math.abs(hA - c.hA) + Math.abs(hB - c.hB) > 0.0015 || !c.dense) this._arcGeom(c), c.dirty = true;
    if (c.flat && (!c.lastRq || c.lastRq.angleTo(rq) > 1e-4)) { c.dirty = true; c.lastRq = rq.clone(); }
    // short arcs are drawn thinner (head and tube shrink together, ≥ 45 %)
    const R0 = 0.019 * sc * c.rf * (c.total ? clamp(c.total / (0.5 * sc), 0.45, 1) : 1);
    if (c.dirty || c.lastScale !== sc) {
      c.tube.update(c.pts, (t) => R0 * (0.5 + 0.5 * smooth(Math.min(1, t * 1.6))));
      const T = V().subVectors(c.tip, c.base).normalize();
      const hl = c.tip.distanceTo(c.base);
      c.head.position.copy(c.base);
      if (c.flat) {
        // flat Blender arrow head, laid in the view plane along the arc's on-screen direction
        // (an arc diving straight at the viewer would otherwise show the head edge-on)
        const cam = V().set(0, 0, 1).applyQuaternion(rq);
        const D = V().subVectors(c.tip, c.pts[AS - 14]);
        D.addScaledVector(cam, -D.dot(cam));
        if (D.lengthSq() < 1e-8) D.copy(T);
        D.normalize();
        const xA = V().crossVectors(cam, D).normalize();
        c.head.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, cam, D));
        c.head.position.copy(c.base).addScaledVector(cam, 0.01 * sc);
        c.head.scale.set((R0 * 6.4) / 1.04, R0 * 4, Math.max(hl, R0 * 5) * 1.05);
      } else {
        c.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), T);
        c.head.scale.set(R0 * 5.0, hl * 1.15, R0 * 5.0);
      }
      c.headHull.position.copy(c.head.position);
      c.headHull.quaternion.copy(c.head.quaternion);
      c.headHull.scale.copy(c.head.scale);
      c.dirty = false; c.lastScale = sc;
    }
    c.body.material.uniforms.uProg.value = ep;
    c.body.material.uniforms.uFlow.value = c.total > 0.9 ? 3 : 2; // 2–3 slow comets, never a zebra
    c.R0 = R0;
    c.hull.material.uniforms.uProg = c.body.material.uniforms.uProg;
    const headOn = ep >= 0.999;
    c.head.visible = c.headHull.visible = headOn || ep > 0.97;
    return headOn;
  }

  /** Recompute the arc points (object space) for the current plate heights. */
  _arcGeom(c) {
    const w = this.w;
    // §25: a sea route — the great circle between the two coasts, lifted into a low arc over the water, bowed a
    // touch toward the planet's front so it reads as a curve (both ends face the viewer: the minor arc never
    // goes round the back of the globe)
    const da = (c.aDir || w.anchorDir[c.fk]).clone().normalize(), db = (c.bDir || w.anchorDir[c.tk]).clone().normalize();
    const pA = w.surfPos(da, 0, V()), pB = w.surfPos(db, 0, V());
    const hA = pA.length() - 1, hB = pB.length() - 1;
    const om = Math.max(1e-4, da.angleTo(db)), so = Math.sin(om);
    const nrm = V().crossVectors(da, db).normalize();
    if (nrm.dot(w.frontDir) < 0) nrm.negate();
    const ws = w.ws || 1; // §26 zoomed real Earth: the arc keeps its shape on screen
    const bow = 0.09 * om;
    const peak = ws * (0.04 + 0.11 * Math.min(1, om / (1.4 * ws)));
    const D = 200, P = [], cum = [0];
    const d = V();
    for (let i = 0; i <= D; i++) {
      const t = i / D;
      const sb = Math.sin(Math.PI * t);
      const a = Math.sin((1 - t) * om) / so, b = Math.sin(t * om) / so;
      d.set(a * da.x + b * db.x, a * da.y + b * db.y, a * da.z + b * db.z).addScaledVector(nrm, bow * sb).normalize();
      const lift = peak * Math.pow(sb, 0.85);
      const r = 1 + hA + (hB - hA) * t + 0.006 * ws + lift;
      P.push(d.clone().multiplyScalar(r));
      if (i) cum.push(cum[i - 1] + P[i].distanceTo(P[i - 1]));
    }
    const total = cum[D];
    // a short hop (two places in one country) keeps an arrow, never just an oversized head
    const headLen = clamp(total * 0.16, Math.min(0.07 * ws, total * 0.22), 0.12 * ws);
    const at = (s) => {
      let j = 1;
      while (j < D && cum[j] < s) j++;
      const u = (s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
      return P[j - 1].clone().lerp(P[j], u);
    };
    const tubeLen = total - headLen;
    for (let i = 0; i <= AS; i++) c.pts[i].copy(at((i / AS) * tubeLen));
    c.tip = P[D].clone();
    c.base = at(tubeLen);
    c.apex = at(total * 0.5);
    c.samples = [];
    for (let i = 1; i <= 9; i++) c.samples.push(at((total * i) / 10));
    c.poly = [];
    for (let i = 0; i <= 12; i++) c.poly.push(at((total * i) / 12));
    c.total = total;
    c.dense = P;
    c.denseCum = cum;
    c.hA = hA; c.hB = hB;
    c.peak = peak;
  }

  // ---------------------------------------------------------------------------- per-frame
  update(dt, now, blink, rootQuat, reveal) {
    const w = this.w, L = this.ctx.look, U = this.ctx.U;
    const rq = this._q.copy(rootQuat).invert(); // world → planet-local
    const Lobj = U.uLobj.value;
    const sk = this.sketch;
    sk.begin();
    const up = V().set(0, 1, 0).applyQuaternion(rq);

    // ---- 主航道 (+ a thinner branch to a second destination)
    const c = this.chan;
    if (c) {
      const hA = w.h[c.fk] * w.uRise.value, hB = w.h[c.tk] * w.uRise.value;
      if (reveal < 0.95) c.t0 = now; // draw the arc in once the planet has risen
      const age = now - c.t0;
      const prog = clamp((age - 150) / 900, 0, 1) * reveal;
      const ep = smooth(prog);
      const sc = U.uChanScale.value;
      const headOn = this._updArc(c, ep, sc, rq, hA, hB);
      const br = c.branch;
      let brOn = false;
      if (br) {
        const ep2 = smooth(clamp((age - 450) / 900, 0, 1) * reveal);
        brOn = this._updArc(br, ep2, sc, rq, hA, w.h[br.tk] * w.uRise.value);
      }
      this.chanApex = c.apex;
      // ground shadow: a crisp, narrow, faint band right under the arc (shadow light close to the view
      // axis, so it never reads as a second arc)
      const cam = V().set(0, 0, 1).applyQuaternion(rq);
      const Ls = V().copy(Lobj).addScaledVector(cam, -Lobj.dot(cam)).multiplyScalar(0.42).add(cam).normalize();
      const sh = [];
      const nS = 60, sw = [];
      for (let i = 0; i <= nS; i++) {
        const t = i / nS;
        if (t > ep) break;
        const p = c.dense[Math.round(t * (c.dense.length - 1))];
        const q = castOn(p, Ls, 1);
        if (!q) continue;
        w.surfPos(q, 0.002 * sc, q);
        sh.push(q);
        sw.push(t);
      }
      const R0 = 0.019 * sc;
      if (sh.length > 1) sk.ribbon(sh, () => R0 * 0.8, L.shadow, (i) => L.shadowA * reveal * smooth(Math.min(1, sw[i] * 5)) * smooth(Math.min(1, (1 - sw[i]) * 4)), false);
      // take-off pad + landing ripple
      const pA = c.aDir ? w.surfPos(c.aDir, 0.002 * sc, V()) : w.anchorPos(c.fk, V(), 0.002 * sc);
      const pB = c.bDir ? w.surfPos(c.bDir, 0.002 * sc, V()) : w.anchorPos(c.tk, V(), 0.002 * sc);
      sk.disc(pA, 0.022 * sc, 0.022 * sc, L.chan, 0.18 * reveal, up);
      if (headOn) {
        for (let r = 0; r < 2; r++) {
          const ph = ((now / 1600 + r * 0.5) % 1);
          ringOn(sk, pB, (0.02 + ph * 0.07) * sc, 0.0035 * sc, L.inC, (1 - ph) * 0.55 * reveal, up);
        }
      }
      if (brOn && br.bDir) {
        const pB2 = w.surfPos(br.bDir, 0.002 * sc, V());
        const ph = ((now / 1600 + 0.25) % 1);
        ringOn(sk, pB2, (0.016 + ph * 0.05) * sc, 0.003 * sc, L.inC, (1 - ph) * 0.45 * reveal, up);
      }
    } else this.chanApex = null;

    // ---- clouds (Polymarket): float above, upright to the viewer, a light shadow right under them
    let ncs = 0;
    /** a flat round shadow under the cloud's ground spot, nudged ≤ 0.25 × its width away from the light */
    const castShadow = (o, size, a) => {
      if (ncs >= 8 || a < 0.5 || (o.edge != null && o.edge > 0.92)) return;
      const spot = o.spot || w.visibleAnchor(o.k, V().set(0, 0, 1).applyQuaternion(rq));
      const lt = V().copy(Lobj).addScaledVector(spot, -Lobj.dot(spot));
      const q = V().copy(spot);
      if (lt.lengthSq() > 1e-8) q.addScaledVector(lt.normalize(), -0.25 * size).normalize();
      w.uCS.value[ncs++].set(q.x, q.y, q.z, 0.3 * size);
    };
    for (const o of this.clouds.values()) {
      const k = o.k;
      const age = (now - o.born) / 700;
      stepSpot(o, w, k, rq, dt);
      const hv = hover(w, k, rq, 0, o.spot);
      // props whose territory turns away fade out (never float on the paper beyond the limb)
      o.vis = smooth(clamp((hv.facing - 0.3) / 0.2, 0, 1));
      const sIn = smooth(clamp(age, 0, 1)) * reveal * (o.vis > 0.02 ? 1 : 0);
      const ws = w.ws || 1;
      const size = clamp(w.L.rEq[k] * 0.62, 0.1 * ws, 0.24 * ws) * (0.8 + 0.35 * clamp(o.strength, 0, 1));
      const alt = 0.1 * ws + size * 0.25;
      const bob = Math.sin(now / 2300 + o.seed * 6.28) * 0.006 * ws;
      const p = hover(w, k, rq, alt + bob, o.spot).p;
      o.alt = alt;
      // drift a little sideways
      p.addScaledVector(V().set(1, 0, 0).applyQuaternion(rq), Math.sin(now / 5200 + o.seed * 9) * 0.01 * ws);
      o.obj.position.copy(p);
      o.obj.quaternion.copy(rq);
      o.obj.scale.setScalar(size * sIn + 1e-4);
      o.obj.visible = sIn > 0.02;
      const fa = (o.fade == null ? 1 : o.fade) * o.vis;
      o.obj.userData.mat.uniforms.uA.value = fa;
      o.obj.userData.hull.uniforms.uA.value = fa;
      castShadow(o, size * sIn, sIn * fa);
    }

    // ---- storms: dark cloud + rain + occasional bolt (only spotlit storms flash: attention budget)
    for (const o of this.storms.values()) {
      const k = o.k;
      stepSpot(o, w, k, rq, dt);
      const hv = hover(w, k, rq, 0, o.spot);
      o.vis = smooth(clamp((hv.facing - 0.3) / 0.2, 0, 1));
      const sIn = smooth(clamp((now - o.born) / 700, 0, 1)) * reveal * (o.vis > 0.02 ? 1 : 0);
      const ws = w.ws || 1;
      const size = clamp(w.L.rEq[k] * 0.75, 0.1 * ws, 0.27 * ws) * (0.85 + 0.15 * clamp(o.storm - 0.8, 0, 1.5));
      const alt = 0.1 * ws + size * 0.2;
      const p = hover(w, k, rq, alt + Math.sin(now / 2700 + k) * 0.004 * ws, o.spot).p;
      o.alt = alt;
      o.obj.position.copy(p);
      o.obj.quaternion.copy(rq);
      o.obj.scale.setScalar(size * sIn + 1e-4);
      o.obj.visible = sIn > 0.02;
      const fa = (o.fade == null ? 1 : o.fade) * o.vis;
      o.cloud.userData.mat.uniforms.uA.value = fa;
      o.cloud.userData.hull.uniforms.uA.value = fa;
      o.rain.material.uniforms.uFall.value = (alt / size) * 1.0;
      o.rain.material.uniforms.uA.value = L.rain.a * sIn * (0.4 + 0.6 * fa);
      castShadow(o, size * sIn, sIn * fa);
      // lightning: only spotlit storms (attention budget)
      const may = !!o.blink;
      if (may && now > o.next) {
        o.flashUntil = now + 150;
        o.next = now + (Math.random() < 0.25 ? 260 : 2600 + Math.random() * 3800);
      }
      const on = now < o.flashUntil && reveal > 0.9 && (o.fade == null || o.fade > 0.6);
      o.el.classList.toggle('p3-on', on);
      o.cloud.userData.mat.uniforms.uFlash.value = on ? 1 : 0;
    }

    // ---- fronts: the classic weather-map front on the surface — a solid line, semicircles (inflow, 若竹) or
    // triangles (outflow, 臙脂) every ~22 px on the outward side (sizes in screen pixels)
    const px = 1 / Math.max(60, this.ctx.Rpx || 300);
    for (const f of this.state.fronts) {
      const k = f.k;
      if (!f.geo) continue;
      const pts = f.geo.map((d) => w.surfPos(d, 0.0025 * (w.ws || 1), V()));
      const col = f.dir > 0 ? L.inC : L.outC;
      const a = (f.active ? 1 : 0.6) * reveal;
      sk.ribbon(pts, 2.3 * px, this.ctx.look.halo, () => 0.7 * a);
      sk.ribbon(pts, 1.1 * px, col, () => a);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const Lt = cum[cum.length - 1];
      const gap = 22 * px, sr = 5 * px, th = 6 * px;
      const off = f.active ? ((now / 1000) * 6 * px) % gap : gap * 0.5;
      const anc = w.anchorPos(k, V(), 0.0025 * (w.ws || 1));
      let j = 1;
      for (let s0 = off; s0 < Lt - sr; s0 += gap) {
        if (s0 < sr) continue;
        while (j < cum.length - 1 && cum[j] < s0) j++;
        const u = (s0 - cum[j - 1]) / Math.max(1e-6, cum[j] - cum[j - 1]);
        const p = pts[j - 1].clone().lerp(pts[j], u);
        const t = V().subVectors(pts[j], pts[j - 1]).normalize();
        const nn = V().crossVectors(p, t).normalize();
        if (V().subVectors(anc, p).dot(nn) > 0) nn.negate(); // outward: away from the territory's middle
        if (f.dir > 0) {
          const N = 10;
          let prev = null;
          for (let q = 0; q <= N; q++) {
            const ang = -Math.PI / 2 + (q / N) * Math.PI;
            const pt = p.clone().addScaledVector(nn, Math.cos(ang) * sr).addScaledVector(t, Math.sin(ang) * sr);
            if (prev) sk.tri(p, prev, pt, col, a);
            prev = pt;
          }
        } else {
          const hw = th * 0.62;
          sk.tri(p.clone().addScaledVector(t, -hw), p.clone().addScaledVector(t, hw), p.clone().addScaledVector(nn, th), col, a);
        }
      }
    }

    w.uNCS.value = ncs;

    // ---- intel: dashed 预期风 arrow + bolt tag
    for (const o of this.intelObjs.values()) {
      const k = o.k;
      const camV = V().set(0, 0, 1).applyQuaternion(rq);
      // §26 amendment 5: a story about a deeper place sits on that place (planet3d.js _sync: o.place), as in 2D
      o.vis = smooth(clamp(((o.place ? o.place.dot(camV) : w.facingOf(k)) - 0.3) / 0.15, 0, 1));
      const an = o.place || w.visibleAnchor(k, camV);
      const [fe, fn] = frame3(an, V(), V());
      // "outward": away from the middle of the visible disc (an arrow coming in from open sea)
      const out3 = V().copy(an).addScaledVector(camV, -1).addScaledVector(an, -an.clone().addScaledVector(camV, -1).dot(an));
      let ux = out3.dot(fe), uy = out3.dot(fn);
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-4) { ux = 0.7; uy = -0.7; } else { ux /= ul; uy /= ul; }
      const rot = 0.55;
      const iws = w.ws || 1;
      const len = (0.12 + 0.05 * (o.strength || 1)) * iws;
      const rx = ux * Math.cos(rot) - uy * Math.sin(rot), ry = ux * Math.sin(rot) + uy * Math.cos(rot);
      const far = [rx * len, ry * len];
      const near = [rx * 0.025 * iws, ry * 0.025 * iws];
      const ctrl = [ux * len * 0.75, uy * len * 0.75];
      const [s0, s1] = o.dir > 0 ? [far, near] : [near, far];
      const pts = [];
      const N = 26;
      const q = V();
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = (1 - t) * (1 - t) * s0[0] + 2 * (1 - t) * t * ctrl[0] + t * t * s1[0];
        const y = (1 - t) * (1 - t) * s0[1] + 2 * (1 - t) * t * ctrl[1] + t * t * s1[1];
        offsetDir(an, fe, fn, x, y, q);
        pts.push(w.surfPos(q, 0.004 * iws, V()));
      }
      const col = o.dir > 0 ? L.inC : L.outC;
      const fr = clamp(o.fresh || 0.5, 0.25, 1) * reveal * o.vis;
      const dashPh = (now / 900) % 1;
      sk.ribbon(pts, 0.0058 * iws, L.halo, (i) => (dashOn(i / N, dashPh) ? 0.7 * fr : 0));
      sk.ribbon(pts, 0.003 * iws, col, (i) => (dashOn(i / N, dashPh) ? fr : 0));
      // arrow head at the end
      const e = pts[N], e0 = pts[N - 2];
      const t = V().subVectors(e, e0).normalize();
      const nn = V().crossVectors(e, t).normalize();
      sk.tri(e.clone().addScaledVector(t, 0.016 * iws), e.clone().addScaledVector(nn, 0.011 * iws), e.clone().addScaledVector(nn, -0.011 * iws), col, fr);
      o.obj.position.copy(o.dir > 0 ? pts[0] : pts[N]);
      o.alpha = reveal * o.vis; // the tag itself is placed (and kept legible) by labels.js
    }
    sk.end();
  }

  /** The arc in planet-local space, for label placement (nothing may cover the arc or its head). */
  chanGeo(Rpx) {
    const c = this.chan;
    if (!c || !c.dense || !c.samples) return null;
    const geo = (a) => ({
      samples: a.samples, poly: a.poly, tip: a.tip, base: a.base, start: a.dense[0], apex: a.apex, R0: a.R0 || 0.019,
      prog: a.body.material.uniforms.uProg.value, headPx: (a.R0 || 0.019) * 3.4 * Rpx,
    });
    const out = geo(c);
    out.branch = c.branch && c.branch.dense && c.branch.samples ? geo(c.branch) : null;
    return out;
  }

  /** Screen rects (canvas px) covered by floating props, so labels and cards keep clear of them. */
  blockers(project, Rpx) {
    const out = [];
    const add = (o) => {
      if (!o.obj.visible || o.obj.scale.x < 0.02 || (o.vis != null && o.vis < 0.5)) return;
      const wp = o.obj.getWorldPosition(V());
      const [x, y] = project(wp);
      const r = Math.max(14, o.obj.scale.x * Rpx * 0.55);
      out.push({ x0: x - r, x1: x + r, y0: y - r * 0.95, y1: y + r * 0.4 });
    };
    for (const o of this.clouds.values()) add(o);
    for (const o of this.storms.values()) add(o);
    return out;
  }

  dispose() {
    this._dropChannel();
    for (const o of this.clouds.values()) this._kill(o.obj);
    for (const o of this.storms.values()) this._kill(o.obj);
    for (const o of this.intelObjs.values()) this._kill(o.obj);
    this.sketch.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

function dashOn(t, ph) { return ((t * 7 - ph) % 1 + 1) % 1 < 0.58; }
/** An intel title for the map: no trailing bracket aside, cut at a comma (≤ 16), never mid-bracket. */
export function shortTitle(title) {
  let t = String(title || '').replace(/[（(].*$/, '').trim();
  if (t.length > 16) { const c = t.lastIndexOf('，', 15); t = (c > 6 ? t.slice(0, c) : t.slice(0, 15)) + '…'; }
  return t || String(title || '').slice(0, 15);
}
function ringOn(sk, p, r, wdt, col, a, up) {
  if (a <= 0.01) return;
  const nrm = p.clone().normalize();
  const ax = V().crossVectors(up, nrm);
  if (ax.lengthSq() < 1e-8) ax.set(1, 0, 0); else ax.normalize();
  const ay = V().crossVectors(nrm, ax).normalize();
  const N = 32;
  let po = null, pi = null;
  for (let i = 0; i <= N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const o = p.clone().addScaledVector(ax, Math.cos(ang) * (r + wdt)).addScaledVector(ay, Math.sin(ang) * (r + wdt));
    const n = p.clone().addScaledVector(ax, Math.cos(ang) * (r - wdt)).addScaledVector(ay, Math.sin(ang) * (r - wdt));
    if (po) { sk.tri(po, o, n, col, a); sk.tri(po, n, pi, col, a); }
    po = o; pi = n;
  }
}
/** Where a point's shadow lands on the sphere of radius rr (light Lobj, object space), or null (a direction). */
function castOn(p, Lobj, rr) {
  const pl = p.dot(Lobj);
  const disc = pl * pl - p.lengthSq() + rr * rr;
  if (disc < 0) return null;
  const t = pl - Math.sqrt(disc);
  if (t < 0) return p.clone().normalize();
  return p.clone().addScaledVector(Lobj, -t).normalize();
}
/** A floating prop over territory k: lifted toward the viewer (so it stays over its land on screen) and a little up. */
function hover(w, k, rq, alt, spot) {
  const cam = V().set(0, 0, 1).applyQuaternion(rq);
  const base = w.surfPos(spot || w.visibleAnchor(k, cam), 0.01 * (w.ws || 1), V());
  const radial = base.clone().normalize();
  const facing = radial.dot(cam);
  // lift toward the viewer (stays over its land on screen) and a little up the radial, less so near the limb
  return { p: base.addScaledVector(cam, alt).addScaledVector(radial, alt * 0.3 * clamp((facing - 0.4) / 0.4, 0, 1)), facing };
}
/** Glide a prop's ground spot (a direction) toward the spot the planet chose for it (clear of every label). */
function stepSpot(o, w, k, rq, dt) {
  if (!o.spotTarget) return;
  if (!o.spot) { o.spot = o.spotTarget.clone(); return; }
  o.spot.lerp(o.spotTarget, 1 - Math.exp(-dt * 4)).normalize();
}
/** Screen rect a floating prop would cover with its ground spot at direction d (project: object → px). */
export function propRect(w, o, d, rq, project, Rpx) {
  const p = hover(w, o.k, rq, o.alt || 0.12 * (w.ws || 1), d);
  const [sx, sy] = project(p.p);
  // (§26 amendment 5: in the view unit ws — on a zoomed real Earth a prop is ~0.003 units, and the old 0.01 / 0.15
  // floor made every cloud's box cover the whole screen, so each one faded to 0.16 at ×10–×150)
  const ws = w.ws || 1, sc = o.obj.scale.x > 0.01 * ws ? o.obj.scale.x : 0.15 * ws;
  const hw = sc * Rpx * 0.52;
  // a storm's rain falls below its base: that belongs to it too (no arrowhead or label under the rain)
  return { x0: sx - hw, x1: sx + hw, y0: sy - sc * Rpx * 0.66, y1: sy + (o.rain ? sc * Rpx * 0.5 : 3), facing: p.facing };
}
export function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
