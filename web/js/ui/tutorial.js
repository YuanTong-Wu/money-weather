// tutorial.js — 怎么看这张图 (§4, §8, §12, §17, §22). Opens on the first visit and from the help button.
// Illustrations: the Blender-rendered cards in assets/3d/illustrations (art3d/illustrations.py — toon shading,
// ink lines, the planet's own palette; _night twins for the night theme, hero_<theme> for the 主航道 card).
// The flat SVG drawings below stay as the fallback when an image cannot load. No emoji. Sharp voice by default.
// Keyboard comes from main.js (onKey) so Esc always closes it; the ✕ lives in a header that never scrolls away.
import { h, clear, store, icon } from './dom.js';

// ---------------------------------------------------------------- copy (§12: adult, blunt, ≤ 30 字 a sentence)
// Five cards (§4: 4–5), in the order the eye meets the map: hero → colour & wind → crowding & storms → seasons →
// fly in + the daily 60 秒. The extra layers (white clouds, ⚡ tags, the outer band) get one quiet line, not a card.
const SHARP = {
  map: { title: '先看主航道，再看 ①②③', body: '每块地是一群股票。那条粗箭头（或那个圈）是今天的主航道：钱从哪搬到哪。然后按 ①②③ 看三处，其他都是背景。' },
  tempwind: { title: '颜色 = 温度，风线 = 钱在搬家', body: '越红越热：涨得比平时快、比邻居快；越蓝越冷，没人疼。风线从失血的地方吹向吸钱的地方，线越密，钱搬得越狠。' },
  presstorm: { title: '挤 / 空 = 人多人少，乌云 = 风暴', body: '「挤」是人挤人，这时候冲进去多半是接最后一棒；「空」是冷清洼地，往往是下一个春天的起点。乌云打闪：波动突然放大，坐稳扶好。',
    note: '白云是预言市场在动，⚡ 是你投喂的情报，星球外圈是全球的水位——都是参考，不是测出来的天气。' },
  season: { title: '季节 = 钱走到哪一步了', body: '春：钱刚进来，还不挤。夏：正热，人多。秋：钱从挤的地方撤。冬：没人管。季节说的是现在的人气和钱，不是预言；下一步看历史概率。' },
  zoom: { title: '点进去，一路飞到单只股票', body: '点哪块飞进哪块，Esc 飞回来。底部时间条拖一拖，过去一年都在。每天先按「60 秒看懂今天」，看完就够了。' },
};
const MILD = {
  map: { title: '这是一张钱的天气图', body: '每块地是一群股票。粗箭头（或一个圈）是今天的主航道：钱从哪里流向哪里。再按 ①②③ 的顺序看三个地方就够了。' },
  tempwind: { title: '颜色是温度，风线是钱在流动', body: '红色表示涨得比平时和邻居快，蓝色表示冷清。风线从流出的地方吹向流入的地方，线越密，流动越大。' },
  presstorm: { title: '挤 / 空 是人多人少，乌云是风暴', body: '「挤」表示交易拥挤，追进去要小心；「空」表示冷清，常常是下一轮的起点。乌云和闪电表示波动突然变大。',
    note: '白云是预言市场的变化，⚡ 是你投喂的情报，外圈是全球流动性——它们是参考信息，不是测量出来的天气。' },
  season: { title: '季节 = 钱走到哪一步', body: '春：钱刚开始进来，还不挤。夏：正热、人多。秋：钱从拥挤处撤离。冬：冷清没人管。春天的地方最值得留意。' },
  zoom: { title: '点进去，一路看到单只股票', body: '点哪块就飞进哪块，Esc 返回。底部时间条可以看过去一年。每天先看「60 秒看懂今天」就够了。' },
};
const ORDER = ['map', 'tempwind', 'presstorm', 'season', 'zoom'];
const DEMO_OF = { tempwind: 'wind', presstorm: 'storm' };
// words.js cards whose topic already lives inside one of the five (so they never add a sixth or seventh)
const COVERED = { temp: 'tempwind', wind: 'tempwind', particle: 'tempwind', pres: 'presstorm', storm: 'presstorm', spotlight: 'map', channel: 'map' };

