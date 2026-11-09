#!/usr/bin/env python3
"""intel/ingest.py — 情报投喂: feed anything in, get 1–3 intel events on the map (DESIGN.md §11).

    python3 intel/ingest.py --text "美光说明年 HBM 已经卖光"           # paste
    python3 intel/ingest.py --url https://www.reuters.com/...          # a link (fetched with stdlib)
    python3 intel/ingest.py --url https://… --text "我的看法：…"        # link + your note
    python3 intel/ingest.py --file ~/Desktop/article.html               # .txt / .md / .html
    python3 intel/ingest.py --list                                      # what is stored
    python3 intel/ingest.py --delete intel-261027231005-ab12            # one event, or a whole input

Prints the stored events as JSON (a list) on stdout; progress goes to stderr.
Flags: --dry-run (don't store), --force (ingest again even if this input was fed before),
--source paste|url|claude, --model sonnet|opus, --job <id> (used by job.py; reads the job's input file).

Rule: measured weather is never altered. This only appends to the intel layer (store.INTEL_PATH).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import secrets
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from intel import catalog as catmod  # noqa: E402
from intel import fetch as fetchmod  # noqa: E402
from intel import links, llm, store  # noqa: E402

MAX_INPUT_CHARS = 400_000      # what we accept
MAX_PROMPT_CHARS = 12_000      # what goes into the prompt (owner text + page text together)
LAG_ORDER = {"now": 0, "1-3m": 1, "3-12m": 2}
KIND_ALIASES = {"report": "news", "announcement": "news", "statistic": "data", "stats": "data", "macro": "data",
                "gossip": "rumor", "leak": "rumor", "analysis": "opinion", "commentary": "opinion",
                "post": "opinion", "earning": "earnings", "guidance": "earnings", "regulation": "policy",
                "law": "policy", "government": "policy"}

Progress = Callable[[str, str], None]


def _today() -> date:
    env = os.environ.get("MW_TODAY")
    if env:
        try:
            return date.fromisoformat(env)
        except ValueError:
            pass
    return date.today()


def _say(progress: Progress | None, key: str, zh: str) -> None:
    if progress:
        progress(key, zh)


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


_FULLWIDTH = {",": "，", "?": "？", "!": "！", ":": "：", ";": "；"}
_CJK_RE = r"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]"


def _short(s: Any, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).replace("\ufffd", "").strip()
    s = s.replace("——", "，").replace("—", "，")   # house style: no dashes
    # half-width punctuation glued to Chinese → full-width ("截图,也配?" → "截图，也配？"); numbers untouched
    s = re.sub(rf"(?<={_CJK_RE})\s?([,?!:;])\s?|([,?!:;])\s?(?={_CJK_RE})",
               lambda m: _FULLWIDTH[m.group(1) or m.group(2)], s)
    return s if len(s) <= n else s[: n - 1].rstrip("，,。. ") + "…"


def _norm_date(s: Any, today: date) -> str:
    t = str(s or "").strip()
    m = re.match(r"(20\d\d)[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?", t)
    if not m:
        return today.isoformat()
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3) or 1)
    try:
        dt = date(y, mo, d)
    except ValueError:
        return today.isoformat()
    # an "event date" far in the future is almost always a misread; keep it (it can be a scheduled
    # event like an FOMC meeting) but never more than ~2 years out
    if dt > today + timedelta(days=730) or dt < date(2000, 1, 1):
        return today.isoformat()
    return dt.isoformat()


# ─────────────────────────────────────── priced in? ───────────────────────────────────────────
def priced_in(direction: int, wx: dict, novelty: str) -> float:
    """0–1 estimate (heuristic, labelled 估的) of how much of this impact today's prices already carry.
    Same spirit as the scenario engine (§9): crowded summer + good news → mostly priced;
    winter/spring with low crowding → the market hasn't run with it yet."""
    w, p, key = wx["wind"], wx["pres"], wx["season"]["key"]
    x = 0.5 + 0.10 * _clip(direction * w, -2, 2) + 0.20 * direction * (p - 50) / 50
    if direction > 0:
        if key == "summer" and p >= 80:
            x = max(x, 0.8)
        elif key in ("winter", "spring") and p < 50:
            x = min(x, 0.3)
    else:
        if key in ("autumn", "winter"):
            x = max(x, 0.6)
        elif key == "summer" and p >= 80:
            x = min(x, 0.25)
    if novelty == "old":
        x = max(x, 0.85)
    elif novelty == "probably-known":
        x += 0.1
    return round(_clip(x, 0.05, 0.95), 2)


