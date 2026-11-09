"""polymarket/fetch.py: Polymarket → web/data/polymarket.json (DESIGN §10).

    python3 polymarket/fetch.py                 # full run: pull, classify, history, write
    python3 polymarket/fetch.py --reuse-min 60  # reuse cache/events_raw.json if younger than 60 min
    python3 polymarket/fetch.py --no-hist       # skip CLOB history (use gamma's own change fields)
    python3 polymarket/fetch.py --quiet
    python3 polymarket/fetch.py --no-llm        # the loop's 15/30-minute refresh: guaranteed zero Claude calls;
                                                # new markets wait for the nightly map.py (through the gateway)

Steps: gamma events (gamma.py) → keep money-relevant markets (classify.py + rules.py) → probability
1d/7d/30d ago from clob prices-history (cached per token for 3 h) → Chinese text (translate.py, cached
Claude translations; never calls Claude itself) → map nodes with signs (rules; Claude mappings from
mapping.json for low-confidence ones; owner overrides win) → shifts, clouds, ladders, brief lines.
Writes polymarket/out/polymarket.json and copies it to web/data/polymarket.json. Also writes
polymarket/out/pending.json (what map.py should translate / map next).

Output (all probabilities 0–1; d1/d7/d30 are CHANGES in probability, e.g. +0.15 = up 15 points):
{ asOf, generatedAt, counts, categories:{cat:{zh,emoji,n}},
  markets:[{id, slug(event), event, q, qZh, zhOk, group, prob, d1, d7, d30, volume, endDate, cat, tags,
            milestone, conf, mapBy, nodes:[{id, sign, w}], url, spark(16 pts / 30 d), swing}],
  shifts:[top 10 by |d7|·log10(volume), one per event: {id, q, qZh, prob, d7, volume, cat, nodes,
          fact, say, sayMild, good:[names], bad:[names]}],
  brief:[top 3 shifts as plain lines], aiWatch:[AI-milestone events with date ladders],
  events:[{id, slug, title, titleZh, cat, volume, n, kind, ladder?, p50?, fav?, markets:[ids]}],
  clouds:{nodeId:{s 0–1 (this week's swing, scaled per depth), tilt −1…1 (net: + = the moves favour
          this territory's money), n, events, top:[market ids], label}} }
"""
from __future__ import annotations

import argparse
import math
import shutil
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import common as C  # type: ignore
    import gamma  # type: ignore
    import classify as CL  # type: ignore
    import rules as RU  # type: ignore
    import translate as TR  # type: ignore
else:
    from . import common as C
    from . import gamma
    from . import classify as CL
    from . import rules as RU
    from . import translate as TR

WEB_FILE = C.ROOT / "web" / "data" / "polymarket.json"
PENDING = C.OUT_DIR / "pending.json"
OVERRIDES = C.ROOT / "web" / "data" / "overrides.json"
HIST_TTL_S = 3 * 3600
HIST_DAYS = 32
SPARK_N = 16
SPARK_MIN_VOL = 20_000   # sparklines only for markets people actually trade
SHIFT_MIN_VOL = 20_000   # a $5k market jumping 60 points is noise, not weather


# --------------------------------------------------------------------------------------------
# probability history (clob prices-history), cached per token
# --------------------------------------------------------------------------------------------
class History:
    def __init__(self, enabled=True, log=print):
        self.enabled = enabled
        self.log = log
        self.refused = False
        self.hits = self.fetched = self.failed = 0
        C.HIST_DIR.mkdir(parents=True, exist_ok=True)

    def _fp(self, token: str) -> Path:
        return C.HIST_DIR / f"{token}.json"

    def cached(self, token: str, max_age: float | None = HIST_TTL_S):
        fp = self._fp(token)
        if not fp.exists():
            return None
        d = C.read_json(fp, None)
        if not d or "h" not in d:
            return None
        if max_age is not None and time.time() - d.get("at", 0) > max_age:
            return None
        return d["h"]

    def get(self, token: str):
        h = self.cached(token)
        if h is not None:
            self.hits += 1
            return h
        if not self.enabled or self.refused:
            return self.cached(token, max_age=3 * 86400)  # stale is better than nothing
        now = int(time.time())
        try:
            r = C.get_json(C.CLOB + "/prices-history",
                           {"market": token, "startTs": now - HIST_DAYS * 86400, "fidelity": 360},
                           retries=2, timeout=30)
        except C.Refused as e:
            self.refused = True
            self.log(f"  clob refused ({e}); using gamma change fields for the rest")
            return self.cached(token, max_age=None)
        except Exception:
            self.failed += 1
            return self.cached(token, max_age=None)
        h = [[int(x["t"]), round(float(x["p"]), 4)] for x in (r or {}).get("history") or []
             if isinstance(x, dict) and x.get("t") is not None and C.fnum(x.get("p")) is not None]
        C.write_json(self._fp(token), {"at": now, "h": h})
        self.fetched += 1
        time.sleep(0.05)
        return h

    def prune(self, keep: set[str]):
        cut = time.time() - 3 * 86400
        for fp in C.HIST_DIR.glob("*.json"):
            if fp.stem not in keep and fp.stat().st_mtime < cut:
                try:
                    fp.unlink()
                except OSError:
                    pass


