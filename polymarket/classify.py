"""polymarket/classify.py: apply rules.py to one market → category, concepts, direction, nodes.

Pure functions, no network. fetch.py calls `event_context(event)` once per event and
`classify(event, market, ctx, tree)` per market.
"""
from __future__ import annotations

import math
import re

try:
    from . import rules as RU
except ImportError:
    import rules as RU

_DEESC = re.compile(
    r"ceasefire|cease-fire|peace|diplomatic|\bmeeting\b|\bmeets?\b|summit|security guarantee|rejoin|\bagrees?\b|"
    r"\bend (of )?(the )?[a-z]* ?(war|blockade|conflict|strikes|enrichment)|\bdeal\b|agreement|truce|returns? to normal|reopen|sanction relief|\btalks\b|"
    r"negotiat|accord|normaliz|recogni[sz]e|lift(s|ed)? (the )?(blockade|sanctions)|withdraw|end (of )?(the )?war|"
    r"hostages? (released|deal)|disarm|de-?escalat", re.I)
_TARIFF_DOWN = re.compile(
    r"\blower|reduc|\bcut\b|remov|\blift|\bend(s|ed)?\b|\bdrop|\bdeal\b|agreement|exempt|pause|suspend|"
    r"strike(s)? down|struck down|unlawful|illegal|unconstitutional|rule(s)? against|refund|repeal|roll ?back", re.I)
_CB_DOWN = re.compile(r"decrease|\bcut(s)?\b|lower(s|ed)? (interest )?rates|easing", re.I)
_CB_UP = re.compile(r"increase|\bhike(s)?\b|raise(s)? (interest )?rates|tighten", re.I)
_CB_HOLD = re.compile(r"no change|unchanged|\bhold(s)?\b|pause|maintain", re.I)
_TICKER_PAREN = re.compile(r"\(([A-Z][A-Z.\-]{0,5})\)")
_NOT_TICKERS = {"HIGH", "LOW", "ET", "PT", "UTC", "YES", "NO", "Y", "US", "UK", "EU", "AI", "GC", "SPX", "CL", "NG",
                "SI", "HG", "BTC", "ETH", "SOL", "XRP", "DXY", "VIX"}


def norm_text(*parts) -> str:
    s = " || ".join(p for p in parts if p)
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


