"""Find the Polymarket markets that matter for one scenario sentence.

Order of preference:
  1. polymarket/search.py (owned by the Polymarket agent), if it exists and returns something;
  2. a local keyword match over polymarket.json (web/data/polymarket.json, or $MW_POLYMARKET_JSON);
  3. nothing — the scenario still runs, with an empty market list.

The owner's sentence never leaves this machine from here: option 2 only reads a local file.
Every market is normalised to:
  {id, slug, q, qZh, prob, d1, d7, d30, volume, endDate, tags, nodes:[{id,sign}], url}
where d1/d7/d30 are CHANGES in probability (e.g. +0.15 = up 15 points), or None.
"""
from __future__ import annotations

import importlib
import inspect
import json
import math
import os
import re
import sys
from pathlib import Path

from weather import ROOT, data_dir  # type: ignore  # (engine puts scenario/ on sys.path)

# Chinese words in the owner's sentence → English pattern in market questions.
TOPICS = {
    "fed": (["美联储", "联储", "降息", "加息", "利率", "基点", "FOMC", "鲍威尔", "货币政策", "宽松"],
            r"\bfed\b|fomc|rate cut|rate hike|interest rate|\bbps\b|basis point|powell|federal reserve"),
    "inflation": (["通胀", "CPI", "物价", "PCE"], r"inflation|\bcpi\b|\bpce\b"),
    "recession": (["衰退", "失业", "就业", "非农", "GDP", "经济"], r"recession|\bgdp\b|unemployment|jobs report|payroll"),
    "tariff": (["关税", "贸易战", "贸易", "进口", "出口管制", "制裁"], r"tariff|trade war|trade deal|trade agreement|import|export control|sanction"),
    "china": (["中国", "中美", "北京", "习近平", "台湾", "两岸"], r"china|chinese|\bxi\b|xi jinping|beijing|taiwan"),
    "ai": (["AI", "人工智能", "RSI", "AGI", "agent", "智能体", "大模型", "模型", "OpenAI", "Anthropic", "自我改进", "AI 研究"],
           r"\bai\b|artificial intelligence|\bagi\b|openai|anthropic|\bgpt|claude|gemini|\bxai\b|grok|\bllm|superintelligen|deepmind|deepseek|ai model"),
    "chips": (["英伟达", "芯片", "算力", "GPU", "半导体", "台积电", "内存"], r"nvidia|\bchip|semiconductor|\bgpu|tsmc|\bnvda"),
    "bigtech": (["微软", "谷歌", "苹果", "亚马逊", "Meta", "特斯拉", "市值"], r"microsoft|google|alphabet|apple|amazon|\bmeta\b|tesla|market cap|largest company|\bipo\b"),
    "crypto": (["比特币", "加密", "以太坊", "币", "BTC", "ETH"], r"bitcoin|\bbtc\b|ethereum|\beth\b|crypto|solana|stablecoin"),
    "oil": (["石油", "原油", "油价", "OPEC", "能源", "天然气"], r"\boil\b|opec|crude|brent|\bwti\b|natural gas|gas price"),
    "mideast": (["中东", "伊朗", "以色列", "沙特"], r"iran|israel|gaza|middle east|saudi|hezbollah|houthi"),
    "russia": (["俄罗斯", "乌克兰", "俄乌", "普京"], r"russia|ukraine|putin|zelensk"),
    "uspol": (["大选", "选举", "国会", "特朗普", "总统", "政府关门", "中期"], r"election|trump|president|congress|senate|\bhouse\b|shutdown|midterm"),
    "stocks": (["股市", "标普", "纳指", "崩盘", "美股"], r"s&p|\bspx\b|nasdaq|stock market|\bdow\b"),
    "gold": (["黄金", "金价", "白银"], r"\bgold\b|silver"),
    "debt": (["国债", "美债", "收益率", "赤字"], r"treasury|yield|10-year|deficit|debt ceiling"),
    "jobs_ai": (["换人", "裁员", "白领", "失业"], r"layoff|unemployment|jobs"),
    "power": (["电力", "电网", "核电", "发电", "数据中心", "机房", "缺电", "电价", "停电", "用电"],
              r"data ?cent|electric|power grid|\bgrid\b|nuclear (?:power|plant|reactor|energy)|moratorium|"
              r"\bsmr\b|utility|utilities|blackout"),
}

