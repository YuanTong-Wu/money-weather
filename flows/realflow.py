#!/usr/bin/env python3
"""realflow.py — real ETF creations/redemptions put on the curated map's own trading days (DESIGN §2, §14, §23).

The map's `flow` is an ESTIMATE (§2: DV × push). For the ~85 ETFs whose issuer publishes daily shares (iShares,
SPDR: etf.json `history:"issuer-daily"`, est:false) we know the real number, and the estimate is far off for most
of them — 5 issuer days to 10-26: HYG est +5,989 M vs real +179 M; TLT +4,571 vs +8; GLD −6,075 vs −2,298; FXI −783
vs −10 — and on any lag the estimate is ~uncorrelated with the real flow (median ρ ≈ 0.0–0.09). This module:

  1. shifts every issuer-dated flow back ONE US trading day: the shares an issuer publishes for day t contain the
     creations/redemptions traded on t−1 (T+1 booking). Measured, not assumed: |real flow on issuer day t| lines up
     best with that ETF's dollar-volume spike on t−1 (rank ρ 0.29 SPDR / 0.21 iShares, vs 0.08 / 0.07 at lag 0 and
     ≤ 0.15 at t−2; 85 ETFs, 252 days);
  2. aligns it to web/data/meta.json `dates` (null where the issuer has not published that trade day yet — usually
     the last 1–2 sessions);
  3. writes web/data/flows/aligned.json, and
  4. offers patch functions so the pipeline (or `--apply DIR` as a step after compute, before brief) replaces the
     estimate with the real money wherever it exists (`flowSource:"real"`, estimate kept as `flowPush`), and marks
     every remaining push-based flow `flowEst: true` (see patch_stock for the field names).

    python3 flows/realflow.py                  # → web/data/flows/aligned.json  (run.sh runs it after etf)
    python3 flows/realflow.py --apply DIR      # also patch DIR/{tree.json, stocks/*.json, maps/*.json} in place
                                               #   (DIR = a curated data dir; the pipeline owns web/data itself)
    python3 flows/realflow.py --check          # print est vs real for a few ETFs (no writes)

--apply is ADDITIVE by default (update.sh runs it after compute, before brief; flows/run.sh after etf): `flow` stays the
§2 estimate everywhere (stock.js, why/facts.py, scenario … read `flow` as 估 and label it so), and the real money is put
BESIDE it — maps: `realFlow[]` (null = not measured that day), `realEst[]` (the estimate of the SAME ETFs on the SAME
days — the only fair thing to hold real money against), `realCoverage`, `realLabel`; tree: node.real {flow5, est5,
through, coverage, clash, blind, …}; stocks: `realFlow[]`, `realThrough`, `realSource`. `--replace` keeps the old
behaviour (real money written INTO `flow`) for when every reader understands `flowSource`.

反 (real money vs estimate disagree) — compare_at(), the same rule as web/js/ui/realmoney.js and pipeline/brief.py:
  · like for like: the real 5-day sum over the last 5 days that HAVE real money (≤ the day looked at), against the
    estimate of the same ETFs on exactly those days (never the whole territory's estimate, never issuer-dated days);
  · both material: |real5| ≥ max(5 M$, ½·its typical |5-day real|) and |est5| ≥ max(5 M$, ½·its typical |5-day est|)
    (typical = median over the trailing 120 windows) — a sign flip between two near-zeros is not news;
  · the estimate must be able to point both ways: when ≥ 90 % (or ≤ 10 %) of its 5-day sums over the past year have
    the same sign it is blind to direction (T-bill / money-market ETFs: the price accrues every day, so the estimate
    says "inflow" forever) → `blind`, never 反; the UI says the real money is the measure there;
  · real money more than 5 trading days behind the day looked at → no comparison (stale).

aligned.json
  { kind:"aligned", asOf, generatedAt, est:false, unit:"USD m", shift:1, dates:[meta.dates],
    tickers:{T:{flow:[len(dates), USD m | null], through, flow5, flow20, flow60, issuer, source, aum, firstIdx}},
    regions:{id:{flow:[…|null], through, flow5, flow20, flow60, coverage, covered:[T…], members:[T…]}},
    long:{path:"flows/out/aligned_long.json", days}  → that file: {dates:[~2y US trade days], tickers:{T:[USD m|null]}}
                                                        ← for a z-scored real flow5 (the wind's flow term) }
`flowN` sums are the last N real trade days ending at `through` (never padded with estimates).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, ROOT, envelope, log, r2, read_json, write_json  # noqa: E402

META = ROOT / "web" / "data" / "meta.json"
ETF_JSON = OUT / "etf.json"
ALIGNED = OUT / "aligned.json"
ALIGNED_LONG = ROOT / "flows" / "out" / "aligned_long.json"     # not served (web/js/stock.js reads every flows/*.json)
LONG_DAYS = 540
MIN_REGION_COVERAGE = 0.3
# 反 rule (see the docstring; realmoney.js / brief.py carry the same numbers)
CLASH_ABS = 5.0          # USD m: below this neither side is "material"
CLASH_REL = 0.5          # ... and at least half of its own typical 5-day size
SCALE_WINDOWS = 120      # trailing 5-day windows for "typical"
BLIND_WINDOWS = 250      # trailing 5-day windows for "can the estimate point both ways"
BLIND_SHARE = 0.9        # ≥ 90 % one sign → blind
BLIND_MIN = 40           # need this many windows to call it blind
STALE_DAYS = 5           # real money this many trade days behind → no comparison


# ----------------------------------------------------------------------------------------------- calendar
def us_calendar(etf_doc: dict, meta_dates: list[str], long_rows: dict | None = None) -> list[str]:
    """NYSE trading days: the curated map's dates (SPY's calendar) and, before them, the days that at least half of
    the issuer-daily ETFs carry. A few funds publish a NAV row on market holidays (Thanksgiving, Christmas, MLK…);
    those must not become trading days, or every other ETF's T+1 shift would land on a holiday."""
    days = set(meta_dates)
    first = min(meta_dates) if meta_dates else "9999"
    count: dict[str, int] = {}
    n = 0
    for rows in (long_rows or {}).values():
        n += 1
        for d, _ in rows:
            if d < first:
                count[d] = count.get(d, 0) + 1
    if not long_rows:
        for it in etf_doc.get("items") or []:
            if it.get("history") == "issuer-daily" and not it.get("est"):
                n += 1
                for d in it.get("date") or []:
                    if d < first:
                        count[d] = count.get(d, 0) + 1
    days.update(d for d, c in count.items() if c >= 0.5 * max(n, 1))
    return sorted(days)


