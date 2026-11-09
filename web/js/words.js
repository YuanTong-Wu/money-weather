/* 钱的天气 · words.js —— 把一大堆数字翻译成一句人话，替主人守住注意力。
 *
 * 纯函数：不碰 DOM，不 import 任何东西，可以在浏览器和 Node 里直接跑。
 * 词汇表 DESIGN.md §5，注意力 §6，季节 / 主航道 / 今日一猜 §8，老风的嘴 §12，估算 §14。
 * surprise() / season() / mainChannel() 的规则和 pipeline/brief.py 完全一样 —— 改一边，必须改另一边。
 *
 * 约定：
 *   - 钱的单位一律是「百万美元」(USD millions)，和 web/data 里的 flow / flow5 / dv 一样。
 *   - 涨跌幅是小数：0.032 = +3.2%。
 *   - i 是日期下标（0…251）；不传 i 就用最后一天；越界会被夹回范围内。
 *   - 拿不到数据时给出安静的文字（"暂无数据"），绝不输出 NaN / undefined。
 *   - 说话的人是「老风」：默认犀利（setVoice('sharp')），可切温和（setVoice('mild')）。
 *     观点是句子，数字放在徽章 / 括号里，数字永远精确；每句 ≤ 30 字。
 *
 * 导出一览（§7 + §8 + §12 + §14）：
 *   setVoice(v) getVoice() voiced(obj, key) sayOf(item)
 *   windWord(w, flow5?, crash?) tempWord presWord stormWord frontWord → {text, short, emoji, level, mixed?, crash?}；windMix(w, flow5)
 *   displayName(node) ALIAS  asOfLabel(meta)  liquiditySay(liq, {asOf})
 *   money(m, {sign, est}) pct(x) times(r) dateCN(iso) hanLen(s)
 *   nowAt(series, i) describe(nowLike, opts?) take(nowLike, opts?) —— opts {real} 或 {id, i}：真钱和估算对不上时先说真钱
 *   season(w, dw, p, flow5?, temp?, crash?) → {key, emoji, name, icon, now, next, nowMild, nextMild, text, mixed, note, odds, crash}；seasonInfo(key) seasonKey(w, dw, p, crash?)
 *   crashAt(series, i) → null | {level 1 急跌 | 2 崩, name, r1, r5, sigma, z5, by} —— 季节的「暴跌闸门」（DESIGN §8 修订）：暴跌中的地方永远不读春 / 夏
 *   setSeasonStats(brief.seasonStats) getSeasonStats() seasonNext(key, flow5?, crash?) —— 季节的「下一步」用历史概率说（不是预言；暴跌中用 byCrash 那张表）
 *   compareAt(real, est, i) realOfSeries(series, i, dates?) realSay(r, est) realBit(r) setRealOf(fn) —— 真钱 vs 估（§23 修订）
 *   seasonAt(series, i) seasonsOf(mapJson, childNodes, i) → {id: 'spring'|'summer'|'autumn'|'winter'|null}
 *   surprise(series, i) surpriseParts(series, i) attentionPicks(mapJson, childNodes, i, k=3, {pins, holdings, min})
 *   mainChannel(mapJson, childNodes, i, opts) → {from, to, to2, fromName, toName, say, sayMild, saySharp, strength, weak} | null
 *   regionWeather(mapJson, node, childNodes, i, opts?) → {headline, channel, spotlight, inflow, outflow, springs, crowded, quiet, storms, fronts}
 *   caster(stockJson, i) → 2–3 句
 *   changesSince(mapJson, childNodes, iFrom, iTo, k) sinceLastVisit(...)
 *   guessCandidates(mapJson, childNodes, i, opts) scoreGuess(mapJson, guess, iFrom, iTo, childNodes?) guessStats(records)
 *   GUESS_QUESTION  EST_BADGE  confWord(conf)  estimateNote(x)  estLabel(x)
 *   tutorialCards  TERMS  SEASONS
 */

// ───────────────────────────── 小工具 ─────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const A = Math.abs;
const r2 = (x) => Math.round(x * 100) / 100;
const len = (a) => (Array.isArray(a) ? a.length : 0);
const MAX_HAN = 30;

function seriesLen(s) {
  if (!s) return 0;
  return Math.max(len(s.wind), len(s.temp), len(s.pres), len(s.idx), len(s.flow), len(s.c));
}
function clampIdx(i, n) {
  if (!(n > 0)) return -1;
  if (!isNum(i)) return n - 1;
  const k = Math.round(i);
  return k < 0 ? 0 : k >= n ? n - 1 : k;
}
function val(arr, i) {
  return Array.isArray(arr) && i >= 0 && i < arr.length && isNum(arr[i]) ? arr[i] : null;
}
/** arr[i-n+1 … i] 的和（跳过空值）；一个都没有就返回 null */
function sumBack(arr, i, n) {
  if (!Array.isArray(arr) || i < 0) return null;
  let s = 0;
  let k = 0;
  for (let j = Math.max(0, i - n + 1); j <= i && j < arr.length; j++) {
    if (isNum(arr[j])) { s += arr[j]; k++; }
  }
  return k ? s : null;
}
function avgBack(arr, i, n) {
  if (!Array.isArray(arr) || i < 0) return null;
  let s = 0;
  let k = 0;
  for (let j = Math.max(0, i - n + 1); j <= i && j < arr.length; j++) {
    if (isNum(arr[j])) { s += arr[j]; k++; }
  }
  return k ? s / k : null;
}
/** arr[i] / arr[i-n] − 1 */
function chg(arr, i, n) {
  const a = val(arr, i);
  const b = val(arr, i - n);
  return a != null && b != null && b !== 0 ? a / b - 1 : null;
}
/** 「平时」5 天净流量有多大：前 60 天里，每个 5 天窗口净流量绝对值的平均。 */
function typical5(flow, i) {
  const xs = [];
  for (let j = i - 5; j >= Math.max(4, i - 60); j--) {
    const s = sumBack(flow, j, 5);
    if (s != null) xs.push(A(s));
  }
  if (xs.length < 10) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return m > 0 ? m : null;
}
/** 名字会被看错的公司（和指数 / 板块同名）：说话时换成不会误会的叫法（和 brief.py ALIAS 一样）。 */
export const ALIAS = Object.freeze({ NDAQ: '纳斯达克交易所（公司）' });
const tickerOf = (node) => (node && (node.ticker || (/^s:/.test(String(node.id || '')) ? String(node.id).slice(2) : ''))) || '';
/** 说话时用的名字：NDAQ → 「纳斯达克交易所（公司）」，免得和纳斯达克指数搞混。 */
export function displayName(node) {
  if (!node) return '这里';
  const t = tickerOf(node);
  if (t && ALIAS[t]) return ALIAS[t];
  return node.name || t || String(node.id || '') || '这里';
}
const nm = (node) => displayName(node);
const B = (s) => `【${s}】`;
/** 稳定的小哈希：同一个东西同一天说同一句，不同的东西换着说（不随机，可复现）。 */
function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const vary = (key, opts) => opts[hash(key) % opts.length];

/** 数一句话里有几个汉字（每句要求 ≤ 30 个）。 */
export function hanLen(s) {
  return (String(s).match(/[\u3400-\u9fff]/g) || []).length;
}
/** 第一句每个分句都 ≤ 30 字的；都太长就用最后一句。 */
function fit(...cands) {
  const xs = cands.filter(Boolean);
  for (const c of xs) if (c.split(/[。！？；]/).every((p) => hanLen(p) <= MAX_HAN)) return c;
  return xs[xs.length - 1] || '';
}

