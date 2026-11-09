"""Keep HQ points on land (geodata/build_hq.py step 'snap').

GeoNames puts a city's point on its historic centre, and for harbour cities that centre is often in the water once
the coastline is drawn at Natural Earth 1:10m / 1:50m (Miami in Biscayne Bay, Xiamen and Shantou in the harbour,
Copenhagen, Stavanger, Camden NJ on the Delaware, lower Manhattan at 1:50m). The map draws an HQ marker exactly
there, so a dot floats in the bay. `LandSnap.snap(lon, lat)` moves such a point onto the nearest land — inside the
1:10m land and, when it costs only a small extra step, also inside the 1:50m land the globe uses at low zoom — as
long as that land is within `max_km` (15 km). Points already on land, or far out at sea, are returned unchanged.

Reads web/vendor/geo/land-10m.json and land-50m.json (world-atlas TopoJSON, quantized) with plain Python + numpy.
"""
import json
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEO = os.path.join(ROOT, 'web', 'vendor', 'geo')
KM_PER_DEG = 111.195


def _decode(path):
    """TopoJSON land object -> list of rings (numpy arrays of [lon, lat]); outer rings and holes alike (the
    even-odd rule below handles holes)."""
    with open(path) as f:
        topo = json.load(f)
    tf = topo.get('transform')
    arcs = []
    for a in topo['arcs']:
        arr = np.array(a, dtype=float)
        if tf:
            arr = np.cumsum(arr, axis=0)
            arr[:, 0] = arr[:, 0] * tf['scale'][0] + tf['translate'][0]
            arr[:, 1] = arr[:, 1] * tf['scale'][1] + tf['translate'][1]
        arcs.append(arr)

    def arc(i):
        return arcs[i] if i >= 0 else arcs[~i][::-1]

    rings = []

    def polygon(p):
        for ring in p:
            pts = []
            for k, i in enumerate(ring):
                a = arc(i)
                pts.append(a if k == 0 else a[1:])
            rings.append(np.vstack(pts))

    def geom(g):
        t = g.get('type')
        if t == 'GeometryCollection':
            for h in g['geometries']:
                geom(h)
        elif t == 'Polygon':
            polygon(g['arcs'])
        elif t == 'MultiPolygon':
            for p in g['arcs']:
                polygon(p)

    geom(topo['objects']['land'])
    return rings


class _Layer:
    def __init__(self, path):
        self.rings = _decode(path)
        self.bbox = np.array([[r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()] for r in self.rings])

    def rings_at(self, lon, lat):
        """Indices of the rings that contain the point."""
        b = self.bbox
        idx = np.nonzero((b[:, 0] <= lon) & (b[:, 2] >= lon) & (b[:, 1] <= lat) & (b[:, 3] >= lat))[0]
        out = []
        for i in idx:
            r = self.rings[i]
            x1, y1 = r[:-1, 0], r[:-1, 1]
            x2, y2 = r[1:, 0], r[1:, 1]
            cond = (y1 > lat) != (y2 > lat)
            with np.errstate(divide='ignore', invalid='ignore'):
                xi = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if (np.count_nonzero(cond & (lon < xi)) % 2) == 1:
                out.append(int(i))
        return out

    def inside(self, lon, lat):
        """Even-odd rule over every ring (holes included)."""
        return len(self.rings_at(lon, lat)) % 2 == 1

    def island(self, lon, lat):
        """The smallest ring holding the point (its island / landmass), or None."""
        rs = self.rings_at(lon, lat)
        if not rs:
            return None
        b = self.bbox
        return min(rs, key=lambda i: (b[i, 2] - b[i, 0]) * (b[i, 3] - b[i, 1]))

    def nearest(self, lon, lat, max_km, k=6):
        """Up to k nearest boundary points within max_km: [(km, plon, plat)], nearest first."""
        dlat = max_km / KM_PER_DEG
        coslat = max(math.cos(math.radians(lat)), 0.05)
        dlon = dlat / coslat
        b = self.bbox
        idx = np.nonzero((b[:, 0] <= lon + dlon) & (b[:, 2] >= lon - dlon) &
                         (b[:, 1] <= lat + dlat) & (b[:, 3] >= lat - dlat))[0]
        out = []
        for i in idx:
            r = self.rings[i]
            # local plane in km around the point
            x = (r[:, 0] - lon) * KM_PER_DEG * coslat
            y = (r[:, 1] - lat) * KM_PER_DEG
            ax, ay, bx, by = x[:-1], y[:-1], x[1:], y[1:]
            near = ((np.minimum(ax, bx) <= max_km) & (np.maximum(ax, bx) >= -max_km) &
                    (np.minimum(ay, by) <= max_km) & (np.maximum(ay, by) >= -max_km))
            if not near.any():
                continue
            ax, ay, bx, by = ax[near], ay[near], bx[near], by[near]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            with np.errstate(divide='ignore', invalid='ignore'):
                t = np.clip(np.where(L2 > 0, -(ax * dx + ay * dy) / L2, 0), 0, 1)
            px, py = ax + t * dx, ay + t * dy
            d = np.hypot(px, py)
            for j in np.argsort(d)[:k]:
                if d[j] <= max_km:
                    out.append((float(d[j]), lon + px[j] / (KM_PER_DEG * coslat), lat + py[j] / KM_PER_DEG))
        out.sort()
        return out[:k]


