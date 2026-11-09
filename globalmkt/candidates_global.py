#!/usr/bin/env python3
"""candidates_global.py — 全球雷达: the few things on the global map worth the owner's attention today (§6, §23).

    python3 globalmkt/candidates_global.py               # → globalmkt/candidates.json + web/data/gl/candidates.json
    python3 globalmkt/candidates_global.py --print       # also print a human-readable list
    python3 globalmkt/candidates_global.py --i -6 --print --no-write    # pretend today is 5 calendar days ago

Same shape as web/data/fm/candidates.json (pipeline/brief.py class Radar reads web/data/gl/candidates.json through
global_radar(): ≤ 1 of the 3 spotlights and 1–2 tour stops for both radars together, only when it clearly wins).
Reads globalmkt/out/series_gl.npz + web/data/gl/tree.json (compute_global.py) and web/data/brief.json (curated #3).

Scoring = DESIGN §6 surprise + §8.2 🌱 +0.5 (identical to brief.py / words.js / the 全市场雷达), evaluated on each
node's own last session (a market that has not closed yet today is judged on its previous close).
Gates (§23 noise control):
  · eligible: dv20 ≥ $5M a day (measured from prices, USD); spotlight / tour need ≥ $20M (spotlightOk / tourOk)
  · depth ≥ 2 (countries and below); cap tiers folded into their industry, one item per industry
  · never an item inside another chosen item; ≤ 2 per country; ≤ 2 per sector key across countries (no five chip
    stories from five countries); ≤ 7 stocks of 12; ≤ 4 of one story; only one of an A/H pair
  · skipped: §14 estimates, stale listings, nodes whose market has not traded for > 3 calendar days (holiday weeks)
  · rank prefers 🌱 spring and fronts (+0.3, like brief.py's Radar); $20M+ items are picked first
The voice (§12) is the 全市场雷达's (fullmarket/attention_candidates.py story/short), with country-qualified names.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import glcore as G  # noqa: E402

sys.path.append(str(ROOT / "fullmarket"))      # appended: globalmkt's own modules (stockfile.py!) must win
import attention_candidates as V  # noqa: E402  — the 全市场雷达's words (story / short / fit / season_key …)
sys.path.insert(0, str(ROOT / "pipeline"))
import crashgate as CG  # noqa: E402  — DESIGN §8 amendment: a crashing market never reads 春 / 夏


def crash_of(idx_col, i: int) -> dict | None:
    """crash gate on the global map's idx as written (2 decimals), day i (pipeline/crashgate.py)."""
    seg = idx_col[max(0, i - (CG.SIG_DAYS + 8)): i + 1]
    px = [round(float(x), 2) if np.isfinite(x) else None for x in seg]
    return CG.crash_at(px, len(px) - 1)

LABEL = "全球雷达"
MIN_DV, SPOT_DV = 5.0, 20.0
K_ITEMS, MAX_STOCKS, PER_COUNTRY, PER_SECTOR, KIND_CAP = 12, 7, 2, 2, 4
MAX_LAG = 3
OUT_FILES = [HERE / "candidates.json", G.WEB / "candidates.json"]
SECTOR_ZH = {"tech": "科技", "comm": "通信传媒", "health": "医疗", "fin": "金融", "ind": "工业", "disc": "可选消费",
             "staple": "必需消费", "energy": "能源", "util": "公用事业", "mat": "材料", "realty": "地产"}
isnum, r = V.isnum, V.r


