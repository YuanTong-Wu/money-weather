#!/usr/bin/env python3
"""attention_candidates.py — 全市场雷达: the few full-market things worth the owner's attention today.

    python3 fullmarket/attention_candidates.py             # → web/data/fm/candidates.json (+ static stock files)
    python3 fullmarket/attention_candidates.py --print     # also print a human-readable list
    python3 fullmarket/attention_candidates.py --i -6 --print --no-write    # pretend today is 5 days ago

Reads fullmarket/out/series_full.npz + web/data/fm/tree.json (both from compute_full.py), web/data/search.json (the
curated map, to skip what it already shows) and fullmarket/universe_full.json (country → 海外 badge).
pipeline/brief.py reads candidates.json (class Radar) and lets the radar take at most 1 of the 3 spotlights and 1–2
of the 5 tour stops, only when it beats the curated #3 by +0.5 (DESIGN §6, fullmarket/REPORT.md §5).

Scoring = DESIGN §6 surprise + §8.2 spring bonus (identical to brief.py / words.js):
  0.45·|w−w₋₅| + 0.25·|w| + 0.15·|t−t₋₅| + 0.6·|front| + 0.3·(storm≥0.8) + 0.2·(pres≥90 or ≤10) + 0.5·(🌱 春)
Season = §8.2 + the §8 amendment crash gate (pipeline/crashgate.py, imported): a node falling hard reads 🍂/❄️, never
🌱/☀️/平稳; its item carries `crash` (0/1/2, what brief.py's Radar reads), `crashInfo` {level, name, r1, r5, by} and
its story is 「崩了 / 急跌」 with the exact drop.
Diversity rules (REPORT §5.3):
  · eligible: dv20 ≥ $5M a day; spotlight / tour need ≥ $20M (spotlightOk / tourOk)
  · cap tiers are folded into their parent industry (大/中/小型银行 = one story: 美国银行), one item per industry
  · never an item inside another chosen item (no 金融 + 美国银行), ≤ 2 per sector, ≤ 7 stocks of 12,
    ≤ 4 of one story (front / spring / inflow …); $20M+ items are picked first
  · skipped: stocks the curated map already has, §14-estimated nodes, stale tickers
  · ranking prefers 🌱 spring and fronts (+0.3, like brief.py's Radar), foreign listings ×0.9
Item fields brief.py relies on: id, name, kind ('region'|'stock'), ticker, score, wind, dw5, pres, front, season,
flow5, ret5, dv20, parentId (dedupe key = folded industry), parentName, path, pathIds (full-map ids, incl. itself).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import zlib
from datetime import datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT / "pipeline") not in sys.path:
    sys.path.append(str(ROOT / "pipeline"))      # appended, so nothing in pipeline/ can shadow our own modules
import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 brief.py、words.js crashAt 同一条规则
NPZ = HERE / "out" / "series_full.npz"
FM = ROOT / "web" / "data" / "fm"
CURATED = ROOT / "web" / "data"
UNIVERSE = HERE / "universe_full.json"
LABEL = "全市场雷达"
MIN_DV, SPOT_DV = 5.0, 20.0          # USD millions / day
K_ITEMS, MAX_STOCKS, PER_SECTOR, KIND_CAP = 12, 7, 2, 4

SEASONS = {
    "spring": {"emoji": "🌱", "name": "春", "now": "钱刚开始进来，还不挤", "next": "可能进入夏天"},
    "summer": {"emoji": "☀️", "name": "夏", "now": "正热、人多", "next": "小心入秋"},
    "autumn": {"emoji": "🍂", "name": "秋", "now": "钱从拥挤处撤离", "next": "可能入冬"},
    "winter": {"emoji": "❄️", "name": "冬", "now": "冷清没人管", "next": "等春天"},
}


# ------------------------------------------------------------------------------------------------ words
def isnum(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def han_len(s: str) -> int:
    return len(re.findall(r"[㐀-鿿]", str(s)))


def money(m) -> str:
    """USD millions → 3.2亿美元 / 850万美元 (same as brief.py / words.js)."""
    if not isnum(m):
        return "—"
    a = abs(m)
    sg = "-" if (m < 0 and a * 100 >= 0.05) else ""
    if a >= 1e6:
        wy = a / 1e6
        return sg + (str(round(wy)) if wy >= 9.95 else f"{wy:.1f}") + "万亿美元"
    if a >= 100:
        yi = a / 100
        return sg + (str(round(yi)) if yi >= 99.95 else f"{yi:.1f}") + "亿美元"
    wan = a * 100
    if wan >= 9.95:
        return sg + str(round(wan)) + "万美元"
    return sg + f"{wan:.1f}" + "万美元" if wan >= 0.05 else "0美元"


def pct_abs(x) -> str:
    if not isnum(x):
        return "—"
    a = abs(x * 100)
    return (str(round(a)) if a >= 99.5 else f"{a:.1f}") + "%"


def times(r) -> str:
    if not isnum(r):
        return "—"
    if r >= 9.95:
        return str(round(r))
    s = f"{r:.1f}"
    return s[:-2] if s.endswith(".0") else s


def flow_text(f5) -> str:
    if not isnum(f5) or abs(f5) < 0.05:
        return "5天进出打平"
    return f'5天净{"流入" if f5 > 0 else "流出"} {money(abs(f5))}'


def fit(*options: str, limit: int = 28) -> str:
    """first option whose every sentence has ≤ limit Chinese characters (§12: short)."""
    for s in options:
        if all(han_len(p) <= limit for p in re.split(r"[。！？]", s)):
            return s
    return options[-1]


def vary(key: str, options: list[str]) -> str:
    """stable pick among phrasings, so 12 fronts don't read like a broken record."""
    return options[zlib.crc32(key.encode("utf-8")) % len(options)]


