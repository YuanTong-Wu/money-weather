#!/usr/bin/env python3
"""Build Money Weather's wholly synthetic, offline, reproducible demo.

    python3 scripts/create_demo.py             # 64 fictional weekday observations
    python3 scripts/create_demo.py --days 32   # shorter demo, same fictional world
    python3 scripts/create_demo.py --check     # verify existing 64-day output

Only Python's standard library is used. No project modules, fixtures, market
files, credentials, subprocesses, sockets, or AI services are loaded. All writes
are confined to this checkout's web/demo/. Output bytes depend only on --days
and this source, never on the clock, environment, working directory or secrets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from datetime import date, timedelta


REPO = Path(__file__).resolve().parents[1]
OUTPUT = REPO / "web" / "demo"
LABEL = "【合成演示】"
NOTICE = (
    LABEL + "全部地区、公司、价格、成交量和资金天气均为从零编写的数学样本。"
    "不是行情，不对应真实证券、用户持仓或真实资金；不代表预测或投资收益。"
)
SERIES_KEYS = ("wind", "temp", "pres", "storm", "front", "idx", "flow", "dv")
WEATHER_KEYS = ("wind", "temp", "pres", "storm", "front")
STOCK_ARRAYS = ("o", "h", "l", "c", "v", "flow", "cumFlow") + WEATHER_KEYS
REGIONS = (
    ("demo-dawn", "晨光群岛", "demo-compute", (("FICTA", "纸盒算力"), ("FICTB", "云朵工坊"))),
    ("demo-tide", "暮潮平原", "demo-energy", (("FICTC", "风轮电池"), ("FICTD", "潮汐灯塔"))),
    ("demo-sand", "星沙海岸", "demo-materials", (("FICTE", "星砂材料"), ("FICTF", "月光陶瓷"))),
)
TICKERS = tuple(t for _, _, _, stocks in REGIONS for t, _ in stocks)


def marked(name: str) -> str:
    return LABEL + name


def fake_dates(days: int) -> list[str]:
    """Weekdays for animation, NOT a real exchange's holiday calendar."""
    result: list[str] = []
    day = date(2000, 1, 3)
    while len(result) < days:
        if day.weekday() < 5:
            result.append(day.isoformat())
        day += timedelta(days=1)
    return result


def r(value: float, places: int = 6) -> float:
    value = round(value, places)
    return 0.0 if value == 0 else value


def fronts(wind: list[float]) -> list[int]:
    """Decorative transitions, not an inference from actual trading."""
    out = [0]
    for previous, current in zip(wind, wind[1:]):
        out.append(1 if previous <= 0.5 < current else -1 if previous >= -0.5 > current else 0)
    return out


def synthetic_stock(dates: list[str], number: int, ticker: str) -> dict:
    """Generate independent, bounded candle/volume/weather arrays from formulas."""
    phase = number * 1.07
    first = 24.0 + number * 9.0
    close = [first]
    for i in range(1, len(dates)):
        move = 0.014 * math.sin(i * 0.31 + phase) + 0.004 * math.cos(i * 0.67 - phase)
        close.append(r(close[-1] * (1.0 + move), 4))
    opening, high, low, volume = [], [], [], []
    for i, c in enumerate(close):
        previous = close[max(0, i - 1)]
        o = r(previous * (1.0 + 0.003 * math.sin(i * 0.83 + phase)), 4)
        opening.append(o)
        high.append(r(max(o, c) * (1.009 + 0.003 * abs(math.sin(i + phase))), 4))
        low.append(r(min(o, c) * (0.991 - 0.003 * abs(math.cos(i + phase))), 4))
        volume.append(80000 + number * 17000 + ((i * 7919 + number * 1543) % 110000))
    wind = [r(1.75 * math.sin(i * 0.24 + phase) + 0.20 * math.cos(i * 0.61)) for i in range(len(dates))]
    temp = [r(1.65 * math.sin(i * 0.31 + phase) + 0.3 * math.cos(i * 0.17)) for i in range(len(dates))]
    pres = [round(50 + 36 * math.sin(i * 0.13 + phase + 0.5)) for i in range(len(dates))]
    storm = [r(0.12 + 1.65 * max(0.0, math.sin(i * 0.19 + phase)) ** 8) for i in range(len(dates))]
    dv = [r(c * v / 1e6) for c, v in zip(close, volume)]
    flow = [r(d * 0.12 * math.tanh(w)) for d, w in zip(dv, wind)]
    cumulative, total = [], 0.0
    for f in flow:
        total = r(total + f)
        cumulative.append(total)
    series = {
        "wind": wind, "temp": temp, "pres": pres, "storm": storm, "front": fronts(wind),
        "idx": [r(c / first * 100) for c in close], "flow": flow, "dv": dv,
    }
    return {
        "t": ticker, "o": opening, "h": high, "l": low, "c": close, "v": volume,
        "cumFlow": cumulative, "series": series,
    }


