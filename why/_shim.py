"""why/_shim.py — a thin stand-in for common/claude_gate.py with the SAME signature (DESIGN §24), used only
until the real gateway exists. why/gate.py switches to the real one automatically as soon as it imports.

    call(kind, prompt, *, system=None, tools=(), schema=None, model=None, effort=None, auto=False, timeout=240)
        -> {"ok", "text", "json", "usd", "inTok", "outTok", "ms", "model", "error", "refused": None | "budget"}
    can_spend(auto) -> (bool, str)        # via loop/usage.py: 6 weekly-quota points/day, automatic ≤ 4
    budget_status() -> {"day","usedPts","capPts","autoUsedPts","autoCapPts","usd","usdPerPt","calibrated","byKind","resetsAtLocal"}

Runs `claude -p` with stream-json (for the cost), in a temp cwd, --safe-mode --strict-mcp-config
--no-session-persistence, tools only as passed; every call (ok or not) is written to the shared ledger
web/data/claude_usage.json through loop/usage.py. One cheap retry (no tools) when JSON was expected but the
answer did not parse. No count or concurrency limits — spend is the only limit.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _usage():
    try:
        from loop import usage
        return usage
    except Exception:  # noqa: BLE001
        return None


def _bin() -> str:
    b = os.path.expanduser(os.environ.get("MW_CLAUDE_BIN") or "~/.local/bin/claude")
    if os.path.isfile(b) and os.access(b, os.X_OK):
        return b
    return shutil.which("claude") or b


def can_spend(auto: bool = False) -> tuple[bool, str]:
    u = _usage()
    if u is None:
        return True, ""
    try:
        return u.can_spend(auto=auto)
    except Exception:  # noqa: BLE001
        return True, ""


def budget_status() -> dict:
    u = _usage()
    s = {}
    if u is not None:
        try:
            s = u.status()
        except Exception:  # noqa: BLE001
            s = {}
    cfg = {}
    try:
        cfg = (json.loads((ROOT / "loop" / "config.json").read_text(encoding="utf-8")).get("usage") or {})
    except (OSError, ValueError):
        pass
    reset = str(s.get("resetsAt") or "")
    return {"day": s.get("day"), "usedPts": s.get("pct", 0.0), "capPts": s.get("capPct", 6.0),
            "autoUsedPts": s.get("autoPct", 0.0), "autoCapPts": s.get("autoCapPct", 4.0),
            "usd": s.get("usd", 0.0), "usdPerPt": s.get("usdPerPct", 1.0),
            "calibrated": bool(cfg.get("calibrated")), "byKind": s.get("byKind") or {},
            "resetsAtLocal": reset[11:16] if len(reset) >= 16 else reset, "say": s.get("say"),
            "over": s.get("over"), "autoOver": s.get("autoOver"), "source": "why/_shim (loop/usage)"}


def _parse_stream(out: str) -> dict | None:
    final = None
    for line in (out or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "result":
            final = e
    if final is None:                       # --output-format json (one object)
        try:
            e = json.loads(out)
            if isinstance(e, dict) and "result" in e:
                final = e
        except ValueError:
            pass
    return final


def _parse_json(text: str):
    from why.card import parse_json
    return parse_json(text)


def _run(kind: str, prompt: str, system, tools, model, effort, auto: bool, timeout: int) -> dict:
    cmd = [_bin(), "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--model", model or "sonnet", "--no-session-persistence", "--safe-mode", "--strict-mcp-config",
           "--permission-prompts", "none"]
    tl = ",".join(tools or [])
    cmd += ["--tools", tl] + (["--allowedTools", tl] if tl else [])
    if system:
        cmd += ["--system-prompt", system]
    if effort:
        cmd += ["--effort", str(effort)]
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)
    t0 = time.time()
    res = {"ok": False, "text": "", "json": None, "usd": 0.0, "inTok": 0, "outTok": 0, "ms": 0,
           "model": model, "error": None, "refused": None}
    with tempfile.TemporaryDirectory(prefix="why-") as td:
        try:
            p = subprocess.Popen(cmd, cwd=td, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True, env=env)
        except OSError as e:
            res["error"] = f"Claude CLI 起不来：{e}"
            return res
        try:
            out, err = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(p.pid, sig)
                except (ProcessLookupError, PermissionError):
                    pass
                time.sleep(1.5)
            out, err = p.communicate()
            res["error"] = f"Claude 超时（{timeout} 秒）"
    res["ms"] = int((time.time() - t0) * 1000)
    final = _parse_stream(out or "")
    u = _usage()
    if final is None:
        res["error"] = res["error"] or f"Claude 没返回结果（exit {p.returncode}）：{(err or out or '')[-240:]}"
        if u:
            u.record(kind, module=kind.split(":")[0], env=None, auto=auto, ok=False, ms=res["ms"], note=res["error"][:100])
        return res
    usage = final.get("usage") or {}
    mu = final.get("modelUsage") or {}
    res.update(usd=float(final.get("total_cost_usd") or 0.0),
               inTok=int((usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0)
                         + (usage.get("cache_creation_input_tokens") or 0)),
               outTok=int(usage.get("output_tokens") or 0), model=(next(iter(mu)) if mu else model),
               text=str(final.get("result") or ""))
    bad = bool(final.get("is_error")) or final.get("subtype") not in (None, "success")
    if u:
        u.record(kind, module=kind.split(":")[0], env=final, auto=auto, ok=not bad, ms=res["ms"],
                 note="" if not bad else str(final.get("subtype")))
    if bad:
        res["error"] = f"Claude 出错：{final.get('subtype')} {res['text'][:200]}"
        return res
    res["ok"] = True
    return res


def call(kind: str, prompt: str, *, system: str | None = None, tools=(), schema: dict | None = None,
         model: str | None = None, effort: str | None = None, auto: bool = False, timeout: int = 240) -> dict:
    ok, why = can_spend(auto)
    if not ok:
        return {"ok": False, "text": "", "json": None, "usd": 0.0, "inTok": 0, "outTok": 0, "ms": 0,
                "model": model, "error": why, "refused": "budget"}
    r = _run(kind, prompt, system, list(tools or ()), model, effort, auto, int(timeout))
    if r["ok"]:
        r["json"] = _parse_json(r["text"])
        if r["json"] is None and schema is not None:          # one cheap retry: no tools, just re-format
            fix = ("把下面这段回答整理成一个严格合法的 JSON 对象（符合这个 JSON Schema），只输出 JSON，不要别的话。"
                   "字符串里的英文双引号改成「」。\nSchema：" + json.dumps(schema, ensure_ascii=False) +
                   "\n回答：\n" + r["text"][:20000])
            r2 = _run(kind, fix, None, [], model, "low", auto, 180)
            r["usd"] += r2.get("usd") or 0.0
            r["inTok"] += r2.get("inTok") or 0
            r["outTok"] += r2.get("outTok") or 0
            r["ms"] += r2.get("ms") or 0
            r["json"] = _parse_json(r2.get("text") or "") if r2.get("ok") else None
            if r["json"] is None:
                r["ok"] = False
                r["error"] = "Claude 的回答不是合法 JSON（重试一次也没成）"
    return r