// ---------------------------------------------------------------- illustrations (440 × 170, CSS tokens)
const S = (inner) => `<svg viewBox="0 0 440 170" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${inner}</svg>`;
const NUM = (x, y, n) => `<g class="d-num"><circle cx="${x}" cy="${y}" r="10"/><text x="${x}" y="${y + 4}" text-anchor="middle">${n}</text></g>`;
function planetArt(cx, cy, r, cells, id) {
  const clip = `tut-clip-${id}`, mask = `tut-mask-${id}`;
  return `<defs><clipPath id="${clip}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <mask id="${mask}"><rect x="0" y="0" width="440" height="170" fill="#fff"/><circle cx="${cx - r * 0.22}" cy="${cy - r * 0.2}" r="${r * 1.02}" fill="#000"/></mask></defs>
    <ellipse class="d-drop" cx="${cx + 4}" cy="${cy + r + 6}" rx="${r * 0.82}" ry="5"/>
    <g clip-path="url(#${clip})">${cells}<rect x="0" y="0" width="440" height="170" class="d-shade" mask="url(#${mask})"/></g>
    <path class="d-rim" d="M${cx - r * 0.86} ${cy - r * 0.42}A${r} ${r} 0 0 1 ${cx - r * 0.2} ${cy - r * 0.97}"/>
    <circle class="d-outline" cx="${cx}" cy="${cy}" r="${r}"/>`;
}
const cell = (pts, band) => `<path class="d-cell" style="fill:var(--t${band})" d="M${pts.join('L')}Z"/>`;

