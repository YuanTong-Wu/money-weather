"""common/claude_gate.py — the ONE gateway for every `claude -p` the system makes (DESIGN §21 amendment, §24).

Every module (为什么 why/, 推演 scenario/, 投喂 intel/, 侦察兵 scout/, 预言市场 polymarket/ translate+map, 心跳
loop/) calls Claude through here and nowhere else:

    from common import claude_gate as gate
    r = gate.call("why:node", prompt, system=SYS, tools=["WebSearch", "WebFetch"], auto=False)
    # → {"ok", "text", "json", "usd", "inTok", "outTok", "ms", "model", "error", "refused": None|"budget"|"disabled", …}
    gate.can_spend(auto=True)      # → (True, "") | (False, "自动任务今天的额度用完了（…）")
    gate.budget_status()           # → {"day","usedPts","capPts","autoUsedPts","autoCapPts","usd","usdPerPt",
                                   #    "calibrated","byKind","resetsAtLocal", …}

The rules (owner, 2026-10-28): NO count caps and NO concurrency limits anywhere. The only limit is spend:
all calls together ≤ 6 weekly-quota points per day; automatic work (auto=True) stops at 4, so the last 2
are always left for the owner's own clicks (为什么 / 推演 / 投喂 / 🔎). Points are an estimate:
points = USD / usd_per_weekly_pct (common/budget.json, `calibrated:false` until measured → the UI says 约).

What one call does
  1. budget check + an in-flight reservation (an estimate of this call's cost), atomically under a file
     lock — parallel callers never all slip through on the same last point; no queue, no waiting.
  2. `claude -p … --output-format stream-json --verbose --no-session-persistence --safe-mode
     --strict-mcp-config --tools <exactly what was passed> [--allowedTools …] --system-prompt <short>`
     in a fresh temp cwd with a minimal environment (no project files, CLAUDE.md, MCP servers, hooks or
     parent-session variables leak in; no API key — the owner's subscription).
  3. cost + tokens of every CLI run → web/data/claude_usage.json (format below, shared with the 💓 panel).
  4. JSON out: structured_output (when `schema` is passed, CLI-enforced) or the first JSON object in the
     answer; ONE retry when it is not valid JSON or `validate(obj)` lists problems.
  5. optional result cache (`cache_key`), free and instant on a hit.

A day is the owner's LOCAL date (Australia/Sydney). The day's points also restart at the weekly-quota reset
(budget.json → weekly_reset): spend before the reset belonged to last week's quota. In the last hours before
that reset, when Claude Code has recorded a fresh reading of the real weekly % (`reading` below), quota that
would otherwise expire unused may be spent (budget.json → use_before_reset; owner 2026-10-28: "能把额度用完就用完").

Ledger web/data/claude_usage.json ($MW_CLAUDE_USAGE overrides) — same shape loop/usage.py wrote, plus keys:
    {"version": 1, "updatedAt", "config": {"dailyWeeklyPct", "autoWeeklyPct", "usdPerWeeklyPct", "tz", "calibrated"},
     "days":  {"2026-10-28": {"usd", "autoUsd", "calls", "byKind": {"scout:verify": {"usd", "calls", "inTok", "outTok"}}}},
     "calls": [{"at", "day", "kind", "module", "auto", "ok", "usd", "inTok", "outTok", "cacheRead", "cacheWrite",
                "model", "ms", "note", "est"?} …newest first],
     "totalUsd", "inflight": {id: {"at", "until", "kind", "auto", "estUsd", "pid"}},
     "weekly": {"last": {"pct", "resetsAt", "readAt", "usdTotal", "source"}, "history": […]}}

CLI (python3 common/claude_gate.py …):
    status                         today's points, per kind, in-flight, boost
    reading --pct 72 [--resets 2026-10-27T19:00:00Z]   record the real weekly % (from get_usage / the usage card)
    calibrate [--apply]            usd_per_weekly_pct from two readings of the same week (Δ ledger USD / Δ %)
    test [--auto] [--model haiku]  one tiny real call, to see cost logging end to end
Env: MW_CLAUDE_BIN (a fake for tests), MW_CLAUDE_USAGE, MW_CLAUDE_BUDGET, MW_CLAUDE_CACHE,
     MW_CLAUDE_DISABLED=1 (every call refused with refused="disabled" — e.g. polymarket/fetch.py --no-llm).
"""
from __future__ import annotations

import contextlib
import copy
import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
COMMON = Path(__file__).resolve().parent
BUDGET_PATH = Path(os.environ.get("MW_CLAUDE_BUDGET") or (COMMON / "budget.json"))
USAGE_PATH = Path(os.environ.get("MW_CLAUDE_USAGE") or (ROOT / "web" / "data" / "claude_usage.json"))
CACHE_DIR = Path(os.environ.get("MW_CLAUDE_CACHE") or (COMMON / "cache"))
KEEP_CALLS = 1500
KEEP_DAYS = 35
KEEP_READINGS = 40

DEFAULTS: dict = {
    "enabled": True,
    "daily_weekly_pct": 6.0,          # all calls together, weekly-quota points per day
    "auto_weekly_pct": 4.0,           # automatic work stops here; the rest is the owner's
    "usd_per_weekly_pct": 1.0,        # estimate until calibrated (deliberately high-cost → stops early)
    "calibrated": False,
    "tz": "Australia/Sydney",
    "weekly_reset": {"at": None, "every_days": 7},
    "use_before_reset": {"enabled": False, "hours": 4, "keep_weekly_pct": 12, "keep_weekly_pct_projected": 4,
                         "max_extra_pts": 6, "reading_fresh_h": 5},
    "max_usd_per_call": 3.0,          # --max-budget-usd for one CLI run (a runaway guard, not a count cap)
    "claude_bin": "~/.local/bin/claude",
    "est_usd": {"web": 0.2, "none": 0.05},
    "system_default": "你是「钱的天气」本地系统的助手。用简体中文。严格按要求的格式回答，不要多余的话。",
}

# what a child `claude` may see of our environment (like launchd would give it). No ANTHROPIC_API_KEY:
# the owner's subscription pays, never an API key that happens to be in the shell.
KEEP_ENV = ("HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM", "PATH",
            "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
            "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS")

URL_RE = re.compile(r"https?://[^\s\"'<>)\]}，。]+")


# ═══════════════════════════════════════ config ═══════════════════════════════════════

