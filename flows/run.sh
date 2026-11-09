#!/bin/bash
# flows/run.sh — real-money layer (DESIGN §23/§24): ETF creations, China/HK flows, stablecoins, CFTC COT, ICI.
# Called by update.sh step 10 ("bash flows/run.sh", full runs only, hard cap 1800 s) or by hand:
#   flows/run.sh                         # everything
#   flows/run.sh etf cot                 # only these steps
#   CN_BACKFILL=900 flows/run.sh china   # more time for the A-share ETF share backfill (default 180 s)
#   MW_FLOWS_BUDGET=1680                 # whole-run deadline in seconds (default 1680, under update.sh's 1800)
# Every step is isolated (a failing source never blocks the others) and gets min(its own cap, time left).
# Writes web/data/flows/{etf,aligned,china,stablecoins,cot,ici,index}.json; log in flows/out/run.log.
# realflow also puts the fresh real money beside the estimate on the curated map (maps/tree/stocks, additive; update.sh
# runs it again right after every compute, so a recompute never drops it).
# No Claude calls anywhere in this layer (it spends no quota). Daily data: no 15-minute mode on purpose.

cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-python3}"
LOG=flows/out/run.log
STATUS=flows/out/last_run.txt
mkdir -p flows/out
CN_BACKFILL="${CN_BACKFILL:-180}"
BUDGET="${MW_FLOWS_BUDGET:-1680}"
export PYTHONWARNINGS=ignore
T_START=$(date +%s)

# portable timeout (macOS has no coreutils timeout by default): perl alarm + exec
limit() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$secs" "$@"; }
left() { echo $(( BUDGET - ( $(date +%s) - T_START ) )); }

steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=(stablecoins cot etf realflow ici china)   # realflow/ici read etf.json; china last (elastic backfill)

touch "$STATUS"
record() {  # record <name> <ok|fail|skip> <seconds>
  grep -v "^$1 " "$STATUS" > "$STATUS.tmp" 2>/dev/null; mv "$STATUS.tmp" "$STATUS"
  echo "$1 $2 $3 $(date '+%F %T')" >> "$STATUS"
  echo "$1: $2 (${3}s)"
}
run_step() {  # run_step <name> <cap seconds> <script> [args…]
  local name=$1 cap=$2; shift 2
  local rem; rem=$(left)
  if [ "$rem" -lt 30 ]; then
    echo "[$(date '+%F %T')] -- $name skipped: run budget used up" >> "$LOG"; record "$name" skip 0; return
  fi
  [ "$cap" -gt "$rem" ] && cap=$rem
  local t0; t0=$(date +%s)
  echo "[$(date '+%F %T')] >> $name (cap ${cap}s)" >> "$LOG"
  if limit "$cap" "$PY" "$@" >> "$LOG" 2>&1; then res=ok; else res=fail; fi
  local dt=$(( $(date +%s) - t0 ))
  echo "[$(date '+%F %T')] << $name $res ${dt}s" >> "$LOG"
  record "$name" "$res" "$dt"
}

for s in "${steps[@]}"; do
  case "$s" in
    stablecoins) run_step stablecoins 300 flows/stablecoins.py ;;
    cot)         run_step cot 300 flows/cot.py ;;
    etf)         run_step etf 1200 flows/etf.py ;;
    realflow)    run_step realflow 120 flows/realflow.py --apply web/data ;;   # fresh ETF days → the curated map (additive)
    ici)         run_step ici 120 flows/ici.py ;;
    china)
      # the backfill gets what is left after ~8 min reserved for the rest of the china step
      bf=$CN_BACKFILL; room=$(( $(left) - 480 )); [ "$room" -lt "$bf" ] && bf=$room; [ "$bf" -lt 0 ] && bf=0
      run_step china $(( bf + 900 )) flows/china.py --backfill-seconds "$bf" ;;
    *) echo "unknown step $s" ;;
  esac
done
limit 120 "$PY" flows/index.py >> "$LOG" 2>&1 && echo "index: ok"
# keep the log from growing forever
tail -n 4000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
