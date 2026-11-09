"""ETF real money flows = Δ shares outstanding × NAV (creations − redemptions), DESIGN §23/§24.

Universe: every ETF in the curated world continents (intl / bonds / commod / crypto / cash) of
universe/parts/world.json.

Sources, best first:
  1. iShares (BlackRock) — full daily history of NAV + Shares Outstanding from the fund-document API
     (the same "Download" file as the product page, sheet "Historical"); refreshed weekly, and every day
     the one-call product screener (NAV + total net assets for all iShares funds) appends the newest day.
  2. State Street SPDR — navhist-us-en-<t>.xlsx: full daily history Date / NAV / Shares Outstanding / TNA,
     fetched every run (~200 KB each). Includes GLD and GLDM.
  3. Everyone else — a daily snapshot from Yahoo (yfinance .info: totalAssets, navPrice, sharesOutstanding)
     stored in flows/store so a history starts accumulating today. Yahoo's numbers are often stale, so these
     items are marked est:true until an issuer adapter replaces them.

Store: flows/store/etf/<TICKER>.csv (date,nav,shares,src) + raw daily snapshots in flows/store/snapshots/.
Output: web/data/flows/etf.json.
"""
from __future__ import annotations

import concurrent.futures as cf
import csv
import datetime as dt
import io
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (OUT, STORE, envelope, http_get, http_json, last_us_session, log,  # noqa: E402
                    r2, read_json, save_snapshot, today_local, world_etf_universe, write_json)

ETF_DIR = STORE / "etf"
ETF_DIR.mkdir(parents=True, exist_ok=True)
META_PATH = STORE / "etf_meta.json"
WINDOW = 252

ISH_SCREENER = ("https://www.ishares.com/us/product-screener/product-screener-v3.1.jsn?dcrPath=/templatedata/"
                "config/product-screener-v3/data/en/us-ishares/ishares-product-screener-backend-config"
                "&siteEntryPassthrough=true")
ISH_DOC = ("https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document"
           "?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US&portfolioId={pid}"
           "&component=fundDownload&userType=individual")
SSGA_NAV = "https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-{t}.xlsx"

ISSUER_LABEL = {"ishares-hist": "iShares 官网每日份额", "ishares-screener": "iShares 官网每日份额",
                "ssga-navhist": "State Street SPDR 官网每日份额", "yf-snapshot": "Yahoo 快照（每天记一次）",
                "issuer-page": "发行商官网当日份额（从首次运行起每天记一次）"}


# ------------------------------------------------------------------------------------ store helpers
def load_series(t: str) -> list[dict]:
    p = ETF_DIR / f"{t}.csv"
    if not p.exists():
        return []
    rows = []
    with open(p, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                rows.append({"date": r["date"], "nav": float(r["nav"]) if r["nav"] else None,
                             "shares": float(r["shares"]) if r["shares"] else None, "src": r["src"],
                             "raw": r.get("raw", "")})
            except Exception:  # noqa: BLE001
                continue
    rows.sort(key=lambda r: r["date"])
    return rows


def save_series(t: str, rows: list[dict]):
    by = {}
    for r in rows:
        by[r["date"]] = r                         # later rows win
    rows = [by[d] for d in sorted(by)]
    p = ETF_DIR / f"{t}.csv"
    tmp = p.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "nav", "shares", "src", "raw"])
        for r in rows:
            w.writerow([r["date"], "" if r["nav"] is None else f"{r['nav']:.6f}",
                        "" if r["shares"] is None else f"{r['shares']:.0f}", r["src"], r.get("raw", "")])
    tmp.replace(p)


SRC_PRIORITY = {"ishares-hist": 3, "ssga-navhist": 3, "ishares-screener": 2, "issuer-page": 2, "yf-snapshot": 1}


