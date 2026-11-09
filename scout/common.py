"""scout/common.py — shared plumbing: paths, config, atomic JSON with locks, time, tree index, words."""
from __future__ import annotations

import contextlib
import fcntl
import json
import math
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "pipeline") not in sys.path:
    sys.path.append(str(ROOT / "pipeline"))      # appended, so nothing in pipeline/ can shadow our own modules
try:
    import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 brief.py、words.js crashAt 同一条规则
except ImportError:          # a code-only sandbox without pipeline/ (scout/selftest.py copies scout/ + intel/ only)
    class CG:                # noqa: N801 — same API, never gates; the real tree always has pipeline/crashgate.py
        SIG_DAYS, NAMES = 60, {1: "急跌", 2: "崩"}
        crash_at = staticmethod(lambda px, t: None)
        gate_key = staticmethod(lambda key, crash, p: key)
        series_px = staticmethod(lambda s: None)

SCOUT = ROOT / "scout"
OUT = SCOUT / "out"
RUNS = OUT / "runs"
JOBS = OUT / "jobs"
WEB_DATA = ROOT / "web" / "data"
CONFIG_PATH = SCOUT / "config.json"
# where scout's explain results join the owner's intel layer (§11); same env var as intel/store.py
INTEL_WEB = Path(os.environ.get("MW_INTEL_PATH") or (WEB_DATA / "intel.json"))

ET = ZoneInfo("America/New_York")

# DESIGN §21 amendment: no count caps (999 = unlimited); spend is the limit (loop/usage.py: all Claude calls
# ≤ 6 weekly-quota points a day, automatic ≤ 4). One call at a time. Override in scout/config.json.
DEFAULTS: dict[str, Any] = {
    "claude_bin": "~/.local/bin/claude",
    "model": "sonnet",
    "effort": "medium",
    "output_mode": "text",
    "timeout_s": 480,
    "max_budget_usd_per_task": 3.0,
    "concurrency": 1,
    "daily_cap": 999,
    "kind_caps": {"explain": 999, "gap": 999, "verify": 999, "ask": 999},
    "owner_daily_cap": 999,
    "hard_daily_cap": 999,
    "cap_tz": "America/New_York",
    "owner_tz": "Australia/Sydney",
    "dedupe_days": 3,
    "retry_failed_after_h": 6,
    "auto_expire_h": 36,
    "owner_wait_max_s": 1500,
    "check_urls": True,
    "push_explain_to_intel": "auto",
    "min_conf_verified": 0.7,
    "detect": {
        "max_new_per_run": 6, "explain_min_depth": 2, "explain_min_abs_wind": 2.5,
        "explain_min_storm": 1.5, "explain_intel_days": 3, "gap_max_conf": 0.5,
        "gap_max_per_run": 3, "verify_zero_volume_days": 3, "verify_batch": 8,
    },
}

KINDS = ("explain", "gap", "verify", "ask")


