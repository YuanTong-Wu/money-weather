// planet.js — the hero visual: one node of the money tree drawn as a planet with live weather.
// Contract: DESIGN.md §7 (exports), §4 (layers), §6 (attention budget ≤ 3), §8.1 (主航道 + ①②③),
// §8.2 (season glyphs), §14 (估), §17 (art direction: Japanese clean cartoon, day/night), §18 (overlays).
//
//   const planet = new Planet(canvas, { onHover(child|null, {x,y}), onClick(child), onBack(),
//                                       onContextMenu(child, {x,y}), theme: 'day'|'night' });
//   await planet.setNode(node, mapJson, { direction: 'in'|'out'|'none', focusChildId });
//   planet.setDate(i); planet.setLens(tag|null); planet.setSpotlight([{id, why}]); planet.setPins(ids);
//   planet.setOverlay(name, data|null); planet.setTheme('day'|'night');
//   planet.resize(); planet.pause(); planet.resume(); planet.getChildScreenRect(id);
//
// Overlays (§18) — setOverlay(name, data):
//   'channel'   {from, to, say}            主航道 ribbon. Never set (or 'auto') → derived from the map
//                                          (biggest outflow child → biggest inflow child); null → hidden.
//   'numbers'   [{id, n, why}]             ①②③ badges. Never set (or 'auto') → spotlight order; null → none.
//   'seasons'   {id: 'spring'|'summer'|'autumn'|'winter'|null}  (also accepts {key} objects or 春夏秋冬)
//                                          Never set (or 'auto') → §8.2 rule on the map series; null → none.
//   'clouds'    [{id, strength 0–1, label}]                 Polymarket high-altitude clouds.
//   'intel'     [{id, dir, strength 1–3, ageDays, title}]   dashed 预期风 arrows + bolt tags (+ light rain).
//   'scenario'  {nodes:{id:{impact, dir, lag, pricedIn, gap, inferred}}, stage, epicenters:[ids]}
//               → future weather: field = impact (gated by lag ≤ stage), wind follows impact, ripples
//                 from epicentres, badges 时间差 / 已抢跑, inferred dashed. null → back to measured weather.
//   'estimates' [ids]                      hatched + dashed + 估 badge. Children without data in the map
//                                          are estimated automatically (inherit the parent, dimmed).
//
// Notes for the shell
// - onHover's {x,y} are viewport (client) coordinates. It fires on every pointer move over a territory
//   (or its label) and once with null when leaving. onContextMenu fires on right-click / long-press.
// - §26 free camera (planet/freecam2d.js + planet/controls.js): drag rotates, wheel / pinch zoom at the cursor,
//   ＋ / － / 回正 bottom-right, keys + − 0 (arrows while the map has focus). The wheel never changes level: click a
//   territory = onClick, Esc / breadcrumb = the shell's back (pass {keys:true} to let the planet call onBack on Esc).
// - setNode resolves when the flight ends (~1 s). 'in': focusChildId (or node.id) is the territory of the
//   current planet we zoom into; 'out': focusChildId is the child of the new planet we came from.
// - setSpotlight(null) (never set) → the planet itself picks ≤ 3 fronts/storms that may blink;
//   setSpotlight([]) → nothing blinks. Captions show `why`, numbered ①②③ in order.
// - Layout keeps clear of overlays: until setInsets({top,right,bottom,left}) is called it measures
//   #topbar / #timebar / #panel (body.panel-closed respected) itself; captions also avoid #gauges,
//   #pins and #since (constructor option avoidIds to change the list).
// - getChildScreenRect(id) → {x,y,left,top,width,height,right,bottom, cx,cy, lx,ly (label anchor), r} in client px;
//   cx,cy = the label anchor, or on the real Earth where the territory's money is (layout focus.at / item.hub — the
//   ①②③ / 主航道 rule; null when that place is off the map). While the camera moves it follows the map (liveXY).
// - getStats() → {fps, frameMs, steadyMs, workMs, fieldMs, particles}; destroy() removes listeners.
// - §26 真实 (geoMode 'real', geo/real.js): the real Earth — d3.geoOrthographic rotated to layout.view with
//   scale(R0·zoom) (R0 = the porthole radius): every coast on Earth as quiet paper land, the node's regions coloured,
//   sea areas tinting the water, companies as small crisp markers at their HQs (names by zoom). Flying in/out
//   zooms the old picture into the new view's spot (the same camera move as 3D, drawn as a 2D zoom).
// - §26 full-bleed (真实 only; 抽象 keeps the round porthole): the globe itself is the window. At zoom 1 it is the
//   porthole; zooming in, the globe grows (bezel, liquidity band and cel shading fade by ×1.35) until it covers the
//   screen (≈ ×1.7) — then the map runs under the top bar / gauges (a paper veil keeps them legible) like 3D.
//   Geometry: the layout grid is the square [-1, 1]² drawn at R = R0·ext (state.ext ≤ how far the screen reaches),
//   the layout's own zoom is Zl = zoom / ext and the limb sits at local radius state.win = Zl (_realFit / _realWin).
//   Labels, ①②③ cards, the 主航道 caption and clouds are placed by score on the map (planet/names2d.js) once there is no
//   room beside the globe; captions never sit on names / markers / each other / the shell's UI.
// - Where the surface is drawn (_surface): a static base layer (sea, coast foam, neutral land — redrawn only when the
//   view / theme changes) and a weather layer (§26 real: every territory filled flat with its weather colour from its
//   exact rings in `_fillTerritories`, then hatch / isobars / region edges / atlas lines in `_drawEdges`). Admin-unit
//   fills belong in _fillTerritories, their borders in _drawEdges (both in local units: 1 = R px).
// - §26 amendment 4 (real admin borders, planet/units.js): fold lines between two units of one territory and faint
//   unclaimed unit borders (_ctxPath → _drawEdges), minority dots + tiny-territory rings (_drawTicks), the unit tag on
//   hover ('海淀区 · AI 算力 · 也有 金融 3 家'); a camera rebuild asks getLayout(…, {zoom, at}) so the units follow the zoom
//   (states → counties → cities / 区, real.js lod); ZMAX ×150; a ①②③ about a deeper place points at item.childAt.
//   setHeroAnchor(id): on 抽象 the globe turns once so a one-ended 主航道's place faces the viewer.
// - placeCaption(id, {w, h}, {ring}) → {x, y} (client px, top-left) or null: a scored free spot for a shell card
//   (the 主航道 hero pin #hero-cap) near territory `id`; the planet then keeps its own labels / clouds / cards off
//   that box and draws a hairline from the place to it.

import { G, computeLayout, cellAt } from './planet/layout.js';
import { getLayout, onProvidersChange } from './geo/index.js';
import { prepareSphere, neutralPolys, dirOf } from './planet/sphere.js';
import { orthoLayout } from './planet/orthoLayout.js';
import { FreeCam2D } from './planet/freecam2d.js'; // §26 free camera
import { lensD, lensK, lensInv, lensVis } from './planet/persp.js'; // §26 amendment 5: the 3D camera's lens
import { unitModel, unitFiles, unitLines, unitHit, unitText, tickText, UnitTag, deepPlace } from './planet/units.js'; // §26 amendment 4
import { baseLand, windowLand, borderLines, stateLines, viewWindow, admin1For, admin1Lines } from './planet/realearth.js';
import { blendScalar, computeWind, coastWind, isobarPaths, tempBandPaths, bandGrid } from './planet/fields.js';
import { Streams } from './planet/streams.js'; // §26 amendment 5: the 3D wind language (was particles.js)
import { THEMES, BAND_EDGES, bandOf, REAL_LAND, seaLook } from './planet/theme.js';
import { drawSeabed, dotScreen, shadeLand, drawRim, toonLight, unitFade } from './planet/seabed.js'; // §26 amendment 5: the 3D ground
import {
  font, numFont, drawSeason, drawNumber, drawTri, drawEstBadge, drawHourglass, drawBolt, SEASON_KEYS,
} from './planet/glyphs.js';
import {
  channelPoly, curvePt, drawChannel, channelCaptionSpec, drawChannelCaption, frontGeometry, drawFront,
  drawSkyCloud, drawStormCloud, intelArrowGeom, intelTagSpec, drawIntelArrow, drawIntelTag, drawRipple,
} from './planet/overlays.js';
import { drawCelCloud, intelArcGeom, intelBoltSpec, drawIntelBolt } from './planet/overlays.js'; // §26 amendment 5 (weather as in 3D)
import {
  clamp, lerp, smoothstep, easeInOutCubic, easeOutCubic, mulberry32, hashStr, wrapText, roundRect,
} from './planet/util.js';
import { installNames } from './planet/names2d.js'; // §26 amendment 5: the 3D planet's names, cards and 主航道, flat
import { drawPuff, puffBox, drawIntelArc, CLOUD_VARIANTS } from './planet/puffs.js'; // §26 refine: the 3D props, flat

const KEYS = ['wind', 'temp', 'pres', 'storm'];
const LERP_MS = 300;
const FLY_MS = 1000;
const HUB_CUT = 0.05; // §26 amendment 5: the shell's 主航道 pin hides only over 3D's horizon (planet3d.js getChildScreenRect)
const ZMAX_REAL = 150; // §26 amendment 4: the free camera reaches city level (admin3 from ×40)
const N2 = G * G;
const LAGS = ['now', '1-3m', '3-12m', '1y+'];
const STAGE_ZH = { now: '现在', '1-3m': '1–3 个月后', '3-12m': '3–12 个月后', '1y+': '1 年以后' };
const SEASON_ALIAS = { '春': 'spring', '夏': 'summer', '秋': 'autumn', '冬': 'winter', '🌱': 'spring', '☀️': 'summer', '🍂': 'autumn', '❄️': 'winter' };
const OVERLAYS = ['channel', 'numbers', 'clouds', 'intel', 'scenario', 'estimates', 'seasons', 'liquidity'];
const LIQ_STATES = ['放水', '收水', '平稳'];

function valAt(series, key, i) {
  const a = series && series[key];
  if (!a || !a.length || i == null) return NaN;
  const v = a[Math.max(0, Math.min(i, a.length - 1))];
  return v == null ? NaN : +v;
}
function seriesLen(map) {
  if (!map) return 0;
  const s = map.self && map.self.wind;
  if (s && s.length) return s.length;
  for (const k in map.children || {}) {
    const w = map.children[k] && map.children[k].wind;
    if (w && w.length) return w.length;
  }
  return 0;
}
/** §8.2 season rule → 0 spring, 1 summer, 2 autumn, 3 winter, -1 none. */
function seasonRule(w, dw, p) {
  if (!Number.isFinite(w) || !Number.isFinite(p)) return -1;
  if (!Number.isFinite(dw)) dw = 0;
  if (w > 0.3 && dw > 0.3 && p < 65) return 0;
  if ((w < -0.3 && p >= 50) || (dw < -0.6 && p >= 65)) return 2;
  if (w > 0.3 && p >= 65) return 1;
  if ((w < -0.3 && p < 50) || (Math.abs(w) <= 0.3 && p < 35)) return 3;
  return -1;
}
function normSeason(v) {
  if (v && typeof v === 'object') v = v.key;
  if (typeof v !== 'string') return null;
  if (SEASON_KEYS.includes(v)) return v;
  return SEASON_ALIAS[v] || null;
}

export class Planet {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = {
      onHover: opts.onHover || (() => {}),
      onClick: opts.onClick || (() => {}),
      onBack: opts.onBack || (() => {}),
      onContextMenu: opts.onContextMenu || null,
    };
    this.opts = { keys: !!opts.keys, radiusScale: opts.radiusScale || 0.84, geoMode: opts.geoMode || null, mapKey: opts.mapKey || null };
    this._offProv = onProvidersChange(() => { const n = this._lastNav; if (n && !this.transition) this.setNode(n.node, n.mapJson, { direction: 'none' }); });
    this.insets = Object.assign({ top: 0, right: 0, bottom: 0, left: 0 }, opts.insets || {});
    this.theme = THEMES[opts.theme] || THEMES.day;
    this.W = 0; this.H = 0; this.dpr = 1;
    this.view = { cx: 0, cy: 0, R: 100, R0: 100 }; // R0 the porthole radius, R = R0·ext the layout's drawing radius
    this.viewTarget = null;
    this.cur = null;
    this.transition = null;
    this.dateIndex = null;
    this.lens = null;
    this.spot = null; // null = never set (fallback budget), [] = nothing to spotlight
    this.pins = new Set();
    this.ov = { channel: 'auto', numbers: 'auto', seasons: 'auto', clouds: null, intel: null, scenario: null, estimates: null, liquidity: null };
    this._estSet = new Set();
    this._ovVer = 0;
    this.avoidIds = opts.avoidIds || ['gauges', 'pins', 'since'];
    this.hoverIdx = -1;
    this.particles = new Streams();
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._steadySince = 0;
    this._textW = new Map();
    this._labels = [];
    this._sticky = new Map(); // floating captions keep their last spot while it still works (no flicker)
    this._flash = new Map();
    this._rain = new Map();
    this.stats = { fps: 60, frameMs: 16.7, steadyMs: 16.7, workMs: 0, fieldMs: 0, particles: 0, frames: 0 };
    this._adaptT = 0;

    this.bg = document.createElement('canvas');

