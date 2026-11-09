"""why/card.py — turn Claude's JSON into the §24 原因卡, strictly.

    parse_json(text) -> dict | None            tolerant extraction (code fences, stray quotes, trailing commas)
    validate(raw, f) -> (clean, issues, fatal) every reason needs text + a real-looking URL + a date ≤ today;
                                               English-only / placeholder answers are fatal (job retries once)
    check_urls(reasons)                        HEAD/GET each link in parallel; 404/410/dead host → marked, conf halved
    make_card(clean, f, gate_result) -> dict   {key, asOf, date, target, title, question, say, sayMild, facts,
                                               reasons, counter, watch, honest, timeline, usd, at, …}
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from urllib.parse import urlparse

from why.prompt import REASON_TYPES
from why.util import has_han, iso_now, num, today_et

DATE_RE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$")
BAD_HOSTS = {"example.com", "www.example.com", "localhost", "127.0.0.1", "url", "link"}
SEARCH_HOSTS = ("google.", "bing.com", "duckduckgo.com", "search.yahoo.com", "baidu.com")
PLACEHOLDER_RE = re.compile(r"^(…|\.\.\.|xxx|todo|tbd|n/?a|none|null|placeholder|略)$", re.I)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"


# ── JSON extraction ───────────────────────────────────────────────────────────────────────────────
def _value_start(s: str, j: int) -> bool:
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
            if nxt in "}]" or nxt == "" or (nxt in ",:" and _value_start(s, j + 1)):
                in_str = False
                out.append(ch)
            else:
                out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        else:
            out.append(ch)
    return re.sub(r",\s*([}\]])", r"\1", "".join(out))


def parse_json(text) -> dict | None:
    if isinstance(text, dict):
        return text
    if not isinstance(text, str):
        return None
    t = re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", text.strip())
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    body = t[a:b + 1]
    for cand in (body, repair_json(body)):
        try:
            d = json.loads(cand)
            return d if isinstance(d, dict) else None
        except ValueError:
            continue
    return None


# ── validation ────────────────────────────────────────────────────────────────────────────────────
def _s(x, n: int = 400) -> str:
    return re.sub(r"\s+", " ", str(x)).strip()[:n] if isinstance(x, (str, int, float)) else ""


def norm_date(d) -> str | None:
    """'2026-10-06' / '2026-10' kept; '2026/10/6', '20261006', 'Oct 6, 2026' normalised; future dates → None."""
    if not isinstance(d, str) or not d.strip():
        return None
    s = d.strip()[:30]
    m = re.match(r"^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?", s)
    if not m:
        m2 = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)
        if m2:
            m = m2
    if not m:
        from datetime import datetime
        for fmt in ("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y"):
            try:
                x = datetime.strptime(s, fmt).date()
                return x.isoformat() if x <= date.fromisoformat(today_et()) + timedelta(days=1) else None
            except ValueError:
                continue
        return None
    y, mo, dd = int(m.group(1)), int(m.group(2)), int(m.group(3)) if m.group(3) else None
    try:
        x = date(y, mo, dd or 1)
    except ValueError:
        return None
    if x > date.fromisoformat(today_et()) + timedelta(days=1):
        return None
    return x.isoformat() if dd else f"{y:04d}-{mo:02d}"


def url_ok_shape(u) -> bool:
    if not isinstance(u, str) or not u.startswith(("http://", "https://")):
        return False
    p = urlparse(u.strip())
    host = (p.hostname or "").lower()
    if not host or "." not in host or host in BAD_HOSTS or host.endswith(".example") or "example." in host:
        return False
    if any(h in host for h in SEARCH_HOSTS) and ("search" in p.path or p.query.startswith("q=") or "q=" in p.query):
        return False
    return len(p.path.strip("/")) >= 3 or bool(p.query)       # a specific page, not a bare homepage


def _conf(x, default=0.5) -> float:
    v = num(x)
    if v is None:
        return default
    if v > 1 and v <= 100:
        v /= 100
    return round(max(0.0, min(1.0, v)), 2)


CJK = "\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"


def zh_punct(t: str) -> str:
    """ASCII , ; : ! ? right after a Chinese character → full-width (cosmetic, keeps numbers like 1,000 intact)."""
    if not t:
        return t
    t = re.sub(rf"(?<=[{CJK}]),\s*", "，", t)
    t = re.sub(rf"(?<=[{CJK}]);\s*", "；", t)
    t = re.sub(rf"(?<=[{CJK}])!\s*", "！", t)
    t = re.sub(rf"(?<=[{CJK}])\?\s*", "？", t)
    return re.sub(rf",(?=[{CJK}])", "，", t)


def short_say(say: str, limit: int = 36) -> str:
    """§12: the sharp line is short. Over the limit → cut at the last clause break that fits."""
    if len(say) <= limit:
        return say
    cut = max((m.end() for m in re.finditer(r"[，。；！？—…]", say[:limit + 1])), default=0)
    out = say[:cut].rstrip("，；—…") if cut >= 12 else say[:limit].rstrip("，；") + "…"
    return out.rstrip("。") + ("" if out.endswith(("！", "？", "…")) else "")


# company names the model keeps mistranslating (DESIGN §12 prompt rule 10: "Twist 不是「推特」"); applied when
# the card is about / mentions that ticker
NAME_FIXES = {"TWST": [("推特", "Twist"), ("崔斯特", "Twist")], "DNA": [("银杏生物", "Ginkgo"), ("银杏", "Ginkgo")]}   # same aliases as graph/names.py WRONG


def _scope_text(f: dict) -> str:
    bits = [str(x) for x in (f.get("ids") or [])] + [str(x) for x in (f.get("searchTerms") or [])]
    bits += [str(x) for x in (f.get("context") or [])] + [str(f.get("title") or ""), str(f.get("question") or "")]
    return " ".join(bits)


def fix_names(obj: dict, f: dict) -> int:
    """Replace known mistranslations in every text field of a raw/clean answer. Returns how many were fixed."""
    scope = _scope_text(f)
    pairs = [p for t, ps in NAME_FIXES.items() if re.search(rf"(?<![A-Z]){t}(?![A-Z])", scope) for p in ps]
    if not pairs:
        return 0
    n = 0

    def fx(s):
        nonlocal n
        if not isinstance(s, str):
            return s
        for bad, good in pairs:
            if bad in s:
                n += s.count(bad)
                s = s.replace(bad, good)
        return s
    for k in ("say", "sayFull", "sayMild", "honest"):
        if k in obj:
            obj[k] = fx(obj[k])
    for k in ("reasons", "counter", "watch"):
        for it in obj.get(k) or []:
            if isinstance(it, dict):
                for kk in ("text", "what"):
                    if kk in it:
                        it[kk] = fx(it[kk])
    return n


SUBJECT_ALIASES = {"地产": "realestate", "房产": "realestate", "楼市": "realestate"}
SUBJECT_SKIP = {"美股", "地球"}          # too generic to say a line is about the wrong place


def _region_names(f: dict) -> dict[str, str]:
    """Region names of the card's map (+ a few everyday aliases, e.g. 地产 for 房地产) → node id."""
    try:
        from why.facts import data_root
        tree = data_root(f.get("map") or "curated").tree
    except Exception:  # noqa: BLE001
        return {}
    out: dict[str, str] = {}
    for nid, n in tree.nodes.items():
        if tree.is_stock(nid) or nid == "world":
            continue
        nm = str(n.get("name") or "").strip()
        if len(nm) >= 2 and has_han(nm) and nm not in SUBJECT_SKIP:
            out.setdefault(nm, nid)
    for a, nid in SUBJECT_ALIASES.items():
        if nid in tree.nodes:
            out.setdefault(a, nid)
    return out