def shift(dates: list[str], usd: list, cal: list[str]) -> dict[str, float]:
    """issuer-dated flows → trade-dated: each issuer date books the trades of the latest NYSE day BEFORE it (T+1).
    An issuer row on a holiday therefore lands on the day before the holiday, together with the next row."""
    import bisect
    out: dict[str, float] = {}
    for d, v in zip(dates, usd):
        k = bisect.bisect_left(cal, d) - 1
        if k >= 0 and isinstance(v, (int, float)):
            td = cal[k]
            out[td] = out.get(td, 0.0) + float(v)
    return out


def on_dates(by_day: dict[str, float], dates: list[str]) -> list:
    """Map dates → real value; inside the ETF's covered span a day without a row is 0 (the issuer skipped a day and
    the next row carries both days' net); before its first / after its last trade day → None (unknown)."""
    have = [d for d in dates if d in by_day]
    if not have:
        return [None] * len(dates)
    lo, hi = have[0], have[-1]
    return [r2(by_day[d], 2) if d in by_day else (0.0 if lo < d < hi else None) for d in dates]


def tail_sums(flow: list, n_list=(1, 5, 20, 60)) -> tuple[str | None, dict]:
    """Sums over the last N real days (ignoring the unpublished tail) → (through index, {flowN})."""
    idx = [i for i, v in enumerate(flow) if v is not None]
    if not idx:
        return None, {}
    vals = [flow[i] for i in idx]
    return idx[-1], {f"flow{n}": r2(sum(vals[-n:]), 1) for n in n_list}


