#!/usr/bin/env python3
"""Fetch company profile (HQ address) for every ticker, one cache file per ticker.

Used by build_hq.py; can also be run alone:
    python3 geodata/fetch_profiles.py                 # fetch everything not cached yet
    python3 geodata/fetch_profiles.py --refresh-missing   # re-fetch cached tickers with no city/country
    python3 geodata/fetch_profiles.py --only NVDA,DNA

Source: Yahoo Finance quoteSummary (the same endpoint yfinance's Ticker.info uses), but only the
modules we need: assetProfile (address/city/state/zip/country), quoteType (EQUITY/ETF/...),
fundProfile (Morningstar category for ETFs). One small request per ticker, 7 polite threads,
global back-off on HTTP 429.

Cache: geodata/cache/yf/<safe ticker>.json
    {"t", "at", "status": ok|notfound|error, "http", "qt", "name", "exch", "a1", "a2", "city",
     "state", "zip", "country", "ind", "sector", "cat", "fam", "legal"}
"""
import argparse
import json
import logging
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, 'cache', 'yf')
TREES = [('curated', 'web/data/tree.json'), ('full', 'web/data/fm/tree.json'), ('global', 'web/data/gl/tree.json')]
QS_URL = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/'
MODULES = 'assetProfile,quoteType,fundProfile'


def safe_name(t):
    return ''.join(c if (c.isalnum() or c in '.-_^=') else '_%02X' % ord(c) for c in t)


def cache_path(t):
    return os.path.join(CACHE, safe_name(t) + '.json')


def read_cache(t):
    p = cache_path(t)
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def write_cache(t, rec):
    os.makedirs(CACHE, exist_ok=True)
    p = cache_path(t)
    tmp = p + '.tmp%d' % threading.get_ident()
    with open(tmp, 'w') as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, p)


def tree_tickers():
    """Ordered union of stock tickers in the three trees (curated first)."""
    seen = {}
    for tag, rel in TREES:
        with open(os.path.join(ROOT, rel)) as f:
            tree = json.load(f)
        stack = [tree]
        while stack:
            n = stack.pop()
            if n.get('kind') == 'stock' and n.get('ticker'):
                seen.setdefault(n['ticker'], tag)
            stack.extend(reversed(n.get('children') or []))
    return list(seen)


def needs_refresh(rec):
    """A cached record worth re-asking Yahoo about."""
    if rec is None:
        return True
    if rec.get('status') == 'error':
        return True
    if rec.get('status') == 'notfound':
        return True
    if rec.get('qt') in ('ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY', 'CURRENCY', 'FUTURE'):
        return False  # funds have no address by design
    return not (rec.get('city') and rec.get('country'))


