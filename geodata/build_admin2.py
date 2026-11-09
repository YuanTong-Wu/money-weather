#!/usr/bin/env python3
"""Real administrative units for the 真实 map (DESIGN.md §26 amendment 4): admin2 (county / 地级市 / 市区町村 /
시군구 / district / NUTS3 …) per country, admin3 (CN 区县, US places, JP 政令市 wards, KR 일반구, TW 鄉鎮市區 …) for the
dense metros, and web/data/geo/units.json (every HQ and anchor → [a1, a2, a3]).

    python3 -I geodata/build_admin2.py                       # everything (downloads are cached in geodata/admin2.nosync)
    python3 -I geodata/build_admin2.py --countries US,CN     # some countries (admin2 + their admin3), then units.json
    python3 -I geodata/build_admin2.py --level 2             # admin2 only (3 = admin3 only)
    python3 -I geodata/build_admin2.py --units-only          # only rebuild units.json + the report
    python3 -I geodata/build_admin2.py --check               # only validate the files on disk

Output contract (see geodata/units_README.md):
  web/vendor/geo/admin2/index.json  {ISO2: {file, object:"units", level:2, unit_zh, units, bytes, bbox, source, license, …}}
  web/vendor/geo/admin2/<ISO2>.json TopoJSON, object "units", properties {id, name, name_zh, a1, level:2}
  web/vendor/geo/admin3/index.json  {key: {file, cc, object:"units", level:3, bbox, a2:[parent ids], …}}
  web/vendor/geo/admin3/<key>.json  same properties + a2
  web/data/geo/units.json           {version, t:{TICKER:[a1,a2,a3|null]}, a:{anchorId:[a1,a2,a3|null]}}

How a file is made: source units (dissolved by code) are unioned with the country's own polygon from the app's coast
(web/vendor/geo/countries-10m.json): what is outside is cut off, land the source misses (coast differences) is given
to the touching unit — split between neighbours by nearest shared border — so the units tile exactly the country the
app draws. Coast and national borders keep the world-atlas vertices; only borders *between* units are simplified
(Douglas–Peucker, the finest step that fits the size cap). admin3 files are cut from the finished admin2 parents the
same way, so a parent drawn as admin2 and its neighbour drawn as admin3 share one border.

Needs Python 3 + numpy, Node, and mapshaper 0.6 (`npx -y mapshaper@0.6`, or $MAPSHAPER). Run with -I: downloaded
files are data only; opencc / unidecode (optional, for Chinese conversion and romanisation) are taken from the user's
site-packages explicitly.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import shlex
import shutil
import site
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GEO = Path(__file__).resolve().parent
VENDOR = ROOT / 'web' / 'vendor'
OUT2 = Path(os.environ.get('MW_ADMIN2_OUT') or VENDOR / 'geo' / 'admin2')   # env overrides: testing only
OUT3 = Path(os.environ.get('MW_ADMIN3_OUT') or VENDOR / 'geo' / 'admin3')
ADMIN1 = VENDOR / 'geo' / 'admin1'
UNITS_JSON = ROOT / 'web' / 'data' / 'geo' / 'units.json'
HQ_JSON = ROOT / 'web' / 'data' / 'geo' / 'hq.json'
ANCHORS_JSON = ROOT / 'web' / 'data' / 'geo' / 'anchors.json'
CACHE = GEO / 'admin2.nosync'
SRC = CACHE / 'src'
WORK = CACHE / 'work'
REPORT = Path(os.environ.get('MW_ADMIN2_REPORT') or CACHE / 'report.json')   # env override: testing only
OBJECT = 'units'
CAP2_KB = 1500
CAP3_KB = 1000
TOTAL_KB = 40000
UA = 'money-weather/geodata (build_admin2.py; open-data boundary build)'
# Douglas–Peucker tolerance ladder for the borders between units (metres): the finest that fits the cap wins.
LADDER = [0, 15, 25, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650, 800, 1000, 1300, 1600, 2000, 2600,
          3200, 4000, 5000, 6500, 8000]

# optional helpers from the user's site-packages (run with -I keeps the script / data dirs off sys.path)
try:
    import opencc  # noqa
except Exception:
    try:
        sys.path.append(site.getusersitepackages())
    except Exception:
        pass
try:
    import opencc
    _CC = opencc.OpenCC('t2s')
    t2s = _CC.convert
except Exception:  # pragma: no cover
    def t2s(s):
        return s
try:
    from unidecode import unidecode
except Exception:  # pragma: no cover
    def unidecode(s):
        return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()

sys.path.insert(0, str(GEO))
import geo_tables as T  # noqa: E402  (trusted, ours)
import units_refine as R  # noqa: E402  (trusted, ours: postcodes, zones, guesses for units.json)

ISO_NUM = {k: v[0] for k, v in T.COUNTRIES.items()}
ISO_NUM.update({'PY': '600', 'BT': '064', 'BO': '068', 'GN': '324', 'NE': '562', 'PR': '630', 'HK': '344',
                'MO': '446', 'TW': '158', 'BM': '060', 'KY': '136'})
NUM_ISO = {v: k for k, v in ISO_NUM.items()}
ISO3 = {}  # filled from the geoBoundaries metadata

# Japanese shinjitai → simplified Chinese (before OpenCC t2s), as in build_hq.py, plus a few more
JP2ZH = str.maketrans({'豊': '丰', '沢': '泽', '広': '广', '浜': '滨', '栄': '荣', '鉄': '铁', '関': '关', '徳': '德',
                       '恵': '惠', '歩': '步', '竜': '龙', '済': '济', '総': '总', '辺': '边', '亜': '亚', '桜': '樱',
                       '県': '县', '黒': '黑', '発': '发', '検': '检', '険': '险', '労': '劳', '営': '营', '覚': '觉',
                       '戸': '户', '瀬': '濑', '巣': '巢', '縄': '绳', '児': '儿', '斎': '斋', '蔵': '藏', '穂': '穗',
                       '芸': '艺', '塩': '盐', '宮': '宫', '岡': '冈', '渋': '涩', '駅': '驿', '円': '圆', '気': '气',
                       '団': '团', '仏': '佛', '払': '拂', '桧': '桧', '弘': '弘', '畑': '田', '峠': '岭', '込': '込',
                       '粂': '粂', '杁': '杁', '笹': '笹', '栃': '枥', '楢': '楢', '榊': '榊', '樫': '樫', '鴨': '鸭',
                       '奥': '奥', '郷': '乡', '尾': '尾', '鶴': '鹤', '亀': '龟', '飯': '饭', '館': '馆', '駒': '驹',
                       '騨': '驒', '嶋': '岛', '島': '岛', '黄': '黄', '条': '条', '舘': '馆', '澤': '泽', '濱': '滨',
                       '廣': '广', '邊': '边', '邉': '边', '齋': '斋', '當': '当', '萩': '萩', '倶': '俱', '縁': '缘',
                       '凪': '凪', '剣': '剑', '壱': '壹', '弐': '贰', '巻': '卷', '帯': '带', '寿': '寿', '曽': '曾',
                       '槇': '槙', '湯': '汤', '滝': '泷', '焼': '烧', '牟': '牟', '砺': '砺', '礼': '礼', '稲': '稻',
                       '粕': '粕', '芦': '芦', '蘂': '蕊', '覇': '霸', '観': '观', '谷': '谷', '賀': '贺', '郡': '郡',
                       '鎌': '镰', '隠': '隐', '静': '静', '韮': '韭', '頸': '颈', '鯖': '鲭', '鰺': '鲹', '麻': '麻'})
KANA_RE = re.compile(r'[぀-ヿ]')


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def norm(s):
    s = unidecode(s or '').lower()
    s = re.sub(r"[’'`]", '', s)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def slug(s):
    return re.sub(r'\s+', '-', norm(s)) or 'x'


def zh_cn(s):
    """Any CJK name (traditional / Japanese shinjitai) → simplified Chinese."""
    return t2s((s or '').translate(JP2ZH)) if s else ''


def km(lon1, lat1, lon2, lat2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(max(0.0, a)))


# ── shell / downloads ─────────────────────────────────────────────────────────────────────────────────────────
def mapshaper_cmd():
    env = os.environ.get('MAPSHAPER')
    if env:
        return shlex.split(env)
    if shutil.which('mapshaper'):
        return ['mapshaper']
    return ['npx', '-y', 'mapshaper@0.6']


def run(cmd, **kw):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)
    if r.returncode:
        raise SystemExit(f'command failed ({r.returncode}): {" ".join(map(str, cmd))[:600]}\n{r.stderr[-3000:]}')
    return r


def ms(*args):
    return run(mapshaper_cmd() + ['-quiet'] + list(args))


def fetch(url, dest: Path, timeout=600, tries=3, min_bytes=1):
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size >= min_bytes:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    err = None
    for k in range(tries):
        try:
            log(f'  ↓ {url}')
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            tmp = dest.with_name(dest.name + '.part')
            with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, 'wb') as f:
                shutil.copyfileobj(r, f)
            if tmp.stat().st_size < min_bytes:
                raise OSError(f'short download {tmp.stat().st_size} B')
            tmp.replace(dest)
            return dest
        except Exception as e:  # noqa
            err = e
            time.sleep(2 + 4 * k)
    raise SystemExit(f'download failed: {url}: {err}')


def read_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def write_json(path: Path, obj, compact=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
    tmp.replace(path)


def fc(features):
    return {'type': 'FeatureCollection', 'features': features}


def unzip_member(zp: Path, suffixes, dest_dir: Path):
    """Extract the members with these suffixes from a flat archive (refuses paths) → dest_dir. Returns paths."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = []
    with zipfile.ZipFile(zp) as z:
        for n in z.namelist():
            base = os.path.basename(n)
            if not base or base.startswith('.') or '..' in n:
                continue
            if any(base.lower().endswith(s) for s in suffixes):
                p = dest_dir / base
                if not p.exists() or p.stat().st_size != z.getinfo(n).file_size:
                    p.write_bytes(z.read(n))
                out.append(p)
    return out


# ── node helpers (vendored topojson-client + d3) ─────────────────────────────────────────────────────────────
NODE_TOPO2GEO = r"""
const fs = require('fs'), vm = require('vm'), path = require('path');
const [vendor, src, objName, out, idsJson, propsJson] = process.argv.slice(1);
const ctx = { self: {}, console }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(vendor, 'geo/topojson-client.min.js'), 'utf8'), ctx);
const { topojson } = ctx;
const t = JSON.parse(fs.readFileSync(src, 'utf8'));
const name = objName || Object.keys(t.objects)[0];
const ids = idsJson ? new Set(JSON.parse(idsJson)) : null;
const extra = propsJson ? JSON.parse(propsJson) : {};
const feats = topojson.feature(t, t.objects[name]).features
  .filter(f => !ids || ids.has(String(f.id)))
  .map(f => ({ type: 'Feature', geometry: f.geometry, properties: Object.assign({ fid: String(f.id) }, f.properties || {}, extra) }));
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features: feats }));
"""


def topo2geo(src: Path, out: Path, obj=None, ids=None, props=None):
    run(['node', '-e', NODE_TOPO2GEO, str(VENDOR), str(src), obj or '', str(out),
         json.dumps(sorted(ids)) if ids else '', json.dumps(props or {})])
    return out


def frame_path(cc: str) -> Path:
    """The country's polygon exactly as the app draws it (world-atlas countries-10m)."""
    p = WORK / '_frames' / f'{cc}.geojson'
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        topo2geo(VENDOR / 'geo' / 'countries-10m.json', p, 'countries', {ISO_NUM[cc]}, {'fr': 1})
        if not read_json(p)['features']:
            raise SystemExit(f'{cc}: no world-atlas feature {ISO_NUM.get(cc)}')
    return p


# ── TopoJSON decoding (python) ───────────────────────────────────────────────────────────────────────────────
def decode_arcs(topo):
    tr = topo.get('transform')
    arcs = []
    if tr:
        sx, sy = tr['scale']
        tx, ty = tr['translate']
        for arc in topo['arcs']:
            a = np.array(arc, dtype=np.float64)
            if len(a):
                a = np.cumsum(a, axis=0)
                a[:, 0] = a[:, 0] * sx + tx
                a[:, 1] = a[:, 1] * sy + ty
            arcs.append(a)
    else:
        arcs = [np.array(a, dtype=np.float64) for a in topo['arcs']]
    return arcs


def geom_polys(g):
    """TopoJSON geometry → list of polygons, each a list of rings, each a list of arc indexes."""
    if g.get('type') == 'Polygon':
        return [g['arcs']]
    if g.get('type') == 'MultiPolygon':
        return g['arcs']
    return []


def ring_coords(arcs, ring):
    pts = []
    for i in ring:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        if pts:
            a = a[1:]
        pts.append(a)
    return np.concatenate(pts) if pts else np.zeros((0, 2))


def ring_area_km2(r):
    if len(r) < 4:
        return 0.0
    lat = np.radians(r[:, 1].mean())
    x = r[:, 0] * 111.32 * math.cos(lat)
    y = r[:, 1] * 110.57
    return 0.5 * float(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1]))


def arc_len_km(a):
    if len(a) < 2:
        return 0.0
    lat = np.radians(a[:, 1].mean())
    d = np.diff(a, axis=0)
    return float(np.hypot(d[:, 0] * 111.32 * math.cos(lat), d[:, 1] * 110.57).sum())


class Shapes:
    """Decoded polygons of a TopoJSON object, for point-in-polygon and nearest-unit queries."""

    def __init__(self, topo, obj=OBJECT):
        arcs = decode_arcs(topo)
        self.items = []  # (id, props, [rings], bbox)
        for g in topo['objects'][obj]['geometries']:
            rings = []
            for poly in geom_polys(g):
                for ring in poly:
                    rings.append(ring_coords(arcs, ring))
            if not rings:
                continue
            allp = np.concatenate(rings)
            bb = (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())
            props = dict(g.get('properties') or {})
            self.items.append((g.get('id') or props.get('id'), props, rings, bb))

    @staticmethod
    def _inside(rings, x, y):
        c = False
        for r in rings:
            xs, ys = r[:, 0], r[:, 1]
            x1, y1, x2, y2 = xs[:-1], ys[:-1], xs[1:], ys[1:]
            m = ((y1 > y) != (y2 > y))
            if m.any():
                xi = x1[m] + (y - y1[m]) * (x2[m] - x1[m]) / (y2[m] - y1[m])
                c ^= bool((np.count_nonzero(xi > x)) & 1)
        return c

    def locate(self, lon, lat, snap_km=0.0, where=None):
        """(id, props, dist_km) of the unit containing the point, else the nearest within snap_km, else None."""
        for uid, p, rings, bb in self.items:
            if where and not where(p):
                continue
            if bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3] and self._inside(rings, lon, lat):
                return uid, p, 0.0
        if snap_km <= 0:
            return None
        dlat = snap_km / 110.57
        dlon = snap_km / (111.32 * max(0.05, math.cos(math.radians(lat))))
        best = None
        for uid, p, rings, bb in self.items:
            if where and not where(p):
                continue
            if bb[0] - dlon > lon or bb[2] + dlon < lon or bb[1] - dlat > lat or bb[3] + dlat < lat:
                continue
            for r in rings:
                d = seg_dist_km(r, lon, lat)
                if d <= snap_km and (best is None or d < best[2]):
                    best = (uid, p, d)
        return best


def seg_dist_km(r, lon, lat):
    c = math.cos(math.radians(lat))
    x = (r[:, 0] - lon) * 111.32 * c
    y = (r[:, 1] - lat) * 110.57
    x1, y1, x2, y2 = x[:-1], y[:-1], x[1:], y[1:]
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    t = np.where(L > 0, np.clip(-(x1 * dx + y1 * dy) / np.where(L > 0, L, 1), 0, 1), 0)
    px, py = x1 + t * dx, y1 + t * dy
    return float(np.sqrt((px * px + py * py).min())) if len(px) else 1e9


# ── geometry helpers on GeoJSON ──────────────────────────────────────────────────────────────────────────────
def gj_polys(g):
    if not g:
        return []
    if g['type'] == 'Polygon':
        return [g['coordinates']]
    if g['type'] == 'MultiPolygon':
        return g['coordinates']
    if g['type'] == 'GeometryCollection':
        out = []
        for x in g['geometries']:
            out += gj_polys(x)
        return out
    return []


def gj_bbox(features):
    xs, ys = [], []
    for f in features:
        for poly in gj_polys(f['geometry']):
            r = np.asarray(poly[0], dtype=float)
            xs += [r[:, 0].min(), r[:, 0].max()]
            ys += [r[:, 1].min(), r[:, 1].max()]
    return [min(xs), min(ys), max(xs), max(ys)]


def map_coords(g, fn):
    def rec(c):
        if isinstance(c[0], (int, float)):
            return list(fn(c[0], c[1]))
        return [rec(x) for x in c]
    return {'type': g['type'], 'coordinates': rec(g['coordinates'])}


