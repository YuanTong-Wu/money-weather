"""why/job.py — 为什么 jobs (DESIGN §21, §24): one click → one background Claude search → one 原因卡, cached.

Server routes (server.py calls these):
    POST /api/why {target:{kind, ids:[…], dateIndex?|date?, map?}, force?}  → start(target, force)
         → {"id", "state":"queued", "key", "ahead", "position", "concurrent", "say", "title", "facts",
            "previous"?}                                                              a new search was started
                                                       (nothing waits: `concurrent` = other searches running at
                                                        once; `previous` = the stale card this one replaces)
         | {"id": null, "state":"cached", "key", "card"}                               free and instant
         | {"id": null, "state":"stale", "key", "card"}    free: researched on an intraday bar whose numbers have
                                                        moved since — card.stale {kind:'intraday'|'closed', at,
                                                        now?, say:"盘中查的（截至美东 14:15）· 收盘后数字变了",
                                                        ask?} and card.facts rebuilt from today's files
         | {"id", "state":"running"|"queued", "key", "duplicate": true}               same key already being searched
         | {"state":"refused", "key", "error":"今天的额度用完了（明天 00:00 恢复）", "budget"}
         | {"state":"error", "error"}                                                  bad target (HTTP 400)
    GET  /api/why?id=      → status(id)  {"id","key","state":"queued|running|done|error|refused","card"?,"error"?,
                                          "elapsed","ahead","position","title","facts"}
    GET  /api/why/peek?key=… | ?kind=&ids=&dateIndex=&map= | POST /api/why/peek {target}
                           → peek(...)  {"state":"cached"|"stale","key","card","age"} | {"state":"running","id","key"}
                                        | {"state":"none","key"}
    Every card read also carries live flags: card.snapshot {partial, etTime, say} (when the reasons were researched),
    card.stale (above), card.recheck {say} (made by a model other than budget.json force_model), card.old {say}
    (made on an earlier data day), card.currentTitle/currentQuestion (today's question when it differs).
    GET  /api/why          → overview(): recent cards, active jobs, budget, which gateway
    GET  /api/why/list     → recent(limit)

Target kinds: node | stock | day | edge | channel | landing | market (why/facts.py). Key = target + the data day
it is about (e.g. 'day~s_DNA~2026-10-06', 'node~ai-compute~2026-10-27'); the same key on the same data day is
never searched again unless force (重新查). Cards: web/data/why/<key>.json (also served statically at
data/why/<key>.json) + web/data/why/index.json. Job state: why/out/jobs/<id>.json.

No count or concurrency limit: every job runs at once in its own detached process (`python3 -m why.job --run <id>`),
so a server restart does not lose it. The only limit is spend — the gateway (common/claude_gate.py, or
why/_shim.py until it exists) refuses when today's points are used up.

CLI: python3 -m why.job ask '{"kind":"day","ids":["DNA"],"date":"2026-10-06"}' [--wait] [--force] [--dry-run]
     python3 -m why.job status <id> | peek <key> | list | facts '<target json>'
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime

from common import procs
from why import card as wcard
from why import facts as wfacts
from why import gate as wgate
from why import memo as wmemo
from why import prompt as wprompt
from why.util import (JOBS_DIR, ROOT, WHY_DIR, age_text, has_han, iso_now, load_config, locked, now_local,
                      parse_dt, read_json, write_json)

INDEX = WHY_DIR / "index.json"
ACTIVE = ("queued", "running")


# ── files ─────────────────────────────────────────────────────────────────────────────────────────
def _job_path(jid: str):
    return JOBS_DIR / f"{jid}.json"


def _check_id(jid: str) -> bool:
    return isinstance(jid, str) and 6 <= len(jid) <= 40 and all(c.isalnum() or c in "-_" for c in jid)


def _card_path(key: str):
    return WHY_DIR / f"{key}.json"


def read_card(key: str, *, live: bool = True) -> dict | None:
    """The cached card. live=True also checks it against today's data: a card researched on a still-forming
    intraday bar whose numbers have since moved comes back with `stale` set and its measured side (title, facts,
    partial) rebuilt from the current files — the reasons stay as researched (重新查 to search again)."""
    if not isinstance(key, str) or not wfacts.KEY_RE.match(key):
        return None
    c = read_json(_card_path(key))
    if isinstance(c, dict) and c.get("say"):
        c = dict(c)
        c["age"] = age_text(c.get("at"))
        if live:
            c = annotate(c)
        return c
    return None


def snapshot(c: dict) -> dict | None:
    """When the card's reasons were researched (card.snapshot; older cards: parsed from card.partial)."""
    s = c.get("snapshot")
    if isinstance(s, dict) and "partial" in s:
        return s
    p = c.get("partial")
    if isinstance(p, str) and p.strip():
        m = re.search(r"截至美东 (\d{1,2}:\d{2})", p)
        hm = m.group(1).zfill(5) if m else None
        return {"date": c.get("date"), "asOf": c.get("asOf"), "partial": True, "etTime": hm,
                "say": f"盘中查的（截至美东 {hm}）" if hm else "盘中查的"}
    return {"date": c.get("date"), "asOf": c.get("asOf"), "partial": False, "etTime": None, "say": None}


