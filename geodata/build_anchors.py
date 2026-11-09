#!/usr/bin/env python3
"""Build web/data/geo/anchors.json — where each non-company asset's money really ends up (DESIGN.md §26 amendment).

Every bond / cash / FX / commodity / crypto fund (and country / region / sector ETF) in the three trees gets a
weighted list of real places: Treasuries → the US Treasury in Washington, corporate bonds → the issuers' HQ cities,
copper → Atacama / Katanga / Peru …, spot BTC ETFs → the issuer's HQ plus a little of the mining regions, miners →
their own mine sites plus HQ. Curated-tree region nodes under 债券 / 商品 / 加密 / 现金 get the weighted union.

Inputs (read-only): geodata/anchors_src.json (hand-curated knowledge + inheritance rules), web/data/geo/hq.json,
the three trees, geodata/cache/yf/<t>.json (fund names → name rules / issuer), geodata/cities15000.txt +
geodata/tables/extra_places.tsv (geocoding), web/vendor/geo/land-10m.json (on-land check).

    python3 geodata/build_anchors.py                 # build + validate + summary
    python3 geodata/build_anchors.py --check GLD,IBIT,EWJ   # print how some tickers resolve (writes nothing)
    python3 geodata/build_anchors.py --out /tmp/a.json
"""
import argparse, collections, datetime, json, math, os, re, sys, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, 'anchors_src.json')
OUT = os.path.join(ROOT, 'web', 'data', 'geo', 'anchors.json')
HQ = os.path.join(ROOT, 'web', 'data', 'geo', 'hq.json')
TREES = [('curated', os.path.join(ROOT, 'web', 'data', 'tree.json')),
         ('fm', os.path.join(ROOT, 'web', 'data', 'fm', 'tree.json')),
         ('gl', os.path.join(ROOT, 'web', 'data', 'gl', 'tree.json'))]
CITIES = os.path.join(HERE, 'cities15000.txt')
EXTRA = os.path.join(HERE, 'tables', 'extra_places.tsv')
YF = os.path.join(HERE, 'cache', 'yf')
LAND = os.path.join(ROOT, 'web', 'vendor', 'geo', 'land-10m.json')

MIN_W = 0.004        # anchors lighter than this are dropped (then renormalised)
MAX_TICKER = 24      # at most this many anchors per ticker
MAX_NODE = 40        # … per node
NODE_MERGE_KM = 5    # in node unions, anchors closer than this merge into the heavier one
NEAR_WARN_KM = 450   # explicit point farther than this from its 'near' town → warning


def km(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(a)))


def norm(s):
    s = unicodedata.normalize('NFKD', s.lower().strip())
    return ''.join(c for c in s if not unicodedata.combining(c))