# GCJ-02 (China's offset system, used by DataV / AMap) → WGS84. Verified on the Shenzhen district borders against
# OSM (geoBoundaries CHN ADM3): median distance 464 m raw → 205 m after the inverse transform (p25 286 → 80 m).
def _gcj_delta(lon, lat):
    a, ee = 6378245.0, 0.00669342162296594323
    x, y = lon - 105.0, lat - 35.0
    dlat = (-100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
            + (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2 / 3
            + (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2 / 3
            + (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2 / 3)
    dlon = (300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
            + (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2 / 3
            + (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2 / 3
            + (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2 / 3)
    rl = lat / 180 * math.pi
    m = 1 - ee * math.sin(rl) ** 2
    sm = math.sqrt(m)
    return dlon * 180 / (a / sm * math.cos(rl) * math.pi), dlat * 180 / ((a * (1 - ee)) / (m * sm) * math.pi)


def gcj2wgs(lon, lat):
    if not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271):
        return lon, lat
    wl, wt = lon, lat
    for _ in range(3):  # fixed-point iteration of the forward transform
        dx, dy = _gcj_delta(wl, wt)
        wl, wt = lon - dx, lat - dy
    return round(wl, 6), round(wt, 6)


# ── fit: source units ∪ the app's country polygon → units that tile the country exactly ─────────────────────
def _topo_pieces(topo, layer):
    """mapshaper TopoJSON (one layer) → arcs, [(props, rings(list of arc idx lists))] (single polygons)."""
    arcs = decode_arcs(topo)
    pieces = []
    for g in topo['objects'][layer]['geometries']:
        for poly in geom_polys(g):
            pieces.append((dict(g.get('properties') or {}), poly))
    return arcs, pieces


def _densify(a, step_km):
    out = [a[0]]
    lat = math.radians(float(a[:, 1].mean()))
    for p, q in zip(a[:-1], a[1:]):
        d = math.hypot((q[0] - p[0]) * 111.32 * math.cos(lat), (q[1] - p[1]) * 110.57)
        n = int(d / step_km)
        for k in range(1, n + 1):
            out.append(p + (q - p) * k / (n + 1))
        out.append(q)
    return np.array(out)


def _cells_for(rings, cell_m, cap=30000):
    """Square cells (lon/lat boxes on a global grid) covering a polygon: per row, from the leftmost to the rightmost
    edge inside the row (over-coverage is harmless, the union cuts it away)."""
    allp = np.concatenate(rings)
    lat0 = float(allp[:, 1].mean())
    while True:
        dlat = cell_m / 110570.0
        dlon = cell_m / (111320.0 * max(0.05, math.cos(math.radians(lat0))))
        rows = {}
        for r in rings:
            for (x1, y1), (x2, y2) in zip(r[:-1], r[1:]):
                j0, j1 = int(math.floor(min(y1, y2) / dlat)), int(math.floor(max(y1, y2) / dlat))
                for j in range(j0, j1 + 1):
                    b0, b1 = j * dlat, (j + 1) * dlat
                    if y1 == y2:
                        xa, xb = min(x1, x2), max(x1, x2)
                    else:
                        ta = (max(b0, min(y1, y2)) - y1) / (y2 - y1)
                        tb = (min(b1, max(y1, y2)) - y1) / (y2 - y1)
                        xa_, xb_ = x1 + ta * (x2 - x1), x1 + tb * (x2 - x1)
                        xa, xb = min(xa_, xb_), max(xa_, xb_)
                    lo, hi = rows.get(j, (xa, xb))
                    rows[j] = (min(lo, xa), max(hi, xb))
        n = sum(int(math.floor(hi / dlon)) - int(math.floor(lo / dlon)) + 1 for lo, hi in rows.values())
        if n <= cap:
            break
        cell_m *= math.sqrt(n / cap) * 1.05
    cells = []
    for j, (lo, hi) in rows.items():
        for i in range(int(math.floor(lo / dlon)), int(math.floor(hi / dlon)) + 1):
            x0, y0 = i * dlon, j * dlat
            cells.append([[x0, y0], [x0, y0 + dlat], [x0 + dlon, y0 + dlat], [x0 + dlon, y0], [x0, y0]])
    return cells, cell_m


def fit_units(tag, src_feats, frame_feats, wd: Path, rest_of=None, thin_m=120.0, presimplify=None):
    """Union source units (props code) with the frame (props fr=1 [, a2]) and give every bit of frame land to a
    unit. Returns {key: geometry} where key = code (admin2) or (code, a2) (admin3, frame carries a2).

    rest_of: admin3 only — a2 → code of the parent's "rest" unit; gap pieces that are not thin slivers become that
    unit (US unincorporated land) instead of being handed to the neighbours."""
    wd.mkdir(parents=True, exist_ok=True)
    s, f = wd / 'src.geojson', wd / 'frame.geojson'
    write_json(s, fc(src_feats))
    write_json(f, fc(frame_feats))
    mos = wd / 'mos.json'
    pre = ['-simplify', f'interval={presimplify}', 'keep-shapes', 'target=src'] if presimplify else []
    ms('-i', s, f, 'combine-files', 'snap',
       '-dissolve2', 'code', 'target=src',
       *pre,
       '-union', 'target=src,frame', 'name=mos',
       '-explode', 'target=mos',
       '-o', 'target=mos', 'format=topojson', 'no-quantization', mos)
    topo = read_json(mos)
    arcs, pieces = _topo_pieces(topo, 'mos')
    has_a2 = any('a2' in p for p, _ in pieces)

    def key_of(p):
        return (p['code'], p.get('a2')) if has_a2 else p['code']

    if has_a2:
        # admin3: a source unit belongs to the parent holding most of it; bits that spill over a (simplified) parent
        # border into another parent are gaps there, unless they are a real part of the unit (≥ 10 % and ≥ 0.5 km²,
        # e.g. a city spanning two counties)
        area = defaultdict(float)
        for p, poly in pieces:
            if p.get('fr') and p.get('code') not in (None, ''):
                r = ring_coords(arcs, poly[0])
                area[(p['code'], p.get('a2'))] += abs(ring_area_km2(r))
        tot = defaultdict(float)
        home = {}
        for (code, a2), ar in area.items():
            tot[code] += ar
            if ar > home.get(code, (None, -1))[1]:
                home[code] = (a2, ar)
        for p, poly in pieces:
            c = p.get('code')
            if p.get('fr') and c not in (None, '') and p.get('a2') != home[c][0]:
                ar = area[(c, p.get('a2'))]
                if ar < 0.5 or ar < 0.10 * tot[c]:
                    p['code'] = None
    units, gaps = [], []
    for i, (p, poly) in enumerate(pieces):
        if not p.get('fr'):
            continue  # outside the app's land: cut off
        (units if p.get('code') not in (None, '') else gaps).append(i)
    arc_users = defaultdict(list)
    for i in units + gaps:
        for ring in pieces[i][1]:
            for a in ring:
                arc_users[a if a >= 0 else ~a].append(i)
    unit_set = set(units)
    assign = {}  # piece index -> key
    for i in units:
        assign[i] = key_of(pieces[i][0])
    split, isolated = [], []
    for g in gaps:
        gp = pieces[g][0]
        nb = defaultdict(float)
        seeds = defaultdict(list)
        for ring in pieces[g][1]:
            for a in ring:
                ai = a if a >= 0 else ~a
                for j in arc_users[ai]:
                    if j != g and j in unit_set and (not has_a2 or pieces[j][0].get('a2') == gp.get('a2')):
                        k = key_of(pieces[j][0])
                        nb[k] += arc_len_km(arcs[ai])
                        seeds[k].append(arcs[ai])
        rings = [ring_coords(arcs, r) for r in pieces[g][1]]
        area = abs(ring_area_km2(rings[0])) - sum(abs(ring_area_km2(r)) for r in rings[1:])
        perim = sum(arc_len_km(r) for r in rings)
        thin = (2 * area / max(perim, 1e-9)) * 1000 < thin_m  # mean width in metres
        if rest_of is not None and not thin and gp.get('a2') in rest_of:
            assign[g] = (rest_of[gp['a2']], gp['a2'])
            continue
        if not nb:
            isolated.append((g, rings))
        elif len(nb) == 1:
            assign[g] = next(iter(nb))
        else:
            split.append((g, rings, seeds))
    # isolated land (an island the source does not have): nearest unit (same parent for admin3)
    if isolated:
        pts_by_key = defaultdict(list)
        for i in units:
            k = key_of(pieces[i][0])
            for r in pieces[i][1][:1]:
                c = ring_coords(arcs, r)
                pts_by_key[k].append(c[::max(1, len(c) // 200)])
        keys = list(pts_by_key)
        P = [np.concatenate(pts_by_key[k]) for k in keys]
        for g, rings in isolated:
            gp = pieces[g][0]
            c = rings[0].mean(axis=0)
            best = None
            for k, pp in zip(keys, P):
                if has_a2 and k[1] != gp.get('a2'):
                    continue
                d = float((((pp[:, 0] - c[0]) * math.cos(math.radians(c[1]))) ** 2 + (pp[:, 1] - c[1]) ** 2).min())
                if best is None or d < best[0]:
                    best = (d, k)
            if best is not None:
                assign[g] = best[1]
            elif rest_of is not None and gp.get('a2') in rest_of:
                assign[g] = (rest_of[gp['a2']], gp['a2'])
            elif has_a2 and gp.get('a2'):  # a parent the source has nothing for: keep it whole as one unit
                assign[g] = (f"{gp['a2'][3:]}-rest", gp['a2'])
    # gaps touching several units: cut on a fine grid, each bit to the unit whose shared border is nearest
    out_feats = []
    if split:
        gfe, cfe = [], []
        seedmap = {}
        for g, rings, seeds in split:
            area = abs(ring_area_km2(rings[0]))
            cell_m = max(150.0, min(1500.0, math.sqrt(max(area, 1e-6)) * 1000 / 6))
            cells, cell_m = _cells_for(rings, cell_m)
            gfe.append({'type': 'Feature', 'properties': {'gid': g},
                        'geometry': {'type': 'Polygon', 'coordinates': [r.tolist() for r in rings]}})
            for c in cells:
                cfe.append({'type': 'Feature', 'properties': {'cid': 1}, 'geometry': {'type': 'Polygon', 'coordinates': [c]}})
            ks = list(seeds)
            pts, lab = [], []
            for n, k in enumerate(ks):
                for a in seeds[k]:
                    d = _densify(a, cell_m / 3000.0)
                    pts.append(d)
                    lab += [n] * len(d)
            seedmap[g] = (ks, np.concatenate(pts), np.array(lab))
        gs, cs, sub = wd / 'gapsplit.geojson', wd / 'cells.geojson', wd / 'sub.json'
        write_json(gs, fc(gfe))
        write_json(cs, fc(cfe))
        ms('-i', gs, cs, 'combine-files', 'snap', '-union', 'target=gapsplit,cells', 'name=sub', '-explode',
           'target=sub', '-filter', 'gid != null', 'target=sub', '-o', 'target=sub', 'format=topojson', 'no-quantization', sub)
        st = read_json(sub)
        sarcs, spieces = _topo_pieces(st, 'sub')
        for p, poly in spieces:
            g = p.get('gid')
            if g is None or g not in seedmap:
                continue
            ks, P, lab = seedmap[g]
            r = ring_coords(sarcs, poly[0])
            c = r[:-1].mean(axis=0)
            cl = math.cos(math.radians(c[1]))
            k = ks[int(lab[int((((P[:, 0] - c[0]) * cl) ** 2 + (P[:, 1] - c[1]) ** 2).argmin())])]
            out_feats.append((k, {'type': 'Polygon', 'coordinates': [ring_coords(sarcs, rr).tolist() for rr in poly]}))
    for i, k in assign.items():
        out_feats.append((k, {'type': 'Polygon', 'coordinates': [ring_coords(arcs, r).tolist() for r in pieces[i][1]]}))
    # dissolve per key
    keyname = {}
    feats = []
    for k, geom in out_feats:
        kk = keyname.setdefault(k, f'k{len(keyname)}')
        feats.append({'type': 'Feature', 'properties': {'kk': kk}, 'geometry': geom})
    pp, fo = wd / 'pieces.geojson', wd / 'fit.json'
    write_json(pp, fc(feats))
    ms('-i', pp, 'snap', '-dissolve2', 'kk', '-o', 'format=geojson', fo)
    back = {v: k for k, v in keyname.items()}
    res = {}
    for ft in read_json(fo)['features']:
        if ft.get('geometry'):
            g = clean_parts(ft['geometry'])
            if g:
                res[back[ft['properties']['kk']]] = g
    stats = {'units_in': len({key_of(pieces[i][0]) for i in units}), 'gaps': len(gaps), 'gaps_split': len(split),
             'gaps_isolated': len(isolated), 'units_out': len(res)}
    log(f'    fit {tag}: {stats}')
    return res, stats


def clean_parts(g, min_km2=0.02):
    """Drop specks: polygon parts (never the largest) and holes smaller than min_km2."""
    polys = gj_polys(g)
    if not polys:
        return None
    areas = [abs(ring_area_km2(np.asarray(p[0], dtype=float))) for p in polys]
    big = int(np.argmax(areas))
    out = []
    for i, p in enumerate(polys):
        if i != big and areas[i] < min_km2:
            continue
        out.append([p[0]] + [h for h in p[1:] if abs(ring_area_km2(np.asarray(h, dtype=float))) >= min_km2])
    return {'type': 'Polygon', 'coordinates': out[0]} if len(out) == 1 else {'type': 'MultiPolygon', 'coordinates': out}


# ── TopoJSON output with interior-only simplification ────────────────────────────────────────────────────────
def dp_keep(xy, tol):
    """Douglas–Peucker on an (n,2) array in metres; returns a boolean mask of kept points (ends kept)."""
    n = len(xy)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    if n <= 2 or tol <= 0:
        keep[:] = True
        return keep
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = xy[i], xy[j]
        seg = xy[i + 1:j]
        d = b - a
        L = math.hypot(d[0], d[1])
        if L == 0:
            dist = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1])
        else:
            dist = np.abs(d[0] * (seg[:, 1] - a[1]) - d[1] * (seg[:, 0] - a[0])) / L
        k = int(dist.argmax())
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return keep


def _to_m(a):
    lat = math.radians(float(a[:, 1].mean()))
    return np.column_stack([a[:, 0] * 111320.0 * math.cos(lat), a[:, 1] * 110570.0])


class TopoOut:
    """A mapshaper TopoJSON of the finished units (no quantization) → compact quantized TopoJSON in which only the
    arcs between two units (and not locked) are simplified."""

    sparse_tol = 800.0  # metres, coast / border arcs with no company within ~60 km (Alaska, Arctic Canada, Siberia …)
    coast_tol = 60.0    # metres, every other coast / border arc (world-atlas 10m is quantised to ~300 m anyway)

    def __init__(self, raw_topo, layer, lock=None, dense=None):
        self.topo = raw_topo
        self.layer = layer
        self.arcs = decode_arcs(raw_topo)
        self.geoms = raw_topo['objects'][layer]['geometries']
        users = defaultdict(set)
        for gi, g in enumerate(self.geoms):
            for poly in geom_polys(g):
                for ring in poly:
                    for a in ring:
                        users[a if a >= 0 else ~a].add(gi)
        self.interior = set()
        for ai, us in users.items():
            if len(us) >= 2:
                us = sorted(us)
                if lock and any(lock(self.geoms[x], self.geoms[y]) for x in us for y in us if x < y):
                    continue
                self.interior.add(ai)
        self.closed = {ai for ai, a in enumerate(self.arcs) if len(a) > 3 and np.allclose(a[0], a[-1])}
        self.m = [_to_m(a) if len(a) else a for a in self.arcs]
        allp = np.concatenate([a for a in self.arcs if len(a)])
        self.bbox = [float(allp[:, 0].min()), float(allp[:, 1].min()), float(allp[:, 0].max()), float(allp[:, 1].max())]
        # adaptive: borders near companies keep more detail than empty countryside
        self.factor = np.ones(len(self.arcs))
        self.sparse_ext = set()   # coast / national border arcs with no company within ~100 km
        if dense is not None and len(dense):
            cell = 0.35
            grid = Counter((int(math.floor(x / cell)), int(math.floor(y / cell))) for x, y in dense)
            big = Counter((int(math.floor(x / 0.6)), int(math.floor(y / 0.6))) for x, y in dense)
            for ai in range(len(self.arcs)):
                a = self.arcs[ai]
                if not len(a):
                    continue
                if ai in self.interior:
                    n = 0
                    for x, y in (a[0], a[len(a) // 2], a[-1]):
                        i, j = int(math.floor(x / cell)), int(math.floor(y / cell))
                        n = max(n, sum(grid.get((i + di, j + dj), 0) for di in (-1, 0, 1) for dj in (-1, 0, 1)))
                    self.factor[ai] = 0.3 if n >= 8 else 0.5 if n >= 2 else 1.0 if n >= 1 else 3.0
                else:
                    near = False
                    for x, y in a[::max(1, len(a) // 12)]:
                        i, j = int(math.floor(x / 0.6)), int(math.floor(y / 0.6))
                        if any(big.get((i + di, j + dj)) for di in (-1, 0, 1) for dj in (-1, 0, 1)):
                            near = True
                            break
                    if not near:
                        self.sparse_ext.add(ai)
        # signed ring areas of the unsimplified rings (to catch rings flipped by simplification)
        self.ring_sign = {}
        self.geom_area = defaultdict(float)
        for gi, g in enumerate(self.geoms):
            for pi, poly in enumerate(geom_polys(g)):
                for ri, ring in enumerate(poly):
                    self.ring_sign[(gi, pi, ri)] = a = ring_area_km2(ring_coords(self.arcs, ring))
                    if ri == 0:
                        self.geom_area[gi] += abs(a)

    def simplified(self, tol, tol_ext=0.0):
        out = []
        for ai, a in enumerate(self.arcs):
            if ai in self.interior:
                t = tol * self.factor[ai]
            else:
                t = max(tol_ext, self.sparse_tol if ai in self.sparse_ext else self.coast_tol)
            if t <= 0 or len(a) <= 2:
                out.append(a)
                continue
            xy = self.m[ai]
            if ai in self.closed:
                far = int(np.hypot(*(xy - xy[0]).T).argmax())
                k1 = dp_keep(xy[:far + 1], t)
                k2 = dp_keep(xy[far:], t)
                keep = np.concatenate([k1, k2[1:]])
                if keep.sum() < 4:
                    idx = np.linspace(0, len(a) - 1, 4).astype(int)
                    keep[idx] = True
            else:
                keep = dp_keep(xy, t)
            out.append(a[keep])
        # rings must keep their area and orientation: a ring that collapsed (< 3 distinct points), flipped, or lost
        # more than half its area gets its original arcs back (shared arcs change for both neighbours alike)
        for _ in range(3):
            bad = 0
            for gi, g in enumerate(self.geoms):
                for pi, poly in enumerate(geom_polys(g)):
                    for ri, ring in enumerate(poly):
                        c = ring_coords(out, ring)
                        a0 = self.ring_sign[(gi, pi, ri)]
                        a1 = ring_area_km2(c)
                        ok = len({(round(x, 7), round(y, 7)) for x, y in c}) >= 3 and a1 * a0 > 0 and \
                            abs(a1) >= 0.5 * abs(a0) and abs(a1) <= 2 * abs(a0) + 0.05
                        if not ok:
                            for x in ring:
                                ai = x if x >= 0 else ~x
                                if out[ai] is not self.arcs[ai]:
                                    out[ai] = self.arcs[ai]
                                    bad += 1
            if not bad:
                break
        return out

    def encode(self, arcs, grid_m):
        x0, y0, x1, y1 = self.bbox
        # per-axis grid of ~grid_m metres (at the latitude where most of the units are)
        lat_ref = float(np.median(np.concatenate([a[:, 1] for a in self.arcs if len(a)])))
        kx = grid_m / (111320.0 * max(0.1, math.cos(math.radians(lat_ref))))
        ky = grid_m / 110570.0
        enc = []
        for a in arcs:
            if not len(a):
                enc.append([])
                continue
            ix = np.round((a[:, 0] - x0) / kx).astype(np.int64)
            iy = np.round((a[:, 1] - y0) / ky).astype(np.int64)
            pts = np.column_stack([ix, iy])
            keep = np.ones(len(pts), dtype=bool)
            keep[1:] = np.any(pts[1:] != pts[:-1], axis=1)
            keep[-1] = True
            pts = pts[keep]
            if len(pts) == 1:
                pts = np.vstack([pts, pts])
            d = np.vstack([pts[:1], np.diff(pts, axis=0)])
            enc.append(d.tolist())
        return {'scale': [kx, ky], 'translate': [x0, y0]}, enc

    def build(self, tol, props_of, meta, grid_m=None, tol_ext=0.0):
        arcs = self.simplified(tol, tol_ext)
        grid = grid_m or min(40.0, max(5.0, tol / 8 if tol else 5.0))
        tr, enc = self.encode(arcs, grid)
        # rings as they will be decoded: drop parts / holes that quantisation flipped or squashed to nothing
        dec = decode_arcs({'transform': tr, 'arcs': enc})
        geoms = []
        for gi, g in enumerate(self.geoms):
            p = props_of(g)
            if self.geom_area.get(gi, 0) < 0.005:  # a speck (< 5,000 m²) left by clipping: not a unit (its area is invisible)
                continue
            polys = []
            for pi, poly in enumerate(geom_polys(g)):
                keep = []
                for ri, ring in enumerate(poly):
                    a0 = self.ring_sign[(gi, pi, ri)]
                    a1 = ring_area_km2(ring_coords(dec, ring))
                    if a1 * a0 > 0 and abs(a1) > 1e-5:
                        keep.append(ring)
                    elif ri == 0:
                        keep = None
                        break
                if keep:
                    polys.append(keep)
            if not polys:  # never lose a unit: keep its largest part as is
                polys = [max(geom_polys(g), key=lambda pl: abs(ring_area_km2(ring_coords(dec, pl[0]))))]
            if len(polys) == 1:
                geoms.append({'type': 'Polygon', 'id': p['id'], 'arcs': polys[0], 'properties': p})
            else:
                geoms.append({'type': 'MultiPolygon', 'id': p['id'], 'arcs': polys, 'properties': p})
        geoms.sort(key=lambda g: g['id'])
        return {'type': 'Topology', 'bbox': [round(v, 5) for v in self.bbox], 'transform': tr,
                'objects': {OBJECT: {'type': 'GeometryCollection', 'geometries': geoms}}, 'arcs': enc, 'meta': meta}


def size_of(obj):
    return len(json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode())


def fit_to_cap(to: TopoOut, props_of, meta, cap_kb, min_tol=0):
    ladder = [t for t in LADDER if t >= min_tol]
    lo, hi, best = 0, len(ladder) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        topo = to.build(ladder[mid], props_of, dict(meta, simplify_m=ladder[mid]))
        sz = size_of(topo)
        if sz <= cap_kb * 1000:
            best, hi = (ladder[mid], topo, sz), mid - 1
        else:
            lo = mid + 1
    if best is None:  # the coast alone is too big: simplify it as well (documented in meta)
        for te in [300, 600, 1000, 1600, 2500, 4000, 6500]:
            topo = to.build(ladder[-1], props_of, dict(meta, simplify_m=ladder[-1], coast_simplify_m=te), tol_ext=te)
            sz = size_of(topo)
            if sz <= cap_kb * 1000:
                best = (ladder[-1], topo, sz)
                break
    if best is None:
        raise SystemExit(f'{meta.get("key")}: does not fit {cap_kb} KB')
    return best


# ── sources ──────────────────────────────────────────────────────────────────────────────────────────────────
CENSUS = 'https://www2.census.gov/geo/tiger/GENZ2023/shp/'
DATAV = 'https://geo.datav.aliyun.com/areas_v3/bound/'
GISCO_NUTS3 = 'https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2021_4326_LEVL_3.geojson'
GB_API = 'https://www.geoboundaries.org/api/current/gbOpen/ALL/{lvl}/'
STATCAN = ('https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/{layer}/query')
JP_N03 = ('https://cdn.jsdelivr.net/gh/smartnews-smri/japan-topography@main/data/municipality/geojson/s0010/'
          'N03-21_{p:02d}_210101.json')
KR_ADM = 'https://raw.githubusercontent.com/vuski/admdongkor/master/ver20261001/HangJeongDong_ver20261001.geojson'
TW_ATLAS = 'https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/{f}-10t.json'
GEONAMES = 'https://download.geonames.org/export/dump/'

LICENSES = {
    'census': ('US Census Bureau cartographic boundary files 2023 (1:500k), counties / places / county subdivisions',
               'Public domain (US federal government)'),
    'datav': ('DataV.GeoAtlas (Aliyun) areas_v3, from 国家地理信息公共服务平台 天地图 data; GCJ-02 → WGS84 corrected',
              'Free to use with attribution (DataV.GeoAtlas / 天地图); 审图号 GS(2024)0650'),
    'n03': ('国土交通省 国土数値情報 行政区域 N03 (2021-01-01), simplified by SmartNews Media Research Institute '
            '(japan-topography, s0010)', '国土数値情報 利用規約 (credit: 「国土数値情報（行政区域データ）」（国土交通省）を加工して作成)'),
    'kr': ('통계청 SGIS 행정동 경계 2026-10-01 via vuski/admdongkor, dissolved to 시군구 / 일반구',
           'Korea Open Government License (KOGL) type 1 / repository MIT'),
    'tw': ('內政部國土測繪中心 鄉鎮市區界線 via taiwan-atlas 2021.9.20', 'Open Government Data License, version 1.0 (Taiwan)'),
    'nuts': ('Eurostat GISCO NUTS 2021 level 3, 1:1 million', '© EuroGeographics for the administrative boundaries; '
             'Eurostat copyright notice (free re-use with attribution)'),
    'statcan': ('Statistics Canada 2021 cartographic boundary file, census divisions (geo.statcan.gc.ca REST)',
                'Open Government Licence – Canada'),
}


def gb_meta(lvl):
    p = CACHE / 'meta' / f'gb_ALL_{lvl}.json'
    fetch(GB_API.format(lvl=lvl), p, min_bytes=1000)
    d = read_json(p)
    for x in d:
        ISO3.setdefault(x['boundaryISO'], x['boundaryISO'])
    return {x['boundaryISO']: x for x in d}


def iso3_of(cc):
    a = T.COUNTRIES.get(cc)
    # geo_tables has no ISO3; use the geoBoundaries metadata names → ISO3 via a static table
    return ISO2_3.get(cc)


ISO2_3 = {
    'US': 'USA', 'CN': 'CHN', 'JP': 'JPN', 'TW': 'TWN', 'HK': 'HKG', 'KR': 'KOR', 'IN': 'IND', 'GB': 'GBR', 'DE': 'DEU',
    'FR': 'FRA', 'CA': 'CAN', 'AU': 'AUS', 'CH': 'CHE', 'NL': 'NLD', 'SE': 'SWE', 'BR': 'BRA', 'SG': 'SGP', 'IE': 'IRL',
    'IL': 'ISR', 'UY': 'URY', 'FI': 'FIN', 'DK': 'DNK', 'BM': 'BMU', 'ES': 'ESP', 'IT': 'ITA', 'NO': 'NOR', 'PL': 'POL',
    'BE': 'BEL', 'MX': 'MEX', 'LU': 'LUX', 'AT': 'AUT', 'PE': 'PER', 'ZA': 'ZAF', 'CL': 'CHL', 'ID': 'IDN', 'RU': 'RUS',
    'SA': 'SAU', 'TR': 'TUR', 'KZ': 'KAZ', 'CO': 'COL', 'AR': 'ARG', 'VN': 'VNM', 'GH': 'GHA', 'MY': 'MYS', 'TH': 'THA',
    'PH': 'PHL', 'EG': 'EGY', 'UZ': 'UZB', 'CD': 'COD', 'EC': 'ECU', 'PG': 'PNG', 'ET': 'ETH', 'PY': 'PRY', 'BT': 'BTN',
    'AE': 'ARE', 'QA': 'QAT', 'RO': 'ROU', 'PA': 'PAN', 'CZ': 'CZE', 'HU': 'HUN', 'PR': 'PRI', 'SN': 'SEN', 'BF': 'BFA',
    'BO': 'BOL', 'ZW': 'ZWE', 'DO': 'DOM', 'TZ': 'TZA', 'GN': 'GIN', 'GR': 'GRC', 'BW': 'BWA', 'ZM': 'ZMB', 'JO': 'JOR',
    'PT': 'PRT', 'NA': 'NAM', 'NE': 'NER', 'MG': 'MDG', 'CI': 'CIV', 'UA': 'UKR', 'KY': 'CYM', 'MO': 'MAC', 'NZ': 'NZL',
    'GR_': 'GRC', 'CY': 'CYP', 'MC': 'MCO', 'JE': 'JEY', 'GG': 'GGY', 'IM': 'IMN', 'BG': 'BGR', 'HR': 'HRV', 'SK': 'SVK',
    'SI': 'SVN', 'LT': 'LTU', 'LV': 'LVA', 'EE': 'EST', 'IS': 'ISL', 'MT': 'MLT', 'NG': 'NGA', 'KE': 'KEN', 'MA': 'MAR',
    'PK': 'PAK', 'BD': 'BGD', 'LK': 'LKA', 'KW': 'KWT', 'BH': 'BHR', 'OM': 'OMN', 'GT': 'GTM', 'CR': 'CRI', 'JM': 'JAM',
}


GB_FULL = {'IN', 'AU', 'CH', 'NL', 'SE', 'BR', 'SG', 'IL', 'UY', 'FI', 'DK', 'NO', 'PL', 'MX', 'AT', 'LU'}


def src_geoboundaries(cc, lvl='ADM2'):
    """geoBoundaries gbOpen. Markets with companies use the full-resolution TopoJSON (the 'simplified' GeoJSON is
    ~500 m coarse); anchor-only countries use the simplified file."""
    meta = gb_meta(lvl).get(ISO2_3[cc])
    if not meta:
        return None, None
    if cc in GB_FULL and lvl != 'ADM1':
        p = SRC / 'geoboundaries' / f'{ISO2_3[cc]}_{lvl}_full.geojson'
        if not p.exists():
            tj = fetch(meta['tjDownloadURL'], SRC / 'geoboundaries' / f'{ISO2_3[cc]}_{lvl}.topojson', min_bytes=1000)
            ms('-i', tj, '-merge-layers', 'force', '-o', 'format=geojson', p)
    else:
        p = SRC / 'geoboundaries' / f'{ISO2_3[cc]}_{lvl}_simplified.geojson'
        fetch(meta['simplifiedGeometryGeoJSON'], p, min_bytes=200)
    feats = read_json(p)['features']
    out, seen = [], Counter()
    isos = Counter((f['properties'].get('shapeISO') or '').strip() for f in feats)
    for f in feats:
        pr = f['properties']
        name = (pr.get('shapeName') or '').strip() or '?'
        iso = (pr.get('shapeISO') or '').strip()
        code = iso if iso and isos[iso] == 1 and re.fullmatch(r'[A-Z]{2}-[A-Z0-9]{1,4}', iso) else slug(name)
        seen[code] += 1
        if seen[code] > 1:
            code = f'{code}-{seen[code]}'
        if code.startswith(cc + '-'):
            code = code[len(cc) + 1:]
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': code, 'name': name, 'name_zh': '', 'iso': iso}})
    src = (f"geoBoundaries gbOpen {ISO2_3[cc]} {lvl} ({meta.get('boundaryYearRepresented')}, "
           f"{meta.get('boundarySource')})")
    return out, (src, meta.get('boundaryLicense') or '')


# --- US (Census) ---
def census_geojson(kind, fips='us'):
    """cb_2023_<fips>_<kind>_500k as GeoJSON (cached)."""
    stem = f'cb_2023_{fips}_{kind}_500k'
    gj = SRC / 'census' / f'{stem}.geojson'
    if gj.exists():
        return gj
    zp = fetch(CENSUS + stem + '.zip', SRC / 'census' / f'{stem}.zip', min_bytes=1000)
    files = unzip_member(zp, ['.shp', '.shx', '.dbf', '.prj', '.cpg'], SRC / 'census' / stem)
    shp = [p for p in files if p.suffix == '.shp'][0]
    ms('-i', shp, 'encoding=utf8', '-proj', 'wgs84', '-o', 'format=geojson', gj)
    return gj


US_TERR = {'60', '66', '69', '78'}
US_ZH = {  # counties whose usual Chinese name is not a plain transliteration
    '36061': '曼哈顿（纽约县）', '36047': '布鲁克林（国王县）', '36081': '皇后区', '36005': '布朗克斯', '36085': '史泰登岛',
    '11001': '华盛顿哥伦比亚特区', '06075': '旧金山', '06085': '圣克拉拉县', '06081': '圣马特奥县', '06001': '阿拉米达县',
    '06037': '洛杉矶县', '06073': '圣迭戈县', '06059': '橙县', '53033': '金县（西雅图）', '48453': '特拉维斯县（奥斯汀）',
    '48201': '哈里斯县（休斯敦）', '48113': '达拉斯县', '17031': '库克县（芝加哥）', '25025': '萨福克县（波士顿）',
    '25017': '米德尔塞克斯县', '13121': '富尔顿县（亚特兰大）', '37119': '梅克伦堡县（夏洛特）', '42101': '费城',
    '24510': '巴尔的摩市', '51059': '费尔法克斯县', '51013': '阿灵顿县', '06013': '康特拉科斯塔县', '06041': '马林县',
    '04013': '马里科帕县（凤凰城）', '08031': '丹佛', '27053': '亨内平县（明尼阿波利斯）', '12086': '迈阿密-戴德县',
    '29510': '圣路易斯市', '39035': '凯霍加县（克利夫兰）', '26163': '韦恩县（底特律）', '41051': '马尔特诺马县（波特兰）',
    '47157': '谢尔比县（孟菲斯）', '48029': '贝克萨尔县（圣安东尼奥）', '48085': '科林县', '48439': '塔兰特县',
    '34017': '哈德逊县', '34013': '埃塞克斯县（纽瓦克）', '09001': '费尔菲尔德县', '36119': '韦斯特切斯特县',
    '05007': '本顿县（沃尔玛）', '41067': '华盛顿县（耐克）', '53053': '皮尔斯县', '15003': '檀香山',
}


def src_us(territory=False):
    feats = read_json(census_geojson('county'))['features']
    out = []
    for f in feats:
        p = f['properties']
        st = p['STATEFP']
        if st in US_TERR or (st == '72') != territory:
            continue
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': p['GEOID'], 'name': p['NAMELSAD'], 'name_zh': US_ZH.get(p['GEOID'], ''),
                                   'a1': 'US-PR' if territory else f"US-{p['STUSPS']}"}})
    return out, LICENSES['census']


# --- China / HK / Macau (DataV, GCJ-02) ---
CN_PROV_ISO = {'11': 'CN-BJ', '12': 'CN-TJ', '13': 'CN-HE', '14': 'CN-SX', '15': 'CN-NM', '21': 'CN-LN', '22': 'CN-JL',
               '23': 'CN-HL', '31': 'CN-SH', '32': 'CN-JS', '33': 'CN-ZJ', '34': 'CN-AH', '35': 'CN-FJ', '36': 'CN-JX',
               '37': 'CN-SD', '41': 'CN-HA', '42': 'CN-HB', '43': 'CN-HN', '44': 'CN-GD', '45': 'CN-GX', '46': 'CN-HI',
               '50': 'CN-CQ', '51': 'CN-SC', '52': 'CN-GZ', '53': 'CN-YN', '54': 'CN-XZ', '61': 'CN-SN', '62': 'CN-GS',
               '63': 'CN-QH', '64': 'CN-NX', '65': 'CN-XJ', '81': 'CN-HK', '82': 'CN-MO'}
CN_MUNI = {'110000', '120000', '310000', '500000'}


def datav(adcode, full=True):
    """DataV boundary file, coordinates converted GCJ-02 → WGS84 once and cached."""
    stem = f'{adcode}_full' if full else f'{adcode}'
    wgs = SRC / 'datav' / f'{stem}.wgs84.geojson'
    if wgs.exists():
        return read_json(wgs)
    raw = fetch(DATAV + stem + '.json', SRC / 'datav' / f'{stem}.json', min_bytes=200)
    d = read_json(raw)
    for f in d['features']:
        if f.get('geometry'):
            f['geometry'] = map_coords(f['geometry'], gcj2wgs)
    write_json(wgs, d)
    return d


def cn_name_en(zh):
    """Romanised name for a Chinese unit (GeoNames English names are applied on top where they match)."""
    base, suf = zh, ''
    for s, e in (('特别行政区', ''), ('自治州', ' Prefecture'), ('自治县', ' County'), ('自治旗', ' Banner'),
                 ('林区', ' Forestry District'), ('地区', ' Prefecture'), ('新区', ' New Area'), ('市', ''),
                 ('区', ' District'), ('县', ' County'), ('旗', ' Banner'), ('盟', ' League')):
        if zh.endswith(s) and len(zh) > len(s):
            base, suf = zh[:-len(s)], e
            break
    py = unidecode(base).strip().split()
    word = ''.join(py).capitalize() if py else base
    return (word + suf).strip()


def src_cn():
    top = datav(100000)
    out = []
    for f in top['features']:
        ad = str(f['properties'].get('adcode') or '')
        if not re.fullmatch(r'\d{6}', ad) or ad in ('710000', '810000', '820000'):
            continue
        a1 = CN_PROV_ISO[ad[:2]]
        if ad in CN_MUNI:
            nm = f['properties']['name']
            out.append({'type': 'Feature', 'geometry': f['geometry'],
                        'properties': {'code': ad, 'name': cn_name_en(nm), 'name_zh': nm, 'a1': a1}})
            continue
        for c in datav(ad)['features']:
            cp = c['properties']
            cad = str(cp.get('adcode') or '')
            if not c.get('geometry') or not re.fullmatch(r'\d{6}', cad):
                continue
            out.append({'type': 'Feature', 'geometry': c['geometry'],
                        'properties': {'code': cad, 'name': cn_name_en(cp['name']), 'name_zh': cp['name'], 'a1': a1}})
    return out, LICENSES['datav']


HK_EN = {'中西区': 'Central and Western', '湾仔区': 'Wan Chai', '东区': 'Eastern', '南区': 'Southern',
         '油尖旺区': 'Yau Tsim Mong', '深水埗区': 'Sham Shui Po', '九龙城区': 'Kowloon City', '黄大仙区': 'Wong Tai Sin',
         '观塘区': 'Kwun Tong', '荃湾区': 'Tsuen Wan', '屯门区': 'Tuen Mun', '元朗区': 'Yuen Long', '北区': 'North',
         '大埔区': 'Tai Po', '西贡区': 'Sai Kung', '沙田区': 'Sha Tin', '葵青区': 'Kwai Tsing', '离岛区': 'Islands'}
MO_EN = {'花地玛堂区': 'Nossa Senhora de Fátima', '花王堂区': 'Santo António', '望德堂区': 'São Lázaro',
         '大堂区': 'Sé', '风顺堂区': 'São Lourenço', '嘉模堂区': 'Nossa Senhora do Carmo (Taipa)',
         '路凼填海区': 'Cotai', '圣方济各堂区': 'São Francisco Xavier (Coloane)'}


def src_hkmo(cc):
    ad, en, a1 = ('810000', HK_EN, 'CN-HK') if cc == 'HK' else ('820000', MO_EN, 'CN-MO')
    out = []
    for c in datav(ad)['features']:
        cp = c['properties']
        if not c.get('geometry'):
            continue
        nm = cp['name']
        out.append({'type': 'Feature', 'geometry': c['geometry'],
                    'properties': {'code': str(cp['adcode']), 'name': en.get(nm, cn_name_en(nm)), 'name_zh': nm, 'a1': a1}})
    return out, LICENSES['datav']


# --- Taiwan (taiwan-atlas, MOI) ---
TW_ISO = {'63000': 'TW-TPE', '65000': 'TW-NWT', '68000': 'TW-TAO', '66000': 'TW-TXG', '67000': 'TW-TNN', '64000': 'TW-KHH',
          '10017': 'TW-KEE', '10018': 'TW-HSZ', '10020': 'TW-CYI', '10004': 'TW-HSQ', '10005': 'TW-MIA', '10007': 'TW-CHA',
          '10008': 'TW-NAN', '10009': 'TW-YUN', '10010': 'TW-CYQ', '10013': 'TW-PIF', '10002': 'TW-ILA', '10015': 'TW-HUA',
          '10014': 'TW-TTT', '10016': 'TW-PEN', '09020': 'TW-KIN', '09007': 'TW-LIE'}


def tw_geo(obj):
    gj = SRC / 'tw' / f'{obj}.geojson'
    if not gj.exists():
        src = fetch(TW_ATLAS.format(f=obj), SRC / 'tw' / f'{obj}-10t.json', min_bytes=1000)
        topo2geo(src, gj, obj)
    return read_json(gj)['features']


def src_tw():
    out = []
    for f in tw_geo('counties'):
        p = f['properties']
        code = p['COUNTYCODE']
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': code, 'name': p['COUNTYENG'], 'name_zh': zh_cn(p['COUNTYNAME']),
                                   'a1': TW_ISO.get(code)}})
    return out, LICENSES['tw']


# --- Japan (N03) ---
def jp_raw():
    feats = []
    for p in range(1, 48):
        path = fetch(JP_N03.format(p=p), SRC / 'jp' / f'N03-21_{p:02d}_210101.json', min_bytes=1000)
        feats += read_json(path)['features']
    # designated cities: city code = smallest ward code − 1
    wards = defaultdict(list)
    for f in feats:
        pr = f['properties']
        c3, c4, code = pr.get('N03_003') or '', pr.get('N03_004') or '', pr.get('N03_007')
        if code and c3.endswith('市') and c4.endswith('区') and pr.get('N03_001') != '東京都':
            wards[(pr['N03_001'], c3)].append(code)
    city = {k: f'{int(min(v)) - 1:05d}' for k, v in wards.items()}
    return feats, city


def src_jp():
    feats, city = jp_raw()
    out = []
    for f in feats:
        pr = f['properties']
        code = pr.get('N03_007')
        if not code or not f.get('geometry'):
            continue
        key = (pr['N03_001'], pr.get('N03_003') or '')
        if key in city and (pr.get('N03_004') or '').endswith('区'):
            code, nm = city[key], key[1]
        else:
            nm = pr.get('N03_004') or ''
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': code, 'name': nm, 'name_zh': zh_cn(nm), 'a1': f'JP-{code[:2]}', 'ja': nm}})
    return out, LICENSES['n03']


# --- Korea (행정동 → 시군구) ---
KR_SIDO_ISO = {'11': 'KR-11', '26': 'KR-26', '27': 'KR-27', '28': 'KR-28', '29': 'KR-29', '30': 'KR-30', '31': 'KR-31',
               '36': 'KR-50', '41': 'KR-41', '42': 'KR-42', '51': 'KR-42', '43': 'KR-43', '44': 'KR-44', '45': 'KR-45',
               '52': 'KR-45', '46': 'KR-46', '47': 'KR-47', '48': 'KR-48', '50': 'KR-49'}
KR_CITY_GU = re.compile(r'^(.+?시)(.+구)$')
KR_ZH_FIX = {'영도구': '影岛区', '세종특별자치시': '世宗市', '세종시': '世宗市', '아산시': '牙山市', '사천시': '泗川市',
             '서해구': '西海区', '제물포구': '济物浦区', '영종구': '永宗区', '검단구': '黔丹区', '군위군': '军威郡',
             # 일반구 (admin3): Hanja of the district names
             '장안구': '长安区', '권선구': '劝善区', '팔달구': '八达区', '영통구': '灵通区', '수정구': '寿井区', '중원구': '中院区',
             '분당구': '盆唐区', '만안구': '万安区', '동안구': '东安区', '원미구': '远美区', '소사구': '素砂区', '오정구': '梧亭区',
             '상록구': '常绿区', '단원구': '檀园区', '처인구': '处仁区', '기흥구': '器兴区', '수지구': '水枝区', '덕양구': '德阳区',
             '일산동구': '一山东区', '일산서구': '一山西区', '상당구': '上党区', '서원구': '西原区', '흥덕구': '兴德区',
             '청원구': '清原区', '동남구': '东南区', '서북구': '西北区', '의창구': '义昌区', '성산구': '城山区',
             '마산합포구': '马山合浦区', '마산회원구': '马山会原区', '진해구': '镇海区', '완산구': '完山区', '덕진구': '德津区',
             '만세구': '万岁区', '효행구': '孝行区', '병점구': '饼店区', '동탄구': '东滩区'}


def kr_raw():
    p = fetch(KR_ADM, SRC / 'kr' / 'HangJeongDong_ver20261001.geojson', min_bytes=1_000_000)
    return read_json(p)['features']


def kr_split(pr):
    """(admin2 code, admin2 name, admin3 code|None, admin3 name|None) of a 행정동."""
    sgg, nm = pr['sgg'], pr['sggnm']
    m = KR_CITY_GU.match(nm)
    if m and not pr['sidonm'].endswith(('특별시', '광역시')):
        return sgg[:4] + '0', m.group(1), sgg, m.group(2)
    return sgg, nm, None, None


def src_kr():
    out = []
    for f in kr_raw():
        pr = f['properties']
        code, nm, _, _ = kr_split(pr)
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': code, 'name': nm, 'name_zh': KR_ZH_FIX.get(nm, ''),
                                   'a1': KR_SIDO_ISO.get(pr['sido']), 'ko': nm}})
    return out, LICENSES['kr']


# --- Canada (StatCan census divisions) ---
CA_PR_ISO = {'10': 'CA-NL', '11': 'CA-PE', '12': 'CA-NS', '13': 'CA-NB', '24': 'CA-QC', '35': 'CA-ON', '46': 'CA-MB',
             '47': 'CA-SK', '48': 'CA-AB', '59': 'CA-BC', '60': 'CA-YT', '61': 'CA-NT', '62': 'CA-NU'}


def statcan_layer(layer, fields, where='1=1', name='cd', offset_deg=0.0003):
    gj = SRC / 'statcan' / f'{name}.geojson'
    if gj.exists():
        return read_json(gj)['features']
    feats, off = [], 0
    while True:
        q = urllib.parse.urlencode({'where': where, 'outFields': fields, 'outSR': '4326', 'f': 'geojson',
                                    'resultOffset': off, 'resultRecordCount': 50, 'maxAllowableOffset': offset_deg,
                                    'returnGeometry': 'true'})
        part = SRC / 'statcan' / f'{name}.{off}.json'
        fetch(STATCAN.format(layer=layer) + '?' + q, part, min_bytes=50)
        d = read_json(part)
        fs = d.get('features') or []
        feats += fs
        if len(fs) < 50:
            break
        off += 50
    write_json(gj, fc(feats))
    return feats


def src_ca():
    out = []
    for f in statcan_layer(4, 'CDUID,CDNAME,CDTYPE,PRUID'):
        p = f['properties']
        if not f.get('geometry'):
            continue
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': p['CDUID'], 'name': p['CDNAME'], 'name_zh': '',
                                   'a1': CA_PR_ISO.get(str(p['PRUID']))}})
    return out, LICENSES['statcan']


