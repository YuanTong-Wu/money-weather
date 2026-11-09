"""CFTC Commitments of Traders for key futures — where the big speculators are moving money. DESIGN §23/§24.

Source: CFTC Public Reporting (Socrata, free, no key), futures-only reports:
  legacy           6dca-aqww  → non-commercial ("大投机盘") net, every contract (the primary series)
  TFF              gpe5-46if  → asset managers + leveraged funds (financial futures)
  disaggregated    72hh-3qpy  → managed money (commodities)
Weekly, positions as of Tuesday, published Friday 15:30 ET. Real history; est:false.

usd[] (USD m, weekly) = Δ(non-commercial net contracts) × contract notional on the report date
                        (notional = futures price × multiplier, price from Yahoo futures closes).
Also: net[] (contracts), netUsd[] (USD m level), oi[], and the extra trader groups as contracts.
Output: web/data/flows/cot.json
"""
from __future__ import annotations

import datetime as dt
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, envelope, http_json, log, r2, save_snapshot, write_json  # noqa: E402

API = "https://publicreporting.cftc.gov/resource/{ds}.json"
WEEKS = 156

# key: (cftc code, 中文名, yahoo price symbol, multiplier → USD per (price unit), group, tree nodes)
# multiplier is applied as notional = price × mult; 'inv' means price is quoted as units per USD.
CONTRACTS = {
    "ES":  ("13874A", "标普500 小型期货", "ES=F", 50, "equity", ["us"]),
    "NQ":  ("209742", "纳斯达克100 小型期货", "NQ=F", 20, "equity", ["us", "ai-compute", "ai-cloud"]),
    "RTY": ("239742", "罗素2000 小型期货", "RTY=F", 50, "equity", ["us"]),
    "YM":  ("124603", "道琼斯 小型期货", "YM=F", 5, "equity", ["us"]),
    "ZT":  ("042601", "2年美债期货", "ZT=F", 2000, "rates", ["bonds-short", "bonds-gov"]),
    "ZF":  ("044601", "5年美债期货", "ZF=F", 1000, "rates", ["bonds-mid", "bonds-gov"]),
    "ZN":  ("043602", "10年美债期货", "ZN=F", 1000, "rates", ["bonds-mid", "bonds-gov"]),
    "TN":  ("043607", "超长10年美债期货", "TN=F", 1000, "rates", ["bonds-mid", "bonds-gov"]),
    "ZB":  ("020601", "长期美债期货", "ZB=F", 1000, "rates", ["bonds-long", "bonds-gov"]),
    "GC":  ("088691", "黄金期货", "GC=F", 100, "metals", ["commod-gold", "commod-precious"]),
    "SI":  ("084691", "白银期货", "SI=F", 5000, "metals", ["commod-silver", "commod-precious"]),
    "HG":  ("085692", "铜期货", "HG=F", 25000, "metals", ["commod-copper"]),
    "CL":  ("067651", "WTI 原油期货", "CL=F", 1000, "energy", ["commod-oil", "energy"]),
    "BZ":  ("06765T", "布伦特原油期货", "BZ=F", 1000, "energy", ["commod-oil"]),
    "NG":  ("023651", "天然气期货", "NG=F", 10000, "energy", ["commod-oil"]),
    "ZC":  ("002602", "玉米期货", "ZC=F", 50, "ag", ["commod-ag"]),          # cents/bu × 5000 bu / 100
    "ZS":  ("005602", "大豆期货", "ZS=F", 50, "ag", ["commod-ag"]),
    "ZW":  ("001602", "小麦期货", "ZW=F", 50, "ag", ["commod-ag"]),
    "BTC": ("133741", "比特币期货（CME）", "BTC-USD", 5, "crypto", ["crypto-btc", "crypto"]),
    "ETH": ("146021", "以太坊期货（CME）", "ETH-USD", 50, "crypto", ["crypto-alt", "crypto"]),
    "6E":  ("099741", "欧元期货", "EURUSD=X", 125000, "fx", ["intl-europe", "cash-fx"]),
    "6J":  ("097741", "日元期货", "JPY=X", ("inv", 12_500_000), "fx", ["intl-japan", "cash-fx"]),
    "6B":  ("096742", "英镑期货", "GBPUSD=X", 62500, "fx", ["intl-europe", "cash-fx"]),
    "DX":  ("098662", "美元指数期货", "DX-Y.NYB", 1000, "fx", ["cash-fx", "cash"]),
    "VX":  ("1170E1", "VIX 恐慌指数期货", "^VIX", 1000, "vol", []),
}
TFF_GROUPS = {"equity", "rates", "fx", "crypto", "vol"}
DIS_GROUPS = {"metals", "energy", "ag"}