def foreign_subject(say: str, f: dict) -> str | None:
    """The sharp line is about a region the facts never mention, and not about the target at all (a card on Ginkgo
    whose 老风 line talks about 地产) → that region's name, else None."""
    if not say or f.get("kind") in ("channel", "market", "edge"):
        return None
    allowed = _scope_text(f) + " " + " ".join(str(v) for v in (f.get("facts") or {}).values())
    names = _region_names(f)
    if any(nm in say and nm in allowed for nm in names):
        return None
    own = set()
    for x in f.get("ids") or []:
        x = str(x)
        own.add(x[2:] if x.startswith("s:") else x)
    t = str(f.get("title") or "")
    own |= set(re.findall(r"【([^】（]+)", t)) | set(re.findall(r"（([A-Z0-9.\-]{1,8})）", t))
    if any(o and o in say for o in own):
        return None
    if any(w in say for w in ("它", "这只", "这票", "这家", "这波", "这里", "这块", "这股")):
        return None                                # "黄金都没它涨得猛": a comparison, still about the target
    hits = [nm for nm in sorted(names, key=len, reverse=True) if nm in say and nm not in allowed]
    return hits[0] if hits else None


def _past(by: str) -> bool:
    t = today_et()
    return bool(by) and by < (t if len(by) == 10 else t[:7])


