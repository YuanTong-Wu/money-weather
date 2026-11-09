// planet/theme.js — §17 art direction: Japanese clean-cartoon palettes (day = warm paper, night = 紺 navy).
// Muted traditional colours: 藍 indigo / 浅葱 asagi (cold) → 生成り kinari (neutral) → 山吹 yamabuki →
// 柿 persimmon → 朱 vermilion (hot). Inflow 若竹 green, outflow 臙脂 crimson-brown. No neon, no glow.

import { clamp } from './util.js';

/** §26 refine: the real Earth's unclaimed land (2D planet.js / freecam2d.js; 3D should match: planet3d/core.js
 *  realNeutral) — cooler and lower than 生成り so a neutral-weather territory never vanishes into it.
 *  §26 amendment 5: one value for both renderers — night is the dusk grey-beige of 3D (#8a8577, on a navy sea). */
export const REAL_LAND = { day: '#dbdad3', night: '#8a8577' };
/** (its shadow tone: the dot screen's ink and the toon shade — 3D realNeutralSh) */
export const REAL_LAND_SH = { day: '#cecdc5', night: '#757062' };

/** Temperature band edges (isotherms). Values between two edges share one flat colour (cel look).
 *  §26 amendment 5: stored as float32 values — the temperatures live in Float32Arrays (2D) and the 3D shader compares
 *  float32 to float32, so a value that sits exactly on an edge (欧洲 1.05) lands in the same band in both. */
export const BAND_EDGES = [-2.6, -1.8, -1.05, -0.4, 0.4, 1.05, 1.8, 2.6].map(Math.fround);
/** Representative temperature of each band (BAND_EDGES.length + 1 bands). */
export const BAND_MID = [-3, -2.2, -1.4, -0.7, 0, 0.7, 1.4, 2.2, 3];

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbStr = (c, a = 1) => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);
const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

function make(def) {
  const t = Object.assign({}, def);
  t.bandRGB = def.bands.map(hex);
  t.bandCSS = t.bandRGB.map((c) => rgbStr(c));
  // a band counts as "dark" when cream wind-lines read better on it than ink ones
  t.bandDark = Uint8Array.from(t.bandRGB.map((c) => (lum(c) < def.darkLum ? 1 : 0)));
  t.inkRGB = hex(def.ink);
  t.paperRGB = hex(def.paper);
  t.inRGB = hex(def.in);
  t.outRGB = hex(def.out);
  t.goldRGB = hex(def.gold);
  t.coldRGB = hex(def.cold);
  t.hotRGB = hex(def.hot);
  t.rgba = rgbStr;
  return t;
}

/** The day weather colours (§17 ramp; 生成り #f0e3c3, §26 refine). */
const DAY_BANDS = ['#263e63', '#33628a', '#5895ab', '#a4c8c2', '#f0e3c3', '#f1cf8e', '#e9a643', '#d96f3c', '#b43d2c'];
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** §26 amendment 5: night = the same lit paper a little dimmer — every weather colour is the day colour × 0.86, 4 %
 *  toward 紺 #1c2a48 (planet3d/core.js look() bandTone, both renderers, 真实 and 抽象). */
export function nightTone(h, k = 0.86, t = 0.04) {
  const c = hex(h), n = [28, 42, 72];
  return toHex(c.map((v, i) => v * k * (1 - t) + n[i] * t));
}

/**
 * §26 amendment 5: the sea and the unclaimed land of one picture, 2D and 3D (planet3d/core.js look(): seaDeep …,
 * neutral, realNeutral, realSea). real = the real Earth (its own navy night sea), else an abstract planet.
 * deep / shal (by coast distance), deepSh / shalSh (the toon shadow), line (等深線), wave (wave marks), foam, land / landSh.
 */
