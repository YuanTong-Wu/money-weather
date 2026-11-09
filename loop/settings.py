"""Paths + configuration for the loop (DESIGN.md §16).

Every path the loop writes lives under OUT_DIR (loop/out/) except the heartbeat, which the page's 💓 reads
at web/data/heartbeat.json ($MW_HEARTBEAT_PATH overrides it; the self-test points it at a temp dir).

Config: built-in DEFAULTS deep-merged with loop/config.json (or $MW_LOOP_CONFIG). Unknown keys are kept,
missing keys fall back to the defaults, so an old config.json never breaks a newer loop.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOOP_DIR = ROOT / "loop"
OUT_DIR = Path(os.environ.get("MW_LOOP_OUT") or (LOOP_DIR / "out"))
WEB_DATA = ROOT / "web" / "data"

# ── the one constant: where the page's 💓 reads the heartbeat (served as data/heartbeat.json) ────────
HEARTBEAT_PATH = Path(os.environ.get("MW_HEARTBEAT_PATH") or (WEB_DATA / "heartbeat.json"))
# ────────────────────────────────────────────────────────────────────────────────────────────────

CONFIG_PATH = Path(os.environ.get("MW_LOOP_CONFIG") or (LOOP_DIR / "config.json"))
STATE_PATH = OUT_DIR / "state.json"            # schedule bookkeeping, issues, Claude log
BUDGET_PATH = OUT_DIR / "budget.json"          # Claude calls per day per kind (flock-protected)
ISSUES_MD = OUT_DIR / "issues.md"              # code-level problems for the owner / Claude Code
FIXES_PATH = OUT_DIR / "fixes.json"            # data-level fixes Claude found (ticker renames, values…)
LOCK_PATH = OUT_DIR / "loop.lock"              # single-instance lock (flock, released on crash)
LOG_PATH = OUT_DIR / "loop.log"                # rotating text log
STEP_LOG_DIR = OUT_DIR / "steps"               # last output of every step, one file per step
OVERRIDES_PATH = Path(os.environ.get("MW_OVERRIDES_PATH") or (WEB_DATA / "overrides.json"))  # §14
UPDATE_LOCK = ROOT / "cache" / "update.lock"   # update.sh's own lock dir

DEFAULTS: dict = {
    "tick_seconds": 30,
    "owner_tz": "Australia/Sydney",
    "server_status_url": "http://127.0.0.1:8765/api/status",
    "backoff_s": [30, 120, 300],
    # DESIGN §21 amendment (owner, 2026-10-27): automatic Claude work is ON — intraday patrol, after-close
    # explain, nightly gap filling, Polymarket mapping — with NO count caps; the only limit is spend (see
    # "usage": all calls ≤ 6 weekly-quota points/day, automatic ≤ 4, the last 2 kept for the owner's clicks).
    "cycles": {
        "market": {"enabled": True, "every_min": 15,
                   "steps": ["quick_refresh", "polymarket", "scout_detect", "health"]},
        "close": {"enabled": True, "after_close_min": 30,
                  "steps": ["full_update", "scenario_track", "polymarket", "scout_explain", "health"]},
        "nightly": {"enabled": True, "at": "21:00",
                    "steps": ["graph_build", "fullmarket", "scout_gaps", "polymarket_map", "health"]},
        "health": {"enabled": True, "every_min": 60, "steps": ["health"]},
    },
    "steps": {
        "quick_refresh": {"retries": 2, "timeout_s": 1200, "args": [], "fallback_every_min": 60},
        "full_update": {"retries": 2, "timeout_s": 3600, "args": []},
        "polymarket": {"retries": 1, "timeout_s": 600, "min_interval_min": 30},
        "scenario_track": {"retries": 1, "timeout_s": 900},
        # reserve_pct: the intraday patrol stops while fewer automatic points than this are left, so the
        # after-close explain of the day's anomalies still has budget (keep_for_later = the same in counts)
        "scout_detect": {"retries": 0, "timeout_s": 1800, "max_tasks": 1, "keep_for_later": 0, "reserve_pct": 1.5},
        "scout_explain": {"retries": 0, "timeout_s": 3600, "max_tasks": 3},
        "scout_gaps": {"retries": 0, "timeout_s": 3600, "max_tasks": 2},
        "graph_build": {"retries": 1, "timeout_s": 900},
        "fullmarket": {"enabled": True, "retries": 1, "timeout_s": 7200},
        "polymarket_map": {"retries": 0, "timeout_s": 1800, "max_tasks": 3},
        "health": {"retries": 0, "timeout_s": 120},
    },
    # Claude calls per New-York day, by kind. "global" bounds everything; explain/gap/ask also count against
    # "scout". DESIGN §21 amendment: no count caps (999 = unlimited) — spend is limited by "usage" below.
    # A count cap can still be set here as an extra brake (e.g. "explain": 3).
    "budget": {
        "caps": {"global": 999, "scout": 999, "explain": 999, "gap": 999, "verify": 999, "map": 999},
        "parents": {"explain": ["scout"], "gap": ["scout"], "ask": ["scout"]},
    },
    # §21: the day's Claude budget for EVERY caller = 6 percentage points of the weekly quota, automatic work
    # ≤ 4 (estimate: pct = USD / usd_per_weekly_pct; calibrate). Ledger: web/data/claude_usage.json (loop/usage.py).
    "usage": {"daily_weekly_pct": 6, "auto_weekly_pct": 4, "usd_per_weekly_pct": 1.0, "tz": "Australia/Sydney"},
    "claude": {
        "bin": "~/.local/bin/claude",
        "model": "sonnet",
        "effort": "medium",
        "timeout_s": 300,
        "tools": ["WebSearch", "WebFetch"],
    },
    "health": {
        "fresh_grace_min": 90,              # after the close, data may lag this long before it is "stale"
        "remediate_every_min": 120,         # at most one automatic re-update per this many minutes
        "ticker_fail_streak": 2,            # a ticker must fail this many updates in a row before Claude looks
        "max_tickers_per_verify": 8,
        "failed_ticker_frac_fail": 0.05,    # > 5% of tickers without data = the fetch itself is broken
        "check_server": True,
        "min_free_gb": 1.0,
    },
    # via_scout: send failing steps to scout/job.py (shared caps + scout log + 🔎 panel); false = ask Claude directly
    "verify": {"via_scout": True, "dedupe_hours": 24, "max_log_chars": 2500},
    # Command templates. {py} = this Python, {max} = how many Claude tasks the step may run.
    # A command whose script file is missing is skipped with a log line — other agents may not have
    # written it yet. The first command of a step is its primary one: if it is missing the whole step
    # is skipped; later ones are optional follow-ups.
    "commands": {
        "polymarket": [["{py}", "polymarket/fetch.py"]],
        "scenario_track": [["{py}", "scenario/track.py"], ["{py}", "intel/ingest.py", "--refresh"]],
        "graph_build": [["{py}", "graph/build.py"]],
        "fullmarket": [["{py}", "fullmarket/fetch_full.py", "--incremental"], ["{py}", "fullmarket/compute_full.py", "--write"],
                       ["{py}", "pipeline/brief.py"]],   # brief again: today's 全市场雷达 exists only after compute_full
        "polymarket_map": [["{py}", "polymarket/map.py", "--max", "{max}"]],
    },
    # scout/ CLI (§15). null = auto-detect scout/run.py|cli.py|scout.py|main.py and its subcommands.
    # Templates may use {py} {cli} {max} {kind} {target} {question} {context_file}.
    "scout": {"cli": None, "detect_cmd": None, "work_cmd": None, "verify_cmd": None},
}


def deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if k.startswith("_"):
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path: Path | None = None) -> dict:
    p = Path(path) if path else CONFIG_PATH
    user: dict = {}
    if p.exists():
        try:
            user = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger("loop").error("config: %s 读不了（%s），先用默认设置", p, e)
    return deep_merge(DEFAULTS, user)
