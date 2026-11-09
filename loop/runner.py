#!/usr/bin/env python3
"""心跳循环 · the loop (DESIGN.md §16) — keeps 钱的天气 alive and sends Claude when something breaks.

    python3 loop/runner.py                      run forever (Ctrl+C / SIGTERM stops it cleanly)
    python3 loop/runner.py --once               run whatever is due now (or a health check), then exit
    python3 loop/runner.py --cycle close        force one cycle now: market | close | nightly | health
    python3 loop/runner.py --dry-run [--cycle X] show the plan; runs nothing, writes nothing, no Claude
    python3 loop/runner.py --status             the heartbeat in plain words
    python3 loop/runner.py --resolve I-1027-ab12  mark an issue in loop/out/issues.md as solved
    python3 loop/runner.py --print-plist        the launchd agent filled in for this machine (installs nothing)
  test hooks: --inject-fail STEP (STEP raises), --fast (1–3 s back-off instead of 30 s/2 min/5 min)

From server.py:   from loop.runner import start_in_thread;  start_in_thread()
Cycles (America/New_York; shown to the owner in their own time zone):
  market  every 15 min while NYSE is open: quick refresh → Polymarket (≤ every 30 min) → scout → health
          (until update.sh has --quick, the plain update runs at most hourly)
  close   16:30 ET (13:30 on early-close days): full update → scenario tracking → Polymarket → scout explain
  nightly 21:00 ET on trading days: scout gap research → graph merge → full-market refresh → Polymarket mapping
  health  hourly when nothing else ran
A step that still fails after retries goes to Claude (scout verify, web tools only) with its log:
data-level fixes are applied automatically, code-level problems land in loop/out/issues.md.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

if __package__ in (None, ""):  # run as a script: import siblings as the `loop` package, never shadow stdlib
    _here = str(Path(__file__).resolve().parent)
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse  # noqa: E402
import atexit  # noqa: E402
import fcntl  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import re  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
from datetime import date, datetime, timedelta  # noqa: E402
from logging.handlers import RotatingFileHandler  # noqa: E402
from xml.sax.saxutils import escape as xml_escape  # noqa: E402
from zoneinfo import ZoneInfo  # noqa: E402

from loop import calendar_ny as cal  # noqa: E402
from loop import settings  # noqa: E402
from loop import usage  # noqa: E402
from loop.budget import Budget  # noqa: E402
from loop.fixes import Issues, apply_fix, atomic_json, atomic_write, key_line  # noqa: E402
from loop.scout_bridge import ScoutBridge, run_verify, step_prompt, tickers_prompt  # noqa: E402
from loop.steps import STEPS, FailingStep, Outcome, ShellStep  # noqa: E402

HEARTBEAT_PATH = settings.HEARTBEAT_PATH  # the constant the integrator points at web/data/heartbeat.json
CYCLE_ZH = {"market": "盘中轮", "close": "收盘轮", "nightly": "夜间轮", "health": "体检轮"}
PRIORITY = ["close", "market", "nightly", "health"]
REMEDIABLE = {"stale", "meta_missing", "meta_broken", "output_missing", "output_broken", "output_empty",
              "partial_after_close", "filled_close"}
REMEDIABLE_WARN = {"partial_after_close", "filled_close"}   # warnings, but the fix is the same: one full update
LEVELS = {"transient", "data", "code", "env"}

log = logging.getLogger("loop")


def setup_logging(to_file: bool = True) -> logging.Logger:
    if getattr(log, "_mw_setup", False):
        return log
    log.setLevel(logging.INFO)
    log.propagate = False
    fmt = logging.Formatter("%(asctime)s [loop] %(levelname)s %(message)s", "%m-%d %H:%M:%S")
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    if to_file:
        settings.OUT_DIR.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(settings.LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
    log._mw_setup = True  # type: ignore[attr-defined]
    return log


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def _last_line(text: str | None) -> str:
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return lines[-1].strip() if lines else ""


def _parse(x) -> datetime | None:
    if not x:
        return None
    try:
        d = datetime.fromisoformat(str(x))
        return d if d.tzinfo else d.replace(tzinfo=cal.NY)
    except ValueError:
        return None


class Runner:
    def __init__(self, cfg: dict | None = None, *, mode: str = "standalone", dry_run: bool = False,
                 inject_fail=(), fast: bool = False, clock=None, steps: dict | None = None):
        self.cfg = cfg or settings.load_config()
        self.mode = mode
        self.dry_run = dry_run
        self.inject_fail = set(inject_fail or ())
        self.clock = clock or (lambda: datetime.now(cal.NY))
        self.steps = dict(steps or STEPS)
        for name in (self.cfg.get("commands") or {}):  # any extra command list in config becomes a step
            if name not in self.steps and not name.startswith("_"):
                title = ((self.cfg.get("steps") or {}).get(name) or {}).get("title") or name
                self.steps[name] = ShellStep(name, title)
        self.log = log
        self.stop_event = threading.Event()
        self._child = None
        self._child_lock = threading.Lock()
        self._lock_fh = None
        self.state = self._load_state()
        self.issues = Issues(self.state)
        b = self.cfg.get("budget") or {}
        self.budget = Budget(settings.BUDGET_PATH, b.get("caps", {}), b.get("parents", {}), clock=self.clock)
        self.bridge = ScoutBridge(self.cfg)
        self.backoff = [1, 2, 3] if fast else [float(x) for x in (self.cfg.get("backoff_s") or [30, 120, 300])]
        self.cycle: dict = {}
        self.current: dict | None = None
        self._last_hb = 0.0
        self.last_tick: float | None = None    # the loop thread proved it is alive (tick, step, subprocess poll)
        self._crashes: list[float] = []
        try:
            self.owner_tz = ZoneInfo(self.cfg.get("owner_tz") or "Australia/Sydney")
        except Exception:  # noqa: BLE001
            self.owner_tz = datetime.now().astimezone().tzinfo

    # ── time helpers ──────────────────────────────────────────────────────────────────────────────
    def now(self) -> datetime:
        return self.clock().astimezone(cal.NY)

    def owner_fmt(self, x) -> str:
        d = x if isinstance(x, datetime) else _parse(x)
        if not d:
            return "—"
        o = d.astimezone(self.owner_tz)
        return f"{o.month}月{o.day}日 {o:%H:%M}"

    def both_fmt(self, d: datetime) -> str:
        return f"你那边 {self.owner_fmt(d)}（纽约 {d.astimezone(cal.NY):%H:%M}）"

    # ── state ─────────────────────────────────────────────────────────────────────────────────────
    def _load_state(self) -> dict:
        try:
            s = json.loads(settings.STATE_PATH.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            s = {}
        for k, v in (("sched", {}), ("stepLast", {}), ("issues", {}), ("claudeLog", []), ("recent", []),
                     ("tickerFail", {}), ("tickerVerified", {})):
            s.setdefault(k, v)
        return s

    def save_state(self) -> None:
        if not self.dry_run:
            self.issues.prune()
            atomic_json(settings.STATE_PATH, self.state)

    # ── single-instance lock ──────────────────────────────────────────────────────────────────────
    def acquire_lock(self) -> tuple[bool, str | None]:
        settings.OUT_DIR.mkdir(parents=True, exist_ok=True)
        fh = open(settings.LOCK_PATH, "a+")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fh.seek(0)
            holder = fh.read().strip()[:200]
            fh.close()
            return False, holder or "?"
        fh.seek(0)
        fh.truncate()
        fh.write(json.dumps({"pid": os.getpid(), "mode": self.mode, "since": _iso(self.now())}))
        fh.flush()
        self._lock_fh = fh
        return True, None

    def release_lock(self) -> None:
        if self._lock_fh:
            try:
                fcntl.flock(self._lock_fh.fileno(), fcntl.LOCK_UN)
                self._lock_fh.close()
            except OSError:
                pass
            self._lock_fh = None

    # ── subprocesses ──────────────────────────────────────────────────────────────────────────────
    def _set_child(self, p) -> None:
        with self._child_lock:
            self._child = p

    def run_cmd(self, argv: list[str], name: str, timeout: float = 1800) -> tuple[int, str, int]:
        """Run argv in the project root; output appended to loop/out/steps/<name>.log. → (rc, output, ms)."""
        settings.STEP_LOG_DIR.mkdir(parents=True, exist_ok=True)
        lp = settings.STEP_LOG_DIR / f"{name}.log"
        if lp.exists() and lp.stat().st_size > 2_000_000:
            lp.write_text("", encoding="utf-8")
        t0 = time.time()
        with open(lp, "a", encoding="utf-8") as fh:
            fh.write(f"\n===== {self.now():%Y-%m-%d %H:%M:%S} ET  $ {' '.join(argv)}\n")
            fh.flush()
            start = fh.tell()
            env = dict(os.environ, PYTHONUNBUFFERED="1", MW_LOOP_RUN="1")
            try:
                p = subprocess.Popen(argv, cwd=str(settings.ROOT), stdout=fh, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, env=env, start_new_session=True)
            except OSError as e:
                fh.write(f"cannot start: {e}\n")
                return 127, f"cannot start: {e}", 0
            self._set_child(p)
            rc = None
            try:
                while rc is None:
                    self.last_tick = time.time()
                    try:
                        rc = p.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        if self.stop_event.is_set() or time.time() - t0 > timeout:
                            why = "loop 正在停止" if self.stop_event.is_set() else f"超时 {int(timeout)}s"
                            fh.write(f"\n[loop] 停掉子进程：{why}\n")
                            self._kill(p)
                            rc = -9
            finally:
                self._set_child(None)
            fh.write(f"===== exit {rc} in {time.time() - t0:.1f}s\n")
        try:
            with open(lp, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(start)
                out = fh.read()[-20000:]
        except OSError:
            out = ""
        out = re.sub(r"\n?===== exit [^\n]*\s*$", "", out.rstrip())   # the loop's own marker is not the step's output
        return rc, out, int((time.time() - t0) * 1000)

    @staticmethod
    def _kill(p) -> None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(timeout=10)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=5)
            except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
                pass

    def _step_log_tail(self, *names: str, n: int = 40) -> str:
        for nm in names:
            p = settings.STEP_LOG_DIR / f"{nm}.log"
            if p.exists():
                lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
                return "\n".join(lines[-n:])
        return ""

    # ── schedule ──────────────────────────────────────────────────────────────────────────────────
    def _cy(self, name: str) -> dict:
        return (self.cfg.get("cycles") or {}).get(name) or {}

    def _close_at(self, d: date) -> datetime | None:
        s = cal.session(d)
        return s[1] + timedelta(minutes=int(self._cy("close").get("after_close_min", 30))) if s else None

    def _night_at(self, d: date) -> datetime | None:
        if not cal.is_trading_day(d):
            return None
        hh, mm = (int(x) for x in str(self._cy("nightly").get("at", "21:00")).split(":"))
        return datetime(d.year, d.month, d.day, hh, mm, tzinfo=cal.NY)

    def _market_slots(self, d: date) -> list[datetime]:
        s = cal.session(d)
        if not s:
            return []
        every = timedelta(minutes=int(self._cy("market").get("every_min", 15)))
        out, t = [], s[0] + every
        while t <= s[1]:
            out.append(t)
            t += every
        return out

    def _current_slot(self, now: datetime) -> datetime | None:
        every = timedelta(minutes=int(self._cy("market").get("every_min", 15)))
        cur = [s for s in self._market_slots(now.date()) if s <= now < s + every]
        return cur[-1] if cur else None

    def _latest_day(self, now: datetime, at_fn) -> date | None:
        d = now.date()
        for _ in range(12):
            t = at_fn(d)
            if t is not None and t <= now:
                return d
            d -= timedelta(days=1)
        return None

    def _next_at(self, now: datetime, at_fn) -> datetime | None:
        d = now.date()
        for _ in range(20):
            t = at_fn(d)
            if t is not None and t > now:
                return t
            d += timedelta(days=1)
        return None

    def due(self, now: datetime) -> list[str]:
        S = self.state["sched"]
        out = []
        if self._cy("close").get("enabled", True):
            D = self._latest_day(now, self._close_at)
            if D and (S.get("close_day") or "") < D.isoformat():
                out.append("close")
        if self._cy("market").get("enabled", True):
            slot = self._current_slot(now)
            if slot and S.get("market_slot") != _iso(slot):
                out.append("market")
        if self._cy("nightly").get("enabled", True):
            D = self._latest_day(now, self._night_at)
            if (D and (S.get("nightly_day") or "") < D.isoformat()
                    and (S.get("close_day") or "") >= D.isoformat() and not cal.is_open(now)):
                out.append("nightly")
        if self._cy("health").get("enabled", True):
            last = _parse(S.get("last_any"))
            if not last or now - last >= timedelta(minutes=int(self._cy("health").get("every_min", 60))):
                out.append("health")
        return sorted(out, key=PRIORITY.index)

    def next_due(self, now: datetime) -> tuple[str, datetime] | None:
        due = self.due(now)
        if due:
            return due[0], now
        S = self.state["sched"]
        cands: list[tuple[datetime, int, str]] = []
        if self._cy("close").get("enabled", True):
            t = self._next_at(now, self._close_at)
            if t:
                cands.append((t, 0, "close"))
        if self._cy("market").get("enabled", True):
            t = self._next_at(now, lambda d: next((s for s in self._market_slots(d) if s > now), None))
            if t:
                cands.append((t, 1, "market"))
        if self._cy("nightly").get("enabled", True):
            t = self._next_at(now, self._night_at)
            if t:
                cands.append((t, 2, "nightly"))
        if self._cy("health").get("enabled", True):
            last = _parse(S.get("last_any")) or now
            cands.append((last + timedelta(minutes=int(self._cy("health").get("every_min", 60))), 3, "health"))
        if not cands:
            return None
        t, _, n = min(cands)
        return n, t

    def seed_first_start(self, now: datetime) -> None:
        """First run ever: don't redo today's close or kick a heavy nightly if the data is already fresh."""
        S = self.state["sched"]
        if "close_day" not in S:
            D = self._latest_day(now, self._close_at)
            as_of = None
            try:
                as_of = json.loads((settings.WEB_DATA / "meta.json").read_text(encoding="utf-8")).get("asOf")
            except Exception:  # noqa: BLE001
                pass
            if D and as_of and str(as_of)[:10] >= D.isoformat():
                S["close_day"] = D.isoformat()
                self.log.info("首次启动：数据已经是 %s 收盘的，收盘轮记为已完成", as_of)
            else:
                S["close_day"] = ""
        if "nightly_day" not in S:
            D = self._latest_day(now, self._night_at)
            S["nightly_day"] = D.isoformat() if D else ""
            self.log.info("首次启动：夜间轮从下一个交易日晚上开始（不在启动时跑全市场）")

    # ── one cycle ─────────────────────────────────────────────────────────────────────────────────
    def run_cycle(self, name: str, forced: bool = False) -> bool:
        now = self.now()
        t0 = time.time()
        self.cycle = {"name": name, "health": None, "results": [], "updated": False, "startedAt": _iso(now)}
        names = list(self._cy(name).get("steps") or ["health"])
        for f in sorted(self.inject_fail):
            if f not in names:
                names.insert(len(names) - 1 if names and names[-1] == "health" else len(names), f)
        tag = "[dry-run] " if self.dry_run else ""
        self.log.info("%s━━ %s开始 · %s%s", tag, CYCLE_ZH.get(name, name), self.both_fmt(now),
                      "（手动触发）" if forced else "")
        for sn in names:
            if self.stop_event.is_set():
                break
            step = self.steps.get(sn) or (FailingStep(sn) if sn in self.inject_fail else None)
            if step is None:
                self.log.warning("  · %s：没有这个步骤（config 写错了？）跳过", sn)
                self.cycle["results"].append({"name": sn, "title": sn, "ok": True, "skipped": True, "ms": 0,
                                              "at": _iso(self.now()), "note": "没有这个步骤"})
                continue
            self.cycle["results"].append(self.run_step(step))
        if self.cycle.get("health") and not self.stop_event.is_set():
            self.after_health(self.cycle["health"])
        if not self.stop_event.is_set():
            self.maybe_verify_tickers()
        res = self.cycle["results"]
        ok = all(r["ok"] or r.get("skipped") for r in res)
        end = self.now()
        ms = int((time.time() - t0) * 1000)
        fails = [r for r in res if not r["ok"] and not r.get("skipped")]
        say = ("被停止，没跑完" if self.stop_event.is_set() else
               "全部顺利" if ok else "出错：" + "、".join(r["title"] for r in fails))
        self.log.info("%s━━ %s结束 · %.1fs · %s", tag, CYCLE_ZH.get(name, name), ms / 1000, say)
        if self.dry_run:
            return ok
        S = self.state["sched"]
        if self.stop_event.is_set():
            # interrupted: keep the schedule untouched so this cycle runs again after a restart
            self.state["recent"] = (self.state["recent"] + [{"name": name, "startedAt": _iso(now), "ok": ok, "ms": ms,
                                                             "say": "被停止，没跑完"}])[-20:]
            self.current = None
            self.save_state()
            return ok
        if name == "close":
            D = self._latest_day(end, self._close_at)
            S["close_day"] = (D or end.date()).isoformat()
        elif name == "nightly":
            D = self._latest_day(end, self._night_at)
            S["nightly_day"] = (D or end.date()).isoformat()
        if name == "market" or self.cycle["updated"]:
            slot = self._current_slot(end) or self._current_slot(now)
            if slot:
                S["market_slot"] = _iso(slot)
        S["last_any"] = _iso(end)
        S.setdefault("last", {})[name] = _iso(end)
        self.state["lastCycle"] = {"name": name, "nameZh": CYCLE_ZH.get(name, name), "startedAt": _iso(now),
                                   "endedAt": _iso(end), "ok": ok, "ms": ms, "say": say, "forced": forced,
                                   "steps": res}
        self.state["recent"] = (self.state["recent"] + [{"name": name, "startedAt": _iso(now), "ok": ok, "ms": ms,
                                                         "say": say}])[-20:]
        self.current = None
        self.save_state()
        self.write_issues_md()
        self.write_heartbeat()
        return ok

    def run_step(self, step) -> dict:
        c = (self.cfg.get("steps") or {}).get(step.name) or {}
        attempts = 1 + max(0, int(c.get("retries", 1)))
        started = self.now()
        self.last_tick = time.time()
        self.current = {"cycle": self.cycle.get("name"), "step": step.name, "title": step.title, "since": _iso(started)}
        if not self.dry_run:
            self.write_heartbeat()
        t0 = time.time()
        out: Outcome = Outcome(False, error="没跑")
        a = 0
        for a in range(1, attempts + 1):
            try:
                if step.name in self.inject_fail:
                    raise RuntimeError(f"模拟故障：{step.name} 抛出异常（--inject-fail 测试）")
                out = step.run(self)
            except Exception as e:  # noqa: BLE001
                tb = traceback.format_exc(limit=6)
                out = Outcome(False, note=f"{type(e).__name__}: {e}"[:140], error=tb, tail=tb,
                              cmd=f"(python) loop step {step.name}")
            if out.ok or out.skipped or not out.retryable or self.stop_event.is_set():
                break
            if a < attempts:
                wait = self.backoff[min(a - 1, len(self.backoff) - 1)]
                if self.dry_run:
                    self.log.info("  [dry-run] %s 失败（%s）→ 会等 %ss 后重试（共 %d 次）", step.name,
                                  (out.note or out.error)[:80], int(wait), attempts)
                    continue
                self.log.warning("  ✗ %s 失败（%s），%ss 后第 %d/%d 次重试", step.name,
                                 (out.note or key_line(out.error))[:100],
                                 int(wait), a + 1, attempts)
                if self.stop_event.wait(wait):
                    break
        ms = int((time.time() - t0) * 1000)
        busy = out.busy and not out.ok
        interrupted = not out.ok and self.stop_event.is_set()
        if interrupted:
            out = Outcome(False, skipped=True, note="loop 正在停止，这步没跑完（重启后会重跑）")
        r = {"name": step.name, "title": step.title, "ok": bool(out.ok) or busy, "skipped": bool(out.skipped) or busy,
             "ms": ms, "at": _iso(self.now()), "attempts": a, "note": out.note or ("" if out.ok else "失败")}
        if not out.ok and not busy:
            r["error"] = (key_line(out.error) or out.note)[:200]
        mark = "·" if r["skipped"] else ("✓" if r["ok"] else "✗")
        self.log.info("  %s %-15s %6.1fs  %s", mark, step.name, ms / 1000, r["note"])
        if self.dry_run:
            if not r["ok"] and not getattr(step, "self_reporting", False):
                self.on_failure(step.name, step.title, out, a)
            return r
        sl = self.state["stepLast"].setdefault(step.name, {})
        sl.update(ok=r["ok"], at=r["at"], ms=ms, note=r["note"], skipped=r["skipped"])
        if r["ok"] and not r["skipped"]:
            sl["okAt"] = r["at"]
            sl.pop("error", None)
            if step.name in ("quick_refresh", "full_update"):
                self.cycle["updated"] = True
            for it in self.issues.resolve_step(step.name, self.now()):
                self.log.info("  ✅ 问题 %s 已自愈（%s 又跑通了）", it["id"], step.name)
        elif not r["ok"]:
            sl["error"] = r.get("error")
            if not self.stop_event.is_set() and not getattr(step, "self_reporting", False):
                self.on_failure(step.name, step.title, out, a)
        self.save_state()
        return r

    # ── failed tickers (fed by UpdateStep) ────────────────────────────────────────────────────────
    def note_failed_tickers(self, failed: list[str]) -> None:
        if self.dry_run:
            return
        today = self.now().date().isoformat()
        self.state["lastFailedTickers"] = list(failed)
        tf = self.state["tickerFail"]
        for t in list(tf):
            if t not in failed:
                tf.pop(t)
        for t in failed:
            days = tf.setdefault(t, [])
            if today not in days:
                days.append(today)
            tf[t] = days[-5:]

    # ── health → remediation → Claude ─────────────────────────────────────────────────────────────
    def after_health(self, h: dict) -> None:
        hcfg = self.cfg.get("health") or {}
        fails = [p for p in h["problems"] if p["level"] == "fail"]
        codes = {p["code"] for p in fails} | {p["code"] for p in h["problems"] if p["code"] in REMEDIABLE_WARN}
        S = self.state["sched"]
        if codes & REMEDIABLE and not self.cycle.get("updated"):
            last = _parse(S.get("last_remediation"))
            gap = timedelta(minutes=int(hcfg.get("remediate_every_min", 120)))
            if self.dry_run:
                self.log.info("  [dry-run] 体检发现 %s → 会先自己补救：跑一次完整更新再复查", "、".join(sorted(codes & REMEDIABLE)))
            elif not last or self.now() - last >= gap:
                S["last_remediation"] = _iso(self.now())
                self.log.info("  体检发现 %s → 先自己补救：跑一次完整更新", "、".join(sorted(codes & REMEDIABLE)))
                r = self.run_step(self.steps["full_update"])
                self.cycle["results"].append(r)
                if r["ok"] and not r["skipped"]:
                    h = self.steps["health"].run(self).data
                    self.cycle["health"] = h
                    fails = [p for p in h["problems"] if p["level"] == "fail"]
                    self.log.info("  复查：%s", "好了" if not fails else "；".join(p["say"] for p in fails))
            else:
                self.log.info("  体检发现 %s，但 %s 刚补救过，先不重复更新", "、".join(sorted(codes)), self.owner_fmt(last))
        self.state["lastHealth"] = {"at": _iso(self.now()), "worst": "fail" if fails else h.get("worst"),
                                    "facts": h.get("facts"), "problems": h.get("problems")}
        if self.dry_run:
            for p in fails:
                self.on_failure(f"health:{p['code']}", p["say"], Outcome(False, error=p["say"]), 1)
            return
        present = {f"health:{p['code']}" for p in fails}
        for it in self.issues.open_list():
            if it["step"].startswith("health:") and it["step"] not in present:
                it.update(status="resolved", resolvedAt=_iso(self.now()), resolvedBy="auto", statusText="已自愈：体检不再报这个")
                self.log.info("  ✅ 问题 %s 已自愈（%s）", it["id"], it["step"])
        for p in fails:
            tail = self._step_log_tail("full_update", "quick_refresh") if p["code"] in REMEDIABLE | {"failed_tickers"} else ""
            out = Outcome(False, note=p["say"], error=f"{p['say']}\n{p.get('detail', '')}", cmd="loop health check",
                          tail=tail)
            self.on_failure(f"health:{p['code']}", p["say"], out, 1)

    def on_failure(self, step: str, title: str, out: Outcome, attempts: int) -> None:
        now = self.now()
        if self.dry_run:
            left = self.budget.left("verify")
            self.log.info("  [dry-run] %s 重试后仍失败 → 会派 Claude 诊断（verify 今天还剩 %d 次）→ 数据问题自动修 / 代码问题写进 %s",
                          step, left, settings.ISSUES_MD.relative_to(settings.ROOT) if settings.ISSUES_MD.is_relative_to(settings.ROOT) else settings.ISSUES_MD)
            return
        it = self.issues.touch(step, title, out.error or out.note or "失败", now, cmd=out.cmd or None, rc=out.rc)
        vcfg = self.cfg.get("verify") or {}
        prev = _parse(it.get("verifiedAt"))
        if prev and now - prev < timedelta(hours=float(vcfg.get("dedupe_hours", 24))):
            it["statusText"] = (f"又出现了（第 {it['count']} 次）；Claude {self.owner_fmt(prev)} 查过：{it.get('diagnosis') or '—'}")
            self.log.info("  ↺ 问题 %s 24 小时内已让 Claude 查过，不重复花额度", it["id"])
            self.write_issues_md()
            return
        asked = _parse(it.get("askedAt"))
        if asked and not prev and now - asked < timedelta(hours=float(vcfg.get("retry_failed_ask_hours", 3))):
            self.log.info("  ↺ 问题 %s：上次找 Claude 没查成（%s），过几小时再试", it["id"], self.owner_fmt(asked))
            self.write_issues_md()
            return
        pts_ok, pts_why = usage.can_spend(auto=True)
        if not pts_ok:
            it["statusText"] = f"还没诊断：{pts_why}（或者你直接看下面的错误）"
            self.log.warning("  💸 %s 失败，但%s，只记进 issues.md", step, pts_why)
            self.write_issues_md()
            return
        if not self.budget.try_spend("verify", 1, note=step):
            it["statusText"] = "还没诊断：今天 Claude 额度用完了，明天再查（或者你直接看下面的错误）"
            self.log.warning("  💸 %s 失败，但今天 Claude 额度（verify/global）用完了，只记进 issues.md", step)
            self.write_issues_md()
            return
        self.log.info("  🔎 派 Claude 去查 %s 为什么失败（问题 %s）…", step, it["id"])
        it["statusText"] = "Claude 正在查…"
        it["askedAt"] = _iso(now)
        self.current = {"cycle": self.cycle.get("name"), "step": f"claude:verify:{step}", "title": "Claude 诊断中",
                        "since": _iso(now)}
        self.write_heartbeat()
        rel = lambda t: (t or "").replace(str(settings.ROOT) + "/", "")  # noqa: E731  (shorter, no home path)
        err = rel(key_line(out.error) or out.note)
        tail = rel(out.tail or out.error or "")[-int(vcfg.get("max_log_chars", 2500)):]
        prompt = step_prompt(step, title, rel(out.cmd or ""), out.rc, attempts, err, tail, f"{now:%Y-%m-%d %H:%M}")
        question = (f"「钱的天气」后台步骤 {step}（{title}）重试 {attempts} 次后还是失败：{err[:120]}。"
                    "是外部临时故障、数据问题（如股票改名退市），还是代码/环境要改？")
        res, spent = run_verify(self.bridge, self.cfg, prompt=prompt, question=question, key=f"verify:loop:{it['sig']}"[:200],
                                target={"type": "error", "step": step, "cmd": rel(out.cmd or ""), "rc": out.rc,
                                        "log": tail[-1500:]},
                                run_cmd=self.run_cmd, stop_event=self.stop_event, on_proc=self._set_child)
        entry = {"at": _iso(self.now()), "kind": "verify", "target": step, "issue": it["id"],
                 "ask": f"{title}为什么失败", "ok": res.ok, "ms": res.ms,
                 "via": (res.data or {}).get("via", "loop") if res.ok else None}
        if not spent or (not res.ok and ("找不到 claude" in res.error or "启动 claude 失败" in res.error)):
            self.budget.refund("verify", 1, note="这次没真正调用 Claude")
        if not res.ok:
            it["statusText"] = f"Claude 没查成（{res.error[:80]}），先记下来"
            entry["found"] = res.error[:200]
            self.log.warning("  🔎 Claude 没查成：%s", res.error[:200])
        else:
            d = res.data or {}
            level = d.get("level") if d.get("level") in LEVELS else "unknown"
            src = [s for s in (d.get("sources") or []) if isinstance(s, str)]
            it.update(level=level, diagnosis=str(d.get("diagnosis") or "")[:200], issue=d.get("issue") or {},
                      sources=src[:5], conf=d.get("conf"), fix=d.get("fix"), verifiedAt=_iso(self.now()))
            entry.update(found=it["diagnosis"], level=level, sources=src[:3])
            if level == "data":
                applied, note = apply_fix(d.get("fix"), why=it["diagnosis"], sources=src,
                                          conf=float(d.get("conf") or 0.5), now=self.now())
                it["fixResult"] = note
                it["fixApplied"] = applied
                entry["applied"] = note if applied else None
                if applied:
                    it["statusText"] = "已自动修数据：" + note
                elif (d.get("fix") or {}).get("kind") in (None, "", "none", "rerun"):
                    it["statusText"] = "数据问题，没有能自动用的修法，已写进 issues.md 等你处理"
                else:
                    it["statusText"] = "数据问题，没能自动修：" + note
                if not applied and "不认识" in note:
                    it["level"] = "unknown"
                self.log.info("  🔧 %s", it["statusText"])
            elif level == "transient":
                it["statusText"] = "外部临时故障，下轮自动重试"
                self.log.info("  ⏳ Claude 判断是临时故障：%s", it["diagnosis"])
            else:
                it["statusText"] = "需要改代码/环境，已写进 issues.md 等你处理"
                self.log.warning("  📝 Claude 判断要改%s：%s → 写进 issues.md", "代码" if level == "code" else "环境", it["diagnosis"])
        self.state["claudeLog"] = (self.state["claudeLog"] + [entry])[-30:]
        self.save_state()
        self.write_issues_md()

    def maybe_verify_tickers(self) -> None:
        """Tickers that returned no data on ≥ N different days → one batched Claude lookup per day."""
        if self.dry_run:
            return
        hcfg = self.cfg.get("health") or {}
        need = int(hcfg.get("ticker_fail_streak", 2))
        S = self.state["sched"]
        today = self.now().date().isoformat()
        cands = [t for t, days in self.state["tickerFail"].items()
                 if len(days) >= need and t not in self.state["tickerVerified"]]
        if not cands or S.get("ticker_verify_day") == today:
            return
        pts_ok, pts_why = usage.can_spend(auto=True)
        if not pts_ok:
            self.log.info("  💸 %d 只股票连续拿不到数据，但%s", len(cands), pts_why)
            return
        if not self.budget.try_spend("verify", 1, note="tickers"):
            self.log.info("  💸 %d 只股票连续拿不到数据，但今天 Claude 额度用完了", len(cands))
            return
        S["ticker_verify_day"] = today
        batch = cands[: int(hcfg.get("max_tickers_per_verify", 8))]
        self.log.info("  🔎 派 Claude 查 %d 只连续拿不到数据的股票：%s", len(batch), " ".join(batch))
        res, spent = run_verify(self.bridge, self.cfg, prompt=tickers_prompt(batch, today),
                                target={"type": "tickers", "tickers": batch,
                                        "details": {t: "连续几天 yfinance 拿不到日线" for t in batch}},
                                question="这些代码为什么从 yfinance 拿不到数据？改名、退市、被并购还是临时故障？",
                                key=f"verify:tickers:{','.join(sorted(batch))}", run_cmd=self.run_cmd,
                                stop_event=self.stop_event, on_proc=self._set_child)
        if not spent:
            self.budget.refund("verify", 1, note="这次没真正调用 Claude")
        entry = {"at": _iso(self.now()), "kind": "verify", "target": " ".join(batch), "ask": "这些代码是不是改名/退市了",
                 "ok": res.ok, "ms": res.ms}
        found = []
        if res.ok:
            d = res.data or {}
            items = d.get("tickers")
            if items is None:  # scout's shape: per-ticker fixes
                st_map = {"ticker-rename": "renamed", "ticker-delisted": "delisted", "ticker-merged": "merged",
                          "data-ok": "temporary"}
                items = [{"t": f.get("ticker"), "status": st_map.get(f.get("type"), "unknown"), "newTicker": f.get("new"),
                          "say": f.get("say"), "sources": d.get("sources"), "conf": d.get("conf")}
                         for f in d.get("scoutFixes") or []]
            for item in items or []:
                t = str(item.get("t") or "").upper()
                if t not in batch:
                    continue
                st = item.get("status")
                self.state["tickerVerified"][t] = {"at": _iso(self.now()), "status": st, "say": item.get("say")}
                conf = float(item.get("conf") or 0.5)
                note = ""
                if st == "renamed" and item.get("newTicker"):
                    _, note = apply_fix({"kind": "ticker_rename", "from": t, "to": item["newTicker"]},
                                        why=item.get("say") or "", sources=item.get("sources"), conf=conf, now=self.now())
                elif st in ("delisted", "merged") and conf >= 0.6:
                    _, note = apply_fix({"kind": "ticker_drop", "from": t}, why=item.get("say") or "",
                                        sources=item.get("sources"), conf=conf, now=self.now())
                found.append(f"{t}: {item.get('say') or st}" + (f"（{note}）" if note else ""))
            entry["found"] = "；".join(found)[:400] or (d.get("diagnosis") or "没结论")
        else:
            entry["found"] = res.error[:200]
        self.log.info("  🔎 股票代码核查：%s", entry["found"])
        self.state["claudeLog"] = (self.state["claudeLog"] + [entry])[-30:]
        self.save_state()

    # ── outputs ───────────────────────────────────────────────────────────────────────────────────
    def write_issues_md(self) -> None:
        if self.dry_run:
            return
        text = self.issues.render_md(self.owner_fmt)
        try:
            old = settings.ISSUES_MD.read_text(encoding="utf-8")
        except FileNotFoundError:
            old = None
        # ignore the "updated at" line when deciding whether anything changed
        strip = lambda s: "\n".join(s.splitlines()[3:]) if s else s  # noqa: E731
        if old is None or strip(old) != strip(text):
            atomic_write(settings.ISSUES_MD, text)

    def heartbeat(self, stopped: bool = False) -> dict:
        now = self.now()
        fresh = self._data_freshness()
        nx = None if stopped else self.next_due(now)
        last = self.state.get("lastCycle")
        lh = self.state.get("lastHealth") or {}
        facts = lh.get("facts") or {}
        bud = self.budget.status()
        open_issues = self.issues.for_heartbeat()
        fails = [p for p in (lh.get("problems") or []) if p["level"] == "fail"]
        warns = [p for p in (lh.get("problems") or []) if p["level"] == "warn"]
        last_fail = [s for s in (last or {}).get("steps", []) if not s["ok"] and not s.get("skipped")]
        if fails or last_fail:
            status = "red"
            what = fails[0]["say"] if fails else f"{last_fail[0]['title']}失败"
            sent = any(i.get("level") not in (None, "unknown") or "Claude" in (i.get("statusText") or "")
                       for i in open_issues)
            say = f"出问题了：{what}" + ("（已派 Claude 查过，详情看问题列表）" if sent else "")
        elif warns or open_issues:
            status = "amber"
            say = "小毛病：" + (warns[0]["say"] if warns else open_issues[0]["title"])
        elif not last:
            status = "amber"
            say = "刚启动，还没跑完第一轮"
        else:
            status = "green"
            say = f"数据新鲜（{facts.get('asOf', '?')} 收盘），一切正常"
            live = fresh
            if live.get("partial"):
                p = live["partial"]
                say = (f"数据新鲜（{live.get('asOf') or facts.get('asOf', '?')} 盘中，截至纽约 {p.get('etTime') or '?'}"
                       + (f"／你那边 {p['localTime']}" if p.get("localTime") else "") + "），一切正常")
            elif live.get("asOf"):
                say = f"数据新鲜（{live['asOf']} 收盘），一切正常"
        if stopped:
            status, say = "amber", "心跳循环停了（页面照常能看，但数据不会自己更新）"
        mk = cal.status(now)
        nxt = None
        if nx:
            name, at = nx
            mins = max(0, int((at - now).total_seconds() // 60))
            nxt = {"name": name, "nameZh": CYCLE_ZH.get(name, name), "at": _iso(at),
                   "atLocal": _iso(at.astimezone(self.owner_tz)), "inMin": mins,
                   "say": f"下一轮：{CYCLE_ZH.get(name, name)}，" + ("马上" if mins == 0 else self.both_fmt(at))}
        steps = [{k: s.get(k) for k in ("name", "title", "ok", "ms", "at", "skipped", "note", "error", "attempts")}
                 for s in (last or {}).get("steps", [])]
        # updatedAt = when the loop thread last proved it is alive (a tick, a step, a subprocess poll), not the
        # time of this request — otherwise the page's "心跳 N 分钟没跳了" check could never fire while the thread
        # object exists. generatedAt = when this answer was made.
        tick = datetime.fromtimestamp(self.last_tick, cal.NY) if self.last_tick else now
        if tick > now:
            tick = now
        return {
            "version": 1, "updatedAt": _iso(tick), "updatedAtLocal": _iso(tick.astimezone(self.owner_tz)),
            "lastTickAt": _iso(tick) if self.last_tick else None, "generatedAt": _iso(now),
            "data": fresh,
            "pid": os.getpid(), "mode": self.mode, "state": "stopped" if stopped else ("busy" if self.current else "idle"),
            "running": None if stopped else self.current,
            "status": status, "statusSay": say,
            "lastCycle": {k: v for k, v in (last or {}).items() if k != "steps"} or None,
            "nextCycle": nxt, "steps": steps,
            "stepsLatest": self.state.get("stepLast", {}),
            # caps: only real count brakes (999 = unlimited since the §21 amendment is left out, so the 💓 sheet
            # shows "N 次" instead of "N/999"); the real limit is "usage" — today's points of the weekly quota
            "claudeCallsToday": bud["today"], "caps": {k: v for k, v in bud["caps"].items() if v < 999},
            "budget": bud, "scout": self._scout_usage(), "usage": usage.status(),
            "claude": list(reversed(self.state.get("claudeLog", [])[-10:])),
            "issues": open_issues, "issuesFile": str(settings.ISSUES_MD),
            "health": {"worst": lh.get("worst"), "at": lh.get("at"), "facts": facts,
                       "problems": [p for p in (lh.get("problems") or []) if p["level"] != "info"][:8]},
            "market": {**mk, "opensAtLocal": self.owner_fmt(mk.get("opensAt")) if mk.get("opensAt") else None},
            "recent": list(reversed(self.state.get("recent", [])[-12:])),
            "ownerTz": str(self.owner_tz),
        }

    def _data_freshness(self) -> dict:
        """meta.json right now (the last health check can be up to an hour old): asOf + the intraday bar, if any."""
        try:
            m = json.loads((settings.WEB_DATA / "meta.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}
        out = {"asOf": m.get("asOf")}
        p = m.get("partial")
        if isinstance(p, dict) and p.get("date"):
            et = str(p.get("fetchedAt") or "")
            out["partial"] = {"date": p.get("date"), "etTime": et[11:16] if len(et) >= 16 else None,
                              "localTime": (m.get("intraday") or {}).get("localTime")}
        return out

    def _scout_usage(self) -> dict | None:
        """Scout's own counters (its queue file), read defensively — the 🔎 panel shows both."""
        p = settings.ROOT / "scout" / "out" / "queue.json"
        try:
            st = json.loads(p.read_text(encoding="utf-8"))
            u = (st.get("usage") or {}).get(self.now().date().isoformat()) or {}
            tasks = st.get("tasks") or []
            return {"callsToday": u.get("_all", 0), "byKind": {k: v for k, v in u.items() if not k.startswith("_")},
                    "queued": sum(1 for t in tasks if t.get("state") == "queued"),
                    "running": sum(1 for t in tasks if t.get("state") == "running")}
        except Exception:  # noqa: BLE001
            return None

    def write_heartbeat(self, stopped: bool = False) -> None:
        if self.dry_run:
            return
        try:
            atomic_json(HEARTBEAT_PATH, self.heartbeat(stopped=stopped))
            self._last_hb = time.time()
        except Exception as e:  # noqa: BLE001
            self.log.error("写心跳文件失败：%s", e)

    # ── requests from other processes (e.g. --resolve while the loop runs) ────────────────────────
    def drain_requests(self) -> None:
        d = settings.OUT_DIR / "requests"
        if not d.exists():
            return
        for p in sorted(d.glob("*.json")):
            try:
                req = json.loads(p.read_text(encoding="utf-8"))
                if req.get("op") == "resolve" and self.issues.resolve_id(req.get("id", ""), self.now()):
                    self.log.info("主人把问题 %s 标记为已解决", req.get("id"))
                    self.save_state()
                    self.write_issues_md()
                    self.write_heartbeat()
            except Exception as e:  # noqa: BLE001
                self.log.warning("请求文件 %s 读不了：%s", p.name, e)
            p.unlink(missing_ok=True)

    # ── run forever / stop ────────────────────────────────────────────────────────────────────────
    def serve_forever(self) -> None:
        try:
            self.seed_first_start(self.now())
            self.save_state()
            nx = self.next_due(self.now())
            self.log.info("💓 心跳循环启动（%s，pid %d）。%s；心跳文件 %s", self.mode, os.getpid(),
                          f"下一轮 {CYCLE_ZH.get(nx[0], nx[0])}" + ("（马上）" if nx[1] <= self.now() else f"，{self.both_fmt(nx[1])}") if nx else "",
                          HEARTBEAT_PATH)
            self.write_heartbeat()
            while not self.stop_event.is_set():
                self.last_tick = time.time()
                try:
                    self.drain_requests()
                    due = self.due(self.now())
                    if due:
                        self.run_cycle(due[0])
                        continue
                    if time.time() - self._last_hb > 120:
                        self.write_heartbeat()
                except Exception as e:  # noqa: BLE001
                    self.loop_crashed(e)
                self.stop_event.wait(float(self.cfg.get("tick_seconds", 30)))
        finally:
            self.current = None
            self.write_heartbeat(stopped=True)
            self.log.info("💤 心跳循环停了")
            self.release_lock()

    def loop_crashed(self, e: Exception) -> None:
        """A bug in the loop itself: log it, record a code-level issue, keep going (unless it keeps happening)."""
        tb = traceback.format_exc(limit=8)
        self.log.error("loop 自己出错了：%s\n%s", e, tb)
        now = time.time()
        self._crashes = [t for t in self._crashes if now - t < 3600] + [now]
        it = self.issues.touch("loop", "心跳循环自身出错", tb, self.now(), cmd="loop/runner.py")
        it.update(level="code", statusText="loop 代码自身的 bug，需要改 loop/runner.py")
        try:
            self.save_state()
            self.write_issues_md()
        except Exception:  # noqa: BLE001
            pass
        if len(self._crashes) >= 5:
            self.log.error("一小时内崩了 5 次，loop 先停下（看 loop/out/issues.md）")
            self.stop_event.set()

    def stop(self, timeout: float = 15) -> None:
        if not self.stop_event.is_set():
            self.log.info("收到停止信号，收尾中…")
        self.stop_event.set()
        with self._child_lock:
            p = self._child
        if p is not None and p.poll() is None:
            self._kill(p)


