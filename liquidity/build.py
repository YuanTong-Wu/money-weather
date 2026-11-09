#!/usr/bin/env python3
"""liquidity/build.py — 流动性气压: FRED + Treasury DTS → web/data/liquidity.json (DESIGN §23, §24).

    python3 liquidity/build.py            # fetch (cached: 6 h weekly, 2 h daily, RRP/DTS after each release) + compute + write
    python3 liquidity/build.py --force    # re-download everything
    python3 liquidity/build.py --offline  # cache only, never touch the network

Net liquidity ($ billions) = Fed balance sheet (WALCL) − Treasury account (TGA) − overnight reverse repo (RRP).
TGA is the Treasury's own daily closing balance (Daily Treasury Statement) where it exists, else FRED's
WDTGAL (Wednesday level — not WTREGEN, a week average); weekly series are carried forward to the next print. All values are real published data
(est:false); the only judgement is in `regime`, `pressure` and the sentences.

Regime (放水 / 收水 / 平稳): trend = % change of the 20-day mean of net liquidity vs the same mean 40 business
days earlier. Enter 放水 above +1.2 %, 收水 below −1.2 %; fall back to 平稳 once the trend is back inside ±0.3 %;
a change needs 3 days in a row (no flapping on tax days). `since` = first day of the current regime.

Pressure −3…3 ("气压"; + = 钱多/宽松 = high pressure, fair weather; − = 钱紧 = low pressure): a weighted mix of
robust z-scores (each vs its own trailing 3 years):
    0.40·z(20-day change of net liquidity, 5-day smoothed)
  + 0.20·−z(20-day change of the high-yield spread)
  + 0.15·−z(SOFR − IORB, the repo squeeze)
  + 0.15·−z(20-day change of the 2-year yield)
  + 0.10·−z(20-day change of the broad dollar)
then z-scored once more against its own 3-year history and clipped to ±3.

Output (all money in $ billions, rates in %, spreads in bp where named so):
{ asOf, generatedAt, source, units, note, est:false,
  dates:[~2y business days], series:{netliq, walcl, tga, rrp, reserves, dgs2, dgs10, curve, hy, ig, sofrIorb,
          nfci, breakeven, dollar, trend, pressure, state},
  lastObs:{key:date}, now:{…}, chg:{key:{d5,d20,d60}},
  regime:{state, since, days, prev, prevSince, fresh, trend, say, sayMild, why},
  pressure, pressureWord, components:[{key,name,value,unit,z,w,contrib,say}], drivers:{d20:{…}, regime:{…}},
  fronts:[{date, from, to}], watch:[…], headline, say, sayMild, brief:[…],
  overlay:{pressure, state, say},                  ← Planet.setOverlay('liquidity', …)
  tm:{dates:[meta.dates], pressure:[…], state:[…], netliq:[…]} }   ← aligned to the time machine
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from liquidity import net, sources as S  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data" / "liquidity.json"
META = ROOT / "web" / "data" / "meta.json"

SMOOTH, LAG, ENTER, EXIT, CONFIRM = 20, 40, 1.2, 0.3, 3
ZWIN, ZMIN = 756, 120
OUT_DAYS = 520
W = {"liq": 0.40, "credit": 0.20, "funding": 0.15, "rates": 0.15, "dollar": 0.10}


# --------------------------------------------------------------------------------------------
def rz(x: pd.Series, win: int = ZWIN, minp: int = ZMIN, clip: float = 3.0) -> pd.Series:
    """Robust z vs the trailing `win` values (incl. today): (x − median) / max(1.4826·MAD, 0.25·std)."""
    a = x.to_numpy(dtype=float)
    out = np.full(len(a), np.nan)
    for i in range(len(a)):
        if not np.isfinite(a[i]):
            continue
        v = a[max(0, i - win + 1):i + 1]
        v = v[np.isfinite(v)]
        if len(v) < minp:
            continue
        med = np.median(v)
        sc = max(1.4826 * np.median(np.abs(v - med)), 0.25 * np.std(v))
        out[i] = 0.0 if sc < 1e-12 else max(-clip, min(clip, (a[i] - med) / sc))
    return pd.Series(out, index=x.index)


def ffill_to(s: pd.Series | None, cal: pd.DatetimeIndex) -> pd.Series:
    if s is None or not len(s):
        return pd.Series(np.nan, index=cal)
    return s.reindex(s.index.union(cal)).ffill().reindex(cal)


def regime_states(trend: pd.Series) -> list[str]:
    state, cur, pend, cnt = [], "平稳", None, 0
    for v in trend.to_numpy():
        if not np.isfinite(v):
            state.append(cur)
            continue
        want = cur
        if cur == "平稳":
            want = "放水" if v > ENTER else ("收水" if v < -ENTER else cur)
        elif cur == "放水" and v < EXIT:
            want = "收水" if v < -ENTER else "平稳"
        elif cur == "收水" and v > -EXIT:
            want = "放水" if v > ENTER else "平稳"
        if want != cur:
            cnt = cnt + 1 if pend == want else 1
            pend = want
            if cnt >= CONFIRM:
                cur, pend, cnt = want, None, 0
        else:
            pend, cnt = None, 0
        state.append(cur)
    return state


def r1(x, nd=1):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return round(v, nd)


def yi(b: float) -> str:
    """$ billions → '1,234 亿美元' / '1.2 万亿美元'."""
    v = abs(b) * 10  # 亿
    if v >= 10000:
        return f"{v / 10000:.2f} 万亿美元"
    return f"{v:,.0f} 亿美元"


def bp(x: float) -> str:
    return f"{abs(x):.0f} 个基点"


def pressure_word(p: float) -> tuple[str, str]:
    if p >= 1.5:
        return "高压", "钱很多，天很晴"
    if p >= 0.5:
        return "偏高压", "钱偏松"
    if p > -0.5:
        return "平稳", "不松不紧"
    if p > -1.5:
        return "偏低压", "钱偏紧"
    return "低压", "钱很紧，要变天"


# --------------------------------------------------------------------------------------------
def build(series: dict[str, pd.Series], tga_d: pd.Series | None, info: dict, log=print) -> dict:
    for k in ("walcl", "rrp", "dgs2", "dgs10", "hy"):
        if k not in series:
            raise RuntimeError(f"missing required series {k}")
    # calendar: business days up to the newest daily print of the plumbing (RRP / DTS)
    ends = [series["rrp"].index[-1]]
    if tga_d is not None and len(tga_d):
        ends.append(tga_d.index[-1])
    end = max(ends)
    cal = pd.bdate_range("2017-01-02", end)
    f = {k: ffill_to(v, cal) for k, v in series.items()}
    tga = f.get("tga_w", pd.Series(np.nan, index=cal)).copy()
    tga_src = "WDTGAL"
    if tga_d is not None and len(tga_d):
        td = ffill_to(tga_d, cal)
        m = td.notna() & (cal >= tga_d.index[0])
        tga[m] = td[m]
        tga_src = "DTS"
    netliq = f["walcl"] - tga - f["rrp"]
    curve = (f["dgs10"] - f["dgs2"]) * 100
    sofr_iorb = (f["sofr"] - f["iorb"]) * 100 if "sofr" in f and "iorb" in f else pd.Series(np.nan, index=cal)

    # regime
    sm = netliq.rolling(SMOOTH, min_periods=SMOOTH).mean()
    trend = (sm / sm.shift(LAG) - 1) * 100
    states = pd.Series(regime_states(trend), index=cal)

    # pressure
    nl5 = netliq.rolling(5, min_periods=3).mean()
    comp_raw = {
        "liq": nl5 - nl5.shift(20),
        "credit": -(f["hy"] - f["hy"].shift(20)),
        "funding": -sofr_iorb,
        "rates": -(f["dgs2"] - f["dgs2"].shift(20)),
        "dollar": -(np.log(f["dollar"]) - np.log(f["dollar"].shift(20))) if "dollar" in f else pd.Series(np.nan, index=cal),
    }
    comp_z = {k: rz(v) for k, v in comp_raw.items()}
    num = sum(W[k] * comp_z[k].fillna(0) for k in W)
    den = sum(W[k] * comp_z[k].notna() for k in W)
    composite = (num / den.replace(0, np.nan)).where(den >= 0.5)
    pressure = rz(composite).clip(-3, 3)

    # ---- now
    i = len(cal) - 1
    d = cal[i]
    asof = d.strftime("%Y-%m-%d")
    st = states.iloc[i]
    run_start = i
    while run_start > 0 and states.iloc[run_start - 1] == st:
        run_start -= 1
    since = cal[run_start].strftime("%Y-%m-%d")
    prev = states.iloc[run_start - 1] if run_start > 0 else None
    prev_start = run_start - 1
    while prev_start > 0 and states.iloc[prev_start - 1] == prev:
        prev_start -= 1
    days = i - run_start + 1
    p_now = r1(pressure.iloc[i], 2) or 0.0
    pw, pw_say = pressure_word(p_now)

    def chg(s: pd.Series, n: int):
        if i - n < 0:
            return None
        return r1(s.iloc[i] - s.iloc[i - n], 2)

    walcl, tga_now, rrp = f["walcl"], tga, f["rrp"]
    d20 = {"netliq": chg(netliq, 20), "walcl": chg(walcl, 20), "tga": chg(tga_now, 20), "rrp": chg(rrp, 20)}
    dreg = {"netliq": r1(netliq.iloc[i] - netliq.iloc[run_start], 1), "walcl": r1(walcl.iloc[i] - walcl.iloc[run_start], 1),
            "tga": r1(tga_now.iloc[i] - tga_now.iloc[run_start], 1), "rrp": r1(rrp.iloc[i] - rrp.iloc[run_start], 1)}
    # contributions to the net-liquidity change: +walcl, −tga, −rrp
    contrib = {"walcl": d20["walcl"] or 0.0, "tga": -(d20["tga"] or 0.0), "rrp": -(d20["rrp"] or 0.0)}
    driver = max(contrib, key=lambda k: abs(contrib[k]))

    # ---- components (for the "为什么" of the pressure)
    comps = []
    names = {"liq": ("净流动性 4 周变化", "亿美元"), "credit": ("垃圾债利差 4 周变化", "基点"),
             "funding": ("回购利率 − 准备金利率", "基点"), "rates": ("2 年美债利率 4 周变化", "基点"),
             "dollar": ("美元（广义）4 周变化", "%")}
    for k in W:
        raw = comp_raw[k].iloc[i]
        z = comp_z[k].iloc[i]
        if k == "liq":
            val = r1((netliq.iloc[i] - netliq.iloc[i - 20]) * 10, 0) if i >= 20 else None  # 亿美元 (raw, as in the sentence)
        elif k == "credit":
            val = r1(-raw * 100, 0)        # bp, + = wider
        elif k == "funding":
            val = r1(-raw, 1)              # bp
        elif k == "rates":
            val = r1(-raw * 100, 0)        # bp
        else:
            val = r1(-raw * 100, 2)        # %
        zz = r1(z, 2)
        comps.append({"key": k, "name": names[k][0], "value": val, "unit": names[k][1], "z": zz, "w": W[k],
                      "contrib": r1((zz or 0) * W[k], 2),
                      "dir": 0 if zz is None or abs(zz) < 0.5 else (1 if zz > 0 else -1)})

    # ---- words (§12: numbers exact, opinion in the sentence)
    nl_d20 = d20["netliq"] or 0.0
    s1, s1m = regime_sentence(st, driver, contrib, nl_d20, days)
    s2, s2m = extra_sentence(comps, f, i, sofr_iorb, rrp)
    tail = "风险资产有水托着。" if p_now >= 1 else ("风险资产只能靠自己扛。" if p_now <= -1 else "")
    say = s1 + (s2 or "") + tail
    say_mild = s1m + (s2m or "")
    headline = f"钱的水位：{st}（自 {md(since)} 起），气压 {p_now:+.1f}，{pw_say}。"
    fresh = days <= 10 and prev is not None
    why = [f"净流动性四周 {sgn(nl_d20)}{yi(nl_d20)}：美联储资产{'多放' if contrib['walcl'] >= 0 else '收回'} "
           f"{yi(contrib['walcl'])}，财政部账户{'放出' if contrib['tga'] >= 0 else '吸走'} {yi(contrib['tga'])}，"
           f"逆回购{'放出' if contrib['rrp'] >= 0 else '吸走'} {yi(contrib['rrp'])}"]
    for c in sorted(comps, key=lambda c: -abs(c["contrib"] or 0))[:3]:
        if c["value"] is not None:
            why.append(f"{c['name']} {c['value']:+g} {c['unit']}（{'利好' if (c['z'] or 0) > 0 else '利空'}，强度 {abs(c['z'] or 0):.1f}）")

    watch = []
    if (rrp.iloc[i] or 0) < 50:
        watch.append({"key": "rrp_empty", "say": "逆回购池子已经见底：再缩表，就要直接抽银行准备金。",
                      "fact": f"逆回购余额只剩 {yi(rrp.iloc[i])}"})
    if np.isfinite(sofr_iorb.iloc[i]) and sofr_iorb.iloc[i] > 0:
        watch.append({"key": "repo_squeeze", "say": "回购利率高过准备金利率，银行体系的钱不算宽裕了。",
                      "fact": f"SOFR − IORB = {sofr_iorb.iloc[i]:+.0f} 个基点"})
    if np.isfinite(curve.iloc[i]) and curve.iloc[i] < 0:
        watch.append({"key": "inverted", "say": "收益率曲线还倒挂着，市场在押经济要降温。",
                      "fact": f"10年 − 2年 = {curve.iloc[i]:+.0f} 个基点"})

    # fronts: regime changes (the biggest "front" of the whole planet)
    ch = states[states != states.shift()]
    fronts = []
    prev_v = None
    for dd, v in ch.items():
        if prev_v is not None:
            fronts.append({"date": dd.strftime("%Y-%m-%d"), "from": prev_v, "to": v})
        prev_v = v
    fronts = fronts[-12:][::-1]

    # ---- series window
    w0 = max(0, len(cal) - OUT_DAYS)
    win = cal[w0:]
    keys = {"netliq": netliq, "walcl": walcl, "tga": tga_now, "rrp": rrp, "reserves": f.get("reserves"),
            "dgs2": f["dgs2"], "dgs10": f["dgs10"], "curve": curve, "hy": f["hy"], "ig": f.get("ig"),
            "sofrIorb": sofr_iorb, "nfci": f.get("nfci"), "breakeven": f.get("breakeven"), "dollar": f.get("dollar"),
            "trend": trend, "pressure": pressure}
    nd = {"netliq": 1, "walcl": 1, "tga": 1, "rrp": 1, "reserves": 1, "dgs2": 2, "dgs10": 2, "curve": 0, "hy": 2,
          "ig": 2, "sofrIorb": 1, "nfci": 3, "breakeven": 2, "dollar": 2, "trend": 2, "pressure": 2}
    out_series = {}
    for k, s in keys.items():
        if s is None:
            continue
        out_series[k] = [r1(v, nd[k]) for v in s.iloc[w0:].to_numpy()]
    out_series["state"] = list(states.iloc[w0:])

    now = {k: r1(s.iloc[i], nd[k]) for k, s in keys.items() if s is not None}
    chgs = {}
    for k in ("netliq", "walcl", "tga", "rrp", "reserves", "dgs2", "dgs10", "hy", "dollar"):
        s = keys.get(k)
        if s is None:
            continue
        chgs[k] = {"d5": chg(s, 5), "d20": chg(s, 20), "d60": chg(s, 60)}

    last_obs = {spec["key"]: info.get(sid, {}).get("last") for sid, spec in S.FRED.items()}
    last_obs["tga"] = (tga_d.index[-1].strftime("%Y-%m-%d") if tga_d is not None and len(tga_d) else last_obs.get("tga_w"))
    stale = [sid for sid, inf in info.items() if inf.get("source") in ("stale", "none")]

    # ---- time machine alignment (meta.dates)
    tm = None
    meta = net.read_json(META, {})
    if meta.get("dates"):
        md_ = pd.to_datetime(meta["dates"])
        idx = cal.get_indexer(md_, method="ffill")
        tm = {"dates": meta["dates"],
              "pressure": [r1(pressure.iloc[j], 2) if j >= 0 else None for j in idx],
              "state": [states.iloc[j] if j >= 0 else None for j in idx],
              "netliq": [r1(netliq.iloc[j], 1) if j >= 0 else None for j in idx]}

    brief = [{"text": headline, "say": say, "sayMild": say_mild}]
    if fresh:
        brief.insert(0, {"text": f"流动性风向刚变：{prev} → {st}（{md(since)}）", "say": s1, "sayMild": s1m, "front": True})

    return {
        "asOf": asof,
        "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "FRED (St. Louis Fed) csv: WALCL WDTGAL RRPONTSYD WRBWFRBL DGS2 DGS10 BAMLH0A0HYM2 BAMLC0A0CM "
                  "SOFR IORB DFF NFCI T10YIE DTWEXBGS; U.S. Treasury Daily Treasury Statement (TGA closing balance)",
        "units": {"netliq": "$B", "walcl": "$B", "tga": "$B", "rrp": "$B", "reserves": "$B", "dgs2": "%", "dgs10": "%",
                  "curve": "bp", "hy": "%", "ig": "%", "sofrIorb": "bp", "nfci": "index", "breakeven": "%",
                  "dollar": "index", "trend": "%", "pressure": "−3…3"},
        "note": "netliq = WALCL − TGA − RRP. pressure > 0 = 钱多/宽松（高气压），< 0 = 钱紧（低气压），跟它自己过去三年比。"
                "regime 由净流动性 20 日均值相对 40 个交易日前的变化判定（±1.2% 进入，±0.3% 退出，连续 3 天确认）。",
        "est": False,
        "tgaSource": tga_src,
        "stale": stale,
        "dates": [x.strftime("%Y-%m-%d") for x in win],
        "series": out_series,
        "lastObs": last_obs,
        "now": now,
        "chg": chgs,
        "regime": {"state": st, "since": since, "days": int(days), "prev": prev,
                   "prevSince": cal[prev_start].strftime("%Y-%m-%d") if prev is not None else None,
                   "fresh": bool(fresh), "trend": r1(trend.iloc[i], 2), "say": s1, "sayMild": s1m, "why": why},
        "pressure": p_now,
        "pressureWord": pw,
        "pressureSay": pw_say,
        "components": comps,
        "drivers": {"d20": d20, "regime": dreg, "main": driver},
        "fronts": fronts,
        "watch": watch,
        "headline": headline,
        "say": say,
        "sayMild": say_mild,
        "brief": brief,
        "overlay": {"pressure": p_now, "state": st, "say": s1, "since": since, "fresh": bool(fresh)},
        "tm": tm,
    }


def sgn(x) -> str:
    return "+" if (x or 0) >= 0 else "−"


def md(s: str) -> str:
    try:
        d = datetime.strptime(s, "%Y-%m-%d")
        return f"{d.month}月{d.day}日"
    except Exception:
        return s


def regime_sentence(st: str, driver: str, contrib: dict, nl_d20: float, days: int) -> tuple[str, str]:
    c = contrib[driver]
    if st == "放水":
        if driver == "tga":
            return (f"财政部在往外撒钱：TGA 四周放出 {yi(c)}，水位在涨。", f"财政部账户在下降，净流动性回升。")
        if driver == "rrp":
            return (f"逆回购池子在放水，{yi(c)} 回到市场。", "逆回购余额下降，资金回流市场。")
        return (f"美联储在扩表，四周多放了 {yi(c)}。", "美联储资产负债表在扩张。")
    if st == "收水":
        if driver == "tga":
            return (f"财政部在抽水：TGA 四周吸走 {yi(c)}，市场的钱变少了。", "财政部账户在上升，净流动性下降。")
        if driver == "rrp":
            return (f"钱在躲进逆回购，四周 {yi(c)} 离开市场。", "逆回购余额上升，市场资金减少。")
        return (f"美联储还在缩表，四周抽走 {yi(c)}。", "美联储资产负债表在收缩。")
    # 平稳
    if abs(nl_d20) < 30:
        side = "多了" if nl_d20 > 0 else "少了"
        return (f"水位四周只{side} {yi(nl_d20)}，美联储和财政部都没大动作。", "净流动性四周基本持平。")
    side = "多了" if nl_d20 > 0 else "少了"
    who = {"tga": "财政部账户", "rrp": "逆回购", "walcl": "美联储资产"}[driver]
    return (f"水位四周{side} {yi(nl_d20)}，主要是{who}在动，还没成气候。", f"净流动性四周{side} {yi(nl_d20)}，趋势未成。")


def extra_sentence(comps: list[dict], f: dict, i: int, sofr_iorb: pd.Series, rrp: pd.Series) -> tuple[str | None, str | None]:
    """The most extreme non-liquidity component, in words."""
    best = None
    for c in comps:
        if c["key"] == "liq" or c["z"] is None or c["value"] is None:
            continue
        if abs(c["z"]) >= 1.0 and (best is None or abs(c["z"]) > abs(best["z"])):
            best = c
    if not best:
        return None, None
    k, v, z = best["key"], best["value"], best["z"]
    if k == "credit":
        return ((f"垃圾债利差四周走阔 {bp(v)}，借钱开始变贵。", "高收益债利差走阔。") if v > 0 else
                (f"垃圾债利差四周收窄 {bp(v)}，借钱的人很放松。", "高收益债利差收窄。"))
    if k == "funding":
        return ((f"回购利率比准备金利率高 {v:.0f} 个基点，银行的钱开始紧。", "回购利率高于准备金利率。") if v > 0 else
                (f"回购利率比准备金利率低 {abs(v):.0f} 个基点，银行间不缺钱。", "回购市场资金充裕。"))
    if k == "rates":
        return ((f"2 年美债四周涨了 {bp(v)}，市场在赌美联储不松口。", "短端利率上行。") if v > 0 else
                (f"2 年美债四周跌了 {bp(v)}，市场在押降息。", "短端利率下行。"))
    if k == "dollar":
        return ((f"美元四周涨了 {abs(v):.1f}%，全球的钱更紧了。", "美元走强。") if v > 0 else
                (f"美元四周跌了 {abs(v):.1f}%，全球的钱松了一口气。", "美元走弱。"))
    return None, None


# --------------------------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--force", action="store_true", help="re-download even if the cache is fresh")
    ap.add_argument("--offline", action="store_true", help="use the cache only")
    ap.add_argument("--quick", action="store_true", help="update.sh --quick: same as the default (release-aware cache)")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    log = (lambda *x, **k: None) if a.quiet else print
    t0 = time.time()
    if a.offline:
        S.TTL_S = 10 ** 12
    series, info = S.fetch_fred(force=a.force, log=log)
    tga_d, dinf = S.fetch_dts(force=a.force, log=log)
    info["DTS"] = dinf
    missing = [sid for sid in S.REQUIRED if S.FRED[sid]["key"] not in series]
    if missing:
        print(f"liquidity: missing required series {missing}; keeping the previous file", file=sys.stderr)
        return 2
    out = build(series, tga_d, info, log=log)
    net.write_json(Path(a.out), out)
    r = out["regime"]
    log(f"wrote {Path(a.out).relative_to(ROOT) if Path(a.out).is_relative_to(ROOT) else a.out} "
        f"({Path(a.out).stat().st_size / 1024:.0f} KB) in {time.time() - t0:.1f}s")
    log(f"asOf {out['asOf']}  netliq {out['now']['netliq']} $B  regime {r['state']} since {r['since']} "
        f"(trend {r['trend']}%)  pressure {out['pressure']:+.2f} {out['pressureWord']}")
    log(f"say: {out['say']}")
    for c in out["components"]:
        log(f"   {c['name']:<16} {c['value']!s:>8} {c['unit']:<4} z={c['z']!s:>6} → {c['contrib']!s:>6}")
    for w_ in out["watch"]:
        log(f"   watch: {w_['say']} ({w_['fact']})")
    if out["stale"]:
        log(f"   stale/missing: {out['stale']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
