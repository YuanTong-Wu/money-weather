#!/usr/bin/env python3
"""test_clash.py — 反 (real money vs estimate disagree) on real cases + parity of the three implementations.

    python3 flows/test_clash.py                 # uses web/data (flows/aligned.json must have est[]: realflow.py)
    python3 flows/test_clash.py --data DIR

Checks (exit 1 on any failure):
  1. synthetic edge cases of compare_at: tiny opposite signs are not 反; stale real money → no comparison; a
     one-sided estimate is blind; a genuine material disagreement is 反.
  2. real cases on the data as of its last day (printed with numbers; the asserted ones are structural, so they hold
     on any day):
       · cash / cash-tbill / SGOV / BIL: the price-based estimate is blind (T-bill NAV accrues daily → "inflow"
         ≥ 90 % of the time) → never 反, whatever the real creations do;
       · crypto: real = IBIT + ETHA creations, compared with the estimate of IBIT + ETHA (not MSTR/COIN/miners, not
         stablecoins) — the old rule held it against the whole 加密 territory's estimate;
       · every 反 has both sides material and opposite signs, on the same ETFs and the same trade days.
  3. parity: flows/realflow.py compare_at == pipeline/brief.py compare_at == web/js/ui/realmoney.js compareAt on every
     aligned region / ticker × the last 60 days (node required for the JS side; skipped with a note if missing).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "pipeline"))
import realflow as RF  # noqa: E402

FAIL = []


def ok(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAIL.append(msg)


def synthetic():
    print("1. synthetic")
    n = 200
    base_r = [((-1) ** k) * 50.0 for k in range(n)]
    base_e = [((-1) ** (k // 3)) * 400.0 for k in range(n)]
    # tiny opposite signs: real +2 vs est −3 over the last 5 days → neither material
    r = base_r[:-5] + [0.4] * 5
    e = base_e[:-5] + [-0.6] * 5
    c = RF.compare_at(r, e, n - 1)
    ok(c is not None and not c["clash"], f"tiny opposite signs are not 反 (real5 {c['real5']}, est5 {c['est5']})")
    # genuine: real +600 vs est −2000 over the same 5 days, both well above their typical size
    r = base_r[:-5] + [120.0] * 5
    e = base_e[:-5] + [-400.0] * 5
    c = RF.compare_at(r, e, n - 1)
    ok(c is not None and c["clash"], f"material opposite signs are 反 (real5 {c['real5']}, est5 {c['est5']})")
    # stale: no real money for the last 7 days → no comparison
    r = base_r[:-7] + [None] * 7
    ok(RF.compare_at(r, base_e, n - 1) is None, "real money 7 trade days behind → no comparison")
    # one-sided estimate (T-bill like): always positive → blind → never 反
    e = [300.0 + (k % 7) * 10 for k in range(n)]
    r = base_r[:-5] + [-200.0] * 5
    c = RF.compare_at(r, e, n - 1)
    ok(c is not None and c["blind"] and not c["clash"], f"a one-sided estimate is blind (estPos {c['estPos']}), never 反")
    # the estimate is only compared on days that HAVE real money (a null real day is skipped, not padded)
    r = base_r[:-3] + [None] * 2 + [None]
    r[-6] = None
    c = RF.compare_at(r + [], base_e, n - 1)
    ok(c is None or c["lag"] >= 1, "null real days are skipped, never padded with the estimate")


def real_cases(al: dict):
    print(f"2. real cases (aligned through {al.get('asOf')})")
    R, T = al.get("regions") or {}, al.get("tickers") or {}
    last = len(al["dates"]) - 1

    def show(kind, k, c):
        if c:
            print(f"     {kind} {k:14} real5 {c['real5']:+10.1f}  est5(same ETFs/days) {c['est5'] if c['est5'] is not None else float('nan'):+10.1f}"
                  f"  realMat {c['realMat']!s:5} estMat {c['estMat']!s:5} blind {c['blind']!s:5} 反 {c['clash']}")
    for rid in ("cash", "cash-tbill"):
        if rid in R:
            for i in range(max(70, last - 59), last + 1):      # any day of the last 60: never 反
                c = RF.compare_at(R[rid]["flow"], R[rid].get("est"), i)
                if c and c["clash"]:
                    ok(False, f"{rid} 反 on {al['dates'][i]} although its estimate is blind")
                    break
            c = RF.compare_at(R[rid]["flow"], R[rid].get("est"), last)
            show("region", rid, c)
            ok(c is None or c["blind"], f"{rid}: the price-based estimate is blind to direction (estPos {c and c['estPos']})")
    for t in ("SGOV", "BIL"):
        if t in T:
            c = RF.compare_at(T[t]["flow"], T[t].get("est"), last)
            show("ticker", t, c)
            ok(c is None or not c["clash"], f"{t}: never 反")
    if "crypto" in R:
        cov = set(R["crypto"].get("covered") or [])
        ok(cov <= {"IBIT", "ETHA", "FBTC", "GBTC", "ARKB", "BITB", "ETHE"}, f"crypto real money = spot ETFs only ({sorted(cov)})")
        c = RF.compare_at(R["crypto"]["flow"], R["crypto"].get("est"), last)
        show("region", "crypto", c)
        if c:
            ok(c["est5"] is not None, "crypto is compared with the estimate of the same ETFs (not the whole territory)")
    n_clash = 0
    for kind, src in (("region", R), ("ticker", T)):
        for k, rec in src.items():
            for i in range(max(70, last - 19), last + 1):
                c = RF.compare_at(rec["flow"], rec.get("est"), i)
                if c and c["clash"]:
                    n_clash += 1
                    good = c["realMat"] and c["estMat"] and not c["blind"] and (c["real5"] > 0) != (c["est5"] > 0)
                    if not good:
                        ok(False, f"{kind} {k} {al['dates'][i]}: 反 without both sides material / opposite")
                    if i == last:
                        show(kind, k, c)
    ok(True, f"{n_clash} 反 region/ticker-days over the last 20 days, each with both sides material and opposite")


def parity(al: dict, data: Path):
    print("3. parity: realflow.py == brief.py == realmoney.js")
    import brief as BR  # pipeline/brief.py
    keys = ("real5", "est5", "through", "lag", "realMat", "estMat", "blind", "clash")
    last = len(al["dates"]) - 1
    cases = [(f"r:{k}", v["flow"], v.get("est")) for k, v in (al.get("regions") or {}).items()] + \
            [(f"t:{k}", v["flow"], v.get("est")) for k, v in (al.get("tickers") or {}).items()]
    py = {}
    bad = 0
    for name, real, est in cases:
        for i in range(max(70, last - 59), last + 1):
            a, b = RF.compare_at(real, est, i), BR.compare_at(real, est, i)
            if (a is None) != (b is None) or (a and any(
                    (round(a[k], 1) if isinstance(a[k], float) else a[k]) != (round(b[k], 1) if isinstance(b[k], float) else b[k])
                    for k in keys)):
                bad += 1
            py[f"{name}@{i}"] = None if a is None else {k: a[k] for k in keys}
    ok(bad == 0, f"realflow.py vs brief.py: {len(py)} comparisons, {bad} differ")
    node = shutil.which("node")
    if not node:
        print("  (node not found: JS parity skipped)")
        return
    js = ROOT / "web" / "js" / "ui" / "realmoney.js"
    prog = (f"const m = await import({json.dumps(js.as_uri())});"
            "const al = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));"
            "const out = {}; const last = al.dates.length - 1;"
            "for (const [kind, src] of [['r', al.regions || {}], ['t', al.tickers || {}]]) for (const [k, v] of Object.entries(src))"
            " for (let i = Math.max(70, last - 59); i <= last; i++) { const c = m.compareAt(v.flow, v.est || null, i);"
            " out[`${kind}:${k}@${i}`] = c && {real5: c.real5, est5: c.est5, through: c.through, lag: c.lag, realMat: c.realMat, estMat: c.estMat, blind: c.blind, clash: c.clash}; }"
            "console.log(JSON.stringify(out));")
    wrapper = "const require = (await import('node:module')).createRequire(import.meta.url);" + prog
    r = subprocess.run([node, "--input-type=module", "-e", wrapper, str(data / "flows" / "aligned.json")],
                       capture_output=True, text=True, timeout=120)
    if r.returncode:
        ok(False, f"node failed: {r.stderr[-300:]}")
        return
    jsd = json.loads(r.stdout.strip().splitlines()[-1])
    bad = 0
    for k, a in py.items():
        b = jsd.get(k)
        if (a is None) != (b is None):
            bad += 1
            continue
        if a is None:
            continue
        for f in keys:
            x, y = a[f], b[f]
            if isinstance(x, float) or isinstance(y, float):
                if x is None or y is None or abs(x - y) > 0.051 + 1e-6 * abs(x):   # realflow rounds to 0.1
                    bad += 1
                    break
            elif x != y:
                bad += 1
                break
    ok(bad == 0, f"realflow.py vs realmoney.js: {len(py)} comparisons, {bad} differ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "web" / "data"))
    a = ap.parse_args()
    data = Path(a.data)
    al = json.loads((data / "flows" / "aligned.json").read_text(encoding="utf-8"))
    if not any(isinstance(v.get("est"), list) for v in (al.get("regions") or {}).values()):
        print("aligned.json has no est[] yet — run python3 flows/realflow.py first")
        return 1
    synthetic()
    real_cases(al)
    parity(al, data)
    print(f"\n{'ALL OK' if not FAIL else f'{len(FAIL)} FAILED'}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
