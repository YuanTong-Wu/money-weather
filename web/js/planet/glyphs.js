// planet/glyphs.js — one consistent hand-drawn-but-precise icon set, drawn on canvas (§17):
// season glyphs (sprout / sun / maple leaf / snowflake), circled numbers, tiny wind triangles, 估 badge,
// 2-tone cel clouds, a crisp lightning bolt and an hourglass. Expensive ones are cached as sprites.

const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Noto Sans SC","Source Han Sans SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif';
export const font = (px, w = 500) => `${w} ${px}px ${FONT_STACK}`;
export const numFont = (px, w = 600) => `${w} ${px}px "SF Pro Text","Helvetica Neue",Inter,"Segoe UI",Roboto,${FONT_STACK}`;

const sprites = new Map();
function sprite(key, wCss, hCss, dpr, draw) {
  const k = key + '|' + dpr;
  let c = sprites.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = Math.ceil(wCss * dpr);
  c.height = Math.ceil(hCss * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(g);
  c.cssW = wCss; c.cssH = hCss;
  if (sprites.size > 400) sprites.delete(sprites.keys().next().value);
  sprites.set(k, c);
  return c;
}

// ------------------------------------------------------------------------------------ seasons
export const SEASON_KEYS = ['spring', 'summer', 'autumn', 'winter'];
const SEASON_COL = {
  day: { spring: '#6aa25a', summer: '#eab03e', autumn: '#d0602f', winter: '#4f93ae', line: 'rgba(31,42,68,0.85)', core: '#fbf8f1' },
  night: { spring: '#8cc27a', summer: '#f0c058', autumn: '#e27747', winter: '#8cc3d8', line: 'rgba(12,16,32,0.9)', core: '#1a2238' },
};

function sproutPath(g, s) {
  // stem + two almond leaves, drawn in a unit box of size s (origin top-left)
  const cx = s / 2;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  return {
    stem() {
      g.beginPath();
      g.moveTo(cx, s * 0.92);
      g.quadraticCurveTo(cx - s * 0.02, s * 0.66, cx, s * 0.48);
    },
    leafL() {
      g.beginPath();
      g.moveTo(cx, s * 0.52);
      g.quadraticCurveTo(cx - s * 0.08, s * 0.16, cx - s * 0.42, s * 0.2);
      g.quadraticCurveTo(cx - s * 0.36, s * 0.52, cx, s * 0.52);
      g.closePath();
    },
    leafR() {
      g.beginPath();
      g.moveTo(cx + s * 0.01, s * 0.46);
      g.quadraticCurveTo(cx + s * 0.06, s * 0.06, cx + s * 0.44, s * 0.08);
      g.quadraticCurveTo(cx + s * 0.4, s * 0.44, cx + s * 0.01, s * 0.46);
      g.closePath();
    },
  };
}

function mapleLeaf(g, s) {
  // stylised 5-lobed momiji, tip up; polar outline around (cx, cy). Lobes are broad with one
  // serration notch on each flank so the leaf still reads as a leaf at 13 px.
  const cx = s / 2, cy = s * 0.47, R = s * 0.5;
  const lobes = [[-122, 0.66], [-60, 0.9], [0, 1.0], [60, 0.9], [122, 0.66]];
  const P = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return [cx + Math.sin(a) * r * R, cy - Math.cos(a) * r * R];
  };
  const pts = [P(-170, 0.2)];
  for (let i = 0; i < lobes.length; i++) {
    const [a, L] = lobes[i];
    pts.push(P(a - 22, L * 0.56), P(a - 15, L * 0.74), P(a - 12, L * 0.68), P(a, L), P(a + 12, L * 0.68), P(a + 15, L * 0.74), P(a + 22, L * 0.56));
    if (i < lobes.length - 1) pts.push(P((a + lobes[i + 1][0]) / 2, 0.42));
  }
  pts.push(P(170, 0.2));
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  return { cx, cy, R };
}

