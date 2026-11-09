"""polymarket/search.py: find the Polymarket markets that matter for a free-text judgment. Fast, local, no LLM.

    from polymarket.search import search, by_node
    search("美联储 12 月降息 50 个基点", k=8)          → [market dict + matchScore + why], best first
    search("2026 年 11 月实现 RSI，AI 开始自己做 AI 研究")
    by_node("ai-compute-memory", k=5)                 → markets mapped to that territory (or below it)

    python3 polymarket/search.py "台海开战" [-k 10]

Market dicts are the records of polymarket.json (web/data/, else polymarket/out/): id, slug, q, qZh,
prob, d1, d7, d30 (changes), volume, endDate, cat, tags, nodes:[{id, sign}], url, ...
Matching: concept words (Chinese and English, rules.CONCEPT_ZH) against each market's tags; English
words against the question; Chinese bigrams against qZh; territory names / tickers against the
market's nodes; month / year / bps hints. At most 3 outcomes of one event are returned.
"""
from __future__ import annotations

import json
import math
import re
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if __package__ in (None, ""):
    sys.path.insert(0, str(HERE))
    import rules as RU  # type: ignore
    import translate as TR  # type: ignore
else:
    from . import rules as RU
    from . import translate as TR

FILES = [ROOT / "web" / "data" / "polymarket.json", HERE / "out" / "polymarket.json"]
TREE = ROOT / "web" / "data" / "tree.json"

GENERIC = {"ai", "geopolitics", "politics", "stocks", "crypto", "macro", "milestone", "trade", "energy",
           "commodities", "bigtech", "earnings", "other", "election", "war"}
STOP = {"the", "will", "and", "for", "with", "that", "this", "from", "into", "before", "after", "by", "be", "of",
        "in", "on", "at", "to", "a", "an", "is", "are", "what", "which", "who", "when", "how", "end", "year",
        "price", "hit", "reach", "than", "more", "less", "any", "new", "next", "its", "their", "out"}
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]
HINTS = [
    (r"降息|减息|宽松|放水|\bcut", r"decrease|\bcuts?\b|lower"),
    (r"加息|收紧|\bhike", r"increase|hike|raise"),
    (r"不降|按兵不动|维持不变|不动", r"no change|pause|hold"),
    (r"入侵|武统|攻台|开战|打仗", r"invade|invasion|war\b|clash"),
    (r"封锁", r"blockade|clos"),
    (r"停火|和谈|和平|休战", r"ceasefire|peace|truce|talks"),
    (r"上市|IPO", r"\bipo\b"),
    (r"估值", r"valuation|market cap"),
    (r"AGI|通用人工智能|超级智能|ASI", r"\bagi\b|superintelligen|\bssi\b|\basi\b"),
    (r"RSI|自我改进|自我迭代|递归|自己做.{0,6}研究|AI ?研究|自己改进", r"self.?improv|recursive|automated ai research|ai research"),
    (r"agent|智能体|代理|连续干|自主", r"\bagents?\b|autonom"),
    (r"换人|裁员|失业|白领", r"layoff|unemploy|jobs"),
    (r"最好的模型|最强模型|排行|第一", r"best ai model|#1|top \d"),
    (r"发布|上线|推出", r"releas|launch"),
    (r"破产|爆雷|倒闭", r"bankrupt"),
    (r"泡沫|崩", r"bubble|crash|burst"),
    (r"禁令|暂停", r"moratorium|ban\b|pause"),
    (r"加征|升级|报复", r"increase|raise|impose|escalat|\d+%"),
    (r"协议|谈成|达成", r"deal|agreement"),
    (r"新高|历史高", r"all.time high|\bath\b"),
    (r"跌破|下跌|跌到", r"dip|below|\(low\)|↓"),
    (r"涨到|突破|上涨|冲上", r"reach|above|\(high\)|↑"),
    (r"年底|年末|今年", r"december 31|end of (the )?year|end of 20\d\d|in 20\d\d|before 20\d\d"),
]
# Chinese proper nouns → English words in the questions (countries, companies, people, assets)
ZH_EN: dict[str, list[str]] = {}
for _en, _zh in list(TR.COUNTRIES.items()) + list(TR.NAMES.items()):
    if len(_en) >= 3 and re.search(r"[\u4e00-\u9fff]", _zh):
        ZH_EN.setdefault(_zh, []).append(_en)