def merge_rows(old: list[dict], new: list[dict], *, replace_src: str | None = None) -> list[dict]:
    """Merge by date; a row only replaces one of equal or lower source priority (issuer history beats the
    screener point, which beats a Yahoo snapshot). Older dates are never dropped."""
    by = {r["date"]: r for r in old}
    for r in new:
        prev = by.get(r["date"])
        if prev is None or SRC_PRIORITY.get(r["src"], 0) >= SRC_PRIORITY.get(prev["src"], 0):
            by[r["date"]] = r
    return [by[d] for d in sorted(by)]


# ------------------------------------------------------------------------------------ meta
def ensure_meta(tickers: list[str], ish_map: dict) -> dict:
    """quoteType / fundFamily per ticker (yfinance .info), cached; refreshed after 30 days."""
    meta = read_json(META_PATH, {}) or {}
    need = []
    for t in tickers:
        m = meta.get(t)
        if t in ish_map:
            meta[t] = {**(m or {}), "quoteType": "ETF", "fundFamily": "iShares", "checked": today_local()}
            continue
        if not m or not m.get("quoteType") or (dt.date.today() - dt.date.fromisoformat(m.get("checked", "2000-01-01"))).days > 30:
            need.append(t)
    if need:
        log(f"meta: classifying {len(need)} tickers via yfinance")
        import yfinance as yf

        def one(t):
            for i in range(3):
                try:
                    inf = yf.Ticker(t).info
                    return t, {"quoteType": inf.get("quoteType"), "fundFamily": inf.get("fundFamily"),
                               "longName": inf.get("longName"), "checked": today_local()}
                except Exception:  # noqa: BLE001
                    time.sleep(2 + 3 * i)
            return t, None

        with cf.ThreadPoolExecutor(3) as ex:
            for t, v in ex.map(one, need):
                if v:
                    meta[t] = v
    write_json(META_PATH, meta, indent=1)
    return meta


# ------------------------------------------------------------------------------------ iShares
def ishares_screener():
    d = http_json(ISH_SCREENER, timeout=90)
    out = {}
    for pid, v in d.items():
        t = v.get("localExchangeTicker")
        if not t:
            continue

        def rv(k):
            x = v.get(k)
            return x.get("r") if isinstance(x, dict) else x
        out[t] = {"pid": pid, "url": v.get("productPageUrl"), "name": v.get("fundName"),
                  "nav": rv("navAmount"), "navAsOf": rv("navAmountAsOf"),
                  "tna": rv("totalNetAssetsFund"), "tnaAsOf": rv("totalNetAssetsFundAsOf")}
    return out


def _ymd(r) -> str | None:
    try:
        s = str(int(r))
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    except Exception:  # noqa: BLE001
        return None


_CELL = re.compile(r"<ss:Cell[^>]*>(.*?)</ss:Cell>", re.S)
_ROW = re.compile(r"<ss:Row[^>]*>(.*?)</ss:Row>", re.S)
_TAG = re.compile(r"<[^>]+>")


def ishares_history(pid: str) -> list[dict]:
    raw = http_get(ISH_DOC.format(pid=pid), timeout=180, retries=2).decode("utf-8", "replace")
    i = raw.find('ss:Name="Historical"')
    if i < 0:
        raise RuntimeError("no Historical sheet")
    j = raw.find("</ss:Worksheet>", i)
    rows = _ROW.findall(raw[i:j if j > 0 else None])
    if not rows:
        raise RuntimeError("empty Historical")
    head = [_TAG.sub("", c).strip() for c in _CELL.findall(rows[0])]
    try:
        ia = head.index("As Of")
        inav = head.index("NAV per Share")
        iso = head.index("Shares Outstanding")
    except ValueError as e:
        raise RuntimeError(f"unexpected header {head}") from e
    out = []
    for r in rows[1:]:
        c = [_TAG.sub("", x).strip() for x in _CELL.findall(r)]
        if len(c) <= max(ia, inav, iso):
            continue
        try:
            d = dt.datetime.strptime(c[ia], "%b %d, %Y").date().isoformat()
            nav = float(c[inav].replace(",", ""))
            so = float(c[iso].replace(",", ""))
        except Exception:  # noqa: BLE001
            continue
        out.append({"date": d, "nav": nav, "shares": so, "src": "ishares-hist", "raw": ""})
    out.sort(key=lambda r: r["date"])
    return out