def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if str(k).startswith("_"):
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def config() -> dict:
    """DEFAULTS deep-merged with common/budget.json (keys starting with "_" are comments). Never raises."""
    try:
        over = json.loads(BUDGET_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        over = {}
    return _merge(DEFAULTS, over if isinstance(over, dict) else {})


def _tz(c: dict) -> ZoneInfo:
    try:
        return ZoneInfo(str(c.get("tz") or "Australia/Sydney"))
    except Exception:  # noqa: BLE001
        return ZoneInfo("Australia/Sydney")


def _now(c: dict) -> datetime:
    return datetime.now(_tz(c))


def _num(x) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _dt(s) -> datetime | None:
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    if not s or not isinstance(s, str):
        return None
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ═══════════════════════════════════════ ledger file ═══════════════════════════════════════

@contextlib.contextmanager
def _locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _read(path: Path, repair: bool = False) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        d = {}
    except (OSError, ValueError):
        if repair:                                  # only under the lock: keep the broken file for a look
            with contextlib.suppress(OSError):
                os.replace(path, path.with_name(path.name + ".corrupt"))
        d = {}
    if not isinstance(d, dict):
        d = {}
    d.setdefault("version", 1)
    if not isinstance(d.get("days"), dict):
        d["days"] = {}
    if not isinstance(d.get("calls"), list):
        d["calls"] = []
    if not isinstance(d.get("inflight"), dict):
        d["inflight"] = {}
    if "totalUsd" not in d:
        d["totalUsd"] = round(sum(_num((v or {}).get("usd")) for v in d["days"].values()), 4)
    return d


def _write(path: Path, d: dict) -> None:
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=1, allow_nan=False)
            fh.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _ledger_config(c: dict) -> dict:
    return {"dailyWeeklyPct": _num(c["daily_weekly_pct"]), "autoWeeklyPct": _num(c["auto_weekly_pct"]),
            "usdPerWeeklyPct": _num(c["usd_per_weekly_pct"]), "tz": str(c["tz"]),
            "calibrated": bool(c.get("calibrated"))}


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (ProcessLookupError, ValueError, TypeError):
        return False
    except PermissionError:
        return True


def _prune_inflight(d: dict, now: datetime) -> dict:
    live = {}
    for k, v in (d.get("inflight") or {}).items():
        if not isinstance(v, dict):
            continue
        until = _dt(v.get("until"))
        if until and now > until:
            continue
        if v.get("pid") and not _pid_alive(v["pid"]):
            continue
        live[k] = v
    d["inflight"] = live
    return live


# ═══════════════════════════════════════ the day's window ═══════════════════════════════════════

def _weekly_resets(c: dict, now: datetime) -> tuple[datetime | None, datetime | None]:
    """(last weekly-quota reset ≤ now, next one) from budget.json weekly_reset {at, every_days}."""
    wr = c.get("weekly_reset") or {}
    at = _dt(wr.get("at"))
    if not at:
        return None, None
    period = timedelta(days=max(1.0, _num(wr.get("every_days")) or 7.0))
    k = math.floor((now - at) / period)
    last = at + k * period
    return last, last + period


def _window(c: dict, now: datetime) -> dict:
    tz = _tz(c)
    local = now.astimezone(tz)
    midnight = datetime(local.year, local.month, local.day, tzinfo=tz)
    nxt_mid = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), tzinfo=tz)
    last, nxt = _weekly_resets(c, now)
    start, end, end_kind = midnight, nxt_mid, "midnight"
    if last and last > midnight:
        start = last.astimezone(tz)
    if nxt and nxt < nxt_mid:
        end, end_kind = nxt.astimezone(tz), "weekly"
    word = ("今天 " if end.date() == local.date() else "明天 ") + end.strftime("%H:%M")
    return {"day": local.date().isoformat(), "midnight": midnight, "start": start, "end": end,
            "endKind": end_kind, "resetWord": word, "nextWeeklyReset": nxt, "lastWeeklyReset": last}


def _call_at(r: dict) -> datetime | None:
    return _dt(r.get("at")) if isinstance(r, dict) else None


def _window_spend(d: dict, w: dict) -> dict:
    dd = (d["days"].get(w["day"]) or {})
    usd, ausd, n = _num(dd.get("usd")), _num(dd.get("autoUsd")), int(_num(dd.get("calls")))
    by = {k: {"usd": _num(v.get("usd")), "calls": int(_num(v.get("calls")))}
          for k, v in (dd.get("byKind") or {}).items() if isinstance(v, dict)}
    same_day_end = w["end"].date().isoformat() == w["day"] and w["endKind"] == "weekly"
    if w["start"] > w["midnight"] or same_day_end:
        # a weekly reset splits today: what came before it was last week's quota (and what comes after the
        # next one belongs to the next window)
        for r in d["calls"]:
            at = _call_at(r)
            if not at or r.get("day") != w["day"] or w["start"] <= at < w["end"]:
                continue
            u = _num(r.get("usd"))
            usd -= u
            n -= 1
            if r.get("auto"):
                ausd -= u
            k = by.get(r.get("kind"))
            if k:
                k["usd"] -= u
                k["calls"] -= 1
    by = {k: v for k, v in by.items() if v["calls"] > 0 or v["usd"] > 1e-9}
    return {"usd": max(0.0, usd), "autoUsd": max(0.0, ausd), "calls": max(0, n), "byKind": by}