def staleness(c: dict) -> dict | None:
    """{kind:'closed'|'intraday', at, now?, say} when a card researched mid-session no longer matches the data."""
    snap = snapshot(c)
    if not snap or not snap.get("partial"):
        return None
    try:
        root = wfacts.data_root(c.get("map") or "curated")
    except Exception:  # noqa: BLE001
        return None
    d = snap.get("date") or c.get("date")
    p = root.meta.get("partial")
    at = snap.get("etTime")
    when = f"盘中查的（截至美东 {at}）" if at else "盘中查的"
    if isinstance(p, dict) and p.get("date") == d:
        now_hm = str(p.get("fetchedAt") or "")[11:16]
        if not now_hm or not at or now_hm <= at:
            return None                                   # still the same intraday snapshot
        return {"kind": "intraday", "at": at, "now": now_hm, "say": f"{when} · 现在是美东 {now_hm} 的数，数已更新"}
    if root.asOf and d and str(root.asOf) >= str(d):
        return {"kind": "closed", "at": at, "say": f"{when} · 收盘后数字变了"}
    return None


def _refresh_measured(c: dict) -> bool:
    """Rebuild title / facts / partial / regime from today's files (no Claude). True when it worked."""
    if not c.get("target"):
        return False
    try:
        f = wfacts.build(c["target"])
    except Exception:  # noqa: BLE001 — a target that no longer builds keeps its old facts
        return False
    if f.get("key") != c.get("key"):
        return False
    # the title + question stay what was RESEARCHED (the reasons answer them); today's question goes beside them,
    # so the page can say "现在该问的是…" and offer 重新查 when the day itself has become the story
    c.update(facts=f.get("facts"), partial=f.get("partial"), regime=wcard._regime_brief(f.get("regime")),
             day=f.get("day"), focus=wcard._focus_brief(f.get("focus")), factsAt=iso_now(),
             factsPartialAt=f.get("partialAt"))
    if f.get("title") and f.get("title") != c.get("title"):
        c.update(currentTitle=f.get("title"), currentQuestion=f.get("question"))
    else:
        c.pop("currentTitle", None)
        c.pop("currentQuestion", None)
    return True


def _force_model() -> str | None:
    try:
        from common import claude_gate
        return claude_gate.config().get("force_model")
    except Exception:  # noqa: BLE001
        return None


def annotate(c: dict) -> dict:
    """Live flags for the page: stale (researched mid-session, numbers moved → facts rebuilt), old model, old data."""
    if not c.get("snapshot"):
        c["snapshot"] = snapshot(c)
    st = staleness(c)
    if st:
        cur = wfacts.data_root(c.get("map") or "curated").meta.get("partial") or {}
        cur_hm = (str(cur.get("fetchedAt") or "")[11:16] or None) if cur.get("date") == c.get("date") else None
        built = c.get("factsPartialAt", (c.get("snapshot") or {}).get("etTime"))
        if (built or None) != cur_hm:              # the facts on the card are from an older snapshot → rebuild
            _refresh_measured(c)
        if c.get("currentTitle"):
            st = dict(st, ask=c["currentTitle"], say=st["say"] + " · 现在该问的是别的了")
        c["stale"] = st
    fm = _force_model()
    m = str(c.get("model") or "")
    if fm and m and fm not in m:
        nm = "Haiku 4.5" if "haiku" in m else "Sonnet 5" if "sonnet-5" in m and "5-5" not in m else m
        c["recheck"] = {"model": m, "say": f"这张是旧模型（{nm}）查的，按「重新查」用 Sonnet 5.5 再查一遍更准"}
    try:
        now = wfacts.data_root(c.get("map") or "curated").asOf
        if now and c.get("asOf") and str(c["asOf"]) < str(now) and c.get("date") == c.get("asOf") \
                and c.get("kind") not in ("day",):
            c["old"] = {"asOf": c["asOf"], "now": now,
                        "say": f"旧卡：按 {c['asOf']} 的数据查的，现在数据已经到 {now}"}
    except Exception:  # noqa: BLE001
        pass
    return c


