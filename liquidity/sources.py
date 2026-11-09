"""liquidity/sources.py: the raw series (FRED csv, no key) + the Treasury's daily cash balance (DTS).

    python3 liquidity/sources.py          # fetch everything (cached, see TTLs below) and print the last values

FRED ids (units as published):
  WALCL         Fed total assets, weekly (Wed), $ millions          → 美联储资产负债表
  WDTGAL        Treasury General Account, Wednesday LEVEL, $ millions → 财政部账户 TGA (fallback only)
  RRPONTSYD     overnight reverse repo, daily, $ billions            → 逆回购 RRP
  WRBWFRBL      reserve balances at the Fed, Wednesday LEVEL, $ millions → 银行准备金
  DGS2 / DGS10  2y / 10y Treasury yield, daily, %
  BAMLH0A0HYM2  US high-yield OAS, daily, %                          → 垃圾债利差
  BAMLC0A0CM    US investment-grade OAS, daily, %                    → 投资级利差
  SOFR / IORB   secured overnight rate / interest on reserves, daily, % → 回购市场松紧
  DFF           effective fed funds, daily, %
  NFCI          Chicago Fed financial conditions, weekly (Fri), index (<0 = looser than average)
  T10YIE        10y breakeven inflation, daily, %
  DTWEXBGS      broad trade-weighted dollar, daily, index
Daily TGA: fiscaldata.treasury.gov Daily Treasury Statement, "Treasury General Account (TGA) Closing
Balance" ($ millions) — the TGA level for every business day. WDTGAL is only the fallback when the DTS is missing.
Do NOT use WTREGEN / WRESBAL here: those are WEEK AVERAGES (Thu–Wed), not Wednesday levels — WTREGEN equals the
DTS 7-day mean and was 115 $B off the Wednesday TGA on 2026-09-16 (877.0 vs 991.7), enough to flip the regime,
which is entirely TGA-driven. WDTGAL matches the DTS Wednesday close exactly. WALCL is a Wednesday level too.

Caching: weekly series 6 h; daily FRED series 2 h; RRPONTSYD (NY Fed posts ~13:15 ET) and the DTS (~16:00 ET,
for the previous business day) are re-fetched whenever the cached copy predates the latest release, and at
least hourly — so the after-close cycle always gets the newest RRP print.
"""
from __future__ import annotations

import io
import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from liquidity import net  # noqa: E402

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
START = "2016-01-01"
TTL_S = 6 * 3600              # weekly series (and the ceiling for everything); --offline sets it to ~forever
DAILY_TTL_S = 2 * 3600
FAST_TTL_S = 3600             # RRP and DTS: at most this old, and never older than their latest release
ET = ZoneInfo("America/New_York")
RELEASE_ET = {"RRPONTSYD": (13, 20), "DTS": (16, 10)}

FRED = {
    "WALCL": {"key": "walcl", "scale": 1e-3, "freq": "W"},       # → $ billions
    "WDTGAL": {"key": "tga_w", "scale": 1e-3, "freq": "W"},       # Wednesday level (WTREGEN is a week average)
    "RRPONTSYD": {"key": "rrp", "scale": 1.0, "freq": "D"},
    "WRBWFRBL": {"key": "reserves", "scale": 1e-3, "freq": "W"},  # Wednesday level (WRESBAL is a week average)
    "DGS2": {"key": "dgs2", "scale": 1.0, "freq": "D"},
    "DGS10": {"key": "dgs10", "scale": 1.0, "freq": "D"},
    "BAMLH0A0HYM2": {"key": "hy", "scale": 1.0, "freq": "D"},
    "BAMLC0A0CM": {"key": "ig", "scale": 1.0, "freq": "D"},
    "SOFR": {"key": "sofr", "scale": 1.0, "freq": "D"},
    "IORB": {"key": "iorb", "scale": 1.0, "freq": "D"},
    "DFF": {"key": "dff", "scale": 1.0, "freq": "D"},
    "NFCI": {"key": "nfci", "scale": 1.0, "freq": "W"},
    "T10YIE": {"key": "breakeven", "scale": 1.0, "freq": "D"},
    "DTWEXBGS": {"key": "dollar", "scale": 1.0, "freq": "D"},
}
# the ones the output cannot do without
REQUIRED = ("WALCL", "RRPONTSYD", "DGS2", "DGS10", "BAMLH0A0HYM2")

DTS_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance"
DTS_TYPE = "Treasury General Account (TGA) Closing Balance"


