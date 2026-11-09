#!/usr/bin/env python3
"""Step 1 — full US stock universe from the Nasdaq screener.

Reads  fullmarket/raw/nasdaq_stocks.json, fullmarket/raw/nasdaq_etf.json
       (download them with `python3 fullmarket/build_universe_raw.py --download`)
Writes fullmarket/universe_raw.json

Filter: marketCap >= $300M, common equity only (drops notes/bonds, preferreds, warrants, rights,
units, closed-end funds, SPACs), symbols normalised for yfinance ("BRK/B" -> "BRK-B").
Secondary share classes (GOOG vs GOOGL) are kept but marked `altOf` (excluded from the map tree).
"""
import json, re, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
MIN_CAP = 300e6
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
URLS = {
    "nasdaq_stocks.json": "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true",
    "nasdaq_etf.json": "https://api.nasdaq.com/api/screener/etf?tableonly=true&download=true",
}


def download():
    RAW.mkdir(exist_ok=True)
    for fn, url in URLS.items():
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"})
        with urllib.request.urlopen(req, timeout=60) as r:
            (RAW / fn).write_bytes(r.read())
        print("downloaded", fn)


def fnum(x):
    try:
        return float(str(x).replace("$", "").replace(",", "").replace("%", "") or 0)
    except ValueError:
        return 0.0


ADR = re.compile(r"American Depositary|American Depository|\bADS\b|\bADR\b|Sponsored ADR", re.I)
# fixed income, preferreds, derivatives, units that are not common equity
NONCOMMON = re.compile(
    r"\bWarrants?\b|\bRights\b|Contingent Value|\bNotes?\b|Debentures?|\bBonds?\b|"
    r"Preferred (Stock|Shares|Securities|Units)|Perpetual Preferred|Trust Preferred|"
    r"Depositary Shares\b(?!.*American)|Tangible Equity Units?|Corporate Units|"
    r"\d+(\.\d+)?\s?%|\bZONES\b|Fixed-to-Floating|Fixed-Rate|Mandatory Convertible", re.I)
# closed-end funds / interval funds that Nasdaq lists as stocks
CEF = re.compile(
    r"\bFund\b|Municipal|\bMuni[A-Z]|Income Trust|Term Trust|Opportunities Trust|Opportunity Trust|"
    r"Dividend & Income|Tax-Advantaged|Tax-Managed|Buy-Write|Floating Rate Income|Strategic Municipals|"
    r"Income Solutions|Dynamic Income|Science and Technology Trust|Health Sciences Trust|Utility Trust|"
    r"Small-Cap Trust|Capital Allocation|Resources & Commodities|Energy and Resources Trust|"
    r"Enhanced Equity|Enhanced Large Cap|Total Return Realty|Quality Income Realty|Tri-Continental|"
    r"Central Securities|Select Tax Free|Corporate Investors|Credit Opportunities|Healthcare Investors|"
    r"Equity & Convertible|Convertible & Income|Government Markets Income|Intermediate Income|"
    r"Trust for Investment Grade|Credit Allocation|Limited Duration Income|Premier Income|"
    r"Strategic Total Return|General American Investors|Adams (Diversified|Natural)|ESG Capital|"
    r"Technology and Private Equity|Private Credit|Interval", re.I)
CEF_INDUSTRY = {"Trusts Except Educational Religious and Charitable"}
SPAC = re.compile(r"Acquisition Corp|Merger Corp|Blank Check|SPAC\b", re.I)
REAL_DESPITE_NAME = {"MTAL", "PRE"}   # operating companies that kept a SPAC-style name / industry
KEEP_UNITS = re.compile(r"Common Units|Limited Partner|L\.?P\.?\b|Partners|Partnership|Investment Trust Units", re.I)


def classify(r):
    """return (keep: bool, kind or drop-reason)"""
    sym, name, ind = r["symbol"], r["name"], r.get("industry", "")
    if "^" in sym or "." in sym:
        return False, "special-symbol"
    adr = bool(ADR.search(name))
    if not adr and NONCOMMON.search(name):
        return False, "non-common (pref/notes/warrant/unit)"
    if re.search(r"\bUnits?\b", name) and not adr and not KEEP_UNITS.search(name):
        return False, "units"
    if sym not in REAL_DESPITE_NAME and SPAC.search(name):
        return False, "spac"
    if ind in CEF_INDUSTRY or (CEF.search(name) and ind != "Real Estate Investment Trusts"):
        return False, "closed-end fund"
    if adr:
        return True, "adr"
    if KEEP_UNITS.search(name) and re.search(r"Units?|L\.?P\.?\b", name):
        return True, "mlp"
    return True, "common"


CLASS_WORDS = re.compile(
    r"\b(Class [A-Z]( Common)?|Series [A-Z]|Capital Stock|Common Stock|Common Shares|Ordinary Shares?|"
    r"Subordinate Voting Shares|Non-Voting|Voting|Common|Stock|Shares|New|Inc\.?|Corp(oration)?\.?|"
    r"Ltd\.?|Limited|plc|PLC|Holdings?|Group|Co\.|Company)\b", re.I)


def issuer_key(name):
    k = CLASS_WORDS.sub(" ", name)
    k = re.sub(r"[^A-Za-z0-9 ]", " ", k)
    return " ".join(k.lower().split())


SHORT_STRIP = re.compile(
    r"\s+(American Depositary Shares?.*|American Depository Shares?.*|Sponsored ADR.*|ADS.*|"
    r"Common Stock.*|Common Shares.*|Ordinary Shares?.*|Class [A-Z] .*|Class [A-Z]$|"
    r"Common Units.*|Limited Partnership Units.*|Units.*|Registered.*|New York Registry.*|"
    r"Subordinate Voting.*|Capital Stock.*|Shares of Beneficial.*|Depositary.*)$", re.I)
