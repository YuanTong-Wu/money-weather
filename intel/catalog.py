"""intel/catalog.py — which territory ids exist, how to name them to Claude, how to repair bad ids,
and what today's measured weather says about a territory (for the "already priced in?" check).

The tree is re-read on every ingest (never cached across runs), so the moment the real
web/data/tree.json replaces the sample, intel uses it. Source preference:
  web/data/tree.json  >  universe/universe.json  >  universe/parts/*.json (+ the fixed continents)
— tree.json (what the map draws) wins unless it has < 90% of the regions of the biggest candidate.
"""
from __future__ import annotations

import difflib
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "pipeline") not in sys.path:
    sys.path.append(str(ROOT / "pipeline"))      # appended, so nothing in pipeline/ can shadow our own modules
try:
    import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 brief.py、words.js crashAt 同一条规则
except ImportError:          # a code-only sandbox without pipeline/ (scout/selftest.py copies scout/ + intel/ only)
    class CG:                # noqa: N801 — same API, never gates; the real tree always has pipeline/crashgate.py
        SIG_DAYS, NAMES = 60, {1: "急跌", 2: "崩"}
        crash_at = staticmethod(lambda px, t: None)
        gate_key = staticmethod(lambda key, crash, p: key)
        series_px = staticmethod(lambda s: None)
WEB_DATA = ROOT / "web" / "data"

# Fixed continent ids from DESIGN.md §1 (used only when assembling from universe/parts).
US_CONTINENTS = [
    ("ai-compute", "AI 算力"), ("ai-power", "AI 电力基建"), ("ai-cloud", "AI 云与平台"),
    ("software", "软件应用"), ("security", "网络安全"), ("media", "通信娱乐"),
    ("robot", "机器人汽车"), ("space", "太空国防"), ("industrial", "工业材料"), ("energy", "能源"),
    ("finance", "金融"), ("health", "医疗"), ("consumer", "消费"), ("realestate", "房地产"),
]
WORLD_CONTINENTS = [("intl", "海外股市"), ("bonds", "债券"), ("commod", "商品"), ("crypto", "加密"),
                    ("cash", "现金避险")]

# Upper-case words that look like tickers but almost always aren't, when written bare.
_NOT_TICKERS = set("""
A I AI IT ON ALL NOW ARE CAN FOR ONE OUT SEE TWO GO BE AM PM US UK EU CEO CFO CTO COO IPO ETF ETFS GDP CPI
PPI PCE FED FOMC USA USD EUR CNY JPY GBP API APIS GPU GPUS CPU CPUS TPU LLM LLMS AGI ASI RSI SEC DOJ FTC
FDA EPA DOE IRS OK NEW BIG ANY HAS HAD WAS THE AND NOT BUT YOU HIS HER ITS OUR WHO WHY HOW TOP LOW HIGH
Q1 Q2 Q3 Q4 H1 H2 YOY QOQ EPS EBIT EBITDA AR VR XR EV EVS HBM DRAM NAND SSD HDD DC AC TV PC PCS IP TAM
SAAS AWS GCP OEM ODM M&A R&D ESG UN NATO OPEC WTI LNG BTC ETH SOL NFT""".split())

_CJK = re.compile(r"[一-鿿]")


@dataclass
class Node:
    id: str
    name: str
    kind: str                         # "region" | "stock"
    depth: int
    tags: list[str] = field(default_factory=list)       # own tags only
    parents: list[str] = field(default_factory=list)    # stocks may sit in 2 places
    children: list[str] = field(default_factory=list)
    ticker: str | None = None
    emoji: str = ""


