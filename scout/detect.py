"""scout/detect.py — look at today's data and decide what is worth sending Claude to check (DESIGN §15).

Reads (all optional except tree.json; anything missing is skipped with a log line):
  web/data/tree.json, meta.json, brief.json (spotlight), maps/*.json, stocks/*.json,
  universe/universe.json, web/data/graph/edges.json + graph/raw/*.json + web/data/graph/<T>.json,
  intel events (intel.store / web/data/intel.json / intel/out/intel.json) and scout/out/intel_events.json.

Candidates → {"kind","target","question","priority","key","keys","why","context"}; priority = attention:
  explain  front ≠ 0, storm ≥ 1.5 or |wind| ≥ 2.5 at depth ≥ 2, or any spotlight item, with no intel on
           it (or its ancestors/descendants) in the last 3 days. priority = §6 surprise (+0.5 for 🌱春,
           +0.3 spotlight, +0.2 big storm). A flagged region swallows its flagged children (one task, not five).
           The owner's holdings (universe/holdings.json, §20) trigger on any front, storm ≥ 0.8 or |wind| ≥ 1.5
           and get +10 priority, so the automatic budget goes to the owner's money first.
  A kind whose automatic cap in scout/config.json is 0 is not detected at all.
  gap      estimated graph edges (est / inferred / no money) with conf < 0.5, biggest money first.
  verify   tickers that vanished from the map (in universe, not in tree), stocks with zero volume for N days,
           graph money larger than the payee's revenue.
Dedupe: a key asked in the last 3 days (failed: 6 h) or already queued is dropped.

CLI: python3 scout/detect.py [--json] [--all]   (prints candidates; does not enqueue — queue.py does)
"""
from __future__ import annotations

import os
import sys

if __name__ == "__main__" and __package__ in (None, ""):
    _here = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or ".") == _here:
        sys.path[0] = os.path.dirname(_here)          # scout/queue.py must not shadow stdlib queue

import json  # noqa: E402
import math  # noqa: E402

from scout import log as slog  # noqa: E402
from scout.common import (OUT, ROOT, WEB_DATA, Tree, age_hours, load_config, load_tree, node_series,  # noqa: E402
                          num, read_json, say, stock_file, surprise, wind_word)

SCOUT_INTEL = OUT / "intel_events.json"


# ── inputs ──────────────────────────────────────────────────────────────────────────────────────

def intel_events() -> list[dict]:
    evs: list[dict] = []
    try:
        from intel import store as istore                       # owned by the intel agent
        evs += [e for e in istore.load() if isinstance(e, dict)]
    except Exception as e:                                      # noqa: BLE001
        say(f"detect: intel.store not usable ({e.__class__.__name__}); reading intel files directly")
        for p in (WEB_DATA / "intel.json", ROOT / "intel" / "out" / "intel.json"):
            d = read_json(p, [])
            if isinstance(d, dict):
                d = d.get("events", [])
            if isinstance(d, list):
                evs += [e for e in d if isinstance(e, dict)]
    d = read_json(SCOUT_INTEL, [])
    if isinstance(d, list):
        evs += [e for e in d if isinstance(e, dict)]
    return evs


def explained_ids(tree: Tree, days: float) -> set[str]:
    """Node ids that got intel (from the owner or a scout) in the last `days`."""
    ids: set[str] = set()
    for e in intel_events():
        h = min(age_hours(e.get("addedAt")), age_hours(e.get("eventDate")) if e.get("source") != "scout" else 1e9)
        if h > days * 24:
            continue
        for im in e.get("impacts") or []:
            if isinstance(im, dict) and im.get("id"):
                ids.add(im["id"])
        tgt = (e.get("scout") or {}).get("target")
        if tgt:
            ids.add(tgt)
    return ids


def graph_edges() -> list[dict]:
    out: list[dict] = []
    p = WEB_DATA / "graph" / "edges.json"
    d = read_json(p)
    if isinstance(d, dict):
        d = d.get("edges")
    if isinstance(d, list):
        out += [e for e in d if isinstance(e, dict)]
    raw_dir = ROOT / "graph" / "raw"
    if raw_dir.is_dir():
        for f in sorted(raw_dir.glob("*.json")):
            d = read_json(f)
            if isinstance(d, dict):
                d = d.get("edges")
            if isinstance(d, list):
                out += [e for e in d if isinstance(e, dict)]
    if not out:
        say("detect: no graph edges yet (web/data/graph/edges.json, graph/raw/) — gap/verify on graph skipped")
    return out