class Fetcher:
    def __init__(self, workers=7):
        import yfinance as yf  # noqa: F401  (import here so --help is instant)
        from yfinance.data import YfData
        for name in ('yfinance', 'yfinance.data'):
            logging.getLogger(name).setLevel(logging.CRITICAL)
        self.data = YfData()
        self.workers = workers
        self.pause_until = 0.0
        self.lock = threading.Lock()
        self.n429 = 0
        self.fails = 0          # consecutive transport failures across threads
        self.last_reset = 0.0
        self.resets = 0

    def _note(self, ok):
        """A wedged connection pool shows up as a run of timeouts: start a fresh session + crumb."""
        with self.lock:
            if ok:
                self.fails = 0
                return
            self.fails += 1
            if self.fails >= 4 and time.time() - self.last_reset > 20:
                try:
                    from curl_cffi import requests as creq
                    self.data._set_session(creq.Session(impersonate='chrome'))
                    self.data._crumb = None
                    self.data._cookie = None
                except Exception:
                    pass
                self.last_reset = time.time()
                self.resets += 1
                self.fails = 0

    def _wait_global(self):
        while True:
            with self.lock:
                d = self.pause_until - time.time()
            if d <= 0:
                return
            time.sleep(min(d, 5))

    def fetch_one(self, t):
        rec = {'t': t, 'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
        last = None
        for attempt in range(4):
            self._wait_global()
            time.sleep(random.uniform(0.05, 0.25))
            try:
                r = self.data.get(QS_URL + t, params={'modules': MODULES, 'formatted': 'false',
                                                      'corsDomain': 'finance.yahoo.com', 'symbol': t}, timeout=12)
                code = r.status_code
            except Exception as e:  # includes YFRateLimitError
                name = type(e).__name__
                code = 429 if 'RateLimit' in name or 'Too Many' in str(e) else -1
                last = '%s: %s' % (name, str(e)[:160])
                r = None
            self._note(code in (200, 404))
            if code == 200:
                try:
                    j = r.json()
                    res = (j.get('quoteSummary') or {}).get('result') or []
                except Exception as e:
                    last = 'json: %s' % e
                    time.sleep(1 + attempt)
                    continue
                if not res:
                    rec.update(status='notfound', http=200)
                    return rec
                res = res[0]
                ap = res.get('assetProfile') or {}
                qt = res.get('quoteType') or {}
                fp = res.get('fundProfile') or {}
                rec.update(status='ok', http=200, qt=qt.get('quoteType'),
                           name=qt.get('longName') or qt.get('shortName'), exch=qt.get('exchange'),
                           a1=ap.get('address1'), a2=ap.get('address2'), city=ap.get('city'),
                           state=ap.get('state'), zip=ap.get('zip'), country=ap.get('country'),
                           ind=ap.get('industry'), sector=ap.get('sector'),
                           cat=fp.get('categoryName'), fam=fp.get('family'), legal=fp.get('legalType'))
                return rec
            if code == 404:
                rec.update(status='notfound', http=404)
                return rec
            if code == 429:
                with self.lock:
                    self.n429 += 1
                    back = min(300, 20 * (2 ** min(attempt, 4)))
                    self.pause_until = max(self.pause_until, time.time() + back)
                last = 'HTTP 429'
                continue
            last = last or 'HTTP %s' % code
            time.sleep(1.5 * (attempt + 1))
        rec.update(status='error', err=last)
        return rec

    def run(self, tickers, log=print):
        done = 0
        t0 = time.time()
        stats = {'ok': 0, 'notfound': 0, 'error': 0}
        with ThreadPoolExecutor(self.workers) as ex:
            futs = {ex.submit(self.fetch_one, t): t for t in tickers}
            for fu in as_completed(futs):
                t = futs[fu]
                try:
                    rec = fu.result()
                except Exception as e:
                    rec = {'t': t, 'status': 'error', 'err': repr(e)[:200]}
                old = read_cache(t)
                # never overwrite a good record with a transient failure
                if not (rec.get('status') == 'error' and old and old.get('status') == 'ok'):
                    write_cache(t, rec)
                stats[rec.get('status', 'error')] = stats.get(rec.get('status', 'error'), 0) + 1
                done += 1
                if done % 100 == 0 or done == len(tickers):
                    el = time.time() - t0
                    log('  fetched %d/%d  %s  429s=%d resets=%d  %.0fs (%.1f/s)' % (
                        done, len(tickers), stats, self.n429, self.resets, el, done / max(el, 1e-6)))
        return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh-missing', action='store_true')
    ap.add_argument('--refresh-all', action='store_true')
    ap.add_argument('--only', default='')
    ap.add_argument('--workers', type=int, default=7)
    a = ap.parse_args()
    tickers = [x for x in a.only.split(',') if x] or tree_tickers()
    if a.refresh_all or a.only:
        todo = tickers
    elif a.refresh_missing:
        todo = [t for t in tickers if needs_refresh(read_cache(t))]
    else:
        todo = [t for t in tickers if read_cache(t) is None]
    print('tickers %d, to fetch %d' % (len(tickers), len(todo)), flush=True)
    if todo:
        Fetcher(a.workers).run(todo, log=lambda s: print(s, flush=True))


if __name__ == '__main__':
    sys.exit(main())
