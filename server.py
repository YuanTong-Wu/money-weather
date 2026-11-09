#!/usr/bin/env python3
"""钱的天气 · Money Weather — the one local backend (stdlib http.server + the project's own modules).

    python3 server.py --port 8765            → http://localhost:8765   (starts the 💓 loop in a thread)
    python3 server.py --port 8765 --no-loop  → same, without the loop (or set MW_LOOP=0)

Every feature module is imported lazily and defensively: one that is missing or broken answers
HTTP 503 {"error": "<中文说明>", "module": …} and the rest keeps working. All answers are JSON.

Routes
  GET  /api/intraday?t=MU            5-minute money flow for one ticker (cached 60 s; failure → {"error"} with 200)
  POST /api/refresh[?quick=1]        start ./update.sh in the background → {"started":true} (one at a time)
                                     ?quick=1 last 5 sessions + compute + brief (~1–2 min) · ?force=1 · ?sample=1 · ?core=1
  GET  /api/status                   {"running","mode","asOf","generatedAt","partial","log","lastRun":{steps…},"modules"}
  GET  /api/heartbeat                the loop's heartbeat (§16): live from the in-process loop, else heartbeat.json
  POST /api/scenario {text,date?,tier?}  → {"started":true,"id"}            推演 (§9), runs ~1–2 min in its own process
  GET  /api/scenario?id=             → {"id","state":"queued|running|done|error","stage","elapsed","result"?}
  DELETE /api/scenario?id=           → {"deleted":n}   (also POST /api/scenario/delete?id=)
  GET  /api/scenarios                → {"scenarios":[newest first: done ones with title/headline/track, running ones]}
  POST /api/intel {text|url}         → {"started","id"}   情报投喂 (§11) — handled by intel/job.py route()
  GET  /api/intel?id= · GET /api/intel/list · DELETE /api/intel?id= · POST /api/intel/delete?id=
  POST /api/scout {kind,target?,question?,force?} → {"id","state"} | {"state":"cached",…}   侦察兵 (§15)
  GET  /api/scout?id= · GET /api/scout/log?limit=50 → {"log":[…]} · GET /api/scout/usage
  POST /api/polymarket/refresh       re-run polymarket/fetch.py in the background → {"started":true}
  GET  /api/polymarket/status        {"running","asOf","log",…} · GET /api/polymarket/search?q=  (if polymarket/search.py)
  GET  /api/fm/stock?t=XYZ           全市场 stock file, built lazily (fullmarket/stockfile.py); the same JSON is
                                     also served at /data/fm/stocks/XYZ.json when no static file exists
  GET  /api/gl/stock?t=0700.HK       全球 stock file (§23), built lazily (globalmkt/stockfile.py); also at
                                     /data/gl/stocks/<T>.json when no static file exists
  POST /api/why {target:{kind,ids,dateIndex?|date?,map?},force?}  为什么 (§21/§24) → {"id","state":"queued",
                                     "key","ahead","position","title","facts"} | {"state":"cached","key","card"}
                                     | {"state":"refused","error","budget"} | {"state":"running","duplicate":true}
                                     kind: node|stock|day|edge|channel|landing|market   (runs in its own process)
  GET  /api/why?id=                  → {"id","key","state":"queued|running|done|error|refused","card"?,"error"?,"elapsed"}
  GET  /api/why/peek?key= | ?kind=&ids=&dateIndex=&map= | POST /api/why/peek {target}  cache only (free):
                                     {"state":"cached","card","age"} | {"state":"running","id"} | {"state":"none","key"}
  GET  /api/why                      recent cards + active jobs + budget · GET /api/why/list?limit=30
  GET  /api/budget                   today's Claude spend (§24 claude_gate.budget_status: usedPts/capPts/…)
  GET  /api/overrides                {"overrides":[…],"effective":[…]}   主人的修正 (§14, web/data/overrides.json)
  POST /api/overrides {target,field,value,note?}  → {"ok":true,"entry"} (source "owner")
  DELETE /api/overrides?id=… | ?target=…&field=…  → {"deleted":n}   (also POST /api/overrides/delete?…)
  GET  /api/modules                  which feature modules are installed / importable
  everything else                    static files from web/ (data/ and api/ are Cache-Control: no-store)

Where the modules keep their files (env defaults set here, so CLI runs by update.sh agree):
  MW_SCENARIO_DIR=web/data/scenarios  MW_INTEL_PATH=web/data/intel.json  MW_SCOUT_LOG=web/data/scout_log.json
  MW_HEARTBEAT_PATH=web/data/heartbeat.json  MW_OVERRIDES_PATH=web/data/overrides.json
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = WEB / "data"
CACHE = ROOT / "cache"
LOG = CACHE / "update.log"
LOCK = CACHE / "update.lock"
UPDATE_STATUS = CACHE / "update_status.json"
PM_LOG = CACHE / "polymarket.log"

# ── where every module reads/writes (before any module is imported: they read these at import time) ──
ENV_PATHS = {
    "MW_SCENARIO_DIR": DATA / "scenarios",
    "MW_INTEL_PATH": DATA / "intel.json",
    "MW_SCOUT_LOG": DATA / "scout_log.json",
    "MW_HEARTBEAT_PATH": DATA / "heartbeat.json",
    "MW_OVERRIDES_PATH": DATA / "overrides.json",
}
for _k, _v in ENV_PATHS.items():
    os.environ.setdefault(_k, str(_v))

# project root first (packages: scenario, intel, scout, loop, polymarket, fullmarket, graph); pipeline/ last
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "pipeline") not in sys.path:
    sys.path.append(str(ROOT / "pipeline"))

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
}
MAX_BODY = 1_000_000
TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-^=]{0,14}$")
STARTED_AT = datetime.now().isoformat(timespec="seconds")


class ApiError(Exception):
    def __init__(self, code: int, msg: str, **extra):
        super().__init__(msg)
        self.code, self.msg, self.extra = code, msg, extra


# ═══════════════════════════════════════════════════════════════════════════ lazy feature modules
class Feature:
    """A feature module that may not exist yet (other agents are writing them) — import on first use,
    retry a failed import every few seconds, never crash the server."""

    def __init__(self, name: str, zh: str, file: str, retry_s: float = 5.0):
        self.name, self.zh, self.file, self.retry_s = name, zh, ROOT / file, retry_s
        self.mod = None
        self.err: str | None = None
        self.failed_at = 0.0
        self.lock = threading.Lock()

    def present(self) -> bool:
        return self.file.exists()

    def get(self):
        if self.mod is not None:
            return self.mod
        with self.lock:
            if self.mod is not None:
                return self.mod
            if not self.present():
                raise ApiError(503, f"{self.zh}模块还没装好（{self.file.relative_to(ROOT)} 还不存在），稍后再试",
                               module=self.name)
            if self.err and time.time() - self.failed_at < self.retry_s:
                raise ApiError(503, f"{self.zh}模块加载失败：{self.err}", module=self.name)
            try:
                self.mod = importlib.import_module(self.name)
                self.err = None
                return self.mod
            except Exception as e:  # noqa: BLE001 — SyntaxError / ImportError in a half-written module
                self.err = f"{type(e).__name__}: {e}"[:300]
                self.failed_at = time.time()
                raise ApiError(503, f"{self.zh}模块加载失败：{self.err}", module=self.name) from None

    def info(self) -> dict:
        return {"module": self.name, "file": str(self.file.relative_to(ROOT)), "present": self.present(),
                "loaded": self.mod is not None, "error": self.err}


SCENARIO = Feature("scenario.job", "推演", "scenario/job.py")
INTEL = Feature("intel.job", "情报投喂", "intel/job.py")
SCOUT = Feature("scout.job", "侦察兵", "scout/job.py")
LOOPMOD = Feature("loop.runner", "心跳循环", "loop/runner.py")
PM_SEARCH = Feature("polymarket.search", "预言市场搜索", "polymarket/search.py")
STOCKFILE = Feature("fullmarket.stockfile", "全市场个股", "fullmarket/stockfile.py")
OVERRIDES = Feature("owner_overrides", "主人修正", "pipeline/owner_overrides.py")
INTRADAY = Feature("intraday", "盘中资金流", "pipeline/intraday.py")
WHY = Feature("why.job", "为什么", "why/job.py")
GATE = Feature("common.claude_gate", "Claude 额度出口", "common/claude_gate.py")
GL_STOCKFILE = Feature("globalmkt.stockfile", "全球个股", "globalmkt/stockfile.py")
FEATURES = [SCENARIO, INTEL, SCOUT, LOOPMOD, PM_SEARCH, STOCKFILE, OVERRIDES, INTRADAY, WHY, GATE, GL_STOCKFILE]
SCRIPTS = {  # run as subprocesses, not imported
    "update": "update.sh", "brief": "pipeline/brief.py", "polymarket": "polymarket/fetch.py",
    "fullmarket_fetch": "fullmarket/fetch_full.py", "fullmarket_compute": "fullmarket/compute_full.py",
    "graph": "graph/build.py", "scenario_track": "scenario/track.py", "scout_queue": "scout/queue.py",
}


def modules_info() -> dict:
    return {"imported": {f.name: f.info() for f in FEATURES},
            "scripts": {k: (ROOT / v).exists() for k, v in SCRIPTS.items()},
            "loop": loop_state()}


# ═══════════════════════════════════════════════════════════════════════════ intraday (§3)
INTRADAY_TTL = 60.0
INTRADAY_ERR_TTL = 15.0
_intra_cache: dict[str, tuple[float, dict]] = {}
_intra_locks: dict[str, threading.Lock] = {}
_intra_guard = threading.Lock()


def intraday(ticker: str) -> dict:
    mod = INTRADAY.get()  # pipeline/intraday.py (lazy: yfinance import is slow)
    t = mod.clean_ticker(ticker)
    if not t:
        return {"error": "股票代码不对", "t": ticker}
    with _intra_guard:
        lock = _intra_locks.setdefault(t, threading.Lock())
    with lock:  # one download per ticker at a time; others wait and reuse it
        hit = _intra_cache.get(t)
        now = time.time()
        if hit:
            ttl = INTRADAY_ERR_TTL if "error" in hit[1] else INTRADAY_TTL
            if now - hit[0] < ttl:
                return hit[1]
        out = mod.get_intraday(t)
        _intra_cache[t] = (time.time(), out)
        if len(_intra_cache) > 300:
            for k, _ in sorted(_intra_cache.items(), key=lambda kv: kv[1][0])[:100]:
                _intra_cache.pop(k, None)
        return out


# ═══════════════════════════════════════════════════════════════════════════ background jobs
def _read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _tail(p: Path, n: int = 15) -> str:
    try:
        return "\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
    except FileNotFoundError:
        return ""


class BgTask:
    """One background command at a time, output to a log file."""

    def __init__(self, name: str, log: Path):
        self.name, self.log = name, log
        self.proc: subprocess.Popen | None = None
        self.started_at = self.finished_at = None
        self.exit_code: int | None = None
        self.args: list[str] = []
        self.lock = threading.Lock()

    def _alive_elsewhere(self) -> bool:
        return False

    def running(self) -> bool:
        with self.lock:
            if self.proc is not None:
                rc = self.proc.poll()
                if rc is None:
                    return True
                self.exit_code = rc
                self.finished_at = self.finished_at or datetime.now().isoformat(timespec="seconds")
                self.proc = None
        return self._alive_elsewhere()

    def start(self, argv: list[str], label: str = "") -> dict:
        if self.running():
            return {"started": False, "running": True, "reason": "已经在跑了，等它跑完"}
        with self.lock:
            self.log.parent.mkdir(parents=True, exist_ok=True)
            fh = open(self.log, "w", encoding="utf-8")
            fh.write(f"[{datetime.now():%H:%M:%S}] {self.name} requested: {label or '(default)'}\n")
            fh.flush()
            env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHON=sys.executable)  # same interpreter as the server
            try:
                self.proc = subprocess.Popen(argv, cwd=str(ROOT), stdout=fh, stderr=subprocess.STDOUT,
                                             stdin=subprocess.DEVNULL, env=env, start_new_session=True)
            except OSError as e:
                fh.write(f"cannot start: {e}\n")
                return {"started": False, "error": f"起不来：{e}"}
            finally:
                fh.close()
            self.started_at = datetime.now().isoformat(timespec="seconds")
            self.finished_at = None
            self.exit_code = None
            self.args = argv[2:] if argv[:1] == ["bash"] else argv[1:]
        return {"started": True}

    def base_status(self) -> dict:
        running = self.running()
        return {"running": running, "startedAt": self.started_at, "finishedAt": self.finished_at,
                "exitCode": self.exit_code, "ok": self.exit_code in (0, None), "log": _tail(self.log)}


class Updater(BgTask):
    """update.sh in the background (it also holds its own lock dir, so a run started by the loop or by
    hand counts as running too)."""

    def _alive_elsewhere(self) -> bool:
        if not LOCK.exists():
            return False
        try:
            pid = int((LOCK / "pid").read_text().strip())
            os.kill(pid, 0)
            return True
        except (FileNotFoundError, ValueError):
            # no pid file: update.sh writes it right after mkdir, so a pid-less lock older than 2 min is debris
            # (iCloud Drive can re-create a deleted lock dir) — update.sh itself takes such a lock over
            try:
                return time.time() - LOCK.stat().st_mtime < 120
            except FileNotFoundError:
                return False
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def refresh(self, quick=False, force=False, sample=False, core=False) -> dict:
        args = ["bash", str(ROOT / "update.sh")]
        for on, flag in ((quick, "--quick"), (force, "--force"), (sample, "--sample"), (core, "--core")):
            if on:
                args.append(flag)
        out = self.start(args, " ".join(args[2:]))
        if out.get("running"):
            out["reason"] = "已经在更新了"
        if out.get("started"):
            out["mode"] = "quick" if quick else ("sample" if sample else "full")
        return out

    def status(self) -> dict:
        st = self.base_status()
        # a run started by the loop (or by hand) logs elsewhere: show whichever log was written last
        logs = [self.log, ROOT / "loop" / "out" / "steps" / "full_update.log",
                ROOT / "loop" / "out" / "steps" / "quick_refresh.log"]
        try:
            newest = max((p for p in logs if p.exists()), key=lambda p: p.stat().st_mtime)
            if newest != self.log:
                st["log"] = _tail(newest)
                st["logFile"] = str(newest.relative_to(ROOT))
        except ValueError:
            pass
        meta = _read_json(DATA / "meta.json", {}) or {}
        mode = None
        if st["running"]:
            try:
                mode = (LOCK / "mode").read_text().strip()
            except OSError:
                mode = "quick" if "--quick" in self.args else "full"
        return {**st, "mode": mode, "asOf": meta.get("asOf"), "generatedAt": meta.get("generatedAt"),
                "partial": meta.get("partial"), "lastRun": _read_json(UPDATE_STATUS),
                "server": {"startedAt": STARTED_AT, "pid": os.getpid(), "loop": loop_state()}}


UPDATER = Updater("update", LOG)
PM_TASK = BgTask("polymarket", PM_LOG)


def polymarket_status() -> dict:
    st = PM_TASK.base_status()
    pm = _read_json(DATA / "polymarket.json", {}) or {}
    return {**st, "asOf": pm.get("asOf") if isinstance(pm, dict) else None,
            "markets": len(pm.get("markets") or []) if isinstance(pm, dict) else 0,
            "installed": (ROOT / SCRIPTS["polymarket"]).exists()}


def polymarket_refresh() -> dict:
    if not (ROOT / SCRIPTS["polymarket"]).exists():
        raise ApiError(503, "预言市场模块还没装好（polymarket/fetch.py 还不存在），稍后再试", module="polymarket")
    return PM_TASK.start([sys.executable, SCRIPTS["polymarket"]], "polymarket/fetch.py")


# ═══════════════════════════════════════════════════════════════════════════ loop (§16)
LOOP_HANDLE = None
LOOP_NOTE = "没启动"


def loop_state() -> dict:
    alive = bool(LOOP_HANDLE is not None and LOOP_HANDLE.alive())
    return {"inProcess": alive, "note": "在 server 里跑" if alive else LOOP_NOTE}


def start_loop() -> None:
    global LOOP_HANDLE, LOOP_NOTE
    try:
        mod = LOOPMOD.get()
    except ApiError as e:
        LOOP_NOTE = e.msg
        print(f"  💓 loop: {e.msg}", flush=True)
        return
    fn = getattr(mod, "start_in_thread", None)
    if not callable(fn):
        LOOP_NOTE = "loop/runner.py 没有 start_in_thread()"
        print(f"  💓 loop: {LOOP_NOTE}", flush=True)
        return
    try:
        LOOP_HANDLE = fn()
    except Exception as e:  # noqa: BLE001
        LOOP_NOTE = f"心跳循环起不来：{type(e).__name__}: {e}"[:300]
        print(f"  💓 loop: {LOOP_NOTE}", flush=True)
        return
    if LOOP_HANDLE is None:
        LOOP_NOTE = "没在 server 里启动（MW_LOOP=0，或另一个心跳循环已经在跑）"
    print(f"  💓 loop: {'running in this server' if LOOP_HANDLE else LOOP_NOTE}", flush=True)


def heartbeat() -> dict:
    h, src = None, None
    if LOOP_HANDLE is not None and LOOP_HANDLE.alive():
        try:
            h, src = LOOP_HANDLE.heartbeat(), "live"
        except Exception:  # noqa: BLE001
            h = None
    if h is None:
        for p in (Path(os.environ["MW_HEARTBEAT_PATH"]), ROOT / "loop" / "out" / "heartbeat.json"):
            d = _read_json(p)
            if isinstance(d, dict):
                h, src = d, "file"
                try:
                    h["ageSec"] = int(time.time() - p.stat().st_mtime)
                except OSError:
                    pass
                break
    if h is None:
        if not LOOPMOD.present():
            raise ApiError(503, "心跳循环模块还没装好（loop/runner.py 还不存在）", module="loop.runner")
        h = {"status": "amber", "statusSay": "心跳循环没在跑（" + LOOP_NOTE + "）", "state": "stopped",
             "steps": [], "issues": []}
        src = "none"
    h = dict(h)
    h["source"] = src
    h["server"] = {"startedAt": STARTED_AT, "pid": os.getpid(), "loop": loop_state()}
    return h


# ═══════════════════════════════════════════════════════════════════════════ scenario (§9)
def _scenario_dir() -> Path:
    d = Path(os.environ["MW_SCENARIO_DIR"])
    d.mkdir(parents=True, exist_ok=True)
    return d


def scenario_start(body: dict) -> dict:
    job = SCENARIO.get()
    text = str(body.get("text") or body.get("q") or "").strip()
    date = body.get("date") or None
    tier = body.get("tier") or None
    try:
        sid = job.start(text, date=str(date) if date else None, tier=str(tier) if tier else None)
    except getattr(job, "JobError", RuntimeError) as e:
        return {"started": False, "error": str(e)}
    return {"started": True, "id": sid, "state": "queued"}


def scenario_status(sid: str) -> dict:
    job = SCENARIO.get()
    try:
        return job.status(sid)
    except getattr(job, "JobError", RuntimeError) as e:
        return {"id": sid, "state": "error", "error": str(e)}


def scenario_list(limit: int = 50) -> dict:
    job = SCENARIO.get()
    items = job.list_scenarios(limit)
    return {"scenarios": items, "running": sum(1 for i in items if i.get("state") in ("queued", "running"))}


def scenario_delete(sid: str) -> dict:
    job = SCENARIO.get()
    try:
        job._check_id(sid)  # noqa: SLF001 — the module's own id validation
    except Exception:  # noqa: BLE001
        return {"deleted": 0, "error": "推演 id 不对"}
    dirs = [_scenario_dir()]
    if hasattr(job, "work_dir"):
        dirs.append(job.work_dir())
    for d in dirs:  # stop it first if it is still running
        st = _read_json(d / f"{sid}.status.json", {}) or {}
        if st.get("state") in ("queued", "running") and st.get("pid"):
            try:
                os.killpg(int(st["pid"]), signal.SIGTERM)
            except (OSError, ValueError, TypeError):
                pass
    if callable(getattr(job, "delete", None)):  # the module's soft delete (→ trash) + index rebuild
        try:
            ok = job.delete(sid)
        except Exception as e:  # noqa: BLE001
            return {"deleted": 0, "error": f"删不掉：{type(e).__name__}: {e}"[:300]}
        if ok:
            return {"deleted": 1}
    n = 0
    for d in dirs:
        for suf in (".json", ".raw.json", ".status.json", ".log"):
            p = d / f"{sid}{suf}"
            if p.exists():
                p.unlink()
                n += 1
    return {"deleted": 1} if n else {"deleted": 0, "error": "找不到这个推演"}


# ═══════════════════════════════════════════════════════════════════════════ scout (§15)
def scout_start(body: dict) -> dict:
    job = SCOUT.get()
    kind = str(body.get("kind") or "ask").strip()
    target = body.get("target")
    question = body.get("question")
    question = str(question).strip() if question else None
    return job.start(kind, target, question, force=bool(body.get("force")))


# ═══════════════════════════════════════════════════════════════════════════ full market (fullmarket/)
_fm_lock = threading.Lock()
FM_FUNCS = ("stock_json_bytes", "build_stock_json", "stock_json", "get_stock", "stock_file", "build_stock", "make_stock", "stock", "get", "build", "load")


def fm_stock_bytes(raw: str) -> bytes:
    t = unquote(raw or "").strip().upper()
    if t.startswith("S:"):
        t = t[2:]
    if not TICKER_RE.match(t):
        raise ApiError(400, "股票代码不对", t=raw)
    for p in (DATA / "fm" / "stocks" / f"{t}.json",):
        if p.exists():
            return p.read_bytes()
    err = None
    if STOCKFILE.present():
        mod = STOCKFILE.get()
        fn = next((getattr(mod, n) for n in FM_FUNCS if callable(getattr(mod, n, None))), None)
        if fn is None:
            raise ApiError(503, "全市场个股模块里找不到生成函数（fullmarket/stockfile.py）", module=STOCKFILE.name)
        with _fm_lock:
            out = fn(t)
        if out is None:
            raise ApiError(404, f"全市场里没有 {t}", t=t)
        if isinstance(out, (bytes, bytearray)):
            return bytes(out)
        if isinstance(out, str):
            return out.encode("utf-8")
        if isinstance(out, dict) and out.get("error") and len(out) <= 3:
            raise ApiError(404, str(out["error"]), t=t)
        return json.dumps(out, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    sample = ROOT / "fullmarket" / "out" / "stocks_sample" / f"{t}.json"
    if sample.exists():
        return sample.read_bytes()
    raise ApiError(503, "全市场个股模块还没装好（fullmarket/stockfile.py 还不存在），稍后再试",
                   module=STOCKFILE.name, detail=err)


# ═══════════════════════════════════════════════════════════════════════════ global market (globalmkt/, §23)
_gl_lock = threading.Lock()
GL_TICKER_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-^=_&]{0,19}$")   # 0700.HK 600519.SS ^N225 EURUSD=X CL=F M&M.NS


def gl_stock_bytes(raw: str) -> bytes:
    """全球 stock file: a static web/data/gl/stocks/<T>.json when it exists, else built on demand by
    globalmkt/stockfile.py (phase-4 module, imported defensively — missing or half-written → 503)."""
    t = unquote(raw or "").strip().upper()
    if t.startswith("S:"):
        t = t[2:]
    if not GL_TICKER_RE.match(t) or ".." in t:
        raise ApiError(400, "股票代码不对", t=raw)
    p = DATA / "gl" / "stocks" / f"{t}.json"
    if p.exists():
        return p.read_bytes()
    if not GL_STOCKFILE.present():
        raise ApiError(503, "全球个股模块还没装好（globalmkt/stockfile.py 还不存在），稍后再试", module=GL_STOCKFILE.name)
    mod = GL_STOCKFILE.get()
    fn = next((getattr(mod, n) for n in FM_FUNCS if callable(getattr(mod, n, None))), None)
    if fn is None:
        raise ApiError(503, "全球个股模块里找不到生成函数（globalmkt/stockfile.py）", module=GL_STOCKFILE.name)
    with _gl_lock:
        out = fn(t)
    if out is None:
        raise ApiError(404, f"全球市场里没有 {t}", t=t)
    if isinstance(out, (bytes, bytearray)):
        return bytes(out)
    if isinstance(out, str):
        return out.encode("utf-8")
    if isinstance(out, dict) and out.get("error") and len(out) <= 3:
        raise ApiError(404, str(out["error"]), t=t)
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


# ═══════════════════════════════════════════════════════════════════════════ 为什么 (§21, §24) + budget
def why_start(body: dict) -> tuple[int, dict] | dict:
    job = WHY.get()
    target, force = job._target_of(body)  # noqa: SLF001 — the module's own body parser
    if target is None:
        return 400, {"state": "error", "error": "缺少 target：{kind, ids:[…], dateIndex?}"}
    out = job.start(target, force=force)
    return (400, out) if out.get("state") == "error" and not out.get("id") else out


def why_get(q: dict) -> dict:
    job = WHY.get()
    jid, key = _q(q, "id"), _q(q, "key")
    if jid:
        return job.status(jid)
    if key:
        return job.peek(key=key)
    if _q(q, "kind") or _q(q, "ids") or _q(q, "target"):
        return job.peek(target=_why_target_from_query(q))
    return job.overview()


def _why_target_from_query(q: dict):
    raw = _q(q, "target")
    if raw.strip().startswith("{"):
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(400, "target 不是合法 JSON") from None
    t = {"kind": _q(q, "kind") or "node", "ids": [x for x in _q(q, "ids").split(",") if x]}
    for k in ("dateIndex", "date", "map", "type"):
        if _q(q, k):
            t[k] = _q(q, k)
    return t


def budget() -> dict:
    """§24 budget_status() from the real gateway, else why/_shim.py's stand-in (same shape)."""
    if GATE.present():
        try:
            return GATE.get().budget_status()
        except ApiError:
            pass
    try:
        from why import _shim
        return _shim.budget_status()
    except Exception as e:  # noqa: BLE001
        raise ApiError(503, f"额度模块还没装好：{type(e).__name__}: {e}"[:300], module=GATE.name) from None