@dataclass
class Catalog:
    source: str
    nodes: dict[str, Node]
    root: str = "world"

    # ── lookups ──
    def has(self, nid: str) -> bool:
        return nid in self.nodes

    @property
    def regions(self) -> list[Node]:
        return [n for n in self.nodes.values() if n.kind == "region"]

    @property
    def stocks(self) -> list[Node]:
        return [n for n in self.nodes.values() if n.kind == "stock"]

    def ticker_id(self, t: str) -> str | None:
        t = (t or "").strip().upper().lstrip("$").replace(".", "-")
        sid = "s:" + t
        return sid if sid in self.nodes else None

    def ancestors(self, nid: str) -> list[str]:
        """All ancestors over every path (nearest first), excluding the root."""
        out: list[str] = []
        frontier = list(self.nodes[nid].parents) if nid in self.nodes else []
        while frontier:
            nxt = []
            for p in frontier:
                if p in out or p == self.root or p not in self.nodes:
                    continue
                out.append(p)
                nxt.extend(self.nodes[p].parents)
            frontier = nxt
        return out

    def path_names(self, nid: str) -> list[str]:
        names = []
        cur = nid
        seen = set()
        while cur in self.nodes and cur not in seen:
            seen.add(cur)
            names.append(self.nodes[cur].name)
            ps = self.nodes[cur].parents
            cur = ps[0] if ps else None
        return list(reversed(names))

    # ── prompt text ──
    def compact_text(self, tickers_per_leaf: int = 3) -> str:
        """Regions only, one per line, indented by depth: `id 名称 #tags (T1 T2 T3)`."""
        lines: list[str] = []

        def walk(nid: str, depth: int) -> None:
            n = self.nodes[nid]
            if n.kind != "region":
                return
            kids = [self.nodes[c] for c in n.children if c in self.nodes]
            stock_kids = [k for k in kids if k.kind == "stock"]
            # tags: shown only where they differ from the parent's (tree.json repeats inherited tags,
            # and union-style tags on big nodes like world/us are noise)
            ptags = set(self.nodes[n.parents[0]].tags) if n.parents and n.parents[0] in self.nodes else set()
            show = n.tags if (n.tags and set(n.tags) != ptags and len(n.tags) <= 4) else []
            tag = (" " + " ".join("#" + t for t in show)) if show else ""
            ex = ""
            if stock_kids and tickers_per_leaf:
                ex = " (" + " ".join(k.ticker or k.id[2:] for k in stock_kids[:tickers_per_leaf]) + ")"
            if nid != self.root:
                lines.append("  " * max(depth - 1, 0) + f"{n.id} {n.name}{tag}{ex}")
            for k in kids:
                if k.kind == "region":
                    walk(k.id, depth + 1)

        walk(self.root, 0)
        return "\n".join(lines)

    # ── id repair ──
    def repair_id(self, raw: Any) -> str | None:
        """Map whatever the model wrote to a real id, or None. Deterministic, conservative."""
        if not isinstance(raw, str):
            return None
        s = raw.strip().strip("`'\"").strip()
        if not s:
            return None
        if s in self.nodes:
            return s
        # stock forms: s:mu, S:MU, $MU, MU, s_MU, BRK.B
        m = re.fullmatch(r"(?:[sS][:_])?\$?([A-Za-z0-9]{1,6}(?:[.\-][A-Za-z]{1,2})?)", s)
        if m and s.lower() not in self.nodes:
            prefixed = bool(re.match(r"[sS][:_]", s)) or s.startswith("$")
            sid = self.ticker_id(m.group(1))
            if sid and (prefixed or m.group(1) == m.group(1).upper()):
                return sid
        norm = re.sub(r"[\s_]+", "-", s.lower()).strip("-")
        if norm in self.nodes:
            return norm
        # by Chinese / display name (unique)
        by_name = [n.id for n in self.nodes.values() if n.name == s]
        if len(by_name) == 1:
            return by_name[0]
        region_ids = [n.id for n in self.regions if n.id != self.root]
        # token containment: "ai-chips" → the unique shortest region id containing all its tokens
        toks = set(t for t in norm.split("-") if t)
        if toks:
            sup = [r for r in region_ids if toks <= set(r.split("-"))]
            if sup:
                sup.sort(key=len)
                if len(sup) == 1 or len(sup[0]) < len(sup[1]):
                    return sup[0]
        close = difflib.get_close_matches(norm, region_ids, n=2, cutoff=0.82)
        if close:
            return close[0]
        return None

    # ── mentions in free text ──
    def scan_mentions(self, text: str, limit: int = 12) -> list[dict]:
        """Stocks the text probably names: $MU / (MU) / NASDAQ: MU / bare MU / 美光. Hints only."""
        if not text:
            return []
        found: dict[str, int] = {}
        for n in self.stocks:
            t = n.ticker or n.id[2:]
            if not t:
                continue
            esc = re.escape(t)
            strong = re.search(r"(?:\$|\(|（|(?:NASDAQ|NYSE|Nasdaq|Nyse|纳斯达克|纽交所)\s*[:：]\s*)" + esc +
                               r"(?![A-Za-z0-9])", text)
            hit = 0
            if strong:
                hit = 3
            elif len(t) >= 2 and t not in _NOT_TICKERS and re.search(r"(?<![A-Za-z0-9$])" + esc + r"(?![A-Za-z0-9])", text):
                hit = 2 if len(t) >= 3 else 1
            nm = n.name or ""
            if nm and len(_CJK.findall(nm)) >= 2 and nm in text:
                hit = max(hit, 3)
            elif nm and not _CJK.search(nm) and len(nm) >= 4 and nm.upper() != t and \
                    re.search(r"(?<![A-Za-z])" + re.escape(nm) + r"(?![A-Za-z])", text, re.I):
                hit = max(hit, 2)
            if hit:
                found[n.id] = max(found.get(n.id, 0), hit)
        ranked = sorted(found.items(), key=lambda kv: -kv[1])[:limit]
        out = []
        for sid, score in ranked:
            n = self.nodes[sid]
            out.append({"id": sid, "ticker": n.ticker, "name": n.name, "regions": list(n.parents), "score": score})
        return out


