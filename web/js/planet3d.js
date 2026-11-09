// planet3d.js — the money planet as a real toon-shaded 3D globe (DESIGN §22), same API as planet.js.
// Contract: §7 (exports/callbacks), §18 (overlays, setTheme, onContextMenu), §6 (≤ 3 spotlights), §8.1
// (主航道 hero arc + ①②③), §8.2 (seasons), §14 (估), §17 (日式干净卡通: cel shading, ink outline, paper/navy).
//
//   const planet = new Planet3D(canvas, { onHover(child|null, {x,y}), onClick(child), onBack(),
//                                         onContextMenu(child, {x,y}), onSlow(stats), theme, keys });
//   await planet.setNode(node, mapJson, { direction: 'in'|'out'|'none', focusChildId });
//   planet.setDate(i); planet.setLens(tag|null); planet.setSpotlight([{id, why}]); planet.setPins(ids);
//   planet.setOverlay(name, data|null); planet.setTheme('day'|'night'); planet.setInsets({top,right,bottom,left});
//   planet.resize(); planet.pause(); planet.resume(); planet.getChildScreenRect(id); planet.getStats(); planet.destroy();
//   planet.faceChild(id)   (extra: turn the globe so that territory faces the viewer, e.g. from a ①②③ card)
//   overlays (§18 + §24): channel, numbers, clouds, intel, scenario, estimates, seasons, liquidity
//     channel may carry to2 (a second destination: a thinner branch arc; also inferred from the sentence)
//     channel / numbers start EMPTY (the shell sends the real ones; nothing flips a second later) unless
//     opts.autoOverlays; while 'scenario' is on, the channel / numbers set right after it (scenario.js) win
//     over any measured ones the shell pushes later, until 推演 closes.
//
// Attention (§6): ①②③ cards + the 主航道 caption are the only boxed captions. Everything else on the map
// whispers (halo text): Polymarket cloud words, intel words and the 水位 line speak only for the hovered
// territory / band, or — at most one, while ①②③ + 主航道 leave room — on a ①②③ territory (水位: on news).
// Rain = 风暴 only (measured storm ≥ 0.8); intel is a small dashed ⚡ tag (owner-fed, or a scout find on a
// ①②③ / holding territory; ≤ 2 per planet). Labels appear only once the rest pose is final (no sliding).
//
// Look (§25): a small Earth — every child is a landmass (organic islands, or real countries on the 全球 map),
// raised as a paper-cut plate (|wind|), in a calm pale sea (~70 % of the globe: shallows, a foam line on every
// coast, 等深線 rings, sparse wave marks); money (wind lines) crosses the water between landmasses; the 主航道 is
// a great-circle sea route; an atmosphere band (the §24 liquidity pressure).
// Orientation: north up, a 3/4 rest pose chosen once per planet (setNode) so the 主航道 and ①②③ face the
// viewer with as much land as possible on the visible face, then frozen — date changes, ▶ play, overlays and
// spotlights never swing it (same layout every visit, §4). §26 free camera (planet3d/freecam.js + planet/controls.js):
// drag turns the globe freely (inertia), wheel / pinch zoom at the cursor, ＋ / － / 回正 / compass; the manual view
// stays (refreshes and date changes keep it) until 回正 or a new level. The wheel never changes level.
// setNode(node, map, {direction, focusChildId, geo: 'real'|'earth'|'abstract'}) — geo defaults to opts.geoMode(node)
// (main.js: app.state.geoMode — 'real' by default, §26) or, without it, 'earth' for gl-* nodes.
// §26 真实 (geo 'real', when geo/real.js answers): ONE real Earth (planet3d/globe.js) that never swaps — setNode flies
// the camera (rotation + a telephoto zoom, Google-Earth style: out a little, across, in) to layout.view; the old
// node's coloured regions sink back into the land while the new ones rise. Companies are small crisp markers at
// their HQs (a crowded city fans out), names appear by zoom; sea areas tint the ocean; coastlines go 1:10m when
// zoomed. Every size in object space is scaled by 1/zoom so the weather keeps its size on screen.
//
// §26 amendment 4 (real admin borders): every territory is the dissolved union of real admin units (geo/real.js); on
// top of the paper-cut plates World draws faint fold lines between two units of one territory, faint unclaimed unit
// borders from county zoom on, minority dots (item.ticks) and an ink ring round a speck (item.tiny); hovering a unit
// shows '海淀区 · AI 算力 · 也有 金融 3 家' with its money (planet/units.js UnitTag). The free camera reaches ×150; when it
// rests outside layout.lod (states ×≤3.63 → counties → cities / 区 ×≥40) or far from the window the world was built
// for, the world is rebuilt in place from geo.getLayout(…, {zoom, at}) (_reask / _swapReal: a short cross-fade, the
// camera untouched; also re-seeds the wind where the camera looks). A ①②③ about a deeper place points at
// item.childAt[deepId] ('→ 孟买' when it is over the horizon). placeCaption(id, {w, h}, {ring}) scores the shell's
// 主航道 card off the cards (null until they are final); setHeroAnchor(id) turns the rest pose toward a one-ended 主航道.
//
// Throws (from the constructor) when WebGL2 is not available — main.js should catch and use the 2D Planet.
// It never touches a 2D context, so the same <canvas> stays usable for the fallback in that case.
// After a successful construction the canvas holds a WebGL context: to fall back later (opts.onSlow),
// destroy() this instance and give the 2D Planet a fresh <canvas> (canvas.replaceWith(clone)).
//
// Rendering: three.js r170 (vendored). §25: every planet is a small Earth — the children are landmasses from
// geo/index.js (abstract islands, or real countries on the 全球 map: setNode(…, {geo: 'earth'})), prepared by
// planet/sphere.js, raised as plates (|wind|) in a calm sea; money (wind lines) crosses the water between them.

import { THREE, look as lookOf, SKY_VS, SKY_FS, VEIL_FS, lookQuat } from './planet3d/core.js';
import { World, seriesLen, LAGS } from './planet3d/world.js';
import { Wind } from './planet3d/wind.js';
import { Fx, ARC_LAYER, propRect } from './planet3d/fx.js';
import { Labels, injectStyle, cssVars } from './planet3d/labels.js';
import { loadProps } from './planet3d/assets.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { getLayout, onProvidersChange } from './geo/index.js';
import { prepareSphere, dirOf, lonLatOf } from './planet/sphere.js';
import { Globe } from './planet3d/globe.js';
import { restAim, aimImp } from './planet/aim.js'; // §26 amendment 5: one rest pose for 2D and 3D
import { cities, viewWindow, boxContains } from './planet/realearth.js';
import { unitModel, unitFiles, unitHit, unitText, tickText, UnitTag } from './planet/units.js'; // §26 amendment 4
import { FreeCam3D } from './planet3d/freecam.js'; // §26 free camera
import { deepPlace } from './planet/units.js'; // §26 amendment 5: an intel tag sits on the deeper place (as 2D)

const OVERLAYS = ['channel', 'numbers', 'clouds', 'intel', 'scenario', 'estimates', 'seasons', 'liquidity'];
const LIQ_STATES = ['放水', '收水', '平稳'];
const SEASON_KEYS = ['spring', 'summer', 'autumn', 'winter'];
const SEASON_ALIAS = { '春': 'spring', '夏': 'summer', '秋': 'autumn', '冬': 'winter', '🌱': 'spring', '☀️': 'summer', '🍂': 'autumn', '❄️': 'winter' };
const FOV = 22;
const QUALITY = [
  { pr: 2, wind: 1 },
  { pr: 1.5, wind: 0.8 },
  { pr: 1.15, wind: 0.62 },
  { pr: 0.85, wind: 0.45 },
];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const Z = new THREE.Vector3(0, 0, 1);
const AX_X = new THREE.Vector3(1, 0, 0), AX_Y = new THREE.Vector3(0, 1, 0);
const Q0 = new THREE.Quaternion();
const TILT = +((globalThis.__P3 || {}).tilt) || 0.3; // 3/4 rest pose: the cap's pole is turned this far (rad) off the view axis
const HOLD_MS = 12000; // a drag is kept this long after release
const DEPTH_LAYER = 2; // depth-only globe for the 主航道 pass (the arc goes behind the horizon, never through it)
const AIM_GRACE = 1500; // overlays that arrive this soon after a flight may still steer the rest pose
const ZMAX_REAL = 150; // §26 amendment 4: the free camera reaches city level (admin3 from ×40, real.js levelForZoom)

function normSeason(v) {
  if (v && typeof v === 'object') v = v.key;
  if (typeof v !== 'string') return null;
  if (SEASON_KEYS.includes(v)) return v;
  return SEASON_ALIAS[v] || null;
}

/** Great-circle distance (deg) between two lon/lat points. */
function angDeg(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2), b = Math.sin(((lon2 - lon1) * r) / 2);
  return (2 * Math.asin(Math.min(1, Math.sqrt(a * a + Math.cos(lat1 * r) * Math.cos(lat2 * r) * b * b)))) / r;
}
/** The middle part (× f) of a lon/lat window: the camera may wander this far before the window is rebuilt. */
function shrinkBox(B, f) {
  const h = ((B.lat1 - B.lat0) * f) / 2, c = (B.lat0 + B.lat1) / 2;
  return { lon: B.lon, lat0: c - h, lat1: c + h, span: B.span * f };
}

export class Planet3D {
  /** true when this browser can run the 3D planet (WebGL2). Uses a throw-away canvas. */
  static isSupported() {
    try {
      if (typeof window === 'undefined' || !window.WebGL2RenderingContext) return false;
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return false;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) { return false; }
  }

  constructor(canvas, opts = {}) {
    if (!Planet3D.isSupported()) throw new Error('Planet3D: 这个浏览器不支持 WebGL2，3D 星球画不出来（请用 2D 地图）');
    this.canvas = canvas;
    this.cb = {
      onHover: opts.onHover || (() => {}),
      onClick: opts.onClick || (() => {}),
      onBack: opts.onBack || (() => {}),
      onContextMenu: opts.onContextMenu || null,
      onSlow: opts.onSlow || null,
    };
    this.opts = { keys: !!opts.keys, radiusScale: opts.radiusScale || +((globalThis.__P3 || {}).rs) || 0.84, aimDir: opts.aimDir || null, autoOverlays: !!opts.autoOverlays, geoMode: opts.geoMode || null, mapKey: opts.mapKey || null };
    this.insets = Object.assign({ top: 0, right: 0, bottom: 0, left: 0 }, opts.insets || {});
    this.avoidIds = opts.avoidIds || ['gauges', 'pins', 'since', 'holdings'];
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    } catch (e) {
      throw new Error('Planet3D: 无法创建 WebGL 画布（' + (e && e.message) + '），请用 2D 地图');
    }
    const r = this.renderer;
    r.autoClear = false;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    this._lost = false;
    canvas.addEventListener('webglcontextlost', (this._onLost = (e) => { e.preventDefault(); this._lost = true; }));
    canvas.addEventListener('webglcontextrestored', (this._onRestored = () => { this._lost = false; }));

