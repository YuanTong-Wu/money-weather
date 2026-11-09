"""The 推演 call to Claude — through the ONE gateway common/claude_gate.py (DESIGN §21 amendment, §24).

The gateway checks today's points (an owner click: may use all 6), runs `claude -p` with no tools in an
empty temp cwd (no session saved, customizations off, short system prompt), CLI-enforced JSON via
--json-schema, books the cost in web/data/claude_usage.json, and retries once when the answer is not
usable JSON or `validate()` finds problems.

Env: MW_CLAUDE_BIN (a fake for tests), MW_SCENARIO_TIMEOUT (s, default 240), MW_SCENARIO_MODEL (None → the
CLI default), MW_SCENARIO_EFFORT (low|medium|high|xhigh|max).
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

_GATE_FILE = Path(__file__).resolve().parent.parent / "common" / "claude_gate.py"
TIMEOUT = int(os.environ.get("MW_SCENARIO_TIMEOUT", "240"))
MODEL = os.environ.get("MW_SCENARIO_MODEL")  # None → the CLI default
EFFORT = os.environ.get("MW_SCENARIO_EFFORT")  # low|medium|high|xhigh|max, None → default


class LLMError(RuntimeError):
    pass


def _gate():
    alias = "mw_gate_" + hashlib.md5(str(_GATE_FILE).encode()).hexdigest()[:8]
    for name in ("common.claude_gate", alias):
        m = sys.modules.get(name)
        if m is not None and Path(getattr(m, "__file__", "") or "").resolve() == _GATE_FILE:
            return m
    try:
        m = importlib.import_module("common.claude_gate")
        if Path(m.__file__).resolve() == _GATE_FILE:
            return m
    except Exception:  # noqa: BLE001
        pass
    if not _GATE_FILE.exists():
        raise LLMError(f"Claude 额度出口不见了：{_GATE_FILE}")
    spec = importlib.util.spec_from_file_location(alias, _GATE_FILE)
    m = importlib.util.module_from_spec(spec)
    sys.modules[alias] = m
    spec.loader.exec_module(m)
    return m


def _extract_json(text: str):
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    a, b = t.find("{"), t.rfind("}")
    if a >= 0 and b > a:
        try:
            return json.loads(t[a:b + 1])
        except Exception:
            return None
    return None


def ask_json(prompt: str, system: str, schema: dict | None = None, validate=None,
             timeout: int = TIMEOUT, retries: int = 1) -> tuple[dict, list[dict]]:
    """→ (parsed JSON, call infos). `validate(obj)` returns a list of problems ([] = ok).
    A usable-but-imperfect answer after the retry is returned too (the caller repairs what it can).
    Raises LLMError when nothing usable came back — including "今天的额度用完了（…）" from the gateway."""
    r = _gate().call("scenario", prompt, system=system, tools=(), schema=schema, model=MODEL, effort=EFFORT,
                     auto=False, timeout=timeout, validate=validate, retries=retries, module="scenario")
    calls = [{"sec": round((c.get("ms") or 0) / 1000, 1), "rc": c.get("rc"), "cost": c.get("usd"),
              "model": c.get("model"), "is_error": bool(c.get("error")) or None,
              **({"error": c["error"]} if c.get("error") else {}),
              **({"problems": c["problems"]} if c.get("problems") else {})} for c in r.get("calls") or []]
    if r["refused"]:
        raise LLMError(r["error"] or "今天的额度用完了")
    if r["ok"] and isinstance(r["json"], dict):
        return r["json"], calls
    raise LLMError("推演没有拿到能用的答案：" + (r.get("error") or "unknown"))
