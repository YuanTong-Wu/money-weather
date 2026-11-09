"""Bridge to the 侦察兵 (scout/, DESIGN.md §15) — owned by another agent, so everything is detected,
never assumed. Detection reads source text only (an unknown script is never run with --help).

Used when present (as of 2026-10-27):
    python3 scout/queue.py detect                         detectors → enqueue (scout's own dedupe)
    python3 scout/queue.py drain --max N [--kind K]       run ≤ N queued tasks within scout/config.json caps
    scout.job.start("verify", {"type":"error","step":…,"log":…}, question, source="loop", wait=True, key=…)
        (or `python3 scout/job.py start --kind verify --target <json> --question … --wait`)
      → result dict; the verify fix types land in scout/out/fixes.json (ticker-rename|ticker-delisted|
        ticker-merged|data-ok|data-error|code-issue), which the loop reads back to classify the problem.
Every command can be overridden in loop/config.json → "scout" ({py} {max} {kind} templates).

When scout cannot do a verify, the loop asks Claude itself (loop.claude, web tools only) with its own
compact prompt — §16 requires that a failing step ends up in front of Claude with its error log.
"""
from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path

from loop import claude
from loop.settings import ROOT

log = logging.getLogger("loop")
MARK = "@@LOOP_RESULT@@"
# scout verify fix type → loop level / fix
SCOUT_FIX_LEVEL = {"code-issue": "code", "data-error": "data", "ticker-rename": "data", "ticker-delisted": "data",
                   "ticker-merged": "data", "data-ok": "transient"}


def _has(src: str, word: str) -> bool:
    return bool(re.search(r"""['"]""" + re.escape(word) + r"""['"]""", src))


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


