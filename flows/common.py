"""Shared helpers for the real-money flows layer (DESIGN §23/§24).

Everything here is stdlib + pandas/numpy. No API keys. Polite HTTP (one client, retries with backoff,
small sleeps between calls). Output JSON never contains NaN/Infinity.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent          # money-weather/
FLOWS = ROOT / "flows"
STORE = FLOWS / "store"
OUT = ROOT / "web" / "data" / "flows"
LOGDIR = FLOWS / "out"
for _d in (STORE, OUT, LOGDIR):
    _d.mkdir(parents=True, exist_ok=True)

ET = ZoneInfo("America/New_York")
AEDT = ZoneInfo("Australia/Sydney")
UTC = dt.timezone.utc

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def log(*a):
    ts = dt.datetime.now(AEDT).strftime("%m-%d %H:%M:%S")
    print(f"[{ts}]", *a, flush=True)


def now_iso() -> str:
    return dt.datetime.now(AEDT).replace(microsecond=0).isoformat()


def today_local() -> str:
    return dt.datetime.now(AEDT).strftime("%Y-%m-%d")


def last_us_session() -> str:
    """Date of the last *completed* US cash session (ET). Weekends/holidays roll back.
    Holidays are approximated by weekends only; the issuer as-of dates are preferred where present."""
    now = dt.datetime.now(ET)
    d = now.date()
    if now.hour < 17:            # today's session not finished (NAVs strike ~16:00, publish later)
        d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


# ----------------------------------------------------------------------------------------- HTTP
def http_get(url: str, *, headers: dict | None = None, timeout: int = 60, retries: int = 3,
             backoff: float = 3.0, use_curl_fallback: bool = False) -> bytes:
    """GET with retries. use_curl_fallback: some CN servers drop Python keep-alive connections;
    retry once with the system curl (an ordinary HTTP client, no challenge solving)."""
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8"}
    if headers:
        h.update(headers)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403, 404, 410):
                break                     # do not hammer a server that said no
        except Exception as e:            # noqa: BLE001
            last = e
        time.sleep(backoff * (i + 1))
    if use_curl_fallback:
        try:
            args = ["curl", "-s", "-L", "--fail", "-m", str(timeout), "-A", h["User-Agent"]]
            for k, v in h.items():
                if k != "User-Agent":
                    args += ["-H", f"{k}: {v}"]
            p = subprocess.run(args + [url], capture_output=True, timeout=timeout + 10)
            if p.returncode == 0 and p.stdout:
                return p.stdout
            last = RuntimeError(f"curl rc={p.returncode}")
        except Exception as e:            # noqa: BLE001
            last = e
    raise RuntimeError(f"GET failed {url[:120]}: {last!r}")


def http_json(url: str, **kw):
    return json.loads(http_get(url, **kw).decode("utf-8"))


_patched = False


def requests_default_timeout(seconds: float = 40):
    """akshare calls requests.get(...) without a timeout in several places; one stalled TCP connection then
    hangs forever. Give every requests call that did not set one a default timeout."""
    global _patched
    if _patched:
        return
    import requests
    orig = requests.sessions.Session.request

    def request(self, method, url, **kw):
        if kw.get("timeout") is None:
            kw["timeout"] = seconds
        return orig(self, method, url, **kw)

    requests.sessions.Session.request = request
    _patched = True


# ----------------------------------------------------------------------------------------- JSON
def clean(o):
    """Recursively replace NaN/Inf with None so json is strict."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    try:
        import numpy as np
        if isinstance(o, np.generic):
            return clean(o.item())
    except Exception:  # noqa: BLE001
        pass
    return o


def write_json(path: Path, obj, *, indent=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(clean(obj), ensure_ascii=False, indent=indent, allow_nan=False,
                      separators=(",", ":") if indent is None else None)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=path.suffix)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
    os.chmod(tmp, 0o644)          # mkstemp makes 0600; the data files are plain readable files like compute.py writes
    os.replace(tmp, path)


def read_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def r2(x, nd=2):
    try:
        x = float(x)
    except Exception:  # noqa: BLE001
        return None
    return round(x, nd) if math.isfinite(x) else None


# ----------------------------------------------------------------------------------------- snapshots
def snapshot_path(source: str, day: str | None = None) -> Path:
    """flows/store/snapshots/<YYYY-MM-DD>/<source>.json — the raw daily snapshot store.
    `day` is the *data* as-of date when known, else the local fetch date."""
    day = day or today_local()
    return STORE / "snapshots" / day / f"{source}.json"


