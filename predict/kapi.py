"""predict/kapi.py: Kalshi public market data (read-only, no login, no keys, no trading).

Base https://api.elections.kalshi.com/trade-api/v2 (serves every Kalshi market, not only elections).
  discovery  GET /events?status=open&with_nested_markets=true (paged, 200/page; ~75 pages ≈ 2–3 min)
             → only money-relevant categories are kept on disk (cache/events.json, slimmed)
  quick      GET /markets?tickers=a,b,… (100 per request) → fresh prices for the markets we already keep
  history    GET /markets/candlesticks?market_tickers=…&period_interval=1440 (≤ 100 markets per request)
Polite: one request at a time, ≥ 0.15 s apart, backoff on 429/5xx, stop on 403. Every request is logged
to cache/requests.log.
"""
from __future__ import annotations

import json
import os
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
EVENTS_FILE = CACHE / "kalshi_events.json"
HIST_FILE = CACHE / "kalshi_hist.json"
LOG = CACHE / "requests.log"
BASE = "https://api.elections.kalshi.com/trade-api/v2"
UA = "money-weather/0.1 (personal research, read-only, local use)"
GAP_S = 0.15

# Kalshi categories that can move money (sports, entertainment, weather, mentions, social are dropped here)
KEEP_CATS = {"Economics", "Financials", "Politics", "Elections", "Science and Technology", "Crypto", "Companies",
             "Commodities", "Health", "AI", "World", "Business", "Transportation"}
MKT_FIELDS = ("ticker", "event_ticker", "title", "yes_sub_title", "subtitle", "status", "close_time",
              "last_price_dollars", "yes_bid_dollars", "yes_ask_dollars", "previous_price_dollars",
              "previous_yes_bid_dollars", "previous_yes_ask_dollars", "volume_fp", "volume_24h_fp",
              "open_interest_fp", "strike_type", "floor_strike", "cap_strike", "market_type")
EV_FIELDS = ("event_ticker", "series_ticker", "title", "sub_title", "category", "mutually_exclusive")


class Refused(RuntimeError):
    pass


_lock = threading.Lock()
_last = [0.0]


def _log(code, url, extra=""):
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(f"{datetime.now().strftime('%Y-%m-%dT%H:%M:%S')}\t{code}\t{url[:240]}\t{extra}\n")
    except Exception:
        pass


def get(path: str, params: dict | None = None, *, retries: int = 4, timeout: int = 60) -> dict:
    url = BASE + path + ("?" + urllib.parse.urlencode(params, safe=",") if params else "")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    delay = 1.5
    last = None
    for attempt in range(retries + 1):
        with _lock:
            wait = GAP_S - (time.time() - _last[0])
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            _log(200, url)
            return json.loads(body)
        except urllib.error.HTTPError as e:
            last = e
            _log(e.code, url)
            if e.code == 403:
                raise Refused(f"403 from {url[:120]}")
            if e.code in (400, 404):
                raise
            if e.code == 429 and attempt == retries:
                raise Refused(f"429 (rate limited) from {url[:120]}")
        except Exception as e:
            last = e
            _log(-1, url, repr(e)[:120])
        if attempt < retries:
            time.sleep(delay + random.random() * 0.5)
            delay *= 2
    raise RuntimeError(f"GET failed after {retries + 1} tries: {url[:120]}: {last!r}")


def _slim_market(m: dict) -> dict:
    return {k: m.get(k) for k in MKT_FIELDS if m.get(k) not in (None, "")}


def _write(fp: Path, obj):
    fp.parent.mkdir(parents=True, exist_ok=True)
    tmp = fp.with_suffix(fp.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    os.replace(tmp, fp)


def read_events() -> dict:
    try:
        return json.loads(EVENTS_FILE.read_text())
    except Exception:
        return {}


def discover(log=print) -> dict:
    """Full pull of open events (+ nested markets); keeps the relevant categories, active markets only."""
    t0 = time.time()
    events, cursor, pages, seen = [], None, 0, 0
    while True:
        p = {"status": "open", "limit": 200, "with_nested_markets": "true"}
        if cursor:
            p["cursor"] = cursor
        d = get("/events", p, timeout=90)
        pages += 1
        batch = d.get("events") or []
        seen += len(batch)
        for e in batch:
            if e.get("category") not in KEEP_CATS:
                continue
            ms = [_slim_market(m) for m in e.get("markets") or [] if m.get("status") == "active"]
            if not ms:
                continue
            ev = {k: e.get(k) for k in EV_FIELDS}
            ev["markets"] = ms
            events.append(ev)
        cursor = d.get("cursor")
        if not cursor or not batch:
            break
        if pages % 15 == 0:
            log(f"  kalshi discovery: {pages} pages, {seen} events seen, {len(events)} kept …")
    out = {"at": time.time(), "atIso": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), "pages": pages, "seen": seen,
           "events": events}
    _write(EVENTS_FILE, out)
    log(f"kalshi discovery: {seen} open events on {pages} pages → kept {len(events)} "
        f"({sum(len(e['markets']) for e in events)} active markets) in {time.time() - t0:.0f}s")
    return out