# a topic in the owner's sentence → map regions whose markets matter (overlap with a market's nodes)
TOPIC_NODES = {"power": ["ai-power", "energy-gas"], "chips": ["ai-compute"], "ai": ["ai-cloud", "software"],
               "fed": ["bonds", "cash", "finance"], "debt": ["bonds"], "gold": ["commod-gold"],
               "oil": ["commod-oil", "energy"], "crypto": ["crypto"], "china": ["intl-china"],
               "jobs_ai": ["software-itsvc"]}

# words in the owner's sentence that mean "an AI milestone": markets flagged milestone=true get a bonus
MILESTONE_RE = r"RSI|AGI|自我改进|自己做.{0,8}研究|AI 研究|超级智能|奇点|千禧年|agent|智能体|连续干"


def _f(x):
    try:
        x = float(x)
        return None if (math.isnan(x) or math.isinf(x)) else x
    except (TypeError, ValueError):
        return None


def normalize(m: dict) -> dict | None:
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

    def chg(key, ago_key, api_key):
        # Prefer an explicit "probability N days ago"; else a change; else the gamma API change field.
        if m.get(ago_key) is not None and _f(m.get(ago_key)) is not None:
            return round(prob - _f(m[ago_key]), 4)
        v = _f(m.get(key))
        if v is None:
            v = _f(m.get(api_key))
        return None if v is None else round(v, 4)

    nodes = []
    for n in m.get("nodes") or []:
        if isinstance(n, dict) and n.get("id"):
            nodes.append({"id": n["id"], "sign": 1 if (_f(n.get("sign")) or 1) >= 0 else -1})
        elif isinstance(n, str):
            nodes.append({"id": n, "sign": 1})
    return {
        "id": str(mid), "slug": m.get("slug") or "", "q": q, "qZh": m.get("qZh") or m.get("q_zh") or q,
        "prob": round(prob, 4),
        "d1": chg("d1", "prob1d", "oneDayPriceChange"),
        "d7": chg("d7", "prob7d", "oneWeekPriceChange"),
        "d30": chg("d30", "prob30d", "oneMonthPriceChange"),
        "volume": _f(m.get("volume") or m.get("volumeNum")) or 0.0,
        "endDate": str(m.get("endDate") or m.get("end") or "")[:10],
        "tags": m.get("tags") or [], "nodes": nodes, "event": str(m.get("event") or "") or None,
        "milestone": bool(m.get("milestone")), "cat": m.get("cat"),
        "url": m.get("url") or (("https://polymarket.com/event/" + m["slug"]) if m.get("slug") else ""),
        **({"matchScore": m["matchScore"]} if m.get("matchScore") is not None else {}),
        **({"why": m["why"]} if m.get("why") else {}),
    }


MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
          "october", "november", "december"]

# finer hints: a word in the sentence → a pattern that should also be in the question (+1 each)
HINTS = [
    (r"降息|减息|宽松", r"decrease|\bcut"),
    (r"加息|收紧", r"increase|hike"),
    (r"不降|按兵不动|维持", r"no change|pause|hold"),
    (r"入侵|武统|攻台|封锁", r"invade|invasion|blockade"),
    (r"上市|IPO", r"\bipo\b"),
    (r"AGI|通用人工智能|RSI|自我改进|自己做.{0,8}研究|AI 研究|超级智能|奇点",
     r"\bagi\b|superintelligen|self-improv|recursive|automat|solved by ai|ai research|singularity|millennium prize"),
    (r"瓶颈|缺电|不够用|限电", r"moratorium|shortage|blackout|price|capacity"),
    (r"agent|智能体|连续干|自主", r"\bagents?\b|autonom"),
    (r"换人|裁员|失业|白领", r"layoff|unemploy|jobs"),
    (r"最好的模型|最强模型|排行", r"best ai model|top \d ai model"),
    (r"升级|大幅|加征|报复", r"increase|raise|impose|escalat|\d+%"),
    (r"协议|谈成|达成|休战", r"deal|agreement|truce"),
]


