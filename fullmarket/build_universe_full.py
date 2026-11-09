#!/usr/bin/env python3
"""Step 2 — full-market tree: fm-world -> sector (11) -> industry (-> tier / REIT type) -> stocks.

Reads  fullmarket/universe_raw.json (+ taxonomy.py, zh_names.py)
Writes fullmarket/universe_full.json   — one root node in the DESIGN.md §1 node shape (ids prefixed "fm-")
       fullmarket/taxonomy_report.json — counts, merges, splits, leaf sizes (used by REPORT.md)
"""
import json, math, re, sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import taxonomy as tx            # noqa: E402
from zh_names import ZH          # noqa: E402

MIN_LEAF = 4
DROP = {"PSUS"}                   # closed-end fund that slipped through the name filter
NON_US = lambda c: c not in ("United States", "Puerto Rico", "")  # noqa: E731
SECTOR_FALLBACK = {               # Nasdaq sector -> slug, for rows with an unknown industry
    "Finance": "consumer-fin", "Technology": "software", "Health Care": "pharma", "Industrials": "machinery",
    "Consumer Discretionary": "specialty-retail", "Consumer Staples": "foods", "Energy": "e-and-p",
    "Utilities": "electric", "Real Estate": "re-services", "Basic Materials": "metals",
    "Telecommunications": "telecom", "Miscellaneous": "machinery", "": "biz-services",
}


def slug_meta():
    """slug -> dict(sector, zh, emoji, desc, tags, synth)"""
    meta = {}
    for ind, (slug, sec, zh, emo, desc, tags) in tx.IND.items():
        if slug not in meta or (desc and not meta[slug]["desc"]):
            meta[slug] = dict(sector=sec, zh=zh, emoji=emo, desc=desc, tags=list(tags), synth=False,
                              nasdaq=[])
        meta[slug]["nasdaq"].append(ind)
    for slug, (sec, zh, emo, desc, tags, _) in tx.SYNTH.items():
        old = meta.get(slug, {})
        meta[slug] = dict(sector=sec, zh=zh, emoji=emo, desc=desc, tags=list(tags), synth=True,
                          nasdaq=old.get("nasdaq", []))
    meta["banks-intl"] = dict(sector="fin", zh="海外银行", emoji="🌏",
                              desc="加拿大、欧洲、日本、拉美等地在美国上市的大银行。", tags=[], synth=True, nasdaq=[])
    return meta


def money_yi(usd):
    yi = usd / 1e8
    if yi >= 10000:
        return f"{yi / 10000:.1f}万亿"
    if yi >= 100:
        return f"{yi:,.0f}亿"
    return f"{yi:.0f}亿" if yi >= 10 else f"{yi:.1f}亿"


def stock_entry(s, ind_zh):
    t = s["t"]
    name = ZH.get(t) or s["short"] or t
    cz = tx.COUNTRY_ZH.get(s["country"], s["country"][:4])
    head = f"{cz}{ind_zh}" if cz else ind_zh
    note = f"{head}｜市值{money_yi(s['cap'])}"
    if len(note) > 14:
        note = f"{head}｜{money_yi(s['cap'])}"
    if len(note) > 14:
        note = head[:14]
    tags = []
    c = s["country"]
    if c in tx.CHINA:
        tags.append("china")
    elif c in tx.JAPAN:
        tags.append("japan")
    elif c in tx.EUROPE:
        tags.append("europe")
    elif c in tx.EMERGING:
        tags.append("emerging")
    if t in tx.AI_TICKERS:
        tags.append("ai")
    e = {"t": t, "name": name, "note": note}
    if tags:
        e["tags"] = tags
    e["cap"] = round(s["cap"] / 1e9, 2)          # USD billions (extra field, for sizing/ranking)
    if cz:
        e["country"] = cz
    return e


def tier_split(slug, m, members):
    """equal-count market-cap tiers -> list of (id, zh, desc, members)"""
    n = len(members)
    k = math.ceil(n / tx.SPLIT_TARGET)
    labels = tx.TIER_LABELS.get(slug)
    if not labels or len(labels) < k:
        base = m["zh"][:4]
        labels = [f"{p}{base}" for p in ["巨头", "大型", "中大型", "中型", "中小型", "小型", "微型", "迷你"]]
    if k < len(labels):   # keep the top label(s) and the bottom one
        labels = labels[:k - 1] + [labels[-1]]
    if k == 2 and not tx.TIER_LABELS.get(slug):
        labels = [f"大型{m['zh'][:4]}", f"中小{m['zh'][:4]}"]
    members = sorted(members, key=lambda s: -s["cap"])
    out, start = [], 0
    for i in range(k):
        end = round((i + 1) * n / k)
        grp = members[start:end]
        start = end
        hi, lo = grp[0]["cap"], grp[-1]["cap"]
        desc = f"{m['zh']}里市值约 {money_yi(lo)}–{money_yi(hi)} 美元的那一档。"
        out.append((f"fm-{slug}-t{i + 1}", labels[i], desc, grp))
    return out


