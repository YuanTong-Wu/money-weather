#!/usr/bin/env python3
"""predict/kalshi.py — Kalshi → web/data/kalshi.json, in the same shape as polymarket.json (DESIGN §10, §24).

    python3 predict/kalshi.py                 # quick: refresh prices of the kept markets (full discovery if the
                                              #   event list is older than 12 h); history cached 3 h; no Claude
    python3 predict/kalshi.py --full          # full discovery of all open events (~2–3 min, ~75 requests)
    python3 predict/kalshi.py --reuse-min 60  # no network at all if the cached event list is younger than 60 min
    python3 predict/kalshi.py --translate     # + nightly: Chinese for new markets and Claude mappings for
                                              #   low-confidence ones, ONE batched call via common/claude_gate
    python3 predict/kalshi.py --nightly       # = --full --translate
    python3 predict/kalshi.py --no-hist       # skip candlesticks (d7/d30 unknown; d1 from Kalshi's own field)

Which markets: Kalshi categories that can move money (kapi.KEEP_CATS), then exactly the same relevance and
node-mapping rules as Polymarket (polymarket/rules.py + classify.py): sports/celebrity/weather/mentions are
dropped, the rule table maps each market to tree territories with a sign (+1 = YES is good for that
territory's money), Claude mappings (predict/kalshi_mapping.json) only for low-confidence ones, owner overrides
(web/data/overrides.json, target "ks:<ticker>", fields qZh | nodes | hide) win over everything. Daily/hourly
price-range markets that close within 3 days are dropped (noise), except Fed/CPI/jobs-type releases.

Probabilities 0–1: midpoint of the book when it is tight (≤ 10 cents), else the last trade. d1/d7/d30 =
changes in probability from Kalshi's daily candles. volume = contracts traded (each pays $1; ≈ dollars of face
value — the Polymarket volume floors apply as they are).

Output (= polymarket.json, plus `source:"kalshi"`, `oi` and `series` per market):
{ asOf, generatedAt, source, note, caveat, counts, categories, markets:[{id, slug, event, series, q, qZh, zhOk,
  group, prob, d1, d7, d30, volume, oi, endDate, cat, tags, milestone, conf, mapBy, nodes:[{id, sign, w}], url,
  spark, swing}], shifts:[…], brief:[…], aiWatch:[…], events:[…], clouds:{nodeId:{s, tilt, n, events, top, label}} }
"""
from __future__ import annotations

import argparse
import math
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from polymarket import classify as CL  # noqa: E402
from polymarket import common as PC  # noqa: E402
from polymarket import fetch as PF  # noqa: E402  (pure helpers: p_at, spark, opinion, pct, pts)
from polymarket import rules as RU  # noqa: E402
from predict import kapi, kzh  # noqa: E402

WEB_FILE = ROOT / "web" / "data" / "kalshi.json"
OVERRIDES = ROOT / "web" / "data" / "overrides.json"
PENDING = HERE / "out" / "kalshi_pending.json"
DISCOVERY_MAX_AGE_S = 12 * 3600
SPARK_MIN_VOL = 20_000
SHIFT_MIN_VOL = 50_000   # contracts; a thin Kalshi market jumping 70 points is noise
SHORT_OK_CATS = {"rates", "macro"}     # releases that matter even when they close within days

# Kalshi phrasings the Polymarket table does not know (added to the same rule list, in this process only)
_EXTRA_DONE = []