def soql(ds: str, codes: list[str], since: str, fields: list[str]) -> list[dict]:
    q = {"$select": ",".join(["cftc_contract_market_code", "report_date_as_yyyy_mm_dd"] + fields),
         "$where": f"report_date_as_yyyy_mm_dd >= '{since}' AND cftc_contract_market_code in("
                   + ",".join(f"'{c}'" for c in codes) + ")",
         "$order": "report_date_as_yyyy_mm_dd ASC", "$limit": "50000"}
    url = API.format(ds=ds) + "?" + urllib.parse.urlencode(q)
    return http_json(url, timeout=120)


def prices(symbols: list[str], start: str):
    import yfinance as yf
    out = {}
    for i in range(3):
        try:
            df = yf.download(symbols, start=start, progress=False, auto_adjust=False, threads=False)["Close"]
            for s in symbols:
                if s in df:
                    c = df[s].dropna()
                    out[s] = {d.strftime("%Y-%m-%d"): float(v) for d, v in c.items()}
            break
        except Exception as e:  # noqa: BLE001
            log("cot prices retry", e)
            time.sleep(5 * (i + 1))
    return out


def price_on(series: dict, d: str):
    """price on d or the nearest earlier trading day (≤ 7 days back)."""
    if not series:
        return None
    day = dt.date.fromisoformat(d)
    for k in range(8):
        s = (day - dt.timedelta(days=k)).isoformat()
        if s in series:
            return series[s]
    return None


def notional(px, mult):
    if px is None:
        return None
    if isinstance(mult, tuple) and mult[0] == "inv":
        return mult[1] / px          # e.g. ¥12.5m per contract ÷ (JPY per USD)
    return px * mult


