// realmoney.js — the real-money layer on the map (§23 "real money first", §24 web/data/flows/*.json).
// The weather's flow numbers are ESTIMATES from price × volume (§2). Where flows/ has the real thing — ETF
// creations/redemptions (shares outstanding × NAV), 南向资金, A股 ETF 申赎, stablecoin net mint — this module
// shows it next to the estimate, labelled 真钱 vs 估, and says plainly when the two genuinely point opposite ways.
//   app.realMoney(id, dateIndex | 'YYYY-MM-DD'?) → {flow5, flow1, from, asOf, label, source, coverage, lag, extra:[…],
//                                     est5, likeForLike, clash, blind, realMat, estMat} | null
//        (from / asOf = the first / last of the 5 real-money trade days the numbers cover; a date string lets the stock
//         page ask by its own file's dates)
//   app.realMoneyClash(r) → 反 (like for like); app.realMoneyClash(r, est) → must a sentence stating `est`'s direction
//        say that the real money points the other way (反, or material real money against it, or a blind estimate)
//   app.realMoneyFan(r) → 反 only; app.realMoneySay(r, est) → that sentence (words.realSay, voice in use) or ''
//   app.realMoneyBlock(id, i, est) → the hover card's 真钱 vs 估 block, over named trade days (「10月17–23日」)
//   words.setRealOf(app.realMoney): describe / take / ①②③ reasons / 主航道 rows see the real money (the 全球 map's too)
//   emits 'realmoney' once loaded (and after each reload); then asks the shell to recompute 主航道 / ①②③ (settleDate)
//   panel section 「真钱流向」: the current planet's territories that have real money, biggest moves first
// Nothing here is ever drawn as fact unless the file says est:false; Yahoo-snapshot ETFs (est:true) stay out.
//
// 反 (same rule as flows/realflow.py compare_at and pipeline/brief.py — change one, change all three; the JS copy is
// words.compareAt, re-exported here):
//   · like for like: the real 5-day sum over the last 5 days that HAVE real money (≤ the day looked at), against
//     the estimate of the SAME ETFs on exactly those days (data/flows/aligned.json est[], T+1 already aligned);
//     where no like-for-like estimate exists (南向 / A股 ETF on the 全球 map) the territory's own estimate, same days;
//   · both material: |x| ≥ max(5 M$, ½ · its own typical |5-day sum|, median of the trailing 120 windows);
//   · the estimate must be able to point both ways: ≥ 90 % of its 5-day sums over the past year on one side →
//     blind (T-bill / money-market ETFs: the price accrues daily, the estimate says "inflow" forever) → never 反;
//   · real money more than 5 trading days behind → no comparison.
//   Stablecoin net mint is context for 加密 (cash parked on crypto rails), never compared with the crypto
//   equities' estimate.
//
// §8 amendment (season crash gate): main.js app.seasonAt hands words.season() only (w, dw, p, flow5, temp), so it
// cannot see a crash. gateSeasons() re-judges a season with the series itself (words.crashAt reads its idx) — the
// map glyphs, hover card, panel and 今日一猜 all ask app.seasonAt, so a market falling hard never shows 春 / 夏.
import { h, nowAt, icon } from './dom.js';
import * as WM from '../words.js';

const FILES = ['aligned.json', 'etf.json', 'stablecoins.json', 'china.json'];
const MIN_COVERAGE = 0.3;
const REAL_MIN = 5;              // 百万美元：「估不出方向」的地方，真钱至少这么多才拿来说方向（= 反 的绝对下限）

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** flows/realflow.py compare_at, line for line — the one JS copy lives in words.js (words.compareAt); this re-export
 *  keeps flows/test_clash.py's parity check pointed at what the map actually runs. */
export function compareAt(real, est, i) { return WM.compareAt(real, est, i); }

