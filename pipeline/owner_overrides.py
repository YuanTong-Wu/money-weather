#!/usr/bin/env python3
"""owner_overrides.py — the owner's corrections, applied on top of all generated data (DESIGN.md §14).

File: web/data/overrides.json (or $MW_OVERRIDES_PATH). A JSON array (a {"overrides": [...]} wrapper is
also read), one entry per correction:

    {"id": "ov-…", "target": "s:MU" | "ai-memory" | "edge:GOOGL>AVGO" | …, "field": "name" | "wind" | "ticker" | …,
     "value": …, "source": "owner" | "scout" | …, "at": "2026-10-27T23:10:00", "note": "…"}

Precedence (§14/§15): an owner entry always wins; entries from anyone else (scout, loop) only fill values
that are estimated or missing — real pipeline data beats them. For one (target, field) the newest entry of
the winning source counts. Who applies what:
  build_universe.py   field "ticker" on "s:OLD" → the stock is fetched/shown as the new symbol
                      (value null/"" → the stock is taken off the map: delisted)
  compute.py          node fields name/note/desc/emoji and weather fields wind/temp/pres/storm/front
                      (latest day) and ret1/ret5/ret20/flow5/dv20 (the `now` block)
  graph/build.py, the frontend — everything else (edges, estimates) by the same file.

    python3 pipeline/owner_overrides.py                       # list effective overrides
    python3 pipeline/owner_overrides.py add s:MU name 美光科技   # owner entry (value parsed as JSON if it can be)
    python3 pipeline/owner_overrides.py rm <id>                # remove one entry
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import secrets
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = Path(os.environ.get("MW_OVERRIDES_PATH") or (ROOT / "web" / "data" / "overrides.json"))

NODE_FIELDS = ("name", "note", "desc", "emoji")
SERIES_FIELDS = ("wind", "temp", "pres", "storm", "front")
NOW_FIELDS = SERIES_FIELDS + ("ret1", "ret5", "ret20", "flow5", "dv20")
MAX_ENTRIES = 5000


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


@contextlib.contextmanager
def _locked(path: Path = None):
    path = path or PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _read_raw(path: Path = None):
    path = path or PATH
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return None  # broken: callers must not overwrite it blindly


def _entries(raw) -> list[dict]:
    lst = raw if isinstance(raw, list) else (raw.get("overrides") if isinstance(raw, dict) else None)
    if not isinstance(lst, list):
        return []
    return [e for e in lst if isinstance(e, dict) and e.get("target") and e.get("field")]


def _write(raw, entries: list[dict], path: Path = None) -> None:
    path = path or PATH
    out = {**raw, "overrides": entries} if isinstance(raw, dict) else entries
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def load(path: Path = None) -> list[dict]:
    """All entries (oldest first, as stored). Missing or broken file → []."""
    raw = _read_raw(path)
    return _entries(raw) if raw is not None else []


def ensure_file(path: Path = None) -> bool:
    """Create an empty overrides.json so other writers (loop fixes) know the shape. True if created."""
    path = path or PATH
    if path.exists():
        return False
    with _locked(path):
        if path.exists():
            return False
        _write([], [], path)
        return True


def is_owner(e: dict) -> bool:
    return (e.get("source") or "owner") == "owner"


def effective(entries: list[dict] | None = None) -> dict[tuple[str, str], dict]:
    """(target, field) → the entry that counts. Owner beats everyone; newest wins within a source class."""
    entries = load() if entries is None else entries
    best: dict[tuple[str, str], dict] = {}
    for e in entries:
        k = (str(e["target"]), str(e["field"]))
        cur = best.get(k)
        if cur is None:
            best[k] = e
            continue
        if is_owner(cur) and not is_owner(e):
            continue
        if is_owner(e) and not is_owner(cur):
            best[k] = e
            continue
        if str(e.get("at") or "") >= str(cur.get("at") or ""):
            best[k] = e
    return best


def ticker_renames(eff: dict | None = None) -> dict[str, str | None]:
    """{"OLD": "NEW"} (or None = delisted, take it off the map) from field "ticker" on stock targets."""
    eff = effective() if eff is None else eff
    out: dict[str, str | None] = {}
    for (target, field), e in eff.items():
        if field != "ticker":
            continue
        old = target[2:] if target.startswith("s:") else target
        v = e.get("value")
        new = str(v).strip().upper().replace(".", "-") if v not in (None, "", False) else None
        if old and old.upper() != (new or ""):
            out[old.upper()] = new
    return out


def add(target: str, field: str, value, source: str = "owner", note: str | None = None,
        extra: dict | None = None, path: Path = None) -> dict:
    """Append one entry (replacing an earlier entry of the same source for the same target/field)."""
    target, field = str(target or "").strip(), str(field or "").strip()
    if not target or not field:
        raise ValueError("需要 target 和 field")
    path = path or PATH
    entry = {"id": "ov-" + datetime.now().strftime("%m%d%H%M%S") + "-" + secrets.token_hex(2),
             "target": target, "field": field, "value": value, "source": source or "owner", "at": _now()}
    if note:
        entry["note"] = str(note)[:300]
    for k, v in (extra or {}).items():
        entry.setdefault(k, v)
    with _locked(path):
        raw = _read_raw(path)
        if raw is None:
            raise ValueError("overrides.json 坏了（不是合法 JSON），先修好它再写")
        cur = _entries(raw)
        cur = [e for e in cur if not (e["target"] == target and e["field"] == field
                                      and (e.get("source") or "owner") == entry["source"])]
        cur.append(entry)
        _write(raw, cur[-MAX_ENTRIES:], path)
    return entry


def remove(ident: str | None = None, target: str | None = None, field: str | None = None,
           source: str | None = None, path: Path = None) -> int:
    """Remove by id, or every entry for (target[, field][, source]). Returns how many were removed."""
    path = path or PATH
    if not ident and not target:
        return 0
    with _locked(path):
        raw = _read_raw(path)
        if raw is None:
            raise ValueError("overrides.json 坏了（不是合法 JSON），先修好它再删")
        cur = _entries(raw)

        def hit(e):
            if ident:
                return e.get("id") == ident
            return (e["target"] == target and (field is None or e["field"] == field)
                    and (source is None or (e.get("source") or "owner") == source))

        keep = [e for e in cur if not hit(e)]
        n = len(cur) - len(keep)
        if n:
            _write(raw, keep, path)
        return n


def _main(argv: list[str]) -> int:
    if argv[:1] == ["add"] and len(argv) >= 4:
        try:
            val = json.loads(argv[3])
        except ValueError:
            val = argv[3]
        print(json.dumps(add(argv[1], argv[2], val, note=" ".join(argv[4:]) or None), ensure_ascii=False))
        return 0
    if argv[:1] == ["rm"] and len(argv) == 2:
        print(f"removed {remove(argv[1])}")
        return 0
    if argv:
        print(__doc__)
        return 2
    eff = effective()
    print(f"{PATH}: {len(load())} entries, {len(eff)} effective")
    for (t, f), e in sorted(eff.items()):
        print(f"  {t:24s} {f:10s} = {json.dumps(e.get('value'), ensure_ascii=False)[:60]:60s} "
              f"[{e.get('source') or 'owner'} {e.get('at', '')}]")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