# ═══════════════════════════════════════════════════════════════════════════ overrides (§14)
def overrides_get() -> dict:
    ov = OVERRIDES.get()
    path = Path(os.environ["MW_OVERRIDES_PATH"])
    entries = ov.load(path)
    eff = ov.effective(entries)
    return {"path": "data/overrides.json", "overrides": entries, "effective": list(eff.values()),
            "count": len(entries)}


def overrides_add(body: dict) -> dict:
    ov = OVERRIDES.get()
    target = str(body.get("target") or "").strip()
    field = str(body.get("field") or "").strip()
    if not target or not field or len(target) > 200 or len(field) > 80:
        return {"ok": False, "error": "要写清楚改哪个（target）的哪一项（field）"}
    if "value" not in body:
        return {"ok": False, "error": "缺少 value（要删修正请用 DELETE）"}
    extra = {k: body[k] for k in ("basis", "conf", "url", "sources") if k in body}
    try:
        e = ov.add(target, field, body.get("value"), source="owner", note=body.get("note"), extra=extra,
                   path=Path(os.environ["MW_OVERRIDES_PATH"]))
    except ValueError as ex:
        return {"ok": False, "error": str(ex)}
    return {"ok": True, "entry": e, "say": "记下了。页面马上按你的改；地图数据下次更新时也会带上。"}