ZH_EN.update({"霍尔木兹": ["hormuz"], "胡塞": ["houthi", "houthis"], "红海": ["red sea", "bab el-mandeb"],
              "格陵兰": ["greenland"], "鲍威尔": ["powell"], "沃什": ["warsh"], "马斯克": ["musk", "elon"],
              "奥特曼": ["altman"], "特朗普": ["trump"], "普京": ["putin"], "泽连斯基": ["zelenskyy", "zelensky"],
              "原油": ["crude", "oil", "wti"], "油价": ["oil", "crude", "wti"], "铀": ["uranium"], "铜": ["copper"],
              "稳定币": ["stablecoin", "stablecoins"], "英伟达": ["nvidia"], "台积电": ["tsmc"], "美光": ["micron"],
              "博通": ["broadcom"], "甲骨文": ["oracle"], "英特尔": ["intel"], "苹果": ["apple"], "亚马逊": ["amazon"],
              "微软": ["microsoft"], "谷歌": ["google", "gemini"], "特斯拉": ["tesla"], "字节": ["bytedance"],
              "阿里": ["alibaba", "qwen"], "月之暗面": ["moonshot", "kimi"], "智谱": ["z.ai", "glm"],
              "国债": ["treasury"], "收益率": ["yield"], "房贷": ["mortgage"], "失业率": ["unemployment"],
              "数据中心": ["data center"], "机房": ["data center"], "人形机器人": ["humanoid", "optimus"],
              "无人驾驶": ["robotaxi", "waymo", "self-driving"], "星舰": ["starship"], "量子": ["quantum"],
              "减肥药": ["glp-1", "retatrutide", "orforglipron"], "欧佩克": ["opec"]})
_ZH_UNITS = {"万亿": 1e12, "千亿": 1e11, "亿": 1e8, "万": 1e4, "千": 1e3}


def _numbers(text: str) -> set[float]:
    """'15 万' → 150000, '$150k' → 150000, '1.5 万亿' → 1.5e12, '5%' → 5."""
    out = set()
    for a, u in re.findall(r"(\d+(?:\.\d+)?)\s*(万亿|千亿|亿|万|千)", text or ""):
        out.add(round(float(a) * _ZH_UNITS[u], 6))
    for a, u in re.findall(r"\$?\s?(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?\b", (text or "").lower()):
        try:
            v = float(a.replace(",", "")) * {"k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12}.get(u or "", 1.0)
        except ValueError:
            continue
        if not (1990 <= v <= 2100 and not u):  # years are not numbers here
            out.add(round(v, 6))
    return {v for v in out if v >= 1}

_lock = threading.Lock()
_state = {"mtime": None, "path": None, "data": None, "idx": None, "tree": None}


# --------------------------------------------------------------------------------------------
def _concepts():
    out = []
    for tag, words in RU.CONCEPT_ZH.items():
        pats = []
        for w in set(words + [tag.replace("-", " ")]):
            w = w.strip().lower()
            if not w:
                continue
            if re.fullmatch(r"[a-z0-9 .&+\-]+", w):
                pats.append(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])")
            else:
                pats.append(re.escape(w))
        out.append((tag, re.compile("|".join(sorted(pats, key=len, reverse=True)), re.I)))
    return out


_CONCEPTS = _concepts()


def _bigrams(s: str) -> set[str]:
    s = re.sub(r"[\s，。、？！：；（）()“”\"'·｜|]+", "", s or "")
    return {s[i:i + 2] for i in range(len(s) - 1) if re.search(r"[一-鿿]", s[i:i + 2])}


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z0-9.\-]{2,}", (s or "").lower()) if w not in STOP}