def _hint_score(text: str, q: str) -> float:
    s = 0.0
    for zh, en in HINTS:
        if re.search(zh, text, re.I) and re.search(en, q, re.I):
            s += 1.0
    for mo in re.findall(r"(\d{1,2})\s*月", text):
        k = int(mo)
        if 1 <= k <= 12 and MONTHS[k - 1] in q.lower():
            s += 1.0
    for y in set(re.findall(r"20\d\d", text)):
        if y in q:
            s += 0.5
    for num in set(re.findall(r"(\d+)\s*个?\s*(?:基点|bp|bps)", text, re.I)):
        if re.search(rf"\b{num}\+?\s*bps|{num} basis", q, re.I):
            s += 1.5
    return s


def _topics_in(text: str) -> list[str]:
    low = text.lower()
    return [k for k, (zh, _) in TOPICS.items() if any(w.lower() in low for w in zh)]


def _bigrams(s: str) -> set[str]:
    s = re.sub(r"\s+", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1) if re.search(r"[一-鿿]", s[i:i + 2])}


_TREE_NAMES: list[tuple[str, str]] | None = None


def _tree_names(ddir=None) -> list[tuple[str, str]]:
    """[(node id, name without 'AI ')] for every region of the map, to match the owner's words."""
    global _TREE_NAMES
    if _TREE_NAMES is None:
        out = []
        try:
            t = json.loads((data_dir(ddir) / "tree.json").read_text())
            stack = [t]
            while stack:
                n = stack.pop()
                if n.get("kind") != "stock" and n.get("id") != "world":
                    nm = re.sub(r"^AI\s*", "", str(n.get("name") or "")).strip()
                    if len(nm) >= 2:
                        out.append((n["id"], nm))
                stack.extend(n.get("children") or [])
        except Exception:
            pass
        _TREE_NAMES = out
    return _TREE_NAMES


def text_nodes(text: str, ddir=None) -> set[str]:
    """Map regions the owner's sentence names (by Chinese name), plus their id prefixes."""
    hit = set()
    for nid, nm in _tree_names(ddir):
        if nm in text or (len(nm) >= 3 and len(_bigrams(nm) & _bigrams(text)) >= 2):
            hit.add(nid)
    return hit


def _node_overlap(m: dict, want: set[str]) -> int:
    k = 0
    for n in m.get("nodes") or []:
        nid = n.get("id") if isinstance(n, dict) else str(n)
        if any(nid == w or nid.startswith(w + "-") or w.startswith(nid + "-") for w in want):
            k += 1
    return k


_STOP = {"will", "the", "a", "an", "by", "in", "of", "to", "on", "be", "before", "after", "at", "for", "?"}


def _shape(q: str) -> set[str]:
    """The question's template: lower-case words without numbers or Capitalised names."""
    ws = re.findall(r"[A-Za-z][A-Za-z'+.-]*", q)
    return {w.lower() for w in ws if not w[0].isupper() and w.lower() not in _STOP} or {q.lower()[:20]}


def local_rank(text: str, markets: list[dict], k: int = 12, ddir=None) -> list[dict]:
    from datetime import date as _d, timedelta as _td
    topics = _topics_in(text)
    tb = _bigrams(text)
    want = text_nodes(text, ddir) | {n for t in topics for n in TOPIC_NODES.get(t, [])}
    milestone = bool(re.search(MILESTONE_RE, text, re.I))
    soon = (_d.today() + _td(days=7)).isoformat()
    scored = []
    for m in markets:
        q = (m.get("q") or "") + " " + " ".join(t for t in m.get("tags") or [] if isinstance(t, str))
        hit = [t for t in topics if re.search(TOPICS[t][1], q, re.I)]
        ov = _node_overlap(m, want) if want else 0
        if not hit and not ov:
            continue
        s = 2.0 * len(hit) + _hint_score(text, m.get("q") or "") + min(3.0, 1.0 * ov)
        if milestone and m.get("milestone"):
            s += 1.5
        if m.get("endDate") and m["endDate"] < soon and not re.search(r"\d{1,2}\s*月\s*\d{1,2}", text):
            s -= 2.0  # resolves within a week: says nothing about the owner's date
        if tb and m.get("qZh") and m["qZh"] != m.get("q"):
            s += min(2.0, 0.25 * len(tb & _bigrams(m["qZh"])))
        s += 0.25 * math.log10(max(1.0, m.get("volume") or 1.0))
        if m.get("prob") is not None and 0.02 < m["prob"] < 0.98:
            s += 0.5  # an undecided market says more than a settled one
        if m.get("d7") is not None:
            s += min(1.0, 4 * abs(m["d7"]))
        scored.append((s, m))
    scored.sort(key=lambda x: -x[0])
    out, seen_slug, shapes = [], {}, []
    for s, m in scored:
        # near-duplicate questions (same template, another state / date / company): at most 2
        w = _shape(m.get("q") or "")
        if sum(1 for x in shapes if len(w & x) / max(1, len(w | x)) >= 0.6) >= 2:
            continue
        # keep at most 3 outcomes of the same multi-outcome event (e.g. "3 / 4 / 5 cuts in 2026")
        ev = m.get("event") or re.sub(r"-\d+$", "", m.get("url") or m.get("slug") or m["id"])
        if seen_slug.get(ev, 0) >= 3:
            continue
        seen_slug[ev] = seen_slug.get(ev, 0) + 1
        shapes.append(w)
        out.append(dict(m, matchScore=round(s, 2)))
        if len(out) >= k:
            break
    return out


