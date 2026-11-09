// planet/puffs.js — §26 amendment 5 (2D = the 3D planet flattened): the 3D weather props, drawn flat.
//
// The 3D clouds are toon-shaded meshes (planet3d/assets.js puffCloud: five lumpy cumuli, seeds 1–5, chosen per territory
// as geos[(k·7 + i) % 5]; one storm cloud, seed 11), upright to the viewer, an ink hull 1.7 px (day) / 1.5 px (night),
// lit / shade split at N·L = 0.05 with the planet's one light (upper left, a little in front), a light rim, and a flat
// round shadow on the ground (radius 0.3 × size, 0.25 × size away from the light; a 45 % step toward the ground's own
// shade — barely there). This module rebuilds the same puffs (same random sequence, same flattened base, same width-1
// normalisation), shades them per pixel once per theme × shape at a reference width, and draws them at any size with a
// crisp ink hull; the box it returns is the drawn shape (labels / props keep clear of what is really drawn).
//
//   puffBox(kind, variant, w)                  → {x0, x1, y0, y1} around the base centre (px; y down), w = drawn width
//   drawPuff(ctx, theme, dpr, kind, variant, bx, by, w, alpha, shadow)   → the drawn box (screen px) | null
//   drawIntelArc(ctx, pts, dir, fresh, theme, now, wsPx)   the 3D 预期风 ribbon (thin dashes, a small head) along pts
//   CLOUD_VARIANTS = 5

export const CLOUD_VARIANTS = 5;
const LIGHT = (() => { const l = Math.hypot(-0.62, 0.55, 0.28); return [-0.62 / l, 0.55 / l, 0.28 / l]; })(); // (planet3d/core.js LIGHT)
const LOOK = {
  // (planet3d/core.js look: cloud / storm lit · shade · line, rim + rimAmt; hull px = uHullW)
  day: { sky: { shade: '#dbe0e6', line: '#5b6680' }, storm: { lit: '#8d96a7', shade: '#6c768a', line: '#2a3450' }, rim: '#fffdf6', rimAmt: 0.48, hull: 1.7 },
  night: { sky: { shade: '#c3c5cb', line: '#0b1020' }, storm: { lit: '#8790ab', shade: '#6b7491', line: '#090d1a' }, rim: '#fbf2dc', rimAmt: 0.42, hull: 1.5 },
};
const REF = 224; // reference body width (device px) — shaded once per theme × shape, scaled when drawn

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
const hex = (h) => { const v = parseInt(String(h).replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const css2rgb = (c) => {
  const s = String(c || '').trim();
  if (s[0] === '#') return hex(s.length === 4 ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s);
  const m = s.match(/rgba?\(([^)]+)\)/);
  return m ? m[1].split(',').slice(0, 3).map((v) => +v) : [255, 255, 255];
};

/**
 * The 3D puffCloud(seed, {storm}) as spheres in its own frame after the same flatten / normalise steps:
 * {S:[{x, y, z, r}] (original units), xc, yMin, w, storm, H (height / width)}. Same rng calls, in the same order.
 */
const shapes = new Map();
function puffShape(seed, storm) {
  const key = seed + (storm ? 's' : '');
  let sh = shapes.get(key);
  if (sh) return sh;
  const rnd = rng(seed * 7919 + 17);
  const S = [];
  const nBase = storm ? 5 : 3 + Math.floor(rnd() * 2);
  const spread = storm ? 0.5 : 0.42;
  for (let i = 0; i < nBase; i++) {
    const u = nBase === 1 ? 0 : i / (nBase - 1) - 0.5;
    const r = 0.2 + rnd() * 0.07 + (0.5 - Math.abs(u)) * 0.12;
    S.push({ x: u * spread * 2 * 0.9, y: r * 0.55, z: (rnd() - 0.5) * 0.14, r });
  }
  const nTop = storm ? 3 : 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < nTop; i++) {
    const r = 0.2 + rnd() * 0.08;
    const x = (rnd() - 0.5) * 0.36, y = 0.32 + rnd() * 0.12, z = (rnd() - 0.5) * 0.1;
    S.push({ x, y, z, r });
  }
  // flatten the underside (y < 0.05 → 0.05 + (y − 0.05)·0.18), a storm squashed to 0.78; base at 0, width 1
  const T = (y) => (y < 0.05 ? 0.05 + (y - 0.05) * 0.18 : y) * (storm ? 0.78 : 1);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of S) { x0 = Math.min(x0, s.x - s.r); x1 = Math.max(x1, s.x + s.r); y0 = Math.min(y0, T(s.y - s.r)); y1 = Math.max(y1, T(s.y + s.r)); }
  const w = x1 - x0;
  sh = { S, xc: (x0 + x1) / 2, yMin: y0, w, storm, H: (y1 - y0) / w, T };
  shapes.set(key, sh);
  return sh;
}
const shapeOf = (kind, variant) => (kind === 'storm' ? puffShape(11, true) : puffShape(1 + (((variant | 0) % CLOUD_VARIANTS) + CLOUD_VARIANTS) % CLOUD_VARIANTS, false));

