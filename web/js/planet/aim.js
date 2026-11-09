// planet/aim.js — the rest pose of a planet (§8.1 + §25), shared by Planet3D (planet3d.js _aimFor) and the 2D planet
// (planet/freecam2d.js: §26 amendment 5 — the same node and mode open at the same camera place in 2D and 3D).
//
// North up, the globe turned so the 主航道 ends and ①②③ face the viewer (① weighted most), as much land as possible on
// the visible face (names need ground facing the viewer), the important places on the lit side, and — for the abstract
// planets — close to the layout's front, so a planet keeps its face from one visit to the next. Searched over 240
// directions in a ~70° cap around the important places' centroid. Plain arrays (no three.js) so both renderers share it.
//
//   restAim({anchors, areas, front, earth, light, imp}) → [x, y, z] the unit direction the camera looks at
//     anchors [[x,y,z]] per territory (sphere.js T.anchor), areas [sr], front [x,y,z] (S.front), earth (全球 real
//     countries: no pull to the front), light [x, y] (the key light's screen direction), imp [[dir, weight, zMin?]]
//   aimImp({n, chan, hero, numOf, anchors}) → imp   (chan {fk, tk, t2k?} | null, hero k | null, numOf(k) → 0 | 1 | 2 | 3)

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** East / north at unit vector c (sphere.js frameAt, planet3d.js frame3v — the same frame). */
function frame(c) {
  let ex = c[2], ez = -c[0];
  let l = Math.hypot(ex, ez);
  if (l < 1e-6) { ex = 1; ez = 0; l = 1; }
  const e = [ex / l, 0, ez / l];
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  return [e, [n[0] / nl, n[1] / nl, n[2] / nl]];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function aimImp({ n, chan, hero, numOf, anchors }) {
  const imp = [];
  if (chan) {
    imp.push([anchors[chan.fk], 1]); imp.push([anchors[chan.tk], 1.2]);
    if (chan.t2k != null) imp.push([anchors[chan.t2k], 0.9]);
  } else if (hero != null) imp.push([anchors[hero], 2.2, 0.8]); // (well inside the face, not just on it)
  for (let k = 0; k < n; k++) {
    const nb = numOf(k);
    if (nb) imp.push([anchors[k], nb === 1 ? 1.7 : nb === 2 ? 0.9 : 0.7]);
  }
  return imp.filter((x) => x[0]);
}

export function restAim({ anchors, areas, front, earth, light, imp }) {
  const n = anchors.length;
  const fr = unit(front || [0, 0, 1]);
  const ll = Math.hypot(light[0], light[1]) || 1;
  const area = areas || [];
  const atot = area.reduce((a, b) => a + (b || 0), 0) || 1;
  const wsum = imp.reduce((a, x) => a + x[1], 0) || 1;
  // the important places' centroid: candidate views are searched around it (and the layout's front)
  let ctr = [0, 0, 0];
  for (const [d, wt] of imp) for (let i = 0; i < 3; i++) ctr[i] += d[i] * wt;
  for (let k = 0; k < n; k++) { const f = (0.6 * (area[k] || 0)) / atot; for (let i = 0; i < 3; i++) ctr[i] += anchors[k][i] * f; }
  if (!earth) for (let i = 0; i < 3; i++) ctr[i] += fr[i] * 0.5;
  if (ctr[0] * ctr[0] + ctr[1] * ctr[1] + ctr[2] * ctr[2] < 1e-8) ctr = fr.slice();
  ctr = unit(ctr);
  const [ce, cn] = frame(ctr);
  let best = null, bestS = -Infinity;
  const NC = 240;
  for (let i = 0; i < NC; i++) {
    // a Fibonacci cap of ~70° around the centroid
    const t = (i + 0.5) / NC, th = Math.acos(1 - t * (1 - Math.cos(1.2))), ph = i * 2.39996323;
    const st = Math.sin(th), ct = Math.cos(th), cp = Math.cos(ph), sp = Math.sin(ph);
    const v = unit([0, 1, 2].map((j) => ctr[j] * ct + ce[j] * st * cp + cn[j] * st * sp));
    const [e, nn] = frame(v);
    let pen = 0, wf = 0, lit = 0;
    for (const [dd, wt, zMin = 0.55] of imp) {
      const z = dot(dd, v), x = dot(dd, e), y = dot(dd, nn);
      pen += (Math.max(0, zMin - z) + 4 * Math.max(0, 0.22 - z)) * wt; // every important place in view, well inside the disc
      wf += Math.min(z, earth ? 0.97 : 0.85) * wt;
      lit += ((x * light[0] + y * light[1]) / ll) * wt;
    }
    // land on the visible face (every name needs ground facing the viewer)
    let seen = 0;
    for (let k = 0; k < n; k++) seen += ((area[k] || 0) / atot) * clamp((dot(anchors[k], v) - 0.15) / 0.45, 0, 1);
    const off = earth ? 0 : Math.acos(clamp(dot(v, fr), -1, 1));
    // (a natural 3/4 view: the layout's front a little off the centre, never dead on)
    const sc = (imp.length ? -5 * (pen / wsum) + 0.8 * (wf / wsum) + (earth ? 0.04 : 0.15) * (lit / wsum) : 0) + 1.3 * seen - 0.35 * Math.abs(off - 0.22);
    if (sc > bestS) { bestS = sc; best = v; }
  }
  return best || fr;
}