class LandSnap:
    def __init__(self, max_km=15.0):
        self.max_km = max_km
        self.l10 = _Layer(os.path.join(GEO, 'land-10m.json'))
        p50 = os.path.join(GEO, 'land-50m.json')
        self.l50 = _Layer(p50) if os.path.exists(p50) else None
        self._cache = {}

    def on_land(self, lon, lat):
        return self.l10.inside(lon, lat), (self.l50.inside(lon, lat) if self.l50 else True)

    def snap(self, lon, lat):
        """-> (lon, lat, info) where info is None (unchanged) or a dict {km, was, layer}."""
        key = (round(lon, 5), round(lat, 5))
        if key in self._cache:
            return self._cache[key]
        res = self._snap(lon, lat)
        self._cache[key] = res
        return res

    def _snap(self, lon, lat):
        in10, in50 = self.on_land(lon, lat)
        if in10 and in50:
            return lon, lat, None
        coslat = max(math.cos(math.radians(lat)), 0.05)

        def dist(a, b):
            return math.hypot((a - lon) * KM_PER_DEG * coslat, (b - lat) * KM_PER_DEG)

        def push(plon, plat, eps):
            # from the original point through the boundary point, eps km further (into the land)
            vx, vy = (plon - lon) * KM_PER_DEG * coslat, (plat - lat) * KM_PER_DEG
            n = math.hypot(vx, vy) or 1.0
            return plon + vx / n * eps / (KM_PER_DEG * coslat), plat + vy / n * eps / KM_PER_DEG

        both, only10 = [], []
        layers = [lay for lay, ok in ((self.l10, in10), (self.l50, in50)) if lay is not None and not ok]
        for lay in layers:
            for d, plon, plat in lay.nearest(lon, lat, self.max_km):
                for eps in (0.25, 0.6, 1.2, 2.5):
                    c = push(plon, plat, eps)
                    if dist(*c) > self.max_km:
                        break
                    a10 = self.l10.inside(*c)
                    a50 = self.l50.inside(*c) if self.l50 else True
                    if a10 and a50:
                        both.append((dist(*c), c))
                        break
                    if a10 and not in10:
                        only10.append((dist(*c), c))
        # inside both coastlines if that costs at most 4 km more than reaching the 1:10m land; else 1:10m land only
        b = min(both) if both else None
        o = min(only10) if only10 else None
        if in10:
            # already on the detailed coast (lower Manhattan): only move for the 1:50m globe, a little, and stay on
            # the same island — the nearest 1:50m land may be across a river (Brooklyn), so search a small disc
            isl = self.l10.island(lon, lat)
            best = None
            step = 0.25
            for ring in range(1, int(6 / step) + 1):
                rad = ring * step
                n = max(8, int(2 * math.pi * rad / step))
                for k in range(n):
                    a = 2 * math.pi * k / n
                    c = (lon + rad * math.cos(a) / (KM_PER_DEG * coslat), lat + rad * math.sin(a) / KM_PER_DEG)
                    if (self.l50 is None or self.l50.inside(*c)) and self.l10.island(*c) == isl:
                        best = (rad, c)
                        break
                if best:
                    break
            if best:
                return round(float(best[1][0]), 4), round(float(best[1][1]), 4), {'km': round(best[0], 2), 'layer': '50m'}
            return lon, lat, None
        if b and (o is None or b[0] <= o[0] + 4):
            return round(float(b[1][0]), 4), round(float(b[1][1]), 4), {'km': round(b[0], 2), 'layer': '10m+50m'}
        if o:
            return round(float(o[1][0]), 4), round(float(o[1][1]), 4), {'km': round(o[0], 2), 'layer': '10m'}
        return lon, lat, None
