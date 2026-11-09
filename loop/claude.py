"""The loop's Claude call (§15/§16 data-health diagnosis): web tools only, JSON out — through the ONE gateway
common/claude_gate.py (DESIGN §21 amendment, §24), which checks the day's points first (automatic work ≤ 4),
runs `claude -p` in a temp cwd with a clean environment, and writes the cost to web/data/claude_usage.json.

    claude -p <prompt> --output-format stream-json --verbose --tools WebSearch,WebFetch
           --allowedTools WebSearch,WebFetch --permission-mode dontAsk --permission-prompts none
           --safe-mode --strict-mcp-config --no-session-persistence --system-prompt <short>
           [--model sonnet] [--effort medium] [--max-budget-usd …]

$MW_CLAUDE_BIN overrides the binary (the self-test points it at a fake script).
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path

_GATE_FILE = Path(__file__).resolve().parent.parent / "common" / "claude_gate.py"


def _load_gate():
    """common/claude_gate.py of THIS checkout; by path if `common` is shadowed by another module."""
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
    spec = importlib.util.spec_from_file_location(alias, _GATE_FILE)
    m = importlib.util.module_from_spec(spec)
    sys.modules[alias] = m
    spec.loader.exec_module(m)
    return m


gate = _load_gate()
KEEP_ENV = gate.KEEP_ENV

# short system prompt instead of Claude Code's full one: fewer tokens per call (owner's quota)
SYSTEM_PROMPT = ("你是「钱的天气」本地系统的值班侦察兵。只能用 WebSearch/WebFetch 查资料，不能改文件。"
                 "说中文大白话。最后只输出要求的那个 JSON 对象。")


@dataclass
class ClaudeResult:
    ok: bool
    data: dict | None = None        # the JSON object Claude answered with
    text: str = ""                  # raw answer text
    error: str = ""
    ms: int = 0
    cost_usd: float | None = None
    raw: dict = field(default_factory=dict)
    refused: str | None = None      # "budget" when the gateway said no (nothing ran, nothing spent)


def find_bin(cfg: dict) -> str | None:
    return gate.find_bin((cfg.get("claude") or {}).get("bin"))


def clean_env() -> dict:
    return gate.clean_env()


def extract_json(text: str) -> dict | None:
    """First JSON object in `text` (tolerates ```json fences and chatter around it)."""
    return gate.extract_json(text)


def _opts(cfg: dict) -> dict:
    c = cfg.get("claude") or {}
    return {"system": c.get("system_prompt") or SYSTEM_PROMPT, "tools": list(c.get("tools") or ["WebSearch", "WebFetch"]),
            "model": c.get("model"), "effort": c.get("effort")}


def build_argv(binary: str, prompt: str, cfg: dict) -> list[str]:
    o = _opts(cfg)
    return gate.build_argv(binary, prompt=prompt, system=o["system"], tools=o["tools"], model=o["model"],
                           effort=o["effort"], max_usd=gate.config().get("max_usd_per_call"))


def call(prompt: str, cfg: dict, *, timeout: float | None = None, stop_event=None,
         on_proc=None, kind: str = "loop:verify") -> ClaudeResult:
    """One automatic diagnosis call. The gateway refuses (ok=False, refused="budget") when the day's
    automatic points are used up; every CLI run it makes is in the ledger."""
    o = _opts(cfg)
    c = cfg.get("claude") or {}
    r = gate.call(kind, prompt, system=o["system"], tools=o["tools"], model=o["model"], effort=o["effort"],
                  auto=True, timeout=int(float(timeout or c.get("timeout_s") or 300)), prompt_via="argv",
                  stop_event=stop_event, on_proc=on_proc, claude_bin=c.get("bin"), module="loop")
    if r["ok"]:
        return ClaudeResult(True, data=r["json"], text=r["text"], ms=r["ms"], cost_usd=r["usd"],
                            raw=r.get("envelope") or {})
    err = r["error"] or "claude 没按要求回 JSON"
    if r["refused"]:
        err = "没调用 Claude：" + err
    return ClaudeResult(False, text=r.get("text") or "", error=err, ms=r["ms"], cost_usd=r["usd"],
                        raw=r.get("envelope") or {}, refused=r["refused"])
