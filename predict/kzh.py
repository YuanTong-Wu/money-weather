"""predict/kzh.py: plain Chinese for Kalshi markets — rules first, Claude (through common/claude_gate) at night.

Layers, first hit wins (nothing is ever blank; untranslated text stays English with zhOk=false):
  1. owner override (web/data/overrides.json, target "ks:<ticker>", field "qZh") — applied by kalshi.py
  2. predict/kalshi_translations.json  (Claude via the gate, or the owner; {items:{english:{zh,by,at}}})
  3. polymarket/translations.json      (read-only: the same English string translated for Polymarket)
  4. templates below for Kalshi's recurring series (Fed, CPI, GDP, recession, rate cuts, best AI, …)
  5. outcome labels by rules (polymarket/translate.zh_label + Kalshi's own label formats)
`translate_pending()` sends the missing strings (+ low-confidence mappings) in ONE batched call through
common/claude_gate (kind "kalshi:translate", auto=True — counts against the 4 automatic points).
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from polymarket import translate as PTR  # noqa: E402  (rules + date helpers; read-only use)

CACHE_FILE = HERE / "kalshi_translations.json"
MAPPING_FILE = HERE / "kalshi_mapping.json"
PM_TRANSLATIONS = ROOT / "polymarket" / "translations.json"

MON = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                       "september", "october", "november", "december"])}
MON.update({k[:3]: v for k, v in list(MON.items())})
MON["sept"] = 9


def _key(en: str) -> str:
    return re.sub(r"\s+", " ", (en or "").replace("’", "'").replace("​", "").strip())


def _read(fp: Path) -> dict:
    try:
        return json.loads(fp.read_text())
    except Exception:
        return {}


def _write(fp: Path, obj):
    tmp = fp.with_suffix(fp.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=0))
    tmp.replace(fp)


class Translations:
    def __init__(self):
        self.items: dict[str, dict] = (_read(CACHE_FILE).get("items") or {})
        self.pm: dict[str, dict] = (_read(PM_TRANSLATIONS).get("items") or {})
        self.dirty = False

    def get(self, en: str) -> str | None:
        k = _key(en)
        if not k:
            return None
        it = self.items.get(k) or self.pm.get(k)
        if it and it.get("zh"):
            return it["zh"]
        return template(k)

    def cached(self, en: str) -> bool:
        k = _key(en)
        return bool(self.items.get(k) or self.pm.get(k))

    def put(self, en: str, zh: str, by: str = "claude"):
        if en and zh:
            self.items[_key(en)] = {"zh": zh.strip(), "by": by, "at": datetime.now().strftime("%Y-%m-%dT%H:%M")}
            self.dirty = True

    def save(self):
        if self.dirty:
            _write(CACHE_FILE, {"v": 1, "n": len(self.items), "items": self.items})
            self.dirty = False


# --------------------------------------------------------------------------------------------- templates
def _ym(mon: str, year: str | None) -> str | None:
    m = MON.get((mon or "").lower().rstrip("."))
    if not m:
        return None
    return (f"{year}年" if year else "") + f"{m}月"


_CB = {"bank of canada": "加拿大央行", "ecb": "欧洲央行", "european central bank": "欧洲央行", "bank of england": "英国央行",
       "boe": "英国央行", "bank of japan": "日本央行", "boj": "日本央行", "rba": "澳洲联储", "reserve bank of australia": "澳洲联储",
       "pboc": "中国央行", "people's bank of china": "中国央行", "snb": "瑞士央行", "swiss national bank": "瑞士央行",
       "bank of mexico": "墨西哥央行", "banxico": "墨西哥央行", "rbi": "印度央行"}
_ASSET = {"bitcoin": "比特币", "btc": "比特币", "ethereum": "以太坊", "eth": "以太坊", "solana": "Solana",
          "the s&p": "标普500", "s&p": "标普500", "the s&p 500": "标普500", "oil (wti)": "WTI 油价", "wti": "WTI 油价",
          "us gas prices": "美国汽油价", "gas prices": "汽油价", "unemployment": "失业率", "inflation": "通胀",
          "the nasdaq-100": "纳指100", "nasdaq-100": "纳指100", "gold": "金价", "dogecoin": "狗狗币", "xrp": "XRP"}


def _date_zh(s: str) -> str:
    z = PTR.zh_date(s.strip())
    if z:
        return z
    t = s.strip().lower()
    if t in ("this year", "in 2026"):
        return "今年"
    m = re.match(r"^(?:in |by |before )?(\d{4})$", t)
    if m:
        return f"{m.group(1)}年"
    return s.strip()


def _paren_date(s: str) -> str:
    """'Election Day (November 3, 2026)' → '2026年11月3日（Election Day）'."""
    m = re.match(r"^(.*?)\s*\((.+)\)\s*$", s)
    if m:
        d = PTR.zh_date(m.group(2))
        if d:
            return d
    return _date_zh(s)


_T = [
    (r"^fed decision in ([a-z]+)\.? (\d{4})\?$", lambda m: f"美联储{_ym(m[1], m[2])}议息：怎么动？"),
    (r"^fed funds rate after ([a-z]+)\.? (\d{4}) meeting\?$", lambda m: f"{_ym(m[1], m[2])}议息后联邦基金利率上限？"),
    (r"^number of rate cuts in (\d{4})\?$", lambda m: f"{m[1]}年美联储降息几次？"),
    (r"^number of emergency rate cuts in (\d{4})\?$", lambda m: f"{m[1]}年美联储紧急降息几次？"),
    (r"^fed rate cut before (\d{4})\?$", lambda m: f"{m[1]}年前美联储会降息吗？"),
    (r"^will the federal reserve cut rates before (\d{4})\?$", lambda m: f"{m[1]}年前美联储会降息吗？"),
    (r"^will the fed do a rate cut greater than 25 ?bps this year\?$", lambda m: "今年美联储会一次降息超过 25 个基点吗？"),
    (r"^(core )?cpi in ([a-z]+)(?: (\d{4}))?\??$", lambda m: f"{_ym(m[2], m[3])}{'核心 ' if m[1] else ''}CPI 环比涨多少？"),
    (r"^cpi yoy in ([a-z]+)(?: (\d{4}))?\??$", lambda m: f"{_ym(m[1], m[2])} CPI 同比涨多少？"),
    (r"^recession this year\?$", lambda m: "今年美国会衰退吗？"),
    (r"^recession in (\d{4})\?$", lambda m: f"{m[1]}年美国会衰退吗？"),
    (r"^will there be a recession in (\d{4})\?$", lambda m: f"{m[1]}年美国会衰退吗？"),
    (r"^when will the next u\.?s\.? recession start\?$", lambda m: "美国下一次衰退什么时候开始？"),
    (r"^us real gdp growth in (\d{4})\?$", lambda m: f"{m[1]}年美国实际 GDP 增速？"),
    (r"^gdp growth in (\d{4})\?$", lambda m: f"{m[1]}年美国 GDP 增速？"),
    (r"^best ai at the end of (\d{4})\?$", lambda m: f"{m[1]}年底谁是最强 AI？"),
    (r"^best ai (?:in|on) ([a-z]+)\.? (\d{1,2}, )?(\d{4})\?$",
     lambda m: f"{_ym(m[1], m[3])}{(m[2] or '').strip(', ') + '日' if m[2] else ''}谁是最强 AI？"),
    (r"^which ai company will have the best coding model at the end of (\d{4})\?$", lambda m: f"{m[1]}年底谁的编程模型最强？"),
    (r"^which companies will have a top-ranked ai model this year\?$", lambda m: "今年哪些公司能拿到榜首 AI 模型？"),
    (r"^(bitcoin|ethereum|solana) price at the end of (\d{4})$", lambda m: f"{m[2]}年底{_ASSET[m[1]]}价格？"),
    (r"^how (high|low) will (.+?) get (?:in|by|before) (.+?)\?$",
     lambda m: (f"{_date_zh(m[3])}{_ASSET[m[2]]}最{'高' if m[1] == 'high' else '低'}到多少？" if m[2] in _ASSET else None)),
    (r"^how (high|low) will (.+?) get this year\?$",
     lambda m: (f"今年{_ASSET[m[2]]}最{'高' if m[1] == 'high' else '低'}到多少？" if m[2] in _ASSET else None)),
    (r"^s&p close price end of (\d{4})\?$", lambda m: f"{m[1]}年底标普500收在哪？"),
    (r"^nasdaq-100 close price end of (\d{4})\?$", lambda m: f"{m[1]}年底纳指100收在哪？"),
    (r"^will the s&p finish positive this year\?$", lambda m: "今年标普500能收红吗？"),
    (r"^oil price \(wti\) on (.+?)\?$", lambda m: f"{_paren_date(m.raw(1))} WTI 油价？"),
    (r"^gas prices in the us in ([a-z]+) (\d{4})\?$", lambda m: f"{_ym(m[1], m[2])}美国汽油均价？"),
    (r"^when will (.+?) officially announce an ipo\?$", lambda m: f"{m.raw(1)}什么时候官宣上市？"),
    (r"^when will (openai|anthropic|spacex|.+?) ipo\?$", lambda m: f"{m.raw(1)}什么时候上市？"),
    (r"^will openai or anthropic ipo first\?$", lambda m: "OpenAI 和 Anthropic 谁先上市？"),
    (r"^when will openai achieve agi\?$", lambda m: "OpenAI 什么时候宣布实现 AGI？"),
    (r"^will openai announce the creation of agi\?$", lambda m: "OpenAI 会宣布实现 AGI 吗？"),
    (r"^when will (anthropic|openai|google|xai|meta) release (.+?)\?$", lambda m: f"{PTR.NAMES.get(m[1], m.raw(1))}什么时候发布 {m.raw(2)}？"),
    (r"^which party will win the u\.?s\.? (house|senate)\?$", lambda m: f"哪个党会拿下{'众议院' if m[1] == 'house' else '参议院'}？"),
    (r"^(\d{4}) (house|senate) winner$", lambda m: f"{m[1]}年{'众议院' if m[2] == 'house' else '参议院'}归谁？"),
    (r"^(.+?) decision in ([a-z]+)\.? (\d{4})\?$",
     lambda m: (f"{_CB[m[1]]}{_ym(m[2], m[3])}议息：怎么动？" if m[1] in _CB else None)),
    (r"^more tech layoffs in (\d{4}) than in (\d{4})\?$", lambda m: f"{m[1]}年科技业裁员会比{m[2]}年多吗？"),
    (r"^how high will unemployment get (?:in|before) (\d{4})\?$", lambda m: f"{m[1]}年前失业率最高到多少？"),
    (r"^us tariff revenue for (\d{4})$", lambda m: f"{m[1]}年美国关税收入？"),
    (r"^us effective tariff rate for (q[1-4]) (\d{4})$", lambda m: f"{m[2]}年{'一二三四'[int(m[1][1]) - 1]}季度美国实际关税税率？"),
    (r"^what will the tariff rate on (.+?) imports be on (.+?)\?$",
     lambda m: f"{_date_zh(m.raw(2))}美国对{PTR.COUNTRIES.get(m[1].replace('ese', 'a').replace('ian', 'ia'), m.raw(1))}进口关税税率？"),
    (r"^will the clarity act become law\?$", lambda m: "《Clarity 法案》（加密市场结构）会成为法律吗？"),
    (r"^us-iran nuclear deal\?$", lambda m: "美伊会达成核协议吗？"),
    (r"^when will traffic at the strait of hormuz return to normal\?$", lambda m: "霍尔木兹海峡什么时候恢复正常通航？"),
    (r"^will the u\.?s\.? confirm that aliens exist\?$", lambda m: None),
]
_TC = [(re.compile(p, re.I), f) for p, f in _T]


class _Low:
    """Match object view: m[i] is lower-case (for the lookup tables), m.raw(i) keeps the original case."""

    def __init__(self, m):
        self.m = m

    def __getitem__(self, i):
        g = self.m.group(i)
        return g.lower() if isinstance(g, str) else g

    def raw(self, i):
        return self.m.group(i)


def template(en: str) -> str | None:
    t = _key(en)
    for rx, f in _TC:
        m = rx.match(t)
        if m:
            m = _Low(m)
        if m:
            try:
                z = f(m)
            except Exception:
                z = None
            if z and "None" not in z:
                return z
    return None


# --------------------------------------------------------------------------------------------- labels
_LBL = [
    (r"^cut >\s*(\d+)\s*bps$", lambda m: f"降息超 {m[1]} 个基点"),
    (r"^hike >\s*(\d+)\s*bps$", lambda m: f"加息超 {m[1]} 个基点"),
    (r"^(?:hike|cut) 0\s*bps$|^fed maintains rate$|^maintains? rates?$|^no change$|^hold$", lambda m: "按兵不动"),
    (r"^exactly (\d+) cuts?$", lambda m: "一次都不降" if m[1] == "0" else f"正好降 {m[1]} 次"),
    (r"^exactly (\d+) hikes?$", lambda m: "一次都不加" if m[1] == "0" else f"正好加 {m[1]} 次"),
    (r"^(\d+) cuts?$", lambda m: "一次都不降" if m[1] == "0" else f"降 {m[1]} 次"),
    (r"^above (.+)$", lambda m: f"高于 {m[1]}"),
    (r"^below (.+)$", lambda m: f"低于 {m[1]}"),
    (r"^(.+?) or above$", lambda m: f"{m[1]} 及以上"),
    (r"^(.+?) or below$", lambda m: f"{m[1]} 及以下"),
    (r"^(-?[\d.,$]+%?) to (-?[\d.,$]+%?)$", lambda m: f"{m[1]}–{m[2]}"),
    (r"^democratic party$|^democrats?$", lambda m: "民主党"),
    (r"^republican party$|^republicans?$", lambda m: "共和党"),
    (r"^republicans win$", lambda m: "共和党赢"),
    (r"^democrats win$", lambda m: "民主党赢"),
    (r"^yes$", lambda m: "是"),
    (r"^starts$", lambda m: "开始衰退"),
    (r"^cuts$", lambda m: "降息"),
    (r"^positive growth$", lambda m: "收红"),
    (r"^in (\d{4})$", lambda m: f"{m[1]}年内"),
    (r"^before his term ends$|^during trump's term$", lambda m: "任期内"),
]
_LC = [(re.compile(p, re.I), f) for p, f in _LBL]
_NAME = re.compile(r"^[A-Z][A-Za-z0-9.&'+\-]*(?: [A-Z0-9][A-Za-z0-9.&'+\-]*){0,2}(?: \([A-Z]{2,6}\))?$")


def label_zh(label: str, tr: Translations | None = None) -> tuple[str | None, bool]:
    """→ (Chinese label, ok). Proper names (Claude, Gemini, OpenAI, Kash Patel) stay as they are (ok=True)."""
    g = _key(label)
    if not g:
        return None, False
    low = g.lower()
    for rx, f in _LC:
        m = rx.match(g)
        if m:
            return f(m), True
    z = PTR.zh_label(g)
    if z:
        return z, True
    if tr:
        c = tr.get(g)
        if c:
            return c, True
    if _NAME.match(g) and len(g) <= 32:
        return PTR.NAMES.get(low, g), True
    return None, False


def compose(title: str, q: str, label: str | None, multi: bool, tr: Translations) -> tuple[str, bool, list[str]]:
    """→ (Chinese text, fully translated?, English units still missing)."""
    missing = []
    if multi and label:
        tz = tr.get(title)
        gz, gok = label_zh(label, tr)
        if tz and gok:
            filled = PTR.fill_blank(tz, gz)
            return (filled or f"{tz.rstrip('？?')}｜{gz}"), True, []
        qz = tr.get(q)
        if qz:
            return qz, True, []
        if not tz:
            missing.append(title)
        if not gok:
            missing.append(label)
        if tz:
            return f"{tz.rstrip('？?')}｜{label}", False, missing
        return f"{title}｜{label}", False, missing
    qz = tr.get(q)
    if qz:
        return qz, True, []
    tz = tr.get(title) if title and title != q else None
    if tz and label:
        gz, gok = label_zh(label, tr)
        if gok:
            return f"{tz.rstrip('？?')}｜{gz}", True, []
    return q, False, [q]


# --------------------------------------------------------------------------------------------- Claude (nightly)
SYSTEM = """你是“钱的天气”的翻译和分析助手。只输出一个 JSON 对象，不要任何别的文字。

