"""why/gate.py — which Claude gateway to use: the real common/claude_gate.py (DESIGN §24) whenever it imports
and has call/can_spend/budget_status. If that file exists but does not load, calls are refused (nothing is
launched around the gateway). why/_shim.py is only used when the gateway file is absent or MW_WHY_GATE=shim
(tests). Re-checked on each use, so a long-running server switches by itself."""
from __future__ import annotations

import importlib
import inspect
import os
import threading
import time

from why.util import ROOT

_lock = threading.Lock()
_real = None
_last_try = 0.0
_last_err: str | None = None


def gate():
    """The gateway module (real if available, else the shim)."""
    global _real, _last_try, _last_err
    if os.environ.get("MW_WHY_GATE") == "shim":          # tests: force the stand-in
        from why import _shim
        return _shim
    if _real is not None:
        return _real
    with _lock:
        if _real is not None:
            return _real
        if (ROOT / "common" / "claude_gate.py").exists() and time.time() - _last_try > 5:
            _last_try = time.time()
            try:
                m = importlib.import_module("common.claude_gate")
                if all(callable(getattr(m, n, None)) for n in ("call", "can_spend", "budget_status")):
                    _real, _last_err = m, None
                    return m
                _last_err = "common/claude_gate.py 还缺 call/can_spend/budget_status"
            except Exception as e:  # noqa: BLE001 — a half-written gateway: refuse, never bypass it
                _last_err = f"{type(e).__name__}: {e}"[:200]
        if (ROOT / "common" / "claude_gate.py").exists():
            # DESIGN §21/§24: every Claude call goes through common/claude_gate.py. When the gateway file is
            # there but does not load (being edited, syntax error), refuse instead of launching claude around it.
            return _Refuse
    from why import _shim
    return _shim


class _Refuse:
    """Stand-in while common/claude_gate.py exists but cannot be imported: nothing is launched, nothing spent."""

    @staticmethod
    def _why() -> str:
        return f"Claude 出口 common/claude_gate.py 暂时加载不了（{_last_err or '未知原因'}），过几秒再点一次"

    @staticmethod
    def call(kind: str, prompt: str, **kw) -> dict:
        return {"ok": False, "text": "", "json": None, "usd": 0.0, "inTok": 0, "outTok": 0, "ms": 0,
                "model": None, "error": _Refuse._why(), "refused": "disabled"}

    @staticmethod
    def can_spend(auto: bool = False) -> tuple[bool, str]:
        return False, _Refuse._why()

    @staticmethod
    def budget_status() -> dict:
        return {"error": _Refuse._why(), "enabled": False}


def which() -> dict:
    g = gate()
    name = "common.claude_gate" if g is _real and _real is not None else ("refusing" if g is _Refuse else "why._shim")
    return {"gate": name, "error": _last_err}


def supports(name: str) -> bool:
    """Does the active gateway's call() take this keyword (the real one has validate/parse/retries/module…)?"""
    try:
        return name in inspect.signature(gate().call).parameters
    except (TypeError, ValueError):
        return False


def call(kind: str, prompt: str, **kw) -> dict:
    """gateway.call with only the keywords it understands (the shim has just the §24 core ones)."""
    fn = gate().call
    try:
        params = inspect.signature(fn).parameters
        if not any(p.kind == p.VAR_KEYWORD for p in params.values()):
            kw = {k: v for k, v in kw.items() if k in params}
    except (TypeError, ValueError):
        pass
    return fn(kind, prompt, **kw)


def can_spend(auto: bool = False) -> tuple[bool, str]:
    try:
        return gate().can_spend(auto)
    except TypeError:
        return gate().can_spend(auto=auto)


def budget_status() -> dict:
    return gate().budget_status()
