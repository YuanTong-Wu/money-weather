#!/usr/bin/env python3
"""fetch_global.py — daily OHLCV for the 全球 universe (DESIGN §23) + daily FX, yfinance, polite, cached.

    python3 globalmkt/fetch_global.py                       # full refresh: 2 years for every market (~15–20 min)
    python3 globalmkt/fetch_global.py --days 5              # incremental: last 5 sessions of each market, merged
    python3 globalmkt/fetch_global.py --incremental         # = --days 5 --full-every 7 (per market)
    python3 globalmkt/fetch_global.py --due --incremental   # only the markets whose close passed since their last
                                                            #   fetch (weather follows the sun: Asia → Europe → Americas)
    python3 globalmkt/fetch_global.py --markets jp,kr --days 5      # these markets only
    python3 globalmkt/fetch_global.py --region asia|europe|americas
    options: --chunk 100 --pause 2 --limit N (first N tickers per market, test) --out FILE (test cache) --no-fx --fx-only

Reads   globalmkt/universe.json (9.3k listings in 25 markets; markets.<mk>.tz/close, stock mkt/ccy)
Writes  globalmkt/cache/prices_gl.parquet   long: date (market-local trading date), t, o, h, l, c, v — LOCAL currency,
                                            auto_adjust=True (dividends and splits folded into prices)
        globalmkt/cache/fx_gl.parquet       long: date, ccy, usdPer  (from Yahoo <CCY>=X, e.g. JPY=X ≈ 150 → 1/150;
                                            CNY = offshore CNH from hourly bars at the 15:00 Beijing close, because
                                            daily CNY=X goes stale for days — globalmkt/fxcnh.py)
        globalmkt/cache/fetch_stats.json    totals + per market {fetchedAt (aware), mode, lastFull, ok, failed,
                                            seconds, lastSession, failures}; compute_global.py and glcore.due_markets()
                                            read fetchedAt to decide which bars are final / which markets are due

Politeness: one market at a time (one timezone per request), chunks of ~100 symbols with threads=True, a pause
between chunks, exponential backoff when a chunk comes back mostly empty or rate-limited, a second pass for failures
in small chunks. Own yfinance tz cache under globalmkt/cache/yf-tz.

A bar of today (market-local date) is dropped when it was downloaded before the local close + 30 min — it is still
forming. Incremental merge re-bases older cached rows onto Yahoo's newest auto-adjust basis (same rule as
fullmarket/fetch_full.py: factor from the earliest overlapping session; volume too when they disagree by > 20 %);
new or nonsensical tickers get a full 2-year backfill; failed tickers keep their old rows.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
import yfinance.shared as yfs

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glcore as G  # noqa: E402

G.CACHE.mkdir(parents=True, exist_ok=True)
(G.CACHE / "yf-tz").mkdir(exist_ok=True)
yf.set_tz_cache_location(str(G.CACHE / "yf-tz"))
FIELDS = {"Open": "o", "High": "h", "Low": "l", "Close": "c", "Volume": "v"}
KEEP_DAYS = 760          # calendar days kept in the cache (≈ 2 years + slack: 252-day window + 252-day warm-up)
REGIONS = {"asia": "gl-greater-china gl-asia-pac", "europe": "gl-europe", "americas": "gl-americas"}
log = G.log


# ------------------------------------------------------------------------------------------------ yahoo
def split_frame(df, tickers, holes: dict | None = None):
    """yf.download multi-ticker frame → {ticker: DataFrame[o,h,l,c,v]} (only tickers with data).
    holes (optional): filled with {ticker: {date: volume}} for rows that have a volume but no prices — Yahoo's
    daily candle for Tokyo / Seoul often stays empty for many hours after the close (the hourly bars are there)."""
    out = {}
    if df is None or df.empty:
        return out
    if not isinstance(df.columns, pd.MultiIndex):
        df = pd.concat({tickers[0]: df}, axis=1).swaplevel(0, 1, axis=1)
    lvl0 = set(df.columns.get_level_values(0))
    for t in tickers:
        try:
            sub = pd.DataFrame({FIELDS[f]: df[(f, t)] for f in FIELDS if f in lvl0})
        except KeyError:
            continue
        if holes is not None and "v" in sub:
            h = sub[sub["c"].isna() & (sub["v"].fillna(0) > 0)]
            if len(h):
                idx = pd.to_datetime(h.index)
                idx = (idx.tz_localize(None) if idx.tz is not None else idx).normalize()
                holes.setdefault(t, {}).update({d: float(v) for d, v in zip(idx, h["v"].to_numpy())})
        sub = sub.dropna(subset=["c"])
        if len(sub):
            idx = pd.to_datetime(sub.index)
            if idx.tz is not None:
                idx = idx.tz_localize(None)
            sub.index = idx.normalize()
            sub.index.name = "date"
            out[t] = sub[~sub.index.duplicated(keep="last")]
    return out


def fetch_chunk(tickers, dl: dict, max_tries=4, base_sleep=10, holes: dict | None = None):
    t0 = time.time()
    got, errs = {}, {}
    todo = list(tickers)
    attempt = 0
    for attempt in range(1, max_tries + 1):
        yfs._ERRORS.clear()
        rate_limited = False
        try:
            df = yf.download(todo, interval="1d", auto_adjust=True, threads=True, group_by="column",
                             progress=False, timeout=25, multi_level_index=True, **dl)
        except Exception as e:  # noqa: BLE001 — YFRateLimitError etc.
            df, rate_limited = None, True
            errs["__chunk__"] = repr(e)[:200]
        part = split_frame(df, todo, holes)
        got.update(part)
        e = dict(yfs._ERRORS)
        if any("Rate" in str(v) or "Too Many" in str(v) for v in e.values()):
            rate_limited = True
        for t in todo:
            if t not in part:
                errs[t] = str(e.get(t, "no rows"))[:160]
        todo = [t for t in todo if t not in got]
        miss = len(todo) / max(len(tickers), 1)
        if not todo or (not rate_limited and miss < 0.2):
            break
        sl = base_sleep * (3 ** (attempt - 1))
        log(f"  chunk retry {attempt}: {len(todo)} missing, rate_limited={rate_limited}; sleeping {sl}s")
        time.sleep(sl)
    for t in got:
        errs.pop(t, None)
    return got, errs, attempt, time.time() - t0


def fetch_all(tickers, dl: dict, chunk: int, pause: float, label: str, holes: dict | None = None):
    T0 = time.time()
    data, errors, chunks = {}, {}, []
    for i in range(0, len(tickers), chunk):
        ch = tickers[i: i + chunk]
        got, errs, attempts, secs = fetch_chunk(ch, dl, holes=holes)
        data.update(got)
        errors.update(errs)
        chunks.append({"i": i // chunk, "n": len(ch), "ok": len(got), "attempts": attempts, "sec": round(secs, 1)})
        log(f"{label} chunk {i // chunk:3d}: {len(got)}/{len(ch)} ok in {secs:5.1f}s (attempts {attempts}) "
            f"total {len(data)}/{len(tickers)} elapsed {time.time() - T0:6.1f}s")
        if i + chunk < len(tickers):
            time.sleep(pause)
    retry = [t for t in tickers if t not in data]
    if retry and len(retry) < len(tickers):
        log(f"{label} second pass for {len(retry)} failed tickers")
        time.sleep(4)
        for i in range(0, len(retry), 25):
            got, errs, _, _ = fetch_chunk(retry[i: i + 25], dl, max_tries=2, base_sleep=15)
            data.update(got)
            errors.update(errs)
            time.sleep(2)
    errors = {t: errors.get(t, "no rows") for t in tickers if t not in data}
    return data, errors, chunks, time.time() - T0


def fill_holes(data: dict, holes: dict, m: dict, chunk: int, pause: float, label: str, days: int = 7) -> int:
    """Daily rows with a volume but no prices (Yahoo's Tokyo / Seoul candles lag for hours after the close): rebuild
    them from the hourly bars of the same local day (o = first open, h/l = extremes, c = last close; v = the daily
    row's volume). Only the last `days` calendar days; the next fetch replaces them once Yahoo fills the candle."""
    cut = pd.Timestamp(datetime.now().date() - timedelta(days=days))
    want = {t: {d: v for d, v in hs.items() if d >= cut and (t not in data or d not in data[t].index)}
            for t, hs in holes.items()}
    want = {t: hs for t, hs in want.items() if hs}
    if not want:
        return 0
    tz = m.get("tz") or "UTC"
    syms = sorted(want)
    n = 0
    log(f"{label} {len(syms)} ticker(s) have empty daily candles ({sum(len(v) for v in want.values())} rows) — "
        f"rebuilding them from hourly bars")
    for i in range(0, len(syms), chunk):
        ch = syms[i: i + chunk]
        try:
            df = yf.download(ch, period="5d", interval="60m", auto_adjust=True, threads=True, group_by="column",
                             progress=False, timeout=25, multi_level_index=True, prepost=False)
        except Exception as e:  # noqa: BLE001
            log(f"{label} hourly fetch failed: {e!r}"[:200])
            continue
        if df is None or df.empty:
            continue
        if not isinstance(df.columns, pd.MultiIndex):
            df = pd.concat({ch[0]: df}, axis=1).swaplevel(0, 1, axis=1)
        idx = pd.to_datetime(df.index)
        idx = idx.tz_convert(tz) if idx.tz is not None else idx
        day = pd.DatetimeIndex(idx.date if idx.tz is None else idx.tz_localize(None).date).normalize()
        for t in ch:
            try:
                sub = pd.DataFrame({FIELDS[f]: df[(f, t)].to_numpy() for f in FIELDS}, index=day).dropna(subset=["c"])
            except KeyError:
                continue
            rows = []
            for d, vday in want[t].items():
                g = sub[sub.index == d]
                if g.empty:
                    continue
                rows.append({"date": d, "o": float(g["o"].iloc[0]), "h": float(g["h"].max()),
                             "l": float(g["l"].min()), "c": float(g["c"].iloc[-1]),
                             "v": float(vday if vday > 0 else g["v"].sum())})
            if rows:
                add = pd.DataFrame(rows).set_index("date")
                add.index.name = "date"
                base = data.get(t)
                data[t] = add if base is None else pd.concat([base, add]).sort_index()
                data[t] = data[t][~data[t].index.duplicated(keep="first")]
                n += len(rows)
        time.sleep(pause)
    log(f"{label} rebuilt {n} daily row(s) from hourly bars")
    return n


# ------------------------------------------------------------------------------------------------ cache io
def read_long(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    df = pd.read_parquet(path)
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


def write_long(long: pd.DataFrame, path: Path) -> Path:
    long = long.sort_values(["t", "date"]).reset_index(drop=True)
    long["t"] = long["t"].astype("category")
    for c in "ohlc":
        long[c] = long[c].astype("float64")
    long["v"] = long["v"].fillna(0).astype("float64")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    long.to_parquet(tmp, index=False, compression="zstd")
    os.replace(tmp, path)            # atomic: compute_global.py never sees a half-written cache
    return path


def merge(old: pd.DataFrame, new: dict) -> tuple[pd.DataFrame, dict]:
    """incremental merge (fullmarket/fetch_full.py's rule): returns (long frame of the merged tickers, report)."""
    rep = {"rebased": {}, "volumeRebased": {}, "needFull": [], "newRows": 0}
    old_by = {t: g.set_index("date")[["o", "h", "l", "c", "v"]].sort_index()
              for t, g in old[old.t.isin(list(new))].groupby("t", observed=True)}
    out = {}
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
        elif nd.index.min() > od.index.max() + pd.Timedelta(days=12):
            rep["needFull"].append(t)
            continue
        rep["newRows"] += int(len(nd.index.difference(od.index)))
        out[t] = nd.combine_first(od)[["o", "h", "l", "c", "v"]]
    return to_long(out), rep


def market_sessions(long: pd.DataFrame, tickers: list[str], min_frac: float = 0.3) -> list[pd.Timestamp]:
    """trading days of one market in the cache: dates on which ≥ 30 % of its cached tickers traded (volume > 0)."""
    sub = long[long.t.isin(tickers)]
    if sub.empty:
        return []
    n = sub.t.nunique()
    sub = sub[sub["v"] > 0]          # zero-volume placeholder rows (exchange holidays) are not sessions
    cnt = sub.groupby("date").size()
    return sorted(cnt.index[cnt >= max(1, min_frac * n)])


def drop_unfinished(data: dict, m: dict, fetched: datetime) -> int:
    """drop bars that were still forming when downloaded (today, before the local close + buffer)."""
    n = 0
    for t, d in list(data.items()):
        keep = [G.bar_is_final(m, ts.date(), fetched) for ts in d.index]
        if not all(keep):
            n += int(len(keep) - sum(keep))
            d = d[np.array(keep)]
            if len(d):
                data[t] = d
            else:
                del data[t]
    return n


# ------------------------------------------------------------------------------------------------ fx
def fetch_fx(ccys: list[str], period: str = "2y") -> tuple[pd.DataFrame, dict]:
    syms = [G.fx_symbol(c) for c in ccys if c != "USD"]
    got, errs, _, secs = fetch_chunk(syms, {"period": period}, max_tries=3, base_sleep=8)
    frames = []
    for c in ccys:
        if c == "USD":
            continue
        d = got.get(G.fx_symbol(c))
        if d is None:
            continue
        s = d["c"].astype(float)
        s = s[(s > 0) & np.isfinite(s)]
        frames.append(pd.DataFrame({"date": s.index, "ccy": c, "usdPer": 1.0 / s.to_numpy()}))
    rep = {"symbols": len(syms), "ok": len(frames), "failed": sorted(errs), "sec": round(secs, 1)}
    # CNY: Yahoo's daily CNY=X is frozen on ~1 day in 5 and then jumps (a fake FX "return" for every A-share on the
    # catch-up day). Use offshore CNH built from hourly bars at the Asia close (15:00 Beijing); CNY=X only fills days
    # before the hourly history starts (globalmkt/fxcnh.py).
    if "CNY" in ccys:
        import fxcnh
        fb = None
        for fr in frames:
            if len(fr) and fr["ccy"].iloc[0] == "CNY":
                idx = pd.DatetimeIndex(pd.to_datetime(fr["date"]))
                fb = pd.Series(1.0 / fr["usdPer"].to_numpy(), index=idx.tz_localize(None) if idx.tz is not None else idx)
        try:
            s, info = fxcnh.spliced(fb, cut="asia")
            frames = [fr for fr in frames if not (len(fr) and fr["ccy"].iloc[0] == "CNY")]
            frames.append(pd.DataFrame({"date": s.index, "ccy": "CNY", "usdPer": 1.0 / s.to_numpy()}))
            if fb is None:
                rep["ok"] += 1
                rep["failed"] = [x for x in rep["failed"] if x != G.fx_symbol("CNY")]
            rep["cny"] = info
        except Exception as e:  # noqa: BLE001
            rep["cny"] = {"source": "CNY=X daily (CNH hourly failed)", "error": str(e)[:200]}
            log(f"fx: CNH hourly failed ({e}); CNY stays on daily CNY=X")
    fx = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["date", "ccy", "usdPer"])
    return fx, rep


def write_fx(fx: pd.DataFrame, fxp: Path) -> None:
    if fxp.exists():           # keep old rows of a currency that failed this time
        ofx = pd.read_parquet(fxp)
        ofx = ofx[~ofx.ccy.isin(fx.ccy.unique())]
        fx = pd.concat([ofx, fx], ignore_index=True)
    tmp = fxp.with_name(fxp.name + ".tmp")
    fx.sort_values(["ccy", "date"]).reset_index(drop=True).to_parquet(tmp, index=False)
    os.replace(tmp, fxp)


def fx_only(table: dict, stats_path: Path, test_mode: bool, out_path: Path) -> int:
    ccys = sorted({G.base_ccy(s.get("ccy") or "USD")[0] for s in table.values()})
    fx, rep = fetch_fx(ccys)
    fxp = G.FXFILE if not test_mode else out_path.with_name(out_path.stem + "_fx.parquet")
    if len(fx):
        write_fx(fx, fxp)
    rep["fetchedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        st = json.loads(stats_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        st = {}
    st["fx"] = rep
    stats_path.write_text(json.dumps(st, indent=1, ensure_ascii=False), encoding="utf-8")
    log(f"fx only: {rep['ok']}/{rep['symbols']} currencies in {rep['sec']}s; failed {rep['failed']}; CNY {rep.get('cny')}")
    return 0 if len(fx) else 1


# ------------------------------------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=0, help="incremental: re-download each market's last N sessions")
    ap.add_argument("--incremental", action="store_true", help="= --days 5 --full-every 7")
    ap.add_argument("--full-every", type=int, default=0, help="with --days: full refresh of a market whose last "
                                                              "full refresh is ≥ this many days old")
    ap.add_argument("--markets", default="", help="comma-separated market keys (cn,hk,jp …); default all")
    ap.add_argument("--region", default="", help="asia | europe | americas")
    ap.add_argument("--due", action="store_true", help="only markets whose close passed since their last fetch")
    ap.add_argument("--chunk", type=int, default=100)
    ap.add_argument("--pause", type=float, default=2.0)
    ap.add_argument("--period", default="2y")
    ap.add_argument("--limit", type=int, default=0, help="only the first N tickers of each market (tests)")
    ap.add_argument("--out", default=str(G.PRICES), help="cache file (tests: write elsewhere)")
    ap.add_argument("--no-fx", action="store_true")
    ap.add_argument("--fx-only", action="store_true", help="refresh fx_gl.parquet only (no prices)")
    a = ap.parse_args(argv)
    if a.incremental:
        a.days = a.days or 5
        a.full_every = a.full_every or 7
    out_path = Path(a.out)
    test_mode = out_path.resolve() != G.PRICES.resolve()
    stats_path = G.FETCH_STATS if not test_mode else out_path.with_name(out_path.stem + "_stats.json")

    root = G.load_universe()
    mk_info = G.markets(root)
    table = G.stock_table(root)
    if a.fx_only:
        return fx_only(table, stats_path, test_mode, out_path)
    by_mkt: dict[str, list[str]] = {mk: [] for mk in mk_info}
    for t, s in table.items():
        by_mkt.setdefault(s.get("mkt"), []).append(t)
    want = list(mk_info)
    if a.markets:
        want = [m for m in a.markets.split(",") if m in mk_info]
    if a.region:
        regs = REGIONS.get(a.region, a.region).split()
        want = [m for m in want if mk_info[m].get("region") in regs]
    try:
        prev = json.loads(stats_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        prev = {}
    if a.due:
        due = set(G.due_markets(root, stats=prev))
        want = [m for m in want if m in due]
        if not want:
            log("nothing due: every market was fetched after its last close")
            return 0
    log(f"markets: {','.join(want)} ({sum(len(by_mkt[m]) for m in want)} tickers)")

    src = out_path if out_path.exists() else (None if test_mode else G.PRICES)
    old = read_long(src) if src is not None else None
    T0 = time.time()
    per_prev = prev.get("markets") or {}
    per: dict[str, dict] = dict(per_prev)
    new_long: list[pd.DataFrame] = []
    replaced: set[str] = set()
    all_fail: dict[str, str] = {}
    for mk in want:
        m = mk_info[mk]
        tick = sorted(by_mkt.get(mk, []))
        if a.limit:
            tick = tick[: a.limit]
        if not tick:
            continue
        pm = per_prev.get(mk) or {}
        mode, why_full = ("incremental" if a.days > 0 else "full"), None
        start = None
        if mode == "incremental":
            sess = market_sessions(old, tick) if old is not None else []
            if len(sess) < a.days + 1:
                why_full = "no usable cache"
            elif a.full_every:
                lf = pm.get("lastFull")
                try:
                    lfd = datetime.fromisoformat(lf) if lf else None
                except ValueError:
                    lfd = None
                if lfd is None:
                    why_full = "no full refresh on record"
                elif datetime.now().astimezone() - lfd >= timedelta(days=a.full_every):
                    why_full = f"last full refresh {lf[:10]} is ≥ {a.full_every} days old"
            if why_full:
                mode = "full"
            else:
                start = pd.Timestamp(sess[-a.days]).strftime("%Y-%m-%d")
        t0 = time.time()
        fetched = datetime.now().astimezone()
        label = f"[{mk}]"
        if mode == "full":
            log(f"{label} full {a.period}: {len(tick)} tickers" + (f" ({why_full})" if why_full else ""))
            holes: dict = {}
            data, errors, chunks, secs = fetch_all(tick, {"period": a.period}, a.chunk, a.pause, label, holes)
            filled = fill_holes(data, holes, m, a.chunk, a.pause, label)
            dropped = drop_unfinished(data, m, fetched)
            part = to_long(data)
            rep = {}
            if old is not None:      # failed tickers keep their old rows
                part = pd.concat([part, old[old.t.isin([t for t in tick if t not in data])]], ignore_index=True)
        else:
            log(f"{label} incremental from {start}: {len(tick)} tickers")
            holes = {}
            data, errors, chunks, secs = fetch_all(tick, {"start": start}, a.chunk, a.pause, label, holes)
            filled = fill_holes(data, holes, m, a.chunk, a.pause, label)
            dropped = drop_unfinished(data, m, fetched)
            part, rep = merge(old, data)
            if rep["needFull"]:
                log(f"{label} backfilling {len(rep['needFull'])} ticker(s) with a full {a.period} download")
                bf, bf_err, _, _ = fetch_all(rep["needFull"], {"period": a.period}, 50, a.pause, label + "bf")
                drop_unfinished(bf, m, fetched)
                part = pd.concat([part, to_long(bf)], ignore_index=True)
                rep["backfilled"] = len(bf)
                errors.update({t: e for t, e in bf_err.items() if t not in data})
            have = set(part.t.astype(str).unique())     # failed / not backfilled tickers keep their old rows
            part = pd.concat([part, old[old.t.isin(tick) & ~old.t.isin(list(have))]], ignore_index=True)
        new_long.append(part)
        replaced.update(tick)
        fail = sorted(t for t in tick if t not in data)
        all_fail.update({t: errors.get(t, "no rows") for t in fail})
        sess_new = market_sessions(part, tick)
        last_sess = str(pd.Timestamp(sess_new[-1]).date()) if sess_new else None
        expected = (G.last_close(m, fetched) - timedelta(minutes=G.BUFFER_MIN)).date().isoformat()
        behind = bool(last_sess and last_sess < expected)
        tries = (int(pm.get("tries", 0)) + 1) if (behind and pm.get("expected") == expected) else (1 if behind else 0)
        per[mk] = {
            "fetchedAt": fetched.isoformat(timespec="seconds"), "mode": mode, "whyFull": why_full,
            "lastFull": fetched.isoformat(timespec="seconds") if (mode == "full" and not a.limit) else pm.get("lastFull"),
            "start": start, "requested": len(tick), "ok": len(tick) - len(fail), "failed": len(fail),
            "seconds": round(time.time() - t0, 1), "unfinishedDropped": dropped,
            "lastSession": last_sess, "expected": expected, "behind": behind, "tries": tries,
            "hourlyFilled": filled,
            "rebased": len(rep.get("rebased", {})), "backfilled": rep.get("backfilled", 0),
            "failures": {t: all_fail[t] for t in fail[:30]},
        }
        log(f"{label} done: {per[mk]['ok']}/{len(tick)} ok in {per[mk]['seconds']}s, last session "
            f"{per[mk]['lastSession']}, {dropped} unfinished bar(s) dropped")
        if mk != want[-1]:
            time.sleep(a.pause)

    # ---- assemble: untouched markets keep their rows
    if old is not None:
        rest = old[~old.t.isin(list(replaced))]
        long = pd.concat([rest] + new_long, ignore_index=True)
    else:
        long = pd.concat(new_long, ignore_index=True) if new_long else to_long({})
    long = long.drop_duplicates(["date", "t"], keep="last")
    long = long[long.t.isin(list(table))]
    cut = pd.Timestamp(datetime.now().date() - timedelta(days=KEEP_DAYS))
    long = long[long.date >= cut]
    path = write_long(long, out_path)

    fx_rep = prev.get("fx")
    if not a.no_fx:
        ccys = sorted({G.base_ccy(s.get("ccy") or "USD")[0] for s in table.values()})
        fx, fx_rep = fetch_fx(ccys)
        fxp = G.FXFILE if not test_mode else out_path.with_name(out_path.stem + "_fx.parquet")
        if len(fx):
            write_fx(fx, fxp)
        fx_rep["fetchedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        log(f"fx: {fx_rep['ok']}/{fx_rep['symbols']} currencies in {fx_rep['sec']}s; failed {fx_rep['failed']}")

    rows = long.groupby("t", observed=True).size()
    stats = {
        "fetchedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "lastRun": {"markets": want, "days": a.days or None, "fullEvery": a.full_every or None,
                    "seconds": round(time.time() - T0, 1), "failed": len(all_fail)},
        "requested": len(table), "tickersCached": int(long.t.nunique()), "rowsTotal": int(len(long)),
        "rowsPerTicker": {"min": int(rows.min()) if len(rows) else 0, "median": float(rows.median()) if len(rows) else 0,
                          "max": int(rows.max()) if len(rows) else 0, "lt252": int((rows < 252).sum()),
                          "lt60": int((rows < 60).sum())},
        "file": str(path.relative_to(G.HERE)) if path.is_relative_to(G.HERE) else str(path),
        "fileMB": round(path.stat().st_size / 1e6, 2),
        "fx": fx_rep, "markets": per,
    }
    stats_path.write_text(json.dumps(stats, indent=1, ensure_ascii=False), encoding="utf-8")
    log(f"wrote {path} ({stats['fileMB']} MB, {stats['tickersCached']} tickers, {stats['rowsTotal']} rows) in "
        f"{stats['lastRun']['seconds']}s; {len(all_fail)} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
