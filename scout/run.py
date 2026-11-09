"""scout/run.py — run ONE scout task: `claude -p` with web tools only → strict JSON → validate → scout/out/*.

The Claude call (spends the owner's subscription quota; never call this outside queue.py's caps):
  claude -p <prompt> --output-format json --json-schema <schema> --model sonnet
         --tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch --permission-prompts none
         --safe-mode --strict-mcp-config --no-session-persistence --system-prompt <short>
  run in a fresh temp cwd, killed after config.timeout_s.

Result contract (validated here, invalid → task failed, nothing written):
  {answer_zh, sharp_say, facts:[{claim, value?, unit?, source_url, source_name?, date}], fixes:[{type,…}], conf,
   title_zh?, event_date?, event_kind?, novelty?}

Writes by kind (all records carry source:"scout", sources, conf, taskId, at):
  explain → out/intel_events.json (+ intel.store when it is wired to web/data, see push_explain_to_intel)
  gap     → out/graph_patches.json (edges) / out/overrides_scout.json (other values)
  verify  → out/fixes.json
  ask     → out/answers.json
Every run → out/runs/<id>.json (prompt + envelope) and one log entry (scout/log.py).

CLI (debugging; normal use goes through queue.py / job.py so caps apply):
  python3 scout/run.py --task-id <id>                 run a task already in the queue (respects caps)
  python3 scout/run.py --kind ask --target security --question "…" --dry-run    show the prompt, no Claude call
"""
from __future__ import annotations

import os
import sys

if __name__ == "__main__" and __package__ in (None, ""):
    _here = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or ".") == _here:
        sys.path[0] = os.path.dirname(_here)          # scout/queue.py must not shadow stdlib queue

import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402
from pathlib import Path  # noqa: E402
from urllib.parse import urlparse  # noqa: E402

from scout import log as slog  # noqa: E402
from scout.common import (INTEL_WEB, OUT, ROOT, RUNS, WEB_DATA, Tree, at, iso, load_config, load_tree,  # noqa: E402
                          locked, map_file, money, node_series, num, owner_time, pct, read_json, say,
                          stock_file, today_et, update_list, weather_lines, write_json)

INTEL_EVENTS = OUT / "intel_events.json"
GRAPH_PATCHES = OUT / "graph_patches.json"
OVERRIDES_SCOUT = OUT / "overrides_scout.json"
FIXES = OUT / "fixes.json"
ANSWERS = OUT / "answers.json"

SCHEMA = {
    "type": "object",
    "properties": {
        "answer_zh": {"type": "string"},
        "sharp_say": {"type": "string"},
        "title_zh": {"type": "string"},
        "facts": {"type": "array", "items": {"type": "object", "properties": {
            "claim": {"type": "string"},
            "value": {"description": "number or short string"},
            "unit": {"type": "string"},
            "source_url": {"type": "string"},
            "source_name": {"type": "string"},
            "date": {"type": "string"}},
            "required": ["claim", "source_url", "date"]}},
        "fixes": {"type": "array", "items": {"type": "object", "properties": {"type": {"type": "string"}},
                                             "required": ["type"]}},
        "conf": {"type": "number", "minimum": 0, "maximum": 1},
        "event_date": {"type": "string"},
        "event_kind": {"type": "string", "enum": ["news", "data", "rumor", "opinion", "earnings", "policy"]},
        "novelty": {"type": "string", "enum": ["new", "probably-known", "old"]},
    },
    "required": ["answer_zh", "sharp_say", "facts", "fixes", "conf"],
}

SYSTEM = """你是「钱的天气」里的侦察兵，替老风上网查证。只能用 WebSearch / WebFetch。
铁律：
1. facts 每条都要附你这次真的搜到或打开过的来源：完整 URL（具体文章/文件页，不是首页）和发布日期 YYYY-MM-DD。claim 写成带数字的完整一句话，value 填那个数字。地图数据不算 facts（它没有链接）。查不到就直说查不到，把 conf 降下来。绝不编造数字、日期、链接。
2. answer_zh：大白话简体中文，先结论后证据，3–6 句，数字照来源写准并带日期。
3. sharp_say：一句不超过 30 字，老风口吻——直接、有立场、可以刻薄，但必须从事实推出来；不喊单、不给买卖建议。
4. 事实和观点分开：数字放 facts，观点放 sharp_say。
5. conf 0–1：只有一家来源、或是推算，conf ≤ 0.5。
6. 最多 6 条 facts，优先一手来源（公司公告/财报/SEC 文件/监管）和路透、彭博、CNBC、WSJ、FT 等。
7. 先用 WebSearch/WebFetch 查完，最后一条消息只输出一个 JSON 对象（不要 markdown、不要别的话）：
{"answer_zh":"…","sharp_say":"…","facts":[{"claim":"…","value":数字或null,"unit":"…","source_url":"https://…","source_name":"…","date":"YYYY-MM-DD"}],"fixes":[…],"conf":0.0,"title_zh":"…","event_date":"YYYY-MM-DD","event_kind":"news|data|rumor|opinion|earnings|policy","novelty":"new|probably-known|old"}
前五个字段必填，后四个按任务要求填。字符串里绝不用英文双引号，要引用就用「」。"""

