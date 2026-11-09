#!/usr/bin/env python3
"""build_universe.py — merge universe/parts/*.json into universe/universe.json (DESIGN.md §1).

    python3 pipeline/build_universe.py            # real parts in universe/parts/
    python3 pipeline/build_universe.py --sample   # universe/sample.json only (fast smoke test)

The root `world` and the assembled continent `us` are defined here. Part files contain a JSON array of
continent nodes whose ids must be one of the fixed continent ids. Validation is forgiving: problems are
fixed where possible (bad tags dropped, duplicate stocks removed, duplicate ids renamed) and reported as
warnings; one broken part file never stops the build.

§20 holdings (universe/holdings.json, the owner's): each holding is always on the map regardless of any
liquidity rule. Listed by a part → every copy is marked `"holding": true`. Not listed → added to a sensible
leaf region: its own `"region"` id if the holding names one, else the region with the most curated stocks of
the same industry (offline lookup in fullmarket/universe_raw.json / the raw Nasdaq list), else a small
"我的持仓" region under 美股. A non-US symbol (7203.T, 0700.HK) stays for the global map. Ticker corrections
from overrides.json follow the holding. The placed list is published to web/data/holdings.json
({…the owner's file, holdings:[{t, name, note, id, pathIds, path, places, placed:"part"|"holdings"|"fallback"|"global"}],
updatedAt}) whenever the build writes the default universe/universe.json (or --holdings-out says where).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS_DIR = ROOT / "universe" / "parts"
SAMPLE = ROOT / "universe" / "sample.json"
OUT = ROOT / "universe" / "universe.json"
HOLDINGS = ROOT / "universe" / "holdings.json"          # the owner's holdings (§20) — written by the owner
HOLDINGS_OUT = ROOT / "web" / "data" / "holdings.json"  # published copy with where each one sits on the map
FM_RAW = ROOT / "fullmarket" / "universe_raw.json"      # sector / industry of every US listing (offline lookup)
NASDAQ_RAW = ROOT / "fullmarket" / "raw" / "nasdaq_stocks.json"
GLOBAL_SUFFIX = set("HK SS SZ T KS KQ TW TWO NS BO L DE PA AS SW TO V AX NZ SA MX MI MC ST CO OL HE BR LS VI IR "
                    "JK KL SI BK TA IS JO SR F".split())

# (id, name, emoji, part file) — order is the display order
US_CONTINENTS = [
    ("ai-compute", "AI 算力", "ai.json"),
    ("ai-power", "AI 电力基建", "ai.json"),
    ("ai-cloud", "AI 云与平台", "ai.json"),
    ("software", "软件应用", "soft.json"),
    ("security", "网络安全", "soft.json"),
    ("media", "通信娱乐", "soft.json"),
    ("robot", "机器人汽车", "hard.json"),
    ("space", "太空国防", "hard.json"),
    ("industrial", "工业材料", "hard.json"),
    ("energy", "能源", "hard.json"),
    ("finance", "金融", "finhealth.json"),
    ("health", "医疗", "finhealth.json"),
    ("consumer", "消费", "consumer.json"),
    ("realestate", "房地产", "consumer.json"),
]
WORLD_CONTINENTS = [
    ("intl", "海外股市", "world.json"),
    ("bonds", "债券", "world.json"),
    ("commod", "商品", "world.json"),
    ("crypto", "加密", "world.json"),
    ("cash", "现金避险", "world.json"),
]
EXPECTED_PARTS = sorted({p for _, _, p in US_CONTINENTS + WORLD_CONTINENTS})

WORLD = {
    "id": "world",
    "name": "地球",
    "emoji": "🌍",
    "desc": "全世界的钱都在这里流动：股票、债券、商品、加密货币和现金。",
    "tags": [],
}
US = {
    "id": "us",
    "name": "美股",
    "emoji": "🇺🇸",
    "desc": "美国股市，全世界的钱最爱来的地方。",
    "tags": [],
}

TAG_VOCAB = set(
    "ai chip power cloud software security robot ev space defense energy oil clean finance crypto health "
    "biotech consumer china japan europe emerging gold metals rates realestate".split()
)
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TICKER_RE = re.compile(r"^[A-Z0-9]{1,6}(?:-[A-Z]{1,2})?$")
MAX_PLACES = 2


class Report:
    def __init__(self) -> None:
        self.items: list[tuple[str, str]] = []

    def warn(self, kind: str, msg: str) -> None:
        self.items.append((kind, msg))

    def print(self, limit_per_kind: int = 12) -> None:
        if not self.items:
            print("  no warnings")
            return
        by = defaultdict(list)
        for k, m in self.items:
            by[k].append(m)
        for k, msgs in by.items():
            print(f"  [{k}] {len(msgs)} warning(s)")
            for m in msgs[:limit_per_kind]:
                print(f"     - {m}")
            if len(msgs) > limit_per_kind:
                print(f"     … {len(msgs) - limit_per_kind} more")


BROKEN: set[str] = set()


def load_part(path: Path, rep: Report) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        rep.warn("part", f"{path.name}: cannot parse JSON ({e}); skipped")
        BROKEN.add(path.name)
        return []
    if isinstance(data, dict):
        # tolerate {"continents":[…]} or a single continent object
        if isinstance(data.get("continents"), list):
            data = data["continents"]
        elif "id" in data:
            data = [data]
        else:
            rep.warn("part", f"{path.name}: expected an array of continent nodes; skipped")
            return []
    if not isinstance(data, list):
        rep.warn("part", f"{path.name}: expected an array; skipped")
        return []
    out = []
    for n in data:
        if isinstance(n, dict):
            n["_part"] = path.name
            out.append(n)
        else:
            rep.warn("part", f"{path.name}: non-object entry skipped")
    return out


def clean_tags(tags, where: str, rep: Report) -> list[str]:
    if tags is None:
        return []
    if isinstance(tags, str):
        tags = [tags]
    if not isinstance(tags, list):
        rep.warn("tags", f"{where}: tags is not a list; ignored")
        return []
    out = []
    for t in tags:
        t2 = str(t).strip().lower()
        if t2 in TAG_VOCAB:
            if t2 not in out:
                out.append(t2)
        else:
            rep.warn("tags", f"{where}: unknown tag '{t}' dropped")
    return out


def norm_ticker(t: str) -> str:
    return str(t).strip().upper().replace(".", "-").replace("/", "-")


class Builder:
    def __init__(self, rep: Report, strict_counts: bool = True) -> None:
        self.rep = rep
        self.strict_counts = strict_counts
        self.ids: Counter = Counter()
        self.ticker_places: dict[str, list[str]] = defaultdict(list)

    def unique_id(self, nid: str, where: str) -> str:
        if self.ids[nid] == 0:
            self.ids[nid] += 1
            return nid
        k = 2
        while self.ids[f"{nid}-{k}"]:
            k += 1
        new = f"{nid}-{k}"
        self.rep.warn("ids", f"{where}: duplicate id '{nid}' renamed to '{new}'")
        self.ids[new] += 1
        return new

    def node(self, raw: dict, depth: int, where: str) -> dict | None:
        """Clean a continent/region node (depth 2+ relative to world for US continents)."""
        nid = str(raw.get("id", "")).strip()
        if not ID_RE.match(nid):
            fixed = re.sub(r"[^a-z0-9]+", "-", nid.lower()).strip("-")
            if not fixed:
                self.rep.warn("shape", f"{where}: node without usable id skipped")
                return None
            self.rep.warn("ids", f"{where}: id '{nid}' is not kebab-case; using '{fixed}'")
            nid = fixed
        if nid in ("world", "us"):
            self.rep.warn("ids", f"{where}: reserved id '{nid}' renamed")
            nid = nid + "-x"
        here = f"{where}/{nid}"
        nid = self.unique_id(nid, here)
        name = str(raw.get("name") or nid)
        emoji = str(raw.get("emoji") or "")
        if not emoji:
            self.rep.warn("shape", f"{here}: missing emoji")
            emoji = "•"
        desc = str(raw.get("desc") or "")
        if not desc:
            self.rep.warn("shape", f"{here}: missing desc")
        node = {"id": nid, "name": name, "emoji": emoji, "desc": desc,
                "tags": clean_tags(raw.get("tags"), here, self.rep)}
        kids = raw.get("children")
        stocks = raw.get("stocks")
        has_kids = isinstance(kids, list) and len(kids) > 0
        has_stocks = isinstance(stocks, list) and len(stocks) > 0
        if has_kids and has_stocks:
            self.rep.warn("shape", f"{here}: has both children and stocks; stocks moved to a sub-region '其他'")
            kids = list(kids) + [{"id": f"{nid}-other", "name": "其他", "emoji": "•",
                                  "desc": "放在这里的其他股票。", "stocks": stocks}]
            has_stocks = False
        if has_kids:
            if depth >= 5:
                self.rep.warn("shape", f"{here}: tree too deep; children ignored")
                return None
            out_kids = []
            for i, k in enumerate(kids):
                if not isinstance(k, dict):
                    self.rep.warn("shape", f"{here}: non-object child #{i} skipped")
                    continue
                c = self.node(k, depth + 1, here)
                if c is not None:
                    out_kids.append(c)
            if not out_kids:
                self.rep.warn("shape", f"{here}: no usable children; node dropped")
                self.ids[nid] -= 1
                return None
            node["children"] = out_kids
        elif has_stocks:
            out_stocks = []
            seen = set()
            for s in stocks:
                if isinstance(s, str):
                    s = {"t": s}
                if not isinstance(s, dict) or not s.get("t"):
                    self.rep.warn("stocks", f"{here}: stock entry without 't' skipped")
                    continue
                t = norm_ticker(s["t"])
                if t != s["t"]:
                    self.rep.warn("stocks", f"{here}: ticker '{s['t']}' normalised to '{t}'")
                if not TICKER_RE.match(t):
                    self.rep.warn("stocks", f"{here}: ticker '{t}' looks invalid; skipped")
                    continue
                if t in seen:
                    self.rep.warn("dup", f"{here}: {t} listed twice under the same parent; second removed")
                    continue
                if len(self.ticker_places[t]) >= MAX_PLACES:
                    self.rep.warn("dup", f"{here}: {t} already in {self.ticker_places[t]}; extra place removed")
                    continue
                seen.add(t)
                self.ticker_places[t].append(nid)
                note = str(s.get("note") or "")
                if len(note) > 14:
                    self.rep.warn("note", f"{here}: {t} note longer than 14 chars")
                out_stocks.append({
                    "t": t,
                    "name": str(s.get("name") or t),
                    "note": note,
                    "tags": clean_tags(s.get("tags"), f"{here}/{t}", self.rep),
                })
            if not out_stocks:
                self.rep.warn("shape", f"{here}: no usable stocks; node dropped")
                self.ids[nid] -= 1
                return None
            if self.strict_counts and not (4 <= len(out_stocks) <= 12):
                self.rep.warn("count", f"{here}: {len(out_stocks)} stocks (want 4–12)")
            node["stocks"] = out_stocks
        else:
            self.rep.warn("shape", f"{here}: neither children nor stocks; dropped")
            self.ids[nid] -= 1
            return None
        return node


def count_tickers(node: dict, acc: set) -> set:
    for s in node.get("stocks", []):
        acc.add(s["t"])
    for c in node.get("children", []):
        count_tickers(c, acc)
    return acc


def count_regions(node: dict) -> int:
    return sum(1 + count_regions(c) for c in node.get("children", []))


def ticker_renames(rep: Report) -> dict:
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import owner_overrides as ov  # pipeline/owner_overrides.py
        return ov.ticker_renames() or {}
    except Exception as e:  # noqa: BLE001
        rep.warn("overrides", f"could not read overrides.json ({e})")
        return {}


def apply_ticker_overrides(world: dict, rep: Report) -> None:
    """§14 corrections from web/data/overrides.json: field "ticker" on "s:OLD" → fetch/show it as the new
    symbol (renamed / merged); value null → take it off the map (delisted). Owner entries beat scout ones."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import owner_overrides as ov  # pipeline/owner_overrides.py
        ren = ov.ticker_renames()
    except Exception as e:  # noqa: BLE001
        rep.warn("overrides", f"could not read overrides.json ({e}); ticker corrections skipped")
        return
    if not ren:
        return
    done = Counter()

    def walk(n: dict) -> None:
        if "stocks" in n:
            out, seen = [], set()
            for s in n["stocks"]:
                t = s["t"]
                if t in ren:
                    new = ren[t]
                    if new is None:
                        done[f"{t} removed (delisted)"] += 1
                        continue
                    s = {**s, "t": new, "renamedFrom": t}
                    done[f"{t} → {new}"] += 1
                if s["t"] in seen:
                    continue
                seen.add(s["t"])
                out.append(s)
            n["stocks"] = out
        for c in n.get("children", []):
            walk(c)
        if "children" in n:
            n["children"] = [c for c in n["children"] if c.get("stocks") or c.get("children")]

    walk(world)
    for k in done:
        rep.warn("overrides", f"ticker correction applied: {k}")


