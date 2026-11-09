"""Issues + data-level fixes (DESIGN.md §16).

- Data-level fixes Claude finds (renamed ticker, dead ticker, a missing value, a stuck lock) are applied
  automatically: written to loop/out/fixes.json (source "scout", with sources + conf) and, when
  web/data/overrides.json already exists in a known shape, appended there too — never touching an
  entry the owner wrote. The pipeline reads them on its next build.
- Code-level problems are never "fixed" unattended: they go to loop/out/issues.md for the owner (or
  for Claude Code when the owner says so).
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from datetime import datetime
from pathlib import Path

from loop import settings

TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-^=]{0,11}$")
LEVEL_ZH = {"code": "要改代码", "env": "本机环境", "data": "数据问题", "transient": "临时故障", "unknown": "还没诊断"}


# ── small io helpers ──────────────────────────────────────────────────────────────────────────────
def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def atomic_json(path: Path, data) -> None:
    atomic_write(path, json.dumps(data, ensure_ascii=False, indent=1, allow_nan=False) + "\n")


@contextlib.contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


_EXC_RE = re.compile(r"\b[A-Z]\w*(Error|Exception|Exit)\b")
_FAIL_RE = re.compile(r"FAILED|failed|失败|cannot|can't|不存在|Errno")


def key_line(text: str | None) -> str:
    """The most telling line of an error/log: the last exception line ("SyntaxError: …"), else the last
    "FAILED/失败" line, else the last line. Skips the loop's own "===== exit" markers and traceback frames."""
    lines = [ln.strip() for ln in (text or "").strip().splitlines()
             if ln.strip() and not ln.lstrip().startswith(("=====", "File \"", "^"))]
    for rx in (_EXC_RE, _FAIL_RE):
        for ln in reversed(lines):
            if rx.search(ln):
                return ln
    return lines[-1] if lines else ""


def signature(step: str, error: str) -> str:
    """Same problem → same signature, even if numbers / times / paths in the message differ; different
    problems in the same step (a SyntaxError vs a network error) → different signatures."""
    core = key_line(error)
    core = re.sub(r"0x[0-9a-f]+|\d+(\.\d+)?", "#", core.lower())
    core = re.sub(r"\s+", " ", core)[:160]
    return f"{step}|{core}"


def short_id(sig: str, at: datetime) -> str:
    return f"I-{at:%m%d}-{hashlib.sha1(sig.encode()).hexdigest()[:5]}"


