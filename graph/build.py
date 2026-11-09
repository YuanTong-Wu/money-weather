#!/usr/bin/env python3
"""graph/build.py — 关系网 merge (DESIGN.md §13 company web, §14 宁可估不可空).

Reads   graph/raw/*.json                 researched batches {batch, companies[{t,name,take,asOf}], edges[§13], privateNodes[{id,name,note,listed?}]}
        web/data/tree.json, web/data/fm/tree.json, fullmarket/universe_raw.json   names / which tickers are on the map
        cache/prices.pkl (pipeline/fetch.py) + fullmarket/cache/prices_full.parquet   daily closes for measured ties
        scout/out/graph_patches.json     侦察兵 'gap' results (only fill estimates; real data wins)
        web/data/overrides.json          the owner's corrections ("edge:A>B" money etc.; owner beats everything)
Writes  web/data/graph/edges.json        {asOf, generatedAt, stats, nodes{id:{…}}, companies{T:{name,take,asOf}}, edges[…], measured[…]}
        web/data/graph/<ID>.json         one per company/neighbour (':' → '_', e.g. p_openai.json):
                                         {t, name, note, take, takeAuto, researched, inUniverse, inFull, private, listed,
                                          flows{inB, outB, …}, upstream[…], downstream[…], competitors[…], partners[…],
                                          nodes{id:{name, note, inUniverse, inFull, private, listed, est}}, edges[…], measured[…]}
        web/data/graph/index.json        {asOf, stats, companies[{t, name, n, m, researched, inUniverse, private, listed, inB, outB}]}

Edges are directed by MONEY: money.from pays money.to. Role buckets are from the company's point of view:
upstream = the suppliers / licensors it pays, downstream = the customers / licensees that pay it, competitors,
partners = partner / invests-in / finances (either way). Measured ties (no opinion, est:false):
comove = 120-day correlation of daily returns ≥ 0.6 (each company's top 6, plus any business neighbour ≥ 0.6);
leadlag = one tends to move 1..5 days before the other, kept only when clearly meaningful (see LEADLAG_*).

    python3 graph/build.py              # build everything
    python3 graph/build.py --check NVDA # build, then print NVDA's buckets (money directions) for a sanity look
    python3 graph/build.py --no-measured  # skip the price-based ties (fast)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import pickle
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "graph" / "raw"
DATA = ROOT / "web" / "data"
OUT = Path(os.environ.get("MW_GRAPH_OUT") or (DATA / "graph")).resolve()
PRICE_CACHE = Path(os.environ.get("MW_PRICE_CACHE") or (ROOT / "cache" / "prices.pkl"))   # = pipeline/fetch.py CACHE
FM_PRICES = ROOT / "fullmarket" / "cache" / "prices_full.parquet"
FM_RAW = ROOT / "fullmarket" / "universe_raw.json"
SCOUT_PATCHES = Path(os.environ.get("MW_SCOUT_PATCHES") or (ROOT / "scout" / "out" / "graph_patches.json"))
EXTRA_PATCHES = Path(os.environ.get("MW_EXTRA_PATCHES") or (ROOT / "graph" / "patches_extra.json"))   # graph/apply_patch.py --file / stdin
PATCH_LOG = Path(os.environ.get("MW_PATCH_LOG") or (ROOT / "graph" / "patch_log.json"))        # what became of every scout patch
FUND = ROOT / "graph" / "fundamentals.json"                 # graph/fundamentals.py: revenue / capex per listed company
SANITY_REPORT = Path(os.environ.get("MW_SANITY_REPORT") or (ROOT / "graph" / "sanity_report.json"))
SEARCH = DATA / "search.json"
FM_SEARCH = DATA / "fm" / "search.json"
LOCK = ROOT / "graph" / ".build.lock"
OVERRIDES = Path(os.environ.get("MW_OVERRIDES_PATH") or (DATA / "overrides.json"))

TYPES = ("buys-from", "sells-to", "partner", "invests-in", "competes", "licenses", "finances")
COMOVE_WINDOW, COMOVE_MIN_OBS, COMOVE_MIN, COMOVE_TOP, COMOVE_TIED_EXTRA = 120, 100, 0.6, 6, 4
LEADLAG_WINDOW, LEADLAG_MIN_OBS, LEADLAG_LAGS = 480, 400, range(1, 6)   # ≈ the 2 years the cache holds
LEADLAG_FDR = 0.05          # Benjamini–Hochberg false-discovery rate over every (pair, lag, direction) test
LEADLAG_MIN_R = 0.12        # and a size worth mentioning
LEADLAG_HALF_MIN = 0.08     # must show up in BOTH halves of the window (stable, not one event)
LEADLAG_MARGIN = 0.06       # and clearly beat the reverse direction
SAME_CO_CORR = 0.97         # share classes of one company (FOX/FOXA…) are not a "tie"
WINSOR_K = 3.0              # returns clipped at ±3 robust sigmas before any correlation

# A foreign primary listing → the US-listed line of the SAME company (only used when that US ticker is on one
# of our maps). Share classes fold into the one the map uses.
ALIAS = {
    "GOOG": "GOOGL", "BRK-A": "BRK-B", "BRK.A": "BRK-B", "BRK.B": "BRK-B", "FOX": "FOXA", "NWS": "NWSA", "FB": "META",
    "2330.TW": "TSM", "000660.KS": "SKHY", "7203.T": "TM", "6758.T": "SONY", "8306.T": "MUFG", "8316.T": "SMFG",
    "8411.T": "MFG", "8604.T": "NMR", "8591.T": "IX", "4502.T": "TAK", "7267.T": "HMC", "7974.T": "NTDOY",
    "005490.KS": "PKX", "3711.TW": "ASX", "9988.HK": "BABA", "9618.HK": "JD", "9888.HK": "BIDU", "9999.HK": "NTES",
    "FME": "FMS", "FME.DE": "FMS", "WPP.L": "WPP", "VOD.L": "VOD", "TEF.MC": "TEF", "ASML.AS": "ASML", "SAP.DE": "SAP",
    "NOVO-B.CO": "NVO", "SHEL.L": "SHEL", "AZN.L": "AZN", "HSBA.L": "HSBC", "RIO.L": "RIO", "BP.L": "BP",
    "ULVR.L": "UL", "GSK.L": "GSK", "SAN.PA": "SNY", "NOKIA.HE": "NOK", "ERIC-B.ST": "ERIC", "INFY.NS": "INFY",
    "DGE.L": "DEO", "LLOY.L": "LYG", "BATS.L": "BTI", "NG.L": "NGG", "REL.L": "RELX",
    "9984.T": "SFTBY", "MC.PA": "LVMUY",                      # OTC ADRs that the curated map carries
    "SATS": "ECHO", "ZG": "Z", "BK": "BNY", "p:luckin": "LKNCY", "p:spacex": "SPCX",   # renamed / other class / since listed
}
# names the scout / owner may type instead of an id
NAME_ALIAS = {
    "google": "GOOGL", "alphabet": "GOOGL", "googlecloud": "GOOGL", "apple": "AAPL", "facebook": "META",
    "microsoft": "MSFT", "amazon": "AMZN", "aws": "AMZN", "nvidia": "NVDA", "tsmc": "TSM", "softbank": "9984.T",
    "softbankgroup": "9984.T", "openai": "p:openai", "anthropic": "p:anthropic", "xai": "p:xai", "spacex": "p:spacex",
    "ginkgo": "DNA", "ginkgobioworks": "DNA", "oracle": "ORCL", "broadcom": "AVGO", "crowdstrike": "CRWD",
}
# English names of foreign primary listings / big private names a scout may write (used only if the id is in the graph)
EN_NAMES = {
    "samsung": "005930.KS", "samsungelectronics": "005930.KS", "skhynix": "000660.KS", "hynix": "000660.KS",
    "foxconn": "2317.TW", "honhai": "2317.TW", "honhaiprecision": "2317.TW", "tencent": "0700.HK", "xiaomi": "1810.HK",
    "smic": "0981.HK", "catl": "300750.SZ", "contemporaryamperex": "300750.SZ", "byd": "1211.HK", "lenovo": "0992.HK",
    "mediatek": "2454.TW", "tokyoelectron": "8035.T", "advantest": "6857.T", "kioxia": "285A.T", "renesas": "6723.T",
    "hitachi": "6501.T", "bayer": "BAYN.DE", "siemens": "SIE.DE", "infineon": "IFX.DE", "lgenergysolution": "373220.KS",
    "wuxibiologics": "2269.HK", "luxshare": "002475.SZ", "innolight": "300308.SZ", "eoptolink": "300502.SZ",
    "deutschetelekom": "DTE.DE", "airbus": "AIR.PA", "toyota": "TM", "sony": "SONY", "huawei": "p:huawei",
    "bytedance": "p:bytedance", "tiktok": "p:bytedance", "stargate": "p:stargate", "mistral": "p:mistral",
    "databricks": "p:databricks", "metaplatforms": "META", "amazonwebservices": "AMZN", "microsoftazure": "MSFT",
    "azure": "MSFT", "googledeepmind": "GOOGL", "deepmind": "GOOGL", "youtube": "GOOGL", "instagram": "META",
    "whatsapp": "META", "novonordisk": "NVO", "elililly": "LLY", "lilly": "LLY", "twist": "TWST",
}
# names for foreign listings nobody named in the raw files (from the graph-ui fixture builder)
FOREIGN = {
    "000660.KS": "SK 海力士", "002459.SZ": "晶澳科技", "005930.KS": "三星电子", "009830.KS": "韩华 Qcells",
    "034730.KS": "SK 集团", "0981.HK": "中芯国际", "1347.HK": "华虹半导体", "2330.TW": "台积电（台股）",
    "2379.TW": "瑞昱", "2454.TW": "联发科", "300274.SZ": "阳光电源", "300308.SZ": "中际旭创", "300750.SZ": "宁德时代",
    "3034.TW": "联咏", "336260.KS": "斗山燃料电池", "373220.KS": "LG 新能源", "4901.T": "富士胶片", "4919.TW": "新唐",
    "5202.T": "日本板硝子", "600703.SS": "三安光电", "601012.SS": "隆基绿能", "6501.T": "日立", "6856.T": "堀场",
    "688032.SS": "禾迈", "688348.SS": "昱能科技", "688408.SS": "中信博", "688472.SS": "阿特斯阳光（A股）",
    "688599.SS": "天合光能", "6920.T": "Lasertec", "7731.T": "尼康", "7751.T": "佳能", "8035.T": "东京电子",
    "8630.T": "SOMPO", "9984.T": "软银集团", "ATCO-A.ST": "阿特拉斯·科普柯", "BESI.AS": "BESI", "CSU.TO": "Constellation",
    "DSG.TO": "Descartes", "DSY.PA": "达索系统", "EL.PA": "依视路陆逊梯卡", "EXPN.L": "益博睿", "GALP.LS": "Galp",
    "HEXA-B.ST": "Hexagon", "IFX.DE": "英飞凌", "ITM.L": "ITM Power", "JMAT.L": "庄信万丰", "MRK.DE": "默克集团",
    "NEL.OL": "Nel", "PRY.MI": "普睿司曼", "S92.DE": "SMA Solar", "SIE.DE": "西门子", "SINCH.ST": "Sinch",
    "VNP.TO": "5N Plus", "VOD.L": "沃达丰", "WRT1V.HE": "瓦锡兰", "XRO.AX": "Xero", "0992.HK": "联想集团",
    "6857.T": "爱德万测试", "6723.T": "瑞萨电子", "300502.SZ": "新易盛", "000725.SZ": "京东方", "285A.T": "铠侠",
    "2317.TW": "鸿海", "688008.SS": "澜起科技", "6594.T": "尼得科", "5803.T": "藤仓", "6503.T": "三菱电机",
    "3661.TW": "世芯", "8058.T": "三菱商事", "4004.T": "力森诺科", "MQG.AX": "麦格理", "1810.HK": "小米集团",
    "002475.SZ": "立讯精密", "6954.T": "发那科", "7741.T": "豪雅", "6902.T": "电装", "BK": "纽约梅隆银行",
    "FNMA": "房利美", "FORD": "Forward Industries", "ZG": "Zillow", "FIP": "FTAI Infrastructure", "MAXN": "Maxeon",
    "TYGO": "Tigo", "GWH": "ESS Tech", "FTCI": "FTC Solar", "QRVO": "Qorvo", "COMM": "康普 CommScope",
    "1530.HK": "三生制药", "196170.KQ": "Alteogen", "2196.HK": "复星医药", "2252.HK": "微创机器人",
    "2269.HK": "药明生物", "300122.SZ": "智飞生物", "3933.HK": "联邦制药", "4151.T": "协和麒麟", "4503.T": "安斯泰来",
    "4519.T": "中外制药", "4528.T": "小野药品", "600276.SS": "恒瑞医药", "GLPG": "Galapagos", "SDZ.SW": "山德士 Sandoz",
    "ALM.MC": "Almirall",
}
EXCH_SUFFIX = re.compile(r"\.(T|HK|TW|TWO|KS|KQ|SS|SZ|SR|L|PA|DE|AS|SW|MI|MC|CO|ST|OL|HE|BR|VI|WA|IS|NS|BO|AX|TO|V|SA|MX|JK|SI|LS|F|NE|IR|NZ|BK|KL)$")
FILING_RX = re.compile(r"10-?K|10-?Q|20-?F|8-?K|S-1|DEF ?14A|年报|季报|财报|招股|公告|annual report|earnings|investor|官方|新闻稿|press|filing|SEC", re.I)
MEMORY_RX = re.compile(r"记忆|未联网|训练知识|knowledge")


def log(*a):
    print(*a, flush=True)


def read_json(p: Path, default=None):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except Exception as e:  # a file being written right now, or broken
        log(f"  ! cannot read {p.name}: {e}")
        return default


def write_json(p: Path, obj) -> None:
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, p)


def write_json_if_changed(p: Path, obj, ignore: tuple = ("generatedAt",)) -> bool:
    """Write only when the content differs from what is on disk (ignoring the build stamp). The project lives in an
    iCloud-synced folder, where every rename of ~2,400 company files costs file-provider work (minutes on a busy
    machine); a scout patch touches 2–3 companies, so the rest stays untouched. → True when written."""
    try:
        old = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(old, dict) and isinstance(obj, dict):
            strip = lambda d: {k: v for k, v in d.items() if k not in ignore}  # noqa: E731
            if strip(old) == json.loads(json.dumps(strip(obj), ensure_ascii=False, allow_nan=False)):
                return False
    except (OSError, ValueError):
        pass
    write_json(p, obj)
    return True


def num(x):
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x) if math.isfinite(x) else None
    try:
        v = float(str(x).replace(",", "").strip())
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def fname(i: str) -> str:
    return i.replace(":", "_") + ".json"


# ════════════════════════════ universe: who is on which map, and what are they called ════════════════════════════
class Universe:
    def __init__(self):
        self.cur: dict[str, dict] = {}       # curated map (web/data/tree.json): ticker → {name, note, path}
        self.fm: dict[str, dict] = {}        # full-market map (web/data/fm/tree.json)
        self.fmraw: dict[str, dict] = {}     # fullmarket/universe_raw.json stocks (common / adr / mlp)
        self.etf: set[str] = set()
        tree = read_json(DATA / "tree.json", {}) or {}

        def walk(n, path, into):
            if n.get("kind") == "stock" and n.get("ticker"):
                into.setdefault(n["ticker"], {"name": n.get("name"), "note": n.get("note"), "path": path})
            for c in n.get("children") or []:
                walk(c, path + [n.get("id")], into)
        walk(tree, [], self.cur)
        fm = read_json(DATA / "fm" / "tree.json", {}) or {}
        walk(fm, [], self.fm)
        raw = read_json(FM_RAW, {}) or {}
        for s in raw.get("stocks") or []:
            if s.get("t"):
                self.fmraw[s["t"]] = s
        world_parts = {"intl", "bonds", "commod", "crypto", "cash"}
        for t, v in self.cur.items():
            if t in self.fmraw:
                continue
            txt = f"{v.get('name') or ''} {v.get('note') or ''}"
            top = v["path"][1] if len(v["path"]) > 1 else ""
            if top in world_parts or re.search(r"ETF|一篮子|基金", txt, re.I):
                if not re.search(r"交易所|管道|放贷|老板", txt):
                    self.etf.add(t)

    def known(self, t: str) -> bool:
        return t in self.cur or t in self.fm or t in self.fmraw


def _names_mod():
    """graph/names.py (one display name per company + the wrong-alias lint), loaded by path: graph/ is not a package."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("graph_names", Path(__file__).resolve().parent / "names.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("graph_names", mod)
    spec.loader.exec_module(mod)
    return mod