def _save_job(job: dict) -> None:
    with locked(_job_path(job["id"])):
        write_json(_job_path(job["id"]), job)


def _load_job(jid: str) -> dict | None:
    if not _check_id(jid):
        return None
    j = read_json(_job_path(jid))
    return j if isinstance(j, dict) else None


def _update_job(jid: str, **kw) -> dict | None:
    p = _job_path(jid)
    with locked(p):
        j = read_json(p)
        if not isinstance(j, dict):
            return None
        j.update(kw)
        write_json(p, j)
        return j


def _alive(pid) -> bool:
    """A killed worker is a zombie until someone waits on it, and os.kill(pid, 0) still succeeds on a zombie —
    common/procs.alive() reaps our own children and reads the process state for the others."""
    return procs.alive(pid)


def _active_jobs() -> list[dict]:
    """Queued/running jobs (a dead worker is marked error on the way)."""
    out = []
    if not JOBS_DIR.exists():
        return out
    cfg = load_config()
    ttl = float(cfg.get("job_ttl_h") or 72) * 3600
    now = time.time()
    for p in JOBS_DIR.glob("*.json"):
        try:
            mt = p.stat().st_mtime
        except OSError:
            continue
        if now - mt > ttl:
            for q in (p, p.with_suffix(".log"), p.with_name(p.name + ".lock")):
                try:
                    q.unlink()
                except OSError:
                    pass
            continue
        j = read_json(p)
        if not isinstance(j, dict) or j.get("state") not in ACTIVE:
            continue
        j = _reap(j)
        if j.get("state") in ACTIVE:
            out.append(j)
    out.sort(key=lambda j: (float(j.get("t0") or 0), str(j.get("createdAt") or "")))
    return out


def _reap(j: dict) -> dict:
    """A job whose worker died (killed, machine slept through a crash) becomes an error instead of spinning."""
    if j.get("state") not in ACTIVE:
        return j
    created = parse_dt(j.get("createdAt"))
    age = (now_local() - created).total_seconds() if created else 0
    pid = j.get("pid")
    if pid and not _alive(pid):
        return _update_job(j["id"], state="error", error="查询进程意外退出了，按「重新查」再试", finishedAt=iso_now()) or j
    if not pid and age > 90:
        return _update_job(j["id"], state="error", error="查询进程没起来，按「重新查」再试", finishedAt=iso_now()) or j
    timeout = float(load_config().get("timeout_s") or 480)
    if age > 2.5 * timeout + 300:
        return _update_job(j["id"], state="error", error="查得太久了，已放弃", finishedAt=iso_now()) or j
    return j


def _ahead(jid: str | None, t0: float | None, act: list[dict] | None = None) -> int:
    """How many other searches started before this one are still running (informational: nothing waits —
    there is no concurrency limit). Stable order (t0, then id), so a burst never gives two jobs the same number
    and the number never exceeds the jobs actually running."""
    me = (float(t0 or time.time()), str(jid or "~"))
    act = _active_jobs() if act is None else act
    return sum(1 for j in act if j["id"] != jid and (float(j.get("t0") or 0), str(j["id"])) < me)


def _concurrent(jid: str | None, act: list[dict] | None = None) -> int:
    act = _active_jobs() if act is None else act
    return sum(1 for j in act if j["id"] != jid)


def _waiting_say(state: str, others: int) -> str:
    return "老风派人去查了…" + (f"（同时在查的还有 {others} 个，不用排队）" if others else "")