const DEMOS = {
  map: () => S(`${planetArt(200, 84, 70, [
    cell(['120 0', '205 0', '196 66', '152 104', '120 104'], 2),
    cell(['205 0', '290 0', '290 76', '244 88', '196 66'], 6),
    cell(['120 104', '152 104', '196 66', '210 118', '182 170', '120 170'], 4),
    cell(['196 66', '244 88', '250 132', '210 118'], 7),
    cell(['244 88', '290 76', '290 170', '182 170', '210 118', '250 132'], 3),
  ].join(''), 'map')}
    <path class="d-chan-case" d="M168 128C186 98 214 62 252 44"/>
    <path class="d-chan" d="M168 128C186 98 214 62 252 44"/>
    <path class="d-chan-flow" d="M168 128C186 98 214 62 252 44"/>
    <path class="d-chan-head" d="M244 36l16 5-9 14z"/>
    ${NUM(226, 104, 1)}${NUM(160, 48, 2)}${NUM(262, 134, 3)}
    <g class="d-tag"><rect x="300" y="30" width="112" height="44" rx="6"/><text x="314" y="49">今天的主航道</text><text class="d-tag-sub" x="314" y="65">钱从这里 → 那里</text></g>
    <path class="d-leader" d="M300 52H262"/>
    <g class="d-tag"><rect x="300" y="96" width="112" height="44" rx="6"/><text x="314" y="115">①②③</text><text class="d-tag-sub" x="314" y="131">按顺序看三处</text></g>`),

  temp: () => {
    const labels = [[0, '很冷'], [2, '凉'], [4, '常温'], [6, '暖'], [8, '很热']];
    let tiles = '';
    for (let k = 0; k < 9; k++) tiles += `<rect class="d-tile" x="${34 + k * 42}" y="44" width="40" height="52" rx="4" style="fill:var(--t${k})"/>`;
    const txt = labels.map(([k, t]) => `<text class="d-lbl" x="${54 + k * 42}" y="122" text-anchor="middle">${t}</text>`).join('');
    return S(`<text class="d-cap" x="34" y="30">冷</text><text class="d-cap" x="406" y="30" text-anchor="end">热</text>
      <path class="d-axis" d="M52 26H388"/><path class="d-axis-head" d="M384 22l6 4-6 4"/>
      ${tiles}${txt}<text class="d-note" x="220" y="152" text-anchor="middle">跟它自己过去一年比，也跟邻居比</text>`);
  },

  wind: () => {
    const lines = [
      'M108 62C170 46 250 46 318 64', 'M104 84C170 76 260 76 330 86', 'M110 106C180 112 252 112 322 104',
      'M120 128C186 138 246 136 306 124', 'M126 42C180 30 236 30 290 42',
    ];
    return S(`<path class="d-blob" style="fill:var(--t2)" d="M30 50C52 18 104 24 114 58 124 92 118 132 82 142 44 152 14 124 16 96 17 76 22 62 30 50Z"/>
      <path class="d-blob" style="fill:var(--t6)" d="M318 40C352 18 410 30 420 70 430 112 404 146 364 146 330 146 312 118 310 92 308 70 306 50 318 40Z"/>
      ${lines.map((d) => `<path class="d-wind-trace" d="${d}"/>`).join('')}
      ${lines.map((d, k) => `<path class="d-wind" style="animation-delay:-${(0.3 + k * 0.41).toFixed(2)}s" d="${d}"/>`).join('')}
      <g class="d-tag small"><rect x="34" y="78" width="62" height="24" rx="5"/><text x="65" y="95" text-anchor="middle" class="out">钱流出</text></g>
      <g class="d-tag small"><rect x="334" y="78" width="62" height="24" rx="5"/><text x="365" y="95" text-anchor="middle" class="in">钱流入</text></g>`);
  },

  pres: () => {
    const iso = (cx, cy, k) => `<ellipse class="d-iso" cx="${cx}" cy="${cy}" rx="${22 + k * 24}" ry="${15 + k * 17}"/>`;
    return S(`${[0, 1, 2, 3].map((k) => iso(136, 86, k)).join('')}${[0, 1, 2].map((k) => iso(330, 84, k)).join('')}
      <g class="d-mark hi"><circle cx="136" cy="86" r="15"/><text x="136" y="92" text-anchor="middle">挤</text></g>
      <g class="d-mark lo"><circle cx="330" cy="84" r="15"/><text x="330" y="90" text-anchor="middle">空</text></g>
      <text class="d-note" x="136" y="164" text-anchor="middle">人挤人：小心踩踏</text>
      <text class="d-note" x="330" y="164" text-anchor="middle">冷清洼地：没人要</text>`);
  },

  storm: () => {
    let rain = '';
    for (let k = 0; k < 11; k++) rain += `<path class="d-rain" style="animation-delay:${((k * 0.17) % 0.9).toFixed(2)}s" d="M${84 + k * 11} ${92 + (k % 3) * 6}l-5 11"/>`;
    // classic stationary front: triangles one side, semicircles the other
    let pips = '';
    const pts = [[262, 118], [292, 104], [322, 96], [352, 94], [382, 98]];
    pts.forEach(([x, y], k) => {
      pips += k % 2 === 0
        ? `<path class="d-pip cold" d="M${x - 7} ${y}l7 -11 7 11z"/>`
        : `<path class="d-pip warm" d="M${x - 7} ${y + 1}a7 7 0 0 0 14 0z"/>`;
    });
    return S(`<g class="d-cloud"><path class="base" d="M70 84C58 84 52 70 62 62 60 46 78 38 90 46 96 30 124 28 132 46 146 40 162 50 158 66 170 68 172 84 160 84Z"/>
      <path class="shade" d="M62 74C70 80 150 80 166 74 168 80 164 84 160 84H70C64 84 60 80 62 74Z"/>
      <path class="line" d="M70 84C58 84 52 70 62 62 60 46 78 38 90 46 96 30 124 28 132 46 146 40 162 50 158 66 170 68 172 84 160 84Z"/></g>
      ${rain}
      <path class="d-bolt" d="M118 86l-12 22h12l-9 22 26-31h-13l9-13z"/>
      <path class="d-front" d="M236 128C270 104 330 88 404 100"/>${pips}
      <text class="d-note" x="112" y="160" text-anchor="middle">风暴：波动突然变大</text>
      <text class="d-note" x="324" y="150" text-anchor="middle">锋线：风向刚变</text>`);
  },

  season: () => {
    const items = [['spring', '春', '钱刚进来', 'in'], ['summer', '夏', '正热人多', 'gold'], ['autumn', '秋', '从挤处撤', 'warm'], ['winter', '冬', '没人管', 'cold']];
    let g = '';
    items.forEach(([k, n, say, tone], j) => {
      const x = 62 + j * 105;
      g += `<g class="d-season ${tone}"><circle cx="${x}" cy="70" r="30"/><g transform="translate(${x - 15} 55) scale(1.5)" class="d-sicon">${''}</g>
        <text class="d-sname" x="${x}" y="122" text-anchor="middle">${n}</text><text class="d-note" x="${x}" y="142" text-anchor="middle">${say}</text></g>`;
      if (j < 3) g += `<path class="d-arrow" d="M${x + 38} 70h28"/><path class="d-arrow-head" d="M${x + 62} 65l6 5-6 5"/>`;
    });
    g += `<path class="d-cycle" d="M377 108C380 164 70 170 58 112"/><path class="d-arrow-head" d="M54 118l4-7 6 6"/>`;
    return S(g);
  },

  zoom: () => S(`${planetArt(78, 80, 46, [
    cell(['20 20', '84 20', '78 76', '20 96'], 2), cell(['84 20', '140 20', '140 90', '78 76'], 6),
    cell(['20 96', '78 76', '140 90', '140 140', '20 140'], 4)].join(''), 'z1')}
    <path class="d-ring" d="M100 52a14 14 0 1 1 0.1 0"/>
    <path class="d-cursor" d="M106 60l0 20 5-5 4 9 4-2-4-9 7 0z"/>
    <path class="d-arrow" d="M136 80h36"/><path class="d-arrow-head" d="M168 75l6 5-6 5"/>
    ${planetArt(226, 80, 36, [
    cell(['180 30', '230 30', '222 82', '180 92'], 7), cell(['230 30', '270 30', '270 100', '222 82'], 5),
    cell(['180 92', '222 82', '270 100', '270 130', '180 130'], 3)].join(''), 'z2')}
    <path class="d-arrow" d="M276 80h36"/><path class="d-arrow-head" d="M308 75l6 5-6 5"/>
    <g class="d-stock"><rect x="322" y="42" width="98" height="76" rx="6"/>
      <path class="price" d="M332 96l12-8 10 4 12-16 10 6 12-20 14-6"/>
      <path class="bar in" d="M336 112v-6M348 112v-3M372 112v-8M396 112v-5"/><path class="bar out" d="M360 112v-4M384 112v-3M408 112v-6"/></g>
    <text class="d-note" x="78" y="152" text-anchor="middle">地球</text><text class="d-note" x="226" y="152" text-anchor="middle">一块大陆</text>
    <text class="d-note" x="371" y="152" text-anchor="middle">单只股票</text>`),
};
DEMOS.spotlight = DEMOS.map;
DEMOS.particle = DEMOS.wind;

