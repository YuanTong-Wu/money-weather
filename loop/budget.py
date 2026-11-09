"""Budget guard: daily caps on Claude calls (DESIGN.md §16). Every call spends the owner's quota.

File: loop/out/budget.json = {"day":"2026-10-27", "used":{"global":3,"scout":2,"verify":1}, "log":[…]}
The day is the New York date. Writes are flock-serialised so other modules may share it:

    from loop.budget import Budget
    b = Budget.default()
    if b.try_spend("explain"):  ...call claude...   else: log "over cap"
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

from loop import settings
from loop.calendar_ny import NY


class Budget:
    def __init__(self, path: Path, caps: dict, parents: dict | None = None, clock=None):
        self.path = Path(path)
        self.caps = {k: int(v) for k, v in caps.items()}
        self.parents = parents or {}
        self.clock = clock or (lambda: datetime.now(NY))

    @classmethod
    def default(cls, cfg: dict | None = None) -> "Budget":
        cfg = cfg or settings.load_config()
        b = cfg.get("budget", {})
        return cls(settings.BUDGET_PATH, b.get("caps", {}), b.get("parents", {}))

    # ── storage
    def _today(self) -> str:
        return self.clock().astimezone(NY).date().isoformat()

    @contextlib.contextmanager
    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path.with_name(self.path.name + ".lock"), "a+") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def _read(self) -> dict:
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            d = {}
        if d.get("day") != self._today():
            d = {"day": self._today(), "used": {}, "log": []}
        d.setdefault("used", {})
        d.setdefault("log", [])
        return d

    def _write(self, d: dict) -> None:
        fd, tmp = tempfile.mkstemp(prefix=".budget.", dir=str(self.path.parent))
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    # ── logic
    def chain(self, kind: str) -> list[str]:
        out = [kind]
        for p in self.parents.get(kind, []):
            if p not in out:
                out.append(p)
        if "global" not in out:
            out.append("global")
        return out

    def _left(self, used: dict, kind: str) -> int:
        lefts = [self.caps[k] - used.get(k, 0) for k in self.chain(kind) if k in self.caps]
        return max(0, min(lefts)) if lefts else 0

    def left(self, kind: str) -> int:
        with self._locked():
            return self._left(self._read()["used"], kind)

    def try_spend(self, kind: str, n: int = 1, note: str = "") -> bool:
        """Reserve n calls of `kind` (and its parents + global). False = over cap, nothing reserved."""
        if n <= 0:
            return True
        with self._locked():
            d = self._read()
            if self._left(d["used"], kind) < n:
                return False
            for k in self.chain(kind):
                d["used"][k] = d["used"].get(k, 0) + n
            d["log"] = (d["log"] + [{"at": self.clock().isoformat(timespec="seconds"), "kind": kind, "n": n,
                                     "note": note[:120]}])[-200:]
            self._write(d)
            return True

    def refund(self, kind: str, n: int, note: str = "") -> None:
        if n <= 0:
            return
        with self._locked():
            d = self._read()
            for k in self.chain(kind):
                d["used"][k] = max(0, d["used"].get(k, 0) - n)
            d["log"] = (d["log"] + [{"at": self.clock().isoformat(timespec="seconds"), "kind": kind, "n": -n,
                                     "note": ("退回: " + note)[:120]}])[-200:]
            self._write(d)

    def status(self) -> dict:
        with self._locked():
            d = self._read()
        used = d["used"]
        return {"day": d["day"], "used": dict(used), "caps": dict(self.caps),
                "left": {k: self._left(used, k) for k in self.caps}, "today": used.get("global", 0)}