class Glob:
    def __init__(self, i: int | None):
        z = np.load(G.NPZ, allow_pickle=False)
        self.asOf = str(z["asOf"])
        self.dates = [str(d) for d in z["dates"]]
        self.ids = [str(x) for x in z["ids"]]
        self.col = {x: k for k, x in enumerate(self.ids)}
        self.A = {k: z[k].astype(np.float64) for k in ("wind", "temp", "pres", "storm", "front", "flow", "dv", "idx")}
        self.lag = z["lag"].astype(int)
        z.close()
        L = len(self.dates)
        self.i = L - 1 if i is None else max(0, min(L - 1, i if i >= 0 else L + i))
        self.shift = L - 1 - self.i
        self.date = self.dates[self.i]
        self.nodes: dict[str, dict] = {}
        tree = json.loads((G.WEB / "tree.json").read_text(encoding="utf-8"))
        self.root_name = tree.get("name", "全球")
        self._walk(tree, [], None)

    def _walk(self, n, trail, parent):
        p = trail + [n["id"]]
        if n["id"] not in self.nodes:
            self.nodes[n["id"]] = {"raw": n, "pathIds": p, "parent": parent}
        for c in n.get("children") or []:
            self._walk(c, p, n["id"])

    def values(self, nid: str):
        """(P, v) at the node's own last session — fullmarket Full.values with a per-node day."""
        k = self.col.get(nid)
        if k is None:
            return None
        lag = int(self.lag[k]) if self.shift == 0 else 0
        i, A = self.i - lag, self.A
        if i < 6:
            return None
        j = max(0, i - 5)
        g = lambda key, t: (float(A[key][t, k]) if np.isfinite(A[key][t, k]) else None)  # noqa: E731
        w = g("wind", i)
        if w is None:
            return None
        w5, tp, tp5 = g("wind", j), g("temp", i), g("temp", j)
        st, p, f = g("storm", i), g("pres", i), int(A["front"][i, k])
        dw = w - (w if w5 is None else w5)
        cr = crash_of(A["idx"][:, k], i)
        sk = CG.gate_key(V.season_key(w, dw, p), cr, p)
        P = {"crash": cr, "wind": w, "wind5": w5, "temp": tp, "temp5": tp5, "pres": p, "stormV": st, "frontV": f, "season": sk,
             "shift": 0.45 * abs(dw), "level": 0.25 * abs(w),
             "heat": 0.15 * abs(tp - tp5) if (tp is not None and tp5 is not None) else 0.0,
             "front": 0.6 * abs(f), "storm": 0.3 if (st is not None and st >= 0.8) else 0.0,
             "crowd": 0.2 if (p is not None and (p >= 90 or p <= 10)) else 0.0,
             "spring": 0.5 if sk == "spring" else 0.0, "dw": dw}
        P["base"] = P["shift"] + P["level"] + P["heat"] + P["front"] + P["storm"] + P["crowd"]
        P["score"] = P["base"] + P["spring"]
        fl = np.nan_to_num(A["flow"][:, k])
        cs = np.concatenate([[0.0], np.cumsum(fl)])
        s5 = lambda t: cs[t + 1] - cs[max(0, t - 4)]  # noqa: E731
        f5 = float(s5(i))
        xs = [abs(s5(t)) for t in range(i - 5, max(4, i - 60) - 1, -1)]
        norm = (sum(xs) / len(xs)) if len(xs) >= 10 else None
        idx = A["idx"][:, k]
        r5 = float(idx[i] / idx[j] - 1) if j < i and np.isfinite(idx[i]) and np.isfinite(idx[j]) and idx[j] > 0 else None
        dv = A["dv"][max(0, i - 19): i + 1, k]
        dv = dv[np.isfinite(dv) & (dv > 0)]        # closed days show dv 0: average over days that traded
        v = {"wind": w, "temp": tp, "pres": p, "storm": st, "front": f, "flow5": f5, "ret5": r5,
             "dv20": float(dv.mean()) if len(dv) else 0.0,
             "ratio": (abs(f5) / norm) if norm and norm > 0 else None, "lag": lag, "day": self.dates[i]}
        return P, v


def _drop(cr: dict) -> str:
    if cr.get("by") == "r1":
        return f"一天跌了 {abs(cr['r1']) * 100:.1f}%"
    return f"5天跌了 {abs(cr['r5']) * 100:.1f}%"


def crash_story(P: dict):
    """a crashing item says the drop first (same words as words.js crashWords / brief.py crash_words)."""
    cr = P.get("crash")
    if not cr:
        return None
    d = _drop(cr)
    if cr["level"] >= 2:
        return "storm", f"崩了：{d}，人多是在逃命。", f"暴跌：{d}，远超它平时的波动。"
    return "storm", f"急跌：{d}，热闹的是夺门的人。", f"急跌：{d}，比它平时的波动大得多。"