# ----------------------------------------------------------------------------------------------- 反 rule
def _median(xs: list[float]) -> float:
    ys = sorted(xs)
    n = len(ys)
    if not n:
        return 0.0
    return ys[n // 2] if n % 2 else 0.5 * (ys[n // 2 - 1] + ys[n // 2])


def compare_at(real: list, est: list | None, i: int) -> dict | None:
    """Real money vs the estimate at day i (indices into the same dates). → None when there is no real money up to i
    or it is stale; else {real5, est5, through (index), lag, realScale, estScale, estPos, realMat, estMat, blind, clash}.
    est None → only the real side (realMat), never a clash."""
    have = [k for k in range(0, min(i, len(real) - 1) + 1)
            if isinstance(real[k], (int, float)) and (est is None or isinstance(est[k], (int, float)))]
    if len(have) < 5 or i - have[-1] > STALE_DAYS:
        return None
    w = have[-5:]
    r5 = sum(real[k] for k in w)
    out = {"real5": r2(r5, 1), "through": w[-1], "lag": i - w[-1]}
    sums_r = [sum(real[k] for k in have[q - 4:q + 1]) for q in range(max(4, len(have) - SCALE_WINDOWS), len(have))]
    rs = _median([abs(x) for x in sums_r])
    out["realScale"] = r2(rs, 1)
    out["realMat"] = abs(r5) >= max(CLASH_ABS, CLASH_REL * rs)
    if est is None:
        out.update(est5=None, estScale=None, estPos=None, estMat=False, blind=False, clash=False)
        return out
    e5 = sum(est[k] for k in w)
    sums_e = [sum(est[k] for k in have[q - 4:q + 1]) for q in range(max(4, len(have) - SCALE_WINDOWS), len(have))]
    es = _median([abs(x) for x in sums_e])
    long_e = [sum(est[k] for k in have[q - 4:q + 1]) for q in range(max(4, len(have) - BLIND_WINDOWS), len(have))]
    pos = sum(1 for x in long_e if x > 0) / len(long_e) if long_e else None
    blind = pos is not None and len(long_e) >= BLIND_MIN and (pos >= BLIND_SHARE or pos <= 1 - BLIND_SHARE)
    est_mat = abs(e5) >= max(CLASH_ABS, CLASH_REL * es)
    out.update(est5=r2(e5, 1), estScale=r2(es, 1), estPos=r2(pos, 2) if pos is not None else None, estMat=est_mat,
               blind=blind, clash=bool(not blind and out["realMat"] and est_mat and (r5 > 0) != (e5 > 0)))
    return out


def ticker_estimates(data_dir: Path, tickers: list[str], dates: list[str]) -> dict[str, list]:
    """The §2 estimate (DV × push) of each ETF on `dates`, from <data_dir>/stocks/<T>.json (`flowPush` if a --replace
    run left it there, else `flow`)."""
    out = {}
    for t in tickers:
        d = read_json(Path(data_dir) / "stocks" / f"{t}.json", None)
        if not isinstance(d, dict) or not d.get("dates"):
            continue
        e = d.get("flowPush") if isinstance(d.get("flowPush"), list) else d.get("flow")
        if not isinstance(e, list):
            continue
        pos = {x: k for k, x in enumerate(d["dates"])}
        out[t] = [r2(e[pos[x]], 2) if x in pos and isinstance(e[pos[x]], (int, float)) else None for x in dates]
    return out


def sum_series(rows: list[list]) -> list:
    """day-wise sum of several series; None on a day where any of them is None (never a partial sum)."""
    if not rows:
        return []
    n = len(rows[0])
    return [None if any(not isinstance(r[k], (int, float)) for r in rows) else r2(sum(r[k] for r in rows), 2)
            for k in range(n)]


# ----------------------------------------------------------------------------------------------- build
def long_history(tickers: list[str]) -> dict[str, list[tuple[str, float]]]:
    """Full issuer-dated daily flows from flows/store/etf/<T>.csv (same split/glitch guards as etf.py)."""
    try:
        import etf as E
    except Exception as e:  # noqa: BLE001
        log("realflow: cannot import etf.py for long history", e)
        return {}
    out = {}
    for t in tickers:
        try:
            fl = E.compute_flows(E.load_series(t))
            out[t] = [(x["date"], x["usd"]) for x in fl[-(LONG_DAYS + 5):]]
        except Exception as e:  # noqa: BLE001
            log("realflow: long history failed", t, e)
    return out


def build(etf_doc: dict | None = None, meta: dict | None = None, with_long: bool = True,
          data_dir: Path | None = None) -> dict:
    etf_doc = etf_doc if etf_doc is not None else read_json(ETF_JSON, {}) or {}
    data_dir = Path(data_dir) if data_dir else META.parent
    meta = meta if meta is not None else read_json(data_dir / "meta.json", {}) or {}
    dates = meta.get("dates") or []
    if not dates or not etf_doc.get("items"):
        raise RuntimeError("realflow: need web/data/meta.json dates and web/data/flows/etf.json")
    real_items = [it for it in etf_doc["items"]
                  if it.get("history") == "issuer-daily" and not it.get("est") and it.get("date")]
    long_rows = long_history([it["ticker"] for it in real_items]) if with_long else {}
    cal = us_calendar(etf_doc, dates, long_rows)
    tickers = {}
    for it in real_items:
        rows = long_rows.get(it["ticker"])       # full store history (covers the window's first days too)
        src_d, src_v = ([d for d, _ in rows], [v for _, v in rows]) if rows else (it["date"], it["usd"])
        flow = on_dates(shift(src_d, src_v, cal), dates)
        last, sums = tail_sums(flow)
        if last is None:
            continue
        first = next(i for i, v in enumerate(flow) if v is not None)
        recent = [v for v in flow if v is not None][-120:]
        active = round(sum(1 for v in recent if v) / len(recent), 2) if recent else None
        tickers[it["ticker"]] = {"flow": flow, "through": dates[last], "firstIdx": first, **sums,
                                 "activeDays120": active,     # share of days with any creation/redemption
                                 "issuer": it.get("issuer"), "source": it.get("source"), "aum": it.get("aum"),
                                 "issuerAsOf": it.get("asOf")}
    # the estimate of every ETF with real money, on the same dates: what 反 compares against (like for like)
    ests = ticker_estimates(data_dir, list(tickers), dates)
    last_i = len(dates) - 1
    for t, rec in tickers.items():
        if t in ests:
            rec["est"] = ests[t]
        rec["now"] = compare_at(rec["flow"], rec.get("est"), last_i)
    regions = {}
    for rg in etf_doc.get("regions") or []:
        if rg.get("est") or not rg.get("date") or (rg.get("coverage") or 0) < MIN_REGION_COVERAGE:
            continue
        # real AND estimate both = the sum over the same covered ETFs (trade-dated); a day where one of them has
        # not been published yet is unknown (null), never a partial sum
        cov = [t for t in (rg.get("covered") or []) if t in tickers]
        if cov:
            flow = sum_series([tickers[t]["flow"] for t in cov])
            est = sum_series([ests[t] for t in cov]) if all(t in ests for t in cov) else None
        else:
            flow, est = on_dates(shift(rg["date"], rg["usd"], cal), dates), None
        last, sums = tail_sums(flow)
        if last is None:
            continue
        regions[rg["id"]] = {"flow": flow, "est": est, "through": dates[last], **sums, "coverage": rg.get("coverage"),
                             "aum": rg.get("aum"), "covered": rg.get("covered"), "members": rg.get("members"),
                             "name": rg.get("name"), "now": compare_at(flow, est, last_i)}
    long = None
    if long_rows:
        ldays = [d for d in cal if d >= (cal[-LONG_DAYS] if len(cal) > LONG_DAYS else cal[0])]
        long = {"dates": ldays, "tickers": {t: on_dates(shift([d for d, _ in rows], [v for _, v in rows], cal), ldays)
                                            for t, rows in long_rows.items()}}
    through = max((v["through"] for v in tickers.values()), default=None)
    return envelope("aligned", source="web/data/flows/etf.json（发行商每日份额 × 净值），按 T+1 记账往前挪一个美股交易日，"
                                      "对齐到 web/data/meta.json 的日期",
                    asOf=through, items=[],
                    notes=["发行商 t 日公布的份额 = t−1 日成交的申赎（T+1 记账）：这里已经往前挪一天，对上地图的那一天",
                           "实测：真钱 |申赎| 跟前一天成交额放大的秩相关 0.21–0.29，跟当天只有 0.07–0.08",
                           "flow[] 里 null = 发行商还没公布那天（通常是最近 1–2 个交易日），别拿估算补",
                           "activeDays120 = 近 120 天里有申赎的天数占比。EFA/EEM 这类海外股票 ETF 申赎单位大、在一级市场很少动"
                           "（EFA 每次 60 万份的整数倍），0 就是真的 0：二级市场换手再大，钱也没进出基金",
                           f"regions 只收 coverage ≥ {MIN_REGION_COVERAGE} 的（有发行商每日数据的 ETF 占该区资产的比例）；"
                           "区域的真钱和估算都只算它覆盖的那几只 ETF，日子也一样（est[] = 同一批 ETF 按成交估的）",
                           "now = 最后一天的「真钱 vs 估」：real5/est5（同一批 ETF、同几天）、realMat/estMat（够不够大）、"
                           "blind（估算近一年 ≥ 90% 的 5 天都同一个方向，看不出方向）、clash（真的唱反调）"],
                    shift=1, dates=dates, tickers=tickers, regions=regions, long=long,
                    counts={"tickers": len(tickers), "regions": len(regions)})


# ----------------------------------------------------------------------------------------------- patching
def _sum_tail(vals: list, n: int) -> float:
    return r2(sum(v for v in vals[-n:] if isinstance(v, (int, float))), 1)


def patch_stock(doc: dict, aligned: dict) -> bool:
    """stocks/<T>.json: flow / cumFlow / facts.flow5 / facts.flow20 → real money where it exists.
    Field names (one meaning each):
      flowSource  'real' | 'est'      what `flow` is
      flowEst     true                only when `flow` is the §2 estimate (ticker without real money)
      flowPush[]  the §2 estimate (DV × push), kept beside the real series
      flowEstIdx  indices of `flow` that still carry the estimate (days the issuer has not published yet, and
                  days before the ETF's real history starts) — draw those dashed / 估
      realThrough last trade day with real money;  facts.flowN = last N REAL days (facts.flowNPush = estimate)
    Idempotent (re-running on a patched doc uses flowPush, never the real series, as the estimate)."""
    t = doc.get("t") or doc.get("ticker")
    rec = (aligned.get("tickers") or {}).get(t)
    if not rec or not doc.get("dates") or not isinstance(doc.get("flow"), list):
        if doc.get("flowSource") != "real":
            doc["flowSource"], doc["flowEst"] = "est", True
        return False
    est = doc.get("flowPush") if isinstance(doc.get("flowPush"), list) else list(doc["flow"])
    pos = {d: i for i, d in enumerate(aligned["dates"])}
    flow, est_idx, cum, run = [], [], [], 0.0
    for i, d in enumerate(doc["dates"]):
        j = pos.get(d)
        v = rec["flow"][j] if j is not None else None
        if v is None:
            v = est[i] if i < len(est) else 0.0
            est_idx.append(i)
        flow.append(r2(v, 1))
        run += v or 0.0
        cum.append(r2(run, 1))
    doc["flowPush"] = est
    doc.pop("flowEst", None)
    doc["flow"], doc["cumFlow"] = flow, cum
    doc["flowSource"] = "real"
    doc["flowEstIdx"] = est_idx
    doc["realThrough"] = rec["through"]
    doc["realSource"] = (rec.get("source") or "发行商每日份额") + "（T+1 记账已对齐到交易日）"
    f = doc.setdefault("facts", {})
    for n in (5, 20):
        if f"flow{n}Push" not in f and f"flow{n}" in f:
            f[f"flow{n}Push"] = f[f"flow{n}"]
        if f"flow{n}" in rec:
            f[f"flow{n}"] = rec[f"flow{n}"]
    f["flowThrough"], f["flowSource"] = rec["through"], "real"
    return True


def patch_map(doc: dict, aligned: dict, dates: list[str]) -> int:
    """maps/<id>.json: every stock child 's:T' with real money gets its `flow` series replaced (`flowSource:"real"`,
    the estimate kept as `flowPush[]`, still-estimated indices in `flowEstIdx`); every other series gets
    `flowEst: true`, and region children / self with a covered ETF region also `realFlow[]` + `realCoverage`
    (partial coverage — shown beside, never replacing, the estimate). → number of series patched with real money."""
    pos = {d: i for i, d in enumerate(aligned["dates"])}
    n = 0

    def real_series(rec):
        return [rec["flow"][pos[d]] if d in pos else None for d in dates]

    for cid, ser in list((doc.get("children") or {}).items()) + [("__self__", doc.get("self"))]:
        if not isinstance(ser, dict) or not isinstance(ser.get("flow"), list):
            continue
        key = cid[2:] if cid.startswith("s:") else None
        rec = (aligned.get("tickers") or {}).get(key) if key else None
        if rec:
            est = ser.get("flowPush") if isinstance(ser.get("flowPush"), list) else list(ser["flow"])
            rs = real_series(rec)
            ser["flowPush"] = est
            ser["flow"] = [r2(r if r is not None else (est[i] if i < len(est) else 0.0), 1) for i, r in enumerate(rs)]
            ser["flowEstIdx"] = [i for i, r in enumerate(rs) if r is None]
            ser["flowSource"] = "real"
            ser.pop("flowEst", None)
            n += 1
            continue
        rid = doc.get("id") if cid == "__self__" else cid
        rg = (aligned.get("regions") or {}).get(rid)
        if rg:
            ser["realFlow"] = real_series(rg)
            ser["realCoverage"] = rg.get("coverage")
            n += 1
        ser["flowEst"] = True
    return n


def patch_tree(tree: dict, aligned: dict) -> dict:
    """tree.json: stock nodes with real money → now.flow5 real (now.flow5Push keeps the estimate, now.flowSource
    'real', now.flowThrough); region nodes with a covered ETF region → node.real {flow5, flow20, coverage, through};
    every other now block with a flow5 → now.flowEst = true. → counts."""
    tk, rg = aligned.get("tickers") or {}, aligned.get("regions") or {}
    c = {"stocks": 0, "regions": 0, "est": 0}

    def walk(n):
        now = n.get("now") or {}
        t = n.get("ticker")
        if t and t in tk:
            rec = tk[t]
            if "flow5Push" not in now:
                now["flow5Push"] = now.get("flow5")
            now["flow5"], now["flowSource"], now["flowThrough"] = rec.get("flow5"), "real", rec["through"]
            now.pop("flowEst", None)
            c["stocks"] += 1
        elif "flow5" in now:
            now["flowEst"] = True
            c["est"] += 1
        if n.get("kind") != "stock" and n.get("id") in rg:
            r = rg[n["id"]]
            n["real"] = {"flow5": r.get("flow5"), "flow20": r.get("flow20"), "coverage": r.get("coverage"),
                         "through": r["through"], "label": "ETF 申赎", "est": False,
                         "source": "成员 ETF 发行商每日份额 × 净值（T+1 已对齐）"}
            c["regions"] += 1
        for ch in n.get("children") or []:
            walk(ch)

    walk(tree)
    return c


# ----------------------------------------------------------------------------------------------- additive patch
REAL_LABEL = "ETF 申赎"
REAL_SOURCE = "发行商每日份额 × 净值（T+1 记账已对齐到交易日）"


def _on(dates_src: list[str], vals: list | None, dates: list[str]) -> list | None:
    if vals is None:
        return None
    pos = {d: i for i, d in enumerate(dates_src)}
    return [vals[pos[d]] if d in pos else None for d in dates]


def add_stock(doc: dict, aligned: dict) -> bool:
    """stocks/<T>.json: realFlow[] (trade-dated, null = unknown) + realThrough + realSource beside the untouched
    estimate. A ticker without real money loses stale real fields."""
    t = doc.get("t") or doc.get("ticker")
    rec = (aligned.get("tickers") or {}).get(t)
    if not rec or not doc.get("dates"):
        for k in ("realFlow", "realThrough", "realSource", "realLabel"):
            doc.pop(k, None)
        return False
    doc["realFlow"] = _on(aligned["dates"], rec["flow"], doc["dates"])
    doc["realThrough"], doc["realSource"], doc["realLabel"] = rec["through"], (rec.get("source") or REAL_SOURCE), "申赎"
    return True


def add_map(doc: dict, aligned: dict, dates: list[str]) -> int:
    """maps/<id>.json: every series (children + self) with real money gets realFlow[] / realEst[] / realCoverage /
    realLabel; `flow` (the estimate) is never touched. → number of series with real money."""
    tk, rg = aligned.get("tickers") or {}, aligned.get("regions") or {}
    n = 0
    for cid, ser in list((doc.get("children") or {}).items()) + [("__self__", doc.get("self"))]:
        if not isinstance(ser, dict) or not isinstance(ser.get("flow"), list):
            continue
        for k in ("realFlow", "realEst", "realCoverage", "realLabel"):
            ser.pop(k, None)
        nid = doc.get("id") if cid == "__self__" else cid
        if nid and nid.startswith("s:") and nid[2:] in tk:
            rec = tk[nid[2:]]
            ser["realFlow"] = _on(aligned["dates"], rec["flow"], dates)
            ser["realEst"] = _on(aligned["dates"], rec.get("est"), dates)
            ser["realCoverage"], ser["realLabel"] = 1.0, "申赎"
            n += 1
        elif nid in rg:
            rec = rg[nid]
            ser["realFlow"] = _on(aligned["dates"], rec["flow"], dates)
            ser["realEst"] = _on(aligned["dates"], rec.get("est"), dates)
            ser["realCoverage"], ser["realLabel"] = rec.get("coverage"), REAL_LABEL
            n += 1
    return n


def add_tree(tree: dict, aligned: dict) -> dict:
    """tree.json: node.real = {flow5, est5, through, lag, coverage, label, clash, blind, realMat, estMat, est:false, source}
    for every node (region or stock) with real money, as of the map's last day. → counts."""
    tk, rg = aligned.get("tickers") or {}, aligned.get("regions") or {}
    dates = aligned.get("dates") or []
    c = {"stocks": 0, "regions": 0}

    def block(rec, cov, label):
        nw = rec.get("now")
        if not nw:
            return None
        return {"flow5": nw["real5"], "est5": nw.get("est5"), "through": dates[nw["through"]], "lag": nw["lag"],
                "coverage": cov, "label": label, "clash": nw["clash"], "blind": nw["blind"],
                "realMat": nw["realMat"], "estMat": nw["estMat"], "est": False, "source": REAL_SOURCE}

    def walk(n):
        n.pop("real", None)
        t = n.get("ticker")
        b = None
        if n.get("kind") == "stock" and t in tk:
            b = block(tk[t], 1.0, "申赎")
            c["stocks"] += bool(b)
        elif n.get("kind") != "stock" and n.get("id") in rg:
            b = block(rg[n["id"]], rg[n["id"]].get("coverage"), REAL_LABEL)
            c["regions"] += bool(b)
        if b:
            n["real"] = b
        for ch in n.get("children") or []:
            walk(ch)

    walk(tree)
    return c


def load_aligned() -> dict:
    """The aligned table as written by main() (for the pipeline: `from flows.realflow import load_aligned, patch_*`)."""
    return read_json(ALIGNED, {}) or {}


def apply_dir(data_dir: Path, aligned: dict, replace: bool = False) -> dict:
    """Patch a curated data dir in place (tree.json, stocks/*.json, maps/*.json). Atomic writes. Additive by default
    (add_*: real money beside the estimate); replace=True = the old patch_* (real money written into `flow`)."""
    data_dir = Path(data_dir)
    meta = read_json(data_dir / "meta.json", {}) or {}
    dates = meta.get("dates") or aligned["dates"]
    if not replace:
        rep = {"mode": "additive", "stocksReal": 0, "maps": 0, "series": 0, "tree": None}
        for t in (aligned.get("tickers") or {}):
            p = data_dir / "stocks" / f"{t}.json"
            d = read_json(p, None)
            if isinstance(d, dict) and add_stock(d, aligned):
                write_json(p, d)
                rep["stocksReal"] += 1
        for p in sorted((data_dir / "maps").glob("*.json")):
            d = read_json(p, None)
            if not isinstance(d, dict):
                continue
            had = any(isinstance(s, dict) and "realFlow" in s
                      for s in list((d.get("children") or {}).values()) + [d.get("self")])
            k = add_map(d, aligned, dates)
            if k or had:
                write_json(p, d)
                rep["maps"] += 1
                rep["series"] += k
        tp = data_dir / "tree.json"
        tree = read_json(tp, None)
        if isinstance(tree, dict):
            rep["tree"] = add_tree(tree, aligned)
            write_json(tp, tree)
        return rep
    rep = {"mode": "replace", "stocksReal": 0, "stocksEst": 0, "maps": 0, "tree": None}
    for p in sorted((data_dir / "stocks").glob("*.json")):
        d = read_json(p, None)
        if not isinstance(d, dict):
            continue
        rep["stocksReal" if patch_stock(d, aligned) else "stocksEst"] += 1
        write_json(p, d)
    for p in sorted((data_dir / "maps").glob("*.json")):
        d = read_json(p, None)
        if isinstance(d, dict) and patch_map(d, aligned, dates):
            write_json(p, d)
            rep["maps"] += 1
    tp = data_dir / "tree.json"
    tree = read_json(tp, None)
    if isinstance(tree, dict):
        rep["tree"] = patch_tree(tree, aligned)
        write_json(tp, tree)
    return rep


# ----------------------------------------------------------------------------------------------- main
def check(aligned: dict, data_dir: Path, tickers=("HYG", "TLT", "GLD", "FXI", "IBIT", "LQD", "EEM")):
    for t in tickers:
        rec = aligned["tickers"].get(t)
        s = read_json(data_dir / "stocks" / f"{t}.json", None)
        if not rec or not s:
            print(f"{t:6} (no real / no stock file)")
            continue
        pos = {d: i for i, d in enumerate(s["dates"])}
        ds = [d for d, v in zip(aligned["dates"], rec["flow"]) if v is not None][-5:]
        est = sum(s["flow"][pos[d]] for d in ds if d in pos)
        real = sum(rec["flow"][aligned["dates"].index(d)] for d in ds)
        print(f"{t:6} trade days {ds[0]}…{ds[-1]}  map est {est:+10.1f} M   real {real:+9.1f} M")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", default="", help="patch this curated data dir in place (tree, stocks, maps); additive")
    ap.add_argument("--replace", action="store_true", help="with --apply: write the real money INTO flow (old mode)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--no-long", action="store_true")
    a = ap.parse_args(argv)
    aligned = build(with_long=not a.no_long, data_dir=Path(a.apply) if a.apply else None)
    if a.check:
        check(aligned, ROOT / "web" / "data")
        return 0
    long = aligned.pop("long", None)
    if long:
        write_json(ALIGNED_LONG, long)
        aligned["long"] = {"path": str(ALIGNED_LONG.relative_to(ROOT)), "days": len(long["dates"]),
                           "from": long["dates"][0], "to": long["dates"][-1]}
    write_json(ALIGNED, aligned)
    log(f"realflow: {len(aligned['tickers'])} ETFs, {len(aligned['regions'])} regions aligned to the map "
        f"(through {aligned['asOf']}) → {ALIGNED.relative_to(ROOT)}")
    if a.apply:
        rep = apply_dir(Path(a.apply), aligned, replace=a.replace)
        log(f"realflow: applied to {a.apply}: {rep}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