/** Its silhouette as a Path2D in width units (base centre at 0, y DOWN): circles above the fold, squashed below. */
function silPath(sh) {
  if (sh.path) return sh.path;
  const p = new Path2D(), k = sh.storm ? 0.78 : 1, w = sh.w;
  // screen y (down) of an original y: −(T(y) − yMin) / w; x: (x − xc) / w
  const Y = (y) => -(((y < 0.05 ? 0.05 + (y - 0.05) * 0.18 : y) * k) - sh.yMin) / w;
  for (const s of sh.S) {
    const cx = (s.x - sh.xc) / w, r = s.r / w;
    const fold = 0.05;
    if (s.y - s.r >= fold) { p.moveTo(cx + r, Y(s.y)); p.ellipse(cx, Y(s.y), r, (s.r * k) / w, 0, 0, Math.PI * 2); continue; }
    // the part above the fold: a (storm-squashed) circle; below it: the same circle squashed 0.18 about the fold
    const ey = Y(fold) + (Y(s.y) - Y(fold)) * 0.18; // (the centre of the squashed lower ellipse)
    const dy = Math.max(-s.r, Math.min(s.r, fold - s.y));
    const a = Math.asin(dy / s.r); // fold angle (y up) on the original circle
    // canvas angles (y down): the upper arc runs from (π − … ) — draw the whole outline as one closed loop
    p.moveTo(cx + r * Math.cos(a), Y(fold));
    p.ellipse(cx, Y(s.y), r, (s.r * k) / w, 0, -a, Math.PI + a, true); // upper part (anticlockwise on screen = over the top)
    p.ellipse(cx, ey, r, ((s.r * k) / w) * 0.18, 0, Math.PI + a, -a, true); // lower squashed part
    p.closePath();
  }
  sh.path = p;
  return p;
}

