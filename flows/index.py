"""web/data/flows/index.json — one small file that says what real-money data exists, how fresh it is,
which parts are real history vs started-today snapshots, and a few factual highlights (numbers only;
the §12 voice is added by the words/brief modules, not here)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import LOGDIR, OUT, now_iso, r2, read_json, write_json  # noqa: E402

FILES = ["etf", "china", "stablecoins", "cot", "ici", "aligned"]
HONESTY = {
    "etf": "iShares + SPDR = 发行商真实每日历史（多年）；Global X / First Trust / KraneShares = 官网当日份额，首次运行起积累；"
           "其余（Vanguard、Invesco、VanEck、Grayscale、Fidelity…）= Yahoo 快照，滞后严重，est:true",
    "china": "南向 = 真实每日历史（2014 起）；北向 = 2024-08-16 后交易所停止公布，只有历史；主力资金 = 东方财富约 120 个交易日历史 + 之后每天累积；"
             "行业资金 = 东方财富板块历史（能连上时）否则同花顺每日快照起步；A股 ETF 申赎 = 交易所每日份额向前回补",
    "stablecoins": "DefiLlama 真实每日历史（全量）",
    "cot": "CFTC 真实每周历史（取最近 3 年）",
    "ici": "ICI 官网拦截程序访问 → 用本地 ETF 申赎按周汇总代替（proxy:true）；主人可手动下载放进 flows/inbox/ici/",
    "aligned": "etf.json 里 iShares/SPDR 的真实申赎按 T+1 往前挪一个交易日，对齐到地图日期（最近 1–2 天发行商还没公布 = null）；"
               "给 pipeline 用来替换按成交额估的 flow（flows/realflow.py）",
}


def _last(it, n=1, key="usd"):
    v = [x for x in (it.get(key) or [])[-n:] if x is not None]
    return r2(sum(v), 1) if v else None


def highlights() -> list[dict]:
    out = []
    etf = read_json(OUT / "etf.json", {}) or {}
    regs = [r for r in etf.get("regions", []) if r.get("date") and r.get("coverage") and r["coverage"] >= 0.3]
    for cid in ("intl", "bonds", "commod", "crypto", "cash"):
        r = next((x for x in regs if x["id"] == cid), None)
        if r:
            out.append({"id": cid, "file": "etf", "what": f"{r['name']} ETF 近 5 日净申购", "usd": r.get("flow5"),
                        "usd20": r.get("flow20"), "asOf": r.get("asOf"), "coverage": r.get("coverage")})
    leaf = [r for r in regs if r["id"] not in ("intl", "bonds", "commod", "crypto", "cash")]
    for r in sorted(leaf, key=lambda r: -(r.get("flow5") or 0))[:3]:
        out.append({"id": r["id"], "file": "etf", "what": f"{r['name']}：近 5 日钱进来最多", "usd": r.get("flow5"),
                    "asOf": r.get("asOf"), "coverage": r.get("coverage")})
    for r in sorted(leaf, key=lambda r: (r.get("flow5") or 0))[:3]:
        out.append({"id": r["id"], "file": "etf", "what": f"{r['name']}：近 5 日钱走得最多", "usd": r.get("flow5"),
                    "asOf": r.get("asOf"), "coverage": r.get("coverage")})
    st = read_json(OUT / "stablecoins.json", {}) or {}
    tot = next((i for i in st.get("items", []) if i["id"] == "stable:total"), None)
    if tot:
        out.append({"id": "stable:total", "file": "stablecoins", "what": "美元稳定币近 7 日净铸造", "usd": tot.get("flow7"),
                    "usd30": tot.get("flow30"), "asOf": tot.get("asOf")})
    cn = read_json(OUT / "china.json", {}) or {}
    for iid, what in (("cn:southbound", "南向资金近 5 日净买入港股"), ("cn-etf-equity", "A股股票 ETF（宽基+行业）近 5 日净申购"),
                      ("cn:main", "A股主力资金近 5 日")):
        it = next((i for i in cn.get("items", []) if i["id"] == iid), None)
        if it and it.get("date"):
            out.append({"id": iid, "file": "china", "what": what, "usd": it.get("flow5"), "asOf": it.get("asOf")})
    cot = read_json(OUT / "cot.json", {}) or {}
    moves = sorted((i for i in cot.get("items", []) if i.get("flow1w") is not None), key=lambda i: -abs(i["flow1w"]))[:3]
    for i in moves:
        out.append({"id": i["id"], "file": "cot", "what": f"{i['name']}：大投机盘上周净{'加多' if i['flow1w'] > 0 else '加空'}",
                    "usd": i["flow1w"], "asOf": i["asOf"], "netPctile": i.get("netPctile")})
    return out


def main():
    runs = {}
    p = LOGDIR / "last_run.txt"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) >= 3:
                runs[parts[0]] = {"ok": parts[1] == "ok", "s": int(parts[2]), "at": " ".join(parts[3:]) or None}
    files = {}
    for f in FILES:
        d = read_json(OUT / f"{f}.json")
        if not d:
            files[f] = {"ok": False, "path": f"data/flows/{f}.json", "honest": HONESTY[f], "run": runs.get(f)}
            continue
        its = d.get("items", [])
        if f == "aligned":
            its = [{"kind": "etf"}] * len(d.get("tickers") or {}) + [{"kind": "region"}] * len(d.get("regions") or {})
        kinds = {}
        for i in its:
            k = i.get("history") or i.get("kind") or "series"
            kinds[k] = kinds.get(k, 0) + 1
        files[f] = {"ok": True, "path": f"data/flows/{f}.json", "asOf": d.get("asOf"), "generatedAt": d.get("generatedAt"),
                    "items": len(its), "est": sum(1 for i in its if i.get("est")), "kinds": kinds,
                    "errors": len(d.get("errors") or {}), "source": d.get("source"), "honest": HONESTY[f],
                    "run": runs.get(f)}
        if f == "etf":
            files[f]["coverage"] = d.get("coverage")
    write_json(OUT / "index.json", {"generatedAt": now_iso(), "unit": "USD m", "files": files,
                                    "highlights": highlights(),
                                    "readme": "flows/README.md"}, indent=1)
    print("index:", {k: (v.get("asOf"), v.get("items")) for k, v in files.items()})


if __name__ == "__main__":
    main()
