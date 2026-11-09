#!/usr/bin/env python3
"""Raw listing sources for the global universe (DESIGN §23). Everything is cached under raw/.

  yahoo_industry()  Yahoo equity screener, one query per Yahoo industry over the whitelisted main exchanges
                    (A-shares, HK, TW, JP, KR, IN, UK, CH, CA, AU, BR, Europe). Gives symbol, names, currency,
                    marketCap (local), averageDailyVolume3Month, price -> liquidity + sector/industry.
  hkex()            HKEX list of securities (Chinese names, traditional).
  a_lists()         SSE + SZSE official A-share lists (Chinese names) via akshare.
  sw()              申万 2021 industry classification of every A-share (一级/二级/三级).
  eastmoney_a()     (optional) 东方财富 A 股列表: Chinese name, 行业 (f100), 成交额, 总市值 (CNY).
  eastmoney_hk()    东方财富 港股列表: Chinese name, 行业, 成交额, 总市值 (HKD).
  taiwan()          TWSE + TPEX open data: Chinese (traditional) names + trade value.
  jpx()             JPX listed-company file: Japanese names + 33 業種.
  fx()              latest FX (USD per 1 unit of currency) via yfinance.

Polite: one request at a time, small sleeps, backoff on errors, cache reused for `max_age_h` hours.
CLI: python3 globalmkt/universe/sources.py [--refresh] [--only fx,lists,tw,jpx,yahoo,em]
"""
import json, sys, time, math, re, argparse
from pathlib import Path
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
RAW.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"}

# market key -> Yahoo exchange codes (main exchanges only; no MTFs, no IOB GDRs, no BDR-only boards)
MARKET_EXCHANGES = {
    "cn": ["SHH", "SHZ"], "hk": ["HKG"], "tw": ["TAI", "TWO"], "jp": ["JPX"], "kr": ["KSC", "KOE"],
    "in": ["NSI"], "gb": ["LSE"], "ch": ["EBS"], "ca": ["TOR", "VAN"], "au": ["ASX"], "br": ["SAO"],
    "de": ["GER"], "fr": ["PAR"], "nl": ["AMS"], "it": ["MIL"], "es": ["MCE"], "se": ["STO"], "dk": ["CPH"],
    "fi": ["HEL"], "no": ["OSL"], "be": ["BRU"], "at": ["VIE"], "pt": ["LIS"], "ie": ["ISE"], "pl": ["WSE"],
}
EXCHANGE_MARKET = {e: m for m, es in MARKET_EXCHANGES.items() for e in es}
KEEP = ["symbol", "shortName", "longName", "exchange", "currency", "financialCurrency", "marketCap",
        "averageDailyVolume3Month", "averageDailyVolume10Day", "regularMarketPrice", "regularMarketVolume",
        "fiftyDayAverage", "twoHundredDayAverage", "firstTradeDateMilliseconds", "quoteType", "sharesOutstanding",
        "regularMarketTime", "market", "fullExchangeName", "displayName"]


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _fresh(path, max_age_h):
    return path.exists() and (time.time() - path.stat().st_mtime) < max_age_h * 3600


def _write(path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower().replace("—", "-")).strip("-")


def _retry(fn, tries=5, base=2.0, what=""):
    for k in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            wait = base * (2 ** k)
            print(f"  ! {what} {type(e).__name__}: {str(e)[:120]} — retry in {wait:.0f}s", flush=True)
            time.sleep(wait)


# ---------------------------------------------------------------------------------------------- Yahoo
def yahoo_industry(refresh=False, max_age_h=72, sleep=0.6):
    """-> {"fetchedAt", "industries": {industry: {"sector", "total", "quotes": [...]}}}"""
    import yfinance as yf
    from yfinance import EquityQuery as Q
    out_dir = RAW / "yahoo"
    out_dir.mkdir(exist_ok=True)
    vv = Q("eq", ["region", "us"]).valid_values["industry"]
    exch = sorted(EXCHANGE_MARKET)
    result = {}
    n_calls = 0
    for sector, inds in vv.items():
        for ind in sorted(inds):
            path = out_dir / f"{_slug(sector)}__{_slug(ind)}.json"
            if not refresh and _fresh(path, max_age_h):
                result[ind] = json.loads(path.read_text())
                continue
            q = Q("and", [Q("eq", ["industry", ind]), Q("is-in", ["exchange"] + exch)])
            quotes, total, off = [], None, 0
            while True:
                r = _retry(lambda: yf.screen(q, size=250, offset=off, sortField="intradaymarketcap",
                                             sortAsc=False), what=f"{ind}@{off}")
                n_calls += 1
                total = r.get("total", 0) if total is None else total
                page = r.get("quotes", []) or []
                quotes += [{k: x.get(k) for k in KEEP if x.get(k) is not None} for x in page]
                off += 250
                time.sleep(sleep)
                if not page or off >= total:
                    break
            rec = {"sector": sector, "industry": ind, "total": total, "fetchedAt": _now(), "quotes": quotes}
            _write(path, rec)
            result[ind] = rec
            print(f"  yahoo {sector} / {ind}: {len(quotes)}/{total}", flush=True)
    print(f"yahoo: {sum(len(v['quotes']) for v in result.values())} quotes, {n_calls} calls", flush=True)
    return result


