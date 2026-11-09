#!/usr/bin/env bash
# update.sh — the daily job, the whole chain in order (DESIGN.md §2–§16, §20, §23):
#    1 build_universe  universe/parts + holdings → universe/universe.json + web/data/holdings.json  (core)
#    2 fetch           Yahoo daily prices → cache/prices.pkl               (core)
#    3 compute         weather numbers → web/data/{meta,tree,search,maps,stocks} + §14 estimates + overrides (core)
#                      (today's still-forming bar is kept, its volume scaled to a full day: meta.intraday)
#    3b realflow       真钱 beside the estimate (§23, DESIGN §8/§14): flows/realflow.py --apply web/data puts the ETF
#                      creations/redemptions (T+1 aligned) into maps (realFlow[], realEst[]), tree (node.real) and
#                      stocks (realFlow[]) — additive, `flow` stays the estimate; also rebuilds flows/aligned.json
#                      (the like-for-like estimate the 反 rule needs). Runs in every mode, after compute, before brief.
#    4 brief           今日天气预报 → web/data/brief.json                    (exit 4 if it fails)
#    4b why_facts      为什么 cards researched mid-session → today's numbers (why.job tidy --partial; free)
#   ---- optional: each runs isolated (own process group, no stdin, a timeout) — one failing never blocks the map
#    5 polymarket      预言市场 → web/data/polymarket.json
#    5b kalshi         Kalshi 预言市场 → web/data/kalshi.json  (predict/run.sh: prices, no Claude; the loop runs
#                      it itself every 30 min while the market is open + a nightly translate/map pass)
#    6 fullmarket      全市场 fetch (after the curated fetch, never at the same time) + compute
#    7 liquidity       流动性气压   liquidity/run.sh  → web/data/liquidity.json        (phase 4, if it exists)
#    8 macro           汇率+期货     macro/run.sh      → web/data/macro.json            (phase 4, if it exists)
#    9 globalmkt       全球股市     globalmkt/run.sh  → web/data/gl/                   (phase 4, if it exists)
#   10 flows           真金白银     flows/run.sh      → web/data/flows/                (phase 4, if it exists)
#   11 graph           关系网 merge → web/data/graph/                         (if graph/build.py exists)
#   12 scenario_track  re-score saved 推演 in web/data/scenarios/
#   13 brief_final     brief again when 全市场雷达 / a phase-4 layer it reads was just rebuilt
#   14 scout_detect    侦察兵: detect → queue (free); the queue is worked off by the loop, or here in the
#                      background when no loop is running (spends Claude quota within the gateway budget)
#
#   ./update.sh            everything above
#   ./update.sh --quick    fast "刷新到最新收盘": last 5 sessions only (incl. today's still-forming bar while
#                          the market is open) → compute --live → brief (+ `<mod>/run.sh --quick` for phase-4
#                          modules whose run.sh supports --quick). ~1–2 min.
#   ./update.sh --force    re-download all prices even if the cache is fresh
#   ./update.sh --sample   small sample universe (universe/sample.json); optional steps skipped
#   ./update.sh --core     only steps 1–4          --no-fm   skip the full-market step
#   ./update.sh --fm-force refresh the full market even if it was fetched after the last close
#   ./update.sh --no-global  skip the phase-4 steps 7–10
# Phase-4 module contract: `bash <mod>/run.sh` (full; cwd = project root) and, only if the script mentions
# --quick, `bash <mod>/run.sh --quick` in quick mode. Env given to them: MW_ROOT, PYTHON, MW_UPDATE_MODE
# (full|quick), MW_LOOP_RUN. Exit 0 = ok; anything else is a warning. Missing run.sh = skipped.
# Env: PYTHON (interpreter), MW_SCOUT_RUN=0 (never start a background scout drain), MW_SCOUT_DRAIN_MAX (4),
#      MW_LOOP_RUN=1 (set by loop/runner.py: the steps the loop runs itself are skipped; phase-4 steps still
#      run here unless loop/config.json or loop/settings.py names their run.sh, all within the loop's timeout),
#      MW_UPDATE_BUDGET_S (overall seconds for this run; optional steps that no longer fit are skipped),
#      MW_TIMEOUT_<STEP> (seconds, e.g. MW_TIMEOUT_GLOBALMKT=5400), MW_SKIP="flows macro" (skip by name),
#      MW_GLOBAL=0 (same as --no-global).
# Only one run at a time (lock dir cache/update.lock). Per-step results → cache/update_status.json.
# Exit codes: 0 ok (optional steps may have warned) · 1 a core step failed (old data stays) ·
#             3 already running · 4 map data written but brief.py failed.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
PY="${PYTHON:-python3}"
LOCK="cache/update.lock"
STATUS_JSON="cache/update_status.json"
mkdir -p cache

