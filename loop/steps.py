"""Pluggable steps (DESIGN.md §16). A step is any object with .name, .title and .run(ctx) -> Outcome.

Steps never import other agents' code: they shell out to CLIs that may not exist yet, detect that, and
skip with a clear log line. Register more with `STEPS["my_step"] = MyStep()` (or pass extra steps to
Runner) and list the name in a cycle in loop/config.json.

ctx (the Runner) gives: cfg, state, budget, bridge, dry_run, now(), log, run_cmd(argv, name, timeout)
→ (rc, output, ms), cycle (dict for this cycle's scratch data).
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from datetime import datetime

from loop import health as health_mod
from loop import usage
from loop.settings import ROOT


@dataclass
class Outcome:
    ok: bool
    skipped: bool = False
    note: str = ""            # short plain Chinese, shown on the heartbeat
    error: str = ""           # what went wrong (goes to Claude on failure)
    rc: int | None = None
    cmd: str = ""
    tail: str = ""            # last lines of output
    retryable: bool = True
    busy: bool = False        # someone else holds the update lock — not an error
    data: dict = field(default_factory=dict)


def _tail(text: str, n: int = 40) -> str:
    lines = (text or "").rstrip().splitlines()
    return "\n".join(lines[-n:])


def _claude_calls(text: str) -> int | None:
    m = re.findall(r"CLAUDE_CALLS=(\d+)", text or "")
    return int(m[-1]) if m else None


def _fmt(tpl: list, **kw) -> list[str]:
    return [str(x).format(py=sys.executable, **kw) for x in tpl]


def _script_of(argv: list[str]) -> str | None:
    """The project-relative script a command runs (first .py/.sh argument)."""
    for a in argv[1:] if argv and (argv[0] == sys.executable or argv[0] in ("bash", "sh")) else argv:
        if a.endswith((".py", ".sh")):
            return a
    return None


class Step:
    name = "step"
    title = "步骤"
    self_reporting = False      # True → the runner does not send a plain "step failed" to Claude

    def cfg(self, ctx) -> dict:
        return (ctx.cfg.get("steps") or {}).get(self.name, {})

    def run(self, ctx) -> Outcome:  # pragma: no cover - interface
        raise NotImplementedError


# ── update.sh (quick + full) ───────────────────────────────────────────────────────────────────────
FAILED_RE = re.compile(r"WARNING: no data for \d+ ticker\(s\):\s*(.+)")


class UpdateStep(Step):
    def __init__(self, name: str, title: str, quick: bool):
        self.name, self.title, self.quick = name, title, quick

    def run(self, ctx) -> Outcome:
        sh = ROOT / "update.sh"
        if not sh.exists():
            return Outcome(True, skipped=True, note="update.sh 还不存在，跳过")
        args = [str(a) for a in self.cfg(ctx).get("args", [])]
        note = ""
        if self.quick:
            src = sh.read_text(encoding="utf-8", errors="replace")
            if "--quick" in src:
                args = ["--quick"] + args
            else:
                # no incremental mode yet: a plain update.sh redoes compute + brief but cannot add today's
                # partial bar, so run it at most every `fallback_every_min` instead of every 15 minutes
                every = float(self.cfg(ctx).get("fallback_every_min", 60))
                last = (ctx.state.get("stepLast") or {}).get(self.name, {}).get("okAt")
                if last and (ctx.now() - datetime.fromisoformat(last)).total_seconds() < every * 60:
                    return Outcome(True, skipped=True, note=f"update.sh 还没有 --quick；普通更新每 {int(every)} 分钟最多一次")
                note = "update.sh 还不支持 --quick，用普通更新代替（盘中半根K线要等它支持）"
                if not ctx.state.get("_warned_quick") and not ctx.dry_run:
                    ctx.log.info("quick_refresh: %s", note)
        argv = ["bash", "update.sh"] + args
        if ctx.dry_run:
            return Outcome(True, skipped=True, note=f"[dry-run] 会运行: {' '.join(argv)}" + (f"（{note}）" if note else ""))
        ctx.state["_warned_quick"] = True
        rc, out, ms = ctx.run_cmd(argv, self.name, timeout=float(self.cfg(ctx).get("timeout_s", 1800)))
        failed: list[str] = []
        for m in FAILED_RE.finditer(out):
            failed = m.group(1).split()
        if rc in (0, 4):
            ctx.note_failed_tickers(failed)
        if rc == 0:
            return Outcome(True, note=(note or ("快速刷新完成" if self.quick else "完整更新完成"))
                           + (f"；{len(failed)} 只没拿到数据" if failed else ""), rc=rc, cmd=" ".join(argv))
        if rc == 3:
            return Outcome(False, busy=True, note="另一个更新正在跑，这轮让给它", rc=rc, cmd=" ".join(argv),
                           error="update.sh 正被别的进程占用（exit 3）", tail=_tail(out, 10))
        if rc == 4:
            return Outcome(False, note="地图数据更新了，但今日预报 brief.py 出错", rc=rc, cmd=" ".join(argv),
                           error="brief.py failed (update.sh exit 4)\n" + _tail(out, 30), tail=_tail(out, 40))
        why = "超时被停掉" if rc == -9 else f"退出码 {rc}"
        return Outcome(False, note=f"更新失败（{why}）", rc=rc, cmd=" ".join(argv),
                       error=f"update.sh {why}\n" + _tail(out, 30), tail=_tail(out, 40))


# ── generic "run these scripts if they exist" step ────────────────────────────────────────────────
class ShellStep(Step):
    def __init__(self, name: str, title: str, claude_kind: str | None = None):
        self.name, self.title, self.claude_kind = name, title, claude_kind

    def run(self, ctx) -> Outcome:
        c = self.cfg(ctx)
        if c.get("enabled") is False:
            return Outcome(True, skipped=True, note="config 里关掉了")
        cmds = (ctx.cfg.get("commands") or {}).get(self.name) or []
        if not cmds:
            return Outcome(True, skipped=True, note="config 里没配命令")
        primary = _script_of(_fmt(cmds[0], max=0))
        if primary and not (ROOT / primary).exists():
            return Outcome(True, skipped=True, note=f"{primary} 还不存在，跳过")
        mi = c.get("min_interval_min")
        if mi:
            last = (ctx.state.get("stepLast") or {}).get(self.name, {}).get("okAt")
            if last and (ctx.now() - datetime.fromisoformat(last)).total_seconds() < float(mi) * 60:
                return Outcome(True, skipped=True, note=f"{mi} 分钟内刚跑过")
        max_n = 0
        if self.claude_kind:
            pts_ok, pts_why = usage.can_spend(auto=True)
            if not pts_ok:
                return Outcome(True, skipped=True, note=pts_why)
            max_n = min(int(c.get("max_tasks", 2)), ctx.budget.left(self.claude_kind))
            if max_n <= 0:
                return Outcome(True, skipped=True, note=f"今天 Claude 额度（{self.claude_kind}）用完了，跳过")
        plan = [_fmt(t, max=max_n) for t in cmds]
        plan = [a for i, a in enumerate(plan) if i == 0 or not _script_of(a) or (ROOT / _script_of(a)).exists()]
        if ctx.dry_run:
            extra = f"；最多花 {max_n} 次 Claude（{self.claude_kind}）" if self.claude_kind else ""
            return Outcome(True, skipped=True, note="[dry-run] 会运行: " + " && ".join(
                " ".join(a[1:] if a[0] == sys.executable else a) for a in plan) + extra)
        reserved = 0
        if self.claude_kind and max_n > 0 and ctx.budget.try_spend(self.claude_kind, max_n, note=self.name):
            reserved = max_n
        outs, total_ms = [], 0
        try:
            for argv in plan:
                rc, out, ms = ctx.run_cmd(argv, self.name, timeout=float(c.get("timeout_s", 1800)))
                total_ms += ms
                outs.append(out)
                if rc != 0:
                    shown = " ".join(argv[1:] if argv[0] == sys.executable else argv)
                    why = "超时被停掉" if rc == -9 else f"退出码 {rc}"
                    return Outcome(False, note=f"{_script_of(argv) or argv[0]} 失败（{why}）", rc=rc, cmd=shown,
                                   error=f"{shown}: {why}\n" + _tail(out, 30), tail=_tail(out, 40))
        finally:
            if reserved:
                used = _claude_calls("\n".join(outs))
                if used is not None and used < reserved:
                    ctx.budget.refund(self.claude_kind, reserved - used, note=self.name)
        return Outcome(True, note=f"完成（{len(plan)} 个命令）", cmd=" && ".join(" ".join(a) for a in plan))


# ── scout (§15) ───────────────────────────────────────────────────────────────────────────────────
class ScoutStep(Step):
    """scout/queue.py detect (free: enqueue by attention) → drain --max N [--kind K] (spends quota).
    Scout keeps its own caps in scout/config.json; the loop's budget guard sits on top of them."""

    def __init__(self, name: str, title: str, kind, budget_kind: str):
        self.name, self.title, self.kind, self.budget_kind = name, title, kind, budget_kind

    def run(self, ctx) -> Outcome:
        b = ctx.bridge
        if not b.present():
            return Outcome(True, skipped=True, note="scout/ 侦察兵模块还没有，跳过")
        c = self.cfg(ctx)
        # keep_for_later: leave this many scout calls for the close cycle's explain (count brake, off by default)
        left = max(0, ctx.budget.left(self.budget_kind) - int(c.get("keep_for_later", 0)))
        max_n = min(int(c.get("max_tasks", 2)), left)
        # DESIGN §21: the real limit is spend — automatic work ≤ its points; reserve_pct keeps some for later
        pts_ok, pts_why = usage.can_spend(auto=True)
        reserve = float(c.get("reserve_pct") or 0)
        if pts_ok and reserve > 0:
            al = usage.status()["autoLeftPct"]
            if al <= reserve:
                pts_ok, pts_why = False, f"自动额度只剩 ≈{al:.1f} 个点，留给后面更要紧的（收盘后解释异动）"
        if not pts_ok:
            max_n = 0
        det = b.detect_argv(self.kind, max_n)
        work = b.work_argv(self.kind, max_n) if max_n > 0 else None
        if not det and not work:
            if not pts_ok:
                return Outcome(True, skipped=True, note=pts_why)
            if max_n <= 0:
                return Outcome(True, skipped=True, note=f"今天侦察兵额度（{self.budget_kind}）用完了")
            return Outcome(True, skipped=True, note=f"认不出 scout 的命令：{b.describe()}（可在 config 里配 scout.*_cmd）")
        if ctx.dry_run:
            parts = [" ".join(a[1:]) for a in (det, work) if a]
            return Outcome(True, skipped=True, note="[dry-run] 会运行: " + " && ".join(parts)
                           + (f"；最多派 {max_n} 个任务（{usage.status()['say']}）" if work
                              else f"；只巡逻不派人（{pts_why or self.budget_kind + ' 额度用完'}）"))
        timeout = float(c.get("timeout_s", 1800))
        notes = []
        if det:
            rc, out, _ = ctx.run_cmd(det, self.name, timeout=300)
            if rc != 0:
                return Outcome(False, note="侦察兵巡逻（detect）出错", rc=rc, cmd=" ".join(det[1:]),
                               error=f"scout detect 退出码 {rc}\n" + _tail(out, 30), tail=_tail(out, 40))
            notes.append("巡逻完")
        if work:
            if not ctx.budget.try_spend(self.budget_kind, max_n, note=self.name):
                return Outcome(True, skipped=True, note="侦察兵额度刚好用完")
            rc, out, _ = ctx.run_cmd(work, self.name, timeout=timeout)
            used = b.count_ran(out)
            if used is not None and used < max_n:
                ctx.budget.refund(self.budget_kind, max_n - used, note=self.name)
            if rc != 0:
                return Outcome(False, note="侦察兵干活（drain）出错", rc=rc, cmd=" ".join(work[1:]),
                               error=f"scout drain 退出码 {rc}\n" + _tail(out, 30), tail=_tail(out, 40))
            notes.append(f"派出 {used} 个任务" if used is not None else f"最多派 {max_n} 个任务")
        else:
            notes.append(f"只巡逻不派人：{pts_why}" if not pts_ok else "额度用完，只巡逻不派人")
        return Outcome(True, note="；".join(notes))


