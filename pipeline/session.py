#!/usr/bin/env python3
"""session.py — the US regular-session clock and a standard U-shaped intraday volume curve.

Used by compute.py (and free for anyone else: fullmarket, brief, the loop) to answer one question:
"if a daily bar was taken at HH:MM New York time, what share of the day's volume has normally traded?"
A 15-minute refresh at 10:37 sees only ~23 % of a normal day's volume; comparing that half-formed bar
with full days would make every territory look like money is leaving. compute.py scales the still-forming
bar to a full-day estimate with this curve (and says so in meta.intraday).

    python3 pipeline/session.py                 # fraction right now
    python3 pipeline/session.py 2026-10-27T10:37 # fraction at a New York time
    python3 pipeline/session.py --table         # the curve, every 15 minutes
    python3 pipeline/session.py --is-open       # exit 0 while the regular session is open, else 1

    python3 pipeline/session.py --calibrate     # re-measure the curve on Yahoo's last 4 full days (2 requests)

The curve is in Yahoo's own accounting — what matters is the daily bar's volume *during* the session (which
equals the 5-minute bars summed so far) as a share of that day's *final* daily volume. Measured 2026-10-28 on 35
liquid names × 4 days (median): 09:45 ≈ 10 %, 10:00 14 %, 10:30 21 %, 11:00 28 %, 12:00 38 %, 13:00 47 %,
14:00 55 %, 15:00 64 %, 15:30 70 %, 15:55 77 % — the usual smile, plus a big lump at the bell: the 5-minute
bars only ever reach ~80 % of the final daily volume, the rest (closing cross + prints that land after
16:00) arrives at the close. Early-close days (13:00) use the same shape squeezed into the shorter session.
Holidays need no entry: they simply have no bar.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
OPEN_MIN = 9 * 60 + 30
CLOSE_MIN = 16 * 60
SESSION_MIN = CLOSE_MIN - OPEN_MIN          # 390
CLOSE_AUCTION = 0.204                       # share of Yahoo's final daily volume that lands at/after the bell

# NYSE/Nasdaq early closes (13:00 ET). Day after Thanksgiving + Christmas Eve when it is a trading day.
EARLY_CLOSE = {
    "2025-11-28": 13 * 60, "2025-12-24": 13 * 60,
    "2026-11-27": 13 * 60, "2026-12-24": 13 * 60,
    "2027-11-26": 13 * 60,
}

# (minutes after the open, share of the final daily volume traded in that bucket) — continuous trading only;
# the bell lump is added at 16:00. Weights sum to 1 − CLOSE_AUCTION (calibrated 2026-10-28, see above).
_BUCKETS = [
    (5, 0.045), (10, 0.028), (15, 0.024), (20, 0.015), (25, 0.014), (30, 0.014),    # 09:30–10:00  14.0 %
    (60, 0.072), (90, 0.067), (120, 0.056), (150, 0.048),                            # 10:00–12:00  24.3 %
    (180, 0.046), (210, 0.044), (240, 0.039), (270, 0.040),                          # 12:00–14:00  16.9 %
    (300, 0.043), (330, 0.048), (360, 0.057), (385, 0.071), (390, 0.025),            # 14:00–16:00  24.4 %
]
_tot = sum(w for _, w in _BUCKETS)
_scale = (1.0 - CLOSE_AUCTION) / _tot
CURVE: list[tuple[int, float]] = []         # (minute after open, cumulative share before the auction)
_c = 0.0
for _m, _w in _BUCKETS:
    _c += _w * _scale
    CURVE.append((_m, _c))


def close_minute(d: date | str) -> int:
    return EARLY_CLOSE.get(str(d), CLOSE_MIN)


def _cum(minutes_after_open: float) -> float:
    """cumulative share of continuous-trading volume after this many minutes of a 390-minute session."""
    if minutes_after_open <= 0:
        return 0.0
    prev_m, prev_c = 0, 0.0
    for m, c in CURVE:
        if minutes_after_open <= m:
            return prev_c + (c - prev_c) * (minutes_after_open - prev_m) / (m - prev_m)
        prev_m, prev_c = m, c
    return CURVE[-1][1]


def to_ny(t: datetime | str | None) -> datetime:
    if t is None:
        return datetime.now(NY)
    if isinstance(t, str):
        t = datetime.fromisoformat(t)
    return t.astimezone(NY) if t.tzinfo else t.replace(tzinfo=NY)


def session_fraction(t: datetime | str | None = None, d: date | str | None = None) -> float:
    """Expected share (0…1) of a normal day's volume traded by New York time `t` on session day `d`
    (default: t's own date). Before the open 0, from the closing bell on 1."""
    t = to_ny(t)
    d = str(d or t.date())
    if str(t.date()) > d:
        return 1.0
    if str(t.date()) < d:
        return 0.0
    close = close_minute(d)
    mins = t.hour * 60 + t.minute + t.second / 60.0
    if mins < OPEN_MIN:
        return 0.0
    if mins >= close:
        return 1.0
    # squeeze the 390-minute shape into a shorter session on early-close days
    eq = (mins - OPEN_MIN) * SESSION_MIN / (close - OPEN_MIN)
    return float(min(1.0 - CLOSE_AUCTION, _cum(eq)))


def is_open(t: datetime | str | None = None) -> bool:
    t = to_ny(t)
    if t.weekday() >= 5:
        return False
    mins = t.hour * 60 + t.minute
    return OPEN_MIN <= mins < close_minute(t.date())


def info(t: datetime | str | None = None, d: date | str | None = None, local_tz: str = "Australia/Sydney") -> dict:
    """{date, asOf (ISO, New York), etTime "HH:MM", localTime "HH:MM" (owner's clock), fraction, open}."""
    t = to_ny(t)
    f = session_fraction(t, d)
    try:
        lt = t.astimezone(ZoneInfo(local_tz)).strftime("%H:%M")
    except Exception:  # noqa: BLE001
        lt = None
    return {"date": str(d or t.date()), "asOf": t.isoformat(timespec="seconds"), "etTime": t.strftime("%H:%M"),
            "localTime": lt, "localTz": local_tz, "fraction": round(f, 3), "open": is_open(t)}


# ---------------------------------------------------------------------------------- full-day estimate
SHRINK_K = 0.05   # how strongly a very young session is pulled toward a typical day (see full_day_volume)


def full_day_weight(f: float) -> float:
    """Weight of the pure pace projection V/f. 0 before the open, ≈0.5 at f=5 % (09:37), ≈0.84 at 10:35,
    0.95 at midday, 1 at the bell. The rest goes to "so far + a typical rest of the day"."""
    f = max(0.0, min(1.0, f))
    return f * (1 + SHRINK_K) / (f + SHRINK_K) if f > 0 else 0.0


def full_day_volume(v_so_far, f: float, v_typical=None):
    """Full-day volume estimate for a bar that has `v_so_far` after a share `f` of the session.
    pace = v/f  (what the U-curve says the day will end at)
    rest = v + (1 − f)·v_typical  (what is in + a normal rest of the day)
    estimate = w·pace + (1 − w)·rest, w = full_day_weight(f). Never below v_so_far. Works on numbers or
    numpy arrays (v_typical NaN/None → pace alone, with f floored at 5 %)."""
    import numpy as np

    v = np.asarray(v_so_far, dtype=np.float64)
    f = float(max(0.0, min(1.0, f)))
    if f >= 1.0:
        return v.copy() if v.ndim else float(v)
    w = full_day_weight(f)
    if v_typical is None:
        vt = np.full_like(v, np.nan)
    else:
        vt = np.asarray(v_typical, dtype=np.float64) * np.ones_like(v)
        vt = np.where(vt > 0, vt, np.nan)
    rest = v + (1.0 - f) * vt                      # NaN where no typical volume is known
    pace_only = v / max(f, 0.05)                   # no history: the curve alone (≤ 20× what is in)
    blended = (w * (v / f) if f > 0 else 0.0) + (1.0 - w) * rest
    est = np.where(np.isfinite(rest), blended, pace_only)
    est = np.where(np.isfinite(est), np.maximum(est, v), v)
    return est if est.ndim else float(est)


def calibrate(tickers: list[str] | None = None) -> None:
    """Print Yahoo's measured cumulative share by time (5-minute bars summed ÷ that day's final daily volume,
    median over liquid names) for the last full days next to this curve. Two Yahoo requests."""
    import logging

    import numpy as np
    import pandas as pd
    import yfinance as yf

    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    T = tickers or ("SPY QQQ NVDA MSFT AAPL AMZN GOOGL META TSLA AMD MU AVGO JPM XOM UNH LLY WMT COST BAC KO "
                    "PFE INTC ORCL CRM NFLX PLTR SOFI DNA TLT HYG GLD IWM XLE XLF SMH").split()
    v5 = yf.download(T, period="5d", interval="5m", auto_adjust=True, progress=False, group_by="column")["Volume"]
    vd = yf.download(T, period="10d", interval="1d", auto_adjust=True, progress=False, group_by="column")["Volume"]
    v5.index = v5.index.tz_convert(NY)
    vd.index = pd.DatetimeIndex(vd.index).tz_localize(None).normalize()
    marks = ["09:45", "10:00", "10:30", "11:00", "11:30", "12:00", "13:00", "14:00", "15:00", "15:30", "15:55"]
    today = datetime.now(NY).date()
    rows = {}
    for d in sorted(set(v5.index.date)):
        if d == today and is_open():
            continue
        day = v5[v5.index.date == d]
        if pd.Timestamp(d) not in vd.index:
            continue
        tot = vd.loc[pd.Timestamp(d)].replace(0, np.nan)
        mins = day.index.hour * 60 + day.index.minute
        rows[str(d)] = [float(np.nanmedian(day[mins < int(m[:2]) * 60 + int(m[3:])].sum() / tot)) for m in marks]
    rows["curve"] = [session_fraction(datetime.combine(date(2026, 10, 27), time(int(m[:2]), int(m[3:])), NY))
                     for m in marks]
    print(pd.DataFrame(rows, index=marks).T.round(3).to_string())


def _main(argv: list[str]) -> int:
    if "--calibrate" in argv:
        calibrate()
        return 0
    if "--is-open" in argv:
        return 0 if is_open() else 1
    if "--table" in argv:
        for m in list(range(0, SESSION_MIN, 15)) + [SESSION_MIN - 1, SESSION_MIN]:
            h, mm = divmod(OPEN_MIN + m, 60)
            t = datetime.combine(date(2026, 10, 27), time(h, mm), NY)
            print(f"{h:02d}:{mm:02d}  {session_fraction(t):6.1%}" + ("  (closing auction in)" if m == SESSION_MIN else ""))
        return 0
    t = argv[0] if argv and not argv[0].startswith("-") else None
    import json
    print(json.dumps(info(t), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
