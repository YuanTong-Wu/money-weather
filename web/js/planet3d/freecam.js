// planet3d/freecam.js — §26 amendment 3 for Planet3D: the free Google-Earth camera (input: planet/controls.js).
//
// The globe's own drag rotation (rot.q, premultiplied onto the rest pose) is driven from here: drag / inertia /
// arrow keys turn it freely, the wheel / pinch / ＋－ set a manual telephoto zoom about the cursor (the globe point
// under the cursor stays there), 回正 eases rot.q back to the rest pose and the zoom to the layout's view, the
// compass shows north and turns it up on click. The manual camera persists (no ease-back after idle) through
// date changes and refreshes (setNode on the same node + reading keeps it); a new level resets it. 真实: when
// the camera rests, the 1:10m coast window follows it (Globe.setView) and names-by-zoom use the live zoom.
// Zoom clamp: 真实 1 (whole globe) … 150 (a city's districts: §26 amendment 4, admin3 from ×40); 抽象 / 全球 1 … 4.
// At rest the planet checks the admin-unit level of the zoom and the window it was built for (Planet3D._reask:
// a new level, or wind / unit borders re-seeded where the camera now looks — rebuilt in place, the camera untouched).

import { THREE } from './core.js';
import { FreeControls } from '../planet/controls.js';
import { lonLatOf } from '../planet/sphere.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const ZMAX_REAL = 150, ZMAX_ABSTRACT = 4;
const AZ = new THREE.Vector3(0, 0, 1), NORTH = new THREE.Vector3(0, 1, 0), AX_X = new THREE.Vector3(1, 0, 0);
const Q0 = new THREE.Quaternion();

export class FreeCam3D {
  constructor(planet) {
    this.p = planet;
    this.zm = null; // manual zoom (null = follow the layout's view)
    this.manual = false;
    this.nodeId = null; this.mode = null;
    this.tw = null;
    this._ray = new THREE.Raycaster();
    this._sph = new THREE.Sphere(new THREE.Vector3(), 1);
    this._v = new THREE.Vector3();
    this.fc = new FreeControls(planet.canvas, this, { compass: true, extra: [planet.layer] });
  }

  destroy() { this.fc.destroy(); }
  moving() { return this.fc.moving(); }

  /** setNode: true = keep the manual camera (same node + reading: a refresh); else reset to the new default. */
  keep(node, mode) {
    const same = this.manual && node && node.id === this.nodeId && mode === this.mode;
    this.nodeId = node ? node.id : null; this.mode = mode;
    if (!same) { this.manual = false; this.zm = null; this.tw = null; }
    return !!same;
  }

  /** §26 amendment 5: the camera handed over from the 2D map — held as a manual view on that node + reading. */
  seed(cam) {
    this.nodeId = cam.nodeId; this.mode = cam.mode;
    this.manual = true; this.tw = null;
    this.zm = clamp(+cam.zoom || 1, 1, cam.mode === 'real' ? ZMAX_REAL : ZMAX_ABSTRACT);
  }

  /** faceChild (search / tour): let go of the manual turn so the territory can come to the front. */
  faceRelease() {
    const r = this.p.rot;
    if (r.q.angleTo(Q0) < 1e-4) return;
    this.tw = { t: 0, dur: 0.6, q0: r.q.clone(), q1: Q0.clone(), z0: null };
    this.fc._startGesture();
  }

  // ------------------------------------------------------------------------------------------ FreeControls camera
  // (§26 amendment 5: the short in-place level swap never swallows a key or a drag — as in 2D)
  busy() { return !!(this.p.tr && this.p.tr.dir !== 'swap') || !this.p.live; }
  isDefault() { return !this.manual; }
  _zmax() { const L = this.p.live; return L && L.world.real ? ZMAX_REAL : ZMAX_ABSTRACT; }
  _defZoom() { const L = this.p.live; return L && L.realView ? L.realView.zoom : 1; }

  begin() {
    const p = this.p;
    p.rot.dragging = true; p.rot.wx = p.rot.wy = 0;
    if (p.hoverIdx >= 0) p._setHover(-1, null);
  }

  settle() {
    const p = this.p;
    p.rot.dragging = false;
    p.rot.release = performance.now();
    p._dirty = true;
    // 真实: the 1:10m coast window follows the camera
    const L = p.live, G = p.globe;
    if (!L || !L.world.real || !G || !L.realView) return;
    const d = this._v.set(0, 0, 1).applyQuaternion(L.world.root.quaternion.clone().invert());
    const [lon, lat] = lonLatOf(d.x, d.y, d.z);
    try { G.setView({ lon, lat, scale: p.zoom || 1 }, L.realView.context || {}, { detail: G.detail }); } catch (e) { /* the globe keeps its window */ }
    if (p._camSettled) p._camSettled(); // §26 amendment 4: the unit level of this zoom / the window where it looks
  }