    injectStyle();
    this.layer = document.createElement('div');
    this.layer.className = 'p3-layer';
    canvas.after(this.layer);
    this.css = new CSS2DRenderer({ element: this.layer });
    this.layer.style.position = 'fixed';
    this.layer.style.overflow = 'hidden';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
    this.camera.position.set(0, 0, 5);
    this.skyScene = new THREE.Scene();
    this.skyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.look = lookOf(opts.theme === 'night' ? 'night' : 'day');
    this.U = this._makeUniforms();
    this.ctx = { U: this.U, look: this.look, bandDark: this.look.bandDark, D: 5, Rpx: 300 };
    this._applyLook();
    const skyGeo = new THREE.PlaneGeometry(2, 2);
    this.skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this._skyUniforms(1), depthTest: false, depthWrite: false });
    this.fadeMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this._skyUniforms(0), depthTest: false, depthWrite: false, transparent: true });
    this.fadeMat.uniforms.uDropA.value = 0;
    this.skyMesh = new THREE.Mesh(skyGeo, this.skyMat);
    this.fadeMesh = new THREE.Mesh(skyGeo, this.fadeMat);
    this.skyMesh.frustumCulled = this.fadeMesh.frustumCulled = false;
    this.skyScene.add(this.skyMesh);
    this.fadeScene = new THREE.Scene();
    this.fadeScene.add(this.fadeMesh);
    // §26 the paper veil behind the shell's chrome when a zoomed real Earth fills the screen
    this.veilMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: VEIL_FS, depthTest: false, depthWrite: false, transparent: true,
      uniforms: {
        uSky0: this.skyMat.uniforms.uSky0, uSky1: this.skyMat.uniforms.uSky1, uRes: this.skyMat.uniforms.uRes, uPlanet: this.skyMat.uniforms.uPlanet,
        uRects: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uN: { value: 0 }, uPR: this.U.uPR, uA: { value: 0 },
      },
    });
    this.veilMesh = new THREE.Mesh(skyGeo, this.veilMat);
    this.veilMesh.frustumCulled = false;
    this.veilScene = new THREE.Scene();
    this.veilScene.add(this.veilMesh);

    const P = loadProps();
    this.props = P.now;
    P.ready.then((p) => {
      if (p && p !== this.props && !this._destroyed) { this.props = p; this._rebuildFx(); }
    });

    this.W = 0; this.H = 0; this.pr = 1;
    this.q = 0; // quality level
    this.view = { cx: 0, cy: 0, R: 100, D: 5 };
    this.viewTarget = null;
    this.zoom = 1; // §26: camera zoom (telephoto) on the real Earth; 1 = the whole globe fits
    this.globe = null;
    this._offProv = onProvidersChange(() => this._providersChanged());
    this.live = null; // {world, wind, fx, labels}
    this.tr = null;
    this.dateIndex = null;
    this.lens = null;
    this.spot = null;
    this.pins = new Set();
    // the shell (main.js) drives channel / numbers: nothing shows until its real values arrive (no fallback
    // caption that flips a second later). Standalone pages pass {autoOverlays: true} for the derived defaults.
    const auto0 = this.opts.autoOverlays ? 'auto' : null;
    this.ov = { channel: auto0, numbers: auto0, seasons: 'auto', clouds: null, intel: null, scenario: null, estimates: null, liquidity: null };
    // 推演: the scenario module's own channel / numbers (set right after its 'scenario' overlay) win over
    // the measured ones for as long as the imagined weather is on (see setOverlay)
    this.ovScn = null;
    this._scnCap = false;
    this.hoverIdx = -1;
    this.rot = { q: new THREE.Quaternion(), wx: 0, wy: 0, release: 0, dragging: false };
    this._dirty = true;
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this.stats = { fps: 60, frameMs: 16.7, steadyMs: 16.7, workMs: 0, fieldMs: 0, particles: 0, quality: 0, frames: 0, calls: 0, triangles: 0 };
    this._slowT = 0;
    this._adaptT = 0;
    this._raycaster = new THREE.Raycaster();
    this._tmpM = new THREE.Matrix4();

    this._frameBound = (t) => this._frame(t);
    this._bind();
    this._fc = new FreeCam3D(this); // §26 free camera: drag / wheel / pinch / keys / ＋－回正 / compass (planet3d/freecam.js)
    this._utag = new UnitTag(); // §26 amendment 4: '海淀区 · AI 算力 · 也有 金融 3 家' while the pointer rests on a unit
    this.resize();
    this.resume();
  }

  // ============================================================================== public API
  async setNode(node, mapJson, { direction = 'none', focusChildId, geo } = {}) {
    if (!node) return;
    const tok = (this._navTok = (this._navTok || 0) + 1);
    this._reaskForce = false; clearTimeout(this._reaskT); // (this layout is asked fresh)
    // §25/§26 geometry: the children as landmasses (abstract islands / silhouettes, real countries on the 全球 map)
    // or — 真实 — places on the one real Earth
    const mode = geo === 'earth' || geo === 'abstract' || geo === 'real' ? geo : typeof this.opts.geoMode === 'function' ? this.opts.geoMode(node) : this.opts.geoMode || guessGeo(node);
    // the reading changed on the same node (top-bar 真实 | 抽象): the old globe stays drawn while the new layout is
    // computed, then the two cross-fade (no blank paper frame in between)
    const prevNav = this._lastNav;
    this._xfade = !!(prevNav && this.live && prevNav.node && prevNav.node.id === node.id && (prevNav.mode === 'real') !== (mode === 'real'));
    this._lastNav = { node, mapJson, mode };
    let S = null, list = null;
    try {
      // §26 free camera: a refresh of the same node keeps the manual view — and the admin-unit level of its zoom
      const fcCam = mode === 'real' ? this._manualCam(node) : null;
      list = await getLayout(node, node.children || [], mapJson, Object.assign({ mode, map: typeof this.opts.mapKey === 'function' ? this.opts.mapKey() : undefined }, fcCam ? { zoom: fcCam.zoom, at: [fcCam.lon, fcCam.lat] } : {}));
      if (list && list.mode === 'real') {
        if (tok !== this._navTok || this._destroyed) return;
        return this._setNodeReal(tok, node, mapJson, list, direction, focusChildId, fcCam);
      }
      S = this._prep(list, node);
    } catch (e) { console.warn('[planet3d] layout', e); }
    if (tok !== this._navTok || this._destroyed) return;
    this._leaveReal();
    const now = performance.now();
    if (this.dateIndex == null) {
      const len = seriesLen(mapJson);
      this.dateIndex = len ? len - 1 : null;
    }
    // finish any running flight first
    if (this.tr) this._endTransition(true);
    const prev = this.live;
    const next = this._makeLive(node, mapJson, S);
    if (!(this._fc && this._fc.keep(node, mode))) this._resetRot(); // §26 free camera: a refresh keeps the manual view
    if (this.hoverIdx >= 0) this._setHover(-1, null);
    let k = null;
    if (prev && direction === 'in') {
      const kk = prev.world.idxOf.get(focusChildId || node.id);
      if (kk != null) k = kk;
    } else if (direction === 'out' && focusChildId) {
      const kk = next.world.idxOf.get(focusChildId);
      if (kk != null) k = kk;
    }
    const snapped = !!(prev && this._xfade && this.running && this._snapFade(400, next.world.root));
    this.live = next;
    next.aimLockAt = Infinity; // set when the flight ends (see _endTransition)
    this._dirty = true;
    let dir = !prev ? 'intro' : k == null && (direction === 'in' || direction === 'out') ? 'none' : direction;
    if (prev && prev.world.real) dir = 'none'; // leaving the real Earth (toggle 抽象, or a fallback layer)
    if (prev && snapped) dir = 'swap';
    if (!this.running) {
      if (prev) this._disposeLive(prev);
      next.reveal = 1;
      next.aimLockAt = now + AIM_GRACE;
      next.gateOn = true; next.labGate = 1;
      this._renderOnce(now);
      return;
    }
    const dur = dir === 'in' ? 1150 : dir === 'out' ? 1050 : dir === 'intro' ? 700 : 560;
    next.reveal = 0;
    return new Promise((resolve) => {
      const tr = { dir, t0: now, dur, from: prev, to: next, k, resolve };
      if (prev && dir === 'in') {
        tr.q0 = prev.world.root.quaternion.clone();
        tr.q1 = lookQuat(prev.world.anchorDir[k]);
        tr.S = this._zoomScale(prev.world, k);
      }
      if (dir === 'out') {
        tr.q0 = lookQuat(next.world.anchorDir[k]);
        tr.q1 = new THREE.Quaternion();
        tr.S = this._zoomScale(next.world, k);
      }
      this.tr = tr;
    });
  }

  // ============================================================================== §26 the real Earth
  /** Camera window (deg) a zoomed view needs for its rasters / wind: ~1.7× what the screen shows. */
  _viewBox(v, z, aspect) { return viewWindow({ lon: v.lon, lat: v.lat, scale: z }, aspect, 1.6); }

  /**
   * setNode on the real Earth: the globe stays, the camera flies to layout.view (rotation + telephoto zoom, out a
   * little when the hop is long), the old node's regions sink back into the land while the new ones rise.
   */
  async _setNodeReal(tok, node, mapJson, list, direction, focusChildId, fcCam = null) {
    if (!this.globe) { this.globe = new Globe(this.ctx); this.globe.root.visible = false; this.scene.add(this.globe.root); }
    await this.globe.ready;
    if (tok !== this._navTok || this._destroyed) return;
    if (this.globe.failed) return this.setNode(node, mapJson, { direction, focusChildId, geo: 'abstract' });
    const v = list.view || { lon: 0, lat: 20, scale: 1 };
    const z = clamp(+v.scale || 1, 1, ZMAX_REAL);
    const aspect = this.W / Math.max(1, this.H);
    this.ctx.aspect = aspect;
    let next;
    try { next = this._realLive(node, mapJson, list, fcCam || { lon: v.lon, lat: v.lat, zoom: z }); } catch (e) {
      console.warn('[planet3d] real layout', e);
      return this.setNode(node, mapJson, { direction, focusChildId, geo: 'abstract' });
    }
    const now = performance.now();
    if (this.tr) this._endTransition(true);
    const prev = this.live;
    const q0 = prev ? prev.world.root.quaternion.clone() : null;
    const target = new THREE.Vector3(...dirOf(v.lon, v.lat));
    next.realView = { lon: v.lon, lat: v.lat, zoom: z, dir: target, context: list.context || {} };
    next.aimTarget = lookQuat(target);
    next.aimQ = next.aimTarget.clone();
    next.aimLocked = true;
    next.lockedAt = now;
    this.globe.setView(fcCam ? { lon: fcCam.lon, lat: fcCam.lat, scale: fcCam.zoom } : { lon: v.lon, lat: v.lat, scale: z }, list.context || {}, { detail: list.detail });
    next.world.frontDir.copy(target); // the 主航道 bows toward the viewer
    const kept = !!(this._fc && this._fc.keep(node, 'real')); // §26 free camera: a refresh keeps the manual view
    if (!kept) this._resetRot();
    if (this.hoverIdx >= 0) this._setHover(-1, null);
    const snapped = !!(prev && this._xfade && this.running && this._snapFade(400, next.world.root));
    this.live = next;
    this._dirty = true;
    if (!this.running) {
      if (prev) this._disposeLive(prev);
      this.zoom = z;
      next.reveal = 1; next.gateOn = true; next.labGate = 1;
      this._renderOnce(now);
      return;
    }
    next.reveal = 0;
    let dir = !prev ? 'intro' : prev.world.real && !kept ? 'fly' : 'none';
    if (prev && snapped) { dir = 'swap'; this.zoom = z; }
    return new Promise((resolve) => {
      const tr = { dir, t0: now, dur: 560, from: prev, to: next, resolve, z1: z };
      if (dir === 'intro') { tr.dur = 900; this.zoom = z; }
      if (dir === 'fly') {
        // Google-Earth hop: zoom out enough to see both places, swing across, zoom in (log-space Bézier)
        const from = new THREE.Vector3(0, 0, 1).applyQuaternion(q0.clone().invert());
        const th = from.angleTo(target);
        const z0 = this.zoom;
        const fit = Math.max(1, 0.92 / Math.sin(Math.min(Math.PI / 2, th / 2 + Math.asin(Math.min(1, 1 / Math.max(z0, z))) * 0.6)));
        const zm = Math.min(z0, z, fit);
        tr.q0 = q0; tr.q1 = next.aimTarget.clone(); tr.z0 = z0;
        tr.la = Math.log(z0); tr.lb = Math.log(z);
        const lm = Math.log(zm);
        tr.lc = lm < Math.min(tr.la, tr.lb) - 0.02 ? 2 * lm - (tr.la + tr.lb) / 2 : (tr.la + tr.lb) / 2;
        tr.dur = clamp(1050 + 650 * Math.min(1, th / 1.3) + 220 * Math.abs(tr.lb - tr.la), 900, 2300);
      }
      this.tr = tr;
    });
  }

  /**
   * §26 one live world on the real Earth for camera {lon, lat, zoom}: rasters / wind / unit borders in a window
   * around what that camera shows (the whole globe below ×1.6), sizes ×1/zoom, the layout's §26 amendment 4 extras
   * (childAt, focus, lod, the unit model) and faint city names. Used by setNode and by the in-place rebuilds of the
   * free camera (_reask: a new unit level, or the wind / borders re-seeded where the camera now looks).
   */
  _realLive(node, mapJson, list, cam) {
    const z = clamp(+cam.zoom || 1, 1, ZMAX_REAL);
    const ws = 1 / z;
    const aspect = this.W / Math.max(1, this.H);
    const box = z >= 1.6 ? this._viewBox(cam, z, aspect) : null;
    if (!this._realMemo) this._realMemo = new WeakMap();
    let byBox = this._realMemo.get(list);
    if (!byBox) { byBox = new Map(); this._realMemo.set(list, byBox); }
    const bk = box ? [box.lon, box.lat0, box.lat1, box.span].map((x) => x.toFixed(3)).join(',') : 'globe';
    let S = byBox.get(bk);
    if (!S) {
      // (ring points are kept down to ~1.1 px at this zoom: a Census place at ×130 keeps its real outline; refine #13:
      // ⅔ px cost a third more points — a 350 ms hitch per rest in Beijing / Shanghai — for no visible gain)
      S = prepareSphere(list, node.children || [], { coast: false, box, pointR: 0.0065 * ws, neutral: false, segMin: Math.min(0.0012, 0.0032 * ws), rasterW: box ? 1536 : 0 });
      if (byBox.size > 4) byBox.delete(byBox.keys().next().value);
      byBox.set(bk, S);
    }
    if (this.dateIndex == null) { const len = seriesLen(mapJson); this.dateIndex = len ? len - 1 : null; }
    const hints = new Map();
    (node.children || []).forEach((c, k) => { const it = list.find((x) => x && x.id === c.id); if (it && it.kind === 'sea' && Array.isArray(it.hint) && it.hint.length) hints.set(k, it.hint.slice(0, 4)); });
    const um = unitModel(list, node.children || []);
    const next = this._makeLive(node, mapJson, S, { real: true, ws, windBox: box, hints, units: um });
    next.list = list;
    next.lod = list.lod || null;
    next.built = { lon: cam.lon, lat: cam.lat, zoom: z, box };
    // §26 amendment 4: where a ①②③ about a deeper place points (海外股市 › 印度 → 孟买), and today's spots' places
    next.childAt = new Map();
    for (const it of list) if (it && it.childAt && typeof it.childAt === 'object') {
      for (const [cid, ll] of Object.entries(it.childAt)) if (Array.isArray(ll) && Number.isFinite(+ll[0]) && Number.isFinite(+ll[1])) next.childAt.set(cid, new THREE.Vector3(...dirOf(+ll[0], +ll[1])));
    }
    next.focus = new Map((Array.isArray(list.focus) ? list.focus : []).filter((f) => f && f.id).map((f) => [f.id, f]));
    // refine: where each child's MONEY is — layout.focus[].at (= item.hub, its heaviest metro) — and the points of the
    // units it owns (item.metros[].at) with their share of its money (item.units[].w). The ①②③ cards, the 主航道 ends
    // and the hero ring aim at the money, not at the label anchor (a stray town that happens to be its biggest piece).
    next.money = (node.children || []).map((c) => {
      const it = list.find((x) => x && x.id === c.id);
      if (!it || it.kind === 'sea') return null;
      const f = next.focus.get(c.id);
      const ll = f && Array.isArray(f.at) ? f.at : Array.isArray(it.hub) ? it.hub : null;
      if (!ll || !Number.isFinite(+ll[0]) || !Number.isFinite(+ll[1])) return null;
      const wOf = new Map((Array.isArray(it.units) ? it.units : []).map((u) => [u.id, +u.w || 0]));
      const units = (Array.isArray(it.metros) ? it.metros : []).filter((m) => m && Array.isArray(m.at) && Number.isFinite(+m.at[0]))
        .map((m) => ({ d: new THREE.Vector3(...dirOf(+m.at[0], +m.at[1])), w: wOf.get(m.id) || 0, label: m.label || null, ll: [+m.at[0], +m.at[1]] }));
      return { hub: new THREE.Vector3(...dirOf(+ll[0], +ll[1])), ll: [+ll[0], +ll[1]], label: (f && f.label) || it.hubLabel || null, share: +it.hubShare || 0, units };
    });
    // faint city names (an atlas's context) once the camera is close enough to need them
    if (z >= 1.7) {
      const cb = this._viewBox(cam, z, aspect);
      cities(cb).then((cs) => {
        if (this.live !== next || !cs.length) return;
        const ZH = new Set(['CN', 'JP', 'TW', 'KR', 'HK', 'MO']);
        const top = cs.filter((c) => c.pop >= (z < 3 ? 900 : z < 6 ? 350 : z < 30 ? 120 : 40) && (!ZH.has(c.cc) || /[\u3400-\u9fff]/.test(c.zh || ''))).slice(0, 24);
        next.labels.setCities(top.map((c) => ({ d: new THREE.Vector3(...dirOf(c.lon, c.lat)), name: c.name, pop: c.pop })), z < 3 ? 5 : z < 6 ? 8 : 12);
        next.labels.cityIndex = cs.filter((c) => /[\u3400-\u9fff]/.test(c.zh || '') && c.pop >= 150); // Chinese names for '金融 · 纽约'
      }).catch(() => {});
    }
    return next;
  }

  // ============================================================================== §26 amendment 4: zoom re-ask
  /** The manual camera on this node (a refresh keeps it), or null. */
  _manualCam(node) {
    const fc = this._fc, L = this.live;
    // §26 amendment 5: the camera handed over from the 2D map (main.js setRender) opens this node where it was
    const sd = this._seed;
    if (sd && fc && fc.manual && node && sd.nodeId === node.id && sd.mode === 'real' && fc.nodeId === node.id) return { lon: +sd.lon, lat: +sd.lat, zoom: clamp(+sd.zoom || 1, 1, ZMAX_REAL) };
    if (!fc || !fc.manual || !node || fc.nodeId !== node.id || fc.mode !== 'real' || !L || !L.world.real) return null;
    const [lon, lat] = this._camLL();
    return { lon, lat, zoom: this.zoom || 1 };
  }

  /** lon / lat (deg) at the middle of the free area (the camera's aim on the live world). */
  _camLL() {
    const L = this.live;
    const d = new THREE.Vector3(0, 0, 1);
    if (L) d.applyQuaternion(L.world.root.quaternion.clone().invert());
    return lonLatOf(d.x, d.y, d.z);
  }

  /** The free camera came to rest (planet3d/freecam.js): check the unit level / the window shortly. */
  _camSettled() {
    clearTimeout(this._reaskT);
    this._reaskT = setTimeout(() => this._reask(), 160);
  }

  /**
   * The camera rests outside what the live world was built for → rebuild it in place (no camera move):
   *   a new unit level — layout.lod [zoomMin, zoomMax) left, or (level 3) > 4° from lod.near: geo.getLayout(…, {zoom, at});
   *   the same layout, a new window — the wind, unit borders and anchors re-seeded where the camera now looks
   *   (open item 11: rotate far away and the wind still blows there).
   */
  async _reask(force = false) {
    const L = this.live, n = this._lastNav;
    if (force) this._reaskForce = true; // (new unit data that arrived mid-flight is not forgotten)
    if (!L || !L.world.real || !n || n.mode !== 'real' || this._destroyed) return;
    if (this.tr || (this._fc && this._fc.moving())) { this._camSettled(); return; }
    force = !!this._reaskForce;
    const [lon, lat] = this._camLL();
    const z = this.zoom || 1;
    const lod = L.lod, b = L.built || { zoom: 1, box: null };
    // (§26 amendment 5: a points-only level too — its faint unit borders follow the zoom, as a fresh build at that camera has)
    const lodOut = !!(lod && lod.level > 0 && (z < (+lod.zoomMin || 0) - 1e-6 || (lod.zoomMax != null && z >= +lod.zoomMax)));
    const nearOut = !!(lod && lod.near && angDeg(lon, lat, +lod.near.lon, +lod.near.lat) > 4);
    const zr = z / (b.zoom || 1);
    const boxOut = b.box ? !boxContains(shrinkBox(b.box, 0.6), lon, lat) || zr > 2.2 || zr < 0.45 : z >= 2.4;
    // (refine #4: the 1:10m coast window follows the camera on every rest, not only when the world is rebuilt — its
    // edge must never come into sight)
    if (this.globe && L.list) this.globe.setView({ lon, lat, scale: z }, L.list.context || {}, { detail: L.list.detail });
    if (!force && !lodOut && !nearOut && !boxOut) return;
    this._reaskForce = false;
    const tok = (this._reaskTok = (this._reaskTok || 0) + 1);
    const navTok = this._navTok;
    let list = L.list;
    if (force || lodOut || nearOut || !list) {
      try {
        list = await getLayout(n.node, n.node.children || [], n.mapJson, { mode: 'real', map: typeof this.opts.mapKey === 'function' ? this.opts.mapKey() : undefined, zoom: z, at: [lon, lat] });
      } catch (e) { console.warn('[planet3d] 换行政区层', e); return; }
    }
    if (tok !== this._reaskTok || navTok !== this._navTok || this.live !== L || this._destroyed) return;
    if (!list || list.mode !== 'real') return;
    if (this.tr || (this._fc && this._fc.moving())) { this._camSettled(); return; }
    const [lon2, lat2] = this._camLL();
    this._swapReal(list, { lon: lon2, lat: lat2, zoom: this.zoom || 1 });
  }

  /** Swap the live world for one built from `list` at camera `cam`, in place: a short cross-fade, the camera untouched. */
  _swapReal(list, cam) {
    const L = this.live, n = this._lastNav;
    const t0 = performance.now();
    let next;
    try { next = this._realLive(n.node, n.mapJson, list, cam); } catch (e) { console.warn('[planet3d] 换行政区层', e); return; }
    next.realView = L.realView; // 回正 still goes back to the node's own view
    next.aimTarget = (L.aimTarget || new THREE.Quaternion()).clone();
    next.aimQ = (L.aimQ || next.aimTarget).clone();
    next.aimLocked = true;
    next.lockedAt = L.lockedAt || t0;
    next.world.frontDir.copy(L.world.frontDir);
    next.gateOn = true; next.labGate = 1;
    if (this.globe) this.globe.setView({ lon: cam.lon, lat: cam.lat, scale: cam.zoom }, list.context || {}, { detail: list.detail });
    if (this.hoverIdx >= 0) this._setHover(-1, null);
    const now = performance.now();
    this.stats.reaskMs = now - t0;
    if (!this.running) { this.live = next; this._disposeLive(L); next.reveal = 1; this._dirty = true; this._renderOnce(now); return; }
    this._snapFade(360, next.world.root);
    this.live = next;
    this._dirty = true;
    next.reveal = 0;
    if (this.tr) this._endTransition(true);
    this.tr = { dir: 'swap', t0: now, dur: 480, from: L, to: next, resolve: null, z1: this.zoom || cam.zoom };
  }

  /**
   * Cross-fade helper: the current frame is copied into a 2D canvas laid over the WebGL one and faded out over
   * 400 ms while the new world is drawn underneath at full strength. Returns false when it cannot (no frame yet).
   */
  _snapFade(ms = 400, hide = null) {
    try {
      if (!this.live || this._lost || typeof document === 'undefined') return false;
      if (hide) hide.visible = false;
      this._render(performance.now(), 0); // a fresh frame in the drawing buffer, copied in the same task
      if (hide) hide.visible = true;
      const src = this.renderer.domElement;
      let c = this._snapCv;
      if (!c) {
        c = this._snapCv = document.createElement('canvas');
        c.className = 'p3-snap';
        Object.assign(c.style, { position: 'fixed', pointerEvents: 'none', zIndex: getComputedStyle(this.canvas).zIndex || 'auto' });
        this.canvas.after(c);
      }
      const rect = this.canvas.getBoundingClientRect();
      c.width = src.width; c.height = src.height;
      Object.assign(c.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', transition: 'none', opacity: '1', display: 'block' });
      c.getContext('2d').drawImage(src, 0, 0);
      // the old labels go at once (the new ones fade in with their world)
      if (this.live) this.live.labels.group.visible = false;
      clearTimeout(this._snapT);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        c.style.transition = `opacity ${ms}ms ease-in-out`;
        c.style.opacity = '0';
        this._snapT = setTimeout(() => { c.style.display = 'none'; }, ms + 60);
      }));
      return true;
    } catch (e) { return false; }
  }

  /** The shell switched to 抽象 / another map: nothing to do but let the globe fade with its last world. */
  _leaveReal() { if (this.globe && !(this.live && this.live.world.real)) this.globe.setView(null, {}); }

  /** geo/real.js or geo/silhouettes.js just became available: redraw the current node with it, in place. */
  _providersChanged() {
    const n = this._lastNav;
    if (!n || this._destroyed || this.tr) return;
    // §26 the real Earth: new HQ / anchor / unit data → the same camera, the territories rebuilt in place
    if (n.mode === 'real' && this.live && this.live.world.real) { console.info('[planet3d] 新地图数据到了，原地重画'); this._reask(true); return; }
    console.info('[planet3d] 新地图数据到了，重画这一层');
    this.setNode(n.node, n.mapJson, { direction: 'none' });
  }

  setDate(i) {
    if (i == null || !Number.isFinite(+i)) return;
    this.dateIndex = Math.round(+i);
    if (this.live) this.live.world.applyDate(this.dateIndex, true, this.ov);
    this._dirty = true;
  }

  setLens(tag) {
    this.lens = tag || null;
    if (this.live) this.live.world.applyLens(this.lens, hasTag, false);
    this._dirty = true;
  }

  setSpotlight(list) {
    this.spot = (Array.isArray(list) ? list : []).filter((s) => s && s.id).slice(0, 3).map((s) => ({ id: s.id, why: s.why || '', kind: s.kind || null }));
    this._dirty = true;
  }

  setPins(ids) { this.pins = new Set(ids || []); this._dirty = true; }

  setOverlay(name, data) {
    if (!OVERLAYS.includes(name)) { console.warn('[planet3d] unknown overlay', name); return; }
    const auto = name === 'channel' || name === 'numbers' || name === 'seasons';
    if (data === undefined) data = null;
    if (data === 'auto' && !auto) data = null;
    if (name === 'liquidity') data = normLiq(data);
    if (name === 'scenario') {
      // the scenario module sets its own channel / numbers in the same task, right after this call: capture
      // those; the measured ones the shell pushes afterwards wait in this.ov until 推演 closes
      if (data && data.nodes) {
        this.ovScn = {};
        this._scnCap = true;
        Promise.resolve().then(() => { this._scnCap = false; });
      } else { this.ovScn = null; this._scnCap = false; }
    }
    if ((name === 'channel' || name === 'numbers') && this.ovScn && this._scnCap) {
      this.ovScn[name] = data;
      this._dirty = true;
      return;
    }
    this.ov[name] = data;
    // the shell's real channel / ①②③ arrived: settle the rest pose now (labels wait for it, so nothing slides)
    const L = this.live;
    if ((name === 'channel' || name === 'numbers') && data && data !== 'auto' && L && !L.aimLocked) {
      L.ovArrived = performance.now();
      if (!this.tr || this.tr.to !== L) L.aimLockAt = Math.min(L.aimLockAt == null ? Infinity : L.aimLockAt, L.ovArrived + 250);
    }
    if (name === 'estimates' && this.live) this._applyEst(this.live.world);
    if (name === 'scenario' && this.live) {
      const w = this.live.world;
      w.applyDate(this.dateIndex, true, this.ov);
      w.setScenarioUniforms(!!(data && data.nodes), data && data.epicenters);
    }
    this._dirty = true;
  }

  getOverlay(name) { return this.ov[name]; }

  /** Effective channel / numbers: while 推演 is on, the scenario module's own (else the planet's 'auto'). */
  _ovv(name) {
    if (this.ovScn && this.ov.scenario && this.ov.scenario.nodes) return name in this.ovScn ? this.ovScn[name] : 'auto';
    return this.ov[name];
  }

  /** Turn the globe (gently) so territory `id` (or the child that contains it) faces the viewer. */
  faceChild(id) {
    const L = this.live;
    if (!L) return false;
    const w = L.world;
    const k = this._resolveK(w, id);
    if (k == null) return false;
    // turn the territory toward the viewer, but keep a little of the 3/4 curve (it lands a bit below-right
    // of the middle, on the lit side of the globe)
    // (the real Earth: straight at it, north up — a map does not tilt)
    const off = w.real ? Z.clone() : new THREE.Vector3(0.12, -0.16, 1).normalize();
    L.aimTarget = new THREE.Quaternion().setFromUnitVectors(Z, off).multiply(lookQuat(w.anchorDir[k]));
    L.aimLockAt = 0;
    L.aimLocked = true;
    this.rot.release = performance.now() - HOLD_MS; // let a held drag spring back to the new pose
    if (this._fc) this._fc.faceRelease(); // §26 free camera: the manual turn lets go too
    this._dirty = true;
    return true;
  }

  // §26 amendment 5: switching 2D ↔ 3D keeps the place and zoom (main.js setRender hands the camera over)
  /** The live camera: {lon, lat} at the middle of the free area, zoom, manual, nodeId, mode. */
  getCamera() {
    const L = this.live, fc = this._fc, n = this._lastNav;
    if (!L || !fc || !n || !n.node) return null;
    const [lon, lat] = this._camLL();
    return { lon, lat, zoom: this.zoom || 1, manual: !!fc.manual, nodeId: n.node.id, mode: n.mode };
  }

  /** The next setNode on cam.nodeId (same reading) opens at this camera, held as a manual view. */
  seedCamera(cam) {
    if (!cam || !cam.nodeId || !this._fc || !Number.isFinite(+cam.lon) || !Number.isFinite(+cam.lat)) return;
    this._seed = { ...cam };
    this._fc.seed(cam);
    // (pinned in _render until the rest pose under it settles: rot.q = seed · aimQ⁻¹)
    this._seedQ = lookQuat(new THREE.Vector3(...dirOf(+cam.lon, +cam.lat)));
  }

  setTheme(name) {
    const nm = name === 'night' ? 'night' : 'day';
    if (nm === this.look.name) return;
    this.look = lookOf(nm);
    this._lightT = null;
    this.ctx.look = this.look;
    this.ctx.bandDark = this.look.bandDark;
    this._applyLook();
    Object.assign(this.skyMat.uniforms, this._skyUniforms(1, this.skyMat.uniforms));
    Object.assign(this.fadeMat.uniforms, this._skyUniforms(this.fadeMat.uniforms.uA.value, this.fadeMat.uniforms));
    this.fadeMat.uniforms.uDropA.value = 0;
    this._rebuildFx();
    this._dirty = true;
    if (!this.running) this._renderOnce(performance.now());
  }

  getTheme() { return this.look.name; }

  setInsets(ins = {}) {
    this._insetsSet = true;
    Object.assign(this.insets, ins);
    this._computeView(false);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || window.innerWidth));
    const H = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || window.innerHeight));
    const pr = Math.min(QUALITY[this.q].pr, window.devicePixelRatio || 1);
    Object.assign(this.layer.style, { left: rect.left + 'px', top: rect.top + 'px', width: W + 'px', height: H + 'px' });
    if (!this._insetsSet) {
      clearTimeout(this._insetTimer);
      this._insetTimer = setTimeout(() => this._computeView(false), 450);
    }
    if (W === this.W && H === this.H && pr === this.pr) { this._computeView(false); return; }
    this.W = W; this.H = H; this.pr = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(W, H, false);
    this.css.setSize(W, H);
    this._computeView(true);
    if (this.live && !this.running) this._renderOnce(performance.now());
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  resume() {
    if (this.running || this._destroyed) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frameBound);
  }

  getChildScreenRect(id) {
    const L = this.live;
    if (!L) return null;
    const w = L.world;
    const k = w.idxOf.get(id);
    if (k == null) return null;
    const rect = this.canvas.getBoundingClientRect();
    w.root.updateMatrixWorld(true);
    const T = w.S && w.S.terr[k];
    if (w.kind && w.kind[k] === 'point' && w.pointScr) {
      const p = w.pointScr.find((o) => o.k === k);
      if (!p || !p.vis) return null;
      const r0 = p.r + 2;
      return { x: rect.left + p.tx - r0, y: rect.top + p.ty - r0, left: rect.left + p.tx - r0, top: rect.top + p.ty - r0, width: 2 * r0, height: 2 * r0, right: rect.left + p.tx + r0, bottom: rect.top + p.ty + r0, cx: rect.left + p.tx, cy: rect.top + p.ty, r: r0 };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = new THREE.Vector3();
    for (const poly of (T && T.polys) || []) {
      const r = poly.ext, m = r.length / 3, step = Math.max(1, Math.floor(m / 40));
      for (let i = 0; i < m; i += step) {
        v.set(r[3 * i], r[3 * i + 1], r[3 * i + 2]);
        if (v.dot(w.camObj) < 0.05) continue; // the far side does not count
        w.surfPos(v, 0, v);
        const [sx, sy] = this._project(v.applyMatrix4(w.root.matrixWorld));
        x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
      }
    }
    // refine (#6): on the real Earth the place of a territory is where its money is (layout.focus[].at = item.hub) —
    // the shell's 主航道 ring and tour pins land there, not on whichever piece is its biggest (a stray town)
    const mo = w.real && L.money ? L.money[k] : null;
    if (mo && mo.hub) {
      const hp = w.surfPos(mo.hub, 0, new THREE.Vector3());
      if (hp.clone().normalize().dot(w.camObj) < 0.05) return null; // over the horizon: the shell hides its pin
      const a = this._project(hp.applyMatrix4(w.root.matrixWorld));
      const R0 = Math.max(18, Math.min(60, w.angR[k] * this.view.R * this.zoom));
      if (!Number.isFinite(x0)) { x0 = a[0] - R0; x1 = a[0] + R0; y0 = a[1] - R0; y1 = a[1] + R0; }
      const left = rect.left + x0, top = rect.top + y0;
      return {
        x: left, y: top, left, top, width: x1 - x0, height: y1 - y0, right: rect.left + x1, bottom: rect.top + y1,
        cx: rect.left + a[0], cy: rect.top + a[1], r: w.angR[k] * this.view.R * this.zoom,
      };
    }
    if (!Number.isFinite(x0)) return null;
    const a = this._project(w.anchorPos(k, v, 0).applyMatrix4(w.root.matrixWorld));
    const left = rect.left + x0, top = rect.top + y0;
    return {
      x: left, y: top, left, top, width: x1 - x0, height: y1 - y0, right: rect.left + x1, bottom: rect.top + y1,
      cx: rect.left + a[0], cy: rect.top + a[1], r: w.angR[k] * this.view.R * this.zoom,
    };
  }

  // ============================================================================== §26 shell cards (placeCaption)
  /**
   * A free spot for one of the shell's floating cards (the 主航道 hero pin #hero-cap, CSS px size {w, h}) near
   * territory `id`: off the ①②③ cards, names, markers and the shell's UI, a little above the place when it can be
   * (opts.ring: the shell's ring radius around the place, kept clear). Returns {x, y} (client px, top-left), or null
   * while the planet's own cards are not final yet (a flight, the rest pose settling — open item 4: the shell's card
   * waits instead of landing on a ①②③ card first) or the place is off the map. While the camera moves the card
   * rides with its place (the last offset); at rest it is re-scored. The planet draws a hairline from the place to
   * it when the card stands off.
   */
  placeCaption(id, size = {}, opts = {}) {
    const L = this.live;
    this._capAsk = performance.now();
    const swap = !!(this.tr && this.tr.dir === 'swap' && this.tr.to === L && this._cap); // (an in-place unit rebuild)
    if (!L || (this.tr && !swap) || (!swap && (!L.gateOn || (L.labGate || 0) < 0.97 || L.reveal < 0.97))) return null;
    const r = this.getChildScreenRect(id);
    if (!r || !Number.isFinite(r.cx) || !Number.isFinite(r.cy)) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ax = r.cx - rect.left, ay = r.cy - rect.top;
    if (ax < 0 || ay < 0 || ax > this.W || ay > this.H) return null;
    const w = Math.max(40, +size.w || 220), h = Math.max(16, +size.h || 34);
    const ring = clamp(+opts.ring || 0, 0, 80);
    const key = id + '|' + Math.round(w / 8) + 'x' + Math.round(h / 4);
    const prev = this._cap && this._cap.key === key ? this._cap : null;
    const moving = !!(this._fc && this._fc.moving()) || swap;
    if (moving) {
      if (!prev) return null;
      const x = ax + prev.dx, y = ay + prev.dy;
      this._cap = Object.assign({}, prev, { ax, ay, x, y, t: this._capAsk });
      return { x: rect.left + x, y: rect.top + y };
    }
    if (prev && Math.hypot(prev.ax - ax, prev.ay - ay) < 2.5 && this._capAsk - prev.scoredAt < 700) {
      prev.t = this._capAsk;
      return { x: rect.left + prev.x, y: rect.top + prev.y };
    }
    // what the card must not cover: the planet's cards (most), names / markers, the shell's other UI, the ring
    const hard = [];
    for (const b of L.labels.rects || []) {
      const s = b.k != null && L.labels.items[b.k] && L.labels.items[b.k].spec;
      hard.push({ x0: b.x0 - 6, y0: b.y0 - 6, x1: b.x1 + 6, y1: b.y1 + 6, wt: s && s.num ? 8 : 2.2 });
    }
    for (const p of L.world.pointScr || []) if (p.vis) hard.push({ x0: p.tx - p.r - 4, y0: p.ty - p.r - 4, x1: p.tx + p.r + 4, y1: p.ty + p.r + 4, wt: 1.5 });
    for (const q of this._obstacles(['hero-cap', 'hero-ring'])) hard.push(Object.assign({ wt: 6 }, q));
    if (ring) hard.push({ x0: ax - ring - 4, y0: ay - ring - 4, x1: ax + ring + 4, y1: ay + ring + 4, wt: 8 });
    const ins = this.insets;
    const E = { x0: ins.left + 8, y0: ins.top + 8, x1: this.W - ins.right - 8, y1: this.H - ins.bottom - 8 };
    const cost = (x, y) => {
      let c = 0;
      if (x < E.x0 || y < E.y0 || x + w > E.x1 || y + h > E.y1) c += 1e7;
      for (const q of hard) {
        const ox = Math.min(x + w, q.x1) - Math.max(x, q.x0), oy = Math.min(y + h, q.y1) - Math.max(y, q.y0);
        if (ox > 0 && oy > 0) c += ox * oy * q.wt;
      }
      // (like the ①②③ cards: rather over open water / empty ground than over the territories it talks about)
      if (c < 1e6 && L.labels._cam) { try { c += 40 * L.labels._groundPen({ x0: x, y0: y, x1: x + w, y1: y + h }, 3, 0.4, 5, 2); } catch (e) { /* no ground test */ } }
      return c;
    };
    let best = null;
    const gaps = [ring + 10, ring + 26, ring + 46, ring + 72, ring + 104, ring + 142];
    for (let gi = 0; gi < gaps.length; gi++) {
      const g = gaps[gi];
      for (let i = 0; i < 16; i++) {
        const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 8); // up first, then fanning down
        const ca = Math.cos(a), sa = Math.sin(a);
        const x = ax + ca * (g + (w / 2) * Math.abs(ca)) - w / 2, y = ay + sa * (g + (h / 2) * Math.abs(sa)) - h / 2;
        const c = cost(x, y) + g * 6 + (sa > 0.3 ? 900 : 0) + Math.abs(i) * 20;
        if (!best || c < best.c) best = { x, y, c };
      }
      if (best && best.c < (g + 30) * 6 + 400) break; // a free spot this close: no need to go farther
    }
    // hysteresis: the last spot stays while it is (nearly) as good
    if (prev) {
      const x = ax + prev.dx, y = ay + prev.dy;
      const g = Math.max(0, Math.hypot(prev.dx + w / 2, prev.dy + h / 2) - Math.max(w, h) / 2);
      const c = cost(x, y) + g * 6;
      if (c <= best.c + 600) best = { x, y, c };
    }
    this._cap = { key, ax, ay, x: best.x, y: best.y, dx: best.x - ax, dy: best.y - ay, w, h, ring, t: this._capAsk, scoredAt: this._capAsk };
    return { x: rect.left + best.x, y: rect.top + best.y };
  }

  /** The hairline from the place to the shell's card (only while the shell keeps asking, and when it stands off). */
  _capLeader(now) {
    const c = this._cap;
    const on = c && now - c.t < 300 && this.live && !this.tr;
    let el = this._capLead;
    if (!on) { if (el) el.style.display = 'none'; return; }
    const ex = clamp(c.ax, c.x, c.x + c.w), ey = clamp(c.ay, c.y, c.y + c.h);
    const d = Math.hypot(ex - c.ax, ey - c.ay);
    if (d < c.ring + 16) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = this._capLead = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('class', 'p3-caplead');
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' });
      el.innerHTML = '<line stroke-width="1" stroke-linecap="round"/>';
      this.layer.appendChild(el);
    }
    const ux = (ex - c.ax) / d, uy = (ey - c.ay) / d, r0 = c.ring + 3;
    const ln = el.firstChild;
    ln.setAttribute('x1', (c.ax + ux * r0).toFixed(1)); ln.setAttribute('y1', (c.ay + uy * r0).toFixed(1));
    ln.setAttribute('x2', ex.toFixed(1)); ln.setAttribute('y2', ey.toFixed(1));
    ln.setAttribute('stroke', this.look.day ? 'rgba(31,42,68,0.45)' : 'rgba(236,231,218,0.5)');
    el.style.display = '';
  }

  /**
   * The shell's 主航道 hero pin when it is not a two-ended arc ('sink' / 'source' / 'inner': main.js app.channel.anchor):
   * the rest pose turns so that place faces the viewer too (open item 6 — on 抽象 it sat on the globe's top edge).
   */
  setHeroAnchor(id) {
    const v = id || null;
    if (v === this.heroId) return;
    this.heroId = v;
    const L = this.live;
    if (!L || !v) return;
    const w = L.world, k = this._resolveK(w, v);
    if (k == null) return;
    if (!L.aimLocked) { this._dirty = true; return; }
    // already at rest: turn only when the place sits near the rim and the owner has not turned the globe himself
    if (w.real || (this._fc && this._fc.manual)) return;
    const f = w.anchorDir[k].clone().applyQuaternion(L.aimTarget).z;
    if (f < 0.45) { L.aimLocked = false; L.aimLockAt = performance.now() + 120; L.gateOn = false; this._dirty = true; }
  }

  getStats() {
    const L = this.live;
    return Object.assign({}, this.stats, { particles: L ? L.wind.n : 0, target: L ? L.wind.target : 0, pixelRatio: this.pr, renderer: 'webgl2', zoom: this.zoom, real: !!(L && L.world.real), lod: !!(this.globe && this.globe.lod) });
  }

  destroy() {
    this._destroyed = true;
    this.pause();
    if (this.tr) this._endTransition(true);
    if (this.live) this._disposeLive(this.live);
    this.live = null;
    this._unbind();
    if (this._offProv) this._offProv();
    if (this.globe) { this.globe.dispose(); this.globe = null; }
    this.layer.remove();
    clearTimeout(this._reaskT);
    if (this._utag) { this._utag.destroy(); this._utag = null; }
    if (this._capLead) { this._capLead.remove(); this._capLead = null; }
    this.skyMat.dispose(); this.fadeMat.dispose(); this.veilMat.dispose(); this.skyMesh.geometry.dispose();
    if (this._occGeo) { this._occGeo.dispose(); this._occMat.dispose(); }
    this.renderer.dispose();
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
  }

  // ============================================================================== look / uniforms
  _makeUniforms() {
    const v3 = () => ({ value: new THREE.Vector3() });
    return {
      uL: { value: new THREE.Vector3() }, uLobj: { value: new THREE.Vector3() },
      uMidMix: { value: 0.72 }, uRimCol: v3(), uRimAmt: { value: 0.4 },
      uSeaDeep: v3(), uSeaShal: v3(), uSeaDeepSh: v3(), uSeaShalSh: v3(), uSeaLine: v3(), uSeaWave: v3(), uFoam: v3(),
      uNeutral: v3(), uNeutralSh: v3(), uBorder: v3(),
      uBands: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
      uBandsSh: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
      uIso: v3(), uIsoA: { value: 0.2 }, uHatch: v3(), uHatchA: { value: 0.2 }, uDimCol: v3(), uInk: v3(),
      uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uHullW: { value: 2 }, uChanCaseW: { value: 3 }, uChanScale: { value: 1 },
      uOutline: v3(), uWindInk: v3(), uWindPaper: v3(), uWindIn: v3(), uWindOut: v3(), uPR: { value: 1 }, uWallMix: { value: 0.3 },
    };
  }

  _applyLook() {
    const U = this.U, L = this.look;
    U.uL.value.copy(L.light);
    U.uMidMix.value = L.midMix;
    U.uRimCol.value.copy(L.rim);
    U.uRimAmt.value = L.rimAmt;
    U.uSeaDeep.value.copy(L.seaDeep); U.uSeaShal.value.copy(L.seaShal); U.uSeaDeepSh.value.copy(L.seaDeepSh); U.uSeaShalSh.value.copy(L.seaShalSh);
    U.uSeaLine.value.copy(L.seaLine); U.uSeaWave.value.copy(L.seaWave); U.uFoam.value.copy(L.foam);
    U.uNeutral.value.copy(L.neutral); U.uNeutralSh.value.copy(L.neutralSh); U.uBorder.value.copy(L.border);
    U.uWallMix.value = L.wallMix;
    L.bands.forEach((b, i) => U.uBands.value[i].copy(b));
    L.bandsSh.forEach((b, i) => U.uBandsSh.value[i].copy(b));
    U.uIso.value.copy(L.iso); U.uIsoA.value = L.isoA;
    U.uHatch.value.copy(L.hatch); U.uHatchA.value = L.hatchA;
    U.uDimCol.value.copy(L.lensDim);
    U.uInk.value.copy(L.ink);
    U.uOutline.value.copy(L.outline);
    U.uWindInk.value.copy(L.windInk);
    U.uWindPaper.value.copy(L.windPaper);
    U.uWindIn.value.copy(L.inC);
    U.uWindOut.value.copy(L.outC);
    const vars = cssVars(L);
    for (const k in vars) this.layer.style.setProperty(k, vars[k]);
    this.layer.dataset.theme = L.name;
    if (this.globe) this.globe.applyLook(L);
  }

  _skyUniforms(a, prev) {
    const L = this.look;
    const u = prev || {};
    const set = (k, v) => { if (u[k]) u[k].value = v; else u[k] = { value: v }; };
    set('uSky0', L.sky0.clone()); set('uSky1', L.sky1.clone());
    if (!u.uRes) u.uRes = { value: new THREE.Vector2(1, 1) };
    if (!u.uPlanet) u.uPlanet = { value: new THREE.Vector3(0, 0, 100) };
    set('uStars', L.stars); set('uA', a);
    set('uDropA', L.day ? 0.1 : 0.22); set('uDrop', L.day ? new THREE.Vector3(0.55, 0.49, 0.38) : new THREE.Vector3(0.02, 0.03, 0.08));
    if (!u.uAtmo) u.uAtmo = { value: new THREE.Vector4(0.022, 0, 0, 1.005) };
    if (!u.uAtmoT) u.uAtmoT = { value: new THREE.Vector2(0, 0) };
    if (!u.uAtmoLit) u.uAtmoLit = { value: new THREE.Vector3() };
    if (!u.uAtmoSh) u.uAtmoSh = { value: new THREE.Vector3() };
    if (!u.uLdir) u.uLdir = { value: new THREE.Vector2(L.light.x, L.light.y).normalize() };
    else u.uLdir.value.set(L.light.x, L.light.y).normalize();
    if (!u.uTime) u.uTime = this.U.uTime;
    return u;
  }

  // ============================================================================== worlds
  /** The node's landmasses (geo/index.js) prepared for rendering (cached per layout). */
  _prep(list, node, opts) {
    if (!this._sphereMemo) this._sphereMemo = new WeakMap();
    let S = this._sphereMemo.get(list);
    if (!S) {
      S = prepareSphere(list, node.children || [], opts);
      this._sphereMemo.set(list, S);
    }
    return S;
  }

  _makeLive(node, map, S, wopts) {
    const world = new World(this.ctx, node, map, this.dateIndex, this.ov, S, wopts);
    if (world.real && this.globe) world.globeLand = (d) => this.globe.isLand(d);
    world.applyLens(this.lens, hasTag, true);
    this._applyEst(world);
    world.setScenarioUniforms(!!(this.ov.scenario && this.ov.scenario.nodes), this.ov.scenario && this.ov.scenario.epicenters);
    const wind = new Wind(this.ctx, world);
    wind.setTarget(this._windTarget());
    wind.reset();
    world.root.add(wind.group);
    const fx = new Fx(this.ctx, world, this.props);
    world.root.add(fx.group);
    const labels = new Labels(this.ctx, world);
    world.root.add(labels.group);
    if (!this._occGeo) {
      this._occGeo = new THREE.SphereGeometry(0.994, 64, 40);
      this._occMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    }
    const occ = new THREE.Mesh(this._occGeo, this._occMat);
    occ.layers.set(DEPTH_LAYER);
    occ.renderOrder = -10;
    occ.userData.sharedGeo = occ.userData.sharedMat = true;
    world.root.add(occ);
    this.scene.add(world.root);
    return { world, wind, fx, labels, reveal: 1, fronts: new Map() };
  }

  _disposeLive(L) {
    L.labels.dispose();
    L.fx.dispose();
    L.wind.dispose();
    L.world.dispose();
  }

  _rebuildFx() {
    const L = this.live;
    if (!L) return;
    L.fx.dispose();
    L.fx = new Fx(this.ctx, L.world, this.props);
    L.world.root.add(L.fx.group);
    this._dirty = true;
  }

  _applyEst(world) {
    const d = this.ov.estimates;
    const ids = (Array.isArray(d) ? d : []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter(Boolean);
    world.estOv = new Set(ids);
  }

  _zoomScale(world, k) {
    const D = this.view.D;
    const rEq = Math.max(0.06, world.angR[k] || 0.2) * 0.78; // angular size of the landmass
    const s = (1.15 * D) / (rEq * D + 1.15);
    return clamp(s, 1.6, (D - 0.7) / 1.1);
  }

  _resetRot() { this.rot.q.identity(); this.rot.wx = this.rot.wy = 0; this.rot.dragging = false; }

  // ============================================================================== attention / overlays → state
  _blinkSet(w) {
    const set = new Map();
    if (this.spot) {
      this.spot.forEach((s, i) => { const k = w.idxOf.get(s.id); if (k != null && set.size < 3) set.set(k, i); });
    } else {
      const cand = [];
      for (let k = 0; k < w.n; k++) {
        const f = w.front[k], s = w.to.storm[k], wd = w.to.wind[k];
        if (!f && !(s >= 0.8)) continue;
        cand.push([k, 0.6 * Math.abs(f) + 0.3 * (s >= 0.8 ? 1 : 0) + 0.25 * Math.abs(wd || 0)]);
      }
      cand.sort((a, b) => b[1] - a[1]);
      cand.slice(0, 3).forEach(([k], i) => set.set(k, i));
    }
    return set;
  }

  _resolveK(w, id) {
    if (id == null) return undefined;
    const k = w.idxOf.get(id);
    if (k != null) return k;
    if (!w.anc) w.anc = new Map();
    if (w.anc.has(id)) return w.anc.get(id);
    let found;
    for (let j = 0; j < w.n && found === undefined; j++) if (inSubtree(w.children[j], id)) found = j;
    w.anc.set(id, found);
    return found;
  }

  _intelItems(w) {
    const arr = Array.isArray(this.ov.intel) ? this.ov.intel : [];
    const out = [];
    for (const it of arr) {
      if (!it) continue;
      const k = this._resolveK(w, it.id);
      if (k == null) continue;
      const fresh = clamp(1 - (+it.ageDays || 0) / 6, 0.12, 1);
      const strength = clamp(+it.strength || 1, 1, 3);
      // (§26 amendment 5: the deeper nodes the story is about — ui/intel.js it.deep, else its impacts)
      const dIds = (x) => (Array.isArray(x) ? x : [x]).map((v) => (v && typeof v === 'object' ? v.id : v)).filter((v) => v != null && v !== w.children[k].id);
      const deep = it.deep != null ? dIds(it.deep) : Array.isArray(it.impacts) ? dIds(it.impacts) : null;
      out.push({ k, dir: (+it.dir || 0) >= 0 ? 1 : -1, strength, fresh, title: it.title || '', score: strength * fresh, source: it.source || 'paste', deep });
    }
    return out;
  }

  /**
   * Intel on the map (§6 calm): what the owner fed (paste / url / claude), plus scout finds on a ①②③ or a
   * holding (pinned) territory — at most 2 per planet; the rest live in the panel only. One per territory.
   */
  _intelMap(w, spotKs) {
    const pinK = new Set();
    for (const id of this.pins) { const k = this._resolveK(w, id); if (k != null) pinK.add(k); }
    const own = (s) => s === 'paste' || s === 'url' || s === 'claude' || s === 'owner';
    const cand = this._intelItems(w).filter((it) => own(it.source) || spotKs.has(it.k) || pinK.has(it.k));
    cand.sort((a, b) => (own(b.source) ? 1 : 0) - (own(a.source) ? 1 : 0) || b.score - a.score);
    const out = [], seen = new Set();
    for (const it of cand) { if (out.length >= 2) break; if (seen.has(it.k)) continue; seen.add(it.k); out.push(it); }
    return out;
  }

  _channel(w) {
    const ov = this._ovv('channel');
    if (ov === null || ov === undefined || w.n < 2) return null;
    const nm = (c) => c.name || c.ticker || c.id;
    const say = (fk, tk) => (w.scenOn ? `若成真：钱从${nm(w.children[fk])}流向${nm(w.children[tk])}` : `钱从${nm(w.children[fk])}流向${nm(w.children[tk])}`);
    if (ov && typeof ov === 'object') {
      // the shell's channel for this planet (one left over from the previous planet does not resolve: none
      // until the new one arrives, never a derived caption that flips a moment later)
      const fk = this._resolveK(w, ov.from), tk = this._resolveK(w, ov.to);
      if (fk == null || tk == null || fk === tk) return null;
      let t2 = ov.to2 != null ? this._resolveK(w, ov.to2) : null;
      if (t2 == null && ov.say) {
        // "…奔向【欧洲】和【美洲】": a second destination named in the sentence (and taking money in) gets a branch
        const say0 = String(ov.say), ti = say0.indexOf(nm(w.children[tk]));
        for (let k = 0; k < w.n && t2 == null; k++) {
          const name = String(nm(w.children[k]));
          if (k === fk || k === tk || name.length < 2) continue;
          const at = say0.indexOf(name);
          if (at >= 0 && (ti < 0 || at > ti) && w.to.wind[k] >= 0.3) t2 = k;
        }
      }
      return { fk, tk, t2k: t2 != null && t2 !== fk && t2 !== tk ? t2 : null, say: ov.say || say(fk, tk) };
    }
    let fk = -1, tk = -1, lo = Infinity, hi = -Infinity;
    for (let k = 0; k < w.n; k++) {
      const wd = w.to.wind[k];
      if (!Number.isFinite(wd) || w.est[k]) continue;
      if (wd < lo) { lo = wd; fk = k; }
      if (wd > hi) { hi = wd; tk = k; }
    }
    if (fk < 0 || tk < 0 || fk === tk || hi - lo < 0.6 || (lo > -0.2 && hi < 0.2)) return null;
    return { fk, tk, say: say(fk, tk) };
  }

  _numberOf(w, k) {
    const ov = this._ovv('numbers'), id = w.children[k].id;
    if (Array.isArray(ov)) {
      const it = ov.find((x) => x && x.id === id);
      return it ? { n: +it.n || ov.indexOf(it) + 1, why: it.why, deepId: it.deepId && it.deepId !== id ? it.deepId : null } : null;
    }
    if (ov === 'auto' && this.spot) {
      const i = this.spot.findIndex((s) => s.id === id);
      return i >= 0 ? { n: i + 1, why: this.spot[i].why } : null;
    }
    return null;
  }

  _seasonOf(w, k) {
    if (w.scenOn) return null;
    const ov = this.ov.seasons;
    if (ov === null) return null;
    if (ov && typeof ov === 'object') return normSeason(ov[w.children[k].id]);
    const s = w.season[k];
    return s >= 0 ? SEASON_KEYS[s] : null;
  }

  /** Data → fx objects + label content. Runs when something changed (date, overlays, spotlight…). */
  _sync(L) {
    const w = L.world;
    const blink = this._blinkSet(w);
    let chan = this._channel(w);
    // fx state
    // ①②③ territories: the only places where a secondary caption (cloud / intel words) may speak unasked
    const spotKs = new Set();
    for (let k = 0; k < w.n; k++) if (this._numberOf(w, k)) spotKs.add(k);
    const clouds = [];
    if (Array.isArray(this.ov.clouds)) {
      for (const c of this.ov.clouds) {
        if (!c) continue;
        const k = this._resolveK(w, c.id);
        if (k == null || clouds.some((x) => x.k === k)) continue;
        // refine (#8): on the real Earth a cloud floats over the place its story is about — the market's own nodes
        // (c.nodes, main.js adds them from the market) under this territory, at item.childAt (中印冲突 → India, not
        // over Brazil; 北约与俄罗斯 → Europe, not over Canada); none known → its territory as before
        let place = null;
        if (w.real && L.childAt && Array.isArray(c.nodes)) {
          for (const n of c.nodes) {
            const id = n && typeof n === 'object' ? n.id : n;
            if (id == null || id === w.children[k].id || !L.childAt.has(id) || !inSubtree(w.children[k], id)) continue;
            place = L.childAt.get(id).clone();
            break;
          }
        }
        clouds.push({ k, strength: clamp(+c.strength || 0, 0, 1), label: c.label || '', tip: c.tip || c.label || '', place });
      }
    }
    // rain = 风暴 (the tutorial's grammar): measured storms only — intel is the small dashed ⚡ tag
    const storms = [];
    if (!w.scenOn) for (let k = 0; k < w.n; k++) if (w.to.storm[k] >= 0.8) storms.push({ k, storm: w.to.storm[k], blink: blink.has(k) });
    const intel = w.scenOn ? [] : this._intelMap(w, spotKs);
    // §26 amendment 5 (one rule with 2D, planet/units.js deepPlace): on the real Earth a story about a deeper place
    // sits on that place (卢拉连任 → 巴西), not on its territory's biggest piece (海外股市 → British Columbia)
    for (const it of intel) {
      const dp = w.real && it.deep && it.deep.length ? deepPlace(w.children[it.k], it.deep, L.childAt) : null;
      it.place = dp && dp.ll ? (Array.isArray(dp.ll) ? new THREE.Vector3(...dirOf(+dp.ll[0], +dp.ll[1])) : dp.ll.clone()) : null;
    }
    const fronts = [];
    for (let k = 0; k < w.n; k++) {
      if (!w.front[k]) continue;
      // (refine: a front is a line on LAND — a sea area ('未定位' money parked in the Gulf) or a company dot gets none)
      if (w.real && w.kind[k] !== 'land') continue;
      let geo = L.fronts.get(k);
      if (geo === undefined) { geo = frontGeo(w, k); L.fronts.set(k, geo); }
      fronts.push({ k, dir: w.front[k], active: blink.has(k), geo });
    }
    // rest pose: chosen once per planet from the 主航道 and ①②③, then frozen (see AIM_GRACE)
    const tNow = performance.now();
    if (!L.aimLocked && tNow > (L.aimLockAt == null ? Infinity : L.aimLockAt)) L.aimLocked = true;
    if (!L.aimLocked || !L.aimTarget) L.aimTarget = this._aimFor(w, chan, (k) => this._numberOf(w, k));
    if (!L.aimQ) L.aimQ = L.aimTarget.clone();
    if (chan) {
      // both ends well inside the disc on screen (never on the limb), inside their territories
      chan.aDir = w.chanEnd(chan.fk, L.aimTarget, 0.78, this.view.D, L.realView ? L.realView.zoom : 1);
      chan.bDir = w.chanEnd(chan.tk, L.aimTarget, 0.76, this.view.D, L.realView ? L.realView.zoom : 1);
      // refine (§26): on the real Earth both ends are where the money is (layout.focus[].at = item.hub) — the same
      // points the 2D map uses — never "whichever piece of the territory happens to be on screen"
      if (w.real && L.money) {
        const ma = L.money[chan.fk], mb = L.money[chan.tk];
        if (ma && ma.hub && w.kind[chan.fk] !== 'point') chan.aDir = ma.hub.clone();
        if (mb && mb.hub && w.kind[chan.tk] !== 'point') chan.bDir = mb.hub.clone();
      }
      // §26 the real Earth does not turn to suit the arc: an end over the horizon (or off the screen) is pulled
      // along the route to where it comes into view — the arc then reads "coming from over there"
      if (w.real && L.realView) {
        // (§26 amendment 5: at the live camera — a free camera's turn and zoom on top of the rest pose — as 2D does)
        const zq = this._fc && this._fc.manual && this._fc.zm ? this._fc.zm : L.realView.zoom, D = this.view.D, sil = 1 / Math.sqrt(Math.max(1.01, D * D - 1));
        const Qv = this.rot.q.clone().multiply(L.aimTarget);
        const inView = (d) => { const t = d.clone().applyQuaternion(Qv); return t.z > 0.3 && (Math.hypot(t.x, t.y) / (D - t.z) / sil) * zq < 0.86; };
        const pull = (a, b) => {
          if (inView(a)) return a;
          const om = a.angleTo(b), so = Math.sin(om);
          if (om < 1e-4 || so < 1e-6) return a;
          for (let i = 1; i <= 60; i++) {
            const t = i / 60, ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
            const d = new THREE.Vector3().copy(a).multiplyScalar(ka).addScaledVector(b, kb).normalize();
            if (inView(d)) return d;
          }
          return a;
        };
        const a0 = chan.aDir.clone(), b0 = chan.bDir.clone();
        chan.aDir = pull(a0, b0);
        chan.bDir = pull(b0, a0);
        chan.pull = pull;
        // §26 amendment 5 (one rule with 2D): no part of the route on the map → no arc and no orphan caption
        if (!inView(chan.aDir) && !inView(chan.bDir)) chan.off = true;
        // both ends in one city (A股 原材料 → 金融: 海淀 → 西城, 13 km): at this zoom that is a dot-sized arrowhead.
        // Ends < 36 px apart: a short readable arrow (64 px) centred on the place, from→to bearing, and the caption says
        // so (「都在北京：原材料 → 金融」); zoomed in far enough (海淀 → 西城 at ×60) the true ends are used again.
        const zb = (L.built && L.built.zoom) || zq;
        const pxR = Math.max(60, this.view.R * zb);
        const minA = 64 / pxR;
        const om = chan.aDir.angleTo(chan.bDir);
        if (om * pxR < 36 && !(w.kind[chan.fk] === 'point' || w.kind[chan.tk] === 'point')) {
          const mid = chan.aDir.clone().add(chan.bDir).normalize();
          let ax = chan.bDir.clone().sub(chan.aDir);
          ax.addScaledVector(mid, -ax.dot(mid));
          if (ax.lengthSq() < 1e-14) ax.copy(frame3v(mid)[0]); // the same point: west → east
          ax.normalize();
          const h = minA / 2;
          chan.aDir = mid.clone().multiplyScalar(Math.cos(h)).addScaledVector(ax, -Math.sin(h)).normalize();
          chan.bDir = mid.clone().multiplyScalar(Math.cos(h)).addScaledVector(ax, Math.sin(h)).normalize();
          const ma = L.money && L.money[chan.fk], mb = L.money && L.money[chan.tk];
          const place = (ma && ma.label) || (mb && mb.label) || null;
          const unitA = ma ? unitNear(ma) : null, unitB = mb ? unitNear(mb) : null;
          const nm = (c) => c.name || c.ticker || c.id;
          const nmA = nm(w.children[chan.fk]), nmB = nm(w.children[chan.tk]);
          chan.local = place;
          if (place) chan.say = `都在${place}：${nmA} → ${nmB}` + (unitA && unitB && unitA !== unitB ? `（${unitA} → ${unitB}）` : '');
        }
      }
      // a company target: the head stops at its marker ring + 4 px (the marker and its neighbours stay readable)
      if (w.kind[chan.tk] === 'point' && w.pointKs) {
        const i = w.pointKs.indexOf(chan.tk);
        const px = ((i >= 0 && w.pointSize ? w.pointSize[i] : 5) + 1.6 + 4) / Math.max(60, this.view.R * (L.realView ? (this._fc && this._fc.zm) || L.realView.zoom : 1));
        const a = chan.aDir.clone(), b = chan.bDir.clone(), om = a.angleTo(b);
        if (om > px * 1.5) { const t = 1 - px / om, so = Math.sin(om); chan.bDir = a.multiplyScalar(Math.sin((1 - t) * om) / so).addScaledVector(b, Math.sin(t * om) / so).normalize(); }
      }
      // a second destination (§23 "…跑去欧洲和美洲"): a thinner branch, only when it faces the viewer
      if (chan.t2k != null) {
        const d2 = new THREE.Vector3().copy(w.anchorDir[chan.t2k]).applyQuaternion(L.aimTarget);
        chan.b2Dir = d2.z > 0.45 ? w.chanEnd(chan.t2k, L.aimTarget, 0.76, this.view.D, L.realView ? L.realView.zoom : 1) : null;
        if (!chan.b2Dir) chan.t2k = null;
        // (refine-names, one rule with 2D: on the real Earth the second destination is its money place — 金融 in 北京 —
        // pulled into view along the route like the main ends)
        const m2 = chan.b2Dir && w.real && L.money ? L.money[chan.t2k] : null;
        if (m2 && m2.hub && w.kind[chan.t2k] !== 'point') chan.b2Dir = chan.pull ? chan.pull(m2.hub.clone(), chan.aDir) : m2.hub.clone();
      }
    }
    if (chan && chan.off) chan = null; // (no part of the route on the map: §26 amendment 5)
    L.fx.sync({ channel: chan, clouds, storms, fronts, intel, blink });
    // labels
    const n = w.n;
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => w.L.areas[b] - w.L.areas[a]);
    const nMajor = Math.max(5, Math.ceil(n * 0.5));
    const major = new Set(order.slice(0, nMajor));
    // §26 names by zoom: regions and sea areas always; companies — ①②③ + the biggest names at low zoom, more as
    // the camera comes closer (the rest on hover)
    let ptMajor = null;
    if (w.real && w.pointKs && w.pointKs.length) {
      const z = L.realView ? (this._fc && this._fc.zm) || L.realView.zoom : 1; // §26 free camera: the live zoom
      const budget = z < 1.4 ? 4 : z < 2.5 ? 7 : z < 5 ? 12 : z < 10 ? 20 : 40;
      const pk = w.pointKs.map((k, i) => [k, w.pointSize[i]]).sort((a, b) => b[1] - a[1]);
      ptMajor = new Set(pk.slice(0, budget).map((x) => x[0]));
      for (const k of w.pointKs) major.delete(k);
      for (const k of ptMajor) major.add(k);
      for (let k = 0; k < n; k++) if (w.kind[k] !== 'point') major.add(k);
    }
    // 挤 / 空 (like 高 / 低 on a weather chart): same thresholds and budget as the 2D map
    const crowd = new Map();
    if (!w.scenOn) {
      const cand = [];
      for (let k = 0; k < n; k++) {
        const p = w.to.pres[k];
        if (!w.est[k] && Number.isFinite(p) && (p >= 80 || p <= 20)) cand.push([k, Math.abs(p - 50), p >= 80 ? 'hi' : 'lo']);
      }
      cand.sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([k, , c]) => crowd.set(k, c));
    }
    const spec = {};
    // companies ranked by money (label priority: the fan's biggest name first)
    const dvOf = (k) => +((w.children[k].now || {}).dv20) || 0;
    const dvRank = new Map();
    if (w.pointKs && w.pointKs.length) w.pointKs.slice().sort((a, b) => dvOf(b) - dvOf(a)).forEach((k, i, arr) => dvRank.set(k, i / Math.max(1, arr.length - 1)));
    // (refine-names, one rule with 2D: ★ marks the child that holds a pinned holding anywhere below it)
    const pinK = new Set();
    for (const id of this.pins || []) { const pk = this._resolveK(w, id); if (pk != null) pinK.add(pk); }
    for (let k = 0; k < n; k++) {
      const c = w.children[k];
      const wd = w.to.wind[k];
      const num = this._numberOf(w, k);
      const sc = w.scen[k];
      const badges = [];
      if (sc && sc.on) {
        if (+sc.gap >= 1.2) badges.push({ text: '时间差', cls: 'gap' });
        else if (+sc.pricedIn >= 0.65) badges.push({ text: '已抢跑' });
      }
      const isStock = c.kind === 'stock' || String(c.id).startsWith('s:');
      w.liftTarget[k] = this.hoverIdx === k ? 1 : 0;
      // §26 amendment 4: a ①②③ about a deeper place points there (item.childAt) and — when that place is over the
      // horizon of this view (layout.focus inView false) — says where ('→ 孟买')
      const deepDir = num && num.deepId && L.childAt ? L.childAt.get(num.deepId) || null : null;
      const foc = deepDir && L.focus ? L.focus.get(num.deepId) : null;
      // refine: on the real Earth a card points at its money (L.money[k].hub = layout.focus[].at); when that is off the
      // screen the card waits at the edge and says where ('→ 奥斯汀', shown only in that edge state — labels.js)
      const mo = w.real && L.money && w.kind[k] !== 'point' ? L.money[k] : null;
      const offL = w.off && w.off[k] ? String(w.off[k]).replace(/^→\s*/, '') : null; // real.js: '新竹 台积电'
      const toLab = deepDir ? (foc && foc.label) || null : mo ? (offL && mo.label && offL.includes(mo.label) ? offL : mo.label) : null;
      const where = deepDir || mo ? null : w.off && w.off[k];
      spec[k] = {
        name: c.name || c.ticker || c.id,
        ticker: isStock ? c.ticker || String(c.id).slice(2) : null,
        season: this._seasonOf(w, k),
        dir: wd >= 0.5 ? 1 : wd <= -0.5 ? -1 : 0,
        num: num ? num.n : 0,
        why: num ? withWhere(num.why || (this.spot && this.spot.find((s) => s.id === c.id) || {}).why, where) : '',
        to: num && toLab ? toLab : null,
        money: mo,
        deepDir,
        pulse: num && blink.has(k),
        est: w.isEst(k),
        pin: pinK.has(k),
        dim: w.dimTarget[k] > 0.5,
        badges,
        major: major.has(k),
        chanEnd: chan && (chan.fk === k || chan.tk === k),
        crowd: crowd.get(k) || null,
        point: !!(w.kind && w.kind[k] === 'point'),
        dv: dvOf(k),
        dvRank: dvRank.has(k) ? dvRank.get(k) : null,
        hideName: !!(ptMajor && w.kind[k] === 'point' && !ptMajor.has(k) && !num && !pinK.has(k) && !(chan && (chan.fk === k || chan.tk === k))),
      };
    }
    L.labels.setHover(this.hoverIdx);
    L.labels.hintList = w.hintList || null;
    L.labels.spotKs = spotKs;
    L.wind.spotKs = spotKs;
    L.labels.sync(spec, chan, clouds);
    L.blink = blink;
    L.nSpot = spotKs.size;
    L.chanOn = !!chan;

  }

  /**
   * Rest orientation (§8.1 + §25): north up, the globe turned so the 主航道 ends and ①②③ face the viewer
   * (① weighted most), as much land as possible on the visible face (names need ground facing the viewer),
   * the important places on the lit side, and — for the abstract planets — close to the layout's front, so a
   * planet keeps its face from one visit to the next. Searched over directions on the sphere.
   */
  _aimFor(w, chan, numOf) {
    // (§26 amendment 5: planet/aim.js — the 2D planet opens at the same rest pose)
    const hk = !chan && this.heroId ? this._resolveK(w, this.heroId) : null;
    const anchors = w.anchorDir.map((d) => [d.x, d.y, d.z]);
    const imp = aimImp({ n: w.n, chan, hero: hk != null ? hk : null, numOf: (k) => { const nb = numOf(k); return nb ? nb.n : 0; }, anchors });
    const Ld = this.look.light;
    const v = restAim({ anchors, areas: w.areas || [], front: [w.frontDir.x, w.frontDir.y, w.frontDir.z], earth: !!(w.S && w.S.mode === 'earth'), light: [Ld.x, Ld.y], imp });
    return lookQuat(new THREE.Vector3(v[0], v[1], v[2]));
  }

  // ============================================================================== view
  _autoInsets() {
    if (this._insetsSet || typeof document === 'undefined') return;
    const vis = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    const rect = this.canvas.getBoundingClientRect();
    const ins = { top: 0, right: 0, bottom: 0, left: 0 };
    const tb = document.getElementById('topbar'), tm = document.getElementById('timebar'), pn = document.getElementById('panel');
    if (vis(tb)) { const r = tb.getBoundingClientRect(); if (r.height > 0 && r.bottom - rect.top < this.H * 0.3) ins.top = Math.max(0, r.bottom - rect.top); }
    if (vis(tm)) { const r = tm.getBoundingClientRect(); if (r.height > 0 && rect.bottom - r.top < this.H * 0.35) ins.bottom = Math.max(0, rect.bottom - r.top); }
    if (vis(pn) && !document.body.classList.contains('panel-closed')) {
      const r = pn.getBoundingClientRect();
      if (r.width > 0 && r.left > rect.left + this.W * 0.5 && rect.right - r.left < this.W * 0.42) ins.right = Math.max(0, rect.right - r.left + 8);
    }
    this.insets = ins;
  }

  _computeView(immediate) {
    this._autoInsets();
    const { top, right, bottom, left } = this.insets;
    const aw = Math.max(50, this.W - left - right), ah = Math.max(50, this.H - top - bottom);
    const R = Math.max(40, (Math.min(aw, ah) / 2) * this.opts.radiusScale);
    const tanA = (R / (this.H / 2)) * Math.tan(((FOV / 2) * Math.PI) / 180);
    const D = 1 / Math.sin(Math.atan(tanA));
    const v = { cx: left + aw / 2, cy: top + ah / 2 + R * 0.02, R, D };
    if (immediate || !this.live) { this.view = v; this.viewTarget = null; this._applyView(); }
    else this.viewTarget = v;
    if (this.live) this.live.wind.setTarget(this._windTarget());
  }

  _applyView() {
    const v = this.view, cam = this.camera;
    this.ctx.D = v.D;
    cam.aspect = this.W / this.H;
    cam.position.set(0, 0, v.D);
    cam.near = Math.max(0.05, v.D - 3.2);
    cam.far = v.D + 3;
    cam.setViewOffset(this.W, this.H, this.W / 2 - v.cx, this.H / 2 - v.cy, this.W, this.H);
    cam.zoom = this.zoom || 1;
    this._camZoom = cam.zoom;
    cam.updateProjectionMatrix();
    this.ctx.aspect = this.W / Math.max(1, this.H);
    this.ctx.screen = { W: this.W, H: this.H, cx: v.cx, cy: v.cy, R: v.R }; // (globe.js: the 1:10m window covers all of it)
    const pw = this.W * this.pr, ph = this.H * this.pr;
    this.U.uRes.value.set(pw, ph);
    this.U.uPR.value = this.pr;
    this.U.uHullW.value = (this.look.day ? 1.7 : 1.5) * this.pr;
    this.U.uChanCaseW.value = 2.6 * this.pr;
    for (const m of [this.skyMat, this.fadeMat]) {
      m.uniforms.uRes.value.set(pw, ph);
      m.uniforms.uPlanet.value.set(v.cx * this.pr, (this.H - v.cy) * this.pr, v.R * (this.zoom || 1) * this.pr);
    }
  }

  /** §26: set the telephoto zoom (camera + everything that measures the planet in px). */
  _setZoom(z) {
    z = clamp(z, 1, ZMAX_REAL + 10);
    if (Math.abs(z - (this._camZoom || 1)) < 1e-5) { this.zoom = z; return; }
    this.zoom = z;
    this._applyView();
  }

  /** Floating shell UI (gauges, pins strip, since-line, bars, panel) that labels must not cover. */
  _obstacles(skip = null) {
    const out = [];
    if (typeof document === 'undefined') return out;
    const rect = this.canvas.getBoundingClientRect();
    for (const id of this.avoidIds.concat(['topbar', 'timebar', 'panel'])) {
      if (skip && skip.includes(id)) continue;
      const el = document.getElementById(id);
      if (!el || el.hidden) continue;
      if (id === 'panel' && document.body.classList.contains('panel-closed')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      out.push({ x0: r.left - rect.left - 4, y0: r.top - rect.top - 4, x1: r.right - rect.left + 4, y1: r.bottom - rect.top + 4, id });
    }
    return out;
  }

  _windTarget() {
    const R = this.view.R, z = this.zoom || 1;
    const area = Math.min(Math.PI * R * R * z * z, (this.W || 1) * (this.H || 1) * 0.85);
    return clamp(area / 520, 300, 900) * QUALITY[this.q].wind;
  }

  _project(v) {
    const q = v.clone().project(this.camera);
    return [(q.x * 0.5 + 0.5) * this.W, (-q.y * 0.5 + 0.5) * this.H, q.z];
  }

  // ============================================================================== frame
  _frame(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frameBound);
    const dt = clamp((now - this._last) / 1000, 0, 0.1);
    this._last = now;
    const t0 = performance.now();
    if (!this._lost) this._render(now, dt);
    const work = performance.now() - t0;
    this._adapt(now, dt, work);
  }

  _renderOnce(now) {
    if (this._lost) return;
    this._render(now, 0);
  }

  _render(now, dt) {
    const U = this.U;
    U.uTime.value = now / 1000;
    // smooth view changes (insets / panel)
    if (this.viewTarget) {
      const a = 1 - Math.exp(-dt * 9);
      const v = this.view, t = this.viewTarget;
      v.cx = lerp(v.cx, t.cx, a); v.cy = lerp(v.cy, t.cy, a); v.R = lerp(v.R, t.R, a); v.D = lerp(v.D, t.D, a);
      if (Math.abs(v.cx - t.cx) + Math.abs(v.cy - t.cy) + Math.abs(v.R - t.R) < 0.3) { this.view = t; this.viewTarget = null; }
      this._applyView();
    }
    const L = this.live;
    if (!L) {
      this.renderer.clear();
      this.renderer.render(this.skyScene, this.skyCam);
      return;
    }
    // values / fields
    const w = L.world;
    const st = w.stepLerp(now);
    if (st) {
      // fields (temperature / crowding / wind) follow a date lerp at 20–60 Hz depending on size and quality
      const every = this.q >= 2 ? 4 : w.n > 24 ? 3 : w.n > 12 ? 2 : 1;
      if (st === 2 || this.stats.frames % every === 0) w.recompute();
      if (st === 2) this._dirty = true;
    }
    if (this._dirty) { this._dirty = false; this._sync(L); }
    // §26 zoom: the live real Earth's view (a flight drives it below); anything else is the whole globe
    {
      const tz = L.realView && (!this.tr || this.tr.dir !== 'fly') ? L.realView.zoom : 1;
      const trz = this.tr && this.tr.dir === 'none' && this.tr.from && (now - this.tr.t0) / this.tr.dur < 0.5 && this.tr.from.realView;
      const want = trz ? this.tr.from.realView.zoom : tz;
      if (this._fc && this._fc.zm != null) { if (!this.tr || this.tr.dir !== 'fly') this._setZoom(this._fc.zm); } // §26 free camera
      else if (!this.tr || this.tr.dir !== 'fly') this._setZoom(Math.abs(want - this.zoom) < 0.002 ? want : this.zoom + (want - this.zoom) * (this.tr && this.tr.dir === 'none' ? 1 : 1 - Math.exp(-dt * 6)));
    }
    // drag rotation: free turning with inertia, eased back to the rest pose after HOLD_MS idle
    const r = this.rot;
    if (!r.dragging) {
      if (Math.abs(r.wx) + Math.abs(r.wy) > 1e-4) {
        this._spin(r.wy * dt, r.wx * dt);
        const damp = Math.exp(-dt * 3.2);
        r.wx *= damp; r.wy *= damp;
      }
      if (!this._fc && now - r.release > HOLD_MS) r.q.slerp(Q0, 1 - Math.exp(-dt * 1.5)); // §26 free camera: no ease-back
    }
    // transitions
    let tr = this.tr, u = 1;
    if (tr) {
      u = clamp((now - tr.t0) / tr.dur, 0, 1);
      if (u >= 1) { this._endTransition(false); tr = null; }
    }
    // labels wait until the rest pose is final and reached (no card slides about after it appears); until
    // then the globe settles quickly
    if (!L.aimLocked && now > (L.aimLockAt == null ? Infinity : L.aimLockAt)) { L.aimLocked = true; L.lockedAt = now; this._dirty = true; }
    // (+300 ms: the shell's own floating cards, placed from the same pose, settle first)
    if (!L.gateOn && L.aimLocked && L.aimQ && L.aimTarget && L.aimQ.angleTo(L.aimTarget) < 0.03 && now - (L.lockedAt || 0) > 300) L.gateOn = true;
    L.labGate = (L.labGate || 0) + ((L.gateOn ? 1 : 0) - (L.labGate || 0)) * (1 - Math.exp(-dt * 7));
    if (L.gateOn && L.labGate > 0.995) L.labGate = 1;
    if (L.aimQ && L.aimTarget) L.aimQ.slerp(L.aimTarget, 1 - Math.exp(-dt * (L.gateOn ? 2.2 : 8)));
    // §26 amendment 5: a camera handed over from 2D stays exactly where it was while the rest pose settles under it
    if (this._seedQ) {
      const fc = this._fc, n = this._lastNav;
      if (!fc || !fc.manual || fc.tw || r.dragging || !n || !this._seed || n.node.id !== this._seed.nodeId || (tr && tr.dir === 'fly')) { this._seedQ = null; this._seed = null; }
      else if (L.aimQ) {
        r.q.copy(this._seedQ).multiply(L.aimQ.clone().invert());
        if (L.aimLocked && L.aimTarget && L.aimQ.angleTo(L.aimTarget) < 1e-3 && !tr) { this._seedQ = null; this._seed = null; }
      }
    }
    const restQ = r.q.clone();
    if (L.aimQ) restQ.multiply(L.aimQ);
    let rise = 1, fadeA = 0, front = null, back = L;
    if (!tr) {
      w.root.quaternion.copy(restQ);
      w.root.scale.setScalar(1);
      w.root.position.set(0, 0, 0);
      L.reveal = Math.min(1, L.reveal + dt * 3);
    } else if (tr.dir === 'fly') {
      // §26: one Earth — the camera swings and zooms; the old regions sink into the land, the new ones rise
      const e = easeInOut(u);
      const q = tr.q0.clone().slerp(tr.q1, e);
      const lz = (1 - e) * (1 - e) * tr.la + 2 * e * (1 - e) * tr.lc + e * e * tr.lb;
      this._setZoom(Math.exp(lz));
      const old = tr.from;
      w.root.quaternion.copy(q); w.root.scale.setScalar(1); w.root.position.set(0, 0, 0);
      old.world.root.quaternion.copy(q); old.world.root.scale.setScalar(1);
      old.reveal = Math.max(0, 1 - u / 0.12);
      old.world.uRise.value = 1 - smooth(clamp(u / 0.38, 0, 1));
      if (old.world.pointMat) old.world.pointMat.uniforms.uA.value = 1 - smooth(clamp(u / 0.3, 0, 1));
      rise = smooth(clamp((u - 0.55) / 0.45, 0, 1));
      L.reveal = clamp((u - 0.86) / 0.14, 0, 1);
      back = L; front = null; fadeA = 0;
    } else if (tr.dir === 'intro') {
      const e = easeOut(u);
      w.root.quaternion.copy(restQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (1 - e) * 0.35));
      w.root.scale.setScalar(lerp(0.86, 1, e));
      rise = smooth(clamp((u - 0.25) / 0.75, 0, 1));
      fadeA = 1 - smooth(clamp(u / 0.55, 0, 1));
      L.reveal = clamp((u - 0.65) / 0.35, 0, 1);
    } else if (tr.dir === 'swap') {
      w.root.quaternion.copy(restQ); w.root.scale.setScalar(1); w.root.position.set(0, 0, 0);
      if (tr.from) tr.from.reveal = 0;
      back = L; fadeA = 0; rise = 1;
      L.reveal = clamp((u - 0.35) / 0.65, 0, 1);
    } else if (tr.dir === 'none') {
      if (u < 0.5) {
        back = tr.from; fadeA = smooth(u / 0.5);
        tr.from.reveal = Math.max(0, 1 - u / 0.2);
        L.reveal = 0;
      } else {
        back = L; fadeA = 1 - smooth((u - 0.5) / 0.5);
        w.root.quaternion.copy(restQ);
        w.root.scale.setScalar(lerp(0.96, 1, easeOut((u - 0.5) / 0.5)));
        rise = smooth((u - 0.5) / 0.5);
        L.reveal = clamp((u - 0.75) / 0.25, 0, 1);
      }
    } else if (tr.dir === 'in') {
      const old = tr.from;
      const ow = old.world;
      ow.root.quaternion.slerpQuaternions(tr.q0, tr.q1, easeInOut(clamp(u / 0.6, 0, 1)));
      ow.root.scale.setScalar(lerp(1, tr.S, easeIn(clamp(u / 0.82, 0, 1))));
      old.reveal = Math.max(0, 1 - u / 0.12);
      back = old;
      fadeA = smooth(clamp((u - 0.4) / 0.38, 0, 1));
      const v = clamp((u - 0.36) / 0.64, 0, 1);
      front = L;
      w.root.position.set(0, 0, 0);
      w.root.scale.setScalar(lerp(0.07, 1, easeOut(v)) + 1e-4);
      w.root.quaternion.copy(restQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (1 - easeOut(v)) * -0.5));
      rise = smooth(clamp((v - 0.3) / 0.7, 0, 1));
      L.reveal = clamp((v - 0.78) / 0.22, 0, 1);
      if (v <= 0) front = null;
    } else if (tr.dir === 'out') {
      const old = tr.from;
      const ow = old.world;
      // parent zooms out from the territory we came from
      w.root.quaternion.slerpQuaternions(tr.q0, restQ, easeInOut(clamp(u / 0.85, 0, 1)));
      w.root.scale.setScalar(lerp(tr.S, 1, easeInOut(clamp(u / 0.9, 0, 1))));
      back = L;
      fadeA = 1 - smooth(clamp((u - 0.12) / 0.45, 0, 1));
      L.reveal = clamp((u - 0.8) / 0.2, 0, 1);
      // the child sinks back into it
      const v = clamp(u / 0.6, 0, 1);
      ow.root.scale.setScalar(lerp(1, 0.06, easeIn(v)) + 1e-4);
      old.reveal = Math.max(0, 1 - u / 0.12);
      front = v < 1 ? old : null;
    }
    // per-world animation (only the live world moves its weather)
    this._tickLive(L, dt, now, rise);
    if (tr && tr.from) this._tickFrozen(tr.from, dt);

    // ---- render passes
    const R = this.renderer;
    R.clear();
    const sky = this.skyMat.uniforms;
    sky.uDropA.value = (this.look.day ? 0.1 : 0.22) * (tr ? (tr.dir === 'intro' ? 1 - fadeA : 0.4 + 0.6 * (back === L ? 1 - fadeA : 0)) : 1);
    this._atmo(sky, dt, tr ? 0 : 1);
    R.render(this.skyScene, this.skyCam);
    const worlds = [L, tr && tr.from].filter(Boolean);
    const G = this.globe;
    const only = (x) => {
      worlds.forEach((o) => { o.world.root.visible = o === x || !!(tr && tr.dir === 'fly'); });
      if (G) {
        G.root.visible = !!(x && x.world.real && G.S);
        if (G.root.visible) { G.root.quaternion.copy(x.world.root.quaternion); G.root.scale.copy(x.world.root.scale); }
      }
    };
    if (G && G.S) G.update(this.zoom, null, dt);
    // §17 the key light sits within 20° of the camera (upper left): at globe scale the shadow is only a thin rim
    // on the lower-right limb (≤ 12 % of the radius), never a terminator across a country; a zoomed real Earth
    // swings it closer still (a map). A ①②③ place near that rim pulls the light toward itself.
    {
      const zt = back && back.world.real ? clamp((this.zoom - 1.05) / 1.6, 0, 1) : 0;
      const Lk = this.look.light;
      const tilt = lerp(Math.tan((20 * Math.PI) / 180), 0.12, zt);
      const lx = Lk.x, ly = Lk.y, ll = Math.hypot(lx, ly) || 1;
      const Lv = new THREE.Vector3((lx / ll) * tilt, (ly / ll) * tilt, 1).normalize();
      const nk = back && back.labels && back.labels.spotKs ? [...back.labels.spotKs] : [];
      if (nk.length && back.world.root) {
        const q = back.world.root.quaternion;
        for (let it = 0; it < 6; it++) {
          let worst = 1, wd = null;
          for (const k of nk) {
            const d = back.world.anchorDir[k];
            if (!d) continue;
            const dw = d.clone().applyQuaternion(q);
            if (dw.z < 0.05) continue; // over the horizon: not on screen
            const ndl = dw.dot(Lv);
            if (ndl < worst) { worst = ndl; wd = dw; }
          }
          if (!wd || worst >= 0.34) break;
          Lv.lerp(wd, 0.35).normalize();
        }
      }
      const key = Lv.x.toFixed(4) + Lv.y.toFixed(4) + Lv.z.toFixed(4) + '|' + zt.toFixed(3);
      if (key !== this._lightT) {
        this._lightT = key;
        this.U.uL.value.copy(Lv);
        this.U.uMidMix.value = lerp(0.88, 0.94, zt);
      }
    }
    only(back);
    const DBG = globalThis.__P3dbg;
    if (DBG) { if (DBG.noWorld) worlds.forEach((o) => { o.world.root.visible = false; }); if (DBG.noGlobe && G) G.root.visible = false; }
    R.render(this.scene, this.camera);
    if (fadeA > 0.001) {
      this.fadeMat.uniforms.uA.value = fadeA;
      R.render(this.fadeScene, this.skyCam);
    }
    if (front && front !== back) {
      R.clearDepth();
      only(front);
      R.render(this.scene, this.camera);
    }
    if (G) G.root.visible = false; // (the arc pass below draws the live world's layers only)
    // labels of the live world only (kept clear of the shell's floating UI)
    // (every frame while the labels fade in: the shell's own floating UI arrives with the same overlays)
    // (refine-names, one rule with 2D: the shell's 主航道 card is placed after the words and keeps off them — the words do
    // not keep off it, so the picture never depends on which of the two happened to land first)
    // (refine-names, one rule with 2D: the shell's 主航道 ring is known from the first frame — the place and the size the
    // shell gives it (main.js heroTick) — so the cards' first picks already keep off it, wherever the DOM ring is yet)
    if (!this._obsT || now - this._obsT > 800 || (L.labGate || 0) < 0.99) {
      this._obsT = now;
      const obs = this._obstacles(['hero-cap', 'hero-ring']);
      const hr = this.heroId && L.world.idxOf.has(this.heroId) && !this.tr ? this.getChildScreenRect(this.heroId) : null;
      if (hr && Number.isFinite(hr.cx)) {
        const rc = this.canvas.getBoundingClientRect(), Rr = clamp(Math.min((hr.r || 60) * 0.42, hr.width * 0.32, hr.height * 0.32), 22, 46);
        obs.push({ id: 'hero-ring', x0: hr.cx - rc.left - Rr - 4, y0: hr.cy - rc.top - Rr - 4, x1: hr.cx - rc.left + Rr + 4, y1: hr.cy - rc.top + Rr + 4 });
      }
      L.labels.obstacles = obs;
    }
    worlds.forEach((o) => { o.world.root.visible = o === L; });
    // the 主航道 in its own pass on top: no cloud, storm or rain ever cuts through the arc or its head
    if (L.fx.chan && L.reveal > 0.01) {
      R.clearDepth();
      this.camera.layers.set(ARC_LAYER);
      this.camera.layers.enable(DEPTH_LAYER);
      R.render(this.scene, this.camera);
      this.camera.layers.set(0);
    }
    this._veil(L, dt, now);
    // labels are never hidden by clouds: they are placed first, and a cloud under a label fades (below)
    L.labels.blockers = [];
    const Rpx = this.view.R * L.world.root.scale.x * this.zoom;
    const labA = L.reveal * (L.labGate || 0) * (fadeA < 0.5 || back !== L ? 1 : 0);
    // secondary captions (水位 / cloud / intel words): at most one, and only while ①②③ + 主航道 leave room
    const budget = (L.nSpot || 0) + (L.chanOn ? 1 : 0) < 4 ? 1 : 0;
    const liq = this._placeLiq(labA * (tr ? 0 : 1), L.labels.obstacles, budget);
    L.labels.pre = liq.rects;
    L.labels.extraBudget = Math.max(0, budget - liq.used);
    const ins = this.insets;
    L.labels.edgeBox = L.world.real && !tr ? { x0: ins.left + 10, y0: ins.top + 10, x1: this.W - ins.right - 10, y1: this.H - ins.bottom - 10 } : null;
    L.labels.zoom = this.zoom;
    L.labels._Rpx = Rpx;
    L.labels.update(this.camera, this.W, this.H, labA, Rpx, L.fx.clouds, L.fx.chanGeo(Rpx), L.fx.intelObjs);
    this._placeClouds(L, dt, Rpx);
    if (tr && tr.from) tr.from.labels.update(this.camera, this.W, this.H, 0, 0, null, null, tr.from.fx.intelObjs);
    this.css.render(this.scene, this.camera);
    this._capLeader(now);
    this.stats.calls = R.info.render.calls;
    this.stats.triangles = R.info.render.triangles;
  }

  /** §26 paper veil behind the top bar / gauges / since-line while a zoomed real Earth runs under them. */
  _veil(L, dt, now) {
    // (§26 amendment 5, refine-surface: a zoomed 抽象 planet runs under the top bar and the gauges too — 2D veils both)
    const want = clamp((this.zoom - 1.04) / 0.35, 0, 1);
    const u = this.veilMat.uniforms;
    u.uA.value += (want - u.uA.value) * (1 - Math.exp(-dt * 6));
    if (u.uA.value < 0.01) return;
    if (!this._veilT || now - this._veilT > 700) {
      this._veilT = now;
      let n = 0;
      if (typeof document !== 'undefined') {
        const rect = this.canvas.getBoundingClientRect();
        for (const id of ['topbar', 'gauges', 'since']) {
          const el = document.getElementById(id);
          if (!el || el.hidden || n >= 4) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
          // the top bar: its whole strip; the others: their box
          const x0 = id === 'topbar' ? -40 : r.left - rect.left, x1 = id === 'topbar' ? this.W + 40 : r.right - rect.left;
          u.uRects.value[n++].set(x0, id === 'topbar' ? -40 : r.top - rect.top, x1, r.bottom - rect.top);
        }
      }
      u.uN.value = n;
    }
    this.renderer.render(this.veilScene, this.skyCam);
  }

  /** Turn the globe by a screen-space drag: yaw about the view's up axis, pitch about its right axis. */
  _spin(yaw, pitch) {
    // §26 amendment 5: a map does not tilt — yaw about the globe's own axis, pitch about the screen's x (north stays up,
    // as the 2D camera; the look point's latitude stays within ±84°, a yaw moves the ground at the middle by `yaw`)
    const L = this.live;
    if (!L) {
      const dq = new THREE.Quaternion().setFromAxisAngle(AX_Y, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(AX_X, pitch));
      this.rot.q.premultiply(dq).normalize();
      return;
    }
    const pose = this.rot.q.clone();
    if (L.aimQ) pose.multiply(L.aimQ);
    const nC = AX_Y.clone().applyQuaternion(pose).normalize(); // north, in camera space
    const sl = clamp(nC.z, -1, 1), phi = Math.asin(sl), cphi = Math.sqrt(Math.max(0, 1 - sl * sl));
    const lim = (84 * Math.PI) / 180;
    const a = clamp(pitch, -lim - phi, lim - phi);
    const qy = new THREE.Quaternion().setFromAxisAngle(nC, yaw / Math.max(0.25, cphi));
    const qx = new THREE.Quaternion().setFromAxisAngle(AX_X, a);
    this.rot.q.premultiply(qy).premultiply(qx).normalize();
  }

  /** Inner radius of the atmosphere band (planet radii): it hugs the planet's ink line, no paper gap. */
  _atmoR0() { return 1 + ((this.look.day ? 1.7 : 1.5) + 0.6) / Math.max(40, this.view.R); }
  _atmoW(lq) { return lq ? 0.03 + 0.03 * clamp(Math.abs(lq.pressure), 0, 3) : 0.022; }

  /** Atmosphere band uniforms: a thin calm halo, or the §24 liquidity pressure band (水位). */
  _atmo(sky, dt, vis) {
    const lq = this.ov.liquidity, Lk = this.look;
    this._atmoA = (this._atmoA == null ? vis : this._atmoA + (vis - this._atmoA) * (1 - Math.exp(-dt * 5)));
    const a = this._atmoA;
    const r0 = this._atmoR0();
    if (lq) {
      const p = clamp(Math.abs(lq.pressure), 0, 3);
      const flow = lq.state === '放水' ? 1 : lq.state === '收水' ? -1 : 0;
      // calm: the rings still drift (inward when pressure is up, outward when down), at half contrast
      const drift = flow || (lq.pressure < -0.05 ? -0.5 : 0.5);
      sky.uAtmo.value.set(this._atmoW(lq), 0.8 * a, drift, r0);
      sky.uAtmoT.value.set(Math.round(12 + 12 * p), 0.5);
      sky.uAtmoLit.value.copy(flow > 0 ? Lk.liqIn : flow < 0 ? Lk.liqOut : Lk.atmo);
      sky.uAtmoSh.value.copy(flow > 0 ? Lk.liqInSh : flow < 0 ? Lk.liqOutSh : Lk.atmoSh);
    } else {
      sky.uAtmo.value.set(0.022, 0.55 * a, 0, r0);
      sky.uAtmoT.value.set(0, 0);
      sky.uAtmoLit.value.copy(Lk.atmo);
      sky.uAtmoSh.value.copy(Lk.atmoSh);
    }
  }

  /**
   * The liquidity caption (水位): a quiet line of halo text just outside the band — only when it is news
   * (a fresh regime change, 放水 / 收水, or |pressure| ≥ 1.5, within the secondary-caption budget) or while
   * the pointer is on the band. A calm 平稳 day keeps the band and says nothing. Returns {rects, used}.
   */
  _placeLiq(vis, obstacles, budget) {
    const lq = this.ov.liquidity;
    const off = () => { if (this._liqEl) this._liqEl.classList.add('p3-off'); return { rects: [], used: 0 }; };
    if (!lq || vis < 0.05) return off();
    const news = !!lq.fresh || lq.state !== '平稳' || Math.abs(lq.pressure) >= 1.5;
    const hov = !!this._liqHover;
    if (!hov && !(news && (budget > 0 || lq.fresh))) return off();
    if (!this._liqEl) {
      this._liqEl = document.createElement('div');
      this._liqEl.className = 'p3-liq p3-off';
      this.layer.appendChild(this._liqEl);
    }
    const el = this._liqEl;
    const cls = lq.state === '放水' ? 'p3-liq-in' : lq.state === '收水' ? 'p3-liq-out' : 'p3-liq-calm';
    const pw = presWord(lq.pressure);
    const html = `<span class="p3-liq-dot ${cls}"></span><span class="p3-liq-k">水位</span><b>${esc(lq.state)}</b><span class="p3-liq-p">${pw}</span>${lq.say ? `<span class="p3-liq-say">${esc(lq.say)}</span>` : ''}`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; el._sz = null; }
    el.classList.toggle('p3-liq-news', news);
    if (!el._sz) {
      const wasOff = el.classList.contains('p3-off');
      const r = el.getBoundingClientRect();
      if (r.width) el._sz = { w: r.width, h: r.height };
      else if (wasOff) { el.classList.remove('p3-off'); el.style.opacity = '0'; const r2 = el.getBoundingClientRect(); if (r2.width) el._sz = { w: r2.width, h: r2.height }; }
    }
    const { w: ew, h: eh } = el._sz || { w: 220, h: 18 };
    const v = this.view;
    const rr = v.R * (this._atmoR0() + this._atmoW(lq)) + 8;
    const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    let best = null;
    for (const deg of [-40, -58, -24, -140, -122, 40, 140, -90, 90, -8, 188]) {
      const t = (deg * Math.PI) / 180, ux = Math.cos(t), uy = Math.sin(t);
      let cx = v.cx + ux * (rr + Math.abs(ux) * ew / 2), cy = v.cy + uy * (rr + Math.abs(uy) * eh / 2);
      // push out until the rect's nearest point to the planet's centre clears the band
      for (let it = 0; it < 5; it++) {
        const nx = clamp(v.cx, cx - ew / 2, cx + ew / 2), ny = clamp(v.cy, cy - eh / 2, cy + eh / 2);
        const d = Math.hypot(nx - v.cx, ny - v.cy);
        if (d >= rr) break;
        cx += ux * (rr - d + 1); cy += uy * (rr - d + 1);
      }
      const r = { x0: cx - ew / 2 - 4, x1: cx + ew / 2 + 4, y0: cy - eh / 2 - 4, y1: cy + eh / 2 + 4 };
      if (r.x0 < 6 || r.y0 < 6 || r.x1 > this.W - 6 || r.y1 > this.H - 6) continue;
      if ((obstacles || []).some((q) => hit(r, q))) continue;
      best = { cx, cy, r };
      break;
    }
    if (!best) return off();
    el.style.transform = `translate(${(best.cx - ew / 2).toFixed(1)}px,${(best.cy - eh / 2).toFixed(1)}px)`;
    el.style.opacity = String(Math.min(1, vis));
    el.classList.remove('p3-off');
    return { rects: [best.r], used: hov ? 0 : 1 };
  }

  /**
   * Labels always win over clouds: each cloud / storm cloud glides to a spot inside its own territory
   * that keeps clear of every placed label, card and caption; when there is no such spot it fades out
   * under the label instead (never the other way round).
   */
  _placeClouds(L, dt, Rpx) {
    // (final, one rule with 2D planet._layoutClouds: a ①②③ card's anchor dot keeps a cloud ±8 px off, an edge chip's ±9)
    const rects = (L.labels.placed || []).filter((q) => !q.arc).map((q) => {
      if (!q.capDot) return q;
      const x = (q.x0 + q.x1) / 2, y = (q.y0 + q.y1) / 2, h = q.capDot;
      return { x0: x - h, x1: x + h, y0: y - h, y1: y + h };
    });
    const w = L.world;
    const rq = w.root.quaternion.clone().invert();
    const M = w.root.matrixWorld;
    const v = new THREE.Vector3();
    const project = (p) => this._project(v.copy(p).applyMatrix4(M));
    // the 主航道 (and its branch): ~12 padded rects along the arc, the head included
    const cg = L.fx.chanGeo(Rpx);
    for (const g of cg ? [cg, cg.branch].filter(Boolean) : []) {
      const pad = 10 + (g.R0 || 0.02) * Rpx;
      for (const p of g.poly || []) {
        const [x, y] = project(p);
        rects.push({ x0: x - pad, x1: x + pad, y0: y - pad, y1: y + pad, arcObs: true });
      }
    }
    // a prop's ground spot must project inside 0.85 R (never floating off the globe at the limb)
    const D = this.view.D, sil = 1 / Math.sqrt(Math.max(1.01, D * D - 1));
    const cam = new THREE.Vector3(0, 0, 1).applyQuaternion(rq);
    const dd = new THREE.Vector3();
    const fracOf = (d) => {
      dd.copy(d).normalize();
      const c = dd.dot(cam);
      if (c <= 0) return 2;
      return (Math.sqrt(Math.max(0, 1 - c * c)) / (D - c) / sil) * this.zoom;
    };
    const a = 1 - Math.exp(-dt * 7);
    const overlap = (r, key) => {
      let o = 0;
      for (const q of rects) {
        if (q.cloud && q.cloud === key) continue;
        const ix = Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0), iy = Math.min(r.y1, q.y1) - Math.max(r.y0, q.y0);
        if (ix > 2 && iy > 2) o += ix * iy;
      }
      return o;
    };
    // (integrator, one rule with 2D planet._layoutClouds — refine-weather's extras): a tiny territory's ring (±14 px round
    // its money, world._buildTiny) is never under a cloud either; past the free screen (the shell's panel and bars) counts
    // as the shell's UI; a later cloud prefers a spot clear of the clouds placed before it (soft: the spot, never the fade)
    if (w.real && w.um && w.um.tiny) for (const k of w.um.tiny) {
      const hd = k < w.n ? w.hubDir[k] || w.anchorDir[k] : null;
      if (!hd || hd.dot(w.camObj) < 0.05) continue;
      const [x, y] = project(hd);
      rects.push({ x0: x - 14, x1: x + 14, y0: y - 14, y1: y + 14 });
    }
    const ins = this.insets;
    const offFree = (r) => r.x0 < (ins.left || 0) + 2 || r.y0 < (ins.top || 0) + 2 || r.x1 > this.W - (ins.right || 0) - 2 || r.y1 > this.H - (ins.bottom || 0) - 2;
    const uiObs = (L.labels && L.labels.obstacles) || [];
    const onUi = (r) => uiObs.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
    const cloudRects = [];
    const overC = (r) => {
      let o = 0;
      for (const q of cloudRects) {
        const ix = Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0), iy = Math.min(r.y1, q.y1) - Math.max(r.y0, q.y0);
        if (ix > 2 && iy > 2) o += ix * iy;
      }
      return o;
    };
    const cands = (k) => w.cands(k);
    /** a cloud about a place (refine #8): that place first, then a small ring round it (clear of the labels) */
    const near = (o) => {
      if (o._nearOf === o.place && o._near) return o._near;
      const out = [o.place.clone()], [e, n] = frame3v(o.place), r = 0.05 * (w.ws || 1);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; out.push(o.place.clone().addScaledVector(e, Math.cos(a) * r).addScaledVector(n, Math.sin(a) * r).normalize()); }
      o._nearOf = o.place; o._near = out;
      return out;
    };
    const place = (o, key) => {
      if (o.place && o._pl !== o.place) { o._pl = o.place; o.spotTarget = o.place.clone(); }
      if (!o.obj.visible || !(o.vis > 0.05)) { o.fade = o.fade == null ? 1 : o.fade; return; }
      const list = o.place ? near(o) : cands(o.k);
      const cur = o.spotTarget || null;
      // score = what it would cover (labels, cards, the arc) + how far past 0.85 R it would float
      let best = null, bestS = Infinity, bestO = Infinity;
      const tryAt = (d, bias) => {
        const r = propRect(w, o, d, rq, project, Rpx);
        if (r.facing < 0.4) return;
        const fr = fracOf(d);
        // (final, one rule with 2D _layoutClouds' uiHit: the shell's floating UI and the 主航道 ring count as UI too)
        const ov = overlap(r, key) + (offFree(r) || onUi(r) ? 1e5 : 0);
        const sc = ov + bias + (fr > 0.85 ? 8e4 * (fr - 0.85) : 0) + 0.5 * overC(r);
        if (sc < bestS) { bestS = sc; bestO = ov; best = d; }
      };
      if (cur) tryAt(cur, -1); // keep the current spot while it stays clear (no jitter)
      if (bestS > 0) for (const d of list) { tryAt(d, 0); if (bestS <= 0) break; }
      if (best) o.spotTarget = best.clone();
      if (best && key != null) cloudRects.push(propRect(w, o, best, rq, project, Rpx));
      o.edge = best ? fracOf(best) : 1;
      const target = bestO > 0 ? 0.16 : 1;
      o.fade = o.fade == null ? target : o.fade + (target - o.fade) * a;
    };
    for (const [key, o] of L.fx.clouds) place(o, key);
    for (const o of L.fx.storms.values()) place(o, null);
  }

  _tickLive(L, dt, now, rise) {
    const w = L.world;
    w.zoomNow = w.real ? this.zoom : 1;
    this.ctx.Rpx = this.view.R * w.root.scale.x * this.zoom;
    this.ctx.ws = w.ws || 1;
    // (refine-names, one rule with 2D: the 主航道 tube keeps its screen width on a zoomed 抽象 planet too, as on the real
    // Earth — it was 34 px at 抽象 ×4 against 2D's 9; stepped by ~2.5 % so the tube is not rebuilt every frame of a glide)
    this.U.uChanScale.value = w.real ? w.ws || 1 : Math.exp(-Math.round(Math.log(Math.max(1, this.zoom || 1)) * 40) / 40);
    // hover lift + spotlight breathing (≤ 3)
    const blink = L.blink || new Map();
    for (let k = 0; k < w.n; k++) {
      let t = this.hoverIdx === k ? 1 : 0;
      if (blink.has(k) && blink.get(k) < 10) t = Math.max(t, 0.35 + 0.35 * Math.sin(now / 520 + k));
      w.liftTarget[k] = t;
    }
    const qi = w.root.quaternion.clone().invert();
    w.camObj.set(0, 0, 1).applyQuaternion(qi);
    w.tick(dt, rise);
    w.root.updateMatrixWorld(true);
    this.U.uLobj.value.copy(this.U.uL.value).applyQuaternion(qi);
    w.heightGrid();
    const playing = L.reveal > 0.05 || rise > 0.3;
    L.wind.group.visible = rise > 0.5;
    L.wind.mat.uniforms.uAlpha.value = this.look.windAlpha * (w.scenOn ? 0.55 : 1) * smooth(clamp((rise - 0.5) / 0.5, 0, 1));
    L.wind.update(dt, playing, this.view.R * w.root.scale.x * this.zoom);
    if (w.points) {
      w.pointMat.uniforms.uA.value = smooth(clamp(rise, 0, 1));
      w.pointMat.uniforms.uGround.value = w.neutralH();
      this._fanPoints(L);
    }
    // §26 amendment 4: minority dots and tiny-territory rings fade with the plates
    if (w.tickMat) { w.tickMat.uniforms.uA.value = 0.92 * smooth(clamp(rise, 0, 1)); w.tickMat.uniforms.uGround.value = w.neutralH(); }
    if (w.tinyMat) { w.tinyMat.uniforms.uA.value = smooth(clamp((rise - 0.3) / 0.7, 0, 1)); w.tinyMat.uniforms.uGround.value = w.neutralH(); }
    // unclaimed unit borders: barely there at county zoom, a little firmer as the camera comes close
    // (refine #2: each arc fades by its own length on screen — invisible while a county is a few px, so the state
    // lines stay dominant at ×3.6–×8 and the map never reads as a spreadsheet)
    if (w.uPxR) w.uPxR.value = this.view.R * w.root.scale.x * this.zoom;
    if (w.unitNeutralMat) w.unitNeutralMat.uniforms.uA.value = (this.look.day ? 0.09 : 0.1) + 0.05 * clamp((this.zoom - 5) / 30, 0, 1);
    L.fx.group.visible = rise > 0.05;
    L.fx.update(dt, now, L.blink || new Map(), w.root.quaternion, smooth(clamp(rise, 0, 1)) * (L.reveal > 0 || rise >= 1 ? 1 : 0.999));
  }

  /**
   * §26 companies in one city never pile up: markers that would touch on screen are fanned out into a tidy little
   * sunflower around their common centre (biggest in the middle). Screen positions are kept for hit-testing and
   * for the names (labels.js reads w.pointScr).
   */
  _fanPoints(L) {
    const w = L.world;
    const ks = w.pointKs, n = ks ? ks.length : 0;
    if (!n) return;
    const q = w.root.quaternion;
    const key = this.zoom.toFixed(4) + '|' + q.x.toFixed(4) + q.y.toFixed(4) + q.z.toFixed(4) + q.w.toFixed(4) + '|' + this.W + 'x' + this.H;
    if (L._fanKey === key) return;
    L._fanKey = key;
    w.root.updateMatrixWorld(true);
    const M = w.root.matrixWorld, v = new THREE.Vector3(), cam = w.camObj;
    const sz = w.pointSize, off = w.pointOff;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const k = ks[i], d = w.anchorDir[k];
      v.copy(d).multiplyScalar(1 + w.neutralH()).applyMatrix4(M);
      const [x, y] = this._project(v);
      pts.push({ i, k, x, y, r: sz[i] + 1.6, vis: d.dot(cam) > 0.06, tx: x, ty: y });
    }
    // clusters: markers closer than their radii (+ a hair) belong together
    const par = pts.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let a = 0; a < n; a++) {
      if (!pts[a].vis) continue;
      for (let b = a + 1; b < n; b++) {
        if (!pts[b].vis) continue;
        const A = pts[a], B = pts[b];
        if (Math.hypot(A.x - B.x, A.y - B.y) < A.r + B.r + 2) par[find(a)] = find(b);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) if (pts[i].vis) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(pts[i]); }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      let cx = 0, cy = 0;
      for (const p of g) { cx += p.x; cy += p.y; }
      cx /= g.length; cy /= g.length;
      g.sort((a, b) => b.r - a.r);
      const placed = [];
      for (const p of g) {
        let best = null;
        for (let j = 0; j < 400 && !best; j++) {
          const rr = j === 0 ? 0 : 2.2 * Math.sqrt(j) * 2.4, a = j * 2.39996;
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.92;
          if (placed.every((o) => Math.hypot(o.tx - x, o.ty - y) >= o.r + p.r + 1.5)) best = [x, y];
        }
        if (best) { p.tx = best[0]; p.ty = best[1]; }
        placed.push(p);
      }
    }
    for (const p of pts) { off[2 * p.i] = p.tx - p.x; off[2 * p.i + 1] = -(p.ty - p.y); }
    w.points.geometry.attributes.aOff.needsUpdate = true;
    w.pointScr = pts;
    w.pointOffOf = (k) => { const p = pts.find((o) => o.k === k); return p ? [p.tx - p.x, p.ty - p.y] : [0, 0]; };
  }

  /** A company marker under canvas point (x, y) → k, else −1. */
  _hitPoint(L, x, y) {
    const P = L.world.pointScr;
    if (!P) return -1;
    let best = -1, bd = Infinity;
    for (const p of P) {
      if (!p.vis) continue;
      const d = Math.hypot(p.tx - x, p.ty - y);
      if (d <= p.r + 4 && d < bd) { bd = d; best = p.k; }
    }
    return best;
  }

  _tickFrozen(old) {
    old.world.camObj.set(0, 0, 1).applyQuaternion(old.world.root.quaternion.clone().invert());
    old.wind.group.visible = old.reveal > 0.01;
    old.wind.mat.uniforms.uAlpha.value = old.reveal;
    old.fx.group.visible = old.reveal > 0.01;
    old.world.root.updateMatrixWorld(true);
  }

  _endTransition(abort) {
    const tr = this.tr;
    if (!tr) return;
    this.tr = null;
    if (tr.dir === 'fly' || (tr.to && tr.to.realView)) {
      this._setZoom(tr.z1 || (tr.to.realView ? tr.to.realView.zoom : 1));
      if (tr.to) { tr.to.lockedAt = performance.now(); tr.to.wind.setTarget(this._windTarget()); }
    }
    if (tr.from && tr.from !== this.live) this._disposeLive(tr.from);
    if (this.live) {
      const w = this.live.world;
      w.root.visible = true;
      w.root.scale.setScalar(1);
      w.root.position.set(0, 0, 0);
      w.uRise.value = 1;
      if (abort) this.live.reveal = 1;
      if (!this.live.aimLocked) this.live.aimLockAt = performance.now() + (this.live.ovArrived ? 250 : AIM_GRACE);
    }
    this._dirty = true;
    if (tr.resolve) tr.resolve();
  }

  _adapt(now, dt, work) {
    const s = this.stats;
    s.frames++;
    const ms = dt * 1000;
    if (ms > 0) {
      s.frameMs = s.frameMs * 0.92 + ms * 0.08;
      s.fps = 1000 / Math.max(1, s.frameMs);
    }
    s.workMs = s.workMs * 0.9 + work * 0.1;
    s.quality = this.q;
    if (this.tr || document.hidden) { this._adaptT = now; return; }
    s.steadyMs = s.steadyMs * 0.95 + ms * 0.05;
    if (now - this._adaptT < 1600) return;
    if (s.steadyMs > 21 && this.q < QUALITY.length - 1) {
      this.q++; this._adaptT = now; this._applyQuality();
    } else if (s.steadyMs < 13 && this.q > 0 && now - this._adaptT > 6000) {
      this.q--; this._adaptT = now; this._applyQuality();
    }
    if (this.q === QUALITY.length - 1 && s.steadyMs > 45) {
      if (!this._slowT) this._slowT = now;
      if (now - this._slowT > 5000 && this.cb.onSlow && !this._slowFired) { this._slowFired = true; this.cb.onSlow(this.getStats()); }
    } else this._slowT = 0;
  }

  _applyQuality() {
    const pr = Math.min(QUALITY[this.q].pr, window.devicePixelRatio || 1);
    if (pr !== this.pr) {
      this.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(this.W, this.H, false);
      this._applyView();
    }
    if (this.live) this.live.wind.setTarget(this._windTarget());
  }

  // ============================================================================== input
  _bind() {
    const c = this.canvas;
    this._h = {
      move: (e) => this._pointerMove(e),
      leave: () => { this._cancelPress(); this._liqHover = false; if (!this.rot.dragging) this._setHover(-1, null); },
      down: (e) => this._pointerDown(e),
      up: (e) => this._pointerUp(e),
      click: (e) => this._click(e),
      wheel: (e) => this._wheel(e),
      ctx: (e) => this._contextMenu(e),
      key: (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) this.cb.onBack();
      },
    };
    c.addEventListener('pointermove', this._h.move);
    c.addEventListener('pointerleave', this._h.leave);
    c.addEventListener('pointerdown', this._h.down);
    c.addEventListener('pointerup', this._h.up);
    c.addEventListener('pointercancel', this._h.up);
    c.addEventListener('click', this._h.click);
    c.addEventListener('contextmenu', this._h.ctx);
    c.addEventListener('wheel', this._h.wheel, { passive: false });
    if (this.opts.keys) window.addEventListener('keydown', this._h.key);
    if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(c); }
    else window.addEventListener('resize', (this._onResize = () => this.resize()));
  }

  _unbind() {
    const c = this.canvas, h = this._h;
    c.removeEventListener('pointermove', h.move);
    c.removeEventListener('pointerleave', h.leave);
    c.removeEventListener('pointerdown', h.down);
    c.removeEventListener('pointerup', h.up);
    c.removeEventListener('pointercancel', h.up);
    c.removeEventListener('click', h.click);
    c.removeEventListener('contextmenu', h.ctx);
    c.removeEventListener('wheel', h.wheel);
    window.removeEventListener('keydown', h.key);
    if (this._fc) { this._fc.destroy(); this._fc = null; } // §26 free camera
    if (this._ro) this._ro.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
  }

  _hit(e) {
    const L = this.live;
    this._hitInfo = null;
    if (!L || this.tr) return -1;
    if (this._fc && this._fc.moving()) return -1; // §26 free camera: nothing to hover while the globe turns
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const rs = L.labels.rects;
    for (let i = rs.length - 1; i >= 0; i--) {
      const b = rs[i];
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b.k;
    }
    const w = L.world;
    const pk = this._hitPoint(L, x, y);
    if (pk >= 0) return pk;
    // §26 amendment 4: a minority dot (another child's money inside this unit) — hovering it speaks for that child
    const ti = this._hitTick(L, x, y);
    if (ti >= 0) { this._hitInfo = { via: 'tick', t: w.tickList[ti] }; return w.tickList[ti].k; }
    const ndc = new THREE.Vector2((x / this.W) * 2 - 1, -(y / this.H) * 2 + 1);
    this._raycaster.setFromCamera(ndc, this.camera);
    const ray = this._raycaster.ray.clone().applyMatrix4(this._tmpM.copy(w.root.matrixWorld).invert());
    // the plates stand at different heights: hit the tallest shell, then settle on the plate under it
    let maxH = 0;
    for (let k = 0; k < w.n; k++) maxH = Math.max(maxH, w.hAt(k));
    const sph = new THREE.Sphere(new THREE.Vector3(), 1), hp = new THREE.Vector3();
    let k = -1, rad = 1 + maxH;
    for (let it = 0; it < 4; it++) {
      sph.radius = rad;
      if (!ray.intersectSphere(sph, hp)) { if (rad <= 1.0005) return -1; rad = 1; continue; }
      const kk = w.ownerAt(hp.normalize());
      if (kk >= 0 && w.kind && w.kind[kk] === 'point') return -1; // a marker is hit on screen (above), not by its little disc
      if (kk < 0) { if (rad <= 1.0005) return -1; rad = 1; continue; } // the sea (or a lower plate under it)
      const nr = 1 + w.hAt(kk);
      if (kk === k || Math.abs(nr - rad) < 0.002) { this._hitInfo = { via: 'ground', d: hp.clone() }; return kk; }
      k = kk; rad = nr;
    }
    if (k >= 0) this._hitInfo = { via: 'ground', d: hp.clone() };
    return k;
  }

  /** A tick dot under canvas point (x, y) → its index in world.tickList, else −1. */
  _hitTick(L, x, y) {
    const w = L.world, T = w.tickList, D = w.tickDir;
    if (!T || !T.length || !D) return -1;
    const M = w.root.matrixWorld, v = new THREE.Vector3();
    let best = -1, bd = Infinity;
    for (let i = 0; i < T.length; i++) {
      if (D[i].dot(w.camObj) < 0.06) continue;
      v.copy(D[i]).multiplyScalar(1 + w.neutralH() + 0.0035).applyMatrix4(M);
      const [sx, sy] = this._project(v);
      const d = Math.hypot(sx - x, sy - y);
      if (d <= (w.tickSize ? w.tickSize[i] : 3) + 4 && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** The unit tag for the pointer (hit info from _hit): a minority dot, or the admin unit under the ground point. */
  _unitHover(e) {
    const L = this.live, h = this._hitInfo, tag = this._utag;
    if (!tag) return;
    if (!L || !h || this.hoverIdx < 0 || this.tr || !L.world.um) { tag.hide(); return; }
    const w = L.world, kids = w.children;
    let txt = null;
    if (h.via === 'tick') txt = tickText(w.um, h.t, kids);
    else if (h.via === 'ground' && w.unitFs && w.kind[this.hoverIdx] === 'land') {
      const [lon, lat] = lonLatOf(h.d.x, h.d.y, h.d.z);
      const key = lon.toFixed(3) + ',' + lat.toFixed(3);
      if (this._uhKey !== key) { this._uhKey = key; this._uh = unitHit(w.um, w.unitFs, lon, lat); }
      const u = this._uh;
      if (u && u.k === this.hoverIdx) txt = unitText(w.um, u, kids);
    }
    if (txt) tag.show(txt.head, txt.line, e.clientX, e.clientY); else tag.hide();
  }

  _setHover(k, e) {
    const L = this.live;
    const changed = k !== this.hoverIdx;
    this.hoverIdx = k;
    this.canvas.style.cursor = this.rot.dragging ? 'grabbing' : k >= 0 ? 'pointer' : '';
    if (changed) { this._dirty = true; }
    if (k >= 0 && L) this.cb.onHover(L.world.children[k], { x: e.clientX, y: e.clientY });
    else if (changed) this.cb.onHover(null, e ? { x: e.clientX, y: e.clientY } : null);
    if (k < 0 && this._utag) this._utag.hide();
  }

  _pointerMove(e) {
    const p = this._press;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10 && p.timer) { clearTimeout(p.timer); p.timer = 0; }
    if (p && !this._fc && p.drag !== false && (this.rot.dragging || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) && !this.tr) {
      if (!this.rot.dragging) {
        this.rot.dragging = true;
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (this.hoverIdx >= 0) this._setHover(-1, e);
      }
      // a point under the cursor follows it (≈ 1 rad per planet radius dragged)
      const k = 1 / Math.max(120, this.view.R * (this.zoom || 1));
      const dx = e.clientX - p.lx, dy = e.clientY - p.ly;
      p.lx = e.clientX; p.ly = e.clientY;
      const r = this.rot;
      this._spin(dx * k, dy * k);
      // fling speed from the last ~100 ms of movement, capped (a flick turns the globe, never spins it away)
      const now = performance.now();
      (p.hist || (p.hist = [])).push([now, dx * k, dy * k]);
      while (p.hist.length > 2 && now - p.hist[0][0] > 100) p.hist.shift();
      const span = Math.max(16, now - p.hist[0][0]) / 1000;
      let sy = 0, sx = 0;
      for (const h of p.hist) { sy += h[1]; sx += h[2]; }
      const cap = 3.2, wy = sy / span, wx = sx / span, m = Math.hypot(wx, wy);
      const f = m > cap ? cap / m : 1;
      r.wy = wy * f; r.wx = wx * f;
      p.t = now;
      r.release = now;
      this._dirty = true;
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const k = this._hit(e);
    this._setHover(k, e);
    this._unitHover(e);
    // the 水位 band: its caption speaks while the pointer is on it
    let lh = false;
    if (k < 0 && this.ov.liquidity && !this.tr) {
      const rect = this.canvas.getBoundingClientRect();
      const v = this.view;
      const rr = Math.hypot(e.clientX - rect.left - v.cx, e.clientY - rect.top - v.cy) / Math.max(1, v.R);
      const r0 = this._atmoR0();
      lh = rr > r0 - 0.012 && rr < r0 + this._atmoW(this.ov.liquidity) + 0.03;
    }
    if (lh !== !!this._liqHover) { this._liqHover = lh; this._dirty = true; }
  }

  _pointerDown(e) {
    this._cancelPress();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this._press = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), timer: 0 };
    if (e.pointerType !== 'mouse' && this.cb.onContextMenu) {
      const k = this._hit(e);
      if (k >= 0) {
        const ev = { clientX: e.clientX, clientY: e.clientY };
        this._press.timer = setTimeout(() => {
          if (!this._press || this.rot.dragging) return;
          this._press.timer = 0;
          this._press.drag = false;
          const kk = this._hit(ev);
          if (kk >= 0 && this.live) {
            this._suppressClick = performance.now() + 700;
            this.cb.onContextMenu(this.live.world.children[kk], { x: ev.clientX, y: ev.clientY });
          }
        }, 550);
      }
    }
  }

  _pointerUp(e) {
    if (this.rot.dragging) {
      this.rot.dragging = false;
      // released after holding still: no fling
      const p = this._press;
      if (p && p.t && performance.now() - p.t > 90) this.rot.wx = this.rot.wy = 0;
      this.rot.release = performance.now();
      this._suppressClick = performance.now() + 250;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.canvas.style.cursor = '';
    }
    this._cancelPress();
  }

  _cancelPress() {
    if (this._press) { if (this._press.timer) clearTimeout(this._press.timer); this._press = null; }
  }

  _contextMenu(e) {
    if (!this.cb.onContextMenu) return;
    const k = this._hit(e);
    if (k < 0 || !this.live) return;
    e.preventDefault();
    if (this._suppressClick && performance.now() < this._suppressClick) return;
    this.cb.onContextMenu(this.live.world.children[k], { x: e.clientX, y: e.clientY });
  }

  _click(e) {
    if (this._suppressClick && performance.now() < this._suppressClick) { this._suppressClick = 0; return; }
    const k = this._hit(e);
    if (k >= 0 && this.live) this.cb.onClick(this.live.world.children[k]);
  }

  // §26 free camera: the wheel zooms continuously at the cursor (planet/controls.js) — it no longer changes level
  _wheel(e) { if (!this._fc) e.preventDefault(); }
}