def _tree_names():
    """name/ticker → node ids (regions and stocks), for 'which territory does the text talk about'."""
    try:
        d = json.loads(TREE.read_text())
    except Exception:
        return {}, {}
    names: dict[str, set[str]] = {}
    parent: dict[str, str] = {}

    def walk(n, par):
        nid = n.get("id")
        if not nid:
            return
        if par:
            parent[nid] = par
        nm = (n.get("name") or "").strip()
        if nm and len(nm) >= 2 and nid != "world":
            names.setdefault(nm.lower(), set()).add(nid)
        t = n.get("ticker")
        if t and len(t) >= 2:
            names.setdefault(t.lower(), set()).add(nid)
        for c in n.get("children") or []:
            walk(c, nid)

    walk(d, None)
    return names, parent


def _load():
    fp = next((f for f in FILES if f.exists()), None)
    if fp is None:
        return None
    mt = fp.stat().st_mtime
    with _lock:
        if _state["data"] is not None and _state["path"] == fp and _state["mtime"] == mt:
            return _state
        try:
            data = json.loads(fp.read_text())
        except Exception:
            return _state if _state["data"] is not None else None
        ev_title = {e["id"]: (e.get("title") or "", e.get("titleZh") or "") for e in data.get("events") or []}
        idx = []
        for m in data.get("markets") or []:
            t, tz = ev_title.get(m.get("event"), ("", ""))
            en = " ".join([m.get("q") or "", t, m.get("group") or ""]).lower()
            zh = (m.get("qZh") or "") + " " + tz if m.get("zhOk") else tz if tz != t else ""
            idx.append({"m": m, "en": en, "words": _words(en), "bi": _bigrams(zh), "tags": set(m.get("tags") or []),
                        "nodes": {n["id"] for n in m.get("nodes") or [] if isinstance(n, dict)}})
        names, parent = _tree_names()
        _state.update(mtime=mt, path=fp, data=data, idx=idx, tree=(names, parent))
        return _state


def _ancestors(nid: str, parent: dict) -> list[str]:
    out = []
    while nid in parent:
        nid = parent[nid]
        out.append(nid)
    return out


# --------------------------------------------------------------------------------------------
def analyze(text: str) -> dict:
    low = (text or "").lower()
    tags = [tag for tag, rx in _CONCEPTS if rx.search(low)]
    hints = [(zh, en) for zh, en in HINTS if re.search(zh, text or "", re.I)]
    months = set()
    for mo in re.findall(r"(\d{1,2})\s*月", text or ""):
        if 1 <= int(mo) <= 12:
            months.add(MONTHS[int(mo) - 1])
    for mo in MONTHS:
        if re.search(r"\b" + mo + r"\b|\b" + mo[:3] + r"\b", low):
            months.add(mo)
    years = set(re.findall(r"20\d\d", text or ""))
    bps = set(re.findall(r"(\d+)\s*个?\s*(?:基点|bps?|basis)", text or "", re.I))
    words = _words(low)
    for zh, ens in ZH_EN.items():
        if zh in (text or ""):
            for en in ens:
                words |= {en} if " " not in en else set()
                if " " in en:
                    words.add(en)
    nums = _numbers(text or "") - {float(b) for b in bps} - {float(m) for m in re.findall(r"(\d{1,2})\s*月", text or "")}
    return {"tags": tags, "hints": hints, "months": months, "years": years, "bps": bps,
            "words": words, "bi": _bigrams(text or ""), "nums": nums}


