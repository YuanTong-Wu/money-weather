"""China / Hong Kong real money: 南向/北向 (Stock Connect), A股主力资金, 行业资金, A股 ETF 申赎. DESIGN §23/§24.

Every value is converted to USD millions with the same day's FX: HKD=X, and for CNY the offshore CNH built from
Yahoo's hourly bars at the 15:00 Beijing close (daily CNY=X goes stale for days, then jumps — flows/common.fx_cny_series).
Items carry `kind`:
  connect   — 南向资金 (mainland → HK, Eastmoney datacenter, real daily history; 亿港元 at source)
              北向资金 (HK → A-shares, real until 2024-08-16; the exchanges stopped publishing daily net buy
              after that, so the series is marked stopped/stale)
  market    — A股主力资金 (Eastmoney 大盘资金流, ~120 trading days of history, merged into flows/store so it
              keeps growing). NOTE: 主力 = net of large/extra-large orders by an order-size classifier — a trading
              pressure measure, not new money entering the market.
  industry  — 行业主力资金: Eastmoney board history when reachable; otherwise 同花顺 daily snapshots that
              accumulate from the first run (history:'snapshot').
  etf / etf-group / etf-total / etf-all — A股 ETF 份额变化 × 价格 (SSE 每日份额 by date + SZSE 每日份额 range; top ETFs
              by size; prices from Yahoo .SS/.SZ). This is where 国家队 buying via 宽基 ETFs shows up.
              cn-etf-equity (kind etf-total) = STOCK ETFs only (宽基 + 行业) — the real money into A-share equities;
              its coverage = the top ETFs' share of all A-share stock-ETF assets. cn-etf-all (kind etf-all) = every
              ETF incl. bond / money-market / gold / cross-border / HK, for reference only.
Map attachment hints (data-driven, for web/js/ui/realmoney.js and the global map): every headline item carries
`nodes` (curated tree ids) and `glNodes` (全球 map ids) plus `attach:[{map, id, primary, label}]`. 南向资金 is money
moving INSIDE 大中华 (mainland → Hong Kong): it belongs to gl-hk only, and to gl-greater-china only as an
"其中" line; the curated intl-china uses US-listed China ETF creations (etf.json regions) instead.
Item order: headline items first (cn-etf-equity, cn-etf-all, groups), then connect, market, industry, single ETFs.
Output: web/data/flows/china.json
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (OUT, STORE, envelope, fx_cny_series, fx_on, fx_series, http_get, log, r2, read_json,  # noqa: E402
                    requests_default_timeout, save_snapshot, write_json)

CN = ZoneInfo("Asia/Shanghai")
CN_DIR = STORE / "cn"
ETF_DIR = STORE / "cn_etf"
for _d in (CN_DIR, ETF_DIR / "sse", ETF_DIR / "szse"):
    _d.mkdir(parents=True, exist_ok=True)
WINDOW = 252
TOP_ETF = 150

EM_MARKET = ("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=1.000001"
             "&secid2=0.399001&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65"
             "&ut=b2884a393a59ad64002292a3e90d46a5")
EM_BOARDS = ("https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f62"
             "&fs=m:90+t:2&fields=f12,f14,f62&ut=b2884a393a59ad64002292a3e90d46a5")
EM_BOARD_HIST = ("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=90.{code}"
                 "&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65"
                 "&ut=b2884a393a59ad64002292a3e90d46a5")


def ak():
    requests_default_timeout(40)
    import akshare
    return akshare


# ------------------------------------------------------------------------------------------- calendar
def cn_trading_dates() -> list[str]:
    """SSE trading days from Yahoo (510300.SS bars), plus today if the session closed and the bar exists."""
    import yfinance as yf
    for i in range(3):
        try:
            df = yf.download("510300.SS", period="2y", progress=False, auto_adjust=False, threads=False)
            ds = [d.strftime("%Y-%m-%d") for d in df.index]
            now = dt.datetime.now(CN)
            if ds and ds[-1] == now.date().isoformat() and (now.hour, now.minute) < (15, 5):
                ds = ds[:-1]                          # today's bar is still live
            return ds
        except Exception as e:  # noqa: BLE001
            log("cn calendar retry", e)
            time.sleep(4 * (i + 1))
    raise RuntimeError("no CN calendar")


# ------------------------------------------------------------------------------------------- connect
def connect_items(usdcny, usdhkd):
    items, errors = [], {}
    a = ak()
    for sym, iid, name, cur, nodes in [
        ("南向资金", "cn:southbound", "南向资金（内地 → 港股）", "HKD", []),
        ("北向资金", "cn:northbound", "北向资金（香港 → A股）", "CNY", []),
    ]:
        try:
            df = a.stock_hsgt_hist_em(symbol=sym)
            df["日期"] = df["日期"].astype(str)
            df = df.dropna(subset=["当日成交净买额"])
            df = df[df["当日成交净买额"].astype(float).abs() > 0] if sym == "北向资金" else df
            df = df.tail(WINDOW)
            dates = df["日期"].tolist()
            fx = fx_on(usdhkd if cur == "HKD" else usdcny, dates)
            net = [float(v) * 100 / f for v, f in zip(df["当日成交净买额"], fx)]          # 亿 → m, then → USD
            buy = [float(v) * 100 / f if v == v else None for v, f in zip(df["买入成交额"], fx)]
            sell = [float(v) * 100 / f if v == v else None for v, f in zip(df["卖出成交额"], fx)]
            it = {"id": iid, "kind": "connect", "name": name, "date": dates, "usd": [r2(x, 1) for x in net],
                  "buy": [r2(x, 0) for x in buy], "sell": [r2(x, 0) for x in sell], "currency": cur,
                  "source": "东方财富 数据中心 沪深港通（akshare stock_hsgt_hist_em）", "sourceUrl": "https://data.eastmoney.com/hsgt/index.html",
                  "asOf": dates[-1] if dates else None, "est": False, "nodes": nodes,
                  "flow1": r2(sum(net[-1:]), 1), "flow5": r2(sum(net[-5:]), 1), "flow20": r2(sum(net[-20:]), 1),
                  "flow60": r2(sum(net[-60:]), 1)}
            if sym == "南向资金":
                it.update({"glNodes": ["gl-hk"], "internal": "gl-greater-china",
                           "attach": [{"map": "global", "id": "gl-hk", "primary": True, "label": "南向资金（内地→港股）"},
                                      {"map": "global", "id": "gl-greater-china", "primary": False,
                                       "label": "其中南向（内地→港股，大中华内部搬家）"}],
                           "basis": "内地投资者经港股通净买入港股。钱从 A股/内地账户搬到港股，对整个大中华是内部搬家，"
                                    "不是外面来的新钱"})
            if sym == "北向资金":
                it.update({"stopped": "2024-08-16", "stale": True, "glNodes": ["gl-cn"],
                           "basis": "沪深交易所 2024-08-19 起不再公布北向每日净买额，这里只有到 2024-08-16 的真实历史"})
            items.append(it)
        except Exception as e:  # noqa: BLE001
            errors[iid] = str(e)[:300]
            log("china connect failed", sym, e)
    return items, errors


# ------------------------------------------------------------------------------------------- 主力资金
def market_item(usdcny):
    store_p = CN_DIR / "em_market.json"
    store = read_json(store_p, {}) or {}
    err = None
    try:
        j = json.loads(http_get(EM_MARKET, timeout=20, retries=2, backoff=4,
                                headers={"Referer": "https://data.eastmoney.com/zjlx/dpzjlx.html"},
                                use_curl_fallback=True))
        for line in j["data"]["klines"]:
            store[line.split(",")[0]] = line
        write_json(store_p, store)
    except Exception as e:  # noqa: BLE001
        err = str(e)[:300]
        log("china: Eastmoney 大盘资金流 unreachable, using stored history", e)
    if not store:
        return None, err
    dates = sorted(store)[-WINDOW:]
    fx = fx_on(usdcny, dates)
    cols = {"main": 1, "small": 2, "medium": 3, "large": 4, "super": 5}
    vals = {k: [] for k in cols}
    shc = []
    for d, f in zip(dates, fx):
        p = store[d].split(",")
        for k, i in cols.items():
            vals[k].append(float(p[i]) / f / 1e6)
        shc.append(float(p[11]) if len(p) > 11 else None)
    it = {"id": "cn:main", "kind": "market", "name": "A股主力资金（沪深两市）", "date": dates,
          "usd": [r2(x, 1) for x in vals["main"]],
          "super": [r2(x, 1) for x in vals["super"]], "large": [r2(x, 1) for x in vals["large"]],
          "medium": [r2(x, 1) for x in vals["medium"]], "small": [r2(x, 1) for x in vals["small"]],
          "shIndex": shc, "currency": "CNY",
          "source": "东方财富 大盘资金流（主力 = 超大单 + 大单）", "sourceUrl": "https://data.eastmoney.com/zjlx/dpzjlx.html",
          "asOf": dates[-1], "est": False, "nodes": ["intl-china"],
          "method": "按成交单大小划分的主动买入减主动卖出；每笔成交都有买卖双方，这是交易压力指标，不是新增资金",
          "flow1": r2(sum(vals["main"][-1:]), 1), "flow5": r2(sum(vals["main"][-5:]), 1),
          "flow20": r2(sum(vals["main"][-20:]), 1)}
    if err:
        it["staleFetch"] = err
    return it, err


def industry_items(usdcny, session_date: str):
    """Eastmoney board history if reachable, else 同花顺 snapshot accumulation."""
    items, errors = [], {}
    store_p = CN_DIR / "em_boards.json"
    store = read_json(store_p, {}) or {}            # {code: {"name":…, "k": {date: line}}}
    em_ok = False
    try:
        j = json.loads(http_get(EM_BOARDS, timeout=15, retries=1, backoff=3, use_curl_fallback=True))
        boards = [(b["f12"], b["f14"]) for b in j["data"]["diff"]]
        n_ok = n_fail = 0
        for code, name in boards:
            if n_ok == 0 and n_fail >= 3:
                errors["em_boards"] = "board history unreachable (first 3 failed)"
                break
            try:
                h = json.loads(http_get(EM_BOARD_HIST.format(code=code), timeout=15, retries=2, backoff=3,
                                        use_curl_fallback=True))
                e = store.setdefault(code, {"name": name, "k": {}})
                e["name"] = name
                for line in h["data"]["klines"]:
                    e["k"][line.split(",")[0]] = line
                n_ok += 1
                time.sleep(0.3)
            except Exception as ex:  # noqa: BLE001
                n_fail += 1
                errors[f"em:{code}"] = str(ex)[:120]
        if n_ok:
            write_json(store_p, store)
        em_ok = n_ok >= 0.8 * max(1, len(boards))
    except Exception as e:  # noqa: BLE001
        errors["em_boards"] = str(e)[:200]
        log("china: Eastmoney boards unreachable", e)
    # use the Eastmoney board history only while it is fresh and broad; otherwise the 同花顺 snapshots
    fresh = [e for e in store.values() if e.get("k") and max(e["k"]) >= (
        dt.date.fromisoformat(session_date) - dt.timedelta(days=4)).isoformat()]
    em_ok = em_ok or len(fresh) >= 30

    # 同花顺 snapshot (always taken; it is the fallback history and a cross-check)
    ths = {}
    try:
        a = ak()
        now_df = a.stock_fund_flow_industry(symbol="即时")
        d5 = a.stock_fund_flow_industry(symbol="5日排行")
        d20 = a.stock_fund_flow_industry(symbol="20日排行")
        f5 = dict(zip(d5["行业"], d5["净额"]))
        f20 = dict(zip(d20["行业"], d20["净额"]))
        for _, r in now_df.iterrows():
            ths[r["行业"]] = {"net": float(r["净额"]), "in": float(r["流入资金"]), "out": float(r["流出资金"]),
                             "chg": float(r["行业-涨跌幅"]), "n": int(r["公司家数"]),
                             "net5": float(f5.get(r["行业"], 0) or 0), "net20": float(f20.get(r["行业"], 0) or 0)}
        cn_now = dt.datetime.now(CN)
        partial = cn_now.date().isoformat() == session_date and (cn_now.hour, cn_now.minute) < (15, 5)
        if not partial:
            save_snapshot("ths_industry_flow", ths, day=session_date)
    except Exception as e:  # noqa: BLE001
        errors["ths"] = str(e)[:200]

    fx_last = fx_on(usdcny, [session_date])[0]
    if em_ok:
        for code, e in sorted(store.items()):
            dates = sorted(e["k"])[-WINDOW:]
            if not dates:
                continue
            fx = fx_on(usdcny, dates)
            main = [float(e["k"][d].split(",")[1]) / f / 1e6 for d, f in zip(dates, fx)]
            items.append({"id": f"cn-ind:{code}", "kind": "industry", "name": e["name"], "date": dates,
                          "usd": [r2(x, 1) for x in main], "source": "东方财富 行业板块主力资金",
                          "asOf": dates[-1], "est": False, "history": "provider-daily",
                          "flow5": r2(sum(main[-5:]), 1), "flow20": r2(sum(main[-20:]), 1)})
    else:
        # build history from accumulated 同花顺 snapshots
        snaps = sorted((STORE / "snapshots").glob("*/ths_industry_flow.json"))
        hist: dict = {}
        for p in snaps:
            s = read_json(p, {}) or {}
            d = s.get("asOf")
            for name, v in (s.get("data") or {}).items():
                hist.setdefault(name, {})[d] = v
        names = sorted(set(hist) | set(ths))
        for name in names:
            h = hist.get(name, {})
            dates = sorted(h)[-WINDOW:]
            fx = fx_on(usdcny, dates) if dates else []
            usd = [h[d]["net"] * 100 / f for d, f in zip(dates, fx)]
            cur = ths.get(name) or (h[dates[-1]] if dates else None)
            items.append({"id": f"cn-ind:ths:{name}", "kind": "industry", "name": name, "date": dates,
                          "usd": [r2(x, 1) for x in usd],
                          "source": "同花顺 行业资金流（每日快照，从首次运行开始积累）",
                          "sourceUrl": "https://data.10jqka.com.cn/funds/hyzjl/",
                          "asOf": dates[-1] if dates else session_date, "est": False, "history": "snapshot",
                          "since": dates[0] if dates else None,
                          "today": r2(cur["net"] * 100 / fx_last, 1) if cur else None,
                          "flow5": r2(cur["net5"] * 100 / fx_last, 1) if cur else None,
                          "flow20": r2(cur["net20"] * 100 / fx_last, 1) if cur else None,
                          "chg": cur.get("chg") if cur else None})
    return items, errors


# ------------------------------------------------------------------------------------------- A股 ETF
def _store_day(ex: str, d: str, rows: list[tuple]):
    p = ETF_DIR / ex / f"{d}.csv"
    with open(p, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["code", "name", "shares"])
        w.writerows(rows)


def _load_day(ex: str, d: str) -> dict | None:
    p = ETF_DIR / ex / f"{d}.csv"
    if not p.exists():
        return None
    out = {}
    with open(p, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                out[r["code"]] = (r["name"], float(r["shares"]))
            except Exception:  # noqa: BLE001
                pass
    return out


def backfill_shares(dates: list[str], budget_s: float):
    """Fill SSE (one call per date, slow) and SZSE (range calls) share counts, newest first, within budget."""
    a = ak()
    t0 = time.time()
    want = dates[-(WINDOW + 1):]
    # SZSE: month chunks
    miss = [d for d in want if not (ETF_DIR / "szse" / f"{d}.csv").exists()]
    chunks = {}
    for d in miss:
        chunks.setdefault(d[:7], []).append(d)
    for ym in sorted(chunks, reverse=True):
        if time.time() - t0 > budget_s:
            break
        ds = chunks[ym]
        try:
            df = a.fund_scale_daily_szse(start_date=ds[0].replace("-", ""), end_date=ds[-1].replace("-", ""), symbol="ETF")
            df["日期"] = df["日期"].astype(str)
            for d, g in df.groupby("日期"):
                if d in ds:
                    _store_day("szse", d, [(str(r["基金代码"]).zfill(6), r["基金简称"], float(r["基金份额"]))
                                           for _, r in g.iterrows() if r["基金份额"] == r["基金份额"]])
            time.sleep(0.5)
        except Exception as e:  # noqa: BLE001
            log("szse scale failed", ym, e)
    # SSE: one date per call
    n_sse = 0
    for d in sorted([d for d in want if not (ETF_DIR / "sse" / f"{d}.csv").exists()], reverse=True):
        if time.time() - t0 > budget_s:
            break
        try:
            df = a.fund_etf_scale_sse(date=d.replace("-", ""))
            if df is None or not len(df):
                continue
            got = str(df["统计日期"].iloc[0])[:10]
            if got != d:
                continue                       # the exchange returned a different day (holiday / not yet)
            _store_day("sse", d, [(str(r["基金代码"]).zfill(6), r["基金简称"], float(r["基金份额"]))
                                  for _, r in df.iterrows() if r["基金份额"] == r["基金份额"]])
            n_sse += 1
            time.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            log("sse scale failed", d, e)
    have_sse = sum(1 for d in want if (ETF_DIR / "sse" / f"{d}.csv").exists())
    have_szse = sum(1 for d in want if (ETF_DIR / "szse" / f"{d}.csv").exists())
    log(f"china etf shares: SSE {have_sse}/{len(want)} days (+{n_sse} now), SZSE {have_szse}/{len(want)}")
    return have_sse, have_szse, len(want)


def categorize(name: str, code: str = "") -> str:
    n = name
    if "现金流" not in n and any(k in n for k in ("货币", "添益", "日利", "现金", "短融")):
        return "money"                                   # 自由现金流 ETF is an equity index, not cash
    if any(k in n for k in ("债", "国开", "利率", "信用", "城投", "政金", "地方", "可转", "AAA")):
        return "bond"                                    # 科创AAA (551550) = 科创债 AAA, a bond ETF
    if "黄金" in n or "金ETF" in n or "上海金" in n:
        return "gold"
    if any(k in n for k in ("恒生", "港股", "H股", "香港", "中概", "恒指", "HK")):
        return "hk"                                      # HK创新药 (513120) buys Hong Kong listings
    if any(k in n for k in ("纳指", "纳斯达克", "标普", "道琼斯", "日经", "德国", "法国", "美国", "海外", "亚太",
                            "沙特", "东南亚", "日本", "全球", "美股", "中韩", "韩国", "越南", "印度", "巴西",
                            "欧洲", "英国", "新加坡", "QDII")):
        return "overseas"                                # 中韩芯片 (513310) holds Korean chips too
    if code.startswith("513"):
        return "overseas"                                # SSE 513xxx = cross-border ETFs
    if any(k in n for k in ("300", "50ETF", "上证50", "A500", "500ETF", "中证500", "1000", "2000", "科创50",
                            "科创板", "创业板", "上证指数", "深证100", "双创", "红利", "A50", "综指", "上证综", "180")):
        return "broad"
    return "sector"


CAT_ZH = {"broad": "宽基（沪深300/上证50/A500/科创/创业板…）", "hk": "港股/中概", "overseas": "跨境（美股/日本/欧洲…）",
          "gold": "黄金", "bond": "债券", "money": "货币", "sector": "行业主题"}
CAT_NODES = {"broad": ["intl-china", "intl-cn-etf"], "hk": ["intl-china", "intl-cn-etf"], "overseas": [],
             "gold": ["commod-gold"], "bond": [], "money": [], "sector": ["intl-china"]}
CAT_GL = {"broad": ["gl-cn"], "sector": ["gl-cn"], "hk": ["gl-hk"], "overseas": [], "gold": [], "bond": [], "money": []}
EQUITY = ("broad", "sector")          # A-share stock ETFs: the real money into A-share equities


def etf_items(dates: list[str], usdcny, budget_s: float):
    import yfinance as yf
    items, errors = [], {}
    have = backfill_shares(dates, budget_s)
    a = ak()
    nav = {}
    try:
        df = a.fund_etf_spot_ths()
        for _, r in df.iterrows():
            v = r.get("最新-单位净值")
            try:
                nav[str(r["基金代码"]).zfill(6)] = float(v)
            except Exception:  # noqa: BLE001
                pass
        save_snapshot("ths_cn_etf_nav", {k: v for k, v in nav.items()}, day=str(df["最新-交易日"].iloc[0])[:10])
    except Exception as e:  # noqa: BLE001
        errors["ths_nav"] = str(e)[:200]
    want = dates[-(WINDOW + 1):]
    days = {}
    for d in want:
        s, z = _load_day("sse", d), _load_day("szse", d)
        if s or z:
            days[d] = {"sse": s, "szse": z}
    if not days:
        return items, {"etf": "no share data yet", **errors}, have
    last = max(days)
    latest = {}
    for ex in ("sse", "szse"):
        for d in sorted(days, reverse=True):
            if days[d][ex]:
                for code, (name, sh) in days[d][ex].items():
                    latest.setdefault(code, (ex, name, sh))
                break
    ranked = sorted(((code, ex, name, sh, sh * nav.get(code, 0)) for code, (ex, name, sh) in latest.items()),
                    key=lambda x: -x[4])
    total_aum_cny = sum(x[4] for x in ranked)
    top = ranked[:TOP_ETF]
    syms = {c: f"{c}.SS" if ex == "sse" else f"{c}.SZ" for c, ex, *_ in top}
    px = {}
    for i in range(3):
        try:
            df = yf.download(sorted(syms.values()), period="2y", progress=False, auto_adjust=False, threads=True)["Close"]
            for c, s in syms.items():
                if s in df:
                    col = df[s].dropna()
                    px[c] = {d.strftime("%Y-%m-%d"): float(v) for d, v in col.items()}
            break
        except Exception as e:  # noqa: BLE001
            log("cn etf prices retry", e)
            time.sleep(5 * (i + 1))
    cal = [d for d in want]
    complete = []                  # dates where both exchanges have d and the previous trading day
    for i in range(1, len(cal)):
        d, p = cal[i], cal[i - 1]
        if d in days and p in days and all(days[d][ex] and days[p][ex] for ex in ("sse", "szse")):
            complete.append(d)
    group = {k: {d: 0.0 for d in complete} for k in CAT_ZH}
    total = {d: 0.0 for d in complete}
    fx_by = dict(zip(cal, fx_on(usdcny, cal)))
    for code, ex, name, sh, aum in top:
        series = px.get(code, {})
        fl_d, fl_v = [], []
        for i in range(1, len(cal)):
            d, p = cal[i], cal[i - 1]
            a_d, a_p = (days.get(d) or {}).get(ex), (days.get(p) or {}).get(ex)
            if not a_d or not a_p or code not in a_d or code not in a_p:
                continue
            price = series.get(d) or nav.get(code)
            if not price:
                continue
            f = (a_d[code][1] - a_p[code][1]) * price / fx_by[d] / 1e6
            fl_d.append(d)
            fl_v.append(f)
            cat = categorize(name, code)
            if d in total:
                total[d] += f
                group[cat][d] += f
        cat = categorize(name, code)
        aum_usd = aum / fx_by[cal[-1]] / 1e6
        items.append({"id": f"cn-etf:{code}", "kind": "etf", "ticker": syms[code], "code": code, "name": name,
                      "category": cat, "categoryName": CAT_ZH[cat], "exchange": ex.upper(),
                      "date": fl_d, "usd": [r2(x, 1) for x in fl_v], "aum": r2(aum_usd, 1),
                      "shares": sh, "nav": nav.get(code),
                      "source": ("上交所 ETF 每日份额" if ex == "sse" else "深交所 ETF 每日份额") + " × Yahoo 收盘价（akshare）",
                      "asOf": fl_d[-1] if fl_d else None, "est": False, "nodes": CAT_NODES[cat], "glNodes": CAT_GL[cat],
                      "flow5": r2(sum(fl_v[-5:]), 1), "flow20": r2(sum(fl_v[-20:]), 1),
                      "flow60": r2(sum(fl_v[-60:]), 1)})
    top_aum = sum(x[4] for x in top)
    cov = r2(top_aum / total_aum_cny, 3) if total_aum_cny else None
    # coverage per category = the top ETFs' share of that category's assets among ALL listed ETFs with a NAV
    cat_all, cat_top = {k: 0.0 for k in CAT_ZH}, {k: 0.0 for k in CAT_ZH}
    top_codes = {x[0] for x in top}
    for code, ex, name, sh, aum in ranked:
        c = categorize(name, code)
        cat_all[c] += aum
        if code in top_codes:
            cat_top[c] += aum
    cov_cat = {k: (r2(cat_top[k] / cat_all[k], 3) if cat_all[k] else None) for k in CAT_ZH}
    eq_all, eq_top = sum(cat_all[k] for k in EQUITY), sum(cat_top[k] for k in EQUITY)
    cov_eq = r2(eq_top / eq_all, 3) if eq_all else None
    head = []
    ds = sorted(total)
    eq = [sum(group[k][d] for k in EQUITY) for d in ds]
    head.append({"id": "cn-etf-equity", "kind": "etf-total", "name": "A股股票 ETF 净申购（宽基 + 行业，前 %d 大 ETF 里的）" % TOP_ETF,
                 "label": "A股 ETF 申赎（股票类）",
                 "date": ds, "usd": [r2(x, 1) for x in eq], "coverage": cov_eq, "coverageOf": "A股股票 ETF 总规模",
                 "includes": ["broad", "sector"], "excludes": ["bond", "money", "gold", "hk", "overseas"],
                 "source": "沪深交易所 ETF 每日份额 × 价格（只算股票 ETF：宽基 + 行业主题）", "asOf": ds[-1] if ds else None,
                 "est": False, "nodes": ["intl-china"], "glNodes": ["gl-cn", "gl-greater-china"],
                 "attach": [{"map": "global", "id": "gl-cn", "primary": True, "label": "A股 ETF 申赎（股票类）"},
                            {"map": "global", "id": "gl-greater-china", "primary": True, "label": "A股 ETF 申赎（股票类）"}],
                 "basis": "沪深两市股票 ETF（宽基、行业）的份额变化 × 当天价格 = 真实申购赎回；国家队托市主要从这里进。"
                          "债券、货币、黄金、跨境、港股 ETF 不算在内",
                 "flow1": r2(sum(eq[-1:]), 1), "flow5": r2(sum(eq[-5:]), 1), "flow20": r2(sum(eq[-20:]), 1),
                 "flow60": r2(sum(eq[-60:]), 1), "historyDays": len(ds)})
    v = [total[d] for d in ds]
    head.append({"id": "cn-etf-all", "kind": "etf-all", "name": "A股上市 ETF 合计净申购（含债券/货币/黄金/跨境/港股，前 %d 大）" % TOP_ETF,
                 "date": ds, "usd": [r2(x, 1) for x in v], "coverage": cov, "coverageOf": "全部 A股上市 ETF 总规模",
                 "includes": list(CAT_ZH), "source": "沪深交易所 ETF 每日份额 × 价格", "asOf": ds[-1] if ds else None,
                 "est": False, "nodes": [], "glNodes": [],
                 "basis": "参考用：把债券、货币、黄金、跨境 ETF 也加进来了，不能当成流进 A股股票的钱",
                 "flow1": r2(sum(v[-1:]), 1), "flow5": r2(sum(v[-5:]), 1), "flow20": r2(sum(v[-20:]), 1),
                 "flow60": r2(sum(v[-60:]), 1), "historyDays": len(ds)})
    for k, name in CAT_ZH.items():
        ds_k = sorted(group[k])
        v = [group[k][d] for d in ds_k]
        g = {"id": f"cn-etf-group:{k}", "kind": "etf-group", "name": f"A股ETF · {name}", "date": ds_k,
             "usd": [r2(x, 1) for x in v], "source": "沪深交易所 ETF 每日份额 × 价格（前 %d 大 ETF）" % TOP_ETF,
             "asOf": ds_k[-1] if ds_k else None, "est": False, "nodes": CAT_NODES[k], "glNodes": CAT_GL[k],
             "coverage": cov_cat[k], "category": k,
             "flow1": r2(sum(v[-1:]), 1), "flow5": r2(sum(v[-5:]), 1), "flow20": r2(sum(v[-20:]), 1),
             "flow60": r2(sum(v[-60:]), 1)}
        if k == "hk":
            g["attach"] = [{"map": "global", "id": "gl-hk", "primary": False, "label": "A股上市的港股 ETF 申赎"}]
        head.append(g)
    return head + items, errors, have


# ------------------------------------------------------------------------------------------- main
def main(budget_s: float = 180):
    t0 = time.time()
    usdcny, usdhkd = fx_cny_series(), fx_series("HKD=X")
    errors = {}
    items = []
    cal = cn_trading_dates()
    session = cal[-1]
    c_items, e = connect_items(usdcny, usdhkd)
    items += c_items
    errors.update(e)
    m, e = market_item(usdcny)
    if m:
        items.append(m)
    if e:
        errors["em_market"] = e
    try:
        it, e = industry_items(usdcny, session)
        items += it
        errors.update(e)
    except Exception as ex:  # noqa: BLE001
        errors["industry"] = str(ex)[:300]
    try:
        it, e, have = etf_items(cal, usdcny, budget_s)
        items += it
        errors.update(e)
    except Exception as ex:  # noqa: BLE001
        have = None
        errors["etf"] = str(ex)[:300]
        log("china etf failed", ex)
    # headline items first: consumers that take "the first record per node" (web/js/ui/realmoney.js) then show the
    # A-share stock-ETF money as 大中华's real money, and 南向 (an internal move) only as an extra line
    rank = {"etf-total": 0, "etf-all": 1, "etf-group": 2, "connect": 3, "market": 4, "industry": 5, "etf": 6}
    items.sort(key=lambda x: rank.get(x.get("kind"), 9))
    asof = max((i["asOf"] for i in items if i.get("asOf") and not i.get("stale")), default=None)
    doc = envelope("china", source="东方财富（沪深港通、大盘/行业资金流）、同花顺（行业资金流、ETF 净值）、上交所/深交所（ETF 每日份额），"
                                   "经 akshare 1.18 或直接调用；汇率 Yahoo",
                   asOf=asof, items=items, errors=errors,
                   notes=["usd[] 都已按当天汇率换成百万美元",
                          "南向资金 = 内地投资者通过港股通净买入港股（真实每日数据）",
                          "北向资金 2024-08-16 之后交易所不再公布每日净买额，只保留历史（stale）",
                          "主力资金是按单子大小划的交易压力，不是新钱；ETF 申赎才是真金白银进出",
                          "cn-etf-equity = 只算股票 ETF（宽基 + 行业）——这才是流进 A股股票的真钱；cn-etf-all 把债券/货币/黄金/跨境也算进去，只作参考",
                          "南向资金是大中华内部搬家（内地 → 港股）：只挂在港股（gl-hk）上，大中华只作「其中南向」一行",
                          "人民币汇率用离岸 CNH 的小时价（北京 15:00 收盘那一刻）；Yahoo 的日线 CNY=X 经常好几天不动再一下跳过去",
                          "ETF 份额历史从首次运行起向前回补（上交所一天一次请求，较慢），historyDays 显示已有天数"],
                   session=session, etfShareDays=have, fx={"CNY": usdcny.attrs.get("fx"), "HKD": "HKD=X daily"},
                   ms=int((time.time() - t0) * 1000))
    write_json(OUT / "china.json", doc)
    log(f"china: {len(items)} items asOf {asof}; errors {list(errors)}; {time.time() - t0:.0f}s")
    return doc


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-seconds", type=float, default=180)
    a = ap.parse_args()
    main(a.backfill_seconds)
