// guess.js — 🎯 今日一猜 + 回放练习 (DESIGN.md §8.3): the predict → feedback loop that trains intuition
// about where money goes NEXT.
//
// Live: on the latest date, the panel card offers 3–4 territories of the planet on screen (one 春, one 夏/秋,
// one random contender, often a 冬) and asks where money flows over the next 5 trading days. The pick is
// stored in localStorage; once ≥ 5 newer trading days exist the card reveals ✅/❌ with one sentence why,
// and keeps 直觉命中率 + streak.
// Replay: on any past date picked with the time machine, the same card is a practice rep with an instant
// reveal (many reps a day). Candidates come from words.guessCandidates (else the same rules here).
//
// The answer is MONEY ONLY (review 2026-10-28): the candidate with the biggest net inflow over the next 5
// trading days, measured against its own usual 5-day size (so a continent and a small corner compete fairly).
// The wind change is only the tie-break — wind is a mean-reverting score, and when it counted half, "pick the
// coldest one right now" won 44% of games and 🍂秋/❄️冬 won twice as often as 🌱春/☀️夏. Where data/flows/ has
// real money for a candidate (ETF 申赎, 稳定币净增发, 南向资金 via app.realMoney) that replaces the estimate.
// Every reveal also shows the base rate: how often that kind of candidate (its season) won on this planet over
// the past year, and what blind guessing would score — so a streak can be judged against chance.
import {
  h, icon, rich, A, nameOf, go, toast, onAny, syncTheme, panelSection, store, cnDate, seasonOf, SEASONS,
} from './heartbeat.js';

const HORIZON = 5;
const KEY = 'mw.guess.v1';
const MAX_LIVE = 240, MAX_PRACTICE = 400;
const SCORE_V = 2;               // 2 = money only (wind = tie-break); results saved with v1 keep their old reading
const TYP_DAYS = 60, TYP_MIN = 10;
const BASE_FROM = 65;            // first day the base-rate replay uses (the z-scores need warm-up)

// ------------------------------------------------------------------ tiny utils
const isNum = (v) => typeof v === 'number' && isFinite(v);
const at = (arr, i) => (Array.isArray(arr) && i >= 0 && i < arr.length && isNum(arr[i]) ? arr[i] : null);
function sumRange(arr, a, b) { let s = 0, k = 0; for (let j = a; j <= b; j++) { const v = at(arr, j); if (v != null) { s += v; k++; } } return k ? s : null; }
function hashStr(s) { let x = 2166136261; for (let k = 0; k < s.length; k++) { x ^= s.charCodeAt(k); x = Math.imul(x, 16777619); } return x >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, r) { const a = arr.slice(); for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; }
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;
const lenOf = (s) => (s ? Math.max(0, ...['wind', 'flow', 'pres'].map((k) => (Array.isArray(s[k]) ? s[k].length : 0))) : 0);
/** mean |5-day sum| over the windows that end on days i−TYP_DAYS … i (no look-ahead); null when too few */
function typical(sums, i) {
  let s = 0, k = 0;
  for (let j = i; j >= Math.max(0, i - TYP_DAYS); j--) { const v = sums[j]; if (isNum(v)) { s += Math.abs(v); k++; } }
  return k >= TYP_MIN && s > 0 ? s / k : null;
}