# ------------------------------------------------------------------------------------- §20 holdings
def load_holdings(path: Path, rep: Report) -> tuple[dict, list[dict]]:
    """universe/holdings.json → (the file as written, [{t, name, note, region?}]). Tolerates a bare list."""
    if not path.exists():
        return {}, []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        rep.warn("holdings", f"{path.name}: cannot parse JSON ({e}); holdings skipped this build")
        return {}, []
    items = raw.get("holdings") if isinstance(raw, dict) else raw
    out, seen = [], set()
    for h in items if isinstance(items, list) else []:
        if isinstance(h, str):
            h = {"t": h}
        if not isinstance(h, dict) or not (h.get("t") or h.get("ticker")):
            rep.warn("holdings", "holding without a ticker skipped")
            continue
        t0 = str(h.get("t") or h.get("ticker")).strip().upper()
        if t0 in seen:
            continue
        seen.add(t0)
        out.append({**h, "t": t0})
    return (raw if isinstance(raw, dict) else {"holdings": items}), out


def _fm_industry_index() -> dict[str, tuple[str, str, str]]:
    """ticker → (sector, industry, short name) from the full-market lists (fullmarket/universe_raw.json, else the
    raw Nasdaq screener). Offline; empty when neither exists."""
    idx: dict[str, tuple[str, str, str]] = {}
    try:
        u = json.loads(FM_RAW.read_text(encoding="utf-8"))
        for s in (u.get("stocks") or []) + (u.get("dropped") or []):
            t = norm_ticker(s.get("t") or "")
            if t and s.get("industry"):
                idx[t] = (s.get("sector") or "", s.get("industry") or "", s.get("short") or s.get("name") or t)
    except Exception:  # noqa: BLE001
        pass
    try:
        r = json.loads(NASDAQ_RAW.read_text(encoding="utf-8"))
        for s in ((r.get("data") or {}).get("rows") or []):
            t = norm_ticker(s.get("symbol") or "")
            if t and t not in idx and s.get("industry"):
                idx[t] = (s.get("sector") or "", s.get("industry") or "", s.get("name") or t)
    except Exception:  # noqa: BLE001
        pass
    return idx