# ---------------------------------------------------------------------------------------------- 东方财富
def _em_list(fs, fields, label, refresh, max_age_h, sleep=0.35):
    import requests
    path = RAW / f"em_{label}.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    url = "https://push2delay.eastmoney.com/api/qt/clist/get"
    rows, pn, total = [], 1, None
    while True:
        params = {"pn": pn, "pz": 100, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f6", "fs": fs,
                  "fields": fields}
        d = _retry(lambda: requests.get(url, params=params, headers=UA, timeout=20).json()["data"],
                   what=f"em {label} p{pn}")
        if d is None:
            break
        total = d["total"]
        rows += d["diff"]
        if pn * 100 >= total or not d["diff"]:
            break
        pn += 1
        time.sleep(sleep)
    rec = {"fetchedAt": _now(), "total": total, "rows": rows}
    _write(path, rec)
    print(f"eastmoney {label}: {len(rows)}/{total}", flush=True)
    return rec


def eastmoney_a(refresh=False, max_age_h=72):
    # SH main, SH STAR, SZ main, SZ ChiNext. f2 price, f6 turnover CNY, f20 total mcap, f21 float mcap, f100 行业
    return _em_list("m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80", "f2,f6,f12,f13,f14,f20,f21,f100", "a", refresh, max_age_h)


def eastmoney_hk(refresh=False, max_age_h=72):
    return _em_list("m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:2", "f2,f6,f12,f13,f14,f20,f21,f100", "hk", refresh,
                    max_age_h)


# ---------------------------------------------------------------------------------------------- Taiwan
def taiwan(refresh=False, max_age_h=72):
    import requests
    path = RAW / "taiwan.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    twse = _retry(lambda: requests.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
                                       headers=UA, timeout=30).json(), what="twse")
    time.sleep(0.5)
    tpex = _retry(lambda: requests.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
                                       headers=UA, timeout=30).json(), what="tpex")
    rows = {}
    for x in twse:
        rows[x["Code"] + ".TW"] = {"name": x["Name"], "tv": float(x.get("TradeValue") or 0)}
    for x in tpex:
        try:
            tv = float(x.get("TransactionAmount") or 0)
        except ValueError:
            tv = 0.0
        rows[x["SecuritiesCompanyCode"] + ".TWO"] = {"name": x["CompanyName"], "tv": tv}
    rec = {"fetchedAt": _now(), "rows": rows}
    _write(path, rec)
    print(f"taiwan: {len(rows)} (twse {len(twse)}, tpex {len(tpex)})", flush=True)
    return rec


# ---------------------------------------------------------------------------------------------- Japan
def jpx(refresh=False, max_age_h=24 * 14):
    import requests
    import pandas as pd
    path = RAW / "jpx.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    xl = RAW / "jpx_data_j.xlsx"
    if refresh or not _fresh(xl, max_age_h):
        b = _retry(lambda: requests.get("https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/"
                                        "data_j.xlsx", headers=UA, timeout=60).content, what="jpx")
        xl.write_bytes(b)
    df = pd.read_excel(xl, dtype=str)
    rows = {}
    for _, r in df.iterrows():
        code = str(r["コード"]).strip()
        rows[code + ".T"] = {"name": str(r["銘柄名"]).strip(), "mkt": str(r["市場・商品区分"]),
                             "ind33": str(r["33業種区分"]), "ind17": str(r["17業種区分"]), "size": str(r["規模区分"])}
    rec = {"fetchedAt": _now(), "rows": rows}
    _write(path, rec)
    print(f"jpx: {len(rows)}", flush=True)
    return rec


# ---------------------------------------------------------------------------------------------- HK / A lists
def hkex(refresh=False, max_age_h=24 * 7):
    """HKEX list of securities (Chinese, traditional) -> {"rows": {"0700.HK": {"name", "cls", "sub"}}}"""
    import requests
    import pandas as pd
    path = RAW / "hkex.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    xl = RAW / "hkex_c.xlsx"
    if refresh or not _fresh(xl, max_age_h):
        b = _retry(lambda: requests.get("https://www.hkex.com.hk/chi/services/trading/securities/securitieslists/"
                                        "ListOfSecurities_c.xlsx", headers=UA, timeout=60).content, what="hkex")
        xl.write_bytes(b)
    df = pd.read_excel(xl, header=2, dtype=str)
    rows = {}
    for _, r in df.iterrows():
        cls = str(r["分類"])
        if cls not in ("股本", "房地產投資信託基金"):
            continue
        code = str(r["股份代號"]).strip().lstrip("0").zfill(4)
        rows[code + ".HK"] = {"name": str(r["股份名稱"]).strip(), "cls": cls, "sub": str(r["次分類"])}
    rec = {"fetchedAt": _now(), "rows": rows}
    _write(path, rec)
    print(f"hkex: {len(rows)}", flush=True)
    return rec