def say(msg: str) -> None:
    """One log line on stderr (stdout is kept clean for --json output)."""
    print(f"[scout {datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ── config ──────────────────────────────────────────────────────────────────────────────────────

def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        user = {}
    except (OSError, ValueError) as e:
        say(f"config.json unreadable ({e}); using defaults")
        user = {}
    for k, v in user.items():
        if k.startswith("_"):
            continue
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


# ── time ────────────────────────────────────────────────────────────────────────────────────────

def now_utc() -> datetime:
    return datetime.now().astimezone()


def iso(dt: datetime | None = None) -> str:
    return (dt or now_utc()).isoformat(timespec="seconds")


def parse_iso(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = datetime.strptime(s[:10], "%Y-%m-%d")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    return dt


def day_key(cfg: dict | None = None, dt: datetime | None = None) -> str:
    tz = ZoneInfo((cfg or {}).get("cap_tz") or "America/New_York")
    return (dt or now_utc()).astimezone(tz).strftime("%Y-%m-%d")


def age_hours(s: Any) -> float:
    dt = parse_iso(s)
    if not dt:
        return 1e9
    return (now_utc() - dt).total_seconds() / 3600.0


def owner_time(s: Any, cfg: dict | None = None) -> str:
    """'10月28日 08:15' in the owner's local zone (AEDT)."""
    dt = parse_iso(s)
    if not dt:
        return ""
    tz = ZoneInfo((cfg or {}).get("owner_tz") or "Australia/Sydney")
    d = dt.astimezone(tz)
    return f"{d.month}月{d.day}日 {d:%H:%M}"


def today_et() -> str:
    return now_utc().astimezone(ET).strftime("%Y-%m-%d")


def days_ago(n: float) -> datetime:
    return now_utc() - timedelta(days=n)


# ── JSON files: atomic write + flock on a sidecar lock ────────────────────────────────────────

@contextlib.contextmanager
def locked(path: Path) -> Iterator[None]:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def write_json(path: Path, data: Any, indent: int | None = 1) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(clean(data), fh, ensure_ascii=False, indent=indent, allow_nan=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        say(f"cannot read {rel(path)} ({e.__class__.__name__}); treating as empty")
        return default


def clean(x: Any) -> Any:
    """No NaN/Infinity in output JSON (DESIGN §2)."""
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def update_list(path: Path, fn, limit: int = 2000) -> list:
    """Read-modify-write a JSON list under the file's lock. fn(list) -> list."""
    with locked(path):
        cur = read_json(path, [])
        if not isinstance(cur, list):
            cur = []
        out = fn(cur)
        write_json(path, out[:limit])
        return out


def rel(p: Path | str) -> str:
    try:
        return str(Path(p).resolve().relative_to(ROOT))
    except ValueError:
        return str(p)


# ── numbers & words (DESIGN §5) ─────────────────────────────────────────────────────────────────

def num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    return None


def money(m: Any) -> str:
    """USD millions → '3.2亿美元' / '850万美元'."""
    v = num(m)
    if v is None:
        return "—"
    sign = "-" if v < 0 else ""
    a = abs(v)
    if a >= 100:
        return f"{sign}{a / 100:.1f}亿美元"
    return f"{sign}{a * 100:.0f}万美元"


def pct(x: Any) -> str:
    v = num(x)
    return "—" if v is None else f"{v * 100:+.1f}%"


def wind_word(w: Any) -> str:
    v = num(w)
    if v is None:
        return "没数据"
    if v > 1.5:
        return "钱在狂涌进来"
    if v > 0.5:
        return "钱在流进来"
    if v >= -0.5:
        return "风平浪静"
    if v >= -1.5:
        return "钱在悄悄溜走"
    return "钱在大逃离"


def temp_word(t: Any) -> str:
    v = num(t)
    if v is None:
        return "没数据"
    return "很热" if v > 1.5 else "暖" if v > 0.5 else "常温" if v >= -0.5 else "凉" if v >= -1.5 else "很冷"


def pres_word(p: Any) -> str:
    v = num(p)
    if v is None:
        return "没数据"
    return "人挤人" if v >= 85 else "人多" if v >= 65 else "正常" if v >= 35 else "人少" if v >= 15 else "冷清洼地"


_SEASON_ZH = {"spring": "春", "summer": "夏", "autumn": "秋", "winter": "冬"}


def season(w: Any, dw: Any, p: Any, crash: Any = None) -> str:
    """DESIGN §8.2 → '春'/'夏'/'秋'/'冬'/''. crash = crashgate.crash_at(...) or a tree now.crash level (0/1/2):
    a node falling hard never reads 春 / 夏 / 平稳 (§8 amendment) → 秋 if p ≥ 50, else 冬."""
    w, dw, p = num(w), num(dw) or 0.0, num(p)
    if w is None or p is None:
        return ""
    k = None
    if w > 0.3 and dw > 0.3 and p < 65:
        k = "spring"
    elif w > 0.3 and p >= 65:
        k = "summer"
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = "autumn"
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = "winter"
    return _SEASON_ZH.get(CG.gate_key(k, crash, p) or "", "")


def crash_of(s: dict | None, t: int = -1) -> dict | None:
    """crashgate.crash_at on a map series (idx) or a stock file (c) at day t (−1 = last)."""
    px = CG.series_px(s) if s else None
    if not isinstance(px, list) or not px:
        return None
    return CG.crash_at(px, len(px) - 1 if t < 0 else min(t, len(px) - 1))


def crash_say(cr: Any) -> str:
    """「崩：一天跌了 19.8%」/「急跌：5天跌了 9.3%」 (the test that fired, exact), '' when no crash."""
    lv = cr.get("level", 0) if isinstance(cr, dict) else (num(cr) or 0)
    if not lv:
        return ""
    name = CG.NAMES.get(int(lv), "急跌")
    if isinstance(cr, dict):
        if cr.get("by") == "r1" and num(cr.get("r1")) is not None:
            return f"{name}：一天跌了 {abs(cr['r1']) * 100:.1f}%"
        if num(cr.get("r5")) is not None:
            return f"{name}：5天跌了 {abs(cr['r5']) * 100:.1f}%"
    return name


# ── tree index ──────────────────────────────────────────────────────────────────────────────────

class Tree:
    """Flat index over web/data/tree.json (falls back to universe/universe.json without weather)."""

    def __init__(self, raw: dict, source: str):
        self.source = source
        self.raw = raw
        self.nodes: dict[str, dict] = {}       # id → node (without children)
        self.parents: dict[str, list[str]] = {}
        self.paths: dict[str, list[str]] = {}  # first path of ids, root first, incl. self
        self.children: dict[str, list[str]] = {}
        self._walk(raw, [])

    def _walk(self, n: dict, trail: list[str]) -> None:
        if "t" in n and "id" not in n:          # universe.json stock entry
            n = {"id": "s:" + n["t"], "ticker": n["t"], "name": n.get("name", n["t"]), "note": n.get("note", ""),
                 "kind": "stock", "tags": n.get("tags", [])}
        nid = n.get("id")
        if not nid:
            return
        kids = list(n.get("children") or []) + list(n.get("stocks") or [])
        first = nid not in self.nodes
        if first:
            self.nodes[nid] = {k: v for k, v in n.items() if k not in ("children", "stocks")}
            self.nodes[nid].setdefault("kind", "stock" if nid.startswith("s:") else "region")
            self.nodes[nid].setdefault("depth", len(trail))
            self.paths[nid] = trail + [nid]
            self.children[nid] = []
        if trail:
            self.parents.setdefault(nid, [])
            if trail[-1] not in self.parents[nid]:
                self.parents[nid].append(trail[-1])
        for c in kids:
            cid = c.get("id") or ("s:" + c["t"] if "t" in c else None)
            if cid and cid not in self.children[nid]:
                self.children[nid].append(cid)
            self._walk(c, trail + [nid])

    # lookups
    def get(self, nid: str) -> dict | None:
        return self.nodes.get(nid)

    def resolve(self, ref: str) -> str | None:
        """Node id, 's:TICKER', bare ticker, or exact Chinese/English name → node id."""
        if not ref:
            return None
        ref = ref.strip()
        if ref in self.nodes:
            return ref
        t = ref.upper().lstrip("$").replace(".", "-")
        if "s:" + t in self.nodes:
            return "s:" + t
        for nid, n in self.nodes.items():
            if n.get("name") == ref:
                return nid
        return None

    def is_stock(self, nid: str) -> bool:
        return (self.nodes.get(nid) or {}).get("kind") == "stock"

    def parent(self, nid: str) -> str | None:
        p = self.parents.get(nid) or []
        return p[0] if p else None

    def ancestors(self, nid: str) -> list[str]:
        out: list[str] = []
        stack = list(self.parents.get(nid) or [])
        while stack:
            p = stack.pop(0)
            if p not in out:
                out.append(p)
                stack.extend(self.parents.get(p) or [])
        return out

    def descendants(self, nid: str) -> list[str]:
        out, stack = [], list(self.children.get(nid) or [])
        seen = set()
        while stack:
            c = stack.pop()
            if c in seen:
                continue
            seen.add(c)
            out.append(c)
            stack.extend(self.children.get(c) or [])
        return out

    def path_names(self, nid: str) -> str:
        ids = [i for i in self.paths.get(nid, []) if i != "world"]
        return " › ".join(self.nodes[i].get("name", i) for i in ids)

    def stocks_under(self, nid: str) -> list[str]:
        if self.is_stock(nid):
            return [nid]
        return [d for d in self.descendants(nid) if self.is_stock(d)]

    def regions(self) -> list[str]:
        return [i for i, n in self.nodes.items() if n.get("kind") != "stock"]


def load_tree() -> Tree | None:
    raw = read_json(WEB_DATA / "tree.json")
    if isinstance(raw, dict) and raw.get("id"):
        return Tree(raw, "web/data/tree.json")
    raw = read_json(ROOT / "universe" / "universe.json")
    if isinstance(raw, dict) and raw.get("id"):
        return Tree(raw, "universe/universe.json")
    return None


def map_file(nid: str) -> Path:
    return WEB_DATA / "maps" / (nid.replace(":", "_") + ".json")


def stock_file(ticker: str) -> Path:
    return WEB_DATA / "stocks" / (ticker + ".json")


def node_series(tree: Tree, nid: str, _cache: dict | None = None) -> dict | None:
    """Daily weather series for any node: maps/<id>.json self, else stocks/<T>.json, else parent's map."""
    cache = _cache if _cache is not None else {}
    if nid in cache:
        return cache[nid]
    s = None
    if tree.is_stock(nid):
        d = read_json(stock_file(nid[2:]))
        if isinstance(d, dict) and isinstance(d.get("wind"), list):
            s = {k: d.get(k) for k in ("wind", "temp", "pres", "storm", "front", "flow")}
    else:
        d = read_json(map_file(nid))
        if isinstance(d, dict) and isinstance(d.get("self"), dict):
            s = d["self"]
    if s is None:
        p = tree.parent(nid)
        d = read_json(map_file(p)) if p else None
        if isinstance(d, dict):
            s = (d.get("children") or {}).get(nid)
    cache[nid] = s
    return s


def at(arr: Any, i: int) -> float | None:
    if not isinstance(arr, list) or not arr:
        return None
    if i < 0:
        i = len(arr) + i
    if i < 0 or i >= len(arr):
        return None
    return num(arr[i])


def surprise(s: dict | None, t: int = -1) -> float:
    """DESIGN §6 (same formula as pipeline/brief.py and words.js) + §8.2 spring bonus."""
    if not s:
        return 0.0
    n = len(s.get("wind") or [])
    if n == 0:
        return 0.0
    t = n - 1 if t < 0 else t
    j = max(0, t - 5)
    w, w5 = at(s.get("wind"), t), at(s.get("wind"), j)
    if w is None:
        return 0.0
    tp, tp5 = at(s.get("temp"), t), at(s.get("temp"), j)
    f = at(s.get("front"), t) or 0.0
    st = at(s.get("storm"), t)
    p = at(s.get("pres"), t)
    sc = 0.45 * abs(w - (w if w5 is None else w5)) + 0.25 * abs(w)
    if tp is not None and tp5 is not None:
        sc += 0.15 * abs(tp - tp5)
    sc += 0.6 * abs(f)
    sc += 0.3 if (st is not None and st >= 0.8) else 0.0
    sc += 0.2 if (p is not None and (p >= 90 or p <= 10)) else 0.0
    if season(w, (w - w5) if w5 is not None else 0.0, p, crash_of(s, t)) == "春":   # gated (§8 amendment)
        sc += 0.5
    return round(sc, 3)


def weather_lines(tree: Tree, nid: str, cache: dict | None = None) -> list[str]:
    """Compact plain-Chinese measured weather for a prompt (numbers exact, ≤ 6 lines)."""
    n = tree.get(nid) or {}
    now = n.get("now") or {}
    s = node_series(tree, nid, cache) or {}
    w5 = at(s.get("wind"), -6)
    lines = []
    w = num(now.get("wind"))
    if w is not None:
        extra = f"，5个交易日前 {w5:+.2f}" if w5 is not None else ""
        lines.append(f"风 {w:+.2f}（{wind_word(w)}{extra}）；温度 {num(now.get('temp')) or 0:+.2f}（{temp_word(now.get('temp'))}）；"
                     f"拥挤度 {now.get('pres')}（{pres_word(now.get('pres'))}）；风暴 {now.get('storm')}；"
                     f"风向突变 {now.get('front')}（+1=刚转流入，-1=刚转流出）")
    if now:
        lines.append(f"涨跌：1日 {pct(now.get('ret1'))}，5日 {pct(now.get('ret5'))}，20日 {pct(now.get('ret20'))}；"
                     f"5日估算净流入 {money(now.get('flow5'))}；近20日日均成交 {money(now.get('dv20'))}")
    # the season the map shows (§8.2 + crash gate), so a prompt never calls a crashing place 春 / 夏
    cr = crash_of(s) if s else (now.get("crash") or None)
    w0 = num(now.get("wind"))
    w5b = at(s.get("wind"), -6) if s else None
    se = season(w0, (w0 - w5b) if (w0 is not None and w5b is not None) else 0.0, now.get("pres"), cr)
    cs = crash_say(cr)
    if se or cs:
        lines.append(f"季节 {se or '平稳'}" + (f"（{cs}，远超它平时的波动；暴跌中不读春夏）" if cs else ""))
    return lines
