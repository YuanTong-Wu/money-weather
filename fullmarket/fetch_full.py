#!/usr/bin/env python3
"""fetch_full.py — daily OHLCV for the whole full-market universe (yfinance, auto_adjust=True).

    python3 fullmarket/fetch_full.py                     # full refresh: 2 years for every ticker (~5 min)
    python3 fullmarket/fetch_full.py --days 5            # incremental: re-download the last 5 sessions + anything
                                                         #   newer, merge into the cache (~3–4 min: one request per ticker dominates)
    python3 fullmarket/fetch_full.py --days 5 --full-every 7   # incremental, but a full refresh when the last one
                                                         #   is ≥ 7 days old
    python3 fullmarket/fetch_full.py --incremental       # the same thing (update.sh passes this flag)
    options: --chunk 100 --pause 1.5 --limit N (test) --out FILE (write elsewhere, test) --period 2y

Tickers  SPY (trading calendar) + every stock of fullmarket/universe_full.json
Writes   fullmarket/cache/prices_full.parquet  (long: date, t, o, h, l, c, v)   [pickle if no pyarrow]
         fullmarket/cache/fetch_stats.json     (mode, fetchedAt with timezone, lastFull, timings, failures, merges)

Incremental merge (auto_adjust prices move whenever a dividend or split happens):
  · each ticker's newly downloaded rows replace the cached rows on the same dates; rows are kept where the new
    download has none (a failed ticker keeps yesterday's data; compute_full.py marks it stale after 3 sessions)
  · older cached rows are re-based onto the new adjustment: factor = new close / cached close on the earliest
    overlapping session (not the last cached one, which may have been a still-trading bar); volume is re-based the
    same way when the overlap volumes disagree by > 20 % (a split)
  · tickers new to the universe, or whose overlap makes no sense, get a full 2-year download
  · the cache is trimmed to the last ~2 years of SPY sessions
Thin-day guard (2026-10-28: the 21:01 ET run on 10-27 got 10-27 rows for only 26 of 3,308 tickers — SPY not among
them — with zero failures; Yahoo's evening chart data simply lagged, merge and dedupe were fine, and 全市场 stayed a
day behind the other maps):
  · after every run the newest date in the cache is checked against the session before it: it needs rows for
    ≥ 90 % (THIN) of the tickers that traded that session
  · if it is thinner, the missing tickers (+ SPY) are re-downloaded at once with period=5d (Yahoo's range query, a
    different path from the start/end query) and merged the same way
  · still thin → that day's rows are dropped, so the trading calendar (SPY) and asOf never advance on a thin day;
    fetch_stats.json records `thin` {date, coverage, missing}, and the cache's mtime is set back 5 days so
    pipeline/stale.py (update.sh) treats it as stale and the next run re-downloads the last sessions (which every
    incremental run does for every ticker anyway)
Politeness: chunks of ~100 with threads=True, a short pause between chunks, exponential backoff when a chunk comes
back mostly empty or Yahoo rate-limits; failures get a second pass in small chunks. Own yfinance tz-cache.
Run it after the curated fetch, never at the same time (both hit Yahoo).
"""
from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
import yfinance.shared as yfs

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)
(CACHE / "yf-tz").mkdir(exist_ok=True)
yf.set_tz_cache_location(str(CACHE / "yf-tz"))
PRICES = CACHE / "prices_full.parquet"
STATS = CACHE / "fetch_stats.json"
KEEP_SESSIONS = 505            # ≈ 2 years: 252-day window + 252-day warm-up for the crowding percentile
THIN = 0.90                    # the newest date needs rows for ≥ 90 % of the tickers that traded the session before
REPAIR_PERIOD = "5d"           # the thin-day re-download (range query)

