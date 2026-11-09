#!/usr/bin/env python3
"""fetch.py — download daily OHLCV for every ticker in universe/universe.json (+ SPY + atmosphere)
into cache/prices.pkl (DESIGN.md §2: yfinance, period=2y, auto_adjust=True).

    python3 pipeline/fetch.py            # reuse tickers fetched < 6 h ago (and after the last close)
    python3 pipeline/fetch.py --force    # re-download everything
    python3 pipeline/fetch.py --quick    # only the last 5 sessions (incl. today's partial bar), merged in place

--quick (update.sh --quick, the loop's 15-minute market refresh): one period="5d" pass for every ticker,
rows merged over the cache without touching the "fetched" stamps (so the next full update still re-downloads
everything after the close). A ticker whose overlapping close disagrees with the cache by > 1.5 % (a split or
dividend re-adjusted its history) gets its full 2 years again. cache["quick"] = {date, at, partial} tells
compute.py whether the newest row is a still-forming session. cache["barAt"][ticker] = when that ticker's
newest rows were downloaded (every mode) — compute.py uses it to know how much of today's session a
still-forming bar has seen (pipeline/session.py) and scales its volume to a full-day estimate.

Batches of ~80 tickers, retries with back-off, failed tickers retried in small batches.
Cache format (pickle): {"version":1, "fields":{"Open"|"High"|"Low"|"Close"|"Volume": DataFrame(date × ticker)},
                        "fetched":{ticker: iso-time}, "failed":{ticker: iso-time}, "period":"2y",
                        "barAt":{ticker: iso-time of the download that gave its newest rows}, "quick":{…},
                        "filled":{date: {"tickers": [...], "at": iso-time, "source": "60m"}}}

Filled bars (every mode): a finished session whose daily bar came back with Volume but no Close (a Yahoo hiccup,
seen 2026-11-04: still so 4½ h after the bell; with auto_adjust the Open/High/Low go NaN too) is rebuilt from the
same day's 60-minute bars and listed in cache["filled"]. compute.py passes the list on as meta.filled (the page
says 「补」), and every later fetch downloads those tickers again until Yahoo has the real bar.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import pickle
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE = ROOT / "universe" / "universe.json"
CACHE = ROOT / "cache" / "prices.pkl"
NY = ZoneInfo("America/New_York")
FIELDS = ["Open", "High", "Low", "Close", "Volume"]
CALENDAR = "SPY"
ATMOSPHERE = ["^VIX", "^TNX", "DX-Y.NYB", "HYG", "IEF"]
PERIOD = "2y"
FILL_INTERVAL = "60m"   # the bars a missing daily close is rebuilt from
FILL_LOOKBACK = 5       # newest cache rows checked for a finished session without a close


def universe_tickers(path: Path = UNIVERSE) -> list[str]:
    tree = json.loads(path.read_text(encoding="utf-8"))
    out: list[str] = []
    seen = set()

    def walk(n):
        for s in n.get("stocks", []):
            if s["t"] not in seen:
                seen.add(s["t"])
                out.append(s["t"])
        for c in n.get("children", []):
            walk(c)

    walk(tree)
    return out


def last_close_before(now: datetime) -> datetime:
    """Most recent weekday 16:15 New York time at or before `now` (holidays ignored — harmless)."""
    t = now.astimezone(NY)
    cand = t.replace(hour=16, minute=15, second=0, microsecond=0)
    if cand > t:
        cand -= timedelta(days=1)
    while cand.weekday() >= 5:
        cand -= timedelta(days=1)
    return cand


def is_fresh(fetched_iso: str | None, now: datetime, max_age_h: float) -> bool:
    if not fetched_iso:
        return False
    try:
        f = datetime.fromisoformat(fetched_iso)
    except ValueError:
        return False
    if f.tzinfo is None:
        f = f.replace(tzinfo=NY)
    if now - f > timedelta(hours=max_age_h):
        return False
    # a market close happened after we fetched → the last bar we have may be partial / missing
    return f >= last_close_before(now)


def load_cache() -> dict:
    if CACHE.exists():
        try:
            with open(CACHE, "rb") as fh:
                c = pickle.load(fh)
            if c.get("version") == 1:
                return c
        except Exception as e:  # noqa: BLE001
            print(f"  cache unreadable ({e}); starting fresh")
    return {"version": 1, "fields": {f: pd.DataFrame() for f in FIELDS}, "fetched": {}, "failed": {},
            "period": PERIOD}


def save_cache(c: dict) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".pkl.tmp")
    with open(tmp, "wb") as fh:
        pickle.dump(c, fh, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, CACHE)


def _normalise_index(df: pd.DataFrame) -> pd.DataFrame:
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    df = df.copy()
    df.index = idx.normalize()
    df = df[~df.index.duplicated(keep="last")]
    return df.sort_index()


def _ny_index(df: pd.DataFrame) -> pd.DataFrame:
    """Intraday bars: New York wall-clock timestamps (tz dropped), so .normalize() gives the session date."""
    idx = pd.DatetimeIndex(df.index)
    idx = idx.tz_convert(NY).tz_localize(None) if idx.tz is not None else idx
    df = df.copy()
    df.index = idx
    df = df[~df.index.duplicated(keep="last")]
    return df.sort_index()


def split_fields(raw: pd.DataFrame, tickers: list[str], daily: bool = True) -> dict[str, pd.DataFrame]:
    """yfinance frame → {field: DataFrame(date × ticker)} (daily=False: NY bar times × ticker); tolerates both
    column layouts."""
    out = {}
    if raw is None or raw.empty:
        return {f: pd.DataFrame() for f in FIELDS}
    norm = _normalise_index if daily else _ny_index
    cols = raw.columns
    if isinstance(cols, pd.MultiIndex):
        lvl0 = set(cols.get_level_values(0))
        price_first = bool(lvl0 & set(FIELDS))
        for f in FIELDS:
            try:
                sub = raw[f] if price_first else raw.xs(f, axis=1, level=1)
            except KeyError:
                sub = pd.DataFrame(index=raw.index)
            if isinstance(sub, pd.Series):
                sub = sub.to_frame(tickers[0])
            out[f] = norm(sub.astype(float))
    else:  # single ticker, flat columns
        for f in FIELDS:
            s = raw[f] if f in raw.columns else pd.Series(index=raw.index, dtype=float)
            out[f] = norm(s.astype(float).to_frame(tickers[0]))
    return out


def download(tickers: list[str], period: str, attempts: int = 3) -> dict[str, pd.DataFrame]:
    import yfinance as yf

    last_err = None
    for a in range(attempts):
        try:
            raw = yf.download(tickers, period=period, interval="1d", auto_adjust=True, actions=False,
                              progress=False, threads=True, group_by="column", timeout=30)
            return split_fields(raw, tickers)
        except Exception as e:  # noqa: BLE001
            last_err = e
            wait = 3 * (2 ** a)
            print(f"    download error ({type(e).__name__}: {e}); retry in {wait}s")
            time.sleep(wait)
    print(f"    giving up on batch of {len(tickers)}: {last_err}")
    return {f: pd.DataFrame() for f in FIELDS}


def good_columns(fields: dict[str, pd.DataFrame]) -> list[str]:
    c = fields.get("Close")
    if c is None or c.empty:
        return []
    return [t for t in c.columns if c[t].notna().sum() > 0]


def merge_into(cache: dict, new: dict[str, pd.DataFrame], tickers: list[str]) -> None:
    for f in FIELDS:
        old = cache["fields"].get(f, pd.DataFrame())
        add = new.get(f, pd.DataFrame())
        add = add[[t for t in tickers if t in add.columns]] if not add.empty else add
        if not old.empty:
            old = old.drop(columns=[t for t in tickers if t in old.columns])
        if old.empty:
            # (every column replaced: keep the old dates, so a day we hold bars for can still be restored)
            merged = add.reindex(add.index.union(old.index)) if len(old.index) and not add.empty else add
        elif add.empty:
            merged = old
        else:
            merged = pd.concat([old, add], axis=1)
        cache["fields"][f] = merged.sort_index()
    # drop dates nobody has any more (a date with volume but no close at all is a Yahoo hole fill_holes() repairs)
    close = cache["fields"]["Close"]
    vol = cache["fields"]["Volume"].reindex(index=close.index)
    keep = close.notna().any(axis=1) | vol.fillna(0).gt(0).any(axis=1)
    held = [pd.Timestamp(d) for d, e in (cache.get("filled") or {}).items() if e.get("bars")]
    keep |= close.index.isin(held)  # (a day we hold rebuilt bars for stays, so restore_filled() can put them back)
    if not keep.all():
        for f in FIELDS:
            cache["fields"][f] = cache["fields"][f].reindex(keep.index[keep])


def session_done(day: pd.Timestamp, now: datetime) -> bool:
    """The New York session of `day` has ended (the 16:15 cut compute.py uses for a still-forming bar)."""
    t = now.astimezone(NY)
    d = day.date()
    return d < t.date() or (d == t.date() and t.hour * 60 + t.minute >= 16 * 60 + 15)


def find_holes(cache: dict, now: datetime, lookback: int = FILL_LOOKBACK) -> dict[pd.Timestamp, list[str]]:
    """{day: tickers}: finished sessions among the newest cache rows whose daily bar has Volume but no Close."""
    F = cache["fields"]
    close = F.get("Close", pd.DataFrame())
    if close.empty:
        return {}
    vol = F.get("Volume", pd.DataFrame()).reindex(index=close.index, columns=close.columns)
    out = {}
    for day in close.index[-lookback:]:
        if not session_done(day, now):
            continue
        miss = close.columns[close.loc[day].isna().values & vol.loc[day].fillna(0).gt(0).values]
        if len(miss):
            out[day] = list(miss)
    return out


def clear_filled(cache: dict, got: dict[str, pd.DataFrame], tickers: list[str]) -> None:
    """Yahoo now has a real close for a bar we filled earlier → it is no longer ours to mark (or to restore)."""
    filled = cache.get("filled") or {}
    c = got.get("Close", pd.DataFrame())
    if not filled or c.empty:
        return
    for day in list(filled):
        ts = pd.Timestamp(day)
        if ts not in c.index:
            continue
        real = {t for t in tickers if t in c.columns and pd.notna(c.at[ts, t])}
        _unmark(filled, day, real)


def _unmark(filled: dict, day: str, tickers, keep_bars: bool = False) -> None:
    """Drop the 「补」 mark for `tickers` on `day`; keep_bars=False also forgets their stored bars (Yahoo's own
    adjusted bar is in). An entry goes when it neither marks nor holds anything."""
    e = filled.get(day)
    if not e or not tickers:
        return
    e["tickers"] = [t for t in e.get("tickers", []) if t not in tickers]
    e["ohlc60"] = [t for t in e.get("ohlc60", []) if t not in tickers]
    if not keep_bars:
        e["bars"] = {t: b for t, b in (e.get("bars") or {}).items() if t not in tickers}
    if not e["tickers"] and not e.get("bars"):
        del filled[day]


def _prev_close(close: pd.DataFrame, ts: pd.Timestamp, t: str) -> float | None:
    pos = close.index.get_loc(ts)
    if not isinstance(pos, int) or pos == 0 or t not in close.columns:
        return None
    v = close.iloc[pos - 1][t]
    return float(v) if pd.notna(v) else None


def restore_filled(cache: dict) -> int:
    """Put the bars we wrote back where a fresh download blanked them again (Yahoo still without the adjusted close):
    merge_into replaces a ticker's whole column, and the 60-minute bars may be gone by then (a failed download,
    or the day older than their 5-day window) — the day must not drop out of the calendar again.
    Each bar keeps the previous day's close it was written next to; if a split or dividend has re-adjusted the
    history since, the bar is scaled by the same factor (new previous close / old one) before it goes back."""
    F = cache["fields"]
    close = F["Close"]
    n = 0
    for day, e in sorted((cache.get("filled") or {}).items()):  # (oldest first: a day's previous close is back first)
        ts = pd.Timestamp(day)
        if ts not in close.index:
            continue
        bars = e.get("bars") or {}
        for t, b in list(bars.items()):
            if t not in close.columns or len(b) < 4:
                continue
            ref = b[4] if len(b) > 4 else None
            prev = _prev_close(close, ts, t)
            if ref and prev and abs(prev / ref - 1) > 1e-6:
                k = prev / ref
                b = [v * k for v in b[:4]] + [prev] + list(b[5:])
                bars[t] = b
            if pd.isna(close.at[ts, t]):
                for f, v in zip(("Open", "High", "Low", "Close"), b[:4]):
                    F[f].at[ts, t] = float(v)
                # (the volume too, when the whole row went missing: compute.py's calendar needs SPY's volume > 0)
                if len(b) > 5 and b[5] and t in F["Volume"].columns and not F["Volume"].at[ts, t] > 0:
                    F["Volume"].at[ts, t] = float(b[5])
                n += 1
    return n


def refill_tickers(cache: dict, want: list[str]) -> set[str]:
    """Tickers we hold a written bar for among the newest rows — downloaded again every full fetch until Yahoo has
    the real (adjusted) bar. Older ones (Yahoo never fixed it, or the ticker left the universe) stay as they are,
    but stop costing downloads."""
    close = cache["fields"]["Close"]
    recent = {str(d.date()) for d in close.index[-FILL_LOOKBACK:]} if not close.empty else set()
    keep = set(want)
    return {t for day, e in (cache.get("filled") or {}).items() if day in recent
            for t in (e.get("bars") or {}) if t in keep}


def fill_holes(cache: dict, now: datetime, chunk: int = 80) -> int:
    """Rebuild finished daily bars that came back without a close. Yahoo's unadjusted daily bar of that day still
    has its Open / High / Low (only auto_adjust needs the missing Close): those are kept, and the close is the last
    60-minute bar's (≈ the 16:00 close: a median 2 bp off the official one, at most ~30 bp, in a check of 80
    tickers × 3 days). If the unadjusted bar has a close after all, that real close is used and nothing is marked.
    60-minute highs / lows are only a fallback — they carry stray prints (2026-11-04: SPY 775.64 against a real
    high of 769.22). The daily volume stays. Unadjusted values: a dividend going ex while the mark is up shifts that
    day by the dividend yield until Yahoo's real (adjusted) bar replaces it.
    Kept in cache["filled"][day] = {tickers (marked 「补」), bars {t: [o, h, l, c, previous close, volume]} (every bar written,
    Yahoo's unadjusted closes too), ohlc60 (tickers whose open / high / low are from 60-minute bars too), at, source};
    returns how many
    bars were written (filled or given Yahoo's unadjusted close)."""
    holes = find_holes(cache, now)
    filled = cache.setdefault("filled", {})
    for day in list(filled):  # a filled date the cache no longer has
        if pd.Timestamp(day) not in cache["fields"]["Close"].index:
            del filled[day]
    if not holes:
        return 0
    want = sorted({t for ts in holes.values() for t in ts})
    print(f"  {sum(len(v) for v in holes.values())} finished bar(s) came back without a close "
          f"({', '.join(f'{d.date()} × {len(v)}' for d, v in holes.items())}) → rebuilding them "
          f"(unadjusted daily bar + {FILL_INTERVAL} close)")
    import yfinance as yf

    def get(ch, interval, adjust):
        try:
            raw = yf.download(ch, period="5d", interval=interval, auto_adjust=adjust, actions=False, prepost=False,
                              progress=False, threads=True, group_by="column", timeout=30)
        except Exception as e:  # noqa: BLE001
            print(f"    {interval} download error ({type(e).__name__}: {e})")
            return {}
        return split_fields(raw, ch, daily=interval == "1d")

    def val(frame, day, t):
        if frame is None or frame.empty or day not in frame.index or t not in frame.columns:
            return None
        v = frame.at[day, t]
        return float(v) if pd.notna(v) else None

    F = cache["fields"]
    stamp = datetime.now(NY).isoformat(timespec="seconds")
    done: dict[pd.Timestamp, dict[str, list[float]]] = {d: {} for d in holes}
    real: dict[pd.Timestamp, dict[str, list]] = {d: {} for d in holes}
    guessed: dict[pd.Timestamp, set[str]] = {d: set() for d in holes}  # open / high / low from 60-minute bars too
    for i in range(0, len(want), chunk):
        ch = want[i:i + chunk]
        raw_day = get(ch, "1d", False)
        bars = get(ch, FILL_INTERVAL, True)
        bc = bars.get("Close", pd.DataFrame()) if bars else pd.DataFrame()
        days = bc.index.normalize() if not bc.empty else None
        for day, tks in holes.items():
            on = (days == day) if days is not None else None
            for t in tks:
                if t not in ch:
                    continue
                d_open, d_high, d_low, d_close = (val(raw_day.get(f) if raw_day else None, day, t)
                                                  for f in ("Open", "High", "Low", "Close"))
                c_bars = bc.loc[on, t].dropna() if on is not None and on.any() and t in bc.columns else pd.Series(dtype=float)
                close = d_close if d_close is not None else (float(c_bars.iloc[-1]) if len(c_bars) else None)
                if close is None:
                    continue

                def bar(f, pick):
                    fr = bars.get(f, pd.DataFrame()) if bars else pd.DataFrame()
                    s = fr.loc[on, t].dropna() if on is not None and on.any() and t in fr.columns else c_bars
                    return pick(s) if len(s) else close
                o = d_open if d_open is not None else bar("Open", lambda s: float(s.iloc[0]))
                hi = d_high if d_high is not None else bar("High", lambda s: float(s.max()))
                lo = d_low if d_low is not None else bar("Low", lambda s: float(s.min()))
                b = [o, max(hi, o, close), min(lo, o, close), close]
                for f, v in zip(("Open", "High", "Low", "Close"), b):
                    F[f].at[day, t] = v
                b.append(_prev_close(F["Close"], day, t))  # (the reference restore_filled() rescales by)
                vol = F["Volume"].at[day, t] if t in F["Volume"].columns else None
                b.append(float(vol) if pd.notna(vol) else None)
                if d_close is not None:  # (Yahoo's own unadjusted close is the real one: kept, not marked)
                    real[day][t] = b
                else:
                    done[day][t] = b
                    if d_open is None or d_high is None or d_low is None:
                        guessed[day].add(t)
        if i + chunk < len(want):
            time.sleep(0.4)
    n = r = 0
    for day in holes:
        key = str(day.date())
        _unmark(filled, key, set(real[day]), keep_bars=True)
        r += len(real[day])
        if not done[day] and not real[day]:
            continue
        e = filled.get(key) or {"tickers": [], "bars": {}, "ohlc60": []}
        e["tickers"] = sorted(set(e.get("tickers", [])) | set(done[day]))
        e["bars"] = {**(e.get("bars") or {}), **real[day], **done[day]}
        e["ohlc60"] = sorted((set(e.get("ohlc60", [])) - set(done[day])) | guessed[day])
        e.update(at=stamp, source=FILL_INTERVAL)
        filled[key] = e
        n += len(done[day])
    left = sum(len(v) for v in holes.values()) - n - r
    g = sum(len(v) for v in guessed.values())
    print(f"  filled {n} bar(s) with the {FILL_INTERVAL} close{f' ({g} also with {FILL_INTERVAL} open/high/low)' if g else ''}"
          f"{f', {r} with Yahoo’s unadjusted close' if r else ''}{f'; {left} without any bar that day stay empty' if left else ''}")
    return n + r


def market_open(now: datetime) -> bool:
    """Weekday 09:30–16:15 New York (holidays ignored: a holiday simply has no new bar)."""
    t = now.astimezone(NY)
    return t.weekday() < 5 and 9 * 60 + 30 <= t.hour * 60 + t.minute < 16 * 60 + 15


def merge_rows(cache: dict, new: dict[str, pd.DataFrame], tickers: list[str]) -> None:
    """Overlay new rows on the cache (new values win where present); other tickers/dates untouched."""
    for f in FIELDS:
        old = cache["fields"].get(f, pd.DataFrame())
        add = new.get(f, pd.DataFrame())
        if add.empty:
            continue
        add = add[[t for t in tickers if t in add.columns]]
        cache["fields"][f] = add.combine_first(old).sort_index() if not old.empty else add.sort_index()


def quick(args, want: list[str]) -> int:
    cache = load_cache()
    have = set(good_columns(cache["fields"]))
    if CALENDAR not in have:
        print("quick: no usable cache yet — falling back to a full fetch")
        return -1
    now = datetime.now(NY)
    print(f"fetch --quick: last 5 sessions for {len(want)} tickers")
    t0 = time.time()
    try:
        import yfinance as yf
        yf.download(CALENDAR, period="5d", progress=False, threads=False, auto_adjust=True)
    except Exception:  # noqa: BLE001
        pass
    ok_all: list[str] = []
    readjust: list[str] = []
    old_close = cache["fields"]["Close"]
    chunks = [want[i:i + args.chunk] for i in range(0, len(want), args.chunk)]
    bar_at = cache.setdefault("barAt", {})
    for i, ch in enumerate(chunks, 1):
        stamp = datetime.now(NY).isoformat(timespec="seconds")
        got = download(ch, "5d", attempts=2)
        ok = good_columns(got)
        if ok:
            nc = got["Close"]
            for t in ok:
                if t not in old_close.columns:
                    readjust.append(t)
                    continue
                both = pd.concat([old_close[t], nc[t]], axis=1, keys=["a", "b"]).dropna()
                both = both[both.index < nc[t].dropna().index.max()]  # the newest bar may still be moving
                if len(both):
                    a, b = float(both["a"].iloc[0]), float(both["b"].iloc[0])
                    if a > 0 and abs(b / a - 1) > 0.015:
                        readjust.append(t)
            merge_rows(cache, got, [t for t in ok if t not in readjust])
            clear_filled(cache, got, [t for t in ok if t not in readjust])
            for t in ok:
                if t not in readjust:
                    bar_at[t] = stamp
        ok_all += ok
        print(f"  batch {i}/{len(chunks)}: {len(ok)}/{len(ch)} ok")
        if i < len(chunks):
            time.sleep(0.4)
    if readjust:
        print(f"  {len(readjust)} ticker(s) re-adjusted (split/dividend) → full {args.period}: "
              f"{' '.join(readjust[:20])}{' …' if len(readjust) > 20 else ''}")
        for j in range(0, len(readjust), args.chunk):
            ch = readjust[j:j + args.chunk]
            stamp = datetime.now(NY).isoformat(timespec="seconds")
            got = download(ch, args.period, attempts=2)
            ok = good_columns(got)
            merge_into(cache, got, ok)
            clear_filled(cache, got, ok)
            for t in ok:
                cache["fetched"][t] = stamp
                bar_at[t] = stamp
    restore_filled(cache)
    fill_holes(cache, now, args.chunk)
    close = cache["fields"]["Close"]
    spy = close[CALENDAR].dropna() if CALENDAR in close.columns else pd.Series(dtype=float)
    last = spy.index.max() if len(spy) else None
    partial = bool(last is not None and last.date() == now.date() and market_open(now))
    cache["quick"] = {"date": str(last.date()) if last is not None else None,
                      "at": now.isoformat(timespec="seconds"), "partial": partial}
    save_cache(cache)
    miss = [t for t in want if t not in set(ok_all)]
    print(f"  quick refresh: {len(ok_all)}/{len(want)} ok in {time.time() - t0:.1f}s; newest session "
          f"{last.date() if last is not None else '-'}{' (still trading)' if partial else ''}")
    if miss:
        print(f"  note: {len(miss)} ticker(s) not refreshed (kept from cache): {' '.join(miss[:30])}"
              f"{' …' if len(miss) > 30 else ''}")
    if len(miss) > 0.5 * len(want):
        print("ERROR: quick refresh mostly failed (Yahoo down or rate-limited?)", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="ignore the cache and re-download everything")
    ap.add_argument("--quick", action="store_true", help="only the last 5 sessions, merged into the cache")
    ap.add_argument("--max-age", type=float, default=6.0, help="hours a cached ticker stays fresh (default 6)")
    ap.add_argument("--chunk", type=int, default=80)
    ap.add_argument("--period", default=PERIOD)
    ap.add_argument("--universe", default=str(UNIVERSE), help="universe file (default universe/universe.json)")
    args = ap.parse_args()
    universe = Path(args.universe)

    if not universe.exists():
        print("ERROR: universe/universe.json missing — run pipeline/build_universe.py first", file=sys.stderr)
        return 2
    want = [CALENDAR] + [t for t in ATMOSPHERE if t != CALENDAR]
    for t in universe_tickers(universe):
        if t not in want:
            want.append(t)

    if args.quick and not args.force:
        rc = quick(args, want)
        if rc >= 0:
            return rc
    cache = load_cache()
    if cache.get("period") != args.period:
        cache = {"version": 1, "fields": {f: pd.DataFrame() for f in FIELDS}, "fetched": {}, "failed": {},
                 "period": args.period}
    now = datetime.now(NY)
    have = set(good_columns(cache["fields"]))
    refill = refill_tickers(cache, want)
    if args.force:
        todo = list(want)
    else:
        todo = [t for t in want
                if t in refill or not (t in have and is_fresh(cache["fetched"].get(t), now, args.max_age))]
    # SPY defines the calendar: if anything is being refreshed, refresh SPY too
    if todo and CALENDAR not in todo:
        todo.insert(0, CALENDAR)
    print(f"fetch: {len(want)} tickers wanted, {len(want) - len(todo)} fresh in cache, {len(todo)} to download")
    if not todo:
        # (a hole the last run could not fill — no 60-minute bars yet — gets another try)
        if restore_filled(cache) + fill_holes(cache, now, args.chunk):
            save_cache(cache)
        else:
            print("  cache is fresh — nothing to do (use --force to re-download)")
        return 0

    t0 = time.time()
    ok_all: set[str] = set()
    # warm-up: one tiny single-threaded request so cookie/crumb is set before parallel batches
    try:
        import yfinance as yf
        yf.download(CALENDAR, period="5d", progress=False, threads=False, auto_adjust=True)
    except Exception:  # noqa: BLE001
        pass
    chunks = [todo[i:i + args.chunk] for i in range(0, len(todo), args.chunk)]
    bar_at = cache.setdefault("barAt", {})
    for i, ch in enumerate(chunks, 1):
        t1 = time.time()
        stamp = datetime.now(NY).isoformat(timespec="seconds")
        got = download(ch, args.period)
        ok = good_columns(got)
        merge_into(cache, got, ok)
        clear_filled(cache, got, ok)
        miss = [t for t in ch if t not in ok]
        if len(miss) > max(3, len(ch) // 10):  # a batch that mostly failed is usually a hiccup: retry it once
            time.sleep(3)
            got2 = download(miss, args.period, attempts=2)
            ok2 = good_columns(got2)
            merge_into(cache, got2, ok2)
            clear_filled(cache, got2, ok2)
            ok = ok + ok2
        ok_all.update(ok)
        for t in ok:
            cache["fetched"][t] = stamp
            bar_at[t] = stamp
            cache["failed"].pop(t, None)
        print(f"  batch {i}/{len(chunks)}: {len(ok)}/{len(ch)} ok in {time.time() - t1:.1f}s")
        if i < len(chunks):
            time.sleep(0.6)

    missing = [t for t in todo if t not in ok_all]
    if missing:
        print(f"  retrying {len(missing)} failed ticker(s) in small batches: {' '.join(missing[:30])}"
              f"{' …' if len(missing) > 30 else ''}")
        for j in range(0, len(missing), 10):
            ch = missing[j:j + 10]
            time.sleep(1.5)
            stamp = datetime.now(NY).isoformat(timespec="seconds")
            got = download(ch, args.period, attempts=2)
            ok = good_columns(got)
            ok_all.update(ok)
            merge_into(cache, got, ok)
            clear_filled(cache, got, ok)
            for t in ok:
                cache["fetched"][t] = stamp
                bar_at[t] = stamp
                cache["failed"].pop(t, None)
    still = [t for t in todo if t not in ok_all]
    stamp = datetime.now(NY).isoformat(timespec="seconds")
    for t in still:
        cache["failed"][t] = stamp
    restored = restore_filled(cache)
    if restored:
        print(f"  {restored} filled bar(s) put back (Yahoo still has no close for them)")
    fill_holes(cache, now, args.chunk)
    save_cache(cache)

    close = cache["fields"]["Close"]
    last = close.index.max() if not close.empty else None
    print(f"  downloaded {len(ok_all)}/{len(todo)} in {time.time() - t0:.1f}s; cache now {close.shape[1]} tickers × "
          f"{close.shape[0]} days (last {last.date() if last is not None else '-'})")
    if still:
        print(f"  WARNING: no data for {len(still)} ticker(s): {' '.join(still)}")
    if CALENDAR not in good_columns(cache["fields"]):
        print("ERROR: no SPY data — cannot build the trading calendar", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