/** Draw a season glyph centred at (x, y) with box size s (CSS px). key: spring|summer|autumn|winter. */
export function drawSeason(ctx, key, x, y, s, theme, dpr = 1, alpha = 1) {
  if (!SEASON_COL.day[key]) return;
  const tn = theme.name;
  const pad = 2;
  const S = s + pad * 2;
  const spr = sprite(`season|${key}|${s}|${tn}`, S, S, dpr, (g) => {
    g.translate(pad, pad);
    const col = SEASON_COL[tn] || SEASON_COL.day;
    const lw = Math.max(1, s * 0.075);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (key === 'spring') {
      const p = sproutPath(g, s);
      p.stem();
      g.strokeStyle = col.line; g.lineWidth = lw * 2.4; g.stroke();
      g.strokeStyle = col.spring; g.lineWidth = lw * 1.1; g.stroke();
      for (const leaf of [p.leafL, p.leafR]) {
        leaf();
        g.fillStyle = col.spring; g.fill();
        g.strokeStyle = col.line; g.lineWidth = lw; g.stroke();
      }
      // leaf veins
      g.strokeStyle = col.line; g.lineWidth = lw * 0.6; g.globalAlpha = 0.55;
      g.beginPath(); g.moveTo(s * 0.5, s * 0.5); g.lineTo(s * 0.2, s * 0.26);
      g.moveTo(s * 0.51, s * 0.44); g.lineTo(s * 0.82, s * 0.16); g.stroke();
      g.globalAlpha = 1;
    } else if (key === 'summer') {
      const cx = s / 2, cy = s / 2, r = s * 0.24;
      g.strokeStyle = col.summer; g.lineWidth = lw * 1.25;
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const r0 = r + s * 0.09, r1 = s * (i % 2 ? 0.44 : 0.48);
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      }
      g.stroke();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = col.summer; g.fill();
      g.strokeStyle = col.line; g.lineWidth = lw; g.stroke();
    } else if (key === 'autumn') {
      const { cx, cy, R } = mapleLeaf(g, s);
      g.fillStyle = col.autumn; g.fill();
      g.strokeStyle = col.line; g.lineWidth = lw; g.stroke();
      // veins + stem
      g.strokeStyle = col.line; g.lineWidth = lw * 0.7; g.globalAlpha = 0.6;
      g.beginPath();
      for (const a of [-64, 0, 64]) {
        const r = (a * Math.PI) / 180;
        g.moveTo(cx, cy + R * 0.12); g.lineTo(cx + Math.sin(r) * R * 0.62, cy - Math.cos(r) * R * 0.62);
      }
      g.stroke();
      g.globalAlpha = 1;
      g.beginPath(); g.moveTo(cx, cy + R * 0.12); g.quadraticCurveTo(cx + s * 0.02, s * 0.86, cx + s * 0.1, s * 0.98);
      g.lineWidth = lw * 1.1; g.stroke();
    } else if (key === 'winter') {
      const cx = s / 2, cy = s / 2, L = s * 0.46;
      const arms = () => {
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
          const ux = Math.cos(a), uy = Math.sin(a);
          g.moveTo(cx, cy); g.lineTo(cx + ux * L, cy + uy * L);
          const bx = cx + ux * L * 0.58, by = cy + uy * L * 0.58, b = L * 0.32;
          for (const sgn of [-1, 1]) {
            const ba = a + sgn * 0.75;
            g.moveTo(bx, by); g.lineTo(bx + Math.cos(ba) * b, by + Math.sin(ba) * b);
          }
        }
      };
      arms();
      g.strokeStyle = col.line; g.lineWidth = lw * 2.5; g.stroke();
      arms();
      g.strokeStyle = col.winter; g.lineWidth = lw * 1.25; g.stroke();
      g.beginPath(); g.arc(cx, cy, s * 0.09, 0, Math.PI * 2);
      g.fillStyle = col.winter; g.fill();
    }
  });
  const a0 = ctx.globalAlpha;
  ctx.globalAlpha = a0 * alpha;
  ctx.drawImage(spr, x - S / 2, y - S / 2, S, S);
  ctx.globalAlpha = a0;
}

