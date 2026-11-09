"""scout/job.py — on-demand scout jobs for the server and the loop (DESIGN §15, §16).

Server wiring (integrator) — one call, like intel/job.py:
    from scout import job as scout_job
    r = scout_job.route(self.command, u.path, u.query, body)      # body: bytes or None
    if r is not None: return self.send_json(r[1], r[0])
  which answers
    POST /api/scout  {kind, target?, question?, force?}  → start(kind, target, question, force=force)
                     → {"id", "state":"queued", "ahead", "position"} | {"id", "state":"cached", …answer} | {"error"}
    GET  /api/scout?id=<id>                             → status(id)
    GET  /api/scout                                     → usage()  (no id: today's counters + queue)
    GET  /api/scout/log[?limit=50]                      → log(limit)  — same list as web/data/scout_log.json
    GET  /api/scout/usage                               → usage()   (for 💓 heartbeat / 🔎 panel)

  kind    explain | gap | verify | ask
  target  node id ("security", "s:MU"), a ticker ("MU"), {"type":"edge","a":"MSFT","b":"NVDA","what":"GPU"},
          {"type":"tickers","tickers":[…]}, {"type":"error","step":"fetch","log":"…"} or null (ask: guessed
          from the question)
start() puts the task at the front of the queue (source "owner", own daily cap) and spawns a detached
`python3 -m scout.job --run <id>` that runs it at once (no concurrency limit: scout/config.json concurrency 999). The same
question on the same target answered OK in the last 3 days is returned from the log ("cached") unless
force=True — no quota spent.

The loop's health check sends broken steps here: start("verify", {"type":"error","step":…,"log":…},
question, source="loop") — counted under the automatic caps.

CLI: python3 scout/job.py start --kind ask --target security --question "…" [--wait] [--force]
     python3 scout/job.py status <id> | log [N] | --run <id>
"""
from __future__ import annotations

import os
import sys

if __name__ == "__main__" and __package__ in (None, ""):
    _here = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or ".") == _here:
        sys.path[0] = os.path.dirname(_here)          # scout/queue.py must not shadow stdlib queue

import json  # noqa: E402
import subprocess  # noqa: E402

from scout import log as slog  # noqa: E402
from scout import queue as squeue  # noqa: E402
from scout.common import JOBS, KINDS, ROOT, age_hours, load_config, owner_time, say  # noqa: E402

PRIORITY = {"owner": 10.0, "loop": 5.0, "auto": 1.0}


def _key(kind: str, target, question: str | None) -> str:
    t = json.dumps(target, ensure_ascii=False, sort_keys=True) if isinstance(target, dict) else str(target or "")
    q = "".join((question or "").split()).rstrip("？?。.")
    return f"{kind}:{t}:{q}"


def _queue_pos(task_id: str) -> dict:
    """Where a queued task stands, in the order queue.claim() takes them (owner first, then priority, then age):
    {"ahead": N in front, "position": N+1}; {} when it is not queued (running/done)."""
    try:
        qd = squeue.list_tasks(("queued",))
    except Exception:  # noqa: BLE001 — a half-written state file must not break the status call
        return {}
    qd.sort(key=lambda t: (-(1 if t.get("source") == "owner" else 0), -(t.get("priority") or 0), t.get("createdAt") or ""))
    i = next((n for n, t in enumerate(qd) if t.get("id") == task_id), None)
    return {} if i is None else {"ahead": i, "position": i + 1}


def _public(t: dict) -> dict:
    r = t.get("result") or {}
    cfg = load_config()
    pos = _queue_pos(t["id"]) if t.get("state") == "queued" else {}
    return {"id": t["id"], "kind": t["kind"], "state": t["state"], "question": t.get("question"), **pos,
            "target": t.get("target"), "source": t.get("source"), "createdAt": t.get("createdAt"),
            "startedAt": t.get("startedAt"), "finishedAt": t.get("finishedAt"),
            "finishedLocal": owner_time(t.get("finishedAt"), cfg), "error": t.get("error"),
            "waiting": t.get("capNote"), **{k: r.get(k) for k in ("line", "say", "answer", "conf", "sources", "changes", "issues")}}


def _from_log(e: dict, state: str | None = None) -> dict:
    return {"id": e.get("id"), "kind": e.get("kind"), "state": state or e.get("state"), "question": e.get("question"),
            "target": e.get("target"), "finishedAt": e.get("finishedAt"), "line": e.get("line"), "say": e.get("say"),
            "answer": e.get("found"), "conf": e.get("conf"), "sources": e.get("sources"), "changes": e.get("changes"),
            "issues": e.get("issues"), "error": e.get("error")}


