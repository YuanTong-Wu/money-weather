"""Read the generated map data (web/data) and answer the questions the scenario engine needs:
today's weather per node, season (DESIGN §8.2), how much a move is already "priced in", and the
region-to-region return correlation used for propagation.

Pure numbers, no LLM. Shared by engine.py and track.py.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "pipeline") not in sys.path:
    sys.path.append(str(ROOT / "pipeline"))      # appended, so nothing in pipeline/ can shadow our own modules
import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 brief.py、words.js crashAt 同一条规则

LAGS = ["now", "1-3m", "3-12m", "1y+"]
LAG_ZH = {"now": "现在", "1-3m": "1-3 个月", "3-12m": "3-12 个月", "1y+": "1 年以上"}
TIERS = ["弱", "中", "强"]

SEASONS = {
    "spring": {"emoji": "🌱", "name": "春", "now": "钱刚开始进来，还不挤", "next": "可能进入夏天"},
    "summer": {"emoji": "☀️", "name": "夏", "now": "正热、人多", "next": "小心入秋"},
    "autumn": {"emoji": "🍂", "name": "秋", "now": "钱从拥挤处撤离", "next": "可能入冬"},
    "winter": {"emoji": "❄️", "name": "冬", "now": "冷清没人管", "next": "等春天"},
    "none": {"emoji": "", "name": "平", "now": "平稳", "next": ""},
}


def data_dir(override: str | os.PathLike | None = None) -> Path:
    if override:
        return Path(override)
    env = os.environ.get("MW_DATA_DIR")
    if env:
        return Path(env)
    return ROOT / "web" / "data"


def season_key(w: float, dw: float, p: float, crash=None) -> str:
    """DESIGN §8.2, checked in the order of the table. crash = crashgate.crash_at(...) result or a tree
    now.crash level (0/1/2): a node falling hard never reads 春 / 夏 / 平稳 (§8 amendment) → 秋 if p ≥ 50, else 冬."""
    k = "none"
    if w > 0.3 and dw > 0.3 and p < 65:
        k = "spring"
    elif w > 0.3 and p >= 65:
        k = "summer"
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = "autumn"
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = "winter"
    return CG.gate_key(k, crash, p) or "none"


def crash_say(cr) -> str | None:
    """「崩：一天跌了 19.8%」/「急跌：5天跌了 9.3%」 — the exact drop that tripped the gate (words.js crashDrop)."""
    lv = cr.get("level", 0) if isinstance(cr, dict) else (cr or 0)
    if not lv:
        return None
    name = CG.NAMES.get(lv, "急跌")
    if isinstance(cr, dict):
        if cr.get("by") == "r1" and isinstance(cr.get("r1"), (int, float)):
            return f"{name}：一天跌了 {abs(cr['r1']) * 100:.1f}%"
        if isinstance(cr.get("r5"), (int, float)):
            return f"{name}：5天跌了 {abs(cr['r5']) * 100:.1f}%"
    return name


def _arr(xs) -> np.ndarray:
    return np.array([np.nan if v is None else float(v) for v in (xs or [])], dtype=float)


def _num(x, default=0.0) -> float:
    try:
        x = float(x)
        return default if (math.isnan(x) or math.isinf(x)) else x
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------------------------
# priced-in (抢跑度). See scenario/README.md for the reasoning; keep the two in sync.
# ---------------------------------------------------------------------------------------------
SEASON_PRIOR = {
    1: {"summer": 0.85, "autumn": 0.60, "none": 0.45, "spring": 0.30, "winter": 0.15},
    -1: {"winter": 0.85, "autumn": 0.65, "none": 0.45, "spring": 0.25, "summer": 0.15},
}
W_SEASON, W_PRES, W_RET60, W_TEMP = 0.30, 0.30, 0.25, 0.15
STRETCH = 1.0  # >1 spreads values away from 0.5; 1.0 keeps the plain weighted mean


def priced_in(dir_: int, f: dict) -> tuple[float, dict]:
    """How far money and price have already moved the way the scenario says (0..1).

    dir_=+1: crowded (pres), 60-day return high vs its own year, hot, summer → priced in.
    dir_=-1: deserted, 60-day return low vs its own year, cold, winter/autumn → damage priced in.
    """
    d = 1 if dir_ >= 0 else -1
    s = SEASON_PRIOR[d][f["season"]]
    p = f["pres"] / 100.0
    r = f["ret60Pct"]
    t = min(1.0, max(0.0, 0.5 + f["temp"] / 4.0))
    if d < 0:
        p, r, t = 1 - p, 1 - r, 1 - t
    raw = W_SEASON * s + W_PRES * p + W_RET60 * r + W_TEMP * t
    val = min(0.97, max(0.03, 0.5 + STRETCH * (raw - 0.5)))
    parts = {"season": round(s, 2), "pres": round(p, 2), "ret60": round(r, 2), "temp": round(t, 2)}
    return round(val, 2), parts


def priced_word(pi: float, dir_: int) -> dict:
    if pi >= 0.7:
        tag = "已抢跑"
        say = "钱和价格已经按这件事走了一大段" if dir_ > 0 else "已经被卖过一轮，坏消息大多算进去了"
    elif pi >= 0.4:
        tag = "算进去一部分"
        say = "市场算进去了一部分" if dir_ > 0 else "钱已经走了一部分"
    else:
        tag = "⏳ 时间差"
        say = "市场还没按你的日期算" if dir_ > 0 else "市场还没按这个坏消息算，钱还没走"
    return {"tag": tag, "say": say}


class World:
    """Everything read from web/data (tree.json, meta.json, maps/*.json)."""

    def __init__(self, ddir=None):
        self.dir = data_dir(ddir)
        tree_p, meta_p = self.dir / "tree.json", self.dir / "meta.json"
        if not tree_p.exists() or not meta_p.exists():
            raise FileNotFoundError(f"地图数据还没生成：{self.dir}（缺 tree.json 或 meta.json）")
        self.tree = json.loads(tree_p.read_text())
        self.meta = json.loads(meta_p.read_text())
        self.dates: list[str] = self.meta.get("dates") or []
        self.asOf: str = self.meta.get("asOf") or (self.dates[-1] if self.dates else "")
        self.nodes: dict[str, dict] = {}
        self.parent: dict[str, str | None] = {}
        self.path: dict[str, list[str]] = {}
        self.children: dict[str, list[str]] = {}
        self._index(self.tree, None, [])
        self.regions = [i for i, n in self.nodes.items() if n.get("kind") != "stock"]
        self.stocks = [i for i, n in self.nodes.items() if n.get("kind") == "stock"]
        self.series: dict[str, dict] = {}
        self._load_maps()
        self._feat_cache: dict[tuple, dict] = {}
        self._corr = None

    # -- tree ----------------------------------------------------------------------------------
    def _index(self, n, parent, path):
        nid = n["id"]
        p = path + [nid]
        if nid not in self.nodes:  # a duplicated stock keeps its first path
            self.nodes[nid] = n
            self.parent[nid] = parent
            self.path[nid] = p
        kids = n.get("children") or []
        self.children.setdefault(nid, [])
        for c in kids:
            if c["id"] not in self.children[nid]:
                self.children[nid].append(c["id"])
            self._index(c, nid, p)

    def is_leaf_region(self, nid) -> bool:
        n = self.nodes.get(nid) or {}
        kids = self.children.get(nid) or []
        return n.get("kind") != "stock" and bool(kids) and all(
            self.nodes[k].get("kind") == "stock" for k in kids)

    def ancestors(self, nid) -> list[str]:
        return self.path.get(nid, [nid])[:-1]

    def descendants(self, nid) -> list[str]:
        out, stack = [], list(self.children.get(nid, []))
        while stack:
            k = stack.pop()
            out.append(k)
            stack.extend(self.children.get(k, []))
        return out

    def stocks_under(self, nid) -> list[str]:
        if self.nodes.get(nid, {}).get("kind") == "stock":
            return [nid]
        seen, out = set(), []
        for d in self.descendants(nid):
            if self.nodes[d].get("kind") == "stock" and d not in seen:
                seen.add(d)
                out.append(d)
        return out

    def related(self, a, b) -> bool:
        return a in self.path.get(b, []) or b in self.path.get(a, [])

    def name_path(self, nid) -> str:
        return " › ".join(self.nodes[i]["name"] for i in self.path.get(nid, [nid]) if i != "world")

    def dv(self, nid) -> float:
        return max(0.0, _num((self.nodes.get(nid, {}).get("now") or {}).get("dv20"), 0.0))

    # -- series --------------------------------------------------------------------------------
    def _load_maps(self):
        mdir = self.dir / "maps"
        for rid in self.regions:
            fp = mdir / (rid.replace(":", "_") + ".json")
            if not fp.exists():
                continue
            try:
                m = json.loads(fp.read_text())
            except Exception:
                continue
            if m.get("self"):
                self.series[rid] = m["self"]
            for cid, s in (m.get("children") or {}).items():
                self.series.setdefault(cid, s)

    def idx_at(self, date: str) -> int | None:
        """Index of `date` in the current window (or the last date before it)."""
        if not self.dates:
            return None
        if date in self.dates:
            return self.dates.index(date)
        before = [i for i, d in enumerate(self.dates) if d <= date]
        return before[-1] if before else None

    def feat(self, nid, i: int = -1) -> dict:
        """Today's weather for one node (or at index i)."""
        key = (nid, i)
        if key in self._feat_cache:
            return self._feat_cache[key]
        s = self.series.get(nid)
        now = (self.nodes.get(nid) or {}).get("now") or {}
        n = len(self.dates)
        ii = i if i >= 0 else n + i
        est: list[str] = []
        crash = None
        if s:
            wind, temp, pres, idx = _arr(s.get("wind")), _arr(s.get("temp")), _arr(s.get("pres")), _arr(s.get("idx"))
            ii = min(ii, len(wind) - 1)
            w = _num(wind[ii] if ii >= 0 else None, _num(now.get("wind")))
            w5 = _num(wind[ii - 5] if ii >= 5 else None, w)
            t = _num(temp[ii] if ii >= 0 else None, _num(now.get("temp")))
            p = _num(pres[ii] if ii >= 0 else None, _num(now.get("pres"), 50))
            if ii < 0 or ii >= len(pres) or np.isnan(pres[ii]):
                est.append("拥挤度没有读数，用今天的或按 50 估")
            n_ok = int((~np.isnan(idx)).sum())
            if 0 < n_ok < 120:
                est.append(f"只有 {n_ok} 天历史，读数按已有的估")
            ret60, pct = 0.0, 0.5
            if len(idx) > 61 and ii >= 60 and not np.isnan(idx[ii]) and not np.isnan(idx[ii - 60]) and idx[ii - 60] > 0:
                ret60 = idx[ii] / idx[ii - 60] - 1
                hist = idx[60:ii + 1] / idx[:ii + 1 - 60] - 1
                hist = hist[~np.isnan(hist)]
                if len(hist) >= 20:
                    pct = float((hist < ret60).mean() + 0.5 * (hist == ret60).mean())
            ret20 = 0.0
            if ii >= 20 and not np.isnan(idx[ii]) and not np.isnan(idx[ii - 20]) and idx[ii - 20] > 0:
                ret20 = idx[ii] / idx[ii - 20] - 1
            if ret60 == 0.0 and pct == 0.5 and n_ok < 61:
                est.append("历史不到 60 天，60 日涨跌按中间值估")
            px = CG.series_px(s)
            if isinstance(px, list) and px:
                crash = CG.crash_at(px, min(ii, len(px) - 1))
        elif now:  # no series: fall back to tree "now"
            w, t, p = _num(now.get("wind")), _num(now.get("temp")), _num(now.get("pres"), 50)
            w5, ret60, pct, ret20 = w, 0.0, 0.5, _num(now.get("ret20"))
            est.append("没有历史序列，用今天的读数估")
            # tree now.crash (0/1/2, compute.py); an older tree without it: σ unknown, so a drop past the gate's
            # −5 % floor must not read 春 / 夏 (§8 amendment, last sentence) — treat it as 急跌
            if isinstance(now.get("crash"), (int, float)):
                crash = int(now["crash"]) or None
            elif _num(now.get("ret5")) <= -0.05 or _num(now.get("ret1")) <= -0.05:
                crash = 1
        else:  # nothing at all (§14 宁可估，不可空): borrow the parent's weather
            par = self.parent.get(nid)
            if par and par != nid:
                f = dict(self.feat(par, i))
                f["est"] = True
                f["basis"] = "用上一层【" + (self.nodes.get(par, {}).get("name") or par) + "】的天气代替"
                f["hasSeries"] = False
                self._feat_cache[key] = f
                return f
            w = t = 0.0
            p, w5, ret60, pct, ret20 = 50.0, 0.0, 0.0, 0.5, 0.0
            est.append("没有数据，按平常估")
        sk = season_key(w, w - w5, p, crash)
        cs = crash_say(crash)
        f = {"wind": round(w, 2), "dw": round(w - w5, 2), "temp": round(t, 2), "pres": int(round(p)),
             "ret20": round(float(ret20), 4), "ret60": round(float(ret60), 4), "ret60Pct": round(pct, 2),
             "season": sk, "seasonEmoji": SEASONS[sk]["emoji"], "seasonName": SEASONS[sk]["name"],
             "seasonNow": cs or SEASONS[sk]["now"], "seasonNext": SEASONS[sk]["next"],
             "crash": (crash if isinstance(crash, dict) else {"level": crash, "name": CG.NAMES.get(crash)}) if crash else None,
             "hasSeries": bool(s), "est": bool(est), "basis": "；".join(est) if est else None}
        self._feat_cache[key] = f
        return f

    def returns(self, nid) -> np.ndarray | None:
        s = self.series.get(nid)
        if not s:
            return None
        idx = _arr(s.get("idx"))
        if len(idx) < 30:
            return None
        with np.errstate(divide="ignore", invalid="ignore"):
            r = idx[1:] / idx[:-1] - 1
        r[~np.isfinite(r)] = np.nan
        return r

    # -- correlation ---------------------------------------------------------------------------
    def corr(self):
        """(ids, raw corr, market-residual corr) over daily region returns in the window.

        Residual = each region's return minus beta × the "tide" (equal-weight mean of all leaf
        regions), so two regions only look linked if they move together beyond the whole map.
        """
        if self._corr is not None:
            return self._corr
        ids, cols = [], []
        for rid in self.regions:
            if rid == "world":
                continue
            r = self.returns(rid)
            if r is None or np.isnan(r).mean() > 0.3:
                continue
            ids.append(rid)
            cols.append(r)
        if len(ids) < 2:
            self._corr = (ids, np.zeros((len(ids), len(ids))), np.zeros((len(ids), len(ids))))
            return self._corr
        m = np.vstack(cols).T  # days × regions
        m = np.where(np.isnan(m), np.nanmean(m, axis=0, keepdims=True), m)
        leaf_cols = [k for k, rid in enumerate(ids) if self.is_leaf_region(rid)] or list(range(len(ids)))
        tide = m[:, leaf_cols].mean(axis=1)
        tv = tide - tide.mean()
        var = float((tv ** 2).sum()) or 1e-12
        mc = m - m.mean(axis=0)
        beta = (mc * tv[:, None]).sum(axis=0) / var
        resid = mc - np.outer(tv, beta)
        raw = np.corrcoef(mc.T)
        res = np.corrcoef(resid.T)
        raw = np.nan_to_num(raw)
        res = np.nan_to_num(res)
        self._corr = (ids, raw, res)
        return self._corr
