#!/usr/bin/env python3
"""intel/selftest.py — offline checks for the intel layer (no network, no real Claude call).

    python3 intel/selftest.py          # ~5 s; uses a stub `claude` and a temp store
    python3 intel/selftest.py --live   # also one real `claude -p` dry-run ingest (~15–30 s)

Never touches the real store: MW_INTEL_PATH points at a temp file before anything is imported.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="mw-intel-test-"))
os.environ["MW_INTEL_PATH"] = str(TMP / "intel.json")
os.environ["MW_POLYMARKET_JSON"] = str(TMP / "polymarket.json")
LIVE = "--live" in sys.argv
if not LIVE:
    os.environ["MW_CLAUDE_BIN"] = str(TMP / "claude-stub")
    os.environ["MW_CLAUDE_USAGE"] = str(TMP / "claude_usage.json")   # stub runs stay out of the real ledger (§24 gate)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from intel import catalog, fetch, ingest, job, links, store  # noqa: E402

FAILS: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f"  → {detail}"))
    if not cond:
        FAILS.append(name)


# ── a stub claude: 1st call → garbage, later calls → a valid answer (exercises the one retry) ──
COUNTER = TMP / "calls"
cat = catalog.load_catalog()
region = next(n.id for n in cat.regions if n.depth >= 2 and any(c.startswith("s:") for c in n.children))
stock = cat.stocks[0] if cat.stocks else None
GOOD = {"events": [{
    "title": "测试：某公司说订单翻倍——还要涨", "summary": "一段摘要。", "eventDate": "2026年10月26日",
    "kind": "Earnings", "credibility": 85, "novelty": "NEW", "signal": "minor",
    "impacts": [{"id": region, "dir": 1, "strength": 5, "lag": "1y+", "why": "因为订单翻倍"},
                {"id": "no-such-place", "dir": -1, "strength": 2, "lag": "now", "why": "x"},
                {"id": region.upper().replace("-", " "), "dir": 1, "strength": 1, "lag": "now", "why": "dup"}],
    "tickers": [{"t": (stock.ticker if stock else "MU"), "dir": 1, "why": "被点名"}, {"t": "ZZZZ", "dir": 1}],
    "polymarket": [{"id": "pm-1", "relation": "supports", "say": "让 YES 更可能"},
                   {"id": "pm-made-up", "relation": "supports"}],
    "scenarios": [{"id": "nope", "effect": "supports", "say": "x"}],
    "say": "钱可能会往这里走。"}]}
stub = TMP / "claude-stub"
(TMP / "good.json").write_text(json.dumps(GOOD, ensure_ascii=False), encoding="utf-8")
stub.write_text(f"""#!{sys.executable}
import sys, json, pathlib, time
inp = sys.stdin.read()
good = pathlib.Path({str(TMP / "good.json")!r}).read_text(encoding="utf-8")
if "拉面" in inp:
    body = json.dumps({{"events": [], "reason": "午饭吃什么跟钱的流向没关系"}}, ensure_ascii=False)
elif "SLOWJOB" in inp:
    time.sleep(4); body = good
else:
    c = pathlib.Path({str(COUNTER)!r}); n = int(c.read_text() or 0) if c.exists() else 0; c.write_text(str(n + 1))
    body = "抱歉我不确定" if n == 0 else good