def rollup(children: list[dict]) -> dict:
    days = len(children[0]["wind"])
    result = {}
    for key in SERIES_KEYS:
        if key == "front":
            continue
        result[key] = [
            r(sum(child[key][i] for child in children) / (1 if key in ("flow", "dv") else len(children)))
            for i in range(days)
        ]
    result["pres"] = [round(x) for x in result["pres"]]
    result["front"] = fronts(result["wind"])
    return {key: result[key] for key in SERIES_KEYS}


def current(series: dict) -> dict:
    idx = series["idx"]
    result = {key: series[key][-1] for key in WEATHER_KEYS}
    for period in (1, 5, 20):
        result[f"ret{period}"] = r(idx[-1] / idx[-1 - period] - 1) if len(idx) > period else None
    result.update(flow5=r(sum(series["flow"][-5:])), dv20=r(sum(series["dv"][-20:]) / len(series["dv"][-20:])))
    return result


def demo_series(series: dict, name: str) -> dict:
    return {"sample": True, "name": name, "desc": NOTICE, **series}


def profile(stock: dict) -> dict:
    """Fictional volume distribution, never described as observed transactions."""
    lo, hi = min(stock["l"]), max(stock["h"])
    bins = [r(lo + (hi - lo) * (i + 0.5) / 24, 4) for i in range(24)]
    return {
        "sample": True, "est": True, "basis": NOTICE,
        "lo": lo, "hi": hi, "bins": bins,
        "buy": [r(0.3 + 2.0 / (1 + ((i - 8) / 5) ** 2)) for i in range(24)],
        "sell": [r(0.3 + 1.7 / (1 + ((i - 15) / 6) ** 2)) for i in range(24)],
    }


