"""Health checks run at the end of every cycle (DESIGN.md §16). Read-only: safe in --dry-run.

Each problem: {"code", "level": "fail"|"warn"|"info", "say": plain Chinese, "detail": for Claude}.
"fail" problems go through remediation → Claude verify → issues; "warn" only shows on the heartbeat.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import time
import urllib.request
from datetime import date, datetime, timedelta

from loop import calendar_ny as cal
from loop import settings


def _no_nan(x):
    raise ValueError(f"NaN/Infinity in JSON ({x})")


def load_json_strict(path):
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=_no_nan)


def check(now: datetime, cfg: dict, state: dict) -> dict:
    h = cfg.get("health") or {}
    probs: list[dict] = []
    facts: dict = {}
    data = settings.WEB_DATA

    def add(code, level, say, detail=""):
        probs.append({"code": code, "level": level, "say": say, "detail": detail})

    # 1. meta.json + freshness
    meta = None
    mp = data / "meta.json"
    if not mp.exists():
        add("meta_missing", "fail", "地图数据还没生成（web/data/meta.json 不存在）", str(mp))
    else:
        try:
            meta = load_json_strict(mp)
        except Exception as e:  # noqa: BLE001
            add("meta_broken", "fail", "meta.json 坏了，页面打不开", f"{type(e).__name__}: {e}")
    if meta:
        as_of = meta.get("asOf")
        facts["asOf"] = as_of
        facts["generatedAt"] = meta.get("generatedAt")
        grace = timedelta(minutes=int(h.get("fresh_grace_min", 90)))
        expected = cal.last_completed_session(now, grace)
        facts["expectedAsOf"] = expected.isoformat()
        try:
            d = date.fromisoformat(str(as_of)[:10])
            behind = cal.trading_days_between(d, expected)
            facts["behind"] = behind
            if behind >= 1:
                add("stale", "fail", f"数据停在 {d:%m月%d日}，落后 {behind} 个交易日",
                    f"meta.asOf={as_of}, expected>={expected}, now NY={now.astimezone(cal.NY):%Y-%m-%d %H:%M}")
            if len(meta.get("dates") or []) < 200:
                add("short_window", "warn", f"时间窗只有 {len(meta.get('dates') or [])} 天（应约 252）")
        except ValueError:
            add("meta_broken", "fail", f"meta.asOf 不是日期：{as_of!r}")
        # a still-forming intraday bar (quick refresh while the market is open) must become the real close after
        # the session ends — if it is still there long after the close, the after-close update failed or was skipped
        part = meta.get("partial")
        if isinstance(part, dict) and part.get("date"):
            et = str(part.get("fetchedAt") or "")
            hm = et[11:16] if len(et) >= 16 else ""
            facts["partial"] = {"date": part.get("date"), "etTime": hm or None,
                                "localTime": (meta.get("intraday") or {}).get("localTime")}
            try:
                pd = date.fromisoformat(str(part["date"])[:10])
                sess = cal.session(pd)
                if sess and now.astimezone(cal.NY) > sess[1] + grace:
                    late = int((now.astimezone(cal.NY) - sess[1]).total_seconds() // 60)
                    add("partial_after_close", "warn",
                        f"收盘后还没换成收盘数据（还是盘中 {hm or '?'} 的半根K线）",
                        f"meta.partial={part}, session close={sess[1]:%Y-%m-%d %H:%M} ET, {late} min ago")
            except (ValueError, TypeError):
                pass

        # a close Yahoo had not sent yet, rebuilt from 60-minute bars (pipeline/fetch.py → meta.filled): fine to show,
        # but keep asking Yahoo — the fix is the same full update (fetch.py downloads those tickers again)
        # (only the newest two days, and only for a day after the fill: an old mark Yahoo never fixed stays on the
        # page but stops the 2-hourly updates — a Friday fill would otherwise keep them going all weekend)
        recent = set((meta.get("dates") or [])[-2:])

        def young(f):
            try:
                at = datetime.fromisoformat(str(f.get("at")))
            except (TypeError, ValueError):
                return False
            at = at if at.tzinfo else at.replace(tzinfo=cal.NY)
            return (now if now.tzinfo else now.astimezone()) - at <= timedelta(hours=int(h.get("filled_retry_hours", 24)))
        fl = [f for f in (meta.get("filled") or []) if isinstance(f, dict) and f.get("date") in recent and young(f)]
        if fl:
            facts["filled"] = fl
            try:
                days = "、".join(f"{date.fromisoformat(str(f['date'])[:10]):%m月%d日}" for f in fl)
            except ValueError:
                days = "、".join(str(f["date"]) for f in fl)
            add("filled_close", "warn", f"{days} 的收盘价 Yahoo 还没给，先用当天最后一小时的成交价补着，会定时重取",
                f"meta.filled={fl}")

    # 2. other outputs: parse strictly (no NaN), not empty
    for name, need in (("tree.json", True), ("search.json", True), ("brief.json", False),
                       ("maps/world.json", True)):
        p = data / name
        if not p.exists():
            if need and meta:
                add("output_missing", "fail", f"{name} 不见了", str(p))
            elif not need and meta:
                add("brief_missing", "warn", "今日天气预报 brief.json 还没有")
            continue
        try:
            obj = load_json_strict(p)
            if not obj:
                add("output_empty", "fail", f"{name} 是空的")
            elif name == "tree.json":
                facts["nStocks"] = obj.get("nStocks")
                if not obj.get("children"):
                    add("output_empty", "fail", "tree.json 里没有任何大陆")
        except Exception as e:  # noqa: BLE001
            add("output_broken", "fail", f"{name} 坏了（{type(e).__name__}）", f"{p}: {e}")
    stocks = sorted((data / "stocks").glob("*.json")) if (data / "stocks").exists() else []
    facts["stockFiles"] = len(stocks)
    for p in random.Random(now.toordinal()).sample(stocks, min(3, len(stocks))):
        try:
            s = load_json_strict(p)
            if not s.get("c"):
                add("output_empty", "warn", f"个股文件 {p.name} 没有价格")
        except Exception as e:  # noqa: BLE001
            add("output_broken", "fail", f"个股文件 {p.name} 坏了", f"{p}: {e}")

    # 3. tickers that returned no data in the last update (parsed from fetch.py's output by the step)
    failed = state.get("lastFailedTickers") or []
    facts["failedTickers"] = len(failed)
    if failed:
        n = max(1, int(facts.get("nStocks") or 500))
        frac = len(failed) / n
        lvl = "fail" if frac > float(h.get("failed_ticker_frac_fail", 0.05)) else "info"
        add("failed_tickers" if lvl == "fail" else "some_failed_tickers", lvl,
            f"{len(failed)} 只股票这次没拿到数据" + ("（太多了，像是下载本身坏了）" if lvl == "fail" else ""),
            " ".join(failed[:60]))

    # 4. update lock stuck?
    lock = settings.UPDATE_LOCK
    if lock.exists():
        age_h = (time.time() - lock.stat().st_mtime) / 3600
        pid_alive = None
        try:
            pid = int((lock / "pid").read_text().strip())
            os.kill(pid, 0)
            pid_alive = True
        except ProcessLookupError:
            pid_alive = False
        except (OSError, ValueError):
            pid_alive = None
        if age_h > 2:
            add("update_stuck", "fail" if pid_alive else "warn",
                f"update 锁已经挂了 {age_h:.1f} 小时" + ("，进程还在——像是卡住了" if pid_alive else ""),
                f"{lock} pid_alive={pid_alive}")

    # 5. server up? (page closed is fine — data still updates — so only a warning)
    if h.get("check_server", True) and cfg.get("server_status_url"):
        try:
            with urllib.request.urlopen(cfg["server_status_url"], timeout=2) as r:
                facts["server"] = r.status == 200
        except Exception:  # noqa: BLE001
            facts["server"] = False
        if not facts["server"]:
            add("server_down", "info", "本地页面服务没开（不影响后台更新数据）")

    # 6. disk
    try:
        free_gb = shutil.disk_usage(str(settings.ROOT)).free / 1e9
        facts["freeGB"] = round(free_gb, 1)
        if free_gb < float(h.get("min_free_gb", 1.0)):
            add("disk_low", "fail", f"硬盘只剩 {free_gb:.1f} GB", "")
    except OSError:
        pass

    worst = "ok"
    if any(p["level"] == "fail" for p in probs):
        worst = "fail"
    elif any(p["level"] == "warn" for p in probs):
        worst = "warn"
    return {"ok": worst != "fail", "worst": worst, "problems": probs, "facts": facts}