# --- Great Britain (ONS local authority districts) ---
ONS_LAD = ('https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/'
           'Local_Authority_Districts_December_2024_Boundaries_UK_BGC/FeatureServer/0/query')


def arcgis_layer(url, fields, name, page=100):
    gj = SRC / 'arcgis' / f'{name}.geojson'
    if gj.exists():
        return read_json(gj)['features']
    feats, off = [], 0
    while True:
        q = urllib.parse.urlencode({'where': '1=1', 'outFields': fields, 'outSR': '4326', 'f': 'geojson',
                                    'resultOffset': off, 'resultRecordCount': page, 'returnGeometry': 'true'})
        part = SRC / 'arcgis' / f'{name}.{off}.json'
        fetch(url + '?' + q, part, min_bytes=50)
        fs = read_json(part).get('features') or []
        feats += fs
        if len(fs) < page:
            break
        off += page
    write_json(gj, fc(feats))
    return feats


def src_gb():
    out = []
    for f in arcgis_layer(ONS_LAD, 'LAD24CD,LAD24NM', 'ons_lad_2024_bgc'):
        p = f['properties']
        if f.get('geometry'):
            out.append({'type': 'Feature', 'geometry': f['geometry'],
                        'properties': {'code': p['LAD24CD'], 'name': p['LAD24NM'], 'name_zh': ''}})
    return out, ('ONS Local Authority Districts (December 2024), UK, BGC (generalised 20 m, clipped to the coastline)',
                 'Open Government Licence v3.0 (contains OS data © Crown copyright and database right 2024)')