export function seaLook(name, real) {
  const day = name !== 'night';
  if (day) {
    return {
      deep: '#bcd5d6', shal: '#d8e9e5', deepSh: '#98b6bc', shalSh: '#b4ccca', line: '#8daeb5', wave: '#7fa3ad', foam: '#f8faf4',
      land: real ? REAL_LAND.day : '#e0ddd3', landSh: real ? REAL_LAND_SH.day : '#c3bfb2', dot: real ? 0.5 : 1,
    };
  }
  if (real) {
    return {
      deep: '#22385a', shal: '#2e4a6e', deepSh: '#1b2e4c', shalSh: '#253f60', line: '#4d6c90', wave: '#58789c', foam: '#a3b5c6',
      land: REAL_LAND.night, landSh: REAL_LAND_SH.night, dot: 0.4,
    };
  }
  // an abstract planet by night: the same paper planet, a touch dimmer (3D nightTone: lit × 0.95, shadows × 0.9 → 紺)
  const lit = (h) => nightTone(h, 0.95, 0), sh = (h) => nightTone(h, 0.9, 0.05);
  return {
    deep: lit('#bcd5d6'), shal: lit('#d8e9e5'), deepSh: sh('#98b6bc'), shalSh: sh('#b4ccca'), line: lit('#8daeb5'), wave: lit('#7fa3ad'), foam: lit('#f8faf4'),
    land: lit('#e0ddd3'), landSh: sh('#c3bfb2'), dot: 1,
  };
}