NAMES = _names_mod()
EDGE_TEXT = ("say", "sayMild", "basis", "checkNote", "source")
MONEY_TEXT = ("what", "basis", "source")


def lint_names(edges: list[dict], companies: dict, stats: Counter, pnodes: dict | None = None) -> None:
    """§12/§20: one name per company in every researched / generated line (「银杏」→ Ginkgo, 「推特」→ Twist next to TWST)."""
    nb = defaultdict(set)
    for e in edges:
        ids = {e["a"], e["b"]}
        nb[e["a"]].add(e["b"])
        nb[e["b"]].add(e["a"])
        for holder, keys in ((e, EDGE_TEXT), (e.get("money") or {}, MONEY_TEXT), (e.get("share") or {}, ("ofTo", "ofFrom"))):
            for k in keys:
                v = holder.get(k)
                if isinstance(v, str) and (w := NAMES.lint(v, ids)) != v:
                    holder[k] = w
                    stats["name_linted"] += 1
    for t, c in companies.items():
        ids = {t} | nb.get(t, set())
        for k in ("take", "takeMild"):
            v = c.get(k)
            if isinstance(v, str) and (w := NAMES.lint(v, ids)) != v:
                c[k] = w
                stats["name_linted"] += 1
    for i, p in (pnodes or {}).items():           # private nodes' notes ("2026Q2 占银杏收入 45%")
        v = p.get("note")
        if isinstance(v, str) and (w := NAMES.lint(v, {i} | nb.get(i, set()))) != v:
            p["note"] = w
            stats["name_linted"] += 1


U: Universe | None = None
LAST: dict = {}            # the last build's scout outcomes / sanity report (graph/apply_patch.py reads them)
SCALE: dict = {}           # id → {revB, capexB, capB, at} from graph/fundamentals.json (yfinance TTM), shown next to the flows


def norm_id(x, known_extra: set | None = None) -> str | None:
    """Raw id → canonical id: 'p:…' private ids lower-case; tickers upper-case, US share classes with '-',
    foreign primary listings folded into their US line when that line is on our maps."""
    if x is None:
        return None
    s = str(x).strip()
    if not s:
        return None
    if s[:2].lower() == "p:":
        s = "p:" + s[2:].strip().lower()
        tgt = ALIAS.get(s)
        return tgt if tgt and U and U.known(tgt) else s
    if s[:2].lower() == "s:":
        s = s[2:]
    s = s.upper().replace(" ", "")
    m = re.match(r"^([A-Z]{1,5})\.([A-C])$", s)          # BRK.B → BRK-B (but BA.L / 2702.T are exchanges)
    if m and not EXCH_SUFFIX.search(s):
        s = f"{m.group(1)}-{m.group(2)}"
    tgt = ALIAS.get(s)
    if tgt and U and U.known(tgt):
        s = tgt
    return s


def is_private(i: str) -> bool:
    return i.startswith("p:")


# ════════════════════════════ raw batches ════════════════════════════
def per_norm(per):
    """'year' | 'quarter' | 'once' | 'deal' | 'total' | 'stake' | 'commitment' | 'contract' | 'framework' (+ the original text)."""
    if per is None:
        return None, None
    p = str(per).strip()
    if p in ("year", "quarter", "once", "deal", "total", "stake", "commitment", "contract", "framework", "month"):
        return p, None
    if re.search(r"一次性|收购|定增|one-?off|once", p):
        return "once", p
    if re.search(r"累计|cumulative|total", p):
        return "total", p
    if re.search(r"合同|contract", p):
        return "contract", p
    if re.search(r"额度|承诺|commit|贷款", p):
        return "commitment", p
    if re.search(r"年|year|annual", p):
        return "year", p
    if re.search(r"季|quarter", p):
        return "quarter", p
    return "deal", p


def has_source(*xs) -> bool:
    return any(isinstance(x, str) and x.strip() and x.strip() not in ("est", "估", "-", "null") for x in xs)


def clean_edge(e: dict, batch: str, deep: bool, stats: Counter) -> dict | None:
    if not isinstance(e, dict):
        return None
    a, b = norm_id(e.get("a")), norm_id(e.get("b"))
    if not a or not b:
        stats["drop_noid"] += 1
        return None
    if a == b:
        stats["drop_selfloop"] += 1
        return None
    t = str(e.get("type") or "").strip().lower()
    if t not in TYPES:
        stats["type_fixed"] += 1
        t = {"buys": "buys-from", "sells": "sells-to", "supplier": "sells-to", "customer": "buys-from",
             "invests": "invests-in", "competitor": "competes", "license": "licenses"}.get(t, "partner")
    out = {"a": a, "b": b, "type": t}
    src = e.get("source")
    # §14 est flags. Old batches (01–14) had no est field: missing → false only when a source is given
    est = e.get("est")
    if not isinstance(est, bool):
        est = not has_source(src)
        stats["est_defaulted"] += 1
    inferred = bool(e.get("inferred"))
    m = e.get("money")
    money = None
    if isinstance(m, dict) and (m.get("from") or m.get("to") or m.get("usdB") is not None):
        fr, to = norm_id(m.get("from")), norm_id(m.get("to"))
        if fr not in (a, b) or to not in (a, b) or fr == to:
            # payer/payee missing or not one of the two ends: fall back to the type's natural direction
            fr, to = {"buys-from": (a, b), "invests-in": (a, b), "finances": (a, b),
                      "sells-to": (b, a), "licenses": (b, a)}.get(t, (fr if fr in (a, b) else a, to if to in (a, b) and to != fr else (b if fr == a else a)))
            stats["money_dir_repaired"] += 1
        per, per_text = per_norm(m.get("per"))
        money = {"from": fr, "to": to, "usdB": num(m.get("usdB")), "per": per, "what": m.get("what")}
        if per_text:
            money["perText"] = per_text
        for k in ("source", "asOf"):
            if m.get(k):
                money[k] = m[k]
        mest = m.get("est")
        if not isinstance(mest, bool):
            mest = est if not has_source(m.get("source"), src) else False
        money["est"] = bool(mest) or inferred
        lo, hi = num(m.get("usdBLow")), num(m.get("usdBHigh"))
        if money["usdB"] is not None and money["usdB"] < 0:
            money["usdB"] = abs(money["usdB"])
        if lo is not None and hi is not None and lo > hi:
            lo, hi = hi, lo
        if lo is not None:
            money["usdBLow"] = lo
        if hi is not None:
            money["usdBHigh"] = hi
        if m.get("basis"):
            money["basis"] = m["basis"]
    out["money"] = money
    sh = e.get("share")
    out["share"] = sh if isinstance(sh, dict) and (sh.get("ofTo") or sh.get("ofFrom")) else None
    st = num(e.get("strength"))
    out["strength"] = int(min(3, max(1, round(st)))) if st is not None else 1
    for k in ("since", "asOf"):
        out[k] = e.get(k)
    c = num(e.get("conf"))
    out["conf"] = round(min(1.0, max(0.0, c)), 2) if c is not None else (0.4 if est else 0.6)
    out["source"] = src
    out["est"] = bool(est) or inferred
    if inferred:
        out["inferred"] = True
    basis = e.get("basis") or (money or {}).get("basis")
    if basis:
        out["basis"] = basis
    for k in ("say", "sayMild", "verified", "checked", "checkedAt"):
        if e.get(k) not in (None, ""):
            out[k] = e[k]
    out["batch"] = batch
    out["_deep"] = deep
    return out


def payer_payee(e: dict):
    m = e.get("money")
    if m and m.get("from") and m.get("to"):
        return m["from"], m["to"]
    t = e["type"]
    if t in ("buys-from", "finances", "invests-in"):
        return e["a"], e["b"]
    if t in ("sells-to", "licenses"):
        return e["b"], e["a"]
    return None, None


def edge_key(e: dict):
    t = e["type"]
    if t in ("buys-from", "sells-to"):
        p, q = payer_payee(e)
        return ("supply", p, q)
    if t == "licenses":
        p, q = payer_payee(e)
        return ("licenses", p, q)
    if t in ("invests-in", "finances"):
        return (t, e["a"], e["b"])
    return (t,) + tuple(sorted((e["a"], e["b"])))


def quality(e: dict) -> float:
    m = e.get("money") or {}
    q = 0.0
    if m.get("usdB") is not None:
        q += 1.0 + (2.0 if not m.get("est") else 0.0)
    if not e.get("est") and not e.get("inferred"):
        q += 1.0
    q += e.get("conf") or 0
    srcs = f"{e.get('source') or ''} {m.get('source') or ''}"
    if FILING_RX.search(srcs):
        q += 0.5
    if MEMORY_RX.search(srcs):
        q -= 0.5
    if e.get("_deep"):
        q += 0.3
    if e.get("verified") or e.get("checked") or e.get("checkedAt"):
        q += 0.3
    y = str(e.get("asOf") or "")[:4]
    if y.isdigit():
        q += 0.2 * min(1.0, max(0.0, (int(y) - 2022) / 4))    # newer research wins ties
    return q


