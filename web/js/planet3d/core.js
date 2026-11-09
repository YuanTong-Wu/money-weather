// planet3d/core.js — shared bits of the 3D planet: sphere helpers, palette, GLSL.
//
// §25: every planet is a small Earth — territories are landmasses (spherical polygons from geo/index.js, raised as
// paper-cut plates by |wind|) in a calm sea (~70 % of the globe). Object space is the unit sphere: x = east at
// lon 90°, y = north, z = toward lon 0° lat 0° (the camera looks down −z; with no rotation lon 0 / lat 0 faces
// the viewer, north up). Colours are passed to the shaders as raw sRGB triples and written out unconverted, so
// the §17 palette lands on screen exactly as specified (no tone mapping, no colour-space drift).

import * as THREE from 'three';
import { THEMES, BAND_EDGES, REAL_LAND, REAL_LAND_SH } from '../planet/theme.js';
import { DMAX } from '../planet/sphere.js';

export { THREE, THEMES, BAND_EDGES };

export const MAXT = 128; // max territories per planet (uniform array size; the largest planets have ≤ 59)
export const BASE_R = 0.995; // sea level / plate foot (object units)
export const SEA_R = BASE_R - 0.0015; // the sea surface sits just under the plate feet

const DBG = (typeof globalThis !== 'undefined' && globalThis.__P3) || {}; // dev-harness knobs (look tuning only)

// ------------------------------------------------------------------------------------------ sphere
/** Unit vector (object space) → [lon, lat] radians. */
export function lonLat(d) {
  const l = Math.hypot(d.x, d.y, d.z) || 1;
  return [Math.atan2(d.x, d.z), Math.asin(Math.max(-1, Math.min(1, d.y / l)))];
}
/** Tangent frame at unit vector d: east, north (Vector3s). */
export function frame3(d, e = new THREE.Vector3(), n = new THREE.Vector3()) {
  e.set(d.z, 0, -d.x);
  if (e.lengthSq() < 1e-10) e.set(1, 0, 0);
  e.normalize();
  n.crossVectors(d, e).normalize();
  return [e, n];
}
/** Point at local equidistant offset (x east, y north; radians) from unit vector c. */
export function offsetDir(c, e, n, x, y, out = new THREE.Vector3()) {
  const r = Math.hypot(x, y);
  if (r < 1e-12) return out.copy(c);
  const s = Math.sin(r) / r, k = Math.cos(r);
  return out.set(k * c.x + s * (x * e.x + y * n.x), k * c.y + s * (x * e.y + y * n.y), k * c.z + s * (x * e.z + y * n.z)).normalize();
}
/** Rotation that brings unit vector v to the screen centre (+z) with north up (falls back near the poles). */
export function lookQuat(v, out = new THREE.Quaternion()) {
  const z = v.clone().normalize();
  let x = new THREE.Vector3(z.z, 0, -z.x);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z); // columns: object → (x, y, z) frame
  return out.setFromRotationMatrix(m).invert();
}

