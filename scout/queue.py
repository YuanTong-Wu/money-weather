"""scout/queue.py — the scout's persistent task queue, caps and concurrency (DESIGN §15, §16 budget guard).

State: scout/out/queue.json = {"tasks":[task…], "usage":{"YYYY-MM-DD": {"_all":n, "_auto":n, "_owner":n, "<kind>":n}}}
(days in America/New_York). Every read-modify-write holds an flock, so the server, the loop and a CLI can
share it. A task:
  {"id","kind","target","question","priority","source":"auto|owner|loop","key","keys","why","context",
   "createdAt","state":"queued|running|done|failed|invalid|expired","startedAt","finishedAt","pid",
   "attempts","result":{line, say, conf, answer, sources, changes, issues, ms, costUsd},"error"}

Limits: first the day's Claude points (loop/usage.py, DESIGN §21: everything ≤ 6 weekly-quota points, automatic
tasks ≤ 4, the rest kept for the owner's clicks); then the count brakes in scout/config.json — concurrency
(running at once, across processes), daily_cap + kind_caps for automatic tasks, owner_daily_cap for on-demand
ones, hard_daily_cap for everything (999 = off, the default since the §21 amendment). A Claude call counts when
it starts, success or not. Over a limit → the task stays queued (auto ones expire after auto_expire_h) with the
plain reason in capNote, and the drain says so in the log.

CLI
  python3 scout/queue.py auto [--max N] [--no-run]   detect → enqueue → run (what update.sh / the loop call)
  python3 scout/queue.py detect                      detect → enqueue only
  python3 scout/queue.py add --kind ask --target security --question "…" [--owner]
  python3 scout/queue.py drain [--max N] [--kind K]  run queued tasks within caps
  python3 scout/queue.py list | usage | show <id>
"""
from __future__ import annotations

import os
import sys

if __name__ == "__main__" and __package__ in (None, ""):
    _here = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or ".") == _here:
        sys.path[0] = os.path.dirname(_here)          # this file must not shadow stdlib queue

import contextlib  # noqa: E402
import json  # noqa: E402
import random  # noqa: E402
import socket  # noqa: E402
import string  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from datetime import datetime  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Iterator  # noqa: E402

from scout.common import KINDS, OUT, ROOT, age_hours, day_key, iso, load_config, locked, read_json, say, write_json  # noqa: E402

QUEUE_PATH = OUT / "queue.json"
KEEP_FINISHED = 300
ACTIVE = ("queued", "running")
HOST = socket.gethostname()


@contextlib.contextmanager
def _state() -> Iterator[dict]:
    with locked(QUEUE_PATH):
        st = read_json(QUEUE_PATH, None)
        if not isinstance(st, dict):
            st = {}
        st.setdefault("tasks", [])
        st.setdefault("usage", {})
        yield st
        fin = [t for t in st["tasks"] if t.get("state") not in ACTIVE]
        if len(fin) > KEEP_FINISHED:
            drop = {t["id"] for t in sorted(fin, key=lambda t: t.get("finishedAt") or "")[: len(fin) - KEEP_FINISHED]}
            st["tasks"] = [t for t in st["tasks"] if t["id"] not in drop]
        days = sorted(st["usage"])
        for d in days[:-14]:
            st["usage"].pop(d, None)
        write_json(QUEUE_PATH, st)


def _read() -> dict:
    st = read_json(QUEUE_PATH, None)
    return st if isinstance(st, dict) else {"tasks": [], "usage": {}}


def new_id(kind: str) -> str:
    return f"{kind[:2]}-{datetime.now():%m%d-%H%M%S}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"


def active_keys() -> set[str]:
    ks: set[str] = set()
    for t in _read().get("tasks", []):
        if t.get("state") in ACTIVE:
            ks.add(t.get("key") or "")
            ks.update(t.get("keys") or [])
    ks.discard("")
    return ks


# ── enqueue ─────────────────────────────────────────────────────────────────────────────────────

