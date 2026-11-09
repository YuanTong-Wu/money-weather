#!/usr/bin/env python3
"""Self-test for common/claude_gate.py — spends NO Claude quota (a fake `claude` answers) and never touches
web/data: the ledger, budget, cache and fake binary all live in a temp dir.

    python3 common/selftest.py         # ~15 s; PASS/FAIL per check, exit 1 on any failure

Checks: result shape (§24) · cost/tokens/kind booked · in-flight reservation cleared · tools flags exactly as
passed · prompt on stdin or argv · ONE retry on invalid JSON / validate() problems · refusals spawn nothing
and book nothing · automatic work stops at 4 points, the owner's clicks go on to 6 · many calls at once never
all slip through on the last points (no concurrency limit, but reservations) · timeout books an estimate ·
weekly reset restarts the day · before-reset spend-down needs a fresh reading · MW_CLAUDE_DISABLED · cache ·
unlimited:true never refuses but still books, force_model/force_effort win · loop/usage.py shim keeps the old API.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mw-gate-test-"))
os.environ.update({"MW_CLAUDE_USAGE": str(TMP / "claude_usage.json"), "MW_CLAUDE_BUDGET": str(TMP / "budget.json"),
                   "MW_CLAUDE_CACHE": str(TMP / "cache"), "MW_CLAUDE_BIN": str(TMP / "claude")})
os.environ.pop("MW_CLAUDE_DISABLED", None)
BUDGET = {"daily_weekly_pct": 6, "auto_weekly_pct": 4, "usd_per_weekly_pct": 1.0, "calibrated": False,
          "tz": "Australia/Sydney", "weekly_reset": {"at": None, "every_days": 7},
          "use_before_reset": {"enabled": True, "hours": 4, "keep_weekly_pct": 12, "keep_weekly_pct_projected": 4,
                               "max_extra_pts": 6, "reading_fresh_h": 5},
          "max_usd_per_call": 3.0, "est_usd": {"web": 0.2, "none": 0.05}}
(TMP / "budget.json").write_text(json.dumps(BUDGET))

FAKE = r'''#!__PY__
"""fake claude: stream-json like the real CLI; behaviour from $MW_FAKE_MODE / $MW_FAKE_COST / $MW_FAKE_SLEEP."""
import json, os, sys, time
from pathlib import Path
d = Path(__file__).resolve().parent
a = sys.argv[1:]
prompt = a[a.index("-p") + 1] if "-p" in a and a.index("-p") + 1 < len(a) and not a[a.index("-p") + 1].startswith("--") else None
via = "argv" if prompt is not None else "stdin"
if prompt is None:
    prompt = sys.stdin.read()
with open(d / "calls.jsonl", "a") as fh:
    fh.write(json.dumps({"args": a, "via": via, "prompt": prompt[:400], "t": time.time()}, ensure_ascii=False) + "\n")
mode = os.environ.get("MW_FAKE_MODE", "ok")
time.sleep(float(os.environ.get("MW_FAKE_SLEEP", "0")))
retry = "上一次的回答不能用" in prompt
if mode == "garbage" or (mode == "garbage_then_ok" and not retry):
    body = "抱歉，我不确定"
elif mode == "problems_then_ok" and not retry:
    body = json.dumps({"say": "bad"})
else:
    body = "好的：\n```json\n" + json.dumps({"say": "测试通过", "n": 5}, ensure_ascii=False) + "\n```"
print(json.dumps({"type": "system", "subtype": "init"}))
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "WebSearch", "input": {"query": "x"}}]}}))
print(json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "see https://www.sec.gov/a/b.htm ok"}]}}))
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 2, "result": body,
                  "total_cost_usd": float(os.environ.get("MW_FAKE_COST", "0.01")),
                  "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 1000},
                  "modelUsage": {"claude-haiku-x": {"costUSD": 9, "outputTokens": 5}, "claude-sonnet-x": {"costUSD": 1, "outputTokens": 50}}},
                 ensure_ascii=False))
'''
(TMP / "claude").write_text(FAKE.replace("__PY__", sys.executable))
(TMP / "claude").chmod(0o755)

sys.path.insert(0, str(ROOT))
from common import claude_gate as G  # noqa: E402

assert G.USAGE_PATH == TMP / "claude_usage.json" and G.BUDGET_PATH == TMP / "budget.json", (G.USAGE_PATH, G.BUDGET_PATH)
FAILS: list[str] = []


def check(name: str, cond, detail="") -> None:
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  — {str(detail)[:300]}"))
    if not cond:
        FAILS.append(name)


def fake_calls() -> list[dict]:
    p = TMP / "calls.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def ledger() -> dict:
    return json.loads(G.USAGE_PATH.read_text()) if G.USAGE_PATH.exists() else {"calls": [], "days": {}}


def reset(**env) -> None:
    for f in ("claude_usage.json", "calls.jsonl"):
        (TMP / f).unlink(missing_ok=True)
    for k in ("MW_FAKE_MODE", "MW_FAKE_COST", "MW_FAKE_SLEEP"):
        os.environ.pop(k, None)
    os.environ.update({k: str(v) for k, v in env.items()})
    (TMP / "budget.json").write_text(json.dumps(BUDGET))


def set_budget(**kw) -> None:
    b = json.loads(json.dumps(BUDGET))
    b.update(kw)
    (TMP / "budget.json").write_text(json.dumps(b))


print("one call")
reset(MW_FAKE_COST=0.02)
r = G.call("test:one", "你好", tools=["WebSearch", "WebFetch"], model="sonnet", auto=False, note="n1")
keys = {"ok", "text", "json", "usd", "inTok", "outTok", "ms", "model", "error", "refused"}
check("result has every §24 key", keys <= set(r), sorted(keys - set(r)))
check("ok + parsed JSON from a fenced answer", r["ok"] and r["json"] == {"say": "测试通过", "n": 5}, r)
led = ledger()
c0 = led["calls"][0] if led["calls"] else {}
check("booked: kind, module, owner, usd, tokens", c0.get("kind") == "test:one" and c0.get("module") == "test"
      and c0.get("auto") is False and c0.get("usd") == 0.02 and c0.get("inTok") == 100 and c0.get("cacheRead") == 1000, c0)
check("model = the one asked for, not the WebFetch helper", c0.get("model") == "claude-sonnet-x", c0.get("model"))
check("day aggregate + per kind", led["days"][c0["day"]]["byKind"]["test:one"]["calls"] == 1, led["days"])
check("in-flight reservation cleared", led.get("inflight") == {}, led.get("inflight"))
fc = fake_calls()[-1]
args = fc["args"]
check("web tools exactly as passed + safe flags", args[args.index("--tools") + 1] == "WebSearch,WebFetch"
      and "--allowedTools" in args and "--safe-mode" in args and "--strict-mcp-config" in args
      and "--no-session-persistence" in args and args[args.index("--output-format") + 1] == "stream-json", args)
check("prompt on stdin by default", fc["via"] == "stdin" and fc["prompt"] == "你好", fc)
check("trace / seenUrls / toolCalls from the stream", r["toolCalls"].get("WebSearch") == 1
      and "sec.gov/a/b.htm" in r["seenUrls"], (r["toolCalls"], r["seenUrls"]))
r = G.call("test:none", "hi", prompt_via="argv")
fc = fake_calls()[-1]
check("no tools → --tools '' and no --allowedTools; prompt in argv", fc["args"][fc["args"].index("--tools") + 1] == ""
      and "--allowedTools" not in fc["args"] and fc["via"] == "argv", fc["args"])
check("no system given → a short default system prompt (not CLI's big one)", "--system-prompt" in fc["args"], fc["args"])

print("one retry")
reset(MW_FAKE_MODE="garbage_then_ok")
r = G.call("test:retry", "给我 JSON")
check("invalid JSON → one retry → ok", r["ok"] and r["attempts"] == 2 and len(fake_calls()) == 2, r)
check("both runs booked", len(ledger()["calls"]) == 2 and r["usd"] == 0.02, ledger()["calls"])
reset(MW_FAKE_MODE="garbage")
r = G.call("test:retry", "给我 JSON")
check("still invalid after the retry → ok False, error", not r["ok"] and r["attempts"] == 2 and "JSON" in (r["error"] or ""), r)
reset(MW_FAKE_MODE="garbage")
r = G.call("test:retry", "给我 JSON", retries=0)
check("retries=0 → exactly one run", r["attempts"] == 1 and len(fake_calls()) == 1, r)
reset(MW_FAKE_MODE="problems_then_ok")
seen = []
r = G.call("test:val", "x", validate=lambda o: (seen.append(o) or ([] if o.get("n") == 5 else ["缺 n"])))
check("validate() problems → retry with the reason → ok", r["ok"] and r["attempts"] == 2 and len(seen) == 2
      and "缺 n" in fake_calls()[-1]["prompt"], (r, fake_calls()[-1]["prompt"][-80:]))
reset()
r = G.call("test:text", "随便说", json_out=False)
check("json_out=False → text, no parsing, no retry", r["ok"] and r["text"].startswith("好的") and r["attempts"] == 1, r)

print("budget: refusals, automatic 4, owner 6")
reset(MW_FAKE_COST=0.5)
ran = [G.call("scout:explain", "p", auto=True)["ok"] for _ in range(10)]
s = G.status()
check("automatic stops at 4 points (8 × 0.5)", ran.count(True) == 8 and abs(s["autoPct"] - 4.0) < 1e-9, (ran, s["say"]))
n0 = len(fake_calls())
r = G.call("scout:explain", "p", auto=True)
check("refused: refused='budget', plain reason, nothing spawned, nothing booked", r["refused"] == "budget"
      and "自动任务今天的额度用完了" in r["error"] and len(fake_calls()) == n0 and len(ledger()["calls"]) == 8, r)
ok, why = G.can_spend(auto=True)
check("can_spend(auto=True) says no", not ok and "自动任务" in why, why)
ok, _ = G.can_spend(auto=False)
check("can_spend(auto=False) still yes (the owner's 2 points)", ok)
owner = [G.call("why:node", "p", auto=False)["ok"] for _ in range(5)]
s = G.status()
check("owner clicks run on the last 2 points, then everything stops", owner == [True] * 4 + [False] and s["over"]
      and "今天的额度用完了" in s["say"], (owner, s["say"]))
b = G.budget_status()
check("budget_status() §24 shape", {"day", "usedPts", "capPts", "autoUsedPts", "autoCapPts", "usd", "usdPerPt", "calibrated",
                                    "byKind", "resetsAtLocal"} <= set(b) and b["usedPts"] == 6.0 and b["capPts"] == 6, b)
check("per-kind breakdown", b["byKind"]["scout:explain"]["calls"] == 8 and b["byKind"]["why:node"]["pct"] == 2.0, b["byKind"])
reset(MW_FAKE_COST=0.01)
set_budget(usd_per_weekly_pct=0.001)       # every point now costs $0.001 → 0.01 = 10 points
r1 = G.call("x", "p")
r2 = G.call("x", "p")
check("calibration value drives the points (one call over 6 → next refused)", r1["ok"] and r2["refused"] == "budget", r2)

print("many calls at once (no concurrency limit, but reservations)")
reset(MW_FAKE_COST=0.5, MW_FAKE_SLEEP=1.5)
set_budget(daily_weekly_pct=2, auto_weekly_pct=2, est_usd={"web": 0.5, "none": 0.5})
res: list[dict] = []
ths = [threading.Thread(target=lambda: res.append(G.call("par", "p", auto=True))) for _ in range(10)]
t0 = time.time()
for t in ths:
    t.start()
for t in ths:
    t.join()
started = [x for x in res if not x["refused"]]
check("10 at once: only as many start as the points allow (4 × 0.5 = 2)", len(started) == 4, [x["error"] for x in res])
check("they ran in parallel (no queue)", time.time() - t0 < 5.5, time.time() - t0)
check("the rest were told why, in plain words", all("额度" in (x["error"] or "") for x in res if x["refused"]),
      [x["error"] for x in res if x["refused"]][:2])
check("spend stays at the cap", abs(G.status()["pct"] - 2.0) < 1e-9 and ledger()["inflight"] == {}, G.status()["say"])

print("timeout")
reset(MW_FAKE_SLEEP=6)
set_budget(est_usd={"web": 0.2, "none": 0.07})
t0 = time.time()
r = G.call("slow", "p", timeout=4)
c0 = ledger()["calls"][0]
check("killed after the timeout, says so", not r["ok"] and "超时" in (r["error"] or "") and time.time() - t0 < 12, r)
check("booked with the estimate (est: true), reservation cleared", c0.get("est") is True and c0.get("usd") == 0.07
      and ledger()["inflight"] == {}, c0)

print("disabled / cache / missing CLI")
reset()
os.environ["MW_CLAUDE_DISABLED"] = "1"
r = G.call("x", "p")
check("MW_CLAUDE_DISABLED=1 → refused='disabled', nothing spawned", r["refused"] == "disabled" and not fake_calls(), r)
os.environ.pop("MW_CLAUDE_DISABLED")
r1 = G.call("why:node", "p", cache_key="node~ai~2026-10-27")
r2 = G.call("why:node", "p", cache_key="node~ai~2026-10-27")
check("cache: second call is free and instant", r1["ok"] and r2["ok"] and r2["cached"] and r2["usd"] == 0
      and len(fake_calls()) == 1, (len(fake_calls()), r2.get("cached")))
os.environ["MW_CLAUDE_BIN"] = str(TMP / "nope")
real_bin = G.find_bin(c={"claude_bin": str(TMP / "nope")})
os.environ["MW_CLAUDE_BIN"] = str(TMP / "claude")
check("find_bin falls back to a real CLI when the override is missing", real_bin is None or Path(real_bin).name.startswith("claude"),
      real_bin)

print("the day's window: weekly reset, before-reset spend-down")
reset()
set_budget(weekly_reset={"at": "2026-10-28T06:00:00+11:00", "every_days": 7})
c = G.config()
tz = G._tz(c)
for hh, usd, auto in ((1, 2.0, True), (3, 1.0, False), (7, 0.5, True)):
    G.record("scout:gap", usd=usd, auto=auto, at=datetime(2026, 10, 28, hh, 0, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s3 = G._compute(c, d, datetime(2026, 10, 28, 3, 30, tzinfo=tz))
s8 = G._compute(c, d, datetime(2026, 10, 28, 8, 0, tzinfo=tz))
check("before the 06:00 reset: everything since midnight counts; resets 今天 06:00",
      abs(s3["pct"] - 3.0) < 1e-9 and s3["resetWord"] == "今天 06:00", (s3["pct"], s3["resetWord"]))
check("after the reset: only what came after it counts (last week's quota is gone)",
      abs(s8["pct"] - 0.5) < 1e-9 and abs(s8["autoPct"] - 0.5) < 1e-9 and s8["resetWord"] == "明天 00:00"
      and s8["byKind"]["scout:gap"]["calls"] == 1, (s8["pct"], s8["autoPct"], s8["byKind"]))
check("no reading → no extra points", s3["boost"] is None and s3["capPct"] == 6, s3["boost"])
G.set_weekly_reading(72, "2026-10-27T19:00:00Z", read_at=datetime(2026, 10, 28, 2, 0, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s3 = G._compute(c, d, datetime(2026, 10, 28, 3, 30, tzinfo=tz))
check("fresh reading, 2.5 h before the reset: +6 points (28% left, keep 12%)", s3["boost"] and s3["capPct"] == 12
      and s3["autoCapPct"] == 10 and "多给" in s3["say"], (s3["capPct"], s3["say"]))
s1 = G._compute(c, d, datetime(2026, 10, 28, 1, 30, tzinfo=tz))
check("more than 4 h before the reset: no extra", s1["boost"] is None, s1["boost"])
s8 = G._compute(c, d, datetime(2026, 10, 28, 8, 0, tzinfo=tz))
check("after the reset: no extra, normal 6", s8["boost"] is None and s8["capPct"] == 6, s8["capPct"])
G.set_weekly_reading(85, "2026-10-27T19:00:00Z", read_at=datetime(2026, 10, 28, 3, 0, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s = G._compute(c, d, datetime(2026, 10, 28, 3, 30, tzinfo=tz))
check("weekly quota burning fast anyway (72→85% in 1 h) → nothing would expire → no extra",
      s["boost"] is None and s["capPct"] == 6, s["boost"])
G.set_weekly_reading(86, "2026-10-27T19:00:00Z", read_at=datetime(2026, 10, 28, 3, 20, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s = G._compute(c, d, datetime(2026, 10, 28, 3, 30, tzinfo=tz))
check("slow burn (3%/h): 14% left at the 03:20 reading − 3%/h × 2.67 h (reading → reset) − keep 4% → +2.0 points",
      s["boost"] and abs(s["boost"]["extraPts"] - 2.0) < 1e-6 and s["boost"]["burnPctPerH"] == 3.0, s["boost"])
# the projection runs from the READING, so it must not grow as the reset comes closer (it used to: 16 → 21%)
s_a = G._compute(c, d, datetime(2026, 10, 28, 3, 40, tzinfo=tz))
s_b = G._compute(c, d, datetime(2026, 10, 28, 4, 15, tzinfo=tz))
check("boost: expiring quota does not grow while the clock runs towards the reset",
      s_a["boost"] and s_b["boost"] and s_b["boost"]["expiringPct"] <= s_a["boost"]["expiringPct"] + 1e-9,
      (s_a["boost"], s_b["boost"]))
s_old = G._compute(c, d, datetime(2026, 10, 28, 4, 40, tzinfo=tz))
check("boost: a 3%/h burn with a reading 80 min old still counts (only > 5%/h needs one < 1 h old)",
      s_old["boost"] is not None, s_old["boost"])
G.set_weekly_reading(95, "2026-10-27T19:00:00Z", read_at=datetime(2026, 10, 28, 3, 30, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s = G._compute(c, d, datetime(2026, 10, 28, 3, 31, tzinfo=tz))
check("weekly nearly used up → no extra", s["boost"] is None and s["capPct"] == 6, s["boost"])
cal = G.calibrate()
check("calibrate: needs readings that moved with spend in between", cal.get("ok") is False, cal)

print("owner amendment 2: unlimited + forced model/effort")
reset(MW_FAKE_COST=0.5)
set_budget(unlimited=True, force_model="claude-sonnet-5-5", force_effort="xhigh")
for _ in range(16):                                   # 8 points — way past both caps of the 6/4/2 rule
    G.record("scout:gap", usd=0.5, auto=True)
ok_a, why_a = G.can_spend(auto=True)
ok_o, why_o = G.can_spend(auto=False)
check("unlimited: automatic and owner calls are never refused (8 points spent)", ok_a and ok_o, (why_a, why_o))
bs = G.budget_status()
check("unlimited: status says 不限额度 · 今天已花 ≈ $x, never x / 6 or 用完",
      bs["unlimited"] is True and "不限额度" in bs["say"] and "用完" not in bs["say"] and "/ 6" not in bs["say"]
      and bs["over"] is False and bs["autoOver"] is False, bs["say"])
r = G.call("test:forced", "hi", model="haiku", effort="low", auto=True)
fc = fake_calls()[-1]["args"]
check("unlimited: the call runs and is still booked", r["ok"] and any(x.get("kind") == "test:forced" and x.get("auto") for x in ledger()["calls"]), r)
check("force_model / force_effort override what the caller passed",
      fc[fc.index("--model") + 1] == "claude-sonnet-5-5" and "--effort" in fc and fc[fc.index("--effort") + 1] == "xhigh", fc)
# unlimited: the 💓 line is the owner's whole calendar day — the weekly reset at 06:00 must not zero it
reset(MW_FAKE_COST=0.5)
set_budget(unlimited=True, weekly_reset={"at": "2026-10-28T06:00:00+11:00", "every_days": 7})
c = G.config()
for h, m in ((1, 0), (3, 10), (5, 50)):
    G.record("why:stock", usd=9.6, at=datetime(2026, 10, 28, h, m, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s559 = G._compute(c, d, datetime(2026, 10, 28, 5, 59, tzinfo=tz))
s601 = G._compute(c, d, datetime(2026, 10, 28, 6, 1, tzinfo=tz))
G.record("why:node", usd=0.2, at=datetime(2026, 10, 28, 6, 30, tzinfo=tz))
d = G._read(G.USAGE_PATH)
s700 = G._compute(c, d, datetime(2026, 10, 28, 7, 0, tzinfo=tz))
check("unlimited: today's spend does not drop to $0 at the 06:00 weekly reset",
      abs(s559["usd"] - 28.8) < 1e-6 and abs(s601["usd"] - 28.8) < 1e-6 and s601["calls"] == 3
      and abs(s700["usd"] - 29.0) < 1e-6 and s700["calls"] == 4 and "$29.00" in s700["say"],
      (s559["say"], s601["say"], s700["say"]))
check("unlimited: the part after a reset that fell today is named, not hidden",
      "06:00 周额度重置后 $0.20" in s700["say"] and s700["afterReset"]["usd"] == 0.2, s700["say"])
set_budget(unlimited=False, weekly_reset={"at": None, "every_days": 7})
for _ in range(20):
    G.record("scout:gap", usd=0.5, auto=True)          # 10 points now
check("unlimited:false restores the 6/4/2 refusals", not G.can_spend(auto=True)[0] and not G.can_spend(auto=False)[0],
      G.budget_status()["say"])

print("loop/usage.py shim (old API)")
reset(MW_FAKE_COST=0.3)
for m in [m for m in sys.modules if m == "loop.usage"]:
    del sys.modules[m]
from loop import usage as U  # noqa: E402
U.record("scout:verify", module="scout", env={"total_cost_usd": 4.2, "usage": {"input_tokens": 5}}, auto=True)
s = U.status()
check("shim: same ledger, old status() keys", U.USAGE_PATH == G.USAGE_PATH and s["autoOver"] and "4.2 / 6" in s["say"]
      and {"pct", "capPct", "autoPct", "autoCapPct", "autoLeftPct", "byKind", "resetsAt", "say"} <= set(s), s["say"])
ok, why = U.can_spend(auto=True)
check("shim: can_spend(auto=True) → 自动任务今天的额度用完了", not ok and why.startswith("自动任务今天的额度用完了"), why)

print()
print(f"{'ALL PASSED' if not FAILS else str(len(FAILS)) + ' FAILED: ' + str(FAILS)}  (temp: {TMP})")
sys.exit(1 if FAILS else 0)
