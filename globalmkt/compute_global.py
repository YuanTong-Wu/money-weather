#!/usr/bin/env python3
"""compute_global.py — 全球 weather → web/data/gl/  (DESIGN §2 metrics, §3 files, §14, §23, §24 global layer)

    python3 globalmkt/compute_global.py              # ≈ 1–3 min
    python3 globalmkt/compute_global.py --quiet      # no summary table
    python3 globalmkt/compute_global.py --out DIR --npz FILE    # write somewhere else (tests; skips radar + brief)
    (then by default: candidates_global.py → globalmkt/candidates.json + web/data/gl/candidates.json (全球雷达), and
     pipeline/brief.py --data web/data/gl → web/data/gl/brief.json; --no-candidates / --no-brief skip them)

Reads  globalmkt/universe.json            9.3k listings outside the US: gl-world → regions → countries → sectors → …
       globalmkt/cache/prices_gl.parquet  local-currency OHLCV (fetch_global.py) + fx_gl.parquet (USD per unit, daily)
       globalmkt/cache/fetch_stats.json   per-market fetchedAt (a bar fetched before its local close is dropped)
       web/data/meta.json                 (optional) the gauges (VIX / 10y / DXY), date-aligned
       web/data/overrides.json            (optional) §14 owner corrections ("s:<T>" / region ids)
Writes web/data/gl/{tree,meta,search}.json + maps/<id>.json — exactly the §3 shapes, root id "world" (name 全球), every
       other region id "gl-…", stock ids "s:<yahoo symbol>" (s:0700.HK, s:600519.SS) — so the frontend only swaps its
       data root to data/gl/; globalmkt/out/series_gl.npz for stockfile.py (lazy /api/gl/stock) and the radar;
       globalmkt/out/compute_stats.json (timings, sizes, failures, per-market state).

The weather math is NOT re-implemented: pipeline/compute.py (Universe, compute, estimate_info, apply_overrides,
now_block, volume_profile) runs on prices prepared like this:
  · Currency (§23): every series is converted to USD with that day's FX (Yahoo <CCY>=X; London pence = GBP/100;
    CNY = offshore CNH from hourly bars at the 15:00 Beijing close — the daily CNY=X freezes for days, globalmkt/fxcnh.py)
    BEFORE any metric, so 风 / 温度 compare like with like across markets. Stock files keep a local-currency view.
  · Calendar: the union of every market's own trading days (a market's day = ≥ 30 % of its listings have a bar), last
    ≈ 2 years. On a day a market is CLOSED (holiday, or its session today has not finished yet — "weather follows
    the sun"), its listings carry the last USD bar AND the last volume with a flat bar, so price change = 0 and the
    money push = 0 (no fake inflow/outflow, no fake "money left" from a zero-volume holiday); displayed money (dv, v) is
    the real 0, and every node whose markets were all closed that day shows its last open day's weather (frozen,
    front 0). Inside an open market a listing without a bar gets volume 0 (DESIGN §2).
  · Yahoo glitches: isolated ×100 unit flips (pence/pounds) are rescaled, other one-day spikes > ×4 vs the centred
    11-bar median are dropped, absurd highs/lows clamped.
  · now blocks / facts / radar of a node whose markets have not traded on the last calendar day are taken at its
    last open day (meta.markets.<mk>.state = pending | holiday tells the UI).
Extras on top of the §3 shapes (safe to ignore): root "map":"global"; region "tier": true on market-cap slices,
"markets" on country nodes; stock "cap" (USD bn), "ccy", "mkt", "en" (English name), "pair" (A/H twin), "stale";
meta.map "global", meta.markets {mk: {name, tz, close, node, region, lastSession, state, fetchedAt, nStocks}},
meta.fx {asOf, usdPer}, meta.pending [mk], meta.stale, meta.estimates; region "real" (§23 real money from
web/data/flows/china.json via its `attach` hints: gl-cn / gl-greater-china ← A股股票 ETF 申赎 (cn-etf-equity), gl-hk ←
南向; {id, label, flow1, flow5, flow20, asOf, coverage, parts:[其中南向…], est5, clash}) and meta.real {nodes}. markets.<mk>.state: current (traded on the
last calendar day) | pending (that day's session has not closed / not been fetched yet) | closed (fetched after the
close but no bars: a holiday, or Yahoo late — fetch retries hourly) | nodata.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import glcore as G  # noqa: E402

sys.path.insert(0, str(ROOT / "pipeline"))
try:
    import compute as eng  # pipeline/compute.py — the one implementation of DESIGN §2 / §14
except Exception as e:  # noqa: BLE001
    raise SystemExit(f"compute_global: cannot import pipeline/compute.py ({type(e).__name__}: {e})")

FACT_KEYS = ["last", "dv20", "flow5", "flow20", "flow5Avg", "ret1", "ret5", "ret20", "ret60", "high52", "low52"]
NPZ_VERSION = 1
SESSION_FRAC = 0.3          # a market traded on a day when ≥ 30 % of its listings have a bar
KEEP_SESSIONS = 520         # union calendar length (≈ 2 years of weekdays: 252 window + 252 warm-up + slack)
STALE_SESSIONS = 3
warnings.filterwarnings("ignore", category=RuntimeWarning)
T0 = time.perf_counter()
TIMES: dict[str, float] = {}
log = G.log


def lap(name: str, t: float) -> float:
    TIMES[name] = round(time.perf_counter() - t, 2)
    return time.perf_counter()


# ------------------------------------------------------------------------------------------------ threads
def _par_cols(fn, n_threads: int = 12):
    """Column-parallel wrapper for robust_z / pct_rank: they treat every column independently, so splitting the
    columns over threads gives bit-identical results (numpy sorts and reductions release the GIL)."""
    def wrapped(X, rows, *args, **kw):
        K = X.shape[1]
        if K < 512:
            return fn(X, rows, *args, **kw)
        edges = np.linspace(0, K, n_threads + 1).astype(int)
        parts = [(int(a), int(b)) for a, b in zip(edges[:-1], edges[1:]) if b > a]
        with ThreadPoolExecutor(len(parts)) as ex:
            outs = list(ex.map(lambda ab: fn(X[:, ab[0]:ab[1]], rows, *args, **kw), parts))
        return np.concatenate(outs, axis=1)
    return wrapped


# ------------------------------------------------------------------------------------------------ prices
def fetched_at(stats: dict) -> dict[str, datetime]:
    out = {}
    for mk, v in (stats.get("markets") or {}).items():
        try:
            d = datetime.fromisoformat(v.get("fetchedAt"))
            out[mk] = d if d.tzinfo else d.astimezone()
        except Exception:  # noqa: BLE001
            pass
    return out


def clean_bars(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """per-ticker Yahoo glitch repair on a ticker's own bars (local currency). Returns (frame, counts)."""
    rep = {"x100": 0, "spike": 0, "clamped": 0, "leading": 0}
    df = df[np.isfinite(df["c"]) & (df["c"] > 0)].copy()
    vv = df["v"].to_numpy(np.float64)
    first = int(np.argmax(np.nan_to_num(vv) > 0)) if (np.nan_to_num(vv) > 0).any() else 0
    if first > 0:                       # placeholder bars before the first trade (new listings): no volume, odd price
        rep["leading"] = first
        df = df.iloc[first:].copy()
    if len(df) < 5:
        return df, rep
    c = df["c"].to_numpy(np.float64)
    med = pd.Series(c).rolling(11, center=True, min_periods=3).median().to_numpy()
    r = c / med
    up100 = (r > 80) & (r < 125)            # pence ↔ pounds (and similar) unit flips: ≈ ×100 exactly
    dn100 = (r < 1 / 80) & (r > 1 / 125)
    if up100.any() or dn100.any():
        f = np.where(up100, 0.01, np.where(dn100, 100.0, 1.0))
        for k in "ohlc":
            df[k] = df[k].to_numpy(np.float64) * f
        rep["x100"] = int(up100.sum() + dn100.sum())
        c = df["c"].to_numpy(np.float64)
        r = c / pd.Series(c).rolling(11, center=True, min_periods=3).median().to_numpy()
    bad = (r > 4) | (r < 0.25)
    if bad.any():
        # only runs of ≤ 3 bad bars that are followed by a normal bar (the price comes back): a real crash or a jump
        # that stays — also one in the last few days, whose centred median is lopsided — is kept
        drop = np.zeros(len(bad), dtype=bool)
        i, n = 0, len(bad)
        while i < n:
            if bad[i]:
                j = i
                while j < n and bad[j]:
                    j += 1
                back = j < n and (i == 0 or abs(np.log(c[j] / c[i - 1])) < np.log(2.5))
                if back and j - i <= 3:
                    drop[i:j] = True
                i = j
            else:
                i += 1
        if drop.any():
            rep["spike"] = int(drop.sum())
            df = df[~drop].copy()
    o, h, l, c = (df[k].to_numpy(np.float64) for k in "ohlc")
    o = np.where(np.isfinite(o) & (o > c / 3) & (o < c * 3), o, c)
    hi_cap, lo_cap = np.fmax(o, c) * 2.0, np.fmin(o, c) / 2.0
    h2 = np.where(np.isfinite(h), np.clip(h, np.fmax(o, c), hi_cap), np.fmax(o, c))
    l2 = np.where(np.isfinite(l) & (l > 0), np.clip(l, lo_cap, np.fmin(o, c)), np.fmin(o, c))
    rep["clamped"] = int(((h2 != h) & np.isfinite(h)).sum() + ((l2 != l) & np.isfinite(l)).sum())
    df["o"], df["h"], df["l"] = o, h2, l2
    v = df["v"].to_numpy(np.float64)
    df["v"] = np.where(np.isfinite(v) & (v > 0), v, 0.0)
    return df, rep