def _boost(c: dict, d: dict, now: datetime, per: float) -> dict | None:
    """Quota about to expire unused at the weekly reset may be spent (needs a fresh reading of the real %)."""
    ub = c.get("use_before_reset") or {}
    if not ub.get("enabled"):
        return None
    last = ((d.get("weekly") or {}).get("last") or {})
    pct, resets, read = _num(last.get("pct")), _dt(last.get("resetsAt")), _dt(last.get("readAt"))
    if not resets or not read or not (now < resets):
        return None
    if resets - now > timedelta(hours=_num(ub.get("hours")) or 4):
        return None
    if now - read > timedelta(hours=_num(ub.get("reading_fresh_h")) or 4):
        return None
    since = sum(_num(r.get("usd")) for r in d["calls"] if read <= (_call_at(r) or now) <= now) / per
    # how fast is the weekly quota going anyway (the owner's own Claude Code sessions, other work, AND this
    # system's own calls — the real % includes them)? Two readings of the same week ≥ 10 min apart → burn rate.
    hist = [h for h in ((d.get("weekly") or {}).get("history") or []) if isinstance(h, dict)
            and h.get("resetsAt") == last.get("resetsAt") and _dt(h.get("readAt"))]
    prev = next((h for h in reversed(hist) if read - _dt(h["readAt"]) >= timedelta(minutes=10)), None)
    rate = None
    if prev is not None:
        hrs = (read - _dt(prev["readAt"])).total_seconds() / 3600
        rate = max(0.0, (pct - _num(prev.get("pct"))) / hrs)
    if rate is not None:
        # project from the READING to the reset: the burn between the reading and now is already in the rate
        # (counting it again via `since`, or projecting only from now, made "expiring" GROW as the reset came
        # closer and granted points that were long gone). A fast burn needs a recent reading.
        if rate > 5.0 and now - read > timedelta(hours=1):
            return None
        expiring = max(0.0, 100.0 - pct - rate * max(0.0, (resets - read).total_seconds() / 3600))
        room = expiring - _num(ub.get("keep_weekly_pct_projected", ub.get("keep_weekly_pct")))
    else:
        expiring = max(0.0, 100.0 - pct - since)       # no rate: only what we know was spent since the reading
        room = expiring - _num(ub.get("keep_weekly_pct"))
    extra = max(0.0, min(_num(ub.get("max_extra_pts")), room))
    if extra <= 0.05:
        return None
    hm = resets.astimezone(_tz(c)).strftime("%H:%M")
    return {"extraPts": round(extra, 2), "until": resets.isoformat(timespec="minutes"), "weeklyPct": pct,
            "readAt": read.isoformat(timespec="minutes"), "burnPctPerH": None if rate is None else round(rate, 2),
            "expiringPct": round(expiring, 1),
            "say": f"周额度 {hm} 重置前大约还有 {max(0.0, expiring):.0f}% 会白白作废，多给 {extra:.1f} 个点把它用掉"}


def _day_spend(d: dict, day: str) -> dict:
    """The whole local calendar day from the ledger (no weekly-reset split)."""
    dd = (d["days"].get(day) or {})
    by = {k: {"usd": _num(v.get("usd")), "calls": int(_num(v.get("calls")))}
          for k, v in (dd.get("byKind") or {}).items() if isinstance(v, dict)}
    return {"usd": _num(dd.get("usd")), "autoUsd": _num(dd.get("autoUsd")), "calls": int(_num(dd.get("calls"))),
            "byKind": {k: v for k, v in by.items() if v["calls"] > 0 or v["usd"] > 1e-9}}


def _compute(c: dict, d: dict, now: datetime) -> dict:
    w = _window(c, now)
    per = _num(c["usd_per_weekly_pct"]) or 1.0
    cap = _num(c["daily_weekly_pct"])
    acap = min(cap, _num(c["auto_weekly_pct"])) if cap > 0 else _num(c["auto_weekly_pct"])
    b = _boost(c, d, now, per)
    if b and cap > 0:
        cap += b["extraPts"]
        acap += b["extraPts"]
    sp = _window_spend(d, w)
    split = None
    if c.get("unlimited"):
        # no cap → the weekly-reset split only confused the display ("今天已花 $0" at 06:01 after $29 that day).
        # Report the owner's whole calendar day; mention the part after a reset that fell today.
        full = _day_spend(d, w["day"])
        if w["start"] > w["midnight"] and full["usd"] - sp["usd"] > 0.005:
            split = {"at": w["start"].strftime("%H:%M"), "usd": round(sp["usd"], 3), "calls": sp["calls"]}
        sp = full
    infl = _prune_inflight(d, now)
    iusd = sum(_num(v.get("estUsd")) for v in infl.values())
    iausd = sum(_num(v.get("estUsd")) for v in infl.values() if v.get("auto"))
    pct, apct = sp["usd"] / per, sp["autoUsd"] / per
    ipct, iapct = iusd / per, iausd / per
    over = cap > 0 and pct >= cap
    # automatic work stops at its own cap AND as soon as only the owner's reserve (cap − acap) is left
    auto_over = acap <= 0 or apct >= acap or (cap > 0 and pct >= acap)
    if c.get("unlimited"):                 # owner 2026-10-28: no cap — report spend only
        over = auto_over = False
    if c.get("unlimited"):
        say = f"不限额度 · 今天已花 ≈ ${sp['usd']:.2f}（{sp['calls']} 次，全用 Sonnet 5.5 · xhigh 推理"
        say += (f"；{split['at']} 周额度重置后 ${split['usd']:.2f}）" if split else "）")
    elif over:
        say = f"今天的额度用完了（≈{pct:.1f} / {cap:g} 个点，{w['resetWord']} 恢复）"
    else:
        say = f"今天已用 ≈ {pct:.1f} / {cap:g} 个点"
        if auto_over:
            say += "（自动任务已停，剩下的留给你点按钮）"
        if b:
            say += f"（{b['say']}）"
    by = {k: {"calls": v["calls"], "usd": round(v["usd"], 3), "pct": round(v["usd"] / per, 2)}
          for k, v in sorted(sp["byKind"].items(), key=lambda kv: -kv[1]["usd"])}
    return {"day": w["day"], "unlimited": bool(c.get("unlimited")), "model": c.get("force_model"), "effort": c.get("force_effort"),
            "usd": round(sp["usd"], 3), "pct": round(pct, 2), "capPct": round(cap, 2),
            "leftPct": round(max(0.0, cap - pct), 2),
            "autoUsd": round(sp["autoUsd"], 3), "autoPct": round(apct, 2), "autoCapPct": round(acap, 2),
            "autoLeftPct": round(max(0.0, min(acap - apct, acap - pct)), 2), "over": over, "autoOver": auto_over,
            "calls": sp["calls"], "byKind": by, "usdPerPct": per, "calibrated": bool(c.get("calibrated")),
            "inflight": len(infl), "inflightPct": round(ipct, 2), "inflightAutoPct": round(iapct, 2),
            "windowStart": w["start"].isoformat(timespec="minutes"),
            "resetsAt": w["end"].isoformat(timespec="minutes"), "resetsAtLocal": w["end"].strftime("%H:%M"),
            "resetWord": w["resetWord"], "resetKind": w["endKind"], "tz": str(c["tz"]), "boost": b,
            "afterReset": split, "calendarDay": bool(c.get("unlimited")),
            "weekly": (d.get("weekly") or {}).get("last"), "say": say, "estimate": True}