def priced_say(direction: int, pi: float, wx: dict, voice: str = "sharp", novelty: str = "new") -> str:
    """One line under the impact: today's season + crowding vs the news. Numbers stay in badges.
    Old news is "already in the price" because it is old, not because the crowd ran with it."""
    season = wx["season"]
    tag = f"{season['emoji']}{season['name']}，" if season["name"] else ""
    p = wx["pres"]
    crowd = "人挤人" if p >= 85 else "人多" if p >= 65 else "人少" if p < 35 else "人不多不少"
    mild = voice == "mild"
    if novelty == "old":
        return f"{tag}{crowd}，旧事，早就在价格里了" if mild else f"{tag}{crowd}，陈年旧事，价格早消化完了"
    crowded = p >= 65
    if direction > 0:
        if pi >= 0.7:
            if mild:
                return f"{tag}{crowd}，好消息多半已经算进价格了"
            return (f"{tag}{crowd}，早被抢跑了，现在进去是接最后一棒" if crowded
                    else f"{tag}{crowd}，消息早传开了，价格里已经有了")
        if pi <= 0.35:
            return f"{tag}{crowd}，市场还没按这条消息算" if mild else f"{tag}{crowd}，市场还没按这条算，时间差在这"
        return f"{tag}{crowd}，算进去了一部分" if mild else f"{tag}{crowd}，算进去一半，剩下的看后续"
    if pi >= 0.7:
        return f"{tag}钱已经在撤，坏消息多半已经算进去了" if mild else f"{tag}钱早就在跑，坏消息已经砸进价格了"
    if pi <= 0.35:
        return (f"{tag}{crowd}，坏消息还没算进去，留意" if mild
                else f"{tag}{crowd}，还没人当回事，挤着的人要被踩" if crowded
                else f"{tag}{crowd}，坏消息还没进价格")
    return f"{tag}坏消息算进去了一部分" if mild else f"{tag}坏消息砸进去一半，还没完"


# ─────────────────────────────────────── validation ───────────────────────────────────────────
class Rejected(Exception):
    """The model's answer can't be used as-is (worth one retry)."""