KIND_HELP = {
    "explain": (
        "地图上这里刚出现异动（{why}）。查最近 10 天到底发生了什么：财报/指引、并购、政策/预算、评级、大单、宏观。"
        "多个原因按重要性排。另给 title_zh（≤20 字标题）、event_date（最关键事件日期）、event_kind、"
        "novelty（new=市场可能还没消化完 / probably-known / old）。fixes 放 1–4 条影响："
        '{{"type":"impact","id":"<只能用下面列出的 id>","dir":1或-1,"strength":1-3,"lag":"now|1-3m|3-12m","why":"≤30字"}}。'),
    "gap": (
        "地图上缺这个数：{a} 每年付给 {b} 多少钱（{what}）。查公司披露（10-K/10-Q、财报电话会、大客户占比）和可信估算"
        "（分析师、权威媒体）。fixes 放 1 条："
        '{{"type":"edge","a":"{a}","b":"{b}","from":"{a}","to":"{b}","usdB":中值,"usdBLow":下限,"usdBHigh":上限,'
        '"per":"year","what":"买的是什么","period":"FY2025 或 2025 等","est":true或false,"basis":"中文：数字怎么来的",'
        '"share_ofTo":"约占{b}相关收入几成，或 null","share_ofFrom":"约占{a}资本开支几成，或 null"}}。'
        "金额单位：十亿美元。只有公司直接披露了这个具体金额才 est:false；用客户占比×收入推算就 est:true 并把 basis 写清楚。"),
    "verify": (
        "地图数据里有个可疑点：{why}。查真相（改名、退市、被并购、停牌、换交易所、数据源问题，或其实没问题）。"
        'fixes 每个问题一条：{{"type":"ticker-rename|ticker-delisted|ticker-merged|data-ok|data-error|code-issue",'
        '"ticker":"…","new":"新代码或 null","effective_date":"YYYY-MM-DD 或 null","say":"一句话"}}。'),
    "verify_error": (
        "本机一个自动步骤重试后还是失败（{why}），日志在下面。先读日志自己判断原因；只有需要时才上网查"
        "（比如 Yahoo/yfinance 接口是不是改了、某个代码是不是退市了）。不要改任何代码。fixes 放 1 条结论："
        '{{"type":"data-ok|data-error|ticker-rename|ticker-delisted|ticker-merged|code-issue","ticker":"相关代码或 null",'
        '"new":"新代码或 null","file":"出问题的文件（相对路径）或 null","say":"一句话：哪里坏了、怎么修"}}。'
        "data-ok=外部临时故障（网络、接口抽风），下一轮自己会好；data-error=某个数据文件坏了或缺了；"
        "code-issue=要改代码或本机环境。facts 只放你真的在网上查到的来源；纯本地问题 facts 可以是空列表，"
        "answer_zh 里写清楚日志哪一行说明了什么。"),
    "ask": (
        "主人问的问题，直接回答。如果问题的前提和地图数据对不上（比如问“为什么没人要”但数据显示钱在流入），"
        "先直说前提不对，再分“这几天”和“这一年”讲清楚。fixes 一般为空；觉得地图数据本身可能错了才放 "
        '{{"type":"note","say":"…"}}。'),
}

VALID_FIX_TYPES = {
    "explain": {"impact"},
    "gap": {"edge", "value"},
    "verify": {"ticker-rename", "ticker-delisted", "ticker-merged", "data-ok", "data-error", "code-issue"},
    "ask": {"note"},
}
LAGS = {"now", "1-3m", "3-12m", "1y+"}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
BAD_HOSTS = {"example.com", "www.example.com", "localhost", "127.0.0.1"}


class ScoutError(Exception):
    pass


# ════════════════════════════ context for the prompt ════════════════════════════

def _longer(tree: Tree, nid: str, cache: dict) -> str:
    """60/120/252-day returns and 20/60-day flow from the map series."""
    if tree.is_stock(nid):
        d = read_json(stock_file(nid[2:])) or {}
        px = d.get("c") or []
        flow = d.get("flow") or []
    else:
        d = read_json(map_file(nid)) or {}
        s = d.get("self") or node_series(tree, nid, cache) or {}
        px = s.get("idx") or []
        flow = s.get("flow") or []

    def ret(n):
        a, b = at(px, -1), at(px, -1 - n)
        return pct(a / b - 1) if a and b else "—"

    def fsum(n):
        vals = [num(x) for x in flow[-n:]]
        vals = [v for v in vals if v is not None]
        return money(sum(vals)) if vals else "—"

    if not px:
        return ""
    return f"更长：60日 {ret(60)}，120日 {ret(120)}，一年 {ret(len(px) - 1)}；近20日累计估算净流入 {fsum(20)}，近60日 {fsum(60)}"


def node_context(tree: Tree, nid: str, cache: dict) -> tuple[list[str], list[str]]:
    """Lines describing a node + the ids Claude may use for impacts."""
    n = tree.get(nid) or {}
    lines = [f"目标：{tree.path_names(nid)}（id: {nid}）" + (f" — {n.get('desc') or n.get('note')}" if (n.get('desc') or n.get('note')) else "")]
    lines += weather_lines(tree, nid, cache)
    lg = _longer(tree, nid, cache)
    if lg:
        lines.append(lg)
    par = tree.parent(nid)
    if par and par != "world":
        pn = (tree.get(par) or {}).get("now") or {}
        lines.append(f"同期上一级「{tree.get(par).get('name')}」：5日 {pct(pn.get('ret5'))}，20日 {pct(pn.get('ret20'))}，风 {pn.get('wind')}")
    allowed = [nid] + [a for a in tree.ancestors(nid) if a != "world"]
    kids = [c for c in tree.children.get(nid, []) if not tree.is_stock(c)]
    if kids:
        rows = sorted(kids, key=lambda c: -abs(num(((tree.get(c) or {}).get("now") or {}).get("wind")) or 0))
        bits = []
        for c in rows[:7]:
            cn = (tree.get(c) or {}).get("now") or {}
            bits.append(f"{tree.get(c).get('name')}({c}) 风{num(cn.get('wind')) or 0:+.1f} 5日{pct(cn.get('ret5'))}")
        lines.append("下一级：" + "；".join(bits))
        allowed += kids
    if tree.is_stock(nid):
        d = read_json(stock_file(nid[2:])) or {}
        f = d.get("facts") or {}
        if f:
            lines.append(f"价格 {f.get('last')}，52周高 {f.get('high52')} / 低 {f.get('low52')}，60日 {pct(f.get('ret60'))}")
        peers = [p[2:] for p in (d.get("peers") or [])[:6]]
        if peers:
            lines.append("同行：" + ", ".join(peers))
    else:
        st = tree.stocks_under(nid)
        st = sorted(st, key=lambda s: -(num(((tree.get(s) or {}).get("now") or {}).get("dv20")) or 0))[:12]
        if st:
            bits = []
            for s in st:
                sn = (tree.get(s) or {}).get("now") or {}
                bits.append(f"{s[2:]} 5日{pct(sn.get('ret5'))} 20日{pct(sn.get('ret20'))}")
            lines.append("主要成分股（按成交额）：" + "；".join(bits))
            allowed += st
    return lines, allowed


