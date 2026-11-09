// planet3d/globe.js — the §26 real Earth that stays put while the camera flies (Google-Earth style).
//
// One persistent globe under every real-mode planet: the calm §25 sea (coast-distance shallows, foam, 等深線, wave
// marks), every continent and island as quiet neutral paper land (1:50m), a faint atlas line along country
// borders, US state lines when zoomed into the US, and — when zoomed in — a 1:10m window (land, coast distances)
// that takes over seamlessly inside a box larger than the screen. Weather-coloured items (World, real mode) sit on
// top. Everything scales with the zoom so the coast, the foam and the dot screen keep their size on screen.
//
//   const g = new Globe(ctx); await g.ready;  scene.add(g.root);
//   g.setView({lon, lat, scale}, {states}); g.update(zoom, quaternion, dt); g.isLand(dir); g.dispose();

import { THREE, MAXT, BASE_R, BAND_EDGES, PLATE_VS, PLATE_FS, HULL_VS, FLAT_FS, OCEAN_VS, OCEAN_FS, BORDER_VS, BORDER_FS } from './core.js';
import { buildLand, NEUTRAL_H } from './world.js';
import { prepareSphere, makeGrid } from '../planet/sphere.js';
import { baseLand, windowLand, borderLines, stateLines, lodBox, boxContains, viewWindow, admin1For, admin1Lines } from '../planet/realearth.js';