def load_prices(table: dict, mk_info: dict, prices: Path, fxfile: Path, fstats: dict):
    """→ dict with cal, px (USD OHLCV DataFrames on cal × tickers), vreal (real volume), open masks, fx, info."""
    t0 = time.perf_counter()
    df = pd.read_parquet(prices)
    df["t"] = df["t"].astype(str)
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    df = df[df.t.isin(list(table))].drop_duplicates(["date", "t"], keep="last")
    df = df[df.date.dt.weekday < 5]
    mk_of = {t: s.get("mkt") for t, s in table.items()}
    df["mk"] = df.t.map(mk_of)
    # belt and braces: a bar dated on/after its market's fetch day, fetched before the local close, is unfinished
    fa = fetched_at(fstats)
    dropped_unfinished = 0
    for mk, f in fa.items():
        m = mk_info.get(mk)
        if not m:
            continue
        sel = (df.mk == mk) & (df.date >= pd.Timestamp(f.astimezone(G.ZoneInfo(m["tz"])).date()))
        if sel.any():
            fin = np.array([G.bar_is_final(m, d.date(), f) for d in df.loc[sel, "date"]])
            idx = df.index[sel][~fin]
            dropped_unfinished += len(idx)
            df = df.drop(index=idx)
    # glitch repair, per ticker
    rep_tot = {"x100": 0, "spike": 0, "clamped": 0, "leading": 0}
    parts = []
    for t, g in df.groupby("t", sort=False):
        g2, rep = clean_bars(g.sort_values("date"))
        for k in rep_tot:
            rep_tot[k] += rep[k]
        parts.append(g2)
    df = pd.concat(parts, ignore_index=True)
    t1 = time.perf_counter()
    # per-market sessions: days on which ≥ 30 % of the market's listings TRADED (Yahoo writes flat zero-volume
    # placeholder rows on some exchange holidays, e.g. Taiwan 2026-10-23 — those are not sessions)
    sessions: dict[str, pd.DatetimeIndex] = {}
    traded = df[df["v"] > 0]
    for mk, g in traded.groupby("mk"):
        n = df.loc[df.mk == mk, "t"].nunique()
        cnt = g.groupby("date").size()
        sessions[mk] = pd.DatetimeIndex(sorted(cnt.index[cnt >= max(1, SESSION_FRAC * n)]))
    sess_key = pd.MultiIndex.from_tuples([(mk, d) for mk, ss in sessions.items() for d in ss])
    row_key = pd.MultiIndex.from_arrays([df["mk"], df["date"]])
    placeholder = (df["v"] <= 0).to_numpy() & ~row_key.isin(sess_key)
    if placeholder.any():
        df = df[~placeholder]
    cal = pd.DatetimeIndex(sorted(set().union(*[set(s) for s in sessions.values()])))
    cal = cal[-KEEP_SESSIONS:]
    # FX → USD per unit of the quote currency, on the calendar (ffill; first days back-filled)
    fx = pd.read_parquet(fxfile)
    fx["date"] = pd.to_datetime(fx["date"]).dt.normalize()
    fxw = fx.pivot_table(index="date", columns="ccy", values="usdPer", aggfunc="last").sort_index()
    allday = fxw.index.union(cal).union(pd.DatetimeIndex(df["date"].unique()))
    fxw = fxw.reindex(allday).ffill().bfill()
    fxw["USD"] = 1.0
    tick = list(table)
    mult = np.array([G.base_ccy(table[t].get("ccy") or "USD")[1] for t in tick])
    base = [G.base_ccy(table[t].get("ccy") or "USD")[0] for t in tick]
    missing_ccy = sorted({b for b in base if b not in fxw.columns})
    for b in missing_ccy:      # no FX at all for a currency: fall back to the universe's snapshot rate (estimate)
        fxw[b] = (G.load_universe().get("fx") or {}).get("usdPer", {}).get(b, np.nan)
    # wide local frames on each ticker's own dates → USD with that date's FX
    F = {k: df.pivot(index="date", columns="t", values=k) for k in "ohlcv"}
    del df
    raw_dates = F["c"].index
    fx_on = fxw.reindex(raw_dates)
    fx_t = fx_on[base].to_numpy(np.float64) * mult[None, :]           # dates × tickers (USD per quote unit)
    cols = list(F["c"].columns)
    pos = {t: j for j, t in enumerate(tick)}
    fx_t = fx_t[:, [pos[t] for t in cols]]
    usd = {k: F[k] * fx_t for k in "ohlc"}
    vol = F["v"]
    # onto the union calendar
    has_bar = F["c"].reindex(cal).notna().reindex(columns=tick, fill_value=False)
    C = usd["c"].reindex(cal).reindex(columns=tick)
    O, H, L = (usd[k].reindex(cal).reindex(columns=tick) for k in "ohl")
    V = vol.reindex(cal).reindex(columns=tick)
    Cl = F["c"].reindex(cal).reindex(columns=tick)          # local close (for the stock file's local view)
    # open[t, mk]: did market mk trade on cal[t]?
    mks = list(mk_info)
    open_mk = pd.DataFrame({mk: cal.isin(sessions.get(mk, pd.DatetimeIndex([]))) for mk in mks}, index=cal)
    tmk = [mk_of[t] for t in tick]
    open_t = open_mk[tmk].to_numpy(bool)                     # cal × tickers: the ticker's market was open
    # closed market → carry price and volume (flat bar, push 0); open market without a bar → volume 0
    Cf = C.ffill()
    Vc = V.where(has_bar.to_numpy(), np.nan).ffill().fillna(0.0)
    vreal = np.where(has_bar.to_numpy(), V.fillna(0.0).to_numpy(), 0.0)
    vcalc = np.where(open_t, vreal, Vc.to_numpy())
    vcalc = np.where(np.isfinite(Cf.to_numpy()), vcalc, 0.0)
    gap = ~has_bar.to_numpy() & np.isfinite(Cf.to_numpy())
    px = {"Close": Cf}
    for name, X in (("Open", O), ("High", H), ("Low", L)):
        px[name] = X.mask(gap, Cf).fillna(Cf)
    px["Volume"] = pd.DataFrame(vcalc, index=cal, columns=tick)
    fx_cal = (fxw.reindex(cal)[base].to_numpy(np.float64) * mult[None, :])
    # local close carried like the USD one (so USD / local = the FX of the last real bar, exactly)
    Clf = Cl.ffill()
    info = {
        "unfinishedDropped": dropped_unfinished, "glitches": rep_tot, "missingFx": missing_ccy,
        "placeholderRows": int(placeholder.sum()),
        "sessions": {mk: [str(sessions[mk][0].date()), str(sessions[mk][-1].date()), int(len(sessions[mk]))]
                     for mk in sessions},
        "secLoad": round(t1 - t0, 2), "secReshape": round(time.perf_counter() - t1, 2),
    }
    return {"cal": cal, "px": px, "vreal": vreal, "open_t": open_t, "open_mk": open_mk, "sessions": sessions,
            "has_bar": has_bar.to_numpy(), "fx_cal": fx_cal, "Clocal": Clf.to_numpy(np.float64), "fxw": fxw,
            "tick": tick, "info": info}


