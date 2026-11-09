#!/usr/bin/env bash
# globalmkt/run.sh — the 全球 layer's job (DESIGN §23/§24): universe (weekly) → prices + FX → weather → radar → brief.
#
#   bash globalmkt/run.sh              full daily run (update.sh step 9, after the US close): every market, the last 5
#                                      sessions (--days 5, a market whose last 2-year refresh is ≥ 7 days old gets one),
#                                      then compute (web/data/gl/ + 全球雷达 + the global map's own brief.json).
#                                      Rebuilds globalmkt/universe.json first when it is ≥ 7 days old (≈ 10 min).
#   bash globalmkt/run.sh --quick      = --due (update.sh --quick passes this): only the markets whose local close
#   bash globalmkt/run.sh --due          (+30 min) passed since their last fetch — weather follows the sun: Asia →
#                                        Europe → Americas — then compute. Nothing due → exits 0 in < 1 s.
#   bash globalmkt/run.sh --watch      stay running: sleep until the next market close (+30 min), run --due, repeat.
#                                      (for a launchd agent / tmux; the loop can instead call --due every 15–30 min)
#   options: --days N (default 5) · --full (2-year refresh of every market, ≈ 15 min) · --markets cn,hk,…
#            --region asia|europe|americas · --no-fetch (compute only) · --universe (force the universe rebuild)
#            --no-universe · --brief (afterwards re-run the curated pipeline/brief.py so its 全球雷达 is fresh;
#            update.sh does that itself, so only for standalone --due runs)
# Env: PYTHON (interpreter), MW_ROOT (project root; default: the parent of this script).
# A standalone --due skips while update.sh holds cache/update.lock (update.sh runs this script itself).
# Writes globalmkt/out/run.log (appended) and globalmkt/out/run_status.json {mode, markets, steps:[{name,ok,sec}], exit}.
# One run at a time (lock dir globalmkt/cache/run.lock; a stale lock of a dead process is taken over). A full run
# waits up to 15 min for a running --due to finish; --due / --quick skip (exit 0) when another run holds the lock.
# Exit: 0 ok · 1 a step failed (old data stays — every write is atomic) · 2 bad arguments.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${MW_ROOT:-$(dirname "$HERE")}"
cd "$ROOT" || exit 1
PY="${PYTHON:-python3}"
OUT="globalmkt/out"; LOCK="globalmkt/cache/run.lock"
mkdir -p "$OUT" globalmkt/cache
LOG="$OUT/run.log"; STATUS="$OUT/run_status.json"

MODE="full" DAYS=5 FULL="" MARKETS="" REGION="" NOFETCH="" UNIV="auto" BRIEF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick|--due) MODE="due" ;;
    --watch) MODE="watch" ;;
    --full) FULL=1 ;;
    --days) DAYS="${2:-5}"; shift ;;
    --markets) MARKETS="${2:-}"; shift ;;
    --region) REGION="${2:-}"; shift ;;
    --no-fetch) NOFETCH=1 ;;
    --universe) UNIV="force" ;;
    --no-universe) UNIV="no" ;;
    --brief) BRIEF=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "run.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "watch" ]; then
  echo "$(date '+%F %T') [watch] started (pid $$)" | tee -a "$LOG"
  while true; do
    secs="$("$PY" globalmkt/glcore.py --next 2>/dev/null || echo 900)"
    case "$secs" in ''|*[!0-9]*) secs=900 ;; esac
    if [ "$secs" -gt 0 ]; then
      [ "$secs" -gt 3600 ] && secs=3600       # re-check at least hourly (clock changes, new universe)
      sleep "$secs"
      continue
    fi
    bash "$0" --due ${BRIEF:+--brief} >/dev/null 2>&1
    sleep 60
  done
fi

# ---- a standalone --due (loop / --watch) never hits Yahoo while update.sh is fetching (it calls us itself)
if [ "$MODE" = "due" ] && [ -z "${MW_UPDATE_MODE:-}" ] && [ -d cache/update.lock ]; then
  upid="$(cat cache/update.lock/pid 2>/dev/null || true)"
  if [ -n "$upid" ] && kill -0 "$upid" 2>/dev/null; then
    echo "run.sh --due: update.sh is running (pid $upid) — it runs globalmkt itself; skipping"; exit 0
  fi
fi