def _index_add(c: dict) -> None:
    with locked(INDEX):
        idx = read_json(INDEX) or {}
        cards = idx.get("cards") if isinstance(idx.get("cards"), dict) else {}
        cards[c["key"]] = {"at": c.get("at"), "say": c.get("say"), "title": c.get("title"), "kind": c.get("kind"),
                           "ids": c.get("ids"), "date": c.get("date"), "map": c.get("map"),
                           "n": len(c.get("reasons") or []), "timeline": c.get("timeline"), "usd": c.get("usd")}
        if len(cards) > 3000:
            for k in sorted(cards, key=lambda k: str(cards[k].get("at") or ""))[:len(cards) - 3000]:
                cards.pop(k, None)
        write_json(INDEX, {"updatedAt": iso_now(), "count": len(cards), "cards": cards})


# ── public API ────────────────────────────────────────────────────────────────────────────────────
def _target_of(body) -> tuple[object, bool]:
    """The server's JSON body → (target, force). Accepts {target:{…}, force} or the target itself."""
    if isinstance(body, dict):
        force = bool(body.get("force"))
        t = body.get("target")
        if t is None and (body.get("kind") or body.get("ids") or body.get("id")):
            t = {k: v for k, v in body.items() if k != "force"}
        if isinstance(t, str) and t.strip().startswith("{"):
            try:
                t = json.loads(t)
            except ValueError:
                pass
        return t, force
    return body, False


def _public_facts(f: dict) -> dict:
    return {"title": f.get("title"), "facts": f.get("facts"), "question": f.get("question"), "date": f.get("date"),
            "asOf": f.get("asOf"), "partial": f.get("partial"), "kind": f.get("kind"), "ids": f.get("ids")}


def start(target, force: bool = False, *, spawn: bool = True, wait: bool = False) -> dict:
    try:
        f = wfacts.build(target)
    except wfacts.FactsError as e:
        return {"state": "error", "error": str(e)}
    key = f["key"]
    # cache check → "already being searched?" → save the new job: one atomic step across threads and processes,
    # so ten clicks within the same 60 ms start ONE paid search, not ten
    with locked(JOBS_DIR / ".start"):
        previous = None
        if not force:
            c = read_card(key)
            # a click (POST) on a card researched mid-session whose day has since become a different question
            # (e.g. it was "why the inflow since 10-09", now the day itself is +12% with the whole group) searches
            # again; a card whose numbers merely moved is served as it is (stale, free) until 重新查
            if c and not (c.get("stale") and c.get("currentTitle")):
                return {"id": None, "state": "stale" if c.get("stale") else "cached", "key": key, "card": c}
            previous = c
        act = _active_jobs()
        for j in act:
            if j.get("key") == key:
                return {"id": j["id"], "state": j["state"], "key": key, "duplicate": True,
                        "ahead": _ahead(j["id"], j.get("t0"), act), "concurrent": _concurrent(j["id"], act),
                        **_public_facts(j.get("f") or f)}
        ok, why = wgate.can_spend(False)
        if not ok:
            return {"id": None, "state": "refused", "key": key, "error": why or "今天的额度用完了",
                    "budget": _budget_safe(), **_public_facts(f)}
        jid = f"w{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        job = {"id": jid, "key": key, "state": "queued", "createdAt": iso_now(), "t0": time.time(), "force": bool(force),
               "target": f.get("target"), "f": f, "pid": None}
        _save_job(job)
        ahead = _ahead(jid, job["t0"], act)
        others = _concurrent(jid, act)
    if wait:
        run(jid)
        return status(jid)
    if spawn:
        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        with open(JOBS_DIR / f"{jid}.log", "a") as fh:
            try:
                p = procs.spawn([sys.executable, "-m", "why.job", "--run", jid], cwd=str(ROOT), stdout=fh, stderr=fh,
                                env=dict(os.environ, PYTHONUNBUFFERED="1"))
                _update_job(jid, pid=p.pid)
            except OSError as e:
                _update_job(jid, state="error", error=f"查询进程起不来：{e}", finishedAt=iso_now())
                return {"id": jid, "state": "error", "key": key, "error": f"查询进程起不来：{e}"}
    out = {"id": jid, "state": "queued", "key": key, "ahead": ahead, "position": ahead + 1, "concurrent": others,
           "say": _waiting_say("queued", others), **_public_facts(f)}
    if previous:
        out["previous"] = {"title": previous.get("title"), "say": previous.get("say"), "at": previous.get("at"),
                           "stale": previous.get("stale")}
    return out