export async function init(app) {
  const D = app.data || app.D;
  const byId = new Map();          // tree id → [{kind:'aligned'|'dated', label, source, …, primary, context}]
  let loaded = false;

  gateSeasons(app);

  const put = (id, rec) => { if (!id) return; if (!byId.has(id)) byId.set(id, []); byId.get(id).push(rec); };
  async function load(fresh = false) {
    byId.clear();
    const top = await D.listDir?.('data/').catch(() => null);
    if (top && !top.has('flows/')) { loaded = true; return; }
    const names = await D.listDir?.('data/flows/').catch(() => null);
    const want = FILES.filter((f) => !names || names.has(f));
    const got = await Promise.all(want.map((f) => (fresh ? D.loadFresh : D.load)('flows/' + f).catch(() => null)));
    const files = Object.fromEntries(want.map((f, k) => [f.replace('.json', ''), got[k]]));
    // 1) the curated map: issuer-daily ETF creations/redemptions, trade-dated (T+1 aligned), with the estimate of the
    //    same ETFs on the same days (aligned.json est[]) — the like-for-like comparison
    const al = files.aligned;
    const alOk = !!(al && Array.isArray(al.dates) && al.regions && Object.values(al.regions).some((r) => Array.isArray(r.est)));
    if (alOk) {
      for (const [id, r] of Object.entries(al.regions)) {
        if (!Array.isArray(r.flow) || !(r.coverage >= MIN_COVERAGE)) continue;
        put(id, { kind: 'aligned', dates: al.dates, flow: r.flow, est: Array.isArray(r.est) ? r.est : null, label: 'ETF 申赎',
          source: `成员 ETF 发行商每日份额 × 净值（T+1 记账已对齐到交易日；${(r.covered || []).length} 只）`, coverage: r.coverage, primary: true });
      }
      for (const [t, r] of Object.entries(al.tickers || {})) {
        if (!Array.isArray(r.flow)) continue;
        put('s:' + t, { kind: 'aligned', dates: al.dates, flow: r.flow, est: Array.isArray(r.est) ? r.est : null, label: '申赎',
          source: `${r.source || '发行商每日份额 × 净值'}（T+1 记账已对齐到交易日）`, primary: true });
      }
    } else {
      // older data without aligned.json est[]: issuer-dated etf.json, held against the territory's own estimate
      for (const r of files.etf?.regions || []) {
        if (r.est || !(r.coverage >= MIN_COVERAGE) || !Array.isArray(r.date) || !r.date.length) continue;
        put(r.id, { kind: 'dated', label: 'ETF 申赎', source: r.source || 'ETF 份额变化 × 净值', date: r.date, usd: r.usd, coverage: r.coverage, primary: true });
      }
      for (const it of files.etf?.items || []) {
        if (it.est || !Array.isArray(it.date) || !it.date.length || !it.ticker) continue;
        put(it.id || 's:' + it.ticker, { kind: 'dated', label: '申赎', source: it.source || '发行商每日份额 × 净值', date: it.date, usd: it.usd, primary: true });
      }
    }
    // 2) stablecoins: net mint of all USD stablecoins = cash arriving at (or leaving) the crypto rails. Context for
    //    加密, never compared with the crypto equities' / ETFs' estimate (different money). The last UTC day is often
    //    still running (partialLast): left out.
    const sc = (files.stablecoins?.items || []).find((x) => x.id === 'stable:total' || x.kind === 'total');
    if (sc && !sc.est && Array.isArray(sc.date)) {
      const n = sc.partialLast ? sc.date.length - 1 : sc.date.length;
      put('crypto', { kind: 'dated', label: '稳定币净增发', source: sc.source || 'DefiLlama', date: sc.date.slice(0, n), usd: sc.usd.slice(0, n), context: true });
    }
    // 3) China: 南向 (mainland → HK) and A股 ETF 申赎 — flows/china.py says where each belongs ({map, id, primary, label})
    for (const x of files.china?.items || []) {
      if (x.est || x.stale || !Array.isArray(x.date) || !x.date.length) continue;
      if (Array.isArray(x.attach) && x.attach.length) {
        for (const a of x.attach) {
          if (!a || !a.id) continue;
          put(a.id, { kind: 'dated', label: a.label || x.label || x.name || '真钱', source: x.source || (x.kind === 'connect' ? '港股通净买入（真实每日）' : '交易所每日份额 × 净值'), date: x.date, usd: x.usd, primary: !!a.primary });
        }
      }
    }
    loaded = true;
  }

  /** the series of a territory on the map on screen (child or the planet itself) — its own estimate */
  function seriesOf(id) {
    const m = app.currentMap;
    if (!m) return null;
    if (m.children && m.children[id]) return m.children[id];
    return m.id === id ? m.self : null;
  }
  /** a 'dated' record's values on the map's own dates (matched by date string) */
  function onMapDates(rec) {
    const dates = app.meta?.dates || [];
    if (rec._on && rec._on.dates === dates) return rec._on.vals;
    const pos = new Map(rec.date.map((d, k) => [String(d).slice(0, 10), k]));
    const vals = dates.map((d) => { const k = pos.get(d); const v = k == null ? null : rec.usd[k]; return isNum(v) ? v : null; });
    rec._on = { dates, vals };
    return vals;
  }
  /** → {cmp, day index on rec.dates, likeForLike} for a record at map day i */
  function measure(rec, id, i) {
    const day = app.meta?.dates?.[i];
    if (rec.kind === 'aligned') {
      const j = day ? rec.dates.indexOf(day) : -1;
      if (j < 0) return null;
      const cmp = compareAt(rec.flow, rec.context ? null : rec.est, j);
      return cmp ? { cmp, dates: rec.dates, likeForLike: !!rec.est } : null;
    }
    const real = onMapDates(rec);
    const s = rec.context ? null : seriesOf(id);
    const est = s && Array.isArray(s.flow) ? s.flow.map((v) => (isNum(v) ? v : null)) : null;
    const cmp = compareAt(real, est, i);
    return cmp ? { cmp, dates: app.meta?.dates || [], likeForLike: false } : null;
  }

  /** i = the map's day index, or a date string 'YYYY-MM-DD' (the stock page speaks its own file's dates) */
  app.realMoney = (id, i = app.state.dateIndex) => {
    if (!loaded || !byId.has(id)) return null;
    if (typeof i === 'string') {
      i = (app.meta?.dates || []).indexOf(i.slice(0, 10));
      if (i < 0) return null;
    }
    const recs = byId.get(id);
    const main = recs.find((r) => r.primary && !r.context) || recs.find((r) => !r.context) || null;
    const day = app.meta?.dates?.[i] || null;
    const extraOf = (r) => { const m = measure(r, id, i); return m ? { label: r.label, flow5: m.cmp.real5, asOf: m.dates[m.cmp.through], source: r.source, context: !!r.context } : null; };
    if (!main) {
      // only context (stablecoins): shown as a line, never as the territory's real money
      const ex = recs.map(extraOf).filter(Boolean);
      return ex.length ? { flow5: null, label: null, contextOnly: true, extra: ex } : null;
    }
    const m = measure(main, id, i);
    if (!m) return null;
    const c = m.cmp, asOf = m.dates[c.through];
    return {
      flow5: c.real5, flow1: main.kind === 'aligned' ? main.flow[c.through] : onMapDates(main)[c.through], asOf,
      from: c.from != null ? m.dates[c.from] || null : null,
      label: main.label, source: main.source, coverage: main.coverage ?? null,
      lag: day && asOf && asOf < day ? asOf : null,
      est5: c.est5, likeForLike: m.likeForLike, clash: c.clash, blind: c.blind, realMat: c.realMat, estMat: c.estMat, estPos: c.estPos,
      extra: recs.filter((r) => r !== main).map(extraOf).filter(Boolean),
    };
  };
  app.hasRealMoney = (id) => loaded && byId.has(id);

  const money = (x) => app.W.money(Math.abs(x));
  const signed = (x) => (x >= 0 ? '+' : '−') + money(x);
  const day = (d) => { const m = String(d || '').match(/^\d{4}-(\d\d)-(\d\d)/); return m ? `${+m[1]}月${+m[2]}日` : ''; };
  /** the 5 real-money trade days a number covers: 「10月17–23日」 / 「9月29日–10月3日」 / 「截至10月23日」 */
  const span = (a, b) => {
    const pa = String(a || '').match(/^\d{4}-(\d\d)-(\d\d)/), pb = String(b || '').match(/^\d{4}-(\d\d)-(\d\d)/);
    if (!pb) return '';
    if (!pa) return `截至${+pb[1]}月${+pb[2]}日`;
    return pa[1] === pb[1] ? `${+pa[1]}月${+pa[2]}–${+pb[2]}日` : `${+pa[1]}月${+pa[2]}日–${+pb[1]}月${+pb[2]}日`;
  };
  const verb = (r, x) => (/申赎|申购/.test(r.label || '') ? (x >= 0 ? '净申购' : '净赎回') : /增发/.test(r.label || '') ? (x >= 0 ? '净增发' : '净销毁') : /南向/.test(r.label || '') ? (x >= 0 ? '净买入' : '净卖出') : (x >= 0 ? '净流入' : '净流出'));
  const flat = (x) => !isNum(x) || Math.abs(x) < 0.5;     // < 50 万美元：「没动」
  /** "ETF 申赎 5天净申购 77.8亿美元" */
  app.realMoneyLine = (r) => (r && r.flow5 != null ? `${r.label} 5天${flat(r.flow5) ? '几乎没动' : `${verb(r, r.flow5)} ${money(r.flow5)}`}` : '');
  /** words.realSay on the voice in use → the sentence a card must say when the real money and `est` disagree, or '' */
  const realSentence = (r, est) => {
    let rs = null;
    try { rs = app.W?.realSay ? app.W.realSay(r, est) : null; } catch (e) { rs = null; }
    return rs ? (app.state.voice === 'mild' ? rs.mild : rs.sharp) : '';
  };
  app.realMoneySay = realSentence;
  /** Without `est`: 反 — the real money and the estimate of the SAME ETFs on the same days genuinely point opposite
   *  ways (both material, the estimate not blind).
   *  With `est` (a caller's own estimate, e.g. the hover card's / caster's 5-day flow): must a sentence that states a
   *  direction from `est` say that the real money points the other way? (§23 amendment) — true when `est` points
   *  against the real money AND that real money counts: a 反, or material real money (realMat), or a blind estimate
   *  (T-bill / money-market: the estimate says "inflow" forever) with ≥ 5 M$ of real money. So "按成交估是钱在出，可…在进"
   *  is always literally true, and a material opposite real move is never left unsaid (现金避险 / 加密 / 新兴市场). */
  app.realMoneyClash = (r, est) => {
    if (!r || r.flow5 == null) return false;
    if (est == null || !isNum(est)) return !!r.clash;
    if (Math.abs(est) < 0.05 || (est > 0) === (r.flow5 > 0)) return false;
    return !!(r.clash || r.realMat || (r.blind && Math.abs(r.flow5) >= REAL_MIN));
  };
  /** 反 only (like for like), whatever the caller's estimate says — for the 「反」 flag */
  app.realMoneyFan = (r) => !!(r && r.clash);
  /** A small block for cards (hover card): 真钱 badge, the real line, the like-for-like estimate beside it — both over
   *  the same named trade days (「10月17–23日」), so the card's own 5-day estimate above (the whole territory, the latest
   *  5 days) is never mistaken for the same sum. */
  app.realMoneyBlock = (id, i = app.state.dateIndex, est = null) => {
    const r = app.realMoney(id, i);
    if (!r) return null;
    if (r.contextOnly) {
      return h('div.rm-block', { title: '稳定币净增发：钱进出币圈的大门，不是这块地本身的进出' },
        ...r.extra.slice(0, 1).map((x) => h('div.rm-row.extra', h('span.rm-badge.sub', '真钱'), h('span.rm-text', `${x.label} 5天${verb(x, x.flow5)} ${money(x.flow5)}`))));
    }
    const cov = r.coverage != null && r.coverage < 0.95 ? `（算进了约 ${Math.round(r.coverage * 100)}% 的资金）` : '';
    const win = span(r.from, r.asOf);
    const realTxt = `${r.label} ${flat(r.flow5) ? '几乎没动' : `${verb(r, r.flow5)} ${money(r.flow5)}`}${r.realMat || flat(r.flow5) ? '' : '，不算大'}`;
    // (one line each in the card: .rm-text never wraps — the head names the days, the tooltip says the rest)
    const same = r.likeForLike ? '同批 ETF 估' : '同几天估';
    const pos = r.estPos ?? 0.5;
    const estTxt = r.blind
      ? `估不出方向（近一年 ${Math.round(100 * Math.max(pos, 1 - pos))}% 都说${pos >= 0.5 ? '在进' : '在出'}），看真钱`
      : r.est5 != null ? `${same} ${signed(r.est5)}${r.estMat ? '' : '，不算大'}`
        : est != null ? `按成交估 5天 ${signed(est)}` : null;
    // the card's own estimate line (the whole territory, the latest 5 days) can point the other way from the
    // like-for-like one above: say they are two different sums instead of leaving two opposite 估 side by side
    const other = !r.blind && r.est5 != null && isNum(est) && Math.abs(est) >= 0.05 && Math.abs(r.est5) >= 0.05 && (est > 0) !== (r.est5 > 0)
      ? `上面那行估（${signed(est)}）是${r.likeForLike ? '整块地' : '这块地'}最近 5 天，另一笔账` : null;
    const clashTxt = r.clash
      ? `${r.likeForLike ? '同一批 ETF 估的' : '按成交估的'}说钱在${r.est5 > 0 ? '进' : '出'}，真钱却在${verb(r, r.flow5)}${r.est5 > 0 ? '：别被成交量骗了' : ''}`
      : null;
    return h('div.rm-block' + (r.clash ? '.clash' : ''), { title: `真钱：${r.source}${cov}。估：${r.likeForLike ? '同一批 ETF ' : '这块地'}按每天的价格和成交额推算（§2）。两边算的都是 ${win || '同几天'}（最近 5 个有真钱的交易日）。` },
      h('div.rm-head', h('span', '真钱 vs 估'), win ? h('span.rm-asof', win) : null),
      h('div.rm-row',
        h('span.rm-badge', '真钱'),
        h('span.rm-text', realTxt)),
      estTxt ? h('div.rm-row.est', h('span.rm-badge.est', '估'), h('span.rm-text', estTxt)) : null,
      clashTxt ? h('div.rm-clash', clashTxt) : null,
      other ? h('div.rm-other', { style: { fontSize: '11px', color: 'var(--ink-3)', lineHeight: '1.35' } }, other) : null,
      ...r.extra.slice(0, 2).map((x) => h('div.rm-row.extra', h('span.rm-badge.sub', '真钱'), h('span.rm-text', `${x.label} 5天${verb(x, x.flow5)} ${money(x.flow5)}`))));
  };

  // ---------------------------------------------------------------- panel: 真钱流向 for the planet on screen
  function render(el, ctx) {
    const node = ctx.node;
    if (!node || !loaded) return false;
    const mild = app.state.voice === 'mild';
    const kids = node.children || [];
    const rows = [];
    for (const c of kids) {
      const r = app.realMoney(c.id, ctx.dateIndex);
      if (!r || r.contextOnly) continue;
      rows.push({ c, r });
    }
    // the planet itself: when its own real money and its own estimate disagree, the panel's 这里的天气 lines (the
    // estimate's direction) need this next to them (§23 amendment)
    const self = app.realMoney(node.id, ctx.dateIndex);
    const selfEst = nowAt(ctx.map?.self, ctx.dateIndex, null)?.flow5 ?? null;
    const selfSay = self && !self.contextOnly ? realSentence(self, selfEst) : '';
    // a leaf region with real money but no children that have any
    if (!rows.length) {
      if (!self || self.contextOnly) return false;
      el.append(h('p.rm-lead', selfSay ? `${node.name}：${selfSay}` : `${node.name}：${app.realMoneyLine(self)}`), app.realMoneyBlock(node.id, ctx.dateIndex, selfEst) || '');
      return true;
    }
    rows.sort((a, b) => Math.abs(b.r.flow5) - Math.abs(a.r.flow5));
    const clashes = rows.filter((x) => x.r.clash);
    const who = (r) => (r.likeForLike ? '同一批 ETF 估的' : '按成交估的');
    const lead = clashes.length
      ? `${clashes[0].c.name}：${who(clashes[0].r)}${clashes[0].r.est5 >= 0 ? '说钱在进' : '说钱在出'}，真钱${clashes[0].r.flow5 >= 0 ? '在进' : '在出'}。`
      : rows.length > 1 && rows[0].r.realMat ? `真钱最多的是${rows[0].c.name}，${rows[0].r.blind ? '那里按成交估不出方向，以真钱为准' : '跟估的方向不打架'}。` : '';
    // the trade days the numbers cover (the same for every row on one map, unless one source lags)
    const wins = [...new Set(rows.map((x) => span(x.r.from, x.r.asOf)).filter(Boolean))];
    const lastAsOf = rows.map((x) => x.r.asOf).filter(Boolean).sort().pop();
    const when = wins.length === 1 ? `两边算的都是 ${wins[0]}（最近 5 个有真钱的交易日）。` : lastAsOf ? `真钱截至${day(lastAsOf)}。` : '';
    el.append(
      h('p.rm-sub', rows.some((x) => x.r.likeForLike)
        ? '「真钱」是 ETF 申赎、南向资金这些真实进出；「估」是同一批 ETF、同几天按价格和成交额推算的。'
        : '「真钱」是 ETF 申赎、南向资金这些真实进出；「估」是这块地自己同几天按价格和成交额推算的。', when ? ` ${when}` : ''),
      selfSay ? h('p.rm-lead.rm-self', `${node.name}自己：${selfSay}${mild ? '' : '。'}`.replace(/。。$/, '。')) : '',
      lead ? h('p.rm-lead', lead) : '',
      h('ul.items.rm-list', rows.slice(0, 6).map(({ c, r }) => h('li.item', {
        tabindex: 0, role: 'button', title: `${r.source}${r.coverage != null ? `（算进了约 ${Math.round(r.coverage * 100)}% 的资金）` : ''}${r.from ? ` · ${span(r.from, r.asOf)}` : ''}`,
        onclick: () => app.goId(c.id), onkeydown: (e) => { if (e.key === 'Enter') app.goId(c.id); },
      },
      h('span.item-main',
        h('span.item-name', c.name, h('span.rm-badge', '真钱'), r.clash ? h('span.rm-flag', { title: `${r.likeForLike ? '同一批 ETF、同几天' : '同几天'}：真钱和估算方向相反，两边都不小` }, '反') : null),
        h('span.item-say', `${r.label}${r.realMat || flat(r.flow5) ? '' : '（真钱不算大）'} · ${r.blind ? '估不出方向' : r.est5 == null ? '估 —' : `${r.likeForLike ? '同批' : ''}估 ${signed(r.est5)}${r.estMat ? '' : '（不算大）'}`}`)),
      h('span.item-metric.rm-metric' + (flat(r.flow5) ? '.flat' : r.flow5 >= 0 ? '.in' : '.out'), flat(r.flow5) ? '没动' : signed(r.flow5)))))
    );
    return true;
  }

  // words.js (the hover card / panel lines, ①②③ reasons, 主航道 rows) reads real money through this hook: the 全球
  // map's 南向 / A股 ETF 申赎 live only here, not in the map series
  const hook = (id, i) => app.realMoney(id, i);
  const installHook = () => { try { app.W?.setRealOf?.(hook); } catch (e) { /* older words.js */ } };
  // main.js computed the 主航道 / ①②③ before this module existed (a deep link straight into 大中华 named A股 as the
  // place money leaves, while the headline — rendered later, with real money — named 台股): once the real money is in,
  // let the shell recompute them, so the map, the headline and 真钱流向 tell one story
  const resettle = () => {
    if (!byId.size || !app.currentMap || app.playing || app.touring || typeof app.settleDate !== 'function') return;
    try { app.settleDate(); } catch (e) { console.warn('[realmoney] settle', e); }
  };

  await load().catch((e) => { console.warn('[realmoney] load', e); loaded = true; });
  installHook();
  if (app.panel && typeof app.panel.addSection === 'function') {
    try { app.panel.addSection({ id: 'realmoney', title: '真钱流向', icon: 'dollar', order: 55, render }); } catch (e) { console.warn('[realmoney] addSection', e); }
  }
  resettle();
  try { app.emit?.('realmoney', { loaded: true }); } catch (e) { /* no listeners */ }
  // a stock page opened by a deep link (#/stock/EWZ) spoke before this module existed — its 「实」 line then fell back
  // to the old sign test (a 2090万 creation read as 「反着，以真钱为准」). Its only re-speak hook today is the voice
  // event: send the same voice once so it asks app.realMoney again (stock.js can listen to 'realmoney' instead).
  if (app.state?.view === 'stock' && byId.size) { try { app.emit?.('voice', app.state.voice); } catch (e) { /* none */ } }
  app.on('dataReloaded', (p) => {
    const parts = p && p.parts;
    if (parts && ![].concat(parts).some((q) => /flows|all|meta/.test(String(q)))) return;
    try { D.forgetDir?.('data/flows/'); } catch (e) { /* optional */ }
    load(true).then(() => { app.panel?.refresh?.(); resettle(); try { app.emit?.('realmoney', { loaded: true }); } catch (e) { /* none */ } }).catch(() => {});
  });
  void icon;
  return { reload: () => load(true) };
}