class ScoutBridge:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.sc = cfg.get("scout") or {}

    # ── discovery (per file: a word in a sibling module does not count) ─────────────────────────
    def queue_cli(self) -> Path | None:
        p = ROOT / "scout" / "queue.py"
        src = _read(p)
        return p if src and _has(src, "detect") and _has(src, "drain") else None

    def job_cli(self) -> Path | None:
        p = ROOT / "scout" / "job.py"
        src = _read(p)
        return p if src and _has(src, "start") and _has(src, "--wait") else None

    def present(self) -> bool:
        return (ROOT / "scout").is_dir()

    def describe(self) -> str:
        if not self.present():
            return "scout/ 还不存在"
        q, j = self.queue_cli(), self.job_cli()
        parts = []
        parts.append("queue.py detect/drain" if q else "queue.py ✗")
        parts.append("job.py start --wait" if j else "job.py ✗")
        return "scout/（" + "，".join(parts) + "）"

    def _fmt(self, tpl: list, **kw) -> list[str]:
        return [str(x).format(py=sys.executable, **{k: ("" if v is None else v) for k, v in kw.items()}) for x in tpl]

    def detect_argv(self, kind: str | None, max_n: int) -> list[str] | None:
        if self.sc.get("detect_cmd"):
            return self._fmt(self.sc["detect_cmd"], kind=kind, max=max_n)
        q = self.queue_cli()
        return [sys.executable, str(q.relative_to(ROOT)), "detect"] if q else None

    def work_argv(self, kind: str | None, max_n: int) -> list[str] | None:
        if self.sc.get("work_cmd"):
            return self._fmt(self.sc["work_cmd"], kind=kind, max=max_n)
        q = self.queue_cli()
        if not q:
            return None
        argv = [sys.executable, str(q.relative_to(ROOT)), "drain", "--max", str(max_n)]
        if kind and _has(_read(q), "--kind"):
            for k in ([kind] if isinstance(kind, str) else kind):
                argv += ["--kind", k]
        return argv

    @staticmethod
    def count_ran(output: str) -> int | None:
        """How many tasks a drain ran (its stdout is a JSON list), or None if unknown."""
        m = re.findall(r"CLAUDE_CALLS=(\d+)", output or "")
        if m:
            return int(m[-1])
        i = (output or "").rfind("\n[")
        txt = output[i + 1:] if i >= 0 else (output or "").lstrip()
        if txt.startswith("["):
            try:
                v, _ = json.JSONDecoder().raw_decode(txt)
                if isinstance(v, list):
                    return sum(1 for r in v if isinstance(r, dict) and r.get("state") not in ("cached", "queued"))
            except ValueError:
                return None
        return None

    # ── verify through scout ────────────────────────────────────────────────────────────────────
    def verify_argv(self, target: dict, question: str, key: str) -> list[str] | None:
        if self.sc.get("verify_cmd"):
            return self._fmt(self.sc["verify_cmd"], target=json.dumps(target, ensure_ascii=False), question=question)
        j = self.job_cli()
        if not j:
            return None
        src = _read(j)
        if re.search(r"def start\([^)]*\bsource\b", src):
            # Python API: lets us pass source="loop" (automatic caps) and a stable dedupe key
            code = (
                "import inspect,json,sys\n"
                f"sys.path.insert(0,{str(ROOT)!r})\n"
                "from scout import job\n"
                "a=json.loads(sys.argv[1])\n"
                "p=inspect.signature(job.start).parameters\n"
                "kw={k:v for k,v in (('source','loop'),('wait',True),('spawn',False),('key',a['key'])) if k in p}\n"
                "out=job.start('verify',a['target'],a['question'],**kw)\n"
                f"print({MARK!r}+json.dumps(out,ensure_ascii=False,default=str))\n")
            return [sys.executable, "-c", code, json.dumps({"target": target, "question": question, "key": key},
                                                           ensure_ascii=False)]
        return [sys.executable, str(j.relative_to(ROOT)), "start", "--kind", "verify",
                "--target", json.dumps(target, ensure_ascii=False), "--question", question, "--wait"]

    @staticmethod
    def parse_job_output(out: str) -> dict | None:
        i = (out or "").rfind(MARK)
        txt = out[i + len(MARK):] if i >= 0 else out
        return claude.extract_json(txt)

    @staticmethod
    def scout_fixes_for(task_id: str) -> list[dict]:
        try:
            d = json.loads((ROOT / "scout" / "out" / "fixes.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        items = d if isinstance(d, list) else (d.get("fixes") or d.get("items") or []) if isinstance(d, dict) else []
        return [f for f in items if isinstance(f, dict) and str(f.get("id", "")).startswith(str(task_id))]


def scout_result_to_loop(res: dict, fixes: list[dict]) -> dict:
    """scout job result + its fixes → the loop's verify shape {level, diagnosis, fix, issue, sources, conf}."""
    types = [f.get("type") for f in fixes]
    level = "unknown"
    for t in ("code-issue", "data-error", "ticker-rename", "ticker-delisted", "ticker-merged", "data-ok"):
        if t in types:
            level = SCOUT_FIX_LEVEL[t]
            break
    fix: dict = {"kind": "none"}
    for f in fixes:
        if f.get("type") == "ticker-rename" and f.get("ticker") and f.get("new"):
            fix = {"kind": "ticker_rename", "from": f["ticker"], "to": f["new"]}
            break
        if f.get("type") in ("ticker-delisted", "ticker-merged") and f.get("ticker"):
            fix = {"kind": "ticker_drop", "from": f["ticker"]}
            break
    say = res.get("say") or res.get("line") or ""
    ans = res.get("answer") or ""
    issue_f = next((f for f in fixes if f.get("type") in ("code-issue", "data-error")), None)
    return {"level": level, "diagnosis": (say or ans)[:200], "fix": fix,
            "issue": {"title": (issue_f or {}).get("say", "")[:60] or say[:60], "detail": ans[:400],
                      "suggestion": (issue_f or {}).get("say", ""),
                      "files": [f["file"] for f in fixes if isinstance(f.get("file"), str) and f["file"]][:6]},
            "sources": [s if isinstance(s, str) else (s or {}).get("url") for s in (res.get("sources") or [])],
            "conf": res.get("conf") or 0.5, "via": "scout", "taskId": res.get("id"), "scoutFixes": fixes}


# ── the loop's own verify prompts (fallback; compact: every token is the owner's quota) ──────────

VERIFY_SCHEMA = ('{"level":"transient|data|code|env","diagnosis":"≤60字中文，说人话",'
                 '"fix":{"kind":"none|rerun|ticker_rename|ticker_drop|override|stale_lock",'
                 '"from":null,"to":null,"target":null,"field":null,"value":null},'
                 '"issue":{"title":"≤30字","detail":"≤200字，写给主人看","files":["相对路径"],"suggestion":"怎么修"},'
                 '"sources":["url"],"conf":0.0}')


def step_prompt(step: str, title: str, cmd: str, rc, attempts: int, error: str, tail: str, today: str) -> str:
    return (
        "你是「钱的天气」本地系统的值班侦察兵。一个自动步骤重试后仍失败，请诊断原因。"
        "需要时可用 WebSearch/WebFetch 查（如 yfinance/Yahoo 接口变动、股票代码改名退市、Polymarket API 变化）。"
        "不要改任何代码，只给结论。\n"
        f"步骤: {step}（{title}）\n命令: {cmd}\n退出码: {rc}  已试: {attempts} 次\n错误: {error[:300]}\n"
        f"日志尾部:\n```\n{tail}\n```\n"
        f"环境: macOS, Python 3.12, yfinance 1.3, pandas 2.3；现在 {today}（纽约时间）。\n"
        "level 含义: transient=外部临时故障，下轮自会好; data=数据层问题，可用 fix 自动修(改名/补值/清过期锁);"
        " code=要改代码; env=本机环境/网络/权限。\n"
        f"只输出一个 JSON 对象，不要任何别的文字:\n{VERIFY_SCHEMA}"
    )


def tickers_prompt(tickers: list[str], today: str) -> str:
    return (
        "这些美股/ETF 代码连续几天从 yfinance 拿不到日线数据: " + ", ".join(tickers) + "。"
        "用 WebSearch 逐个查：改名换代码、退市、被并购，还是 Yahoo 临时故障？"
        f"今天 {today}。只输出一个 JSON 对象，不要别的文字:\n"
        '{"tickers":[{"t":"代码","status":"renamed|delisted|merged|temporary|unknown",'
        '"newTicker":null,"say":"≤30字中文","sources":["url"],"conf":0.0}]}'
    )


def run_verify(bridge: ScoutBridge, cfg: dict, *, target: dict, question: str, key: str, prompt: str,
               run_cmd, stop_event=None, on_proc=None) -> tuple[claude.ClaudeResult, bool]:
    """Scout first (shared caps, scout log, 🔎 panel); fall back to a direct Claude call.
    Returns (result, spent) — spent=False when no Claude call happened (cached / over scout's cap)."""
    argv = bridge.verify_argv(target, question, key) if (cfg.get("verify") or {}).get("via_scout", True) else None
    if argv:
        timeout = float((cfg.get("claude") or {}).get("timeout_s", 300)) + 1500
        rc, out, ms = run_cmd(argv, "scout_verify", timeout=timeout)
        res = bridge.parse_job_output(out) if rc == 0 else None
        if isinstance(res, dict) and not res.get("error") and res.get("state") in ("done", "cached"):
            fixes = bridge.scout_fixes_for(res.get("id") or "")
            data = scout_result_to_loop(res, fixes)
            return claude.ClaudeResult(True, data=data, text=json.dumps(res, ensure_ascii=False)[:2000], ms=ms), \
                res.get("state") != "cached"
        why = str((res or {}).get("error") or f"rc={rc}")
        if re.search(r"cap|额度|上限", why):
            log.info("  scout 今天的 verify 额度满了（%s），loop 自己问 Claude", why[:80])
        elif rc == -9 or (isinstance(res, dict) and res.get("state") in ("failed", "invalid", "running")):
            # scout did reach Claude (or is still on it): don't pay twice for the same question
            log.warning("  scout verify 没查成（%s）", why[:120])
            return claude.ClaudeResult(False, error=f"scout verify 没查成：{why[:160]}", ms=ms), True
        else:
            log.warning("  scout verify 没跑起来（%s），loop 自己问 Claude", why[:120])
    return claude.call(prompt, cfg, stop_event=stop_event, on_proc=on_proc), True