# ── server.py entry point ─────────────────────────────────────────────────────────────────────────
class LoopHandle:
    def __init__(self, runner: Runner, thread: threading.Thread):
        self.runner, self.thread = runner, thread

    def alive(self) -> bool:
        return self.thread.is_alive()

    def stop(self, timeout: float = 30) -> None:
        self.runner.stop()
        self.thread.join(timeout)

    def heartbeat(self) -> dict:
        return self.runner.heartbeat()


_handle: LoopHandle | None = None


def start_in_thread(config_path: str | os.PathLike | None = None) -> LoopHandle | None:
    """Start the loop in a daemon thread inside server.py. Returns None (and logs why) when it is turned
    off with $MW_LOOP=0 or another loop (standalone / launchd) already holds loop/out/loop.lock."""
    global _handle
    if _handle and _handle.alive():
        return _handle
    setup_logging(to_file=True)
    if os.environ.get("MW_LOOP", "1").strip().lower() in ("0", "off", "false", "no"):
        log.info("MW_LOOP=0：server 里不启动心跳循环")
        return None
    r = Runner(settings.load_config(Path(config_path) if config_path else None), mode="thread")
    ok, holder = r.acquire_lock()
    if not ok:
        log.info("另一个心跳循环已经在跑（%s），server 里不再起第二个", holder)
        return None
    t = threading.Thread(target=r.serve_forever, name="money-weather-loop", daemon=True)
    t.start()
    _handle = LoopHandle(r, t)
    atexit.register(_handle.stop, 15)  # kill a running child, write the "stopped" heartbeat, free the lock
    return _handle


# ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
def print_plan(r: Runner) -> None:
    now = r.now()
    mk = cal.status(now)
    print(f"心跳循环 · 计划（dry-run，什么都不跑、不写、不调 Claude）")
    print(f"  现在：纽约 {now:%Y-%m-%d %H:%M %a}；{r.owner_fmt(now)}（{r.owner_tz}）")
    print(f"  美股：{mk['reason']}" + (f"；下次开盘 {r.owner_fmt(mk['opensAt'])}" if not mk["open"] else
                                      f"；收盘 {r.owner_fmt(mk['closesAt'])}"))
    due = r.due(now)
    print(f"  现在该跑：{'、'.join(CYCLE_ZH[d] for d in due) if due else '没有'}")
    for name in PRIORITY:
        cy = r._cy(name)
        if not cy.get("enabled", True):
            print(f"  {CYCLE_ZH[name]}：关掉了")
            continue
        if name == "market":
            t = r._next_at(now, lambda d: next((s for s in r._market_slots(d) if s > now), None))
        elif name == "close":
            t = r._next_at(now, r._close_at)
        elif name == "nightly":
            t = r._next_at(now, r._night_at)
        else:
            last = _parse(r.state["sched"].get("last_any"))
            t = max(now, (last + timedelta(minutes=int(cy.get("every_min", 60))))) if last else now
        when = "马上" if t and t <= now else (r.both_fmt(t) if t else "—")
        print(f"  {CYCLE_ZH[name]}（{', '.join(cy.get('steps', []))}）下次：{when}")
    b = r.budget.status()
    print(f"  Claude 额度（{b['day']}，纽约日期）：" + "，".join(f"{k} {b['used'].get(k, 0)}/{v}" for k, v in b["caps"].items()))
    print(f"  Claude 花费（DESIGN §21，你那边的日期）：{usage.status()['say']}（估算，{usage.USAGE_PATH.name}）")
    from loop import claude as cl
    print(f"  claude 命令：{cl.find_bin(r.cfg) or '找不到！'}；侦察兵：{r.bridge.describe()}")
    print(f"  心跳文件：{HEARTBEAT_PATH}；问题清单：{settings.ISSUES_MD}", flush=True)


