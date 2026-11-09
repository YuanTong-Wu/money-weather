"""polymarket/map.py: Chinese translations + Claude mappings for new markets, in as few Claude calls as possible.

    python3 polymarket/map.py              # at most 1 batched `claude -p` call, then rebuild polymarket.json
    python3 polymarket/map.py --max 999    # (the loop's nightly step: until done or the day's points say stop)
    python3 polymarket/map.py --dry-run    # show what would be sent, no call

Every call goes through common/claude_gate.py (automatic work: stops at 4 of the day's 6 weekly-quota points;
MW_PM_OWNER=1 when the owner runs it by hand). Prints CLAUDE_CALLS=<n> at the end for the loop.

Reads polymarket/out/pending.json (written by fetch.py): English strings without a Chinese translation
(event titles, single questions, odd outcome labels; most important first) and high-volume markets
whose rule mapping is missing or low-confidence. One call carries up to --units strings and, on the
first call, up to --map-n mapping candidates. Results are cached:
  polymarket/translations.json  {items: {english: {zh, by, at}}}
  polymarket/mapping.json       {items: {marketId: {nodes:[{id, sign}], none?, why, at}}}
so every later fetch.py run reuses them without spending quota. Owner overrides (web/data/overrides.json,
target "pm:<marketId>") still win over both.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import common as C  # type: ignore
    import translate as TR  # type: ignore
    import llm  # type: ignore
    import fetch  # type: ignore
else:
    from . import common as C
    from . import translate as TR
    from . import llm
    from . import fetch

LAST_BATCH = C.CACHE_DIR / "map_last_batch.json"   # the strings sent in the last call (for --from-last)

SYSTEM = """你是“钱的天气”的翻译和分析助手。只输出一个 JSON 对象，不要任何别的文字。

任务一：把 Polymarket 预言市场的英文问题/标题/选项翻成简短、自然的简体中文。
- 每条 ≤ 30 字；原文是问句就保留问句；口语化、给中国散户看得懂。
- 模型和产品名保持英文原样（Fable、Opus、Sonnet、Claude、GPT Astra、GPT Terra、GPT Sol、GPT Luna、Muse Spark、
  Gemini、Grok、Kimi、DeepSeek、Qwen、GLM、SSI 等），公司常用中文名（谷歌、微软、英伟达、亚马逊、苹果、特斯拉），
  OpenAI / Anthropic / xAI / Meta 保持英文。Fed=美联储，bps=个基点，Strait of Hormuz=霍尔木兹海峡，
  Humanity's Last Exam=HLE（人类最后的考试），Arena=竞技场榜，IPO=上市，ATH=历史新高。
- "by...?" / "by ___" 译成“……前？”，"___" 译成“多少”；日期写成“2026年12月31日前”；金额保留 $ 和数字。
- 不要添加原文没有的信息。

任务二（只对 map 列表里的市场）：判断“如果这个市场结果为 YES，哪些地图板块的钱会受影响”。
- 只能用给出的板块 id；选 1–5 个最直接的；sign=1 表示 YES 对这个板块的钱是利好，-1 是利空。
- 和资金流向基本无关（八卦、人事、纯政治表态）就给 {"none": true}。
- why：一句中文，≤ 20 字。

