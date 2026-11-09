#!/usr/bin/env bash
# predict/run.sh — Kalshi prediction markets → web/data/kalshi.json (same shape as polymarket.json).
#   predict/run.sh             quick: fresh prices for the kept markets (+ full discovery when the event list
#                              is older than 12 h), daily candles cached 3 h. No Claude. ~15–40 s (discovery ~3 min).
#   predict/run.sh --quick     same as no flag (for update.sh --quick)
#   predict/run.sh --full      full discovery of all open Kalshi events now
#   predict/run.sh --nightly   full discovery + Chinese for new markets + Claude mappings for low-confidence ones:
#                              ONE batched call through common/claude_gate (kind kalshi:translate, auto=True,
#                              counts against the 4 automatic points; skipped when the budget says no)
#   other flags pass through to predict/kalshi.py (--reuse-min N, --no-hist, --translate, --dry-run, --quiet)
# Exit: 0 ok · 1 no tree · 2 no events (network down, no cache) · 3 nothing kept (previous file stays).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-python3}"
exec "$PY" predict/kalshi.py "$@"