# ─────────────────────────────────────────── loading ──────────────────────────────────────────
def _read_json(path: Path) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _add(nodes: dict[str, Node], n: Node, parent: str | None) -> Node:
    if n.id in nodes:
        old = nodes[n.id]
        if parent and parent not in old.parents:
            old.parents.append(parent)
        return old
    if parent:
        n.parents.append(parent)
    nodes[n.id] = n
    return n


def _from_tree(tree: dict) -> dict[str, Node]:
    """web/data/tree.json shape (§3): children nested, stock nodes have kind=stock, id s:T."""
    nodes: dict[str, Node] = {}

    def walk(d: dict, parent: str | None, depth: int) -> None:
        nid = d.get("id")
        if not isinstance(nid, str):
            return
        is_stock = d.get("kind") == "stock" or nid.startswith("s:")
        _add(nodes, Node(id=nid, name=str(d.get("name") or nid), kind="stock" if is_stock else "region",
                             depth=depth, tags=list(d.get("ownTags") or d.get("tags") or []),
                             ticker=d.get("ticker") or (nid[2:] if is_stock else None),
                             emoji=d.get("emoji") or ""), parent)
        if parent and nid not in nodes[parent].children:
            nodes[parent].children.append(nid)
        for c in d.get("children") or []:
            if isinstance(c, dict):
                walk(c, nid, depth + 1)
        for s in d.get("stocks") or []:          # tolerate universe-style leaves too
            if isinstance(s, dict) and s.get("t"):
                walk({"id": "s:" + s["t"], "name": s.get("name") or s["t"], "kind": "stock", "ticker": s["t"],
                      "tags": s.get("tags") or []}, nid, depth + 1)

    walk(tree, None, 0)
    return nodes


def _from_parts(parts_dir: Path) -> dict[str, Node]:
    world = {"id": "world", "name": "地球", "children": []}
    us = {"id": "us", "name": "美股", "children": []}
    found: dict[str, dict] = {}
    for f in sorted(parts_dir.glob("*.json")):
        data = _read_json(f)
        if isinstance(data, dict):
            data = [data]
        for c in data or []:
            if isinstance(c, dict) and isinstance(c.get("id"), str):
                found.setdefault(c["id"], c)
    for cid, name in US_CONTINENTS:
        us["children"].append(found.get(cid) or {"id": cid, "name": name})
    world["children"].append(us)
    for cid, name in WORLD_CONTINENTS:
        world["children"].append(found.get(cid) or {"id": cid, "name": name})
    return _from_tree(world)


def load_catalog() -> Catalog:
    cands: list[tuple[str, dict[str, Node]]] = []
    tree = _read_json(WEB_DATA / "tree.json")
    if isinstance(tree, dict) and tree.get("children"):
        cands.append(("tree", _from_tree(tree)))
    uni = _read_json(ROOT / "universe" / "universe.json")
    if isinstance(uni, dict) and uni.get("children"):
        cands.append(("universe", _from_tree(uni)))
    parts_dir = ROOT / "universe" / "parts"
    if parts_dir.is_dir() and any(parts_dir.glob("*.json")):
        cands.append(("parts", _from_parts(parts_dir)))
    if not cands:
        cands.append(("skeleton", _from_parts(Path("/nonexistent"))))

    def score(c: tuple[str, dict[str, Node]]) -> int:
        return sum(1 for n in c[1].values() if n.kind == "region")

    top = max(score(c) for c in cands)
    # The map's own tree.json wins unless it is clearly a smaller sample (ids must be ones the page draws).
    if cands[0][0] == "tree" and score(cands[0]) >= 0.9 * top:
        best = cands[0]
    else:
        best = max(cands, key=score)
    return Catalog(source=best[0], nodes=best[1])