任务一：把 Kalshi 预言市场的英文问题/标题/选项翻成简短、自然的简体中文。
- 每条 ≤ 30 字；原文是问句就保留问句；口语化、给中国散户看得懂。
- 模型和产品名保持英文原样（Claude、Opus、Mythos、GPT、Gemini、Grok 等），公司用常用中文名（谷歌、微软、英伟达、
  亚马逊、苹果、特斯拉），OpenAI / Anthropic / xAI / Meta 保持英文。Fed=美联储，bps=个基点，IPO=上市。
- "before/by ..." 译成“……前”；日期写成“2026年12月31日前”；金额保留 $ 和数字。不要添加原文没有的信息。

任务二（只对 map 列表里的市场）：如果这个市场结果为 YES，哪些地图板块的钱会受影响。
- 只能用给出的板块 id；选 1–5 个最直接的；sign=1 表示 YES 对这个板块的钱是利好，-1 是利空。
- 和资金流向基本无关（八卦、人事、纯政治表态）就给 {"none": true}。why：一句中文，≤ 20 字。

输出格式：{"zh": {"<编号>": "中文", ...}, "map": {"<市场id>": {"nodes": [{"id": "...", "sign": 1}], "why": "..."} 或 {"none": true, "why": "..."}}}"""


def region_list(tree) -> str:
    return "；".join(f"{nid}={tree.nodes[nid]['name']}" for nid in tree.regions() if nid != "world")


def translate_pending(units: list[str], cands: list[dict], tree, *, log=print, model: str = "sonnet",
                      max_units: int = 450, timeout: int = 900, dry_run: bool = False) -> dict:
    """ONE batched call through common/claude_gate (auto=True). → {called, zh, mapped, usd, refused, error}"""
    tr = Translations()
    units = [u for u in dict.fromkeys(units) if u and not tr.cached(u)][:max_units]
    mapping = (_read(MAPPING_FILE).get("items") or {})
    cands = [c for c in cands if c["id"] not in mapping][:30]
    out = {"called": False, "zh": 0, "mapped": 0, "usd": 0.0, "refused": None, "error": None,
           "units": len(units), "cands": len(cands)}
    if not units and not cands:
        log("kalshi translate: nothing pending")
        return out
    parts = ["# zh：要翻译的条目（编号\\t英文）"] + [f"{i}\t{u}" for i, u in enumerate(units)]
    if cands:
        parts.append("\n# map：要判断板块的市场（id\\t问题\\t规则猜测）")
        parts += [f"{c['id']}\t{c['q']}\t{' '.join(c.get('rules') or []) or '-'}" for c in cands]
        parts.append("\n# 板块 id=名字\n" + region_list(tree))
    prompt = "\n".join(parts)
    if dry_run:
        log(f"kalshi translate (dry run): {len(units)} strings, {len(cands)} mappings, {len(prompt)} chars")
        log(prompt[:1200])
        return out
    try:
        from common import claude_gate as gate
    except Exception as e:  # the gateway is the only way out to Claude (DESIGN §21/§24)
        out["error"] = f"common/claude_gate 不可用：{e}"
        log(f"kalshi translate: skipped — {out['error']}")
        return out
    ok, why = gate.can_spend(auto=True)
    if not ok:
        out["refused"], out["error"] = "budget", why
        log(f"kalshi translate: skipped — {why}")
        return out

    def validate(obj):
        zh = obj.get("zh") if isinstance(obj, dict) else None
        if not isinstance(zh, dict) or (units and not zh):
            return ["缺少 zh 对象"]
        bad = [k for k, v in list(zh.items())[:50] if not isinstance(v, str) or not re.search(r"[一-鿿]", v)]
        return [f"这些编号不是中文：{', '.join(bad[:10])}"] if len(bad) > 5 else []

    r = gate.call("kalshi:translate", prompt, system=SYSTEM, tools=(), auto=True, model=model, effort="low",
                  timeout=timeout, validate=validate, module="predict", note=f"{len(units)} zh + {len(cands)} map")
    out.update(called=True, usd=r.get("usd") or 0.0, refused=r.get("refused"), error=r.get("error"))
    res = r.get("json") if r.get("ok") else None
    if not isinstance(res, dict):
        log(f"kalshi translate: no usable answer ({r.get('refused') or r.get('error')})")
        return out
    for k, v in (res.get("zh") or {}).items():
        try:
            i = int(k)
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(units) and isinstance(v, str) and re.search(r"[一-鿿]", v):
            tr.put(units[i], v.strip()[:80], by="claude")
            out["zh"] += 1
    tr.save()
    mp = res.get("map") or {}
    if mp:
        ok_ids = {c["id"] for c in cands}
        at = datetime.now().strftime("%Y-%m-%dT%H:%M")
        for mid, v in mp.items():
            if str(mid) not in ok_ids or not isinstance(v, dict):
                continue
            if v.get("none"):
                mapping[str(mid)] = {"none": True, "nodes": [], "why": str(v.get("why") or "")[:60], "at": at}
                out["mapped"] += 1
                continue
            nodes = []
            for n in v.get("nodes") or []:
                if not isinstance(n, dict):
                    continue
                rid = tree.resolve(str(n.get("id") or ""))
                if rid and rid != "world" and n.get("sign") in (1, -1) and rid not in [x["id"] for x in nodes]:
                    nodes.append({"id": rid, "sign": n["sign"]})
            if nodes:
                mapping[str(mid)] = {"nodes": nodes[:6], "why": str(v.get("why") or "")[:60], "at": at}
                out["mapped"] += 1
        _write(MAPPING_FILE, {"v": 1, "n": len(mapping), "items": mapping})
    log(f"kalshi translate: {out['zh']}/{len(units)} translated, {out['mapped']}/{len(cands)} mapped, "
        f"${out['usd']:.3f}")
    return out


def mapping() -> dict:
    return _read(MAPPING_FILE).get("items") or {}
