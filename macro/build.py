#!/usr/bin/env python3
"""macro/build.py — 宏观天气: FX majors + key futures with §2-style weather → web/data/macro.json (DESIGN §23/§24).

    python3 macro/build.py              # prices (yfinance, 30 min cache) + CFTC (12 h cache) → macro.json
    python3 macro/build.py --quick      # intraday: prices younger than 10 min reused
    python3 macro/build.py --force      # re-download prices and CFTC
    python3 macro/build.py --offline    # caches only

Every instrument is measured on a strength basis (macro/instruments.py): up = money flowing INTO it.
Per instrument, per day (same formulas as DESIGN §2 where the data allows):
  ret, clv, vol20, push = clip(0.5·clv + 0.5·tanh(ret/vol20), −1, 1)
  futures with usable volume:  DV = C·V·multiplier (USD), MF = DV·push, rot = ln(mean₅ S / mean₆₀ S) with
                               S = DV / DV(group), flow5 = Σ₅ MF / mean₆₀ DV
  open interest (CFTC, weekly): oiFlow = mom·(0.3 + 0.7·(0.5 + 0.5·tanh(ln(OI/OI₂₀)/0.05))) — price momentum
                               confirmed (OI rising) or discounted (OI falling, e.g. short covering)
  no volume (FX, indices):     push5 = Σ₅ push (price action only), mom = tanh(ret20 / (vol20·√20))
  wind = 0.25 z(rot) + 0.35 z(flow5) + 0.40 z(oiFlow)   futures with volume + OI
       = 0.50 z(rot) + 0.50 z(flow5)                     futures with volume, no OI (Brent)
       = 0.50 z(push5) + 0.50 z(oiFlow)                  no usable volume, OI (FX with CME futures, VIX, …)
       = 0.50 z(push5) + 0.50 z(mom)                     price only (KRW, INR, CNH)
  temp = 0.5 z(ret20) + 0.5 z(rs) (rs vs the group mean); pres = percentile of mean(z(distance from MA50 in
  vol units), z(RSI14), z(ln DV20/DV120) if volume, z(speculators' net % of OI) if CFTC); storm, front, idx as §2.
z = robust z vs the instrument's own trailing 252 days (min 60), clipped ±3. Flows are always inferred from
prices/volume/OI (est:true with basis + conf); CFTC numbers themselves are real (cot.est:false).
Group nodes: wind = mean of members' wind (FX: without the dollar index), ret = mean of members.

Output: { asOf, generatedAt, source, note, dates[252],
  tree:{id:'macro', …, children:[group nodes → instrument nodes (kind 'macro', id 'm:XXX')]},   ← §3 node shape
  maps:{'macro':{id, self, children}, '<groupId>':{…}},                                         ← §3 SERIES shape
  items:{'m:XXX':{id, key, sym, name, group, kind, quote, note, last, chg, facts, cot, est, basis, conf,
                  season, say, sayMild, c:[252]}},
  headline, say, sayMild, channel:{from,to,say}, spotlight:[≤3], fronts:[…], brief:[…], extras:{vixTerm, cnhSpot} }
"""
from __future__ import annotations

import argparse
import math
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

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if str(Path(__file__).resolve().parent.parent / "pipeline") not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parent.parent / "pipeline"))   # appended: never shadows our modules
import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 brief.py、words.js crashAt 同一条规则
from liquidity import net  # noqa: E402
from macro import cot as COT  # noqa: E402
from macro.instruments import BY_KEY, EXTRA, FLAVOR, GROUPS, INSTRUMENTS  # noqa: E402

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
OUT = ROOT / "web" / "data" / "macro.json"
META = ROOT / "web" / "data" / "meta.json"
PRICES = HERE / "cache" / "prices.pkl"
PRICE_TTL_S = 30 * 60      # default run; --quick: 10 min (intraday); --offline: cache only
WIN, ZWIN, ZMIN = 252, 252, 60
NY = ZoneInfo("America/New_York")


def partial_info(last: pd.Timestamp) -> dict | None:
    """Is the last bar today's still-forming bar? CME's day runs 18:00 ET (previous day) → 17:00 ET; roughly
    30 % of the volume trades overnight and 70 % in 09:30–16:00. → {date, etTime, fraction} or None."""
    now = datetime.now(NY)
    if last.date() != now.date() or now.weekday() >= 5:
        return None
    h = now.hour + now.minute / 60
    if h >= 17:
        return None
    f = 0.3 * min(1.0, max(0.05, (h + 6) / 15.5)) if h < 9.5 else 0.3 + 0.7 * min(1.0, (h - 9.5) / 6.5)
    return {"date": last.strftime("%Y-%m-%d"), "etTime": now.strftime("%H:%M"), "fraction": round(f, 2),
            "localTime": datetime.now().strftime("%H:%M"),
            "say": f"盘中（截至美东 {now.strftime('%H:%M')}），今天的成交量按时段估成全天"}