# ---------------------------------------------------------------- gazetteer
class Gazetteer:
    def __init__(self):
        self.exact = collections.defaultdict(list)   # (name, cc) → recs   (name / asciiname / extra_places)
        self.alt = collections.defaultdict(list)     # (alternate name, cc) → recs
        self.capital = {}                            # cc → rec (PPLC)
        self.grid = collections.defaultdict(list)    # (int lat, int lon) → recs, for nearest()
        with open(CITIES, encoding='utf-8') as f:
            for line in f:
                c = line.rstrip('\n').split('\t')
                rec = {'name': c[1], 'lon': float(c[5]), 'lat': float(c[4]), 'cc': c[8], 'a1': c[10],
                       'pop': int(c[14] or 0), 'fc': c[7]}
                for n in {norm(c[1]), norm(c[2])}:
                    self.exact[(n, c[8])].append(rec)
                for a in c[3].split(','):
                    if a and len(a) < 40:
                        self.alt[(norm(a), c[8])].append(rec)
                if c[7] == 'PPLC' and (c[8] not in self.capital or rec['pop'] > self.capital[c[8]]['pop']):
                    self.capital[c[8]] = rec
                self.grid[(int(math.floor(rec['lat'])), int(math.floor(rec['lon'])))].append(rec)
        if os.path.exists(EXTRA):
            with open(EXTRA, encoding='utf-8') as f:
                for line in f:
                    if not line.strip() or line.startswith('#'):
                        continue
                    c = line.rstrip('\n').split('\t')
                    if len(c) < 5:
                        continue
                    rec = {'name': c[0], 'lon': float(c[4]), 'lat': float(c[3]), 'cc': c[1], 'a1': '',
                           'pop': 0, 'fc': 'EXTRA', 'zh': c[5] if len(c) > 5 else ''}
                    for n in [c[0]] + (c[6].split(',') if len(c) > 6 and c[6] else []):
                        self.exact[(norm(n), c[1])].append(rec)

    def lookup(self, q):
        """q = 'Name|CC' or 'Name|CC|admin1'. Exact name/asciiname wins over alternate names."""
        p = q.split('|')
        name, cc, a1 = norm(p[0]), p[1], (p[2] if len(p) > 2 else None)
        for table in (self.exact, self.alt):
            c = [r for r in table.get((name, cc), []) if not a1 or r['a1'] == a1 or r['fc'] == 'EXTRA']
            if c:
                c.sort(key=lambda r: -r['pop'])
                return c[0]
        return None

    def nearest(self, lon, lat):
        best, bd = None, 1e9
        la, lo = int(math.floor(lat)), int(math.floor(lon))
        for r in range(0, 40):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if max(abs(dy), abs(dx)) != r:
                        continue
                    for rec in self.grid.get((la + dy, (lo + dx + 180) % 360 - 180), []):
                        d = km(lon, lat, rec['lon'], rec['lat'])
                        if d < bd:
                            best, bd = rec, d
            if best and bd < r * 80:
                break
        return best, bd