def reconcile(edges: list[dict], stats: Counter) -> list[dict]:
    """A→B researched from both sides (A buys-from B ≡ B sells-to A) → one edge; keep the better-sourced number,
    fill gaps from the others, remember the others' numbers (alt) and how many batches saw it (seenIn)."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for e in edges:
        groups[edge_key(e)].append(e)
    out = []
    for key, es in groups.items():
        if len(es) == 1:
            out.append(es[0])
            continue
        # the same batch may list two genuinely different flows between one pair (different "what"): keep both
        clusters: list[list[dict]] = []
        for e in sorted(es, key=quality, reverse=True):
            placed = False
            if e.get("_sep"):                    # a scout flow in another rhythm (yearly vs one-off): its own edge
                clusters.append([e])
                continue
            for cl in clusters:
                if cl[0].get("_sep"):
                    continue
                if all(x["batch"] != e["batch"] for x in cl):
                    cl.append(e)
                    placed = True
                    break
                w1 = str((cl[0].get("money") or {}).get("what") or "")[:12]
                w2 = str((e.get("money") or {}).get("what") or "")[:12]
                if w1 and w1 == w2:
                    cl.append(e)
                    placed = True
                    break
            if not placed:
                clusters.append([e])
        for cl in clusters:
            best = dict(cl[0])
            if len(cl) > 1:
                stats["merged"] += len(cl) - 1
                batches = sorted({x["batch"] for x in cl} | set(best.get("seenIn") or []))
                best["seenIn"] = batches
                bm = best.get("money")
                alts = []
                for o in cl[1:]:
                    om = o.get("money")
                    if not best.get("share") and o.get("share"):
                        best["share"] = o["share"]
                    elif best.get("share") and o.get("share"):
                        for k in ("ofTo", "ofFrom"):
                            if not best["share"].get(k) and o["share"].get(k):
                                best["share"] = {**best["share"], k: o["share"][k]}
                    for k in ("since", "say", "basis"):
                        if not best.get(k) and o.get(k):
                            best[k] = o[k]
                    if om and om.get("usdB") is not None:
                        if not bm or bm.get("usdB") is None:
                            best["money"] = bm = dict(om)
                        elif abs(om["usdB"] - bm["usdB"]) > 0.2 * max(bm["usdB"], 1e-9):
                            alts.append({"usdB": om["usdB"], "per": om.get("per"), "est": om.get("est"),
                                         "source": om.get("source") or o.get("source"), "batch": o["batch"]})
                    elif om and not bm:
                        best["money"] = bm = dict(om)
                    if best.get("strength", 1) < o.get("strength", 1):
                        best["strength"] = o["strength"]
                if alts:
                    have = best.get("alt") or []
                    seen_alt = {(a.get("usdB"), a.get("batch")) for a in have}
                    best["alt"] = (have + [a for a in alts if (a.get("usdB"), a.get("batch")) not in seen_alt])[:5]
                # seen independently from both ends and the numbers agree → a bit more confidence
                if len({x["batch"] for x in cl}) > 1 and not alts:
                    best["conf"] = round(min(0.95, (best.get("conf") or 0.5) + 0.05 * (len(cl) - 1)), 2)
            out.append(best)
    return out


# ════════════════════════════ scout patches + owner overrides ════════════════════════════
class Resolver:
    """Free text ('GOOGLE CLOUD (ALPHABET)', 'S:DNA', 'GINKGO BIOWORKS (DNA)', 'TWIST BIOSCIENCE', 'OPENAI/STARGATE…')
    → a node id. Knows every id in the graph, every name the raw batches use, the curated + full-market search
    indexes (web/data/search.json, web/data/fm/search.json) and fullmarket/universe_raw.json's English names.
    `place(text)` never fails: what cannot be matched becomes a ticker (when it looks like one) or a 'p:slug'."""

    STOP = r"\b(inc|incorporated|corp|corporation|co|company|group|holdings?|ltd|limited|plc|sa|ag|nv|se|spa|the|llc|lp|" \
           r"class [a-c]|common stock|ordinary shares?|american depositary shares?|ads|adr|shares?)\b\.?"

    def __init__(self, names: dict[str, set[str]], ids: set[str], prefer: set[str] | None = None):
        self.ids = ids
        self.prefer = prefer or set()          # on an ambiguous name, a ticker on the curated map wins
        self.by: dict[str, set[str]] = defaultdict(set)
        for i, ns in names.items():
            for n in ns:
                for part in self.parts(n):
                    self.by[part].add(i)
        for k, v in NAME_ALIAS.items():
            self.by[k] = {norm_id(v)}
        self.how: dict[str, str] = {}          # text → how it was placed (for the patch log)

    @classmethod
    def key(cls, s: str) -> str:
        s = s.lower()
        s = re.sub(cls.STOP, "", s)
        return re.sub(r"[\s\W_]+", "", s)

    def parts(self, name: str):
        out = {self.key(name)}
        for p in re.split(r"[/（）()·,，、|]|\s{2,}", name):
            p = p.strip()
            if p:
                out.add(self.key(p))
        latin = " ".join(re.findall(r"[A-Za-z][A-Za-z0-9&.'-]*", name))
        if latin:
            out.add(self.key(latin))
        cjk = "".join(re.findall(r"[⺀-鿿]+", name))
        if cjk:
            out.add(cjk)
        return {p for p in out if len(p) >= 2}

    def _pick(self, hit: set[str] | None) -> str | None:
        if not hit:
            return None
        if len(hit) == 1:
            return next(iter(hit))
        pref = [h for h in hit if h in self.prefer]
        return pref[0] if len(pref) == 1 else None

    def __call__(self, text) -> str | None:
        if not text:
            return None
        s = str(text).strip()
        if s[:2].lower() == "s:":                 # a map stock id ('s:GOOGLE' from the UI) → the name / ticker behind it
            s = s[2:].strip()
        cand = norm_id(s)
        if cand in self.ids:
            return cand
        for t in re.findall(r"\(([A-Za-z0-9.\-:]{1,12})\)|（([A-Za-z0-9.\-:]{1,12})）", s):
            t = norm_id(t[0] or t[1])
            if t in self.ids:
                return t
        pieces = [s] + [p for p in re.split(r"[/（）()·,，、|]", s) if p.strip()]
        for p in pieces:
            c = norm_id(p)
            if c in self.ids:
                return c
            hit = self._pick(self.by.get(self.key(p)))
            if hit:
                return hit
        # a known multi-word name that starts the text ('GOOGLE CLOUD PLATFORM' → google…)
        k = self.key(s)
        best = [(len(n), self._pick(ids)) for n, ids in self.by.items() if len(n) >= 5 and k.startswith(n)]
        best = [b for b in best if b[1]]
        if best:
            return max(best, key=lambda x: x[0])[1]
        return None

    TICKER_RX = re.compile(r"^(?:[A-Z]{1,5}(?:-[A-Z])?|[A-Z0-9]{1,8}\.[A-Z]{1,3}|\d{4,6}\.[A-Z]{1,3})$")

    @staticmethod
    def slug(text: str) -> str:
        s = re.sub(r"[（(][^）)]*[）)]", " ", str(text))          # drop '(含英伟达芯片采购)' style asides
        latin = " ".join(re.findall(r"[A-Za-z0-9][A-Za-z0-9&.'-]*", s)).lower()
        latin = re.sub(Resolver.STOP, " ", latin)
        sl = re.sub(r"[^a-z0-9]+", "-", latin).strip("-")[:40].strip("-")
        if len(sl) < 2:
            import hashlib
            sl = "x-" + hashlib.sha1(str(text).encode("utf-8")).hexdigest()[:8]
        return "p:" + sl

    def place(self, text) -> tuple[str | None, str]:
        """→ (id, how) with how ∈ id | name | ticker | slug | none."""
        if not text or not str(text).strip():
            return None, "none"
        s = str(text).strip()
        hit = self(s)
        if hit:
            how = "id" if norm_id(s) == hit else "name"
            self.how[s] = how
            return hit, how
        bare = s[2:] if s[:2].lower() == "s:" else s
        if " " not in bare.strip() and self.TICKER_RX.match(bare.strip().upper()) and not bare.lower().startswith("p:"):
            self.how[s] = "ticker"
            return norm_id(bare), "ticker"
        if s[:2].lower() == "p:":
            return norm_id(s), "id"
        self.how[s] = "slug"
        return self.slug(s), "slug"


def make_resolver(names: dict[str, set[str]], all_ids: set[str]) -> Resolver:
    """names = everything the raw batches call each id; adds the map's own names, the search indexes and the
    full-market English names, so scout / owner / UI text resolves to the same ids the graph uses."""
    nm: dict[str, set[str]] = defaultdict(set, {k: set(v) for k, v in names.items()})
    ids = set(all_ids)
    for t, v in (U.cur if U else {}).items():
        if v.get("name"):
            nm[t].add(v["name"])
    for t, v in (U.fm if U else {}).items():
        if v.get("name"):
            nm[t].add(v["name"])
    for t, s in (U.fmraw if U else {}).items():
        for k in ("short", "name"):
            if s.get(k):
                nm[t].add(s[k])
    for f in (SEARCH, FM_SEARCH):
        for it in read_json(f, []) or []:
            if not isinstance(it, dict) or not it.get("ticker"):
                continue
            t = norm_id(it["ticker"])
            ids.add(t)
            if it.get("name"):
                nm[t].add(it["name"])
    for t, n in FOREIGN.items():
        nm[norm_id(t)].add(n)
    r = Resolver(nm, ids, prefer=set(U.cur) if U else set())
    for k, v in EN_NAMES.items():
        t = norm_id(v)
        if t in ids and k not in NAME_ALIAS:
            r.by[k] = {t}
    return r


# ── scout patches ─────────────────────────────────────────────────────────────────────────────────────────────
RECUR = ("year", "quarter", "month")
NOT_YEARLY_RX = re.compile(r"非逐年|不是每年|非年度|并非每年")                       # the scout says outright: not per year
TOTALISH_RX = re.compile(r"累计投资|总承诺|累计承诺|一次性")                          # … or names a total
YEARLY_RX = re.compile(r"年均|年化|均摊|逐年|每年约|除以\s*\d+\s*年|÷\s*\d+\s*年")       # … but then annualised it


def load_patches() -> list[dict]:
    """scout/out/graph_patches.json (written by scout/run.py) + graph/patches_extra.json (graph/apply_patch.py --file).
    Same key → the newer one ('at')."""
    out: dict[str, dict] = {}
    for f in (SCOUT_PATCHES, EXTRA_PATCHES):
        raw = read_json(f, []) or []
        if isinstance(raw, dict):
            raw = raw.get("patches") or []
        for pt in raw:
            if not isinstance(pt, dict):
                continue
            k = str(pt.get("key") or pt.get("taskId") or json.dumps(pt, sort_keys=True, ensure_ascii=False)[:200])
            if k not in out or str(pt.get("at") or "") >= str(out[k].get("at") or ""):
                out[k] = pt
    return sorted(out.values(), key=lambda p: str(p.get("at") or ""))


def normalize_patch(pt: dict, resolve: Resolver) -> dict:
    """A scout patch with messy names → canonical ids + a cleaned money object. Never raises.
    → {ok, a, b, fr, to, type, money, how{…}, why?}"""
    m = pt.get("money") if isinstance(pt.get("money"), dict) else {}
    A, ha = resolve.place(pt.get("a"))
    B, hb = resolve.place(pt.get("b"))
    F, hf = resolve.place(m.get("from")) if m.get("from") else (None, "none")
    T, ht = resolve.place(m.get("to")) if m.get("to") else (None, "none")
    # money.from / to are usually the cleaner ids ('DNA', 'GOOGL') — and a/b the messier names of the same two.
    # A slug that only exists because the text was messy loses to a real id on the same side.
    if F and T and F != T:
        fr, to = F, T
        if A and B and A != B and {A, B} != {F, T}:
            # a/b name the same two differently: a side that only became a slug takes the a/b id it stands for
            hab = {A: ha, B: hb}
            if hf == "slug" and T in hab:
                other = B if T == A else A
                if hab[other] != "slug":
                    fr = other
            if ht == "slug" and F in hab:
                other = B if F == A else A
                if hab[other] != "slug":
                    to = other
    elif A and B and A != B:
        fr, to = A, B
        if pt.get("type") in ("sells-to", "licenses"):
            fr, to = B, A
    else:
        return {"ok": False, "why": "两头认不出来", "how": {"a": ha, "b": hb, "from": hf, "to": ht}}
    if fr == to:
        return {"ok": False, "why": "付钱和收钱是同一家", "how": {"a": ha, "b": hb}}
    usd = num(m.get("usdB"))
    lo, hi = num(m.get("usdBLow")), num(m.get("usdBHigh"))
    if usd is None and lo is not None and hi is not None:
        usd = (lo + hi) / 2
    if usd is None:
        return {"ok": False, "why": "没有金额", "fr": fr, "to": to, "how": {"from": hf, "to": ht}}
    usd = abs(usd)
    if lo is not None and hi is not None and lo > hi:
        lo, hi = hi, lo
    per = per_norm(m.get("per") or "year")[0]
    basis = str(pt.get("basis") or "")
    per_fixed = None
    txt = basis + " " + str(m.get("what") or "")
    if per in RECUR and (NOT_YEARLY_RX.search(txt) or (TOTALISH_RX.search(txt) and not YEARLY_RX.search(txt))):
        per_fixed, per = per, "total"          # the scout said 'year' but its own basis says it is a cumulative total
    t = pt.get("type") if pt.get("type") in TYPES else "buys-from"
    if t in PERIOD_TYPES and per in RECUR and not per_fixed:
        # the same reading the raw batches get (fix_periods): "2025 年再次入股" per year is a one-off
        fund = (read_json(FUND, {}) or {}).get("items") or {}
        rv = lambda i: (fund.get(i) or {}).get("revB") if ((fund.get(i) or {}).get("revB") or 0) > 0 else None  # noqa: E731
        np_, _ = period_of({"type": t, "money": {"what": m.get("what"), "basis": basis, "to": to, "usdB": usd, "per": per}}, rv)
        if np_ and np_ != "intra":
            per_fixed, per = per, np_
    names = {}
    for txt, i, h in ((pt.get("a"), A, ha), (pt.get("b"), B, hb), (m.get("from"), F, hf), (m.get("to"), T, ht)):
        if i and h == "slug" and i in (fr, to):
            nm = re.sub(r"[（(][^）)]*[）)]", "", str(txt)).strip() or str(txt)
            names[i] = nm.title() if nm.isupper() else nm
    return {"ok": True, "fr": fr, "to": to, "type": t, "usdB": usd, "usdBLow": lo, "usdBHigh": hi, "per": per,
            "perFixed": per_fixed, "newNodes": names,
            "how": {"a": [pt.get("a"), A, ha], "b": [pt.get("b"), B, hb], "from": [m.get("from"), F, hf], "to": [m.get("to"), T, ht]}}


def num_conf(e: dict) -> float:
    """How much we trust the NUMBER on an edge (edge conf is about the tie). Real numbers ≥ 0.7; a researched
    estimate at most 0.55, a bulk estimate at most 0.45; one the sanity pass had to pull back is halved."""
    m = e.get("money") or {}
    if m.get("usdB") is None:
        return 0.0
    c = e.get("conf") if e.get("conf") is not None else 0.4
    if not m.get("est") and not e.get("est") and not e.get("inferred"):
        return max(c, 0.7)
    c = min(c, 0.45 if str(e.get("batch") or "").startswith("bulk") else 0.55)
    return c * 0.5 if (e.get("sanity") or {}).get("fixed") else c


def apply_scout(edges: list[dict], resolve: Resolver, stats: Counter, pnodes: dict | None = None,
                outcomes: list | None = None) -> list[dict]:
    """侦察兵 'gap' results (scout/out/graph_patches.json + graph/patches_extra.json) → the graph.
    - names are normalised (Resolver.place): 'GINKGO BIOWORKS (DNA)'→DNA, 'GOOGLE'→GOOGL, 'S:DNA'→DNA, unknown → p:slug
    - a disclosed (est:false) number is never overwritten; the scout's number rides along in `alt`
    - an estimate is replaced when the scout's number is about as trustworthy (sourced: conf ≥ num_conf − 0.1)
    - a scout number within ±25 % of the existing estimate corroborates it (sources attached, conf +0.05)
    - a recurring flow vs a one-off between the same two is a different flow → its own edge
    - nothing to attach to → a new edge (and new private nodes for p:slugs)"""
    patches = load_patches()
    pnodes = pnodes if pnodes is not None else {}
    outcomes = outcomes if outcomes is not None else []
    idx = defaultdict(list)

    def index(i, e):
        p, q = payer_payee(e)
        if p and q:
            idx[(p, q)].append(i)
    for i, e in enumerate(edges):
        index(i, e)
    for pt in patches:
        if not isinstance(pt, dict) or not isinstance(pt.get("money"), dict):
            continue
        n = normalize_patch(pt, resolve)
        rec = {"key": pt.get("key"), "taskId": pt.get("taskId"), "at": pt.get("at"), "how": n.get("how")}
        if not n["ok"]:
            stats["scout_unresolved"] += 1
            log(f"  · scout patch skipped ({n['why']}): {pt.get('key')}")
            outcomes.append({**rec, "action": "unresolved", "why": n["why"]})
            continue
        fr, to, usd = n["fr"], n["to"], n["usdB"]
        rec.update({"from": fr, "to": to, "usdB": usd, "per": n["per"]})
        if n["perFixed"]:
            rec["perFixed"] = f"{n['perFixed']}→{n['per']}"
            stats["scout_per_fixed"] += 1
        for i, nm in n["newNodes"].items():
            if i not in pnodes and (i.startswith("p:") or not (U and U.known(i))):
                pnodes[i] = {"name": nm, "note": "侦察兵查到的新名字", "listed": None}
                resolve.ids.add(i)
                stats["scout_new_node"] += 1
        m = pt["money"]
        verified = pt.get("est") is False
        pconf = num(pt.get("conf")) or 0.3
        srcs = [s for s in (pt.get("sources") or []) if isinstance(s, str)]
        newm = {"from": fr, "to": to, "usdB": usd, "usdBLow": n["usdBLow"], "usdBHigh": n["usdBHigh"],
                "per": n["per"], "what": m.get("what"), "est": not verified,
                "source": "侦察兵：" + "；".join(srcs[:2]) if srcs else "侦察兵", "asOf": pt.get("asOf"),
                "basis": pt.get("basis") if not verified else None}
        if n["perFixed"]:
            newm["perText"] = f"侦察兵写的是每年，但它自己的说法是{PER_LABEL.get(n['per'], '累计')}的钱，按{PER_LABEL.get(n['per'], '累计')}算"
        newm = {k: v for k, v in newm.items() if v is not None}
        scout = {"taskId": pt.get("taskId"), "at": pt.get("at"), "conf": pconf, "sources": srcs[:5]}
        alt = {"usdB": usd, "per": newm.get("per"), "est": not verified, "source": newm["source"], "batch": "scout", "conf": pconf}
        hits = [i for i in idx.get((fr, to), []) if edges[i]["type"] != "competes" and not edges[i].get("_removed")]
        # the same tie with a number in a different rhythm (yearly vs one-off) is a different flow
        rhythm = lambda per: "r" if per in RECUR else "o"
        same = [i for i in hits if (edges[i].get("money") or {}).get("usdB") is None
                or rhythm((edges[i].get("money") or {}).get("per")) == rhythm(n["per"])]
        action = None
        if hits and not same and pconf >= 0.4:
            action = "separate"
        elif same or hits:
            pool = same or hits
            i = min(pool, key=lambda j: (-num_conf(edges[j]) if (edges[j].get("money") or {}).get("usdB") is not None else 1, -quality(edges[j])))
            e = edges[i]
            em = e.get("money") or {}
            real = em.get("usdB") is not None and not em.get("est") and not e.get("est")
            old = em.get("usdB")
            close = old is not None and rhythm(em.get("per")) == rhythm(n["per"]) and \
                abs(usd * (ANNUAL.get(n["per"]) or 1) - old * (ANNUAL.get(em.get("per")) or 1)) <= 0.25 * max(old * (ANNUAL.get(em.get("per")) or 1), 1e-9)
            if real:
                if not close:
                    e.setdefault("alt", []).append(alt)
                else:
                    e.setdefault("scoutChecked", []).append(scout)
                stats["scout_kept_real"] += 1
                action = "kept_real" if not close else "corroborated_real"
            elif old is not None and not verified and pconf < round(num_conf(e) - (0.1 if srcs else 0.0), 3):
                if close:
                    e["scout"] = scout
                    e["conf"] = round(min(0.95, (e.get("conf") or 0.5) + 0.05), 2)
                    lo2 = [x for x in (em.get("usdBLow"), n["usdBLow"]) if x is not None]
                    hi2 = [x for x in (em.get("usdBHigh"), n["usdBHigh"]) if x is not None]
                    if lo2 and hi2 and em.get("per") == n["per"]:
                        e["money"] = {**em, "usdBLow": min(lo2), "usdBHigh": max(hi2)}
                        e["money"].pop("rangeAuto", None)
                    stats["scout_corroborated"] += 1
                    action = "corroborated"
                else:
                    # a shakier scout guess does not replace a researched estimate — it rides along as an alternative
                    e.setdefault("alt", []).append(alt)
                    stats["scout_kept_estimate"] += 1
                    action = "kept_estimate"
            else:
                if old is not None:
                    e.setdefault("alt", []).append({"usdB": old, "per": em.get("per"), "est": em.get("est"),
                                                    "source": em.get("source") or e.get("source"), "batch": e.get("batch")})
                e["money"] = newm
                e["scout"] = scout
                if pt.get("say") and (not e.get("say") or old is None):
                    e["say"] = pt["say"]
                if pt.get("share") and isinstance(pt["share"], dict) and (pt["share"].get("ofTo") or pt["share"].get("ofFrom")):
                    e["share"] = {**(e.get("share") or {}), **{k: v for k, v in pt["share"].items() if v}}
                if verified:
                    e["est"] = False
                    e.pop("inferred", None)
                    e.pop("basis", None)
                elif pt.get("basis"):
                    e["basis"] = pt["basis"]
                e["conf"] = round(max(e.get("conf") or 0, pconf), 2)
                stats["scout_applied"] += 1
                action = "applied"
            rec["edge"] = f"{e['a']}>{e['b']}:{e['type']}"
        if action in (None, "separate"):
            t = n["type"]
            if t not in ("buys-from", "sells-to", "invests-in", "finances", "licenses", "partner"):
                t = "buys-from"
            a, b = (fr, to) if t in ("buys-from", "invests-in", "finances", "partner") else (to, fr)
            ne = {"a": a, "b": b, "type": t, "money": newm, "share": pt.get("share") if isinstance(pt.get("share"), dict) and
                  (pt["share"].get("ofTo") or pt["share"].get("ofFrom")) else None, "strength": 2 if usd >= 1 else 1,
                  "since": None, "asOf": pt.get("asOf"), "conf": round(pconf, 2), "source": "scout",
                  "est": not verified, "basis": pt.get("basis") or "侦察兵估算", "say": pt.get("say"),
                  "batch": "scout", "scout": scout, "_deep": False}
            if action == "separate":
                ne["_sep"] = True
            edges.append(ne)
            index(len(edges) - 1, ne)
            stats["scout_added"] += 1
            action = action or "added"
            rec["edge"] = f"{a}>{b}:{t}"
        rec["action"] = action
        outcomes.append(rec)
    return edges


def apply_overrides(edges: list[dict], resolve: Resolver, stats: Counter):
    """web/data/overrides.json (§14 我来补): targets 'edge:A>B' (fields money.usdB | usdB | money | money.usdBLow |
    money.usdBHigh | money.per | money.what | say | type | strength | conf | remove | edge) and node targets
    ('graph:T', 's:T', 'T', 'p:x') with fields name | note | take. Owner entries beat everything; others only
    fill estimated / missing numbers. Returns (edges, node_patches)."""
    try:
        sys.path.insert(0, str(ROOT / "pipeline"))
        from owner_overrides import effective, load  # noqa: E402
        eff = effective(load(OVERRIDES))
    except Exception as ex:  # no file / broken file → nothing to apply
        raw = read_json(OVERRIDES, []) or []
        lst = raw if isinstance(raw, list) else (raw.get("overrides") or [])
        eff = {(str(x.get("target")), str(x.get("field"))): x for x in lst if isinstance(x, dict) and x.get("target") and x.get("field")}
        if lst:
            log(f"  ! owner_overrides import failed ({ex}); applied raw entries")
    node_patch: dict[str, dict] = defaultdict(dict)
    for (target, field), x in sorted(eff.items(), key=lambda kv: str(kv[1].get("at") or "")):
        owner = (x.get("source") or "owner") == "owner"
        who = "你补的" if owner else ("侦察兵查到的" if x.get("source") == "scout" else "修正")
        v = x.get("value")
        if target.startswith("edge:"):
            mm = re.match(r"^edge:(.+?)>(.+)$", target)
            if not mm:
                continue
            A, B = resolve(mm.group(1)) or norm_id(mm.group(1)), resolve(mm.group(2)) or norm_id(mm.group(2))
            if field == "edge" and isinstance(v, dict) and owner:
                ne = clean_edge({**v, "a": v.get("a") or A, "b": v.get("b") or B, "source": v.get("source") or "主人补充"}, "owner", True, Counter())
                if ne:
                    ne.update({"owner": True, "fixedBy": who, "conf": max(ne.get("conf") or 0, 0.9)})
                    edges.append(ne)
                    stats["override_edge_added"] += 1
                continue
            cands = []
            for a, b in ((A, B), (B, A)):
                cands = [i for i, e in enumerate(edges) if e["a"] == a and e["b"] == b
                         and (not x.get("type") or x["type"] == e["type"]) and (e["type"] != "competes" or field in ("remove", "say", "strength", "conf"))]
                if cands:
                    break
            if not cands:
                stats["override_unmatched"] += 1
                continue
            i = next((j for j in cands if edges[j].get("est") or (edges[j].get("money") or {}).get("est")), None)
            i = i if i is not None else next((j for j in cands if edges[j].get("money")), cands[0])
            e = edges[i]
            em = e.get("money") or {}
            is_est = e.get("est") or e.get("inferred") or em.get("est") or em.get("usdB") is None
            if not owner and not is_est:
                stats["override_kept_real"] += 1
                continue
            if field == "remove":
                if v not in (False, None, 0, "", "false"):
                    e["_removed"] = True
                    stats["override_removed"] += 1
                continue
            if field in ("money.usdB", "usdB", "money"):
                val = num(v.get("usdB") if isinstance(v, dict) else v)
                if val is None:
                    continue
                p, q = payer_payee(e)
                newm = {**em, "from": em.get("from") or p or e["a"], "to": em.get("to") or q or e["b"], "usdB": val,
                        "est": False, "source": f"{who}：{x.get('note') or '（没写出处）'}"}
                if isinstance(v, dict):
                    for k in ("per", "what", "usdBLow", "usdBHigh"):
                        if v.get(k) is not None:
                            newm[k] = v[k]
                if not (isinstance(v, dict) and (v.get("usdBLow") is not None)):
                    newm.pop("usdBLow", None)
                    newm.pop("usdBHigh", None)
                newm.pop("basis", None)
                e["money"] = newm
                e.update({"est": False, "owner": owner, "fixedBy": who, "fixKey": target, "conf": max(e.get("conf") or 0, 0.9)})
                e.pop("inferred", None)
                e.pop("basis", None)
            elif field.startswith("money.") and e.get("money"):
                e["money"] = {**e["money"], field[6:]: v}
                e.update({"owner": owner, "fixedBy": who})
            elif field in ("say", "sayMild", "what"):
                e[field] = v
            elif field == "type" and v in TYPES:
                e["type"] = v
            elif field in ("strength", "conf") and num(v) is not None:
                e[field] = num(v)
            else:
                continue
            stats["override_applied"] += 1
        elif field in ("name", "note", "take", "takeMild"):
            tid = target[6:] if target.startswith("graph:") else target
            nid = resolve(tid) or norm_id(tid)
            if nid and (owner or field not in ("name",)):
                node_patch[nid][field] = v
                stats["override_node"] += 1
    return [e for e in edges if not e.get("_removed")], node_patch


# ════════════════════════════ period repair (§14): one-off / cumulative / stake money written as "per year" ════════════════════════════
# Research batches (bulk-2 above all) wrote stakes, loans and investment totals as `per:"year"`: Toyota's "累计投资 Joby"
# 8.94 亿, PIF's "多轮注资" into Lucid, Apple's "预付款 + 入股" into Globalstar, a DOE loan to Rivian. Counted as yearly
# money they swell the payee's flows.inB (Rivian 76 亿/yr vs 59 亿 revenue) and the edge widths. So for invests-in /
# finances / partner ties a yearly number is re-read from its own words: recurring words (分红 / 分成 / 佣金 / 租金 …)
# keep it yearly; 累计 / 多轮 → total, 持有 / 持股 / 按市值 → stake, 贷款 / 额度 → commitment, 预付 / 入股 / 投资 / 收购 → once;
# a "yearly" number bigger than the payee's whole revenue that none of this explains → total. A wholly-owned
# subsidiary's money (Athene → Apollo, consolidated since 2022) is group-internal: the tie stays, the amount goes.
PERIOD_TYPES = ("invests-in", "finances", "partner")
RECUR_WORDS_RX = re.compile(r"分红|分派|股息|派息|权益收益|权益法|利润|分成|分润|分账|佣金|(?<!消)费|版税|租金|利息|激励|赞助|奖金|会员|订阅|"
                            r"采购|年化|每年|年均|逐年|按年|每月|每季|前向流|流购|销售|收入|抵免|催缴|分摊")
TOTAL_WORDS_RX = re.compile(r"累计|合计(?!\s*(约|占)?\s*\d+(\.\d+)?\s*%)|多轮|总额")
STAKE_WORDS_RX = re.compile(r"(?<!不)持有|持股|股份|按市值|市值估算|账面")
LOAN_WORDS_RX = re.compile(r"贷款|额度|授信")
BALANCE_WORDS_RX = re.compile(r"余额")
ONCE_WORDS_RX = re.compile(r"预付|一次性|入股|注资|收购|投资|融资|买下|换股|认购|出资")
INTRA_RX = re.compile(r"全资子公司|全资拥有|wholly[- ]owned|并表子公司")
PER_LABEL = {"total": "累计", "stake": "持股市值", "commitment": "承诺额度", "once": "一次性"}


def period_of(e: dict, rev_of) -> tuple[str | None, str]:
    """What a yearly invests-in / finances / partner number really is → (new per | 'intra' | None, the word that says so)."""
    m = e.get("money") or {}
    what = str(m.get("what") or "")
    basis = " ".join(str(x or "") for x in (m.get("basis"), e.get("basis")))
    if (x := INTRA_RX.search(what + " " + basis)):
        return "intra", x.group(0)
    if (x := TOTAL_WORDS_RX.search(what)) and not YEARLY_RX.search(what):
        return "total", x.group(0)
    if RECUR_WORDS_RX.search(what) or RECUR_WORDS_RX.search(basis):
        return None, ""
    for rx, per, txt in ((STAKE_WORDS_RX, "stake", what + " " + basis), (LOAN_WORDS_RX, "commitment", what),
                         (BALANCE_WORDS_RX, "total", what + " " + basis), (ONCE_WORDS_RX, "once", what)):
        if (x := rx.search(txt)):
            return per, x.group(0)
    R = rev_of(m.get("to"))
    k = ANNUAL.get(m.get("per")) or 1
    if R and m.get("usdB") is not None and m["usdB"] * k > PAYEE_MAX * R:
        return "total", f"比对方一年收入 {yi(R)}还大"
    return None, ""


def fix_periods(edges: list[dict], stats: Counter) -> list[dict]:
    """Re-label one-off / cumulative / stake amounts that were written per year; drop group-internal money.
    Owner corrections are never touched. → the list of what changed (for graph/sanity_report.json)."""
    fund = (read_json(FUND, {}) or {}).get("items") or {}

    def rev_of(i):
        r = (fund.get(i) or {}).get("revB") if i else None
        return r if r and r > 0 else None
    changed = []
    for e in edges:
        m = e.get("money") or {}
        if e.get("owner") or e["type"] not in PERIOD_TYPES or m.get("usdB") is None or m.get("per") not in RECUR:
            continue
        per, kw = period_of(e, rev_of)
        if not per:
            continue
        base = {"id": f"{e['a']}>{e['b']}:{e['type']}", "from": m.get("from"), "to": m.get("to"), "usdB": m["usdB"],
                "per": m.get("per"), "est": bool(m.get("est") or e.get("est")), "conf": e.get("conf"), "batch": e.get("batch"),
                "what": str(m.get("what") or "")[:60], "revB_to": rev_of(m.get("to")), "spendB_from": None, "ratio": 0,
                "fixed": True, "severity": 2}
        if per == "intra":
            why = f"「{kw}」：集团内部的钱（母公司合并报表），不是外面流进来的收入，金额不计入资金流"
            e["money"] = {k2: v for k2, v in m.items() if k2 not in ("usdBLow", "usdBHigh", "rangeAuto")}
            e["money"].update({"usdB": None, "per": None})
            e["intraGroup"] = True
            e["moneyDropped"] = {"usdB": m["usdB"], "per": m.get("per"), "why": why}
            e["basis"] = (e.get("basis") or m.get("basis") or "按公开信息推算") + f"（{why}）"
            e["money"]["basis"] = e["basis"]
            stats["period_intra"] += 1
            changed.append({**base, "flag": "intra-group", "now": None, "why": why})
            continue
        label = PER_LABEL[per]
        why = f"原写成每年，按文字「{kw}」看是{label}金额，不是每年都在流的钱"
        e["money"] = {**m, "per": per, "perFixed": m.get("per"), "est": True}
        e["money"]["basis"] = (m.get("basis") or e.get("basis") or "按公开信息推算") + f"（{why}，已改记为{label}）"
        e["est"] = True
        if not e.get("basis"):
            e["basis"] = e["money"]["basis"]
        stats["period_fixed"] += 1
        changed.append({**base, "flag": "per-fixed", "now": m["usdB"], "perNow": per, "why": why})
    return changed


# ════════════════════════════ money sanity pass (§14 estimates must stay plausible, §15 'verify') ════════════════════════════
SANITY_TYPES = ("buys-from", "sells-to", "licenses", "partner", "invests-in", "finances")
INFLOW_TYPES = ("buys-from", "sells-to", "licenses", "partner")      # money that is the payee's revenue
PAYEE_MAX = 1.0        # one customer paying more than the payee's whole yearly revenue → absurd
PAYEE_FIX = 1.25       # … but only squeezed above 1.25× (TTM revenue lags a growing payee; 1.0–1.25× is only reported)
SINGLE_SOURCE_X = 1.15  # a crowd payer (p:us-renters → a REIT) up to 1.15× revenue: that crowd IS the revenue → set to it
YOUNG_DAYS = 400       # a payee listed fewer days ago than this has no full trailing year of revenue
YOUNG_NOTE_RX = re.compile(r"合并而成|合并后|新合并|刚合并|分拆|拆分上市|刚上市|新上市|借壳")
RENT_RX = re.compile(r"租金|房租|收租|rent", re.I)   # a REIT's rent from its crowd of tenants: single-source revenue
DEAL_CAP_X = 1.5       # an investment / stake / deal > 1.5× the payee's market value (premium + debt explain up to ~1.5×)
PAYER_MAX = 1.5        # one supplier getting 1.5× the payer's TTM revenue + capex → absurd (TTM lags hypergrowth
                       # buyers: Nebius' 2026 capex guide is 2× its trailing capex)
PRE_REVENUE_B = 0.1    # a payee with < $100M revenue and a flow ≥ 10× it: a future contract, not today's money
PAYEE_BIG, PAYER_BIG = 0.6, 0.35    # big but possible: only reported
CONTRACT_X = 8.0       # a one-off / contract total > 8× the payee's yearly revenue: reported
INFLOW_X, INFLOW_TO = 1.5, 1.2   # all named customers together > 1.5× the payee's revenue → estimates scaled to fit 1.2×


def sanity_pass(edges: list[dict], stats: Counter, prior: dict | None = None, write: bool = True,
                periods: list[dict] | None = None) -> dict:
    """Compare every money edge with the two companies' scale (graph/fundamentals.json, yfinance TTM).
    Absurd ESTIMATES (> 1.25× the payee's revenue, > 1.5× the payer's spend) are pulled back into range (number ≤ half
    the payee's revenue / 30 % of the payer's spend, a crowd payer 90 %; range widened, conf lowered, `sanity.was`
    keeps the old numbers). 1.0–1.25× is within how far a TTM revenue lags a growing payee: only reported — except a
    crowd payer up to 1.15× (the renters of a REIT ARE its revenue), which is set to the revenue. A payee whose TTM
    revenue is partial (a fresh listing, < 4 reported quarters, a recent merger — universe note 「合并而成」) is never
    squeezed, only reported. Absurd DISCLOSED numbers are not changed — usually a multi-year contract written as
    'per year' — they are flagged for verification (lower conf). Owner corrections are never touched.
    Writes graph/sanity_report.json (+ `periods`: what fix_periods re-labelled)."""
    fund = (read_json(FUND, {}) or {}).get("items") or {}
    today = datetime.now().date()

    def scale(i):
        r = fund.get(i) or {}
        rev = r.get("revB")
        return (rev if rev and rev > 0 else None), ((rev or 0) + (r.get("capexB") or 0)) if rev and rev > 0 else None

    def young(i) -> str | None:
        """Why this payee's TTM revenue is not a full year of the company as it is now (None when it is)."""
        r = fund.get(i) or {}
        nq = r.get("nq")
        if isinstance(nq, int) and nq < 4:
            return f"收钱方的财报才 {nq} 个季度，过去 12 个月的收入不全"
        ft = str(r.get("firstTrade") or "")
        if ft:
            try:
                if (today - datetime.fromisoformat(ft).date()).days < YOUNG_DAYS:
                    return f"收钱方 {ft} 才上市，还没有一整年的收入"
            except ValueError:
                pass
        for d in ((U.cur, U.fm) if U else ()):
            note = str((d.get(i) or {}).get("note") or "")
            if (x := YOUNG_NOTE_RX.search(note)):
                return f"收钱方是「{note.strip()}」，过去 12 个月的收入还没把{x.group(0)[:2]}后的公司算全"
        return None

    items = []
    out_sum: dict[str, float] = defaultdict(float)
    in_sum: dict[str, Counter] = defaultdict(Counter)
    for e in edges:
        m = e.get("money") or {}
        u = m.get("usdB")
        if u is None or e["type"] not in SANITY_TYPES:
            continue
        fr, to = m.get("from"), m.get("to")
        k = ANNUAL.get(m.get("per"))
        est = bool(m.get("est") or e.get("est") or e.get("inferred"))
        R, _ = scale(to)
        _, S = scale(fr)
        base = {"id": f"{e['a']}>{e['b']}:{e['type']}", "from": fr, "to": to, "usdB": u, "per": m.get("per"),
                "est": est, "conf": e.get("conf"), "batch": e.get("batch"), "what": str(m.get("what") or "")[:60],
                "revB_to": R, "spendB_from": S}
        if k:
            annual = u * k
            out_sum[fr] += annual
            rp = annual / R if R else 0
            # the payer side only for companies with real revenue: a loss-maker spends far more than it sells
            rs = annual / S if S and S >= 1.0 and annual >= 0.5 else 0
            if e.get("owner"):
                continue
            if e.get("checkedAt") and (rp > PAYEE_MAX or rs > PAYER_MAX):
                # a web-checked tie (CORRECTIONS 'note' / 'set'): the check holds; listed for the record only
                items.append({**base, "annualB": round(annual, 3), "flag": "checked", "ratio": round(max(rp, rs), 2),
                              "fixed": False, "severity": 0, "why": e.get("checkNote") or "已核对"})
                continue
            if rp > PAYEE_MAX or rs > PAYER_MAX:
                flag = "payee>rev" if rp >= rs else "payer>spend"
                why = (f"每年 {yi(annual)}，比收钱方一年总收入 {yi(R)}还多" if flag == "payee>rev"
                       else f"每年 {yi(annual)}，是付钱方一年收入加资本开支 {yi(S)}的 {rs:.1f} 倍")
                was = {x: m.get(x) for x in ("usdB", "usdBLow", "usdBHigh") if m.get(x) is not None}
                pre_rev = flag == "payee>rev" and R < PRE_REVENUE_B and annual >= 10 * R
                prev = e.get("sanity") or {}
                if prev and not prev.get("fixed"):          # already flagged by the pre-scout pass: report, don't touch twice
                    items.append({**base, "annualB": round(annual, 3), "flag": prev.get("flag") or flag, "ratio": round(max(rp, rs), 2),
                                  "fixed": False, "now": u, "why": prev.get("why"),
                                  "severity": prev.get("sev") or (1 if prev.get("flag") == "pre-revenue" else 3)})
                    continue
                if prev.get("fixed") and prev.get("flag") == "payee≈rev":   # set to the revenue already: nothing more to do
                    continue
                squeezable = est and e["type"] != "partner"
                payee_side = rp > PAYEE_MAX and rs <= PAYER_MAX          # only the payee's revenue is exceeded
                yng = young(to) if payee_side and squeezable and not pre_rev else None
                soft = payee_side and rp <= PAYEE_FIX                    # within how far a TTM revenue lags
                # partner money is often assets passing through, not a fee: report it, never squeeze it.
                # Same for a pre-revenue payee's future contract (Oklo ← Switch PPA).
                if est and pre_rev:
                    note = f"（对方现在一年收入才 {yi(R)}，这是未来合同的年化规模，不是今天已经在流的钱）"
                    if note not in str(m.get("basis") or ""):
                        m["basis"] = (m.get("basis") or e.get("basis") or "按公开信息推算") + note
                    e["conf"] = round(max(0.15, (e.get("conf") or 0.4) * 0.8), 2)
                    e["sanity"] = {"flag": "pre-revenue", "ratio": round(rp, 2), "fixed": False, "sev": 1,
                                   "why": why + "（对方还没什么收入，按未来合同看）"}
                    stats["sanity_prerevenue"] += 1
                    flag = "pre-revenue"
                elif squeezable and yng:
                    # VMRK (AvalonBay + Equity Residential): yfinance's TTM is one of the two — the edge's ~$6bn is right
                    e["sanity"] = {"flag": "payee-young", "ratio": round(rp, 2), "fixed": False, "sev": 1,
                                   "why": f"{why}（{yng}，没有压）"}
                    stats["sanity_young"] += 1
                    flag = "payee-young"
                elif squeezable and soft and is_private(fr) and rp <= SINGLE_SOURCE_X and RENT_RX.search(str(m.get("what") or "")):
                    # a crowd that is the payee's whole business (a REIT's renters): its money IS the revenue
                    sig = 3 if R / k >= 1 else 4
                    new = math.floor(R / k * 10 ** sig) / 10 ** sig
                    lo = min(m.get("usdBLow") if m.get("usdBLow") is not None else new * 0.9, new * 0.9)
                    e["money"] = {**m, "usdB": new, "usdBLow": round(lo, sig), "usdBHigh": round(max(new, min(u, m.get("usdBHigh") or u)), sig)}
                    e["money"].pop("rangeAuto", None)
                    why = f"每年 {yi(annual)}，比收钱方一年总收入 {yi(R)}多 {rp - 1:.0%}；这群付款人就是它的全部生意"
                    note = f"（{why}，按它的收入记）"
                    e["money"]["basis"] = (m.get("basis") or e.get("basis") or "按公开信息推算") + note
                    if e.get("basis"):
                        e["basis"] = e["basis"] + note
                    e["sanity"] = {"flag": "payee≈rev", "ratio": round(rp, 2), "was": was, "fixed": True, "sev": 1, "why": why}
                    stats["sanity_set_to_rev"] += 1
                    flag = "payee≈rev"
                elif squeezable and soft:
                    e["sanity"] = {"flag": "payee≈rev", "ratio": round(rp, 2), "fixed": False, "sev": 1,
                                   "why": why + f"（只多 {rp - 1:.0%}，收入在涨时过去 12 个月的数会落后，没有压）"}
                    stats["sanity_soft"] += 1
                    flag = "payee≈rev"
                elif squeezable:
                    caps, highs = [], []
                    # a crowd of customers / suppliers (p:us-renters, p:re-agents…) can be nearly all of it; one company not
                    if rp > PAYEE_FIX:
                        crowd = is_private(fr)
                        caps.append((0.9 if crowd else 0.5) * R)
                        highs.append((1.0 if crowd else 0.9) * R)
                    if rs > PAYER_MAX:
                        crowd = is_private(to)
                        caps.append((0.9 if crowd else 0.6) * S)
                        highs.append(1.0 * S)
                    new = min(caps) / k
                    hi = min(min(highs) / k, max(u, m.get("usdBHigh") or u))
                    lo = min(m.get("usdBLow") if m.get("usdBLow") is not None else new * 0.5, new * 0.5)
                    sig = 3 if new >= 1 else 4
                    e["money"] = {**m, "usdB": round(new, sig), "usdBLow": round(lo, sig), "usdBHigh": round(max(hi, new), sig)}
                    e["money"].pop("rangeAuto", None)
                    note = f"（原估{yi(u)}{PER_ZH.get(m.get('per'), '')}，{why}，已压回合理范围）"
                    e["money"]["basis"] = (m.get("basis") or e.get("basis") or "按公开信息推算") + note
                    if e.get("basis"):
                        e["basis"] = e["basis"] + note
                    e["conf"] = round(max(0.15, (e.get("conf") or 0.4) * 0.6), 2)
                    e["sanity"] = {"flag": flag, "ratio": round(max(rp, rs), 2), "was": was, "fixed": True, "why": why}
                    stats["sanity_fixed"] += 1
                elif est:
                    e["sanity"] = {"flag": flag, "ratio": round(max(rp, rs), 2), "fixed": False,
                                   "why": why + "（合作方之间过手的资金，不一定是对方收入，没有压）"}
                    stats["sanity_flagged_partner"] += 1
                else:
                    e["sanity"] = {"flag": flag, "ratio": round(max(rp, rs), 2), "fixed": False,
                                   "why": why + "——可能是多年合同总额被写成每年，待核实"}
                    e["conf"] = round(max(0.3, (e.get("conf") or 0.6) - 0.15), 2)
                    stats["sanity_flagged_real"] += 1
                fixed = bool((e.get("sanity") or {}).get("fixed"))
                items.append({**base, "annualB": round(annual, 3), "flag": flag, "ratio": round(max(rp, rs), 2),
                              "fixed": fixed, "now": e["money"].get("usdB"), "why": (e.get("sanity") or {}).get("why"),
                              "severity": (e.get("sanity") or {}).get("sev") or (2 if fixed else (1 if flag == "pre-revenue" else 3))})
            elif (rp > PAYEE_BIG or rs > PAYER_BIG) and not (e.get("sanity") or {}).get("fixed") \
                    and not is_private(fr) and not is_private(to):      # a crowd of renters paying ~all the rent is normal
                items.append({**base, "annualB": round(annual, 3), "flag": "big-share", "ratio": round(max(rp, rs), 2),
                              "fixed": False, "severity": 1})
                stats["sanity_big"] += 1 if write else 0
        elif e["type"] in ("invests-in", "finances") and not e.get("owner"):
            # a stake / loan / investment total vs the payee's revenue says nothing (start-ups raise many times their
            # sales); vs its market value it does: more than the whole company is worth → reported
            cap = (fund.get(to) or {}).get("capB")
            if cap and u > DEAL_CAP_X * cap and m.get("per") != "commitment":     # a loan line may exceed the equity
                items.append({**base, "flag": "deal>cap", "ratio": round(u / cap, 2), "capB_to": cap, "fixed": False, "severity": 1,
                              "why": f"{yi(u)}{PER_ZH.get(m.get('per'), '')}，比收钱方现在的市值 {yi(cap)}还大"})
                stats["sanity_dealcap"] += 1 if write else 0
        elif R and u > CONTRACT_X * R and not e.get("owner"):
            items.append({**base, "flag": "contract>8x-rev", "ratio": round(u / R, 2), "fixed": False, "severity": 1})
            stats["sanity_contract"] += 1 if write else 0
    # one payer's recurring outflows together vs what it spends in a year
    totals = []
    for fr, tot in out_sum.items():
        _, S = scale(fr)
        if S and tot > 0.8 * S:
            totals.append({"from": fr, "annualOutB": round(tot, 2), "spendB": round(S, 2), "ratio": round(tot / S, 2)})
    # one payee's recurring inflows together vs its revenue: estimates of one company's customers that add up to
    # far more than it sells (often the same GPUs counted at the cloud AND at the server maker) are scaled down together
    in_totals = []
    for e in edges:
        m = e.get("money") or {}
        k = ANNUAL.get(m.get("per"))
        if m.get("usdB") is None or not k or e["type"] not in INFLOW_TYPES:    # financing / stakes are not revenue
            continue
        c = in_sum[m.get("to")]
        c["est" if (m.get("est") or e.get("est") or e.get("inferred")) else "real"] += m["usdB"] * k
        c["n"] += 1
    for to, c in in_sum.items():
        R, _ = scale(to)
        tot = c["est"] + c["real"]
        if not R or tot <= INFLOW_X * R:
            continue
        f, nsc = None, 0
        if c["est"] > 0 and c["real"] < INFLOW_TO * R:
            f = max(0.3, (INFLOW_TO * R - c["real"]) / c["est"])
            for e in edges:
                m = e.get("money") or {}
                if m.get("to") != to or m.get("usdB") is None or not ANNUAL.get(m.get("per")) or e.get("owner") \
                        or e["type"] not in INFLOW_TYPES or e["type"] == "partner" or is_private(m.get("from") or ""):
                    continue
                if not (m.get("est") or e.get("est") or e.get("inferred")) or (e.get("sanity") or {}).get("fixed"):
                    continue
                was = {x: m.get(x) for x in ("usdB", "usdBLow", "usdBHigh") if m.get(x) is not None}
                sig = 3 if m["usdB"] * f >= 1 else 4
                e["money"] = {**m, "usdB": round(m["usdB"] * f, sig),
                              "usdBLow": round(min(m.get("usdBLow") or m["usdB"], m["usdB"]) * f * 0.8, sig),
                              "usdBHigh": round(max(m.get("usdBHigh") or m["usdB"], m["usdB"]), sig)}
                e["money"].pop("rangeAuto", None)
                why = f"估算的客户付款加起来每年 {yi(tot)}，是它一年收入 {yi(R)}的 {tot / R:.1f} 倍（同一批货多半在不同环节被算了两次）"
                note = f"（原估{yi(m['usdB'])}，{why}，按比例压到 {f:.0%}）"
                e["money"]["basis"] = (m.get("basis") or e.get("basis") or "按公开信息推算") + note
                e["conf"] = round(max(0.15, (e.get("conf") or 0.4) * 0.8), 2)
                e["sanity"] = {"flag": "inflows>rev", "ratio": round(tot / R, 2), "was": was, "fixed": True, "why": why}
                stats["sanity_scaled"] += 1
                nsc += 1
                items.append({"id": f"{e['a']}>{e['b']}:{e['type']}", "from": m.get("from"), "to": to, "usdB": was.get("usdB"),
                              "per": m.get("per"), "est": True, "conf": e.get("conf"), "batch": e.get("batch"),
                              "what": str(m.get("what") or "")[:60], "revB_to": R, "spendB_from": None, "flag": "inflows>rev",
                              "ratio": round(tot / R, 2), "fixed": True, "now": e["money"]["usdB"], "severity": 2})
        in_totals.append({"to": to, "annualInB": round(tot, 2), "estB": round(c["est"], 2), "realB": round(c["real"], 2),
                          "revB": round(R, 2), "ratio": round(tot / R, 2), "n": c["n"],
                          "scaledTo": round(f, 3) if f and nsc else None, "scaledEdges": nsc})
    if prior:                                   # the pre-scout pass: what it already fixed stays in the report
        have = {(x["id"], x["flag"]) for x in items}
        items += [x for x in prior.get("items") or [] if x.get("fixed") and (x["id"], x["flag"]) not in have]
    if periods:                                 # fix_periods: yearly money re-labelled as total / stake / once, or dropped
        have = {(x["id"], x["flag"]) for x in items}
        items += [x for x in periods if (x["id"], x["flag"]) not in have]
    items.sort(key=lambda x: (-x["severity"], -(x.get("annualB") or x["usdB"] or 0) * (x["ratio"] or 1)))
    rep = {"generatedAt": datetime.now().isoformat(timespec="seconds"), "fundamentals": len(fund),
           "known": sum(1 for v in fund.values() if v.get("revB")),
           "counts": dict(Counter(x["flag"] for x in items)), "items": items,
           "payerTotals": sorted(totals, key=lambda x: -x["ratio"]),
           "payeeTotals": sorted(in_totals, key=lambda x: -x["ratio"])}
    if not write:
        return rep
    try:
        write_json(SANITY_REPORT, rep)
    except OSError:
        pass
    if items:
        log(f"  sanity: {rep['counts']} (fixed {stats['sanity_fixed']} estimates, flagged {stats['sanity_flagged_real']} disclosed; "
            f"scale known for {rep['known']} companies)")
    return rep