FIELDS = {"Open": "o", "High": "h", "Low": "l", "Close": "c", "Volume": "v"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def universe_tickers() -> list[str]:
    root = json.loads((HERE / "universe_full.json").read_text(encoding="utf-8"))
    out = []

    def walk(n):
        for s in n.get("stocks", []):
            out.append(s["t"])
        for c in n.get("children", []):
            walk(c)
    walk(root)
    return ["SPY"] + [t for t in dict.fromkeys(out) if t != "SPY"]


def split_frame(df, tickers):
    """yf.download multi-ticker frame -> {ticker: DataFrame[o,h,l,c,v]} (only tickers with data)."""
    out = {}
    if df is None or df.empty:
        return out
    if not isinstance(df.columns, pd.MultiIndex):  # single ticker
        df = pd.concat({tickers[0]: df}, axis=1).swaplevel(0, 1, axis=1)
    lvl0 = set(df.columns.get_level_values(0))
    for t in tickers:
        try:
            sub = pd.DataFrame({FIELDS[f]: df[(f, t)] for f in FIELDS if f in lvl0})
        except KeyError:
            continue
        sub = sub.dropna(subset=["c"])
        if len(sub):
            sub.index = pd.to_datetime(sub.index).tz_localize(None).normalize()
            sub.index.name = "date"
            out[t] = sub[~sub.index.duplicated(keep="last")]
    return out


def fetch_chunk(tickers, dl: dict, max_tries=4, base_sleep=10):
    """download one chunk with backoff; dl = {"period": "2y"} or {"start": "YYYY-MM-DD"}.
    returns (data dict, errors dict, attempts, seconds)"""
    t0 = time.time()
    got, errs = {}, {}
    todo = list(tickers)
    attempt = 0
    for attempt in range(1, max_tries + 1):
        yfs._ERRORS.clear()
        rate_limited = False
        try:
            df = yf.download(todo, interval="1d", auto_adjust=True, threads=True, group_by="column",
                             progress=False, timeout=20, multi_level_index=True, **dl)
        except Exception as e:  # YFRateLimitError etc.
            df, rate_limited = None, True
            errs["__chunk__"] = repr(e)[:200]
        part = split_frame(df, todo)
        got.update(part)
        e = dict(yfs._ERRORS)
        if any("Rate" in str(v) or "Too Many" in str(v) for v in e.values()):
            rate_limited = True
        for t in todo:
            if t not in part:
                errs[t] = str(e.get(t, "no rows"))[:160]
        todo = [t for t in todo if t not in got]
        miss_frac = len(todo) / max(len(tickers), 1)
        # few misses and no rate limiting -> genuine dead/odd symbols; don't hammer
        if not todo or (not rate_limited and miss_frac < 0.2):
            break
        sl = base_sleep * (3 ** (attempt - 1))
        log(f"  chunk retry {attempt}: {len(todo)} missing, rate_limited={rate_limited}; sleeping {sl}s")
        time.sleep(sl)
    for t in got:
        errs.pop(t, None)
    return got, errs, attempt, time.time() - t0


def fetch_all(tickers, dl: dict, chunk: int, pause: float, label: str):
    """chunked download + a second pass for failures. returns (data, errors, chunk log, seconds)"""
    T0 = time.time()
    data, errors, chunks = {}, {}, []
    for i in range(0, len(tickers), chunk):
        ch = tickers[i: i + chunk]
        got, errs, attempts, secs = fetch_chunk(ch, dl)
        data.update(got)
        errors.update(errs)
        chunks.append({"i": i // chunk, "n": len(ch), "ok": len(got), "fail": len(ch) - len(got),
                       "attempts": attempts, "sec": round(secs, 2)})
        log(f"{label} chunk {i // chunk:3d}: {len(got)}/{len(ch)} ok in {secs:5.1f}s (attempts {attempts}) "
            f"total {len(data)}/{len(tickers)} elapsed {time.time() - T0:6.1f}s")
        if i + chunk < len(tickers):
            time.sleep(pause)
    retry = [t for t in tickers if t not in data]
    if retry and len(retry) < len(tickers):
        log(f"{label} second pass for {len(retry)} failed tickers")
        time.sleep(5)
        for i in range(0, len(retry), 25):
            got, errs, _, _ = fetch_chunk(retry[i: i + 25], dl, max_tries=2, base_sleep=15)
            data.update(got)
            errors.update(errs)
            time.sleep(3)
    errors = {t: errors.get(t, "no rows") for t in tickers if t not in data}
    return data, errors, chunks, time.time() - T0


# ------------------------------------------------------------------------------------------------ cache io
def read_cache(path: Path) -> pd.DataFrame | None:
    if path.exists():
        df = pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_pickle(path)
    elif path.with_suffix(".pkl").exists():
        df = pd.read_pickle(path.with_suffix(".pkl"))
    else:
        return None
    df["t"] = df["t"].astype(str)
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    return df


def to_long(data: dict) -> pd.DataFrame:
    frames = []
    for t, d in data.items():
        d = d.reset_index()
        d["t"] = t
        frames.append(d)
    if not frames:
        return pd.DataFrame(columns=["date", "t", "o", "h", "l", "c", "v"])
    return pd.concat(frames, ignore_index=True)[["date", "t", "o", "h", "l", "c", "v"]]


def write_cache(long: pd.DataFrame, path: Path) -> Path:
    long = long.sort_values(["t", "date"]).reset_index(drop=True)
    long["t"] = long["t"].astype("category")
    for c in "ohlc":
        long[c] = long[c].astype("float64")
    long["v"] = long["v"].fillna(0).astype("float64")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import pyarrow  # noqa: F401
        tmp = path.with_name(path.name + ".tmp")
        long.to_parquet(tmp, index=False, compression="zstd")
    except ImportError:
        path = path.with_suffix(".pkl")
        tmp = path.with_name(path.name + ".tmp")
        long.to_pickle(tmp)
    os.replace(tmp, path)            # atomic: compute_full.py never sees a half-written cache
    return path


def trim(long: pd.DataFrame) -> pd.DataFrame:
    spy = np.sort(long.loc[long.t == "SPY", "date"].unique())
    if len(spy) > KEEP_SESSIONS:
        long = long[long.date >= spy[-KEEP_SESSIONS]]
    return long


# ------------------------------------------------------------------------------------------------ merge
def merge(old: pd.DataFrame, new: dict) -> tuple[pd.DataFrame, dict]:
    """incremental merge (see module doc). returns (long frame, report)"""
    rep = {"rebased": {}, "volumeRebased": {}, "needFull": [], "newRows": 0}
    old_by = {t: g.set_index("date")[["o", "h", "l", "c", "v"]].sort_index() for t, g in old.groupby("t", observed=True)}
    out = dict(old_by)
    for t, nd in new.items():
        od = old_by.get(t)
        if od is None or od.empty:
            rep["needFull"].append(t)
            continue
        ov = nd.index.intersection(od.index)
        ref = [d for d in ov if d != od.index[-1]] or list(ov)
        if ref:
            d0 = ref[0]
            oc, nc = float(od.at[d0, "c"]), float(nd.at[d0, "c"])
            if not (np.isfinite(oc) and np.isfinite(nc) and oc > 0 and nc > 0):
                rep["needFull"].append(t)
                continue
            r = nc / oc
            if r > 50 or r < 0.02:
                rep["needFull"].append(t)
                continue
            if abs(r - 1) > 1e-4:
                od = od.copy()
                od[["o", "h", "l", "c"]] *= r
                rep["rebased"][t] = round(r, 6)
            ovv, nvv = float(od.at[d0, "v"]), float(nd.at[d0, "v"])
            if ovv > 0 and nvv > 0 and abs(np.log(nvv / ovv)) > np.log(1.2):
                od = od.copy()
                od["v"] *= nvv / ovv
                rep["volumeRebased"][t] = round(nvv / ovv, 4)
        elif nd.index.min() > od.index.max() + pd.Timedelta(days=10):
            rep["needFull"].append(t)        # a gap we cannot bridge without a full download
            continue
        rep["newRows"] += int(len(nd.index.difference(od.index)))
        out[t] = nd.combine_first(od)[["o", "h", "l", "c", "v"]]
    frames = []
    for t, d in out.items():
        d = d.reset_index()
        d["t"] = t
        frames.append(d)
    return pd.concat(frames, ignore_index=True)[["date", "t", "o", "h", "l", "c", "v"]], rep


# ------------------------------------------------------------------------------------------------ thin-day guard
def coverage(long: pd.DataFrame, tickers: list[str]) -> dict | None:
    """the newest date in the cache vs the session before it (SPY's, else the previous date in the cache):
    {date, prev, have, base, frac, missing[], spy} — base = universe tickers with a row on `prev`."""
    dates = np.sort(long["date"].unique())
    if len(dates) < 2:
        return None
    d = dates[-1]
    spy = np.sort(long.loc[long.t == "SPY", "date"].unique())
    earlier = spy[spy < d]
    prev = earlier[-1] if len(earlier) else dates[-2]
    uni = set(tickers)
    base = set(long.loc[long["date"] == prev, "t"].astype(str)) & uni
    have = set(long.loc[long["date"] == d, "t"].astype(str)) & uni
    frac = len(have & base) / max(1, len(base))
    return {"date": str(pd.Timestamp(d).date()), "prev": str(pd.Timestamp(prev).date()), "have": len(have & base),
            "base": len(base), "frac": round(frac, 4), "missing": sorted(base - have), "spy": "SPY" in have}


def guard_thin(long: pd.DataFrame, tickers: list[str], chunk: int, pause: float) -> tuple[pd.DataFrame, dict]:
    """re-download the missing tickers once when the newest date is thin; drop it if it stays thin (see module doc).
    returns (long, report {checked, repaired, dropped, thin})"""
    out = {"checked": None, "repaired": None, "dropped": [], "thin": None}
    repaired = False
    for _ in range(4):
        cv = coverage(long, tickers)
        if out["checked"] is None and cv:
            out["checked"] = {k: v for k, v in cv.items() if k != "missing"}
        if not cv or cv["frac"] >= THIN:
            break
        if not repaired:
            get = list(cv["missing"]) + ([] if cv["spy"] else ["SPY"])
            get = list(dict.fromkeys(get))
            log(f"thin day {cv['date']}: rows for {cv['have']}/{cv['base']} tickers ({cv['frac']:.1%}) — "
                f"re-downloading {len(get)} with period={REPAIR_PERIOD}")
            data, errs, _, secs = fetch_all(get, {"period": REPAIR_PERIOD}, chunk, pause, "repair")
            repaired = True
            if data:
                long, _rep = merge(long, data)
                long = long.drop_duplicates(["date", "t"], keep="last")
            after = coverage(long, tickers)
            out["repaired"] = {"date": cv["date"], "asked": len(get), "got": len(data), "sec": round(secs, 1),
                               "before": cv["frac"], "after": after["frac"] if after else None}
            log(f"repair: {len(data)}/{len(get)} downloaded in {secs:.0f}s; {cv['date']} coverage "
                f"{cv['frac']:.1%} → {(after or {}).get('frac', 0):.1%}")
            continue
        # still thin after the repair pass: never let the calendar / asOf advance on it
        log(f"thin day {cv['date']} still {cv['frac']:.1%} after the repair pass — dropping its "
            f"{cv['have']} row(s); the next run re-downloads it")
        out["dropped"].append({"date": cv["date"], "rows": int((long["date"] == pd.Timestamp(cv["date"])).sum()),
                               "coverage": cv["frac"]})
        out["thin"] = {"date": cv["date"], "coverage": cv["frac"], "missing": len(cv["missing"]),
                       "sample": cv["missing"][:12]}
        long = long[long["date"] < pd.Timestamp(cv["date"])]
    return long, out


# ------------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=0, help="incremental: re-download the last N sessions (0 = full)")
    ap.add_argument("--incremental", action="store_true",
                    help="the daily default: same as --days 5 --full-every 7 (update.sh looks for this flag)")
    ap.add_argument("--full-every", type=int, default=0,
                    help="with --days: do a full refresh instead when the last one is ≥ this many days old")
    ap.add_argument("--chunk", type=int, default=100)
    ap.add_argument("--pause", type=float, default=1.5)
    ap.add_argument("--period", default="2y")
    ap.add_argument("--limit", type=int, default=0, help="only the first N tickers (tests)")
    ap.add_argument("--out", default=str(PRICES), help="cache file to write (default fullmarket/cache/prices_full.parquet)")
    a = ap.parse_args()
    if a.incremental:
        a.days = a.days or 5
        a.full_every = a.full_every or 7
    out_path = Path(a.out)
    src_path = out_path if out_path.exists() else PRICES

    tickers = universe_tickers()
    if a.limit:
        tickers = tickers[: a.limit]
    try:
        prev = json.loads(STATS.read_text())
    except Exception:  # noqa: BLE001
        prev = {}
    last_full = prev.get("lastFull") or (prev.get("fetchedAt") if prev.get("mode", "full") == "full" else None)

    mode = "incremental" if a.days > 0 else "full"
    if prev.get("thin"):
        log(f"the last run left {prev['thin'].get('date')} thin ({prev['thin'].get('coverage')}) and dropped it — "
            f"re-downloading the last sessions")
    old = read_cache(src_path) if mode == "incremental" else None
    why_full = None
    if mode == "incremental":
        if old is None or (old.t == "SPY").sum() < a.days + 1:
            why_full = "no usable cache"
        elif a.full_every and last_full:
            try:
                lf = datetime.fromisoformat(last_full)
                lf = lf if lf.tzinfo else lf.astimezone()
                if datetime.now().astimezone() - lf >= timedelta(days=a.full_every):
                    why_full = f"last full refresh {last_full[:10]} is ≥ {a.full_every} days old"
            except ValueError:
                why_full = "unreadable lastFull"
        elif a.full_every and not last_full:
            why_full = "no full refresh on record"
        if why_full:
            log(f"switching to a full refresh: {why_full}")
            mode = "full"

    T0 = time.time()
    rep: dict = {}
    if mode == "full":
        log(f"full refresh: {len(tickers)} tickers, period={a.period}, chunk={a.chunk}")
        data, errors, chunks, secs = fetch_all(tickers, {"period": a.period}, a.chunk, a.pause, "full")
        long = to_long(data)
        if a.limit and src_path.exists():    # a partial test run never throws away the other tickers
            keep = read_cache(src_path)
            long = pd.concat([keep[~keep.t.isin(list(data))], long], ignore_index=True)
    else:
        spy = np.sort(old.loc[old.t == "SPY", "date"].unique())
        start = pd.Timestamp(spy[-a.days]).strftime("%Y-%m-%d")
        log(f"incremental: {len(tickers)} tickers from {start} (last cached session {pd.Timestamp(spy[-1]).date()}), "
            f"chunk={a.chunk}")
        data, errors, chunks, secs = fetch_all(tickers, {"start": start}, a.chunk, a.pause, "incr")
        if "SPY" not in data:
            raise SystemExit("fetch_full: SPY did not download — keeping the old cache untouched")
        long, rep = merge(old, data)
        if rep["needFull"]:
            log(f"backfilling {len(rep['needFull'])} ticker(s) with a full {a.period} download")
            bf, bf_err, _, _ = fetch_all(rep["needFull"], {"period": a.period}, 50, a.pause, "backfill")
            long = pd.concat([long[~long.t.isin(list(bf))], to_long(bf)], ignore_index=True)
            rep["backfilled"] = sorted(bf)
            errors.update({t: e for t, e in bf_err.items() if t not in data})
    long = long.drop_duplicates(["date", "t"], keep="last")
    guard = {"checked": None, "repaired": None, "dropped": [], "thin": None}
    if not a.limit:                      # a --limit test run has no meaningful coverage
        long, guard = guard_thin(long, tickers, a.chunk, a.pause)
    long = trim(long)
    path = write_cache(long, out_path)
    if guard["thin"]:
        # pipeline/stale.py (update.sh) would call a cache written after the close "fresh" and skip the next fetch;
        # set its mtime back so the dropped day is fetched again on the next run
        back = time.time() - 5 * 86400
        os.utime(path, (back, back))
    total = time.time() - T0
    failed = sorted(errors)

    rows = long.groupby("t", observed=True).size()
    spy_days = int(rows.get("SPY", 0))
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    spy_dates = np.sort(long.loc[long.t == "SPY", "date"].unique())
    stats = {
        "mode": mode, "fetchedAt": now, "lastFull": now if mode == "full" and not a.limit else last_full,
        "whyFull": why_full, "days": a.days or None, "period": a.period, "chunkSize": a.chunk, "pause": a.pause,
        "requested": len(tickers), "ok": len(tickers) - len(failed), "failed": len(failed),
        "secondsTotal": round(total, 1), "secondsPer1000": round(total / max(len(tickers), 1) * 1000, 1),
        "lastSession": str(pd.Timestamp(spy_dates[-1]).date()) if len(spy_dates) else None,
        "rowsTotal": int(len(long)), "spyDays": spy_days,
        "rowsPerTicker": {"min": int(rows.min()), "median": float(rows.median()), "max": int(rows.max()),
                          "fullHistory": int((rows >= spy_days - 2).sum()),
                          "lt252": int((rows < 252).sum()), "lt60": int((rows < 60).sum())},
        "merge": ({k: (v if k != "rebased" else {"n": len(v), "sample": dict(list(v.items())[:20])})
                   for k, v in rep.items()} if rep else None),
        "coverage": guard["checked"], "repair": guard["repaired"], "droppedThin": guard["dropped"] or None,
        "thin": guard["thin"],
        "file": str(path.relative_to(HERE)) if path.is_relative_to(HERE) else str(path),
        "fileMB": round(path.stat().st_size / 1e6, 2),
        "chunks": chunks, "failures": errors,
    }
    if out_path.resolve() == PRICES.resolve():
        STATS.write_text(json.dumps(stats, indent=1, ensure_ascii=False))
    else:
        out_path.with_name(out_path.stem + "_stats.json").write_text(json.dumps(stats, indent=1, ensure_ascii=False))
    log(json.dumps({k: v for k, v in stats.items() if k not in ("chunks", "failures", "merge")}, ensure_ascii=False))
    if rep:
        log(f"merge: {len(rep.get('rebased', {}))} re-based for dividends/splits, "
            f"{len(rep.get('volumeRebased', {}))} volume re-based, {rep.get('newRows', 0)} new rows, "
            f"{len(rep.get('needFull', []))} backfilled")
    log(f"failed ({len(failed)}):", failed[:40])


if __name__ == "__main__":
    main()