# ---------------------------------------------------------------- land mask (world-atlas land-10m TopoJSON)
class Land:
    def __init__(self, path):
        topo = json.load(open(path))
        sx, sy = topo['transform']['scale']
        tx, ty = topo['transform']['translate']
        arcs = []
        for a in topo['arcs']:
            x = y = 0
            pts = []
            for dx, dy in a:
                x += dx
                y += dy
                pts.append((x * sx + tx, y * sy + ty))
            arcs.append(pts)
        self.rings = []
        for g in topo['objects']['land']['geometries']:
            polys = g['arcs'] if g['type'] == 'MultiPolygon' else [g['arcs']]
            for poly in polys:
                for ring in poly:
                    raw = []
                    for i in ring:
                        seg = arcs[i] if i >= 0 else arcs[~i][::-1]
                        raw.extend(seg if not raw else seg[1:])
                    # unwrap across the antimeridian (Eurasia's ring jumps 180 → -180 at Chukotka), so that a
                    # horizontal ray never meets a fake world-wide edge
                    pts, off = [raw[0]], 0.0
                    for (xa, _), (xb, yb) in zip(raw, raw[1:]):
                        if xb - xa > 180:
                            off -= 360
                        elif xa - xb > 180:
                            off += 360
                        pts.append((xb + off, yb))
                    if abs(off) > 1:      # polar ring (Antarctica): close it along the pole
                        pole = -90.0 if sum(p[1] for p in pts) < 0 else 90.0
                        pts += [(pts[-1][0], pole), (pts[0][0], pole)]
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    self.rings.append((min(xs), min(ys), max(xs), max(ys), pts))

    @staticmethod
    def _in_ring(pts, lon, lat):
        inside = False
        n = len(pts)
        j = n - 1
        for i in range(n):
            xi, yi = pts[i]
            xj, yj = pts[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return inside

    def on_land(self, lon, lat):
        inside = False
        for x0, y0, x1, y1, pts in self.rings:
            if not (y0 <= lat <= y1):
                continue
            for L in (lon, lon - 360, lon + 360):
                if x0 <= L <= x1 and self._in_ring(pts, L, lat):
                    inside = not inside
                    break
        return inside

    def coast_km(self, lon, lat):
        """Distance to the nearest land-ring vertex (rough; only used to explain coastal misses)."""
        best = 1e9
        for x0, y0, x1, y1, pts in self.rings:
            if y0 - 1 > lat or y1 + 1 < lat:
                continue
            for L in (lon, lon - 360, lon + 360):
                if x0 - 1 > L or x1 + 1 < L:
                    continue
                for x, y in pts:
                    if abs(x - L) < 0.5 and abs(y - lat) < 0.5:
                        best = min(best, km(L, lat, x, y))
        return best


# ---------------------------------------------------------------- trees
def walk(node, path, out):
    if node.get('ticker'):
        out.append((node['ticker'], path, node))
    for c in node.get('children') or []:
        walk(c, path + [node['id']], out)


def load_trees():
    per = {}
    trees = {}
    for key, p in TREES:
        t = json.load(open(p, encoding='utf-8'))
        trees[key] = t
        out = []
        walk(t, [], out)
        per[key] = out
    return trees, per


def yf_info(t):
    p = os.path.join(YF, t + '.json')
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return {}


# ---------------------------------------------------------------- builder
class Builder:
    def __init__(self, src, hqd, gaz, log=print):
        self.src, self.hqd, self.gaz, self.log = src, hqd, gaz, log
        self.hq = hqd['hq']
        self.problems, self.warnings = [], []
        self.places = {}
        self.cache = {}
        self.how = {}
        raw = {}
        for sect in ('places', 'extraPlaces'):
            for k, v in src.get(sect, {}).items():
                if k.startswith('_') or v is None:
                    continue
                if k in raw:
                    self.problems.append(f'place {k} defined twice')
                raw[k] = v
        for k, v in raw.items():
            self.places[k] = self.place(k, v)
        self.issuer_pats = [(k, re.compile(v['pat'], re.I)) for k, v in src['issuers'].items()]
        self.name_hints = [(re.compile(p, re.I), f) for p, f in src['rules']['nameHints']]

    def place(self, key, v):
        p = {'id': key, 'zh': v['zh'], 'en': v['en'], 'label': v.get('label'), 'offshore': bool(v.get('offshore'))}
        if 'city' in v and 'll' in v:      # a city nudged inland (its GeoNames point sits on the 10m coastline)
            v = dict(v, near=v['city'])
            del v['city']
        if 'city' in v:
            r = self.gaz.lookup(v['city'])
            if not r:
                self.problems.append(f'place {key}: cannot geocode {v["city"]}')
                p.update(lon=0.0, lat=0.0, geo='MISSING')
                return p
            want = norm(v['city'].split('|')[0])
            if norm(r['name']) != want and r['fc'] != 'EXTRA':
                self.warnings.append(f'place {key}: "{v["city"]}" matched GeoNames "{r["name"]}" (alternate name)')
            p.update(lon=round(r['lon'], 4), lat=round(r['lat'], 4), geo=f'{r["name"]}|{r["cc"]}', cc=r['cc'])
        else:
            lon, lat = v['ll']
            p.update(lon=lon, lat=lat, geo='explicit')
            if v.get('near'):
                r = self.gaz.lookup(v['near'])
                if not r:
                    r, d = self.gaz.nearest(lon, lat)
                    p['cc'] = v['near'].split('|')[1]
                    if r:
                        p['near'] = (r['name'], r['cc'], round(d))
                    if r and r['cc'] != p['cc'] and d < 100:
                        self.warnings.append(f'place {key}: nearest town {r["name"]} is in {r["cc"]}, expected {p["cc"]}')
                else:
                    d = km(lon, lat, r['lon'], r['lat'])
                    p['near'] = (r['name'], r['cc'], round(d))
                    p['cc'] = r['cc']
                    if d > NEAR_WARN_KM:
                        self.warnings.append(f'place {key}: {d:.0f} km from {v["near"]}')
        return p

    # -- resolution ------------------------------------------------------------
    def issuer_key(self, t):
        info = yf_info(t)
        txt = ' '.join(x for x in (info.get('fam'), info.get('name')) if x)
        for k, pat in self.issuer_pats:
            if txt and pat.search(txt):
                return k
        return None

    def spec(self, t):
        """→ (anchor list, how-string)."""
        tk = self.src['tickers']
        rules = self.src['rules']
        if t in tk and not t.startswith('_'):
            s = tk[t]
            return s, 'explicit'
        h = self.hq.get(t)
        if not h:
            return None, 'unknown ticker (not in hq.json)'
        kind = h[5] if len(h) > 5 else 'hq'
        cat = h[6] if len(h) > 6 else None
        cc = h[3]
        if kind == 'nongeo':
            name = yf_info(t).get('name') or ''
            for pat, fam in self.name_hints:
                if name and pat.search(name):
                    fam = rules.get('remap', {}).get(cat, {}).get(fam, fam)
                    return fam, f'name~/{pat.pattern}/'
            sub = self.hqd.get('sub', {}).get(t)
            if sub and sub in rules['sub']:
                fam = rules['sub'][sub]
                if isinstance(fam, str):
                    fam = rules.get('remap', {}).get(cat, {}).get(fam, fam)
                return fam, f'sub:{sub}'
            if cat in ('sector', 'broad') and cc:
                return 'ctry:' + cc, f'cat:{cat}+country:{cc}'
            if cat in rules['cat']:
                return rules['cat'][cat], f'cat:{cat}'
            return None, f'nongeo cat {cat} has no rule'
        if kind == 'country':
            return 'ctry:' + cc, f'country:{cc}'
        if kind == 'region':
            return 'region:' + cat, f'region:{cat}'
        return [['hq', 1]], 'hq'

    def norm_spec(self, s):
        if isinstance(s, str):
            return [[s if (':' in s or s.startswith('@')) else 'fam:' + s, 1]], None
        if isinstance(s, dict):
            return s['anchors'], s.get('est')
        return s, None

    def expand(self, ref, t, stack):
        """ref → list of (place, w, why, est) with weights summing to 1."""
        if ref in self.cache:
            return self.cache[ref]
        if ref in stack:
            raise ValueError('cycle: ' + ' → '.join(stack + [ref]))
        stack = stack + [ref]
        if ref.startswith('fam:'):
            fam = self.src['families'].get(ref[4:])
            if fam is None:
                raise ValueError(f'unknown family {ref}')
            out = self.combine(fam['anchors'], t, stack, fam.get('est', True))
        elif ref.startswith('ctry:'):
            cc = ref[5:]
            lst = self.src['countries'].get(cc)
            if lst:
                out = self.combine(lst, t, stack, True)
            else:
                cap = self.gaz.capital.get(cc)
                if not cap:
                    raise ValueError(f'no anchors and no capital for country {cc}')
                key = 'cap:' + cc
                if key not in self.places:
                    zh = self.hqd.get('countries', {}).get(cc, {}).get('zh', cc)
                    self.places[key] = {'id': key, 'zh': f'{zh}首都{cap["name"]}', 'en': f'{cap["name"]} (capital)',
                                        'lon': cap['lon'], 'lat': cap['lat'], 'geo': f'{cap["name"]}|{cc}', 'cc': cc,
                                        'offshore': False, 'label': None}
                out = [(key, 1.0, f'{cc} 首都（默认锚点）', True)]
        elif ref.startswith('region:'):
            rk = ref[7:]
            mix = self.src['regions'].get(rk)
            if not mix:
                iso = self.hqd.get('regions', {}).get(rk, {}).get('iso', [])
                if not iso:
                    raise ValueError(f'unknown region {rk}')
                mix = [[c, 1 / len(iso)] for c in iso]
            out = self.combine([['ctry:' + c, w] for c, w in mix], t, stack, True)
        elif ref.startswith('@'):
            out = self.ticker_anchors(ref[1:], stack)[0]
        elif ref.startswith('issuer:'):
            k = ref[7:]
            if k == 'auto':
                k = self.issuer_key(t) or None
            iss = self.src['issuers'].get(k) if k else None
            if iss:
                out = [(iss['place'], 1.0, f'{iss["zh"]}总部（基金发行人）', True)]
            else:
                out = [('nyc', 1.0, '基金发行人（未识别，默认纽约）', True)]
            self.cache.pop(ref, None)
            return out
        elif ref == 'hq':
            return [(self.hq_place(t), 1.0, '公司总部', False)]
        else:
            raise ValueError(f'bad ref {ref}')
        self.cache[ref] = out
        return out

    def hq_place(self, t):
        key = 'hq:' + t
        if key not in self.places:
            h = self.hq.get(t)
            if not h or h[0] is None:
                raise ValueError(f'{t}: no HQ coordinates in hq.json')
            city, cc = h[2] or '', h[3] or ''
            zh = self.hqd.get('zh', {}).get(f'{city}|{cc}') or city
            self.places[key] = {'id': key, 'zh': f'{zh}', 'en': f'{city}, {cc}', 'lon': h[0], 'lat': h[1],
                                'geo': 'hq.json', 'cc': cc, 'offshore': False, 'label': None, 'hqOf': t}
        return key

    def combine(self, lst, t, stack, est_default):
        acc = collections.OrderedDict()
        for a in lst:
            ref, w = a[0], float(a[1])
            if w <= 0:
                continue
            if ref in self.places and not ref.startswith(('fam:', 'ctry:', 'region:', 'issuer:')):
                if len(a) < 3:
                    raise ValueError(f'{t}: direct place {ref} needs a why')
                est = a[3] if len(a) > 3 else est_default
                parts = [(ref, 1.0, a[2], est)]
            elif ref in ('hq',) or ref.startswith(('fam:', 'ctry:', 'region:', '@', 'issuer:')):
                parts = self.expand(ref, t, stack)
                if len(a) > 3:
                    parts = [(p, ww, why, a[3]) for p, ww, why, _ in parts]
            else:
                raise ValueError(f'{t}: unknown place/ref "{ref}"')
            for p, ww, why, est in parts:
                if p not in acc:
                    acc[p] = [0.0, {}, est]
                acc[p][0] += w * ww
                acc[p][1][why] = acc[p][1].get(why, 0) + w * ww
                if w * ww > acc[p][1].get('__max', 0):
                    acc[p][1]['__max'] = w * ww
                    acc[p][2] = est
        tot = sum(v[0] for v in acc.values())
        out = []
        for p, (w, whys, est) in acc.items():
            whys.pop('__max', None)
            why = max(whys.items(), key=lambda kv: kv[1])[0]
            out.append((p, w / tot, why, est))
        return out

    def ticker_anchors(self, t, stack=()):
        key = '@' + t
        if key in self.cache:
            return self.cache[key], self.how.get(t)
        s, how = self.spec(t)
        if s is None:
            raise ValueError(f'{t}: {how}')
        lst, est = self.norm_spec(s)
        h = self.hq.get(t)
        company = bool(h) and (len(h) <= 5 or h[5] not in ('nongeo', 'country', 'region'))
        # a company's own listed sites are exact (est:false) unless marked; for funds a bare place is an estimate
        default = est if est is not None else (not company)
        out = self.combine(lst, t, list(stack) + [key], default)
        if est is True:          # an explicit 'est:true' spec marks everything below it as an approximation
            out = [(p, w, why, True) for p, w, why, _ in out]
        out = trim(out, MAX_TICKER)
        self.cache[key] = out
        self.how[t] = how
        return out, how

    def emit(self, lst):
        res = []
        for p, w, why, est in lst:
            pl = self.places[p]
            label = pl.get('label') or re.split('（|\\(', pl['zh'])[0]
            a = {'id': p, 'lon': round(pl['lon'], 4), 'lat': round(pl['lat'], 4),
                 'place': f'{pl["zh"]} · {pl["en"]}', 'label': label, 'w': w, 'why': why, 'est': bool(est)}
            if pl.get('offshore'):
                a['offshore'] = True
            res.append(a)
        return res


def trim(lst, cap):
    lst = sorted(lst, key=lambda x: -x[1])
    keep = [x for x in lst if x[1] >= MIN_W][:cap] or lst[:1]
    tot = sum(x[1] for x in keep)
    keep = [(p, w / tot, why, est) for p, w, why, est in keep]
    # round to 4 decimals, the largest absorbs the rounding so the list sums to exactly 1
    r = [(p, round(w, 4), why, est) for p, w, why, est in keep]
    diff = round(1 - sum(x[1] for x in r), 4)
    if r:
        p, w, why, est = r[0]
        r[0] = (p, round(w + diff, 4), why, est)
    return r


def node_union(b, members, dv):
    """members: list of tickers. weight = ½ dollar-volume share + ½ equal share."""
    n = len(members)
    tot = sum(dv.get(t, 0) or 0 for t in members)
    acc = {}
    for t in members:
        mw = 0.5 / n + (0.5 * (dv.get(t, 0) or 0) / tot if tot > 0 else 0.5 / n)
        lst, _ = b.ticker_anchors(t)
        for p, w, why, est in lst:
            if p not in acc:
                acc[p] = [0.0, {}, est]
            acc[p][0] += mw * w
            acc[p][1][why] = acc[p][1].get(why, 0) + mw * w
    items = sorted(([p, v[0], v[1], v[2]] for p, v in acc.items()), key=lambda x: -x[1])
    merged = []
    for p, w, whys, est in items:
        pl = b.places[p]
        for m in merged:
            q = b.places[m[0]]
            if km(pl['lon'], pl['lat'], q['lon'], q['lat']) < NODE_MERGE_KM:
                m[1] += w
                for k, v in whys.items():
                    m[2][k] = m[2].get(k, 0) + v
                break
        else:
            merged.append([p, w, dict(whys), est])
    out = [(p, w, max(whys.items(), key=lambda kv: kv[1])[0], est) for p, w, whys, est in merged]
    return trim(out, MAX_NODE)


def build(args):
    src = json.load(open(SRC, encoding='utf-8'))
    hqd = json.load(open(HQ, encoding='utf-8'))
    gaz = Gazetteer()
    b = Builder(src, hqd, gaz)
    trees, per = load_trees()
    hq = hqd['hq']
    conts = src['rules']['nodeContinents']

    # ---- targets
    targets = collections.OrderedDict()   # ticker → {trees, cont, why}
    for key, rows in per.items():
        for t, path, node in rows:
            h = hq.get(t)
            kind = (h[5] if len(h) > 5 else 'hq') if h else None
            cont = path[1] if len(path) > 1 else None
            reason = None
            if kind in ('nongeo', 'country', 'region'):
                reason = kind
            elif key == 'curated' and cont in conts:
                reason = 'continent'
            if reason:
                e = targets.setdefault(t, {'trees': [], 'cont': None, 'reason': reason})
                if key not in e['trees']:
                    e['trees'].append(key)
                if key == 'curated' and not e['cont']:
                    e['cont'] = cont
                elif not e['cont']:
                    e['cont'] = key + ':' + (path[1] if len(path) > 1 else '?')
    if args.check:
        for t in args.check.split(','):
            lst, how = b.ticker_anchors(t)
            print(f'\n{t}  [{how}]')
            for a in b.emit(lst):
                print(f'  {a["w"]:.4f}  {a["place"]:<60} {a["why"]}  est={a["est"]}{"  OFFSHORE" if a.get("offshore") else ""}')
        return 0

    anchors = collections.OrderedDict()
    for t in targets:
        try:
            lst, how = b.ticker_anchors(t)
            anchors[t] = b.emit(lst)
        except ValueError as e:
            b.problems.append(str(e))

    # ---- nodes: curated subtrees of the non-geographic continents
    dv = {}
    nodes = collections.OrderedDict()
    curated = trees['curated']

    def leaves(n, acc):
        if n.get('ticker'):
            acc.append(n['ticker'])
            dv[n['ticker']] = (n.get('now') or {}).get('dv20') or 0
        for c in n.get('children') or []:
            leaves(c, acc)
        return acc

    def visit(n):
        if n.get('ticker'):
            return
        mem = list(dict.fromkeys(leaves(n, [])))
        if mem:
            nodes[n['id']] = b.emit(node_union(b, mem, dv))
        for c in n.get('children') or []:
            visit(c)

    for c in curated.get('children') or []:
        if c['id'] in conts:
            visit(c)

    # ---- validation
    land = Land(LAND)
    used = set()
    for lst in list(anchors.values()) + list(nodes.values()):
        for a in lst:
            used.add(a['id'])
    land_bad, coastal = [], []
    for p in sorted(used):
        pl = b.places[p]
        on = land.on_land(pl['lon'], pl['lat'])
        if pl.get('offshore'):
            if on:
                land_bad.append(f'{p}: marked offshore but on land')
        elif not on:
            d = land.coast_km(pl['lon'], pl['lat'])
            if d <= 6:
                coastal.append(f'{p} ({pl["en"]}) {d:.1f} km off the 10m coastline (coastal city)')
            else:
                land_bad.append(f'{p} ({pl["en"]}) at {pl["lon"]},{pl["lat"]} is in the sea ({d:.0f} km from land)')
    sums = [t for t, lst in list(anchors.items()) + list(nodes.items()) if abs(sum(a['w'] for a in lst) - 1) > 1e-6]
    missing = [t for t in targets if t not in anchors]

    out = {
        'v': 1,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'about': ('Where each non-company asset\'s money really ends up (DESIGN.md §26 amendment). anchors[ticker] / '
                  'nodes[curated node id] = [{id, lon, lat, place ("中文 · English"), label (short 中文 for the map), w (0–1, '
                  'sums to 1), why (one short 中文 phrase), est (true = approximation: index weights / production regions '
                  '/ fund issuer HQ; false = exactly where the money goes), offshore? (true = deliberately at sea, '
                  'e.g. North Sea fields)}], heaviest first. Covers every ticker of the three trees whose hq.json kind '
                  'is nongeo / country / region, plus every curated member of 债券 / 商品 / 加密 / 现金 (plain companies '
                  'there = their HQ, w 1; miners = mine sites + HQ). nodes = curated region nodes under those four '
                  'continents (and the continents), weighted union of members (½ 20-day dollar-volume share + ½ equal), '
                  'anchors < 5 km apart merged. Weights are approximate (2025-26 composition, curated). Source: '
                  'geodata/anchors_src.json, built by geodata/build_anchors.py.'),
        'fields': ['id', 'lon', 'lat', 'place', 'label', 'w', 'why', 'est', 'offshore'],
        'how': {t: b.how.get(t) for t in anchors},
        'anchors': anchors,
        'nodes': nodes,
    }
    if not args.out == '-':
        path = args.out or OUT
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, path)
        print(f'wrote {path}  ({os.path.getsize(path) / 1024:.0f} KB): {len(anchors)} tickers, {len(nodes)} nodes, '
              f'{len(used)} distinct places')

    report(b, targets, anchors, nodes, per, land_bad, coastal, sums, missing)
    return 1 if (b.problems or land_bad or sums or missing) else 0