# --------------------------------------------------------------------------------------------
# bucket events: "3 cuts", "4.25%", "$2.50-$3.00", "25 bps decrease", "↑$3.0T"
# --------------------------------------------------------------------------------------------
_MULT = {"k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12}


def bucket_value(label: str):
    """Number on an ordinal axis for a bucket label, or None."""
    if not label:
        return None
    s = label.lower().replace(",", "").replace("−", "-").replace("–", "-").replace("—", "-")
    if _CB_HOLD.search(s) and not re.search(r"\d", s):
        return 0.0
    m = re.search(r"(\d+(?:\.\d+)?)\+?\s*bps?\s*(increase|decrease|hike|cut)", s) or \
        re.search(r"(increase|decrease|hike|cut)\w*\s*(?:by\s*)?(\d+(?:\.\d+)?)\+?\s*bps?", s)
    if m:
        g = m.groups()
        v, w = (float(g[0]), g[1]) if g[0][0].isdigit() else (float(g[1]), g[0])
        return v if w.startswith(("increase", "hike")) else -v
    if re.match(r"\s*(no|none|zero)\b", s):
        return 0.0
    core = re.sub(r"\(.*?\)", " ", s).strip() or s
    nums = re.findall(r"(\d+(?:\.\d+)?)\s*([kmbt](?![a-z]))?", core)
    if not nums:
        return None
    vals = [float(a) * _MULT.get(b or "", 1.0) for a, b in nums[:2]]
    v = sum(vals) / len(vals) if (len(vals) == 2 and re.search(r"\d\s*[-to]+\s*\$?\d", core)) else vals[0]
    eps = abs(v) * 1e-3 + 1e-6
    if re.search(r"<|≤|less than|under|below|fewer", core):
        v -= eps
    elif re.search(r">|≥|\+|more than|above|over|at least|or more", core):
        v += eps
    return v


_DATE_LABEL = re.compile(r"\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|"
                         r"oct(ober)?|nov(ember)?|dec(ember)?)\b\.?\s*\d{0,2}|\bq[1-4]\b|\b20\d\d-\d\d", re.I)


def event_context(event: dict) -> dict:
    """Per-event facts shared by its markets: is it a bucket event, which bucket is the favourite."""
    ms = [m for m in event.get("markets") or [] if _is_open(m)]
    ctx = {"bucket": False, "values": {}, "fav": None, "n_open": len(ms)}
    if not event.get("negRisk") or len(ms) < 3:
        return ctx
    vals = {}
    labels = [(m.get("groupItemTitle") or "") for m in ms]
    if sum(1 for g in labels if _DATE_LABEL.search(g)) >= 0.5 * len(labels):
        return ctx  # a date ladder ("released on Oct 28 / Oct 29 / no release"), not an ordinal bucket
    for m in ms:
        v = bucket_value(m.get("groupItemTitle") or "")
        if v is not None:
            vals[m["id"]] = v
    if len(vals) >= 3 and len(set(vals.values())) >= 3 and len(vals) >= 0.6 * len(ms):
        best = max((m for m in ms if m["id"] in vals), key=lambda m: _p(m))
        ctx.update(bucket=True, values=vals, fav=vals[best["id"]])
    return ctx


def _p(m) -> float:
    op = m.get("outcomePrices") or []
    return op[0] if op and op[0] is not None else 0.0


def _is_open(m) -> bool:
    return bool(m.get("active")) and not m.get("closed") and m.get("acceptingOrders") is not False \
        and bool(m.get("outcomePrices")) and m.get("outcomePrices")[0] is not None


# --------------------------------------------------------------------------------------------
def _level_dir(q: str, group: str, title: str) -> int:
    qg = q + " " + group
    neg = -1 if RU.NEG_Q.search(q) else 1
    if RU.DOWN_Q.search(qg):
        return -1 * neg
    if re.search(r"\(high\)|↑", qg):
        return 1 * neg
    if RU.EVENT_DOWN.search(title) and not RU.UP_Q.search(group):
        return -1 * neg
    return 1 * neg


def market_dir(r: dict, q: str, group: str, title: str, text: str, ctx: dict, mid: str) -> int:
    kind = r["dir"]
    if kind == "none":
        return 0
    if kind == "bucket":
        if ctx.get("bucket") and mid in ctx["values"]:
            d = ctx["values"][mid] - ctx["fav"]
            return 0 if abs(d) < 1e-9 else (1 if d > 0 else -1)
        return _level_dir(q, group, title)
    if kind == "level":
        if ctx.get("bucket") and mid in ctx["values"]:
            d = ctx["values"][mid] - ctx["fav"]
            return 0 if abs(d) < 1e-9 else (1 if d > 0 else -1)
        return _level_dir(q, group, title)
    if kind == "cb":
        s = q + " " + group
        n = len(_CB_DOWN.findall(s)) - len(_CB_UP.findall(s))
        if n == 0:
            return 0
        return 1 if n > 0 else -1
    if kind == "tariff":
        return -1 if _TARIFF_DOWN.search(q + " " + group + " " + title) else 1
    if kind == "geo":
        d = -1 if _DEESC.search(q + " " + group + " " + title) else 1
        if re.search(r"ships transit|transiting|traffic", text):
            if ctx.get("bucket") and mid in ctx["values"]:
                bd = ctx["values"][mid] - ctx["fav"]
                return 0 if abs(bd) < 1e-9 else (-1 if bd > 0 else 1)
            if not _DEESC.search(text):
                d = -_level_dir(q, group, title)
        if RU.NEG_Q.search(q):
            d = -d
        return d
    if kind == "party":
        s = (group or q).lower()
        if re.search(r"d senate, r house|r senate, d house|other|party [a-e]\b|independent", s):
            return 0
        if re.search(r"republican|\bgop\b|\br senate, r house|republicans sweep", s):
            return 1
        if re.search(r"democrat|\bd senate, d house|democrats sweep", s):
            return -1
        return 0
    if kind == "shutdown":
        return -1 if re.search(r"\bend(s|ed)?\b|\bover\b|reopen|last(s)? (until|through)|how long", q) else 1
    if kind == "ipo":
        return -1 if re.search(r"\bnot ipo|\bno ipo|won'?t ipo|not go public", q + " " + group) else 1
    if kind == "export":
        return 1 if re.search(r"tighten|new (export )?(control|ban|restriction)|ban(s|ned)?\b|restrict|block", q) and \
            not re.search(r"lift|eas|allow|approve|resume|permit", q) else -1
    if kind == "listrm":
        return 1 if re.search(r"remov|delist|taken off|dropped", q) else -1
    if kind == "mstr":
        return 1 if re.search(r"margin call|bankrupt|liquidat|\bsell", q) else -1
    if kind == "opec":
        if re.search(r"leave|dissolve|exit|quit|increase (production|output)|output hike|raise output", q):
            return -1
        if re.search(r"\bcut\b|reduce (production|output)", q):
            return 1
        return 0
    # "event": in a bucket event ("how many more problems will AI solve: 0 / 1 / 2+") the outcome is
    # read against the favourite bucket, like "bucket"
    if ctx.get("bucket") and mid in ctx["values"]:
        d = ctx["values"][mid] - ctx["fav"]
        return 0 if abs(d) < 1e-9 else (1 if d > 0 else -1)
    return -1 if RU.NEG_Q.search(q) else 1


# --------------------------------------------------------------------------------------------
_COMP = [(re.compile(p, re.I), t) for p, t in RU.COMPANIES.items()]
_LABS = [(k, re.compile(p, re.I), t) for k, (p, t) in RU.LAB_PROXIES.items()]
_CNAI = re.compile(RU.CHINESE_AI, re.I)


def companies(q_raw: str, group: str, text: str, tags: list[str], use_labs: bool) -> tuple[list[str], list[str], bool]:
    """→ (tickers, lab keys, chinese_ai?) named by the market. The group title (one outcome of a
    multi-outcome event) wins over the question, so 'Largest company: NVIDIA' → NVDA only."""
    tick: list[str] = []
    for t in _TICKER_PAREN.findall(q_raw or ""):
        if t in _NOT_TICKERS:
            continue
        t = t.replace(".", "-")
        if t not in tick:
            tick.append(t)
    if not tick:
        for scope in ([group] if group else []) + [q_raw.lower()]:
            for rx, ts in _COMP:
                if rx.search(scope):
                    for t in ts:
                        if t not in tick:
                            tick.append(t)
            if tick:
                break
    labs, cn = [], False
    if use_labs:
        for scope in ([group] if group else []) + [text]:
            labs = [k for k, rx, ts in _LABS if rx.search(scope)]
            cn = bool(_CNAI.search(scope))
            if labs or cn:
                break
        if not labs and not cn:
            for k in ("openai", "anthropic", "google", "meta", "xai"):
                if k in tags:
                    labs.append(k)
    return tick, labs, cn


def classify(event: dict, m: dict, ctx: dict, tree) -> dict | None:
    """→ {cat, tags, milestone, conf, nodes:[(id, sign, weight)], dir, rules:[names]} or None (drop)."""
    q_raw = m.get("question") or ""
    group = (m.get("groupItemTitle") or "").lower()
    title = (event.get("title") or "").lower()
    q = norm_text(q_raw)
    text = norm_text(q_raw, event.get("title"), m.get("groupItemTitle"))
    etags = set(event.get("tags") or [])

    if etags & RU.EXCLUDE_TAGS:
        return None
    if RU.EXCLUDE_PAT.search(text) or re.search(r"\bpending\b|iranian rials?", text):
        return None

    matched = []
    for r in RU.RULES:
        if r["need_tag"] and r["need_tag"] not in etags:
            continue
        if not r["pat"].search(text):
            continue
        if r["not"] is not None and r["not"].search(text):
            continue
        if r.get("need") is not None and not r["need"].search(text):
            continue
        if r["name"] in ("gold",) and RU.FALSE_FRIENDS.search(text):
            continue
        if r["name"] == "mideast" and re.search(r"supreme leader|khamenei|regime|election|knesset|prime minister|"
                                                r"aramco|largest company|rials?|netanyahu|recogni[sz]e israel", text):
            continue
        matched.append(r)

    if not matched:
        if etags & RU.MONEY_TAGS and (m.get("volumeNum") or 0) >= RU.OTHER_MIN_VOLUME:
            return {"cat": "other", "tags": ["other"], "milestone": False, "conf": "none", "nodes": [],
                    "dir": 1, "rules": []}
        return None

    cat = min((r["cat"] for r in matched), key=lambda c: RU.CAT_PRIORITY.index(c) if c in RU.CAT_PRIORITY else 99)
    solo = [r for r in matched if r.get("solo")]
    tags: list[str] = []
    for r in matched:
        for t in r["tags"]:
            if t not in tags:
                tags.append(t)
    milestone = any(r["milestone"] for r in matched)
    conf = "hi" if any(r["conf"] == "hi" and (r["themes"] or r["co"]) for r in matched) else "lo"

    total: dict[str, float] = {}
    dirs = []
    use_labs = any(r["labs"] for r in matched)
    tick, labs, cn = companies(q_raw, group, text, sorted(etags), use_labs)
    for t in labs:
        if t not in tags:
            tags.append(t)
    if cn and "chinese-ai" not in tags:
        tags.append("chinese-ai")

    def add(nid, s, w):
        rid = None
        if tree is None:
            rid = nid.split("|")[0]
        else:
            for alt in nid.split("|"):
                if tree.has(alt):
                    rid = alt
                    break
            if rid is None:
                rid = tree.resolve(nid.split("|")[0])
        if not rid or rid in ("world",):
            return
        total[rid] = total.get(rid, 0.0) + s * w

    for r in matched:
        d = market_dir(r, q, group, title, text, ctx, m["id"])
        dirs.append(d)
        if d == 0:
            continue
        w = 1.0 if r["conf"] == "hi" else 0.6
        if solo and r not in solo:
            continue
        for theme, tsign in r["themes"]:
            for nid, nsign in RU.THEMES.get(theme, []):
                add(nid, d * tsign * nsign, w)
        if r["name"] in ("tariff", "trade_deal", "trade_deal_minor"):
            for rx, nid in _TARIFF_COUNTRY:
                if rx.search(text):
                    s = -1 if r["name"] == "tariff" else 1
                    add(nid, d * s, w)
        if r["name"] in ("tariff", "tariff_rate"):
            for rx, nid in _TARIFF_GOODS:
                if rx.search(text):
                    add(nid, d, w)
        if r["name"] == "china_clash":
            for rx, nid in _CLASH_COUNTRY:
                if rx.search(text):
                    add(nid, -d, w)
        if r["co"]:
            cos = [(t, 1) for t in tick]
            if r["labs"]:
                # "Anthropic vs OpenAI – higher valuation?": YES is good for the first-named lab, bad for the other
                vs = len(labs) >= 2 and re.search(r"\bvs\.?\b|\bversus\b|\bor\b.{0,40}\b(first|higher)\b", q)
                order = sorted(labs, key=lambda k: (q.find(k) if k in q else 999))
                for i, k in enumerate(order):
                    for t in RU.LAB_PROXIES[k][1]:
                        if t not in [c for c, _ in cos]:
                            cos.append((t, (1 if i == 0 else -1) if vs else 1))
            for t, ts in cos:
                if tree is None or not tree.has("s:" + t):
                    continue
                add("s:" + t, d * r["co"] * ts, w)
                for reg in (tree.tickers.get(t) or [])[:1]:
                    add(reg, d * r["co"] * ts, w * 0.8)
            if r["labs"] and cn:
                add("intl-cn-net", d * r["co"], w)

    if any(r["dir"] == "cb" for r in matched):
        qg = q + " " + group
        if _CB_DOWN.search(qg) and "rate-cut" not in tags:
            tags.append("rate-cut")
        if _CB_UP.search(qg) and "rate-hike" not in tags:
            tags.append("rate-hike")
    nodes = [(k, 1 if v > 0 else -1, abs(v)) for k, v in total.items() if abs(v) > 1e-9]
    nodes.sort(key=lambda x: (not x[0].startswith("s:"), -x[2]))
    stocks = [n for n in nodes if n[0].startswith("s:")][:3]
    regions = [n for n in nodes if not n[0].startswith("s:")][:9]
    nd = next((d for d in dirs if d != 0), 0)
    return {"cat": cat, "tags": tags[:10], "milestone": milestone, "conf": conf, "nodes": stocks + regions,
            "dir": nd, "rules": [r["name"] for r in matched]}


_TARIFF_COUNTRY = [(re.compile(p, re.I), n) for p, n in [
    (r"canada|canadian", "intl-canada"), (r"china|chinese", "intl-china"), (r"mexico|mexican", "intl-latam"),
    (r"\beu\b|europe|european", "intl-europe"), (r"japan", "intl-japan"), (r"korea", "intl-korea"),
    (r"india", "intl-india"), (r"brazil", "intl-brazil"), (r"taiwan", "intl-taiwan"),
    (r"semiconductor|chips?\b", "ai-compute-foundry"), (r"pharma|drug", "health-pharma"),
    (r"\bauto|car(s)?\b|vehicle", "robot-cars"), (r"lumber|timber", "realestate-builders"),
    (r"argentin|chile|peru|colombia", "intl-latam"), (r"indonesia|south africa|turkey|poland|saudi", "intl-em-small"),
    (r"australia|singapore", "intl-pacific"), (r"switzerland|swiss", "intl-eu-etf"),
]]
# goods whose US producers gain from a tariff on imports (sign +1 for "tariff happens")
_TARIFF_GOODS = [(re.compile(p, re.I), n) for p, n in [
    (r"copper", "industrial-copper"), (r"steel|aluminum|aluminium", "industrial-steel"),
]]
_CLASH_COUNTRY = [(re.compile(p, re.I), n) for p, n in [
    (r"japan", "intl-japan"), (r"india", "intl-india"), (r"korea", "intl-korea"),
]]


def volume_floor(cls: dict) -> float:
    if cls.get("milestone"):
        return RU.VOLUME_FLOOR["milestone"]
    if not cls.get("nodes"):
        return RU.VOLUME_FLOOR["unmapped"]
    return RU.VOLUME_FLOOR.get(cls.get("cat"), RU.VOLUME_FLOOR["default"])


def is_open(m) -> bool:
    return _is_open(m)


def prob_of(m) -> float:
    return _p(m)


def log_volume(v) -> float:
    return math.log10(max(float(v or 0), 1000.0))