def guess_target(question: str, tree: Tree) -> str | None:
    """Longest node name (or ticker) mentioned in the question."""
    best, blen = None, 0
    for nid, n in tree.nodes.items():
        name = n.get("name") or ""
        if len(name) >= 2 and name in question and len(name) > blen:
            best, blen = nid, len(name)
    if best:
        return best
    for tok in re.findall(r"\b[A-Z]{2,5}\b", question):
        if "s:" + tok in tree.nodes:
            return "s:" + tok
    return None


def resolve_target(task: dict, tree: Tree | None) -> dict:
    """Normalise task.target to a dict with a type."""
    t = task.get("target")
    if isinstance(t, str):
        t = {"type": "node", "id": t}
    if not isinstance(t, dict):
        t = {}
    if not t.get("type"):
        t["type"] = "node" if t.get("id") else ("edge" if t.get("a") and t.get("b") else "none")
    if t["type"] == "node" and tree:
        nid = tree.resolve(t.get("id") or "")
        if nid:
            t["id"] = nid
        else:
            t = {"type": "none", "ref": t.get("id")}
    if t["type"] == "none" and tree and task.get("question"):
        g = guess_target(task["question"], tree)
        if g:
            t = {"type": "node", "id": g, "guessed": True}
    return t


def edge_context(t: dict, tree: Tree | None) -> list[str]:
    a, b = t.get("a", "").upper(), t.get("b", "").upper()
    lines = []
    for x in (a, b):
        n = tree.get("s:" + x) if tree else None
        if n:
            lines.append(f"{x}：{n.get('name')} — {n.get('note', '')}（地图位置：{tree.path_names('s:' + x)}）")
        else:
            lines.append(f"{x}")
    cur = t.get("current")
    if isinstance(cur, dict):
        m = cur.get("money") or {}
        lines.append(f"地图现在的估计：{m.get('usdB')} 十亿美元/年（est={cur.get('est')}, conf={cur.get('conf')}, basis={cur.get('basis')}）")
    else:
        lines.append("地图现在没有这个数（空白）。")
    return lines


def build_prompt(task: dict, tree: Tree | None, meta: dict | None) -> tuple[str, list[str], dict]:
    kind = task["kind"]
    t = resolve_target(task, tree)
    cache: dict = {}
    lines: list[str] = []
    allowed: list[str] = []
    if t["type"] == "node" and tree:
        lines, allowed = node_context(tree, t["id"], cache)
    elif t["type"] == "edge":
        lines = edge_context(t, tree)
    elif t["type"] == "tickers":
        for tk in t.get("tickers") or []:
            n = tree.get("s:" + tk) if tree else None
            info = (t.get("details") or {}).get(tk, "")
            lines.append(f"{tk}：{(n or {}).get('name', '')} {(n or {}).get('note', '')} {info}".strip())
    elif t["type"] == "error":
        lines.append(f"出错的步骤：{t.get('step', '?')}")
        if t.get("cmd"):
            lines.append(f"命令：{t['cmd']}" + (f"（退出码 {t['rc']}）" if t.get("rc") is not None else ""))
        log = str(t.get("log") or "")[-1500:]
        if log:
            lines.append("日志末尾：\n" + log)
    if tree and t["type"] in ("none",):
        root = tree.get("world") or {}
        if root.get("now"):
            lines.append("全球：" + "；".join(weather_lines(tree, "world", cache)[:1]))
    ctx = task.get("context") or {}
    if ctx.get("children_flagged"):
        lines.append("同时异动的下级：" + "、".join(ctx["children_flagged"]))
    if ctx.get("note"):
        lines.append(str(ctx["note"]))
    if allowed and kind == "explain":
        lines.append("可用于 impacts 的 id：" + ", ".join(allowed[:24]))

    why = task.get("why") or derive_why(t, task)
    task.setdefault("why", why)
    a, b = (t.get("a") or "").upper(), (t.get("b") or "").upper()
    hk = "verify_error" if (kind == "verify" and t["type"] == "error") else kind
    helptext = KIND_HELP[hk].format(why=why, a=a or "?", b=b or "?", what=t.get("what") or "主要采购")
    as_of = (meta or {}).get("asOf") or "?"
    question = task.get("question") or default_question(task, t, tree)
    prompt = "\n".join([
        f"今天 {today_et()}（美东）。地图数据截至 {as_of} 收盘。任务：{kind}。",
        helptext,
        "—— 地图上测到的（由价格和成交额算出，不是新闻；风>0=钱流入，拥挤度 0–100 跟它自己过去一年比）——",
        *(lines or ["（没有更多地图数据）"]),
        "—— 问题 ——",
        question,
    ])
    return prompt, allowed, t


def derive_why(t: dict, task: dict) -> str:
    """A short 'what looks wrong' line when the caller did not give one (on-demand verify/explain)."""
    if t.get("type") == "tickers":
        det = t.get("details") or {}
        return "；".join(f"{x}：{det.get(x) or '数据异常'}" for x in t.get("tickers") or []) or "股票代码数据异常"
    if t.get("type") == "error":
        return f"「{t.get('step', '?')}」这一步一直出错"
    if t.get("type") == "edge":
        return f"{t.get('a')}→{t.get('b')} 这条关系的钱数对不上"
    return (task.get("question") or "").strip() or "主人觉得这里不对劲"


def default_question(task: dict, t: dict, tree: Tree | None) -> str:
    kind = task["kind"]
    name = (tree.get(t["id"]).get("name") if (tree and t.get("type") == "node" and tree.get(t["id"])) else t.get("id") or "")
    if kind == "explain":
        return f"为什么「{name}」突然起风？到底发生了什么？"
    if kind == "gap":
        return f"{t.get('a')} 一年付给 {t.get('b')} 多少钱（{t.get('what') or '主要采购'}）？"
    if kind == "verify":
        return f"这些数据异常是怎么回事：{task.get('why') or name}？"
    return f"「{name}」最近怎么了？"


