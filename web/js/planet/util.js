// planet/util.js — small deterministic helpers shared by the planet renderer (no DOM).

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** FNV-1a 32-bit string hash. */
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded PRNG in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded 2-D gradient noise (Perlin-style), returns roughly [-1,1]. */
export function makeNoise2(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256), gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2;
    gx[i] = Math.cos(a); gy[i] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const g00 = perm[X + perm[Y]], g10 = perm[X + 1 + perm[Y]];
    const g01 = perm[X + perm[Y + 1]], g11 = perm[X + 1 + perm[Y + 1]];
    const n00 = gx[g00] * xf + gy[g00] * yf;
    const n10 = gx[g10] * (xf - 1) + gy[g10] * yf;
    const n01 = gx[g01] * xf + gy[g01] * (yf - 1);
    const n11 = gx[g11] * (xf - 1) + gy[g11] * (yf - 1);
    const u = fade(xf), v = fade(yf);
    return 1.41 * ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v);
  };
}

// ---------------------------------------------------------------------------------------------
// Separable box blur on a Float32Array grid (G×G). Three passes ≈ gaussian with σ ≈ r.
export function boxBlur(src, G, r, passes = 3, tmp = null) {
  if (r < 1) return src;
  const a = src, b = tmp || new Float32Array(G * G);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    // horizontal a → b
    for (let y = 0; y < G; y++) {
      const row = y * G;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[row + clampI(k, 0, G - 1)];
      for (let x = 0; x < G; x++) {
        b[row + x] = acc * inv;
        acc += a[row + clampI(x + r + 1, 0, G - 1)] - a[row + clampI(x - r, 0, G - 1)];
      }
    }
    // vertical b → a
    for (let x = 0; x < G; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[clampI(k, 0, G - 1) * G + x];
      for (let y = 0; y < G; y++) {
        a[y * G + x] = acc * inv;
        acc += b[clampI(y + r + 1, 0, G - 1) * G + x] - b[clampI(y - r, 0, G - 1) * G + x];
      }
    }
  }
  return a;
}
const clampI = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Wrap text into lines that fit maxWidth (CJK aware: breaks between any characters). */
export function wrapText(ctx, text, maxWidth, maxLines = 3) {
  const lines = [];
  let cur = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur) {
      // avoid starting a line with punctuation
      if (/[，。！？、；：,.!?;:）)」』]/.test(ch)) { cur = test; continue; }
      // keep latin words together when possible
      const m = cur.match(/^(.*[^A-Za-z0-9.%+-])([A-Za-z0-9.%+-]+)$/);
      if (m && /[A-Za-z0-9.%+-]/.test(ch) && m[1].length > 0) {
        lines.push(m[1]); cur = m[2] + ch;
      } else {
        lines.push(cur); cur = ch;
      }
      if (lines.length === maxLines) break;
    } else cur = test;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines && cur) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
