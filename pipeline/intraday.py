#!/usr/bin/env python3
"""intraday.py — on-demand 5-minute money flow for one ticker (used by server.py /api/intraday).

    python3 pipeline/intraday.py MU      # prints the JSON

get_intraday("MU") → {"t","asOf","session","prevClose","bars":[{"ts","c","v","flow"}],"days":[{"date","flow","dv","ret"}]}
  bars = the latest session's 5-minute bars; flow per bar (USD millions) =
         C·V · clip(0.5·clv + 0.5·tanh(ret/σ_5m), −1, 1), σ_5m = stdev of same-day 5-minute returns (5 days).
  days = one summary per session in the 5-day window (flow/dv in USD millions, ret = close/prev close − 1).
  A session still trading (US regular hours) is NOT a full day: its summary carries
  partial = {etTime, fraction, label:"盘中（截至 HH:MM ET）", dvFull, flowFull} — dv/flow stay what traded so far,
  dvFull/flowFull are the full-day estimates (pipeline/session.py U-curve, pulled toward the other days' typical dv
  early in the session), so nobody compares half a day with full days by accident.
On any failure returns {"error": "..."}; never raises.
"""
from __future__ import annotations

import json
import logging
import math
import re
import sys
import threading
import time

import numpy as np
import pandas as pd

_YF_LOCK = threading.Lock()
TICKER_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-^=]{0,14}$")


def _r(v, nd):
    v = float(v)
    return round(v, nd) + 0.0 if math.isfinite(v) else None


def clean_ticker(t: str) -> str | None:
    t = (t or "").strip().upper()
    if t.startswith("S:"):
        t = t[2:]
    t = t.replace(".", "-") if re.match(r"^[A-Z]+\.[A-Z]$", t) else t
    return t if TICKER_RE.match(t) else None


def get_intraday(ticker: str) -> dict:
    t = clean_ticker(ticker)
    if not t:
        return {"error": "股票代码不对", "t": ticker}
    df = None
    err = None
    for attempt in range(3):
        try:
            import yfinance as yf

            logging.getLogger("yfinance").setLevel(logging.CRITICAL)
            try:
                yf.config.debug.hide_exceptions = False  # we want rate-limit errors raised (to retry)
            except Exception:  # noqa: BLE001
                pass
            with _YF_LOCK:  # one Yahoo request at a time: parallel calls trip the rate limiter
                df = yf.Ticker(t).history(period="5d", interval="5m", auto_adjust=True, prepost=False,
                                          actions=False)
            err = None
            break
        except Exception as e:  # noqa: BLE001
            err = e
            name = type(e).__name__
            if "RateLimit" in name or "Timeout" in name or "Connection" in name:
                time.sleep(1.0 + 1.5 * attempt)
                continue
            break
    if err is not None:
        msg = str(err)
        if "delisted" in msg or "No data" in msg or "not found" in msg.lower() or "404" in msg:
            return {"error": "暂时拿不到盘中数据（可能还没开盘或代码没有分时数据）", "t": t}
        return {"error": f"暂时拿不到盘中数据（{type(err).__name__}）", "t": t}
    if df is None or df.empty or "Close" not in df:
        return {"error": "暂时拿不到盘中数据（可能还没开盘或代码没有分时数据）", "t": t}
    try:
        return _compute(t, df)
    except Exception as e:  # noqa: BLE001
        return {"error": f"盘中数据算不出来（{type(e).__name__}: {e}）", "t": t}


