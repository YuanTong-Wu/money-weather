#!/usr/bin/env bash
# macro/run.sh — 宏观天气: FX majors + key futures (yfinance) + CFTC open interest → web/data/macro.json.
#   macro/run.sh            prices (30 min cache) + CFTC (12 h cache) → macro.json   (~5–30 s)
#   macro/run.sh --quick    intraday refresh (update.sh --quick): prices younger than 10 min are reused
#   macro/run.sh --force    re-download prices and CFTC
#   macro/run.sh --offline  caches only
# Free public data, no keys, no Claude. One batched Yahoo download per run (33 symbols) — polite.
# Good cadence: every 15–30 min while US futures trade (a still-forming bar is flagged `partial` and its
# volume scaled to a full day), plus once after the close.
# Exit: 0 ok · 2 no prices at all (the previous macro.json stays).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-python3}"
exec "$PY" macro/build.py "$@"