# ════════════════════════════ measured ties from prices ════════════════════════════
def load_returns(asof: str | None):
    import numpy as np
    import pandas as pd
    close = None
    cal = None
    if PRICE_CACHE.exists():
        try:
            with open(PRICE_CACHE, "rb") as fh:
                c = pickle.load(fh)
            close = c["fields"]["Close"].copy()
            if "SPY" in close.columns:
                cal = close.index[close["SPY"].notna()]
        except Exception as e:
            log(f"  ! price cache unreadable ({e})")
    if FM_PRICES.exists():
        try:
            df = pd.read_parquet(FM_PRICES, columns=["date", "t", "c"])
            df["t"] = df["t"].astype(str)
            w = df.pivot_table(index="date", columns="t", values="c", aggfunc="last", observed=True)
            w.index = pd.DatetimeIndex(w.index)
            if close is None:
                close = w
            else:
                close.index = pd.DatetimeIndex(close.index)
                extra = [t for t in w.columns if t not in close.columns]
                close = close.join(w[extra], how="outer") if extra else close
        except Exception as e:
            log(f"  ! full-market prices unreadable ({e})")
    if close is None or close.empty:
        return None
    close = close.sort_index()
    if cal is not None:
        close = close.reindex(cal)                       # the trading calendar = SPY's dates (DESIGN §2)
    if asof:
        close = close[close.index <= pd.Timestamp(asof)]
    close = close.iloc[-(LEADLAG_WINDOW + 1):]
    rets = close.pct_change(fill_method=None).iloc[1:].clip(-0.5, 0.5)
    rets = rets.replace([np.inf, -np.inf], np.nan)
    return rets


