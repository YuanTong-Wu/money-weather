"""HTTP glue for server.py (DESIGN §9) — stdlib only, so the server can delegate in three lines:

    import scenario.api as scenario_api           # (project root on sys.path)
    hit = scenario_api.handle(method, url.path, parse_qs(url.query), body_dict_or_None)
    if hit is not None: status, payload = hit; send JSON

Routes (errors come back as {"error": "…"} with HTTP 200, like /api/intraday):
  POST   /api/scenario            {text, date?, tier?}  → {id, state:"queued"}      (starts a background job)
  GET    /api/scenario?id=<id>    → {id, state: queued|running|done|error, stage, elapsed, error?, result?}
  GET    /api/scenarios           → {scenarios:[summary…]}  (same rows as web/data/scenarios/index.json + live jobs)
  DELETE /api/scenario?id=<id>    → {deleted: bool}          (soft delete into scenario/out/trash/)
  POST   /api/scenario/track      → {tracked:[…]}            (re-score every saved scenario now; no Claude call)
Results are also readable statically: data/scenarios/index.json and data/scenarios/<id>.json.
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import job  # noqa: E402


def _q(query: dict, key: str):
    v = (query or {}).get(key)
    if isinstance(v, list):
        v = v[0] if v else None
    return v


def handle(method: str, path: str, query: dict | None = None, body: dict | None = None):
    """→ (http_status, payload) for scenario routes, or None if the path is not ours."""
    method = (method or "GET").upper()
    path = (path or "").rstrip("/")
    try:
        if path == "/api/scenarios" and method in ("GET", "HEAD"):
            return 200, {"scenarios": job.list_scenarios()}
        if path == "/api/scenario/track" and method == "POST":
            import track
            return 200, {"tracked": track.track_all()}
        if path != "/api/scenario":
            return None
        if method == "POST":
            b = body if isinstance(body, dict) else {}
            sid = job.start(str(b.get("text") or ""), (b.get("date") or None), (b.get("tier") or None))
            return 200, {"id": sid, "state": "queued"}
        if method in ("GET", "HEAD"):
            sid = _q(query, "id")
            if not sid:
                return 200, {"scenarios": job.list_scenarios()}
            return 200, job.status(str(sid))
        if method == "DELETE":
            sid = _q(query, "id") or (body or {}).get("id")
            return 200, {"deleted": job.delete(str(sid or ""))}
        return 200, {"error": f"不支持 {method}"}
    except job.JobError as e:
        return 200, {"error": str(e)}
    except Exception as e:  # noqa: BLE001 — never take the server down
        return 200, {"error": f"推演出错了：{e}"[:300]}