输出格式：{"zh": {"<编号>": "中文", ...}, "map": {"<市场id>": {"nodes": [{"id": "...", "sign": 1}], "why": "..."} 或 {"none": true, "why": "..."}}}"""


def region_list(tree: C.Tree) -> str:
    rows = []
    for nid in tree.regions():
        if nid == "world":
            continue
        n = tree.nodes[nid]
        rows.append(f"{nid}={n['name']}")
    return "；".join(rows)


def build_prompt(units: list[str], cands: list[dict], tree: C.Tree) -> str:
    parts = ["# zh：要翻译的条目（编号\\t英文）"]
    parts += [f"{i}\t{u}" for i, u in enumerate(units)]
    if cands:
        parts.append("\n# map：要判断板块的市场（id\\t问题\\t规则猜测）")
        parts += [f"{c['id']}\t{c['q']}\t{' '.join(c.get('rules') or []) or '-'}" for c in cands]
        parts.append("\n# 板块 id=名字\n" + region_list(tree))
    return "\n".join(parts)


def apply_result(res: dict, units: list[str], cands: list[dict], tr: TR.Translations, tree: C.Tree) -> tuple[int, int]:
    n_zh = n_map = 0
    zh = (res or {}).get("zh") or {}
    for k, v in zh.items():
        try:
            i = int(k)
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(units) and isinstance(v, str) and v.strip():
            tr.put(units[i], v.strip()[:80], by="claude")
            n_zh += 1
    mp = (res or {}).get("map") or {}
    if mp:
        store = C.read_json(C.MAPPING, {})
        items = store.get("items") or {}
        ok_ids = {c["id"] for c in cands}
        at = datetime.now().strftime("%Y-%m-%dT%H:%M")
        for mid, v in mp.items():
            mid = str(mid)
            if mid not in ok_ids or not isinstance(v, dict):
                continue
            if v.get("none"):
                items[mid] = {"none": True, "nodes": [], "why": str(v.get("why") or "")[:60], "at": at}
                n_map += 1
                continue
            nodes = []
            for n in v.get("nodes") or []:
                if not isinstance(n, dict):
                    continue
                rid = tree.resolve(str(n.get("id") or ""))
                sg = n.get("sign")
                if rid and rid != "world" and sg in (1, -1) and rid not in [x["id"] for x in nodes]:
                    nodes.append({"id": rid, "sign": sg})
            if nodes:
                items[mid] = {"nodes": nodes[:6], "why": str(v.get("why") or "")[:60], "at": at}
                n_map += 1
        C.write_json(C.MAPPING, {"v": 1, "n": len(items), "items": items}, indent=1)
    tr.save()
    return n_zh, n_map


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--max", type=int, default=1, help="max Claude calls this run (default 1)")
    ap.add_argument("--units", type=int, default=520, help="max strings per call")
    ap.add_argument("--map-n", type=int, default=24, help="max mapping candidates (first call only)")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--timeout", type=float, default=900)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-rebuild", action="store_true")
    ap.add_argument("--from-last", action="store_true", help="re-parse cache/llm_last.json instead of calling Claude")
    a = ap.parse_args(argv)
    tree = C.Tree.load()
    pend = C.read_json(fetch.PENDING, None)
    if not pend:
        print("no pending.json — running fetch first")
        fetch.main(["--reuse-min", "1440", "--quiet"])
        pend = C.read_json(fetch.PENDING, {}) or {}
    tr = TR.Translations()
    units = [u for u in pend.get("units") or [] if not tr.get(u)]
    mapping = (C.read_json(C.MAPPING, {}) or {}).get("items") or {}
    cands = [c for c in pend.get("map") or [] if c["id"] not in mapping][:a.map_n]
    print(f"pending: {len(units)} strings to translate, {len(cands)} markets to map; max {a.max} call(s)")
    if not units and not cands:
        print("nothing to do")
        return 0
    calls = ran = 0
    total_zh = total_map = 0
    while (units or cands) and calls < a.max:
        batch, units = units[:a.units], units[a.units:]
        mc = cands if calls == 0 else []
        prompt = build_prompt(batch, mc, tree)
        if a.dry_run:
            print(f"--- dry run: call {calls + 1}: {len(batch)} strings, {len(mc)} mappings, {len(prompt)} chars")
            print(prompt[:1500] + ("\n…" if len(prompt) > 1500 else ""))
            calls += 1
            cands = []
            continue
        t0 = time.time()
        try:
            if a.from_last:
                last = C.read_json(LAST_BATCH, {}) or {}
                batch, mc = last.get("units") or [], last.get("cands") or []  # what that answer was for
                res, info = llm.reparse_last()
            else:
                C.write_json(LAST_BATCH, {"units": batch, "cands": mc}, indent=0)
                res, info = llm.call(SYSTEM, prompt, model=a.model, timeout=a.timeout)
                ran += int(info.get("attempts") or 1)
        except llm.ClaudeError as e:
            refused = any(w in str(e) for w in ("额度", "关掉了", "budget"))
            ran += 0 if refused else 1
            print(("skipped (Claude budget): " if refused else "claude call failed: ") + str(e))
            break
        calls += 1
        if not isinstance(res, dict):
            print(f"claude answer was not JSON ({info.get('raw', '')[:200]!r})")
            break
        n_zh, n_map = apply_result(res, batch, mc, tr, tree)
        total_zh += n_zh
        total_map += n_map
        cands = []
        print(f"call {calls}: {n_zh}/{len(batch)} translated, {n_map}/{len(mc)} mapped in {time.time() - t0:.0f}s "
              f"(out tokens {info.get('outTokens')}, cost ${info.get('cost')})")
    if a.dry_run:
        return 0
    print(f"total: {total_zh} translations, {total_map} mappings cached; {len(units)} strings still pending")
    print(f"CLAUDE_CALLS={ran}")
    if not a.no_rebuild and (total_zh or total_map):
        fetch.main(["--reuse-min", "1440", "--quiet"])
        d = C.read_json(C.OUT_FILE, {})
        print(f"rebuilt polymarket.json: {d.get('counts')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