# --- Brazil (IBGE microregions; municipalities as admin3) ---
IBGE_MICRO = ('https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_municipais/'
              'municipio_2022/Brasil/BR/BR_Microrregioes_2022.zip')


def src_br():
    gj = SRC / 'ibge' / 'BR_Microrregioes_2022.geojson'
    if not gj.exists():
        zp = fetch(IBGE_MICRO, SRC / 'ibge' / 'BR_Microrregioes_2022.zip', timeout=1800, min_bytes=1_000_000)
        files = unzip_member(zp, ['.shp', '.shx', '.dbf', '.prj', '.cpg'], SRC / 'ibge' / 'micro')
        shp = [f for f in files if f.suffix == '.shp'][0]
        ms('-i', shp, 'encoding=utf8', '-proj', 'wgs84', '-simplify', 'interval=20', 'keep-shapes',
           '-o', 'format=geojson', gj)
    out = []
    for f in read_json(gj)['features']:
        p = f['properties']
        code = str(p.get('CD_MICRO') or p.get('CD_MICRORR') or '')
        if not f.get('geometry') or not code:
            continue
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': code, 'name': p.get('NM_MICRO') or p.get('NM_MICRORR') or code,
                                   'name_zh': '', 'a1': f"BR-{p['SIGLA_UF']}" if p.get('SIGLA_UF') else None}})
    return out, ('IBGE Malha de Microrregiões 2022', 'IBGE open data (free use with attribution: Fonte: IBGE)')


# --- Europe (GISCO NUTS3) ---
NUTS_CC = {'GR': 'EL', 'GB': 'UK'}


def src_nuts(cc):
    p = fetch(GISCO_NUTS3, SRC / 'gisco' / 'NUTS_RG_01M_2021_4326_LEVL_3.geojson', min_bytes=1_000_000)
    want = NUTS_CC.get(cc, cc)
    out = []
    for f in read_json(p)['features']:
        pr = f['properties']
        if pr['CNTR_CODE'] != want:
            continue
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'code': pr['NUTS_ID'], 'name': pr['NAME_LATN'], 'name_zh': ''}})
    return out, LICENSES['nuts']


# ── the plan: which source per country (priority order = build order) ────────────────────────────────────────
# kind: census | cn | hkmo | tw | jp | kr | ca | nuts | gb:<ADMn>
PLAN = [
    ('US', 'census', '县', 'county (Census 2023; Connecticut = its 9 planning regions)'),
    ('CN', 'cn', '地级市', '地级市 / 地区 / 自治州 / 盟 + 省直辖县级单位; 北京 上海 天津 重庆 = one unit each (区县 in admin3); Taiwan, Hong Kong, Macau excluded (own files)'),
    ('JP', 'jp', '市区町村', '市町村 + Tokyo special wards; 政令指定都市 merged (their wards are admin3)'),
    ('TW', 'tw', '县市', '22 縣市 (incl. 連江); 鄉鎮市區 are admin3'),
    ('HK', 'hkmo', '区', '18 districts'),
    ('MO', 'hkmo', '堂区', '7 parishes + Cotai'),
    ('KR', 'kr', '市郡区', '시·군·구 (일반구 merged into their 시; they are admin3)'),
    ('IN', 'gb:ADM2', '县', 'districts'),
    ('GB', 'ons', '地方政府区', '361 local authority districts (London: 32 boroughs + City of London; Scotland: council areas; NI: districts)'),
    ('DE', 'nuts', '县（Kreis）', 'NUTS3 = Kreise / kreisfreie Städte'),
    ('FR', 'nuts', '省（département）', 'NUTS3 = départements (incl. overseas)'),
    ('CA', 'ca', '人口普查区', 'census divisions'),
    ('AU', 'gb:ADM2', '地方政府区', 'local government areas'),
    ('CH', 'gb:ADM2', '区（Bezirk）', 'districts'),
    ('NL', 'gb:ADM2', '市镇（gemeente）', 'municipalities'),
    ('SE', 'gb:ADM2', '市镇（kommun）', 'municipalities'),
    ('BR', 'ibge', '微区（microrregião）', 'IBGE microregions (municipalities are admin3)'),
    ('SG', 'gb:ADM2', '规划区', 'URA planning areas'),
    ('IE', 'nuts', '地区（NUTS3）', 'NUTS3 regions (Dublin = one region)'),
    ('IL', 'gb:ADM2', '分区', 'sub-districts'),
    ('UY', 'gb:ADM2', '市镇', 'municipalities'),
    ('FI', 'gb:ADM3', '市镇（kunta）', 'municipalities'),
    ('DK', 'gb:ADM2', '市镇（kommune）', 'municipalities'),
    ('ES', 'nuts', '省', 'NUTS3 = provinces / islands'),
    ('IT', 'nuts', '省', 'NUTS3 = provinces'),
    ('NO', 'gb:ADM2', '市镇（kommune）', 'municipalities (2013 borders)'),
    ('PL', 'gb:ADM2', '县（powiat）', 'powiats'),
    ('BE', 'nuts', '专区（arrondissement）', 'NUTS3 = arrondissements'),
    ('PR', 'census', '市（municipio）', 'municipios (Census 2023)'),
    ('MX', 'gb:ADM2', '市（municipio）', 'municipios'),
    ('AT', 'gb:ADM2', '县（Bezirk）', 'districts'),
    ('LU', 'gb:ADM2', '市镇', 'communes'),
    ('PT', 'nuts', '次区域（NUTS3）', 'NUTS3'),
    ('GR', 'nuts', '地区（NUTS3）', 'NUTS3'),
    ('CZ', 'nuts', '州（NUTS3）', 'NUTS3 = kraje (no finer open level wired yet)'),
    ('HU', 'nuts', '州（NUTS3）', 'NUTS3 = counties'),
    ('RO', 'nuts', '县（NUTS3）', 'NUTS3 = județe'),
] + [(cc, 'gb:ADM2', '二级行政区', 'second-level units (geoBoundaries)') for cc in [
    'ZA', 'CL', 'PE', 'ID', 'RU', 'SA', 'TR', 'KZ', 'CO', 'AR', 'VN', 'GH', 'MY', 'TH', 'PH', 'EG', 'UZ', 'CD', 'EC',
    'PG', 'ET', 'PY', 'BT', 'AE', 'QA', 'PA', 'SN', 'BF', 'BO', 'ZW', 'DO', 'TZ', 'GN', 'BW', 'ZM', 'JO', 'NA', 'NE',
    'MG', 'CI', 'UA', 'NZ']]
PLAN_BY = {p[0]: p for p in PLAN}
# countries that are only on the map through anchors (mines, fields, capitals): smaller files keep the total ≤ 40 MB
ANCHOR_ONLY = {p[0] for p in PLAN if p[2] == '二级行政区'}
ANCHOR_CAP_KB = 400
NAME_FIX = {'CH-pays-denhaut': "Riviera-Pays-d'Enhaut"}  # geoBoundaries calls the Vaud district only Pays-d'Enhaut
ANCHOR_CAP_OVERRIDE = {'RU': 1500}  # ~2,300 raions + the Arctic coast cannot fit 400 KB


def source_for(cc):
    kind = PLAN_BY[cc][1]
    if kind == 'census':
        return src_us(territory=(cc == 'PR'))
    if kind == 'cn':
        return src_cn()
    if kind == 'hkmo':
        return src_hkmo(cc)
    if kind == 'tw':
        return src_tw()
    if kind == 'jp':
        return src_jp()
    if kind == 'kr':
        return src_kr()
    if kind == 'ca':
        return src_ca()
    if kind == 'ons':
        return src_gb()
    if kind == 'ibge':
        return src_br()
    if kind == 'nuts':
        return src_nuts(cc)
    if kind.startswith('gb:'):
        return src_geoboundaries(cc, kind[3:])
    raise SystemExit(f'unknown source kind {kind}')


# ── admin1 parent of each unit ────────────────────────────────────────────────────────────────────────────────
def admin1_source(cc):
    """GeoJSON path whose features carry `a1`: the app's admin1 file, else geoBoundaries ADM1 (shapeISO)."""
    p = WORK / '_a1' / f'{cc}.geojson'
    if p.exists():
        return p, read_json(p).get('src')
    p.parent.mkdir(parents=True, exist_ok=True)
    if (ADMIN1 / f'{cc}.json').exists():
        tmp = WORK / '_a1' / f'{cc}.raw.geojson'
        topo2geo(ADMIN1 / f'{cc}.json', tmp, 'admin1')
        feats = [{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'a1': f['properties']['fid']}}
                 for f in read_json(tmp)['features']]
        d = dict(fc(feats), src='admin1')
    else:
        feats, _ = src_geoboundaries(cc, 'ADM1') if ISO2_3.get(cc) in gb_meta('ADM1') else (None, None)
        if not feats:
            return None, None
        out = []
        for f in feats:
            iso = f['properties'].get('iso') or ''
            if not re.fullmatch(r'[A-Z]{2}-[A-Z0-9]{1,3}', iso) or not iso.startswith(cc + '-'):
                iso = A1_BY_NAME.get(cc, {}).get(f['properties']['name'])
            out.append({'type': 'Feature', 'geometry': f['geometry'], 'properties': {'a1': iso,
                                                                                      'a1name': f['properties']['name']}})
        d = dict(fc(out), src='geoBoundaries ADM1 shapeISO')
    write_json(p, d)
    return p, d['src']


# geoBoundaries ADM1 units without shapeISO → the best ISO 3166-2 code. Singapore's URA regions are not its ISO
# subdivisions (the 5 CDC districts); each region gets the CDC district that covers most of it (approximate).
A1_BY_NAME = {
    'SG': {'CENTRAL REGION': 'SG-01', 'NORTH-EAST REGION': 'SG-02', 'NORTH REGION': 'SG-03', 'EAST REGION': 'SG-04',
           'WEST REGION': 'SG-05'},
    'BE': {'Brussels Hoofdstedelijk': 'BE-BRU', 'Vlaams Gewest': 'BE-VLG', 'Wallonne Gewest': 'BE-WAL'},
}


NE_A1_ZIP = 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip'


def ne_admin1(cc):
    """Natural Earth 1:10m admin-1 units of a country with their ISO 3166-2 code (fallback a1 source)."""
    gj = SRC / 'ne' / 'ne_10m_admin_1_states_provinces.geojson'
    if not gj.exists():
        zp = fetch(NE_A1_ZIP, SRC / 'ne' / 'ne_10m_admin_1_states_provinces.zip', min_bytes=1_000_000)
        files = unzip_member(zp, ['.shp', '.shx', '.dbf', '.prj', '.cpg'], SRC / 'ne' / 'shp')
        shp = [f for f in files if f.suffix == '.shp'][0]
        ms('-i', shp, 'encoding=utf8', '-filter-fields', 'iso_3166_2,iso_a2,adm0_a3,name', '-o', 'format=geojson', gj)
    if '_ne' not in _GN:
        _GN['_ne'] = read_json(gj)['features']
    out = []
    for f in _GN['_ne']:
        p = f['properties']
        iso = (p.get('iso_3166_2') or '').strip()
        if p.get('iso_a2') == cc and f.get('geometry') and re.fullmatch(r'[A-Z]{2}-[A-Z0-9]{1,3}', iso):
            out.append({'type': 'Feature', 'geometry': f['geometry'], 'properties': {'a1': iso}})
    return out


def a1_pass(ccs=None):
    """Fill a1 = null in the finished admin2 files (countries without an app admin1 file) from Natural Earth admin-1
    ISO 3166-2 codes by largest overlap; admin3 units copy their parent's a1."""
    n_all = 0
    for cc, *_ in PLAN:
        path = OUT2 / f'{cc}.json'
        if ccs and cc not in ccs or not path.exists():
            continue
        topo = read_json(path)
        need = [g for g in topo['objects'][OBJECT]['geometries'] if not g['properties'].get('a1')]
        if not need:
            continue
        ne = ne_admin1(cc)
        if not ne:
            log(f'  a1 {cc}: Natural Earth has no ISO codes either ({len(need)} units stay null)')
            continue
        wd = WORK / cc / 'a1fix'
        wd.mkdir(parents=True, exist_ok=True)
        ids = {g['id'] for g in need}
        feats = [{'type': 'Feature', 'properties': {'id': uid},
                  'geometry': {'type': 'Polygon', 'coordinates': [r.tolist() for r in rings]}}
                 for uid, p, rings, bb in Shapes(topo).items if uid in ids]
        u, a, o = wd / 'units.geojson', wd / 'ne.geojson', wd / 'out.geojson'
        write_json(u, fc(feats))
        write_json(a, fc(ne))
        ms('-i', u, a, 'combine-files', '-rename-layers', 'units,a1src', '-join', 'target=units', 'source=a1src',
           'largest-overlap', 'fields=a1', '-o', 'target=units', 'format=geojson', o)
        got = {f['properties']['id']: f['properties'].get('a1') for f in read_json(o)['features']}
        n = 0
        for g in topo['objects'][OBJECT]['geometries']:
            if g['id'] in got and got[g['id']]:
                g['properties']['a1'] = got[g['id']]
                n += 1
        write_json(path, topo)
        n_all += n
        log(f'  a1 {cc}: {n}/{len(need)} filled from Natural Earth admin-1')
        for f in OUT3.glob(f'{cc}-*.json'):
            t3 = read_json(f)
            par = {g['id']: g['properties'].get('a1') for g in topo['objects'][OBJECT]['geometries']}
            for g in t3['objects'][OBJECT]['geometries']:
                g['properties']['a1'] = par.get(g['properties']['a2'], g['properties'].get('a1'))
            write_json(f, t3)
    write_index(2)
    return n_all


def join_a1(cc, feats, wd):
    """Fill properties.a1 where missing, by largest overlap with the admin1 polygons (nearest as a fallback)."""
    need = [f for f in feats if not f['properties'].get('a1')]
    if not need:
        return 'source'
    a1p, how = admin1_source(cc)
    if not a1p:
        return None
    u, o = wd / 'a1in.geojson', wd / 'a1out.geojson'
    write_json(u, fc([{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'id': f['properties']['id']}}
                      for f in need]))
    ms('-i', u, a1p, 'combine-files', '-rename-layers', 'units,a1src', '-join', 'target=units', 'source=a1src',
       'largest-overlap', 'fields=a1', '-o', 'target=units', 'format=geojson', o)
    got = {f['properties']['id']: f['properties'].get('a1') for f in read_json(o)['features']}
    a1f = read_json(a1p)['features']
    for f in need:
        a1 = got.get(f['properties']['id'])
        if not a1:  # nearest admin1 polygon to an inner point
            pt = np.asarray(gj_polys(f['geometry'])[0][0], dtype=float).mean(axis=0)
            best = None
            for g in a1f:
                if not g['properties'].get('a1'):
                    continue
                for poly in gj_polys(g['geometry']):
                    d = seg_dist_km(np.asarray(poly[0], dtype=float), pt[0], pt[1])
                    if best is None or d < best[0]:
                        best = (d, g['properties']['a1'])
            a1 = best[1] if best and best[0] < 200 else None
        f['properties']['a1'] = a1
    return how


# ── HQ points (used for Chinese names, admin3 selection, units.json) ──────────────────────────────────────────
_HQ = {}


def hq_data():
    if 'hq' in _HQ:
        return _HQ['hq']
    h = read_json(HQ_JSON)
    dv = defaultdict(dict)  # ticker -> {tree: dv20}

    def leaves(n):
        ch = n.get('children') or []
        if not ch:
            yield n
            return
        for c in ch:
            yield from leaves(c)
    for tree, path in (('curated', 'tree.json'), ('full', 'fm/tree.json'), ('global', 'gl/tree.json')):
        p = ROOT / 'web' / 'data' / path
        if not p.exists():
            continue
        for lf in leaves(read_json(p)):
            t = lf.get('ticker')
            if t and t not in dv or (t and tree not in dv[t]):
                dv[t][tree] = float((lf.get('now') or {}).get('dv20') or 0)
    pts = []
    for t, v in h['hq'].items():
        kind = v[5] if len(v) > 5 else 'hq'
        pts.append({'t': t, 'lon': v[0], 'lat': v[1], 'city': v[2], 'cc': v[3], 'est': v[4], 'kind': kind or 'hq',
                    'dv': dv.get(t, {})})
    _HQ['hq'] = (h, pts)
    return _HQ['hq']


def placed(p):
    return p['lon'] is not None and p['kind'] not in ('country', 'region', 'nongeo')


def units_with_points(cc, feats):
    """Ids of the units that hold at least one HQ / anchor point (bbox test is enough for a name lookup filter)."""
    pts = dense_points()
    ids = set()
    for f in feats:
        rings = [np.asarray(r, dtype=float) for poly in gj_polys(f['geometry']) for r in poly]
        allp = np.concatenate(rings)
        x0, y0, x1, y1 = allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max()
        for x, y in pts:
            if x0 <= x <= x1 and y0 <= y <= y1 and Shapes._inside(rings, x, y):
                ids.add(f['properties']['id'])
                break
    return ids


def dense_points():
    """HQ + anchor points, for adaptive simplification."""
    if 'dense' not in _HQ:
        _, pts = hq_data()
        xy = [(p['lon'], p['lat']) for p in pts if placed(p)]
        a = read_json(ANCHORS_JSON)
        for d in (a['anchors'], a['nodes']):
            for v in d.values():
                xy += [(x['lon'], x['lat']) for x in v if x.get('lon') is not None]
        _HQ['dense'] = xy
    return _HQ['dense']


def zh_from_hq(cc, feats, shapes_topo):
    """name_zh for units that hold an HQ city of the same name (hq.json zh table: 'Cupertino|US' → 库比蒂诺)."""
    h, pts = hq_data()
    zh = h.get('zh') or {}
    by_name = defaultdict(set)
    for p in pts:
        if p['cc'] == cc and placed(p) and p['city']:
            z = zh.get(f"{p['city']}|{cc}")
            if z:
                by_name[norm(p['city'])].add((z, p['lon'], p['lat']))
    if not by_name:
        return 0
    sh = Shapes(shapes_topo)
    where = {uid: (rings, bb) for uid, _, rings, bb in sh.items}
    n = 0
    for f in feats:
        pr = f['properties']
        if pr.get('name_zh'):
            continue
        nm = norm(pr['name'])
        base = re.sub(r'\b(county|city|town|borough|parish|district|municipality|city and borough|census area|'
                      r'planning region|region|shi|ku|gun|si|kreis|landkreis|stadt)\b', '', nm).strip()
        for key in (nm, base):
            for z, lon, lat in by_name.get(key, ()):
                rb = where.get(pr['id'])
                if rb and rb[1][0] <= lon <= rb[1][2] and rb[1][1] <= lat <= rb[1][3] and Shapes._inside(rb[0], lon, lat):
                    suf = ''
                    if re.search(r'\bcounty\b', nm):
                        suf = '县'
                    elif re.search(r'\bborough\b', nm) and cc == 'GB':
                        suf = '区'
                    pr['name_zh'] = z + suf
                    n += 1
                    break
            if pr.get('name_zh'):
                break
    return n