def status(jid: str) -> dict:
    j = _load_job(jid)
    if not j:
        return {"id": jid, "state": "unknown", "error": "没有这个查询（可能已过期）"}
    j = _reap(j)
    out = {"id": jid, "key": j.get("key"), "state": j.get("state"), "createdAt": j.get("createdAt"),
           "startedAt": j.get("startedAt"), "finishedAt": j.get("finishedAt"), **_public_facts(j.get("f") or {})}
    created = parse_dt(j.get("createdAt"))
    end = parse_dt(j.get("finishedAt")) or now_local()
    if created:
        out["elapsed"] = int((end - created).total_seconds())
    if j.get("state") in ACTIVE:
        act = _active_jobs()
        out["ahead"] = _ahead(jid, j.get("t0"), act)
        out["position"] = out["ahead"] + 1
        out["concurrent"] = _concurrent(jid, act)
        out["say"] = _waiting_say(j.get("state"), out["concurrent"])
    if j.get("state") == "done":
        out["card"] = read_card(j.get("key")) or j.get("card")
    if j.get("error"):
        out["error"] = j["error"]
    if j.get("issues"):
        out["issues"] = j["issues"]
    return out


def peek(key: str | None = None, target=None) -> dict:
    if not key and target is not None:
        try:
            key, _ = wfacts.key_for(target)
        except wfacts.FactsError as e:
            return {"state": "error", "error": str(e)}
    if not key or not wfacts.KEY_RE.match(key):
        return {"state": "error", "error": "key 不对"}
    c = read_card(key)
    if c:
        return {"state": "stale" if c.get("stale") else "cached", "key": key, "card": c, "age": c.get("age")}
    for j in _active_jobs():
        if j.get("key") == key:
            return {"state": j["state"], "id": j["id"], "key": key}
    return {"state": "none", "key": key}


def recent(limit: int = 30) -> list[dict]:
    idx = read_json(INDEX) or {}
    cards = idx.get("cards") if isinstance(idx.get("cards"), dict) else {}
    rows = sorted(({"key": k, **v} for k, v in cards.items()), key=lambda r: str(r.get("at") or ""), reverse=True)
    for r in rows[:limit]:
        r["age"] = age_text(r.get("at"))
    return rows[:limit]


def overview() -> dict:
    act = _active_jobs()
    return {"recent": recent(20), "active": [{"id": j["id"], "key": j.get("key"), "state": j.get("state"),
                                             "title": (j.get("f") or {}).get("title"), "createdAt": j.get("createdAt")}
                                            for j in act],
            "budget": _budget_safe(), **wgate.which()}


def _budget_safe() -> dict:
    try:
        return wgate.budget_status()
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"[:200]}


# ── the worker ────────────────────────────────────────────────────────────────────────────────────
def _ask(f: dict, cfg: dict, extra: str = "") -> dict:
    """One gateway call. The real gateway retries once itself when validate() finds a fatal problem; the shim
    does not, so run() retries for it. No CLI --json-schema by default (long Chinese text + a stray quote makes
    the structured-output tool call collapse); the answer is parsed + validated here instead."""
    def _validate(obj: dict) -> list[str]:
        _, iss, fatal = wcard.validate(obj, f, int(cfg.get("max_reasons") or 5))
        return iss if fatal else []
    kw = dict(system=wprompt.system_prompt(), tools=list(cfg.get("tools") or ["WebSearch", "WebFetch"]),
              model=cfg.get("model"), effort=cfg.get("effort"), auto=False, timeout=int(cfg.get("timeout_s") or 480),
              validate=_validate, parse=wcard.parse_json, retries=1 if cfg.get("retry_on_bad_card", True) else 0,
              module="why", note=f.get("key", "")[:100])
    if cfg.get("cli_schema"):
        kw["schema"] = wprompt.SCHEMA
    return wgate.call(f"why:{f.get('kind')}", wprompt.user_prompt(f) + extra, **kw)


