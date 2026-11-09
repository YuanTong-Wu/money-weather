"""polymarket/common.py: paths, polite HTTP, the map's tree, small helpers.

Read-only public data only (gamma-api and clob prices-history). No login, no keys, no trading.
"""
from __future__ import annotations

import json
import math
import os
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT_DIR = HERE / "out"
CACHE_DIR = HERE / "cache"
HIST_DIR = CACHE_DIR / "hist"
OUT_FILE = OUT_DIR / "polymarket.json"
TRANSLATIONS = HERE / "translations.json"
MAPPING = HERE / "mapping.json"
LOG_FILE = CACHE_DIR / "requests.log"

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
UA = "money-weather/0.1 (personal research, read-only, local use)"


class Refused(RuntimeError):
    """The server said no (403) or kept rate-limiting (429). We stop instead of hammering."""


_log_lock = threading.Lock()


def _log(code, url, extra=""):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with _log_lock, open(LOG_FILE, "a") as f:
            f.write(f"{datetime.now().strftime('%Y-%m-%dT%H:%M:%S')}\t{code}\t{url[:300]}\t{extra}\n")
    except Exception:
        pass


def get_json(url: str, params: dict | None = None, *, retries: int = 4, timeout: int = 60):
    """GET → parsed JSON. Retries timeouts / 5xx / 429 with backoff; raises Refused on 403 or
    a 429 that does not go away."""
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    delay = 1.5
    last = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            return json.loads(body)
        except urllib.error.HTTPError as e:
            last = e
            _log(e.code, url)
            if e.code == 403:
                raise Refused(f"403 from {url[:120]}")
            if e.code in (400, 404, 422):
                raise  # our request is wrong; retrying will not help
            if e.code == 429 and attempt == retries:
                raise Refused(f"429 (rate limited) from {url[:120]}")
        except Exception as e:  # timeouts, resets, bad JSON
            last = e
            _log(-1, url, repr(e)[:120])
        if attempt < retries:
            time.sleep(delay + random.random() * 0.5)
            delay *= 2
    raise RuntimeError(f"GET failed after {retries + 1} tries: {url[:120]}: {last!r}")


# --------------------------------------------------------------------------------------------
# the map's tree (web/data/tree.json, else universe/universe.json, else universe/parts/*.json)
# --------------------------------------------------------------------------------------------
class Tree:
    def __init__(self):
        self.nodes: dict[str, dict] = {}     # id → {name, emoji, parent, depth, tags, kind, ticker}
        self.children: dict[str, list[str]] = {}
        self.tickers: dict[str, list[str]] = {}  # ticker → leaf region ids it sits under
        self.source = None

    @classmethod
    def load(cls) -> "Tree":
        t = cls()
        cand = [ROOT / "web" / "data" / "tree.json", ROOT / "universe" / "universe.json"]
        for fp in cand:
            if fp.exists():
                try:
                    d = json.loads(fp.read_text())
                    root = d if isinstance(d, dict) and d.get("id") else (d.get("tree") if isinstance(d, dict) else None)
                    if isinstance(root, dict) and root.get("id"):
                        t._walk(root, None, 0)
                        t.source = str(fp.relative_to(ROOT))
                        break
                    if isinstance(d, list):
                        for n in d:
                            t._walk(n, "world", 1)
                        t.source = str(fp.relative_to(ROOT))
                        break
                except Exception:
                    continue
        if not t.nodes:
            for fp in sorted((ROOT / "universe" / "parts").glob("*.json")):
                try:
                    arr = json.loads(fp.read_text())
                except Exception:
                    continue
                for n in arr if isinstance(arr, list) else []:
                    parent = "us" if n.get("id") not in ("intl", "bonds", "commod", "crypto", "cash") else "world"
                    t._walk(n, parent, 2 if parent == "us" else 1)
            if t.nodes:
                for cid, name in (("world", "地球"), ("us", "美股")):
                    t.nodes.setdefault(cid, {"name": name, "emoji": "", "parent": None if cid == "world" else "world",
                                             "depth": 0 if cid == "world" else 1, "tags": [], "kind": "region"})
                t.source = "universe/parts"
        return t

    def _walk(self, n: dict, parent: str | None, depth: int):
        nid = n.get("id")
        if not nid:
            if n.get("t"):  # a stock entry in a part file
                nid = "s:" + n["t"]
            else:
                return
        kind = n.get("kind") or ("stock" if nid.startswith("s:") else "region")
        ticker = n.get("ticker") or n.get("t")
        if nid not in self.nodes:
            self.nodes[nid] = {"name": n.get("name") or nid, "emoji": n.get("emoji") or "", "parent": parent,
                               "depth": n.get("depth", depth), "tags": n.get("tags") or [], "kind": kind,
                               "ticker": ticker, "desc": n.get("desc") or n.get("note") or ""}
        if parent:
            self.children.setdefault(parent, [])
            if nid not in self.children[parent]:
                self.children[parent].append(nid)
        if kind == "stock" and ticker and parent:
            self.tickers.setdefault(ticker, [])
            if parent not in self.tickers[ticker]:
                self.tickers[ticker].append(parent)
        for c in n.get("children") or []:
            self._walk(c, nid, depth + 1)
        for s in n.get("stocks") or []:
            self._walk(s, nid, depth + 1)

    def has(self, nid: str) -> bool:
        return nid in self.nodes

    def resolve(self, nid: str) -> str | None:
        """An id from a rule or from Claude → an id that exists. Falls back up the kebab-case
        naming convention ('industrial-gold' → 'industrial') so a renamed region still lands."""
        if not nid:
            return None
        if nid in self.nodes:
            return nid
        if nid.startswith("s:"):
            return None
        parts = nid.split("-")
        while len(parts) > 1:
            parts = parts[:-1]
            cand = "-".join(parts)
            if cand in self.nodes:
                return cand
        return None

    def name(self, nid: str) -> str:
        n = self.nodes.get(nid)
        return n["name"] if n else nid

    def ancestors(self, nid: str) -> list[str]:
        out = []
        p = self.nodes.get(nid, {}).get("parent")
        while p:
            out.append(p)
            p = self.nodes.get(p, {}).get("parent")
        return out

    def regions(self) -> list[str]:
        return [k for k, v in self.nodes.items() if v["kind"] != "stock"]


# --------------------------------------------------------------------------------------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(s) -> datetime | None:
    if not s:
        return None
    try:
        s = str(s).replace("Z", "+00:00")
        if len(s) == 10:
            s += "T00:00:00+00:00"
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def fnum(x, default=None):
    try:
        v = float(x)
        if math.isnan(v) or math.isinf(v):
            return default
        return v
    except (TypeError, ValueError):
        return default


def jload(s, default):
    if isinstance(s, (list, dict)):
        return s
    try:
        return json.loads(s) if s else default
    except Exception:
        return default


def read_json(fp: Path, default):
    try:
        return json.loads(Path(fp).read_text())
    except Exception:
        return default


def write_json(fp: Path, obj, indent=None):
    """Atomic write, never NaN/Infinity."""
    fp = Path(fp)
    fp.parent.mkdir(parents=True, exist_ok=True)
    tmp = fp.with_suffix(fp.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=indent, allow_nan=False,
                              separators=None if indent else (",", ":")))
    os.replace(tmp, fp)
