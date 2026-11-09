"""why/facts.py — the measured side of 为什么 (DESIGN §21/§24). No Claude here, no network.

From the generated data (web/data, web/data/fm, web/data/gl) it works out, for one target:
  what moved, how much, since when (start of the current wind regime, detected from the series),
  how it compares with its neighbours — and for a 'day' target that exact day's price and money flow.
The result feeds both the card (`facts` — four plain sentences) and the prompt (`context` — richer lines,
`question`, `searchDates`, `searchTerms`) so Claude searches news around the exact dates.

    build(target) -> dict  {kind, ids, map, date, dateIndex, asOf, partial, key, title, facts{what,howMuch,since,
                            vsNeighbours}, regime, day?, context[], question, searchDates[], searchTerms[]}
    normalize_target(raw) -> dict   (accepts the shapes the frontend sends, see job.py)
    make_key(kind, ids, map, date) -> str

Target kinds: node | stock | day | edge | channel | landing | market   (map: curated | full | global)
"""
from __future__ import annotations

import hashlib
import re
import threading
from pathlib import Path
from typing import Any

from why.util import (ROOT, SEASONS, WEB_DATA, at, crash_at, crash_say, money, num, pct, pres_word, read_json,
                      season, temp_word, wind_word, zh_date)

KINDS = ("node", "stock", "day", "edge", "channel", "landing", "market")
MAPS = {"curated": WEB_DATA, "full": WEB_DATA / "fm", "global": WEB_DATA / "gl"}
MAP_ALIASES = {"fm": "full", "gl": "global", "精选": "curated", "全市场": "full", "全球": "global", "": "curated"}


class FactsError(ValueError):
    """A target we cannot build a question for (unknown id, no data) — message is plain Chinese."""


# ═════════════════════════════════════════════════════════════════════════ data access
class Tree:
    def __init__(self, raw: dict | None):
        self.nodes: dict[str, dict] = {}
        self.parent: dict[str, str] = {}
        self.children: dict[str, list[str]] = {}
        self.paths: dict[str, list[str]] = {}
        self.by_name: dict[str, str] = {}
        if isinstance(raw, dict) and raw.get("id"):
            self._walk(raw, [])

    def _walk(self, n: dict, trail: list[str]) -> None:
        nid = n.get("id")
        if not nid:
            return
        if nid not in self.nodes:
            self.nodes[nid] = {k: v for k, v in n.items() if k != "children"}
            self.paths[nid] = trail + [nid]
            self.children[nid] = []
            if trail:
                self.parent[nid] = trail[-1]
            nm = str(n.get("name") or "").strip().lower()
            if nm and nm not in self.by_name:
                self.by_name[nm] = nid
        for c in n.get("children") or []:
            cid = c.get("id")
            if cid and cid not in self.children[nid]:
                self.children[nid].append(cid)
            self._walk(c, trail + [nid])

    def get(self, nid: str) -> dict:
        return self.nodes.get(nid) or {}

    def is_stock(self, nid: str) -> bool:
        return nid.startswith("s:") or self.get(nid).get("kind") == "stock"

    def name(self, nid: str) -> str:
        n = self.get(nid)
        if not n:
            return nid[2:] if nid.startswith("s:") else nid
        nm = n.get("name") or nid
        if self.is_stock(nid):
            t = n.get("ticker") or nid[2:]
            return nm if nm.upper() == t.upper() else f"{nm}（{t}）"
        return nm

    def path_names(self, nid: str) -> str:
        return " › ".join(self.get(i).get("name", i) for i in self.paths.get(nid, []) if i != "world")

    def resolve(self, ref: Any) -> str | None:
        """Node id, 's:TICKER', bare ticker, 'Ginkgo Bioworks (DNA)', exact name → node id."""
        if not isinstance(ref, str) or not ref.strip():
            return None
        r = ref.strip()
        if r in self.nodes:
            return r
        if r.lower() in self.nodes:
            return r.lower()
        m = re.search(r"\(([A-Za-z0-9.\-^=]{1,15})\)\s*$", r)
        cands = [m.group(1)] if m else []
        t = r[2:] if r[:2].lower() == "s:" else r
        cands += [t, t.lstrip("$"), t.replace(".", "-")]
        for c in cands:
            if "s:" + c.upper() in self.nodes:
                return "s:" + c.upper()
            if "s:" + c in self.nodes:
                return "s:" + c
        return self.by_name.get(r.lower())


