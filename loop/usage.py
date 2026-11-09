"""loop/usage.py — compatibility shim: the Claude spend ledger + budget now live in common/claude_gate.py
(DESIGN §21 amendment, §24). Old callers keep working unchanged:

    from loop import usage
    ok, why = usage.can_spend(auto=True)      # automatic work stops at 4 points, owner clicks at 6
    usage.record("scout:gap", module="scout", env=cli_envelope, auto=True)
    usage.status()                            # for the 💓 panel: {"pct","capPct","autoPct","say","byKind",…}

New code should call the gateway directly (`from common import claude_gate as gate; gate.call(...)`) —
it does the budget check, the CLI run and the ledger line in one go. Settings: common/budget.json
(no longer loop/config.json → "usage"). Ledger: web/data/claude_usage.json ($MW_CLAUDE_USAGE overrides).
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_GATE_FILE = ROOT / "common" / "claude_gate.py"


def _load_gate():
    """common/claude_gate.py next to THIS checkout (a test sandbox gets its own copy, never the real one).
    Loaded by path when `common` is shadowed (polymarket/common.py runs as top-level `common` in its scripts)."""
    for name in ("common.claude_gate", "mw_gate_" + hashlib.md5(str(_GATE_FILE).encode()).hexdigest()[:8]):
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
        raise ImportError(f"Claude 额度出口不见了：{_GATE_FILE}")
    name = "mw_gate_" + hashlib.md5(str(_GATE_FILE).encode()).hexdigest()[:8]
    spec = importlib.util.spec_from_file_location(name, _GATE_FILE)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


gate = _load_gate()
USAGE_PATH = Path(os.environ.get("MW_CLAUDE_USAGE") or gate.USAGE_PATH)
KEEP_CALLS = gate.KEEP_CALLS
KEEP_DAYS = gate.KEEP_DAYS


def config() -> dict:
    return gate.config()


def record(kind: str, *, path: Path | None = None, **kw) -> dict:
    """One Claude CLI run → the ledger (see common.claude_gate.record). Never raises."""
    return gate.record(kind, path=path or USAGE_PATH, **kw)


def status(path: Path | None = None) -> dict:
    return gate.status(path or USAGE_PATH)


def can_spend(auto: bool = False, est_pct: float = 0.0, path: Path | None = None) -> tuple[bool, str]:
    return gate.can_spend(auto=auto, est_pct=est_pct, path=path or USAGE_PATH)


def budget_status(path: Path | None = None) -> dict:
    return gate.budget_status(path or USAGE_PATH)