/** The toon body (lit / shade / rim, no hull) of one shape and theme, REF device px wide, with an alpha mask. */
const bodies = new Map();
function bodyOf(theme, kind, variant, light) {
  const night = theme.name === 'night';
  const Lq = (light || LIGHT).map((v) => Math.round(v * 16) / 16); // (the light in a few steps between globe and map: few rebuilds)
  const key = (night ? 'n' : 'd') + kind + (kind === 'storm' ? '' : variant) + '|' + Lq.join(',');
  let b = bodies.get(key);
  if (b) return b;
  const sh = shapeOf(kind, variant), look = LOOK[night ? 'night' : 'day'];
  const lit = css2rgb(kind === 'storm' ? look.storm.lit : (theme.skyCloud && theme.skyCloud.base) || '#ffffff');
  const shade = hex(kind === 'storm' ? look.storm.shade : look.sky.shade), rim = hex(look.rim), rimK = look.rimAmt * 0.8;
  const W = REF, H = Math.ceil(REF * sh.H) + 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H), D = img.data;
  const k = sh.storm ? 0.78 : 1, SS = 3; // (3×3 samples a pixel: a clean edge and terminator)
  const ll = Math.hypot(Lq[0], Lq[1], Lq[2]) || 1, Lx = Lq[0] / ll, Ly = Lq[1] / ll, Lz = Lq[2] / ll;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    let cov = 0, cr = 0, cg = 0, cb = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = (px + (sx + 0.5) / SS) / W - 0.5, Yu = (H - 1 - (py + (sy + 0.5) / SS)) / W; // width units, y up from the base
      // back to the original frame: x, then y through the inverse squash / fold
      const x = X * sh.w + sh.xc;
      let y = (Yu * sh.w + sh.yMin) / k;
      const below = y < 0.05;
      if (below) y = 0.05 + (y - 0.05) / 0.18;
      let best = null, bz = -Infinity, bdx = 0, bdy = 0;
      for (const s of sh.S) {
        const dx = x - s.x, dy = y - s.y, q = s.r * s.r - dx * dx - dy * dy;
        if (q <= 0) continue;
        const z = s.z + Math.sqrt(q);
        if (z > bz) { bz = z; best = s; bdx = dx; bdy = dy; }
      }
      if (!best) continue;
      let nx = bdx / best.r, ny = bdy / best.r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      if (below) { nx *= 0.5; nz *= 0.5; ny = -0.85; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; }
      const ndl = nx * Lx + ny * Ly + nz * Lz;
      const t = ndl > 0.05 ? 1 : 0;
      let r0 = shade[0] + (lit[0] - shade[0]) * t, g0 = shade[1] + (lit[1] - shade[1]) * t, b0 = shade[2] + (lit[2] - shade[2]) * t;
      // rim light (3D PROP_FS): where the puff turns away from the viewer, on its lit side
      const e = 1 - Math.max(0, Math.min(1, nz));
      const rr = (e > 0.8 ? 1 : 0) * Math.max(0, Math.min(1, (ndl + 0.1) / 0.4)) * rimK;
      r0 += (rim[0] - r0) * rr; g0 += (rim[1] - g0) * rr; b0 += (rim[2] - b0) * rr;
      cov++; cr += r0; cg += g0; cb += b0;
    }
    if (!cov) continue;
    const o = (py * W + px) * 4;
    D[o] = cr / cov; D[o + 1] = cg / cov; D[o + 2] = cb / cov; D[o + 3] = (255 * cov) / (SS * SS);
  }
  g.putImageData(img, 0, 0);
  b = { c, W, H, sh, key };
  bodies.set(key, b);
  return b;
}

/** The drawn box of a prop of drawn width w (hull included), around its base centre: {x0, x1, y0, y1} (y down). */
export function puffBox(kind, variant, w) {
  const sh = shapeOf(kind, variant), hu = 1.7;
  return { x0: -w / 2 - hu, x1: w / 2 + hu, y0: -w * sh.H - hu, y1: hu };
}