def company_revenue_b(ticker: str) -> float | None:
    d = read_json(WEB_DATA / "graph" / f"{ticker}.json")
    if not isinstance(d, dict):
        return None
    for k in ("revenueB", "revenue_b"):
        v = num(d.get(k)) or num((d.get("facts") or {}).get(k))
        if v:
            return v
    return None


# ── detectors ───────────────────────────────────────────────────────────────────────────────────

def holdings() -> set[str]:
    """DESIGN §20: the owner's holdings (universe/holdings.json) → node ids like 's:EXAMPLE'."""
    d = read_json(ROOT / "universe" / "holdings.json", {})
    items = d.get("holdings") if isinstance(d, dict) else d
    out = set()
    for h in items or []:
        t = (h.get("t") or h.get("ticker")) if isinstance(h, dict) else h
        if isinstance(t, str) and t.strip():
            out.add("s:" + t.strip().upper().replace(".", "-"))
    return out


HOLDING_BONUS = 10.0     # §20 / §21: automatic budget goes to the owner's money first, then by surprise


def detect_explain(tree: Tree, cfg: dict, spotlight: dict[str, str]) -> list[dict]:
    dc = cfg["detect"]
    cache: dict = {}
    explained = explained_ids(tree, float(dc.get("explain_intel_days", 3)))
    held = holdings()
    cands: dict[str, dict] = {}
    for nid, n in tree.nodes.items():
        now = n.get("now") or {}
        if not now:
            continue
        stock = n.get("kind") == "stock"
        w, st, fr = num(now.get("wind")) or 0.0, num(now.get("storm")) or 0.0, int(num(now.get("front")) or 0)
        trig: list[tuple[str, str]] = []          # (why for the prompt, phrase for the question)
        if nid in held:
            # a holding: a front, any storm or a strong wind is enough (§20), whatever its priority
            if fr:
                trig.append(("你的持仓：风向刚变：" + ("钱开始流入" if fr > 0 else "钱开始撤离"),
                             "突然转成钱流入" if fr > 0 else "突然转成钱撤离"))
            if st >= 0.8:
                trig.append((f"你的持仓：风暴 {st:.1f}，波动突然变大", "突然起风暴、波动变大"))
            if abs(w) >= 1.5 and not trig:
                trig.append((f"你的持仓：风 {w:+.1f}，{wind_word(w)}", wind_word(w)))
        elif not stock and int(n.get("depth") or 0) >= int(dc.get("explain_min_depth", 2)):
            if fr:
                trig.append(("风向刚变：钱开始流入", "突然转成钱流入") if fr > 0 else ("风向刚变：钱开始撤离", "突然转成钱撤离"))
            if st >= float(dc.get("explain_min_storm", 1.5)):
                trig.append((f"风暴 {st:.1f}，波动突然变得很大", "突然起风暴、波动变大"))
            if abs(w) >= float(dc.get("explain_min_abs_wind", 2.5)):
                trig.append((f"风 {w:+.1f}，{wind_word(w)}", wind_word(w)))
        elif stock and abs(w) >= float(dc.get("explain_min_abs_wind", 2.5)) and st >= float(dc.get("explain_min_storm", 1.5)):
            trig.append((f"风 {w:+.1f}（{wind_word(w)}）还起了风暴 {st:.1f}", f"{wind_word(w)}还起风暴"))
        if nid in spotlight:
            trig.append((f"今天的聚光灯：{spotlight[nid]}".rstrip("：。"), "今天上了聚光灯"))
        if not trig:
            continue
        s = node_series(tree, nid, cache)
        pr = surprise(s) + (0.3 if nid in spotlight else 0) + (0.2 if st >= 1.5 else 0)
        if stock and nid not in held:
            pr *= 0.8
        if nid in held:
            pr += HOLDING_BONUS
        cands[nid] = {"kind": "explain", "target": {"type": "node", "id": nid}, "priority": round(pr, 3),
                      "key": f"explain:{nid}", "why": "；".join(t[0] for t in trig), "q": trig[0][1], "context": {}}
    # a flagged region swallows its flagged descendants
    flagged = set(cands)
    merge_into = {}
    for nid in flagged - held:
        anc = [a for a in tree.ancestors(nid) if a in flagged]    # nearest first → last = farthest
        if anc:
            merge_into[nid] = anc[-1]
    for nid, top in sorted(merge_into.items(), key=lambda kv: -cands[kv[0]]["priority"]):
        c = cands.pop(nid)
        tc = cands[top]
        tc["context"].setdefault("children_flagged", []).append(f"{tree.get(nid).get('name')}（{c['why']}）")
        tc.setdefault("keys", []).append(c["key"])
        tc["priority"] = round(tc["priority"] + min(0.1, c["priority"] * 0.05), 3)
    out = []
    for nid, c in cands.items():
        rel = {nid, *tree.ancestors(nid), *tree.descendants(nid)} - {"world"}
        rel -= {a for a in tree.ancestors(nid) if int((tree.get(a) or {}).get("depth") or 0) < 2}
        if nid in held:
            rel = {nid}                     # only intel about the holding itself counts as "already explained"
        if rel & explained:
            say(f"detect: skip explain {nid} — intel in the last {dc.get('explain_intel_days', 3)} days already covers it")
            continue
        kids = c["context"].get("children_flagged") or []
        c["context"]["children_flagged"] = kids[:6]
        c["question"] = f"为什么「{tree.path_names(nid)}」{c.pop('q')}？发生了什么？"
        out.append(c)
    return out