def _main_model(g: dict, cfg: dict) -> str | None:
    """The model that did the reasoning (the one asked for), not the helper that summarised fetched pages
    (WebFetch runs a small model, which can cost more than the main one on a page-heavy search)."""
    mu = ((g.get("envelope") or {}).get("modelUsage") or {}) if isinstance(g.get("envelope"), dict) else {}
    want = str(cfg.get("model") or "").lower()
    if isinstance(mu, dict) and mu:
        hit = [m for m in mu if want and want in m.lower()]
        if hit:
            return hit[0]
        return max(mu, key=lambda m: (mu.get(m) or {}).get("outputTokens", 0) if isinstance(mu.get(m), dict) else 0)
    return g.get("model")


def _shorten(text: str, cfg: dict) -> str | None:
    """Over-long sharp line → ≤ 30 字 by a small model, no tools (≈ 0.01 points). None when it fails."""
    _shorten.last_usd = 0.0
    prompt = ("把下面这句市场点评压缩成一句 ≤ 30 个汉字的简体中文，保留立场和最狠的那个点，别加新事实，"
              "改掉繁体字和错别字。只输出这一句，不要引号、不要解释。\n" + text)
    g = wgate.call("why:say", prompt, system="你是中文编辑，只输出改好的一句话。", tools=[],
                   model=cfg.get("say_model") or "haiku", effort="low", auto=False, timeout=90, json_out=False,
                   module="why", note="压缩老风一句话")
    _shorten.last_usd = float(g.get("usd") or 0.0)
    out = wcard.zh_punct((g.get("text") or "").strip().strip("「」\"'“”").splitlines()[0] if g.get("ok") and g.get("text") else "")
    return out if out and has_han(out) and len(out) <= 40 else None


_shorten.last_usd = 0.0


def run(jid: str) -> dict:
    j = _load_job(jid)
    if not j:
        return {"error": "没有这个查询"}
    if j.get("state") not in ACTIVE:
        return j
    j = _update_job(jid, state="running", pid=os.getpid(), startedAt=iso_now()) or j
    f = j.get("f") or {}
    cfg = load_config()
    total = {"usd": 0.0, "inTok": 0, "outTok": 0, "ms": 0, "model": None}
    issues: list[str] = []
    clean, fatal = {}, True
    attempts = 0
    try:
        extra = ""
        own_retry = cfg.get("retry_on_bad_card", True) and not wgate.supports("validate")
        seen: list[str] = []
        while attempts < (2 if own_retry else 1):
            attempts += 1
            g = _ask(f, cfg, extra)
            for k in ("usd", "inTok", "outTok", "ms"):
                total[k] += g.get(k) or 0
            total["model"] = _main_model(g, cfg) or total["model"]
            seen += list(g.get("seenUrls") or [])
            total["toolCalls"] = g.get("toolCalls") or total.get("toolCalls")
            if g.get("refused"):
                return _update_job(jid, state="refused", error=g.get("error") or "今天的额度用完了",
                                   finishedAt=iso_now(), usd=total["usd"]) or {}
            raw = g.get("json") if isinstance(g.get("json"), dict) else wcard.parse_json(g.get("text") or "")
            if not g.get("ok") and raw is None:
                issues = [g.get("error") or "Claude 没回答"]
                if "超时" in (g.get("error") or "") or "起不来" in (g.get("error") or ""):
                    break
                extra = wprompt.retry_note(issues)
                continue
            # the gateway already retried once on a fatal answer (or, with the shim, this loop does): the last
            # word on "the 老风 line is about another place" is an issue on the card, not a lost search
            strict = own_retry and attempts < 2
            clean, iss, fatal = wcard.validate(raw, f, int(cfg.get("max_reasons") or 5), strict_subject=strict)
            issues = iss
            if not fatal:
                break
            extra = wprompt.retry_note(iss)
        if fatal:
            return _update_job(jid, state="error", error="没查出能用的结果：" + "；".join(issues[:3]), issues=issues,
                               finishedAt=iso_now(), usd=total["usd"], attempts=attempts) or {}
        if clean.get("sayFull"):                           # §12: one short sharp line — ask a tiny model to tighten it
            short = _shorten(clean["sayFull"], cfg)
            if short:
                clean["say"] = short
                total["usd"] += _shorten.last_usd
                issues = [i for i in issues if not i.startswith("老风这句太长")]
        links = (clean.get("reasons") or []) + (clean.get("counter") or [])
        if seen:
            unseen = wcard.mark_seen(links, seen)
            if unseen:
                issues.append(f"{unseen} 个链接不在这次搜索看到的结果里（已降低可信度）")
        if cfg.get("check_urls", True):
            dead = wcard.check_urls(links)
            if dead:
                issues.append(f"{dead} 个链接打不开（已降低可信度）")
        c = wcard.make_card(clean, f, total, issues)
        c["attempts"] = attempts
        c["gate"] = wgate.which()["gate"]
        write_json(_card_path(c["key"]), c)
        _index_add(c)
        wmemo.record(c)
        return _update_job(jid, state="done", finishedAt=iso_now(), usd=total["usd"], issues=issues,
                           attempts=attempts) or {}
    except Exception as e:  # noqa: BLE001 — the job must end in a state the page can show
        return _update_job(jid, state="error", error=f"出错了：{type(e).__name__}: {e}"[:300], finishedAt=iso_now(),
                           usd=total["usd"]) or {}