def build_documents(days: int = 64) -> dict[str, object]:
    """Pure builder: no reads, writes, network, project imports or model calls."""
    if days not in (32, 64):
        raise ValueError("--days must be 32 or 64")
    dates = fake_dates(days)
    documents: dict[str, object] = {}
    series_by_id: dict[str, dict] = {}
    nodes: dict[str, dict] = {}
    search = []
    world = {
        "id": "world", "name": marked("虚构世界"), "desc": NOTICE, "sample": True,
        "kind": "region", "depth": 0, "emoji": "", "tags": [], "children": [],
        "nStocks": len(TICKERS),
    }
    nodes["world"] = world
    for region_number, (region_id, region_name, tag, members) in enumerate(REGIONS):
        region = {
            "id": region_id, "name": marked(region_name), "desc": NOTICE, "sample": True,
            "kind": "region", "depth": 1, "emoji": "", "tags": [tag],
            "children": [], "nStocks": len(members),
        }
        world["children"].append(region)
        nodes[region_id] = region
        for offset, (ticker, name) in enumerate(members):
            number = region_number * len(members) + offset
            stock = synthetic_stock(dates, number, ticker)
            node_id = "s:" + ticker
            series_by_id[node_id] = stock["series"]
            leaf = {
                "id": node_id, "ticker": ticker, "name": marked(name), "desc": NOTICE,
                "note": NOTICE, "sample": True, "kind": "stock", "depth": 2,
                "tags": [tag], "nStocks": 1, "now": current(stock["series"]),
            }
            nodes[node_id] = leaf
            region["children"].append(leaf)
            close, series = stock["c"], stock["series"]
            facts = {
                "sample": True, "last": close[-1], "dv20": leaf["now"]["dv20"],
                "flow5": leaf["now"]["flow5"], "flow20": r(sum(series["flow"][-20:])),
                "flow5Avg": r(sum(abs(sum(series["flow"][i-4:i+1])) for i in range(4, days)) / (days - 4)),
                **{f"ret{n}": r(close[-1] / close[-1-n] - 1) if days > n else None for n in (1, 5, 20, 60)},
                # 32/64 fabricated rows are not a 52-week observation window.
                "high52": None, "low52": None,
            }
            documents[f"stocks/{ticker}.json"] = {
                "sample": True, "synthetic": True, "source": NOTICE,
                "t": ticker, "name": leaf["name"], "note": NOTICE, "desc": NOTICE,
                "paths": [["world", region_id, node_id]], "dates": dates,
                **{key: stock[key] for key in ("o", "h", "l", "c", "v", "cumFlow")},
                **{key: series[key] for key in ("flow",) + WEATHER_KEYS},
                "profile": profile(stock), "facts": facts,
                "peers": ["s:" + t for t, _ in members if t != ticker],
                "est": {"fields": list(WEATHER_KEYS) + ["flow", "profile"], "basis": NOTICE},
            }
        series_by_id[region_id] = rollup([series_by_id[child["id"]] for child in region["children"]])
        region["now"] = current(series_by_id[region_id])
    series_by_id["world"] = rollup([series_by_id[node["id"]] for node in world["children"]])
    world["now"] = current(series_by_id["world"])

    def visit(node: dict, ids: list[str], names: list[str]) -> None:
        ids, names = ids + [node["id"]], names + [node["name"]]
        search.append({
            "id": node["id"], "name": node["name"], "desc": NOTICE, "note": NOTICE,
            "sample": True, "kind": node["kind"], "path": names, "pathIds": ids,
            **({"ticker": node["ticker"]} if "ticker" in node else {}),
        })
        if node["kind"] != "stock":
            documents[f"maps/{node['id']}.json"] = {
                "id": node["id"], "name": node["name"], "desc": NOTICE, "sample": True,
                "dates": dates, "self": demo_series(series_by_id[node["id"]], node["name"]),
                "children": {child["id"]: demo_series(series_by_id[child["id"]], child["name"]) for child in node["children"]},
            }
        for child in node.get("children", []):
            visit(child, ids, names)

    visit(world, [], [])
    regions = world["children"]
    leaves = [leaf for region in regions for leaf in region["children"]]

    def row(node: dict) -> dict:
        entry = next(entry for entry in search if entry["id"] == node["id"])
        return {
            "id": node["id"], "name": node["name"], "desc": NOTICE, "sample": True,
            "path": " › ".join(entry["path"]), "pathIds": entry["pathIds"],
            "say": marked("预设数学曲线，仅展示界面读数与交互。"),
            **node["now"], **({"ticker": node["ticker"]} if "ticker" in node else {}),
        }

    documents["meta.json"] = {
        "sample": True, "synthetic": True, "mode": "synthetic-demo",
        "name": marked("钱的天气离线演示"), "desc": NOTICE, "headline": NOTICE,
        "asOf": dates[-1], "generatedAt": dates[-1] + "T00:00:00Z", "dates": dates,
        "dateBasis": marked("固定起点的假想工作日，不对应任何交易所的交易日、假日或采集时间。"),
        "tags": {"demo-compute": marked("虚构算力"), "demo-energy": marked("虚构能源"), "demo-materials": marked("虚构材料")},
        "atmosphere": [], "holdings": [], "estimates": list(nodes),
        "partial": None, "filled": [], "intraday": None, "nStocks": len(leaves),
        "nRegions": 1 + len(regions), "claudeCalls": 0, "externalRequests": 0,
    }
    documents["tree.json"] = world
    documents["search.json"] = search
    documents["brief.json"] = {
        "sample": True, "synthetic": True, "name": marked("界面演示导览"),
        "desc": NOTICE, "headline": NOTICE, "asOf": dates[-1],
        "big": [row(node) for node in regions],
        "inflow": [row(node) for node in regions if node["now"]["flow5"] > 0],
        "outflow": [row(node) for node in regions if node["now"]["flow5"] < 0],
        "fronts": [{**row(node), "dir": node["now"]["front"]} for node in regions if node["now"]["front"]],
        "crowded": [row(node) for node in regions if node["now"]["pres"] >= 65],
        "quiet": [row(node) for node in regions if node["now"]["pres"] < 35],
        "storms": [row(node) for node in regions if node["now"]["storm"] >= 0.8],
        "stocksIn": [row(node) for node in leaves if node["now"]["flow5"] > 0],
        "stocksOut": [row(node) for node in leaves if node["now"]["flow5"] < 0],
        "spotlight": [{**row(node), "why": marked("点击查看下一层，所有读数均为虚构。"), "score": 1.0} for node in regions],
        "tour": [{**row(node), "caption": marked("演示地图缩放与预设曲线；不是市场分析或预测。"), "kind": "inflow" if node["now"]["flow5"] > 0 else "outflow"} for node in regions],
    }
    documents["holdings.json"] = {"sample": True, "name": marked("没有真实持仓"), "desc": NOTICE, "holdings": []}
    documents["demo-info.json"] = {
        "sample": True, "name": marked("演示数据契约与限制"), "desc": NOTICE,
        "days": days, "tickers": list(TICKERS), "generatedBy": "scripts/create_demo.py",
        "networkRequestsByGenerator": 0, "modelCallsByGenerator": 0,
        "sourceDataFilesReadByGenerator": [],
        "urls": ["/?data=demo#/world", "/?data=demo#/world/demo-dawn", "/?data=demo#/stock/FICTA"],
        "serve": "From web/: python3 -m http.server 8000 --bind 127.0.0.1 (static only; no server.py/update.sh).",
        "limitations": [
            marked("不会生成真实资金、新闻、AI 回答、模型推演、预测命中率或回测成功记录。"),
            marked("浏览器的 2D/3D 共用地图契约；3D 渲染能力由浏览器决定，生成器不启动 UI。"),
            marked("现有前端有独立于 ?data= 的 /api/*、data/flows/* 与地理资源请求；本脚本不会改写或代理这些入口。"),
            marked("仅用静态服务器浏览本演示；若要求浏览器零 API 请求，需由父任务另行禁用按钮和轮询。"),
            marked("使用抽象地图模式；未提供真实总部、国家边界或地理数据。"),
        ],
        "schemas": {
            "meta.json": "object: sample, name, desc, asOf, generatedAt, dates[], tags{}, atmosphere[], nStocks, nRegions",
            "tree.json": "node: sample, id, name, desc, kind, depth, tags[], nStocks, now{}, children[] (non-stock nodes)",
            "search.json": "array of {sample, id, name, desc, kind, ticker?, path:[names], pathIds:[ids]}",
            "brief.json": "object: sample, asOf, headline, big[], inflow[], outflow[], fronts[], crowded[], quiet[], storms[], stocksIn[], stocksOut[], spotlight[], tour[]",
            "maps/<id>.json": "object: sample, id, name, desc, dates[], self:series, children:{childId:series}",
            "series": "sample, name, desc, wind[], temp[], pres[], storm[], front[], idx[], flow[], dv[]; every series has days rows",
            "stocks/<ticker>.json": "object: sample, t, name, note, paths:[[ids]], dates[], o[], h[], l[], c[], v[], flow[], cumFlow[], wind[], temp[], pres[], storm[], front[], profile{}, peers:[s:T], facts{}, est{}",
            "profile": "sample, est, basis, lo, hi, bins[], buy[], sell[] (24 fictional bins)",
            "facts": "sample, last, dv20, flow5, flow20, flow5Avg, ret1, ret5, ret20, ret60, high52:null, low52:null",
        },
    }
    documents["README.md"] = (
        "# " + marked("Money Weather") + "\n\n" + NOTICE + "\n\n"
        "生成：`python3 scripts/create_demo.py`；32 日版加 `--days 32`。"
        "相同参数产生完全相同的文件字节，`--check` 核对磁盘文件。\n\n"
        "从项目的 `web/` 目录用 Python 静态服务器打开，访问 "
        "`http://127.0.0.1:8000/?data=demo#/world`。地区：`#/world/demo-dawn`；"
        "个股：`#/stock/FICTA`。地图选择“抽象”，2D/3D 使用同一组时间序列。\n\n"
        "本脚本不运行服务器、行情更新、Claude 或其他 AI。不要用 `server.py` 或 "
        "`update.sh` 启动此纯静态演示。前端现有独立 API/地理资源入口并非由本生成器禁用；"
        "严格浏览器零 API 模式须由父任务处理。\n\n"
        "所有文件形状见 `demo-info.json`；每份文件的 SHA-256 见 `manifest.json`。"
        "未生成新闻、AI 回答、预测命中率、真实资金或回测证明。\n"
    )
    validate_documents(documents, days)
    return documents