# ── health ────────────────────────────────────────────────────────────────────────────────────────
class HealthStep(Step):
    name, title = "health", "体检"
    self_reporting = True

    def run(self, ctx) -> Outcome:
        res = health_mod.check(ctx.now(), ctx.cfg, ctx.state)
        ctx.cycle["health"] = res
        fails = [p for p in res["problems"] if p["level"] == "fail"]
        warns = [p for p in res["problems"] if p["level"] == "warn"]
        if fails:
            note = "；".join(p["say"] for p in fails[:2])
        elif warns:
            note = "小毛病：" + "；".join(p["say"] for p in warns[:2])
        else:
            f = res["facts"]
            note = f"数据到 {f.get('asOf', '?')}，一切正常"
        return Outcome(not fails, note=note, error="\n".join(f"{p['say']} | {p['detail']}" for p in fails),
                       retryable=False, data=res)


class FailingStep(Step):
    """Test hook (--inject-fail NAME): stands in for a step and raises."""
    def __init__(self, name: str, title: str = "模拟故障"):
        self.name, self.title = name, title

    def run(self, ctx) -> Outcome:
        raise RuntimeError(f"模拟故障：{self.name} 抛出异常（--inject-fail 测试）")


def default_steps() -> dict[str, Step]:
    return {
        "quick_refresh": UpdateStep("quick_refresh", "快速刷新价格", quick=True),
        "full_update": UpdateStep("full_update", "完整更新", quick=False),
        "polymarket": ShellStep("polymarket", "预言市场"),
        "scenario_track": ShellStep("scenario_track", "推演打分"),
        "scout_detect": ScoutStep("scout_detect", "侦察兵巡逻", kind=["explain", "verify"], budget_kind="scout"),
        "scout_explain": ScoutStep("scout_explain", "侦察兵解释异动", kind="explain", budget_kind="explain"),
        "scout_gaps": ScoutStep("scout_gaps", "侦察兵补估算", kind="gap", budget_kind="gap"),
        "graph_build": ShellStep("graph_build", "关系网合并"),
        "fullmarket": ShellStep("fullmarket", "全市场刷新"),
        "polymarket_map": ShellStep("polymarket_map", "预言市场翻译映射", claude_kind="map"),
        "health": HealthStep(),
    }


STEPS = default_steps()