# ── validation (node: vendored topojson-client + d3) ─────────────────────────────────────────────────────────
NODE_CHECK = r"""
const fs = require('fs'), vm = require('vm'), path = require('path');
const [vendor, ...files] = process.argv.slice(1);
const ctx = { self: {}, console }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['geo/topojson-client.min.js', 'd3.min.js']) vm.runInContext(fs.readFileSync(path.join(vendor, f), 'utf8'), ctx);
const { topojson, d3 } = ctx; const out = {};
for (const f of files) {
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  const o = t.objects.units;
  if (!o) { out[f] = { error: 'no object units' }; continue; }
  const fc = topojson.feature(t, o);
  const mesh = topojson.mesh(t, o, (a, b) => a !== b);
  let open = 0, badLL = 0, inverted = [], zero = [], sum = 0;
  for (const ft of fc.features) {
    const polys = ft.geometry ? (ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates) : [];
    if (!polys.length) zero.push(ft.id);
    for (const p of polys) for (const r of p) {
      const a = r[0], b = r[r.length - 1];
      if (r.length < 4 || a[0] !== b[0] || a[1] !== b[1]) open++;
      for (const [x, y] of r) if (!(x >= -180 && x <= 180 && y >= -90 && y <= 90)) badLL++;
    }
    const ar = ft.geometry ? d3.geoArea(ft) : 0;
    if (ar > 2 * Math.PI) inverted.push(ft.id); else sum += ar;
    if (!(ar > 0)) zero.push(ft.id);
  }
  const merged = topojson.merge(t, o.geometries);
  const mArea = d3.geoArea(merged);
  out[f] = { n: fc.features.length, open, badLL, inverted: inverted.slice(0, 5), nInverted: inverted.length,
             zero: zero.slice(0, 5), nZero: zero.length, meshLines: mesh.coordinates ? mesh.coordinates.length : 0,
             km2: Math.round(sum * 6371 * 6371), mergedKm2: Math.round(mArea * 6371 * 6371) };
}
process.stdout.write(JSON.stringify(out));
"""


def validate(files, cap_kb, level):
    errs = []
    if not files:
        return errs, {}
    r = subprocess.run(['node', '-e', NODE_CHECK, str(VENDOR), *map(str, files)], capture_output=True, text=True)
    if r.returncode:
        return [f'node check failed: {r.stderr[-1500:]}'], {}
    res = json.loads(r.stdout)
    for f in files:
        f = Path(f)
        x = res[str(f)]
        t = read_json(f)
        geoms = t['objects'][OBJECT]['geometries']
        ids = [g['id'] for g in geoms]
        tag = f'admin{level}/{f.name}'
        if x.get('error'):
            errs.append(f'{tag}: {x["error"]}')
            continue
        if len(set(ids)) != len(ids):
            errs.append(f'{tag}: duplicate ids')
        for g in geoms:
            p = g.get('properties') or {}
            if p.get('id') != g['id'] or p.get('level') != level or 'name_zh' not in p or not p.get('name'):
                errs.append(f'{tag}/{g["id"]}: bad properties {p}')
                break
            if level == 3 and not p.get('a2'):
                errs.append(f'{tag}/{g["id"]}: no a2')
                break
            if g['type'] not in ('Polygon', 'MultiPolygon'):
                errs.append(f'{tag}/{g["id"]}: geometry {g["type"]}')
        if x['open'] or x['badLL'] or x['nInverted'] or x['nZero']:
            errs.append(f'{tag}: open {x["open"]}, bad lon/lat {x["badLL"]}, inverted {x["nInverted"]} {x["inverted"]}, '
                        f'zero {x["nZero"]} {x["zero"]}')
        if x['km2'] and abs(x['mergedKm2'] - x['km2']) > 0.02 * x['km2'] + 50:
            errs.append(f'{tag}: merged area {x["mergedKm2"]} km² vs sum {x["km2"]} km² (overlaps/holes?)')
        kb = f.stat().st_size / 1000
        if kb > cap_kb * 1.001:
            errs.append(f'{tag}: {kb:.0f} KB > {cap_kb} KB')
    return errs, res


# ── admin2 build ─────────────────────────────────────────────────────────────────────────────────────────────
PRESIMPLIFY = {'census': 15, 'cn': 20, 'kr': 15, 'nuts': 20, 'jp': None, 'tw': None, 'hkmo': None, 'ca': None}


def units_topo(feats, wd, name='units'):
    """GeoJSON features (properties final) → mapshaper TopoJSON without quantization (shared arcs)."""
    g, o = wd / f'{name}.final.geojson', wd / f'{name}.raw.topo.json'
    write_json(g, fc(feats))
    ms('-i', g, 'snap', '-rename-layers', OBJECT, '-o', 'format=topojson', 'no-quantization', 'id-field=id', o)
    return read_json(o)


def props_basic(level):
    keys = ['id', 'name', 'name_zh', 'a1', 'level'] + (['a2'] if level == 3 else [])

    def f(g):
        p = g.get('properties') or {}
        return {k: p.get(k) if k != 'level' else level for k in keys}
    return f


def build_admin2(cc, cap_kb=CAP2_KB):
    t0 = time.time()
    _, kind, unit_zh, note = PLAN_BY[cc]
    feats, srcinfo = source_for(cc)
    if not feats:
        log(f'{cc}: no source — skipped')
        return None
    src_name, lic = srcinfo
    wd = WORK / cc / 'a2'
    info = {}
    sf = []
    for f in feats:
        p = f['properties']
        code = str(p['code'])
        if code not in info:
            info[code] = {k: v for k, v in p.items() if k != 'code'}
        sf.append({'type': 'Feature', 'geometry': f['geometry'], 'properties': {'code': code}})
    frame = [{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'fr': 1}}
             for f in read_json(frame_path(cc))['features']]
    res, stats = fit_units(cc, sf, frame, wd, presimplify=PRESIMPLIFY.get(kind.split(':')[0], 20 if kind == 'nuts' else None))
    out = []
    for code, geom in res.items():
        p = dict(info.get(code, {}))
        p['name'] = NAME_FIX.get(f'{cc}-{code}', p.get('name'))
        out.append({'type': 'Feature', 'geometry': geom,
                    'properties': {'id': f'{cc}-{code}', 'name': p.get('name') or code, 'name_zh': p.get('name_zh') or '',
                                   'a1': p.get('a1'), 'level': 2, 'ja': p.get('ja'), 'ko': p.get('ko')}})
    a1how = join_a1(cc, out, wd)
    if any(not f['properties'].get('a1') for f in out) and not (ADMIN1 / f'{cc}.json').exists():
        ne = ne_admin1(cc)
        if ne:
            p_ne = wd / 'ne_a1.geojson'
            write_json(p_ne, fc(ne))
            need = [f for f in out if not f['properties'].get('a1')]
            u, o = wd / 'a1ne_in.geojson', wd / 'a1ne_out.geojson'
            write_json(u, fc([{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'id': f['properties']['id']}}
                              for f in need]))
            ms('-i', u, p_ne, 'combine-files', '-rename-layers', 'units,a1src', '-join', 'target=units',
               'source=a1src', 'largest-overlap', 'fields=a1', '-o', 'target=units', 'format=geojson', o)
            got = {f['properties']['id']: f['properties'].get('a1') for f in read_json(o)['features']}
            for f in need:
                f['properties']['a1'] = got.get(f['properties']['id'])
            a1how = f'{a1how} + Natural Earth admin-1'
    raw = units_topo(out, wd)
    n_zh = zh_from_hq(cc, out, raw) if cc not in ('CN', 'HK', 'MO', 'TW', 'JP') else 0
    if n_zh:
        raw = units_topo(out, wd)
    names = enrich_names(cc, out)
    if cc not in ('CN', 'HK', 'MO', 'TW', 'JP'):
        only = None if cc == 'KR' else units_with_points(cc, out)
        names += wikidata_zh(cc, out, only)
    if names:
        raw = units_topo(out, wd)
    to = TopoOut(raw, OBJECT, dense=dense_points())
    meta = {'key': cc, 'source': src_name, 'license': lic, 'level': 2, 'built': time.strftime('%Y-%m-%d'),
            'frame': f'web/vendor/geo/countries-10m.json id {ISO_NUM[cc]}', 'fit': stats}
    if cc in ANCHOR_ONLY:
        cap_kb = min(cap_kb, ANCHOR_CAP_OVERRIDE.get(cc, ANCHOR_CAP_KB))
    tol, topo, size = fit_to_cap(to, props_basic(2), meta, cap_kb)
    write_json(OUT2 / f'{cc}.json', topo)
    zh = sum(1 for g in topo['objects'][OBJECT]['geometries'] if g['properties'].get('name_zh'))
    nu = len(topo['objects'][OBJECT]['geometries'])
    no_a1 = [g['id'] for g in topo['objects'][OBJECT]['geometries'] if not g['properties'].get('a1')]
    log(f'{cc}: {nu} units, {size / 1000:.0f} KB, borders simplified at {tol} m, name_zh {zh}/{nu}, '
        f'a1 via {a1how}{" (missing " + str(len(no_a1)) + ")" if no_a1 else ""}, {time.time() - t0:.0f} s')
    write_index(2)
    return {'cc': cc, 'units': nu, 'bytes': size, 'tol': tol, 'zh': zh, 'a1': a1how, 'noA1': no_a1[:20]}


def enrich_names(cc, feats):
    """Hook for GeoNames English / Chinese names (CN, JP, KR); see geonames_names()."""
    try:
        return geonames_names(cc, feats)
    except NameError:
        return 0


def write_index(level):
    out_dir = OUT2 if level == 2 else OUT3
    idx = {}
    if level == 2:
        for cc, kind, unit_zh, note in PLAN:
            f = out_dir / f'{cc}.json'
            if not f.exists():
                continue
            t = read_json(f)
            m = t.get('meta') or {}
            geoms = t['objects'][OBJECT]['geometries']
            idx[cc] = {'file': f.name, 'object': OBJECT, 'level': 2, 'unit_zh': unit_zh, 'units': len(geoms),
                       'bytes': f.stat().st_size, 'bbox': t['bbox'], 'source': m.get('source'), 'license': m.get('license'),
                       'simplify_m': m.get('simplify_m'), 'built': m.get('built'), 'note': note,
                       'name_zh': round(sum(1 for g in geoms if g['properties'].get('name_zh')) / max(1, len(geoms)), 3)}
            if m.get('coast_simplify_m'):
                idx[cc]['coast_simplify_m'] = m['coast_simplify_m']
    else:
        for f in sorted(out_dir.glob('*.json')):
            if f.name == 'index.json' or f.name.endswith('.tmp'):
                continue
            t = read_json(f)
            m = t.get('meta') or {}
            geoms = t['objects'][OBJECT]['geometries']
            idx[f.stem] = {'file': f.name, 'cc': m.get('cc'), 'object': OBJECT, 'level': 3, 'unit_zh': m.get('unit_zh'),
                           'units': len(geoms), 'bytes': f.stat().st_size, 'bbox': t['bbox'],
                           'a2': sorted({g['properties']['a2'] for g in geoms}), 'source': m.get('source'),
                           'license': m.get('license'), 'simplify_m': m.get('simplify_m'), 'built': m.get('built'),
                           'name_zh': round(sum(1 for g in geoms if g['properties'].get('name_zh')) / max(1, len(geoms)), 3)}
    write_json(out_dir / 'index.json', idx)
    return idx


# ── GeoNames names (English for JP / KR / CN units, Chinese for KR) ──────────────────────────────────────────
GN_DIR = GEO / 'geonames.nosync'
GN_NATIVE = {'JP': ('ja', 'ja'), 'KR': ('ko', 'ko'), 'CN': ('zh', 'name_zh')}  # language, feature prop with native name
_GN = {}


def gn_country(cc):
    """GeoNames admin features of a country: {geonameid: (asciiname, lon, lat, fcode)} + alternate names."""
    if cc in _GN:
        return _GN[cc]
    zp = fetch(GEONAMES + f'{cc}.zip', GN_DIR / f'{cc}.zip', min_bytes=10000)
    ap = fetch(GEONAMES + f'alternatenames/{cc}.zip', GN_DIR / f'alt_{cc}.zip', min_bytes=10000)
    feats = {}
    with zipfile.ZipFile(zp) as z:
        with z.open(f'{cc}.txt') as fh:
            for line in io.TextIOWrapper(fh, encoding='utf-8'):
                c = line.rstrip('\n').split('\t')
                if len(c) < 15:
                    continue
                if c[6] == 'A' and c[7].startswith('ADM') or c[6] == 'P' and c[7] in ('PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC'):
                    feats[c[0]] = (c[2], float(c[5]), float(c[4]), c[7])
    alt = defaultdict(list)  # geonameid -> [(lang, name, preferred)]
    with zipfile.ZipFile(ap) as z:
        with z.open(f'{cc}.txt') as fh:
            for line in io.TextIOWrapper(fh, encoding='utf-8'):
                c = line.rstrip('\n').split('\t')
                if len(c) < 4 or c[1] not in feats:
                    continue
                if c[2] in ('ja', 'ko', 'zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant', 'en') and not (len(c) > 7 and c[7] == '1'):
                    alt[c[1]].append((c[2], c[3], len(c) > 4 and c[4] == '1'))
    _GN[cc] = (feats, alt)
    return _GN[cc]


def kr_roman(name):
    """'영통구' → 'Yeongtong-gu' (unidecode Revised-Romanisation-like spelling) when GeoNames has no English name."""
    r = unidecode(name).replace(' ', '').lower()
    m = re.match(r'^(.+?)(gu|gun|si)$', r)
    return (m.group(1).capitalize() + '-' + m.group(2)) if m else r.capitalize()


def geonames_names(cc, feats):
    """Fill `name` (English, from GeoNames) and, for KR, `name_zh`, for units whose native name matches a GeoNames
    admin feature (or seat city) lying inside the unit. Returns how many units changed."""
    if cc not in GN_NATIVE:
        return 0
    lang, prop = GN_NATIVE[cc]
    gfe, alt = gn_country(cc)
    by_native = defaultdict(list)
    for gid, names in alt.items():
        for lg, nm, pref in names:
            if lg == lang:
                by_native[nm].append(gid)
    changed = 0
    for f in feats:
        pr = f['properties']
        native = pr.get(prop) or ''
        if cc == 'JP':
            native = pr.get('ja') or native
        if cc == 'KR':
            native = pr.get('ko') or native
        if not native:
            continue
        cands = list(by_native.get(native, []))
        if cc == 'CN' and not cands:  # 'Shenzhen Shi' carries '深圳市'; some only '深圳'
            for suf in ('市', '区', '县', '地区'):
                if native.endswith(suf):
                    cands = list(by_native.get(native[:-len(suf)], []))
                    if cands:
                        break
        if not cands:
            continue
        rings = [np.asarray(r, dtype=float) for poly in gj_polys(f['geometry']) for r in poly]
        allp = np.concatenate(rings)
        bb = (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())
        best = None
        for gid in cands:
            asc, lon, lat, fcode = gfe[gid]
            if fcode in ('ADM4', 'ADM5', 'ADM4H', 'ADM5H'):
                continue  # 동 / 町丁 level features share names with districts
            if not (bb[0] - 0.05 <= lon <= bb[2] + 0.05 and bb[1] - 0.05 <= lat <= bb[3] + 0.05):
                continue
            inside = Shapes._inside(rings, lon, lat)
            score = (0 if inside else 1, 0 if fcode.startswith('ADM') else 1)
            if best is None or score < best[0]:
                best = (score, gid)
        if not best or best[0][0] == 1 and len(cands) > 1:
            continue
        gid = best[1]
        asc = gfe[gid][0]
        en = [nm for lg, nm, pref in alt.get(gid, []) if lg == 'en']
        name = asc if asc and not KANA_RE.search(asc) else (en[0] if en else None)
        if name and cc == 'KR' and re.search(r'-?dong$', name) and not native.endswith('동'):
            name = None  # a 동 that shares the district's name (오정구 → Ojeong-dong)
        if name:
            if cc == 'JP':  # 'Minato-ku' / 'Toyota Shi' → 'Minato-ku' / 'Toyota-shi'
                name = re.sub(r'\s+(Shi|Ku|Machi|Mura|Cho|Son)$', lambda m: '-' + m.group(1).lower(), name)
            pr['name'] = name
            changed += 1
        if cc == 'KR' and not pr.get('name_zh'):
            zhs = [(lg, nm) for lg, nm, pref in alt.get(gid, []) if lg.startswith('zh')]
            zhs.sort(key=lambda x: (x[0] not in ('zh', 'zh-CN', 'zh-Hans'), len(x[1])))
            for lg, nm in zhs:
                z = zh_cn(nm)
                if z and not re.search(r'[가-힯]', z):
                    pr['name_zh'] = z
                    break
    if cc == 'KR':  # hangul left over → romanised
        for f in feats:
            pr = f['properties']
            if re.search(r'[\uac00-\ud7af]', pr.get('name') or ''):
                pr['ko'] = pr.get('ko') or pr['name']
                pr['name'] = kr_roman(pr['name'])
                changed += 1
    return changed


# ── Wikidata Chinese labels (CC0) for units whose native / English label matches an item inside the unit ─────
WD_SPARQL = 'https://query.wikidata.org/sparql'
_WD_PENDING = [0]
_WD_BUDGET = [int(os.environ.get('MW_WIKIDATA_QUERIES', '0'))]  # live queries per run (--wikidata N); 0 = cache only
WD_COUNTRY = {'US': 'Q30', 'KR': 'Q884', 'IN': 'Q668', 'GB': 'Q145', 'DE': 'Q183', 'FR': 'Q142', 'CA': 'Q16', 'AU': 'Q408',
              'CH': 'Q39', 'NL': 'Q55', 'SE': 'Q34', 'BR': 'Q155', 'SG': 'Q334', 'IE': 'Q27', 'IL': 'Q801', 'UY': 'Q77',
              'FI': 'Q33', 'DK': 'Q35', 'ES': 'Q29', 'IT': 'Q38', 'NO': 'Q20', 'PL': 'Q36', 'BE': 'Q31', 'PR': 'Q1183',
              'MX': 'Q96', 'AT': 'Q40', 'LU': 'Q32', 'PT': 'Q45', 'GR': 'Q41', 'CZ': 'Q213', 'HU': 'Q28', 'RO': 'Q218',
              'ZA': 'Q258', 'CL': 'Q298', 'PE': 'Q419', 'ID': 'Q252', 'RU': 'Q159', 'SA': 'Q851', 'TR': 'Q43', 'KZ': 'Q232',
              'CO': 'Q739', 'AR': 'Q414', 'VN': 'Q881', 'MY': 'Q833', 'TH': 'Q869', 'PH': 'Q928', 'AE': 'Q878', 'NZ': 'Q664'}
WD_LANG = {'KR': ['ko', 'en'], 'DE': ['de', 'en'], 'AT': ['de', 'en'], 'CH': ['de', 'fr', 'it', 'en'], 'FR': ['fr', 'en'],
           'IT': ['it', 'en'], 'ES': ['es', 'en'], 'NL': ['nl', 'en'], 'BE': ['nl', 'fr', 'en'], 'SE': ['sv', 'en'],
           'DK': ['da', 'en'], 'NO': ['nb', 'en'], 'FI': ['fi', 'en'], 'PL': ['pl', 'en'], 'BR': ['pt', 'en'],
           'PT': ['pt', 'en'], 'MX': ['es', 'en'], 'UY': ['es', 'en'], 'CL': ['es', 'en'], 'PE': ['es', 'en'],
           'AR': ['es', 'en'], 'CO': ['es', 'en'], 'PR': ['es', 'en'], 'LU': ['fr', 'de', 'en'], 'CZ': ['cs', 'en'],
           'HU': ['hu', 'en'], 'RO': ['ro', 'en'], 'GR': ['el', 'en'], 'ID': ['id', 'en'], 'RU': ['ru', 'en'],
           'TR': ['tr', 'en']}


def wd_query(cc, lang, labels):
    """{label: [(zh, lon, lat)]} for Wikidata items in country cc with that label (cached)."""
    q = WD_COUNTRY.get(cc)
    if not q or not labels:
        return {}
    cache = CACHE / 'wikidata' / f'{cc}.{lang}.json'
    have = read_json(cache) if cache.exists() else {}
    todo = sorted(l for l in labels if l not in have)
    for i in range(0, len(todo), 250):
        if _WD_BUDGET[0] <= 0:
            _WD_PENDING[0] += len(todo) - i
            break
        _WD_BUDGET[0] -= 1
        chunk = todo[i:i + 250]
        vals = ' '.join(json.dumps(l, ensure_ascii=False) + '@' + lang for l in chunk)
        sparql = ('SELECT ?item ?l ?zh ?zhcn ?zhhans ?coord WHERE { VALUES ?l { ' + vals + ' } ?item rdfs:label ?l; '
                  f'wdt:P17 wd:{q}; wdt:P625 ?coord. '
                  'OPTIONAL{?item rdfs:label ?zh FILTER(lang(?zh)="zh")} OPTIONAL{?item rdfs:label ?zhcn FILTER(lang(?zhcn)="zh-cn")} '
                  'OPTIONAL{?item rdfs:label ?zhhans FILTER(lang(?zhhans)="zh-hans")} }')
        url = WD_SPARQL + '?' + urllib.parse.urlencode({'query': sparql, 'format': 'json'})
        for k in range(4):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/sparql-results+json'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    d = json.load(r)
                break
            except Exception as e:  # noqa
                log(f'    wikidata retry {k}: {str(e)[:90]}')
                time.sleep(65 if '429' in str(e) else 5 + 10 * k)
        else:
            log(f'    wikidata failed for {cc}/{lang} chunk {i}')
            continue
        for l in chunk:
            have.setdefault(l, [])
        for b in d['results']['bindings']:
            l = b['l']['value']
            zh = (b.get('zhcn') or b.get('zhhans') or b.get('zh') or {}).get('value')
            m = re.match(r'Point\(([-\d.eE]+) ([-\d.eE]+)\)', b['coord']['value'])
            if zh and m:
                have.setdefault(l, []).append((zh_cn(zh), float(m.group(1)), float(m.group(2))))
        write_json(cache, have)
        time.sleep(2.0)
    return have


