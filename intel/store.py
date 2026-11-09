"""intel/store.py — the intel layer's only file (DESIGN.md §11).

The store is a JSON **array of events, newest first**, at web/data/intel.json (served to the page as
data/intel.json, no-store like everything under /data/). Writes are atomic (temp file in the same
directory + fsync + os.replace) and serialised with an flock on a sidecar lock file, so several
background jobs, the scout and a server DELETE can touch it at the same time without losing anything.

The pipeline never writes intel.json (compute.py only prunes maps/ and stocks/), so the layer survives
every data rebuild. Measured weather is never touched from here.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent

# ── the one constant ────────────────────────────────────────────────────────────────────────────
# MW_INTEL_PATH overrides it (selftests and adversarial tests point it at a scratch file).
INTEL_PATH = Path(os.environ.get("MW_INTEL_PATH") or (ROOT / "web" / "data" / "intel.json"))
# ────────────────────────────────────────────────────────────────────────────────────────────────

OUT_DIR = ROOT / "intel" / "out"          # job files, logs (never served)
JOBS_DIR = OUT_DIR / "jobs"
LEGACY_PATH = OUT_DIR / "intel.json"      # where the layer lived before it was wired to web/data
MAX_EVENTS = 1000                         # oldest beyond this are trimmed (append-only otherwise)


@contextlib.contextmanager
def locked(path: Path | None = None):
    """Exclusive inter-process lock on `<path>.lock` (default: the store)."""
    path = Path(path or INTEL_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with open(lock_path, "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


_locked = locked                          # old name, kept for callers that used it


def atomic_write_json(path: Path, data: Any, indent: int | None = 1) -> None:
    """Write JSON so readers never see a half-written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=indent, allow_nan=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _read(path: Path | None = None, *, quarantine: bool = False) -> list[dict]:
    path = Path(path or INTEL_PATH)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        # A corrupt store must not take the app down. Only a writer (holding the lock) moves it aside
        # for a human to look at; plain readers just see "no intel".
        if quarantine:
            with contextlib.suppress(OSError):
                os.replace(path, path.with_name(path.name + ".corrupt"))
        return []
    if isinstance(data, dict):            # tolerate {"events":[…]} if someone wrote that shape
        data = data.get("events", [])
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def ensure_exists() -> Path:
    """Create an empty layer (`[]`) so the page's fetch of data/intel.json never 404s. Moves events
    from the old intel/out/intel.json once, if that file exists and the new one does not."""
    if INTEL_PATH.exists():
        return INTEL_PATH
    with locked():
        if not INTEL_PATH.exists():
            old = _read(LEGACY_PATH) if LEGACY_PATH.exists() and LEGACY_PATH != INTEL_PATH else []
            atomic_write_json(INTEL_PATH, old[:MAX_EVENTS])
            if old:
                with contextlib.suppress(OSError):
                    os.replace(LEGACY_PATH, LEGACY_PATH.with_name("intel.migrated.json"))
    return INTEL_PATH


def load() -> list[dict]:
    """All events, newest first."""
    return _read()


def _adopt(ev: dict) -> dict:
    """Events written by other modules (the scout, §15) get the same validation + enrichment as ours:
    ids checked against the map, names/paths, priced-in estimate, `reach`. Never blocks storing."""
    meta = ev.get("meta") if isinstance(ev.get("meta"), dict) else {}
    own = ev.get("source") in ("paste", "url", "claude") and "reach" in ev and "groupId" in ev
    if own or meta.get("adopted"):
        return ev
    try:
        here = str(Path(__file__).resolve().parent.parent)
        if here not in sys.path:
            sys.path.insert(0, here)
        from intel import ingest              # lazy: ingest imports this module
        return ingest.adopt_external(ev)
    except Exception as e:                    # noqa: BLE001 — store as given rather than lose it
        out = dict(ev)
        out.setdefault("groupId", out.get("id"))
        out.setdefault("meta", {})
        if isinstance(out["meta"], dict):
            out["meta"].setdefault("issues", []).append(f"adopt failed: {type(e).__name__}")
        return out


def add(events: Iterable[dict], *, normalise: bool = True) -> list[dict]:
    """Prepend events (one input's group, in order) so the file stays newest first. An event whose id
    is already stored replaces the old copy (scout re-runs upsert)."""
    new = [e for e in events if isinstance(e, dict) and e.get("id")]
    if normalise:
        new = [_adopt(e) for e in new]
    if not new:
        return load()
    with locked():
        cur = _read(quarantine=True)
        ids = {e["id"] for e in new}
        cur = [e for e in cur if e.get("id") not in ids]
        out = (new + cur)[:MAX_EVENTS]
        atomic_write_json(INTEL_PATH, out)
    return out


def delete(ident: str) -> int:
    """Delete one event by id, or every event of an input by its groupId. Returns how many went."""
    ident = (ident or "").strip()
    if not ident:
        return 0
    with locked():
        cur = _read(quarantine=True)
        keep = [e for e in cur if e.get("id") != ident and e.get("groupId") != ident]
        n = len(cur) - len(keep)
        if n:
            atomic_write_json(INTEL_PATH, keep)
    return n


def find_by_hash(input_hash: str) -> list[dict]:
    """Events that came from the same input before (used to skip re-ingesting a duplicate)."""
    if not input_hash:
        return []
    return [e for e in load() if (e.get("input") or {}).get("hash") == input_hash]


def recent_titles(n: int = 8) -> list[dict]:
    return [{"title": e.get("title", ""), "eventDate": e.get("eventDate", "")} for e in load()[:n]]
