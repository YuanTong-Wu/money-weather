#!/usr/bin/env python3
"""build_silhouettes.py — real continent & island outlines for the 抽象 map (DESIGN §26 B).

Reads the vendored world-atlas TopoJSON (web/vendor/geo/countries-10m.json, land-10m.json) and writes
web/js/geo/silhouette-lib.json: ~90 recognisable real landmasses (6 continents + named islands), each as a
north-up outline in local Lambert azimuthal equal-area coordinates around its own centroid (so the true
relative shape is kept: equal-area, north up, no stretching), normalised to area pi (equivalent radius 1).

  continents are assembled from countries (country borders cancel out, the Caspian stays a lake):
    Eurasia (everything not in Africa / the Americas), Africa, North America (Canada…Panama),
    South America (Colombia…Argentina + French Guiana), Australia, Greenland; Antarctica is excluded.
  islands are picked from the land layer by a point inside them (Borneo, New Guinea, Hispaniola, Ireland,
    Timor, Tierra del Fuego are whole even though countries share them).
  regions (Europe, Japan, New Zealand, British Isles, Italy, Denmark, Philippines) keep several parts in their real
    relative positions; country outlines (USA, China, India, Korea, France, …: mainland) are only used for children
    whose name says that geography (美股 → USA, 印度 → India …).

Output (compact JSON):
  {"v": 1, "src": "...", "unit": "...", "shapes": [
     {"id": "honshu", "name": "Honshu", "zh": "本州", "kind": "island",
      "km2": 227960, "sr": 0.005616, "c": [lon, lat],            # real area and centroid
      "core": [x, y],                                             # a point well inside the main part
      "d": 2.31,                                                  # diameter (farthest two coast points), same units
      "reg": "asia",                                              # americas | europe | africa | asia | oceania | eurasia
      "has": ["c-china", …],                                      # shapes whose real centroid or core lies inside
                                                                  #   this one's real coast (Eurasia has China, Europe
                                                                  #   has Great Britain, Honshu and Japan have each other)
      "parts": [[[x0, y0, x1, y1, …], …], …]}                      # per part: coast, then lakes (holes)
  ]}
Coordinates: x east, y north, integers in units of 1e-4 of the equivalent radius (shape area = pi).
Outer rings are counter-clockwise in (x east, y north) (positive shoelace), holes clockwise.

`d`, `reg` and `has` let the 抽象 map size a shape by its reach (no silhouette wider than ~55° of arc) and keep one
planet's geography consistent (no Eurasia beside China, no North America beside the USA; a Europe planet's sectors
get European islands): web/js/geo/silhouettes.js.

Usage: python3 geodata/build_silhouettes.py [--out path]   (stdlib only; ~15 s)
"""
import json
import math
import os
import sys

