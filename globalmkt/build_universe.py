#!/usr/bin/env python3
"""Global universe (DESIGN §23) — liquid listings outside the US, as one tree:

    gl-world -> regions (4) -> countries/markets -> sectors (11) -> [groups] -> industries -> [cap tiers] -> stocks

Inputs (cached by globalmkt/universe/sources.py under globalmkt/universe/raw/):
  Yahoo equity screener per industry (symbols, names, currency, marketCap, 3-month average volume, price),
  SSE/SZSE official A-share lists (Chinese names), 申万2021 classification (A-share industries), HKEX list
  (Chinese names), TWSE/TPEX (Chinese names),
  JPX listed-company file (Japanese names), FX (USD per unit), fullmarket/universe_raw.json (US companies, to
  keep US names out: the US stays in fullmarket/curated).

Rules
  * main exchanges only (sources.MARKET_EXCHANGES); no BDRs/CDRs/LSE international lines/SPACs;
  * a company lives once, in its home market (max liquidity listing); A/H pairs both stay (different money);
    a secondary listing elsewhere stays only if it is big on its own (>= $20M/day and >= 25 % of the primary);
  * companies whose home is the US are dropped (they are in fullmarket);
  * liquidity gate: 3-month average daily value traded (USD) x venue factor (primary exchanges outside Asia see
    only part of the consolidated volume) >= GATE_USD (default $5M);
  * names: native Chinese for A/HK/TW (simplified), Japanese kanji names when readable, a curated table of common
    Chinese names for well-known companies elsewhere, else a short English name.

Outputs
  globalmkt/universe.json            the tree (+ markets, fx, rule, core list) — DESIGN §1 node shape, ids "gl-…"
  globalmkt/universe/report.json     counts, drops, gate, leaf sizes, validation
  globalmkt/universe/REPORT.md       human summary (regenerated)

CLI
  python3 globalmkt/build_universe.py                  # build from cache (fetches missing sources)
  python3 globalmkt/build_universe.py --fetch          # refresh all sources first (~5 min of polite Yahoo calls)
  python3 globalmkt/build_universe.py --validate 20    # + yfinance check of 20 sampled symbols per market
  python3 globalmkt/build_universe.py --gate 5e6
"""
import argparse, json, math, random, re, sys, time, unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UNI = HERE / "universe"
sys.path.insert(0, str(UNI))
import sources as src          # noqa: E402
import taxonomy as tx          # noqa: E402
import names as nm             # noqa: E402

GATE_USD = 4e6           # ≈ $5M: at 5e6 the universe is 8.7k (< 9k target); see REPORT.md
# share of consolidated volume seen on the primary exchange is lower outside Asia (MTFs, dark pools, ATS)
VENUE_FACTOR = {"gb": 1.8, "ch": 1.6, "de": 1.8, "fr": 1.8, "nl": 1.8, "it": 1.6, "es": 1.6, "se": 1.6,
                "dk": 1.6, "fi": 1.6, "no": 1.5, "be": 1.6, "at": 1.4, "pt": 1.4, "ie": 1.6, "pl": 1.1,
                "ca": 1.5, "au": 1.2, "jp": 1.1, "in": 1.05, "kr": 1.1, "br": 1.0, "cn": 1.0, "hk": 1.0, "tw": 1.0}
MIN_HISTORY_DAYS = 30          # listings younger than this are skipped (no weather yet)
TURNOVER_FLOOR = 5e-5          # daily value / market cap below this outside Asia = a foreign line of a big name
# exchanges that quote many US companies (XETRA/Vienna foreign segments, TSX/ASX inter-listings, LSE, SIX):
# a listing there whose name is a US-domiciled fullmarket company and that trades < US_LINE_SHARE of the US
# listing's dollar volume is a secondary line of a US company -> dropped (it lives in fullmarket)
US_CHECK_MARKETS = {"de", "at", "ca", "au", "gb", "ch", "br", "nl", "fr"}
US_LINE_SHARE = 0.25
ASIA_HOME = {"cn", "hk", "tw", "jp", "kr", "in"}
CLOSED_HOME = {"cn", "tw", "jp", "kr", "in"}
SECONDARY_MIN_USD = 20e6
SECONDARY_SHARE = 0.25
SAME_MARKET_CLASS_SHARE = 0.5
CORE_N = 1500
MARKET_TZ = {"cn": ("Asia/Shanghai", "15:00"), "hk": ("Asia/Hong_Kong", "16:10"), "tw": ("Asia/Taipei", "13:30"),
             "jp": ("Asia/Tokyo", "15:30"), "kr": ("Asia/Seoul", "15:30"), "in": ("Asia/Kolkata", "15:30"),
             "au": ("Australia/Sydney", "16:10"), "gb": ("Europe/London", "16:35"), "ch": ("Europe/Zurich", "17:30"),
             "de": ("Europe/Berlin", "17:35"), "fr": ("Europe/Paris", "17:35"), "nl": ("Europe/Amsterdam", "17:35"),
             "it": ("Europe/Rome", "17:35"), "es": ("Europe/Madrid", "17:35"), "se": ("Europe/Stockholm", "17:30"),
             "dk": ("Europe/Copenhagen", "17:00"), "fi": ("Europe/Helsinki", "18:30"), "no": ("Europe/Oslo", "16:25"),
             "be": ("Europe/Brussels", "17:35"), "at": ("Europe/Vienna", "17:35"), "pt": ("Europe/Lisbon", "16:35"),
             "ie": ("Europe/Dublin", "16:30"), "pl": ("Europe/Warsaw", "17:05"), "ca": ("America/Toronto", "16:00"),
             "br": ("America/Sao_Paulo", "17:00")}

