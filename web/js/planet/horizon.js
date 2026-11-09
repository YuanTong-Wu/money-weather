// planet/horizon.js — §26 amendment 5 (2D = the 3D planet flattened): a sphere ring seen by the 2D planet, cut at the
// horizon. 3D draws the land as a sphere mesh; 2D projects each ring through the 3D lens (planet/persp.js). A ring that
// runs behind the planet used to have its far-side points slid onto the limb one by one: a ring bigger than the view
// (the 1:50m Eurasia seen from 大中华 / 亚太 / 印度) then closed the wrong way round the limb and the 'evenodd' fill
// swapped land and sea. Here the ring is cut where it crosses the horizon and closed along the limb on its own
// interior's side (rings are small-side, sphere.js polygonsOf; the vector area against the mean says which way round).
//
//   clipRing(r, C, e, n, vis, K, sink, s = 1, ox = 0, oy = 0, minD = 0, allVis = false) → sub-rings emitted
//     r       Float32Array xyz ring on the unit sphere (implicitly closed)
//     C, e, n the view: look direction, east, north (sphere.js frameAt)
//     vis     the limb's facing (persp.js lensVis(D); 0 = orthographic); a point is seen when its facing > vis
//     K(f)    the lens: (east, north) × K(facing) = limb units (the limb at radius 1)
//     sink    moveTo / lineTo / closePath — a Path2D, or ringSink(); a point lands at (ox, oy) + s × limb units
//     minD    drop a point closer than this (output units, |dx| + |dy|) to the last one
//     allVis  the caller knows every point is in front (a bounding cap): skip the test
//   ringSink() → {moveTo, lineTo, closePath, rings: [[[x, y], …], …]} (rings of < 3 points are dropped)

const TAU = Math.PI * 2;
const STEP = Math.PI / 90; // the limb closing arcs: one point every 2°
let F = new Float32Array(4096);

export function clipRing(r, C, e, n, vis, K, sink, s = 1, ox = 0, oy = 0, minD = 0, allVis = false) {
  const m = (r.length / 3) | 0;
  if (m < 3) return 0;
  const c0 = C[0], c1 = C[1], c2 = C[2], ex = e[0], ey = e[1], ez = e[2], nx = n[0], ny = n[1], nz = n[2];
  let lx = 0, ly = 0, pen = false;
  const put = (x, y) => {
    if (pen && minD > 0 && Math.abs(x - lx) + Math.abs(y - ly) < minD) return;
    if (pen) sink.lineTo(x, y); else { sink.moveTo(x, y); pen = true; }
    lx = x; ly = y;
  };
  const vtx = (j, f) => {
    const x = r[j], y = r[j + 1], z = r[j + 2], k = K(f) * s;
    put(ox + (x * ex + y * ey + z * ez) * k, oy - (x * nx + y * ny + z * nz) * k);
  };
  if (F.length < m) F = new Float32Array(m * 2);
  let nv = 0;
  for (let i = 0, j = 0; i < m; i++, j += 3) { const f = r[j] * c0 + r[j + 1] * c1 + r[j + 2] * c2; F[i] = f; if (allVis || f > vis) nv++; }
  if (!nv) return 0;
  if (nv === m) {
    for (let i = 0; i < m; i++) vtx(3 * i, F[i]);
    sink.closePath();
    return 1;
  }
  // which way round the interior is: left of the travel (counter-clockwise seen from outside) when V·M > 0
  let Vx = 0, Vy = 0, Vz = 0, Mx = 0, My = 0, Mz = 0;
  for (let i = 0; i < m; i++) {
    const a = 3 * i, b = 3 * ((i + 1) % m);
    const ax = r[a], ay = r[a + 1], az = r[a + 2], bx = r[b], by = r[b + 1], bz = r[b + 2];
    Vx += ay * bz - az * by; Vy += az * bx - ax * bz; Vz += ax * by - ay * bx;
    Mx += ax; My += ay; Mz += az;
  }
  // (screen y is down: walking the limb counter-clockwise seen from outside is the screen angle falling)
  const dir = Vx * Mx + Vy * My + Vz * Mz > 0 ? -1 : 1;
  // the screen angle where edge i → j crosses the horizon
  const ang = (i, j) => {
    const t = (F[i] - vis) / (F[i] - F[j]), a = 3 * i, b = 3 * j;
    const x = r[a] + t * (r[b] - r[a]), y = r[a + 1] + t * (r[b + 1] - r[a + 1]), z = r[a + 2] + t * (r[b + 2] - r[a + 2]);
    return Math.atan2(-(x * nx + y * ny + z * nz), x * ex + y * ey + z * ez);
  };
  // the visible runs: an entry on the limb, the points in front, an exit on the limb
  let s0 = 0;
  while (s0 < m && !(F[s0] <= vis && F[(s0 + 1) % m] > vis)) s0++;
  const runs = [];
  let cur = null;
  for (let q = 0; q < m; q++) {
    const i = (s0 + q) % m, j = (i + 1) % m, vi = F[i] > vis, vj = F[j] > vis;
    if (!vi && vj) cur = { a0: ang(i, j), a1: 0, pts: [] };
    if (vj) { if (cur) cur.pts.push(j); } else if (vi && cur) { cur.a1 = ang(i, j); runs.push(cur); cur = null; }
  }
  if (!runs.length) return 0;
  // link: from each exit, along the limb (the interior's way round) to the next entry
  const limb = (a) => put(ox + Math.cos(a) * s, oy + Math.sin(a) * s);
  const used = new Uint8Array(runs.length);
  let out = 0;
  for (let r0 = 0; r0 < runs.length; r0++) {
    if (used[r0]) continue;
    pen = false;
    let k = r0;
    while (k >= 0 && !used[k]) {
      used[k] = 1;
      const u = runs[k];
      limb(u.a0);
      for (const j of u.pts) vtx(3 * j, F[j]);
      limb(u.a1);
      let best = -1, bd = Infinity;
      for (let q = 0; q < runs.length; q++) {
        let d = dir * (runs[q].a0 - u.a1);
        d = ((d % TAU) + TAU) % TAU;
        if (d < bd) { bd = d; best = q; }
      }
      const ns = Math.ceil(bd / STEP);
      for (let t = 1; t < ns; t++) limb(u.a1 + (dir * bd * t) / ns);
      k = best;
    }
    sink.closePath();
    out++;
  }
  return out;
}

export function ringSink() {
  const S = {
    rings: [], cur: null,
    moveTo(x, y) { if (S.cur && S.cur.length >= 3) S.rings.push(S.cur); S.cur = [[x, y]]; },
    lineTo(x, y) { (S.cur || (S.cur = [])).push([x, y]); },
    closePath() { if (S.cur && S.cur.length >= 3) S.rings.push(S.cur); S.cur = null; },
  };
  return S;
}
