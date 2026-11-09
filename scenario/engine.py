#!/usr/bin/env python3
"""推演模式 engine (DESIGN §9 steps 1–2).

    python3 scenario/engine.py "2026 年 11 月基本实现 RSI…" --date 2026-11 --tier 强
    → web/data/scenarios/<id>.json  (+ web/data/scenarios/index.json, the list the screen reads)
    → scenario/out/<id>.raw.json    (the model's untouched answer; --reuse it to redo step 2 for free)

    from scenario import engine; engine.run(text, date=None, tier=None) → result dict

Step 1 asks the local `claude -p` for the chain of consequences (prompt.py). Step 2 is plain
arithmetic on today's map data: validate ids, propagate along return correlation, aggregate up the
tree, price-in and 时间差 gap per node, the landing list. Formulas: scenario/README.md.
"""
from __future__ import annotations

import argparse
import calendar
import difflib
import hashlib
import json
import math
import os
import re
import sys
import time
from datetime import date as _date, datetime
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import llm  # noqa: E402
import pm  # noqa: E402
import prompt as P  # noqa: E402
import valuation as V  # noqa: E402
from weather import (LAG_ZH, LAGS, ROOT, SEASONS, TIERS, World, priced_in,  # noqa: E402
                     priced_word)

VERSION = 2
# results (served to the screen) and work files (raw model answers, job status, logs) live apart
OUT_DIR = Path(os.environ.get("MW_SCENARIO_DIR") or (ROOT / "web" / "data" / "scenarios"))
WORK_DIR = Path(os.environ.get("MW_SCENARIO_WORK") or (_HERE / "out"))
INDEX_NAME = "index.json"

# --- weights (documented in README.md) --------------------------------------------------------
LAYER_CONF = {1: 1.0, 2: 0.8, 3: 0.6}        # shorter chains are more reliable
ROBUST_CONF = {True: 1.0, False: 0.85}        # bet the direction of the error, not one path
NEEDS_CONF = {"弱": 1.0, "中": 0.95, "强": 0.85}  # holds under a weaker root → worth more
BEYOND_TIER = 0.5                              # needs a stronger root than the one chosen
INHERIT_DECAY = 0.9                            # per level, parent impact → unnamed sub-regions
CORR_MIN, RESID_MIN = 0.6, 0.1                 # propagation gate (raw corr, market-residual corr)
INFER_SCALE = 0.4                              # inferred = 0.4 × source impact × corr …
INFER_CAP = 1.0                                # … and never more than a weak 1.0 ("连带" is weak by design)
INFER_MAX = 10                                 # at most this many inferred regions
AGG_MIN = 0.05                                 # aggregated parents below this are dropped
LANDING_N = 8
LANDING_MAX_INFERRED = 2                       # 推断 spots may not crowd out what the chain named
STOCKS_PER_LANDING = 5
PM_KAPPA = 0.5                                 # how much the market's own odds of the root count as priced in
PM_LAYER = {1: 1.0, 2: 0.5, 3: 0.25}           # markets reprice the first layer, rarely the third
PM_EST_WEIGHT = 0.5                            # a root-odds estimate with no market behind it counts half × conf
FACTOR_MAX = 3                                 # landing spots per factor (挂在同一件事上的算一注)


# ----------------------------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------------------------
def norm_date(s: str | None, today: _date | None = None) -> str | None:
    """'2026-11' / '2026年11月' / '2026/11/30' / '11月' → 'YYYY-MM' or 'YYYY-MM-DD'."""
    if not s:
        return None
    s = str(s).strip()
    today = today or _date.today()
    m = re.search(r"(\d{4})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), m.group(3)
        if not 1 <= mo <= 12:
            return None
        if d:
            d = min(int(d), calendar.monthrange(y, mo)[1])
            return f"{y}-{mo:02d}-{d:02d}"
        return f"{y}-{mo:02d}"
    m = re.search(r"^(\d{4})$", s)
    if m:
        return f"{m.group(1)}-12"
    m = re.search(r"(\d{1,2})\s*月", s)
    if m:
        mo = int(m.group(1))
        if 1 <= mo <= 12:
            y = today.year if mo >= today.month else today.year + 1
            return f"{y}-{mo:02d}"
    return None


def date_end(s: str | None) -> _date | None:
    """Last day of the period a normalised date names."""
    if not s:
        return None
    try:
        parts = [int(x) for x in s.split("-")]
        if len(parts) == 3:
            return _date(*parts)
        if len(parts) == 2:
            return _date(parts[0], parts[1], calendar.monthrange(parts[0], parts[1])[1])
    except Exception:
        return None
    return None


def norm_tier(t: str | None) -> str | None:
    if not t:
        return None
    t = str(t).strip()
    for k, alias in (("弱", ("弱", "weak", "low", "1")), ("中", ("中", "mid", "medium", "2")),
                     ("强", ("强", "strong", "high", "3"))):
        if t.lower() in alias or t.startswith(k):
            return k
    return None


def make_id(text: str, date: str | None, tier: str | None) -> str:
    h = hashlib.sha1(f"{text}|{date}|{tier}|{time.time()}".encode()).hexdigest()[:4]
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + h


def _write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1, allow_nan=False))
    os.replace(tmp, path)


def _clean(x):
    """No NaN/Infinity in output JSON."""
    if isinstance(x, float):
        return 0.0 if (math.isnan(x) or math.isinf(x)) else x
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_clean(v) for v in x]
    return x


def _rel(p) -> str:
    """Paths stored in results are relative to the project root (the project moves around)."""
    try:
        return str(Path(p).resolve().relative_to(ROOT))
    except Exception:
        return str(p)


def _short(s: str, n: int) -> str:
    s = str(s or "").strip()
    return s if len(s) <= n else s[:n - 1] + "…"


def _factor(v) -> str | None:
    t = re.sub(r"[\s“”\"'「」]", "", str(v or ""))
    return t[:12] or None


# ----------------------------------------------------------------------------------------------
# step 1b: repair the model's answer
# ----------------------------------------------------------------------------------------------
def repair_id(x, world: World) -> str | None:
    if not isinstance(x, str) or not x.strip():
        return None
    s = x.strip()
    if s in world.nodes and s != "world":
        return s
    t = re.sub(r"^s:", "", s, flags=re.I).upper().replace(".", "-")
    if "s:" + t in world.nodes:
        return "s:" + t
    low = s.lower()
    for nid, n in world.nodes.items():
        if nid == "world":
            continue
        if nid.lower() == low or (n.get("name") or "").strip() == s:
            return nid
    ids = [i for i in world.nodes if i != "world"]
    hit = difflib.get_close_matches(low, [i.lower() for i in ids], n=1, cutoff=0.85)
    if hit:
        return ids[[i.lower() for i in ids].index(hit[0])]
    return None


def _strip_label(v, labels) -> str:
    t = str(v or "").strip()
    for lb in labels:
        t = re.sub(rf"^{lb}\s*(?:[：:]|是)\s*", "", t)
    return t


def _as_int(v, lo, hi, default):
    try:
        v = int(round(float(str(v).replace("+", ""))))
    except Exception:
        return default
    return max(lo, min(hi, v))


def _lag(v) -> str:
    s = str(v or "").strip().lower().replace(" ", "").replace("月", "m").replace("个", "")
    if s in LAGS:
        return s
    if s in ("0", "now", "现在", "立刻", "马上", "<1m", "0-1m"):
        return "now"
    if s.startswith("1-3") or s.startswith("1~3"):
        return "1-3m"
    if s.startswith("3-12") or s.startswith("3~12") or s.startswith("6"):
        return "3-12m"
    if "y" in s or "年" in s:
        return "1y+"
    return "3-12m"