// Blender art (art3d/README.md): card key → image base name; 'hero' = hero_<theme> (1600×1000)
const ART = { map: 'hero', spotlight: 'hero', spot: 'hero', channel: 'hero', temp: 'tut_temp', wind: 'tut_wind', particle: 'tut_wind', pres: 'tut_pres', storm: 'tut_storm', season: 'tut_season', zoom: 'tut_zoom' };
const ALT = {
  map: '示意图：一颗星球上，一条粗箭头从冷的地方指向热的地方——今天的主航道',
  temp: '示意图：等温线从冷到热铺过星球，旁边是从雪花到太阳的温度格',
  wind: '示意图：风线从一块冷地吹向一块热地，热地像积木一样升起来',
  pres: '示意图：「挤」的高压圈很密，「空」的低洼圈很松',
  storm: '示意图：一朵乌云下着斜雨、劈一道闪电，旁边是一条带三角和半圆的锋线',
  season: '示意图：春芽、夏日、秋叶、冬雪四个圆盘，用箭头连成一圈',
  zoom: '示意图：点一块地，下一颗星球从里面升起来，再到一只股票',
};
const ART_DIR = 'assets/3d/illustrations/';
function artName(k, theme) {
  const base = ART[k];
  if (!base) return null;
  return base === 'hero' ? `hero_${theme === 'night' ? 'night' : 'day'}` : base + (theme === 'night' ? '_night' : '');
}
const artUrl = (name) => `${ART_DIR}${name}.webp`;
const warmed = new Set();
/** Fetch the next card's art ahead of time so paging never shows a blank slot. */
function warm(card, theme) {
  const k = demoKey(card);
  const name = artName(k, theme);
  if (!name || warmed.has(name)) return;
  warmed.add(name);
  const im = new Image(); im.decoding = 'async'; im.src = artUrl(name);
}
function demoKey(card) {
  const key = String(card.demo || card.key || '').toLowerCase();
  const pick = (...ks) => ks.find((k) => key.includes(k));
  return DEMOS[key] ? key : pick('season', 'temp', 'wind', 'pres', 'storm', 'zoom', 'map', 'spot', 'channel') || 'map';
}