def _check(s: dict, auto: bool, est_pct: float = 0.0) -> tuple[bool, str]:
    if config().get("unlimited"):          # owner 2026-10-28: no budget cap (Sonnet 5.5 is cheap for them); still logged
        return True, ""
    e = max(0.0, est_pct)
    used, busy = s["pct"], s["inflightPct"]
    if s["capPct"] > 0 and used + e >= s["capPct"]:
        return False, f"今天的额度用完了（≈{used:.1f} / {s['capPct']:g} 个点，{s['resetWord']} 恢复）"
    if s["capPct"] > 0 and used + busy + e >= s["capPct"]:
        return False, (f"今天的额度快用完了：还有 {s['inflight']} 个查询在跑（约 {busy:.1f} 个点），"
                       f"等它们跑完再试（≈{used:.1f} / {s['capPct']:g} 个点）")
    if auto:
        acap = s["autoCapPct"]
        a_used = max(s["autoPct"] + s["inflightAutoPct"], used + busy) + e
        if acap <= 0 or a_used >= acap:
            return False, (f"自动任务今天的额度用完了（≈{used:.1f} 个点，自动最多 {acap:g}，"
                           f"剩下的留给你点按钮；{s['resetWord']} 恢复）")
    return True, ""


# ═══════════════════════════════════════ public budget API ═══════════════════════════════════════

def status(path: Path | None = None) -> dict:
    """Today's spend in the owner's words (weekly-quota points, an estimate) — the shape loop/usage.status()
    always had: {"day","usd","pct","capPct","leftPct","autoPct","autoCapPct","autoLeftPct","over","autoOver",
    "calls","byKind","usdPerPct","resetsAt","tz","say","estimate"} + calibrated, inflight*, boost, resetsAtLocal."""
    c = config()
    d = _read(Path(path or USAGE_PATH))
    return _compute(c, d, _now(c))


def budget_status(path: Path | None = None) -> dict:
    """§24 contract shape (+ the say line and the rest of status())."""
    s = status(path)
    return {"day": s["day"], "usedPts": s["pct"], "capPts": s["capPct"], "autoUsedPts": s["autoPct"],
            "autoCapPts": s["autoCapPct"], "usd": s["usd"], "usdPerPt": s["usdPerPct"],
            "calibrated": s["calibrated"], "byKind": s["byKind"], "resetsAtLocal": s["resetsAtLocal"],
            "resetWord": s["resetWord"], "leftPts": s["leftPct"], "autoLeftPts": s["autoLeftPct"],
            "over": s["over"], "autoOver": s["autoOver"], "inflight": s["inflight"], "inflightPts": s["inflightPct"],
            "boost": s["boost"], "weekly": s["weekly"], "calls": s["calls"], "say": s["say"], "estimate": True,
            "unlimited": s.get("unlimited", False), "model": s.get("model"), "effort": s.get("effort")}


def can_spend(auto: bool = False, est_pct: float = 0.0, path: Path | None = None) -> tuple[bool, str]:
    """(True, "") when one more call fits today's points; else (False, plain-Chinese reason).
    auto=True (loop / scout patrol / verify / nightly maps): stops at auto_weekly_pct, keeping the rest for
    the owner. Calls still running count with their estimated cost."""
    c = config()
    if not c.get("enabled", True) or os.environ.get("MW_CLAUDE_DISABLED") == "1":
        return False, "这里关掉了 Claude（MW_CLAUDE_DISABLED / budget.json enabled:false）"
    return _check(status(path), auto, est_pct)


def record(kind: str, *, module: str = "", env: dict | None = None, usd: float | None = None,
           tokens: dict | None = None, model: str | None = None, auto: bool = False, ok: bool = True,
           ms: int | None = None, note: str = "", path: Path | None = None, at: datetime | None = None,
           inflight_id: str | None = None, est: bool = False) -> dict:
    """Write one Claude CLI run down. `env` = the CLI's result envelope (total_cost_usd, usage{…}, modelUsage);
    or pass usd/tokens. Never raises — losing a ledger line must not lose the call's result."""
    try:
        c = config()
        p = Path(path or USAGE_PATH)
        env = env if isinstance(env, dict) else {}
        u = tokens if isinstance(tokens, dict) else (env.get("usage") if isinstance(env.get("usage"), dict) else {})
        cost = _num(usd if usd is not None else env.get("total_cost_usd"))
        now = at.astimezone(_tz(c)) if isinstance(at, datetime) and at.tzinfo else _now(c)
        day = now.date().isoformat()
        rec = {"at": now.isoformat(timespec="seconds"), "day": day, "kind": kind,
               "module": module or kind.split(":")[0], "auto": bool(auto), "ok": bool(ok), "usd": round(cost, 4),
               "inTok": int(_num(u.get("input_tokens"))), "outTok": int(_num(u.get("output_tokens"))),
               "cacheRead": int(_num(u.get("cache_read_input_tokens"))),
               "cacheWrite": int(_num(u.get("cache_creation_input_tokens"))),
               "model": model or _main_model(env), "ms": ms, "note": str(note or "")[:120]}
        if est:
            rec["est"] = True
        with _locked(p):
            d = _read(p, repair=True)
            if inflight_id:
                d["inflight"].pop(inflight_id, None)
            dd = d["days"].setdefault(day, {"usd": 0.0, "autoUsd": 0.0, "calls": 0, "byKind": {}})
            dd["usd"] = round(_num(dd.get("usd")) + cost, 4)
            if auto:
                dd["autoUsd"] = round(_num(dd.get("autoUsd")) + cost, 4)
            dd["calls"] = int(_num(dd.get("calls"))) + 1
            k = dd.setdefault("byKind", {}).setdefault(kind, {"usd": 0.0, "calls": 0, "inTok": 0, "outTok": 0})
            k["usd"] = round(_num(k.get("usd")) + cost, 4)
            k["calls"] = int(_num(k.get("calls"))) + 1
            k["inTok"] = int(_num(k.get("inTok"))) + rec["inTok"] + rec["cacheRead"] + rec["cacheWrite"]
            k["outTok"] = int(_num(k.get("outTok"))) + rec["outTok"]
            for old in sorted(d["days"])[:-KEEP_DAYS]:
                d["days"].pop(old, None)
            d["calls"] = sorted([rec] + d["calls"], key=lambda r: (_call_at(r) or now).timestamp(),
                                reverse=True)[:KEEP_CALLS]
            d["totalUsd"] = round(_num(d.get("totalUsd")) + cost, 4)
            _prune_inflight(d, _now(c))
            d["config"] = _ledger_config(c)
            d["updatedAt"] = _now(c).isoformat(timespec="seconds")
            _write(p, d)
        return rec
    except Exception:  # noqa: BLE001
        return {}