# --------------------------------------------------------------------------------------------- data
def fetch_prices(force=False, offline=False, log=print) -> tuple[dict[str, pd.DataFrame], dict]:
    syms = [x["sym"] for x in INSTRUMENTS] + list(EXTRA.values())
    if PRICES.exists() and (offline or (not force and time.time() - PRICES.stat().st_mtime < PRICE_TTL_S)):
        d = pickle.loads(PRICES.read_bytes())
        if set(syms) <= set(d):
            return d, {"source": "cache", "age_s": round(time.time() - PRICES.stat().st_mtime)}
    if offline:
        raise RuntimeError("no price cache")
    import yfinance as yf
    t0 = time.time()
    raw = yf.download(syms, period="3y", auto_adjust=True, progress=False, group_by="ticker", threads=True)
    out = {}
    for s in syms:
        try:
            x = raw[s].dropna(how="all")
            x = x[["Open", "High", "Low", "Close", "Volume"]].astype(float)
            x.index = pd.to_datetime(x.index).tz_localize(None).normalize()
            x = x[~x.index.duplicated(keep="last")]
            if len(x):
                out[s] = x
        except Exception:
            continue
    # USD/CNH: Yahoo's daily bars of USDCNH=X / CNH=X are just the latest quote, so build the daily FX-day bars
    # (17:00 New York cut) from its hourly history; onshore USDCNY=X only before that history starts.
    try:
        sys.path.insert(0, str(ROOT / "globalmkt"))
        import fxcnh
        cnh = fxcnh.daily_ohlc("ny")
        fb = out.get("USDCNY=X")
        if fb is not None and len(fb):
            cnh = pd.concat([fb[fb.index < cnh.index[0]], cnh]).sort_index()
        cnh = cnh[~cnh.index.duplicated(keep="last")]
        cnh.attrs["source"] = "CNH=X 1h → daily (17:00 NY)"
        out["USDCNH=X"] = cnh
    except Exception as e:  # noqa: BLE001
        log(f"  ! CNH hourly failed ({e}); USD/CNH falls back to onshore USDCNY=X")
        if "USDCNY=X" in out:
            fb = out["USDCNY=X"].copy()
            fb.attrs["source"] = "USDCNY=X daily (fallback)"
            out["USDCNH=X"] = fb
    old = pickle.loads(PRICES.read_bytes()) if PRICES.exists() else {}
    for s in syms:   # a symbol that failed today keeps yesterday's history
        if s not in out and s in old:
            out[s] = old[s]
    PRICES.parent.mkdir(parents=True, exist_ok=True)
    tmp = PRICES.with_suffix(".tmp")
    tmp.write_bytes(pickle.dumps(out))
    tmp.replace(PRICES)
    log(f"prices: {len(out)}/{len(syms)} symbols in {time.time() - t0:.0f}s")
    return out, {"source": "net", "age_s": 0, "missing": [s for s in syms if s not in out]}


# --------------------------------------------------------------------------------------------- math
def _nanmedian_last(V):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmedian(V, axis=-1)


def rz(df: pd.DataFrame, win=ZWIN, minp=ZMIN, clip=3.0) -> pd.DataFrame:
    X = df.to_numpy(dtype=float)
    X[~np.isfinite(X)] = np.nan
    T, K = X.shape
    Xp = np.vstack([np.full((win - 1, K), np.nan), X])
    V = sliding_window_view(Xp, win, axis=0)          # (T, K, win)
    cnt = np.sum(~np.isnan(V), axis=-1)
    med = _nanmedian_last(V)
    mad = _nanmedian_last(np.abs(V - med[..., None]))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sd = np.nanstd(V, axis=-1)
    sc = np.maximum(1.4826 * mad, 0.25 * sd)
    z = np.where(sc > 1e-12, (X - med) / np.where(sc > 1e-12, sc, 1.0), 0.0)
    z[(cnt < minp) | np.isnan(X)] = np.nan
    return pd.DataFrame(np.clip(z, -clip, clip), index=df.index, columns=df.columns)


def pct_rank(df: pd.DataFrame, win=ZWIN, minp=ZMIN) -> pd.DataFrame:
    X = df.to_numpy(dtype=float)
    X[~np.isfinite(X)] = np.nan
    T, K = X.shape
    Xp = np.vstack([np.full((win - 1, K), np.nan), X])
    V = sliding_window_view(Xp, win, axis=0)
    x = X[..., None]
    cnt = np.sum(~np.isnan(V), axis=-1)
    p = 100.0 * (np.sum(V < x, axis=-1) + 0.5 * np.sum(V == x, axis=-1)) / np.maximum(cnt, 1)
    p[(cnt < minp) | np.isnan(X)] = np.nan
    return pd.DataFrame(p, index=df.index, columns=df.columns)


def mix(parts: list[tuple[float, pd.Series | None]]) -> pd.Series:
    """Σ w·z with missing parts dropped and the weights renormalised; NaN only if everything is missing."""
    num = None
    den = None
    for w, s in parts:
        if s is None:
            continue
        a = w * s.fillna(0)
        b = w * s.notna()
        num = a if num is None else num + a
        den = b if den is None else den + b
    if num is None:
        return None
    return (num / den.replace(0, np.nan)).clip(-3, 3)


def rsi14(c: pd.Series) -> pd.Series:
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def fronts_of(wind: pd.Series) -> pd.Series:
    w = wind.to_numpy()
    out = np.zeros(len(w))
    for t in range(10, len(w)):
        if not np.isfinite(w[t]) or abs(w[t]) <= 0.8:
            continue
        seg = w[t - 10:t - 4]
        seg = seg[np.isfinite(seg)]
        if not len(seg):
            continue
        v = seg[np.argmax(np.abs(seg))]
        if abs(v) > 0.5 and np.sign(v) != np.sign(w[t]):
            out[t] = 1.0 if w[t] > 0 else -1.0
    return pd.Series(out, index=wind.index)


def r(x, nd=2):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if math.isfinite(v) else None


def season_key(w, dw, p, crash=None):
    """§8.2; crash = crashgate.crash_at(...) or a level (0/1/2): a node falling hard never reads 春 / 夏 / 平稳
    (§8 amendment) → 秋 if p ≥ 50, else 冬."""
    if w is None or p is None:
        return None
    dw = dw or 0.0
    k = None
    if w > 0.3 and dw > 0.3 and p < 65:
        k = "spring"
    elif w > 0.3 and p >= 65:
        k = "summer"
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = "autumn"
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = "winter"
    return CG.gate_key(k, crash, p)