# where the feature modules keep their files (same defaults as server.py; override by exporting them)
export MW_SCENARIO_DIR="${MW_SCENARIO_DIR:-$ROOT/web/data/scenarios}"
export MW_INTEL_PATH="${MW_INTEL_PATH:-$ROOT/web/data/intel.json}"
export MW_SCOUT_LOG="${MW_SCOUT_LOG:-$ROOT/web/data/scout_log.json}"
export MW_HEARTBEAT_PATH="${MW_HEARTBEAT_PATH:-$ROOT/web/data/heartbeat.json}"
export MW_OVERRIDES_PATH="${MW_OVERRIDES_PATH:-$ROOT/web/data/overrides.json}"
export PYTHONUNBUFFERED=1
export MW_ROOT="$ROOT"
export PYTHON="$PY"

SAMPLE="" FORCE="" QUICK="" CORE="" NOFM="" FMFORCE="" NOGLOBAL=""
for a in "$@"; do
  case "$a" in
    --sample) SAMPLE="--sample" ;;
    --force) FORCE="--force" ;;
    --quick) QUICK=1 ;;
    --core) CORE=1 ;;
    --no-fm) NOFM=1 ;;
    --fm-force) FMFORCE=1 ;;
    --no-global) NOGLOBAL=1 ;;
    -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 1 ;;
  esac
done
[ "${MW_GLOBAL:-1}" = "0" ] && NOGLOBAL=1