ROOT = os.environ.get('MW_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, 'web', 'vendor', 'geo')
OUT = os.path.join(ROOT, 'web', 'js', 'geo', 'silhouette-lib.json')
R_EARTH_KM = 6371.0088

# ------------------------------------------------------------------------------------------- continents
AFRICA = {
    'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon',
    'Central African Rep.', 'Chad', 'Comoros', 'Congo', "Côte d'Ivoire", 'Dem. Rep. Congo', 'Djibouti', 'Egypt',
    'Eq. Guinea', 'Eritrea', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea', 'Guinea-Bissau', 'Kenya', 'Lesotho',
    'Liberia', 'Libya', 'Madagascar', 'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique',
    'Namibia', 'Niger', 'Nigeria', 'Rwanda', 'S. Sudan', 'Saint Helena', 'Senegal', 'Seychelles', 'Sierra Leone',
    'Somalia', 'Somaliland', 'South Africa', 'Sudan', 'São Tomé and Principe', 'Tanzania', 'Togo', 'Tunisia',
    'Uganda', 'W. Sahara', 'Zambia', 'Zimbabwe', 'eSwatini',
}
NORTH_AMERICA = {
    'Canada', 'United States of America', 'Mexico', 'Guatemala', 'Belize', 'Honduras', 'El Salvador', 'Nicaragua',
    'Costa Rica', 'Panama',
}
SOUTH_AMERICA = {
    'Colombia', 'Venezuela', 'Guyana', 'Suriname', 'France', 'Brazil', 'Ecuador', 'Peru', 'Bolivia', 'Paraguay',
    'Chile', 'Argentina', 'Uruguay',
}
NOT_EURASIA = AFRICA | NORTH_AMERICA | (SOUTH_AMERICA - {'France'}) | {'Antarctica'}

# (id, English, 中文, kind, source, pick [lon, lat])
#   source: 'land' (land-10m) or a set name for a country merge
SPECS = [
    ('eurasia', 'Eurasia', '欧亚大陆', 'continent', 'eurasia', (90, 50)),
    ('africa', 'Africa', '非洲', 'continent', 'africa', (20, 5)),
    ('north-america', 'North America', '北美洲', 'continent', 'north-america', (-100, 45)),
    ('south-america', 'South America', '南美洲', 'continent', 'south-america', (-60, -15)),
    ('australia', 'Australia', '澳大利亚', 'continent', 'land', (134, -25)),
    ('greenland', 'Greenland', '格陵兰', 'continent', 'land', (-41, 74)),
    # islands (largest first, roughly)
    ('new-guinea', 'New Guinea', '新几内亚岛', 'island', 'land', (142, -5)),
    ('borneo', 'Borneo', '婆罗洲', 'island', 'land', (114, 1)),
    ('madagascar', 'Madagascar', '马达加斯加岛', 'island', 'land', (46.8, -19)),
    ('baffin', 'Baffin Island', '巴芬岛', 'island', 'land', (-73, 70)),
    ('sumatra', 'Sumatra', '苏门答腊岛', 'island', 'land', (101.5, 0)),
    ('honshu', 'Honshu', '本州岛', 'island', 'land', (138.5, 36.2)),
    ('victoria-island', 'Victoria Island', '维多利亚岛', 'island', 'land', (-110, 71)),
    ('great-britain', 'Great Britain', '大不列颠岛', 'island', 'land', (-2, 53)),
    ('ellesmere', 'Ellesmere Island', '埃尔斯米尔岛', 'island', 'land', (-80, 80)),
    ('sulawesi', 'Sulawesi', '苏拉威西岛', 'island', 'land', (120.0, -4.5)),
    ('south-island-nz', 'South Island (NZ)', '新西兰南岛', 'island', 'land', (170.5, -44)),
    ('java', 'Java', '爪哇岛', 'island', 'land', (110, -7.3)),
    ('north-island-nz', 'North Island (NZ)', '新西兰北岛', 'island', 'land', (175.8, -38.8)),
    ('luzon', 'Luzon', '吕宋岛', 'island', 'land', (121.0, 16.5)),
    ('newfoundland', 'Newfoundland', '纽芬兰岛', 'island', 'land', (-56, 48.8)),
    ('cuba', 'Cuba', '古巴岛', 'island', 'land', (-78.5, 21.7)),
    ('iceland', 'Iceland', '冰岛', 'island', 'land', (-19, 65)),
    ('mindanao', 'Mindanao', '棉兰老岛', 'island', 'land', (125, 7.8)),
    ('ireland', 'Ireland', '爱尔兰岛', 'island', 'land', (-8, 53.3)),
    ('hokkaido', 'Hokkaido', '北海道', 'island', 'land', (143, 43.5)),
    ('hispaniola', 'Hispaniola', '伊斯帕尼奥拉岛', 'island', 'land', (-71, 19)),
    ('sakhalin', 'Sakhalin', '库页岛', 'island', 'land', (142.8, 50)),
    ('banks-island', 'Banks Island', '班克斯岛', 'island', 'land', (-121.5, 72.8)),
    ('sri-lanka', 'Sri Lanka', '斯里兰卡岛', 'island', 'land', (80.7, 7.8)),
    ('tasmania', 'Tasmania', '塔斯马尼亚岛', 'island', 'land', (146.5, -42)),
    ('devon-island', 'Devon Island', '德文岛', 'island', 'land', (-87, 75.4)),
    ('novaya-zemlya-n', 'Novaya Zemlya (north)', '新地岛北岛', 'island', 'land', (59, 75)),
    ('tierra-del-fuego', 'Tierra del Fuego', '火地岛', 'island', 'land', (-68.5, -54)),
    ('southampton', 'Southampton Island', '南安普敦岛', 'island', 'land', (-84, 64.3)),
    ('melville-island-ca', 'Melville Island', '梅尔维尔岛', 'island', 'land', (-110, 75.5)),
    ('axel-heiberg', 'Axel Heiberg Island', '阿克塞尔海伯格岛', 'island', 'land', (-91, 79.5)),
    ('spitsbergen', 'Spitsbergen', '斯匹次卑尔根岛', 'island', 'land', (16, 78.7)),
    ('new-britain', 'New Britain', '新不列颠岛', 'island', 'land', (150.5, -5.6)),
    ('taiwan', 'Taiwan', '台湾岛', 'island', 'land', (121, 23.7)),
    ('kyushu', 'Kyushu', '九州岛', 'island', 'land', (131, 32.6)),
    ('hainan', 'Hainan', '海南岛', 'island', 'land', (109.7, 19.2)),
    ('prince-of-wales-ca', 'Prince of Wales Island', '威尔士亲王岛', 'island', 'land', (-99, 72.5)),
    ('novaya-zemlya-s', 'Novaya Zemlya (south)', '新地岛南岛', 'island', 'land', (54, 71.5)),
    ('vancouver-island', 'Vancouver Island', '温哥华岛', 'island', 'land', (-125.6, 49.7)),
    ('timor', 'Timor', '帝汶岛', 'island', 'land', (125.5, -9)),
    ('sicily', 'Sicily', '西西里岛', 'island', 'land', (14, 37.5)),
    ('somerset-island', 'Somerset Island', '萨默塞特岛', 'island', 'land', (-93.5, 73)),
    ('sardinia', 'Sardinia', '撒丁岛', 'island', 'land', (9, 40)),
    ('shikoku', 'Shikoku', '四国岛', 'island', 'land', (133.5, 33.7)),
    ('halmahera', 'Halmahera', '哈马黑拉岛', 'island', 'land', (127.9, 1.2)),
    ('seram', 'Seram', '斯兰岛', 'island', 'land', (129.5, -3.2)),
    ('new-caledonia', 'New Caledonia', '新喀里多尼亚岛', 'island', 'land', (165.5, -21.3)),
    ('sumbawa', 'Sumbawa', '松巴哇岛', 'island', 'land', (117.8, -8.6)),
    ('flores', 'Flores', '弗洛勒斯岛', 'island', 'land', (121, -8.6)),
    ('samar', 'Samar', '萨马岛', 'island', 'land', (125, 11.8)),
    ('negros', 'Negros', '内格罗斯岛', 'island', 'land', (123, 10.2)),
    ('palawan', 'Palawan', '巴拉望岛', 'island', 'land', (118.5, 9.5)),
    ('panay', 'Panay', '班乃岛', 'island', 'land', (122.5, 11.1)),
    ('jamaica', 'Jamaica', '牙买加岛', 'island', 'land', (-77.3, 18.1)),
    ('kodiak', 'Kodiak Island', '科迪亚克岛', 'island', 'land', (-153.5, 57.5)),
    ('mindoro', 'Mindoro', '民都洛岛', 'island', 'land', (121, 13)),
    ('hawaii', 'Hawaiʻi (Big Island)', '夏威夷大岛', 'island', 'land', (-155.5, 19.6)),
    ('viti-levu', 'Viti Levu', '维提岛', 'island', 'land', (178, -17.8)),
    ('cape-breton', 'Cape Breton Island', '布雷顿角岛', 'island', 'land', (-60.8, 46.2)),
    ('bougainville', 'Bougainville', '布干维尔岛', 'island', 'land', (155.3, -6.2)),
    ('cyprus', 'Cyprus', '塞浦路斯岛', 'island', 'land', (33, 35)),
    ('puerto-rico', 'Puerto Rico', '波多黎各岛', 'island', 'land', (-66.5, 18.2)),
    ('corsica', 'Corsica', '科西嘉岛', 'island', 'land', (9.1, 42.1)),
    ('chiloe', 'Chiloé', '奇洛埃岛', 'island', 'land', (-73.9, -42.6)),
    ('crete', 'Crete', '克里特岛', 'island', 'land', (24.9, 35.2)),
    ('anticosti', 'Anticosti', '安蒂科斯蒂岛', 'island', 'land', (-63, 49.4)),
    ('zealand-dk', 'Zealand', '西兰岛', 'island', 'land', (11.8, 55.5)),
    ('graham-island', 'Graham Island (Haida Gwaii)', '格雷厄姆岛', 'island', 'land', (-132.5, 53.6)),
    ('bali', 'Bali', '巴厘岛', 'island', 'land', (115.1, -8.4)),
    ('prince-edward', 'Prince Edward Island', '爱德华王子岛', 'island', 'land', (-63.3, 46.4)),
    ('east-falkland', 'East Falkland', '东福克兰岛', 'island', 'land', (-58.7, -51.7)),
    ('trinidad', 'Trinidad', '特立尼达岛', 'island', 'land', (-61.3, 10.4)),
    ('kangaroo-island', 'Kangaroo Island', '袋鼠岛', 'island', 'land', (137.2, -35.8)),
    ('mallorca', 'Mallorca', '马略卡岛', 'island', 'land', (2.95, 39.6)),
    ('socotra', 'Socotra', '索科特拉岛', 'island', 'land', (53.9, 12.5)),
    ('long-island', 'Long Island', '长岛', 'island', 'land', (-73, 40.8)),
    ('south-georgia', 'South Georgia', '南乔治亚岛', 'island', 'land', (-36.5, -54.3)),
    ('gotland', 'Gotland', '哥得兰岛', 'island', 'land', (18.5, 57.5)),
    ('reunion', 'Réunion', '留尼汪岛', 'island', 'land', (55.5, -21.1)),
    ('bioko', 'Bioko', '比奥科岛', 'island', 'land', (8.7, 3.5)),
    ('jeju', 'Jeju', '济州岛', 'island', 'land', (126.5, 33.4)),
    ('mauritius', 'Mauritius', '毛里求斯岛', 'island', 'land', (57.6, -20.3)),
    ('okinawa', 'Okinawa', '冲绳岛', 'island', 'land', (127.9, 26.5)),
    ('isle-of-man', 'Isle of Man', '马恩岛', 'island', 'land', (-4.5, 54.2)),
    ('zanzibar', 'Zanzibar (Unguja)', '桑给巴尔岛', 'island', 'land', (39.35, -6.1)),
]


EUROPE = {
    'Albania', 'Andorra', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herz.', 'Bulgaria', 'Croatia', 'Czechia', 'Denmark',
    'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Italy', 'Kosovo', 'Latvia', 'Liechtenstein', 'Lithuania',
    'Luxembourg', 'Macedonia', 'Moldova', 'Monaco', 'Montenegro', 'Netherlands', 'Norway', 'Poland', 'Portugal', 'Romania',
    'San Marino', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine', 'Vatican', 'Gibraltar',
}

# multi-part shapes: (id, English, 中文, kind, [(source, (lon, lat)), …]) — the first part is the main one
MULTI = [
    ('europe', 'Europe', '欧洲', 'region', [('europe', (10, 50)), ('europe', (16, 62)), ('land', (-2, 53)), ('land', (-8, 53.3)),
                                         ('land', (14, 37.5)), ('land', (9, 40)), ('land', (9.1, 42.1)), ('land', (24.9, 35.2))]),
    ('japan', 'Japan', '日本列岛', 'region', [('land', (138.5, 36.2)), ('land', (143, 43.5)), ('land', (131, 32.6)), ('land', (133.5, 33.7))]),
    ('new-zealand', 'New Zealand', '新西兰', 'region', [('land', (175.8, -38.8)), ('land', (170.5, -44))]),
    ('british-isles', 'British Isles', '不列颠群岛', 'region', [('land', (-2, 53)), ('land', (-8, 53.3))]),
    ('italy', 'Italy', '意大利', 'country', [('country:Italy', (12.5, 42.5)), ('land', (14, 37.5)), ('land', (9, 40))]),
    ('denmark', 'Denmark', '丹麦', 'country', [('country:Denmark', (9.2, 56.2)), ('land', (11.8, 55.5)), ('land', (10.4, 55.3))]),
    ('philippines', 'Philippines', '菲律宾', 'country', [('land', (121.0, 16.5)), ('land', (125, 7.8)), ('land', (125, 11.8)),
                                                       ('land', (123, 10.2)), ('land', (122.5, 11.1)), ('land', (118.5, 9.5)), ('land', (121, 13))]),
]
# single country outlines (mainland): (id, English, 中文, country name in world-atlas, pick)
COUNTRIES = [
    ('c-usa', 'United States', '美国', 'United States of America', (-100, 40)),
    ('c-china', 'China', '中国', 'China', (100, 35)),
    ('c-india', 'India', '印度', 'India', (79, 22)),
    ('c-south-korea', 'South Korea', '韩国', 'South Korea', (128, 36.5)),
    ('c-hong-kong', 'Hong Kong', '香港', 'Hong Kong', (114.15, 22.42)),
    ('c-canada', 'Canada', '加拿大', 'Canada', (-100, 58)),
    ('c-brazil', 'Brazil', '巴西', 'Brazil', (-52, -10)),
    ('c-mexico', 'Mexico', '墨西哥', 'Mexico', (-102, 23)),
    ('c-france', 'France', '法国', 'France', (2.5, 46.5)),
    ('c-germany', 'Germany', '德国', 'Germany', (10.4, 51)),
    ('c-switzerland', 'Switzerland', '瑞士', 'Switzerland', (8.2, 46.8)),
    ('c-netherlands', 'Netherlands', '荷兰', 'Netherlands', (5.6, 52.2)),
    ('c-sweden', 'Sweden', '瑞典', 'Sweden', (15, 62)),
    ('c-norway', 'Norway', '挪威', 'Norway', (9, 61)),
    ('c-finland', 'Finland', '芬兰', 'Finland', (26, 63)),
    ('c-spain', 'Spain', '西班牙', 'Spain', (-3.7, 40.2)),
    ('c-saudi-arabia', 'Saudi Arabia', '沙特', 'Saudi Arabia', (45, 24)),
    ('c-south-africa', 'South Africa', '南非', 'South Africa', (24, -29)),
    ('c-russia', 'Russia', '俄罗斯', 'Russia', (90, 60)),
    ('c-turkey', 'Turkey', '土耳其', 'Turkey', (35, 39)),
    ('c-vietnam', 'Vietnam', '越南', 'Vietnam', (106, 16)),
    ('c-thailand', 'Thailand', '泰国', 'Thailand', (101, 15)),
    ('c-argentina', 'Argentina', '阿根廷', 'Argentina', (-64, -34)),
    ('c-israel', 'Israel', '以色列', 'Israel', (35, 31.3)),
    ('c-poland', 'Poland', '波兰', 'Poland', (19, 52)),
    ('c-singapore', 'Singapore', '新加坡', 'Singapore', (103.82, 1.35)),
]

# ------------------------------------------------------------------------------------------- topojson
def load_topo(name):
    with open(os.path.join(VENDOR, name), encoding='utf-8') as f:
        t = json.load(f)
    tr = t.get('transform')
    arcs = []
    for arc in t['arcs']:
        pts = []
        if tr:
            (sx, sy), (tx, ty) = tr['scale'], tr['translate']
            x = y = 0
            for p in arc:
                x += p[0]
                y += p[1]
                pts.append((x * sx + tx, y * sy + ty))
        else:
            pts = [(p[0], p[1]) for p in arc]
        arcs.append(pts)
    return t, arcs


def ring_of(idx_list, arcs):
    pts = []
    for i in idx_list:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(a[1:] if pts else a)
    return pts


def polygons_of(geom, arcs):
    """→ list of polygons, each a list of rings (lists of (lon, lat))."""
    t = geom.get('type')
    if t == 'Polygon':
        return [[ring_of(r, arcs) for r in geom['arcs']]]
    if t == 'MultiPolygon':
        return [[ring_of(r, arcs) for r in p] for p in geom['arcs']]
    return []


# ------------------------------------------------------------------------------------------- planar helpers
def shoelace(r):
    a = 0.0
    n = len(r)
    for i in range(n):
        x0, y0 = r[i]
        x1, y1 = r[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return a / 2


def bbox(r):
    xs = [p[0] for p in r]
    ys = [p[1] for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def pip(r, x, y):
    inside = False
    n = len(r)
    j = n - 1
    for i in range(n):
        xi, yi = r[i]
        xj, yj = r[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# ------------------------------------------------------------------------------------------- merge
def merge_rings(rings):
    """Union of polygons that share exact boundary points: cancel opposite segments, stitch what is left."""
    key = lambda p: (round(p[0], 6), round(p[1], 6))
    segs = {}
    for r in rings:
        n = len(r)
        if n < 3:
            continue
        pts = [key(p) for p in r]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            if a == b:
                continue
            if (b, a) in segs:
                segs[(b, a)] -= 1
                if segs[(b, a)] == 0:
                    del segs[(b, a)]
            else:
                segs[(a, b)] = segs.get((a, b), 0) + 1
    nxt = {}
    for (a, b), c in segs.items():
        for _ in range(c):
            nxt.setdefault(a, []).append(b)
    out = []
    for start in list(nxt.keys()):
        while nxt.get(start):
            ring = [start]
            cur = nxt[start].pop()
            guard = 0
            while cur != start and guard < 5_000_000:
                ring.append(cur)
                lst = nxt.get(cur)
                if not lst:
                    break
                cur = lst.pop()
                guard += 1
            if cur == start and len(ring) >= 3:
                out.append(ring)
    return out


# ------------------------------------------------------------------------------------------- sphere
def vec(lon, lat):
    a, b = math.radians(lon), math.radians(lat)
    c = math.cos(b)
    return (c * math.sin(a), math.sin(b), c * math.cos(a))  # x east @ lon 90, y north, z @ lon 0 (as islands.js)


def lonlat(v):
    l = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1
    return math.degrees(math.atan2(v[0], v[2])), math.degrees(math.asin(max(-1, min(1, v[1] / l))))


def frame(c):
    e = (c[2], 0.0, -c[0])
    l = math.hypot(e[0], e[2])
    e = (1.0, 0.0, 0.0) if l < 1e-9 else (e[0] / l, 0.0, e[2] / l)
    n = (c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0])
    nl = math.sqrt(sum(x * x for x in n))
    return e, (n[0] / nl, n[1] / nl, n[2] / nl)


def laea(c, e, n, p):
    d = p[0] * c[0] + p[1] * c[1] + p[2] * c[2]
    k = math.sqrt(2 / max(1e-9, 1 + d))
    return (k * (p[0] * e[0] + p[1] * e[1] + p[2] * e[2]), k * (p[0] * n[0] + p[1] * n[1] + p[2] * n[2]))


def inv_laea(c, e, n, x, y):
    rho = math.hypot(x, y)
    if rho < 1e-12:
        return c
    cc = 2 * math.asin(min(1, rho / 2))
    s, k = math.sin(cc) / rho, math.cos(cc)
    v = tuple(k * c[i] + s * (x * e[i] + y * n[i]) for i in range(3))
    l = math.sqrt(sum(t * t for t in v))
    return tuple(t / l for t in v)


def planar_centroid(r):
    a = cx = cy = 0.0
    n = len(r)
    for i in range(n):
        x0, y0 = r[i]
        x1, y1 = r[(i + 1) % n]
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if abs(a) < 1e-15:
        return 0.0, 0.0
    return cx / (3 * a), cy / (3 * a)


def douglas_peucker(pts, tol):
    """Closed ring simplification: split at the two farthest-apart vertices, DP each half (iterative)."""
    n = len(pts)
    if n < 8:
        return pts
    i0 = 0
    i1 = max(range(n), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    keep = [False] * n
    keep[i0] = keep[i1] = True
    t2 = tol * tol

    def dp(a, b):
        stack = [(a, b)]
        while stack:
            a, b = stack.pop()
            ax, ay = pts[a % n]
            bx, by = pts[b % n]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            best, bi = -1.0, -1
            for i in range(a + 1, b):
                px, py = pts[i % n]
                if L2 < 1e-30:
                    d2 = (px - ax) ** 2 + (py - ay) ** 2
                else:
                    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                    d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
                if d2 > best:
                    best, bi = d2, i
            if best > t2:
                keep[bi % n] = True
                stack.append((a, bi))
                stack.append((bi, b))

    dp(i0, i1)
    dp(i1, n + i0)
    return [pts[i] for i in range(n) if keep[i]]



def core_point(ring):
    """An interior point far from the coast (≈ pole of inaccessibility on a grid): where a label or a containment
    test can stand even for a crescent-shaped island whose centroid is at sea."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    n = len(ring)
    segs = [(ring[i], ring[(i + 1) % n]) for i in range(n)]

    def dist(x, y):
        best = 1e18
        for (ax, ay), (bx, by) in segs:
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 < 1e-18 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
            d = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2
            if d < best:
                best = d
        return best

    best, bp = -1.0, (0.0, 0.0)
    G = 28
    for gy in range(G):
        y = y0 + (gy + 0.5) * (y1 - y0) / G
        for gx in range(G):
            x = x0 + (gx + 0.5) * (x1 - x0) / G
            if not pip(ring, x, y):
                continue
            d = dist(x, y)
            if d > best:
                best, bp = d, (x, y)
    # refine around the best cell
    step = max(x1 - x0, y1 - y0) / G
    for _ in range(3):
        cx, cy = bp
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                x, y = cx + dx * step * 0.5, cy + dy * step * 0.5
                if pip(ring, x, y):
                    d = dist(x, y)
                    if d > best:
                        best, bp = d, (x, y)
        step *= 0.5
    return bp


def region_of(sid, lon, lat):
    """Coarse world region of a real centroid (Eurasia itself spans two)."""
    if sid == 'eurasia':
        return 'eurasia'
    if lon <= -30:
        return 'oceania' if lon < -150 and lat < 30 else 'americas'
    if (lat < -11 and lon >= 100) or (lon >= 130 and lat < 0) or lon >= 160:
        return 'oceania'
    if -30 < lon < 45 and lat >= 35:
        return 'europe'
    if lon < 60 and lat < 35 and not (lon > 34 and lat > 12):
        return 'africa'
    return 'asia'


def hull(pts):
    """Convex hull (monotone chain) of planar points."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def diameter(out_parts):
    """Farthest two coast points of every part (normalised units)."""
    pts = []
    for p in out_parts:
        o = p[0]
        pts.extend((o[k] / 1e4, o[k + 1] / 1e4) for k in range(0, len(o), 2))
    h = hull(pts)
    best = 0.0
    for i in range(len(h)):
        for j in range(i + 1, len(h)):
            d = (h[i][0] - h[j][0]) ** 2 + (h[i][1] - h[j][1]) ** 2
            if d > best:
                best = d
    return math.sqrt(best)


# ------------------------------------------------------------------------------------------- build
def main():
    out_path = OUT
    if '--out' in sys.argv:
        out_path = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])
    t10, arcs10 = load_topo('countries-10m.json')
    countries = t10['objects']['countries']['geometries']
    land_t, land_arcs = load_topo('land-10m.json')
    land_geom = land_t['objects']['land']['geometries'] if 'geometries' in land_t['objects']['land'] else [land_t['objects']['land']]
    land_polys = []
    for g in land_geom:
        land_polys.extend(polygons_of(g, land_arcs))
    print(f'land polygons: {len(land_polys)}', file=sys.stderr)

    def country_rings(names=None, exclude=None, shift_russia=False):
        rings = []
        for g in countries:
            nm = (g.get('properties') or {}).get('name')
            if names is not None and nm not in names:
                continue
            if exclude is not None and nm in exclude:
                continue
            for poly in polygons_of(g, arcs10):
                for r in poly:
                    if shift_russia and nm == 'Russia' and max(p[0] for p in r) < -150:
                        r = [(p[0] + 360, p[1]) for p in r]  # Chukotka east of 180° rejoins the mainland
                    rings.append(r)
        return rings

    merged = {}

    def source_rings(src):
        if src in merged:
            return merged[src]
        if src == 'eurasia':
            rs = merge_rings(country_rings(exclude=NOT_EURASIA, shift_russia=True))
        elif src == 'africa':
            rs = merge_rings(country_rings(names=AFRICA))
        elif src == 'north-america':
            rs = merge_rings(country_rings(names=NORTH_AMERICA))
        elif src == 'south-america':
            rs = merge_rings(country_rings(names=SOUTH_AMERICA))
        elif src == 'europe':
            rs = merge_rings(country_rings(names=EUROPE))
        elif src.startswith('country:'):
            rs = merge_rings(country_rings(names={src[8:]}, shift_russia=True))
        else:
            rs = [r for poly in land_polys for r in poly]
        info = [(r, bbox(r), shoelace(r)) for r in rs if len(r) >= 4]
        merged[src] = info
        print(f'{src}: {len(info)} rings', file=sys.stderr)
        return info

    def pick_ring(src, pick):
        info = source_rings(src)
        x, y = pick
        cont = [it for it in info if it[1][0] <= x <= it[1][2] and it[1][1] <= y <= it[1][3] and pip(it[0], x, y)]
        if cont:
            return min(cont, key=lambda it: abs(it[2])), 'contains', info
        cands = [it for it in info if abs(it[2]) > 0.05] or info
        return min(cands, key=lambda it: ((it[1][0] + it[1][2]) / 2 - x) ** 2 + ((it[1][1] + it[1][3]) / 2 - y) ** 2), 'nearest', info

    def holes_of(outer, info):
        sign = outer[2] > 0
        ob = outer[1]
        out = []
        for it in info:
            if it is outer or (it[2] > 0) == sign:
                continue
            b = it[1]
            if b[0] < ob[0] or b[2] > ob[2] or b[1] < ob[1] or b[3] > ob[3]:
                continue
            if abs(it[2]) < 0.003 * abs(outer[2]):
                continue
            if pip(outer[0], it[0][0][0], it[0][0][1]):
                out.append(it[0])
        return out

    def build(sid, name, zh, kind, parts_spec, used=None):
        parts = []  # [(outer lonlat ring, [holes])]
        hows = []
        for src, pick in parts_spec:
            outer, how, info = pick_ring(src, pick)
            if used is not None:
                if id(outer[0]) in used:
                    print(f'!! {sid}: ring already used by another silhouette, skipped', file=sys.stderr)
                    return None
                used.add(id(outer[0]))
            if any(o is outer[0] for o, _ in parts):
                continue
            parts.append((outer[0], holes_of(outer, info)))
            hows.append(how)
        # sphere: centroid of all parts by iterated LAEA (area-weighted)
        P_parts = [[vec(lo, la) for lo, la in o] for o, _ in parts]
        c = [sum(p[i] for P in P_parts for p in P) for i in range(3)]
        l = math.sqrt(sum(t * t for t in c))
        c = tuple(t / l for t in c)
        for _ in range(5):
            e, n = frame(c)
            ax = ay = aa = 0.0
            for P in P_parts:
                pl = [laea(c, e, n, p) for p in P]
                a = abs(shoelace(pl))
                cx, cy = planar_centroid(pl)
                ax += cx * a
                ay += cy * a
                aa += a
            c = inv_laea(c, e, n, ax / aa, ay / aa)
        e, n = frame(c)
        planar = []
        sr = 0.0
        for (o, hs), P in zip(parts, P_parts):
            op = [laea(c, e, n, p) for p in P]
            if shoelace(op) < 0:
                op.reverse()
            hp = []
            for h in hs:
                q = [laea(c, e, n, vec(lo, la)) for lo, la in h]
                if shoelace(q) > 0:
                    q.reverse()
                hp.append(q)
            sr += abs(shoelace(op)) - sum(abs(shoelace(q)) for q in hp)
            planar.append([op] + hp)
        qk = math.sqrt(math.pi / sr)  # → area pi
        # relative detail (equivalent radius 1): ~1.5 px at the biggest drawn sizes; fjord coasts get coarser until
        # they fit a point budget (a clean paper-cut edge, not a fractal)
        cap = 520 if kind in ('continent', 'region') else 300
        tol = 0.0085
        while True:
            out_parts = []
            npts = 0
            for pi_, rings in enumerate(planar):
                out_rings = []
                for ri, r in enumerate(rings):
                    rn = [(px * qk, py * qk) for px, py in r]
                    rs = douglas_peucker(rn, tol)
                    if len(rs) < 4:
                        continue
                    if ri == 0 and pi_ > 0 and abs(shoelace(rs)) < 0.004 * math.pi:
                        break  # a tiny extra part: drop it
                    if ri > 0 and abs(shoelace(rs)) < 0.004 * math.pi:
                        continue
                    flat = []
                    for px, py in rs:
                        flat.extend([int(round(px * 1e4)), int(round(py * 1e4))])
                    out_rings.append(flat)
                    npts += len(rs)
                if out_rings:
                    out_parts.append(out_rings)
            if npts <= cap or tol > 0.03:
                break
            tol *= 1.2
        km2 = sr * R_EARTH_KM ** 2
        clon, clat = lonlat(c)
        print(f'{sid:22s} {",".join(sorted(set(hows))):8s} {km2:12,.0f} km²  parts={len(out_parts)} pts={npts:4d}', file=sys.stderr)
        main = out_parts[0][0]
        cx, cy = core_point([(main[k] / 1e4, main[k + 1] / 1e4) for k in range(0, len(main), 2)])
        # the real geometry (normalised rings + the frame) for the containment test after every shape is built
        geom[sid] = (c, e, n, qk, [[[(r[k] / 1e4, r[k + 1] / 1e4) for k in range(0, len(r), 2)] for r in part] for part in out_parts],
                     inv_laea(c, e, n, cx / qk, cy / qk))
        return {
            'id': sid, 'name': name, 'zh': zh, 'kind': kind,
            'km2': int(round(km2)), 'sr': round(sr, 7), 'c': [round(clon, 3), round(clat, 3)],
            'core': [round(cx, 4), round(cy, 4)],
            'd': round(diameter(out_parts), 4),
            'reg': region_of(sid, clon, clat),
            'parts': out_parts,
        }

    shapes = []
    geom = {}
    used = set()
    for sid, name, zh, kind, src, pick in SPECS:
        sh = build(sid, name, zh, kind, [(src, pick)], used)
        if sh:
            shapes.append(sh)
    for sid, name, zh, kind, parts_spec in MULTI:
        sh = build(sid, name, zh, kind, parts_spec)
        if sh:
            shapes.append(sh)
    for sid, name, zh, cname, pick in COUNTRIES:
        sh = build(sid, name, zh, 'country', [('country:' + cname, pick)])
        if sh:
            shapes.append(sh)

    # geographic containment: B's real centroid or core inside A's real coast (any part, not in a lake)
    def inside(a, p):
        c, e, n, qk, parts, _ = geom[a]
        if p[0] * c[0] + p[1] * c[1] + p[2] * c[2] <= 0.05:
            return False
        x, y = laea(c, e, n, p)
        x, y = x * qk, y * qk
        for part in parts:
            o = part[0]
            xs = [q[0] for q in o]
            ys = [q[1] for q in o]
            if x < min(xs) or x > max(xs) or y < min(ys) or y > max(ys) or not pip(o, x, y):
                continue
            if not any(pip(h, x, y) for h in part[1:]):
                return True
        return False
    for A in shapes:
        has = []
        for B in shapes:
            if B is A:
                continue
            cb = geom[B['id']][0]
            if inside(A['id'], cb) or inside(A['id'], geom[B['id']][5]):
                has.append(B['id'])
        A['has'] = has
        if has:
            print(f'{A["id"]:22s} has {", ".join(has)}', file=sys.stderr)

    shapes.sort(key=lambda s: ({'continent': 0, 'island': 1, 'region': 2, 'country': 3}.get(s['kind'], 4), -s['sr']))
    lib = {
        'v': 2,
        'src': 'world-atlas countries-10m / land-10m (Natural Earth, public domain); geodata/build_silhouettes.py',
        'unit': 'x east, y north; integers = 1e-4 of the equivalent radius (each shape has area pi); Lambert azimuthal equal-area around the shape centroid; parts = [[coast (ccw), lakes (cw)…], …], part 0 = the main landmass',
        'shapes': shapes,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(lib, f, ensure_ascii=False, separators=(',', ':'))
    print(f'wrote {out_path}: {len(shapes)} shapes, {os.path.getsize(out_path) / 1024:.0f} KB', file=sys.stderr)


if __name__ == '__main__':
    main()
