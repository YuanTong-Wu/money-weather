"""NYSE trading calendar for the loop (DESIGN.md §16) — America/New_York, 2026–2027 hardcoded.

Regular session 09:30–16:00 ET; early closes at 13:00 ET. Weekends closed. Dates outside the covered
years fall back to "weekdays are trading days" and log one warning, so the loop never stops working
just because nobody updated this list — but please add the next year's holidays before 2028.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
OPEN = time(9, 30)
CLOSE = time(16, 0)
EARLY_CLOSE = time(13, 0)

# NYSE full-day closures (official observed dates).
HOLIDAYS: dict[date, str] = {
    # 2026
    date(2026, 1, 1): "元旦",
    date(2026, 1, 19): "马丁·路德·金纪念日",
    date(2026, 2, 16): "总统日",
    date(2026, 4, 3): "耶稣受难日",
    date(2026, 5, 25): "阵亡将士纪念日",
    date(2026, 6, 19): "六月节",
    date(2026, 7, 3): "独立日（补休）",       # 7/4 is a Saturday
    date(2026, 9, 7): "劳动节",
    date(2026, 11, 26): "感恩节",
    date(2026, 12, 25): "圣诞节",
    # 2027
    date(2027, 1, 1): "元旦",
    date(2027, 1, 18): "马丁·路德·金纪念日",
    date(2027, 2, 15): "总统日",
    date(2027, 3, 26): "耶稣受难日",
    date(2027, 5, 31): "阵亡将士纪念日",
    date(2027, 6, 18): "六月节（补休）",      # 6/19 is a Saturday
    date(2027, 7, 5): "独立日（补休）",       # 7/4 is a Sunday
    date(2027, 9, 6): "劳动节",
    date(2027, 11, 25): "感恩节",
    date(2027, 12, 24): "圣诞节（补休）",     # 12/25 is a Saturday
    # 2028-01-01 is a Saturday: NYSE does not close on Fri 2027-12-31.
}

# 13:00 ET early closes.
EARLY_CLOSES: dict[date, str] = {
    date(2026, 11, 27): "感恩节次日",
    date(2026, 12, 24): "平安夜",
    date(2027, 11, 26): "感恩节次日",
}

COVERED_YEARS = {2026, 2027}
_log = logging.getLogger("loop")
_warned: set[int] = set()


def _check_year(d: date) -> None:
    if d.year not in COVERED_YEARS and d.year not in _warned:
        _warned.add(d.year)
        _log.warning("calendar: %s 年的美股假期没写进 loop/calendar_ny.py，暂时只按周末判断", d.year)


def is_trading_day(d: date) -> bool:
    _check_year(d)
    return d.weekday() < 5 and d not in HOLIDAYS


def session(d: date) -> tuple[datetime, datetime] | None:
    """(open, close) as aware New York datetimes, or None when the market is shut that day."""
    if not is_trading_day(d):
        return None
    close = EARLY_CLOSE if d in EARLY_CLOSES else CLOSE
    return datetime.combine(d, OPEN, NY), datetime.combine(d, close, NY)


def ny_now(now: datetime | None = None) -> datetime:
    return (now or datetime.now(NY)).astimezone(NY)


def is_open(now: datetime | None = None) -> bool:
    t = ny_now(now)
    s = session(t.date())
    return bool(s and s[0] <= t < s[1])


def next_trading_day(d: date, include: bool = False) -> date:
    x = d if include else d + timedelta(days=1)
    for _ in range(30):
        if is_trading_day(x):
            return x
        x += timedelta(days=1)
    raise RuntimeError("no trading day within 30 days")  # unreachable with a sane calendar


def prev_trading_day(d: date, include: bool = False) -> date:
    x = d if include else d - timedelta(days=1)
    for _ in range(30):
        if is_trading_day(x):
            return x
        x -= timedelta(days=1)
    raise RuntimeError("no trading day within 30 days")


def last_completed_session(now: datetime | None = None, grace: timedelta = timedelta(0)) -> date:
    """Most recent trading day whose close + grace is at or before `now`."""
    t = ny_now(now)
    d = t.date()
    for _ in range(30):
        s = session(d)
        if s and s[1] + grace <= t:
            return d
        d -= timedelta(days=1)
    raise RuntimeError("no completed session within 30 days")


def trading_days_between(a: date, b: date) -> int:
    """Number of trading days in (a, b] — how far `a` lags behind `b`."""
    if b <= a:
        return 0
    n, x = 0, a + timedelta(days=1)
    while x <= b:
        n += is_trading_day(x)
        x += timedelta(days=1)
    return n


def next_open(now: datetime | None = None) -> datetime:
    t = ny_now(now)
    s = session(t.date())
    if s and t < s[0]:
        return s[0]
    d = next_trading_day(t.date())
    return session(d)[0]  # type: ignore[index]


def status(now: datetime | None = None) -> dict:
    """Plain description for the heartbeat: {open, phase, reason, opensAt, closesAt}."""
    t = ny_now(now)
    d = t.date()
    s = session(d)
    out: dict = {"open": False, "phase": "closed", "reason": None, "opensAt": None, "closesAt": None,
                 "earlyClose": d in EARLY_CLOSES}
    if s is None:
        out["reason"] = HOLIDAYS.get(d) or ("周末" if d.weekday() >= 5 else "休市")
    elif t < s[0]:
        out["phase"] = "pre"
        out["reason"] = "还没开盘"
    elif t < s[1]:
        out.update(open=True, phase="open", reason="交易中")
    else:
        out["phase"] = "post"
        out["reason"] = "已收盘"
    if s and t < s[1]:
        out["closesAt"] = s[1].isoformat()
    out["opensAt"] = next_open(t).isoformat() if not out["open"] else s[0].isoformat()  # type: ignore[index]
    return out


def easter(year: int) -> date:
    """Anonymous Gregorian computus — used only by the self-test to double-check Good Friday."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)