def overrides_delete(q: dict) -> dict:
    ov = OVERRIDES.get()
    ident = _q(q, "id")
    target = _q(q, "target")
    field = _q(q, "field") or None
    if not ident and not target:
        return {"deleted": 0, "error": "缺少 id 或 target"}
    try:
        n = ov.remove(ident or None, target or None, field, path=Path(os.environ["MW_OVERRIDES_PATH"]))
    except ValueError as ex:
        return {"deleted": 0, "error": str(ex)}
    return {"deleted": n} if n else {"deleted": 0, "error": "没找到这条修正"}


# ═══════════════════════════════════════════════════════════════════════════ one-time path migration
def migrate_paths() -> list[str]:
    """Modules used to keep their files under <module>/out/; the page reads web/data/. Copy what exists
    over once (never overwriting), so earlier results — which cost the owner's Claude quota — stay visible.
    (Saved scenarios are moved by the scenario module itself.)"""
    notes = []
    pairs = [(ROOT / "scout" / "out" / "scout_log.json", Path(os.environ["MW_SCOUT_LOG"])),
             (ROOT / "intel" / "out" / "intel.json", Path(os.environ["MW_INTEL_PATH"])),
             (ROOT / "loop" / "out" / "heartbeat.json", Path(os.environ["MW_HEARTBEAT_PATH"]))]
    for src, dst in pairs:
        try:
            if src.exists() and not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                notes.append(f"{src.relative_to(ROOT)} → {dst.relative_to(ROOT)}")
        except OSError as e:
            notes.append(f"{src.name}: {e}")
    try:
        if OVERRIDES.present():
            OVERRIDES.get().ensure_file(Path(os.environ["MW_OVERRIDES_PATH"]))
    except Exception:  # noqa: BLE001
        pass
    return notes