def _check_card(c: dict) -> list[str]:
    """Today's card rules on an old card (no Claude): name mistranslations (推特 → Twist), watch dates that were
    already past when the card was made, a model other than budget.json force_model (→ recheck flag)."""
    notes = []
    f = {"ids": c.get("ids"), "title": c.get("title"), "question": c.get("question"), "map": c.get("map"),
         "context": [json.dumps(c.get("facts") or {}, ensure_ascii=False)], "searchTerms": [], "kind": c.get("kind")}
    n = wcard.fix_names(c, f)
    if n:
        notes.append(f"改了 {n} 处公司名的错译")
    made = str(c.get("at") or "")[:10]
    if made:
        keep = [w for w in c.get("watch") or [] if not (isinstance(w, dict) and re.match(r"^\d{4}-\d{2}", str(w.get("by") or ""))
                                                        and str(w["by"]) < (made if len(str(w["by"])) == 10 else made[:7]))]
        if len(keep) != len(c.get("watch") or []):
            notes.append(f"丢掉了 {len(c.get('watch') or []) - len(keep)} 条做卡时就已经过去的「接下来要盯」")
            c["watch"] = keep
    if c.get("target"):
        try:
            wfacts.build(c["target"])
        except wfacts.FactsError as e:
            if "窗口" in str(e):                    # asked about the first days of the window: no history, junk facts
                c["_drop"] = str(e)
        except Exception:  # noqa: BLE001
            pass
    if notes:
        c["issues"] = list(dict.fromkeys((c.get("issues") or []) + notes))[:10]
        c["checkedAt"] = iso_now()
    return notes


TRASH = JOBS_DIR.parent / "trash"


def _trash_card(p, c: dict, why: str) -> None:
    """Move a cached card out of web/data/why (kept in why/out/trash/, not deleted) and off the index."""
    TRASH.mkdir(parents=True, exist_ok=True)
    c = dict(c, trashedAt=iso_now(), trashedWhy=why)
    c.pop("_drop", None)
    write_json(TRASH / p.name, c)
    try:
        p.unlink()
    except OSError:
        pass
    with locked(INDEX):
        idx = read_json(INDEX) or {}
        cards = idx.get("cards") if isinstance(idx.get("cards"), dict) else {}
        if cards.pop(c.get("key"), None) is not None:
            write_json(INDEX, {"updatedAt": iso_now(), "count": len(cards), "cards": cards})