def detect_gap(tree: Tree | None, cfg: dict, edges: list[dict]) -> list[dict]:
    dc = cfg["detect"]
    seen: dict[str, dict] = {}
    for e in edges:
        if e.get("type") == "competes":
            continue
        a, b = str(e.get("a") or "").upper(), str(e.get("b") or "").upper()
        if not a or not b:
            continue
        m = e.get("money") if isinstance(e.get("money"), dict) else None
        usd = num((m or {}).get("usdB"))
        est = bool(e.get("est")) or bool(e.get("inferred")) or usd is None
        conf = num(e.get("conf"))
        conf = 0.0 if (usd is None and conf is None) else (0.4 if conf is None else conf)
        if not est or conf >= float(dc.get("gap_max_conf", 0.5)) or e.get("source") in ("owner", "scout"):
            continue
        strength = num(e.get("strength")) or 1
        pr = 0.6 + 0.35 * math.log1p(usd or strength * 2) + 0.15 * strength + 0.3 * (1 - conf)
        key = f"gap:{a}>{b}:{e.get('type') or 'buys-from'}"
        if key in seen and seen[key]["priority"] >= pr:
            continue
        frm = (m or {}).get("from") or a
        to = (m or {}).get("to") or b
        what = (m or {}).get("what") or e.get("what") or ""
        seen[key] = {"kind": "gap", "priority": round(pr, 3), "key": key,
                     "target": {"type": "edge", "a": frm, "b": to, "what": what, "edgeType": e.get("type") or "buys-from",
                                "current": {"money": m, "est": est, "conf": conf, "basis": e.get("basis")}},
                     "why": f"估算的关系，把握只有 {conf:.1f}", "question": f"{frm} 一年付给 {to} 多少钱（{what or '主要采购'}）？"}
    return sorted(seen.values(), key=lambda c: -c["priority"])[: int(dc.get("gap_max_per_run", 3))]