// ------------------------------------------------------------------------------------------ palette
export const hex3 = (h) => {
  const n = parseInt(String(h).replace('#', '').slice(0, 6), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
/** 'rgba(r,g,b,a)' | '#hex' → {c: Vector3, a} */
export function parseCol(s) {
  s = String(s).trim();
  if (s[0] === '#') return { c: hex3(s), a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return { c: new THREE.Vector3(0, 0, 0), a: 1 };
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { c: new THREE.Vector3(p[0] / 255, p[1] / 255, p[2] / 255), a: p.length > 3 ? p[3] : 1 };
}
const mixV = (a, b, t) => new THREE.Vector3().copy(a).lerp(b, t);

/**
 * The 3D planet is a lit paper object: the same surface colours by day and by night (only the sky
 * changes). Shadows are hand-picked per temperature band (anime rule: shadows are richer — a little darker,
 * a little more saturated, never greyer, no violet): kinari → warm sand, 柿 → 弁柄, 藍 → deeper 藍.
 */
// (§26 amendment 5: 生成り #f0e3c3 in both renderers — was #ece2cb here; its shadow keeps the same warm-sand ratio)
const BANDS_3D = ['#263e63', '#33628a', '#5895ab', '#a4c8c2', '#f0e3c3', '#f1cf8e', '#e9a643', '#d96f3c', '#b43d2c'];
const BANDS_3D_SH = ['#172b4e', '#214a73', '#38748f', '#78a5a4', '#d0c097', '#d6a655', '#c27d20', '#a74622', '#83261c'];
const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
/** v scaled so its luma is L (a touch cooler: night paper leans to 紺). */
const toLum = (v, L) => v.clone().multiplyScalar(L / Math.max(1e-3, lum(v))).lerp(new THREE.Vector3(0.11, 0.16, 0.28), 0.06);
const DARK_LUM = 0.42; // sRGB luma below which ink text turns into grey fuzz → cream text
/** Is the ground under a label dark? band index + N·L at that point (the toon's lit / mid / shadow tone). */
export function darkAt(look, band, ndl) {
  if (band == null || band < 0) return false;
  if (ndl < 0) return !!look.bandDarkSh[band];
  if (ndl < 0.28) return !!look.bandDarkMid[band];
  return !!look.bandDark[band];
}

// upper left and well off the view axis: the terminator crosses the continent as a crisp two-tone split, so the
// globe reads as a ball (a light near the view axis flattens it into a disc)
export const LIGHT = (DBG.light ? new THREE.Vector3(...DBG.light) : new THREE.Vector3(-0.62, 0.55, 0.28)).normalize();

/** 3D look per theme: the 2D theme (THEMES) plus lighting/material constants. */
export function look(name) {
  const th = THEMES[name] || THEMES.day;
  const day = th.name !== 'night';
  const sky0 = hex3(th.sky0), sky1 = hex3(th.sky1);
  const ink = hex3(day ? '#1f2a44' : '#efe7d6');
  const outline = day ? hex3('#22304d') : mixV(hex3('#101629'), hex3('#d9cdb3'), 0.42);
  // night: the same lit paper planet, a touch dimmer; its shadows a touch deeper and cooler
  const nightTone = (v, sh) => (day ? v : sh ? v.clone().multiplyScalar(0.9).lerp(hex3('#1c2a48'), 0.05) : v.clone().multiplyScalar(0.95));
  // (refine #3: at night the weather colours step down a little more — on a 紺 sea and dusk-grey land they read as
  // lit paper, not as day-bright stickers)
  const bandTone = (v, sh) => (day ? v : v.clone().multiplyScalar(sh ? 0.8 : 0.86).lerp(hex3('#1c2a48'), sh ? 0.08 : 0.04));
  const bands = BANDS_3D.map((h) => bandTone(hex3(h), false));
  const bandsSh = BANDS_3D_SH.map((h) => bandTone(hex3(h), true));
  return {
    th, day, name: th.name,
    sky0, sky1,
    bands, bandsSh,
    // knock-out (cream) text where the ground is dark: lit band, and the same band in its mid tone / shadow
    bandDark: Uint8Array.from(bands.map((v) => (lum(v) < DARK_LUM ? 1 : 0))),
    bandDarkMid: Uint8Array.from(bands.map((v, i) => (lum(mixV(bandsSh[i], v, 0.72)) < DARK_LUM ? 1 : 0))),
    bandDarkSh: Uint8Array.from(bandsSh.map((v) => (lum(v) < DARK_LUM ? 1 : 0))),
    ink, paper: hex3(day ? '#fbf8f1' : '#1a2238'),
    border: nightTone(hex3('#fffcf4'), false),
    // the sea (§25 + §17): calm pale 浅葱 water, a touch deeper offshore, 藍-grey linework (等深線, wave marks),
    // a soft foam line on the shore — paler than any cool land band, so land always reads as land
    seaDeep: nightTone(hex3(DBG.seaDeep || '#bcd5d6'), false), seaShal: nightTone(hex3(DBG.seaShal || '#d8e9e5'), false),
    seaDeepSh: nightTone(hex3('#98b6bc'), true), seaShalSh: nightTone(hex3('#b4ccca'), true),
    seaLine: nightTone(hex3('#8daeb5'), false), seaWave: nightTone(hex3('#7fa3ad'), false), foam: nightTone(hex3('#f8faf4'), false),
    // neutral land (全球: countries without a market of their own): quiet kinari-grey paper
    neutral: nightTone(hex3('#e0ddd3'), false), neutralSh: nightTone(hex3('#c3bfb2'), true),
    // §26 the real Earth's unclaimed land: a lighter, cooler paper (ΔE ≥ 8 from 生成り, so a neutral-temperature region
    // still reads as land with money on it); at night it is toned down to ~0.55 luminance (no bright paper on navy)
    // (refine #3: night = §17's deep 紺 — the real Earth's sea is navy, its unclaimed land a dusk grey-beige: land / sea
    // contrast ≈ 2.5 : 1 instead of 1.4 : 1 grey fog; 2D night uses the same values)
    // (§26 amendment 5: one value with 2D — planet/theme.js REAL_LAND; day was #e7e6e0 here)
    realNeutral: hex3(day ? REAL_LAND.day : REAL_LAND.night), realNeutralSh: hex3(day ? REAL_LAND_SH.day : REAL_LAND_SH.night),
    realSeaK: 1,
    realSea: day ? null : {
      deep: hex3('#22385a'), shal: hex3('#2e4a6e'), deepSh: hex3('#1b2e4c'), shalSh: hex3('#253f60'),
      line: hex3('#4d6c90'), wave: hex3('#58789c'), foam: hex3('#a3b5c6'),
    },
    realBorder: day ? null : hex3('#c9c3b2'),
    // plate walls (the paper-cut edge): a touch deeper than the band shadow
    wallMix: 0.3,
    // atmosphere + liquidity band (§24 'liquidity'): 浅葱 calm, 若竹 放水, 臙脂 收水 — muted, never neon
    atmo: day ? hex3('#b9d3d0') : hex3('#5f7f8f'), atmoSh: day ? hex3('#a5bfc0') : hex3('#3f5a6c'),
    liqIn: day ? hex3('#8fb795') : hex3('#5f9a6c'), liqInSh: day ? hex3('#77a17f') : hex3('#457a54'),
    liqOut: day ? hex3('#c99a95') : hex3('#9a5c62'), liqOutSh: day ? hex3('#b5827e') : hex3('#7a4248'),
    outline,
    midMix: 0.72,
    rim: day ? hex3('#fffdf6') : hex3('#fbf2dc'),
    rimAmt: day ? 0.48 : 0.42,
    iso: hex3('#1f2a44'), isoA: day ? 0.1 : 0.12,
    hatch: hex3('#1f2a44'), hatchA: 0.2,
    lensDim: nightTone(hex3('#ece4d3'), false),
    halo: day ? hex3('#fbf8f1') : hex3('#141a2e'),
    windInk: new THREE.Vector3(th.windInk[0] / 255, th.windInk[1] / 255, th.windInk[2] / 255),
    windPaper: new THREE.Vector3(th.windPaper[0] / 255, th.windPaper[1] / 255, th.windPaper[2] / 255),
    windAlpha: day ? 0.62 : 0.66,
    inC: hex3(th.in), outC: hex3(th.out), gold: hex3(th.gold),
    chan: hex3(day ? '#22304f' : '#f3ead6'), chanShade: hex3(day ? '#18233d' : '#d9cdb0'),
    chanCase: hex3(day ? '#fbf8f1' : '#141a2e'), chanFlow: hex3(day ? '#4a5c86' : '#fffaf0'),
    shadow: hex3('#1f2a44'), shadowA: 0.1,
    cloud: { lit: hex3(th.skyCloud.base), shade: hex3(day ? '#dbe0e6' : '#c3c5cb'), line: day ? hex3('#5b6680') : hex3('#0b1020') },
    storm: day ? { lit: hex3('#8d96a7'), shade: hex3('#6c768a'), line: hex3('#2a3450') } : { lit: hex3('#8790ab'), shade: hex3('#6b7491'), line: hex3('#090d1a') },
    rain: parseCol(th.rain),
    bolt: hex3(th.bolt), boltLine: hex3(th.boltLine),
    // light comes from the upper left, slightly in front: one crisp terminator on the lower right
    // (one canonical light for the planet and every prop; assets.js swaps in manifest.light_dir if present)
    light: LIGHT.clone(),
    stars: day ? 0 : 1,
  };
}

// ------------------------------------------------------------------------------------------ GLSL
/**
 * Toon shading with a hand-picked shadow colour (never a multiply): lit / a soft mid band / shadow,
 * one crisp terminator, a thin rim light on the lit side.
 */
export const GLSL_TOON = /* glsl */ `
uniform vec3 uL;
uniform float uMidMix;
uniform vec3 uRimCol;
uniform float uRimAmt;
vec3 toon(vec3 col, vec3 sh, vec3 N, vec3 V, float ndlBias) {
  float ndl = dot(N, uL) + ndlBias;
  float fl = max(fwidth(ndl), 1e-4) * 0.9;
  float lit = smoothstep(-fl, fl, ndl);
  float mid = smoothstep(0.28 - fl, 0.28 + fl, ndl);
  vec3 c = mix(sh, mix(mix(sh, col, uMidMix), col, mid), lit);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float e = 1.0 - ndv;
  float fr = max(fwidth(e), 1e-4);
  // a cream rim ~12–15 px wide on the lit limb (N·V < 0.28)
  float rim = smoothstep(0.72 - fr, 0.72 + fr, e) * smoothstep(0.0, 0.3, ndl);
  return mix(c, uRimCol, rim * uRimAmt);
}
`;
const GLSL_NOISE3 = /* glsl */ `
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

/**
 * Plates: every landmass is a raised paper-cut plate (a low shelf, plus |wind| — money has volume), walls drop
 * to sea level at the coast. Vertices carry their unit direction; heights come from uInfo per territory
 * (aTerr < 0: neutral land, a flat shelf).
 */
export const GLSL_PLATE_VERT = /* glsl */ `
attribute float aProf;
attribute float aWall;
attribute vec3 aOut;
attribute float aTerr;
uniform vec4 uInfo[${MAXT}];
uniform vec4 uInfo2[${MAXT}];
uniform float uRise;
uniform float uNeutralH;
vec4 plateInfo() { if (aTerr < -0.5) return vec4(uNeutralH, 0.0, 0.0, 0.0); int k = int(aTerr + 0.5); return uInfo[k]; }
vec4 plateInfo2() { if (aTerr < -0.5) return vec4(0.0, 0.0, 0.0, 1.0); int k = int(aTerr + 0.5); return uInfo2[k]; }
// §17 at the limb a plate lies down flat (height × smoothstep(0.15, 0.55, N·V)): no brick walls on the rim, but it
// never sinks under the neutral land around it
float plateFace() {
  vec3 dn = normalize(position);
  vec4 mv0 = modelViewMatrix * vec4(dn, 1.0);
  return dot(normalize(normalMatrix * dn), normalize(-mv0.xyz));
}
float plateH(vec4 info) {
  float h = max(info.x, 0.0) * uRise;
  float fl = uNeutralH * 1.6;
  return h > fl ? max(h * smoothstep(0.15, 0.55, plateFace()), fl) : h;
}
vec3 platePos(vec4 info) {
  float top = 1.0 - ${BASE_R.toFixed(4)} + plateH(info);
  return normalize(position) * (${BASE_R.toFixed(4)} + top * aProf);
}
vec3 plateNormal(vec4 info) {
  return normalize(mix(normalize(position), aOut, aWall * (plateH(info) > 0.002 ? 0.92 : 0.35)));
}
`;

export const PLATE_VS = /* glsl */ `
${GLSL_PLATE_VERT}
varying vec3 vDir;
varying vec3 vN;
varying vec3 vView;
varying float vWall;
varying float vProf;
varying vec4 vInfo;
varying vec4 vInfo2;
void main() {
  vec4 info = plateInfo();
  vec3 p = platePos(info);
  vDir = normalize(position);
  vWall = aWall;
  vProf = aProf;
  vInfo = info;
  vInfo2 = plateInfo2();
  vN = normalize(normalMatrix * plateNormal(info));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const PLATE_FS = /* glsl */ `
uniform float uRise;
uniform float uWallMix;
uniform vec3 uBands[9];
uniform vec3 uBandsSh[9];
uniform float uEdges[8];
uniform vec3 uHatch;
uniform float uHatchA;
uniform vec3 uDimCol;
uniform vec3 uInk;
uniform vec3 uNeutral;
uniform vec3 uNeutralSh;
uniform float uNeutralDot;
uniform float uScen;
uniform float uTime;
uniform float uPR;
uniform vec4 uRip[4];
uniform float uNRip;
uniform vec4 uCS[8];
uniform float uNCS;
uniform float uWS;
uniform float uHide;
uniform vec4 uHideBox;
varying vec3 vDir;
varying vec3 vN;
varying vec3 vView;
varying float vWall;
varying float vProf;
varying vec4 vInfo;
varying vec4 vInfo2;
${GLSL_TOON}
${GLSL_NOISE3}
vec3 bandLit(float T) {
  vec3 c = uBands[0];
  for (int i = 0; i < 8; i++) c = mix(c, uBands[i + 1], step(uEdges[i], T));
  return c;
}
vec3 bandSh(float T) {
  vec3 c = uBandsSh[0];
  for (int i = 0; i < 8; i++) c = mix(c, uBandsSh[i + 1], step(uEdges[i], T));
  return c;
}
void main() {
  // one flat paper colour per landmass: its own temperature band (neutral land: quiet kinari-grey)
  bool neutral = vInfo2.w > 0.5;
  vec3 col = neutral ? uNeutral : bandLit(vInfo2.x);
  vec3 colS = neutral ? uNeutralSh : bandSh(vInfo2.x);
  vec3 ratio = colS / max(col, vec3(0.02));
  vec3 d = normalize(vDir);
  float ws = max(uWS, 1e-3);
  if (uHide > 0.5) {
    // §26 coastline LOD: inside the detailed window the 1:10m land takes over (no double coast)
    float hl = asin(clamp(d.y, -1.0, 1.0)), hn = atan(d.x, d.z) - uHideBox.x;
    hn = hn > 3.14159265 ? hn - 6.2831853 : hn < -3.14159265 ? hn + 6.2831853 : hn;
    if (abs(hn) < uHideBox.y && hl > uHideBox.z && hl < uHideBox.w) discard;
  }
  if (neutral) {
    // a faint dot screen: land without a market of its own (an atlas's "no data"), never mistaken for weather
    float lat = asin(clamp(d.y, -1.0, 1.0)), lon = atan(d.x, d.z);
    float dsz = 0.0125 * ws;
    vec2 q = vec2(lon * cos(lat), lat) / dsz;
    vec2 f = fract(q) - 0.5;
    float fw = max(length(fwidth(d)) / dsz, 1e-3);
    float dm = 1.0 - smoothstep(0.15, 0.15 + fw, length(f));
    col = mix(col, colS, dm * 0.4 * uNeutralDot);
  }
  // washi grain (subtle)
  float g = vnoise3(d * 52.0 / ws) * 0.6 + vnoise3(d * 150.0 / ws) * 0.4;
  col *= 0.992 + 0.016 * g;
  // scenario ripples from the epicentres (angular distance on the sphere)
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uNRip) break;
    float dd = acos(clamp(dot(d, uRip[i].xyz), -1.0, 1.0));
    float ph = dd * 9.0 - uTime * 0.55 - uRip[i].w;
    float fr = fract(ph);
    float fd = max(fwidth(ph), 1e-4);
    float ring = smoothstep(0.0, fd * 1.5, fr) * (1.0 - smoothstep(fd * 1.5, fd * 3.5, fr));
    col = mix(col, uInk, ring * 0.32 * (1.0 - smoothstep(0.2, 0.75, dd)));
  }
  // estimate / inferred: diagonal hatch
  if (vInfo.z > 0.5) {
    float s = (gl_FragCoord.x + gl_FragCoord.y) / (7.0 * uPR); // a crisp screen-space paper hatch (as in 2D)
    float fs = max(fwidth(s), 1e-4);
    float hatch = 1.0 - smoothstep(0.14, 0.14 + fs * 1.2, abs(fract(s) - 0.5));
    col = mix(col, uDimCol, 0.3);
    col = mix(col, uHatch, hatch * uHatchA * 1.05);
  }
  // lens: territories without the tag fade into the paper
  col = mix(col, uDimCol, vInfo.y * 0.72);
  // hover / spotlight lift
  col = mix(col, vec3(1.0), clamp(vInfo.w, 0.0, 1.0) * 0.1);
  vec3 sh = col * ratio;
  // the terminator never splits a landmass into two colours: its contrast is capped at 6 % luma
  float dl = dot(col - sh, vec3(0.2126, 0.7152, 0.0722));
  sh = mix(col, sh, min(1.0, 0.06 / max(dl, 1e-4)));
  vec3 N = normalize(vN);
  vec3 V = normalize(-vView);
  vec3 c = toon(col, sh, N, V, 0.0);
  // walls: the paper-cut edge — the top colour × 0.88, no ink on the vertical edges; a light lip along the cut
  float wl = smoothstep(0.45, 0.9, vWall);
  c = mix(c, c * 0.88, wl);
  float lip = wl * smoothstep(0.8, 0.97, vProf) * step(0.004, vInfo.x * uRise);
  c = mix(c, col * 1.04 + 0.03, lip * 0.6);
  // cloud shadows: flat, hard-edged caps in the ground's own shadow colour
  float cs = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uNCS) break;
    float e = acos(clamp(dot(d, uCS[i].xyz), -1.0, 1.0)) / max(uCS[i].w, 1e-4);
    float fe = max(fwidth(e), 1e-4);
    cs = max(cs, 1.0 - smoothstep(1.0 - fe, 1.0 + fe, e));
  }
  c = mix(c, sh, cs * 0.45 * (1.0 - wl));
  gl_FragColor = vec4(c, 1.0);
}
`;

export const HULL_VS = /* glsl */ `
uniform float uW;
uniform vec2 uRes;
uniform float uGrow;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position + normal * uGrow, 1.0);
  vec3 nv = normalize(normalMatrix * normal);
  vec2 d = (projectionMatrix * vec4(nv, 0.0)).xy;
  float l = length(d);
  if (l > 1e-5) clip.xy += (d / l) * uW * 2.0 / uRes * clip.w;
  gl_Position = clip;
}
`;
/**
 * Ink outline of the raised plates (inverted hull of the plate mesh): pushed out in screen space only near
 * the globe's silhouette, so land that reaches the limb carries the same ink line as the sea.
 */
export const PLATE_HULL_VS = /* glsl */ `
${GLSL_PLATE_VERT}
uniform float uW;
uniform vec2 uRes;
void main() {
  vec4 info = plateInfo();
  vec3 p = platePos(info) * 0.9992;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float facing = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  float k = (1.0 - smoothstep(0.1, 0.3, facing)) * (aTerr < -0.5 ? 0.0 : 1.0); // neutral land: no ink at the limb
  vec3 nv = normalize(normalMatrix * plateNormal(info));
  vec2 d = (projectionMatrix * vec4(nv, 0.0)).xy;
  float l = length(d);
  if (l > 1e-5) clip.xy += (d / l) * uW * k * 2.0 / uRes * clip.w;
  gl_Position = clip;
}
`;
/** Paper hairlines along every coast / border at the plate tops (1 px lines). */
export const BORDER_VS = /* glsl */ `
${GLSL_PLATE_VERT}
varying float vFace;
void main() {
  vec4 info = plateInfo();
  float top = 1.0 - ${BASE_R.toFixed(4)} + plateH(info);
  vec3 p = normalize(position) * (${BASE_R.toFixed(4)} + top + 0.0007);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFace = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  gl_Position = projectionMatrix * mv;
}
`;
export const BORDER_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
varying float vFace;
void main() { gl_FragColor = vec4(uCol, uA * smoothstep(0.08, 0.3, vFace)); }
`;
/**
 * §17 paper-cut edges for the real Earth's regions: screen-space ribbons along every ring at the plate top —
 * band 0 an off-white inner rim (1.5 px, inside), band 1 a 0.75 px ink edge (outside), band 2 a 1 px soft drop shadow
 * shifted 0.6 px away from the light. aOff: signed px from the coast (+ outward), aOut: outward tangent normal.
 */
export const EDGE_VS = /* glsl */ `
${GLSL_PLATE_VERT}
attribute float aOff;
attribute float aBand;
attribute float aT;
uniform vec2 uRes;
uniform float uPR;
uniform vec3 uL;
varying float vBand;
varying float vT;
varying float vFace;
void main() {
  vec4 info = plateInfo();
  float top = 1.0 - ${BASE_R.toFixed(4)} + plateH(info);
  vec3 p = normalize(position) * (${BASE_R.toFixed(4)} + top + 0.0005);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFace = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  vec4 clip = projectionMatrix * mv;
  vec4 clip2 = projectionMatrix * (modelViewMatrix * vec4(p + aOut * 0.0004, 1.0));
  vec2 dd = (clip2.xy / clip2.w - clip.xy / clip.w) * uRes;
  float l = length(dd);
  vec2 dir = l > 1e-7 ? dd / l : vec2(0.0);
  vec2 off = dir * aOff * uPR;
  if (aBand > 1.5) off -= normalize(uL.xy + vec2(1e-5)) * 0.6 * uPR;
  clip.xy += off * 2.0 / uRes * clip.w;
  vBand = aBand; vT = aT;
  gl_Position = clip;
}
`;
export const EDGE_FS = /* glsl */ `
uniform vec3 uRimC;
uniform vec3 uInk;
uniform float uA;
uniform float uRimA;
uniform float uInkA;
uniform float uShA;
varying float vBand;
varying float vT;
varying float vFace;
void main() {
  float f = smoothstep(0.08, 0.3, vFace) * uA;
  vec4 o;
  if (vBand < 0.5) o = vec4(uRimC, uRimA * smoothstep(0.0, 0.35, vT));
  else if (vBand < 1.5) o = vec4(uInk, uInkA);
  else o = vec4(uInk, uShA * (1.0 - vT) * (1.0 - vT));
  o.a *= f;
  if (o.a < 0.003) discard;
  gl_FragColor = o;
}
`;

/** Ink hull that follows a draw-in progress along uv.x (the 主航道 casing). */
export const HULL_UV_VS = /* glsl */ `
uniform float uW;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec3 nv = normalize(normalMatrix * normal);
  vec2 d = (projectionMatrix * vec4(nv, 0.0)).xy;
  float l = length(d);
  if (l > 1e-5) clip.xy += (d / l) * uW * 2.0 / uRes * clip.w;
  gl_Position = clip;
}
`;
export const HULL_UV_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
uniform float uProg;
varying vec2 vUv;
void main() { if (uProg < 1.0 && vUv.x > uProg) discard; gl_FragColor = vec4(uCol, uA); }
`;
export const FLAT_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
void main() { gl_FragColor = vec4(uCol, uA); }
`;

/**
 * The sea (§25): calm water — paler near the coasts (shallows) and a touch deeper offshore, a soft foam band and
 * a crisp foam line hugging every shore, three thin 等深線 rings fading out to sea (an old Japanese chart), and
 * sparse little cel-shaded wave marks (two small crests) drifting very slowly in the open water.
 * uCoastT: the sea's distance to the nearest coast (equirect, 0…uDMax rad).
 */
export const OCEAN_VS = /* glsl */ `
varying vec3 vObj;
varying vec3 vN;
varying vec3 vView;
void main() {
  vec3 d = normalize(position);
  vObj = d;
  vN = normalize(normalMatrix * d);
  vec4 mv = modelViewMatrix * vec4(d * ${SEA_R.toFixed(4)}, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
export const OCEAN_FS = /* glsl */ `
uniform sampler2D uCoastT;
uniform sampler2D uCoastL;
uniform float uLodOn;
uniform vec4 uLodBox;
uniform vec4 uLodBox2;
uniform float uDS;
uniform float uWS;
uniform vec3 uSeaDeep;
uniform vec3 uSeaShal;
uniform vec3 uSeaDeepSh;
uniform vec3 uSeaShalSh;
uniform vec3 uSeaLine;
uniform vec3 uSeaWave;
uniform vec3 uFoam;
uniform float uTime;
uniform float uWaveA;
uniform float uSeaK;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vView;
${GLSL_TOON}
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lineAt(float x, float c, float w, float f) { return 1.0 - smoothstep(w * 0.5, w * 0.5 + f * 1.2, abs(x - c)); }
// two small crests (a Japanese wave mark) in sparse cells of roughly equal size on the sphere
float waveMarks(vec3 d) {
  float WS = 0.085 * max(uWS, 1e-3);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float lon = atan(d.x, d.z);
  float row = floor((lat + 1.5707963) / WS);
  float latc = (row + 0.5) * WS - 1.5707963;
  float nc = max(3.0, floor(6.2831853 * cos(latc) / WS));
  float u = (lon + 3.1415927) / 6.2831853 * nc;
  float col = floor(u);
  vec2 cell = vec2(col, row);
  float h = hash2(cell);
  if (h > 0.16 || abs(latc) > 1.35) return 0.0;
  float h2 = hash2(cell + 17.3), h3 = hash2(cell + 41.9);
  vec2 q = vec2((fract(u) - 0.5) * 6.2831853 * cos(lat) / nc, lat - latc) / WS; // local, −0.5…0.5
  q -= vec2((h2 - 0.5) * 0.3 + 0.06 * sin(uTime * 0.35 + h * 40.0), (h3 - 0.5) * 0.3);
  float fw = max(length(fwidth(d)) / WS, 1e-4) * 0.9; // from the continuous direction (no seams at cell edges)
  float r = 0.12 + 0.03 * h3;
  float m = 0.0;
  for (int i = 0; i < 2; i++) {
    vec2 c = vec2(float(i) * 2.0 - 1.0, 0.0) * r * 0.98;
    vec2 v = q - c;
    float arc = abs(length(v) - r);
    float up = smoothstep(-0.02, 0.03, v.y);
    m = max(m, (1.0 - smoothstep(fw * 0.6, fw * 1.6, arc)) * up);
  }
  return m;
}
void main() {
  vec3 d = normalize(vObj);
  float lon = atan(d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  vec2 uv = vec2(lon * 0.15915494 + 0.5, 0.5 - lat * 0.31830989);
  float dist = texture2D(uCoastT, uv).r;
  if (uLodOn > 0.5) {
    // §26 coastline LOD: the zoomed window's own (1:10m) coast distances
    float rl = lon - uLodBox.x;
    rl = rl > 3.14159265 ? rl - 6.2831853 : rl < -3.14159265 ? rl + 6.2831853 : rl;
    vec2 luv = vec2((rl - uLodBox.y) / uLodBox.z, (uLodBox2.x - lat) / uLodBox2.y);
    if (luv.x > 0.002 && luv.x < 0.998 && luv.y > 0.002 && luv.y < 0.998) dist = texture2D(uCoastL, luv).r;
  }
  dist *= max(uDS, 1.0);
  float fd = max(fwidth(dist), 1e-5);
  float shallow = 1.0 - smoothstep(0.0, 0.16, dist);
  vec3 col = mix(uSeaDeep, uSeaShal, shallow);
  vec3 sh = mix(uSeaDeepSh, uSeaShalSh, shallow);
  // 等深線: three thin rings hugging the coasts, fading out to sea
  float cl = max(lineAt(dist, 0.04, fd * 0.8, fd) * 0.32, lineAt(dist, 0.09, fd * 0.7, fd) * 0.16);
  col = mix(col, uSeaLine, cl);
  sh = mix(sh, uSeaLine * 0.88, cl);
  // wave marks (open water only)
  float wm = waveMarks(d) * smoothstep(0.06, 0.1, dist) * uWaveA;
  col = mix(col, uSeaWave, wm * 0.55);
  sh = mix(sh, uSeaWave * 0.82, wm * 0.5);
  // foam: a soft white band on the shore and a crisp line just off it
  float band = 1.0 - smoothstep(0.0015, 0.0075, dist);
  float fl = lineAt(dist, 0.0125, fd * 1.1, fd);
  float foam = max(band * 0.75, fl * 0.7);
  col = mix(col, uFoam, foam);
  sh = mix(sh, mix(sh, uFoam, 0.55), foam);
  gl_FragColor = vec4(toon(col, sh, normalize(vN), normalize(-vView), 0.0) * uSeaK, 1.0);
}
`;

/**
 * §26 sea areas: money that has no place on land (bonds, cash, crypto …) is a tinted stretch of the ocean in its
 * weather colour — the waves still show through — with a dashed chart line (SEALINE) around it.
 */
export const SEAAREA_VS = /* glsl */ `
attribute float aTerr;
uniform vec4 uInfo[${MAXT}];
uniform vec4 uInfo2[${MAXT}];
varying vec3 vDir;
varying vec3 vN;
varying vec3 vView;
varying vec4 vInfo;
varying vec4 vInfo2;
void main() {
  int k = int(aTerr + 0.5);
  vInfo = uInfo[k];
  vInfo2 = uInfo2[k];
  vec3 d = normalize(position);
  vDir = d;
  vN = normalize(normalMatrix * d);
  vec4 mv = modelViewMatrix * vec4(d * ${(SEA_R + 0.0005).toFixed(5)}, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
export const SEAAREA_FS = /* glsl */ `
uniform vec3 uBands[9];
uniform vec3 uBandsSh[9];
uniform float uEdges[8];
uniform vec3 uSeaShal;
uniform vec3 uFoam;
uniform vec3 uDimCol;
uniform vec3 uHatch;
uniform vec3 uInk;
uniform float uPR;
uniform float uTime;
uniform float uWS;
uniform float uA;
uniform float uRise;
varying vec3 vDir;
varying vec3 vN;
varying vec3 vView;
varying vec4 vInfo;
varying vec4 vInfo2;
${GLSL_TOON}
vec3 bandOf(float T, bool sh) {
  vec3 c = sh ? uBandsSh[0] : uBands[0];
  for (int i = 0; i < 8; i++) c = mix(c, sh ? uBandsSh[i + 1] : uBands[i + 1], step(uEdges[i], T));
  return c;
}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = bandOf(vInfo2.x, false), sh = bandOf(vInfo2.x, true);
  // §26 water stays water: the weather colour is mixed into the ocean at ≤ 25 %, and a neutral-temperature sea area
  // (the 生成り band) gets no tint at all — just its swell lines and the dashed chart line
  float band = 0.0;
  for (int i = 0; i < 8; i++) band += step(uEdges[i], vInfo2.x);
  float tint = abs(band - 4.0) < 0.5 ? 0.0 : 0.25;
  // a current: thin parallel swell lines drifting slowly (the sea keeps moving, the colour says the weather)
  float lat = asin(clamp(d.y, -1.0, 1.0)), lon = atan(d.x, d.z);
  float ws = max(uWS, 1e-3);
  float ph = (lat * 1.0 + lon * cos(lat) * 0.35) / (0.018 * ws) + uTime * 0.12;
  float fp = max(fwidth(ph), 1e-4);
  float sw = 1.0 - smoothstep(0.06, 0.06 + fp * 1.3, abs(fract(ph) - 0.5));
  // estimate: the paper hatch
  float hat = 0.0;
  if (vInfo.z > 0.5) {
    float s = (gl_FragCoord.x + gl_FragCoord.y) / (7.0 * uPR);
    float fs = max(fwidth(s), 1e-4);
    hat = (1.0 - smoothstep(0.14, 0.14 + fs * 1.2, abs(fract(s) - 0.5))) * 0.3;
  }
  col = mix(col, uDimCol, vInfo.y * 0.72);
  col = mix(col, vec3(1.0), clamp(vInfo.w, 0.0, 1.0) * 0.12);
  vec3 c = toon(col, mix(sh, col, 0.35), normalize(vN), normalize(-vView), 0.0);
  float ta = (tint + 0.06 * clamp(vInfo.w, 0.0, 1.0)) * (1.0 - 0.6 * vInfo.y);
  float swa = sw * 0.42, ha = hat;
  float a = max(max(ta, swa), ha);
  vec3 o = c;
  o = mix(o, uFoam, swa / max(a, 1e-3) * (1.0 - ta * 0.5));
  o = mix(o, uHatch, ha / max(a, 1e-3) * 0.6);
  a *= uA * clamp(uRise * 1.4, 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(o, a);
}
`;
export const SEALINE_VS = /* glsl */ `
attribute float aDist;
varying float vDist;
varying float vFace;
void main() {
  vec3 p = normalize(position) * ${(SEA_R + 0.0009).toFixed(5)};
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFace = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  vDist = aDist;
  gl_Position = projectionMatrix * mv;
}
`;
export const SEALINE_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
uniform float uDash;
uniform float uRise;
varying float vDist;
varying float vFace;
void main() {
  if (fract(vDist / uDash) > 0.55) discard;
  gl_FragColor = vec4(uCol, uA * smoothstep(0.08, 0.3, vFace) * clamp(uRise * 1.4, 0.0, 1.0));
}
`;
/**
 * §26 companies at their HQs: crisp screen-space markers (a weather-coloured dot, an ink ring, a thin paper halo
 * so they read on any ground), sized in px by money; aOff fans a crowded city out into a tidy cluster.
 */
export const POINT_VS = /* glsl */ `
attribute vec3 aDir;
attribute float aK;
attribute float aSize;
attribute vec2 aOff;
uniform vec4 uInfo[${MAXT}];
uniform vec4 uInfo2[${MAXT}];
uniform vec2 uRes;
uniform float uPR;
uniform float uLift;
uniform float uGround;
varying vec2 vUv;
varying float vT;
varying vec4 vInfo;
varying float vR;
varying float vFace;
void main() {
  int k = int(aK + 0.5);
  vInfo = uInfo[k];
  vT = uInfo2[k].x;
  vec3 d = normalize(aDir);
  vec4 mv = modelViewMatrix * vec4(d * (1.0 + uGround + uLift), 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFace = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  vec4 clip = projectionMatrix * mv;
  float r = aSize * (1.0 + 0.3 * clamp(vInfo.w, 0.0, 1.0)) * uPR;
  vR = r;
  vUv = position.xy;
  clip.xy += (position.xy * (r + 1.6 * uPR) + aOff * uPR) * 2.0 / uRes * clip.w;
  if (vFace < 0.06) clip = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = clip;
}
`;
export const POINT_FS = /* glsl */ `
uniform vec3 uBands[9];
uniform float uEdges[8];
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec3 uDimCol;
uniform float uPR;
uniform float uA;
varying vec2 vUv;
varying float vT;
varying vec4 vInfo;
varying float vR;
varying float vFace;
void main() {
  float R = vR + 1.6 * uPR;
  float d = length(vUv) * R;
  vec3 col = uBands[0];
  for (int i = 0; i < 8; i++) col = mix(col, uBands[i + 1], step(uEdges[i], vT));
  col = mix(col, uDimCol, vInfo.y * 0.72);
  float ink = 1.25 * uPR;
  float aa = 0.75;
  float fill = 1.0 - smoothstep(vR - ink - aa, vR - ink + aa, d);
  float ring = 1.0 - smoothstep(vR - aa, vR + aa, d);
  float halo = 1.0 - smoothstep(R - aa * 1.2, R, d);
  vec3 c = mix(uPaper, uInk, ring);
  c = mix(c, col, fill);
  // a tiny highlight: a printed bead, not a glow
  c = mix(c, vec3(1.0), fill * (1.0 - smoothstep(0.0, vR * 0.45, length(vUv * R - vec2(-0.3, 0.32) * vR))) * 0.22);
  float a = halo * uA * smoothstep(0.06, 0.2, vFace) * (1.0 - 0.45 * vInfo.y);
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}
`;

/** §26 producing-region hints of a sea area (oil → Permian …): faint dashed rings, shown for the hovered / ①②③ one. */
export const HINT_VS = /* glsl */ `
attribute vec3 aDir;
attribute float aK;
uniform vec4 uInfo[${MAXT}];
uniform vec2 uRes;
uniform float uPR;
uniform float uGround;
varying vec2 vUv;
varying float vA;
void main() {
  int k = int(aK + 0.5);
  vA = smoothstep(0.25, 0.9, uInfo[k].w);
  vec3 d = normalize(aDir);
  vec4 mv = modelViewMatrix * vec4(d * (1.0 + uGround + 0.002), 1.0);
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float face = dot(normalize(mv.xyz - c), normalize(-mv.xyz));
  vec4 clip = projectionMatrix * mv;
  vUv = position.xy;
  clip.xy += position.xy * 9.0 * uPR * 2.0 / uRes * clip.w;
  if (face < 0.1 || vA < 0.01) clip = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = clip;
}
`;
export const HINT_FS = /* glsl */ `
uniform vec3 uInk;
uniform float uA;
varying vec2 vUv;
varying float vA;
void main() {
  float r = length(vUv);
  float ring = 1.0 - smoothstep(0.08, 0.16, abs(r - 0.7));
  float ang = atan(vUv.y, vUv.x);
  float dash = step(0.0, sin(ang * 6.0));
  float dot0 = 1.0 - smoothstep(0.12, 0.2, r);
  float a = max(ring * dash, dot0) * vA * uA * 0.6;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uInk, a);
}
`;

/** Generic 2-tone toon for props (clouds, arc, arrow head). The 主航道 body carries 2–3 slow comets. */
export const PROP_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec2 vUv;
varying vec3 vObj;
void main() {
  vUv = uv;
  vObj = position;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
export const PROP_FS = /* glsl */ `
uniform vec3 uLit;
uniform vec3 uShade;
uniform float uA;
uniform float uFlow;
uniform vec3 uFlowCol;
uniform float uTime;
uniform float uProg;
uniform float uFlash;
varying vec3 vN;
varying vec3 vView;
varying vec2 vUv;
varying vec3 vObj;
uniform vec3 uL;
uniform vec3 uRimCol;
uniform float uRimAmt;
void main() {
  if (uProg < 1.0 && vUv.x > uProg) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(-vView);
  float ndl = dot(N, uL);
  float fl = max(fwidth(ndl), 1e-4);
  vec3 c = mix(uShade, uLit, smoothstep(0.05 - fl, 0.05 + fl, ndl));
  if (uFlow > 0.0) {
    // comets: a short lighter streak with a crisp head and a soft tail, travelling slowly toward the head
    float s = vUv.x * uFlow - uTime * 0.16;
    float f = fract(s);
    float fs = max(fwidth(s), 1e-4);
    float duty = 0.12;
    float com = smoothstep(0.0, duty, f) * (1.0 - smoothstep(duty, duty + fs * 1.5, f));
    vec3 cc = mix(uFlowCol * mix(0.86, 1.0, step(0.05, ndl)), uFlowCol, 0.5);
    c = mix(c, cc, com * smoothstep(0.04, 0.12, vUv.x));
  }
  float e = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  float fr = max(fwidth(e), 1e-4);
  float rim = smoothstep(0.8 - fr, 0.8 + fr, e) * smoothstep(-0.1, 0.3, ndl);
  c = mix(c, uRimCol, rim * uRimAmt * 0.8);
  c = mix(c, vec3(1.0, 0.97, 0.86), uFlash * 0.35);
  gl_FragColor = vec4(c, uA);
}
`;

/** Full-screen paper / night sky, with a soft paper drop-shadow under the planet. */
export const SKY_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
/**
 * §26 paper veil: on a zoomed real Earth the map runs under the shell's chrome (top bar, gauges); a feathered patch
 * of the sky paper behind them keeps that text legible. uRects: CSS-px boxes (x0, y0, x1, y1) from the top-left.
 */
export const VEIL_FS = /* glsl */ `
uniform vec3 uSky0;
uniform vec3 uSky1;
uniform vec2 uRes;
uniform vec3 uPlanet;
uniform vec4 uRects[4];
uniform float uN;
uniform float uPR;
uniform float uA;
varying vec2 vUv;
void main() {
  vec2 px = vUv * uRes;
  float d = length(px - uPlanet.xy) / max(uRes.x, uRes.y);
  vec3 col = mix(uSky0, uSky1, smoothstep(0.0, 0.85, d));
  vec2 p = vec2(px.x, uRes.y - px.y) / uPR;
  float m = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uN) break;
    vec4 r = uRects[i];
    vec2 q = max(vec2(r.x - p.x, r.y - p.y), vec2(p.x - r.z, p.y - r.w));
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    m = max(m, 1.0 - smoothstep(-6.0, 26.0, sd));
  }
  float a = m * uA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}
`;

export const SKY_FS = /* glsl */ `
uniform vec3 uSky0;
uniform vec3 uSky1;
uniform vec2 uRes;
uniform vec3 uPlanet;
uniform float uStars;
uniform float uA;
uniform float uDropA;
uniform vec3 uDrop;
uniform vec4 uAtmo;
uniform vec3 uAtmoLit;
uniform vec3 uAtmoSh;
uniform vec2 uLdir;
uniform vec2 uAtmoT;
uniform float uTime;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 px = vUv * uRes;
  vec2 c = vec2(uPlanet.x, uPlanet.y);
  float d = length(px - c) / max(uRes.x, uRes.y);
  vec3 col = mix(uSky0, uSky1, smoothstep(0.0, 0.85, d));
  // washi fibres / night grain (backdrop only)
  float n = hash(floor(px / 1.5));
  float n2 = hash(floor(px / 7.0) + 13.1);
  col *= 1.0 - (uStars > 0.5 ? -1.0 : 1.0) * (pow(n, 7.0) * 0.06 + n2 * 0.012);
  // paper drop shadow under the planet (day) / a faint halo of dark (night)
  float pd = length(px - c - vec2(uPlanet.z * 0.03, -uPlanet.z * 0.045)) - uPlanet.z * 1.0;
  float drop = 1.0 - smoothstep(-uPlanet.z * 0.04, uPlanet.z * 0.09, pd);
  col = mix(col, uDrop, drop * uDropA);
  // atmosphere: a flat 2-tone band hugging the planet's ink line (lit toward the sun, thinner on the shade
  // side). With the 'liquidity' overlay it is the air-pressure band (水位): thickness grows with |pressure|,
  // 若竹 = 放水, 臙脂 = 收水, short radial isobar ticks (more with |pressure|), and two thin pressure rings
  // drifting inward (pressure up / 放水) or outward (pressure down / 收水) — at half contrast when calm.
  // uAtmo = (width, alpha, signed drift: sign = inward(+)/outward(−), |·| = ring contrast, r0 = inner radius)
  if (uAtmo.y > 0.001) {
    vec2 dv = px - c;
    float rr = length(dv) / max(uPlanet.z, 1.0);
    float fr = max(fwidth(rr), 1e-4);
    float sd = dot(dv / max(length(dv), 1e-3), uLdir);
    float lit = smoothstep(-0.3 - fr * 8.0, -0.3 + fr * 8.0, sd);
    float r0 = uAtmo.w, r1 = r0 + uAtmo.x * mix(0.62, 1.0, lit);
    float band = smoothstep(r0 - fr, r0 + fr, rr) * (1.0 - smoothstep(r1 - fr, r1 + fr, rr));
    vec3 bc = mix(uAtmoSh, uAtmoLit, lit);
    col = mix(col, bc, band * uAtmo.y);
    float lineC = 0.0;
    if (uAtmo.z != 0.0) {
      float k = abs(uAtmo.z);
      float rings = 0.0;
      for (int i = 0; i < 2; i++) {
        float ph = fract(uTime * 0.11 * k * -sign(uAtmo.z) + float(i) * 0.5);
        float rc = r0 + (r1 - r0) * (0.15 + 0.7 * ph);
        float w = fr * 1.3;
        rings = max(rings, (1.0 - smoothstep(w * 0.5, w * 0.5 + fr, abs(rr - rc))) * sin(ph * 3.14159));
      }
      lineC = max(lineC, rings * k);
    }
    if (uAtmoT.x > 0.5) {
      // isobar ticks: short radial strokes across the middle of the band
      float a = atan(dv.y, dv.x) / 6.28318 * uAtmoT.x;
      float fa = uAtmoT.x / 6.28318 / max(length(dv), 1.0); // one pixel, in tick units (no seam at ±π)
      float t = abs(fract(a + 0.5) - 0.5);
      float tick = 1.0 - smoothstep(fa * 0.55, fa * 1.35, t);
      float mid = smoothstep(r0 + (r1 - r0) * 0.2, r0 + (r1 - r0) * 0.28, rr) * (1.0 - smoothstep(r0 + (r1 - r0) * 0.72, r0 + (r1 - r0) * 0.8, rr));
      col = mix(col, uAtmoSh * 0.8, tick * mid * uAtmoT.y * band * uAtmo.y);
    }
    col = mix(col, mix(bc, uSky0, 0.6), lineC * band * uAtmo.y * 0.85);
  }
  // night: tiny sparse dots only, and an empty sky around the planet
  if (uStars > 0.5) {
    vec2 cell = floor(px / 38.0);
    float h = hash(cell);
    if (h > 0.62) {
      vec2 sp = (cell + vec2(hash(cell + 1.7), hash(cell + 3.1))) * 38.0;
      float m = pow(hash(cell + 9.2), 2.5);
      float dot0 = 1.0 - smoothstep(0.35, 0.9, length(px - sp));
      float keep = smoothstep(uPlanet.z * 1.3, uPlanet.z * 1.45, length(sp - c));
      col = mix(col, vec3(0.94, 0.91, 0.84), dot0 * (0.25 + m * 0.45) * keep);
    }
  }
  gl_FragColor = vec4(col, uA);
}
`;

/** Wind strokes: tapered ribbons lying on the surface, ink on light ground and paper on dark ground. */
export const WIND_VS = /* glsl */ `
attribute float aA;
attribute float aC;
varying float vA;
varying float vC;
void main() {
  vA = aA; vC = aC;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const WIND_FS = /* glsl */ `
uniform vec3 uInkC;
uniform vec3 uPaperC;
uniform vec3 uInC;
uniform vec3 uOutC;
uniform float uAlpha;
varying float vA;
varying float vC;
void main() {
  // vC: 0 ink, 1 paper (dark ground), 2 若竹 (heading into an inflow territory), 3 臙脂 (leaving an outflow one)
  float a = vA * uAlpha * (vC > 0.5 && vC < 1.5 ? 1.45 : 1.0);
  if (a < 0.003) discard;
  vec3 c = vC < 0.5 ? uInkC : vC < 1.5 ? uPaperC : vC < 2.5 ? uInC : uOutC;
  gl_FragColor = vec4(c, min(a, 0.92));
}
`;

/** Decal shadows and surface ribbons. */
export const DECAL_VS = /* glsl */ `
attribute float aA;
varying vec2 vUv;
varying float vA;
void main() {
  vUv = uv; vA = aA;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const DECAL_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
uniform float uSoft;
uniform float uProg;
varying vec2 vUv;
varying float vA;
void main() {
  if (uProg < 1.0 && vUv.x > uProg) discard;
  float e = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float a = uSoft > 0.0 ? smoothstep(0.0, uSoft, e) : 1.0;
  gl_FragColor = vec4(uCol, uA * a * vA);
}
`;

/** Rain: short neat diagonal strokes falling (in screen-down direction) under a storm cloud. */
export const RAIN_VS = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uDown;
uniform vec3 uSide;
uniform float uFall;
uniform float uLen;
uniform float uWid;
varying float vA;
varying float vT;
void main() {
  float ph = fract(uTime * (0.9 + aSeed.w * 0.5) + aSeed.z);
  vec3 base = vec3(aSeed.x, 0.0, aSeed.y);
  vec3 slant = normalize(uDown + uSide * 0.325); // tan 18°
  vec3 p = base + slant * (ph * uFall) + slant * (position.y * uLen) + uSide * position.x * uWid;
  vA = sin(ph * 3.14159);
  vT = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
export const RAIN_FS = /* glsl */ `
uniform vec3 uCol;
uniform float uA;
varying float vA;
varying float vT;
void main() { gl_FragColor = vec4(uCol, uA * vA); }
`;