def _leaf_regions(n: dict, path: list[dict]):
    if "stocks" in n:
        yield n, path
    for c in n.get("children", []):
        yield from _leaf_regions(c, path + [n])


def _pick_region(world: dict, h: dict, fm: dict, rep: Report) -> tuple[dict | None, str]:
    """A sensible leaf region for a holding no part file lists: 1) its own `region` id, 2) the region holding
    most curated stocks of the same industry (full-market lists; same sector counts a little), 3) none."""
    leaves = list(_leaf_regions(world, []))
    want = str(h.get("region") or "").strip()
    if want:
        for leaf, _ in leaves:
            if leaf["id"] == want:
                return leaf, f"holdings.json 指定的「{leaf['name']}」"
        rep.warn("holdings", f"{h['t']}: region '{want}' not in the map; choosing one by industry")
    me = fm.get(h["t"])
    if me:
        sec, ind, _ = me
        best, best_score = None, 0.0
        for leaf, path in leaves:
            if any(p["id"] == "my-holdings" for p in path) or leaf["id"] == "my-holdings":
                continue
            sc = 0.0
            for s in leaf["stocks"]:
                o = fm.get(s["t"])
                if not o:
                    continue
                sc += 1.0 if o[1] == ind else (0.25 if sec and o[0] == sec else 0.0)
            sc = sc / (1.0 + 0.02 * len(leaf["stocks"]))  # prefer the tighter region on ties
            if sc > best_score:
                best, best_score = leaf, sc
        if best is not None and best_score >= 0.5:
            return best, f"同行业（{ind}）的公司最多的「{best['name']}」"
    return None, ""