def crash_short(P: dict):
    cr = P.get("crash")
    if not cr:
        return None
    d = _drop(cr)
    return ("崩了，" if cr["level"] >= 2 else "急跌，") + d, ("暴跌，" if cr["level"] >= 2 else "急跌，") + d


def curated_ids() -> set[str]:
    try:
        s = json.loads((G.CURATED / "search.json").read_text(encoding="utf-8"))
        return {e["id"] for e in s if str(e.get("id", "")).startswith("s:")}
    except Exception:  # noqa: BLE001
        return set()


def build(F: Glob, k_items: int = K_ITEMS) -> dict:
    curated = curated_ids()
    N = F.nodes
    name = lambda nid: N[nid]["raw"].get("name", nid) if nid in N else nid  # noqa: E731

    def industry(nid: str) -> str:
        n = N[nid]
        if n["raw"].get("kind") == "stock":
            nid = n["parent"]
            n = N[nid]
        return n["parent"] if n["raw"].get("tier") else nid

    def sector_key(pids: list[str]) -> str | None:
        if len(pids) < 4:
            return None
        c, s = pids[2], pids[3]
        return s[len(c) + 1:] if s.startswith(c + "-") else s

    pool, skipped = [], {"inCurated": 0, "estimated": 0, "stale": 0, "illiquid": 0, "noData": 0, "closed": 0}
    for nid, n in N.items():
        raw = n["raw"]
        if raw.get("depth", 0) < 2:
            continue
        is_stock = raw.get("kind") == "stock"
        if is_stock and nid in curated:
            skipped["inCurated"] += 1
            continue
        if raw.get("est") is True:
            skipped["estimated"] += 1
            continue
        if raw.get("stale"):
            skipped["stale"] += 1
            continue
        got = F.values(nid)
        if got is None:
            skipped["noData"] += 1
            continue
        P, v = got
        if v["lag"] > MAX_LAG:
            skipped["closed"] += 1
            continue
        if v["dv20"] < MIN_DV:
            skipped["illiquid"] += 1
            continue
        rank = P["score"] + (0.3 if (P["frontV"] or P["season"] == "spring") else 0.0)
        pids = n["pathIds"]
        pool.append({"id": nid, "P": P, "v": v, "rank": rank, "stock": is_stock, "ind": industry(nid),
                     "country": pids[2] if len(pids) > 2 else nid, "sector": sector_key(pids),
                     "pair": ("s:" + raw["pair"]) if is_stock and raw.get("pair") else None})
    pool.sort(key=lambda c: -c["rank"])

    chosen: list[dict] = []
    used_ind, per_country, per_sector, per_story, used_pair = set(), {}, {}, {}, set()
    for min_dv, story_cap in ((SPOT_DV, KIND_CAP), (MIN_DV, KIND_CAP), (MIN_DV, k_items)):
        for c in pool:
            if len(chosen) >= k_items:
                break
            if c["v"]["dv20"] < min_dv or any(c is o for o in chosen):
                continue
            if c["ind"] in used_ind or per_country.get(c["country"], 0) >= PER_COUNTRY:
                continue
            if c["sector"] and per_sector.get(c["sector"], 0) >= PER_SECTOR:
                continue
            if c["id"] in used_pair:
                continue
            if c["stock"] and sum(1 for o in chosen if o["stock"]) >= MAX_STOCKS:
                continue
            pi = N[c["id"]]["pathIds"]
            if any(o["id"] in pi or c["id"] in N[o["id"]]["pathIds"] for o in chosen):
                continue
            c["said"] = c.get("said") or crash_story(c["P"]) or V.story(c["P"], c["v"], c["id"])
            sk = c["said"][0]
            if per_story.get(sk, 0) >= story_cap:
                continue
            chosen.append(c)
            used_ind.add(c["ind"])
            per_country[c["country"]] = per_country.get(c["country"], 0) + 1
            if c["sector"]:
                per_sector[c["sector"]] = per_sector.get(c["sector"], 0) + 1
            per_story[sk] = per_story.get(sk, 0) + 1
            if c["pair"]:
                used_pair.add(c["pair"])

    items = []
    for c in chosen:
        n, P, v = N[c["id"]], c["P"], c["v"]
        raw = n["raw"]
        sk, sharp, mild = c["said"]
        cs, cm = crash_short(P) or V.short(sk, P, v)
        nm = raw.get("name") or c["id"]
        ind = c["ind"]
        cname = name(c["country"])
        is_country = c["id"] == c["country"]
        container = ind if (c["stock"] or raw.get("tier")) else (n["parent"] or "")
        if is_country:
            parent_name = name(n["parent"]) if n["parent"] else F.root_name
        elif container == c["country"]:
            parent_name = cname
        else:
            parent_name = f"{cname}·{name(container)}" if container else cname
        if is_country:
            who_full = who_short = f"【{nm}】"
        elif c["stock"]:
            who_full, who_short = f"{parent_name}里的【{nm}】", f"{cname}的【{nm}】"
        else:
            # a region name such as 「医疗」 exists in 25 countries: the item is called 「法国·医疗」
            short_nm = nm
            nm = nm if nm.startswith(cname) else f"{cname}·{nm}"
            who_full = f"【{nm}】" if n["parent"] == c["country"] else f"{parent_name}里的【{short_nm}】"
            who_short = f"【{nm}】"
        it = {
            "id": c["id"], "name": nm, "kind": "stock" if c["stock"] else "region",
            "story": sk, "tourKind": V.tour_kind(sk, v),
            "score": r(P["score"]), "base": r(P["base"]), "springBonus": r(P["spring"]), "rank": r(c["rank"]),
            "wind": r(v["wind"]), "dw5": r(P["dw"]), "temp": r(v["temp"]),
            "pres": round(v["pres"]) if isnum(v["pres"]) else None, "storm": r(v["storm"]), "front": v["front"],
            "flow5": r(v["flow5"], 1), "ret5": r(v["ret5"], 4), "dv20": r(v["dv20"], 1), "ratio": r(v["ratio"], 1),
            "season": {"key": P["season"], **V.SEASONS[P["season"]]} if P["season"] in V.SEASONS else None,
            "crash": (P.get("crash") or {}).get("level", 0),
            "parentId": ind, "parentName": parent_name, "industry": {"id": ind, "name": name(ind)},
            "country": {"id": c["country"], "name": cname},
            "sector": {"key": c["sector"], "name": SECTOR_ZH.get(c["sector"] or "", name(n["pathIds"][3]) if len(n["pathIds"]) > 3 else "")},
            "path": " › ".join(name(x) for x in n["pathIds"][1:-1]) or F.root_name,
            "pathIds": list(n["pathIds"]),
            "why": sharp, "whyMild": mild,
            "caption": V.fit(f"{LABEL}：{who_full}{cs}。", f"{LABEL}：{who_short}{cs}。", f"{LABEL}：【{nm}】{cs}。",
                             f"【{nm}】{cs}。"),
            "captionMild": V.fit(f"{LABEL}：{who_full}{cm}。", f"{LABEL}：{who_short}{cm}。", f"{LABEL}：【{nm}】{cm}。",
                                 f"【{nm}】{cm}。"),
            "spotlightOk": v["dv20"] >= SPOT_DV, "tourOk": v["dv20"] >= SPOT_DV,
            "map": "global", "label": LABEL, "inCurated": False, "asOfDay": v["day"],
        }
        if v["lag"]:
            it["closedDays"] = v["lag"]
        if raw.get("emoji"):
            it["emoji"] = raw["emoji"]
        if c["stock"]:
            it["ticker"] = raw.get("ticker") or c["id"][2:]
            for f in ("cap", "ccy", "mkt", "en", "pair"):
                if raw.get(f) not in (None, ""):
                    it[f] = raw[f]
        if raw.get("tier"):
            it["tier"] = True
        items.append(it)

    curated3 = None
    try:
        b = json.loads((G.CURATED / "brief.json").read_text(encoding="utf-8"))
        sp = [s for s in b.get("spotlight") or [] if not s.get("radar")]
        gap = abs((date.fromisoformat(b["asOf"]) - date.fromisoformat(F.date)).days) if b.get("asOf") else 99
        if gap <= 4 and len(sp) >= 3 and isnum(sp[2].get("score")):
            curated3 = sp[2]["score"]
    except Exception:  # noqa: BLE001
        pass
    for it in items:
        it["beatsCurated"] = None if curated3 is None else bool(it["score"] >= curated3 + 0.5)
    ok = [it for it in items if it["spotlightOk"]]
    return {
        "asOf": F.date, "generatedAt": datetime.now().isoformat(timespec="seconds"), "map": "global", "label": LABEL,
        "rules": "surprise §6 + 🌱+0.5 at each node's own last session; dv20≥$5M (spotlight/tour ≥$20M); depth≥2; tiers "
                 "folded, 1 per industry, ≤2 per country, ≤2 per sector key, no nesting, ≤7 stocks, ≤4 per story, one of "
                 "an A/H pair; curated / estimates / stale / closed>3d skipped; brief: radars together ≤1 of 3 spotlights",
        "curated3": curated3,
        "spotlight": ok[0]["id"] if ok else None,
        "tour": [it["id"] for it in ok[:2]],
        "items": items,
        "stats": {"pool": len(pool), **skipped},
    }