def clean_events(obj: Any, *, cat: catmod.Catalog, markets: list[dict], scenarios: list[dict],
                 today: date, mentioned: set[str] | None = None) -> tuple[list[dict], dict]:
    """Validate + repair the model's events. Returns (events, report{repairs, dropped, issues}).
    Raises Rejected when nothing usable came back."""
    rep: dict = {"repairs": [], "dropped": [], "issues": []}
    if isinstance(obj, list):
        obj = {"events": obj}
    if not isinstance(obj, dict):
        raise Rejected("输出不是 JSON 对象")
    evs = obj.get("events")
    if isinstance(evs, dict):
        evs = [evs]
    if isinstance(evs, list) and not evs and not obj.get("title"):
        # the model's honest answer: this input has nothing to do with where money goes
        rep["reason"] = _short(obj.get("reason") or "看不出跟钱的流向有什么关系", 60)
        return [], rep
    if not isinstance(evs, list) or not evs:
        if obj.get("title"):
            evs = [obj]
        else:
            raise Rejected("没有 events 数组")
    mk = {m["id"]: m for m in markets}
    sc = {s["id"]: s for s in scenarios}
    out = []
    unknown_total, ids_total = 0, 0
    for raw in evs[:3]:
        if not isinstance(raw, dict):
            rep["issues"].append("有一条事件不是对象，已丢掉")
            continue
        title = _short(raw.get("title"), 32)
        if not title:
            rep["issues"].append("有一条事件没有标题，已丢掉")
            continue
        kind = str(raw.get("kind") or "news").strip().lower()
        kind = kind if kind in llm.KINDS else KIND_ALIASES.get(kind, "news")
        try:
            cred = float(raw.get("credibility"))
            cred = cred / 100 if cred > 1 else cred
            cred = round(_clip(cred if math.isfinite(cred) else 0.5, 0.0, 1.0), 2)
        except (TypeError, ValueError):
            cred = 0.5
        nov = str(raw.get("novelty") or "probably-known").strip().lower().replace("_", "-").replace(" ", "-")
        nov = nov if nov in llm.NOVELTY else ("new" if nov.startswith("new") else "old" if "old" in nov
                                              else "probably-known")
        sig = str(raw.get("signal") or "minor").strip().lower()
        sig = sig if sig in llm.SIGNALS else ("noise" if "nois" in sig else "major" if sig in ("big", "strong")
                                              else "minor")
        # honesty caps: a rumour or an opinion can't be near-certain, whatever the model says
        if kind == "rumor":
            cred = min(cred, 0.5)
        elif kind == "opinion":
            cred = min(cred, 0.6)
        ev_date = _norm_date(raw.get("eventDate"), today)
        age = (today - date.fromisoformat(ev_date)).days
        if (age > 7 and nov == "new") or age > 30:
            nov = "old"                     # a week-old event can't be news to the market

        # impacts on regions
        imps: dict[str, dict] = {}

        def put(nid: str, d: int, s: int, lag: str, why: str) -> None:
            if nid == cat.root:
                return
            prev = imps.get(nid)
            if prev is None or s > prev["strength"]:
                imps[nid] = {"id": nid, "dir": d, "strength": s, "lag": lag, "why": why}
            elif prev["dir"] != d and s == prev["strength"]:
                rep["issues"].append(f"{nid} 方向矛盾，已丢掉")
                imps.pop(nid, None)

        for it in raw.get("impacts") or []:
            if not isinstance(it, dict):
                continue
            ids_total += 1
            rid = it.get("id")
            nid = cat.repair_id(rid)
            if not nid:
                unknown_total += 1
                rep["dropped"].append(str(rid)[:40])
                continue
            if nid != rid:
                rep["repairs"].append({"from": str(rid)[:40], "to": nid})
            try:
                d = 1 if float(it.get("dir", 1)) >= 0 else -1
            except (TypeError, ValueError):
                d = 1
            try:
                s = int(round(_clip(float(it.get("strength", 1)), 1, 3)))
            except (TypeError, ValueError):
                s = 1
            lag = str(it.get("lag") or "now").strip().lower()
            lag = lag if lag in LAG_ORDER else ("3-12m" if ("y" in lag or "12" in lag) else
                                               "1-3m" if ("m" in lag or "week" in lag or "周" in lag) else "now")
            put(nid, d, s, lag, _short(it.get("why"), 40))

        off_map, n_stock = [], 0
        mentioned = mentioned or set()
        for tk in raw.get("tickers") or []:
            if isinstance(tk, str):
                tk = {"t": tk, "dir": 1}
            if not isinstance(tk, dict) or not tk.get("t"):
                continue
            t = str(tk["t"]).strip().upper().lstrip("$").replace(".", "-")
            sid = cat.ticker_id(t)
            try:
                d = 1 if float(tk.get("dir", 1)) >= 0 else -1
            except (TypeError, ValueError):
                d = 1
            if sid:
                # A stock adds something only if the text names it, or its region isn't already covered
                # the same way. Otherwise "all memory stocks up" just repeats "memory up" five times.
                covered = any(imps.get(p, {}).get("dir") == d for p in cat.nodes[sid].parents)
                if (sid in mentioned or not covered) and n_stock < 3:
                    put(sid, d, 2, "now", _short(tk.get("why") or f"{cat.nodes[sid].name} 被直接点名", 40))
                    n_stock += 1
            elif re.fullmatch(r"[A-Z0-9-]{1,7}", t):
                off_map.append(t)

        impacts = list(imps.values())
        if sig == "noise":
            for im in impacts:
                im["strength"] = 1
            impacts = impacts[:2]
        impacts.sort(key=lambda im: (LAG_ORDER[im["lag"]], -im["strength"]))
        impacts = impacts[:8]

        pm = []
        for p in raw.get("polymarket") or []:
            if not isinstance(p, dict):
                continue
            m = mk.get(str(p.get("id")))
            if not m:
                if p.get("id"):
                    rep["dropped"].append("pm:" + str(p.get("id"))[:30])
                continue
            rel = str(p.get("relation") or "").lower()
            rel = rel if rel in llm.RELATIONS else "supports"
            pm.append({"id": m["id"], "q": m["q"], "qZh": m.get("qZh") or "", "prob": m["prob"], "d7": m.get("d7"),
                       "relation": rel, "say": _short(p.get("say"), 60), "url": m.get("url")})

        scs = []
        for s in raw.get("scenarios") or []:
            if not isinstance(s, dict):
                continue
            hit = sc.get(str(s.get("id")))
            if not hit:
                if s.get("id"):
                    rep["dropped"].append("scenario:" + str(s.get("id"))[:30])
                continue
            eff = str(s.get("effect") or "").lower()
            eff = eff if eff in llm.EFFECTS else ("weakens" if "weak" in eff else "hits-kill-signal" if "kill" in eff
                                                  else "supports")
            scs.append({"id": hit["id"], "title": hit["title"], "effect": eff, "say": _short(s.get("say"), 60)})

        say = _short(raw.get("say"), 80)
        mild = _short(raw.get("sayMild"), 80) or say
        if sig == "noise" and "噪" not in say:
            say = (say.rstrip("。") + "。" if say else "") + "噪音，别追。"
        if sig == "noise" and "噪" not in mild:
            mild = (mild.rstrip("。") + "。" if mild else "") + "多半是噪音。"
        if not say:
            say = mild or title
        out.append({"title": title, "summary": _short(raw.get("summary"), 220), "eventDate": ev_date,
                    "kind": kind, "credibility": cred, "novelty": nov, "signal": sig, "impacts": impacts,
                    "polymarket": pm, "scenarios": scs, "say": say, "sayMild": mild, "offMap": off_map[:6]})
    if not out:
        raise Rejected("没有一条能用的事件")
    if ids_total >= 2 and unknown_total / ids_total > 0.5:
        raise Rejected(f"一半以上的领地 id 不在清单里：{', '.join(rep['dropped'][:6])}")
    return out, rep