function demoFor(card, theme = 'day') {
  const k = demoKey(card);
  const name = artName(k, theme);
  if (name) {
    const wrap = h('div.tut-demo.tut-art.demo-' + k + (ART[k] === 'hero' ? '.hero' : ''));
    const img = h('img', { src: artUrl(name), alt: ALT[ART[k] === 'hero' ? 'map' : k] || '', width: ART[k] === 'hero' ? 1600 : 1200, height: ART[k] === 'hero' ? 1000 : 700, decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => { wrap.replaceWith(svgDemo(k)); }, { once: true });
    img.addEventListener('load', () => wrap.classList.add('ok'), { once: true });
    wrap.append(img);
    return wrap;
  }
  return svgDemo(k);
}

function svgDemo(k) {
  const svg = (DEMOS[k] || DEMOS[{ spot: 'map', channel: 'map' }[k]] || DEMOS.map)();
  const el = h('div.tut-demo.demo-' + k, { html: svg });
  if (k === 'season') {
    // drop the line icons into the four season circles
    el.querySelectorAll('.d-sicon').forEach((g, j) => {
      const name = ['spring', 'summer', 'autumn', 'winter'][j];
      const span = icon(name, { size: 20 });
      g.innerHTML = span.querySelector('svg').innerHTML;
      g.setAttribute('fill', 'none'); g.setAttribute('stroke', 'currentColor'); g.setAttribute('stroke-width', '1.4');
      g.setAttribute('stroke-linecap', 'round'); g.setAttribute('stroke-linejoin', 'round');
    });
  }
  return el;
}

// ---------------------------------------------------------------- deck
function buildDeck(app) {
  const words = (Array.isArray(app.W?.tutorialCards) ? app.W.tutorialCards : []).filter(Boolean);
  const byKey = new Map(words.map((c) => [c.key, c]));
  const sharp = app.state.voice !== 'mild';
  const keys = ORDER.slice();
  // a genuinely new card from words.js goes before the last — but never past five cards
  for (const c of words) if (c.key && !keys.includes(c.key) && !COVERED[c.key] && keys.length < 5) keys.splice(keys.length - 1, 0, c.key);
  return keys.map((k) => {
    const w = byKey.get(k);
    const copy = sharp ? (SHARP[k] || (w && { title: w.title, body: w.body })) : (MILD[k] || (w && { title: w.title, body: w.body }) || SHARP[k]);
    if (!copy) return null;
    return { key: k, demo: DEMO_OF[k] || w?.demo || k, title: copy.title, body: copy.body, note: copy.note || '' };
  }).filter(Boolean);
}

export function initTutorial(app) {
  const root = document.getElementById('tutorial');
  let k = 0, cards = [], openState = false, prevFocus = null, hideTimer = 0;

  function render() {
    const c = cards[k];
    const last = k === cards.length - 1;
    const card = h('div.tut-card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tut-title' },
      h('div.tut-top',
        h('span.tut-kicker', '怎么看这张图'),
        h('span.tut-step', `${k + 1} / ${cards.length}`),
        h('button.tut-close', { type: 'button', title: '关闭（Esc）', 'aria-label': '关闭教程', onclick: (e) => { e.stopPropagation(); close(); } }, icon('close', { size: 18 }))),
      h('div.tut-scroll',
        demoFor(c, app.state.theme),
        h('h2.tut-title#tut-title', c.title || ''),
        h('p.tut-body', c.body || ''),
        c.note ? h('p.tut-note', c.note) : null),
      h('div.tut-foot',
        h('div.tut-dots', cards.map((_, j) => h('button.tut-dot' + (j === k ? '.on' : ''), { type: 'button', 'aria-label': `第 ${j + 1} 张`, onclick: () => go(j) }))),
        h('div.tut-actions',
          k > 0 ? h('button.btn.ghost', { type: 'button', onclick: () => go(k - 1) }, '上一张') : h('button.btn.ghost', { type: 'button', onclick: close }, '跳过'),
          last
            ? h('button.btn.primary', { type: 'button', onclick: () => { close(); setTimeout(() => app.startTour(), 260); } }, icon('play', { size: 14 }), '60 秒看懂今天')
            : h('button.btn.primary', { type: 'button', onclick: () => go(k + 1) }, '下一张', icon('chev-r', { size: 14 })))));
    clear(root).append(card);
    card.querySelector('.tut-actions .primary')?.focus({ preventScroll: true });
    if (cards[k + 1]) warm(cards[k + 1], app.state.theme);
  }
  const go = (j) => { k = Math.max(0, Math.min(cards.length - 1, j)); render(); };

  function open(start = 0) {
    cards = buildDeck(app);
    if (!cards.length) return;
    clearTimeout(hideTimer);
    if (!openState) prevFocus = document.activeElement;
    openState = true;
    k = Math.min(Math.max(0, start), cards.length - 1);
    render();
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('on'));
    store.set('mw.tutorialSeen', 1);
    app.hover?.hide?.();
  }
  function close() {
    if (!openState) return;
    openState = false;
    root.classList.remove('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!openState) { root.hidden = true; clear(root); } }, 220);
    try { prevFocus?.focus?.({ preventScroll: true }); } catch (e) { /* */ }
  }
  /** Keyboard while open (called by main.js's single key handler). */
  function onKey(e) {
    const key = e.key;
    if (key === 'Escape' || key === 'Esc' || e.keyCode === 27) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (key === 'ArrowRight') { e.preventDefault(); if (k < cards.length - 1) go(k + 1); return; }
    if (key === 'ArrowLeft') { e.preventDefault(); if (k > 0) go(k - 1); return; }
    if (key === 'Tab') {                      // keep focus inside the card
      const f = [...root.querySelectorAll('button')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }
  // click on the dimmed backdrop closes; the card itself swallows clicks
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  app.on('voice', () => { if (openState) { cards = buildDeck(app); go(k); } });
  app.on('theme', () => { if (openState) go(k); });

  return { open, close, onKey, isOpen: () => openState, firstVisit: () => !store.get('mw.tutorialSeen') };
}
