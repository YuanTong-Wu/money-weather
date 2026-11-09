// ui/clouds.js — 预言市场 as high-altitude clouds (DESIGN §10, §18 'clouds' overlay) + the panel section
// "预言市场的风向". A §19 feature module: `init(app)`.
//
// Reads data/polymarket.json (polymarket/fetch.py): {asOf, caveat, markets:[{id, q, qZh, prob, d1, d7, d30,
// volume, endDate, conf, mapBy, nodes:[{id, sign, w}], url, spark}], shifts:[…], brief:[…], aiWatch:[ladders]}
// and, when it exists, data/kalshi.json (same shape, §24). For the planet on screen, child territories that
// markets map to get a faint cloud; brightness = this week's probability swing.
// Phase 3 (owner: "俄罗斯柴油 → 美股" was a weak mapping, captions were cut off):
//  · only CONFIDENT mappings reach the map — |sign| = 1 and (owner / Claude mapping, or a trusted rule with
//    weight ≥ 0.8); a market whose mapped nodes under one territory point both ways says nothing clear about
//    that territory and leaves it alone (so a diesel-import market clouds 能源/商品, never all of 美股);
//  · captions are short enough to never be cut: "美国进口俄罗斯柴油 86% 周+57个点" (≤ 22 characters).
// Calm by default (§6): at most 4 clouds, only ONE carries a caption; the rest show theirs on hover. While a
// 推演 is open the map shows imagined weather and no clouds. Market rows carry the §21 "为什么？" button.
// Styles live in css/scenario.css (shared with the 推演 cards). Owns only this file + the DOM it creates.
import { whyButton, zhFix, sameQuestion } from '../scenario.js';

const LS_ON = 'mw.clouds.on';
const LS_CAVEAT = 'mw.pm.caveatSeen';
const LS_AI = 'mw.pm.aiOpen';
const AI_IDS = new Set(['ai-compute', 'ai-cloud', 'ai-power', 'software', 'security']);

/** append, skipping null/false (Element.append would print "null") */
function add(el, ...kids) {
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c);
  return el;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// same line-art hand as scenario.js and the shell's set