# ------------------------------------------------------------------------------------------------ fast JSON
_INT0 = re.compile(r"\.0(?=[,\]])")


def col_strings(M: np.ndarray, nd: int | None, as_int: bool = False) -> list[str]:
    """W×K matrix → K JSON arrays, identical to pipeline/compute.py's flist / ilist (NaN → null, 3.0 → 3)."""
    A = np.asarray(M, dtype=np.float64)
    A = np.where(np.isfinite(A), A, np.nan)
    A = (np.round(A) if as_int else np.round(A, nd)) + 0.0
    out = []
    for k in range(A.shape[1]):
        s = json.dumps(A[:, k].tolist(), separators=(",", ":"))
        out.append(_INT0.sub("", s.replace("NaN", "null")))
    return out


def series_strings(res: dict) -> list[str]:
    """every node's SERIES object (§3) as a JSON string, same values as eng.series(res, k)."""
    K = res["wind"].shape[1]
    S = {
        "wind": col_strings(res["wind"], 2), "temp": col_strings(res["temp"], 2),
        "pres": col_strings(res["pres"], None, as_int=True), "storm": col_strings(res["storm"], 2),
        "front": col_strings(np.nan_to_num(res["front"]), None, as_int=True), "idx": col_strings(res["idx"], 2),
        "flow": col_strings(res["flow"], 1), "dv": col_strings(res["dv"], 1),
    }
    keys = eng.SERIES_KEYS
    return ["{" + ",".join(f'"{key}":{S[key][k]}' for key in keys) + "}" for k in range(K)]