def print_status() -> int:
    try:
        hb = json.loads(HEARTBEAT_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        print(f"还没有心跳文件（{HEARTBEAT_PATH}）——loop 还没跑过")
        return 1
    dot = {"green": "🟢", "amber": "🟡", "red": "🔴"}.get(hb.get("status"), "⚪")
    print(f"{dot} {hb.get('statusSay')}   （{hb.get('mode')}, {hb.get('state')}, 更新于 {hb.get('updatedAtLocal')}）")
    lc = hb.get("lastCycle") or {}
    if lc:
        print(f"上一轮：{lc.get('nameZh')} {lc.get('startedAt')} · {lc.get('ms', 0) / 1000:.1f}s · {lc.get('say')}")
    for s in hb.get("steps") or []:
        mark = "·" if s.get("skipped") else ("✓" if s.get("ok") else "✗")
        print(f"   {mark} {s.get('name'):<15} {(s.get('ms') or 0) / 1000:6.1f}s  {s.get('note')}")
    if hb.get("nextCycle"):
        print(hb["nextCycle"]["say"])
    gcap = (hb.get("caps") or {}).get("global")
    print(f"今天 Claude 调用：{hb.get('claudeCallsToday')}" + (f"/{gcap}" if gcap else " 次")
          + (f"；{hb['usage']['say']}" if isinstance(hb.get("usage"), dict) and hb["usage"].get("say") else ""))
    for c in (hb.get("claude") or [])[:5]:
        print(f"  🔎 {c.get('at')} {c.get('ask')} → {c.get('found')}")
    for i in hb.get("issues") or []:
        print(f"  ⚠️  {i.get('id')} [{i.get('level')}] {i.get('title')} — {i.get('statusText')}")
    return 0


def resolve_issue(issue_id: str) -> int:
    r = Runner(mode="cli")
    ok, holder = r.acquire_lock()
    if not ok:
        d = settings.OUT_DIR / "requests"
        d.mkdir(parents=True, exist_ok=True)
        atomic_json(d / f"resolve-{int(time.time() * 1000)}.json", {"op": "resolve", "id": issue_id})
        print(f"loop 正在跑（{holder}），已把请求交给它，半分钟内处理")
        return 0
    try:
        if r.issues.resolve_id(issue_id, r.now()):
            r.save_state()
            r.write_issues_md()
            print(f"已标记 {issue_id} 为已解决")
            return 0
        print(f"没找到未解决的问题 {issue_id}")
        return 1
    finally:
        r.release_lock()


def render_plist() -> str:
    tpl = (settings.LOOP_DIR / "launchd" / "com.moneyweather.loop.plist.template").read_text(encoding="utf-8")
    path = ":".join(dict.fromkeys([str(Path.home() / ".local/bin"), str(Path(sys.executable).parent),
                                   "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))
    rep = {"__PYTHON__": sys.executable, "__ROOT__": str(settings.ROOT), "__HOME__": str(Path.home()),
           "__PATH__": path, "__HEARTBEAT__": str(settings.WEB_DATA / "heartbeat.json")}
    for k, v in rep.items():
        tpl = tpl.replace(k, xml_escape(v))
    return tpl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="钱的天气 · 心跳循环 (DESIGN.md §16)")
    ap.add_argument("--once", action="store_true", help="run what is due now (or a health check) and exit")
    ap.add_argument("--cycle", choices=list(CYCLE_ZH), help="force this cycle now and exit")
    ap.add_argument("--dry-run", action="store_true", help="show the plan; run/write/call nothing")
    ap.add_argument("--inject-fail", action="append", default=[], metavar="STEP", help="test: make STEP raise")
    ap.add_argument("--fast", action="store_true", help="test: 1–3 s back-off")
    ap.add_argument("--status", action="store_true", help="print the heartbeat in plain words")
    ap.add_argument("--resolve", metavar="ISSUE_ID", help="mark an issue as solved")
    ap.add_argument("--print-plist", action="store_true", help="print the launchd agent for this machine")
    ap.add_argument("--mode", default="standalone", choices=["standalone", "launchd"])
    ap.add_argument("--config", help="config file (default loop/config.json)")
    a = ap.parse_args(argv)

    if a.status:
        return print_status()
    if a.print_plist:
        sys.stdout.write(render_plist())
        return 0
    setup_logging(to_file=not a.dry_run)
    if a.resolve:
        return resolve_issue(a.resolve)

    cfg = settings.load_config(Path(a.config) if a.config else None)
    r = Runner(cfg, mode=a.mode, dry_run=a.dry_run, inject_fail=a.inject_fail, fast=a.fast)
    if a.dry_run:
        r.seed_first_start(r.now())
        print_plan(r)
        if a.cycle:
            r.run_cycle(a.cycle, forced=True)
        elif a.once:
            due = r.due(r.now())
            r.run_cycle(due[0] if due else "health")
        else:
            for name in PRIORITY:
                r.run_cycle(name)
        return 0

    ok, holder = r.acquire_lock()
    if not ok:
        log.error("另一个心跳循环已经在跑（%s）。一次只能有一个。", holder)
        return 3

    def _sig(signum, _frame):
        r.stop()

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _sig)

    if a.once or a.cycle:
        try:
            r.seed_first_start(r.now())
            if a.cycle:
                ok = r.run_cycle(a.cycle, forced=True)
            else:
                ok, n = True, 0
                due = r.due(r.now()) or ["health"]
                while due and n < 4 and not r.stop_event.is_set():
                    ok = r.run_cycle(due[0]) and ok
                    n += 1
                    due = r.due(r.now())
                    due = [d for d in due if d != "health"]
            return 0 if ok else 1
        finally:
            r.release_lock()
    r.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