def crash_last(ser: dict) -> int:
    """0 | 1 急跌 | 2 崩 on the last day of a SERIES (its rounded idx, exactly what words.js crashAt reads)."""
    px = ser.get("idx") if isinstance(ser, dict) else None
    cr = CG.crash_at(px, len(px) - 1) if isinstance(px, list) and px else None
    return int(cr["level"]) if cr else 0


SEASON_ZH = {"spring": "🌱 春", "summer": "☀️ 夏", "autumn": "🍂 秋", "winter": "❄️ 冬"}


# --------------------------------------------------------------------------------------------- build
def build(px: dict[str, pd.DataFrame], cotdf: pd.DataFrame | None, cot_info: dict, log=print) -> dict:
    # calendar: weekdays on which CME equity futures or the dollar index printed
    base = [px[s].index for s in ("ES=F", "DX-Y.NYB", "ZN=F") if s in px]
    if not base:
        raise RuntimeError("no calendar instruments (ES=F / DX-Y.NYB)")
    cal = base[0]
    for b in base[1:]:
        cal = cal.union(b)
    cal = cal[cal.dayofweek < 5]
    keys = [x["key"] for x in INSTRUMENTS if x["sym"] in px]
    miss = [x["key"] for x in INSTRUMENTS if x["sym"] not in px]
    cnh_fallback = "1h" not in (px["USDCNH=X"].attrs.get("source", "") if "USDCNH=X" in px else "")
    if miss:
        log(f"  ! no prices for {miss}")
    I = {k: BY_KEY[k] for k in keys}

    O, H, L, C, V, Craw = {}, {}, {}, {}, {}, {}
    for k in keys:
        x = px[I[k]["sym"]].reindex(cal)
        c = x["Close"].ffill()
        o = x["Open"].fillna(c).ffill()
        h = x["High"].fillna(c).ffill()
        lo = x["Low"].fillna(c).ffill()
        Craw[k] = c
        if I[k]["invert"]:
            o, h, lo, c = 1 / o, 1 / lo, 1 / h, 1 / c
        O[k], H[k], L[k], C[k] = o, h, lo, c
        V[k] = x["Volume"].fillna(0.0)
    C, H, L, V, Craw = (pd.DataFrame(d) for d in (C, H, L, V, Craw))
    partial = partial_info(cal[-1])
    if partial:   # today's bar is still forming: scale its volume to a full-day estimate (§ phase-3 note)
        V.iloc[-1] = V.iloc[-1] / max(partial["fraction"], 0.05)

    ret = (C / C.shift(1) - 1).clip(-0.5, 0.5).fillna(0.0)
    rng = (H - L)
    clv = (((C - L) - (H - C)) / rng.where(rng > 0)).fillna(0.0).clip(-1, 1)
    vol20 = ret.rolling(20, min_periods=10).std()
    push = (0.5 * clv + 0.5 * np.tanh(ret / vol20.clip(lower=1e-4))).clip(-1, 1)
    ret5 = (1 + ret).rolling(5).apply(np.prod, raw=True) - 1
    ret20 = (1 + ret).rolling(20).apply(np.prod, raw=True) - 1
    ret60 = (1 + ret).rolling(60).apply(np.prod, raw=True) - 1
    mom = np.tanh(ret20 / (vol20.clip(lower=1e-4) * math.sqrt(20)))
    push5 = push.rolling(5, min_periods=3).sum()

    # usable volume? (continuous futures often carry the dying front month's volume)
    vol_ok = {}
    for k in keys:
        v = V[k]
        if I[k]["kind"] != "future" or (v.tail(252) > 0).mean() < 0.8:
            vol_ok[k] = False
            continue
        vol_ok[k] = bool(v.tail(60).median() >= 0.05 * v.tail(252).quantile(0.9))
    DV = pd.DataFrame({k: (Craw[k] * V[k] * I[k]["mult"]) if vol_ok[k] else np.nan for k in keys}, index=cal)
    MF = DV * push

    # CFTC
    oi, netp = {}, {}
    for k in keys:
        code = I[k]["cftc"]
        if cotdf is None or not code:
            continue
        dd = COT.daily(cotdf, code, cal)
        if dd is None or dd["oi"].notna().sum() < 60:
            continue
        oi[k], netp[k] = dd["oi"], dd["netPct"]
    OI = pd.DataFrame(oi, index=cal)
    NETP = pd.DataFrame(netp, index=cal)
    oi_chg20 = np.log(OI / OI.shift(20)) if len(oi) else pd.DataFrame(index=cal)
    oi_flow = (mom[OI.columns] * (0.3 + 0.7 * (0.5 + 0.5 * np.tanh(oi_chg20 / 0.05)))) if len(oi) else pd.DataFrame(index=cal)

    # group shares
    gmembers = {g["id"]: [k for k in keys if I[k]["group"] == g["id"]] for g in GROUPS}
    rot = pd.DataFrame(index=cal)
    flow5 = pd.DataFrame(index=cal)
    for gid, mem in gmembers.items():
        vk = [k for k in mem if vol_ok[k]]
        if not vk:
            continue
        dvg = DV[vk].sum(axis=1)
        for k in vk:
            S_ = DV[k] / dvg.where(dvg > 0)
            rot[k] = np.log(S_.rolling(5, min_periods=3).mean() / S_.rolling(60, min_periods=30).mean())
            flow5[k] = MF[k].rolling(5, min_periods=3).sum() / DV[k].rolling(60, min_periods=30).mean()

    Z = {}
    def z_of(name, df):
        if df is None or df.shape[1] == 0:
            Z[name] = pd.DataFrame(index=cal)
        else:
            Z[name] = rz(df.replace([np.inf, -np.inf], np.nan))
    z_of("rot", rot)
    z_of("flow5", flow5)
    z_of("oiFlow", oi_flow)
    z_of("push5", push5)
    z_of("mom", mom)
    z_of("ret20", ret20)

    gret = {}
    for gid, mem in gmembers.items():
        mm = [k for k in mem if k != "dxy"] or mem
        if mm:
            gret[gid] = ret[mm].mean(axis=1)
    GRET = pd.DataFrame(gret)
    g5 = (1 + GRET).rolling(5).apply(np.prod, raw=True) - 1
    g20 = (1 + GRET).rolling(20).apply(np.prod, raw=True) - 1
    rs = pd.DataFrame({k: 0.6 * (ret20[k] - g20[I[k]["group"]]) + 0.4 * (ret5[k] - g5[I[k]["group"]]) for k in keys})
    Z["rs"] = rz(rs)

    ma50 = C.rolling(50, min_periods=30).mean()
    dist = (C / ma50 - 1) / vol20.clip(lower=1e-4)
    rsi = pd.DataFrame({k: rsi14(C[k]) for k in keys})
    dvr = np.log(DV.rolling(20, min_periods=10).mean() / DV.rolling(120, min_periods=60).mean())
    zd, zr, zv = rz(dist), rz(rsi), rz(dvr)
    zn = rz(NETP) if NETP.shape[1] else pd.DataFrame(index=cal)

    wind, temp, pres, storm, front = {}, {}, {}, {}, {}
    method = {}
    for k in keys:
        has_oi = k in OI.columns
        if vol_ok[k] and has_oi:
            w = mix([(0.25, Z["rot"].get(k)), (0.35, Z["flow5"].get(k)), (0.40, Z["oiFlow"].get(k))])
            method[k] = "vol+oi"
        elif vol_ok[k]:
            w = mix([(0.5, Z["rot"].get(k)), (0.5, Z["flow5"].get(k))])
            method[k] = "vol"
        elif has_oi:
            w = mix([(0.5, Z["push5"].get(k)), (0.5, Z["oiFlow"].get(k))])
            method[k] = "price+oi"
        else:
            w = mix([(0.5, Z["push5"].get(k)), (0.5, Z["mom"].get(k))])
            method[k] = "price"
        wind[k] = w
        temp[k] = mix([(0.5, Z["ret20"][k]), (0.5, Z["rs"][k])])
        pp = [zd[k], zr[k]]
        if vol_ok[k]:
            pp.append(zv[k])
        if k in zn.columns:
            pp.append(zn[k])
        pres[k] = pd.concat(pp, axis=1).mean(axis=1, skipna=True)
        st5 = ret[k].rolling(5).std()
        st60 = ret[k].rolling(60, min_periods=30).std()
        storm[k] = (st5 / st60.where(st60 > 0) - 1).clip(0, 3)
    WIND = pd.DataFrame(wind)
    TEMP = pd.DataFrame(temp)
    PRES = pct_rank(pd.DataFrame(pres))
    STORM = pd.DataFrame(storm)
    FRONT = pd.DataFrame({k: fronts_of(WIND[k]) for k in keys})

    # groups + root
    G = {}
    for gid, mem in gmembers.items():
        if not mem:
            continue
        mm = [k for k in mem if k != "dxy"] or mem
        gw = WIND[mm].mean(axis=1).clip(-3, 3)
        G[gid] = {"ret": GRET[gid], "wind": gw, "pres": PRES[mem].mean(axis=1),
                  "dv": DV[mem].sum(axis=1, min_count=1), "mf": MF[mem].sum(axis=1, min_count=1)}
    root_ret = pd.DataFrame({g: G[g]["ret"] for g in G}).mean(axis=1)
    r20 = lambda s: (1 + s).rolling(20).apply(np.prod, raw=True) - 1  # noqa: E731
    r5 = lambda s: (1 + s).rolling(5).apply(np.prod, raw=True) - 1  # noqa: E731
    grs = pd.DataFrame({g: 0.6 * (r20(G[g]["ret"]) - r20(root_ret)) + 0.4 * (r5(G[g]["ret"]) - r5(root_ret)) for g in G})
    gz20 = rz(pd.DataFrame({g: r20(G[g]["ret"]) for g in G}))
    gzrs = rz(grs)
    for g in G:
        G[g]["temp"] = mix([(0.5, gz20[g]), (0.5, gzrs[g])])
        s5 = G[g]["ret"].rolling(5).std()
        s60 = G[g]["ret"].rolling(60, min_periods=30).std()
        G[g]["storm"] = (s5 / s60.where(s60 > 0) - 1).clip(0, 3)
        G[g]["front"] = fronts_of(G[g]["wind"])
    root = {"ret": root_ret, "wind": pd.DataFrame({g: G[g]["wind"] for g in G}).mean(axis=1),
            "pres": pd.DataFrame({g: G[g]["pres"] for g in G}).mean(axis=1),
            "temp": rz(pd.DataFrame({"x": r20(root_ret)}))["x"],
            "dv": pd.DataFrame({g: G[g]["dv"] for g in G}).sum(axis=1, min_count=1),
            "mf": pd.DataFrame({g: G[g]["mf"] for g in G}).sum(axis=1, min_count=1)}
    s5 = root_ret.rolling(5).std()
    s60 = root_ret.rolling(60, min_periods=30).std()
    root["storm"] = (s5 / s60.where(s60 > 0) - 1).clip(0, 3)
    root["front"] = fronts_of(root["wind"])

    # ---------------------------------------------------------------- output window
    meta = net.read_json(META, {})
    if meta.get("dates") and len(meta["dates"]) >= 60:
        out_dates = list(meta["dates"])
        ix = cal.get_indexer(pd.to_datetime(out_dates), method="ffill")
        if (ix < 0).any():
            out_dates = [d.strftime("%Y-%m-%d") for d in cal[-WIN:]]
            ix = np.arange(len(cal) - len(out_dates), len(cal))
        # the macro data may run a day ahead of the stock map (FX/futures trade on US holidays): extend
        last_cal = cal[-1]
        if last_cal > pd.Timestamp(out_dates[-1]):
            extra = [d for d in cal if d > pd.Timestamp(out_dates[-1])]
            out_dates = out_dates[len(extra):] + [d.strftime("%Y-%m-%d") for d in extra]
            ix = np.concatenate([ix[len(extra):], cal.get_indexer(extra)])
    else:
        out_dates = [d.strftime("%Y-%m-%d") for d in cal[-WIN:]]
        ix = np.arange(len(cal) - WIN, len(cal))
    n = len(ix)

    def take(s: pd.Series | None, nd=2):
        if s is None:
            return [None] * n
        a = s.to_numpy()[ix]
        return [r(v, nd) for v in a]

    def idx_of(rt: pd.Series):
        a = rt.to_numpy()[ix].copy()
        a[0] = 0.0
        a = np.nan_to_num(a)
        return [round(float(v), 2) for v in 100 * np.cumprod(1 + a)]

    def series(rt, w, t, p, st, fr, mf, dv):
        return {"wind": take(w), "temp": take(t), "pres": [None if v is None else int(round(v)) for v in take(p, 1)],
                "storm": take(st), "front": [int(v or 0) for v in take(fr, 0)], "idx": idx_of(rt),
                "flow": take(None if mf is None else mf / 1e6, 1), "dv": take(None if dv is None else dv / 1e6, 1)}

    last = ix[-1]
    asof = out_dates[-1]

    def now_of(rt, w, t, p, st, fr, mf, dv):
        f5 = None if mf is None else mf.iloc[max(0, last - 4):last + 1].sum(min_count=1) / 1e6
        d20 = None if dv is None else dv.iloc[max(0, last - 19):last + 1].mean() / 1e6
        g = lambda s, j=last: (None if s is None else s.iloc[j])  # noqa: E731
        return {"wind": r(g(w)), "temp": r(g(t)), "pres": None if g(p) is None or not np.isfinite(g(p)) else int(round(g(p))),
                "storm": r(g(st)), "front": int(g(fr) or 0),
                "ret1": r(rt.iloc[last], 4), "ret5": r(r5(rt).iloc[last], 4), "ret20": r(r20(rt).iloc[last], 4),
                "flow5": r(f5, 1), "dv20": r(d20, 1)}

    items, nodes_by_group, maps = {}, {}, {}
    for k in keys:
        x = I[k]
        mf = MF[k] if vol_ok[k] else None
        dv = DV[k] if vol_ok[k] else None
        ser = series(ret[k], WIND[k], TEMP[k], PRES[k], STORM[k], FRONT[k], mf, dv)
        nw = now_of(ret[k], WIND[k], TEMP[k], PRES[k], STORM[k], FRONT[k], mf, dv)
        nw["crash"] = crash_last(ser)          # same field as tree.json now.crash (compute.py)
        w5 = WIND[k].iloc[max(0, last - 5)]
        dw = None if nw["wind"] is None or not np.isfinite(w5) else nw["wind"] - w5
        sk = season_key(nw["wind"], dw, nw["pres"], nw["crash"])
        basis, conf = basis_of(method[k], x, cnh_fallback)
        cot_blk = cot_block(k, OI, NETP, cotdf, x, last, cal)
        facts = {"ret5": nw["ret5"], "ret20": nw["ret20"], "ret60": r(ret60[k].iloc[last], 4),
                 "high52": r(Craw[k].iloc[max(0, last - 251):last + 1].max(), 4),
                 "low52": r(Craw[k].iloc[max(0, last - 251):last + 1].min(), 4),
                 "vol20y": r(vol20[k].iloc[last] * math.sqrt(252), 4),
                 "quoteChg1": r(Craw[k].iloc[last] / Craw[k].iloc[last - 1] - 1, 4),
                 "quoteChg20": r(Craw[k].iloc[last] / Craw[k].iloc[last - 20] - 1, 4)}
        say, mild = item_say(k, x, nw, dw, cot_blk, facts)
        node = {"id": x["id"], "ticker": x["sym"], "name": x["name"], "note": x["note"], "kind": "macro", "depth": 2,
                "tags": next((g["tags"] for g in GROUPS if g["id"] == x["group"]), []), "now": nw,
                "est": True, "basis": basis, "conf": conf, "season": sk}
        nodes_by_group.setdefault(x["group"], []).append(node)
        items[x["id"]] = {
            "id": x["id"], "key": k, "sym": x["sym"], "name": x["name"], "group": x["group"], "kind": x["kind"],
            "quote": x["quote"], "note": x["note"], "invert": x["invert"],
            "last": r(Craw[k].iloc[last], 4), "lastDate": px[x["sym"]].index[-1].strftime("%Y-%m-%d"),
            "now": nw, "facts": facts, "cot": cot_blk, "volumeOk": vol_ok[k], "method": method[k],
            "est": True, "estParts": {"wind": True, "price": k == "vx" or (k == "cnh" and cnh_fallback),
                                      "cot": False if cot_blk else None},
            "basis": basis, "conf": conf, "season": sk, "dw": r(dw), "say": say, "sayMild": mild,
            "c": take(Craw[k], 4), "series": ser,
        }
    group_nodes = []
    for g in GROUPS:
        gid = g["id"]
        if gid not in G:
            continue
        gg = G[gid]
        mf = gg["mf"] if gg["mf"].notna().any() else None
        dv = gg["dv"] if gg["dv"].notna().any() else None
        ser = series(gg["ret"], gg["wind"], gg["temp"], gg["pres"], gg["storm"], gg["front"], mf, dv)
        nw = now_of(gg["ret"], gg["wind"], gg["temp"], gg["pres"], gg["storm"], gg["front"], mf, dv)
        nw["crash"] = crash_last(ser)
        kids = nodes_by_group.get(gid, [])
        maps[gid] = {"id": gid, "self": ser, "children": {it["id"]: items[it["id"]]["series"] for it in kids}}
        w5 = gg["wind"].iloc[max(0, last - 5)]
        group_nodes.append({"id": gid, "name": g["name"], "emoji": g["emoji"], "desc": g["desc"], "kind": "region",
                            "depth": 1, "tags": g["tags"], "nStocks": len(kids), "now": nw, "est": True,
                            "season": season_key(nw["wind"], None if not np.isfinite(w5) else nw["wind"] - w5, nw["pres"],
                                                 nw["crash"]),
                            "children": kids, "_ser": ser})
    root_ser = series(root["ret"], root["wind"], root["temp"], root["pres"], root["storm"], root["front"],
                      root["mf"], root["dv"])
    maps["macro"] = {"id": "macro", "self": root_ser, "children": {g["id"]: g.pop("_ser") for g in group_nodes}}
    root_now = now_of(root["ret"], root["wind"], root["temp"], root["pres"], root["storm"], root["front"],
                      root["mf"], root["dv"])
    root_now["crash"] = crash_last(root_ser)
    tree = {"id": "macro", "name": "宏观", "emoji": "🌐", "desc": "外汇、美债、股指、能源、金属、农产品期货：大钱的方向盘。",
            "kind": "region", "depth": 0, "tags": [], "nStocks": len(items),
            "now": root_now,
            "est": True, "children": group_nodes}
    for it in items.values():
        it.pop("series", None)   # the series live in maps[group].children

    # ---------------------------------------------------------------- attention
    picks = []
    for gid, mp in maps.items():
        if gid == "macro":
            continue
        for cid, s in mp["children"].items():
            sc, parts = surprise(s, n - 1)
            picks.append((sc, cid, parts))
    picks.sort(key=lambda t: -t[0])
    spotlight = []
    for sc, cid, parts in picks[:3]:
        it = items[cid]
        spotlight.append({"id": cid, "name": it["name"], "pathIds": ["macro", it["group"], cid],
                          "path": f"宏观 › {next(g['name'] for g in GROUPS if g['id'] == it['group'])} › {it['name']}",
                          "why": it["say"], "score": round(sc, 2), "kind": parts})
    gw = sorted(((g["now"]["wind"] or 0, g["id"], g["name"]) for g in group_nodes))
    # §8 amendment: a group that is crashing is never the inflow end of the main channel
    crashing = {g["id"] for g in group_nodes if g["now"].get("crash")}
    gw = [x for x in gw[:1]] + [x for x in gw[1:] if x[1] not in crashing] if gw else gw
    channel = None
    if len(gw) >= 2 and gw[0][0] < -0.2 and gw[-1][0] > 0.2:
        channel = {"from": gw[0][1], "to": gw[-1][1],
                   "say": f"宏观主航道：钱从【{gw[0][2]}】流向【{gw[-1][2]}】"}
    fronts = [{"id": it["id"], "name": it["name"], "dir": it["now"]["front"],
               "say": f"{it['name']}风向刚变：{'钱开始流入' if it['now']['front'] > 0 else '钱开始撤离'}"}
              for it in items.values() if it["now"]["front"]]
    headline, say, mild = macro_headline(items, spotlight)
    brief = [{"id": s["id"], "text": f"{s['name']}：{fact_line(items[s['id']])}", "say": items[s["id"]]["say"],
              "sayMild": items[s["id"]]["sayMild"]} for s in spotlight]

    extras = {}
    if "^VIX3M" in px and "^VIX" in px:
        v = px["^VIX"]["Close"].iloc[-1]
        v3 = px["^VIX3M"]["Close"].iloc[-1]
        ratio = v / v3 if v3 else None
        extras["vixTerm"] = {"vix": r(v), "vix3m": r(v3), "ratio": r(ratio, 3),
                             "say": ("近月恐慌比三个月后还高（倒挂），市场在怕眼前的事。" if ratio and ratio > 1 else
                                     "恐慌曲线正常向上，市场没在怕眼前的事。")}
    if "USDCNH=X" in px and len(px["USDCNH=X"]):
        src = px["USDCNH=X"].attrs.get("source", "")
        extras["cnhSpot"] = {"last": r(px["USDCNH=X"]["Close"].iloc[-1], 4),
                             "date": px["USDCNH=X"].index[-1].strftime("%Y-%m-%d"),
                             "note": ("离岸人民币最新价（Yahoo 小时价拼成的日线，每天纽约 17:00 收）" if "1h" in src else
                                      "离岸价拿不到，这里是在岸人民币 CNY")}

    return {
        "asOf": asof, "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "Yahoo Finance (yfinance) daily FX/futures/indices; CFTC Commitments of Traders (legacy, futures only)",
        "note": "强弱口径：涨=钱流进它（USD/XXX 报价已取倒数，=该货币变强）。风/温度/拥挤度跟它自己过去一年比。"
                "钱的流向是用价格、成交量和持仓量推断的（est:true），CFTC 持仓是真实数据。",
        "cotAsOf": cot_info.get("last"), "dates": out_dates, "tree": tree, "maps": maps, "items": items,
        "headline": headline, "say": say, "sayMild": mild, "channel": channel, "spotlight": spotlight,
        "fronts": fronts, "brief": brief, "extras": extras, "partial": partial,
        "missing": miss,
    }