export function init(app) {
  syncTheme(app);
  const X = () => A(app);
  const W = () => X().words || {};
  let db = load();
  let celebrate = null;              // key of a result to animate once
  let mapCache = new Map();          // planetId → map json (for reveals of other planets)
  const hints = new Map();           // candidate id → words' one-line hint (tooltip)
  // a reveal stays on the card for the whole session once shown (seen=true is only for the next visit)
  const gkey = (g) => g.planetId + '|' + g.date;
  const shown = new Set(), dismissed = new Set(), animated = new Set();
  const fresh = (g) => g.result && !g.result.expired && (g.seen === false || shown.has(gkey(g))) && !dismissed.has(gkey(g));
  let lastRenderKey = '';

  let section = { refresh() {} };     // set at the end of init (addSection renders at once)

  // ---------------------------------------------------------------- storage
  function load() {
    const d = store.get(KEY, null);
    return d && typeof d === 'object' ? { live: Array.isArray(d.live) ? d.live : [], practice: Array.isArray(d.practice) ? d.practice : [] } : { live: [], practice: [] };
  }
  function save() {
    db.live = db.live.slice(-MAX_LIVE);
    db.practice = db.practice.slice(-MAX_PRACTICE);
    store.set(KEY, db);
  }
  function stats(list) {
    const done = list.filter((g) => g.result && !g.result.expired);
    let out = null;
    const W_ = W();
    if (typeof W_.guessStats === 'function') {
      try {
        const r = W_.guessStats(done);
        if (r && typeof r.total === 'number') out = { n: r.total, hits: r.hits, pct: r.total ? Math.round(r.rate * 100) : null, streak: r.streak, best: r.best };
      } catch (e) { /* own count */ }
    }
    if (!out) {
      const hits = done.filter((g) => g.result.hit).length;
      let streak = 0;
      for (let k = done.length - 1; k >= 0; k--) { if (done[k].result.hit) streak++; else break; }
      let best = 0, run = 0;
      for (const g of done) { run = g.result.hit ? run + 1 : 0; best = Math.max(best, run); }
      out = { n: done.length, hits, pct: done.length ? Math.round((hits / done.length) * 100) : null, streak, best };
    }
    // blind guessing = 1 / (candidates on the card), averaged over the games played — the bar to beat (not 50%)
    const ch = done.length ? done.reduce((a, g) => a + 1 / Math.max(2, (g.candidates || []).length || 3), 0) / done.length : null;
    out.chance = ch != null ? Math.round(ch * 100) : null;
    out.chanceRaw = ch;
    out.say = chanceSay(out);
    return out;
  }
  /** the running score read against blind guessing (3–4 candidates → 25–33%, not a coin flip) */
  function chanceSay(s) {
    if (!s.n) return '';
    const c = s.chance;
    const streak = s.streak >= 3 && s.chanceRaw ? `连中 ${s.streak} 次；瞎猜连中这么多次的机会约 ${Math.max(0.1, Math.round(Math.pow(s.chanceRaw, s.streak) * 1000) / 10)}%。` : '';
    if (s.n < 8) return `才 ${s.n} 次，样本太少：先多猜，再跟瞎猜的 ${c}% 比。` + (streak ? ' ' + streak : '');
    const d = s.pct - c;
    const base = d >= 15 ? `比瞎猜（${c}%）高 ${d} 个点，直觉在长。` : d >= 5 ? `比瞎猜（${c}%）略好 ${d} 个点，继续练。`
      : d > -5 ? `跟瞎猜（${c}%）差不多——正常，多用回放练。` : `还不如瞎猜（${c}%），多用回放练习。`;
    return base + (streak ? ' ' + streak : '');
  }
  const liveSorted = () => db.live.slice().sort((a, b) => (a.date + a.at).localeCompare(b.date + b.at));

  // ---------------------------------------------------------------- the model: candidates + answer
  /** season of one territory on day i — the shell's app.seasonAt (same glyphs as the map), else §8.2 here */
  function seasonFor(s, i) {
    if (s && typeof app.seasonAt === 'function') {
      try {
        const r = app.seasonAt(s, i);
        if (r && SEASONS[r.key]) return { ...SEASONS[r.key], now: r.now || SEASONS[r.key].now, next: r.next || SEASONS[r.key].next };
        if (r === null) return SEASONS.none;
      } catch (e) { /* fall through */ }
    }
    const w = at(s && s.wind, i), p = at(s && s.pres, i), w5 = at(s && s.wind, Math.max(0, i - 5));
    return seasonOf(W(), w, w != null && w5 != null ? w - w5 : 0, p);
  }

  function rowsOf(map, kids, i) {
    const rows = [];
    for (const c of kids) {
      const s = map && map.children ? map.children[c.id] : null;
      if (!s) continue;
      const w = at(s.wind, i), p = at(s.pres, i), w5 = at(s.wind, Math.max(0, i - 5));
      if (w == null || p == null) continue;
      const dw = w5 != null ? w - w5 : 0;
      rows.push({ id: c.id, node: c, s, w, p, dw, season: seasonFor(s, i) });
    }
    return rows;
  }

  function normIds(r, valid) {
    if (!r) return [];
    const arr = Array.isArray(r) ? r : Array.isArray(r.candidates) ? r.candidates : [];
    return arr.map((x) => (typeof x === 'string' ? x : x && x.id)).filter((id) => id && valid.has(id));
  }

  /** 3–4 candidate ids for planet `node` on day i (deterministic per planet + date). */
  function candidates(map, node, i, quiet = false) {
    const kids = node.children || [];
    const rows = rowsOf(map, kids, i);
    if (rows.length < 2) return [];
    const valid = new Set(rows.map((r) => r.id));
    const w = W();
    if (typeof w.guessCandidates === 'function') {
      try {
        const r = w.guessCandidates(map, kids, i);
        if (!quiet) for (const c of Array.isArray(r) ? r : []) if (c && c.id && c.hint) hints.set(c.id, c.hint);
        const ids = [...new Set(normIds(r, valid))];
        if (ids.length >= 2) return ids.slice(0, 4);
      } catch (e) { console.warn('[guess] words.guessCandidates', e); }
    }
    const date = X().dates[i] || String(i);
    const r = rng(hashStr(node.id + '|' + date));
    if (rows.length <= 3) return shuffle(rows.map((x) => x.id), r);
    const chosen = [];
    const take = (x) => { if (x && !chosen.includes(x.id)) chosen.push(x.id); };
    const free = () => rows.filter((x) => !chosen.includes(x.id));
    take(free().filter((x) => x.season.key === 'spring').sort((a, b) => b.dw - a.dw)[0]);
    take(free().filter((x) => x.season.key === 'summer' || x.season.key === 'autumn').sort((a, b) => Math.abs(b.w) - Math.abs(a.w))[0]);
    const rest = free();
    take(rest[Math.floor(r() * rest.length)]);
    if (rows.length >= 6) take(free().filter((x) => x.season.key === 'winter').sort((a, b) => a.p - b.p)[0] || free().sort((a, b) => b.w - a.w)[0]);
    while (chosen.length < Math.min(3, rows.length)) { const f = free(); take(f[Math.floor(r() * f.length)]); }
    return shuffle(chosen, r);
  }

  // ---------------------------------------------------------------- the answer: forward money only
  /** the last day whose bar is a finished session: a 盘中 (partial) last day can't be an answer yet */
  const partialLast = () => { const x = X(); const p = x.meta && x.meta.partial; return !!(p && p.date && x.dates[x.lastIdx] === p.date); };
  const lastFull = () => X().lastIdx - (partialLast() ? 1 : 0);
  // stamp of the data the 5-day sums were built from (a reload / new day starts over)
  const stamp = () => { const d = X().dates; return d.length + '|' + (d[d.length - 1] || ''); };
  // per map object (精选 / 全市场 maps of one planet differ): child id → {est5[], real5[]|null, label, rm, stamp}
  let tracks = new WeakMap();
  /** 5-day money sums ending on every day: est = price×volume estimate (§2), real = app.realMoney (est:false). */
  function trackOf(map, id) {
    const rmReady = typeof app.realMoney === 'function' && (typeof app.hasRealMoney !== 'function' || !!app.hasRealMoney(id));
    let per = tracks.get(map);
    if (!per) { per = new Map(); tracks.set(map, per); }
    const key = id;
    const old = per.get(key);
    if (old && old.stamp === stamp() && old.rm === rmReady) return old;
    const s = (map.children && map.children[id]) || null;
    const n = lenOf(s);
    const est5 = new Array(n).fill(null);
    for (let j = HORIZON - 1; j < n; j++) est5[j] = sumRange(s.flow, j - HORIZON + 1, j);
    let real5 = null, label = null;
    if (rmReady) {
      real5 = new Array(n).fill(null);
      for (let j = 0; j < n; j++) {
        let r = null;
        try { r = app.realMoney(id, j); } catch (e) { r = null; }
        // only days the real series actually reaches (lag = it stops before that day)
        if (r && r.lag == null && isNum(r.flow5)) { real5[j] = r.flow5; label = label || r.label || '真钱'; }
      }
      if (!real5.some((v) => v != null)) real5 = null;
    }
    const t = { est5, real5, label, rm: rmReady, stamp: stamp() };
    per.set(key, t);
    return t;
  }

  /** each candidate over days i+1 … i+5: net inflow ÷ its own usual 5-day size (clipped ±3) = the score;
   *  wind change only breaks ties. → rows sorted best first: [{id, flow, est, nf, dw, src, label, score}] */
  function rankRows(map, ids, i, { real = true } = {}) {
    const rows = [];
    for (const id of ids) {
      const s = map && map.children ? map.children[id] : null;
      if (!s) continue;
      const T = trackOf(map, id);
      const est = at(T.est5, i + HORIZON);
      let F = est, typ = typical(T.est5, i), src = 'est';
      if (real && T.real5) {
        const rf = at(T.real5, i + HORIZON), rt = typical(T.real5, i);
        if (rf != null && rt) { F = rf; typ = rt; src = 'real'; }
      }
      const nf = F == null ? null : typ ? clamp(F / typ, -3, 3) : Math.sign(F);
      const w0 = at(s.wind, i), w1 = at(s.wind, i + HORIZON);
      rows.push({ id, flow: F == null ? null : Math.round(F * 10) / 10, est, nf: nf == null ? null : r2(nf), dw: w0 != null && w1 != null ? r2(w1 - w0) : null,
        src, label: src === 'real' ? T.label : null, score: nf == null ? -9 : r2(nf) });
    }
    rows.sort((a, b) => { const d = b.score - a.score; return Math.abs(d) > 0.004 ? d : (b.dw ?? 0) - (a.dw ?? 0); });
    return rows;
  }

  /** how each candidate did over days i+1 … i+5 → {v, answer, hit, why, whyMild, rows, pickSeason} */
  function score(map, ids, i, pick, kids) {
    void kids;
    if (i + HORIZON > lastFull()) return null;
    const rows = rankRows(map, ids, i);
    if (!rows.length || rows[0].score <= -9) return null;
    const answer = rows[0].id;
    const t = sentence(rows, answer, pick);
    const ps = pick && map.children && map.children[pick] ? seasonFor(map.children[pick], i).key : null;
    return { v: SCORE_V, answer, hit: answer === pick, why: t.sharp, whyMild: t.mild, rows, pickSeason: ps };
  }

  /** "（是它平时 5 天进出量的 1.8 倍）" — the measure the answer was ranked by */
  const timesTxt = (r) => (r && isNum(r.nf) && Math.abs(r.nf) >= 0.3 ? `，是它平时 5 天进出量的 ${Math.abs(r.nf) >= 2.95 ? '3 倍多' : Math.abs(r.nf).toFixed(1) + ' 倍'}` : '');
  const srcTxt = (r) => (r && r.src === 'real' ? `（${r.label || '真钱'}）` : '');
  function sentence(rows, answer, pick) {
    const M = (v) => (W().money ? W().money(v, { sign: true }) : (v >= 0 ? '+' : '') + Math.round(v) + '百万美元');
    const A_ = (v) => M(Math.abs(v)).replace(/^[+-]/, '');
    const win = rows.find((r) => r.id === answer), mine = rows.find((r) => r.id === pick);
    const wn = nameOf(app, answer), pn = nameOf(app, pick);
    const wf = win && win.flow != null ? win.flow : null;
    if (wf != null && wf < 0) {
      if (answer === pick) return { sharp: `猜中了，但钱都在撤：【${wn}】撤得最少（5 天${srcTxt(win)} ${M(wf)}）。`, mild: `猜中了：几个都在流出，【${wn}】流出最少（${M(wf)}）。` };
      const mt = mine && mine.flow != null ? `（${M(mine.flow)}）` : '';
      return { sharp: `钱都在撤，【${wn}】撤得最少（${M(wf)}）；你押的【${pn}】撤得更狠${mt}。`, mild: `几个都在流出，【${wn}】最少（${M(wf)}）；你选的【${pn}】流出更多${mt}。` };
    }
    const ws = `5 天${srcTxt(win)}净流入 ${A_(wf ?? 0)}${timesTxt(win)}`;
    if (answer === pick) return { sharp: `直觉在线：【${wn}】${ws}。`, mild: `猜中了：【${wn}】${ws}。` };
    let mt = '没跟上';
    if (mine && mine.flow != null) {
      if (mine.flow < 0) mt = `反倒流出 ${A_(mine.flow)}`;
      else if (wf != null && mine.flow > wf) mt = `进得更多（${A_(mine.flow)}），但按它自己的个头只算小打小闹${isNum(mine.nf) ? `（平时的 ${Math.abs(mine.nf).toFixed(1)} 倍）` : ''}`;
      else mt = `只进了 ${A_(mine.flow)}`;
    }
    return { sharp: `被市场打脸：钱去了【${wn}】（${ws}），你押的【${pn}】${mt}。`, mild: `这次是【${wn}】：${ws}；你选的【${pn}】${mt}。` };
  }

  // ---------------------------------------------------------------- base rate (how often a kind of candidate wins)
  let bases = new WeakMap();         // map object → {stamp, by:{season:{n,w}}, games, chance}
  /** replay the card on every past day of this planet (same candidates, same money-only answer) and count how
   *  often a candidate of each season won. Estimated flows only (fast, and the same for every day). */
  function baseRates(node, map) {
    if (!node || !map) return null;
    const old = bases.get(map);
    if (old && old.stamp === stamp()) return old;
    const last = lastFull();
    const by = {};
    let games = 0, chance = 0;
    for (let i = BASE_FROM; i + HORIZON <= last; i++) {
      const ids = candidates(map, node, i, true);
      if (ids.length < 2) continue;
      const rows = rankRows(map, ids, i, { real: false });
      if (!rows.length || rows[0].score <= -9) continue;
      games++; chance += 1 / ids.length;
      for (const id of ids) {
        const k = seasonFor(map.children[id], i).key || 'none';
        const b = by[k] || (by[k] = { n: 0, w: 0 });
        b.n++; if (rows[0].id === id) b.w++;
      }
    }
    const out = { stamp: stamp(), by, games, chance: games ? chance / games : null };
    bases.set(map, out);
    return out;
  }
  /** "基准：在「美股」过去一年，☀️夏 这一类候选赢了 31%（瞎猜 ≈ 27%）。" */
  function baseLine(g) {
    const node = X().nodeById(g.planetId);
    const map = mapCache.get(g.planetId) || (app.currentMap && app.currentMap.id === g.planetId ? app.currentMap : null);
    if (!node || !map) return null;
    const b = baseRates(node, map);
    if (!b || b.games < 20) return null;
    const i = X().dates.indexOf(g.date);
    const k = (g.result && g.result.pickSeason) || (i >= 0 && map.children && map.children[g.pick] ? seasonFor(map.children[g.pick], i).key : null) || 'none';
    const x = b.by[k];
    const S = SEASONS[k] || SEASONS.none;
    const kind = k === 'none' ? '没季节（平稳）的' : `${S.name}天的`;
    const ch = Math.round((b.chance || 0) * 100);
    if (!x || x.n < 15) return { text: `基准：这颗星球过去一年，${kind}候选出现得太少，算不出胜率；瞎猜 ≈ ${ch}%。`, k };
    const p = Math.round((x.w / x.n) * 100);
    const lean = p - ch >= 8 ? '比瞎猜强一截' : p - ch <= -8 ? '比瞎猜还差' : '跟瞎猜差不多';
    return { text: `基准：在「${node.name}」过去一年，你押的${kind}候选赢了 ${p}%（${x.n} 次里），瞎猜 ≈ ${ch}%——${lean}。一两次中不中说明不了什么。`, k, p, ch };
  }

  // ---------------------------------------------------------------- reveals for live guesses
  async function mapFor(planetId) {
    if (mapCache.has(planetId)) return mapCache.get(planetId);
    const D = X().data;
    let m = null;
    try { m = D && D.loadMap ? await D.loadMap(planetId) : null; } catch (e) { m = null; }
    if (m) mapCache.set(planetId, m);
    return m;
  }

  async function revealDue() {
    const dates = X().dates, last = lastFull();
    let changed = false;
    for (const g of db.live) {
      if (g.result) continue;
      const i = dates.indexOf(g.date);
      if (i < 0) {
        if (dates.length && g.date < dates[0]) { g.result = { expired: true, hit: false, answer: null, rows: [], why: '太久了，这一天已经滑出数据窗口' }; changed = true; }
        continue;
      }
      if (i + HORIZON > last) continue;
      const m = await mapFor(g.planetId);
      if (!m) continue;
      const pn = X().nodeById(g.planetId);
      const r = score(m, g.candidates, i, g.pick, (pn && pn.children) || []);
      if (!r) continue;
      g.result = { ...r, revealedAt: new Date().toISOString() };
      g.seen = false;
      changed = true;
    }
    if (changed) {
      save();
      const fresh = db.live.filter((g) => g.result && !g.result.expired && g.seen === false);
      if (fresh.length) {
        const hits = fresh.filter((g) => g.result.hit).length;
        toast(app, fresh.length === 1 ? `🎯 揭晓：${fresh[0].result.hit ? '✅ 押中了' : '❌ 没押中'}（${cnDate(fresh[0].date)} 在「${nameOf(app, fresh[0].planetId)}」押的）`
          : `🎯 ${fresh.length} 个猜测揭晓了：中了 ${hits} 个`, 4800);
      }
      section.refresh();
    }
  }

  // ---------------------------------------------------------------- actions
  function pickLive(node, i, ids, id) {
    const date = X().dates[i];
    if (db.live.some((g) => g.planetId === node.id && g.date === date)) return;
    db.live.push({ date, planetId: node.id, candidates: ids, pick: id, at: new Date().toISOString() });
    save();
    toast(app, `记下了：你押「${nameOf(app, id)}」。${HORIZON} 个交易日后揭晓。`, 3200);
    section.refresh();
  }

  function pickPractice(node, map, i, ids, id) {
    const r = score(map, ids, i, id, node.children || []);
    if (!r) return;
    const date = X().dates[i];
    db.practice = db.practice.filter((g) => !(g.planetId === node.id && g.date === date));
    db.practice.push({ date, planetId: node.id, candidates: ids, pick: id, at: new Date().toISOString(), result: r });
    save();
    if (r.hit) celebrate = 'p|' + node.id + '|' + date;
    section.refresh();
  }

  function randomRep() {
    const last = lastFull();
    const lo = Math.min(25, Math.max(5, last - 30)), hi = last - HORIZON;
    if (hi <= lo || typeof app.setDate !== 'function') { toast(app, '用底部的时间机器拖到过去任何一天，就能练一题'); return; }
    let i = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (i === X().state.dateIndex) i = Math.max(lo, i - 7);
    try { app.setDate(i); if (typeof app.settleDate === 'function') app.settleDate(); } catch (e) { console.warn('[guess] setDate', e); }
  }
  function backToToday() { try { app.setDate && app.setDate(X().lastIdx); app.settleDate && app.settleDate(); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- render
  function render(el, ctx = {}) {
    el.classList.add('ops', 'ops-guess-sec');
    const x = X();
    const node = ctx.node || x.node();
    const i = isNum(ctx.dateIndex) ? ctx.dateIndex : isNum(x.state.dateIndex) ? x.state.dateIndex : x.lastIdx;
    let map = ctx.map || app.currentMap || null;
    if (!node || !(node.children || []).length || !x.dates.length) return;
    if (!map || (map.id && map.id !== node.id)) {
      mapFor(node.id).then((m) => { if (m) section.refresh(); });
      map = mapCache.get(node.id) || null;
      if (!map) { el.append(h('p.ops-empty', '正在读这里的天气…')); return; }
    }
    const last = x.lastIdx;
    const live = i >= last;
    const card = h('div.ops-guess-card' + (live ? '.live' : '.replay'));
    el.append(card);

    // a reveal from another planet / day that the owner has not seen yet
    const unseen = liveSorted().filter((g) => fresh(g) && !(g.planetId === node.id && live));
    if (unseen.length) card.append(revealBanner(unseen[unseen.length - 1], unseen.length));

    if (live) renderLive(card, node, map, i);
    else renderReplay(card, node, map, i);
    lastRenderKey = node.id + '|' + i;
  }

  function header(card, mode, extra) {
    const s = stats(liveSorted());
    const p = stats(db.practice);
    card.append(h('div.ops-guess-head',
      h('span.ops-guess-mode', icon(mode === 'live' ? 'target' : 'replay'), mode === 'live' ? '今日一猜' : extra),
      h('span.ops-guess-stats',
        mode === 'live'
          ? [h('span', { title: '真猜（等 5 个交易日揭晓）的命中率' + (s.say ? '\n' + s.say : '') }, '直觉命中率 ', h('b', s.n ? `${s.hits}/${s.n}` : '—'), s.pct != null ? h('span.ops-sub', ` ${s.pct}%`) : null),
            s.chance != null ? h('span.ops-chance', { title: '每题 3–4 个候选，闭着眼睛乱点也能中这么多：命中率要比它高才算直觉' }, `瞎猜 ≈ ${s.chance}%`) : null,
            s.streak >= 2 ? h('span.ops-streak', { title: `最长连中 ${s.best}${s.say ? '\n' + s.say : ''}` }, `连中 ${s.streak}`) : null]
          : [h('span', { title: '回放练习：在历史上猜，马上揭晓' + (p.say ? '\n' + p.say : '') }, '练习 ', h('b', p.n ? `${p.hits}/${p.n}` : '—'), p.pct != null ? h('span.ops-sub', ` ${p.pct}%`) : null),
            p.chance != null ? h('span.ops-chance', { title: '每题 3–4 个候选，闭着眼睛乱点也能中这么多' }, `瞎猜 ≈ ${p.chance}%`) : null,
            p.streak >= 2 ? h('span.ops-streak', { title: p.say || '' }, `连中 ${p.streak}`) : null])));
  }

  function renderLive(card, node, map, i) {
    const date = X().dates[i];
    const mine = db.live.find((g) => g.planetId === node.id && g.date === date);
    const older = liveSorted().filter((g) => g.planetId === node.id && g.date < date && (!g.result || fresh(g))).pop();
    header(card, 'live');

    if (older && older.result) card.append(resultBlock(older, true));
    else if (older) card.append(h('p.ops-guess-pending', icon('clock'), `${cnDate(older.date)} 在这里押了「${nameOf(app, older.pick)}」，还要 ${daysLeft(older)} 个交易日揭晓。`));

    const ids = mine ? mine.candidates : candidates(map, node, i);
    if (ids.length < 2) { card.append(h('p.ops-empty', '这里能比的地方太少，换个星球再猜。')); return; }
    card.append(h('p.ops-guess-q', mine ? '你押了一个，等它揭晓：' : (W().GUESS_QUESTION || `接下来 ${HORIZON} 个交易日，钱最可能流进哪一个？`)));
    card.append(tiles(map, i, ids, { pick: mine ? mine.pick : null, locked: !!mine, onPick: (id) => pickLive(node, i, ids, id) }));
    if (mine) {
      card.append(h('p.ops-guess-pending', icon('clock'), `已锁定。${daysLeft(mine)} 个交易日后揭晓（大约 ${cnDate(approxReveal(mine.date))}）。`));
    }
    card.append(h('div.ops-guess-foot',
      h('button.ops-more', { type: 'button', onclick: randomRep, title: '跳到过去随便一天，猜完马上揭晓' }, icon('shuffle'), mine ? '等的时候，回放练几题' : '先在历史上练一题'),
      h('span.ops-sub', practiceLine())));
  }

  function renderReplay(card, node, map, i) {
    const date = X().dates[i];
    const last = lastFull();
    header(card, 'replay', `回放练习 · ${cnDate(date)}`);
    if (i + HORIZON > last) {
      const live = i + HORIZON === X().lastIdx && partialLast();
      card.append(h('p.ops-empty', live ? `${cnDate(date)} 之后第 ${HORIZON} 天还在盘中，收盘后才算数。往前拖一点，或者：`
        : `${cnDate(date)} 之后还不到 ${HORIZON} 个交易日，答案没出来。往前拖一点，或者：`));
      card.append(h('div.ops-guess-foot', h('button.ops-btn.ghost.small', { type: 'button', onclick: randomRep }, icon('shuffle'), '随机来一题'),
        h('button.ops-more', { type: 'button', onclick: backToToday }, '回到今天')));
      return;
    }
    const done = db.practice.filter((g) => g.planetId === node.id && g.date === date).pop();
    const ids = done ? done.candidates : candidates(map, node, i);
    if (ids.length < 2) { card.append(h('p.ops-empty', '这里能比的地方太少，换个星球再练。')); return; }
    card.append(h('p.ops-guess-q', `站在 ${cnDate(date)}：接下来 ${HORIZON} 个交易日，钱最可能流进哪一个？`));
    const res = done ? done.result : null;
    card.append(tiles(map, i, ids, { pick: done ? done.pick : null, locked: !!done, result: res, onPick: (id) => pickPractice(node, map, i, ids, id) }));
    if (done) card.append(resultBlock(done, false));
    card.append(h('div.ops-guess-foot',
      h('button.ops-btn' + (done ? '.primary' : '.ghost') + '.small', { type: 'button', onclick: randomRep }, icon('shuffle'), done ? '下一题' : '换一天'),
      h('button.ops-more', { type: 'button', onclick: backToToday }, '回到今天')));
  }

  function tiles(map, i, ids, { pick, locked, result, onPick }) {
    const res = result || null;
    const compact = ids.length === 3;
    const grid = h('div.ops-guess-grid' + (compact ? '.three' : ''), { role: 'radiogroup', 'aria-label': '候选' });
    for (const id of ids) {
      const s = map.children ? map.children[id] : null;
      const w = at(s && s.wind, i), p = at(s && s.pres, i);
      const season = seasonFor(s, i);
      // the same words as the hover card: the wind read together with the last 5 days of money (when the two
      // disagree it says 光热闹 / 钱悄悄进), never the raw wind score (it reads like money next to 亿 figures)
      const f5 = s ? sumRange(s.flow, i - HORIZON + 1, i) : null;
      let cr = null;
      try { cr = W().crashAt ? W().crashAt(s, i) : null; } catch (e) { cr = null; }
      const ww = W().windWord ? W().windWord(w, f5 ?? undefined, cr) : { short: '', text: '' };
      const row = res && res.rows ? res.rows.find((r) => r.id === id) : null;
      const isAns = res && res.answer === id;
      const isPick = pick === id;
      const n = X().nodeById(id);
      const cls = ['button.ops-guess-tile', 's-' + season.key, isPick ? 'pick' : '', isAns ? 'answer' : '', res && isPick && !isAns ? 'wrong' : '', locked ? 'locked' : ''].filter(Boolean).join('.');
      grid.append(h(cls, {
        type: 'button', role: 'radio', 'aria-checked': isPick ? 'true' : 'false', disabled: locked,
        title: [hints.get(id), season.key !== 'none' ? `${season.name}：${season.now} → ${season.next}` : '',
          ww.text ? `风：${ww.text}${f5 != null ? `（过去 5 天${f5 >= 0 ? '净流入' : '净流出'} ${money(Math.abs(f5))}）` : ''}` : '',
          p != null ? `拥挤度 ${Math.round(p)}` : ''].filter(Boolean).join('\n'),
        onclick: () => { if (!locked) onPick(id); },
      },
      h('span.ops-season', icon(season.icon), h('span.ops-season-name', season.name)),
      h('span.ops-guess-name', (n && n.name) || nameOf(app, id)),
      h('span.ops-guess-sub', row ? flowBadge(row, compact, res.v) : windTag(ww, compact)),
      isPick ? h('span.ops-guess-flag', isAns ? icon('check') : res ? icon('cross') : '你押的') : isAns ? h('span.ops-guess-flag.ans', '钱去了这') : null));
    }
    return grid;
  }

  const money = (v) => (W().money ? W().money(v) : Math.round(v) + '百万美元');
  /** "流入" / "钱悄悄进" / "光热闹" — the wind word, tinted by which way the money really went */
  function windTag(ww, compact) {
    const tone = ww.mixed === 'quiet' ? 'in' : ww.mixed === 'attn' ? 'out' : ww.level > 0 ? 'in' : ww.level < 0 ? 'out' : 'calm';
    return h('span.ops-windtag.' + tone, (compact ? '' : '风：') + (ww.short || ww.text || '—'));
  }
  function flowBadge(r, compact = false, ver = null) {
    const M = (v) => (W().money ? W().money(v, { sign: true }) : String(Math.round(v)));
    const v1 = !ver || ver < SCORE_V;
    return h('span.ops-flowbadge' + ((r.flow ?? 0) >= 0 ? '.in' : '.out'), { title: r.src === 'real' ? `${r.label || '真钱'}（真实申赎 / 净买入，不是估算）` : '按价格 × 成交量估算的净流入' },
      r.flow != null ? (compact ? h('span.ops-nowrap', M(r.flow)) : ['5天 ', h('span.ops-nowrap', M(r.flow))]) : '—',
      r.src === 'real' ? h('span.ops-chip.ops-real', '实') : null,
      !compact && v1 && isNum(r.dw) ? h('span.ops-sub', ` · 风${r.dw >= 0 ? '↑' : '↓'}${Math.abs(r.dw).toFixed(1)}`) : null);
  }

  function resultBlock(g, isLive) {
    const r = g.result;
    const key = (isLive ? 'l|' : 'p|') + gkey(g);
    const anim = celebrate === key || (isLive && r.hit && !animated.has(key));
    if (celebrate === key) celebrate = null;
    if (anim) animated.add(key);
    const box = h('div.ops-guess-result' + (r.hit ? '.hit' : '.miss') + (anim ? '.anim' : ''),
      h('span.ops-guess-mark', icon(r.hit ? 'check' : 'cross')),
      h('div.ops-guess-why',
        isLive ? h('span.ops-guess-when', `揭晓 · ${cnDate(g.date)} 押「${nameOf(app, g.pick)}」`) : null,
        rich((typeof app.say === 'function' ? app.say(r, 'why') : r.why) || (r.hit ? '押中了。' : '没押中。'))),
      isLive ? h('button.ops-icon-btn.ops-guess-x', { type: 'button', title: '知道了', 'aria-label': '知道了', onclick: () => { dismissed.add(gkey(g)); section.refresh(); } }, icon('close')) : null,
      bars(r.rows || [], r.answer, g.pick, r.v),
      baseBlock(g));
    if (isLive && g.seen === false) {
      shown.add(gkey(g));
      g.seen = true;
      save();
    }
    return box;
  }

  /** mini chart: each candidate's 5-day net inflow measured against its own usual 5-day size (the score), labelled
   *  with the money. Results saved before v2 mixed in the wind change: their legend says so. */
  function bars(rows, answer, pick, ver) {
    const valid = rows.filter((r) => isNum(r.score) && r.score > -9);
    if (valid.length < 2) return null;
    const v2 = ver >= SCORE_V;
    const mx = Math.max(1e-9, ...valid.map((r) => Math.abs(r.score)));
    const M = (v) => (W().money && isNum(v) ? W().money(v, { sign: true }) : '');
    const list = h('ul.ops-guess-bars', { title: v2 ? '长短 = 5 天净流入，按它自己平时 5 天的进出量折算（大块头和小角落公平比）' : '长短 = 5 天净流入（按它平时的量折算）和风的变化，各占一半（旧算法）' }, valid.map((r) => {
      const f = Math.abs(r.score) / mx;
      const tip = `${nameOf(app, r.id)}：5 天 ${M(r.flow) || '—'}${r.src === 'real' ? `（${r.label || '真钱'}）` : '（估算）'}${v2 && isNum(r.nf) ? `，是它平时 5 天进出量的 ${r.nf.toFixed(1)} 倍` : ''}${!v2 && isNum(r.dw) ? `，风${r.dw >= 0 ? '变大' : '变小'} ${Math.abs(r.dw).toFixed(1)}` : ''}`;
      return h('li' + (r.id === answer ? '.ans' : '') + (r.id === pick ? '.mine' : ''), { title: tip },
        h('span.ops-bar-name', nameOf(app, r.id)),
        h('span.ops-bar-track', h('span.ops-bar-mid'), h('span.ops-bar-fill' + (r.score >= 0 ? '.in' : '.out'), { style: r.score >= 0 ? { left: '50%', width: (f * 50).toFixed(1) + '%' } : { right: '50%', width: (f * 50).toFixed(1) + '%' } })),
        h('span.ops-bar-num', M(r.flow), r.src === 'real' ? h('span.ops-chip.ops-real', { title: r.label || '真钱' }, '实') : null));
    }));
    return [list, h('p.ops-guess-legend', v2 ? '条 = 5 天净流入 ÷ 它平时 5 天的进出量 · 数字 = 5 天净流入（实 = 真实申赎）' : '条 = 钱和风的综合分（旧算法） · 数字 = 5 天净流入')];
  }

  /** the base rate under every reveal: how often this kind of candidate wins here, vs blind guessing */
  function baseBlock(g) {
    let b = null;
    try { b = baseLine(g); } catch (e) { console.warn('[guess] base rate', e); }
    return b ? h('p.ops-guess-base', { title: '把这颗星球过去一年的每一天都当成一题，用同样的候选规则和同样的答案（只看钱）算出来的' }, b.text) : null;
  }

  function revealBanner(g, n) {
    const r = g.result;
    if (g.seen === false) { shown.add(gkey(g)); g.seen = true; save(); }
    return h('div.ops-guess-banner' + (r.hit ? '.hit' : '.miss'),
      h('span.ops-guess-mark.small', icon(r.hit ? 'check' : 'cross')),
      h('span.ops-guess-banner-t', `${n > 1 ? `${n} 个猜测揭晓了 · 最近一个：` : '揭晓：'}${cnDate(g.date)} 在「${nameOf(app, g.planetId)}」押「${nameOf(app, g.pick)}」→ ${r.hit ? '押中' : `钱去了「${nameOf(app, r.answer)}」`}`),
      h('button.ops-more', { type: 'button', onclick: () => { go(app, g.planetId); } }, '去看'),
      h('button.ops-icon-btn', { type: 'button', title: '知道了', 'aria-label': '知道了', onclick: () => { db.live.forEach((x) => { if (x.result) { x.seen = true; dismissed.add(gkey(x)); } }); save(); section.refresh(); } }, icon('close')));
  }

  function daysLeft(g) {
    const i = X().dates.indexOf(g.date);
    return i < 0 ? HORIZON : Math.max(1, HORIZON - (lastFull() - i));
  }
  function approxReveal(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    let k = 0;
    while (k < HORIZON) { t.setUTCDate(t.getUTCDate() + 1); const wd = t.getUTCDay(); if (wd !== 0 && wd !== 6) k++; }
    return t.toISOString().slice(0, 10);
  }
  function practiceLine() {
    const p = stats(db.practice);
    return p.n ? `练习 ${p.hits}/${p.n}（${p.pct}%，瞎猜 ≈ ${p.chance}%）` : '';
  }

  // ---------------------------------------------------------------- boot
  // no shell title: the card carries its own head (今日一猜 / 回放练习 · date + the running score)
  section = panelSection(app, { id: 'guess', title: '', order: 30, render });
  revealDue();
  onAny(app, ['dataReloaded', 'data', 'map'], () => { mapCache = new Map(); tracks = new WeakMap(); bases = new WeakMap(); revealDue(); });
  // the shell re-renders panel sections on node/date change; with the older shell, refresh ourselves
  onAny(app, ['date-settled', 'nav-done'], () => { const k = (X().node() || {}).id + '|' + X().state.dateIndex; if (k !== lastRenderKey) section.refresh(); });

  const out = { stats: () => ({ live: stats(liveSorted()), practice: stats(db.practice) }), reveal: revealDue, random: randomRep,
    // for tests / the base-rate check: the same functions the card uses
    _test: { candidates: (map, node, i) => candidates(map, node, i, true), rankRows, score, baseRates, mapFor } };
  app.guess = out;
  return out;
}