def main():
    t0 = time.time()
    since = (dt.date.today() - dt.timedelta(weeks=WEEKS + 2)).isoformat()
    codes = [v[0] for v in CONTRACTS.values()]
    errors = {}
    leg = soql("6dca-aqww", codes, since, ["noncomm_positions_long_all", "noncomm_positions_short_all",
                                           "open_interest_all", "contract_units"])
    try:
        tff = soql("gpe5-46if", [v[0] for v in CONTRACTS.values() if v[4] in TFF_GROUPS], since,
                   ["asset_mgr_positions_long", "asset_mgr_positions_short",
                    "lev_money_positions_long", "lev_money_positions_short"])
    except Exception as e:  # noqa: BLE001
        tff, errors["tff"] = [], str(e)[:200]
    try:
        dis = soql("72hh-3qpy", [v[0] for v in CONTRACTS.values() if v[4] in DIS_GROUPS], since,
                   ["m_money_positions_long_all", "m_money_positions_short_all"])
    except Exception as e:  # noqa: BLE001
        dis, errors["disagg"] = [], str(e)[:200]
    save_snapshot("cftc_cot_latest", [r for r in leg if r["report_date_as_yyyy_mm_dd"][:10] ==
                                      max(x["report_date_as_yyyy_mm_dd"][:10] for x in leg)])

    def by_code(rows):
        out = {}
        for r in rows:
            out.setdefault(r["cftc_contract_market_code"], {})[r["report_date_as_yyyy_mm_dd"][:10]] = r
        return out
    L, T, D = by_code(leg), by_code(tff), by_code(dis)
    px = prices(sorted({v[2] for v in CONTRACTS.values()}), since)

    def num(r, k):
        try:
            return float(r.get(k))
        except Exception:  # noqa: BLE001
            return None

    items = []
    for key, (code, name, sym, mult, group, nodes) in CONTRACTS.items():
        rows = L.get(code)
        if not rows:
            errors[key] = "no legacy rows"
            continue
        dates = sorted(rows)[-(WEEKS + 1):]
        net = [num(rows[d], "noncomm_positions_long_all") - num(rows[d], "noncomm_positions_short_all") for d in dates]
        oi = [num(rows[d], "open_interest_all") for d in dates]
        nots = [notional(price_on(px.get(sym, {}), d), mult) for d in dates]
        net_usd = [n * v / 1e6 if v else None for n, v in zip(net, nots)]
        flow = [None if nots[i] is None else (net[i] - net[i - 1]) * nots[i] / 1e6 for i in range(1, len(dates))]
        it = {"id": f"cot:{key}", "key": key, "code": code, "name": name, "group": group, "nodes": nodes,
              "trader": "非商业（大投机盘）", "units": rows[dates[-1]].get("contract_units"),
              "date": dates[1:], "usd": [r2(x, 1) for x in flow],
              "net": [int(x) for x in net[1:]], "netUsd": [r2(x, 0) for x in net_usd[1:]],
              "oi": [int(x) if x is not None else None for x in oi[1:]],
              "price": {"symbol": sym, "last": r2(price_on(px.get(sym, {}), dates[-1]), 4)},
              "source": "CFTC 持仓报告（期货）每周二持仓、周五公布", "sourceUrl": "https://publicreporting.cftc.gov/",
              "asOf": dates[-1],
              "published": (dt.date.fromisoformat(dates[-1]) + dt.timedelta(days=3)).isoformat(),
              "est": False}
        # percentile of the latest net position vs the window (crowding-ish)
        ns = sorted(net[1:])
        if ns:
            it["netPctile"] = int(round(100 * sum(1 for x in ns if x <= net[-1]) / len(ns)))
        it["flow1w"] = it["usd"][-1] if it["usd"] else None
        it["flow4w"] = r2(sum(x for x in flow[-4:] if x is not None), 1)
        it["flow13w"] = r2(sum(x for x in flow[-13:] if x is not None), 1)
        extra = {}
        if group in TFF_GROUPS and code in T:
            tr = T[code]
            extra["assetMgrNet"] = [None if d not in tr else int(num(tr[d], "asset_mgr_positions_long") -
                                                                  num(tr[d], "asset_mgr_positions_short")) for d in dates[1:]]
            extra["levFundsNet"] = [None if d not in tr else int(num(tr[d], "lev_money_positions_long") -
                                                                  num(tr[d], "lev_money_positions_short")) for d in dates[1:]]
        if group in DIS_GROUPS and code in D:
            dr = D[code]
            extra["managedMoneyNet"] = [None if d not in dr else int(num(dr[d], "m_money_positions_long_all") -
                                                                      num(dr[d], "m_money_positions_short_all")) for d in dates[1:]]
        if extra:
            it["groups"] = extra
        if any(v is None for v in it["usd"][-8:]):
            it["priceGaps"] = True
        items.append(it)

    asof = max((i["asOf"] for i in items), default=None)
    doc = envelope("cot", source="CFTC Commitments of Traders（publicreporting.cftc.gov，Socrata API），真实每周历史",
                   asOf=asof, items=items, errors=errors,
                   notes=["usd[] = 每周大投机盘（非商业）净持仓变化 × 合约面值（百万美元）：正 = 加多/减空，负 = 加空/减多",
                          "持仓是周二的，周五美东 15:30 公布；这是押注方向的变化，不是现金流进流出",
                          "国债期货里的大投机盘有很多是基差交易（对冲现货），净空不一定是看空",
                          "groups: 金融期货另给资产管理人、杠杆基金净持仓；商品另给管理基金净持仓（单位：合约）"],
                   ms=int((time.time() - t0) * 1000))
    write_json(OUT / "cot.json", doc)
    log(f"cot: {len(items)} contracts asOf {asof}; errors {errors}; {time.time() - t0:.0f}s")
    return doc


if __name__ == "__main__":
    main()