# ════════════════════════════ the Claude call ════════════════════════════

def _gate():
    """common/claude_gate.py of THIS checkout — DESIGN §24: every Claude call goes through the one gateway
    (budget check, in-flight reservation, cost ledger web/data/claude_usage.json). Loaded by path when
    `common` is shadowed by another module."""
    import hashlib
    import importlib
    import importlib.util
    f = ROOT / "common" / "claude_gate.py"
    alias = "mw_gate_" + hashlib.md5(str(f).encode()).hexdigest()[:8]
    for name in ("common.claude_gate", alias):
        m = sys.modules.get(name)
        if m is not None and Path(getattr(m, "__file__", "") or "").resolve() == f.resolve():
            return m
    try:
        m = importlib.import_module("common.claude_gate")
        if Path(m.__file__).resolve() == f.resolve():
            return m
    except Exception:                               # noqa: BLE001
        pass
    if not f.exists():
        raise ScoutError(f"Claude 额度出口不见了：{f}")
    spec = importlib.util.spec_from_file_location(alias, f)
    m = importlib.util.module_from_spec(spec)
    sys.modules[alias] = m
    spec.loader.exec_module(m)
    return m


def claude_bin(cfg: dict) -> str:
    """$MW_CLAUDE_BIN (tests point it at a fake; the loop uses the same variable) > config > PATH."""
    b = _gate().find_bin(cfg.get("claude_bin"))
    if not b:
        raise ScoutError(f"找不到 Claude Code CLI（{cfg.get('claude_bin') or 'claude'}）")
    return b


def parse_stream(out: str) -> tuple[dict | None, list[dict]]:
    """stream-json lines → (final result event, compact trace of tool calls/results)."""
    final, trace, seen = None, [], set()
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        typ = e.get("type")
        if typ == "result":
            final = e
        elif typ in ("assistant", "user"):
            for c in ((e.get("message") or {}).get("content") or []):
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use":
                    trace.append({"tool": c.get("name"), "input": json.dumps(c.get("input"), ensure_ascii=False)[:240]})
                    if c.get("name") == "WebFetch" and isinstance(c.get("input"), dict) and c["input"].get("url"):
                        seen.add(_norm_url(c["input"]["url"]))
                elif c.get("type") in ("server_tool_use",):
                    trace.append({"tool": c.get("name"), "input": json.dumps(c.get("input"), ensure_ascii=False)[:240]})
                elif c.get("type") in ("tool_result", "web_search_tool_result"):
                    body = c.get("content")
                    if isinstance(body, list):
                        body = " ".join(str(x.get("text") or x.get("url") or "") if isinstance(x, dict) else str(x) for x in body)
                    body = str(body)
                    seen.update(_norm_url(u) for u in URL_RE.findall(body))
                    trace.append({"result": body[:300], "error": bool(c.get("is_error"))})
                elif c.get("type") == "text" and c.get("text"):
                    trace.append({"text": c["text"][:200]})
    if final is not None:
        final["seenUrls"] = sorted(seen)[:800]
    return final, trace[-60:]


URL_RE = re.compile(r"https?://[^\s\"'<>)\]}，。]+")


def _norm_url(u: str) -> str:
    u = u.strip().rstrip(".,;:")
    p = urlparse(u)
    host = (p.hostname or "").lower().removeprefix("www.")
    return host + p.path.rstrip("/")


def _ledger(kind: str, env: dict | None, auto: bool, ok: bool, ms: int, note: str = "") -> None:
    """DESIGN §21: every claude -p is in web/data/claude_usage.json. call_claude() goes through the gateway,
    which books every run itself; this stays for anything that ran Claude some other way."""
    try:
        _gate().record(f"scout:{kind}", module="scout", env=env, auto=auto, ok=ok, ms=ms, note=note)
    except Exception:                               # noqa: BLE001 — losing a ledger line must not lose a result
        pass


def spend_check(auto: bool = False) -> str | None:
    """None when today's Claude points allow another call, else the plain reason (§21: all ≤ 6 points/day,
    automatic ≤ 4, the rest kept for the owner's clicks). No count or concurrency limits — spend only."""
    try:
        ok, why = _gate().can_spend(auto=auto)
        return None if ok else why
    except Exception:                               # noqa: BLE001
        return None


def call_claude(prompt: str, cfg: dict, kind: str = "ask", auto: bool = False) -> dict:
    """One scout task through common/claude_gate.py: web tools only, stream-json, temp cwd, cost booked.
    Returns the CLI's result envelope plus trace / toolCalls / seenUrls (what validate() checks).
    output_mode "schema" = CLI-validated structured output. Off by default: when Claude mis-escapes a quote
    inside long Chinese text the tool call collapses to one field, Claude retries, then submits a placeholder."""
    claude_bin(cfg)                                  # clear error when the CLI is missing
    r = _gate().call(
        f"scout:{kind}", prompt, system=SYSTEM, tools=["WebSearch", "WebFetch"],
        schema=SCHEMA if cfg.get("output_mode") == "schema" else None,
        model=str(cfg.get("model") or "sonnet"), effort=(str(cfg["effort"]) if cfg.get("effort") else None),
        auto=auto, timeout=int(float(cfg.get("timeout_s") or 480)), parse=parse_json_obj, retries=1,
        prompt_via="argv", max_usd=num(cfg.get("max_budget_usd_per_task")) or None,
        claude_bin=cfg.get("claude_bin"), module="scout")
    if r["refused"]:
        raise ScoutError(r["error"] or "今天的额度用完了")
    env_json = r.get("envelope")
    if not isinstance(env_json, dict):
        raise ScoutError(r["error"] or "Claude 没返回 JSON")
    if env_json.get("is_error") or env_json.get("subtype") not in (None, "success"):
        raise ScoutError(f"Claude 出错：{env_json.get('subtype')} {str(env_json.get('result') or '')[:300]}")
    env_json = dict(env_json)
    env_json["trace"] = r["trace"]
    env_json["toolCalls"] = dict(r["toolCalls"])
    env_json["seenUrls"] = r["seenUrls"]
    env_json["total_cost_usd"] = r["usd"]            # all runs of this task (a JSON retry included)
    env_json["attempts"] = r["attempts"]
    return env_json