// ------------------------------------------------------------------------------------------ helpers
/** The classic front line for territory k: a run of its coast pulled 26 % in toward its anchor, on the side facing the planet's front. */
function frontGeo(w, k) {
  const T = w.S && w.S.terr[k];
  const poly = T && T.polys.slice().sort((a, b) => b.ext.length - a.ext.length)[0];
  if (!poly || poly.ext.length < 18) return null;
  const r = poly.ext, m = r.length / 3;
  // (refine: the line is drawn just inside ITS OWN piece — pulled toward that piece's centre, never toward an anchor on
  // another piece across the water, and kept on its land: no front floating in the Gulf of Mexico)
  const a = new THREE.Vector3();
  for (let i = 0; i < m; i++) a.x += r[3 * i], a.y += r[3 * i + 1], a.z += r[3 * i + 2];
  a.normalize();
  const own = (q) => !w.real || !w.S.ownerAt || w.S.ownerAt(q.x, q.y, q.z) === k;
  const pts = [];
  for (let i = 0; i < m; i++) {
    const p0 = new THREE.Vector3(r[3 * i], r[3 * i + 1], r[3 * i + 2]);
    let q = null;
    for (const t of [0.26, 0.14, 0.06]) { const c = p0.clone().lerp(a, t).normalize(); if (own(c)) { q = c; break; } }
    pts.push(q || p0);
  }
  let best = 0, bd = -2;
  pts.forEach((p, i) => { const d = p.dot(w.frontDir); if (d > bd) { bd = d; best = i; } });
  const half = Math.floor(m * 0.31), run = [];
  for (let i = -half; i <= half; i++) run.push(pts[(best + i + m) % m]);
  return run.length >= 4 ? run : null;
}
function frame3v(d) {
  const e = new THREE.Vector3(d.z, 0, -d.x);
  if (e.lengthSq() < 1e-10) e.set(1, 0, 0);
  e.normalize();
  return [e, new THREE.Vector3().crossVectors(d, e).normalize()];
}
/** The name of the unit a child's money hub sits in, when the child owns it (item.metros[].at at the hub): '西城区'. */
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
/** The 全球 map's planets (gl-* ids) are the real Earth; everything else is abstract islands. */
function guessGeo(node) {
  const id = String((node && node.id) || '');
  if (id.startsWith('gl-')) return 'earth';
  return (node && node.children || []).some((c) => String(c.id || '').startsWith('gl-')) ? 'earth' : 'abstract';
}

