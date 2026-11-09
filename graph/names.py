#!/usr/bin/env python3
"""graph/names.py — one display name per company, and a lint for the wrong ones (DESIGN §12 voice, §20 holdings).

The map calls the owner's biggest holding 「Ginkgo」 (web/data/search.json). Research agents and Claude lines kept
writing 「银杏」 (a literal translation nobody uses) or worse, 「推特」 for Twist Bioscience (推特 is Twitter). One
company, one name, everywhere: graph/build.py runs every take / say / what / basis through `lint()`, and the why /
scout prompts can use `canonical()` + `rule_text()` to pass the right names in and `lint()` to check what comes back.

    from graph.names import canonical, lint, rule_text     # or load by path (see graph/apply_patch.py)
    canonical("DNA")                      → "Ginkgo"   (search.json name; falls back to the ticker)
    lint("银杏跌 48%", ids={"DNA"})        → "Ginkgo跌 48%"
    lint("推特吃的是红利", ids={"TWST"})    → "Twist吃的是红利"   (only when the text is about TWST, never next to X/Twitter)
    rule_text(["DNA", "TWST"])            → a one-line prompt rule: 「公司名照写：DNA=Ginkgo，TWST=Twist；不要意译…」

    python3 graph/names.py --scan web/data/why web/data/graph   # list wrong aliases still in generated JSON
"""
from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEARCH = (ROOT / "web" / "data" / "search.json", ROOT / "web" / "data" / "fm" / "search.json")

# wrong alias → the ticker it was (mis)used for, and tickers whose presence means the alias may be right after all
WRONG: list[dict] = [
    {"wrong": "银杏生物", "t": "DNA", "unless": ()},
    {"wrong": "银杏", "t": "DNA", "unless": ()},
    {"wrong": "推特", "t": "TWST", "unless": ("X", "p:x", "p:twitter", "p:x-corp", "TWTR", "p:xai")},
    {"wrong": "崔斯特", "t": "TWST", "unless": ()},
]
# what to call them when search.json is not there (tests, a fresh checkout)
FALLBACK = {"DNA": "Ginkgo", "TWST": "Twist"}


@lru_cache(maxsize=1)
def _names() -> dict[str, str]:
    out: dict[str, str] = {}
    for p in reversed(SEARCH):                       # curated wins over full-market
        try:
            rows = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        for r in rows if isinstance(rows, list) else []:
            t, n = r.get("ticker"), r.get("name")
            if t and n:
                out[str(t)] = str(n)
    return out


def canonical(t: str) -> str:
    """The map's display name for a ticker (what search.json shows), else the fallback, else the ticker."""
    t = str(t or "")
    if t.startswith("s:"):
        t = t[2:]
    return _names().get(t) or FALLBACK.get(t) or t


def lint(text, ids=()):
    """Replace wrong aliases in `text` with the canonical name — only when the text is about that company
    (its ticker is in `ids`; `ids=None` means 'any context') and none of the `unless` tickers is. Non-strings pass."""
    if not isinstance(text, str) or not text:
        return text
    ids = None if ids is None else {str(i)[2:] if str(i).startswith("s:") else str(i) for i in ids}
    for w in WRONG:
        if w["wrong"] not in text:
            continue
        if ids is not None and (w["t"] not in ids or ids & set(w["unless"])):
            continue
        text = text.replace(w["wrong"], canonical(w["t"]))
    return text


def hits(text, ids=None) -> list[str]:
    """The wrong aliases `lint` would replace in this text."""
    if not isinstance(text, str):
        return []
    return [w["wrong"] for w in WRONG if w["wrong"] in text and lint(text, ids) != text]


def rule_text(tickers) -> str:
    """One prompt line that pins the names (for why / scout / take prompts)."""
    ts = [str(t)[2:] if str(t).startswith("s:") else str(t) for t in tickers if t]
    pairs = "，".join(f"{t}={canonical(t)}" for t in dict.fromkeys(ts))
    bad = "、".join(f"「{w['wrong']}」" for w in WRONG if w["t"] in ts)
    s = f"公司名照写，不要意译：{pairs}" if pairs else "公司名照写，不要意译"
    return s + (f"；不要写成{bad}。" if bad else "。")


def _walk(o, ids, path, out):
    if isinstance(o, str):
        h = hits(o, ids)
        if h:
            out.append((path, h, o[:80]))
    elif isinstance(o, dict):
        own = {str(o[k]) for k in ("t", "id", "a", "b") if isinstance(o.get(k), str)}
        for k, v in o.items():
            here = ids | own | ({k} if re.match(r"^(p:[a-z0-9\-]+|[A-Z0-9][A-Z0-9.\-]{0,9})$", str(k)) else set())
            _walk(v, here, f"{path}.{k}", out)
    elif isinstance(o, list):
        for n, v in enumerate(o):
            _walk(v, ids, f"{path}[{n}]", out)


def scan(paths) -> list[tuple]:
    """Every wrong alias left in JSON files under `paths` (context: the tickers named in the file name / content)."""
    out = []
    for p in paths:
        p = Path(p)
        files = sorted(p.rglob("*.json")) if p.is_dir() else [p]
        for f in files:
            try:
                raw = f.read_text(encoding="utf-8")
            except Exception:
                continue
            if not any(w["wrong"] in raw for w in WRONG):
                continue
            try:
                d = json.loads(raw)
            except Exception:
                continue
            ctx = set(re.findall(r"\b[A-Z][A-Z0-9.\-]{0,9}\b", f.stem.replace("_", ":"))) | {w["t"] for w in WRONG if w["t"] in raw}
            _walk(d, ctx, f.name, out)
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--scan"] or [str(ROOT / "web" / "data" / "graph"), str(ROOT / "web" / "data" / "why")]
    found = scan(args)
    for path, h, txt in found[:200]:
        print(f"{path}: {'/'.join(h)} → {txt}")
    print(f"{len(found)} text field(s) with a wrong company alias")
    sys.exit(1 if found else 0)
