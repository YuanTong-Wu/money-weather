#!/usr/bin/env python3
"""graph/fundamentals.py — revenue / capex scale of every listed company that pays or gets paid in the graph.

graph/build.py uses it for the money sanity pass (DESIGN §14/§15 'verify': "graph money larger than the payee's
revenue"): an estimated flow bigger than what the payee sells in a whole year, or than what the payer spends in a
whole year (revenue + capex), is absurd and gets pulled back.

    python3 graph/fundamentals.py                 # fetch what is missing or older than 30 days (polite: 2 workers, backs off on 429)
    python3 graph/fundamentals.py --max-age 0     # refetch everything
    python3 graph/fundamentals.py --only MRVL,TSM # just these

Writes graph/fundamentals.json:
    {asOf, fetchedAt, fx:{EUR:1.08,…}, items:{T:{revB, capexB, capB, cur, at, nq?, firstTrade?, err?}}}   (USD billions, trailing 12 months)
    nq = reported quarters of revenue in the last ~21 months (< 4: the TTM revenue is partial — fresh listing / spin-off),
    firstTrade = first trading day (yfinance), so the sanity pass can tell a recent listing.
Source: yfinance Ticker.info (totalRevenue, financialCurrency, marketCap, firstTradeDate) + Ticker.ttm_cashflow
(Capital Expenditure) + Ticker.quarterly_income_stmt (Total Revenue, for nq).

    python3 graph/fundamentals.py --flagged       # refetch only the payees the last sanity pass flagged (graph/sanity_report.json)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "graph" / "fundamentals.json"
EDGES = ROOT / "web" / "data" / "graph" / "edges.json"


def read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(p: Path, obj) -> None:
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=0, sort_keys=True, allow_nan=False), encoding="utf-8")
    os.replace(tmp, p)


def fin(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def candidates() -> list[str]:
    """Listed ids that appear as payer or payee of a money edge."""
    d = read_json(EDGES, {}) or {}
    out = set()
    for e in d.get("edges") or []:
        m = e.get("money") or {}
        if m.get("usdB") is None:
            continue
        for i in (m.get("from"), m.get("to")):
            if i and not str(i).startswith("p:"):
                out.add(i)
    return sorted(out)


_FX: dict[str, float] = {"USD": 1.0}


def fx(cur: str | None) -> float | None:
    if not cur:
        return None
    cur = cur.upper()
    if cur in _FX:
        return _FX[cur]
    import yfinance as yf
    sub = 1.0
    base = cur
    if cur in ("GBP", "GBX", "GBPENCE", "ZAC", "ILA"):     # pence / agorot quotes
        base, sub = {"GBX": ("GBP", 0.01), "GBPENCE": ("GBP", 0.01), "ZAC": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}.get(cur, (cur, 1.0))
    rate = None
    for sym, inv in ((f"{base}USD=X", False), (f"USD{base}=X", True)):
        try:
            h = yf.Ticker(sym).history(period="10d")
            if len(h):
                c = float(h["Close"].dropna().iloc[-1])
                if c > 0:
                    rate = (1 / c) if inv else c
                    break
        except Exception:
            continue
    _FX[cur] = rate * sub if rate else None
    return _FX[cur]


TRANSIENT_RX = ("Too Many Requests", "Rate limited", "Unauthorized", "Invalid Crumb", "timed out", "Connection")
_LIMITED = {"until": 0.0, "hits": 0}


def transient(rec: dict | None) -> bool:
    return bool(rec and rec.get("err") and any(x in rec["err"] for x in TRANSIENT_RX))


def fetch_one(t: str, pause: float = 0.4) -> dict:
    """One ticker, politely: a short pause per call; on a rate-limit answer wait (60 s, 120 s) and try again."""
    for attempt in range(3):
        wait = _LIMITED["until"] - time.time()
        if wait > 0:
            time.sleep(wait)
        time.sleep(pause)
        rec = _fetch_one(t)
        if not transient(rec):
            return rec
        _LIMITED["hits"] += 1
        _LIMITED["until"] = max(_LIMITED["until"], time.time() + 60 * (attempt + 1))
    return rec


def _fetch_one(t: str) -> dict:
    import yfinance as yf
    rec = {"at": datetime.now().isoformat(timespec="seconds")}
    try:
        tk = yf.Ticker(t)
        info = tk.info or {}
        cur = info.get("financialCurrency") or info.get("currency")
        rev = fin(info.get("totalRevenue"))
        cap = fin(info.get("marketCap"))
        capex = None
        try:
            cf = tk.ttm_cashflow
            if cf is not None and "Capital Expenditure" in cf.index:
                capex = fin(cf.loc["Capital Expenditure"].dropna().iloc[0])
        except Exception:
            pass
        # how much history the revenue really has: reported quarters in the last ~21 months (yfinance often leaves the
        # newest quarter blank, so the window is wider than a year). A fresh listing / spin-off has 1–3, and
        # build.py's sanity pass then does not squeeze money down to a partial TTM.
        try:
            q = tk.quarterly_income_stmt
            if q is not None and "Total Revenue" in q.index:
                s = q.loc["Total Revenue"]
                cut = datetime.now() - timedelta(days=640)
                rec["nq"] = int(sum(1 for c, v in s.items() if fin(v) is not None and str(c)[:10] >= cut.date().isoformat()))
        except Exception:
            pass
        ft = info.get("firstTradeDateMilliseconds") or ((info.get("firstTradeDateEpochUtc") or 0) * 1000) or None
        if ft:
            try:
                rec["firstTrade"] = datetime.fromtimestamp(float(ft) / 1000).date().isoformat()
            except (OverflowError, OSError, ValueError):
                pass
        r = fx(cur) if (rev is not None or capex is not None) else None
        mcur = info.get("currency")
        rm = fx(mcur) if cap is not None else None
        rec.update({"cur": cur,
                    "revB": round(rev * r / 1e9, 4) if rev is not None and r else None,
                    "capexB": round(abs(capex) * r / 1e9, 4) if capex is not None and r else None,
                    "capB": round(cap * rm / 1e9, 3) if cap is not None and rm else None})
        if rec["revB"] is None and rec["capB"] is None:
            rec["err"] = "no data"
    except Exception as e:  # network / delisted
        rec["err"] = str(e)[:120]
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age", type=float, default=30, help="days before a ticker is refetched (failures: 7)")
    ap.add_argument("--only", default=None)
    ap.add_argument("--flagged", action="store_true", help="refetch the payees / payers in graph/sanity_report.json (adds nq / firstTrade)")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--budget", type=float, default=900, help="stop after this many seconds (what is left waits for the next run)")
    args = ap.parse_args(argv)
    cur = read_json(OUT, {}) or {}
    items: dict = cur.get("items") or {}
    if args.flagged:
        rep = read_json(ROOT / "graph" / "sanity_report.json", {}) or {}
        fl = sorted({x.get(k) for x in rep.get("items") or [] for k in ("to", "from")
                     if x.get(k) and not str(x.get(k)).startswith("p:") and x.get("flag") != "big-share"})
        args.only = ",".join(fl) or None
    want = args.only.split(",") if args.only else candidates()
    now = datetime.now()
    todo = []
    for t in want:
        r = items.get(t)
        if r and not args.only:
            try:
                age = now - datetime.fromisoformat(r.get("at"))
            except Exception:
                age = timedelta(days=999)
            if not transient(r) and age < timedelta(days=(7 if r.get("err") else args.max_age)):
                continue
        todo.append(t)
    print(f"fundamentals: {len(want)} candidates, {len(todo)} to fetch", flush=True)
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = {ex.submit(lambda x: None if time.time() - t0 > args.budget or _LIMITED["hits"] > 12 else fetch_one(x), t): t for t in todo}
        for f in as_completed(futs):
            t = futs[f]
            r = f.result()
            if r is None:                       # out of time / Yahoo keeps saying no: leave it for the next run
                continue
            if transient(r) and not transient(items.get(t)) and items.get(t, {}).get("revB") is not None:
                continue                        # keep the older good number rather than a rate-limit error
            items[t] = r
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(todo)} in {time.time() - t0:.0f}s", flush=True)
                write_json(OUT, {"asOf": now.date().isoformat(), "fetchedAt": now.isoformat(timespec="seconds"),
                                 "fx": {k: v for k, v in _FX.items() if v}, "items": items})
    write_json(OUT, {"asOf": now.date().isoformat(), "fetchedAt": now.isoformat(timespec="seconds"),
                     "fx": {k: v for k, v in _FX.items() if v}, "items": items})
    ok = sum(1 for t in want if (items.get(t) or {}).get("revB") is not None)
    print(f"  done in {time.time() - t0:.0f}s: revenue known for {ok}/{len(want)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