# ── issues registry (lives inside state["issues"], persisted by the runner) ────────────────────────
class Issues:
    def __init__(self, state: dict):
        self.items: dict = state.setdefault("issues", {})

    def touch(self, step: str, title: str, error: str, now: datetime, **extra) -> dict:
        sig = signature(step, error)
        it = self.items.get(sig)
        if it is None or it.get("status") == "resolved":
            it = {"id": short_id(sig, now), "sig": sig, "step": step, "title": title, "error": error[-600:],
                  "firstAt": now.isoformat(timespec="seconds"), "count": 0, "level": "unknown",
                  "status": "open", "statusText": "刚发现"}
            self.items[sig] = it
        it["count"] = it.get("count", 0) + 1
        it["lastAt"] = now.isoformat(timespec="seconds")
        it["error"] = error[-600:]
        it.update({k: v for k, v in extra.items() if v is not None})
        return it

    def open_for_step(self, step: str) -> list[dict]:
        return [i for i in self.items.values() if i.get("step") == step and i.get("status") == "open"]

    def resolve_step(self, step: str, now: datetime, by: str = "auto") -> list[dict]:
        """A step that succeeds again closes its open issues ("已自愈")."""
        out = []
        for it in self.open_for_step(step):
            it.update(status="resolved", resolvedAt=now.isoformat(timespec="seconds"), resolvedBy=by,
                      statusText="已自愈：这一步又跑通了" if by == "auto" else "主人标记已解决")
            out.append(it)
        return out

    def resolve_id(self, issue_id: str, now: datetime) -> bool:
        for it in self.items.values():
            if it.get("id") == issue_id and it.get("status") != "resolved":
                it.update(status="resolved", resolvedAt=now.isoformat(timespec="seconds"), resolvedBy="owner",
                          statusText="主人标记已解决")
                return True
        return False

    def prune(self, keep_resolved: int = 30) -> None:
        res = sorted((i for i in self.items.values() if i.get("status") == "resolved"),
                     key=lambda i: i.get("resolvedAt", ""), reverse=True)
        for it in res[keep_resolved:]:
            self.items.pop(it["sig"], None)

    def open_list(self) -> list[dict]:
        return sorted((i for i in self.items.values() if i.get("status") == "open"),
                      key=lambda i: i.get("lastAt", ""), reverse=True)

    def for_heartbeat(self) -> list[dict]:
        keys = ("id", "step", "title", "level", "status", "statusText", "count", "firstAt", "lastAt", "diagnosis")
        return [{k: i.get(k) for k in keys} for i in self.open_list()][:20]

    def render_md(self, owner_fmt) -> str:
        """issues.md — written for the owner; code-level first."""
        now = datetime.now().astimezone()
        opn = self.open_list()
        code = [i for i in opn if i.get("level") in ("code", "env", "unknown")
                or (i.get("level") == "data" and not i.get("fixApplied"))]
        other = [i for i in opn if i not in code]
        done = sorted((i for i in self.items.values() if i.get("status") == "resolved"),
                      key=lambda i: i.get("resolvedAt", ""), reverse=True)[:10]
        L = ["# 心跳循环 · 待处理问题", "",
             f"_由 loop/runner.py 自动生成，{owner_fmt(now)} 更新。别手改——想关掉一条，跑 "
             "`python3 loop/runner.py --resolve <编号>`，或者直接把这页丢给 Claude Code 让它修。_", ""]
        L.append(f"## 要动代码 / 环境的问题（{len(code)}）")
        L.append("")
        if not code:
            L += ["没有。系统自己扛得住。", ""]
        for i in code:
            L += [f"### {i['id']} · {i.get('issue', {}).get('title') or i['title']}",
                  f"- 步骤：`{i['step']}`　类型：{LEVEL_ZH.get(i.get('level'), i.get('level'))}　"
                  f"出现 {i.get('count', 1)} 次（首次 {owner_fmt(i.get('firstAt'))}，最近 {owner_fmt(i.get('lastAt'))}）",
                  f"- 现状：{i.get('statusText', '')}"]
            if i.get("diagnosis"):
                L.append(f"- Claude 的判断：{i['diagnosis']}")
            iss = i.get("issue") or {}
            if iss.get("detail"):
                L.append(f"- 说明：{iss['detail']}")
            if iss.get("suggestion"):
                L.append(f"- 建议怎么修：{iss['suggestion']}")
            if iss.get("files"):
                L.append("- 相关文件：" + "、".join(f"`{f}`" for f in iss["files"][:6]))
            if i.get("cmd"):
                L.append(f"- 命令：`{i['cmd']}`" + (f"（退出码 {i['rc']}）" if i.get("rc") is not None else ""))
            for s in (i.get("sources") or [])[:3]:
                L.append(f"- 来源：{s}")
            L += ["", "```", (i.get("error") or "").strip()[-600:], "```", ""]
        if other:
            L += [f"## 正在自己处理的（{len(other)}）", ""]
            for i in other:
                L.append(f"- {i['id']} `{i['step']}` {LEVEL_ZH.get(i.get('level'), '')}：{i.get('statusText', '')}"
                         + (f" —— {i['diagnosis']}" if i.get("diagnosis") else ""))
            L.append("")
        if done:
            L += ["## 最近解决的", ""]
            for i in done:
                L.append(f"- {i['id']} `{i['step']}`：{i.get('statusText', '')}（{owner_fmt(i.get('resolvedAt'))}）")
            L.append("")
        return "\n".join(L)


# ── data-level fixes ──────────────────────────────────────────────────────────────────────────────
def _record_fix(entry: dict) -> bool:
    """Append to loop/out/fixes.json (deduped). Returns False if the same fix is already there."""
    p = settings.FIXES_PATH
    with file_lock(p):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            d = {"fixes": []}
        key = lambda f: (f.get("kind"), f.get("from"), f.get("to"), f.get("target"), f.get("field"))  # noqa: E731
        if any(key(f) == key(entry) for f in d.get("fixes", [])):
            return False
        d.setdefault("fixes", []).append(entry)
        d["updatedAt"] = entry["at"]
        atomic_json(p, d)
        return True