# ------------------------------------------------------------------------------------ SSGA
SSGA_FAMILIES = ("State Street", "SPDR")


def ssga_history(t: str) -> list[dict]:
    import pandas as pd
    b = http_get(SSGA_NAV.format(t=t.lower()), timeout=60, retries=2)
    if not b.startswith(b"PK"):
        raise RuntimeError("not an xlsx")
    x = pd.read_excel(io.BytesIO(b), header=None)
    hdr_row = None
    for i in range(min(15, len(x))):
        if str(x.iat[i, 0]).strip() == "Date":
            hdr_row = i
            break
    if hdr_row is None:
        raise RuntimeError("no Date header")
    head = [str(v).strip() for v in x.iloc[hdr_row].tolist()]
    inav, iso = head.index("NAV"), head.index("Shares Outstanding")
    out = []
    for i in range(hdr_row + 1, len(x)):
        d0 = x.iat[i, 0]
        try:
            d = (d0.date() if hasattr(d0, "date") else dt.datetime.strptime(str(d0).strip(), "%d-%b-%Y").date()).isoformat()
            nav, so = float(x.iat[i, inav]), float(x.iat[i, iso])
        except Exception:  # noqa: BLE001
            continue
        if so > 0 and nav > 0:
            out.append({"date": d, "nav": nav, "shares": so, "src": "ssga-navhist", "raw": ""})
    out.sort(key=lambda r: r["date"])
    if not out:
        raise RuntimeError("no rows")
    return out


# ------------------------------------------------------------------------------------ issuer page snapshot
# Issuers whose fund page shows today's shares outstanding in plain HTML (checked 2026-10-28). No history is
# published, so these start a daily issuer-accurate history from the first run (history:'issuer-snapshot').
ISSUER_PAGES = {
    "Global X Funds": "https://www.globalxetfs.com/funds/{tl}/",
    "First Trust": "https://www.ftportfolios.com/Retail/Etf/EtfSummary.aspx?Ticker={T}",
    "KraneShares": "https://kraneshares.com/{tl}/",
}
_SO_RE = re.compile(r"(?:Shares Outstanding|Outstanding Shares)\s*:?\s*([0-9][0-9,]{4,})")
_DATE_RE = re.compile(r"(?:[Aa]s of|AS OF)\s*:?\s*(\d{1,2}/\d{1,2}/\d{4}|[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})")


def issuer_page_shares(t: str, family: str):
    url = ISSUER_PAGES[family].format(tl=t.lower(), T=t.upper())
    html = http_get(url, timeout=45, retries=2).decode("utf-8", "replace")
    text = re.sub(r"\s+", " ", _TAG.sub(" ", html))
    m = _SO_RE.search(text)
    if not m:
        raise RuntimeError("no shares outstanding on page")
    so = float(m.group(1).replace(",", ""))
    d = None
    dm = _DATE_RE.search(text[max(0, m.start() - 400): m.end() + 400])
    if dm:
        s = dm.group(1).replace(".", "")
        for fmt in ("%m/%d/%Y", "%B %d, %Y", "%b %d, %Y"):
            try:
                d = dt.datetime.strptime(s, fmt).date().isoformat()
                break
            except ValueError:
                pass
    return so, d, url


# ------------------------------------------------------------------------------------ Yahoo snapshot
def yf_snapshot(tickers: list[str]) -> dict:
    import yfinance as yf

    def one(t):
        for i in range(3):
            try:
                inf = yf.Ticker(t).info
                return t, {k: inf.get(k) for k in ("totalAssets", "navPrice", "sharesOutstanding",
                                                    "regularMarketPrice", "previousClose", "fundFamily")}
            except Exception:  # noqa: BLE001
                time.sleep(2 + 3 * i)
        return t, None

    out = {}
    with cf.ThreadPoolExecutor(3) as ex:
        for t, v in ex.map(one, tickers):
            if v:
                out[t] = v
    return out