def enqueue(kind: str, target=None, question: str | None = None, *, priority: float = 1.0, source: str = "auto",
            key: str | None = None, keys: list[str] | None = None, why: str | None = None,
            context: dict | None = None) -> tuple[dict, str]:
    """Add a task. Returns (task, status) with status 'queued' or 'duplicate' (same key already queued/running)."""
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r}")
    key = key or f"{kind}:{json.dumps(target, ensure_ascii=False, sort_keys=True)}:{(question or '').strip()}"
    with _state() as st:
        for t in st["tasks"]:
            if t.get("state") in ACTIVE and (t.get("key") == key or key in (t.get("keys") or [])):
                if priority > (t.get("priority") or 0):
                    t["priority"] = priority
                return t, "duplicate"
        task = {"id": new_id(kind), "kind": kind, "target": target, "question": question,
                "priority": round(float(priority), 3), "source": source, "key": key, "keys": keys or [],
                "why": why, "context": context or {}, "createdAt": iso(), "state": "queued", "attempts": 0}
        st["tasks"].append(task)
        return task, "queued"


def enqueue_candidates(cands: list[dict], max_new: int | None = None) -> list[dict]:
    added = []
    for c in cands:
        if max_new is not None and len(added) >= max_new:
            break
        t, status = enqueue(c["kind"], c.get("target"), c.get("question"), priority=c.get("priority", 1.0),
                            source=c.get("source", "auto"), key=c.get("key"), keys=c.get("keys"),
                            why=c.get("why"), context=c.get("context"))
        if status == "queued":
            added.append(t)
    return added


# ── caps & claiming ─────────────────────────────────────────────────────────────────────────────

def _alive(t: dict) -> bool:
    """A killed runner is a zombie until reaped, and os.kill(pid, 0) succeeds on zombies — common/procs.alive()
    tells them apart (and reaps the ones this process started)."""
    pid = t.get("pid")
    if not pid or t.get("host") not in (None, HOST):
        return True
    from common import procs
    return procs.alive(pid)


_respawn: list[str] = []          # owner tasks requeued after their runner died → a new runner is started


def _respawn_pending() -> None:
    """Start a fresh `scout.job --run <id>` for each owner task _housekeep just requeued (the loop only drains
    explain/verify/gap, and owner tasks never expire — without this a requeued 🔎 question waited forever)."""
    while _respawn:
        tid = _respawn.pop(0)
        try:
            from common import procs
            from scout.common import JOBS
            JOBS.mkdir(parents=True, exist_ok=True)
            with open(JOBS / f"{tid}.log", "a") as fh:
                procs.spawn([sys.executable, "-m", "scout.job", "--run", tid], cwd=str(ROOT), stdout=fh, stderr=fh,
                            env=dict(os.environ))
            say(f"housekeep: owner task {tid} lost its runner → started a new one")
        except Exception as e:  # noqa: BLE001 — the next drain / housekeep tries again
            say(f"housekeep: could not restart {tid}: {e}")


def _housekeep(st: dict, cfg: dict) -> None:
    limit_h = (float(cfg.get("timeout_s", 480)) * 2 + 120) / 3600
    for t in st["tasks"]:
        if t.get("state") == "running" and (not _alive(t) or age_hours(t.get("startedAt")) > limit_h):
            t["state"] = "queued" if t.get("attempts", 0) < 2 else "failed"
            t["error"] = "runner died or timed out; " + ("requeued" if t["state"] == "queued" else "gave up")
            t.pop("pid", None)
            if t["state"] == "queued" and t.get("source") == "owner" and t["id"] not in _respawn:
                t["respawnedAt"] = iso()
                _respawn.append(t["id"])
            elif t["state"] == "failed":
                t["finishedAt"] = t.get("finishedAt") or iso()
        elif (t.get("state") == "queued" and t.get("source") != "owner"
              and age_hours(t.get("createdAt")) > float(cfg.get("auto_expire_h", 36))):
            t["state"] = "expired"
            t["finishedAt"] = iso()


def _usage(st: dict, cfg: dict) -> dict:
    return st["usage"].setdefault(day_key(cfg), {})


