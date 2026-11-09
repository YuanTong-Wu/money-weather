#!/usr/bin/env python3
"""stockfile.py — the §3 stocks/<T>.json document for any full-market ticker, built on demand.

The full map has ~3,300 stocks; writing all their files would be ~67 MB a day. compute_full.py instead stores
everything in fullmarket/out/series_full.npz and the server builds one ticker's file when the stock view asks
for it (~1 ms after a one-off ~0.3 s load; the result is cached until the npz changes).

    from stockfile import build_stock_json, stock_json_bytes
    build_stock_json("NVDA")   -> dict in the exact §3 stock shape (same fields as pipeline/compute.py writes,
                                  incl. §14 est/estUntil/basis/conf), or None if the ticker is not on the full map
    stock_json_bytes("NVDA")   -> the same as compact UTF-8 JSON bytes (cached), or None

    python3 fullmarket/stockfile.py NVDA                # one-line summary
    python3 fullmarket/stockfile.py NVDA --out x.json   # write the file
    python3 fullmarket/stockfile.py --bench             # load + build timings

numpy only (no pandas) so the stdlib server can import it cheaply. Thread-safe.
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
NPZ = Path(os.environ.get("MW_FM_NPZ") or (HERE / "out" / "series_full.npz"))
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
    a = np.asarray(a, dtype=np.float64)
    return _finish(np.where(np.abs(a) >= 10, np.round(a, 2), np.round(a, 4)) + 0.0)


def mlist(a) -> list:
    a = np.asarray(a, dtype=np.float64)
    ab = np.abs(a)
    return _finish(np.where(ab < 100, np.round(a, 2), np.where(ab < 10000, np.round(a, 1), np.round(a, 0))) + 0.0)


def _price(v):
    v = float(v)
    if not math.isfinite(v):
        return None
    return round(v, 4 if abs(v) < 10 else 2) + 0.0


def _num(v):
    v = float(v)
    if not math.isfinite(v):
        return None
    return int(v) if v.is_integer() else v


# ------------------------------------------------------------------------- store
def _load() -> dict:
    """(Re)load the npz when it changed on disk. Arrays used per request are kept in memory (~60 MB)."""
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
            S = {k: z[k] for k in ("dates", "tick", "nRegions", "wind", "temp", "pres", "storm", "front", "flow",
                                   "px_o", "px_h", "px_l", "px_c", "px_v", "facts", "factKeys",
                                   "prof_lo", "prof_hi", "prof_bins", "prof_buy", "prof_sell")}
            S["info"] = json.loads(str(z["info"]))
            S["asOf"] = str(z["asOf"])
        S["dates"] = [str(d) for d in S["dates"]]
        S["tix"] = {str(t): j for j, t in enumerate(S["tick"])}
        S["R"] = int(S["nRegions"])
        S["factKeys"] = [str(k) for k in S["factKeys"]]
        S["key"] = key
        S["loadSec"] = round(time.perf_counter() - t0, 3)
        _docs.clear()
        _store = S
        return S


def clean_ticker(t: str) -> str:
    t = str(t or "").strip()
    if t.startswith("s:"):
        t = t[2:]
    if t.endswith(".json"):
        t = t[:-5]
    return t.upper().replace(".", "-")


def tickers() -> list[str]:
    return list(_load()["tix"])


def build_stock_json(ticker: str) -> dict | None:
    """§3 stock document for one full-market ticker (None if unknown)."""
    S = _load()
    t = clean_ticker(ticker)
    j = S["tix"].get(t)
    if j is None:
        return None
    k = S["R"] + j
    inf = S["info"].get(t, {})
    C = S["px_c"][:, j].astype(np.float64)
    alive = np.isfinite(C)
    flow_w = np.where(alive, S["flow"][:, k].astype(np.float64), np.nan)
    cum = np.where(alive, np.nancumsum(np.nan_to_num(flow_w)), np.nan)
    fk = S["factKeys"]
    fr = S["facts"][j]
    facts = {}
    for i, key in enumerate(fk):
        v = fr[i]
        facts[key] = _price(v) if key in ("last", "high52", "low52") else _num(v)
    if np.isfinite(S["prof_lo"][j]):
        prof = {"lo": _price(S["prof_lo"][j]), "hi": _price(S["prof_hi"][j]), "bins": plist(S["prof_bins"][j]),
                "buy": flist(S["prof_buy"][j], 2), "sell": flist(S["prof_sell"][j], 2)}
    else:
        prof = {"lo": None, "hi": None, "bins": [], "buy": [], "sell": []}
    doc = {
        "t": t, "name": inf.get("name") or t, "note": inf.get("note", ""), "paths": inf.get("paths", []),
        "dates": S["dates"],
        "o": plist(S["px_o"][:, j]), "h": plist(S["px_h"][:, j]), "l": plist(S["px_l"][:, j]), "c": plist(C),
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
        "map": "full",
    }
    for f in ("est", "estUntil", "basis", "conf", "ov"):
        if f in inf:
            doc[f] = inf[f]
    return doc


def stock_json_bytes(ticker: str) -> bytes | None:
    """build_stock_json as compact JSON bytes, LRU-cached until the npz changes."""
    S = _load()
    t = clean_ticker(ticker)
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
    """Write <out_dir>/<T>.json (used for static fallbacks of the attention candidates). Returns bytes or 0."""
    b = stock_json_bytes(ticker)
    if b is None:
        return 0
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{clean_ticker(ticker)}.json"
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(b)
    os.replace(tmp, p)
    return len(b)


# ------------------------------------------------------------------------- CLI
def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="build a full-market stocks/<T>.json from the npz")
    ap.add_argument("ticker", nargs="?")
    ap.add_argument("--out", help="write the JSON to this file")
    ap.add_argument("--bench", action="store_true")
    a = ap.parse_args(argv)
    if not NPZ.exists():
        print(f"stockfile: {NPZ} not found — run fullmarket/compute_full.py first", file=sys.stderr)
        return 1
    t0 = time.perf_counter()
    S = _load()
    t_load = time.perf_counter() - t0
    if a.bench:
        ts = list(S["tix"])[:: max(1, len(S["tix"]) // 200)]
        t0 = time.perf_counter()
        sizes = [len(stock_json_bytes(t)) for t in ts]
        dt = time.perf_counter() - t0
        t0 = time.perf_counter()
        for t in ts:
            stock_json_bytes(t)
        dt2 = time.perf_counter() - t0
        print(json.dumps({"npz": str(NPZ), "asOf": S["asOf"], "tickers": len(S["tix"]), "loadSec": round(t_load, 3),
                          "builtN": len(ts), "msPerBuild": round(dt / len(ts) * 1000, 2),
                          "msPerCachedHit": round(dt2 / len(ts) * 1000, 4),
                          "avgKB": round(sum(sizes) / len(sizes) / 1024, 1)}))
        return 0
    if not a.ticker:
        ap.print_help()
        return 1
    doc = build_stock_json(a.ticker)
    if doc is None:
        print(f"stockfile: {a.ticker} is not on the full-market map", file=sys.stderr)
        return 2
    if a.out:
        b = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        Path(a.out).write_bytes(b)
        print(f"wrote {a.out} ({len(b) / 1024:.1f} KB)")
    else:
        f = doc["facts"]
        print(f"{doc['t']} {doc['name']} · {doc['note']} · path {' › '.join(doc['paths'][0])} · last {f['last']} "
              f"· 5d {f['ret5']} · flow5 {f['flow5']}M · wind {doc['wind'][-1]} · peers {len(doc['peers'])} "
              f"· {len(doc['dates'])} days · load {t_load:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