def winsorize(R):
    """Clip each ticker's daily returns at median ± WINSOR_K robust sigmas (1.4826·MAD): one shared earnings day
    (MSFT +15% and MKTX +29% on the same date) must not make two unrelated stocks look like twins."""
    med = R.median()
    s = 1.4826 * (R - med).abs().median()
    s = s.where(s > 1e-6, R.std())
    return R.clip(med - WINSOR_K * s, med + WINSOR_K * s, axis=1)


def measured_ties(rets, pool: list[str], tied_pairs: set[tuple], same_co, asof: str, stats: Counter):
    import numpy as np
    out_co: dict[tuple, dict] = {}
    if rets is None or not pool:
        return [], []
    R = winsorize(rets[[t for t in pool if t in rets.columns]])
    R120 = R.iloc[-COMOVE_WINDOW:]
    ok = R120.columns[R120.notna().sum() >= COMOVE_MIN_OBS]
    R120 = R120[ok]
    C = R120.corr(min_periods=COMOVE_MIN_OBS)
    cols = list(C.columns)
    Cv = C.values
    nobs = R120.notna().astype(float)
    pos = {t: i for i, t in enumerate(cols)}
    tied_by = defaultdict(set)
    for a, b in tied_pairs:
        tied_by[a].add(b)
        tied_by[b].add(a)

    def add(a, b, r, why):
        k = tuple(sorted((a, b)))
        if k in out_co:
            out_co[k]["why"] = sorted(set(out_co[k]["why"]) | {why})
            return
        n = int((nobs[a] * nobs[b]).sum())
        out_co[k] = {"a": k[0], "b": k[1], "type": "comove", "corr": round(float(r), 2), "window": COMOVE_WINDOW, "n": n,
                     "asOf": asof, "est": False, "why": [why],
                     "source": f"价格测量：近 {COMOVE_WINDOW} 个交易日的日涨跌相关 {r:.2f}（极端单日已截尾）"}

    for t in cols:
        i = pos[t]
        row = Cv[i]
        order = np.argsort(-np.nan_to_num(row, nan=-9))
        took = 0
        for j in order:
            if j == i:
                continue
            r = row[j]
            if not np.isfinite(r) or r < COMOVE_MIN:
                break
            o = cols[j]
            if r >= SAME_CO_CORR and same_co(t, o):
                continue
            add(t, o, r, "top")
            took += 1
            if took >= COMOVE_TOP:
                break
        extra = 0
        for o in sorted(tied_by.get(t, ()), key=lambda o: -(Cv[i][pos[o]] if o in pos and np.isfinite(Cv[i][pos[o]]) else -9)):
            if o not in pos or extra >= COMOVE_TIED_EXTRA:
                continue
            r = Cv[i][pos[o]]
            if np.isfinite(r) and r >= COMOVE_MIN and tuple(sorted((t, o))) not in out_co:
                add(t, o, r, "tied")
                extra += 1
    stats["comove"] = len(out_co)

    # lead-lag on business-tied pairs + co-moving pairs. Daily lead-lag between US stocks is rare (prices adjust
    # within the day), so with ~50k tests plain thresholds only find noise: a tie is kept only when it survives
    # Benjamini–Hochberg FDR (q = LEADLAG_FDR) across ALL tests, shows up in both halves of the window, and
    # clearly beats the reverse direction. Zero results is an honest answer.
    RL = R.iloc[-LEADLAG_WINDOW:]
    good = set(RL.columns[RL.notna().sum() >= LEADLAG_MIN_OBS])
    cand = {tuple(sorted(p)) for p in tied_pairs if p[0] in good and p[1] in good} | {k for k in out_co if k[0] in good and k[1] in good}
    X = {t: RL[t].values for t in good}
    half = len(RL) // 2

    def xcorr(x, y, k, lo=0, hi=None):
        """corr(x[t-k], y[t]) over t in [lo+k, hi) — x leads y by k days"""
        hi = len(y) if hi is None else hi
        xs, ys = x[lo:hi - k], y[lo + k:hi]
        msk = np.isfinite(xs) & np.isfinite(ys)
        if msk.sum() < 40:
            return np.nan, 0
        xs, ys = xs[msk], ys[msk]
        sx, sy = xs.std(), ys.std()
        if sx <= 0 or sy <= 0:
            return np.nan, 0
        return float(((xs - xs.mean()) * (ys - ys.mean())).mean() / (sx * sy)), int(msk.sum())

    def p_one_sided(r, n):
        if not np.isfinite(r) or n < 10 or r >= 1:
            return 1.0
        t = r * math.sqrt((n - 2) / max(1e-12, 1 - r * r))
        try:
            from scipy.stats import t as tdist
            return float(tdist.sf(t, n - 2))
        except Exception:
            return 0.5 * math.erfc(t / math.sqrt(2))

    tests = []          # (p, r, lead, lag, k, n)
    rev = {}
    for a, b in sorted(cand):
        xa, xb = X[a], X[b]
        for k in LEADLAG_LAGS:
            for lead, lag, x, y in ((a, b, xa, xb), (b, a, xb, xa)):
                r, n = xcorr(x, y, k)
                if not np.isfinite(r):
                    continue
                rev[(lead, lag)] = max(rev.get((lead, lag), -1.0), r)
                tests.append((p_one_sided(r, n), r, lead, lag, k, n))
    tests.sort(key=lambda x: x[0])
    m = len(tests)
    cut = 0
    for j, tst in enumerate(tests, 1):
        if tst[0] <= LEADLAG_FDR * j / max(1, m):
            cut = j
    out_ll, done = [], set()
    for p, r, lead, lag, k, n in tests[:cut]:
        key = tuple(sorted((lead, lag)))
        if key in done or r < LEADLAG_MIN_R or r - rev.get((lag, lead), -1.0) < LEADLAG_MARGIN:
            continue
        r1, _ = xcorr(X[lead], X[lag], k, 0, half)
        r2, _ = xcorr(X[lead], X[lag], k, half, None)
        if not (np.isfinite(r1) and np.isfinite(r2) and r1 >= LEADLAG_HALF_MIN and r2 >= LEADLAG_HALF_MIN):
            continue
        done.add(key)
        out_ll.append({"a": lead, "b": lag, "lead": lead, "lag": lag, "type": "leadlag", "days": k, "corr": round(r, 2),
                       "halves": [round(r1, 2), round(r2, 2)], "p": float(f"{p:.2g}"), "window": len(RL), "n": n, "asOf": asof,
                       "est": False,
                       "source": f"价格测量：近 {len(RL)} 个交易日，{lead} 的涨跌常领先 {lag} 约 {k} 天（相关 {r:.2f}，"
                                 f"经 {m} 次检验的多重校正后仍显著，前后两半都成立）"})
    stats["leadlag_tested"] = len(cand)
    stats["leadlag"] = len(out_ll)
    return list(out_co.values()), out_ll