def extend_rules():
    if _EXTRA_DONE:
        return
    RU.THEMES.setdefault("power_demand_up", [("ai-power-plants", 1), ("ai-power-utility", 1), ("ai-power-equip", 1),
                                             ("ai-power-nuclear", 1), ("energy-gas", 1)])
    RU.THEMES.setdefault("card_cap", [("finance-banks-credit", -1), ("finance-pay", -1), ("finance-banks-big", -1)])
    RU.rule("k_ercot", "energy", r"\bercot\b|peak electricity demand|peak (power|load)|integrated system load",
            [("power_demand_up", 1)], dir="level", tags=["power", "datacenter", "energy"])
    RU.rule("k_diesel", "energy", r"diesel price|price of diesel", [("oil_up", 1)], dir="level",
            tags=["oil", "diesel", "inflation"])
    RU.rule("k_crude_prod", "energy", r"crude oil production|oil production in", [("oil_up", -1)], dir="level",
            tags=["oil", "supply"], conf="lo")
    RU.rule("k_boeing", "tech", r"boeing.{0,60}deliver", [], dir="level", co=1, tags=["boeing", "aerospace"])
    RU.rule("k_stake", "tech", r"take a stake|stake of .{0,40}(in|of) ", [], co=1, tags=["policy", "stake"], conf="lo")
    RU.rule("k_pandemic", "macro", r"\bpandemic\b|public health emergency of international concern",
            [("recession", 1)], tags=["health", "pandemic"], conf="lo")
    RU.rule("k_cc_cap", "macro", r"credit card (interest )?rates?.{0,20}capped|cap on credit card",
            [("card_cap", 1)], tags=["banks", "credit", "policy"])
    _EXTRA_DONE.append(True)


# never money weather, whatever the rules say
K_EXCLUDE = re.compile(
    r"which bank will lead|lead (underwriter|bank)|\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|"
    r"delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|"
    r"massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|"
    r"new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|"
    r"south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|"
    r"wyoming|nyc|los angeles|chicago|houston)( state)? (gas|diesel) price|trimmed mean", re.I)
_ZERO_BPS = re.compile(r"\b(hike|cut|raise|lower)s? (interest )?rates? by 0 ?bps", re.I)


def clean_q(q: str) -> str:
    """Make Kalshi wording readable for the shared rules ("Hike rates by 0bps" is a hold, not a hike)."""
    q = _ZERO_BPS.sub("keep rates unchanged (no change)", q)
    q = re.sub(r"\bSP ?500\b", "S&P 500", q)
    return q.replace("**", "")


CAT_TAGS = {"Economics": {"economy"}, "Financials": {"finance"}, "Politics": {"politics"},
            "Elections": {"politics", "elections"}, "Science and Technology": {"science"}, "Crypto": {"crypto"},
            "Companies": {"business"}, "Commodities": {"commodities"}, "Health": {"health"}, "AI": {"ai"},
            "World": {"geopolitics"}, "Business": {"business"}, "Transportation": {"transportation"}}


def _iso(s) -> datetime | None:
    return PC.parse_iso(s)


def adapt(e: dict) -> tuple[dict, list[dict]]:
    """Kalshi event → the gamma-like event/market dicts polymarket/classify.py understands."""
    ms = e.get("markets") or []
    titles = [m.get("title") or "" for m in ms]
    generic = len(ms) > 1 and len(set(titles)) == 1
    multi = len(ms) > 1
    out = []
    for m in ms:
        p = kapi.prob_now(m)
        if p is None:
            continue
        label = (m.get("yes_sub_title") or m.get("subtitle") or "").strip()
        if _ZERO_BPS.search(m.get("title") or "") and re.search(r"0 ?bps|maintain", label, re.I):
            label = "No change"
        q = clean_q(m.get("title") or e.get("title") or "")
        if generic and label:
            q = f"{q.rstrip('?')}: {label}?"
        out.append({"id": m["ticker"], "question": q, "groupItemTitle": label if multi else "",
                    "outcomePrices": [round(p, 4), round(1 - p, 4)], "active": True, "closed": False,
                    "acceptingOrders": True, "volumeNum": kapi.fnum(m.get("volume_fp")) or 0.0,
                    "endDate": m.get("close_time"), "_k": m})
    ev = {"id": e["event_ticker"], "slug": (e.get("series_ticker") or "").lower(),
          "title": clean_q((e.get("title") or "").replace("\u200b", "")),
          "tags": sorted(CAT_TAGS.get(e.get("category"), set())), "negRisk": bool(e.get("mutually_exclusive")),
          "markets": out, "series": e.get("series_ticker"), "category": e.get("category"),
          "volume": sum(x["volumeNum"] for x in out)}
    return ev, out