def season_key(w, dw, p, crash=None):
    """DESIGN §8.2 (same order as brief.py season_key) + the crash gate (§8 amendment): crash = crashgate.crash_at(...)
    or a level → 春 / 夏 / None read 秋 when p ≥ 50, else 冬."""
    if not isnum(w) or not isnum(p):
        return None
    dw = dw if isnum(dw) else 0.0
    k = None
    if w > 0.3 and dw > 0.3 and p < 65:
        k = "spring"
    elif w > 0.3 and p >= 65:
        k = "summer"
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = "autumn"
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = "winter"
    return CG.gate_key(k, crash, p)


def crash_level(cr) -> int:
    return int(cr.get("level", 0)) if isinstance(cr, dict) else (int(cr) if isnum(cr) else 0)


def crash_drop(cr, r5=None) -> str:
    """「一天跌了 19.8%」/「5天跌了 9.3%」: the test that fired (words.js crashDrop), else the 5-day return."""
    if isinstance(cr, dict):
        if cr.get("by") == "r1" and isnum(cr.get("r1")):
            return f"一天跌了 {pct_abs(cr['r1'])}"
        if isnum(cr.get("r5")):
            return f"5天跌了 {pct_abs(cr['r5'])}"
    return f"5天跌了 {pct_abs(r5)}" if isnum(r5) and r5 < 0 else ""


def dominant(P: dict) -> str:
    if P["front"]:
        return "front"
    parts = [("shift", P["shift"]), ("level", P["level"]), ("heat", P["heat"]), ("storm", P["storm"]),
             ("crowd", P["crowd"])]
    parts.sort(key=lambda kv: -kv[1])
    return parts[0][0]