def validate_documents(documents: dict[str, object], days: int) -> None:
    """Check the cross-file contracts used by map navigation/time travel/stock view."""
    dates = documents["meta.json"]["dates"]
    assert len(dates) == days and dates == sorted(set(dates))
    assert all(date.fromisoformat(day).weekday() < 5 for day in dates)
    assert documents["brief.json"]["asOf"] == dates[-1]
    index = {}

    def walk(node: dict, path: list[str]) -> None:
        assert node["sample"] is True and node["name"].startswith(LABEL)
        assert node["desc"].startswith(LABEL) and node["id"] not in index
        index[node["id"]] = path + [node["id"]]
        if node["kind"] == "stock":
            assert node["ticker"] in TICKERS
            return
        payload = documents[f"maps/{node['id']}.json"]
        assert payload["sample"] and payload["dates"] == dates
        assert set(payload["children"]) == {n["id"] for n in node["children"]}
        for series in [payload["self"], *payload["children"].values()]:
            assert series["sample"] and series["name"].startswith(LABEL)
            assert all(len(series[key]) == days for key in SERIES_KEYS)
            assert all(math.isfinite(x) for key in SERIES_KEYS for x in series[key])
            assert all(0 <= x <= 100 for x in series["pres"])
            assert set(series["front"]) <= {-1, 0, 1}
            assert all(x > 0 for x in series["idx"] + series["dv"])
        for child in node["children"]:
            walk(child, index[node["id"]])

    walk(documents["tree.json"], [])
    assert len(index) == 10 and len(documents["search.json"]) == len(index)
    for row in documents["search.json"]:
        assert row["sample"] and row["name"].startswith(LABEL)
        assert row["pathIds"] == index[row["id"]]
    for ticker in TICKERS:
        stock = documents[f"stocks/{ticker}.json"]
        assert stock["sample"] and stock["t"] == ticker and stock["dates"] == dates
        assert stock["paths"] == [index["s:" + ticker]]
        assert all(len(stock[key]) == days for key in STOCK_ARRAYS)
        assert all(math.isfinite(x) for key in STOCK_ARRAYS for x in stock[key])
        for o, h, l, c, v in zip(*(stock[key] for key in ("o", "h", "l", "c", "v"))):
            assert 0 < l <= min(o, c) <= max(o, c) <= h and v > 0
        assert all(peer in index and peer != "s:" + ticker for peer in stock["peers"])
        parent = stock["paths"][0][-2]
        child = documents[f"maps/{parent}.json"]["children"]["s:" + ticker]
        assert all(child[key] == stock[key] for key in ("flow",) + WEATHER_KEYS)
        assert all(abs(a - b) < 1e-5 for a, b in zip(child["dv"], [c * v / 1e6 for c, v in zip(stock["c"], stock["v"])]))
        total = 0.0
        for flow, cumulative in zip(stock["flow"], stock["cumFlow"]):
            total = r(total + flow)
            assert total == cumulative
        assert all(len(stock["profile"][key]) == 24 for key in ("bins", "buy", "sell"))
        assert stock["facts"]["high52"] is None and stock["facts"]["low52"] is None
        assert stock["facts"]["ret60"] is None if days == 32 else stock["facts"]["ret60"] is not None


