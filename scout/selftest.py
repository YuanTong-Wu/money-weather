#!/usr/bin/env python3
"""Self-test for the 侦察兵 (scout/) — spends NO Claude quota and never touches the real data.

    python3 scout/selftest.py        # ~15 s; PASS/FAIL per check, exit 1 on any failure
    python3 scout/selftest.py -v     # also show scout's own log lines

It copies scout/ + intel/ + loop/ (code only) and web/data/ into a temp directory, writes its own configs
there, points $MW_CLAUDE_BIN at a fake `claude` that answers in the CLI's stream-json format (with a
configurable cost), and then checks:
  1. count brake  if count caps are set (DESIGN §21 amendment: off by default, 999), automatic tasks stop at
                  daily_cap / kind_caps; the rest stay queued with a reason; owner questions have their own
                  cap; hard_daily_cap stops everything
  8. points       the real limit (§21): with the real scout/config.json, automatic work stops at 4 weekly-quota
                  points, the owner's clicks can still spend up to 6, then everything stops — every call is in
                  web/data/claude_usage.json with its cost and kind
  2. one-at-a-time  two drains started together never run two Claude calls at once (concurrency 1)
  3. intel     an explain result is merged into web/data/intel.json (newest first, source "scout",
               enriched with names / priced-in like the owner's intel); events already there survive
  4. log       web/data/scout_log.json gets one line per run, with the owner's local time
  5. dedupe    the same owner question within 3 days is answered from the log (no new Claude call)
  6. loop      a failing step sent by the loop ({"type":"error"}) is diagnosed from its log alone,
               classified in out/fixes.json (code-issue), with zero web use accepted
  7. route     the server's /api/scout… handler answers GET/POST correctly and ignores other paths
  9. holdings  the owner's holdings (universe/holdings.json) are explained first (§20)
"""
from __future__ import annotations

import os
import sys

if __name__ == "__main__" and __package__ in (None, ""):
    _here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]   # scout/queue.py ≠ stdlib queue

import json  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402

REAL = Path(__file__).resolve().parent.parent
VERBOSE = "-v" in sys.argv
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail and (not cond or VERBOSE) else ""))


FAKE_CLAUDE = r'''#!__PY__
"""Fake `claude -p … --output-format stream-json`: one WebSearch, then a JSON answer shaped for the task."""
import json, os, re, sys, time
from pathlib import Path
d = Path(__file__).resolve().parent
prompt = sys.argv[sys.argv.index("-p") + 1] if "-p" in sys.argv else ""
run = d / "running"
run.mkdir(exist_ok=True)
me = run / str(os.getpid())
me.touch()
with open(d / "calls.txt", "a") as fh:
    fh.write(f"{time.time():.3f} {len(list(run.iterdir()))}\n")
time.sleep(float(os.environ.get("MW_FAKE_SLEEP", "0.2")))
me.unlink()
url = "https://www.sec.gov/Archives/edgar/data/0000000/selftest-filing.htm"
local = "本机一个自动步骤" in prompt
kind = (re.search(r"任务：(\w+)", prompt) or [None, "ask"])[1]
fixes, facts = [], [{"claim": "测试来源说营收增长 12%", "value": 12, "unit": "%", "source_url": url,
                     "source_name": "SEC", "date": "2026-10-20"}]
if kind == "explain":
    ids = (re.search(r"可用于 impacts 的 id：(.+)", prompt) or [None, ""])[1].split(", ")
    fixes = [{"type": "impact", "id": ids[0].strip(), "dir": 1, "strength": 2, "lag": "now", "why": "自测"}]
elif kind == "gap":
    fixes = [{"type": "edge", "a": "MSFT", "b": "NVDA", "from": "MSFT", "to": "NVDA", "usdB": 20, "usdBLow": 15,
              "usdBHigh": 25, "per": "year", "what": "GPU", "est": True, "basis": "自测估算"}]
elif local:
    facts = []
    fixes = [{"type": "code-issue", "file": "universe/parts/ai.json", "say": "ai.json 第 3 行 JSON 坏了，修好这个文件"}]
ans = {"answer_zh": "自测回答：日志最后一行说 JSON 解析失败，是一个数据文件坏了，不是网络问题。",
       "sharp_say": "自测：文件坏了就修文件，别怪网络。", "facts": facts, "fixes": fixes, "conf": 0.8,
       "title_zh": "自测标题", "event_date": "2026-10-20", "event_kind": "news", "novelty": "new"}
if not local:
    print(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "WebSearch", "input": {"query": "selftest"}}]}}))
    print(json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "content": "results: " + url}]}}))
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 3,
                  "total_cost_usd": float(os.environ.get("MW_FAKE_COST", "0.01")),
                  "usage": {"input_tokens": 1200, "output_tokens": 300, "cache_read_input_tokens": 5000},
                  "result": json.dumps(ans, ensure_ascii=False)}, ensure_ascii=False))
'''


