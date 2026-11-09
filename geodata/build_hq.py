#!/usr/bin/env python3
"""Build web/data/geo/hq.json — where every company in the three trees really is.

    python3 geodata/build_hq.py                    # fetch what is not cached yet, then build
    python3 geodata/build_hq.py --refresh-missing  # re-ask Yahoo (and cninfo) for tickers that came out
                                                   # without an exact city, then build
    python3 geodata/build_hq.py --no-fetch         # rebuild from cache only (fast, offline)
    python3 geodata/build_hq.py --check NVDA,DNA   # print how a few tickers resolve

Pipeline: tickers from web/data/{tree,fm/tree,gl/tree}.json + private graph nodes (web/data/graph/p_*.json)
 → profiles (Yahoo quoteSummary assetProfile/quoteType/fundProfile; cache/yf/) → A-share gaps from cninfo
 via akshare (cache/cninfo/) → geocode with GeoNames cities15000 (+ tables/extra_places.tsv) → fallbacks
 (state/province point, then country point, est:true) → funds classified (country / region / non-geographic)
 → web/data/geo/hq.json + geodata/report.json. See geodata/README.md for the output contract.
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import geo_tables as T  # noqa: E402
import fetch_profiles as FP  # noqa: E402

OUT = os.path.join(ROOT, 'web', 'data', 'geo', 'hq.json')
REPORT = os.path.join(HERE, 'report.json')
CNINFO_CACHE = os.path.join(HERE, 'cache', 'cninfo')
TABLES = os.path.join(HERE, 'tables')
TREES = FP.TREES

try:
    from unidecode import unidecode
except Exception:  # pragma: no cover
    def unidecode(s):
        return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
try:
    import opencc
    _T2S = opencc.OpenCC('t2s')
    t2s = _T2S.convert
except Exception:  # pragma: no cover
    def t2s(s):
        return s

CJK_RE = re.compile(r'[㐀-鿿豈-﫿]')
# Japanese shinjitai that OpenCC t2s leaves alone
JP2ZH = str.maketrans({'豊': '丰', '沢': '泽', '広': '广', '浜': '滨', '栄': '荣', '鉄': '铁', '関': '关', '徳': '德',
                       '恵': '惠', '歩': '步', '竜': '龙', '済': '济', '総': '总', '辺': '边', '亜': '亚', '桜': '樱',
                       '県': '县', '黒': '黑', '発': '发', '検': '检', '険': '险', '労': '劳', '営': '营', '覚': '觉',
                       '戸': '户', '瀬': '濑', '巣': '巢', '縄': '绳', '児': '儿', '斎': '斋', '蔵': '藏', '穂': '穗',
                       '芸': '艺', '塩': '盐', '宮': '宫', '岡': '冈'})
KANA_HANGUL_RE = re.compile(r'[぀-ヿ가-힯ᄀ-ᇿ]')


# ------------------------------------------------------------------------------------------------
# names
def norm(s):
    if s is None:
        return ''
    s = str(s).strip()
    if CJK_RE.search(s):
        s = t2s(re.sub(r'\s+', '', s))
        return s
    s = unidecode(s).lower()
    s = s.replace('&', ' and ')
    s = re.sub(r"[’'`\.]", '', s)
    s = re.sub(r'[\-_/,()]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'^saint ', 'st ', s)
    s = re.sub(r'^sainte ', 'ste ', s)
    s = re.sub(r'^fort ', 'ft ', s)
    s = re.sub(r'^mount ', 'mt ', s)
    return s


SUFFIXES = [' city', ' shi', ' si', ' gun', ' ku', ' district', ' town', ' municipality', ' county',
            ' prefecture', ' new district', ' new area', ' borough', ' village', ' cho', ' machi', ' eup', ' myeon',
            ' dong', ' gu', ' qu', ' xian', ' zhen', ' shire', ' am main', ' an der ruhr']
CJK_SUFFIXES = ['特别行政区', '自治州', '自治县', '新区', '市', '县', '区', '镇', '乡', '都', '府', '郡']


def variants(n):
    """Weaker spellings of an already-normalised name (suffix stripped)."""
    out = []
    if not n:
        return out
    if CJK_RE.search(n):
        for suf in CJK_SUFFIXES:
            if n.endswith(suf) and len(n) - len(suf) >= 2:
                out.append(n[:-len(suf)])
                break
        return out
    for suf in SUFFIXES:
        if n.endswith(suf) and len(n) - len(suf) >= 3:
            out.append(n[:-len(suf)].strip())
    if n.startswith('city of '):
        out.append(n[8:])
    return out


def km(lon1, lat1, lon2, lat2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2 +
         math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(min(1, math.sqrt(a)))


# ------------------------------------------------------------------------------------------------
# gazetteer
class Gaz:
    """GeoNames cities (cities15000 + any cities1000/5000/500 dropped into geodata/) + hand gazetteer."""

    def __init__(self):
        self.rows = []  # dict(id, name, lat, lon, fcode, cc, a1, pop, cjk)
        self.idx = defaultdict(list)  # (cc, key) -> [(level, row_i)]
        files = [os.path.join(HERE, 'cities15000.txt')]
        for extra in ('cities5000.txt', 'cities1000.txt', 'cities500.txt'):
            p = os.path.join(HERE, extra)
            if os.path.exists(p):
                files.append(p)
        seen = set()
        for path in files:
            with open(path, encoding='utf-8') as f:
                for line in f:
                    c = line.rstrip('\n').split('\t')
                    if len(c) < 15 or c[0] in seen:
                        continue
                    seen.add(c[0])
                    self._add(dict(id=c[0], name=c[1], ascii=c[2], alts=c[3], lat=float(c[4]), lon=float(c[5]),
                                   fcode=c[7], cc=c[8], a1=c[10], pop=int(c[14] or 0), src='geonames'))
        self.n_geonames = len(self.rows)
        self.by_cc = defaultdict(list)
        for i, r in enumerate(self.rows):
            self.by_cc[r['cc']].append(i)
        self._a1_cache = {}
        # hand gazetteer: name, country, state (check only), lat, lon, zh, extra spellings (comma-separated)
        # admin1 is taken from the nearest GeoNames city of the same country, which doubles as a sanity check.
        self.extra_rows = 0
        self.extra_warnings = []
        p = os.path.join(TABLES, 'extra_places.tsv')
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                for ln, line in enumerate(f, 1):
                    if not line.strip() or line.startswith('#'):
                        continue
                    c = [x.strip() for x in line.rstrip('\n').split('\t')]
                    c += [''] * (7 - len(c))
                    name, cc, state, lat, lon, zh, alts = c[:7]
                    lat, lon = float(lat), float(lon)
                    near = self.nearest(lon, lat, cc)
                    a1 = near[1]['a1'] if near else ''
                    if not near or near[0] > 250:
                        self.extra_warnings.append('extra_places.tsv:%d %s/%s is %.0f km from any %s city' % (
                            ln, name, cc, near[0] if near else -1, cc))
                    if state and cc in T.STATE_CAPITALS:
                        cap_a1 = self.admin1_of_capital(cc, T.STATE_CAPITALS[cc].get(state.lower()) or
                                                        T.STATE_CAPITALS[cc].get(state) or '')
                        if cap_a1:
                            a1 = cap_a1
                        else:
                            self.extra_warnings.append('extra_places.tsv:%d unknown state %r' % (ln, state))
                    if cc == 'US' and state:
                        if state != a1 and near and near[0] > 40:
                            self.extra_warnings.append('extra_places.tsv:%d %s says %s but nearest city (%s, %.0f km) '
                                                       'is in %s' % (ln, name, state, near[1]['name'], near[0], a1))
                        a1 = state
                    i = len(self.rows)
                    self._add(dict(id='x:%s:%s:%s' % (name, cc, state), name=name, ascii=unidecode(name),
                                   alts=','.join(x for x in (alts, zh) if x), lat=lat, lon=lon, fcode='PPL',
                                   cc=cc, a1=a1, pop=0, src='manual', zh=zh or None))
                    self.by_cc[cc].append(i)
                    self.extra_rows += 1
        for w in self.extra_warnings:
            print('  ! ' + w)

    def _add(self, r):
        i = len(self.rows)
        self.rows.append(r)
        cc = r['cc']
        names0 = {norm(r['name']), norm(r['ascii'])}
        alts = [a for a in (r['alts'] or '').split(',') if a]
        r['cjk'] = [a for a in alts if CJK_RE.search(a) and not KANA_HANGUL_RE.search(a)]
        names1 = set()
        for a in alts:
            if len(a) <= 3 and a.isupper():
                continue  # airport / abbreviation codes
            names1.add(norm(a))
        for n in names0:
            if n:
                self.idx[(cc, n)].append((0, i))
                for v in variants(n):
                    self.idx[(cc, v)].append((2, i))
        for n in names1 - names0:
            if n:
                self.idx[(cc, n)].append((1, i))
                if CJK_RE.search(n):  # suffix-stripped alternate names only for CJK (仁怀市 -> 仁怀)
                    for v in variants(n):
                        self.idx[(cc, v)].append((3, i))

    def lookup(self, name, cc, a1=None, strict_a1=False, near=None):
        """Best row for a city name inside a country (and admin1 if given; or within `near`=(lon, lat, km)).
        Returns (row, level) or (None, None)."""
        if not name or not cc:
            return None, None
        q = norm(name)
        keys = [(q, 0)]
        al = T.CITY_ALIASES.get(cc, {}).get(q) or T.CITY_ALIASES['*'].get(q)
        if al:
            keys.insert(0, (norm(al), 0))
        keys += [(v, 2) for v in variants(q)]
        best = None
        for key, penalty in keys:
            cands = self.idx.get((cc, key))
            if not cands:
                continue
            if near:
                cands = [(lv, i) for lv, i in cands
                         if km(near[0], near[1], self.rows[i]['lon'], self.rows[i]['lat']) <= near[2]]
                if not cands:
                    continue
            if a1:
                in_a1 = [(lv, i) for lv, i in cands if self.rows[i]['a1'] == a1]
                if in_a1:
                    cands = in_a1
                elif strict_a1:
                    continue
            for lv, i in cands:
                r = self.rows[i]
                score = (lv + penalty, -(r['pop'] if r['src'] == 'geonames' else 10 ** 9),
                         r['fcode'] == 'PPLX')
                if best is None or score < best[0]:
                    best = (score, i)
            if best:
                break
        if best is None:
            return None, None
        return self.rows[best[1]], best[0][0]

    def admin1_of_capital(self, cc, capital):
        key = (cc, capital)
        if key not in self._a1_cache:
            r, _ = self.lookup(capital, cc)
            self._a1_cache[key] = r['a1'] if r else None
        return self._a1_cache[key]

    def area_point(self, cc, a1=None):
        """Population-weighted centre of a country (or one admin1 inside it), snapped to the nearest real city
        so it is always on land. Returns the row."""
        key = ('pt', cc, a1)
        if key in self._a1_cache:
            return self._a1_cache[key]
        rows = [self.rows[i] for i in self.by_cc.get(cc, []) if self.rows[i]['src'] == 'geonames'
                and (a1 is None or self.rows[i]['a1'] == a1) and self.rows[i]['fcode'] != 'PPLX']
        res = None
        if rows:
            w = sum(max(r['pop'], 1) for r in rows)
            # mean on the unit sphere (handles countries across the antimeridian)
            x = y = z = 0.0
            for r in rows:
                la, lo = math.radians(r['lat']), math.radians(r['lon'])
                k = max(r['pop'], 1) / w
                x += k * math.cos(la) * math.cos(lo)
                y += k * math.cos(la) * math.sin(lo)
                z += k * math.sin(la)
            lon = math.degrees(math.atan2(y, x))
            lat = math.degrees(math.atan2(z, math.hypot(x, y)))
            big = sorted(rows, key=lambda r: -r['pop'])[:max(8, len(rows) // 4)]
            res = min(big, key=lambda r: km(lon, lat, r['lon'], r['lat']))
        elif cc in T.TINY_CAPITALS:
            nm, lo, la = T.TINY_CAPITALS[cc]
            res = dict(id='tiny:' + cc, name=nm, lat=la, lon=lo, cc=cc, a1='', pop=0, src='manual', cjk=[])
        self._a1_cache[key] = res
        return res

    def main_city(self, cc):
        rows = [self.rows[i] for i in self.by_cc.get(cc, []) if self.rows[i]['src'] == 'geonames']
        if rows:
            caps = [r for r in rows if r['fcode'] == 'PPLC']
            return (caps or sorted(rows, key=lambda r: -r['pop']))[0]
        if cc in T.TINY_CAPITALS:
            nm, lo, la = T.TINY_CAPITALS[cc]
            return dict(id='tiny:' + cc, name=nm, lat=la, lon=lo, cc=cc, a1='', pop=0, src='manual', cjk=[])
        return None

    def nearest(self, lon, lat, cc=None):
        best = None
        for i in (self.by_cc.get(cc, []) if cc else range(len(self.rows))):
            r = self.rows[i]
            if r['src'] != 'geonames':
                continue
            d = km(lon, lat, r['lon'], r['lat'])
            if best is None or d < best[0]:
                best = (d, r)
        return best

    @staticmethod
    def zh(r):
        if r.get('zh'):
            return r['zh']
        # Mainland usage first: a name already written in simplified characters (圣迭戈) beats a traditional /
        # Taiwanese / Japanese one converted to simplified (聖地牙哥 -> 圣地牙哥, 豊田 -> 丰田).
        cands = Counter()
        simp = Counter()
        for a in r.get('cjk') or []:
            if any(ch in a for ch in '()（）,，·'):
                continue
            s = t2s(a.translate(JP2ZH))
            orig_simplified = (a == s)
            for suf in ('特别行政区', '市'):
                if s.endswith(suf) and len(s) > len(suf) + 1:
                    s = s[:-len(suf)]
            if 1 < len(s) <= 8:
                cands[s] += 1
                if orig_simplified:
                    simp[s] += 1
        if not cands:
            return None
        return sorted(cands.items(), key=lambda kv: (-simp[kv[0]], -kv[1], len(kv[0])))[0][0]


SMALL_TOWN_FILES = [os.path.join(HERE, 'geonames.nosync', 'txt', 'cities1000.txt'),
                    os.path.join(HERE, 'geonames.nosync', 'txt', 'cities5000.txt')]


class SmallTowns(Gaz):
    """GeoNames towns of 1,000+ people (cities1000, or cities5000) that are NOT in cities15000. Used only as a last
    resort before a state / country fallback, with the state Yahoo gave (strict), so no other company moves."""

    def __init__(self, big):  # noqa  (deliberately not calling Gaz.__init__)
        self.rows, self.idx, self.by_cc = [], defaultdict(list), defaultdict(list)
        self._a1_cache = {}
        self.n_geonames = 0
        self.extra_rows = 0
        have = {r['id'] for r in big.rows}
        path = next((p for p in SMALL_TOWN_FILES if os.path.exists(p)), None)
        self.source = os.path.basename(path) if path else None
        if not path:
            return
        with open(path, encoding='utf-8') as f:
            for line in f:
                c = line.rstrip('\n').split('\t')
                if len(c) < 15 or c[0] in have:
                    continue
                i = len(self.rows)
                self._add(dict(id=c[0], name=c[1], ascii=c[2], alts=c[3], lat=float(c[4]), lon=float(c[5]),
                               fcode=c[7], cc=c[8], a1=c[10], pop=int(c[14] or 0), src='geonames'))
                self.by_cc[c[8]].append(i)
        self.n_geonames = len(self.rows)

    def town(self, name, cc, a1=None, near=None):
        """A small town with this name: in the given state (strict), or near (lon, lat, km), or the only one with
        that name in the country. Exact / alternate-name matches only (no suffix-stripped guesses)."""
        if not name or not cc or not self.rows:
            return None
        r, lv = self.lookup(name, cc, a1, strict_a1=a1 is not None, near=near)
        if r is None or lv not in (0, 1):
            return None
        if a1 is None and near is None:
            q = norm(name)
            hits = {i for lv2, i in self.idx.get((cc, q), []) if lv2 in (0, 1)}
            if len(hits) != 1:
                return None
        return r


# ------------------------------------------------------------------------------------------------
COUNTRY_BY_NAME = {v[1].lower(): k for k, v in T.COUNTRIES.items()}
COUNTRY_BY_NAME.update(T.COUNTRY_ALIASES)


def country_iso(name):
    if not name:
        return None
    n = name.strip().lower()
    if n in COUNTRY_BY_NAME:
        return COUNTRY_BY_NAME[n]
    n2 = unidecode(n)
    return COUNTRY_BY_NAME.get(n2)


def suffix_country(t):
    m = re.search(r'\.([A-Z]+)$', t)
    if not m:
        return 'US'
    return T.SUFFIX_COUNTRY.get(m.group(1))


# ------------------------------------------------------------------------------------------------
# inputs
def load_trees():
    """ticker -> ctx {trees:set, top:set(top-level ids per tree), names:[...], mkt, cap}"""
    ctx = {}
    per_tree = {}
    for tag, rel in TREES:
        with open(os.path.join(ROOT, rel)) as f:
            tree = json.load(f)
        lst = []
        stack = [(tree, [])]
        while stack:
            n, path = stack.pop()
            if n.get('kind') == 'stock' and n.get('ticker'):
                t = n['ticker']
                c = ctx.setdefault(t, {'trees': set(), 'top': set(), 'path': set(), 'names': [], 'mkt': None,
                                       'cap': 0, 'tags': set()})
                c['trees'].add(tag)
                if len(path) > 1:
                    c['top'].add(path[1])
                c['path'].update(path)
                for k in ('name', 'en', 'note'):
                    if n.get(k):
                        c['names'].append(n[k])
                c['mkt'] = c['mkt'] or n.get('mkt')
                c['cap'] = max(c['cap'], n.get('cap') or 0)
                c['dv'] = max(c.get('dv') or 0, (n.get('now') or {}).get('dv20') or 0)
                c['tags'].update(n.get('tags') or [])
                lst.append(t)
            for ch in reversed(n.get('children') or []):
                stack.append((ch, path + [n['id']]))
        per_tree[tag] = list(dict.fromkeys(lst))
    return ctx, per_tree


def load_private():
    out = {}
    for p in glob.glob(os.path.join(ROOT, 'web', 'data', 'graph', 'p_*.json')):
        try:
            with open(p) as f:
                g = json.load(f)
        except Exception:
            continue
        pid = g.get('id') or g.get('t')
        if pid and pid.startswith('p:'):
            out[pid] = {'name': g.get('name') or '', 'note': g.get('note') or ''}
    return out


def load_tsv(name, ncols):
    p = os.path.join(TABLES, name)
    rows = []
    if not os.path.exists(p):
        return rows
    with open(p, encoding='utf-8') as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            c = [x.strip() for x in line.rstrip('\n').split('\t')]
            c += [''] * (ncols - len(c))
            rows.append(c[:ncols])
    return rows


# ------------------------------------------------------------------------------------------------
# cninfo (A-shares) — registered/office address in Chinese
def cninfo_path(code):
    return os.path.join(CNINFO_CACHE, code + '.json')


def cninfo_get(code):
    p = cninfo_path(code)
    if os.path.exists(p):
        try:
            with open(p) as f:
                return json.load(f)
        except Exception:
            return None
    return None


def cninfo_fetch(codes, workers=4, log=print):
    import akshare as ak
    os.makedirs(CNINFO_CACHE, exist_ok=True)

    def one(code):
        for attempt in range(3):
            try:
                df = ak.stock_profile_cninfo(symbol=code)
                if df is None or df.empty:
                    rec = {'code': code, 'status': 'notfound'}
                else:
                    r = df.iloc[0]
                    rec = {'code': code, 'status': 'ok', 'office': str(r.get('办公地址') or ''),
                           'reg': str(r.get('注册地址') or ''), 'zip': str(r.get('邮政编码') or ''),
                           'name': str(r.get('公司名称') or '')}
                break
            except Exception as e:
                rec = {'code': code, 'status': 'error', 'err': str(e)[:160]}
                time.sleep(2 * (attempt + 1))
        rec['at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        with open(cninfo_path(code), 'w') as f:
            json.dump(rec, f, ensure_ascii=False)
        time.sleep(0.2)
        return rec

    n = 0
    with ThreadPoolExecutor(workers) as ex:
        for _ in ex.map(one, codes):
            n += 1
            if n % 100 == 0 or n == len(codes):
                log('  cninfo %d/%d' % (n, len(codes)))


CN_ADDR_TOKEN = re.compile(r'([\u4e00-\u9fff]{2,7}?)(市|县|区|旗|自治州|地区|盟)')


# ------------------------------------------------------------------------------------------------
class Resolver:
    def __init__(self, gaz, small=None):
        self.g = gaz
        self.small = small      # SmallTowns (cities1000/5000): only used inside fallback()
        self.overrides = {r[0]: r for r in load_tsv('overrides.tsv', 6)}  # ticker, city, cc, state, kind, cat
        self.private = {r[0]: r for r in load_tsv('private.tsv', 6)}      # id, city, cc, state, kind, cat
        self.ops = {r[0]: r for r in load_tsv('ops.tsv', 5)}              # ticker, city|'=', cc, state, note
        self.districts = {cc: {norm(k): v for k, v in d.items()} for cc, d in T.DISTRICTS.items()}
        self.why = {}
        self.reg = {}           # ticker -> [city, cc] of the registered office when ops.tsv moved it
        self.ops_warnings = []
        # business capitals (set by build() after a first pass): cc -> row, (cc, a1) -> row
        self.biz = None
        self.biz_state = None

    # ---- helpers
    def entry(self, r, cc, est, kind=None, cat=None, city=None):
        e = [round(r['lon'], 4), round(r['lat'], 4), city or r['name'], cc, bool(est)]
        if kind and kind != 'hq':
            e.append(kind)
            if cat:
                e.append(cat)
        e_meta = {'row': r}
        return e, e_meta

    def state_a1(self, cc, state, zipc=None):
        if cc == 'US':
            if state:
                s = state.strip()
                if len(s) == 2:
                    return s.upper()
                return T.US_STATE_NAMES.get(s.lower())
            return None
        if cc == 'CN':
            cap = None
            if state:
                cap = T.STATE_CAPITALS['CN'].get(state.strip().lower()) or T.STATE_CAPITALS['CN'].get(state.strip())
            if not cap and zipc:
                z = re.sub(r'\D', '', str(zipc))
                if len(z) == 6:
                    cap = T.CN_POSTAL.get(z[:2])
            return self.g.admin1_of_capital('CN', cap) if cap else None
        if state and cc in T.STATE_CAPITALS:
            cap = T.STATE_CAPITALS[cc].get(state.strip().lower())
            if cap:
                return self.g.admin1_of_capital(cc, cap)
        return None

    # Exchange suffix -> the business city an unplaced Chinese company most likely sits in.
    CN_SUFFIX_CITY = {'SS': 'Shanghai', 'SZ': 'Shenzhen', 'BJ': 'Beijing', 'HK': 'Shenzhen'}

    def country_point(self, cc, t=None):
        """Where a company known only by its country goes: the country's BUSINESS capital — the city with the most
        exact HQs in this build (GB London, KR Seoul, CA Toronto …) — not its population centre, which put piles of
        London trusts near Nuneaton and KOSDAQ names in Cheongju. US -> New York City; CN by exchange suffix
        (.SS Shanghai, .SZ Shenzhen, .BJ Beijing, .HK Shenzhen: the mainland city next to Hong Kong, since the
        company is still in CN). First pass (biz unknown) and countries without any exact HQ: the capital, else
        the population centre."""
        if cc == 'US':
            r, _ = self.g.lookup('New York City', 'US', 'NY')
            if r:
                return r
        if cc == 'CN' and t:
            m = re.search(r'\.([A-Z]+)$', t)
            name = self.CN_SUFFIX_CITY.get(m.group(1)) if m else None
            if name:
                r, _ = self.g.lookup(name, 'CN')
                if r:
                    return r
        if self.biz and self.biz.get(cc):
            return self.biz[cc]
        return self.g.main_city(cc) or self.g.area_point(cc)

    def state_point(self, cc, a1):
        """A company known only by its state/province: that state's city with the most exact HQs (Texas -> Houston,
        not Killeen); else the population centre of the state snapped to a real city."""
        if self.biz_state and self.biz_state.get((cc, a1)):
            return self.biz_state[(cc, a1)]
        return self.g.area_point(cc, a1)

    def fallback(self, cc, a1, city_label, why, citystate=True, t=None):
        """State point, else (tiny territory) its main city, else the country point. The city slot keeps the
        name Yahoo gave (it is still the true town name) or null — never the name of the stand-in point."""
        if city_label and self.small is not None and why in ('nocity', 'jp-nocity') and cc not in T.CITY_STATES:
            near = None
            if cc == 'JP' and a1:  # wards / towns repeat across Japan: stay near the postcode's prefecture capital
                cap = next((self.g.rows[i] for i in self.g.by_cc.get('JP', []) if self.g.rows[i]['a1'] == a1
                            and self.g.rows[i]['fcode'] == 'PPLA'), None)
                near = (cap['lon'], cap['lat'], 150) if cap else None
            r = self.small.town(city_label, cc, None if near else a1, near)
            if r is not None:
                self.why_set(why + '>smalltown')
                return self.entry(r, cc, False)
        if city_label and self.g.lookup(city_label, cc)[0] is not None:
            city_label = None  # the name exists elsewhere in the country (postcode disagrees): don't label it
        if a1:
            r = self.state_point(cc, a1)
            if r:
                self.why_set(why + '>state')
                e, m = self.entry(r, cc, True, 'state')
                e[2] = city_label or None
                return e, m
        if citystate and cc in T.CITY_STATES:
            r = self.g.main_city(cc)
            if r:
                self.why_set(why + '>citystate')
                return self.entry(r, cc, False)
        r = self.country_point(cc, t)
        if r:
            self.why_set(why + '>country')
            e, m = self.entry(r, cc, True, 'approx')
            e[2] = city_label or None
            return e, m
        return None, None

    def why_set(self, w):
        self._why = w

    # ---- companies
    def company(self, t, rec, ctx, use_cninfo=True):
        """Resolve a company. tables/ops.tsv (operating HQ) wins over Yahoo's registered office; the place Yahoo
        gave is then kept in self.reg[t] = [city, cc] (shown as 注册地 on the hover card)."""
        op = self.ops.get(t)
        if not op or op[1] == '=':
            return self._company(t, rec, ctx, use_cninfo)
        reg_e, _ = self._company(t, rec, ctx, use_cninfo)
        _, ocity, occ, ostate, _note = op
        e, m = self._company(t, {}, ctx, use_cninfo=False, ov=(t, ocity, occ, ostate, '', ''))
        if e is None or len(e) != 5 or e[4]:
            self.ops_warnings.append('ops.tsv: %s %r/%s did not resolve to an exact city (%s)' % (
                t, ocity, occ, e and e[2:]))
        self._why = 'ops'
        if reg_e and e and reg_e[0] is not None and (reg_e[2], reg_e[3]) != (e[2], e[3]):
            self.reg[t] = [reg_e[2], reg_e[3]]
        return e, m

    def _company(self, t, rec, ctx, use_cninfo=True, ov=None):
        self._why = ''
        rec = rec or {}
        ov = ov or self.overrides.get(t)
        cc = None
        city = rec.get('city')
        state = rec.get('state')
        if ov:
            _, ocity, occ, ostate, okind, ocat = ov
            if okind in ('country', 'region', 'nongeo'):
                return self.fund_entry(t, okind, occ or None, ocat or None, why='override')
            city, cc, state = ocity or city, occ or cc, ostate or state
        cc = cc or country_iso(rec.get('country'))
        if cc == 'US' and state and state.strip().upper() in T.US_TERRITORIES:
            cc, state = T.US_TERRITORIES[state.strip().upper()], None
        if not cc and rec.get('country'):
            self._unknown_country = rec.get('country')
        if not cc:
            mk = (ctx or {}).get('mkt')
            cc = T.MKT_COUNTRY.get(mk) if mk else None
            if cc and not city and not (cc == 'CN' and use_cninfo and cninfo_get(t[:6])):
                return self.fallback(cc, None, None, 'mkt-only', citystate=False, t=t)
            if not cc:
                return None, None
        a1 = self.state_a1(cc, state, rec.get('zip'))
        if cc == 'JP':
            # wards repeat across Japan: anchor on the postcode's prefecture capital
            z = re.sub(r'\D', '', str(rec.get('zip') or ''))
            capname = T.JP_POSTAL.get(z[:2]) if len(z) == 7 else None
            cap = self.g.lookup(capname, 'JP')[0] if capname else None
            if cap:
                a1 = cap['a1']
                if city:
                    r, lv = self.g.lookup(city, 'JP', near=(cap['lon'], cap['lat'], 400 if capname == 'Sapporo' else 150))
                    if r:
                        self.why_set('city-jp')
                        return self.entry(r, cc, False)
                    if norm(city) in T.JP_WARD_CITIES or norm(city).endswith(' ku'):
                        self.why_set('jp-ward')
                        return self.entry(cap, cc, False)
                return self.fallback(cc, a1, city, 'jp-nocity', t=t)
        if city:
            r, lv = self.g.lookup(city, cc, a1, strict_a1=(cc in ('US', 'CN') and a1 is not None))
            if r:
                self.why_set('city' + ('' if lv in (0, 1) else '~'))
                return self.entry(r, cc, False)
            # a district of a big city ("Haidian", "Nanshan", "Zhongli", "Hsitun" …)
            d = self.districts.get(cc, {}).get(norm(city))
            if d:
                for parent in (d if isinstance(d, list) else [d]):
                    r, lv = self.g.lookup(parent, cc, a1, strict_a1=(cc == 'CN' and a1 is not None))
                    if r:
                        self.why_set('district')
                        return self.entry(r, cc, False)
                if isinstance(d, list) and not a1:
                    r, lv = self.g.lookup(d[0], cc)
                    if r:
                        self.why_set('district')
                        return self.entry(r, cc, False)
            # a province given as the city ("Tibet", "Jiangsu")
            if cc == 'CN' and T.STATE_CAPITALS['CN'].get(norm(city)):
                a1 = a1 or self.g.admin1_of_capital('CN', T.STATE_CAPITALS['CN'][norm(city)])
                city = None  # "Jiangsu" is not a town
        # Chinese address from cninfo (A-shares)
        if cc == 'CN' and use_cninfo and re.match(r'^\d{6}\.(SS|SZ)$', t):
            ci = cninfo_get(t[:6])
            if ci and ci.get('status') == 'ok':
                res = self.cn_address(ci.get('office'), a1) or self.cn_address(ci.get('reg'), a1)
                if res:
                    return res
                a1 = self.cn_province(ci) or a1
        # tokens of the street address (not for US/CA: street names collide with towns)
        if (a1 or cc == 'TW') and cc not in ('US', 'CA', 'GB', 'AU') and (rec.get('a1') or rec.get('a2')):
            for part in (rec.get('a2'), rec.get('a1')):
                if not part:
                    continue
                for tok in re.split(r'[,;]| No\.? | Road| Rd| Street| St\b', part):
                    tok = re.sub(r'\b(District|Science Park|Industrial Park|Zone|Town|Village|City)\b', '', tok).strip()
                    if len(tok) < 4 or re.search(r'\d', tok):
                        continue
                    r, lv = self.g.lookup(tok, cc, a1, strict_a1=a1 is not None)
                    if r and lv in (0, 1, 2):
                        self.why_set('addr')
                        return self.entry(r, cc, True, 'near')
        return self.fallback(cc, a1, city, 'nocity', t=t)

    CN_PROV_SUFFIX = ('维吾尔自治区', '壮族自治区', '回族自治区', '自治区', '特别行政区', '省', '市', '')
    CN_MUNICIPALITIES = {'北京', '上海', '天津', '重庆'}

    def cn_split_province(self, addr):
        """'湖北省武汉市武昌区…' -> (admin1 of Hubei, capital name, '武汉市武昌区…')."""
        a = re.sub(r'^\s*中国\s*[（(]?', '', addr or '')
        for en, zh, cap, _ in T.CN_PROVINCES:
            for suf in self.CN_PROV_SUFFIX:
                if a.startswith(zh + suf):
                    return self.g.admin1_of_capital('CN', cap), cap, a[len(zh + suf):].lstrip('）) ')
        return None, None, a

    def cn_province(self, ci):
        for addr in (ci.get('office'), ci.get('reg')):
            a1, _, _ = self.cn_split_province(addr or '')
            if a1:
                return a1
        z = re.sub(r'\D', '', ci.get('zip') or '')
        if len(z) == 6 and z[:2] in T.CN_POSTAL:
            return self.g.admin1_of_capital('CN', T.CN_POSTAL[z[:2]])
        return None

    def cn_address(self, addr, a1_hint):
        """Geocode a Chinese address. Its own province wins over the Yahoo postcode (they sometimes disagree)."""
        if not addr:
            return None
        addr = re.split(r'[；;]', addr)[0]
        a1, cap, rest = self.cn_split_province(addr)
        if cap and addr.lstrip('中国（( ').startswith(tuple(self.CN_MUNICIPALITIES)):
            r, _ = self.g.lookup(cap, 'CN')
            if r:
                self.why_set('cninfo')
                return self.entry(r, 'CN', False)
        a1 = a1 or a1_hint
        toks = [m.group(1) + m.group(2) for m in CN_ADDR_TOKEN.finditer(rest)]
        cities = [x for x in toks if x[-1] in '市县旗']
        # most specific first (the county-level city), then the prefecture it sits in
        for k, tok in enumerate(reversed(cities)):
            r, lv = self.g.lookup(tok, 'CN', a1, strict_a1=a1 is not None)
            if r:
                exact = (k == 0)
                self.why_set('cninfo' + ('' if exact else '-prefecture'))
                return self.entry(r, 'CN', not exact, None if exact else 'near')
        # "宜兴经济技术开发区…", "张家港保税区…", "苏州片区": a place name in front of a zone word
        heads = [rest[:n] for n in (4, 3, 2)]
        for tok in reversed(toks):
            for suf in ('经济技术开发区', '高新技术产业开发区', '高新区', '开发区', '保税区', '工业园区', '片区', '新区'):
                if tok.endswith(suf) and 2 <= len(tok) - len(suf) <= 4:
                    heads.append(tok[:-len(suf)])
        for head in heads:
            if len(head) >= 2 and CJK_RE.match(head) and all(CJK_RE.match(ch) for ch in head):
                r, lv = self.g.lookup(head, 'CN', a1, strict_a1=a1 is not None)
                if r:
                    self.why_set('cninfo-head')
                    return self.entry(r, 'CN', False)
        return None

    # ---- funds
    def fund_entry(self, t, kind, cc=None, cat=None, why='fund'):
        self._why = why
        if kind == 'country' and cc:
            r = self.g.area_point(cc)
            if r:
                return [round(r['lon'], 4), round(r['lat'], 4), None, cc, True, 'country', 'etf'], {'row': r}
        if kind == 'region' and cat in T.REGIONS:
            pts = [self.g.area_point(c) for c in T.REGIONS[cat][2]]
            pts = [p for p in pts if p]
            x = y = z = 0.0
            for p in pts:
                la, lo = math.radians(p['lat']), math.radians(p['lon'])
                x += math.cos(la) * math.cos(lo)
                y += math.cos(la) * math.sin(lo)
                z += math.sin(la)
            lon = math.degrees(math.atan2(y, x))
            lat = math.degrees(math.atan2(z, math.hypot(x, y)))
            # label anchor only (shade regions[cat].iso): snap to the member country nearest the mean
            p = min(pts, key=lambda p: km(lon, lat, p['lon'], p['lat']))
            return [round(p['lon'], 4), round(p['lat'], 4), T.REGIONS[cat][0], None, True, 'region', cat], {}
        return [None, None, None, cc, True, 'nongeo', cat or 'broad'], {}

    def fund(self, t, rec, ctx):
        """Classify an ETF / fund. Returns (entry, meta, sub)."""
        names = [rec.get('name') or ''] + list((ctx or {}).get('names') or [])
        raw = ' | '.join(n for n in names if n)
        low = ' ' + unidecode(raw).lower() + ' '
        home = suffix_country(t)
        top = (ctx or {}).get('top') or set()
        mcat = T.category_of_morningstar(rec.get('cat'))
        sub = None

        def hit(k, lo, ra):
            if re.match(r'^[\x00-\x7f]+$', k):
                return re.search(r'(?<![a-z0-9])' + re.escape(k) + r'(?![a-z0-9])', lo) is not None
            return k in ra

        # 1) non-geographic families (the curated tree branch already says so; then keywords; then Morningstar)
        cat = None
        for top_id, c in T.TREE_NONGEO.items():
            if top_id in top:
                cat = c
        for k, c, s_ in T.FUND_KEYWORDS:
            if hit(k, low, raw) and (cat is None or cat == c):
                cat, sub = cat or c, s_
                break
        if mcat in ('bonds', 'cash', 'crypto', 'commodities') and (cat is None or cat not in T.TREE_NONGEO.values()):
            cat = mcat
        if cat in ('bonds', 'cash', 'crypto', 'commodities'):
            return self.fund_entry(t, 'nongeo', self.fund_country(low, raw, hit) or home, cat) + (sub,)

        # 2) equity exposure. Exclusions first ("ex-US", "不含美国", "美国以外") so they do not read as the country.
        lo, ra = low, raw
        ex = set()
        for pat, tag in ((r'(?<![a-z])ex[- ]?(u\.?s\.?a?|united states)(?![a-z])', 'us'), (r'(?<![a-z])ex[- ]?japan', 'japan'),
                         (r'(?<![a-z])ex[- ]?china', 'china'), (r'(?<![a-z])ex[- ]?(uk|u\.k\.)(?![a-z])', 'uk')):
            if re.search(pat, lo):
                ex.add(tag)
                lo = re.sub(pat, ' ', lo)
        for word, tag in (('美国', 'us'), ('美國', 'us'), ('日本', 'japan'), ('中国', 'china'), ('中國', 'china')):
            for pat in ('不含' + word, '除了' + word, '除' + word, word + '以外', word + '除外'):
                if pat in ra:
                    ex.add(tag)
                    ra = ra.replace(pat, ' ')
        region = None
        if 'china' in ex and (hit('emerging', lo, ra) or '新兴' in ra):
            region = 'em-ex-china'
        elif 'japan' in ex and (hit('asia', lo, ra) or '亚洲' in ra or 'アジア' in ra):
            region = 'asia-ex-japan'
        elif 'us' in ex:
            region = 'dev-ex-us' if (hit('developed', lo, ra) or hit('eafe', lo, ra) or '发达' in ra) else 'world-ex-us'
        cc = self.fund_country(lo, ra, hit)
        if region is None and not cc:
            for k, rg in T.FUND_REGION_WORDS:
                if hit(k, lo, ra):
                    region = rg
                    break
        if region and not (cc and region in ('greater-china',)):
            return self.fund_entry(t, 'region', None, region) + (sub,)
        if cc and cc != home:
            # a single named foreign country ("iShares MSCI Brazil", 纳指ETF on Shanghai) -> that country
            return self.fund_entry(t, 'country', cc) + (sub,)
        is_sector = mcat == 'sector' or any(hit(w, lo, ra) for w in T.SECTOR_WORDS)
        if hit('global', lo, ra) or hit('world', lo, ra) or hit('acwi', lo, ra) or '全球' in ra or '全世界' in ra:
            return self.fund_entry(t, 'nongeo', None, 'sector' if is_sector else 'broad') + (sub,)
        return self.fund_entry(t, 'nongeo', cc or home, 'sector' if is_sector else 'broad') + (sub,)

    @staticmethod
    def fund_country(lo, ra, hit):
        for k, cc in T.FUND_COUNTRY_WORDS:
            if hit(k, lo, ra):
                return cc
        return None


# ------------------------------------------------------------------------------------------------
def is_fund(rec, t):
    qt = (rec or {}).get('qt')
    if qt in ('ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY', 'CURRENCY', 'FUTURE'):
        return True
    if rec and rec.get('legal') and 'fund' in rec['legal'].lower():
        return True
    if rec and rec.get('cat') and not rec.get('city'):
        return True
    return False


def build(args):
    t0 = time.time()
    ctx, per_tree = load_trees()
    tickers = list(dict.fromkeys(t for tag, _ in TREES for t in per_tree[tag]))
    print('tickers: %d  (curated %d, full %d, global %d)' % (
        len(tickers), len(per_tree['curated']), len(per_tree['full']), len(per_tree['global'])), flush=True)

    # 1. profiles
    if not args.no_fetch:
        if args.refresh_missing:
            todo = [t for t in tickers if FP.needs_refresh(FP.read_cache(t))]
        else:
            todo = [t for t in tickers if FP.read_cache(t) is None]
        print('yahoo: %d to fetch' % len(todo), flush=True)
        if todo:
            FP.Fetcher(args.workers).run(todo, log=lambda s: print(s, flush=True))
    recs = {t: FP.read_cache(t) for t in tickers}

    gaz = Gaz()
    GAZ_REF[:] = [gaz]
    print('gazetteer: %d GeoNames places + %d hand places' % (gaz.n_geonames, gaz.extra_rows), flush=True)
    small = SmallTowns(gaz)
    print('small towns: %d extra GeoNames places (%s), used only before a state/country fallback' % (
        small.n_geonames, small.source), flush=True)
    res = Resolver(gaz, small)

    def resolve_all(use_cninfo):
        out, meta, subs = {}, {}, {}
        res.reg, res.ops_warnings = {}, []
        for t in tickers:
            rec = recs.get(t)
            res._unknown_country = None
            if (rec and is_fund(rec, t)) or (t in res.overrides and res.overrides[t][4] in ('country', 'region', 'nongeo')):
                if t in res.overrides and res.overrides[t][4] in ('country', 'region', 'nongeo'):
                    o = res.overrides[t]
                    ocat, _, s = (o[5] or '').partition(':')
                    e, m = res.fund_entry(t, o[4], o[2] or None, ocat or None, why='override')
                    s = s or None
                else:
                    e, m, s = res.fund(t, rec, ctx.get(t))
                if s:
                    subs[t] = s
            else:
                e, m = res.company(t, rec, ctx.get(t), use_cninfo=use_cninfo)
            if e is not None:
                out[t] = e
                meta[t] = dict(m or {}, why=res._why, unknown_country=res._unknown_country)
            else:
                meta[t] = {'why': 'missing', 'unknown_country': res._unknown_country}
        return out, meta, subs

    hq, meta, subs = resolve_all(use_cninfo=True)

    # 2. A-shares that did not land on an exact city -> ask cninfo for the Chinese address, then redo
    if not args.no_fetch:
        cn_todo = []
        for t in tickers:
            if not re.match(r'^\d{6}\.(SS|SZ)$', t):
                continue
            e = hq.get(t)
            exact = e is not None and len(e) == 5 and not e[4]
            if not exact:
                ci = cninfo_get(t[:6])
                if ci is None or (args.refresh_missing and ci.get('status') != 'ok'):
                    cn_todo.append(t[:6])
        print('cninfo: %d A-shares to look up' % len(cn_todo), flush=True)
        if cn_todo:
            cninfo_fetch(cn_todo, workers=1, log=lambda s: print(s, flush=True))  # akshare runs V8: one thread
            hq, meta, subs = resolve_all(use_cninfo=True)

    # 2b. business capitals: a company known only by its country / state goes to the city with the most exact HQs
    #     there (London, Seoul, Toronto, Houston …), not to the population centre. Second pass with them.
    res.biz, res.biz_state = business_capitals(hq, meta)
    hq, meta, subs = resolve_all(use_cninfo=True)
    for w in res.ops_warnings:
        print('  ! ' + w)

    # 3. private graph nodes
    priv = load_private()
    n_priv = Counter()
    for pid, info in sorted(priv.items()):
        e, how = private_entry(res, pid, info)
        if e:
            hq[pid] = e
            meta[pid] = {'why': 'private-' + how}
            n_priv[how] += 1

    # 3b. keep every point on land: GeoNames city centres of harbour towns fall in the water at 1:10m / 1:50m
    snaps = snap_to_land(hq)

    # 4. write
    zh = {}
    for t, e in hq.items():
        m = meta.get(t) or {}
        r = m.get('row')
        if e[2] and r and len(e) == 5 or (e[2] and r and len(e) > 5 and e[5] == 'near'):
            z = Gaz.zh(r)
            if z:
                zh['%s|%s' % (e[2], e[3])] = z
    reg = dict(sorted(res.reg.items()))
    for city, cc in reg.values():
        k = '%s|%s' % (city, cc)
        if city and k not in zh:
            r, _ = gaz.lookup(city, cc)
            z = Gaz.zh(r) if r and r['name'] == city else None
            if z:
                zh[k] = z
    used_keys = {'%s|%s' % (e[2], e[3]) for e in hq.values() if e[2]} | {'%s|%s' % tuple(v) for v in reg.values()}
    for k, z in T.CITY_ZH.items():  # hand-checked Chinese names win (Korea, Changshu, Austin 奥斯汀 …)
        if k in used_keys:
            zh[k] = z
    countries = {}
    used_cc = Counter(e[3] for e in hq.values() if e[3])
    used_cc.update(cc for _, cc in reg.values() if cc)
    for cc in sorted(set(used_cc) | {c for rg in T.REGIONS.values() for c in rg[2]}):
        info = T.COUNTRIES.get(cc)
        p = gaz.area_point(cc)
        countries[cc] = {'id': info[0] if info else None, 'name': info[1] if info else cc,
                         'zh': info[2] if info else None,
                         'p': [round(p['lon'], 4), round(p['lat'], 4)] if p else None}
    hints = {}
    for sub, places in T.COMMODITY_HINTS.items():
        lst = []
        for name, cc, st, label in places:
            a1 = res.state_a1(cc, st) if st else None
            r, _ = gaz.lookup(name, cc, a1)
            if r:
                lst.append([round(r['lon'], 3), round(r['lat'], 3), label])
        hints[sub] = lst

    out = {
        'v': 1,
        'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'about': 'Real headquarters of every company in the curated, full-market and global trees. '
                 'hq[ticker] = [lon, lat, city, country(ISO2), est, kind?, cat?]. kind omitted = exact HQ city. '
                 'reg[ticker] = [city, country] = the registered office Yahoo reports when the map uses the operating '
                 'HQ instead (geodata/tables/ops.tsv), for a 注册地 line on the hover card. See geodata/README.md.',
        'fields': ['lon', 'lat', 'city', 'country', 'est', 'kind', 'cat'],
        'kinds': {
            'hq': 'exact headquarters city (default when kind is omitted), est:false',
            'near': 'a known city near the HQ (same prefecture/district), est:true',
            'state': 'only the state/province is known: the state\'s city with the most exact HQs (Texas -> Houston), est:true',
            'approx': 'only the country is known: its business capital (the city with the most exact HQs: GB London, '
                      'KR Seoul; US New York; CN by exchange .SS Shanghai / .SZ Shenzhen), est:true',
            'country': 'a fund/aggregate that IS a whole country (cat "etf" or "agg"); shade countries[cc]',
            'region': 'a fund covering several countries; cat = key of regions{} (shade regions[cat].iso)',
            'nongeo': 'not a place (sea area): cat = bonds|commodities|crypto|cash|sector|broad; country = home market hint; lon/lat null',
        },
        'hq': hq,
        'reg': reg,
        'sub': subs,
        'zh': zh,
        'countries': countries,
        'regions': {k: {'name': v[0], 'zh': v[1], 'iso': v[2]} for k, v in T.REGIONS.items()},
        'hints': hints,
    }
    dest = args.out or OUT
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, dest)

    # 5. report
    rep = report(hq, meta, per_tree, recs, ctx, n_priv, len(priv))
    rep['regOffice'] = reg_office_report(hq, recs, ctx, res, per_tree)
    rep['opsMoved'] = [[t, hq[t][2], hq[t][3], v[0], v[1]] for t, v in reg.items() if t in hq]
    rep['opsWarnings'] = res.ops_warnings
    rep['businessCapitals'] = {cc: r['name'] for cc, r in sorted(res.biz.items())}
    rep['snapped'] = snaps
    rep['zhCoverage'] = zh_coverage(hq, zh)
    rep['spot'] = spot_check(hq)
    with open(REPORT, 'w') as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    print_report(rep)
    print('wrote %s (%.0f KB) in %.0fs' % (dest, os.path.getsize(dest) / 1024, time.time() - t0))
    return hq, meta


# ------------------------------------------------------------------------------------------------
GAZ_REF = []  # the build's gazetteer (business_capitals looks up BUSINESS_CAPITALS hints in it)


def business_capitals(hq, meta):
    """cc -> GeoNames row of the city with the most exact company HQs; (cc, a1) -> the same per state/province.
    Ties go to the bigger city. Funds, private nodes and estimated places do not vote."""
    by_cc, by_st, rows = defaultdict(Counter), defaultdict(Counter), {}
    for t, e in hq.items():
        if t.startswith('p:') or len(e) != 5 or e[4]:
            continue
        r = (meta.get(t) or {}).get('row')
        if not r:
            continue
        rows[r['id']] = r
        by_cc[e[3]][r['id']] += 1
        if r.get('a1'):
            by_st[(e[3], r['a1'])][r['id']] += 1

    def top(c):
        return max(c.items(), key=lambda kv: (kv[1], rows[kv[0]].get('pop') or 0))

    biz = {}
    for cc, c in by_cc.items():
        rid, n = top(c)
        biz[cc] = rows[rid]
        if n < 5 and GAZ_REF:  # too few HQs to vote: the known business capital, else the capital
            g = GAZ_REF[0]
            r = g.lookup(T.BUSINESS_CAPITALS[cc], cc)[0] if cc in T.BUSINESS_CAPITALS else g.main_city(cc)
            if r:
                biz[cc] = r
    return biz, {k: rows[top(c)[0]] for k, c in by_st.items()}


def snap_to_land(hq, max_km=15.0):
    """Move points that sit in the water (at 1:10m, or at the 1:50m the globe draws) onto the nearest land within
    max_km. City / est / kind are kept. Returns the log [{city, cc, from, to, km, layer, n, tickers}]."""
    try:
        import landsnap
        snapper = landsnap.LandSnap(max_km)
    except Exception as ex:  # numpy / geometry missing: keep the points as they are
        print('  ! land snap skipped: %s' % ex)
        return []
    log = {}
    for t, e in hq.items():
        if e[0] is None or e[1] is None or (len(e) > 5 and e[5] in ('country', 'region', 'nongeo')):
            continue
        lon, lat, info = snapper.snap(e[0], e[1])
        if info is None:
            continue
        key = (e[0], e[1], e[2], e[3])
        if key not in log:
            log[key] = {'city': e[2], 'cc': e[3], 'from': [e[0], e[1]], 'to': [lon, lat], 'km': info['km'],
                        'layer': info['layer'], 'n': 0, 'tickers': []}
        log[key]['n'] += 1
        if len(log[key]['tickers']) < 12:
            log[key]['tickers'].append(t)
        e[0], e[1] = lon, lat
    out = sorted(log.values(), key=lambda x: -x['n'])
    print('land snap: %d points in the water moved onto land (%d tickers)' % (len(out), sum(x['n'] for x in out)))
    return out


OFFSHORE = {'KY', 'BM', 'VG', 'JE', 'GG', 'IM'}           # always a registered office, unless reviewed
TAX_SEATS = {'LU', 'IE', 'NL', 'CH', 'CY'}               # real HQs too: flagged when listed outside Europe
EUROPE_LISTINGS = {'GB', 'DE', 'FR', 'CH', 'NL', 'SE', 'IT', 'ES', 'NO', 'DK', 'FI', 'BE', 'AT', 'IE', 'PT', 'PL', 'LU',
                   None}
AGENT_WORDS = ('ugland house', 'maples', 'walkers', 'walker house', 'c/o', 'clarendon house', 'canon\'s court',
               '1209 orange street', '251 little falls', '1000 north west street', '1000 n west', '838 walker road',
               ' pmb ', 'one nexus way', 'grand pavilion', '103 south church street')


def reg_office_report(hq, recs, ctx, res, per_tree):
    """Exact HQs that are probably a registered office / tax seat and not where the company is run, for review:
    any HQ in KY BM VG JE GG IM; one in LU IE NL CH CY when the ticker is listed in another country; Wilmington /
    Dover DE; or a registered-agent address (Ugland House, Maples, Walkers, c/o, 1209 Orange St …). Tickers in
    tables/ops.tsv (moved, or '=' reviewed as genuine) are left out. Sorted by market cap ($bn, from the trees);
    'share' = the share of each tree's dv20 that still sits in such places."""
    items = []
    flagged = set()
    for t, e in hq.items():
        if t.startswith('p:') or len(e) != 5 or e[4] or t in res.ops:
            continue
        r = recs.get(t) or {}
        addr = ' '.join(str(r.get(k) or '') for k in ('a1', 'a2')).lower()
        why = []
        if e[3] in OFFSHORE:
            why.append('offshore ' + e[3])
        if e[3] in TAX_SEATS and suffix_country(t) not in EUROPE_LISTINGS:
            why.append('%s seat, listed %s' % (e[3], suffix_country(t)))
        if e[3] == 'US' and e[2] in ('Wilmington', 'Dover') and (r.get('state') or '').upper() == 'DE':
            why.append('Delaware')
        if any(w in addr for w in AGENT_WORDS):
            why.append('agent address')
        if not why:
            continue
        c = ctx.get(t) or {}
        flagged.add(t)
        items.append({'t': t, 'name': (r.get('name') or '')[:48], 'city': e[2], 'cc': e[3], 'cap': c.get('cap') or 0,
                      'why': ', '.join(why), 'addr': addr[:60], 'trees': sorted(c.get('trees') or [])})
    items.sort(key=lambda x: -(x['cap'] or 0))
    share, moved = {}, {}
    for tag, lst in per_tree.items():
        tot = sum((ctx.get(t) or {}).get('dv') or 0 for t in lst)
        bad = sum((ctx.get(t) or {}).get('dv') or 0 for t in lst if t in flagged)
        mv = sum((ctx.get(t) or {}).get('dv') or 0 for t in lst if t in res.reg)
        share[tag] = round(100 * bad / tot, 2) if tot else 0
        moved[tag] = round(100 * mv / tot, 2) if tot else 0
    return {'n': len(items), 'sharePctOfDv20': share, 'movedByOpsPctOfDv20': moved, 'items': items}


