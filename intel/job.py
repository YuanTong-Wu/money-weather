"""intel/job.py — background ingest jobs for the server (start / status / delete) + one route() helper.

Each job is a detached `python3 intel/ingest.py --job <id>` process, so the server never blocks
and a crash in one job can't touch the server. State lives in files (survives a server restart):
  intel/out/jobs/<id>.json      status (atomic writes), read by GET /api/intel?id=
  intel/out/jobs/<id>.in.json   the input, deleted when the job ends
  intel/out/jobs/<id>.log       the child's stderr (for debugging)

Server wiring: one line per verb, `if intel_job.serve(self): return` (or `route(method, path, query, body)`
if you want to send the response yourself). See intel/README.md.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from intel import store  # noqa: E402

JOBS_DIR = store.JOBS_DIR
INGEST = _HERE / "ingest.py"
MAX_RUNNING = 999                 # owner: no count limit, only the spend budget (DESIGN §21)
HARD_TIMEOUT_S = 240          # a job still "running" after this is killed and marked as failed
KEEP_JOBS_S = 2 * 86400       # job files older than this are cleaned up
MAX_BODY = 1_000_000          # bytes accepted from POST /api/intel
_JOB_RE = re.compile(r"^job-[0-9a-f]{6,}-[0-9a-f]{4}$")


def _path(job_id: str, suffix: str = ".json") -> Path:
    if not _JOB_RE.match(job_id or ""):
        raise ValueError("bad job id")
    return JOBS_DIR / f"{job_id}{suffix}"


def _read(p: Path) -> dict | None:
    try:
        with open(p, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except (OSError, TypeError, ValueError):
        return False
    # a finished child of this process stays a zombie until reaped; reap it and call it dead
    try:
        done, _ = os.waitpid(int(pid), os.WNOHANG)
        if done:
            return False
    except ChildProcessError:
        pass
    except OSError:
        pass
    return True


# ── used by ingest.py --job ──
def write_status(job_id: str, **fields: Any) -> dict:
    """Read-modify-write under a per-job lock (the server and the job process both write it).
    A final state (done/error/cancelled) is never overwritten by a late "queued"/"running"."""
    p = _path(job_id)
    with store.locked(p):
        cur = _read(p) or {"id": job_id}
        if cur.get("state") in ("done", "error", "cancelled") and fields.get("state") in ("queued", "running"):
            fields = {k: v for k, v in fields.items() if k not in ("state", "stage", "step")}
        cur.update(fields)
        cur["updatedAt"] = datetime.now().isoformat(timespec="seconds")
        store.atomic_write_json(p, cur, indent=None)
    return cur


def read_input(job_id: str) -> dict | None:
    return _read(_path(job_id, ".in.json"))


def drop_input(job_id: str) -> None:
    try:
        _path(job_id, ".in.json").unlink()
    except OSError:
        pass


# ── server side ──
def _running() -> list[dict]:
    out = []
    if not JOBS_DIR.is_dir():
        return out
    for f in JOBS_DIR.glob("job-*.json"):
        if f.name.endswith(".in.json"):
            continue
        d = _read(f)
        if d and d.get("state") in ("queued", "running") and _alive(d.get("pid")):
            out.append(d)
    return out


def cleanup(max_age_s: float = KEEP_JOBS_S) -> int:
    n = 0
    if not JOBS_DIR.is_dir():
        return 0
    cutoff = time.time() - max_age_s
    for f in JOBS_DIR.glob("job-*"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                n += 1
        except OSError:
            pass
    return n


def start(text: str | None = None, url: str | None = None, source: str | None = None,
          force: bool = False) -> dict:
    """Start one ingest in the background → {"id", "started": true} or {"error": "…"}."""
    text = (text or "").strip()
    url = (url or "").strip()
    if not text and not url:
        return {"started": False, "error": "没有内容：请贴一段文字或一个网址"}
    if len(text) > 400_000:
        text = text[:400_000]
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    store.ensure_exists()
    # the cap check and the spawn happen under one lock, so 5 simultaneous POSTs can't start 5 jobs
    with store.locked(JOBS_DIR / "start"):
        if len(_running()) >= MAX_RUNNING:
            return {"started": False, "error": f"已经有 {MAX_RUNNING} 条在消化，等一下再投"}
        cleanup()
        return _spawn(text, url, source, force)


def _spawn(text: str, url: str, source: str | None, force: bool) -> dict:
    job_id = f"job-{datetime.now().strftime('%y%m%d%H%M%S')}-{secrets.token_hex(2)}"
    if source not in ("paste", "url", "claude"):
        source = "url" if (url and not text) else "paste"
    store.atomic_write_json(_path(job_id, ".in.json"), {"text": text, "url": url, "source": source,
                                                         "force": bool(force)}, indent=None)
    excerpt = re.sub(r"\s+", " ", text)[:120]
    write_status(job_id, state="queued", stage="排队中…", startedAt=datetime.now().isoformat(timespec="seconds"),
                 input={"url": url or None, "excerpt": excerpt, "source": source}, events=[], warnings=[],
                 error=None)
    log = open(_path(job_id, ".log"), "w")
    try:
        p = subprocess.Popen([sys.executable, str(INGEST), "--job", job_id], cwd=str(store.ROOT),
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                             close_fds=True)
    except OSError as e:
        write_status(job_id, state="error", stage="没成功", error=f"后台任务起不来：{e}")
        return {"started": False, "id": job_id, "error": f"后台任务起不来：{e}"}
    finally:
        log.close()
    write_status(job_id, pid=p.pid)
    return {"started": True, "id": job_id}


def status(job_id: str) -> dict:
    """{"id","state":"queued|running|done|error|cancelled","stage":"中文进度","elapsed":s,
        "events":[…] when done,"warnings":[…],"error":"…"|null}"""
    try:
        p = _path(job_id)
    except ValueError:
        return {"id": job_id, "state": "error", "error": "没有这条任务"}
    d = _read(p)
    if d is None:
        return {"id": job_id, "state": "error", "error": "没有这条任务"}
    try:
        started = datetime.fromisoformat(d.get("startedAt"))
        d["elapsed"] = int((datetime.now() - started).total_seconds())
    except (TypeError, ValueError):
        d["elapsed"] = None
    if d.get("state") in ("queued", "running"):
        pid = d.get("pid")
        if pid and not _alive(pid):
            # child is gone but never wrote a final state → re-read once (it may have just finished)
            d2 = _read(p) or d
            if d2.get("state") in ("queued", "running"):
                d = write_status(job_id, state="error", stage="没成功", error="后台进程意外退出")
            else:
                d = d2
        elif d.get("elapsed") and d["elapsed"] > HARD_TIMEOUT_S:
            _kill(pid)
            d = write_status(job_id, state="error", stage="没成功", error=f"超过 {HARD_TIMEOUT_S} 秒还没好，已停掉")
            drop_input(job_id)
    d.pop("pid", None)
    return d


def _kill(pid: Any) -> None:
    try:
        os.killpg(int(pid), signal.SIGTERM)
    except (OSError, TypeError, ValueError):
        try:
            os.kill(int(pid), signal.SIGTERM)
        except (OSError, TypeError, ValueError):
            pass


def delete(ident: str) -> dict:
    """A job id → cancel it. An event id or groupId → remove from the intel layer."""
    ident = (ident or "").strip()
    if not ident:
        return {"deleted": 0, "error": "缺少 id"}
    if _JOB_RE.match(ident):
        d = _read(_path(ident))
        if not d:
            return {"deleted": 0, "error": "没有这条任务"}
        if d.get("state") in ("queued", "running"):
            _kill(d.get("pid"))
            write_status(ident, state="cancelled", stage="已取消")
            drop_input(ident)
            return {"deleted": 1, "cancelled": True}
        return {"deleted": 0, "note": "任务已经结束；要删它产生的情报，请用情报的 id"}
    n = store.delete(ident)
    return {"deleted": n} if n else {"deleted": 0, "error": "没找到这条情报"}


def list_events(limit: int | None = None) -> dict:
    evs = store.load()
    return {"events": evs[:limit] if limit else evs, "count": len(evs), "running": [
        {"id": j["id"], "stage": j.get("stage"), "input": j.get("input")} for j in _running()]}


# ── one-call server integration ──
def serve(handler: Any) -> bool:
    """For server.py: put `if intel_job.serve(self): return` first in do_GET / do_HEAD / do_POST /
    do_DELETE. Handles every /api/intel… request on a BaseHTTPRequestHandler (reads the body itself,
    413 over MAX_BODY) and returns True; returns False for any other path without touching the request."""
    from urllib.parse import urlsplit
    u = urlsplit(handler.path)
    if not (u.path == "/api/intel" or u.path.startswith("/api/intel/")):
        return False
    try:
        n = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        n = 0
    body = b""
    if n > MAX_BODY:
        handler.close_connection = True
        code, obj = 413, {"started": False, "error": "内容太长了（上限约 1 MB）"}
    else:
        body = handler.rfile.read(n) if n > 0 else b""
        try:
            r = route(handler.command, u.path, u.query, body)
            code, obj = r if r is not None else (404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 — never take the server down
            code, obj = 200, {"error": f"情报接口出错：{type(e).__name__}: {e}"}
    data = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
    try:
        handler.send_response(code)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        if handler.command != "HEAD":
            handler.wfile.write(data)
    except (BrokenPipeError, ConnectionResetError):
        pass
    return True


def route(method: str, path: str, query: str | dict | None = None, body: bytes | None = None
          ) -> tuple[int, dict] | None:
    """Handle every /api/intel… request. Returns (http_code, json_obj), or None if not ours.

    POST   /api/intel            body {"text": "…", "url": "…", "force": false} (or raw text) → {"started", "id"}
    GET    /api/intel?id=<job>   → job status (state, stage, events when done)
    GET    /api/intel/list       → {"events": […newest first], "count", "running": […]}
    DELETE /api/intel?id=<id>    → cancel a job, or delete an event / a whole input (groupId)
    POST   /api/intel/delete?id= → same as DELETE (for clients that can't send DELETE)
    """
    if not (path == "/api/intel" or path.startswith("/api/intel/")):
        return None
    q = parse_qs(query) if isinstance(query, str) else (query or {})

    def qv(k: str) -> str:
        v = q.get(k)
        if isinstance(v, list):
            return v[0] if v else ""
        return v or ""

    m = method.upper()
    if path == "/api/intel/list" and m in ("GET", "HEAD"):
        store.ensure_exists()
        lim = qv("limit")
        return 200, list_events(int(lim) if lim.isdigit() else None)
    if path == "/api/intel/delete" and m == "POST":
        return 200, delete(qv("id"))
    if path == "/api/intel":
        if m in ("GET", "HEAD"):
            jid = qv("id")
            if not jid:
                return 200, {"running": [{"id": j["id"], "stage": j.get("stage")} for j in _running()]}
            return 200, status(jid)
        if m == "DELETE":
            return 200, delete(qv("id"))
        if m == "POST":
            raw = (body or b"")[:MAX_BODY]
            payload: dict = {}
            s = raw.decode("utf-8", "replace").strip()
            if s.startswith("{"):
                try:
                    payload = json.loads(s)
                except ValueError:
                    return 400, {"started": False, "error": "请求不是合法 JSON"}
            elif s:
                payload = {"text": s}
            if not isinstance(payload, dict):
                return 400, {"started": False, "error": "请求格式不对"}
            res = start(text=str(payload.get("text") or ""), url=str(payload.get("url") or ""),
                        source=payload.get("source") or None,
                        force=bool(payload.get("force")) or qv("force") in ("1", "true"))
            return 200, res
    return 405, {"error": "不支持这个请求"}