def enrich(ev: dict, cat: catmod.Catalog, tree_now: dict) -> dict:
    """Add names, paths, the priced-in check and `reach` (signed pressure on every ancestor)."""
    reach: dict[str, float] = {}
    gone = [im.get("id") for im in ev.get("impacts") or [] if im.get("id") not in cat.nodes]
    if gone:                                   # the map changed under a stored event: drop what is no longer drawn
        ev["impacts"] = [im for im in ev["impacts"] if im.get("id") in cat.nodes]
        meta = ev.setdefault("meta", {}) if isinstance(ev.get("meta", {}), dict) else {}
        meta.setdefault("dropped", []).extend(str(g)[:40] for g in gone)
    for im in ev["impacts"]:
        nid = im["id"]
        im["name"] = cat.nodes[nid].name
        im["path"] = " › ".join(cat.path_names(nid)[1:])
        # §14: an intel impact is always an interpretation, never measured weather
        im["est"] = True
        im.setdefault("basis", "Claude 按情报推断" if ev.get("source") != "scout" else "侦察兵查到的资料推断")
        wx = catmod.weather_now(cat, nid, tree_now)
        if wx:
            pi = priced_in(im["dir"], wx, ev["novelty"])
            im["pricedIn"] = pi
            im.setdefault("pricedIn0", pi)     # at the time it was fed; --refresh moves pricedIn, not this
            im["gap"] = round(im["strength"] * (1 - pi), 2)
            im["season"] = wx["season"]["key"]
            im["nowSay"] = priced_say(im["dir"], pi, wx, "sharp", ev["novelty"])
            im["nowSayMild"] = priced_say(im["dir"], pi, wx, "mild", ev["novelty"])
        else:
            # 宁可估不可空: no weather yet → a neutral prior, labelled as such
            pi = 0.85 if ev.get("novelty") == "old" else 0.5
            im["pricedIn"] = pi
            im["gap"] = round(im["strength"] * (1 - pi), 2)
            im["season"] = None
            im["nowSay"] = im["nowSayMild"] = "这块还没有天气数据，先按一半算进价格估"
        v = im["dir"] * im["strength"]
        reach[nid] = reach.get(nid, 0.0) + v
        for k, a in enumerate(cat.ancestors(nid), start=1):
            reach[a] = reach.get(a, 0.0) + v * (0.6 ** k)
    ev["reach"] = {k: round(_clip(v, -3, 3), 2) for k, v in sorted(reach.items(), key=lambda kv: -abs(kv[1]))
                   if abs(v) >= 0.05}
    ev["weight"] = event_weight(ev)
    return ev


SIGNAL_W = {"noise": 0.2, "minor": 0.6, "major": 1.0}
NOVELTY_W = {"new": 1.0, "probably-known": 0.6, "old": 0.15}


def event_weight(ev: dict) -> float:
    """0–1: how loudly the page should draw this event when it is fresh (before fading with age).
    credibility × signal × novelty, so a credible new major item is ~1, old news or noise is a whisper."""
    try:
        c = float(ev.get("credibility") or 0)
    except (TypeError, ValueError):
        c = 0.0
    w = c * SIGNAL_W.get(ev.get("signal"), 0.6) * NOVELTY_W.get(ev.get("novelty"), 0.6)
    return round(_clip(w, 0.0, 1.0), 2)


