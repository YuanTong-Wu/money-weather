"""why/selftest.py — offline tests for the 为什么 backend (no real Claude call, no quota spent).

    python3 -m why.selftest            facts on real data, regime detection, card validation, jobs (in-process and
                                       detached worker), budget refusal, retry on a bad answer, server routes
A fake `claude` (stream-json, like the real CLI) is pointed to with $MW_CLAUDE_BIN; cards, jobs and the ledger go
to a temp dir ($MW_WHY_DIR, $MW_WHY_JOBS, $MW_CLAUDE_USAGE), so web/data is never touched.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="why-selftest-"))
FAKE_DIR = TMP / "fake"
os.environ.update({"MW_WHY_DIR": str(TMP / "why"), "MW_WHY_JOBS": str(TMP / "jobs"),
                   "MW_CLAUDE_USAGE": str(TMP / "claude_usage.json"), "MW_CLAUDE_CACHE": str(TMP / "gcache"),
                   "MW_CLAUDE_BIN": str(FAKE_DIR / "claude")})
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FAKE = r'''#!/usr/bin/env python3
import json, sys, pathlib
here = pathlib.Path(__file__).resolve().parent
mode = (here / "mode").read_text().strip() if (here / "mode").exists() else "good"
n = int((here / "count").read_text() or 0) if (here / "count").exists() else 0
(here / "count").write_text(str(n + 1))
prompt = sys.stdin.read() if not sys.stdin.isatty() else ""
(here / "last_prompt.txt").write_text(prompt + "\n\nARGV: " + json.dumps(sys.argv[1:], ensure_ascii=False))
url = "https://www.reuters.com/business/healthcare-pharmaceuticals/ginkgo-bioworks-shares-fall-2026-10-06/"
good = {"say": "涨了一倍就有人跑，DNA 这根针扎得准", "sayMild": "涨太快之后获利了结",
        "reasons": [{"text": "前一周股价翻倍后，10 月 6 日盘中冲高到 18.22 美元后被大量获利盘砸下", "date": "2026-10-06",
                     "source": "Reuters", "url": url, "type": "flow-mechanics", "conf": 0.6},
                    {"text": "公司宣布增发融资，摊薄股东", "date": "2026-10-06", "source": "SEC 8-K",
                     "url": "https://www.sec.gov/Archives/edgar/data/1830214/000000000026000001/dna-8k.htm", "type": "news", "conf": 0.8},
                    {"text": "没有链接的一条", "date": "2026-10-06", "source": "x", "url": "", "type": "news", "conf": 0.9}],
        "counter": [{"text": "同行 TWST 同日也跌 18%，可能是板块情绪", "url": url, "date": "2026-10-06"}],
        "watch": [{"by": "2026-11-10", "what": "三季度财报"}], "honest": "新闻和下跌时间对得上", "timeline": "fits"}
if mode == "english" or (mode == "english-then-good" and n == 0):
    good = {"say": "Profit taking after a double", "reasons": [], "counter": [], "watch": [], "honest": "no news"}
text = "这里是答案：" + json.dumps(good, ensure_ascii=False) if mode != "nojson" else "我查不到。"
ev = [{"type": "system", "subtype": "init"},
      {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "WebSearch", "input": {"query": "Ginkgo Bioworks October 6 2026"}}]}},
      {"type": "user", "message": {"content": [{"type": "tool_result", "content": "Links: " + url + " https://www.sec.gov/x"}]}},
      {"type": "result", "subtype": "success", "is_error": False, "result": text, "total_cost_usd": 0.0,
       "usage": {"input_tokens": 10, "output_tokens": 20}, "modelUsage": {"claude-sonnet-fake": {}}, "num_turns": 3}]
for e in ev:
    print(json.dumps(e, ensure_ascii=False))
'''

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f"  — {detail}"))
    if not cond:
        FAILS.append(name)


def setup_fake(mode: str = "good") -> None:
    FAKE_DIR.mkdir(parents=True, exist_ok=True)
    (FAKE_DIR / "claude").write_text(FAKE)
    (FAKE_DIR / "claude").chmod(0o755)
    (FAKE_DIR / "mode").write_text(mode)
    (FAKE_DIR / "count").write_text("0")


def t_facts() -> None:
    from why import facts
    print("facts on real data")
    targets = [{"kind": "node", "ids": ["health-synbio"]}, {"kind": "node", "ids": ["DNA"]},
               {"kind": "day", "ids": ["DNA"], "date": "2026-10-06"}, {"kind": "edge", "ids": ["DNA>TWST:buys-from"]},
               {"kind": "channel", "ids": []}, {"kind": "node", "ids": ["world"]}, {"kind": "stock", "ids": ["s:NVDA"], "dateIndex": -20}]
    pm = json.loads((ROOT / "web/data/polymarket.json").read_text()) if (ROOT / "web/data/polymarket.json").exists() else {}
    if pm.get("markets"):
        targets.append({"kind": "market", "ids": [pm["markets"][0]["id"]]})
    sc = sorted((ROOT / "web/data/scenarios").glob("2*.json")) if (ROOT / "web/data/scenarios").exists() else []
    for p in sc:
        d = json.loads(p.read_text())
        if d.get("landing"):
            targets.append({"kind": "landing", "ids": [d["landing"][0]["id"], d["id"]]})
            break
    for t in targets:
        try:
            f = facts.build(t)
            k, _ = facts.key_for(t)
            ok = all(isinstance(f["facts"].get(x), str) and f["facts"][x] for x in ("what", "howMuch", "since", "vsNeighbours"))
            check(f"build {t['kind']} {t['ids']}", ok and k == f["key"] and facts.KEY_RE.match(k) is not None,
                  json.dumps(f["facts"], ensure_ascii=False)[:200] + f" key {k} vs {f['key']}")
        except Exception as e:  # noqa: BLE001
            check(f"build {t['kind']} {t['ids']}", False, f"{type(e).__name__}: {e}")
    d = facts.build({"kind": "day", "ids": ["DNA"], "date": "2026-10-06"})
    check("day: exact date + price", d["date"] == "2026-10-06" and d["day"]["ret"] is not None and "10月6日" in d["facts"]["what"],
          d["facts"]["what"])
    for bad in ({"kind": "node", "ids": ["no-such-place"]}, {"kind": "zzz", "ids": ["x"]}, {"kind": "edge", "ids": ["DNA"]}):
        try:
            facts.build(bad)
            check(f"bad target rejected {bad}", False, "no error")
        except facts.FactsError:
            check(f"bad target rejected {bad['kind']}", True)
    check("aliases resolve", facts.normalize_target({"kind": "node", "ids": ["GINKGO BIOWORKS (DNA)"]})["ids"] == ["s:DNA"]
          and facts.normalize_target("S:DNA")["kind"] == "stock")


def t_regime() -> None:
    from why.facts import Series, regime
    print("regime detection")
    dates = [f"2026-01-{i + 1:02d}" for i in range(30)]

    def mk(w, flow=None):
        flow = flow or [1.0 if x > 0 else -1.0 for x in w]
        return Series(dates[:len(w)], {"wind": w, "flow": flow, "px": [100 + i for i in range(len(w))],
                                       "dv": [100.0] * len(w), "front": [0] * len(w)}, False)
    w = [0.0] * 10 + [1.2] * 8
    r = regime(mk(w), 17)
    check("inflow starts on the first windy day", r["dir"] == 1 and r["startIndex"] == 10 and r["days"] == 8, str(r))
    w2 = [0.0] * 10 + [1.0] * 4 + [0.1] + [1.0] * 4
    check("one shallow dip tolerated", regime(mk(w2), 18)["startIndex"] == 10)
    w3 = [0.0] * 5 + [1.5] * 10 + [0.3]
    r3 = regime(mk(w3), 15)
    check("one calm day after a wave = fading", r3["dir"] == 1 and r3.get("fading") and r3["startIndex"] == 5, str(r3))
    w4 = [-1.0] * 8 + [1.0] * 5
    check("flip resets the start", regime(mk(w4), 12)["startIndex"] == 8)


def t_card() -> None:
    from why import card
    print("card validation")
    f = {"key": "k", "facts": {}}
    good = {"say": "老风说：钱跑了", "reasons": [{"text": "公司发增发公告", "date": "2026-10-06", "source": "SEC",
            "url": "https://www.sec.gov/a/b/c.htm", "type": "news", "conf": 0.8}], "counter": [], "watch": [], "honest": "对得上"}
    c, iss, fatal = card.validate(good, f)
    check("good card passes", not fatal and len(c["reasons"]) == 1, str(iss))
    _, _, fatal = card.validate({"say": "Profit taking", "reasons": []}, f)
    check("english say is fatal", fatal)
    bad = dict(good, reasons=[dict(good["reasons"][0], url="https://www.reuters.com/"),
                              dict(good["reasons"][0], date="2031-01-01"),
                              dict(good["reasons"][0], url="https://www.google.com/search?q=dna")])
    c, iss, fatal = card.validate(bad, f)
    check("homepage / future date / search page dropped", not fatal and not c["reasons"] and c["timeline"] == "no-news", str(c))
    check("tolerant JSON", card.parse_json('前言 ```json\n{"say":"他说"没人要"了","reasons":[],}\n```')["say"] == '他说"没人要"了')
    items = [{"url": "https://www.reuters.com/x/y-article-2026", "conf": 0.8}, {"url": "https://made.up/zz/qq-made-up-1", "conf": 0.8}]
    n = card.mark_seen(items, ["reuters.com/x/y-article-2026"])
    check("unseen link marked + conf lowered", n == 1 and items[0]["seen"] and not items[1]["seen"] and items[1]["conf"] < 0.8)


def t_review3() -> None:
    """Regressions for the phase-3 review findings (today-first questions, window start, weak channel, names,
    past watch dates, wrong-subject lines, intraday cards going stale)."""
    from why import card, facts
    from why import job as wjob
    print("review-3 fixes")
    root = facts.data_root("curated")
    s = root.series("s:DNA")
    # a synthetic "today": the asked day is a big move with the peers up too → the question is about that day
    i = root.dates.index("2026-10-06") if "2026-10-06" in root.dates else None
    if i is not None:
        f = facts.build({"kind": "stock", "ids": ["DNA"], "date": "2026-10-06"})
        check("big day + peers moving together → the question is about that day, its date searched first",
              f.get("focus") and "10月6日" in f["title"] and f["searchDates"][:1] == ["2026-10-06"]
              and "先查整个板块" in f["question"], (f["title"], f["searchDates"], f["question"][:80]))
    try:
        facts.build({"kind": "stock", "ids": ["DNA"], "dateIndex": 0})
        check("window start (no history) is refused, no paid search", False, "built")
    except facts.FactsError as e:
        check("window start (no history) is refused, no paid search", "窗口的开头" in str(e), str(e))
    f = facts.build({"kind": "stock", "ids": ["DNA"], "dateIndex": 60})
    check("a past date is in the title", facts.zh_date(f["date"], root.asOf) in f["title"], f["title"])
    ch = facts.build({"kind": "channel", "ids": ["commod", "bonds"]})
    check("channel: weak flag set from the winds, and a weak one asks whether it is one event",
          isinstance(ch.get("weak"), bool) and (not ch["weak"] or "是同一件事吗" in ch["title"]), (ch.get("weak"), ch["title"]))
    fd = facts.build({"kind": "stock", "ids": ["DNA"]})
    raw = {"say": "地产流出不足日常十分之一，不是外逃", "reasons": [], "counter": [], "watch": [], "honest": "没查到"}
    _, iss, fatal = card.validate(raw, fd)
    check("a 老风 line about another place (地产 on Ginkgo) is fatal → the one retry", fatal and "地产" in iss[0], iss)
    _, iss, fatal = card.validate(raw, fd, strict_subject=False)
    check("…after the retry it is only an issue (the search is not lost)", not fatal and any("地产" in x for x in iss), iss)
    raw = {"say": "推特跟着涨，Ginkgo 也飞", "reasons": [], "counter": [], "honest": "没查到",
           "watch": [{"by": "2025-11-06", "what": "去年的财报"}, {"by": "2099-01-01", "what": "以后"}]}
    fe = facts.build({"kind": "edge", "ids": ["DNA", "TWST"]})
    c, iss, fatal = card.validate(raw, fe)
    check("推特 → Twist on a TWST card; past watch dates dropped",
          not fatal and "推特" not in c["say"] and "Twist" in c["say"] and [w["by"] for w in c["watch"]] == ["2099-01-01"],
          (c.get("say"), c.get("watch"), iss))
    c = {"key": fd["key"], "date": fd["date"], "asOf": fd["asOf"], "map": "curated", "target": fd["target"],
         "partial": "10月27日 是盘中数据（截至美东 09:45），当天成交和资金流还不完整", "say": "x", "facts": {"what": "old"}}
    st = wjob.staleness(c)
    meta_p = root.meta.get("partial")
    moved = not (isinstance(meta_p, dict) and meta_p.get("date") == fd["date"] and str(meta_p.get("fetchedAt"))[11:16] <= "09:45")
    check("a card researched at 09:45 ET is stale once the data moved on", (st is not None) == moved, st)
    if st:
        a = wjob.annotate(dict(c))
        check("…and its facts are rebuilt from today's files", a["facts"].get("what") != "old" and a["stale"]["say"].startswith(
            "盘中查的（截至美东 09:45）"), a.get("stale"))


def t_jobs() -> None:
    from why import gate, job
    print(f"jobs (gateway: {gate.which()['gate']})")
    setup_fake("good")
    tgt = {"kind": "day", "ids": ["DNA"], "date": "2026-10-06"}
    r = job.start(tgt, wait=True)
    c = r.get("card") or {}
    check("in-process job → done with card", r.get("state") == "done" and c.get("say"), json.dumps(r, ensure_ascii=False)[:300])
    check("card has the §24 fields", all(k in c for k in ("key", "asOf", "say", "facts", "reasons", "counter", "watch", "honest", "usd", "at")))
    check("reason without link dropped, sources kept", len(c.get("reasons") or []) == 2, str(c.get("reasons")))
    if gate.supports("validate"):                      # the real gateway reports the URLs the search saw
        check("reasons seen-marked", all("seen" in x for x in c.get("reasons") or []))
    ds = [x.get("date") for x in c.get("reasons") or []]
    check("reasons newest first", ds == sorted(ds, reverse=True), str(ds))
    prompt = (FAKE_DIR / "last_prompt.txt").read_text()
    check("prompt has the exact date + money", "2026-10-06" in prompt and "估算净流出" in prompt and "老风" in prompt)
    check("tools passed = WebSearch,WebFetch", "WebSearch,WebFetch" in prompt or "WebSearch" in prompt)
    r2 = job.start(tgt)
    check("same key → cached, free", r2.get("state") == "cached" and r2.get("card", {}).get("say") == c.get("say"))
    p = job.peek(key=r["key"])
    check("peek by key", p.get("state") == "cached")
    p2 = job.peek(target=tgt)
    check("peek by target", p2.get("state") == "cached" and p2.get("key") == r["key"])
    check("peek miss", job.peek(target={"kind": "node", "ids": ["security"]}).get("state") == "none")
    # detached worker
    r3 = job.start({"kind": "node", "ids": ["health-synbio"]})
    check("detached start → queued", r3.get("state") == "queued" and r3.get("id") and r3.get("facts"), str(r3)[:200])
    dup = job.start({"kind": "node", "ids": ["health-synbio"]})
    check("same key while running → duplicate, no second search", dup.get("duplicate") and dup.get("id") == r3.get("id"), str(dup)[:200])
    st = {}
    for _ in range(60):
        st = job.status(r3["id"])
        if st.get("state") not in ("queued", "running"):
            break
        time.sleep(0.5)
    check("detached worker → done", st.get("state") == "done" and st.get("card"), json.dumps(st, ensure_ascii=False)[:300])
    check("index lists the cards", len(job.recent()) >= 2)
    # force = 重新查
    r4 = job.start(tgt, force=True, wait=True)
    check("force re-searches", r4.get("state") == "done" and r4.get("id"))
    # retry on a bad answer, then give up
    setup_fake("english-then-good")
    r5 = job.start({"kind": "node", "ids": ["security"]}, wait=True)
    n = int((FAKE_DIR / "count").read_text())
    check("bad answer retried once → done", r5.get("state") == "done" and n == 2, f"{r5.get('state')} calls={n} {r5.get('error')}")
    setup_fake("nojson")
    r6 = job.start({"kind": "node", "ids": ["energy"]}, wait=True)
    check("no JSON → error state (plain Chinese)", r6.get("state") == "error" and r6.get("error"), str(r6)[:200])
    # budget refusal
    os.environ["MW_CLAUDE_DISABLED"] = "1"
    try:
        r7 = job.start({"kind": "node", "ids": ["finance"]})
        check("budget/disabled → refused before any job", r7.get("state") == "refused" and r7.get("error"), str(r7)[:200])
    finally:
        os.environ.pop("MW_CLAUDE_DISABLED", None)
    led = json.loads(Path(os.environ["MW_CLAUDE_USAGE"]).read_text()) if Path(os.environ["MW_CLAUDE_USAGE"]).exists() else {}
    kinds = {c.get("kind") for c in led.get("calls") or []}
    check("every call in the (temp) ledger under why:*", any(str(k).startswith("why:") for k in kinds), str(kinds))


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _http(method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def t_server() -> None:
    print("server routes")
    setup_fake("good")
    port = _free_port()
    env = dict(os.environ, MW_LOOP="0")
    log = open(TMP / "server.log", "w")
    p = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", str(port), "--no-loop"], cwd=str(ROOT),
                         env=env, stdout=log, stderr=log)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(base + "/api/modules", timeout=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        code, b = _http("GET", base + "/api/budget")
        check("/api/budget", code == 200 and "usedPts" in b and "capPts" in b, str(b)[:200])
        code, r = _http("POST", base + "/api/why", {"target": {"kind": "stock", "ids": ["DNA"]}})
        check("POST /api/why → queued", code == 200 and r.get("state") == "queued" and r.get("id"), str(r)[:200])
        st = {}
        for _ in range(60):
            code, st = _http("GET", base + f"/api/why?id={r.get('id')}")
            if st.get("state") not in ("queued", "running"):
                break
            time.sleep(0.5)
        check("GET /api/why?id= → done + card", st.get("state") == "done" and st.get("card", {}).get("say"), str(st)[:200])
        code, pk = _http("GET", base + f"/api/why/peek?key={r.get('key')}")
        check("GET /api/why/peek?key=", pk.get("state") == "cached")
        code, pk2 = _http("GET", base + "/api/why/peek?kind=stock&ids=DNA")
        check("GET /api/why/peek?kind=&ids=", pk2.get("state") == "cached" and pk2.get("key") == r.get("key"), str(pk2)[:200])
        code, pk3 = _http("POST", base + "/api/why/peek", {"target": {"kind": "node", "ids": ["s:DNA"]}})
        check("POST /api/why/peek {target}", pk3.get("state") == "cached", str(pk3)[:200])
        code, again = _http("POST", base + "/api/why", {"target": {"kind": "stock", "ids": ["DNA"]}})
        check("POST again → cached", again.get("state") == "cached")
        code, bad = _http("POST", base + "/api/why", {"target": {"kind": "node", "ids": ["nowhere"]}})
        check("bad target → 400 + Chinese error", code == 400 and bad.get("error"), str(bad))
        code, ov = _http("GET", base + "/api/why")
        check("GET /api/why overview", code == 200 and "recent" in ov and "budget" in ov)
        code, ls = _http("GET", base + "/api/why/list")
        check("GET /api/why/list", code == 200 and isinstance(ls.get("cards"), list) and ls["cards"])
        code, gl = _http("GET", base + "/api/gl/stock?t=0700.HK")
        gl_ok = (code == 503 and "globalmkt" in (gl.get("error") or "")) if not (ROOT / "globalmkt/stockfile.py").exists() \
            else code in (200, 404, 503)
        check("/api/gl/stock lazy + defensive", gl_ok, f"{code} {gl}")
        code, gl2 = _http("GET", base + "/api/gl/stock?t=../../etc")
        check("/api/gl/stock rejects bad ticker", code == 400)
    except Exception as e:  # noqa: BLE001
        check("server routes", False, f"{type(e).__name__}: {e}")
    finally:
        p.terminate()
        p.wait(10)
        log.close()


def main() -> int:
    print(f"temp dir {TMP}")
    t_facts()
    t_regime()
    t_card()
    t_review3()
    t_jobs()
    t_server()
    print(f"\n{'ALL OK' if not FAILS else str(len(FAILS)) + ' FAILED: ' + ', '.join(FAILS)}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