// ---------------------------------------------------------------- §8 amendment: season crash gate on the map
function gateSeasons(app) {
  // the brief's own measured season odds (brief.seasonStats, incl. byCrash): main.js loadAll() hands them to words.js
  // before app.W exists on the first boot, so until a map switch the default table spoke — hand them over here too
  try { if (app.brief?.seasonStats) app.W?.setSeasonStats?.(app.brief.seasonStats); } catch (e) { /* default table */ }
  const base = app.seasonAt;
  if (typeof base !== 'function' || base.crashGated) return;
  const gated = (series, i = app.state.dateIndex) => {
    const s = base(series, i);
    const W = app.W;
    if (!series || !W || typeof W.crashAt !== 'function' || typeof W.seasonAt !== 'function') return s;
    let cr = null;
    try { cr = W.crashAt(series, i); } catch (e) { cr = null; }
    if (!cr) return s;                       // nothing falling hard: main.js's answer, untouched
    try {
      const g = W.seasonAt(series, i);       // words.js: same rule, sees the crash, says the drop
      return g && g.key ? { ...(s || {}), ...g, key: g.key } : s;
    } catch (e) { return s; }
  };
  gated.crashGated = true;
  app.seasonAt = gated;
  try { app.applyOverlays?.(); } catch (e) { /* the next redraw picks it up */ }
}