def adopt_external(raw: dict) -> dict:
    """Normalise an event written by another module (the scout, §15) so the page can treat every event
    alike: enums/ranges checked, impact ids repaired against the map (unknown ones dropped), names,
    paths, priced-in estimate and `reach` added. Keeps every extra field it does not know about."""
    today = _today()
    cat = catmod.load_catalog()
    ev = dict(raw)
    imps_in = [dict(i) for i in (raw.get("impacts") or []) if isinstance(i, dict)]
    probe = {"events": [{**{k: raw.get(k) for k in ("title", "summary", "eventDate", "kind", "credibility",
                                                    "novelty", "signal", "say", "sayMild")},
                         "title": raw.get("title") or raw.get("say") or "侦察兵的情报",
                         "signal": raw.get("signal") or "minor",
                         "impacts": imps_in, "tickers": [], "polymarket": [], "scenarios": []}]}
    try:
        cleaned, rep = clean_events(probe, cat=cat, markets=[], scenarios=[], today=today)
        c = cleaned[0]
    except Rejected as e:
        c = {"impacts": [], "title": _short(raw.get("title") or raw.get("say") or "侦察兵的情报", 32)}
        rep = {"repairs": [], "dropped": [str(i.get("id"))[:40] for i in imps_in], "issues": [str(e)]}
    for k in ("title", "eventDate", "kind", "credibility", "novelty", "signal", "impacts", "say", "sayMild"):
        if k in c:
            ev[k] = c[k]
    ev["summary"] = _short(raw.get("summary") or c.get("summary") or "", 400)
    ev.setdefault("polymarket", [])
    ev.setdefault("scenarios", [])
    ev.setdefault("offMap", [])
    ev["groupId"] = ev.get("groupId") or ev.get("id")
    ev["addedAt"] = str(ev.get("addedAt") or datetime.now().strftime("%Y-%m-%dT%H:%M"))[:16]
    ev["source"] = ev.get("source") if ev.get("source") in ("paste", "url", "claude", "scout") else "scout"
    enrich(ev, cat, catmod.tree_now_index())
    meta = ev.get("meta") if isinstance(ev.get("meta"), dict) else {}
    meta.update({"adopted": True, "catalog": cat.source, "repairs": rep.get("repairs", []),
                 "dropped": rep.get("dropped", []), "issues": rep.get("issues", [])})
    ev["meta"] = meta
    return ev


def refresh_all() -> dict:
    """Re-check every stored event against today's weather (pricedIn / gap / season / nowSay / reach /
    weight move as the market moves; pricedIn0 keeps the value from the day it was fed). Scout events
    that were never validated get adopted. Run after each data update (the loop's job)."""
    cat = catmod.load_catalog()
    tree_now = catmod.tree_now_index()
    n = adopted = 0
    with store.locked():
        cur = store._read(quarantine=True)
        out = []
        for ev in cur:
            try:
                meta = ev.get("meta") if isinstance(ev.get("meta"), dict) else {}
                if ev.get("source") not in ("paste", "url", "claude") and not meta.get("adopted"):
                    ev = adopt_external(ev)
                    adopted += 1
                else:
                    ev.setdefault("sayMild", ev.get("say", ""))
                    enrich(ev, cat, tree_now)
                n += 1
            except Exception as e:  # noqa: BLE001 — one odd event must not block the rest
                (ev.setdefault("meta", {}) if isinstance(ev.get("meta", {}), dict) else {}).setdefault(
                    "issues", []).append(f"refresh failed: {type(e).__name__}")
            out.append(ev)
        if out:
            store.atomic_write_json(store.INTEL_PATH, out)
    return {"refreshed": n, "adopted": adopted, "total": len(out)}


# ─────────────────────────────────────────── main flow ────────────────────────────────────────
def _input_hash(url: str, text: str) -> str:
    norm = re.sub(r"\s+", " ", (text or "")).strip()[:20000]
    return hashlib.sha1(((url or "").strip() + "\n" + norm).encode("utf-8")).hexdigest()[:16]


def _split_bare_url(text: str) -> tuple[str, str]:
    """If the pasted text is basically one link (+ a short note), treat it as a URL."""
    urls = re.findall(r"https?://[^\s<>\"'）)】]+", text or "")
    if len(urls) == 1:
        rest = (text.replace(urls[0], " ")).strip()
        if len(rest) <= 300:
            return urls[0].rstrip(".,;:!?。，；："), rest
    return "", text