def snapshot_row(t: str, snap: dict, prev_rows: list[dict], day: str) -> dict | None:
    """One stored row from a Yahoo snapshot. shares = totalAssets / navPrice; if totalAssets did not change
    since the previous snapshot, carry the previous share count (stale TA must not create fake flows)."""
    ta, nav = snap.get("totalAssets"), snap.get("navPrice") or snap.get("previousClose")
    if not nav:
        return None
    raw = f"ta={ta or ''};so={snap.get('sharesOutstanding') or ''}"
    prev = next((r for r in reversed(prev_rows) if r["src"] == "yf-snapshot"), None)
    shares = None
    if ta:
        prev_ta = None
        if prev and prev.get("raw", "").startswith("ta="):
            try:
                prev_ta = float(prev["raw"].split(";")[0][3:] or "nan")
            except Exception:  # noqa: BLE001
                prev_ta = None
        if prev is not None and prev_ta is not None and abs(prev_ta - float(ta)) < 1:
            shares = prev["shares"]
        else:
            shares = float(ta) / float(nav)
    elif snap.get("sharesOutstanding"):
        shares = float(snap["sharesOutstanding"])
    if not shares:
        return None
    return {"date": day, "nav": float(nav), "shares": shares, "src": "yf-snapshot", "raw": raw}


# ------------------------------------------------------------------------------------ flows
def compute_flows(rows: list[dict]):
    """daily flow (USD m) = (S_t − S_{t−1}) × NAV_t, with split / glitch guards."""
    rows = [r for r in rows if r["shares"] and r["nav"]]
    flows = []
    for i in range(1, len(rows)):
        a, b = rows[i - 1], rows[i]
        ratio = b["shares"] / a["shares"]
        nav_ratio = b["nav"] / a["nav"]
        f = (b["shares"] - a["shares"]) * b["nav"] / 1e6
        flag = None
        if (ratio > 1.5 or ratio < 0.67) and abs(ratio * nav_ratio - 1) < 0.12:
            f, flag = 0.0, "split"
        flows.append({"date": b["date"], "usd": f, "flag": flag, "aum": b["shares"] * b["nav"] / 1e6,
                      "src": b["src"]})
    # glitch: a one-day jump > 40% of AUM that fully reverses the next day
    for i in range(len(flows) - 1):
        f0, f1 = flows[i], flows[i + 1]
        if f0["aum"] > 0 and abs(f0["usd"]) > 0.4 * f0["aum"] and f0["usd"] * f1["usd"] < 0 and \
                abs(f0["usd"] + f1["usd"]) < 0.2 * abs(f0["usd"]):
            f0["usd"] = f1["usd"] = 0.0
            f0["flag"] = f1["flag"] = "glitch"
    return flows


def summarize(fl: list[dict], n: int) -> float | None:
    if not fl:
        return None
    return r2(sum(x["usd"] for x in fl[-n:]), 1)