export const THEMES = {
  day: make({
    name: 'day',
    // sky: warm washi paper
    sky0: '#f6f1e6', sky1: '#ece4d3', grainA: 0.05,
    ink: '#1f2a44', inkSoft: 'rgba(31,42,68,0.62)', inkFaint: 'rgba(31,42,68,0.38)',
    paper: '#fbf8f1',
    bezel: 'rgba(31,42,68,0.15)', bezelStrong: 'rgba(31,42,68,0.32)',
    drop: 'rgba(92,74,40,0.13)',
    // planet surface
    // (生成り #f0e3c3: §26 refine — a touch lighter and warmer than the old #ece2cb, so a neutral-weather region reads
    // as claimed land against the real Earth's cooler, lower unclaimed paper #dbdad3: ΔE ≈ 15, was 9.5 at 1.03:1)
    bands: DAY_BANDS,
    darkLum: 0.42,
    bandShadow: 'rgba(40,36,30,0.16)',
    border: 'rgba(252,249,242,0.95)', borderShade: 'rgba(31,42,68,0.13)',
    iso: 'rgba(31,42,68,0.20)', isoHi: 'rgba(120,42,30,0.30)', isoLo: 'rgba(38,62,99,0.26)',
    terminator: 'rgba(28,36,64,0.13)', rim: 'rgba(255,253,247,0.9)', outline: '#22304d', // (outline: 3D's limb ink)
    atlas: '#22304d', // (§26 amendment 5: 3D's outline ink — country / state / province lines)
    lensDim: 'rgba(236,228,211,0.72)', // (3D: 72 % toward the paper)
    hoverWash: 'rgba(255,253,247,0.16)', hoverLine: 'rgba(31,42,68,0.75)',
    // wind lines
    windInk: [38, 54, 88], windPaper: [255, 252, 244], windAlpha: 0.7,
    // accents
    in: '#4f8f5c', out: '#a33d45', gold: '#d9a23a', cold: '#33628a', hot: '#c2492f',
    rain: 'rgba(38,62,99,0.62)',
    stormCloud: { base: '#8d96a7', shade: '#6c768a', line: 'rgba(31,42,68,0.55)', hi: '#a9b1bf' },
    skyCloud: { base: '#ffffff', shade: '#dfe4ec', line: 'rgba(31,42,68,0.42)', hi: '#ffffff' },
    bolt: '#f2c14e', boltLine: '#1f2a44',
    // labels / cards
    label: '#1f2a44', labelSoft: 'rgba(31,42,68,0.72)', halo: 'rgba(251,248,241,0.92)',
    // labels on the lit planet surface: ink on light ground, knock-out paper on dark ground
    surfInk: '#1f2a44', surfInkSoft: 'rgba(31,42,68,0.74)', surfHalo: 'rgba(251,248,241,0.9)',
    surfInkDark: '#fbf8f1', surfInkDarkSoft: 'rgba(251,248,241,0.86)', surfHaloDark: 'rgba(22,34,60,0.62)',
    card: '#fbf8f1', cardLine: 'rgba(31,42,68,0.2)', cardShadow: 'rgba(31,42,68,0.10)', cardText: '#1f2a44', cardMuted: 'rgba(31,42,68,0.7)',
    badge: '#1f2a44', badgeText: '#fbf8f1',
    // 主航道 ribbon
    chan: '#22304f', chanCase: '#fbf8f1', chanWake: 'rgba(251,248,241,0.42)', chanFlow: 'rgba(251,248,241,0.92)', chanShadow: 'rgba(31,42,68,0.18)',
    // 主航道 caption: a light paper card with ink text and a navy-outline tag (as in 3D) — the arrow stays
    // the heaviest object; never a dark slab, never 若竹 green
    chanInk: '#22304f',
    hatch: 'rgba(31,42,68,0.21)',
  }),
  night: make({
    name: 'night',
    sky0: '#1d2643', sky1: '#121831', grainA: 0.035,
    ink: '#efe7d6', inkSoft: 'rgba(239,231,214,0.66)', inkFaint: 'rgba(239,231,214,0.4)',
    paper: '#1a2238',
    bezel: 'rgba(239,231,214,0.13)', bezelStrong: 'rgba(239,231,214,0.28)',
    drop: 'rgba(4,7,18,0.45)',
    // §26 amendment 5: the day colours toned × 0.86 (as 3D) — was a hand-picked set (生成り #b4ac98, 柿 #c4603a …)
    bands: DAY_BANDS.map((h) => nightTone(h)),
    darkLum: 0.42, // (3D DARK_LUM: the same knock-out text on the same colours)
    bandShadow: 'rgba(8,10,22,0.24)',
    border: 'rgba(242,239,232,0.9)', borderShade: 'rgba(8,12,26,0.25)', // (border: 3D's night paper rim, #fffcf4 × 0.95)
    iso: 'rgba(16,22,44,0.30)', isoHi: 'rgba(90,26,18,0.40)', isoLo: 'rgba(14,30,58,0.40)',
    terminator: 'rgba(10,14,34,0.30)', rim: 'rgba(250,240,218,0.75)', outline: '#646363', // (3D's night limb: a dusk grey)
    atlas: '#646363', // (3D's night outline: #101629 → #d9cdb3 at 42 %)
    lensDim: 'rgba(224,217,200,0.72)', // (§26 amendment 5: 3D dims into the night paper, #ece4d3 × 0.95, not into navy)
    hoverWash: 'rgba(255,250,236,0.14)', hoverLine: 'rgba(250,242,224,0.9)',
    windInk: [24, 30, 54], windPaper: [252, 246, 232], windAlpha: 0.7,
    in: '#7fbf8a', out: '#e07c7f', gold: '#e6b85a', cold: '#7fb0c8', hot: '#e78a5c',
    rain: 'rgba(196,220,240,0.6)',
    stormCloud: { base: '#5d6680', shade: '#454d66', line: 'rgba(8,12,26,0.7)', hi: '#737c95' },
    skyCloud: { base: '#e9e6df', shade: '#b9bdca', line: 'rgba(8,12,26,0.55)', hi: '#f6f3ec' },
    bolt: '#f2c14e', boltLine: '#141a2e',
    label: '#f6efe0', labelSoft: 'rgba(246,239,224,0.75)', halo: 'rgba(20,26,46,0.88)',
    surfInk: '#18203a', surfInkSoft: 'rgba(24,32,58,0.78)', surfHalo: 'rgba(206,198,178,0.85)',
    surfInkDark: '#f6efe0', surfInkDarkSoft: 'rgba(246,239,224,0.86)', surfHaloDark: 'rgba(14,20,40,0.66)',
    card: '#222b45', cardLine: 'rgba(239,231,214,0.2)', cardShadow: 'rgba(0,0,0,0.3)', cardText: '#f3ecdc', cardMuted: 'rgba(243,236,220,0.72)',
    badge: '#efe7d6', badgeText: '#1a2238',
    chan: '#f3ead6', chanCase: '#141a2e', chanWake: 'rgba(20,26,46,0.4)', chanFlow: 'rgba(26,34,56,0.9)', chanShadow: 'rgba(0,0,0,0.35)',
    chanInk: '#f3ecdc',
    hatch: 'rgba(31,42,68,0.21)', // (3D: the same ink hatch by night)
  }),
};

/** Band index for a temperature value (compared in float32, as the 3D shader's step(uEdges[i], T)). */
export function bandOf(t) {
  const f = Math.fround(t);
  let b = 0;
  while (b < BAND_EDGES.length && f >= BAND_EDGES[b]) b++;
  return b;
}

/** Flat colour for a temperature (band colour). */
export function tempCSS(theme, t, a = 1) {
  const c = theme.bandRGB[bandOf(clamp(Number.isFinite(t) ? t : 0, -3, 3))];
  return rgbStr(c, a);
}