def basis_of(method: str, x: dict, cnh_fallback: bool = False) -> tuple[str, float]:
    b = {"vol+oi": ("按价格动量、成交额和 CFTC 持仓量推断钱的流向", 0.6),
         "vol": ("按价格动量和成交额推断（没有持仓数据）", 0.5),
         "price+oi": ("没有可用成交量，按价格动作和 CFTC 持仓量推断", 0.45),
         "price": ("只有价格，按价格动量推断", 0.3)}[method]
    basis, conf = b
    if x["key"] == "vx":
        basis = "VIX 期货价格拿不到，用 VIX 指数代替；" + basis
        conf -= 0.1
    if x["key"] == "cnh" and cnh_fallback:
        basis = "离岸人民币的小时价拿不到，用在岸人民币代替；" + basis
        conf -= 0.05
    return basis, round(conf, 2)


def cot_block(k, OI, NETP, cotdf, x, last, cal):
    if k not in OI.columns or cotdf is None:
        return None
    oi = OI[k]
    np_ = NETP[k]
    rows = cotdf[cotdf["code"] == x["cftc"]].sort_values("date")
    rows = rows[rows["known"] <= cal[last]]
    if rows.empty:
        return None
    lr = rows.iloc[-1]
    hist = (rows["ncl"] - rows["ncs"]) / rows["oi"]
    hist3 = hist.tail(156)
    cur = float(hist.iloc[-1])
    pctile = float((hist3 < cur).mean() * 100 + 0.5 * (hist3 == cur).mean() * 100)
    o1 = rows["oi"].iloc[-2] if len(rows) >= 2 else None
    o4 = rows["oi"].iloc[-5] if len(rows) >= 5 else None
    side = "净多" if cur > 0 else "净空"
    crowd = ("挤到顶了" if pctile >= 90 else "很挤" if pctile >= 75 else "很冷清" if pctile <= 10 else
             "偏冷" if pctile <= 25 else "正常")
    return {"asOf": lr["date"].strftime("%Y-%m-%d"), "known": lr["known"].strftime("%Y-%m-%d"),
            "oi": int(lr["oi"]), "oiChg1w": r(lr["oi"] / o1 - 1 if o1 else None, 4),
            "oiChg4w": r(lr["oi"] / o4 - 1 if o4 else None, 4),
            "netSpec": int(lr["ncl"] - lr["ncs"]), "netSpecPct": r(cur, 4), "netSpecPctile": int(round(pctile)),
            "est": False, "market": lr["market"],
            "say": f"投机盘{side} {abs(cur) * 100:.0f}% 的持仓，三年里排第 {int(round(pctile))} 百分位——{crowd}。"}