# ------------------------------------------------------------------------------------ main
def main(full_refresh_days: int = 7, workers: int = 2):
    t0 = time.time()
    uni, region_names = world_etf_universe()
    tickers = sorted(uni)
    log(f"etf: {len(tickers)} tickers in world continents")
    errors: dict = {}

    # iShares screener (one call: every iShares fund's latest NAV and total net assets)
    try:
        ish = ishares_screener()
        mine = {t: v for t, v in ish.items() if t in uni}
        nav_asof = _ymd(next(iter(mine.values()))["navAsOf"]) if mine else None
        save_snapshot("ishares_screener", mine, day=nav_asof)
        log(f"etf: iShares screener {len(ish)} funds, {len(mine)} in our world, asOf {nav_asof}")
    except Exception as e:  # noqa: BLE001
        ish, mine = {}, {}
        errors["ishares_screener"] = str(e)[:300]
        log("etf: iShares screener failed", e)

    meta = ensure_meta(tickers, mine)
    etfs = [t for t in tickers if (meta.get(t) or {}).get("quoteType") == "ETF"]
    log(f"etf: {len(etfs)} ETFs")
    state = read_json(STORE / "etf_state.json", {}) or {}

    # ---- iShares full history (first run / weekly), screener point daily
    def ish_job(t):
        info = mine[t]
        rows = load_series(t)
        last_full = state.get(t, {}).get("fullAt", "2000-01-01")
        need_full = not rows or (dt.date.today() - dt.date.fromisoformat(last_full)).days >= full_refresh_days
        if need_full:
            hist = ishares_history(info["pid"])
            rows = merge_rows(rows, hist, replace_src="ishares-hist")
            state.setdefault(t, {})["fullAt"] = today_local()
        d = _ymd(info.get("navAsOf"))
        if d and info.get("nav") and info.get("tna") and _ymd(info.get("tnaAsOf")) == d:
            if not rows or rows[-1]["date"] < d:
                so = round(float(info["tna"]) / float(info["nav"]) / 100.0) * 100.0
                rows.append({"date": d, "nav": float(info["nav"]), "shares": so, "src": "ishares-screener", "raw": ""})
        save_series(t, rows)
        state.setdefault(t, {})["src"] = "ishares"
        return t, len(rows), need_full

    ish_targets = [t for t in etfs if t in mine]
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(ish_job, t): t for t in ish_targets}
        for fu in cf.as_completed(futs):
            t = futs[fu]
            try:
                _, n, full = fu.result()
                if full:
                    log(f"etf: iShares {t} history {n} rows")
            except Exception as e:  # noqa: BLE001
                errors[t] = f"ishares: {str(e)[:200]}"
                log(f"etf: iShares {t} failed: {e}")

    # ---- SSGA navhist (all SPDR funds, every run)
    ssga_targets = [t for t in etfs if t not in mine and any(s in ((meta.get(t) or {}).get("fundFamily") or "")
                                                               for s in SSGA_FAMILIES)]
    for t in ssga_targets:
        try:
            hist = ssga_history(t)
            rows = merge_rows(load_series(t), hist, replace_src="ssga-navhist")
            save_series(t, rows)
            state.setdefault(t, {})["src"] = "ssga"
            time.sleep(0.4)
        except Exception as e:  # noqa: BLE001
            errors[t] = f"ssga: {str(e)[:200]}"
            log(f"etf: SSGA {t} failed: {e}")
    ssga_ok = [t for t in ssga_targets if t not in errors]

    # ---- issuer fund pages with today's shares outstanding (accurate, but no published history)
    day = last_us_session()
    page_targets = [t for t in etfs if t not in mine and t not in ssga_ok and
                    (meta.get(t) or {}).get("fundFamily") in ISSUER_PAGES]
    page_so = {}
    for t in page_targets:
        try:
            so, d, url = issuer_page_shares(t, meta[t]["fundFamily"])
            # a page date is trusted only if it is the last session or a few days before (pages carry many
            # unrelated "as of" dates: prospectus, expense ratio…)
            if not d or not (0 <= (dt.date.fromisoformat(day) - dt.date.fromisoformat(d)).days <= 5):
                d = day
            page_so[t] = {"shares": so, "asOf": d, "url": url}
            time.sleep(0.6)
        except Exception as e:  # noqa: BLE001
            errors[t] = f"page: {str(e)[:160]}"
    if page_so:
        save_snapshot("issuer_pages", page_so, day=day)

    # ---- Yahoo snapshot for everything else (NAV for the page tickers; and failed issuer pulls still accumulate)
    snap_targets = [t for t in etfs if t not in mine and t not in ssga_ok]
    snaps = yf_snapshot(snap_targets) if snap_targets else {}
    save_snapshot("yf_etf_info", snaps, day=day)
    for t, p in page_so.items():
        s = snaps.get(t) or {}
        nav = s.get("navPrice") or s.get("previousClose") or s.get("regularMarketPrice")
        if not nav:
            continue
        rows = [r for r in load_series(t) if r["src"] != "yf-snapshot"]     # never mix with Yahoo rows
        rows = merge_rows(rows, [{"date": p["asOf"], "nav": float(nav), "shares": p["shares"],
                                  "src": "issuer-page", "raw": p["url"]}])
        save_series(t, rows)
        state.setdefault(t, {})["src"] = "issuer-page"
    for t, s in snaps.items():
        if t in page_so:
            continue
        rows = load_series(t)
        if any(r["src"] != "yf-snapshot" for r in rows):
            continue      # issuer data exists (temporary failure today) — don't mix sources
        row = snapshot_row(t, s, rows, day)
        if row:
            rows = merge_rows(rows, [row])
            save_series(t, rows)
            state.setdefault(t, {})["src"] = "yahoo"
    write_json(STORE / "etf_state.json", state, indent=1)

    # ---- build items
    items, asofs = [], []
    for t in etfs:
        rows = load_series(t)
        if not rows:
            continue
        srcs = {r["src"] for r in rows}
        issuer = ("ishares" if srcs & {"ishares-hist", "ishares-screener"} else
                  "ssga" if "ssga-navhist" in srcs else "page" if "issuer-page" in srcs else "yahoo")
        if issuer == "page":
            rows = [r for r in rows if r["src"] == "issuer-page"]
        fl = compute_flows(rows)
        win = fl[-WINDOW:]
        last = rows[-1]
        u = uni[t]
        est = issuer == "yahoo"
        item = {
            "ticker": t, "id": f"s:{t}", "name": u["name"], "note": u.get("note"),
            "continent": u["continent"], "nodes": u["regions"], "paths": u["paths"],
            "issuer": (meta.get(t) or {}).get("fundFamily") or issuer,
            "date": [x["date"] for x in win], "usd": [r2(x["usd"], 2) for x in win],
            "source": ISSUER_LABEL.get(last["src"], last["src"]),
            "sourceUrl": ("https://www.ishares.com" + mine[t]["url"]) if t in mine and mine[t].get("url") else
                         (SSGA_NAV.format(t=t.lower()) if issuer == "ssga" else
                          last.get("raw") if issuer == "page" else f"https://finance.yahoo.com/quote/{t}"),
            "asOf": last["date"],
            "history": {"yahoo": "snapshot", "page": "issuer-snapshot"}.get(issuer, "issuer-daily"),
            "since": rows[0]["date"],
            "nDays": len(rows),
            "est": est,
            "aum": r2(last["shares"] * last["nav"] / 1e6, 1), "shares": r2(last["shares"], 0), "nav": r2(last["nav"], 4),
            "flow1": summarize(win, 1), "flow5": summarize(win, 5), "flow20": summarize(win, 20),
            "flow60": summarize(win, 60), "flow252": summarize(win, 252),
        }
        if item["aum"] and item["flow20"] is not None:
            item["pctAum20"] = r2(100 * item["flow20"] / item["aum"], 2)
        flags = [x["date"] for x in win if x["flag"]]
        if flags:
            item["flagged"] = flags
        if est:
            # §23 "real money first; estimates stay marked": consumers read date[]/usd[] as real money, so the
            # stale Yahoo-derived series lives in estDate[]/estUsd[] and date[]/usd[] stay empty.
            item["estDate"], item["estUsd"] = item["date"], item["usd"]
            item["date"], item["usd"] = [], []
            for k in ("flow1", "flow5", "flow20", "flow60", "flow252", "pctAum20"):
                item.pop(k, None)
            item["basis"] = ("Yahoo 快照：份额≈总资产÷净值。实测（2026-10-28，对照 85 只有官网数据的 ETF）中位误差 3.7%，"
                             "常滞后几周到几个月 —— 只能看大方向，日度数字别当真；从首次运行起每天记一次")
            item["conf"] = 0.2
        items.append(item)
        if not est:
            asofs.append(last["date"])

    # ---- region / continent aggregates (unique tickers; issuer-daily members only)
    regions = build_regions(items, region_names)
    asof = max(asofs) if asofs else None
    n_real = sum(1 for i in items if not i["est"])
    n_page = sum(1 for i in items if i["history"] == "issuer-snapshot")
    doc = envelope("etf", source="ETF 份额变化 × 净值：iShares/BlackRock 官网 + State Street SPDR 官网（真实每日历史）；"
                                 "Global X / First Trust / KraneShares 官网当日份额（从首次运行起积累）；"
                                 "其他发行商用 Yahoo 每日快照（est:true，从首次运行起积累）",
                   asOf=asof, items=items,
                   notes=["usd[] = 当天份额变化 × 当天净值（百万美元），正 = 申购（钱进来），负 = 赎回（钱走了）",
                          "发行商公布的份额通常反映前一交易日下单的申赎（T+1 记账），日期按发行商的 as-of 日期",
                          "history='snapshot' 的条目从开始记录那天起才有数据，est:true，别当真钱看"],
                   regions=regions,
                   coverage={"etfs": len(items), "issuerDaily": n_real - n_page, "issuerSnapshot": n_page,
                             "yahooSnapshot": len(items) - n_real,
                             "aumIssuerDaily": r2(sum(i["aum"] or 0 for i in items if i["history"] == "issuer-daily"), 0),
                             "aumAll": r2(sum(i["aum"] or 0 for i in items), 0)},
                   errors=errors, ms=int((time.time() - t0) * 1000))
    write_json(OUT / "etf.json", doc)
    log(f"etf: wrote {len(items)} items ({n_real} issuer-daily), {len(regions)} regions, asOf {asof}, "
        f"{len(errors)} errors, {time.time() - t0:.0f}s")
    return doc


