"""common/procs.py — detached worker processes that are reaped, and a liveness check that sees zombies.

Why: 为什么 and 侦察兵 start each paid search in its own detached process (`python3 -m why.job --run <id>`,
`python3 -m scout.job --run <id>`) so a server restart does not lose it. The server never waited on them, so a
worker killed by OOM / kill -9 stayed a zombie — and `os.kill(pid, 0)` succeeds on a zombie, so the job kept
showing "running" forever (and a requeued owner 🔎 task was never picked up again).

    p = spawn(argv, cwd=…, stdout=fh, stderr=fh, env=…)   # Popen kept here; a daemon thread reaps finished ones
    alive(pid) -> bool                                       # False for a dead or zombie process
    reap() -> int                                            # poll every child we started (also called by alive)
"""
from __future__ import annotations

import os
import subprocess
import threading
import time

_children: dict[int, subprocess.Popen] = {}
_lock = threading.Lock()
_reaper: threading.Thread | None = None
REAP_EVERY_S = 10.0


def reap() -> int:
    """poll() every child we spawned; finished ones are waited on (no zombie) and forgotten. → how many."""
    with _lock:
        done = [pid for pid, p in _children.items() if p.poll() is not None]
        for pid in done:
            _children.pop(pid, None)
    return len(done)


def _reaper_loop() -> None:
    while True:
        time.sleep(REAP_EVERY_S)
        try:
            reap()
        except Exception:  # noqa: BLE001 — the reaper must never die
            pass


def _ensure_reaper() -> None:
    global _reaper
    with _lock:
        if _reaper is None or not _reaper.is_alive():
            _reaper = threading.Thread(target=_reaper_loop, name="mw-reaper", daemon=True)
            _reaper.start()


def spawn(argv: list[str], *, cwd: str | None = None, stdout=None, stderr=None, env: dict | None = None,
          new_session: bool = True) -> subprocess.Popen:
    """Start a detached worker (own session, stdin closed) and keep its handle so it is reaped when it ends."""
    reap()
    p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, env=env,
                         start_new_session=new_session)
    with _lock:
        _children[p.pid] = p
    _ensure_reaper()
    return p


def _ps_state(pid: int) -> str | None:
    try:
        r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=3)
    except Exception:  # noqa: BLE001
        return None
    return (r.stdout or "").strip() or None


def alive(pid) -> bool:
    """True while the process runs. Our own children: poll() (which also reaps them). Others (a worker started
    by another process): os.kill(pid, 0), then `ps` to tell a zombie ('Z') from a live process."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    with _lock:
        p = _children.get(pid)
    if p is not None:
        if p.poll() is None:
            return True
        with _lock:
            _children.pop(pid, None)
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    st = _ps_state(pid)
    if st is None:              # ps found nothing: it just ended (or ps is unavailable — then trust kill)
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    return not st.startswith("Z")