def apply_holdings(world: dict, holdings: list[dict], b: "Builder", rep: Report, ren: dict) -> list[dict]:
    """§20: every holding is on the curated map regardless of liquidity rules. Listed already → marked
    `holding: true` in every place. Not listed → added to a sensible region (_pick_region), else to a small
    "我的持仓" region under 美股. Ticker corrections from overrides.json follow it (renamed → the new symbol).
    Returns the published list (web/data/holdings.json): [{t, name, note, id, pathIds, path, places, placed}]."""
    if not holdings:
        return []
    fm = None
    published = []
    for h in holdings:
        base, _, suf = h["t"].rpartition(".")
        t = h["t"] if base and suf in GLOBAL_SUFFIX else norm_ticker(h["t"])  # 7203.T stays; BRK.B → BRK-B
        entry = {k: v for k, v in h.items() if k not in ("region",)}
        if t in ren:
            if ren[t]:
                rep.warn("holdings", f"{t}: ticker correction → {ren[t]} (overrides.json)")
                entry["renamedFrom"] = t
                t = ren[t]
            else:
                rep.warn("holdings", f"{t}: overrides.json says delisted, but it is your holding — kept on the map")
        entry["t"] = t
        entry["id"] = f"s:{t}"
        if not TICKER_RE.match(t):
            # a non-US listing (e.g. 0700.HK) cannot live on the US-only curated map; the global map (§23) has it
            rep.warn("holdings", f"{t}: not a US symbol — kept in holdings.json for the global map, not on the curated map")
            published.append({**entry, "places": [], "placed": "global"})
            continue
        places = []
        for leaf, path in _leaf_regions(world, []):
            for s in leaf["stocks"]:
                if s["t"] == t:
                    s["holding"] = True
                    places.append((leaf, path))
                    entry.setdefault("name", s.get("name") or t)
        placed = "part"
        if not places:
            if fm is None:
                fm = _fm_industry_index()
            leaf, why = _pick_region(world, {**h, "t": t}, fm, rep)
            if leaf is None:
                us = next((c for c in world.get("children", []) if c["id"] == "us"), None) or world
                leaf = next((c for c in us.get("children", []) if c["id"] == "my-holdings"), None)
                if leaf is None:
                    leaf = {"id": b.unique_id("my-holdings", "holdings"), "name": "我的持仓", "emoji": "⭐",
                            "desc": "你的持仓里地图上还没有的公司，先放这里，天气照样算。", "tags": [], "stocks": []}
                    us.setdefault("children", []).append(leaf)
                why = "没找到同行业的地方，先放进「我的持仓」"
                placed = "fallback"
            else:
                placed = "holdings"
            nm = str(h.get("name") or (fm.get(t) or ("", "", t))[2] or t)
            entry["name"] = nm
            leaf["stocks"].append({"t": t, "name": nm, "note": str(h.get("note") or "你的持仓")[:14], "tags": [],
                                   "holding": True, "addedBy": "holdings"})
            b.ticker_places[t].append(leaf["id"])
            rep.warn("holdings", f"{t}: not in any part file → added to {leaf['id']} ({why})")
            places = [(leaf, p) for lf, p in _leaf_regions(world, []) if lf is leaf]
        leaf0, path0 = places[0]
        ids = [p["id"] for p in path0] + [leaf0["id"]]
        names = [p["name"] for p in path0] + [leaf0["name"]]
        published.append({**entry, "pathIds": ids, "path": names,
                          "places": [[p["id"] for p in pp] + [lf["id"]] for lf, pp in places], "placed": placed})
    return published


