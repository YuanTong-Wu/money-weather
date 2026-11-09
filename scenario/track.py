#!/usr/bin/env python3
"""Re-score saved scenarios against newer map data (DESIGN §9 step 3).

    python3 scenario/track.py                    # every scenario in web/data/scenarios ($MW_SCENARIO_DIR)
    python3 scenario/track.py --dir web/data/scenarios --data web/data
    from scenario import track; track.track_all()

For each scenario: since the data date it was made on, did the places it named move the way it
said? Price: the place's return minus the whole map's return (so a rising tide doesn't count as a
hit). Money: the sum of daily net flow over the same days. Also (playbook step 7, the second way to
leave): is the 时间差 still there? Each landing spot's priced-in is recomputed on today's data;
when it has climbed to ≥ 0.7 the market has caught up ("已经付过钱了"). Writes result["track"] back
in place and rebuilds web/data/scenarios/index.json.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date as _date
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import numpy as np  # noqa: E402

from weather import World, _arr, priced_in  # noqa: E402

MIN_DAYS = 5  # fewer trading days than this: report, but say it's too early


def _date_end(s):
    from engine import date_end
    return date_end(s)


def score(result: dict, world: World, today: _date | None = None) -> dict:
    today = today or _date.today()
    since = result.get("asOf")
    t0 = world.idx_at(since) if since else None
    t1 = len(world.dates) - 1
    due = [k for k in (result.get("killSignals") or [])
           if (_date_end(k.get("by")) or _date(2100, 1, 1)) <= today]
    base = {"asOf": world.asOf, "since": since, "due": due}
    if t0 is None or (since and since < world.dates[0]):
        return {**base, "days": None, "hit": 0, "miss": 0, "say": "这个推演太老了，已经滑出一年的数据窗口"}
    days = t1 - t0
    if days < 1:
        return {**base, "days": 0, "hit": 0, "miss": 0, "flowHit": 0, "rate": None,
                "say": "刚推演完，过几个交易日再来看对没对"}

    def ret(nid):
        s = world.series.get(nid)
        if not s:
            return None
        idx = _arr(s.get("idx"))
        if len(idx) <= t1 or np.isnan(idx[t0]) or np.isnan(idx[t1]) or idx[t0] <= 0:
            return None
        return float(idx[t1] / idx[t0] - 1)

    tide = ret("world") or 0.0
    names = {**{i: True for i, n in (result.get("nodes") or {}).items() if n.get("source") == "direct"},
             **{l["id"]: True for l in result.get("landing") or []}}
    out_nodes, hit, miss, flow_hit, w_hit, w_all = {}, 0, 0, 0, 0.0, 0.0
    for nid in names:
        n = (result.get("nodes") or {}).get(nid)
        if not n or nid not in world.nodes:
            continue
        r = ret(nid)
        if r is None:
            continue
        s = world.series.get(nid) or {}
        flow = _arr(s.get("flow"))[t0 + 1:t1 + 1]
        wind = _arr(s.get("wind"))
        fsum = float(np.nansum(flow)) if len(flow) else 0.0
        excess = r - tide
        ok = (excess > 0) == (n["dir"] > 0) and abs(excess) > 1e-9
        fok = (fsum > 0) == (n["dir"] > 0) and fsum != 0
        wchg = float(wind[t1] - wind[t0]) if len(wind) > t1 and not np.isnan(wind[t0]) and not np.isnan(wind[t1]) else 0.0
        out_nodes[nid] = {"dir": n["dir"], "ret": round(r, 4), "excess": round(excess, 4), "flow": round(fsum, 1),
                          "windChg": round(wchg, 2), "ok": bool(ok), "flowOk": bool(fok)}
        hit += ok
        miss += not ok
        flow_hit += fok
        wt = abs(n.get("impact") or 1.0)
        w_all += wt
        w_hit += wt * ok
    # is the time gap still there? (priced-in now vs when the scenario was made)
    gap_nodes, caught = {}, []
    for l in result.get("landing") or []:
        nid = l["id"]
        if nid not in world.nodes:
            continue
        pi_now, _ = priced_in(l["dir"], world.feat(nid))
        gap_nodes[nid] = {"then": l.get("pricedIn"), "now": pi_now,
                          "gapNow": round(abs(l.get("impact") or 0) * (1 - pi_now), 2)}
        if pi_now >= 0.7 and (l.get("pricedIn") or 0) < 0.7:
            caught.append(l.get("name") or nid)
    if caught:
        gap_say = "、".join(f"【{c}】" for c in caught[:3]) + "已经被市场追上，时间差没了"
    elif gap_nodes:
        d_avg = sum(g["now"] - (g["then"] or 0) for g in gap_nodes.values()) / len(gap_nodes)
        gap_say = ("时间差在收窄，市场开始按你的日期算" if d_avg > 0.1 else
                   "时间差还在，市场还没追上来" if d_avg > -0.1 else "时间差反而拉大了，市场更不信了")
    else:
        gap_say = ""

    total = hit + miss
    rate = round(w_hit / w_all, 2) if w_all else None
    if total == 0:
        say = mild = "这些地块没有能对比的数据"
    else:
        mild = (f"过去 {days} 个交易日：{total} 个地块里 {hit} 个按你说的方向走了"
                f"（跟整张地图比），钱的流向对上 {flow_hit} 个。")
        if days < MIN_DAYS:
            say = mild + f"才 {days} 天，先别当真。"
        elif rate is not None and rate >= 0.65:
            say = mild + "市场正一步步走进你的剧本。"
        elif rate is not None and rate <= 0.35:
            say = mild + "到现在市场都在跟你对着干，看认错线。"
        else:
            say = mild + "一半一半，还看不出。"
    if due:
        say += f"有 {len(due)} 条认错线到期了，去核对一下。"
        mild += f"有 {len(due)} 条认错线到期了。"
    return {**base, "days": days, "hit": hit, "miss": miss, "flowHit": flow_hit, "rate": rate,
            "tide": round(tide, 4), "say": say, "sayMild": mild, "nodes": out_nodes, "gap": gap_nodes,
            "gapSay": gap_say,
            "caught": caught}


def track_all(dir_=None, data=None, today: _date | None = None) -> list[dict]:
    from engine import OUT_DIR, refresh_markets, write_index
    d = Path(dir_ or OUT_DIR)
    if not d.exists():
        return []
    world = World(data)
    out = []
    for p in sorted(d.glob("*.json")):
        if p.name == "index.json" or p.name.endswith((".raw.json", ".status.json")):
            continue
        try:
            r = json.loads(p.read_text())
        except Exception:
            continue
        if not isinstance(r, dict) or "nodes" not in r:
            continue
        r["track"] = score(r, world, today)
        try:
            refresh_markets(r, world.dir)        # today's market odds, no raw ids, take agrees with the ranking
        except Exception:  # noqa: BLE001 — scoring stands even if the market refresh fails
            pass
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(r, ensure_ascii=False, indent=1))
        os.replace(tmp, p)
        out.append({"id": r["id"], "title": r.get("title"), **{k: r["track"].get(k) for k in
                                                                ("days", "hit", "miss", "flowHit", "rate", "say",
                                                                 "gapSay")}})
    write_index(d)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="给保存过的推演重新打分")
    ap.add_argument("--dir", help="推演结果目录（默认 web/data/scenarios 或 $MW_SCENARIO_DIR）")
    ap.add_argument("--data", help="地图数据目录（默认 web/data）")
    a = ap.parse_args(argv)
    try:
        rows = track_all(a.dir, a.data)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1
    for r in rows:
        print(f"{r['id']}  {r['title']}: {r['say']} {r.get('gapSay') or ''}")
    print(f"scored {len(rows)} scenario(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