def cap_reason(st: dict, task: dict, cfg: dict) -> str | None:
    u = _usage(st, cfg)
    from scout.run import spend_check                     # §21: 6 points of the weekly quota per day, all callers
    pts = spend_check(auto=task.get("source") != "owner")
    if pts:
        return pts
    if u.get("_all", 0) >= int(cfg.get("hard_daily_cap", 30)):
        return f"今天总共已经叫了 {u.get('_all', 0)} 次 Claude（上限 {cfg.get('hard_daily_cap')}）"
    if task.get("source") == "owner":
        if u.get("_owner", 0) >= int(cfg.get("owner_daily_cap", 20)):
            return f"今天你点的查询已经 {u.get('_owner', 0)} 次（上限 {cfg.get('owner_daily_cap')}）"
        return None
    if u.get("_auto", 0) >= int(cfg.get("daily_cap", 12)):
        return f"今天自动侦察已经 {u.get('_auto', 0)} 次（上限 {cfg.get('daily_cap')}）"
    kc = (cfg.get("kind_caps") or {}).get(task["kind"])
    if kc is not None and u.get(task["kind"], 0) >= int(kc):
        return f"今天 {task['kind']} 已经 {u.get(task['kind'], 0)} 次（上限 {kc}）"
    return None


def claim(only_id: str | None = None, kinds: list[str] | None = None, cfg: dict | None = None) -> tuple[dict | None, str]:
    """Take the best runnable task (or `only_id`) → (task, 'ok') or (None, reason)."""
    cfg = cfg or load_config()
    try:
        return _claim(only_id, kinds, cfg)
    finally:
        _respawn_pending()


def _claim(only_id: str | None, kinds: list[str] | None, cfg: dict) -> tuple[dict | None, str]:
    with _state() as st:
        _housekeep(st, cfg)
        running = [t for t in st["tasks"] if t.get("state") == "running"]
        if only_id:
            t = next((x for x in st["tasks"] if x["id"] == only_id), None)
            if not t:
                return None, "no such task"
            if t["state"] != "queued":
                return None, f"state:{t['state']}"
            pool = [t]
        else:
            pool = [t for t in st["tasks"] if t.get("state") == "queued" and (not kinds or t["kind"] in kinds)]
            pool.sort(key=lambda t: (-(1 if t.get("source") == "owner" else 0), -(t.get("priority") or 0), t.get("createdAt") or ""))
        if not pool:
            return None, "empty"
        if len(running) >= int(cfg.get("concurrency", 2)):
            return None, "busy"
        reasons = []
        for t in pool:
            r = cap_reason(st, t, cfg)
            if r:
                reasons.append(r)
                t["capNote"] = r
                continue
            u = _usage(st, cfg)
            u["_all"] = u.get("_all", 0) + 1
            src = "_owner" if t.get("source") == "owner" else "_auto"
            u[src] = u.get(src, 0) + 1
            u[t["kind"]] = u.get(t["kind"], 0) + 1
            t.update(state="running", startedAt=iso(), pid=os.getpid(), host=HOST, attempts=t.get("attempts", 0) + 1)
            t.pop("capNote", None)
            return dict(t), "ok"
        return None, "cap: " + (reasons[0] if reasons else "?")


def finish(task_id: str, outcome: dict) -> None:
    with _state() as st:
        t = next((x for x in st["tasks"] if x["id"] == task_id), None)
        if not t:
            return
        t["state"] = outcome.get("state") or ("done" if outcome.get("ok") else "failed")
        t["finishedAt"] = iso()
        t["error"] = outcome.get("error")
        t["result"] = {k: outcome.get(k) for k in ("line", "say", "conf", "answer", "sources", "changes", "issues", "ms", "costUsd")}
        t.pop("pid", None)


def get(task_id: str) -> dict | None:
    return next((t for t in _read().get("tasks", []) if t.get("id") == task_id), None)


def list_tasks(states: tuple[str, ...] | None = None) -> list[dict]:
    ts = _read().get("tasks", [])
    return [t for t in ts if not states or t.get("state") in states]


def usage_today(cfg: dict | None = None) -> dict:
    """For heartbeat.json: {"day", "used":{…}, "caps":{…}, "claudeCallsToday"}."""
    cfg = cfg or load_config()
    st = _read()
    d = day_key(cfg)
    u = dict((st.get("usage") or {}).get(d) or {})
    caps = {"daily_cap": cfg.get("daily_cap"), "kind_caps": cfg.get("kind_caps"),
            "owner_daily_cap": cfg.get("owner_daily_cap"), "hard_daily_cap": cfg.get("hard_daily_cap"),
            "concurrency": cfg.get("concurrency")}
    return {"day": d, "used": u, "caps": caps, "claudeCallsToday": u.get("_all", 0),
            "queued": len([t for t in st.get("tasks", []) if t.get("state") == "queued"]),
            "running": len([t for t in st.get("tasks", []) if t.get("state") == "running"])}