TEST_CAPS = {"daily_cap": 6, "kind_caps": {"explain": 3, "gap": 3, "verify": 3, "ask": 6}, "owner_daily_cap": 10,
             "hard_daily_cap": 16}     # an explicit count brake for test 1 (the real config has none: 999)


def set_scout_cfg(tmp: Path, real: dict, **over) -> dict:
    cfg = {**real, **over, "claude_bin": str(tmp / "fake" / "claude"), "check_urls": False}
    (tmp / "scout" / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    return cfg


def build_sandbox() -> tuple[Path, dict]:
    tmp = Path(tempfile.mkdtemp(prefix="mw-scout-selftest-")).resolve()
    ign = shutil.ignore_patterns("out", "__pycache__", "*.lock", "launchd")
    shutil.copytree(REAL / "scout", tmp / "scout", ignore=ign)
    for mod in ("intel", "loop", "common"):          # common/ = the Claude gateway (DESIGN §24) + its budget
        if (REAL / mod).is_dir():
            shutil.copytree(REAL / mod, tmp / mod, ignore=shutil.ignore_patterns("out", "__pycache__", "*.lock",
                                                                                   "launchd", "cache"))
    lc = json.loads((REAL / "loop" / "config.json").read_text(encoding="utf-8"))
    (tmp / "loop" / "config.json").write_text(json.dumps(
        {"usage": {**{k: v for k, v in (lc.get("usage") or {}).items() if not k.startswith("_")},
                   "daily_weekly_pct": 6, "auto_weekly_pct": 4, "usd_per_weekly_pct": 1.0}}), encoding="utf-8")
    bp = tmp / "common" / "budget.json"              # fixed points for the test, whatever the real calibration
    if bp.exists():
        bj = json.loads(bp.read_text(encoding="utf-8"))
        bj.update({"daily_weekly_pct": 6, "auto_weekly_pct": 4, "usd_per_weekly_pct": 1.0,
                   "unlimited": False, "force_model": None, "force_effort": None})   # the owner may run unlimited
        bp.write_text(json.dumps(bj, ensure_ascii=False), encoding="utf-8")
    (tmp / "universe").mkdir()
    (tmp / "universe" / "holdings.json").write_text(json.dumps({"holdings": [{"t": "EXAMPLE"}]}), encoding="utf-8")
    wd = tmp / "web" / "data"
    wd.mkdir(parents=True)
    for n in ("tree.json", "meta.json", "brief.json", "search.json"):
        if (REAL / "web" / "data" / n).exists():
            shutil.copy2(REAL / "web" / "data" / n, wd / n)
    shutil.copytree(REAL / "web" / "data" / "maps", wd / "maps")
    shutil.copytree(REAL / "web" / "data" / "stocks", wd / "stocks")
    real = json.loads((REAL / "scout" / "config.json").read_text(encoding="utf-8"))
    (tmp / "fake").mkdir()
    fc = tmp / "fake" / "claude"
    fc.write_text(FAKE_CLAUDE.replace("__PY__", sys.executable), encoding="utf-8")
    fc.chmod(0o755)
    return tmp, real


def calls(tmp: Path) -> list[tuple[float, int]]:
    p = tmp / "fake" / "calls.txt"
    if not p.exists():
        return []
    return [(float(a), int(b)) for a, b in (ln.split() for ln in p.read_text().splitlines() if ln.strip())]


def main() -> int:
    tmp, real = build_sandbox()
    cfg = set_scout_cfg(tmp, real, **TEST_CAPS)
    # import scout/, intel/ and loop/ from the sandbox, never from the real tree
    for k in ("MW_SCOUT_LOG", "MW_INTEL_PATH", "MW_CLAUDE_USAGE", "MW_LOOP_CONFIG", "MW_LOOP_OUT", "MW_HEARTBEAT_PATH"):
        os.environ.pop(k, None)
    os.environ["MW_CLAUDE_BIN"] = str(tmp / "fake" / "claude")
    os.environ["MW_FAKE_COST"] = "0.01"
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") not in (str(REAL), str(REAL / "scout"))]
    sys.path.insert(0, str(tmp))
    for m in [m for m in sys.modules if m.split(".")[0] in ("scout", "intel", "loop")]:
        del sys.modules[m]
    from scout import common as C, detect as D, job as J, log as L, queue as Q, run as R   # noqa: E401
    from loop import usage as U
    if not VERBOSE:
        C.say = lambda msg: None                                   # quiet unless -v
        for mod in (J, Q, R):
            mod.say = C.say
    assert C.ROOT == tmp and U.USAGE_PATH == tmp / "web" / "data" / "claude_usage.json", (C.ROOT, U.USAGE_PATH)
    tree = C.load_tree()
    regions = [i for i in tree.regions() if int((tree.get(i) or {}).get("depth") or 0) >= 2][:12]
    print(f"sandbox {tmp}\n  real scout/config.json: daily {real['daily_cap']}, kinds {real['kind_caps']}, "
          f"owner {real['owner_daily_cap']}, hard {real['hard_daily_cap']}, concurrency {real['concurrency']}")

    def reset():
        for p in (Q.QUEUE_PATH, L.LOG_PATH, C.INTEL_WEB, U.USAGE_PATH, tmp / "fake" / "calls.txt"):
            p.unlink(missing_ok=True)

    # ── 6 first (needs an empty day): the loop's local error → log-only diagnosis ──────────────────
    print("loop error verify")
    reset()
    tgt = {"type": "error", "step": "full_update", "cmd": "bash update.sh", "rc": 1,
           "log": "[08:31:02] 1/4 build universe\njson.decoder.JSONDecodeError: Expecting ',' delimiter: line 3 column 5\n"
                  "[08:31:02] FAILED: build_universe"}
    out = J.start("verify", tgt, "full_update 为什么失败？", source="loop", wait=True, spawn=False, key="verify:loop:selftest")
    fx = C.read_json(R.FIXES, [])
    check("6 verify from the loop is done without web use", out.get("state") == "done", str(out)[:200])
    check("6 classified as code-issue in out/fixes.json", any(f.get("type") == "code-issue" and f.get("file") for f in fx))
    check("6 counted as an automatic task (verify)", Q.usage_today(cfg)["used"].get("verify") == 1
          and Q.usage_today(cfg)["used"].get("_auto") == 1)
    ent = L.read(1)[0] if L.read(1) else {}
    check("6 conf capped (judged from the log only)", (ent.get("conf") or 1) <= 0.6, str(ent.get("conf")))

    # ── 1. caps ──────────────────────────────────────────────────────────────────────────────────
    print("count brake (only when count caps are set)")
    reset()
    for i in range(5):
        Q.enqueue("explain", {"type": "node", "id": regions[i]}, None, priority=3 - i * 0.01, key=f"explain:{regions[i]}")
    for i in range(3):
        Q.enqueue("gap", {"type": "edge", "a": "MSFT", "b": f"T{i}", "what": "GPU"}, f"MSFT 付给 T{i} 多少？",
                  priority=2 - i * 0.01, key=f"gap:selftest{i}")
    Q.enqueue("verify", {"type": "tickers", "tickers": ["ZZZT"]}, "ZZZT 为什么没数据？", priority=1, key="verify:selftest")
    res = Q.drain(cfg=C.load_config())
    kinds = [r["kind"] for r in res]
    u = Q.usage_today(cfg)["used"]
    left = Q.list_tasks(("queued",))
    check(f"1 explain stops at its count cap ({cfg['kind_caps']['explain']})", kinds.count("explain") == cfg["kind_caps"]["explain"], str(kinds))
    check(f"1 all automatic stop at daily_cap ({cfg['daily_cap']})", len(res) == cfg["daily_cap"] and u.get("_auto") == cfg["daily_cap"],
          f"ran {len(res)}, used {u}")
    check("1 the rest stay queued with a plain reason", len(left) == 9 - cfg["daily_cap"] and all(t.get("capNote") for t in left),
          str([t.get("capNote") for t in left]))
    n0 = len(calls(tmp))
    o = J.start("ask", regions[0], "自测：这里最近怎么了？", wait=True, spawn=False)
    check("1 owner question still runs (own cap)", o.get("state") == "done" and len(calls(tmp)) == n0 + 1, str(o)[:160])
    hard = dict(C.load_config(), hard_daily_cap=Q.usage_today(cfg)["used"].get("_all", 0))
    t, why = Q.enqueue("ask", regions[1], "自测：总闸？", source="owner")[0], None
    got, why = Q.claim(only_id=t["id"], cfg=hard)
    check("1 hard_daily_cap stops even owner questions", got is None and "上限" in why, why)

    # ── 8. points: the real limit (§21) with the real caps from scout/config.json ─────────────────
    print("points budget (the real limit)")
    reset()
    cfg = set_scout_cfg(tmp, real)
    os.environ["MW_FAKE_COST"] = "0.5"                     # 0.5 USD = 0.5 points at usd_per_weekly_pct 1.0
    for i in range(10):
        Q.enqueue("explain", {"type": "node", "id": regions[i]}, None, priority=3 - i * 0.01, key=f"explain:p{i}")
    res = Q.drain(cfg=C.load_config())
    st = U.status()
    left = Q.list_tasks(("queued",))
    check("8 automatic work stops at 4 points (8 calls × 0.5)", len(res) == 8 and abs(st["autoPct"] - 4.0) < 1e-6,
          f"ran {len(res)}, {st['say']}")
    check("8 the rest wait with the plain reason", len(left) == 2 and all("自动任务今天的额度用完了" in (t.get("capNote") or "")
                                                                       for t in left), str([t.get("capNote") for t in left])[:200])
    n0 = len(calls(tmp))
    outs = [J.start("ask", regions[i], f"自测：按钮 {i}？", wait=True, spawn=False) for i in range(5)]
    st = U.status()
    check("8 the owner's clicks still run on the last 2 points", [o.get("state") for o in outs[:4]] == ["done"] * 4
          and len(calls(tmp)) == n0 + 4, str([o.get("state") for o in outs]))
    check("8 then everything stops: 今天的额度用完了 … 明天 00:00 恢复", outs[4].get("state") == "failed"
          and "今天的额度用完了" in (outs[4].get("error") or "") and st["over"], str(outs[4].get("error")))
    led = json.loads(U.USAGE_PATH.read_text(encoding="utf-8"))
    day = led["days"][st["day"]]
    check("8 web/data/claude_usage.json has every call with cost, tokens and kind",
          len(led["calls"]) == 12 and abs(day["usd"] - 6.0) < 1e-6 and abs(day["autoUsd"] - 4.0) < 1e-6
          and day["byKind"]["scout:explain"]["calls"] == 8 and day["byKind"]["scout:ask"]["calls"] == 4
          and led["calls"][0]["inTok"] == 1200 and led["calls"][0]["auto"] is False, json.dumps(day)[:200])
    os.environ["MW_FAKE_COST"] = "0.01"

    # ── 9. holdings first ────────────────────────────────────────────────────────────────────────
    print("holdings first (§20)")
    tree.nodes["s:EXAMPLE"]["now"] = {**(tree.nodes["s:EXAMPLE"].get("now") or {}), "front": 1, "storm": 0.9, "wind": 0.9}
    cands = sorted(D.detect_explain(tree, C.load_config(), {}), key=lambda c: -c["priority"])
    check("9 a holding with a front/storm is a candidate and comes first", cands and cands[0]["target"]["id"] == "s:EXAMPLE"
          and "持仓" in cands[0]["why"], str([(c["target"]["id"], c["priority"]) for c in cands[:3]]))
    cfg = set_scout_cfg(tmp, real, **TEST_CAPS)

    # ── 2. concurrency 1 across processes ────────────────────────────────────────────────────────
    print("one at a time")
    reset()
    for i in range(3):
        Q.enqueue("explain", {"type": "node", "id": regions[5 + i]}, None, priority=2, key=f"explain:{regions[5 + i]}")
    env = dict(os.environ, MW_FAKE_SLEEP="1.5", PYTHONPATH=str(tmp))
    ps = [subprocess.Popen([sys.executable, "-m", "scout.queue", "drain"], cwd=str(tmp), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    outs = [p.communicate(timeout=120) for p in ps]
    cs = calls(tmp)
    ran = sum(len(json.loads(o[0] or "[]")) for o in outs)
    check("2 two drains together ran all 3 tasks", ran == 3, f"ran={ran} {[o[1][-200:] for o in outs] if VERBOSE else ''}")
    check(f"2 never more than {cfg['concurrency']} Claude call at a time", cs and max(c[1] for c in cs) <= int(cfg["concurrency"]),
          str(cs))
    if int(cfg["concurrency"]) < 3:
        check("2 the second drain found the slot busy and said so", any("slots busy" in o[1] for o in outs),
              " | ".join(o[1].strip()[-120:] for o in outs))
    else:   # no concurrency limit (owner 2026-10-28): both drains share the queue, nothing runs twice
        check("2 no task ran twice across the two drains", len(cs) == 3, str(cs))

    # ── 3. intel merge + 4. log (from the runs above) ────────────────────────────────────────────
    print("intel layer + log")
    owner_ev = {"id": "intel-owner-1", "groupId": "intel-owner-1", "source": "paste", "title": "主人自己的情报",
                "impacts": [], "addedAt": "2026-10-27T08:00"}
    reset()
    C.write_json(C.INTEL_WEB, [owner_ev])
    Q.enqueue("explain", {"type": "node", "id": regions[9]}, None, priority=2, key=f"explain:{regions[9]}")
    Q.drain(cfg=C.load_config())
    ev = C.read_json(C.INTEL_WEB, [])
    top = ev[0] if ev else {}
    check("3 explain merged into web/data/intel.json, newest first", len(ev) == 2 and top.get("source") == "scout"
          and ev[1]["id"] == "intel-owner-1", str([e.get("id") for e in ev]))
    im = (top.get("impacts") or [{}])[0]
    check("3 enriched like the owner's intel (name, path, pricedIn, reach)",
          bool(im.get("name")) and "pricedIn" in im and isinstance(top.get("reach"), dict) and top.get("groupId"),
          json.dumps(im, ensure_ascii=False)[:160])
    check("3 also kept in scout/out/intel_events.json", any(e.get("id") == top.get("id") for e in C.read_json(R.INTEL_EVENTS, [])))
    lg = L.read()
    check("4 web/data/scout_log.json has the run with a plain line + local time",
          L.LOG_PATH == tmp / "web" / "data" / "scout_log.json" and lg and lg[0]["line"].startswith("老风派侦察兵去查了")
          and "月" in (lg[0].get("finishedLocal") or ""), str(lg[:1])[:200])
    R.push_to_intel({**top, "say": "改过"}, C.load_config())
    ev2 = C.read_json(C.INTEL_WEB, [])
    check("3 pushing the same event again replaces it (no duplicate)", len(ev2) == 2 and ev2[0]["say"] == "改过")
    (C.INTEL_WEB).write_text("{broken", encoding="utf-8")
    R.push_to_intel(top, C.load_config())
    check("3 a corrupt intel.json is kept aside, not silently lost",
          (C.INTEL_WEB.with_name("intel.json.corrupt")).exists() and len(C.read_json(C.INTEL_WEB, [])) == 1)

    # ── 5. dedupe ────────────────────────────────────────────────────────────────────────────────
    print("dedupe")
    reset()
    a = J.start("ask", regions[2], "自测：重复问题？", wait=True, spawn=False)
    n0 = len(calls(tmp))
    b = J.start("ask", regions[2], "自测：重复问题", wait=True, spawn=False)
    check("5 same question again → cached, no Claude call", a.get("state") == "done" and b.get("state") == "cached"
          and len(calls(tmp)) == n0, f"{a.get('state')} {b.get('state')}")
    c = J.start("ask", regions[2], "自测：重复问题", force=True, wait=True, spawn=False)
    check("5 force=True asks again", c.get("state") == "done" and len(calls(tmp)) == n0 + 1)

    # ── 7. route ─────────────────────────────────────────────────────────────────────────────────
    print("route (server API)")
    r = J.route("GET", "/api/scout/log", "limit=2")
    check("7 GET /api/scout/log → list", r and r[0] == 200 and isinstance(r[1], list) and len(r[1]) <= 2)
    r = J.route("GET", "/api/scout/usage", "")
    check("7 GET /api/scout/usage → caps + used", r and r[0] == 200 and "caps" in r[1] and "used" in r[1])
    r = J.route("GET", "/api/scout", f"id={a.get('id')}")
    check("7 GET /api/scout?id= → status", r and r[1].get("state") == "done", str(r)[:120])
    r = J.route("POST", "/api/scout", "", b"{not json")
    check("7 POST bad JSON → 400", r and r[0] == 400)
    r = J.route("POST", "/api/scout", "", json.dumps({"kind": "nope"}).encode())
    check("7 POST unknown kind → 400 with a reason", r and r[0] == 400 and r[1].get("error"))
    r = J.route("POST", "/api/scout", "", json.dumps({"kind": "ask", "target": regions[2], "question": "自测：重复问题"},
                                                     ensure_ascii=False).encode())
    check("7 POST a known question → cached answer, nothing spawned", r and r[0] == 200 and r[1].get("state") == "cached")
    check("7 other paths are not ours", J.route("GET", "/api/intel", "") is None)

    bad = [x for x in RESULTS if not x[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed" + (": " + ", ".join(x[0] for x in bad) if bad else ""))
    if not bad:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print(f"(sandbox kept for a look: {tmp})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