def _try_search_module(text: str, k: int):
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        mod = importlib.import_module("polymarket.search")
    except Exception:
        return None
    for name in ("search", "search_markets", "find_markets", "relevant", "match"):
        fn = getattr(mod, name, None)
        if not callable(fn):
            continue
        try:
            params = inspect.signature(fn).parameters
            kw = {}
            for kname in ("k", "limit", "n", "top"):
                if kname in params:
                    kw[kname] = k
                    break
            res = fn(text, **kw)
        except Exception:
            continue
        if isinstance(res, dict):
            res = res.get("markets") or res.get("results") or []
        if isinstance(res, list):
            out = [x for x in (normalize(r) for r in res if isinstance(r, dict)) if x]
            return out[:k]
    return None


def polymarket_file(ddir=None) -> Path:
    """$MW_POLYMARKET_JSON, else <data>/polymarket.json, else polymarket/out/polymarket.json."""
    env = os.environ.get("MW_POLYMARKET_JSON")
    if env:
        return Path(env)
    for fp in (data_dir(ddir) / "polymarket.json", ROOT / "polymarket" / "out" / "polymarket.json"):
        if fp.exists():
            return fp
    return data_dir(ddir) / "polymarket.json"


_FILE_CACHE: dict = {}


def _read_file(ddir=None) -> dict | None:
    fp = polymarket_file(ddir)
    if not fp.exists():
        return None
    try:
        key = (str(fp), fp.stat().st_mtime)
        if key not in _FILE_CACHE:
            _FILE_CACHE.clear()
            _FILE_CACHE[key] = json.loads(fp.read_text())
        return _FILE_CACHE[key]
    except Exception:
        return None


def load_all(ddir=None) -> tuple[list[dict], str | None]:
    d = _read_file(ddir)
    if not d:
        return [], None
    raw = [dict(m) for m in (d.get("markets") or []) if isinstance(m, dict)]
    _levels_to_changes(raw)
    ms = [x for x in (normalize(m) for m in raw) if x]
    return ms, d.get("asOf")


def _levels_to_changes(raw: list[dict]):
    """DESIGN §10 names the fields d1/d7/d30. They should be changes; if a file instead stores the
    probability N days ago under those names (never negative, often large), convert in place."""
    for key in ("d1", "d7", "d30"):
        vals = [(m, m.get(key)) for m in raw if isinstance(m.get(key), (int, float))]
        if len(vals) < 20:
            continue
        neg = sum(1 for _, v in vals if v < 0)
        big = sum(1 for _, v in vals if v > 0.3)
        if neg == 0 and big >= len(vals) * 0.2:
            for m, v in vals:
                pr = _f(m.get("prob"))
                if pr is not None:
                    m[key] = round(pr - v, 4)


