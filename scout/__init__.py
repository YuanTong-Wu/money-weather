"""侦察兵 (DESIGN.md §15): when something on the map looks wrong or missing, send the owner's Claude to go find out.

Modules
  common.py  paths, config, atomic JSON + file locks, time zones, tree index, plain-Chinese words
  log.py     the scout log → web/data/scout_log.json (the page's 🔎 panel; $MW_SCOUT_LOG overrides)
  detect.py  data → candidate tasks (explain / gap / verify), priority = attention/surprise, 3-day dedupe
  run.py     one task → common/claude_gate.py (`claude -p`, WebSearch/WebFetch only) → strict JSON → validated → scout/out/*
  queue.py   persistent queue (scout/out/queue.json). DESIGN §21 amendment: no count or concurrency caps (999 in
             scout/config.json); the only limit is spend, enforced by common/claude_gate.py with common/budget.json
             (owner 2026-10-28: unlimited:true; unlimited:false = all calls ≤ 6 weekly-quota points a day, automatic
             ≤ 4); every call is logged to web/data/claude_usage.json. Holdings (universe/holdings.json) go first (§20).
             A finished 'gap' job is put into the company web at once (graph/apply_patch.py --task <id>).
  job.py     start/status + route() for the server: POST /api/scout, GET /api/scout?id=, GET /api/scout/log
  selftest.py offline checks (fake claude, temp copy): points budget, count brake, concurrent drains, intel merge,
             log, dedupe, the loop's error verify, route, holdings first

Outputs (scout/out/, all tagged source:"scout", with URLs and conf; never touches owner overrides)
  intel_events.json   'explain' results, intel-shaped (§11); also merged into web/data/intel.json (the map's
                      intel layer) through intel/store.py, enriched like the owner's own intel
  graph_patches.json  'gap' results, edge-shaped (§13/§14) — the graph build may merge them under real data
  overrides_scout.json non-edge value patches from 'gap'
  fixes.json          'verify' results (renamed / delisted / merged tickers, data errors, code issues)
  answers.json        'ask' results
  runs/<id>.json      raw prompt + Claude envelope for each run (debugging)

Claude output: plain-text JSON parsed with a quote-repairing parser (config output_mode "text"). The CLI's
--json-schema mode ("schema") is kept as an option but is off: with long Chinese text Claude sometimes
mis-escapes a quote, the submit call collapses to one field, and after a few retries it submits a placeholder.
Validation rejects runs with no web use, placeholder answers, or no sourced facts; every URL is fetched
(dead → conf penalty) and checked against the URLs Claude actually saw in its searches.

Run as `python3 scout/queue.py …` or `python3 -m scout.queue …`. Each script removes scout/ from sys.path
first, because scout/queue.py would otherwise shadow the standard-library `queue` module.
"""