def item_say(k, x, nw, dw, cot_blk, facts) -> tuple[str, str]:
    """§12: one sharp line from the data. Price, money (wind) and open interest must never contradict each
    other on one card: when they disagree, the sentence says so plainly (多空在打架 / 空头平仓 …)."""
    name = x["name"]
    w = nw["wind"] or 0.0
    r20 = nw["ret20"] or 0.0
    up, dn = FLAVOR.get(k, (f"{name}在被买。", f"{name}在被抛。"))
    d = 1 if w >= 0.5 else (-1 if w <= -0.5 else 0)
    oc = (cot_blk or {}).get("oiChg4w")
    oi = None
    if oc is not None:
        if r20 > 0.01 and oc < -0.05:
            oi = "cover"
        elif r20 < -0.01 and oc > 0.05:
            oi = "short"
        elif r20 > 0.01 and oc > 0.08:
            oi = "long"
        elif r20 < -0.01 and oc < -0.08:
            oi = "liquidate"
    ocp = f"{abs(oc) * 100:.0f}%" if oc is not None else ""
    mod_ok = True
    if d > 0:
        mild = f"{name}资金在流入（跟它自己过去一年比）。"
        if oi == "cover":
            main, mod_ok = f"{name}在涨，但多半是空头在平仓，新钱没那么多。", False
        elif oi == "short":
            main, mod_ok = f"{name}短线有钱抄底，可持仓在加空——多空在打架。", False
        elif oi == "long":
            main, mod_ok = up + f"持仓四周多了 {ocp}，是真金白银在进。", False
        elif r20 < -0.005:
            main = f"{name}价格还在跌，但钱已经在偷偷进来。"
        else:
            main = up
    elif d < 0:
        mild = f"{name}资金在流出（跟它自己过去一年比）。"
        if oi == "short":
            main, mod_ok = dn + "持仓还在加，有人在押更低。", False
        elif oi == "cover":
            main, mod_ok = f"{name}价格在涨，但钱在撤——涨是空头平仓撑的。", False
        elif oi == "liquidate":
            main, mod_ok = dn + f"持仓四周少了 {ocp}，多头在认赔离场。", False
        elif oi == "long":
            main, mod_ok = f"{name}价格在涨、持仓在加，可成交里卖的更多——多空在打架。", False
        elif r20 > 0.005:
            main = f"{name}价格还在涨，但钱已经在撤。"
        else:
            main = dn
    else:
        mild = f"{name}资金进出平衡。"
        main = {"cover": f"{name}在涨，但那是空头在平仓，不是新钱。",
                "short": f"{name}在跌，持仓在加，有人在押更低。",
                "long": f"{name}在涨，持仓也在加，钱在悄悄进。",
                "liquidate": f"{name}在跌，多头在认赔离场。"}.get(oi, f"{name}风平浪静，钱没怎么动。")
        mod_ok = oi is None
    mod = None
    p = nw["pres"]
    if p is not None and p >= 85 and d >= 0:
        mod = f"挤满了人（拥挤度 {p}），小心踩踏。"
    elif p is not None and p <= 12 and d <= 0:
        mod = f"冷清得没人管（拥挤度 {p}）。"
    elif (nw["storm"] or 0) >= 1.5:
        if d == 0 and oi is None:
            main = f"{name}的钱没怎么动，可波动突然放大——风暴来了。"
        else:
            mod = "波动突然放大，风暴来了。"
    elif cot_blk and cot_blk["netSpecPctile"] >= 92 and cot_blk["netSpecPct"] > 0:
        mod = "投机盘多头挤到三年最高，一松手就是踩踏。"
    elif cot_blk and cot_blk["netSpecPctile"] <= 8 and cot_blk["netSpecPct"] < 0:
        mod = "投机盘空头挤到三年最多，一反弹就是逼空。"
    if mod and (mod_ok or mod.startswith(("投机盘", "波动"))):
        main += mod
    return main, mild