def tidy_cards(shorten: bool = False, refresh_facts: bool = False, partial_only: bool = False,
               check: bool = False) -> int:
    """Pass over cached cards (no Claude): full-width punctuation after Chinese, the sharp line cut to §12 length
    (full text kept in sayFull). refresh_facts: rebuild the measured side (title/facts/partial/regime) from today's
    files; partial_only: only cards researched on a still-forming intraday bar whose numbers have since moved
    (update.sh runs this after every update, so a card made at 14:15 ET shows the closing numbers after the
    close — its reasons stay, and card.snapshot still says it was researched mid-session). check: today's card
    rules on old cards (_check_card). Returns how many cards changed."""
    n = 0
    for p in WHY_DIR.glob("*.json"):
        if p.name == "index.json":
            continue
        c = read_json(p)
        if not isinstance(c, dict) or not c.get("say"):
            continue
        snap = snapshot(c)
        if partial_only and not (snap and snap.get("partial") and staleness(c)):
            continue
        before = json.dumps(c, ensure_ascii=False, sort_keys=True)
        if not c.get("snapshot"):
            c["snapshot"] = snap
        if refresh_facts or partial_only:                  # measured side only (title/facts/regime); no Claude
            if _refresh_measured(c):
                c["factsRefreshedAt"] = c.get("factsAt")
        if check:
            _check_card(c)
            if c.get("_drop"):
                _trash_card(p, c, c["_drop"])
                n += 1
                continue
        full = wcard.zh_punct(c.get("sayFull") or c["say"])
        short = wcard.short_say(full)
        if short != full and shorten:
            short = _shorten(full, load_config()) or short
        c["say"] = short
        c["sayFull"] = full if full != c["say"] else None
        c["issues"] = [i for i in (c.get("issues") or []) if not (shorten and i.startswith("老风这句太长"))]
        if c.get("sayMild"):
            c["sayMild"] = wcard.zh_punct(c["sayMild"])
        if c.get("honest"):
            c["honest"] = wcard.zh_punct(c["honest"])
        for k in ("reasons", "counter"):
            for it in c.get(k) or []:
                if isinstance(it, dict) and it.get("text"):
                    it["text"] = wcard.zh_punct(it["text"])
        for it in c.get("watch") or []:
            if isinstance(it, dict) and it.get("what"):
                it["what"] = wcard.zh_punct(it["what"])
        if json.dumps(c, ensure_ascii=False, sort_keys=True) != before:
            write_json(p, c)
            _index_add(c)
            n += 1
    return n


# ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--run"] and len(argv) >= 2:
        out = run(argv[1])
        print(f"[why {datetime.now():%H:%M:%S}] {argv[1]}: {out.get('state')} {out.get('error') or ''}", flush=True)
        return 0 if out.get("state") == "done" else 1
    import argparse
    ap = argparse.ArgumentParser(prog="python3 -m why.job", description="为什么 jobs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ask")
    a.add_argument("target")
    a.add_argument("--force", action="store_true")
    a.add_argument("--wait", action="store_true", help="run here and print the card")
    a.add_argument("--dry-run", action="store_true", help="print the prompt only (no Claude call)")
    sub.add_parser("status").add_argument("id")
    sub.add_parser("peek").add_argument("key")
    sub.add_parser("list")
    td = sub.add_parser("tidy")
    td.add_argument("--shorten", action="store_true", help="tighten over-long lines with a small model (≈0.01 pt each)")
    td.add_argument("--facts", action="store_true", help="rebuild the measured title/facts from today's data files")
    td.add_argument("--partial", action="store_true", help="only cards researched mid-session whose numbers moved since")
    td.add_argument("--check", action="store_true", help="today's card rules on old cards (names, past watch dates)")
    sub.add_parser("facts").add_argument("target")
    ns = ap.parse_args(argv)
    if ns.cmd in ("ask", "facts"):
        tgt = json.loads(ns.target) if ns.target.strip().startswith("{") else ns.target
        if ns.cmd == "facts" or ns.dry_run:
            f = wfacts.build(tgt)
            if ns.cmd == "ask":
                print(wprompt.system_prompt(), "\n\n", wprompt.user_prompt(f))
            else:
                print(json.dumps({k: f[k] for k in ("key", "title", "facts", "question", "searchDates", "searchTerms", "context")},
                                 ensure_ascii=False, indent=1))
            return 0
        out = start(tgt, force=ns.force, spawn=not ns.wait, wait=ns.wait)
    elif ns.cmd == "status":
        out = status(ns.id)
    elif ns.cmd == "peek":
        out = peek(ns.key)
    elif ns.cmd == "tidy":
        out = {"changed": tidy_cards(shorten=ns.shorten, refresh_facts=ns.facts, partial_only=ns.partial,
                                     check=ns.check)}
        if ns.check:
            out["memo"] = len((wmemo.rebuild().get("tickers") or {}))
    else:
        out = recent(50)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