def _estimate_usd(d: dict, kind: str, tools: Iterable[str], c: dict) -> float:
    xs = [_num(r.get("usd")) for r in d["calls"][:300]
          if r.get("kind") == kind and r.get("ok") and not r.get("est") and _num(r.get("usd")) > 0][:8]
    if xs:
        xs.sort()
        return xs[len(xs) // 2]
    e = c.get("est_usd") or {}
    return _num(e.get("web" if tools else "none")) or (0.2 if tools else 0.05)


def _reserve(kind: str, auto: bool, tools, timeout: float, path: Path) -> tuple[bool, str, str | None, float]:
    """Atomically: is there room? → write an in-flight reservation. (ok, why, reservation id, estimated USD)."""
    c = config()
    if not c.get("enabled", True) or os.environ.get("MW_CLAUDE_DISABLED") == "1":
        return False, "这里关掉了 Claude（MW_CLAUDE_DISABLED / budget.json enabled:false）", None, 0.0
    with _locked(path):
        d = _read(path, repair=True)
        now = _now(c)
        s = _compute(c, d, now)
        ok, why = _check(s, auto)
        est = _estimate_usd(d, kind, tools, c)
        if not ok:
            return False, why, None, est
        rid = uuid.uuid4().hex[:12]
        d["inflight"][rid] = {"at": now.isoformat(timespec="seconds"),
                              "until": (now + timedelta(seconds=float(timeout) + 180)).isoformat(timespec="seconds"),
                              "kind": kind, "auto": bool(auto), "estUsd": round(est, 4), "pid": os.getpid()}
        d["config"] = _ledger_config(c)
        _write(path, d)
        return True, "", rid, est


def _release(rid: str | None, path: Path) -> None:
    if not rid:
        return
    with contextlib.suppress(Exception), _locked(path):
        d = _read(path, repair=True)
        if d["inflight"].pop(rid, None) is not None:
            _write(path, d)


# ═══════════════════════════════════════ weekly readings + calibration ═══════════════════════════════════════

def set_weekly_reading(pct: float, resets_at: str | datetime | None = None, *, read_at: datetime | None = None,
                       source: str = "get_usage", path: Path | None = None) -> dict:
    """Record the REAL weekly-quota % (from Claude Code's get_usage / the app's usage card). Used for the
    before-reset spend-down and for calibrating usd_per_weekly_pct."""
    c = config()
    p = Path(path or USAGE_PATH)
    now = _now(c)
    resets = _dt(resets_at) if resets_at else _weekly_resets(c, now)[1]
    rec = {"pct": round(_num(pct), 2), "resetsAt": resets.isoformat(timespec="minutes") if resets else None,
           "readAt": (read_at or now).astimezone(_tz(c)).isoformat(timespec="seconds"), "source": source}
    with _locked(p):
        d = _read(p, repair=True)
        rec["usdTotal"] = round(_num(d.get("totalUsd")), 4)
        wk = d.get("weekly") if isinstance(d.get("weekly"), dict) else {}
        hist = [h for h in (wk.get("history") or []) if isinstance(h, dict)]
        wk = {"last": rec, "history": (hist + [rec])[-KEEP_READINGS:]}
        d["weekly"] = wk
        d["config"] = _ledger_config(c)
        d["updatedAt"] = now.isoformat(timespec="seconds")
        _write(p, d)
    return rec


def calibrate(apply: bool = False, path: Path | None = None) -> dict:
    """usd_per_weekly_pct = Δ(system USD in the ledger) / Δ(real weekly %) between the first and the last reading
    of the same weekly period. The owner's own Claude use in between makes Δ% bigger → the estimate comes out
    LOW → points look expensive → the gate stops early (the safe side). Best measured over a quiet batch."""
    d = _read(Path(path or USAGE_PATH))
    hist = [h for h in ((d.get("weekly") or {}).get("history") or []) if isinstance(h, dict)]
    if len(hist) < 2:
        return {"ok": False, "why": "要两次读数（reading --pct …），中间跑一批调用"}
    last = hist[-1]
    same = [h for h in hist if h.get("resetsAt") == last.get("resetsAt")]
    first = same[0]
    dp, du = _num(last.get("pct")) - _num(first.get("pct")), _num(last.get("usdTotal")) - _num(first.get("usdTotal"))
    out = {"from": first, "to": last, "dPct": round(dp, 2), "dUsd": round(du, 4)}
    if dp < 2 or du <= 0:
        out.update(ok=False, why=f"变化太小（Δ{dp:g}% / ${du:.2f}），量不准；至少要 2 个百分点")
        return out
    est = du / dp
    out.update(ok=True, usdPerWeeklyPct=round(est, 4))
    if apply:
        try:
            cur = json.loads(BUDGET_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cur = {}
        cur["usd_per_weekly_pct"] = round(est, 4)
        cur["calibrated"] = True
        cur["calibration"] = {"at": datetime.now().astimezone().isoformat(timespec="minutes"),
                              "dPct": round(dp, 2), "dUsd": round(du, 4), "from": first.get("readAt"),
                              "to": last.get("readAt"),
                              "note": "Δ ledger USD / Δ real weekly %; other Claude use in the window makes this low (safe)"}
        BUDGET_PATH.write_text(json.dumps(cur, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        out["applied"] = True
    return out


# ═══════════════════════════════════════ running the CLI ═══════════════════════════════════════

def find_bin(explicit: str | None = None, c: dict | None = None) -> str | None:
    """$MW_CLAUDE_BIN (tests point it at a fake) > explicit > budget.json claude_bin > PATH > ~/.local/bin/claude."""
    c = c or config()
    for cand in (os.environ.get("MW_CLAUDE_BIN"), explicit, c.get("claude_bin"), "claude"):
        if not cand:
            continue
        p = Path(os.path.expanduser(str(cand)))
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
        w = shutil.which(str(cand))
        if w:
            return w
    home = Path.home() / ".local" / "bin" / "claude"
    return str(home) if home.exists() else None


def clean_env(extra: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV or k.startswith(("LC_", "MW_"))}
    more = [str(Path.home() / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    cur = env.get("PATH", "").split(":") if env.get("PATH") else []
    env["PATH"] = ":".join(dict.fromkeys([p for p in cur + more if p]))
    env.setdefault("LANG", "en_US.UTF-8")
    env["NO_COLOR"] = "1"
    env.update(extra or {})
    return env


def build_argv(binary: str, *, prompt: str | None = None, system: str | None = None, tools: Iterable[str] = (),
               schema: dict | None = None, model: str | None = None, effort: str | None = None,
               max_usd: float | None = None, stream: bool = True) -> list[str]:
    """The exact flags of one run. `prompt` goes into argv only when given (else it is sent on stdin)."""
    tl = ",".join(t for t in (tools or []) if t)
    argv = [binary, "-p"] + ([prompt] if prompt is not None else [])
    argv += ["--output-format", "stream-json", "--verbose"] if stream else ["--output-format", "json"]
    argv += ["--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--tools", tl]
    if tl:
        argv += ["--allowedTools", tl, "--permission-mode", "dontAsk", "--permission-prompts", "none"]
    if system:
        argv += ["--system-prompt", system]
    if model:
        argv += ["--model", str(model)]
    if effort and effort != "none":
        argv += ["--effort", str(effort)]
    if schema:
        argv += ["--json-schema", json.dumps(schema, ensure_ascii=False)]
    if max_usd and _num(max_usd) > 0:
        argv += ["--max-budget-usd", f"{_num(max_usd):g}"]
    return argv


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=8)
    except (ProcessLookupError, PermissionError):
        pass
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)


def _run(argv: list[str], stdin_text: str | None, timeout: float, env: dict, stop_event=None,
         on_proc: Callable | None = None) -> dict:
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="mw-claude-") as cwd:
        try:
            p = subprocess.Popen(argv, cwd=cwd, env=env, text=True, encoding="utf-8", errors="replace",
                                 stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as e:
            return {"spawned": False, "error": f"启动 claude 失败: {e}", "ms": 0}
        if on_proc:
            on_proc(p)
        out = err = ""
        killed = None
        try:
            deadline = t0 + float(timeout)
            first = True
            while True:
                try:
                    out, err = p.communicate(input=stdin_text if first else None, timeout=1.0)
                    break
                except subprocess.TimeoutExpired:
                    first = False
                    if time.time() > deadline or (stop_event is not None and stop_event.is_set()):
                        killed = "超时" if time.time() > deadline else "正在停止"
                        _kill(p)
                        with contextlib.suppress(Exception):
                            out, err = p.communicate(timeout=10)
                        break
        finally:
            if on_proc:
                on_proc(None)
    return {"spawned": True, "rc": p.returncode, "out": out or "", "err": err or "", "killed": killed,
            "ms": int((time.time() - t0) * 1000)}


def _norm_url(u: str) -> str:
    from urllib.parse import urlparse
    u = u.strip().rstrip(".,;:")
    p = urlparse(u)
    return (p.hostname or "").lower().removeprefix("www.") + p.path.rstrip("/")


def parse_output(out: str) -> tuple[dict | None, list[dict], list[str]]:
    """CLI stdout (stream-json lines, or one json envelope) → (final result event, tool trace, seen URLs)."""
    final, trace, seen = None, [], set()
    events: list = []
    s = (out or "").strip()
    if s.startswith("[") or (s.startswith("{") and "\n{" not in s):
        try:
            v = json.loads(s)
            events = v if isinstance(v, list) else [v]
        except ValueError:
            events = []
    if not events:
        for line in s.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    for e in events:
        if not isinstance(e, dict):
            continue
        typ = e.get("type")
        if typ == "result":
            final = e
        elif typ in ("assistant", "user"):
            for ct in ((e.get("message") or {}).get("content") or []):
                if not isinstance(ct, dict):
                    continue
                t = ct.get("type")
                if t in ("tool_use", "server_tool_use"):
                    inp = ct.get("input")
                    trace.append({"tool": ct.get("name"), "input": json.dumps(inp, ensure_ascii=False)[:240]})
                    if ct.get("name") == "WebFetch" and isinstance(inp, dict) and inp.get("url"):
                        seen.add(_norm_url(str(inp["url"])))
                elif t in ("tool_result", "web_search_tool_result"):
                    body = ct.get("content")
                    if isinstance(body, list):
                        body = " ".join(str(x.get("text") or x.get("url") or "") if isinstance(x, dict) else str(x)
                                        for x in body)
                    body = str(body)
                    seen.update(_norm_url(u) for u in URL_RE.findall(body))
                    trace.append({"result": body[:300], "error": bool(ct.get("is_error"))})
                elif t == "text" and ct.get("text"):
                    trace.append({"text": str(ct["text"])[:200]})
    return final, trace[-60:], sorted(seen)[:800]


def _main_model(env: dict, want: str | None = None) -> str | None:
    """The model that did the reasoning: the one asked for when it shows up in modelUsage (WebFetch summarises
    pages with a small helper model, which can even cost more), else the one with the most output."""
    mu = env.get("modelUsage") if isinstance(env, dict) and isinstance(env.get("modelUsage"), dict) else {}
    if not mu:
        return None
    w = str(want or "").lower()
    hit = [m for m in mu if w and w in m.lower()]
    if hit:
        return hit[0]
    return max(mu, key=lambda k: _num((mu.get(k) or {}).get("outputTokens")) if isinstance(mu.get(k), dict) else 0)


def repair_json(s: str) -> str:
    """Escape stray ASCII quotes inside strings (「他说"没人要"」), raw newlines, trailing commas."""
    def value_start(j: int) -> bool:
        while j < len(s) and s[j] in " \t\r\n":
            j += 1
        return j < len(s) and (s[j] in '"{[-' or s[j].isdigit() or s.startswith(("true", "false", "null"), j))
    out, in_str, esc, n = [], False, False, len(s)
    for i, ch in enumerate(s):
        if not in_str:
            in_str = ch == '"'
            out.append(ch)
            continue
        if esc:
            out.append(ch)
            esc = False
        elif ch == "\\":
            out.append(ch)
            esc = True
        elif ch == '"':
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            nxt = s[j] if j < n else ""
            if nxt in "}]" or nxt == "" or (nxt in ",:" and value_start(j + 1)):
                in_str = False
                out.append(ch)
            else:
                out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        else:
            out.append(ch)
    return re.sub(r",\s*([}\]])", r"\1", "".join(out))


def extract_json(text: str) -> dict | None:
    """The answer's JSON object: ```json fences, chatter around it, stray quotes inside Chinese text."""
    if not isinstance(text, str) or not text.strip():
        return None
    t = text.strip()
    cands = []
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.S)
    if m:
        cands.append(m.group(1))
    cands.append(t)
    dec = json.JSONDecoder()
    for c in cands:
        try:
            v = json.loads(c)
            if isinstance(v, dict):
                return v
        except ValueError:
            pass
        for i, ch in enumerate(c):
            if ch == "{":
                try:
                    v, _ = dec.raw_decode(c[i:])
                    if isinstance(v, dict):
                        return v
                except ValueError:
                    continue
                break           # only the first '{' is worth a repair try below
        a, b = c.find("{"), c.rfind("}")
        if 0 <= a < b:
            with contextlib.suppress(ValueError):
                v = json.loads(repair_json(c[a:b + 1]))
                if isinstance(v, dict):
                    return v
    return None


# ═══════════════════════════════════════ cache ═══════════════════════════════════════

def _cache_file(kind: str, key: str) -> Path:
    return CACHE_DIR / (hashlib.sha1(f"{kind}\n{key}".encode("utf-8")).hexdigest()[:24] + ".json")


def _cache_get(kind: str, key: str, ttl_s: float | None) -> dict | None:
    try:
        d = json.loads(_cache_file(kind, key).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if ttl_s is not None and time.time() - _num(d.get("at")) > float(ttl_s):
        return None
    r = d.get("result")
    return r if isinstance(r, dict) else None


def _cache_put(kind: str, key: str, res: dict) -> None:
    with contextlib.suppress(Exception):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        keep = {k: v for k, v in res.items() if k not in ("trace", "envelope")}
        f = _cache_file(kind, key)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps({"at": time.time(), "kind": kind, "result": keep}, ensure_ascii=False),
                       encoding="utf-8")
        os.replace(tmp, f)


# ═══════════════════════════════════════ call ═══════════════════════════════════════

def _result(kind: str, **kw) -> dict:
    r = {"ok": False, "text": "", "json": None, "usd": 0.0, "inTok": 0, "outTok": 0, "ms": 0, "model": None,
         "error": None, "refused": None, "kind": kind, "attempts": 0, "calls": [], "envelope": None,
         "trace": [], "seenUrls": [], "toolCalls": {}, "turns": 0, "problems": [], "cached": False}
    r.update(kw)
    return r


def call(kind: str, prompt: str, *, system: str | None = None, tools: Iterable[str] = (), schema: dict | None = None,
         model: str | None = None, effort: str | None = None, auto: bool = False, timeout: int = 240,
         json_out: bool = True, validate: Callable[[dict], list] | None = None,
         parse: Callable[[str], dict | None] | None = None, retries: int = 1, prompt_via: str = "stdin",
         max_usd: float | None = None, cache_key: str | None = None, cache_ttl_s: float | None = None,
         module: str | None = None, note: str = "", stop_event=None, on_proc: Callable | None = None,
         claude_bin: str | None = None, path: Path | None = None) -> dict:
    """One Claude request through the budget gate. Never raises.

    kind       ledger key "module:what" (e.g. "why:node", "scout:gap", "scenario", "intel", "polymarket:map",
               "loop:verify"); the 💓 panel groups by the part before ":".
    auto       True for anything the system starts by itself (stops at 4 points); False for the owner's clicks.
    tools      exactly the tools Claude may use (() = none; ["WebSearch","WebFetch"] for why/scout).
    schema     CLI-enforced JSON schema (--json-schema; the answer arrives as structured_output).
    json_out   parse a JSON object out of the answer; with `validate(obj) -> [problems]` and/or a custom
               `parse(text) -> dict|None`. Invalid → ONE retry (`retries`), with the reason appended.
    prompt_via "stdin" (default, any size) or "argv".
    → {"ok","text","json","usd","inTok","outTok","ms","model","error","refused", "kind","attempts",
       "calls":[per CLI run],"envelope","trace","seenUrls","toolCalls","turns","problems","cached"}
    """
    c = config()
    # owner 2026-10-28: every system call runs on Sonnet 5.5 at very high effort, whatever the caller asked for
    if c.get("force_model"):
        model = str(c["force_model"])
    if c.get("force_effort"):
        effort = str(c["force_effort"])
    lp = Path(path or USAGE_PATH)
    tools = [t for t in (tools or []) if t]
    if cache_key:
        hit = _cache_get(kind, cache_key, cache_ttl_s)
        if hit:
            return {**_result(kind), **hit, "cached": True, "usd": 0.0, "ms": 0, "refused": None}
    binary = find_bin(claude_bin, c)
    if not binary:
        return _result(kind, error="找不到 claude 命令（Claude Code 没装好？设 budget.json claude_bin 或 $MW_CLAUDE_BIN）")
    system = system if system is not None else c.get("system_default")
    max_usd = max_usd if max_usd is not None else _num(c.get("max_usd_per_call")) or None
    env = clean_env()
    res = _result(kind)
    cur_prompt = prompt
    total_ms = 0
    for attempt in range(max(0, int(retries)) + 1):
        ok, why, rid, est = _reserve(kind, auto, tools, timeout, lp)
        if not ok:
            if attempt == 0:
                return _result(kind, refused="disabled" if "关掉了" in why else "budget", error=why)
            if res["json"] is not None:      # the retry was refused: the imperfect answer is still usable
                res.update(ok=True, error=None)
            else:
                res["error"] = "Claude 没按要求回 JSON" + f"；没再试：{why}"
            break
        argv = build_argv(binary, prompt=cur_prompt if prompt_via == "argv" else None, system=system, tools=tools,
                          schema=schema, model=model, effort=effort, max_usd=max_usd)
        try:
            run = _run(argv, None if prompt_via == "argv" else cur_prompt, timeout, env, stop_event, on_proc)
        except Exception as e:  # noqa: BLE001 — call() never raises
            run = {"spawned": False, "error": f"启动 claude 失败: {e}"}
        if not run.get("spawned"):
            _release(rid, lp)
            return _result(kind, error=run.get("error") or "启动 claude 失败")
        total_ms += run["ms"]
        final, trace, seen = parse_output(run["out"])
        info: dict = {"attempt": attempt + 1, "ms": run["ms"], "rc": run["rc"]}
        if final is None:
            # the process ran (and most likely cost something) but gave no result event: book the estimate
            spent = est if run["ms"] > 3000 else 0.0
            why_bad = (f"claude {run['killed']}（{run['ms'] // 1000}s）" if run["killed"]
                       else f"claude 退出码 {run['rc']}，没给结果：{(run['err'] or run['out'])[-240:].strip()}")
            record(kind, module=module or "", usd=spent, auto=auto, ok=False, ms=run["ms"],
                   note=(why_bad + ("；花费按估计记" if spent else ""))[:120], path=lp, inflight_id=rid, est=bool(spent))
            info.update(usd=spent, error=why_bad)
            res["calls"].append(info)
            res.update(usd=round(res["usd"] + spent, 4), error=why_bad, ms=total_ms, attempts=attempt + 1)
            break
        bad = bool(final.get("is_error")) or final.get("subtype") not in (None, "success") or run["rc"] not in (0, None)
        text = final.get("result") if isinstance(final.get("result"), str) else ""
        usd = _num(final.get("total_cost_usd"))
        u = final.get("usage") if isinstance(final.get("usage"), dict) else {}
        mdl = _main_model(final, model) or model
        record(kind, module=module or "", env=final, auto=auto, ok=not bad, ms=run["ms"], model=mdl,
               note=note if not bad else f"{final.get('subtype')}: {text[:80]}", path=lp, inflight_id=rid)
        tc: dict = {}
        for t in trace:
            if t.get("tool"):
                tc[t["tool"]] = tc.get(t["tool"], 0) + 1
        intok = int(_num(u.get("input_tokens")) + _num(u.get("cache_read_input_tokens")) +
                    _num(u.get("cache_creation_input_tokens")))
        info.update(usd=usd, model=mdl, turns=final.get("num_turns"), subtype=final.get("subtype"))
        res["calls"].append(info)
        res.update(text=text, usd=round(res["usd"] + usd, 4), inTok=res["inTok"] + intok,
                   outTok=res["outTok"] + int(_num(u.get("output_tokens"))), ms=total_ms, model=mdl,
                   envelope=final, trace=trace, seenUrls=seen, toolCalls=tc, turns=final.get("num_turns") or 0,
                   attempts=attempt + 1)
        if bad:
            res["error"] = f"Claude 出错：{final.get('subtype')} {text[:240]}".strip()
            info["error"] = res["error"]
            break
        if not json_out:
            res.update(ok=True, error=None)
            break
        obj = final.get("structured_output") if isinstance(final.get("structured_output"), dict) else None
        if obj is None:
            obj = parse(text) if parse else extract_json(text)
        problems: list = []
        if obj is None:
            problems = ["回答不是一个合法的 JSON 对象"]
        elif validate:
            try:
                problems = [str(p) for p in (validate(obj) or [])]
            except Exception as e:  # noqa: BLE001
                problems = [f"校验出错：{e}"]
        info["problems"] = problems[:10]
        res["json"] = obj
        res["problems"] = problems
        if not problems:
            res.update(ok=True, error=None)
            break
        if attempt >= retries:
            if obj is not None:          # usable but imperfect: the caller repairs what it can
                res.update(ok=True, error=None)
            else:
                res["error"] = "Claude 没按要求回 JSON"
            break
        cur_prompt = (prompt + "\n\n# 上一次的回答不能用\n" + "; ".join(problems[:8])[:1200] +
                      "\n请重新回答：只输出一个合法的 JSON 对象，严格按上面的字段和 id，不要别的文字。")
    if res["ok"] and cache_key:
        _cache_put(kind, cache_key, res)
    return res


# ═══════════════════════════════════════ CLI ═══════════════════════════════════════

def _cli(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="钱的天气 · Claude gateway (DESIGN §24)")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("status", help="today's points")
    r = sub.add_parser("reading", help="record the real weekly %% (from get_usage)")
    r.add_argument("--pct", type=float, required=True)
    r.add_argument("--resets", help="ISO time of the weekly reset (default: from budget.json)")
    r.add_argument("--source", default="get_usage")
    r.add_argument("--set-anchor", action="store_true", help="also store --resets as budget.json weekly_reset.at")
    cb = sub.add_parser("calibrate", help="usd_per_weekly_pct from readings")
    cb.add_argument("--apply", action="store_true")
    t = sub.add_parser("test", help="one tiny real call")
    t.add_argument("--auto", action="store_true")
    t.add_argument("--model", default="haiku")
    t.add_argument("--kind", default="gate:test")
    a = ap.parse_args(argv)
    if a.cmd == "reading":
        rec = set_weekly_reading(a.pct, a.resets, source=a.source)
        if a.set_anchor and a.resets:
            cur = json.loads(BUDGET_PATH.read_text(encoding="utf-8")) if BUDGET_PATH.exists() else {}
            cur.setdefault("weekly_reset", {})["at"] = _dt(a.resets).astimezone(_tz(config())).isoformat()
            BUDGET_PATH.write_text(json.dumps(cur, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(json.dumps(rec, ensure_ascii=False))
        print(budget_status()["say"])
        return 0
    if a.cmd == "calibrate":
        print(json.dumps(calibrate(apply=a.apply), ensure_ascii=False, indent=1))
        return 0
    if a.cmd == "test":
        res = call(a.kind, '只输出这个 JSON，不要别的：{"ok": true, "sum": <把 2 加 3 的结果填这里>}',
                   model=a.model, effort="low", auto=a.auto, timeout=120, note="gateway self-check")
        keep = {k: res[k] for k in ("ok", "json", "usd", "inTok", "outTok", "ms", "model", "error", "refused", "attempts")}
        print(json.dumps(keep, ensure_ascii=False))
        print(budget_status()["say"])
        return 0 if res["ok"] or res["refused"] else 1
    s = budget_status()
    print(s["say"] + ("" if s["calibrated"] else "（约：usd_per_weekly_pct 还没校准）"))
    print(json.dumps(s, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    if __package__ in (None, ""):
        sys.modules.setdefault("common.claude_gate", sys.modules[__name__])
    sys.exit(_cli())