def search(text: str, k: int = 12, *, min_score: float = 2.0, cats: list[str] | None = None) -> list[dict]:
    """Markets most relevant to `text` (Chinese or English), best first. [] if nothing fits or no data."""
    st = _load()
    if not st or not text or not text.strip():
        return []
    q = analyze(text)
    names, parent = st["tree"]
    low = text.lower()
    node_hits: set[str] = set()
    for nm, ids in names.items():
        if len(nm) >= 2 and (nm in low if re.search(r"[一-鿿]", nm) else
                             re.search(r"(?<![a-z0-9])" + re.escape(nm) + r"(?![a-z0-9])", low)):
            if not re.fullmatch(r"[a-z]{2,3}", nm) or nm.upper() in (text or ""):  # short tickers only in CAPS
                node_hits |= ids
    node_hits_up = set(node_hits)
    for nid in node_hits:
        node_hits_up |= set(_ancestors(nid, parent)) - {"world", "us"}
    qtags = set(q["tags"])
    scored = []
    for it in st["idx"]:
        m = it["m"]
        if cats and m.get("cat") not in cats:
            continue
        why = []
        s = 0.0
        th = qtags & it["tags"]
        if th:
            s += sum(1.0 if t in GENERIC else 2.0 for t in th)
            why += sorted(th)
        wh = {w for w in q["words"] if (" " in w and w in it["en"]) or w in it["words"]}
        if wh:
            s += min(3.0, 1.0 * len(wh))
            why += sorted(wh)[:3]
        bh = len(q["bi"] & it["bi"])
        if bh >= 2:
            s += min(2.0, 0.3 * bh)
        nh = node_hits & it["nodes"]
        if nh:
            s += 2.0
            why.append("territory")
        elif node_hits_up & it["nodes"]:
            s += 0.8
        if s < 1.0:
            continue
        hint = 0.0
        for zh, en in q["hints"]:
            if re.search(en, it["en"], re.I):
                hint += 1.0
        if q["months"]:
            hit_mo = [mo for mo in q["months"] if mo in it["en"]]
            if hit_mo:
                hint += 1.5
            elif any(mo in it["en"] for mo in MONTHS):
                hint -= 1.0  # names another month than the one asked about
        for y in q["years"]:
            if y in it["en"] or y in (m.get("endDate") or ""):
                hint += 0.5
        for b in q["bps"]:
            if re.search(rf"\b{b}\+?\s*bps|{b} basis", it["en"]):
                hint += 2.0
        if q["nums"] and it.get("nums") is None:
            it["nums"] = _numbers(it["en"])
        if q["nums"] and q["nums"] & it["nums"]:
            hint += 1.5
        s += max(-1.5, min(5.0, hint))
        if s < min_score:
            continue
        vol = float(m.get("volume") or 0)
        s += 0.25 * math.log10(max(vol, 1000.0))
        p = m.get("prob")
        if p is not None and 0.03 < p < 0.97:
            s += 0.5
        if m.get("d7") is not None:
            s += min(1.0, 4 * abs(m["d7"]))
        scored.append((s, why, m))
    scored.sort(key=lambda x: -x[0])
    out, per_event = [], {}
    for s, why, m in scored:
        ev = m.get("event") or m.get("id")
        if per_event.get(ev, 0) >= 3:
            continue
        per_event[ev] = per_event.get(ev, 0) + 1
        out.append(dict(m, matchScore=round(s, 2), why=why[:6]))
        if len(out) >= k:
            break
    return out


def by_node(node_id: str, k: int = 10, include_below: bool = True) -> list[dict]:
    """Markets mapped to a territory (or, with include_below, to anything inside it), biggest first."""
    st = _load()
    if not st:
        return []
    _, parent = st["tree"]
    res = []
    for it in st["idx"]:
        hit = node_id in it["nodes"] or (include_below and any(node_id in _ancestors(n, parent) for n in it["nodes"]))
        if hit:
            res.append(it["m"])
    res.sort(key=lambda m: -(abs(m.get("d7") or 0) * math.log10(max(m.get("volume") or 0, 1000)) + 1e-9 * (m.get("volume") or 0)))
    return res[:k]


def get(market_id: str) -> dict | None:
    st = _load()
    if not st:
        return None
    for it in st["idx"]:
        if it["m"].get("id") == str(market_id):
            return it["m"]
    return None


def as_of() -> str | None:
    st = _load()
    return (st["data"] or {}).get("asOf") if st else None


def _main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="+")
    ap.add_argument("-k", type=int, default=10)
    a = ap.parse_args(argv)
    text = " ".join(a.text)
    print(f"query: {text}   concepts: {analyze(text)['tags']}")
    for m in search(text, k=a.k):
        d7 = "" if m.get("d7") is None else f"{m['d7'] * 100:+.0f}pt/7d"
        print(f"  {m['matchScore']:5.1f}  {m['prob'] * 100:5.1f}% {d7:>9}  ${m.get('volume', 0):>11,}  {m.get('qZh') or m['q']}")
        if m.get("qZh") != m.get("q"):
            print(f"                {m['q'][:100]}")


if __name__ == "__main__":
    _main(sys.argv[1:])