def _diversify(cands: list[dict], k: int, text: str) -> list[dict]:
    """Keep the list useful to the model: ≤ 3 outcomes per event, ≤ 2 questions of one template
    (five states' moratoriums are one signal), nothing that resolves within a week unless the owner
    named a day."""
    from datetime import date as _d, timedelta as _td
    soon = (_d.today() + _td(days=7)).isoformat()
    day_named = bool(re.search(r"\d{1,2}\s*月\s*\d{1,2}\s*[日号]", text))
    out, per_ev, shapes = [], {}, []
    for m in cands:
        if m.get("endDate") and m["endDate"] < soon and not day_named:
            continue
        ev = m.get("event") or re.sub(r"-\d+$", "", m.get("url") or m.get("slug") or m["id"])
        if per_ev.get(ev, 0) >= 3:
            continue
        w = _shape(m.get("q") or "")
        if sum(1 for x in shapes if len(w & x) / max(1, len(w | x)) >= 0.6) >= 2:
            continue
        per_ev[ev] = per_ev.get(ev, 0) + 1
        shapes.append(w)
        out.append(m)
        if len(out) >= k:
            break
    return out


def find_markets(text: str, k: int = 12, ddir=None) -> dict:
    """→ {source, asOf, markets:[normalised]}: polymarket/search.py first, then the local match,
    merged and thinned out (_diversify)."""
    res = _try_search_module(text, 3 * k) or []
    ms, asof = load_all(ddir)
    if res:
        full = {m["id"]: m for m in ms}
        # the search module may return thin rows: fill in what the full file knows (nodes, d7, event…)
        res = [dict(full.get(m["id"], {}), **{kk: v for kk, v in m.items() if v not in (None, "", [])}) for m in res]
    seen = {m["id"] for m in res}
    local = [m for m in local_rank(text, ms, 3 * k, ddir) if m["id"] not in seen] if ms else []
    out = _diversify(res + local, k, text)
    if not out:
        return {"source": None, "asOf": asof, "markets": []}
    n_search = sum(1 for m in out if m["id"] in seen)
    src = ("polymarket/search.py" + (" + 本地匹配" if n_search < len(out) else "")) if n_search else \
        str(polymarket_file(ddir).name)
    return {"source": src, "asOf": asof, "markets": out}


def by_id(ddir=None) -> dict[str, dict]:
    ms, _ = load_all(ddir)
    return {m["id"]: m for m in ms}


def find_ladders(text: str, k: int = 4, ddir=None) -> list[dict]:
    """Date ladders ("… by …?" events: one market per deadline) that put a date on the owner's sentence.
    → [{id, title, titleZh, cat, volume, p50, ladder:[{date, prob, d7, id}], say}] best first."""
    d = _read_file(ddir) or {}
    evs = [e for e in d.get("events") or [] if isinstance(e, dict) and e.get("ladder")]
    if not evs:
        return []
    ms = {m["id"]: m for m in load_all(ddir)[0]}
    topics = _topics_in(text)
    want = text_nodes(text, ddir) | {n for t in topics for n in TOPIC_NODES.get(t, [])}
    milestone = bool(re.search(MILESTONE_RE, text, re.I))
    scored = []
    for e in evs:
        title = str(e.get("title") or "")
        hit = [t for t in topics if re.search(TOPICS[t][1], title, re.I)]
        members = [ms[i] for i in e.get("markets") or [] if i in ms]
        ov = max((_node_overlap(m, want) for m in members), default=0) if want else 0
        if not hit and not ov:
            continue
        sc = 2.0 * len(hit) + _hint_score(text, title) + min(3.0, ov)
        if milestone and e.get("milestone"):
            sc += 1.5
        sc += 0.25 * math.log10(max(1.0, float(e.get("volume") or 1.0)))
        if sc >= 4.5:  # a ladder that only shares a loose node link says nothing about this date
            scored.append((sc, e))
    scored.sort(key=lambda x: -x[0])
    out, shapes = [], []
    for sc, e in scored:
        w = _shape(e.get("title") or "")
        if any(len(w & x) / max(1, len(w | x)) >= 0.6 for x in shapes):
            continue  # one ladder per template (not five states' moratoriums)
        shapes.append(w)
        lad = sorted(({"date": str(x.get("date") or "")[:10], "prob": x.get("prob"), "d7": x.get("d7"),
                       "id": x.get("id"), "label": x.get("label")} for x in e["ladder"] if x.get("date")),
                     key=lambda x: x["date"])
        out.append({"id": str(e.get("id")), "title": e.get("title"), "titleZh": e.get("titleZh") or e.get("title"),
                    "cat": e.get("cat"), "volume": e.get("volume"), "p50": e.get("p50"), "ladder": lad,
                    "say": e.get("say"), "matchScore": round(sc, 2)})
        if len(out) >= k:
            break
    return out