def last_release(hh: int, mm: int, now: datetime | None = None) -> datetime:
    """The most recent business-day hh:mm New York time at or before `now` (weekends skipped; holidays ignored)."""
    now = now or datetime.now(ET)
    t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if t > now:
        t -= timedelta(days=1)
    while t.weekday() >= 5:
        t -= timedelta(days=1)
    return t


def max_age(name: str, freq: str = "D") -> float:
    """Cache age limit (s) for one source. Offline (TTL_S huge) wins; RRP/DTS also expire at their release time."""
    if TTL_S >= 10 ** 11:
        return TTL_S
    if name in RELEASE_ET:
        since = (datetime.now(ET) - last_release(*RELEASE_ET[name])).total_seconds()
        return max(60.0, min(FAST_TTL_S, since, TTL_S))
    return min(TTL_S, DAILY_TTL_S) if freq == "D" else TTL_S


def fred_url(sid: str, start: str = START) -> str:
    return f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={start}"


def parse_fred(body: bytes, sid: str) -> pd.Series:
    df = pd.read_csv(io.BytesIO(body))
    if df.shape[1] < 2:
        raise ValueError(f"{sid}: unexpected csv")
    dcol = df.columns[0]
    vcol = sid if sid in df.columns else df.columns[1]
    s = pd.to_numeric(df[vcol], errors="coerce")
    s.index = pd.to_datetime(df[dcol], errors="coerce")
    s = s[s.index.notna()].dropna()
    s = s[~s.index.duplicated(keep="last")].sort_index()
    return s.astype(float)


def fetch_fred(force: bool = False, log=print) -> tuple[dict[str, pd.Series], dict]:
    out, info = {}, {}
    for sid, spec in FRED.items():
        body, inf = net.cached(CACHE / "fred" / f"{sid}.csv", max_age(sid, spec["freq"]),
                               lambda sid=sid: net.get_bytes(fred_url(sid)),
                               force=force, log=log)
        info[sid] = inf
        if body is None:
            log(f"  ✗ {sid}: no data ({inf.get('error', '')[:120]})")
            continue
        try:
            s = parse_fred(body, sid) * spec["scale"]
        except Exception as e:
            log(f"  ✗ {sid}: cannot parse ({e})")
            info[sid] = dict(inf, error=f"parse: {e}")
            continue
        out[spec["key"]] = s
        info[sid]["last"] = s.index[-1].strftime("%Y-%m-%d") if len(s) else None
    return out, info


def fetch_dts(force: bool = False, log=print, start: str = "2021-10-01") -> tuple[pd.Series | None, dict]:
    """Daily TGA closing balance ($ billions). Paged JSON, newest first."""

    def pull() -> bytes:
        rows, page = [], 1
        while True:
            body = net.get_bytes(DTS_URL, {
                "filter": f"record_date:gte:{start},account_type:eq:{DTS_TYPE}",
                "fields": "record_date,account_type,open_today_bal,close_today_bal",
                "sort": "-record_date", "page[size]": 1000, "page[number]": page}, timeout=60)
            d = json.loads(body)
            rows += d.get("data") or []
            tot = int(((d.get("meta") or {}).get("total-pages")) or 1)
            if page >= tot or not d.get("data"):
                break
            page += 1
        return json.dumps(rows).encode()

    body, inf = net.cached(CACHE / "dts_tga.json", max_age("DTS"), pull, force=force, log=log)
    if body is None:
        return None, inf
    try:
        rows = json.loads(body)
        vals = {}
        for r in rows:
            # the DTS puts the closing balance of the "Closing Balance" row in open_today_bal (close_today_bal is "null")
            v = r.get("close_today_bal")
            if v in (None, "null", ""):
                v = r.get("open_today_bal")
            try:
                vals[pd.Timestamp(r["record_date"])] = float(v) / 1000.0
            except (TypeError, ValueError, KeyError):
                continue
        s = pd.Series(vals).sort_index()
        inf["last"] = s.index[-1].strftime("%Y-%m-%d") if len(s) else None
        return (s if len(s) else None), inf
    except Exception as e:
        return None, dict(inf, error=f"parse: {e}")


def main():
    force = "--force" in sys.argv
    series, info = fetch_fred(force=force)
    tga, dinf = fetch_dts(force=force)
    for sid, spec in FRED.items():
        s = series.get(spec["key"])
        print(f"{sid:14} {spec['key']:10} {info.get(sid, {}).get('source'):6} "
              f"{'' if s is None else s.index[-1].date()} {'' if s is None else round(s.iloc[-1], 3)}")
    print(f"{'DTS TGA':14} {'tga_d':10} {dinf.get('source'):6} "
          f"{'' if tga is None else tga.index[-1].date()} {'' if tga is None else round(tga.iloc[-1], 1)}")


if __name__ == "__main__":
    main()