# ════════════════════════════ words (§12 voice; numbers exact, opinion is the sentence) ════════════════════════════
ANNUAL = {"year": 1, "quarter": 4, "month": 12}
PER_ZH = {"year": "一年", "quarter": "一季", "month": "一个月", "once": "（一次性）", "deal": "（一笔交易）", "total": "（累计）",
          "stake": "（持股）", "commitment": "（承诺额度）", "contract": "（合同总额）", "framework": "（框架协议）"}


def yi(usd_b: float) -> str:
    v = usd_b * 10  # 十亿美元 → 亿美元
    if v >= 100:
        return f"{v:,.0f} 亿美元".replace(",", "")
    if v >= 1:
        s = f"{v:.1f}".rstrip("0").rstrip(".")
        return f"{s} 亿美元"
    w = usd_b * 1e5  # → 万美元
    return f"{w:.0f} 万美元"


def amt(m: dict) -> str:
    """{'usdB': 30, 'per': 'year', 'est': True} → '一年约 300 亿美元'; a deal → '约 3000 亿美元（合同总额）'."""
    s = ("约 " if m.get("est") else "") + yi(m["usdB"])
    per = PER_ZH.get(m.get("per") or "", "")
    if per.startswith("（"):
        return s + per
    return f"{per}{s}" if per else s


def _size(x: dict) -> float:
    """Comparable size of a tie: recurring money per year; one-off deals / stakes / contracts count a fifth."""
    u = x.get("usdB") or 0
    return u * ANNUAL[x["per"]] if x.get("per") in ANNUAL else u / 5


def auto_take(name: str, doc: dict, names) -> tuple[list[str], list[str]]:
    """2–3 sentences for a company nobody wrote a take for — built only from the ties shown (§12/§13):
    the biggest money first (in or out, whichever is larger), then who backs it, then what the prices say."""
    sharp, mild = [], []
    me = doc["t"]
    down = sorted([x for x in doc["downstream"] if x.get("usdB")], key=_size, reverse=True)
    up = sorted([x for x in doc["upstream"] if x.get("usdB")], key=_size, reverse=True)
    backers = sorted([x for x in doc["partners"] if x.get("usdB") and x.get("payer") not in (None, me)
                      and set(x["types"]) & {"invests-in", "finances"}], key=_size, reverse=True)
    m_of = lambda x: {"usdB": x["usdB"], "per": x.get("per"), "est": x.get("est")}
    nm = lambda x: names(x["id"])

    def s_in():
        x = down[0]
        yearly = [d for d in down if d.get("per") in ANNUAL]
        tot = sum(_size(d) for d in yearly)
        if x.get("per") in ANNUAL and len(yearly) >= 2 and tot and _size(x) / tot >= 0.5:
            return (f"最大的金主是{nm(x)}，{amt(m_of(x))}往它这儿流——钱袋子太集中，{nm(x)}一咳嗽它就感冒。",
                    f"收入较依赖{nm(x)}（{amt(m_of(x))}）。")
        return f"给它送钱最多的是{nm(x)}：{amt(m_of(x))}。", f"已知最大的付款方是{nm(x)}，{amt(m_of(x))}。"

    def s_out():
        top = [x for x in up[:3] if _size(x) >= 0.3 * _size(up[0])]
        if len(top) >= 2:
            lst = "、".join(f"{nm(x)} {amt(m_of(x))}" for x in top)
            return f"钱主要花在：{lst}。", f"已知主要支出：{lst}。"
        x = up[0]
        return f"它最大一笔开销付给{nm(x)}：{amt(m_of(x))}。", f"已知最大的供应商是{nm(x)}，{amt(m_of(x))}。"

    parts = []
    if down:
        parts.append((_size(down[0]), s_in()))
    if up:
        parts.append((_size(up[0]), s_out()))
    for _, (a, b) in sorted(parts, key=lambda p: -p[0]):
        sharp.append(a)
        mild.append(b)
    if backers and len(sharp) < 3:
        x = backers[0]
        sharp.append(f"背后金主是{nm(x)}，砸了{amt(m_of(x))}。")
        mild.append(f"主要投资方是{nm(x)}（{amt(m_of(x))}）。")
    if not sharp:
        comp = [x for x in doc["competitors"] if not x.get("est")] or doc["competitors"]
        if comp:
            sharp.append(f"生意往来没人披露金额，最直接的对手是{nm(comp[0])}。")
            mild.append(f"往来金额没有披露，主要对手是{nm(comp[0])}。")
        elif doc["upstream"] or doc["downstream"] or doc["partners"]:
            x = (doc["downstream"] or doc["upstream"] or doc["partners"])[0]
            sharp.append(f"关系有，金额全没披露，先看它和{nm(x)}的往来。")
            mild.append(f"已知和{nm(x)}有往来，金额未披露。")
    co = sorted([m for m in doc["measured"] if m["type"] == "comove"], key=lambda m: -m["corr"])
    if co and len(sharp) < 3:
        o = [m["b"] if m["a"] == me else m["a"] for m in co[:2]]
        sharp.append(f"股价跟{'、'.join(names(i) for i in o)}穿一条裤子（相关 {co[0]['corr']:.2f}）。")
        mild.append(f"股价和{'、'.join(names(i) for i in o)}走势接近（相关 {co[0]['corr']:.2f}）。")
    ll = [m for m in doc["measured"] if m["type"] == "leadlag"]
    if ll and len(sharp) < 3:
        m = max(ll, key=lambda m: m["corr"])
        if m["lag"] == me:
            sharp.append(f"{names(m['lead'])}先动，它常隔 {m['days']} 天才跟上。")
            mild.append(f"它的涨跌常比{names(m['lead'])}晚约 {m['days']} 天。")
        else:
            sharp.append(f"它常先动，{names(m['lag'])}隔 {m['days']} 天才跟上。")
            mild.append(f"{names(m['lag'])}的涨跌常比它晚约 {m['days']} 天。")
    if not sharp:
        sharp.append(f"{name}的关系网还没人画过，先看地图上的同行。")
        mild.append(f"{name}的关系网暂未研究，可先参考同行。")
    return sharp[:3], mild[:3]