def _read_file(path: str) -> tuple[str, str]:
    """→ (text, published date if the file is a saved web page)."""
    p = Path(path).expanduser()
    raw = p.read_bytes()[: MAX_INPUT_CHARS * 4]
    doc = fetchmod._decode(raw, "")
    if p.suffix.lower() in (".html", ".htm", ".xhtml") or re.search(r"<(html|body)\b", doc[:2000], re.I):
        info = fetchmod.html_to_text(doc)
        return ((info["title"] + "\n") if info["title"] else "") + info["text"], info["published"]
    return doc, ""


def ingest(*, text: str | None = None, url: str | None = None, file: str | None = None,
           source: str | None = None, force: bool = False, dry_run: bool = False,
           model: str | None = None, progress: Progress | None = None) -> dict:
    """→ {ok, events, warnings, error, dup, groupId}. Never raises for expected failures."""
    t_start = time.monotonic()
    today = _today()
    warnings: list[str] = []
    text = (text or "").strip()
    file_date = ""
    if file:
        try:
            ftxt, file_date = _read_file(file)
        except OSError as e:
            return {"ok": False, "events": [], "warnings": [], "error": f"文件读不了：{e.strerror or e}"}
        text = (text + "\n\n" + ftxt).strip() if text else ftxt.strip()
    url = (url or "").strip()
    if not url and text:
        url, text = _split_bare_url(text)
    text = text[:MAX_INPUT_CHARS]
    if not text and not url:
        return {"ok": False, "events": [], "warnings": [], "error": "没有内容：请贴一段文字或一个网址"}
    if source not in ("paste", "url", "claude"):
        source = "url" if (url and not text) else "paste"

    # duplicate?
    ihash = _input_hash(url, text)
    if not force:
        prev = store.find_by_hash(ihash)
        if prev:
            when = (prev[0].get("addedAt") or "")[:16].replace("T", " ")
            return {"ok": True, "events": prev, "dup": True, "groupId": prev[0].get("groupId"),
                    "warnings": [f"这条在 {when} 已经投喂过，没有重复存（要重来加 --force）"], "error": None}

    # fetch
    page_text, fetch_info, source_bits = "", None, []
    if url:
        _say(progress, "fetch", "正在抓网页…")
        fr = fetchmod.fetch_url(url)
        fetch_info = fr.summary()
        url = fr.url or url
        if fr.ok:
            page_text = fr.text
            warnings += fr.notes
            source_bits.append(f"网页 {fr.final_url or fr.url}")
            if fr.title:
                source_bits.append(f"标题：{fr.title}")
            if fr.published:
                source_bits.append(f"网页标的日期：{fr.published}")
        else:
            warnings.append(fr.error or "网页抓不到")
            slug = fetchmod.slug_words(url)
            if len(slug.split()) >= 3 or len(slug) >= 8:
                page_text = f"（网页没抓到，下面只是网址里的字，可信度要打折）\n{slug}"
                source_bits.append(f"网页没抓到，只有网址 {url}")
                if len(text) < 200:
                    warnings.append("只看了网址里的字，可信度已打折")
            elif len(text) < 40:
                return {"ok": False, "events": [], "warnings": warnings,
                        "error": (fr.error or "网页抓不到") + "。请把文字直接贴进来。"}
            else:
                source_bits.append(f"网页没抓到（{url}），只用主人贴的文字")
    if text:
        source_bits.insert(0, "主人贴的文字" if source != "claude" else "主人在 Claude Code 里转述")
    if file_date:
        source_bits.append(f"文件里网页标的日期：{file_date}")

    # budget the prompt: owner text first, page text fills the rest
    owner = text[:MAX_PROMPT_CHARS]
    page = page_text[: max(0, MAX_PROMPT_CHARS - len(owner))]
    if len(text) > MAX_PROMPT_CHARS or len(page_text) > len(page):
        warnings.append("内容很长，只读了前面一部分")

    # context
    _say(progress, "context", "正在对照地图、预言市场和你的推演…")
    cat = catmod.load_catalog()
    tree_now = catmod.tree_now_index()
    scan_src = (fetch_info or {}).get("title", "") + "\n" + owner + "\n" + page
    mentions = cat.scan_mentions(scan_src)
    hint = {r for m in mentions for r in m["regions"]}
    markets = links.polymarket_candidates(owner + "\n" + page, hint)
    scenarios = links.saved_scenarios()
    # what was fed lately (helps the model call "old"), minus this very input when the owner forces a re-feed
    recent = [{"title": e.get("title", ""), "eventDate": e.get("eventDate", "")} for e in store.load()[:12]
              if (e.get("input") or {}).get("hash") != ihash][:8]
    user = llm.build_user_prompt(today=today.isoformat(), tree_text=cat.compact_text(), mentions=mentions,
                                 markets=markets, scenarios=scenarios, recent=recent,
                                 source_line="；".join(source_bits) or "主人贴的文字", owner_text=owner,
                                 page_text=page)

    # Claude (+ one retry)
    attempts, last_err, cleaned, report, info = 0, "", None, {}, {}
    prompt, effort = user, None
    for attempt in range(2):
        attempts += 1
        _say(progress, "claude", "Claude 正在读…" if attempt == 0 else "Claude 第二次尝试…")
        try:
            obj, info = llm.call_claude(llm.SYSTEM, prompt, model=model, effort=effort)
        except llm.ClaudeError as e:
            last_err = str(e)
            if "找不到 claude" in last_err:
                break
            # too slow or crashed → retry shorter and with less thinking, so the total stays bounded
            prompt = user + "\n\n（上一次没有答完或出错了。这次答得短一点，只输出 JSON。）"
            effort = "low"
            continue
        try:
            cleaned, report = clean_events(obj, cat=cat, markets=markets, scenarios=scenarios, today=today,
                                           mentioned={m["id"] for m in mentions})
            break
        except Rejected as e:
            last_err = f"Claude 的回答不合格：{e}"
            prompt = (user + f"\n\n你上一次的输出有问题：{e}。只用清单里的 id，严格按 JSON 结构输出 "
                      "{\"events\":[…]}，不要别的文字。")
    if cleaned is None:
        return {"ok": False, "events": [], "warnings": warnings, "error": last_err or "Claude 没给出能用的结果"}
    if not cleaned:
        # honest "nothing here": nothing stored, the owner is told why
        why = report.get("reason") or "看不出跟钱的流向有什么关系"
        return {"ok": True, "events": [], "irrelevant": True, "dup": False, "groupId": None, "error": None,
                "warnings": warnings + [f"没上地图：{why}"],
                "meta": {"ms": info.get("ms"), "attempts": attempts,
                         "totalMs": int((time.monotonic() - t_start) * 1000)}}

    # finish events
    _say(progress, "save", "正在存进情报层…")
    now = datetime.now()
    group = f"intel-{now.strftime('%y%m%d%H%M%S')}-{secrets.token_hex(2)}"
    fetch_failed = bool(fetch_info and not fetch_info.get("ok"))
    excerpt = _short(text or page_text, 200)
    events = []
    known_date = file_date or ((fetch_info or {}).get("published") or "")
    for k, ev in enumerate(cleaned, start=1):
        if known_date and known_date <= today.isoformat() and (
                ev["eventDate"] > today.isoformat()            # a published article can't be about tomorrow
                or (ev["eventDate"] == today.isoformat() and known_date < ev["eventDate"])):  # "today" = no idea
            ev["eventDate"] = known_date
            age = (today - date.fromisoformat(known_date)).days
            if (age > 7 and ev["novelty"] == "new") or age > 30:
                ev["novelty"] = "old"
        if fetch_failed and len(text) < 200:     # we never read the article itself
            ev["credibility"] = round(min(ev["credibility"], 0.4), 2)
        enrich(ev, cat, tree_now)
        events.append({
            "id": f"{group}-{k}", "groupId": group, "addedAt": now.strftime("%Y-%m-%dT%H:%M"),
            "source": source, "url": url or None,
            **ev,
            "input": {"excerpt": excerpt, "hash": ihash, "chars": len(text) + len(page_text),
                      "fetch": fetch_info},
            "meta": {"model": info.get("model"), "effort": info.get("effort"), "ms": info.get("ms"),
                     "attempts": attempts,
                     "totalMs": int((time.monotonic() - t_start) * 1000), "catalog": cat.source,
                     "repairs": report.get("repairs", []), "dropped": report.get("dropped", []),
                     "issues": report.get("issues", [])},
        })
    if not dry_run:
        store.add(events)
    return {"ok": True, "events": events, "warnings": warnings, "error": None, "dup": False, "groupId": group}