def fact_line(it) -> str:
    f = it["facts"]
    q = it["quote"]
    parts = [f"{q} {it['last']:g}" if it["last"] is not None else q]
    if f.get("ret20") is not None:
        parts.append(f"四周{'+' if f['ret20'] >= 0 else ''}{f['ret20'] * 100:.1f}%")
    if it.get("cot"):
        parts.append(f"投机{'净多' if it['cot']['netSpecPct'] > 0 else '净空'} {abs(it['cot']['netSpecPct']) * 100:.0f}%")
    return "，".join(parts)


def surprise(s: dict, i: int) -> tuple[float, str]:
    w = s["wind"][i]
    if w is None:
        return 0.0, "none"
    j = max(0, i - 5)
    w5 = s["wind"][j] if s["wind"][j] is not None else w
    t = s["temp"][i] or 0.0
    t5 = s["temp"][j] if s["temp"][j] is not None else t
    f = s["front"][i] or 0
    st = s["storm"][i] or 0.0
    p = s["pres"][i]
    sc = 0.45 * abs(w - w5) + 0.25 * abs(w) + 0.15 * abs(t - t5) + 0.6 * abs(f) + 0.3 * (st >= 0.8) + \
        0.2 * (p is not None and (p >= 90 or p <= 10))
    sk = season_key(w, w - w5, p, CG.crash_at(s.get("idx"), i))   # gated (§8 amendment): no 🌱 bonus mid-crash
    if sk == "spring":
        sc += 0.5
    kind = "front" if f else ("storm" if st >= 0.8 else ("crowded" if p is not None and p >= 90 else
                                                          ("inflow" if w > 0 else "outflow")))
    return sc, kind