def write_holdings(src: dict, published: list[dict], out: Path) -> None:
    obj = {k: v for k, v in src.items() if k != "holdings"}
    obj["holdings"] = published
    obj["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", action="store_true", help="build from universe/sample.json only")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--parts", default=str(PARTS_DIR), help="folder with the part files (default universe/parts)")
    ap.add_argument("--holdings", default=str(HOLDINGS), help="the owner's holdings (default universe/holdings.json)")
    ap.add_argument("--holdings-out", default=None,
                    help="publish the placed holdings here (default web/data/holdings.json when --out is the default)")
    args = ap.parse_args()

    rep = Report()
    if args.sample:
        files = [SAMPLE]
        mode = "sample"
    else:
        files = sorted(Path(args.parts).glob("*.json"))
        mode = "full"
        present = {f.name for f in files}
        for p in EXPECTED_PARTS:
            if p not in present:
                rep.warn("missing", f"part file {p} not found (yet) in {args.parts}")
        for f in files:
            if f.name not in EXPECTED_PARTS:
                rep.warn("part", f"unexpected part file {f.name} (still read)")
    print(f"build_universe [{mode}] reading {len(files)} file(s): {', '.join(f.name for f in files) or '-'}")

    raw_by_id: dict[str, dict] = {}
    for f in files:
        for n in load_part(f, rep):
            cid = str(n.get("id", "")).strip()
            known = {c[0] for c in US_CONTINENTS + WORLD_CONTINENTS}
            if cid not in known:
                rep.warn("continent", f"{f.name}: top-level id '{cid}' is not a known continent id; skipped")
                continue
            if cid in raw_by_id:
                rep.warn("continent", f"{f.name}: continent '{cid}' already defined in "
                                      f"{raw_by_id[cid]['_part']}; second copy ignored")
                continue
            raw_by_id[cid] = n

    # a part file that is broken right now (e.g. half-written) → keep its continents from the last good build
    if BROKEN and not args.sample and OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding="utf-8"))
            if prev.get("_build", {}).get("mode") != "full":
                prev = {}
            prev_nodes = {}
            for c in prev.get("children", []):
                prev_nodes[c["id"]] = c
                if c["id"] == "us":
                    for cc in c.get("children", []):
                        prev_nodes[cc["id"]] = cc
            for cid, _, part in US_CONTINENTS + WORLD_CONTINENTS:
                if part in BROKEN and cid not in raw_by_id and cid in prev_nodes:
                    raw_by_id[cid] = {**prev_nodes[cid], "_part": f"{part} (last good build)"}
                    rep.warn("part", f"{part} is broken: continent '{cid}' kept from the last good build")
        except Exception as e:  # noqa: BLE001
            rep.warn("part", f"could not read the last build for fallback ({e})")

    b = Builder(rep, strict_counts=not args.sample)
    b.ids["world"] += 1
    b.ids["us"] += 1
    for cid, _, _ in US_CONTINENTS + WORLD_CONTINENTS:
        b.ids[cid] += 0  # reserve ordering only

    def build_continent(cid: str, cname: str, depth: int) -> dict | None:
        raw = raw_by_id.get(cid)
        if raw is None:
            if not args.sample:
                rep.warn("missing", f"continent '{cid}' ({cname}) not provided by any part")
            return None
        node = b.node(raw, depth, raw.get("_part", "?"))
        if node is None:
            return None
        if b.strict_counts and not (3 <= len(node.get("children", [])) <= 7) and "children" in node:
            rep.warn("count", f"{cid}: {len(node['children'])} children (want 3–7)")
        if "stocks" in node:
            rep.warn("shape", f"{cid}: continent has stocks directly (expected regions)")
        return node

    us_children = [c for c in (build_continent(cid, nm, 2) for cid, nm, _ in US_CONTINENTS) if c]
    world_children = []
    if us_children:
        world_children.append({**US, "children": us_children})
    else:
        rep.warn("missing", "no US continents at all; 'us' omitted")
    for cid, nm, _ in WORLD_CONTINENTS:
        c = build_continent(cid, nm, 1)
        if c:
            world_children.append(c)

    if not world_children:
        print("ERROR: nothing to build — no usable continents found.", file=sys.stderr)
        rep.print()
        return 2

    world = {**WORLD, "children": world_children}
    apply_ticker_overrides(world, rep)
    # §20 the owner's holdings: always on the map (added to a sensible region if no part lists them)
    h_src, h_items = load_holdings(Path(args.holdings), rep)
    held = apply_holdings(world, h_items, b, rep, ticker_renames(rep) if h_items else {})
    tickers = count_tickers(world, set())
    multi = {t: p for t, p in b.ticker_places.items() if len(p) > 1}
    world["_build"] = {
        "mode": mode,
        "builtAt": datetime.now().isoformat(timespec="seconds"),
        "parts": [f.name for f in files],
        "nTickers": len(tickers),
        "nRegions": count_regions(world),
        "holdings": [{"t": h["t"], "placed": h["placed"], "at": (h.get("pathIds") or [None])[-1]} for h in held],
    }

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(world, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, out)

    print(f"  continents under world: {[c['id'] for c in world_children]}")
    if us_children:
        print(f"  us children: {[c['id'] for c in us_children]}")
    print(f"  regions: {world['_build']['nRegions']}, unique tickers: {len(tickers)}, "
          f"tickers in 2 places: {len(multi)}")
    for h in held:
        print(f"  holding {h['t']}: {' › '.join(h.get('path') or []) or '(global map)'} [{h['placed']}]")
    h_out = Path(args.holdings_out) if args.holdings_out else (HOLDINGS_OUT if out == OUT.resolve() else None)
    if h_out is not None and (h_items or h_src):
        try:
            write_holdings(h_src, held, h_out)
            print(f"  published {len(held)} holding(s) → {h_out.relative_to(ROOT) if h_out.is_relative_to(ROOT) else h_out}")
        except Exception as e:  # noqa: BLE001
            print(f"  WARNING: could not write {h_out}: {e}")
    rep.print()
    print(f"  wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