def _value_start(s: str, j: int) -> bool:
    """Is s[j:] (after whitespace) the start of a JSON value?"""
    while j < len(s) and s[j] in " \t\r\n":
        j += 1
    return j < len(s) and (s[j] in '"{[-' or s[j].isdigit() or s.startswith(("true", "false", "null"), j))


def repair_json(s: str) -> str:
    """Escape stray ASCII quotes inside strings (「他说"没人要"」), raw newlines, trailing commas."""
    out, in_str, esc, n = [], False, False, len(s)
    for i, ch in enumerate(s):
        if not in_str:
            in_str = ch == '"'
            out.append(ch)
            continue
        if esc:
            out.append(ch)
            esc = False
        elif ch == "\\":
            out.append(ch)
            esc = True
        elif ch == '"':
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            nxt = s[j] if j < n else ""
            closing = (nxt in "}]" or nxt == "" or
                       (nxt == "," and _value_start(s, j + 1)) or (nxt == ":" and _value_start(s, j + 1)))
            if closing:
                in_str = False
                out.append(ch)
            else:
                out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        else:
            out.append(ch)
    return re.sub(r",\s*([}\]])", r"\1", "".join(out))


def parse_json_obj(txt: str) -> dict | None:
    txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", (txt or "").strip())
    a, b = txt.find("{"), txt.rfind("}")
    if a < 0 or b <= a:
        return None
    body = txt[a:b + 1]
    for cand in (body, repair_json(body)):
        try:
            d = json.loads(cand)
            if isinstance(d, dict):
                return d
        except ValueError:
            continue
    return None


def extract_payload(env: dict) -> dict:
    so = env.get("structured_output")
    if isinstance(so, dict):
        return so
    d = parse_json_obj(str(env.get("result") or ""))
    if d is None:
        raise ScoutError("Claude 的结果不是合法 JSON")
    return d


# ════════════════════════════ validation ════════════════════════════

def url_shape_ok(u: str) -> bool:
    try:
        p = urlparse(u)
    except ValueError:
        return False
    return p.scheme in ("http", "https") and "." in (p.hostname or "") and (p.hostname or "") not in BAD_HOSTS


def check_url(u: str, timeout: float = 8.0) -> dict:
    """ok: True = page answered, False = dead (404/410/DNS), None = could not tell (blocked/timeout)."""
    req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(2048)
            return {"ok": True, "status": r.status}
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            return {"ok": False, "status": e.code}
        return {"ok": None, "status": e.code}               # 401/403/429/5xx: exists but blocks bots/paywall
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        dead = "nodename nor servname" in reason or "Name or service not known" in reason
        return {"ok": False if dead else None, "status": None, "error": reason[:80]}
    except Exception as e:                                   # timeouts, TLS oddities
        return {"ok": None, "status": None, "error": e.__class__.__name__}


DATE_RE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")


def han_len(s: str) -> int:
    return len(re.sub(r"\s", "", s or ""))


