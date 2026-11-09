// planet/flight.js — §26 amendment 5 (2D = the 3D planet flattened): 3D's Google-Earth hop between two views of the
// one real Earth (planet3d.js _setNodeReal, transition 'fly'), for the 2D map's camera.
//
// Planet3D flies a level change by turning its globe from the old pose to the new one (quaternion slerp of lookQuat
// poses) while the telephoto zoom follows a log-space quadratic Bézier that backs out far enough to see both places
// (fit), then comes in — over 900–2300 ms with easeInOutCubic. The 2D map runs the very same path through its moving
// picture (planet/freecam2d.js preview), so a click, an Esc, a breadcrumb, a map switch or a 巡航 stop passes the same
// places at the same zoom in both renderers. 2D keeps north up: the slerp's look direction is used, its small roll is
// dropped (a map does not tilt).
//
//   flightPlan(a, b)   a, b: {lon, lat, zoom} → the plan {q0, q1, la, lb, lc, dur, th}
//   flightAt(F, u)     u = elapsed / dur (0…1) → {lon, lat, zoom, e} (e = the eased progress)

import { dirOf, lonLatOf } from './sphere.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
/** planet3d.js easeInOut (cubic). */
export const flyEase = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** planet3d/core.js lookQuat(d): the rotation [x, y, z, w] whose matrix has rows (east, north', d) — d to +z, north up. */
function lookQ(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1, z = [d[0] / l, d[1] / l, d[2] / l];
  let x = [z[2], 0, -z[0]], lx = Math.hypot(x[0], x[2]);
  if (lx < 1e-3) { x = [1, 0, 0]; lx = 1; }
  x = [x[0] / lx, 0, x[2] / lx];
  let y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const ly = Math.hypot(y[0], y[1], y[2]) || 1;
  y = [y[0] / ly, y[1] / ly, y[2] / ly];
  // (three.js Quaternion.setFromRotationMatrix of the matrix with rows x, y, z)
  const m11 = x[0], m12 = x[1], m13 = x[2], m21 = y[0], m22 = y[1], m23 = y[2], m31 = z[0], m32 = z[1], m33 = z[2];
  const tr = m11 + m22 + m33;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** three.js Quaternion.slerpQuaternions (the short way round). */
function slerpQ(a, b, t) {
  let [x, y, z, w] = b;
  let c = a[0] * x + a[1] * y + a[2] * z + a[3] * w;
  if (c < 0) { x = -x; y = -y; z = -z; w = -w; c = -c; }
  if (c >= 1 - 1e-9) return a.slice();
  const s2 = 1 - c * c;
  if (s2 <= Number.EPSILON) {
    const q = [a[0] * (1 - t) + x * t, a[1] * (1 - t) + y * t, a[2] * (1 - t) + z * t, a[3] * (1 - t) + w * t], l = Math.hypot(...q) || 1;
    return q.map((v) => v / l);
  }
  const s = Math.sqrt(s2), h = Math.atan2(s, c), ra = Math.sin((1 - t) * h) / s, rb = Math.sin(t * h) / s;
  return [a[0] * ra + x * rb, a[1] * ra + y * rb, a[2] * ra + z * rb, a[3] * ra + w * rb];
}

/** The plan of a hop from camera a to camera b (planet3d.js _setNodeReal: the same numbers). */
export function flightPlan(a, b) {
  const A = dirOf(+a.lon || 0, +a.lat || 0), B = dirOf(+b.lon || 0, +b.lat || 0);
  const th = Math.acos(clamp(A[0] * B[0] + A[1] * B[1] + A[2] * B[2], -1, 1));
  const z0 = Math.max(1, +a.zoom || 1), z = Math.max(1, +b.zoom || 1);
  // zoom out enough to see both places, swing across, zoom in (log-space Bézier)
  const fit = Math.max(1, 0.92 / Math.sin(Math.min(Math.PI / 2, th / 2 + Math.asin(Math.min(1, 1 / Math.max(z0, z))) * 0.6)));
  const zm = Math.min(z0, z, fit);
  const la = Math.log(z0), lb = Math.log(z), lm = Math.log(zm);
  const lc = lm < Math.min(la, lb) - 0.02 ? 2 * lm - (la + lb) / 2 : (la + lb) / 2;
  const dur = clamp(1050 + 650 * Math.min(1, th / 1.3) + 220 * Math.abs(lb - la), 900, 2300);
  return { q0: lookQ(A), q1: lookQ(B), la, lb, lc, dur, th, to: { lon: wrap180(+b.lon || 0), lat: clamp(+b.lat || 0, -84, 84), zoom: z } };
}

/** The camera of plan F at u = elapsed / duration. */
export function flightAt(F, u) {
  const t = clamp(u, 0, 1);
  if (t >= 1) return Object.assign({ e: 1 }, F.to);
  const e = flyEase(t);
  const [x, y, z, w] = slerpQ(F.q0, F.q1, e);
  // the globe point facing the camera: the rotation matrix's third row (q⁻¹ · +z)
  const [lon, lat] = lonLatOf(2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y));
  const lz = (1 - e) * (1 - e) * F.la + 2 * e * (1 - e) * F.lc + e * e * F.lb;
  return { lon: wrap180(lon), lat: clamp(lat, -84, 84), zoom: Math.exp(lz), e };
}