/** One prop at size w (drawn width) on the screen: the cel body + ink hull composed once per size, then blitted. */
const sprites = new Map();
function spriteOf(theme, dpr, kind, variant, w, light) {
  const night = theme.name === 'night';
  const wq = w < 40 ? Math.round(w * 2) / 2 : Math.exp(Math.round(Math.log(w) / 0.012) * 0.012); // (size buckets: ½ px, then 1.2 %)
  const body = bodyOf(theme, kind, variant, light);
  const key = body.key + '|' + wq.toFixed(1) + '|' + dpr + '|' + (theme.skyCloud && theme.skyCloud.base);
  let s = sprites.get(key);
  if (s) { sprites.delete(key); sprites.set(key, s); return s; } // (LRU)
  const sh = body.sh, look = LOOK[night ? 'night' : 'day'];
  const hu = look.hull, pad = Math.ceil(hu + 2);
  const Wc = wq + 2 * pad, Hc = wq * sh.H + 2 * pad;
  const c = document.createElement('canvas');
  c.width = Math.ceil(Wc * dpr); c.height = Math.ceil(Hc * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bx = pad + wq / 2, by = pad + wq * sh.H; // base centre inside the sprite
  // the ink hull: the silhouette stroked 2 × hull wide, the body over its inner half
  g.save();
  g.translate(bx, by);
  g.scale(wq, wq);
  g.lineJoin = 'round';
  g.lineWidth = (2 * hu) / wq;
  g.strokeStyle = kind === 'storm' ? look.storm.line : look.sky.line;
  g.stroke(silPath(sh));
  g.restore();
  g.imageSmoothingQuality = 'high';
  g.drawImage(body.c, bx - wq / 2, by - (body.H / body.W) * wq + (wq / body.W), wq, (body.H / body.W) * wq);
  s = { c, cssW: Wc, cssH: Hc, bx, by };
  sprites.set(key, s);
  if (sprites.size > 90) sprites.delete(sprites.keys().next().value);
  return s;
}

/**
 * Draw a 3D prop flat: base centre (bx, by), drawn width w, alpha (the 3D fade × facing), light = the view-space key
 * light (planet/seabed.js toonLight(…).L, as 3D's uL: near the camera, so the shade is a thin crescent), its flat ground shadow
 * (3D castShadow: only when it shows (alpha ≥ 0.5) and not near the limb — the caller passes shadow = false there).
 */
export function drawPuff(ctx, theme, dpr, kind, variant, bx, by, w, alpha, shadow = true, light = null) {
  if (!(alpha > 0.01) || !(w > 2)) return null;
  const s = spriteOf(theme, dpr, kind, variant, w, light);
  ctx.save();
  if (shadow && alpha >= 0.5) {
    // (0.3 × size round, 0.25 × size away from the light — a 45 % step to the ground's shade, i.e. barely darker)
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(bx + 0.19 * w, by + 0.17 * w, 0.3 * w, 0, Math.PI * 2);
    ctx.fillStyle = theme.name === 'night' ? 'rgba(6,10,22,0.075)' : 'rgba(70,52,24,0.07)';
    ctx.fill();
  }
  ctx.globalAlpha = alpha;
  const x = bx - s.bx, y = by - s.by;
  ctx.drawImage(s.c, x, y, s.cssW, s.cssH);
  ctx.restore();
  return { x, y, w: s.cssW, h: s.cssH };
}

/**
 * The 3D 预期风 (planet3d/fx.js): a dashed ribbon along pts (screen px, tail → head), 0.006 view units wide on a halo
 * twice that, dashes 7 per arc sliding toward the head, and a small triangle head (0.016 long, 0.022 wide).
 */
export function drawIntelArc(ctx, pts, dir, fresh, theme, now, wsPx) {
  const n = pts.length - 1;
  if (n < 2) return;
  const col = dir > 0 ? theme.in : theme.out;
  const fr = Math.max(0.25, Math.min(1, fresh || 0.5));
  const ph = (now / 900) % 1;
  const on = (t) => ((t * 7 - ph) % 1 + 1) % 1 < 0.58; // (fx.js dashOn: a vertex is on or off)
  const path = new Path2D();
  for (let i = 0; i < n; i++) {
    if (!on(i / n)) continue;
    path.moveTo(pts[i][0], pts[i][1]);
    path.lineTo(pts[i + 1][0], pts[i + 1][1]);
  }
  const a0 = ctx.globalAlpha;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = a0 * 0.7 * fr;
  ctx.lineWidth = Math.max(2, 0.0116 * wsPx);
  ctx.strokeStyle = theme.surfHalo;
  ctx.stroke(path);
  ctx.globalAlpha = a0 * fr;
  ctx.lineWidth = Math.max(0.9, 0.006 * wsPx);
  ctx.strokeStyle = col;
  ctx.stroke(path);
  // the head: a small flat triangle at the last point (3D: 0.016 ahead, ±0.011 across, view units)
  const e = pts[n], e0 = pts[n - 2];
  let tx = e[0] - e0[0], ty = e[1] - e0[1];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  const L = 0.016 * wsPx, Wd = 0.011 * wsPx;
  ctx.beginPath();
  ctx.moveTo(e[0] + tx * L, e[1] + ty * L);
  ctx.lineTo(e[0] - ty * Wd, e[1] + tx * Wd);
  ctx.lineTo(e[0] + ty * Wd, e[1] - tx * Wd);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();
}
