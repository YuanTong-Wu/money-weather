"""ICI weekly fund flows (DESIGN §23/§24) — with an honest fallback.

Status 2026-10-28: www.ici.org answers scripted requests with HTTP 403 (Akamai "Access Denied"), for the
pages and for the data files. We do NOT try to get around that. Instead:
  1. every run makes ONE polite attempt at each ICI stats page (in case access opens up) and records the result;
  2. if the owner downloads ICI's weekly files in a browser and drops them into flows/inbox/ici/
     (.xls / .xlsx / .csv), they are parsed best-effort into weekly series (source: ICI, est:false);
  3. a clearly labelled proxy is always written: weekly sums (weeks ending Wednesday, like ICI) of the real
     ETF creations/redemptions in web/data/flows/etf.json, by asset class (海外股票 / 债券 / 商品 / 加密 / 现金).
     proxy:true — real money, but our ETF universe, not ICI's whole fund industry.
Output: web/data/flows/ici.json
"""
from __future__ import annotations

import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FLOWS, OUT, envelope, http_get, log, now_iso, r2, read_json, write_json  # noqa: E402

PAGES = ["https://www.ici.org/research/stats/flows", "https://www.ici.org/research/stats/mmf"]
INBOX = FLOWS / "inbox" / "ici"
INBOX.mkdir(parents=True, exist_ok=True)
WEEKS = 104
CLASS_ZH = {"intl": "海外股票 ETF", "bonds": "债券 ETF", "commod": "商品 ETF", "crypto": "加密 ETF", "cash": "现金/短债 ETF"}


def try_ici() -> dict:
    res = {"at": now_iso(), "pages": {}}
    for u in PAGES:
        try:
            b = http_get(u, timeout=30, retries=1)
            res["pages"][u] = {"ok": True, "bytes": len(b)}
        except Exception as e:  # noqa: BLE001
            res["pages"][u] = {"ok": False, "error": str(e)[-160:]}
        time.sleep(1)
    res["ok"] = any(v["ok"] for v in res["pages"].values())
    return res


def parse_inbox() -> tuple[list[dict], list[str]]:
    """Best-effort: any sheet whose first column holds dates and other columns hold numbers → one weekly
    series per numeric column (ICI reports in millions of dollars)."""
    import pandas as pd
    items, notes = [], []
    for p in sorted(INBOX.glob("*")):
        if p.suffix.lower() not in (".xls", ".xlsx", ".csv"):
            continue
        try:
            sheets = {"csv": pd.read_csv(p, header=None)} if p.suffix.lower() == ".csv" else \
                pd.read_excel(p, sheet_name=None, header=None)
        except Exception as e:  # noqa: BLE001
            notes.append(f"{p.name}: 读不了 ({e})")
            continue
        for sname, df in sheets.items():
            dates = pd.to_datetime(df.iloc[:, 0], errors="coerce")
            ok = dates.notna()
            if ok.sum() < 4:
                continue
            first = ok.idxmax()
            header_rows = df.iloc[:first]
            for c in range(1, df.shape[1]):
                vals = pd.to_numeric(df.loc[ok, c], errors="coerce")
                if vals.notna().sum() < 4:
                    continue
                label = " ".join(str(x) for x in header_rows.iloc[:, c].tolist() if str(x) != "nan").strip() or f"col{c}"
                ds = [d.date().isoformat() for d in dates[ok]]
                pairs = sorted((d, v) for d, v in zip(ds, vals.tolist()) if v == v)[-WEEKS:]
                items.append({"id": f"ici:{p.stem}:{sname}:{c}", "kind": "ici", "name": label[:60],
                              "date": [d for d, _ in pairs], "usd": [r2(v, 1) for _, v in pairs],
                              "source": f"ICI（主人手动下载：{p.name}）", "asOf": pairs[-1][0] if pairs else None,
                              "est": False, "parsed": "best-effort，列名照抄原表"})
    return items, notes


def wednesday_week(d: str) -> str:
    x = dt.date.fromisoformat(d)
    return (x + dt.timedelta(days=(2 - x.weekday()) % 7)).isoformat()      # week ending Wednesday


def proxy_items() -> list[dict]:
    etf = read_json(OUT / "etf.json", {}) or {}
    regs = {r["id"]: r for r in etf.get("regions", [])}
    out = []
    for cid, name in CLASS_ZH.items():
        r = regs.get(cid)
        if not r or not r.get("date"):
            continue
        wk: dict = {}
        for d, v in zip(r["date"], r["usd"]):
            if v is not None:
                wk[wednesday_week(d)] = wk.get(wednesday_week(d), 0.0) + v
        last_day = r["date"][-1]
        weeks = sorted(wk)[-WEEKS:]
        it = {"id": f"ici-proxy:{cid}", "kind": "proxy", "proxy": True, "name": name, "nodes": [cid],
              "date": weeks, "usd": [r2(wk[w], 1) for w in weeks], "coverage": r.get("coverage"),
              "source": "本地代算：iShares + SPDR 官网每日份额 × 净值，按周（周三结束）汇总 —— 不是 ICI",
              "asOf": last_day, "est": False,
              "flow1w": r2(wk[weeks[-1]], 1) if weeks else None,
              "flow4w": r2(sum(wk[w] for w in weeks[-4:]), 1)}
        if weeks and weeks[-1] > last_day:
            it["partialLast"] = True        # current week not finished yet
        out.append(it)
    return out


def main():
    t0 = time.time()
    status = try_ici()
    inbox_items, inbox_notes = parse_inbox()
    items = inbox_items + proxy_items()
    asof = max((i["asOf"] for i in items if i.get("asOf")), default=None)
    notes = ["ICI 官网对程序访问返回 403（Akamai 拦截），我们不绕过；能访问时会自动用上",
             "想要真 ICI 数据：浏览器打开 ici.org/research/stats/flows 下载 xls，放进 flows/inbox/ici/，下次运行自动读",
             "proxy 条目 = 我们自己的真实 ETF 申赎按资产类别、按周汇总（只含有发行商每日数据的 ETF，coverage 是覆盖的资产占比）"]
    notes += inbox_notes
    doc = envelope("ici", source="ICI（被拦截时用本地 ETF 申赎周汇总代替，proxy:true）", asOf=asof, items=items,
                   notes=notes, ici={"ok": status["ok"] or bool(inbox_items), "reachable": status["ok"],
                                     "inboxFiles": len({i["source"] for i in inbox_items}), "lastTry": status},
                   ms=int((time.time() - t0) * 1000))
    write_json(OUT / "ici.json", doc)
    log(f"ici: reachable={status['ok']} inbox={len(inbox_items)} proxy={len(items) - len(inbox_items)}")
    return doc


if __name__ == "__main__":
    main()