def validate(raw, f: dict, max_reasons: int = 5, strict_subject: bool = True) -> tuple[dict, list[str], bool]:
    """→ (clean dict, issues, fatal). Fatal = not usable at all (no JSON, no say, not Chinese, placeholders);
    a sharp line about a different place than the card is fatal only with strict_subject (the first attempt —
    it buys the one retry; after that it is kept as an issue rather than losing the whole search)."""
    issues: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["回答不是 JSON 对象"], True
    nfix = fix_names(raw, f)
    if nfix:
        issues.append(f"改了 {nfix} 处公司名的错译（比如 Twist 不是「推特」）")
    say_full = zh_punct(_s(raw.get("say"), 160))
    say = short_say(say_full)
    if not say or PLACEHOLDER_RE.match(say):
        return {}, ["缺少 say（老风一句话）"], True
    if not has_han(say):
        return {}, ["say 不是中文"], True
    other = foreign_subject(say_full, f)
    if other:
        msg = f"老风这句说的是「{other}」，可这张卡问的是{(f.get('title') or '别的地方')[:30]}——说回卡片本身"
        if strict_subject:
            return {}, [msg], True
        issues.append(msg)
    reasons, dropped = [], 0
    for k, r in enumerate(raw.get("reasons") or []):
        if not isinstance(r, dict):
            dropped += 1
            continue
        text = zh_punct(_s(r.get("text"), 400))
        url = _s(r.get("url"), 600)
        d = norm_date(_s(r.get("date"), 30))
        if not text or PLACEHOLDER_RE.match(text):
            dropped += 1
            continue
        if not url_ok_shape(url):
            issues.append(f"第 {k + 1} 条原因没有可用的链接（{url[:60] or '空'}）")
            dropped += 1
            continue
        if not d:
            issues.append(f"第 {k + 1} 条原因日期不对（{_s(r.get('date'), 20) or '空'}）")
            dropped += 1
            continue
        typ = _s(r.get("type"), 30).lower()
        if typ not in REASON_TYPES:
            typ = "flow-mechanics" if any(w in typ for w in ("flow", "index", "option", "资金")) else "news"
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        reasons.append({"text": text, "date": d, "source": _s(r.get("source"), 80) or host, "url": url,
                        "type": typ, "conf": _conf(r.get("conf")), "rank": k + 1, "host": host})
    if dropped:
        issues.append(f"丢掉了 {dropped} 条没有链接/日期的原因")
    if reasons and not any(has_han(r["text"]) for r in reasons):
        return {}, ["原因不是中文"], True
    reasons = reasons[:max_reasons]
    counter = []
    for c in raw.get("counter") or []:
        if isinstance(c, str):
            c = {"text": c}
        if not isinstance(c, dict) or not _s(c.get("text")):
            continue
        item = {"text": zh_punct(_s(c.get("text"), 300))}
        if url_ok_shape(c.get("url")):
            item["url"] = _s(c.get("url"), 600)
            item["source"] = _s(c.get("source"), 80) or (urlparse(item["url"]).hostname or "").removeprefix("www.")
        d = norm_date(_s(c.get("date"), 30))
        if d:
            item["date"] = d
        counter.append(item)
    watch, stale_watch = [], 0
    for w in raw.get("watch") or []:
        if isinstance(w, str):
            w = {"by": "", "what": w}
        if not isinstance(w, dict) or not _s(w.get("what")):
            continue
        by = _s(w.get("by"), 20)
        m = re.match(r"^\d{4}-\d{2}(-\d{2})?", by)
        by = m.group(0) if m else by
        if m and _past(by):                      # "盯 2025-11-06 的财报" on a 2026 card: wrong year / already over
            stale_watch += 1
            continue
        watch.append({"by": by, "what": zh_punct(_s(w.get("what"), 200))})
    if stale_watch:
        issues.append(f"丢掉了 {stale_watch} 条日期已经过去的「接下来要盯」")
    honest = zh_punct(_s(raw.get("honest"), 500))
    if not honest:
        honest = "有明确新闻" if reasons else "没查到能对上日期的明确新闻"
    tl = _s(raw.get("timeline"), 12)
    if tl not in ("fits", "partly", "no-news"):
        tl = "no-news" if not reasons else "partly"
    if not reasons and tl != "no-news":
        tl = "no-news"
    if not reasons and not has_han(honest):
        return {}, ["没有原因，honest 也不是中文"], True
    mild = zh_punct(_s(raw.get("sayMild"), 120))
    if say != say_full:
        issues.append(f"老风这句太长（{len(say_full)} 字），截到了 {len(say)} 字")
    clean = {"say": say, "sayFull": say_full if say != say_full else None,
             "sayMild": mild if has_han(mild) else None, "reasons": reasons, "counter": counter[:4],
             "watch": watch[:4], "honest": honest, "timeline": tl}
    return clean, issues, False


