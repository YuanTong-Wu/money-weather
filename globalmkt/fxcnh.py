#!/usr/bin/env python3
"""fxcnh.py — a USD/CNH (offshore yuan) daily series that is actually fresh every day.

Why: Yahoo's daily `CNY=X` (onshore) is frozen on ~19 % of days and then jumps when it catches up (e.g. 0.149748 USD
per CNY on 10-21…10-26, then +0.35 % on 10-27), so every A-share got an FX-only "return" on the catch-up day. Yahoo's
daily `CNH=X` / `USDCNH=X` only ever returns the latest bar, but its HOURLY bars (interval=1h, 730 days) are complete
and change every day. This module turns them into daily series:

  daily_close("asia")  per date: the last hourly bar starting at or before 07:00 UTC (= 15:00 Beijing / 16:00 HK,
                       the A-share and HK closes) — the rate to convert that day's Chinese closing prices with.
  daily_ohlc("ny")     FX-day bars ending 17:00 New York (the usual FX day), weekdays only — for the macro planet.
  spliced(fallback)    CNH where it exists, the fallback (daily CNY=X) only before CNH history starts or on gaps.

    python3 globalmkt/fxcnh.py      # print the last days of both cuts next to Yahoo's daily CNY=X

CNH vs CNY differ by a basis of ~0.1 % (median |CNH/CNY − 1| = 0.12 % over 2026); that is far smaller than the
stale-then-jump error it replaces. Values are CNH per 1 USD (like CNY=X ≈ 6.66).
"""
from __future__ import annotations

import sys
import time

import pandas as pd

SYMBOL = "CNH=X"
ASIA_LAST_HOUR_UTC = 7          # bar starting 07:00 UTC closes 08:00 UTC = HK close; A-shares close 07:00 UTC
_cache: dict = {}


def _log(*a):
    print("[fxcnh]", *a, file=sys.stderr, flush=True)


def hourly(sym: str = SYMBOL, days: int = 730, tries: int = 3) -> pd.Series:
    """Hourly closes (tz-aware UTC index). Raises when Yahoo returns nothing usable."""
    key = (sym, days)
    if key in _cache:
        return _cache[key]
    import yfinance as yf
    last = None
    for i in range(tries):
        try:
            df = yf.download(sym, period=f"{days}d", interval="1h", progress=False, auto_adjust=False, threads=False)
            c = df["Close"]
            if hasattr(c, "columns"):
                c = c.iloc[:, 0]
            c = c.dropna()
            c = c[c > 0]
            if len(c) > 100:
                idx = c.index.tz_convert("UTC") if c.index.tz is not None else c.index.tz_localize("UTC")
                s = pd.Series(c.to_numpy(dtype=float), index=idx).sort_index()
                s = s[~s.index.duplicated(keep="last")]
                _cache[key] = s
                return s
            last = f"only {len(c)} bars"
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"no hourly {sym}: {last}")


def daily_close(cut: str = "asia", sym: str = SYMBOL) -> pd.Series:
    """Daily CNH per USD indexed by naive midnight Timestamps (weekdays only)."""
    h = hourly(sym)
    if cut == "asia":
        df = pd.DataFrame({"c": h.to_numpy(), "d": h.index.tz_localize(None).normalize(), "hr": h.index.hour})
        s = df[df.hr <= ASIA_LAST_HOUR_UTC].groupby("d").c.last()
    elif cut == "ny":
        s = daily_ohlc("ny", sym)["Close"]
    else:
        raise ValueError(cut)
    s = s[s.index.dayofweek < 5]
    s.index = pd.DatetimeIndex(s.index)
    return s.astype(float)


def daily_ohlc(cut: str = "ny", sym: str = SYMBOL) -> pd.DataFrame:
    """FX-day OHLC: the day ending 17:00 New York (Sunday-evening bars belong to Monday). Volume 0 (FX has none)."""
    h = hourly(sym)
    ny = h.index.tz_convert("America/New_York")
    day = (ny + pd.Timedelta(hours=7)).tz_localize(None).normalize()      # 17:00 NY → next calendar day
    df = pd.DataFrame({"c": h.to_numpy(), "d": day})
    g = df.groupby("d").c
    out = pd.DataFrame({"Open": g.first(), "High": g.max(), "Low": g.min(), "Close": g.last()})
    out = out[out.index.dayofweek < 5]
    out["Volume"] = 0.0
    out.index = pd.DatetimeIndex(out.index)
    return out.astype(float)


def spliced(fallback: pd.Series | None, cut: str = "asia") -> tuple[pd.Series, dict]:
    """CNH daily (cut) where it exists; `fallback` (any date-like index, same units) before/where CNH has no day.
    → (series indexed by naive Timestamps, info {source, cnhFrom, cnhDays, fallbackDays})."""
    try:
        cnh = daily_close(cut)
    except Exception as e:  # noqa: BLE001
        _log("CNH hourly unavailable, using the fallback only:", e)
        if fallback is None:
            raise
        fb = fallback.copy()
        fb.index = pd.DatetimeIndex(pd.to_datetime(fb.index)).normalize()
        return fb.astype(float), {"source": "fallback", "error": str(e)[:200]}
    if fallback is None or not len(fallback):
        return cnh, {"source": "CNH=X 1h", "cnhFrom": str(cnh.index[0].date()), "cnhDays": int(len(cnh)),
                     "fallbackDays": 0}
    fb = fallback.copy()
    fb.index = pd.DatetimeIndex(pd.to_datetime(fb.index)).normalize()
    fb = fb[~fb.index.duplicated(keep="last")]
    extra = fb[~fb.index.isin(cnh.index) & ((fb.index < cnh.index[0]) | (fb.index > cnh.index[-1]))]
    out = pd.concat([cnh, extra.astype(float)]).sort_index()
    return out, {"source": "CNH=X 1h (" + cut + " close) + CNY=X daily before/after", "cnhFrom": str(cnh.index[0].date()),
                 "cnhTo": str(cnh.index[-1].date()), "cnhDays": int(len(cnh)), "fallbackDays": int(len(extra))}


if __name__ == "__main__":
    import yfinance as yf
    a = daily_close("asia")
    n = daily_ohlc("ny")["Close"]
    y = yf.download("CNY=X", period="1mo", progress=False, auto_adjust=False, threads=False)["Close"]
    if hasattr(y, "columns"):
        y = y.iloc[:, 0]
    y.index = pd.DatetimeIndex(y.index).tz_localize(None).normalize()
    j = pd.concat([a.rename("cnh_asia"), n.rename("cnh_ny"), y.rename("cny_daily")], axis=1).tail(12)
    print(j.round(5).to_string())
    print("unchanged day-to-day: asia", round(float((a.diff().iloc[-250:] == 0).mean()), 3),
          "| CNY=X daily", round(float((y.diff() == 0).mean()), 3))