def refresh_markets(cache: dict, tickers: list[str], log=print) -> dict:
    """Fresh prices for the given market tickers (the ones the last build kept); updates the cache in place."""
    if not tickers:
        return cache
    t0 = time.time()
    fresh = {}
    for i in range(0, len(tickers), 100):
        part = tickers[i:i + 100]
        d = get("/markets", {"tickers": ",".join(part), "limit": 1000})
        for m in d.get("markets") or []:
            fresh[m["ticker"]] = m
    n = 0
    for e in cache.get("events") or []:
        keep = []
        for m in e["markets"]:
            f = fresh.get(m["ticker"])
            if f is not None:
                if f.get("status") != "active":
                    continue          # closed / settled since discovery
                m = _slim_market(f)
                n += 1
            keep.append(m)
        e["markets"] = keep
    cache["events"] = [e for e in cache.get("events") or [] if e["markets"]]
    cache["pricesAt"] = time.time()
    _write(EVENTS_FILE, cache)
    log(f"kalshi quick refresh: {n}/{len(tickers)} markets in {time.time() - t0:.0f}s")
    return cache


class History:
    """Daily candles for the last ~32 days, cached per market for `ttl_s`."""

    def __init__(self, enabled=True, ttl_s=3 * 3600, log=print):
        self.enabled, self.ttl_s, self.log = enabled, ttl_s, log
        try:
            self.store = json.loads(HIST_FILE.read_text())
        except Exception:
            self.store = {}
        self.fetched = self.hits = self.failed = 0
        self.refused = False

    def need(self, tickers: list[str]) -> list[str]:
        now = time.time()
        return [t for t in tickers if not (t in self.store and now - self.store[t].get("at", 0) < self.ttl_s)]

    def load(self, tickers: list[str]):
        todo = self.need(tickers) if self.enabled else []
        self.hits = len(tickers) - len(todo)
        now = int(time.time())
        for i in range(0, len(todo), 100):
            if self.refused:
                break
            part = todo[i:i + 100]
            try:
                d = get("/markets/candlesticks", {"market_tickers": ",".join(part), "start_ts": now - 32 * 86400,
                                                  "end_ts": now, "period_interval": 1440}, retries=2, timeout=60)
            except Refused as e:
                self.refused = True
                self.log(f"  kalshi candles refused ({e}); using cached / previous-day prices")
                break
            except Exception as e:
                self.failed += len(part)
                self.log(f"  kalshi candles failed for {len(part)} markets: {str(e)[:120]}")
                continue
            got = set()
            for m in d.get("markets") or []:
                t = m.get("market_ticker")
                h = []
                for c in m.get("candlesticks") or []:
                    p = _candle_price(c)
                    if p is not None:
                        h.append([int(c["end_period_ts"]), round(p, 4)])
                self.store[t] = {"at": now, "h": h}
                got.add(t)
            self.fetched += len(got)
        # forget markets we no longer track (older than 3 days)
        cut = time.time() - 3 * 86400
        keep = set(tickers)
        self.store = {k: v for k, v in self.store.items() if k in keep or v.get("at", 0) > cut}
        _write(HIST_FILE, self.store)

    def get(self, ticker: str) -> list:
        return (self.store.get(ticker) or {}).get("h") or []


def fnum(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def _candle_price(c: dict):
    """Close of the day: last trade if there was one, else the bid/ask midpoint at the close."""
    p = fnum(((c.get("price") or {}).get("close_dollars")))
    b = fnum((c.get("yes_bid") or {}).get("close_dollars"))
    a = fnum((c.get("yes_ask") or {}).get("close_dollars"))
    if b is not None and a is not None and a > 0 and a >= b and a - b <= 0.12:
        mid = (a + b) / 2
        if p is None or abs(p - mid) > 0.1:
            return mid
    return p if p is not None else ((a + b) / 2 if a is not None and b is not None and a > 0 else None)


def prob_now(m: dict) -> float | None:
    """Midpoint when the book is tight, else the last trade, else the midpoint."""
    b, a, last = fnum(m.get("yes_bid_dollars")), fnum(m.get("yes_ask_dollars")), fnum(m.get("last_price_dollars"))
    vol = fnum(m.get("volume_fp")) or 0
    if b is not None and a is not None and a > 0 and a >= b:
        mid = (a + b) / 2
        if a - b <= 0.10:
            return mid
        if last is not None and vol > 0 and b <= last <= a:
            return last
        return mid
    if last is not None and vol > 0:
        return last
    return None
