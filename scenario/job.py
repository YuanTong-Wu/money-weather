"""Tiny background-job runner, so an HTTP request never waits the minute or two a scenario takes.

    from scenario import job
    sid = job.start(text, date=None, tier=None)   # returns at once (raises job.JobError on bad input / busy)
    job.status(sid)        # {id, state: queued|running|done|error, stage, startedAt, updatedAt, error?, result?}
    job.get(sid)           # the full result dict, or None
    job.list_scenarios()   # newest first: finished ones (summary + track) and the ones still running

Each job is a separate `python3 scenario/engine.py … --id <sid> --status-file …` process
(start_new_session=True), so it survives the request and even a server restart. Files:
  results  web/data/scenarios/<id>.json + index.json   ($MW_SCENARIO_DIR)  — served to the screen
  work     scenario/out/<id>.raw.json (model answer), <id>.status.json (progress), <id>.log
                                                         ($MW_SCENARIO_WORK)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent
ENGINE = _HERE / "engine.py"
MAX_RUNNING = int(os.environ.get("MW_SCENARIO_MAX_JOBS", "999"))  # owner: no count limit, only the spend budget
MAX_SECONDS = 15 * 60
ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")


class JobError(RuntimeError):
    pass


def out_dir() -> Path:
    """Results (served): web/data/scenarios."""
    d = Path(os.environ.get("MW_SCENARIO_DIR") or (ROOT / "web" / "data" / "scenarios"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def work_dir() -> Path:
    """Work files (private): scenario/out."""
    d = Path(os.environ.get("MW_SCENARIO_WORK") or (_HERE / "out"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _write(p: Path, obj):
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    os.replace(tmp, p)


def _alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except (ProcessLookupError, ValueError, TypeError):
        return False
    except PermissionError:
        return True
    try:  # reap our own finished child so it does not linger as a zombie
        done, _ = os.waitpid(int(pid), os.WNOHANG)
        if done:
            return False
    except ChildProcessError:
        pass
    except OSError:
        pass
    return True


def _new_id(text: str) -> str:
    h = hashlib.sha1(f"{text}|{time.time()}|{os.getpid()}".encode()).hexdigest()[:4]
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + h


def _check_id(sid: str) -> str:
    if not isinstance(sid, str) or not ID_RE.match(sid):
        raise JobError("推演 id 不对")
    return sid


def running() -> list[str]:
    out = []
    for p in work_dir().glob("*.status.json"):
        st = _read(p) or {}
        if st.get("state") in ("queued", "running") and _alive(st.get("pid")):
            out.append(st.get("id"))
    return out


def start(text: str, date: str | None = None, tier: str | None = None) -> str:
    text = (text or "").strip()
    if not text:
        raise JobError("要先写一句判断")
    if len(text) > 600:
        raise JobError("这句话太长了，写成一句带日期的话就好（600 字以内）")
    if len(running()) >= MAX_RUNNING:
        raise JobError("正在推演的已经有好几个了，等一下再来")
    d, w = out_dir(), work_dir()
    sid = _new_id(text)
    status_p = w / f"{sid}.status.json"
    now = datetime.now().isoformat(timespec="seconds")
    _write(status_p, {"id": sid, "state": "queued", "stage": "排队", "text": text, "date": date, "tier": tier,
                      "startedAt": now, "updatedAt": now})
    cmd = [sys.executable, str(ENGINE), text, "--id", sid, "--status-file", str(status_p), "--out", str(d),
           "--work", str(w), "--quiet"]
    if date:
        cmd += ["--date", str(date)]
    if tier:
        cmd += ["--tier", str(tier)]
    log = open(w / f"{sid}.log", "w")
    try:
        proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True, env=os.environ.copy())
    finally:
        log.close()
    st = _read(status_p) or {}
    st.setdefault("pid", proc.pid)
    if st.get("state") == "queued":
        st["pid"] = proc.pid
    _write(status_p, st)
    return sid


def get(sid: str) -> dict | None:
    _check_id(sid)
    return _read(out_dir() / f"{sid}.json")


def status(sid: str, with_result: bool = True) -> dict:
    _check_id(sid)
    d, w = out_dir(), work_dir()
    st = _read(w / f"{sid}.status.json")
    res_p = d / f"{sid}.json"
    if st is None:
        if res_p.exists():  # a result made from the CLI, without a job
            st = {"id": sid, "state": "done", "stage": "完成"}
        else:
            return {"id": sid, "state": "error", "error": "找不到这个推演"}
    state = st.get("state")
    if state in ("queued", "running"):
        if res_p.exists() and not _alive(st.get("pid")):
            st.update(state="done", stage="完成")
        elif not _alive(st.get("pid")):
            log = ""
            try:
                log = (w / f"{sid}.log").read_text()[-400:]
            except Exception:
                pass
            st.update(state="error", stage="出错了", error="推演中断了" + (("：" + log.strip()) if log.strip() else ""))
        else:
            try:
                t0 = datetime.fromisoformat(st.get("startedAt"))
                if (datetime.now() - t0).total_seconds() > MAX_SECONDS:
                    st.update(state="error", stage="出错了", error="推演太久没完成")
            except Exception:
                pass
        if st.get("state") != state:
            _write(w / f"{sid}.status.json", st)
    if st.get("startedAt"):
        try:
            st["elapsed"] = round((datetime.now() - datetime.fromisoformat(st["startedAt"])).total_seconds())
        except Exception:
            pass
    if with_result and st.get("state") == "done":
        st["result"] = _read(res_p)
        if isinstance(st["result"], dict):
            try:                                   # live market odds (+ no raw ids, take agrees with the ranking)
                import engine
                engine.refresh_markets(st["result"])
            except Exception:  # noqa: BLE001 — the saved result stands
                pass
    return st


def list_scenarios(limit: int = 50) -> list[dict]:
    """Finished ones from web/data/scenarios/index.json (rebuilt if missing) + jobs still running/failed."""
    d = out_dir()
    idx = _read(d / "index.json")
    if not isinstance(idx, dict) or not isinstance(idx.get("scenarios"), list):
        import engine  # lazy: numpy etc.
        idx = engine.write_index(d)
    items = [dict(x, state="done") for x in idx.get("scenarios") or []]
    done = {i["id"] for i in items}
    for p in work_dir().glob("*.status.json"):
        st = _read(p) or {}
        sid = st.get("id")
        if not sid or sid in done or not ID_RE.match(sid):
            continue
        st = status(sid, with_result=False)
        if st.get("state") == "done" and (d / f"{sid}.json").exists():
            continue  # finished after the index was written; the next index rebuild lists it
        if st.get("state") in ("queued", "running", "error"):
            items.append({"id": sid, "state": st["state"], "stage": st.get("stage"), "error": st.get("error"),
                          "elapsed": st.get("elapsed"),
                          "title": (st.get("text") or "")[:24], "root": {"text": st.get("text"), "date": st.get("date"),
                                                                         "tier": st.get("tier")},
                          "createdAt": st.get("startedAt")})
    items.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return items[:limit]


def delete(sid: str) -> bool:
    """Soft delete (moved to scenario/out/trash/) and rebuild the index."""
    _check_id(sid)
    import engine
    return engine.delete(sid, out_dir(), work_dir())


if __name__ == "__main__":  # tiny manual test: python3 scenario/job.py "<text>" [date] [tier]
    if len(sys.argv) < 2:
        print(json.dumps(list_scenarios(), ensure_ascii=False, indent=1))
        sys.exit(0)
    sid = start(sys.argv[1], *(sys.argv[2:4]))
    print("started", sid)
    while True:
        st = status(sid, with_result=False)
        print(st.get("state"), st.get("stage"), st.get("elapsed"))
        if st["state"] in ("done", "error"):
            print(st.get("error") or "ok")
            break
        time.sleep(5)