def repair(ans: dict, world: World, markets: list[dict], text: str, date: str | None, tier: str | None,
           warnings: list[str]) -> dict:
    out = {}
    out["title"] = str(ans.get("title") or text[:12]).strip()[:24]
    out["headline"] = str(ans.get("headline") or "").strip()
    out["headlineMild"] = str(ans.get("headlineMild") or "").strip() or out["headline"]
    out["take"] = str(ans.get("take") or "").strip()
    root = ans.get("root") if isinstance(ans.get("root"), dict) else {}
    r_date = date or norm_date(root.get("date")) or norm_date(text)
    r_tier = tier or norm_tier(root.get("tier")) or ("强" if norm_date(text) else "中")
    r_text = str(root.get("text") or "").strip()
    note = str(root.get("note") or "").strip()
    if not r_text or len(r_text) > 80:  # the model explained instead of quoting: keep the owner's words
        note = note or r_text
        r_text = text
    out["root"] = {"text": r_text, "date": r_date, "tier": r_tier, "note": note[:200], "original": text}
    out["upside"] = _strip_label(ans.get("upside"), ("对了有多大",))
    out["risk"] = _strip_label(ans.get("risk"), ("最要紧的一条风险", "最要紧的风险", "风险"))

    ro = ans.get("rootOdds") if isinstance(ans.get("rootOdds"), dict) else {}
    cand_ids = {m["id"] for m in markets}
    mids = [str(x) for x in ro.get("marketIds") or [] if str(x) in cand_ids]
    try:
        prob = float(ro.get("prob")) if ro.get("prob") is not None else None
    except (TypeError, ValueError):
        prob = None
    if prob is not None and prob > 1 and prob <= 100:
        prob = prob / 100.0  # "13" meant 13%
    if prob is not None and not (0 <= prob <= 1):
        prob = None
    direct = bool(ro.get("direct")) and bool(mids)
    basis = str(ro.get("basis") or "").strip()
    try:
        conf = float(ro.get("conf")) if ro.get("conf") is not None else None
    except (TypeError, ValueError):
        conf = None
    if prob is not None and not direct:
        # §14 宁可估，不可空: keep the estimate, clearly marked, with how it was made
        if not mids:
            basis = basis or "产业链逻辑推断"
            conf = min(conf if conf is not None else 0.2, 0.3)
        else:
            basis = basis or "用相近的盘子推算"
            conf = conf if conf is not None else 0.5
    elif prob is not None:
        conf = 1.0
        basis = basis or "预言市场直接押这件事"
    out["rootOdds"] = {"prob": None if prob is None else round(prob, 4), "marketIds": mids,
                       "say": str(ro.get("say") or "").strip() if prob is not None else "",
                       "direct": direct if prob is not None else False,
                       "est": (prob is not None and not direct),
                       "basis": basis if prob is not None else "",
                       "conf": None if (prob is None or conf is None) else round(max(0.0, min(1.0, conf)), 2)}

    # impacts: valid ids, clipped fields, duplicates merged (keep the stronger)
    imps = {}
    for it in ans.get("impacts") or []:
        if not isinstance(it, dict):
            continue
        nid = repair_id(it.get("id"), world)
        if not nid:
            warnings.append(f"丢掉了地图上没有的 id：{it.get('id')}")
            continue
        if nid != it.get("id"):
            warnings.append(f"把 {it.get('id')} 改成了 {nid}")
        d = it.get("dir")
        try:
            d = 1 if float(str(d).replace("+", "")) >= 0 else -1
        except Exception:
            d = -1 if str(d).strip().lower() in ("down", "neg", "坏", "流出") else 1
        robust = it.get("robust")
        robust = robust if isinstance(robust, bool) else str(robust).lower() in ("true", "1", "yes", "是")
        rec = {"id": nid, "dir": d, "strength": _as_int(it.get("strength"), 1, 3, 2), "lag": _lag(it.get("lag")),
               "order": _as_int(it.get("order"), 1, 3, 1), "needs": norm_tier(it.get("needs")) or r_tier,
               "robust": robust, "factor": _factor(it.get("factor")),
               "why": str(it.get("why") or "").strip(), "upside": str(it.get("upside") or "").strip(),
               "check": str(it.get("check") or "").strip()}
        old = imps.get(nid)
        if old is None or rec["strength"] > old["strength"]:
            imps[nid] = rec
    out["impacts"] = list(imps.values())

    chain = []
    for k, st in enumerate(ans.get("chain") or []):
        if not isinstance(st, dict):
            continue
        nodes = [n for n in (repair_id(x, world) for x in st.get("nodes") or []) if n]
        chain.append({"step": k + 1, "q": str(st.get("q") or "").strip(), "say": str(st.get("say") or "").strip(),
                      "nodes": list(dict.fromkeys(nodes))})
    out["chain"] = chain

    cand = {m["id"]: m for m in markets}
    pms = []
    for x in ans.get("polymarket") or []:
        if not isinstance(x, dict):
            continue
        mid = str(x.get("id") or "")
        if mid not in cand:
            warnings.append(f"丢掉了不在候选里的预言市场：{mid}")
            continue
        rel = x.get("relation") if x.get("relation") in ("supports", "contradicts", "timing") else "timing"
        pms.append({"id": mid, "relation": rel, "say": str(x.get("say") or "").strip()})
    out["polymarket"] = pms

    ks = []
    for x in ans.get("killSignals") or []:
        if not isinstance(x, dict) or not x.get("signal"):
            continue
        by = norm_date(x.get("by")) or str(x.get("by") or "")
        ks.append({"by": by, "signal": str(x["signal"]).strip(),
                   "ifMissing": str(x.get("ifMissing") or "到期没出现，根降一档").strip()})
    ks.sort(key=lambda k: (date_end(k["by"]) or _date(2100, 1, 1)))
    out["killSignals"] = ks
    return out