# ── running ─────────────────────────────────────────────────────────────────────────────────────

def _execute(task: dict, cfg: dict) -> dict:
    from scout import run as srun
    try:
        out = srun.run_task(task, cfg)
    except Exception as e:                                      # noqa: BLE001 — never leave a task "running"
        out = {"ok": False, "state": "failed", "error": f"{e.__class__.__name__}: {e}"}
    if task.get("kind") == "gap" and out.get("ok"):
        g = _apply_graph_patch(task["id"], srun)
        if g:
            out = {**out, "graph": g}
    finish(task["id"], out)
    return out


def _apply_graph_patch(task_id: str, srun) -> dict | None:
    """A finished 'gap' job goes into the company web at once (phase-3 must-fix 2b): graph/apply_patch.py --task
    rebuilds web/data/graph with this patch in ~1 s, so the graph view (which watches the company file for a tie
    stamped with this task id) redraws with it. Only for the real scout output (tests redirect it → skipped)."""
    real = (ROOT / "scout" / "out" / "graph_patches.json").resolve()
    if os.environ.get("MW_SCOUT_APPLY_GRAPH") == "0" or Path(srun.GRAPH_PATCHES).resolve() != real:
        return None
    ap = ROOT / "graph" / "apply_patch.py"
    if not ap.exists():
        return None
    import subprocess
    try:
        p = subprocess.run([sys.executable, str(ap), "--task", task_id], cwd=str(ROOT), capture_output=True,
                           text=True, timeout=600, stdin=subprocess.DEVNULL)
        line = next((x for x in reversed((p.stdout or "").strip().splitlines()) if x.strip().startswith("{")), "")
        r = json.loads(line) if line else {"ok": False, "error": (p.stderr or "").strip()[-300:] or f"exit {p.returncode}"}
    except Exception as e:  # noqa: BLE001 — the scout answer stands even if the graph rebuild failed
        r = {"ok": False, "error": f"{e.__class__.__name__}: {e}"}
    keep = {k: r.get(k) for k in ("ok", "say", "ids", "reload", "error", "ms") if r.get(k) is not None}
    say(f"graph: task {task_id} → " + (keep.get("say") or keep.get("error") or "?"))
    return keep


def run_one(task_id: str, wait_s: float = 0, cfg: dict | None = None) -> dict:
    """Run one specific queued task, waiting up to wait_s for a free slot. If another runner took it,
    wait for that one to finish. Returns {"id","state",…result}."""
    cfg = cfg or load_config()
    deadline = time.time() + wait_s
    while True:
        t, why = claim(only_id=task_id, cfg=cfg)
        if t:
            out = _execute(t, cfg)
            return {"id": task_id, **out}
        cur = get(task_id)
        if not cur:
            return {"id": task_id, "ok": False, "state": "failed", "error": "task vanished"}
        if cur["state"] not in ACTIVE:
            return {"id": task_id, "ok": cur["state"] == "done", "state": cur["state"], "error": cur.get("error"),
                    **(cur.get("result") or {})}
        if why.startswith("cap"):
            with _state() as st:
                for x in st["tasks"]:
                    if x["id"] == task_id and x["state"] == "queued":
                        x["state"], x["error"], x["finishedAt"] = "failed", why[5:], iso()
            return {"id": task_id, "ok": False, "state": "failed", "error": why[5:]}
        if time.time() > deadline:
            return {"id": task_id, "ok": False, "state": cur["state"], "error": f"still {cur['state']} ({why})"}
        time.sleep(3)