def write_text(path: Path, s: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(s, encoding="utf-8")
    os.replace(tmp, path)
    return len(s.encode("utf-8"))


# ------------------------------------------------------------------------------------------------ helpers
def stock_facts(res: dict, j: int, dv20, end: int, w0: int) -> dict:
    """§3 stocks/<T>.json facts at row `end` (full-length row index), same definitions as pipeline/compute.py."""
    C, H, L = res["C"][: end + 1, j], res["H"][: end + 1, j], res["L"][: end + 1, j]
    mf = res["MF"][: end + 1, j] / 1e6
    alive = np.isfinite(C)
    sl = slice(w0, None)

    def cret(n):
        if len(C) > n and np.isfinite(C[-1]) and np.isfinite(C[-1 - n]) and C[-1 - n] > 0:
            return eng.fnum(C[-1] / C[-1 - n] - 1, 4)
        return None

    f5 = pd.Series(np.nan_to_num(mf)).rolling(5).sum().to_numpy()[sl]
    f5 = f5[alive[sl]]
    Hw, Lw = H[sl], L[sl]
    return {
        "last": eng.price(C[-1]), "dv20": dv20,
        "flow5": eng.fnum(np.nansum(mf[-5:]), 2), "flow20": eng.fnum(np.nansum(mf[-20:]), 2),
        "flow5Avg": eng.fnum(np.nanmean(np.abs(f5)) if len(f5) else 0.0, 2),
        "ret1": cret(1), "ret5": cret(5), "ret20": cret(20), "ret60": cret(60),
        "high52": eng.price(np.nanmax(Hw) if np.isfinite(Hw).any() else np.nan),
        "low52": eng.price(np.nanmin(Lw) if np.isfinite(Lw).any() else np.nan),
    }


def now_block_at(res: dict, k: int, lag: int) -> dict:
    """eng.now_block as of `lag` calendar days before the last (the node's last open day)."""
    if lag <= 0:
        return eng.now_block(res, k)
    sub = {key: res[key][:-lag] for key in ("wind", "temp", "pres", "storm", "front", "retn", "ret5", "ret20",
                                            "MFn", "DVn", "alive", "idx")}
    return eng.now_block(sub, k)


def align_atmosphere(dates: list[str]) -> list:
    """the curated map's gauges, re-indexed onto the global dates (a US holiday carries the last value)."""
    try:
        cm = json.loads((G.CURATED / "meta.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    cd = cm.get("dates") or []
    out = []
    for a in cm.get("atmosphere") or []:
        s = a.get("series") or []
        ser = pd.Series(s[: len(cd)], index=pd.to_datetime(cd[: len(s)]), dtype="float64")
        al = ser.reindex(ser.index.union(pd.to_datetime(dates))).ffill().reindex(pd.to_datetime(dates))
        b = dict(a)
        b["series"] = [None if not np.isfinite(v) else round(float(v), 4) for v in al.to_numpy()]
        out.append(b)
    return out


def load_overrides(U, res, est):
    path = Path(os.environ.get("MW_OVERRIDES_PATH") or (G.CURATED / "overrides.json"))
    if not path.exists() or not hasattr(eng, "apply_overrides"):
        return {}, {}, 0
    try:
        import owner_overrides as ovmod  # pipeline/owner_overrides.py
        eff = ovmod.effective(ovmod.load(path))
        if eff:
            return eng.apply_overrides(U, res, est, eff)
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: overrides not applied ({type(e).__name__}: {e})")
    return {}, {}, 0


def save_npz(path: Path, **arrays) -> int:
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(buf.getvalue())
    os.replace(tmp, path)
    return path.stat().st_size


FLOWS_DIR = ROOT / "web" / "data" / "flows"


def real_money_blocks(asof_by_id: dict, est5_by_id: dict) -> dict:
    """§23 real money first: measured flows (web/data/flows/china.json, est:false) attached to 全球 nodes via each
    item's `attach` hints → {nodeId: real block}. The primary record is the node's 真钱; the others are "其中/另外"
    parts (e.g. 南向 inside 大中华 is an internal move, flagged internal). 5-day sums end at the node's own as-of
    day (a node whose market has not traded today is summed to its last open day). Never mixed into the §2 weather."""
    try:
        doc = json.loads((FLOWS_DIR / "china.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — no real-money layer yet: nothing to attach
        return {}
    recs: dict[str, list] = {}
    for it in doc.get("items") or []:
        if it.get("est") or it.get("stale") or not it.get("date") or not it.get("usd"):
            continue
        for a in it.get("attach") or []:
            if a.get("map") == "global" and a.get("id") in asof_by_id:
                recs.setdefault(a["id"], []).append((a, it))
    out = {}

    def sums(it, day):
        ds, us = it["date"], it["usd"]
        j = len(ds) - 1
        while j >= 0 and ds[j] > day:
            j -= 1
        if j < 0:
            return None
        win = lambda k: round(float(sum(v for v in us[max(0, j - k + 1):j + 1] if isinstance(v, (int, float)))), 1)  # noqa: E731
        return {"flow1": win(1), "flow5": win(5), "flow20": win(20), "asOf": ds[j]}

    for nid, lst in recs.items():
        day = asof_by_id[nid]
        lst.sort(key=lambda ai: (not ai[0].get("primary"), ai[1].get("kind") != "etf-total"))
        a0, it0 = lst[0]
        m = sums(it0, day)
        if not m:
            continue
        blk = {"id": it0["id"], "label": a0.get("label") or it0.get("label") or it0.get("name"), **m,
               "source": it0.get("source"), "coverage": it0.get("coverage"), "coverageOf": it0.get("coverageOf"),
               "basis": it0.get("basis"), "est": False}
        if m["asOf"] < day:
            blk["behind"] = True             # the real series ends before the node's weather day
        parts = []
        for a, it in lst[1:]:
            q = sums(it, day)
            if q:
                parts.append({"id": it["id"], "label": a.get("label") or it.get("name"), **q,
                              "internal": it.get("internal") == nid or None, "source": it.get("source")})
        if parts:
            blk["parts"] = [{k: v for k, v in x.items() if v is not None} for x in parts]
        e5 = est5_by_id.get(nid)
        if e5 is not None:
            big = max(abs(e5), abs(m["flow5"]))
            blk["est5"] = e5
            blk["clash"] = bool(big > 0 and (e5 > 0) != (m["flow5"] > 0)
                                and abs(e5) > 0.08 * big and abs(m["flow5"]) > 0.08 * big)
        out[nid] = {k: v for k, v in blk.items() if v is not None}
    return out


def tree_root(uni: dict) -> dict:
    root = {k: v for k, v in uni.items() if k not in ("generatedAt", "fx", "rule", "markets", "core", "map")}
    root["id"] = G.ROOT_ID
    return root


# ------------------------------------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(G.WEB))
    ap.add_argument("--npz", default=str(G.NPZ))
    ap.add_argument("--prices", default=str(G.PRICES))
    ap.add_argument("--fx", default=str(G.FXFILE))
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--threads", type=int, default=12)
    ap.add_argument("--no-candidates", action="store_true")
    ap.add_argument("--no-brief", action="store_true")
    a = ap.parse_args(argv)
    out = Path(a.out).resolve()
    if a.threads > 1:
        eng.robust_z = _par_cols(eng.robust_z, a.threads)
        eng.pct_rank = _par_cols(eng.pct_rank, a.threads)

    t = time.perf_counter()
    uni = G.load_universe()
    mk_info = G.markets(uni)
    table = G.stock_table(uni)
    try:
        fstats = json.loads(G.FETCH_STATS.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        fstats = {}
    if not Path(a.prices).exists():
        raise SystemExit("compute_global: no price cache — run globalmkt/fetch_global.py first")
    P = load_prices(table, mk_info, Path(a.prices), Path(a.fx), fstats)
    cal, px, tick = P["cal"], P["px"], P["tick"]
    t = lap("load_prices", t)
    root = tree_root(uni)
    avail = {x for j, x in enumerate(tick) if P["has_bar"][:, j].any()}
    nodata = sorted(set(tick) - avail)
    U = eng.Universe(root, set(tick))          # keep no-data tickers: §14 estimates instead of vanishing
    log(f"compute_global: {U.R} regions, {U.N} stocks, {len(cal)} union trading days "
        f"({cal[0].date()} → {cal[-1].date()}); {len(nodata)} without prices")
    t = lap("universe", t)
    res = eng.compute(U, px, cal)
    del px
    t = lap("compute", t)

    W, w0, T = res["W"], res["w0"], len(cal)
    tpos = {x: j for j, x in enumerate(tick)}
    # every universe ticker is kept (no-data ones become §14 estimates), in the same DFS order as `tick`: the
    # per-ticker arrays built in load_prices (real volume, FX, local close) line up with res["C"] column by column
    assert U.tickers == tick, "ticker order mismatch between the universe walk and the price frames"
    # ---- real money for display (closed-market days show 0, not the carried volume)
    Vr = P["vreal"]
    DVr = np.nan_to_num(res["C"] * Vr)
    res["dv"] = (DVr[w0:] @ U.M.T) / 1e6
    # ---- open masks per node: did any of its markets trade that day?
    mks = list(mk_info)
    mi = {mk: i for i, mk in enumerate(mks)}
    S_mk = P["open_mk"][mks].to_numpy(np.float64)                         # T × nM
    stock_mk = np.zeros((U.N, len(mks)))
    for j, x in enumerate(U.tickers):
        stock_mk[j, mi[table[x]["mkt"]]] = 1.0
    node_mk = (U.M @ stock_mk) > 0                                       # K × nM
    open_node = (S_mk @ node_mk.T.astype(np.float64)) > 0                # T × K
    ow = open_node[w0:]
    # freeze weather on a node's closed days (its last open day's value), no fronts on them
    last_open = np.where(ow, np.arange(W)[:, None], -1)
    last_open = np.maximum.accumulate(last_open, axis=0)                 # W × K: index of last open day so far
    closed = ~ow
    if closed.any():
        has = last_open >= 0
        for key in ("wind", "temp", "pres", "storm"):
            A = res[key]
            src = A[np.clip(last_open, 0, None), np.arange(A.shape[1])[None, :]]
            res[key] = np.where(closed & has, src, A)
        res["front"] = np.where(closed, 0.0, res["front"])
    lag = (W - 1) - last_open[-1]                                        # K: days since the node last traded
    lag = np.where(last_open[-1] < 0, 0, lag).astype(int)
    t = lap("calendar_freeze", t)

    dates = [d.strftime("%Y-%m-%d") for d in cal[w0:]]
    asof = dates[-1]
    # stale: inside an open market, no bar for the last STALE_SESSIONS sessions of its market
    stale = []
    last_sess_rows = {mk: np.flatnonzero(P["open_mk"][mk].to_numpy())[-STALE_SESSIONS:] for mk in mk_info}
    for j, x in enumerate(tick):
        if x not in U.tcol:
            continue
        mk = table[x]["mkt"]
        ss = P["sessions"].get(mk)
        if ss is None or not len(ss):
            continue
        rows = last_sess_rows[mk]
        if P["has_bar"][:, j].any() and not P["has_bar"][rows, j].any():
            stale.append(x)
    stale_set = set(stale)
    est = eng.estimate_info(U, res)
    now_patch, ov_marks, n_ov = load_overrides(U, res, est)
    if n_ov:
        log(f"  overrides: {n_ov} applied to the global map")

    def est_fields(k: int, full: bool = False) -> dict:
        e = est.get(k)
        if not e:
            return {}
        if full:
            return {"est": e["now"], "estUntil": e["until"], "basis": e["basis"], "conf": e["conf"]}
        return {"est": True, "basis": e["basis"], "conf": e["conf"]} if e["now"] else {}

    now_r = [now_block_at(res, i, int(lag[i])) for i in range(U.R)]
    now_s = {x: now_block_at(res, U.tcol[x], int(lag[U.tcol[x]])) for x in U.tickers}
    for k, patch in now_patch.items():
        nb = now_r[k] if k < U.R else now_s[U.tickers[k - U.R]]
        for f, v in patch.items():
            nb[f] = eng.fnum(v, 4 if f.startswith("ret") else 1)
    t = lap("now_blocks", t)

    out.mkdir(parents=True, exist_ok=True)
    (out / "maps").mkdir(exist_ok=True)
    sizes = {"tree": 0, "maps": 0, "search": 0, "meta": 0}
    # universe extras by id
    rextra, tierset = {}, set()

    def scan(n):
        if n.get("tier"):
            tierset.add(n["id"])
        if n.get("markets"):
            rextra[n["id"]] = {"markets": n["markets"]}
        for c in n.get("children", []):
            scan(c)
    scan(uni)

    def stock_node(x: str, depth: int) -> dict:
        ti, s = U.tinfo[x], table[x]
        k = U.tcol[x]
        n = {"id": f"s:{x}", "ticker": x, "name": ti["name"], "note": ti["note"], "kind": "stock", "depth": depth,
             "tags": ti["tags"], "now": now_s[x], **est_fields(k)}
        for f in ("cap", "ccy", "mkt", "en", "pair"):
            if s.get(f) not in (None, ""):
                n[f] = s[f]
        if x in stale_set:
            n["stale"] = True
        if lag[k] > 0:
            n["closedDays"] = int(lag[k])
        if k in ov_marks:
            n["ov"] = ov_marks[k]
        return n

    # §23 real money (A股股票 ETF 申赎, 南向…) on the nodes that have it — next to, never inside, the estimate
    real = real_money_blocks({U.regions[i]["id"]: dates[len(dates) - 1 - int(lag[i])] for i in range(U.R)},
                             {U.regions[i]["id"]: now_r[i].get("flow5") for i in range(U.R)})

    def region_node(i: int) -> dict:
        r = U.regions[i]
        node = {"id": r["id"], "name": r["name"], "emoji": r["emoji"], "desc": r["desc"], "kind": "region",
                "depth": r["depth"], "tags": U.region_tags(i), "nStocks": len(r["leaf"]), "now": now_r[i],
                **est_fields(i)}
        if r["id"] in tierset:
            node["tier"] = True
        node.update(rextra.get(r["id"], {}))
        if i == 0:
            node["map"] = "global"
        if lag[i] > 0:
            node["closedDays"] = int(lag[i])
        if i in ov_marks:
            node["ov"] = ov_marks[i]
        if r["id"] in real:
            node["real"] = real[r["id"]]
        node["children"] = [region_node(c) for c in r["kids"]] if r["kids"] else \
            [stock_node(x, r["depth"] + 1) for x in r["stocks"]]
        return node

    sizes["tree"] = eng.write_json(out / "tree.json", region_node(0))
    t = lap("write_tree", t)

    # ---- maps/<id>.json, every region incl. world — fast path: each node's SERIES serialised once
    SS = series_strings(res)
    t = lap("serialise_series", t)
    written = set()
    for i, r in enumerate(U.regions):
        cols = [(U.regions[c]["id"], c) for c in r["kids"]] if r["kids"] else \
               [(f"s:{x}", U.tcol[x]) for x in r["stocks"]]
        mest = {cid: {k2: est[c][k2] for k2 in ("until", "basis", "conf")} for cid, c in cols if c in est}
        if i in est:
            mest["self"] = {k2: est[i][k2] for k2 in ("until", "basis", "conf")}
        body = ('{"id":' + json.dumps(r["id"], ensure_ascii=False) + ',"self":' + SS[i] + ',"children":{'
                + ",".join(json.dumps(cid, ensure_ascii=False) + ":" + SS[c] for cid, c in cols) + "}"
                + ((',"est":' + json.dumps(mest, ensure_ascii=False, separators=(",", ":"))) if mest else "") + "}")
        p = out / "maps" / (r["id"].replace(":", "_") + ".json")
        sizes["maps"] += write_text(p, body)
        written.add(p)
    removed = 0
    for p in (out / "maps").glob("*.json"):
        if p not in written:
            p.unlink()
            removed += 1
    for p in (out / "maps").glob("*.tmp"):
        p.unlink()
    t = lap("write_maps", t)

    # ---- search.json (regions + stocks; + en / mkt so English and market search work)
    search = []
    for r in U.regions:
        search.append({"id": r["id"], "name": r["name"], "emoji": r["emoji"], "kind": "region",
                       "path": r["pathNames"], "pathIds": r["pathIds"]})
    for x in U.tickers:
        ti, s = U.tinfo[x], table[x]
        e = {"id": f"s:{x}", "name": ti["name"], "ticker": x, "note": ti["note"], "kind": "stock",
             "path": ti["pathNames"][0], "pathIds": ti["paths"][0]}
        if s.get("en") and s["en"] != ti["name"]:
            e["en"] = s["en"]
        e["mkt"] = s.get("mkt")
        search.append(e)
    sizes["search"] = eng.write_json(out / "search.json", search)

    # ---- meta.json
    used_tags = set()
    for x in U.tickers:
        used_tags.update(U.tinfo[x]["tags"])
    fa = fetched_at(fstats)
    nowl = datetime.now().astimezone()
    mk_meta, pending = {}, []
    n_by_mk = {}
    for x in U.tickers:
        n_by_mk[table[x]["mkt"]] = n_by_mk.get(table[x]["mkt"], 0) + 1
    for mk, m in mk_info.items():
        ss = P["sessions"].get(mk)
        lsess = str(ss[-1].date()) if ss is not None and len(ss) else None
        state = "current"
        if lsess is None:
            state = "nodata"
        elif lsess < asof:
            lc = G.last_close(m, nowl)
            f = fa.get(mk)
            # the market's session on the last calendar day either has not closed / not been fetched yet, or was a holiday
            if lc.date().isoformat() < asof or f is None or f < lc:
                state = "pending"
                pending.append(mk)
            else:
                state = "closed"     # fetched after its close but no bars: a holiday, or Yahoo has not published yet
        mk_meta[mk] = {"name": m.get("name"), "tz": m.get("tz"), "close": m.get("close"), "node": m.get("node"),
                       "region": m.get("region"), "currency": m.get("currency"), "nStocks": n_by_mk.get(mk, 0),
                       "lastSession": lsess, "state": state,
                       "fetchedAt": fa[mk].isoformat(timespec="seconds") if mk in fa else None,
                       "nextClose": G.next_close(m, nowl).isoformat(timespec="minutes")}
    fxl = P["fxw"].iloc[-1]
    meta = {
        "asOf": asof, "generatedAt": datetime.now().isoformat(timespec="seconds"), "dates": dates,
        "tags": {k: v for k, v in eng.TAG_LABELS.items() if k in used_tags},
        "atmosphere": align_atmosphere(dates),
        "mode": "global", "map": "global", "label": "全球", "partial": None,
        "estimates": [U.regions[k]["id"] if k < U.R else f"s:{U.tickers[k - U.R]}"
                      for k, e in sorted(est.items()) if e["now"]],
        "stale": sorted(stale_set), "nStocks": U.N, "nRegions": U.R,
        "markets": mk_meta, "pending": pending,
        "say": ("还没收盘的市场先显示上一个收盘日的天气：" + "、".join(mk_info[m]["name"] for m in pending)) if pending else
               "所有市场都是最新收盘的数据。",
        "fx": {"asOf": str(P["fxw"].index[-1].date()),
               "usdPer": {c: round(float(fxl[c]), 8) for c in sorted(P["fxw"].columns) if np.isfinite(fxl[c])}},
        "currency": "USD",
        "real": {"nodes": sorted(real), "source": "web/data/flows/china.json (est:false)",
                 "say": "真钱 = 交易所公布的 ETF 份额变化、港股通净买入；风和流向仍是按价格和成交额估的（§2）"} if real else None,
    }
    sizes["meta"] = eng.write_json(out / "meta.json", meta)
    t = lap("write_search_meta", t)

    # ---- series_gl.npz for stockfile.py / candidates_global.py
    N = U.N
    jcol = np.array([tpos[x] for x in U.tickers])
    info, facts = {}, np.full((N, len(FACT_KEYS)), np.nan)
    nb = eng.PROFILE_BINS
    prof = {k: np.full((N, nb), np.nan) for k in ("bins", "buy", "sell")}
    prof_lo, prof_hi = np.full(N, np.nan), np.full(N, np.nan)
    dv20_s = {x: (now_s[x]["dv20"] or 0.0) for x in U.tickers}
    nn = lambda v: np.nan if v is None else v  # noqa: E731
    for j, x in enumerate(U.tickers):
        k = U.tcol[x]
        ti, s = U.tinfo[x], table[x]
        peers = []
        for pl in ti["places"]:
            for t2 in U.regions[pl]["stocks"]:
                if t2 != x and t2 not in peers:
                    peers.append(t2)
        peers.sort(key=lambda y: -dv20_s.get(y, 0))
        d = {"name": ti["name"], "note": ti["note"], "paths": ti["paths"], "peers": [f"s:{y}" for y in peers[:8]],
             "ccy": s.get("ccy"), "mkt": s.get("mkt"), "en": s.get("en"), "cap": s.get("cap"), "pair": s.get("pair"),
             "country": s.get("country"), "ex": s.get("ex")}
        d = {kk: vv for kk, vv in d.items() if vv not in (None, "")}
        d.update(est_fields(k, full=True))
        if k in ov_marks:
            d["ov"] = ov_marks[k]
        if x in stale_set:
            d["stale"] = True
        info[x] = d
        end = T - 1 - int(lag[k])
        fxs = stock_facts(res, j, now_s[x]["dv20"], end, w0)
        facts[j] = [nn(fxs[key]) for key in FACT_KEYS]
        e1 = end + 1
        pr = eng.volume_profile(res["H"][:e1, j], res["L"][:e1, j], res["C"][:e1, j],
                                np.nan_to_num(res["C"][:e1, j] * Vr[:e1, j]), res["push"][:e1, j])
        if pr and pr.get("bins"):
            prof_lo[j], prof_hi[j] = nn(pr["lo"]), nn(pr["hi"])
            prof["bins"][j] = [nn(v) for v in pr["bins"]]
            prof["buy"][j] = [nn(v) for v in pr["buy"]]
            prof["sell"][j] = [nn(v) for v in pr["sell"]]
    sl = slice(w0, None)
    alive_px = np.isfinite(res["C"][sl])
    hb = P["has_bar"][sl][:, jcol]
    f32 = lambda v: np.asarray(v, dtype=np.float32)  # noqa: E731
    npz_bytes = save_npz(
        Path(a.npz),
        version=np.array(NPZ_VERSION), asOf=np.array(asof), generatedAt=np.array(meta["generatedAt"]),
        dates=np.array(dates), ids=np.array([r["id"] for r in U.regions] + [f"s:{x}" for x in U.tickers]),
        tick=np.array(U.tickers), nRegions=np.array(U.R), par=np.asarray(U.par, dtype=np.int32),
        wind=f32(res["wind"]), temp=f32(res["temp"]), pres=f32(res["pres"]), storm=f32(res["storm"]),
        front=np.nan_to_num(res["front"]).astype(np.int8), idx=f32(res["idx"]),
        flow=np.asarray(res["flow"], np.float64), dv=np.asarray(res["dv"], np.float64),
        lag=lag.astype(np.int16), openW=ow.astype(np.bool_),
        px_o=np.where(alive_px, res["O"][sl], np.nan), px_h=np.where(alive_px, res["H"][sl], np.nan),
        px_l=np.where(alive_px, res["L"][sl], np.nan), px_c=res["C"][sl].copy(),
        px_v=np.where(alive_px, Vr[sl][:, jcol], np.nan),
        hasBar=hb.astype(np.bool_),
        fx=f32(P["fx_cal"][sl][:, jcol]), c_local=P["Clocal"][sl][:, jcol],
        facts=facts, factKeys=np.array(FACT_KEYS),
        prof_lo=prof_lo, prof_hi=prof_hi, prof_bins=prof["bins"], prof_buy=prof["buy"], prof_sell=prof["sell"],
        info=np.array(json.dumps(info, ensure_ascii=False, separators=(",", ":"))),
    )
    t = lap("write_npz", t)

    default_out = out == G.WEB.resolve() and Path(a.npz).resolve() == G.NPZ.resolve()
    # static stocks/<T>.json are only fallbacks (radar stocks, symbols the server's pattern rejects); the npz just
    # changed and server.py prefers a static file, so drop them now — candidates_global.py writes fresh ones
    if default_out and (out / "stocks").exists():
        for p in (out / "stocks").glob("*.json"):
            p.unlink()
    if default_out and not a.no_candidates:
        try:
            import candidates_global as cg
            rc = cg.main([])
            if rc:
                log(f"  WARNING: candidates_global exited {rc}")
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: candidates_global failed ({type(e).__name__}: {e})")
        t = lap("candidates", t)
    if default_out and not a.no_brief and (ROOT / "pipeline" / "brief.py").exists():
        try:
            r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "brief.py"), "--data", str(out), "--no-fm",
                                "--no-gl"], cwd=str(ROOT), capture_output=True, text=True, timeout=600)
            if r.returncode:
                log(f"  WARNING: brief for the global map exited {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: brief for the global map failed ({type(e).__name__}: {e})")
        t = lap("brief", t)

    TIMES["wall_total"] = round(time.perf_counter() - T0, 2)
    stats = {
        "asOf": asof, "generatedAt": meta["generatedAt"], "unionDays": len(cal), "window": W,
        "regionNodes": U.R, "stockNodes": U.N, "allNodes": U.K, "noPrices": nodata, "stale": sorted(stale_set),
        "estimatesNow": len(meta["estimates"]), "estimatedSomeDays": len(est), "overridesApplied": n_ov,
        "pending": pending, "markets": {mk: {k2: v[k2] for k2 in ("lastSession", "state", "nStocks")}
                                         for mk, v in mk_meta.items()},
        "prep": P["info"],
        "nullShareLastDay": {k: round(float(np.isnan(res[k][-1]).mean()), 4) for k in ("wind", "temp", "pres", "storm")},
        "frontsLastDay": int(np.abs(np.nan_to_num(res["front"][-1])).sum()),
        "bytes": {**sizes, "npz": npz_bytes, "mapsFiles": len(written), "mapsRemoved": removed},
        "timings_s": TIMES,
    }
    sp = G.COMPUTE_STATS if default_out else Path(a.npz).with_name("compute_stats_test.json")
    sp.parent.mkdir(parents=True, exist_ok=True)
    sp.write_text(json.dumps(stats, indent=1, ensure_ascii=False), encoding="utf-8")
    log(f"  wrote {out}: tree {sizes['tree'] / 1e6:.2f} MB, {len(written)} maps {sizes['maps'] / 1e6:.1f} MB, "
        f"search {sizes['search'] / 1e6:.2f} MB; npz {npz_bytes / 1e6:.1f} MB"
        + (f"; removed {removed} old map file(s)" if removed else ""))
    log(f"  asOf {asof}, window {dates[0]} → {dates[-1]}; pending {pending or '-'}; stale {len(stale_set)}, "
        f"no prices {len(nodata)}, estimated now {len(meta['estimates'])}; done in {TIMES['wall_total']:.1f}s")
    if not a.quiet:
        f = lambda v, nd=2: "-" if v is None else f"{v:.{nd}f}"  # noqa: E731
        log(f"  {'node':<12}{'n':>6}{'wind':>7}{'temp':>7}{'pres':>6}{'storm':>7}{'ret5':>8}{'flow5$M':>10}{'dv20$M':>10}")
        show = [0] + U.regions[0]["kids"] + [U.rcol[m["node"]] for m in mk_info.values() if m.get("node") in U.rcol]
        for i in dict.fromkeys(show):
            n = now_r[i]
            r5 = n["ret5"] * 100 if n["ret5"] is not None else None
            log(f"  {U.regions[i]['name']:<12}{len(U.regions[i]['leaf']):>6}{f(n['wind']):>7}{f(n['temp']):>7}"
                f"{f(n['pres'], 0):>6}{f(n['storm']):>7}{f(r5, 1):>7}%{f(n['flow5'], 0):>10}{f(n['dv20'], 0):>10}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