// §26 amendment 5: the 3D labels' season marks (planet3d/labels.js SEASON_SVG) — one-colour line icons on a 20×20 box,
// stroke 1.7 — so a name or a ①②③ card carries the same glyph in 2D and 3D
const SEASON_D = {
  spring: 'M10 17.2V9.8 M10 11.4C10 8 7.6 6 4 6c0 3.4 2.4 5.4 6 5.4z M10 9.6c0-2.9 2.1-4.8 5.6-4.8 0 2.9-2.1 4.8-5.6 4.8z M6.4 17.2h7.2',
  summer: 'M13.3 10A3.3 3.3 0 1 1 6.7 10A3.3 3.3 0 1 1 13.3 10z M10 2.4v1.9M10 15.7v1.9M2.4 10h1.9M15.7 10h1.9M4.6 4.6l1.35 1.35M14.05 14.05l1.35 1.35M4.6 15.4l1.35-1.35M14.05 5.95l1.35-1.35',
  autumn: 'M10 2.6l1.3 2.9 2.3-1.2-.4 3.4 2.9-.8-1.1 2.5 2.4 1-3.4 1.6.7 1.6-3.7-.6.3 2.7h-2.6l.3-2.7-3.7.6.7-1.6-3.4-1.6 2.4-1-1.1-2.5 2.9.8-.4-3.4 2.3 1.2z M10 15.7v2.4',
  winter: (() => {
    let d = '';
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3 - Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
      const P = (r, s) => `${(10 + ux * r + px * s).toFixed(2)} ${(10 + uy * r + py * s).toFixed(2)}`;
      d += `M10 10L${P(7.3, 0)}M${P(6.9, 1.9)}L${P(5.0, 0)}L${P(6.9, -1.9)}`;
    }
    return d;
  })(),
};
const seasonPaths = new Map();
/** Season mark as the 3D label draws it: a line icon (size px) in one colour, centred on (x, y). */
export function drawSeasonLine(ctx, key, x, y, size, color) {
  const d = SEASON_D[key];
  if (!d || typeof Path2D === 'undefined') return;
  let p = seasonPaths.get(key);
  if (!p) { p = new Path2D(d); seasonPaths.set(key, p); }
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 20, size / 20);
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.stroke(p);
  ctx.restore();
}

// ------------------------------------------------------------------------------------ small marks
/** Circled number ①②③ (filled ink disc, paper numeral). */
export function drawNumber(ctx, n, x, y, r, theme) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = theme.badge;
  ctx.fill();
  ctx.fillStyle = theme.badgeText;
  ctx.font = numFont(Math.round(r * 1.25), 700);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + r * 0.06);
  ctx.textAlign = 'left';
}

/** Tiny wind triangle: up = money flowing in. */
export function drawTri(ctx, up, x, y, s, color) {
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y - s * 0.6); ctx.lineTo(x + s * 0.55, y + s * 0.42); ctx.lineTo(x - s * 0.55, y + s * 0.42); }
  else { ctx.moveTo(x, y + s * 0.6); ctx.lineTo(x + s * 0.55, y - s * 0.42); ctx.lineTo(x - s * 0.55, y - s * 0.42); }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** 估 badge: dashed ring + 估 (estimate, §14). */