const RAD = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const LINE_VS = /* glsl */ `
uniform float uR;
varying float vFace;
varying vec3 vDir;
void main() {
  vec3 d = normalize(position);
  vDir = d;
  vec4 mv = modelViewMatrix * vec4(d * uR, 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFace = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  gl_Position = projectionMatrix * mv;
}
`;
const LINE_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
uniform float uHide;
uniform vec4 uHideBox;
varying float vFace;
varying vec3 vDir;
void main() {
  if (uHide > 0.5) {
    vec3 d = normalize(vDir);
    float hl = asin(clamp(d.y, -1.0, 1.0)), hn = atan(d.x, d.z) - uHideBox.x;
    hn = hn > 3.14159265 ? hn - 6.2831853 : hn < -3.14159265 ? hn + 6.2831853 : hn;
    if (abs(hn) < uHideBox.y && hl > uHideBox.z && hl < uHideBox.w) discard;
  }
  gl_FragColor = vec4(uCol, uA * smoothstep(0.06, 0.3, vFace));
}
`;

function lineGeo(lines) {
  const P = [];
  const v = (lon, lat) => { const a = lon * RAD, b = lat * RAD, c = Math.cos(b); return [c * Math.sin(a), Math.sin(b), c * Math.cos(a)]; };
  for (const L of lines || []) {
    for (let i = 0; i + 1 < L.length; i++) {
      const a = L[i], b = L[i + 1];
      if (Math.abs(a[0] - b[0]) > 180) continue; // a cut at the antimeridian
      // densify long segments so they follow the sphere
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 1.5));
      let p = v(a[0], a[1]);
      for (let s = 1; s <= n; s++) {
        const q = v(a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n);
        P.push(p[0], p[1], p[2], q[0], q[1], q[2]);
        p = q;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  return g;
}

export class Globe {
  constructor(ctx) {
    this.ctx = ctx;
    const U = ctx.U;
    this.root = new THREE.Group();
    this.root.name = 'globe';
    this.zoom = 1;
    this.view = null;
    this.ctxStates = false;
    this.lod = null; // {box, S, plates, coastTex, building}
    this.uInfo = { value: Array.from({ length: MAXT }, () => new THREE.Vector4()) };
    this.uInfo2 = { value: Array.from({ length: MAXT }, () => new THREE.Vector4()) };
    this.uNeutralH = { value: NEUTRAL_H };
    this.uRise = { value: 1 };
    this.uWS = { value: 1 };
    this.uHide = { value: 0 };
    this.uHideBox = { value: new THREE.Vector4() };
    // §26 the real Earth's own paper: unclaimed land lighter / cooler than any weather colour; night tones it down
    this.uNeutralC = { value: new THREE.Vector3() };
    this.uNeutralShC = { value: new THREE.Vector3() };
    this.uSeaK = { value: 1 };
    this.uNeutralDot = { value: 0.5 };
    this.admin1 = new Map(); // ISO2 → {mesh, mat}: province / prefecture borders (amendment 2), lazily per country
    this.admin1Want = new Set();
    this.applyLook(ctx.look);
    this.ready = this._build(U).catch((e) => { console.warn('[planet3d] globe', e); this.failed = true; });
  }

  /** Theme → the globe's own paper and ocean tone (planet3d.js calls it from _applyLook). */
  applyLook(look) {
    if (!look) return;
    this.uNeutralC.value.copy(look.realNeutral || look.neutral);
    this.uNeutralShC.value.copy(look.realNeutralSh || look.neutralSh);
    this.uSeaK.value = look.realSeaK || 1;
    // the real Earth's own sea (refine #3: a navy night sea; by day the planet's pale water)
    const R = look.realSea;
    const S = this.uSea || (this.uSea = { deep: { value: new THREE.Vector3() }, shal: { value: new THREE.Vector3() }, deepSh: { value: new THREE.Vector3() }, shalSh: { value: new THREE.Vector3() }, line: { value: new THREE.Vector3() }, wave: { value: new THREE.Vector3() }, foam: { value: new THREE.Vector3() } });
    S.deep.value.copy(R ? R.deep : look.seaDeep); S.shal.value.copy(R ? R.shal : look.seaShal);
    S.deepSh.value.copy(R ? R.deepSh : look.seaDeepSh); S.shalSh.value.copy(R ? R.shalSh : look.seaShalSh);
    S.line.value.copy(R ? R.line : look.seaLine); S.wave.value.copy(R ? R.wave : look.seaWave); S.foam.value.copy(R ? R.foam : look.foam);
    // unclaimed land: a faint dot screen (an atlas's "no money here") so a 常温 (cream) region never melts into it
    this.uNeutralDot.value = look.day ? 0.5 : 0.4;
  }

  async _build(U) {
    const polys = await baseLand();
    if (this._disposed) return;
    const t0 = performance.now();
    const items = polys.map((p) => ({ id: '__land', neutral: true, rings: p }));
    items.mode = 'real';
    const S = (this.S = prepareSphere(items, [], {}));
    // the sea
    if (!S.coastHalf) { const h = new Uint16Array(S.coast.length); for (let i = 0; i < h.length; i++) h[i] = THREE.DataUtils.toHalfFloat(S.coast[i]); S.coastHalf = h; }
    this.texCoast = halfTex(S.coastHalf, S.W, S.H, true);
    const seaGeo = new THREE.SphereGeometry(1, 192, 120);
    this.seaMat = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS,
      uniforms: {
        uCoastT: { value: this.texCoast }, uSeaDeep: this.uSea.deep, uSeaShal: this.uSea.shal, uSeaDeepSh: this.uSea.deepSh, uSeaShalSh: this.uSea.shalSh,
        uSeaLine: this.uSea.line, uSeaWave: this.uSea.wave, uFoam: this.uSea.foam, uTime: U.uTime, uWaveA: { value: 1 },
        uDS: { value: 1 }, uWS: this.uWS, uLodOn: { value: 0 }, uCoastL: { value: null }, uLodBox: { value: new THREE.Vector4() }, uLodBox2: { value: new THREE.Vector4() }, uSeaK: this.uSeaK,
        uL: U.uL, uMidMix: U.uMidMix, uRimCol: U.uRimCol, uRimAmt: U.uRimAmt,
      },
    });
    this.sea = new THREE.Mesh(seaGeo, this.seaMat);
    this.sea.renderOrder = 0;
    this.root.add(this.sea);
    this.hullMat = new THREE.ShaderMaterial({
      vertexShader: HULL_VS, fragmentShader: FLAT_FS, side: THREE.BackSide,
      uniforms: { uW: U.uHullW, uRes: U.uRes, uGrow: { value: BASE_R - 1 - 0.003 }, uCol: U.uOutline, uA: { value: 1 } },
    });
    this.hull = new THREE.Mesh(seaGeo, this.hullMat);
    this.hull.renderOrder = 1;
    this.root.add(this.hull);
    // the land: quiet neutral paper, every coast
    const { geo, lines } = buildLand(S, 0, null);
    this.landMat = this._plateMat(U, this.uHide, this.uHideBox);
    this.land = new THREE.Mesh(geo, this.landMat);
    this.land.renderOrder = 0;
    this.root.add(this.land);
    lines.dispose();
    // coast hairline + faint country borders (an atlas, not a political map)
    this.lineR = { value: 1 + NEUTRAL_H + 0.0006 };
    this.coastMat = this._lineMat(U.uBorder, 0.5);
    this.coast = new THREE.LineSegments(lineGeo(polys.flatMap((p) => p.map((r) => r))), this.coastMat);
    this.coast.renderOrder = 2;
    this.root.add(this.coast);
    this.stats = { buildMs: performance.now() - t0 };
    borderLines().then((b) => {
      if (this._disposed) return;
      this.bordMat = this._lineMat(U.uOutline, 0.16, false); // (country borders stay on inside the 1:10m window)
      this.bord = new THREE.LineSegments(lineGeo(b), this.bordMat);
      this.bord.renderOrder = 2;
      this.root.add(this.bord);
    }).catch((e) => console.info('[planet3d] borders', e && e.message));
  }

  _plateMat(U, uHide, uHideBox) {
    return new THREE.ShaderMaterial({
      vertexShader: PLATE_VS, fragmentShader: PLATE_FS,
      uniforms: {
        uInfo: this.uInfo, uInfo2: this.uInfo2, uRise: this.uRise, uNeutralH: this.uNeutralH,
        uWallMix: U.uWallMix, uBands: U.uBands, uBandsSh: U.uBandsSh, uEdges: { value: BAND_EDGES.slice() }, uHatch: U.uHatch, uHatchA: U.uHatchA,
        uDimCol: U.uDimCol, uInk: U.uInk, uNeutral: this.uNeutralC, uNeutralSh: this.uNeutralShC, uScen: { value: 0 }, uTime: U.uTime, uPR: U.uPR,
        uRip: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uNRip: { value: 0 },
        uCS: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 1, 0.01)) }, uNCS: { value: 0 },
        uWS: this.uWS, uHide, uHideBox, uNeutralDot: this.uNeutralDot,
        uL: U.uL, uMidMix: U.uMidMix, uRimCol: U.uRimCol, uRimAmt: U.uRimAmt,
      },
    });
  }

  /** hide: false for context lines that are not part of the 1:50m coast (states / provinces stay inside the 1:10m window) */
  _lineMat(col, a, hide = true) {
    return new THREE.ShaderMaterial({
      vertexShader: LINE_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false,
      uniforms: { uR: this.lineR, uCol: col, uA: { value: a }, uHide: hide ? this.uHide : { value: 0 }, uHideBox: this.uHideBox },
    });
  }

  /** The node's view (and its context layers): US states when asked for; a 1:10m window when zoomed in. */
  setView(view, context = {}, opts = {}) {
    this.view = view;
    this.detail = opts.detail || null;
    const want = !!(context && context.states);
    if (want !== this.ctxStates) {
      this.ctxStates = want;
      if (want && !this.states && !this._statesP) {
        this._statesP = stateLines().then((L) => {
          if (this._disposed) return;
          this.statesMat = this._lineMat(this.ctx.U.uOutline, 0, false);
          this.states = new THREE.LineSegments(lineGeo(L), this.statesMat);
          this.states.renderOrder = 2;
          this.root.add(this.states);
        }).catch((e) => console.info('[planet3d] states', e && e.message));
      }
    }
    this._wantLod(view);
    this._wantAdmin1(view, context);
  }

  /**
   * §26 amendment 2 — every market gets the same care: faint province / state / prefecture borders for the countries
   * in a zoomed view (context.admin1 when the layout names them, else every vendored country whose box meets the view).
   */
  _wantAdmin1(view, context = {}) {
    const tok = (this._a1Tok = (this._a1Tok || 0) + 1);
    if (!view || !(view.scale >= 1.6)) { this.admin1Want = new Set(); return; }
    const box = viewWindow(view, this.ctx.aspect || 1.6, 1.2);
    const given = Array.isArray(context.admin1) ? Promise.resolve(context.admin1.filter((c) => c !== 'US')) : admin1For(box, { skip: ['US'] });
    given.then((ccs) => {
      if (this._disposed || tok !== this._a1Tok) return;
      this.admin1Want = new Set(ccs.slice(0, 12));
      for (const cc of this.admin1Want) {
        if (this.admin1.has(cc)) continue;
        const o = { mesh: null, mat: null };
        this.admin1.set(cc, o);
        admin1Lines(cc).then((L) => {
          if (this._disposed || !L.length) return;
          o.mat = this._lineMat(this.ctx.U.uOutline, 0, false);
          o.mesh = new THREE.LineSegments(lineGeo(L), o.mat);
          o.mesh.renderOrder = 2;
          o.mesh.visible = false;
          this.root.add(o.mesh);
        }).catch((e) => { console.info('[planet3d] admin1', cc, e && e.message); });
      }
    }).catch(() => {});
  }

  /**
   * refine (#4): the lon/lat box the SCREEN shows for a view (× margin) — measured from the free area's centre to the
   * farthest canvas edge (the panel / bars sit over the canvas, the view centre is off the canvas centre), so the
   * 1:10m window's edge (a straight seam across the sea, an island sliced flat) never comes into sight.
   */
  _screenBox(view, m) {
    const S = this.ctx.screen;
    if (!S || !S.R) return viewWindow(view, this.ctx.aspect || 1.6, 1.3 * m / 1.25);
    // the angle from the view centre to the farthest canvas edge (the globe's screen radius is R · zoom)
    const Rz = S.R * Math.max(1, view.scale);
    const ang = (px) => Math.min(90, (Math.asin(Math.min(1, px / Rz)) / RAD) * m);
    const hy = ang(Math.max(S.cy, S.H - S.cy)), hx = ang(Math.max(S.cx, S.W - S.cx));
    const lat0 = Math.max(-85, view.lat - hy), lat1 = Math.min(85, view.lat + hy);
    const pole = Math.min(82, Math.abs(view.lat) + hy);
    const c = Math.max(0.18, Math.cos(pole * RAD));
    return { lon: view.lon, lat0, lat1, span: Math.min(200, (2 * hx) / c) };
  }

  _wantLod(view) {
    if (!view) { this._lodTarget = null; return; }
    const aspect = this.ctx.aspect || 1.6;
    // 1:10m when zoomed in — or as soon as the items themselves were clipped with 1:10m coasts (so they match)
    // (regions clipped with 1:50m keep the 1:50m coast until the view is < 7° across, where real.js switches too)
    const minS = this.detail === '10m' ? 1.5 : this.detail === '50m' ? 8.2 : 2.6;
    const box0 = lodBox(view, aspect, minS);
    if (!box0) { this._lodTarget = null; return; }
    const box = this.ctx.screen ? this._screenBox(view, 1.3) : box0;
    const cur = this.lod && this.lod.box;
    // keep the current window while all the screen shows sits inside it, at a similar zoom
    if (cur && boxContains(cur, view.lon, view.lat) && Math.abs(cur.span / box.span - 1) < 0.6) {
      const need = this._screenBox(view, 1.05);
      const dl = Math.abs(((((need.lon - cur.lon) % 360) + 540) % 360) - 180);
      if (need.lat0 >= cur.lat0 && need.lat1 <= cur.lat1 && dl + need.span / 2 <= cur.span / 2) { this._lodTarget = cur; return; }
    }
    this._lodTarget = box;
    const tok = (this._lodTok = (this._lodTok || 0) + 1);
    windowLand(box).then((polys) => {
      if (this._disposed || tok !== this._lodTok) return;
      const t0 = performance.now();
      const items = polys.map((p) => ({ id: '__lod', neutral: true, rings: p }));
      const S = prepareSphere(items, [], { box, segMin: 0.00022 });
      const { geo, lines } = buildLand(S, 0, null, { steiner: Math.max(0.004, Math.min(0.03, 0.03 * (box.span / 60))) });
      lines.dispose();
      const h = new Uint16Array(S.coast.length);
      for (let i = 0; i < h.length; i++) h[i] = THREE.DataUtils.toHalfFloat(S.coast[i]);
      const tex = halfTex(h, S.W, S.H, false);
      const mat = this._plateMat(this.ctx.U, { value: 0 }, { value: new THREE.Vector4() });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 0;
      const coast = new THREE.LineSegments(lineGeo(polys.flatMap((p) => p)), this._lineMat(this.ctx.U.uBorder, 0.5));
      coast.material.uniforms.uHide = { value: 0 };
      coast.renderOrder = 2;
      this._dropLod();
      this.lod = { box, S, mesh, coast, tex, grid: S.grid, ms: performance.now() - t0 };
      this.root.add(mesh); this.root.add(coast);
      const G = S.grid;
      this.uHideBox.value.set(G.lonC, G.dLon / 2 - 1e-4, G.lat1 - G.dLat, G.lat1);
      this.uHide.value = 1;
      const su = this.seaMat.uniforms;
      su.uCoastL.value = tex; su.uLodOn.value = 1;
      su.uLodBox.value.set(G.lonC, G.lon0, G.dLon, 0); su.uLodBox2.value.set(G.lat1, G.dLat, 0, 0);
    }).catch((e) => console.info('[planet3d] 1:10m window', e && e.message));
  }

  _dropLod() {
    const L = this.lod;
    if (!L) return;
    this.root.remove(L.mesh); this.root.remove(L.coast);
    L.mesh.geometry.dispose(); L.mesh.material.dispose(); L.coast.geometry.dispose(); L.coast.material.dispose(); L.tex.dispose();
    this.lod = null;
    this.uHide.value = 0;
    if (this.seaMat) { this.seaMat.uniforms.uLodOn.value = 0; this.seaMat.uniforms.uCoastL.value = null; }
  }

  /** Per frame: zoom-scaled sizes (coast distances, dot screen, shelf height), orientation, context fades. */
  update(zoom, q, dt) {
    this.zoom = zoom;
    if (q) this.root.quaternion.copy(q);
    const ws = 1 / Math.max(1, zoom);
    this.uWS.value = ws;
    this.uNeutralH.value = NEUTRAL_H * 0.42 * Math.sqrt(ws); // = World.neutralH() in real mode
    this.lineR.value = 1 + this.uNeutralH.value + 0.0005 * Math.sqrt(ws);
    if (this.seaMat) this.seaMat.uniforms.uDS.value = zoom;
    if (this.statesMat) {
      const a = this.ctxStates ? 0.22 * clamp((zoom - 1.3) / 0.8, 0, 1) : 0;
      const u = this.statesMat.uniforms.uA;
      u.value += (a - u.value) * (1 - Math.exp(-(dt || 0.016) * 4));
      this.states.visible = u.value > 0.01;
    }
    if (this.bordMat) this.bordMat.uniforms.uA.value = 0.1 + 0.08 * clamp((zoom - 1) / 2, 0, 1);
    // the 1:10m window only while zoomed in (and only once it is built)
    if (this.lod && (!this._lodTarget || this._lodTarget !== this.lod.box) && zoom < (this.detail === '10m' ? 1.3 : this.detail === '50m' ? 7.6 : 2.2)) this._dropLod();
    // province / prefecture borders: the same faint style as the US states, fading in with the zoom
    for (const [cc, o] of this.admin1) {
      if (!o.mesh) continue;
      const a = this.admin1Want.has(cc) ? 0.18 * clamp((zoom - 1.5) / 0.8, 0, 1) : 0;
      const u = o.mat.uniforms.uA;
      u.value += (a - u.value) * (1 - Math.exp(-(dt || 0.016) * 4));
      o.mesh.visible = u.value > 0.01;
    }
  }

  /** Is there land under unit vector d (object space)? */
  isLand(d) {
    const x = d.x !== undefined ? d.x : d[0], y = d.y !== undefined ? d.y : d[1], z = d.z !== undefined ? d.z : d[2];
    const L = this.lod;
    if (L) { const o = L.S.ownerAt(x, y, z); if (o !== -1) return o === -2; if (boxContains(L.box, Math.atan2(x, z) / RAD, Math.asin(clamp(y, -1, 1)) / RAD)) return false; }
    return this.S ? this.S.ownerAt(x, y, z) === -2 : false;
  }

  dispose() {
    this._disposed = true;
    this._dropLod();
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this.texCoast) this.texCoast.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

function halfTex(data, W, H, wrap) {
  const t = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export { makeGrid };