ZH_CCS = ('CN', 'JP', 'TW', 'KR', 'HK')


def zh_coverage(hq, zh):
    """Share of labelled company places in CN / JP / TW / KR / HK that have a Chinese name, and what is missing."""
    out = {}
    for cc in ZH_CCS:
        n, miss = 0, Counter()
        for t, e in hq.items():
            if e[3] != cc or not e[2] or (len(e) > 5 and e[5] in ('country', 'region', 'nongeo')):
                continue
            n += 1
            if '%s|%s' % (e[2], cc) not in zh:
                miss[e[2]] += 1
        out[cc] = {'labelled': n, 'pct': round(100 * (n - sum(miss.values())) / max(n, 1), 1),
                   'missing': miss.most_common(20)}
    return out


ZH_COUNTRY_WORDS = sorted(
    [(v[2], k) for k, v in T.COUNTRIES.items()] +
    [('美國', 'US'), ('澳洲', 'AU'), ('台湾', 'TW'), ('臺灣', 'TW'), ('北美', 'US'), ('英國', 'GB'), ('德國', 'DE'),
     ('法國', 'FR'), ('瑞典', 'SE'), ('荷兰', 'NL'), ('韓國', 'KR'), ('印尼', 'ID'), ('沙特', 'SA'), ('阿布扎比', 'AE'),
     ('迪拜', 'AE'), ('中国大陆', 'CN'), ('内地', 'CN'), ('克罗地亚', 'HR'), ('奥地利', 'AT')],
    key=lambda kv: -len(kv[0]))
