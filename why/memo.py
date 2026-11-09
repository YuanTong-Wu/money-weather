"""why/memo.py — what earlier 为什么 cards already found, per ticker, so new cards agree with old ones.

Cards made on different days drifted apart on small facts (Ginkgo's Q3 earnings date written as 11-05 in one
card and 11-06 in another; one deal dated 9-15 here and 9-16 there). After every card this keeps a memo
why/out/facts_memo.json:
    {"version": 1, "updatedAt", "tickers": {"DNA": {"earnings": [{"date", "what", "keys": [...], "n", "at"}],
                                                    "events": [{"date", "text", "url", "source", "conf", "key", "at"}]}}}
and every new prompt for that ticker gets the memo as "之前的卡片查到过" lines (keep it consistent unless a newer,
more authoritative source says otherwise — then say so in reasons).

    record(card)        after a card is written (job.run); never raises
    lines_for(f)        → list[str] for prompt.user_prompt (f = facts.build() output)
    rebuild()           from every cached card (python3 -m why.memo)
"""
from __future__ import annotations

import re
import sys

from why.util import ROOT, WHY_DIR, iso_now, locked, read_json, today_et, write_json

MEMO = ROOT / "why" / "out" / "facts_memo.json"
EARN_RE = re.compile(r"财报|业绩|季报|年报|earnings|Q[1-4]\b|第[一二三四]季度|三季度|四季度", re.I)
MAX_EVENTS = 12


def _tickers_of(card: dict) -> list[str]:
    """Single-company cards only (stock / day / landing on a stock): their watch items are about that company."""
    kind = card.get("kind")
    ids = [str(x) for x in (card.get("ids") or [])]
    if kind in ("stock", "day") and ids:
        t = ids[0]
        return [t[2:] if t.startswith("s:") else t] if t.startswith("s:") or kind == "stock" else []
    return []


def _future(d: str | None) -> bool:
    if not d:
        return False
    t = today_et()
    return d >= (t if len(d) == 10 else t[:7])


def _merge(memo: dict, card: dict) -> None:
    for t in _tickers_of(card):
        m = memo.setdefault("tickers", {}).setdefault(t, {"earnings": [], "events": []})
        for w in card.get("watch") or []:
            by, what = str(w.get("by") or ""), str(w.get("what") or "")
            if not re.match(r"^\d{4}-\d{2}(-\d{2})?$", by) or not EARN_RE.search(what):
                continue
            hit = next((e for e in m["earnings"] if e["date"] == by), None)
            if hit is None:
                hit = {"date": by, "what": what[:80], "keys": [], "n": 0, "at": card.get("at")}
                m["earnings"].append(hit)
            if card.get("key") not in hit["keys"]:
                hit["keys"] = (hit["keys"] + [card.get("key")])[-6:]
                hit["n"] = len(hit["keys"])
            hit["at"] = max(str(hit.get("at") or ""), str(card.get("at") or ""))
        for r in card.get("reasons") or []:
            if not r.get("url") or not r.get("date") or float(r.get("conf") or 0) < 0.55 or r.get("urlOk") is False:
                continue
            if any(e["url"] == r["url"] for e in m["events"]):
                continue
            m["events"].append({"date": r["date"], "text": str(r.get("text") or "")[:90], "url": r["url"],
                                "source": r.get("source"), "conf": r.get("conf"), "key": card.get("key"),
                                "at": card.get("at")})
        m["events"] = sorted(m["events"], key=lambda e: (str(e.get("date")), float(e.get("conf") or 0)),
                             reverse=True)[:MAX_EVENTS]
        m["earnings"] = sorted(m["earnings"], key=lambda e: (-int(e.get("n") or 0), str(e.get("at") or "")))[:6]


def record(card: dict) -> None:
    try:
        if not _tickers_of(card):
            return
        with locked(MEMO):
            memo = read_json(MEMO) or {"version": 1, "tickers": {}}
            _merge(memo, card)
            memo["updatedAt"] = iso_now()
            write_json(MEMO, memo)
    except Exception:  # noqa: BLE001 — the memo is a helper; the card already stands
        pass


def rebuild() -> dict:
    memo = {"version": 1, "tickers": {}}
    cards = []
    for p in WHY_DIR.glob("*.json"):
        if p.name == "index.json":
            continue
        c = read_json(p)
        if isinstance(c, dict) and c.get("say"):
            cards.append(c)
    for c in sorted(cards, key=lambda c: str(c.get("at") or "")):
        _merge(memo, c)
    memo["updatedAt"] = iso_now()
    with locked(MEMO):
        write_json(MEMO, memo)
    return memo


def lines_for(f: dict) -> list[str]:
    """Prompt lines for the tickers this card is about (its own ids; for a region its top members)."""
    try:
        memo = read_json(MEMO) or {}
    except Exception:  # noqa: BLE001
        return []
    tk = memo.get("tickers") or {}
    want: list[str] = []
    for x in f.get("ids") or []:
        x = str(x)
        want.append(x[2:] if x.startswith("s:") else x)
    if f.get("kind") in ("node", "channel", "landing"):
        want += [str(x) for x in (f.get("searchTerms") or [])[:3]]
    out = []
    for t in dict.fromkeys(want):
        m = tk.get(t)
        if not m:
            continue
        earn = [e for e in m.get("earnings") or [] if _future(e.get("date"))]
        if earn:
            if len(earn) > 1:
                alts = "、".join(f"{e['date']}（{e['n']} 张卡）" for e in earn[:3])
                out.append(f"{t} 下次财报：之前的卡片写法不一致——{alts}。请查实是哪天（公司公告/IR 页面），写进 watch")
            else:
                e = earn[0]
                out.append(f"{t} 下次财报：之前的卡片写的是 {e['date']}（{e['what'][:40]}）——除非查到公司正式公布了别的日期")
        ev = m.get("events") or []
        if ev:
            out.append(f"{t} 之前查到过的关键事件（日期以这些来源为准，别写成别的日子）：" + "；".join(
                f"{e['date']} {e['text'][:50]}（{e.get('source') or ''}）" for e in ev[:5]))
    return out


if __name__ == "__main__":
    m = rebuild()
    for t, v in (m.get("tickers") or {}).items():
        print(t, [(e["date"], e["n"]) for e in v["earnings"]], len(v["events"]), "events")
    sys.exit(0)