export function drawEstBadge(ctx, x, y, r, theme) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = theme.card;
  ctx.fill();
  ctx.setLineDash([2, 1.6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.labelSoft;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = theme.labelSoft;
  ctx.font = font(Math.round(r * 1.2), 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('估', x, y + 0.5);
  ctx.textAlign = 'left';
}

/** Hourglass (⏳ 时间差 in scenario mode). */
export function drawHourglass(ctx, x, y, s, theme) {
  const w = s * 0.62, h = s;
  ctx.save();
  ctx.translate(x - w / 2, y - h / 2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(w * 0.08, h * 0.08); ctx.lineTo(w * 0.92, h * 0.08);
  ctx.lineTo(w * 0.5, h * 0.5); ctx.lineTo(w * 0.92, h * 0.92); ctx.lineTo(w * 0.08, h * 0.92);
  ctx.lineTo(w * 0.5, h * 0.5); ctx.closePath();
  ctx.fillStyle = theme.card;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.62); ctx.lineTo(w * 0.8, h * 0.88); ctx.lineTo(w * 0.2, h * 0.88); ctx.closePath();
  ctx.moveTo(w * 0.28, h * 0.2); ctx.lineTo(w * 0.72, h * 0.2); ctx.lineTo(w * 0.5, h * 0.4); ctx.closePath();
  ctx.fillStyle = theme.gold;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.08, h * 0.08); ctx.lineTo(w * 0.92, h * 0.08);
  ctx.lineTo(w * 0.5, h * 0.5); ctx.lineTo(w * 0.92, h * 0.92); ctx.lineTo(w * 0.08, h * 0.92);
  ctx.lineTo(w * 0.5, h * 0.5); ctx.closePath();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = theme.label;
  ctx.stroke();
  ctx.restore();
}

/** One crisp zig-zag lightning bolt, top at (x, y), height h. */
export function boltPath(ctx, x, y, h, lean = 0) {
  const w = h * 0.55;
  const P = (u, v) => [x + (u - 0.5) * w + lean * v * h * 0.25, y + v * h];
  const pts = [P(0.42, 0), P(0.86, 0), P(0.6, 0.38), P(0.84, 0.38), P(0.22, 1), P(0.42, 0.52), P(0.14, 0.52)];
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
}
export function drawBolt(ctx, x, y, h, theme, lean = 0) {
  boltPath(ctx, x, y, h, lean);
  ctx.lineJoin = 'round';
  ctx.fillStyle = theme.bolt;
  ctx.fill();
  ctx.lineWidth = Math.max(1, h * 0.06);
  ctx.strokeStyle = theme.boltLine;
  ctx.stroke();
}

// ------------------------------------------------------------------------------------ clouds
/** Cumulus outline (flat bottom + 3 puffs) in a box w × h with top-left at (x, y). */
function cloudPath(g, x, y, w, h, seed = 0) {
  const b = y + h; // flat bottom
  const r1 = h * 0.42, r2 = h * 0.56, r3 = h * 0.38;
  const s = (seed % 3) * 0.04;
  g.beginPath();
  // base: pill along the bottom (all sub-paths clockwise so the nonzero union has no holes)
  const rb = h * 0.3;
  g.moveTo(x + rb, b - 2 * rb);
  g.lineTo(x + w - rb, b - 2 * rb);
  g.arc(x + w - rb, b - rb, rb, -Math.PI / 2, Math.PI / 2, false);
  g.lineTo(x + rb, b);
  g.arc(x + rb, b - rb, rb, Math.PI / 2, Math.PI * 1.5, false);
  g.closePath();
  g.moveTo(x + w * (0.28 + s) + r1, b - h * 0.42);
  g.arc(x + w * (0.28 + s), b - h * 0.42, r1, 0, Math.PI * 2);
  g.moveTo(x + w * (0.52 - s) + r2, b - h * 0.5);
  g.arc(x + w * (0.52 - s), b - h * 0.5, r2, 0, Math.PI * 2);
  g.moveTo(x + w * 0.75 + r3, b - h * 0.36);
  g.arc(x + w * 0.75, b - h * 0.36, r3, 0, Math.PI * 2);
}

/**
 * 2-tone cel-shaded cloud sprite (kind: 'sky' | 'storm'), w CSS px wide. Returns a canvas with cssW/cssH.
 * Bottom-right rim in the shade tone, crisp outline, one small highlight.
 */
export function cloudSprite(theme, kind, w, dpr = 1, seed = 0) {
  const wq = Math.max(16, Math.round(w / 6) * 6);
  const h = wq * 0.56;
  const pad = 3;
  const pal = kind === 'storm' ? theme.stormCloud : theme.skyCloud;
  return sprite(`cloud|${kind}|${wq}|${theme.name}|${seed % 3}`, wq + pad * 2, h + pad * 2, dpr, (g) => {
    const x = pad, y = pad;
    const lw = Math.max(1, wq / 70);
    cloudPath(g, x, y, wq, h, seed);
    g.lineWidth = lw * 2;
    g.strokeStyle = pal.line;
    g.stroke();
    g.fillStyle = pal.shade;
    g.fill();
    g.save();
    cloudPath(g, x, y, wq, h, seed);
    g.clip();
    g.translate(-wq * 0.035, -h * 0.17);
    cloudPath(g, x, y, wq, h, seed);
    g.fillStyle = pal.base;
    g.fill();
    g.restore();
    if (kind !== 'storm') {
      g.beginPath();
      g.ellipse(x + wq * 0.46, y + h * 0.2, wq * 0.07, h * 0.06, -0.3, 0, Math.PI * 2);
      g.fillStyle = pal.hi;
      g.globalAlpha = 0.9;
      g.fill();
    }
  });
}