class DataRoot:
    """One map's generated data (curated web/data, full web/data/fm, global web/data/gl), cached by mtime."""

    def __init__(self, name: str):
        self.name = name
        self.dir: Path = MAPS[name]
        self.meta = read_json(self.dir / "meta.json") or {}
        self.dates: list[str] = list(self.meta.get("dates") or [])
        self.asOf: str | None = self.meta.get("asOf") or (self.dates[-1] if self.dates else None)
        self.tree = Tree(read_json(self.dir / "tree.json"))
        self._maps: dict[str, Any] = {}
        self._stocks: dict[str, Any] = {}

    def exists(self) -> bool:
        return bool(self.dates) and bool(self.tree.nodes)

    def partial_note(self, d: str | None) -> str | None:
        p = self.meta.get("partial")
        if isinstance(p, dict) and p.get("date") and p.get("date") == d:
            f = str(p.get("fetchedAt") or "")
            hm = f[11:16] if len(f) >= 16 else ""
            return f"{zh_date(d)} 是盘中数据" + (f"（截至美东 {hm}）" if hm else "") + "，当天成交和资金流还不完整"
        return None

    def map_json(self, nid: str | None) -> dict | None:
        if not nid:
            return None
        if nid not in self._maps:
            self._maps[nid] = read_json(self.dir / "maps" / (nid.replace(":", "_") + ".json"))
        return self._maps[nid]

    def stock_json(self, ticker: str) -> dict | None:
        t = ticker[2:] if ticker.startswith("s:") else ticker
        if t in self._stocks:
            return self._stocks[t]
        d = read_json(self.dir / "stocks" / f"{t}.json")
        if d is None and self.name != "curated":
            d = _lazy_stock(self.name, t)
        if d is None and self.name != "curated":            # a curated ticker viewed from another map
            d = read_json(WEB_DATA / "stocks" / f"{t}.json")
        if d is None and self.name == "curated":            # a full-market-only ticker (graph neighbours)
            d = read_json(WEB_DATA / "fm" / "stocks" / f"{t}.json") or _lazy_stock("full", t)
        self._stocks[t] = d if isinstance(d, dict) else None
        return self._stocks[t]

    def series(self, nid: str) -> "Series | None":
        s = self._series(nid)
        if s is not None:
            p = self.meta.get("partial")
            s.partial_date = p.get("date") if isinstance(p, dict) else None
        return s

    def _series(self, nid: str) -> "Series | None":
        if self.tree.is_stock(nid) or nid.startswith("s:"):
            d = self.stock_json(nid)
            if not isinstance(d, dict) or not isinstance(d.get("wind"), list):
                return None
            return Series.from_stock(d)
        m = self.map_json(nid)
        if isinstance(m, dict) and isinstance(m.get("self"), dict):
            return Series.from_map(m["self"], self.dates)
        par = self.tree.parent.get(nid)
        pm = self.map_json(par)
        if isinstance(pm, dict) and isinstance((pm.get("children") or {}).get(nid), dict):
            return Series.from_map(pm["children"][nid], self.dates)
        return None

    def date_index(self, di: Any, date_str: Any = None) -> int:
        n = len(self.dates)
        if not n:
            raise FactsError("这张地图还没有数据")
        if isinstance(date_str, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            return nearest_index(self.dates, date_str)
        if isinstance(di, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", di):
            return nearest_index(self.dates, di)
        v = num(di) if not isinstance(di, str) else (num(float(di)) if re.match(r"^-?\d+$", di) else None)
        if v is None:
            return n - 1
        i = int(v)
        if i < 0:
            i += n
        return max(0, min(n - 1, i))


def _lazy_stock(map_name: str, t: str) -> dict | None:
    """fullmarket/stockfile.py or globalmkt/stockfile.py — imported defensively (other agents write them)."""
    import importlib
    mod_name = {"full": "fullmarket.stockfile", "global": "globalmkt.stockfile"}.get(map_name)
    if not mod_name or not (ROOT / (mod_name.replace(".", "/") + ".py")).exists():
        return None
    try:
        mod = importlib.import_module(mod_name)
        for fn in ("build_stock_json", "stock_json", "get_stock", "build_stock", "stock"):
            f = getattr(mod, fn, None)
            if callable(f):
                out = f(t)
                return out if isinstance(out, dict) and not out.get("error") else None
    except Exception:  # noqa: BLE001 — a half-written module must not break 为什么
        return None
    return None


def nearest_index(dates: list[str], d: str) -> int:
    """Index of d in dates, else the last trading day before it (else 0)."""
    if d in dates:
        return dates.index(d)
    best = 0
    for i, x in enumerate(dates):
        if x <= d:
            best = i
    return best


_roots: dict[str, tuple[float, DataRoot]] = {}
_roots_lock = threading.Lock()


def data_root(name: str) -> DataRoot:
    name = MAP_ALIASES.get(name, name) if isinstance(name, str) else "curated"
    if name not in MAPS:
        name = "curated"
    d = MAPS[name]
    try:
        mt = max((d / "meta.json").stat().st_mtime, (d / "tree.json").stat().st_mtime)
    except OSError:
        mt = 0.0
    with _roots_lock:
        hit = _roots.get(name)
        if hit and hit[0] == mt:
            return hit[1]
        r = DataRoot(name)
        _roots[name] = (mt, r)
        return r


class Series:
    """Daily series for one node/stock on its own dates: wind/temp/pres/storm/front/flow/dv/px (+ OHLCV)."""

    def __init__(self, dates: list[str], cols: dict[str, list], is_stock: bool):
        self.dates, self.c, self.is_stock = dates, cols, is_stock
        self.n = len(dates)
        self.partial_date: str | None = None

    @classmethod
    def from_map(cls, s: dict, dates: list[str]) -> "Series":
        cols = {k: list(s.get(k) or []) for k in ("wind", "temp", "pres", "storm", "front", "flow", "dv")}
        cols["px"] = list(s.get("idx") or [])
        n = min([len(dates)] + [len(v) for v in cols.values() if v])
        return cls(dates[-n:] if n else [], {k: v[-n:] if v else [] for k, v in cols.items()}, False)

    @classmethod
    def from_stock(cls, d: dict) -> "Series":
        dates = list(d.get("dates") or [])
        cols = {k: list(d.get(k) or []) for k in ("wind", "temp", "pres", "storm", "front", "flow", "o", "h", "l", "c", "v")}
        cols["px"] = cols["c"]
        cols["dv"] = [(num(c) or 0) * (num(v) or 0) / 1e6 if num(c) is not None and num(v) is not None else None
                      for c, v in zip(cols["c"], cols["v"])]
        return cls(dates, cols, True)

    def idx_of(self, d: str) -> int:
        return nearest_index(self.dates, d)

    def v(self, k: str, i: int) -> float | None:
        return at(self.c.get(k) or [], i) if 0 <= i < self.n else None

    def ret(self, i: int, n: int = 1) -> float | None:
        a, b = self.v("px", i), self.v("px", i - n) if i - n >= 0 else None
        return a / b - 1 if a and b else None

    def fsum(self, i0: int, i1: int) -> float:
        return sum(num(x) or 0.0 for x in (self.c.get("flow") or [])[max(0, i0):i1 + 1])

    def avg(self, k: str, i0: int, i1: int) -> float | None:
        vals = [num(x) for x in (self.c.get(k) or [])[max(0, i0):i1 + 1]]
        vals = [x for x in vals if x is not None]
        return sum(vals) / len(vals) if vals else None

    def crash_at(self, i: int) -> dict | None:
        """暴跌闸门 (DESIGN §8 amendment) on this series' own prices (map idx / stock c) — same rule as the map."""
        return crash_at(self.c.get("px") or [], i) if 0 <= i < self.n else None

    def season_at(self, i: int) -> str | None:
        w, w5, p = self.v("wind", i), self.v("wind", i - 5), self.v("pres", i)
        return season(w, (w - w5) if (w is not None and w5 is not None) else 0.0, p, self.crash_at(i))


# ═════════════════════════════════════════════════════════════════════════ regime detection
def regime(s: Series, i: int) -> dict | None:
    """Like _regime, but a calm spell of ≤ 2 days right after a clear wave is reported as that wave fading
    (a one-day dip — often a partial intraday bar — must not hide a 20-day inflow)."""
    r = _regime(s, i)
    if r and r["dir"] == 0 and r["days"] <= 2 and r["startIndex"] > 0 and abs(s.v("wind", r["startIndex"] - 1) or 0) > 0.5:
        prev = _regime(s, r["startIndex"] - 1)
        if prev and prev["dir"]:
            a = prev["startIndex"]
            base = a - 1 if a > 0 else a
            px0, px1 = s.v("px", base), s.v("px", i)
            prev.update({"days": i - a + 1, "cumFlow": round(s.fsum(a, i), 2),
                         "ret": round(px1 / px0 - 1, 4) if px0 and px1 else None,
                         "windNow": r["windNow"], "fading": True, "fadeFrom": r["start"]})
            return prev
    return r


def _regime(s: Series, i: int) -> dict | None:
    """The current wind regime at day i: direction (+1 in / -1 out / 0 calm), the day it started (walking back
    while the wind stays on the same side — one shallow dip tolerated), its length, money and price over it,
    the strongest single day (the likely trigger, searched first), the peak, what came before, fronts in it."""
    w = s.c.get("wind") or []
    wi = s.v("wind", i)
    if wi is None:
        return None
    d = 1 if wi > 0.5 else (-1 if wi < -0.5 else 0)
    j = i
    if d:
        while j > 0:
            p1 = at(w, j - 1)
            if p1 is not None and p1 * d > 0.15:
                j -= 1
                continue
            p2 = at(w, j - 2) if j >= 2 else None
            if p1 is not None and p1 * d > -0.3 and p2 is not None and p2 * d > 0.15:
                j -= 2
                continue
            break
    else:
        while j > 0 and at(w, j - 1) is not None and abs(at(w, j - 1)) <= 0.5:
            j -= 1
    start = j
    # wind is a 5-day signal: the money usually started a few days earlier — look back up to 3 days, but not
    # into an earlier wave in the same direction (those days already had strong wind of the same sign)
    lo = start
    while d and lo > max(1, start - 3) and (at(w, lo - 1) or 0.0) * d < 0.5:
        lo -= 1
    lo = max(1, lo if d else start)
    flows = [(k, s.v("flow", k) or 0.0) for k in range(lo, i + 1)]
    if d:
        k_trig, f_trig = max(flows, key=lambda kv: kv[1] * d) if flows else (i, 0.0)
        if f_trig * d <= 0:
            k_trig, f_trig = max(flows, key=lambda kv: abs(kv[1])) if flows else (i, 0.0)
    else:
        k_trig, f_trig = max(flows, key=lambda kv: abs(kv[1])) if flows else (i, 0.0)
    big_days = sorted(flows, key=lambda kv: -abs(kv[1]))[:3]
    seg = [(k, s.v("wind", k)) for k in range(start, i + 1)]
    seg = [(k, x) for k, x in seg if x is not None]
    k_peak, w_peak = (max(seg, key=lambda kx: kx[1] * (d or 1) if d else abs(kx[1])) if seg else (i, wi))
    base = start - 1 if start > 0 else start
    px0, px1 = s.v("px", base), s.v("px", i)
    before = s.avg("wind", start - 6, start - 1) if start > 0 else None
    fronts = [s.dates[k] for k in range(max(0, start - 3), i + 1) if (s.v("front", k) or 0) != 0]
    dv_avg = s.avg("dv", i - 19, i)
    return {
        "dir": d, "start": s.dates[start], "startIndex": start, "days": i - start + 1, "clipped": start == 0,
        "cumFlow": round(s.fsum(start, i), 2), "ret": round(px1 / px0 - 1, 4) if px0 and px1 else None,
        "trigger": {"date": s.dates[k_trig], "flow": round(f_trig, 2), "ret": _r4(s.ret(k_trig)),
                    "volX": _vol_x(s, k_trig)},
        "bigDays": [{"date": s.dates[k], "flow": round(f, 2), "ret": _r4(s.ret(k))} for k, f in big_days],
        "peak": {"date": s.dates[k_peak], "wind": round(w_peak, 2)},
        "windNow": round(wi, 2), "before": round(before, 2) if before is not None else None,
        "beforeWord": wind_word(before) if before is not None else None,
        "fronts": fronts, "dv20": round(dv_avg, 2) if dv_avg is not None else None,
        "searchFrom": s.dates[max(0, min(start, k_trig) - 3)],
    }


def _r4(x):
    return round(x, 4) if x is not None else None


def _vol_x(s: Series, k: int) -> float | None:
    """That day's turnover as a multiple of the previous 20 days' average (None for a partial intraday bar)."""
    if getattr(s, "partial_date", None) and 0 <= k < s.n and s.dates[k] == s.partial_date:
        return None
    dv = s.v("dv", k)
    a = s.avg("dv", k - 20, k - 1)
    return round(dv / a, 1) if dv is not None and a else None


def regime_text(r: dict | None, ref: str | None) -> str:
    if not r:
        return "没有足够的历史数据"
    st = zh_date(r["start"], ref)
    head = (f"至少从 {st} 起（窗口开头）" if r["clipped"] else f"从 {st} 起") + f"，已经 {r['days']} 个交易日"
    if r["dir"] == 0:
        head = (f"至少从 {st} 起" if r["clipped"] else f"从 {st} 起") + f"就风平浪静（{r['days']} 个交易日）"
    elif r.get("beforeWord"):
        head += f"；之前是「{r['beforeWord']}」"
    t = r["trigger"]
    trig = f"{'最猛的一天' if r['dir'] else '其间钱动得最大的一天'}：{zh_date(t['date'], ref)}，{_day_move(t)}，估算净{'流入' if t['flow'] >= 0 else '流出'} {money(abs(t['flow']), False)}"
    if t.get("volX") and (t["volX"] >= 1.5 or t["volX"] <= 0.6):
        trig += f"，成交是平时的 {t['volX']:g} 倍"
    fr = f"；{zh_date(r['fronts'][-1], ref)} 风向突变" if r.get("fronts") else ""
    fade = f"；{zh_date(r['fadeFrom'], ref)} 起风减弱到 {r['windNow']:+.1f}" if r.get("fading") else ""
    return f"{head}。{trig}{fr}{fade}"


def _day_move(t: dict) -> str:
    r = t.get("ret")
    if r is None:
        return "涨跌不明"
    return f"{'涨' if r >= 0 else '跌'} {abs(r) * 100:.1f}%"


# ═════════════════════════════════════════════════════════════════════════ pieces of facts
def weather_line(root: DataRoot, nid: str, s: Series, i: int, wind_label: bool = True) -> str:
    w, t, p, st = s.v("wind", i), s.v("temp", i), s.v("pres", i), s.v("storm", i)
    se = s.season_at(i)
    bits = [(f"风 {w:+.2f}（{wind_word(w)}）" if wind_label else f"风 {w:+.2f}") if w is not None else "风 没数据",
            f"温度 {t:+.2f}（{temp_word(t)}）" if t is not None else None,
            f"拥挤度 {int(p)}（{pres_word(p)}）" if p is not None else None]
    if st is not None and st >= 0.8:
        bits.append(f"风暴 {st:.1f}（波动突然变大）")
    if se:
        cs = crash_say(s.crash_at(i))
        bits.append(f"季节 {SEASONS[se][0]}{SEASONS[se][1]}" + (f"（{cs}）" if cs else ""))
    return "；".join(b for b in bits if b)


def mixed_signal(s: Series, i: int) -> str | None:
    """Phase-3 note 3: wind = share of the parent's trading (attention) + estimated money. When the 5-day money
    points the other way, say it plainly instead of letting two lines on one screen contradict each other."""
    w = s.v("wind", i)
    f5 = s.fsum(i - 4, i)
    dv = s.avg("dv", i - 19, i) or 0
    if w is None or dv <= 0 or abs(f5) < 0.05 * dv:
        return None
    if w > 0.5 and f5 < 0:
        return (f"注意：风说「钱在流进来」，主要是它在成交里的份额在升（关注度上来了）；按价格估算，近 5 日其实净流出 "
                f"{money(abs(f5), False)}——关注度在升，但钱没真进来")
    if w < -0.5 and f5 > 0:
        return (f"注意：风说「钱在溜走」，主要是它在成交里的份额还在降；按价格估算，近 5 日其实小幅回流 "
                f"{money(f5, False)}——跌少了，但没人回头")
    return None


def regime_mismatch(r: dict | None) -> str | None:
    """The wind says in/out but the estimated money over the same stretch went the other way."""
    if not r or not r["dir"] or r["days"] < 3:
        return None
    cf, rt = r.get("cumFlow") or 0.0, r.get("ret")
    dv = r.get("dv20") or 0.0
    if r["dir"] > 0 and cf < 0 and abs(cf) > 0.05 * dv:
        return (f"矛盾：风显示这段在流入，但按价格估算的累计其实是净流出 {money(abs(cf), False)}"
                + (f"、价格 {pct(rt)}" if rt is not None else "") + "——升的主要是成交份额（关注度），钱没真进来")
    if r["dir"] < 0 and cf > 0 and abs(cf) > 0.05 * dv:
        return (f"矛盾：风显示这段在流出，但按价格估算的累计其实是净流入 {money(abs(cf), False)}"
                + (f"、价格 {pct(rt)}" if rt is not None else "") + "——降的主要是成交份额（没人看了），不是被抛")
    return None


def how_much(s: Series, i: int, r: dict | None) -> str:
    f5 = s.fsum(i - 4, i)
    f20 = s.fsum(i - 19, i)
    dv20 = s.avg("dv", i - 19, i)
    bits = [f"近 5 日估算净{'流入' if f5 >= 0 else '流出'} {money(abs(f5), False)}"]
    if dv20:
        bits[-1] += f"（平时日均成交 {money(dv20, False)}，相当于 {abs(f5) / dv20:.1f} 天的成交）"
    bits.append(f"近 20 日 {money(f20)}")
    r5, r20 = s.ret(i, 5), s.ret(i, 20)
    bits.append(f"价格 5 日 {pct(r5)}、20 日 {pct(r20)}")
    if r and r["dir"] and not r["clipped"] and r["days"] > 1:
        bits.append(f"这段{'流入' if r['dir'] > 0 else '流出'}期累计 {money(r['cumFlow'])}、价格 {pct(r['ret'])}")
    return "；".join(bits)


def siblings_line(root: DataRoot, nid: str, i_date: str) -> tuple[str, list[str]]:
    """Rank among the parent's children by wind on that date (+ the parent's own move)."""
    tree = root.tree
    par = tree.parent.get(nid)
    pm = root.map_json(par)
    if not par or not isinstance(pm, dict):
        return "", []
    kids = pm.get("children") or {}
    rows = []
    for cid, ser in kids.items():
        s = Series.from_map(ser, root.dates)
        i = s.idx_of(i_date)
        w = s.v("wind", i)
        if w is None:
            continue
        rows.append((cid, w, s.fsum(i - 4, i), s.ret(i, 5)))
    if not rows:
        return "", []
    rows.sort(key=lambda r: -r[1])
    pos = next((k for k, r in enumerate(rows) if r[0] == nid), None)
    ps = root.series(par)
    pi = ps.idx_of(i_date) if ps else 0
    pname = tree.get(par).get("name", par)
    head = ""
    if pos is not None:
        me = rows[pos]
        head = f"在「{pname}」的 {len(rows)} 个{'成员' if nid.startswith('s:') else '分区'}里，风排第 {pos + 1}"
        if ps:
            pr5 = ps.ret(pi, 5)
            if me[3] is not None and pr5 is not None:
                head += f"；它 5 日 {pct(me[3])}，「{pname}」整体 {pct(pr5)}"
    top = [f"{tree.name(c)} 风{w:+.1f}" for c, w, _, _ in rows[:3] if c != nid and w > 0.3]
    bot = [f"{tree.name(c)} 风{w:+.1f}" for c, w, _, _ in rows[-2:] if c != nid and w < -0.3]
    tail = ""
    if top:
        tail += "；最吸钱的：" + "、".join(top)
    if bot:
        tail += "；最失血的：" + "、".join(bot)
    return head + tail, [c for c, *_ in rows]


def contributors(root: DataRoot, nid: str, i0: int, i1_date: str, i0_date: str, depth: int = 2) -> list[tuple[str, float, float | None]]:
    """Children (and grandchildren of the biggest children) by Σflow over [i0_date, i1_date]."""
    m = root.map_json(nid)
    if not isinstance(m, dict):
        return []
    out = []
    for cid, ser in (m.get("children") or {}).items():
        s = Series.from_map(ser, root.dates)
        a, b = s.idx_of(i0_date), s.idx_of(i1_date)
        px0 = s.v("px", a - 1 if a > 0 else a)
        px1 = s.v("px", b)
        out.append((cid, s.fsum(a, b), (px1 / px0 - 1) if px0 and px1 else None))
    out.sort(key=lambda r: -abs(r[1]))
    return out


MIN_HISTORY = 25          # a card needs this many trading days before the asked day (regime, 20-day numbers)


def _too_early(root: DataRoot, i: int) -> None:
    if i < MIN_HISTORY:
        raise FactsError("这一天在一年窗口的开头，前面没数据，换一天再问")


def _vol(s: Series, i: int, n: int = 20) -> float | None:
    """Stdev of the daily returns over the n days before i (the day's own move left out)."""
    rs = [s.ret(k) for k in range(max(1, i - n), i)]
    rs = [x for x in rs if x is not None]
    if len(rs) < 8:
        return None
    m = sum(rs) / len(rs)
    return (sum((x - m) ** 2 for x in rs) / (len(rs) - 1)) ** 0.5


def _et_hm(root: DataRoot, d: str) -> str | None:
    p = root.meta.get("partial")
    if isinstance(p, dict) and p.get("date") == d:
        f = str(p.get("fetchedAt") or "")
        return f[11:16] if len(f) >= 16 else ""
    return None


def comovers(root: DataRoot, nid: str, s: Series, d: str, r1: float) -> dict:
    """Who moved the same way on day d: a stock's peers, a region's members. → {same:[(name, ret)], opp:[…], n}."""
    tree = root.tree
    rows: list[tuple[str, float]] = []
    if s.is_stock:
        sj = root.stock_json(nid) or {}
        for p in [p[2:] if p.startswith("s:") else p for p in (sj.get("peers") or [])][:8]:
            pj = root.stock_json(p)
            if not isinstance(pj, dict):
                continue
            ps = Series.from_stock(pj)
            k = ps.idx_of(d)
            if ps.dates and ps.dates[k] == d and ps.ret(k) is not None:
                rows.append((p, ps.ret(k)))
    else:
        m = root.map_json(nid)
        for cid, ser in ((m or {}).get("children") or {}).items():
            cs = Series.from_map(ser, root.dates)
            k = cs.idx_of(d)
            if cs.dates and cs.dates[k] == d and cs.ret(k) is not None:
                rows.append((tree.name(cid), cs.ret(k)))
    thr = max(0.02, 0.35 * abs(r1))
    same = sorted([(n, x) for n, x in rows if x * r1 > 0 and abs(x) >= thr], key=lambda nx: -abs(nx[1]))
    opp = sorted([(n, x) for n, x in rows if x * r1 < 0 and abs(x) >= 0.02], key=lambda nx: -abs(nx[1]))
    return {"same": same, "opp": opp, "n": len(rows)}


def day_focus(root: DataRoot, nid: str, s: Series, si: int, r: dict | None) -> dict | None:
    """The asked day itself is the news: a move ≥ 2 × its usual daily swing, or the biggest money day of the
    current wave. Then the card asks about THAT day first (and the regime becomes background) — a +12.5% day
    with the whole group up together must not be answered with reasons from three weeks earlier."""
    d = s.dates[si]
    r1 = s.ret(si)
    if r1 is None:
        return None
    vol = _vol(s, si)
    v = vol or 0.0
    big = vol is not None and abs(r1) >= 2 * vol and abs(r1) >= 0.02
    top_flow = bool(r and r["trigger"]["date"] == d) and abs(r1) >= max(0.015, v)
    top_move = False
    if r and r["startIndex"] < si:
        prior = [abs(x) for x in (s.ret(k) for k in range(max(1, r["startIndex"]), si)) if x is not None]
        top_move = bool(prior) and abs(r1) > max(prior) and abs(r1) >= max(0.015, 1.25 * v)
    co = comovers(root, nid, s, d, r1)
    n_same = len(co["same"])
    together = n_same >= 2 and n_same * 2 >= max(1, co["n"])
    group = together and abs(r1) >= max(0.03 if s.is_stock else 0.015, v)
    if not (big or top_flow or top_move or group):
        return None
    hm = _et_hm(root, d)
    flow = s.v("flow", si) or 0.0
    when = "今天" if d == root.asOf else zh_date(d, root.asOf)
    up = r1 > 0
    move = f"{'盘中' if hm is not None else ''}{'涨' if up else '跌'} {abs(r1) * 100:.1f}%"
    peers = "、".join(f"{n} {pct(x)}" for n, x in co["same"][:3])
    grp = "同行" if s.is_stock else "成员"
    return {"date": d, "ret": round(r1, 4), "vol20": round(vol, 4) if vol is not None else None,
            "volX": round(abs(r1) / vol, 1) if vol else None, "flow": round(flow, 2), "partial": hm is not None,
            "etTime": hm or None, "when": when, "move": move, "together": together, "same": co["same"][:5],
            "opp": co["opp"][:3], "nPeers": co["n"], "peers": peers, "grp": grp,
            "togetherWord": (f"{grp}齐{'涨' if up else '跌'}" if together else ""),
            "text": (f"{when}{move}" + (f"（截至美东 {hm}）" if hm else "")
                     + f"，估算净{'流入' if flow >= 0 else '流出'} {money(abs(flow), False)}"
                     + (f"，是它平时一天波动的 {abs(r1) / vol:.1f} 倍" if vol else "")
                     + (f"；{grp}同天{'也涨' if up else '也跌'}：{peers}" if co["same"] else
                        (f"；{grp}没跟着动" if co["n"] else "")))}


def peers_line(root: DataRoot, sj: dict, d: str, k: int = 6) -> tuple[str, list[str]]:
    peers = [p[2:] if p.startswith("s:") else p for p in (sj.get("peers") or [])][:k]
    bits = []
    for t in peers:
        pj = root.stock_json(t)
        if not isinstance(pj, dict):
            continue
        ps = Series.from_stock(pj)
        i = ps.idx_of(d)
        r1, r5 = ps.ret(i, 1), ps.ret(i, 5)
        bits.append(f"{t} 当日 {pct(r1)} / 5日 {pct(r5)}")
    return ("同行同期：" + "；".join(bits)) if bits else "", peers


# ═════════════════════════════════════════════════════════════════════════ builders per kind
def _common(root: DataRoot, kind: str, ids: list[str], i: int, d: str) -> dict:
    return {"kind": kind, "ids": ids, "map": root.name, "date": d, "dateIndex": i, "asOf": root.asOf,
            "partial": root.partial_note(d), "partialAt": _et_hm(root, d), "context": [], "searchDates": [],
            "searchTerms": []}


def build_node(root: DataRoot, nid: str, i: int) -> dict:
    tree = root.tree
    d = root.dates[i]
    s = root.series(nid)
    if s is None or not s.n:
        raise FactsError(f"「{tree.name(nid)}」没有天气数据")
    si = s.idx_of(d)
    _too_early(root, i)
    kind = "stock" if tree.is_stock(nid) else "node"
    out = _common(root, kind, [nid], i, d)
    r = regime(s, si)
    name = tree.name(nid)
    ref = root.asOf
    w = s.v("wind", si)
    out["regime"] = r
    focus = day_focus(root, nid, s, si, r) if s.dates[si] == d else None
    out["focus"] = focus
    mixed = mixed_signal(s, si) or regime_mismatch(r)
    out["facts"] = {
        "what": f"【{name}】" + (focus["text"] + "。" if focus else "") + f"{wind_word(w)}："
                + weather_line(root, nid, s, si, wind_label=False) + ("。" + mixed if mixed else ""),
        "howMuch": how_much(s, si, r),
        "since": regime_text(r, ref),
        "vsNeighbours": "",
    }
    ctx = out["context"]
    ctx.append(f"目标：{tree.path_names(nid) or name}（id {nid}）" + (f" — {tree.get(nid).get('desc') or tree.get(nid).get('note')}" if (tree.get(nid).get('desc') or tree.get(nid).get('note')) else ""))
    ctx.append(f"日期：{d}（{'最新一天' if i == len(root.dates) - 1 else '时间机器里选的那天'}）")
    if focus:
        ctx.append(f"这一天本身就是大事：{focus['text']}")
    ctx += [f"天气：{weather_line(root, nid, s, si)}", f"多少钱：{out['facts']['howMuch']}", f"从什么时候：{out['facts']['since']}"]
    if mixed:
        ctx.append(mixed)
    if r and r.get("bigDays"):
        ctx.append("这段里钱最大的几天：" + "；".join(f"{bd['date']} 估算净流 {money(bd['flow'])}、价格 {pct(bd['ret'])}" for bd in r["bigDays"]))
    sib, _ = siblings_line(root, nid, d)
    terms: list[str] = []
    if kind == "stock":
        sj = root.stock_json(nid) or {}
        t = nid[2:]
        terms.append(t)
        f = sj.get("facts") or {}
        px = s.v("px", si)
        lo, hi = num(f.get("low52")), num(f.get("high52"))
        if px is not None:
            ctx.append(f"收盘价 {px:g}" + (f"，52 周区间 {lo:g}–{hi:g}" if lo and hi else "") + f"，60 日 {pct(s.ret(si, 60))}")
        pl, _ = peers_line(root, sj, d)
        vs = sib
        if pl:
            ctx.append(pl)
            vs = (sib + "。" if sib else "") + pl
        out["facts"]["vsNeighbours"] = vs or "没有可比的邻居数据"
    else:
        out["facts"]["vsNeighbours"] = sib or "这是最上面一层，没有同级可比"
        if r:
            a = r["startIndex"]
            c0 = s.dates[max(0, min(a, s.idx_of(r["trigger"]["date"])))]
            cons = contributors(root, nid, a, d, c0)
            if cons:
                ctx.append("这段期间钱主要进出了谁（下一级，估算净流）：" + "；".join(
                    f"{tree.name(c)} {money(f)}（价格 {pct(rr)}）" for c, f, rr in cons[:6]))
                for c, f, _ in cons[:2]:
                    sub = contributors(root, c, a, d, c0)
                    if sub:
                        ctx.append(f"  其中「{tree.get(c).get('name', c)}」里：" + "；".join(
                            f"{tree.name(x)} {money(ff)}" for x, ff, _ in sub[:5]))
                        terms += [x[2:] for x, *_ in sub[:4] if x.startswith("s:")]
                terms += [c[2:] for c, *_ in cons[:5] if c.startswith("s:")]
    if sib:
        ctx.append("同级比较：" + sib)
    out["searchTerms"] = list(dict.fromkeys(terms))[:8]
    reg_dates = sorted({r["trigger"]["date"], r["start"]} | {bd["date"] for bd in r["bigDays"][:2]}) if r else []
    out["searchDates"] = reg_dates
    # the title/question verb: the wind regime, unless the 5-day money clearly says the opposite
    f5, dv20 = s.fsum(si - 4, si), s.avg("dv", si - 19, si) or 0.0
    disagree = bool(r and r["dir"] and dv20 > 0 and abs(f5) >= 0.05 * dv20 and (f5 > 0) != (r["dir"] > 0))
    verb = {1: "钱在流进来", -1: "钱在流出去", 0: "风平浪静"}[r["dir"] if r else 0]
    if r and r.get("fading"):
        verb = "进钱的势头停了" if r["dir"] > 0 else "出逃停了"
    if disagree:
        verb = "份额在降，钱却小幅回流" if r["dir"] < 0 else "关注度在升，钱却没真进来"
    dated = f"{zh_date(d, ref)}" if d != ref else ""
    out["title"] = f"{dated}【{name}】为什么{verb}？" if dated else f"为什么【{name}】{verb}？"
    since = zh_date(r["start"], ref) if r else ""
    trig = r["trigger"] if r else None
    if disagree:
        regq = (f"「{name}」从 {since}（{r['start']}）起{'在成交里的份额一直在降' if r['dir'] < 0 else '在成交里的份额一直在升'}"
                f"（风 {w:+.1f}），但按价格估算近 5 日其实净{'流入' if f5 > 0 else '流出'} {money(abs(f5), False)}。"
                + ("为什么份额在降、钱却小幅回流——是跌多了有人抄底，还是只是别的板块抢走了成交？"
                   if r["dir"] < 0 else "为什么关注度在升、钱却没真进来——是放量下跌、还是换手炒作？")
                + f"份额开始变的那几天（{r['start']} 前后，最猛的一天 {trig['date']}，{_day_move(trig)}）发生了什么？")
    elif r and r.get("fading"):
        regq = (f"「{name}」从 {since}（{r['start']}）开始{'有钱流进来' if r['dir'] > 0 else '钱往外流'}，"
                f"最猛的一天是 {trig['date']}（{_day_move(trig)}）；但 {r['fadeFrom']} 起风减弱到 {r['windNow']:+.1f}。"
                f"先说这波是怎么起来的，再说为什么停了——那几天发生了什么？")
    elif r and r["dir"]:
        regq = (f"为什么「{name}」从 {since}（{r['start']}）开始{'有钱流进来' if r['dir'] > 0 else '钱往外流'}？"
                f"最猛的一天是 {trig['date']}（{_day_move(trig)}，估算净{'流入' if trig['flow'] >= 0 else '流出'} {money(abs(trig['flow']), False)}）。"
                f"那几天到底发生了什么？")
    else:
        regq = (f"「{name}」最近风平浪静（{since} 以来没明显进出），但 {trig['date'] if trig else d} 那天钱动得最大"
                f"（{_day_move(trig) if trig else ''}）。最近有什么值得知道的新闻吗？没有就直说。")
    out["question"] = regq
    if focus:
        # the asked day IS the story: ask about it first, with the date to search, the regime as background
        prev = s.dates[si - 1] if si > 0 else d
        hm = f"（截至美东 {focus['etTime']}）" if focus.get("etTime") else ""
        tw = focus["togetherWord"]
        out["title"] = (f"为什么【{name}】{focus['when']}{focus['move']}" + (f"，{tw}" if tw else "") + "？")
        if dated:
            out["title"] = f"{dated}【{name}】为什么{focus['move']}" + (f"，{tw}" if tw else "") + "？"
        peers = f"，{focus['grp']} {focus['peers']} 同天也{'涨' if focus['ret'] > 0 else '跌'}" if focus["same"] else ""
        first = ("先查整个板块同一天的共同消息（行业新闻、政策、龙头公告、研报、并购传闻），再查它自己的事。" if focus["together"]
                 else "先查它自己的事（公告、财报、合同、评级、大单、Form 4），再看板块和大盘。" if focus["nPeers"] and not focus["same"]
                 else "先查它自己的事，再看同行和板块。")
        if r and r["dir"]:
            bg = (f"背景：这段{'流入' if r['dir'] > 0 else '流出'}从 {since}（{r['start']}）开始"
                  + (f"，之前最猛的一天是 {trig['date']}（{_day_move(trig)}）" if trig and trig["date"] != d else "") + "。")
        else:
            bg = f"背景：{since} 以来风平浪静。" if r else ""
        out["question"] = (f"为什么{focus['when']}（{d}）「{name}」{focus['move']}{hm}{peers}？{first}"
                           f"查 {prev} 收盘后到 {d}（含盘前盘后）的新闻。{bg}")
        out["searchDates"] = list(dict.fromkeys([d, prev] + reg_dates))
        out["regimeQuestion"] = regq
        if r and r["dir"]:
            ctx.append(f"次要问题（在 honest 或 counter 里简短带过即可）：{regq}")
    if out["partial"]:
        ctx.append(out["partial"])
    return out


def build_day(root: DataRoot, nid: str, i: int) -> dict:
    tree = root.tree
    d = root.dates[i]
    s = root.series(nid)
    if s is None or not s.n:
        raise FactsError(f"「{tree.name(nid)}」没有天气数据")
    si = s.idx_of(d)
    if s.dates[si] != d:
        raise FactsError(f"「{tree.name(nid)}」在 {d} 没有交易数据")
    if si < 1 or i < 1:
        raise FactsError("这一天是一年窗口的第一天，前面没数据可比，换一天再问")
    out = _common(root, "day", [nid], i, d)
    name = tree.name(nid)
    ref = root.asOf
    flow = s.v("flow", si) or 0.0
    r1 = s.ret(si)
    dv = s.v("dv", si)
    vx = _vol_x(s, si)
    w, w5 = s.v("wind", si), s.v("wind", si - 5)
    day = {"date": d, "flow": round(flow, 2), "ret": _r4(r1), "dv": round(dv, 2) if dv is not None else None, "volX": vx,
           "wind": w}
    move = _day_move({"ret": r1})
    what = f"{zh_date(d, ref)}【{name}】{move}，估算净{'流入' if flow >= 0 else '流出'} {money(abs(flow), False)}"
    if dv is not None:
        what += f"，成交 {money(dv, False)}" + (f"（平时的 {vx:g} 倍）" if vx else "")
    if s.is_stock:
        o, h, lo, c = (s.v(k, si) for k in ("o", "h", "l", "c"))
        pc = s.v("c", si - 1)
        if None not in (o, h, lo, c, pc) and pc:
            gap = o / pc - 1
            loc = ((c - lo) - (h - c)) / (h - lo) if h > lo else 0.0
            day.update({"open": o, "high": h, "low": lo, "close": c, "prevClose": pc, "gap": round(gap, 4)})
            shape = "收在最高附近" if loc > 0.6 else "收在最低附近" if loc < -0.6 else "收在中间"
            what += f"。开盘{'跳空高开' if gap > 0.02 else '跳空低开' if gap < -0.02 else ''} {pct(gap)}，盘中 {lo:g}–{h:g}，{shape}（收 {c:g}，前收 {pc:g}）"
    nxt = []
    for k in (1, 2, 3):
        if si + k < s.n:
            nxt.append(f"{zh_date(s.dates[si + k], ref)} {pct(s.ret(si + k))}（净流 {money(s.v('flow', si + k))}）")
    prev5 = s.ret(si - 1, 5) if si >= 6 else None
    hm = f"那天之前 5 日价格 {pct(prev5)}、之前 5 日净流 {money(s.fsum(si - 5, si - 1))}"
    if nxt:
        hm += "；之后：" + "；".join(nxt)
    r = regime(s, si)
    rp = regime(s, si - 1) if si > 0 else None          # the regime leading INTO that day
    out["regime"] = r
    out["regimeBefore"] = rp
    out["day"] = day
    wp = s.v("wind", si - 1)
    if rp and rp["dir"]:
        since = (f"那天之前是一段{'流入' if rp['dir'] > 0 else '流出'}期——{regime_text(rp, ref)}；"
                 f"这段累计 {money(rp['cumFlow'])}、价格 {pct(rp['ret'])}")
    elif rp:
        since = "那天之前：" + regime_text(rp, ref)
    else:
        since = "窗口第一天，之前没有数据"
    if wp is not None and w is not None and abs(w - wp) >= 0.3:
        since += f"；当天风从 {wp:+.1f} 变成 {w:+.1f}"
    out["facts"] = {"what": what, "howMuch": hm, "since": since, "vsNeighbours": ""}
    ctx = out["context"]
    ctx.append(f"目标：{tree.path_names(nid) or name}（id {nid}）的单日：{d}" + (f" — {tree.get(nid).get('note') or tree.get(nid).get('desc') or ''}"))
    ctx += [f"那天：{what}", f"前后：{hm}", f"那天的天气：{weather_line(root, nid, s, si)}" + (f"（5 个交易日前风 {w5:+.2f}）" if w5 is not None else ""),
            f"所处阶段：{since}"]
    terms: list[str] = []
    vs = ""
    if s.is_stock:
        sj = root.stock_json(nid) or {}
        terms.append(nid[2:])
        pl, _ = peers_line(root, sj, d)
        par = tree.parent.get(nid)
        ps = root.series(par) if par else None
        if ps:
            pi = ps.idx_of(d)
            vs = f"「{tree.get(par).get('name', par)}」整体当日 {pct(ps.ret(pi))}、估算净流 {money(ps.v('flow', pi))}"
        spy = root.series("us") or root.series("world")
        if spy:
            ui = spy.idx_of(d)
            vs += (f"；美股整体当日 {pct(spy.ret(ui))}" if vs else f"美股整体当日 {pct(spy.ret(ui))}")
        if pl:
            vs += ("。" if vs else "") + pl
        idio = None
        if r1 is not None and ps:
            pr = ps.ret(ps.idx_of(d))
            if pr is not None and abs(r1) > 3 * max(abs(pr), 0.01):
                idio = "这一天是它自己的事（远超同板块），多半有公司层面的消息"
        if idio:
            ctx.append(idio)
    else:
        m = root.map_json(nid)
        rows = []
        for cid, ser in ((m or {}).get("children") or {}).items():
            cs = Series.from_map(ser, root.dates)
            ci = cs.idx_of(d)
            rows.append((cid, cs.v("flow", ci) or 0.0, cs.ret(ci)))
        rows.sort(key=lambda x: -abs(x[1]))
        if rows:
            vs = "那天钱主要进出了：" + "；".join(f"{tree.name(c)} {money(f)}（{pct(rr)}）" for c, f, rr in rows[:5])
            terms += [c[2:] for c, *_ in rows[:5] if c.startswith("s:")]
        sib, _ = siblings_line(root, nid, d)
        if sib:
            vs += ("。" if vs else "") + sib
    out["facts"]["vsNeighbours"] = vs or "没有可比的邻居数据"
    if vs:
        ctx.append(f"邻居：{vs}")
    out["searchTerms"] = list(dict.fromkeys(terms))[:8]
    prev_day = s.dates[si - 1] if si > 0 else d
    out["searchDates"] = [prev_day, d] + ([s.dates[si + 1]] if si + 1 < s.n else [])
    out["title"] = f"{zh_date(d, ref)}【{name}】为什么{move}？"
    nx = f"之后一天 {pct(s.ret(si + 1))}。" if si + 1 < s.n else ""
    out["question"] = (f"为什么 {d} 那天「{name}」{move}、估算净{'流入' if flow >= 0 else '流出'} {money(abs(flow), False)}"
                       + (f"、成交是平时的 {vx:g} 倍" if vx else "") + f"？{nx}"
                       f"查 {prev_day} 收盘后到 {d} 收盘之间（含盘前盘后）的新闻、公告、评级、大单。")
    if out["partial"]:
        ctx.append(out["partial"])
    return out


def _graph() -> dict:
    p = WEB_DATA / "graph" / "edges.json"
    try:
        mt = p.stat().st_mtime
    except OSError:
        return {}
    hit = _graph_cache.get("g")
    if hit and hit[0] == mt:
        return hit[1]
    g = read_json(p) or {}
    _graph_cache["g"] = (mt, g)
    return g


_graph_cache: dict[str, tuple[float, dict]] = {}


def _usd_b(x: Any) -> str:
    v = num(x)
    if v is None:
        return "金额不明"
    return f"约 {v:g} 十亿美元" if v >= 1 else f"约 {v * 1000:.0f} 百万美元"


def build_edge(root: DataRoot, a: str, b: str, etype: str | None, i: int) -> dict:
    g = _graph()
    A, B = a.upper().removeprefix("S:"), b.upper().removeprefix("S:")
    edges = [e for e in (g.get("edges") or []) if {str(e.get("a")).upper(), str(e.get("b")).upper()} == {A, B}]
    if etype:                                   # the clicked tie first; all ties between the pair are covered
        edges.sort(key=lambda e: e.get("type") != etype)
    measured = [e for e in (g.get("measured") or []) if {str(e.get("a")).upper(), str(e.get("b")).upper()} == {A, B}]
    d = root.dates[i]
    _too_early(root, i)
    ids = [A, B]
    out = _common(root, "edge", ids, i, d)
    tree = root.tree
    nm = {x: tree.name("s:" + x) if ("s:" + x) in tree.nodes else _graph_name(g, x) for x in ids}
    ties = []
    for e in edges[:4]:
        mo = e.get("money") or {}
        fr, to = mo.get("from") or e.get("a"), mo.get("to") or e.get("b")
        tie = f"{_TYPE_ZH.get(e.get('type'), e.get('type'))}：{nm.get(str(fr).upper(), fr)} → {nm.get(str(to).upper(), to)}"
        if e.get("type") == "competes":
            tie = f"竞争：{nm.get(A, A)} ⇄ {nm.get(B, B)}"
        if mo.get("usdB") is not None:
            tie += f" 约 {money(num(mo.get('usdB')) * 1000, False)}/{_PER_ZH.get(mo.get('per'), mo.get('per') or '')}"
        if mo.get("what"):
            tie += f"（{mo['what']}）"
        if e.get("since"):
            tie += f"，始于 {e['since']}"
        if e.get("est") or mo.get("est"):
            tie += "【估】"
        ties.append(tie)
        src = e.get("source") or mo.get("source")
        out["context"].append(f"关系：{tie}" + (f"；地图记录的出处：{src}" if src else "") + (f"（记录于 {e.get('asOf')}）" if e.get("asOf") else ""))
        if e.get("say"):
            out["context"].append(f"地图上的点评：{e['say']}")
    if not ties and not measured:
        raise FactsError(f"关系网里没有 {A} 和 {B} 之间的关系")
    weather, short, since = [], [], []
    for x in ids:
        s = root.series("s:" + x)
        if s is None:
            weather.append(f"{nm[x]}：没有价格数据")
            short.append(f"{nm[x]} 没有价格数据")
            continue
        si = s.idx_of(d)
        r = regime(s, si)
        wv = s.v("wind", si)
        weather.append(f"{nm[x]}：{weather_line(root, 's:' + x, s, si)}；{how_much(s, si, r)}；{regime_text(r, root.asOf)}")
        short.append(f"{nm[x]} {wind_word(wv)}（风 {wv or 0:+.1f}），5 日净流 {money(s.fsum(si - 4, si))}、价格 5 日 {pct(s.ret(si, 5))}")
        if r:
            st = zh_date(r["start"], root.asOf)
            since.append(f"{nm[x]}：{st} 起{ {1: '流入', -1: '流出', 0: '风平浪静'}[r['dir']] }（{r['days']} 个交易日）")
            out["searchDates"].append(r["trigger"]["date"])
    meas = []
    for e in measured:
        if e.get("type") == "comove":
            meas.append(f"近 {e.get('window', 120)} 个交易日日涨跌相关 {e.get('corr')}")
        elif e.get("type") == "leadlag":
            meas.append(f"领先滞后：{e.get('source') or e.get('say') or ''}")
    out["facts"] = {"what": "；".join(ties) or f"{nm[A]} 和 {nm[B]} 只有价格上的联动，没有已知的生意往来",
                    "howMuch": "；".join(short),
                    "since": "；".join(since) or "—",
                    "vsNeighbours": "；".join(meas) or "价格上没有测到明显的联动"}
    out["context"] += [f"两边的钱：{w}" for w in weather] + ([f"测量：{m}" for m in meas] if meas else [])
    out["searchTerms"] = ids
    out["searchDates"] = sorted(set(out["searchDates"]))
    out["title"] = (f"{zh_date(d, root.asOf)}【{nm[A]}】和【{nm[B]}】：为什么钱这样走？" if d != root.asOf
                    else f"为什么【{nm[A]}】和【{nm[B]}】之间的钱这样走？")
    out["question"] = (f"「{nm[A]}」和「{nm[B]}」之间这条关系最近有什么变化（新订单、合同续签/取消、价格、竞争、诉讼、合作、投资）？"
                       f"两边最近钱的流向（见上）跟这条关系有没有关系，还是各走各的？关系里的金额如果有更新的公开数字，写进 reasons。")
    return out


_TYPE_ZH = {"buys-from": "采购", "sells-to": "销售", "partner": "合作", "invests-in": "投资", "competes": "竞争",
            "licenses": "授权", "finances": "融资"}
_PER_ZH = {"year": "年", "quarter": "季度", "once": "一次性", "total": "合计"}


def _graph_name(g: dict, t: str) -> str:
    nodes = g.get("nodes")
    if isinstance(nodes, dict):
        n = nodes.get(t) or {}
        return n.get("name") or t
    if isinstance(nodes, list):
        for n in nodes:
            if isinstance(n, dict) and str(n.get("id") or n.get("t")).upper() == t:
                return n.get("name") or t
    return t


def build_channel(root: DataRoot, a: str, b: str, i: int) -> dict:
    tree = root.tree
    d = root.dates[i]
    _too_early(root, i)
    out = _common(root, "channel", [a, b], i, d)
    parts, since, terms = [], [], []
    winds: dict[str, float | None] = {}
    for nid, role in ((a, "流出"), (b, "流入")):
        s = root.series(nid)
        if s is None:
            raise FactsError(f"「{tree.name(nid)}」没有天气数据")
        si = s.idx_of(d)
        winds[nid] = s.v("wind", si)
        r = regime(s, si)
        parts.append(f"【{tree.name(nid)}】{wind_word(s.v('wind', si))}：5 日净流 {money(s.fsum(si - 4, si))}，价格 5 日 {pct(s.ret(si, 5))}")
        since.append(f"{tree.name(nid)}：{regime_text(r, root.asOf)}")
        out["context"].append(f"{role}方 {tree.path_names(nid)}（id {nid}）：{weather_line(root, nid, s, si)}；{how_much(s, si, r)}；{regime_text(r, root.asOf)}")
        if r:
            out["searchDates"].append(r["trigger"]["date"])
            cons = contributors(root, nid, r["startIndex"], d, s.dates[r["startIndex"]])
            if cons:
                out["context"].append(f"  {tree.get(nid).get('name', nid)} 里钱主要进出了：" + "；".join(f"{tree.name(c)} {money(f)}" for c, f, _ in cons[:5]))
                terms += [c[2:] for c, *_ in cons[:3] if c.startswith("s:")]
    par = tree.parent.get(a)
    ps = root.series(par) if par else None
    vs = ""
    if ps:
        pi = ps.idx_of(d)
        vs = f"整个「{tree.get(par).get('name', par)}」：{weather_line(root, par, ps, pi)}，5 日 {pct(ps.ret(pi, 5))}"
    # weak channel (brief.channel.weak, or one side barely moving): don't assume one event drove both sides
    ch = (read_json(WEB_DATA / "brief.json") or {}).get("channel") or {} if root.name == "curated" else {}
    wa, wb = winds.get(a), winds.get(b)
    weak = bool(ch.get("weak") and ch.get("from") == a and ch.get("to") == b and d == root.asOf) or \
        wa is None or wb is None or wa > -0.5 or wb < 0.5
    out["weak"] = weak
    A_, B_ = tree.name(a), tree.name(b)
    what = f"钱从【{A_}】流向【{B_}】"
    if weak:
        what += (f"（这条航道不明显：{A_} 风 {wa if wa is not None else 0:+.1f}、{B_} 风 {wb if wb is not None else 0:+.1f}，"
                 "可能是两件各自的事碰巧同时发生）")
    out["facts"] = {"what": what, "howMuch": "；".join(parts),
                    "since": "；".join(since), "vsNeighbours": vs or "—"}
    out["searchTerms"] = terms[:8]
    out["searchDates"] = sorted(set(out["searchDates"]))
    dated = f"{zh_date(d, root.asOf)}：" if d != root.asOf else ""
    if weak:
        out["title"] = f"{dated}【{A_}】在漏、【{B_}】在吸——是同一件事吗？"
        out["question"] = (f"这几天「{A_}」在漏钱、「{B_}」在吸钱，但这条航道不明显。先判断：是同一个原因把钱从「{A_}」推到「{B_}」"
                           f"（宏观、利率、美元、风险偏好、再平衡），还是两边各有各的事碰巧同时发生？"
                           f"如果是两件事，reasons 里分开写（各自带日期和来源），honest 里直说「不是一条航道，是两件事」；"
                           f"如果确实是一件事，给出能对上两边日期的那件事。")
    else:
        out["title"] = f"{dated}为什么钱从【{A_}】流向【{B_}】？"
        out["question"] = (f"为什么这几天钱从「{A_}」撤出、流向「{B_}」？是宏观（利率、美元、数据、央行）、"
                           f"政策、财报季、还是纯资金面的轮动/再平衡？给出能对上日期的具体事件；"
                           f"如果两边其实是两件独立的事，就直说。")
    if out["partial"]:
        out["context"].append(out["partial"])
    return out


def build_landing(root: DataRoot, nid: str, sid: str | None, i: int) -> dict:
    base = build_node(root, nid, i)
    out = dict(base)
    out["kind"] = "landing"
    out["ids"] = [nid] + ([sid] if sid else [])
    sc = None
    if sid and re.match(r"^[A-Za-z0-9_\-]{4,64}$", sid):
        sc = read_json(WEB_DATA / "scenarios" / f"{sid}.json")
    name = root.tree.name(nid)
    if isinstance(sc, dict):
        nd = (sc.get("nodes") or {}).get(nid) or {}
        land = next((x for x in (sc.get("landing") or []) if x.get("id") == nid), {}) or {}
        root_txt = (sc.get("root") or {}).get("text") or sc.get("title") or ""
        dirw = "受益（钱会流进来）" if (nd.get("dir") or land.get("dir") or 0) > 0 else "受损（钱会流出去）"
        why = land.get("why") or nd.get("why") or ""
        line = (f"推演「{sc.get('title') or root_txt}」（根：{root_txt}，日期 {(sc.get('root') or {}).get('date') or '?'}）认为【{name}】{dirw}，"
                f"{land.get('lagZh') or nd.get('lag') or ''}见效；理由：{why}；抢跑度 {nd.get('pricedIn', land.get('pricedIn'))}（0=市场还没算，1=早算进去了），"
                f"时间差 {nd.get('gap', land.get('gap'))}")
        if land.get("check") or nd.get("check"):
            line += f"；认错线：{land.get('check') or nd.get('check')}"
        out["context"] = [line] + list(base["context"])
        out["facts"] = dict(base["facts"])
        out["facts"]["vsNeighbours"] = (base["facts"].get("vsNeighbours") or "") + f"。推演：{dirw}，抢跑度 {nd.get('pricedIn', land.get('pricedIn'))}"
        out["question"] = (f"推演说「{root_txt}」成真时【{name}】会{dirw}。最近有没有带日期的新闻/数据表明市场已经开始按这个逻辑给它定价"
                           f"（或者恰恰相反）？现在地图上它{wind_word(base['regime']['windNow'] if base.get('regime') else None)}，原因是什么？")
    else:
        out["question"] = base["question"]
    out["title"] = (f"{zh_date(out['date'], root.asOf)}落点【{name}】：那时为什么这样？" if out["date"] != root.asOf
                    else f"落点【{name}】：现在为什么这样？")
    return out


def build_market(root: DataRoot, mid: str) -> dict:
    mk, src = None, None
    for f, label in (("polymarket.json", "Polymarket"), ("kalshi.json", "Kalshi")):
        pm = read_json(WEB_DATA / f) or {}
        for m in pm.get("markets") or []:
            if str(m.get("id")) == mid or m.get("slug") == mid:
                mk, src = m, (label, pm.get("asOf"))
                break
        if mk:
            break
    if not mk:
        raise FactsError(f"预言市场里找不到 {mid}")
    as_of = str(src[1] or root.asOf or "")[:10]
    i = len(root.dates) - 1
    out = _common(root, "market", [str(mk.get("id") or mid)], i, as_of or root.dates[i])
    out["date"] = as_of or out["date"]
    prob = num(mk.get("prob"))
    d1, d7, d30 = (num(mk.get(k)) for k in ("d1", "d7", "d30"))

    def pp(x):
        return "—" if x is None else f"{x * 100:+.1f} 个百分点"
    q = mk.get("qZh") or mk.get("q")
    what = f"{src[0]}「{q}」现在概率 {prob * 100:.0f}%" if prob is not None else f"{src[0]}「{q}」"
    hm = f"1 天 {pp(d1)}，7 天 {pp(d7)}，30 天 {pp(d30)}；成交量约 {num(mk.get('volume')) or 0:,.0f} 美元"
    since = ""
    if prob is not None and d7 is not None:
        since = f"一周前约 {(prob - d7) * 100:.0f}%" + (f"，一个月前约 {(prob - d30) * 100:.0f}%" if d30 is not None else "")
    nodes = mk.get("nodes") or []
    tree = root.tree
    nn = []
    for n in nodes[:5]:
        nid = n.get("id")
        if nid in tree.nodes:
            nn.append(f"{tree.name(nid)}（{'YES 利好' if (n.get('sign') or 0) > 0 else 'YES 利空'}，{wind_word(tree.get(nid).get('now', {}).get('wind'))}）")
    out["facts"] = {"what": what, "howMuch": hm, "since": since or "—",
                    "vsNeighbours": ("地图上相关的地方：" + "；".join(nn)) if nn else "这个市场没有映射到地图上的地方"}
    out["context"] = [f"市场：{mk.get('q')}（中文：{mk.get('qZh')}）", f"概率：{what}；{hm}；{since}",
                      f"结束日 {mk.get('endDate')}；链接 {mk.get('url')}"] + ([out["facts"]["vsNeighbours"]] if nn else [])
    out["title"] = f"为什么「{q}」的概率这样动？"
    out["question"] = (f"预言市场「{mk.get('q')}」概率一周{pp(d7)}、一个月{pp(d30)}。是哪些带日期的新闻/数据推动的？"
                       f"这些新闻对地图上的钱（{('、'.join(nn)) or '相关板块'}）意味着什么？")
    out["searchTerms"] = [str(mk.get("q"))[:80]]
    return out


# ═════════════════════════════════════════════════════════════════════════ targets & keys
def normalize_target(raw: Any) -> dict:
    """Accepts {kind, ids:[…]|id, dateIndex?|date?, map?} (also a bare node id / 'DNA' / 'a>b:type' string).
    Returns {kind, ids, dateIndex, date, map} with ids resolved against the map's tree where possible."""
    if isinstance(raw, str):
        raw = {"kind": "edge", "ids": [raw]} if ">" in raw else {"kind": "node", "ids": [raw]}
    if not isinstance(raw, dict):
        raise FactsError("target 格式不对：要 {kind, ids, dateIndex?}")
    kind = str(raw.get("kind") or "node").strip().lower()
    if kind not in KINDS:
        raise FactsError(f"不认识的 kind：{kind}（只能是 {' / '.join(KINDS)}）")
    ids = raw.get("ids")
    if ids is None:
        ids = [x for x in (raw.get("id"), raw.get("a"), raw.get("b"), raw.get("from"), raw.get("to")) if x]
    if isinstance(ids, str):
        ids = [x for x in re.split(r"[,\s]+", ids) if x]
    ids = [str(x).strip() for x in (ids or []) if str(x).strip()][:4]
    # extras the page may send (ui/why.js wire()): edge {a,b,type}, scenario id, market id, day date
    ed = raw.get("edge") if isinstance(raw.get("edge"), dict) else {}
    if kind == "edge" and len(ids) < 2 and ed.get("a") and ed.get("b"):
        ids = [str(ed["a"]), str(ed["b"])]
    if kind == "landing" and len(ids) == 1 and isinstance(raw.get("scenario"), (str, dict)):
        sc = raw["scenario"]
        sid = sc.get("id") if isinstance(sc, dict) else sc
        if sid:
            ids.append(str(sid))
    if kind == "market" and not ids and raw.get("market"):
        mk = raw["market"]
        ids = [str(mk.get("id") if isinstance(mk, dict) else mk)]
    if kind == "day" and not raw.get("date") and isinstance(raw.get("day"), str):
        raw = dict(raw, date=raw["day"])
    mp = MAP_ALIASES.get(str(raw.get("map") or ""), str(raw.get("map") or "curated"))
    if mp not in MAPS:
        mp = "curated"
    etype = (raw.get("type") or ed.get("type")) if kind == "edge" else None
    if kind == "edge" and len(ids) == 1 and ">" in ids[0]:
        m = re.match(r"^([^>]+)>([^:]+)(?::(.+))?$", ids[0])
        if m:
            ids, etype = [m.group(1), m.group(2)], etype or m.group(3)
    if kind == "channel" and not ids:                  # today's 主航道: brief.channel, else strongest out → in
        ch = (read_json(WEB_DATA / "brief.json") or {}).get("channel") or {}
        ids = [x for x in (ch.get("from"), ch.get("to")) if x]
        if len(ids) < 2:
            r0 = data_root(mp)
            kids = [(c, num((r0.tree.get(c).get("now") or {}).get("wind"))) for c in r0.tree.children.get("world", [])]
            kids = sorted([(c, w) for c, w in kids if w is not None], key=lambda cw: cw[1])
            if len(kids) >= 2:
                ids = [kids[0][0], kids[-1][0]]
    if not ids:
        raise FactsError("target 里缺 ids")
    root = data_root(mp)
    if not root.exists():
        if mp != "curated":
            raise FactsError(f"「{ {'full': '全市场', 'global': '全球'}.get(mp, mp) }」地图还没有数据")
        raise FactsError("地图还没有数据（先跑一次 update.sh）")
    tree = root.tree
    if kind in ("node", "stock", "day", "landing"):
        nid = tree.resolve(ids[0])
        if not nid and mp == "curated":                       # a ticker only in the full market
            alt = data_root("full")
            if alt.exists() and alt.tree.resolve(ids[0]):
                root, mp, nid = alt, "full", alt.tree.resolve(ids[0])
        if not nid:
            raise FactsError(f"地图上找不到「{ids[0]}」")
        ids = [nid] + ids[1:2] if kind == "landing" else [nid]
        if kind == "node" and root.tree.is_stock(nid):
            kind = "stock"
        if kind == "stock" and not root.tree.is_stock(nid):
            kind = "node"
    elif kind == "channel":
        if len(ids) < 2:
            raise FactsError("主航道要两个 id：from 和 to")
        rr = [tree.resolve(x) for x in ids[:2]]
        if not all(rr):
            raise FactsError(f"地图上找不到「{ids[rr.index(None)]}」")
        ids = rr
    elif kind == "edge":
        if len(ids) < 2:
            raise FactsError("关系要两个公司：a 和 b（或 'A>B:type'）")
        ids = [re.sub(r"^[sS]:", "", x).upper() if not x.startswith("p:") else x for x in ids[:2]]
    i = root.date_index(raw.get("dateIndex"), raw.get("date"))
    out = {"kind": kind, "ids": ids, "dateIndex": i, "date": root.dates[i], "map": mp}
    if etype:
        out["type"] = str(etype)
    return out


def make_key(kind: str, ids: list[str], mp: str, d: str, etype: str | None = None) -> str:
    """Cache key: target + the data day it is about. 's:DNA' → 's_DNA'; edge pairs sorted (A–B == B–A).
    e.g. 'node~health-synbio~2026-10-27', 'day~s_DNA~2026-10-06', 'edge~DNA+TWST~2026-10-27', 'full~node~fm-tech~…'."""
    ids = list(ids)
    if kind == "edge":                          # one card per company pair (A–B == B–A, all tie types)
        ids = sorted(ids[:2])
    part = "+".join(ids)
    s = ("" if mp == "curated" else f"{mp}~") + f"{kind}~{part}~{d}"
    s = s.replace("s:", "s_").replace("p:", "p_")
    s = re.sub(r"[^A-Za-z0-9._+~=\-]", "_", s)
    if len(s) > 140:
        s = s[:100] + "~" + hashlib.sha1(s.encode()).hexdigest()[:12]
    return s


KEY_RE = re.compile(r"^[A-Za-z0-9._+~=\-]{3,160}$")


def build(target: Any) -> dict:
    t = normalize_target(target)
    root = data_root(t["map"])
    i, kind, ids = t["dateIndex"], t["kind"], t["ids"]
    if kind in ("node", "stock"):
        out = build_node(root, ids[0], i)
    elif kind == "day":
        out = build_day(root, ids[0], i)
    elif kind == "edge":
        out = build_edge(root, ids[0], ids[1], t.get("type"), i)
    elif kind == "channel":
        out = build_channel(root, ids[0], ids[1], i)
    elif kind == "landing":
        out = build_landing(root, ids[0], ids[1] if len(ids) > 1 else None, i)
    else:
        out = build_market(root, ids[0])
    out["target"] = t
    out["key"] = make_key(out["kind"], out["ids"], root.name, out["date"], t.get("type"))
    return out


def key_for(target: Any) -> tuple[str, dict]:
    """The cache key for a target without building the facts (cheap; used by peek)."""
    t = normalize_target(target)
    kind, ids, d = t["kind"], list(t["ids"]), t["date"]
    if kind == "market":
        for f in ("polymarket.json", "kalshi.json"):
            pm = read_json(WEB_DATA / f) or {}
            m = next((m for m in pm.get("markets") or [] if str(m.get("id")) == ids[0] or m.get("slug") == ids[0]), None)
            if m:
                ids = [str(m.get("id") or ids[0])]
                d = str(pm.get("asOf") or d)[:10] or d
                break
    elif kind == "landing":
        ids = ids[:2]
    return make_key(kind, ids, t["map"], d, t.get("type")), t
