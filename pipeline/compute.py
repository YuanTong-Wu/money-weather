#!/usr/bin/env python3
"""compute.py — cached prices → weather numbers → web/data/*.json (DESIGN.md §2 metrics, §3 files).

    python3 pipeline/compute.py

Reads universe/universe.json + cache/prices.pkl, writes web/data/{meta,tree,search}.json,
web/data/maps/<id>.json (every region incl. world) and web/data/stocks/<TICKER>.json.
Never touches web/data/brief.json (pipeline/brief.py owns it).

Everything is vectorised over a (days × nodes) matrix: nodes = all regions (world, continents, regions)
followed by all unique stocks. Robust z-scores use a trailing 252-day window (expanding while shorter,
minimum 60 valid values), z = (x − median) / max(1.4826·MAD, 0.25·std), clipped to ±3.
Root node `world` has no parent, so its wind = z(flow5) and its temp = z(ret20).

§14 宁可估，不可空: a stock with too little history of its own (< 60 values) is measured against its peers'
pooled trailing values (conf 0.5); anything still missing borrows its parent's weather pulled 30 % toward
calm (conf 0.3; no price data at all: 0.2). Estimates are flagged in tree nodes (`est`, `basis`, `conf`),
map files (`est: {childId: {until, basis, conf}}`), stock files (`est`, `estUntil`, `basis`, `conf`) and
meta.estimates. Owner corrections from web/data/overrides.json are applied last (pipeline/owner_overrides.py).
    --live   keep today's still-forming bar (update.sh --quick during market hours; meta.partial says so).
             Its volume is scaled to a full-day estimate first (U-shaped intraday curve, pipeline/session.py),
             so a 15-minute refresh never reads half a day of trading as "money is leaving";
             meta.intraday = {date, asOf, etTime, localTime, fraction, scaled, scaleMedian, nScaled, method, say},
             stock files get intraday = {date, etTime, fraction, vSoFar, vEst} (their `v` stays what traded so far).
§20: stocks marked `holding` in universe.json (the owner's holdings) carry `holding: true` in tree/search/stock
files, and meta.holdings lists their ids.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import pickle
import sys
import time
import warnings
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))  # pipeline/owner_overrides.py
UNIVERSE = ROOT / "universe" / "universe.json"
CACHE = ROOT / "cache" / "prices.pkl"
OUT = ROOT / "web" / "data"
NY = ZoneInfo("America/New_York")

WIN = 252          # output window (trading days)
ZWIN = 252         # trailing window for robust z / percentiles
ZMIN = 60          # minimum valid observations
ZCLIP = 3.0
PROFILE_DAYS = 120
PROFILE_BINS = 40
CALENDAR = "SPY"

TAG_LABELS = {
    "ai": "AI", "chip": "芯片", "power": "电力", "cloud": "云", "software": "软件", "security": "安全",
    "robot": "机器人", "ev": "电动车", "space": "太空", "defense": "国防", "energy": "能源", "oil": "石油",
    "clean": "清洁能源", "finance": "金融", "crypto": "加密", "health": "医疗", "biotech": "生物科技",
    "consumer": "消费", "china": "中国", "japan": "日本", "europe": "欧洲", "emerging": "新兴市场",
    "gold": "黄金", "metals": "金属", "rates": "利率", "realestate": "地产",
}
ATMOS = [  # key, symbol, name, emoji
    ("vix", "^VIX", "恐慌指数", "😨"),
    ("tnx", "^TNX", "10年美债利率", "🏦"),
    ("dxy", "DX-Y.NYB", "美元指数", "💵"),
]

warnings.filterwarnings("ignore", category=RuntimeWarning)

LIVE = {"keep": False, "partial": None,   # --live: keep today's still-forming bar (update.sh --quick)
        "intraday": None,                 # meta.intraday when that bar was scaled to a full day (session.py)
        "vraw": {},                       # ticker → (volume so far, full-day estimate, session fraction)
        "filled": None}                   # meta.filled: days whose close fetch.py rebuilt from 60-minute bars

# §14 宁可估，不可空 — how sure an estimate is
CONF_PEER = 0.5      # own history too short → measured against its peers
CONF_INHERIT = 0.3   # value missing → borrowed from the parent, shrunk toward calm
CONF_NODATA = 0.2    # no price data at all
SHRINK = 0.7         # borrowed weather is "dimmed": parent's value pulled 30 % toward neutral


# ----------------------------------------------------------------------------------------------- utils
def log(msg: str) -> None:
    print(msg, flush=True)


def write_json(path: Path, obj) -> int:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(s, encoding="utf-8")
    os.replace(tmp, path)
    return len(s.encode("utf-8"))


def _finish(r: np.ndarray) -> list:
    """rounded floats → JSON-ready list: NaN/Inf → None, whole numbers as int (0 not 0.0 — smaller files)."""
    out = r.tolist()
    for i, v in enumerate(out):
        if v != v or v in (math.inf, -math.inf):
            out[i] = None
        elif v.is_integer():
            out[i] = int(v)
    return out


def flist(a, nd: int) -> list:
    """numpy → JSON list rounded to nd decimals, NaN/Inf → None, -0.0 → 0."""
    a = np.asarray(a, dtype=np.float64)
    return _finish(np.round(a, nd) + 0.0)


def ilist(a) -> list:
    a = np.asarray(a, dtype=np.float64)
    out = []
    for v in a.tolist():
        out.append(int(round(v)) if math.isfinite(v) else None)
    return out


def plist(a) -> list:
    """prices: 2 decimals when ≥ 10, else 4."""
    a = np.asarray(a, dtype=np.float64)
    return _finish(np.where(np.abs(a) >= 10, np.round(a, 2), np.round(a, 4)) + 0.0)


def mlist(a) -> list:
    """USD-millions series with adaptive precision: 2 decimals below 100, 1 below 10 000, else whole
    millions (finer than the 0.1亿 the screen shows). Keeps stock files small."""
    a = np.asarray(a, dtype=np.float64)
    ab = np.abs(a)
    return _finish(np.where(ab < 100, np.round(a, 2), np.where(ab < 10000, np.round(a, 1), np.round(a, 0))) + 0.0)


def price(v):
    v = float(v)
    return fnum(v, 4 if abs(v) < 10 else 2) if math.isfinite(v) else None


def fnum(v, nd: int):
    v = float(v)
    return round(v, nd) + 0.0 if math.isfinite(v) else None


def shift(X: np.ndarray, n: int) -> np.ndarray:
    """shift rows down by n (like pandas .shift(n)), NaN fill."""
    out = np.full_like(X, np.nan)
    if n < X.shape[0]:
        out[n:] = X[: X.shape[0] - n]
    return out


def roll(X: np.ndarray, w: int, how: str, minp: int | None = None) -> np.ndarray:
    df = pd.DataFrame(X)
    r = df.rolling(w, min_periods=minp if minp is not None else w)
    return getattr(r, how)().to_numpy()


def _sorted_median(S: np.ndarray, cnt: np.ndarray) -> np.ndarray:
    """median along last axis of an array sorted with NaNs at the end; cnt = valid count."""
    lo = np.clip((cnt - 1) // 2, 0, None)
    hi = np.clip(cnt // 2, 0, None)
    hi = np.minimum(hi, S.shape[-1] - 1)
    a = np.take_along_axis(S, lo[..., None], axis=-1)[..., 0]
    b = np.take_along_axis(S, hi[..., None], axis=-1)[..., 0]
    m = 0.5 * (a + b)
    m[cnt == 0] = np.nan
    return m


def robust_z(X: np.ndarray, rows: np.ndarray, win: int = ZWIN, minp: int = ZMIN, clip: float = ZCLIP,
             chunk: int = 64) -> np.ndarray:
    """Robust z of X[t] vs its own trailing `win` values (incl. t). Returns full T×K (NaN outside rows)."""
    T, K = X.shape
    X32 = X.astype(np.float32)
    X32[~np.isfinite(X32)] = np.nan
    Xp = np.vstack([np.full((win - 1, K), np.nan, np.float32), X32])
    full = np.full((T, K), np.nan, np.float32)
    for k0 in range(0, K, chunk):
        k1 = min(K, k0 + chunk)
        V = sliding_window_view(Xp[:, k0:k1], win, axis=0)[rows]  # (R, kc, win) copy
        V = np.sort(V, axis=-1)
        cnt = np.sum(~np.isnan(V), axis=-1)
        med = _sorted_median(V, cnt)
        D = np.abs(V - med[..., None])
        D.sort(axis=-1)
        mad = _sorted_median(D, cnt)
        sd = np.nanstd(V, axis=-1)
        scale = np.maximum(1.4826 * mad, 0.25 * sd)
        x = X32[rows, k0:k1]
        z = np.where(scale > 1e-12, (x - med) / np.where(scale > 1e-12, scale, 1.0), 0.0)
        z[(cnt < minp) | np.isnan(x)] = np.nan
        full[rows, k0:k1] = np.clip(z, -clip, clip)
    return full.astype(np.float64)


def pct_rank(X: np.ndarray, rows: np.ndarray, win: int = ZWIN, minp: int = ZMIN, chunk: int = 64) -> np.ndarray:
    """percentile (0–100) of X[t] within its trailing `win` values (incl. t). Full T×K, NaN outside rows."""
    T, K = X.shape
    X32 = X.astype(np.float32)
    X32[~np.isfinite(X32)] = np.nan
    Xp = np.vstack([np.full((win - 1, K), np.nan, np.float32), X32])
    full = np.full((T, K), np.nan)
    for k0 in range(0, K, chunk):
        k1 = min(K, k0 + chunk)
        V = sliding_window_view(Xp[:, k0:k1], win, axis=0)[rows]
        x = X32[rows, k0:k1][..., None]
        cnt = np.sum(~np.isnan(V), axis=-1)
        less = np.sum(V < x, axis=-1)
        eq = np.sum(V == x, axis=-1)
        p = 100.0 * (less + 0.5 * eq) / np.maximum(cnt, 1)
        p[(cnt < minp) | np.isnan(x[..., 0])] = np.nan
        full[rows, k0:k1] = p
    return full


def peer_fill(X: np.ndarray, Z: np.ndarray, rows: np.ndarray, groups: dict[int, np.ndarray], mode: str = "z",
              win: int = ZWIN, minp: int = ZMIN, clip: float = ZCLIP) -> np.ndarray:
    """§14: where Z[r,k] is missing only because stock k's own history is too short (X[r,k] itself is known),
    measure X[r,k] against its peers' pooled trailing `win` values instead of its own.
    mode "z" → robust z (same formula as robust_z), "pct" → percentile 0–100. Fills Z in place and
    returns the mask of filled cells."""
    filled = np.zeros(Z.shape, dtype=bool)
    if not groups or not len(rows):
        return filled
    cols = np.array(sorted(groups), dtype=int)
    need = np.isnan(Z[np.ix_(rows, cols)]) & np.isfinite(X[np.ix_(rows, cols)])
    for j in np.flatnonzero(need.any(axis=0)):
        k = int(cols[j])
        pc = groups[k]
        if not len(pc):
            continue
        rr = rows[need[:, j]]
        P = X[:, pc].astype(np.float32)
        P[~np.isfinite(P)] = np.nan
        Pp = np.vstack([np.full((win - 1, len(pc)), np.nan, np.float32), P])
        V = sliding_window_view(Pp, win, axis=0)[rr].reshape(len(rr), -1)  # (rows, peers·win)
        cnt = np.sum(~np.isnan(V), axis=1)
        x = X[rr, k].astype(np.float32)
        if mode == "pct":
            less = np.sum(V < x[:, None], axis=1)
            eq = np.sum(V == x[:, None], axis=1)
            z = 100.0 * (less + 0.5 * eq) / np.maximum(cnt, 1)
        else:
            S = np.sort(V, axis=1)
            med = _sorted_median(S, cnt)
            D = np.sort(np.abs(V - med[:, None]), axis=1)
            mad = _sorted_median(D, cnt)
            scale = np.maximum(1.4826 * mad, 0.25 * np.nanstd(V, axis=1))
            z = np.where(scale > 1e-12, (x - med) / np.where(scale > 1e-12, scale, 1.0), 0.0)
            z = np.clip(z, -clip, clip)
        ok = cnt >= minp
        Z[rr[ok], k] = z[ok]
        filled[rr[ok], k] = True
    return filled


def peer_groups(U: "Universe") -> dict[int, np.ndarray]:
    """stock column → its peers' columns: the other stocks of its first leaf region (the parent region's
    stocks when the leaf has fewer than 3 others)."""
    out = {}
    for t in U.tickers:
        pl = U.tinfo[t]["places"][0]
        peers = [x for x in U.regions[pl]["leaf"] if x != t]
        par = U.regions[pl]["parent"]
        if len(peers) < 3 and par >= 0:
            peers = [x for x in U.regions[par]["leaf"] if x != t]
        out[U.tcol[t]] = np.array([U.tcol[x] for x in peers], dtype=int)
    return out


def inherit_missing(U: "Universe", arrs: dict[str, np.ndarray], rows: np.ndarray) -> np.ndarray:
    """§14: a node with no value on a day borrows its parent's, dimmed (pulled toward neutral by SHRINK).
    Regions are in DFS pre-order and stocks come after them, so parents are always filled first."""
    K = arrs["wind"].shape[1]
    inh = np.zeros(arrs["wind"].shape, dtype=bool)
    for key, neutral in (("wind", 0.0), ("temp", 0.0), ("pres", 50.0), ("storm", 0.0)):
        A = arrs[key]
        for k in range(1, K):
            p = U.par[k]
            m = np.isnan(A[rows, k]) & np.isfinite(A[rows, p])
            if m.any():
                rr = rows[m]
                A[rr, k] = neutral + SHRINK * (A[rr, p] - neutral)
                inh[rr, k] = True
    return inh


def combine(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """0.5·a + 0.5·b; a missing half counts as 0; both missing → NaN."""
    out = 0.5 * np.nan_to_num(a) + 0.5 * np.nan_to_num(b)
    out[np.isnan(a) & np.isnan(b)] = np.nan
    return out


# ------------------------------------------------------------------------------------------- universe
class Universe:
    """Flattened tree. Regions in DFS pre-order (index 0 = world); stocks = unique tickers."""

    def __init__(self, root: dict, available: set[str]):
        self.dropped: list[str] = []
        root = self._prune(root, available)
        if root is None:
            raise SystemExit("ERROR: no ticker of the universe has price data")
        self.regions: list[dict] = []
        self.tickers: list[str] = []
        self.tinfo: dict[str, dict] = {}
        self._walk(root, -1, 0, [], [], [])
        self.R = len(self.regions)
        self.N = len(self.tickers)
        self.K = self.R + self.N
        self.tcol = {t: self.R + j for j, t in enumerate(self.tickers)}
        self.rcol = {r["id"]: i for i, r in enumerate(self.regions)}
        # membership: K × N
        M = np.zeros((self.K, self.N), dtype=np.float64)
        for i, r in enumerate(self.regions):
            for t in r["leaf"]:
                M[i, self.tcol[t] - self.R] = 1.0
        M[self.R:, :] = np.eye(self.N)
        self.M = M
        par = np.zeros(self.K, dtype=int)
        for i, r in enumerate(self.regions):
            par[i] = r["parent"] if r["parent"] >= 0 else 0
        for t in self.tickers:
            par[self.tcol[t]] = self.tinfo[t]["places"][0]
        self.par = par
        self.world_kids = [i for i, r in enumerate(self.regions) if r["parent"] == 0]

    def _prune(self, n: dict, avail: set[str]) -> dict | None:
        n = dict(n)
        if "stocks" in n:
            keep = []
            for s in n["stocks"]:
                if s["t"] in avail:
                    keep.append(s)
                else:
                    self.dropped.append(s["t"])
            if not keep:
                return None
            n["stocks"] = keep
            return n
        kids = [c for c in (self._prune(c, avail) for c in n.get("children", [])) if c is not None]
        if not kids:
            return None
        n["children"] = kids
        return n

    def _walk(self, n: dict, parent: int, depth: int, inh_tags: list[str], path_ids: list[str],
              path_names: list[str]) -> set[str]:
        idx = len(self.regions)
        tags = list(dict.fromkeys(inh_tags + list(n.get("tags", []))))
        r = {"id": n["id"], "name": n["name"], "emoji": n.get("emoji", ""), "desc": n.get("desc", ""),
             "inh": tags, "depth": depth, "parent": parent, "kids": [], "stocks": [],
             "pathIds": list(path_ids), "pathNames": list(path_names)}
        self.regions.append(r)
        leaf: set[str] = set()
        sub_ids = path_ids + [n["id"]]
        sub_names = path_names + [n["name"]]
        if "stocks" in n:
            for s in n["stocks"]:
                t = s["t"]
                r["stocks"].append(t)
                leaf.add(t)
                if t not in self.tinfo:
                    self.tickers.append(t)
                    self.tinfo[t] = {"name": s.get("name") or t, "note": s.get("note", ""), "tags": [],
                                     "places": [], "paths": [], "pathNames": [], "depth": depth + 1}
                ti = self.tinfo[t]
                if s.get("holding"):  # §20 the owner's holdings (build_universe.py marks them)
                    ti["holding"] = True
                ti["places"].append(idx)
                ti["paths"].append(sub_ids)
                ti["pathNames"].append(sub_names)
                for tg in tags + list(s.get("tags", [])):
                    if tg not in ti["tags"]:
                        ti["tags"].append(tg)
        else:
            for c in n["children"]:
                cidx = len(self.regions)
                r["kids"].append(cidx)
                leaf |= self._walk(c, idx, depth + 1, tags, sub_ids, sub_names)
        r["leaf"] = sorted(leaf)
        return leaf

    def region_tags(self, i: int) -> list[str]:
        """own + inherited tags, plus any tag carried by a stock below (so a lens can find it)."""
        r = self.regions[i]
        tags = list(r["inh"])
        for t in r["leaf"]:
            for tg in self.tinfo[t]["tags"]:
                if tg not in tags:
                    tags.append(tg)
        order = list(TAG_LABELS)
        return sorted(tags, key=lambda x: order.index(x) if x in order else 99)


# ------------------------------------------------------------------------------------------- prices
def _ny_time(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        t = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return None
    return t.astimezone(NY) if t.tzinfo else t.replace(tzinfo=NY)


def scale_partial_bar(cache: dict, cal: pd.DatetimeIndex, vol: pd.DataFrame, raw_close: pd.DataFrame,
                      quick: dict, spy_fetched: str | None) -> pd.DataFrame:
    """Today's still-forming bar holds only the volume traded so far (≈ 23 % of a normal day at 10:37 ET).
    Every metric compares volume with full days, so a 15-minute refresh would read as "money is leaving
    everywhere". Scale the bar to a full-day estimate with the standard U-shaped intraday curve
    (pipeline/session.py: pace = V/f, gently pulled toward "V + a typical rest of the day" while the session
    is very young). The per-ticker time is when its newest row was downloaded (cache["barAt"], else the
    quick-refresh time, else its fetch stamp). Raw volumes are kept for the stock files (LIVE["vraw"]);
    meta.intraday = {date, asOf, etTime, localTime, fraction, scaled, scaleMedian, nScaled, method, say}."""
    import session as S  # pipeline/session.py

    d = cal[-1].date()
    bar_at = cache.get("barAt") or {}
    fetched = cache.get("fetched") or {}
    q_at = quick.get("at") if quick.get("date") == str(d) else None

    def when(t: str) -> datetime | None:
        for iso in (bar_at.get(t), q_at, fetched.get(t)):
            ts = _ny_time(iso)
            if ts is not None and ts.date() >= d:
                return ts
        return None

    spy_t = when(CALENDAR) or datetime.now(NY)   # only stamps from the bar's own day count
    spy_f = S.session_fraction(spy_t, d)
    cols = list(vol.columns)
    last_v = vol.iloc[-1].to_numpy(np.float64)
    has_bar = raw_close.iloc[-1].notna().to_numpy() & np.isfinite(last_v)
    hist = vol.iloc[-21:-1].where(vol.iloc[-21:-1] > 0)
    v_typ = hist.median(axis=0, skipna=True).to_numpy(np.float64)
    frac = np.full(len(cols), spy_f)
    for j, t in enumerate(cols):
        ts = when(t)
        if ts is not None:
            frac[j] = S.session_fraction(ts, d)
    new_v = last_v.copy()
    for fv in np.unique(frac[has_bar]):
        m = has_bar & (frac == fv)
        new_v[m] = S.full_day_volume(last_v[m], float(fv), v_typ[m])
    scaled = has_bar & (new_v > last_v)
    ratio = np.where(scaled & (last_v > 0), new_v / np.where(last_v > 0, last_v, 1.0), np.nan)
    med = float(np.nanmedian(ratio)) if np.isfinite(ratio).any() else 1.0
    # cross-check the clock with the data: so far today vs a typical full day (median over tickers). Far off
    # the curve means a wrong time stamp — or a genuinely huge day; it is only reported, never "corrected".
    seen = np.where(has_bar & (v_typ > 0), last_v / np.where(v_typ > 0, v_typ, 1.0), np.nan)
    seen_med = float(np.nanmedian(seen)) if np.isfinite(seen).any() else None
    if seen_med is not None and spy_f < 1 and (seen_med > 3 * spy_f + 0.05 or seen_med < spy_f / 3 - 0.02):
        log(f"  WARNING: today so far = {seen_med:.0%} of a typical day, but the clock says {spy_f:.0%} — "
            f"check the bar times (cache barAt) or it is an unusual day")
    vol = vol.copy()
    vol.iloc[-1] = new_v
    LIVE["vraw"] = {t: (float(last_v[j]), float(new_v[j]), float(frac[j])) for j, t in enumerate(cols) if scaled[j]}
    inf = S.info(spy_t, d)
    pct = int(round(spy_f * 100))
    LIVE["intraday"] = {
        **inf, "fraction": round(spy_f, 3), "scaled": bool(scaled.any()), "scaleMedian": round(med, 2),
        "nScaled": int(scaled.sum()), "soFarVsTypical": round(seen_med, 3) if seen_med is not None else None,
        "method": "盘中这根K线只有开盘到现在的成交量；按美股盘中成交量的 U 形曲线折算成全天（开盘头几分钟向平时水平收一点）",
        "say": (f"盘中数据：截至纽约 {inf['etTime']}（你那边 {inf['localTime']}），平常这时大约成交了全天的 {pct}%，"
                f"今天的成交额已按全天折算，收盘后换成真数。") if spy_f < 1 else
               (f"刚收盘：数是纽约 {inf['etTime']}（你那边 {inf['localTime']}）抓的，等收盘后的完整更新再核一遍。"),
    }
    log(f"  partial session {d} as of {inf['etTime']} ET (≈{pct}% of a normal day traded; seen so far "
        f"{(seen_med or 0):.0%} of a typical day): volume of {int(scaled.sum())} ticker(s) scaled to a full-day "
        f"estimate (median ×{med:.2f})")
    return vol


def load_prices(tickers: list[str], extra: list[str]):
    with open(CACHE, "rb") as fh:
        cache = pickle.load(fh)
    F = cache["fields"]
    close = F["Close"]
    if CALENDAR not in close.columns:
        raise SystemExit("ERROR: SPY missing from cache — run pipeline/fetch.py")
    spy_c = close[CALENDAR]
    spy_v = F["Volume"][CALENDAR].reindex(spy_c.index).fillna(0)
    cal = spy_c.index[spy_c.notna() & (spy_v > 0)]
    # drop a partial (still trading) session — unless --live (update.sh --quick during market hours)
    last = cal[-1].date()
    now = datetime.now(NY)
    partial = False
    if last == now.date() and now.hour * 60 + now.minute < 16 * 60 + 15:
        partial = True
    fetched = cache.get("fetched", {}).get(CALENDAR)
    full_after_close = False
    if fetched:
        f = datetime.fromisoformat(fetched)
        f = f.astimezone(NY) if f.tzinfo else f.replace(tzinfo=NY)
        if f.date() == last and f.hour * 60 + f.minute < 16 * 60 + 15:
            partial = True
        full_after_close = f.date() > last or (f.date() == last and f.hour * 60 + f.minute >= 16 * 60 + 15)
    quick = cache.get("quick") or {}
    if quick.get("date") == str(last) and quick.get("partial") and not full_after_close:
        partial = True  # the newest row came from a quick refresh taken while the market was still open
    LIVE["partial"] = None
    LIVE["intraday"] = None
    LIVE["vraw"] = {}
    if partial and LIVE["keep"]:
        LIVE["partial"] = {"date": str(last), "fetchedAt": quick.get("at") or fetched}
        log(f"  keeping the partial session {last} (--live: today's bar is still forming)")
    elif partial:
        log(f"  dropping partial session {last} (market not closed when fetched)")
        cal = cal[:-1]
    cal = pd.DatetimeIndex(cal)
    # a finished day Yahoo sent without a close, rebuilt by fetch.py (cache["filled"]): the page says 「补」 until the
    # real close replaces it
    filled = cache.get("filled") or {}
    ours = set(tickers) | set(extra)

    def n_filled(d, key):  # (marks on this map whose bar is actually there — a failed fill leaves the day empty)
        ts = pd.Timestamp(d)
        return sum(1 for t in filled[d].get(key) or [] if t in ours and t in close.columns and pd.notna(close.at[ts, t]))
    LIVE["filled"] = [{"date": d, "n": n, "of": int(close.loc[pd.Timestamp(d), [t for t in close.columns if t in ours]].notna().sum()),
                       "at": v.get("at"), "source": v.get("source"), "ohlc60": n_filled(d, "ohlc60")}
                      for d, v in sorted(filled.items()) if pd.Timestamp(d) in cal
                      for n in [n_filled(d, "tickers")] if n] or None
    if LIVE["filled"]:
        log("  " + "; ".join(f"{f['date']}: {f['n']} close(s) rebuilt from {f['source']} bars (meta.filled)"
                             for f in LIVE["filled"]))

    avail = [t for t in tickers if t in close.columns and close[t].reindex(cal).notna().any()]
    # §14: tickers without any price data stay on the map (all-NaN columns → they borrow their parent's
    # weather later, marked as estimates) instead of silently disappearing
    cols = list(dict.fromkeys(tickers))
    out = {}
    for f in ["Open", "High", "Low", "Close"]:
        df = F[f].reindex(columns=cols).reindex(cal)
        out[f] = df.ffill()
    vol = F["Volume"].reindex(columns=cols).reindex(cal).fillna(0.0)
    raw_close = F["Close"].reindex(columns=cols).reindex(cal)
    if LIVE["partial"] is not None and len(cal) > 21:
        vol = scale_partial_bar(cache, cal, vol, raw_close, quick, fetched)
    out["Volume"] = vol
    # where a price was missing but carried forward, make O/H/L equal the carried close (flat day)
    gap = raw_close.isna() & out["Close"].notna()
    for f in ["Open", "High", "Low"]:
        out[f] = out[f].mask(gap, out["Close"])
        out[f] = out[f].fillna(out["Close"])
    atm = {}
    for s in extra:
        if s in close.columns:
            atm[s] = close[s].reindex(cal).ffill()
    return cal, avail, out, atm, cache


# ------------------------------------------------------------------------------------------- metrics
def compute(U: Universe, px: dict, cal: pd.DatetimeIndex):
    T = len(cal)
    tick = U.tickers
    C = px["Close"][tick].to_numpy(np.float64)
    O = px["Open"][tick].to_numpy(np.float64)
    H = px["High"][tick].to_numpy(np.float64)
    Lo = px["Low"][tick].to_numpy(np.float64)
    V = px["Volume"][tick].to_numpy(np.float64)
    V[~np.isfinite(V) | (V < 0)] = 0.0
    # repair broken bars: H ≥ max(O,C), L ≤ min(O,C)
    H = np.fmax(H, np.fmax(O, C))
    Lo = np.fmin(Lo, np.fmin(O, C))

    ret = np.full_like(C, np.nan)
    ret[1:] = C[1:] / C[:-1] - 1.0
    ret = np.clip(ret, -0.5, 0.5)
    DV = C * V
    rng = H - Lo
    clv = np.where(rng > 0, ((C - Lo) - (H - C)) / np.where(rng > 0, rng, 1.0), 0.0)
    clv = np.clip(np.nan_to_num(clv), -1, 1)
    vol20 = roll(ret, 20, "std", 10)
    vol20 = np.where(np.isfinite(vol20), vol20, 0.02)
    push = np.clip(0.5 * clv + 0.5 * np.tanh(np.nan_to_num(ret) / np.maximum(vol20, 1e-4)), -1, 1)
    push[np.isnan(C)] = 0.0
    MF = np.nan_to_num(DV) * push

    alive_t = np.isfinite(C)
    valid_r = np.isfinite(ret)
    Mt = U.M.T  # N × K
    DVn = np.nan_to_num(DV) @ Mt
    MFn = MF @ Mt
    cnt = valid_r.astype(np.float64) @ Mt
    retn = np.where(cnt > 0, (np.nan_to_num(ret) @ Mt) / np.maximum(cnt, 1), np.nan)
    alive = (alive_t.astype(np.float64) @ Mt) > 0
    # world's ret = mean of continents
    retn[:, 0] = np.nanmean(retn[:, U.world_kids], axis=1)
    retn[~alive] = np.nan

    par = U.par
    # rotation: share of parent's trading money
    S = DVn / np.where(DVn[:, par] > 0, DVn[:, par], np.nan)
    S[~alive] = np.nan
    m5 = roll(S, 5, "mean", 3)
    m60 = roll(S, 60, "mean", 40)
    rot = np.log(np.where((m5 > 0) & (m60 > 0), m5 / m60, np.nan))
    rot[:, 0] = np.nan  # root has no parent
    # money flow
    dv60 = roll(np.where(alive, DVn, np.nan), 60, "mean", 20)
    flow5 = roll(MFn, 5, "sum", 5) / np.where(dv60 > 0, dv60, np.nan)
    flow5[~alive] = np.nan
    # returns
    lr = np.log1p(np.nan_to_num(retn))
    Lc = np.cumsum(lr, axis=0)
    alive_f = alive.astype(float)

    def comp_ret(n):
        r = np.expm1(Lc - shift(Lc, n))
        ok = shift(alive_f, n) > 0
        r[~ok | ~alive] = np.nan
        return r

    ret5 = comp_ret(5)
    ret20 = comp_ret(20)
    ret60 = comp_ret(60)
    rs = 0.6 * (ret20 - ret20[:, par]) + 0.4 * (ret5 - ret5[:, par])
    rs[:, 0] = np.nan
    # crowding inputs
    idx = np.exp(Lc)
    idx[~alive] = np.nan
    ma50 = roll(idx, 50, "mean", 50)
    sd50 = roll(np.where(alive, retn, np.nan), 50, "std", 30)
    dist = (idx - ma50) / (ma50 * np.maximum(sd50, 1e-4))
    d = np.diff(idx, axis=0, prepend=np.nan)
    gain = pd.DataFrame(np.where(np.isfinite(d), np.clip(d, 0, None), np.nan))
    loss = pd.DataFrame(np.where(np.isfinite(d), np.clip(-d, 0, None), np.nan))
    ag = gain.ewm(alpha=1 / 14, adjust=False, min_periods=14, ignore_na=True).mean().to_numpy()
    al = loss.ewm(alpha=1 / 14, adjust=False, min_periods=14, ignore_na=True).mean().to_numpy()
    rsi = np.where(al > 0, 100 - 100 / (1 + ag / np.where(al > 0, al, 1)), np.where(ag > 0, 100.0, 50.0))
    rsi[~np.isfinite(ag) | ~np.isfinite(al) | ~alive] = np.nan
    dvA = np.where(alive, DVn, np.nan)
    dv20m = roll(dvA, 20, "mean", 15)
    dv120m = roll(dvA, 120, "mean", 80)
    dvr = np.log(np.where((dv20m > 0) & (dv120m > 0), dv20m / dv120m, np.nan))
    # storm
    rA = np.where(alive, retn, np.nan)
    s5 = roll(rA, 5, "std", 5)
    s60 = roll(rA, 60, "std", 40)
    storm = np.clip(np.where(s60 > 0, s5 / np.where(s60 > 0, s60, 1) - 1, np.nan), 0, 3)

    W = min(WIN, T)
    w0 = T - W
    rows_w = np.arange(max(0, w0 - 10), T)
    rows_p = np.arange(max(0, w0 - (ZWIN - 1)), T)
    t0 = time.time()
    z_rot = robust_z(rot, rows_w)
    z_flow = robust_z(flow5, rows_w)
    z_r20 = robust_z(ret20, rows_w)
    z_rs = robust_z(rs, rows_w)
    # §14: a stock with < ZMIN days of its own history is measured against its peers instead of blanking
    t1 = time.time()
    groups = peer_groups(U)
    rows_win = np.arange(w0, T)
    est_peer = np.zeros((T, U.K), dtype=bool)
    for X, Z in ((rot, z_rot), (flow5, z_flow), (ret20, z_r20), (rs, z_rs)):
        est_peer |= peer_fill(X, Z, rows_w, groups)
    t_peer = time.time() - t1
    wind = combine(z_rot, z_flow)
    temp = combine(z_r20, z_rs)
    wind[:, 0] = z_flow[:, 0]
    temp[:, 0] = z_r20[:, 0]
    zd = robust_z(dist, rows_p)
    zr = robust_z(rsi, rows_p)
    zv = robust_z(dvr, rows_p)
    t1 = time.time()
    for X, Z in ((dist, zd), (rsi, zr), (dvr, zv)):
        est_peer |= peer_fill(X, Z, rows_win, groups)
    t_peer += time.time() - t1
    compo = np.nanmean(np.stack([zd, zr, zv]), axis=0)
    pres = pct_rank(compo, rows_win)
    t1 = time.time()
    est_peer |= peer_fill(compo, pres, rows_win, groups, mode="pct")
    t_peer += time.time() - t1
    n_peer = int(est_peer[w0:].any(axis=0).sum())
    log(f"  z-scores for {U.K} nodes × {T} days in {time.time() - t0:.1f}s"
        + (f" ({n_peer} short-history stock(s) measured against peers, {t_peer:.1f}s)" if n_peer else ""))

    # fronts
    front = np.zeros((T, U.K))
    lagged = np.stack([shift(wind, l) for l in range(5, 11)])  # (6, T, K)
    absl = np.where(np.isfinite(lagged), np.abs(lagged), -1.0)
    am = np.argmax(absl, axis=0)
    pick = np.take_along_axis(lagged, am[None], axis=0)[0]
    w = wind
    ok = np.isfinite(w) & np.isfinite(pick) & (np.abs(w) > 0.8) & (np.abs(pick) > 0.5) & (np.sign(pick) == -np.sign(w))
    front[ok] = np.sign(w[ok])

    # §14: anything still missing inside the window borrows its parent's weather (dimmed); no fronts from it
    est_inh = inherit_missing(U, {"wind": wind, "temp": temp, "pres": pres, "storm": storm}, rows_win)

    sl = slice(w0, T)
    idx_w = 100.0 * np.exp(Lc[sl] - Lc[w0])
    idx_w[~alive[sl]] = np.nan
    res = {
        "W": W, "w0": w0,
        "wind": wind[sl], "temp": temp[sl], "pres": pres[sl], "storm": storm[sl], "front": front[sl],
        "idx": idx_w, "flow": MFn[sl] / 1e6, "dv": DVn[sl] / 1e6,
        "retn": retn, "ret5": ret5, "ret20": ret20, "ret60": ret60, "MFn": MFn, "DVn": DVn, "alive": alive,
        # per-ticker raw
        "C": C, "O": O, "H": H, "L": Lo, "V": V, "MF": MF, "push": push, "DV": DV, "ret": ret,
        # internals for sanity checks
        "rot": rot, "flow5": flow5, "rs": rs, "z_rot": z_rot, "z_flow": z_flow,
        # §14 estimate masks over the window (W × K)
        "est_peer": est_peer[sl], "est_inh": est_inh[sl],
        "days_alive": alive.sum(axis=0),
    }
    return res


def estimate_info(U: Universe, res: dict) -> dict[int, dict]:
    """column → {"until": last estimated window index, "now": latest day estimated?, "basis", "conf", "kind"}."""
    peer, inh = res["est_peer"], res["est_inh"]
    anyest = peer | inh
    W = anyest.shape[0]
    out: dict[int, dict] = {}
    for k in np.flatnonzero(anyest.any(axis=0)):
        k = int(k)
        rows = np.flatnonzero(anyest[:, k])
        until = int(rows[-1])
        n = int(res["days_alive"][k])
        if k < U.R:
            r = U.regions[k]
            pname = U.regions[r["parent"]]["name"] if r["parent"] >= 0 else "地球"
            kind, conf = "inherit", CONF_INHERIT
            basis = f"这一片数据不够，先借上一级「{pname}」的天气（打了折）"
        else:
            t = U.tickers[k - U.R]
            pl = U.tinfo[t]["places"][0]
            lname = U.regions[pl]["name"]
            if n == 0:
                kind, conf = "nodata", CONF_NODATA
                basis = f"拿不到这只的价格数据，先借「{lname}」的天气，等你补数据"
            elif inh[until, k]:
                kind, conf = "inherit", CONF_INHERIT
                basis = f"自己的数据只有 {n} 天，先借「{lname}」的天气（打了折）"
            else:
                kind, conf = "peer", CONF_PEER
                basis = f"自己的历史只有 {n} 天，跟同行「{lname}」比着估"
        out[k] = {"until": until, "now": bool(until == W - 1), "basis": basis, "conf": conf, "kind": kind}
    return out


def apply_overrides(U: Universe, res: dict, est: dict[int, dict], eff: dict) -> tuple[dict, dict, int]:
    """§14 owner corrections. Owner entries always apply; anyone else's only where our value is an estimate.
    Weather fields change the latest day of the series (so tree, maps and stock files agree); node fields
    change names/notes. Returns ({column: {field: value}} for the `now` block, {column: {field: source}}, n)."""
    import owner_overrides as ovmod

    col = {r["id"]: i for i, r in enumerate(U.regions)}
    col.update({f"s:{t}": U.tcol[t] for t in U.tickers})
    now_patch: dict[int, dict] = {}
    marks: dict[int, dict] = {}
    n = 0
    for (target, field), e in eff.items():
        k = col.get(target)
        if k is None and not target.startswith("s:"):
            k = col.get(f"s:{target.upper()}")
        if k is None:
            continue
        f = field[4:] if field.startswith("now.") else field
        owner = ovmod.is_owner(e)
        if not owner and not (est.get(k) or {}).get("now"):
            continue  # real data beats scout/loop values
        v = e.get("value")
        if f in ovmod.NODE_FIELDS:
            if v is None:
                continue
            if k < U.R:
                if f in ("name", "desc", "emoji"):
                    U.regions[k][f] = str(v)
                else:
                    continue
            else:
                t = U.tickers[k - U.R]
                if f in ("name", "note"):
                    U.tinfo[t][f] = str(v)
                else:
                    continue
        elif f in ovmod.NOW_FIELDS:
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(v):
                continue
            if f in ovmod.SERIES_FIELDS:
                if f == "front":
                    v = float(int(np.sign(v)))
                elif f == "pres":
                    v = float(min(100.0, max(0.0, round(v))))
                res[f][-1, k] = v
            else:
                now_patch.setdefault(k, {})[f] = v
        else:
            continue
        marks.setdefault(k, {})[f] = "owner" if owner else (e.get("source") or "other")
        n += 1
    return now_patch, marks, n


# ------------------------------------------------------------------------------------------- outputs
SERIES_KEYS = ["wind", "temp", "pres", "storm", "front", "idx", "flow", "dv"]


def series(res: dict, k: int, flow_nd: int = 1) -> dict:
    return {
        "wind": flist(res["wind"][:, k], 2),
        "temp": flist(res["temp"][:, k], 2),
        "pres": ilist(res["pres"][:, k]),
        "storm": flist(res["storm"][:, k], 2),
        "front": [int(v) for v in np.nan_to_num(res["front"][:, k]).tolist()],
        "idx": flist(res["idx"][:, k], 2),
        "flow": flist(res["flow"][:, k], flow_nd),
        "dv": flist(res["dv"][:, k], flow_nd),
    }


def crash_now(res: dict, k: int) -> int:
    """DESIGN §8 amendment (crash gate, pipeline/crashgate.py): 0 | 1 急跌 | 2 崩 on the last day, from the map's own
    idx series as written (rounded to 2 decimals) so tree.json, maps (words.js crashAt) and brief.py always agree."""
    import crashgate as CG
    idx = res.get("idx")
    if idx is None:
        return 0
    col = idx[:, k]
    seg = col[max(0, len(col) - (CG.SIG_DAYS + 8)):]
    px = [round(float(v), 2) if np.isfinite(v) else None for v in seg]
    cr = CG.crash_at(px, len(px) - 1)
    return int(cr["level"]) if cr else 0


def now_block(res: dict, k: int) -> dict:
    T = res["retn"].shape[0]
    alive_k = res["alive"][:, k]
    mf = res["MFn"][:, k]
    dv = res["DVn"][:, k]
    last20 = alive_k[T - 20:]
    return {
        "wind": fnum(res["wind"][-1, k], 2),
        "temp": fnum(res["temp"][-1, k], 2),
        "pres": (int(round(res["pres"][-1, k])) if np.isfinite(res["pres"][-1, k]) else None),
        "storm": fnum(res["storm"][-1, k], 2),
        "front": int(np.nan_to_num(res["front"][-1, k])),
        "ret1": fnum(res["retn"][-1, k], 4),
        "ret5": fnum(res["ret5"][-1, k], 4),
        "ret20": fnum(res["ret20"][-1, k], 4),
        "flow5": fnum(mf[T - 5:].sum() / 1e6, 1),
        "dv20": fnum(dv[T - 20:][last20].mean() / 1e6 if last20.any() else 0.0, 1),
        "crash": crash_now(res, k),
    }


def volume_profile(H, L, C, DV, push, days=PROFILE_DAYS, nb=PROFILE_BINS) -> dict | None:
    h, l, c, dv, p = H[-days:], L[-days:], C[-days:], DV[-days:], push[-days:]
    ok = np.isfinite(h) & np.isfinite(l) & np.isfinite(c) & np.isfinite(dv) & (dv > 0)
    if ok.sum() < 5:
        return None
    h, l, c, dv, p = h[ok], l[ok], c[ok], dv[ok], p[ok]
    lo, hi = float(np.min(l)), float(np.max(h))
    if not (hi > lo):
        hi = lo * 1.01 + 1e-6
    edges = np.linspace(lo, hi, nb + 1)
    a, b = edges[:-1][None, :], edges[1:][None, :]
    span = (h - l)[:, None]
    ov = np.clip(np.minimum(b, h[:, None]) - np.maximum(a, l[:, None]), 0, None)
    share = np.where(span > 0, ov / np.where(span > 0, span, 1), 0.0)
    # flat bars: everything in the bin holding the close
    flat = (span[:, 0] <= 0)
    if flat.any():
        bi = np.clip(np.searchsorted(edges, c[flat], side="right") - 1, 0, nb - 1)
        share[flat] = 0
        share[np.flatnonzero(flat), bi] = 1.0
    alloc = share * dv[:, None] / 1e6
    buy = alloc[p >= 0].sum(axis=0)
    sell = alloc[p < 0].sum(axis=0)
    centers = 0.5 * (edges[:-1] + edges[1:])
    return {"lo": price(lo), "hi": price(hi), "bins": plist(centers),
            "buy": flist(buy, 2), "sell": flist(sell, 2)}


def atmosphere_say(key: str, last: float, chg5: float) -> str:
    """A few plain words for a gauge (≤ 10 chars; the gauge shows the number itself)."""
    if key == "vix":
        if last < 13:
            s = "非常放松"
        elif last < 17:
            s = "市场很平静"
        elif last < 21:
            s = "有点紧张"
        elif last < 26:
            s = "大家紧张了"
        elif last < 32:
            s = "很紧张"
        else:
            s = "恐慌！"
        if chg5 >= 3:
            s += "，在升温"
        elif chg5 <= -3:
            s += "，在降温"
        return s
    if key == "tnx":  # chg5 in percentage points
        if chg5 >= 0.12:
            return "快速上升，股票逆风"
        if chg5 >= 0.05:
            return "在慢慢上升"
        if chg5 <= -0.12:
            return "快速下降，股票顺风"
        if chg5 <= -0.05:
            return "在慢慢下降"
        return "很稳"
    if key == "dxy":
        pc = chg5 / (last - chg5) if last - chg5 else 0
        if pc >= 0.01:
            return "明显走强"
        if pc >= 0.004:
            return "在慢慢走强"
        if pc <= -0.01:
            return "明显走弱"
        if pc <= -0.004:
            return "在慢慢走弱"
        return "很稳"
    return ""


def main() -> int:
    global OUT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--universe", default=str(UNIVERSE), help="universe file (default universe/universe.json)")
    ap.add_argument("--out", default=str(OUT), help="output dir (default web/data)")
    ap.add_argument("--live", action="store_true",
                    help="keep today's still-forming bar (update.sh --quick while the market is open)")
    ap.add_argument("--overrides", help="overrides file (default <out>/overrides.json or $MW_OVERRIDES_PATH)")
    args = ap.parse_args()
    default_out = OUT.resolve()
    OUT = Path(args.out).resolve()
    LIVE["keep"] = bool(args.live)
    t_start = time.time()
    root = json.loads(Path(args.universe).read_text(encoding="utf-8"))
    build = root.get("_build", {})

    all_t: list[str] = []

    def walk(n):
        for s in n.get("stocks", []):
            all_t.append(s["t"])
        for c in n.get("children", []):
            walk(c)

    walk(root)
    all_t = list(dict.fromkeys(all_t))
    cal, avail, px, atm, cache = load_prices(all_t, [s for _, s, _, _ in ATMOS])
    U = Universe(root, set(all_t))
    nodata = sorted(set(all_t) - set(avail))
    if nodata:
        log(f"  WARNING: {len(nodata)} ticker(s) without price data (kept on the map as estimates): "
            f"{' '.join(nodata)}")
    log(f"compute: {U.R} regions, {U.N} stocks, {len(cal)} trading days ({cal[0].date()} → {cal[-1].date()})")
    res = compute(U, px, cal)
    W, w0 = res["W"], res["w0"]
    est = estimate_info(U, res)
    # §14 owner corrections (web/data/overrides.json) on top of the measured data
    ov_path = Path(args.overrides or os.environ.get("MW_OVERRIDES_PATH") or (OUT / "overrides.json"))
    now_patch, ov_marks, n_ov = {}, {}, 0
    try:
        import owner_overrides as ovmod
        if OUT == default_out and not args.overrides:
            ovmod.ensure_file(ov_path)
        eff = ovmod.effective(ovmod.load(ov_path))
        if eff:
            now_patch, ov_marks, n_ov = apply_overrides(U, res, est, eff)
            log(f"  overrides: {len(eff)} in {ov_path.name}, {n_ov} applied to the map")
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: overrides not applied ({type(e).__name__}: {e})")

    def est_fields(k: int, full: bool = False) -> dict:
        e = est.get(k)
        if not e:
            return {}
        if full:
            return {"est": e["now"], "estUntil": e["until"], "basis": e["basis"], "conf": e["conf"]}
        return {"est": True, "basis": e["basis"], "conf": e["conf"]} if e["now"] else {}
    dates = [d.strftime("%Y-%m-%d") for d in cal[w0:]]
    asof = dates[-1]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "maps").mkdir(exist_ok=True)
    (OUT / "stocks").mkdir(exist_ok=True)
    written: set[Path] = set()
    sizes = {"maps": 0, "stocks": 0, "other": 0}

    # --- now blocks
    now_r = [now_block(res, i) for i in range(U.R)]
    now_s = {t: now_block(res, U.tcol[t]) for t in U.tickers}
    for k, patch in now_patch.items():
        nb = now_r[k] if k < U.R else now_s[U.tickers[k - U.R]]
        for f, v in patch.items():
            nb[f] = fnum(v, 4 if f.startswith("ret") else 1)

    # --- tree.json
    def stock_node(t: str, depth: int) -> dict:
        ti = U.tinfo[t]
        k = U.tcol[t]
        node = {"id": f"s:{t}", "ticker": t, "name": ti["name"], "note": ti["note"], "kind": "stock",
                "depth": depth, "tags": ti["tags"], "now": now_s[t], **est_fields(k)}
        if k in ov_marks:
            node["ov"] = ov_marks[k]
        if ti.get("holding"):
            node["holding"] = True
        return node

    def region_node(i: int) -> dict:
        r = U.regions[i]
        node = {"id": r["id"], "name": r["name"], "emoji": r["emoji"], "desc": r["desc"], "kind": "region",
                "depth": r["depth"], "tags": U.region_tags(i), "nStocks": len(r["leaf"]), "now": now_r[i],
                **est_fields(i)}
        if i in ov_marks:
            node["ov"] = ov_marks[i]
        if r["kids"]:
            node["children"] = [region_node(c) for c in r["kids"]]
        else:
            node["children"] = [stock_node(t, r["depth"] + 1) for t in r["stocks"]]
        return node

    tree = region_node(0)
    sizes["other"] += write_json(OUT / "tree.json", tree)

    # --- maps/<id>.json
    for i, r in enumerate(U.regions):
        kids = {}
        cols = [(U.regions[c]["id"], c) for c in r["kids"]] if r["kids"] else [(f"s:{t}", U.tcol[t]) for t in r["stocks"]]
        for cid, c in cols:
            kids[cid] = series(res, c)
        mobj = {"id": r["id"], "self": series(res, i), "children": kids}
        mest = {cid: {k2: est[c][k2] for k2 in ("until", "basis", "conf")} for cid, c in cols if c in est}
        if i in est:
            mest["self"] = {k2: est[i][k2] for k2 in ("until", "basis", "conf")}
        if mest:
            mobj["est"] = mest  # §14: estimated days are 0…until (window index) for that territory
        p = OUT / "maps" / (r["id"].replace(":", "_") + ".json")
        sizes["maps"] += write_json(p, mobj)
        written.add(p)

    # --- stocks/<T>.json
    sl = slice(w0, None)
    dv20_s = {t: (now_s[t]["dv20"] or 0.0) for t in U.tickers}
    for j, t in enumerate(U.tickers):
        k = U.tcol[t]
        ti = U.tinfo[t]
        C, O, H, L, V = res["C"][:, j], res["O"][:, j], res["H"][:, j], res["L"][:, j], res["V"][:, j]
        mf = res["MF"][:, j] / 1e6
        alive = np.isfinite(C)
        flow_w = np.where(alive[sl], mf[sl], np.nan)
        cum = np.nancumsum(np.nan_to_num(flow_w))
        cum = np.where(alive[sl], cum, np.nan)
        peers = []
        for pl in ti["places"]:
            for t2 in U.regions[pl]["stocks"]:
                if t2 != t and t2 not in peers:
                    peers.append(t2)
        peers.sort(key=lambda x: -dv20_s.get(x, 0))
        Cw, Hw, Lw = C[sl], H[sl], L[sl]

        def cret(n):
            if len(C) > n and np.isfinite(C[-1]) and np.isfinite(C[-1 - n]) and C[-1 - n] > 0:
                return fnum(C[-1] / C[-1 - n] - 1, 4)
            return None

        f5 = pd.Series(np.nan_to_num(mf)).rolling(5).sum().to_numpy()[sl]
        f5 = f5[alive[sl]]
        facts = {
            "last": price(C[-1]),
            "dv20": now_s[t]["dv20"],
            "flow5": fnum(np.nansum(mf[-5:]), 2),
            "flow20": fnum(np.nansum(mf[-20:]), 2),
            "flow5Avg": fnum(np.nanmean(np.abs(f5)) if len(f5) else 0.0, 2),
            "ret1": cret(1), "ret5": cret(5), "ret20": cret(20), "ret60": cret(60),
            "high52": price(np.nanmax(Hw) if np.isfinite(Hw).any() else np.nan),
            "low52": price(np.nanmin(Lw) if np.isfinite(Lw).any() else np.nan),
        }
        vr = LIVE["vraw"].get(t)
        dv_p = res["DV"][:, j]
        if vr is not None:  # 筹码山 = where money really traded: today's volume so far, not the estimate
            dv_p = dv_p.copy()
            dv_p[-1] = C[-1] * vr[0]
        prof = volume_profile(H, L, C, dv_p, res["push"][:, j])
        v_out = ilist(np.where(alive[sl], V[sl], np.nan))
        if vr is not None and v_out:
            v_out[-1] = int(round(vr[0]))
        obj = {
            "t": t, "name": ti["name"], "note": ti["note"], "paths": ti["paths"],
            "dates": dates,
            "o": plist(O[sl]), "h": plist(H[sl]), "l": plist(L[sl]), "c": plist(Cw),
            "v": v_out,
            "flow": mlist(flow_w),
            "cumFlow": mlist(cum),
            "wind": flist(res["wind"][:, k], 2),
            "temp": flist(res["temp"][:, k], 2),
            "pres": ilist(res["pres"][:, k]),
            "storm": flist(res["storm"][:, k], 2),
            "front": [int(v) for v in np.nan_to_num(res["front"][:, k]).tolist()],
            "profile": prof or {"lo": None, "hi": None, "bins": [], "buy": [], "sell": []},
            "peers": [f"s:{x}" for x in peers[:8]],
            "facts": facts,
            **est_fields(k, full=True),
        }
        if k in ov_marks:
            obj["ov"] = ov_marks[k]
        if vr is not None:  # today's bar is still forming: v[-1] is what traded so far, flow/dv use vEst
            obj["intraday"] = {"date": dates[-1], "etTime": LIVE["intraday"]["etTime"], "fraction": round(vr[2], 3),
                               "vSoFar": int(round(vr[0])), "vEst": int(round(vr[1]))}
        if ti.get("holding"):
            obj["holding"] = True
        p = OUT / "stocks" / f"{t}.json"
        sizes["stocks"] += write_json(p, obj)
        written.add(p)

    # --- search.json
    search = []
    for i, r in enumerate(U.regions):
        search.append({"id": r["id"], "name": r["name"], "emoji": r["emoji"], "kind": "region",
                       "path": r["pathNames"], "pathIds": r["pathIds"]})
    for t in U.tickers:
        ti = U.tinfo[t]
        search.append({"id": f"s:{t}", "name": ti["name"], "ticker": t, "note": ti["note"], "kind": "stock",
                       "path": ti["pathNames"][0], "pathIds": ti["paths"][0],
                       **({"holding": True} if ti.get("holding") else {})})
    sizes["other"] += write_json(OUT / "search.json", search)

    # --- meta.json
    atmos = []
    for key, sym, name, emoji in ATMOS:
        s = atm.get(sym)
        if s is None or s.iloc[w0:].notna().sum() == 0:
            continue
        vals = s.to_numpy(np.float64)
        if key == "tnx" and np.nanmedian(vals) > 20:  # old Yahoo convention: ×10
            vals = vals / 10.0
        vw = vals[w0:]
        last = float(vw[np.isfinite(vw)][-1])
        prev = vals[-6] if len(vals) >= 6 and np.isfinite(vals[-6]) else last
        chg5 = last - float(prev)
        atmos.append({"key": key, "name": name, "emoji": emoji, "series": flist(vw, 2), "last": fnum(last, 2),
                      "chg5": fnum(chg5, 2), "say": atmosphere_say(key, last, chg5)})
    used_tags = set()
    for t in U.tickers:
        used_tags.update(U.tinfo[t]["tags"])
    meta = {
        "asOf": asof,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "dates": dates,
        "tags": {k: v for k, v in TAG_LABELS.items() if k in used_tags},
        "atmosphere": atmos,
        "mode": build.get("mode", "full"),
        "partial": LIVE["partial"],   # {date, fetchedAt} when the newest day is still trading (--live)
        "filled": LIVE["filled"],     # [{date, n, of, at, source}]: closes Yahoo had not sent yet, rebuilt (fetch.py)
        "intraday": ({k2: v2 for k2, v2 in LIVE["intraday"].items()} if LIVE["partial"] and LIVE["intraday"] else None),
        "holdings": [f"s:{t}" for t in U.tickers if U.tinfo[t].get("holding")],
        "estimates": [U.regions[k]["id"] if k < U.R else f"s:{U.tickers[k - U.R]}"
                      for k, e in sorted(est.items()) if e["now"]],
        "nStocks": U.N,
        "nRegions": U.R,
    }
    sizes["other"] += write_json(OUT / "meta.json", meta)

    # --- remove stale map/stock files from earlier universes
    removed = 0
    for sub in ("maps", "stocks"):
        for p in (OUT / sub).glob("*.json"):
            if p not in written:
                p.unlink()
                removed += 1
        for p in (OUT / sub).glob("*.tmp"):
            p.unlink()

    log(f"  wrote web/data: tree/meta/search {sizes['other'] / 1e6:.2f} MB, {U.R} maps {sizes['maps'] / 1e6:.2f} MB, "
        f"{U.N} stocks {sizes['stocks'] / 1e6:.2f} MB" + (f", removed {removed} stale file(s)" if removed else ""))
    log(f"  asOf {asof}, window {dates[0]} → {dates[-1]} ({len(dates)} days), done in {time.time() - t_start:.1f}s")

    if not args.quiet:
        print_table(U, now_r, now_s)
    return 0


def print_table(U: Universe, now_r: list[dict], now_s: dict) -> None:
    def row(name, n, nst):
        return (f"  {name:<14}{nst:>6}{_f(n['wind']):>7}{_f(n['temp']):>7}{_f(n['pres'], 0):>6}{_f(n['storm']):>7}"
                f"{n['front']:>4}{_f(n['ret5'] * 100 if n['ret5'] is not None else None, 1):>7}%"
                f"{_f(n['flow5'], 0):>10}{_f(n['dv20'], 0):>10}")

    hdr = f"  {'node':<14}{'n':>6}{'wind':>7}{'temp':>7}{'pres':>6}{'storm':>7}{'frt':>4}{'ret5':>8}{'flow5$M':>10}{'dv20$M':>10}"
    log("\n  world and its continents (latest day):")
    log(hdr)
    log(row("world", now_r[0], len(U.regions[0]["leaf"])))
    for i in U.regions[0]["kids"]:
        log(row(U.regions[i]["id"], now_r[i], len(U.regions[i]["leaf"])))
        if U.regions[i]["id"] == "us":
            for c in U.regions[i]["kids"]:
                log(row("  " + U.regions[c]["id"], now_r[c], len(U.regions[c]["leaf"])))


def _f(v, nd=2):
    if v is None:
        return "-"
    return f"{v:.{nd}f}"


if __name__ == "__main__":
    sys.exit(main())
