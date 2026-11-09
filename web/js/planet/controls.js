// planet/controls.js — §26 amendment 3: the Google-Earth camera, shared by the 2D Planet and Planet3D.
// Owner: "2D 的时候不能转动地球，我无法自己放大缩小画面。"
//
//   const fc = new FreeControls(canvas, cam, { compass: true });
//   cam = {
//     rotate(dx, dy)        turn the globe by a screen drag of (dx, dy) px (the point under the cursor follows it)
//     zoom(f, x, y)         multiply the zoom by f (> 1 = closer) about canvas-local px (x, y) (null → the centre)
//     reset()               animate back to the layout's default view (回正)
//     begin() / settle()    a gesture starts / the camera came to rest (inertia, wheel and tweens done)
//     tick?(dt)             per frame while FreeControls animates (the renderer's own tweens, e.g. 回正)
//     animating?()          true while such a tween runs
//     heading?()            north's screen angle (rad, clockwise from up) for the compass; northUp?() on its click
//     busy?()               true while a level flight runs (input is ignored)
//   }
//   fc.moving()  → true while the camera moves (renderers skip hover / hit tests then)
//   fc.destroy()
//
// Input: drag (mouse / one finger) = rotate with gentle inertia; wheel = continuous zoom at the cursor (trackpad
// pinch arrives as ctrl+wheel); two fingers = pinch-zoom + rotate; a drag never becomes a click (levels stay on
// click / Esc / breadcrumb). Keys: + / − zoom, 0 回正 (anywhere outside text fields); arrow keys turn the globe
// while the map has focus (click it — elsewhere ←/→ keep stepping the date, main.js). Small §17 controls sit
// bottom-right of the map: ＋, －, 回正 and (3D) a compass. touch-action:none on the canvas only — the page
// never scrolls from the map, and nothing outside it is hijacked.

const STYLE_ID = 'mw-camctl-style';
const DRAG_PX = { mouse: 4, pen: 6, touch: 8 };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.mw-camctl{position:fixed;z-index:30;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;
  transition:right .35s var(--ease,ease),bottom .35s var(--ease,ease),opacity .3s}