def macro_headline(items: dict, spotlight: list) -> tuple[str, str, str]:
    dxy = items.get("m:DXY")
    parts = []
    if spotlight:
        top = items[spotlight[0]["id"]]
        parts.append(top["say"].split("。")[0] + "。")
    verbs = []
    for s in spotlight[1:3]:
        it = items[s["id"]]
        w = it["now"]["wind"] or 0
        v = "被疯抢" if w >= 1.5 else "有钱进" if w >= 0.5 else "被狂抛" if w <= -1.5 else "在失血" if w <= -0.5 else "没动静"
        if "打架" in it["say"]:
            v = "多空在打架"
        elif "空头在平仓" in it["say"] or "空头平仓" in it["say"]:
            v = "靠空头平仓在涨"
        verbs.append(f"{it['name']}{v}")
    if verbs:
        parts.append("、".join(verbs) + "。")
    head = "".join(parts) or "宏观风平浪静。"
    say = head
    if dxy and dxy["id"] not in [s["id"] for s in spotlight]:
        w = dxy["now"]["wind"] or 0
        if abs(w) >= 0.5:
            say = head + (FLAVOR["dxy"][0] if w > 0 else FLAVOR["dxy"][1])
    mild = "；".join(f"{items[s['id']]['name']}：{fact_line(items[s['id']])}" for s in spotlight) or "宏观资金进出平衡。"
    return head, say, mild


