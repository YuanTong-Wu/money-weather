"""scout/log.py — the scout log: what was asked, what was found, what changed, sources, time (DESIGN §15).

A JSON array, newest first, at LOG_PATH = web/data/scout_log.json (served as data/scout_log.json, no-store), so
the page's "🔎 侦察兵" panel can read it directly or through GET /api/scout/log. $MW_SCOUT_LOG overrides it
(tests). Entries written before 2026-10-27 lived in scout/out/scout_log.json and were merged in once.

Entry
  {"id", "kind", "key", "keys", "target", "question", "source": "auto|owner|loop",
   "askedAt", "finishedAt", "ok", "state": "done|failed|invalid",
   "line":  "老风派侦察兵去查了：… → 找到了：…",     # one line for the panel
   "say":   sharp one-liner, "found": answer (≤ 500 字), "conf": 0-1,
   "sources": [{"url", "ok", "status"}], "changes": [{"file", "what"}],
   "ms", "costUsd", "webSearches", "webFetches", "model", "error",
   "finishedLocal": "10月28日 08:15" (owner's time zone, for the panel)}
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

if __name__ == "__main__" and __package__ in (None, ""):
    _here = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or ".") == _here:
        sys.path[0] = os.path.dirname(_here)          # scout/queue.py must not shadow stdlib queue

from scout.common import WEB_DATA, age_hours, read_json, update_list  # noqa: E402

# ── the one constant ────────────────────────────────────────────────────────────────────────────
LOG_PATH = Path(os.environ.get("MW_SCOUT_LOG") or (WEB_DATA / "scout_log.json"))
# ────────────────────────────────────────────────────────────────────────────────────────────────
MAX_ENTRIES = 500


def append(entry: dict) -> None:
    eid = entry.get("id")

    def fn(cur: list) -> list:
        cur = [e for e in cur if not (eid and e.get("id") == eid)]
        return [entry] + cur

    update_list(LOG_PATH, fn, limit=MAX_ENTRIES)


def read(limit: int | None = None) -> list[dict]:
    cur = read_json(LOG_PATH, [])
    if not isinstance(cur, list):
        return []
    cur = [e for e in cur if isinstance(e, dict)]
    return cur[:limit] if limit else cur


def recent(days: float, kind: str | None = None) -> list[dict]:
    return [e for e in read() if (kind is None or e.get("kind") == kind)
            and age_hours(e.get("finishedAt") or e.get("askedAt")) <= days * 24]


def keys_seen(days: float, retry_failed_after_h: float) -> set[str]:
    """Keys that must not be asked again yet: done within `days`, failed within `retry_failed_after_h`."""
    seen: set[str] = set()
    for e in read():
        h = age_hours(e.get("finishedAt") or e.get("askedAt"))
        window = days * 24 if e.get("ok") else retry_failed_after_h
        if h <= window:
            for k in [e.get("key")] + list(e.get("keys") or []):
                if k:
                    seen.add(k)
    return seen


if __name__ == "__main__":
    import json
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    for e in read(n):
        print(json.dumps({k: e.get(k) for k in ("id", "kind", "ok", "askedAt", "line", "conf")}, ensure_ascii=False))
