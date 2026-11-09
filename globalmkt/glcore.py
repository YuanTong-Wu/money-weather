#!/usr/bin/env python3
"""glcore.py — shared bits of the 全球 layer (DESIGN §23): paths, the universe, markets, close-time schedule.

Used by fetch_global.py, compute_global.py and candidates_global.py (stockfile.py stays numpy-only on purpose).

    python3 globalmkt/glcore.py            # print every market's last/next close and whether it is due a fetch
    python3 globalmkt/glcore.py --due      # print only the due markets, comma-separated ('' = nothing to do)
    python3 globalmkt/glcore.py --next     # seconds until the next market becomes due (0 = due now)

A market is *due* when its most recent local close (+ BUFFER_MIN for Yahoo to publish the final bar) is later
than the last time fetch_global.py downloaded that market (cache/fetch_stats.json → markets.<mk>.fetchedAt).
Weekends are never sessions; exchange holidays are not known in advance — a fetch on a holiday simply brings
nothing new and marks the market fetched, so it is not due again until its next close.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UNIVERSE = HERE / "universe.json"
CACHE = HERE / "cache"
PRICES = CACHE / "prices_gl.parquet"          # long OHLCV in LOCAL currency: date, t, o, h, l, c, v
FXFILE = CACHE / "fx_gl.parquet"              # long: date, ccy, usdPer (USD per 1 unit of ccy)
FETCH_STATS = CACHE / "fetch_stats.json"
OUTDIR = HERE / "out"
NPZ = OUTDIR / "series_gl.npz"
COMPUTE_STATS = OUTDIR / "compute_stats.json"
WEB = ROOT / "web" / "data" / "gl"
CURATED = ROOT / "web" / "data"
BUFFER_MIN = 30          # minutes after the local close before a day's bar counts as final on Yahoo
RETRY_EVERY_MIN, RETRY_N = 60, 3   # a session still missing after its close: re-fetch hourly, ≤ 3 times
ROOT_ID = "world"        # the frontend's root id (universe.json calls it gl-world), like the 全市场 map

# Yahoo quote currency → the currency whose USD pair we download (pence/cents are /100 of their parent)
SUB_UNITS = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01), "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}


def log(*a) -> None:
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def load_universe() -> dict:
    return json.loads(UNIVERSE.read_text(encoding="utf-8"))


def walk_stocks(root: dict):
    """yield every stock dict of the tree (each ticker appears once in the global universe)."""
    def walk(n):
        for s in n.get("stocks", []):
            yield s
        for c in n.get("children", []):
            yield from walk(c)
    yield from walk(root)


def stock_table(root: dict) -> dict[str, dict]:
    """ticker → {mkt, ccy, ...stock fields}; first occurrence wins."""
    out: dict[str, dict] = {}
    for s in walk_stocks(root):
        out.setdefault(s["t"], s)
    return out


def markets(root: dict) -> dict[str, dict]:
    return root.get("markets") or {}


def base_ccy(ccy: str) -> tuple[str, float]:
    """quote currency → (pair currency, multiplier): GBp → (GBP, 0.01)."""
    if ccy in SUB_UNITS:
        return SUB_UNITS[ccy]
    return ccy, 1.0


def fx_symbol(ccy: str) -> str:
    """Yahoo FX symbol quoting `ccy` per 1 USD (e.g. JPY=X ≈ 150)."""
    return f"{ccy}=X"


def close_time(m: dict) -> dtime:
    hh, mm = (m.get("close") or "16:00").split(":")[:2]
    return dtime(int(hh), int(mm))


def last_close(m: dict, now: datetime | None = None, buffer_min: int = BUFFER_MIN) -> datetime:
    """Most recent weekday close (+buffer) at or before `now`, as an aware datetime in the market's tz."""
    tz = ZoneInfo(m.get("tz") or "UTC")
    now = (now or datetime.now(tz)).astimezone(tz)
    ct = close_time(m)
    d = now.date()
    for _ in range(8):
        if d.weekday() < 5:
            c = datetime.combine(d, ct, tz) + timedelta(minutes=buffer_min)
            if c <= now:
                return c
        d -= timedelta(days=1)
    return datetime.combine(d, ct, tz)