# ═══════════════════════════════════════════════════════════════════════════ HTTP
def _q(q: dict, k: str, default: str = "") -> str:
    v = q.get(k)
    if isinstance(v, list):
        return v[0] if v else default
    return v if v is not None else default


def _flag(q: dict, k: str) -> bool:
    return _q(q, k, "0").lower() in ("1", "true", "yes", "on")


FM_STOCK_PATH = re.compile(r"^/data/fm/stocks/([^/]+)\.json$")
GL_STOCK_PATH = re.compile(r"^/data/gl/stocks/([^/]+)\.json$")


class Handler(SimpleHTTPRequestHandler):
    server_version = "MoneyWeather/2.0"
    protocol_version = "HTTP/1.1"
    verbose = False

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    # ---- helpers
    def guess_type(self, path):  # noqa: D401
        ext = os.path.splitext(str(path))[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        p = urlparse(getattr(self, "path", "") or "").path  # no path yet when the request line was malformed
        if p.startswith("/api/") or p.startswith("/data/"):
            self.send_header("Cache-Control", "no-store, max-age=0")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_body(self, body: bytes, code: int = 200, ctype: str = "application/json; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, code: int = 200) -> None:
        try:
            body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except ValueError:  # NaN somewhere in a module's answer → null instead of a crash
            body = json.dumps(_clean_nan(obj), ensure_ascii=False).encode("utf-8")
        self.send_body(body, code)

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    def log_request(self, code="-", size="-"):
        try:
            c = int(code)
        except (TypeError, ValueError):
            c = 0
        path = getattr(self, "path", "") or ""
        if self.verbose or c >= 400 or path.startswith("/api/"):
            sys.stderr.write(f"{self.log_date_time_string()} {getattr(self, 'command', '-')} {path} {code}\n")

    def read_body(self) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "内容太长了（上限约 1 MB）")
        return self.rfile.read(n) if n > 0 else b""

    def json_body(self, raw: bytes) -> dict:
        """JSON object body; a form-encoded body is read as fields; any other text becomes {"text": …}."""
        s = raw.decode("utf-8", "replace").strip()
        if not s:
            return {}
        if s.startswith("{"):
            try:
                d = json.loads(s)
            except ValueError:
                raise ApiError(400, "请求不是合法 JSON") from None
            if not isinstance(d, dict):
                raise ApiError(400, "请求格式不对")
            return d
        if "application/x-www-form-urlencoded" in (self.headers.get("Content-Type") or ""):
            return {k: v[0] for k, v in parse_qs(s).items()}
        return {"text": s}

    # ---- verbs
    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/") or u.path == "/api":
            return self.dispatch("GET", u, b"")
        m = FM_STOCK_PATH.match(u.path)
        if m and not (DATA / "fm" / "stocks" / f"{unquote(m.group(1))}.json").exists():
            return self.dispatch("GET", u, b"", fm_ticker=unquote(m.group(1)))
        m = GL_STOCK_PATH.match(u.path)
        if m and not (DATA / "gl" / "stocks" / f"{unquote(m.group(1))}.json").exists():
            return self.dispatch("GET", u, b"", gl_ticker=unquote(m.group(1)))
        return super().do_GET()

    def do_HEAD(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/") or u.path == "/api":
            return self.dispatch("HEAD", u, b"")
        return super().do_HEAD()

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self.read_body()
        except ApiError as e:
            return self.send_json({"error": e.msg, "started": False}, e.code)
        return self.dispatch("POST", u, body)

    def do_DELETE(self):
        u = urlparse(self.path)
        try:
            body = self.read_body()
        except ApiError as e:
            return self.send_json({"error": e.msg}, e.code)
        return self.dispatch("DELETE", u, body)

    def dispatch(self, method: str, u, body: bytes, fm_ticker: str | None = None, gl_ticker: str | None = None):
        try:
            if fm_ticker is not None:
                return self.send_body(fm_stock_bytes(fm_ticker))
            if gl_ticker is not None:
                return self.send_body(gl_stock_bytes(gl_ticker))
            out = self.route(method, u.path.rstrip("/") or "/", parse_qs(u.query), u.query, body)
            if isinstance(out, tuple):
                return self.send_json(out[1], out[0])
            if isinstance(out, (bytes, bytearray)):
                return self.send_body(bytes(out))
            return self.send_json(out)
        except ApiError as e:
            return self.send_json({"error": e.msg, **e.extra}, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 — a bug in a module must never take the server down
            try:
                self.send_json({"error": f"出错了：{type(e).__name__}: {e}"[:500]}, 500)
            except Exception:  # noqa: BLE001
                pass

    def route(self, m: str, path: str, q: dict, qs: str, body: bytes):
        read = m in ("GET", "HEAD")
        # ---- core
        if path == "/api/intraday" and read:
            return intraday(_q(q, "t") or _q(q, "ticker"))
        if path == "/api/refresh":
            if m == "POST":
                return UPDATER.refresh(quick=_flag(q, "quick"), force=_flag(q, "force"),
                                       sample=_flag(q, "sample"), core=_flag(q, "core"))
            return 405, {"error": "请用 POST /api/refresh", **UPDATER.status()}
        if path == "/api/status" and read:
            return UPDATER.status()
        if path == "/api/heartbeat" and read:
            return heartbeat()
        if path == "/api/modules" and read:
            return modules_info()
        # ---- 推演
        if path == "/api/scenario":
            if m == "POST":
                return scenario_start(self.json_body(body))
            if m == "DELETE":
                return scenario_delete(_q(q, "id"))
            if read:
                sid = _q(q, "id")
                return scenario_status(sid) if sid else scenario_list()
        if path == "/api/scenario/delete" and m == "POST":
            return scenario_delete(_q(q, "id") or str(self.json_body(body).get("id") or ""))
        if path == "/api/scenarios" and read:
            lim = _q(q, "limit")
            return scenario_list(int(lim) if lim.isdigit() else 50)
        # ---- 情报投喂 (intel/job.py owns the whole /api/intel… surface)
        if path == "/api/intel" or path.startswith("/api/intel/"):
            r = INTEL.get().route("GET" if m == "HEAD" else m, path, qs, body)
            if r is not None:
                return r
            raise ApiError(404, "没有这个情报接口")
        # ---- 侦察兵
        if path == "/api/scout":
            if m == "POST":
                return scout_start(self.json_body(body))
            if read:
                sid = _q(q, "id")
                job = SCOUT.get()
                if sid:
                    return job.status(sid)
                return {"usage": job.usage(), "log": job.log(10)}
        if path == "/api/scout/log" and read:
            lim = _q(q, "limit")
            return {"log": SCOUT.get().log(int(lim) if lim.isdigit() else 50)}
        if path == "/api/scout/usage" and read:
            return SCOUT.get().usage()
        # ---- 预言市场
        if path == "/api/polymarket/refresh":
            if m == "POST":
                return polymarket_refresh()
            return 405, {"error": "请用 POST /api/polymarket/refresh", **polymarket_status()}
        if path == "/api/polymarket/status" and read:
            return polymarket_status()
        if path == "/api/polymarket/search" and read:
            mod = PM_SEARCH.get()
            fn = getattr(mod, "search", None)
            if not callable(fn):
                raise ApiError(503, "预言市场搜索模块里没有 search()", module=PM_SEARCH.name)
            qq = _q(q, "q").strip()
            if not qq:
                return {"markets": [], "error": "缺少 q"}
            k = _q(q, "k") or _q(q, "limit")
            try:
                res = fn(qq, int(k)) if k.isdigit() else fn(qq)
            except TypeError:
                res = fn(qq)
            return res if isinstance(res, dict) else {"markets": res}
        # ---- 全市场 / 全球
        if path == "/api/fm/stock" and read:
            return fm_stock_bytes(_q(q, "t") or _q(q, "ticker"))
        if path == "/api/gl/stock" and read:
            return gl_stock_bytes(_q(q, "t") or _q(q, "ticker"))
        # ---- 为什么 + 额度
        if path == "/api/why":
            if m == "POST":
                return why_start(self.json_body(body))
            if read:
                return why_get(q)
        if path == "/api/why/peek":
            if read:
                if not (_q(q, "key") or _q(q, "kind") or _q(q, "ids") or _q(q, "target")):
                    return 400, {"state": "error", "error": "缺少 key（或 kind+ids）"}
                return why_get({k: v for k, v in q.items() if k != "id"})   # cache only, never starts a search
            if m == "POST":
                b = self.json_body(body)
                job = WHY.get()
                if b.get("key"):
                    return job.peek(key=str(b["key"]))
                target, _ = job._target_of(b)  # noqa: SLF001
                return job.peek(target=target) if target is not None else (400, {"state": "error", "error": "缺少 target"})
        if path == "/api/why/list" and read:
            lim = _q(q, "limit")
            return {"cards": WHY.get().recent(int(lim) if lim.isdigit() else 30)}
        if path == "/api/budget" and read:
            return budget()
        # ---- 主人的修正
        if path == "/api/overrides":
            if read:
                return overrides_get()
            if m == "POST":
                return overrides_add(self.json_body(body))
            if m == "DELETE":
                return overrides_delete(q)
        if path == "/api/overrides/delete" and m == "POST":
            b = self.json_body(body)
            return overrides_delete({**{k: [str(v)] for k, v in b.items() if v is not None}, **q})
        if path in ("/api", "/api/routes") and read:
            return {"routes": [ln.strip() for ln in (__doc__ or "").split("Routes", 1)[-1].split("Where the")[0]
                               .splitlines() if ln.strip().startswith(("GET", "POST", "DELETE"))]}
        raise ApiError(404 if read or m in ("POST", "DELETE") else 405, "没有这个接口", path=path)

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass


def _clean_nan(x):
    if isinstance(x, float):
        return x if x == x and x not in (float("inf"), float("-inf")) else None
    if isinstance(x, dict):
        return {k: _clean_nan(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean_nan(v) for v in x]
    return x


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    ap = argparse.ArgumentParser(description="钱的天气 local server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--no-loop", action="store_true", help="do not start the 💓 loop in this server (also: MW_LOOP=0)")
    args = ap.parse_args()
    Handler.verbose = args.verbose
    if not (DATA / "meta.json").exists():
        print("note: web/data/ is empty — run ./update.sh first (or POST /api/refresh)")
    for n in migrate_paths():
        print(f"  moved into web/data: {n}", flush=True)
    srv = Server((args.host, args.port), Handler)
    host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    print(f"钱的天气 · Money Weather → http://{host}:{args.port}   (Ctrl+C to stop)", flush=True)
    missing = [f.file.relative_to(ROOT).as_posix() for f in FEATURES if not f.present()]
    if missing:
        print(f"  not installed yet (their routes answer 503): {', '.join(missing)}", flush=True)
    global LOOP_NOTE
    if args.no_loop:
        LOOP_NOTE = "server 用了 --no-loop"
        print("  💓 loop: off (--no-loop)", flush=True)
    else:
        start_loop()

    def _term(signum, _frame):  # SIGTERM → the same clean stop as Ctrl+C (the loop's atexit hook runs)
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _term)
    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        if LOOP_HANDLE is not None:
            try:
                LOOP_HANDLE.stop(15)
            except Exception:  # noqa: BLE001
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
