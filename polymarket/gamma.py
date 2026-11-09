"""polymarket/gamma.py: pull every open Polymarket event (with its markets) from gamma-api.

Uses the keyset endpoint (/events/keyset, 100 per page, after_cursor). The server-side volume_min
equals our lowest per-market volume floor, so it drops nothing we could keep (a market's volume is
never above its event's). The volume range is split into a few bands pulled in parallel (polite:
4 connections at most, one page at a time each).
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

try:
    from .common import GAMMA, CACHE_DIR, Refused, get_json, read_json, write_json, jload, fnum
except ImportError:
    from common import GAMMA, CACHE_DIR, Refused, get_json, read_json, write_json, jload, fnum

RAW_FILE = CACHE_DIR / "events_raw.json"

# event-volume bands (USD); each band is paged on its own connection
BANDS = [(5_000, 12_000), (12_000, 30_000), (30_000, 100_000), (100_000, None)]

MKT_KEYS = ["id", "slug", "question", "groupItemTitle", "outcomes", "outcomePrices", "clobTokenIds",
            "volumeNum", "endDate", "active", "closed", "acceptingOrders", "lastTradePrice", "bestBid",
            "bestAsk", "oneDayPriceChange", "oneWeekPriceChange", "oneMonthPriceChange", "liquidityNum",
            "startDate", "createdAt", "negRisk", "groupItemThreshold"]


def _trim_event(e: dict) -> dict:
    ms = []
    for m in e.get("markets") or []:
        mm = {k: m.get(k) for k in MKT_KEYS if k in m}
        mm["outcomes"] = jload(m.get("outcomes"), [])
        mm["outcomePrices"] = [fnum(x, None) for x in jload(m.get("outcomePrices"), [])]
        mm["clobTokenIds"] = jload(m.get("clobTokenIds"), [])
        ms.append(mm)
    return {
        "id": str(e.get("id")), "slug": e.get("slug"), "title": e.get("title") or "",
        "tags": [t.get("slug") for t in (e.get("tags") or []) if isinstance(t, dict) and t.get("slug")],
        "tagLabels": [t.get("label") for t in (e.get("tags") or []) if isinstance(t, dict) and t.get("label")],
        "volume": fnum(e.get("volume"), 0.0), "volume1wk": fnum(e.get("volume1wk"), 0.0),
        "endDate": e.get("endDate"), "negRisk": bool(e.get("negRisk") or e.get("enableNegRisk")),
        "liquidity": fnum(e.get("liquidity"), 0.0), "createdAt": e.get("createdAt"),
        "markets": ms,
    }


def _pull_band(lo, hi, log=print) -> list[dict]:
    out, cur, pages = [], None, 0
    while True:
        p = {"closed": "false", "limit": 100, "volume_min": lo}
        if hi is not None:
            p["volume_max"] = hi
        if cur:
            p["after_cursor"] = cur
        d = get_json(GAMMA + "/events/keyset", p, timeout=90)
        ev = (d or {}).get("events") or []
        out += [_trim_event(e) for e in ev]
        pages += 1
        cur = (d or {}).get("next_cursor")
        if not ev or not cur:
            break
        if pages > 400:  # safety valve
            log(f"  band {lo}-{hi}: stopped at {pages} pages")
            break
        time.sleep(0.15)
    return out


def pull_events(min_volume: float = 5_000, log=print, use_cache_min: float = 0) -> list[dict]:
    """All open events with volume ≥ min_volume, markets included (trimmed).
    use_cache_min > 0: reuse cache/events_raw.json if it is younger than that many minutes."""
    if use_cache_min > 0 and RAW_FILE.exists() and (time.time() - RAW_FILE.stat().st_mtime) < use_cache_min * 60:
        d = read_json(RAW_FILE, None)
        if d and d.get("events"):
            log(f"gamma: reuse cached events ({len(d['events'])}, {int((time.time() - RAW_FILE.stat().st_mtime) / 60)} min old)")
            return d["events"]
    t0 = time.time()
    bands = [(max(lo, min_volume), hi) for lo, hi in BANDS if hi is None or hi > min_volume]
    seen: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(bands)) as ex:
        futs = {ex.submit(_pull_band, lo, hi, log): (lo, hi) for lo, hi in bands}
        for f, (lo, hi) in futs.items():
            try:
                evs = f.result()
            except Refused:
                raise
            except Exception as e:
                log(f"  band {lo}-{hi} failed: {e!r}")
                continue
            for e in evs:
                seen[e["id"]] = e
            log(f"  band {lo:>7}-{hi or 'max'}: {len(evs)} events")
    events = list(seen.values())
    log(f"gamma: {len(events)} open events with volume ≥ ${min_volume:,.0f} in {time.time() - t0:.0f}s")
    write_json(RAW_FILE, {"fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "events": events})
    return events