SHORT_SUFFIX = re.compile(
    r"[,\s]+(Inc\.?|Incorporated|Corporation|Corp\.?|Company|Co\.|Ltd\.?|Limited|plc|PLC|N\.V\.|S\.A\.?|"
    r"SE|AG|L\.P\.|LP|LLC|Holdings?|Group|Holding Co\.|S\.A\.B\. de C\.V\.|A/S|ASA|SpA|S\.p\.A\.|"
    r"Technologies|\(The\)|The)$", re.I)


LEGAL_CUT = re.compile(
    r"(?<=\S)\s+(Inc\b|Incorporated|Corporation|Corp\b|Company\b|Ltd\b|Limited|plc\b|PLC\b|N\.V\.|S\.A\.|"
    r"S\.A\.B\.|SE\b|AG\b|L\.P\.|LP\b|LLC\b|Co\.|Common\b|Class [A-Z]\b|Ordinary|American Depositary|"
    r"American Depository|Sponsored|ADS\b|Depositary|Registered|New York Registry|Units?\b|"
    r"Shares? of Beneficial|Capital Stock|Subordinate Voting).*$", re.I)


def short_name(name):
    s = name.strip()
    s = re.sub(r"\s*\(.*$", "", s)                       # cut at first "("
    s = LEGAL_CUT.sub("", s)
    s = SHORT_STRIP.sub("", s)
    for _ in range(3):
        s2 = SHORT_SUFFIX.sub("", s).strip(" ,.")
        if s2 == s or len(s2) < 3:
            break
        s = s2
    s = re.sub(r"^The\s+", "", s)
    s = re.sub(r"\s+(&|and|REIT)$", "", s).strip(" ,.-")
    if len(s) > 24:
        s = s[:24].rsplit(" ", 1)[0]
    if s.isupper() and len(s) > 5 and " " in s:            # STARWOOD PROPERTY TRUST -> Starwood Property Trust
        s = s.title()
    return s or name[:20]


def main():
    if "--download" in sys.argv:
        download()
    stocks = json.loads((RAW / "nasdaq_stocks.json").read_text())["data"]["rows"]
    try:
        etf_doc = json.loads((RAW / "nasdaq_etf.json").read_text())
        etf_rows = etf_doc["data"]["data"]["rows"]
        etf_asof = etf_doc["data"].get("dataAsOf")
    except Exception as e:  # noqa
        etf_rows, etf_asof = [], f"unavailable: {e}"

    kept, dropped = [], []
    below = 0
    for r in stocks:
        cap = fnum(r.get("marketCap"))
        if cap < MIN_CAP:
            below += 1
            continue
        ok, kind = classify(r)
        rec = {
            "t": r["symbol"].replace("/", "-").strip(),
            "nasdaq": r["symbol"],
            "name": r["name"].strip(),
            "short": short_name(r["name"]),
            "cap": round(cap),
            "sector": (r.get("sector") or "").strip(),
            "industry": (r.get("industry") or "").strip(),
            "country": (r.get("country") or "").strip(),
            "ipo": r.get("ipoyear") or None,
            "last": fnum(r.get("lastsale")),
            "vol": int(fnum(r.get("volume"))),
        }
        rec["dv"] = round(rec["last"] * rec["vol"])
        if ok:
            rec["kind"] = kind
            kept.append(rec)
        else:
            rec["drop"] = kind
            dropped.append(rec)

    # secondary share classes: same issuer, keep the one that trades the most dollars as primary
    groups = {}
    for rec in kept:
        groups.setdefault(issuer_key(rec["name"]), []).append(rec)
    n_alt = 0
    for k, g in groups.items():
        if len(g) < 2:
            continue
        caps = [x["cap"] for x in g]
        if max(caps) > 1.6 * min(caps):   # different companies that happen to share words
            continue
        same_name = len({x["name"] for x in g}) == 1
        if not same_name and not any(re.search(r"Class|Series|Capital Stock|Voting", x["name"]) for x in g):
            continue                      # e.g. First Bancorp (FBNC) vs First BanCorp (FBP)
        g.sort(key=lambda x: -x["dv"])
        for x in g[1:]:
            x["altOf"] = g[0]["t"]
            n_alt += 1

    kept.sort(key=lambda x: -x["cap"])
    etfs = [{"t": e["symbol"].replace("/", "-"), "name": e.get("companyName", ""),
             "last": fnum(e.get("lastSalePrice")), "chg1y": e.get("oneYearPercentage")}
            for e in etf_rows]
    out = {
        "source": URLS,
        "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime((RAW / "nasdaq_stocks.json").stat().st_mtime)),
        "rule": "Nasdaq screener rows with marketCap >= $300M, common equity/ADR/MLP units only",
        "counts": {"nasdaqRows": len(stocks), "belowCap": below, "kept": len(kept),
                   "primary": len(kept) - n_alt, "altClass": n_alt, "dropped": len(dropped),
                   "etfs": len(etfs)},
        "stocks": kept,
        "dropped": dropped,
        "etfs": {"asOf": etf_asof, "count": len(etfs), "rows": etfs},
    }
    (HERE / "universe_raw.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(out["counts"]))
    from collections import Counter
    print("drop reasons:", Counter(d["drop"] for d in dropped).most_common())
    print("kinds:", Counter(k["kind"] for k in kept).most_common())


if __name__ == "__main__":
    main()
