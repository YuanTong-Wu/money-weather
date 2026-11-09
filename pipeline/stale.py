#!/usr/bin/env python3
"""stale.py — does a data file need refreshing? (used by update.sh)

    python3 pipeline/stale.py <file> [--hours H]

Exit 0 = stale (missing, or last written before the most recent US close 16:15 New York, or older than H
hours when --hours is given); exit 1 = fresh. Prints one plain line either way.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch import NY, last_close_before  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--hours", type=float, default=None)
    a = ap.parse_args()
    p = Path(a.file)
    if not p.exists():
        print(f"{p.name}: missing → refresh")
        return 0
    m = datetime.fromtimestamp(p.stat().st_mtime, NY)
    now = datetime.now(NY)
    if a.hours is not None and now - m > timedelta(hours=a.hours):
        print(f"{p.name}: older than {a.hours:g} h → refresh")
        return 0
    lc = last_close_before(now)
    if m < lc:
        print(f"{p.name}: written {m:%m-%d %H:%M} ET, before the last close {lc:%m-%d %H:%M} ET → refresh")
        return 0
    print(f"{p.name}: fresh (written {m:%m-%d %H:%M} ET, after the last close)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