# ════════════════════════════ build ════════════════════════════
def build(args) -> dict:
    global U
    t0 = time.time()
    stats: Counter = Counter()
    U = Universe()
    meta = read_json(DATA / "meta.json", {}) or {}
    asof = meta.get("asOf")
    log(f"graph/build.py — asOf {asof}; curated {len(U.cur)} tickers ({len(U.etf)} funds), full-market {len(U.fm)}")

    files = sorted(RAW.glob("*.json"))
    if not files:
        log("  no graph/raw/*.json yet — nothing to build")
        return {}
    companies: dict[str, dict] = {}
    pnodes: dict[str, dict] = {}
    edges: list[dict] = []
    names: dict[str, set[str]] = defaultdict(set)
    bad = []
    for f in files:
        d = read_json(f)
        for _ in range(4):                       # a research agent may be writing this very file: give it a moment
            if isinstance(d, dict):
                break
            time.sleep(0.5)
            d = read_json(f)
        if not isinstance(d, dict):
            stats["raw_unreadable"] += 1
            bad.append(f.name)
            continue
        batch = str(d.get("batch") or f.stem)
        deep = not f.stem.startswith("bulk")
        stats["raw_files"] += 1
        for c in d.get("companies") or []:
            t = norm_id(c.get("t"))
            if not t:
                continue
            if c.get("name"):
                names[t].add(c["name"])
            cand = {"name": c.get("name"), "take": c.get("take"), "takeMild": c.get("takeMild"), "asOf": c.get("asOf") or d.get("asOf"),
                    "batch": batch, "_deep": deep}
            cur = companies.get(t)
            rank = lambda x: (bool(x.get("take")), x["_deep"], str(x.get("asOf") or ""), len(str(x.get("take") or "")))
            if cur is None or rank(cand) > rank(cur):
                companies[t] = cand
        for p in d.get("privateNodes") or []:
            i = norm_id(p.get("id"))
            if not i:
                continue
            if p.get("name"):
                names[i].add(p["name"])
            cur = pnodes.get(i, {})
            pnodes[i] = {"name": cur.get("name") or p.get("name"), "note": cur.get("note") or p.get("note"),
                         "listed": cur.get("listed") or p.get("listed")}
        for e in d.get("edges") or []:
            stats["raw_edges"] += 1
            ce = clean_edge(e, batch, deep, stats)
            if ce:
                edges.append(ce)
    log(f"  raw: {stats['raw_files']} files, {stats['raw_edges']} edges, {len(companies)} researched companies, {len(pnodes)} named extra nodes")
    if bad and not getattr(args, "allow_partial", False):
        # never publish a graph with a whole batch missing (and never delete its companies' files): keep the old one
        raise SystemExit(f"  ! unreadable raw file(s) {bad} — build aborted, web/data/graph left as it was (--allow-partial to force)")
    edges = apply_corrections(edges, stats)
    edges = reconcile(edges, stats)
    log(f"  reconciled: {len(edges)} edges ({stats['merged']} duplicates merged, {stats['drop_selfloop']} self-loops dropped)")
    periods = fix_periods(edges, stats)            # stakes / loans / investment totals written as "per year"
    if periods:
        log(f"  periods: {stats['period_fixed']} yearly numbers re-read as one-off / total / stake, "
            f"{stats['period_intra']} group-internal flows lost their amount")

    # every id we know a name for → resolver for scout / owner text (graph ids + search indexes + English names)
    all_ids = {e["a"] for e in edges} | {e["b"] for e in edges} | set(companies) | set(pnodes) | set(U.cur) | set(U.fm)
    resolve = make_resolver(names, all_ids)
    pre = sanity_pass(edges, stats, write=False)      # absurd estimates first, so a scout number can replace them
    outcomes: list[dict] = []
    edges = apply_scout(edges, resolve, stats, pnodes, outcomes)
    edges, node_patch = apply_overrides(edges, resolve, stats)
    edges = reconcile(edges, stats) if stats["scout_added"] or stats["override_edge_added"] else edges
    periods += fix_periods(edges, stats)           # what the scout / others added
    for e in edges:
        e.pop("_sep", None)
    LAST["outcomes"] = outcomes
    if outcomes and not getattr(args, "dry_run", False):
        write_json(PATCH_LOG, {"generatedAt": datetime.now().isoformat(timespec="seconds"), "patches": outcomes})

    # money sanity (§15 verify): an estimate bigger than the payee's whole revenue / the payer's whole spend is pulled back
    sanity = sanity_pass(edges, stats, prior=pre, write=not getattr(args, "dry_run", False), periods=periods)
    LAST["sanity"] = sanity
    if getattr(args, "dry_run", False):
        log(f"  dry run: scout {dict((k[6:], v) for k, v in stats.items() if k.startswith('scout_'))} — nothing written")
        return {}

    # §14: an estimated number without a range gets one (from its own confidence) — marked rangeAuto
    for e in edges:
        m = e.get("money")
        if m and m.get("usdB") is not None and (m.get("est") or e.get("est")) and (m.get("usdBLow") is None or m.get("usdBHigh") is None):
            s = min(0.5, max(0.2, 0.6 - 0.5 * (e.get("conf") or 0.5)))
            m["usdBLow"] = round(m["usdB"] * (1 - s), 4)
            m["usdBHigh"] = round(m["usdB"] * (1 + s), 4)
            m["rangeAuto"] = True
            stats["range_auto"] += 1
        if (e.get("est") or (m or {}).get("est")) and not e.get("basis") and not (m or {}).get("basis"):
            e["basis"] = "产业链逻辑推断" if e.get("inferred") else "按公开信息推算"

    lint_names(edges, companies, stats, pnodes)

    # ids, stable order, per-pair numbering
    edges.sort(key=lambda e: (e["a"], e["b"], e["type"], -quality(e)))
    seen = Counter()
    for e in edges:
        k = f"{e['a']}>{e['b']}:{e['type']}"
        seen[k] += 1
        e["id"] = k if seen[k] == 1 else f"{k}#{seen[k]}"
        e.pop("_deep", None)

    # ── nodes
    ids = sorted({e["a"] for e in edges} | {e["b"] for e in edges} | set(companies))

    def listed_of(i):
        if is_private(i):
            return "private"
        if i in U.cur or i in U.fm or i in U.fmraw:
            return "us"
        pl = (pnodes.get(i) or {}).get("listed")
        if pl in ("abroad", "delisted"):
            return pl
        return "abroad" if EXCH_SUFFIX.search(i) or re.match(r"^\d", i) else "us"

    def short(nm: str) -> str:
        """'苹果 Apple' → '苹果' (the map's style); names that are only Latin, or start Latin ('SK 海力士'), stay."""
        mm = re.match(r"^([\u2E80-\u9FFF·]{2,})\s+[A-Za-z][^\u2E80-\u9FFF]*$", nm)
        return mm.group(1) if mm else nm

    def name_of(i):
        if i in node_patch and node_patch[i].get("name"):
            return node_patch[i]["name"]
        if (U.cur.get(i) or {}).get("name"):
            return U.cur[i]["name"]
        for src in ((companies.get(i) or {}).get("name"), (pnodes.get(i) or {}).get("name"),
                    FOREIGN.get(i), (U.fm.get(i) or {}).get("name"), (U.fmraw.get(i) or {}).get("short")):
            if src:
                return short(src)
        # a foreign line folded into a US ticker keeps its Chinese name
        for k, v in ALIAS.items():
            if v == i and (pnodes.get(k) or {}).get("name"):
                return pnodes[k]["name"]
        return i[2:] if is_private(i) else i

    def note_of(i):
        if i in node_patch and node_patch[i].get("note"):
            return node_patch[i]["note"]
        return (U.cur.get(i) or {}).get("note") or (pnodes.get(i) or {}).get("note") or (U.fm.get(i) or {}).get("note")

    nodes = {}
    for i in ids:
        n = {"name": name_of(i), "note": note_of(i), "inUniverse": i in U.cur, "inFull": i in U.fm, "private": is_private(i),
             "listed": listed_of(i), "researched": bool((companies.get(i) or {}).get("take"))}
        nodes[i] = {k: v for k, v in n.items() if v is not None}

    # ── measured ties
    adj = defaultdict(list)
    for e in edges:
        adj[e["a"]].append(e)
        adj[e["b"]].append(e)
    comove, leadlag = [], []
    if not args.no_measured:
        t1 = time.time()
        rets = load_returns(asof)
        if rets is not None:
            have = set(rets.columns)
            pool = sorted({t for t in U.cur if t not in U.etf and t not in ALIAS} | {i for i in ids if not is_private(i) and i in have})
            pool = [t for t in pool if t in have]
            tied = {tuple(sorted((e["a"], e["b"]))) for e in edges if e["a"] in have and e["b"] in have and e["type"] != "competes"} \
                | {tuple(sorted((e["a"], e["b"]))) for e in edges if e["type"] == "competes" and e["a"] in have and e["b"] in have}

            def same_co(a, b):
                na = ((U.fmraw.get(a) or {}).get("short") or (U.cur.get(a) or {}).get("name") or a).lower()
                nb = ((U.fmraw.get(b) or {}).get("short") or (U.cur.get(b) or {}).get("name") or b).lower()
                return na == nb or a.split("-")[0] == b.split("-")[0] or a[:-1] == b or b[:-1] == a
            comove, leadlag = measured_ties(rets, pool, tied, same_co, asof, stats)
            log(f"  measured: pool {len(pool)} tickers → {len(comove)} comove pairs, {len(leadlag)} lead-lag "
                f"(of {stats['leadlag_tested']} pairs tested) in {time.time() - t1:.1f}s")
        else:
            log("  ! no price cache — measured ties skipped")
    elif getattr(args, "reuse_measured", False):
        prev = read_json(OUT / "edges.json", {}) or {}
        for m in prev.get("measured") or []:
            (comove if m.get("type") == "comove" else leadlag).append(m)
        stats["measured_reused"] = len(comove) + len(leadlag)
        log(f"  measured: reused {len(comove)} comove + {len(leadlag)} lead-lag from the last build")
    madj = defaultdict(list)
    for m in comove + leadlag:
        madj[m["a"]].append(m)
        madj[m["b"]].append(m)
    for i in list(madj):
        if i not in nodes:
            n = {"name": name_of(i), "note": note_of(i), "inUniverse": i in U.cur, "inFull": i in U.fm, "private": False,
                 "listed": listed_of(i), "researched": False}
            nodes[i] = {k: v for k, v in n.items() if v is not None}

    # ── per-company documents
    SCALE.clear()
    for t, r in ((read_json(FUND, {}) or {}).get("items") or {}).items():
        if r.get("revB") or r.get("capB"):
            SCALE[t] = {k: r[k] for k in ("revB", "capexB", "capB") if r.get(k) is not None} | {"at": str(r.get("at") or "")[:10], "src": "yfinance TTM"}
    gen = datetime.now().isoformat(timespec="seconds")
    OUT.mkdir(parents=True, exist_ok=True)
    written = set()
    index = []
    nm = lambda i: (nodes.get(i) or {}).get("name") or i
    docs = {}
    for i in sorted(set(adj) | set(madj)):
        doc = company_doc(i, adj.get(i, []), madj.get(i, []), nodes, companies, node_patch, asof, gen)
        if not doc["take"]:
            s, m = auto_take(doc["name"], doc, nm)
            ctx = {i} | {x["id"] for b in ("upstream", "downstream", "competitors", "partners") for x in doc[b]}
            doc["take"], doc["takeMild"], doc["takeAuto"] = NAMES.lint("".join(s), ctx), NAMES.lint("".join(m), ctx), True
        docs[i] = doc
        if write_json_if_changed(OUT / fname(i), doc):
            stats["files_rewritten"] = stats.get("files_rewritten", 0) + 1
        written.add(fname(i))
        index.append({"t": i, "name": doc["name"], "n": len(doc["edges"]), "m": len(doc["measured"]),
                      "researched": doc["researched"], "inUniverse": doc["inUniverse"], "private": doc["private"],
                      "listed": doc["listed"], "inB": doc["flows"]["inB"], "outB": doc["flows"]["outB"]})
    index.sort(key=lambda x: (not x["researched"], not x["inUniverse"], -x["n"], -x["m"], x["t"]))

    est_e = sum(1 for e in edges if e.get("est") or e.get("inferred") or (e.get("money") or {}).get("est"))
    st = {"edges": len(edges), "edgesEst": est_e, "withMoney": sum(1 for e in edges if (e.get("money") or {}).get("usdB") is not None),
          "nodes": len(nodes), "companiesResearched": sum(1 for c in companies.values() if c.get("take")),
          "inUniverse": sum(1 for n in nodes.values() if n.get("inUniverse")), "private": sum(1 for n in nodes.values() if n.get("private")),
          "comove": len(comove), "leadlag": len(leadlag), "files": len(written),
          "types": dict(Counter(e["type"] for e in edges)), "rawEdges": stats["raw_edges"], "merged": stats["merged"],
          "scout": {k[6:]: v for k, v in stats.items() if k.startswith("scout_")},
          "overrides": {k[9:]: v for k, v in stats.items() if k.startswith("override_")},
          "sanity": {k[7:]: v for k, v in stats.items() if k.startswith("sanity_")},
          "periods": {k[7:]: v for k, v in stats.items() if k.startswith("period_")}, "namesLinted": stats["name_linted"],
          "corrections": stats["corrected"]}
    comp_out = {}
    for t, c in companies.items():
        if not c.get("take"):
            continue
        take = node_patch.get(t, {}).get("take") or c["take"]
        comp_out[t] = {k: v for k, v in {"name": nodes.get(t, {}).get("name") or c.get("name"), "take": take,
                                          "takeMild": c.get("takeMild"), "asOf": c.get("asOf")}.items() if v}
    write_json(OUT / "edges.json", {"asOf": asof, "generatedAt": gen, "stats": st, "nodes": nodes, "companies": comp_out,
                                    "edges": edges, "measured": comove + leadlag})
    written.add("edges.json")
    write_json(OUT / "index.json", {"asOf": asof, "generatedAt": gen, "stats": st, "companies": index})
    written.add("index.json")
    stale = [p for p in OUT.glob("*.json") if p.name not in written]
    for p in stale:
        p.unlink()
    try:
        where = OUT.relative_to(ROOT)
    except ValueError:
        where = OUT
    log(f"  wrote {len(written)} files to {where} ({stats.get('files_rewritten', 0)} changed, {len(stale)} stale removed) "
        f"in {time.time() - t0:.1f}s")
    log(f"  edges {st['edges']} (est {est_e}, {100 * est_e / max(1, st['edges']):.0f}%), with money {st['withMoney']}, nodes {st['nodes']} "
        f"(on curated map {st['inUniverse']}, private {st['private']}), researched companies {st['companiesResearched']}")
    log(f"  types {st['types']}")
    if st["scout"] or st["overrides"]:
        log(f"  scout {st['scout']}  overrides {st['overrides']}")
    other = {k: v for k, v in stats.items() if k in ("est_defaulted", "money_dir_repaired", "type_fixed", "range_auto", "drop_noid")}
    log(f"  fixes {other}  corrections {stats['corrected']}")
    return docs


def company_doc(i, es, ms, nodes, companies, node_patch, asof, gen) -> dict:
    n = nodes.get(i) or {}
    c = companies.get(i) or {}
    buckets = {"upstream": {}, "downstream": {}, "competitors": {}, "partners": {}}
    order = {"upstream": 3, "downstream": 3, "partners": 2, "competitors": 1}
    pairs = defaultdict(list)
    for e in es:
        o = e["b"] if e["a"] == i else e["a"]
        pairs[o].append(e)
    flows = {"inB": 0.0, "outB": 0.0, "inEstB": 0.0, "outEstB": 0.0, "dealsInB": 0.0, "dealsOutB": 0.0}
    nb_nodes = {}
    for o, rels in pairs.items():
        best_role, best_rank, best_payer = None, (False, -1.0, -1, -1, -1.0), None
        roles = set()
        tot = 0.0
        per = None
        what = None
        for e in rels:
            payer, payee = payer_payee(e)
            m = e.get("money") or {}
            usd = m.get("usdB")
            if e["type"] == "competes":
                role = "competitors"
            elif e["type"] in ("partner", "invests-in", "finances"):
                role = "partners"
            elif payer == i:
                role = "upstream"
            elif payee == i:
                role = "downstream"
            else:
                role = "partners"
            roles.add(role)
            if usd is not None and payer in (i, o) and payee in (i, o):
                yearly = ANNUAL.get(m.get("per"))           # recurring money → per year; deals / stakes kept apart
                key = ("outB" if payer == i else "inB") if yearly else ("dealsOutB" if payer == i else "dealsInB")
                flows[key] += usd * (yearly or 1)
                if m.get("est") and yearly:
                    flows["outEstB" if payer == i else "inEstB"] += usd * yearly
            # the tie shown for a neighbour: money first — a yearly flow counts in full, a one-off / contract as a fifth
            # (Ginkgo's ~$18M/yr Google Cloud bill beats the one-off $14M amendment fee)
            # (a stake / partnership counts half against a supply tie: who-buys-from-whom is what the web is for)
            eff = (usd * (ANNUAL.get(m.get("per")) or 0.2) * (0.5 if role == "partners" else 1.0)) if usd is not None else None
            rank = (eff is not None, round(eff or 0, 4), order[role], e.get("strength") or 1, e.get("conf") or 0)
            if rank > best_rank:
                best_rank, best_role, best_payer = rank, role, payer
                if usd is not None:
                    tot, per, what = usd, m.get("per"), m.get("what")
                else:
                    what = what or m.get("what")
        est = all(e.get("est") or e.get("inferred") or (e.get("money") or {}).get("est") for e in rels)
        item = {"id": o, "name": (nodes.get(o) or {}).get("name") or o, "types": sorted({e["type"] for e in rels}), "payer": best_payer,
                "usdB": round(tot, 4) if per is not None else None, "per": per, "what": what,
                "strength": max(e.get("strength") or 1 for e in rels), "conf": max(e.get("conf") or 0 for e in rels), "est": est}
        if len(roles) > 1:
            item["also"] = sorted(roles - {best_role})
        buckets[best_role][o] = {k: v for k, v in item.items() if v is not None}
        nb = dict(nodes.get(o) or {"name": o})
        nb["est"] = est
        nb_nodes[o] = nb
    for m in ms:
        o = m["b"] if m["a"] == i else m["a"]
        if o not in nb_nodes:
            nb = dict(nodes.get(o) or {"name": o})
            nb["est"] = False
            nb["measuredOnly"] = True
            nb_nodes[o] = nb
    nb_nodes[i] = dict(n)
    rank_key = lambda x: (-(x.get("usdB") or 0) if x.get("per") == "year" else -(x.get("usdB") or 0) / 5, -x.get("strength", 1), -x.get("conf", 0), x["id"])
    out = {
        "t": i, "id": i, "name": n.get("name") or c.get("name") or i, "note": n.get("note"),
        "asOf": c.get("asOf") or asof, "dataAsOf": asof, "generatedAt": gen,
        "researched": bool(c.get("take")), "inUniverse": bool(n.get("inUniverse")), "inFull": bool(n.get("inFull")),
        "private": bool(n.get("private")), "listed": n.get("listed"),
        "take": node_patch.get(i, {}).get("take") or c.get("take"), "takeMild": node_patch.get(i, {}).get("takeMild") or c.get("takeMild"),
        "takeAuto": False,
        "flows": {k: round(v, 3) for k, v in flows.items()},
        **({"scale": SCALE[i]} if i in SCALE else {}),
        **{b: sorted(v.values(), key=rank_key) for b, v in buckets.items()},
        "nodes": nb_nodes, "edges": es,
        "measured": sorted(ms, key=lambda m: (m["type"] != "comove", -m["corr"])),
    }
    return out


