"""liquidity/net.py: polite HTTP for public data (FRED csv, Treasury fiscal-data API), with a file cache.

No keys, read-only. A browser-like User-Agent gets blocked by FRED's bot filter, so we say who we are.
Every fetch is cached on disk; when the network fails the stale copy is used and the caller is told.
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = "money-weather/0.1 (personal research, read-only, local use)"


class FetchError(RuntimeError):
    pass


def _urllib(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _curl(url: str, timeout: float) -> bytes:
    p = subprocess.run(["curl", "-gsS", "--http1.1", "-m", str(int(timeout)), "-A", UA, url],
                       capture_output=True, timeout=timeout + 10)
    if p.returncode != 0 or not p.stdout:
        raise FetchError(f"curl rc={p.returncode}: {p.stderr.decode(errors='replace')[:160]}")
    return p.stdout


def get_bytes(url: str, params: dict | None = None, *, retries: int = 3, timeout: float = 40) -> bytes:
    """GET with retries + backoff; falls back to curl (HTTP/1.1) when urllib keeps failing."""
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params, safe=":,()[]'$ ")
        url = url.replace(" ", "%20")
    last = None
    delay = 1.5
    for attempt in range(retries):
        try:
            return _urllib(url, timeout)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 401, 403, 404):
                break
        except Exception as e:  # timeouts, resets
            last = e
        time.sleep(delay + random.random())
        delay *= 2
    try:
        return _curl(url, timeout)
    except Exception as e:
        raise FetchError(f"GET failed: {url[:140]}: {last!r} / {e!r}")


def cached(fp: Path, max_age_s: float, fetch, *, force: bool = False, log=print) -> tuple[bytes | None, dict]:
    """→ (body, info). info = {source: 'cache'|'net'|'stale'|'none', age_s, error?}"""
    fp = Path(fp)
    age = time.time() - fp.stat().st_mtime if fp.exists() else None
    if not force and age is not None and age < max_age_s:
        return fp.read_bytes(), {"source": "cache", "age_s": round(age)}
    try:
        body = fetch()
        fp.parent.mkdir(parents=True, exist_ok=True)
        tmp = fp.with_suffix(fp.suffix + f".tmp{os.getpid()}")
        tmp.write_bytes(body)
        os.replace(tmp, fp)
        return body, {"source": "net", "age_s": 0}
    except Exception as e:
        if fp.exists():
            log(f"  ! {fp.name}: network failed ({str(e)[:100]}); using the cached copy ({round((age or 0) / 3600, 1)} h old)")
            return fp.read_bytes(), {"source": "stale", "age_s": round(age or 0), "error": str(e)[:200]}
        return None, {"source": "none", "error": str(e)[:200]}


def write_json(fp: Path, obj, indent=None):
    """Atomic write, never NaN/Infinity."""
    fp = Path(fp)
    fp.parent.mkdir(parents=True, exist_ok=True)
    tmp = fp.with_suffix(fp.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=indent, allow_nan=False,
                              separators=None if indent else (",", ":")))
    os.replace(tmp, fp)


def read_json(fp: Path, default):
    try:
        return json.loads(Path(fp).read_text())
    except Exception:
        return default