def build_regions(items: list[dict], region_names: dict) -> list[dict]:
    members: dict = {}
    for it in items:
        ids = set()
        for p in it["paths"]:
            ids.update(p[1:])          # continent + regions (skip 'world')
        for rid in ids:
            members.setdefault(rid, []).append(it)
    out = []
    for rid, its in members.items():
        real = [i for i in its if not i["est"] and i["date"]]
        aum_all = sum(i["aum"] or 0 for i in its)
        aum_real = sum(i["aum"] or 0 for i in real)
        if not real:
            out.append({"id": rid, "name": region_names.get(rid, {}).get("name"), "date": [], "usd": [],
                        "members": [i["ticker"] for i in its], "covered": [], "coverage": 0.0,
                        "source": "无发行商每日数据", "asOf": None, "est": True})
            continue
        dates = sorted({d for i in real for d in i["date"]})[-WINDOW:]
        pos = {d: k for k, d in enumerate(dates)}
        usd = [0.0] * len(dates)
        for i in real:
            for d, v in zip(i["date"], i["usd"]):
                if d in pos and v is not None:
                    usd[pos[d]] += v
        out.append({"id": rid, "name": region_names.get(rid, {}).get("name"),
                    "date": dates, "usd": [r2(v, 2) for v in usd],
                    "members": [i["ticker"] for i in its], "covered": [i["ticker"] for i in real],
                    "coverage": r2(aum_real / aum_all, 3) if aum_all else None,
                    "aum": r2(aum_real, 1),
                    "flow5": r2(sum(usd[-5:]), 1), "flow20": r2(sum(usd[-20:]), 1), "flow60": r2(sum(usd[-60:]), 1),
                    "source": "成员 ETF 份额变化 × 净值之和（只算有发行商每日数据的）",
                    "asOf": dates[-1] if dates else None, "est": False})
    out.sort(key=lambda r: r["id"])
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--full-refresh-days", type=int, default=7)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    main(a.full_refresh_days, a.workers)