LEGAL = set("""inc incorporated corp corporation co company companies ltd limited plc ag se sa s a spa s p a nv n v
ab publ asa as a s oyj oy bhd tbk nl llc lp l p kgaa gmbh sab de cv the
ordinary shares share common stock class cl registered reg adr ads gdr drn cdr cad hedged sdb cdi fpo
units unit trust""".split())


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def name_key(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.split(r"\b(?:common stock|ordinary shares|american depositary|class [abc]\b|series [abc]\b|cdr\b)", s)[0]
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = s.replace("&", " and ")
    toks = [t for t in re.sub(r"[^a-z0-9 ]+", " ", s).split() if t not in LEGAL]
    return " ".join(toks)


# ---------------------------------------------------------------------------------------------- load
def load_yahoo():
    out = {}
    for f in sorted((src.RAW / "yahoo").glob("*.json")):
        d = json.loads(f.read_text())
        for q in d["quotes"]:
            q = dict(q)
            q["industry"], q["ysector"] = d["industry"], d["sector"]
            out[q["symbol"]] = q
    return out


def us_name_keys():
    """full normalised names of US-domiciled companies on the US maps (fullmarket) -> (ticker, US $/day)."""
    keys = {}
    p = ROOT / "fullmarket" / "universe_raw.json"
    if not p.exists():
        return keys
    for s in json.loads(p.read_text())["stocks"]:
        if s.get("country") != "United States":
            continue
        k = name_key(s.get("name"))
        if k and len(k) >= 3:
            keys[k] = (s["t"], float(s.get("dv") or 0))
    return keys


def a_share_ok(sym):
    code, suf = sym.split(".")
    if suf == "SS":
        return code[:2] in ("60", "68")
    return code[:2] in ("00", "30")


# ---------------------------------------------------------------------------------------------- select
def select(gate=GATE_USD):
    fxr = src.fx()
    usd = fxr["usdPer"]
    cap_rate = dict(usd, GBp=usd["GBP"], ZAc=usd.get("ZAR", 0), ILA=usd.get("ILS", 0))
    yq = load_yahoo()
    us_keys = us_name_keys()
    now_ms = time.time() * 1000
    drops = Counter()
    drop_examples = defaultdict(list)

    def drop(why, s):
        drops[why] += 1
        if len(drop_examples[why]) < 12:
            drop_examples[why].append(s)

    rows = []
    for sym, q in yq.items():
        mk = src.EXCHANGE_MARKET.get(q.get("exchange"))
        ccy = q.get("currency")
        if not mk:
            drop("exchange", sym); continue
        if ccy not in usd:
            drop("currency", sym); continue
        if q["industry"] == "Shell Companies":
            drop("shell/SPAC", sym); continue
        ln = q.get("longName") or q.get("shortName") or ""
        sn = q.get("shortName") or ""
        if mk == "gb" and re.match(r"^0[A-Z0-9]{3}\.L$", sym):
            drop("LSE international line (0xxx.L)", sym); continue
        if mk == "br" and re.match(r"^[A-Z0-9]{4}3[1-9]\.SA$", sym):
            drop("Brazil BDR", sym); continue
        if re.search(r"\b(CDR|DRN|BDR)\b", sn) or "CDI 1:1" in sn:
            drop("depositary receipt line", sym); continue
        if mk == "cn" and not a_share_ok(sym):
            drop("not an A-share code", sym); continue
        price = q.get("regularMarketPrice") or 0
        adv = q.get("averageDailyVolume3Month") or q.get("averageDailyVolume10Day") or 0
        dv = adv * price * usd[ccy]
        if dv <= 0:
            drop("no volume/price", sym); continue
        first = q.get("firstTradeDateMilliseconds")
        if first and (now_ms - first) / 86400000 < MIN_HISTORY_DAYS:
            drop(f"listed < {MIN_HISTORY_DAYS} days", sym); continue
        cap = (q.get("marketCap") or 0) * cap_rate[ccy]
        rows.append({"t": sym, "mk": mk, "ccy": ccy, "ex": q["exchange"], "en": ln.strip(), "short": sn.strip(),
                     "ysector": q["ysector"], "industry": q["industry"], "price": price, "dv": dv,
                     "dvc": dv * VENUE_FACTOR.get(mk, 1.0), "cap": cap, "key": name_key(ln) or name_key(sn),
                     "first": first})

    # US-domiciled companies live in fullmarket
    keep = []
    for r in rows:
        us = us_keys.get(r["key"])
        if us and r["mk"] in US_CHECK_MARKETS and r["dv"] < US_LINE_SHARE * us[1]:
            drop("US company line (in fullmarket)", f'{r["t"]}={us[0]}'); continue
        if r["mk"] not in ASIA_HOME and r["cap"] > 0 and r["dv"] / r["cap"] < TURNOVER_FLOOR:
            drop("foreign line (turnover << normal)", r["t"]); continue
        keep.append(r)
    rows = keep

    # one company -> one home listing (+ A/H pairs, + big secondary listings). Same normalised name is not enough
    # (Orion Oyj vs Orion Corp, 首创证券 vs 群益证券 "Capital Securities"): listings merge only when Yahoo reports
    # a similar company market cap for both (a cross-listing quotes the whole company's cap).
    def same_company(a, b):
        if a["mk"] == b["mk"]:
            return True                            # same name on one exchange = share classes / trading lines
        if a["mk"] in CLOSED_HOME and b["mk"] in CLOSED_HOME:
            return False                           # A/TW/KR/JP/IN listings never cross-list into each other
        if a["cap"] > 0 and b["cap"] > 0:
            lim = 3.0 if {a["mk"], b["mk"]} == {"cn", "hk"} else 1.6   # A/H caps may be per share class
            return max(a["cap"], b["cap"]) / min(a["cap"], b["cap"]) <= lim
        return False

    groups = defaultdict(list)
    for r in rows:
        groups[r["key"] or r["t"]].append(r)
    keep = []
    pairs = {}
    for k, g in groups.items():
        g.sort(key=lambda r: -r["dv"])
        clusters = []                              # [primary, kept markets]
        for r in g:
            home = None
            if len(k) >= 4:
                home = next((c for c in clusters if same_company(c[0], r)), None)
            if home is None:
                clusters.append([r, {r["mk"]}])
                keep.append(r)
                continue
            prim, kept_mk = home
            if {r["mk"], prim["mk"]} == {"cn", "hk"} and r["mk"] not in kept_mk:
                keep.append(r); kept_mk.add(r["mk"])
                pairs[r["t"]], pairs[prim["t"]] = prim["t"], r["t"]
                continue
            if r["mk"] in kept_mk:
                if (r["mk"] == prim["mk"] and r["dv"] >= SECONDARY_MIN_USD
                        and r["dv"] >= SAME_MARKET_CLASS_SHARE * prim["dv"]):
                    keep.append(r); r["classOf"] = prim["t"]; continue
                drop("second share class / line", f'{r["t"]}<{prim["t"]}'); continue
            if r["dv"] >= SECONDARY_MIN_USD and r["dv"] >= SECONDARY_SHARE * prim["dv"]:
                keep.append(r); kept_mk.add(r["mk"]); r["alsoOf"] = prim["t"]; continue
            drop("secondary listing (home market kept)", f'{r["t"]}<{prim["t"]}')
    rows = keep
    for r in rows:
        if r["t"] in pairs:
            r["pair"] = pairs[r["t"]]

    # liquidity gate
    keep = []
    for r in rows:
        if r["dvc"] < gate:
            drop("below liquidity gate", r["t"]); continue
        keep.append(r)
    keep.sort(key=lambda r: -r["dv"])
    for i, r in enumerate(keep):
        r["rank"] = i + 1
    return keep, fxr, drops, drop_examples


# ---------------------------------------------------------------------------------------------- tree
def money_yi(usd):
    yi = usd / 1e8
    if yi >= 10000:
        return f"{yi / 10000:.1f}万亿"
    if yi >= 100:
        return f"{yi:,.0f}亿"
    return f"{yi:.0f}亿" if yi >= 10 else f"{yi:.1f}亿"


def stock_entry(r, ind_zh):
    cz = tx.MARKETS[r["mk"]][0]
    head = f"{cz}{ind_zh}"
    note = f"{head}｜市值{money_yi(r['cap'])}" if r["cap"] > 0 else head
    if len(note) > 14:
        note = f"{head}｜{money_yi(r['cap'])}" if r["cap"] > 0 else head
    if len(note) > 14:
        note = head[:14]
    tags = list(dict.fromkeys(tx.MARKETS[r["mk"]][5] + tx.IND[r["industry"]][4]))
    e = {"t": r["t"], "name": r["name"], "note": note}
    if tags:
        e["tags"] = tags
    e.update({"cap": round(r["cap"] / 1e9, 2), "dv": round(r["dv"] / 1e6, 1), "ccy": r["ccy"], "mkt": r["mk"],
              "country": cz, "ex": r["ex"], "en": r["enShort"], "yind": r["industry"], "rank": r["rank"]})
    if r.get("native") and r["native"] != r["name"]:
        e["native"] = r["native"]
    if r.get("nameSrc"):
        e["nameSrc"] = r["nameSrc"]
    for k in ("pair", "classOf", "alsoOf"):
        if r.get(k):
            e[k] = r[k]
    if r.get("sw") and r["sw"][0] != "zz":
        e["sw"] = [r["sw"][3], r["sw"][4], r["sw"][5]]
        if r.get("swEst"):
            e["swEst"] = True
    return e


TIER_SETS = {2: ["大型", "中小型"], 3: ["龙头", "中型", "小型"], 4: ["龙头", "大型", "中型", "小型"],
             5: ["龙头", "大型", "中型", "中小型", "小型"], 6: ["龙头", "大型", "中大型", "中型", "中小型", "小型"],
             7: ["龙头", "大型", "中大型", "中型", "中小型", "小型", "微型"]}


def tiers(base_id, label, emoji, members, ind_zh):
    """equal-count market-cap slices of one big industry (like fullmarket's cap tiers)."""
    n = len(members)
    k = min(max(2, math.ceil(n / tx.SPLIT_TARGET)), 15)
    words = TIER_SETS.get(k) or [f"第{i + 1}档" for i in range(k)]
    members = sorted(members, key=lambda r: -r["cap"])
    out, start = [], 0
    base = label if len(label) <= 4 else label[:4]
    for i in range(k):
        end = round((i + 1) * n / k)
        grp = members[start:end]
        start = end
        hi, lo = grp[0]["cap"], grp[-1]["cap"]
        zh = f"{words[i]}{base}" if k in TIER_SETS else f"{base}{words[i]}"
        desc = f"{label}里市值约 {money_yi(lo)}–{money_yi(hi)} 美元的那一档。" if hi > 0 else f"{label}里的另一档。"
        out.append({"id": f"{base_id}-t{i + 1}", "name": zh, "emoji": emoji, "desc": desc, "tier": True,
                    "stocks": [stock_entry(r, ind_zh) for r in grp]})
    return out


def cap_of(rs):
    return sum(r["cap"] for r in rs)


def build_sector(mk, sec, members, cid):
    zh, emo, desc, tags = tx.SECTORS[sec]
    sid = f"{cid}-{sec}"
    node = {"id": sid, "name": zh, "emoji": emo, "desc": f"{tx.MARKETS[mk][0] if mk in tx.MARKETS else ''}的{zh}：{desc}"}
    if tags:
        node["tags"] = tags
    members = sorted(members, key=lambda r: -r["cap"])
    if len(members) <= tx.FLAT_SECTOR:
        node["stocks"] = [stock_entry(r, tx.IND[r["industry"]][1]) for r in members]
        return node
    by = defaultdict(list)
    for r in members:
        by[tx.IND[r["industry"]][0]].append(r)
    meta = {v[0]: v for v in tx.IND.values()}
    small = [sl for sl, rs in by.items() if len(rs) < tx.MIN_LEAF]
    other = []
    for sl in small:
        other += by.pop(sl)
    if other and len(other) < tx.MIN_LEAF and by:
        # fold the leftovers into the largest industry rather than a tiny "其他"
        big = max(by, key=lambda s: len(by[s]))
        by[big] += other
        other = []
    inds = []
    for sl, rs in by.items():
        slug, izh, iemo, idesc, itags = meta[sl]
        inds.append((sl, izh, iemo, idesc, itags, rs))
    if other:
        inds.append((f"other", f"其他{zh}", "🧺", f"{zh}里零散的小行业。", [], other))
    inds.sort(key=lambda x: -cap_of(x[5]))

    def ind_node(sl, izh, iemo, idesc, itags, rs):
        iid = f"{sid}-{sl}"
        n = {"id": iid, "name": izh, "emoji": iemo, "desc": idesc}
        if itags:
            n["tags"] = list(itags)
        rs = sorted(rs, key=lambda r: -r["cap"])
        if len(rs) > tx.SPLIT_MAX:
            n["children"] = tiers(iid, izh, iemo, rs, izh)
        else:
            n["stocks"] = [stock_entry(r, izh) for r in rs]
        return n

    nodes = [ind_node(*x) for x in inds]
    if len(nodes) > tx.GROUP_OVER and sec in tx.GROUPS:
        by_slug = {n["id"].removeprefix(sid + "-"): n for n in nodes}
        grouped = []
        for gid, gzh, gemo, gdesc, slugs in tx.GROUPS[sec]:
            kids = [by_slug.pop(s) for s in slugs if s in by_slug]
            if len(kids) == 1:
                grouped.append(kids[0])
            elif kids:
                grouped.append({"id": f"{sid}-g-{gid}", "name": gzh, "emoji": gemo, "desc": gdesc, "children": kids})
        grouped += list(by_slug.values())      # "other" bucket
        nodes = grouped
    nodes.sort(key=lambda n: -sum(s["cap"] for s in iter_stocks(n)))
    assert len(nodes) <= 15, (sid, len(nodes))
    node["children"] = nodes
    return node


def assign_sw(rows):
    """申万 codes for A-shares; listings missing from the 申万 file get the 三级 most common among A-shares with the
    same Yahoo industry (marked swEst)."""
    swr = src.sw()["rows"]
    vote = defaultdict(Counter)
    for r in rows:
        if r["mk"] == "cn":
            x = swr.get(r["t"][:6])
            if x:
                vote[r["industry"]][x["code"]] += 1
    names = {x["code"]: x for x in swr.values()}
    est = 0
    for r in rows:
        if r["mk"] != "cn":
            continue
        x = swr.get(r["t"][:6])
        if not x and vote.get(r["industry"]):
            x = names[vote[r["industry"]].most_common(1)[0][0]]
            r["swEst"] = True
            est += 1
        if x:
            c = x["code"]
            r["sw"] = (c[:2], c[:4], c, x["l1"], tx.sw_clean(x["l2"]), tx.sw_clean(x["l3"]))
    return est


def sw_sector(r):
    return tx.SW_L2_SECTOR.get(r["sw"][1]) or tx.SW_L1[r["sw"][0]][0]


def build_cn_sector(sec, members, cid):
    zh, emo, desc, tags = tx.SECTORS[sec]
    sid = f"{cid}-{sec}"
    node = {"id": sid, "name": zh, "emoji": emo, "desc": f"A股的{zh}：{desc}", "taxonomy": "申万2021"}
    if tags:
        node["tags"] = tags
    by2 = defaultdict(list)
    for r in members:
        by2[r["sw"][1]].append(r)

    def leaf_or_split(nid, name, emoji, ndesc, rs, level):
        n = {"id": nid, "name": name, "emoji": emoji, "desc": ndesc}
        rs = sorted(rs, key=lambda r: -r["cap"])
        if len(rs) <= tx.SPLIT_MAX:
            n["stocks"] = [stock_entry(r, name) for r in rs]
            return n
        if level == 2:
            by3 = defaultdict(list)
            for r in rs:
                by3[r["sw"][2]].append(r)
            small = [c for c, v in by3.items() if len(v) < tx.MIN_LEAF]
            other = [r for c in small for r in by3.pop(c)]
            if len(by3) >= 2 or (by3 and other):
                kids = []
                for c, v in by3.items():
                    n3 = v[0]["sw"][5]
                    if n3 == name:
                        n3 = f"{name}本业"
                    kids.append(leaf_or_split(f"{sid}-sw{c}", n3, emoji, f"{name}里做{n3}的那一批。", v, 3))
                if other and len(other) >= tx.MIN_LEAF:
                    kids.append({"id": f"{nid}-other", "name": f"其他{name[:4]}", "emoji": "🧺",
                                 "desc": f"{name}里零散的细分方向。",
                                 "stocks": [stock_entry(r, r["sw"][5]) for r in sorted(other, key=lambda r: -r["cap"])]})
                elif other:                        # 1–3 strays: into the biggest sibling, their own 三级 kept in the note
                    big = max((k for k in kids if "stocks" in k), key=lambda k: len(k["stocks"]), default=None)
                    if big is None:
                        kids.append({"id": f"{nid}-other", "name": f"其他{name[:4]}", "emoji": "🧺",
                                     "desc": f"{name}里零散的细分方向。", "stocks": []})
                        big = kids[-1]
                    big["stocks"] = sorted(big["stocks"] + [stock_entry(r, r["sw"][5]) for r in other],
                                           key=lambda s: -s["cap"])
                kids.sort(key=lambda k: -sum(s["cap"] for s in iter_stocks(k)))
                if len(kids) > 15:
                    keep, rest = kids[:14], kids[14:]
                    pool = [s for k in rest for s in iter_stocks(k)]
                    keep.append({"id": f"{nid}-rest", "name": f"其他{name[:4]}", "emoji": "🧺",
                                 "desc": f"{name}里较小的细分方向。", "stocks": sorted(pool, key=lambda s: -s["cap"])})
                    kids = keep
                n["children"] = kids
                return n
        n["children"] = tiers(nid, name, emoji, rs, name)
        return n

    l2nodes = []
    small = []
    for c2, rs in by2.items():
        if len(rs) < tx.MIN_LEAF:
            small += rs
            continue
        l1 = rs[0]["sw"][0]
        name = rs[0]["sw"][4]
        emoji, d2 = tx.SW_L2.get(c2, (tx.SW_L1[l1][1], f"{rs[0]['sw'][3]}里的{name}公司。"))
        l2nodes.append((l1, leaf_or_split(f"{sid}-sw{c2}", name, emoji, d2, rs, 2)))
    if small:
        l2nodes.append(("zz", {"id": f"{sid}-other", "name": f"其他{zh}", "emoji": "🧺",
                               "desc": f"A股{zh}里公司很少的几个细分行业，拼在一起看。",
                               "stocks": [stock_entry(r, r["sw"][4]) for r in sorted(small, key=lambda r: -r["cap"])]}))
    l1s = {l1 for l1, _ in l2nodes if l1 != "zz"}
    if len(l2nodes) > tx.GROUP_OVER and len(l1s) > 1:
        groups = defaultdict(list)
        for l1, n in l2nodes:
            groups[l1].append(n)
        kids = []
        for l1, ns in groups.items():
            if len(ns) == 1 or l1 == "zz":
                kids += ns
                continue
            l1name = next(s for s in members if s["sw"][0] == l1)["sw"][3]
            kids.append({"id": f"{sid}-sw{l1}", "name": l1name, "emoji": tx.SW_L1[l1][1], "desc": tx.SW_L1[l1][2],
                         "children": sorted(ns, key=lambda k: -sum(s["cap"] for s in iter_stocks(k)))})
    else:
        kids = [n for _, n in l2nodes]
    kids.sort(key=lambda k: -sum(s["cap"] for s in iter_stocks(k)))
    assert len(kids) <= 15, (sid, len(kids))
    node["children"] = kids
    return node


def build_cn_country(cid, zh, emoji, desc, rows, tags):
    with_sw = [r for r in rows if r.get("sw")]
    no_sw = [r for r in rows if not r.get("sw")]
    by_sec = defaultdict(list)
    for r in with_sw:
        by_sec[sw_sector(r)].append(r)
    for r in no_sw:                                   # no 申万 code and no vote: Yahoo sector, own bucket
        by_sec[tx.YAHOO_SECTOR[r["ysector"]]].append(r)
        r["sw"] = ("zz", "zzzz", "zzzzzz", "未分类", "未分类", "未分类")
    node = {"id": cid, "name": zh, "emoji": emoji, "desc": desc, "markets": ["cn"], "taxonomy": "申万2021"}
    if tags:
        node["tags"] = tags
    kids = [build_cn_sector(sec, by_sec[sec], cid) for sec in tx.SECTOR_ORDER if by_sec.get(sec)]
    kids.sort(key=lambda n: -sum(s["cap"] for s in iter_stocks(n)))
    node["children"] = kids
    return node


def build_country(cid, zh, emoji, desc, mks, rows, tags):
    by_sec = defaultdict(list)
    for r in rows:
        by_sec[tx.YAHOO_SECTOR[r["ysector"]]].append(r)
    node = {"id": cid, "name": zh, "emoji": emoji, "desc": desc, "markets": mks}
    if tags:
        node["tags"] = tags
    if len(rows) <= tx.FLAT_SECTOR:
        node["stocks"] = [stock_entry(r, tx.IND[r["industry"]][1]) for r in sorted(rows, key=lambda r: -r["cap"])]
        return node
    small = [s for s, rs in by_sec.items() if len(rs) < tx.MIN_LEAF]
    kids = []
    leftovers = []
    for sec in tx.SECTOR_ORDER:
        if sec not in by_sec:
            continue
        if sec in small:
            leftovers += by_sec[sec]
            continue
        kids.append(build_sector(mks[0] if len(mks) == 1 else "", sec, by_sec[sec], cid))
    if leftovers:
        if len(leftovers) < tx.MIN_LEAF and kids:
            # attach tiny sectors' stocks as their own small leaf anyway (never lose a liquid stock)
            pass
        kids.append({"id": f"{cid}-misc", "name": "其他行业", "emoji": "🧺",
                     "desc": "这里上市公司很少的几个行业，拼在一起看。",
                     "stocks": [stock_entry(r, tx.IND[r["industry"]][1])
                                for r in sorted(leftovers, key=lambda r: -r["cap"])]})
    kids.sort(key=lambda n: -sum(s["cap"] for s in iter_stocks(n)))
    node["children"] = kids
    return node


def build_tree(rows, fxr, gate):
    by_mk = defaultdict(list)
    for r in rows:
        by_mk[r["mk"]].append(r)
    regions = []
    markets_meta = {}
    for rid, rzh, remo, rdesc, mks in tx.REGIONS:
        kids = []
        eu_small = []
        for mk in mks:
            if mk == "eu-other":
                for m in tx.EU_OTHER[4]:
                    rs = by_mk.get(m, [])
                    if rs:
                        zh, emo, desc, ccy, sufs, tags = tx.MARKETS[m]
                        tzname, close = MARKET_TZ[m]
                        markets_meta[m] = {"name": zh, "currency": ccy, "suffix": sufs, "tz": tzname, "close": close,
                                           "region": rid, "n": len(rs), "node": "gl-eu-other",
                                           "dvUsdM": round(sum(r["dv"] for r in rs) / 1e6, 1),
                                           "capUsdB": round(cap_of(rs) / 1e9, 1)}
                        eu_small += rs
                continue
            rs = by_mk.get(mk, [])
            if not rs:
                continue
            zh, emo, desc, ccy, sufs, tags = tx.MARKETS[mk]
            tzname, close = MARKET_TZ[mk]
            markets_meta[mk] = {"name": zh, "currency": ccy, "suffix": sufs, "tz": tzname, "close": close,
                                "region": rid, "n": len(rs), "dvUsdM": round(sum(r["dv"] for r in rs) / 1e6, 1),
                                "capUsdB": round(cap_of(rs) / 1e9, 1)}
            markets_meta[mk]["node"] = f"gl-{mk}"
            if mk == "cn":
                kids.append(build_cn_country(f"gl-{mk}", zh, emo, desc, rs, tags))
            else:
                kids.append(build_country(f"gl-{mk}", zh, emo, desc, [mk], rs, tags))
        if eu_small:
            _, zh, emo, desc, mlist = tx.EU_OTHER
            present = [m for m in mlist if any(r["mk"] == m for r in eu_small)]
            node = build_country("gl-eu-other", zh, emo, desc, present, eu_small, ["europe"])
            kids.append(node)
        kids.sort(key=lambda n: -sum(s["cap"] for s in iter_stocks(n)))
        assert len(kids) <= 15, (rid, len(kids))
        if kids:
            regions.append({"id": rid, "name": rzh, "emoji": remo, "desc": rdesc, "children": kids})
    n = len(rows)
    root = {
        "id": "gl-world", "name": "全球", "emoji": "🌐", "map": "global",
        "desc": f"美国以外 {len(markets_meta)} 个市场里日均成交 {gate / 1e4:,.0f} 万美元以上的 {n:,} 只股票："
                "钱跟着太阳走，亚洲→欧洲→美洲。",
        "generatedAt": now_iso(), "fx": fxr,
        "rule": {"gateUsd": gate, "venueFactor": VENUE_FACTOR, "dv": "Yahoo 3-month average daily volume x price x FX",
                 "minHistoryDays": MIN_HISTORY_DAYS, "usExcluded": "US companies live in fullmarket/curated",
                 "secondary": f">= ${SECONDARY_MIN_USD / 1e6:.0f}M/day and >= {SECONDARY_SHARE:.0%} of the home listing",
                 "aShareAndH": "both kept (pair field)"},
        "markets": markets_meta,
        "core": [r["t"] for r in rows[:CORE_N]],
        "children": regions,
    }
    return root


def iter_nodes(n):
    yield n
    for c in n.get("children", []):
        yield from iter_nodes(c)


def iter_stocks(n):
    for x in iter_nodes(n):
        yield from x.get("stocks", [])


# ---------------------------------------------------------------------------------------------- validate
def validate(rows, per_market, seed=7):
    """light yfinance check: sample per market (top 3 by liquidity + random), 1 month of daily bars."""
    import yfinance as yf
    usd = src.fx()["usdPer"]
    rnd = random.Random(seed)
    by = defaultdict(list)
    for r in rows:
        by[r["mk"]].append(r)
    res = {}
    for mk, rs in sorted(by.items()):
        rs = sorted(rs, key=lambda r: -r["dv"])
        pick = rs[:3] + rnd.sample(rs[3:], min(max(per_market - 3, 0), max(len(rs) - 3, 0)))
        syms = [r["t"] for r in pick]
        ok, bad = [], []
        try:
            df = src._retry(lambda: yf.download(syms, period="1mo", interval="1d", progress=False,
                                                auto_adjust=True, threads=False, group_by="ticker"), what=f"val {mk}")
        except Exception as e:  # noqa: BLE001
            res[mk] = {"n": len(syms), "ok": 0, "bad": syms, "error": str(e)[:200]}
            continue
        ratios = []
        by_t = {r["t"]: r for r in pick}
        for s in syms:
            try:
                sub = df[s] if len(syms) > 1 else df
                c = sub["Close"].dropna()
                v = sub["Volume"].dropna()
                good = len(c) >= 10 and float(v.sum()) > 0
                (ok if good else bad).append(s)
                if good:   # 1-month value traded vs the 3-month figure used for the gate (catches unit/FX slips)
                    dv1m = float((sub["Close"] * sub["Volume"]).dropna().mean()) * usd[by_t[s]["ccy"]]
                    ratios.append(dv1m / by_t[s]["dv"])
            except Exception:  # noqa: BLE001
                bad.append(s)
        med = round(sorted(ratios)[len(ratios) // 2], 2) if ratios else None
        res[mk] = {"n": len(syms), "ok": len(ok), "bad": bad, "rate": round(len(ok) / max(len(syms), 1), 3),
                   "dv1mOver3m": med}
        print(f"  validate {mk}: {len(ok)}/{len(syms)} ok, 1m/3m value traded x{med} {bad[:5]}", flush=True)
        time.sleep(1.0)
    return res


# ---------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="refresh all raw sources first")
    ap.add_argument("--gate", type=float, default=GATE_USD)
    ap.add_argument("--validate", type=int, default=0, help="sampled symbols per market for a yfinance check")
    ap.add_argument("--out", default=str(HERE / "universe.json"))
    a = ap.parse_args()
    if a.fetch:
        for f in (src.fx, src.taiwan, src.jpx, src.hkex, src.a_lists, src.sw):
            try:
                f(True)
            except Exception as e:  # noqa: BLE001  (a name list failing must not block the build: cache is kept)
                print(f"  ! {f.__name__} refresh failed, using cache: {type(e).__name__}: {str(e)[:160]}")
        src.yahoo_industry(True)
    t0 = time.time()
    rows, fxr, drops, drop_ex = select(a.gate)
    nm.assign_names(rows)
    sw_est = assign_sw(rows)
    root = build_tree(rows, fxr, a.gate)
    checks = check_tree(root)
    val = validate(rows, a.validate) if a.validate else None
    val_at = now_iso() if val else None
    if not val and (UNI / "report.json").exists():      # keep the last sampled check (and say when it ran)
        try:
            prev = json.loads((UNI / "report.json").read_text())
            val, val_at = prev.get("validation"), prev.get("validatedAt") or prev.get("generatedAt")
        except Exception:  # noqa: BLE001
            val = None
    if val and a.validate:
        bad = {s for v in val.values() for s in v["bad"]}
        if bad:
            print(f"  dropping {len(bad)} symbols that failed validation: {sorted(bad)[:20]}")
            rows = [r for r in rows if r["t"] not in bad]
            for i, r in enumerate(rows):
                r["rank"] = i + 1
            root = build_tree(rows, fxr, a.gate)
            checks = check_tree(root)
    Path(a.out).write_text(json.dumps(root, ensure_ascii=False, separators=(",", ":")))
    report = make_report(root, rows, drops, drop_ex, checks, val, a.gate, time.time() - t0)
    report["swEstimated"] = sw_est
    report["validatedAt"] = val_at
    (UNI / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    (UNI / "REPORT.md").write_text(report_md(report))
    print(json.dumps({k: report[k] for k in ("stocks", "byMarket", "nodes", "leafSize", "names")}, ensure_ascii=False))


TAG_VOCAB = set("""ai chip power cloud software security robot ev space defense energy oil clean finance crypto health
biotech consumer china japan europe emerging gold metals rates realestate""".split())


def check_tree(root):
    bad_tags = {t for n in iter_nodes(root) for t in n.get("tags", [])} | \
               {t for s in iter_stocks(root) for t in s.get("tags", [])}
    assert bad_tags <= TAG_VOCAB, bad_tags - TAG_VOCAB
    ids, tick = Counter(), Counter()
    over, empty, leaf_sizes = [], [], []
    for n in iter_nodes(root):
        ids[n["id"]] += 1
        assert not ("children" in n and "stocks" in n), n["id"]
        ch = n.get("children", [])
        if len(ch) > 15:
            over.append((n["id"], len(ch)))
        if "stocks" in n:
            leaf_sizes.append((len(n["stocks"]), n["id"]))
            for s in n["stocks"]:
                tick[s["t"]] += 1
        elif not ch:
            empty.append(n["id"])
    dup_ids = [i for i, c in ids.items() if c > 1]
    dup_t = [t for t, c in tick.items() if c > 1]
    assert not dup_ids, dup_ids[:10]
    assert not dup_t, dup_t[:10]
    assert not over, over[:10]
    assert not empty, empty[:10]
    return {"nodes": len(ids), "leaves": len(leaf_sizes), "leafSizes": sorted(leaf_sizes)}


def make_report(root, rows, drops, drop_ex, checks, val, gate, secs):
    by_mk = Counter(r["mk"] for r in rows)
    ls = [x[0] for x in checks["leafSizes"]]
    names = Counter(r.get("nameSrc", "?") for r in rows)
    depth = Counter()

    def walk(n, d):
        if "stocks" in n:
            depth[d + 1] += len(n["stocks"])
        for c in n.get("children", []):
            walk(c, d + 1)
    walk(root, 0)
    regions = []
    for rg in root["children"]:
        regions.append({"id": rg["id"], "name": rg["name"], "children": [
            {"id": c["id"], "name": c["name"], "stocks": sum(1 for _ in iter_stocks(c)),
             "kids": len(c.get("children", [])), "capUsdB": round(sum(s["cap"] for s in iter_stocks(c)), 1),
             "dvUsdM": round(sum(s["dv"] for s in iter_stocks(c)), 1)} for c in rg["children"]]})
    zh_cover = {}
    for mk in by_mk:
        rs = [r for r in rows if r["mk"] == mk]
        zh_cover[mk] = {"n": len(rs), "chinese": sum(1 for r in rs if nm.has_cjk(r["name"])),
                        "top50Chinese": sum(1 for r in sorted(rs, key=lambda r: -r["cap"])[:50] if nm.has_cjk(r["name"]))}
    return {
        "generatedAt": root["generatedAt"], "seconds": round(secs, 1), "gateUsd": gate, "stocks": len(rows),
        "byMarket": dict(by_mk.most_common()), "regions": regions, "nodes": checks["nodes"], "leaves": checks["leaves"],
        "leafSize": {"min": min(ls), "median": sorted(ls)[len(ls) // 2], "max": max(ls)},
        "smallestLeaves": checks["leafSizes"][:10], "largestLeaves": checks["leafSizes"][-10:],
        "stockDepth": dict(sorted(depth.items())), "names": dict(names), "chineseNames": zh_cover,
        "drops": dict(drops.most_common()), "dropExamples": {k: v for k, v in drop_ex.items()},
        "validation": val, "fx": root["fx"],
        "top20": [{"t": r["t"], "name": r["name"], "mk": r["mk"], "dvUsdM": round(r["dv"] / 1e6, 1),
                   "capUsdB": round(r["cap"] / 1e9, 1)} for r in rows[:20]],
    }


REPORT_HEAD = """# 全球覆盖 · Global universe (`globalmkt/universe.json`)

DESIGN §23 phase 4: every liquid listing outside the US (the US stays in fullmarket/curated), as one tree in the §1
node shape, so the global fetch/compute steps can treat it exactly like `fullmarket/universe_full.json`.

```
gl-world 全球
  gl-greater-china 大中华 · gl-asia-pac 亚太 · gl-europe 欧洲 · gl-americas 美洲(美国以外)      regions
    gl-cn A股 · gl-hk 港股 · gl-tw 台股 · gl-jp 日本 · gl-kr 韩国 · gl-in 印度 · gl-au 澳洲 ·        countries / markets
    gl-gb 英国 · gl-ch 瑞士 · gl-de 德国 · gl-fr … · gl-eu-other 欧洲其他 (be at pt ie pl) · gl-ca · gl-br
      gl-<mk>-<sector>      11 sectors (same keys everywhere: tech comm health fin ind disc staple energy util mat realty)
        [gl-<mk>-<sec>-g-<grp>]        middle layer when a sector has > 12 industries (fullmarket-style groups)
          gl-<mk>-<sec>-<industry>     Yahoo industries (Chinese labels); A-shares use 申万2021 instead:
                                       gl-cn-<sec>-sw<一级> → gl-cn-<sec>-sw<二级> → gl-cn-<sec>-sw<三级>
            [...-t<k>]  "tier": true   equal-count market-cap slices when a leaf would exceed 60
              stocks  {"t": yfinance symbol, …}      stock node id = "s:" + t (e.g. s:0700.HK, s:600519.SS)
```
Small sectors (< 4 listings in a country) are pooled into `gl-<mk>-misc` 其他行业; a country or sector with ≤ 24
listings skips the industry level. Every planet has ≤ 15 children; ids and tickers are unique (asserted).

## Stock fields
| field | meaning |
|---|---|
| `t` | yfinance symbol (validated by suffix + sampled download) |
| `name` / `native` / `en` | display name (Chinese where one exists) / local-language exchange name if different / short English |
| `nameSrc` | `exchange` (A: SSE/SZSE, HK: HKEX, TW: TWSE/TPEX) · `jp-kanji` (JPX name → simplified) · `curated` (`universe/zh_table.py`) · `english` |
| `note` | ≤ 14 字: market + industry + 市值 |
| `cap` | market cap, USD bn (Yahoo marketCap × FX) |
| `dv` | 3-month average daily value traded on the listing's exchange, USD m (`averageDailyVolume3Month × price × FX`) |
| `ccy` | trading currency as Yahoo quotes it — **`GBp` = pence** (London), use `fx.usdPer[ccy]` |
| `mkt`, `country`, `ex` | market key (see `markets`), its Chinese label, Yahoo exchange code |
| `yind` | Yahoo industry (all markets); `sw` = [申万一级, 二级, 三级] for A-shares (`swEst` if inferred) |
| `rank` | global rank by `dv` (1 = most traded) |
| `pair` | the other leg of an A/H pair (both kept: different money) |
| `alsoOf` / `classOf` | a big secondary listing / second share class kept next to its home listing |
| `tags` | DESIGN §1 vocabulary only (asserted) |

Root extras: `markets` {mk: name, currency, suffix, tz, local close, region, node id, n, dvUsdM, capUsdB} — use tz/close
for the "weather follows the sun" schedule; `fx` (USD per unit, incl. GBp); `rule` (the gate); `core` = the 1,500 most
traded symbols (candidate 15-minute set).

## Rules
* **Main exchanges only** (`sources.MARKET_EXCHANGES`): no BDRs (`…34.SA`), CDRs, LSE international lines (`0xxx.L`),
  CDI 1:1 lines, SPACs (Yahoo "Shell Companies"), B-shares, listings younger than 30 days.
* **US companies stay in fullmarket**: on XETRA/Vienna/TSX/ASX/LSE/SIX/B3/Euronext, a listing whose full normalised
  name is a US-domiciled fullmarket company and that trades < 25 % of the US line is dropped; outside Asia any line
  trading < 0.005 %/day of the company's market cap is a foreign line and is dropped.
* **One company, one home listing**: same normalised name **and** a similar company market cap (≤ 1.6×) = one company;
  the most traded listing is home. A/H pairs both stay; another market's line stays only if ≥ $20M/day and ≥ 25 % of
  home; a second share class only if ≥ $20M/day and ≥ 50 % of the main class. A/TW/KR/JP/IN never merge with each
  other (相同英文名 ≠ 同一家公司: 首创证券 vs 群益证券, Orion Oyj vs 好丽友).
* **Liquidity gate**: `dv × venue factor ≥ gate`. Primary exchanges outside Asia see only part of the consolidated
  volume (MTFs/dark pools/ATS), so Europe ×1.4–1.8, Canada ×1.5, Australia ×1.2, Japan/Korea ×1.1, India ×1.05.
  The gate is **$4M** ≈ the $5M of §23: at $5M the universe is ~8.7k names, below the 9–12k target. Downstream
  ranking/spotlight gates (§23: ≥ $5M rank, ≥ $20M spotlight) should use measured dv20 from prices.

## Refresh
`python3 globalmkt/build_universe.py --fetch --validate 20` (≈ 10 min: ~220 Yahoo screener calls with backoff, the
exchange name lists, 申万 file, JPX file, then ~25 small validation downloads). Without `--fetch` it rebuilds from the
cache in `universe/raw/` in about a second. Weekly is plenty (new listings/delistings); ids are stable as long as
Yahoo's industry and 申万 codes are. 东方财富 is not used (it blocks bursts); everything comes from Yahoo + exchanges.
"""


def report_md(rep):
    L = [REPORT_HEAD, f"## This build — {rep['generatedAt']}", "",
         f"Gate ${rep['gateUsd'] / 1e6:.0f}M/day. **{rep['stocks']:,} listings**, {rep['nodes']:,} nodes, "
         f"{rep['leaves']:,} leaves (leaf size min/median/max {rep['leafSize']['min']}/{rep['leafSize']['median']}/"
         f"{rep['leafSize']['max']}); stocks by depth {rep['stockDepth']}; 申万 inferred for {rep.get('swEstimated', 0)}.", "",
         "| region | country/market | stocks | children | mcap $bn | ADV $m/day |", "|---|---|---:|---:|---:|---:|"]
    for rg in rep["regions"]:
        for c in rg["children"]:
            L.append(f"| {rg['name']} | {c['name']} (`{c['id']}`) | {c['stocks']:,} | {c['kids']} | {c['capUsdB']:,.0f} | {c['dvUsdM']:,.0f} |")
    L += ["", "### Chinese names", "", "| market | stocks | with a Chinese name | top 50 by cap with a Chinese name |",
          "|---|---:|---:|---:|"]
    for mk, v in sorted(rep["chineseNames"].items(), key=lambda x: -x[1]["n"]):
        top = min(50, v["n"])
        L.append(f"| {mk} | {v['n']} | {v['chinese']} | {v['top50Chinese']}/{top} |")
    L += ["", f"Name sources: {json.dumps(rep['names'], ensure_ascii=False)}", "", "### Dropped", "",
          "| why | n | examples |", "|---|---:|---|"]
    for k, n in rep["drops"].items():
        L.append(f"| {k} | {n:,} | {', '.join(rep['dropExamples'].get(k, [])[:6])} |")
    if rep.get("validation"):
        L += ["", f"### yfinance validation (sampled, run {rep.get('validatedAt')})", "",
              "Per market: the 3 most liquid + random others, 1 month of daily bars. `1m/3m` = median of (1-month average "
              "value traded from the bars, in USD) / (the 3-month figure used for the gate) — ≈ 1 means currency and "
              "units are right.", "", "| market | sampled | ok | 1m/3m | failed |", "|---|---:|---:|---:|---|"]
        for mk, v in sorted(rep["validation"].items()):
            L.append(f"| {mk} | {v['n']} | {v['ok']} | {v.get('dv1mOver3m')} | {', '.join(v['bad'][:8])} |")
    L += ["", "### Top 20 by liquidity", ""]
    for x in rep["top20"]:
        L.append(f"- {x['name']} `{x['t']}` ({x['mk']}) — ${x['dvUsdM']:,.0f}M/day, cap ${x['capUsdB']:,.0f}bn")
    L += ["", "### Smallest / largest leaves", "", f"{rep['smallestLeaves']}", "", f"{rep['largestLeaves']}", ""]
    return "\n".join(L)


if __name__ == "__main__":
    main()