/** 'liquidity' overlay → {pressure (−3…3), state ('放水'|'收水'|'平稳'), say} or null. */
function normLiq(d) {
  if (!d || typeof d !== 'object') return null;
  let p = +(d.pressure != null ? d.pressure : d.regime && d.regime.pressure);
  if (!Number.isFinite(p)) p = 0;
  p = clamp(p, -3, 3);
  let st = d.state || (d.regime && d.regime.state);
  if (!LIQ_STATES.includes(st)) st = p > 0.5 ? '放水' : p < -0.5 ? '收水' : '平稳';
  let say = String(d.say || (d.regime && d.regime.say) || '').trim();
  if (say.length > 26) say = say.slice(0, 25) + '…';
  const fresh = !!(d.fresh || (d.regime && d.regime.fresh));
  return { pressure: p, state: st, say, fresh };
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
/** Air pressure in one word (never a raw "气压 −0.3"). */
function presWord(p) {
  p = +p || 0;
  return p <= -1.5 ? '气压很低' : p <= -0.5 ? '气压略低' : p < 0.5 ? '气压正常' : p < 1.5 ? '气压偏高' : '气压很高';
}

const subMemo = new WeakMap();
function inSubtree(node, id) {
  if (!node || typeof node !== 'object') return false;
  let set = subMemo.get(node);
  if (!set) {
    set = new Set();
    const walk = (n) => {
      for (const c of n.children || []) { if (c && c.id) set.add(c.id); walk(c); }
      for (const c of n.stocks || []) if (c) set.add(c.id || (c.t ? 's:' + c.t : null));
    };
    walk(node);
    subMemo.set(node, set);
  }
  return set.has(id);
}

const tagMemo = new WeakMap();
function hasTag(node, tag) {
  if (!node) return false;
  let m = tagMemo.get(node);
  if (!m) tagMemo.set(node, (m = new Map()));
  if (m.has(tag)) return m.get(tag);
  let r = Array.isArray(node.tags) && node.tags.includes(tag);
  if (!r && Array.isArray(node.children)) r = node.children.some((c) => hasTag(c, tag));
  if (!r && Array.isArray(node.stocks)) r = node.stocks.some((c) => Array.isArray(c.tags) && c.tags.includes(tag));
  m.set(tag, r);
  return r;
}

export { Planet3D as Planet };
export default Planet3D;
export { LAGS };