print(json.dumps({{"type": "result", "is_error": False, "result": body, "total_cost_usd": 0}}, ensure_ascii=False))
""", encoding="utf-8")
stub.chmod(0o755)
(TMP / "polymarket.json").write_text(json.dumps({"markets": [
    {"id": "pm-1", "q": "Will Micron beat earnings?", "qZh": "美光财报会超预期吗？", "prob": 0.55, "d7": 0.1,
     "volume": 100000, "slug": "mu-beat", "nodes": []}]}))

print("fetch / html")
info = fetch.html_to_text("""<html><head><title>T</title><meta property="article:published_time"
 content="2026-10-22T08:00:00Z"></head><body><nav>Home Menu Login</nav><article><h1>Headline here</h1>
 <p>First paragraph with enough words to be kept as text in the article body.</p><script>var x=1</script>
 <p>第二段中文内容，说明订单翻倍，交货期拉长到四十周。</p></article><footer>copyright</footer></body></html>""")
check("html: title", info["title"] == "T", info)
check("html: published", info["published"] == "2026-10-22", info)
check("html: no nav/script/footer", "Menu" not in info["text"] and "var x" not in info["text"]
      and "copyright" not in info["text"], info["text"])
check("html: keeps paragraphs", "First paragraph" in info["text"] and "交货期" in info["text"], info["text"])
check("date: english", fetch._date_only("— Sam (@sama) January 6, 2025") == "2025-01-06")
info2 = fetch.html_to_text("<html><body><div><p>For release at 2:00 p.m. EDT September 17, 2025 the Committee "
                           "decided to lower the target range for the federal funds rate.</p></div></body></html>")
check("date: fallback from text", info2["published"] == "2025-09-17", info2)
check("url: refuses localhost", not fetch.fetch_url("http://127.0.0.1:8765/").ok)
check("url: refuses file://", not fetch.fetch_url("file:///etc/passwd").ok)
check("url: slug words", "hbm" in fetch.slug_words("https://x.com/tech/micron-hbm-sold-out-2026-10-27/"))

print("catalog")
check(f"catalog loads ({cat.source}, {len(cat.regions)} regions)", len(cat.regions) > 5)
check("repair: exact", cat.repair_id(region) == region)
check("repair: spaced/upper", cat.repair_id(region.upper().replace("-", " ")) == region)
check("repair: junk → None", cat.repair_id("no-such-place") is None)
if stock:
    check("repair: s:lower", cat.repair_id("s:" + stock.ticker.lower()) == stock.id)
    check("repair: $TICKER", cat.repair_id("$" + stock.ticker) == stock.id)
check("compact text has ids", region in cat.compact_text())
check("season rule", catalog.season(1.0, 0.5, 40)["key"] == "spring" and catalog.season(1.0, 0, 90)["key"] == "summer")
check("season: table order (hot+crowded+cooling is still summer)", catalog.season(1.0, -0.8, 90)["key"] == "summer")
check("catalog prefers the map's tree.json", cat.source == "tree", cat.source)

print("validation")
mk = links.polymarket_candidates("美光 财报 earnings Micron", set())
check("pm local match", [m["id"] for m in mk] == ["pm-1"], mk)
evs, rep = ingest.clean_events(GOOD, cat=cat, markets=mk, scenarios=[], today=date(2026, 10, 27))
e = evs[0]
check("enum repair kind", e["kind"] == "earnings", e["kind"])
check("credibility 85 → 0.85", e["credibility"] == 0.85, e["credibility"])
check("novelty NEW → new", e["novelty"] == "new", e["novelty"])
check("date 2026年10月26日", e["eventDate"] == "2026-10-26", e["eventDate"])
check("no dashes in title", "—" not in e["title"], e["title"])
ri = [i for i in e["impacts"] if i["id"] == region]
check("strength clipped to 3, lag 1y+ → 3-12m", ri and ri[0]["strength"] == 3 and ri[0]["lag"] == "3-12m", ri)
check("unknown id dropped", "no-such-place" in rep["dropped"], rep)
check("made-up market dropped", [p["id"] for p in e["polymarket"]] == ["pm-1"] and e["polymarket"][0]["prob"] == 0.55,
      e["polymarket"])
check("made-up scenario dropped", e["scenarios"] == [], e["scenarios"])
check("off-map ticker kept aside", "ZZZZ" in e["offMap"], e["offMap"])
check("sayMild falls back to say", e["sayMild"] == e["say"], e)
rum = json.loads(json.dumps(GOOD))
rum["events"][0].update(kind="rumor", credibility=0.9, eventDate="2026-09-01", novelty="probably-known")
re_, _ = ingest.clean_events(rum, cat=cat, markets=[], scenarios=[], today=date(2026, 10, 27))
check("rumor credibility capped at 0.5", re_[0]["credibility"] == 0.5, re_[0]["credibility"])
check("56-day-old event → novelty old", re_[0]["novelty"] == "old", re_[0]["novelty"])
emp, erep = ingest.clean_events({"events": [], "reason": "闲聊"}, cat=cat, markets=[], scenarios=[],
                                today=date(2026, 10, 27))
check("empty events = honest 'not on the map'", emp == [] and erep.get("reason") == "闲聊", erep)
noisy = json.loads(json.dumps(GOOD))
noisy["events"][0]["signal"] = "noise"
ne, _ = ingest.clean_events(noisy, cat=cat, markets=[], scenarios=[], today=date(2026, 10, 27))
check("noise: strength 1, ≤2 impacts, says so", all(i["strength"] == 1 for i in ne[0]["impacts"])
      and len(ne[0]["impacts"]) <= 2 and "噪" in ne[0]["say"], ne[0])
try:
    ingest.clean_events({"events": [{"title": "x", "impacts": [{"id": "a1"}, {"id": "b2"}, {"id": "c3"}]}]},
                        cat=cat, markets=[], scenarios=[], today=date(2026, 10, 27))
    check("mostly-unknown ids → Rejected", False)
except ingest.Rejected:
    check("mostly-unknown ids → Rejected", True)
try:
    ingest.clean_events("not json", cat=cat, markets=[], scenarios=[], today=date(2026, 10, 27))
    check("non-object → Rejected", False)
except ingest.Rejected:
    check("non-object → Rejected", True)

if not LIVE:
    print("ingest (stub claude: garbage first, valid on retry)")
    r = ingest.ingest(text="美光说订单翻倍 (MU)", source="paste")
    check("ingest ok after one retry", r["ok"] and r["events"][0]["meta"]["attempts"] == 2, r.get("error"))
    check("stored newest first", store.load() and store.load()[0]["id"] == r["events"][0]["id"])
    check("event has reach + pricedIn keys", "reach" in r["events"][0]
          and "pricedIn" in r["events"][0]["impacts"][0])
    r2 = ingest.ingest(text="美光说订单翻倍 (MU)", source="paste")
    check("duplicate input not stored twice", r2.get("dup") and len(store.load()) == len(r["events"]))
    imp0 = r["events"][0]["impacts"][0]
    check("impacts carry §14 est/basis", imp0.get("est") is True and imp0.get("basis"), imp0)
    # refresh: pricedIn is recomputed from today's weather, pricedIn0 (day it was fed) is kept
    with store.locked():
        cur = store._read()
        cur[0]["impacts"][0]["pricedIn"] = 0.01
        cur[0]["impacts"][0]["pricedIn0"] = 0.02
        cur[0]["impacts"].append({"id": "vanished-region", "dir": 1, "strength": 1, "lag": "now", "why": "x"})
        store.atomic_write_json(store.INTEL_PATH, cur)
    rr = ingest.refresh_all()
    i0 = store.load()[0]["impacts"]
    check("refresh: recomputes pricedIn, keeps pricedIn0, drops ids no longer on the map",
          rr["refreshed"] >= 1 and i0[0]["pricedIn"] != 0.01 and i0[0]["pricedIn0"] == 0.02
          and all(i["id"] != "vanished-region" for i in i0), (rr, i0))
    gid = r["events"][0]["groupId"]
    check("delete by groupId", store.delete(gid) == len(r["events"]) and store.load() == [])

    ri = ingest.ingest(text="中午吃了拉面，挺好吃。", source="paste")
    check("irrelevant input: ok, nothing stored, says why", ri["ok"] and ri.get("irrelevant") and ri["events"] == []
          and store.load() == [] and any("没上地图" in w for w in ri["warnings"]), ri)

    print("scout events are adopted (validated + enriched) by store.add")
    sc_ev = {"id": "scout-t1", "addedAt": "2026-10-27T10:00:00", "source": "scout", "title": "侦察兵：美光为什么暴涨",
             "summary": "x" * 300, "eventDate": "2026-10-27", "kind": "news", "credibility": 0.7,
             "novelty": "probably-known", "say": "订单爆了。",
             "impacts": [{"id": region, "dir": 1, "strength": 2, "lag": "now", "why": "订单"},
                         {"id": "made-up-region", "dir": 1, "strength": 3, "lag": "now", "why": "x"}],
             "sources": [{"url": "https://example.com"}], "scout": {"taskId": "t1"}}
    store.add([sc_ev])
    got = store.load()[0]
    check("scout: unknown id dropped, known kept", [i["id"] for i in got["impacts"]] == [region], got["impacts"])
    check("scout: enriched (name, reach, groupId, est)", got["impacts"][0].get("name") and got.get("reach")
          and got.get("groupId") == "scout-t1" and got["impacts"][0].get("est") is True, got)
    check("scout: extra fields + long summary kept", got.get("sources") and got.get("scout")
          and len(got["summary"]) == 300, got)
    raw_scout = dict(sc_ev, id="scout-t2", groupId="scout-t2", reach={"x": 1},
                     impacts=[{"id": region, "dir": 1, "strength": 2, "lag": "now", "why": "订单", "pricedIn": 0.5}])
    store.add([raw_scout])                    # pre-enriched by its writer (has reach + groupId): still adopted
    t2 = next(e for e in store.load() if e["id"] == "scout-t2")
    check("scout: pre-enriched event still validated (signal, sayMild, weight)", t2.get("signal") and
          t2.get("sayMild") and "weight" in t2 and (t2.get("meta") or {}).get("adopted"), t2)
    store.delete("scout-t2")
    store.add([dict(sc_ev, say="改了")])
    check("scout: same id upserts", len(store.load()) == 1 and store.load()[0]["say"] == "改了", store.load())
    store.delete("scout-t1")

    print("concurrent writers (8 processes × 15 adds + deletes)")
    writer = TMP / "writer.py"
    writer.write_text(f"""import sys, os