def load_overrides() -> dict:
    raw = PC.read_json(OVERRIDES, [])
    if isinstance(raw, dict):
        raw = raw.get("items") or raw.get("overrides") or []
    out: dict[str, dict] = defaultdict(dict)
    for o in raw if isinstance(raw, list) else []:
        if isinstance(o, dict) and str(o.get("target", "")).startswith("ks:"):
            out[str(o["target"])[3:]][o.get("field")] = o.get("value")
    return out


def build(cache: dict, *, hist: kapi.History, tree: PC.Tree, log=print) -> tuple[dict, dict]:
    extend_rules()
    now_dt = PC.now_utc()
    now = now_dt.timestamp()
    tr = kzh.Translations()
    cmap = kzh.mapping()
    overrides = load_overrides()
    short_edge = now_dt + timedelta(days=3)

    kept = []   # (event, market, cls, ctx)
    dropped = defaultdict(int)
    for raw in cache.get("events") or []:
        e, ms = adapt(raw)
        if not ms:
            continue
        if K_EXCLUDE.search(e["title"]):
            dropped["excluded"] += len(ms)
            continue
        ctx = CL.event_context(e)
        for m in ms:
            if K_EXCLUDE.search(m["question"]):
                dropped["excluded"] += 1
                continue
            end = _iso(m.get("endDate"))
            if end and end < now_dt - timedelta(days=1):
                dropped["past"] += 1
                continue
            cls = CL.classify(e, m, ctx, tree)
            if not cls:
                dropped["irrelevant"] += 1
                continue
            if end and end < short_edge and cls["cat"] not in SHORT_OK_CATS:
                dropped["short"] += 1
                continue
            if m["volumeNum"] < CL.volume_floor(cls):
                dropped["thin"] += 1
                continue
            ov = overrides.get(m["id"]) or {}
            if ov.get("hide"):
                continue
            kept.append((e, m, cls, ctx))
    log(f"kalshi: kept {len(kept)} markets from {len({e['id'] for e, *_ in kept})} events "
        f"(dropped {dict(dropped)})")

    tickers = [m["id"] for _, m, _, _ in sorted(kept, key=lambda t: -t[1]["volumeNum"])]
    t0 = time.time()
    hist.load(tickers)
    log(f"kalshi history: {hist.fetched} fetched, {hist.hits} cached, {hist.failed} failed in {time.time() - t0:.0f}s")

    markets, pending_units, map_cands = [], {}, []
    for e, m, cls, ctx in kept:
        mid = m["id"]
        km = m["_k"]
        prob = m["outcomePrices"][0]
        h = hist.get(mid)
        d = {}
        for key, days in (("d1", 1), ("d7", 7), ("d30", 30)):
            ago = PF.p_at(h, now - days * 86400) if h else None
            if ago is not None:
                d[key] = round(prob - ago, 4)
            elif key == "d1":
                prev = kapi.fnum(km.get("previous_price_dollars"))
                d[key] = round(prob - prev, 4) if prev and (kapi.fnum(km.get("volume_fp")) or 0) > 0 else None
            else:
                d[key] = None
        multi = len(e["markets"]) > 1
        label = m["groupItemTitle"] or (km.get("yes_sub_title") or "")
        qzh, zh_ok, miss = kzh.compose(e["title"], m["question"], label if multi else None, multi, tr)
        ov = overrides.get(mid) or {}
        if ov.get("qZh"):
            qzh, zh_ok, miss = str(ov["qZh"]), True, []
        for u in miss:
            pending_units[u] = max(pending_units.get(u, 0), m["volumeNum"])
        nodes = [{"id": nid, "sign": s, "w": round(min(1.0, w), 2)} for nid, s, w in cls["nodes"]]
        nodes = [n for n in nodes if n["id"].startswith("s:")][:3] + [n for n in nodes if not n["id"].startswith("s:")][:6]
        map_by = "rules"
        cm = cmap.get(mid)
        if cm and (cls["conf"] != "hi" or not nodes):
            cn = []
            for n in cm.get("nodes") or []:
                nid = n.get("id") or ""
                rid = tree.resolve(nid) if not nid.startswith("s:") else (nid if tree.has(nid) else None)
                if rid and rid != "world" and n.get("sign") in (1, -1):
                    cn.append({"id": rid, "sign": n["sign"], "w": 0.7})
            if cn or cm.get("none"):
                nodes, map_by = cn, "claude"
        if isinstance(ov.get("nodes"), list):
            nodes = [{"id": n["id"], "sign": 1 if n.get("sign", 1) >= 0 else -1, "w": 1.0}
                     for n in ov["nodes"] if isinstance(n, dict) and tree.has(n.get("id") or "")]
            map_by = "owner"
        if map_by == "rules" and (cls["conf"] != "hi" or not nodes) and not multi and not cm and m["volumeNum"] >= 50_000:
            map_cands.append({"id": mid, "q": m["question"], "volume": round(m["volumeNum"]), "cat": cls["cat"],
                              "rules": [n["id"] + ("+" if n["sign"] > 0 else "-") for n in nodes]})
        vol = float(m["volumeNum"])
        sw = abs(d["d7"] or 0) * CL.log_volume(vol)
        series = e.get("series") or ""
        markets.append({
            "id": mid, "slug": e["slug"], "event": e["id"], "series": series, "q": m["question"], "qZh": qzh,
            "zhOk": zh_ok, "group": (label or None) if multi else None,
            "prob": round(prob, 4), "d1": d["d1"], "d7": d["d7"], "d30": d["d30"],
            "volume": round(vol), "oi": round(kapi.fnum(km.get("open_interest_fp")) or 0),
            "endDate": str(m.get("endDate") or "")[:10], "cat": cls["cat"], "tags": cls["tags"],
            "milestone": cls["milestone"], "conf": cls["conf"], "mapBy": map_by, "nodes": nodes,
            "url": f"https://kalshi.com/markets/{series.lower()}" if series else "https://kalshi.com",
            "spark": PF.spark(h, now, prob) if (vol >= SPARK_MIN_VOL or cls["milestone"]) else [],
            "swing": round(sw, 4), "source": "kalshi",
        })
    cat_rank = {c: i for i, c in enumerate(RU.CATEGORIES)}
    markets.sort(key=lambda r: (cat_rank.get(r["cat"], 99), -r["volume"]))
    by_id = {r["id"]: r for r in markets}

    # events: ladders / buckets / multi / single (same rules as polymarket/fetch.py)
    ev_out, ai_watch = [], []
    groups: dict[str, list] = defaultdict(list)
    for r in markets:
        groups[r["event"]].append(r)
    ev_by_id = {e["id"]: e for e, *_ in kept}
    ctx_by_id = {e["id"]: ctx for e, _, _, ctx in kept}
    for eid, rs in groups.items():
        e = ev_by_id[eid]
        title = e.get("title") or rs[0]["q"]
        tz = tr.get(title)
        if not tz and len(rs) == 1 and rs[0]["zhOk"]:
            tz = rs[0]["qZh"]
        cats = defaultdict(float)
        for r in rs:
            cats[r["cat"]] += 1
        rec = {"id": eid, "slug": e.get("slug"), "series": e.get("series"), "title": title, "titleZh": tz or title,
               "cat": max(cats, key=cats.get), "volume": round(sum(r["volume"] for r in rs)), "n": len(rs),
               "kind": "single", "milestone": any(r["milestone"] for r in rs), "markets": [r["id"] for r in rs],
               "url": rs[0]["url"]}
        if len(rs) >= 2 and all(r["group"] and PTR_date(r["group"]) for r in rs):
            lad = sorted(rs, key=lambda r: r["endDate"])
            rec["kind"] = "ladder"
            rec["ladder"] = [{"date": r["endDate"], "label": PTR_date(r["group"]), "prob": r["prob"], "d7": r["d7"],
                              "id": r["id"]} for r in lad]
            p50 = next((x for x in rec["ladder"] if x["prob"] >= 0.5), None)
            rec["p50"] = p50["date"] if p50 else None
            last = rec["ladder"][-1]
            rec["say"] = (f"市场认为最早在 {p50['label']} 过半（{PF.pct(p50['prob'])}）" if p50 else
                          f"到 {last['label']} 也只有 {PF.pct(last['prob'])}，市场觉得还早")
        elif ctx_by_id[eid].get("bucket") or (len(rs) > 1 and e.get("negRisk")):
            fav = max(rs, key=lambda r: r["prob"])
            fz, _ = kzh.label_zh(fav["group"] or "", tr)
            rec["kind"] = "bucket" if ctx_by_id[eid].get("bucket") else "multi"
            rec["fav"] = {"id": fav["id"], "label": fav["group"], "labelZh": fz or fav["group"], "prob": fav["prob"]}
            rec["say"] = f"{'最可能' if rec['kind'] == 'bucket' else '领先'}：{rec['fav']['labelZh']}（{PF.pct(fav['prob'])}）"
        elif len(rs) > 1:
            rec["kind"] = "multi"
            rec["say"] = "；".join(f"{(kzh.label_zh(r['group'] or '', tr)[0] or r['group'])} {PF.pct(r['prob'])}"
                                  for r in sorted(rs, key=lambda r: -r["prob"])[:3])
        else:
            r = rs[0]
            rec["say"] = f"{PF.pct(r['prob'])}（一周 {PF.pts(r['d7'])}）"
        ev_out.append(rec)
        if rec["milestone"]:
            ai_watch.append(rec)
    ev_out.sort(key=lambda x: (cat_rank.get(x["cat"], 99), -x["volume"]))
    ai_watch.sort(key=lambda x: -x["volume"])

    # shifts: one per event by |d7|·log10(volume)
    soon = (now_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    best: dict[str, dict] = {}
    for r in markets:
        if r["d7"] is None or abs(r["d7"]) < 0.02 or (r["endDate"] and r["endDate"] < soon):
            continue
        if r["volume"] < SHIFT_MIN_VOL or not (r["nodes"] or r["milestone"]):
            continue
        if (r["prob"] > 0.985 or r["prob"] < 0.015) and abs(r["d7"]) < 0.1:
            continue
        b = best.get(r["event"])
        if not b or r["swing"] > b["swing"]:
            best[r["event"]] = r
    shifts = []
    for r in sorted(best.values(), key=lambda r: -r["swing"])[:10]:
        sharp, mild = PF.opinion(r["prob"], r["d7"])
        up = (r["d7"] or 0) > 0
        good = [tree.name(n["id"]) for n in r["nodes"] if (n["sign"] > 0) == up][:4]
        bad = [tree.name(n["id"]) for n in r["nodes"] if (n["sign"] > 0) != up][:4]
        shifts.append({"id": r["id"], "event": r["event"], "q": r["q"], "qZh": r["qZh"], "prob": r["prob"], "d7": r["d7"],
                       "d1": r["d1"], "volume": r["volume"], "cat": r["cat"], "endDate": r["endDate"],
                       "nodes": [{"id": n["id"], "sign": n["sign"]} for n in r["nodes"]], "url": r["url"],
                       "fact": f"{r['qZh']}：{PF.pct(r['prob'])}（一周 {PF.pts(r['d7'])}）",
                       "say": sharp, "sayMild": mild, "good": good, "bad": bad, "source": "kalshi"})
    brief = []
    for s in shifts[:3]:
        tail = ""
        if s["good"]:
            tail += "利好" + "、".join(s["good"][:2])
        if s["bad"]:
            tail += ("；" if tail else "") + "利空" + "、".join(s["bad"][:2])
        brief.append({"id": s["id"], "text": "Kalshi：" + s["fact"], "say": s["say"], "sayMild": s["sayMild"],
                      "effect": tail, "nodes": s["nodes"]})

    # clouds per tree node (same scaling as polymarket/fetch.py)
    edge = (now_dt + timedelta(days=3)).strftime("%Y-%m-%d")
    acc: dict[str, dict] = defaultdict(lambda: {"ev": {}, "n": 0})
    for r in markets:
        if r["endDate"] and r["endDate"] < edge:
            continue
        vw = min(1.2, max(0.3, (CL.log_volume(r["volume"]) - 3) / 3.5))
        move = r["d7"] or 0.0
        touched: dict[str, tuple[int, float]] = {}
        for n in r["nodes"]:
            for nid in [n["id"]] + tree.ancestors(n["id"]):
                w = n["w"] * (1.0 if nid == n["id"] else 0.6)
                if nid not in touched or touched[nid][1] < w:
                    touched[nid] = (n["sign"], w)
        for nid, (sg, w) in touched.items():
            a = acc[nid]
            a["n"] += 1
            mag = abs(move) * vw * w
            cur = a["ev"].get(r["event"])
            if cur is None or mag > cur[0]:
                a["ev"][r["event"]] = (mag + 1e-6 * vw, sg * move * vw * w, r["id"])
    rawv = {nid: sum(v[0] for v in a["ev"].values()) for nid, a in acc.items()}
    by_depth: dict[int, list[float]] = defaultdict(list)
    for nid, v in rawv.items():
        by_depth[tree.nodes.get(nid, {}).get("depth", 9)].append(v)
    k_depth = {dpt: (max(0.02, sorted(vals)[int(0.75 * (len(vals) - 1))]) if vals else 0.1) for dpt, vals in by_depth.items()}
    clouds = {}
    for nid, a in acc.items():
        evs = sorted(a["ev"].values(), key=lambda v: -v[0])
        top = [v[2] for v in evs[:3]]
        tot = rawv[nid]
        s = 1 - math.exp(-tot / k_depth[tree.nodes.get(nid, {}).get("depth", 9)])
        t = sum(v[1] for v in evs) / tot if tot > 1e-6 else 0.0
        lead = by_id[top[0]]
        clouds[nid] = {"s": round(s, 3), "tilt": round(max(-1.0, min(1.0, t)), 2), "n": a["n"], "events": len(evs),
                       "top": top, "label": f"Kalshi：{lead['qZh']} {PF.pct(lead['prob'])}（一周 {PF.pts(lead['d7'])}）"}

    counts = defaultdict(int)
    for r in markets:
        counts[r["cat"]] += 1
    out = {
        "asOf": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "kalshi",
        "sourceDetail": "api.elections.kalshi.com/trade-api/v2 (public, read-only): events, markets, candlesticks",
        "pricesAt": datetime.fromtimestamp(cache.get("pricesAt") or cache.get("at") or time.time()).strftime("%Y-%m-%dT%H:%M:%S"),
        "discoveredAt": cache.get("atIso"),
        "note": "d1/d7/d30 = change in probability (0.15 = +15 points). nodes.sign: +1 = YES is good for that "
                "territory's money. volume = contracts traded ($1 face each).",
        "caveat": "预言市场盘子小、会错；主人自己的记录显示它们常把 AI 里程碑的日子押得太早。Kalshi 是美国受监管的交易所，和 Polymarket 的人群不同，两边对照着看。",
        "counts": {"markets": len(markets), "events": len(ev_out), "mapped": sum(1 for r in markets if r["nodes"]),
                   "translated": sum(1 for r in markets if r["zhOk"])},
        "categories": {k: dict(v, n=counts.get(k, 0)) for k, v in RU.CATEGORIES.items()},
        "markets": markets, "shifts": shifts, "brief": brief, "aiWatch": ai_watch[:20], "events": ev_out,
        "clouds": clouds,
    }
    pending = {"at": out["generatedAt"], "units": [u for u, _ in sorted(pending_units.items(), key=lambda kv: -kv[1])],
               "map": sorted(map_cands, key=lambda x: -x["volume"])[:60]}
    return out, pending


def PTR_date(label: str) -> str | None:
    from polymarket import translate as PTR
    return PTR.zh_date(label or "")


def write(out: dict, path: Path, log=print):
    PC.write_json(path, out)
    log(f"wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} ({path.stat().st_size / 1024:.0f} KB): "
        f"{out['counts']}")


def summary(out: dict, tree: PC.Tree, log=print):
    for k, v in out["categories"].items():
        if v["n"]:
            log(f"  {v['emoji']} {v['zh']:<6} {k:<9} {v['n']:>4}")
    log("top shifts:")
    for s in out["shifts"]:
        log(f"  {PF.pts(s['d7']):>7} {PF.pct(s['prob']):>5} {s['volume']:>11,}  {s['qZh'][:56]}  | {s['say']}")
    log("sample mappings:")
    seen = set()
    for m in sorted(out["markets"], key=lambda m: -m["volume"]):
        if m["cat"] in seen or not m["nodes"]:
            continue
        seen.add(m["cat"])
        nn = ", ".join(f"{tree.name(n['id'])}{'+' if n['sign'] > 0 else '−'}" for n in m["nodes"][:6])
        log(f"  [{m['cat']}] {m['q'][:64]} ({PF.pct(m['prob'])})\n      {m['qZh'][:50]} → {nn}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--full", action="store_true", help="full discovery of open events")
    ap.add_argument("--reuse-min", type=float, default=0, help="no network if the cached list is younger than N min")
    ap.add_argument("--no-hist", action="store_true")
    ap.add_argument("--translate", action="store_true", help="nightly Chinese + mappings via common/claude_gate")
    ap.add_argument("--nightly", action="store_true", help="= --full --translate")
    ap.add_argument("--quick", action="store_true", help="= the default (price refresh of the kept markets)")
    ap.add_argument("--dry-run", action="store_true", help="with --translate: show the prompt, no call")
    ap.add_argument("--out", default=str(WEB_FILE))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    if a.nightly:
        a.full = a.translate = True
    log = (lambda *x, **k: None) if a.quiet else print
    t0 = time.time()
    tree = PC.Tree.load()
    if not tree.nodes:
        print("no tree (web/data/tree.json) — cannot map markets", file=sys.stderr)
        return 1
    cache = kapi.read_events()
    age = time.time() - (cache.get("pricesAt") or cache.get("at") or 0)
    disc_age = time.time() - (cache.get("at") or 0)
    try:
        if a.reuse_min and cache.get("events") and age < a.reuse_min * 60:
            log(f"kalshi: reusing cached prices ({age / 60:.0f} min old)")
        elif a.full or not cache.get("events") or disc_age > DISCOVERY_MAX_AGE_S:
            cache = kapi.discover(log=log)
        else:
            prev = PC.read_json(Path(a.out), {}) or {}
            tick = [m["id"] for m in prev.get("markets") or []]
            if not tick:
                cache = kapi.discover(log=log)
            else:
                cache = kapi.refresh_markets(cache, tick, log=log)
    except kapi.Refused as e:
        print(f"kalshi refused: {e}; using the cached list", file=sys.stderr)
    except Exception as e:
        print(f"kalshi pull failed: {e!r}; using the cached list", file=sys.stderr)
    if not cache.get("events"):
        print("kalshi: no events (network down and no cache) — keeping the previous file", file=sys.stderr)
        return 2
    hist = kapi.History(enabled=not a.no_hist, log=log)
    out, pending = build(cache, hist=hist, tree=tree, log=log)
    PC.write_json(PENDING, pending, indent=1)
    if not out["markets"]:
        print("kalshi: no markets kept — not overwriting the previous file", file=sys.stderr)
        return 3
    if a.translate:
        res = kzh.translate_pending(pending["units"], pending["map"], tree, log=log, dry_run=a.dry_run)
        if res.get("zh") or res.get("mapped"):
            out, pending = build(cache, hist=kapi.History(enabled=False, log=log), tree=tree, log=log)
            PC.write_json(PENDING, pending, indent=1)
    write(out, Path(a.out), log=log)
    if not a.quiet:
        summary(out, tree, log=log)
    log(f"done in {time.time() - t0:.0f}s; {len(pending['units'])} strings and {len(pending['map'])} mappings pending "
        f"for the nightly translation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
