"""intel/links.py — what else an intel item can be tied to: Polymarket markets and saved scenarios.

Both are optional. If nothing exists yet, both return [] and ingest carries on.

Polymarket candidates (before the Claude call, so Claude only picks among real markets):
  1. polymarket/search.py, if importable (owned by the Polymarket agent; signature probed defensively,
     run in a thread with a time cap so a slow network call cannot stall ingest);
  2. a local keyword match over web/data/polymarket.json (Chinese topic words → English patterns,
     plus Chinese bigrams against the translated question).
Probabilities shown to the owner always come from this data, never from Claude.

Saved scenarios: web/data/scenarios/*.json and scenario/out/*.json (newest first, deduped by id).
"""
from __future__ import annotations

import importlib
import inspect
import json
import math
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PM_JSON = Path(os.environ.get("MW_POLYMARKET_JSON") or (ROOT / "web" / "data" / "polymarket.json"))
PM_FALLBACK = ROOT / "polymarket" / "out" / "polymarket.json"      # before update.sh copies it to web/data
SCENARIO_DIRS = [ROOT / "web" / "data" / "scenarios", ROOT / "scenario" / "out"]

# Chinese words → English regex over market questions
TOPICS: dict[str, tuple[list[str], str]] = {
    "fed": (["美联储", "联储", "降息", "加息", "利率", "基点", "FOMC", "鲍威尔", "议息"],
            r"\bfed\b|fomc|rate cut|rate hike|interest rate|\bbps\b|basis point|powell|federal reserve"),
    "inflation": (["通胀", "CPI", "物价", "PCE"], r"inflation|\bcpi\b|\bpce\b"),
    "recession": (["衰退", "失业率", "非农", "GDP", "就业"], r"recession|\bgdp\b|unemployment|jobs report|payroll"),
    "tariff": (["关税", "贸易战", "贸易协议", "出口管制", "制裁"],
               r"tariff|trade war|trade deal|export control|sanction"),
    "china": (["中国", "中美", "北京", "台湾", "两岸"], r"china|chinese|\bxi\b|beijing|taiwan"),
    "ai": (["AI", "人工智能", "RSI", "AGI", "agent", "智能体", "大模型", "OpenAI", "Anthropic", "Claude", "GPT",
            "Gemini", "自我改进", "AI 研究"],
           r"\bai\b|artificial intelligence|\bagi\b|openai|anthropic|\bgpt|claude|gemini|\bxai\b|grok|"
           r"superintelligen|deepmind|deepseek|ai model"),
    "chips": (["英伟达", "芯片", "算力", "GPU", "半导体", "台积电", "内存", "HBM"],
              r"nvidia|\bchip|semiconductor|\bgpu|tsmc|\bnvda"),
    "bigtech": (["微软", "谷歌", "苹果", "亚马逊", "Meta", "特斯拉", "市值", "上市", "IPO"],
                r"microsoft|google|alphabet|apple|amazon|\bmeta\b|tesla|market cap|largest company|\bipo\b"),
    "crypto": (["比特币", "加密", "以太坊", "BTC", "ETH", "稳定币"],
               r"bitcoin|\bbtc\b|ethereum|\beth\b|crypto|solana|stablecoin"),
    "oil": (["石油", "原油", "油价", "OPEC", "天然气"], r"\boil\b|opec|crude|brent|\bwti\b|natural gas"),
    "mideast": (["中东", "伊朗", "以色列", "沙特", "胡塞"], r"iran|israel|gaza|middle east|saudi|hezbollah|houthi"),
    "russia": (["俄罗斯", "乌克兰", "俄乌", "普京"], r"russia|ukraine|putin|zelensk"),
    "uspol": (["大选", "选举", "国会", "特朗普", "白宫", "政府关门", "中期"],
              r"election|trump|president|congress|senate|shutdown|midterm"),
    "stocks": (["股市", "标普", "纳指", "崩盘", "美股"], r"s&p|\bspx\b|nasdaq|stock market|\bdow\b"),
    "gold": (["黄金", "金价", "白银"], r"\bgold\b|silver"),
    "debt": (["国债", "美债", "收益率", "赤字"], r"treasury|yield|10-year|deficit|debt ceiling"),
    "jobs_ai": (["换人", "裁员", "白领"], r"layoff|unemployment|jobs"),
}
_STOP = set("""the a an of to in on for and or is are be by with will at from as that this it its was were has
have had not but than more most into over after before about what when which who how new says said would could
should may might can just also year years month months week weeks today market markets""".split())