def reit_split(members, meta_reit):
    by = defaultdict(list)
    for s in members:
        slot = None
        for sl, zh, emo, desc, tags, tick, rx in tx.REIT_TYPES:
            if s["t"] in tick:
                slot = sl
                break
        if not slot:
            for sl, zh, emo, desc, tags, tick, rx in tx.REIT_TYPES:
                if rx and re.search(rx, s["name"], re.I):
                    slot = sl
                    break
        by[slot or "reit-special"].append(s)
    # fold tiny types into 特种信托
    for sl in list(by):
        if sl != "reit-special" and len(by[sl]) < MIN_LEAF:
            by["reit-special"] += by.pop(sl)
    out = []
    for sl, zh, emo, desc, tags, tick, rx in tx.REIT_TYPES:
        if by.get(sl):
            out.append((f"fm-{sl}", zh, emo, desc, tags, by[sl]))
    return out


def main():
    raw = json.loads((HERE / "universe_raw.json").read_text())
    stocks = [s for s in raw["stocks"] if not s.get("altOf") and s["t"] not in DROP]
    meta = slug_meta()
    synth_of = {}
    for slug, (*_, ticks) in tx.SYNTH.items():
        for t in ticks:
            synth_of.setdefault(t, slug)
    present = {s["t"] for s in stocks}
    synth_counts = Counter(synth_of[t] for t in present if t in synth_of)
    dissolved = sorted(sl for sl in tx.SYNTH if synth_counts.get(sl, 0) < MIN_LEAF and sl not in
                       {v[0] for v in tx.IND.values()})

    unknown = []

    def base_slug(s):
        ind = s["industry"].strip()
        if ind in tx.IND:
            return tx.IND[ind][0]
        unknown.append((s["t"], ind, s["sector"]))
        return SECTOR_FALLBACK.get(s["sector"], "biz-services")

    assign = {}
    for s in stocks:
        t = s["t"]
        sl = synth_of.get(t)
        if sl and sl not in dissolved:
            slug = sl
        elif t in tx.TICKER_TO:
            slug = tx.TICKER_TO[t]
        else:
            slug = base_slug(s)
        if slug in tx.BANK_SLUGS and NON_US(s["country"]):
            slug = "banks-intl"
        assign[t] = slug

    # explicit + automatic merges of small groups
    merges = []
    for src, dst in tx.MERGE.items():
        for t, sl in assign.items():
            if sl == src:
                assign[t] = dst
        merges.append((src, dst, "explicit"))
    while True:
        cnt = Counter(assign.values())
        small = sorted((sl for sl, n in cnt.items() if n < MIN_LEAF), key=lambda x: cnt[x])
        if not small:
            break
        sl = small[0]
        sec = meta[sl]["sector"]
        sibs = [(n, x) for x, n in cnt.items() if x != sl and meta[x]["sector"] == sec]
        dst = max(sibs)[1]
        for t in assign:
            if assign[t] == sl:
                assign[t] = dst
        merges.append((sl, dst, f"auto ({cnt[sl]} members)"))

    by_slug = defaultdict(list)
    sdict = {s["t"]: s for s in stocks}
    for t, sl in assign.items():
        by_slug[sl].append(sdict[t])

    # build tree
    splits, leaves = [], []
    sector_nodes = []
    for sec in tx.SECTOR_ORDER:
        zh, emo, desc, tags = tx.SECTORS[sec]
        inds = [(sl, mem) for sl, mem in by_slug.items() if meta[sl]["sector"] == sec]
        inds.sort(key=lambda x: -sum(s["cap"] for s in x[1]))
        children = []
        for sl, mem in inds:
            m = meta[sl]
            node = {"id": f"fm-{sl}", "name": m["zh"], "emoji": m["emoji"], "desc": m["desc"]}
            if m["tags"]:
                node["tags"] = m["tags"]
            if m["nasdaq"]:
                node["nasdaq"] = m["nasdaq"]      # extra: source Nasdaq industries
            mem = sorted(mem, key=lambda s: -s["cap"])
            if sl == "reits":
                kids = []
                for cid, czh, cemo, cdesc, ctags, cm in reit_split(mem, m):
                    sub = {"id": cid, "name": czh, "emoji": cemo, "desc": cdesc}
                    if ctags:
                        sub["tags"] = ctags
                    if len(cm) > tx.SPLIT_MAX:
                        sub["children"] = [{"id": tid, "name": tzh, "emoji": cemo, "desc": tdesc,
                                            "stocks": [stock_entry(s, czh) for s in tm]}
                                           for tid, tzh, tdesc, tm in tier_split(cid[3:], {"zh": czh}, cm)]
                    else:
                        sub["stocks"] = [stock_entry(s, czh) for s in cm]
                    kids.append(sub)
                node["children"] = kids
                splits.append((sl, len(mem), "REIT type", [k["name"] for k in kids]))
            elif len(mem) > tx.SPLIT_MAX:
                kids = [{"id": tid, "name": tzh, "emoji": m["emoji"], "desc": tdesc,
                         "stocks": [stock_entry(s, m["zh"]) for s in tm]}
                        for tid, tzh, tdesc, tm in tier_split(sl, m, mem)]
                node["children"] = kids
                splits.append((sl, len(mem), "market-cap tier", [k["name"] for k in kids]))
            else:
                node["stocks"] = [stock_entry(s, m["zh"]) for s in mem]
            children.append(node)
        sn = {"id": f"fm-{sec}", "name": zh, "emoji": emo, "desc": desc}
        if tags:
            sn["tags"] = tags
        if sec in tx.GROUPS:
            by_id = {c["id"]: c for c in children}
            grouped = []
            for gid, gzh, gemo, gdesc, slugs in tx.GROUPS[sec]:
                kids = [by_id.pop(f"fm-{x}") for x in slugs if f"fm-{x}" in by_id]
                if kids:
                    grouped.append({"id": f"fm-{gid}", "name": gzh, "emoji": gemo, "desc": gdesc,
                                    "children": kids})
            assert not by_id, f"ungrouped industries in {sec}: {list(by_id)}"
            grouped.sort(key=lambda g: -sum(s["cap"] for s in iter_stocks(g)))
            children = grouped
            splits.append((sec, len(inds), "middle group layer", [g["name"] for g in grouped]))
        sn["children"] = children
        sector_nodes.append(sn)

    root = {"id": "fm-world", "name": "全市场", "emoji": "🗺️",
            "desc": f"美国上市、市值 3 亿美元以上的 {len(stocks)} 家公司，按行业分好的整张地图。",
            "source": "Nasdaq screener (stocks) " + raw["downloadedAt"], "children": sector_nodes}

    # validation + stats
    ids, leaf_sizes, tick_seen = Counter(), [], Counter()

    def walk(n, depth, path):
        ids[n["id"]] += 1
        assert not ("children" in n and "stocks" in n), n["id"]
        if "stocks" in n:
            leaf_sizes.append((len(n["stocks"]), n["id"], " › ".join(path + [n["name"]])))
            for s in n["stocks"]:
                tick_seen[s["t"]] += 1
        for c in n.get("children", []):
            walk(c, depth + 1, path + [n["name"]])
    walk(root, 0, [])
    dup_ids = [i for i, c in ids.items() if c > 1]
    dup_t = [t for t, c in tick_seen.items() if c > 1]
    assert not dup_ids, dup_ids
    assert not dup_t, dup_t
    long_names = [(i, n) for i, n in [(x["id"], x["name"]) for x in iter_nodes(root)] if len(n) > 6]

    by_sector = []
    for sn in sector_nodes:
        n_st = sum(1 for _ in iter_stocks(sn))
        cap = sum(s["cap"] for s in iter_stocks(sn))
        by_sector.append({"id": sn["id"], "name": sn["name"], "emoji": sn["emoji"], "stocks": n_st,
                          "children": len(sn["children"]),
                          "industries": sum(1 for x in iter_nodes(sn) if x["id"].removeprefix("fm-") in meta), "capT": round(cap / 1000, 2),
                          "leaves": sum(1 for x in iter_nodes(sn) if "stocks" in x)})
    zh_hits = sum(1 for t in tick_seen if t in ZH)
    leaf_n = [x[0] for x in leaf_sizes]
    report = {
        "stocks": len(tick_seen), "sectors": len(sector_nodes),
        "industryNodes": sum(1 for sn in sector_nodes for x in iter_nodes(sn)
                             if x["id"].removeprefix("fm-") in meta),
        "leafNodes": len(leaf_sizes), "allNodes": len(ids),
        "nasdaqIndustriesUsed": len({s["industry"] for s in stocks}),
        "leafSize": {"min": min(leaf_n), "median": sorted(leaf_n)[len(leaf_n) // 2], "max": max(leaf_n)},
        "zhNames": zh_hits, "bySector": by_sector,
        "merges": [{"from": a, "to": b, "why": w} for a, b, w in merges],
        "splits": [{"id": a, "n": n, "how": h, "into": k} for a, n, h, k in splits],
        "dissolvedSynth": dissolved, "unknownIndustry": unknown, "longNames": long_names,
        "smallestLeaves": sorted(leaf_sizes)[:8], "largestLeaves": sorted(leaf_sizes)[-8:],
    }
    (HERE / "universe_full.json").write_text(json.dumps(root, ensure_ascii=False, separators=(",", ":")))
    (HERE / "taxonomy_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k not in ("merges", "splits")}, ensure_ascii=False,
                     indent=1))
    for x in report["merges"]:
        print("merge", x)
    for x in report["splits"]:
        print("split", x)


def iter_nodes(n):
    yield n
    for c in n.get("children", []):
        yield from iter_nodes(c)


def iter_stocks(n):
    for x in iter_nodes(n):
        yield from x.get("stocks", [])


if __name__ == "__main__":
    main()
