// planet/persp.js — §26 amendment 5 (2D = the 3D planet flattened): the 2D planet seen through the 3D camera's lens.
//
// Planet3D looks at the unit globe from distance D with a 22° telephoto (planet3d.js _computeView: the silhouette is R px
// at zoom 1, D = 1/sin(atan((R / (H/2))·tan 11°)) ≈ 7) and zooms with cam.zoom. That is a vertical perspective: a point
// at angle θ from the look point lands at  r = zoom · R · s·sinθ / (D − cosθ)  (s = √(D² − 1)); the limb (cos θ = 1/D)
// sits at zoom·R, and the ground at the look point is s / (D − 1) ≈ 1.15× an orthographic map of the same silhouette.
// The 2D planet uses the same lens, so the same camera {lon, lat, zoom} shows the same px per km and puts every place
// on the same pixel as 3D (only the relief differs). Local units here are "limb units": 1 = the limb at this zoom.
//
//   lensD(R, H)            the 3D camera's distance (globe radii) for a silhouette of R px on a canvas H px tall
//   lensK(D, zc)           camera-frame (east, north) components × this = limb units (zc = cos θ, the facing)
//   lensVis(D)             the facing of the limb (1/D): a point with zc below it is over the horizon
//   lensInv(D, X, Y)       limb units (X right, Y down) → [east, down, facing] on the unit sphere, or null past the limb
//   lensTheta(D, rho)      angle (rad) from the look point of a point rho limb units from the centre
//   lensF(D)               the look point's magnification over an orthographic globe of the same silhouette

export const LENS_FOV = 22; // planet3d.js FOV (deg)
const TAN_HALF = Math.tan(((LENS_FOV / 2) * Math.PI) / 180);

export function lensD(R, H) {
  const t = (Math.max(1, R) / Math.max(1, H / 2)) * TAN_HALF;
  return Math.max(1.0005, Math.sqrt(1 + 1 / (t * t)));
}

export function lensK(D, zc) {
  return Math.sqrt(D * D - 1) / Math.max(1e-6, D - zc);
}

export function lensVis(D) { return 1 / D; }

export function lensF(D) { return Math.sqrt((D + 1) / (D - 1)); }

export function lensInv(D, X, Y) {
  const s = Math.sqrt(D * D - 1), a = X / s, b = Y / s, q = 1 + a * a + b * b;
  const disc = D * D - q * (D * D - 1);
  if (disc < 0) return null;
  const l = (D - Math.sqrt(disc)) / q;
  return [l * a, l * b, D - l];
}

export function lensTheta(D, rho) {
  const p = lensInv(D, Math.min(1, Math.max(0, rho)), 0);
  return Math.acos(Math.max(-1, Math.min(1, p ? p[2] : 1 / D)));
}
