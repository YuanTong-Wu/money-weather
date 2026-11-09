#!/usr/bin/env python3
"""brief.py — 今日天气预报 → web/data/brief.json  (DESIGN.md §3 §6 §8 §12 §14)

把整棵树当天的天气，压缩成主人 10 秒能看懂的东西：
  headline   一句话：钱从哪搬到哪（大方向 + 美股里面最猛的那一股）；盘中时以「盘中：」开头
  asOfLabel / partial  数据是哪一刻的：「10月27日 收盘」或「10月27日 盘中（截至美东 10:30，悉尼 01:30）」+ 一句提醒
  holdings / holdingsLine  §20 我的持仓：每天一行（优先持仓排第一），{say, sayMild, facts}；有动静就占 ①②③
  liquidity  §23 水位：「美联储在放水 / 收水 / 平稳」一句（web/data/liquidity.json 有才写）
  channel    今天的主航道：地球上那根大箭头 {from, to, weak, hero, heroSay, inner}（§8.1；hero 的选法和 main.js computeChannel 一样）
  story      故事主线 {hero:'arrow'|'inner'|'sink'|'source', beats:[{role, id, spot, chain, single?}]}：
             标题第一拍 = 主角 = ①（顺着钱往下找到的推手），第二拍 = ②，巡航按同一个顺序走
  spotlight  先看这里 ①②③ = 主线两拍 + 持仓（有动静时）或 surprise 最高的；一块大陆一个、最多一只股票；每项带 role / story / real
  radarSpot  全市场 / 全球雷达里明显更值得看的那个（不占精选地图的 ①②③：精选地图上没有它的格子）
  tour       「▶ 60 秒看懂今天」5 站：① 主角 → 钱从哪来 → ② → ③ → 一只股票（雷达里更猛的股票可以顶替最后一站）
  seasonStats 这份地图自己的季节历史转移表（季节说的是现在，「下一步」只用历史概率说；words.js setSeasonStats 吃它）
  big / inflow / outflow / fronts / crowded / quiet / storms / stocksIn / stocksOut  排行榜（有真钱的项带 real）

钱（§14 / §23）：地图上的钱是按价格 × 成交额估的。flows/ 里有真钱（ETF 申赎、稳定币、南向资金）的地方先说真钱、
估算放括号里；方向相反就说「真钱唱反调」；没有真钱的金额标「估」。一只股票撑起一整块地（≥ 60%）时，不讲成「板块轮动」。

风和钱不许打架（phase-3 #3）：风 = ½ 关注度（成交份额）+ ½ 净流入。两半方向相反时直说
「关注度在升，但钱没真进来」/「钱在进，但没人注意」；季节、温度、风的说法在同一屏上不互相矛盾，check() 会抓。
NDAQ 叫「纳斯达克交易所（公司）」，免得和指数搞混（ALIAS）。

说话的人是「老风」（§12）：犀利、有立场、数字精确。每句话写两份：
  say / why / caption / headline       → 犀利（默认）
  sayMild / whyMild / captionMild / headlineMild → 温和
估出来的东西（§14：节点带 est/basis/conf）一律标「估」，并说明是怎么估的。

独立运行：只读 web/data/{meta,tree}.json 和 web/data/maps/*.json（+ 可选 fm/candidates.json、gl/、liquidity.json、flows/、
universe/holdings.json），
不依赖 compute.py。surprise / season / 主航道 的规则和 web/js/words.js 完全一样 —— 改一边必须改另一边
（只有一处 brief.py 多：真钱和估算对不上的格子不当主航道的两头；words.mainChannel 要传 opts.realOf 才一样）。

用法:
  python3 pipeline/brief.py                 # 写 web/data/brief.json
  python3 pipeline/brief.py --print         # 同时打印一份给人看的版本（犀利）
  python3 pipeline/brief.py --print --mild  # 打印温和版
  python3 pipeline/brief.py --i 200 --print --no-write   # 假装今天是第 200 天（调文案用）
  python3 pipeline/brief.py --data web/data/fm           # 给全市场地图写一份（不再叠加雷达）
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 compute.py now.crash、words.js crashAt 同一条规则

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'web' / 'data'
MAX_HAN = 30          # §12：每句 ≤ 30 字
# 名字会被看错的公司（和指数 / 板块同名）：说话时换成不会误会的叫法（和 words.js ALIAS 一样）
ALIAS = {'NDAQ': '纳斯达克交易所（公司）'}

# ════════════════════════════ 小工具 ════════════════════════════


def isnum(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def val(arr, i):
    if not isinstance(arr, list) or i < 0 or i >= len(arr):
        return None
    v = arr[i]
    return v if isnum(v) else None


def sum_back(arr, i, n):
    """arr[i-n+1 … i] 的和（跳过空值）；一个都没有 → None。"""
    if not isinstance(arr, list) or i < 0:
        return None
    s, k = 0.0, 0
    for j in range(max(0, i - n + 1), min(i, len(arr) - 1) + 1):
        if isnum(arr[j]):
            s += arr[j]
            k += 1
    return s if k else None


def avg_back(arr, i, n):
    s = sum_back(arr, i, n)
    if s is None:
        return None
    k = sum(1 for j in range(max(0, i - n + 1), min(i, len(arr) - 1) + 1) if isnum(arr[j]))
    return s / k if k else None


def chg(arr, i, n):
    a, b = val(arr, i), val(arr, i - n)
    return a / b - 1 if a is not None and b is not None and b != 0 else None


def typical5(flow, i):
    """「平时」5 天净流量有多大：前 60 天里，每个 5 天窗口净流量绝对值的平均（和 words.js 一样）。"""
    xs = []
    for j in range(i - 5, max(4, i - 60) - 1, -1):
        s = sum_back(flow, j, 5)
        if s is not None:
            xs.append(abs(s))
    if len(xs) < 10:
        return None
    m = sum(xs) / len(xs)
    return m if m > 0 else None


def han_len(s: str) -> int:
    return len(re.findall(r'[㐀-鿿]', str(s)))


def r2(x):
    return round(float(x), 2) if isnum(x) else None


def r1(x):
    return round(float(x), 1) if isnum(x) else None


def B(name: str) -> str:
    return f'【{name}】'


def vary(key: str, options):
    """同一个东西同一天说同一句，不同东西换着说（不随机，可复现）。"""
    return options[zlib.crc32(key.encode('utf-8')) % len(options)]


def fit(*cands) -> str:
    """挑第一句每个分句都 ≤ 30 字的；都太长就用最后一句。"""
    cands = [c for c in cands if c]
    for c in cands:
        if all(han_len(p) <= MAX_HAN for p in re.split(r'[。！？；]', c)):
            return c
    return cands[-1] if cands else ''


# ════════════════════════════ 词汇（DESIGN.md §5，与 words.js 一致） ════════════════════════════


def money(m, sign=False) -> str:
    """百万美元 → "3.2亿美元" / "850万美元"。"""
    if not isnum(m):
        return '—'
    a = abs(m)
    sg = '-' if (m < 0 and a * 100 >= 0.05) else ('+' if (sign and m > 0 and a * 100 >= 0.05) else '')
    if a >= 1e6:
        wy = a / 1e6
        return sg + (str(round(wy)) if wy >= 9.95 else f'{wy:.1f}') + '万亿美元'
    if a >= 100:
        yi = a / 100
        return sg + (str(round(yi)) if yi >= 99.95 else f'{yi:.1f}') + '亿美元'
    wan = a * 100
    if wan >= 9.95:
        return sg + str(round(wan)) + '万美元'
    if wan >= 0.05:
        return sg + f'{wan:.1f}' + '万美元'
    return '0美元'


def pct(x) -> str:
    if not isnum(x):
        return '—'
    v = x * 100
    a = abs(v)
    s = str(round(a)) if a >= 99.5 else f'{a:.1f}'
    if float(s) == 0:
        return '0.0%'
    return ('+' if v > 0 else '-') + s + '%'


def pct_abs(x) -> str:
    return pct(abs(x)).lstrip('+-') if isnum(x) else '—'


def times(r) -> str:
    if not isnum(r):
        return '—'
    if r >= 9.95:
        return str(round(r))
    s = f'{r:.1f}'
    return s[:-2] if s.endswith('.0') else s


def wind_mix(w, f5):
    """风 = ½·关注度（成交份额 rot）+ ½·净流入（flow5）。两半方向相反时（和 words.js windMix 一样）：
    'attn'  风 ≥ 0.5 但 5 天净流出 → 关注度在升，钱没真进来
    'quiet' 风 ≤ −0.5 但 5 天净流入 → 钱在进，但没人注意"""
    if not isnum(w) or not isnum(f5) or abs(f5) < 0.05:
        return None
    if w >= 0.5 and f5 < 0:
        return 'attn'
    if w <= -0.5 and f5 > 0:
        return 'quiet'
    return None


def wind_word(w, f5=None) -> str:
    if not isnum(w):
        return '暂无数据'
    mx = wind_mix(w, f5)
    if mx == 'attn':
        return '关注度在升，但钱没真进来'
    if mx == 'quiet':
        return '钱在进，但没人注意'
    if w > 1.5:
        return '钱在狂涌进来'
    if w >= 0.5:
        return '钱在流进来'
    if w > -0.5:
        return '风平浪静'
    if w >= -1.5:
        return '钱在悄悄溜走'
    return '钱在大逃离'


def wind_sharp(w, key='', f5=None) -> str:
    """「悄悄 / 闷声」只留给风和钱打架的 'quiet'（钱在进，但没人注意）；普通的进出不说悄悄（和 words.js 一样）。"""
    if not isnum(w):
        return '没数据，老风不乱说'
    mx = wind_mix(w, f5)
    if mx == 'attn':
        return vary(key, ['光热闹不掏钱，看客比买家多', '人都围过来了，钱没跟进来'])
    if mx == 'quiet':
        return vary(key, ['没人盯着，钱在闷声进货', '没人注意，钱在悄悄进'])
    if w > 1.5:
        return vary(key, ['钱跟疯了一样往里灌', '钱在狂灌，挡都挡不住'])
    if w >= 0.5:
        return vary(key, ['钱在往里搬', '有人在进货'])
    if w > -0.5:
        return '风平浪静，没故事'
    if w >= -1.5:
        return vary(key, ['钱在溜号', '钱在往外撤'])
    return vary(key, ['钱在大逃亡', '钱在夺门而逃'])


def flow_text(f5, days=5) -> str:
    if not isnum(f5) or abs(f5) < 0.05:
        return f'{days}天进出打平'
    return f'{days}天净{"流入" if f5 > 0 else "流出"} {money(abs(f5))}'


def short_money(m) -> str:
    """括号里的估算用短写：「316亿」（不带「美元」）。"""
    return money(m).replace('美元', '')


def scale_text(f5, dv20) -> str:
    """5 天进出相当于它几天的成交额（给「风平浪静 / 只是日常」配上尺度）。"""
    if not isnum(f5) or not isnum(dv20) or dv20 <= 0:
        return ''
    d = abs(f5) / dv20
    return '不到它 0.1 天的成交' if d < 0.1 else f'约它 {d:.1f} 天的成交'


# ════════════════════════════ 真钱（§23 real money first：web/data/flows/*.json，和 ui/realmoney.js 同一套规矩） ════════════════════════════
# 地图上的「钱」是按价格 × 成交额估出来的（§2）。flows/ 里有真东西的地方——ETF 申赎（份额变化 × 净值）、
# 稳定币净增发、南向资金、A股 ETF 申赎——先说真钱，估算放在括号里；两边方向相反就直说「真钱唱反调」。

REAL_MIN_COV = 0.3
REAL_WORDS = {   # realmoney.js 的 label → (前缀, 流入的说法, 流出的说法)
    'ETF 申赎': ('ETF ', '净申购', '净赎回'),
    '申赎': ('', '净申购', '净赎回'),
    '稳定币净增发': ('稳定币', '净增发', '净销毁'),
    '南向资金': ('南向资金', '净买入', '净卖出'),
    'A股 ETF 申赎': ('A股 ETF ', '净申购', '净赎回'),
}
# 反 的规矩（和 flows/realflow.py compare_at、web/js/ui/realmoney.js compareAt 一字不差）
CLASH_ABS, CLASH_REL = 5.0, 0.5
SCALE_WIN, BLIND_WIN, BLIND_SHARE, BLIND_MIN, STALE_DAYS = 120, 250, 0.9, 40, 5


def _median(xs):
    ys = sorted(xs)
    n = len(ys)
    if not n:
        return 0.0
    return ys[n // 2] if n % 2 else 0.5 * (ys[n // 2 - 1] + ys[n // 2])


def compare_at(real, est, i):
    """真钱 vs 估（同一批 ETF / 同几天）。→ None（没有 / 太旧）或 {real5, est5, through, lag, realMat, estMat, blind, clash, …}"""
    if not isinstance(real, list):
        return None
    top = min(i, len(real) - 1)
    have = [k for k in range(0, top + 1) if isnum(real[k]) and (est is None or isnum(est[k]))]
    if len(have) < 5 or i - have[-1] > STALE_DAYS:
        return None
    w = have[-5:]
    r5 = sum(real[k] for k in w)

    def wins(arr, n):
        return [sum(arr[k] for k in have[q - 4:q + 1]) for q in range(max(4, len(have) - n), len(have))]
    rs = _median([abs(x) for x in wins(real, SCALE_WIN)])
    out = {'real5': r5, 'from': w[0], 'through': w[-1], 'lag': i - w[-1], 'realScale': rs,
           'realMat': abs(r5) >= max(CLASH_ABS, CLASH_REL * rs)}
    if est is None:
        out.update(est5=None, estMat=False, blind=False, clash=False, estPos=None)
        return out
    e5 = sum(est[k] for k in w)
    es = _median([abs(x) for x in wins(est, SCALE_WIN)])
    le = wins(est, BLIND_WIN)
    pos = sum(1 for x in le if x > 0) / len(le) if le else None
    blind = pos is not None and len(le) >= BLIND_MIN and (pos >= BLIND_SHARE or pos <= 1 - BLIND_SHARE)
    est_mat = abs(e5) >= max(CLASH_ABS, CLASH_REL * es)
    out.update(est5=e5, estMat=est_mat, blind=blind, estPos=pos,
               clash=bool(not blind and out['realMat'] and est_mat and (r5 > 0) != (e5 > 0)))
    return out


class RealMoney:
    """id → 截至今天的真钱（和 web/js/ui/realmoney.js 读法一样）：
    · 精选地图：flows/aligned.json（发行商每日份额 × 净值，T+1 已对齐到交易日），和「同一批 ETF、同几天」的估算比；
    · 全球地图：china.json 的南向 / A股 ETF 申赎（按 attach 挂到 gl-hk / gl-cn / gl-greater-china），和那块地自己的估算比；
    · 稳定币净增发只是加密的背景（钱进出币圈的大门），不拿来和加密股 / ETF 的估算比，也不当这块地的真钱。
    Yahoo 快照（est:true）不算。"""

    def __init__(self, data_dir: Path | None, as_of: str | None, dates: list | None = None):
        self.by: dict[str, list[dict]] = {}
        self.as_of = as_of
        self.dates = list(dates or [])
        self.pos = {d: k for k, d in enumerate(self.dates)}
        d = None
        for cand in ([data_dir / 'flows'] if data_dir else []) + [DATA / 'flows']:
            if cand.is_dir():
                d = cand
                break
        if d is None:
            return
        files = {}
        for name in ('aligned', 'etf', 'china'):
            p = d / f'{name}.json'
            if p.exists():
                try:
                    files[name] = json.loads(p.read_text(encoding='utf-8'))
                except Exception as e:  # 坏文件不拖垮整份预报
                    print(f'[brief] 读不了真钱 {p.name}: {e}', file=sys.stderr)
        al = files.get('aligned') or {}
        al_ok = isinstance(al.get('dates'), list) and any(isinstance(r.get('est'), list) for r in (al.get('regions') or {}).values())
        if al_ok:
            for rid, r in (al.get('regions') or {}).items():
                if isinstance(r.get('flow'), list) and isnum(r.get('coverage')) and r['coverage'] >= REAL_MIN_COV:
                    self._put(rid, {'kind': 'aligned', 'dates': al['dates'], 'flow': r['flow'], 'est': r.get('est'),
                                    'label': 'ETF 申赎', 'coverage': r['coverage'], 'primary': True})
            for t, r in (al.get('tickers') or {}).items():
                if isinstance(r.get('flow'), list):
                    self._put('s:' + t, {'kind': 'aligned', 'dates': al['dates'], 'flow': r['flow'], 'est': r.get('est'),
                                         'label': '申赎', 'primary': True})
        else:
            etf = files.get('etf') or {}
            for r in etf.get('regions') or []:
                if r.get('est') or not (isnum(r.get('coverage')) and r['coverage'] >= REAL_MIN_COV) or not r.get('date'):
                    continue
                self._put(r.get('id'), {'kind': 'dated', 'label': 'ETF 申赎', 'date': r['date'], 'usd': r.get('usd') or [],
                                        'coverage': r['coverage'], 'primary': True})
            for it in etf.get('items') or []:
                if it.get('est') or not it.get('date') or not it.get('ticker'):
                    continue
                self._put(it.get('id') or 's:' + it['ticker'], {'kind': 'dated', 'label': '申赎', 'date': it['date'],
                                                                'usd': it.get('usd') or [], 'primary': True})
        for x in (files.get('china') or {}).get('items') or []:
            if x.get('est') or x.get('stale') or not x.get('date'):
                continue
            for a in x.get('attach') or []:
                if isinstance(a, dict) and a.get('id'):
                    lab = '南向资金' if x.get('kind') == 'connect' else 'A股 ETF 申赎'
                    self._put(a['id'], {'kind': 'dated', 'label': lab, 'date': x['date'], 'usd': x.get('usd') or [],
                                        'primary': bool(a.get('primary'))})

    def _put(self, nid, rec):
        if nid:
            self.by.setdefault(str(nid), []).append(rec)

    def get(self, nid: str, series: dict | None = None) -> dict | None:
        """→ {flow5, est5, asOf, label, coverage, clash, blind, realMat, estMat, likeForLike} | None（截至今天）。"""
        recs = self.by.get(nid)
        if not recs:
            return None
        main = next((r for r in recs if r.get('primary')), recs[0])
        if main['kind'] == 'aligned':
            ds = main['dates']
            j = len(ds) - 1
            if self.as_of:
                while j >= 0 and str(ds[j]) > self.as_of:
                    j -= 1
            if j < 0:
                return None
            c = compare_at(main['flow'], main.get('est'), j)
            if not c:
                return None
            asof, like = str(ds[c['through']]), main.get('est') is not None
            frm = str(ds[c['from']])
        else:
            if not self.dates:
                return None
            byd = {str(d)[:10]: v for d, v in zip(main['date'], main['usd'])}
            real = [byd.get(d) if isnum(byd.get(d)) else None for d in self.dates]
            i = self.pos.get(self.as_of, len(self.dates) - 1)
            est = None
            if series and isinstance(series.get('flow'), list) and len(series['flow']) == len(self.dates):
                est = [v if isnum(v) else None for v in series['flow']]
            c = compare_at(real, est, i)
            if not c:
                return None
            asof, like = self.dates[c['through']], False
            frm = self.dates[c['from']]
        # 真钱比今天晚（发行商 T+1、交易所隔夜）：句子里说清是哪 5 天（「10月17–23日」），别让人当成最近 5 天
        span = day_span(frm, asof) if (self.as_of and str(asof) < str(self.as_of)) else None
        # 两位小数：再四舍五入到 0.1 会让同一笔钱在地图上读 19.3亿、在这里读 19.4亿（1934.97 → 1935.0）
        return {'flow5': round(c['real5'], 2), 'est5': round(c['est5'], 2) if isnum(c.get('est5')) else None,
                'asOf': asof, 'from': frm, 'span': span, 'label': main['label'],
                'coverage': round(main['coverage'], 3) if isnum(main.get('coverage')) else None,
                'clash': c['clash'], 'blind': c['blind'], 'realMat': c['realMat'], 'estMat': c['estMat'], 'likeForLike': like}


def day_span(a, b) -> str:
    """('2026-10-17', '2026-10-23') →「10月17–23日」；跨月「9月29日–10月3日」（和 realmoney.js span 一样）"""
    try:
        ma, da = int(str(a)[5:7]), int(str(a)[8:10])
        mb, db = int(str(b)[5:7]), int(str(b)[8:10])
    except (TypeError, ValueError):
        return ''
    return f'{ma}月{da}–{db}日' if ma == mb else f'{ma}月{da}日–{mb}月{db}日'


def real_against(r: dict | None, est) -> bool:
    """句子层面：真钱（不小）和这块地自己的估算 est 方向相反——句子里写「按成交估是钱在进 / 出」时必须把这件事说出来，
    不然「钱在悄悄进」后面跟「真钱净赎回」就自相矛盾。估算看不出方向的地方（blind）走 real_blind。
    注意和 反（r['clash']：同一批 ETF / 同几天、两边都不小）不是一回事：句子只在 clash 时用「唱反调」，否则说「却相反」。"""
    if not r or not r.get('realMat') or r.get('blind') or not isnum(est) or abs(est) < 0.05:
        return False
    return (r['flow5'] > 0) != (est > 0)


def real_blind(r: dict | None) -> bool:
    """按价量估在这里看不出方向（国库券 / 货币基金 ETF：净值天天涨，估算永远说「钱在进」）：只说真钱——真钱不大也一样
    （估算的方向在这里本来就没有意义；§23 修订：说方向的句子必须说「按成交估不出方向，看真钱」，real_bit 会标「不算大」）。"""
    return bool(r and r.get('blind'))


def est_who(r: dict | None, est) -> str:
    """「按成交估」说的是谁：同一批 ETF 估出来的方向（est5）和整块地自己的估算（est）反着时，点明是「整块地」——
    不然真钱流向卡上的「同批估 +9.2亿」和这句「按成交估是钱在出」读起来像同一个估算自相矛盾。"""
    e5 = r.get('est5') if r else None
    if r and r.get('likeForLike') and isnum(e5) and isnum(est) and abs(e5) >= 0.05 and abs(est) >= 0.05 and (e5 > 0) != (est > 0):
        return '最近5天按成交估' if r.get('label') == '申赎' else '整块地按成交估'   # 一只 ETF：两个 5 天
    return '按成交估'


def real_off(r: dict | None, est) -> bool:
    """估算在这里靠不住（真钱反着走 / 真钱几乎没动 / 估算看不出方向）：不拿估算当主航道的一头、不当「真钱」开口。"""
    return real_against(r, est) or real_flat(r, est) or real_blind(r)


def against_word(r: dict) -> str:
    """反（同一批 ETF 也对不上）→「唱反调」；只是和整块地的估算相反 →「却相反」。"""
    return '唱反调' if r.get('clash') else '却相反'


def real_flat(r: dict | None, est) -> bool:
    """真钱几乎没动：同一批 ETF 估出来的钱不小，真钱却不到它的 1/10 也不算大；这块地自己的估算也有 ≥ 5000 万美元
    （句子要说「按成交估是钱在进 / 出」）。估算看不出方向的地方（blind）不算。"""
    if not r or not isnum(est) or abs(est) < 50 or r.get('blind'):
        return False
    e5 = r.get('est5')
    if not isnum(e5):
        return False
    return bool(r.get('estMat')) and not r.get('realMat') and abs(r['flow5']) < 0.1 * abs(e5)


def real_bit(r: dict, days=5) -> str:
    """「ETF 5天净申购 77.8亿美元」；真钱比今天晚时说是哪 5 天「ETF 10月17–23日净申购 77.8亿美元」；不大时「（不算大）」；
    几乎没动时「ETF 5天几乎没有申赎」（和 words.js realBit 一样，多了日期）"""
    pre, vin, vout = REAL_WORDS.get(r.get('label'), ('', '净流入', '净流出'))
    when = r.get('span') or f'{days}天'
    if abs(r['flow5']) < 0.5:
        return f'{pre}{when}几乎没有{"申赎" if "申" in vin else "进出"}'
    small = '' if r.get('realMat', True) else '（不算大）'
    return f'{pre}{when}{vin if r["flow5"] >= 0 else vout} {money(abs(r["flow5"]))}{small}'


def real_info(r: dict | None) -> dict | None:
    """排行榜 / 亮点上带着的真钱（给前端画「真钱」徽章用）。"""
    if not r:
        return None
    return {'flow5': r['flow5'], 'asOf': r['asOf'], 'from': r.get('from'), 'span': r.get('span'), 'label': r['label'], 'coverage': r.get('coverage'),
            'est5': r.get('est5'), 'likeForLike': bool(r.get('likeForLike')), 'clash': bool(r.get('clash')),
            'blind': bool(r.get('blind')), 'material': bool(r.get('realMat'))}


# ════════════════════════════ 一天的大跌 / 大涨（|ret1| ≥ 3 倍平时的日波动） ════════════════════════════


def shock(n) -> tuple[float, float] | None:
    """今天这一天的涨跌有多吓人：|ret1| ≥ 3% 且 ≥ 3 倍过去 20 天的日波动 → (ret1, 倍数)。
    恐慌抛售时成交量暴增，风（一半是成交份额）会被推成「钱在进」——这时先把跌了多少说出来。"""
    v = n.v
    r1, vol = v.get('ret1'), v.get('vol20')
    if isnum(r1) and isnum(vol) and vol > 0 and abs(r1) >= 0.03 and abs(r1) >= 3 * vol:
        return r1, abs(r1) / vol
    return None


def shock_text(n, sk=None) -> str:
    """「一天跌了 19.0%（平时一天只晃 1.6%）」"""
    sk = sk or shock(n)
    if not sk:
        return ''
    r1, _ = sk
    vol = n.v.get('vol20')
    return f'一天{"跌" if r1 < 0 else "涨"}了 {pct_abs(r1)}（平时一天{"只" if vol < 0.03 else ""}晃 {pct_abs(vol)}）'


# ════════════════════════════ 季节（DESIGN.md §8.2，与 words.js 一致：按表格顺序判断） ════════════════════════════

SEASONS = {
    'spring': {'emoji': '🌱', 'name': '春'},
    'summer': {'emoji': '☀️', 'name': '夏'},
    'autumn': {'emoji': '🍂', 'name': '秋'},
    'winter': {'emoji': '❄️', 'name': '冬'},
}


def season_key(w, dw, p, crash=None):
    """🌱 w>0.3 且 dw>0.3 且 p<65 · ☀️ w>0.3 且 p≥65 · 🍂 w<−0.3 且 p≥50（或 dw<−0.6 且 p≥65）
       · ❄️ w<−0.3 且 p<50，或 |w|≤0.3 且 p<35 · 其余 None
       暴跌闸门（§8 修订，pipeline/crashgate.py）：crash 触发时 春 / 夏 / None → p≥50 读秋，否则读冬。"""
    if not isnum(w) or not isnum(p):
        return None
    dw = dw if isnum(dw) else 0.0
    k = None
    if w > 0.3 and dw > 0.3 and p < 65:
        k = 'spring'
    elif w > 0.3 and p >= 65:
        k = 'summer'
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = 'autumn'
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = 'winter'
    return CG.gate_key(k, crash, p)


def crash_words(cr):
    """暴跌时那半句 (犀利, 温和)，和 words.js crashWords 一样：「崩了：一天跌了 19.8%，人多是在逃命」。"""
    lv = cr.get('level', 0) if isinstance(cr, dict) else (cr or 0)
    if not lv:
        return None
    d = ''
    if isinstance(cr, dict):
        if cr.get('by') == 'r1' and isnum(cr.get('r1')):
            d = f'一天跌了 {pct_abs(cr["r1"])}'
        elif isnum(cr.get('r5')):
            d = f'5天跌了 {pct_abs(cr["r5"])}'
    dd = f'：{d}' if d else ''
    if lv >= 2:
        return f'崩了{dd}，人多是在逃命', f'暴跌{dd}，远超它平时的波动'
    return f'急跌{dd}，热闹的是夺门的人', f'急跌{dd}，比它平时的波动大得多'


def season_obj(key):
    return {'key': key, **SEASONS[key]} if key in SEASONS else None


# 季节说的是「现在」的人气和钱，不是预言（§8.2 的「下一步」实测下来站不住：一年 24.5 万个样本里，春天 5 天后只有
# 13% 进夏、42% 退回冬，之后 5 天净流入的概率 52.6%，平时 50.4%）。所以「下一步」一律用历史概率说，
# 每天在这份地图自己的 252 天上重算一遍 → brief.seasonStats（words.js setSeasonStats 吃同一份）。
SEASON_NEXT = {'spring': 'summer', 'summer': 'autumn', 'autumn': 'winter', 'winter': 'spring'}
SEASON_KEYS = ('spring', 'summer', 'autumn', 'winter', 'none')
STAT_H = 5          # 看 5 个交易日之后
STAT_MIN = 300      # 分「钱在进 / 钱在出」两种情况时，样本少于这个就用总表


def season_to_word(k: str, x: str) -> str:
    """从季节 k 走到 x 怎么说：「还是夏」「进夏」「退回冬」「开春」…（和 words.js 一样）"""
    if x == k:
        return f'还是{SEASONS[k]["name"]}'
    if x == 'spring':
        return '开春' if k == 'winter' else '又冒芽'
    if x == 'summer':
        return '进夏' if k == 'spring' else '回到夏'
    if x == 'autumn':
        return '入秋'
    if x == 'winter':
        return '退回冬' if k == 'spring' else '入冬'
    return '没了季节'


def season_next_say(st: dict | None, k: str, money_dir: str | None = None, crash=None) -> tuple[str, str] | None:
    """历史概率版的「下一步」（犀利, 温和）：「别急，历史上 5 天后只有 13% 进夏，42% 退回冬」。和 words.js seasonNext 一样。
    crash（暴跌闸门等级 1/2，或 crash_at 的结果）：用「暴跌那天」的那张表（byCrash，§8 修订）——平常的秋天 24% 回到夏，
    崩了的秋天不是；样本不够就不报概率。"""
    if not st or k not in SEASON_NEXT or not isinstance(st.get(k), dict):
        return None
    e = st[k]
    lv = crash.get('level', 0) if isinstance(crash, dict) else (crash or 0)
    if lv:
        bc = e.get('byCrash') or {}
        if (bc.get('n') or 0) < STAT_MIN or not bc.get('to'):
            return '暴跌过后怎么走，历史样本不够，不报概率', '暴跌过后怎么走，样本不够，不报概率'
        to = bc['to']
    else:
        to = e.get('to') or {}
        bm = (e.get('byMoney') or {}).get(money_dir) if money_dir else None
        if bm and (bm.get('n') or 0) >= STAT_MIN:
            to = bm.get('to') or to
    if not to:
        return None
    pc = lambda p: f'{round(100 * (p or 0))}%'
    nat = SEASON_NEXT[k]
    pn = to.get(nat, 0)
    others = sorted([(x, p) for x, p in to.items() if x not in ('none', nat) and x in SEASONS], key=lambda xp: -xp[1])
    if not others:
        return None
    ox, op = others[0]
    h = STAT_H
    body = f'{pc(pn)} {season_to_word(k, nat)}，{pc(op)} {season_to_word(k, ox)}'
    if lv:
        mild = f'暴跌过后，历史上 {h} 天后 {body}'
        return mild, mild
    mild = f'历史上 {h} 天后 {body}'
    if k == 'spring' and pn < 0.25:
        sharp = f'别急，历史上 {h} 天后只有 {pc(pn)} {season_to_word(k, nat)}，{pc(op)} {season_to_word(k, ox)}'
    elif k == 'winter' and to.get('winter', 0) >= 0.5:
        sharp = f'冬天很长，历史上 {h} 天后 {pc(to["winter"])} 还是冬，{pc(pn)} 开春'
    elif k == 'summer' and pn >= 0.3:
        sharp = f'小心，历史上 {h} 天后 {body}'
    else:
        sharp = mild
    return sharp, mild


def season_stats(W) -> dict:
    """这份地图自己的季节转移表：每个孩子格子、每一天（t+5 ≤ 今天），季节 → 5 天后的季节，以及之后 5 天净流入的概率。
    → {asOf, horizon, n, base:{flowPos}, spring:{n, to:{…}, flowPos, byMoney:{in:{n,to}, out:{n,to}}, byCrash?:{n,to}, say, sayMild}, …}
    byCrash = 只算暴跌闸门触发那天（§8 修订）的转移：崩了的秋天和平常的秋天不是一回事（words.js seasonNext 的 crash）。"""
    H = STAT_H
    T = {k: dict.fromkeys(SEASON_KEYS, 0) for k in SEASON_KEYS}
    M = {(k, d): dict.fromkeys(SEASON_KEYS, 0) for k in SEASON_KEYS for d in ('in', 'out')}
    C = {k: dict.fromkeys(SEASON_KEYS, 0) for k in SEASON_KEYS}      # 暴跌那天（闸门触发）的季节 → 5 天后
    FW = {k: [0, 0] for k in SEASON_KEYS}
    last = W.i
    for m in W.maps.values():
        for s in (m.get('children') or {}).values():
            w, p, fl = s.get('wind'), s.get('pres'), s.get('flow')
            if not (isinstance(w, list) and isinstance(p, list) and isinstance(fl, list)):
                continue
            px = CG.series_px(s)
            n = min(len(w), len(p), len(fl), last + 1)
            keys = [None] * n
            crs = [0] * n
            for t in range(5, n):
                a, b, c = w[t], w[t - 5], p[t]
                if isnum(a) and isnum(b) and isnum(c):
                    cr = CG.crash_at(px, t)
                    crs[t] = cr['level'] if cr else 0
                    keys[t] = season_key(a, a - b, c, cr) or 'none'
            for t in range(65, n - H):
                k, kf = keys[t], keys[t + H]
                if k is None or kf is None:
                    continue
                T[k][kf] += 1
                if crs[t]:
                    C[k][kf] += 1
                fwd = sum(x for x in fl[t + 1:t + 1 + H] if isnum(x))
                back = sum(x for x in fl[t - 4:t + 1] if isnum(x))
                FW[k][0] += 1
                FW[k][1] += fwd > 0
                M[(k, 'in' if back > 0 else 'out')][kf] += 1
    tot = sum(FW[k][0] for k in SEASON_KEYS)
    pos = sum(FW[k][1] for k in SEASON_KEYS)
    norm = lambda c: {x: round(v / max(1, sum(c.values())), 3) for x, v in c.items()}
    out = {'asOf': W.asOf, 'horizon': H, 'n': tot, 'base': {'flowPos': round(pos / tot, 3) if tot else None}}
    for k in SEASON_KEYS:
        nk = FW[k][0]
        e = {'n': nk, 'to': norm(T[k]) if nk else {}, 'flowPos': round(FW[k][1] / nk, 3) if nk else None,
             'byMoney': {d: {'n': sum(M[(k, d)].values()), 'to': norm(M[(k, d)])} for d in ('in', 'out') if sum(M[(k, d)].values())}}
        if sum(C[k].values()):
            e['byCrash'] = {'n': sum(C[k].values()), 'to': norm(C[k])}
        out[k] = e
    for k in SEASON_NEXT:
        ns = season_next_say(out, k) if out[k]['n'] >= STAT_MIN else None
        if ns:
            out[k]['say'], out[k]['sayMild'] = ns
    return out


# ════════════════════════════ 注意力：surprise（DESIGN.md §6，与 words.js 一致） ════════════════════════════


def surprise_parts(s: dict, t: int) -> dict:
    """0.45·|wind_t − wind_{t−5}| + 0.25·|wind_t| + 0.15·|temp_t − temp_{t−5}|
       + 0.6·|front_t| + 0.3·(storm_t ≥ 0.8) + 0.2·(pres_t ≥ 90 或 ≤ 10)
    （§8.2 原来给 🌱 春 +0.5：实测春天并不比别的日子更能预告钱的下一步，这一项去掉了；spring 字段留着恒为 0。）"""
    P = dict(score=0.0, shift=0.0, level=0.0, heat=0.0, front=0.0, storm=0.0, crowd=0.0, spring=0.0,
             wind=None, wind5=None, dw=0.0, temp=None, temp5=None, pres=None, stormV=None, frontV=0, season=None,
             crash=None)
    if not s or t < 0:
        return P
    j = max(0, t - 5)
    w = val(s.get('wind'), t)
    if w is None:
        return P
    w5 = val(s.get('wind'), j)
    tp, tp5 = val(s.get('temp'), t), val(s.get('temp'), j)
    f = val(s.get('front'), t) or 0
    st = val(s.get('storm'), t)
    p = val(s.get('pres'), t)
    dw = w - (w if w5 is None else w5)
    cr = CG.crash_at(CG.series_px(s), t)          # 暴跌闸门（§8 修订）
    sk = season_key(w, dw, p, cr)
    P.update(wind=w, wind5=w5, dw=dw, temp=tp, temp5=tp5, pres=p, stormV=st, frontV=f, season=sk, crash=cr)
    P['shift'] = 0.45 * abs(dw)
    P['level'] = 0.25 * abs(w)
    P['heat'] = 0.15 * abs(tp - tp5) if (tp is not None and tp5 is not None) else 0.0
    P['front'] = 0.6 * abs(f)
    P['storm'] = 0.3 if (st is not None and st >= 0.8) else 0.0
    P['crowd'] = 0.2 if (p is not None and (p >= 90 or p <= 10)) else 0.0
    P['spring'] = 0.0   # 春天不再加分（见上面 season_stats 的实测）
    P['score'] = P['shift'] + P['level'] + P['heat'] + P['front'] + P['storm'] + P['crowd'] + P['spring']
    return P


def dominant(P: dict) -> str:
    if P['front']:
        return 'front'
    parts = [('shift', P['shift']), ('level', P['level']), ('heat', P['heat']), ('storm', P['storm']), ('crowd', P['crowd'])]
    parts.sort(key=lambda kv: -kv[1])  # 稳定排序：同分时按上面的顺序（和 words.js 一样）
    return parts[0][0]


# ════════════════════════════ 树 + 每个节点当天的数字 ════════════════════════════


class Node:
    __slots__ = ('id', 'name', 'emoji', 'kind', 'depth', 'ticker', 'path_ids', 'all_paths', 'parent',
                 'cont', 'raw', 'series', 'v', 'P', 'est')

    def __init__(self, raw, path_ids, parent):
        self.raw = raw
        self.id = raw['id']
        self.name = raw.get('name') or raw.get('ticker') or self.id
        self.emoji = raw.get('emoji') or ''
        self.kind = raw.get('kind') or ('stock' if self.id.startswith('s:') else 'region')
        self.depth = len(path_ids) - 1
        self.ticker = raw.get('ticker')
        self.path_ids = path_ids          # 从 world 到自己（含自己），和 data.js pathIds() 一样
        self.all_paths = [path_ids]
        self.parent = parent
        self.cont = None
        self.series = None
        self.v = {}
        self.P = None
        self.est = est_info(raw)

    @property
    def is_stock(self):
        return self.kind == 'stock'

    @property
    def season(self):
        return self.P.get('season') if self.P else None


def est_info(raw: dict):
    """§14：节点（或它的 now{}）带 est:true → {basis, conf}；否则 None。"""
    now = raw.get('now') or {}
    for src in (raw, now):
        if src.get('est') is True:
            basis = src.get('basis') or now.get('basis') or raw.get('basis') or '按同行类比'
            conf = src.get('conf', now.get('conf', raw.get('conf')))
            return {'basis': str(basis), 'conf': conf if isnum(conf) else None}
    return None


class World:
    def __init__(self, data_dir: Path, i: int | None):
        self.dir = data_dir
        self._real_cache: dict = {}
        self.meta = json.loads((data_dir / 'meta.json').read_text(encoding='utf-8'))
        self.tree = json.loads((data_dir / 'tree.json').read_text(encoding='utf-8'))
        self.root_id = self.tree.get('id', 'world')
        self.nodes: dict[str, Node] = {}
        self.order: list[Node] = []
        self._walk(self.tree, [], None)
        self._display_names()
        self.maps: dict[str, dict] = {}
        for n in self.order:
            if n.kind != 'stock':
                p = data_dir / 'maps' / (n.id.replace(':', '_') + '.json')
                if p.exists():
                    try:
                        self.maps[n.id] = json.loads(p.read_text(encoding='utf-8'))
                    except Exception as e:  # 坏文件不拖垮整份预报
                        print(f'[brief] 读不了 {p.name}: {e}', file=sys.stderr)
        dates = self.meta.get('dates') or []
        L = len(dates) or self._series_len()
        self.last = L - 1
        self.i = self.last if i is None else max(0, min(self.last, i if i >= 0 else L + i))
        self.asOf = dates[self.i] if dates else self.meta.get('asOf')
        self.latest = self.i == self.last
        self.names = {n.id: n.name for n in self.order}
        for n in self.order:
            n.cont = self._continent(n)
            n.series = self._series(n)
            n.v = self._values(n)
            n.P = surprise_parts(n.series, self.i) if n.series else surprise_parts({}, -1)
        # 每块地下面有哪些股票（去重）：用来查「这块地的钱是不是几乎全是一只股票带的」
        self.under: dict[str, list[Node]] = {}
        for n in self.order:
            if n.kind != 'stock':
                continue
            seen = set()
            for p in n.all_paths:
                for a in p[:-1]:
                    if a not in seen:
                        seen.add(a)
                        self.under.setdefault(a, []).append(n)
        # §23 真钱（web/data/flows）：今天（截至 asOf）最近 5 个真实日子
        self.real = RealMoney(data_dir, self.asOf, dates)

    def real_of(self, n: 'Node') -> dict | None:
        if n is None:
            return None
        if n.id not in self._real_cache:
            self._real_cache[n.id] = self.real.get(n.id, n.series)
        return self._real_cache[n.id]

    def _display_names(self):
        """NDAQ → 纳斯达克交易所（公司）；和某个板块同名的股票 / ETF（UNG「天然气」）后面带上代码。"""
        regions = {n.name for n in self.order if n.kind != 'stock'}
        for n in self.order:
            if n.kind != 'stock':
                continue
            t = n.ticker or n.id[2:]
            if t in ALIAS:
                n.name = ALIAS[t]
            elif n.name in regions and t and t not in n.name:
                n.name = f'{n.name}（{t}）'

    # -- 树 --
    def _walk(self, raw, trail, parent):
        p = trail + [raw['id']]
        if raw['id'] in self.nodes:
            self.nodes[raw['id']].all_paths.append(p)
        else:
            n = Node(raw, p, parent)
            self.nodes[n.id] = n
            self.order.append(n)
        for c in raw.get('children') or []:
            self._walk(c, p, raw['id'])

    def _continent(self, n: Node):
        """大陆：美股下面按主题大陆（AI 算力、软件…）算，其它按第一层（债券、商品…）算。"""
        p = n.path_ids
        if len(p) < 2:
            return None
        if p[1] == 'us' and len(p) >= 3:
            return p[2]
        return p[1]

    def _series_len(self):
        m = self.maps.get(self.root_id) or {}
        s = m.get('self') or {}
        return max([len(v) for v in s.values() if isinstance(v, list)] or [0])

    def _series(self, n: Node):
        if n.parent and n.parent in self.maps:
            s = (self.maps[n.parent].get('children') or {}).get(n.id)
            if s:
                return s
        m = self.maps.get(n.id)
        return m.get('self') if m else None

    def _values(self, n: Node) -> dict:
        s, t = n.series or {}, self.i
        now = n.raw.get('now') or {}
        v = {
            'wind': val(s.get('wind'), t), 'temp': val(s.get('temp'), t), 'pres': val(s.get('pres'), t),
            'storm': val(s.get('storm'), t), 'front': val(s.get('front'), t) or 0,
            'flow5': sum_back(s.get('flow'), t, 5), 'ret1': chg(s.get('idx'), t, 1),
            'ret5': chg(s.get('idx'), t, 5), 'ret20': chg(s.get('idx'), t, 20),
            'dv20': avg_back(s.get('dv'), t, 20), 'norm5': typical5(s.get('flow'), t),
        }
        if self.latest:  # 最新一天：以 tree.json 的 now{} 为准（合同里的数），缺的再用序列补
            for k in ('wind', 'temp', 'pres', 'storm', 'front', 'flow5', 'ret1', 'ret5', 'ret20', 'dv20'):
                if isnum(now.get(k)):
                    v[k] = now[k]
        v['front'] = int(v['front'] or 0)
        v['ratio'] = abs(v['flow5']) / v['norm5'] if (isnum(v['flow5']) and v['norm5']) else None
        # 过去 20 天（不含今天）的日波动：判断今天这一跌 / 一涨是不是「吓人」（shock）
        idx = s.get('idx')
        rs = []
        for j in range(max(1, t - 20), t):
            a, b = val(idx, j), val(idx, j - 1)
            if a is not None and b:
                rs.append(a / b - 1)
        if len(rs) >= 10:
            mu = sum(rs) / len(rs)
            v['vol20'] = math.sqrt(sum((x - mu) ** 2 for x in rs) / (len(rs) - 1))
        else:
            v['vol20'] = None
        return v

    # -- 便捷 --
    def path_str(self, n: Node) -> str:
        """父辈路径（不含地球、不含自己），例如「美股 › AI 算力」——自己的名字另外显示。"""
        return ' › '.join(self.names.get(x, x) for x in n.path_ids[1:-1])

    def related(self, a: Node, b: Node) -> bool:
        """a 和 b 是同一个，或者一个在另一个里面。"""
        if a.id == b.id:
            return True
        for pa in a.all_paths:
            if b.id in pa:
                return True
        for pb in b.all_paths:
            if a.id in pb:
                return True
        return False

    def regions(self, min_depth=1):
        return [n for n in self.order if n.kind != 'stock' and n.depth >= min_depth and n.series]

    def stocks(self):
        return [n for n in self.order if n.kind == 'stock' and n.series]

    def top(self):
        """地球的孩子（地球星球上真正画出来的那几块）。"""
        return [n for n in self.order if n.depth == 1 and n.kind != 'stock' and isnum(n.v['wind'])]

    def us_themes(self):
        us = self.nodes.get('us')
        if not us:
            return []
        return [self.nodes[c['id']] for c in us.raw.get('children') or []
                if c['id'] in self.nodes and self.nodes[c['id']].kind != 'stock' and isnum(self.nodes[c['id']].v['wind'])]

    def continents(self):
        """大陆一级：美股展开成主题大陆（AI 算力、软件…），其余第一层（债券、商品…）原样。"""
        out = []
        for n in self.order:
            if n.depth == 1 and n.kind != 'stock':
                if n.id == 'us':
                    out.extend(x for x in self.us_themes() if x.series)
                elif n.series:
                    out.append(n)
        return out


# ════════════════════════════ 小短语 ════════════════════════════


def ratio_text(v: dict) -> str:
    """"是平时的 2.3 倍"（只有明显比平时多时才说）"""
    r = v.get('ratio')
    return f'是平时的 {times(r)} 倍' if (r and r >= 1.5) else ''


def price_text(r5) -> str:
    """"5天涨了 4.0%" / "价格几乎没动" """
    if not isnum(r5):
        return ''
    if abs(r5) < 0.003:
        return '价格几乎没动'
    return f'5天{"涨" if r5 > 0 else "跌"}了 {pct_abs(r5)}'


def join(*bits, k=2) -> str:
    return '，'.join([b for b in bits if b][:k])


def flows_in(n) -> bool:
    return isnum(n.v['wind']) and n.v['wind'] > 0 and (not isnum(n.v['flow5']) or n.v['flow5'] > 0)


def flows_out(n) -> bool:
    return isnum(n.v['wind']) and n.v['wind'] < 0 and (not isnum(n.v['flow5']) or n.v['flow5'] < 0)


def est_tail(n: Node, mild=False) -> str:
    """§14：估出来的要说清楚。"""
    if not n.est:
        return ''
    return f'（估：{n.est["basis"]}）' if mild else f'（老风估的：{n.est["basis"]}）'


# ════════════════════════════ 为什么值得看（一句话，不带名字） ════════════════════════════


CUR: 'World | None' = None   # build() 正在写的那份地图（money_phrase 要用它查真钱）


def money_phrase(n: Node, drop_est=False, W: 'World | None' = None) -> str:
    """一句话里的钱（§14 / §23：真钱先说，估算标「估」）：
       有真钱 →「真钱 ETF 5天净申购 77.8亿美元（估 316亿）」；方向相反 →「真钱唱反调：ETF 5天净赎回 19.4亿美元」；
       只有估算 →「5天净流入 316亿美元（估）」。drop_est：旁边有更平静却更大的数时，不报估算的绝对数。"""
    W = W or CUR
    f5 = n.v.get('flow5')
    r = W.real_of(n) if W is not None else None
    if r:
        if real_blind(r):
            return f'真钱 {real_bit(r)}（这里按成交估不出方向）'
        if real_against(r, f5):
            return f'真钱{against_word(r)}：{real_bit(r)}'
        if real_flat(r, f5):
            return f'真钱 {real_bit(r)}（估{"流入" if f5 > 0 else "流出"} {short_money(abs(f5))}）'
        e5 = r.get('est5')
        if drop_est or not isnum(f5) or abs(f5) < 0.05:
            tail = ''
        elif r.get('likeForLike') and isnum(e5) and abs(e5) >= 0.05:
            # 和真钱流向卡上同一个估算（同一批 ETF、同几天），带方向：别拿整块地的估算和它并排
            tail = f'（同批 ETF 估{"流入" if e5 > 0 else "流出"} {short_money(abs(e5))}）'
        else:
            tail = f'（估 {short_money(abs(f5))}）'
        return f'真钱 {real_bit(r)}{tail}'
    if not isnum(f5) or abs(f5) < 0.05:
        return flow_text(f5)
    return f'{flow_text(f5)}（估）'


def why_sentence(n: Node, salt: str = '') -> tuple[str, str, str]:
    """→ (kind, why 犀利, why 温和)。kind ∈ front|inflow|outflow|storm|crowded|quiet|hot|cold
    钱一律经 money_phrase（真钱先说，估算标「估」）；估算和真钱方向相反时，开口先说这件事；今天一天大跌 / 大涨先说涨跌。"""
    P, v = n.P, n.v
    w = P['wind'] if P['wind'] is not None else 0.0
    w5 = P['wind5'] if P['wind5'] is not None else w
    f5 = v.get('flow5')
    rt = ratio_text(v)
    rtc = '，' + rt if rt else ''
    d = dominant(P)
    key = n.id + salt
    FT = money_phrase(n)
    r = CUR.real_of(n) if CUR is not None else None
    if r and real_blind(r):
        kd = 'inflow' if r['flow5'] > 0 else 'outflow'
        return (kd, fit(f'按成交估不出这里的方向，看真钱：{real_bit(r)}。', f'看真钱：{real_bit(r)}。'),
                fit(f'这里按成交估不出方向，真钱：{real_bit(r)}。', f'真钱：{real_bit(r)}。'))
    if r and real_against(r, f5):
        kd = 'inflow' if r['flow5'] > 0 else 'outflow'
        side = '进' if f5 > 0 else '出'
        aw = against_word(r)
        who = est_who(r, f5)
        return (kd, fit(f'{who}是钱在{side}，真钱{aw}：{real_bit(r)}。', f'真钱{aw}：{real_bit(r)}。'),
                fit(f'{who}是钱在{side}，真钱却相反：{real_bit(r)}。', f'真钱方向相反：{real_bit(r)}。'))
    if r and real_flat(r, f5):
        kd = 'front' if v['front'] else ('inflow' if f5 > 0 else 'outflow')
        side = '进' if f5 > 0 else '出'
        who = est_who(r, f5)
        return (kd, fit(f'{who}是钱在{side}，真钱几乎没动：{real_bit(r)}。', f'真钱几乎没动：{real_bit(r)}。'),
                fit(f'{who}是钱在{side}，真钱几乎没动：{real_bit(r)}。', f'真钱几乎没动。'))
    sk = shock(n)
    if sk:
        st_ = shock_text(n, sk)
        tail = '，成交挤爆了，可钱没真进来' if (w >= 0.5 and isnum(f5) and f5 < 0) else ''
        return ('storm', fit(f'{st_}{tail}。', f'{st_}。'), fit(f'{st_}{"，关注度在升，但钱没真进来" if tail else ""}。', f'{st_}。'))
    cw = crash_words(P.get('crash'))      # 暴跌闸门（§8 修订）：一跌不是今天这一天，也先说跌了多少
    if cw:
        return 'storm', fit(f'{cw[0]}。'), fit(f'{cw[1]}。')
    if d == 'front':
        if P['frontV'] > 0:
            if isnum(f5) and f5 > 0.05:
                lead = vary(key, ['前几天还在撤，今天钱杀回来了', '风向刚掉头，跑掉的钱又灌回来了'])
                return ('front', f'{lead}：{FT}。',
                        f'前几天还在撤，风向刚变：{FT}。')
            if isnum(f5) and f5 < -0.05:   # 风 = 关注度 + 钱：只是人气回来，钱还没跟上
                return ('front', f'风向刚掉头，可只是人气回来：{FT}。',
                        f'风向刚变，买卖的人回来了，钱还没跟上：{FT}。')
            return 'front', '前几天还在撤，风向刚掉头，人气先回来了。', '前几天还在撤，风向刚变，买卖的人先回来了。'
        if isnum(f5) and f5 < -0.05:
            return ('front', f'前几天还在进钱，今天翻脸就跑：{FT}。',
                    f'前几天还在进钱，风向刚变：{FT}。')
        if isnum(f5) and f5 > 0.05:
            return ('front', f'风向刚翻脸，人气在散，钱倒还没走：{FT}。',
                    f'风向刚变，人气在退，钱还在小幅流入：{FT}。')
        return 'front', '前几天还在进钱，今天风向翻脸，开始撤了。', '前几天还在进钱，风向刚变，开始往外撤。'
    if P.get('season') == 'spring' and d in ('shift', 'level') and isnum(f5) and f5 > 0:
        p = P['pres'] if P['pres'] is not None else 50
        return ('inflow', f'刚冒芽：{FT}，人还不多（拥挤度 {round(p)}）。',
                f'钱刚开始进来：{FT}，还不挤（拥挤度 {round(p)}）。')
    if d == 'shift':
        dd = w - w5
        if w5 <= -0.5 and w >= 0.5:
            if isnum(f5) and f5 < 0:
                return 'inflow', '5天前还没人理，现在突然热闹，可钱还没净流入。', '5天前还很冷清，现在买卖的人变多了。'
            return 'inflow', '5天前还在失血，现在钱掉头猛灌。', '5天前钱还在流出，现在掉头涌进来了。'
        if w5 >= 0.5 and w <= -0.5:
            if isnum(f5) and f5 > 0:
                return 'outflow', '5天前还挤满了人，现在突然没人理了。', '5天前还很热闹，现在买卖的人变少了。'
            return 'outflow', '5天前还在吸钱，现在掉头就跑。', '5天前钱还在流入，现在开始往外跑了。'
        if w >= 0.5 and dd > 0:
            if isnum(f5) and f5 > 0:
                return ('inflow', f'钱突然往里灌：{FT}{rtc}。', f'钱突然涌进来：{FT}{rtc}。')
            r5 = v.get('ret5')
            if isnum(r5) and r5 <= -0.02:
                st = '，还起了风暴' if (P['stormV'] or 0) >= 0.8 else ''
                if isnum(f5) and f5 < -0.05:   # 关注度猛升、钱却在走：直说
                    return ('storm' if st else 'inflow',
                            fit(f'跌了 {pct_abs(r5)}，围观的猛增，可钱没真进来{st}。', f'跌了 {pct_abs(r5)}，围观的猛增，可钱没真进来。'),
                            fit(f'5天跌了 {pct_abs(r5)}，关注度在升，但钱没真进来{st}。', f'5天跌了 {pct_abs(r5)}，关注度在升，但钱没真进来。'))
                return ('storm' if st else 'inflow', fit(f'跌了 {pct_abs(r5)}，成交却突然热闹{st}：有人抢有人逃。',
                                                         f'跌了 {pct_abs(r5)}，成交却突然热闹：有人抢有人逃。'),
                        f'5天跌了 {pct_abs(r5)}，买卖的人却突然变多{st}。')
            if isnum(f5) and f5 < -0.05:
                return ('inflow', f'突然热闹，可钱没真进来：{FT}。', f'关注度在升，但钱没真进来：{FT}。')
            return 'inflow', '突然热闹起来，可钱是进是出还没定。', '突然热闹起来，来这里买卖的人变多了。'
        if w >= 0.5:   # 还在进钱，但风一下子小了很多
            p = P['pres'] if P['pres'] is not None else 50
            if isnum(f5) and f5 > 0:
                sharp = (f'挤爆之后，劲头一下泄了：{FT}。' if p >= 90
                         else f'还在进钱，可劲头一下泄了：{FT}。')
                return 'inflow', sharp, f'钱还在进，但比前几天弱多了：{FT}。'
            if isnum(f5) and f5 < -0.05:
                return ('outflow', f'热闹还在，可钱已经不进了：{FT}。', f'关注度还高，但钱没真进来：{FT}。')
            return 'inflow', '热闹还在，劲头已经泄了。', '还很热闹，但比前几天弱多了。'
        if w <= -0.5 and dd < 0:
            if isnum(f5) and f5 < 0:
                return ('outflow', f'钱突然往外跑：{FT}{rtc}。', f'钱突然往外跑：{FT}{rtc}。')
            if isnum(f5) and f5 > 0.05:
                return ('outflow', f'突然没人理了，钱倒还没走：{FT}。', f'没人注意了，但钱还在进：{FT}。')
            return 'outflow', '突然没人理了，买卖的人一下变少。', '突然冷下来，来这里买卖的人变少了。'
        if w <= -0.5:
            if isnum(f5) and f5 < 0:
                return ('outflow', f'还在失血，不过没那么猛了：{FT}。', f'还在流出，但比前几天缓了：{FT}。')
            if isnum(f5) and f5 > 0.05:
                return ('inflow', f'人气还冷，不过钱开始进了：{FT}。', f'钱在进，但没人注意：{FT}。')
            return 'outflow', '还冷着，不过没那么冷了。', '还很冷清，但比前几天好一点。'
        if dd > 0:
            return 'inflow', '失血止住了，先别急着喊反转。', '之前一直在流出，这几天止住了。'
        return 'outflow', '进钱停了，热闹可能到头了。', '之前一直在进钱，这几天停下来了。'
    if d == 'level':
        if w >= 0:
            if isnum(f5) and f5 > 0:
                return ('inflow', f'钱一直在往里灌：{FT}{rtc}。', f'钱一直在涌进来：{FT}{rtc}。')
            if isnum(f5) and f5 < -0.05:
                return ('inflow', f'光热闹不掏钱：{FT}{rtc}。', f'关注度在升，但钱没真进来：{FT}。')
            return 'inflow', '一直很热闹，买卖的人比平时多。', '一直很热闹，买卖的人比平时多。'
        if isnum(f5) and f5 < 0:
            return ('outflow', f'钱一直在跑，没人拦：{FT}{rtc}。', f'钱一直在往外跑：{FT}{rtc}。')
        if isnum(f5) and f5 > 0.05:
            return ('outflow', f'没人盯着，钱在闷声进：{FT}{rtc}。', f'钱在进，但没人注意：{FT}。')
        return 'outflow', '一直很冷清，买卖的人比平时少。', '一直很冷清，买卖的人比平时少。'
    if d == 'heat':
        tp = P['temp'] or 0.0
        tp5 = P['temp5'] if P['temp5'] is not None else tp
        r5 = v.get('ret5')
        if tp >= tp5:
            if isnum(r5) and r5 > 0.003:
                return 'hot', f'突然烧起来了：5天涨了 {pct_abs(r5)}。', f'突然热起来了：5天涨了 {pct_abs(r5)}。'
            return 'hot', '突然烧起来了，跑得比平时快。', '突然热起来了，跑得比平时快。'
        if isnum(r5) and r5 < -0.003:
            return 'cold', f'一下子凉透了：5天跌了 {pct_abs(r5)}。', f'突然凉下来了：5天跌了 {pct_abs(r5)}。'
        return 'cold', '一下子凉透了，跑得比平时慢。', '突然凉下来了，跑得比平时慢。'
    if d == 'storm':
        x = times((P['stormV'] or 0) + 1)
        return 'storm', f'起风暴了：波动是平时的 {x} 倍，这是过山车。', f'起风暴了：最近波动是平时的 {x} 倍，坐稳。'
    p = P['pres'] if P['pres'] is not None else 50
    if p >= 90:
        return ('crowded', f'拥挤度 {round(p)}：比一年里 {round(p)}% 的日子都挤，踩踏预警。',
                f'拥挤度 {round(p)}：比过去一年 {round(p)}% 的日子都挤，小心踩踏。')
    return ('quiet', vary(key, [f'拥挤度只有 {round(p)}，被市场忘了，连风都懒得吹。',
                                f'拥挤度只有 {round(p)}，没人要，冷清得像被忘了。']),
            f'拥挤度只有 {round(p)}，几乎没人关注，是个洼地。')


# ════════════════════════════ 各个排行榜的「说一句」（犀利, 温和） ════════════════════════════


def base_item(W: World, n: Node, **extra) -> dict:
    d = {'id': n.id, 'name': n.name}
    if n.ticker:
        d['ticker'] = n.ticker
    if n.emoji:
        d['emoji'] = n.emoji
    d['path'] = W.path_str(n)
    d['pathIds'] = list(n.path_ids)
    if not n.is_stock:
        d['season'] = season_obj(n.season)
    cr = n.P.get('crash') if n.P else None
    if cr:
        d['crash'] = cr['level']          # 暴跌闸门（§8 修订）：1 急跌 / 2 崩
    if n.est:
        d['est'] = True
        d['basis'] = n.est['basis']
        if n.est['conf'] is not None:
            d['conf'] = round(n.est['conf'], 2)
    d.update(extra)
    return d


def _claims(txt: str, sign: int) -> bool:
    """这句话（除了回忆过去 / 真钱 / 括号里估算的半句）说钱在进（sign>0）或在走（sign<0）吗？和 check() 同一套词。"""
    now = '，'.join(x for x in re.split(r'[，：；。（）]', txt or '') if not PAST.search(x) and '真钱' not in x and not x.startswith('估'))
    return (IN_WORDS if sign > 0 else OUT_WORDS).search(now) is not None


def real_fix(n: Node | None, s: str, m: str) -> tuple[str, str]:
    """一句按估算说「钱在进 / 走」的话，碰上方向相反（又不小）的真钱、或估算在这里看不出方向时，换成先说真钱的说法
    （why_sentence 的真钱分支）：「没人注意，钱在悄悄进」+「真钱净赎回 19 亿」不许出现在同一行。"""
    if CUR is None or n is None:
        return s, m
    r = CUR.real_of(n)
    f5 = n.v.get('flow5')
    if not r or not (real_blind(r) or real_against(r, f5)):
        return s, m
    sign = 1 if r['flow5'] > 0 else -1
    if not (_claims(s, -sign) or _claims(m, -sign)):
        return s, m
    _, s2, m2 = why_sentence(n)
    return s2.rstrip('。'), m2.rstrip('。')


def said(sharp_mild: tuple[str, str], n: Node | None = None, key='say') -> dict:
    s, m = sharp_mild
    s, m = real_fix(n, s, m)
    if n is not None and n.est:
        s = fit(s + est_tail(n), s + '（估）')
        m = fit(m + est_tail(n, True), m + '（估）')
    return {key: s, key + 'Mild': m}


def pick_diverse(W: World, cands: list[Node], k: int, per_cont: int = 3, chosen=None) -> list[Node]:
    out = list(chosen or [])
    start = len(out)
    cont_n: dict = {}
    for c in out:
        cont_n[c.cont] = cont_n.get(c.cont, 0) + 1
    for n in cands:
        if len(out) - start >= k:
            break
        if any(W.related(n, o) for o in out):
            continue
        if cont_n.get(n.cont, 0) >= per_cont:
            continue
        out.append(n)
        cont_n[n.cont] = cont_n.get(n.cont, 0) + 1
    return out[start:]


def pick_collapsed(W: World, cands: list[Node], k: int, per_cont: int = 3) -> list[Node]:
    """同一件事在父子两层都发生时，只留大的那一层（省注意力）；选完再按原顺序排。"""
    rank = {n.id: j for j, n in enumerate(cands)}
    got = pick_diverse(W, sorted(cands, key=lambda n: (n.depth, rank[n.id])), k, per_cont)
    return sorted(got, key=lambda n: rank[n.id])


def big_say(n: Node) -> tuple[str, str]:
    """各大陆：面板只画风的条，没有金额，所以这里带上金额——真钱先说，估算标「估」；
    风平浪静却金额很大时，配上尺度（约它几天的成交），「只是日常」才站得住。"""
    v = n.v
    w, f5 = v['wind'], v['flow5']
    ft = money_phrase(n)
    rt = ratio_text(v)
    p = v['pres'] if isnum(v['pres']) else 50
    mx = wind_mix(w, f5)
    r = CUR.real_of(n) if CUR is not None else None
    if r and real_blind(r):
        return ft, f'按成交估不出方向，真钱：{real_bit(r)}'
    if r and real_against(r, f5):
        return f'{est_who(r, f5)}是钱在{"进" if f5 > 0 else "出"}，{ft}', f'{est_who(r, f5)}和真钱方向相反：{real_bit(r)}'
    if v['front']:
        if v['front'] > 0:
            if isnum(f5) and f5 < -0.05:
                return f'风向刚掉头，可钱还没跟上：{ft}', f'风向刚变，买卖的人回来了：{ft}'
            return f'风向刚掉头，钱杀回来了：{ft}', f'风向刚变，钱开始流入：{ft}'
        if isnum(f5) and f5 > 0.05:
            return f'风向刚翻脸，钱倒还没走：{ft}', f'风向刚变，人气在退：{ft}'
        return f'风向刚翻脸，钱在撤：{ft}', f'风向刚变，钱开始撤离：{ft}'
    if mx:   # 风和钱打架：直说（关注度 vs 真金白银）
        return f'{wind_sharp(w, n.id, f5)}：{ft}', f'{wind_word(w, f5)}：{ft}'
    if isnum(w) and abs(w) >= 0.5:
        mild = f'{wind_word(w)}：{ft}' + (f'，{rt}' if rt and not r and han_len(rt + ft) <= 22 else '')
        if w > 0 and p >= 85:
            sharp = f'还在吸钱，但已经挤爆了：{ft}'
        elif w > 0 and p < 15:
            sharp = f'冷门里钱在摸进来：{ft}'
        elif w < 0 and p < 15:
            sharp = f'没人要了，钱还在跑：{ft}'
        else:
            sharp = f'{wind_sharp(w, n.id)}：{ft}'
        return sharp, mild
    if not isnum(f5) or abs(f5) < 0.05:
        return '风平浪静，没故事', '风平浪静，进出打平'
    if rt and not r:
        return f'{ft}，{rt}', f'{ft}，{rt}'
    sc = scale_text(r['flow5'] if r else f5, v.get('dv20'))
    if not isnum(w) or abs(w) < 0.3:
        side = '进' if f5 > 0 else '出'
        amt_s = f'真钱 {real_bit(r)}' if r else f'{money(abs(f5))}（估）'
        lead = f'5天{side}了 {money(abs(f5))}（估）' if not r else amt_s
        return (fit(f'{lead}，{sc}，只是日常' if sc else f'{lead}，对它来说只是日常', f'{lead}，对它来说只是日常'),
                fit(f'{ft}，{sc}，不算反常' if sc else f'{ft}，不算反常', f'{ft}，不算反常'))
    if (w > 0) != (f5 > 0):   # 风条朝一边、钱朝另一边：说清楚是关注度在变
        return (f'{ft}，但关注度在{"升" if w > 0 else "降"}', f'{ft}，但关注度在{"升" if w > 0 else "降"}')
    return ft, ft


def in_say(n: Node, salt: str = '') -> tuple[str, str]:
    """钱在涌进来的榜单：面板右边已经显示 5 天金额，这里只说「特别在哪」。"""
    v = n.v
    fr = v['front'] > 0
    first_m = '风向刚变，钱刚掉头进来' if fr else (ratio_text(v) or wind_word(v['wind']))
    first_s = '风向刚掉头，钱刚杀进来' if fr else (
        (f'进钱是平时的 {times(v["ratio"])} 倍' if ratio_text(v) else wind_sharp(v['wind'], n.id)))
    sec_m = sec_s = ''
    if isnum(v['pres']) and v['pres'] >= 90:
        sec_m, sec_s = '已经人挤人', vary(n.id + salt, ['已经挤爆了，后来的是接棒的', '挤成这样，还进去的是勇士', '人挤人了，最后一棒谁接？', '门口都排队了，小心踩踏', '挤得没座了，还在往里冲'])
    elif isnum(v['pres']) and v['pres'] < 15:
        sec_m, sec_s = '之前没人关注', '冷门里冒出钱来了'
    elif isnum(v['storm']) and v['storm'] >= 0.8:
        sec_m, sec_s = '波动也变大了', '边进钱边晃，心脏要好'
    elif isnum(v.get('ret5')) and v['ret5'] <= -0.02:
        sec_m, sec_s = f'价格却跌了 {pct_abs(v["ret5"])}', f'价格却跌了 {pct_abs(v["ret5"])}，有人在底下接'
    elif isnum(v.get('ret5')) and v['ret5'] >= 0.05:
        sec_m, sec_s = price_text(v['ret5']), f'{price_text(v["ret5"])}，{vary(n.id + salt, ["跑得飞快", "一点不含糊", "涨得理直气壮"])}'
    if fr and sec_m:
        first_m, first_s = '风向刚变', '风向刚掉头'
    return fit(join(first_s, sec_s), first_s), join(first_m, sec_m)


def out_say(n: Node, salt: str = '') -> tuple[str, str]:
    v = n.v
    fr = v['front'] < 0
    first_m = '风向刚变，钱开始往外撤' if fr else (ratio_text(v) or wind_word(v['wind']))
    if fr:
        first_s = '风向刚翻脸，钱开始撤'
    elif ratio_text(v):
        first_s = f'撤钱是平时的 {times(v["ratio"])} 倍'
    elif isnum(v['temp']) and v['temp'] <= -1.5:
        first_s = '冷成冰窖，钱还在往外漏'
    elif isnum(v['pres']) and v['pres'] < 15:
        first_s = '没人要了，钱还在跑'
    else:
        first_s = wind_sharp(v['wind'], n.id)
    sec_m = sec_s = ''
    if isnum(v['storm']) and v['storm'] >= 0.8:
        sec_m, sec_s = '波动也变大了', '边跑边晃，踩踏现场'
    elif isnum(v.get('ret5')) and v['ret5'] >= 0.02:
        sec_m, sec_s = f'价格却涨了 {pct_abs(v["ret5"])}', f'价格还涨了 {pct_abs(v["ret5"])}，钱却从后门走'
    elif isnum(v['pres']) and v['pres'] >= 85:
        sec_m, sec_s = '之前人挤人', '刚才还人挤人，现在散场'
    elif isnum(v.get('ret5')) and v['ret5'] <= -0.05:
        sec_m, sec_s = price_text(v['ret5']), f'{price_text(v["ret5"])}，没人接'
    if fr and sec_m:
        first_m, first_s = '风向刚变', '风向刚翻脸'
    return fit(join(first_s, sec_s), first_s), join(first_m, sec_m)


def front_say(n: Node) -> tuple[str, str]:
    """风向刚变的榜单：标题已经说了「风向刚变」，这里说变成了什么。"""
    v = n.v
    f5 = v['flow5']
    flow_text = lambda _f: money_phrase(n)   # noqa: E731  真钱先说，估算标「估」
    if v['front'] > 0:
        if isnum(f5) and f5 > 0.05:
            return f'钱杀回来了：{flow_text(f5)}', f'钱开始流入：{flow_text(f5)}'
        if isnum(f5) and f5 < -0.05:
            return f'人气先回来了，钱还没跟上：{flow_text(f5)}', f'买卖的人回来了，钱还没净流入：{flow_text(f5)}'
        return '前几天还在撤，人气先回来了', '前几天还在撤，买卖的人先回来了'
    if isnum(f5) and f5 < -0.05:
        return f'翻脸就跑：{flow_text(f5)}', f'钱开始撤离：{flow_text(f5)}'
    if isnum(f5) and f5 > 0.05:
        return f'人气在散，钱倒还没走：{flow_text(f5)}', f'人气在退，钱还在小幅流入：{flow_text(f5)}'
    return '前几天还在进，现在掉头就跑', '前几天还在进钱，现在开始撤'


def crowd_say(n: Node, salt: str = '') -> tuple[str, str]:
    v = n.v
    w = v['wind'] or 0
    mx = wind_mix(w, v['flow5'])
    if mx == 'quiet':
        return '挤满了人，人气在退，钱倒还没走', '人挤人，人气在退，钱还在进'
    if mx == 'attn':
        return '挤爆了，看客比买家多，钱已经不进了', '人挤人，但钱没真进来'
    if w <= -0.5:
        return '挤满了人，先跑的已经在撤了', '人挤人，但钱已经开始往外走'
    if isnum(v['storm']) and v['storm'] >= 0.8:
        return '又挤又晃，踩踏就差一个喷嚏', '又挤又晃，小心踩踏'
    if w >= 1.0:
        return vary(n.id + salt, ['还在往里挤，后来的小心接最后一棒', '挤爆了还在进，胆子真大', '门都挤破了，钱还在往里塞']), '钱还在往里挤，小心踩踏'
    if isnum(v['temp']) and v['temp'] >= 1:
        return vary(n.id + salt, ['又热又挤，人人都在聊它，危险', '又热又挤，最后一棒谁来接？', '热到发烫、挤到没座，悠着点', '又热又挤，像早高峰的地铁', '热闹到顶了，就看谁先跑']), '又热又挤，小心踩踏'
    if v['pres'] >= 97:
        return '一年里最挤的时候，没空位了', '一年里最挤的时候'
    return '人挤人，踩踏风险写在脸上', '人挤人，小心踩踏'


def quiet_say(n: Node) -> tuple[str, str]:
    v = n.v
    w = v['wind'] or 0
    r20 = v.get('ret20')
    mx = wind_mix(w, v['flow5'])
    icy = not isnum(v['temp']) or v['temp'] <= 0     # 「冰窖」只在温度也冷时说（不然和「暖」打架）
    if mx == 'attn':
        return '冷门里人气回来了，钱还没跟上', '冷门里关注度在升，钱还没进来'
    if mx == 'quiet':
        f5 = v['flow5']
        if isnum(f5) and isnum(v.get('dv20')) and v['dv20'] > 0 and abs(f5) / v['dv20'] >= 0.2:
            return '没人理，成交份额在缩，钱却还在净进', '冷清，但钱在净流入'
        return '没人理，钱倒在悄悄进', '冷清，但钱在进'
    if w >= 0.5:
        return '冷门里开始有钱摸进来', '冷门里开始有钱进来了'
    if w <= -0.5:
        return ('钱还在跑，冷得像冰窖' if icy else '没人理，钱还在跑'), '钱还在走，越来越冷清'
    if isnum(r20) and r20 <= -0.1:
        return f'一个月跌了 {pct_abs(r20)}，死钱一潭，没人理', f'一个月跌了 {pct_abs(r20)}，没人理'
    if isnum(v['temp']) and v['temp'] <= -1.5:
        return '又冷又空，被市场遗忘了', '又冷又空，没人关注'
    return '没人要的洼地，连风都懒得吹', '没人关注的洼地'


def storm_say(n: Node) -> tuple[str, str]:
    s = n.v['storm']
    x = times(s + 1)
    sk = shock(n)
    if sk:   # 今天这一天的大跌 / 大涨先说出来（巴西一天跌 19% 不能只说「波动是平时的 2.9 倍」）
        st_ = shock_text(n, sk)
        # 是哪一块带的头：孩子里同方向、跌（涨）得最狠的那个
        kids = [CUR.nodes[c['id']] for c in (n.raw.get('children') or []) if CUR is not None and c['id'] in CUR.nodes]
        kids = [k for k in kids if shock(k) and (k.v['ret1'] > 0) == (sk[0] > 0) and abs(k.v['ret1']) > abs(sk[0]) * 1.5]
        if kids:
            k = max(kids, key=lambda x: abs(x.v['ret1']))
            lead = f'，其中{B(k.name)}{"跌" if sk[0] < 0 else "涨"}了 {pct_abs(k.v["ret1"])}'
            return fit(f'⛈️ {st_}{lead}', f'⛈️ {st_}'), fit(f'⛈️ {st_}{lead}', f'⛈️ {st_}')
        return fit(f'⛈️ {st_}，过山车'), fit(f'⛈️ {st_}')
    if s >= 1.5:
        return f'⛈️ 大风暴：波动是平时的 {x} 倍，过山车', f'⛈️ 大风暴：波动是平时的 {x} 倍'
    return f'🌧️ 有风暴：波动是平时的 {x} 倍，坐稳', f'🌧️ 有风暴：波动是平时的 {x} 倍'


def stock_in_say(n: Node) -> tuple[str, str]:
    v = n.v
    r5 = v.get('ret5')
    if isnum(r5) and r5 <= -0.02:
        return f'价格跌了 {pct_abs(r5)}，钱却在底下接货', f'价格跌了 {pct_abs(r5)}，钱却在偷偷进来'
    if v['front'] > 0:
        pt = price_text(r5) if isnum(r5) and abs(r5) >= 0.003 else ''
        return ('风向刚掉头，' + (pt or '钱刚杀进来')), ('风向刚变，' + (pt or '钱刚掉头进来'))
    crowded = isnum(v['pres']) and v['pres'] >= 90
    mild = join(ratio_text(v), '已经人挤人' if crowded else price_text(r5)) or wind_word(v['wind'])
    if crowded:
        sharp = join(f'进钱是平时的 {times(v["ratio"])} 倍' if ratio_text(v) else '', '挤成这样还在冲') or '挤成这样还在冲'
    else:
        sharp = join(f'进钱是平时的 {times(v["ratio"])} 倍' if ratio_text(v) else '', price_text(r5)) or wind_sharp(v['wind'], n.id)
    return sharp, mild


def stock_out_say(n: Node) -> tuple[str, str]:
    v = n.v
    r5 = v.get('ret5')
    if isnum(r5) and r5 >= 0.02:
        return f'还涨了 {pct_abs(r5)}，钱却从后门溜了', f'价格涨了 {pct_abs(r5)}，钱却在悄悄溜走'
    if v['front'] < 0:
        pt = price_text(r5) if isnum(r5) and abs(r5) >= 0.003 else ''
        return ('风向刚翻脸，' + (pt or '钱开始撤')), ('风向刚变，' + (pt or '钱开始往外撤'))
    mild = join(ratio_text(v), price_text(r5)) or wind_word(v['wind'])
    sharp = join(f'撤钱是平时的 {times(v["ratio"])} 倍' if ratio_text(v) else '', price_text(r5)) or wind_sharp(v['wind'], n.id)
    return sharp, mild


# ════════════════════════════ 主航道：钱从哪搬到哪（与 words.js mainChannel 同一套规矩） ════════════════════════════


def amt(n) -> float:
    return abs(n.v['flow5']) if isnum(n.v['flow5']) else 0.0


def story_strength(n: Node, sign: int) -> float:
    """这股风有多值得当主角：钱的量（开根号，亿美元）×（风 + 一半的 5 天加速 + 风向刚变 0.6）。
    风要够（≥0.3），钱的方向要对得上，不然 0。真钱（§23）和估算方向相反的，也不当主角（words.js 没有真钱，只有这里多这一条）。"""
    v = n.v
    w = v['wind']
    if not isnum(w) or sign * w < 0.3:
        return 0.0
    if isnum(v['flow5']) and not (sign * v['flow5'] > 0):
        return 0.0
    if sign > 0 and n.P and n.P.get('crash'):     # 暴跌闸门（§8 修订）：正在暴跌的地方不当「钱流进去」的那头（和 words.js 一样）
        return 0.0
    if CUR is not None and real_off(CUR.real_of(n), v['flow5']):
        return 0.0
    yi = abs(v['flow5']) / 100 if isnum(v['flow5']) else 1.0
    dw = n.P['dw'] if n.P else 0.0
    push = sign * w + 0.5 * max(0.0, sign * dw) + (0.6 if sign * v['front'] > 0 else 0.0)
    return math.sqrt(max(yi, 0.01)) * push


class Story:
    def __init__(self, src=None, dst=None, dst2=None, strength=0.0, weak=False):
        self.src: Node | None = src
        self.dst: Node | None = dst
        self.dst2: Node | None = dst2
        self.strength = strength
        self.weak = weak
        self.single: Node | None = None     # 终点的钱几乎全是一只股票（≥ 60%）→ 那只股票

    def __bool__(self):
        return bool(self.src or self.dst)


def pick_story(pool: list[Node]) -> Story:
    ins = sorted([(n, story_strength(n, 1)) for n in pool], key=lambda x: -x[1])
    ins = [x for x in ins if x[1] > 0]
    outs = sorted([(n, story_strength(n, -1)) for n in pool], key=lambda x: -x[1])
    outs = [x for x in outs if x[1] > 0]
    dst = ins[0][0] if ins else None
    src = outs[0][0] if outs else None
    # 起点和终点的钱数要对得上，不能拿 1000 万的流出去解释 300 亿的流入
    if dst and src and amt(src) < 0.1 * amt(dst):
        src = next((n for n, _ in outs if amt(n) >= 0.1 * amt(dst)), None)
    if dst and src and amt(dst) < 0.1 * amt(src):
        dst = next((n for n, _ in ins if amt(n) >= 0.1 * amt(src)), None)
    sd = dict(ins).get(dst, 0.0) if dst else 0.0
    ss = dict(outs).get(src, 0.0) if src else 0.0
    dst2 = next((n for n, s in ins if n is not dst and s >= 0.6 * sd and amt(n) >= 0.25 * amt(dst)), None) if dst else None
    st = min(sd, ss) if (dst and src) else max(sd, ss)
    return Story(src, dst, dst2, st)


def channel_for(pool: list[Node]) -> Story:
    """箭头必须两头都有：只有一头时，另一头用风向对、钱数对得上的最大那块（标 weak）。"""
    S = pick_story(pool)
    if not S:
        return S
    clash = lambda n: CUR is not None and real_off(CUR.real_of(n), n.v['flow5'])
    # 先找钱数对得上的（≥ 10%）；没有就退一步（≥ 2%），标 weak「不太明显」——
    # 地图上总得有一根和标题说同一件事的箭头（§8.1），别让前端退回到只看风的箭头
    if S.dst and not S.src:
        for frac in (0.1, 0.02):
            xs = [n for n in pool if n is not S.dst and isnum(n.v['wind']) and n.v['wind'] < 0
                  and isnum(n.v['flow5']) and n.v['flow5'] < 0 and amt(n) >= frac * amt(S.dst) and not clash(n)]
            if xs:
                S.src, S.weak = max(xs, key=amt), True
                break
    elif S.src and not S.dst:
        for frac in (0.1, 0.02):
            xs = [n for n in pool if n is not S.src and isnum(n.v['wind']) and n.v['wind'] > 0
                  and isnum(n.v['flow5']) and n.v['flow5'] > 0 and amt(n) >= frac * amt(S.src) and not clash(n)]
            if xs:
                S.dst, S.weak = max(xs, key=amt), True
                break
    return S


# ──────────── 一只股票撑起一整块地（§6 别把一只票讲成板块轮动） ────────────
SINGLE = 0.6


def top_stock(W: 'World', n: Node) -> tuple[Node | None, float]:
    """n 下面 5 天进出最大、方向和 n 一样的那只股票，和它占 n 的几成。"""
    f = n.v['flow5']
    if n.is_stock or not isnum(f) or abs(f) < 1:
        return None, 0.0
    best = None
    for s in W.under.get(n.id, []):
        fs = s.v['flow5']
        if isnum(fs) and fs * f > 0 and (best is None or abs(fs) > abs(best.v['flow5'])):
            best = s
    return (best, abs(best.v['flow5']) / abs(f)) if best is not None else (None, 0.0)


def single_of(W: 'World', n: Node | None) -> Node | None:
    """n 的 5 天进出几乎全是一只股票（≥ 60%）→ 那只股票；否则 None。有真钱的地方（ETF 区域）不这么算。"""
    if n is None or n.is_stock or W.real_of(n) is not None:
        return None
    st, share = top_stock(W, n)
    return st if (st is not None and share >= SINGLE) else None


def driver_chain(W: 'World', n: Node, sign: int) -> list[Node]:
    """顺着钱往下找「最深的那个推手」：只要有一个孩子扛了父亲 ≥ 60% 的进出（方向相同），就往下走一层。
    有真钱的地方按真钱比（估算在 ETF 上会差几十倍），没有就按估算；最后一块地若几乎全是一只股票，就落到那只股票。"""
    chain = [n]
    cur = n
    used_real = False
    while not cur.is_stock and len(chain) < 7:
        rc = W.real_of(cur)
        rm = rc is not None and not real_off(rc, cur.v['flow5'])
        f_cur = rc['flow5'] if rm else cur.v['flow5']
        if not isnum(f_cur) or sign * f_cur <= 0:
            break
        best, bf = None, 0.0
        for c in cur.raw.get('children') or []:
            k = W.nodes.get(c['id'])
            if k is None or not k.series:
                continue
            if rm:
                rk = W.real_of(k)
                fk = rk['flow5'] if rk else None
            else:
                fk = k.v['flow5']
            if isnum(fk) and sign * fk > sign * bf:
                best, bf = k, fk
        if best is None or sign * bf < SINGLE * sign * f_cur:
            break
        used_real = used_real or rm
        chain.append(best)
        cur = best
    if not chain[-1].is_stock and not used_real:
        st = single_of(W, chain[-1])
        if st is not None:
            chain.append(st)
    return chain


def singles_map(W: 'World') -> dict:
    """每块地（不是股票、5 天进出 ≥ 1 亿美元）：钱几乎全是一只股票（≥ 60%）时 → {id: {id, name, ticker, share}}。
    给 words.regionWeather / mainChannel 的 opts.singles 用（只对今天有效），任何星球上都不把一只票讲成板块轮动。"""
    out = {}
    for n in W.order:
        if n.is_stock or not n.series or n.depth < 1 or not isnum(n.v['flow5']) or abs(n.v['flow5']) < 100:
            continue
        st = single_of(W, n)
        if st is not None:
            out[n.id] = {'id': st.id, 'name': st.name, 'ticker': st.ticker, 'share': round(share_of(st, n), 2)}
    return out


def channel_say(S: Story, where: str = '') -> tuple[str, str]:
    """where='美股里' 时说「美股里的主航道」。终点几乎全是一只股票时，不讲成板块轮动，直说是那一只。"""
    a, b = S.src, S.dst
    lead_s = f'{where}的主航道' if where else '今天的主航道'
    if b is not None and S.single is not None:
        t = B(S.single.name)
        return (fit(f'{where}钱扎堆{B(b.name)}——几乎全是{t}一只', f'{where}钱扎堆{t}一只'),
                fit(f'{where}流进{B(b.name)}的钱，几乎都进了{t}', f'{where}钱主要流进了{t}'))
    if a and b:
        to = B(b.name) + (f'和{B(S.dst2.name)}' if S.dst2 else '')
        if S.weak:
            return (f'{lead_s}不太明显：钱勉强从{B(a.name)}挪向{to}',
                    f'{lead_s}不太明显：钱从{B(a.name)}慢慢流向{to}')
        verb = '撤出，奔向' if (a.v['wind'] or 0) > -1.5 else '夺门而出，冲进'
        return fit(f'{lead_s}：钱从{B(a.name)}{verb}{to}', f'{lead_s}：钱从{B(a.name)}{verb}{B(b.name)}'), \
            fit(f'{lead_s}：钱从{B(a.name)}流向{to}', f'{lead_s}：钱从{B(a.name)}流向{B(b.name)}')
    if b:
        return f'{lead_s}：钱在往{B(b.name)}灌，源头很散', f'{lead_s}：钱在流进{B(b.name)}'
    if a:
        return f'{lead_s}：钱在逃离{B(a.name)}，去向很散', f'{lead_s}：钱在离开{B(a.name)}'
    return '今天没有主航道，风平浪静', '今天没有明显的主航道'


def channel_obj(S: Story, where: str = '') -> dict | None:
    if not (S.src and S.dst):
        return None
    s, m = channel_say(S, where)
    d = {'from': S.src.id, 'to': S.dst.id, 'to2': S.dst2.id if S.dst2 else None,
         'fromName': S.src.name, 'toName': S.dst.name,
         'strength': r2(S.strength), 'weak': bool(S.weak or S.single is not None), 'say': s, 'sayMild': m}
    if S.single is not None:   # 一只股票撑起来的「轮动」不算真轮动：weak，前端不会把它升成主角
        d['single'] = {'id': S.single.id, 'ticker': S.single.ticker, 'name': S.single.name}
    return d


# ════════════════════════════ 故事主线（§6 / §8.1：标题第一拍 = 主角 = ①，②③ 和巡航按同一个顺序） ════════════════════════════
# 主角（hero）的选法和 web/js/main.js computeChannel 一样，地图上画的和这里说的才是同一件事：
#   'arrow'  地球上的主航道两头都实（不 weak）→ 主角是那根箭头，① = 终点（顺着钱往下找到的推手）
#   'inner'  地球上的主航道 weak，但美股里有一条实的（不 weak、不是一只股票撑起来的）→ 主角在美股里
#   'sink' / 'source'  地球上的主航道 weak，而且美股里没有实的 → 主角是更实的那一头（钱多的那头）
# 第二拍（②）：主角在地球上 → 美股里那条；主角在美股里 → 地球上实的那头；都没有 → 一个尾巴（风向刚变 / 台风 / 最热 / 最挤 / 最冷）。
# ③：持仓（§20，有动静时）或 surprise 最高的、和 ①② 不在同一块大陆上的。巡航：① → 钱从哪来 → ② → ③ → 一只股票。


class Beat:
    def __init__(self, node: Node, sign: int, role: str, chain: list[Node] | None = None, story: Story | None = None,
                 tail: tuple[str, str] | None = None):
        self.node, self.sign, self.role, self.story, self.tail = node, sign, role, story, tail
        self.chain = chain or [node]

    @property
    def spot(self) -> Node:
        return self.chain[-1]


class Spine:
    def __init__(self):
        self.hero: str | None = None
        self.beats: list[Beat] = []
        self.src: Node | None = None          # 主角的「钱从哪来」（巡航第 2 站）
        self.src_weak = False
        self.S1: Story = Story()
        self.S2: Story = Story()


def world_cont(n: Node) -> str:
    return n.path_ids[1] if len(n.path_ids) > 1 else n.id


def real_turn(W: 'World', n: Node, sign: int) -> tuple[str, str]:
    """标题尾巴说的是温度 / 风向（「冷成冰窖」「烧得最旺」），真钱却明显往反方向走时，把真钱补上半句：
    「，真钱却在抄底」——全球地图的大中华冷成冰窖、A股 ETF 5 天净申购几百亿时，标题不能只说冷。"""
    r = W.real_of(n)
    if not r or not r.get('realMat') or not isnum(r.get('flow5')) or (r['flow5'] > 0) == (sign > 0):
        return '', ''
    return ('，真钱却在抄底', '，真钱却在流入') if r['flow5'] > 0 else ('，真钱却在撤', '，真钱却在流出')


def tail_beats(W: 'World', taken: set, named: list[Node]) -> list[Beat]:
    """标题的尾巴候选（和 tail_sentence 同一套：风向刚变 / 大风暴 / 最热 / 人挤人 / 最冷），不在已占的大陆上。
    真钱（§23）明显往反方向走时，尾巴补半句真钱（real_turn）。"""
    C = [n for n in W.continents() if isnum(n.v['wind']) and world_cont(n) not in taken
         and all(not W.related(n, x) for x in named)]
    out = []
    for x in sorted([n for n in C if n.v['front'] != 0], key=lambda n: -n.P['score'])[:1]:
        out.append(Beat(x, 1 if x.v['front'] > 0 else -1, 'tail',
                        tail=(f'{B(x.name)}风向{"刚掉头" if x.v["front"] > 0 else "刚翻脸"}', f'{B(x.name)}风向刚变')))
    for x in sorted([n for n in C if isnum(n.v['storm']) and n.v['storm'] >= 1.5], key=lambda n: -n.v['storm'])[:1]:
        out.append(Beat(x, 1 if (x.v['wind'] or 0) >= 0 else -1, 'tail', tail=(f'{B(x.name)}在刮台风', f'{B(x.name)}起了大风暴')))
    for x in sorted([n for n in C if isnum(n.v['temp']) and n.v['temp'] >= 0.5], key=lambda n: -n.v['temp'])[:1]:
        out.append(Beat(x, 1, 'tail', tail=(f'{B(x.name)}烧得最旺', f'{B(x.name)}最热' if x.v['temp'] >= 1 else f'{B(x.name)}稍微热一点')))
    for x in sorted([n for n in C if isnum(n.v['pres']) and n.v['pres'] >= 90], key=lambda n: -n.v['pres'])[:1]:
        out.append(Beat(x, 1 if (x.v['wind'] or 0) >= 0 else -1, 'tail', tail=(f'{B(x.name)}已经挤爆', f'{B(x.name)}已经人挤人')))
    for x in sorted([n for n in C if isnum(n.v['temp']) and n.v['temp'] <= -1], key=lambda n: n.v['temp'])[:1]:
        out.append(Beat(x, -1, 'tail', tail=(f'{B(x.name)}冷成冰窖', f'{B(x.name)}最冷')))
    for b in out:
        ts, tm = real_turn(W, b.node, b.sign)
        if ts:
            b.tail = (b.tail[0] + ts, b.tail[1] + tm)
    return out


def build_spine(W: 'World', S1: Story, S2: Story) -> Spine:
    sp = Spine()
    sp.S1, sp.S2 = S1, S2
    inner_ok = bool(S2 and S2.src and S2.dst and not S2.weak and S2.single is None)
    if S1.src and S1.dst and not S1.weak:
        sp.hero = 'arrow'
    elif S1.weak and inner_ok:
        sp.hero = 'inner'
    elif S1.src and S1.dst:
        sp.hero = 'sink' if amt(S1.dst) >= amt(S1.src) else 'source'
    elif S1.dst:
        sp.hero = 'sink'
    elif S1.src:
        sp.hero = 'source'
    elif S2 and (S2.dst or S2.src):
        sp.hero = 'inner'
    if sp.hero is None:
        return sp
    # 第一拍
    if sp.hero == 'inner':
        main, sign = (S2.dst, 1) if S2.dst else (S2.src, -1)
        b1 = Beat(main, sign, 'hero', driver_chain(W, main, sign), story=S2)
        sp.src = S2.src if S2.dst else None
    elif sp.hero in ('arrow', 'sink'):
        b1 = Beat(S1.dst, 1, 'hero', driver_chain(W, S1.dst, 1), story=S1)
        sp.src, sp.src_weak = S1.src, sp.hero == 'sink' and S1.src is not None
    else:
        b1 = Beat(S1.src, -1, 'hero', driver_chain(W, S1.src, -1), story=S1)
        sp.src, sp.src_weak = None, False
    # 主角就是一整块【美股】：往里看，美股里那条才是推手（一块大陆只能有一个号码）
    if b1.node.id == 'us' and S2:
        inner_end = S2.dst if b1.sign > 0 else S2.src
        if inner_end is not None:
            b1.chain = [b1.node] + driver_chain(W, inner_end, b1.sign)
    sp.beats.append(b1)
    taken = {world_cont(b1.node)}
    named = [x for x in (S1.src, S1.dst, S1.dst2) if x] if sp.hero != 'inner' else [x for x in (S2.src, S2.dst, S2.dst2) if x]
    # 第二拍
    b2 = None
    if sp.hero != 'inner' and S2 and S2.dst is not None and world_cont(S2.dst) not in taken:
        b2 = Beat(S2.dst, 1, 'inner', driver_chain(W, S2.dst, 1), story=S2)
    elif sp.hero == 'inner' and (S1.dst or S1.src):
        sure, sg = ((S1.dst, 1) if (S1.dst and (not S1.src or amt(S1.dst) >= amt(S1.src))) else (S1.src, -1))
        if world_cont(sure) not in taken:
            b2 = Beat(sure, sg, 'world', driver_chain(W, sure, sg), story=S1)
    if b2 is None:
        tb = tail_beats(W, taken, named + [b1.spot])
        b2 = tb[0] if tb else None
    if b2 is not None:
        # 地图上一屏最多一只股票：两拍都落到股票时，第二拍停在它那块地上
        if b1.spot.is_stock and b2.spot.is_stock and len(b2.chain) > 1:
            b2.chain = b2.chain[:-1]
        sp.beats.append(b2)
    return sp


def hero_say(W: 'World', sp: Spine) -> tuple[str, str]:
    """标题第一拍（不带句号）。涌进 / 狂灌只在终点的风 > 1.5 且主航道不 weak 时才说，不然说流进；
    终点的真钱方向一致时，开口就说「真钱」。"""
    S1, S2 = sp.S1, sp.S2
    b1 = sp.beats[0] if sp.beats else None
    if b1 is None:
        return '', ''
    real = lambda n: W.real_of(n) is not None and not real_off(W.real_of(n), n.v['flow5'])
    if sp.hero == 'arrow':
        a, b = S1.src, S1.dst
        two = f'和{B(S1.dst2.name)}' if S1.dst2 else ''
        lead = '真钱' if (real(a) and real(b)) else '钱'
        return (whole_fit([f'{lead}从{B(a.name)}跑去{B(b.name)}{two}', f'{lead}从{B(a.name)}跑去{B(b.name)}']),
                whole_fit([f'{lead}正从{B(a.name)}搬到{B(b.name)}{two}', f'{lead}正从{B(a.name)}搬到{B(b.name)}']))
    if sp.hero == 'inner':
        a, b = S2.src, S2.dst
        if a and b:
            y2 = B(b.name) + (f'和{B(S2.dst2.name)}' if S2.dst2 else '')
            return (whole_fit([f'美股里钱从{B(a.name)}跑去{y2}', f'美股里钱从{B(a.name)}跑去{B(b.name)}']),
                    whole_fit([f'美股里，钱从{B(a.name)}流向{y2}', f'美股里，钱从{B(a.name)}流向{B(b.name)}']))
        x = b or a
        return (f'美股里钱在{"涌进" if b else "撤出"}{B(x.name)}', f'美股里，钱在{"流进" if b else "离开"}{B(x.name)}')
    n = b1.node
    w = n.v['wind'] or 0
    lead = '真钱' if real(n) else '钱'
    one = single_of(W, n)
    tail = f'（几乎全是{B(one.name)}一只）' if one is not None else ''
    if sp.hero == 'sink':
        strong = w > 1.5 and not S1.weak
        return (fit(f'{lead}在{"狂灌进" if strong else "流进"}{B(n.name)}{tail}', f'{lead}在{"狂灌进" if strong else "流进"}{B(n.name)}'),
                fit(f'{lead}在{"狂涌进" if strong else "流进"}{B(n.name)}{tail}', f'{lead}在流进{B(n.name)}'))
    strong = w < -1.5 and not S1.weak
    return (fit(f'{lead}在{"逃离" if strong else "撤出"}{B(n.name)}{tail}', f'{lead}在{"逃离" if strong else "撤出"}{B(n.name)}'),
            fit(f'{lead}在{"逃离" if strong else "离开"}{B(n.name)}{tail}', f'{lead}在离开{B(n.name)}'))


def beat2_say(W: 'World', sp: Spine) -> tuple[list[str], list[str]]:
    """标题第二拍的几个说法（由长到短）。"""
    if len(sp.beats) < 2:
        return [], []
    b2 = sp.beats[1]
    if b2.role == 'tail':
        return [b2.tail[0]], [b2.tail[1]]
    if b2.role == 'world':
        n = b2.node
        lead = '真钱' if (W.real_of(n) is not None and not real_off(W.real_of(n), n.v['flow5'])) else '钱'
        if b2.sign > 0:
            return [f'大方向上{lead}在流进{B(n.name)}', f'{lead}在流进{B(n.name)}'], [f'大方向上，{lead}在流进{B(n.name)}', f'{lead}在流进{B(n.name)}']
        return [f'大方向上{lead}在撤出{B(n.name)}', f'{lead}在撤出{B(n.name)}'], [f'大方向上，{lead}在离开{B(n.name)}', f'{lead}在离开{B(n.name)}']
    S2 = b2.story or sp.S2
    x = B(S2.src.name) if S2.src else ''
    y = B(S2.dst.name)
    if S2.single is not None:
        t = B(S2.single.name)
        y2 = f'{t}和{B(S2.dst2.name)}' if (S2.dst2 and single_of(W, S2.dst2) is None) else ''
        sharp = ([f'美股里钱扎堆{y2}'] if y2 else []) + [f'美股里钱扎堆{t}一只', f'美股里{t}一只吸走大钱']
        mild = ([f'美股里，钱主要进了{y2}'] if y2 else []) + [f'美股里，钱主要进了{t}一只', f'美股里，钱几乎都进了{t}']
        return sharp, mild
    y2 = y + (f'和{B(S2.dst2.name)}' if S2.dst2 else '')
    if x:
        verb = vary(S2.dst.id + str(W.asOf), ['吃肉', '捡钱', '接住了钱'])
        return ([f'美股里{x}失血，{y}{verb}', f'美股里{x}的钱跑去了{y2}', f'美股里钱冲进{y}'],
                [f'美股里，钱从{x}流向{y2}', f'美股里，钱从{x}流向{y}', f'美股里，钱在流进{y}'])
    return [f'美股里钱在往{y2}灌', f'美股里钱在往{y}灌'], [f'美股里，钱在流进{y2}', f'美股里，钱在流进{y}']


def headline(W: World, sp: Spine) -> tuple[str, str]:
    """一句话 = 故事主线的前两拍：第一拍是主角（和地图上的主航道 / 主角圈是同一件事，也是 ①），第二拍是 ②。"""
    if not W.top():
        return '今天的天气数据还没准备好。', '今天的天气数据还没准备好。'
    h_s, h_m = hero_say(W, sp)
    b_s, b_m = beat2_say(W, sp)
    if not h_s:
        S = sp.S1 if sp.S1 else Story()
        return tail_sentence(W, S, '', '')
    if b_s:
        s = whole_fit([f'{h_s}；{x}。' for x in b_s] + [f'{h_s}。'])
        m = whole_fit([f'{h_m}；{x}。' for x in b_m] + [f'{h_m}。'])
        return s, m
    return h_s + '。', h_m + '。'


def whole_fit(cands: list[str], limit=MAX_HAN) -> str:
    """整句（含分号两拍）≤ limit 个汉字的第一个；都超就退回到每个分句 ≤ 30 字的。"""
    for c in cands:
        if han_len(c) <= limit:
            return c
    return fit(*cands)


def tail_sentence(W: World, S: Story, head_s: str, head_m: str) -> tuple[str, str]:
    """只有一层故事时，加一个最值得提的尾巴（风向刚变 / 大风暴 / 最热 / 人挤人 / 最冷）。"""
    C = [n for n in W.continents() if isnum(n.v['wind'])]
    named = [x for x in (S.src, S.dst, S.dst2) if x]
    calm = not head_s
    if calm:
        head_s, head_m = '全球风平浪静', '全球风平浪静'

    def free(n):
        return all(not W.related(n, x) for x in named)

    tails: list[tuple[str, str]] = []
    fr = sorted([n for n in C if n.v['front'] != 0 and free(n)], key=lambda n: -n.P['score'])
    if fr:
        x = fr[0]
        tails.append((f'{"但" if calm else ""}{B(x.name)}风向{"刚掉头" if x.v["front"] > 0 else "刚翻脸"}',
                      f'{"但" if calm else ""}{B(x.name)}风向刚变'))
    st = sorted([n for n in C if isnum(n.v['storm']) and n.v['storm'] >= 1.5 and free(n)], key=lambda n: -n.v['storm'])
    if st:
        tails.append((f'{"但" if calm else ""}{B(st[0].name)}在刮台风', f'{"但" if calm else ""}{B(st[0].name)}起了大风暴'))
    hot = sorted([n for n in C if isnum(n.v['temp']) and n.v['temp'] >= 0.5], key=lambda n: -n.v['temp'])
    if hot and free(hot[0]):
        x = hot[0]
        rs, rm = real_turn(W, x, 1)
        tails.append((f'{B(x.name)}烧得最旺{rs}', (f'{B(x.name)}最热' if (x.v['temp'] >= 1 or not calm) else f'{B(x.name)}稍微热一点') + rm))
    elif hot and S.dst is hot[0]:
        tails.append(('那里也烧得最旺', '那里也最热'))
    pk = sorted([n for n in C if isnum(n.v['pres']) and n.v['pres'] >= 90 and free(n)], key=lambda n: -n.v['pres'])
    if pk:
        tails.append((f'{B(pk[0].name)}已经挤爆', f'{B(pk[0].name)}已经人挤人'))
    cold = sorted([n for n in C if isnum(n.v['temp']) and n.v['temp'] <= -1 and free(n)], key=lambda n: n.v['temp'])
    if cold:
        rs, rm = real_turn(W, cold[0], -1)
        tails.append((f'{B(cold[0].name)}冷成冰窖{rs}', f'{B(cold[0].name)}最冷{rm}'))
    if calm:
        tails.append(('没什么大动静', '没什么大动静'))
    for ts, tm in tails:
        s, m = f'{head_s}，{ts}。', f'{head_m}，{tm}。'
        if han_len(s) <= MAX_HAN and han_len(m) <= MAX_HAN:
            return s, m
    return head_s + '。', head_m + '。'


# ════════════════════════════ 全市场雷达（web/data/fm/candidates.json，可选） ════════════════════════════


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _days_apart(a: str, b: str):
    try:
        from datetime import date
        return abs((date.fromisoformat(str(a)[:10]) - date.fromisoformat(str(b)[:10])).days)
    except Exception:
        return None


EST_AMT = re.compile(r'(\d+(?:\.\d+)?(?:万亿|亿|万)美元)(?!（估）)')


def mark_est(txt: str) -> str:
    """别的模块写好的句子里的钱数也是估算（§14）：第一个金额后面补「（估）」（已经标了真钱 / 估的不动）。"""
    if not txt or '真钱' in txt or '估' in txt:
        return txt
    out = EST_AMT.sub(lambda m: m.group(1) + '（估）', txt, count=1)
    return out if all(han_len(x) <= MAX_HAN for x in re.split(r'[。！？；]', out)) else txt


class Radar:
    """精选地图之外冒出来的东西：全市场雷达（web/data/fm/candidates.json）和全球雷达（web/data/gl，§23）。
    两个雷达加起来最多占 1 个亮点、1–2 站巡航，各自标「全市场雷达」/「全球雷达」。"""

    def __init__(self, W: World, path: Path | None, label: str = '全市场雷达', map_kind: str = 'full',
                 max_age_days: int = 0, items: list | None = None, paths_dir: Path | None = None):
        self.items: list[dict] = []
        self.label, self.map_kind = label, map_kind
        raw = None
        if items is not None:
            raw = {'items': items}
            path = paths_dir / 'candidates.json' if paths_dir else None
        elif path is None or not path.exists():
            return
        else:
            try:
                raw = json.loads(path.read_text(encoding='utf-8'))
            except Exception as e:
                print(f'[brief] 读不了{label}候选 {path}: {e}', file=sys.stderr)
                return
        asof = raw.get('asOf') if isinstance(raw, dict) else None
        if asof and W.asOf and asof != W.asOf:
            gap = _days_apart(asof, W.asOf)
            if not max_age_days or gap is None or gap > max_age_days:
                print(f'[brief] {label}候选是 {asof} 的，今天是 {W.asOf}，先不用', file=sys.stderr)
                return
        if isinstance(raw, list):
            items = raw
        else:
            items = raw.get('candidates') or raw.get('items') or ((raw.get('topStocks') or []) + (raw.get('topRegions') or []))
        Radar.CRASH = {}
        fm_paths = (self._fm_paths(path.parent) if path is not None else {}) or self._fm_paths(W.dir / ('gl' if map_kind == 'global' else 'fm'))
        crash_of = Radar.CRASH
        seen_parent = set()
        out = []
        for it in items if isinstance(items, list) else []:
            if not isinstance(it, dict) or not it.get('id'):
                continue
            iid = str(it['id'])
            if iid in W.nodes:          # 精选地图上已经有：它本来就在候选里，不重复
                continue
            score = _num(it.get('score'))
            # 候选表还按旧规矩给 🌱 春 +0.5（springBonus）：和精选地图比的时候用不带加分的 base（见 surprise_parts）
            if _num(it.get('springBonus')) and _num(it.get('base')) is not None:
                score = _num(it.get('base'))
            w = _num(it.get('wind'))
            if score is None or w is None:
                continue
            dv20 = _num(it.get('dv20'))
            if dv20 is not None and dv20 < 20:     # 亮点 / 巡航要 ≥ 2000 万美元一天
                continue
            kind = it.get('kind') or ('stock' if iid.startswith('s:') else 'region')
            parent = it.get('parentName') or it.get('parent') or ''
            pkey = it.get('parentId') or parent or iid
            if pkey in seen_parent:                # 同一个行业只要一个（银行分档讲一次就够）
                continue
            dw = _num(it.get('dw5', it.get('dw')))
            pres = _num(it.get('pres'))
            front = int(_num(it.get('front')) or 0)
            sk = it.get('season') if isinstance(it.get('season'), str) else (
                (it.get('season') or {}).get('key') if isinstance(it.get('season'), dict) else None)
            if sk not in SEASONS:
                sk = season_key(w, dw, pres) if pres is not None else ('spring' if (w > 0.3 and (dw or 0) > 0.3) else None)
            cr = crash_of.get(iid) or int(_num(it.get('crash')) or 0)   # 暴跌闸门（§8 修订）：tree.json now.crash / 候选表 crash
            if cr:
                sk = CG.gate_key(sk, cr, pres) if pres is not None else (None if sk in ('spring', 'summer') else sk)
            pids = it.get('pathIds') or fm_paths.get(iid)
            texts = {k: mark_est(it[k]) for k in ('why', 'whyMild', 'caption', 'captionMild')
                     if isinstance(it.get(k), str) and it[k] and not BAD.search(it[k])
                     and all(han_len(x) <= MAX_HAN for x in re.split(r'[。！？；]', it[k]))}
            out.append({'id': iid, 'name': it.get('name') or iid.replace('s:', ''), 'kind': kind,
                        'label': label, 'map': map_kind,
                        'spotOk': it.get('spotlightOk') is not False, 'tourOk': it.get('tourOk') is not False, 'texts': texts,
                        'ticker': it.get('ticker') or (iid[2:] if iid.startswith('s:') else None),
                        'score': score, 'wind': w, 'dw': dw, 'front': front, 'pres': pres, 'season': sk, 'crash': cr,
                        'flow5': _num(it.get('flow5')), 'ret5': _num(it.get('ret5')), 'parent': parent,
                        'pathIds': pids, 'path': it.get('path') or parent,
                        'rank': score + (0.3 if front else 0.0)})
            seen_parent.add(pkey)
        out.sort(key=lambda d: -d['rank'])
        self.items = out

    CRASH: dict = {}      # id → now.crash (0/1/2) of the radar map's tree, filled by _fm_paths

    @staticmethod
    def _fm_paths(fm_dir: Path) -> dict:
        p = fm_dir / 'tree.json'
        if not p.exists():
            return {}
        try:
            t = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            return {}
        out = {}
        crash = {}

        def walk(n, trail):
            q = trail + [n['id']]
            out.setdefault(n['id'], q)
            c0 = (n.get('now') or {}).get('crash')
            if c0:
                crash[n['id']] = c0
            for c in n.get('children') or []:
                walk(c, q)
        walk(t, [])
        Radar.CRASH = crash
        return out

    def why(self, it: dict) -> tuple[str, str]:
        t = it.get('texts') or {}
        if it.get('crash'):                         # 暴跌闸门（§8 修订）：先说跌了多少，候选表写好的「钱在进」不用
            where = f'{it["parent"]}里' if it.get('parent') else ''
            r5 = it.get('ret5')
            d = f'：5天跌了 {pct_abs(r5)}' if isnum(r5) and r5 < 0 else ''
            if it['crash'] >= 2:
                return fit(f'{where}崩了{d}，人多是在逃命。', f'崩了{d}。'), fit(f'{where}暴跌{d}。', f'暴跌{d}。')
            return fit(f'{where}急跌{d}，热闹的是夺门的人。', f'急跌{d}。'), fit(f'{where}急跌{d}。', f'急跌{d}。')
        if t.get('why') and t.get('whyMild'):      # 全市场那边已经写好了（同一套老风口吻），直接用
            return t['why'], t['whyMild']
        w, f5 = it['wind'], it['flow5']
        where = f'{it["parent"]}里' if it['parent'] else ''
        money_s = f'，{flow_text(f5)}（估）' if isnum(f5) and abs(f5) >= 0.05 and (f5 > 0) == (w > 0) else ''
        if it['front'] > 0:
            return fit(f'{where}杀出的黑马：风向刚掉头{money_s}。', f'{where}的黑马：风向刚掉头。'), \
                fit(f'{where}风向刚变，钱开始流入{money_s}。', f'{where}风向刚变，钱开始流入。')
        if it['front'] < 0:
            return fit(f'{where}有人在跑：风向刚翻脸{money_s}。', f'{where}风向刚翻脸。'), \
                fit(f'{where}风向刚变，钱开始撤离{money_s}。', f'{where}风向刚变。')
        if it['season'] == 'spring':
            return fit(f'{where}刚冒芽：钱开始摸进来{money_s}。', f'{where}刚冒芽：钱开始摸进来。'), \
                fit(f'{where}钱刚开始进来，还不挤{money_s}。', f'{where}钱刚开始进来，还不挤。')
        if wind_mix(w, f5):   # 风和钱打架：说实话，再把钱数带上
            ft = f'：{flow_text(f5)}（估）'
            return fit(f'{where}{wind_sharp(w, it["id"], f5)}{ft}。', f'{wind_sharp(w, it["id"], f5)}。'), \
                fit(f'{where}{wind_word(w, f5)}{ft}。', f'{wind_word(w, f5)}。')
        return fit(f'{where}{wind_sharp(w, it["id"])}{money_s}。', f'{wind_sharp(w, it["id"])}。'), \
            fit(f'{where}{wind_word(w)}{money_s}。', f'{wind_word(w)}。')

    def caption(self, it: dict, last=False) -> tuple[str, str]:
        """巡航大字幕：「全市场雷达：美国银行里的【First Citizens】风向刚掉头，钱杀回来了。」"""
        t = it.get('texts') or {}
        if not last and t.get('caption') and t.get('captionMild') and not it.get('crash'):
            return t['caption'], t['captionMild']
        w, f5 = it['wind'], it['flow5']
        nm = B(it['name'])
        glb = it.get('map') == 'global'
        lead = ('最后看一只全球的' if glb else '最后看一只全市场的') if last else (it.get('label') or '全市场雷达')
        who = f'{it["parent"]}里的{nm}' if it['parent'] else nm
        money_s = f'，{flow_text(f5)}（估）' if isnum(f5) and abs(f5) >= 0.05 and (f5 > 0) == (w > 0) else ''
        if it.get('crash'):
            r5 = it.get('ret5')
            d = f'，5天跌了 {pct_abs(r5)}' if isnum(r5) and r5 < 0 else ''
            cs, cm = ('崩了' if it['crash'] >= 2 else '急跌') + d, ('暴跌' if it['crash'] >= 2 else '急跌') + d
            money_s = ''
        elif it['front'] > 0:
            cs, cm = '风向刚掉头，钱杀回来了', '风向刚变，钱开始流入'
        elif it['front'] < 0:
            cs, cm = '风向刚翻脸，有人在跑', '风向刚变，钱开始撤离'
        elif it['season'] == 'spring':
            cs, cm = '刚冒芽，钱开始摸进来', '钱刚开始进来，还不挤'
        else:
            cs, cm = wind_sharp(w, it['id'], f5), wind_word(w, f5)
            if wind_mix(w, f5):
                cs, cm = '：' + cs, '：' + cm
        sharp = fit(f'{lead}：{who}{cs}{money_s}。', f'{lead}：{nm}{cs}{money_s}。', f'{lead}：{nm}{cs}。')
        mild = fit(f'{lead}：{who}{cm}{money_s}。', f'{lead}：{nm}{cm}{money_s}。', f'{lead}：{nm}{cm}。')
        return sharp, mild

    def item(self, it: dict, **extra) -> dict:
        s, m = self.why(it)
        glb = it.get('map') == 'global'
        d = {'id': it['id'], 'name': it['name'], 'path': it['path'] or ('全球' if glb else '全市场'), 'pathIds': it['pathIds'],
             'radar': True, 'label': it.get('label') or '全市场雷达', 'map': it.get('map') or 'full',
             'season': season_obj(it['season'])}
        if it['ticker']:
            d['ticker'] = it['ticker']
        d.update(extra)
        d.setdefault('why', s)
        d.setdefault('whyMild', m)
        return d


def merge_radars(W: World, *radars: 'Radar') -> 'Radar':
    """全市场 + 全球两个雷达合成一张候选表（按 rank 排）。加起来最多 1 个亮点、2 站巡航（§6 / §23 注意力规矩）。"""
    R = Radar(W, None)
    seen = set()
    items = []
    for r in radars:
        for it in (r.items if r else []):
            key = it.get('ticker') or it['id']
            if key in seen:
                continue
            seen.add(key)
            items.append(it)
    items.sort(key=lambda d: -d['rank'])
    R.items = items
    return R


def global_radar(W: World, gl_dir: Path | None) -> 'Radar':
    """§23 全球雷达：web/data/gl 有 candidates.json 就用它（和 fm/candidates.json 一个形状）；
    否则从 gl/{meta,tree}.json + gl/maps 自己挑：精选地图上没有的、成交 ≥ 2000 万美元/天、按 surprise 排。
    全球各市场收盘时间不一样，晚 4 天以内的数据也算数。"""
    R0 = Radar(W, None, '全球雷达', 'global')
    if gl_dir is None or not gl_dir.is_dir():
        return R0
    cand = gl_dir / 'candidates.json'
    if cand.exists():
        return Radar(W, cand, '全球雷达', 'global', max_age_days=4)
    if not ((gl_dir / 'tree.json').exists() and (gl_dir / 'meta.json').exists()):
        return R0
    try:
        nmaps = sum(1 for _ in (gl_dir / 'maps').glob('*.json')) if (gl_dir / 'maps').is_dir() else 0
        if nmaps == 0 or nmaps > 4000:
            print(f'[brief] 全球雷达：gl/maps 有 {nmaps} 个文件，先不自己挑', file=sys.stderr)
            return R0
        G = World(gl_dir, None)
    except Exception as e:
        print(f'[brief] 读不了全球地图 {gl_dir}: {e}', file=sys.stderr)
        return R0
    gap = _days_apart(G.asOf, W.asOf) if (G.asOf and W.asOf) else None
    if gap is not None and gap > 4:
        print(f'[brief] 全球地图是 {G.asOf} 的，今天是 {W.asOf}，太旧，先不用', file=sys.stderr)
        return R0
    curated = {n.ticker for n in W.stocks() if n.ticker}
    items = []
    for n in G.order:
        if n.depth < 2 or not n.series or n.id in W.nodes:
            continue
        if n.is_stock and n.ticker in curated:
            continue
        dv20 = n.v.get('dv20')
        if not isnum(dv20) or dv20 < 20 or not isnum(n.v['wind']) or n.P['score'] <= 0:
            continue
        par = G.nodes.get(n.parent) if n.parent else None
        items.append({'id': n.id, 'name': n.name, 'kind': n.kind, 'ticker': n.ticker, 'score': round(n.P['score'], 3),
                      'wind': n.v['wind'], 'dw5': n.P['dw'], 'front': n.v['front'], 'pres': n.v['pres'],
                      'season': n.P['season'], 'flow5': n.v['flow5'], 'ret5': n.v['ret5'], 'dv20': dv20,
                      'parentId': n.parent, 'parentName': par.name if par else '', 'pathIds': list(n.path_ids),
                      'path': G.path_str(n)})
    items.sort(key=lambda d: -d['score'])
    return Radar(W, None, '全球雷达', 'global', max_age_days=4, items=items[:60], paths_dir=gl_dir)


# ════════════════════════════ 今日 3 件事 + 60 秒巡航 ════════════════════════════


def liquid_floor(W: World, q=0.6) -> float:
    """股票成交额的 60 分位：低于它的小票不占用宝贵的注意力名额。"""
    xs = sorted(n.v['dv20'] for n in W.stocks() if isnum(n.v.get('dv20')))
    return xs[int(q * (len(xs) - 1))] if xs else 0.0


def region_floor(W: World, q=0.1) -> float:
    """区域成交额的 10 分位：太小的角落（几千万美元一天）不上亮点。"""
    xs = sorted(n.v['dv20'] for n in W.regions(1) if isnum(n.v.get('dv20')))
    return xs[int(q * (len(xs) - 1))] if xs else 0.0


def holding_loud(n: Node) -> bool:
    """§20：持仓今天有风向突变 / 风暴（≥0.8）/ |风| ≥ 1.5 → 一定占一个 ①②③。"""
    v = n.v
    return bool(v['front']) or (isnum(v['storm']) and v['storm'] >= 0.8) or (isnum(v['wind']) and abs(v['wind']) >= 1.5)


def quiet_amount(n: Node, sign: int) -> str:
    """不报估算绝对数时的说法：先说倍数（≥1.5），不然说「约它 X 天的成交」（估）。"""
    rt = ratio_text(n.v)
    if rt:
        return f'进钱{rt}' if sign > 0 else f'撤钱{rt}'
    sc = scale_text(n.v.get('flow5'), n.v.get('dv20'))
    if sc:
        return f'5天净{"流入" if sign > 0 else "流出"}{sc}（估）'
    return wind_sharp(n.v['wind'], n.id)


def calmer_bigger(W: 'World', n: Node) -> bool:
    """同一层里有没有「风更平静、估算的钱数却更大」的邻居（比如美股 5 天 700 亿却只是日常）：
    有就别报 n 的估算绝对数，免得「抽水机 316 亿」和「只是日常 700 亿」摆在一起像笑话（§12 / review3 voice）。"""
    f, w = n.v['flow5'], n.v['wind']
    if not isnum(f) or not isnum(w):
        return False
    par = W.nodes.get(n.parent) if n.parent else None
    sibs = [W.nodes[c['id']] for c in (par.raw.get('children') or [])] if par else []
    for s in sibs:
        if s is n or s.kind == 'stock' and not n.is_stock:
            continue
        sf, sw = s.v.get('flow5'), s.v.get('wind')
        if isnum(sf) and isnum(sw) and abs(sw) < abs(w) and abs(sf) > abs(f):
            return True
    return False


def share_of(x: Node, n: Node) -> float:
    """x 的 5 天进出占 n 的几成（同方向才算）。"""
    fx, fn = x.v.get('flow5'), n.v.get('flow5')
    if not isnum(fx) or not isnum(fn) or fn == 0 or fx * fn <= 0:
        return 0.0
    return abs(fx) / abs(fn)


def tail_kind(b: Beat) -> str:
    """尾巴那一拍说的是哪种事（标题、②、巡航第 3 站说同一件事）。"""
    t = (b.tail or ('', ''))[0]
    return ('front' if '风向' in t else 'storm' if '台风' in t else 'hot' if '最旺' in t else 'crowded' if '挤爆' in t
            else 'cold' if '冰窖' in t else 'inflow')


def tail_why(n: Node, kd: str) -> tuple[str, str, str]:
    """尾巴那一拍的「为什么」（不带名字）：和标题里的那半句是同一件事。"""
    v = n.v
    r20 = v.get('ret20')
    move = f'20天{"涨" if (r20 or 0) > 0 else "跌"}了 {pct_abs(r20)}' if isnum(r20) else ''
    if kd == 'hot':
        return 'hot', fit(f'烧得最旺：{move}，跑得比平时快。' if move else '烧得最旺，跑得比平时快。', '烧得最旺。'),             fit(f'最热：{move}，比平时快。' if move else '最热，比平时快。', '最热。')
    if kd == 'cold':
        return 'cold', fit(f'冷成冰窖：{move}，跑得比平时慢。' if move else '冷成冰窖，跑得比平时慢。', '冷成冰窖。'),             fit(f'最冷：{move}，比平时慢。' if move else '最冷，比平时慢。', '最冷。')
    if kd == 'crowded':
        p = round(v['pres']) if isnum(v['pres']) else 0
        return 'crowded', f'拥挤度 {p}：比一年里 {p}% 的日子都挤，踩踏预警。', f'拥挤度 {p}：比过去一年 {p}% 的日子都挤，小心踩踏。'
    return why_sentence(n)


def beat_why(W: 'World', sp: Spine, b: Beat) -> tuple[str, str, str]:
    """主线上那一拍的「为什么值得看」（不带自己的名字；地图卡片会把名字放前面）→ (kind, 犀利, 温和)。"""
    n, spot = b.node, b.spot
    if b.role == 'tail':
        return tail_why(spot, tail_kind(b)) if spot is n else why_sentence(spot)
    drop = calmer_bigger(W, spot)
    FT = money_phrase(spot, drop_est=drop)
    if drop and W.real_of(spot) is None:   # 和巡航第 1 站一样：旁边有更平静却更大的数，就不报估算的绝对数
        FT = quiet_amount(spot, b.sign)
    sg = b.sign
    fr = (spot.v['front'] or 0) * sg > 0
    kind = 'front' if fr else ('inflow' if sg > 0 else 'outflow')
    r = W.real_of(spot)
    if r and real_off(r, spot.v['flow5']):
        return why_sentence(spot)
    if spot is not n:
        if spot.is_stock and single_of(W, n) is spot:
            word = '进账' if sg > 0 else '出账'
            return (kind, fit(f'{B(n.name)}的{word}几乎全是它：{FT}。', f'{B(n.name)}的{word}几乎全是它。'),
                    fit(f'流{"进" if sg > 0 else "出"}{B(n.name)}的钱，几乎都是它：{FT}。', f'{B(n.name)}的钱几乎都是它带的。'))
        if share_of(spot, n) >= SINGLE:
            hs_ = f'{B(n.name)}的钱主要{"进了" if sg > 0 else "是从"}这里{"" if sg > 0 else "出去的"}'
            hm_ = f'{B(n.name)}的钱主要{"流进" if sg > 0 else "流出"}这里'
        else:
            hs_ = f'{B(n.name)}里{"吸钱最猛" if sg > 0 else "跑得最凶"}的是这里'
            hm_ = f'{B(n.name)}里{"流入最多" if sg > 0 else "流出最多"}的是这里'
        return (kind, fit(f'{hs_}：{FT}。', f'{hs_}。'), fit(f'{hm_}：{FT}。', f'{hm_}。'))
    w = n.v['wind'] or 0
    p = n.v['pres'] if isnum(n.v['pres']) else 50
    if sg > 0:
        if b.role == 'hero':
            lead_s = vary(n.id + str(W.asOf), ['今天的抽水机', '今天钱最想去这里']) if (w >= 1 and sp.hero == 'arrow') else '今天钱最想去这里'
            lead_m = '今天钱最想去这里'
        else:
            lead_s, lead_m = ('美股里钱最想去这里', '美股里钱最想去这里') if b.role == 'inner' else ('这里在吸钱', '钱在流进来')
        extra_s = '，已经挤爆了' if p >= 90 else ('，风向也刚掉头' if fr else '')
        extra_m = '，已经很挤' if p >= 90 else ('，风向也刚变' if fr else '')
    else:
        lead_s = '今天钱在从这里撤' if b.role == 'hero' else '这里在失血'
        lead_m = '今天钱在离开这里' if b.role == 'hero' else '钱在流出去'
        extra_s = '，风向也刚翻脸' if fr else ''
        extra_m = '，风向也刚变' if fr else ''
    return (kind, fit(f'{lead_s}：{FT}{extra_s}。', f'{lead_s}：{FT}。', f'{lead_s}。'),
            fit(f'{lead_m}：{FT}{extra_m}。', f'{lead_m}：{FT}。', f'{lead_m}。'))


def spotlight(W: World, R: Radar, sp: Spine | None = None, k=3, holdings: list[Node] | None = None) -> tuple[list[dict], dict | None]:
    """先看这里 ①②③ = 故事主线：① 主角（标题第一拍），② 标题第二拍，③ 持仓（§20，有动静时）或 surprise 最高的。
    不扎堆：地球上每块地（地球的孩子）最多 1 个（地图上 ①②③ 落在三块不同的地上）；最多 1 只股票；互相不包含。
    雷达（全市场 + 全球）不占精选地图的 ①②③（精选地图上没有它的格子，main.js 会悄悄换掉它）——
    明显更值得看时（比 ③ 高 0.5 分）放进 radarSpot，前端可以画成「全球 · 世纪恒通 →」的小卡片。→ (items, radarSpot)"""
    sfloor, rfloor = liquid_floor(W), region_floor(W)
    out: list[tuple] = []     # (node, kind, why, why_m, extra)

    def conflict(n):
        return any(world_cont(n) == world_cont(o) for o, *_ in out) or any(W.related(n, o) for o, *_ in out) \
            or (n.is_stock and any(o.is_stock for o, *_ in out))

    for b in (sp.beats if sp else [])[:2]:
        bb = b
        if conflict(b.spot):   # 推手是只股票、而前面已经有一只股票：退回上一层
            alts = [Beat(b.node, b.sign, b.role, b.chain[:j], b.story, b.tail) for j in range(len(b.chain) - 1, 0, -1)]
            bb = next((x for x in alts if not conflict(x.spot)), None)
            if bb is None:
                continue
        kind, why, why_m = beat_why(W, sp, bb)
        one = single_of(W, bb.node)
        out.append((bb.spot, kind, why, why_m, {'role': bb.role, 'story': 'stock' if (one is not None and one is bb.spot) else
                                                 ('rotation' if bb.role in ('hero', 'inner') and sp.hero in ('arrow', 'inner') else 'place')}))
    n_spine = len(out)
    merged_hold: dict[str, Node] = {}
    for n in holdings or []:
        if len(out) >= k:
            break
        if not (n.series and holding_loud(n)):
            continue
        if conflict(n):   # 它那块大陆已经亮了：号码给不了它，挂在那块地的亮点上（main.js 也会这样标）
            owner = next((o for o, *_ in out if world_cont(o) == world_cont(n)), None)
            if owner is not None:
                merged_hold[owner.id] = n
            continue
        kind, why, why_m = why_sentence(n)
        short_s, short_m = take_say(n)
        out.append((n, kind, fit(f'你的持仓：{why}', f'你的持仓：{short_s}。'), fit(f'你的持仓：{why_m}', f'你的持仓：{short_m}。'),
                    {'holding': True}))
    n_fixed = len(out)
    cands = [n for n in W.order if n.depth >= 1 and n.series and n.P['score'] > 0
             and ((n.v.get('dv20') or 0) >= (sfloor if n.is_stock else rfloor))]
    # 估算被真钱打脸（方向相反 / 真钱几乎没动）的，往后排 0.5 分：注意力先给站得住的故事
    doubt = lambda n: 0.5 if real_off(W.real_of(n), n.v['flow5']) else 0.0
    cands.sort(key=lambda n: -(n.P['score'] - doubt(n)))
    for relax in (False, True):
        for n in cands:
            if len(out) >= k:
                break
            if any(n is o for o, *_ in out) or conflict(n):
                continue
            kind, why, why_m = why_sentence(n)
            lead = lambda x: x.split('：')[0]
            for salt in ('1', '2', '3'):  # 同一屏里开头别一模一样（读起来像复读机）
                if not any(lead(why) == lead(w) for _, _, w, *_ in out):
                    break
                kind, why, why_m = why_sentence(n, salt)
            if not relax and sum(1 for _, kd, *_ in out if kd == kind) >= 2:
                continue
            if any(why == w for _, _, w, *_ in out):
                continue
            out.append((n, kind, why, why_m, {}))
    out = out[:n_fixed] + sorted(out[n_fixed:], key=lambda x: -(x[0].P['score'] - doubt(x[0])))
    items = []
    for n, kind, why, why_m, extra in out[:k]:
        it = base_item(W, n, **said((why, why_m), n, 'why'), score=r2(n.P['score']), kind=kind, **extra)
        if n.is_stock and 'season' not in it:
            # 深处的亮点（一只股票）也带上它的季节（过了暴跌闸门的）：地图上 ①②③ 的季节章用它，main.js resolveDeep
            # 先用 brief 的季节——不然壳子在暴跌闸门装好之前算的「🌱 春」会一直挂在「崩了 37%」旁边
            it['season'] = season_obj(n.season)
        rl = real_info(W.real_of(n))
        if rl:
            it['real'] = rl
        h = merged_hold.get(n.id)
        if h is not None:
            hs, hm = holding_say(h)
            it['holdingAlso'] = {'id': h.id, 'name': h.name, 'say': fit(f'你的持仓{B(h.name)}：{hs}'), 'sayMild': fit(f'你的持仓{B(h.name)}：{hm}')}
        items.append(it)
    for j, it in enumerate(items, 1):
        it['n'] = j
    radar_spot = None
    spot_ok = [it for it in R.items if it['spotOk']]
    if spot_ok:
        best = spot_ok[0]
        third = items[-1]['score'] if len(items) >= k else -1
        if best['score'] >= (third or 0) + 0.5 or len(items) < k:
            kind = 'front' if best['front'] else ('inflow' if best['wind'] >= 0 else 'outflow')
            radar_spot = R.item(best, score=r2(best['score']), kind=kind)
    return items, radar_spot


def tour_kind(n: Node) -> str:
    v = n.v
    if v['front'] != 0:
        return 'front'
    d = dominant(n.P)
    if isnum(v['storm']) and v['storm'] >= 0.8 and d in ('storm', 'heat', 'crowd'):
        return 'storm'
    if isnum(v['pres']) and v['pres'] >= 85 and d in ('crowd', 'heat', 'storm'):
        return 'crowded'
    if isnum(v['storm']) and v['storm'] >= 1.2:
        return 'storm'
    if isnum(v['pres']) and v['pres'] >= 92:
        return 'crowded'
    return 'inflow' if (v['wind'] or 0) >= 0 else 'outflow'


def stock_story(n: Node) -> tuple[str, str, str] | None:
    """一只股票有没有好故事 → (kind, 犀利, 温和)。"""
    v = n.v
    w, f5, r5 = v['wind'] or 0, v['flow5'], v.get('ret5')
    cw = crash_words(n.P.get('crash') if n.P else None)    # 暴跌闸门（§8 修订）：一跌就是故事，别说「有人在底下接货」
    if cw:
        return 'storm', cw[0], cw[1]
    if isnum(r5) and isnum(f5) and r5 <= -0.02 and f5 > 0 and (w >= 0.3 or (v.get('ratio') or 0) >= 0.8):
        return 'inflow', '价格在跌，钱却在底下接货', '价格在跌，但钱在偷偷进来'
    if isnum(r5) and isnum(f5) and r5 >= 0.02 and f5 < 0 and (w <= -0.3 or (v.get('ratio') or 0) >= 0.8):
        return 'outflow', '还在涨，钱却从后门溜了', '价格在涨，但钱在悄悄溜走'
    if v['front'] > 0:
        if isnum(f5) and f5 < -0.05:   # 风 = 关注度 + 钱：钱没跟上就别说「杀回来」
            return 'front', '风向刚掉头，可只是人气回来，钱还没跟上', '风向刚变，买卖的人回来了，钱还没净流入'
        return 'front', '风向刚掉头，钱杀回来了', '风向刚变，钱开始流进来'
    if v['front'] < 0:
        if isnum(f5) and f5 > 0.05:
            return 'front', '风向刚翻脸，人气在散，钱倒还没走', '风向刚变，人气在退，钱还在小幅流入'
        return 'front', '风向刚翻脸，钱开始撤', '风向刚变，钱开始往外撤'
    if isnum(v['storm']) and v['storm'] >= 1.5:
        x = times(v['storm'] + 1)
        return 'storm', f'起大风暴，波动是平时的 {x} 倍', f'起大风暴了，波动是平时的 {x} 倍'
    return None


def season_now(key, w, f5, t, crash=None) -> tuple[str, str] | None:
    """季节「现在」那半句（犀利, 温和），和同一屏上的钱、温度不打架（和 words.js seasonWords 的 now 一样）。
    暴跌闸门触发时先说跌了多少（§8 修订）。"""
    if key not in SEASONS:
        return None
    cw = crash_words(crash)
    if cw:
        return cw
    f = f5 if (isnum(f5) and abs(f5) >= 0.05) else None
    warm = isnum(t) and t >= 0.5
    cool = isnum(t) and t <= -0.5
    if key == 'spring':
        if f is not None and f < 0:
            return '刚冒芽：人气先回来了，钱还在犹豫', '买卖的人多起来了，钱还没净流入'
        return '刚冒芽：钱开始摸进来，人还没到', '钱刚开始进来，还不挤'
    if key == 'summer':
        if f is not None and f < 0:
            return '盛夏：人挤人，可钱已经不进了', '人很多，但钱没真进来'
        if warm:
            return '盛夏：又热又挤，人人都在聊它', '正热、人多'
        if cool:
            return '盛夏只是人多：挤满了人，价格却跑不动', '人很多，价格却跑不动'
        return '盛夏：人挤人，人人都在聊它', '人很多，钱还在进'
    if key == 'autumn':
        if f is not None and f > 0:
            return '入秋了：人在退场，钱倒还没走', '人气在退，钱倒还在进'
        return '入秋了：挤着的人开始往外跑', '钱从拥挤处撤离'
    # 冬：只要 5 天是净流入，就说「钱先到了」（不管风是怎么凑成「冬」的）
    if f is not None and f > 0:
        return (('冬天只是人气：钱先到了，价格也暖，人还没跟上', '人气冷清，可钱在进、价格也暖') if warm
                else ('冬天只是人气：钱先到了，人气还没跟上', '人气冷清，钱却还在进'))
    if warm:
        return '冬天只是人气：没人理，价格倒还暖着', '人气冷清，价格倒还暖'
    return '寒冬：没人要，连风都懒得吹', '冷清没人管'


def take_say(n: Node) -> tuple[str, str]:
    """老风对一块地 / 一只股票的一句判词（和 words.js take() 同一套规矩，不带句号）。
    兜底的「没什么好说的」只在温度常温、没季节、没风暴、没风向突变时才说——不然先说温度 / 季节。"""
    v = n.v
    w = v['wind'] if isnum(v['wind']) else 0.0
    p = v['pres'] if isnum(v['pres']) else 50
    t = v['temp'] if isnum(v['temp']) else 0.0
    f5 = v['flow5']
    sk = n.season
    mx = wind_mix(w, f5)
    usual = isnum(v.get('ratio')) and v['ratio'] < 1.5     # 5 天的钱跟平时差不多
    cw = crash_words(n.P.get('crash') if n.P else None)    # 暴跌闸门（§8 修订）：先说跌了多少（和 words.js take() 一样）
    if cw:
        return cw
    if v['front'] > 0:
        if isnum(f5) and f5 < -0.05:
            return '风向刚掉头，可只是人气回来，钱还没跟上', '风向刚变：买卖的人回来了，钱还没净流入'
        return '风向刚掉头，钱杀回来了', '风向刚变，钱开始流进来'
    if v['front'] < 0:
        if isnum(f5) and f5 > 0.05:
            return '风向刚翻脸，人气在散，钱倒还没走', '风向刚变：人气在退，钱还在小幅流入'
        return '风向刚翻脸，钱开始撤', '风向刚变，钱开始往外撤'
    if isnum(v['storm']) and v['storm'] >= 1.5:
        return '大风暴，这不是散步是过山车', '波动突然变得很大，坐稳'
    if mx == 'attn':
        return (('挤成这样，看客比买家多，钱其实在走', '很挤、关注度在升，但钱没真进来') if p >= 85
                else ('光热闹不掏钱：关注度在升，钱没真进来', '关注度在升，但钱没真进来'))
    if mx == 'quiet':
        if isnum(f5) and isnum(v.get('dv20')) and v['dv20'] > 0 and abs(f5) / v['dv20'] >= 0.2:   # 金额不小：别说「闷声」
            return '成交份额在缩，可钱还是净进了不少', '成交份额在缩，但钱还在净流入'
        return (('没人盯着，钱在闷声进货，价格还暖着', '钱在进，但没人注意，价格也不差') if t >= 0.5
                else ('没人盯着，钱在闷声进货', '钱在进，但没人注意'))
    if w >= 0.5 and p >= 85:
        if usual:
            return '挤成这样，关注度还在升，钱倒跟平时差不多', '很挤，关注度在升，钱跟平时差不多'
        return '挤成这样还往里冲，小心接的是最后一棒', '钱还在进，但已经很挤了'
    if w > 1.5:
        if usual:
            return '关注度猛升，钱倒跟平时差不多', '关注度在升，钱跟平时差不多'
        return '钱跟疯了一样往里灌', '钱在狂涌进来'
    if sk == 'spring':
        return (('人气先回来了，钱还在犹豫', '买卖的人变多，钱还没净流入') if isnum(f5) and f5 < 0
                else ('刚冒芽：钱开始摸进来，人还没到', '钱刚开始进来，还不挤'))
    if w < -1.5:
        return '钱在夺门而逃', '钱在大逃离'
    if w <= -0.5 and p >= 65:
        return '挤满了人，先跑的已经在撤', '人多，但钱开始往外走'
    if w <= -0.5 and t <= -1.5:
        return '冷成冰窖，钱还在往外漏', '又冷，钱还在流出'
    if w >= 0.5:
        return '有人在进货', '钱在流进来'
    if w <= -0.5:
        return '钱在溜号，没人吭声', '钱在悄悄溜走'
    if isnum(f5) and abs(f5) >= 0.05 and isnum(v.get('ratio')) and v['ratio'] >= 1.5:   # 风被关注度抵消了，钱其实进出很猛
        return (('风不大，可钱在大笔往外走', '风不大，但钱流出比平时多很多') if f5 < 0
                else ('风不大，可钱在大笔往里搬', '风不大，但钱流入比平时多很多'))
    if p < 15:
        return '没人要的洼地，连风都懒得吹', '冷清洼地，没人关注'
    if t > 1.5:
        return '涨得正欢，钱却没加码', '涨得比平时快，钱没明显变化'
    if t < -1.5:
        return '冷得结冰，没人理', '跌得比平时多，没人关注'
    if p >= 85:
        return '人挤人，踩踏风险写在脸上', '人挤人，小心踩踏'
    if t >= 0.5:
        return '风不大，价格倒是暖的', '风平浪静，价格偏暖'
    if t <= -0.5:
        return '风不大，价格在发凉', '风平浪静，价格偏凉'
    if isnum(v['storm']) and v['storm'] >= 0.8:
        return '风不大，可晃得比平时凶', '风平浪静，但波动变大了'
    sn = season_now(sk, w, f5, t, n.P.get('crash') if n.P else None)
    if sn:
        return sn
    return '不冷不热，今天没什么好说的', '今天风平浪静'


def cap_hero(W: 'World', sp: Spine, b: Beat) -> tuple[str, str]:
    """巡航第 1 站（= 标题第一拍 = ①）。比平时多就先说倍数；旁边有更平静却更大的数时不报估算的绝对数；真钱先说。"""
    n, spot = b.node, b.spot
    nm = B(n.name)
    drop = calmer_bigger(W, n)
    FT = money_phrase(n, drop_est=drop)
    rt = ratio_text(n.v) if not (W.real_of(n)) else ''
    if drop and W.real_of(n) is None:
        money_s = quiet_amount(n, b.sign)
    else:
        money_s = '，'.join(x for x in ((f'进钱{rt}' if b.sign > 0 else f'撤钱{rt}') if rt else '', FT) if x)
    deep = ''
    if spot is not n:
        one = single_of(W, n)
        if one is spot:
            deep = f'几乎全是{B(spot.name)}一只'
        elif share_of(spot, n) >= SINGLE:
            deep = f'主要{"进了" if b.sign > 0 else "出自"}{B(spot.name)}'
        else:
            deep = f'{"吸得最猛" if b.sign > 0 else "跑得最凶"}的是{B(spot.name)}'
    w = n.v['wind'] or 0
    pre = '美股里' if sp.hero == 'inner' else ''
    if b.sign > 0:
        lead = vary(n.id + str(W.asOf), ['今天的抽水机是', '今天钱最想去']) if (w >= 1 and sp.hero == 'arrow') else f'今天{pre}钱最想去'
        s = fit(*[f'{lead}{nm}：{x}。' for x in ('，'.join(y for y in (money_s, deep) if y), money_s, deep) if x], f'{lead}{nm}。')
        m = fit(*[f'今天{pre}钱最想去{nm}：{x}。' for x in ('，'.join(y for y in (money_s, deep) if y), money_s, deep) if x], f'今天{pre}钱最想去{nm}。')
        return s, m
    verb_s = '夺门而逃' if w < -1.5 else '往外撤'
    s = fit(*[f'今天{pre}钱在从{nm}{verb_s}：{x}。' for x in ('，'.join(y for y in (money_s, deep) if y), money_s, deep) if x], f'今天{pre}钱在从{nm}{verb_s}。')
    m = fit(*[f'今天{pre}钱在离开{nm}：{x}。' for x in ('，'.join(y for y in (money_s, deep) if y), money_s, deep) if x], f'今天{pre}钱在离开{nm}。')
    return s, m


def cap_source(W: 'World', sp: Spine) -> tuple[Node, str, tuple[str, str]] | None:
    """巡航第 2 站：主角的钱从哪来（主角是流出时：钱去了哪）。主航道 weak 时直说「说不清」，不把小钱讲成大故事。"""
    if not sp.beats:
        return None
    b1 = sp.beats[0]
    S = sp.S2 if sp.hero == 'inner' else sp.S1
    if b1.sign > 0:
        n, weak = sp.src, sp.src_weak
    else:
        n, weak = (S.dst if S else None), (sp.hero == 'source')
    if n is None:
        return None
    nm = B(n.name)
    f5 = n.v['flow5']
    r = W.real_of(n)
    real_ok = r is not None and not real_off(r, f5)
    w = n.v['wind'] or 0
    if weak:
        ask = '钱从哪来？' if b1.sign > 0 else '钱去了哪？'
        part = ('真钱只出了' if b1.sign > 0 else '真钱只进了') if real_ok else ('只漏了' if b1.sign > 0 else '只多了')
        amt_s = money(abs(r['flow5'])) if real_ok else (f'{money(abs(f5))}（估）' if isnum(f5) else '一点')
        why_s = '算日常' if abs(w) < 0.5 else '数目对不上'
        s = fit(f'{ask}说不清：{nm}{part} {amt_s}，{why_s}。', f'{ask}说不清：{nm}只动了一点，{why_s}。')
        m = fit(f'{ask}不太明显：{nm}{"真钱" if real_ok else ""}{"流出" if b1.sign > 0 else "流入"}了 {amt_s}，{"算正常" if abs(w) < 0.5 else "对不上"}。',
                f'{ask}不太明显。')
        return n, ('outflow' if b1.sign > 0 else 'inflow'), (s, m)
    FT = money_phrase(n, drop_est=calmer_bigger(W, n))
    rt = ratio_text(n.v) if not real_ok else ''
    rtc = '，' + rt if rt else ''
    pre = '美股里' if sp.hero == 'inner' else ''
    if b1.sign > 0:
        s = fit(f'钱从哪来？{pre}{nm}在失血：{FT}{rtc}。', f'钱从哪来？{pre}{nm}在失血：{FT}。', f'钱从哪来？{pre}{nm}在失血。')
        m = fit(f'钱从哪来？{pre}{nm}：{FT}{rtc}。', f'钱从哪来？{pre}{nm}：{FT}。', f'钱从哪来？{pre}{nm}的钱在往外流。')
        return n, 'outflow', (s, m)
    s = fit(f'钱去了哪？{pre}{nm}在吸钱：{FT}{rtc}。', f'钱去了哪？{pre}{nm}在吸钱：{FT}。', f'钱去了哪？{pre}{nm}在吸钱。')
    m = fit(f'钱去了哪？{pre}{nm}：{FT}{rtc}。', f'钱去了哪？{pre}{nm}：{FT}。', f'钱去了哪？{pre}{nm}。')
    return n, 'inflow', (s, m)


def cap_beat2(W: 'World', sp: Spine, b: Beat, spot: Node) -> tuple[str, str]:
    """巡航第 3 站（= 标题第二拍 = ②）。一只股票撑起来的不叫「大轮动」，直说是那一只。"""
    if b.role == 'tail':
        kd = tail_kind(b)
        if spot is b.node and kd in ('hot', 'cold', 'crowded'):
            _, ws, wm = tail_why(spot, kd)
            return f'{B(spot.name)}{ws}', f'{B(spot.name)}{wm}'
        return cap_mid(spot, kd if kd in ('front', 'storm', 'crowded') else tour_kind(spot))
    if b.role == 'world':
        n = b.node
        FT = money_phrase(n, drop_est=calmer_bigger(W, n))
        verb = '在吸钱' if b.sign > 0 else '在失血'
        deep = f'，{"主要进了" if b.sign > 0 else "主要出自"}{B(spot.name)}' if (spot is not n and share_of(spot, n) >= SINGLE) else ''
        return (fit(f'再看大方向：{B(n.name)}{verb}：{FT}{deep}。', f'再看大方向：{B(n.name)}{verb}：{FT}。', f'再看大方向：{B(n.name)}{verb}。'),
                fit(f'再看大方向：{B(n.name)}{"在流入" if b.sign > 0 else "在流出"}：{FT}{deep}。',
                    f'再看大方向：{B(n.name)}{"在流入" if b.sign > 0 else "在流出"}：{FT}。', f'再看大方向：{B(n.name)}。'))
    S2 = b.story or sp.S2
    a, d = S2.src, S2.dst
    one = S2.single
    if one is not None:
        FT = money_phrase(one)
        return (fit(f'美股里钱扎堆{B(d.name)}——几乎全是{B(one.name)}一只：{FT}。', f'美股里钱扎堆{B(one.name)}一只：{FT}。',
                    f'美股里钱扎堆{B(one.name)}一只。'),
                fit(f'美股里流进{B(d.name)}的钱，几乎都进了{B(one.name)}：{FT}。', f'美股里钱主要进了{B(one.name)}：{FT}。',
                    f'美股里钱主要进了{B(one.name)}。'))
    got = money_phrase(d)
    if a is not None:
        lost = money_phrase(a)
        return (fit(f'美股里的轮动：{B(a.name)}{lost}，{B(d.name)}{got}。', f'美股里：钱从{B(a.name)}冲进{B(d.name)}，{got}。',
                    f'美股里：钱从{B(a.name)}冲进{B(d.name)}。'),
                fit(f'美股里：钱从{B(a.name)}流向{B(d.name)}，{got}。', f'美股里：钱从{B(a.name)}流向{B(d.name)}。'))
    return (fit(f'美股里钱在往{B(d.name)}灌：{got}。', f'美股里钱在往{B(d.name)}灌。'),
            fit(f'美股里钱在流进{B(d.name)}：{got}。', f'美股里钱在流进{B(d.name)}。'))


def cap_mid(n: Node, kind: str) -> tuple[str, str]:
    v = n.v
    nm = B(n.name)
    f5 = v['flow5']
    FT = money_phrase(n)
    rt = ratio_text(v)
    rtc = '，' + rt if rt else ''
    sk = shock(n)
    if sk:
        st_ = shock_text(n, sk)
        return fit(f'{nm}{st_}，这是过山车。', f'{nm}{st_}。'), fit(f'{nm}{st_}，坐稳。', f'{nm}{st_}。')
    r = CUR.real_of(n) if CUR is not None else None
    if r and real_blind(r):
        return (fit(f'{nm}：按成交估不出方向，看真钱：{real_bit(r)}。', f'{nm}：看真钱。'),
                fit(f'{nm}：按成交估不出方向，真钱：{real_bit(r)}。', f'{nm}：看真钱。'))
    if r and (real_against(r, f5) or real_flat(r, f5)):
        side = '进' if f5 > 0 else '出'
        how = against_word(r) if real_against(r, f5) else '几乎没动'
        who = est_who(r, f5)
        return (fit(f'{nm}：{who}是钱在{side}，真钱{how}：{real_bit(r)}。', f'{nm}：真钱{how}：{real_bit(r)}。', f'{nm}：真钱{how}。'),
                fit(f'{nm}：{who}是钱在{side}，真钱{how}：{real_bit(r)}。', f'{nm}：真钱{how}：{real_bit(r)}。', f'{nm}：真钱{how}。'))
    if kind == 'front':
        # 风 = 关注度 + 钱：钱的方向对不上时，只说人气回来 / 散了（和 why_sentence 一样）
        if v['front'] > 0:
            if isnum(f5) and f5 < -0.05:
                return (fit(f'{nm}风向刚掉头，可只是人气回来：{FT}。', f'{nm}风向刚掉头，可只是人气回来。'),
                        fit(f'{nm}风向刚变，买卖的人回来了，钱还没跟上：{FT}。', f'{nm}风向刚变，钱还没跟上。'))
            return (fit(f'{nm}刚掉头：前几天还在撤，现在{FT}。' if isnum(f5) and f5 > 0 else '',
                        f'{nm}刚掉头：前几天还在撤，今天钱杀回来了。'),
                    fit(f'{nm}风向刚变：前几天还在撤，现在{FT}。' if isnum(f5) and f5 > 0 else '', f'{nm}风向刚变：前几天还在撤，现在钱回来了。'))
        if isnum(f5) and f5 > 0.05:
            return (fit(f'{nm}风向刚翻脸，人气在散，钱倒还没走：{FT}。', f'{nm}风向刚翻脸，人气在散，钱倒还没走。'),
                    fit(f'{nm}风向刚变，人气在退，钱还在流入：{FT}。', f'{nm}风向刚变，人气在退，钱还在流入。'))
        return (fit(f'{nm}刚翻脸：前几天还在进，现在{FT}。' if isnum(f5) and f5 < 0 else '',
                    f'{nm}刚翻脸：前几天还在进钱，现在掉头就跑。'),
                fit(f'{nm}风向刚变：前几天还在进钱，现在{FT}。' if isnum(f5) and f5 < 0 else '', f'{nm}风向刚变：前几天还在进钱，现在开始撤了。'))
    if kind == 'spring':
        p = v['pres'] if isnum(v['pres']) else 50
        if v['front'] > 0:
            return (fit(f'{nm}刚冒芽，风向也刚掉头：{FT}，还不挤。', f'{nm}刚冒芽：风向刚掉头，人还不多。'),
                    fit(f'{nm}像春天：风向刚变，{FT}，还不挤。', f'{nm}像春天：风向刚变，还不挤。'))
        return (fit(f'{nm}刚冒芽：{FT}，人还不多（拥挤度 {round(p)}）。', f'{nm}刚冒芽：钱开始进来，人还不多。'),
                fit(f'{nm}像春天：{FT}，还不挤（拥挤度 {round(p)}）。', f'{nm}像春天：钱刚开始进来，还不挤。'))
    if kind == 'storm':
        big = isnum(v['storm']) and v['storm'] >= 1.5
        x = times((v['storm'] or 0) + 1)
        return (f'{nm}在刮{"台风" if big else "大风"}：波动是平时的 {x} 倍，这是过山车。',
                f'{nm}起{"大" if big else ""}风暴了：波动是平时的 {x} 倍，坐稳。')
    if kind == 'crowded':
        p = round(v['pres'])
        if (v['wind'] or 0) <= -0.5:
            return f'{nm}挤满了人（拥挤度 {p}），先跑的已经在撤了。', f'{nm}人挤人（拥挤度 {p}），钱已经开始往外走。'
        return f'{nm}挤爆了（拥挤度 {p}），后来的小心接最后一棒。', f'{nm}人挤人了（拥挤度 {p}），这时追进去容易被踩。'
    if kind == 'inflow':
        if isnum(f5) and f5 > 0:
            return fit(f'{nm}也在吸钱：{FT}{rtc}。', f'{nm}也在吸钱：{FT}。'), \
                fit(f'{nm}也在吸钱：{FT}{rtc}。', f'{nm}也在吸钱：{FT}。')
        return f'{nm}：{wind_sharp(v["wind"], n.id, f5)}。', f'{nm}：{wind_word(v["wind"], f5)}。'
    if isnum(f5) and f5 < 0:
        return fit(f'{nm}在失血：{FT}{rtc}。', f'{nm}在失血：{FT}。'), \
            fit(f'{nm}在失血：{FT}{rtc}。', f'{nm}在失血：{FT}。')
    return f'{nm}：{wind_sharp(v["wind"], n.id, f5)}。', f'{nm}：{wind_word(v["wind"], f5)}。'


def cap_stock(n: Node, story, follow_of: Node | None = None) -> tuple[str, str]:
    nm = B(n.name)
    f5 = n.v['flow5']
    FT = money_phrase(n)
    if story:
        return f'最后看一只：{nm}{story[1]}。', f'最后看一只：{nm}{story[2]}。'
    if follow_of is not None:
        return (fit(f'这些钱主要进了谁？{nm}一只就吸走 {money(f5)}（估）。'), fit(f'这些钱主要进了谁？{nm}一只就吸走 {money(f5)}（估）。'))
    rt = ratio_text(n.v)
    rtc = '，' + rt if rt else ''
    return (fit(f'最后看一只：{nm}{FT}{rtc}。', f'最后看一只：{nm}{FT}。'),
            fit(f'最后看一只：{nm}{FT}{rtc}。', f'最后看一只：{nm}{FT}。'))


def tour(W: World, sp: Spine, spots: list[dict], R: Radar) -> list[dict]:
    """5 站，和标题、①②③ 同一个顺序：① 主角 → 钱从哪来 → ② 第二拍 → ③ → 一只股票（有故事的）。
    雷达（全球 / 全市场）的股票比最后那只更猛时顶替它（tour.js 会在精选地图上把它画成「别的地图上」的一站）。"""
    rfloor = region_floor(W)
    regs = [n for n in W.regions(1) if isnum(n.v['wind']) and n.id != 'us' and (n.v.get('dv20') or 0) >= rfloor]
    stops: list[dict] = []
    chosen: list[Node] = []

    def ok(n):
        return not any(W.related(n, c) for c in chosen)

    def add(node: Node, kind: str, cap: tuple[str, str], **extra):
        num = extra.pop('n', None)
        it = base_item(W, node, kind=kind, caption=cap[0], captionMild=cap[1], **extra)
        if num is not None:
            it['n'] = num            # 这一站就是地图上的 ①②③ 里的第几个
        rl = real_info(W.real_of(node))
        if rl:
            it['real'] = rl
        stops.append(it)
        chosen.append(node)

    by_id = {s['id']: s for s in spots}
    beats = sp.beats if sp else []
    # 1. 主角（= ①）
    if beats:
        b1 = beats[0]
        spot1 = W.nodes.get(spots[0]['id']) if spots and spots[0].get('role') == 'hero' else b1.spot
        bb = Beat(b1.node, b1.sign, b1.role, b1.chain[:b1.chain.index(spot1) + 1] if spot1 in b1.chain else [b1.node], b1.story)
        kd = 'front' if (spot1.v['front'] or 0) * b1.sign > 0 else ('inflow' if b1.sign > 0 else 'outflow')
        add(spot1, kd, cap_hero(W, sp, bb), role='hero', n=by_id.get(spot1.id, {}).get('n'))
        # 2. 钱从哪来
        src = cap_source(W, sp)
        if src is not None and ok(src[0]):
            add(src[0], src[1], src[2], role='source')
    # 3. 第二拍（= ②）
    if len(beats) > 1:
        b2 = beats[1]
        two = next((s for s in spots if s.get('role') == b2.role), None)
        spot2 = W.nodes.get(two['id']) if two else b2.spot
        if spot2 is not None and ok(spot2):
            if b2.role == 'tail':
                kd = tail_kind(b2) if spot2 is b2.node else tour_kind(spot2)
            else:
                kd = 'front' if (spot2.v['front'] or 0) * b2.sign > 0 else ('inflow' if b2.sign > 0 else 'outflow')
            add(spot2, kd, cap_beat2(W, sp, b2, spot2), role=b2.role, n=by_id.get(spot2.id, {}).get('n'))
    # 4. ③（主线之外：持仓或 surprise 最高的）
    for s in spots:
        if s.get('role') in ('hero', 'inner', 'world', 'tail'):
            continue
        n = W.nodes.get(s['id'])
        if n is None or not ok(n):
            continue
        if s.get('holding'):
            hs, hm = holding_say(n)
            add(n, s.get('kind') or tour_kind(n), (fit(f'你的持仓{B(n.name)}：{hs}'), fit(f'你的持仓{B(n.name)}：{hm}')), role='holding', n=s.get('n'))
        else:
            kd = tour_kind(n)
            add(n, kd, cap_mid(n, kd), role='third', n=s.get('n'))
        break
    # 不够 4 站（股票前）：用 surprise 最高的补上（同一块大陆别扎堆）
    cands = sorted([n for n in regs if n.series], key=lambda n: -n.P['score'])
    for strict in (True, False):
        for n in cands:
            if len(stops) >= 4:
                break
            if not ok(n) or (strict and any(world_cont(n) == world_cont(c) for c in chosen)):
                continue
            kd = tour_kind(n)
            add(n, kd, cap_mid(n, kd))
    # 5. 落到一只股票：先找有故事的（背离 / 风向刚变 / 大风暴），再找「钱主要进了谁」
    floor = liquid_floor(W)
    stocks = [n for n in W.stocks() if isnum(n.v['wind']) and (n.v.get('dv20') or 0) >= floor]
    by_sur = sorted([n for n in stocks if all(n.id != c.id for c in chosen)], key=lambda n: -n.P['score'])
    best = None
    best_score = -1.0
    for pool in ([n for n in by_sur if ok(n)], by_sur):
        for n in pool[:30]:
            story = stock_story(n)
            if story:
                best = base_item(W, n, kind=story[0], **dict(zip(('caption', 'captionMild'), cap_stock(n, story))))
                best_score = n.P['score']
                break
        if best:
            break
    first_dst = beats[0].node if beats and beats[0].sign > 0 else None
    if best is None and first_dst is not None and isnum(first_dst.v['flow5']) and first_dst.v['flow5'] > 0:
        under = [n for n in stocks if any(first_dst.id in p for p in n.all_paths) and isnum(n.v['flow5']) and n.v['flow5'] > 0
                 and all(n.id != c.id for c in chosen)]
        if under:
            x = max(under, key=lambda n: n.v['flow5'])
            if x.v['flow5'] >= 0.1 * first_dst.v['flow5']:
                best = base_item(W, x, kind='inflow', **dict(zip(('caption', 'captionMild'), cap_stock(x, None, first_dst))))
                best_score = x.P['score']
    if best is None and by_sur:
        x = by_sur[0]
        kd = 'inflow' if (x.v['wind'] or 0) >= 0 else 'outflow'
        best = base_item(W, x, kind=kd, **dict(zip(('caption', 'captionMild'), cap_stock(x, None))))
        best_score = x.P['score']
    # 雷达（最多 1 站）：股票 → 顶替最后那只股票（它更猛时）
    rkind = lambda it: 'front' if it['front'] else ('inflow' if it['wind'] >= 0 else 'outflow')
    for it in [x for x in R.items if x['tourOk']][:2]:
        if it['kind'] == 'stock' and (best is None or it['score'] >= best_score):
            s_, m_ = R.caption(it, last=True)
            best = R.item(it, kind=rkind(it), caption=s_, captionMild=m_)
            break
    if best:
        stops.append(best)
    return stops[:5]


# ════════════════════════════ 我的持仓（§20）· 盘中（partial）· 水位（§23 流动性） ════════════════════════════


def date_cn(iso) -> str:
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', str(iso or ''))
    return f'{int(m[2])}月{int(m[3])}日' if m else str(iso or '')


def load_holdings(data_dir: Path) -> list[dict]:
    """universe/holdings.json（update.sh 会复制到 web/data/holdings.json）。优先持仓排第一。"""
    for p in (ROOT / 'universe' / 'holdings.json', data_dir / 'holdings.json', DATA / 'holdings.json'):
        if not p.exists():
            continue
        try:
            j = json.loads(p.read_text(encoding='utf-8'))
        except Exception as e:
            print(f'[brief] 读不了持仓 {p}: {e}', file=sys.stderr)
            continue
        hs = j.get('holdings') if isinstance(j, dict) else j
        out = []
        for k, h in enumerate(hs if isinstance(hs, list) else []):
            if not isinstance(h, dict):
                continue
            t = str(h.get('t') or h.get('ticker') or '').upper().strip()
            if t:
                out.append({'t': t, 'name': str(h.get('name') or t), 'note': str(h.get('note') or ''), 'k': k})
        out.sort(key=lambda h: (0 if '最大' in h['note'] else 1, h['k']))
        return out
    return []


def filled_on(W: World) -> dict | None:
    """meta.filled 里有今天这一天：Yahoo 还没给正式收盘价，fetch.py 用 60 分钟线的最后一根补上（标「补」，正式收盘价到了自动换掉）。"""
    for f in W.meta.get('filled') or []:
        if isinstance(f, dict) and f.get('date') == W.asOf:
            return f
    return None


def partial_info(W: World) -> dict | None:
    """meta.partial = {date, fetchedAt}：最新那根日线是盘中抓的。
    pipeline 已经按美股盘中成交量的 U 形曲线把今天的成交折算成了全天（meta.intraday {fraction, scaled, say, method, localTime}），
    所以这里不再用「开盘几分钟 / 390」自己算进度，也不说「只算了一部分」——直接用 meta.intraday 的进度和说法（和 words.js asOfLabel 一样）。"""
    pt = W.meta.get('partial')
    if not W.latest or not isinstance(pt, dict):
        return None
    if pt.get('date') and W.asOf and pt['date'] != W.asOf:
        return None
    iso = str(pt.get('fetchedAt') or pt.get('at') or '')
    m = re.search(r'T(\d{2}):(\d{2})', iso)
    et = f'{m[1]}:{m[2]}' if m else ''
    local = ''
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        local = datetime.fromisoformat(iso).astimezone(ZoneInfo('Australia/Sydney')).strftime('%H:%M')
    except Exception:
        local = ''
    it = W.meta.get('intraday') if isinstance(W.meta.get('intraday'), dict) else {}
    if it and it.get('date') and pt.get('date') and it['date'] != pt['date']:
        it = {}
    et = str(it.get('etTime') or et)
    local = str(it.get('localTime') or local)
    frac = it.get('fraction') if isnum(it.get('fraction')) else None
    scaled = bool(it.get('scaled'))
    date = pt.get('date') or W.asOf
    when = f'截至美东 {et}' + (f'，悉尼 {local}' if local else '') if et else '还没收盘'
    if scaled:
        typ = f'平常这时约成交了全天的 {round(frac * 100)}%，' if frac is not None else ''
        say = fit(f'盘中快照：{typ}今天的数已按全天折算。', '盘中快照：今天的数已按全天折算，收盘后换成真数。')
        mild = '盘中：今天的成交额已按全天折算，收盘后换成真数。'
    else:
        if frac is None:
            mins = max(0, min(390, int(m[1]) * 60 + int(m[2]) - 570)) if m else None
            frac = mins / 390 if mins is not None else None
        bit = ('今天的数只算了一小截' if frac < 0.35 else '今天的数只算了一半左右' if frac < 0.7 else '今天的数快齐了') if frac is not None else '今天的数只算了一部分'
        say = f'盘中快照：{bit}，收盘后换成真数。'
        mild = '还在盘中，今天的数字只算了一部分，收盘后换成真数。'
    out = {'date': date, 'at': et, 'local': local, 'frac': round(frac, 3) if frac is not None else None, 'scaled': scaled,
           'text': f'{date_cn(date)} 盘中（{when}）', 'say': say, 'sayMild': mild}
    if it.get('method'):
        out['method'] = str(it['method'])
    return out


def liq_d20_musd(liq: dict):
    """净流动性 4 周（20 个交易日）变化 → 百万美元（liquidity.json 的 chg.netliq.d20，单位看 units.netliq，默认 $B）。"""
    try:
        d20 = liq['chg']['netliq']['d20']
    except (KeyError, TypeError):
        return None
    if not isnum(d20):
        return None
    unit = str((liq.get('units') or {}).get('netliq') or '$B')
    return d20 * (1.0 if 'M' in unit else 1e6 if 'T' in unit else 1000.0)


def liquidity_say(liq: dict, as_of: str | None) -> dict | None:
    """水位（§23）：liquidity.json {regime:{state:'放水'|'收水'|'平稳', since, prev, fresh}, pressure:-3..3, chg.netliq.d20}
    → 「美联储在放水 / 收水」一句话（和 words.js liquiditySay 一样）。数字（水位四周变化）精确，观点在句子里。"""
    if not isinstance(liq, dict):
        return None
    g = liq.get('regime') if isinstance(liq.get('regime'), dict) else liq
    state = g.get('state')
    if state not in ('放水', '收水', '平稳'):
        return None
    since = str(g.get('since') or '')[:10]
    pr = liq.get('pressure') if isnum(liq.get('pressure')) else (g.get('pressure') if isnum(g.get('pressure')) else None)
    if isinstance(g.get('fresh'), bool):
        fresh = g['fresh']
    else:
        gap = _days_apart(as_of, since) if (since and as_of) else None
        fresh = gap is not None and gap <= 7 and str(since) <= str(as_of)
    frm = f'（{date_cn(since)}起）' if since else ''
    hard = isnum(pr) and abs(pr) >= 2
    d = liq_d20_musd(liq)
    amt = money(abs(d)) if isnum(d) and abs(d) >= 0.05 else ''
    if state == '放水':
        s_ = f'美联储在放水{frm}，水位四周涨了 {amt}{"，放得很猛" if hard else ""}。' if amt and d > 0 else \
            f'美联储在放水{frm}，{"放得很猛，" if hard else ""}池子里的水在变多。'
        m_ = f'美联储在放水{frm}，市场里的钱四周多了 {amt}。' if amt and d > 0 else f'美联储在放水{frm}，市场里的钱在变多。'
    elif state == '收水':
        s_ = f'美联储在收水{frm}，水位四周少了 {amt}{"，收得很狠" if hard else ""}，别太浪。' if amt and d < 0 else \
            f'美联储在收水{frm}，{"收得很狠，" if hard else ""}水位在降，别太浪。'
        m_ = f'美联储在收水{frm}，市场里的钱四周少了 {amt}。' if amt and d < 0 else f'美联储在收水{frm}，市场里的钱在变少。'
    else:
        if amt:
            way = '少' if d < 0 else '多'
            s_ = f'水位平稳，四周只{way}了 {amt}，美联储没在放水也没收水。'
            m_ = f'流动性平稳，四周只{way}了 {amt}。'
        else:
            s_, m_ = '美联储按兵不动，水位平稳。', '流动性平稳：美联储没在放水，也没在收水。'
    prev = g.get('prev')
    if fresh and state != '平稳':
        s_, m_ = '风向大变：' + s_, '水位刚转向：' + m_
    elif fresh and prev in ('放水', '收水'):
        s_, m_ = f'{prev}刚停：' + s_, f'{prev}刚停：' + m_
    out = {'state': state, 'since': since or None, 'fresh': bool(fresh), 'pressure': round(pr, 2) if isnum(pr) else None,
           'netliq4w': round(d, 1) if isnum(d) else None,
           'emoji': {'放水': '💧', '收水': '🏜️'}.get(state, '〰️'), 'say': s_, 'sayMild': m_}
    # 水位那边写好的细节（同一套口吻）：干净、每句 ≤ 30 字才带上
    det_s, det_m = g.get('say') or liq.get('say'), g.get('sayMild') or liq.get('sayMild')
    if all(isinstance(x, str) and x and not BAD.search(x) and all(han_len(p) <= MAX_HAN for p in re.split(r'[。！？；]', x))
           for x in (det_s, det_m)):
        out['detail'], out['detailMild'] = det_s, det_m
    return out


def load_liquidity(data_dir: Path, as_of: str | None) -> dict | None:
    for p in (data_dir / 'liquidity.json', DATA / 'liquidity.json'):
        if p.exists():
            try:
                return liquidity_say(json.loads(p.read_text(encoding='utf-8')), as_of)
            except Exception as e:
                print(f'[brief] 读不了水位 {p}: {e}', file=sys.stderr)
                return None
    return None


def holding_say(n: Node) -> tuple[str, str]:
    """持仓那一句：先看有没有故事（背离 / 风向刚变 / 大风暴），没有就是老风的判词。带句号。"""
    st = stock_story(n)
    s_, m_ = (st[1], st[2]) if st else take_say(n)
    return s_ + '。', m_ + '。'


def holding_facts(n: Node, partial: dict | None) -> str:
    """数字放徽章：「今天盘中 +2.4% · 5天净流入 2264万美元 · 拥挤度 91 · ☀️夏」"""
    v = n.v
    bits = []
    if isnum(v.get('ret1')):
        when = f'今天盘中（截至美东 {partial["at"]}）' if partial and partial.get('at') else ('今天盘中' if partial else '今天')
        bits.append(f'{when} {pct(v["ret1"])}')
    if isnum(v['flow5']):
        bits.append(money_phrase(n))
    if isnum(v['pres']):
        bits.append(f'拥挤度 {round(v["pres"])}')
    so = season_obj(n.season)
    if so:
        bits.append(f'{so["emoji"]}{so["name"]}')
    return ' · '.join(bits)


def holdings_block(W: World, partial: dict | None) -> tuple[list[dict], list[Node], dict | None]:
    """→ (brief.holdings 列表, 今天有动静的持仓节点（给 ①②③）, brief.holdingsLine)"""
    items, loud = [], []
    for h in load_holdings(W.dir):
        t = h['t']
        n = W.nodes.get('s:' + t)
        shown = ALIAS.get(t) or (n.name if n else h['name'])
        if n is None or not n.series or not isnum(n.v.get('wind')):
            items.append({'id': 's:' + t, 'ticker': t, 'name': shown, 'fullName': h['name'], 'note': h['note'],
                          'holding': True, 'missing': True, 'loud': False, 'path': '', 'pathIds': list(n.path_ids) if n else [],
                          'facts': '', 'say': '今天没拿到它的天气数据，老风先不乱说。', 'sayMild': '今天暂时没有它的天气数据。'})
            continue
        v = n.v
        is_loud = holding_loud(n)
        if is_loud:
            loud.append(n)
        r1_, r5_, r20_ = v.get('ret1'), v.get('ret5'), v.get('ret20')
        items.append(base_item(W, n, fullName=h['name'], note=h['note'], holding=True, loud=is_loud,
                               wind=r2(v['wind']), temp=r2(v['temp']), pres=round(v['pres']) if isnum(v['pres']) else None,
                               storm=r2(v['storm']), front=v['front'], flow5=r1(v['flow5']),
                               ret1=round(r1_, 4) if isnum(r1_) else None, ret5=round(r5_, 4) if isnum(r5_) else None,
                               ret20=round(r20_, 4) if isnum(r20_) else None, season=season_obj(n.season),
                               facts=holding_facts(n, partial), **said(holding_say(n), n)))
    line = None
    if items:
        first = items[0]
        nm_ = B(first['name'])
        s_, m_ = first['say'], first['sayMild']
        more = [x for x in items[1:] if x.get('loud')]
        tail_s = f'另外{B(more[0]["name"])}也有动静。' if more else ''
        line = {'say': fit(f'我的持仓{nm_}：{s_}{tail_s}', f'我的持仓{nm_}：{s_}'),
                'sayMild': fit(f'我的持仓{nm_}：{m_}{tail_s}', f'我的持仓{nm_}：{m_}'),
                'facts': first.get('facts', ''), 'id': first['id']}
    return items, loud, line


# ════════════════════════════ 组装 ════════════════════════════


def varied(nodes: list[Node], fn) -> list[tuple[str, str]]:
    """一个榜单里，犀利那句的「尾巴」别一模一样地重复（换个说法，事实不变）。"""
    used: set[str] = set()
    out = []
    for n in nodes:
        pair = fn(n, '')
        for salt in ('1', '2', '3', '4'):
            tail = pair[0].split('，')[-1]
            if tail not in used:
                break
            pair = fn(n, salt)
        used.add(pair[0].split('，')[-1])
        out.append(pair)
    return out


def build(W: World, R: Radar | None = None) -> dict:
    global CUR
    CUR = W
    R = R or Radar(W, None)
    partial = partial_info(W)
    hold_items, hold_loud, hold_line = holdings_block(W, partial)
    regs2 = [n for n in W.regions(2) if isnum(n.v['wind'])]
    regs1 = [n for n in W.regions(1) if isnum(n.v['wind'])]
    stocks = [n for n in W.stocks() if isnum(n.v['wind'])]
    top = W.top()
    S1 = channel_for(top)
    themes = W.us_themes()
    S2 = pick_story(themes) if themes else Story()
    if not (S1.src or S1.dst) and not themes:
        S2 = pick_story(W.continents())
    if S2 and S2.dst is not None and themes:
        S2.single = single_of(W, S2.dst)       # 「美股里的轮动」其实是一只股票撑起来的？
    sp = build_spine(W, S1, S2)
    hs, hm = headline(W, sp)
    if partial:   # 盘中：一句话开头就说清楚，今天这根线还没收完
        hs, hm = fit(f'盘中：{hs}', hs), fit(f'盘中：{hm}', hm)

    big = [base_item(W, n, wind=r2(n.v['wind']), temp=r2(n.v['temp']), flow5=r1(n.v['flow5']), **said(big_say(n), n))
           for n in sorted(top, key=lambda n: -n.v['wind'])]

    # 排行榜按「对它自己来说多不寻常」(风) 排；钱数太小（< 1 亿美元）的不上榜，免得小钱排在大钱前面
    def material(n):
        return not isnum(n.v['flow5']) or abs(n.v['flow5']) >= 100

    inflow = pick_diverse(W, sorted([n for n in regs2 if flows_in(n) and n.v['wind'] >= 0.5 and material(n)],
                                    key=lambda n: -n.v['wind']), 8)
    outflow = pick_diverse(W, sorted([n for n in regs2 if flows_out(n) and n.v['wind'] <= -0.5 and material(n)],
                                     key=lambda n: n.v['wind']), 8)
    fronts = pick_collapsed(W, sorted([n for n in regs1 if n.v['front'] != 0], key=lambda n: -n.P['score']), 8)
    crowded = pick_collapsed(W, sorted([n for n in regs1 if isnum(n.v['pres']) and n.v['pres'] >= 85],
                                       key=lambda n: (-n.v['pres'], -n.P['score'])), 8)
    quiet = pick_collapsed(W, sorted([n for n in regs1 if isnum(n.v['pres']) and n.v['pres'] < 10],
                                     key=lambda n: (n.v['pres'], -n.P['score'])), 8)
    storms = pick_collapsed(W, sorted([n for n in regs1 if isnum(n.v['storm']) and n.v['storm'] >= 0.8],
                                      key=lambda n: -n.v['storm']), 8)
    springs = pick_collapsed(W, sorted([n for n in regs1 if n.season == 'spring' and flows_in(n)],
                                       key=lambda n: -n.P['score']), 8)

    # 个股：只在「对它自己来说不寻常」(|wind| ≥ 0.5) 的里面按钱数排；不够 10 个再放宽
    def stock_rank(sign):
        ok = [n for n in stocks if isnum(n.v['flow5']) and sign * n.v['flow5'] > 0]
        strong = sorted([n for n in ok if sign * n.v['wind'] >= 0.5], key=lambda n: -sign * n.v['flow5'])
        if len(strong) < 10:
            strong += sorted([n for n in ok if 0 < sign * n.v['wind'] < 0.5], key=lambda n: -sign * n.v['flow5'])
        return strong[:10]

    def with_real(d, n):
        rl = real_info(W.real_of(n))
        if rl:
            d['real'] = rl          # §23：前端可以在估算旁边画「真钱」徽章
        return d

    def stock_item(n, sm):
        r5 = n.v.get('ret5')
        return with_real(base_item(W, n, wind=r2(n.v['wind']), flow5=r1(n.v['flow5']), ret5=round(r5, 4) if isnum(r5) else None,
                                   **said(sm, n)), n)

    def reg_item(n, sm, **kw):
        return with_real(base_item(W, n, wind=r2(n.v['wind']), flow5=r1(n.v['flow5']), **kw, **said(sm, n)), n)

    def spring_say(n):
        p = round(n.v['pres']) if isnum(n.v['pres']) else 50
        crowd = '人还不多' if p < 35 else '还没挤满'
        return (vary(n.id, [f'刚冒芽，{crowd}（拥挤度 {p}）', f'钱刚摸进来，{crowd}（拥挤度 {p}）']),
                f'钱刚开始进来，还不挤（拥挤度 {p}）')

    ch = channel_obj(S1)
    if ch is not None:
        inner = channel_obj(S2, '美股里') if (S2 and S2.src and S2.dst and themes) else None
        if inner is not None:
            inner['parent'] = 'us'
        ch['inner'] = inner
        # 主角是谁（和 main.js computeChannel 同一套规矩）+ 标题第一拍：前端的主角圈 / 箭头说的就是这一句
        ch['hero'] = sp.hero
        hs1, hm1 = hero_say(W, sp)
        if hs1:
            ch['heroSay'], ch['heroSayMild'] = hs1, hm1

    spots, radar_spot = spotlight(W, R, sp, holdings=hold_loud)
    for it in hold_items:
        x = next((y for y in spots if y['id'] == it['id']), None)
        it['spot'] = x['n'] if x else (next((y['n'] for y in spots if (y.get('holdingAlso') or {}).get('id') == it['id']), None))
    story = {'hero': sp.hero,
             'beats': [{'role': b.role, 'id': b.node.id, 'name': b.node.name, 'spot': b.spot.id, 'sign': b.sign,
                        'chain': [x.id for x in b.chain], **({'single': single_of(W, b.node).id} if single_of(W, b.node) else {})}
                       for b in sp.beats]}
    return {
        'asOf': W.asOf,
        'asOfLabel': partial['text'] if partial else (f'{date_cn(W.asOf)} 收盘{"（补）" if filled_on(W) else ""}' if W.asOf else ''),
        'partial': partial,
        'filled': filled_on(W),
        'voice': 'sharp',
        'headline': hs,
        'headlineMild': hm,
        'holdings': hold_items,
        'holdingsLine': hold_line,
        'liquidity': load_liquidity(W.dir, W.asOf),
        'channel': ch,
        'big': big,
        'inflow': [reg_item(n, sm) for n, sm in zip(inflow, varied(inflow, in_say))],
        'outflow': [reg_item(n, sm) for n, sm in zip(outflow, varied(outflow, out_say))],
        'fronts': [reg_item(n, front_say(n), dir=1 if n.v['front'] > 0 else -1) for n in fronts],
        'springs': [reg_item(n, spring_say(n), pres=round(n.v['pres']) if isnum(n.v['pres']) else None) for n in springs],
        'crowded': [reg_item(n, sm, pres=round(n.v['pres'])) for n, sm in zip(crowded, varied(crowded, crowd_say))],
        'quiet': [reg_item(n, quiet_say(n), pres=round(n.v['pres'])) for n in quiet],
        'storms': [reg_item(n, storm_say(n), storm=r2(n.v['storm'])) for n in storms],
        'stocksIn': [stock_item(n, stock_in_say(n)) for n in stock_rank(+1)],
        'stocksOut': [stock_item(n, stock_out_say(n)) for n in stock_rank(-1)],
        'spotlight': spots,
        'radarSpot': radar_spot,
        'singles': singles_map(W),
        'story': story,
        'tour': tour(W, sp, spots, R),
        'radar': [R.item(it, score=r2(it['score']), kind=it['kind']) for it in R.items[:5]],
        'seasonStats': season_stats(W),
    }


# ════════════════════════════ 自检 + 打印 ════════════════════════════

BAD = re.compile(r'NaN|None|null|undefined|Infinity|z-score|MAD|CLV|相对强弱|动量|\[object')
IN_WORDS = re.compile(r'钱[^，。；：没不未倒别]{0,5}?(?:涌进|流进|流入|往里|灌|杀回|杀进|摸进|进来|回来|进货|接货|在进)|吸钱|吸走|进货|接货|(?<!不再)进钱(?!停)')
OUT_WORDS = re.compile(r'钱[^，。；：没不未倒别]{0,5}?(?:溜|撤|跑|逃|往外|流出|离开|走)|失血(?!止)|往外漏|夺门|撤钱')
PAST = re.compile(r'前几天|5天前|刚还|之前|刚才|一年里|等|才算|如果|要是|按成交估|历史上')   # 回忆过去 / 假设将来的半句不算
LISTS = ('big', 'inflow', 'outflow', 'fronts', 'springs', 'crowded', 'quiet', 'storms', 'stocksIn', 'stocksOut')


def check(brief: dict) -> list[str]:
    problems = []

    def texts():
        yield 'headline', brief['headline']
        yield 'headlineMild', brief.get('headlineMild', '')
        if brief.get('channel'):
            yield 'channel', brief['channel']['say']
            yield 'channelMild', brief['channel']['sayMild']
        for k in LISTS:
            for it in brief.get(k, []):
                yield k, it.get('say', '')
                yield k + 'Mild', it.get('sayMild', '')
        for it in brief.get('spotlight', []):
            yield 'spotlight', it.get('why', '')
            yield 'spotlightMild', it.get('whyMild', '')
        for it in brief.get('tour', []):
            yield 'tour', it.get('caption', '')
            yield 'tourMild', it.get('captionMild', '')

        for it in brief.get('holdings', []):
            yield 'holdings', it.get('say', '')
            yield 'holdingsMild', it.get('sayMild', '')
        for key in ('holdingsLine', 'liquidity', 'partial'):
            if brief.get(key):
                yield key, brief[key].get('say', '')
                yield key + 'Mild', brief[key].get('sayMild', '')

    for k, s in texts():
        if not s:
            problems.append(f'{k}: 空句子')
        if BAD.search(s):
            problems.append(f'{k}: 有坏字眼 → {s}')
        for part in re.split(r'[。！？；]', s):
            if han_len(part) > MAX_HAN:
                problems.append(f'{k}: 超过 {MAX_HAN} 个汉字（{han_len(part)}）→ {part}')
    if len(brief.get('spotlight', [])) > 3:
        problems.append('spotlight 超过 3 个')
    if sum(1 for s in brief.get('spotlight', []) if s.get('radar')) > 1:
        problems.append('雷达（全市场 + 全球）占了不止 1 个亮点')
    if sum(1 for s in brief.get('tour', []) if s.get('radar')) > 2:
        problems.append('雷达（全市场 + 全球）占了不止 2 站')
    hs = brief.get('holdings') or []
    if hs and brief.get('holdingsLine') is None:
        problems.append('有持仓却没有「我的持仓」那一行')
    for h in hs:
        if h.get('loud') and not any(x['id'] == h['id'] or (x.get('holdingAlso') or {}).get('id') == h['id']
                                     for x in brief.get('spotlight', [])):
            problems.append(f'持仓 {h["id"]} 今天有动静，却没占 ①②③')
    # 故事主线：标题第一拍的主角就是 ①（或 ① 是它往下找到的推手），巡航第 1 站就是 ①
    sp_ = brief.get('spotlight') or []
    st_ = (brief.get('story') or {}).get('beats') or []
    if st_ and sp_ and sp_[0].get('role') == 'hero' and sp_[0]['id'] not in (st_[0].get('chain') or []):
        problems.append(f'① {sp_[0]["id"]} 不在主角 {st_[0]["id"]} 的那条线上')
    if st_ and sp_ and brief.get('tour') and sp_[0].get('role') == 'hero' and brief['tour'][0]['id'] != sp_[0]['id']:
        problems.append(f'巡航第 1 站 {brief["tour"][0]["id"]} 不是 ① {sp_[0]["id"]}')
    conts = [(x.get('pathIds') or [None, x['id']])[1] for x in sp_ if not x.get('radar')]
    if len(conts) != len(set(conts)):
        problems.append(f'①②③ 有两个落在同一块大陆上：{conts}')
    if sum(1 for x in sp_ if x.get('radar')):
        problems.append('雷达占了精选地图的 ①②③（应该放 radarSpot）')
    # 风和钱不许打架：说「钱在进」的那句，5 天净流入不能是负的；反过来也一样（回忆过去的那半句不算）
    for k in LISTS + ('spotlight', 'holdings'):
        for it in brief.get(k, []) or []:
            if it.get('radar') or not isnum(it.get('flow5')):
                continue
            f5 = it['flow5']
            for key in ('say', 'sayMild', 'why', 'whyMild'):
                txt = it.get(key)
                if not txt:
                    continue
                # 回忆过去的半句、真钱那半句（真钱的方向可以和估算相反，那正是要说的）、括号里的估算都不算
                now = '，'.join(x for x in re.split(r'[，：；。（）]', txt) if not PAST.search(x) and '真钱' not in x and not x.startswith('估'))
                if f5 < -0.05 and IN_WORDS.search(now):
                    problems.append(f'{k}.{key}: 说钱在进，但 5 天净流出 → {it["name"]}：{txt}')
                if f5 > 0.05 and OUT_WORDS.search(now):
                    problems.append(f'{k}.{key}: 说钱在走，但 5 天净流入 → {it["name"]}：{txt}')
    # 真钱（不小）在反方向时，按估算说的那半句不许说相反的话；暴跌中的地方不许是春 / 夏（§8 修订）
    for k in LISTS + ('spotlight', 'holdings'):
        for it in brief.get(k, []) or []:
            rl = it.get('real') or {}
            if rl.get('material') and isnum(rl.get('flow5')) and abs(rl['flow5']) >= 0.5:
                sg = 1 if rl['flow5'] > 0 else -1
                for key in ('say', 'sayMild', 'why', 'whyMild'):
                    if it.get(key) and _claims(it[key], -sg):
                        problems.append(f'{k}.{key}: 真钱 {rl["flow5"]:+.0f} 百万美元，这句却说反了 → {it["name"]}：{it[key]}')
            sk_ = (it.get('season') or {}).get('key') if isinstance(it.get('season'), dict) else it.get('season')
            if it.get('crash') and sk_ in ('spring', 'summer'):
                problems.append(f'{k}: {it["name"]} 在暴跌却读成 {sk_}')
    kinds = {'front', 'inflow', 'outflow', 'storm', 'crowded', 'hot', 'cold', 'quiet'}   # tour.js KIND 都认得
    for t in brief.get('tour', []):
        if t['kind'] not in kinds:
            problems.append(f'tour kind 不合法: {t["kind"]}')
    try:
        json.dumps(brief, allow_nan=False)
    except ValueError as e:
        problems.append(f'JSON 里有 NaN/Infinity: {e}')
    return problems


def pretty(b: dict, mild=False) -> str:
    M = 'Mild' if mild else ''
    sk = lambda it: (it.get('season') or {}).get('emoji', '') if isinstance(it.get('season'), dict) else ''
    L = [f'══ 今日天气预报 · {b.get("asOfLabel") or b["asOf"]} · {"温和" if mild else "犀利"} ══', '']
    if b.get('partial'):
        L.append('  ⏱ ' + b['partial']['say' + M])
    L += ['  ' + b['headline' + M], '']
    if b.get('holdingsLine'):
        L.append(f'  ★ {b["holdingsLine"]["say" + M]}   [{b["holdingsLine"].get("facts", "")}]')
        for h in (b.get('holdings') or [])[1:]:
            L.append(f'    · {h["name"]}：{h["say" + M]}   [{h.get("facts", "")}]')
    if b.get('liquidity'):
        L.append(f'  {b["liquidity"]["emoji"]} {b["liquidity"]["say" + M]}')
    if b.get('holdingsLine') or b.get('liquidity'):
        L.append('')
    ch = b.get('channel')
    if ch:
        L.append(f'  ➜ {ch["say" + M]}   [{ch["from"]} → {ch["to"]}{" +" + ch["to2"] if ch.get("to2") else ""}'
                 f'{" weak" if ch.get("weak") else ""} {ch["strength"]}]')
        if ch.get('inner'):
            L.append(f'  ➜ {ch["inner"]["say" + M]}   [{ch["inner"]["from"]} → {ch["inner"]["to"]}]')
        L.append('')
    stb = b.get('story') or {}
    if stb.get('beats'):
        L.append(f'  主线（{stb.get("hero")}）：' + ' → '.join(f'{x["role"]}:{x["name"]}' + (f'⇒{x["spot"]}' if x['spot'] != x['id'] else '')
                                                    for x in stb['beats']))
        L.append('')
    L.append('先看这里：')
    for s in b['spotlight']:
        tag = f'［{s.get("label") or "雷达"}］' if s.get('radar') else ('［持仓］' if s.get('holding') else '')
        tag += f'［{s["role"]}/{s.get("story", "")}］' if s.get('role') else ''
        tag += ' 真钱' if s.get('real') else ''
        L.append(f'  {"①②③"[s["n"] - 1]} {sk(s)}{s["name"]}{tag}（{s["path"] or "—"}）  {s["why" + M]}   [{s["kind"]} {s["score"]}]')
    if b.get('radarSpot'):
        r_ = b['radarSpot']
        L.append(f'  ＋ {r_.get("label", "雷达")}：{r_["name"]}（{r_.get("path", "")}）  {r_["why" + M]}   [{r_["kind"]} {r_["score"]}]')
    L.append('')
    L.append('▶ 60 秒看懂今天：')
    for k, t in enumerate(b['tour'], 1):
        L.append(f'  {k}. [{t["kind"]:<7}] {t["caption" + M]}{"   ［雷达］" if t.get("radar") else ""}'
                 f'{"   ‹" + t["role"] + (" " + "①②③"[t["n"] - 1] if t.get("n") else "") + "›" if t.get("role") else ""}')
    L.append('')
    ss = b.get('seasonStats') or {}
    if ss.get('n'):
        L.append(f'季节的历史概率（{ss["n"]} 个样本，5 天后；之后 5 天净流入：平时 {round(100 * (ss["base"]["flowPos"] or 0))}%）')
        for k_ in ('spring', 'summer', 'autumn', 'winter'):
            e = ss.get(k_) or {}
            if e.get('say'):
                L.append(f'  {SEASONS[k_]["emoji"]} {e["say" + M]}   （之后 5 天净流入 {round(100 * (e.get("flowPos") or 0))}%）')
        L.append('')

    def sec(title, key, metric=None):
        items = b.get(key) or []
        if not items:
            return
        L.append(f'{title}（{len(items)}）')
        for it in items[:8]:
            m = metric(it) if metric else ''
            L.append(f'  · {sk(it) or " "} {it.get("emoji", "")}{it["name"]:<10} {m:<12} {it["say" + M]}   ‹{it.get("path", "")}›')

    fm = lambda it: (money(it['flow5'], sign=True) if it.get('flow5') is not None else '')
    sec('各大陆的风', 'big', lambda it: f'风 {it["wind"]:+.2f}')
    sec('🌊 钱在涌进来', 'inflow', fm)
    sec('🏃 钱在溜走', 'outflow', fm)
    sec('🌀 风向刚变', 'fronts')
    sec('🌱 刚冒芽', 'springs', fm)
    sec('🧑‍🤝‍🧑 人挤人', 'crowded', lambda it: f'拥挤度 {it["pres"]}')
    sec('🏜️ 冷清洼地', 'quiet', lambda it: f'拥挤度 {it["pres"]}')
    sec('⛈️ 风暴', 'storms')
    sec('个股 · 钱流入最多', 'stocksIn', fm)
    sec('个股 · 钱流出最多', 'stocksOut', fm)
    if b.get('radar'):
        L.append('雷达（候选）')
        for it in b['radar']:
            L.append(f'  · {it["name"]:<14} {it["score"]}  [{it.get("label", "")}] {it["why" + M]}  ‹{it.get("path", "")}›')
    return '\n'.join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description='生成今日天气预报 brief.json')
    ap.add_argument('--data', default=str(DATA), help='web/data 目录')
    ap.add_argument('--i', type=int, default=None, help='日期下标（默认最后一天；负数从后往前数）')
    ap.add_argument('--out', default=None, help='输出路径（默认 <data>/brief.json）')
    ap.add_argument('--fm', default=None, help='全市场候选 candidates.json（默认 <data>/fm/candidates.json，存在才用）')
    ap.add_argument('--no-fm', action='store_true', help='不叠加全市场雷达')
    ap.add_argument('--gl', default=None, help='全球地图目录（默认 <data>/gl，存在才用；§23）')
    ap.add_argument('--no-gl', action='store_true', help='不叠加全球雷达')
    ap.add_argument('--print', dest='show', action='store_true', help='打印给人看的版本')
    ap.add_argument('--mild', action='store_true', help='打印温和版')
    ap.add_argument('--no-write', action='store_true', help='不写文件')
    a = ap.parse_args(argv)
    d = Path(a.data)
    if not (d / 'tree.json').exists() or not (d / 'meta.json').exists():
        print(f'[brief] 找不到 {d}/tree.json 或 meta.json，先跑 compute.py', file=sys.stderr)
        return 1
    W = World(d, a.i)
    fm_path = None if a.no_fm else (Path(a.fm) if a.fm else d / 'fm' / 'candidates.json')
    R_fm = Radar(W, fm_path if (fm_path and W.latest) else None)
    gl_dir = None if (a.no_gl or not W.latest) else (Path(a.gl) if a.gl else d / 'gl')
    R_gl = global_radar(W, gl_dir) if (gl_dir is not None and gl_dir.resolve() != d.resolve()) else Radar(W, None)
    R = merge_radars(W, R_fm, R_gl)
    b = build(W, R)
    probs = check(b)
    for p in probs:
        print('[brief] ⚠', p, file=sys.stderr)
    if a.show:
        print(pretty(b, a.mild))
    if not a.no_write:
        out = Path(a.out) if a.out else d / 'brief.json'
        tmp = out.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(b, ensure_ascii=False, allow_nan=False, separators=(',', ':')), encoding='utf-8')
        tmp.replace(out)
        print(f'[brief] 写好了 {out}  ({b["asOfLabel"]}, spotlight {len(b["spotlight"])}, tour {len(b["tour"])}, '
              f'radar {len(R_fm.items)}+{len(R_gl.items)}, holdings {len(b["holdings"])})', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