def story(P: dict, v: dict, key: str = "") -> tuple[str, str, str]:
    """→ (story kind, sharp sentence, mild sentence) — §12 voice, numbers exact, no name inside."""
    w, w5, f5 = P["wind"], P["wind5"], v["flow5"]
    rt = f"，是平时的 {times(v['ratio'])} 倍" if isnum(v.get("ratio")) and v["ratio"] >= 1.5 else ""
    lv = crash_level(P.get("crash"))
    if lv:   # 暴跌闸门 (§8 amendment): the drop IS the story — say it first, exactly (words.js crashWords)
        dd = crash_drop(P.get("crash"), v.get("ret5"))
        dd = f"：{dd}" if dd else ""
        if lv >= 2:
            return "crash", fit(f"崩了{dd}，人多是在逃命。", f"崩了{dd}。"), f"暴跌{dd}，远超它平时的波动。"
        return "crash", fit(f"急跌{dd}，热闹的是夺门的人。", f"急跌{dd}。"), f"急跌{dd}，比它平时的波动大得多。"
    d = dominant(P)
    if d == "front":
        if P["frontV"] > 0:
            if isnum(f5) and f5 > 0.05:
                m = money(f5)
                p = P["pres"] if isnum(P["pres"]) else 50
                if p >= 80:      # turned AND already packed: not a bottom-fishing story
                    lead = f"风向刚掉头就挤爆了：5天净流入 {m}，拥挤度 {round(p)}。"
                elif p >= 65:
                    lead = f"风向掉头，钱杀回来了：5天净流入 {m}，人已经不少。"
                else:
                    lead = vary(key, [f"前几天还在被抛，风向突然掉头：5天净流入 {m}，有人先动手了。",
                                      f"前两天还没人要，今天钱杀回来了：5天净流入 {m}。",
                                      f"风向掉头，抄底的先进场了：5天净流入 {m}。"])
                return "front", fit(lead, f"风向突然掉头：5天净流入 {m}。"), f"前几天还在撤，风向刚变：这5天净流入 {m}。"
            return "front", "前几天还在被抛，风向突然掉头，人气先回来了。", "前几天还在撤，风向刚变，钱掉头进来了。"
        if isnum(f5) and f5 < -0.05:
            m = money(-f5)
            lead = vary(key, [f"前几天还在抢，今天翻脸就跑：5天流出 {m}。",
                              f"风向翻脸，先跑的人已经在跑：5天流出 {m}。"])
            return "front", fit(lead, f"风向刚翻脸：5天流出 {m}。"), f"前几天还在进钱，风向刚变：这5天流出 {m}。"
        return "front", "前几天还在进钱，今天风向翻脸，开始撤了。", "前几天还在进钱，风向刚变，开始往外撤。"
    if P["season"] == "spring" and d in ("shift", "level") and isnum(f5) and f5 > 0:
        p = round(P["pres"]) if isnum(P["pres"]) else 50
        return ("spring", f"刚冒芽：{flow_text(f5)}，人还不多（拥挤度 {p}）。",
                f"钱刚开始进来：{flow_text(f5)}，还不挤（拥挤度 {p}）。")
    if d == "shift":
        if w5 is not None and w5 <= -0.5 and w >= 0.5:
            return "inflow", "5天前还在失血，现在钱掉头猛灌。", "5天前钱还在流出，现在掉头涌进来了。"
        if w5 is not None and w5 >= 0.5 and w <= -0.5:
            return "outflow", "5天前还在吸钱，现在掉头就跑。", "5天前钱还在流入，现在开始往外跑了。"
        if w >= 0.5:
            if isnum(f5) and f5 > 0:
                return "inflow", f"钱突然往里砸：{flow_text(f5)}{rt}。", f"钱突然涌进来：{flow_text(f5)}{rt}。"
            return "inflow", "突然热闹起来，可钱是进是出还没定。", "突然热闹起来，来这里买卖的人变多了。"
        if w <= -0.5:
            if isnum(f5) and f5 < 0:
                return "outflow", f"钱突然往外跑：{flow_text(f5)}{rt}。", f"钱突然往外跑：{flow_text(f5)}{rt}。"
            return "outflow", "突然没人理了，买卖的人一下变少。", "突然冷下来，来这里买卖的人变少了。"
        if w > (w5 if w5 is not None else w):
            return "inflow", "失血止住了，先别急着喊反转。", "之前一直在流出，这几天止住了。"
        return "outflow", "进钱停了，热闹可能到头了。", "之前一直在进钱，这几天停下来了。"
    if d == "level":
        if w >= 0:
            if isnum(f5) and f5 > 0:
                return "inflow", f"钱一直在往里灌：{flow_text(f5)}{rt}。", f"钱一直在涌进来：{flow_text(f5)}{rt}。"
            return "inflow", "一直很热闹，买卖的人比平时多。", "一直很热闹，买卖的人比平时多。"
        if isnum(f5) and f5 < 0:
            return "outflow", f"钱一直在跑，没人拦：{flow_text(f5)}{rt}。", f"钱一直在往外跑：{flow_text(f5)}{rt}。"
        return "outflow", "冷清得没人搭理。", "一直很冷清，买卖的人比平时少。"
    if d == "heat":
        r5 = v.get("ret5")
        if (P["temp"] or 0) >= (P["temp5"] if P["temp5"] is not None else (P["temp"] or 0)):
            if isnum(r5) and r5 > 0.003:
                return "hot", f"突然烧起来了：5天涨了 {pct_abs(r5)}，追的小心烫手。", f"突然热起来了：5天涨了 {pct_abs(r5)}。"
            return "hot", "突然烧起来了，跑得比平时快。", "突然热起来了，跑得比平时快。"
        if isnum(r5) and r5 < -0.003:
            return "cold", f"一下子凉透了：5天跌了 {pct_abs(r5)}，没人接。", f"突然凉下来了：5天跌了 {pct_abs(r5)}。"
        return "cold", "一下子凉透了，跑得比平时慢。", "突然凉下来了，跑得比平时慢。"
    if d == "storm":
        x = times((P["stormV"] or 0) + 1)
        return "storm", f"起风暴了：波动是平时的 {x} 倍，这是过山车。", f"起风暴了：最近波动是平时的 {x} 倍，坐稳。"
    p = round(P["pres"]) if isnum(P["pres"]) else 50
    if p >= 90:
        return "crowded", f"拥挤度 {p}：挤成这样还往里冲的，多半是接最后一棒。", f"拥挤度 {p}：比过去一年 {p}% 的日子都挤。"
    return "quiet", f"拥挤度只有 {p}，被市场忘了——也可能是春天前夜。", f"拥挤度只有 {p}，几乎没人关注，是个洼地。"