# ---- lock (mkdir is atomic); take over a lock whose owner is gone
take_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  local p; p="$(cat "$LOCK/pid" 2>/dev/null || true)"
  case "$p" in *[!0-9]*) p="" ;; esac
  # stale: its owner is gone, or there is no pid at all and the dir is older than 2 min (a real run writes the pid
  # right after mkdir; iCloud Drive syncing ~/Documents can re-create a deleted lock dir with only "pid 2" inside)
  if { [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; } || \
     { [ -z "$p" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +2 2>/dev/null)" ]; }; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null && { echo $$ > "$LOCK/pid"; return 0; }
  fi
  return 1
}
if ! take_lock; then
  if [ "$MODE" = "due" ]; then echo "run.sh: another globalmkt run is going — skipping this --due"; exit 0; fi
  echo "run.sh: waiting for the running globalmkt job to finish…"
  for _ in $(seq 1 180); do sleep 5; take_lock && break; done
  [ -d "$LOCK" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] || { echo "run.sh: still locked after 15 min" >&2; exit 1; }
fi
trap 'rm -rf "$LOCK"' EXIT

STEPS="" FAIL=0 T0=$(date +%s)
logl() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
step() {  # step <name> <cmd…>
  local name="$1"; shift
  local s=$(date +%s)
  logl "[$name] $*"
  "$@" >> "$LOG" 2>&1
  local rc=$?
  local sec=$(( $(date +%s) - s ))
  STEPS="${STEPS}${STEPS:+,}{\"name\":\"$name\",\"ok\":$([ $rc = 0 ] && echo true || echo false),\"rc\":$rc,\"sec\":$sec}"
  if [ $rc = 0 ]; then logl "[$name] ok in ${sec}s"; else logl "[$name] FAILED (exit $rc) after ${sec}s"; FAIL=1; fi
  return $rc
}
finish() {
  local rc=$1
  printf '{"mode":"%s","markets":"%s","startedAt":"%s","finishedAt":"%s","sec":%s,"steps":[%s],"exit":%s}\n' \
    "$MODE" "$MARKETS" "$(date -r "$T0" '+%FT%T%z')" "$(date '+%FT%T%z')" "$(( $(date +%s) - T0 ))" "$STEPS" "$rc" \
    > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  exit "$rc"
}

# ---- which markets
if [ "$MODE" = "due" ] && [ -z "$NOFETCH" ]; then
  DUE="$("$PY" globalmkt/glcore.py --due 2>>"$LOG")"
  if [ -n "$MARKETS" ]; then   # intersect with --markets
    DUE="$(echo "$DUE" | tr ',' '\n' | grep -Fx -f <(echo "$MARKETS" | tr ',' '\n') | paste -sd, -)"
  fi
  if [ -z "$DUE" ]; then echo "run.sh --due: nothing due (every market fetched after its last close)"; finish 0; fi
  MARKETS="$DUE"
fi
logl "== globalmkt run.sh mode=$MODE markets=${MARKETS:-all}${REGION:+ region=$REGION} days=$DAYS${FULL:+ full}"

# ---- universe: weekly (full mode only) — build_universe.py --fetch --validate 20 (≈ 10 min of polite Yahoo calls)
if [ "$MODE" = "full" ] && [ "$UNIV" != "no" ] && [ -f globalmkt/build_universe.py ]; then
  age_days=$(( ( $(date +%s) - $(stat -f %m globalmkt/universe.json 2>/dev/null || echo 0) ) / 86400 ))
  if [ "$UNIV" = "force" ] || [ "$age_days" -ge 7 ]; then
    step universe "$PY" globalmkt/build_universe.py --fetch --validate 20 || logl "[universe] keeping the old universe.json"
  fi
fi

# ---- prices
if [ -z "$NOFETCH" ]; then
  args=()
  [ -n "$MARKETS" ] && args+=(--markets "$MARKETS")
  [ -n "$REGION" ] && args+=(--region "$REGION")
  if [ -n "$FULL" ]; then args+=(--days 0); else args+=(--days "$DAYS" --full-every 7); fi
  step fetch "$PY" globalmkt/fetch_global.py "${args[@]}" || finish 1
fi

# ---- weather + radar + the global map's brief (compute_global.py runs candidates_global.py and brief.py --data gl)
step compute "$PY" globalmkt/compute_global.py --quiet || finish 1

if [ -n "$BRIEF" ] && [ -f pipeline/brief.py ]; then
  step brief_curated "$PY" pipeline/brief.py || true
fi
logl "== done in $(( $(date +%s) - T0 ))s (exit $FAIL)"
finish "$FAIL"