# ════════════════════════════ explicit corrections found in spot checks ════════════════════════════
# Each: match on (a, b, type) + optional substring of money.what → patch. Kept here (not in graph/raw) so a
# re-research of a batch does not silently undo them; every one says why.
_LIC = "licenses 没写金额时默认 b 付钱给 a（a 是授权方）；这条按原文是 a 买下/引进 b 的药或牌照，钱从 a 流向 b"
CORRECTIONS: list[dict] = [
    {"a": "AMGN", "b": "ARWR", "type": "licenses", "payer": "AMGN", "what_text": "olpasiran（Lp(a)）授权：首付+里程碑+版税", "why": _LIC},
    {"a": "BAYN.DE", "b": "CYTK", "type": "licenses", "payer": "BAYN.DE", "what_text": "日本权益授权：首付+里程碑", "why": _LIC},
    {"a": "GSK", "b": "IONS", "type": "licenses", "payer": "GSK", "what_text": "bepirovirsen（乙肝）授权：里程碑+版税", "why": _LIC},
    {"a": "NVS", "b": "ARWR", "type": "licenses", "payer": "NVS", "what_text": "帕金森 RNAi 项目授权：首付约 2 亿+里程碑", "why": _LIC},
    {"a": "NVS", "b": "IONS", "type": "licenses", "payer": "NVS", "what_text": "pelacarsen（Lp(a)）授权：里程碑+版税", "why": _LIC},
    {"a": "RDY", "b": "BMY", "type": "licenses", "payer": "RDY", "what_text": "来那度胺限量仿制许可的分成", "why": _LIC},
    {"a": "RYTM", "b": "IPN.PA", "type": "licenses", "payer": "RYTM", "what_text": "setmelanotide 原授权的销售版税", "why": _LIC},
    {"a": "STZ", "b": "BUD", "type": "licenses", "payer": "STZ", "what_text": "Corona/Modelo 美国永久牌照（2013 年买断）", "why": _LIC},
    {"a": "TAK", "b": "ARWR", "type": "licenses", "payer": "TAK", "what_text": "fazirsiran（肝病 RNAi）合作开发：首付+里程碑", "why": _LIC},
    {"a": "TAK", "b": "EXEL", "type": "licenses", "payer": "TAK", "what_text": "Cabometyx 日本权益：里程碑+版税", "why": _LIC},
    # ── money sanity pass 2026-10-28 (graph-data): checked with web search, sources in each entry ──
    {"a": "MRVL", "b": "GOOGL", "type": "sells-to",
     "set": {"money.usdB": 1.0, "money.per": "year", "money.usdBLow": 0.3, "money.usdBHigh": 4.0, "money.est": True,
             "money.basis": "协议没有保底采购量；认股权证 240 档×每档 5 亿美元＝1200 亿是 FY27Q3–FY33 全部归属的上限（摩根大通折合每年约 192 亿，"
                            "前提是全归属）。迈威尔 CEO 2026-08-27 说谷歌的贡献到 FY2029 才明显，FY2028 目标里只含一部分 → 眼下每年按 10 亿美元估",
             "basis": "眼下每年约 10 亿美元（3 亿–40 亿）；1200 亿是七年满额上限，不是订单",
             "share": {"ofTo": "眼下约占迈威尔一年收入（约 95 亿）的一成；满额归属时每年约 192 亿", "ofFrom": None},
             "conf": 0.35, "checkedAt": "2026-10-28",
             "source": "Marvell 8-K 2026-08-19（协议 2026-07-29，权证 2026-08-18）；Reuters 2026-08-28（CEO：谷歌贡献 FY2029 才明显）；JPMorgan 测算（满额≈每年 192 亿）",
             "say": "谷歌递给迈威尔一本最高 1200 亿的支票本，眼下每年真花的还是零头，大头等 2028。"},
     "why": "原来按'累计 300 亿'记，画在图上像每年 300 亿，比迈威尔一年总收入（约 95 亿）还大三倍；协议无保底量，"
            "CEO 说 FY2029 才放量 → 改成眼下每年约 10 亿的估算，上限写进依据"},
    {"a": "GOOGL", "b": "SPCX", "type": "buys-from",
     "set": {"conf": 0.9, "checkedAt": "2026-10-28",
             "source": "SpaceX FWP（SEC Rule 433，2026-06-05，https://www.sec.gov/Archives/edgar/data/0001181412/000162828026041150/spacexagreementfwp.htm）："
                       "Google 云服务协议，约 11 万块英伟达 GPU，2026-10 至 2029-06 每月 9.2 亿美元，2026 年底后任一方 90 天可解约",
             "say": "谷歌每月付 9.2 亿租马斯克的 GPU 机房，是过渡算力——2026 年底后 90 天就能退租。"},
     "why": "看着离谱（SpaceX 当谷歌的供应商），查证属实：SpaceX 招股期间的 FWP 披露了这份 GPU 租赁协议（xAI 并入后的 Colossus 算力），每年约 110 亿"},
    {"a": "CI", "b": "COR", "type": "buys-from",
     "set": {"money.usdB": 41.8, "money.est": False, "money.usdBLow": None, "money.usdBHigh": None, "money.basis": None,
             "money.what": "Evernorth（Express Scripts 等）药品采购：占 Cencora FY2025 收入约 13%",
             "money.source": "Cencora 10-K FY2025（客户集中度：Evernorth Health Services 约 13%，收入约 3213 亿美元）",
             "est": False, "basis": None, "conf": 0.85, "checkedAt": "2026-10-28",
             "source": "Cencora 10-K FY2025 https://www.sec.gov/Archives/edgar/data/1140859/000114085925000131/cor-20250930.htm",
             "share": {"ofTo": "约占 Cencora 一年收入的 13%", "ofFrom": None}},
     "why": "原来按记忆估 250 亿（conf 0.35）；Cencora 10-K 披露 Evernorth 占 FY2025 收入约 13% ≈ 418 亿，原估偏低四成"},
    {"a": "p:walgreens", "b": "COR", "type": "buys-from",
     "set": {"money.usdB": 80.3, "money.est": False, "money.usdBLow": None, "money.usdBHigh": None, "money.basis": None,
             "money.source": "Cencora 10-K FY2025（客户集中度：Walgreens 与 Boots 合计约 25%）",
             "est": False, "basis": None, "conf": 0.85, "checkedAt": "2026-10-28",
             "source": "Cencora 10-K FY2025 https://www.sec.gov/Archives/edgar/data/1140859/000114085925000131/cor-20250930.htm",
             "share": {"ofTo": "约占 Cencora 一年收入的四分之一", "ofFrom": None}},
     "why": "原来按记忆估 750 亿；Cencora 10-K 披露 Walgreens+Boots 占 FY2025 收入约 25% ≈ 803 亿"},
    {"a": "p:anthropic", "b": "SPCX", "type": "buys-from",
     "note": "SpaceX 披露与 Anthropic 的 Colossus 1 算力协议每月约 12.5 亿美元，属实",
     "why": "看着离谱，查证属实"},
    # numbers that looked too big and held up — kept, with what they were checked against
    {"a": "DELL", "b": "NVDA", "type": "buys-from", "conf": 0.5,
     "note": "戴尔 2026-09 把 FY2027 AI 服务器收入指引上调到约 740 亿美元，GPU 约占整机成本六到七成 → 470 亿说得通",
     "why": "单个供应商占戴尔一年收入+资本开支三成，查证后说得通"},
    {"a": "SMCI", "b": "NVDA", "type": "buys-from", "conf": 0.5,
     "note": "超微 FY2026（至 2026-06）营收 391 亿美元、FY2027 指引 650–720 亿，GPU 占成本约六成 → FY2026 约 235 亿说得通，FY2027 会更多",
     "why": "大额低把握估算，查证后说得通"},
    {"a": "NVDA", "b": "2317.TW", "type": "sells-to", "conf": 0.5,
     "note": "英伟达 FY2027 上半年营收 1778 亿，三家直接客户分别占 16%/15%/13%（10-Q，未点名）；最大一家年化约 570 亿，鸿海是最大的整柜组装商",
     "why": "大额低把握估算，按 10-Q 客户集中度核对"},
    {"a": "NVDA", "b": "META", "type": "sells-to",
     "note": "2026-02 Meta 与英伟达签多年多代协议（数百万颗 Blackwell/Rubin），金额未披露；Meta 2026 资本开支 1150–1350 亿，分析师称其中相当部分流向英伟达",
     "why": "大额低把握估算，查证后说得通"},
    {"a": "SPCX", "b": "NVDA", "type": "buys-from",
     "note": "xAI 2025-10 为 Colossus 2 买约 30 万颗英伟达 GPU，至少 180 亿美元（WSJ）；并入 SpaceX 后继续扩建",
     "why": "大额低把握估算，查证后说得通"},
    {"a": "CRWV", "b": "NVDA", "type": "buys-from",
     "note": "CoreWeave 2026 资本开支指引上调到 350–390 亿美元（Q2 财报），GPU 约占一半以上 → 每年约 190 亿说得通（多经戴尔等整机厂，和戴尔→英伟达那条有重叠）",
     "why": "单个供应商占 CoreWeave 支出三分之二，查证后说得通"},
    {"a": "NVDA", "b": "SKHY", "type": "buys-from", "conf": 0.7,
     "note": "Yonhap：2025 上半年 SK 海力士单一大客户收入 10.89 万亿韩元（约 27%），业内指为英伟达；全年约 24% → 约 160–170 亿美元",
     "why": "大额估算，按 SK 海力士披露的客户集中度核对"},
    # Athene has been Apollo's wholly-owned, consolidated subsidiary since 2022-01: its ~$70–80bn a year of new annuity
    # money is the group's own balance sheet, not money paid to Apollo (it showed as APO flows.inB 75 vs revenue 35.6).
    # fix_periods drops the amount of any wholly-owned tie; this entry also says so in the tie's own words.
    {"a": "p:athene", "b": "APO", "type": "partner",
     "set": {"say": "Apollo 的弹药靠自家 Athene 卖的年金——左口袋进右口袋。",
             "share": {"ofTo": "Athene 是 Apollo 并表的全资子公司（2022-01 起），每年新流入约 700–800 亿美元年金资金，算集团自己的资产负债表", "ofFrom": None}},
     "why": "全资子公司（2022 年起并表）的年金流入是集团内部的钱，不是付给 Apollo 的钱；原来按每年 750 亿记，把 Apollo 的资金流入"
            "撑到一年收入（356 亿）的两倍多 → 保留关系，去掉金额"},
    {"a": "QS", "b": "VOW3.DE", "type": "licenses", "what": "PowerCo 授权预付款",
     "set": {"money.per": "total", "money.perFixed": "year"},
     "why": "「2024 年 1.3 亿 + 2025 年追加 1.31 亿」是两年的预付款合计 2.61 亿，不是每年 2.6 亿 → 改记为累计"},
    {"a": "NBIS", "b": "NVDA", "type": "buys-from",
     "note": "Nebius 2026 资本开支指引 200–250 亿美元（Q2 财报重申），主要买 GPU → 每年约 140 亿说得通（过去 12 个月资本开支还只有约 110 亿）",
     "why": "单个供应商超过 Nebius 过去 12 个月收入+资本开支，按 2026 指引核对后说得通"},
    {"a": "TM", "b": "6902.T", "type": "buys-from",
     "note": "电装 FY2026 收入 7.54 万亿日元，单卖给丰田汽车本体 1.99 万亿（26.4%）；连同丰田旗下子公司超过一半（Reuters）→ 220 亿美元按集团口径说得通",
     "why": "单个客户占电装四成多，查证后按集团口径说得通"},
    {"a": "CORZ", "b": "AMD", "type": "sells-to",
     "note": "2026-07-27 8-K：AMD 直租 Pecos/Hunt County/Muskogee 共 377MW，每份 15 年；全部交付要到 2028 年底",
     "why": "合同总额是 Core Scientific 一年收入的 20 多倍——多年租约，查证属实"},
]


def apply_corrections(edges: list[dict], stats: Counter) -> list[dict]:
    out = []
    for e in edges:
        drop = False
        for c in CORRECTIONS:
            if c.get("a") and norm_id(c["a"]) != e["a"]:
                continue
            if c.get("b") and norm_id(c["b"]) != e["b"]:
                continue
            if c.get("type") and c["type"] != e["type"]:
                continue
            if c.get("what") and c["what"] not in str((e.get("money") or {}).get("what") or ""):
                continue
            if c.get("batch") and c["batch"] != e["batch"]:
                continue
            if c.get("drop"):
                drop = True
            for k, v in (c.get("set") or {}).items():
                tgt, kk = (e["money"], k[6:]) if k.startswith("money.") and e.get("money") else (e, k)
                if k.startswith("money.") and not e.get("money"):
                    continue
                if v is None:
                    tgt.pop(kk, None)
                else:
                    tgt[kk] = v
            if c.get("note"):                    # a spot check that kept the number: say what it was checked against
                note = f"（{c.get('checked', '2026-10-28')} 核对：{c['note']}）"
                if e.get("money") and (e["money"].get("est") or e.get("est")):
                    e["money"]["basis"] = (e["money"].get("basis") or e.get("basis") or "按公开信息推算") + note
                    e["basis"] = (e.get("basis") or "按公开信息推算") + note
                else:
                    e["checkNote"] = c["note"]
                e["checkedAt"] = c.get("checked", "2026-10-28")
                if c.get("conf") is not None:
                    e["conf"] = c["conf"]
            if c.get("swapMoney") and e.get("money"):
                m = e["money"]
                m["from"], m["to"] = m["to"], m["from"]
            if c.get("payer"):
                payer = norm_id(c["payer"])
                payee = e["b"] if payer == e["a"] else e["a"]
                if e.get("money"):
                    e["money"]["from"], e["money"]["to"] = payer, payee
                else:   # no number, but the direction is now explicit (never guess a number)
                    e["money"] = {"from": payer, "to": payee, "usdB": None, "per": None, "what": c.get("what_text"), "est": e.get("est", False)}
            e.setdefault("corrected", []).append(c["why"])
            stats["corrected"] += 1
        if not drop:
            out.append(e)
    return out


def check(ticker: str, docs: dict) -> None:
    t = norm_id(ticker)
    d = docs.get(t) or read_json(OUT / fname(t))
    if not d:
        log(f"\n== {ticker}: no graph file")
        return
    log(f"\n== {t} {d['name']}  researched={d['researched']} inUniverse={d['inUniverse']}  flows/yr in {d['flows']['inB']}B out {d['flows']['outB']}B")
    for b, arrow in (("upstream", "pays →"), ("downstream", "← paid by"), ("competitors", "vs"), ("partners", "~")):
        rows = d[b][:9]
        log(f"  {b} ({len(d[b])}):")
        for x in rows:
            u = f"{x['usdB']}B/{x.get('per')}" if x.get("usdB") is not None else "—"
            log(f"     {arrow} {x['id']:<12} {x['name'][:14]:<14} {u:<16} {','.join(x['types']):<20} {'估' if x['est'] else '  '} {str(x.get('what') or '')[:40]}")
    co = [m for m in d["measured"] if m["type"] == "comove"]
    ll = [m for m in d["measured"] if m["type"] == "leadlag"]
    log(f"  comove: {', '.join(f'{(m['b'] if m['a'] == t else m['a'])} {m['corr']}' for m in co[:8])}")
    log(f"  leadlag: {', '.join(f'{m['lead']}→{m['lag']} {m['days']}d r{m['corr']}' for m in ll[:6])}")
    log(f"  take{' (auto)' if d.get('takeAuto') else ''}: {d['take']}")


class build_lock:
    """One build at a time (update.sh, the server's apply_patch after a scout job, a manual run): two builds
    writing web/data/graph/ at once could delete each other's new files in the stale-file sweep."""

    def __enter__(self):
        import fcntl
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(LOCK, "a+")
        t0 = time.time()
        while True:
            try:
                fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.time() - t0 > 120:
                    raise SystemExit("  ! another graph build has held the lock for 2 minutes — giving up")
                time.sleep(0.2)

    def __exit__(self, *a):
        import fcntl
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="graph/raw/*.json → web/data/graph/ (DESIGN §13/§14)")
    ap.add_argument("--no-measured", action="store_true", help="skip comove / lead-lag from prices")
    ap.add_argument("--reuse-measured", action="store_true", help="take comove / lead-lag from the last build (fast)")
    ap.add_argument("--allow-partial", action="store_true", help="build even if a raw file cannot be read")
    ap.add_argument("--check", nargs="*", default=None, help="print these companies' buckets after the build")
    return ap


def run(argv=None) -> dict:
    args = parser().parse_args(argv or [])
    if args.reuse_measured:
        args.no_measured = True
    with build_lock():
        return build(args)


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.reuse_measured:
        args.no_measured = True
    with build_lock():
        docs = build(args)
    if args.check is not None:
        for t in args.check or ["GOOGL", "NVDA", "MSFT", "ORCL", "TSM", "CRWD"]:
            check(t, docs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