def validate(kind: str, data: dict, env: dict, tree: Tree | None, allowed: list[str], cfg: dict,
             target: dict | None = None) -> tuple[dict, list[str]]:
    issues: list[str] = []
    # a local step error (sent by the loop) can be diagnosed from its log alone: no web use / sources needed
    local = kind == "verify" and (target or {}).get("type") == "error"
    ans = str(data.get("answer_zh") or "").strip()
    sharp = str(data.get("sharp_say") or "").strip()
    if not ans or not sharp:
        raise ScoutError("结果缺 answer_zh 或 sharp_say")
    if not re.search(r"[一-鿿]", ans + sharp):
        raise ScoutError("结果不是中文")
    if han_len(sharp) > 40:
        issues.append(f"sharp_say 太长（{han_len(sharp)} 字）")
    conf = num(data.get("conf"))
    conf = 0.3 if conf is None else max(0.0, min(1.0, conf))

    facts = []
    for f in (data.get("facts") or [])[:8]:
        if not isinstance(f, dict):
            continue
        u = str(f.get("source_url") or "").strip()
        claim = str(f.get("claim") or "").strip()
        d = str(f.get("date") or "").strip()[:10]
        if not claim or not url_shape_ok(u):
            issues.append(f"丢掉一条没有有效链接的事实：{claim[:30]}")
            continue
        if not DATE_RE.match(d):
            d = ""
        ff = {"claim": claim[:300], "source_url": u, "date": d}
        if f.get("value") not in (None, ""):
            ff["value"] = f["value"]
        for k in ("unit", "source_name"):
            if f.get(k):
                ff[k] = str(f[k])[:60]
        if urlparse(u).path in ("", "/"):
            ff["generic"] = True
        facts.append(ff)

    # are the links real?
    if facts and cfg.get("check_urls", True):
        urls = list(dict.fromkeys(f["source_url"] for f in facts))
        with ThreadPoolExecutor(max_workers=6) as ex:
            res = dict(zip(urls, ex.map(check_url, urls)))
        for f in facts:
            r = res.get(f["source_url"]) or {}
            f["urlOk"] = r.get("ok")
            f["urlStatus"] = r.get("status")
        dead = [f for f in facts if f.get("urlOk") is False]
        if dead:
            issues.append(f"{len(dead)} 个链接打不开（404/域名不存在）")
            conf -= 0.15 * len(dead) / len(facts)
            if len(dead) == len(facts):
                conf = min(conf, 0.25)

    turns = env.get("num_turns") or 0
    stu = ((env.get("usage") or {}).get("server_tool_use") or {})
    tc = env.get("toolCalls") or {}
    searches = max(int(stu.get("web_search_requests") or 0), int(tc.get("WebSearch") or 0))
    fetches = max(int(stu.get("web_fetch_requests") or 0), int(tc.get("WebFetch") or 0))
    if searches + fetches == 0 and not local:
        raise ScoutError("Claude 没上网就交卷了（0 次搜索/抓取），结果作废")
    # junk / placeholder answers
    if re.fullmatch(r"(测试|test|todo|n/?a|无|空)[。.!！]?", ans.lower()) or han_len(ans) < 8:
        raise ScoutError(f"答案是占位符（{ans[:20]}），结果作废")
    if not facts and not local:
        raise ScoutError("没有任何带来源的事实，结果作废")
    if not facts:
        conf = min(conf, 0.6)                       # judged from the log only
    # did Claude actually see these links in its searches/fetches?
    seen = set(env.get("seenUrls") or [])
    if seen:
        for f in facts:
            nu = _norm_url(f["source_url"])
            f["seen"] = nu in seen or any(nu.startswith(x) or x.startswith(nu) for x in seen if len(x) > 12)
        unseen = [f for f in facts if not f["seen"]]
        if unseen:
            issues.append(f"{len(unseen)} 个链接没在搜索结果里出现过（可能是凭记忆写的）")
            conf -= 0.1 * len(unseen) / len(facts)

    fixes = []
    ok_types = VALID_FIX_TYPES[kind]
    for x in (data.get("fixes") or [])[:8]:
        if not isinstance(x, dict) or x.get("type") not in ok_types:
            if isinstance(x, dict):
                issues.append(f"丢掉类型不对的 fix：{x.get('type')}")
            continue
        if x["type"] == "impact":
            iid = x.get("id")
            if tree and not tree.get(iid):
                rid = tree.resolve(str(iid or ""))
                if not rid:
                    issues.append(f"丢掉不存在的 id：{iid}")
                    continue
                iid = rid
            d = 1 if (num(x.get("dir")) or 0) >= 0 else -1
            s = int(max(1, min(3, round(num(x.get("strength")) or 1))))
            lag = x.get("lag") if x.get("lag") in LAGS else "now"
            fixes.append({"type": "impact", "id": iid, "dir": d, "strength": s, "lag": lag,
                          "why": str(x.get("why") or "")[:80]})
        elif x["type"] == "edge":
            mid, lo, hi = num(x.get("usdB")), num(x.get("usdBLow")), num(x.get("usdBHigh"))
            if mid is None or mid <= 0:
                issues.append("edge 没有有效金额")
                continue
            lo = mid if lo is None else min(lo, mid)
            hi = mid if hi is None else max(hi, mid)
            if mid > 2000:
                issues.append(f"edge 金额离谱（{mid} 十亿美元）")
                continue
            fixes.append({**x, "usdB": round(mid, 2), "usdBLow": round(lo, 2), "usdBHigh": round(hi, 2)})
        else:
            fixes.append({k: v for k, v in x.items() if isinstance(v, (str, int, float, bool)) or v is None})

    if local and not fixes:
        raise ScoutError("没给出结论（fixes 里没有 data-ok/data-error/code-issue…），结果作废")
    out = {"answer_zh": ans[:1200], "sharp_say": sharp[:80], "facts": facts, "fixes": fixes,
           "conf": round(max(0.0, min(1.0, conf)), 2), "confClaimed": num(data.get("conf")),
           "title_zh": str(data.get("title_zh") or "")[:40] or None,
           "event_date": str(data.get("event_date") or "")[:10] or None,
           "event_kind": data.get("event_kind") if data.get("event_kind") in SCHEMA["properties"]["event_kind"]["enum"] else None,
           "novelty": data.get("novelty") if data.get("novelty") in ("new", "probably-known", "old") else None,
           "webSearches": searches, "webFetches": fetches, "turns": turns, "issues": issues}
    return out, issues


# ════════════════════════════ writing results ════════════════════════════

def _sources(res: dict) -> list[dict]:
    seen, out = set(), []
    for f in res["facts"]:
        u = f["source_url"]
        if u not in seen:
            seen.add(u)
            out.append({"url": u, "name": f.get("source_name"), "date": f.get("date"), "ok": f.get("urlOk")})
    return out


def _upsert(path, rec: dict, key: str = "id", limit: int = 1000) -> None:
    def fn(cur):
        cur = [r for r in cur if not (isinstance(r, dict) and r.get(key) == rec.get(key))]
        return [rec] + cur
    update_list(path, fn, limit=limit)


def _enrich_for_intel(ev: dict) -> dict:
    """Same enrichment the owner's own intel gets (names, paths, priced-in, reach), so the page draws scout
    events exactly like pasted ones. intel/ is another agent's module: any failure → the plain event."""
    ev = json.loads(json.dumps(ev, ensure_ascii=False))
    ev.setdefault("groupId", ev["id"])
    try:
        from intel import catalog as icat
        from intel import ingest as iing
        cat = icat.load_catalog()
        if all(cat.has(im.get("id")) for im in ev.get("impacts") or []):
            trial = json.loads(json.dumps(ev, ensure_ascii=False))
            iing.enrich(trial, cat, icat.tree_now_index())
            return trial
    except Exception as e:                          # noqa: BLE001
        say(f"intel enrich skipped ({e.__class__.__name__}: {str(e)[:80]})")
    return ev


def _merge_into(path: Path, ev: dict, limit: int) -> None:
    """Prepend ev to a newest-first JSON list under the sidecar flock intel/store.py also uses (path.lock)."""
    with locked(path):
        cur: list = []
        if path.exists():
            try:
                with open(path, encoding="utf-8") as fh:
                    cur = json.load(fh)
            except ValueError:                     # like intel/store.py: keep a corrupt file for a human
                os.replace(path, path.with_name(path.name + ".corrupt"))
                cur = []
        if isinstance(cur, dict):
            cur = cur.get("events", [])
        cur = [e for e in (cur if isinstance(cur, list) else []) if isinstance(e, dict) and e.get("id") != ev["id"]]
        write_json(path, ([ev] + cur)[:limit])