.mw-camctl.off{opacity:0;visibility:hidden}
.mw-camctl>*{pointer-events:auto}
.mw-camctl .cc-stack{display:flex;flex-direction:column;background:var(--paper,#fbf8f1);border:1px solid var(--line-2,rgba(31,42,68,.2));
  border-radius:var(--radius-sm,7px);box-shadow:var(--shadow,0 4px 14px rgba(92,74,40,.07));overflow:hidden}
.mw-camctl button{all:unset;pointer-events:auto;box-sizing:border-box;width:32px;height:30px;display:flex;align-items:center;justify-content:center;
  color:var(--ink-2,#464f66);font:500 16px/1 var(--font-num,system-ui);cursor:pointer;user-select:none;-webkit-user-select:none}
.mw-camctl .cc-stack button+button{border-top:1px solid var(--line,rgba(31,42,68,.11))}
.mw-camctl button:hover{background:var(--paper-2,#f3eee2);color:var(--ink,#1f2a44)}
.mw-camctl button:active{background:var(--paper-hi,#efe8d9)}
.mw-camctl button:focus-visible{outline:2px solid var(--accent-line,rgba(51,98,138,.38));outline-offset:-2px}
.mw-camctl button[disabled]{color:var(--ink-4,#a9abb0);cursor:default;background:none}
.mw-camctl .cc-reset{font:500 11.5px/1 var(--font,system-ui);letter-spacing:.04em;width:auto;padding:0 8px;height:26px;
  background:var(--paper,#fbf8f1);border:1px solid var(--line-2,rgba(31,42,68,.2));border-radius:var(--radius-sm,7px);
  box-shadow:var(--shadow,0 4px 14px rgba(92,74,40,.07));transition:opacity .25s}
.mw-camctl .cc-reset.dim{opacity:.55}
.mw-camctl .cc-compass{width:32px;height:32px;border-radius:50%;background:var(--paper,#fbf8f1);
  border:1px solid var(--line-2,rgba(31,42,68,.2));box-shadow:var(--shadow,0 4px 14px rgba(92,74,40,.07));padding:0}
.mw-camctl .cc-compass svg{width:26px;height:26px;display:block;transition:transform .08s linear}
.mw-camctl .cc-compass .n{fill:var(--out,#a33d45)}
.mw-camctl .cc-compass .s{fill:var(--ink-4,#a9abb0)}
.mw-camctl .cc-compass text{font:700 6.5px/1 var(--font-num,system-ui);fill:var(--ink-2,#464f66)}
canvas[data-mw-cam]{touch-action:none;outline:none}
canvas[data-mw-cam].mw-grab{cursor:grabbing!important}
`;
  document.head.appendChild(s);
}

export class FreeControls {
  constructor(canvas, cam, opts = {}) {
    this.canvas = canvas;
    this.cam = cam;
    this.opts = opts;
    this.ptrs = new Map(); // pointerId → {x, y}
    this.drag = null; // {id, x0, y0, lx, ly, on, hist}
    this.pinch = null; // {d, mx, my}
    this.vel = null; // inertia {vx, vy} px/s
    this.wheelLog = 0; // pending log-zoom (smoothed)
    this.wheelAt = null; // canvas-local px of the last wheel / pinch
    this.keyRot = null; // {x, y, left} pending key rotation px
    this._moving = false;
    this._settleT = 0;
    this._raf = 0;
    this._last = 0;
    this._clickBlock = 0;
    this._destroyed = false;
    canvas.dataset.mwCam = '1';
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    injectStyle();
    const on = (t, ev, f, o) => { t.addEventListener(ev, f, o); (this._offs || (this._offs = [])).push(() => t.removeEventListener(ev, f, o)); };
    on(canvas, 'pointerdown', (e) => this._down(e));
    // a drag / wheel may also start on labels floating over the map (opts.extra, e.g. the 3D ①②③ cards; the
    // shell's 主航道 pin #hero-cap / #hero-ring and its hover card #hovercard — §26 open item 11: a drag that starts
    // on the hover card turns the globe too; a plain click on it still does what the card does)
    const extra = (opts.extra || []).concat(typeof document !== 'undefined' ? [document.getElementById('hero-cap'), document.getElementById('hero-ring'), document.getElementById('hovercard')] : []);
    this._extraEls = [];
    for (const el of extra) {
      if (!el || el === canvas) continue;
      this._extraEls.push(el);
      el.style.touchAction = 'none'; // a finger on a label turns the globe too (never pans / zooms the page)
      el.style.userSelect = el.style.webkitUserSelect = 'none'; // (a drag that starts on a card never selects the page's text)
      on(el, 'pointerdown', (e) => this._down(e, true));
      on(el, 'wheel', (e) => this._wheel(e), { passive: false });
    }
    // a drag that started on one of them is never a click on it either
    if (typeof window !== 'undefined') {
      on(window, 'click', (e) => {
        if (performance.now() >= this._clickBlock || !e.target || !this._extraEls.some((x) => x.contains(e.target))) return;
        e.stopImmediatePropagation(); e.preventDefault(); this._clickBlock = 0;
      }, true);
    }
    on(window, 'pointermove', (e) => this._move(e));
    on(window, 'pointerup', (e) => this._up(e));
    on(window, 'pointercancel', (e) => this._up(e, true));
    on(canvas, 'lostpointercapture', (e) => { if (this.ptrs.has(e.pointerId)) this._up(e, true); });
    // a drag is never a click (capture phase at the target runs before the planet's own click listener)
    on(canvas, 'click', (e) => { if (performance.now() < this._clickBlock) { e.stopImmediatePropagation(); e.preventDefault(); this._clickBlock = 0; } }, true);
    on(canvas, 'contextmenu', (e) => { if (performance.now() < this._clickBlock) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    on(canvas, 'wheel', (e) => this._wheel(e), { passive: false });
    on(canvas, 'keydown', (e) => this._keyMap(e));
    on(window, 'keydown', (e) => this._keyAny(e));
    this._frameBound = (t) => this._frame(t);
    this._buildDom();
  }

  /** true while the camera moves (drag, inertia, wheel / key glides, 回正): no hover, no hit tests. */
  moving() { return this._moving || !!this.drag?.on || !!this.pinch; }

  destroy() {
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    for (const f of this._offs || []) f();
    clearInterval(this._placeT);
    if (this.el) this.el.remove();
    delete this.canvas.dataset.mwCam;
    this.canvas.classList.remove('mw-grab');
  }

  // ------------------------------------------------------------------------------------------ pointers
  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _busy() { return !!(this.cam.busy && this.cam.busy()); }

  _down(e, extra) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!extra) { try { this.canvas.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.vel = null; // a touch stops the spin
    if (this.ptrs.size === 1) {
      this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, on: false, hist: [], type: e.pointerType };
      this.pinch = null;
    } else if (this.ptrs.size === 2) {
      // two fingers: pinch + pan (the drag ends here)
      if (this.drag && !this.drag.on) this._startGesture();
      this.drag = null;
      this.pinch = this._pinchState();
      for (const id of this.ptrs.keys()) { try { this.canvas.setPointerCapture(id); } catch (_) { /* ignore */ } }
    }
  }

  _pinchState() {
    const [a, b] = [...this.ptrs.values()];
    const r = this.canvas.getBoundingClientRect();
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
  }

  _move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (this._busy()) return;
    if (this.pinch && this.ptrs.size >= 2) {
      const q = this._pinchState();
      const f = q.d / this.pinch.d;
      const dx = q.mx - this.pinch.mx, dy = q.my - this.pinch.my;
      this.pinch = q;
      if (dx || dy) this.cam.rotate(dx, dy);
      if (Math.abs(f - 1) > 1e-4) this.cam.zoom(f, q.mx, q.my);
      this._kick();
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < (DRAG_PX[d.type] || 5)) return;
      d.on = true;
      d.lx = e.clientX; d.ly = e.clientY;
      try { const sel = window.getSelection && window.getSelection(); if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges(); } catch (_) { /* ignore */ }
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.canvas.classList.add('mw-grab');
      this._startGesture();
      return;
    }
    const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
    d.lx = e.clientX; d.ly = e.clientY;
    if (!dx && !dy) return;
    this.cam.rotate(dx, dy);
    const now = performance.now();
    d.hist.push([now, dx, dy]);
    while (d.hist.length > 2 && now - d.hist[0][0] > 90) d.hist.shift();
    this._kick();
  }

  _up(e, cancel) {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (!this.ptrs.size) this._kick(); // the camera settles once every finger is up
    const d = this.drag;
    if (this.pinch) {
      // one finger left the pinch: nothing flings, the next touch starts fresh
      this.pinch = null;
      this.drag = null;
      this._clickBlock = performance.now() + 350;
      if (!this.ptrs.size) this._kick();
      return;
    }
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.canvas.classList.remove('mw-grab');
    if (!d.on) return; // a click: the planet handles it
    this._clickBlock = performance.now() + 300;
    // fling from the last ~90 ms (released after holding still → no fling), capped so it turns, never spins away
    const now = performance.now();
    const h = d.hist.filter((x) => now - x[0] < 110);
    if (!cancel && h.length && now - h[h.length - 1][0] < 70) {
      const span = Math.max(16, now - h[0][0]) / 1000;
      let sx = 0, sy = 0;
      for (const x of h) { sx += x[1]; sy += x[2]; }
      let vx = sx / span, vy = sy / span;
      const m = Math.hypot(vx, vy), cap = 2600;
      if (m > cap) { vx *= cap / m; vy *= cap / m; }
      if (m > 60) this.vel = { vx, vy };
    }
    this._kick();
  }

  _startGesture() {
    if (!this._moving) { this._moving = true; this.cam.begin && this.cam.begin(); }
    this._kick();
  }

  // ------------------------------------------------------------------------------------------ wheel / keys
  _wheel(e) {
    e.preventDefault(); // only on the map canvas: the page never scrolls from here, and nothing else is touched
    if (this._busy()) return;
    let dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    dy = clamp(dy, -240, 240);
    // trackpad pinch arrives as ctrl+wheel with small deltas: steeper; a mouse notch (≈100) ≈ ×1.3
    const k = e.ctrlKey ? 0.011 : 0.0026;
    this.wheelLog += -dy * k;
    this.wheelLog = clamp(this.wheelLog, -2.5, 2.5);
    this.wheelAt = this._local(e);
    this._startGesture();
  }

  /** The stock view or a module's own dialog covers the map. */
  _covered() {
    const b = document.body.classList;
    const tu = document.getElementById('tutorial');
    return b.contains('mw-modal-open') || b.contains('in-stock') || !!document.querySelector('.mw-modal-open') || !!(tu && !tu.hidden);
  }

  _typing(e) {
    const t = e.target;
    return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
  }

  _visible() {
    const r = this.canvas.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && this.canvas.isConnected && getComputedStyle(this.canvas).visibility !== 'hidden';
  }

  /** + / − / 0 anywhere (outside text fields and modals). */
  _keyAny(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || this._typing(e)) return;
    if (!this._visible() || this._covered()) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomStep(1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomStep(-1); }
    else if (e.key === '0') { e.preventDefault(); this.reset(); }
  }

  /** Arrow keys while the map has focus: turn the globe a step (a short glide). */
  _keyMap(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || this._busy()) return;
    const step = e.shiftKey ? 180 : 70;
    const m = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const k = this.keyRot || { x: 0, y: 0 };
    k.x = clamp(k.x + m[0], -400, 400); k.y = clamp(k.y + m[1], -400, 400);
    this.keyRot = k;
    this.vel = null;
    this._startGesture();
  }

  zoomStep(sign) {
    if (this._busy()) return;
    this.wheelLog = clamp(this.wheelLog + sign * Math.log(1.6), -2.5, 2.5);
    this.wheelAt = null;
    this._startGesture();
  }

  reset() {
    if (this._busy()) return;
    this.vel = null; this.wheelLog = 0; this.keyRot = null;
    this._startGesture();
    this.cam.reset();
  }

  // ------------------------------------------------------------------------------------------ frame loop
  _kick() {
    if (this._raf || this._destroyed) return;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frameBound);
  }

  _frame(now) {
    this._raf = 0;
    if (this._destroyed) return;
    const dt = clamp((now - this._last) / 1000, 0.001, 0.1);
    this._last = now;
    let active = !!(this.drag && this.drag.on) || !!this.pinch;
    if (this._busy()) { this.vel = null; this.wheelLog = 0; this.keyRot = null; }
    // inertia: a gentle glide that dies out in ~0.8 s
    if (this.vel && !(this.drag && this.drag.on)) {
      const { vx, vy } = this.vel;
      this.cam.rotate(vx * dt, vy * dt);
      const damp = Math.exp(-dt * 4.2);
      this.vel.vx *= damp; this.vel.vy *= damp;
      if (Math.hypot(this.vel.vx, this.vel.vy) < 12) this.vel = null;
      active = true;
    }
    // wheel / ± : the pending zoom eases in (no jumps on a mouse notch)
    if (Math.abs(this.wheelLog) > 1e-4) {
      const take = Math.abs(this.wheelLog) < 0.002 ? this.wheelLog : this.wheelLog * (1 - Math.exp(-dt * 16));
      this.wheelLog -= take;
      const at = this.wheelAt;
      this.cam.zoom(Math.exp(take), at ? at[0] : null, at ? at[1] : null);
      active = true;
    } else this.wheelLog = 0;
    if (this.keyRot) {
      const k = this.keyRot, f = 1 - Math.exp(-dt * 12);
      let dx = k.x * f, dy = k.y * f;
      if (Math.abs(k.x) < 0.5 && Math.abs(k.y) < 0.5) { dx = k.x; dy = k.y; this.keyRot = null; }
      else { k.x -= dx; k.y -= dy; }
      this.cam.rotate(dx, dy);
      active = true;
    }
    if (this.cam.animating && this.cam.animating()) { if (this.cam.tick) this.cam.tick(dt); active = true; }
    this._updateCompass();
    if (active) { this._settleT = now; this._kick(); return; }
    if (this._moving && !this.ptrs.size) {
      this._moving = false;
      this.cam.settle && this.cam.settle();
    }
  }

  // ------------------------------------------------------------------------------------------ the little controls
  _buildDom() {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.className = 'mw-camctl';
    if (!document.getElementById('mw-camctl')) el.id = 'mw-camctl'; // labels keep clear of it (main.js AVOID)
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', '地图视角');
    const compass = this.opts.compass
      ? `<button class="cc-compass" type="button" title="指北（把北方转到上面）" aria-label="指北"><svg viewBox="-13 -13 26 26" aria-hidden="true">
           <g class="cc-needle"><path class="n" d="M0,-9.5 L3,0 L-3,0 Z"/><path class="s" d="M0,9.5 L3,0 L-3,0 Z"/></g>
           <text x="0" y="-9.6" text-anchor="middle" dominant-baseline="auto">N</text></svg></button>`
      : '';
    el.innerHTML = `${compass}<div class="cc-stack"><button class="cc-in" type="button" title="放大（滚轮 / 双指 / +）" aria-label="放大">＋</button><button class="cc-out" type="button" title="缩小（滚轮 / 双指 / −）" aria-label="缩小">－</button></div><button class="cc-reset" type="button" title="回到这一层的默认视角（0）" aria-label="回正">回正</button>`;
    const stop = (e) => e.stopPropagation();
    el.addEventListener('pointerdown', stop);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this._wheel(Object.assign(Object.create(null), { deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, preventDefault() {}, clientX: NaN, clientY: NaN })); this.wheelAt = null; }, { passive: false });
    el.querySelector('.cc-in').addEventListener('click', () => this.zoomStep(1));
    el.querySelector('.cc-out').addEventListener('click', () => this.zoomStep(-1));
    el.querySelector('.cc-reset').addEventListener('click', () => this.reset());
    const cb = el.querySelector('.cc-compass');
    if (cb) cb.addEventListener('click', () => { if (this._busy()) return; this._startGesture(); this.cam.northUp && this.cam.northUp(); });
    this.el = el;
    this.needle = el.querySelector('.cc-compass svg');
    document.body.appendChild(el);
    this._place();
    this._placeT = setInterval(() => this._place(), 450);
  }

  /** Bottom-right of the map, clear of the time bar and the side panel. */
  _place() {
    const el = this.el;
    if (!el || this._destroyed) return;
    if (!el.id && !document.getElementById('mw-camctl')) el.id = 'mw-camctl';
    const vis = this._visible();
    el.style.display = vis ? '' : 'none';
    if (!vis) return;
    const r = this.canvas.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    let right = Math.max(0, W - r.right) + 16, bottom = Math.max(0, H - r.bottom) + 16;
    const shown = (x) => x && !x.hidden && getComputedStyle(x).display !== 'none' && getComputedStyle(x).visibility !== 'hidden';
    const tb = document.getElementById('timebar');
    if (shown(tb)) { const q = tb.getBoundingClientRect(); if (q.height > 0 && q.top > H * 0.5) bottom = Math.max(bottom, H - q.top + 12); }
    const pn = document.getElementById('panel');
    if (shown(pn) && !document.body.classList.contains('panel-closed')) {
      const q = pn.getBoundingClientRect();
      if (q.width > 0 && q.left > W * 0.45 && q.bottom > H - bottom - 120) right = Math.max(right, W - q.left + 12);
    }
    // the stock view / a full-screen module covers the map: step aside
    el.classList.toggle('off', this._covered());
    this._updateCompass();
    const rs = el.querySelector('.cc-reset');
    if (rs && this.cam.isDefault) rs.classList.toggle('dim', !!this.cam.isDefault());
    const sR = right + 'px', sB = bottom + 'px';
    if (el.style.right !== sR) el.style.right = sR;
    if (el.style.bottom !== sB) el.style.bottom = sB;
  }

  _updateCompass() {
    if (!this.needle || !this.cam.heading) return;
    const a = this.cam.heading();
    if (a == null || !Number.isFinite(a)) return;
    const deg = (a * 180) / Math.PI; // the needle points to north (clockwise from up)
    if (Math.abs(deg - (this._deg || 0)) < 0.2) return;
    this._deg = deg;
    this.needle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  }

  /** Renderers call this every frame they draw (cheap): keeps the compass true while flights turn the globe. */
  frame() { this._updateCompass(); }
}
