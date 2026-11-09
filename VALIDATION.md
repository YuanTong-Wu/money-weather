# Validation scope

Checked on 2026-11-09 for this public snapshot:

- All 133 copied Python source files parsed successfully with Python's AST parser.
- `python3 common/selftest.py` completed with `ALL PASSED`. It uses a fake Claude executable and a temporary ledger, not a real model account.
- `server.py --host 127.0.0.1 --port 8893 --no-loop`, with `MW_CLAUDE_DISABLED=1`, started successfully.
- Local GET requests to `/`, `/api/status` and `/api/budget` returned HTTP 200.

These checks cover the source and local call gateway. They do not validate third-party data coverage, live model access, every feature module, or market/forecast accuracy. The demo is synthetic and must not be read as historical investment performance.

- The synthetic generator's five tests passed; 32/64-day datasets were deterministic (sidecar verification).
- `python3 scripts/create_demo.py --check` passed against the exact 64-day, three-region, six-fictional-company dataset in this snapshot.
- Browser verification using a static server covered the world map, region drill-down and a synthetic stock detail. The static demo has no live backend/market-fetch/model API.
- Publication-only changes generalize personal holdings references, remove a security-specific priority and embedded research corrections, and avoid rendering a literal null in the date label. The author's runtime directory was not edited.