SPOT = ['TLT', 'SGOV', 'FXY', 'FXF', 'LQD', 'EMB', 'MUB', 'GLD', 'USO', 'BNO', 'CPER', 'URA', 'IBIT', 'RIOT', 'EWJ',
        'FXI', 'DBA', 'MARA', 'PSLV', 'VGK']


def report(b, targets, anchors, nodes, per, land_bad, coastal, sums, missing):
    print('\n=== coverage')
    by = collections.Counter()
    for t, e in targets.items():
        for k in e['trees']:
            by[(k, e['reason'])] += 1
    for (k, r), n in sorted(by.items()):
        print(f'  {k:<8} {r:<10} {n:>4}')
    print(f'  targets {len(targets)}, covered {len(anchors)}, missing {len(missing)} {missing[:10]}')
    print(f'  nodes {len(nodes)}; weight-sum errors {len(sums)} {sums[:5]}')

    print('\n=== per continent (curated) / tree')
    rows = collections.defaultdict(list)
    for t, e in targets.items():
        rows[e['cont'] or '?'].append(t)
    print(f'  {"continent":<22}{"n":>4}{"anchors":>9}{"est%":>7}{"offsh%":>8}  top places (by summed weight)')
    for cont in sorted(rows):
        ts = [t for t in rows[cont] if t in anchors]
        if not ts:
            continue
        na = sum(len(anchors[t]) for t in ts)
        est = sum(a['w'] for t in ts for a in anchors[t] if a['est']) / len(ts)
        off = sum(a['w'] for t in ts for a in anchors[t] if a.get('offshore')) / len(ts)
        agg = collections.Counter()
        for t in ts:
            for a in anchors[t]:
                agg[a['label']] += a['w']
        top = ', '.join(f'{k} {v / len(ts):.0%}' for k, v in agg.most_common(5))
        print(f'  {cont:<22}{len(ts):>4}{na / len(ts):>9.1f}{est:>7.0%}{off:>8.0%}  {top}')

    print('\n=== how tickers resolved')
    hc = collections.Counter(re.sub(r'/.*/', '/…/', (b.how.get(t) or '?')) for t in anchors)
    print('  ' + ', '.join(f'{k} {v}' for k, v in hc.most_common()))

    print('\n=== spot checks')
    for t in SPOT:
        if t not in anchors:
            print(f'  {t}: (not a target)')
            continue
        lst = anchors[t]
        s = '; '.join(f'{a["label"]} {a["w"]:.0%}' for a in lst[:4])
        print(f'  {t:<6} [{b.how.get(t)}] {s}{" …" if len(lst) > 4 else ""}')

    print('\n=== famous places (coordinate check)')
    for p in ['dc-treasury', 'dc-fed', 'boj-tokyo', 'snb-zurich', 'ecb-frankfurt', 'permian', 'cushing', 'escondida',
              'kolwezi', 'witwatersrand', 'bayan-obo', 'mcarthur-river', 'kazakh-isr', 'rockdale', 'grasberg']:
        pl = b.places[p]
        near = pl.get('near')
        nr, d = b.gaz.nearest(pl['lon'], pl['lat'])
        print(f'  {p:<16} {pl["lon"]:>9.4f},{pl["lat"]:>8.4f}  nearest GeoNames: {nr["name"]}, {nr["cc"]} ({d:.0f} km)'
              + (f'  | near {near[0]} {near[2]} km' if near else ''))

    print('\n=== explicit points: nearest town country vs intended country')
    for p, pl in sorted(b.places.items()):
        if pl.get('geo') != 'explicit' or pl.get('offshore') or not pl.get('cc'):
            continue
        nr, d = b.gaz.nearest(pl['lon'], pl['lat'])
        if nr and nr['cc'] != pl['cc'] and d < 60:
            print(f'  ? {p}: intended {pl["cc"]}, nearest town {nr["name"]}, {nr["cc"]} at {d:.0f} km')

    print('\n=== land check')
    print(f'  {len(land_bad)} problems' + ''.join('\n  ✗ ' + x for x in land_bad))
    for x in coastal:
        print('  ~ ' + x)
    if b.warnings:
        print('\n=== warnings')
        for w in b.warnings:
            print('  ! ' + w)
    if b.problems:
        print('\n=== PROBLEMS')
        for w in b.problems:
            print('  ✗ ' + w)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', help='comma-separated tickers to explain (writes nothing)')
    ap.add_argument('--out', help='output path (default web/data/geo/anchors.json; "-" = do not write)')
    sys.exit(build(ap.parse_args()))


if __name__ == '__main__':
    main()
