#!/usr/bin/env python3
"""compute_full.py — full-market weather → web/data/fm/  (DESIGN.md §2 metrics, §3 files, §14, §19 map:'full')

    python3 fullmarket/compute_full.py              # ~50 s, ~2.5 GB peak RAM
    python3 fullmarket/compute_full.py --quiet      # no summary table
    python3 fullmarket/compute_full.py --out DIR --npz FILE    # write somewhere else (tests)
    (then, by default: attention_candidates.py → web/data/fm/candidates.json, and pipeline/brief.py --data web/data/fm
     → web/data/fm/brief.json; --no-candidates / --no-brief skip them; --write is accepted and ignored)

Reads  fullmarket/universe_full.json            the full-market tree (fm-world → 11 sectors → industries → tiers → stocks)
       fullmarket/cache/prices_full.parquet     long OHLCV from fetch_full.py (+ cache/fetch_stats.json: when it was fetched)
       web/data/meta.json                       (optional) the gauges (VIX / 10y / DXY) are copied from it, date-aligned
       web/data/overrides.json                  (optional) §14 owner corrections — "s:<T>" targets apply to both maps
Writes web/data/fm/tree.json, maps/<id>.json, search.json, meta.json — exactly the §3 shapes of the curated map, so the
       frontend swaps its data root (data/ ↔ data/fm/) and nothing else changes. The root id is "world" (name 全市场);
       every other region id is prefixed "fm-"; stock ids stay "s:<TICKER>".
       fullmarket/out/series_full.npz           every node's window series + per-stock prices/facts/profile/peers, read
                                                by stockfile.py (lazy /data/fm/stocks/<T>.json) and attention_candidates.py
       fullmarket/out/compute_stats.json        timings, sizes, stale tickers, estimates

The weather math is NOT re-implemented: it imports pipeline/compute.py (Universe, compute, estimate_info, apply_overrides,
series, now_block, volume_profile, write_json) so wind/temp/pres/estimates mean exactly the same thing on both maps.
stocks/<T>.json are not written here (3,300 × 20 KB); the server builds them on demand from the npz (see README.md).

Extras on top of the §3 shapes (safe to ignore):
  tree root:          "map": "full"
  tree region nodes:  "tier": true on cap-tier sub-industries (e.g. 小型银行) — attention folds them into their parent
  tree stock nodes:   "cap" (market cap, USD bn); "stale": true when the ticker stopped returning prices
  §14 estimates:      same fields as the curated map (node est/basis/conf, map "est": {childId: {until, basis, conf}})
  meta.json:          "map": "full", "label", "stale": [tickers], "estimates": [ids]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import warnings
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "pipeline"))
try:
    import compute as eng  # pipeline/compute.py — the one implementation of DESIGN §2 / §14
except Exception as e:  # noqa: BLE001
    raise SystemExit(f"compute_full: cannot import pipeline/compute.py ({type(e).__name__}: {e})")

UNIVERSE = HERE / "universe_full.json"
PRICES = HERE / "cache" / "prices_full.parquet"
FETCH_STATS = HERE / "cache" / "fetch_stats.json"
NPZ = HERE / "out" / "series_full.npz"
STATS = HERE / "out" / "compute_stats.json"
OUT = ROOT / "web" / "data" / "fm"
CURATED = ROOT / "web" / "data"
NY = ZoneInfo("America/New_York")
ROOT_ID = "world"                       # the frontend's root id; the universe file calls it fm-world
FACT_KEYS = ["last", "dv20", "flow5", "flow20", "flow5Avg", "ret1", "ret5", "ret20", "ret60", "high52", "low52"]
NPZ_VERSION = 1

warnings.filterwarnings("ignore", category=RuntimeWarning)
T0 = time.perf_counter()
TIMES: dict[str, float] = {}


def lap(name: str, t: float) -> float:
    TIMES[name] = round(time.perf_counter() - t, 2)
    return time.perf_counter()


def log(*a) -> None:
    print(*a, flush=True)


# ------------------------------------------------------------------------------------------------ prices
def fetched_at_ny() -> datetime | None:
    """When fetch_full.py last downloaded (America/New_York), from cache/fetch_stats.json."""
    try:
        s = json.loads(FETCH_STATS.read_text())["fetchedAt"]
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.astimezone()          # old stats files: naive local time
        return d.astimezone(NY)
    except Exception:  # noqa: BLE001
        return None


def load_prices(tickers: list[str], path: Path = PRICES):
    """parquet (date,t,o,h,l,c,v) → (cal, avail, px{Open..Volume: DataFrame cal × tickers}, stale, info).
    Same conventions as pipeline/compute.load_prices: SPY trading days, a still-trading session is dropped,
    prices forward-filled, volume 0 on missing days, O/H/L = carried close on gap days, and tickers without
    any price data keep an all-NaN column (they become §14 estimates instead of vanishing)."""
    df = pd.read_parquet(path)
    df["t"] = df["t"].astype(str)
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    df = df.drop_duplicates(["date", "t"], keep="last")
    spy = df[df.t == "SPY"].set_index("date").sort_index()
    if spy.empty:
        raise SystemExit("compute_full: SPY missing from the price cache — run fullmarket/fetch_full.py")
    cal = spy.index[spy["c"].notna() & (spy["v"] > 0)]
    info = {"partialDropped": None}
    last = cal[-1].date()
    now = datetime.now(NY)
    f = fetched_at_ny()
    partial = (last == now.date() and now.hour * 60 + now.minute < 16 * 60 + 15) or \
              (f is not None and f.date() == last and f.hour * 60 + f.minute < 16 * 60 + 15)
    if partial:
        info["partialDropped"] = str(last)
        log(f"  dropping partial session {last} (market not closed when fetched)")
        cal = cal[:-1]
    cal = pd.DatetimeIndex(cal)
    F = {}
    for name, k in (("Open", "o"), ("High", "h"), ("Low", "l"), ("Close", "c"), ("Volume", "v")):
        F[name] = df.pivot(index="date", columns="t", values=k).reindex(cal)
    del df
    cols = list(dict.fromkeys(tickers))
    raw_close = F["Close"].reindex(columns=cols)
    has = raw_close.notna().any(axis=0)
    avail = [t for t in cols if has[t]]
    px = {}
    for name in ("Open", "High", "Low", "Close"):
        px[name] = F[name].reindex(columns=cols).ffill()
    px["Volume"] = F["Volume"].reindex(columns=cols).fillna(0.0)
    gap = raw_close.isna() & px["Close"].notna()
    for name in ("Open", "High", "Low"):
        px[name] = px[name].mask(gap, px["Close"]).fillna(px["Close"])
    # stale = had prices before, but none in the last 3 sessions (renamed / delisted / Yahoo hiccup)
    tail = raw_close.iloc[-3:].notna().any(axis=0)
    stale = sorted(t for t in avail if not tail[t])
    return cal, avail, px, stale, info


# ------------------------------------------------------------------------------------------------ tree
def load_universe() -> dict:
    root = dict(json.loads(UNIVERSE.read_text(encoding="utf-8")))
    root["id"] = ROOT_ID
    root.pop("source", None)
    return root


def tickers_of(root: dict) -> list[str]:
    out = []

    def walk(n):
        for s in n.get("stocks", []):
            out.append(s["t"])
        for c in n.get("children", []):
            walk(c)
    walk(root)
    return list(dict.fromkeys(out))


def tier_ids(root: dict) -> set[str]:
    """cap-tier sub-industries: '<parent>-t<N>' directly under <parent>."""
    out = set()

    def walk(n):
        for c in n.get("children", []):
            if c["id"].startswith(n["id"] + "-t") and c["id"][len(n["id"]) + 2:].isdigit():
                out.add(c["id"])
            walk(c)
    walk(root)
    return out


def stock_caps(root: dict) -> dict[str, float]:
    caps = {}

    def walk(n):
        for s in n.get("stocks", []):
            if isinstance(s.get("cap"), (int, float)):
                caps[s["t"]] = round(float(s["cap"]), 1)
        for c in n.get("children", []):
            walk(c)
    walk(root)
    return caps


# ------------------------------------------------------------------------------------------------ helpers
def stock_facts(res: dict, j: int, dv20: float | None, sl: slice) -> dict:
    """the §3 stocks/<T>.json "facts" block — same definitions as pipeline/compute.py main()."""
    C, H, L = res["C"][:, j], res["H"][:, j], res["L"][:, j]
    mf = res["MF"][:, j] / 1e6
    alive = np.isfinite(C)

    def cret(n):
        if len(C) > n and np.isfinite(C[-1]) and np.isfinite(C[-1 - n]) and C[-1 - n] > 0:
            return eng.fnum(C[-1] / C[-1 - n] - 1, 4)
        return None

    f5 = pd.Series(np.nan_to_num(mf)).rolling(5).sum().to_numpy()[sl]
    f5 = f5[alive[sl]]
    Hw, Lw = H[sl], L[sl]
    return {
        "last": eng.price(C[-1]),
        "dv20": dv20,
        "flow5": eng.fnum(np.nansum(mf[-5:]), 2),
        "flow20": eng.fnum(np.nansum(mf[-20:]), 2),
        "flow5Avg": eng.fnum(np.nanmean(np.abs(f5)) if len(f5) else 0.0, 2),
        "ret1": cret(1), "ret5": cret(5), "ret20": cret(20), "ret60": cret(60),
        "high52": eng.price(np.nanmax(Hw) if np.isfinite(Hw).any() else np.nan),
        "low52": eng.price(np.nanmin(Lw) if np.isfinite(Lw).any() else np.nan),
    }


def align_atmosphere(dates: list[str]) -> list:
    """Copy the curated map's gauges (VIX / 10y / DXY), re-indexed onto the full-market dates."""
    try:
        cm = json.loads((CURATED / "meta.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    pos = {d: i for i, d in enumerate(cm.get("dates") or [])}
    out = []
    for a in cm.get("atmosphere") or []:
        s = a.get("series") or []
        b = dict(a)
        b["series"] = [s[pos[d]] if d in pos and pos[d] < len(s) else None for d in dates]
        out.append(b)
    return out


def load_overrides(U, res, est):
    """§14 owner corrections from the shared web/data/overrides.json (never created from here)."""
    path = Path(os.environ.get("MW_OVERRIDES_PATH") or (CURATED / "overrides.json"))
    if not path.exists() or not hasattr(eng, "apply_overrides"):
        return {}, {}, 0
    try:
        try:
            import owner_overrides as ovmod  # pipeline/owner_overrides.py (the same module compute.py uses)
        except ImportError:
            import overrides as ovmod  # older name; a pip package of that name has no effective()
        if not hasattr(ovmod, "effective"):
            return {}, {}, 0
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
    os.replace(tmp, path)            # atomic: a server that has the old file open keeps reading the old inode
    return path.stat().st_size


# ------------------------------------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(OUT), help="output dir for the JSON (default web/data/fm)")
    ap.add_argument("--npz", default=str(NPZ), help="series file (default fullmarket/out/series_full.npz)")
    ap.add_argument("--prices", default=str(PRICES))
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--write", action="store_true", help="(accepted for old callers; output is always written)")
    ap.add_argument("--no-candidates", action="store_true", help="skip attention_candidates.py (全市场雷达)")
    ap.add_argument("--no-brief", action="store_true", help="skip the full map's own brief (pipeline/brief.py --data)")
    a = ap.parse_args()
    out = Path(a.out).resolve()

    t = time.perf_counter()
    root = load_universe()
    all_t = tickers_of(root)
    tiers = tier_ids(root)
    caps = stock_caps(root)
    cal, avail, px, stale, pinfo = load_prices(all_t, Path(a.prices))
    t = lap("load_prices", t)
    U = eng.Universe(root, set(all_t))
    nodata = sorted(set(all_t) - set(avail))
    if nodata:
        log(f"  {len(nodata)} ticker(s) without price data (kept on the map as estimates): "
            f"{' '.join(nodata[:30])}{' …' if len(nodata) > 30 else ''}")
    log(f"compute_full: {U.R} regions, {U.N} stocks, {len(cal)} trading days ({cal[0].date()} → {cal[-1].date()})")
    t = lap("universe", t)
    res = eng.compute(U, px, cal)
    del px
    t = lap("compute", t)

    W, w0 = res["W"], res["w0"]
    sl = slice(w0, None)
    dates = [d.strftime("%Y-%m-%d") for d in cal[w0:]]
    asof = dates[-1]
    stale_set = set(stale) & set(U.tickers)
    est = eng.estimate_info(U, res) if hasattr(eng, "estimate_info") else {}
    now_patch, ov_marks, n_ov = load_overrides(U, res, est)
    if n_ov:
        log(f"  overrides: {n_ov} applied to the full-market map")

    def est_fields(k: int, full: bool = False) -> dict:
        e = est.get(k)
        if not e:
            return {}
        if full:
            return {"est": e["now"], "estUntil": e["until"], "basis": e["basis"], "conf": e["conf"]}
        return {"est": True, "basis": e["basis"], "conf": e["conf"]} if e["now"] else {}

    now_r = [eng.now_block(res, i) for i in range(U.R)]
    now_s = {x: eng.now_block(res, U.tcol[x]) for x in U.tickers}
    for k, patch in now_patch.items():
        nb = now_r[k] if k < U.R else now_s[U.tickers[k - U.R]]
        for f, v in patch.items():
            nb[f] = eng.fnum(v, 4 if f.startswith("ret") else 1)
    t = lap("now_blocks", t)

    out.mkdir(parents=True, exist_ok=True)
    (out / "maps").mkdir(exist_ok=True)
    sizes = {"tree": 0, "maps": 0, "search": 0, "meta": 0}

    # ---- tree.json
    def stock_node(x: str, depth: int) -> dict:
        ti = U.tinfo[x]
        k = U.tcol[x]
        n = {"id": f"s:{x}", "ticker": x, "name": ti["name"], "note": ti["note"], "kind": "stock",
             "depth": depth, "tags": ti["tags"], "now": now_s[x], **est_fields(k)}
        if x in caps:
            n["cap"] = caps[x]
        if x in stale_set:
            n["stale"] = True
        if k in ov_marks:
            n["ov"] = ov_marks[k]
        return n

    def region_node(i: int) -> dict:
        r = U.regions[i]
        node = {"id": r["id"], "name": r["name"], "emoji": r["emoji"], "desc": r["desc"], "kind": "region",
                "depth": r["depth"], "tags": U.region_tags(i), "nStocks": len(r["leaf"]), "now": now_r[i],
                **est_fields(i)}
        if r["id"] in tiers:
            node["tier"] = True
        if i == 0:
            node["map"] = "full"
        if i in ov_marks:
            node["ov"] = ov_marks[i]
        if r["kids"]:
            node["children"] = [region_node(c) for c in r["kids"]]
        else:
            node["children"] = [stock_node(x, r["depth"] + 1) for x in r["stocks"]]
        return node

    sizes["tree"] = eng.write_json(out / "tree.json", region_node(0))
    t = lap("write_tree", t)

    # ---- maps/<id>.json (every region incl. world)
    written = set()
    for i, r in enumerate(U.regions):
        cols = [(U.regions[c]["id"], c) for c in r["kids"]] if r["kids"] else \
               [(f"s:{x}", U.tcol[x]) for x in r["stocks"]]
        mobj = {"id": r["id"], "self": eng.series(res, i), "children": {cid: eng.series(res, c) for cid, c in cols}}
        mest = {cid: {k2: est[c][k2] for k2 in ("until", "basis", "conf")} for cid, c in cols if c in est}
        if i in est:
            mest["self"] = {k2: est[i][k2] for k2 in ("until", "basis", "conf")}
        if mest:
            mobj["est"] = mest
        p = out / "maps" / (r["id"].replace(":", "_") + ".json")
        sizes["maps"] += eng.write_json(p, mobj)
        written.add(p)
    removed = 0
    for p in (out / "maps").glob("*.json"):
        if p not in written:
            p.unlink()
            removed += 1
    for p in (out / "maps").glob("*.tmp"):
        p.unlink()
    t = lap("write_maps", t)

    # ---- search.json (regions + stocks, same shape as the curated one)
    search = []
    for r in U.regions:
        search.append({"id": r["id"], "name": r["name"], "emoji": r["emoji"], "kind": "region",
                       "path": r["pathNames"], "pathIds": r["pathIds"]})
    for x in U.tickers:
        ti = U.tinfo[x]
        search.append({"id": f"s:{x}", "name": ti["name"], "ticker": x, "note": ti["note"], "kind": "stock",
                       "path": ti["pathNames"][0], "pathIds": ti["paths"][0]})
    sizes["search"] = eng.write_json(out / "search.json", search)

    # ---- meta.json (same shape as the curated meta; atmosphere copied from it, date-aligned)
    used_tags = set()
    for x in U.tickers:
        used_tags.update(U.tinfo[x]["tags"])
    meta = {
        "asOf": asof,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "dates": dates,
        "tags": {k: v for k, v in eng.TAG_LABELS.items() if k in used_tags},
        "atmosphere": align_atmosphere(dates),
        "mode": "fullmarket",
        "map": "full",
        "label": "全市场",
        "partial": None,
        "estimates": [U.regions[k]["id"] if k < U.R else f"s:{U.tickers[k - U.R]}"
                      for k, e in sorted(est.items()) if e["now"]],
        "stale": sorted(stale_set),
        "nStocks": U.N,
        "nRegions": U.R,
    }
    sizes["meta"] = eng.write_json(out / "meta.json", meta)
    t = lap("write_search_meta", t)

    # ---- series_full.npz: everything stockfile.py / attention_candidates.py need, no JSON re-parsing
    tick = U.tickers
    N = len(tick)
    dv20_s = {x: (now_s[x]["dv20"] or 0.0) for x in tick}
    info = {}
    facts = np.full((N, len(FACT_KEYS)), np.nan)
    nb = eng.PROFILE_BINS
    prof_lo, prof_hi = np.full(N, np.nan), np.full(N, np.nan)
    prof_bins = np.full((N, nb), np.nan)
    prof_buy = np.full((N, nb), np.nan)
    prof_sell = np.full((N, nb), np.nan)
    nn = lambda v: np.nan if v is None else v  # noqa: E731
    for j, x in enumerate(tick):
        k = U.tcol[x]
        ti = U.tinfo[x]
        peers = []
        for pl in ti["places"]:
            for t2 in U.regions[pl]["stocks"]:
                if t2 != x and t2 not in peers:
                    peers.append(t2)
        peers.sort(key=lambda y: -dv20_s.get(y, 0))
        d = {"name": ti["name"], "note": ti["note"], "paths": ti["paths"], "peers": [f"s:{y}" for y in peers[:8]]}
        d.update(est_fields(k, full=True))
        if k in ov_marks:
            d["ov"] = ov_marks[k]
        info[x] = d
        fx = stock_facts(res, j, now_s[x]["dv20"], sl)
        facts[j] = [nn(fx[key]) for key in FACT_KEYS]
        pr = eng.volume_profile(res["H"][:, j], res["L"][:, j], res["C"][:, j], res["DV"][:, j], res["push"][:, j])
        if pr and pr.get("bins"):
            prof_lo[j], prof_hi[j] = nn(pr["lo"]), nn(pr["hi"])
            prof_bins[j] = [nn(v) for v in pr["bins"]]
            prof_buy[j] = [nn(v) for v in pr["buy"]]
            prof_sell[j] = [nn(v) for v in pr["sell"]]
    alive_px = np.isfinite(res["C"][sl])
    f32 = lambda v: np.asarray(v, dtype=np.float32)  # noqa: E731
    npz_bytes = save_npz(
        Path(a.npz),
        version=np.array(NPZ_VERSION), asOf=np.array(asof), generatedAt=np.array(meta["generatedAt"]),
        dates=np.array(dates), ids=np.array([r["id"] for r in U.regions] + [f"s:{x}" for x in tick]),
        tick=np.array(tick), nRegions=np.array(U.R), par=np.asarray(U.par, dtype=np.int32),
        wind=f32(res["wind"]), temp=f32(res["temp"]), pres=f32(res["pres"]), storm=f32(res["storm"]),
        front=np.nan_to_num(res["front"]).astype(np.int8), idx=f32(res["idx"]),
        flow=np.asarray(res["flow"], np.float64), dv=np.asarray(res["dv"], np.float64),   # money + prices in float64:
        px_o=np.where(alive_px, res["O"][sl], np.nan), px_h=np.where(alive_px, res["H"][sl], np.nan),  # stock files
        px_l=np.where(alive_px, res["L"][sl], np.nan), px_c=res["C"][sl].copy(),            # match the curated ones
        px_v=np.where(alive_px, res["V"][sl], np.nan),
        facts=facts, factKeys=np.array(FACT_KEYS),
        prof_lo=prof_lo, prof_hi=prof_hi, prof_bins=prof_bins, prof_buy=prof_buy, prof_sell=prof_sell,
        info=np.array(json.dumps(info, ensure_ascii=False, separators=(",", ":"))),
    )
    t = lap("write_npz", t)
    # static stock files under <out>/stocks/ are only fallbacks for the radar's stocks; the npz just changed, so
    # drop them now (attention_candidates.py writes fresh ones) — server.py prefers a static file over the npz
    for p in (out / "stocks").glob("*.json") if (out / "stocks").exists() else []:
        p.unlink()

    # the radar (web/data/fm/candidates.json, read by pipeline/brief.py) and the full map's own brief.json
    default_out = out == OUT.resolve() and Path(a.npz).resolve() == NPZ.resolve()
    if default_out and not a.no_candidates:
        try:
            sys.path.insert(0, str(HERE))
            import attention_candidates as ac
            rc = ac.main([])
            TIMES["candidates"] = round(time.perf_counter() - t, 2)
            if rc:
                log(f"  WARNING: attention_candidates exited {rc}")
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: attention_candidates failed ({type(e).__name__}: {e})")
        t = time.perf_counter()
    if not a.no_brief and (ROOT / "pipeline" / "brief.py").exists():
        import subprocess
        try:
            r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "brief.py"), "--data", str(out), "--no-fm"],
                               cwd=str(ROOT), capture_output=True, text=True, timeout=300)
            if r.returncode:
                log(f"  WARNING: brief for the full map exited {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: brief for the full map failed ({type(e).__name__}: {e})")
        t = lap("brief", t)

    TIMES["wall_total"] = round(time.perf_counter() - T0, 2)
    stats = {
        "asOf": asof, "generatedAt": meta["generatedAt"], "tradingDays": len(cal), "window": W,
        "regionNodes": U.R, "stockNodes": U.N, "allNodes": U.K,
        "noPrices": nodata, "stale": sorted(stale_set),
        "estimatesNow": meta["estimates"], "estimatedSomeDays": len(est),
        "overridesApplied": n_ov, "partialDropped": pinfo.get("partialDropped"),
        "nullShareLastDay": {k: round(float(np.isnan(res[k][-1]).mean()), 4) for k in ("wind", "temp", "pres", "storm")},
        "frontsLastDay": int(np.abs(np.nan_to_num(res["front"][-1])).sum()),
        "bytes": {**sizes, "npz": npz_bytes, "mapsFiles": len(written), "mapsRemoved": removed},
        "timings_s": TIMES,
    }
    STATS.parent.mkdir(parents=True, exist_ok=True)
    STATS.write_text(json.dumps(stats, indent=1, ensure_ascii=False))
    log(f"  wrote {out}: tree {sizes['tree'] / 1e6:.2f} MB, {len(written)} maps {sizes['maps'] / 1e6:.1f} MB, "
        f"search {sizes['search'] / 1e6:.2f} MB; npz {npz_bytes / 1e6:.1f} MB"
        + (f"; removed {removed} stale map file(s)" if removed else ""))
    log(f"  asOf {asof}, window {dates[0]} → {dates[-1]}; stale {len(stale_set)}, estimated now "
        f"{len(meta['estimates'])} (some days {len(est)}); done in {TIMES['wall_total']:.1f}s")
    if not a.quiet:
        f = lambda v, nd=2: "-" if v is None else f"{v:.{nd}f}"  # noqa: E731
        log(f"  {'sector':<10}{'n':>6}{'wind':>7}{'temp':>7}{'pres':>6}{'storm':>7}{'ret5':>8}{'flow5$M':>10}")
        for i in [0] + U.regions[0]["kids"]:
            n = now_r[i]
            r5 = n["ret5"] * 100 if n["ret5"] is not None else None
            log(f"  {U.regions[i]['name']:<10}{len(U.regions[i]['leaf']):>6}{f(n['wind']):>7}{f(n['temp']):>7}"
                f"{f(n['pres'], 0):>6}{f(n['storm']):>7}{f(r5, 1):>7}%{f(n['flow5'], 0):>10}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
