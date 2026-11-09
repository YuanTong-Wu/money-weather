"""Playbook step 4 (比价钱): what today's price already demands, for the stocks under a landing spot.

The owner's method (same formulas as their market_dates/compute.py, discount rate r = 10%):
multiple m = market cap ÷ one year of free cash flow (profit if cash flow is not positive).
  - m·r < 1: the price pays for only N = −ln(1 − m·r) / ln(1 + r) years of today's money, i.e. it is
    betting the business goes downhill;
  - otherwise the price demands perpetual growth g = (m·r − 1) / (m + 1) a year.
"涨了五倍但价格只要求利润不掉，照样有时间差；没怎么涨但价格已经要了十年的高增长，照样没有。"
If we cannot find the numbers we say "没查到" (never treat missing as cheap).

    from valuation import lookup, view, summary
    raw = lookup(["MU", "ACN"])          # yfinance .info, cached 3 days in scenario/cache/valuation.json
    v = view(raw["MU"], dir_=1)          # {multiple, basis, est, demand, say, sayMild, wait, …}

Network failures never break a scenario: missing tickers come back as None. Set
MW_SCENARIO_VALUATION=0 to skip the lookup entirely.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache" / "valuation.json"
TTL = 3 * 86400
FIELDS = ("marketCap", "freeCashflow", "netIncomeToCommon", "trailingPE", "forwardPE", "revenueGrowth",
          "quoteType", "totalRevenue")
ENABLED = os.environ.get("MW_SCENARIO_VALUATION", "1") not in ("0", "false", "no")
_lock = threading.Lock()


def _f(x):
    try:
        x = float(x)
        return None if (math.isnan(x) or math.isinf(x)) else x
    except (TypeError, ValueError):
        return None


def _load_cache() -> dict:
    try:
        return json.loads(CACHE.read_text())
    except Exception:
        return {}


def _save_cache(c: dict):
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(c, ensure_ascii=False))
        os.replace(tmp, CACHE)
    except Exception:
        pass


def _fetch_one(t: str) -> dict | None:
    try:
        import yfinance as yf  # slow import: only when needed
        info = yf.Ticker(t).info or {}
    except Exception:
        return None
    out = {k: info.get(k) for k in FIELDS}
    if out.get("marketCap") is None and out.get("quoteType") != "ETF":
        return None
    return out


def lookup(tickers: list[str], budget_s: float = 45.0, workers: int = 8) -> dict[str, dict | None]:
    """→ {ticker: raw fields or None}. Uses the cache; fetches the rest in parallel within budget_s."""
    tickers = list(dict.fromkeys(t for t in tickers if t))
    cache = _load_cache()
    now = time.time()
    out, todo = {}, []
    for t in tickers:
        hit = cache.get(t)
        if hit and now - hit.get("at", 0) < TTL:
            out[t] = hit.get("v")
        else:
            todo.append(t)
    if todo and ENABLED:
        ex = ThreadPoolExecutor(max_workers=workers)
        futs = {ex.submit(_fetch_one, t): t for t in todo}
        done, _ = wait(futs, timeout=budget_s)
        for fu in done:
            t = futs[fu]
            try:
                v = fu.result()
            except Exception:
                v = None
            out[t] = v
            if v is not None:
                cache[t] = {"at": now, "v": v}
        ex.shutdown(wait=False, cancel_futures=True)
        with _lock:
            _save_cache(cache)
    for t in tickers:
        out.setdefault(t, None)
    return out


R = 0.10  # discount rate


def years_flat(m: float | None, r: float = R) -> float | None:
    """Years of flat cash flow the price pays for; None when the price is above the flat perpetuity."""
    if m is None or not (m > 0) or m * r >= 1:
        return None
    return -math.log(1 - m * r) / math.log(1 + r)


def growth_perp(m: float | None, r: float = R) -> float | None:
    """Perpetual growth the price demands (negative = below the flat perpetuity)."""
    if m is None or not (m > 0):
        return None
    return (m * r - 1) / (m + 1)


def demand_of(m: float, dir_: int) -> tuple[str, str]:
    """→ (demand key, sharp sentence ≤ 30 字) for a multiple m."""
    n, g = years_flat(m), growth_perp(m)
    if n is not None:
        key = "low"
        say = (f"价格只为今天的钱付 {n:.0f} 年，在赌它走下坡" if dir_ > 0 else
               f"只付 {n:.0f} 年的钱，下坡大半已进价")
    elif g <= 0.03:
        key = "flat"
        say = (f"价格只要它别往下走（隐含每年 +{g * 100:.0f}%）" if dir_ > 0 else
               f"价格只要它别往下走，真掉了才疼")
    elif g <= 0.07:
        key = "high"
        say = (f"价格要它永远每年长 {g * 100:.0f}%，几年增长先付了" if dir_ > 0 else
               f"还要它每年长 {g * 100:.0f}%，坏消息一来摔得疼")
    else:
        key = "future"
        say = (f"价格要它永远每年长 {g * 100:.0f}% 以上，未来早被预支" if dir_ > 0 else
               f"要它每年长 {g * 100:.0f}% 以上，坏消息一来最疼")
    return key, say


def _mild(m: float, cash: bool) -> str:
    n, g = years_flat(m), growth_perp(m)
    what = "现金流" if cash else "利润"
    tail = f"相当于只为 {n:.0f} 年的{what}付钱" if n is not None else f"隐含永续增长约 {g * 100:.1f}%"
    return f"市值约是一年{what}的 {m:.0f} 倍，{tail}（按 10% 折现）"


def view(raw: dict | None, dir_: int = 1) -> dict:
    """What the price demands, in the owner's words, for one stock."""
    if not raw:
        return {"multiple": None, "demand": "none", "est": True, "basis": "没查到",
                "say": "价格要的没查到，别当成便宜", "sayMild": "估值数据没查到", "wait": None}
    if raw.get("quoteType") == "ETF":
        return {"multiple": None, "demand": "etf", "est": True, "basis": "ETF 不算倍数，要看里面的公司",
                "say": "ETF，倍数要看里面的公司", "sayMild": "ETF，不单独算倍数", "wait": None}
    mcap = _f(raw.get("marketCap"))
    fcf, ni = _f(raw.get("freeCashflow")), _f(raw.get("netIncomeToCommon"))
    pe, fpe = _f(raw.get("trailingPE")), _f(raw.get("forwardPE"))
    m_fcf = mcap / fcf if (mcap and fcf and fcf > 0) else None
    m_ni = mcap / ni if (mcap and ni and ni > 0) else None
    if m_ni is None and pe and pe > 0:
        m_ni = pe
    rg = _f(raw.get("revenueGrowth"))
    base = {"mcapB": round(mcap / 1e9, 1) if mcap else None, "pe": round(pe, 1) if pe else None,
            "fpe": round(fpe, 1) if fpe else None, "mFcf": round(m_fcf, 1) if m_fcf else None,
            "mNi": round(m_ni, 1) if m_ni else None, "revGrowth": round(rg, 3) if rg is not None else None}
    if m_fcf is not None:
        m, basis, est, cash = m_fcf, "市值 ÷ 一年自由现金流", False, True
    elif m_ni is not None:
        m, basis, est, cash = m_ni, "现金流不是正的，用利润代替", True, False
    else:
        return {**base, "multiple": None, "demand": "future", "est": False,
                "basis": "现金流和利润都不是正的",
                "say": "没利润没现金流，价格要的全是未来" if dir_ > 0 else "没利润还贵着，坏消息来了摔得最狠",
                "sayMild": "目前没有正的利润或现金流", "wait": "干等一年是纯亏：没现金流，全靠故事撑"}
    demand, say = demand_of(m, dir_)
    mild = _mild(m, cash)
    if cash and m_ni and m_ni < 0.5 * m:
        est, basis = True, "现金流和利润差得远（扩产或口径不同），两个都列"
        if dir_ > 0:
            say += f"；按利润只要 {m_ni:.0f} 倍"
        mild += f"；按利润算只有 {m_ni:.0f} 倍（扩产或口径把现金流压低了）"
    if fpe and pe and 0 < fpe < 0.6 * pe and dir_ > 0:
        mild += f"；远期市盈率 {fpe:.0f}，价格在赌利润见顶"
    yld = 100.0 / m if m > 0 else None
    wait_s = (f"干等一年：生意本身每年挣回市值的约 {yld:.0f}%" if yld and yld >= 1
              else "干等一年代价大：自己挣的钱很少")
    g = growth_perp(m)
    return {**base, "multiple": round(m, 1), "years": (round(years_flat(m), 1) if years_flat(m) else None),
            "impliedGrowth": round(g, 3) if g is not None else None, "demand": demand, "est": est,
            "basis": basis, "say": say, "sayMild": mild, "wait": wait_s, "yieldPct": round(yld, 1) if yld else None}


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    k = len(xs)
    return xs[k // 2] if k % 2 else (xs[k // 2 - 1] + xs[k // 2]) / 2


def summary(views: list[dict], dir_: int = 1) -> dict | None:
    """What the price demands for one landing spot: median over the stocks shown under it."""
    if not views:
        return None
    n_all = len(views)
    kinds = [v.get("demand") for v in views]
    if all(k == "etf" for k in kinds):
        return {"median": None, "n": 0, "of": n_all, "demand": "etf", "est": False,
                "say": "一篮子 ETF，不按倍数比价钱，看抢跑度", "sayMild": "ETF：不单独算倍数，看抢跑度"}
    ms = [v["multiple"] for v in views if v.get("multiple")]
    loss = sum(1 for v in views if v.get("demand") == "future" and v.get("multiple") is None)
    if loss and loss >= len(ms):
        return {"median": None, "n": len(ms), "of": n_all, "loss": loss, "demand": "future", "est": False,
                "say": (f"{loss}/{n_all} 家没利润没现金流，价格要的全是未来" if dir_ > 0
                        else f"{loss}/{n_all} 家没利润，坏消息来了摔得最狠"),
                "sayMild": f"{loss}/{n_all} 家目前没有正的利润或现金流"}
    if not ms:
        return {"median": None, "n": 0, "of": n_all, "demand": "none", "est": True,
                "say": "价格要的没查到，别当成便宜", "sayMild": "估值数据没查到"}
    med = _median(ms)
    demand, say = demand_of(med, dir_)
    mild = f"中位数：{_mild(med, True)}（{len(ms)}/{n_all} 家算得出）"
    mn = [v["mNi"] for v in views if v.get("mNi")]
    if mn and _median(mn) < 0.5 * med:
        if dir_ > 0:
            say += f"；按利润只要 {_median(mn):.0f} 倍"
        mild += f"；按利润算中位数 {_median(mn):.0f} 倍（扩产或口径压低了现金流）"
    if loss:
        mild += f"；另有 {loss} 家没利润"
    n, g = years_flat(med), growth_perp(med)
    return {"median": round(med, 1), "n": len(ms), "of": n_all, "loss": loss, "demand": demand,
            "years": round(n, 1) if n else None, "impliedGrowth": round(g, 3) if g is not None else None,
            "est": len(ms) < max(2, (n_all + 1) // 2), "say": say, "sayMild": mild}
