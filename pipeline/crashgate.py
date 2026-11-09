#!/usr/bin/env python3
"""crashgate.py — the season crash gate (DESIGN.md §8 amendment, 2026-10-28). Pure Python, no numpy.

A territory that is falling hard can never read 🌱 春 / ☀️ 夏 (or 平稳). §8.2 judges the season from wind and
crowding only, and a panic sell-off pushes both UP (volume share and crowding jump), so Brazil −19 % in a day read
☀️ 夏. The gate looks at the price itself, measured against the node's OWN volatility, with an absolute floor:

  σ   = stdev of its daily returns over the 60 trading days BEFORE the last 5 (the drop never widens its own
        yardstick); needs ≥ 40 valid days. Robust to one freak day (2026-10-28 refine): before the stdev, each return
        is clipped to median ± 5·σ_MAD (σ_MAD = 1.4826 · median |r − median|), so a single +177 % jump (MRNA
        2026-08-19) cannot blind the gate for three months; for an ordinary series nothing is clipped and σ is
        the plain stdev
  r5  = 5-day return (idx_t / idx_{t−5} − 1), r1 = 1-day return
  level 2 「崩」   r5 ≤ −10 % and (r5 ≤ −3·σ·√5 or r5 ≤ −25 %)   or   r1 ≤ −8 % and r1 ≤ −5·σ
  level 1 「急跌」 r5 ≤ −5 %  and (r5 ≤ −2·σ·√5 or r5 ≤ −15 %)   or   r1 ≤ −5 % and r1 ≤ −4·σ
  (the −5 % / −8 % floors keep low-volatility things — bonds, cash, staples — from tripping on a 1 % wobble; the
   −15 % / −25 % caps catch a crash in something that is always wild, e.g. a biotech with a 7 % daily σ)

Effect (words.js seasonKey/season, pipeline/brief.py season_key — same rule, same numbers): level ≥ 1 and the §8.2
season is 春 / 夏 / none → 🍂 秋 when crowding p ≥ 50, else ❄️ 冬 (the §8.2 table's own split), and the words say
崩 / 急跌 with the exact drop. 秋 / 冬 stay what they are (the words still name the drop).
Every implementation (this file, pipeline/compute.py now.crash, web/js/words.js crashAt) reads the same series
values (the map's `idx`, or a stock file's `c`), so the map, the brief and the panel always agree.
"""
from __future__ import annotations

import math

SIG_DAYS = 60          # σ window (daily returns), ending 5 days before t
SIG_MIN = 40           # at least this many valid returns, else no gate (too little history to say "unusual")
CLIP_K = 5.0           # clip each return to median ± CLIP_K·σ_MAD before the stdev (one freak day never blinds the gate)
MAD_K = 1.4826         # σ_MAD = MAD_K · median |r − median| (= σ for normal returns)
# (floor, k·σ, hard) per level
L1_5 = (-0.05, 2.0, -0.15)
L2_5 = (-0.10, 3.0, -0.25)
L1_1 = (-0.05, 4.0)
L2_1 = (-0.08, 5.0)
NAMES = {1: '急跌', 2: '崩'}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _median(xs):
    ys = sorted(xs)
    n = len(ys)
    return ys[(n - 1) // 2] if n % 2 else 0.5 * (ys[n // 2 - 1] + ys[n // 2])


def robust_sigma(rs: list) -> float:
    """stdev of the returns after clipping each to median ± CLIP_K·σ_MAD (words.js robustSigma, same arithmetic)."""
    med = _median(rs)
    smad = MAD_K * _median([abs(x - med) for x in rs])
    if smad > 0:
        lo, hi = med - CLIP_K * smad, med + CLIP_K * smad
        rs = [lo if x < lo else hi if x > hi else x for x in rs]
    mu = sum(rs) / len(rs)
    return math.sqrt(sum((x - mu) ** 2 for x in rs) / (len(rs) - 1))


def crash_at(px, t: int) -> dict | None:
    """px = a price-like series (map `idx` or stock `c`), t = day index → None | {level, name, r1, r5, sigma, z5, by}.
    `by` = 'r5' | 'r1' (which test fired; r5 wins ties)."""
    if not isinstance(px, list) or t is None or t < 6 or t >= len(px):
        return None
    a, b, c = px[t], px[t - 5], px[t - 1]
    if not (_num(a) and _num(b) and _num(c)) or b <= 0 or c <= 0:
        return None
    r5 = a / b - 1.0
    r1 = a / c - 1.0
    if r5 > L1_5[0] and r1 > L1_1[0]:
        return None                                  # quick exit: not even the floor
    rs = []
    for j in range(max(1, t - 5 - SIG_DAYS + 1), t - 5 + 1):
        x, y = px[j], px[j - 1]
        if _num(x) and _num(y) and y > 0:
            rs.append(x / y - 1.0)
    if len(rs) < SIG_MIN:
        return None
    sig = robust_sigma(rs)
    s5 = sig * math.sqrt(5)

    def hit5(rule):
        floor, k, hard = rule
        return r5 <= floor and (r5 <= -k * s5 or r5 <= hard)

    def hit1(rule):
        floor, k = rule
        return r1 <= floor and r1 <= -k * sig

    level, by = 0, None
    if hit5(L2_5):
        level, by = 2, 'r5'
    elif hit1(L2_1):
        level, by = 2, 'r1'
    elif hit5(L1_5):
        level, by = 1, 'r5'
    elif hit1(L1_1):
        level, by = 1, 'r1'
    if not level:
        return None
    return {'level': level, 'name': NAMES[level], 'r1': round(r1, 4), 'r5': round(r5, 4), 'sigma': round(sig, 4),
            'z5': round(r5 / s5, 2) if s5 > 0 else None, 'by': by}


def gate_key(key: str | None, crash: dict | int | None, p) -> str | None:
    """§8.2 season key → gated key. crash = crash_at(...) result or a level number."""
    lv = crash.get('level', 0) if isinstance(crash, dict) else (crash or 0)
    if not lv or key in ('autumn', 'winter'):
        return key
    if not _num(p):
        return key
    return 'autumn' if p >= 50 else 'winter'


def series_px(s: dict | None):
    """the price-like series of a map SERIES / stock file: `idx`, else `c`."""
    if not s:
        return None
    px = s.get('idx')
    return px if isinstance(px, list) else s.get('c')
