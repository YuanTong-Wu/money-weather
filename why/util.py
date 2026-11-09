"""why/util.py — small shared plumbing: paths, JSON with locks, numbers and plain-Chinese words (DESIGN §5)."""
from __future__ import annotations

import contextlib
import fcntl
import json
import math
import os
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterator
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "pipeline") not in sys.path:
    sys.path.append(str(ROOT / "pipeline"))      # appended, so nothing in pipeline/ can shadow our own modules
import crashgate as CG  # noqa: E402  — 暴跌闸门（DESIGN §8 修订）：和 brief.py、words.js crashAt 同一条规则
WEB_DATA = Path(os.environ.get("MW_WEB_DATA") or (ROOT / "web" / "data"))
WHY_DIR = Path(os.environ.get("MW_WHY_DIR") or (WEB_DATA / "why"))          # cards (served to the page)
JOBS_DIR = Path(os.environ.get("MW_WHY_JOBS") or (ROOT / "why" / "out" / "jobs"))  # job state (not served)
CONFIG_PATH = ROOT / "why" / "config.json"

OWNER_TZ = ZoneInfo("Australia/Sydney")
ET = ZoneInfo("America/New_York")

DEFAULTS: dict[str, Any] = {
    "model": "sonnet",
    "effort": "medium",
    "timeout_s": 480,
    "tools": ["WebSearch", "WebFetch"],
    "check_urls": True,
    "retry_on_bad_card": True,
    "max_reasons": 5,
    "job_ttl_h": 72,
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        user = {}
    for k, v in (user or {}).items():
        if not str(k).startswith("_"):
            cfg[k] = v
    return cfg


# ── JSON ──────────────────────────────────────────────────────────────────────────────────────────
def clean(x: Any) -> Any:
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path: Path, data: Any, indent: int | None = 1) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(clean(data), fh, ensure_ascii=False, indent=indent, allow_nan=False)
            fh.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


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


# ── time ──────────────────────────────────────────────────────────────────────────────────────────
def now_local() -> datetime:
    return datetime.now(OWNER_TZ)


def iso_now() -> str:
    return now_local().isoformat(timespec="seconds")


def today_et() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d")


def parse_dt(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=OWNER_TZ)


def age_text(s: Any) -> str:
    """'3 小时前' / '刚刚' / '2 天前'."""
    dt = parse_dt(s)
    if not dt:
        return ""
    sec = (now_local() - dt).total_seconds()
    if sec < 90:
        return "刚刚"
    if sec < 3600:
        return f"{int(sec // 60)} 分钟前"
    if sec < 86400:
        return f"{int(sec // 3600)} 小时前"
    return f"{int(sec // 86400)} 天前"


def local_hm(s: Any) -> str:
    dt = parse_dt(s)
    return f"{dt.astimezone(OWNER_TZ):%m月%d日 %H:%M}".lstrip("0") if dt else ""


def zh_date(d: str | None, ref: str | None = None) -> str:
    """'2026-10-06' → '10月6日' (year added when it differs from ref's year)."""
    if not d or len(d) < 10:
        return d or "?"
    try:
        x = date.fromisoformat(d[:10])
    except ValueError:
        return d
    s = f"{x.month}月{x.day}日"
    if ref and ref[:4] != d[:4]:
        s = f"{x.year}年" + s
    return s


# ── numbers & words ───────────────────────────────────────────────────────────────────────────────
def num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    return None


def at(arr: Any, i: int) -> float | None:
    if not isinstance(arr, list) or not arr:
        return None
    if i < 0:
        i += len(arr)
    if 0 <= i < len(arr):
        return num(arr[i])
    return None


def money(m: Any, signed: bool = True) -> str:
    """USD millions → '+3.2亿美元' / '-850万美元'."""
    v = num(m)
    if v is None:
        return "—"
    sign = ("+" if v > 0 else "-" if v < 0 else "") if signed else ("-" if v < 0 else "")
    a = abs(v)
    if a >= 100:
        return f"{sign}{a / 100:.1f}亿美元"
    if a >= 1:
        return f"{sign}{a * 100:.0f}万美元"
    return f"{sign}{a * 100:.1f}万美元" if a > 0 else "0"


def pct(x: Any, nd: int = 1) -> str:
    v = num(x)
    return "—" if v is None else f"{v * 100:+.{nd}f}%"


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


SEASONS = {"spring": ("🌱", "春"), "summer": ("☀️", "夏"), "autumn": ("🍂", "秋"), "winter": ("❄️", "冬")}


def season(w: Any, dw: Any, p: Any, crash: Any = None) -> str | None:
    """DESIGN §8.2 → 'spring'|'summer'|'autumn'|'winter'|None. crash = crashgate.crash_at(...) result or a tree
    now.crash level (0/1/2): a node falling hard never reads 春 / 夏 / 平稳 (§8 amendment) → 秋 if p ≥ 50, else 冬."""
    w, dw, p = num(w), num(dw) or 0.0, num(p)
    if w is None or p is None:
        return None
    k = None
    if w > 0.3 and dw > 0.3 and p < 65:
        k = "spring"
    elif w > 0.3 and p >= 65:
        k = "summer"
    elif (w < -0.3 and p >= 50) or (dw < -0.6 and p >= 65):
        k = "autumn"
    elif (w < -0.3 and p < 50) or (abs(w) <= 0.3 and p < 35):
        k = "winter"
    return CG.gate_key(k, crash, p)


def crash_at(px: Any, i: int) -> dict | None:
    """crashgate.crash_at on a price-like list (map idx / stock c) at day i."""
    return CG.crash_at(px, i) if isinstance(px, list) else None


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


def has_han(s: Any) -> bool:
    return isinstance(s, str) and any("一" <= ch <= "鿿" for ch in s)