def _compute(t: str, df: pd.DataFrame) -> dict:
    df = df[["Open", "High", "Low", "Close", "Volume"]].astype(float).dropna(subset=["Close"])
    if df.empty:
        return {"error": "暂时拿不到盘中数据", "t": t}
    idx = df.index
    if idx.tz is None:
        idx = idx.tz_localize("America/New_York")
    else:
        idx = idx.tz_convert("America/New_York")
    df.index = idx
    C, H, L, V = (df[c].to_numpy() for c in ("Close", "High", "Low", "Volume"))
    V = np.nan_to_num(V)
    day = np.array([d.date() for d in idx])
    prevC = np.r_[np.nan, C[:-1]]
    ret = C / prevC - 1.0
    same_day = np.r_[False, day[1:] == day[:-1]]
    r_same = ret[same_day & np.isfinite(ret)]
    sigma = float(np.std(r_same)) if r_same.size > 10 else 0.002
    sigma = max(sigma, 1e-4)
    rng = H - L
    clv = np.where(rng > 0, ((C - L) - (H - C)) / np.where(rng > 0, rng, 1.0), 0.0)
    clv = np.clip(np.nan_to_num(clv), -1, 1)
    push = np.clip(0.5 * clv + 0.5 * np.tanh(np.nan_to_num(ret) / sigma), -1, 1)
    DV = C * V
    flow = DV * push / 1e6

    days_u = list(dict.fromkeys(day.tolist()))
    days = []
    prev_close = None
    for d in days_u:
        m = day == d
        last_c = C[m][-1]
        base = prev_close if prev_close is not None else df["Open"].to_numpy()[m][0]
        days.append({"date": d.isoformat(), "flow": _r(flow[m].sum(), 2), "dv": _r(DV[m].sum() / 1e6, 2),
                     "ret": _r(last_c / base - 1.0, 4) if base else None})
        prev_close = last_c
    last_day = days_u[-1]
    _mark_partial(days, idx[-1])
    m = day == last_day
    prior = C[~m & (day < last_day)]
    bars = []
    for ts, c, v, f in zip(idx[m], C[m], V[m], flow[m]):
        bars.append({"ts": ts.isoformat(), "c": _r(c, 4 if c < 10 else 2), "v": int(v), "flow": _r(f, 3)})
    return {
        "t": t,
        "asOf": idx[-1].isoformat(),
        "session": last_day.isoformat(),
        "prevClose": _r(prior[-1], 4) if prior.size else None,
        "bars": bars,
        "days": days,
    }


def _mark_partial(days: list[dict], last_ts) -> None:
    """The newest session still trading → days[-1]["partial"] (see the module docstring). Bars are stamped at their
    start: the session has run until last bar + 5 minutes."""
    try:
        import os
        from datetime import datetime, timedelta
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import session as S  # pipeline/session.py
        d = days[-1]["date"]
        now = datetime.now(S.NY)
        if str(now.date()) != d or not S.is_open(now):
            return
        t = min(last_ts.to_pydatetime() + timedelta(minutes=5), now)
        f = S.session_fraction(t, d)
        if not (0 < f < 1):
            return
        prev = [x["dv"] for x in days[:-1] if isinstance(x.get("dv"), (int, float)) and x["dv"] > 0]
        typ = float(np.median(prev)) if prev else None
        dv = days[-1]["dv"] or 0.0
        full = float(S.full_day_volume(dv, f, typ))
        k = full / dv if dv > 0 else None
        et = t.strftime("%H:%M")
        days[-1]["partial"] = {"etTime": et, "fraction": round(f, 3), "label": f"盘中（截至 {et} ET）",
                               "dvFull": _r(full, 2), "flowFull": _r(days[-1]["flow"] * k, 2) if k and days[-1]["flow"] is not None else None,
                               "say": f"盘中（截至美东 {et}）：平常这时约成交了全天的 {round(f * 100)}%，dv/flow 是到现在为止的，"
                                      f"dvFull/flowFull 是按全天折算的估计"}
    except Exception:  # noqa: BLE001 — a label never breaks the bars
        return


if __name__ == "__main__":
    out = get_intraday(sys.argv[1] if len(sys.argv) > 1 else "SPY")
    if "bars" in out:
        print(json.dumps({**out, "bars": out["bars"][:3] + ["…"] + out["bars"][-2:]}, ensure_ascii=False, indent=1))
        print(f"{len(out['bars'])} bars in latest session; Σflow today = {sum(b['flow'] or 0 for b in out['bars']):.1f} USDm")
    else:
        print(json.dumps(out, ensure_ascii=False))
