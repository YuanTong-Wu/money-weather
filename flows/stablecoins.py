"""Stablecoin net mint (DefiLlama, free, no key) — new dollars entering / leaving crypto. DESIGN §23/§24.

net mint on day d (USD m) = circulating(d) − circulating(d−1), USD-pegged supply (peggedUSD).
Items: total of all USD stablecoins, the top issuers (USDT, USDC, …) and the biggest chains.
Real daily history (DefiLlama keeps the full series); est:false. Points are 00:00 UTC; the newest point
can be today's partial value, flagged with `partialLast`.
Output: web/data/flows/stablecoins.json
"""
from __future__ import annotations

import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, envelope, http_json, log, r2, save_snapshot, write_json  # noqa: E402

BASE = "https://stablecoins.llama.fi"
WINDOW = 365
TOP_COINS = 8
CHAINS = ["Ethereum", "Tron", "Solana", "BSC", "Arbitrum", "Base"]
ZH = {"USDT": "泰达币 USDT", "USDC": "USDC（Circle）", "USDe": "Ethena USDe", "USDS": "Sky USDS", "DAI": "DAI",
      "PYUSD": "PayPal 美元币", "USD1": "USD1（World Liberty）", "FDUSD": "First Digital 美元", "BUIDL": "贝莱德 BUIDL",
      "USDTB": "Ethena USDtb", "RLUSD": "瑞波 RLUSD", "TUSD": "TrueUSD", "USYC": "USYC", "GHO": "GHO"}
CHAIN_ZH = {"Ethereum": "以太坊链上", "Tron": "波场链上", "Solana": "Solana 链上", "BSC": "币安链上",
            "Arbitrum": "Arbitrum 链上", "Base": "Base 链上"}


def _series(points, key="totalCirculatingUSD"):
    """[(date, usd)] from a stablecoincharts response (peggedUSD only)."""
    out = {}
    for p in points:
        try:
            d = dt.datetime.fromtimestamp(int(p["date"]), dt.timezone.utc).date().isoformat()
            v = (p.get(key) or p.get("totalCirculating") or {}).get("peggedUSD")
            if v is None:
                continue
            out[d] = float(v)
        except Exception:  # noqa: BLE001
            continue
    return sorted(out.items())


def _item(id_, name, pts, source_url, nodes, extra=None):
    pts = pts[-(WINDOW + 1):]
    dates = [d for d, _ in pts][1:]
    lvl = [v for _, v in pts]
    mint = [(lvl[i] - lvl[i - 1]) / 1e6 for i in range(1, len(lvl))]
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    it = {"id": id_, "name": name, "date": dates, "usd": [r2(x, 1) for x in mint],
          "level": [r2(x / 1e6, 0) for x in lvl[1:]],
          "source": "DefiLlama 稳定币流通量（每日 00:00 UTC）", "sourceUrl": source_url,
          "asOf": dates[-1] if dates else None, "est": False, "nodes": nodes,
          "flow1": r2(sum(mint[-1:]), 1), "flow7": r2(sum(mint[-7:]), 1), "flow30": r2(sum(mint[-30:]), 1),
          "flow90": r2(sum(mint[-90:]), 1), "supply": r2(lvl[-1] / 1e6, 0) if lvl else None}
    if dates and dates[-1] >= today:
        it["partialLast"] = True
    if extra:
        it.update(extra)
    return it


def main():
    t0 = time.time()
    errors = {}
    items = []
    coins = http_json(f"{BASE}/stablecoins?includePrices=true", timeout=90)["peggedAssets"]
    usd = [c for c in coins if c.get("pegType") == "peggedUSD"]
    usd.sort(key=lambda c: -((c.get("circulating") or {}).get("peggedUSD") or 0))
    save_snapshot("defillama_stablecoins", [{k: c.get(k) for k in ("id", "symbol", "name", "circulating",
                                                                   "circulatingPrevDay", "circulatingPrevWeek",
                                                                   "circulatingPrevMonth", "pegMechanism")}
                                            for c in usd[:40]])
    total = _series(http_json(f"{BASE}/stablecoincharts/all", timeout=90))
    items.append(_item("stable:total", "全部美元稳定币", total, f"{BASE}/stablecoincharts/all", ["crypto"],
                       {"kind": "total"}))
    for c in usd[:TOP_COINS]:
        sym = c.get("symbol")
        try:
            pts = _series(http_json(f"{BASE}/stablecoincharts/all?stablecoin={c['id']}", timeout=90))
            nodes = ["crypto"] + (["s:CRCL"] if sym == "USDC" else [])
            items.append(_item(f"stable:{sym}", ZH.get(sym, c.get("name") or sym), pts,
                               f"{BASE}/stablecoincharts/all?stablecoin={c['id']}", nodes,
                               {"kind": "coin", "symbol": sym, "mechanism": c.get("pegMechanism")}))
            time.sleep(0.4)
        except Exception as e:  # noqa: BLE001
            errors[sym] = str(e)[:200]
    for ch in CHAINS:
        try:
            pts = _series(http_json(f"{BASE}/stablecoincharts/{ch}", timeout=90))
            items.append(_item(f"chain:{ch}", CHAIN_ZH.get(ch, ch), pts, f"{BASE}/stablecoincharts/{ch}", ["crypto"],
                               {"kind": "chain"}))
            time.sleep(0.4)
        except Exception as e:  # noqa: BLE001
            errors[ch] = str(e)[:200]
    asof = items[0]["asOf"] if items else None
    doc = envelope("stablecoins", source="DefiLlama stablecoins API（stablecoins.llama.fi），真实每日历史",
                   asOf=asof, items=items, errors=errors,
                   notes=["usd[] = 当天美元稳定币流通量变化（百万美元）：正 = 新铸造（新钱进币圈），负 = 销毁（钱离开）",
                          "日期是 UTC 日；最后一个点可能是今天还没结束的数（partialLast）"],
                   ms=int((time.time() - t0) * 1000))
    write_json(OUT / "stablecoins.json", doc)
    log(f"stablecoins: {len(items)} items asOf {asof}; total 7d {items[0]['flow7']} USDm; errors {errors}")
    return doc


if __name__ == "__main__":
    main()
