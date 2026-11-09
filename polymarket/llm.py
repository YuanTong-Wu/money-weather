"""polymarket/llm.py: one batched Claude call (no tools) — through the ONE gateway common/claude_gate.py.

Used only by map.py (translations + mappings for new markets, the loop's NIGHTLY step). fetch.py never calls
Claude (and `fetch.py --no-llm` makes that a hard guarantee), so the 15/30-minute refresh costs no quota.
The gateway checks today's points first — this is automatic work (auto=True: stops at 4 points, the last
2 are the owner's) — books the cost in web/data/claude_usage.json as kind "polymarket:map", and retries once
when the answer is not JSON. The last raw answer is kept on disk so a parsing problem never throws away a
paid-for answer (map.py --from-last re-parses it for free).
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

_GATE_FILE = Path(__file__).resolve().parent.parent / "common" / "claude_gate.py"
LAST_RAW = Path(__file__).resolve().parent / "cache" / "llm_last.json"


class ClaudeError(RuntimeError):
    pass


def _gate():
    """Loaded by path when needed: polymarket's own common.py is the top-level `common` in its scripts."""
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
        raise ClaudeError(f"Claude gateway missing: {_GATE_FILE}")
    spec = importlib.util.spec_from_file_location(alias, _GATE_FILE)
    m = importlib.util.module_from_spec(spec)
    sys.modules[alias] = m
    spec.loader.exec_module(m)
    return m


def claude_bin() -> str:
    return _gate().find_bin() or str(Path.home() / ".local" / "bin" / "claude")


def parse_json_text(s):
    if not isinstance(s, str):
        return None
    t = s.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    try:
        return json.loads(t)
    except ValueError:
        pass
    a, b = t.find("{"), t.rfind("}")
    if a >= 0 and b > a:
        try:
            return json.loads(t[a:b + 1])
        except ValueError:
            return None
    return None


def _keep_raw(envelope: dict | None, err: str = ""):
    """Keep the last raw answer on disk, so a parsing problem never throws away a paid-for answer."""
    try:
        LAST_RAW.parent.mkdir(parents=True, exist_ok=True)
        LAST_RAW.write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                        "stdout": json.dumps(envelope or {}, ensure_ascii=False),
                                        "stderr": (err or "")[-4000:]}, ensure_ascii=False))
    except Exception:
        pass


def call(system: str, user: str, *, model: str = "sonnet", timeout: float = 600, effort: str = "low",
         auto: bool | None = None):
    """→ (parsed JSON object or None, info). Raises ClaudeError (CLI failure, or the gateway refusing:
    "自动任务今天的额度用完了（…）"). auto defaults to True (the nightly loop); MW_PM_OWNER=1 marks a run
    the owner started by hand."""
    if auto is None:
        auto = os.environ.get("MW_PM_OWNER") != "1"
    r = _gate().call("polymarket:map", user, system=system, tools=(), model=model, effort=effort or None,
                     auto=auto, timeout=int(timeout), parse=parse_json_text, retries=1, module="polymarket")
    info = {"ms": r["ms"], "model": r.get("model") or model, "mode": "gate", "cost": r["usd"],
            "outTokens": r["outTok"], "attempts": r["attempts"]}
    if r["refused"]:
        raise ClaudeError(r["error"] or "over budget")
    env = r.get("envelope")
    _keep_raw(env, r.get("error") or "")
    if not isinstance(env, dict):
        raise ClaudeError(f"claude failed: {(r.get('error') or 'no output')[:200]}")
    if env.get("is_error") or env.get("subtype") not in (None, "success"):
        raise ClaudeError(f"claude error: {str(env.get('result') or env.get('subtype'))[:200]}")
    info["raw"] = str(r.get("text") or "")[:2000]
    return (r["json"] if isinstance(r["json"], dict) else None), info


def reparse_last():
    """Parse the last kept raw answer again (no new call)."""
    d = json.loads(LAST_RAW.read_text()) if LAST_RAW.exists() else {}
    out = d.get("stdout") or ""
    try:
        w = json.loads(out)
    except ValueError:
        w = None
    if isinstance(w, dict) and "result" in w:
        return parse_json_text(w.get("result") or ""), {"mode": "reparse", "outTokens": (w.get("usage") or {}).get("output_tokens")}
    return parse_json_text(out), {"mode": "reparse"}
