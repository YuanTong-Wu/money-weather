#!/usr/bin/env python3
"""stockfile.py — the §3 stocks/<T>.json document for any 全球 listing, built on demand (DESIGN §23/§24).

9.3k listings × ~25 KB would be ~230 MB a day, so compute_global.py stores everything in globalmkt/out/series_gl.npz and
server.py builds one file when the stock view asks (GET /api/gl/stock?t=0700.HK, or /data/gl/stocks/<T>.json when no
static file exists). ~1 ms per build after a one-off ~1 s load; results are LRU-cached until the npz changes.

    from globalmkt.stockfile import build_stock_json, stock_json_bytes
    build_stock_json("0700.HK")  -> dict in the exact §3 stock shape (USD prices, flows in USD millions, §14 fields)
                                    + the global extras below, or None if the symbol is not on the global map
    stock_json_bytes("0700.HK")  -> the same as compact UTF-8 JSON bytes (cached), or None

    python3 globalmkt/stockfile.py 0700.HK               # one-line summary
    python3 globalmkt/stockfile.py 7203.T --out x.json   # write the file
    python3 globalmkt/stockfile.py --bench               # load + build timings

Extras on top of the §3 shape (safe to ignore): "map":"global"; "ccy" (quote currency; "GBp" = pence), "mkt", "en",
"cap" (USD bn), "pair" (the A/H twin's symbol), "country"; "local": {"ccy", "o","h","l","c"} — the same bars in the
local currency (the 本币 view, §23); "fx": [USD per 1 unit of ccy, daily]; "closed": [window indices on which the
listing did not trade — its market was closed (holiday / not yet closed today) or it had no bar]; "closedDays": n
when its market has not traded on the last n calendar days (the weather shown is its last close).
`o h l c` are in USD; `v` is shares (0 on closed days). numpy only (no pandas), thread-safe.
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
NPZ = Path(os.environ.get("MW_GL_NPZ") or (HERE / "out" / "series_gl.npz"))
CACHE_MAX = 512

_lock = threading.Lock()
_store: dict | None = None
_docs: "OrderedDict[str, bytes]" = OrderedDict()


# ------------------------------------------------------------------------- rounding (same as pipeline/compute.py)
def _finish(r: np.ndarray) -> list:
    out = r.tolist()
    for i, v in enumerate(out):
        if v != v or v in (math.inf, -math.inf):
            out[i] = None
        elif v.is_integer():
            out[i] = int(v)
    return out


def flist(a, nd: int) -> list:
    return _finish(np.round(np.asarray(a, dtype=np.float64), nd) + 0.0)


def ilist(a) -> list:
    return [int(round(v)) if math.isfinite(v) else None for v in np.asarray(a, dtype=np.float64).tolist()]


def plist(a) -> list:
    """prices: 2 decimals when ≥ 10, else 4 (sub-cent USD prices of e.g. Korean/Indian penny stocks get 6)."""
    a = np.asarray(a, dtype=np.float64)
    ab = np.abs(a)
    return _finish(np.where(ab >= 10, np.round(a, 2), np.where(ab >= 0.01, np.round(a, 4), np.round(a, 6))) + 0.0)


def mlist(a) -> list:
    a = np.asarray(a, dtype=np.float64)
    ab = np.abs(a)
    return _finish(np.where(ab < 100, np.round(a, 2), np.where(ab < 10000, np.round(a, 1), np.round(a, 0))) + 0.0)


def sig(a, n: int = 6) -> list:
    """FX rates: n significant digits (JPY ≈ 0.00634, KRW ≈ 0.000754)."""
    a = np.asarray(a, dtype=np.float64)
    out = []
    for v in a.tolist():
        out.append(None if not math.isfinite(v) or v == 0 else float(f"{v:.{n}g}"))
    return out


def _price(v):
    v = float(v)
    if not math.isfinite(v):
        return None
    return round(v, 2 if abs(v) >= 10 else (4 if abs(v) >= 0.01 else 6)) + 0.0


def _num(v):
    v = float(v)
    if not math.isfinite(v):
        return None
    return int(v) if v.is_integer() else v


# ------------------------------------------------------------------------- store
_KEYS = ("dates", "tick", "nRegions", "wind", "temp", "pres", "storm", "front", "flow", "lag", "hasBar",
         "px_o", "px_h", "px_l", "px_c", "px_v", "fx", "c_local", "facts", "factKeys",
         "prof_lo", "prof_hi", "prof_bins", "prof_buy", "prof_sell")


def _load() -> dict:
    """(Re)load the npz when it changed on disk (atomic replace by compute_global.py)."""
    global _store
    st = NPZ.stat()
    key = (st.st_mtime_ns, st.st_size)
    if _store is not None and _store["key"] == key:
        return _store
    with _lock:
        if _store is not None and _store["key"] == key:
            return _store
        t0 = time.perf_counter()
        with np.load(NPZ, allow_pickle=False) as z:
            S = {k: z[k] for k in _KEYS}
            S["info"] = json.loads(str(z["info"]))
            S["asOf"] = str(z["asOf"])
        S["dates"] = [str(d) for d in S["dates"]]
        S["tix"] = {str(t): j for j, t in enumerate(S["tick"])}
        S["upper"] = {str(t).upper(): str(t) for t in S["tick"]}
        S["R"] = int(S["nRegions"])
        S["factKeys"] = [str(k) for k in S["factKeys"]]
        S["key"] = key
        S["loadSec"] = round(time.perf_counter() - t0, 3)
        _docs.clear()
        _store = S
        return S


def clean_ticker(t: str) -> str:
    t = str(t or "").strip()
    if t[:2].lower() == "s:":
        t = t[2:]
    if t.endswith(".json"):
        t = t[:-5]
    return t


def _resolve(S: dict, ticker: str) -> str | None:
    t = clean_ticker(ticker)
    if t in S["tix"]:
        return t
    return S["upper"].get(t.upper())


def tickers() -> list[str]:
    return list(_load()["tix"])


def build_stock_json(ticker: str) -> dict | None:
    """§3 stock document for one global listing (None if unknown)."""
    S = _load()
    t = _resolve(S, ticker)
    if t is None:
        return None
    j = S["tix"][t]
    k = S["R"] + j
    inf = S["info"].get(t, {})
    C = S["px_c"][:, j].astype(np.float64)
    alive = np.isfinite(C)
    flow_w = np.where(alive, S["flow"][:, k].astype(np.float64), np.nan)
    cum = np.where(alive, np.nancumsum(np.nan_to_num(flow_w)), np.nan)
    fr = S["facts"][j]
    facts = {}
    for i, key in enumerate(S["factKeys"]):
        v = fr[i]
        facts[key] = _price(v) if key in ("last", "high52", "low52") else _num(v)
    if np.isfinite(S["prof_lo"][j]):
        prof = {"lo": _price(S["prof_lo"][j]), "hi": _price(S["prof_hi"][j]), "bins": plist(S["prof_bins"][j]),
                "buy": flist(S["prof_buy"][j], 2), "sell": flist(S["prof_sell"][j], 2)}
    else:
        prof = {"lo": None, "hi": None, "bins": [], "buy": [], "sell": []}
    O, H, L = (S[f"px_{x}"][:, j].astype(np.float64) for x in "ohl")
    CL = S["c_local"][:, j].astype(np.float64)
    conv = np.where(np.isfinite(C) & (C > 0) & np.isfinite(CL), CL / np.where(C > 0, C, 1.0), np.nan)   # local per USD
    hb = S["hasBar"][:, j]
    doc = {
        "t": t, "name": inf.get("name") or t, "note": inf.get("note", ""), "paths": inf.get("paths", []),
        "dates": S["dates"],
        "o": plist(O), "h": plist(H), "l": plist(L), "c": plist(C),
        "v": ilist(S["px_v"][:, j]),
        "flow": mlist(flow_w),
        "cumFlow": mlist(cum),
        "wind": flist(S["wind"][:, k], 2),
        "temp": flist(S["temp"][:, k], 2),
        "pres": ilist(S["pres"][:, k]),
        "storm": flist(S["storm"][:, k], 2),
        "front": [int(v) for v in S["front"][:, k].tolist()],
        "profile": prof,
        "peers": inf.get("peers", []),
        "facts": facts,
        "map": "global",
        "ccy": inf.get("ccy") or "USD",
        "local": {"ccy": inf.get("ccy") or "USD", "o": plist(O * conv), "h": plist(H * conv), "l": plist(L * conv),
                  "c": plist(CL), "last": _price(CL[np.isfinite(CL)][-1]) if np.isfinite(CL).any() else None},
        "fx": sig(S["fx"][:, j]),
        "closed": [int(i) for i in np.flatnonzero(~hb & alive)],
    }
    lag = int(S["lag"][k])
    if lag > 0:
        doc["closedDays"] = lag
    for f in ("mkt", "en", "cap", "pair", "country", "ex", "est", "estUntil", "basis", "conf", "ov", "stale"):
        if f in inf:
            doc[f] = inf[f]
    return doc


def stock_json_bytes(ticker: str) -> bytes | None:
    """build_stock_json as compact JSON bytes, LRU-cached until the npz changes."""
    S = _load()
    t = _resolve(S, ticker)
    if t is None:
        return None
    key = f"{S['key']}|{t}"
    with _lock:
        b = _docs.get(key)
        if b is not None:
            _docs.move_to_end(key)
            return b
    doc = build_stock_json(t)
    if doc is None:
        return None
    b = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    with _lock:
        _docs[key] = b
        while len(_docs) > CACHE_MAX:
            _docs.popitem(last=False)
    return b


def write_stock_file(ticker: str, out_dir: Path) -> int:
    """Write <out_dir>/<T>.json (static fallbacks for the radar's stocks). Returns bytes written or 0."""
    b = stock_json_bytes(ticker)
    if b is None:
        return 0
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{_resolve(_load(), ticker)}.json"
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(b)
    os.replace(tmp, p)
    return len(b)


# ------------------------------------------------------------------------- CLI
def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="build a 全球 stocks/<T>.json from the npz")
    ap.add_argument("ticker", nargs="?")
    ap.add_argument("--out", help="write the JSON to this file")
    ap.add_argument("--bench", action="store_true")
    a = ap.parse_args(argv)
    if not NPZ.exists():
        print(f"stockfile: {NPZ} not found — run globalmkt/compute_global.py first", file=sys.stderr)
        return 1
    t0 = time.perf_counter()
    S = _load()
    t_load = time.perf_counter() - t0
    if a.bench:
        ts = list(S["tix"])[:: max(1, len(S["tix"]) // 300)]
        t0 = time.perf_counter()
        sizes = [len(stock_json_bytes(t)) for t in ts]
        dt = time.perf_counter() - t0
        t0 = time.perf_counter()
        for t in ts:
            stock_json_bytes(t)
        dt2 = time.perf_counter() - t0
        print(json.dumps({"npz": str(NPZ), "npzMB": round(NPZ.stat().st_size / 1e6, 1), "asOf": S["asOf"],
                          "tickers": len(S["tix"]), "loadSec": round(t_load, 3), "builtN": len(ts),
                          "msPerBuild": round(dt / len(ts) * 1000, 2), "msPerCachedHit": round(dt2 / len(ts) * 1000, 4),
                          "avgKB": round(sum(sizes) / len(sizes) / 1024, 1), "maxKB": round(max(sizes) / 1024, 1)}))
        return 0
    if not a.ticker:
        ap.print_help()
        return 1
    doc = build_stock_json(a.ticker)
    if doc is None:
        print(f"stockfile: {a.ticker} is not on the global map", file=sys.stderr)
        return 2
    if a.out:
        b = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        Path(a.out).write_bytes(b)
        print(f"wrote {a.out} ({len(b) / 1024:.1f} KB)")
    else:
        f = doc["facts"]
        print(f"{doc['t']} {doc['name']} ({doc.get('en', '')}) · {doc['note']} · {' › '.join(doc['paths'][0])} · "
              f"last ${f['last']} = {doc['local']['last']} {doc['ccy']} · 5d {f['ret5']} · flow5 {f['flow5']}M · "
              f"dv20 {f['dv20']}M · wind {doc['wind'][-1]} · peers {len(doc['peers'])} · closed {len(doc['closed'])}"
              + (f" · closedDays {doc['closedDays']}" if doc.get("closedDays") else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