def p_at(h: list, ts: float, tol: float = 12 * 3600):
    """Probability at time ts (last point at or before ts). None if the market did not exist yet."""
    if not h:
        return None
    if h[0][0] > ts + tol:
        return None
    best = None
    for t, p in h:
        if t <= ts:
            best = p
        else:
            break
    return best if best is not None else h[0][1]


def spark(h: list, now: float, prob: float) -> list:
    if not h:
        return []
    out = []
    for i in range(SPARK_N):
        ts = now - (SPARK_N - 1 - i) * (30 * 86400 / (SPARK_N - 1))
        v = p_at(h, ts, tol=0) if i < SPARK_N - 1 else prob
        if v is None and h[0][0] <= ts:
            v = h[0][1]
        out.append(None if v is None else round(v, 3))
    while out and out[0] is None:
        out.pop(0)
    return out


# --------------------------------------------------------------------------------------------
# words (§5/§12: facts exact and separate; the opinion is the sentence)
# --------------------------------------------------------------------------------------------
def pct(p) -> str:
    if p is None:
        return "?"
    if p < 0.01:
        return "<1%"
    if p > 0.99:
        return ">99%"
    return f"{round(p * 100)}%"


def pts(d) -> str:
    if d is None:
        return "新盘"
    if abs(d) < 0.005:
        return "持平"
    return f"{d * 100:+.0f} 点"


def opinion(prob, d7) -> tuple[str, str]:
    """→ (sharp, mild) one-liners about a probability move."""
    if d7 is None:
        return ("新开的盘，还没走出方向。", "新开的盘，方向未明。")
    if d7 >= 0.15:
        return (("一周翻盘，赌徒们突然信了。", "一周内转为多数派看好。") if prob >= 0.5 else
                ("还没过半，但钱在猛往这边押。", "概率快速上升，但仍未过半。"))
    if d7 >= 0.05:
        return ("在升温，有人先动了。", "概率在上升。")
    if d7 <= -0.15:
        return (("一周泄气，市场基本不信了。", "概率大幅回落，市场已不太相信。") if prob < 0.2 else
                ("市场在撤退，信的人少了一大截。", "概率明显回落。"))
    if d7 <= -0.05:
        return ("热度在退。", "概率在下降。")
    if prob > 0.9:
        return ("基本板上钉钉。", "市场认为大概率发生。")
    if prob < 0.1:
        return ("没人信。", "市场认为可能性很小。")
    return ("僵着，没人敢下重注。", "概率基本没动。")


# --------------------------------------------------------------------------------------------
def load_overrides() -> dict:
    """§14 owner overrides for Polymarket items: {target:"pm:<marketId>", field:"qZh"|"nodes"|"hide", value}."""
    raw = C.read_json(OVERRIDES, [])
    if isinstance(raw, dict):
        raw = raw.get("items") or raw.get("overrides") or []
    out: dict[str, dict] = defaultdict(dict)
    for o in raw if isinstance(raw, list) else []:
        if isinstance(o, dict) and str(o.get("target", "")).startswith("pm:"):
            out[str(o["target"])[3:]][o.get("field")] = o.get("value")
    return out


def _date10(s) -> str:
    return str(s or "")[:10]