def next_close(m: dict, now: datetime | None = None, buffer_min: int = BUFFER_MIN) -> datetime:
    tz = ZoneInfo(m.get("tz") or "UTC")
    now = (now or datetime.now(tz)).astimezone(tz)
    ct = close_time(m)
    d = now.date()
    for _ in range(8):
        if d.weekday() < 5:
            c = datetime.combine(d, ct, tz) + timedelta(minutes=buffer_min)
            if c > now:
                return c
        d += timedelta(days=1)
    return datetime.combine(d, ct, tz)


def bar_is_final(m: dict, bar_date, fetched: datetime, buffer_min: int = BUFFER_MIN) -> bool:
    """Was a bar dated `bar_date` (market-local date) complete when it was downloaded at `fetched`?"""
    tz = ZoneInfo(m.get("tz") or "UTC")
    f = fetched.astimezone(tz)
    if bar_date < f.date():
        return True
    if bar_date > f.date():
        return False
    return f.time() >= (datetime.combine(f.date(), close_time(m)) + timedelta(minutes=buffer_min)).time()


def read_fetch_stats() -> dict:
    try:
        return json.loads(FETCH_STATS.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def due_markets(root: dict | None = None, now: datetime | None = None, stats: dict | None = None) -> list[str]:
    root = root or load_universe()
    stats = stats if stats is not None else read_fetch_stats()
    per = stats.get("markets") or {}
    now = now or datetime.now().astimezone()
    out = []
    for mk, m in markets(root).items():
        lc = last_close(m, now)
        f = (per.get(mk) or {}).get("fetchedAt")
        try:
            fd = datetime.fromisoformat(f) if f else None
            if fd is not None and fd.tzinfo is None:
                fd = fd.astimezone()
        except ValueError:
            fd = None
        if fd is None or fd < lc:
            out.append(mk)
            continue
        # Yahoo sometimes publishes a session's final bar late (e.g. Tokyo's close with NaN prices for a while):
        # when the expected session is still missing, retry hourly for a few hours after the close (a holiday
        # costs at most RETRY_N extra small fetches, then it waits for the next close)
        pm = per.get(mk) or {}
        ls = pm.get("lastSession")
        exp = (lc - timedelta(minutes=BUFFER_MIN)).date().isoformat()
        if ls and ls < exp and now - fd >= timedelta(minutes=RETRY_EVERY_MIN) and int(pm.get("tries", 0)) < RETRY_N:
            out.append(mk)
    return out


def main(argv: list[str]) -> int:
    root = load_universe()
    if "--due" in argv:
        print(",".join(due_markets(root)))
        return 0
    if "--next" in argv:      # seconds until the next market becomes due (0 = something is due now)
        if due_markets(root):
            print(0)
            return 0
        now = datetime.now().astimezone()
        nxt = min(next_close(m, now) for m in markets(root).values())
        print(max(1, int((nxt - now).total_seconds()) + 5))
        return 0
    stats = read_fetch_stats()
    per = stats.get("markets") or {}
    due = set(due_markets(root, stats=stats))
    local = ZoneInfo("Australia/Sydney")
    print(f"{'mkt':<4}{'name':<8}{'tz':<20}{'close':<7}{'last close (AEDT)':<20}{'next close (AEDT)':<20}"
          f"{'fetchedAt':<27}due")
    for mk, m in markets(root).items():
        lc = last_close(m).astimezone(local).strftime("%m-%d %H:%M")
        nc = next_close(m).astimezone(local).strftime("%m-%d %H:%M")
        print(f"{mk:<4}{m.get('name', ''):<8}{m.get('tz', ''):<20}{m.get('close', ''):<7}{lc:<20}{nc:<20}"
              f"{str((per.get(mk) or {}).get('fetchedAt', '-')):<27}{'yes' if mk in due else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