def _f(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _norm_market(m: Any) -> dict | None:
    if not isinstance(m, dict):
        return None
    mid = m.get("id") or m.get("conditionId") or m.get("slug")
    q = m.get("q") or m.get("question") or m.get("title")
    prob = _f(m.get("prob", m.get("p")))
    if prob is None and m.get("outcomePrices"):
        try:
            op = m["outcomePrices"]
            op = json.loads(op) if isinstance(op, str) else op
            prob = _f(op[0])
        except Exception:
            prob = None
    if not mid or not q or prob is None:
        return None
    nodes = []
    for n in m.get("nodes") or []:
        if isinstance(n, dict) and isinstance(n.get("id"), str):
            nodes.append({"id": n["id"], "sign": 1 if (_f(n.get("sign")) or 1) >= 0 else -1})
    return {"id": str(mid), "q": str(q)[:240], "qZh": str(m.get("qZh") or "")[:160], "prob": round(prob, 4),
            "d7": _f(m.get("d7")), "volume": _f(m.get("volume")), "endDate": str(m.get("endDate") or "")[:10],
            "url": m.get("url") or (f"https://polymarket.com/event/{m['slug']}" if m.get("slug") else None),
            "nodes": nodes}


def _pm_module_search(text: str, limit: int, timeout_s: float = 8.0) -> list[dict]:
    """Ask polymarket/search.py if it exists. Probe a few likely function names/signatures."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    try:
        mod = importlib.import_module("polymarket.search")
    except Exception:
        return []
    fn = None
    for name in ("search", "search_markets", "find_markets", "match", "find"):
        f = getattr(mod, name, None)
        if callable(f):
            fn = f
            break
    if fn is None:
        return []
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            params = inspect.signature(fn).parameters
            kw = {}
            for k in ("limit", "k", "n", "top", "top_k"):
                if k in params:
                    kw[k] = limit
                    break
            box["r"] = fn(text, **kw)
        except Exception as e:  # the other module is optional — never fail ingest on it
            box["e"] = e

    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout_s)
    r = box.get("r")
    if isinstance(r, dict):
        r = r.get("markets") or r.get("results") or []
    out = []
    for m in r or []:
        if isinstance(m, dict) and isinstance(m.get("market"), dict):
            m = m["market"]
        nm = _norm_market(m)
        if nm:
            out.append(nm)
    return out[:limit]


def _bigrams(s: str) -> set[str]:
    cjk = re.findall(r"[一-鿿]+", s or "")
    out = set()
    for run in cjk:
        out |= {run[i:i + 2] for i in range(len(run) - 1)}
    return out


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z0-9&'-]{2,}", (s or "").lower()) if w not in _STOP}


def _pm_local(text: str, node_hint: set[str], limit: int) -> list[dict]:
    data = None
    for path in ([PM_JSON] if os.environ.get("MW_POLYMARKET_JSON") else [PM_JSON, PM_FALLBACK]):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            break
        except (OSError, ValueError):
            continue
    if data is None:
        return []
    markets = data.get("markets") if isinstance(data, dict) else data
    if not isinstance(markets, list):
        return []
    topics = []
    low = text.lower()
    for key, (zh, rx) in TOPICS.items():
        if any((w.lower() in low) for w in zh) or re.search(rx, low):
            topics.append(re.compile(rx, re.I))
    tw, tb = _words(text), _bigrams(text)
    scored = []
    for raw in markets:
        m = _norm_market(raw)
        if not m:
            continue
        q = m["q"]
        s = 0.0
        s += 1.5 * sum(1 for rx in topics if rx.search(q))
        s += 0.5 * len(tw & _words(q))
        s += 0.35 * len(tb & _bigrams(m["qZh"]))
        if node_hint and any(n["id"] in node_hint for n in m["nodes"]):
            s += 1.0
        if s < 1.5:
            continue
        s += 0.15 * math.log10(max(m["volume"] or 1.0, 1.0))
        scored.append((s, m))
    scored.sort(key=lambda x: -x[0])
    return [m for _, m in scored[:limit]]


def polymarket_candidates(text: str, node_hint: set[str] | None = None, limit: int = 15) -> list[dict]:
    """Up to `limit` markets that might relate to the text. [] if no Polymarket data exists."""
    text = (text or "")[:6000]
    out, seen = [], set()
    for m in _pm_module_search(text, limit) + _pm_local(text, node_hint or set(), limit):
        if m["id"] not in seen:
            seen.add(m["id"])
            out.append(m)
    return out[:limit]


# ─────────────────────────────────────── saved scenarios ──────────────────────────────────────
def _scenario_core(d: dict) -> dict:
    for k in ("result", "scenario", "data"):
        if isinstance(d.get(k), dict) and (d[k].get("root") or d[k].get("title")):
            inner = dict(d[k])
            for kk in ("id", "createdAt", "created"):
                if kk in d and kk not in inner:
                    inner[kk] = d[kk]
            return inner
    return d


def saved_scenarios(limit: int = 12) -> list[dict]:
    """[{id, title, root:{text,date,tier}, killSignals:[{by,signal}], impacts:[{id,dir}]}], newest first."""
    files = []
    for d in SCENARIO_DIRS:
        if d.is_dir():
            files += [f for f in d.glob("*.json") if not f.name.startswith(".") and f.name != "index.json"
                      and not f.name.endswith((".raw.json", ".status.json", ".in.json"))]
    files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    out, seen = [], set()
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        d = _scenario_core(d)
        sid = str(d.get("id") or f.stem)
        if sid in seen:
            continue
        root = d.get("root") if isinstance(d.get("root"), dict) else {}
        title = str(d.get("title") or root.get("text") or "")[:80]
        if not title:
            continue
        seen.add(sid)
        ks = [{"by": str(k.get("by") or "")[:10], "signal": str(k.get("signal") or "")[:120]}
              for k in (d.get("killSignals") or []) if isinstance(k, dict) and k.get("signal")][:4]
        imps = [{"id": i.get("id"), "dir": i.get("dir")} for i in (d.get("impacts") or [])
                if isinstance(i, dict) and isinstance(i.get("id"), str)][:8]
        out.append({"id": sid, "title": title, "root": {"text": str(root.get("text") or "")[:120],
                                                        "date": str(root.get("date") or ""),
                                                        "tier": str(root.get("tier") or "")},
                    "killSignals": ks, "impacts": imps})
        if len(out) >= limit:
            break
    return out