# ─────────────────────────────────────────── job mode ─────────────────────────────────────────
def _run_job(job_id: str) -> int:
    from intel import job as jobmod
    inp = jobmod.read_input(job_id)
    if inp is None:
        jobmod.write_status(job_id, state="error", stage="出错了", error="找不到这条任务的输入")
        return 1
    jobmod.write_status(job_id, state="running", stage="开始消化…", pid=os.getpid())

    def progress(key: str, zh: str) -> None:
        jobmod.write_status(job_id, state="running", stage=zh, step=key)

    try:
        res = ingest(text=inp.get("text"), url=inp.get("url"), source=inp.get("source"),
                     force=bool(inp.get("force")), progress=progress)
    except Exception as e:  # last-resort guard so the job never hangs in "running"
        jobmod.write_status(job_id, state="error", stage="出错了", error=f"内部错误：{type(e).__name__}: {e}")
        jobmod.drop_input(job_id)
        return 1
    if res["ok"]:
        n = len(res["events"])
        stage = ("这条之前投喂过" if res.get("dup") else "看完了：这条跟钱的流向没关系，没上地图"
                 if res.get("irrelevant") else f"好了：变成了 {n} 条情报")
        jobmod.write_status(job_id, state="done", stage=stage, events=res["events"], warnings=res["warnings"],
                            dup=bool(res.get("dup")), irrelevant=bool(res.get("irrelevant")),
                            groupId=res.get("groupId"))
    else:
        jobmod.write_status(job_id, state="error", stage="没成功", error=res["error"], warnings=res["warnings"])
    jobmod.drop_input(job_id)
    return 0 if res["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="情报投喂：把一段文字或一个网址变成地图上的情报")
    ap.add_argument("--text", help="pasted text (use - to read stdin)")
    ap.add_argument("--url", help="a link to fetch")
    ap.add_argument("--file", help=".txt / .md / .html file")
    ap.add_argument("--source", choices=["paste", "url", "claude"], help="how it arrived (default: guessed)")
    ap.add_argument("--force", action="store_true", help="ingest again even if fed before")
    ap.add_argument("--dry-run", action="store_true", help="don't store, just print")
    ap.add_argument("--model", help="claude model alias (default sonnet, env MW_INTEL_MODEL)")
    ap.add_argument("--list", action="store_true", help="print stored events")
    ap.add_argument("--delete", metavar="ID", help="delete an event id or a whole input (groupId)")
    ap.add_argument("--refresh", action="store_true", help="re-check stored events against today's weather")
    ap.add_argument("--job", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    store.ensure_exists()
    if a.job:
        return _run_job(a.job)
    if a.list:
        print(json.dumps(store.load(), ensure_ascii=False, indent=1))
        return 0
    if a.refresh:
        print(json.dumps(refresh_all(), ensure_ascii=False))
        return 0
    if a.delete:
        n = store.delete(a.delete)
        print(json.dumps({"deleted": n}, ensure_ascii=False))
        return 0 if n else 1
    text = a.text
    if text == "-":
        text = sys.stdin.read()
    if not (text or a.url or a.file):
        ap.print_usage(sys.stderr)
        print("需要 --text、--url 或 --file 其中之一", file=sys.stderr)
        return 2

    def progress(key: str, zh: str) -> None:
        print(f"· {zh}", file=sys.stderr, flush=True)

    # From the command line it is usually Claude Code relaying what the owner told it → "claude".
    res = ingest(text=text, url=a.url, file=a.file, source=a.source or ("claude" if text or a.file else "url"),
                 force=a.force, dry_run=a.dry_run, model=a.model, progress=progress)
    for w in res.get("warnings") or []:
        print(f"! {w}", file=sys.stderr)
    if not res["ok"]:
        print(f"✗ {res['error']}", file=sys.stderr)
        print(json.dumps({"error": res["error"], "warnings": res.get("warnings", [])}, ensure_ascii=False))
        return 1
    evs = res["events"]
    if res.get("irrelevant"):
        print("✓ 看完了，没上地图", file=sys.stderr)
        print(json.dumps([], ensure_ascii=False))
        return 0
    where = "（没有存，--dry-run）" if a.dry_run else ("（之前就有）" if res.get("dup") else f"→ {store.INTEL_PATH}")
    ms = (evs[0].get("meta") or {}).get("totalMs") if evs else None
    print(f"✓ {len(evs)} 条情报{where}" + (f"，用了 {ms / 1000:.0f} 秒" if ms else ""), file=sys.stderr)
    for e in evs:
        mark = {"noise": "（噪音）", "major": "（大信号）"}.get(e.get("signal"), "")
        print(f"  · {e['title']}{mark}：{e['say']}", file=sys.stderr)
    print(json.dumps(evs, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