sys.path.insert(0, {str(Path(__file__).resolve().parent.parent)!r})
from intel import store
w = int(sys.argv[1])
for i in range(15):
    store.add([{{"id": f"w{{w}}-{{i}}", "groupId": f"w{{w}}-{{i}}", "reach": {{}}, "title": "t"}}])
    if i % 5 == 4:
        store.delete(f"w{{w}}-{{i - 1}}")
""", encoding="utf-8")
    procs = [subprocess.Popen([sys.executable, str(writer), str(w)]) for w in range(8)]
    codes = [pp.wait() for pp in procs]
    ids = [e["id"] for e in store.load()]
    check("concurrent: all writers exit 0", codes == [0] * 8, codes)
    check("concurrent: 8×15 adds − 8×3 deletes = 96, no dupes", len(ids) == 96 and len(set(ids)) == 96, len(ids))
    check("concurrent: file is valid JSON", isinstance(json.loads(Path(store.INTEL_PATH).read_text()), list))
    for i in list(ids):
        store.delete(i)
    check("concurrent: cleaned", store.load() == [])

    print("job + route (stub)")
    COUNTER.write_text("1")
    code, res = job.route("POST", "/api/intel", "", json.dumps({"text": "另一条：订单翻倍"}).encode())
    check("POST /api/intel starts", code == 200 and res.get("started"), res)
    st = {}
    for _ in range(100):
        _, st = job.route("GET", "/api/intel", f"id={res.get('id')}", None)
        if st.get("state") not in ("queued", "running"):
            break
        time.sleep(0.1)
    check("job finishes done with events", st.get("state") == "done" and st.get("events"), st)
    _, lst = job.route("GET", "/api/intel/list", "", None)
    check("GET /api/intel/list", lst.get("count") == len(st.get("events") or []), lst)
    eid = (st.get("events") or [{}])[0].get("id")
    _, d = job.route("DELETE", "/api/intel", f"id={eid}", None)
    check("DELETE /api/intel?id=<event>", d.get("deleted") == 1, d)
    check("route ignores other paths", job.route("GET", "/api/status", "", None) is None)
    check("empty POST → error", job.route("POST", "/api/intel", "", b"")[1].get("started") is False)
    check("bad JSON POST → 400", job.route("POST", "/api/intel", "", b"{nope")[0] == 400)
    check("DELETE unknown id → deleted 0 + error", job.route("DELETE", "/api/intel", "id=intel-nope", None)[1]
          .get("deleted") == 0)
    check("GET status of a bad job id", job.route("GET", "/api/intel", "id=../../etc/passwd", None)[1]
          .get("state") == "error")
    mine = [res.get("id")]

    print("job cap + cancel (slow stub)")
    starts = [job.route("POST", "/api/intel", "", json.dumps({"text": f"SLOWJOB {k}"}).encode())[1] for k in range(5)]
    ok_ids = [x["id"] for x in starts if x.get("started")]
    mine += [x.get("id") for x in starts if x.get("id")]
    check("only 3 jobs run at once, the rest are told to wait", len(ok_ids) == 3
          and all("等一下" in (x.get("error") or "") for x in starts if not x.get("started")), starts)
    _, cancel = job.route("DELETE", "/api/intel", f"id={ok_ids[0]}", None)
    _, cst = job.route("GET", "/api/intel", f"id={ok_ids[0]}", None)
    check("DELETE a running job cancels it", cancel.get("cancelled") and cst.get("state") == "cancelled", (cancel, cst))
    for jid in ok_ids[1:]:
        for _ in range(100):
            _, st = job.route("GET", "/api/intel", f"id={jid}", None)
            if st.get("state") not in ("queued", "running"):
                break
            time.sleep(0.1)
    time.sleep(0.3)
    _, cst2 = job.route("GET", "/api/intel", f"id={ok_ids[0]}", None)
    check("a cancelled job stays cancelled", cst2.get("state") == "cancelled", cst2)
    check("the other two finished", all(job.route("GET", "/api/intel", f"id={j}", None)[1].get("state") == "done"
                                         for j in ok_ids[1:]))
    for jid in mine:
        for f in job.JOBS_DIR.glob(f"{jid}*"):
            f.unlink()
else:
    print("live claude (dry run)")
    t0 = time.time()
    r = ingest.ingest(text="OpenAI 发布了一个新的小模型，编程跑分高了几分，价格便宜一半。", dry_run=True, source="paste")
    check(f"live ingest ok in {time.time() - t0:.0f}s", r["ok"], r.get("error"))
    if r["ok"]:
        e = r["events"][0]
        print("     ", e["title"], e["signal"], e["novelty"], "|", e["say"])
        check("daily AI release judged as noise", e["signal"] == "noise", e["signal"])

print()
print("ALL OK" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