def a_lists(refresh=False, max_age_h=24 * 7):
    """SSE (主板 + 科创板) and SZSE official A-share lists via akshare -> {"rows": {"600519.SS": {...}}}"""
    path = RAW / "a_lists.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    import akshare as ak
    rows = {}
    for sym in ("主板A股", "科创板"):
        df = _retry(lambda: ak.stock_info_sh_name_code(symbol=sym), what=f"sse {sym}")
        for _, r in df.iterrows():
            rows[str(r["证券代码"]).zfill(6) + ".SS"] = {"name": str(r["证券简称"]), "full": str(r["公司全称"]),
                                                     "board": sym, "listed": str(r["上市日期"])}
        time.sleep(1)
    df = _retry(lambda: ak.stock_info_sz_name_code(symbol="A股列表"), what="szse")
    for _, r in df.iterrows():
        rows[str(r["A股代码"]).zfill(6) + ".SZ"] = {"name": str(r["A股简称"]), "board": str(r["板块"]),
                                                   "csrc": str(r["所属行业"]), "listed": str(r["A股上市日期"])}
    rec = {"fetchedAt": _now(), "rows": rows}
    _write(path, rec)
    print(f"a_lists: {len(rows)}", flush=True)
    return rec


# ---------------------------------------------------------------------------------------------- 申万
SW_FILES = {"stock": "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls",
            "codes": "https://www.swsresearch.com/swindex/pdf/SwClass2021/SwClassCode_2021.xls"}


def sw(refresh=False, max_age_h=24 * 7):
    """申万 2021 classification of every A-share -> {"rows": {"600519": {"code","l1","l2","l3","since"}}}.
    Downloaded with curl (the site's TLS chain fails python's default CA bundle)."""
    import subprocess
    import pandas as pd
    path = RAW / "sw.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    d = RAW / "sw"
    d.mkdir(exist_ok=True)
    for k, url in SW_FILES.items():
        f = d / url.rsplit("/", 1)[1]
        if refresh or not _fresh(f, max_age_h):
            _retry(lambda: subprocess.run(["curl", "-sf", "-m", "120", "-A", UA["User-Agent"], "-o", str(f), url],
                                          check=True), what=f"sw {k}")
            time.sleep(0.5)
    codes = pd.read_excel(d / "SwClassCode_2021.xls", dtype=str)
    names = {r["行业代码"]: (r["一级行业名称"], r["二级行业名称"], r["三级行业名称"]) for _, r in codes.iterrows()}
    st = pd.read_excel(d / "StockClassifyUse_stock.xls", dtype=str).sort_values("计入日期")
    rows = {}
    for _, r in st.groupby("股票代码").tail(1).iterrows():
        n = names.get(r["行业代码"])
        if not n:
            continue
        rows[str(r["股票代码"]).zfill(6)] = {"code": r["行业代码"], "l1": n[0], "l2": n[1], "l3": n[2],
                                           "since": str(r["计入日期"])[:10]}
    rec = {"fetchedAt": _now(), "rows": rows}
    _write(path, rec)
    print(f"sw: {len(rows)}", flush=True)
    return rec


# ---------------------------------------------------------------------------------------------- FX
CURRENCIES = ["CNY", "HKD", "TWD", "JPY", "KRW", "INR", "GBP", "CHF", "CAD", "AUD", "BRL", "EUR", "SEK", "DKK",
              "NOK", "PLN", "ZAR", "ILS"]


def fx(refresh=False, max_age_h=24):
    """USD value of 1 unit of each currency (+ minor units GBp/ZAc/ILA)."""
    import yfinance as yf
    path = RAW / "fx.json"
    if not refresh and _fresh(path, max_age_h):
        return json.loads(path.read_text())
    syms = [f"{c}USD=X" for c in CURRENCIES]
    df = _retry(lambda: yf.download(syms, period="10d", interval="1d", progress=False, auto_adjust=False,
                                    threads=False)["Close"], what="fx")
    rates = {"USD": 1.0}
    for c, s in zip(CURRENCIES, syms):
        col = df[s].dropna()
        if len(col):
            rates[c] = float(col.iloc[-1])
    rates["GBp"] = rates["GBP"] / 100
    rates["ZAc"] = rates.get("ZAR", 0) / 100
    rates["ILA"] = rates.get("ILS", 0) / 100
    rec = {"fetchedAt": _now(), "asOf": str(df.index[-1].date()), "usdPer": rates}
    _write(path, rec)
    print("fx:", json.dumps(rates), flush=True)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--only", default="fx,lists,tw,jpx,yahoo")
    a = ap.parse_args()
    only = set(a.only.split(","))
    if "fx" in only:
        fx(a.refresh)
    if "lists" in only:
        hkex(a.refresh)
        a_lists(a.refresh)
        sw(a.refresh)
    if "em" in only:          # optional (东方财富 blocks bursts; not required by the build)
        eastmoney_a(a.refresh)
        eastmoney_hk(a.refresh)
    if "tw" in only:
        taiwan(a.refresh)
    if "jpx" in only:
        jpx(a.refresh)
    if "yahoo" in only:
        yahoo_industry(a.refresh)


if __name__ == "__main__":
    main()