def push_to_intel(ev: dict, cfg: dict, target: Path | None = None) -> str | None:
    """Merge one explain event into the map's intel layer, web/data/intel.json (DESIGN §11/§15).
    Uses intel/store.py when it already points at that file; otherwise writes the same file under the same
    lock, so the two never lose each other's writes. Returns where it went (None = not pushed)."""
    mode = cfg.get("push_explain_to_intel", "auto")
    if mode in (False, None, "off", "false"):
        return None
    target = Path(target or INTEL_WEB)
    ev = _enrich_for_intel(ev)
    istore = None
    try:
        from intel import store as istore          # owned by the intel agent; may not exist
    except Exception as e:                          # noqa: BLE001
        say(f"intel.store not importable ({e.__class__.__name__}); writing {target.name} directly")
    try:
        sp = getattr(istore, "INTEL_PATH", None) if istore else None
        if sp is not None and Path(sp).resolve() == target.resolve() and hasattr(istore, "add"):
            istore.add([ev])
        else:
            _merge_into(target, ev, int(getattr(istore, "MAX_EVENTS", 1000) or 1000))
        return str(target.relative_to(ROOT)) if target.is_relative_to(ROOT) else str(target)
    except Exception as e:                          # noqa: BLE001
        say(f"could not merge the event into {target}: {e}")
        return None


def backfill_intel(cfg: dict | None = None) -> list[str]:
    """Push every stored explain event (scout/out/intel_events.json) that the intel layer does not have yet."""
    cfg = cfg or load_config()
    have = read_json(INTEL_WEB, [])
    if isinstance(have, dict):
        have = have.get("events", [])
    ids = {e.get("id") for e in have if isinstance(e, dict)} if isinstance(have, list) else set()
    done = []
    for ev in reversed(read_json(INTEL_EVENTS, []) or []):          # oldest first → newest ends on top
        if isinstance(ev, dict) and ev.get("id") and ev["id"] not in ids and push_to_intel(ev, cfg):
            done.append(ev["id"])
    return done


def write_outputs(task: dict, t: dict, res: dict, tree: Tree | None, meta: dict | None, cfg: dict) -> list[dict]:
    kind = task["kind"]
    now = iso()
    srcs = _sources(res)
    urls = [s["url"] for s in srcs]
    ok_src = any(s.get("ok") in (True, None) for s in srcs)
    changes: list[dict] = []
    base = {"source": "scout", "taskId": task["id"], "conf": res["conf"], "sources": urls, "at": now}

    if kind == "explain":
        nid = t.get("id")
        impacts = [{k: v for k, v in f.items() if k != "type"} for f in res["fixes"] if f["type"] == "impact"]
        if not impacts and nid and tree and tree.get(nid):
            w = num(((tree.get(nid) or {}).get("now") or {}).get("wind")) or 0
            impacts = [{"id": nid, "dir": 1 if w >= 0 else -1, "strength": 1, "lag": "now", "why": res["sharp_say"][:40]}]
        dates = sorted([f["date"] for f in res["facts"] if f.get("date")], reverse=True)
        ev = {"id": f"scout-{task['id']}", "addedAt": now, "source": "scout", "url": urls[0] if urls else None,
              "title": res.get("title_zh") or res["sharp_say"][:30],
              "summary": res["answer_zh"][:400],
              "eventDate": res.get("event_date") or (dates[0] if dates else (meta or {}).get("asOf")),
              "kind": res.get("event_kind") or "news", "credibility": res["conf"],
              "novelty": res.get("novelty") or "probably-known", "impacts": impacts,
              "polymarket": [], "scenarios": [], "say": res["sharp_say"],
              "sources": srcs, "facts": res["facts"],
              "scout": {"taskId": task["id"], "question": task.get("question"), "target": nid}}
        _upsert(INTEL_EVENTS, ev)
        changes.append({"file": "scout/out/intel_events.json", "what": f"新情报：{ev['title']}"})
        where = push_to_intel(ev, cfg)
        if where:
            changes.append({"file": where, "what": "已并进地图的情报层（标着侦察兵，可删）"})

    elif kind == "gap":
        for f in res["fixes"]:
            if f["type"] == "edge":
                a = str(f.get("a") or t.get("a") or "").upper()
                b = str(f.get("b") or t.get("b") or "").upper()
                verified = (f.get("est") is False and res["conf"] >= float(cfg.get("min_conf_verified", 0.7)) and ok_src)
                etype = t.get("edgeType") or "buys-from"
                patch = {"key": f"{a}>{b}:{etype}", "a": a, "b": b, "type": etype,
                         "money": {"from": str(f.get("from") or a).upper(), "to": str(f.get("to") or b).upper(),
                                   "usdB": f["usdB"], "usdBLow": f["usdBLow"], "usdBHigh": f["usdBHigh"],
                                   "per": f.get("per") or "year", "what": f.get("what") or t.get("what")},
                         "share": {"ofTo": f.get("share_ofTo"), "ofFrom": f.get("share_ofFrom")},
                         "period": f.get("period"), "asOf": today_et()[:7], "est": not verified,
                         "basis": f.get("basis") or ("公司披露" if verified else "侦察兵估算"),
                         "say": res["sharp_say"], **base}
                _upsert(GRAPH_PATCHES, patch, key="key")
                rng = f"{f['usdBLow']}–{f['usdBHigh']}" if f["usdBLow"] != f["usdBHigh"] else f"{f['usdB']}"
                changes.append({"file": "scout/out/graph_patches.json",
                                "what": f"{a}→{b} 每年约 {f['usdB']} 十亿美元（区间 {rng}，{'已核实' if verified else '估算'}）"})
            elif f["type"] == "value" and f.get("target") and f.get("field"):
                rec = {"id": f"{f['target']}|{f['field']}", "target": f["target"], "field": f["field"],
                       "value": f.get("value"), "est": f.get("est", True), "basis": f.get("basis"), **base}
                _upsert(OVERRIDES_SCOUT, rec)
                changes.append({"file": "scout/out/overrides_scout.json", "what": f"{f['target']}.{f['field']} = {f.get('value')}"})

    elif kind == "verify":
        for i, f in enumerate(res["fixes"]):
            auto = f["type"] in ("ticker-rename", "ticker-delisted", "ticker-merged") and res["conf"] >= float(cfg.get("min_conf_verified", 0.7)) and ok_src
            rec = {"id": f"{task['id']}-{i}", "type": f["type"], "ticker": f.get("ticker"), "new": f.get("new"),
                   "effective_date": f.get("effective_date"), "file": f.get("file"), "say": f.get("say"), "autoApply": auto,
                   "applied": False, "context": t, **base}
            _upsert(FIXES, rec)
            changes.append({"file": "scout/out/fixes.json", "what": f"{f.get('ticker') or ''} {f['type']}：{f.get('say') or ''}".strip()})

    else:  # ask
        rec = {"id": task["id"], "question": task.get("question"), "target": t, "answer": res["answer_zh"],
               "say": res["sharp_say"], "facts": res["facts"], "notes": res["fixes"], **base}
        _upsert(ANSWERS, rec)
        changes.append({"file": "scout/out/answers.json", "what": "回答了主人的问题"})
    return changes


