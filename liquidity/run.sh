#!/usr/bin/env bash
# liquidity/run.sh — 流动性气压: FRED + Treasury DTS → web/data/liquidity.json (DESIGN §23/§24).
#   liquidity/run.sh            fetch (6 h weekly / 2 h daily / RRP+DTS after each release) + compute + write   (~1–20 s)
#   liquidity/run.sh --force    re-download everything
#   liquidity/run.sh --offline  cache only
#   liquidity/run.sh --quick    (update.sh --quick) same as the default (the cache is release-aware)
# Free public data, no keys, no Claude. Safe to run any time (daily after the US close is enough:
# FRED posts the daily series the next morning, WALCL/WDTGAL/WRBWFRBL every Thursday 16:30 ET; RRP ~13:15 ET daily; DTS ~16:00 ET).
# Exit: 0 ok · 2 a required FRED series is missing (the previous liquidity.json stays).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-python3}"
exec "$PY" liquidity/build.py "$@"