def save_snapshot(source: str, payload, day: str | None = None):
    p = snapshot_path(source, day)
    write_json(p, {"source": source, "fetchedAt": now_iso(), "asOf": day, "data": payload})
    return p


# ----------------------------------------------------------------------------------------- FX
_fx_cache: dict = {}


def fx_series(pair: str, period: str = "3y"):
    """Daily close of a yfinance FX pair (e.g. 'CNY=X' = CNY per USD, 'HKD=X'). pandas Series by date str."""
    if pair in _fx_cache:
        return _fx_cache[pair]
    import pandas as pd
    import yfinance as yf
    s = None
    for i in range(3):
        try:
            df = yf.download(pair, period=period, progress=False, auto_adjust=False, threads=False)
            c = df["Close"]
            if hasattr(c, "columns"):
                c = c.iloc[:, 0]
            c = c.dropna()
            if len(c):
                s = pd.Series(c.values, index=[d.strftime("%Y-%m-%d") for d in c.index])
                break
        except Exception as e:  # noqa: BLE001
            log("fx retry", pair, e)
            time.sleep(3 * (i + 1))
    if s is None:
        raise RuntimeError(f"no FX for {pair}")
    _fx_cache[pair] = s
    return s


def fx_cny_series(period: str = "3y"):
    """CNY per USD for converting Chinese money: offshore CNH from Yahoo's HOURLY bars at the 15:00 Beijing close
    (globalmkt/fxcnh.py), because the daily CNY=X goes stale for days and then jumps; CNY=X only fills days before
    the hourly history starts. Same shape as fx_series (date-str index). Falls back to CNY=X entirely if needed."""
    if "CNY*" in _fx_cache:
        return _fx_cache["CNY*"]
    import pandas as pd
    fb = fx_series("CNY=X", period)
    try:
        sys.path.insert(0, str(ROOT / "globalmkt"))
        import fxcnh
        s, info = fxcnh.spliced(pd.Series(fb.to_numpy(), index=pd.to_datetime(fb.index)), cut="asia")
        out = pd.Series(s.to_numpy(), index=[d.strftime("%Y-%m-%d") for d in s.index])
        out.attrs["fx"] = info
    except Exception as e:  # noqa: BLE001
        log("CNH hourly unavailable, converting with daily CNY=X", e)
        out = fb.copy()
        out.attrs["fx"] = {"source": "CNY=X daily", "error": str(e)[:200]}
    _fx_cache["CNY*"] = out
    return out


def fx_on(series, dates):
    """As-of (forward-filled) FX for each date in `dates`."""
    import pandas as pd
    idx = sorted(set(series.index) | set(dates))
    s = series.reindex(idx).ffill().bfill()
    return [float(s[d]) for d in dates]


# ----------------------------------------------------------------------------------------- universe
def world_etf_universe():
    """Tickers in the curated world continents (intl/bonds/commod/crypto/cash) with their region path.
    Returns {ticker: {"name", "note", "continent", "regions":[leafRegionId,...], "paths":[[ids...]]}}."""
    parts = json.load(open(ROOT / "universe" / "parts" / "world.json", encoding="utf-8"))
    out: dict = {}
    region_names: dict = {}

    def walk(n, path):
        path = path + [n["id"]]
        region_names[n["id"]] = {"name": n.get("name"), "emoji": n.get("emoji"), "path": path}
        for s in n.get("stocks", []):
            t = s["t"]
            e = out.setdefault(t, {"name": s.get("name"), "note": s.get("note"), "continent": path[0],
                                   "regions": [], "paths": []})
            if n["id"] not in e["regions"]:
                e["regions"].append(n["id"])
                e["paths"].append(["world"] + path)
        for c in n.get("children", []):
            walk(c, path)

    for cont in parts:
        if cont["id"] in ("intl", "bonds", "commod", "crypto", "cash"):
            walk(cont, [])
    return out, region_names


def envelope(kind: str, *, source: str, asOf, items: list, notes: list | None = None, **extra):
    """§24 file envelope. Every item carries its own source/asOf too."""
    d = {"kind": kind, "asOf": asOf, "generatedAt": now_iso(), "est": False, "unit": "USD m",
         "source": source, "items": items}
    if notes:
        d["notes"] = notes
    d.update(extra)
    return d


if __name__ == "__main__":
    print(ROOT, last_us_session(), today_local())
    u, r = world_etf_universe()
    print(len(u), "tickers", len(r), "regions")
    sys.exit(0)
