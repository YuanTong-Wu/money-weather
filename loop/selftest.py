#!/usr/bin/env python3
"""Self-test for the loop — spends NO Claude quota (a fake `claude` answers) and writes only to a temp dir.

    python3 loop/selftest.py          # all checks, prints PASS/FAIL per check, exit 1 on any failure
    python3 loop/selftest.py -v       # also show the runner's own log lines

Covers: NYSE calendar 2026–27 (holidays, Good Friday, early closes, DST), the scheduler at fixed New York
times, the budget guard, JSON extraction, scout result mapping, and end-to-end runs of loop/runner.py:
  1. an injected failing step → retry with back-off → Claude verify → code issue in issues.md
  2. a flaky shell step → transient → same failure again is NOT re-sent to Claude (dedupe) → the step
     passes → the issue closes itself ("已自愈")
  3. a data-level diagnosis → ticker rename applied to fixes.json + overrides.json, owner entry untouched
  4. verify count cap = 0 → no Claude call, the issue says the quota is used up
  4b. today's automatic Claude points (DESIGN §21) used up → no call, the issue and heartbeat say so
  5. single-instance lock: a second runner refuses to start
  6. the scout path: the failing step becomes a scout verify task ({"type":"error","step","log"}) — a fake
     scout CLI stands in via the scout.verify_cmd template, so the real scout queue is never touched
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
from datetime import date, datetime, timedelta
from pathlib import Path

if __package__ in (None, ""):
    _here = str(Path(__file__).resolve().parent)
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from loop import calendar_ny as cal  # noqa: E402
from loop.budget import Budget  # noqa: E402
from loop.claude import build_argv, extract_json  # noqa: E402
from loop.scout_bridge import ScoutBridge, scout_result_to_loop  # noqa: E402
from loop.settings import DEFAULTS, ROOT  # noqa: E402

VERBOSE = "-v" in sys.argv
RESULTS: list[tuple[str, bool, str]] = []
NY = cal.NY


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail and (not cond or VERBOSE) else ""))


# ── pure checks ──────────────────────────────────────────────────────────────────────────────────
def test_calendar() -> None:
    print("calendar")
    check("2026 has 10 NYSE holidays", sum(d.year == 2026 for d in cal.HOLIDAYS) == 10)
    check("2027 has 10 NYSE holidays", sum(d.year == 2027 for d in cal.HOLIDAYS) == 10)
    for y in (2026, 2027):
        gf = cal.easter(y) - timedelta(days=2)
        check(f"Good Friday {y} = {gf}", gf in cal.HOLIDAYS)
    check("all holidays are weekdays", all(d.weekday() < 5 for d in cal.HOLIDAYS))
    check("Thanksgiving = 4th Thursday", all(
        d.weekday() == 3 and 22 <= d.day <= 28 for d, n in cal.HOLIDAYS.items() if n == "感恩节"))
    check("2026-07-03 closed (7/4 is Saturday)", not cal.is_trading_day(date(2026, 7, 3)))
    check("2027-12-31 open (NYSE does not observe Sat New Year)", cal.is_trading_day(date(2027, 12, 31)))
    s = cal.session(date(2026, 11, 27))
    check("2026-11-27 closes 13:00", s is not None and s[1].hour == 13)
    s = cal.session(date(2026, 10, 27))
    check("regular day 09:30–16:00 ET", s[0].hour == 9 and s[0].minute == 30 and s[1].hour == 16)
    check("2026-10-27 09:30 ET = 00:30 AEDT next day",
          s[0].astimezone(cal.ZoneInfo("Australia/Sydney")).strftime("%m-%d %H:%M") == "10-28 00:30")
    after_dst = cal.session(date(2026, 11, 2))[0]   # US DST ends 2026-11-01
    check("after US DST ends, 09:30 ET = 01:30 AEDT", after_dst.astimezone(cal.ZoneInfo("Australia/Sydney")).hour == 1)
    t = datetime(2026, 10, 31, 12, 0, tzinfo=NY)    # Saturday
    check("Saturday: market closed", not cal.is_open(t))
    check("Saturday: last completed session = Fri 10-30", cal.last_completed_session(t) == date(2026, 10, 30))
    check("next open after Sat = Mon 09:30", cal.next_open(t) == datetime(2026, 11, 2, 9, 30, tzinfo=NY))
    check("Thanksgiving week: Wed→Fri is 1 trading day", cal.trading_days_between(date(2026, 11, 25), date(2026, 11, 27)) == 1)


def _runner(state: dict | None = None):
    from loop.runner import Runner
    cfg = json.loads(json.dumps(DEFAULTS))
    r = Runner(cfg, mode="test", dry_run=True)
    r.state = {"sched": {}, "stepLast": {}, "issues": {}, "claudeLog": [], "recent": [], "tickerFail": {},
               "tickerVerified": {}, **(state or {})}
    return r


def test_scheduler() -> None:
    print("scheduler")
    r = _runner({"sched": {"close_day": "2026-10-26", "nightly_day": "2026-10-26",
                           "last_any": "2026-10-27T09:40:00-04:00"}})
    t = datetime(2026, 10, 27, 9, 50, tzinfo=NY)
    check("09:50 ET Tue → market due", r.due(t)[:1] == ["market"], str(r.due(t)))
    r.state["sched"]["market_slot"] = datetime(2026, 10, 27, 9, 45, tzinfo=NY).isoformat(timespec="seconds")
    check("09:50 after 09:45 slot ran → nothing due", r.due(t) == [], str(r.due(t)))
    n = r.next_due(t)
    check("next = market 10:00", n and n[0] == "market" and n[1] == datetime(2026, 10, 27, 10, 0, tzinfo=NY), str(n))
    t = datetime(2026, 10, 27, 16, 31, tzinfo=NY)
    check("16:31 ET → close due", "close" in r.due(t), str(r.due(t)))
    t = datetime(2026, 10, 27, 21, 5, tzinfo=NY)
    check("21:05 before close ran → nightly waits for close", "nightly" not in r.due(t) and "close" in r.due(t))
    r.state["sched"]["close_day"] = "2026-10-27"
    check("21:05 after close → nightly due", "nightly" in r.due(t), str(r.due(t)))
    r2 = _runner({"sched": {"close_day": "2026-10-22", "nightly_day": "2026-10-22",
                            "last_any": "2026-10-22T21:30:00-04:00"}})
    t = datetime(2026, 10, 26, 7, 0, tzinfo=NY)   # Monday pre-market; laptop asleep since Thursday night
    d = r2.due(t)
    check("wake after sleeping through Friday → close catch-up first, then nightly",
          d[:1] == ["close"] and "nightly" not in d, str(d))
    r2.state["sched"]["close_day"] = "2026-10-23"
    check("…and the missed nightly right after", r2.due(t)[:1] == ["nightly"], str(r2.due(t)))
    t = datetime(2026, 11, 26, 11, 0, tzinfo=NY)  # Thanksgiving
    r3 = _runner({"sched": {"close_day": "2026-11-25", "nightly_day": "2026-11-25",
                            "last_any": "2026-11-26T10:30:00-04:00"}})
    check("Thanksgiving 11:00 → no market/close", not ({"market", "close"} & set(r3.due(t))), str(r3.due(t)))
    t = datetime(2026, 11, 27, 13, 31, tzinfo=NY)  # early close day
    r3.state["sched"]["close_day"] = "2026-11-25"
    check("early-close day: close due at 13:31", "close" in r3.due(t), str(r3.due(t)))
    slots = r3._market_slots(date(2026, 11, 27))
    check("early-close day: last market slot 13:00", slots and slots[-1].hour == 13 and slots[-1].minute == 0)


def test_misc(tmp: Path) -> None:
    print("budget / parsing / scout mapping")
    clock = lambda: datetime(2026, 10, 27, 10, 0, tzinfo=NY)  # noqa: E731
    b = Budget(tmp / "b.json", {"global": 3, "scout": 2, "explain": 2, "verify": 1}, {"explain": ["scout"]}, clock=clock)
    check("spend explain ×2", b.try_spend("explain") and b.try_spend("explain"))
    check("explain over scout cap", not b.try_spend("explain"))
    check("verify still allowed (own chain)", b.try_spend("verify"))
    check("global cap reached", not b.try_spend("verify") and b.left("scout") == 0)
    b.refund("explain", 1)
    check("refund frees a slot", b.left("scout") == 1 and b.status()["used"]["explain"] == 1)  # global 2/3, scout 1/2
    b2 = Budget(tmp / "b.json", b.caps, b.parents, clock=lambda: datetime(2026, 10, 28, 10, 0, tzinfo=NY))
    check("new New-York day resets", b2.left("explain") == 2)
    check("extract_json from fenced text", extract_json('看了\n```json\n{"a": 1}\n```') == {"a": 1})
    check("extract_json from chatter", extract_json('result: {"level":"code","x":{"y":2}} done') == {"level": "code", "x": {"y": 2}})
    check("extract_json none", extract_json("no json here") is None)
    argv = build_argv("claude", "hi", DEFAULTS)
    check("claude argv: web tools only + json + no session", "--tools" in argv and argv[argv.index("--tools") + 1] == "WebSearch,WebFetch"
          and "--output-format" in argv and "--no-session-persistence" in argv and "--safe-mode" in argv)
    m = scout_result_to_loop({"id": "t1", "state": "done", "say": "MRO 被康菲收购了", "conf": 0.9, "sources": ["https://x"]},
                             [{"id": "t1-0", "type": "ticker-merged", "ticker": "MRO"}])
    check("scout ticker-merged → data + ticker_drop", m["level"] == "data" and m["fix"] == {"kind": "ticker_drop", "from": "MRO"})
    m = scout_result_to_loop({"id": "t2", "state": "done", "say": "fetch.py 的列名变了"}, [{"type": "code-issue", "say": "改 split_fields"}])
    check("scout code-issue → code", m["level"] == "code")
    br = ScoutBridge(DEFAULTS)
    if br.queue_cli():
        w = br.work_argv("explain", 3)
        check("scout drain argv", w[1:] == ["scout/queue.py", "drain", "--max", "3", "--kind", "explain"], str(w))
        check("scout drain output counted", ScoutBridge.count_ran('x\n[\n {"id":"a","state":"done"},\n {"id":"b","state":"failed"}\n]') == 2)
    else:
        print("  (scout/queue.py not present — skipped scout argv checks)")


# ── end-to-end runs of loop/runner.py (subprocess, temp dirs, fake claude) ───────────────────────
FAKE_CLAUDE = r'''#!/bin/bash
d="$(cd "$(dirname "$0")" && pwd)"
echo x >> "$d/calls.txt"
printf '%s\n' "$@" > "$d/last_args.txt"
level="$(cat "$d/level" 2>/dev/null || echo code)"
exec python3 - "$level" <<'PY'
import json, sys
lvl = sys.argv[1]
fix = {"kind": "ticker_rename", "from": "OLDT", "to": "NEWT"} if lvl == "data" else {"kind": "none"}
ans = {"level": lvl, "diagnosis": "测试用诊断：" + lvl, "fix": fix,
       "issue": {"title": "测试问题", "detail": "selftest", "files": ["loop/runner.py"], "suggestion": "无"},
       "sources": ["https://example.org/selftest"], "conf": 0.9}
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                  "result": "```json\n" + json.dumps(ans, ensure_ascii=False) + "\n```"}, ensure_ascii=False))
PY
'''

FAKE_SCOUT = r'''import json, sys, pathlib
pathlib.Path(__file__).with_name("scout_got.json").write_text(
    json.dumps({"target": json.loads(sys.argv[1]), "question": sys.argv[2]}, ensure_ascii=False))
print("scout: working…")
print(json.dumps({"id": "fake-scout-1", "kind": "verify", "state": "done", "say": "侦察兵：这是测试钩子抛的异常",
                  "answer": "不是数据问题。", "conf": 0.8, "sources": ["https://example.org/scout"]}, ensure_ascii=False))
'''

PROBE = r'''import sys, pathlib
flag = pathlib.Path(sys.argv[1])
if flag.exists():
    print("ConnectionError: HTTPSConnectionPool(host='query1.finance.yahoo.com', port=443): Max retries exceeded")
    sys.exit(1)
print("probe ok")
'''


def _test_budget(tmp: Path) -> Path:
    """A fixed copy of common/budget.json for the tests: the 6/4/2 points rule at $1 a point, whatever the owner's
    live settings are (unlimited / forced model), so the budget checks below stay deterministic."""
    p = tmp / "budget.json"
    if not p.exists():
        try:
            b = json.loads((ROOT / "common" / "budget.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            b = {}
        b.update({"enabled": True, "unlimited": False, "daily_weekly_pct": 6, "auto_weekly_pct": 4,
                  "usd_per_weekly_pct": 1.0, "calibrated": False, "force_model": None, "force_effort": None,
                  "weekly_reset": {"at": None, "every_days": 7}, "use_before_reset": {"enabled": False}})
        p.write_text(json.dumps(b, ensure_ascii=False), encoding="utf-8")
    return p


def run_loop(tmp: Path, name: str, cfg: dict, *args: str) -> tuple[int, str, Path]:
    out = tmp / name
    out.mkdir(parents=True, exist_ok=True)
    (out / "cfg.json").write_text(json.dumps(cfg), encoding="utf-8")
    env = dict(os.environ, MW_LOOP_OUT=str(out / "loop"), MW_CLAUDE_BIN=str(tmp / "fake" / "claude"),
               MW_LOOP_CONFIG=str(out / "cfg.json"), MW_OVERRIDES_PATH=str(tmp / "overrides.json"),
               MW_HEARTBEAT_PATH=str(out / "loop" / "heartbeat.json"), MW_CLAUDE_USAGE=str(out / "claude_usage.json"),
               MW_CLAUDE_BUDGET=str(_test_budget(tmp)))
    p = subprocess.run([sys.executable, str(ROOT / "loop" / "runner.py"), *args], cwd=str(ROOT), env=env,
                       capture_output=True, text=True, timeout=300)
    if VERBOSE:
        print(textwrap.indent(p.stderr.strip(), "      | "))
    return p.returncode, p.stdout + p.stderr, out / "loop"


def state_of(d: Path) -> dict:
    return json.loads((d / "state.json").read_text(encoding="utf-8"))


def calls(tmp: Path) -> int:
    p = tmp / "fake" / "calls.txt"
    return len(p.read_text().splitlines()) if p.exists() else 0


def test_end_to_end(tmp: Path) -> None:
    print("end-to-end (fake claude, temp dirs)")
    (tmp / "fake").mkdir()
    fc = tmp / "fake" / "claude"
    fc.write_text(FAKE_CLAUDE)
    fc.chmod(0o755)
    (tmp / "probe.py").write_text(PROBE)
    flag = tmp / "probe.fail"
    base = {"verify": {"via_scout": False}, "health": {"check_server": False}}

    # 1. injected exception → retries → verify → code issue
    rc, log, d = run_loop(tmp, "t1", base, "--cycle", "health", "--inject-fail", "boom", "--fast")
    st = state_of(d)
    it = next(iter(st["issues"].values()), {})
    check("1 exit code 1 on failed cycle", rc == 1, f"rc={rc}")
    check("1 retried (2 attempts)", st["lastCycle"]["steps"][0].get("attempts") == 2)
    check("1 one Claude call", calls(tmp) == 1, str(calls(tmp)))
    check("1 issue level=code, open", it.get("level") == "code" and it.get("status") == "open")
    md = (d / "issues.md").read_text(encoding="utf-8")
    check("1 issues.md lists it under 要动代码", "要动代码" in md and it.get("id", "?") in md)
    hb = json.loads((d / "heartbeat.json").read_text(encoding="utf-8"))
    check("1 heartbeat red + claude log", hb["status"] == "red" and hb["claude"] and hb["claudeCallsToday"] == 1)
    args = (tmp / "fake" / "last_args.txt").read_text()
    check("1 claude got web tools only", "WebSearch,WebFetch" in args and "--allowedTools" in args)
    led = json.loads((tmp / "t1" / "claude_usage.json").read_text(encoding="utf-8"))
    check("1 the call is in claude_usage.json (kind loop:verify, automatic)",
          len(led["calls"]) == 1 and led["calls"][0]["kind"] == "loop:verify" and led["calls"][0]["auto"] is True)
    check("1 heartbeat shows today's points", "个点" in ((hb.get("usage") or {}).get("say") or ""), str(hb.get("usage"))[:120])

    # 2. flaky shell step: transient → dedupe → self-heal
    (tmp / "fake" / "level").write_text("transient")
    cfg2 = {**base, "cycles": {"health": {"steps": ["probe", "health"]}},
            "commands": {"probe": [["{py}", str(tmp / "probe.py"), str(flag)]]},
            "steps": {"probe": {"retries": 2, "title": "探针"}}}
    flag.write_text("x")
    n0 = calls(tmp)
    rc, log, d = run_loop(tmp, "t2", cfg2, "--cycle", "health", "--fast")
    st = state_of(d)
    it = next(iter(st["issues"].values()), {})
    check("2 probe failed after 3 attempts", st["lastCycle"]["steps"][0].get("attempts") == 3 and rc == 1)
    check("2 transient diagnosis", it.get("level") == "transient" and calls(tmp) == n0 + 1)
    rc, log, d = run_loop(tmp, "t2", cfg2, "--cycle", "health", "--fast")
    it = next(iter(state_of(d)["issues"].values()), {})
    check("2 same failure again → no new Claude call (dedupe)", calls(tmp) == n0 + 1 and it.get("count") == 2, f"calls={calls(tmp)} count={it.get('count')}")
    flag.unlink()
    rc, log, d = run_loop(tmp, "t2", cfg2, "--cycle", "health", "--fast")
    it = next(iter(state_of(d)["issues"].values()), {})
    check("2 step passes → issue closes itself", rc == 0 and it.get("status") == "resolved" and it.get("resolvedBy") == "auto")
    check("2 issues.md shows 已自愈", "已自愈" in (d / "issues.md").read_text(encoding="utf-8"))

    # 3. data-level fix applied automatically, owner override untouched
    (tmp / "fake" / "level").write_text("data")
    (tmp / "overrides.json").write_text(json.dumps([{"target": "s:KEEP", "field": "ticker", "value": "MINE", "source": "owner"}]))
    rc, log, d = run_loop(tmp, "t3", base, "--cycle", "health", "--inject-fail", "boom2", "--fast")
    fx = json.loads((d / "fixes.json").read_text(encoding="utf-8"))["fixes"]
    ov = json.loads((tmp / "overrides.json").read_text(encoding="utf-8"))
    it = next(iter(state_of(d)["issues"].values()), {})
    check("3 fix recorded in fixes.json", any(f["kind"] == "ticker_rename" and f["to"] == "NEWT" for f in fixes_list(fx)))
    check("3 override appended with source scout", any(o.get("source") == "scout" and o.get("value") == "NEWT" for o in ov))
    check("3 owner override untouched", ov[0] == {"target": "s:KEEP", "field": "ticker", "value": "MINE", "source": "owner"})
    check("3 issue says fixed automatically", it.get("fixApplied") is True and "已自动修数据" in it.get("statusText", ""))

    # 4. over budget → no call
    n0 = calls(tmp)
    cfg4 = {**base, "budget": {"caps": {"verify": 0}}}
    rc, log, d = run_loop(tmp, "t4", cfg4, "--cycle", "health", "--inject-fail", "boom", "--fast")
    it = next(iter(state_of(d)["issues"].values()), {})
    check("4 verify cap 0 → no Claude call", calls(tmp) == n0)
    check("4 issue says quota used up", "额度用完" in it.get("statusText", ""), it.get("statusText", ""))

    # 4b. over the day's automatic points (§21) → no call, the issue says so; scout patrol only patrols
    n0 = calls(tmp)
    from zoneinfo import ZoneInfo
    day = datetime.now(ZoneInfo("Australia/Sydney")).date().isoformat()
    (tmp / "t4b").mkdir(parents=True, exist_ok=True)
    (tmp / "t4b" / "claude_usage.json").write_text(json.dumps({"version": 1, "days": {day: {
        "usd": 4.2, "autoUsd": 4.2, "calls": 9, "byKind": {"scout:explain": {"usd": 4.2, "calls": 9}}}}, "calls": []}))
    rc, log, d = run_loop(tmp, "t4b", base, "--cycle", "health", "--inject-fail", "boom", "--fast")
    it = next(iter(state_of(d)["issues"].values()), {})
    hb = json.loads((d / "heartbeat.json").read_text(encoding="utf-8"))
    check("4b automatic points used up → no Claude call", calls(tmp) == n0, log[-300:] if VERBOSE else "")
    check("4b issue says the automatic points are used up", "自动任务今天的额度用完了" in it.get("statusText", ""), it.get("statusText", ""))
    check("4b heartbeat: ≈4.2 / 6 个点, automatic stopped", (hb.get("usage") or {}).get("autoOver") is True
          and "4.2 / 6" in hb["usage"]["say"], str(hb.get("usage"))[:160])

    # 5. single-instance lock
    import fcntl
    lk = tmp / "t5" / "loop"
    lk.mkdir(parents=True)
    with open(lk / "loop.lock", "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        fh.write('{"pid": 1, "mode": "test"}')
        fh.flush()
        rc, log, d = run_loop(tmp, "t5", base, "--once")
    check("5 second instance refuses (exit 3)", rc == 3 and "已经在跑" in log, f"rc={rc}")

    # 6. the scout path: failing step → scout verify task (fake scout CLI via config template) → issue
    (tmp / "fake_scout.py").write_text(FAKE_SCOUT)
    n0 = calls(tmp)
    cfg6 = {"verify": {"via_scout": True}, "health": {"check_server": False},
            "scout": {"verify_cmd": ["{py}", str(tmp / "fake_scout.py"), "{target}", "{question}"]}}
    rc, log, d = run_loop(tmp, "t6", cfg6, "--cycle", "health", "--inject-fail", "boom", "--fast")
    st = state_of(d)
    it = next(iter(st["issues"].values()), {})
    got = json.loads((tmp / "scout_got.json").read_text()) if (tmp / "scout_got.json").exists() else {}
    check("6 scout received an error-type verify task with the log", got.get("target", {}).get("type") == "error"
          and "boom" in got.get("target", {}).get("log", ""), str(got)[:200])
    check("6 no direct Claude call (scout did it)", calls(tmp) == n0)
    check("6 issue carries scout's diagnosis", "侦察兵" in (it.get("diagnosis") or "") and st["claudeLog"][-1].get("via") == "scout",
          str(it.get("diagnosis")))

    # dry-run writes nothing
    rc, log, d = run_loop(tmp, "t7", base, "--dry-run", "--cycle", "close", "--inject-fail", "full_update")
    check("dry-run: no state/heartbeat written", rc == 0 and not (d / "state.json").exists() and not (d / "heartbeat.json").exists())
    check("dry-run: explains the failure path", "会派 Claude" in log and "会等" in log, log[-300:] if VERBOSE else "")


def fixes_list(fx):
    return fx if isinstance(fx, list) else []


def main() -> int:
    test_calendar()
    test_scheduler()
    with tempfile.TemporaryDirectory(prefix="mw-loop-selftest-") as t:
        tmp = Path(t)
        test_misc(tmp)
        test_end_to_end(tmp)
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed" + (": " + ", ".join(r[0] for r in bad) if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