def build(events: list[dict], *, hist: History, tree: C.Tree, log=print) -> dict:
    now_dt = C.now_utc()
    now = now_dt.timestamp()
    tr = TR.Translations()
    mapping = C.read_json(C.MAPPING, {}).get("items") or {}
    overrides = load_overrides()

    # 1. keep + classify
    kept = []   # (event, market, cls)
    for e in events:
        ctx = CL.event_context(e)
        for m in e.get("markets") or []:
            if not CL.is_open(m):
                continue
            end = C.parse_iso(m.get("endDate") or e.get("endDate"))
            if end and end < now_dt - timedelta(days=2):
                continue  # past its deadline, waiting for resolution
            cls = CL.classify(e, m, ctx, tree)
            if not cls:
                continue
            if (m.get("volumeNum") or 0) < CL.volume_floor(cls):
                continue
            ov = overrides.get(str(m["id"])) or {}
            if ov.get("hide"):
                continue
            kept.append((e, m, cls, ctx))
    log(f"kept {len(kept)} markets from {len({e['id'] for e, *_ in kept})} events")

    # 2. history (most important first)
    order = sorted(range(len(kept)), key=lambda i: -(kept[i][1].get("volumeNum") or 0))
    hmap: dict[str, list] = {}
    tokens = {}
    for i in order:
        toks = kept[i][1].get("clobTokenIds") or []
        if toks:
            tokens[kept[i][1]["id"]] = str(toks[0])
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        ids = [kept[i][1]["id"] for i in order if kept[i][1]["id"] in tokens]
        for mid, h in zip(ids, ex.map(lambda mid: hist.get(tokens[mid]), ids)):
            hmap[mid] = h or []
    log(f"history: {hist.fetched} fetched, {hist.hits} cached, {hist.failed} failed in {time.time() - t0:.0f}s")
    hist.prune(set(tokens.values()))

    # 3. market records
    markets = []
    pending_units: dict[str, float] = {}
    map_cands = []
    for e, m, cls, ctx in kept:
        mid = str(m["id"])
        prob = CL.prob_of(m)
        h = hmap.get(m["id"]) or []
        d = {}
        for key, days, api in (("d1", 1, "oneDayPriceChange"), ("d7", 7, "oneWeekPriceChange"),
                               ("d30", 30, "oneMonthPriceChange")):
            ago = p_at(h, now - days * 86400) if h else None
            if ago is not None:
                d[key] = round(prob - ago, 4)
            elif h:
                d[key] = None  # the market is younger than that
            else:
                v = C.fnum(m.get(api))
                d[key] = None if v is None else round(v, 4)
        vol = float(m.get("volumeNum") or 0)
        qzh, zh_ok = TR.compose(e, m, tr)
        ov = overrides.get(mid) or {}
        if ov.get("qZh"):
            qzh, zh_ok = str(ov["qZh"]), True
        if not zh_ok:
            for u in TR.units_for(e, m):
                if not tr.get(u):
                    pending_units[u] = max(pending_units.get(u, 0), vol)
        nodes = [{"id": nid, "sign": s, "w": round(min(1.0, w), 2)} for nid, s, w in cls["nodes"]]
        nodes = [n for n in nodes if n["id"].startswith("s:")][:3] + [n for n in nodes if not n["id"].startswith("s:")][:6]
        map_by = "rules"
        cm = mapping.get(mid)
        if cm and (cls["conf"] != "hi" or not nodes):
            cn = []
            for n in cm.get("nodes") or []:
                rid = tree.resolve(n.get("id")) if n.get("id") and not str(n["id"]).startswith("s:") else \
                    (n.get("id") if tree.has(n.get("id") or "") else None)
                if rid and rid != "world" and n.get("sign") in (1, -1):
                    cn.append({"id": rid, "sign": n["sign"], "w": 0.7})
            if cn or cm.get("none"):
                nodes, map_by = cn, "claude"
        if isinstance(ov.get("nodes"), list):
            nodes = [{"id": n["id"], "sign": 1 if n.get("sign", 1) >= 0 else -1, "w": 1.0}
                     for n in ov["nodes"] if isinstance(n, dict) and tree.has(n.get("id") or "")]
            map_by = "owner"
        if map_by == "rules" and (cls["conf"] != "hi" or not nodes) and len(e.get("markets") or []) == 1 \
                and not cm and vol >= 50_000:
            map_cands.append({"id": mid, "q": m.get("question"), "volume": round(vol), "cat": cls["cat"],
                              "rules": [n["id"] + ("+" if n["sign"] > 0 else "-") for n in nodes]})
        slug = e.get("slug") or m.get("slug") or ""
        sw = abs(d["d7"] or 0) * CL.log_volume(vol)
        rec = {
            "id": mid, "slug": slug, "event": str(e["id"]), "q": m.get("question") or e.get("title"),
            "qZh": qzh, "zhOk": zh_ok, "group": (m.get("groupItemTitle") or None) if len(e.get("markets") or []) > 1 else None,
            "prob": round(prob, 4), "d1": d["d1"], "d7": d["d7"], "d30": d["d30"],
            "volume": round(vol), "endDate": _date10(m.get("endDate") or e.get("endDate")),
            "cat": cls["cat"], "tags": cls["tags"], "milestone": cls["milestone"], "conf": cls["conf"],
            "mapBy": map_by, "nodes": nodes,
            "url": f"https://polymarket.com/event/{slug}" if slug else "",
            "spark": spark(h, now, prob) if (vol >= SPARK_MIN_VOL or cls["milestone"]) else [],
            "swing": round(sw, 4),
        }
        markets.append(rec)

    cat_rank = {c: i for i, c in enumerate(RU.CATEGORIES)}
    markets.sort(key=lambda r: (cat_rank.get(r["cat"], 99), -r["volume"]))
    by_id = {r["id"]: r for r in markets}

    # 4. events: ladders (dates), buckets (favourite), singles
    ev_out = []
    ai_watch = []
    groups: dict[str, list] = defaultdict(list)
    for r in markets:
        groups[r["event"]].append(r)
    ev_by_id = {str(e["id"]): e for e, *_ in kept}
    ctx_by_id = {str(e["id"]): ctx for e, _, _, ctx in kept}
    for eid, rs in groups.items():
        e = ev_by_id[eid]
        title = e.get("title") or rs[0]["q"]
        tz = tr.get(title) if len(rs) > 1 or rs[0]["group"] else (rs[0]["qZh"] if rs[0]["zhOk"] else None)
        cats = defaultdict(float)
        for r in rs:
            cats[r["cat"]] += 1
        rec = {"id": eid, "slug": e.get("slug"), "title": title, "titleZh": tz or title, "cat": max(cats, key=cats.get),
               "volume": round(float(e.get("volume") or 0)), "n": len(rs), "kind": "single",
               "milestone": any(r["milestone"] for r in rs), "markets": [r["id"] for r in rs]}
        if len(rs) >= 2 and all(r["group"] and TR.zh_date(r["group"]) for r in rs):
            lad = sorted(rs, key=lambda r: r["endDate"])
            rec["kind"] = "ladder"
            rec["ladder"] = [{"date": r["endDate"], "label": TR.zh_date(r["group"]), "prob": r["prob"], "d7": r["d7"],
                              "id": r["id"]} for r in lad]
            p50 = next((x for x in rec["ladder"] if x["prob"] >= 0.5), None)
            rec["p50"] = p50["date"] if p50 else None
            last = rec["ladder"][-1]
            rec["say"] = (f"市场认为最早在 {p50['label']} 过半（{pct(p50['prob'])}）" if p50 else
                          f"到 {last['label']} 也只有 {pct(last['prob'])}，市场觉得还早")
        elif ctx_by_id[eid].get("bucket"):
            rec["kind"] = "bucket"
            fav = max(rs, key=lambda r: r["prob"])
            rec["fav"] = {"id": fav["id"], "label": fav["group"], "labelZh": TR.zh_label(fav["group"] or "") or fav["group"],
                          "prob": fav["prob"]}
            rec["say"] = f"最可能：{rec['fav']['labelZh']}（{pct(fav['prob'])}）"
        elif len(rs) > 1:
            rec["kind"] = "multi"
            fav = max(rs, key=lambda r: r["prob"])
            rec["fav"] = {"id": fav["id"], "label": fav["group"], "labelZh": TR.zh_label(fav["group"] or "") or fav["group"],
                          "prob": fav["prob"]}
            rec["say"] = f"领先：{rec['fav']['labelZh']}（{pct(fav['prob'])}）"
        else:
            r = rs[0]
            rec["say"] = f"{pct(r['prob'])}（一周 {pts(r['d7'])}）"
        ev_out.append(rec)
        if rec["milestone"]:
            ai_watch.append(rec)
    ev_out.sort(key=lambda x: (cat_rank.get(x["cat"], 99), -x["volume"]))
    ai_watch.sort(key=lambda x: -x["volume"])

    # 5. shifts: one per event, by |d7|·log10(volume); skip near-certain and expiring-today markets
    soon = (now_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    best_per_event: dict[str, dict] = {}
    for r in markets:
        if r["d7"] is None or abs(r["d7"]) < 0.02 or r["endDate"] and r["endDate"] < soon:
            continue
        if r["volume"] < SHIFT_MIN_VOL or not (r["nodes"] or r["milestone"]):
            continue
        if (r["prob"] > 0.985 or r["prob"] < 0.015) and abs(r["d7"]) < 0.1:
            continue
        b = best_per_event.get(r["event"])
        if not b or r["swing"] > b["swing"]:
            best_per_event[r["event"]] = r
    shift_src = sorted(best_per_event.values(), key=lambda r: -r["swing"])[:10]
    shifts = []
    for r in shift_src:
        sharp, mild = opinion(r["prob"], r["d7"])
        up = (r["d7"] or 0) > 0
        good = [tree.name(n["id"]) for n in r["nodes"] if (n["sign"] > 0) == up][:4]
        bad = [tree.name(n["id"]) for n in r["nodes"] if (n["sign"] > 0) != up][:4]
        shifts.append({"id": r["id"], "event": r["event"], "q": r["q"], "qZh": r["qZh"], "prob": r["prob"], "d7": r["d7"],
                       "d1": r["d1"], "volume": r["volume"], "cat": r["cat"], "endDate": r["endDate"],
                       "nodes": [{"id": n["id"], "sign": n["sign"]} for n in r["nodes"]], "url": r["url"],
                       "fact": f"{r['qZh']}：{pct(r['prob'])}（一周 {pts(r['d7'])}）",
                       "say": sharp, "sayMild": mild, "good": good, "bad": bad})
    brief = []
    for s in shifts[:3]:
        tail = ""
        if s["good"]:
            tail += "利好" + "、".join(s["good"][:2])
        if s["bad"]:
            tail += ("；" if tail else "") + "利空" + "、".join(s["bad"][:2])
        brief.append({"id": s["id"], "text": s["fact"], "say": s["say"], "sayMild": s["sayMild"], "effect": tail,
                      "nodes": s["nodes"]})

    # 6. clouds per tree node (own markets + everything mapped below it). One event counts once (its
    # biggest mover), so a 30-rung price ladder does not drown a single big question. Markets ending
    # within 3 days (daily strike ladders) are left out. Strength is scaled per depth, so every zoom
    # level has a few bright clouds and many faint ones.
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
    raw = {nid: sum(v[0] for v in a["ev"].values()) for nid, a in acc.items()}
    by_depth: dict[int, list[float]] = defaultdict(list)
    for nid, v in raw.items():
        by_depth[tree.nodes.get(nid, {}).get("depth", 9)].append(v)
    k_depth = {}
    for dpt, vals in by_depth.items():
        vals = sorted(vals)
        k_depth[dpt] = max(0.02, vals[int(0.75 * (len(vals) - 1))]) if vals else 0.1
    clouds = {}
    for nid, a in acc.items():
        evs = sorted(a["ev"].values(), key=lambda v: -v[0])
        top = [v[2] for v in evs[:3]]
        tot = raw[nid]
        s = 1 - math.exp(-tot / k_depth[tree.nodes.get(nid, {}).get("depth", 9)])
        t = sum(v[1] for v in evs) / tot if tot > 1e-6 else 0.0
        lead = by_id[top[0]]
        clouds[nid] = {"s": round(s, 3), "tilt": round(max(-1.0, min(1.0, t)), 2), "n": a["n"], "events": len(evs),
                       "top": top, "label": f"预言市场：{lead['qZh']} {pct(lead['prob'])}（一周 {pts(lead['d7'])}）"}

    counts = defaultdict(int)
    for r in markets:
        counts[r["cat"]] += 1
    categories = {k: dict(v, n=counts.get(k, 0)) for k, v in RU.CATEGORIES.items()}
    tr.save()
    out = {
        "asOf": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "gamma-api.polymarket.com + clob.polymarket.com (public, read-only)",
        "note": "d1/d7/d30 = change in probability (0.15 = +15 points). nodes.sign: +1 = YES is good for that territory's money.",
        "caveat": "预言市场盘子小、会错；主人自己的记录显示它们常把 AI 里程碑的日子押得太早。",
        "counts": {"markets": len(markets), "events": len(ev_out), "mapped": sum(1 for r in markets if r["nodes"]),
                   "translated": sum(1 for r in markets if r["zhOk"])},
        "categories": categories,
        "markets": markets,
        "shifts": shifts,
        "brief": brief,
        "aiWatch": ai_watch[:20],
        "events": ev_out,
        "clouds": clouds,
    }
    pending = {"at": out["generatedAt"],
               "units": [u for u, _ in sorted(pending_units.items(), key=lambda kv: -kv[1])],
               "map": sorted(map_cands, key=lambda x: -x["volume"])[:60]}
    C.write_json(PENDING, pending, indent=1)
    return out


def write(out: dict, web=True, log=print):
    C.write_json(C.OUT_FILE, out)
    log(f"wrote {C.OUT_FILE.relative_to(C.ROOT)} ({C.OUT_FILE.stat().st_size / 1024:.0f} KB)")
    if web and WEB_FILE.parent.exists():
        tmp = WEB_FILE.with_suffix(".json.tmp")
        shutil.copyfile(C.OUT_FILE, tmp)
        tmp.replace(WEB_FILE)
        log(f"copied to {WEB_FILE.relative_to(C.ROOT)}")


def summary(out: dict, tree: C.Tree, n_samples=10, log=print):
    cats = out["categories"]
    log("\ncounts by category:")
    for k, v in cats.items():
        if v["n"]:
            log(f"  {v['emoji']} {v['zh']:<6} {k:<9} {v['n']:>4}")
    c = out["counts"]
    log(f"  total {c['markets']} markets / {c['events']} events; mapped {c['mapped']}; Chinese {c['translated']}")
    log("\ntop shifts (|d7|·log volume):")
    for s in out["shifts"]:
        log(f"  {pts(s['d7']):>7}  {pct(s['prob']):>5}  ${s['volume']:>12,}  {s['qZh'][:60]}")
        log(f"           {s['say']}  好:{'、'.join(s['good']) or '-'}  坏:{'、'.join(s['bad']) or '-'}")
    log(f"\n{n_samples} sample mappings:")
    ms = [m for m in out["markets"] if m["nodes"]]
    seen_cat, picks = set(), []
    for m in sorted(ms, key=lambda m: -m["volume"]):
        if m["cat"] not in seen_cat:
            seen_cat.add(m["cat"])
            picks.append(m)
    for m in sorted(ms, key=lambda m: -m["volume"]):
        if len(picks) >= n_samples:
            break
        if m not in picks and m["milestone"]:
            picks.append(m)
    for m in picks[:n_samples]:
        nn = ", ".join(f"{tree.name(n['id'])}{'+' if n['sign'] > 0 else '−'}" for n in m["nodes"][:6])
        log(f"  [{m['cat']}] {m['q'][:70]}  ({pct(m['prob'])})\n      {m['qZh'][:50]}  →  {nn}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reuse-min", type=float, default=0, help="reuse cached gamma events younger than N minutes")
    ap.add_argument("--no-hist", action="store_true", help="skip clob prices-history")
    ap.add_argument("--no-web", action="store_true", help="do not copy into web/data/")
    ap.add_argument("--min-volume", type=float, default=5_000, help="event volume floor for the gamma pull")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-llm", action="store_true",
                    help="never call Claude in this run (common/claude_gate refuses); translations/mappings of new "
                         "markets are left in out/pending.json for the nightly polymarket/map.py")
    a = ap.parse_args(argv)
    if a.no_llm:
        import os
        os.environ["MW_CLAUDE_DISABLED"] = "1"
    log = (lambda *x, **k: None) if a.quiet else print
    t0 = time.time()
    tree = C.Tree.load()
    if not tree.nodes:
        print("no tree (web/data/tree.json) — cannot map markets", file=sys.stderr)
        return 1
    try:
        events = gamma.pull_events(min_volume=max(5_000, a.min_volume), log=log, use_cache_min=a.reuse_min)
    except C.Refused as e:
        print(f"polymarket refused: {e}; keeping the previous file", file=sys.stderr)
        events = (C.read_json(gamma.RAW_FILE, {}) or {}).get("events") or []
        if not events:
            return 2
    except Exception as e:
        print(f"gamma pull failed: {e!r}", file=sys.stderr)
        events = (C.read_json(gamma.RAW_FILE, {}) or {}).get("events") or []
        if not events:
            return 2
        log(f"using cached events ({len(events)})")
    out = build(events, hist=History(enabled=not a.no_hist, log=log), tree=tree, log=log)
    if not out["markets"]:
        print("no markets kept — not overwriting the previous file", file=sys.stderr)
        return 3
    write(out, web=not a.no_web, log=log)
    if not a.quiet:
        summary(out, tree)
    log(f"\ndone in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