  rotate(dx, dy) {
    const p = this.p;
    this.tw = null;
    const k = 1 / Math.max(120, p.view.R * (p.zoom || 1)); // the point under the cursor follows it
    p._spin(dx * k, dy * k);
    p._dirty = true;
    this.manual = true;
  }

  /** The globe point under canvas-local px (x, y) (world space), or null off the globe. */
  _hitAt(x, y) {
    const p = this.p;
    if (!p.W || !p.H) return null;
    this._ray.setFromCamera(new THREE.Vector2((x / p.W) * 2 - 1, -(y / p.H) * 2 + 1), p.camera);
    const out = new THREE.Vector3();
    return this._ray.ray.intersectSphere(this._sph, out) ? out.normalize() : null;
  }

  zoom(f, x, y) {
    const p = this.p;
    this.tw = null;
    const z0 = p.zoom || 1, z1 = clamp(z0 * f, 1, Math.max(this._zmax(), this._defZoom()));
    if (Math.abs(z1 - z0) < 1e-6) return;
    const A = x != null && Number.isFinite(x) ? this._hitAt(x, y) : null;
    this.zm = z1;
    p._setZoom(z1);
    if (A) {
      const B = this._hitAt(x, y);
      if (B && A.angleTo(B) > 1e-7 && !this._turnUp(A, B)) p.rot.q.premultiply(new THREE.Quaternion().setFromUnitVectors(A, B)).normalize();
    }
    p._dirty = true;
    this.manual = true;
  }

  /**
   * §26 amendment 5: a map does not tilt — the zoom's turn that brings the place under the cursor back under it (scene
   * point A → B) is a yaw about the globe's own axis then a pitch about the screen's x, as Planet3D._spin turns a drag,
   * so north stays up (setFromUnitVectors rolled the map 17° in three wheel notches; 2D cannot roll). false = no such
   * turn (a pole at the cursor): the caller turns the shortest way.
   */
  _turnUp(A, B) {
    const p = this.p, L = p.live;
    const pose = p.rot.q.clone();
    if (L && L.aimQ) pose.multiply(L.aimQ);
    const nC = NORTH.clone().applyQuaternion(pose).normalize(); // north, in camera space
    // the pitch a (about x) after which B sits as high along north as A: c1·cos a + s1·sin a = t
    const t = A.dot(nC) - B.x * nC.x, c1 = nC.y * B.y + nC.z * B.z, s1 = nC.y * B.z - nC.z * B.y, r = Math.hypot(c1, s1);
    if (r < 1e-9 || Math.abs(t) > r) return false;
    const ph = Math.atan2(s1, c1), d = Math.acos(clamp(t / r, -1, 1)), w = (v) => Math.atan2(Math.sin(v), Math.cos(v));
    const a = Math.abs(w(ph - d)) <= Math.abs(w(ph + d)) ? w(ph - d) : w(ph + d);
    const Bp = B.clone().applyAxisAngle(AX_X, -a);
    // the yaw about north that takes A to Bp
    const pa = A.clone().addScaledVector(nC, -A.dot(nC)), pb = Bp.clone().addScaledVector(nC, -Bp.dot(nC));
    if (pa.lengthSq() < 1e-14 || pb.lengthSq() < 1e-14) return false;
    const yaw = Math.atan2(nC.dot(pa.clone().cross(pb)), pa.dot(pb));
    p.rot.q.premultiply(new THREE.Quaternion().setFromAxisAngle(nC, yaw)).premultiply(new THREE.Quaternion().setFromAxisAngle(AX_X, a)).normalize();
    return true;
  }

  reset() {
    const p = this.p;
    this.tw = { t: 0, dur: 0.65, q0: p.rot.q.clone(), q1: Q0.clone(), z0: p.zoom || 1, z1: this._defZoom(), done: true };
  }

  heading() {
    const L = this.p.live;
    if (!L) return null;
    const n = this._v.copy(NORTH).applyQuaternion(L.world.root.quaternion);
    if (Math.hypot(n.x, n.y) < 0.05) return null; // a pole faces us: no direction to show
    return Math.atan2(n.x, n.y);
  }

  northUp() {
    const a = this.heading();
    if (a == null || Math.abs(a) < 1e-3) return;
    const q0 = this.p.rot.q.clone();
    this.tw = { t: 0, dur: 0.45, q0, q1: new THREE.Quaternion().setFromAxisAngle(AZ, a).multiply(q0), z0: null };
  }

  animating() { return !!this.tw; }

  tick(dt) {
    const w = this.tw, p = this.p;
    if (!w) return;
    w.t += dt;
    const u = clamp(w.t / w.dur, 0, 1), e = ease(u);
    p.rot.q.slerpQuaternions(w.q0, w.q1, e);
    if (w.z0 != null) { this.zm = Math.exp(Math.log(w.z0) + (Math.log(w.z1) - Math.log(w.z0)) * e); p._setZoom(this.zm); }
    p._dirty = true;
    if (u >= 1) {
      this.tw = null;
      if (w.done) { this.zm = null; this.manual = false; p.rot.q.identity(); }
    }
  }
}
