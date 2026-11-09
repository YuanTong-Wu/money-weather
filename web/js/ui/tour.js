// tour.js — "▶ 60 秒看懂今天" (§6.6): flies through brief.tour, one big caption per stop, progress bars,
// Esc / click to stop, ←/→ to skip. Ends back on the world. Each stop has a 为什么？ (§21): it ends the tour
// right there (the planet stays) and opens the reason card where the caption was.
import { h, clear, richText, icon } from './dom.js';

const KIND = {
  front: { icon: 'front', label: '风向刚变' },
  inflow: { icon: 'arrow-up', label: '钱在流进来' },
  outflow: { icon: 'arrow-down', label: '钱在溜走' },
  storm: { icon: 'storm', label: '风暴' },
  crowded: { icon: 'crowd', label: '人挤人' },
  quiet: { icon: 'winter', label: '冷清洼地' },
  hot: { icon: 'thermo', label: '突然变热' },
  cold: { icon: 'thermo', label: '突然变冷' },
  spring: { icon: 'spring', label: '春天来了' },
};
const INTRO_MS = 5000, STOP_MS = 8000, OUTRO_MS = 3200;

export function initTour(app) {
  const root = document.getElementById('tour');
  let running = false, token = 0, stops = [], cur = -1, skip = null;

  function buildStops() {
    const b = app.brief || {};
    let list = Array.isArray(b.tour) && b.tour.length ? b.tour : (b.spotlight || []).map((s) => ({ ...s, caption: s.why, captionMild: s.whyMild }));
    if (!list.length && app.rootMap) {
      // no brief: tour the root's own attention picks
      try {
        const world = app.D.rootNodeOf();
        list = (app.W.attentionPicks(app.rootMap, world.children, app.lastIdx, 3) || [])
          .map((p) => ({ id: p.id, pathIds: [world.id, p.id], caption: `【${app.D.nodeById(p.id)?.name || p.id}】${p.why}`, kind: p.kind }));
      } catch (e) { list = []; }
    }
    const rid = app.rootId();
    const MAPS = { global: '全球', full: '全市场', curated: '精选' };
    return list.slice(0, 6).map((s) => {
      // a stop that lives on another map (the brief's 全球雷达 pick on 精选): a caption-only stop on the world,
      // with a link that ends the tour and opens it there — never silently dropped
      if (s.map && s.map !== app.state.map && !app.D.nodeById(s.id)) {
        const where = typeof s.path === 'string' ? s.path : '';
        return {
          id: s.id, elsewhere: s.map, mapName: MAPS[s.map] || s.map, ticker: s.ticker || (String(s.id).startsWith('s:') ? String(s.id).slice(2) : null),
          planetPath: [rid], caption: app.say(s, 'caption') || app.say(s, 'why') || '', kind: s.kind || '',
          name: s.name || s.id, where: [s.label || MAPS[s.map], where].filter(Boolean).join(' · '),
        };
      }
      let ids = Array.isArray(s.pathIds) && s.pathIds.length ? s.pathIds.slice() : app.D.pathIds(s.id) || [rid];
      if (ids[0] === 'world' && rid !== 'world') ids[0] = rid;
      if (ids[0] !== rid) ids.unshift(rid);
      if (s.id && ids[ids.length - 1] !== s.id) { const p = app.D.pathIds(s.id); if (p) ids = p; }
      const target = ids[ids.length - 1];
      const planetPath = ids.length > 1 ? ids.slice(0, -1) : ids;
      const okPath = app.D.nodesOnPath(planetPath) ? planetPath : (app.D.pathIds(target) || [rid, target]).slice(0, -1);
      const node = app.D.nodeById(target);
      return {
        id: target, planetPath: okPath.length ? okPath : [rid], caption: app.say(s, 'caption') || app.say(s, 'why') || '', kind: s.kind || '',
        name: node?.name || s.name || target,
        where: (okPath || []).slice(1).map((id) => app.D.nodeById(id)?.name || id).concat(node?.name || target).join(' › '),
      };
    }).filter((s) => s.elsewhere || app.D.nodeById(s.id));
  }

  // ---------------------------------------------------------------- UI
  const dotsEl = h('div.tour-dots');
  const capEl = h('div.tour-cap');
  const hint = h('div.tour-hint', h('span.tour-hint-title', '今日巡航'), h('kbd', 'Esc'), h('span', '退出'), h('kbd', '→'), h('span', '下一站'));
  const shield = h('div.tour-shield', { title: '点一下结束巡航', onclick: () => stop() });
  const top = h('div.tour-top', dotsEl, hint);
  const stopBtn = h('button.tour-stop', { type: 'button', title: '结束巡航（Esc）', 'aria-label': '结束巡航', onclick: () => stop() }, icon('close', { size: 16 }));

  function renderDots(ms) {
    clear(dotsEl);
    stops.forEach((s, j) => {
      const d = h('button.tour-dot' + (j < cur ? '.done' : j === cur ? '.cur' : ''), {
        type: 'button', title: s.name, onclick: (e) => { e.stopPropagation(); jump(j); },
      }, h('i'));
      if (j === cur) d.style.setProperty('--dur', ms + 'ms');
      dotsEl.append(d);
    });
  }

  function whyBtn(stop) {
    if (!app.why || !stop?.id) return null;
    const b = h('button.why-link.tour-why', {
      type: 'button', title: '为什么？巡航停在这里，老风上网查原因', dataset: { why: '1' },
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => {
        e.stopPropagation();
        const r = capEl.getBoundingClientRect();
        const target = stop.elsewhere ? { kind: 'stock', ids: [stop.id], map: stop.elsewhere } : { ids: [stop.id] };
        stop_();
        app.why(target, null, { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
      },
    }, '为什么？');
    return b;
  }

  /** A stop on another map: end the tour and open it there. */
  function goBtn(stop) {
    if (!stop?.elsewhere) return null;
    return h('button.link.tour-go', {
      type: 'button', title: `结束巡航，去${stop.mapName}地图看「${stop.name}」`,
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => {
        e.stopPropagation();
        const st = stop;
        stop_();
        app.goSearch({ id: st.id, ticker: st.ticker, scope: st.elsewhere === 'global' ? 'gl' : st.elsewhere === 'full' ? 'fm' : 'curated' });
      },
    }, `去${stop.mapName}地图看 ›`);
  }

  function caption({ kicker, ic, text, where, big = true, n = null, stop = null }) {
    capEl.classList.remove('in');
    void capEl.offsetWidth;
    clear(capEl).append(...[
      h('div.tour-meta', n != null ? h('span.num', String(n)) : null, ic ? icon(ic, { size: 15 }) : null,
        kicker ? h('span.tour-kicker', kicker) : null, where ? h('span.tour-where', where) : null, whyBtn(stop), goBtn(stop)),
      h('div.tour-line' + (big ? '.big' : ''), richText(text))].filter(Boolean));
    capEl.classList.add('in');
  }

  function wait(ms, my) {
    return new Promise((res) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); if (skip === done) skip = null; res(my === token); }
      skip = done;
    });
  }

  // ---------------------------------------------------------------- flow
  async function run(from = 0) {
    const my = ++token;
    const rid = app.rootId();
    if (from === 0) {
      cur = -1; renderDots(0);
      app.setTourStage({ kind: 'intro' });            // the 主航道 stays up for the headline, nothing else is lit
      await app.navTo([rid]);
      if (my !== token) return;
      caption({ ic: 'channel', text: app.say(app.brief, 'headline') || '先看看全世界的钱往哪儿流。', kicker: '先看全局', where: '接下来带你去今天最值得看的几个地方' });
      if (!(await wait(INTRO_MS, my))) return;
    }
    for (let j = Math.max(0, from); j < stops.length; j++) {
      if (my !== token) return;
      cur = j;
      const s = stops[j];
      renderDots(STOP_MS);
      capEl.classList.remove('in');
      app.setTourStage(null);                          // quiet while the camera moves
      await app.navTo(s.planetPath);
      if (my !== token) return;
      // only this stop's territory carries a number (and turns to the viewer); the big caption carries the words
      app.setTourStage(s.elsewhere ? { kind: s.kind || 'elsewhere' } : { kind: s.kind || 'stop', id: s.id, n: j + 1 });
      const k = KIND[s.kind] || {};
      caption({ n: j + 1, ic: s.elsewhere ? 'map' : k.icon, text: s.caption || `${s.name}：${k.label || ''}`, where: s.where, kicker: k.label, stop: s });
      renderDots(STOP_MS);
      if (!(await wait(STOP_MS, my))) return;
    }
    if (my !== token) return;
    cur = stops.length; renderDots(0);
    app.setTourStage(null);
    capEl.classList.remove('in');
    await app.navTo([rid]);
    if (my !== token) return;
    caption({ ic: 'check', text: app.state.voice === 'mild' ? '今天的天气就这些。想细看哪里，点哪里。' : '就这些。剩下的都是噪音，想细看自己点进去。', kicker: '巡航结束', big: true });
    if (!(await wait(OUTRO_MS, my))) return;
    stop();
  }

  function jump(j) {
    if (!running) return;
    j = Math.max(0, Math.min(stops.length - 1, j));
    token++;
    if (skip) skip();
    run(j);
  }

  async function start() {
    if (running) return;
    if (!app.brief?.tour?.length && !app.brief?.spotlight?.length) app.rootMap = await app.D.loadMap(app.rootId()).catch(() => null);
    stops = buildStops();
    if (!stops.length) { app.toast('今天风平浪静，没有特别要看的地方。'); return; }
    running = true;
    app.touring = true;
    document.body.classList.add('touring');
    app.beforeTour();
    clear(root).append(shield, top, capEl, stopBtn);
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('on'));
    app.emit('tour', true);
    run(0).catch((e) => { console.warn('[tour]', e); stop(); });
  }

  function stop_() { stop(); }
  function stop() {
    if (!running) return;
    running = false;
    token++;
    if (skip) skip();
    app.touring = false;
    document.body.classList.remove('touring');
    root.classList.remove('on');
    setTimeout(() => { if (!running) { root.hidden = true; clear(root); } }, 300);
    app.afterTour();
    app.emit('tour', false);
  }

  return {
    start, stop,
    next: () => { if (running && skip) skip(); },          // ends the current hold → the tour moves on by itself
    prev: () => jump(Math.max(0, cur - 1)),
    isRunning: () => running,
  };
}