def drain(max_tasks: int | None = None, kinds: list[str] | None = None, cfg: dict | None = None) -> list[dict]:
    """Run queued tasks (best first) with `concurrency` workers until empty, capped, or max_tasks done."""
    cfg = cfg or load_config()
    results: list[dict] = []
    lock = threading.Lock()
    budget = [max_tasks if max_tasks is not None else 10 ** 6]
    notes: list[str] = []

    def worker():
        while True:
            with lock:
                if budget[0] <= 0:
                    return
                budget[0] -= 1
            t, why = claim(kinds=kinds, cfg=cfg)
            if not t:
                with lock:
                    budget[0] += 1
                    if why not in notes:
                        notes.append(why)
                return
            out = _execute(t, cfg)
            with lock:
                results.append({"id": t["id"], "kind": t["kind"], **out})

    # no concurrency limit (owner 2026-10-28: concurrency 999), but only start as many workers as there are
    # queued tasks to take — 999 idle threads with a 0.3 s stagger made every drain take ≥ 5 min
    queued = sum(1 for t in list_tasks(("queued",)) if not kinds or t.get("kind") in kinds)
    n = max(1, min(int(cfg.get("concurrency", 2)), queued or 1, budget[0]))
    ths = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
    for i, th in enumerate(ths):
        th.start()
        if i + 1 < len(ths):
            time.sleep(0.3)
    for th in ths:
        th.join()
    for why in notes:
        if why.startswith("cap"):
            say(f"drain: stopped — over the daily cap: {why[5:]} (Claude work skipped, tasks stay queued)")
        elif why == "busy":
            say("drain: all slots busy (another runner is working); the rest stays queued")
    return results


def auto(max_new: int | None = None, run: bool = True, cfg: dict | None = None) -> dict:
    """The automatic trigger (end of update.sh / the loop): detect → enqueue → drain."""
    cfg = cfg or load_config()
    from scout import detect as sdetect
    cands = sdetect.detect(cfg)
    mx = int(max_new if max_new is not None else (cfg.get("detect") or {}).get("max_new_per_run", 6))
    added = enqueue_candidates(cands, mx)
    say(f"auto: {len(cands)} candidate(s), {len(added)} queued: " + ", ".join(f"{t['kind']}:{t['key'].split(':', 1)[-1]}" for t in added))
    res = drain(cfg=cfg) if run else []
    return {"candidates": len(cands), "queued": [t["id"] for t in added], "ran": res, "usage": usage_today(cfg)}


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="scout queue")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a_auto = sub.add_parser("auto")
    a_auto.add_argument("--max", type=int)
    a_auto.add_argument("--no-run", action="store_true")
    sub.add_parser("detect")
    a_add = sub.add_parser("add")
    a_add.add_argument("--kind", required=True, choices=list(KINDS))
    a_add.add_argument("--target")
    a_add.add_argument("--question")
    a_add.add_argument("--priority", type=float, default=1.0)
    a_add.add_argument("--owner", action="store_true")
    a_dr = sub.add_parser("drain")
    a_dr.add_argument("--max", type=int)
    a_dr.add_argument("--kind", action="append")
    sub.add_parser("list")
    sub.add_parser("usage")
    a_show = sub.add_parser("show")
    a_show.add_argument("id")
    a = ap.parse_args(argv)

    if a.cmd == "auto":
        out = auto(a.max, run=not a.no_run)
        print(json.dumps({k: out[k] for k in ("candidates", "queued", "usage")} |
                         {"ran": [{k: r.get(k) for k in ("id", "kind", "state", "line")} for r in out["ran"]]},
                         ensure_ascii=False, indent=1))
    elif a.cmd == "detect":
        from scout import detect as sdetect
        cfg = load_config()
        added = enqueue_candidates(sdetect.detect(cfg), int(cfg["detect"].get("max_new_per_run", 6)))
        print(json.dumps([{k: t[k] for k in ("id", "kind", "key", "priority")} for t in added], ensure_ascii=False, indent=1))
    elif a.cmd == "add":
        tgt = a.target
        if tgt and tgt.strip().startswith("{"):
            tgt = json.loads(tgt)
        t, status = enqueue(a.kind, tgt, a.question, priority=a.priority, source="owner" if a.owner else "auto")
        print(json.dumps({"id": t["id"], "status": status}, ensure_ascii=False))
    elif a.cmd == "drain":
        res = drain(a.max, a.kind)
        print(json.dumps([{k: r.get(k) for k in ("id", "kind", "state", "line", "error")} for r in res], ensure_ascii=False, indent=1))
    elif a.cmd == "list":
        for t in list_tasks():
            print(f"{t['id']:24s} {t['state']:8s} {t['kind']:7s} p={t.get('priority', 0):<5} {t.get('source', ''):6s} {(t.get('question') or '')[:50]}")
    elif a.cmd == "usage":
        print(json.dumps(usage_today(), ensure_ascii=False, indent=1))
    elif a.cmd == "show":
        print(json.dumps(get(a.id), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