def write_json(path: Path, obj) -> None:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(s, encoding="utf-8")
    os.replace(tmp, path)


def write_stock_fallbacks(items: list[dict]) -> int:
    """Static web/data/gl/stocks/<T>.json for the radar's stocks (instant open) and for symbols the server's ticker
    pattern rejects (M&M.NS …); everything else is built lazily by server.py → stockfile.py."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("gl_stockfile", HERE / "stockfile.py")   # never fullmarket's
    stockfile = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stockfile)
    d = G.WEB / "stocks"
    want = {it["ticker"] for it in items if it.get("ticker")}
    want |= {t for t in stockfile.tickers() if not re.match(r"^[A-Z0-9^][A-Z0-9.\-^=_]{0,19}$", t)}
    n = 0
    for t in want:
        if stockfile.write_stock_file(t, d):
            n += 1
    if d.exists():
        for p in d.glob("*.json"):
            if p.stem not in want:
                p.unlink()
    return n


def pretty(c: dict) -> str:
    L = [f"══ {LABEL} · {c['asOf']} ══  (pool {c['stats']['pool']}, curated #3 = {c['curated3']})"]
    for j, it in enumerate(c["items"], 1):
        flag = "★" if it["id"] == c["spotlight"] else ("·" if it["spotlightOk"] else " ")
        se = it["season"]["emoji"] if it["season"] else "  "
        L.append(f" {flag}{j:>2}. {se} {it['name']:<14} {it['kind']:<6} {it['story']:<8} score {it['score']:>5} "
                 f"rank {it['rank']:>5}  dv20 {it['dv20']:>8}  ‹{it['path']}›" + (f"  (收盘 {it['asOfDay']})" if it.get('closedDays') else ""))
        L.append(f"       {it['why']}")
        L.append(f"       巡航：{it['caption']}")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="全球雷达 → globalmkt/candidates.json + web/data/gl/candidates.json")
    ap.add_argument("--i", type=int, default=None, help="date index (default: last day; negative counts back)")
    ap.add_argument("--k", type=int, default=K_ITEMS)
    ap.add_argument("--print", dest="show", action="store_true")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--no-stocks", action="store_true")
    a = ap.parse_args(argv)
    if not G.NPZ.exists() or not (G.WEB / "tree.json").exists():
        print("candidates_global: run globalmkt/compute_global.py first", file=sys.stderr)
        return 1
    F = Glob(a.i)
    c = build(F, a.k)
    bad = [it["id"] for it in c["items"] for s in (it["why"], it["whyMild"], it["caption"], it["captionMild"])
           if any(V.han_len(p) > 28 for p in re.split(r"[。！？]", s))]
    if bad:
        print(f"candidates_global: ⚠ long sentence(s): {bad}", file=sys.stderr)
    if a.show:
        print(pretty(c))
    if not a.no_write:
        for p in OUT_FILES:
            write_json(p, c)
        n = 0 if a.no_stocks or a.i is not None else write_stock_fallbacks(c["items"])
        print(f"[candidates_global] {len(c['items'])} items for {c['asOf']}, spotlight {c['spotlight']}, "
              f"{n} static stock file(s) → {', '.join(str(p.relative_to(ROOT)) for p in OUT_FILES)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