/** "2026-10-21" → "10月21日" */
export function dateCN(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${+m[2]}月${+m[3]}日` : String(iso || '');
}

/** 倍数：2 → "2"，2.36 → "2.4"，12.3 → "12" */
export function times(r) {
  if (!isNum(r)) return '—';
  if (r >= 9.95) return String(Math.round(r));
  const s = r.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// ───────────────────────────── 老风的嘴（§12） ─────────────────────────────
let VOICE = 'sharp';
/** 'sharp'（默认，犀利）| 'mild'（温和）。之后所有生成的句子都用这个语气。返回当前语气。 */
export function setVoice(v) {
  VOICE = v === 'mild' ? 'mild' : 'sharp';
  return VOICE;
}
export function getVoice() { return VOICE; }
const V = (sharp, mild) => (VOICE === 'mild' ? mild : sharp);
/** 读 brief.json 这类双份文字：obj[key]（犀利）/ obj[key+'Mild']（温和），按当前语气挑。 */
export function voiced(obj, key = 'say') {
  if (!obj) return '';
  const s = obj[key];
  const m = obj[key + 'Mild'];
  return (VOICE === 'mild' ? (m ?? s) : (s ?? m)) ?? '';
}
/** 列表项说的那句话：say / why / caption / text，按当前语气。 */
export function sayOf(it) {
  return voiced(it, 'say') || voiced(it, 'why') || voiced(it, 'caption') || (it && it.text) || '';
}

// ───────────────────────────── 数字 → 人话 ─────────────────────────────
/** 百万美元 → "3.2亿美元" / "850万美元"。opts.sign=true 时正数带 "+"；opts.est=true 时前面加「约」。 */
export function money(usdMillions, opts = {}) {
  const m = usdMillions;
  if (!isNum(m)) return '—';
  const a = A(m);
  const sign = m < 0 && a * 100 >= 0.05 ? '-' : opts.sign && m > 0 && a * 100 >= 0.05 ? '+' : '';
  const pre = opts.est ? '约' : '';
  let body;
  if (a >= 1e6) {
    const wy = a / 1e6; // 1e6 百万美元 = 1 万亿美元
    body = (wy >= 9.95 ? String(Math.round(wy)) : wy.toFixed(1)) + '万亿美元';
  } else if (a >= 100) {
    const yi = a / 100; // 100 百万美元 = 1 亿美元
    body = (yi >= 99.95 ? String(Math.round(yi)) : yi.toFixed(1)) + '亿美元';
  } else {
    const wan = a * 100; // 1 百万美元 = 100 万美元
    if (wan >= 9.95) body = Math.round(wan) + '万美元';
    else if (wan >= 0.05) body = wan.toFixed(1) + '万美元';
    else return pre + '0美元';
  }
  return pre + sign + body;
}

/** 0.032 → "+3.2%"，-0.041 → "-4.1%"，0 → "0.0%" */
export function pct(x) {
  if (!isNum(x)) return '—';
  const v = x * 100;
  const a = A(v);
  const s = a >= 99.5 ? String(Math.round(a)) : a.toFixed(1);
  if (+s === 0) return '0.0%';
  return (v > 0 ? '+' : '-') + s + '%';
}
const pctAbs = (x) => pct(A(x)).replace(/^[+-]/, '');

// ───────────────────────────── 估算（§14 宁可估，不可空） ─────────────────────────────
export const EST_BADGE = '估';
/** 把握度 0–1 → 人话 */
export function confWord(conf) {
  if (!isNum(conf)) return '把握不详';
  if (conf >= 0.8) return '比较有把握';
  if (conf >= 0.5) return `把握${Math.round(conf * 10)}成`;
  return `把握不大（${Math.round(conf * 10)}成）`;
}
function estOf(x) {
  if (!x) return null;
  if (x.est === true) return x;
  if (x.now && x.now.est === true) return { ...x.now, basis: x.now.basis || x.basis, conf: x.now.conf ?? x.conf };
  if (x.facts && x.facts.est === true) return x.facts;
  return null;
}
/** 短标签：「估 · 按同行类比」 */
export function estLabel(x) {
  const e = estOf(x);
  if (!e) return '';
  return `${EST_BADGE} · ${e.basis || '按同行类比'}`;
}
/** 一句话说清楚这是怎么估的：「老风估的：按同行类比，把握4成——等你补数据。」 */
export function estimateNote(x) {
  const e = estOf(x);
  if (!e) return '';
  const basis = e.basis || '按同行类比';
  const c = confWord(e.conf);
  return V(`老风估的：${basis}，${c}——等你补数据。`, `这是估算：${basis}（${c}），等你补数据。`);
}

// ───────────────────────────── 真钱 vs 估（DESIGN.md §23 修订） ─────────────────────────────
// 地图上的钱是按价格 × 成交额估的（§2）。有真钱（ETF 申赎、南向、A股 ETF 申赎）的地方，一句按估算说「钱在进 / 出」的话
// 碰上方向相反（又不小）的真钱、或估算在这里看不出方向（国库券 / 货币基金 ETF：净值天天涨，估算永远说「钱在进」）时，
// 必须先把这件事说出来（和 pipeline/brief.py real_against / real_blind / real_flat 一样）。
// 反 的规矩（同一批 ETF、同几天、两边都不小、估算看得出方向）：compareAt —— 和 flows/realflow.py compare_at、
// pipeline/brief.py compare_at 一字不差；ui/realmoney.js 从这里 import（JS 只有这一份）。
const CLASH = Object.freeze({ abs: 5, rel: 0.5, scaleWin: 120, blindWin: 250, blindShare: 0.9, blindMin: 40, stale: 5 });
const medianAbs = (xs) => {
  if (!xs.length) return 0;
  const ys = xs.slice().sort((a, b) => a - b), n = ys.length;
  return n % 2 ? ys[(n - 1) / 2] : 0.5 * (ys[n / 2 - 1] + ys[n / 2]);
};
/** flows/realflow.py compare_at, line for line. real/est = arrays on the same dates; i = day index.
 *  → null（没有 / 太旧）| {real5, est5, from, through, lag, realScale, estScale, estPos, realMat, estMat, blind, clash}
 *  （from / through = 这 5 个有真钱的交易日的头尾下标；from 只在 JS 这份里有，给卡片写「10月17–23日」用） */
export function compareAt(real, est, i) {
  if (!Array.isArray(real)) return null;
  const top = Math.min(i, real.length - 1);
  const have = [];
  for (let k = 0; k <= top; k++) if (isNum(real[k]) && (!est || isNum(est[k]))) have.push(k);
  if (have.length < 5 || i - have[have.length - 1] > CLASH.stale) return null;
  const w = have.slice(-5);
  const sumOver = (arr, ks) => ks.reduce((q, k) => q + arr[k], 0);
  const r5 = sumOver(real, w);
  const wins = (arr, n) => { const out = []; for (let q = Math.max(4, have.length - n); q < have.length; q++) out.push(sumOver(arr, have.slice(q - 4, q + 1))); return out; };
  const rs = medianAbs(wins(real, CLASH.scaleWin).map(Math.abs));
  const realMat = Math.abs(r5) >= Math.max(CLASH.abs, CLASH.rel * rs);
  const out = { real5: r5, from: w[0], through: w[w.length - 1], lag: i - w[w.length - 1], realScale: rs, realMat };
  if (!est) return { ...out, est5: null, estScale: null, estPos: null, estMat: false, blind: false, clash: false };
  const e5 = sumOver(est, w);
  const es = medianAbs(wins(est, CLASH.scaleWin).map(Math.abs));
  const longE = wins(est, CLASH.blindWin);
  const pos = longE.length ? longE.filter((x) => x > 0).length / longE.length : null;
  const blind = pos != null && longE.length >= CLASH.blindMin && (pos >= CLASH.blindShare || pos <= 1 - CLASH.blindShare);
  const estMat = Math.abs(e5) >= Math.max(CLASH.abs, CLASH.rel * es);
  return { ...out, est5: e5, estScale: es, estPos: pos, estMat, blind, clash: !blind && realMat && estMat && (r5 > 0) !== (e5 > 0) };
}
const REAL_MIN_COV = 0.3;
/** 一条序列自带的真钱（realflow.py --apply 写进 maps/<id>.json 的 realFlow[] / realEst[]，或 stocks/<T>.json 的 realFlow[]，
 *  那只 ETF 自己的 flow 就是「同一批 ETF」的估算）→ 和 ui/realmoney.js app.realMoney 一样的形状 | null。dates 给了就带上 asOf。 */
export function realOfSeries(s, i, dates) {
  if (!s || !Array.isArray(s.realFlow)) return null;
  if (isNum(s.realCoverage) && s.realCoverage < REAL_MIN_COV) return null;
  const n = s.realFlow.length;
  const t = clampIdx(i, n);
  if (t < 0) return null;
  const est = Array.isArray(s.realEst) ? s.realEst : Array.isArray(s.c) && Array.isArray(s.flow) ? s.flow : null;
  const c = compareAt(s.realFlow, est, t);
  if (!c) return null;
  const ds = Array.isArray(dates) ? dates : Array.isArray(s.dates) ? s.dates : null;
  const asOf = ds && ds[c.through] ? String(ds[c.through]).slice(0, 10) : null;
  return { flow5: c.real5, est5: c.est5, label: s.realLabel || '申赎', coverage: isNum(s.realCoverage) ? s.realCoverage : null,
    asOf, lag: asOf && c.lag > 0 ? asOf : null, lagDays: c.lag, likeForLike: !!est,
    clash: c.clash, blind: c.blind, realMat: c.realMat, estMat: c.estMat, estPos: c.estPos };
}
let REAL_OF = null;
/** 壳子（ui/realmoney.js）装上 (id, i) → app.realMoney(id, i)：全球地图的南向 / A股 ETF 申赎也看得到。没装就只看序列自带的。 */
export function setRealOf(fn) { REAL_OF = typeof fn === 'function' ? fn : null; return !!REAL_OF; }
/** 一块地第 i 天的真钱：调用方给的 realOf(id) → 壳子装的 → 序列自带的。只有背景（稳定币）的不算。 */
function realFor(id, s, i, realOf) {
  const ok = (r) => (r && !r.contextOnly && isNum(r.flow5) ? r : null);
  let r = null;
  if (typeof realOf === 'function') { try { r = ok(realOf(id)); } catch (e) { r = null; } }
  if (!r && REAL_OF && id) { try { r = ok(REAL_OF(id, i)); } catch (e) { r = null; } }
  return r || realOfSeries(s, i);
}
/** describe / take 的真钱：opts.real → nowLike.real → 壳子装的（opts.id）。 */
function realOfLike(n, opts) {
  const o = opts || {};
  const ok = (r) => (r && !r.contextOnly && isNum(r.flow5) ? r : null);
  if (ok(o.real)) return o.real;
  if (n && ok(n.real)) return n.real;
  if (o.id && REAL_OF) { try { return ok(REAL_OF(o.id, isNum(o.i) ? o.i : undefined)); } catch (e) { return null; } }
  return null;
}
const realVerb = (label, x) => (/申赎|申购/.test(label) ? (x >= 0 ? '净申购' : '净赎回') : /增发/.test(label) ? (x >= 0 ? '净增发' : '净销毁')
  : /南向|北向|港股通/.test(label) ? (x >= 0 ? '净买入' : '净卖出') : (x >= 0 ? '净流入' : '净流出'));
/** 「ETF 申赎」→「ETF」，「A股 ETF 申赎（股票类）」→「A股 ETF」，「稳定币净增发」→「稳定币」，「申赎」→「」 */
function realPre(label) {
  const l = String(label || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  if (/申赎$|申购$/.test(l)) return l.replace(/\s*(申赎|申购)$/, '').trim();
  if (/增发$/.test(l)) return l.replace(/净?增发$/, '').trim();
  return l;
}
/** 「ETF 5天净申购 77.8亿美元」；不大时带「（不算大）」；几乎没动时「ETF 5天几乎没有申赎」（和 brief.py real_bit 一样） */
export function realBit(r, days = 5) {
  if (!r || !isNum(r.flow5)) return '';
  const pre = realPre(r.label);
  const p = pre ? `${pre} ` : '';
  if (A(r.flow5) < 0.5) return `${p}${days}天几乎没有${/申/.test(r.label || '') ? '申赎' : '进出'}`;
  return `${p}${days}天${realVerb(r.label || '', r.flow5)} ${money(A(r.flow5))}${r.realMat === false ? '（不算大）' : ''}`;
}
/**
 * 一句按估算 est（这块地自己 5 天的净流入）说方向的话，碰上真钱时该怎么说（和 brief.py why_sentence 的真钱分支一样）：
 *   blind   估算在这里看不出方向 →「按成交估不出这里的方向，看真钱：…」
 *   clash / against  真钱（不小）和估算反着 →「按成交估是钱在出，真钱唱反调 / 却相反：…」（唱反调 只给同一批 ETF 的 反）
 *   flat    同一批 ETF 估出来的钱不小，真钱几乎没动 →「按成交估是钱在进，真钱几乎没动：…」
 * → null | {kind, sign（真钱的方向 ±1，flat 为 0）, sharp, mild, short, shortMild}
 */
export function realSay(r, est) {
  if (!r || !isNum(r.flow5) || r.contextOnly) return null;
  const bit = realBit(r);
  const sign = r.flow5 > 0 ? 1 : r.flow5 < 0 ? -1 : 0;
  if (r.blind) {
    return { kind: 'blind', sign, sharp: `按成交估不出这里的方向，看真钱：${bit}`, mild: `这里按成交估不出方向，真钱：${bit}`,
      short: `估不出方向，看真钱：${bit}`, shortMild: `看真钱：${bit}` };
  }
  if (!isNum(est) || A(est) < 0.05) return null;
  const side = est > 0 ? '进' : '出';
  // 同一批 ETF 估出来的方向和整块地自己的估算反着时，点明是「整块地」（和 brief.py est_who 一样）
  // （一只 ETF 自己：是「最近 5 天」和「有真钱的那 5 天」两笔估算）
  const who = r.likeForLike && isNum(r.est5) && A(r.est5) >= 0.05 && (r.est5 > 0) !== (est > 0)
    ? (r.label === '申赎' ? '最近5天按成交估' : '整块地按成交估') : '按成交估';
  if (r.realMat && (r.flow5 > 0) !== (est > 0)) {
    const aw = r.clash ? '唱反调' : '却相反';
    return { kind: r.clash ? 'clash' : 'against', sign, sharp: `${who}是钱在${side}，真钱${aw}：${bit}`,
      mild: `${who}是钱在${side}，真钱却相反：${bit}`, short: `真钱${aw}：${bit}`, shortMild: `真钱方向相反：${bit}` };
  }
  if (A(est) >= 50 && isNum(r.est5) && r.estMat && !r.realMat && A(r.flow5) < 0.1 * A(r.est5)) {
    return { kind: 'flat', sign: 0, sharp: `${who}是钱在${side}，真钱几乎没动：${bit}`, mild: `${who}是钱在${side}，真钱几乎没动：${bit}`,
      short: `真钱几乎没动：${bit}`, shortMild: '真钱几乎没动' };
  }
  return null;
}

// ───────────────────────────── 词汇（DESIGN.md §5） ─────────────────────────────
const NA = Object.freeze({ text: '暂无数据', short: '暂无', emoji: '·', level: 0, na: true });

/**
 * 风和真金白银打架了吗？风 = ½·关注度（成交份额 rot）+ ½·净流入（flow5），两半方向相反时风会「说谎」：
 *   'attn'  风 ≥ 0.5 但 5 天净流出 → 关注度在升，钱没真进来
 *   'quiet' 风 ≤ −0.5 但 5 天净流入 → 钱在进，但没人注意
 * flow5 不知道 / 太小（< 5 万美元）→ null（不打架）。
 */
export function windMix(w, flow5) {
  if (!isNum(w) || !isNum(flow5) || A(flow5) < 0.05) return null;
  if (w >= 0.5 && flow5 < 0) return 'attn';
  if (w <= -0.5 && flow5 > 0) return 'quiet';
  return null;
}
const MIXED = Object.freeze({
  attn: Object.freeze({ text: '关注度在升，但钱没真进来', short: '光热闹', emoji: '👀', level: 0, mixed: 'attn' }),
  quiet: Object.freeze({ text: '钱在进，但没人注意', short: '钱悄悄进', emoji: '🤫', level: 0, mixed: 'quiet' }),
});

/**
 * 风：钱是流进来还是流出去。传了 flow5（5 天净流入，百万美元）时，风和钱打架就直说
 * （「关注度在升，但钱没真进来」/「钱在进，但没人注意」，level 0，mixed 'attn'|'quiet'）。
 * 传了 crash（crashAt() 的结果，或 tree now.crash 0/1/2）且在暴跌：不说「风平浪静 / 悄悄溜走」，说「钱跟着崩盘往外逃」
 * 之类（DESIGN §8 修订：恐慌里成交份额暴涨、钱在流出，两半抵消让风接近 0）。{…, crash: 1|2}
 */
/** 暴跌中（crash = crashAt() 的结果 / 等级）：风小只是成交份额和钱互相抵消，「风平浪静 / 悄悄溜走」都不对——直说在跌着跑 */
function crashWind(lv, flow5) {
  const f = isNum(flow5) && A(flow5) >= 0.05 ? flow5 : null;
  if (f != null && f < 0) return lv >= 2 ? { text: '钱跟着崩盘往外逃', short: '崩着逃', emoji: '⏬', level: -2, crash: lv }
    : { text: '钱跟着急跌往外撤', short: '跌着撤', emoji: '🔽', level: -1, crash: lv };
  if (f != null && f > 0) return { text: lv >= 2 ? '崩盘里成交很猛，进的多半是抄底和换手' : '急跌里有人接，多半是换手', short: '跌中换手', emoji: '⚠️', level: 0, crash: lv };
  return { text: lv >= 2 ? '正在崩' : '正在急跌', short: lv >= 2 ? '崩' : '急跌', emoji: '⬇️', level: lv >= 2 ? -2 : -1, crash: lv };
}
export function windWord(w, flow5, crash) {
  if (!isNum(w)) return { ...NA };
  const lv = crashLevel(crash);
  if (lv) return crashWind(lv, flow5);
  const mx = windMix(w, flow5);
  if (mx) return { ...MIXED[mx] };
  if (w > 1.5) return { text: '钱在狂涌进来', short: '狂涌入', emoji: '⏫', level: 2 };
  if (w >= 0.5) return { text: '钱在流进来', short: '流入', emoji: '🔼', level: 1 };
  if (w > -0.5) return { text: '风平浪静', short: '平静', emoji: '〰️', level: 0 };
  if (w >= -1.5) return { text: '钱在悄悄溜走', short: '流出', emoji: '🔽', level: -1 };
  return { text: '钱在大逃离', short: '大逃离', emoji: '⏬', level: -2 };
}
/** 风的犀利说法（只在 sharp 语气里用）；传 flow5 时，风和钱打架就说实话。 */
function windSharp(w, key = '', flow5, crash) {
  if (!isNum(w)) return '没数据，老风不乱说';
  const lv = crashLevel(crash);
  if (lv) {
    const f = isNum(flow5) && A(flow5) >= 0.05 ? flow5 : null;
    if (f != null && f < 0) return lv >= 2 ? '钱跟着崩盘夺门而逃' : '钱跟着急跌往外撤';
    if (f != null && f > 0) return lv >= 2 ? '崩着还有人接，多半是抄底换手' : '跌着还有人接，多半是换手';
    return lv >= 2 ? '正在崩，没人敢说话' : '正在急跌';
  }
  const mx = windMix(w, flow5);
  if (mx === 'attn') return vary(key, ['光热闹不掏钱，看客比买家多', '人都围过来了，钱没跟进来']);
  if (mx === 'quiet') return vary(key, ['没人盯着，钱在闷声进货', '没人注意，钱在悄悄进']);
  if (w > 1.5) return vary(key, ['钱跟疯了一样往里灌', '钱在狂灌，挡都挡不住']);
  // 「悄悄 / 闷声」只留给 'quiet'（钱在进，但没人注意）；普通的进出不说悄悄（和 brief.py 一样）
  if (w >= 0.5) return vary(key, ['钱在往里搬', '有人在进货']);
  if (w > -0.5) return '风平浪静，没故事';
  if (w >= -1.5) return vary(key, ['钱在溜号', '钱在往外撤']);
  return vary(key, ['钱在大逃亡', '钱在夺门而逃']);
}
/** 当前语气下风的那句话（风和钱打架时说实话）。 */
const windSay = (w, key, flow5, crash) => V(windSharp(w, key, flow5, crash), windWord(w, flow5, crash).text);

/** 温度：最近跑得比平时、比邻居快不快 */
export function tempWord(t) {
  if (!isNum(t)) return { ...NA };
  if (t > 1.5) return { text: '很热', short: '很热', emoji: '🔥', level: 2 };
  if (t >= 0.5) return { text: '暖', short: '暖', emoji: '☀️', level: 1 };
  if (t > -0.5) return { text: '常温', short: '常温', emoji: '⛅', level: 0 };
  if (t >= -1.5) return { text: '凉', short: '凉', emoji: '🍃', level: -1 };
  return { text: '很冷', short: '很冷', emoji: '🧊', level: -2 };
}

/** 拥挤度 0…100 */
export function presWord(p) {
  if (!isNum(p)) return { ...NA };
  if (p >= 85) return { text: '人挤人', short: '挤', emoji: '🚇', level: 2 };
  if (p >= 65) return { text: '人多', short: '人多', emoji: '👥', level: 1 };
  if (p >= 35) return { text: '正常', short: '正常', emoji: '🙂', level: 0 };
  if (p >= 15) return { text: '人少', short: '人少', emoji: '🚶', level: -1 };
  return { text: '冷清洼地', short: '空', emoji: '🏜️', level: -2 };
}

/** 风暴：最近几天波动突然变大 */
export function stormWord(s) {
  if (!isNum(s)) return { ...NA };
  if (s >= 1.5) return { text: '大风暴（波动突然变得很大）', short: '大风暴', emoji: '⛈️', level: 2 };
  if (s >= 0.8) return { text: '有风暴', short: '风暴', emoji: '🌧️', level: 1 };
  return { text: '天气平稳', short: '平稳', emoji: '', level: 0 };
}

/** 风向突变 */
export function frontWord(f) {
  if (!isNum(f) || f === 0) return { text: '风向没变', short: '', emoji: '', level: 0 };
  if (f > 0) return { text: '风向刚变：钱开始流入', short: '风向刚变', emoji: '🌀', level: 1 };
  return { text: '风向刚变：钱开始撤离', short: '风向刚变', emoji: '🌀', level: -1 };
}

/** "5天净流入 3.2亿美元" */
function flowText(f5, days = 5) {
  if (!isNum(f5) || A(f5) < 0.05) return `${days}天进出打平`;
  return `${days}天净${f5 > 0 ? '流入' : '流出'} ${money(A(f5))}`;
}
/** 地图上的钱是按价格 × 成交额估出来的（§2 / §14）：带金额的句子都标「估」。"5天净流入 3.2亿美元（估）" */
function flowEst(f5, days = 5) {
  return !isNum(f5) || A(f5) < 0.05 ? flowText(f5, days) : `${flowText(f5, days)}（${EST_BADGE}）`;
}
/** 5 天进出相当于它几天的成交额："约它 0.3 天的成交"（给「风平浪静 / 不算反常」配上尺度，和 brief.py scale_text 一样） */
function scaleText(f5, dv20) {
  if (!isNum(f5) || !isNum(dv20) || dv20 <= 0) return '';
  const d = A(f5) / dv20;
  return d < 0.1 ? '不到它 0.1 天的成交' : `约它 ${d.toFixed(1)} 天的成交`;
}

// ───────────────────────────── 季节（DESIGN.md §8.2） ─────────────────────────────
// 季节说的是「现在」的人气和钱，不是预言。§8.2 原来写的「下一步」（🌱 → 多半进夏）实测站不住：
// 精选地图一年 24.5 万个「格子 × 天」，春天 5 天后只有 13% 进夏、42% 退回冬，之后 5 天净流入的概率 52.6%（平时 50.4%）。
// 所以「下一步」一律用历史概率说。pipeline/brief.py 每天在每份地图自己的 252 天上重算一遍 → brief.seasonStats；
// 壳子拿到 brief 后调 setSeasonStats(brief.seasonStats)，没调就用下面这份（2026-10-28 在精选地图上实测）。
const SEASON_NEXT = Object.freeze({ spring: 'summer', summer: 'autumn', autumn: 'winter', winter: 'spring' });
const SEASON_NAME = Object.freeze({ spring: '春', summer: '夏', autumn: '秋', winter: '冬' });
const STAT_MIN = 300; // 分「钱在进 / 钱在出」看时，样本少于这个就用总表
const DEFAULT_SEASON_STATS = Object.freeze({
  asOf: '2026-10-27', horizon: 5, n: 245154, base: { flowPos: 0.504 }, measured: 'curated',
  spring: { n: 25108, flowPos: 0.526, to: { spring: 0.057, summer: 0.13, autumn: 0.053, winter: 0.423, none: 0.337 },
    byMoney: { in: { n: 21686, to: { spring: 0.05, summer: 0.131, autumn: 0.057, winter: 0.427, none: 0.335 } },
      out: { n: 3422, to: { spring: 0.104, summer: 0.12, autumn: 0.029, winter: 0.397, none: 0.35 } } } },
  summer: { n: 38807, flowPos: 0.528, to: { spring: 0.003, summer: 0.412, autumn: 0.367, winter: 0.07, none: 0.147 },
    byMoney: { in: { n: 35603, to: { spring: 0.003, summer: 0.409, autumn: 0.377, winter: 0.072, none: 0.139 } },
      out: { n: 3204, to: { spring: 0.009, summer: 0.448, autumn: 0.253, winter: 0.047, none: 0.243 } } } },
  autumn: { n: 30911, flowPos: 0.502, to: { spring: 0.032, summer: 0.223, autumn: 0.258, winter: 0.201, none: 0.286 },
    byMoney: { in: { n: 10114, to: { spring: 0.023, summer: 0.184, autumn: 0.305, winter: 0.228, none: 0.259 } },
      out: { n: 20797, to: { spring: 0.036, summer: 0.241, autumn: 0.236, winter: 0.188, none: 0.299 } } } },
  winter: { n: 104470, flowPos: 0.493, to: { spring: 0.185, summer: 0.038, autumn: 0.013, winter: 0.673, none: 0.091 },
    byMoney: { in: { n: 26883, to: { spring: 0.146, summer: 0.03, autumn: 0.016, winter: 0.714, none: 0.094 } },
      out: { n: 77587, to: { spring: 0.198, summer: 0.041, autumn: 0.012, winter: 0.658, none: 0.09 } } } },
});
let SEASON_STATS = DEFAULT_SEASON_STATS;
/** 换上 brief.seasonStats（这份地图自己的历史季节转移表）。给的东西不像样就保持原来的。返回现在用的那份。 */
export function setSeasonStats(stats) {
  const okEntry = (e) => e && typeof e === 'object' && e.to && typeof e.to === 'object';
  if (stats && typeof stats === 'object' && Object.keys(SEASON_NEXT).every((k) => okEntry(stats[k]))) SEASON_STATS = stats;
  return SEASON_STATS;
}
export function getSeasonStats() { return SEASON_STATS; }

/** 从季节 k 走到 x 怎么说（和 brief.py season_to_word 一样） */
function seasonToWord(k, x) {
  if (x === k) return `还是${SEASON_NAME[k]}`;
  if (x === 'spring') return k === 'winter' ? '开春' : '又冒芽';
  if (x === 'summer') return k === 'spring' ? '进夏' : '回到夏';
  if (x === 'autumn') return '入秋';
  if (x === 'winter') return k === 'spring' ? '退回冬' : '入冬';
  return '没了季节';
}
/**
 * 季节的「下一步」，用历史概率说（和 brief.py season_next_say 一样）：
 * seasonNext('spring') → {sharp:'别急，历史上 5 天后只有 13% 进夏，42% 退回冬', mild:'历史上 5 天后：13% 进夏，42% 退回冬', odds}
 * flow5（这 5 天的净流入）给了，就用「钱在进 / 钱在出」那一半的表（样本够时）。
 * crash（暴跌闸门触发）：用 seasonStats[key].byCrash（只算暴跌那天的转移）；没有 / 样本不够就不报概率（odds null）。
 */
export function seasonNext(key, flow5, crash) {
  const st = SEASON_STATS;
  const e = st && st[key];
  if (!SEASON_NEXT[key] || !e || !e.to) return null;
  let to = e.to;
  const lv = crashLevel(crash);
  const dir = isNum(flow5) && A(flow5) >= 0.05 ? (flow5 > 0 ? 'in' : 'out') : null;
  const bm = !lv && dir && e.byMoney && e.byMoney[dir];
  if (lv) {
    // 暴跌那天的季节（§8 修订）：用 brief.seasonStats 的 byCrash 那张表；平常秋天的「24% 回到夏」不是崩了以后的样子
    const bc = e.byCrash;
    if (!bc || !bc.to || (bc.n || 0) < STAT_MIN) {
      return { sharp: '暴跌过后怎么走，历史样本不够，不报概率', mild: '暴跌过后怎么走，样本不够，不报概率', odds: null };
    }
    to = bc.to;
  }
  if (bm && bm.to && (bm.n || 0) >= STAT_MIN) to = bm.to;
  const pc = (p) => `${Math.round(100 * (p || 0))}%`;
  const nat = SEASON_NEXT[key];
  const pn = to[nat] || 0;
  const others = Object.entries(to).filter(([x]) => x !== 'none' && x !== nat && SEASON_NAME[x]).sort((a, b) => b[1] - a[1]);
  if (!others.length) return null;
  const [ox, op] = others[0];
  const h = st.horizon || 5;
  const body = `${pc(pn)} ${seasonToWord(key, nat)}，${pc(op)} ${seasonToWord(key, ox)}`;
  if (lv) {
    const m = `暴跌过后，历史上 ${h} 天后 ${body}`;
    return { sharp: m, mild: m, odds: { horizon: h, next: nat, toNext: pn, top: ox, toTop: op, flowPos: null,
      base: st.base ? st.base.flowPos ?? null : null, n: e.byCrash.n ?? null, money: null, crash: lv } };
  }
  const mild = `历史上 ${h} 天后 ${body}`;
  let sharp = mild;
  if (key === 'spring' && pn < 0.25) sharp = `别急，历史上 ${h} 天后只有 ${pc(pn)} ${seasonToWord(key, nat)}，${pc(op)} ${seasonToWord(key, ox)}`;
  else if (key === 'winter' && (to.winter || 0) >= 0.5) sharp = `冬天很长，历史上 ${h} 天后 ${pc(to.winter)} 还是冬，${pc(pn)} 开春`;
  else if (key === 'summer' && pn >= 0.3) sharp = `小心，历史上 ${h} 天后 ${body}`;
  return { sharp, mild, odds: { horizon: h, next: nat, toNext: pn, top: ox, toTop: op, flowPos: e.flowPos ?? null,
    base: st.base ? st.base.flowPos ?? null : null, n: e.n ?? null, money: bm && (bm.n || 0) >= STAT_MIN ? dir : null } };
}

/** 四季的固定说法。now/next 是温和版，nowSharp/nextSharp 是老风版。icon 给 SVG 图标集用。
 *  next / nextSharp = 默认那份历史概率表的说法（实际显示时 seasonInfo / season 用 setSeasonStats 换上的那份）。 */
const nx = (k) => seasonNext(k) || { sharp: '', mild: '' };
export const SEASONS = Object.freeze({
  spring: Object.freeze({
    key: 'spring', emoji: '🌱', name: '春', icon: 'sprout',
    now: '钱刚开始进来，还不挤', next: nx('spring').mild,
    nowSharp: '刚冒芽：钱开始摸进来，人还没到', nextSharp: nx('spring').sharp,
  }),
  summer: Object.freeze({
    key: 'summer', emoji: '☀️', name: '夏', icon: 'sun',
    now: '正热、人多', next: nx('summer').mild,
    nowSharp: '盛夏：又热又挤，人人都在聊它', nextSharp: nx('summer').sharp,
  }),
  autumn: Object.freeze({
    key: 'autumn', emoji: '🍂', name: '秋', icon: 'maple',
    now: '钱从拥挤处撤离', next: nx('autumn').mild,
    nowSharp: '入秋了：挤着的人开始往外跑', nextSharp: nx('autumn').sharp,
  }),
  winter: Object.freeze({
    key: 'winter', emoji: '❄️', name: '冬', icon: 'snowflake',
    now: '冷清没人管', next: nx('winter').mild,
    nowSharp: '寒冬：没人要，连风都懒得吹', nextSharp: nx('winter').sharp,
  }),
});
const NO_SEASON = Object.freeze({
  key: null, emoji: '', name: '', icon: null,
  now: '平稳', next: '看不出季节，先放着', nowSharp: '不冷不热，没故事', nextSharp: '等它自己挑个方向',
});

// ───────────────────────────── 暴跌闸门（DESIGN.md §8 修订，2026-10-28；和 pipeline/crashgate.py 一字不差） ─────────────────────────────
// §8.2 只看风和拥挤度。恐慌抛售时成交量暴增，风（一半是成交份额）和拥挤度一起被推高，巴西一天跌 19% 读成了 ☀️ 夏。
// 闸门看价格本身，用它自己的波动当尺子，再加一个绝对下限：
//   σ = 它前 60 个交易日（不含最近 5 天，免得这一跌把自己的尺子撑大）的日涨跌标准差，至少 40 个有效日；
//       算之前每天的涨跌先夹到「中位数 ± 5·σ_MAD」（σ_MAD = 1.4826 × 中位绝对偏差）——一天的怪涨（MRNA 2026-08-19
//       +177%）不会把尺子撑大三个月；平常的序列什么都不夹，σ 就是普通的标准差（robustSigma，和 crashgate.py 一样）
//   崩（2）：5 天 ≤ −10% 且（≤ −3σ√5 或 ≤ −25%），或一天 ≤ −8% 且 ≤ −5σ
//   急跌（1）：5 天 ≤ −5% 且（≤ −2σ√5 或 ≤ −15%），或一天 ≤ −5% 且 ≤ −4σ
// 触发时 春 / 夏 / 无季节 → 拥挤度 ≥ 50 读 🍂 秋，否则 ❄️ 冬（§8.2 表自己的分界）；秋 / 冬 不变，但话里说出跌了多少。
const CRASH = Object.freeze({ sigDays: 60, sigMin: 40, clipK: 5, madK: 1.4826, l1r5: [-0.05, 2, -0.15], l2r5: [-0.10, 3, -0.25], l1r1: [-0.05, 4], l2r1: [-0.08, 5] });
const medianOf = (xs) => {
  const ys = xs.slice().sort((a, b) => a - b);
  const n = ys.length;
  return n % 2 ? ys[(n - 1) / 2] : 0.5 * (ys[n / 2 - 1] + ys[n / 2]);
};
/** 日涨跌的标准差，先把每天夹到 中位数 ± clipK·σ_MAD（和 crashgate.py robust_sigma 同一套算术） */
function robustSigma(rs0) {
  const med = medianOf(rs0);
  const smad = CRASH.madK * medianOf(rs0.map((x) => A(x - med)));
  let rs = rs0;
  if (smad > 0) {
    const lo = med - CRASH.clipK * smad, hi = med + CRASH.clipK * smad;
    rs = rs0.map((x) => (x < lo ? lo : x > hi ? hi : x));
  }
  const mu = rs.reduce((p, q) => p + q, 0) / rs.length;
  return Math.sqrt(rs.reduce((p, q) => p + (q - mu) * (q - mu), 0) / (rs.length - 1));
}
const CRASH_NAME = Object.freeze({ 1: '急跌', 2: '崩' });
/** 第 i 天在暴跌吗：series = 地图上的一条（idx）或 stocks/<T>.json（c）。→ null | {level, name, r1, r5, sigma, z5, by} */
export function crashAt(series, i) {
  const s = series || {};
  const px = Array.isArray(s.idx) ? s.idx : s.c;
  if (!Array.isArray(px)) return null;
  const t = clampIdx(i, px.length);
  if (t < 6) return null;
  const a = px[t], b = px[t - 5], c = px[t - 1];
  if (!isNum(a) || !isNum(b) || !isNum(c) || b <= 0 || c <= 0) return null;
  const r5 = a / b - 1;
  const r1 = a / c - 1;
  if (r5 > CRASH.l1r5[0] && r1 > CRASH.l1r1[0]) return null;
  const rs = [];
  for (let j = Math.max(1, t - 5 - CRASH.sigDays + 1); j <= t - 5; j++) {
    const x = px[j], y = px[j - 1];
    if (isNum(x) && isNum(y) && y > 0) rs.push(x / y - 1);
  }
  if (rs.length < CRASH.sigMin) return null;
  const sig = robustSigma(rs);
  const s5 = sig * Math.sqrt(5);
  const hit5 = ([floor, k, hard]) => r5 <= floor && (r5 <= -k * s5 || r5 <= hard);
  const hit1 = ([floor, k]) => r1 <= floor && r1 <= -k * sig;
  let level = 0, by = null;
  if (hit5(CRASH.l2r5)) { level = 2; by = 'r5'; }
  else if (hit1(CRASH.l2r1)) { level = 2; by = 'r1'; }
  else if (hit5(CRASH.l1r5)) { level = 1; by = 'r5'; }
  else if (hit1(CRASH.l1r1)) { level = 1; by = 'r1'; }
  if (!level) return null;
  const rd = (x) => Math.round(x * 1e4) / 1e4;
  return { level, name: CRASH_NAME[level], r1: rd(r1), r5: rd(r5), sigma: rd(sig), z5: s5 > 0 ? r2(r5 / s5) : null, by };
}
/** 调用方没给 crash（undefined：比如只有 ret1 / ret5 的快照），价格又跌破了闸门的下限（5 天或一天 ≤ −5%）：
 *  闸门可能已经触发，只是这里看不到 σ —— 那就不说「春 / 夏 / 平稳」，免得和地图上（看得到整条序列的）季节打架。 */
const crashUnknown = (n) => n && n.crash === undefined && ((isNum(n.ret5) && n.ret5 <= CRASH.l1r5[0]) || (isNum(n.ret1) && n.ret1 <= CRASH.l1r1[0]));
/** crash 参数可以是 crashAt() 的结果、tree.json now.crash（0/1/2）或 null → 等级 0/1/2 */
function crashLevel(cr) { return cr && typeof cr === 'object' ? cr.level || 0 : isNum(cr) ? cr : 0; }   // function: seasonNext 在模块加载时就用到
/** 「一天跌了 19.8%」/「5天跌了 18.6%」：暴跌闸门是被哪一项触发的就说哪一项（数字精确） */
function crashDrop(cr) {
  if (!cr || typeof cr !== 'object') return '';
  return cr.by === 'r1' && isNum(cr.r1) ? `一天跌了 ${pctAbs(cr.r1)}` : isNum(cr.r5) ? `5天跌了 ${pctAbs(cr.r5)}` : '';
}
/** 暴跌时的那句话（犀利 / 温和）：{sharp, mild} */
function crashWords(cr) {
  const lv = crashLevel(cr);
  if (!lv) return null;
  const d = crashDrop(cr);
  const dd = d ? `：${d}` : '';
  return lv >= 2
    ? { sharp: `崩了${dd}，人多是在逃命`, mild: `暴跌${dd}，远超它平时的波动`, note: '崩' }
    : { sharp: `急跌${dd}，热闹的是夺门的人`, mild: `急跌${dd}，比它平时的波动大得多`, note: '急跌' };
}

/** 暴跌 + 真钱对不上时的开头（不带「夺门 / 逃命」：真钱这时在说另一件事）：{sharp:'崩了：5天跌了 20.1%', mild:'暴跌：…'} */
function crashHead(cr) {
  const lv = crashLevel(cr);
  if (!lv) return null;
  const d = crashDrop(cr);
  const dd = d ? `：${d}` : '';
  return lv >= 2 ? { sharp: `崩了${dd}`, mild: `暴跌${dd}` } : { sharp: `急跌${dd}`, mild: `急跌${dd}` };
}

/**
 * §8.2 的规则（按表格顺序判断，和 brief.py / scenario / scout 一样）：
 *   🌱 w>0.3 且 dw>0.3 且 p<65 · ☀️ w>0.3 且 p≥65 · 🍂 w<−0.3 且 p≥50（或 dw<−0.6 且 p≥65）
 *   ❄️ w<−0.3 且 p<50，或 |w|≤0.3 且 p<35 · 其余 null。dw 不知道就当 0（那就不会判成春）。
 */
export function seasonKey(w, dw, p, crash) {
  if (!isNum(w) || !isNum(p)) return null;
  const d = isNum(dw) ? dw : 0;
  let k = null;
  if (w > 0.3 && d > 0.3 && p < 65) k = 'spring';
  else if (w > 0.3 && p >= 65) k = 'summer';
  else if ((w < -0.3 && p >= 50) || (d < -0.6 && p >= 65)) k = 'autumn';
  else if ((w < -0.3 && p < 50) || (A(w) <= 0.3 && p < 35)) k = 'winter';
  // 暴跌闸门（§8 修订）：在暴跌的地方不读春 / 夏 / 平稳
  if (crashLevel(crash) && k !== 'autumn' && k !== 'winter') k = p >= 50 ? 'autumn' : 'winter';
  return k;
}

/** key（或带 key 的对象）→ 当前语气的季节说明 {key, emoji, name, icon, now, next, text}。 */
export function seasonInfo(k) {
  const key = k && typeof k === 'object' ? k.key : k;
  const S = SEASONS[key] || NO_SEASON;
  const nn = S.key ? seasonNext(S.key) : null;      // 「下一步」= 历史概率（setSeasonStats 换上的那份）
  const now = V(S.nowSharp, S.now);
  const next = nn ? V(nn.sharp, nn.mild) : V(S.nextSharp, S.next);
  const text = S.key ? `${S.emoji} ${S.name}：${now} → ${next}` : `${now}，${next}`;
  return { key: S.key, emoji: S.emoji, name: S.name, icon: S.icon, now, next, text, nowMild: S.now, nextMild: nn ? nn.mild : S.next,
    odds: nn ? nn.odds : null };
}

/**
 * 季节的说法和同一屏上的钱、温度对得上（季节只看风、风的变化、拥挤度；它说的是「人气」，不是温度）：
 * 钱的方向和季节相反（春/夏但 5 天净流出；秋/冬但净流入）→ 说「人气 vs 钱」；
 * 夏天却不热、冬天却暖 → 不用「又热」「寒冬」这类和温度打架的词。→ {now, nowMild, mixed, note} | null
 * （「下一步」不在这里：一律用 seasonNext 的历史概率。这里原来的「入秋就在眼前」「等人气跟上就开春」实测也站不住——
 *  夏天钱先走的 5 天后入秋 25%，比钱还在进的 38% 还低；冬天钱在进的开春 15%，比钱在出的 20% 还低。）
 */
function seasonWords(key, w, flow5, temp, crash) {
  const cw = crashWords(crash);
  if (cw) return { mixed: 'crash', note: cw.note, nowSharp: cw.sharp, now: cw.mild };
  const f = isNum(flow5) && A(flow5) >= 0.05 ? flow5 : null;
  const t = isNum(temp) ? temp : null;
  const warm = t != null && t >= 0.5;
  const cool = t != null && t <= -0.5;
  if (key === 'spring') {
    if (f != null && f < 0) {
      return { mixed: 'money', note: '只有人气', nowSharp: '刚冒芽：人气先回来了，钱还在犹豫', now: '买卖的人多起来了，钱还没净流入' };
    }
    return null;
  }
  if (key === 'summer') {
    if (f != null && f < 0) {
      return { mixed: 'money', note: '人多钱少', nowSharp: '盛夏：人挤人，可钱已经不进了', now: '人很多，但钱没真进来' };
    }
    if (warm) return null; // 又热又挤：原话没毛病
    if (cool) {
      return { mixed: 'temp', note: '只是人多', nowSharp: '盛夏只是人多：挤满了人，价格却跑不动', now: '人很多，价格却跑不动' };
    }
    // 温度不知道或常温：不说「热」，只说人和钱
    return { mixed: null, nowSharp: '盛夏：人挤人，人人都在聊它', now: '人很多，钱还在进' };
  }
  if (key === 'autumn') {
    if (f != null && f > 0) {
      return { mixed: 'money', note: '人气在退', nowSharp: '入秋了：人在退场，钱倒还没走', now: '人气在退，钱倒还在进' };
    }
    return null;
  }
  if (key === 'winter') {
    // 只要 5 天是净流入就说「钱先到了」——不管风是怎么凑成「冬」的（|风| ≤ 0.3 且不挤也是冬：
    // 美股 5 天进 597 亿、风 −0.1 时就是这样，不能再说「等第一股钱回来」）
    if (f != null && f > 0) {
      return warm
        ? { mixed: 'money', note: '人气冷清', nowSharp: '冬天只是人气：钱先到了，价格也暖，人还没跟上', now: '人气冷清，可钱在进、价格也暖' }
        : { mixed: 'money', note: '人气冷清', nowSharp: '冬天只是人气：钱先到了，人气还没跟上', now: '人气冷清，钱却还在进' };
    }
    if (warm) {
      return { mixed: 'temp', note: '人气冷清', nowSharp: '冬天只是人气：没人理，价格倒还暖着', now: '人气冷清，价格倒还暖' };
    }
    return null;
  }
  return null;
}

/**
 * season(w, dw, p, flow5?, temp?) → {key, emoji, name, icon, now, next, nowMild, nextMild, text, mixed}
 * dw = wind_t − wind_{t−5}；p = 拥挤度。季节规则（§8.2）只看 w / dw / p，永远不变；
 * flow5（5 天净流入）和 temp（温度）只用来挑说法，保证和同一屏上的钱、温度不打架：
 * 春天却净流出 → 「人气先回来了，钱还在犹豫」；冬天却净流入 → 「人气冷清，钱却还在进」；冬天却暖 → 「价格倒还暖」。
 * mixed：null | 'money'（钱和季节方向相反）| 'temp'（温度和季节字面相反）。
 */
export function season(w, dw, p, flow5, temp, crash) {
  const info = seasonInfo(seasonKey(w, dw, p, crash));
  const x = info.key ? seasonWords(info.key, w, flow5, temp, crash) : null;
  info.crash = crashLevel(crash) ? (typeof crash === 'object' ? crash : { level: crashLevel(crash), name: CRASH_NAME[crashLevel(crash)] }) : null;
  info.mixed = x ? x.mixed : null;
  info.note = x && x.note ? x.note : '';
  if (x) {
    info.now = V(x.nowSharp, x.now);
    info.nowMild = x.now;
  }
  // 「下一步」= 历史概率；这 5 天钱在进还是在出，用对应的那一半表（样本够时）；暴跌中用暴跌那张表
  const nn = info.key ? seasonNext(info.key, flow5, crash) : null;
  if (nn) {
    info.next = V(nn.sharp, nn.mild);
    info.nextMild = nn.mild;
    info.odds = nn.odds;
  }
  if (info.key) info.text = `${info.emoji} ${info.name}：${info.now} → ${info.next}`;
  return info;
}

/** 某条序列第 i 天的季节（说法和那天的钱、温度对得上）。 */
export function seasonAt(series, i) {
  const s = series || {};
  const t = clampIdx(i, seriesLen(s));
  if (t < 0) return seasonInfo(null);
  const w = val(s.wind, t);
  const w5 = val(s.wind, Math.max(0, t - 5));
  return season(w, w != null && w5 != null ? w - w5 : 0, val(s.pres, t), sumBack(s.flow, t, 5), val(s.temp, t), crashAt(s, t));
}

/** 给 Planet.setOverlay('seasons', …) 用：{childId: 'spring'|'summer'|'autumn'|'winter'|null} */
export function seasonsOf(mapJson, childNodes, i) {
  const out = {};
  for (const c of kidsOf(mapJson, childNodes)) {
    const s = childSeries(mapJson, c);
    out[c.id] = s ? seasonAt(s, i).key : null;
  }
  return out;
}

// ───────────────────────────── 某一天的样子 ─────────────────────────────
/**
 * 从 SERIES（maps/<id>.json 里的一条）或 stocks/<T>.json 取出第 i 天的「now」，
 * 形状和 tree.json 的 now{} 一样（多了 wind5 / dw，季节要用；real = 序列自带的真钱或 null），可以直接喂给 describe()。
 */
export function nowAt(series, i) {
  const s = series;
  const n = seriesLen(s);
  const t = clampIdx(i, n);
  if (t < 0) return null;
  const px = s.idx || s.c;
  const wind = val(s.wind, t);
  const wind5 = val(s.wind, Math.max(0, t - 5));
  return {
    wind, wind5, dw: wind != null && wind5 != null ? r2(wind - wind5) : null,
    temp: val(s.temp, t), pres: val(s.pres, t),
    storm: val(s.storm, t), front: val(s.front, t) ?? 0,
    ret1: chg(px, t, 1), ret5: chg(px, t, 5), ret20: chg(px, t, 20),
    flow: val(s.flow, t), flow5: sumBack(s.flow, t, 5), dv20: avgBack(s.dv, t, 20), norm5: typical5(s.flow, t),
    crash: crashAt(s, t),
    // §23：序列自带的真钱（realflow.py --apply 写的 realFlow[]）→ describe / take 说方向时对得上
    real: realOfSeries(s, t),
  };
}
function dwOf(n) {
  if (isNum(n.dw)) return n.dw;
  if (isNum(n.wind) && isNum(n.wind5)) return n.wind - n.wind5;
  return null;
}

/**
 * 老风的一句话判词（只看数据能说出来的）：「挤成这样还往里冲，小心接的是最后一棒。」
 * 温和语气下给一句平实的总结。opts（可选）：{real}（app.realMoney 的结果）或 {id, i}（壳子 setRealOf 装过时）——
 * 真钱和估算对不上时，判词先说真钱（§23）。
 */
export function take(nowLike, opts) {
  const n = nowLike || {};
  const w = n.wind;
  if (!isNum(w) && !isNum(n.temp) && !isNum(n.pres)) return V('没数据，老风不乱说。', '暂时没有天气数据。');
  const p = isNum(n.pres) ? n.pres : 50;
  const t = isNum(n.temp) ? n.temp : 0;
  const ww = isNum(w) ? w : 0;
  const sk = seasonKey(w, dwOf(n), n.pres, n.crash);
  const f5 = n.flow5;
  const mx = windMix(ww, f5);
  // 暴跌闸门（§8 修订）：在暴跌的时候，先说跌了多少——风和拥挤度这时被逃命的成交量推高，不能当「热」读
  const cw = crashWords(n.crash);
  // §23：真钱和估算对不上（反着走 / 估不出方向 / 真钱几乎没动）：先说真钱，不替估算说方向；暴跌中就是「跌了多少 + 真钱」
  const rs = realSay(realOfLike(n, opts), f5);
  if (cw && rs) { const hd = crashHead(n.crash); return V(`${hd.sharp}，${rs.short}。`, `${hd.mild}，${rs.shortMild}。`); }
  if (cw) return V(`${cw.sharp}。`, `${cw.mild}。`);
  if (rs) return V(`${fit(rs.sharp, rs.short)}。`, `${fit(rs.mild, rs.shortMild)}。`);
  const unk = crashUnknown(n);
  if (unk && ((isNum(n.ret1) && n.ret1 <= CRASH.l2r1[0]) || (isNum(n.ret5) && n.ret5 <= CRASH.l2r5[0]))) {
    const d = isNum(n.ret1) && n.ret1 <= CRASH.l2r1[0] ? `一天跌了 ${pctAbs(n.ret1)}` : `5天跌了 ${pctAbs(n.ret5)}`;
    return V(`${d}，人多不等于热。`, `${d}，先看清是不是恐慌。`);
  }
  // 风向刚变：风是关注度 + 钱一起算的，钱没跟上时不说「钱杀回来」
  if (n.front > 0) {
    return isNum(f5) && f5 < -0.05 ? V('风向刚掉头，可只是人气回来，钱还没跟上。', '风向刚变：买卖的人回来了，钱还没净流入。')
      : V('风向刚掉头，钱杀回来了。', '风向刚变，钱开始流进来。');
  }
  if (n.front < 0) {
    return isNum(f5) && f5 > 0.05 ? V('风向刚翻脸，人气在散，钱倒还没走。', '风向刚变：人气在退，钱还在小幅流入。')
      : V('风向刚翻脸，钱开始撤。', '风向刚变，钱开始往外撤。');
  }
  if (isNum(n.storm) && n.storm >= 1.5) return V('大风暴，这不是散步是过山车。', '波动突然变得很大，坐稳。');
  if (mx === 'attn') {
    return p >= 85 ? V('挤成这样，看客比买家多，钱其实在走。', '很挤、关注度在升，但钱没真进来。')
      : V('光热闹不掏钱：关注度在升，钱没真进来。', '关注度在升，但钱没真进来。');
  }
  if (mx === 'quiet') {
    // 金额不小（≥ 它 0.2 天的成交）时别说「闷声」：是成交份额在缩，钱照样净进（why 卡也这么说）
    if (isNum(f5) && isNum(n.dv20) && n.dv20 > 0 && A(f5) / n.dv20 >= 0.2) {
      return V('成交份额在缩，可钱还是净进了不少。', '成交份额在缩，但钱还在净流入。');
    }
    return t >= 0.5 ? V('没人盯着，钱在闷声进货，价格还暖着。', '钱在进，但没人注意，价格也不差。')
      : V('没人盯着，钱在闷声进货。', '钱在进，但没人注意。');
  }
  // 5 天的钱跟平时差不多（知道「平时」时）：风大只是关注度在升，别说「往里冲」
  const usual = isNum(f5) && isNum(n.norm5) && n.norm5 > 0 && A(f5) / n.norm5 < 1.5;
  if (ww >= 0.5 && p >= 85) {
    return usual ? V('挤成这样，关注度还在升，钱倒跟平时差不多。', '很挤，关注度在升，钱跟平时差不多。')
      : V('挤成这样还往里冲，小心接的是最后一棒。', '钱还在进，但已经很挤了。');
  }
  if (ww > 1.5) return usual ? V('关注度猛升，钱倒跟平时差不多。', '关注度在升，钱跟平时差不多。') : V('钱跟疯了一样往里灌。', '钱在狂涌进来。');
  if (sk === 'spring' && !unk) {
    return isNum(f5) && f5 < 0 ? V('人气先回来了，钱还在犹豫。', '买卖的人变多，钱还没净流入。')
      : V('刚冒芽：钱开始摸进来，人还没到。', '钱刚开始进来，还不挤。');
  }
  if (ww < -1.5) return V('钱在夺门而逃。', '钱在大逃离。');
  if (ww <= -0.5 && p >= 65) return V('挤满了人，先跑的已经在撤。', '人多，但钱开始往外走。');
  if (ww <= -0.5 && t <= -1.5) return V('冷成冰窖，钱还在往外漏。', '又冷，钱还在流出。');
  if (ww >= 0.5) return V('有人在进货。', '钱在流进来。');
  if (ww <= -0.5) return V('钱在溜号，没人吭声。', '钱在悄悄溜走。');
  // 风不大，钱却进出得很猛（是平时的 1.5 倍以上；不知道「平时」就看是不是超过它 1 天的成交）：
  // 风是关注度 + 钱，两半抵消了（通信娱乐 5 天出 650 亿、风 0.0 就是这样）——先说钱
  const bigMoney = isNum(f5) && A(f5) >= 0.05 && (isNum(n.norm5) && n.norm5 > 0 ? A(f5) / n.norm5 >= 1.5
    : isNum(n.dv20) && n.dv20 > 0 && A(f5) / n.dv20 >= 1);
  if (bigMoney) return f5 < 0 ? V('风不大，可钱在大笔往外走。', '风不大，但钱流出比平时多很多。') : V('风不大，可钱在大笔往里搬。', '风不大，但钱流入比平时多很多。');
  if (p < 15) return V('没人要的洼地，连风都懒得吹。', '冷清洼地，没人关注。');
  if (t > 1.5) return V('涨得正欢，钱却没加码。', '涨得比平时快，钱没明显变化。');
  if (t < -1.5) return V('冷得结冰，没人理。', '跌得比平时多，没人关注。');
  if (p >= 85) return V('人挤人，踩踏风险写在脸上。', '人挤人，小心踩踏。');
  // 风不大：先说温度（下面那行「暖 / 凉」不能被一句「没什么好说的」压着），再说风暴、季节；
  // 「没什么好说的」只在常温、没风暴、没季节、没风向突变时才说（brief.py take_say 同一套）
  if (t >= 0.5) return V('风不大，价格倒是暖的。', '风平浪静，价格偏暖。');
  if (t <= -0.5) return V('风不大，价格在发凉。', '风平浪静，价格偏凉。');
  if (isNum(n.storm) && n.storm >= 0.8) return V('风不大，可晃得比平时凶。', '风平浪静，但波动变大了。');
  if (sk && !(unk && sk !== 'autumn' && sk !== 'winter')) {
    const S = season(w, dwOf(n), n.pres, f5, n.temp, n.crash);
    if (S.now) return S.now.replace(/[。]?$/, '。');
  }
  return V('不冷不热，今天没什么好说的。', '今天风平浪静。');
}
/** take() 那句说没说到温度（describe 用来决定温度那行别被挤掉） */
const TAKE_TEMP = /暖|凉|热|冷|烫|结冰|冰窖|涨得|跌得|价格/;

/**
 * 悬停卡片：≤ 4 行人话。nowLike = tree.json 的 now{}（或 nowAt() 的结果；带 dw / wind5 才认得出春天）。
 * opts（可选）：{real}（app.realMoney(id, i) 的结果）或 {id, i}（壳子 setRealOf 装过时）—— 真钱（不小）和估算反着走、
 * 估算在这里看不出方向、或真钱几乎没动时，判词和钱那行先说真钱（§23 修订：「钱在悄悄溜走」不许和「真钱净申购」挤一张卡）。
 * 犀利：老风的判词 → 钱 → 温度 → 季节（带拥挤度）/ 风暴。温和：刚发生的变化 → 钱 → 温度 → 风暴 → 拥挤 / 季节。
 * 估出来的（now.est）最后一行写清楚怎么估的。
 */
export function describe(nowLike, opts) {
  const n = nowLike || {};
  if (!isNum(n.wind) && !isNum(n.temp) && !isNum(n.pres)) return [V('没数据，老风不乱说', '暂时没有天气数据')];
  const est = estOf(n);
  const sharp = VOICE === 'sharp';
  // §23：真钱和这块地的估算对不上时（反着走 / 估不出方向 / 真钱几乎没动），说方向的那两行先说真钱
  const real = realOfLike(n, opts);
  const rs = realSay(real, n.flow5);
  // 候选行：[优先级（越小越先留下）, 显示顺序, 文字]。最多留 4 行，再按显示顺序排。
  const cand = [];
  const tk = sharp ? take(n, real ? { real } : null).replace(/。$/, '') : '';
  if (sharp) cand.push([0, 0, '💬 ' + tk]);
  else if (isNum(n.front) && n.front !== 0 && rs) {
    // 风向刚变是按成交估的；真钱对不上时不替它说「钱开始流进来」
    cand.push([0, 0, `🌀 风向刚变（按成交估），但${rs.shortMild}`]);
  } else if (isNum(n.front) && n.front !== 0) {
    const f5 = n.flow5;
    cand.push([0, 0, n.front > 0
      ? (isNum(f5) && f5 < -0.05 ? '🌀 风向刚变：买卖的人回来了，钱还没跟上' : '🌀 风向刚变：钱开始流进来')
      : (isNum(f5) && f5 > 0.05 ? '🌀 风向刚变：人气在退，钱还没走' : '🌀 风向刚变：钱开始往外撤')]);
  }
  if (isNum(n.wind) && rs) {
    // 真钱和估算对不上：犀利时判词已经先说了真钱，这行只报估算（说清是按成交估的）；温和时这行就是真钱那句。
    // 暴跌中判词说的是跌了多少，真钱放在这行
    const ft = isNum(n.flow5) && A(n.flow5) >= 0.05 ? `${flowText(n.flow5)}（${EST_BADGE}）` : '进出打平';
    const l = sharp ? `📊 按成交估：${ft}${rs.kind === 'blind' ? '，这里估不出方向' : ''}`
      : crashLevel(n.crash) ? `📊 按成交估：${ft}，${rs.shortMild}` : `💵 ${rs.mild}`;
    cand.push([1, 1, l]);
  } else if (isNum(n.wind)) {
    // 风和钱打架时直说（「关注度在升，但钱没真进来」），不让「钱在流进来」和「5天净流出」挤在一张卡上。
    // 钱数都是按成交估的（§2 / §14），标「估」；真钱由 realmoney.js 在卡片下面单独画。
    // 暴跌中（§8 修订）：风小只是恐慌成交和流出互相抵消，不说「风平浪静 / 悄悄溜走」（windWord 的 crash）
    const w = windWord(n.wind, n.flow5, n.crash);
    let l = `${w.emoji} ${w.text}`;
    if (isNum(n.flow5) && A(n.flow5) >= 0.05) {
      const ft = `${est ? flowText(n.flow5).replace(/(净流[入出]) /, '$1约 ') : flowText(n.flow5)}（${EST_BADGE}）`;
      if (w.mixed || w.crash) l += `：${ft}`;
      else if (w.level === 0) {
        // 风平浪静：配上尺度（是平时的几倍 / 约它几天的成交），「不算反常」才站得住；
        // 风小只是因为关注度和钱互相抵消、钱其实进出很猛时（通信娱乐 5 天出 650 亿）直说
        const ratio = isNum(n.norm5) && n.norm5 > 0 ? A(n.flow5) / n.norm5 : null;
        const days = isNum(n.dv20) && n.dv20 > 0 ? A(n.flow5) / n.dv20 : null;
        const sc = scaleText(n.flow5, n.dv20);
        const big = ratio != null ? ratio >= 1.5 : days != null && days >= 1;
        // 暴跌中（或看不到 σ 但跌破了闸门下限）：风小只是成交份额和钱互相抵消，别说「风平浪静 / 不算反常」
        const falling = crashLevel(n.crash) > 0 || crashUnknown(n);
        if (big) l = `💸 风不大，钱却进出很猛：${ft}${ratio != null ? `，是平时的 ${times(ratio)} 倍` : sc ? `，${sc}` : ''}`;
        else if (falling) l = `💸 ${ft}${sc ? `，${sc}` : ''}`;
        else l += `：${ft}${sc ? `，${sc}` : ''}，不算反常`;
      } else l += `，${ft}`;
    }
    cand.push([1, 1, l]);
  }
  if (isNum(n.temp)) {
    const t = tempWord(n.temp);
    let l = `${t.emoji} ${t.text}`;
    if (isNum(n.ret20)) {
      l += A(n.ret20) < 0.003 ? '，20天几乎没动' : `，20天${n.ret20 > 0 ? '涨' : '跌'}了 ${pctAbs(n.ret20)}`;
    }
    // 判词说到了温度（「价格倒是暖的」）：温度那行排在风暴前面，别被 4 行的上限挤掉
    cand.push([tk && TAKE_TEMP.test(tk) ? 2.5 : 4, 2, l]);
  }
  // 犀利的判词已经说了大风暴，就不再单列
  if (isNum(n.storm) && n.storm >= 0.8 && !(sharp && n.storm >= 1.5 && !n.front)) {
    cand.push([3, 3, `${stormWord(n.storm).emoji} ${n.storm >= 1.5 ? '大风暴' : '有风暴'}：波动是平时的 ${times(n.storm + 1)} 倍`]);
  }
  const sk0 = seasonKey(n.wind, dwOf(n), n.pres, n.crash);
  // 看不到 σ、价格又跌破下限：不替地图说「春 / 夏」（地图上的季节看得到整条序列，以它为准）
  const sk = crashUnknown(n) && sk0 !== 'autumn' && sk0 !== 'winter' ? null : sk0;
  if (sk) {
    // 季节说的是人气；和钱 / 温度字面相反时（冬天却在进钱、冬天却暖），把这层话说出来
    const S = season(n.wind, dwOf(n), n.pres, n.flow5, n.temp, n.crash);
    cand.push([2, 4, `${S.emoji} ${S.name}（${S.mixed && S.note ? S.note + '，' : ''}拥挤度 ${Math.round(n.pres)}）：${S.next}`]);
  } else if (isNum(n.pres)) {
    cand.push([2, 4, `${presWord(n.pres).emoji} ${presWord(n.pres).text}（拥挤度 ${Math.round(n.pres)}）`]);
  }
  const lines = cand.sort((a, b) => a[0] - b[0]).slice(0, 4).sort((a, b) => a[1] - b[1]).map((x) => x[2]);
  const out = lines.filter(Boolean).slice(0, 4);
  if (est) {
    const e = `${EST_BADGE} · ${est.basis || '按同行类比'}（${confWord(est.conf)}，等你补数据）`;
    if (out.length >= 4) out[3] = e; else out.push(e);
  }
  return out;
}

// ───────────────────────────── 注意力（DESIGN.md §6 + §8.2） ─────────────────────────────
/**
 * surprise 的每一项。公式（和 brief.py 一样）：
 *   0.45·|wind_t − wind_{t−5}| + 0.25·|wind_t| + 0.15·|temp_t − temp_{t−5}|
 *   + 0.6·|front_t| + 0.3·(storm_t ≥ 0.8) + 0.2·(pres_t ≥ 90 或 ≤ 10)
 * （§8.2 原来给 🌱 春 +0.5：实测春天并不比别的日子更能预告钱的下一步，这一项去掉了；spring 字段留着恒为 0。）
 * t−5 不足时用第 0 天；wind_t 没数据 → 0 分；wind_{t−5} 没数据 → 变化记 0；temp 任一没数据 → 0。
 */
export function surpriseParts(series, i) {
  const s = series || {};
  const n = seriesLen(s);
  const t = clampIdx(i, n);
  const P = {
    score: 0, shift: 0, level: 0, heat: 0, front: 0, storm: 0, crowd: 0, spring: 0,
    wind: null, wind5: null, dw: 0, temp: null, temp5: null, pres: null, stormV: null, frontV: 0, flow5: null, season: null, crash: null, i: t,
  };
  if (t < 0) return P;
  const j = Math.max(0, t - 5);
  const w = val(s.wind, t);
  if (w == null) return P;
  const w5 = val(s.wind, j);
  const tp = val(s.temp, t);
  const tp5 = val(s.temp, j);
  const f = val(s.front, t) ?? 0;
  const st = val(s.storm, t);
  const p = val(s.pres, t);
  const dw = w - (w5 == null ? w : w5);
  const cr = crashAt(s, t);
  const sk = seasonKey(w, dw, p, cr);
  Object.assign(P, { wind: w, wind5: w5, dw, temp: tp, temp5: tp5, pres: p, stormV: st, frontV: f, flow5: sumBack(s.flow, t, 5), season: sk, crash: cr });
  P.shift = 0.45 * A(dw);
  P.level = 0.25 * A(w);
  P.heat = tp != null && tp5 != null ? 0.15 * A(tp - tp5) : 0;
  P.front = 0.6 * A(f);
  P.storm = st != null && st >= 0.8 ? 0.3 : 0;
  P.crowd = p != null && (p >= 90 || p <= 10) ? 0.2 : 0;
  P.spring = 0; // 春天不再加分（见 seasonNext 上面的实测）
  P.score = P.shift + P.level + P.heat + P.front + P.storm + P.crowd + P.spring;
  return P;
}

/** 某个格子（SERIES）在第 i 天有多「不寻常」。 */
export function surprise(series, i) {
  return surpriseParts(series, i).score;
}

/** 由 surprise 的主导项，说出「为什么值得看」（短句，不带名字）。 */
function reasonOf(P, key = '') {
  const w = P.wind ?? 0;
  const w5 = P.wind5 ?? w;
  const f5 = P.flow5;
  if (P.crash) {
    // 暴跌闸门（§8 修订）：值得看的理由就是这一跌（和 brief.py why_sentence 一样）
    const d = crashDrop(P.crash);
    return { kind: 'storm', why: P.crash.level >= 2 ? V(`崩了：${d}`, `暴跌：${d}`) : V(`急跌：${d}`, `急跌：${d}`) };
  }
  // §23：真钱（不小）和估算反着走 / 估算在这里看不出方向 / 真钱几乎没动 → 理由先说真钱（和 brief.py why_sentence 一样），
  // 不然「还在失血」配上「A股 ETF 5天净申购 246亿」就是一张卡说两件相反的事
  const rs = realSay(P.real, f5);
  if (rs) {
    const kind = rs.sign > 0 ? 'inflow' : rs.sign < 0 ? 'outflow' : (isNum(f5) && f5 > 0 ? 'inflow' : 'outflow');
    return { kind, why: V(fit(rs.sharp, rs.short), fit(rs.mild, rs.shortMild)), real: rs.kind };
  }
  if (P.front) {
    // 风 = 关注度 + 钱：钱的方向对不上时，只说人气回来 / 散了
    if (P.frontV > 0) {
      return isNum(f5) && f5 < -0.05 ? { kind: 'front', why: V('风向刚掉头，可钱还没跟上', '风向刚变，买卖的人先回来了') }
        : { kind: 'front', why: V('风向刚掉头，钱杀回来了', '风向刚变，钱开始流进来') };
    }
    return isNum(f5) && f5 > 0.05 ? { kind: 'front', why: V('风向刚翻脸，人气散了，钱倒没走', '风向刚变，人气在退，钱还没走') }
      : { kind: 'front', why: V('风向刚翻脸，钱开始撤', '风向刚变，钱开始往外撤') };
  }
  const parts = [['shift', P.shift], ['level', P.level], ['heat', P.heat], ['storm', P.storm], ['crowd', P.crowd]]
    .sort((a, b) => b[1] - a[1]);
  const top = parts[0][0];
  let r;
  if (P.season === 'spring' && (top === 'shift' || top === 'level') && isNum(f5) && f5 > 0) {
    r = { kind: 'inflow', why: V('刚冒芽：钱开始摸进来，人还没到', '钱刚开始进来，还不挤') };
  } else if (top === 'shift') {
    const d = w - w5;
    if (w5 <= -0.5 && w >= 0.5) {
      r = isNum(f5) && f5 < 0 ? { kind: 'inflow', why: V('刚还没人理，突然热闹，钱还没跟上', '前几天还很冷清，现在买卖的人变多') }
        : { kind: 'inflow', why: V('刚还在失血，现在钱掉头猛灌', '前几天还在流出，现在钱回来了') };
    } else if (w5 >= 0.5 && w <= -0.5) {
      r = isNum(f5) && f5 > 0 ? { kind: 'outflow', why: V('刚还热闹，现在突然没人理了', '前几天还很热闹，现在买卖的人变少') }
        : { kind: 'outflow', why: V('刚还在吸钱，现在掉头就跑', '前几天还在进钱，现在开始撤') };
    }
    else if (d > 0 && w >= 0.5 && isNum(f5) && f5 <= 0) r = { kind: 'inflow', why: V('突然热闹，可钱没真进来', '关注度在升，但钱没真进来') };
    else if (d < 0 && w <= -0.5 && isNum(f5) && f5 >= 0) r = { kind: 'outflow', why: V('突然没人理了，钱倒还没走', '没人注意了，但钱还在进') };
    else if (d > 0) {
      r = w >= 1.5 ? { kind: 'inflow', why: V('钱跟疯了一样往里灌', '钱突然狂涌进来') }
        : w >= 0.5 ? { kind: 'inflow', why: V('有人开始进货', '钱开始流进来') }
          : w > -0.5 ? { kind: 'inflow', why: V('失血止住了', '流出停了，风小了') }
            : isNum(f5) && f5 > 0 ? { kind: 'inflow', why: V('人气还冷，不过钱开始进了', '钱在进，但没人注意') }
              : { kind: 'outflow', why: V('还在失血，但没那么猛了', '还在流出，但没那么猛了') };
    } else {
      r = w <= -1.5 ? { kind: 'outflow', why: V('钱在夺门而逃', '钱突然大逃离') }
        : w <= -0.5 ? { kind: 'outflow', why: V('钱开始溜号', '钱开始往外流') }
          : w < 0.5 ? { kind: 'outflow', why: V('进钱停了，热闹到头了', '进钱停了，风小了') }
            : isNum(f5) && f5 < 0 ? { kind: 'outflow', why: V('热闹还在，可钱已经不进了', '关注度还高，但钱没真进来') }
              : { kind: 'inflow', why: V('还在进钱，但没那么猛了', '还在进钱，但没那么猛了') };
    }
  } else if (top === 'level') {
    const agree = !isNum(f5) || (w >= 0 ? f5 > 0 : f5 < 0);
    r = {
      kind: w >= 0 ? 'inflow' : 'outflow',
      why: agree ? windSay(w, key)
        : (w >= 0 ? V('光热闹不掏钱，看客比买家多', '关注度在升，但钱没真进来') : V('没人盯着，钱在闷声进货', '钱在进，但没人注意')),
    };
  } else if (top === 'heat') {
    const t = P.temp ?? 0;
    const t5 = P.temp5 ?? t;
    r = t >= t5
      ? { kind: 'hot', why: V(t > 1.5 ? '突然烧起来了' : '一下子热起来了', t > 1.5 ? '突然变得很热' : '突然热起来了') }
      : { kind: 'cold', why: V(t < -1.5 ? '一下子凉透了' : '突然凉下来了', t < -1.5 ? '突然变得很冷' : '突然凉下来了') };
  } else if (top === 'storm') {
    const x = times((P.stormV ?? 0) + 1);
    r = { kind: 'storm', why: V(`起风暴了，波动是平时的 ${x} 倍`, `起风暴了，波动是平时的 ${x} 倍`) };
  } else {
    // 冷清 / 拥挤是主导项时，风还在明显地吹（钱在进 / 出、方向和钱数对得上）就别说「连风都懒得吹」——
    // 同一屏的主航道可能正说「钱在撤出这里」（大中华 › 台股）
    const out = w <= -0.5 && (!isNum(f5) || f5 < 0);
    const inn = w >= 0.5 && (!isNum(f5) || f5 > 0);
    r = (P.pres ?? 50) >= 90
      ? { kind: 'crowded', why: V('人挤人，踩踏风险写在脸上', '人挤人，小心踩踏') }
      : out ? { kind: 'quiet', why: V('没人理，钱还在往外走', '冷清洼地，钱还在流出') }
        : inn ? { kind: 'quiet', why: V('冷门里有钱摸进来了', '冷清洼地，开始有钱进来') }
          : { kind: 'quiet', why: V('没人要的洼地，连风都懒得吹', '冷清洼地，没人关注') };
  }
  // 第二个值得一提的小尾巴（只加一个、只加在一句话的短理由后面，不重复）
  const short = !r.why.includes('，') && hanLen(r.why) <= 10;
  if (short && r.kind !== 'storm' && P.storm) r.why += V('，还在刮风暴', '，还起了风暴');
  else if (short && r.kind !== 'crowded' && r.kind !== 'quiet' && P.crowd && !/挤|冷清|洼地/.test(r.why)) {
    r.why += (P.pres ?? 50) >= 90 ? V('，已经挤爆了', '，已经很挤') : V('，可没人理', '，但很冷清');
  }
  return r;
}

/** 同一屏里两个亮点理由一样时，后一个换成带数字的说法，免得读起来像复读。 */
function altWhy(P, r) {
  const f = P.flow5;
  if (P.crash || realSay(P.real, f)) return r.why;   // 暴跌 / 真钱的理由本来就带数字，别换成估算
  if (r.kind === 'front') return isNum(f) && A(f) >= 0.05 ? `${V('风向刚掉头', '风向刚变')}，${flowEst(f)}` : V('风向刚掉头，钱刚转身', '风向刚变，钱刚掉头');
  if (r.kind === 'inflow' || r.kind === 'outflow') return isNum(f) && A(f) >= 0.05 ? flowEst(f) : windWord(P.wind, f, P.crash).text;
  if (r.kind === 'hot' || r.kind === 'cold') return `温度从${tempWord(P.temp5).text}变成${tempWord(P.temp).text}`;
  if (r.kind === 'crowded' || r.kind === 'quiet') return `${presWord(P.pres).text}（拥挤度 ${Math.round(P.pres ?? 0)}）`;
  return r.why;
}

function childSeries(mapJson, c) {
  const ch = mapJson && mapJson.children;
  if (!ch || !c) return null;
  return ch[c.id] || (c.ticker && (ch['s:' + c.ticker] || ch[c.ticker])) || null;
}
function kidsOf(mapJson, childNodes) {
  if (Array.isArray(childNodes) && childNodes.length) return childNodes;
  const ch = (mapJson && mapJson.children) || {};
  return Object.keys(ch).map((id) => ({ id, name: id.replace(/^s:/, '') }));
}
const seasonLite = (k) => (k && SEASONS[k] ? { key: k, emoji: SEASONS[k].emoji, name: SEASONS[k].name } : null);

/**
 * 注意力预算 = 3：这块星球上第 i 天最该看的 ≤ k 个孩子（①②③ 的顺序就是返回的顺序）。
 * → [{id, name, n, score, why, kind, season, holding?}]，score 从高到低。kind ∈ front|inflow|outflow|storm|crowded|quiet|hot|cold
 * opts.pins：关注列表里的 id，若今天有风向突变/风暴，额外加 0.5 分。
 * opts.holdings（§20 我的持仓）：孩子 id，或 {id, name?, now?}（id = 这块星球上装着持仓的那个孩子；
 *   now = 持仓自己那天的 {wind, storm, front, flow5}，不给就看孩子自己的序列）。
 *   持仓那天有风向突变 / 风暴（≥0.8）/ |风| ≥ 1.5 → 一定占一个 ①②③（排最前，主人的钱优先），最多占 k−1 个。
 * opts.min：低于这个分数就不点亮（默认 0.3）——平静的日子宁可少亮几个。
 * opts.realOf(id)（可选；不给就看 setRealOf / 序列自带的 realFlow）：真钱和估算对不上时，理由先说真钱（§23）。
 */
export function attentionPicks(mapJson, childNodes, i, k = 3, opts = {}) {
  const pins = new Set(opts.pins || []);
  const min = isNum(opts.min) ? opts.min : 0.3;
  const hold = new Map();
  for (const h of opts.holdings || []) {
    const hid = typeof h === 'string' ? h : h && h.id;
    if (hid && !hold.has(hid)) hold.set(hid, typeof h === 'string' ? {} : h);
  }
  const rows = [];
  const forced = [];
  for (const c of kidsOf(mapJson, childNodes)) {
    const s = childSeries(mapJson, c);
    if (!s) continue;
    const P = surpriseParts(s, i);
    P.real = P.i >= 0 ? realFor(c.id, s, P.i, opts.realOf) : null;   // §23：理由要和真钱对得上
    let score = P.score;
    if (pins.has(c.id) && (P.front || P.storm)) score += 0.5;
    const h = hold.get(c.id);
    if (h) {
      const nw = h.now || { wind: P.wind, storm: P.stormV, front: P.frontV, flow5: P.flow5 };
      const loud = (isNum(nw.front) && nw.front !== 0) || (isNum(nw.storm) && nw.storm >= 0.8) || (isNum(nw.wind) && A(nw.wind) >= 1.5);
      if (loud) {
        const deep = h.name && h.name !== nm(c) ? h.name : '';
        const what = isNum(nw.front) && nw.front !== 0 ? (nw.front > 0 ? V('风向刚掉头', '风向刚变') : V('风向刚翻脸', '风向刚变'))
          : isNum(nw.storm) && nw.storm >= 0.8 ? V(`起风暴了，波动是平时的 ${times(nw.storm + 1)} 倍`, `起风暴了，波动是平时的 ${times(nw.storm + 1)} 倍`)
            : windSay(nw.wind, c.id, nw.flow5, h.now ? h.now.crash : P.crash);
        const r = reasonOf(P, c.id);
        forced.push({ id: c.id, name: nm(c), score, why: fit(`你的持仓${deep ? B(deep) : ''}：${what}`, `你的持仓：${what}`), kind: r.kind,
          season: seasonLite(P.season), holding: true, P });
        continue;
      }
    }
    if (!(score >= min)) continue;
    const r = reasonOf(P, c.id);
    rows.push({ id: c.id, name: nm(c), score, why: r.why, kind: r.kind, season: seasonLite(P.season), P });
  }
  rows.sort((a, b) => b.score - a.score);
  forced.sort((a, b) => b.score - a.score);
  const kk = Math.max(0, k);
  const lead = forced.slice(0, kk > 1 ? kk - 1 : kk);
  // 剩下的名额按分数来：没占到位的持仓也可以凭分数进来
  const rest = [...rows, ...forced.slice(lead.length).filter((r) => r.score >= min)].sort((a, b) => b.score - a.score);
  const all = [...lead, ...rest].slice(0, kk);
  const seen = new Set();
  return all.map(({ P, ...r }, j) => {
    let why = r.why;
    if (seen.has(why)) why = altWhy(P, r);
    seen.add(why);
    return { ...r, n: j + 1, why, score: r2(r.score) };
  });
}

// ───────────────────────────── 主航道（DESIGN.md §8.1，和 brief.py 同一套规矩） ─────────────────────────────
function rowOf(mapJson, c, i, realOf) {
  const s = childSeries(mapJson, c);
  if (!s) return null;
  const n = seriesLen(s);
  const t = clampIdx(i, n);
  if (t < 0) return null;
  const P = surpriseParts(s, t);
  const w = val(s.wind, t);
  if (w == null) return null;
  return {
    id: c.id, name: nm(c), emoji: c.emoji || '',
    wind: w, dw: P.dw, temp: val(s.temp, t), pres: val(s.pres, t), storm: val(s.storm, t), front: val(s.front, t) ?? 0,
    flow5: sumBack(s.flow, t, 5), dv20: avgBack(s.dv, t, 20), ret5: chg(s.idx, t, 5), ret20: chg(s.idx, t, 20), score: P.score, season: P.season, P,
    est: c.est === true || (c.now && c.now.est === true) ? (c.est === true ? c : c.now) : null,
    // §23 真钱（调用方的 realOf(id) → 壳子装的 setRealOf → 序列自带的 realFlow）：说方向时要对得上
    real: realFor(c.id, s, t, realOf),
  };
}
const flowsIn = (r) => r.wind > 0 && (!isNum(r.flow5) || r.flow5 > 0);
const flowsOut = (r) => r.wind < 0 && (!isNum(r.flow5) || r.flow5 < 0);
const amt = (r) => (isNum(r.flow5) ? A(r.flow5) : 0);

/** 这股风有多值得当主角：√(钱数，亿美元) ×（风 + ½·5天加速 + 风向刚变 0.6）。风 <0.3 或钱的方向不对 → 0。 */
function storyStrength(r, sign) {
  const w = r.wind;
  if (!isNum(w) || sign * w < 0.3) return 0;
  if (r.doubt) return 0; // 真钱（opts.realOf 给了）和估算方向相反 / 几乎没动：不当主角（和 brief.py 一样）
  if (sign > 0 && r.P && r.P.crash) return 0; // 暴跌闸门（§8 修订）：正在暴跌的地方不当「钱流进去」的那头（和 brief.py 一样）
  if (isNum(r.flow5) && !(sign * r.flow5 > 0)) return 0;
  const yi = isNum(r.flow5) ? A(r.flow5) / 100 : 1;
  const push = sign * w + 0.5 * Math.max(0, sign * (r.dw || 0)) + (sign * (r.front || 0) > 0 ? 0.6 : 0);
  return Math.sqrt(Math.max(yi, 0.01)) * push;
}
/** 钱从哪搬到哪：最强的流出 → 最强的流入；起点和终点的钱数要对得上（不拿 1000 万解释 300 亿）。 */
function mainStory(rows) {
  const rank = (sign) => rows.map((r) => [r, storyStrength(r, sign)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const ins = rank(1);
  const outs = rank(-1);
  let dst = ins.length ? ins[0][0] : null;
  let src = outs.length ? outs[0][0] : null;
  if (dst && src && amt(src) < 0.1 * amt(dst)) src = (outs.find(([r]) => amt(r) >= 0.1 * amt(dst)) || [null])[0];
  if (dst && src && amt(dst) < 0.1 * amt(src)) dst = (ins.find(([r]) => amt(r) >= 0.1 * amt(src)) || [null])[0];
  const sOf = (list, r) => (list.find((x) => x[0] === r) || [null, 0])[1];
  const sd = dst ? sOf(ins, dst) : 0;
  const ss = src ? sOf(outs, src) : 0;
  const dst2 = dst ? (ins.find(([r, s]) => r !== dst && s >= 0.6 * sd && amt(r) >= 0.25 * amt(dst)) || [null])[0] : null;
  return { src, dst, dst2, strength: dst && src ? Math.min(sd, ss) : Math.max(sd, ss), weak: false };
}

function channelSays(st, where) {
  const { src: a, dst: b, dst2 } = st;
  const lead = where ? `${where}的主航道` : '主航道';
  const to = b ? B(b.name) + (dst2 ? `和${B(dst2.name)}` : '') : '';
  if (a && b && st.single) {
    // 终点的钱几乎全是一只股票：不讲成板块轮动（和 brief.py channel_say 一样）
    const t = B(st.single.name);
    return {
      sharp: fit(`${where}钱扎堆${B(b.name)}——几乎全是${t}一只`, `${where}钱扎堆${t}一只`),
      mild: fit(`${where}流进${B(b.name)}的钱，几乎都进了${t}`, `${where}钱主要流进了${t}`),
    };
  }
  if (a && b) {
    if (st.weak) {
      return {
        sharp: `${lead}不太明显：钱勉强从${B(a.name)}挪向${to}`,
        mild: `${lead}不太明显：钱从${B(a.name)}慢慢流向${to}`,
      };
    }
    const verb = a.wind > -1.5 ? '撤出，奔向' : '夺门而出，冲进';
    return {
      sharp: fit(`${lead}：钱从${B(a.name)}${verb}${to}`, `${lead}：钱从${B(a.name)}${verb}${B(b.name)}`),
      mild: fit(`${lead}：钱从${B(a.name)}流向${to}`, `${lead}：钱从${B(a.name)}流向${B(b.name)}`),
    };
  }
  return { sharp: '', mild: '' };
}

/**
 * 今天的主航道：一根大箭头，从流出最强的孩子指向流入最强的孩子（§8.1）。
 * → {from, to, to2, fromName, toName, say, sayMild, saySharp, strength, weak} | null（平静、没有两头时）
 * 只有一头够强时，另一头用风向和钱数都对得上的最大那块，标 weak:true（箭头画细一点）。
 * opts.where：「AI 算力里」之类，用在句子开头；不传就说「主航道」。
 * opts.realOf(id) → {flow5}|null：有真钱（ETF 申赎…）时传进来，和 brief.py 一样排除被真钱打脸的格子。
 */
/** 真钱（§23）和估算对不上吗：方向相反（真钱 ≥ 50 万美元）或真钱几乎没动（和 brief.py real_against / real_flat 一样）。 */
function realDoubt(r, est) {
  if (!r || !isNum(r.flow5) || !isNum(est) || A(est) < 0.05) return false;
  // realmoney.js（同一批 ETF / 同几天比过的）：估算看不出方向 / 真钱（不小）和这块地的估算反着 / 真钱几乎没动 → 不当主角
  // （和 brief.py real_off 一样：realSay 有话要说，就是估算靠不住）
  if ('realMat' in r) return !!realSay(r, est);
  const a = A(r.flow5);
  const flat = A(est) >= 50 && (a < 0.5 || (a < 10 && a < 0.02 * A(est)));
  return flat || (a >= 0.5 && (r.flow5 > 0) !== (est > 0));
}

export function mainChannel(mapJson, childNodes, i, opts = {}) {
  const rows = kidsOf(mapJson, childNodes).map((c) => rowOf(mapJson, c, i, opts && opts.realOf)).filter(Boolean);
  if (rows.length < 2) return null;
  // 真钱（opts.realOf(id) → 壳子的 app.realMoney；没给就看 setRealOf / 序列自带的）：估算被真钱打脸的格子不当主航道的两头
  for (const r of rows) r.doubt = realDoubt(r.real, r.flow5);
  const st = mainStory(rows);
  // 先找钱数对得上的（≥ 10%）；没有就退一步（≥ 2%），标 weak「不太明显」（和 brief.py channel_for 一样）
  if (st.dst && !st.src) {
    for (const frac of [0.1, 0.02]) {
      const xs = rows.filter((r) => r !== st.dst && !r.doubt && r.wind < 0 && isNum(r.flow5) && r.flow5 < 0 && amt(r) >= frac * amt(st.dst));
      if (xs.length) { st.src = xs.sort((a, b) => amt(b) - amt(a))[0]; st.weak = true; break; }
    }
  } else if (st.src && !st.dst) {
    for (const frac of [0.1, 0.02]) {
      const xs = rows.filter((r) => r !== st.src && !r.doubt && !(r.P && r.P.crash) && r.wind > 0 && isNum(r.flow5) && r.flow5 > 0 && amt(r) >= frac * amt(st.src));
      if (xs.length) { st.dst = xs.sort((a, b) => amt(b) - amt(a))[0]; st.weak = true; break; }
    }
  }
  if (!st.src || !st.dst) return null;
  // opts.singles（brief.singles，只对最新一天有效）：终点的钱几乎全是一只股票 → 不叫轮动，标 weak
  const one = opts.singles && st.dst ? opts.singles[st.dst.id] : null;
  if (one && one.name) { st.single = one; st.weak = true; }
  const s = channelSays(st, opts.where || '');
  return {
    from: st.src.id, to: st.dst.id, to2: st.dst2 ? st.dst2.id : null,
    fromName: st.src.name, toName: st.dst.name,
    strength: r2(st.strength), weak: st.weak, ...(st.single ? { single: st.single } : {}),
    say: V(s.sharp, s.mild), saySharp: s.sharp, sayMild: s.mild,
  };
}

// ───────────────────────────── 一块星球的天气 ─────────────────────────────
function item(r, say) {
  return {
    id: r.id, name: r.name, emoji: r.emoji,
    wind: r2(r.wind), temp: r.temp == null ? null : r2(r.temp), pres: r.pres == null ? null : Math.round(r.pres),
    storm: r.storm == null ? null : r2(r.storm), front: r.front,
    flow5: r.flow5 == null ? null : Math.round(r.flow5 * 10) / 10, score: r2(r.score), season: seasonLite(r.season),
    ...(r.est ? { est: true, basis: r.est.basis || null } : {}),
    say: r.est ? fit(`${say}（${EST_BADGE}）`, say) : say,
  };
}

function inSay(r) {
  const p = r.pres;
  if (r.front > 0) return V('风向刚掉头，钱刚杀进来', '风向刚变，钱刚开始进来');
  const rs = realSay(r.real, r.flow5);
  if (rs) return V(rs.short, rs.shortMild);
  const base = isNum(r.flow5) && r.flow5 >= 0.05 ? flowEst(r.flow5) : windWord(r.wind, r.flow5, r.P && r.P.crash).text;
  if (isNum(p) && p >= 85) return base + V(vary(r.id, ['，已经挤爆了', '，最后一棒谁接？']), '，已经很挤');
  if (r.season === 'spring') return base + V('，刚冒芽', '，还不挤');
  if (isNum(r.storm) && r.storm >= 0.8) return base + V('，边进钱边晃', '，波动也大');
  if (isNum(r.ret5) && r.ret5 <= -0.02) return base + V(`，价格却跌了 ${pctAbs(r.ret5)}`, `，价格跌了 ${pctAbs(r.ret5)}`);
  return base;
}
function outSay(r) {
  if (r.front < 0) return V('风向刚翻脸，钱开始撤', '风向刚变，钱开始往外撤');
  const rs = realSay(r.real, r.flow5);
  if (rs) return V(rs.short, rs.shortMild);
  if (r.P && r.P.crash) return `${V(crashWords(r.P.crash).sharp, crashWords(r.P.crash).mild)}${isNum(r.flow5) && r.flow5 <= -0.05 ? `，${flowEst(r.flow5)}` : ''}`;
  const base = isNum(r.flow5) && r.flow5 <= -0.05 ? flowEst(r.flow5) : windWord(r.wind, r.flow5, r.P && r.P.crash).text;
  if (isNum(r.storm) && r.storm >= 0.8) return base + V('，边跑边晃', '，波动也大');
  if (isNum(r.temp) && r.temp <= -1.5) return base + V('，冷成冰窖', '，很冷');
  if (isNum(r.ret5) && r.ret5 >= 0.02) return base + V(`，价格还涨了 ${pctAbs(r.ret5)}`, `，价格涨了 ${pctAbs(r.ret5)}`);
  return base;
}
function crowdSay(r) {
  const p = Math.round(r.pres);
  const mx = windMix(r.wind, r.flow5);
  if (mx === 'quiet') return V(`挤满了人（拥挤度 ${p}），人气在退，钱倒还没走`, `人挤人（拥挤度 ${p}），人气在退，钱还在进`);
  if (mx === 'attn') return V(`挤爆了（拥挤度 ${p}），看客多，钱已经不进了`, `人挤人（拥挤度 ${p}），但钱没真进来`);
  if (r.wind <= -0.5) return V(`挤满了人（拥挤度 ${p}），先跑的已经在撤`, `人挤人（拥挤度 ${p}），钱开始往外走`);
  if (r.wind >= 1) return V(`挤爆了（拥挤度 ${p}），还在往里塞`, `人挤人（拥挤度 ${p}），钱还在进`);
  return V(`人挤人（拥挤度 ${p}），踩踏风险写在脸上`, `人挤人（拥挤度 ${p}），小心踩踏`);
}
function quietSay(r) {
  const p = Math.round(r.pres);
  const mx = windMix(r.wind, r.flow5);
  // 「冷得像冰窖」只在温度也冷时说（不然和「暖」打架）
  const icy = !isNum(r.temp) || r.temp <= 0;
  if (mx === 'attn') return V(`冷门里人气回来了（拥挤度 ${p}），钱还没跟上`, `冷清洼地（拥挤度 ${p}），关注度在升，钱还没进来`);
  if (mx === 'quiet') {
    const big = isNum(r.flow5) && isNum(r.dv20) && r.dv20 > 0 && A(r.flow5) / r.dv20 >= 0.2;
    return big ? V(`没人理（拥挤度 ${p}），成交份额在缩，钱却还在净进`, `冷清洼地（拥挤度 ${p}），但钱在净流入`)
      : V(`没人理（拥挤度 ${p}），钱倒在悄悄进`, `冷清洼地（拥挤度 ${p}），但钱在进`);
  }
  if (r.wind >= 0.5) return V(`冷门里有钱摸进来了（拥挤度 ${p}）`, `冷清洼地（拥挤度 ${p}），开始有钱进来`);
  if (r.wind <= -0.5) return icy ? V(`冷得像冰窖（拥挤度 ${p}），钱还在跑`, `冷清洼地（拥挤度 ${p}），钱还在走`)
    : V(`没人理（拥挤度 ${p}），钱还在跑`, `冷清洼地（拥挤度 ${p}），钱还在走`);
  return V(`没人要（拥挤度 ${p}），连风都懒得吹`, `冷清洼地（拥挤度 ${p}），没人关注`);
}

/** 一句话标题：钱从哪搬到哪（和这块星球上的主航道箭头是同一件事）+ 一个最值得提的尾巴。 */
function planetHeadline(rows, node, st, singles) {
  if (!rows.length) return V(`${nm(node)}还没有天气数据，老风不乱说。`, `${nm(node)}暂时没有天气数据。`);
  const { src, dst, dst2 } = st;
  const key = (node && node.id) || '';
  const to = dst ? B(dst.name) + (dst2 ? `和${B(dst2.name)}` : '') : '';
  const one = singles && dst ? singles[dst.id] : null;
  let head;
  if (dst && one && one.name) {
    // 一只股票撑起来的：直说是那一只，不说「钱从 X 跑去 Y」
    head = V(`钱扎堆${B(dst.name)}，几乎全是${B(one.name)}一只`, `钱主要流进${B(dst.name)}，几乎都是${B(one.name)}`);
  } else if (src && dst) {
    head = V(vary(key + dst.id, [`${B(src.name)}在失血，钱冲进${to}`, `钱从${B(src.name)}跑去${to}`]), `钱正从${B(src.name)}搬到${to}`);
  } else if (dst) head = V(`钱在往${to}${dst.wind > 1.5 ? '狂灌' : '灌'}`, `钱在${dst.wind > 1.5 ? '狂涌进' : '流进'}${to}`);
  else if (src) head = V(`钱在${src.wind < -1.5 ? '夺门逃离' : '撤出'}${B(src.name)}`, `钱在${src.wind < -1.5 ? '逃离' : '悄悄离开'}${B(src.name)}`);
  else head = V('这里风平浪静', '今天风平浪静');
  const calm = !src && !dst;
  const named = new Set([src, dst, dst2].filter(Boolean).map((r) => r.id));
  const free = (r) => r && !named.has(r.id);
  const bySurprise = [...rows].sort((a, b) => b.score - a.score);
  const withT = rows.filter((r) => isNum(r.temp));
  const but = calm ? '但' : '';

  const tails = [];
  const front = bySurprise.find((r) => r.front !== 0);
  if (front && ((dst && front.id === dst.id && front.front > 0) || (src && front.id === src.id && front.front < 0))) {
    tails.push(V('风向是刚变的', '风向是刚变的'));
  } else if (free(front)) tails.push(`${but}${B(front.name)}${V(front.front > 0 ? '风向刚掉头' : '风向刚翻脸', '风向刚变')}`);
  const bigStorm = bySurprise.find((r) => isNum(r.storm) && r.storm >= 1.5 && free(r));
  if (bigStorm) tails.push(`${but}${B(bigStorm.name)}${V('在刮台风', '起了大风暴')}`);
  const spring = bySurprise.find((r) => r.season === 'spring' && free(r) && isNum(r.flow5) && r.flow5 > 0);
  if (spring) tails.push(`${but}${B(spring.name)}${V('刚冒芽', '像春天：钱刚开始进来')}`);
  const hot = [...withT].sort((a, b) => b.temp - a.temp)[0];
  if (hot && hot.temp >= 0.5) {
    if (dst && hot.id === dst.id) tails.push(dst2 ? `其中${B(hot.name)}${V('烧得最旺', '最热')}` : V('那里也烧得最旺', '那里也最热'));
    else if (dst2 && hot.id === dst2.id) tails.push(`其中${B(hot.name)}${V('烧得最旺', '最热')}`);
    else if (src && hot.id === src.id) tails.push(`${V('可', '不过')}${B(hot.name)}${V('还是最烫', '依然最热')}`);
    else tails.push(calm && hot.temp < 1 ? `${B(hot.name)}稍微热一点` : `${B(hot.name)}${V('烧得最旺', '最热')}`);
  }
  const packed = rows.filter((r) => isNum(r.pres) && r.pres >= 90).sort((a, b) => b.pres - a.pres)[0];
  if (packed) tails.push(dst && packed.id === dst.id && !dst2 ? V('那里已经挤爆', '那里已经人挤人') : `${B(packed.name)}${V('已经挤爆', '已经人挤人')}`);
  const cold = [...withT].sort((a, b) => a.temp - b.temp)[0];
  if (cold && cold.temp <= -1 && free(cold)) tails.push(`${B(cold.name)}${V('冷成冰窖', '最冷')}`);
  if (calm) tails.push(V('没什么好说的', '没什么大动静'));
  for (const t of tails) {
    const sentence = `${head}，${t}。`;
    if (hanLen(sentence) <= MAX_HAN) return sentence;
  }
  return head + '。';
}

/**
 * 「这里的天气」：任何一个星球（region 节点）在第 i 天的天气预报。
 * → {headline, channel, spotlight, inflow, outflow, springs, crowded, quiet, storms, fronts}
 * 列表项：{id, name, emoji, wind, temp, pres, storm, front, flow5, score, season, say}；每个列表最多 8 个，已排序。
 * opts 原样交给 attentionPicks（{pins, holdings, min}）：持仓今天有动静就占一个 ①②③。
 * opts.singles（= brief.singles，只在最新一天传）：{regionId: {id, name, share}}——这块地的钱几乎全是一只股票时，
 *   标题和主航道直说是那一只，不讲成「钱从 X 跑去 Y」的板块轮动。opts.realOf 交给 mainChannel（见那里）。
 * headline 和 channel 说的是同一件事（地图上的主航道箭头）。
 */
export function regionWeather(mapJson, node, childNodes, i, opts = {}) {
  const rows = kidsOf(mapJson, childNodes).map((c) => rowOf(mapJson, c, i, opts && opts.realOf)).filter(Boolean);
  const singles = opts && opts.singles ? opts.singles : null;   // brief.singles（只在最新一天传）
  // 标题和主航道讲同一件事：被真钱打脸的格子在标题里也不当主角（和 mainChannel 一样）
  for (const r of rows) r.doubt = realDoubt(r.real, r.flow5);
  const st = rows.length ? mainStory(rows) : { src: null, dst: null, dst2: null };
  const headline = planetHeadline(rows, node, st, singles);
  const where = node && node.id && node.id !== 'world' ? `${nm(node)}里` : '';
  const channel = mainChannel(mapJson, childNodes, i, { where, singles, realOf: opts && opts.realOf });
  // 「钱在涌进来」只放方向和钱数都对得上的（风 ≥ 0.5 且 5 天净流入为正）
  const inflow = rows.filter((r) => r.wind >= 0.5 && flowsIn(r)).sort((a, b) => b.wind - a.wind).slice(0, 8).map((r) => item(r, inSay(r)));
  const outflow = rows.filter((r) => r.wind <= -0.5 && flowsOut(r)).sort((a, b) => a.wind - b.wind).slice(0, 8).map((r) => item(r, outSay(r)));
  const springs = rows.filter((r) => r.season === 'spring').sort((a, b) => b.score - a.score).slice(0, 8)
    .map((r) => item(r, isNum(r.flow5) && r.flow5 > 0
      ? V(`刚冒芽：${flowEst(r.flow5)}，人还不多`, `钱刚开始进来：${flowEst(r.flow5)}，还不挤`)
      : V('人气先回来了，钱还在犹豫', '买卖的人变多，钱还没净流入')));
  const crowded = rows.filter((r) => isNum(r.pres) && r.pres >= 85).sort((a, b) => b.pres - a.pres).slice(0, 8).map((r) => item(r, crowdSay(r)));
  const quiet = rows.filter((r) => isNum(r.pres) && r.pres < 15).sort((a, b) => a.pres - b.pres).slice(0, 8).map((r) => item(r, quietSay(r)));
  const storms = rows.filter((r) => isNum(r.storm) && r.storm >= 0.8).sort((a, b) => b.storm - a.storm).slice(0, 8)
    .map((r) => item(r, `${r.storm >= 1.5 ? '⛈️ 大风暴' : '🌧️ 有风暴'}：波动是平时的 ${times(r.storm + 1)} 倍${V(r.storm >= 1.5 ? '，过山车' : '，坐稳', '')}`));
  const fronts = rows.filter((r) => r.front !== 0).sort((a, b) => b.score - a.score).slice(0, 8)
    .map((r) => ({
      // 风向是关注度 + 钱一起算的：钱的方向对不上时，只说人气
      ...item(r, r.front > 0
        ? (isNum(r.flow5) && r.flow5 > 0.05 ? V(`钱杀回来了：${flowEst(r.flow5)}`, frontWord(1).text)
          : isNum(r.flow5) && r.flow5 < -0.05 ? V(`人气先回来了，钱还没跟上：${flowEst(r.flow5)}`, '风向刚变：买卖的人回来了，钱还没跟上')
            : V('前几天还在撤，人气先回来了', frontWord(1).text))
        : (isNum(r.flow5) && r.flow5 < -0.05 ? V(`翻脸就跑：${flowEst(r.flow5)}`, frontWord(-1).text)
          : isNum(r.flow5) && r.flow5 > 0.05 ? V(`人气在散，钱倒还没走：${flowEst(r.flow5)}`, '风向刚变：人气在退，钱还没走')
            : V('前几天还在进，现在掉头就跑', frontWord(-1).text))),
      dir: r.front > 0 ? 1 : -1,
    }));
  const spotlight = attentionPicks(mapJson, childNodes, i, 3, opts || {});
  // story：标题里说的那两头（壳子的主航道只有一头时也用它，标题和地图上的圈才对得上）
  const story = { src: st.src ? st.src.id : null, dst: st.dst ? st.dst.id : null, dst2: st.dst2 ? st.dst2.id : null,
    srcWind: st.src ? st.src.wind : null, dstWind: st.dst ? st.dst.wind : null };
  return { headline, channel, story, spotlight, inflow, outflow, springs, crowded, quiet, storms, fronts };
}

// ───────────────────────────── 单只股票的天气播报员 ─────────────────────────────
function stockFacts(st, t) {
  const f5 = sumBack(st.flow, t, 5);
  const norm = typical5(st.flow, t);
  const w = val(st.wind, t);
  const w5 = val(st.wind, Math.max(0, t - 5));
  return {
    t,
    p1: chg(st.c, t, 1), p5: chg(st.c, t, 5), p20: chg(st.c, t, 20),
    f5, f20: sumBack(st.flow, t, 20), norm,
    ratio: norm && f5 != null ? A(f5) / norm : null,
    w, dw: w != null && w5 != null ? w - w5 : 0, tp: val(st.temp, t), pr: val(st.pres, t), pr5: val(st.pres, t - 5),
    s: val(st.storm, t), fr: val(st.front, t) ?? 0,
    cr: crashAt(st, t),
    // §23：ETF 自己的真钱（stocks/<T>.json realFlow[]，发行商每日份额 × 净值，已对齐到交易日），和它自己的估算比
    real: realOfSeries(st, t),
  };
}

/** "过去5天约 3.2亿美元净流入（估），是平时的 2 倍"（钱数是按成交估的：§2 / §14） */
function flowClause(F) {
  const f = F.f5;
  if (f == null) return null;
  if (A(f) < 0.05 || (F.norm && A(f) < 0.15 * F.norm)) return '过去5天钱进出差不多，基本打平';
  let s = `过去5天约 ${money(A(f))}${f > 0 ? '净流入' : '净流出'}（${EST_BADGE}）`;
  if (F.ratio != null) {
    if (F.ratio >= 1.5) s += `，是平时的 ${times(F.ratio)} 倍`;
    else if (F.ratio <= 0.5) s += '，力度比平时小';
    else s += '，跟平时差不多';
  }
  return s;
}
/** "价格涨了 6.0%" */
function priceClause(p, lead = '价格') {
  if (p == null) return null;
  if (A(p) < 0.003) return `${lead}几乎没动`;
  return `${lead}${p > 0 ? '涨' : '跌'}了 ${pctAbs(p)}`;
}
function tempTail(tp, p5) {
  if (!isNum(tp)) return '';
  // 温度看的是这个月（跟它自己过去一年比）；和 5 天涨跌方向相反时要说清楚，不然听着矛盾
  if (isNum(p5) && p5 > 0.003 && tp <= -0.5) return '，但这个月整体还偏凉';
  if (isNum(p5) && p5 < -0.003 && tp >= 0.5) return '，但这个月整体还偏热';
  if (tp > 1.5) return V('，烫手', '，热得发烫');
  if (tp >= 0.5) return '，有点热';
  if (tp <= -1.5) return V('，冷到结冰', '，冷得结冰');
  if (tp <= -0.5) return '，有点凉';
  return '';
}
/** 没有特别故事时，老风对这只股票的一句判词（不带数字）。 */
function stockTake(F) {
  const w = F.w ?? 0;
  const p = F.pr ?? 50;
  const sk = seasonKey(F.w, F.dw, F.pr, F.cr);
  // 风和钱打架：先把这件事说清楚（关注度 vs 真金白银）
  const mx = windMix(w, F.f5);
  if (mx === 'attn') return p >= 85 ? '挤成这样，看客比买家多，钱其实在走。' : '光热闹不掏钱：关注度在升，钱没真进来。';
  if (mx === 'quiet') return isNum(F.tp) && F.tp >= 0.5 ? '没人盯着，钱在闷声进货，价格还暖着。' : '没人盯着，钱在闷声进货。';
  // 风大，可 5 天的钱跟平时差不多（< 1.5 倍）：那只是关注度在升，别说「还往里冲」（第二句会说「跟平时差不多」）
  const usual = F.ratio != null && F.ratio < 1.5;
  if (w >= 0.5 && p >= 85) return usual ? '挤成这样，关注度还在升，钱倒跟平时差不多。' : '挤成这样还往里冲的，小心是来接最后一棒的。';
  if (w > 1.5) return usual ? '关注度猛升，钱倒跟平时差不多。' : '钱跟疯了一样往里灌。';
  if (sk === 'spring' && (F.f5 ?? 0) > 0) return '刚冒芽：钱开始摸进来，人还没到。';
  if (w >= 0.5 && p < 35) return '有人在进货，人还没到。';
  if (w >= 0.5) return '有人在进货，还不算挤。';
  if (w < -1.5) return '钱在夺门而逃。';
  if (w <= -0.5 && p >= 65) return '挤满了人，先跑的已经在撤。';
  if (w <= -0.5) return '钱在溜号，没人吭声。';
  if (p < 15) return '冷清得不像它自己，没人搭理。';
  if (isNum(F.tp) && F.tp > 1.5) return '涨得正欢，钱却没加码。';
  if (isNum(F.tp) && F.tp < -1.5) return '冷得结冰，没人理它。';
  if (isNum(F.tp) && F.tp >= 0.5) return '风不大，价格倒是暖的。';
  if (isNum(F.tp) && F.tp <= -0.5) return '风不大，价格在发凉。';
  if (isNum(F.s) && F.s >= 0.8) return '风不大，可晃得比平时凶。';
  if (sk) {
    const S = season(F.w, F.dw, F.pr, F.f5, F.tp, F.cr);
    if (S.now) return S.nowMild && VOICE === 'mild' ? `${S.nowMild}。` : `${S.now}。`;
  }
  return '不冷不热，今天没什么好说的。';
}

/**
 * 天气播报员：2–3 句像主持人一样的话。第一句是今天最值得说的事（犀利时是老风的判词）。
 * stockJson = stocks/<T>.json；i = 日期下标（不传 = 最后一天）。数据是估出来的（est）时，最后一句说清楚。
 */
export function caster(stockJson, i) {
  const st = stockJson;
  const n = len(st && st.c);
  if (!n) return [V('这只还没有天气数据，老风不乱说。', '这只股票暂时没有天气数据。'), '换一只看看吧。'];
  const t = clampIdx(i, n);
  const F = stockFacts(st, t);
  const w = F.w ?? 0;
  const ratio = F.ratio ?? 0;
  const out = [];
  let usedStorm = false;
  let usedTemp = false;
  let usedQuiet = false;
  const flowC = flowClause(F);
  const withPrice = (lead) => `${flowC}${F.p5 != null ? '；' + priceClause(F.p5, lead) : ''}。`;

  const divIn = F.p5 != null && F.p5 <= -0.02 && F.f5 > 0 && (w >= 0.3 || ratio >= 0.8);
  const divOut = F.p5 != null && F.p5 >= 0.02 && F.f5 < 0 && (w <= -0.3 || ratio >= 0.8);
  const divIn20 = F.p20 != null && F.p20 <= -0.05 && F.f20 > 0 && w >= 0 && F.f5 >= 0;
  const divOut20 = F.p20 != null && F.p20 >= 0.05 && F.f20 < 0 && w <= 0 && F.f5 <= 0;

  const cw = crashWords(F.cr);
  // §23：这只 ETF 的真钱和按成交估的对不上（估不出方向 / 反着走 / 真钱几乎没动）：不替估算说方向。
  // 真钱的金额和日期由个股页自己的「实」那行说（这里不重复，免得两个日期打架）
  const rs = realSay(F.real, F.f5);
  if (cw && rs) {
    // 暴跌 + 真钱对不上：先说跌了多少，再说真钱（不说「夺门」——真钱这时在说另一件事）；估算只当成交热度
    const hd = crashHead(F.cr);
    const verb = F.real.flow5 >= 0 ? '净申购' : '净赎回';
    out.push(V(`${hd.sharp}，${rs.kind === 'flat' ? '真钱却几乎没动' : rs.kind === 'blind' ? '按成交估看不出方向，以真钱为准' : `真钱却在${verb}`}。`,
      `${hd.mild}，${rs.kind === 'flat' ? '但真钱几乎没动' : rs.kind === 'blind' ? '这只按成交估看不出方向' : `真钱却在${verb}`}。`));
    if (flowC) out.push(`按成交估：${flowC.replace('过去5天约 ', '5天约 ')}。`);
  } else if (cw) {
    // 暴跌闸门（§8 修订）：先说跌了多少；这时按成交估的「钱在进」多半是恐慌换手，不说「有人接货」
    out.push(V(`${cw.sharp}。`, `${cw.mild}。`));
    if (flowC) out.push(`${flowC}${F.p5 != null && F.cr.by === 'r1' ? '；' + priceClause(F.p5, '价格5天') : ''}。`);
  } else if (rs) {
    const side = (F.f5 ?? 0) > 0 ? '进' : '出';
    const verb = F.real.flow5 >= 0 ? '净申购' : '净赎回';
    if (rs.kind === 'blind') out.push(V('按成交估看不出这只的方向（净值天天涨，估算永远说在进），以真钱为准。', '这只按成交估看不出方向，以真钱为准。'));
    else if (rs.kind === 'flat') out.push(V(`按成交估是钱在${side}，真钱几乎没动，别当真。`, `按成交估是钱在${side}，但真钱几乎没动。`));
    else if (rs.kind === 'clash') out.push(V(`按成交估是钱在${side}，真钱唱反调：在${verb}，以真钱为准。`, `按成交估是钱在${side}，真钱却在${verb}。`));
    else out.push(V(`按成交估是钱在${side}，真钱却在${verb}，以真钱为准。`, `按成交估是钱在${side}，真钱却在${verb}。`));
    if (flowC) out.push(`按成交估：${flowC.replace('过去5天约 ', '5天约 ')}${rs.kind === 'blind' && !flowC.includes('打平') ? '，只能当成交热度看' : ''}。`);
  } else if (divIn) {
    out.push(V('价格在跌，钱却在底下偷偷接货。', '价格在跌，但钱在偷偷进来。'));
    out.push(`${flowC}；价格却跌了 ${pctAbs(F.p5)}。`);
  } else if (divOut) {
    out.push(V('价格还在涨，钱已经从后门溜了。', '价格在涨，但钱在悄悄溜走。'));
    out.push(`${flowC}；价格却涨了 ${pctAbs(F.p5)}。`);
  } else if (F.fr !== 0) {
    // 风向是关注度 + 钱一起算的：钱没跟上（或还没走）时照实说
    const f5 = F.f5;
    if (F.fr > 0) {
      out.push(isNum(f5) && f5 < -0.05 ? V('风向刚掉头，可只是人气回来，钱还没跟上。', '🌀 风向刚变：买卖的人回来了，钱还没净流入。')
        : V('风向刚掉头，钱杀回来了。', '🌀 风向刚变：钱开始流进来了。'));
    } else {
      out.push(isNum(f5) && f5 > 0.05 ? V('风向刚翻脸，人气在散，钱倒还没走。', '🌀 风向刚变：人气在退，钱还在小幅流入。')
        : V('风向刚翻脸，钱开始撤，别挡门口。', '🌀 风向刚变：钱开始往外撤了。'));
    }
    if (flowC) out.push(withPrice('价格'));
  } else if (F.s != null && F.s >= 1.5) {
    usedStorm = true;
    out.push(V(`⛈️ 大风暴：波动是平时的 ${times(F.s + 1)} 倍，这是过山车。`, `⛈️ 起大风暴了：波动是平时的 ${times(F.s + 1)} 倍。`));
    if (flowC) out.push(withPrice('价格'));
  } else if (divIn20) {
    out.push(V('跌了一个月，钱却一直在进，有人在慢慢吸筹。', '这个月价格在跌，钱却一直在进。'));
    out.push(`20天累计净流入 ${money(F.f20)}，价格跌了 ${pctAbs(F.p20)}。`);
  } else if (divOut20) {
    out.push(V('涨了一个月，钱却一直在走，越涨越心虚。', '这个月价格在涨，钱却一直在走。'));
    out.push(`20天累计净流出 ${money(-F.f20)}，价格涨了 ${pctAbs(F.p20)}。`);
  } else if (VOICE === 'sharp') {
    // 犀利：先给判词（观点），再给一整句数字（事实）
    out.push(stockTake(F));
    usedQuiet = /冷清/.test(out[0]);
    const pc = priceClause(F.p5, '价格5天');
    if (flowC && pc) out.push(`${flowC.replace('过去5天约 ', '5天约 ')}；${pc}${tempTail(F.tp, F.p5)}。`);
    else if (flowC) out.push(`${flowC}。`);
    else if (pc) out.push(`${pc}${tempTail(F.tp, F.p5)}。`);
    usedTemp = true;
  } else {
    // 温和：先说钱，再说价格和温度；风和钱方向一致时，用天气词开场（「钱在流进来：…」）；
    // 打架时开场说实话（「关注度在升，但钱没真进来：…」）
    const lead = A(w) >= 0.5 && F.f5 != null && A(F.f5) >= 0.05 && flowC && !flowC.includes('打平');
    if (flowC) out.push(lead ? `${windWord(w, F.f5, F.cr).text}：${flowC.replace('过去5天约 ', '5天约 ')}。` : `${flowC}。`);
    const pc = priceClause(F.p5, '价格5天');
    if (pc) {
      out.push(`${pc}${tempTail(F.tp, F.p5)}。`);
      usedTemp = true;
    }
  }

  // 第三句：拥挤 / 风暴 / 季节 / 冷热；数据是估出来的就说清楚
  let third = null;
  const p = F.pr;
  const p5 = F.pr5;
  const sk = seasonKey(F.w, F.dw, F.pr, F.cr);
  if (p != null && p >= 85) third = V(`人挤人了（拥挤度 ${Math.round(p)}），踩踏风险写在脸上。`, `人挤人了（拥挤度 ${Math.round(p)}），小心踩踏。`);
  else if (p != null && p < 15 && !usedQuiet) third = V(`冷清得像被忘了（拥挤度 ${Math.round(p)}）。`, `比它平时冷清得多（拥挤度 ${Math.round(p)}）。`);
  else if (!usedStorm && F.s != null && F.s >= 0.8) third = V(`🌧️ 波动是平时的 ${times(F.s + 1)} 倍，坐稳。`, `🌧️ 最近波动变大，是平时的 ${times(F.s + 1)} 倍。`);
  else if (p != null && p5 != null && p >= 65 && p - p5 >= 10) third = V(`人开始多了（拥挤度 ${Math.round(p)}），热闹要来了。`, `人开始多了（拥挤度 ${Math.round(p)}）。`);
  else if (p != null && p5 != null && p <= 35 && p5 - p >= 10) third = V(`人在散场（拥挤度 ${Math.round(p)}）。`, `人在散去（拥挤度 ${Math.round(p)}）。`);
  else if (sk) {
    const S = season(F.w, F.dw, F.pr, F.f5, F.tp, F.cr);
    third = S.mixed && S.note ? `${S.emoji} ${S.name}（${S.note}）：${S.next}。` : `${S.emoji} ${S.name}：${S.next}。`;
  } else if (!usedTemp && isNum(F.tp) && F.tp > 1.5) third = V('🔥 烫手，比它平时跑得快多了。', '🔥 热得发烫，比它平时跑得快多了。');
  else if (!usedTemp && isNum(F.tp) && F.tp < -1.5) third = V('🧊 冷到结冰，比它平时慢多了。', '🧊 冷得结冰，比它平时慢多了。');
  const estN = estimateNote(st);
  if (estN) third = estN;
  if (third) out.push(third);

  if (out.length < 2) {
    const ww = windWord(F.w, F.f5, F.cr);
    const tw = tempWord(F.tp);
    out.push(ww.na ? V('数据还不够，老风先憋着。', '数据还不够多，先观察几天。') : `现在：${ww.text}，温度${tw.text}。`);
  }
  if (out.length < 2) out.push('先观察几天再说。');
  return out.slice(0, 3);
}

// ───────────────────────────── 自你上次来以来 ─────────────────────────────
/**
 * 从 iFrom 到 iTo，风向变得最多的 ≤ k 个孩子。→ [{id, name, from, to, say, score}]
 */
export function changesSince(mapJson, childNodes, iFrom, iTo, k = 3) {
  const rows = [];
  for (const c of kidsOf(mapJson, childNodes)) {
    const s = childSeries(mapJson, c);
    if (!s) continue;
    const n = seriesLen(s);
    const a = val(s.wind, clampIdx(iFrom, n));
    const tTo = clampIdx(iTo, n);
    const b = val(s.wind, tTo);
    if (a == null || b == null) continue;
    const flip = (a <= -0.5 && b >= 0.5) || (a >= 0.5 && b <= -0.5);
    const score = A(b - a) + (flip ? 1 : 0);
    if (score < 0.8) continue;
    let say;
    const name = B(nm(c));
    // 现在的风和这 5 天的钱打架时（风是关注度 + 钱），只说人气，不说钱进钱出
    const mx = windMix(b, sumBack(s.flow, tTo, 5));
    if (mx === 'attn') say = V(`${name}突然热闹了，钱还没跟上`, `${name}关注度在升，钱还没进来`);
    else if (mx === 'quiet') say = V(`${name}没人理了，钱倒还在进`, `${name}人气在退，钱还在进`);
    else if (a <= -0.5 && b >= 0.5) say = V(`${name}翻身了，钱杀回来`, `${name}掉头进钱`);
    else if (a >= 0.5 && b <= -0.5) say = V(`${name}翻脸了，钱在撤`, `${name}开始撤钱`);
    else if (b > a) say = b >= 0.5 ? V(`${name}进钱更猛了`, `${name}进钱更猛了`) : V(`${name}止血了`, `${name}不再流出`);
    else say = b <= -0.5 ? V(`${name}失血更猛了`, `${name}流出更猛了`) : V(`${name}的热闹散了`, `${name}不再进钱`);
    rows.push({ id: c.id, name: nm(c), from: r2(a), to: r2(b), score, say });
  }
  rows.sort((x, y) => y.score - x.score);
  return rows.slice(0, k).map(({ score, ...r }) => ({ ...r, score: r2(score) }));
}

/** "自你上次来（10月21日）以来：【存储】掉头进钱，【黄金】开始撤钱。" */
export function sinceLastVisit(mapJson, childNodes, iFrom, iTo, lastDate) {
  if (!(isNum(iFrom) && isNum(iTo)) || iTo <= iFrom) return null;
  const items = changesSince(mapJson, childNodes, iFrom, iTo, 3);
  const head = `自你上次来（${dateCN(lastDate)}）以来：`;
  if (!items.length) return head + V('没什么大变化，你没错过什么。', '没什么大变化。');
  return head + items.map((x) => x.say).join('，') + '。';
}

// ───────────────────────────── 今日一猜（DESIGN.md §8.3） ─────────────────────────────
export const GUESS_QUESTION = '接下来 5 个交易日，钱最可能流进哪一个？';

/** 确定性的「随机」：同一个星球同一天，候选永远一样（刷新不会变）。 */
function seeded(seed) {
  let x = hash(seed) || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * 「🎯 今日一猜」的 3–4 个候选：一个 🌱 春、一个 ☀️夏 / 🍂秋、一个「现在的风口」（够多孩子时）、一个随机对手。
 * → [{id, name, emoji, role, season:{key,emoji,name}|null, hint}]，顺序已打乱（确定性）。
 * role ∈ spring|summer|autumn|crowded|leader|wild（crowded = 没有夏/秋时拿最挤的顶上）。孩子不到 2 个 → []。opts.k 最多几个（默认 4，最少 3）。
 */
export function guessCandidates(mapJson, childNodes, i, opts = {}) {
  const kmax = Math.max(3, Math.min(4, opts.k || 4));
  const rows = kidsOf(mapJson, childNodes).map((c) => rowOf(mapJson, c, i)).filter(Boolean);
  if (rows.length < 2) return [];
  const t = rows[0].P.i;
  const rnd = seeded(`${(mapJson && mapJson.id) || ''}:${t}`);
  const chosen = [];
  const roles = new Map();
  const take1 = (r, role) => { if (r && !chosen.includes(r)) { chosen.push(r); roles.set(r.id, role); } };
  const free = () => rows.filter((r) => !chosen.includes(r));
  // 1. 🌱 春：没有就找「最像春天的」（风在变大、还不挤）
  const springs = rows.filter((r) => r.season === 'spring').sort((a, b) => b.score - a.score);
  take1(springs[0] || rows.filter((r) => r.wind > 0 && r.dw > 0 && (r.pres ?? 50) < 65).sort((a, b) => b.dw - a.dw)[0], 'spring');
  // 2. ☀️ 夏 / 🍂 秋：没有就拿最挤的
  const hot = free().filter((r) => r.season === 'summer' || r.season === 'autumn').sort((a, b) => b.score - a.score)[0]
    || free().filter((r) => isNum(r.pres)).sort((a, b) => b.pres - a.pres)[0];
  if (hot) take1(hot, hot.season === 'autumn' ? 'autumn' : hot.season === 'summer' ? 'summer' : 'crowded');
  // 3. 现在的风口（最明显的那个答案——练的就是别被它骗，或者别错过它）
  if (rows.length >= 5 && chosen.length < kmax - 1) {
    const lead = free().filter((r) => r.wind >= 0.5).sort((a, b) => b.wind - a.wind)[0];
    if (lead) take1(lead, 'leader');
  }
  // 4. 随机对手（一个；凑不够 3 个就多补几个）
  const target = Math.min(rows.length, Math.max(3, Math.min(kmax, chosen.length + 1)));
  while (chosen.length < target && free().length) {
    const pool = free();
    take1(pool[Math.floor(rnd() * pool.length)], 'wild');
  }
  // 打乱顺序（确定性），免得「第一个总是春天」
  const order = chosen.map((r) => [r, rnd()]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  return order.map((r) => {
    const S = season(r.wind, r.dw, r.pres, r.flow5, r.temp, r.P ? r.P.crash : null);
    const cr = r.P ? r.P.crash : null;
    const w = windWord(r.wind, r.flow5, cr);
    const hint = S.key ? `${S.emoji} ${S.now}` : `${w.emoji} ${windSay(r.wind, r.id, r.flow5, cr)}`;
    return { id: r.id, name: r.name, emoji: r.emoji, role: roles.get(r.id), season: seasonLite(r.season), hint };
  });
}

/**
 * 揭晓：iFrom（猜的那天）→ iTo（默认 iFrom+5）之间，候选里谁「吸钱」最多。
 * 分数 = ½·(这几天净流入 ÷ 它平时 5 天的进出量，夹在 ±3) + ½·(风的变化)。这样大块头和小角落能公平比。
 * guess = {candidates:[id | {id,name}], pick: id, …}（localStorage 里存的那个）。
 * → {ready, days, winner:{id,name}, pick:{id,name}, hit, rows:[{id,name,flow,windGain,score,rank}], say, sayMild, saySharp}
 */
export function scoreGuess(mapJson, guess, iFrom, iTo, childNodes) {
  const g = guess || {};
  const cands = (Array.isArray(g.candidates) ? g.candidates : []).map((c) => (typeof c === 'string' ? { id: c } : c)).filter((c) => c && c.id);
  const pickId = typeof g.pick === 'string' ? g.pick : g.pick && g.pick.id;
  const names = new Map();
  for (const c of kidsOf(mapJson, childNodes)) names.set(c.id, nm(c));
  for (const c of cands) if (c.name) names.set(c.id, c.name);
  const nameOf = (id) => names.get(id) || String(id || '').replace(/^s:/, '');
  const empty = { ready: false, days: 0, winner: null, pick: pickId ? { id: pickId, name: nameOf(pickId) } : null, hit: false, rows: [] };
  const ch = (mapJson && mapJson.children) || {};
  const series = cands.map((c) => ch[c.id] || ch['s:' + c.id] || null);
  const n = Math.max(0, ...series.map(seriesLen));
  if (!cands.length || !n) {
    const s = { sharp: '没法揭晓：这块星球的数据不见了。', mild: '暂时没法揭晓：缺少数据。' };
    return { ...empty, say: V(s.sharp, s.mild), saySharp: s.sharp, sayMild: s.mild };
  }
  const a = clampIdx(iFrom, n);
  const b = clampIdx(isNum(iTo) ? iTo : a + 5, n);
  const days = Math.max(0, b - a);
  const rows = cands.map((c, k) => {
    const s = series[k] || {};
    let flow = 0;
    for (let j = a + 1; j <= b; j++) if (isNum(s.flow && s.flow[j])) flow += s.flow[j];
    const w0 = val(s.wind, a);
    const w1 = val(s.wind, b);
    const gain = w0 != null && w1 != null ? w1 - w0 : 0;
    const norm = typical5(s.flow, a);
    const flowN = norm ? Math.max(-3, Math.min(3, (flow / norm) * (days ? 5 / days : 1))) : Math.sign(flow);
    return { id: c.id, name: nameOf(c.id), flow: Math.round(flow * 10) / 10, windGain: r2(gain), score: r2(0.5 * flowN + 0.5 * gain) };
  });
  const sorted = [...rows].sort((x, y) => y.score - x.score);
  sorted.forEach((r, k) => { r.rank = k + 1; });
  const win = sorted[0];
  const mine = rows.find((r) => r.id === pickId) || null;
  const hit = !!(mine && win && mine.id === win.id);
  const facts = (r) => `${days}天${r.flow >= 0 ? '净流入' : '净流出'} ${money(A(r.flow))}（${EST_BADGE}）`;
  let sharp;
  let mild;
  if (days < 5) {
    const left = 5 - days;
    sharp = `还没到揭晓的时候：再等 ${left} 个交易日。`;
    mild = `还要等 ${left} 个交易日才揭晓。`;
  } else if (!mine) {
    sharp = `答案是${B(win.name)}：${facts(win)}。你这次没押。`;
    mild = `答案是${B(win.name)}：${facts(win)}。`;
  } else if (hit) {
    const allOut = rows.every((r) => r.flow < 0);
    // the score mixes money with wind gain: a winner can still be net outflow — then don't call it 吸金
    sharp = allOut ? fit(`✅ 猜中了：都在漏钱，${B(win.name)}漏得最少（${facts(win)}）。`, `✅ 猜中了：${B(win.name)}漏得最少。`)
      : win.flow < 0 ? fit(`✅ 猜中了：${B(win.name)}风转得最猛，虽然${facts(win)}。`, `✅ 猜中了：${B(win.name)}风转得最猛。`)
      : fit(`✅ 直觉在线：${B(win.name)}果然吸金，${facts(win)}。`, `✅ 直觉在线：${B(win.name)}果然吸金。`);
    mild = fit(`✅ 猜中了：${B(win.name)}${facts(win)}${win.windGain >= 0.3 ? '，风也变大了' : ''}。`, `✅ 猜中了：${B(win.name)}。`);
  } else {
    sharp = win.flow < 0
      ? fit(`❌ 没押中：风转得最猛的是${B(win.name)}（${facts(win)}），你押的${B(mine.name)}${facts(mine)}。`,
        `❌ 没押中：风转得最猛的是${B(win.name)}，不是${B(mine.name)}。`)
      : fit(`❌ 被市场打脸：钱去了${B(win.name)}（${facts(win)}），你押的${B(mine.name)}${facts(mine)}。`,
        `❌ 被市场打脸：钱去了${B(win.name)}，不是${B(mine.name)}。`);
    mild = fit(`❌ 这次是${B(win.name)}：${facts(win)}；你选的${B(mine.name)}${facts(mine)}。`,
      `❌ 这次是${B(win.name)}，不是${B(mine.name)}。`);
  }
  return {
    ready: days >= 5, days,
    winner: { id: win.id, name: win.name }, pick: mine ? { id: mine.id, name: mine.name } : empty.pick,
    hit: days >= 5 && hit, rows: sorted, say: V(sharp, mild), saySharp: sharp, sayMild: mild,
  };
}

/**
 * 直觉命中率：records 按时间顺序，每条有 hit（或 result.hit）；没揭晓的（hit 为 null/undefined）不算。
 * → {hits, total, rate, streak, best, text:"直觉命中率 7/12 (58%)", say}
 */
export function guessStats(records) {
  const xs = (Array.isArray(records) ? records : [])
    .map((r) => (r && typeof r.hit === 'boolean' ? r.hit : r && r.result && typeof r.result.hit === 'boolean' ? r.result.hit : null))
    .filter((h) => h !== null);
  const total = xs.length;
  const hits = xs.filter(Boolean).length;
  let streak = 0;
  for (let k = xs.length - 1; k >= 0 && xs[k]; k--) streak++;
  let best = 0;
  let run = 0;
  for (const h of xs) { run = h ? run + 1 : 0; best = Math.max(best, run); }
  const rate = total ? hits / total : 0;
  const text = total ? `直觉命中率 ${hits}/${total} (${Math.round(rate * 100)}%)` : '还没猜过';
  let say;
  if (total < 5) say = V('样本太少，先多猜几次再说。', '再多猜几次，命中率才有意义。');
  else if (rate >= 0.65) say = V('比抛硬币强多了，直觉在长。', '命中率不错，直觉在变准。');
  else if (rate >= 0.5) say = V('略胜抛硬币，继续练。', '比随便猜好一点，继续练习。');
  else say = V('还不如抛硬币——正常，多用回放练习。', '暂时不如随便猜，多用回放练习。');
  if (streak >= 3) say = V(`连中 ${streak} 次，手感来了。`, `已经连续猜中 ${streak} 次。`);
  return { hits, total, rate: r2(rate), streak, best, text, say };
}

// ───────────────────────────── 数据是哪一刻的（盘中 / 收盘）、水位（流动性） ─────────────────────────────
/** "2026-10-27T10:30:08-04:00" → {et:"10:30", min: 开盘后几分钟, local:"01:30"（悉尼）} */
function clockOf(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const et = `${m[1]}:${m[2]}`;
  const min = Math.max(0, Math.min(390, (+m[1] * 60 + +m[2]) - (9 * 60 + 30)));
  let local = '';
  try {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    }
  } catch (e) { local = ''; }
  return { et, min, local };
}
/**
 * 数据是哪一刻的：meta.json（{asOf, partial:{date, fetchedAt}|null}）→
 * {partial, date, text:"10月27日 盘中（截至美东 10:30，悉尼 01:30）"|"10月27日 收盘", at, local, frac, say, sayMild}
 * 盘中的那根日线只算了一部分成交（风、钱数会偏小），所以盘中时一定要说「盘中」。
 */
export function asOfLabel(meta) {
  const m = meta || {};
  const date = m.asOf || (Array.isArray(m.dates) && m.dates.length ? m.dates[m.dates.length - 1] : '');
  const pt = m.partial && typeof m.partial === 'object' ? m.partial : null;
  if (pt && (!pt.date || !date || pt.date === date)) {
    // pipeline 已按美股盘中成交量的 U 形曲线把今天折算成全天（meta.intraday {fraction, scaled, etTime, localTime, method}）：
    // 用它的进度和说法，不再用「开盘几分钟 / 390」自己算，也不说「只算了一部分」（和 brief.py partial_info 一样）
    const it0 = m.intraday && typeof m.intraday === 'object' ? m.intraday : null;
    const it = it0 && (!it0.date || !pt.date || it0.date === pt.date) ? it0 : null;
    const c = clockOf(pt.fetchedAt || pt.at);
    const at = (it && it.etTime) || (c ? c.et : '');
    const local = (it && it.localTime) || (c ? c.local : '');
    const when = at ? `截至美东 ${at}${local ? `，悉尼 ${local}` : ''}` : '还没收盘';
    let frac;
    let sharp;
    let mild;
    if (it && it.scaled) {
      frac = isNum(it.fraction) ? r2(it.fraction) : null;
      const typ = frac != null ? `平常这时约成交了全天的 ${Math.round(frac * 100)}%，` : '';
      sharp = fit(`盘中快照：${typ}今天的数已按全天折算。`, '盘中快照：今天的数已按全天折算，收盘后换成真数。');
      mild = '盘中：今天的成交额已按全天折算，收盘后换成真数。';
    } else {
      const fr = it && isNum(it.fraction) ? it.fraction : c ? c.min / 390 : null;
      frac = fr != null ? r2(fr) : null;
      const bit = fr == null ? '今天的数只算了一部分' : fr < 0.35 ? '今天的数只算了一小截' : fr < 0.7 ? '今天的数只算了一半左右' : '今天的数快齐了';
      sharp = `盘中快照：${bit}，收盘后换成真数。`;
      mild = '还在盘中，今天的数字只算了一部分，收盘后换成真数。';
    }
    return { partial: true, date: pt.date || date, text: `${dateCN(pt.date || date)} 盘中（${when}）`, short: '盘中',
      at, local, frac, scaled: !!(it && it.scaled), method: (it && it.method) || '', say: V(sharp, mild), saySharp: sharp, sayMild: mild };
  }
  // meta.filled: Yahoo 还没给这天的正式收盘价，pipeline/fetch.py 用 60 分钟线的最后一根补上（和 brief.py filled_on 一样标「补」）
  const fill = (Array.isArray(m.filled) ? m.filled : []).find((f) => f && f.date === date);
  return { partial: false, filled: !!fill, date, text: date ? `${dateCN(date)} 收盘${fill ? '（补）' : ''}` : '', short: '收盘',
    at: '', local: '', frac: 1, say: '', saySharp: '', sayMild: '' };
}

/** 净流动性 4 周变化 → 百万美元（liquidity.json chg.netliq.d20，单位看 units.netliq，默认 $B）。 */
function liqD20(liq) {
  const d = liq && liq.chg && liq.chg.netliq ? liq.chg.netliq.d20 : null;
  if (!isNum(d)) return null;
  const unit = String((liq.units && liq.units.netliq) || '$B');
  return d * (unit.includes('M') ? 1 : unit.includes('T') ? 1e6 : 1000);
}

/**
 * 水位（流动性，§23）：liquidity.json 的 {regime:{state:'放水'|'收水'|'平稳', since, prev, fresh}, pressure:-3..3, chg.netliq.d20}
 * → {state, emoji, since, fresh, pressure, netliq4w, say, sayMild, saySharp, detail?, detailMild?} | null。和 brief.py liquidity_say 同一套话。
 * opts.asOf：今天的日期（liquidity.json 没写 fresh 时，用它判断「刚变」：since 在 7 天内）。
 */
export function liquiditySay(liq, opts = {}) {
  const g = liq && (liq.regime && typeof liq.regime === 'object' ? liq.regime : liq);
  const state = g && g.state;
  if (!['放水', '收水', '平稳'].includes(state)) return null;
  const since = typeof g.since === 'string' ? g.since.slice(0, 10) : '';
  const pr = isNum(liq.pressure) ? liq.pressure : isNum(g.pressure) ? g.pressure : null;
  let fresh = false;
  if (typeof g.fresh === 'boolean') fresh = g.fresh;
  else if (since && opts.asOf) {
    const d = (Date.parse(String(opts.asOf).slice(0, 10)) - Date.parse(since)) / 864e5;
    fresh = isNum(d) && d >= 0 && d <= 7;
  }
  const from = since ? `（${dateCN(since)}起）` : '';
  const hard = isNum(pr) && A(pr) >= 2;
  const d = liqD20(liq);
  const amt = isNum(d) && A(d) >= 0.05 ? money(A(d)) : '';
  let sharp;
  let mild;
  if (state === '放水') {
    sharp = amt && d > 0 ? `美联储在放水${from}，水位四周涨了 ${amt}${hard ? '，放得很猛' : ''}。` : `美联储在放水${from}，${hard ? '放得很猛，' : ''}池子里的水在变多。`;
    mild = amt && d > 0 ? `美联储在放水${from}，市场里的钱四周多了 ${amt}。` : `美联储在放水${from}，市场里的钱在变多。`;
  } else if (state === '收水') {
    sharp = amt && d < 0 ? `美联储在收水${from}，水位四周少了 ${amt}${hard ? '，收得很狠' : ''}，别太浪。` : `美联储在收水${from}，${hard ? '收得很狠，' : ''}水位在降，别太浪。`;
    mild = amt && d < 0 ? `美联储在收水${from}，市场里的钱四周少了 ${amt}。` : `美联储在收水${from}，市场里的钱在变少。`;
  } else if (amt) {
    const way = d < 0 ? '少' : '多';
    sharp = `水位平稳，四周只${way}了 ${amt}，美联储没在放水也没收水。`;
    mild = `流动性平稳，四周只${way}了 ${amt}。`;
  } else {
    sharp = '美联储按兵不动，水位平稳。';
    mild = '流动性平稳：美联储没在放水，也没在收水。';
  }
  if (fresh && state !== '平稳') { sharp = '风向大变：' + sharp; mild = '水位刚转向：' + mild; }
  else if (fresh && (g.prev === '放水' || g.prev === '收水')) { sharp = `${g.prev}刚停：` + sharp; mild = `${g.prev}刚停：` + mild; }
  const out = { state, emoji: state === '放水' ? '💧' : state === '收水' ? '🏜️' : '〰️', since, fresh, pressure: pr,
    netliq4w: isNum(d) ? Math.round(d * 10) / 10 : null, say: V(sharp, mild), saySharp: sharp, sayMild: mild };
  const ds = g.say || liq.say;
  const dm = g.sayMild || liq.sayMild;
  const clean = (x) => typeof x === 'string' && x && !/NaN|undefined|null|Infinity/.test(x) && x.split(/[。！？；]/).every((p) => hanLen(p) <= MAX_HAN);
  if (clean(ds) && clean(dm)) { out.detail = V(ds, dm); out.detailSharp = ds; out.detailMild = dm; }
  return out;
}

// ───────────────────────────── 新手教程 & 词汇表 ─────────────────────────────
export const tutorialCards = [
  {
    key: 'map', emoji: '🌍', title: '先看箭头，再看 ①②③', demo: 'spotlight',
    body: '大箭头是今天的主航道：钱从哪搬到哪。①②③是今天最该看的三处，其余先别管。',
  },
  {
    key: 'temp', emoji: '🌡️', title: '颜色 = 温度', demo: 'temp',
    body: '越偏朱红越热：涨得比平时快、比邻居快。越偏靛蓝越冷。米白色就是正常，不用管。',
  },
  {
    key: 'wind', emoji: '💨', title: '风线 = 钱在流动，波纹 = 风向刚变', demo: 'wind',
    body: '细细的风线从钱流走的地方，吹向钱流进的地方。一圈圈波纹：钱刚掉头，最值得看一眼。',
  },
  {
    key: 'pres', emoji: '🚇', title: '挤 / 空，下雨 = 风暴', demo: 'pres',
    body: '「挤」是人挤人，追进去容易被踩；「空」是冷清洼地。下雨是波动突然变大，坐稳。',
  },
  {
    key: 'season', emoji: '🌱', title: '四季：钱走到哪一步了', demo: 'season',
    body: '🌱春：钱刚进来还不挤。☀️夏：热又挤。🍂秋：钱从挤处撤。❄️冬：没人管。季节说的是现在，不是预言；下一步看卡片上的历史概率。',
  },
  {
    key: 'zoom', emoji: '🚀', title: '飞进去，猜一猜，听老风说', demo: 'zoom',
    body: '点任何一块地就飞进去，Esc 飞回来。每天猜一次钱去哪，练直觉。老风嘴毒；钱数是按成交估的，真钱单独标「真钱」。',
  },
];

function term(name, emoji, short, text) {
  return Object.freeze({ name, emoji, short, text, toString() { return this.text; } });
}

/** 词汇表（悬停提示用）。每个词条：{name, emoji, short, text}；直接当字符串用就是 text。 */
export const TERMS = Object.freeze({
  wind: term('风', '💨', '钱的流向', '一半看关注度（成交份额），一半看净流入；两者打架时会直接说（跟它自己过去一年比）。'),
  attn: term('关注度', '👀', '大家有多在意它', '它在上一级板块的成交里占几成：份额变大就是关注度在升（跟它自己过去一年比）。'),
  temp: term('温度', '🌡️', '热不热', '最近涨得比平时快、比邻居快就热，慢就冷（跟它自己过去一年比）。'),
  pres: term('拥挤度', '🚇', '人多不多', '0 到 100，越高越挤：涨得急、买的人突然变多（跟它自己过去一年比）。'),
  storm: term('风暴', '⛈️', '波动突然变大', '最近几天上下晃得比平时厉害很多（跟它自己过去一年比）。'),
  front: term('风向刚变', '🌀', '钱刚掉头', '前几天钱还往一个方向流，现在反过来了（跟它自己过去一年比）。'),
  season: term('季节', '🌱', '钱的轮回走到哪一步', '春：钱刚进来还不挤；夏：热又挤；秋：钱从挤处撤；冬：没人管。看的是风、风的变化和拥挤度。说的是现在，不是预言；「历史上 5 天后」是过去一年实测的概率。'),
  channel: term('主航道', '➜', '今天钱搬家的主路线', '从钱流出最猛的地方，指向钱流进最猛的地方。每个画面只有一根。'),
  flow: term('净流入', '💰', '进来的钱减去出去的钱', '估算值（标「估」）：收盘靠近当天高点、涨得多，就算钱在进来；反过来算钱在走。有 ETF 申赎这类真实进出的地方，单独标「真钱」。'),
  real: term('真钱', '💵', '真的进出了多少钱', 'ETF 份额变化 × 净值（申购 / 赎回）、稳定币增发、南向资金：真实发生的进出。和按成交估的数不一样时，以它为准。'),
  flow5: term('5天净流入', '💰', '最近一周进出的钱', '最近 5 个交易日净流入加起来。正数是进来，负数是出去。'),
  dv: term('成交额', '💵', '一天买卖了多少钱', '当天所有成交加起来的金额。'),
  idx: term('指数', '📈', '这一片的平均涨跌', '里面每只股票一样重，从 100 开始算涨跌。'),
  cumFlow: term('资金河流', '🌊', '钱一路攒下来', '把每天的净流入加起来：线往上是钱一直在进，往下是一直在走。'),
  profile: term('筹码山', '⛰️', '大家在哪个价位买卖最多', '过去 120 天每个价位成交了多少钱。山越高，越多人在这个价买过。'),
  spotlight: term('先看这里', '①', '今天最不一样的地方', '跟 5 天前比变化最大的地方，按 ①②③ 的顺序看。每个画面最多 3 个。'),
  tour: term('60 秒看懂今天', '▶', '自动导游', '自动飞到今天最值得看的 5 个地方，每处一句话讲清楚为什么。'),
  guess: term('今日一猜', '🎯', '练直觉的小游戏', '猜接下来 5 个交易日钱最可能流进哪一块，5 天后揭晓，记下命中率。'),
  est: term('估', '估', '这是估出来的', '缺数据时先按同行、ETF 或产业链逻辑估一个，标上「估」和怎么估的，等你补数据。'),
  radar: term('全市场雷达', '📡', '精选地图之外冒出来的', '从三千多只股票里扫出来、精选地图上没有的异动，最多占一个亮点。'),
  voice: term('老风', '💬', '说话的天气播报员', '嘴毒、有立场；钱数是按成交量估的（标「估」），真钱单独标「真钱」。不喜欢可以在设置里换成温和。'),
  vix: term('恐慌指数', '😨', '市场有多紧张', '越高大家越害怕。20 以下算平静，30 以上算很紧张。'),
  tnx: term('10年美债利率', '🏦', '借钱的价格', '利率往上，股票（尤其是贵的成长股）通常会有压力。'),
  dxy: term('美元指数', '💲', '美元强不强', '美元变强，钱往往流回美国；变弱，钱更愿意去海外和商品。'),
  liquidity: term('水位', '💧', '市场里有多少钱', '美联储资产减去财政部账户和逆回购：在涨叫放水，在跌叫收水。'),
  partial: term('盘中', '⏱️', '今天还没收盘', '今天的成交额已按美股盘中成交的 U 形曲线折算成全天，收盘后换成真数。'),
  holding: term('我的持仓', '★', '你自己的钱', '你的持仓永远在地图上；它一有风向突变、风暴或大风，就一定占一个 ①②③。'),
});