def wikidata_zh(cc, feats, only=None, label_keys=('ko', 'name')):
    """Fill empty name_zh from Wikidata (item with the same label whose coordinate is inside the unit)."""
    if cc not in WD_COUNTRY:
        return 0
    langs = WD_LANG.get(cc, ['en'])
    n = 0
    for lang in langs:
        need = [f for f in feats if not f['properties'].get('name_zh') and (only is None or f['properties']['id'] in only)]
        if not need:
            break
        key = 'ko' if lang == 'ko' else 'name'
        labels = {f['properties'].get(key) for f in need if f['properties'].get(key)}
        got = wd_query(cc, lang, labels)
        for f in need:
            lab = f['properties'].get(key)
            cands = got.get(lab) or []
            if not cands:
                continue
            rings = [np.asarray(r, dtype=float) for poly in gj_polys(f['geometry']) for r in poly]
            best = None
            for zh, lon, lat in cands:
                if Shapes._inside(rings, lon, lat):
                    d = 0.0
                else:
                    d = min(seg_dist_km(r, lon, lat) for r in rings)
                if d <= 3 and (best is None or d < best[0]):
                    best = (d, zh)
            if best and best[1] and not re.search(r'[a-zA-Z가-힯]', best[1]):
                f['properties']['name_zh'] = best[1]
                n += 1
    return n


# ── admin3: metro detail cut from the finished admin2 parents ────────────────────────────────────────────────
NE_TOWNS = {'09', '23', '25', '33', '44', '50', '34'}  # CT ME MA NH RI VT NJ: county subdivisions tile the county
US_FIPS = {}


def admin2_shapes(cc):
    p = OUT2 / f'{cc}.json'
    return (Shapes(read_json(p)), read_json(p)) if p.exists() else (None, None)


def points_per_unit(cc, sh):
    """{admin2 id: [count of HQ/anchor points, money share max over trees]}"""
    h, pts = hq_data()
    tot = defaultdict(float)
    for p in pts:
        for tr, v in p['dv'].items():
            tot[tr] += v
    res = defaultdict(lambda: [0, 0.0])
    for p in pts:
        if not placed(p) or p['cc'] != cc:
            continue
        hit = sh.locate(p['lon'], p['lat'], snap_km=5)
        if hit:
            r = res[hit[0]]
            r[0] += 1
            r[1] = max([r[1]] + [v / tot[tr] for tr, v in p['dv'].items() if tot[tr]])
    for x, y in dense_points()[len([p for p in pts if placed(p)]):]:
        hit = sh.locate(x, y)
        if hit and hit[0].startswith(cc + '-'):
            res[hit[0]][0] += 1
    return res


def admin3_plan(cc):
    """[(key, [parent ids], kind)] — which admin2 units get admin3 detail, grouped into files."""
    sh, topo = admin2_shapes(cc)
    if not sh:
        return []
    cnt = points_per_unit(cc, sh)
    props = {uid: p for uid, p, _, _ in sh.items}
    plan = []
    if cc == 'US':
        by_state = defaultdict(list)
        for uid, (n, share) in cnt.items():
            if n >= 2 or share >= 0.0005:
                by_state[props[uid]['a1']].append(uid)
        for a1, ids in sorted(by_state.items()):
            plan.append((a1, sorted(ids), 'us'))
    elif cc == 'CN':
        by_prov = defaultdict(list)
        for uid, (n, share) in cnt.items():
            code = uid[3:]
            if code[:2] in ('81', '82') or not code.endswith('00') and code not in CN_MUNI:
                continue  # 省直辖县级 units have no lower level
            if n >= 3 or share >= 0.0005 or code in CN_MUNI:
                by_prov[props[uid]['a1']].append(uid)
        for a1, ids in sorted(by_prov.items()):
            plan.append((a1, sorted(ids), 'cn'))
    elif cc == 'JP':
        _, city = jp_raw()
        dcodes = {f'JP-{c}' for c in city.values()}
        ids = sorted(uid for uid in cnt if uid in dcodes)
        if ids:
            plan.append(('JP-wards', ids, 'jp'))
    elif cc == 'KR':
        cities = set()
        for f in kr_raw():
            c2, _, c3, _ = kr_split(f['properties'])
            if c3:
                cities.add(f'KR-{c2}')
        ids = sorted(uid for uid in cnt if uid in cities)
        if ids:
            plan.append(('KR-gu', ids, 'kr'))
    elif cc == 'TW':
        plan.append(('TW-towns', sorted(props), 'tw'))
    elif cc == 'BR':
        ids = sorted(uid for uid, (n, share) in cnt.items() if n >= 2 or share >= 0.0005)
        if ids:
            plan.append(('BR-mun', ids, 'br'))
    return plan


def src3(cc, kind, parents, sh):
    """admin3 source features (props code, name, name_zh [, rest]) for the given parent admin2 ids."""
    out = []
    lic = None
    if kind == 'us':
        pset = set(parents)
        states = sorted({p[3:5] for p in parents})
        for st in states:
            k = 'cousub' if st in NE_TOWNS else 'place'
            for f in read_json(census_geojson(k, st))['features']:
                pr = f['properties']
                if k == 'cousub':
                    if pr.get('COUSUBFP') == '00000' or f"US-{pr['STATEFP']}{pr['COUNTYFP']}" not in pset:
                        continue
                nm = pr.get('NAME') or ''
                out.append({'type': 'Feature', 'geometry': f['geometry'],
                            'properties': {'code': pr['GEOID'], 'name': nm, 'name_zh': '', 'lsad': pr.get('NAMELSAD')}})
        # unincorporated land = Census county − places, as explicit '<county>-rest' units (so that coast differences
        # between Census and world-atlas go to the neighbouring units, not to 'rest')
        wd = WORK / 'US' / 'a3' / '_rest'
        wd.mkdir(parents=True, exist_ok=True)
        cf = [f for f in read_json(census_geojson('county'))['features'] if f"US-{f['properties']['GEOID']}" in pset]
        cp, pp, ro = wd / 'counties.geojson', wd / 'places.geojson', wd / 'rest.geojson'
        write_json(cp, fc([{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'code': f['properties']['GEOID'] + '-rest'}}
                           for f in cf]))
        write_json(pp, fc([{'type': 'Feature', 'geometry': f['geometry'], 'properties': {}} for f in out]))
        ms('-i', cp, pp, 'combine-files', 'snap', '-erase', 'target=counties', 'source=places', '-o', 'target=counties',
           'format=geojson', ro)
        for f in read_json(ro).get('features') or []:
            g = clean_parts(f['geometry'], min_km2=0.3) if f.get('geometry') else None
            if g:
                out.append({'type': 'Feature', 'geometry': g, 'properties': {'code': f['properties']['code'], 'name': '',
                                                                             'name_zh': ''}})
        lic = ('US Census Bureau cartographic boundary files 2023 (1:500k): places; county subdivisions in CT ME MA NH RI '
               'VT NJ; "rest" = county minus places', 'Public domain (US federal government)')
    elif kind == 'cn':
        for uid in parents:
            ad = uid[3:]
            try:
                kids = datav(ad)['features']
            except SystemExit as e:  # e.g. 东莞 / 中山: DataV has no _full file for cities without counties
                log(f'    {uid}: no DataV children ({str(e)[:80]})')
                continue
            for c in kids:
                cp = c['properties']
                cad = str(cp.get('adcode') or '')
                # 区/县 (6 digits); cities without counties (东莞 中山 嘉峪关 儋州) list 镇/街道 (9 digits)
                if c.get('geometry') and re.fullmatch(r'\d{6}|\d{9}', cad) and cad != ad:
                    out.append({'type': 'Feature', 'geometry': c['geometry'],
                                'properties': {'code': cad, 'name': cn_name_en(cp['name']), 'name_zh': cp['name']}})
        lic = LICENSES['datav']
    elif kind == 'jp':
        feats, city = jp_raw()
        rev = {v: k for k, v in city.items()}
        want = {p[3:] for p in parents}
        for f in feats:
            pr = f['properties']
            key = (pr['N03_001'], pr.get('N03_003') or '')
            if key in city and city[key] in want and (pr.get('N03_004') or '').endswith('区') and pr.get('N03_007'):
                nm = pr['N03_004']
                out.append({'type': 'Feature', 'geometry': f['geometry'],
                            'properties': {'code': pr['N03_007'], 'name': nm, 'name_zh': zh_cn(key[1] + nm), 'ja': nm}})
        lic = LICENSES['n03']
    elif kind == 'kr':
        want = {p[3:] for p in parents}
        for f in kr_raw():
            c2, n2, c3, n3 = kr_split(f['properties'])
            if c3 and c2 in want:
                out.append({'type': 'Feature', 'geometry': f['geometry'],
                            'properties': {'code': c3, 'name': n3, 'name_zh': KR_ZH_FIX.get(n3, ''), 'ko': n3}})
        lic = LICENSES['kr']
    elif kind == 'br':
        feats, lic = src_geoboundaries('BR', 'ADM2')
        out = [{'type': 'Feature', 'geometry': f['geometry'],
                'properties': {'code': f['properties']['code'], 'name': f['properties']['name'], 'name_zh': ''}}
               for f in feats]
    elif kind == 'tw':
        for f in tw_geo('towns'):
            p = f['properties']
            out.append({'type': 'Feature', 'geometry': f['geometry'],
                        'properties': {'code': p['TOWNCODE'], 'name': p['TOWNENG'], 'name_zh': zh_cn(p['TOWNNAME'])}})
        lic = LICENSES['tw']
    return out, lic


A3_UNIT_ZH = {'us': '市镇（Census place）', 'cn': '区县', 'jp': '区（政令市）', 'kr': '区（일반구）', 'tw': '乡镇市区',
              'br': '市（município）'}


def build_admin3(cc, key, parents, kind, cap_kb=CAP3_KB):
    t0 = time.time()
    sh, topo2 = admin2_shapes(cc)
    pprops = {uid: p for uid, p, _, _ in sh.items}
    wd = WORK / cc / 'a3' / key
    wd.mkdir(parents=True, exist_ok=True)
    fr = wd / 'parents.geojson'
    topo2geo(OUT2 / f'{cc}.json', fr, OBJECT, set(parents))
    frame = [{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'fr': 1, 'a2': f['properties']['fid']}}
             for f in read_json(fr)['features']]
    feats, lic = src3(cc, kind, parents, sh)
    if not feats:
        log(f'  admin3 {key}: no source units')
        return None
    # parents the source has nothing for (DataV without children …) stay admin2 only
    have = set()
    pg = {f['properties']['fid']: [np.asarray(r, dtype=float) for poly in gj_polys(f['geometry']) for r in poly]
          for f in read_json(fr)['features']}
    for f in feats:
        rings = [np.asarray(r, dtype=float) for poly in gj_polys(f['geometry']) for r in poly[:1]]
        if not rings:
            continue
        c = rings[0][:-1].mean(axis=0)
        for a2, pr in pg.items():
            if a2 not in have and Shapes._inside(pr, c[0], c[1]):
                have.add(a2)
                break
    if kind != 'us' and len(have) < len(parents):
        drop = sorted(set(parents) - have)
        log(f'  admin3 {key}: no source units inside {drop} — they stay admin2 only')
        parents = [p for p in parents if p in have]
        frame = [f for f in frame if f['properties']['a2'] in have]
        if not parents:
            return None
    info = {}
    sf = []
    for f in feats:
        p = f['properties']
        info.setdefault(str(p['code']), p)
        sf.append({'type': 'Feature', 'geometry': f['geometry'], 'properties': {'code': str(p['code'])}})
    res, stats = fit_units(key, sf, frame, wd, presimplify=10 if kind in ('us', 'cn', 'kr') else None)
    codes_a2 = defaultdict(set)
    for (code, a2) in res:
        codes_a2[code].add(a2)
    out = []
    for (code, a2), geom in res.items():
        par = pprops.get(a2, {})
        if code.endswith('-rest'):
            pn, pz = par.get('name') or a2, par.get('name_zh') or ''
            name, name_zh, uid = f'{pn} (rest)', (f'{pz}其余地区' if pz else ''), f'{a2}-rest'
        else:
            p = info.get(code, {})
            name, name_zh = p.get('name') or code, p.get('name_zh') or ''
            uid = f'{cc}-{code}' if len(codes_a2[code]) == 1 else f'{cc}-{code}-{a2[3:]}'
        out.append({'type': 'Feature', 'geometry': geom,
                    'properties': {'id': uid, 'name': name, 'name_zh': name_zh, 'a1': par.get('a1'), 'a2': a2, 'level': 3,
                                   'ja': info.get(code, {}).get('ja'), 'ko': info.get(code, {}).get('ko')}})
    raw = units_topo(out, wd)
    if cc in ('US',):
        if zh_from_hq(cc, out, raw):
            raw = units_topo(out, wd)
    n = 0
    if cc in ('JP', 'KR'):
        n += geonames_names(cc, out)
    if cc == 'KR':
        n += wikidata_zh(cc, out)
    elif cc == 'US':
        n += wikidata_zh(cc, out, units_with_points(cc, out))
    if n:
        raw = units_topo(out, wd)
    to = TopoOut(raw, OBJECT, lock=lambda a, b: (a.get('properties') or {}).get('a2') != (b.get('properties') or {}).get('a2'),
                 dense=dense_points())
    meta = {'key': key, 'cc': cc, 'unit_zh': A3_UNIT_ZH.get(kind), 'source': lic[0], 'license': lic[1], 'level': 3,
            'built': time.strftime('%Y-%m-%d'), 'frame': f'admin2/{cc}.json (parents, exact borders)', 'fit': stats}
    tol, topo, size = fit_to_cap(to, props_basic(3), meta, cap_kb)
    write_json(OUT3 / f'{key}.json', topo)
    nu = len(topo['objects'][OBJECT]['geometries'])
    zh = sum(1 for g in topo['objects'][OBJECT]['geometries'] if g['properties'].get('name_zh'))
    log(f'  admin3 {key}: {nu} units in {len(parents)} parents, {size / 1000:.0f} KB, simplified at {tol} m, '
        f'name_zh {zh}/{nu}, {time.time() - t0:.0f} s')
    write_index(3)
    return {'key': key, 'units': nu, 'bytes': size, 'tol': tol, 'zh': zh, 'parents': len(parents)}