# ════════════════════════════ one task end to end ════════════════════════════

def short_q(task: dict, limit: int = 24) -> str:
    q = (task.get("question") or "").strip()
    return q if len(q) <= limit else q[:limit] + "…"


def run_task(task: dict, cfg: dict | None = None, dry_run: bool = False) -> dict:
    """Run one task (already claimed by the queue). Returns an outcome dict; never raises."""
    cfg = cfg or load_config()
    t0 = time.time()
    tree = load_tree()
    meta = read_json(WEB_DATA / "meta.json", {}) or {}
    prompt, allowed, t = build_prompt(task, tree, meta)
    if not task.get("question"):
        task["question"] = default_question(task, t, tree)
    if dry_run:
        return {"ok": True, "dryRun": True, "prompt": prompt, "target": t}
    RUNS.mkdir(parents=True, exist_ok=True)
    run_path = RUNS / f"{task['id']}.json"
    env, res, err, changes, state = None, None, None, [], "failed"
    try:
        say(f"→ {task['kind']} {task['id']}: {short_q(task, 40)}")
        env = call_claude(prompt, cfg, kind=task["kind"], auto=task.get("source") != "owner")
        payload = extract_payload(env)
        res, issues = validate(task["kind"], payload, env, tree, allowed, cfg, t)
        changes = write_outputs(task, t, res, tree, meta, cfg)
        state = "done"
    except ScoutError as e:
        err = str(e)
        state = "invalid" if env else "failed"
    except Exception as e:                                       # noqa: BLE001 — keep the queue alive
        err = f"{e.__class__.__name__}: {e}"
    ms = int((time.time() - t0) * 1000)
    write_json(run_path, {"task": task, "target": t, "prompt": prompt, "envelope": env, "result": res,
                          "error": err, "ms": ms, "at": iso()})
    ok = state == "done"
    srcs = _sources(res) if res else []
    if ok:
        line = f"老风派侦察兵去查了：{short_q(task)} → 找到了：{res['sharp_say']}"
    else:
        line = f"老风派侦察兵去查了：{short_q(task)} → 没查成（{(err or '')[:40]}）"
    entry = {"id": task["id"], "kind": task["kind"], "key": task.get("key"), "keys": task.get("keys") or [],
             "target": t, "question": task.get("question"), "source": task.get("source", "auto"),
             "askedAt": task.get("startedAt") or task.get("createdAt"), "finishedAt": iso(), "ok": ok, "state": state,
             "line": line, "say": res["sharp_say"] if res else None,
             "found": res["answer_zh"][:500] if res else None, "conf": res["conf"] if res else None,
             "sources": [{"url": s["url"], "ok": s.get("ok")} for s in srcs], "changes": changes,
             "issues": res["issues"] if res else [], "ms": ms,
             "costUsd": (env or {}).get("total_cost_usd"), "webSearches": res["webSearches"] if res else None,
             "turns": (env or {}).get("num_turns"), "model": cfg.get("model"), "error": err}
    entry["finishedLocal"] = owner_time(entry["finishedAt"], cfg)
    try:
        slog.append(entry)
    except Exception as e:                                       # noqa: BLE001
        say(f"could not write scout log: {e}")
    say(f"{'✓' if ok else '✗'} {task['kind']} {task['id']} in {ms / 1000:.0f}s: {line}")
    return {"ok": ok, "state": state, "error": err, "line": line, "say": entry["say"], "conf": entry["conf"],
            "answer": res["answer_zh"] if res else None, "sources": entry["sources"], "changes": changes,
            "issues": entry["issues"], "ms": ms, "costUsd": entry["costUsd"]}


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task-id")
    ap.add_argument("--kind", choices=["explain", "gap", "verify", "ask"])
    ap.add_argument("--target", help="node id / ticker, or JSON object")
    ap.add_argument("--question")
    ap.add_argument("--dry-run", action="store_true", help="print the prompt; no Claude call")
    ap.add_argument("--backfill-intel", action="store_true",
                    help="merge stored explain events (out/intel_events.json) missing from web/data/intel.json; "
                         "manual only — an event the owner deleted would come back")
    a = ap.parse_args(argv)
    if a.backfill_intel:
        done = backfill_intel()
        print(json.dumps({"pushed": done, "into": str(INTEL_WEB)}, ensure_ascii=False))
        return 0
    from scout import queue as squeue
    if a.task_id:
        out = squeue.run_one(a.task_id)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0 if out.get("ok") else 1
    if not a.kind:
        ap.error("--task-id or --kind is required")
    target = a.target
    if target and target.strip().startswith("{"):
        target = json.loads(target)
    task = {"id": "dry", "kind": a.kind, "target": target, "question": a.question, "source": "owner"}
    if a.dry_run:
        out = run_task(task, dry_run=True)
        print(out["prompt"])
        print("\n# target:", json.dumps(out["target"], ensure_ascii=False))
        return 0
    from scout import job
    out = job.start(a.kind, target, a.question, spawn=False, wait=True)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("state") in ("done", "cached") else 1


if __name__ == "__main__":
    sys.exit(main())