# ─────────────────────────────────────── measured weather ─────────────────────────────────────
_SEASONS = {"spring": {"key": "spring", "emoji": "🌱", "name": "春"},
            "summer": {"key": "summer", "emoji": "☀️", "name": "夏"},
            "autumn": {"key": "autumn", "emoji": "🍂", "name": "秋"},
            "winter": {"key": "winter", "emoji": "❄️", "name": "冬"}}


def season(w: float, dw: float, p: float, crash: Any = None) -> dict:
    """DESIGN.md §8.2. Returns {key, emoji, name}. crash = crashgate.crash_at(...) result or a tree now.crash level
    (0/1/2): a node falling hard never reads 春 / 夏 / 平稳 (§8 amendment) → 秋 if p ≥ 50, else 冬."""
    k = None
    if w > 0.3 and dw > 0.3 and p < 65:
        k = "spring"
    elif w > 0.3 and p >= 65:
        k = "summer"
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = "autumn"
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = "winter"
    k = CG.gate_key(k, crash, p)
    return dict(_SEASONS[k]) if k in _SEASONS else {"key": "none", "emoji": "", "name": ""}


def _crash_info(cr: Any) -> dict | None:
    """{level, name, r1?, r5?, by?} for the JSON, or None."""
    if isinstance(cr, dict) and cr.get("level"):
        return {k: cr[k] for k in ("level", "name", "r1", "r5", "by") if k in cr}
    if isinstance(cr, (int, float)) and cr:
        return {"level": int(cr), "name": CG.NAMES.get(int(cr), "急跌")}
    return None


def _num(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _last(series: Any, back: int = 0) -> float | None:
    if not isinstance(series, list) or len(series) <= back:
        return None
    for v in reversed(series[: len(series) - back] if back else series):
        f = _num(v)
        if f is not None:
            return f
    return None


def weather_now(cat: Catalog, nid: str, tree_now: dict[str, dict] | None = None) -> dict | None:
    """{wind, dw, pres, temp, season} for a node from web/data, or None if there is no data yet."""
    ser = None
    if nid.startswith("s:"):
        d = _read_json(WEB_DATA / "stocks" / f"{nid[2:]}.json")
        if isinstance(d, dict):
            ser = d
    else:
        d = _read_json(WEB_DATA / "maps" / f"{nid.replace(':', '_')}.json")
        if isinstance(d, dict) and isinstance(d.get("self"), dict):
            ser = d["self"]
        else:
            for p in (cat.nodes[nid].parents if nid in cat.nodes else []):
                d = _read_json(WEB_DATA / "maps" / f"{p.replace(':', '_')}.json")
                if isinstance(d, dict) and isinstance((d.get("children") or {}).get(nid), dict):
                    ser = d["children"][nid]
                    break
    if ser:
        w, w5, p, t = _last(ser.get("wind")), _last(ser.get("wind"), 5), _last(ser.get("pres")), _last(ser.get("temp"))
        if w is not None and p is not None:
            dw = (w - w5) if w5 is not None else 0.0
            px = CG.series_px(ser)
            cr = CG.crash_at(px, len(px) - 1) if isinstance(px, list) and px else None   # 暴跌闸门, last day
            return {"wind": round(w, 2), "dw": round(dw, 2), "pres": round(p), "temp": round(t or 0.0, 2),
                    "season": season(w, dw, p, cr), "crash": _crash_info(cr)}
    now = (tree_now or {}).get(nid)
    if now and _num(now.get("wind")) is not None and _num(now.get("pres")) is not None:
        w, p = float(now["wind"]), float(now["pres"])
        cr = now.get("crash")
        if not isinstance(cr, (int, float)):   # older tree without now.crash: σ unknown, a drop past −5 % → 急跌
            cr = 1 if ((_num(now.get("ret5")) or 0) <= -0.05 or (_num(now.get("ret1")) or 0) <= -0.05) else 0
        return {"wind": round(w, 2), "dw": 0.0, "pres": round(p), "temp": round(float(now.get("temp") or 0), 2),
                "season": season(w, 0.0, p, cr), "crash": _crash_info(cr)}
    return None


def tree_now_index() -> dict[str, dict]:
    tree = _read_json(WEB_DATA / "tree.json")
    out: dict[str, dict] = {}

    def walk(d: dict) -> None:
        if isinstance(d, dict):
            if isinstance(d.get("id"), str) and isinstance(d.get("now"), dict):
                out.setdefault(d["id"], d["now"])
            for c in d.get("children") or []:
                walk(c)

    if isinstance(tree, dict):
        walk(tree)
    return out
