// timemachine.js — bottom bar (§4): play/pause, speed, slider over the 252 days with the planet's idx line
// behind it and the days the wind flipped (fronts) marked as ticks. Colours come from CSS tokens (day/night).
import { h, clear, cnDate, clamp, icon } from './dom.js';

const SPEEDS = [{ label: '1×', dps: 8 }, { label: '2×', dps: 16 }, { label: '慢', dps: 4 }];

export function initTimeMachine(app) {
  const root = document.getElementById('timebar');
  clear(root);
  const playBtn = h('button.tm-play', { type: 'button', title: '播放（空格）', 'aria-label': '播放' }, icon('play', { size: 16 }));
  const speedBtn = h('button.tm-speed', { type: 'button', title: '播放速度：每秒 8 天' }, '1×');
  const canvas = h('canvas.tm-canvas');
  const bubble = h('span.tm-bubble');
  const thumb = h('div.tm-thumb', bubble);
  const ghost = h('div.tm-ghost', h('span.tm-ghost-label'));
  const track = h('div.tm-track', { role: 'slider', tabindex: 0, 'aria-label': '时间机器：拖动看过去的天气' }, canvas, ghost, thumb);
  const todayBtn = h('button.tm-today', { type: 'button', title: '回到最新一天（End）', onclick: () => { stop(); app.setDate(app.lastIdx); } }, '回到今天');
  const label = h('div.tm-label', h('span.tm-label-title', '时间机器'), h('span.tm-label-sub', '拖动看过去一年'));
  root.append(playBtn, speedBtn, label, track, todayBtn);

  let speed = 0, playing = false, raf = 0, last = 0, acc = 0, dragging = false;
  const N = () => app.meta.dates.length;

  // ---------------------------------------------------------------- drawing
  function draw() {
    const r = track.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const W = Math.max(10, r.width), H = Math.max(10, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = N(), X = (k) => (k / Math.max(1, n - 1)) * W;
    const css = getComputedStyle(document.documentElement);
    const v = (k, d) => css.getPropertyValue(k).trim() || d;
    const C = {
      grid: v('--tm-grid', 'rgba(31,42,68,0.08)'), month: v('--tm-month', 'rgba(31,42,68,0.45)'),
      line: v('--tm-line', 'rgba(31,42,68,0.55)'), area: v('--tm-area', 'rgba(31,42,68,0.06)'),
      tick: v('--tm-tick', 'rgba(31,42,68,0.22)'), inn: v('--in', '#4f8f5c'), out: v('--out', '#a33d45'),
    };
    const src = app.trackSource ? app.trackSource() : { idx: app.currentMap?.self?.idx, front: app.currentMap?.self?.front, kids: [] };
    const top = 7, bottom = H - 15;

    // month labels + gridlines
    ctx.font = '10.5px ' + (v('--font', 'sans-serif'));
    ctx.textBaseline = 'alphabetic';
    let prevM = null;
    app.meta.dates.forEach((d, k) => {
      const m = +d.slice(5, 7);
      if (m !== prevM && prevM !== null) {
        const x = X(k);
        ctx.fillStyle = C.grid; ctx.fillRect(Math.round(x), top, 1, bottom - top);
        if (x < W - 28) { ctx.fillStyle = C.month; ctx.fillText(m === 1 ? `${d.slice(2, 4)}年1月` : `${m}月`, x + 4, H - 2); }
      }
      prevM = m;
    });

    // idx line (flat area under it — no gradients, §17)
    const idx = src.idx;
    if (idx && idx.length) {
      let lo = Infinity, hi = -Infinity;
      for (const y of idx) if (y != null) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
      if (hi === lo) { hi += 1; lo -= 1; }
      const Y = (y) => top + 3 + (1 - (y - lo) / (hi - lo)) * (bottom - top - 6);
      const pts = [];
      idx.forEach((y, k) => { if (y != null) pts.push([X(k), Y(y)]); });
      if (pts.length > 1) {
        const line = new Path2D(), area = new Path2D();
        pts.forEach(([x, y], k) => { k ? line.lineTo(x, y) : line.moveTo(x, y); k ? area.lineTo(x, y) : area.moveTo(x, y); });
        area.lineTo(pts[pts.length - 1][0], bottom); area.lineTo(pts[0][0], bottom); area.closePath();
        ctx.fillStyle = C.area; ctx.fill(area);
        ctx.strokeStyle = C.line; ctx.lineWidth = 1.25; ctx.lineJoin = 'round'; ctx.stroke(line);
      }
    }

    // fronts: faint ticks for "how many children flipped", small marks for the planet's own fronts
    const kids = src.kids || [];
    if (kids.length) {
      const cnt = new Array(n).fill(0);
      for (const s of kids) (s.front || []).forEach((f, k) => { if (f) cnt[k]++; });
      const mx = Math.max(1, ...cnt);
      ctx.fillStyle = C.tick;
      cnt.forEach((c, k) => { if (c) { const hh = 2 + (c / mx) * 6; ctx.fillRect(Math.round(X(k)), bottom - hh, 1, hh); } });
    }
    (src.front || []).forEach((f, k) => {
      if (!f) return;
      ctx.fillStyle = f > 0 ? C.inn : C.out;
      const x = X(k);
      ctx.beginPath();
      if (f > 0) { ctx.moveTo(x - 3, top + 4); ctx.lineTo(x + 3, top + 4); ctx.lineTo(x, top - 1); }   // ▲ like a cold-front pip
      else { ctx.arc(x, top + 3, 2.4, Math.PI, 0); }                                                   // ◠ like a warm-front pip
      ctx.closePath(); ctx.fill();
    });
    placeThumb();
  }

  function placeThumb() {
    const r = track.getBoundingClientRect();
    const i = app.state.dateIndex, n = N();
    const x = (i / Math.max(1, n - 1)) * r.width;
    thumb.style.transform = `translateX(${x}px)`;
    bubble.textContent = cnDate(app.meta.dates[i]);
    bubble.classList.toggle('flip', x > r.width - 44);
    track.setAttribute('aria-valuemin', 0); track.setAttribute('aria-valuemax', n - 1);
    track.setAttribute('aria-valuenow', i); track.setAttribute('aria-valuetext', cnDate(app.meta.dates[i], true, true));
    const latest = i === app.lastIdx;
    const was = todayBtn.classList.contains('show');
    todayBtn.classList.toggle('show', !latest);
    root.classList.toggle('past', !latest);
    if (was === latest) requestAnimationFrame(draw);   // the track got wider/narrower: redraw at the new width
  }

  // ---------------------------------------------------------------- interaction
  const idxAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return clamp(Math.round(((clientX - r.left) / r.width) * (N() - 1)), 0, N() - 1);
  };
  track.addEventListener('pointerdown', (e) => {
    if (app.touring) return;
    dragging = true; stop(); track.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    app.setDate(idxAt(e.clientX));
  });
  track.addEventListener('pointermove', (e) => {
    if (dragging) { app.setDate(idxAt(e.clientX)); return; }
    const k = idxAt(e.clientX), r = track.getBoundingClientRect();
    ghost.style.transform = `translateX(${(k / (N() - 1)) * r.width}px)`;
    ghost.firstChild.textContent = cnDate(app.meta.dates[k]);
    ghost.classList.add('on');
  });
  track.addEventListener('pointerleave', () => ghost.classList.remove('on'));
  const end = (e) => { if (!dragging) return; dragging = false; root.classList.remove('dragging'); try { track.releasePointerCapture(e.pointerId); } catch (_) { /* */ } app.settleDate(); };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stop(); app.setDate(app.state.dateIndex + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1)); }
  });

  playBtn.addEventListener('click', () => toggle());
  speedBtn.addEventListener('click', () => {
    speed = (speed + 1) % SPEEDS.length;
    speedBtn.textContent = SPEEDS[speed].label;
    speedBtn.title = `播放速度：每秒 ${SPEEDS[speed].dps} 天`;
  });

  function frame(t) {
    if (!playing) return;
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    acc += dt * SPEEDS[speed].dps;
    if (acc >= 1) {
      const step = Math.floor(acc); acc -= step;
      const next = Math.min(app.lastIdx, app.state.dateIndex + step);
      app.setDate(next, { playing: true });
      if (next >= app.lastIdx) { stop(); return; }
    }
    raf = requestAnimationFrame(frame);
  }
  const setPlayIcon = (on) => {
    clear(playBtn).append(icon(on ? 'pause' : 'play', { size: 16 }));
    playBtn.title = on ? '暂停（空格）' : '播放（空格）';
    playBtn.setAttribute('aria-label', on ? '暂停' : '播放');
  };
  function play() {
    if (playing || app.touring) return;
    if (app.state.dateIndex >= app.lastIdx) app.setDate(0, { playing: true });
    playing = true; acc = 0; last = performance.now();
    setPlayIcon(true);
    root.classList.add('playing');
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!playing) return;
    playing = false; cancelAnimationFrame(raf);
    setPlayIcon(false);
    root.classList.remove('playing');
    app.settleDate();
  }
  function toggle() { playing ? stop() : play(); }

  let rz = 0;
  addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(draw); });
  app.on('nav', draw);
  app.on('data', draw);
  app.on('date', placeThumb);
  app.on('layout', draw);
  app.on('track', draw);
  app.on('theme', () => requestAnimationFrame(draw));
  draw();
  return { draw, toggle, stop, play, isPlaying: () => playing };
}