AGG_WORDS = ('合计', '群', '各州', '家庭', '消费者', '市场', '用户', '租户', '业主', '买家', '卖家', '借款人', '运营商（合计）')


def private_entry(res, pid, info):
    """Returns (entry, how) for a private graph node, or (None, None)."""
    g = res.g
    row = res.private.get(pid)
    if row:
        _, city, cc, state, kind, cat = row
        if kind in ('country', 'region', 'nongeo'):
            e, _ = res.fund_entry(pid, kind, cc or None, cat or None, why='private')
            if kind == 'country':
                e[6] = 'agg'
            return e, 'table'
        a1 = res.state_a1(cc, state) if state else None
        if kind == 'state':
            r = res.state_point(cc, a1)
            return ([round(r['lon'], 4), round(r['lat'], 4), None, cc, True, 'state'], 'table') if r else (None, None)
        r, _ = g.lookup(city, cc, a1)
        if r:
            e = [round(r['lon'], 4), round(r['lat'], 4), r['name'], cc, kind == 'near']
            if kind == 'near':
                e.append('near')
            return e, 'table'
        print('  ! private.tsv: %s city %r not found in %s' % (pid, city, cc))
        return None, None
    # rule: the note (or name) opens with a country word -> that country, estimated
    text_note = (info.get('note') or '')[:8]
    name = info.get('name') or ''
    for word, cc in ZH_COUNTRY_WORDS:
        if word in text_note or name.startswith(word):
            if any(w in name for w in AGG_WORDS):
                e, _ = res.fund_entry(pid, 'country', cc)
                e[6] = 'agg'
                return e, 'note'
            r = res.country_point(cc)
            if r:
                return [round(r['lon'], 4), round(r['lat'], 4), None, cc, True, 'approx'], 'note'
    return None, None


