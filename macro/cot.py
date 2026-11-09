"""macro/cot.py: CFTC Commitments of Traders (legacy, futures only) — open interest + speculator positioning.

Public Socrata API, no key: https://publicreporting.cftc.gov/resource/6dca-aqww.json
Weekly, positions as of Tuesday, published Friday 15:30 ET. A row is treated as known from the Friday after
its report date (no look-ahead). Cached 12 h in macro/cache/cot.json.

    python3 macro/cot.py      # fetch + print the latest row per contract
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from liquidity import net  # noqa: E402  (shared polite HTTP + cache helpers)

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache" / "cot.json"
URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
TTL_S = 12 * 3600
FIELDS = ["cftc_contract_market_code", "market_and_exchange_names", "report_date_as_yyyy_mm_dd", "open_interest_all",
          "noncomm_positions_long_all", "noncomm_positions_short_all", "comm_positions_long_all",
          "comm_positions_short_all"]
RELEASE_LAG_DAYS = 3   # Tuesday positions → Friday release


def fetch(codes: list[str], since: str | None = None, force: bool = False, log=print) -> tuple[pd.DataFrame | None, dict]:
    since = since or (date.today() - timedelta(days=4 * 365)).isoformat()
    codes = sorted({c for c in codes if c})

    def pull() -> bytes:
        rows, off = [], 0
        inlist = ",".join(f"'{c}'" for c in codes)
        while True:
            body = net.get_bytes(URL, {
                "$select": ",".join(FIELDS),
                "$where": f"cftc_contract_market_code in({inlist}) AND report_date_as_yyyy_mm_dd >= '{since}'",
                "$order": "report_date_as_yyyy_mm_dd ASC, cftc_contract_market_code ASC",
                "$limit": 50000, "$offset": off}, timeout=90)
            part = json.loads(body)
            rows += part
            if len(part) < 50000:
                break
            off += 50000
        return json.dumps({"codes": codes, "since": since, "rows": rows}).encode()

    body, info = net.cached(CACHE, TTL_S, pull, force=force, log=log)
    if body is None:
        return None, info
    try:
        d = json.loads(body)
        if set(codes) - set(d.get("codes") or []):   # the cache was for another contract list
            body = pull()
            CACHE.write_bytes(body)
            d = json.loads(body)
            info = {"source": "net", "age_s": 0}
        df = pd.DataFrame(d["rows"])
        if df.empty:
            return None, dict(info, error="no rows")
        df["date"] = pd.to_datetime(df["report_date_as_yyyy_mm_dd"].str[:10])
        for c in FIELDS[3:]:
            df[c] = pd.to_numeric(df[c], errors="coerce")
        df = df.rename(columns={"cftc_contract_market_code": "code", "open_interest_all": "oi",
                                "noncomm_positions_long_all": "ncl", "noncomm_positions_short_all": "ncs",
                                "comm_positions_long_all": "cl", "comm_positions_short_all": "cs",
                                "market_and_exchange_names": "market"})
        df["known"] = df["date"] + pd.Timedelta(days=RELEASE_LAG_DAYS)
        df = df.sort_values(["code", "date"]).drop_duplicates(["code", "date"], keep="last")
        info["last"] = df["date"].max().strftime("%Y-%m-%d")
        return df[["code", "market", "date", "known", "oi", "ncl", "ncs", "cl", "cs"]], info
    except Exception as e:
        return None, dict(info, error=f"parse: {e}")


def daily(df: pd.DataFrame, code: str, cal: pd.DatetimeIndex) -> pd.DataFrame | None:
    """One contract's weekly rows → daily (carried forward from the release day)."""
    x = df[df["code"] == code]
    if x.empty:
        return None
    x = x.set_index("known")[["date", "oi", "ncl", "ncs"]]
    x = x[~x.index.duplicated(keep="last")]
    out = x.reindex(x.index.union(cal)).ffill().reindex(cal)
    out["net"] = out["ncl"] - out["ncs"]
    out["netPct"] = out["net"] / out["oi"].where(out["oi"] > 0)
    return out


def main():
    sys.path.insert(0, str(HERE.parent))
    from macro.instruments import INSTRUMENTS
    df, info = fetch([x["cftc"] for x in INSTRUMENTS], force="--force" in sys.argv)
    print(info)
    if df is None:
        return 1
    last = df.sort_values("date").groupby("code").tail(1)
    for _, r in last.iterrows():
        print(f"{r['code']:7} {r['date'].date()} oi={r['oi']:>10,.0f} netSpec={(r['ncl'] - r['ncs']) / r['oi'] * 100:+6.1f}%  {r['market'][:50]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