def make_validator(world: World):
    def validate(ans: dict) -> list[str]:
        probs = []
        imps = ans.get("impacts") or []
        ok = [it for it in imps if isinstance(it, dict) and repair_id(it.get("id"), world)]
        if len(ok) < 4:
            probs.append(f"impacts 里能对上地图 id 的只有 {len(ok)} 条，至少要 4 条")
        bad = [it.get("id") for it in imps if isinstance(it, dict) and not repair_id(it.get("id"), world)]
        if len(bad) > max(3, len(imps) // 3):
            probs.append("这些 id 地图上没有：" + ", ".join(map(str, bad[:10])))
        if len(ans.get("chain") or []) < 4:
            probs.append("chain 至少要四步（四个问题）")
        if len(ans.get("killSignals") or []) < 3:
            probs.append("killSignals 至少要 3 条")
        if not ans.get("headline"):
            probs.append("缺 headline")
        return probs
    return validate


# ----------------------------------------------------------------------------------------------
# step 2: deterministic post-processing
# ----------------------------------------------------------------------------------------------
def _next_lag(lag: str) -> str:
    i = LAGS.index(lag) if lag in LAGS else 1
    return LAGS[min(i + 1, len(LAGS) - 1)]


def effective(imp: dict, root_tier: str) -> tuple[float, bool]:
    beyond = TIERS.index(imp["needs"]) > TIERS.index(root_tier)
    eff = (imp["strength"] * LAYER_CONF[imp["order"]] * ROBUST_CONF[imp["robust"]] * NEEDS_CONF[imp["needs"]]
           * (BEYOND_TIER if beyond else 1.0))
    return eff, beyond


def postprocess(ans: dict, world: World, markets: list[dict]) -> dict:
    root_tier = ans["root"]["tier"]
    nodes: dict[str, dict] = {}

    # a) direct impacts
    for imp in ans["impacts"]:
        eff, beyond = effective(imp, root_tier)
        nodes[imp["id"]] = {"impact": round(imp["dir"] * eff, 2), "dir": imp["dir"], "lag": imp["lag"],
                            "order": imp["order"], "inferred": False, "source": "direct",
                            "strength": imp["strength"], "needs": imp["needs"], "robust": imp["robust"],
                            "beyondTier": beyond, "factor": imp["factor"], "why": imp["why"],
                            "upside": imp.get("upside", ""), "check": imp["check"], "est": False}

    # b) unnamed sub-regions inherit from their nearest named ancestor
    direct_regions = sorted([i for i in nodes if world.nodes[i].get("kind") != "stock"],
                            key=lambda i: len(world.path[i]))
    inherited: dict[str, dict] = {}
    for rid in direct_regions:
        base = nodes[rid]
        for d in world.descendants(rid):
            if world.nodes[d].get("kind") == "stock" or d in nodes:
                continue
            lv = len(world.path[d]) - len(world.path[rid])
            inherited[d] = {"impact": round(base["impact"] * INHERIT_DECAY ** lv, 2), "dir": base["dir"],
                            "lag": base["lag"], "order": base["order"], "inferred": False, "source": "inherited",
                            "from": rid, "why": f"跟着【{world.nodes[rid]['name']}】：{base['why']}",
                            "check": base["check"], "needs": base["needs"], "robust": base["robust"],
                            "factor": base.get("factor"), "upside": base.get("upside", ""),
                            "est": True, "basis": f"跟着上一层【{world.nodes[rid]['name']}】", "conf": 0.6}
    nodes.update(inherited)

    # c) propagate to correlated leaf regions nobody named (推断)
    ids, raw, res = world.corr()
    pos = {r: k for k, r in enumerate(ids)}
    sources = [i for i in nodes if nodes[i]["source"] == "direct" and i in pos]

    def continent(nid):
        p = world.path.get(nid, [nid])
        return p[2] if len(p) > 2 and p[1] == "us" else (p[1] if len(p) > 1 else nid)

    # signs the chain itself gave inside each continent: correlation must not overrule the reasoning
    named_sign: dict[str, set[int]] = {}
    for i in nodes:
        if nodes[i]["source"] == "direct":
            named_sign.setdefault(continent(i), set()).add(nodes[i]["dir"])
    cands = []
    for t in ids:
        if t in nodes or not world.is_leaf_region(t):
            continue
        best = None
        for s in sources:
            if world.related(s, t):
                continue
            c, r = float(raw[pos[s], pos[t]]), float(res[pos[s], pos[t]])
            if c >= CORR_MIN and r >= RESID_MIN:
                v = INFER_SCALE * nodes[s]["impact"] * c
                v = max(-INFER_CAP, min(INFER_CAP, v))
                if best is None or abs(v) > abs(best[0]):
                    best = (v, s, c, r)
        if not best or abs(best[0]) < 0.1:
            continue
        if (-1 if best[0] < 0 else 1) * -1 in named_sign.get(continent(t), set()):
            continue  # e.g. chips named as hurt, so equipment is not inferred as helped
        cands.append((t, best))
    cands.sort(key=lambda x: -abs(x[1][0]))
    for t, (v, s, c, r) in cands[:INFER_MAX]:
        src = nodes[s]
        nodes[t] = {"impact": round(v, 2), "dir": 1 if v > 0 else -1, "lag": _next_lag(src["lag"]),
                    "order": min(3, src["order"] + 1), "inferred": True, "source": "inferred", "from": s,
                    "corr": round(c, 2), "residCorr": round(r, 2),
                    "why": f"推断：它平时和【{world.nodes[s]['name']}】一起涨跌（过去一年相关 {c:.2f}），会被连带",
                    "check": (f"跟着【{world.nodes[s]['name']}】的认错线：{src['check']}" if src.get("check") else ""),
                    "needs": src["needs"], "robust": src["robust"], "factor": src.get("factor"),
                    "est": True, "basis": "按过去一年一起涨跌推断", "conf": round(min(0.6, 0.6 * c), 2)}

    # d) aggregate up the tree (DV-weighted mean of children; unimpacted children count as 0)
    def agg(nid):
        n = world.nodes[nid]
        if n.get("kind") == "stock":
            return nodes[nid]["impact"] if nid in nodes else 0.0
        kids = world.children.get(nid, [])
        vals = [(k, agg(k)) for k in kids]
        if nid in nodes:
            return nodes[nid]["impact"]
        wsum = sum(world.dv(k) for k, _ in vals) or float(len(vals)) or 1.0
        if not any(v for _, v in vals):
            return 0.0
        use_dv = sum(world.dv(k) for k, _ in vals) > 0
        v = sum((world.dv(k) if use_dv else 1.0) * x for k, x in vals) / wsum
        if abs(v) >= AGG_MIN:
            hit = [k for k, x in vals if x and k in nodes]
            lags = [nodes[k]["lag"] for k in hit]
            nodes[nid] = {"impact": round(v, 2), "dir": 1 if v > 0 else -1,
                          "lag": min(lags, key=LAGS.index) if lags else "3-12m",
                          "order": min((nodes[k]["order"] for k in hit), default=2),
                          "inferred": all(nodes[k].get("inferred") for k in hit) if hit else True,
                          "source": "aggregated", "est": False}
        return v

    agg("world")

    # e) priced-in and the 时间差 gap, per node. If prediction markets already give the root good
    #    odds, the first layer of consequences is partly priced in even where money hasn't moved yet.
    ro = ans.get("rootOdds") or {}
    p_root = ro.get("prob")
    p_weight = 1.0
    if p_root is not None and ro.get("est"):
        p_weight = (ro.get("conf") or 0.0) * (1.0 if ro.get("marketIds") else PM_EST_WEIGHT)
    for nid, n in nodes.items():
        f = world.feat(nid)
        pi, parts = priced_in(n["dir"], f)
        if f.get("est"):
            n["pricedEst"] = f.get("basis")
        if p_root is not None and p_weight > 0:
            adj = PM_KAPPA * p_root * p_weight * PM_LAYER.get(n["order"], 0.25)
            pi2 = round(1 - (1 - pi) * (1 - adj), 2)
            if pi2 != pi:
                parts["market"] = round(adj, 3)
            pi = pi2
        n["pricedIn"] = pi
        n["pricedParts"] = parts
        n["gap"] = round(abs(n["impact"]) * (1 - pi), 2)
        n["season"] = f["season"]
        n["tag"] = priced_word(pi, n["dir"])["tag"]
    return nodes


def _weather_brief(f: dict) -> dict:
    return {"season": f["season"], "seasonEmoji": f["seasonEmoji"], "seasonName": f["seasonName"],
            "wind": f["wind"], "temp": f["temp"], "pres": f["pres"], "ret60": f["ret60"]}


# --- §12 voice: one sharp sentence per landing spot, from the numbers only --------------------
def _pick(nid: str, options: list[str]) -> str:
    """Stable variety: the same spot always gets the same line, neighbours get different ones."""
    h = int(hashlib.md5(nid.encode()).hexdigest()[:6], 16)
    return options[h % len(options)]


def voice(dir_: int, pi: float, f: dict, nid: str = "") -> tuple[str, str]:
    """(sharp, mild) for 'what the market has done so far' at one spot. ≤ 30 字, follows the data."""
    se, pres, r60 = f["season"], f["pres"], f["ret60"]
    up, dn = f"{abs(r60) * 100:.0f}%", f"{abs(r60) * 100:.0f}%"
    if dir_ > 0:
        if pi < 0.4:
            if r60 <= -0.15:
                sharp = _pick(nid, [f"60 日跌了 {dn}，被当死钱扔，你的日期没人算",
                                    f"两个月砸掉 {dn}，市场在赌它凉透了",
                                    f"跌了 {dn} 还没人捡，价格还停在旧剧本里"])
            elif pres <= 5:
                sharp = f"拥挤度才 {pres}，冷到没人看，时间差全在这"
            elif se == "winter":
                sharp = _pick(nid, ["冷得像冰窖，没人按你的日期算，时间差就在这",
                                    "没人看的角落，得靠财报一季季逼市场回头",
                                    "冬天没人管，正是该提前在场的地方"])
            elif se == "spring":
                sharp = "钱才刚摸进来，还远没挤，正是该在场的时候"
            elif se == "autumn":
                sharp = "钱还在往外撤，市场压根没按你的日期算"
            elif se == "summer":
                sharp = "热是热，离你的日期还差一大截"
            else:
                sharp = _pick(nid, ["风平浪静，市场还没按你的日期算", "没人在意，价格还停在旧剧本里"])
        elif pi < 0.7:
            sharp = ("已经有人在抢，剩下那段要靠现实逼市场信" if se in ("summer", "spring")
                     else "算进去一半，剩下那段要靠现实一点点逼出来")
        else:
            sharp = (f"挤到 {pres} 了，你的日期早被抢跑" if se == "summer"
                     else "钱和价格已经跑了一大段，对了也付过钱了")
    else:
        if pi < 0.4:
            if se == "summer" and r60 >= 0.2:
                sharp = f"60 日还涨了 {up}、挤到 {pres}，刀一点没进价"
            elif se == "summer":
                sharp = _pick(nid, [f"还挤在 {pres} 往上冲，坏消息一点没进价",
                                    "人挤人还在买，没人想到它要挨刀"])
            elif se == "spring":
                sharp = "钱还在往里冲，没人想到它要挨刀"
            elif se == "winter":
                sharp = "冷是冷了，可这一刀还没算进去"
            elif se == "autumn":
                sharp = "钱刚开始撤，这一刀大半还没算"
            else:
                sharp = "风平浪静，坏消息还没进价"
        elif pi < 0.7:
            sharp = "钱已经走了一部分，还没走完"
        else:
            sharp = ("早被卖成冰窖，坏消息基本算完了" if se == "winter"
                     else "钱已经在撤，这一刀大半算进去了")
    mild = priced_word(pi, dir_)["say"]
    return sharp, mild


def facts_line(f: dict, pi: float) -> str:
    s = SEASONS[f["season"]]
    season = f"{s['emoji']}{s['name']}" if f["season"] != "none" else "平稳"
    return f"{season} · 拥挤 {f['pres']} · 60 日 {f['ret60'] * 100:+.0f}% · 抢跑度 {pi:.2f}"


def landing(nodes: dict, world: World, pm_links: dict[str, list[str]], val: bool = True) -> list[dict]:
    cands = []
    for nid, n in nodes.items():
        if n["source"] == "aggregated" or nid == "world":
            continue
        depth = len(world.path[nid]) - 1
        if depth <= 1 and n["source"] != "direct":
            continue
        cands.append(nid)
    cands.sort(key=lambda i: (-nodes[i]["gap"], -abs(nodes[i]["impact"])))
    picked: list[str] = []
    n_inf = 0
    per_factor: dict[str, int] = {}
    for nid in cands:
        if any(world.related(nid, p) and nodes[p]["dir"] == nodes[nid]["dir"] for p in picked):
            continue
        if nodes[nid]["inferred"]:
            if n_inf >= LANDING_MAX_INFERRED:
                continue
        fac = nodes[nid].get("factor")
        if fac and per_factor.get(fac, 0) >= FACTOR_MAX:
            continue
        if nodes[nid]["inferred"]:
            n_inf += 1
        per_factor[fac] = per_factor.get(fac, 0) + 1
        picked.append(nid)
        if len(picked) >= LANDING_N:
            break
    # 谁的生意没了 must stay on the list: if every pick is an inflow, the best outflow spot takes the last seat
    if picked and all(nodes[i]["dir"] > 0 for i in picked) and len(picked) >= LANDING_N:
        neg = next((i for i in cands if nodes[i]["dir"] < 0 and nodes[i]["gap"] >= 0.3 and i not in picked
                    and not nodes[i]["inferred"]), None)
        if neg:
            picked[-1] = neg

    # the stocks shown under each spot, and (playbook step 4) what their price already demands
    rows = {}
    for nid in picked:
        n = nodes[nid]
        stocks = []
        for sid in world.stocks_under(nid):
            sf = world.feat(sid)
            spi, _ = priced_in(n["dir"], sf)
            sn = world.nodes[sid]
            st = {"id": sid, "ticker": sn.get("ticker") or sid[2:], "name": sn.get("name"), "note": sn.get("note"),
                  "pricedIn": spi, "tag": priced_word(spi, n["dir"])["tag"], **_weather_brief(sf)}
            if sf.get("est"):
                st["est"], st["basis"] = True, sf.get("basis")
            stocks.append(st)
        stocks.sort(key=lambda x: (x["pricedIn"], -x["wind"] * n["dir"]))
        rows[nid] = (stocks, len(stocks))
    vals = {}
    if val:
        tick = [st["ticker"] for nid in picked for st in rows[nid][0][:STOCKS_PER_LANDING]]
        try:
            vals = V.lookup(tick)
        except Exception:
            vals = {}

    out = []
    for nid in picked:
        n, wn = nodes[nid], world.nodes[nid]
        f = world.feat(nid)
        sharp, mild = voice(n["dir"], n["pricedIn"], f, nid)
        stocks = rows[nid][0][:STOCKS_PER_LANDING]
        views = []
        for st in stocks:
            if val:
                v = V.view(vals.get(st["ticker"]), n["dir"])
                st["val"] = v
                views.append(v)
        vsum = V.summary(views, n["dir"]) if val else None
        dir_say = "钱会流进来" if n["dir"] > 0 else "钱会流出去"
        s = SEASONS[f["season"]]
        season_say = f"{s['emoji']}{s['name']}，{s['now']}" if f["season"] != "none" else "平稳"
        item = {
            "id": nid, "name": wn.get("name"), "emoji": wn.get("emoji", ""), "kind": wn.get("kind"),
            "path": world.name_path(nid), "pathIds": world.path[nid],
            "dir": n["dir"], "impact": n["impact"], "pricedIn": n["pricedIn"], "gap": n["gap"],
            "lag": n["lag"], "lagZh": LAG_ZH.get(n["lag"], n["lag"]), "order": n["order"],
            "inferred": n["inferred"], "source": n["source"], "needs": n.get("needs"), "robust": n.get("robust"),
            "factor": n.get("factor"), "why": n.get("why", ""), "upside": n.get("upside", ""),
            "check": n.get("check", ""), "tag": priced_word(n["pricedIn"], n["dir"])["tag"],
            "say": sharp, "sayMild": f"{dir_say}；{mild}（现在{season_say}）", "facts": facts_line(f, n["pricedIn"]),
            "weather": _weather_brief(f), "stocks": stocks, "nStocks": rows[nid][1],
            "valuation": vsum, "markets": pm_links.get(nid, []),
            "est": bool(n.get("est")), "basis": n.get("basis"), "conf": n.get("conf"),
        }
        if n.get("pricedEst"):
            item["pricedEst"] = n["pricedEst"]
        item["bet"] = bet_kind(item)
        out.append(item)
    return out


BET_ZH = {"base": "打底", "punt": "去搏", "paid": "对了也已付过钱", "hurt": "受损的一边"}


def bet_kind(l: dict) -> dict:
    """Playbook step 5, read off the numbers: 打底 needs a weak/medium root, a clean path, both numbers
    (what the price demands, how big if right) and a price that is not demanding the future already."""
    v = l.get("valuation") or {}
    demand = v.get("demand")
    sized = bool(l.get("upside")) and "说不准" not in (l.get("upside") or "")
    if l["dir"] < 0:
        return {"kind": "hurt", "zh": BET_ZH["hurt"],
                "why": "钱会从这里流出去" + ("，坏消息还没进价" if l["pricedIn"] < 0.4 else "")}
    if l["pricedIn"] >= 0.7 or (demand == "future" and l["pricedIn"] >= 0.4):
        return {"kind": "paid", "zh": BET_ZH["paid"], "why": "钱和价格已经按这件事走了，或价格早要了未来"}
    ok_root = l.get("needs") in ("弱", "中")
    ok_val = demand in ("low", "flat", "high", "etf")
    if ok_root and l.get("robust") and ok_val and sized and l["pricedIn"] < 0.5 and not l.get("inferred"):
        return {"kind": "base", "zh": BET_ZH["base"],
                "why": f"{l.get('needs')}档的根就成立，价格要的和对了多大都算得出"}
    miss = []
    if not ok_root:
        miss.append("只有强档的根才成立")
    if not l.get("robust"):
        miss.append("要猜对具体的路")
    if demand == "future":
        miss.append("价格已经要了未来")
    elif not ok_val:
        miss.append("价格要的没查到")
    if not sized:
        miss.append("对了多大说不准")
    if l.get("inferred"):
        miss.append("是推断出来的")
    if l["pricedIn"] >= 0.5:
        miss.append("算进去一半以上")
    return {"kind": "punt", "zh": BET_ZH["punt"], "why": "；".join(miss) or "把握不够"}


def factors(nodes: dict, land: list[dict], world: World) -> list[dict]:
    """挂在同一件事上的算一注: group the named impacts by what they really bet on."""
    g: dict[str, dict] = {}
    for nid, n in nodes.items():
        if n["source"] != "direct":
            continue
        fac = n.get("factor") or "其他"
        x = g.setdefault(fac, {"name": fac, "ids": [], "landing": [], "gap": 0.0, "up": 0, "down": 0})
        x["ids"].append(nid)
        x["gap"] += n["gap"]
        x["up" if n["dir"] > 0 else "down"] += 1
    for l in land:
        fac = l.get("factor") or "其他"
        if fac in g:
            g[fac]["landing"].append(l["id"])
    if set(g) == {"其他"}:
        return []  # an older answer without factors: nothing to group
    out = sorted(g.values(), key=lambda x: -x["gap"])
    for x in out:
        x["gap"] = round(x["gap"], 2)
        x["names"] = [world.nodes[i].get("name") for i in x["ids"]]
    return out


def verdict(land: list[dict], nodes: dict, facs: list[dict], world: World) -> list[dict]:
    """老风's deterministic summary of the result: where the gap is, what is already taken. ≤ 30 字 each."""
    out = []
    ups = [l for l in land if l["dir"] > 0 and l["pricedIn"] < 0.4]
    downs = [l for l in land if l["dir"] < 0 and l["pricedIn"] < 0.4]
    if ups:
        names = "、".join(f"【{l['name']}】" for l in ups[:2])
        out.append({"kind": "gap", "ids": [l["id"] for l in ups[:2]],
                    "say": f"时间差最大：{names}，没人按你日期算",
                    "sayMild": f"{names}的价格还没反映这个判断"})
    if downs:
        names = "、".join(f"【{l['name']}】" for l in downs[:2])
        out.append({"kind": "unpriced-damage", "ids": [l["id"] for l in downs[:2]],
                    "say": f"{names}还没意识到要挨刀",
                    "sayMild": f"{names}的价格还没反映这个坏消息"})
    taken = sorted([(i, n) for i, n in nodes.items() if n["source"] == "direct" and n["dir"] > 0
                    and n["pricedIn"] >= 0.7 and abs(n["impact"]) >= 1.0], key=lambda x: -x[1]["pricedIn"])
    if taken:
        names = "、".join(f"【{world.nodes[i]['name']}】" for i, _ in taken[:2])
        out.append({"kind": "taken", "ids": [i for i, _ in taken[:2]],
                    "say": f"{names}早被抢跑，对了也已经付过钱",
                    "sayMild": f"{names}已经涨了不少，这个判断大部分已在价格里"})
    if len(land) >= 3 and all(l.get("factor") for l in land):
        k = len({l.get("factor") for l in land})
        out.append({"kind": "factors", "ids": [],
                    "say": f"{len(land)} 个落点其实只押了 {k} 件事，别当成分散",
                    "sayMild": f"这 {len(land)} 个落点归成 {k} 个因子"})
    base = [l for l in land if (l.get("bet") or {}).get("kind") == "base"]
    if base:
        names = "、".join(f"【{l['name']}】" for l in base[:3])
        out.append({"kind": "base", "ids": [l["id"] for l in base[:3]],
                    "say": f"能打底的只有{names}：弱根就成立，价钱算得出",
                    "sayMild": f"{names}在弱或中档的根下就成立，两个数都算得出"})
    else:
        out.append({"kind": "base", "ids": [],
                    "say": "没有一个能打底：要么价格早要了未来，要么数算不出",
                    "sayMild": "按打法的标准，这里没有能打底的落点"})
    cheap = [l for l in land if l["dir"] > 0 and (l.get("valuation") or {}).get("demand") == "low"
             and l["pricedIn"] < 0.5]
    if cheap:
        l = cheap[0]
        out.append({"kind": "cheap", "ids": [l["id"]],
                    "say": f"【{l['name']}】价格在赌下坡，你对了就是错杀",
                    "sayMild": f"【{l['name']}】的估值只反映了不太好的前景"})
    return out


def polymarket_view(picked: list[dict], markets: list[dict], root_date: str | None, nodes: dict,
                    world: World) -> tuple[list[dict], dict[str, list[str]]]:
    cand = {m["id"]: m for m in markets}
    rd = date_end(root_date)
    out, links = [], {}
    for x in picked:
        m = cand[x["id"]]
        end = date_end(m.get("endDate")) if m.get("endDate") else None
        if rd and end:
            vs = "before" if rd < end.replace(day=1) else ("after" if rd > end else "same-month")
        else:
            vs = None
        vs_say = {"before": "你的日期在这个市场截止之前", "after": "你的日期在这个市场截止之后",
                  "same-month": "你的日期和它截止在同一个月", None: ""}[vs]
        touched = []
        for mn in m.get("nodes") or []:
            nid = mn["id"]
            if nid in nodes:
                touched.append(nid)
                links.setdefault(nid, []).append(m["id"])
                # also tag the landing ancestors/descendants that share a lineage
        for nid in list(nodes):
            if any(world.related(nid, t) for t in touched) and m["id"] not in links.get(nid, []):
                links.setdefault(nid, []).append(m["id"])
        d7 = m.get("d7")
        mv = f"预言市场：YES {pp(m['prob'])}"
        if d7 is not None:
            mv += f"（一周 {d7 * 100:+.0f} 个点）"
        if m.get("endDate"):
            mv += f"，{m['endDate']} 截止"
        out.append({"id": m["id"], "question": m["q"], "qZh": m.get("qZh"), "prob": m["prob"],
                    "d1": m.get("d1"), "d7": d7, "d30": m.get("d30"), "endDate": m.get("endDate"),
                    "volume": m.get("volume"), "url": m.get("url"), "relation": x["relation"], "say": x["say"],
                    "marketSay": mv, "ownerVsEnd": vs, "ownerVsEndSay": vs_say, "nodes": touched})
    return out, links


def pp(p) -> str:
    """A probability the way the screen prints it (scenario.js pctProb): '0.8%' under 1%, else whole percent with
    half rounding UP — Python's :.0f rounds 22.5 to 22 while the chart shows 23%, and one card disagreed."""
    try:
        v = float(p) * 100
    except (TypeError, ValueError):
        return "—"
    if not math.isfinite(v):
        return "—"
    if 0 < v < 1 or 99 < v < 100:
        return f"{v:.1f}%"
    return f"{int(math.floor(v + 0.5))}%"


_MID_RE = re.compile(r"(?:(Polymarket|Kalshi|预言市场)\s*(?:市场|盘口)?\s*[#＃]?\s*)?[「“\"(（]?(?<![\d.])(\d{5,9})(?![\d.%])[」”\")）]?")


def market_words(text: str, by_id: dict) -> str:
    """'Polymarket 3215005升到20%以上' → 'Polymarket「12月降息50基点」（现在 0.8%）升到20%以上': a raw market id never
    reaches the screen; the market's Chinese question and its live probability do."""
    if not isinstance(text, str) or not text or not by_id:
        return text

    def sub(m):
        mid = m.group(2)
        mk = by_id.get(mid)
        if not mk:
            return m.group(0)
        q = (mk.get("qZh") or mk.get("q") or "").strip().rstrip("？?")
        src = m.group(1) or "预言市场"
        prob = f"（现在 {pp(mk.get('prob'))}）" if mk.get("prob") is not None else ""
        return f"{src}「{_short(q, 28)}」{prob}"
    return _MID_RE.sub(sub, text)


_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")


def live_prob_text(text: str, old, new) -> str:
    """An LLM line that quotes a market's probability at creation ('市场只给0.8%'): swap that number for today's."""
    if not isinstance(text, str) or old is None or new is None:
        return text
    try:
        o, n = float(old) * 100, float(new) * 100
    except (TypeError, ValueError):
        return text
    if pp(old) == pp(new):
        return text
    tol = 0.15 if o < 1 else 0.6

    def sub(m):
        v = float(m.group(1))
        return pp(new) if abs(v - o) <= tol else m.group(0)
    return _PCT_RE.sub(sub, text)


_GAP_WORDS = ("时间差", "没人按你", "还没算进", "没算进去")


def fix_take(take: str, land: list[dict], verd: list[dict], world) -> tuple[str, bool]:
    """老风's take must not crown a different 「最大的时间差」 than the result's own ranking (the take said 短债 while
    the list ranked 短期国债 #6, 58% priced in). A clause about the gap that names none of the top spots is
    rebuilt from the verdict (or landing[0..1]); everything else in the take stays."""
    if not take or not land:
        return take, False
    gap_v = next((v for v in verd or [] if v.get("kind") == "gap" and v.get("ids")), None)
    top_ids = list(gap_v["ids"]) if gap_v else [l["id"] for l in land[:2]]
    ok_ids = set(top_ids) | {l["id"] for l in land[:2]}

    def names_of(nid):
        n = world.nodes.get(nid) or {}
        out = {str(n.get("name") or "")}
        for sid in (world.stocks_under(nid) if hasattr(world, "stocks_under") else [])[:12]:
            sn = world.nodes.get(sid) or {}
            out |= {str(sn.get("name") or ""), str(sn.get("ticker") or "")}
        return {x for x in out if len(x) >= 2}
    ok_names = set().union(*(names_of(i) for i in ok_ids)) if ok_ids else set()
    parts = re.split(r"([；。;！!])", take)
    changed = False
    for k in range(0, len(parts), 2):
        seg = parts[k]
        if not any(w in seg for w in _GAP_WORDS):
            continue
        if any(nm in seg for nm in ok_names):
            continue
        names = "、".join(f"【{(world.nodes.get(i) or {}).get('name', i)}】" for i in top_ids[:2])
        parts[k] = f"时间差最大的是{names}，还没人按你的日期算"
        changed = True
    return ("".join(parts) if changed else take), changed


def refresh_markets(r: dict, ddir=None) -> bool:
    """Bring a saved scenario's market numbers to today's polymarket.json (no model call, no map math):
    each cited market's prob/d7 + marketSay, probabilities quoted inside the model's lines, the date ladders
    (+ their say lines), raw market ids in 认错线, and the take's 「最大的时间差」 clause. True when anything changed."""
    try:
        by_id = pm.by_id(ddir)
    except Exception:  # noqa: BLE001 — no polymarket.json: keep the saved numbers
        by_id = {}
    before = json.dumps(r, ensure_ascii=False, sort_keys=True)
    for x in r.get("polymarket") or []:
        mk = by_id.get(str(x.get("id")))
        if not mk or mk.get("prob") is None:
            continue
        old = x.get("prob")
        x["say"] = live_prob_text(market_words(x.get("say") or "", by_id), old, mk["prob"])
        x.update(prob=mk["prob"], d1=mk.get("d1"), d7=mk.get("d7"), d30=mk.get("d30"), volume=mk.get("volume"))
        mv = f"预言市场：YES {pp(mk['prob'])}"
        if mk.get("d7") is not None:
            mv += f"（一周 {mk['d7'] * 100:+.0f} 个点）"
        if mk.get("endDate"):
            mv += f"，{mk['endDate']} 截止"
        x["marketSay"] = mv
        x["probAt"] = datetime.now().isoformat(timespec="minutes")
    ro = r.get("rootOdds") or {}
    for m in ro.get("markets") or []:
        mk = by_id.get(str(m.get("id")))
        if mk and mk.get("prob") is not None:
            m.update(prob=mk["prob"], d7=mk.get("d7"))
    if ro.get("say") and ro.get("direct") and ro.get("markets"):
        ro["say"] = live_prob_text(ro["say"], ro.get("prob"), ro["markets"][0].get("prob"))
    try:
        evs = {str(e.get("id")): e for e in ((pm._read_file(ddir) or {}).get("events") or []) if isinstance(e, dict)}
    except Exception:  # noqa: BLE001
        evs = {}
    md = r.get("marketDates") or []
    if md:
        rebuilt = []
        for it in md:
            e = evs.get(str(it.get("id")))
            lad = it.get("ladder") or []
            if e and e.get("ladder"):
                lad = sorted(({"date": str(x.get("date") or "")[:10], "prob": x.get("prob"), "d7": x.get("d7"),
                               "id": x.get("id"), "label": x.get("label")} for x in e["ladder"] if x.get("date")),
                             key=lambda x: x["date"])
            else:                                       # no event: still take each rung's live price
                lad = [dict(x, prob=(by_id.get(str(x.get("id"))) or {}).get("prob", x.get("prob"))) for x in lad]
            rebuilt.append({"id": it.get("id"), "title": it.get("title"), "titleZh": it.get("titleZh"),
                            "p50": (e or {}).get("p50", it.get("p50")), "relation": it.get("relation"),
                            "ladder": lad, "say": it.get("say")})
        new = market_dates(rebuilt, (r.get("root") or {}).get("date") or r.get("input", {}).get("date"))
        if new:
            r["marketDates"] = new
    for k in r.get("killSignals") or []:
        k["signal"] = market_words(k.get("signal") or "", by_id)
        if k.get("ifMissing"):
            k["ifMissing"] = market_words(k["ifMissing"], by_id)
    for c in r.get("chain") or []:
        c["say"] = market_words(c.get("say") or "", by_id)
    for key in ("take", "headline", "headlineMild", "risk", "upside"):
        if isinstance(r.get(key), str):
            r[key] = market_words(r[key], by_id)
    if r.get("take") and r.get("landing"):
        try:
            dd = (r.get("meta") or {}).get("dataDir")
            r["take"], _ = fix_take(r["take"], r["landing"], r.get("verdict") or [], _names(ROOT / dd if dd else ddir))
        except Exception:  # noqa: BLE001 — a map that will not load keeps the take as it is
            pass
    return json.dumps(r, ensure_ascii=False, sort_keys=True) != before


class _Names:
    """Just the tree's names (no map series) — what fix_take needs, cheap enough for every status read."""

    def __init__(self, tree: dict):
        self.nodes: dict[str, dict] = {}
        self.kids: dict[str, list[str]] = {}

        def walk(n):
            nid = n.get("id")
            if not nid:
                return
            self.nodes.setdefault(nid, {k: v for k, v in n.items() if k != "children"})
            self.kids.setdefault(nid, [])
            for c in n.get("children") or []:
                if c.get("id"):
                    self.kids[nid].append(c["id"])
                walk(c)
        walk(tree)

    def stocks_under(self, nid: str) -> list[str]:
        out, todo = [], [nid]
        while todo:
            x = todo.pop()
            if (self.nodes.get(x) or {}).get("kind") == "stock":
                out.append(x)
            todo += self.kids.get(x, [])
        return out


_names_cache: dict[str, tuple[float, _Names]] = {}


def _names(ddir=None) -> _Names:
    from weather import data_dir
    p = Path(data_dir(ddir)) / "tree.json"
    mt = p.stat().st_mtime
    hit = _names_cache.get(str(p))
    if hit and hit[0] == mt:
        return hit[1]
    n = _Names(json.loads(p.read_text()))
    _names_cache[str(p)] = (mt, n)
    return n


def _months_between(a: _date, b: _date) -> int:
    return (b.year - a.year) * 12 + (b.month - a.month)


def market_dates(ladders: list[dict], root_date: str | None) -> list[dict]:
    """The time difference made visible (§10): what date the market puts on it vs the owner's date."""
    rd = date_end(root_date)
    out = []
    for e in ladders:
        lad = [x for x in e.get("ladder") or [] if x.get("prob") is not None and date_end(x.get("date"))]
        if not lad:
            continue
        first, last = lad[0], lad[-1]
        p50 = date_end(e.get("p50")) if e.get("p50") else None
        rel = e.get("relation") or "timing"
        item = {"id": e["id"], "title": e.get("title"), "titleZh": e.get("titleZh"), "p50": e.get("p50"),
                "relation": rel, "ladder": lad, "ownerDate": root_date, "probByOwner": None, "monthsEarly": None}
        if rd:
            by = [x for x in lad if date_end(x["date"]) <= _date.fromordinal(rd.toordinal() + 3)]
            item["probByOwner"] = by[-1]["prob"] if by else None
            lb = lambda x: x.get("label") or x["date"]  # noqa: E731 — "2026年12月31日" reads better than 2027-01-01
            rungs = "、".join(f"{lb(x)}前 {pp(x['prob'])}" for x in lad[:4])
            if by:
                fact = f"市场给：{rungs}；你的日期在“{lb(by[-1])}”那档之后"
            else:
                fact = f"市场给：{rungs}；你的日期比最早一档还早"
            if p50:
                m = _months_between(rd, p50)
                item["monthsEarly"] = m
                if m > 0:
                    sharp, mild = f"市场要到 {e['p50'][:7]} 才过半，你早了 {m} 个月", f"市场的过半日期比你晚约 {m} 个月"
                elif m < 0:
                    sharp, mild = f"市场比你还急：{e['p50'][:7]} 就过半", f"市场的过半日期比你早约 {-m} 个月"
                else:
                    sharp, mild = "市场和你押的是同一个月", "市场的过半日期和你一致"
            else:
                m = _months_between(rd, date_end(last["date"]))
                item["monthsEarly"] = m if m > 0 else None
                sharp = (f"到{lb(last)}也只给 {pp(last['prob'])}，市场根本不信" if last["prob"] < 0.3
                         else f"到{lb(last)}才 {pp(last['prob'])}，市场觉得还早")
                mild = f"到{lb(last)}市场给 {pp(last['prob'])}，还没过半"
            if rel == "contradicts":  # a ladder for the thing that would prove the owner wrong
                top = max(x["prob"] for x in lad)
                sharp = (f"唱反调的只占少数：到{lb(last)}才 {pp(last['prob'])}" if top < 0.5
                         else f"唱反调的已经过半（{pp(top)}），小心")
                mild = f"反方向的事：到{lb(last)}市场给 {pp(last['prob'])}"
            item.update(fact=fact, say=sharp, sayMild=mild)
        else:
            item.update(fact=e.get("say") or "", say=e.get("say") or "", sayMild=e.get("say") or "")
        out.append(item)
    return out


def stages(nodes: dict) -> dict:
    st = {k: [] for k in LAGS}
    for nid, n in sorted(nodes.items(), key=lambda kv: (kv[1]["order"], -abs(kv[1]["impact"]))):
        if n["source"] == "aggregated":
            continue
        st[n["lag"]].append(nid)
    return st


# ----------------------------------------------------------------------------------------------
# the whole run
# ----------------------------------------------------------------------------------------------
def run(text: str, date: str | None = None, tier: str | None = None, *, data=None, out_dir=None,
        work_dir=None, sid: str | None = None, progress=None, save: bool = True, answer: dict | None = None,
        today: _date | None = None, created_at: str | None = None, val: bool = True,
        made_on: str | None = None) -> dict:
    """Run one scenario. `answer` = a saved raw model answer (skips the model call). `made_on` keeps the
    data date of the original run on a rebuild, so tracking still counts from the day it was made."""
    text = (text or "").strip()
    if not text:
        raise ValueError("要先写一句判断")
    today = today or _date.today()
    t0 = time.time()
    say = progress or (lambda *_: None)
    date = norm_date(date, today) if date else None
    tier = norm_tier(tier)
    sid = sid or make_id(text, date, tier)
    out_dir = Path(out_dir) if out_dir else OUT_DIR
    work_dir = Path(work_dir) if work_dir else WORK_DIR
    warnings: list[str] = []

    say("读地图")
    world = World(data)

    say("找预言市场")
    pmr = pm.find_markets(text, k=12, ddir=world.dir)
    markets = pmr["markets"]
    try:
        ladders = pm.find_ladders(text, k=4, ddir=world.dir)
    except Exception:
        ladders = []
    if not pmr["source"] and not ladders:
        warnings.append("这次没有预言市场数据（polymarket.json 还没有）")
    # every rung of a date ladder is a market the model may cite
    have = {m["id"] for m in markets}
    allm = pm.by_id(world.dir) if ladders else {}
    rungs = [allm[x["id"]] for e in ladders for x in e["ladder"] if x.get("id") in allm and x["id"] not in have]
    cand = markets + list({m["id"]: m for m in rungs}.values())

    calls = []
    if answer is None:
        say("正在推演（AI 在想，约 1 到 2 分钟）")
        prompt_text = P.build(world, text, date, tier, markets, today=today, ladders=ladders)
        sch = P.schema(world, cand)
        answer, calls = llm.ask_json(prompt_text, P.SYSTEM, schema=sch, validate=make_validator(world))
        if save:
            _write_json(work_dir / f"{sid}.raw.json",
                        {"id": sid, "input": {"text": text, "date": date, "tier": tier},
                         "createdAt": datetime.now().isoformat(timespec="seconds"), "asOf": world.asOf,
                         "answer": answer, "calls": calls})

    say("算时间差")
    # a market the model cited stays usable even if today's candidate search ranks it lower (rebuilds)
    allm = allm or pm.by_id(world.dir)
    have = {m["id"] for m in cand}
    for mid in [str(x.get("id")) for x in (answer.get("polymarket") or []) if isinstance(x, dict)] + \
            [str(x) for x in ((answer.get("rootOdds") or {}).get("marketIds") or [])]:
        if mid not in have and mid in allm:
            cand.append(allm[mid])
            have.add(mid)
    ans = repair(answer, world, cand, text, date, tier, warnings)
    if len(ans["impacts"]) < 1:
        raise llm.LLMError("推演结果里没有一个能落到地图上的地块")
    nodes = postprocess(ans, world, cand)
    pm_out, pm_links = polymarket_view(ans["polymarket"], cand, ans["root"]["date"], nodes, world)
    cited = {x["id"]: x["relation"] for x in ans["polymarket"]}
    cited.update({i: cited.get(i, "supports") for i in ans["rootOdds"]["marketIds"]})
    used = []
    for e in ladders:
        rel = next((cited[x["id"]] for x in e["ladder"] if x.get("id") in cited), None)
        if rel:
            used.append(dict(e, relation=rel))
    mdates = market_dates(used, ans["root"]["date"])
    if val:
        say("比价钱（查估值）")
    land = landing(nodes, world, pm_links, val=val)
    facs = factors(nodes, land, world)
    verd = verdict(land, nodes, facs, world)
    # model lines must not show raw market ids, nor crown a different 「最大的时间差」 than the ranking above
    mk_by_id = {m["id"]: m for m in cand}
    for k in ans["killSignals"]:
        k["signal"] = market_words(k["signal"], mk_by_id)
        k["ifMissing"] = market_words(k.get("ifMissing") or "", mk_by_id)
    for c in ans["chain"]:
        c["say"] = market_words(c["say"], mk_by_id)
    for x in pm_out:
        x["say"] = market_words(x.get("say") or "", mk_by_id)
    for key in ("take", "headline", "headlineMild", "risk", "upside"):
        if isinstance(ans.get(key), str):
            ans[key] = market_words(ans[key], mk_by_id)
    ans["take"], take_fixed = fix_take(ans["take"], land, verd, world)
    if take_fixed:
        warnings.append("老风的话里「最大的时间差」跟落点排名对不上，按排名改写了那一句")
    check_kill_signals(ans["killSignals"], today, warnings)

    impacts = []
    for imp in ans["impacts"]:
        n = nodes[imp["id"]]
        impacts.append({**imp, "impact": n["impact"], "pricedIn": n["pricedIn"], "gap": n["gap"],
                        "name": world.nodes[imp["id"]].get("name"), "path": world.name_path(imp["id"])})
    impacts.sort(key=lambda x: (x["order"], LAGS.index(x["lag"]), -x["strength"]))

    result = {
        "id": sid, "version": VERSION,
        "createdAt": created_at or datetime.now().isoformat(timespec="seconds"),
        "asOf": made_on or world.asOf,
        "input": {"text": text, "date": date, "tier": tier},
        "title": ans["title"], "headline": ans["headline"], "headlineMild": ans["headlineMild"],
        "take": ans["take"], "verdict": verd, "root": ans["root"],
        "rootOdds": {**ans["rootOdds"], "markets": [
            {"id": m["id"], "question": m["q"], "qZh": m.get("qZh"), "prob": m["prob"], "d7": m.get("d7"),
             "endDate": m.get("endDate"), "url": m.get("url")}
            for m in cand if m["id"] in ans["rootOdds"]["marketIds"]]},
        "marketDates": mdates,
        "upside": ans["upside"], "risk": ans["risk"],
        "chain": ans["chain"], "impacts": impacts,
        "polymarket": pm_out, "killSignals": ans["killSignals"],
        "nodes": nodes, "landing": land, "factors": facs, "stages": stages(nodes),
        "epicenters": [i["id"] for i in sorted(ans["impacts"], key=lambda x: (x["order"], -x["strength"]))
                       if i["order"] == 1][:4],
        "snapshot": {nid: {"wind": world.feat(nid)["wind"], "pres": world.feat(nid)["pres"]}
                     for nid, n in nodes.items() if n["source"] != "aggregated"},
        "track": None,
        "meta": {
            "sec": round(time.time() - t0, 1),
            "model": next((c.get("model") for c in calls if c.get("model")), None),
            "cost": round(sum(c.get("cost") or 0 for c in calls), 4) if calls else None,
            "calls": len(calls), "dataDir": _rel(world.dir), "dataAsOf": world.asOf,
            "polymarketSource": pmr["source"], "polymarketAsOf": pmr["asOf"],
            "polymarketCandidates": [m["id"] for m in markets],
            "polymarketLadders": [e["id"] for e in ladders],
            "warnings": warnings,
            "pricedInNote": "“抢跑度”只看钱和价格已经走了多少（季节、拥挤度、60 日涨跌、温度）。"
                            "“价格要的”是打法第 4 步的粗算：市值 ÷ 一年现金流（没有就用利润），"
                            "要和每个落点的“对了多大”放在一起比；查不到的写“没查到”，不当成便宜。",
            "estimates": sum(1 for n in nodes.values() if n.get("est")) + (1 if ans["rootOdds"].get("est") else 0),
        },
    }
    result = _clean(result)
    if save:
        _write_json(out_dir / f"{sid}.json", result)
        write_index(out_dir)
    say("完成")
    return result


def check_kill_signals(ks: list[dict], today: _date, warnings: list[str]):
    """The root's own 认错线 must be near: one in each of the next three months (playbook step 1)."""
    months = P._months_after(today, 3)
    have = {str(k.get("by") or "")[:7] for k in ks}
    miss = [m for m in months if m not in have]
    if miss:
        warnings.append("认错线没有覆盖接下来每个月：缺 " + "、".join(miss))
    for k in ks:
        k["month"] = str(k.get("by") or "")[:7]


# ----------------------------------------------------------------------------------------------
# persistence: web/data/scenarios/<id>.json + index.json (the list the screen reads statically)
# ----------------------------------------------------------------------------------------------
def summary_of(r: dict) -> dict:
    tr = r.get("track") or {}
    return {
        "id": r["id"], "title": r.get("title"), "headline": r.get("headline"),
        "headlineMild": r.get("headlineMild") or r.get("headline"), "take": r.get("take"),
        "root": {k: (r.get("root") or {}).get(k) for k in ("text", "date", "tier")},
        "createdAt": r.get("createdAt"), "asOf": r.get("asOf"),
        "rootOdds": {k: (r.get("rootOdds") or {}).get(k) for k in ("prob", "direct", "est")},
        "factors": [f["name"] for f in r.get("factors") or []][:5],
        "top": [{"id": l["id"], "name": l["name"], "dir": l["dir"], "gap": l["gap"], "tag": l["tag"],
                 "bet": (l.get("bet") or {}).get("kind"), "pathIds": l.get("pathIds")}
                for l in (r.get("landing") or [])[:3]],
        "nLanding": len(r.get("landing") or []),
        "base": [l["name"] for l in r.get("landing") or [] if (l.get("bet") or {}).get("kind") == "base"],
        "track": ({k: tr.get(k) for k in ("asOf", "days", "hit", "miss", "flowHit", "rate", "say", "sayMild",
                                          "gapSay")} if tr else None),
        "due": len((tr or {}).get("due") or []),
    }


def write_index(out_dir=None) -> dict:
    d = Path(out_dir) if out_dir else OUT_DIR
    d.mkdir(parents=True, exist_ok=True)
    items = []
    for fp in d.glob("*.json"):
        if fp.name == INDEX_NAME or fp.name.endswith((".raw.json", ".status.json", ".tmp")):
            continue
        try:
            r = json.loads(fp.read_text())
        except Exception:
            continue
        if isinstance(r, dict) and r.get("id") and isinstance(r.get("landing"), list):
            items.append(summary_of(r))
    items.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    for it in items:  # the older list shape (job.list_scenarios before v2) called the top spots "landing"
        it["landing"] = it["top"]
    idx = {"updatedAt": datetime.now().isoformat(timespec="seconds"), "count": len(items), "scenarios": items}
    _write_json(d / INDEX_NAME, idx)
    return idx


def delete(sid: str, out_dir=None, work_dir=None) -> bool:
    if not re.match(r"^\d{8}-\d{6}-[0-9a-f]{4}$", str(sid or "")):
        return False
    d, w = Path(out_dir) if out_dir else OUT_DIR, Path(work_dir) if work_dir else WORK_DIR
    trash = w / "trash"
    hit = False
    for fp in (d / f"{sid}.json", w / f"{sid}.raw.json", w / f"{sid}.status.json", w / f"{sid}.log"):
        if fp.exists():  # soft delete: moved to scenario/out/trash/, never destroyed
            trash.mkdir(parents=True, exist_ok=True)
            os.replace(fp, trash / fp.name)
            hit = True
    write_index(d)
    return hit


# ----------------------------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------------------------
def _print_summary(r: dict, path: Path | None):
    print(f"\n🔮 {r['title']}  ·  根：{r['root']['text']}（{r['root']['date']}，{r['root']['tier']}）")
    print(f"   {r['headline']}")
    if r.get("take"):
        print(f"   老风：{r['take']}")
    if r["root"].get("note"):
        print(f"   怎么算成真：{r['root']['note']}")
    ro = r.get("rootOdds") or {}
    if ro.get("prob") is not None:
        est = f"（估：{ro.get('basis')}，把握 {ro.get('conf')}）" if ro.get("est") else "（直接押这件事的盘子）"
        print(f"   预言市场给这个根：{ro['prob'] * 100:.1f}%{est}  {ro.get('say', '')}")
    if r.get("upside"):
        print(f"   对了有多大：{r['upside']}")
    if r.get("risk"):
        print(f"   最要紧的风险：{r['risk']}")
    print("\n链条：")
    for st in r["chain"]:
        print(f"  {st['step']}. {st['q']}：{st['say']}  → {', '.join(st['nodes'])}")
    print("\n因子（挂在同一件事上的算一注）：")
    for f in r.get("factors") or []:
        print(f"  {f['name']}：{len(f['ids'])} 条，时间差合计 {f['gap']:.2f}  ({'、'.join(f['names'][:6])})")
    print("\n落点（按时间差排）：")
    for k, l in enumerate(r["landing"], 1):
        arrow = "↑" if l["dir"] > 0 else "↓"
        print(f"  {k}. {arrow} {l['path']}  差 {l['gap']:.2f}  影响 {l['impact']:+.2f}  抢跑 {l['pricedIn']:.2f}  "
              f"{l['lagZh']}  {l['tag']}  [{l.get('factor')}|要{l.get('needs')}档]{'  [推断]' if l['inferred'] else ''}")
        print(f"     老风：{l['say']}   ({l['facts']})   【{(l.get('bet') or {}).get('zh')}】{(l.get('bet') or {}).get('why')}")
        if l.get("why"):
            print(f"     为什么：{l['why']}")
        if l.get("upside"):
            print(f"     对了多大：{l['upside']}")
        if l.get("valuation"):
            print(f"     价格要的：{l['valuation']['say']}（{l['valuation']['sayMild']}）")
        stocks = " ".join(f"{s['ticker']}({s['pricedIn']:.2f}"
                          + (f",{s['val']['multiple']:.0f}x" if (s.get('val') or {}).get('multiple') else "") + ")"
                          for s in l["stocks"][:5])
        if stocks:
            print(f"     里面最没被算进去的：{stocks}")
    if r.get("verdict"):
        print("\n老风总结：")
        for v in r["verdict"]:
            print(f"  · {v['say']}")
    if r.get("marketDates"):
        print("\n市场给的日子：")
        for m in r["marketDates"]:
            print(f"  [{m.get('relation')}] {m['title']}：{m.get('fact')}  → {m.get('say')}")
    if r["polymarket"]:
        print("\n预言市场：")
        for m in r["polymarket"]:
            print(f"  [{m['relation']}] {m['question']}  {m['marketSay']}")
            print(f"     {m['say']}  {m['ownerVsEndSay']}")
    print("\n认错线：")
    for k in r["killSignals"]:
        print(f"  {k['by']}  {k['signal']}  （{k['ifMissing']}）")
    if r["meta"]["warnings"]:
        print("\n提醒：" + "；".join(r["meta"]["warnings"][:8]))
    print(f"\n用时 {r['meta']['sec']}s，模型 {r['meta']['model']}，费用 {r['meta']['cost']}，估计项 {r['meta'].get('estimates')}")
    if path:
        print(f"写到了 {path}")


def _status_writer(path: str | None, sid: str):
    if not path:
        return lambda stage: print(f"… {stage}", file=sys.stderr)
    p = Path(path)

    def write(stage):
        st = {}
        try:
            st = json.loads(p.read_text())
        except Exception:
            pass
        st.update({"id": sid, "state": "done" if stage == "完成" else "running", "stage": stage,
                   "updatedAt": datetime.now().isoformat(timespec="seconds"), "pid": os.getpid()})
        _write_json(p, st)
    return write


def rebuild(work_dir=None, out_dir=None, data=None, val: bool = True) -> list[str]:
    """Redo step 2 for every saved raw answer (no model call): after a formula change or a data move."""
    w = Path(work_dir) if work_dir else WORK_DIR
    done = []
    for fp in sorted(w.glob("*.raw.json")):
        try:
            raw = json.loads(fp.read_text())
        except Exception:
            continue
        sid = raw.get("id") or fp.name[:-len(".raw.json")]
        inp = raw.get("input") or {}
        old = {}
        for d in (Path(out_dir) if out_dir else OUT_DIR, w):
            try:
                old = json.loads((d / f"{sid}.json").read_text())
                break
            except Exception:
                continue
        inp = inp or old.get("input") or {}
        text = inp.get("text") or ((old.get("root") or {}).get("original"))
        if not text or not raw.get("answer"):
            continue
        run(text, inp.get("date"), inp.get("tier"), data=data, out_dir=out_dir, work_dir=w, sid=sid,
            answer=raw["answer"], created_at=raw.get("createdAt") or old.get("createdAt"), val=val,
            made_on=raw.get("asOf") or old.get("asOf"))
        done.append(sid)
    return done


def main(argv=None):
    ap = argparse.ArgumentParser(description="推演模式：如果我的判断成真，天气图会怎么变")
    ap.add_argument("text", nargs="?")
    ap.add_argument("--date", help="根的日期，例如 2026-11")
    ap.add_argument("--tier", help="根的档：弱 / 中 / 强")
    ap.add_argument("--data", help="地图数据目录（默认 web/data，或 $MW_DATA_DIR）")
    ap.add_argument("--out", help="结果目录（默认 web/data/scenarios，或 $MW_SCENARIO_DIR）")
    ap.add_argument("--work", help="草稿目录：模型原始回答、进度、日志（默认 scenario/out，或 $MW_SCENARIO_WORK）")
    ap.add_argument("--id", help="指定结果 id（job.py 用）")
    ap.add_argument("--status-file", help="把进度写到这个文件（job.py 用）")
    ap.add_argument("--reuse", help="用一个保存过的 <id>.raw.json 重算，不再调用模型（id 也沿用）")
    ap.add_argument("--rebuild", action="store_true", help="把草稿目录里所有的原始回答按现在的数据重算一遍")
    ap.add_argument("--no-val", action="store_true", help="不查估值（离线时用）")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    if a.rebuild:
        ids = rebuild(a.work, a.out, a.data, val=not a.no_val)
        print(f"重算了 {len(ids)} 个推演：{', '.join(ids)}")
        return 0
    answer, created, made_on = None, None, None
    sid = a.id
    if a.reuse:
        raw = json.loads(Path(a.reuse).read_text())
        answer, created, made_on = raw.get("answer"), raw.get("createdAt"), raw.get("asOf")
        sid = sid or raw.get("id")
        inp = raw.get("input") or {}
        if (not created or not inp) and sid:  # older raw files: take both from the saved result
            for d in (Path(a.out) if a.out else OUT_DIR, Path(a.work) if a.work else WORK_DIR):
                try:
                    old = json.loads((d / f"{sid}.json").read_text())
                except Exception:
                    continue
                created = created or old.get("createdAt")
                made_on = made_on or old.get("asOf")
                inp = inp or old.get("input") or {}
                break
        a.text = a.text or inp.get("text")
        a.date = a.date or inp.get("date")
        a.tier = a.tier or inp.get("tier")
    if not a.text:
        ap.error("要写一句判断")
    sid = sid or make_id(a.text, a.date, a.tier)
    status = _status_writer(a.status_file, sid)
    try:
        r = run(a.text, a.date, a.tier, data=a.data, out_dir=a.out, work_dir=a.work, sid=sid, progress=status,
                answer=answer, created_at=created, val=not a.no_val, made_on=made_on)
    except Exception as e:  # noqa: BLE001
        if a.status_file:
            st = {"id": sid, "state": "error", "stage": "出错了", "error": str(e)[:500],
                  "updatedAt": datetime.now().isoformat(timespec="seconds")}
            _write_json(Path(a.status_file), st)
        print(f"推演失败：{e}", file=sys.stderr)
        return 1
    if not a.quiet:
        _print_summary(r, (Path(a.out) if a.out else OUT_DIR) / f"{r['id']}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