def build_admin3_country(cc):
    out = []
    plan = admin3_plan(cc)
    for key, parents, kind in plan:
        # keep files under the cap: split big groups (e.g. California) by parent
        groups = [parents]
        while True:
            try:
                res = [build_admin3(cc, key if len(groups) == 1 else f'{key}-{i + 1}', g, kind) for i, g in enumerate(groups)]
                out += [r for r in res if r]
                break
            except SystemExit as e:
                if 'does not fit' not in str(e) or max(len(g) for g in groups) < 2:
                    raise
                groups = [h for g in groups for h in (g[:len(g) // 2], g[len(g) // 2:])]
                for f in OUT3.glob(f'{key}*.json'):
                    f.unlink()
                log(f'  admin3 {key}: splitting into {len(groups)} files')
    return out


# ── units.json: every HQ and anchor → [a1, a2, a3] ───────────────────────────────────────────────────────────
SNAP_KM = 5.0
# markets where hq.json points are often a city centre while Yahoo / cninfo give the district (区 / ku / gu)
REFINE_CC = {'CN', 'JP', 'KR', 'TW', 'HK', 'IN'}
YF_CACHE = GEO / 'cache' / 'yf'
CNINFO_CACHE = GEO / 'cache' / 'cninfo'
UNIT_WORDS = {'district', 'dist', 'ku', 'gu', 'qu', 'shi', 'si', 'city', 'ward', 'county', 'mandal', 'gun', 'xian',
              'hsien', 'township', 'borough', 'prefecture'}
ADDR_SUFFIX = re.compile(r'\b(district|county|city|town|ward|ku|gu|gun|si|shi|qu|xian|township|dist)\b\.?', re.I)


UNIHAN = SRC / 'unihan'
_PY = {}


def py_readings():
    """Every Mandarin reading of each CJK character, toneless (Unicode Unihan: kMandarin, kXHC1983, kTGHZ2013,
    kHanyuPinyin) — so 闵行 reads 'minhang' (unidecode says 'minxing'), 长宁 'changning' (not 'changzhu')."""
    if 'r' in _PY:
        return _PY['r']
    cache = UNIHAN / 'readings.json'
    if cache.exists():
        _PY['r'] = read_json(cache)
        return _PY['r']
    zp = UNIHAN / 'Unihan.zip'
    if not zp.exists():
        fetch('https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip', zp)
    txt = zipfile.ZipFile(zp).read('Unihan_Readings.txt').decode('utf-8')
    out = defaultdict(set)
    for line in txt.splitlines():
        if not line.startswith('U+'):
            continue
        cp, field, val = line.split('\t', 2)
        if field not in ('kMandarin', 'kXHC1983', 'kTGHZ2013', 'kHanyuPinyin'):
            continue
        ch = chr(int(cp[2:], 16))
        for tok in re.split(r'[\s,]+', val):
            tok = tok.split(':')[-1]
            tok = unicodedata.normalize('NFD', tok)
            tok = ''.join(c for c in tok if not unicodedata.combining(c)).lower().replace('ü', 'u')
            if re.fullmatch(r'[a-z]+', tok):
                out[ch].add(tok)
    res = {k: sorted(v) for k, v in out.items()}
    write_json(cache, res)
    _PY['r'] = res
    return res


ZH_UNIT_SUFFIX = ('自治县', '自治旗', '新区', '林区', '特区', '区', '县', '市', '旗')


def py_keys(zh, cap=24):
    """All pinyin spellings of a Chinese unit name without its unit word: 浦东新区 → {'pudong'}, 朝阳区 →
    {'chaoyang', 'zhaoyang'}; empty when the base is one character (东区, 南区: too generic for an address)."""
    base = zh
    for suf in ZH_UNIT_SUFFIX:
        if base.endswith(suf) and len(base) - len(suf) >= 2:
            base = base[:-len(suf)]
            break
    if len(base) < 2 or not all('\u4e00' <= c <= '\u9fff' for c in base):
        return set()
    rd = py_readings()
    combos = ['']
    for ch in base:
        opts = rd.get(ch) or []
        if not opts:
            return set()
        combos = [c + o for c in combos for o in opts][:cap]
    return set(combos)


TWIN = {}


def _twin_office(t):
    """cninfo 办公地址 of the A-share that is the same company (Yahoo long name), for H-shares and ADRs:
    0981.HK → 688981 中芯国际 '上海市浦东新区张江路18号'."""
    if not TWIN:
        names = {}
        h, pts = hq_data()
        for p in pts:
            m = re.match(r'^(\d{6})\.(SS|SZ|BJ)$', p['t'])
            if not m or not (CNINFO_CACHE / f'{m.group(1)}.json').exists():
                continue
            y = YF_CACHE / f"{p['t']}.json"
            try:
                nm = norm(read_json(y).get('name') or '') if y.exists() else ''
                ci = read_json(CNINFO_CACHE / f'{m.group(1)}.json')
            except Exception:
                continue
            if nm and ci.get('status') == 'ok' and ci.get('office'):
                names.setdefault(nm, ci['office'])
        TWIN['names'] = names
    if re.match(r'^\d{6}\.(SS|SZ|BJ)$', t):
        return None
    y = YF_CACHE / f'{t}.json'
    try:
        nm = norm(read_json(y).get('name') or '') if y.exists() else ''
    except Exception:
        return None
    return TWIN['names'].get(nm) if nm else None


def _yf(t):
    p = YF_CACHE / f'{t}.json'
    if p.exists():
        try:
            return read_json(p)
        except Exception:
            pass
    return {}


def _addr_tokens(t):
    """Normalised address strings of a ticker (Yahoo street address + cninfo office address, or the cninfo address
    of its A-share twin)."""
    out = []
    d = _yf(t)
    out += [d.get('a1') or '', d.get('a2') or '']
    m = re.match(r'^(\d{6})\.(SS|SZ|BJ)$', t)
    if m and (CNINFO_CACHE / f'{m.group(1)}.json').exists():
        try:
            c = read_json(CNINFO_CACHE / f'{m.group(1)}.json')
            # several offices ('北京…；深圳…'): the first is the head office
            out += [re.split(r'[；;]', c.get('office') or '')[0]]
        except Exception:
            pass
    else:
        tw = _twin_office(t)
        if tw:
            out += [re.split(r'[；;]', tw)[0]]
    return [x for x in out if x]


def _unit_keys(p):
    """Strings an address may use for a unit: Chinese name (with / without 区县市), English name without suffix."""
    keys = set()
    z = p.get('name_zh') or ''
    for suf in ('其余地区',):
        if z.endswith(suf):
            return keys
    if z and len(z) >= 2:
        keys.add(('zh', z))
    n = norm(p.get('name') or '')
    if n and not n.endswith(' rest'):
        base = ADDR_SUFFIX.sub('', n).strip()
        base = re.sub(r'\s+', '', base)
        base = re.sub(r'newarea$', '', base)
        if len(base) >= 4:
            keys.add(('en', base))
        # hangul / kana names romanised by unidecode: '영통구' → yeongtonggu → yeongtong
        glued = re.sub(r'\s+', '', n)
        m = re.match(r'^(.{4,}?)(gu|gun|si|shi|ku|qu|xian|cheon)$', glued)
        if m and m.group(2) != 'cheon':
            keys.add(('en', m.group(1)))
    # Chinese units: every pinyin reading of the name (闵行 → minhang, 朝阳 → chaoyang), so 'Minhang District',
    # 'Chaoyang District', 'Pudong New Area' match even where the romanised `name` is unidecode's guess
    if z and str(p.get('id', ''))[:2] in ('CN', 'HK', 'MO', 'TW'):
        cls = PY_CLASS.get(z[-1], 'any')
        for k in py_keys(z):
            if len(k) >= 4:
                keys.add(('py:' + cls, k))
    return keys


# the unit word an address may put after a Chinese unit's pinyin: '苗栗市' is 'Miaoli City', never 'Miaoli County'
# (that is the 縣 around it); '浦东新区' 'Pudong District / New Area'; '昆山市' 'Kunshan City'
PY_CLASS = {'市': 'city', '区': 'district', '县': 'county', '旗': 'county', '镇': 'town', '乡': 'town'}
PY_WORDS = {'city': {'city', 'shi', 'si'}, 'district': {'district', 'dist', 'qu', 'ward', 'borough'},
            'county': {'county', 'xian', 'hsien'}, 'town': {'town', 'township', 'zhen', 'xiang'}}


def _addr_match(addrs, units):
    """The single unit (id) whose name appears in the address, longest key first; None if none or ambiguous.
    Chinese names: substring of the Chinese address. Latin names: 1–3 consecutive address words, joined
    ('Yu Hang District' → yuhang, 'Minato-ku' → minato, 'Yeongtong-gu' → yeongtong)."""
    zh_text = ''.join(a for a in addrs if re.search(r'[\u4e00-\u9fff]', a))
    grams, tail = {}, set()
    for a in addrs:
        a = re.sub(r'\bnew\s+(area|district|zone)\b', 'district', a, flags=re.I)
        for part in re.split(r'[,;()]', a):
            w = norm(part).split()
            for n in (1, 2, 3):
                for i in range(len(w) - n + 1):
                    g = ''.join(w[i:i + n])
                    if len(g) < 4 or g.isdigit():
                        continue
                    # a name followed by its unit word: 'Nanshan District', 'Minato-ku', 'Yeongtong-gu',
                    # 'Ranga Reddy District' — not 'Navi Mumbai', 'East Tower', 'Erode Road'
                    if i + n < len(w) and w[i + n] in UNIT_WORDS:
                        grams.setdefault(g, set()).add(w[i + n])
                    # a Chinese district name closing an address line ('… Industrial Park Nanshan'): weaker
                    elif i + n == len(w) and n <= 2:
                        tail.add(g)
    hits = []
    for uid, p in units:
        best = 0
        for kind, k in _unit_keys(p):
            if kind == 'zh' and k in zh_text:
                best = max(best, len(k) * 3 + 0.5)   # the Chinese (cninfo 办公地址) name wins a tie with Yahoo's
            elif kind == 'en' and k in grams:
                best = max(best, len(k))
            elif kind.startswith('py') and k in grams and (kind == 'py:any' or grams[k] & PY_WORDS[kind[3:]]):
                best = max(best, len(k))
            elif kind.startswith('py') and len(k) >= 6 and k in tail:
                best = max(best, len(k) * 0.5)
        if best:
            hits.append((best, uid))
    if not hits:
        return None
    hits.sort(reverse=True)
    if len(hits) > 1 and hits[0][0] == hits[1][0]:
        return None
    return hits[0][1]


def _inner_point(rings):
    """A point inside the unit: centroid of its largest ring if inside, else the midpoint of a horizontal chord."""
    big = max(rings, key=lambda r: abs(ring_area_km2(r)))
    c = big[:-1].mean(axis=0)
    if Shapes._inside(rings, c[0], c[1]):
        return round(float(c[0]), 5), round(float(c[1]), 5)
    y = float(np.median(big[:, 1]))
    xs = []
    for r in rings:
        x1, y1, x2, y2 = r[:-1, 0], r[:-1, 1], r[1:, 0], r[1:, 1]
        m = (y1 > y) != (y2 > y)
        xs += list(x1[m] + (y - y1[m]) * (x2[m] - x1[m]) / (y2[m] - y1[m]))
    xs.sort()
    if len(xs) >= 2:
        i = max(range(0, len(xs) - 1, 2), key=lambda k: xs[k + 1] - xs[k])
        return round((xs[i] + xs[i + 1]) / 2, 5), round(y, 5)
    return round(float(big[0, 0]), 5), round(float(big[0, 1]), 5)


class Locator:
    def __init__(self):
        self.i2 = read_json(OUT2 / 'index.json') if (OUT2 / 'index.json').exists() else {}
        self.i3 = read_json(OUT3 / 'index.json') if (OUT3 / 'index.json').exists() else {}
        self.s2, self.s3, self.a1s = {}, {}, {}
        self.by_a2 = defaultdict(list)  # admin2 id → admin3 keys
        for k, v in self.i3.items():
            for a2 in v.get('a2', []):
                self.by_a2[a2].append(k)
        wa = read_json(VENDOR / 'geo' / 'countries-10m.json')
        self.world = Shapes(wa, 'countries')

    def sh2(self, cc):
        if cc not in self.s2:
            self.s2[cc] = Shapes(read_json(OUT2 / self.i2[cc]['file'])) if cc in self.i2 else None
        return self.s2[cc]

    def sh3(self, key):
        if key not in self.s3:
            self.s3[key] = Shapes(read_json(OUT3 / self.i3[key]['file']))
        return self.s3[key]

    def sh1(self, cc):
        if cc not in self.a1s:
            sh = None
            if (ADMIN1 / f'{cc}.json').exists():
                sh = Shapes(read_json(ADMIN1 / f'{cc}.json'), 'admin1')
            else:
                p = WORK / '_a1' / f'{cc}.geojson'
                feats = [f for f in read_json(p)['features'] if f['properties'].get('a1')] if p.exists() else []
                if not feats:  # e.g. AE, BM, CY, JE …: Natural Earth admin-1 ISO codes
                    try:
                        feats = ne_admin1(cc)
                    except SystemExit:
                        feats = []
                sh = GeoShapes(feats, 'a1') if feats else None
            self.a1s[cc] = sh
        return self.a1s[cc]

    def countries_of(self, lon, lat):
        """ISO2 of the world-atlas countries containing the point (planar test; countries whose polygons wrap the
        antimeridian — RU, US, FJ … — are tried last, their planar bbox covers half the globe), else the nearest
        within SNAP_KM."""
        hits = []
        for uid, p, rings, bb in self.world.items:
            if bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3] and Shapes._inside(rings, lon, lat):
                hits.append((bb[2] - bb[0] > 300, NUM_ISO.get(str(uid))))
        hits.sort(key=lambda h: h[0])
        out = [c for _, c in hits if c]
        if not out:
            near = self.world.locate(lon, lat, snap_km=SNAP_KM)
            if near and NUM_ISO.get(str(near[0])):
                out = [NUM_ISO[str(near[0])]]
        return out

    def locate(self, lon, lat, cc=None):
        """[a1, a2, a3], cc, how — admin2 of the given country, else of the countries under the point; then admin1."""
        cands = [cc] if cc else []
        cands += [x for x in self.countries_of(lon, lat) if x not in cands]
        for c in cands:
            sh = self.sh2(c) if c in self.i2 else None
            if not sh:
                continue
            hit = sh.locate(lon, lat, snap_km=SNAP_KM)
            if hit:
                a2, p2, d2 = hit
                a3 = None
                for key in self.by_a2.get(a2, []):
                    h3 = self.sh3(key).locate(lon, lat, snap_km=SNAP_KM, where=lambda p, a2=a2: p.get('a2') == a2)
                    if h3:
                        a3 = h3[0]
                        break
                return [p2.get('a1'), a2, a3], c, ('snap' if d2 else 'in')
        for c in cands:
            s1 = self.sh1(c)
            if s1:
                hit = s1.locate(lon, lat, snap_km=SNAP_KM)
                if hit:
                    return [hit[0] if s1.__class__ is Shapes else hit[1].get('a1'), None, None], c, 'admin1'
        return [None, None, None], cc, 'none'

    def refine(self, t, lon, lat, tri, cc):
        """Street-address refinement: the address names another unit of the same a1 (admin2) / a2 (admin3) —
        by name (cninfo 中文地址, 'Nanshan District', 'Pudong New Area') or, failing that, by a zone / neighbourhood
        word of units_refine.ZONES (张江 → 浦东新区, Admiralty → 中西区). Returns [a1, a2, a3, lon, lat] or None;
        self.last_how says which ('addr' / 'zone'); self.last_confirmed = the address names the unit the point is in."""
        self.last_how = None
        self.last_confirmed = None
        if cc not in REFINE_CC:
            return None
        addrs = _addr_tokens(t)
        city = (_yf(t).get('city') or '') if cc == 'HK' else ''
        if not (addrs or city) or not tri[1]:
            return None
        a1, a2, a3 = tri
        how = 'addr'
        new2 = a2
        sh = self.sh2(cc)
        if sh:
            cands = [(uid, p) for uid, p, _, _ in sh.items if p.get('a1') == a1]
            m = _addr_match(addrs, cands)
            if not m and cc == 'HK':
                m = R.zone_match([city] + addrs[::-1], 'CN-HK', cands)
                how = 'zone' if m else how
            if m and m != a2:
                # only when the address unit is close (the point is a city centre, not another city)
                rings = next(r for uid, _, r, _ in sh.items if uid == m)
                if min(seg_dist_km(r, lon, lat) for r in rings) <= 25:
                    new2 = m
            elif m == a2 and not self.by_a2.get(a2):
                self.last_confirmed = a2
        new3 = a3 if new2 == a2 else None
        rings3 = None
        for key in self.by_a2.get(new2, []):
            s3 = self.sh3(key)
            cands = [(uid, p) for uid, p, _, _ in s3.items if p.get('a2') == new2]
            m = _addr_match(addrs, cands)
            if not m:
                m = R.zone_match(addrs[::-1], new2, cands)
                how = 'zone' if m else how
            if m:
                if m == a3 and new2 == a2:
                    self.last_confirmed = a3
                new3 = m
                rings3 = next(r for uid, _, r, _ in s3.items if uid == m)
                break
        if new2 == a2 and new3 == a3:
            return None
        self.last_how = how
        if rings3 is None:
            if new3 and new2 == a2:
                return None
            rings = next(r for uid, _, r, _ in sh.items if uid == new2)
            if new3 is None and self.by_a2.get(new2):
                # moved to another admin2 that has admin3: find the admin3 at the new point
                x, y = _inner_point(rings)
                for key in self.by_a2[new2]:
                    h3 = self.sh3(key).locate(x, y, where=lambda p: p.get('a2') == new2)
                    if h3:
                        new3 = h3[0]
                        break
                return [a1, new2, new3, x, y]
            x, y = _inner_point(rings)
            return [a1, new2, None, x, y]
        x, y = _inner_point(rings3)
        return [a1, new2, new3, x, y]

    def unit_props(self, uid):
        """properties of a unit id (admin2 or admin3), cached."""
        if not hasattr(self, '_props'):
            self._props = {}
        if uid not in self._props:
            cc = uid.split('-')[0]
            for sh in [self.sh2(cc) if cc in self.i2 else None] + [self.sh3(k) for k in self.i3 if self.i3[k].get('cc') == cc]:
                if sh:
                    for i, p, rings, _ in sh.items:
                        self._props.setdefault(i, (p, rings))
        return self._props.get(uid, ({}, None))


class GeoShapes(Shapes):
    def __init__(self, feats, key):
        self.items = []
        for f in feats:
            rings = [np.asarray(r, dtype=float) for poly in gj_polys(f['geometry']) for r in poly]
            if not rings:
                continue
            allp = np.concatenate(rings)
            bb = (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())
            self.items.append((f['properties'][key], dict(f['properties']), rings, bb))


SPOT = [  # ticker, expected words in a2 / a3 (name or name_zh)
    ('NVDA', 'Santa Clara'), ('AAPL', 'Cupertino'), ('GOOGL', 'Mountain View'), ('META', 'Menlo Park'),
    ('MSFT', 'Redmond'), ('AMZN', 'Seattle'), ('TSLA', 'Austin'), ('JPM', 'New York'), ('DNA', 'Boston'),
    ('XOM', 'Spring|Harris'), ('WMT', 'Bentonville'), ('NKE', 'Beaverton|Washington County'), ('BRK-B', 'Omaha'),
    ('600519.SS', '仁怀'), ('300750.SZ', '宁德'), ('002594.SZ', '坪山'), ('0700.HK', '南山'), ('9988.HK', '余杭'),
    ('BABA', '余杭'), ('601318.SS', '深圳'), ('600036.SS', '深圳'), ('601857.SS', '北京'), ('000333.SZ', '佛山'),
    ('2330.TW', '新竹'), ('2317.TW', '新北|土城'), ('2454.TW', '新竹'), ('005930.KS', '水原|灵通'), ('000660.KS', '利川'),
    ('005380.KS', '首尔|瑞草'), ('6758.T', '港区|Minato'), ('7203.T', '丰田|Toyota'), ('6861.T', '大阪'),
    ('9984.T', '港区|Minato'), ('RELIANCE.NS', '^Mumbai(?! Suburban)'), ('INFY.NS', 'Bangalore|Bengaluru'),
    ('ASML', 'Veldhoven'), ('ASML.AS', 'Veldhoven'), ('SAP', 'Rhein-Neckar|Walldorf'), ('SAP.DE', 'Rhein-Neckar|Walldorf'),
    ('NVO', 'Gladsaxe|Bagsv'), ('NESN.SW', 'Riviera|Vevey'), ('SHEL', 'Lambeth'), ('HSBA.L', 'Tower Hamlets|London'),
    ('AZN', 'Cambridge'), ('ARM', 'Cambridge'), ('MC.PA', 'Paris'), ('SHOP', 'Ottawa'), ('RY', 'Toronto'),
    ('BHP', 'Melbourne'), ('CBA.AX', 'Sydney'), ('SE', 'Singapore|Queenstown|Downtown|Southern|Outram|Museum'),
    ('NU', 'São Paulo|Sao Paulo'), ('VALE', 'Rio de Janeiro'), ('MELI', 'Montevideo|Municipality B'),
    # refine 2026-10-28: the critics' wrong districts (city-centre points)
    ('688981.SS', '浦东'), ('0981.HK', '浦东'), ('3690.HK', '朝阳'), ('300760.SZ', '南山'), ('600030.SS', '朝阳'),
    ('601012.SS', '未央'), ('600938.SS', '东城'), ('0883.HK', '东城'), ('0941.HK', '西城'), ('BARC.L', 'Tower Hamlets'),
    ('SHEL.L', 'Lambeth'), ('LSEG.L', 'City of London'), ('ULVR.L', 'City of London'), ('GSK.L', 'Camden'),
    ('RR.L', 'Islington|Camden'), ('TCS.NS', '^Mumbai(?! Suburban)'), ('HDFCBANK.NS', '^Mumbai(?! Suburban)'),
    ('IBN', 'Mumbai Suburban'), ('HD', 'Cobb'), ('1299.HK', '中西区'), ('0016.HK', '湾仔'), ('0008.HK', '东区'),
]


def _codes(t):
    """Postcodes of a ticker: Yahoo zip + cninfo 邮政编码 (A-shares)."""
    out = []
    z = _yf(t).get('zip')
    if z:
        out.append(str(z))
    m = re.match(r'^(\d{6})\.(SS|SZ|BJ)$', t)
    if m and (CNINFO_CACHE / f'{m.group(1)}.json').exists():
        try:
            z = read_json(CNINFO_CACHE / f'{m.group(1)}.json').get('zip')
            if z:
                out.append(str(z))
        except Exception:
            pass
    return out


GUESS_DENSITY = 3000.0   # people per km² of a city's built-up area: pop / density ≈ how much land "the city" covers


def units_guess(L, pts, T_, fine, h, sure=()):
    """guess[ticker] = the first unit level that is only the hq.json point's (a city centre or a stand-in), not the
    company's: 1 for a country stand-in (kind approx), 2 for a state stand-in (kind state) or a city bigger than its
    admin2 unit (Tokyo → 新宿区, London → Westminster, Seoul → 중구, Mumbai → Mumbai Suburban), 3 for a city bigger than
    its admin3 unit (上海 → 黄浦区, 北京 → 东城区). Units with an address / postcode (fine) are never guesses; a city
    that IS the unit (Paris, Toronto, New York County, Santa Clara) or smaller than it (Walldorf in Rhein-Neckar) is
    not one either."""
    pops = R.city_pops(GEO / 'cities15000.txt')
    zh = h.get('zh') or {}
    area = {}

    def unit_area(uid):
        if uid not in area:
            _, rings = L.unit_props(uid)
            area[uid] = abs(sum(ring_area_km2(r) for r in rings)) if rings else 0.0
        return area[uid]

    def same_name(city, czh, uid):
        p, _ = L.unit_props(uid)
        a, b = norm(city), norm(p.get('name') or '')
        a = re.sub(r'\b(city|shi|si|gu|ku)\b', '', a).strip()
        b = re.sub(r'\b(county|city|district|borough|of|shi|si|gu|ku|qu|kreisfreie|stadt|metropolitan|government|'
                   r'balance|municipio|municipality|rest)\b', '', b).strip()
        if a and b and (a == b or (len(a) >= 4 and a in b) or (len(b) >= 4 and b in a)):
            return True
        z = p.get('name_zh') or ''
        return bool(czh and z and (z.startswith(czh) or czh.startswith(z.rstrip('区县市'))))

    def shares(city, uid, level):
        """another unit of the same parent also carries the city's name (Mumbai / Mumbai Suburban)"""
        p, _ = L.unit_props(uid)
        cc = uid.split('-')[0]
        a = norm(city)
        shs = [L.sh2(cc)] if level == 2 else [L.sh3(k) for k in L.by_a2.get(p.get('a2'), [])]
        n = 0
        for sh in shs:
            if not sh:
                continue
            for i, q, _, _ in sh.items:
                if len(a) >= 4 and a in norm(q.get('name') or '') and (level == 2 and q.get('a1') == p.get('a1') or
                                                                     level == 3 and q.get('a2') == p.get('a2')):
                    n += 1
        return n > 1

    out = {}
    for p in pts:
        t = p['t']
        tri = T_.get(t)
        if t in fine or t in sure or not tri or not tri[1] or not placed(p):
            continue
        if p['kind'] == 'approx':
            out[t] = 1
            continue
        if p['kind'] == 'state':
            out[t] = 2
            continue
        city = p['city'] or ''
        cands = pops.get((norm(city), p['cc']), [])
        cands = [c for c in cands if km(c[1], c[2], p['lon'], p['lat']) <= 15]
        if not cands:
            if p['kind'] == 'near' and tri[2]:
                out[t] = 3
            continue
        pop = max(c[0] for c in cands)
        city_km2 = pop / GUESS_DENSITY
        czh = zh.get(f"{city}|{p['cc']}") or ''
        for level in (2, 3):
            uid = tri[level - 1]
            if not uid:
                continue
            if same_name(city, czh, uid) and not shares(city, uid, level):
                continue
            ua = unit_area(uid)
            if ua and city_km2 > 1.5 * ua:
                out[t] = level
                break
        else:
            if p['kind'] == 'near' and tri[2]:
                out[t] = 3
    return out


def build_units():
    t0 = time.time()
    L = Locator()
    h, pts = hq_data()
    T_ = {}
    fine = {}
    why = {}          # ticker -> how its fine entry was found (addr / zone / postal / pin-mumbai / code)
    how = Counter()
    moved = R.load_moved(GEO / 'tables')
    P = R.Postal(fetch=fetch, log=log)
    if not R.ZCTA_REL.exists():
        fetch(R.ZCTA_REL_URL, R.ZCTA_REL)
    confirmed = defaultdict(list)   # cc -> [(postcode, unit)] of HQs whose address names their unit
    sure = set()                    # tickers whose address / postcode confirms the unit the point is in
    unit_name = lambda uid: L.unit_props(uid)[0].get('name') or ''
    for p in pts:
        if not placed(p):
            T_[p['t']] = [None, None, None]
            how['not-a-place'] += 1
            continue
        tri, cc, hw = L.locate(p['lon'], p['lat'], p['cc'])
        how[hw] += 1
        T_[p['t']] = tri
        if not tri[1]:
            continue
        cc = cc or p['cc']
        r = L.refine(p['t'], p['lon'], p['lat'], tri, cc)
        if r:
            fine[p['t']] = r
            why[p['t']] = L.last_how or 'addr'
        if cc in ('CN', 'TW') and (r or L.last_confirmed) and (L.last_how in (None, 'addr')):
            unit = (r[2] or r[1]) if r else L.last_confirmed
            for z in _codes(p['t']):
                confirmed[cc].append((z, unit))
        if L.last_confirmed:
            sure.add(p['t'])
        if r or p['t'] in moved:
            continue
        if cc == 'US':
            got, ok = R.street_refine(L, p['t'], p['lon'], p['lat'], tri)
            if got:
                fine[p['t']], why[p['t']] = got, ok
                continue
            if ok:
                sure.add(p['t'])
                continue
            if p['t'] in R.census_points():
                continue   # the street geocode disagrees with the city (another state / far): leave it
        if cc not in R.POSTAL_FILES:
            continue
        y = _yf(p['t'])
        if y.get('zip'):
            got, ok = R.postal_refine(L, P, p['t'], cc, str(y['zip']), p['lon'], p['lat'], tri, _inner_point,
                                      unit_name, y.get('city') or '')
            if got:
                fine[p['t']], why[p['t']] = got, ok
            elif ok:
                sure.add(p['t'])
    # postcodes that address-confirmed HQs share (CN 6 digits, TW the 3-digit district code)
    learned = {'CN': R.learn_codes(confirmed['CN'], R.cn_code, 2), 'TW': R.learn_codes(confirmed['TW'], R.tw_code, 1)}
    for p in pts:
        t = p['t']
        if t in fine or t in moved or not placed(p) or p['cc'] not in learned or not T_[t][1]:
            continue
        tri = T_[t]
        key = R.cn_code if p['cc'] == 'CN' else R.tw_code
        units = {learned[p['cc']].get(key(z)) for z in _codes(t)} - {None}
        if len(units) != 1:
            continue
        u = units.pop()
        if u in (tri[1], tri[2]):
            continue
        props, rings = L.unit_props(u)
        if not rings or not props:
            continue
        if min(seg_dist_km(rr, p['lon'], p['lat']) for rr in rings) > 25:
            continue
        x, y = _inner_point(rings)
        if props.get('level') == 3:
            fine[t] = [props.get('a1') or tri[0], props['a2'], u, x, y]
        else:
            a3 = None
            for k in L.by_a2.get(u, []):
                h3 = L.sh3(k).locate(x, y, where=lambda q, u=u: q.get('a2') == u)
                if h3:
                    a3 = h3[0]
                    break
            fine[t] = [props.get('a1') or tri[0], u, a3, x, y]
        why[t] = 'code'
    guess = units_guess(L, pts, T_, fine, h, sure)
    A = {}
    an = read_json(ANCHORS_JSON)
    seen = {}
    for d in (an['anchors'], an['nodes']):
        for v in d.values():
            for x in v:
                seen.setdefault(x['id'], x)
    for aid, x in seen.items():
        if x.get('lon') is None:
            A[aid] = [None, None, None]
            continue
        tri, cc, hw = L.locate(x['lon'], x['lat'])
        A[aid] = tri
        how['anchor-' + hw] += 1
    out = {'version': 1, 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'about': ('Administrative units of every HQ (hq.json) and anchor (anchors.json), DESIGN §26 amendment 4. '
                     't[ticker] / a[anchorId] = [a1, a2, a3|null]: a1 = admin1 id (web/vendor/geo/admin1, or the best '
                     'ISO 3166-2 code), a2 = admin2 unit id (web/vendor/geo/admin2/<ISO2>.json), a3 = admin3 unit id '
                     '(web/vendor/geo/admin3/<key>.json) or null; by point-in-polygon of the hq.json / anchors.json point '
                     '(snapped up to 5 km for coastal points). [null,null,null] = not a place (funds that are a whole '
                     'country / region / sea area, offshore anchors) or no unit data. fine[ticker] = [a1, a2, a3|null, '
                     'lon, lat]: the HQ is in another / finer unit than the hq.json point (a city centre) says — the street '
                     'address names it (Sony: Tokyo centre → 新宿区, address Minato-ku → 港区; 中芯国际: 上海 → 浦东新区), '
                     'or its postcode places it (HSBC E14 5HQ → Tower Hamlets; Reliance PIN 400021 → Mumbai City), or '
                     'address-confirmed HQs with the same postcode all sit there (CN / TW). Prefer fine where present and '
                     'draw the dot at its lon/lat (a point inside that unit). guess[ticker] = 1|2|3: from this level down '
                     'the unit comes from a city-centre / stand-in point, not from an address (e.g. a Shanghai company '
                     'with no address: a2 上海 is right, a3 黄浦区 is only the centre) — say 区不详 / 估, do not name it. '
                     'Built by geodata/build_admin2.py (+ units_refine.py).'),
           't': T_, 'a': A, 'fine': fine, 'guess': guess}
    write_json(UNITS_JSON, out)
    rep = units_report(out, pts, L)
    rep['how'] = dict(how)
    rep['fineHow'] = dict(Counter(why.values()))
    by_cc = defaultdict(Counter)
    for p in pts:
        if p['t'] in why:
            by_cc[p['cc']][why[p['t']]] += 1
    rep['fineByCountry'] = {cc: dict(c) for cc, c in sorted(by_cc.items(), key=lambda kv: -sum(kv[1].values()))}
    rep['learnedCodes'] = {cc: len(v) for cc, v in learned.items()}
    rep['guess'] = dict(Counter(guess.values()))
    rep['seconds'] = round(time.time() - t0)
    log(f'units.json: {len(T_)} tickers, {len(A)} anchors, {len(fine)} address refinements, {time.time() - t0:.0f} s')
    return rep


def units_report(out, pts, L):
    T_, fine = out['t'], out['fine']
    trees = ('curated', 'full', 'global')
    cov = {}
    names = {}

    def nm(uid):
        if not uid:
            return None
        if uid not in names:
            cc = uid.split('-')[0]
            for sh in [L.sh2(cc)] + [L.sh3(k) for k in L.i3 if L.i3[k].get('cc') == cc]:
                if not sh:
                    continue
                for i, p, _, _ in sh.items:
                    names.setdefault(i, f"{p.get('name')} {p.get('name_zh') or ''}".strip())
        return names.get(uid, uid)
    for tr in trees:
        tot = has2 = has3 = has1 = 0.0
        by_cc = defaultdict(lambda: [0.0, 0.0, 0.0])
        misses = []
        for p in pts:
            v = p['dv'].get(tr)
            if not v or not placed(p):
                continue
            tri = fine.get(p['t'], T_[p['t']])[:3]
            tot += v
            has1 += v if tri[0] else 0
            has2 += v if tri[1] else 0
            has3 += v if tri[2] else 0
            c = by_cc[p['cc']]
            c[0] += v
            c[1] += v if tri[1] else 0
            c[2] += v if tri[2] else 0
            if not tri[1]:
                misses.append((v, p['t'], p['cc'], p['city']))
        misses.sort(reverse=True)
        cov[tr] = {'placedMoney': round(tot), 'a1': round(100 * has1 / tot, 2), 'a2': round(100 * has2 / tot, 2),
                   'a3': round(100 * has3 / tot, 2),
                   'byMarket': {cc: {'share': round(100 * c[0] / tot, 2), 'a2': round(100 * c[1] / c[0], 1),
                                     'a3': round(100 * c[2] / c[0], 1)}
                                for cc, c in sorted(by_cc.items(), key=lambda kv: -kv[1][0])[:20]},
                   'misses': [[t, cc, city, round(100 * v / tot, 3)] for v, t, cc, city in misses[:40]]}
    spot = []
    for t, want in SPOT:
        if t not in T_:
            continue
        tri = T_[t]
        f = fine.get(t)
        got = f[:3] if f else tri
        txt = ' | '.join(filter(None, [nm(got[1]), nm(got[2])]))
        ok = bool(re.search(want, txt, re.I))
        spot.append({'t': t, 'want': want, 'ok': ok, 'got': txt, 'pip': ' | '.join(filter(None, [nm(tri[1]), nm(tri[2])])),
                     'fine': bool(f)})
    anchors = {'total': len(out['a']), 'a2': sum(1 for v in out['a'].values() if v[1]),
               'none': sorted(k for k, v in out['a'].items() if not v[0])}
    return {'coverage': cov, 'spot': spot, 'spotOk': f"{sum(s['ok'] for s in spot)}/{len(spot)}", 'anchors': anchors,
            'fine': len(fine)}


def zh_pass(ccs=None):
    """Fill empty name_zh in the finished files from Wikidata, for units holding an HQ / anchor point (KR: every
    unit). Labels of all files of a country are queried together (live queries within the --wikidata budget, the
    rest from the cache); geometry is not touched."""
    files = [(OUT2 / f'{cc}.json', cc) for cc, *_ in PLAN if (OUT2 / f'{cc}.json').exists()]
    i3 = read_json(OUT3 / 'index.json') if (OUT3 / 'index.json').exists() else {}
    files += [(OUT3 / v['file'], v['cc']) for v in i3.values()]
    todo = defaultdict(list)  # cc -> [(path, topo, feats, only)]
    for path, cc in files:
        if ccs and cc not in ccs or cc in ('CN', 'HK', 'MO', 'TW', 'JP') or cc not in WD_COUNTRY:
            continue
        topo = read_json(path)
        feats = [{'type': 'Feature', 'properties': dict(p),
                  'geometry': {'type': 'Polygon', 'coordinates': [r.tolist() for r in rings]}}
                 for uid, p, rings, bb in Shapes(topo).items if not p.get('name_zh')]
        if not feats:
            continue
        if cc == 'KR':
            for f in feats:
                nm = f['properties']['name']
                f['properties']['ko'] = nm if re.search(r'[\uac00-\ud7af]', nm) else None
        only = None if cc == 'KR' else units_with_points(cc, feats)
        todo[cc].append((path, topo, feats, only))
    # 1. query all labels of a country at once (fills the cache)
    for cc, items in todo.items():
        for lang in WD_LANG.get(cc, ['en']):
            key = 'ko' if lang == 'ko' else 'name'
            labels = {f['properties'].get(key) for _, _, feats, only in items for f in feats
                      if f['properties'].get(key) and (only is None or f['properties']['id'] in only)}
            wd_query(cc, lang, labels)
    # 2. apply from the cache
    changed = {}
    for cc, items in todo.items():
        for path, topo, feats, only in items:
            n = wikidata_zh(cc, feats, only)
            if not n:
                continue
            zh = {f['properties']['id']: f['properties']['name_zh'] for f in feats if f['properties'].get('name_zh')}
            for g in topo['objects'][OBJECT]['geometries']:
                if g['id'] in zh:
                    g['properties']['name_zh'] = zh[g['id']]
            write_json(path, topo)
            changed[path.name] = n
            log(f'  name_zh +{n} in {path.parent.name}/{path.name}')
    if changed:
        write_index(2)
        write_index(3)
    if _WD_PENDING[0]:
        log(f'  wikidata: {_WD_PENDING[0]} labels still unqueried (rerun with --zh-pass --wikidata N)')
    return changed


def fetch_addresses():
    """cninfo 办公地址 for A-shares without a cache file (akshare, single-threaded: its V8 is not thread-safe; ~2 s
    each) and Census geocodes for US HQs not yet geocoded."""
    h, pts = hq_data()
    codes = sorted({p['t'][:6] for p in pts if re.match(r'^\d{6}\.(SS|SZ|BJ)$', p['t'])
                    and not (CNINFO_CACHE / f"{p['t'][:6]}.json").exists()})
    if codes:
        sys.path.insert(0, str(GEO))
        import build_hq  # noqa: E402  (ours)
        log(f'cninfo: {len(codes)} A-shares to fetch')
        build_hq.cninfo_fetch(codes, workers=1, log=log)
    R.geocode_us(h['hq'], _yf, log=log)


# ── names pass: hand table + systematic clean-ups on the finished files (geometry untouched) ─────────────────
UNIT_NAMES = GEO / 'tables' / 'unit_names.tsv'
# Chinese names the old hq.json zh table gave units (zh_from_hq) that geo_tables.CITY_ZH has since corrected
ZH_FIX = {'布里司班': '布里斯班', '阿德来得': '阿德莱德', '德寳': '达博', '李斯腓': '累西腓', '古里提巴': '库里蒂巴',
          '阿勒勒自治': '阿勒勒', '巴勒鲁普自治': '巴勒鲁普', '雅息特': '埃克塞特', '清奈': '金奈', '燕豪芬': '埃因霍温',
          '希星堡': '赫尔辛堡', '沙加缅度': '萨克拉门托', '波德': '博尔德', '肯顿': '卡姆登', '柯巴利': '奥尔巴尼',
          '德罕': '达勒姆', '列治文': '里士满', '维珍尼亚海滩': '弗吉尼亚海滩', '本顿维': '本顿维尔', '喜瑞都': '塞里托斯',
          '都伯林': '都柏林', '艾尔蒙地': '埃尔蒙特', '费利蒙': '弗里蒙特', '希活': '海沃德', '利佛摩': '利弗莫尔',
          '帕罗奥图': '帕洛阿尔托', '库卡蒙格牧场': '兰乔库卡蒙加', '柔似蜜': '罗斯米德', '圣地牙哥': '圣迭戈',
          '圣利安卓': '圣莱安德罗', '圣马刁': '圣马特奥', '拉哥': '拉戈', '克罗格': '凯洛格', '菲力荷自治': '弗里霍尔德',
          '拉坦姆': '莱瑟姆', '维斯特': '韦斯特维尔', '奥克拉荷马': '俄克拉何马城', '苏瀑': '苏福尔斯', '斯德伯克': '锡达帕克',
          '休斯顿': '休斯敦', '汉柏': '亨布尔', '普若佛': '普罗沃', '巴萨尔': '博塞尔', '卡加利': '卡尔加里', '杜拜': '迪拜',
          '伊斯坦堡': '伊斯坦布尔', '翡冷翠': '佛罗伦萨', '基秦拿': '基奇纳', '素里': '萨里', '阿哇': '艾哈迈达巴德'}
_ZH_FIX_RE = re.compile(r'^(.+?)(县|市)?(其余地区)?$')


def load_unit_names():
    out = {}
    if UNIT_NAMES.exists():
        for line in UNIT_NAMES.read_text(encoding='utf-8').splitlines():
            if not line.strip() or line.startswith('#'):
                continue
            c = line.split('\t')
            out[c[0].strip()] = ((c[1].strip() if len(c) > 1 else ''), (c[2].strip() if len(c) > 2 else ''))
    return out


def fix_names(props, table, parent_zh=None):
    """Clean one unit's name / name_zh in place; True when something changed."""
    uid = props.get('id') or ''
    old = (props.get('name'), props.get('name_zh'))
    n = re.sub(r'\s+', ' ', props.get('name') or '').strip()
    if uid.startswith('NO-'):
        n = re.sub(r' nor$', '', n)                       # geoBoundaries NO: 'Oslo nor'
    if uid.startswith('SG-') and n.isupper():
        n = n.title()                                      # URA planning areas: 'DOWNTOWN CORE'
    props['name'] = n
    z = props.get('name_zh') or ''
    m = _ZH_FIX_RE.match(z) if z else None
    if m and m.group(1) in ZH_FIX:
        props['name_zh'] = ZH_FIX[m.group(1)] + (m.group(2) or '') + (m.group(3) or '')
    if uid in table:
        zh, en = table[uid]
        if zh:
            props['name_zh'] = zh
        if en:
            props['name'] = en
    if uid.endswith('-rest') and parent_zh and (not props.get('name_zh') or props['name_zh'].endswith('其余地区')) \
            and uid not in table:
        props['name_zh'] = parent_zh.split('（')[0] + '其余地区' if '（' in parent_zh else parent_zh + '其余地区'
    return (props.get('name'), props.get('name_zh')) != old


def names_pass(ccs=None):
    """Apply tables/unit_names.tsv + the clean-ups of fix_names() to the finished admin2 / admin3 files."""
    table = load_unit_names()
    changed = {}
    zh2 = {}
    for cc, *_ in PLAN:
        f = OUT2 / f'{cc}.json'
        if not f.exists() or (ccs and cc not in ccs):
            if f.exists():
                for g in read_json(f)['objects'][OBJECT]['geometries']:
                    zh2[g['id']] = g['properties'].get('name_zh') or ''
            continue
        topo = read_json(f)
        n = 0
        for g in topo['objects'][OBJECT]['geometries']:
            n += fix_names(g['properties'], table)
            zh2[g['id']] = g['properties'].get('name_zh') or ''
        if n:
            write_json(f, topo)
            changed[f'admin2/{f.name}'] = n
    i3 = read_json(OUT3 / 'index.json') if (OUT3 / 'index.json').exists() else {}
    for key, v in i3.items():
        if ccs and v.get('cc') not in ccs:
            continue
        f = OUT3 / v['file']
        topo = read_json(f)
        n = 0
        for g in topo['objects'][OBJECT]['geometries']:
            n += fix_names(g['properties'], table, zh2.get(g['properties'].get('a2')))
        if n:
            write_json(f, topo)
            changed[f'admin3/{f.name}'] = n
    if changed:
        write_index(2)
        write_index(3)
    log(f'names pass: {sum(changed.values())} units renamed in {len(changed)} files ' + json.dumps(changed, ensure_ascii=False))
    return changed


# ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────
def check_all(cap2=CAP2_KB, cap3=CAP3_KB, total=TOTAL_KB):
    f2 = sorted(p for p in OUT2.glob('*.json') if p.name != 'index.json')
    f3 = sorted(p for p in OUT3.glob('*.json') if p.name != 'index.json')
    e2, _ = validate(f2, cap2, 2)
    e3, _ = validate(f3, cap3, 3)
    errs = e2 + e3
    tot = sum(p.stat().st_size for p in f2 + f3)
    if tot > total * 1000:
        errs.append(f'total {tot / 1e6:.1f} MB > {total / 1000:.0f} MB')
    # admin3 parents must exist in admin2 and carry the same a1
    for p in f3:
        t = read_json(p)
        cc = (t.get('meta') or {}).get('cc')
        par = {g['id']: g['properties'] for g in read_json(OUT2 / f'{cc}.json')['objects'][OBJECT]['geometries']} \
            if cc and (OUT2 / f'{cc}.json').exists() else {}
        for g in t['objects'][OBJECT]['geometries']:
            a2 = g['properties'].get('a2')
            if a2 not in par:
                errs.append(f'admin3/{p.name}/{g["id"]}: parent {a2} not in admin2/{cc}.json')
                break
    return errs, tot, len(f2), len(f3)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--countries', help='comma-separated ISO2 list (default: all, in priority order)')
    ap.add_argument('--level', choices=['2', '3', 'both'], default='both')
    ap.add_argument('--units-only', action='store_true', help='only rebuild web/data/geo/units.json + report')
    ap.add_argument('--no-units', action='store_true', help='do not rebuild units.json at the end')
    ap.add_argument('--check', action='store_true', help='only validate the files on disk')
    ap.add_argument('--cap2', type=int, default=CAP2_KB)
    ap.add_argument('--cap3', type=int, default=CAP3_KB)
    ap.add_argument('--zh-pass', action='store_true', help='only fill Chinese names in the finished files (Wikidata)')
    ap.add_argument('--a1-pass', action='store_true', help='only fill missing a1 codes (Natural Earth admin-1)')
    ap.add_argument('--fetch-addresses', action='store_true',
                    help='fetch missing street addresses first (network): cninfo 办公地址 of every A-share, Census '
                         'geocodes of every US HQ; then units.json')
    ap.add_argument('--names-pass', action='store_true',
                    help='only apply tables/unit_names.tsv + name clean-ups to the finished files (then units.json)')
    ap.add_argument('--wikidata', type=int, default=None,
                    help='allow up to N live Wikidata label queries (Chinese names; cached; default: cache only)')
    a = ap.parse_args()
    if a.wikidata is not None:
        _WD_BUDGET[0] = a.wikidata
    if a.check:
        errs, tot, n2, n3 = check_all(a.cap2, a.cap3)
        if errs:
            log('VALIDATION FAILED:\n  ' + '\n  '.join(errs))
            raise SystemExit(1)
        log(f'ok: {n2} admin2 + {n3} admin3 files valid, {tot / 1e6:.1f} MB')
        return
    ccs = [c.strip().upper() for c in a.countries.split(',')] if a.countries else [p[0] for p in PLAN]
    bad = [c for c in ccs if c not in PLAN_BY]
    if bad:
        raise SystemExit(f'unknown / unplanned countries: {bad}')
    if a.zh_pass:
        zh_pass(set(ccs) if a.countries else None)
        return
    if a.a1_pass:
        a1_pass(set(ccs) if a.countries else None)
        return
    if a.names_pass:
        names_pass(set(ccs) if a.countries else None)
        a.units_only = True
    if a.fetch_addresses:
        fetch_addresses()
        a.units_only = True
    rep = read_json(REPORT) if REPORT.exists() else {}
    if not a.units_only:
        for cc in ccs:
            try:
                if a.level in ('2', 'both'):
                    r = build_admin2(cc, a.cap2)
                    if r:
                        rep.setdefault('admin2', {})[cc] = r
                if a.level in ('3', 'both') and (OUT2 / f'{cc}.json').exists():
                    for r in build_admin3_country(cc):
                        rep.setdefault('admin3', {})[r['key']] = r
            except SystemExit as e:
                log(f'{cc}: FAILED — {str(e)[:800]}')
                rep.setdefault('failed', {})[cc] = str(e)[:400]
            write_json(REPORT, rep, compact=False)
        names_pass(set(ccs))   # hand names + clean-ups survive every rebuild
    if not a.no_units:
        rep['units'] = build_units()
        # file summary straight from the indexes (several partial runs may have written the report)
        i2 = read_json(OUT2 / 'index.json') if (OUT2 / 'index.json').exists() else {}
        i3 = read_json(OUT3 / 'index.json') if (OUT3 / 'index.json').exists() else {}
        rep['files'] = {
            'admin2': {cc: {k: v.get(k) for k in ('units', 'bytes', 'simplify_m', 'name_zh', 'source')} for cc, v in i2.items()},
            'admin3': {k: {kk: v.get(kk) for kk in ('cc', 'units', 'bytes', 'simplify_m', 'name_zh')} for k, v in i3.items()},
            'admin2_bytes': sum(v['bytes'] for v in i2.values()), 'admin3_bytes': sum(v['bytes'] for v in i3.values())}
        write_json(REPORT, rep, compact=False)
    errs, tot, n2, n3 = check_all(a.cap2, a.cap3)
    log(f'{n2} admin2 + {n3} admin3 files, {tot / 1e6:.1f} MB' + ('' if not errs else '\nVALIDATION:\n  ' + '\n  '.join(errs)))


if __name__ == '__main__':
    main()
