#!/usr/bin/env python3
"""runstep.py — run one optional update.sh step in isolation: own process group, no stdin, a hard timeout.

    python3 pipeline/runstep.py --timeout 900 --name globalmkt -- bash globalmkt/run.sh [--quick]

- The step runs in its own session/process group, so on a timeout the WHOLE step (bash + the python it
  started + anything those spawned) is stopped: SIGTERM, then SIGKILL after --grace seconds.
- SIGTERM/SIGINT/SIGHUP sent to this wrapper (e.g. the 💓 loop stopping update.sh's process group) are
  passed on to the step's group the same way, so nothing is left running in the background.
- stdin is /dev/null (a step can never hang waiting for input); stdout/stderr go straight through.
- Exit code: the step's own, 124 on timeout (like coreutils timeout), 128+N if it died from signal N,
  127 if the command could not be started. --timeout 0 = no limit.
Standard library only, works with macOS' bash 3.2 callers.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time


def stop_group(p: subprocess.Popen, grace: float) -> None:
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5.0)):
        try:
            os.killpg(p.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            p.wait(timeout=wait)
            # the leader is gone; make sure stragglers in the group are too
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            return
        except subprocess.TimeoutExpired:
            continue


def main(argv: list[str]) -> int:
    if "--" in argv:
        k = argv.index("--")
        mine, cmd = argv[:k], argv[k + 1:]
    else:
        mine, cmd = [], argv
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--timeout", type=float, default=0, help="seconds (0 = no limit)")
    ap.add_argument("--grace", type=float, default=8.0, help="seconds between SIGTERM and SIGKILL")
    ap.add_argument("--name", default="")
    args = ap.parse_args(mine)
    if not cmd:
        ap.error("no command given (put it after --)")
    name = args.name or os.path.basename(cmd[-1] if len(cmd) > 1 else cmd[0])
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, start_new_session=True)
    except OSError as e:
        print(f"   [{name}] cannot start {' '.join(cmd)}: {e}", flush=True)
        return 127

    got = {"sig": None}

    def on_signal(signum, _frame):
        got["sig"] = signum
        stop_group(p, min(args.grace, 5.0))

    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)

    t0 = time.time()
    deadline = t0 + args.timeout if args.timeout and args.timeout > 0 else None
    while True:
        try:
            rc = p.wait(timeout=1.0)
            break
        except subprocess.TimeoutExpired:
            pass
        if got["sig"] is not None:
            rc = p.poll()
            break
        if deadline and time.time() > deadline:
            print(f"   [{name}] TIMEOUT after {int(time.time() - t0)}s (limit {int(args.timeout)}s) — stopping it",
                  flush=True)
            stop_group(p, args.grace)
            return 124
    if got["sig"] is not None:
        return 128 + int(got["sig"])
    if rc is None:
        return 1
    return 128 - rc if rc < 0 else rc   # killed by signal N → 128 + N


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