# ── URL check ─────────────────────────────────────────────────────────────────────────────────────
def check_url(u: str, timeout: float = 7.0) -> dict:
    req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(1024)
            return {"ok": True, "status": r.status}
    except urllib.error.HTTPError as e:
        return {"ok": False if e.code in (404, 410) else None, "status": e.code}   # 401/403/429/5xx: paywall/bot wall
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        dead = "nodename nor servname" in reason or "Name or service not known" in reason
        return {"ok": False if dead else None, "status": None}
    except Exception:  # noqa: BLE001 — timeouts, TLS oddities: unknown, not dead
        return {"ok": None, "status": None}


def check_urls(items: list[dict]) -> int:
    """Marks each item with urlOk (True / False / None=unknown); dead links halve conf. Returns #dead."""
    urls = [it["url"] for it in items if it.get("url")]
    if not urls:
        return 0
    with ThreadPoolExecutor(max_workers=min(8, len(urls))) as ex:
        res = dict(zip(urls, ex.map(check_url, urls)))
    dead = 0
    for it in items:
        r = res.get(it.get("url"))
        if not r:
            continue
        it["urlOk"] = r["ok"]
        if r["ok"] is False:
            dead += 1
            if "conf" in it:
                it["conf"] = round(it["conf"] * 0.5, 2)
    return dead


def _norm_url(u: str) -> str:
    u = (u or "").strip().rstrip(".,;:")
    p = urlparse(u)
    return (p.hostname or "").lower().removeprefix("www.") + p.path.rstrip("/")


def mark_seen(items: list[dict], seen_urls: list[str]) -> int:
    """seen=True when the link (host+path) showed up in this run's search results / fetched pages (from the
    gateway's trace); an unseen link may be invented → conf × 0.6. Returns #unseen."""
    seen = {_norm_url(u) if "://" in u else u.rstrip("/") for u in seen_urls if u}   # the gateway sends host+path
    hosts = {s.split("/", 1)[0] for s in seen}
    n = 0
    for it in items:
        u = it.get("url")
        if not u:
            continue
        nu = _norm_url(u)
        ok = nu in seen or (len(nu) > 20 and any(s.startswith(nu) for s in seen))
        it["seen"] = bool(ok)
        if not ok:
            n += 1
            if "conf" in it:
                it["conf"] = round(it["conf"] * (0.8 if nu.split("/", 1)[0] in hosts else 0.6), 2)
    return n


# ── the card ──────────────────────────────────────────────────────────────────────────────────────
def make_card(clean: dict, f: dict, g: dict | None, issues: list[str]) -> dict:
    g = g or {}
    reasons = sorted(clean.get("reasons") or [], key=lambda r: (r.get("date") or "", -r.get("rank", 0)), reverse=True)
    return {
        "key": f["key"], "asOf": f.get("asOf"), "date": f.get("date"), "map": f.get("map"),
        "target": f.get("target"), "kind": f.get("kind"), "ids": f.get("ids"),
        "title": f.get("title"), "question": f.get("question"),
        "say": clean.get("say"), "sayMild": clean.get("sayMild"), "sayFull": clean.get("sayFull"),
        "facts": f.get("facts"), "partial": f.get("partial"),
        # when the reasons were researched: on a still-forming intraday bar (etTime ET) or on a closed day.
        # `partial` above describes the facts shown and is refreshed when the data moves on; this stays.
        "snapshot": snapshot_of(f), "factsPartialAt": f.get("partialAt"),
        "focus": _focus_brief(f.get("focus")),
        "regime": _regime_brief(f.get("regime")), "day": f.get("day"),
        "reasons": reasons, "counter": clean.get("counter") or [], "watch": clean.get("watch") or [],
        "honest": clean.get("honest"), "timeline": clean.get("timeline"),
        "usd": round(num(g.get("usd")) or 0.0, 4), "ms": g.get("ms"), "model": g.get("model"),
        "tokens": {"in": g.get("inTok"), "out": g.get("outTok")},
        "issues": issues[:8], "at": iso_now(), "version": 1,
    }


def snapshot_of(f: dict) -> dict:
    at = f.get("partialAt")
    return {"date": f.get("date"), "asOf": f.get("asOf"), "partial": at is not None, "etTime": at or None,
            "say": (f"盘中查的（截至美东 {at}）" if at else (f"盘中查的" if at == "" else None))}


def _focus_brief(fo: dict | None) -> dict | None:
    if not fo:
        return None
    return {k: fo.get(k) for k in ("date", "ret", "volX", "flow", "partial", "etTime", "when", "move", "together",
                                   "togetherWord", "peers", "grp", "text")}


def _regime_brief(r: dict | None) -> dict | None:
    if not r:
        return None
    return {k: r.get(k) for k in ("dir", "start", "days", "cumFlow", "ret", "trigger", "peak", "fronts", "fading", "windNow")}