def short(sk: str, P: dict, v: dict) -> tuple[str, str]:
    """compact (sharp, mild) phrase for a tour caption after the name."""
    f5, r5 = v["flow5"], v.get("ret5")
    if sk == "crash":
        dd = crash_drop(P.get("crash"), r5)
        lv = crash_level(P.get("crash"))
        return (f"崩了，{dd}" if lv >= 2 else f"急跌，{dd}") if dd else ("崩了" if lv >= 2 else "急跌"), \
            (f"暴跌，{dd}" if lv >= 2 else f"急跌，{dd}") if dd else ("暴跌" if lv >= 2 else "急跌")
    if sk == "front":
        if P["frontV"] > 0:
            m = f"，5天净流入 {money(f5)}" if isnum(f5) and f5 > 0.05 else ""
            return f"风向刚掉头，杀出来了{m}", f"风向刚变，钱开始流入{m}"
        m = f"，5天流出 {money(-f5)}" if isnum(f5) and f5 < -0.05 else ""
        return f"风向刚翻脸，有人在跑{m}", f"风向刚变，钱开始撤离{m}"
    if sk == "spring":
        return f"刚冒芽，{flow_text(f5)}", f"钱刚开始进来，{flow_text(f5)}"
    if sk == "inflow":
        if isnum(f5) and f5 < -0.05:      # busier, but the 5-day money is out: never say 钱在往里砸 next to 净流出
            return f"突然热闹，可{flow_text(f5)}", f"买卖变多了，{flow_text(f5)}"
        return f"钱在往里砸，{flow_text(f5)}", f"钱在流进来，{flow_text(f5)}"
    if sk == "outflow":
        if isnum(f5) and f5 > 0.05:
            return f"突然冷清，可{flow_text(f5)}", f"买卖变少了，{flow_text(f5)}"
        return f"钱在往外跑，{flow_text(f5)}", f"钱在流出，{flow_text(f5)}"
    if sk == "hot":
        return f"突然烧起来，5天涨了 {pct_abs(r5)}", f"突然变热，5天涨了 {pct_abs(r5)}"
    if sk == "cold":
        return f"一下凉透，5天跌了 {pct_abs(r5)}", f"突然变凉，5天跌了 {pct_abs(r5)}"
    if sk == "storm":
        x = times((P["stormV"] or 0) + 1)
        return f"起风暴了，波动是平时的 {x} 倍", f"有风暴，波动是平时的 {x} 倍"
    p = round(P["pres"]) if isnum(P["pres"]) else 50
    if sk == "crowded":
        return f"人挤人（拥挤度 {p}），小心踩踏", f"很挤（拥挤度 {p}）"
    return f"冷清洼地（拥挤度 {p}），没人要", f"没人关注（拥挤度 {p}）"


def tour_kind(sk: str, v: dict) -> str:
    """the 5 tour kinds (front|inflow|outflow|storm|crowded)."""
    if v["front"]:
        return "front"
    if sk == "crash":
        return "storm"          # a crash is the weather's storm (tour.js has no 崩 kind)
    if sk == "storm" or (isnum(v["storm"]) and v["storm"] >= 1.2):
        return "storm"
    if sk == "crowded" or (isnum(v["pres"]) and v["pres"] >= 92):
        return "crowded"
    return "inflow" if (v["wind"] or 0) >= 0 else "outflow"