TIER = [('exact', lambda e: len(e) == 5 and not e[4]),
        ('near', lambda e: len(e) > 5 and e[5] == 'near'),
        ('state', lambda e: len(e) > 5 and e[5] == 'state'),
        ('country-only', lambda e: len(e) > 5 and e[5] == 'approx'),
        ('fund:country', lambda e: len(e) > 5 and e[5] == 'country'),
        ('fund:region', lambda e: len(e) > 5 and e[5] == 'region'),
        ('fund:nongeo', lambda e: len(e) > 5 and e[5] == 'nongeo')]


def tier_of(e):
    if e is None:
        return 'missing'
    for name, f in TIER:
        if f(e):
            return name
    return 'exact'


def report(hq, meta, per_tree, recs, ctx, n_priv, n_priv_all):
    rep = {'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'trees': {}}
    for tag, lst in per_tree.items():
        c = Counter(tier_of(hq.get(t)) for t in lst)
        n = len(lst)
        companies = n - c['fund:country'] - c['fund:region'] - c['fund:nongeo']
        rep['trees'][tag] = {
            'n': n, 'companies': companies, 'funds': n - companies,
            'tiers': dict(c),
            'exactPctOfCompanies': round(100 * (c['exact']) / max(companies, 1), 1),
            'fallbackPctOfCompanies': round(100 * (c['near'] + c['state'] + c['country-only']) / max(companies, 1), 1),
            'missing': c['missing'],
            'missingList': [t for t in lst if t not in hq][:200],
        }
    # unmatched city names (for growing tables/extra_places.tsv)
    um = Counter()
    um_cap = defaultdict(float)
    for t, e in hq.items():
        if t.startswith('p:'):
            continue
        tr = tier_of(e)
        if tr in ('state', 'country-only', 'near'):
            r = recs.get(t) or {}
            key = '%s|%s|%s' % (r.get('city'), r.get('state') or '', e[3])
            um[key] += 1
            um_cap[key] = max(um_cap[key], (ctx.get(t) or {}).get('cap') or 0)
    rep['unmatchedCities'] = [[k, v, round(um_cap[k], 1)] for k, v in um.most_common(400)]
    rep['unknownCountries'] = Counter(m.get('unknown_country') for m in meta.values() if m.get('unknown_country')).most_common()
    rep['why'] = Counter((m or {}).get('why') for m in meta.values()).most_common()
    rep['private'] = {'placed': sum(n_priv.values()), 'fromTable': n_priv.get('table', 0),
                      'fromNoteCountry': n_priv.get('note', 0), 'of': n_priv_all}
    return rep


SPOT = [
    ('NVDA', 'Santa Clara', 'US'), ('MSFT', 'Redmond', 'US'), ('JPM', 'New York', 'US'), ('XOM', 'Spring', 'US'),
    ('DNA', 'Boston', 'US'), ('600519.SS', 'Renhuai/Guizhou', 'CN'), ('7203.T', 'Toyota', 'JP'),
    ('ASML', 'Veldhoven', 'NL'), ('TSM', 'Hsinchu', 'TW'), ('AAPL', 'Cupertino', 'US'),
    ('GOOGL', 'Mountain View', 'US'), ('AMZN', 'Seattle', 'US'), ('META', 'Menlo Park', 'US'),
    ('TSLA', 'Austin', 'US'), ('BRK-B', 'Omaha', 'US'), ('LLY', 'Indianapolis', 'US'), ('WMT', 'Bentonville', 'US'),
    ('NKE', 'Beaverton', 'US'), ('0700.HK', 'Shenzhen', 'CN'), ('BABA', 'Hangzhou', 'CN'),
    ('005930.KS', 'Suwon', 'KR'), ('SAP', 'Walldorf', 'DE'), ('NVO', 'Bagsvaerd', 'DK'), ('NESN.SW', 'Vevey', 'CH'),
    ('MC.PA', 'Paris', 'FR'), ('SHEL', 'London', 'GB'), ('RELIANCE.NS', 'Mumbai', 'IN'), ('6758.T', 'Tokyo', 'JP'),
    ('300750.SZ', 'Ningde', 'CN'), ('002594.SZ', 'Shenzhen', 'CN'), ('RY', 'Toronto', 'CA'), ('VALE', 'Rio de Janeiro', 'BR'),
    ('EWJ', 'country JP', 'JP'), ('VGK', 'region europe', None), ('TLT', 'nongeo bonds', None),
    ('GLD', 'nongeo commodities', None), ('IBIT', 'nongeo crypto', None), ('SGOV', 'nongeo cash', None),
    ('p:openai', 'San Francisco', 'US'), ('p:bytedance', 'Beijing', 'CN'),
    ('MRVL', 'Santa Clara (ops)', 'US'), ('CRDO', 'San Jose (ops)', 'US'), ('FN', 'Pathum Thani (ops)', 'TH'),
    ('PDD', 'Shanghai (ops)', 'CN'), ('MDT', 'Minneapolis (ops)', 'US'), ('TCOM', 'Shanghai (ops)', 'CN'),
    ('AIR.PA', 'Blagnac (ops)', 'FR'), ('6981.T', 'Nagaokakyo', 'JP'), ('6954.T', 'Oshino', 'JP'),
    ('ACGL', 'Hamilton BM (genuine)', 'BM'), ('ADI', 'Wilmington MA', 'US'), ('NCNO', 'Wilmington NC', 'US'),
    ('SI', 'Grand Rapids', 'US'),
]


def spot_check(hq):
    out = []
    for t, want, cc in SPOT:
        e = hq.get(t)
        out.append({'t': t, 'want': want, 'got': e})
    return out


def print_report(rep):
    print('\ncoverage (companies = non-fund tickers; exact = HQ city found)')
    for tag, r in rep['trees'].items():
        print('  %-8s n=%5d companies=%5d funds=%4d | exact %5.1f%%  fallback %4.1f%%  missing %d   %s' % (
            tag, r['n'], r['companies'], r['funds'], r['exactPctOfCompanies'], r['fallbackPctOfCompanies'],
            r['missing'], r['tiers']))
    print('  private graph nodes placed: %(placed)d of %(of)d (table %(fromTable)d, note-country %(fromNoteCountry)d)' % rep['private'])
    if rep['unknownCountries']:
        print('  unknown country strings:', rep['unknownCountries'][:20])
    ro = rep.get('regOffice') or {}
    if ro:
        print('\nregistered offices still on the map (review; ops.tsv to move or mark "="): %d, dv20 share %s' % (
            ro['n'], ro['sharePctOfDv20']))
        for it in ro['items'][:12]:
            print('  %-10s %-16s %-3s %6.1f  %s' % (it['t'], it['city'], it['cc'], it['cap'] or 0, it['why']))
    if rep.get('opsMoved'):
        print('ops.tsv moved %d tickers to their operating HQ' % len(rep['opsMoved']))
    for w in rep.get('opsWarnings') or []:
        print('  ! ' + w)
    if rep.get('zhCoverage'):
        print('zh labels: ' + '  '.join('%s %.1f%%' % (cc, v['pct']) for cc, v in rep['zhCoverage'].items()))
    print('\nspot check')
    for s in rep['spot']:
        print('  %-12s want %-20s got %s' % (s['t'], s['want'], s['got']))


def check(args):
    gaz = Gaz()
    small = SmallTowns(gaz)
    print('small towns: %d extra GeoNames places (%s), used only before a state/country fallback' % (
        small.n_geonames, small.source), flush=True)
    res = Resolver(gaz, small)
    ctx, _ = load_trees()
    for t in args.check.split(','):
        rec = FP.read_cache(t)
        res._unknown_country = None
        if rec and is_fund(rec, t):
            e, m, s = res.fund(t, rec, ctx.get(t))
        else:
            e, m = res.company(t, rec, ctx.get(t))
        print(t, '|', {k: (rec or {}).get(k) for k in ('qt', 'name', 'city', 'state', 'zip', 'country', 'cat')},
              '\n   ->', e, res._why)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--refresh-missing', action='store_true',
                    help='re-fetch tickers whose cached profile has no city/country (or errored), and A-shares '
                         'whose cninfo lookup failed')
    ap.add_argument('--no-fetch', action='store_true', help='build from cache only')
    ap.add_argument('--workers', type=int, default=7)
    ap.add_argument('--out', default='', help='write somewhere else than web/data/geo/hq.json (testing)')
    ap.add_argument('--check', default='', help='comma-separated tickers to explain, no output written')
    args = ap.parse_args()
    if args.check:
        return check(args)
    build(args)


if __name__ == '__main__':
    main()