if ! mkdir "$LOCK" 2>/dev/null; then
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    echo "removing stale lock (pid $pid is gone)"
    rm -rf "$LOCK"
    mkdir "$LOCK" || { echo "cannot take lock"; exit 3; }
  elif [ -z "$pid" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
    # a real run writes its pid right after mkdir; a pid-less lock dir older than 2 min is debris (e.g. iCloud
    # Drive syncing ~/Documents re-creates a deleted lock dir holding only a conflict copy "pid 2")
    echo "removing stale lock (no pid file, older than 2 min)"
    rm -rf "$LOCK"
    mkdir "$LOCK" || { echo "cannot take lock"; exit 3; }
  else
    echo "another update is already running (pid ${pid:-?})"
    exit 3
  fi
fi
echo $$ > "$LOCK/pid"
STEPS_TSV="$LOCK/steps.tsv"
: > "$STEPS_TSV"
MODE="full"
[ -n "$QUICK" ] && MODE="quick"
[ -n "$SAMPLE" ] && MODE="sample"
echo "$MODE" > "$LOCK/mode"
export MW_UPDATE_MODE="$MODE"
T0=$(date +%s)
STARTED="$(date +%Y-%m-%dT%H:%M:%S)"
RC=0
WARN=0

ts() { date +%H:%M:%S; }
say() { echo "[$(ts)] $*"; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$STEPS_TSV"; }

write_status() {  # cache/update_status.json — read by server.py /api/status
  "$PY" - "$STEPS_TSV" "$STATUS_JSON" "$MODE" "$STARTED" "$1" "$(( $(date +%s) - T0 ))" "$WARN" <<'PYEOF' || true
import json, os, sys
from datetime import datetime
tsv, out, mode, started, rc, sec, warn = sys.argv[1:8]
steps = []
try:
    for line in open(tsv, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 4:
            steps.append({"name": p[0], "status": p[1], "ok": p[1] in ("ok", "skip"), "sec": int(p[2] or 0),
                          "note": p[3]})
except FileNotFoundError:
    pass
obj = {"mode": mode, "startedAt": started, "finishedAt": datetime.now().isoformat(timespec="seconds"),
       "rc": int(rc), "ok": int(rc) == 0, "warnings": int(warn), "sec": int(sec), "steps": steps}
tmp = out + ".tmp"
open(tmp, "w", encoding="utf-8").write(json.dumps(obj, ensure_ascii=False, indent=1))
os.replace(tmp, out)
PYEOF
}

finish() {
  local rc=$1
  write_status "$rc"
  say "done in $(( $(date +%s) - T0 ))s (mode ${MODE}, exit ${rc}$( [ "$WARN" -gt 0 ] && echo ", ${WARN} optional step(s) with warnings"))"
  rm -rf "$LOCK"
  exit "$rc"
}
CUR=""
trap '[ -n "$CUR" ] && record "$CUR" fail 0 "interrupted"; write_status 130; rm -rf "$LOCK"; exit 130' INT TERM

N=0
LAST_OK=0
# run <name> <title> <core|opt> cmd… — prints timing, records the result, never aborts by itself
run() {
  local name="$1" title="$2" kind="$3"; shift 3
  N=$((N + 1))
  say "${N}. ${name} — ${title}"
  local s rc d note
  s=$(date +%s)
  CUR="$name"
  "$@"
  rc=$?
  CUR=""
  d=$(( $(date +%s) - s ))
  LAST_OK=0
  if [ $rc -eq 0 ]; then
    say "   ✓ ${name} ok (${d}s)"
    record "$name" ok "$d" ""
    LAST_OK=1
  else
    note="exit ${rc}"
    [ $rc -eq 124 ] && note="timeout after ${d}s"
    [ $rc -eq 127 ] && note="could not start (exit 127)"
    if [ "$kind" = "core" ]; then
      say "   ✗ FAILED: ${name} (${note}, ${d}s)"
    else
      say "   ⚠ WARNING: ${name} failed (${note}, ${d}s) — the map is still updated"
      WARN=$((WARN + 1))
    fi
    record "$name" fail "$d" "$note"
  fi
  return $rc
}
skip() {  # skip <name> <why>
  N=$((N + 1))
  say "${N}. ${1} — skipped: ${2}"
  record "$1" skip 0 "$2"
  LAST_OK=0
}
have() { [ -f "$1" ]; }

# ---- time budget: under the 💓 loop the whole run must end before the loop's own timeout for this step
DEADLINE=""
if [ -n "${MW_UPDATE_BUDGET_S:-}" ]; then
  DEADLINE=$(( T0 + MW_UPDATE_BUDGET_S ))
elif [ "${MW_LOOP_RUN:-0}" = "1" ]; then
  LOOP_TO=$("$PY" - "$MODE" <<'PYEOF' 2>/dev/null || echo 0
import json, sys
mode = sys.argv[1]
key, default = ("quick_refresh", 1200) if mode == "quick" else ("full_update", 3600)
try:
    s = (json.load(open("loop/config.json", encoding="utf-8")).get("steps") or {}).get(key) or {}
    print(int(float(s.get("timeout_s") or default)))
except Exception:
    print(default)
PYEOF
)
  [ "${LOOP_TO:-0}" -gt 0 ] 2>/dev/null || LOOP_TO=3600
  DEADLINE=$(( T0 + LOOP_TO - 120 ))   # 2 minutes of slack for the loop to read the result
fi
budget_left() { if [ -n "$DEADLINE" ]; then echo $(( DEADLINE - $(date +%s) )); else echo ""; fi; }
skipped_by_env() { case " ${MW_SKIP:-} " in *" $1 "*) return 0 ;; esac; return 1; }

# orun <name> <title> <timeout_s> cmd… — an optional step: isolated (pipeline/runstep.py: own process group,
# stdin closed, hard timeout), never more than the time budget left, MW_TIMEOUT_<NAME> overrides the limit
orun() {
  local name="$1" title="$2" to="$3"; shift 3
  if skipped_by_env "$name"; then skip "$name" "MW_SKIP"; return 0; fi
  local ev left
  ev="MW_TIMEOUT_$(echo "$name" | tr '[:lower:]-' '[:upper:]_')"
  [ -n "${!ev:-}" ] && to="${!ev}"
  left=$(budget_left)
  if [ -n "$left" ]; then
    if [ "$left" -lt 60 ]; then
      skip "$name" "time budget used up ($(( $(date +%s) - T0 ))s so far)"
      return 0
    fi
    if [ "$to" -eq 0 ] || [ "$to" -gt "$left" ]; then to=$left; fi
  fi
  run "$name" "$title" opt "$PY" pipeline/runstep.py --timeout "$to" --name "$name" -- "$@"
}

# ---------------------------------------------------------------------------------------------- core
if [ -n "$QUICK" ]; then
  # rebuild the universe only when a part file / the holdings changed (it takes < 1 s)
  newer=""
  if [ -f universe/universe.json ]; then
    newer="$(find universe/parts -name '*.json' -newer universe/universe.json 2>/dev/null | head -1)"
    [ -z "$newer" ] && [ -f universe/holdings.json ] && \
      newer="$(find universe/holdings.json -newer universe/universe.json 2>/dev/null)"
    [ -z "$newer" ] && [ -f universe/holdings.json ] && [ ! -f web/data/holdings.json ] && newer="web/data/holdings.json missing"
  fi
  if [ ! -f universe/universe.json ] || [ -n "$newer" ]; then
    run build_universe "合并地图${newer:+（${newer} 有变化）}" core "$PY" pipeline/build_universe.py $SAMPLE || finish 1
  else
    skip build_universe "quick mode (universe.json kept)"
  fi
  run fetch "最近 5 个交易日的价格（含盘中）" core "$PY" pipeline/fetch.py --quick || finish 1
  run compute "算天气（今天还没收盘的那根按全天折算）" core "$PY" pipeline/compute.py --live --quiet || finish 1
else
  # build_universe also publishes web/data/holdings.json (§20: where each holding sits on the map)
  run build_universe "合并地图 ${SAMPLE}" core "$PY" pipeline/build_universe.py $SAMPLE || finish 1
  run fetch "下载价格 ${FORCE}" core "$PY" pipeline/fetch.py $FORCE || finish 1
  # --live: while the market is open, today's bar stays (scaled to a full day) instead of the map jumping
  # back a day until the next quick refresh; after the close it changes nothing
  run compute "算天气" core "$PY" pipeline/compute.py --live || finish 1
fi
# 3b 真钱 beside the estimate (needs web/data/flows/etf.json from an earlier flows run; free, no network, ~1 s)
if have flows/realflow.py && have web/data/flows/etf.json; then
  orun realflow "真钱放到地图旁边（ETF 申赎，T+1 对齐）" 120 "$PY" flows/realflow.py --apply web/data
else
  skip realflow "flows/realflow.py or web/data/flows/etf.json not there yet"
fi
if have pipeline/brief.py; then
  run brief "今日天气预报" opt "$PY" pipeline/brief.py || { RC=4; WARN=$((WARN - 1)); }
else
  skip brief "pipeline/brief.py not there yet"
fi
# 4b 为什么 cards researched on a still-forming intraday bar: their measured side (title, facts) → the numbers
#    just computed, so after the close a 14:15 ET card shows the closing numbers (reasons kept; the card still
#    says 盘中查的). Free: no Claude. Runs in every mode, also under the loop.
if have why/job.py; then
  orun why_facts "为什么卡片换成最新的数（盘中查的那些）" 240 "$PY" -m why.job tidy --partial
fi

# ------------------------------------------------------------------------------------------ optional
if [ -n "$SAMPLE" ] || [ -n "$CORE" ]; then
  why="$( [ -n "$SAMPLE" ] && echo "sample mode" || echo "--core" )"
  for s in polymarket kalshi fullmarket liquidity macro globalmkt flows graph scenario_track scout_detect; do skip "$s" "$why"; done
  finish $RC
fi

LOOP=""
[ "${MW_LOOP_RUN:-0}" = "1" ] && LOOP=1
# steps the loop runs itself (loop/config.json cycles): skipped here under the loop and in quick mode
why_skip=""
[ -n "$QUICK" ] && why_skip="quick mode"
[ -n "$LOOP" ] && [ -z "$why_skip" ] && why_skip="the loop runs this step itself"
FM_COMPUTED=""
LAYERS_OK=""

# 5 预言市场
if [ -n "$why_skip" ]; then
  skip polymarket "$why_skip"
elif have polymarket/fetch.py; then
  orun polymarket "预言市场" 900 "$PY" polymarket/fetch.py
  # publish if the module only wrote its own out/ copy
  if [ -f polymarket/out/polymarket.json ] && { [ ! -f web/data/polymarket.json ] || [ polymarket/out/polymarket.json -nt web/data/polymarket.json ]; }; then
    cp polymarket/out/polymarket.json web/data/polymarket.json.tmp && mv web/data/polymarket.json.tmp web/data/polymarket.json \
      && say "   published polymarket/out/polymarket.json → web/data/polymarket.json"
  fi
else
  skip polymarket "polymarket/fetch.py not there yet"
fi

# 5b Kalshi (same shape as polymarket.json; quick refresh of kept markets, full discovery when the list is > 12 h old)
if [ -n "$why_skip" ]; then
  skip kalshi "$why_skip"
elif have predict/run.sh; then
  orun kalshi "Kalshi 预言市场" 600 bash predict/run.sh
else
  skip kalshi "predict/run.sh not there yet"
fi

# 6 全市场 — strictly after the curated fetch (sequential: never two Yahoo jobs at once)
if [ -n "$why_skip" ]; then
  skip fullmarket "$why_skip"
elif [ -n "$NOFM" ]; then
  skip fullmarket "--no-fm"
elif have fullmarket/fetch_full.py; then
  FM_PRICES=fullmarket/cache/prices_full.parquet
  [ -f "$FM_PRICES" ] || FM_PRICES=fullmarket/cache/prices_full.pkl
  if [ -n "$FMFORCE" ] || [ -n "$FORCE" ] || "$PY" pipeline/stale.py "$FM_PRICES"; then
    FM_ARGS=""
    for f in --incremental --append --update; do
      if grep -q -- "\"$f\"" fullmarket/fetch_full.py 2>/dev/null; then FM_ARGS="$f"; break; fi
    done
    orun fullmarket_fetch "全市场价格 ${FM_ARGS}" 7200 "$PY" fullmarket/fetch_full.py $FM_ARGS
  else
    skip fullmarket_fetch "already fetched after the last close"
  fi
  if have fullmarket/compute_full.py; then
    orun fullmarket_compute "全市场天气" 1800 "$PY" fullmarket/compute_full.py --write
    [ "$LAST_OK" = "1" ] && FM_COMPUTED=1
  else
    skip fullmarket_compute "fullmarket/compute_full.py not there yet"
  fi
else
  skip fullmarket "fullmarket/fetch_full.py not there yet"
fi

# 7–10 phase 4 (§23): liquidity (FRED) → macro (FX + futures) → global markets (Yahoo, after the US fetches,
# never at the same time) → real-money flows (may read the global map). Each is <mod>/run.sh if it exists.
p4() {  # p4 <dir> <title> <full timeout> <quick timeout>
  local mod="$1" title="$2" tf="$3" tq="$4" sh="$1/run.sh"
  if [ -n "$NOGLOBAL" ]; then skip "$mod" "--no-global"; return 0; fi
  if ! have "$sh"; then skip "$mod" "$sh not there yet"; return 0; fi
  if [ -n "$LOOP" ] && grep -qs -- "$sh" loop/config.json loop/settings.py; then
    skip "$mod" "the loop runs $sh itself"; return 0
  fi
  if [ -n "$QUICK" ]; then
    if grep -qs -- "--quick" "$sh"; then
      orun "$mod" "${title}（快速）" "$tq" bash "$sh" --quick
    else
      skip "$mod" "quick mode ($sh has no --quick)"; return 0
    fi
  else
    orun "$mod" "$title" "$tf" bash "$sh"
  fi
  [ "$LAST_OK" = "1" ] && LAYERS_OK="${LAYERS_OK} ${mod}"
  return 0
}
p4 liquidity "流动性气压（美联储资产负债表、TGA、逆回购、利差）" 900 240
p4 macro "汇率 + 期货" 1200 300
p4 globalmkt "全球股市（亚洲→欧洲→美洲）" 5400 600
p4 flows "真金白银的资金流（ETF 申赎、北向南向、稳定币、ICI）" 1800 300

# 11 关系网
if [ -n "$why_skip" ]; then
  skip graph "$why_skip"
elif have graph/build.py; then
  orun graph "关系网合并" 1200 "$PY" graph/build.py
else
  skip graph "graph/build.py not there yet"
fi

# 12 推演打分
if [ -n "$why_skip" ]; then
  skip scenario_track "$why_skip"
elif have scenario/track.py; then
  mkdir -p "$MW_SCENARIO_DIR"
  orun scenario_track "给保存的推演打分" 900 "$PY" scenario/track.py --dir "$MW_SCENARIO_DIR" --data web/data
else
  skip scenario_track "scenario/track.py not there yet"
fi

# 13 the brief ran in step 4, before today's 全市场雷达 / phase-4 layers existed → run it once more when one of
#    them was rebuilt (brief.py only uses fm/candidates.json when its asOf matches)
if have pipeline/brief.py; then
  again=""
  [ -n "$FM_COMPUTED" ] && [ -f web/data/fm/candidates.json ] && again="全市场雷达"
  for m in $LAYERS_OK; do
    case "$m" in
      liquidity) pat="liquidity.json" ;; macro) pat="macro.json" ;; globalmkt) pat="gl/" ;; flows) pat="flows/" ;; *) pat="$m/" ;;
    esac
    grep -qs -- "$pat" pipeline/brief.py && again="${again:+$again + }$m"
  done
  if [ -n "$again" ]; then
    orun brief_final "今日天气预报 + ${again}" 300 "$PY" pipeline/brief.py
  else
    skip brief_final "nothing new for the brief"
  fi
fi

# 14 侦察兵巡逻 (detect → queue; free)
if [ -n "$why_skip" ]; then
  skip scout_detect "$why_skip"
elif have scout/queue.py; then
  orun scout_detect "侦察兵巡逻（只排队，不花额度）" 600 "$PY" -m scout.queue detect
  if [ "${MW_SCOUT_RUN:-1}" != "0" ]; then
    # nobody holds the loop's lock → no loop will work the queue: start a detached drain (within the budget)
    if "$PY" -c "import fcntl,os; os.makedirs('loop/out',exist_ok=True); f=open('loop/out/loop.lock','a+'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)" 2>/dev/null; then
      mkdir -p scout/out
      nohup "$PY" -m scout.queue drain --max "${MW_SCOUT_DRAIN_MAX:-4}" >> scout/out/drain.log 2>&1 < /dev/null &
      say "   scout: no loop running → background drain started (pid $!, log scout/out/drain.log)"
    else
      say "   scout: the loop is running and will send the queued tasks out"
    fi
  fi
else
  skip scout_detect "scout/queue.py not there yet"
fi

finish $RC