def start(kind: str, target=None, question: str | None = None, *, force: bool = False, source: str = "owner",
          spawn: bool = True, wait: bool = False, key: str | None = None) -> dict:
    """Queue one scout task and run it in a detached worker. `key` (optional) groups repeats for dedupe,
    e.g. the loop passes key="verify:step:fetch" so one broken step is not re-asked within 3 days."""
    if kind not in KINDS:
        return {"error": f"kind 必须是 {', '.join(KINDS)} 之一"}
    if kind == "ask" and not (question or "").strip():
        return {"error": "ask 需要一个问题"}
    if kind == "gap" and not (isinstance(target, dict) and target.get("a") and target.get("b")) and not question:
        return {"error": "gap 需要 target {a, b, what} 或一个问题"}
    cfg = load_config()
    key = key or _key(kind, target, question)
    if not force:
        days = float(cfg.get("dedupe_days", 3))
        for e in slog.read():
            if e.get("ok") and e.get("key") == key and age_hours(e.get("finishedAt")) <= days * 24:
                return {**_from_log(e, "cached"), "cached": True}
    task, status = squeue.enqueue(kind, target, question, priority=PRIORITY.get(source, 10.0),
                                  source="owner" if source == "owner" else "auto", key=key)
    if status == "duplicate":
        return {**_public(task), "duplicate": True}
    if wait:
        squeue.run_one(task["id"], wait_s=float(cfg.get("owner_wait_max_s", 1500)))
        return status_of(task["id"])
    if spawn:
        JOBS.mkdir(parents=True, exist_ok=True)
        with open(JOBS / f"{task['id']}.log", "a") as fh:
            env = dict(os.environ, MW_SCOUT_LOG=str(slog.LOG_PATH))   # a runtime LOG_PATH override reaches the worker
            from common import procs                                   # kept + reaped: a killed worker is no zombie
            procs.spawn([sys.executable, "-m", "scout.job", "--run", task["id"]], cwd=str(ROOT), env=env,
                        stdout=fh, stderr=fh)
    return {"id": task["id"], "state": "queued", "kind": kind, "question": question, **_queue_pos(task["id"])}


def status_of(job_id: str) -> dict:
    t = squeue.get(job_id)
    if t:
        return _public(t)
    for e in slog.read():
        if e.get("id") == job_id:
            return _from_log(e)
    return {"id": job_id, "state": "unknown", "error": "没有这个任务"}


status = status_of          # server-facing name


def log(limit: int = 50) -> list[dict]:
    cfg = load_config()
    return [{**e, "finishedLocal": owner_time(e.get("finishedAt"), cfg)} for e in slog.read(limit)]


def usage() -> dict:
    return squeue.usage_today()


MAX_BODY = 1 << 16


def route(method: str, path: str, query=None, body: bytes | None = None) -> tuple[int, object] | None:
    """Handle every /api/scout… request → (http_code, json), or None when the path is not ours."""
    if not (path == "/api/scout" or path.startswith("/api/scout/")):
        return None
    from urllib.parse import parse_qs
    q = parse_qs(query) if isinstance(query, str) else (query or {})

    def qv(k: str) -> str:
        v = q.get(k)
        return (v[0] if v else "") if isinstance(v, list) else (v or "")

    m = method.upper()
    try:
        if m in ("GET", "HEAD"):
            if path == "/api/scout/log":
                lim = qv("limit")
                return 200, log(int(lim) if lim.isdigit() else 50)
            if path == "/api/scout/usage":
                return 200, usage()
            if path == "/api/scout":
                return (200, status_of(qv("id"))) if qv("id") else (200, usage())
        if m == "POST" and path == "/api/scout":
            raw = (body or b"")[:MAX_BODY].decode("utf-8", "replace").strip()
            try:
                a = json.loads(raw) if raw.startswith("{") else {"kind": "ask", "question": raw}
            except ValueError:
                return 400, {"error": "请求不是合法 JSON"}
            if not isinstance(a, dict):
                return 400, {"error": "请求格式不对"}
            kind = str(a.get("kind") or "ask")
            target = a.get("target")
            if isinstance(target, str) and target.strip().startswith("{"):
                try:
                    target = json.loads(target)
                except ValueError:
                    pass
            force = bool(a.get("force")) or qv("force") in ("1", "true")
            res = start(kind, target, (a.get("question") or None), force=force)
            return (400 if res.get("error") and not res.get("id") else 200), res
    except Exception as e:                                       # noqa: BLE001 — the page must get JSON back
        return 500, {"error": f"侦察兵出错：{e.__class__.__name__}: {str(e)[:160]}"}
    return 405, {"error": "不支持这个请求"}


def _worker(job_id: str) -> int:
    cfg = load_config()
    out = squeue.run_one(job_id, wait_s=float(cfg.get("owner_wait_max_s", 1500)), cfg=cfg)
    say(f"job {job_id}: {out.get('state')} {out.get('line') or out.get('error') or ''}")
    return 0 if out.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    import argparse
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--run"] and len(argv) >= 2:
        return _worker(argv[1])
    ap = argparse.ArgumentParser(description="scout jobs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("--kind", required=True, choices=list(KINDS))
    s.add_argument("--target")
    s.add_argument("--question")
    s.add_argument("--force", action="store_true")
    s.add_argument("--wait", action="store_true", help="run in this process and print the result")
    st = sub.add_parser("status")
    st.add_argument("id")
    lg = sub.add_parser("log")
    lg.add_argument("n", nargs="?", type=int, default=10)
    a = ap.parse_args(argv)
    if a.cmd == "start":
        tgt = a.target
        if tgt and tgt.strip().startswith("{"):
            tgt = json.loads(tgt)
        out = start(a.kind, tgt, a.question, force=a.force, spawn=not a.wait, wait=a.wait)
    elif a.cmd == "status":
        out = status_of(a.id)
    else:
        out = [{k: e.get(k) for k in ("id", "kind", "ok", "finishedLocal", "line", "conf")} for e in log(a.n)]
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