# --------------------------------------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--quick", action="store_true", help="intraday refresh: prices younger than 10 min are reused")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    log = (lambda *x, **k: None) if a.quiet else print
    t0 = time.time()
    global PRICE_TTL_S
    if a.quick:
        PRICE_TTL_S = 10 * 60
    try:
        px, pinfo = fetch_prices(force=a.force, offline=a.offline, log=log)
    except Exception as e:
        print(f"macro: no prices ({e}); keeping the previous file", file=sys.stderr)
        return 2
    if a.offline:
        COT.TTL_S = 10 ** 12
    cotdf, cinfo = COT.fetch([x["cftc"] for x in INSTRUMENTS], force=a.force, log=log)
    if cotdf is None:
        log(f"  ! CFTC unavailable ({cinfo.get('error', '')[:120]}) — winds use price/volume only")
    out = build(px, cotdf, cinfo, log=log)
    net.write_json(Path(a.out), out)
    log(f"wrote {a.out} ({Path(a.out).stat().st_size / 1024:.0f} KB) in {time.time() - t0:.1f}s — asOf {out['asOf']}, "
        f"{len(out['items'])} instruments, CFTC {out['cotAsOf']}")
    log(f"headline: {out['headline']}")
    if out["channel"]:
        log(f"channel: {out['channel']['say']}")
    for g in out["tree"]["children"]:
        log(f"  {g['emoji']} {g['name']:<6} wind {g['now']['wind']!s:>6} temp {g['now']['temp']!s:>6} pres {g['now']['pres']!s:>4}")
        for c in g["children"]:
            it = out["items"][c["id"]]
            log(f"      {c['name']:<8} {it['method']:<9} w {c['now']['wind']!s:>6} t {c['now']['temp']!s:>6} "
                f"p {c['now']['pres']!s:>4} s {c['now']['storm']!s:>5} r20 {c['now']['ret20']!s:>7}  {it['say']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