# ------------------------------------------------------------------------------------------------ data
class Full:
    def __init__(self, i: int | None):
        z = np.load(NPZ, allow_pickle=False)
        self.asOf = str(z["asOf"])
        self.dates = [str(d) for d in z["dates"]]
        self.ids = [str(x) for x in z["ids"]]
        self.col = {x: k for k, x in enumerate(self.ids)}
        self.A = {k: z[k].astype(np.float64) for k in ("wind", "temp", "pres", "storm", "front", "flow", "dv", "idx")}
        z.close()
        L = len(self.dates)
        self.i = L - 1 if i is None else max(0, min(L - 1, i if i >= 0 else L + i))
        self.date = self.dates[self.i]
        self.nodes: dict[str, dict] = {}
        tree = json.loads((FM / "tree.json").read_text(encoding="utf-8"))
        self.root_name = tree.get("name", "全市场")
        self._walk(tree, [], None)

    def _walk(self, n, trail, parent):
        p = trail + [n["id"]]
        if n["id"] not in self.nodes:
            self.nodes[n["id"]] = {"raw": n, "pathIds": p, "parent": parent}
        for c in n.get("children") or []:
            self._walk(c, p, n["id"])

    def crash(self, nid: str, k: int):
        """暴跌闸门 at day i on the map's own idx (rounded to 2 decimals, as the maps / words.crashAt read it). On the
        last day the fm tree's now.crash (compute_full, what brief.py's Radar reads) wins if it says otherwise."""
        i = self.i
        seg = self.A["idx"][max(0, i - (CG.SIG_DAYS + 8)): i + 1, k]
        px = [round(float(x), 2) if np.isfinite(x) else None for x in seg]
        cr = CG.crash_at(px, len(px) - 1)
        if i == len(self.dates) - 1:
            lv = ((self.nodes.get(nid) or {}).get("raw", {}).get("now") or {}).get("crash")
            if isnum(lv) and int(lv) != crash_level(cr):
                cr = {"level": int(lv), "name": CG.NAMES.get(int(lv))} if lv else None
        return cr

    def values(self, nid: str) -> tuple[dict, dict] | None:
        k = self.col.get(nid)
        if k is None:
            return None
        i, A = self.i, self.A
        j = max(0, i - 5)
        g = lambda key, t: (float(A[key][t, k]) if np.isfinite(A[key][t, k]) else None)  # noqa: E731
        w = g("wind", i)
        if w is None:
            return None
        w5, tp, tp5 = g("wind", j), g("temp", i), g("temp", j)
        st, p, f = g("storm", i), g("pres", i), int(A["front"][i, k])
        dw = w - (w if w5 is None else w5)
        cr = self.crash(nid, k)
        sk = season_key(w, dw, p, cr)
        P = {"wind": w, "wind5": w5, "temp": tp, "temp5": tp5, "pres": p, "stormV": st, "frontV": f, "season": sk,
             "crash": cr,
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
        dv = dv[np.isfinite(dv)]
        v = {"wind": w, "temp": tp, "pres": p, "storm": st, "front": f, "flow5": f5, "ret5": r5,
             "dv20": float(dv.mean()) if len(dv) else 0.0,
             "ratio": (abs(f5) / norm) if norm and norm > 0 else None}
        return P, v


def curated_tickers() -> set[str]:
    try:
        s = json.loads((CURATED / "search.json").read_text(encoding="utf-8"))
        return {e["id"] for e in s if str(e.get("id", "")).startswith("s:")}
    except Exception:  # noqa: BLE001
        return set()


def foreign_tickers() -> set[str]:
    out = set()
    try:
        def walk(n):
            for s in n.get("stocks", []):
                if s.get("country") not in (None, "", "United States", "Puerto Rico"):
                    out.add("s:" + s["t"])
            for c in n.get("children", []):
                walk(c)
        walk(json.loads(UNIVERSE.read_text(encoding="utf-8")))
    except Exception:  # noqa: BLE001
        pass
    return out


def r(x, nd=2):
    return round(float(x), nd) if isnum(x) else None


# ------------------------------------------------------------------------------------------------ main
def build(F: Full, k_items: int = K_ITEMS) -> dict:
    curated = curated_tickers()
    foreign = foreign_tickers()
    N = F.nodes
    name = lambda nid: N[nid]["raw"].get("name", nid) if nid in N else nid  # noqa: E731

    def industry(nid: str) -> str:
        """fold cap tiers into their parent industry; a stock belongs to its (folded) leaf region."""
        n = N[nid]
        if n["raw"].get("kind") == "stock":
            nid = n["parent"]
            n = N[nid]
        return n["parent"] if n["raw"].get("tier") else nid

    pool, skipped = [], {"inCurated": 0, "estimated": 0, "stale": 0, "illiquid": 0, "noData": 0}
    for nid, n in N.items():
        raw = n["raw"]
        if raw.get("depth", 0) < 1:
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
        if v["dv20"] < MIN_DV:
            skipped["illiquid"] += 1
            continue
        intl = nid in foreign
        rank = (P["score"] + (0.3 if (P["frontV"] or P["season"] == "spring") else 0.0)) * (0.9 if intl else 1.0)
        pool.append({"id": nid, "P": P, "v": v, "rank": rank, "stock": is_stock, "intl": intl,
                     "ind": industry(nid), "sector": n["pathIds"][1] if len(n["pathIds"]) > 1 else nid})
    pool.sort(key=lambda c: -c["rank"])

    chosen: list[dict] = []
    used_ind, per_sector, per_story = set(), {}, {}
    # pass 1: big enough for a spotlight/tour, ≤ 4 of one story; pass 2: down to $5M; pass 3: any story
    for min_dv, story_cap in ((SPOT_DV, KIND_CAP), (MIN_DV, KIND_CAP), (MIN_DV, k_items)):
        for c in pool:
            if len(chosen) >= k_items:
                break
            if c["v"]["dv20"] < min_dv or any(c is o for o in chosen):
                continue
            if c["ind"] in used_ind or per_sector.get(c["sector"], 0) >= PER_SECTOR:
                continue
            if c["stock"] and sum(1 for o in chosen if o["stock"]) >= MAX_STOCKS:
                continue
            pi = N[c["id"]]["pathIds"]
            if any(o["id"] in pi or c["id"] in N[o["id"]]["pathIds"] for o in chosen):
                continue
            c["said"] = c.get("said") or story(c["P"], c["v"], c["id"])
            sk = c["said"][0]
            if per_story.get(sk, 0) >= story_cap:
                continue
            chosen.append(c)
            used_ind.add(c["ind"])
            per_sector[c["sector"]] = per_sector.get(c["sector"], 0) + 1
            per_story[sk] = per_story.get(sk, 0) + 1

    items = []
    for c in chosen:
        n, P, v = N[c["id"]], c["P"], c["v"]
        raw = n["raw"]
        sk, sharp, mild = c["said"]
        cs, cm = short(sk, P, v)
        nm = raw.get("name") or c["id"]
        ind = c["ind"]
        container = ind if (c["stock"] or raw.get("tier")) else (n["parent"] or "")
        parent_name = name(container) if container and container != "world" else F.root_name
        who = f"{parent_name}里的【{nm}】" if parent_name and parent_name != F.root_name else f"【{nm}】"
        it = {
            "id": c["id"], "name": nm, "kind": "stock" if c["stock"] else "region",
            "story": sk, "tourKind": tour_kind(sk, v),
            "score": r(P["score"]), "base": r(P["base"]), "springBonus": r(P["spring"]), "rank": r(c["rank"]),
            "wind": r(v["wind"]), "dw5": r(P["dw"]), "temp": r(v["temp"]),
            "pres": round(v["pres"]) if isnum(v["pres"]) else None, "storm": r(v["storm"]), "front": v["front"],
            "flow5": r(v["flow5"], 1), "ret5": r(v["ret5"], 4), "dv20": r(v["dv20"], 1),
            "ratio": r(v["ratio"], 1),
            "season": {"key": P["season"], **SEASONS[P["season"]]} if P["season"] in SEASONS else None,
            "crash": crash_level(P.get("crash")),
            "crashInfo": ({k: P["crash"][k] for k in ("level", "name", "r1", "r5", "by") if k in P["crash"]}
                          if isinstance(P.get("crash"), dict) else None),
            "parentId": ind, "parentName": parent_name, "industry": {"id": ind, "name": name(ind)},
            "sector": {"id": c["sector"], "name": name(c["sector"])},
            "path": " › ".join(name(x) for x in n["pathIds"][1:-1]) or F.root_name,
            "pathIds": list(n["pathIds"]),
            "why": sharp, "whyMild": mild,
            "caption": fit(f"{LABEL}：{who}{cs}。", f"{LABEL}：【{nm}】{cs}。", f"【{nm}】{cs}。"),
            "captionMild": fit(f"{LABEL}：{who}{cm}。", f"{LABEL}：【{nm}】{cm}。", f"【{nm}】{cm}。"),
            "spotlightOk": v["dv20"] >= SPOT_DV, "tourOk": v["dv20"] >= SPOT_DV,
            "map": "full", "label": LABEL, "inCurated": False,
        }
        if raw.get("emoji"):
            it["emoji"] = raw["emoji"]
        if c["stock"]:
            it["ticker"] = raw.get("ticker") or c["id"][2:]
            if isnum(raw.get("cap")):
                it["cap"] = raw["cap"]
        if raw.get("tier"):
            it["tier"] = True
        if c["intl"]:
            it["intl"] = True
        items.append(it)

    curated3 = None
    try:
        b = json.loads((CURATED / "brief.json").read_text(encoding="utf-8"))
        sp = [s for s in b.get("spotlight") or [] if not s.get("radar")]
        if b.get("asOf") == F.date and len(sp) >= 3 and isnum(sp[2].get("score")):
            curated3 = sp[2]["score"]
    except Exception:  # noqa: BLE001
        pass
    for it in items:
        it["beatsCurated"] = None if curated3 is None else bool(it["score"] >= curated3 + 0.5)
    ok = [it for it in items if it["spotlightOk"]]
    return {
        "asOf": F.date, "generatedAt": datetime.now().isoformat(timespec="seconds"), "map": "full", "label": LABEL,
        "rules": "surprise §6 + 🌱+0.5; dv20≥$5M (spotlight/tour ≥$20M); tiers folded into parent industry, "
                 "1 per industry, ≤2 per sector, no nesting, ≤7 stocks, ≤4 per story; curated stocks / estimates / stale skipped; "
                 "brief: ≤1 of 3 spotlights and 1–2 of 5 tour stops, only if score ≥ curated #3 + 0.5",
        "curated3": curated3,
        "spotlight": ok[0]["id"] if ok else None,
        "tour": [it["id"] for it in ok[:2]],
        "items": items,
        "stats": {"pool": len(pool), **skipped},
    }


def write_json(path: Path, obj) -> None:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(s, encoding="utf-8")
    os.replace(tmp, path)


def write_stock_fallbacks(items: list[dict]) -> int:
    """Static stocks/<T>.json for the candidate stocks, so the radar's stocks open even before server.py has the
    lazy /data/fm/stocks/ route. Files of earlier candidates are removed."""
    sys.path.insert(0, str(HERE))
    import stockfile
    d = FM / "stocks"
    want = {it["ticker"] for it in items if it.get("ticker")}
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
                 f"rank {it['rank']:>5}  dv20 {it['dv20']:>8}  ‹{it['path']}›")
        L.append(f"       {it['why']}")
        L.append(f"       巡航：{it['caption']}")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="全市场雷达 → web/data/fm/candidates.json")
    ap.add_argument("--i", type=int, default=None, help="date index (default: last day; negative counts back)")
    ap.add_argument("--k", type=int, default=K_ITEMS)
    ap.add_argument("--print", dest="show", action="store_true")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--no-stocks", action="store_true", help="skip the static stock fallback files")
    a = ap.parse_args(argv)
    if not NPZ.exists() or not (FM / "tree.json").exists():
        print("attention_candidates: run fullmarket/compute_full.py first", file=sys.stderr)
        return 1
    F = Full(a.i)
    c = build(F, a.k)
    bad = [it["id"] for it in c["items"] for s in (it["why"], it["whyMild"], it["caption"], it["captionMild"])
           if any(han_len(p) > 28 for p in re.split(r"[。！？]", s))]
    if bad:
        print(f"attention_candidates: ⚠ long sentence(s): {bad}", file=sys.stderr)
    if a.show:
        print(pretty(c))
    if not a.no_write:
        write_json(FM / "candidates.json", c)
        n = 0 if a.no_stocks or a.i is not None else write_stock_fallbacks(c["items"])
        print(f"[candidates] {FM / 'candidates.json'}: {len(c['items'])} items for {c['asOf']}, "
              f"spotlight {c['spotlight']}, {n} stock file(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