def _append_override(target: str, field: str, value, why: str, sources: list, conf: float, at: str) -> str:
    """Add a source:"scout" entry to web/data/overrides.json if it exists in a known shape."""
    p = settings.OVERRIDES_PATH
    if not p.exists():
        return "overrides.json 还没有，只记在 loop/out/fixes.json"
    with file_lock(p):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            return "overrides.json 读不了，没碰它"
        lst = d if isinstance(d, list) else (d.get("overrides") if isinstance(d, dict) else None)
        if not isinstance(lst, list):
            return "overrides.json 格式不认识，没碰它"
        for o in lst:
            if isinstance(o, dict) and o.get("target") == target and o.get("field") == field:
                if o.get("source") == "owner":
                    return "主人已经改过这一项，不碰"
                if o.get("value") == value:
                    return "overrides.json 里已经有了"
        lst.append({"target": target, "field": field, "value": value, "source": "scout", "at": at,
                    "conf": conf, "why": why[:200], "sources": sources[:5], "est": conf < 0.8})
        atomic_json(p, d)
        return "已写入 web/data/overrides.json"


def apply_fix(fix: dict | None, *, why: str, sources: list | None, conf: float, now: datetime,
              dry_run: bool = False) -> tuple[bool, str]:
    """Apply one data-level fix. Returns (applied, plain-Chinese note)."""
    fix = fix or {}
    kind = (fix.get("kind") or "none").strip()
    sources = [s for s in (sources or []) if isinstance(s, str)][:5]
    at = now.isoformat(timespec="seconds")
    if kind in ("none", "rerun", ""):
        return False, "不用改数据，下一轮自动重跑"
    if dry_run:
        return False, f"[dry-run] 会应用修正 {kind}: {json.dumps(fix, ensure_ascii=False)[:120]}"
    if kind == "stale_lock":
        lock = settings.UPDATE_LOCK
        if not lock.exists():
            return False, "锁已经不在了"
        pid = None
        with contextlib.suppress(Exception):
            pid = int((lock / "pid").read_text().strip())
        alive = False
        if pid:
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            except PermissionError:
                alive = True
        age_h = (time.time() - lock.stat().st_mtime) / 3600
        if alive and age_h < 2:
            return False, f"锁的主人（pid {pid}）还活着，不动它"
        shutil.rmtree(lock, ignore_errors=True)
        return True, f"清掉了卡住的 update 锁（pid {pid or '?'}，{age_h:.1f} 小时）"
    if kind in ("ticker_rename", "ticker_drop"):
        old = str(fix.get("from") or fix.get("target") or "").upper().removeprefix("S:")
        new = str(fix.get("to") or "").upper() or None
        if not TICKER_RE.match(old or "-") or (kind == "ticker_rename" and not (new and TICKER_RE.match(new))):
            return False, f"代码看着不对（{old} → {new}），没改"
        entry = {"id": f"F-{hashlib.sha1(f'{kind}{old}{new}'.encode()).hexdigest()[:6]}", "at": at, "kind": kind,
                 "from": old, "to": new, "target": f"s:{old}", "field": "ticker" if new else "inactive",
                 "value": new if new else True, "why": why[:200], "sources": sources, "conf": conf,
                 "source": "scout", "status": "applied"}
        fresh = _record_fix(entry)
        ov = _append_override(entry["target"], entry["field"], entry["value"], why, sources, conf, at)
        what = f"{old} 改名为 {new}" if new else f"{old} 已停止交易，标记为不活跃"
        return True, f"{what}（{'已记入修正层' if fresh else '修正层里已有'}；{ov}）"
    if kind == "override":
        target, field = fix.get("target"), fix.get("field")
        if not target or not field:
            return False, "补值缺 target/field，没改"
        entry = {"id": f"F-{hashlib.sha1(f'{target}{field}'.encode()).hexdigest()[:6]}", "at": at, "kind": kind,
                 "target": target, "field": field, "value": fix.get("value"), "why": why[:200],
                 "sources": sources, "conf": conf, "source": "scout", "status": "applied"}
        fresh = _record_fix(entry)
        ov = _append_override(target, field, fix.get("value"), why, sources, conf, at)
        return True, f"补了 {target}.{field}（{'已记入修正层' if fresh else '修正层里已有'}；{ov}）"
    return False, f"不认识的修法 {kind!r}，当成问题记下"