def encode_documents(documents: dict[str, object], days: int) -> dict[str, bytes]:
    def encode(value: object) -> bytes:
        return (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")

    files = {name: encode(value) for name, value in documents.items()}
    manifest = {
        "sample": True, "name": marked("可重复生成清单"), "desc": NOTICE,
        "generator": "scripts/create_demo.py", "days": days,
        "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in sorted(files.items())},
        "note": marked("清单不对自身取摘要；不含时间戳、绝对路径或外部数据。"),
    }
    files["manifest.json"] = encode(manifest)
    return dict(sorted(files.items()))


def safe_target(relative: str) -> Path:
    """Refuse symlinks/path traversal rather than write outside this demo folder."""
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Output path must be under web/demo/")
    target = OUTPUT / path
    current = target
    while current != REPO:
        if current.is_symlink():
            raise ValueError(f"Refusing symlink in demo output: {current}")
        current = current.parent
    target.resolve().relative_to(OUTPUT.resolve())
    return target


def write_or_check(files: dict[str, bytes], check: bool) -> list[str]:
    targets = {name: safe_target(name) for name in files}
    mismatches = []
    for name, target in targets.items():
        if check:
            if not target.is_file() or target.read_bytes() != files[name]:
                mismatches.append(name)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix="." + target.name + ".", suffix=".tmp", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(files[name])
            os.replace(temporary, target)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
    return mismatches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, choices=(32, 64), default=64, help="fictional weekday rows (default: 64)")
    parser.add_argument("--check", action="store_true", help="read-only byte comparison with deterministic output")
    args = parser.parse_args()
    files = encode_documents(build_documents(args.days), args.days)
    mismatches = write_or_check(files, args.check)
    if mismatches:
        print(marked("文件缺失或不匹配：") + ", ".join(mismatches))
        return 1
    digest = hashlib.sha256(b"".join(name.encode("utf-8") + b"\0" + data for name, data in files.items())).hexdigest()
    verb = "核对通过" if args.check else "已生成"
    print(f"{LABEL}{verb}：{args.days} 日，3 个虚构地区，6 家虚构公司，{len(files)} 个文件。")
    print(f"{LABEL}固定内容摘要：{digest}")
    print(f"{LABEL}生成器外部请求 0；模型调用 0；未读取行情、持仓、fixture 或用户配置。")
    print("静态服务器页面：http://127.0.0.1:8000/?data=demo#/world")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