    this._frameBound = (t) => this._frame(t);
    this._onMove = (e) => this._pointerMove(e);
    this._onLeave = () => { this._cancelPress(); this._setHover(-1, null); };
    this._onClick = (e) => this._click(e);
    this._onWheel = (e) => this._wheel(e);
    this._onCtx = (e) => this._contextMenu(e);
    this._onDown = (e) => this._pointerDown(e);
    this._onUp = () => this._cancelPress();
    this._onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) this.cb.onBack();
    };
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('contextmenu', this._onCtx);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    if (this.opts.keys) window.addEventListener('keydown', this._onKey);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    } else window.addEventListener('resize', (this._onResize = () => this.resize()));

    this._fc = new FreeCam2D(this); // §26 free camera: drag / wheel / pinch / keys / ＋－回正 (planet/freecam2d.js)

    this.resize();
    this.resume();
  }

  // ============================================================================== public API
  // (§26 free camera: `cam: true` = rebuild this node at the live camera, swapped in place — planet/freecam2d.js)
  async setNode(node, mapJson, { direction = 'none', focusChildId, geo: geoArg, cam = false } = {}) {
    if (!node) return;
    // §25: the same landmasses as the 3D planet (geo/index.js), seen orthographically (2D = one hemisphere)
    const tok = (this._navTok = (this._navTok || 0) + 1);
    const mode = geoArg === 'earth' || geoArg === 'abstract' || geoArg === 'real' ? geoArg : typeof this.opts.geoMode === 'function' ? this.opts.geoMode(node) : this.opts.geoMode || guessGeo(node);
    this._lastNav = { node, mapJson };
    let Lpre = null, real = null, fcS = null, fcList = null, cv = null; // §26 free camera
    let absFit = null; // §26 amendment 5: a zoomed 抽象 planet grows past the screen (full-bleed) as the real Earth does
    try {
      cv = this._fc ? this._fc.viewFor(node, mode, cam) : null; // §26 free camera: a manual view on this node
      // §26 amendment 4: a camera view asks for the admin-unit level of its own zoom (real.js lod: states → counties
      // → cities / 区), the same layout memo as every other renderer (geo/index.js keys it by level / 4° cell)
      // §26 amendment 5: a camera rebuild keeps the layout it has while the zoom stays inside its unit level and the
      // camera near its place (Planet3D._reask: the same rule) — no new units, no new raster, no hitch at rest
      const keep = cam && cv && mode === 'real' ? keptList(this.cur, node, mapJson, cv) : null;
      const list = keep || await getLayout(node, node.children || [], mapJson, Object.assign({ mode, map: typeof this.opts.mapKey === 'function' ? this.opts.mapKey() : undefined },
        cv && mode === 'real' ? { zoom: clamp(+cv.scale || 1, 1, ZMAX_REAL), at: [+cv.lon || 0, +cv.lat || 0] } : {}));
      if (!this._sphereMemo) this._sphereMemo = new WeakMap();
      let S = this._sphereMemo.get(list);
      fcList = list;
      if (list && list.mode === 'real') {
        // §26: the node's places on the one real Earth (+ every coast as neutral land), seen full-bleed
        const v = cv || list.view || { lon: 0, lat: 20, scale: 1 };
        const z = clamp(+v.scale || 1, 1, ZMAX_REAL);
        const fit = this._realFit(z);
        if (cv) S = this._fc.sphereFor(list, v, z); // §26 free camera: reuse a window that still covers the view
        if (!S) {
          const win = this._realWin(v, z, list);
          const box = win.box;
          // every coast: 1:50m for the globe, 1:10m (clipped to the window) when the screen holds a small region
          let pre;
          const segMin = Math.min(0.0012, 0.0022 / z); // (the territories' detail: a metro coast keeps its bays)
          if (box && win.ten) {
            // (refine-surface: the unclaimed 1:10m coast at the territories' detail — at the default 0.0012 rad (≈ 7.6 km)
            // Hong Kong and Lantau were a triangle and a quadrilateral at ×60; 3D keeps the 1:10m coast)
            const key = JSON.stringify(box) + '|' + segMin.toExponential(2);
            if (!this._lodPre || this._lodPre.key !== key) this._lodPre = { key, p: windowLand(box).then((p) => neutralPolys(p, segMin)) };
            pre = await this._lodPre.p.catch(() => null);
          }
          if (!pre) {
            if (!this._landPre) this._landPre = baseLand().then((p) => neutralPolys(p));
            pre = await this._landPre;
          }
          // (the filtered list keeps the layout's fields: sphere.js puts anchors on the money only for mode 'real')
          const own = Object.assign(list.filter((it) => !it.neutral), { mode: list.mode, view: list.view, context: list.context, detail: list.detail });
          if (this.running) { await frameGap(); if (tok !== this._navTok) return; } // (§26 amendment 5: the heavy steps in their own tasks)
          S = prepareSphere(own, node.children || [], { coast: false, box, pointR: 0.0065 / z, neutralPre: pre, segMin, rasterW: box ? 1536 : 0 });
          if (cv) this._fc.sphereKeep(list, box, z, S, win.ten); // §26 free camera (own window)
          else this._sphereMemo.set(list, S);
        }
        real = { view: v, zoom: z, dir: dirOf(v.lon, v.lat), context: list.context || {}, ext: fit.ext, Zl: fit.Zl };
        if (this.running && !cam) { await frameGap(); if (tok !== this._navTok) return; }
        Lpre = orthoLayout(S, 'real:' + node.id, real.dir, fit.Zl, this._lensD());
      } else {
        if (!S) {
          if (this.running) { await frameGap(); if (tok !== this._navTok) return; } // (§26 amendment 5: the heavy steps in their own tasks)
          S = prepareSphere(list, node.children || []); this._sphereMemo.set(list, S);
          if (this.running) { await frameGap(); if (tok !== this._navTok) return; }
        }
        absFit = cv ? this._realFit(clamp(+cv.scale || 1, 1, 4)) : null;
        Lpre = cv ? orthoLayout(S, mode + ':' + node.id, dirOf(cv.lon, cv.lat), absFit.Zl, this._lensD()) : orthoLayout(S, mode + ':' + node.id, this._fc ? this._fc.aimDir(S, node, mode, !cam) : null, 1, this._lensD());
      }
      fcS = S;
    } catch (e) { console.warn('[planet] layout', e); }
    if (tok !== this._navTok) return;
    const now = performance.now();
    const prev = this.cur;
    if (this.dateIndex == null) {
      const len = seriesLen(mapJson);
      this.dateIndex = len ? len - 1 : null;
    }
    const st = this._buildState(node, mapJson, Lpre, !!real, { ext: real ? real.ext : absFit ? absFit.ext : 1, kMoney: real ? moneyWeights(node.children || [], fcList) : null });
    st.real = real;
    // §26 full-bleed: R = R0·ext; the globe's limb at local radius win (真实: Zl ≥ 1; 抽象: §26 amendment 5 the same —
    // it was a fixed porthole, 1)
    st.ext = real ? real.ext : absFit ? absFit.ext : 1;
    st.Zl = real ? real.Zl : Lpre && Lpre.zoom ? Lpre.zoom : 1;
    st.win = real ? real.Zl : absFit ? absFit.Zl : 1;
    st.frame = Lpre && Lpre.view ? { v: Lpre.view, Zl: Lpre.zoom || 1 } : null; // (inverse projection: the moving picture)
    // §26 real.js: a place whose money is mostly off the view ('→ 新竹 台积电') — its ①②③ card says where
    st.where = new Map();
    st.whereAt = new Map();
    if (st.frame) st.frame.D = (Lpre && Lpre.D) || 0; // §26 amendment 5: the 3D lens this view was built with (planet/persp.js)
    st.childAt = new Map(); // §26 amendment 4: item.childAt {grandchildId: [lon, lat]} → a ①②③ card about a deeper place points there
    if (real && Array.isArray(fcList)) {
      for (const it of fcList) {
        const k = it && it.offscreen && it.offscreen.label ? st.idxOf.get(it.id) : null;
        if (k != null) { st.where.set(k, String(it.offscreen.label)); st.whereAt.set(k, [+it.offscreen.lon, +it.offscreen.lat]); }
        if (it && it.childAt && typeof it.childAt === 'object') {
          for (const [cid, ll] of Object.entries(it.childAt)) if (Array.isArray(ll) && Number.isFinite(+ll[0]) && Number.isFinite(+ll[1])) st.childAt.set(cid, [+ll[0], +ll[1]]);
        }
      }
    }
    // §26 amendment 4: the layout's admin units — fold lines / unclaimed borders (_ctxPath), minority dots, tiny
    // rings, the unit tag on hover (planet/units.js); the unit files arrive lazily (the edges redraw then)
    st.um = real && Array.isArray(fcList) ? unitModel(fcList, node.children || []) : null;
    st.unitFs = null;
    st.lod = real && fcList ? fcList.lod || null : null;
    st.list = real && Array.isArray(fcList) ? fcList : null; // (inspection / walkers)
    st.focus = new Map((real && fcList && Array.isArray(fcList.focus) ? fcList.focus : []).filter((f) => f && f.id).map((f) => [f.id, f]));
    // §26 refine: where each territory's MONEY is (one rule for the ①②③ cards, the 主航道 ends and 3D): the layout's
    // focus.at for that child, else its money hub (item.hub — the heaviest metro, in view or not), else none (the label).
    // A sector that owns only a leftover county far from its money (网络安全 → Monmouth, NJ) is pointed at its money
    // (圣克拉拉), where its minority dot sits.
    st.S = Lpre ? fcS : null; // §26 amendment 5: the sphere (name candidates, parts, towns, hubs) — names2d.js reads it
    // §26 amendment 5 (as 3D's L.money): every non-sea child, with the points of the units it owns (item.metros[].at)
    // and their share of its money (item.units[].w) — the unit-suffix names and the ≥ 50 % card rule read them
    st.money = new Map();
    if (real && Array.isArray(fcList)) {
      const okLL = (p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]);
      for (const it of fcList) {
        const k = it ? st.idxOf.get(it.id) : null;
        if (k == null || it.kind === 'sea' || it.neutral) continue;
        const f = st.focus.get(it.id);
        const ll = f && okLL(f.at) ? f.at : okLL(it.hub) ? it.hub : null;
        if (!ll) continue;
        const wOf = new Map((Array.isArray(it.units) ? it.units : []).map((u) => [u.id, +u.w || 0]));
        const units = (Array.isArray(it.metros) ? it.metros : []).filter((m) => m && okLL(m.at))
          .map((m) => ({ d: dirOf(+m.at[0], +m.at[1]), w: wOf.get(m.id) || 0, label: m.label || null, ll: [+m.at[0], +m.at[1]] }));
        st.money.set(k, { ll: [+ll[0], +ll[1]], d: dirOf(+ll[0], +ll[1]), label: (f && f.label) || it.hubLabel || null, units, point: it.kind === 'point' });
      }
    }
    this._loadCities(st); // §26 amendment 5: faint city names (≥ ×1.7), the same list as 3D
    if (st.um && st.um.files.length) {
      unitFiles(st.um).then((Fs) => {
        if (!Fs.length) return;
        st.unitFs = Fs;
        if (this.cur === st) { this._ovVer = (this._ovVer || 0) + 1; st.ctxPath = undefined; }
      }).catch(() => {});
    }
    // §26 amendment 5: a camera rebuild crossfades like 3D's in-place swap (planet3d.js _swapReal → _snapFade 360 ms): the
    // picture on screen now (the moving preview or the resting map, words left out) fades out over the new map
    const camSnap = cam && prev && this.running && !this.transition ? this._snapshot(now, true) : null;
    // §26 amendment 5: a level change on the one real Earth flies the camera as 3D does (planet3d.js 'fly'): from the
    // camera on screen now (mid-flight too) to the new view — not when a manual view on this node is kept (cv), as 3D
    const flyFrom = !cam && !cv && real && Lpre && fcS && prev && prev.real && this.running && this._fc && this._fc.cam && this._fc.st === prev && this._fc.S ? { cam: { ...this._fc.cam }, S: this._fc.S, st: prev } : null;
    if (this._fc) this._fc.adopt(st, node, mode, Lpre ? fcS : null, fcList, cv); // §26 free camera

    // geometry of the territory we fly through (for a continuous zoom)
    let geo = null;
    if (prev && (real || prev.real)) {
      // §26: one Earth — zoom the old picture into the new view's spot (or out of the old one), else a calm swap
      geo = real && prev.real ? realHop(prev.real, real, this.viewTarget || this.view, this._freeArea()) : null;
      if (geo) direction = geo.dir;
      else direction = 'none';
    } else if (prev && direction === 'in') {
      const k = prev.idxOf.get(focusChildId || node.id);
      if (k != null) geo = this._terrGeo(prev, k);
    } else if (direction === 'out' && focusChildId) {
      const k = st.idxOf.get(focusChildId);
      if (k != null) geo = this._terrGeo(st, k);
    }
    // (§26 amendment 5: the flight runs 3D's own path — planet/flight.js; no snapshot dissolve, no shrinking rectangle)
    const fly = flyFrom ? this._fc.flyPlan(flyFrom, real) : null;
    if (fly) { geo = null; direction = 'fly'; }
    let snap = null;
    if (prev && this.running && !cam && !fly) snap = this._snapshot(now, true); // (§26 amendment 5: the old words go at once)
    if (this.transition && this.transition.resolve) this.transition.resolve();
    if (this.hoverIdx >= 0) this._setHover(-1, null);

    this.cur = st;
    this._syncR();
    // (§26 amendment 5: a flight's resting map is painted now, while the old picture still stands — as 3D builds before it
    // flies — not on the landing frame)
    if (fly) { try { this._surface(st); } catch (e) { /* drawn on landing instead */ } }
    this._flash.clear();
    this._restPick = null;
    // §26 free camera: a camera rebuild swaps in place (the moving preview already showed this view) — names, markers,
    // cards and the 主航道 stay put (they moved with the picture), wind / clouds / weather marks fade back in
    if (cam && this.running) {
      // §26 amendment 5: the same level keeps its names, cards, 主航道 and wind (carried onto the new view) under a short
      // crossfade; a new level (counties ↔ cities / 区, another unit set) fades its words and weather in under 360 ms
      this.transition = null;
      const lvl = (x) => (x && x.lod ? x.lod.level : null) + '|' + (x && x.um && x.um.files ? x.um.files.join(',') : '');
      const same = !!prev && lvl(prev) === lvl(st) && !!prev.real === !!st.real;
      this._camFade = camSnap ? { snap: camSnap, t0: now, dur: same ? 240 : 360 } : null;
      const carried = same && this._fc && this._fc.carryWind(prev, st);
      st.revealT0 = same ? now - 900 : now - 150;
      st.fxT0 = carried || same ? now - 2000 : now; // (the wind fades its own new lines in: planet/streams.js)
      if (!carried) this.particles.reset(st);
      return;
    }
    if (!this.running) {
      this.transition = null;
      st.revealT0 = now - 2000;
      st.fxT0 = now - 2000;
      this.particles.reset(st);
      if (this._fc) this._fc.landed();
      this._render(now, 0);
      return;
    }
    const dir = prev ? direction : 'intro';
    const dur = fly ? fly.dur : dir === 'none' ? 450 : dir === 'intro' ? 900 : geo ? FLY_MS : 750;
    const zFrom = prev && prev.real ? prev.real.zoom : 1;
    return new Promise((resolve) => {
      this.transition = { dir, t0: now, dur, snap, geo, resolve, zFrom, fly };
    });
  }

  setDate(i) {
    if (i == null || !Number.isFinite(+i)) return;
    this.dateIndex = Math.round(+i);
    if (this.cur) this._applyDate(this.cur, this.dateIndex, true);
  }

  setLens(tag) {
    this.lens = tag || null;
    if (this.cur) this._applyLens(this.cur);
  }

  setSpotlight(list) {
    this.spot = (Array.isArray(list) ? list : [])
      .filter((s) => s && s.id)
      .slice(0, 3)
      .map((s) => ({ id: s.id, why: s.why || '', kind: s.kind || null, deep: s.deepId || s.deep || null }));
  }

  setPins(ids) {
    this.pins = new Set(ids || []);
  }

  /** §18 overlays. See the header for shapes; null clears, 'auto' restores the derived default. */
  setOverlay(name, data) {
    if (!OVERLAYS.includes(name)) { console.warn('[planet] unknown overlay', name); return; }
    const auto = name === 'channel' || name === 'numbers' || name === 'seasons';
    if (data === undefined) data = null;
    if (data === 'auto' && !auto) data = null;
    if (name === 'liquidity') data = normLiq(data);
    this.ov[name] = data;
    if ((name === 'channel' || name === 'numbers') && this._fc) this._fc.reaim(); // §26 amendment 5: the 3D rest pose
    if (name === 'estimates') {
      const ids = (Array.isArray(data) ? data : []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter(Boolean);
      const key = ids.slice().sort().join('|');
      if (key !== this._estKey) { this._estKey = key; this._estSet = new Set(ids); this._ovVer++; }
    } else if (name === 'scenario') this._ovVer++; // only these two change the cached surface
    if (name === 'scenario' && this.cur) {
      this._applyDate(this.cur, this.dateIndex, true);
      if (data && !this.cur.scenT0) this.cur.scenT0 = performance.now();
      if (!data) this.cur.scenT0 = 0;
    }
  }

  getOverlay(name) { return this.ov[name]; }

  setTheme(name) {
    const t = THEMES[name];
    if (!t || t === this.theme) return;
    this.theme = t;
    this._ovVer++;
    this._veilT = 0;
    this._buildBg();
    if (this.cur && !this.running) this._render(performance.now(), 0);
  }

  getTheme() { return this.theme.name; }

  setInsets(ins = {}) {
    this._insetsSet = true;
    Object.assign(this.insets, ins);
    this._computeView(false);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || window.innerWidth));
    const H = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || window.innerHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!this._insetsSet) {
      // overlays may still be animating (e.g. the side panel sliding): look again a little later
      clearTimeout(this._insetTimer);
      this._insetTimer = setTimeout(() => this._computeView(false), 450);
    }
    if (W === this.W && H === this.H && dpr === this.dpr && this.canvas.width === Math.round(W * dpr)) {
      this._computeView(false);
      return;
    }
    this.W = W; this.H = H; this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this._buildBg();
    this._computeView(true);
    if (this.cur && !this.running) this._render(performance.now(), 0);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frameBound);
  }

  getChildScreenRect(id) {
    const st = this.cur;
    if (!st) return null;
    // §26 free camera: while the globe turns, the resting rect is carried to where its place is now (planet/freecam2d
    // liveXY) — the shell's 主航道 pin rides along (as 3D) instead of vanishing mid-drag; never a stale rect
    if (this._fc && this._fc.moving()) {
      if (this.transition || !this._fc.liveXY) return null;
      const r0 = this._restRect(st, id);
      if (!r0) return null;
      const rect = this.canvas.getBoundingClientRect();
      const m = this._fc.liveXY(r0.cx - rect.left, r0.cy - rect.top, HUB_CUT);
      if (!m || !this._visXY(st, m[0], m[1], 0)) return null;
      const f = this._fc.liveScale(), w = r0.width * f, h = r0.height * f, x = rect.left + m[0] - w / 2, y = rect.top + m[1] - h / 2;
      return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, cx: rect.left + m[0], cy: rect.top + m[1], r: r0.r * f };
    }
    return this._restRect(st, id);
  }

  /** getChildScreenRect at the resting picture (client px). */
  _restRect(st, id) {
    const k = st.idxOf.get(id);
    if (k == null) return null;
    const { cx, cy, R } = this.view;
    const rect = this.canvas.getBoundingClientRect();
    const pp = st.ptOf && st.ptOf.get(k);
    if (pp) {
      // (§26 amendment 5: a company right on the limb keeps the shell's pin until 3D's horizon — planet3d.js: dot < 0.05)
      const T0 = st.S && st.S.terr[k], a0 = T0 && T0.anchor, v0 = st.frame && st.frame.v;
      if (!pp.vis && !(a0 && v0 && a0[0] * v0[0] + a0[1] * v0[1] + a0[2] * v0[2] >= HUB_CUT && this._visXY(st, pp.tx, pp.ty, -2))) return null;
      const r0 = pp.r + 2;
      return { x: rect.left + pp.tx - r0, y: rect.top + pp.ty - r0, left: rect.left + pp.tx - r0, top: rect.top + pp.ty - r0, width: 2 * r0, height: 2 * r0, right: rect.left + pp.tx + r0, bottom: rect.top + pp.ty + r0, cx: rect.left + pp.tx, cy: rect.top + pp.ty, r: r0 };
    }
    // §26 amendment 5 (as 3D getChildScreenRect): the box of every visible piece of the territory, r = its equivalent
    // radius on the sphere at this zoom (the shell sizes its 主航道 ring from these)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of (st.L.exts && st.L.exts[k]) || [st.L.polys[k] || []]) {
      const step = Math.max(1, Math.floor(ring.length / 40));
      for (let i = 0; i < ring.length; i += step) { const [x, y] = ring[i]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
    const T = st.S && st.S.terr[k];
    const rPx = T && T.angR ? T.angR * R * (st.frame ? st.frame.Zl || 1 : 1) : st.L.rEq[k] * R;
    const [ax, ay] = st.L.anchors[k];
    if (!Number.isFinite(x0)) { const r0 = clamp(rPx, 18, 60) / R; x0 = ax - r0; x1 = ax + r0; y0 = ay - r0; y1 = ay + r0; }
    const left = rect.left + cx + x0 * R, top = rect.top + cy + y0 * R;
    const width = (x1 - x0) * R, height = (y1 - y0) * R;
    // §26 refine: on the real Earth (cx, cy) is where the territory's MONEY is (st.money: layout focus.at / hub — the
    // ①②③ and 主航道 rule), so the shell's 主航道 pin sits on 奥斯汀, not on a leftover piece of 机器人汽车 in the Bay
    // Area; that place off the map → null. (lx, ly) = the label anchor.
    let px = cx + ax * R, py = cy + ay * R;
    const mon = st.real && st.money ? st.money.get(k) : null;
    if (mon) {
      const q = this._llScreen(st, mon.ll[0], mon.ll[1], HUB_CUT); // (§26 amendment 5: 3D's horizon for the shell's pin)
      if (!q || !this._visXY(st, q[0], q[1], 0)) return null;
      px = q[0]; py = q[1];
    } else if (st.real && !this._visXY(st, px, py, 0)) return null; // §26 its place is off the map
    // (final check: 抽象 zoomed in (×2–×4) — a place outside the porthole is off the map too: the shell's 主航道 ring
    // must not float in the paper sky above the planet; a few px of rim tolerance keeps rim anchors at ×1)
    else if (!st.real && !this._visXY(st, px, py, -8)) return null;
    return {
      x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
      cx: rect.left + px, cy: rect.top + py, lx: rect.left + cx + ax * R, ly: rect.top + cy + ay * R, r: rPx,
    };
  }

  getStats() {
    return Object.assign({}, this.stats, { particles: this.particles.n, target: this.particles.target });
  }

  destroy() {
    if (this._offProv) { this._offProv(); this._offProv = null; }
    if (this._fc) { this._fc.destroy(); this._fc = null; } // §26 free camera
    if (this._utag) { this._utag.destroy(); this._utag = null; } // §26 amendment 4
    this.pause();
    const c = this.canvas;
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerleave', this._onLeave);
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('click', this._onClick);
    c.removeEventListener('contextmenu', this._onCtx);
    c.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('keydown', this._onKey);
    if (this._ro) this._ro.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
  }

  // ============================================================================== state
  _buildState(node, map, Lpre, Lreal = false, pre = null) {
    const children = Array.isArray(node.children) ? node.children : [];
    const n = children.length;
    const raw = children.map((c) => (c.now && c.now.dv20 > 0 ? +c.now.dv20 : null));
    const known = raw.filter((v) => v != null).sort((a, b) => a - b);
    const med = known.length ? known[known.length >> 1] : 1;
    const items = children.map((c, k) => ({ id: c.id, weight: raw[k] != null ? raw[k] : med * 0.5 }));
    const L = Lpre || computeLayout(node.id, items);
    const F32 = () => new Float32Array(n);
    const st = {
      node, map: map || null, children, n, L,
      idxOf: new Map(children.map((c, k) => [c.id, k])),
      cur: { wind: F32(), temp: F32(), pres: F32(), storm: F32() },
      from: { wind: F32(), temp: F32(), pres: F32(), storm: F32() },
      to: { wind: F32(), temp: F32(), pres: F32(), storm: F32() },
      front: new Int8Array(n),
      season: new Int8Array(n).fill(-1),
      est: new Uint8Array(n),
      scen: new Array(n).fill(null),
      self: { cur: 0, from: 0, to: 0 },
      lerp: null,
      T: new Float32Array(N2), P: new Float32Array(N2), pot: new Float32Array(N2),
      vx: new Float32Array(N2), vy: new Float32Array(N2), spd: new Float32Array(N2), div: new Float32Array(N2), maxSpd: 0,
      band: new Uint8Array(N2),
      bands: null, iso: null, fieldVer: 0,
      cache: null, cacheKey: '', cacheR: 0, cachePad: 3,
      frontGeo: new Array(n),
      dim: F32(), dimTarget: F32(),
      revealT0: 0, scenT0: 0, fxT0: 0,
      polyPaths: [], borderPath: new Path2D(),
      ext: 1, Zl: 1, win: 1,
      aux: { sinkOf: new Int16Array(N2).fill(-1), sinkCap: null, nSink: 0, real: !!Lreal }, // fields.js: sinks / swirls (particles.js caps them)
    };
    st.sinkOf = st.aux.sinkOf;
    // §26 refine (set before the first wind field): the full-bleed size (the swirls' px cap) and how much of each
    // territory's money its own land holds (a leftover county pulls the wind gently and gets a small swirl)
    if (pre) { st.ext = pre.ext || 1; st.kMoney = pre.kMoney || null; }
    // Path2D in local coords (radius 1); §25 layouts: every ring of a landmass, the land and the neutral land
    st.landPath = L.sea ? new Path2D() : null;
    st.neutralPath = L.sea ? new Path2D() : null;
    // §26: sea areas tint the water (no coast, no foam), companies are markers (not land)
    st.kind = L.kind || null;
    st.seaPath = st.kind && st.kind.includes('sea') ? new Path2D() : null;
    st.points = st.kind ? st.kind.map((kd, k) => (kd === 'point' ? k : -1)).filter((k) => k >= 0) : [];
    const ringPath = (p, ring) => { ring.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); };
    for (const r of L.neutralRings || []) ringPath(st.neutralPath, r);
    for (let k = 0; k < n; k++) {
      const p = new Path2D();
      if (L.sea) {
        const kd = st.kind ? st.kind[k] : 'land';
        if (kd === 'point') {
          const [ax, ay] = L.anchors[k];
          p.arc(ax, ay, 9 / Math.max(60, this.view.R), 0, Math.PI * 2);
        } else for (const r of L.rings[k] || []) { ringPath(p, r); ringPath(kd === 'sea' ? st.seaPath : st.landPath, r); }
        st.polyPaths.push(p);
        continue;
      }
      L.polys[k].forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      p.closePath();
      st.polyPaths.push(p);
      // border: internal edges only (skip rim)
      const poly = L.polys[k];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (Math.hypot(a[0], a[1]) > 0.985 && Math.hypot(b[0], b[1]) > 0.985) continue;
        st.borderPath.moveTo(a[0], a[1]);
        st.borderPath.lineTo(b[0], b[1]);
      }
    }
    this._applyDate(st, this.dateIndex, false);
    this._applyLens(st, true);
    this._recomputeFields(st, true);
    return st;
  }

  _applyDate(st, i, animate) {
    const map = st.map;
    const useNow = !map; // no map file: fall back to tree "now" values
    const sc = this.ov.scenario && this.ov.scenario.nodes ? this.ov.scenario : null;
    const stageIdx = sc ? (LAGS.indexOf(sc.stage) >= 0 ? LAGS.indexOf(sc.stage) : LAGS.length - 1) : 0;
    const selfS = map ? map.self : null;
    for (let k = 0; k < st.n; k++) {
      const ch = st.children[k];
      const s = map && map.children ? map.children[ch.id] : null;
      let missing = false;
      for (const key of KEYS) {
        const v = useNow ? (ch.now && ch.now[key] != null ? +ch.now[key] : NaN) : valAt(s, key, i);
        st.to[key][k] = v;
      }
      // §14: no data → inherit the parent's weather, dimmed, and mark as an estimate
      if (!Number.isFinite(st.to.wind[k]) && !Number.isFinite(st.to.temp[k])) {
        missing = true;
        const pw = useNow ? (st.node.now ? +st.node.now.wind : NaN) : valAt(selfS, 'wind', i);
        const pt = useNow ? (st.node.now ? +st.node.now.temp : NaN) : valAt(selfS, 'temp', i);
        const pp = useNow ? (st.node.now ? +st.node.now.pres : NaN) : valAt(selfS, 'pres', i);
        st.to.wind[k] = Number.isFinite(pw) ? pw * 0.6 : 0;
        st.to.temp[k] = Number.isFinite(pt) ? pt * 0.6 : 0;
        st.to.pres[k] = Number.isFinite(pp) ? pp : 50;
        st.to.storm[k] = 0;
      }
      st.est[k] = missing ? 1 : 0;
      const f = useNow ? (ch.now && ch.now.front) || 0 : valAt(s, 'front', i);
      st.front[k] = !missing && Number.isFinite(f) ? Math.sign(f) : 0;
      // season (auto rule, §8.2)
      const w = st.to.wind[k];
      const w5 = useNow ? NaN : valAt(s, 'wind', i - 5);
      st.season[k] = missing ? -1 : seasonRule(w, Number.isFinite(w5) ? w - w5 : 0, st.to.pres[k]);
      // scenario: future weather replaces the measured fields
      if (sc) {
        const info = sc.nodes[ch.id] || null;
        let on = false, imp = 0;
        if (info) {
          const li = LAGS.indexOf(info.lag);
          on = (li < 0 ? 0 : li) <= stageIdx;
          const raw = Number.isFinite(+info.impact) ? +info.impact : (info.dir || 0) * (+info.strength || 1);
          imp = on ? clamp(raw, -3, 3) : 0;
        }
        st.scen[k] = info ? Object.assign({}, info, { on, value: imp }) : null;
        st.to.temp[k] = imp;
        st.to.wind[k] = imp;
        st.to.pres[k] = 50;
        st.to.storm[k] = 0;
        st.front[k] = 0;
      } else st.scen[k] = null;
    }
    if (sc) {
      const si = sc.nodes[st.node.id];
      st.self.to = si && Number.isFinite(+si.impact) ? clamp(+si.impact, -3, 3) : 0;
    } else {
      st.self.to = map ? valAt(map.self, 'temp', i) : st.node.now ? +st.node.now.temp : NaN;
      if (!Number.isFinite(st.self.to)) st.self.to = 0;
    }
    st.scenOn = !!sc;
    if (animate) {
      for (const key of KEYS) {
        const c = st.cur[key], f = st.from[key], t = st.to[key];
        for (let k = 0; k < st.n; k++) f[k] = Number.isFinite(c[k]) && Number.isFinite(t[k]) ? c[k] : t[k];
      }
      st.self.from = st.self.cur;
      st.lerp = { t0: performance.now(), dur: sc ? 650 : LERP_MS };
    } else {
      for (const key of KEYS) st.cur[key].set(st.to[key]);
      st.self.cur = st.self.to;
      st.lerp = null;
    }
  }

  /** Advance the value lerp. Returns 0 idle, 1 still lerping, 2 just finished. */
  _stepLerp(st, now) {
    if (!st.lerp) return 0;
    const u = clamp((now - st.lerp.t0) / st.lerp.dur, 0, 1);
    const e = st.scenOn ? easeInOutCubic(u) : easeOutCubic(u);
    for (const key of KEYS) {
      const c = st.cur[key], f = st.from[key], t = st.to[key];
      for (let k = 0; k < st.n; k++) c[k] = Number.isFinite(f[k]) && Number.isFinite(t[k]) ? lerp(f[k], t[k], e) : t[k];
    }
    st.self.cur = lerp(st.self.from, st.self.to, e);
    if (u >= 1) { st.lerp = null; return 2; }
    return 1;
  }

  _recomputeFields(st, full) {
    const t0 = performance.now();
    const L = st.L;
    if (st.n === 0) {
      st.T.fill(st.self.cur || 0);
      st.P.fill(50);
    } else {
      blendScalar(L.coefT, st.cur.temp, 0, st.T);
      blendScalar(L.coefP, st.cur.pres, 50, st.P, 50);
    }
    st.bands = tempBandPaths(st.T);
    bandGrid(st.T, st.band);
    if (L.sea) for (let c = 0; c < N2; c++) if (L.owner[c] < 0) st.band[c] = 4; // the sea is never "dark ground"
    if (st.scenOn) st.iso = null;
    else if (full || !st.iso) st.iso = isobarPaths(st.P);
    // §26 refine: on the real Earth the wind's pull follows the money on the ground — a territory whose own land holds
    // little of its money (网络安全's Waterloo, 1.4 %) pulls gently and its swirl stays small (≤ ~70 px, fields.js)
    let wind = st.cur.wind;
    if (st.kMoney) {
      const w2 = st.windEff || (st.windEff = new Float32Array(st.n));
      for (let k = 0; k < st.n; k++) w2[k] = wind[k] * (0.3 + 0.7 * st.kMoney[k]);
      wind = w2;
    }
    st.aux.kMoney = st.kMoney || null;
    st.aux.cellPx = (2 * (this.view.R0 || this.view.R) * (st.ext || 1)) / G;
    // §26 amendment 5: a §25 sphere layout takes the 3D planet's own wind field (one wind in both renderers)
    // (the signed wind as measured, as 3D: a leftover county stays a small cyclone by its own small reach — σ ∝ its size)
    // (built once the sphere's sizes are known — the first frame after the free camera's adopt, _drawScene)
    if (L.sea) st.maxSpd = st.windS !== undefined || !this._fc ? coastWind(L, st.cur.wind, st.vx, st.vy, st.spd, this._windOpts(st)) : 0;
    else st.maxSpd = computeWind(L, wind, st.pot, st.vx, st.vy, st.spd, st.div, st.aux);
    st.fieldVer++;
    this.stats.fieldMs = performance.now() - t0;
  }

  _applyLens(st, immediate = false) {
    const tag = this.lens;
    for (let k = 0; k < st.n; k++) {
      st.dimTarget[k] = tag && !hasTag(st.children[k], tag) ? 1 : 0;
      if (immediate) st.dim[k] = st.dimTarget[k];
    }
  }

  // ============================================================================== view / sizing
  /** Until the shell calls setInsets, keep clear of the usual overlays (#topbar, #timebar, #panel). */
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

  /** Floating overlays (gauges, pins strip, "since last visit") that captions must not cover. */
  _obstacles(now, skip = null) {
    if (skip) return (this._obstacles(now) || []).filter((o) => !skip.includes(o.id));
    if (this._obsT && now - this._obsT < 800) return this._obs;
    this._obsT = now;
    const out = [];
    if (typeof document !== 'undefined') {
      const rect = this.canvas.getBoundingClientRect();
      for (const id of this.avoidIds) {
        const el = document.getElementById(id);
        if (!el || el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        out.push({ id, x: r.left - rect.left - 6, y: r.top - rect.top - 6, w: r.width + 12, h: r.height + 12 });
      }
    }
    return (this._obs = out);
  }

  /** Wind lines for the visible window: the porthole's area at ~400 px² a line; a zoomed real map (full-bleed, finer
   *  detail, names everywhere) calmer at ~1300 px² a line, so the sea of lines never buries the places. */
  _idealParticles() {
    const st = this.cur, v = this.viewTarget || this.view;
    const z = st && st.real ? st.real.zoom : 1;
    const R0 = v.R0 || v.R;
    if (!st || !st.real || z <= 1.02) return clamp((Math.PI * R0 * R0) / 400, 380, 1300);
    const per = lerp(400, 1500, smoothstep(1.02, 1.6, z));
    return clamp(this._visArea() / per, 300, 900);
  }

  /** The visible map's area (px²): the porthole, or the real globe's disc ∩ the free screen area (sampled). */
  _visArea() {
    const st = this.cur, v = this.viewTarget || this.view;
    const R0 = v.R0 || v.R;
    const Rg = R0 * this._camZoom(st);
    const fa = this._freeArea();
    const x0 = Math.max(fa.x0, v.cx - Rg), x1 = Math.min(fa.x1, v.cx + Rg), y0 = Math.max(fa.y0, v.cy - Rg), y1 = Math.min(fa.y1, v.cy + Rg);
    if (x1 <= x0 || y1 <= y0) return 0;
    let n = 0;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
      const x = x0 + ((i + 0.5) / 16) * (x1 - x0), y = y0 + ((j + 0.5) / 16) * (y1 - y0);
      if ((x - v.cx) * (x - v.cx) + (y - v.cy) * (y - v.cy) <= Rg * Rg) n++;
    }
    return (x1 - x0) * (y1 - y0) * (n / 256);
  }

  /** The screen area free of the shell's chrome (top bar, panel, time machine), canvas px. */
  _freeArea() {
    const ins = this.insets;
    return { x0: ins.left || 0, y0: ins.top || 0, x1: this.W - (ins.right || 0), y1: this.H - (ins.bottom || 0) };
  }

  /**
   * §26 full-bleed fit of a real view at camera zoom z (px/rad = R0·z): ext = the layout grid's half-size in porthole
   * radii (the square [-1, 1]² covers the visible screen once z reaches it), Zl = the layout's own zoom, kv = the
   * visible screen's half-diagonal in porthole radii (the land window must hold it).
   */
  _realFit(z, t = this.viewTarget || this.view) {
    const R0 = Math.max(40, t.R0 || t.R), ins = this.insets;
    const Wv = this.W - Math.max(0, (ins.right || 0) - 6); // the panel's left edge (it is opaque)
    const cover = Math.max(t.cx, Wv - t.cx, t.cy, this.H - t.cy) / R0 + 0.02;
    const ext = Math.max(1, Math.min(z, cover));
    const kv = Math.max(1, Math.hypot(Math.max(t.cx, Wv + 24 - t.cx), Math.max(t.cy, this.H - t.cy)) / R0);
    return { ext, Zl: z / ext, kv, cover };
  }

  /**
   * §26 the lon/lat window a real view rasterizes and clips 1:10m land to: everything the screen can show at zoom z
   * (planet/freecam2d.js asks the same question). ten = 1:10m coasts (only when the screen holds a small region, or
   * real.js clipped its regions at 1:10m); null box = the whole globe at 1:50m.
   */
  _realWin(v, z, list = null, margin = 1.35) {
    const { kv } = this._realFit(z);
    const ze = z / kv; // the zoom whose porthole holds the whole visible screen
    // (built with a roomy margin, so a camera that pans a little keeps the same raster and coasts: freecam2d asks
    // with margin ≈ 1 whether the screen is still inside)
    // (refine-names: from ×1.6 on, 3D's own window — Planet3D._viewBox: the screen's aspect, 1.6 margin — and, at the
    // prepareSphere call, its 1536-px raster: the same cells give the same owners, anchors, parts and money units, so every
    // name and card stands where 3D has it (美股 ×2.38: 卢卡斯县 / 科布县 stay 房地产's; 日本: 野田市 stays 必需消费's))
    const box = z >= 1.6 ? viewWindow({ lon: v.lon, lat: v.lat, scale: z }, this.W / Math.max(1, this.H), (1.6 * margin) / 1.35) : null;
    return { box, ze, ten: !!box && ze >= 1.15 && (ze >= 2.4 || !!(list && list.detail === '10m')) };
  }

  /** R (the layout's drawing radius) follows R0 and the state's ext. */
  _syncR() {
    const v = this.view;
    v.R = (v.R0 || v.R) * (this.cur && this.cur.ext ? this.cur.ext : 1);
  }

  _computeView(immediate) {
    this._obsT = 0;
    this._veilT = 0;
    this._autoInsets();
    const { top, right, bottom, left } = this.insets;
    const aw = Math.max(50, this.W - left - right), ah = Math.max(50, this.H - top - bottom);
    const R0 = Math.max(40, (Math.min(aw, ah) / 2) * this.opts.radiusScale);
    const ext = this.cur && this.cur.ext ? this.cur.ext : 1;
    // (§26 amendment 5: the look point where 3D puts it — planet3d.js _computeView: cy + 2 % of R; D its lens)
    const v = { cx: left + aw / 2, cy: top + ah / 2 + R0 * 0.02, R0, R: R0 * ext, D: lensD(R0, this.H) };
    if (immediate || !this.cur) {
      this.view = v;
      this.viewTarget = null;
    } else this.viewTarget = v;
    this.particles.setTarget(this._idealParticles());
    // §26 full-bleed: a real view whose grid no longer covers the screen (panel opened / closed, a resize) is rebuilt
    // at the same camera (swapped in place)
    const st = this.cur;
    if (st && (st.real || st.ext > 1) && this._fc && !this.transition) {
      const fit = this._realFit(this._camZoom(st), v);
      if (Math.abs(fit.ext - st.ext) > 0.02 * st.ext) this._fc.refit();
    }
    if (st && this._fc && !this.transition && st.frame && st.frame.D && Math.abs(v.D / st.frame.D - 1) > 0.02) this._fc.refit(); // (a new lens)
  }

  /** §26 amendment 5: the 3D camera's distance for the current window (planet/persp.js). */
  _lensD() {
    const v = this.viewTarget || this.view;
    return v.D || lensD(v.R0 || v.R, this.H);
  }

  _buildBg() {
    const { W, H, dpr } = this;
    const th = this.theme;
    const c = this.bg;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // (§26 amendment 5: 3D's sky — SKY_FS: sky0 → sky1 by smoothstep(0, 0.85) of the distance from the planet over the
    // screen's long side; the planet sits in the middle of the free area)
    const ins = this.insets || {}, px = (ins.left || 0) + (W - (ins.left || 0) - (ins.right || 0)) / 2, py = (ins.top || 0) + (H - (ins.top || 0) - (ins.bottom || 0)) / 2;
    const base = g.createRadialGradient(px, py, 0, px, py, Math.max(W, H) * 0.85);
    const s0 = hexRGB(th.sky0), s1 = hexRGB(th.sky1);
    for (let i = 0; i <= 8; i++) { const t = i / 8, k = t * t * (3 - 2 * t); base.addColorStop(t, `rgb(${s0.map((v, j) => Math.round(v + (s1[j] - v) * k)).join(',')})`); }
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    // washi grain: a small noise tile, multiplied (day) or screened (night) in
    const tile = document.createElement('canvas');
    const TS = 128;
    tile.width = TS; tile.height = TS;
    const tg = tile.getContext('2d');
    const img = tg.createImageData(TS, TS);
    const rnd = mulberry32(th.name === 'day' ? 20261027 : 7741);
    const day = th.name === 'day';
    for (let i = 0; i < TS * TS; i++) {
      const r = rnd();
      // a few longer "fibres" (runs of darker pixels) for a paper feel
      const v = day ? 255 - Math.round(Math.pow(r, 6) * 34 + r * 6) : Math.round(Math.pow(r, 5) * 26 + r * 4);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = day ? v - 2 : v + 2; img.data[i * 4 + 3] = 255;
    }
    tg.putImageData(img, 0, 0);
    g.save();
    g.globalCompositeOperation = day ? 'multiply' : 'screen';
    g.globalAlpha = day ? 0.55 : 0.6;
    g.fillStyle = g.createPattern(tile, 'repeat');
    g.fillRect(0, 0, W, H);
    g.restore();
    if (!day) {
      // a calm, flat star field (§26 amendment 5: 3D's — tiny sparse dots, one in ~4 cells of 38 px, none around the
      // planet; no sparkles, no glow, no twinkle)
      const srnd = mulberry32(99173);
      const R0 = (Math.min(W - (ins.left || 0) - (ins.right || 0), H - (ins.top || 0) - (ins.bottom || 0)) / 2) * this.opts.radiusScale;
      for (let cy = 0; cy * 38 < H; cy++) for (let cx = 0; cx * 38 < W; cx++) {
        const h = srnd(), hx = srnd(), hy = srnd(), m = Math.pow(srnd(), 2.5);
        if (h <= 0.62) continue;
        const x = (cx + hx) * 38, y = (cy + hy) * 38, d = Math.hypot(x - px, y - py);
        const keep = Math.min(1, Math.max(0, (d - R0 * 1.3) / (R0 * 0.15)));
        if (keep <= 0) continue;
        g.fillStyle = `rgba(240,232,214,${((0.25 + m * 0.45) * keep).toFixed(2)})`;
        g.beginPath();
        g.arc(x, y, 0.75, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // ============================================================================== frame loop
  _frame(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frameBound);
    const dtMs = now - this._last;
    this._last = now;
    const dt = clamp(dtMs / 1000, 0.001, 0.05);
    const s = this.stats;
    s.frames++;
    if (dtMs > 0 && dtMs < 500) s.frameMs = s.frameMs * 0.94 + dtMs * 0.06;
    s.fps = 1000 / s.frameMs;
    const t0 = performance.now();
    const steady = !this.transition && now - this._steadySince > 1500;
    if (this.transition) this._steadySince = now;
    this._render(now, dt);
    const work = performance.now() - t0;
    s.workMs = s.workMs * 0.94 + work * 0.06;
    if (steady && dtMs > 0 && dtMs < 500) s.steadyMs = (s.steadyMs || dtMs) * 0.9 + dtMs * 0.1;
    if (steady) this._adapt(now);
  }

  _adapt(now) {
    // adaptive particle count: frame time > 20ms → fewer particles; plenty of headroom → more
    if (now - this._adaptT < 700) return;
    this._adaptT = now;
    const p = this.particles, s = this.stats;
    const ideal = this._idealParticles();
    if (p.target > ideal * 1.05) p.setTarget(ideal);
    if (s.steadyMs > 21) p.setTarget(Math.max(Math.min(300, ideal), p.target * 0.85));
    else if (s.steadyMs < 17.8 && p.target < ideal) p.setTarget(Math.min(ideal, p.target * 1.1 + 40));
  }

  _render(now, dt) {
    const ctx = this.ctx, dpr = this.dpr;
    if (this.viewTarget) {
      const v = this.view, t = this.viewTarget, k = 1 - Math.exp(-dt * 9);
      v.cx = lerp(v.cx, t.cx, k); v.cy = lerp(v.cy, t.cy, k); v.R0 = lerp(v.R0, t.R0, k);
      v.D = t.D;
      if (Math.abs(v.cx - t.cx) + Math.abs(v.cy - t.cy) + Math.abs(v.R0 - t.R0) < 0.3) { this.view = t; this.viewTarget = null; }
    }
    this._syncR();
    const st = this.cur;
    if (st) {
      const l = this._stepLerp(st, now);
      if (l) this._recomputeFields(st, l === 2);
      const kd = 1 - Math.exp(-dt * 10);
      for (let k = 0; k < st.n; k++) st.dim[k] = lerp(st.dim[k], st.dimTarget[k], dt ? kd : 1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawScene(ctx, now, dt, true);
  }

  _drawScene(ctx, now, dt, withBg) {
    const tr = this.transition;
    if (withBg) { this._drawBg(ctx); this._drawLiquidity(ctx, now); }
    const st = this.cur;
    if (!st) return;
    if (tr && tr.fly && this._fc) {
      // §26 amendment 5: a level flight on the real Earth — the moving picture at 3D's flight camera (planet/freecam2d.js)
      this._fc.flyFrame(ctx, now, tr);
      if (withBg && now - tr.t0 >= tr.dur) this._endTransition(now);
      return;
    }
    if (tr) {
      this._drawTransition(ctx, now, tr);
      if (withBg) this._drawVeil(ctx);
      if (withBg && now - tr.t0 >= tr.dur) this._endTransition(now);
      return;
    }
    if (this._fc && this._fc.preview(ctx)) return; // §26 free camera: the light moving globe until the camera rests
    const { cx, cy, R } = this.view;
    const th = this.theme;
    const reveal = smoothstep(0, 650, now - st.revealT0);
    // wind, clouds and weather marks have their own fade (a camera rebuild keeps names / cards but re-seeds the wind)
    const fx = Math.min(reveal, smoothstep(0, 520, now - (st.fxT0 || st.revealT0)));
    const blink = (this._blink = this._blinkSet(st));
    const chan = this._channel(st);
    const placed = this._layoutLabels(ctx, st, chan);

    // ---- surface
    this._drawBody(ctx, cx, cy, R, st, 1, false);
    this._drawLensDim(ctx, st, cx, cy, R);
    ctx.save();
    this._clipWin(ctx, st, 0.5);
    if (dt > 0) {
      const L = st.L, dim = st.dim, anyDim = !!this.lens;
      const band = st.band, dark = th.bandDark;
      this.particles.alpha = st.scenOn ? 0.55 : 1;
      // (the sphere's own territory sizes arrive with the free camera's adopt: the field is rebuilt once with them)
      if (L.sea && st.windS === undefined && this._fc && this._fc.st === st) { st.windS = this._fc.S || null; this._recomputeFields(st, false); }
      this.particles.step(dt, st, anyDim ? (c) => { const o = L.owner[c]; return o >= 0 ? dim[o] : 0; } : null, (c) => dark[band[c]],
        Object.assign({ mask: this._partMask(st, placed), spotKs: this._spotKs(st) }, this._windOpts(st)));
    }
    ctx.globalAlpha = fx;
    this.particles.draw(ctx, cx, cy, R, th);
    ctx.globalAlpha = 1;
    ctx.restore();
    this._drawFronts(ctx, now, st, blink, fx);
    this._shadeOf(ctx, st, cx, cy, R);
    this._drawHover(ctx, st);
    this._drawSpotOutlines(ctx, now, st, blink, reveal);
    if (st.points && st.points.length) this._drawPoints(ctx, st, reveal);
    this._drawTicks(ctx, st, reveal);
    if (withBg) this._drawVeil(ctx);

    // ---- air
    this._drawStorms(ctx, now, st, blink, fx);
    this._drawClouds(ctx, now, st, placed, fx);
    this._drawIntel(ctx, now, st, blink, placed, fx);
    this._drawScenarioFx(ctx, now, st, fx);
    if (this._camFade && withBg) this._drawCamFade(ctx, now); // §26 amendment 5: the old view fades out (words above it)
    if (this._bare) return; // (§26 amendment 5: a crossfade's / flight's old picture carries no words — they go at once, as 3D)
    this._drawChannel(ctx, now, st, chan, placed, reveal);
    this._drawMarkers(ctx, st, placed, reveal);
    this._drawLabels(ctx, st, placed, reveal);
    this._drawCaptions(ctx, now, st, placed, reveal);
    this._drawExtLeader(ctx, now, reveal);
    if (withBg) this._drawLiqCaption(ctx, now, st, placed, reveal);
    // what the moving picture keeps while the camera turns (planet/freecam2d.js re-projects it)
    if (withBg) this._rest = { st, placed, caps: this._caps || [], chan: chan && (chan.curve || chan.single) ? chan : null, R, cx, cy };
  }

  /** §26 amendment 5: the old picture of a camera rebuild, fading out over the new map (planet3d.js _snapFade). */
  _drawCamFade(ctx, now) {
    const f = this._camFade;
    const u = (now - f.t0) / f.dur;
    if (u >= 1 || (this._fc && this._fc.moving())) { this._camFade = null; return; }
    const a = 1 - easeInOutCubic(clamp(u, 0, 1));
    if (a <= 0.003) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.drawImage(f.snap, 0, 0, this.W, this.H);
    ctx.restore();
  }

  // ============================================================================== §26 the window
  /** Clip to the visible window: the porthole (抽象), or the real globe's own disc (full-bleed: the canvas). */
  _clipWin(ctx, st = this.cur, inset = 0) {
    const { cx, cy, R } = this.view;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R * (st && st.win ? st.win : 1) - inset), 0, Math.PI * 2);
    ctx.clip();
  }

  /** Is screen point (x, y) on the visible map: inside the window and the free screen area (pad px inside both)? */
  _visXY(st, x, y, pad = 0) {
    const { cx, cy, R } = this.view, fa = this._freeArea();
    const Rw = R * (st && st.win ? st.win : 1) - pad;
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= Rw * Rw && x >= fa.x0 + pad && x <= fa.x1 - pad && y >= fa.y0 + pad && y <= fa.y1 - pad;
  }

  /** Does box b lie on the visible map (all four corners)? */
  _visBox(st, b, pad = 0) {
    return this._visXY(st, b.x, b.y, pad) && this._visXY(st, b.x + b.w, b.y, pad) && this._visXY(st, b.x, b.y + b.h, pad) && this._visXY(st, b.x + b.w, b.y + b.h, pad);
  }

  /**
   * Wind lines step back near names, company markers, the 主航道 caption, clouds and cards: a G² mask (1 = faint,
   * 2 = not drawn) rebuilt from this frame's boxes (particles.js).
   */
  _partMask(st, placed) {
    const m = st.pmask || (st.pmask = new Uint8Array(N2));
    // (§26 amendment 5: no quiet mask for empty land any more — the 3D field itself leaves it calm, as in 3D)
    m.fill(0);
    const { cx, cy, R } = this.view;
    const toG = (v, c0) => Math.floor((((v - c0) / R) + 1) / 2 * G);
    const box = (x0, y0, x1, y1, val) => {
      const gx0 = Math.max(0, toG(x0, cx)), gx1 = Math.min(G - 1, toG(x1, cx));
      const gy0 = Math.max(0, toG(y0, cy)), gy1 = Math.min(G - 1, toG(y1, cy));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0, c = gy * G + gx0; gx <= gx1; gx++, c++) if (m[c] < val) m[c] = val;
    };
    for (const b of placed) {
      if (!b.it && !b.chan && !b.cloud && !b.intel) continue;
      box(b.x - 12, b.y - 9, b.x + b.w + 12, b.y + b.h + 9, 1);
      box(b.x - 2, b.y - 1, b.x + b.w + 2, b.y + b.h + 1, 2);
    }
    for (const b of this._capBoxes || []) box(b.x, b.y, b.x + b.w, b.y + b.h, 2);
    if (st.pt) for (const p of st.pt) {
      if (!p.vis) continue;
      box(p.tx - p.r - 12, p.ty - p.r - 12, p.tx + p.r + 12, p.ty + p.r + 12, 1);
      box(p.tx - p.r - 2, p.ty - p.r - 2, p.tx + p.r + 2, p.ty + p.r + 2, 2);
    }
    return m;
  }

  /**
   * §26 refine: no wind dust over empty land (as 3D) — on the real Earth, unclaimed land farther than ~26 px from any
   * territory hides the lines (2), the 10–26 px fringe draws them faint (1); the sea keeps its lines (money crossing
   * water, §25). Once per state (null when there is no unclaimed land).
   */
  _quietMask(st) {
    const L = st.L;
    if (!L || !L.neutral || !L.owner) return null;
    const cellPx = (2 * this.view.R) / G;
    const INF = 1e9, d = new Float32Array(N2);
    let anyN = false;
    for (let c = 0; c < N2; c++) { d[c] = L.owner[c] >= 0 && (!st.kind || st.kind[L.owner[c]] !== 'sea') ? 0 : INF; if (L.neutral[c]) anyN = true; }
    if (!anyN) return null;
    const D2 = Math.SQRT2;
    for (let gy = 1; gy < G - 1; gy++) for (let gx = 1; gx < G - 1; gx++) { const c = gy * G + gx; d[c] = Math.min(d[c], d[c - 1] + 1, d[c - G] + 1, d[c - G - 1] + D2, d[c - G + 1] + D2); }
    for (let gy = G - 2; gy > 0; gy--) for (let gx = G - 2; gx > 0; gx--) { const c = gy * G + gx; d[c] = Math.min(d[c], d[c + 1] + 1, d[c + G] + 1, d[c + G + 1] + D2, d[c + G - 1] + D2); }
    const q = new Uint8Array(N2);
    for (let c = 0; c < N2; c++) {
      if (!L.neutral[c]) continue;
      const px = d[c] * cellPx;
      q[c] = px > 26 ? 2 : px > 10 ? 1 : 0;
    }
    return q;
  }

  // ============================================================================== liquidity (§23/§24)
  /** The atmosphere band between the planet and the bezel: 若竹 放水 / 臙脂 收水 / 浅葱 平稳, thickness = |pressure|,
   *  two hairline rings drifting inward (放水: money pouring in) or outward (收水). Calm thin halo without data. */
  _drawLiquidity(ctx, now) {
    // §26 amendment 5: the 3D atmosphere (planet3d.js _atmo, core.js sky shader) — a flat 2-tone band hugging the
    // planet's ink line (lit toward the light, thinner on the shade side): calm 浅葱 hairline band (α .55), or the §24
    // 水位 band (α .8, thicker with |pressure|, 若竹 放水 / 臙脂 收水, isobar ticks, two pressure rings drifting in / out)
    // (3D keeps the band at every zoom — a full-bleed map just has its limb off the screen)
    const gl = this._globe();
    const { cx, cy } = gl, R = gl.Rg;
    if (R > 4 * Math.hypot(this.W, this.H)) return;
    const day = this.theme.name !== 'night', lq = this.ov.liquidity;
    const C = day
      ? { atmo: '#b9d3d0', atmoSh: '#a5bfc0', in: '#8fb795', inSh: '#77a17f', out: '#c99a95', outSh: '#b5827e' }
      : { atmo: '#5f7f8f', atmoSh: '#3f5a6c', in: '#5f9a6c', inSh: '#457a54', out: '#9a5c62', outSh: '#7a4248' };
    const p = lq ? clamp(Math.abs(lq.pressure), 0, 3) : 0;
    const flow = lq ? (lq.state === '放水' ? 1 : lq.state === '收水' ? -1 : 0) : 0;
    const lit = flow > 0 ? C.in : flow < 0 ? C.out : C.atmo, sh = flow > 0 ? C.inSh : flow < 0 ? C.outSh : C.atmoSh;
    const r0 = R + (day ? 1.7 : 1.5) + 0.6; // (3D _atmoR0: no paper gap under the ink line)
    const W = R * (lq ? 0.03 + 0.03 * p : 0.022);
    const A = lq ? 0.8 : 0.55;
    // the light in screen space (y down); 3D: lit = smoothstep(−0.3, sd) of the band's outward normal · light
    const Lt = toonLight(gl.z, gl.real).L, ll = Math.hypot(Lt[0], Lt[1]) || 1, lx = Lt[0] / ll, ly = -Lt[1] / ll;
    const N = 96, out = [], inn = [], lt = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2, ux = Math.cos(t), uy = Math.sin(t);
      const l = smoothstep(-0.36, -0.24, ux * lx + uy * ly);
      lt[i] = l;
      const r1 = r0 + W * (0.62 + 0.38 * l);
      out.push([cx + ux * r1, cy + uy * r1]);
      inn.push([cx + ux * r0, cy + uy * r0]);
    }
    ctx.save();
    ctx.globalAlpha = A;
    const band = new Path2D();
    out.forEach((q, i) => (i ? band.lineTo(q[0], q[1]) : band.moveTo(q[0], q[1])));
    band.closePath();
    band.arc(cx, cy, r0, 0, Math.PI * 2, true);
    // two tones: the shade colour under a conic sweep of the lit colour
    ctx.fillStyle = sh;
    ctx.fill(band, 'evenodd');
    if (typeof ctx.createConicGradient === 'function') {
      const g = ctx.createConicGradient(0, cx, cy), cl = hexRGB(lit);
      for (let i = 0; i <= N; i++) g.addColorStop(i / N, `rgba(${cl[0]},${cl[1]},${cl[2]},${lt[i % N].toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fill(band, 'evenodd');
    }
    if (lq) {
      ctx.save();
      ctx.clip(band, 'evenodd');
      // isobar ticks across the middle of the band (3D uAtmoT: 12 + 12·p ticks, the shade tone × 0.8 at half contrast)
      const nT = Math.round(12 + 12 * p), shc = hexRGB(sh).map((v) => Math.round(v * 0.8));
      ctx.strokeStyle = `rgb(${shc[0]},${shc[1]},${shc[2]})`;
      ctx.globalAlpha = A * 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < nT; i++) {
        const t = (i / nT) * Math.PI * 2, ux = Math.cos(t), uy = Math.sin(t);
        const w = W * (0.62 + 0.38 * lt[Math.round((i / nT) * N) % N]);
        ctx.moveTo(cx + ux * (r0 + w * 0.24), cy + uy * (r0 + w * 0.24));
        ctx.lineTo(cx + ux * (r0 + w * 0.76), cy + uy * (r0 + w * 0.76));
      }
      ctx.stroke();
      // two thin pressure rings drifting inward (pressure up / 放水) or outward (down / 收水); calm at half contrast
      const drift = flow || (lq.pressure < -0.05 ? -0.5 : 0.5), k = Math.abs(drift);
      const ringC = hexRGB(lit).map((v, j) => Math.round(v + (hexRGB(this.theme.sky0 || (day ? '#f4efe4' : '#16223a'))[j] - v) * 0.6));
      ctx.strokeStyle = `rgb(${ringC[0]},${ringC[1]},${ringC[2]})`;
      ctx.lineWidth = 1.3;
      for (let i = 0; i < 2; i++) {
        const u = now / 1000 * 0.11 * k * -Math.sign(drift) + i * 0.5, ph = u - Math.floor(u);
        ctx.globalAlpha = A * 0.85 * k * Math.sin(ph * Math.PI);
        ctx.beginPath();
        ctx.arc(cx, cy, r0 + W * 0.81 * (0.15 + 0.7 * ph), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }


  /**
   * §26 amendment 5 — the liquidity caption (水位) as in 3D (Planet3D._placeLiq): a quiet line of halo text just outside
   * the band, only when it is news (a fresh change, 放水 / 收水, or |pressure| ≥ 1.5) within the secondary-caption
   * budget (_layoutClouds decides: this._liqTalk). A calm 平稳 day keeps the band and says nothing.
   */
  _drawLiqCaption(ctx, now, st, placed, reveal) {
    const lq = this.ov.liquidity;
    this._liqBox = null;
    if (!lq || this.transition || !this._liqTalk) return;
    const gl = this._globe();
    if (gl.fade < 0.5) return; // a zoomed real map: the band is gone, so is its caption
    const th = this.theme;
    const { cx, cy } = gl, R = gl.Rg;
    const news = !!lq.fresh || lq.state !== '平稳' || Math.abs(+lq.pressure || 0) >= 1.5;
    const p = +lq.pressure || 0;
    const pw = p <= -1.5 ? '气压很低' : p <= -0.5 ? '气压略低' : p < 0.5 ? '气压正常' : p < 1.5 ? '气压偏高' : '气压很高';
    let say = String(lq.say || '');
    const fK = font(10.5, 600), fB = font(10.5, 650), fP = font(10.5, 550), fS = font(10.5, 450);
    while (say && this._tw(say + '…', fS) > 220) say = say.slice(0, -1);
    if (say && say !== String(lq.say || '')) say += '…';
    const parts = [['水位', fK, th.cardMuted], [lq.state, fB, th.cardText], [pw, fP, th.cardMuted]].concat(say ? [[say, fS, th.cardMuted]] : []);
    const gap = 5, dot = 8;
    const ew = dot + gap + parts.reduce((a, [t, f]) => a + this._tw(t, f) + gap, 0) - gap, eh = 16;
    // (just outside the atmosphere band — _drawLiquidity, 3D _atmoR0 + _atmoW)
    const rr = R + (th.name === 'night' ? 2.1 : 2.3) + R * (0.03 + 0.03 * clamp(Math.abs(p), 0, 3)) + 8;
    const boxes = placed.concat(this._capBoxes || [], this._obstacles(now));
    const hit = (r) => boxes.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
    let at = null;
    for (const deg of [-40, -58, -24, -140, -122, 40, 140, -90, 90, -8, 188]) {
      const t = (deg * Math.PI) / 180, ux = Math.cos(t), uy = Math.sin(t);
      let bx = cx + ux * (rr + Math.abs(ux) * ew / 2), by = cy + uy * (rr + Math.abs(uy) * eh / 2);
      for (let it = 0; it < 5; it++) {
        const nx = clamp(cx, bx - ew / 2, bx + ew / 2), ny = clamp(cy, by - eh / 2, by + eh / 2), d = Math.hypot(nx - cx, ny - cy);
        if (d >= rr) break;
        bx += ux * (rr - d + 1); by += uy * (rr - d + 1);
      }
      const r = { x: bx - ew / 2 - 4, y: by - eh / 2 - 4, w: ew + 8, h: eh + 8 };
      if (r.x < 6 || r.y < 6 || r.x + r.w > this.W - 6 || r.y + r.h > this.H - 6 || hit(r)) continue;
      at = { x: bx - ew / 2, y: by - eh / 2, w: ew, h: eh };
      break;
    }
    if (!at) return;
    this._liqBox = at;
    const col = lq.state === '放水' ? th.in : lq.state === '收水' ? th.out : (th.name === 'night' ? '#7aa0a0' : '#5895ab');
    ctx.save();
    ctx.globalAlpha = reveal * (news ? 0.95 : 0.75) * smoothstep(0.5, 0.8, gl.fade);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    const my = at.y + eh / 2;
    ctx.beginPath();
    ctx.arc(at.x + dot / 2, my, dot / 2 - 0.75, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col;
    ctx.stroke();
    let x = at.x + dot + gap;
    for (const [t, f, c] of parts) {
      ctx.font = f;
      ctx.lineWidth = 3;
      ctx.strokeStyle = th.halo;
      ctx.strokeText(t, x, my);
      ctx.fillStyle = c;
      ctx.fillText(t, x, my);
      x += this._tw(t, f) + gap;
    }
    ctx.restore();
  }

  _endTransition(now) {
    const tr = this.transition;
    // §26 amendment 5: a flight lands on the resting map under a short crossfade of its last frame (words fade in)
    const flySnap = tr && tr.fly && this._fc && this.running ? this._snapshot(now, true) : null;
    this.transition = null;
    if (tr && tr.fly && this._fc) { this._fc.flyEnd(); if (flySnap) this._camFade = { snap: flySnap, t0: now, dur: 360 }; }
    if (this.cur) {
      this.cur.revealT0 = now;
      this.cur.fxT0 = now;
      this.particles.reset(this.cur);
    }
    if (tr && tr.resolve) tr.resolve();
    if (this._fc) this._fc.landed(); // §26 amendment 5: the 3D rest pose settles soon
    this._heroTry();
  }

  /**
   * The shell's one-ended 主航道 pin (main.js app.channel.anchor when it is not a two-ended arc): on 抽象 the globe
   * turns (once per planet, unless the owner turned it) so that place faces the viewer (§26 open item 6).
   */
  setHeroAnchor(id) {
    this.heroId = id || null;
    this._heroTry();
  }

  _heroTry() {
    const st = this.cur;
    if (!st || !this.heroId || st.real || this.transition || !this._fc || !this._fc.faceHero) return;
    const k = this._resolveK(st, this.heroId);
    if (k == null) return;
    const key = st.node.id + '|' + this.heroId;
    if (this._heroDone === key) return;
    this._heroDone = key;
    this._fc.faceHero(k);
  }

  // §26 amendment 5 (2D = the 3D planet flattened): the same camera API as Planet3D
  /** Turn territory `id` (or the child that holds it) to the viewer — the tour / search (Planet3D.faceChild). */
  faceChild(id) {
    const st = this.cur;
    if (!st || !this._fc) return false;
    const k = this._resolveK(st, id);
    return k != null ? this._fc.faceChild(k) : false;
  }

  /** The live camera {lon, lat, zoom, manual, nodeId, mode} — main.js hands it over on a 2D ↔ 3D switch. */
  getCamera() { return this._fc ? this._fc.getCamera() : null; }

  /** The next setNode on cam.nodeId (same reading) opens at this camera (a manual view). */
  seedCamera(cam) { if (this._fc) this._fc.seed(cam); }

  _snapshot(now, bare = false) {
    // two pooled canvases (ping-pong): a flight may start while another is still drawing the old one
    this._snapPool = this._snapPool || [document.createElement('canvas'), document.createElement('canvas')];
    const c = this._snapPool[(this._snapFlip = (this._snapFlip || 0) ^ 1)];
    if (c.width !== this.canvas.width || c.height !== this.canvas.height) {
      c.width = this.canvas.width; c.height = this.canvas.height;
    }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // background excluded (the bezel must not zoom); §26 amendment 5: words left out (bare) — the old level's names,
    // cards and captions go at once and the new ones fade in, as 3D (planet3d.js _snapFade)
    this._bare = !!bare;
    try { this._drawScene(g, now, 0, false); } finally { this._bare = false; }
    return c;
  }

  _terrGeo(st, k) {
    const { cx, cy, R } = this.view;
    const [ax, ay] = st.L.anchors[k];
    const cell = st.L.cells[k];
    let gx = ax, gy = ay;
    if (cell && cell.length >= 3) {
      const c = globalThis.d3.polygonCentroid(cell);
      gx = (ax + c[0]) / 2; gy = (ay + c[1]) / 2;
    }
    return { px: cx + gx * R, py: cy + gy * R, r: Math.max(8, st.L.rEq[k] * R * 1.05) };
  }

  // ============================================================================== drawing: sky & body
  /**
   * The globe on screen right now: centre, limb radius Rg (px), the live camera zoom z and `fade` — how much of the
   * porthole look (bezel, liquidity band, cel shading) remains. 真实: Rg = R0·z (px/rad), fading out by ×1.35 (the
   * free camera's live zoom while it moves; the flight's zoom while a level flies). 抽象: the porthole, always.
   */
  _globe() {
    const v = this.viewTarget || this.view, st = this.cur;
    const R0 = v.R0 || v.R;
    if (!st) return { cx: v.cx, cy: v.cy, R0, z: 1, Rg: R0, fade: 1, real: false };
    let z = this._camZoom(st);
    const fc = this._fc, tr = this.transition;
    if (!st.real) {
      // §26 amendment 5: a zoomed 抽象 planet grows like the real Earth (its live camera while it moves)
      if (!tr && fc && fc.cam && fc.st === st && fc.moving()) z = fc.cam.zoom;
      return { cx: v.cx, cy: v.cy, R0, z, Rg: R0 * z, fade: this._porthole(st, z), real: false };
    }
    if (tr && tr.fly && fc && fc.cam) z = fc.cam.zoom; // (§26 amendment 5: a level flight — its live camera)
    else if (tr) {
      const e = easeInOutCubic(clamp((performance.now() - tr.t0) / tr.dur, 0, 1));
      z = Math.exp(lerp(Math.log(tr.zFrom || 1), Math.log(z), e));
    } else if (fc && fc.cam && fc.st === st && fc.moving()) z = fc.cam.zoom;
    return { cx: v.cx, cy: v.cy, R0, z, Rg: R0 * z, fade: this._porthole(st, z), real: true };
  }

  /** §26 paper veil: a full-bleed real map runs under the top bar, the gauges and the since-line — a clean paper card
   *  of the sky paper behind them keeps that text legible (as in 3D). Rebuilt when those boxes move. */
  _drawVeil(ctx) {
    const gl = this._globe();
    const a = 1 - gl.fade; // (§26 amendment 5: a zoomed 抽象 planet runs under the shell's UI too)
    if (a < 0.01 || typeof document === 'undefined') return;
    const now = performance.now();
    if (!this._veilT || now - this._veilT > 700) { this._veilT = now; this._buildVeil(); }
    if (!this._veilOk) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.drawImage(this._veilC, 0, 0, this.W, this.H);
    ctx.restore();
  }

  _buildVeil() {
    const rect = this.canvas.getBoundingClientRect();
    const rs = [];
    for (const id of ['topbar', 'gauges', 'since']) {
      const el = document.getElementById(id);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      rs.push(id === 'topbar' ? [-40, -40, this.W + 40, r.bottom - rect.top] : [r.left - rect.left, r.top - rect.top, r.right - rect.left, r.bottom - rect.top]);
    }
    const key = rs.map((r) => r.map(Math.round).join(',')).join('|') + `|${this.W}x${this.H}@${this.dpr}|${this.theme.name}`;
    if (key === this._veilKey) return;
    this._veilKey = key;
    this._veilOk = rs.length > 0;
    if (!this._veilOk) return;
    const c = this._veilC || (this._veilC = document.createElement('canvas'));
    c.width = Math.round(this.W * this.dpr); c.height = Math.round(this.H * this.dpr);
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    // §26 refine: clean paper cards, not a feathered wash (the old 24 px feather smeared the map under the gauges into
    // a soft glow): the sky paper itself, a crisp hairline edge and the cards' small shadow (§17 paper cut)
    const th = this.theme;
    const shapes = rs.map(([x0, y0, x1, y1]) => {
      const p = new Path2D();
      const pad = x0 < -20 ? 0 : 8;
      rrPath(p, x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad, x0 < -20 ? 0 : 9);
      return p;
    });
    g.save();
    g.translate(1.5, 2.5);
    g.fillStyle = th.cardShadow;
    for (const p of shapes) g.fill(p);
    g.restore();
    // (the hairline first, 2 px, then the paper over it: only the outer 1 px of the union's outline stays — no line
    // where the top bar's card meets the gauges' card)
    g.lineWidth = 2;
    g.strokeStyle = th.cardLine;
    for (const p of shapes) g.stroke(p);
    const all = new Path2D();
    for (const p of shapes) all.addPath(p);
    g.save();
    g.clip(all);
    g.clearRect(0, 0, this.W, this.H);
    g.globalAlpha = 0.95;
    g.drawImage(this.bg, 0, 0, this.W, this.H);
    g.restore();
  }

  _drawBg(ctx) {
    const { W, H } = this;
    ctx.drawImage(this.bg, 0, 0, W, H);
    // instrument bezel: one thin ring with 5° ticks (30° majors) — static while planets fly; §26 it hugs a growing real
    // globe and fades out as the map goes full-bleed
    // (§26 amendment 5: gone — the 3D planet has no bezel; 2D is the same picture flattened)
    const gl = this._globe();
    if (!this._bezel || gl.fade <= 0.01) return;
    const { cx, cy } = gl;
    const th = this.theme;
    const rr = gl.Rg + Math.max(14, gl.R0 * 0.07);
    ctx.save();
    ctx.globalAlpha = gl.fade;
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.bezel;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      if (i % 6 === 0) continue;
      const a = (i / 72) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(cx + c * rr, cy + s * rr);
      ctx.lineTo(cx + c * (rr + 3.5), cy + s * (rr + 3.5));
    }
    ctx.stroke();
    ctx.strokeStyle = th.bezelStrong;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(cx + c * (rr - 1), cy + s * (rr - 1));
      ctx.lineTo(cx + c * (rr + 7), cy + s * (rr + 7));
    }
    ctx.stroke();
    ctx.restore();
  }

  /** The local rectangle the cached surface covers: the window (the porthole, or the real globe's disc) ∩ the canvas. */
  _surfRect(st, cx, cy, R) {
    const win = st.win || 1, pad = st.cachePad / R;
    const q = (x) => Math.round(x * 400) / 400;
    return [
      q(Math.max(-win, -cx / R) - pad), q(Math.max(-win, -cy / R) - pad),
      q(Math.min(win, (this.W - cx) / R) + pad), q(Math.min(win, (this.H - cy) / R) + pad),
    ];
  }

  /**
   * The surface, cached in two layers at the current radius (local units, 1 = R px; the rect of _surfRect):
   *   base    — sea, depth rings and coast foam, neutral land: only the view / theme / coasts change it
   *   weather — sea-area tints, territory fills, hatch, isobars, region edges, atlas lines: redrawn while values lerp
   * (§26 full-bleed: a zoomed real map's layers are as large as the screen; a lerp only repaints the weather layer.)
   */
  _surface(st) {
    const { cx, cy, R } = this.view, th = this.theme;
    const rect = this._surfRect(st, cx, cy, R);
    // big screens: the cache resolution is capped (≈ 12 Mpx a layer), never the layout
    const wC = (rect[2] - rect[0]) * R, hC = (rect[3] - rect[1]) * R;
    const dpr = Math.min(this.dpr, Math.sqrt(12e6 / Math.max(1, wC * hC)));
    st.cacheDpr = dpr; // (device px per css px of the cached layers: the dot screen's tile, 3D's device-px lines)
    const geoKey = `${R.toFixed(1)}|${dpr.toFixed(3)}|${rect.join(',')}|${th.name}`;
    const prep = (c) => {
      const w = Math.max(1, Math.ceil(wC * dpr)), h = Math.max(1, Math.ceil(hC * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext('2d');
      // (refine-surface: drop the last build's window clip first — clip() intersects, so a layer rebuilt at the same size
      // under a moved window kept the old circle's cut)
      if (c.__clip) g.restore();
      g.save(); c.__clip = true;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);
      const k = dpr * R;
      g.setTransform(k, 0, 0, k, -rect[0] * k, -rect[1] * k);
      g.beginPath();
      g.arc(0, 0, st.win || 1, 0, Math.PI * 2);
      g.clip();
      return g;
    };
    // (§26 amendment 5: the 3D sea costs ~25 ms — while the porthole glides to a new size (panel opened / closed) the
    // last base layer is drawn scaled, and rebuilt once the view rests)
    const glide = !!this.viewTarget && !!st.cacheBase && !!st.baseKey && st.baseKey.endsWith('|' + th.name);
    if (st.landPath && st.baseKey !== geoKey && !glide) {
      if (!st.cacheBase) st.cacheBase = document.createElement('canvas');
      const g = prep(st.cacheBase);
      this._drawBase(g, st, R, rect);
      st.baseKey = geoKey;
      st.baseRect = rect;
    }
    // (refine-surface: the ink where two regions meet — geometry only: built with the view, never per weather step)
    st.geoKey = geoKey;
    if (st.real && st.landPath && st.inkKey !== geoKey && !glide) {
      this._sharedInk(st, prep(st.inkC || (st.inkC = document.createElement('canvas'))), R);
      st.inkKey = geoKey;
    }
    const wxKey = `${geoKey}|${st.fieldVer}|${this._ovVer}`;
    if (st.wxKey !== wxKey) {
      if (!st.cache) st.cache = document.createElement('canvas');
      const g = prep(st.cache);
      this._drawWeather(g, st, R, rect);
      st.wxKey = wxKey;
    }
    st.cacheR = R;
    st.cacheRect = rect;
    return st;
  }

  /**
   * §26 amendment 5 (refine-surface): where two regions meet, 3D draws both regions' ink edges (each 0.75 px outside
   * its own ring: one 1.5 px ink line with a faint rim either side); 2D's edge is clipped outside the land's union, so
   * that line was lost (a white double rim). Every ring stroked 1.5 px, then kept only ≥ 0.9 px inside the land (an
   * erosion by eight shifted fills) — the coasts keep their rim. Drawn by _drawEdges from st.inkC.
   */
  _sharedInk(st, g, R) {
    g.lineJoin = 'round';
    g.lineWidth = 1.5 / R; g.strokeStyle = this.theme.ink; g.globalAlpha = 0.74;
    g.stroke(st.landPath);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = '#000';
    const d = 0.9 / R, q = d * Math.SQRT1_2;
    for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [q, q], [-q, q], [q, -q], [-q, -q]]) { g.save(); g.translate(dx, dy); g.fill(st.landPath, 'evenodd'); g.restore(); }
    g.globalCompositeOperation = 'source-over';
  }

  /** §25 the sea and the unclaimed land — §26 amendment 5: drawn like the 3D ground (planet/seabed.js): deep → shallow
   *  water by coast distance, two 等深線 rings, wave marks, foam, 3D's toon light; unclaimed land in 3D's paper with a
   *  faint dot screen and a hairline coast (real night: navy sea, dusk land). */
  _drawBase(g, st, R, rect) {
    const th = this.theme;
    const day = th.name !== 'night';
    const pal = seaLook(th.name, !!st.real);
    // (3D: the real Earth's sea keeps its size on screen (globe.js uDS = zoom); an abstract planet's sea is painted on the
    // planet and grows with it — so its unit is R0 × zoom)
    const zc = this._camZoom(st), R0 = (this.view.R0 || this.view.R) * (st.real ? 1 : zc), light = this._toon(st), fr = st.frame;
    const [e, n] = fr ? frameOf(fr.v) : [null, null];
    const both = [[st.landPath, 'evenodd'], [st.neutralPath, 'evenodd']];
    const sea = drawSeabed(g, { rect, R, R0, dpr: this.dpr, pal, light, zoom: st.real ? zc : 1, real: !!st.real, land: both, proj: fr ? { v: fr.v, e, n, Z: st.Zl || fr.Zl || 1, D: fr.D || 0 } : null });
    this.stats.seaMs = Math.round(sea.ms);
    g.fillStyle = pal.land;
    g.fill(st.neutralPath, 'evenodd');
    dotScreen(g, st.neutralPath, 'evenodd', pal, R0, (st.cacheDpr || this.dpr) * R, st.cacheDpr || this.dpr,
      fr ? { v: fr.v, e, n, Z: st.Zl || fr.Zl || 1, D: fr.D || 0, rect, R, real: !!st.real } : null);
    shadeLand(g, st.neutralPath, 'evenodd', st.win || 1, light, day, null, Math.hypot(Math.max(-rect[0], rect[2]), Math.max(-rect[1], rect[3])));
    // the coast hairline (3D globe.js: every coast in the paper border colour, α .5, one device px)
    g.lineWidth = 1 / Math.max(1, this.dpr) / R;
    g.strokeStyle = th.border;
    g.globalAlpha = 0.5;
    g.stroke(st.neutralPath);
    g.globalAlpha = 1;
  }

  /** §26 amendment 5: the camera zoom of a state (真实 the real camera; 抽象 its layout zoom) and 3D's light at it. */
  _camZoom(st) { return st && st.real ? st.real.zoom : st ? (st.Zl || 1) * (st.ext || 1) : 1; }
  _toon(st) { return toonLight(this._camZoom(st), !!(st && st.real)); }

  /** The weather layer: everything that changes with the day's values (see _surface). */
  _drawWeather(g, st, R, rect) {
    const th = this.theme;
    const day = th.name !== 'night';
    if (st.landPath) {
      if (st.seaPath) {
        // §26 sea areas stay water: the weather colour at ≤ 25 % over the ocean (a neutral one: no tint at all —
        // swell lines and the dashed chart line only)
        const mid = Math.floor(BAND_EDGES.length / 2); // the 生成り band: no tint
        g.save();
        g.globalAlpha = 0.25;
        for (let k = 0; k < st.n; k++) {
          if (st.kind[k] !== 'sea') continue;
          const b = bandOf(clamp(Number.isFinite(st.cur.temp[k]) ? st.cur.temp[k] : 0, -3, 3));
          if (b === mid) continue;
          g.fillStyle = th.bandCSS[b];
          g.fill(st.polyPaths[k], 'evenodd');
        }
        g.restore();
        g.save();
        g.clip(st.seaPath, 'evenodd');
        g.globalAlpha = 0.5;
        g.strokeStyle = '#f6f9f3';
        g.lineWidth = 0.9 / R;
        g.beginPath();
        for (let yy = rect[1]; yy < rect[3]; yy += 7 / R) { g.moveTo(rect[0], yy); g.lineTo(rect[2], yy + 0.35); }
        g.stroke();
        g.restore();
        g.save();
        g.setLineDash([5 / R, 4 / R]);
        g.lineWidth = 1 / R;
        g.strokeStyle = th.inkSoft;
        g.globalAlpha = 0.6;
        g.stroke(st.seaPath);
        g.restore();
      }
      if (st.real) {
        // §17 paper cut: every claimed region casts a soft drop shadow (3D EDGE_FS band 2: 0.2–1.4 px outside, α .22
        // falling off, 0.6 px away from the upper-left light, in the ink colour)
        g.save();
        g.translate(0.45 / R, 0.4 / R);
        g.lineJoin = 'round';
        g.lineWidth = 2.8 / R; g.strokeStyle = th.ink; g.globalAlpha = 0.1;
        g.stroke(st.landPath);
        g.restore();
      }
      g.save();
      g.clip(st.landPath, 'evenodd');
    }
    if (st.real) this._fillTerritories(g, st);
    else {
      // isotherm bands, stacked like layered paper: each warmer layer casts a tiny crisp shadow
      g.fillStyle = th.bandCSS[0];
      g.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
      const sx = 0.9 / R, sy = 1.4 / R;
      if (st.bands) {
        for (let i = 0; i < st.bands.length; i++) {
          const p = st.bands[i];
          g.save();
          g.translate(sx, sy);
          g.fillStyle = th.bandShadow;
          g.fill(p);
          g.restore();
          g.fillStyle = th.bandCSS[i + 1];
          g.fill(p);
        }
      }
    }
    // estimates (§14) and inferred scenario impacts: hatched, with a dashed outline
    const estK = [];
    for (let k = 0; k < st.n; k++) if (this._isEst(st, k)) estK.push(k);
    for (const k of estK) {
      const [x0, y0, x1, y1] = st.L.bbox[k];
      g.save();
      g.clip(st.polyPaths[k]);
      // (3D PLATE_FS: an estimate is 30 % toward the paper, then hatched)
      g.fillStyle = day ? 'rgba(236,228,211,0.3)' : 'rgba(224,217,200,0.3)';
      g.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
      g.beginPath();
      const step = 7 / R, span = (x1 - x0) + (y1 - y0);
      for (let d = -span; d < span; d += step) { g.moveTo(x0 + d, y0); g.lineTo(x0 + d + (y1 - y0), y1); }
      g.lineWidth = 1 / R;
      g.strokeStyle = th.hatch;
      g.stroke();
      g.restore();
    }
    // (§26 amendment 5: no isobars on the ground — 3D draws none; st.iso stays computed for whoever reads it)
    // 3D's toon light on the land: the thin shadow crescent on the anti-light limb (≤ 6 % luma)
    if (st.landPath) shadeLand(g, null, null, st.win || 1, this._toon(st), day, null, Math.hypot(Math.max(-rect[0], rect[2]), Math.max(-rect[1], rect[3])));
    if (st.landPath) g.restore();
    this._drawEdges(g, st, R, estK);
  }

  /** §26 real: each territory one flat weather colour, filled from its own exact rings (admin-unit fills go here). */
  _fillTerritories(g, st) {
    const th = this.theme;
    for (let k = 0; k < st.n; k++) {
      if (st.kind && st.kind[k] !== 'land') continue;
      const T = st.cur.temp[k];
      g.fillStyle = th.bandCSS[bandOf(clamp(Number.isFinite(T) ? T : 0, -3, 3))];
      g.fill(st.polyPaths[k], 'evenodd');
    }
  }

  /** Territory edges (paper cuts: soft shade + off-white line; §25 every coast), §26 atlas lines, 估 dashes. */
  _drawEdges(g, st, R, estK) {
    const th = this.theme;
    if (st.landPath && st.real) {
      // §17 regions on the real Earth's paper land (§26 amendment 5: 3D's EDGE ribbons): an off-white inner rim and a
      // firm ink edge just outside (0…0.75 px, α .74), so a neutral-temperature region still reads as land with money
      // on it (the drop shadow is in _drawWeather). refine-surface: the rim as 3D's band 0 — α .88 over the outer 1 px,
      // fading over the next .5 px (smoothstep(0, .35) across 1.5 px): the solid 1.5 px rim (+ a hairline) read as a
      // chalk outline at night (cream rim + cream night ink ≈ 4 light px; 3D ≈ 1.5)
      g.lineJoin = 'round';
      g.save(); g.clip(st.landPath, 'evenodd');
      g.strokeStyle = th.border;
      g.lineWidth = 3 / R; g.globalAlpha = 0.2; g.stroke(st.landPath);
      g.lineWidth = 2 / R; g.globalAlpha = 0.85; g.stroke(st.landPath);
      g.restore();
      g.save();
      const out = new Path2D();
      out.rect(-1e3, -1e3, 2e3, 2e3);
      out.addPath(st.landPath);
      g.clip(out, 'evenodd');
      g.lineWidth = 1.5 / R; g.strokeStyle = th.ink; g.globalAlpha = 0.74; g.stroke(st.landPath);
      g.restore();
      g.globalAlpha = 1;
      // (where two regions meet: both regions' ink edges, one 1.5 px line — _sharedInk, built once per view)
      if (st.inkC && st.inkKey === st.geoKey && st.inkC.width === g.canvas.width && st.inkC.height === g.canvas.height) {
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(st.inkC, 0, 0); g.restore();
      }
    } else if (st.landPath) {
      g.lineJoin = 'round';
      g.lineWidth = 3 / R; g.strokeStyle = th.borderShade; g.stroke(st.landPath);
      g.lineWidth = 1.3 / R; g.strokeStyle = th.border; g.stroke(st.landPath);
    } else if (st.n > 1) {
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.lineWidth = 3.4 / R;
      g.strokeStyle = th.borderShade;
      g.stroke(st.borderPath);
      g.lineWidth = 1.5 / R;
      g.strokeStyle = th.border;
      g.stroke(st.borderPath);
    }
    if (st.real) {
      // §26 atlas context: faint country borders, US states when the view is in the US
      // (§26 amendment 5: 3D's atlas lines — one device px in the outline ink, country borders α .10→.18 with the zoom,
      // states .22 and provinces .18 fading in from ×1.3 / ×1.5: the strongest lines at ×3.6–×8)
      const cp = this._ctxPath(st);
      if (cp) {
        const z = st.real.zoom || 1, w1 = 1 / Math.max(1, this.dpr) / R;
        g.lineJoin = 'round';
        // (refine-surface: 3D lays the atlas lines on the ground, under the raised regions — none crosses a region;
        // inside one only its fold lines show)
        g.save();
        if (st.landPath) { const out = new Path2D(); out.rect(-1e3, -1e3, 2e3, 2e3); out.addPath(st.landPath); g.clip(out, 'evenodd'); }
        g.lineWidth = w1; g.strokeStyle = th.atlas || th.inkFaint;
        g.globalAlpha = 0.1 + 0.08 * clamp((z - 1) / 2, 0, 1); g.stroke(cp.borders);
        if (cp.states) { g.globalAlpha = 0.22 * clamp((z - 1.3) / 0.8, 0, 1); if (g.globalAlpha > 0.005) g.stroke(cp.states); }
        // §26 amendment 2: provinces / prefectures of every country in a zoomed view, the same faint style
        if (cp.admin1) { g.globalAlpha = 0.18 * clamp((z - 1.5) / 0.8, 0, 1); if (g.globalAlpha > 0.005) g.stroke(cp.admin1); }
        // §26 amendment 4: unclaimed admin units (level ≥ 2) — each border fades by its own length on screen
        // (smoothstep 18–46 px), so a county mesh never turns the map into a spreadsheet (3D world.js UNITLINE_FS)
        if (cp.unitOut) { g.strokeStyle = th.ink; for (const b of cp.unitOut) { g.globalAlpha = this._unitOutAlpha(st, z) * b.f; g.stroke(b.p); } }
        g.globalAlpha = 1;
        g.restore();
        // fold lines inside a territory (two of its units meet): an off-white crease on the colour, fading 8–22 px
        if (cp.unitIn) { g.lineWidth = w1; g.strokeStyle = th.border; for (const b of cp.unitIn) { g.globalAlpha = 0.5 * b.f; g.stroke(b.p); } g.globalAlpha = 1; }
      }
    }
    if (estK.length) {
      g.setLineDash([4 / R, 3 / R]);
      g.lineWidth = 1.3 / R;
      g.strokeStyle = th.inkSoft;
      for (const k of estK) g.stroke(st.polyPaths[k]);
      g.setLineDash([]);
    }
  }

  /**
   * §26 refine: how strongly unclaimed admin-unit borders show (§26 amendment 5: 3D's ink α .13 by day, .20 at night;
   * each border then fades by its own length on screen — _ctxPath / freecam2d bucket them by unitFade).
   */
  _unitOutAlpha(st, z) {
    return this.theme.name === 'night' ? 0.2 : 0.13;
  }

  /** Country borders (+ US states) projected into this real view (local units); null until the lines are loaded. */
  _ctxPath(st) {
    if (st.ctxPath !== undefined) return st.ctxPath;
    if (!this._lines) {
      this._lines = { b: null, s: null };
      borderLines().then((b) => { this._lines.b = b; this._ovVer = (this._ovVer || 0) + 1; if (this.cur) this.cur.ctxPath = undefined; }).catch(() => {});
      stateLines().then((x) => { this._lines.s = x; this._ovVer = (this._ovVer || 0) + 1; if (this.cur) this.cur.ctxPath = undefined; }).catch(() => {});
    }
    if (!this._lines.b) return null;
    const c = st.real.dir, Z = st.Zl || st.real.zoom, [e, n] = frameOf(c), RAD = Math.PI / 180;
    const LD = st.frame && st.frame.D, LV = LD ? lensVis(LD) : 0, LK = (fz) => (LD ? Z * lensK(LD, fz) : Z); // §26 amendment 5: the 3D lens
    // (local units of the layout: projected × Zl; cull past the screen)
    const { cx, cy, R } = this.view;
    const lim = Math.max(1.6, Math.max(cx, this.W - cx, cy, this.H - cy) / R + 0.2);
    const mk = (lines) => {
      const p = new Path2D();
      for (const L of lines) {
        let pen = false;
        for (const [lon, lat] of L) {
          const a = lon * RAD, b = lat * RAD, cb = Math.cos(b), x = cb * Math.sin(a), y = Math.sin(b), z = cb * Math.cos(a);
          const fz = x * c[0] + y * c[1] + z * c[2], kz = LK(fz);
          const px = (x * e[0] + y * e[1] + z * e[2]) * kz, py = -(x * n[0] + y * n[1] + z * n[2]) * kz;
          if (fz < LV + 0.02 || Math.abs(px) > lim || Math.abs(py) > lim) { pen = false; continue; }
          if (pen) p.lineTo(px, py); else p.moveTo(px, py);
          pen = true;
        }
      }
      return p;
    };
    // provinces / prefectures (amendment 2): the countries of a zoomed view, loaded lazily per country
    let admin1 = null;
    if (st.real.zoom >= 1.6) {
      const key = 'a1:' + c.map((x) => x.toFixed(2)).join(',') + st.real.zoom.toFixed(1);
      if (!this._a1 || this._a1.key !== key) {
        this._a1 = { key, lines: null };
        const v = st.real.view || { lon: 0, lat: 0 };
        const box = viewWindow({ lon: v.lon, lat: v.lat, scale: Math.max(1.05, this._realWin(v, st.real.zoom).ze) }, 1.2, 1.15);
        const given = st.real.context && Array.isArray(st.real.context.admin1) ? Promise.resolve(st.real.context.admin1.filter((x) => x !== 'US')) : admin1For(box, { skip: ['US'] });
        const a1 = this._a1;
        given.then((ccs) => Promise.all(ccs.slice(0, 12).map((cc) => admin1Lines(cc).catch(() => [])))).then((ls) => {
          a1.lines = [].concat(...ls);
          this._ovVer = (this._ovVer || 0) + 1;
          if (this.cur) this.cur.ctxPath = undefined;
        }).catch(() => {});
      }
      if (this._a1.lines && this._a1.lines.length) admin1 = mk(this._a1.lines);
    }
    // §26 amendment 4: fold lines between two units of one territory, faint borders between unclaimed units
    let unitIn = null, unitOut = null;
    if (st.um && st.unitFs) {
      const UL = unitLines(st.um, st.unitFs);
      // (flat lon,lat arrays straight from the topology — the same projection / culling as mk)
      // §26 amendment 5: every arc fades by its own length on screen (3D: the arc's chord sum × px per rad, smoothstep
      // f0–f1 px) — arcs share a path per fade step (8 steps), arcs too short to read are not drawn
      const pxR = this.view.R * Z;
      const mkFlat = (list, f0, f1) => {
        const B = new Map();
        for (const A of list) {
          const fd = unitFade(A, pxR, f0, f1);
          if (fd <= 0) continue;
          let p = B.get(fd);
          if (!p) { p = new Path2D(); B.set(fd, p); }
          let pen = false;
          for (let i = 0; i + 1 < A.length; i += 2) {
            const a = A[i] * RAD, b = A[i + 1] * RAD, cb = Math.cos(b), x = cb * Math.sin(a), y = Math.sin(b), z = cb * Math.cos(a);
            const fz = x * c[0] + y * c[1] + z * c[2], kz = LK(fz);
            const px = (x * e[0] + y * e[1] + z * e[2]) * kz, py = -(x * n[0] + y * n[1] + z * n[2]) * kz;
            if (fz < LV + 0.02 || Math.abs(px) > lim || Math.abs(py) > lim) { pen = false; continue; }
            if (pen) p.lineTo(px, py); else p.moveTo(px, py);
            pen = true;
          }
        }
        return [...B].map(([f, p]) => ({ f, p }));
      };
      if (UL.inner.length) unitIn = mkFlat(UL.inner.map((x) => x[1]), 8, 22);
      if (UL.neutral.length) unitOut = mkFlat(UL.neutral, 18, 46);
    }
    st.ctxPath = { borders: mk(this._lines.b), states: st.real.context && st.real.context.states && this._lines.s ? mk(this._lines.s) : null, admin1, unitIn, unitOut };
    return st.ctxPath;
  }

  _drawBody(ctx, cx, cy, R, st, alpha, shade = true) {
    if (alpha <= 0.001 || R < 1) return;
    const th = this.theme;
    this._surface(st);
    const rect = st.cacheRect, Rw = R * (st.win || 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    // cast shadow on the paper under the globe's own disc (§26 amendment 5: 3D's soft paper drop, not a crisp disc)
    this._drawDrop(ctx, cx, cy, Rw);
    ctx.imageSmoothingEnabled = true;
    const x = cx + rect[0] * R, y = cy + rect[1] * R, w = (rect[2] - rect[0]) * R, h = (rect[3] - rect[1]) * R;
    if (st.landPath && st.cacheBase) {
      const b = st.baseRect || rect;
      ctx.drawImage(st.cacheBase, cx + b[0] * R, cy + b[1] * R, (b[2] - b[0]) * R, (b[3] - b[1]) * R);
    }
    ctx.drawImage(st.cache, x, y, w, h);
    if (shade) this._shadeOf(ctx, st, cx, cy, R);
    ctx.restore();
  }

  /** §26 amendment 5: 3D's paper drop under the planet (SKY_FS: offset (0.03, 0.045)·R, soft from −0.04 R to +0.09 R,
   *  warm sand α .10 by day, a faint dark α .22 at night). */
  _drawDrop(ctx, cx, cy, Rw) {
    if (!(Rw > 4) || Rw > 2.2 * Math.max(this.W, this.H)) return;
    const day = this.theme.name !== 'night';
    const c = day ? '140,125,97' : '5,8,20', a = day ? 0.1 : 0.22;
    const x = cx + Rw * 0.03, y = cy + Rw * 0.045, r0 = Rw * 0.96, r1 = Rw * 1.09;
    const gr = ctx.createRadialGradient(x, y, r0, x, y, r1);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) gr.addColorStop(t, `rgba(${c},${(a * (1 - t * t * (3 - 2 * t))).toFixed(4)})`);
    ctx.beginPath();
    ctx.arc(x, y, r1, 0, Math.PI * 2);
    ctx.fillStyle = gr;
    ctx.fill();
  }

  /** How much porthole look a state keeps (cel shading, bezel, liquidity band): 1 at the porthole, 0 by ×1.35 on the
   *  real Earth (full-bleed comes next). */
  _porthole(st, z = null) {
    if (!st) return 1;
    return 1 - smoothstep(1.02, 1.35, z != null ? z : this._camZoom(st));
  }

  _shadeOf(ctx, st, cx, cy, R) { this._drawShade(ctx, cx, cy, R * (st && st.win ? st.win : 1), this._porthole(st), st); }

  /**
   * The globe's own disc (radius Rw): §26 amendment 5 — 3D's toon light. The mid tone and the thin shadow crescent are in
   * the cached ground (planet/seabed.js); here the cream rim on the lit limb (light from the live zoom: it swings to the
   * camera as a real Earth comes close) and always the ink limb. (fade: kept for callers; the light itself decides.)
   */
  _drawShade(ctx, cx, cy, Rw, fade = 1, st = this.cur) {
    const th = this.theme;
    if (Rw > 2.2 * Math.max(this.W, this.H)) return; // the limb is far off the screen
    const gl = st === this.cur ? this._globe() : null;
    drawRim(ctx, cx, cy, Rw, toonLight(gl && gl.real ? gl.z : this._camZoom(st), !!(st && st.real)), th.name !== 'night');
    // (3D's inverted hull: 1.7 / 1.5 px pushed out from a hull a hair inside the sea — on screen ≈ 1.3 px of ink by day
    // at ×1, ≈ 1 px by night; refine-surface: the stroke widths that draw that (1.7 / 1.5 read as a bold navy disc).
    // 3D's own line thins with the zoom and breaks by ×1.6 (its hull sits 0.003 inside the sea); 2D keeps it whole)
    const lw = th.name !== 'night' ? 1.2 : 1.1;
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = th.outline;
    ctx.beginPath();
    ctx.arc(cx, cy, Rw + lw / 2 - 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawTransition(ctx, now, tr) {
    const st = this.cur;
    const e = clamp((now - tr.t0) / tr.dur, 0, 1);
    const { cx, cy, R } = this.view;
    const W = this.W, H = this.H;
    const drawSnap = (a, s, ox, oy) => {
      if (!tr.snap || a <= 0.001) return;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.transform(s, 0, 0, s, ox, oy);
      ctx.drawImage(tr.snap, 0, 0, W, H);
      ctx.restore();
    };
    if (tr.geo && (tr.dir === 'in' || tr.dir === 'out')) {
      const { px, py, r } = tr.geo;
      const S = R / r;
      const u = tr.dir === 'in' ? easeInOutCubic(e) : 1 - easeInOutCubic(e);
      const k = Math.pow(S, u);
      const Ax = lerp(px, cx, u), Ay = lerp(py, cy, u);
      if (tr.dir === 'in') {
        // old parent zooms into the territory and dissolves; the child planet grows out of it
        drawSnap(1 - smoothstep(0.42, 0.92, e), k, Ax - k * px, Ay - k * py);
        this._drawBody(ctx, Ax, Ay, r * k, st, smoothstep(0.22, 0.78, e));
      } else {
        // new parent appears zooming out; the old child shrinks back into its territory
        this._drawBody(ctx, Ax + k * (cx - px), Ay + k * (cy - py), k * R, st, smoothstep(0.0, 0.55, e));
        const s = (r * k) / R;
        drawSnap(1 - smoothstep(0.35, 0.85, e), s, Ax - s * cx, Ay - s * cy);
      }
      return;
    }
    const E = easeInOutCubic(e);
    if (tr.dir === 'intro') {
      this._drawBody(ctx, cx, cy, R * lerp(0.92, 1, easeOutCubic(e)), st, smoothstep(0, 0.8, e));
    } else if (tr.dir === 'in') {
      const s = lerp(1, 1.45, E);
      drawSnap(1 - smoothstep(0, 0.6, e), s, cx - s * cx, cy - s * cy);
      this._drawBody(ctx, cx, cy, R * lerp(0.7, 1, E), st, smoothstep(0.25, 1, e));
    } else if (tr.dir === 'out') {
      this._drawBody(ctx, cx, cy, R * lerp(1.3, 1, E), st, smoothstep(0.1, 0.9, e));
      const s = lerp(1, 0.6, E);
      drawSnap(1 - smoothstep(0, 0.7, e), s, cx - s * cx, cy - s * cy);
    } else {
      // a true cross-fade (真实 ↔ 抽象, a refresh): the new picture comes up under the old one as it fades
      this._drawBody(ctx, cx, cy, R, st, smoothstep(0, 0.45, e));
      drawSnap(1 - smoothstep(0.1, 1, e), 1, 0, 0);
    }
  }

  /** §26 companies: crisp markers at their HQs (a weather-coloured dot, ink ring, paper halo); a crowd fans out. */
  _ptLayout(st) {
    const { cx, cy, R } = this.view;
    const fa = this._freeArea();
    const key = `${cx.toFixed(1)}|${cy.toFixed(1)}|${R.toFixed(1)}|${fa.x1}|${fa.y0}|${fa.y1}`;
    if (st.ptKey === key && st.pt) return st.pt;
    const L = st.L;
    const dv = st.points.map((k) => +((st.children[k].now || {}).dv20) || 0);
    const sorted = dv.filter((x) => x > 0).sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1] : 1;
    const pts = st.points.map((k, i) => {
      const [ax, ay] = L.anchors[k];
      const zf = clamp(1 + 0.11 * Math.log2(st.real ? st.real.zoom : 1), 1, 1.4);
      const r = clamp(4.2 + 1.9 * Math.log2(Math.max(0.25, dv[i] > 0 ? dv[i] / med : 0.6)), 3.2, 8.2) * zf + 1.6;
      const x = cx + ax * R, y = cy + ay * R;
      return { k, x, y, r, tx: x, ty: y, vis: this._visXY(st, x, y, 3) };
    });
    // clusters of touching markers → a tidy sunflower around their centre (biggest in the middle)
    const n = pts.length, par = pts.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      if (pts[a].vis && pts[b].vis && Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y) < pts[a].r + pts[b].r + 2) par[find(a)] = find(b);
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) if (pts[i].vis) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(pts[i]); }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      let gx = 0, gy = 0;
      for (const p of g) { gx += p.x; gy += p.y; }
      gx /= g.length; gy /= g.length;
      g.sort((a, b) => b.r - a.r);
      const placed = [];
      for (const p of g) {
        for (let j = 0; j < 400; j++) {
          const rr = j === 0 ? 0 : 5.3 * Math.sqrt(j), a = j * 2.39996;
          const x = gx + Math.cos(a) * rr, y = gy + Math.sin(a) * rr * 0.92;
          if (placed.every((o) => Math.hypot(o.tx - x, o.ty - y) >= o.r + p.r + 1.5)) { p.tx = x; p.ty = y; break; }
        }
        placed.push(p);
      }
    }
    st.ptKey = key;
    st.pt = pts;
    st.ptOf = new Map(pts.map((p) => [p.k, p]));
    return pts;
  }

  _drawPoints(ctx, st, reveal) {
    const th = this.theme;
    const pts = this._ptLayout(st);
    ctx.save();
    for (const p of pts) {
      if (!p.vis) continue;
      const k = p.k, hov = k === this.hoverIdx;
      const r = (p.r - 1.6) * (hov ? 1.3 : 1);
      const a = reveal * (1 - 0.55 * (st.dim[k] || 0));
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      if (Math.hypot(p.tx - p.x, p.ty - p.y) > 2) {
        // a hairline back to the true HQ when the crowd fanned it out
        ctx.strokeStyle = th.inkFaint; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.tx, p.ty); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(p.tx, p.ty, r + 1.6, 0, Math.PI * 2); ctx.fillStyle = th.paper; ctx.fill();
      ctx.beginPath(); ctx.arc(p.tx, p.ty, r, 0, Math.PI * 2); ctx.fillStyle = th.ink; ctx.fill();
      const T = st.scenOn ? (st.scen[k] && st.scen[k].on ? st.scen[k].value : 0) : st.cur.temp[k];
      ctx.beginPath(); ctx.arc(p.tx, p.ty, Math.max(1.2, r - 1.3), 0, Math.PI * 2); ctx.fillStyle = th.bandCSS[bandOf(clamp(T, -3, 3))]; ctx.fill();
    }
    ctx.restore();
  }

  /**
   * §26 amendment 4: minority dots (a child's money inside a unit someone else owns, or one left unclaimed) in that
   * child's weather colour, and an ink ring around a territory too small to see at this zoom (DC in 债券).
   * Screen positions are kept for hover (st.tickScr).
   */
  _drawTicks(ctx, st, reveal) {
    st.tickScr = null;
    const M = st.um;
    if (!M || !st.real || reveal < 0.02) return;
    const th = this.theme;
    const out = [];
    ctx.save();
    ctx.globalAlpha = reveal;
    // §26 refine (one picture with 3D): a dot under a raised money plate is not seen (3D draws it just above the ground
    // with the depth test on — at national zoom the tall plates hide theirs, a metro view shows all of them); and
    // dots never pile up (§26 "never a pile"): heaviest first, one closer than 11 px to a dot already drawn is left out
    // (its money still reads in that unit's hover list)
    const under = this._tickPlate(st), { cx: vx, cy: vy, R: vR } = this.view;
    const order = [];
    for (let i = 0; i < M.ticks.length; i++) {
      const t = M.ticks[i];
      const q = this._llScreen(st, t.lon, t.lat);
      if (!q || !this._visXY(st, q[0], q[1], 2)) continue;
      const c = cellAt((q[0] - vx) / vR, (q[1] - vy) / vR), o = c >= 0 && st.L.owner ? st.L.owner[c] : -1;
      if (under(o, this._facingXY(st, q[0], q[1]))) continue;
      order.push([i, q]);
    }
    order.sort((a, b) => (+M.ticks[b[0]].w || 0) - (+M.ticks[a[0]].w || 0) || a[0] - b[0]);
    const kept = [];
    for (const [i, q] of order) {
      const t = M.ticks[i];
      if (kept.some((p) => (p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]) < 121)) continue;
      kept.push(q);
      const r = clamp(2.4 + 0.55 * Math.log10(Math.max(1e-3, t.w) * 1000), 2.2, 3.6) + (this.hoverIdx === t.k ? 0.8 : 0);
      const T = st.cur.temp[t.k];
      ctx.beginPath(); ctx.arc(q[0], q[1], r + 1.6, 0, Math.PI * 2);
      ctx.fillStyle = th.paper; ctx.fill();
      ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
      ctx.fillStyle = th.bandCSS[bandOf(clamp(Number.isFinite(T) ? T : 0, -3, 3))]; ctx.fill();
      ctx.lineWidth = 1.1; ctx.strokeStyle = th.ink; ctx.stroke();
      out.push({ i, k: t.k, x: q[0], y: q[1], r });
    }
    // tiny territories: a ring so the speck is seen
    for (const k of M.tiny) {
      const q = this._tinyXY(st, k);
      if (!q) continue;
      const [x, y] = q;
      if (!this._visXY(st, x, y, 4)) continue;
      const rr = 11 + (this.hoverIdx === k ? 1.5 : 0);
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.lineWidth = 3.2; ctx.strokeStyle = th.name === 'night' ? 'rgba(236,231,218,0.5)' : 'rgba(251,248,241,0.75)'; ctx.stroke();
      ctx.lineWidth = 1.2; ctx.strokeStyle = th.ink; ctx.globalAlpha = reveal * 0.8; ctx.stroke(); ctx.globalAlpha = reveal;
    }
    ctx.restore();
    st.tickScr = out;
  }

  /**
   * integrator (one rule with 3D world._buildTiny): a tiny territory's ring circles its MONEY — the sphere's hub (real.js
   * item.hub, its heaviest metro), never the raster's deepest speck: that anchor differed between the renderers' rasters
   * and could ring empty land (债券: 公司债's ring over Pennsylvania in 3D, Connecticut in 2D, its money in Manhattan).
   */
  _tinyXY(st, k) {
    if (k == null || k >= st.n) return null;
    const T = st.S && st.S.terr[k];
    if (T && T.hub) { const q = this._xyzScreen(st, T.hub); if (q) return q; }
    const a = st.L && st.L.anchors[k];
    return a ? [this.view.cx + a[0] * this.view.R, this.view.cy + a[1] * this.view.R] : null;
  }

  /**
   * 3D's plate height at a minority dot (planet3d/world.js heightOf · hs, capped by hCap; core.js plateH lays it down
   * toward the limb): (owner k, facing) → true when that plate stands above the dot (3D draws the dot at radius
   * 1 + neutralH + 0.0035 with the depth test on, planet3d.js tickMat uGround = world.neutralH(), so it hides there).
   */
  _tickPlate(st) {
    const wsR = this._windOpts(st).ws / ((st.frame && st.frame.Zl) || 1), z = this._camZoom(st);
    const hs = 0.42 * Math.sqrt(wsR), cap = 0.005 + clamp((z - 1.5) / 1.0, 0, 1) * 0.06, fl = 0.0025 * hs * 1.6;
    const hOf = (w) => (Number.isFinite(w) ? 0.009 + 0.072 * Math.pow(clamp((Math.min(3, Math.abs(w)) - 0.25) / 2.75, 0, 1), 1.1) : 0.009);
    return (k, face) => {
      if (k == null || k < 0 || k >= st.n || (st.kind && st.kind[k] !== 'land')) return false;
      const h = Math.min(cap, hOf(st.cur.wind[k]) * hs);
      return (h > fl ? Math.max(h * smoothstep(0.15, 0.55, face), fl) : h) > 0.0025 * hs + 0.0035;
    };
  }

  _drawLensDim(ctx, st, cx, cy, R) {
    let any = false;
    for (let k = 0; k < st.n; k++) if (st.dim[k] > 0.01) { any = true; break; }
    if (!any) return;
    ctx.save();
    this._clipWin(ctx, st);
    ctx.transform(R, 0, 0, R, cx, cy);
    for (let k = 0; k < st.n; k++) {
      const d = st.dim[k];
      if (d <= 0.01) continue;
      ctx.globalAlpha = d;
      ctx.fillStyle = this.theme.lensDim;
      ctx.fill(st.polyPaths[k]);
    }
    ctx.restore();
  }

  // ============================================================================== attention
  /** Territories allowed to blink/pulse (≤ 3): spotlight first, then fresh intel; fallback if unset. */
  _blinkSet(st) {
    const set = new Map();
    if (this.spot) {
      this.spot.forEach((s, i) => {
        const k = st.idxOf.get(s.id);
        if (k != null && set.size < 3) set.set(k, i);
      });
    } else {
      // fallback (spotlight never set): top-3 fronts / storms by a local surprise score
      const cand = [];
      for (let k = 0; k < st.n; k++) {
        const f = st.front[k], s = st.cur.storm[k], w = st.cur.wind[k];
        if (!f && !(s >= 0.8)) continue;
        cand.push([k, 0.6 * Math.abs(f) + 0.3 * (s >= 0.8 ? 1 : 0) + 0.25 * Math.abs(w || 0)]);
      }
      cand.sort((a, b) => b[1] - a[1]);
      cand.slice(0, 3).forEach(([k], i) => set.set(k, i));
    }
    if (set.size < 3 && Array.isArray(this.ov.intel)) {
      const cand = this._intelItems(st).filter((it) => it.fresh >= 0.5).sort((a, b) => b.score - a.score);
      for (const it of cand) { if (set.size >= 3) break; if (!set.has(it.k)) set.set(it.k, 10 + set.size); }
    }
    return set;
  }

  _accent(st, k) {
    const th = this.theme;
    const w = st.cur.wind[k];
    if (st.front[k] > 0) return th.in;
    if (st.front[k] < 0) return th.out;
    if (w >= 0.5) return th.in;
    if (w <= -0.5) return th.out;
    return th.gold;
  }

  _isEst(st, k) {
    if (st.est[k]) return true;
    const ch = st.children[k];
    if (this._estSet.has(ch.id)) return true;
    const sc = st.scen[k];
    return !!(sc && sc.inferred && sc.on);
  }

  /**
   * The spotlight items that get a callout card (≤ 3, with a `why`), in order — shared by the label
   * layout and _drawCaptions so a spotlight is numbered in ONE place only: the callout card. The
   * territory label then stays a plain (bold) name joined to its card by the leader line.
   */
  _captionList(st) {
    let list = this.spot && this.spot.length ? this.spot : null;
    if (!list && Array.isArray(this.ov.numbers)) list = this.ov.numbers.filter((x) => x && x.id != null);
    const out = [];
    for (const s of list || []) {
      if (out.length >= 3) break;
      // (refine-names: a card with no why — a 今日巡航 stop, tourNumbers' {id, n, why: ''} — still stands: just its title
      // row, as 3D draws it)
      const k = s && s.id != null ? st.idxOf.get(s.id) : null;
      if (k == null || out.some((o) => o.k === k)) continue;
      // §26 amendment 4: the shell's ①②③ name the deeper place a card speaks for (numbers[].deepId)
      let deep = s.deep || null;
      if (!deep && Array.isArray(this.ov.numbers)) { const nb = this.ov.numbers.find((x) => x && x.id === s.id); if (nb && nb.deepId && nb.deepId !== s.id) deep = nb.deepId; }
      out.push({ s: deep && deep !== s.deep ? Object.assign({}, s, { deep }) : s, k });
    }
    return out;
  }

  /** A real place on this state's map, canvas px; over the horizon → the limb point toward it ({over:true}). */
  _llToward(st, lon, lat) {
    if (!st || !st.frame) return null;
    const q = this._llScreen(st, lon, lat);
    if (q) return q;
    const d = dirOf(lon, lat), v = st.frame.v, [e, n] = frameOf(v);
    const px = d[0] * e[0] + d[1] * e[1] + d[2] * e[2], py = -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]), l = Math.hypot(px, py);
    if (l < 1e-6) return null;
    const { cx, cy, R } = this.view, k = R * st.frame.Zl * 0.97;
    const out = [cx + (px / l) * k, cy + (py / l) * k];
    out.over = true;
    return out;
  }

  /**
   * §26 refine — where territory k's money is on screen (canvas px): st.money (layout focus.at / item.hub; a company:
   * its marker) seen from this camera, the limb point toward it when it is over the horizon ({over:true}); without a
   * money place, the label anchor. One rule for the ①②③ leaders and the 主航道 ends (3D: sphere T.hub).
   */
  _moneyXY(st, k) {
    const { cx, cy, R } = this.view;
    const pp = st.ptOf && st.ptOf.get(k);
    if (pp) return [pp.tx, pp.ty];
    const m = st.money && st.money.get(k);
    if (m) { const q = this._llToward(st, m.ll[0], m.ll[1]); if (q) return q; }
    return [cx + st.L.anchors[k][0] * R, cy + st.L.anchors[k][1] * R];
  }

  _numberOf(st, k) {
    const ov = this.ov.numbers, id = st.children[k].id;
    if (Array.isArray(ov)) {
      const it = ov.find((x) => x && x.id === id);
      return it ? +it.n || ov.indexOf(it) + 1 : 0;
    }
    if (ov === 'auto' && this.spot) {
      const i = this.spot.findIndex((s) => s.id === id);
      return i >= 0 ? i + 1 : 0;
    }
    return 0;
  }

  _seasonOf(st, k) {
    if (st.scenOn) return null;
    const ov = this.ov.seasons;
    if (ov === null) return null;
    if (ov && typeof ov === 'object') return normSeason(ov[st.children[k].id]);
    const s = st.season[k];
    return s >= 0 ? SEASON_KEYS[s] : null;
  }

  /** Resolved 主航道 for this planet: {fk, tk, say} or null. */
  _channel(st) {
    const ov = this.ov.channel;
    if (ov === null || st.n < 2) return null;
    if (ov && typeof ov === 'object') {
      const fk = st.idxOf.get(ov.from), tk = st.idxOf.get(ov.to);
      if (fk != null && tk != null && fk !== tk) {
        // §26 amendment 5 (as 3D): a second destination (ov.to2, or one named after the first in the sentence that is
        // taking money in: "…奔向【欧洲】和【美洲】") gets a thinner branch
        const nm = (c) => c.name || c.ticker || c.id;
        let t2 = ov.to2 != null ? this._resolveK(st, ov.to2) : null;
        if (t2 == null && ov.say) {
          const say0 = String(ov.say), ti = say0.indexOf(nm(st.children[tk]));
          for (let k = 0; k < st.n && t2 == null; k++) {
            const name = String(nm(st.children[k]));
            if (k === fk || k === tk || name.length < 2) continue;
            const at = say0.indexOf(name);
            if (at >= 0 && (ti < 0 || at > ti) && st.to.wind[k] >= 0.3) t2 = k;
          }
        }
        return { fk, tk, t2k: t2 != null && t2 !== fk && t2 !== tk ? t2 : null, say: ov.say || this._autoSay(st, fk, tk) };
      }
    }
    let fk = -1, tk = -1, lo = Infinity, hi = -Infinity;
    for (let k = 0; k < st.n; k++) {
      const w = st.cur.wind[k];
      if (!Number.isFinite(w) || st.est[k]) continue;
      if (w < lo) { lo = w; fk = k; }
      if (w > hi) { hi = w; tk = k; }
    }
    // money rotates even when everyone is up: weakest → strongest, as long as there is a real gap
    if (fk < 0 || tk < 0 || fk === tk || hi - lo < 0.6 || (lo > -0.2 && hi < 0.2)) return null;
    return { fk, tk, say: this._autoSay(st, fk, tk) };
  }

  _autoSay(st, fk, tk) {
    const a = st.children[fk], b = st.children[tk];
    const nm = (c) => c.name || c.ticker || c.id;
    return st.scenOn ? `若成真：钱从【${nm(a)}】流向【${nm(b)}】` : `钱从【${nm(a)}】流向【${nm(b)}】`;
  }

  /** Territory index for an id on this planet: the child itself, or the child whose subtree holds it. */
  _resolveK(st, id) {
    if (id == null) return undefined;
    const k = st.idxOf.get(id);
    if (k != null) return k;
    if (!st.anc) st.anc = new Map();
    if (st.anc.has(id)) return st.anc.get(id);
    let found;
    for (let j = 0; j < st.n && found === undefined; j++) if (inSubtree(st.children[j], id)) found = j;
    st.anc.set(id, found);
    return found;
  }

  _intelItems(st) {
    const arr = Array.isArray(this.ov.intel) ? this.ov.intel : [];
    const out = [];
    for (const it of arr) {
      if (!it) continue;
      const k = this._resolveK(st, it.id);
      if (k == null) continue;
      const fresh = clamp(1 - (+it.ageDays || 0) / 6, 0.12, 1);
      const strength = clamp(+it.strength || 1, 1, 3);
      out.push({ k, dir: (+it.dir || 0) >= 0 ? 1 : -1, strength, fresh, title: it.title || '', score: strength * fresh, deep: this._intelDeep(it, st.children[k]), source: it.source || 'paste' });
    }
    return out;
  }

  /**
   * §26 refine: the deeper nodes an intel item is about (it.deep | it.impacts; else the event's impacts from
   * data/intel.json by it.eventId, loaded once in the background) — its tag goes there (卢拉连任 → 巴西), not on the
   * label of the territory that holds it (海外股市, drawn over Alaska / Tibet).
   */
  _intelDeep(it, child) {
    const ids = (x) => (Array.isArray(x) ? x : [x]).map((v) => (v && typeof v === 'object' ? v.id : v)).filter((v) => v != null && v !== (child && child.id));
    if (it.deep != null) return ids(it.deep);
    if (Array.isArray(it.impacts)) return ids(it.impacts);
    if (!it.eventId) return null;
    if (this._intelEv && this._intelEv.has(it.eventId)) return this._intelEv.get(it.eventId);
    const now = performance.now();
    if (!this._intelEvP && !(this._intelEvT && now - this._intelEvT < 60000) && typeof fetch === 'function') {
      this._intelEvT = now;
      this._intelEvP = fetch(new URL('../data/intel.json', import.meta.url).href, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null)).then((j) => {
          const arr = Array.isArray(j) ? j : j && Array.isArray(j.events) ? j.events : [];
          const m = new Map();
          for (const e of arr) if (e && e.id && Array.isArray(e.impacts)) m.set(e.id, e.impacts.map((i) => i && i.id).filter((v) => v != null));
          this._intelEv = m;
        }).catch(() => {}).finally(() => { this._intelEvP = null; });
    }
    return null;
  }

  // ============================================================================== §26 amendment 5: weather as in 3D
  /** The ①②③ territories (the only places whose cloud / intel words may speak unasked, §6 — Planet3D._sync spotKs). */
  _spotKs(st) {
    const memo = this._spotMemo;
    if (memo && memo.st === st && memo.ov === this.ov.numbers && memo.spot === this.spot) return memo.set;
    const set = new Set();
    for (let k = 0; k < st.n; k++) if (this._numberOf(st, k)) set.add(k);
    this._spotMemo = { st, ov: this.ov.numbers, spot: this.spot, set };
    return set;
  }

  /** The wind's units (fields.js coastWind, streams.js): px per local unit, the 3D view unit ws in local units (3D:
   *  1/zoom rad on the real Earth, 1 rad in 抽象 — × the layout's zoom), the sphere's territory sizes when at hand. */
  _windOpts(st) {
    const R = (this.view.R0 || this.view.R) * (st.ext || 1), L = st.L, S = st.windS && st.windS.terr && st.windS.terr.length === st.n ? st.windS : null;
    const ws = st.real || (st.aux && st.aux.real) ? 1 / (st.ext || 1) : L && L.zoom ? L.zoom : 1;
    return { R, ws, zoom: (L && L.zoom) || 1, seed: 'amb:' + st.node.id, angR: S ? S.terr.map((T) => T.angR) : null, partR: S ? S.terr.map((T) => (T.partR || T.angR) * ((L && L.zoom) || 1)) : null };
  }

  /** The sphere layout this state was built from (sphere.js: territory sizes, interior spots, outlines), or null. */
  _wxS(st) {
    const S = st.windS !== undefined && st.windS ? st.windS : this._fc && this._fc.st === st ? this._fc.S : null;
    return S && S.terr && S.terr.length === st.n ? S : null;
  }

  /** A unit vector on the globe → screen [x, y, facing] at the built view (null behind the globe). */
  _xyzScreen(st, d) {
    if (!st || !st.frame) return null;
    const l = Math.hypot(d[0], d[1], d[2]) || 1, x = d[0] / l, y = d[1] / l, z0 = d[2] / l;
    const v = st.frame.v, [e, n] = frameOf(v), D = st.frame.D;
    const f = x * v[0] + y * v[1] + z0 * v[2];
    if (f < (D ? lensVis(D) : 0) + 0.02) return null; // (§26 amendment 5: through the 3D lens, as _llScreen)
    const { cx, cy, R } = this.view, k = R * st.frame.Zl * (D ? lensK(D, f) : 1);
    return [cx + (x * e[0] + y * e[1] + z0 * e[2]) * k, cy - (x * n[0] + y * n[1] + z0 * n[2]) * k, f];
  }

  /** How squarely screen point (x, y) faces the viewer on the globe (1 at the middle, 0 at the limb; 3D's facing). */
  _facingXY(st, x, y) {
    const { cx, cy, R } = this.view, Rg = R * ((st && st.frame && st.frame.Zl) || (st && st.Zl) || 1);
    const D = st && st.frame && st.frame.D;
    if (D) { const p = lensInv(D, (x - cx) / Rg, (y - cy) / Rg); return p ? Math.max(0, p[2]) : 0; } // (§26 amendment 5: the 3D lens)
    const q = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (Rg * Rg);
    return q >= 1 ? 0 : Math.sqrt(1 - q);
  }

  /** Territory k's equivalent radius in local units (3D's angR × the layout's zoom; 2D's own when no sphere). */
  _propR(st, k) {
    const S = this._wxS(st);
    return S ? S.terr[k].angR * ((st.L && st.L.zoom) || 1) : st.L.rEq[k] || 0.05;
  }

  /** Ground spots a prop of territory k may float over (3D w.cands: its interior candidates), on the map; else its anchor. */
  _propSpots(st, k) {
    const S = this._wxS(st), out = [];
    const T = S && S.terr[k];
    if (T && Array.isArray(T.cands)) for (const d of T.cands) { const q = this._xyzScreen(st, d); if (q && this._visXY(st, q[0], q[1], 6)) out.push(q); }
    if (!out.length) {
      const { cx, cy, R } = this.view, a = st.L.anchors[k];
      if (a && this._visXY(st, cx + a[0] * R, cy + a[1] * R, 6)) out.push([cx + a[0] * R, cy + a[1] * R]);
    }
    return out;
  }

  /** Where territory k shows on the map (3D visibleAnchor): its anchor when it is on the map, else its most central spot. */
  _visAnchor(st, k) {
    const { cx, cy, R } = this.view, a = st.L.anchors[k];
    if (a && this._visXY(st, cx + a[0] * R, cy + a[1] * R, 10)) return [cx + a[0] * R, cy + a[1] * R];
    let best = null, bd = Infinity;
    for (const q of this._propSpots(st, k)) { const d = Math.hypot(q[0] - cx, q[1] - cy); if (d < bd) { bd = d; best = q; } }
    return best;
  }

  /** Planet3D._sync: a cloud floats over its market's first node under this territory (item.childAt) — real Earth only. */
  _cloudPlace(st, k, c) {
    if (!st.real || !st.childAt || !Array.isArray(c.nodes)) return null;
    const child = st.children[k];
    for (const n of c.nodes) {
      const id = n && typeof n === 'object' ? n.id : n;
      if (id == null || id === child.id || !st.childAt.has(id) || !inSubtree(child, id)) continue;
      return st.childAt.get(id);
    }
    return null;
  }

  /**
   * Planet3D._intelMap (§6 calm): what the owner fed (paste / url / claude), plus scout finds on a ①②③ or a pinned
   * territory — at most 2 per planet, one per territory, the owner's first then by strength × freshness.
   */
  _intelMap(st) {
    const pinK = new Set();
    for (const id of this.pins) { const k = this._resolveK(st, id); if (k != null) pinK.add(k); }
    const spotKs = this._spotKs(st);
    const own = (s) => s === 'paste' || s === 'url' || s === 'claude' || s === 'owner';
    const cand = this._intelItems(st).filter((it) => own(it.source) || spotKs.has(it.k) || pinK.has(it.k));
    cand.sort((a, b) => (own(b.source) ? 1 : 0) - (own(a.source) ? 1 : 0) || b.score - a.score);
    const out = [], seen = new Set();
    for (const it of cand) { if (out.length >= 2) break; if (seen.has(it.k)) continue; seen.add(it.k); out.push(it); }
    return out;
  }

  /**
   * The classic front line for territory k, as 3D (planet3d.js frontGeo): a run of its largest outline on the globe,
   * each vertex pulled 26 / 14 / 6 % toward that piece's own centre and kept on its own land (real Earth), centred on the
   * side facing the viewer — then seen on the map. Never on the sea, never through another piece.
   */
  _frontGeo(st, k) {
    const S = this._wxS(st);
    if (!S || !st.frame) return frontGeometry(st.L, k, st.win || 1, st.real ? this.view.R : 0);
    const T = S.terr[k];
    const poly = T && T.polys && T.polys.slice().sort((a, b) => b.ext.length - a.ext.length)[0];
    if (!poly || poly.ext.length < 18) return null;
    const r = poly.ext, m = r.length / 3;
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < m; i++) { ax += r[3 * i]; ay += r[3 * i + 1]; az += r[3 * i + 2]; }
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const own = (x, y, z) => !st.real || !S.ownerAt || S.ownerAt(x, y, z) === k;
    const pts = [];
    for (let i = 0; i < m; i++) {
      const x0 = r[3 * i], y0 = r[3 * i + 1], z0 = r[3 * i + 2];
      let q = null;
      for (const t of [0.26, 0.14, 0.06]) {
        let x = x0 + (ax - x0) * t, y = y0 + (ay - y0) * t, z = z0 + (az - z0) * t;
        const l = Math.hypot(x, y, z) || 1;
        x /= l; y /= l; z /= l;
        if (own(x, y, z)) { q = [x, y, z]; break; }
      }
      pts.push(q || [x0, y0, z0]);
    }
    const v = st.frame.v;
    let best = 0, bd = -2;
    pts.forEach((p, i) => { const d = p[0] * v[0] + p[1] * v[1] + p[2] * v[2]; if (d > bd) { bd = d; best = i; } });
    const half = Math.floor(m * 0.31), [e, n] = frameOf(v), Z = st.frame.Zl || 1, run = [];
    for (let i = -half; i <= half; i++) {
      const p = pts[(best + i + m) % m];
      if (p[0] * v[0] + p[1] * v[1] + p[2] * v[2] < 0.02) continue;
      run.push([(p[0] * e[0] + p[1] * e[1] + p[2] * e[2]) * Z, -(p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) * Z]);
    }
    return run.length >= 4 ? { pts: run, anchor: st.L.anchors[k] || [0, 0] } : null;
  }

  /**
   * §26 refine: the 3D 预期风 arc (planet3d/fx.js) on the globe, then seen on the map — from its place A (screen) out
   * toward open sea (away from the look point), turned 0.55 rad, (0.12 + 0.05·strength) view units long, laid on the
   * sphere (so it shortens toward the limb as in 3D). → {pts (tail → head, screen), far (the ⚡'s end), wsPx (px per
   * view unit at A)} | null. No sphere frame (a layout fallback) → the flat screen arc.
   */
  _intelArc(st, A, strength, dir) {
    const { cx, cy, R } = this.view, Zl = (st.frame && st.frame.Zl) || 1, D = st.frame && st.frame.D;
    const ws = this._windOpts(st).ws, iws = ws / Zl;
    const ll = st.frame ? this._lonLatAt(st, (A[0] - cx) / R, (A[1] - cy) / R) : null;
    const N = 26, pts = [];
    if (!ll) {
      const g = intelArcGeom(A, cx, cy, ws * R, strength);
      const [p0, p1] = dir > 0 ? [g.far, g.near] : [g.near, g.far];
      for (let i = 0; i <= N; i++) { const t = i / N, u = 1 - t; pts.push([u * u * p0[0] + 2 * u * t * g.ctrl[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * g.ctrl[1] + t * t * p1[1]]); }
      return { pts, far: g.far, wsPx: ws * R };
    }
    const an = dirOf(ll[0], ll[1]), v = st.frame.v;
    let e = [an[2], 0, -an[0]], el = Math.hypot(e[0], e[2]);
    if (el < 1e-5) { e = [1, 0, 0]; el = 1; }
    e = [e[0] / el, 0, e[2] / el];
    const n = [an[1] * e[2] - an[2] * e[1], an[2] * e[0] - an[0] * e[2], an[0] * e[1] - an[1] * e[0]];
    const c = an[0] * v[0] + an[1] * v[1] + an[2] * v[2];
    const o = [an[0] * c - v[0], an[1] * c - v[1], an[2] * c - v[2]];
    let ux = o[0] * e[0] + o[1] * e[1] + o[2] * e[2], uy = o[0] * n[0] + o[1] * n[1] + o[2] * n[2];
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-4) { ux = 0.7; uy = -0.7; } else { ux /= ul; uy /= ul; }
    const rot = 0.55, len = (0.12 + 0.05 * clamp(strength || 1, 1, 3)) * iws;
    const rx = ux * Math.cos(rot) - uy * Math.sin(rot), ry = ux * Math.sin(rot) + uy * Math.cos(rot);
    const far = [rx * len, ry * len], near = [rx * 0.025 * iws, ry * 0.025 * iws], ctrl = [ux * len * 0.75, uy * len * 0.75];
    const [s0, s1] = dir > 0 ? [far, near] : [near, far];
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const x = u * u * s0[0] + 2 * u * t * ctrl[0] + t * t * s1[0], y = u * u * s0[1] + 2 * u * t * ctrl[1] + t * t * s1[1];
      const r = Math.hypot(x, y), sk = r > 1e-12 ? Math.sin(r) / r : 1, ck = Math.cos(r);
      const q = this._xyzScreen(st, [ck * an[0] + sk * (x * e[0] + y * n[0]), ck * an[1] + sk * (x * e[1] + y * n[1]), ck * an[2] + sk * (x * e[2] + y * n[2])]);
      if (q) pts.push([q[0], q[1]]);
    }
    if (pts.length < 4) return null;
    const wsPx = iws * R * Zl * (D ? lensK(D, c) : 1);
    return { pts, far: dir > 0 ? pts[0] : pts[pts.length - 1], wsPx };
  }

  /**
   * §26 amendment 5: while the camera moves nothing important vanishes — the rest frame's weather rides on the moving
   * picture (planet/freecam2d.js _ridePicture), re-projected through the camera as 3D keeps it: the wind strokes keep
   * sliding along their lines (a little thinner), fronts, storm clouds, clouds (+ words) and intel arcs (+ ⚡) stay.
   */
  _rideWeather(ctx, rest, mv, okXY) {
    const st = rest && rest.st;
    if (!st || st !== this.cur) return;
    const now = performance.now();
    const dt = clamp((now - (this._rideT || now)) / 1000, 0, 0.05);
    this._rideT = now;
    const th = this.theme, c = this._fc && this._fc.cam;
    const { cx, cy } = this.view, R0 = this.view.R0 || this.view.R;
    const Rw = st.real ? R0 * (c ? c.zoom : 1) : R0;
    const mvOk = (x, y) => { const m = mv(x, y); return m && okXY(m[0], m[1]) ? m : null; };
    ctx.save();
    if (Rw < 4 * Math.max(this.W, this.H)) { ctx.beginPath(); ctx.arc(cx, cy, Rw, 0, Math.PI * 2); ctx.clip(); }
    if (dt > 0) {
      const band = st.band, dark = th.bandDark;
      this.particles.step(dt, st, null, (q) => dark[band[q]], Object.assign({ spotKs: this._spotKs(st) }, this._windOpts(st)));
    }
    this.particles.draw(ctx, rest.cx, rest.cy, rest.R, th, mv, 0.75);
    for (let k = 0; k < st.n; k++) {
      const g = st.frontGeo && st.frontGeo[k];
      if (!g || !st.front[k]) continue;
      const pts = [];
      for (const [x, y] of g.pts) { const m = mvOk(rest.cx + x * rest.R, rest.cy + y * rest.R); if (m) pts.push(m); }
      const an = mv(rest.cx + g.anchor[0] * rest.R, rest.cy + g.anchor[1] * rest.R);
      if (pts.length >= 4 && an) drawFront(ctx, { pts, anchor: an }, st.front[k], 0, 0, 1, th, now, 0.6 * (1 - 0.7 * st.dim[k]), false);
    }
    ctx.restore();
    this._drawStorms(ctx, now, st, new Map(), 1, mvOk);
    this._drawClouds(ctx, now, st, rest.placed || [], 1, mvOk);
    this._drawIntel(ctx, now, st, null, rest.placed || [], 1, mvOk);
  }

  // ============================================================================== drawing: weather
  _drawFronts(ctx, now, st, blink, reveal) {
    const { cx, cy, R } = this.view;
    for (let k = 0; k < st.n; k++) {
      const f = st.front[k];
      if (!f) continue;
      // §26 amendment 5 (3D): a front is a line on LAND — never on a sea area or a company dot
      const kd = st.kind ? st.kind[k] : 'land';
      if (kd === 'point' || (st.real && kd !== 'land')) continue;
      if (st.frontGeo[k] === undefined) st.frontGeo[k] = this._frontGeo(st, k);
      const active = blink.has(k);
      const a = (active ? 1 : 0.6) * reveal * (1 - 0.7 * st.dim[k]);
      drawFront(ctx, st.frontGeo[k], f, cx, cy, R, this.theme, now, a, active);
    }
  }

  _drawSpotOutlines(ctx, now, st, blink, reveal, wk = 1) {
    // (wk: the moving picture's fitted scale undone — a rim keeps its screen width while the map zooms, as 3D)
    if (!this.spot || !this.spot.length) return;
    const { cx, cy, R } = this.view;
    const th = this.theme;
    const t = now / 1000;
    ctx.save();
    this._clipWin(ctx, st);
    ctx.transform(R, 0, 0, R, cx, cy);
    ctx.lineJoin = 'round';
    for (const [k, i] of blink) {
      if (i >= 10) continue;
      // a calm breathing rim inside the territory: paper light + a hairline of ink
      const b = 0.5 + 0.5 * Math.sin(t * 2.0 + i * 2.1);
      ctx.save();
      ctx.clip(st.polyPaths[k]);
      ctx.lineWidth = (5 / R) * wk;
      ctx.strokeStyle = th.rgba(th.name === 'day' ? [255, 252, 244] : [250, 242, 224], ((0.35 + 0.35 * b) * reveal).toFixed(3));
      ctx.stroke(st.polyPaths[k]);
      ctx.restore();
      ctx.lineWidth = (1.2 / R) * wk;
      ctx.strokeStyle = th.rgba(th.name === 'day' ? th.inkRGB : [250, 242, 224], ((0.3 + 0.25 * b) * reveal).toFixed(3));
      ctx.stroke(st.polyPaths[k]);
    }
    ctx.restore();
  }

  _drawHover(ctx, st) {
    const k = this.hoverIdx;
    if (k < 0 || k >= st.n) return;
    const { cx, cy, R } = this.view;
    ctx.save();
    this._clipWin(ctx, st);
    ctx.transform(R, 0, 0, R, cx, cy);
    ctx.fillStyle = this.theme.hoverWash;
    ctx.fill(st.polyPaths[k]);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.8 / R;
    ctx.strokeStyle = this.theme.hoverLine;
    ctx.stroke(st.polyPaths[k]);
    ctx.restore();
  }

  _rainDrops(st, k) {
    const key = st.node.id + '|' + k;
    let drops = this._rain.get(key);
    if (!drops) {
      const rnd = mulberry32(hashStr(st.children[k].id));
      drops = new Float32Array(260 * 3);
      for (let j = 0; j < drops.length; j++) drops[j] = rnd();
      this._rain.set(key, drops);
      if (this._rain.size > 300) this._rain.delete(this._rain.keys().next().value);
    }
    return drops;
  }

  /** Neat short diagonal rain strokes clipped to territory k. */
  _rainIn(ctx, now, st, k, inten, alpha, color) {
    const { cx, cy, R } = this.view;
    const [x0, y0, x1, y1] = st.L.bbox[k];
    const bx = cx + x0 * R, by = cy + y0 * R, bw = (x1 - x0) * R, bh = (y1 - y0) * R;
    const areaPx = st.L.areas[k] * R * R;
    const count = Math.min(260, Math.round((areaPx / 420) * inten));
    if (count < 2) return;
    const drops = this._rainDrops(st, k);
    const t = now / 1000;
    ctx.save();
    this._clipWin(ctx, st);
    ctx.save();
    ctx.transform(R, 0, 0, R, cx, cy);
    ctx.clip(st.polyPaths[k]);
    ctx.restore();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const span = bh + 30;
    for (let j = 0; j < count; j++) {
      const u = drops[j * 3], v = drops[j * 3 + 1], sp = 0.85 + drops[j * 3 + 2] * 0.3;
      const ph = (v + (t * 150 * sp) / span) % 1;
      const y = by - 15 + ph * span;
      const x = bx + u * (bw + 24) - ph * span * 0.3;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 3, y + 9);
    }
    ctx.stroke();
    ctx.restore();
  }

  _flashState(key, now) {
    let L = this._flash.get(key);
    if (!L) {
      L = { next: now + 700 + Math.random() * 1600, start: -1, lean: 0 };
      this._flash.set(key, L);
    }
    if (L.start < 0 && now >= L.next) { L.start = now; L.lean = Math.random() - 0.5; }
    if (L.start < 0) return 0;
    const age = now - L.start;
    if (age > 240) { L.start = -1; L.next = now + 2200 + Math.random() * 3400; return 0; }
    // double flicker
    return age < 70 ? 1 : age < 110 ? 0.15 : Math.max(0, 0.9 * (1 - (age - 110) / 130));
  }

  /**
   * §26 amendment 5: the 3D storm (planet3d/fx.js) — measured 风暴 only: a dark cel cloud on a spot inside its own land
   * (never past the limb), six neat rain strokes falling from its base (18° away from the light), a flat shadow, and a
   * crisp bolt now and then when the territory is spotlit (attention budget).
   */
  _drawStorms(ctx, now, st, blink, reveal, move = null) {
    const th = this.theme, wsPx = this._windOpts(st).ws * this.view.R;
    const light = toonLight(this._camZoom(st), !!st.real).L;
    const placed = (this._wxPlaced && this._wxPlaced.st === st ? this._wxPlaced.placed : null) || [];
    for (const b of placed) {
      if (!b.storm) continue;
      let [x, y] = b.spot;
      let mk = 1;
      if (move) { const m = move(x, y); if (!m) continue; const m1 = move(x + 8, y); if (m1) mk = clamp(Math.hypot(m1[0] - m[0], m1[1] - m[1]) / 8, 0.25, 4); [x, y] = m; }
      // (3D: the storm's bob runs toward the viewer — no screen motion; it fades as its ground turns away, b.vis)
      const vis = b.vis == null ? 1 : b.vis, dim = 1 - 0.7 * st.dim[b.k];
      const a = reveal * b.fade * vis * dim, s = (b.W || b.sPx * 1.17) * mk;
      const box = drawPuff(ctx, th, this.dpr, 'storm', 0, x, y, s, a, b.edge == null || b.edge <= 0.92, light);
      if (!box && !(vis > 0.02)) continue;
      // rain: 6 strokes of equal length in 2 staggered rows under the base, falling the cloud's height (3D uFall = alt)
      ctx.save();
      ctx.strokeStyle = th.rain; // (its own alpha is 3D's L.rain.a)
      ctx.lineWidth = Math.max(1.2, 0.028 * s); // (3D uWid: 0.028 of the cloud's size)
      ctx.lineCap = 'round';
      const sl = 0.325, fall = (0.1 * wsPx + 0.2 * b.sPx) * mk, len = s * 0.17;
      const rainA = reveal * (0.4 + 0.6 * b.fade * vis) * dim * (vis > 0.02 ? 1 : 0); // (3D: rain uA × (0.4 + 0.6 · fade))
      const ROWS = [[-0.22, 0, 0.22], [-0.11, 0.11, 0.33]];
      for (let i = 0; i < 6; i++) {
        const row = i < 3 ? 0 : 1, sx = ROWS[row][i % 3] - 0.05;
        const ph = ((now / 1000) * 1.1 + row * 0.5) % 1; // (3D RAIN_VS: a row falls together, 1.1 a second)
        const y0 = y + ph * fall, x0 = x + sx * s + ph * fall * sl;
        ctx.globalAlpha = rainA * Math.sin(ph * Math.PI);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + len * sl, y0 + len);
        ctx.stroke();
      }
      ctx.restore();
      if (!move && blink.has(b.k) && b.fade > 0.6) {
        const f = this._flashState(st.node.id + '|s|' + b.k, now);
        if (f > 0) {
          ctx.save();
          ctx.globalAlpha = f * reveal;
          drawBolt(ctx, x + 0.08 * s, y + 0.06 * s, 28, th, this._flash.get(st.node.id + '|s|' + b.k).lean);
          ctx.restore();
        }
      }
    }
  }

  /** §26 amendment 5: the 3D cloud — opaque cel cloud with an ink hull on its spot, a flat shadow, its words below. */
  _drawClouds(ctx, now, st, placed, reveal, move = null) {
    const th = this.theme, wsPx = this._windOpts(st).ws * this.view.R;
    const light = toonLight(this._camZoom(st), !!st.real).L;
    for (const b of placed) {
      if (!b.cloud) continue;
      let [x, y] = b.spot;
      let mk = 1;
      if (move) { const m = move(x, y); if (!m) continue; const m1 = move(x + 8, y); if (m1) mk = clamp(Math.hypot(m1[0] - m[0], m1[1] - m[1]) / 8, 0.25, 4); [x, y] = m; }
      // (3D: a slow sideways drift; its bob runs toward the viewer, so no screen bob)
      const sd = (b.k * 0.731) % 1;
      x += Math.sin(now / 5200 + sd * 9) * 0.01 * wsPx * mk;
      const a = reveal * b.fade * (b.vis == null ? 1 : b.vis) * (1 - 0.6 * st.dim[b.k]);
      // §26 refine: the 3D puff (one of its five shapes), its size through the lens, a 1.7 / 1.5 px hull, a faint shadow
      drawPuff(ctx, th, this.dpr, 'sky', b.variant || 0, x, y, (b.W || b.w0 * 1.17) * mk, a, b.edge == null || b.edge <= 0.92, light);
      if (b.text && !this._bare) { // (§26 amendment 5: an old picture keeps no words)
        const tx = move ? x + (b.tx - b.spot[0]) : b.tx, ty = move ? y + (b.ty - b.spot[1]) : b.ty;
        ctx.save();
        ctx.font = font(10.5, 550);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = Math.min(1, reveal);
        ctx.lineWidth = 3;
        ctx.strokeStyle = th.surfHalo;
        ctx.strokeText(b.text, tx, ty);
        ctx.fillStyle = th.surfInkSoft;
        ctx.fillText(b.text, tx, ty);
        ctx.restore();
      }
    }
  }

  /**
   * §26 amendment 5 — intel as in 3D (Planet3D._intelMap + planet3d/fx.js): at most 2 stories (the owner's first, else
   * a scout find on a ①②③ / pinned territory), a dashed 预期风 arc from open sea into (or out of) the place the story is
   * about — the deeper place on the real Earth (卢拉连任 → 巴西; not drawn while that place is off the map), else the
   * territory — and a small quiet ⚡ at its far end. The words only for the hovered territory or a ①②③ territory within
   * the secondary-caption budget. No intel rain (rain = measured 风暴), no flash (only spotlit storms flash).
   */
  _drawIntel(ctx, now, st, blink, placed, reveal, move = null) {
    if (st.scenOn) return;
    const items = move ? (st.wxIntel || []) : this._intelMap(st).sort((a, b) => b.score - a.score);
    if (!move) st.wxIntel = [];
    if (!items.length) return;
    const { cx, cy, R } = this.view;
    const th = this.theme, wsPx = this._windOpts(st).ws * R;
    const spotKs = this._spotKs(st);
    const ins = this.insets;
    const ui = this._obstacles(now).concat(this._extBoxes(now));
    const hit = (b, q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y;
    const fits = (b) => b.x >= ins.left + 6 && b.y >= ins.top + 6 && b.x + b.w <= this.W - ins.right - 6 && b.y + b.h <= this.H - ins.bottom - 6
      && !placed.some((p) => !p.cloud && !p.storm && hit(b, p)) && !(this._capBoxes || []).some((q) => hit(b, q)) && !ui.some((q) => hit(b, q));
    for (const it of items) {
      let A = it.A, geo;
      if (move) {
        A = move(A[0], A[1]);
        if (!A) continue;
        const pts = [];
        for (const q of it.pts || []) { const m = move(q[0], q[1]); if (m) pts.push(m); }
        if (pts.length < 4) continue;
        geo = { pts, far: it.dir > 0 ? pts[0] : pts[pts.length - 1], wsPx: it.wsPx };
      } else {
        const dp = st.real && it.deep && it.deep.length ? deepPlace(st.children[it.k], it.deep, st.childAt) : null;
        if (dp) {
          const q = this._llScreen(st, dp.ll[0], dp.ll[1]);
          if (!q || !this._visXY(st, q[0], q[1], 14)) continue;
          A = q;
        } else A = this._visAnchor(st, it.k);
        // (3D: the arc and its ⚡ fade out as their place turns toward the limb)
        if (!A || this._facingXY(st, A[0], A[1]) < 0.3) continue;
        // §26 refine: 3D's arc on the globe — a thin dashed ribbon and a small head (no big ▶), the ⚡ at its far end
        geo = this._intelArc(st, A, it.strength, it.dir);
        if (!geo) continue;
      }
      const vis = move ? it.vis || 1 : smoothstep(0.3, 0.45, this._facingXY(st, A[0], A[1]));
      ctx.save();
      ctx.globalAlpha = reveal * vis * (move ? 0.85 : 1);
      drawIntelArc(ctx, geo.pts, it.dir, it.fresh, th, now, geo.wsPx);
      ctx.restore();
      if (move) {
        // (a pan carries the tag as it is; while the picture zooms its words step back and only the ⚡ rides)
        const m1 = move(it.A[0] + 8, it.A[1]), zk = m1 ? Math.abs(Math.log(Math.max(1e-3, Math.hypot(m1[0] - A[0], m1[1] - A[1]) / 8))) : 1;
        const spec = it.tag && it.tag.spec.text && zk > 0.06 ? intelBoltSpec((t, f) => this._tw(t, f), '', false) : it.tag && it.tag.spec;
        if (it.tag && !this._bare) drawIntelBolt(ctx, spec, geo.far[0] + it.tag.ox, geo.far[1] + it.tag.oy, th, it.tag.a * reveal * vis);
        continue;
      }
      const talk = it.k === this.hoverIdx || (spotKs.has(it.k) && this._xb > 0);
      let tag = null;
      for (const tk of talk ? [true, false] : [false]) {
        const spec = intelBoltSpec((t, f) => this._tw(t, f), it.title, tk);
        for (const [ox, oy] of [[0, 0], [0, -(spec.h + 4)], [0, spec.h + 4], [spec.w / 2 + 6, 0], [-(spec.w / 2 + 6), 0]]) {
          const b = { x: geo.far[0] + ox - spec.w / 2, y: geo.far[1] + oy - spec.h / 2, w: spec.w, h: spec.h };
          if (!fits(b)) continue;
          tag = { spec, ox, oy, b, a: tk ? 1 : 0.85, talk: tk };
          break;
        }
        if (tag) break;
      }
      if (tag) {
        // (§26 amendment 5: a crossfade's / flight's old picture keeps only the dashed arc — no words, as 3D)
        if (!this._bare) drawIntelBolt(ctx, tag.spec, geo.far[0] + tag.ox, geo.far[1] + tag.oy, th, tag.a * reveal * vis);
        placed.push(Object.assign(tag.b, { intel: true, text: tag.spec.text || '⚡' }));
        if (tag.talk && it.k !== this.hoverIdx) this._xb--;
      }
      st.wxIntel.push({ A, pts: geo.pts, wsPx: geo.wsPx, dir: it.dir, fresh: it.fresh, strength: it.strength, tag, vis });
    }
  }

  _drawScenarioFx(ctx, now, st, reveal) {
    const sc = this.ov.scenario;
    if (!sc || !st.scenOn) return;
    const { cx, cy, R } = this.view;
    const th = this.theme;
    const eps = [...new Set((Array.isArray(sc.epicenters) ? sc.epicenters : []).map((id) => this._resolveK(st, id)).filter((k) => k != null))].slice(0, 3);
    const S = this._wxS(st);
    if (S && st.frame && eps.length) { this._drawRipples3(ctx, now, st, S, eps.slice(0, 4), reveal); return; }
    ctx.save();
    this._clipWin(ctx, st);
    eps.forEach((k, i) => {
      const [ax, ay] = st.L.anchors[k];
      drawRipple(ctx, cx + ax * R, cy + ay * R, Math.min(R, this.view.R0 || R) * 0.7, th, now, i * 0.33, reveal);
    });
    ctx.restore();
    // (§26 amendment 5: no 2D-only mode tag on the bezel — 3D has none; the shell's 推演 stage bar says it)
  }

  /**
   * §26 refine: 3D's scenario ripples (planet3d/core.js plate shader, world.setScenarioUniforms) — ink rings painted on
   * the territories (never the sea), every 1/9 rad of angular distance from each epicentre (≤ 4), drifting outward
   * 0.55/9 rad a second, 32 % ink fading out by 0.75 rad; no centre dot.
   */
  _drawRipples3(ctx, now, st, S, eps, reveal) {
    const { cx, cy, R } = this.view, t = now / 1000;
    const land = new Path2D();
    for (let k = 0; k < st.n; k++) if (st.polyPaths[k] && (!st.kind || st.kind[k] === 'land')) land.addPath(st.polyPaths[k]);
    ctx.save();
    this._clipWin(ctx, st);
    ctx.save();
    ctx.transform(R, 0, 0, R, cx, cy);
    ctx.clip(land, 'evenodd'); // (the pieces never overlap; their holes stay holes)
    ctx.restore();
    ctx.strokeStyle = this.theme.ink;
    ctx.lineWidth = 1.7;
    eps.forEach((k, i) => {
      const T = S.terr[k], d0 = T && (T.anchor || (T.cands && T.cands[0]));
      if (!d0) return;
      const l = Math.hypot(d0[0], d0[1], d0[2]) || 1, d = [d0[0] / l, d0[1] / l, d0[2] / l];
      let e = [d[2], 0, -d[0]], el = Math.hypot(e[0], e[2]);
      if (el < 1e-5) { e = [1, 0, 0]; el = 1; }
      e = [e[0] / el, 0, e[2] / el];
      const n = [d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]];
      const base = (((0.55 * t + (i + 1) * 0.37) % 1) + 1) % 1;
      for (let j = 0; ; j++) {
        const dd = (j + base) / 9;
        if (dd > 0.75) break;
        const a = 0.32 * (1 - smoothstep(0.2, 0.75, dd)) * reveal;
        if (a < 0.01) continue;
        const cr = Math.cos(dd), sr = Math.sin(dd), path = new Path2D();
        let pen = false;
        for (let q = 0; q <= 72; q++) {
          const th = (q / 72) * Math.PI * 2, c = Math.cos(th) * sr, s2 = Math.sin(th) * sr;
          const p = this._xyzScreen(st, [cr * d[0] + c * e[0] + s2 * n[0], cr * d[1] + c * e[1] + s2 * n[1], cr * d[2] + c * e[2] + s2 * n[2]]);
          if (!p) { pen = false; continue; }
          if (pen) path.lineTo(p[0], p[1]); else path.moveTo(p[0], p[1]);
          pen = true;
        }
        ctx.globalAlpha = a;
        ctx.stroke(path);
      }
    });
    ctx.restore();
  }

  _drawChannel(ctx, now, st, chan, placed, reveal) {
    if (!chan || !chan.curve) return;
    const t0 = (st.scenOn && st.scenT0 ? Math.max(st.revealT0, st.scenT0) : st.revealT0) + 250;
    const prog = easeInOutCubic(clamp((now - t0) / 900, 0, 1));
    const cap = placed.find((b) => b.chan);
    // §26 amendment 5: 3D's arc — the great circle between the money places (planet/names2d.js _chanGeom), the 3D tube's
    // proportions; a second destination's thinner branch from the same take-off
    const tube = { R0: this.view.R0 || this.view.R };
    // (final: 3D's take-off pad and landing ripple on the ground, under the ribbon — names2d _chanRipples)
    if (this._chanRipples) this._chanRipples(ctx, chan, this._lf(st), now, reveal, prog >= 0.999, prog >= 0.999, this._fc && this._fc.cam ? this._fc.cam.zoom : 1);
    if (chan.branch) drawChannel(ctx, chan.branch, this.theme, this.view.R, now, prog * reveal, null, null, Infinity, { R0: tube.R0, rf: 0.62 });
    drawChannel(ctx, chan.curve, this.theme, this.view.R, now, prog * reveal, null, null, Infinity, tube);
    if (cap && !this._bare) drawChannelCaption(ctx, cap.spec, cap.x, cap.y, this.theme, smoothstep(0.55, 1, prog) * reveal, cap.ax != null ? [cap.ax, cap.ay] : null);
  }

  // ============================================================================== labels
  _tw(text, f) {
    const key = f + '|' + text;
    let w = this._textW.get(key);
    if (w == null) {
      this.ctx.font = f;
      w = this.ctx.measureText(text).width;
      if (this._textW.size > 3000) this._textW.clear();
      this._textW.set(key, w);
    }
    return w;
  }

  /**
   * §26 amendment 5: the word layer in 3D's order (planet3d/labels.js update) — the 主航道 (arc + caption), the ①②③
   * cards, company clusters, the names (metro columns, the 主航道's ends, unit-suffix names, twins), then clouds, part
   * names and city names (planet/names2d.js). Returns the placed word boxes; the cards land in this._caps.
   */
  _layoutLabels(ctx, st, chan) {
    const now = performance.now();
    // (refine-names: the moment the picture came to rest — 3D labels' _settleT: card picks made before it are re-scored)
    if (this._laySt !== st || now - (this._layT || 0) > 150) this._settleT = now;
    // (a new sphere — a new unit level / raster, 3D's _reask world — starts its cards' history afresh, as 3D's new labels do)
    if (this._laySt !== st && (!this._laySt || this._laySt.S !== st.S)) this._sticky.clear();
    this._laySt = st; this._layT = now;
    const capList = this._captionList(st);
    this._capK = new Map(capList.map((c) => [c.k, String(c.s.why || '')]));
    // the shell's UI (gauges, holdings, pins, since-line, the hero ring, camera controls): words never go there.
    // (refine-names, one rule with 3D: the shell's 主航道 card is NOT one of them — it is placed after the words and keeps
    // off them (placeCaption), so the picture never depends on which of the two happened to land first)
    const ui = this._obstacles(now).filter((q) => q.id !== 'hero-cap' && q.id !== 'hero-ring');
    // (refine-names, one rule with 3D: the shell's 主航道 ring is known from the first frame — the place and the size the
    // shell gives it (main.js heroTick) — so the cards' first picks already keep off it, wherever the DOM ring is yet)
    const hr = this.heroId && st.idxOf.has(this.heroId) ? this._restRect(st, this.heroId) : null;
    if (hr && Number.isFinite(hr.cx)) {
      const rc = this.canvas.getBoundingClientRect(), Rr = clamp(Math.min((hr.r || 60) * 0.42, hr.width * 0.32, hr.height * 0.32), 22, 46);
      ui.push({ id: 'hero-ring', x: hr.cx - rc.left - Rr - 6, y: hr.cy - rc.top - Rr - 6, w: 2 * Rr + 12, h: 2 * Rr + 12 });
    }
    const ovl = (b, q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y;
    const uiHit = (b) => ui.some((q) => ovl(b, q));
    const fa = this._freeArea();
    const E = { x0: fa.x0 + 10, y0: fa.y0 + 10, x1: fa.x1 - 10, y1: fa.y1 - 10 };
    const LF = this._lf(st);
    if (st.points && st.points.length) this._ptLayout(st);
    const placed = [];
    const hard = []; // not words, but words keep off them: the arc, the cards, a cluster's fan
    const fits = (b) => b.x >= fa.x0 + 6 && b.y >= fa.y0 + 6 && b.x + b.w <= fa.x1 - 6 && b.y + b.h <= fa.y1 - 6 &&
      !placed.some((q) => ovl(b, q)) && !hard.some((q) => ovl(b, q)) && !uiHit(b);
    const area = (b, q) => Math.max(0, Math.min(b.x + b.w, q.x + q.w) - Math.max(b.x, q.x)) * Math.max(0, Math.min(b.y + b.h, q.y + q.h) - Math.max(b.y, q.y));
    /** how bad a spot that does not fit is: cards and names weigh most, the arc less, off the free screen worst */
    const cost = (b) => {
      let c = b.x < fa.x0 + 6 || b.y < fa.y0 + 6 || b.x + b.w > fa.x1 - 6 || b.y + b.h > fa.y1 - 6 ? 1e7 : 0;
      for (const q of placed) c += area(b, q) * (q.it ? 4 : 1.5);
      for (const q of hard) c += area(b, q) * (q.arc ? 0.6 : q.cap ? 4 : 1.5);
      for (const q of ui) c += area(b, q) * 3;
      return c;
    };
    const overlaps = (b) => placed.some((q) => ovl(b, q)) || hard.some((q) => !q.arc && ovl(b, q));
    // company markers (their fanned dots) — floating captions never sit on them
    const marks = (st.pt || []).filter((p) => p.vis).map((p) => ({ x: p.tx - p.r - 3, y: p.ty - p.r - 3, w: 2 * p.r + 6, h: 2 * p.r + 6 }));
    const onMark = (b) => marks.some((q) => ovl(b, q));
    // ---- the 主航道 first: its caption, then its body, head and both ends are obstacles for every word
    let arcPx = [];
    if (chan) {
      this._chanGeom(st, chan, LF);
      if (chan.curve) {
        // (refine-names, 3D's order: the arc's boxes first, then its caption — hung on the arc's top point by 3D's
        // callout, never hugging the ribbon on its own side rule)
        hard.push(...this._chanBoxes(chan));
        const spec = channelCaptionSpec((t, f) => this._tw(t, f), ctx, chan.say);
        const cap = this._placeChanCap(st, chan, spec, LF, { fits, cost, ui, E });
        if (cap) placed.push(Object.assign(cap, { chan: true, spec }));
        arcPx = chan.curve.pts.filter((_, i) => i % 4 === 0).concat(chan.branch ? chan.branch.pts.filter((_, i) => i % 4 === 0) : []);
      }
    }
    const specs = this._nameSpecs(st, chan);
    const env = { placed, hard, fits, cost, ui, E, arcPx, chan };
    // ---- ①②③ cards, company clusters, names
    env.twin = this._layoutCards(st, capList, specs, LF, env);
    this._capBoxes = (this._caps || []).map((c) => ({ x: c.x - 4, y: c.y - 4, w: c.w + 8, h: c.h + 8 }));
    env.inClu = this._layoutClusters(st, specs, LF, env);
    this._layoutNames(st, specs, LF, env);
    this._labels = placed.filter((b) => b.it && b.it.k >= 0 && b.spec && b.spec.kind !== 'part');
    this._chanObs = chan && chan.pts ? chan : null;
    this._chanBox = placed.find((b) => b.chan) || null;
    // ---- clouds (their own rules), then the quiet layers: part names, city names
    this._layoutClouds(st, placed, overlaps, { uiHit, onMark });
    this._cloudBoxes = placed.filter((b) => b.cloud);
    this._layoutParts(st, specs, LF, env);
    this._layoutCities(st, LF, env);
    return placed;
  }

  /**
   * How much a screen box covers places that matter (per 1000 px²): territories (heavy) and land (light); the sea
   * and the sky are free. Same rule as the 3D cards (planet3d/labels.js _groundPen).
   */
  _groundPen(st, b, wT = 3, wL = 0.4, wS = 0, own = -9, nx = 4, ny = 3) {
    // (refine-names: what lies under each sample is read exactly as 3D's labels._groundAt does — the screen point back
    // onto the sphere through this frame's lens, the sphere's own raster: territory k / sea / unclaimed land / sky)
    if (st.S && st.frame && this._groundAt) {
      let t = 0, l = 0, sea = 0;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const g = this._groundAt(st, b.x + ((i + 0.5) / nx) * b.w, b.y + ((j + 0.5) / ny) * b.h);
        if (g === own) continue; else if (g >= 0) t++; else if (g === -2) l++; else if (g === -1) sea++;
      }
      const n = nx * ny;
      return ((b.w * b.h) / 1000) * (wT * (t / n) + wL * (l / n) + wS * (sea / n));
    }
    const { cx, cy, R } = this.view, L = st.L;
    let t = 0, l = 0, sea = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      const c = cellAt((b.x + ((i + 0.5) / 4) * b.w - cx) / R, (b.y + ((j + 0.5) / 3) * b.h - cy) / R);
      if (c < 0 || !L.inside[c]) continue;
      const o = L.owner[c];
      if (o >= 0 && o === own) continue; // (wS / own — §26 amendment 5, as 3D: a name keeps off the sea, its own land is free)
      if (o >= 0 && (!st.kind || st.kind[o] !== 'sea')) t++; else if (L.neutral && L.neutral[c]) l++; else sea++;
    }
    return ((b.w * b.h) / 1000) * (wT * (t / 12) + wL * (l / 12) + wS * (sea / 12));
  }

  /**
   * Short map caption for a cloud: drop the "预言市场：" prefix and the "等 N 个盘口" tail, keep the
   * probability and its weekly swing, and trim the question to fit (the full text belongs in the panel).
   */
  _cloudLabel(t) {
    const MAXW = 196, f = font(11, 600);
    let s = t.replace(/^\s*预言市场[：:]\s*/, '').replace(/\s*等\s*\d+\s*个?盘口\s*$/, '').trim();
    s = s.replace(/（\s*一周\s*([+\-−]?\d+(?:\.\d+)?)\s*个?点?\s*）/, '（周 $1）');
    // the deadline is the least informative part on a map caption ("美国会在11月30日前进口俄罗斯柴油吗" →
    // "美国会进口俄罗斯柴油吗"): drop it so a trimmed caption still says WHAT the market is about
    s = s.replace(/在\s*(?:\d{4}\s*年)?\s*(?:\d{1,2}\s*月)?\s*(?:\d{1,2}\s*日)?\s*(?:底)?\s*(?:之|以)?前/g, (m) => (/\d/.test(m) ? '' : m))
      .replace(/^\s*\d{4}\s*年\s*(?:底)?\s*(?:(?:之|以)?前)?\s*/, '')
      .replace(/^\s*\d{1,2}\s*月\s*(?:\d{1,2}\s*日)?\s*(?:底)?\s*(?:之|以)?前\s*/, '')
      .replace(/吗([？?])/, '$1').trim();
    if (this._tw(s, f) <= MAXW) return s;
    const m = s.match(/^(.*?)(\s*\d+(?:\.\d+)?%\s*(?:（[^）]*）)?)\s*$/);
    let q = m ? m[1] : s, tail = m ? m[2].trim() : '';
    if (tail && this._tw(tail, f) > MAXW - 30) tail = tail.replace(/（[^）]*）/, '');
    const room = MAXW - (tail ? this._tw(' ' + tail, f) : 0);
    const chars = Array.from(q.replace(/[？?]\s*$/, ''));
    while (chars.length > 1 && this._tw(chars.join('') + '…', f) > room) chars.pop();
    return chars.join('') + '…' + (tail ? ' ' + tail : '');
  }

  /**
   * §26 amendment 5 — Polymarket clouds and storm clouds as in 3D (Planet3D._sync / _placeClouds), after the names:
   * one cloud per territory, the first in the shell's order; on the real Earth it floats over the place its market is
   * about (its first node under that territory, item.childAt), else over a spot inside its own land; labels always win —
   * it glides to a nearby spot clear of names, cards and captions, or fades to 0.16 under them. Strength changes its size.
   * Words (§6 secondary-caption budget, as 3D): at most one unasked caption, only for a ①②③ territory and only while
   * ①②③ + 主航道 < 4 (水位 news takes it first) — or the hovered territory's. Storm clouds (measured 风暴 only) use the
   * same spots, never past the limb.
   */
  _layoutClouds(st, placed, overlaps, { uiHit, onMark }) {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - (this._wxT || now)) / 1000));
    this._wxT = now;
    const { R } = this.view;
    const ws = this._windOpts(st).ws, wsPx = ws * R;
    if (!st.wxPos) { st.wxPos = new Map(); st.wxTgt = new Map(); st.wxFade = new Map(); }
    // the secondary-caption budget
    const spotKs = this._spotKs(st);
    // (final, one rule with 3D's L.chanOn = !!chan: a 主航道 with any part on the map counts, its caption placed or not)
    const chanOn = placed.some((b) => b.chan) || !!this._chanObs;
    let budget = spotKs.size + (chanOn ? 1 : 0) < 4 ? 1 : 0;
    const lq = this.ov.liquidity;
    this._liqTalk = false;
    if (lq && !this.transition && this._globe().fade >= 0.5) {
      const news = !!lq.fresh || lq.state !== '平稳' || Math.abs(+lq.pressure || 0) >= 1.5;
      if (news && (budget > 0 || lq.fresh)) { this._liqTalk = true; budget = Math.max(0, budget - 1); }
    }
    // what a prop keeps clear of: names, the 主航道 caption, the ①②③ cards, the shell's UI
    const rects = placed.filter((b) => !b.cloud && !b.storm).concat(this._capBoxes || []);
    // the 主航道 (and its branch): ~12 padded boxes along the arc, the head included (3D _placeClouds)
    const ch = this._chanObs;
    if (ch && ch.curve) {
      const pad = 10 + (ch.tube || 6) * 0.5;
      for (const c of [ch.curve, ch.branch].filter(Boolean)) for (let i = 0; i <= 12; i++) { const q = curvePt(c, i / 12); rects.push({ x: q[0] - pad, y: q[1] - pad, w: 2 * pad, h: 2 * pad }); }
    }
    // §26 refine: the place a ①②③ card points at (3D labels.js: its anchor dot is a placed box) and a tiny territory's
    // ring are never under a cloud either; past the free screen (the shell's panel and bars) counts as the shell's UI
    for (const c of this._caps || []) if (Number.isFinite(c.ax) && Number.isFinite(c.ay)) { const h = c.edge ? 9 : 8; rects.push({ x: c.ax - h, y: c.ay - h, w: 2 * h, h: 2 * h }); }
    if (st.real && st.um && st.um.tiny) for (const k of st.um.tiny) {
      const a = this._tinyXY(st, k);
      if (a) rects.push({ x: a[0] - 14, y: a[1] - 14, w: 28, h: 28 });
    }
    const fa = this._freeArea();
    const offFree = (r) => r.x0 < fa.x0 + 2 || r.y0 < fa.y0 + 2 || r.x1 > fa.x1 - 2 || r.y1 > fa.y1 - 2;
    const ovl = (r, list = rects) => {
      let o = 0;
      for (const q of list) { const ix = Math.min(r.x1, q.x + q.w) - Math.max(r.x0, q.x), iy = Math.min(r.y1, q.y + q.h) - Math.max(r.y0, q.y); if (ix > 2 && iy > 2) o += ix * iy; }
      return o;
    };
    // (a later cloud prefers a spot clear of the clouds placed before it — two markets on one city never stack)
    const cloudRects = [];
    const props = [];
    const seen = new Set();
    for (const c of Array.isArray(this.ov.clouds) ? this.ov.clouds : []) {
      if (!c) continue;
      const k = this._resolveK(st, c.id);
      if (k == null || seen.has(k)) continue;
      seen.add(k);
      // (3D fx.sync: the puff shape geos[(k·7 + i) % 5], i = its place in the cloud list)
      props.push({ key: 'c' + k, k, c, strength: clamp(+c.strength || 0, 0, 1), place: this._cloudPlace(st, k, c), variant: (k * 7 + props.length) % CLOUD_VARIANTS });
    }
    if (!st.scenOn) for (let k = 0; k < st.n; k++) if (st.to.storm[k] >= 0.8) props.push({ key: 's' + k, k, storm: st.to.storm[k] });
    const live = new Set();
    const D = st.frame && st.frame.D, Zl = (st.frame && st.frame.Zl) || 1;
    for (const o of props) {
      const r3 = this._propR(st, o.k);
      const size = o.storm != null
        ? clamp(r3 * 0.75, 0.1 * ws, 0.27 * ws) * (0.85 + 0.15 * clamp(o.storm - 0.8, 0, 1.5))
        : clamp(r3 * 0.62, 0.1 * ws, 0.24 * ws) * (0.8 + 0.35 * o.strength);
      const sPx = size * R;
      // §26 refine: drawn as 3D draws it — the prop floats alt above its spot toward the camera, so the 3D lens shows it
      // s / (D − facing − alt) × its size (≈ 1.17× at the middle of the view); its box is the drawn shape
      const alt = (0.1 * ws + (o.storm != null ? 0.2 : 0.25) * size) / Zl;
      const kind = o.storm != null ? 'storm' : 'sky', vr = o.variant || 0;
      const drawW = (p) => sPx * (D ? Math.sqrt(D * D - 1) / Math.max(0.5, D - this._facingXY(st, p[0], p[1]) - alt) : 1);
      let list;
      if (o.place) {
        const q = this._llScreen(st, o.place[0], o.place[1]);
        if (!q || !this._visXY(st, q[0], q[1], 4)) continue; // its place is off the map
        list = [q];
        for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; list.push([q[0] + Math.cos(a) * 0.05 * wsPx, q[1] + Math.sin(a) * 0.05 * wsPx]); }
      } else list = this._propSpots(st, o.k);
      const rectAt = (p) => {
        const bx = puffBox(kind, vr, drawW(p));
        // (a storm's rain below its base belongs to it too — 3D propRect: half its size)
        return { x0: p[0] + bx.x0, x1: p[0] + bx.x1, y0: p[1] + bx.y0, y1: p[1] + (o.storm != null ? Math.max(bx.y1, 0.5 * sPx) : bx.y1) };
      };
      let best = null, bestS = Infinity, bestO = Infinity;
      const tryAt = (p, bias) => {
        if (!this._visXY(st, p[0], p[1], 4)) return;
        // (3D: a prop over a place turned away is not shown; past 0.85 of the disc it would float off the globe)
        const f = this._facingXY(st, p[0], p[1]);
        if (f < 0.4) return;
        const fr = Math.sqrt(1 - f * f);
        const r = rectAt(p);
        const ov = ovl(r) + (uiHit({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }) || offFree(r) ? 1e5 : 0);
        const sc = ov + bias + (fr > 0.85 ? 8e4 * (fr - 0.85) : 0) + 0.5 * ovl(r, cloudRects);
        if (sc < bestS) { bestS = sc; bestO = ov; best = p; }
      };
      const tg = st.wxTgt.get(o.key);
      if (tg) tryAt(tg, -1); // keep the current spot while it stays clear (no jitter)
      if (bestS > 0) for (const p of list) { tryAt(p, 0); if (bestS <= 0) break; }
      if (!best) continue;
      st.wxTgt.set(o.key, best);
      let pos = st.wxPos.get(o.key);
      if (!pos || !this._visXY(st, pos[0], pos[1], -40)) pos = best.slice();
      else { const a = 1 - Math.exp(-dt * 4); pos = [pos[0] + (best[0] - pos[0]) * a, pos[1] + (best[1] - pos[1]) * a]; }
      st.wxPos.set(o.key, pos);
      const target = bestO > 0 ? 0.16 : 1;
      const f0 = st.wxFade.has(o.key) ? st.wxFade.get(o.key) : target;
      const fade = f0 + (target - f0) * (1 - Math.exp(-dt * 7));
      st.wxFade.set(o.key, fade);
      live.add(o.key);
      // (3D: o.vis — a prop whose ground turns toward the limb fades out; no ground shadow near the rim, o.edge > 0.92)
      const fP = this._facingXY(st, pos[0], pos[1]), rP = rectAt(pos);
      const b = { x: rP.x0, y: rP.y0, w: rP.x1 - rP.x0, h: rP.y1 - rP.y0, k: o.k, key: o.key, spot: pos, sPx, fade, seed: o.k + 1, text: '',
        variant: vr, W: drawW(pos), vis: smoothstep(0.3, 0.5, fP), edge: Math.sqrt(Math.max(0, 1 - fP * fP)) };
      if (o.storm != null) { b.storm = true; b.stormV = o.storm; placed.push(b); continue; }
      b.cloud = true; b.sgt = o.strength; b.w0 = sPx;
      placed.push(b);
      cloudRects.push(b);
      // its words: the hovered territory's, or a ①②③ territory's within the budget (3D labels.js cloudLabs)
      const lab = String(o.c.label || o.c.tip || '');
      const hov = o.k === this.hoverIdx;
      // (final, one rule with 3D labels.js cloudLabs: no words while the cloud's ground turns toward the limb, vis < 0.6)
      if (!lab || !(hov || (spotKs.has(o.k) && budget > 0)) || fade < 0.6 || b.vis < 0.6) continue;
      const text = lab.length > 22 ? lab.slice(0, 21) + '…' : lab;
      const f = font(10.5, 550), tw = this._tw(text, f) + 4, th = 14, cw = Math.max(16, b.w / 2 + 1); // (beside the drawn cloud)
      for (const [ox, oy] of [[0, 5 + th / 2], [cw + tw / 2, -th * 0.2], [-(cw + tw / 2), -th * 0.2], [0, 12 + th]]) {
        const t = { x: pos[0] + ox - tw / 2, y: pos[1] + oy - th / 2, w: tw, h: th };
        // (halo words may run past the limb onto the paper, as 3D's — but stay on the free screen)
        const fa = this._freeArea();
        if (t.x < fa.x0 + 4 || t.y < fa.y0 + 4 || t.x + t.w > fa.x1 - 4 || t.y + t.h > fa.y1 - 4) continue;
        if (overlaps(t) || uiHit(t) || onMark(t) || ovl({ x0: t.x, x1: t.x + t.w, y0: t.y, y1: t.y + t.h }) > 0) continue;
        b.text = text; b.tx = pos[0] + ox; b.ty = pos[1] + oy;
        placed.push(Object.assign(t, { cloudText: true, k: o.k }));
        rects.push(t);
        if (!hov) budget--;
        break;
      }
    }
    for (const key of [...st.wxPos.keys()]) if (!live.has(key)) { st.wxPos.delete(key); st.wxTgt.delete(key); st.wxFade.delete(key); }
    this._xb = budget; // (what is left for the intel words, _drawIntel)
    this._wxPlaced = { st, placed };
  }

  /** Names. move(b) → [dx, dy] | null shifts a rest-frame label with its place (the moving picture). */
  _drawLabels(ctx, st, placed, reveal, move = null) {
    if (this._bare) return; // (§26 amendment 5: a crossfade's old picture carries no words — as 3D)
    // §26 amendment 5: names, part names, city names and cluster callouts as 3D draws them (planet/names2d.js _drawWord)
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    for (const b0 of placed) {
      if (!b0.it || !b0.spec || !b0.spec.kind) continue;
      let ox = 0, oy = 0;
      if (move) { const d = move(b0); if (!d) continue; ox = d[0]; oy = d[1]; }
      const b = move ? Object.assign({}, b0, { x: b0.x + ox, y: b0.y + oy }) : b0;
      const it = move ? Object.assign({}, b0.it, { ax: b0.it.ax + ox, ay: b0.it.ay + oy }) : b0.it;
      const k = it.k;
      const a = reveal * (k >= 0 && b0.spec.kind !== 'clu' ? 1 - 0.62 * (st.dim[k] || 0) + (b0.spec.dim ? 0.62 * (st.dim[k] || 0) : 0) : 1);
      if (a <= 0.01) continue;
      this._drawWord(ctx, st, b, it, a);
    }
    ctx.restore();
  }

  /** §26 real: is the ground under a screen point a dark weather colour (paper knock-out text)? Exact territory. */
  _darkAt(st, x, y) {
    const { cx, cy, R } = this.view;
    const key = `${Math.round(x)}|${Math.round(y)}|${R.toFixed(1)}`;
    const memo = st._darkMemo || (st._darkMemo = new Map());
    let k = memo.get(key);
    if (k === undefined) {
      const lx = (x - cx) / R, ly = (y - cy) / R, c = cellAt(lx, ly);
      k = this._hitExact(st, lx, ly, c >= 0 ? st.L.owner[c] : -1);
      if (memo.size > 400) memo.clear();
      memo.set(key, k);
    }
    if (k < 0 || st.kind[k] !== 'land') return false;
    const T = st.cur.temp[k];
    return this.theme.bandDark[bandOf(clamp(Number.isFinite(T) ? T : 0, -3, 3))] === 1;
  }

  /** The rest frame's 主航道 redrawn with its places moved (the moving picture). */
  _rideChannel(ctx, st, chan, A, B, mv, LFlive = null) {
    const cap = this._rest && this._rest.placed.find((b) => b.chan);
    const tube = { R0: this.view.R0 || this.view.R };
    // (§26 amendment 5: the arc is a polyline on the sphere — each of its points rides with the map; the longest run
    // still on the map is drawn)
    const ride = (c) => {
      let run = [], best = [];
      for (const p of c.pts) {
        const m = mv(p[0], p[1]);
        if (m) run.push(m); else { if (run.length > best.length) best = run; run = []; }
      }
      if (run.length > best.length) best = run;
      return best.length >= 2 ? channelPoly(best) : null;
    };
    // (integrator: with the live lens at hand the arc is re-drawn from its sphere ends — names2d _chanLive — so a zoom
    // glide neither stretches nor folds it; else the rest frame's points ride)
    const live = LFlive && chan.curve ? this._chanLive(chan, LFlive) : null;
    const main = live ? live.curve : ride(chan.curve);
    if (!main) return;
    // (integrator: a route too short to draw — two places in one city — still keeps its caption while the map moves, as
    // at rest; it used to vanish on every drag)
    if (main.len >= 12) {
      const br = live ? live.branch : chan.branch ? ride(chan.branch) : null;
      if (live && this._chanRipples) this._chanRipples(ctx, chan, LFlive, performance.now(), 1, true, !!(br && br.len > 20), this._fc && this._fc.cam ? this._fc.cam.zoom : 1);
      if (br && br.len > 20) drawChannel(ctx, br, this.theme, this.view.R, performance.now(), 1, null, null, Infinity, { R0: tube.R0, rf: 0.62 });
      drawChannel(ctx, main, this.theme, this.view.R, performance.now(), 1, null, null, Infinity, tube);
    }
    if (cap) {
      // (refine-names: the caption rides with the arc point it hangs from, its leader too)
      const o = cap.ax != null ? [cap.ax, cap.ay] : chan.curve.apex;
      let m = mv(o[0], o[1]);
      if (live && main.pts.length === chan.curve.pts.length) {
        // (the live arc: the same point along it — the rest point is lifted off the ground, so mv alone drifts)
        const P0 = chan.curve.pts;
        let bi = 0, bd = Infinity;
        for (let i = 0; i < P0.length; i++) { const d = (P0[i][0] - o[0]) ** 2 + (P0[i][1] - o[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
        m = main.pts[bi];
      }
      const dx = m ? m[0] - o[0] : main.apex[0] - o[0], dy = m ? m[1] - o[1] : main.apex[1] - o[1];
      drawChannelCaption(ctx, cap.spec, cap.x + dx, cap.y + dy, this.theme, 1, m && cap.ax != null ? m : null);
    }
  }

  /** 挤 / 空 markers: §26 amendment 5 — drawn inline before the name (as 3D), never as a separate stamp. */
  _drawMarkers() {}

  /** Spotlight captions (≤ 3): the ①②③ cards laid out with the words (_layoutLabels → names2d _layoutCards), painted here. */
  _drawCaptions(ctx, now, st, placed, reveal) {
    if (this._bare) return; // (§26 amendment 5)
    const caps = this._caps || [];
    if (!caps.length) return;
    this._paintCaptions(ctx, st, caps, reveal * smoothstep(0, 500, now - st.revealT0));
  }

  /** Draw ①②③ cards (+ leaders). move(x, y) → [x', y'] | null re-projects the anchors (the moving picture). */
  _paintCaptions(ctx, st, caps, a, move = null) {
    this._paintCards(ctx, st, caps, a, move);
  }

  /** A real place (lon, lat) on this state's map, canvas px — or null when it is on the far side. */
  _llScreen(st, lon, lat, cut = null) {
    if (!st || !st.frame) return null;
    const d = dirOf(lon, lat), v = st.frame.v, [e, n] = frameOf(v), D = st.frame.D;
    const z = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
    if (z < (cut != null ? cut : (D ? lensVis(D) : 0) + 0.02)) return null; // (cut: a caller's own horizon — the shell's rect)
    const { cx, cy, R } = this.view, k = R * st.frame.Zl * (D ? lensK(D, z) : 1);
    return [cx + (d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) * k, cy - (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) * k];
  }

  // ============================================================================== §26 shell cards (placeCaption)
  /**
   * A free spot for one of the shell's floating cards (the 主航道 hero pin #hero-cap, CSS px size {w, h}) near
   * territory `id`, by the same score as the ①②③ cards: off company names / markers / labels / cards / clouds / the
   * 主航道 caption / the shell's UI, never on a dense cluster, preferably over open water, a little above the place
   * (opts.ring: the shell's ring radius around the place, kept clear). Returns {x, y} (client px, top-left) or null
   * (no such place on the map now, or the camera moves). The planet keeps its own words off that box for ~½ s and
   * draws a hairline from the place to it.
   */
  placeCaption(id, size = {}, opts = {}) {
    const st = this.cur;
    if (!st || this.transition) return null;
    if (this._fc && this._fc.moving()) {
      // §26 refine: the card rides with its place while the camera moves (its resting spot, carried by liveXY)
      const e = this._ext;
      if (!e || e.id !== id || !this._fc.liveXY) return null;
      const m = this._fc.liveXY(e.ax, e.ay);
      if (!m) return null;
      const rect = this.canvas.getBoundingClientRect();
      e.t = performance.now();
      return { x: rect.left + e.box.x + (m[0] - e.ax), y: rect.top + e.box.y + (m[1] - e.ay) };
    }
    // the planet's own ①②③ cards land first (open item 4: the shell's card waits instead of covering one)
    if (performance.now() - (st.revealT0 || 0) < 600) return null;
    const r = this.getChildScreenRect(id);
    if (!r) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ax = r.cx - rect.left, ay = r.cy - rect.top;
    if (!this._visXY(st, ax, ay, 0)) return null;
    const w = Math.max(40, +size.w || 220), h = Math.max(16, +size.h || 34);
    const ring = clamp(+opts.ring || 0, 0, 80);
    const now = performance.now();
    const key = 'ext:' + id + '|' + Math.round(w / 8) + 'x' + Math.round(h / 4);
    // §26 amendment 5: 3D's cost model (planet3d.js placeCaption) — the card stands beside the ring (6 per px of
    // distance, the first good ring of spots wins), up first; off the planet's cards (most), names, markers, clouds,
    // the 主航道 caption and the shell's other UI; rather over open water than over the territories it talks about
    const prev = this._ext && this._ext.key === key ? this._ext : null;
    if (prev && Math.hypot(prev.ax - ax, prev.ay - ay) < 2.5 && now - (prev.scoredAt || 0) < 700) {
      prev.t = now;
      return { x: rect.left + prev.box.x, y: rect.top + prev.box.y };
    }
    // (refine-names: literally 3D's list — its labels.rects: names / clusters ±6 at 2.2, the ①②③ cards' callout boxes
    // (card ±3) ±6 at 8; no cloud, no 主航道 caption — then markers, the shell's other UI and the ring)
    const hard = [];
    for (const b of this._labels || []) hard.push({ x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12, wt: this._capK && this._capK.has(b.it.k) ? 8 : 2.2 }); // (3D: a ①②③ territory's rect — its twin name too — weighs 8)
    for (const c of this._caps || []) hard.push({ x: c.x - 9, y: c.y - 9, w: c.w + 18, h: c.h + 18, wt: 8 });
    for (const p of st.pt || []) if (p.vis) hard.push({ x: p.tx - p.r - 4, y: p.ty - p.r - 4, w: 2 * p.r + 8, h: 2 * p.r + 8, wt: 1.5 });
    for (const q of this._obstacles(now, ['hero-cap', 'hero-ring'])) hard.push(Object.assign({ wt: 6 }, q));
    if (ring) hard.push({ x: ax - ring - 4, y: ay - ring - 4, w: 2 * ring + 8, h: 2 * ring + 8, wt: 8 });
    const fa = this._freeArea();
    const cost = (x, y) => {
      let c = x < fa.x0 + 8 || y < fa.y0 + 8 || x + w > fa.x1 - 8 || y + h > fa.y1 - 8 ? 1e7 : 0;
      for (const q of hard) {
        const ox = Math.min(x + w, q.x + q.w) - Math.max(x, q.x), oy = Math.min(y + h, q.y + q.h) - Math.max(y, q.y);
        if (ox > 0 && oy > 0) c += ox * oy * q.wt;
      }
      if (c < 1e6) c += 40 * this._groundPen(st, { x, y, w, h }, 3, 0.4, 0, -9, 5, 2); // (3D samples 5 × 2)
      return c;
    };
    let best = null;
    const gaps = [ring + 10, ring + 26, ring + 46, ring + 72, ring + 104, ring + 142];
    for (const g of gaps) {
      for (let i = 0; i < 16; i++) {
        const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 8); // up first, then fanning down
        const ca = Math.cos(a), sa = Math.sin(a);
        const x = ax + ca * (g + (w / 2) * Math.abs(ca)) - w / 2, y = ay + sa * (g + (h / 2) * Math.abs(sa)) - h / 2;
        const c = cost(x, y) + g * 6 + (sa > 0.3 ? 900 : 0) + i * 20;
        if (!best || c < best.c) best = { x, y, c };
      }
      if (best && best.c < (g + 30) * 6 + 400) break; // a free spot this close: no need to go farther
    }
    // hysteresis: the last spot stays while it is (nearly) as good
    if (prev) {
      const x = ax + (prev.box.x - prev.ax), y = ay + (prev.box.y - prev.ay);
      const g = Math.max(0, Math.hypot(x + w / 2 - ax, y + h / 2 - ay) - Math.max(w, h) / 2);
      const c = cost(x, y) + g * 6;
      if (c <= best.c + 600) best = { x, y, c };
    }
    this._ext = { id, key, box: { x: best.x, y: best.y, w, h }, ax, ay, ring, t: now, scoredAt: now };
    return { x: rect.left + best.x, y: rect.top + best.y };
  }

  /** The shell card placed through placeCaption (while the shell keeps asking: ~½ s). */
  _extBoxes(now) {
    const e = this._ext;
    if (!e || now - e.t > 500) return [];
    return [{ x: e.box.x - 6, y: e.box.y - 6, w: e.box.w + 12, h: e.box.h + 12 }];
  }

  _drawExtLeader(ctx, now, a, mv = null) {
    const e = this._ext;
    if (!e || now - e.t > 400 || a < 0.02) return;
    let ax = e.ax, ay = e.ay, bx = e.box.x, by = e.box.y;
    if (mv) { const m = mv(e.ax, e.ay); if (!m) return; bx += m[0] - ax; by += m[1] - ay; ax = m[0]; ay = m[1]; }
    const b = e.box, ex = clamp(ax, bx, bx + b.w), ey = clamp(ay, by, by + b.h);
    const d = Math.hypot(ex - ax, ey - ay);
    if (d < e.ring + 14) return;
    const ux = (ex - ax) / d, uy = (ey - ay) / d, r0 = e.ring + 3;
    ctx.save();
    ctx.globalAlpha = a * 0.8;
    ctx.strokeStyle = this.theme.inkFaint;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax + ux * r0, ay + uy * r0); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.restore();
  }

  // ============================================================================== interaction
  _local(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const { cx, cy, R } = this.view;
    return { x, y, lx: (x - cx) / R, ly: (y - cy) / R };
  }

  _hit(e) {
    const st = this.cur;
    this._hitInfo = null;
    if (!st || this.transition) return -1;
    if (this._fc && this._fc.moving()) return -1; // §26 free camera: nothing to hover while the globe turns
    const { x, y, lx, ly } = this._local(e);
    if (st.pt) {
      let best = -1, bd = Infinity;
      for (const p of st.pt) { if (!p.vis) continue; const d = Math.hypot(p.tx - x, p.ty - y); if (d <= p.r + 4 && d < bd) { bd = d; best = p.k; } }
      if (best >= 0) return best;
    }
    for (let i = this._labels.length - 1; i >= 0; i--) {
      const b = this._labels[i];
      if (x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 3 && y <= b.y + b.h + 3) return b.it.k;
    }
    // §26 amendment 4: a minority dot speaks for its own child (a 金融 dot inside AI 算力's county)
    if (st.tickScr && st.um) {
      let best = null, bd = Infinity;
      for (const t of st.tickScr) { const d = Math.hypot(t.x - x, t.y - y); if (d <= t.r + 4 && d < bd) { bd = d; best = t; } }
      if (best) { this._hitInfo = { via: 'tick', t: st.um.ticks[best.i] }; return best.k; }
    }
    if (!this._visXY(st, x, y, 0)) return -1;
    const c = cellAt(lx, ly);
    const o = c < 0 ? -1 : st.L.owner[c];
    if (st.real) {
      const k = this._hitExact(st, lx, ly, o);
      if (k >= 0) this._hitInfo = { via: 'ground', lx, ly };
      return k;
    }
    return o >= 0 && st.kind && st.kind[o] === 'point' ? -1 : o;
  }

  /** lon / lat (deg) under a local point of a real view (inverse of _llScreen), or null off the globe. */
  _lonLatAt(st, lx, ly) {
    if (!st || !st.frame) return null;
    const v = st.frame.v, [e, n] = frameOf(v), Z = st.frame.Zl || 1, D = st.frame.D;
    let a = lx / Z, b = -ly / Z;
    const r2 = a * a + b * b;
    if (r2 >= 1) return null;
    let c = Math.sqrt(1 - r2);
    if (D) { const q = lensInv(D, a, -b); if (!q) return null; a = q[0]; b = -q[1]; c = q[2]; } // (the 3D lens)
    const x = e[0] * a + n[0] * b + v[0] * c, y = e[1] * a + n[1] * b + v[1] * c, z = e[2] * a + n[2] * b + v[2] * c;
    return [Math.atan2(x, z) * 180 / Math.PI, Math.asin(clamp(y, -1, 1)) * 180 / Math.PI];
  }

  /** §26 amendment 4: the unit tag for the pointer — '海淀区 · AI 算力 · 也有 金融 3 家', or a minority dot. */
  _unitHover(e) {
    const st = this.cur, h = this._hitInfo;
    if (!this._utag) this._utag = new UnitTag();
    const tag = this._utag;
    if (!st || !st.um || !h || this.hoverIdx < 0 || this.transition) { tag.hide(); return; }
    let txt = null;
    if (h.via === 'tick') txt = tickText(st.um, h.t, st.children);
    else if (h.via === 'ground' && st.unitFs && st.kind[this.hoverIdx] === 'land') {
      const ll = this._lonLatAt(st, h.lx, h.ly);
      if (ll) {
        const key = ll[0].toFixed(3) + ',' + ll[1].toFixed(3);
        if (this._uhKey !== key) { this._uhKey = key; this._uh = unitHit(st.um, st.unitFs, ll[0], ll[1]); }
        if (this._uh && this._uh.k === this.hoverIdx) txt = unitText(st.um, this._uh, st.children);
      }
    }
    if (!txt) { tag.hide(); return; }
    // (the canvas planet's own cards and 主航道 caption: client rects for the tag to keep off)
    const rc = this.canvas.getBoundingClientRect();
    const av = (this._capBoxes || []).concat(this._chanBox ? [this._chanBox] : []).map((b) => ({ left: rc.left + b.x, top: rc.top + b.y, right: rc.left + b.x + b.w, bottom: rc.top + b.y + b.h }));
    tag.show(txt.head, txt.line, e.clientX, e.clientY, av);
  }

  /** §26 the real Earth: the territory under a local point from its exact rings (the grid only suggests one). */
  _hitExact(st, lx, ly, guess) {
    const g = this._hitG || (this._hitG = document.createElement('canvas').getContext('2d'));
    // (the point is moved to the middle of the little hit canvas; local units × 4096 keep sub-pixel precision)
    const S = 4096;
    g.setTransform(S, 0, 0, S, 100 - lx * S, 75 - ly * S);
    const test = (k) => k >= 0 && k < st.n && st.kind[k] !== 'point' && g.isPointInPath(st.polyPaths[k], 100, 75, 'evenodd');
    if (test(guess)) return guess;
    // land first (sea areas sit under it), the smallest first (a county inside a bigger region's hole)
    const order = st._hitOrder || (st._hitOrder = [...Array(st.n).keys()].filter((k) => st.kind[k] !== 'point')
      .sort((a, b) => (st.kind[a] === 'sea') - (st.kind[b] === 'sea') || st.L.areas[a] - st.L.areas[b]));
    for (const k of order) if (k !== guess && test(k)) return k;
    return -1;
  }

  _setHover(k, e) {
    const st = this.cur;
    const changed = k !== this.hoverIdx;
    this.hoverIdx = k;
    this.canvas.style.cursor = k >= 0 ? 'pointer' : '';
    if (k >= 0 && st) this.cb.onHover(st.children[k], { x: e.clientX, y: e.clientY });
    else if (changed) this.cb.onHover(null, e ? { x: e.clientX, y: e.clientY } : null);
    if (k < 0 && this._utag) this._utag.hide();
  }

  _pointerMove(e) {
    if (this._press && Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y) > 10) this._cancelPress();
    this._setHover(this._hit(e), e);
    this._unitHover(e);
  }

  _pointerDown(e) {
    this._cancelPress();
    if (e.pointerType === 'mouse' || !this.cb.onContextMenu) return;
    const k = this._hit(e);
    if (k < 0) return;
    const ev = { clientX: e.clientX, clientY: e.clientY };
    this._press = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        this._press = null;
        const kk = this._hit(ev);
        if (kk >= 0 && this.cur) {
          this._suppressClick = performance.now() + 700;
          this.cb.onContextMenu(this.cur.children[kk], { x: ev.clientX, y: ev.clientY });
        }
      }, 550),
    };
  }

  _cancelPress() {
    if (this._press) { clearTimeout(this._press.timer); this._press = null; }
  }

  _contextMenu(e) {
    if (!this.cb.onContextMenu) return;
    const k = this._hit(e);
    if (k < 0 || !this.cur) return;
    e.preventDefault();
    if (this._suppressClick && performance.now() < this._suppressClick) return; // long-press already fired
    this.cb.onContextMenu(this.cur.children[k], { x: e.clientX, y: e.clientY });
  }

  _click(e) {
    if (this._suppressClick && performance.now() < this._suppressClick) { this._suppressClick = 0; return; }
    const k = this._hit(e);
    if (k >= 0 && this.cur) this.cb.onClick(this.cur.children[k]);
  }

  // §26 free camera: the wheel zooms continuously at the cursor (planet/controls.js) — it no longer changes level
  _wheel(e) { if (!this._fc) e.preventDefault(); }
}

// ids below a node (memoised per node object)
const subMemo = new WeakMap();
/** The 全球 map's planets (gl-* ids) are the real Earth; everything else is abstract islands. */
/**
 * §26 hop between two real views: zoom into the new centre as seen now ('in'), or out of the old one ('out'). Screen
 * px: px/rad = R0·zoom; the new picture is drawn at R = R0·ext (full-bleed), so r (its size as seen in the old
 * picture) is R / zr ('in') or R·zr ('out'). fa = the free screen area (the place must be on it).
 */
function realHop(a, b, view, fa) {
  const R0 = view.R0 || view.R;
  const loc = (from, d) => {
    const c = from.dir, [e, n] = frameOf(c), f = d[0] * c[0] + d[1] * c[1] + d[2] * c[2], s = R0 * from.zoom * (view.D ? lensK(view.D, f) : 1);
    return [(d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) * s, -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) * s, f];
  };
  const onScreen = (x, y, lim) => view.cx + x > fa.x0 + 20 && view.cx + x < fa.x1 - 20 && view.cy + y > fa.y0 + 20 && view.cy + y < fa.y1 - 20 && x * x + y * y < lim * lim;
  const Rb = R0 * (b.ext || 1);
  const zr = b.zoom / a.zoom;
  if (Math.abs(Math.log(zr)) < 0.08) {
    const [x, y, z] = loc(a, b.dir);
    if (z > 0.3 && onScreen(x, y, R0 * 0.7)) return { dir: 'in', px: view.cx + x, py: view.cy + y, r: Rb / Math.max(1.0001, zr) };
    return null;
  }
  if (zr > 1) {
    const [x, y, z] = loc(a, b.dir);
    if (z > 0.2 && onScreen(x, y, R0 * a.zoom * 0.92)) return { dir: 'in', px: view.cx + x, py: view.cy + y, r: Rb / zr };
  } else {
    const [x, y, z] = loc(b, a.dir);
    if (z > 0.2 && onScreen(x, y, R0 * b.zoom * 0.92)) return { dir: 'out', px: view.cx + x, py: view.cy + y, r: Rb * zr };
  }
  return null;
}
/** One painted frame between two heavy steps (a long build never holds the main thread for all of them at once). */
function frameGap() {
  return new Promise((res) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => setTimeout(res, 0)) : setTimeout(res, 0)));
}

/**
 * §26 amendment 5: the layout a camera rebuild may keep (planet3d.js _reask): the same node and data, real, the zoom
 * inside layout.lod [zoomMin, zoomMax) and the camera within 4° of lod.near — else null (ask geo for this zoom / place).
 */
function keptList(st, node, mapJson, cv) {
  if (!st || !st.real || !Array.isArray(st.list) || !st.node || st.node.id !== node.id || st.map !== (mapJson || null)) return null;
  const lod = st.lod, z = clamp(+cv.scale || 1, 1, ZMAX_REAL);
  // (§26 amendment 5: a points-only level too — its faint unit borders follow the zoom, as a fresh build at that camera has)
  if (lod && lod.level > 0 && (z < (+lod.zoomMin || 0) - 1e-6 || (lod.zoomMax != null && z >= +lod.zoomMax))) return null;
  if (lod && lod.near) {
    const r = Math.PI / 180, la1 = +cv.lat * r, la2 = +lod.near.lat * r;
    const a = Math.sin((la2 - la1) / 2), b = Math.sin(((+lod.near.lon - +cv.lon) * r) / 2);
    if ((2 * Math.asin(Math.min(1, Math.sqrt(a * a + Math.cos(la1) * Math.cos(la2) * b * b)))) / r > 4) return null;
  }
  return st.list;
}
function frameOf(c) {
  let ex = c[2], ez = -c[0];
  let l = Math.hypot(ex, ez);
  if (l < 1e-6) { ex = 1; ez = 0; l = 1; }
  const e = [ex / l, 0, ez / l];
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  return [e, [n[0] / nl, n[1] / nl, n[2] / nl]];
}

/**
 * §26 refine: per child, √(its money on its own land ÷ the most any child has) — dv20 × Σ item.units[].w (a company /
 * sea area / item without units: its dv20). 0…1, null when nothing is known.
 */
function moneyWeights(children, list) {
  if (!Array.isArray(list) || !children.length) return null;
  const byId = new Map(list.filter((it) => it && it.id != null).map((it) => [it.id, it]));
  const m = children.map((c) => {
    const dv = Math.max(0, +((c && c.now) || {}).dv20 || 0);
    const it = byId.get(c && c.id);
    if (!it || it.kind !== 'land' || !Array.isArray(it.units) || !it.units.length) return dv;
    let w = 0;
    for (const u of it.units) w += Math.max(0, +u.w || 0);
    return dv * clamp(w, 0, 1);
  });
  const mx = Math.max(...m);
  if (!(mx > 0)) return null;
  return Float32Array.from(m, (v) => Math.sqrt(v / mx));
}

/** Two [lon, lat] places within ~150 km of each other. */
function near(a, b) {
  if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(b[0])) return false;
  const R = Math.PI / 180, x = Math.sin(((a[1] - b[1]) * R) / 2), y = Math.sin(((a[0] - b[0]) * R) / 2);
  return 2 * Math.asin(Math.min(1, Math.sqrt(x * x + Math.cos(a[1] * R) * Math.cos(b[1] * R) * y * y))) < 150 / 6371;
}

/** §26 a ①②③ card whose money is mostly off the view says where: '钱杀回来 → 新竹 台积电'. */
function withWhere(why, where) {
  const a = String(why || '').trim(), b = String(where || '').trim();
  if (!b || a.includes(b.replace(/^→\s*/, ''))) return a;
  return a ? `${a} ${b}` : b;
}

function guessGeo(node) {
  const id = String((node && node.id) || '');
  if (id.startsWith('gl-')) return 'earth';
  return ((node && node.children) || []).some((c) => String(c.id || '').startsWith('gl-')) ? 'earth' : 'abstract';
}

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

// tags: a child matches the lens if it, or anything below it, carries the tag
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

installNames(Planet); // §26 amendment 5 (planet/names2d.js)

export { BAND_EDGES };
export default Planet;

/** 'liquidity' overlay → {pressure (−3…3), state ('放水'|'收水'|'平稳'), say} or null (same rules as planet3d.js). */
function normLiq(d) {
  if (!d || typeof d !== 'object') return null;
  let p = +(d.pressure != null ? d.pressure : d.regime && d.regime.pressure);
  if (!Number.isFinite(p)) p = 0;
  p = clamp(p, -3, 3);
  let st = d.state || (d.regime && d.regime.state);
  if (!LIQ_STATES.includes(st)) st = p > 0.5 ? '放水' : p < -0.5 ? '收水' : '平稳';
  let say = String(d.say || (d.regime && d.regime.say) || '').trim();
  if (say.length > 30) say = say.slice(0, 29) + '…';
  return { pressure: p, state: st, say };
}
function hexRGB(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
/** A rounded rectangle added to a Path2D (several boxes in one clip). */
function rrPath(p, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  p.moveTo(x + r, y);
  p.arcTo(x + w, y, x + w, y + h, r);
  p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r);
  p.arcTo(x, y, x + w, y, r);
  p.closePath();
}
