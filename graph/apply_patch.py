#!/usr/bin/env python3
"""graph/apply_patch.py — put ONE finished scout 'gap' result into the company web right now (DESIGN §15, phase-3 must-fix 2b).

The scout (scout/run.py) writes its gap results to scout/out/graph_patches.json. graph/build.py merges every patch
on each build (update.sh step 7); this script is what the server / UI calls the moment one job is done, so the
answer shows up on the 关系网 without waiting for tonight's update:

    python3 graph/apply_patch.py --task ga-1028-003622-xrps     # the job that just finished
    python3 graph/apply_patch.py --key "MSFT>NVDA:buys-from"     # the same, by patch key
    python3 graph/apply_patch.py --file my_patch.json            # a patch (or a list) that the scout did not write
    echo '{…patch…}' | python3 graph/apply_patch.py --stdin      #   → kept in graph/patches_extra.json, merged on every build
    python3 graph/apply_patch.py --task … --dry-run              # how the names resolve and what would happen; writes nothing
    python3 graph/apply_patch.py --all                           # just rebuild with every patch (fast: price ties reused)
    python3 graph/apply_patch.py --resolve "S:GOOGLE" "GINKGO BIOWORKS (DNA)"   # only: which graph id is this name?

stdout is ONE line of JSON (logs go to stderr):
    {"ok": true, "ms": 900, "reload": ["graph"], "ids": ["DNA", "GOOGL"],
     "applied": [{"key", "taskId", "action": "applied|added|separate|corroborated|corroborated_real|kept_real|kept_estimate|unresolved",
                  "from", "to", "usdB", "per", "edge", "how": {...}, "now": {edge as it is in web/data/graph after the build}}],
     "say": "侦察兵的数已经放进关系网：DNA→GOOGL 每年约 0.02 十亿美元"}
    {"ok": false, "error": "…"}            (exit code 1)
After ok:true the page should call app.reloadData(['graph']).

A patch is shaped like scout/run.py writes it: {key, a, b, type, money:{from, to, usdB, usdBLow, usdBHigh, per, what},
share, asOf, est, basis, say, conf, sources, taskId, at}. Names may be messy ("GINKGO BIOWORKS (DNA)", "S:DNA",
"GOOGLE", "TWIST BIOSCIENCE"): they resolve to tickers / p:slugs exactly as the build does (build.Resolver).
The rebuild is the normal build (same rules, same lock) with the price-based ties reused from the last build,
so it takes about a second and can never disagree with tonight's full build.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _build_mod():
    spec = importlib.util.spec_from_file_location("graph_build", HERE / "build.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["graph_build"] = mod
    spec.loader.exec_module(mod)
    return mod


B = _build_mod()


def _read_list(p: Path) -> list:
    raw = B.read_json(p, []) or []
    if isinstance(raw, dict):
        raw = raw.get("patches") or []
    return [x for x in raw if isinstance(x, dict)]


def find(task: str | None = None, key: str | None = None) -> list[dict]:
    out = []
    for p in _read_list(B.SCOUT_PATCHES) + _read_list(B.EXTRA_PATCHES):
        if (task and p.get("taskId") == task) or (key and p.get("key") == key):
            out.append(p)
    return out


def store_extra(patches: list[dict]) -> list[dict]:
    """Patches handed in by hand / by another module → graph/patches_extra.json (upsert by key)."""
    import fcntl
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    fixed = []
    for p in patches:
        if not isinstance(p, dict) or not isinstance(p.get("money"), dict):
            raise ValueError("补丁要有 money 对象（from / to / usdB）")
        p = dict(p)
        m = p["money"]
        p.setdefault("a", m.get("from"))
        p.setdefault("b", m.get("to"))
        p.setdefault("type", "buys-from")
        p.setdefault("key", f"{p['a']}>{p['b']}:{p['type']}")
        p.setdefault("at", now)
        p.setdefault("source", "manual")
        fixed.append(p)
    lockf = B.EXTRA_PATCHES.with_name(B.EXTRA_PATCHES.name + ".lock")
    with open(lockf, "a+") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        cur = _read_list(B.EXTRA_PATCHES)
        keys = {p["key"] for p in fixed}
        cur = [x for x in cur if x.get("key") not in keys] + fixed
        B.write_json(B.EXTRA_PATCHES, cur[-2000:])
        fcntl.flock(lf, fcntl.LOCK_UN)
    return fixed


def _edge_now(docs: dict, rec: dict) -> dict | None:
    eid = rec.get("edge")
    for i in (rec.get("from"), rec.get("to")):
        d = docs.get(i) if docs else None
        if not d:
            continue
        cands = [e for e in d.get("edges") or [] if e.get("id") == eid or str(e.get("id", "")).split("#")[0] == eid]
        if cands:
            # the one carrying this patch's scout taskId, else the first
            hit = next((e for e in cands if (e.get("scout") or {}).get("taskId") == rec.get("taskId")), cands[0])
            keep = ("id", "a", "b", "type", "money", "est", "conf", "basis", "say", "scout", "alt", "sanity", "source")
            return {k: hit[k] for k in keep if k in hit}
    return None


def _rel(p: Path) -> str:
    try:
        return str(p.relative_to(B.ROOT))
    except ValueError:
        return str(p)


def _say(recs: list[dict]) -> str:
    bits = []
    for r in recs:
        a = r.get("action")
        if a == "unresolved":
            bits.append(f"有一条认不出两头（{r.get('why')}）")
            continue
        u = r.get("usdB")
        per = r.get("per")
        amt = f"{r.get('from')}→{r.get('to')} {('每年约 ' if per == 'year' else '约 ') if u is not None else ''}" \
              f"{B.yi(u) if u is not None else ''}{B.PER_ZH.get(per, '') if per not in ('year', None) else ''}"
        bits.append({"applied": f"已换成侦察兵的数：{amt}", "added": f"新连了一条线：{amt}",
                     "separate": f"另记了一笔不同节奏的钱：{amt}", "corroborated": f"侦察兵核对过，原来的估算站得住（{amt}）",
                     "corroborated_real": f"侦察兵查到的和公开数字一致（{amt}）",
                     "kept_real": f"公开数字没动，侦察兵的数记作参考（{amt}）",
                     "kept_estimate": f"原来的估算更有把握，侦察兵的数记作参考（{amt}）"}.get(a, f"{a}: {amt}"))
    return "；".join(bits)


def apply(task: str | None = None, key: str | None = None, patches: list[dict] | None = None,
          dry_run: bool = False, rebuild_all: bool = False) -> dict:
    t0 = time.time()
    try:
        if patches:
            if dry_run:
                targets = patches
            else:
                targets = store_extra(patches)
        elif task or key:
            targets = find(task, key)
            if not targets:
                return {"ok": False, "error": f"graph_patches.json 里没有{'任务 ' + task if task else '补丁 ' + str(key)}的关系网补丁"
                                              "（这个任务可能只查到了别的值，或者还没写完）"}
        elif rebuild_all:
            targets = []
        else:
            return {"ok": False, "error": "要给 --task / --key / --file / --stdin / --all 之一"}
        keys = {p.get("key") for p in targets}
        argv = ["--reuse-measured"] if (B.OUT / "edges.json").exists() else []
        with contextlib.redirect_stdout(sys.stderr):
            if dry_run:
                docs = _dry(targets)
            else:
                docs = B.run(argv)
        recs = [r for r in (B.LAST.get("outcomes") or []) if r.get("key") in keys]
        if not dry_run:
            for r in recs:
                r["now"] = _edge_now(docs, r)
        ids = sorted({i for r in recs for i in (r.get("from"), r.get("to")) if i})
        return {"ok": True, "ms": int((time.time() - t0) * 1000), "dryRun": dry_run,
                "reload": [] if dry_run else ["graph"], "ids": ids, "applied": recs, "say": _say(recs),
                "files": [] if dry_run else [_rel(B.OUT / f) for f in ["edges.json", "index.json"] + [B.fname(i) for i in ids]]}
    except SystemExit as e:              # lock timeout / unreadable raw batch
        return {"ok": False, "error": str(e).strip()}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _dry(targets: list[dict]) -> dict:
    """Run the build's merge on a throw-away output and patch file: same resolution, nothing written to the app."""
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="mw-graph-dry-"))
    extra = tmp / "extra.json"
    extra.write_text(json.dumps(_read_list(B.EXTRA_PATCHES) + [t for t in targets if t not in _read_list(B.EXTRA_PATCHES)],
                                ensure_ascii=False), encoding="utf-8")
    old = (B.OUT, B.EXTRA_PATCHES, B.PATCH_LOG, B.SANITY_REPORT)
    B.OUT, B.EXTRA_PATCHES, B.PATCH_LOG, B.SANITY_REPORT = tmp / "out", extra, tmp / "log.json", tmp / "sanity.json"
    try:
        args = B.parser().parse_args(["--no-measured"])
        args.dry_run = True
        return B.build(args)
    finally:
        B.OUT, B.EXTRA_PATCHES, B.PATCH_LOG, B.SANITY_REPORT = old
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def resolve_names(texts: list[str]) -> dict:
    """Messy names → graph ids, exactly as the build resolves scout text (for the server / scout before queuing)."""
    import contextlib as _c
    with _c.redirect_stdout(sys.stderr):
        B.U = B.Universe()
        idx = B.read_json(B.OUT / "edges.json", {}) or {}
        names: dict = {}
        for i, n in (idx.get("nodes") or {}).items():
            if n.get("name"):
                names.setdefault(i, set()).add(n["name"])
        r = B.make_resolver(names, set(idx.get("nodes") or {}))
    out = {}
    for t in texts:
        i, how = r.place(t)
        out[t] = {"id": i, "how": how, "inGraph": bool(i and i in (idx.get("nodes") or {}))}
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="apply one scout gap result to web/data/graph now")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--task", help="scout task id (the patch's taskId)")
    g.add_argument("--key", help="patch key, e.g. 'MSFT>NVDA:buys-from'")
    g.add_argument("--file", help="a JSON file with one patch or a list")
    g.add_argument("--stdin", action="store_true", help="read one patch or a list from stdin")
    g.add_argument("--all", action="store_true", help="rebuild with every stored patch")
    g.add_argument("--resolve", nargs="+", metavar="NAME", help="only print which graph id each name resolves to")
    ap.add_argument("--dry-run", action="store_true", help="resolve and report only; write nothing")
    args = ap.parse_args(argv)
    if args.resolve:
        print(json.dumps({"ok": True, "resolved": resolve_names(args.resolve)}, ensure_ascii=False))
        return 0
    patches = None
    try:
        if args.file:
            patches = json.loads(Path(args.file).read_text(encoding="utf-8"))
        elif args.stdin:
            patches = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"读不了补丁：{e}"}, ensure_ascii=False))
        return 1
    if isinstance(patches, dict):
        patches = patches.get("patches") if isinstance(patches.get("patches"), list) else [patches]
    res = apply(task=args.task, key=args.key, patches=patches, dry_run=args.dry_run, rebuild_all=args.all)
    print(json.dumps(res, ensure_ascii=False, default=str))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