const I = {
  cloud: '<path d="M6.2 15.2h8.3a3.3 3.3 0 0 0 .4-6.6 4.6 4.6 0 0 0-8.8 1.3 2.7 2.7 0 0 0 .1 5.3z"/>',
  up: '<path d="M10 15.5v-11M5.8 8.6 10 4.4l4.2 4.2"/>',
  down: '<path d="M10 4.5v11M5.8 11.4 10 15.6l4.2-4.2"/>',
  ext: '<path d="M8 4.5H4.5v11h11V12"/><path d="M11 3.8h5.2V9M16 4 9.5 10.5"/>',
  calendar: '<rect x="3.5" y="4.6" width="13" height="11.9" rx="1.6"/><path d="M3.5 8.4h13M7 3v3M13 3v3"/>',
  chev: '<path d="M5 8l5 5 5-5"/>',
  chevU: '<path d="M5 12l5-5 5 5"/>',
};
function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', ('scn-i ' + cls).trim());
  s.innerHTML = I[name] || '';
  return s;
}
/** A two-tone cel-shaded cloud whose ink density shows the swing (0–1); the belly tint is the direction. */
function cloudGlyph(strength, dir) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 22');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'pm-cloud ' + (dir > 0 ? 'up' : dir < 0 ? 'down' : ''));
  const a = (0.25 + 0.75 * clamp(strength, 0, 1)).toFixed(2);
  s.innerHTML = '<path class="pm-cloud-body" d="M8.5 19h15.2a5 5 0 0 0 .7-9.95A7.2 7.2 0 0 0 10.6 7.6 5.7 5.7 0 0 0 8.5 19z"/>'
    + `<path class="pm-cloud-shade" style="opacity:${a}" d="M3.4 14.6A5.7 5.7 0 0 0 8.5 19h15.2a5 5 0 0 0 4.9-4c-1.3 1-2.9 1.5-4.6 1.5H9.6a6.2 6.2 0 0 1-6.2-1.9z"/>`
    + '<path class="pm-cloud-line" d="M8.5 19h15.2a5 5 0 0 0 .7-9.95A7.2 7.2 0 0 0 10.6 7.6 5.7 5.7 0 0 0 8.5 19z"/>';
  return s;
}
function spark(vals, dir) {
  const v = (vals || []).map(Number).filter(Number.isFinite);
  if (v.length < 3) return null;
  const W = 56, H = 16;
  const xs = (i) => (i / (v.length - 1)) * W;
  const ys = (p) => H - 1 - clamp(p, 0, 1) * (H - 2);
  const d = v.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(p).toFixed(1)}`).join('');
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  s.setAttribute('class', 'pm-spark ' + (dir > 0 ? 'up' : dir < 0 ? 'down' : ''));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<line x1="0" y1="${ys(0.5)}" x2="${W}" y2="${ys(0.5)}" class="pm-spark-mid"/><path d="${d}"/><circle cx="${xs(v.length - 1)}" cy="${ys(v[v.length - 1])}" r="1.8"/>`;
  return s;
}
function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const pctProb = (p) => {
  if (p == null || !Number.isFinite(+p)) return '—';
  const v = +p * 100;
  if (v > 0 && v < 1) return v.toFixed(1) + '%';
  if (v > 99 && v < 100) return v.toFixed(1) + '%';
  return Math.round(v) + '%';
};
const ptsTxt = (d) => {
  const v = (+d || 0) * 100, a = Math.abs(v);
  const s = a < 1 ? a.toFixed(1) : String(Math.round(a));
  return (v > 0.05 ? '+' : v < -0.05 ? '−' : '±') + s;
};
const daysLeft = (end) => {
  if (!end) return null;
  const t = new Date(String(end).slice(0, 10) + 'T00:00:00');
  if (isNaN(t)) return null;
  const n = new Date();
  return Math.round((t - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
};
/** "俄乌和谈会在……前举行吗｜11月30日" → "俄乌和谈会在11月30日前举行吗？" (the translations keep the
 *  event's question with a ……/｜ slot for the market's own option). */
function cleanQ(m) {
  const raw = zhFix(String(m.qZh || m.q || m.question || '').trim());
  const [a, b] = raw.split('｜');
  let s = a;
  if (b != null) s = a.includes('……') ? a.replace('……', b) : `${a.replace(/[？?]$/, '')}：${b}`;
  s = s.replace(/吗$/, '吗？');
  // this year's dates read without the year: "2026年11月30日前" → "11月30日前"
  s = s.replace(new RegExp(`${new Date().getFullYear()}年(?=\\d{1,2}月)`, 'g'), '');
  return s;
}
/** The question without its deadline: "俄乌和谈会在11月30日前举行吗" and "…12月31日前…" are one story. */
const stemOf = (m) => cleanQ(m)
  .replace(/在?\s*(?:\d{4}\s*年)?\s*(?:\d{1,2}\s*月)?\s*(?:\d{1,2}\s*日)?\s*(?:底)?\s*(?:之|以)?前/g, (x) => (/\d/.test(x) ? '' : x))
  .replace(/^\s*\d{4}\s*年\s*(?:底)?\s*/, '').replace(/[？?吗\s]/g, '');
/** One market per event and per deadline-free question (the map and the panel tell each story once). */
function oncePerStory(list) {
  const seen = new Set();
  const kept = [];
  return list.filter((m) => {
    const a = 'e:' + (m.event ?? m.id), b = 'q:' + stemOf(m);
    if (seen.has(a) || seen.has(b)) return false;
    // the same question on Polymarket and Kalshi (or two Kalshi phrasings) is one story: keep the first (biggest)
    const q = `${m.q || m.question || ''} ${m.group || ''}`;
    if (kept.some((k) => sameQuestion(q, k))) return false;
    seen.add(a); seen.add(b); kept.push(q);
    return true;
  });
}

// ---------------------------------------------------------------- confidence + captions
const STRONG_W = 0.8;
/** The mapped nodes we trust enough to draw: |sign| = 1 and a confident mapping. */
function strongNodes(m) {
  const by = m.mapBy || 'rules';
  const trusted = by === 'owner' || by === 'claude' || (m.conf !== 'lo' && m.conf !== 'none');
  if (!trusted) return [];
  return (m.nodes || []).filter((n) => n && n.id && Math.abs(+n.sign || 0) === 1
    && (by === 'owner' || by === 'claude' || n.w == null || +n.w >= STRONG_W));
}
/** visual width: CJK = 1, latin/digits ≈ .55 */
const vw = (s) => [...String(s)].reduce((a, ch) => a + (/[\x00-\xff]/.test(ch) ? 0.55 : 1), 0);
function fitW(s, max) {
  s = String(s || '').trim();
  if (vw(s) <= max) return s;
  let out = '';
  for (const ch of s) { if (vw(out + ch) > max - 1) break; out += ch; }
  return out.replace(/[\s·：:，,、]+$/, '') + '…';
}
/** The heart of a market question in ≤ 10 字宽: deadline, "吗？", filler "会" dropped; "谁｜X" questions name X. */
function topicOf(m, max = 10) {
  const raw = zhFix(String(m.qZh || m.q || m.question || '').trim());
  let [a, b] = raw.split('｜');
  const undate = (s) => String(s || '')
    .replace(/在?\s*(?:\d{4}\s*年)?\s*(?:\d{1,2}\s*月)?\s*(?:\d{1,2}\s*日)?\s*(?:底)?\s*(?:之|以)?前/g, (x) => (/\d/.test(x) ? '' : x))
    .replace(/^\s*\d{4}\s*年\s*(?:底)?\s*/, '').replace(/[吗呢]?\s*[？?]\s*$/, '').replace(/吗$/, '').trim();
  a = undate(a).replace(/[：:]\s*(怎么动|怎么走|会怎样|如何|多少|几次|结果)[？?]?$/, '').replace(/(\d{4})\s*年\s*(?=\d{1,2}\s*月)/g, '');
  let s;
  if (b != null && /什么时候|何时/.test(a)) {
    // "X 什么时候官宣上市｜2026年12月1日之前" — the option IS the date: keep it, short
    const m2 = /(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日)?\s*(之前|以前|前|之后|以后|后)?/.exec(b);
    const when = m2 ? `${m2[2]}月${m2[3] ? m2[3] + '日' : ''}${m2[4] ? (/后/.test(m2[4]) ? '后' : '前') : ''}` : b;
    s = a.replace(/什么时候|何时/, '') + ' ' + when;
  } else if (b != null) {
    b = undate(b);
    if (/谁|哪/.test(a)) s = a.replace(/谁|(?:在)?哪(?:些|个月|一年|一天|里|儿|个|家|一位|位|款)?(?:公司|国家|人)?/, (x) => (x.startsWith('在') && !/^\d/.test(b) ? '在' : '') + b);
    else if (/^[A-Za-z][\w .&'-]{0,20}$/.test(b) && /^会?有/.test(a)) s = `${b} ${a.replace(/^会?有/, '')}`;
    else if (a.includes('……')) s = /^(未|不|没)/.test(b) ? a.replace(/会?在?……/, '') + '·' + b : a.replace('……', b);
    else s = a.replace(/(利率)?(会议)?(决定|结果)$/, '').replace(/会议$/, '').replace(/(如何|怎样|怎么样)$/, '') + (/^[A-Za-z]/.test(b) ? '·' : '') + b;
  } else s = a;
  s = s
    .replace(/^\s*(?:\d{4}\s*年)?\s*\d{1,2}\s*月\s*(?:\d{1,2}\s*日)?\s*(?:底|初|中)?\s*/, '')   // a leading date says least
    .replace(/在\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g, '')
    .replace(/^下一?(?:个|次|款|任|届)/, '').replace(/^(今年|明年|年末|年底)/, '')
    .replace(/平均时租价/g, '时租').replace(/NVIDIA\s*/g, '英伟达')
    .replace(/([$]?[\d.,]+\s*(?:%|次|个|美元)?)\s*及以上/g, '≥$1').replace(/([$]?[\d.,]+\s*(?:%|次|个|美元)?)\s*及以下/g, '≤$1')
    .replace(/会?到\s*([↑↓])\s*/g, '$1').replace(/最高到\s*/g, '↑').replace(/最低到\s*/g, '↓')
    .replace(/(\d+)\s*年期美债收益率/g, '$1年美债').replace(/\s*个基点/g, 'bp').replace(/模型\s*\((\d[^)]*)\)/g, ' $1')
    .replace(/^([一-龥A-Za-z.]{1,9})会(?![议谈面晤见长员])/, '$1')
    .replace(/([一-龥])\s+(?=[\d$↑↓])|(\d)\s+(?=[一-龥])/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
  return fitW(s, max);
}
/** "美国进口俄罗斯柴油 86% 周+57个点" — ≤ 11 字宽 for the topic, ≤ 22 characters in all (the 3D label's limit).
 *  The swing always carries its unit (个点 = percentage points), the same as the panel and the 推演 drawer. */
function capOf(m) {
  const p = +m.prob;
  const prob = !Number.isFinite(p) ? '—' : p < 0.01 ? '<1%' : p > 0.99 ? '>99%' : Math.round(p * 100) + '%';
  const n = (s) => [...s].length;
  const d = Math.abs((+m.d7 || 0) * 100);
  let tail = `${prob} 周${d < 1 ? '持平' : ptsTxt(m.d7).replace(/\.\d$/, '') + '个点'}`;
  let topic = topicOf(m, 11);
  if (n(topic) + 1 + n(tail) > 22) tail = tail.replace(' ', '');
  while (n(topic) + 1 + n(tail) > 22 && n(topic) > 4) {
    const core = topic.replace(/…$/, '');
    topic = [...core].slice(0, n(core) - (topic.endsWith('…') ? 1 : 2)).join('').replace(/[\s·(（$:：]+$/, '') + '…';
  }
  return `${topic} ${tail}`;
}
const SETTLE_DAYS = 3;

const hashId = (s) => { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
const MOVE_TAIL = {
  upCross: { sharp: ['一周翻盘，押 YES 的成了多数', '风向一周掉了个头', '赌徒们一周内改了主意'], mild: ['一周内转为多数看好', '看好的人一周内过了半'] },
  upBig: { sharp: ['押 YES 的人在抢座', '钱在猛往 YES 押', '信的人一下多了一大截'], mild: ['看好的人明显变多', '押 YES 的明显变多'] },
  up: { sharp: ['风往 YES 这边吹', '有人先动了', '信的人在变多'], mild: ['看好的人在变多', '概率在上升'] },
  downCross: { sharp: ['一周翻盘，信的人成了少数', '风向一周掉了个头', '赌徒们一周内改了主意'], mild: ['一周内转为多数不看好', '看好的人一周内跌破一半'] },
  downBig: { sharp: ['这个赌注在被大逃离', '一周泄了气', '押 YES 的在夺门而逃'], mild: ['看好的人少了很多', '市场明显不太信了'] },
  down: { sharp: ['信的人在悄悄下车', '热度在退', '有人先撤了'], mild: ['看好的人在变少', '概率在下降'] },
};
/** "一周从 22% 跳到 87%，押 YES 的人在抢座。" — what moved, then one sharp word; the wording rotates by market id
 *  and skips a tail already used on this panel (`used`), so neighbouring cards never repeat each other. ≤ 30 字. */
function moveSay(m, voice, used = null) {
  const d = +m.d7 || 0, a = Math.abs(d) * 100;
  const p = +m.prob;
  const left = daysLeft(m.endDate);
  const sharp = voice !== 'mild';
  if (!Number.isFinite(p) || a < 5 || (left != null && left >= 0 && left <= 7 && a >= 15)) return swingSay(m, voice);
  const from = clamp(p - d, 0, 1);
  const cross = (from < 0.5) !== (p < 0.5);
  const k = d > 0 ? (cross && a >= 10 ? 'upCross' : d >= 0.15 ? 'upBig' : 'up') : (cross && a >= 10 ? 'downCross' : d <= -0.15 ? 'downBig' : 'down');
  const list = MOVE_TAIL[k][sharp ? 'sharp' : 'mild'];
  let i = hashId(m.id) % list.length;
  for (let n = 0; n < list.length && used && used.has(list[i]); n++) i = (i + 1) % list.length;
  if (used) used.add(list[i]);
  const verb = d > 0 ? (a >= 15 ? '跳到' : '涨到') : (a >= 15 ? '砸到' : '掉到');
  return `一周从 ${pctProb(from)} ${sharp ? verb : d > 0 ? '升到' : '降到'} ${pctProb(p)}，${list[i]}。`;
}
/** One sharp (or mild) line about a week's swing. ≤ 30 字, follows from the numbers shown. */
function swingSay(m, voice) {
  const d = +m.d7 || 0, a = Math.abs(d) * 100, x = a < 1 ? a.toFixed(1) : Math.round(a);
  const left = daysLeft(m.endDate);
  const soon = left != null && left >= 0 && left <= 7;
  const sharp = voice !== 'mild';
  if (soon && a >= 15) return sharp ? `${left} 天后就截止，这是收盘前清算，别当新风向。` : `${left} 天后截止，这次大变动多半是临近结算。`;
  if (d >= 0.15) return sharp ? `一周狂拉 ${x} 个点，押 YES 的人在抢座。` : `一周涨了 ${x} 个点，看好的人明显变多。`;
  if (d >= 0.05) return sharp ? `一周多了 ${x} 个点，风往 YES 这边吹。` : `一周上升 ${x} 个点。`;
  if (d <= -0.15) return sharp ? `一周砸掉 ${x} 个点，这个赌注在被大逃离。` : `一周跌了 ${x} 个点，看好的人少了很多。`;
  if (d <= -0.05) return sharp ? `一周掉了 ${x} 个点，信的人在悄悄下车。` : `一周下降 ${x} 个点。`;
  return sharp ? '这周几乎没动，市场懒得改主意。' : '这周变化不大。';
}

/** Weight of a market for "is a weather system forming here": the swing × how much money is in it. */
function marketScore(m) {
  const swing = Math.abs(+m.d7 || 0);
  const vol = Math.max(+m.volume || 0, 1000);
  const wv = clamp((Math.log10(vol) - 4) / 3, 0.15, 1);          // $10k → .15 … $10M → 1
  const left = daysLeft(m.endDate);
  // settling markets swing for no new reason; finished ones say nothing about what comes next
  const wt = left == null ? 1 : left < 0 ? 0.05 : left <= 7 ? 0.4 : 1;
  return swing * wv * wt;
}

export function init(app) {
  ensureCss();
  const D = () => app.data || app.D || {};
  const planet = () => app.planet || null;
  const nodeById = (id) => { try { return D().nodeById?.(id) || null; } catch (e) { return null; } };
  const voice = () => (app.state && app.state.voice) || 'sharp';
  const say = (o, k = 'say') => {
    if (!o) return '';
    if (typeof app.say === 'function') { try { return app.say(o, k) || ''; } catch (e) { /* fall through */ } }
    return (voice() === 'mild' && o[k + 'Mild']) || o[k] || '';
  };
  const refreshPanel = () => { try { (app.panel?.refresh || app.panel?.rerender)?.(); } catch (e) { /* optional */ } };

  const S = {
    pm: null,              // polymarket.json
    byId: new Map(),
    shiftById: new Map(),
    under: new Map(),      // node id → [{m, sign}] for every market mapped to it or anything below it
    on: store.get(LS_ON, true) !== false,
    only: null,            // Set of market ids while a 推演 is open (panel list)
    scn: false,            // a 推演 is open: no clouds on the imagined map
    expanded: false,
    aiOpen: store.get(LS_AI, false) === true,
    lastKey: '',
  };

  // ------------------------------------------------------------------ data
  async function getJSON(u) {
    const r = await fetch(u, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status + ' ' + u);
    return r.json();
  }
  async function load() {
    let pm = null, ks = null;
    // polymarket.json / kalshi.json are shared files: they live in data/ even when the 全市场 map (data/fm/) is shown
    let names = null;
    try { names = typeof D().listDir === 'function' ? await D().listDir('data/') : null; } catch (e) { names = null; }
    try { pm = await getJSON('data/polymarket.json'); } catch (e) { pm = null; }
    if (!names || names.has('kalshi.json')) { try { ks = await getJSON('data/kalshi.json'); } catch (e) { ks = null; } }
    pm = pm && Array.isArray(pm.markets) ? pm : null;
    if (ks && Array.isArray(ks.markets) && ks.markets.length) {
      const km = ks.markets.map((m) => ({ ...m, src: 'kalshi' }));
      if (pm) {
        pm = { ...pm, markets: pm.markets.concat(km), shifts: (pm.shifts || []).concat((ks.shifts || []).map((x) => (typeof x === 'object' ? { ...x, src: 'kalshi' } : x))),
          brief: (pm.brief || []).concat(ks.brief || []), kalshiAsOf: ks.asOf || null };
      } else pm = { ...ks, markets: km, kalshiAsOf: ks.asOf || null, asOf: null };
    }
    S.pm = pm;
    index();
  }

  function ancestorsOf(id) {
    const d = D();
    let paths = [];
    try { paths = typeof d.allPaths === 'function' ? d.allPaths(id) : [d.pathIds?.(id)].filter(Boolean); } catch (e) { paths = []; }
    const out = new Set();
    for (const p of paths) for (const x of p) out.add(x);
    if (!out.size && nodeById(id)) out.add(id);
    return out;
  }

  /** S.under: node id → [{m, sign, prox}] for every market CONFIDENTLY mapped to it or below it. sign = 0 when the
   *  market's nodes under this territory point both ways (then it says nothing clear about it); prox = 1 for
   *  the node itself, 0.6 per level further down (a market about one sub-region is a faint signal for the continent). */
  function index() {
    S.byId.clear(); S.under.clear(); S.shiftById.clear();
    if (!S.pm) return;
    for (const x of S.pm.shifts || []) if (x && typeof x === 'object' && x.id != null) S.shiftById.set(String(x.id), x);
    const depthOf = (id) => { const n = nodeById(id); return n && typeof n.depth === 'number' ? n.depth : null; };
    for (const m of S.pm.markets) {
      S.byId.set(String(m.id), m);
      const seen = new Map();   // ancestor → {pos, neg, prox}
      for (const n of strongNodes(m)) {
        const dn = depthOf(n.id);
        for (const a of ancestorsOf(n.id)) {
          const da = depthOf(a);
          const prox = dn != null && da != null ? Math.pow(0.6, Math.max(0, dn - da)) : (a === n.id ? 1 : 0.6);
          const cur = seen.get(a) || { pos: 0, neg: 0, prox: 0 };
          if (+n.sign > 0) cur.pos++; else cur.neg++;
          cur.prox = Math.max(cur.prox, prox);
          seen.set(a, cur);
        }
      }
      for (const [a, s] of seen) {
        if (!S.under.has(a)) S.under.set(a, []);
        S.under.get(a).push({ m, sign: s.pos && s.neg ? 0 : s.pos ? 1 : -1, prox: s.prox });
      }
    }
  }
  const settling = (m) => { const left = daysLeft(m.endDate); return left != null && left < SETTLE_DAYS; };

  const visible = (m) => !S.only || S.only.has(String(m.id));

  function currentNode() {
    try { if (typeof app.currentNode === 'function') return app.currentNode(); } catch (e) { /* fall through */ }
    return nodeById(app.state?.nodeId || 'world');
  }

  // ------------------------------------------------------------------ the overlay
  const labelOf = (m) => capOf(m);
  const CLOUD_K = 0.15;    // one well-traded market swinging 15 points this week ≈ a 63%-bright cloud

  function cloudsFor(node) {
    const raw = [];
    for (const c of node?.children || []) {
      // confident, one-directional, about THIS territory (mapped to it or one level inside it — a market about
      // one corner of 美股 is not a weather system over all of 美股), not a settlement-day ladder
      const list = (S.under.get(c.id) || []).filter((x) => x.sign !== 0 && x.prox >= 0.6 && visible(x.m) && !settling(x.m));
      if (!list.length) continue;
      // one event counts once (its biggest mover): a 30-rung price ladder must not drown a single big question
      const byEvent = new Map();
      for (const x of list) {
        const k = 'e:' + (x.m.event ?? x.m.id);
        const sc = marketScore(x.m) * x.prox;
        if (!byEvent.has(k) || byEvent.get(k).sc < sc) byEvent.set(k, { ...x, sc });
      }
      const evs = [...byEvent.values()].sort((a, b) => b.sc - a.sc);
      const tot = evs.slice(0, 3).reduce((a, x) => a + x.sc, 0);      // the 3 biggest stories, not the long tail
      const top = evs[0];
      const dir = top ? Math.sign(top.sign * (+top.m.d7 || 0)) : 0;    // + = the odds moved in this territory's favour
      raw.push({ id: c.id, tot, ranked: evs.map((x) => x.m), dir, n: evs.length });
    }
    // brightness relative to this planet: a few bright clouds, the rest faint (absolute floor CLOUD_K/3)
    const tots = raw.map((r) => r.tot).sort((a, b) => a - b);
    const K = Math.max(CLOUD_K / 3, tots.length ? tots[Math.floor(0.75 * (tots.length - 1))] : CLOUD_K);
    for (const r of raw) r.strength = 1 - Math.exp(-r.tot / K);
    raw.sort((a, b) => b.strength - a.strength);
    const used = new Set();
    const out = [];
    // territories already carrying a ①②③ caption keep their cloud quiet (caption on hover only)
    const spot = new Set((app.currentPicks || []).map((p) => p.id));
    let captions = 0;
    for (const r of raw.slice(0, S.only ? 2 : 4)) {
      if (r.strength < 0.06 && !S.only) continue;
      // one caption per market: a continent whose top market is already captioned names its next one
      // (and one caption per event: "Anthropic 上市 by Nov 30" and "by Dec 31" are the same story)
      const keys = (x) => [String(x.id), 'e:' + (x.event ?? x.id), 'q:' + stemOf(x)];
      const fresh = r.ranked.find((x) => !keys(x).some((k) => used.has(k)));
      const m = fresh || r.ranked[0];
      if (m) for (const k of keys(m)) used.add(k);
      const label = fresh ? labelOf(fresh) : null;
      // attention budget (§6): ①②③ + 主航道 already speak — at most ONE cloud carries a caption (the planet
      // captions strength ≥ .35); the rest show theirs on hover and in the panel
      let s = clamp(r.strength, 0, 1), captioned = false;
      if (S.only) s = clamp(0.18 + s * 0.12, 0.18, 0.3);
      else if (s >= 0.35 && captions < 1 && !spot.has(r.id)) { captions++; captioned = true; }
      else s = Math.min(s, 0.3);
      // §26 amendment 5: one cloud list for both planets (they apply the same words rule: hover, or a ①②③ territory
      // within the secondary-caption budget — `tip` carries the words, `label` marks the shell's own pick)
      out.push({ id: r.id, strength: +s.toFixed(3), label: captioned ? label : null, tip: label, dir: r.dir, marketId: m ? String(m.id) : null, n: r.n });
    }
    return out;
  }

  function apply(force = false) {
    const p = planet();
    if (!p || typeof p.setOverlay !== 'function') return;
    const node = currentNode();
    // while a 推演 is open the map shows imagined weather: no measured-odds clouds over it (the drawer
    // carries the scenario's own markets and dates)
    // the odds are today's: on a past date (time machine) they would tell a story that did not exist then
    const today = app.lastIdx == null || app.state?.dateIndex == null || app.state.dateIndex >= app.lastIdx;
    const data = S.on && S.pm && !S.scn && today ? cloudsFor(node) : null;
    const key = (node?.id || '') + '|' + (S.scn ? 'scn' : '') + (today ? '' : 'past') + (app.state?.render || '') + (data ? data.map((c) => c.id + c.strength + (c.label ? 'L' : '')).join(',') : 'off');
    if (!force && key === S.lastKey) return;
    S.lastKey = key;
    try { p.setOverlay('clouds', data && data.length ? data : null); } catch (e) { console.warn('[clouds] setOverlay', e); }
  }

  // ------------------------------------------------------------------ panel section
  function marketsHere(node, isRoot) {
    if (!S.pm) return [];
    let list = [];
    if (isRoot && !S.only) {
      const brief = Array.isArray(S.pm.brief) ? S.pm.brief : [];
      const ids = brief.map((b) => String(b.id)).concat((S.pm.shifts || []).map((x) => String(typeof x === 'object' ? x.id : x)));
      list = [...new Set(ids)].map((id) => S.byId.get(id)).filter(Boolean);
      if (!list.length) list = S.pm.markets.slice().sort((a, b) => marketScore(b) - marketScore(a));
      return oncePerStory(list);
    }
    list = (S.under.get(node?.id) || []).filter((x) => x.sign !== 0).map((x) => x.m).filter(visible);
    return oncePerStory([...new Set(list)].sort((a, b) => marketScore(b) - marketScore(a)));
  }

  function territoriesOf(m, node) {
    const out = [];
    for (const c of node?.children || []) {
      // the same rule as the clouds: confident, one-directional, about this territory itself
      const x = (S.under.get(c.id) || []).find((y) => y.m === m && y.sign !== 0 && y.prox >= 0.6);
      if (x) out.push({ id: c.id, name: c.name, sign: x.sign });
    }
    return out.slice(0, 3);
  }

  function row(m, node, used = null) {
    const d = +m.d7 || 0;
    const sh = S.shiftById.get(String(m.id)) || (Array.isArray(S.pm.brief) ? S.pm.brief.find((b) => String(b.id) === String(m.id)) : null);
    // the fetcher's one-liners are canned ("一周翻盘，赌徒们突然信了。" ×3 in a row): say what moved instead
    const line = moveSay(m, voice(), used);
    const effect = sh && sh.effect ? sh.effect : null;
    const terr = territoriesOf(m, node);
    const kalshi = m.src === 'kalshi' || m.source === 'kalshi';
    const why = whyButton(app, { kind: 'market', ids: [String(m.id)], source: kalshi ? 'kalshi' : 'polymarket', map: app.state?.map || 'curated' }, {
      question: `预言市场「${cleanQ(m)}」现在 ${pctProb(m.prob)}，一周 ${ptsTxt(d)} 个点：为什么？最近有什么新闻？`,
      title: '这个盘口为什么这样走：派 Claude 去查新闻和来源（花今天的额度）',
    });
    return h('li.pm-row',
      h('div.pm-row-l', cloudGlyph(clamp(marketScore(m) * 3, 0, 1), d)),
      h('div.pm-row-b', { dataset: { whyHost: '' } },
        h('div.pm-row-q', { title: m.q || '' }, kalshi ? h('span.pm-src', 'Kalshi') : null, cleanQ(m)),
        h('div.pm-row-say', line),
        effect ? h('div.pm-row-eff', effect) : null,
        h('div.pm-row-terr', terr.map((t) => h('button.scn-node.small' + (t.sign > 0 ? '.in' : t.sign < 0 ? '.out' : ''), {
          type: 'button', title: t.sign > 0 ? 'YES 对这里是好事 · 点击飞过去' : t.sign < 0 ? 'YES 对这里是坏事 · 点击飞过去' : '点击飞过去',
          onclick: () => fly(t.id),
        }, t.sign ? icon(t.sign > 0 ? 'up' : 'down') : null, t.name)), why)),
      h('div.pm-row-r',
        h('b.pm-row-p', pctProb(m.prob)),
        h('span.pm-row-d' + (d > 0.005 ? '.up' : d < -0.005 ? '.down' : ''), { title: '这一周概率变了多少个百分点' }, `一周 ${ptsTxt(d)} 个点`),
        spark(m.spark, d),
        m.url ? h('a.pm-row-link', { href: m.url, target: '_blank', rel: 'noopener noreferrer', title: kalshi ? '在 Kalshi 看' : '在 Polymarket 看' }, icon('ext')) : null));
  }

  function aiBlock() {
    const list = (S.pm.aiWatch || []).filter((x) => (x.ladder || []).length);
    if (!list.length) return null;
    const open = S.aiOpen;
    return h('div.pm-ai',
      h('button.pm-ai-t' + (open ? '.open' : ''), { type: 'button', 'aria-expanded': String(open),
        onclick: () => { S.aiOpen = !S.aiOpen; store.set(LS_AI, S.aiOpen); refreshPanel(); } },
      icon('calendar'), h('span', 'AI 里程碑：市场押的日子'), h('span.pm-ai-n', String(list.length)), icon(open ? 'chevU' : 'chev')),
      open ? h('ul.pm-ai-list', list.slice(0, 6).map((x) => h('li.pm-ai-i',
        h('div.pm-ai-q', (x.titleZh || x.title || '').replace(/……/g, '…')),
        h('div.pm-ai-ladder', x.ladder.slice(0, 4).map((s) => h('span.pm-ai-step',
          h('span', String(s.label || s.date).replace(/^\d{4}年/, (y) => (y.startsWith(String(new Date().getFullYear())) ? '' : y.slice(2)))),
          h('b', pctProb(s.prob))))),
        say(x) ? h('div.pm-ai-say', say(x)) : null))) : null);
  }

  function fly(id) {
    const p = D().pathIds?.(id);
    if (!p) return;
    try { app.flyTo?.(p); } catch (e) { console.warn('[clouds] flyTo', e); }
  }

  function renderSection(el, ctx) {
    const wrap = h('div.scn-scope.pm-sec');
    const node = (ctx && ctx.node) || currentNode();
    const isRoot = ctx && ctx.isRoot != null ? ctx.isRoot : (!node || node.id === (typeof app.rootId === 'function' ? app.rootId() : 'world'));
    if (!S.pm) {
      wrap.append(h('p.pm-empty', '预言市场的数据还没抓到。'));
      el.append(wrap);
      return;
    }
    const list = marketsHere(node, isRoot);
    const k = S.expanded ? 8 : 3;
    const lead = S.only ? '推演里用到的盘口' : !isRoot && node ? `押在「${node.name}」上的盘口，按这周的波动排` : '这周赌注变化最大的几件事';
    const caveatText = S.pm.caveat || '预言市场盘子小、会错；你自己的记录显示它们常把 AI 里程碑的日子押得太早。';
    add(wrap,
      h('div.pm-head',
        h('span.pm-lead', lead),
        h('button.pm-toggle' + (S.on ? '.on' : ''), {
          type: 'button', role: 'switch', 'aria-checked': String(S.on), title: S.on ? '把地图上的云层关掉' : '在地图上显示云层',
          onclick: () => { S.on = !S.on; store.set(LS_ON, S.on); apply(true); refreshPanel(); },
        }, icon('cloud'), h('span', S.on ? '云层开' : '云层关'))),
      !store.get(LS_CAVEAT, false) ? h('div.scn-caveat.pm-caveat',
        h('p', caveatText),
        h('button.scn-link', { type: 'button', onclick: (e) => { store.set(LS_CAVEAT, true); e.currentTarget.parentElement.remove(); } }, '知道了')) : null,
      list.length ? (() => { const used = new Set(); return h('ul.pm-list', list.slice(0, k).map((m) => row(m, node, used))); })() : h('p.pm-empty', '这里没有能对上的盘口。'),
      list.length > 3 ? h('button.scn-more', { type: 'button', onclick: () => { S.expanded = !S.expanded; refreshPanel(); } },
        S.expanded ? '收起' : `展开更多（还有 ${Math.min(list.length, 8) - 3} 个）`) : null,
      (isRoot || AI_IDS.has(node?.id)) && !S.only ? aiBlock() : null,
      S.pm.asOf || S.pm.kalshiAsOf ? h('div.pm-foot', `${[S.pm.asOf ? 'Polymarket' : '', S.pm.kalshiAsOf ? 'Kalshi' : ''].filter(Boolean).join(' · ')} 公开数据 · `
        + `${String(S.pm.asOf || S.pm.kalshiAsOf).slice(5, 10).replace('-', '月')}日 · 地图上的云只画有把握的对应`) : null);
    el.append(wrap);
  }

  if (app.panel && typeof app.panel.addSection === 'function') {
    try { app.panel.addSection({ id: 'polymarket', title: '预言市场的风向', icon: 'cloud', order: 60, render: renderSection }); }
    catch (e) { console.warn('[clouds] panel.addSection', e); }
  }

  // ------------------------------------------------------------------ events
  const refresh = () => apply();
  app.on?.('node', refresh);
  app.on?.('nav-done', refresh);
  app.on?.('picks', refresh);
  app.on?.('date-settled', refresh);
  const reload = () => load().then(() => { apply(true); refreshPanel(); });
  app.on?.('map', reload);
  app.on?.('dataReloaded', (e) => {
    const parts = e && Array.isArray(e.parts) ? e.parts.join(',') : '';
    if (!parts || parts.includes('polymarket') || parts.includes('all')) reload();
  });
  app.on?.('theme', () => refreshPanel());
  app.on?.('render', () => apply(true));
  app.on?.('planet', () => apply(true));
  app.on?.('scenario', (e) => {
    const r = e && e.active ? e.result : null;
    S.scn = !!r;
    const ids = r ? (r.polymarket || []).map((m) => String(m.id)).concat((r.rootOdds?.marketIds || []).map(String)) : null;
    S.only = ids && ids.length ? new Set(ids) : (r ? new Set() : null);
    // the scenario's own markets may lack node mappings here: use the engine's nodes for them
    if (r) {
      let added = false;
      for (const m of r.polymarket || []) {
        const have = S.byId.get(String(m.id));
        if ((have && (have.nodes || []).length) || !(m.nodes || []).length) continue;
        const mm = { id: String(m.id), q: m.question, qZh: m.qZh, prob: m.prob, d7: m.d7, volume: m.volume, endDate: m.endDate,
          url: m.url, nodes: m.nodes.map((id) => ({ id, sign: 1 })) };
        S.pm = S.pm || { asOf: null, markets: [], shifts: [] };
        if (have) Object.assign(have, { nodes: mm.nodes }); else S.pm.markets.push(mm);
        added = true;
      }
      if (added) index();
    }
    apply(true);
    refreshPanel();
  });

  // the planet may come up after us: try a few times
  let tries = 0;
  const t = setInterval(() => { tries++; apply(); if (tries > 20 || S.lastKey) clearInterval(t); }, 700);

  const ready = load().then(() => { apply(true); refreshPanel(); });
  app.clouds = { reload, markets: () => S.pm, ready };
  return app.clouds;
}

function ensureCss() {
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /(^|\/)css\/scenario\.css(\?|$)/.test(l.getAttribute('href') || ''));
  if (has || document.querySelector('link[data-mw="scenario-css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../../css/scenario.css', import.meta.url).href;
  l.dataset.mw = 'scenario-css';
  document.head.append(l);
}

// pure helpers, exported for tests
export const _test = { topicOf, capOf, strongNodes };