def detect_verify(tree: Tree, cfg: dict, edges: list[dict]) -> list[dict]:
    dc = cfg["detect"]
    out: list[dict] = []
    # 1) tickers in the universe that the map lost
    uni = read_json(ROOT / "universe" / "universe.json")
    lost: dict[str, str] = {}
    if isinstance(uni, dict) and tree.source == "web/data/tree.json":
        u = Tree(uni, "universe")
        for sid in u.nodes:
            if sid.startswith("s:") and sid not in tree.nodes and not stock_file(sid[2:]).exists():
                lost[sid[2:]] = "在股票清单里，但地图上没有它的价格数据（下载失败？）"
    # 2) zero volume for N days (stopped trading / forward-filled)
    nzero = int(dc.get("verify_zero_volume_days", 3))
    for sid in tree.nodes:
        if not sid.startswith("s:"):
            continue
        d = read_json(stock_file(sid[2:]))
        if not isinstance(d, dict):
            continue
        v = d.get("v") or []
        tail = [num(x) for x in v[-nzero:]]
        if len(tail) == nzero and all((x or 0) == 0 for x in tail):
            last_trade = next((d["dates"][i] for i in range(len(v) - 1, -1, -1) if (num(v[i]) or 0) > 0), None) \
                if isinstance(d.get("dates"), list) and len(d["dates"]) == len(v) else None
            lost[sid[2:]] = f"连续 {nzero} 天成交量为 0" + (f"，最后一次有成交是 {last_trade}" if last_trade else "")
    if lost:
        tick = sorted(lost)
        b = int(dc.get("verify_batch", 8))
        for i in range(0, len(tick), b):
            chunk = tick[i:i + b]
            out.append({"kind": "verify", "priority": round(1.5 + 0.05 * len(chunk), 3),
                        "key": "verify:tickers:" + ",".join(chunk), "keys": [f"verify:ticker:{t}" for t in chunk],
                        "target": {"type": "tickers", "tickers": chunk, "details": {t: lost[t] for t in chunk}},
                        "why": "这些代码突然没数据了：" + "、".join(chunk),
                        "question": f"{'、'.join(chunk)} 这些股票代码为什么没数据了？改名、退市、被并购，还是数据源问题？"})
    # 3) graph money bigger than the payee's whole revenue
    for e in edges:
        m = e.get("money") if isinstance(e.get("money"), dict) else None
        usd = num((m or {}).get("usdB"))
        to = str((m or {}).get("to") or "").upper()
        if usd and to:
            rev = company_revenue_b(to)
            if rev and usd > rev * 1.05:
                key = f"verify:edge:{(m or {}).get('from')}>{to}"
                out.append({"kind": "verify", "priority": 1.8, "key": key,
                            "target": {"type": "edge", "a": (m or {}).get("from"), "b": to, "what": (m or {}).get("what")},
                            "why": f"关系网里 {(m or {}).get('from')}→{to} 的钱（{usd} 十亿美元）比 {to} 全年收入（{rev}）还多",
                            "question": f"{(m or {}).get('from')} 每年真的付给 {to} {usd} 十亿美元吗？{to} 全年收入才 {rev} 十亿。"})
    return out


# ── main entry ──────────────────────────────────────────────────────────────────────────────────

def detect(cfg: dict | None = None, include_seen: bool = False) -> list[dict]:
    """All candidate tasks, highest priority first, deduped against the log and the live queue."""
    cfg = cfg or load_config()
    tree = load_tree()
    if not tree or tree.source != "web/data/tree.json":
        say("detect: web/data/tree.json not found — nothing to look at yet")
        return []
    brief = read_json(WEB_DATA / "brief.json")
    spotlight: dict[str, str] = {}
    if isinstance(brief, dict):
        spotlight = {x["id"]: str(x.get("why") or "") for x in (brief.get("spotlight") or [])
                     if isinstance(x, dict) and x.get("id")}
    else:
        say("detect: no brief.json yet — spotlight bonus skipped")
    kc = cfg.get("kind_caps") or {}
    off = {k for k in ("explain", "gap", "verify") if kc.get(k) is not None and int(kc[k]) <= 0}
    if off:
        say(f"detect: automatic {'/'.join(sorted(off))} is off (kind_caps = 0; owner rule DESIGN §21) — not queued")
    edges = graph_edges() if not {"gap", "verify"} <= off else []
    cands = ((detect_explain(tree, cfg, spotlight) if "explain" not in off else [])
             + (detect_gap(tree, cfg, edges) if "gap" not in off else [])
             + (detect_verify(tree, cfg, edges) if "verify" not in off else []))
    if not include_seen:
        seen = slog.keys_seen(float(cfg.get("dedupe_days", 3)), float(cfg.get("retry_failed_after_h", 6)))
        try:
            from scout import queue as squeue
            seen |= squeue.active_keys()
        except Exception as e:                                  # noqa: BLE001
            say(f"detect: queue not readable ({e}); deduping against the log only")
        kept = []
        for c in cands:
            ks = {c["key"], *(c.get("keys") or [])}
            if ks & seen:
                continue
            kept.append(c)
        if len(kept) < len(cands):
            say(f"detect: {len(cands) - len(kept)} candidate(s) already asked recently or queued")
        cands = kept
    cands.sort(key=lambda c: -c["priority"])
    return cands


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="list scout candidates (does not enqueue)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--all", action="store_true", help="include ones already asked recently")
    a = ap.parse_args(argv)
    c = detect(include_seen=a.all)
    if a.json:
        print(json.dumps(c, ensure_ascii=False, indent=1))
    else:
        for x in c:
            print(f"{x['priority']:5.2f}  {x['kind']:7s} {x['key']:40s} {x.get('question', '')}")
        print(f"{len(c)} candidate(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
