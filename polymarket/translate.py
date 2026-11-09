"""polymarket/translate.py: plain Chinese for every kept market, without spending Claude on each one.

A market's Chinese text is composed from pieces:
  single-question event  → zh(question)
  multi-outcome event    → zh(event title) + "｜" + zh(outcome label)   e.g. "美联储 12 月议息？｜降息 25 基点"
Outcome labels are mostly dates, prices, bps, company names: translated here by rules. Titles and
questions come from the cache (polymarket/translations.json, filled by map.py with ONE batched
`claude -p` call per run, in the loop's nightly cycle, through common/claude_gate.py). Anything not translated yet falls back to the English text, flagged
zhOk=false, so nothing is ever blank.
"""
from __future__ import annotations

import re
from datetime import datetime

try:
    from .common import TRANSLATIONS, read_json, write_json
except ImportError:
    from common import TRANSLATIONS, read_json, write_json

MONTHS = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july",
                                          "august", "september", "october", "november", "december"])}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9

NAMES = {
    "google": "谷歌", "alphabet": "谷歌", "openai": "OpenAI", "anthropic": "Anthropic", "xai": "xAI", "meta": "Meta",
    "microsoft": "微软", "apple": "苹果", "amazon": "亚马逊", "nvidia": "英伟达", "tesla": "特斯拉",
    "deepseek": "DeepSeek", "alibaba": "阿里巴巴", "moonshot": "月之暗面", "moonshot ai": "月之暗面",
    "bytedance": "字节跳动", "tencent": "腾讯", "baidu": "百度", "zhipu": "智谱", "z.ai": "智谱 Z.ai",
    "mistral": "Mistral", "kimi": "Kimi", "minimax": "MiniMax", "qwen": "通义千问", "broadcom": "博通",
    "tsmc": "台积电", "saudi aramco": "沙特阿美", "berkshire hathaway": "伯克希尔", "spacex": "SpaceX",
    "netflix": "奈飞", "oracle": "甲骨文", "intel": "英特尔", "amd": "AMD", "micron": "美光", "palantir": "Palantir",
    "coinbase": "Coinbase", "jpmorgan": "摩根大通", "eli lilly": "礼来", "walmart": "沃尔玛", "visa": "Visa",
    "microstrategy": "MicroStrategy", "strategy": "Strategy", "perplexity": "Perplexity", "cursor": "Cursor",
    "databricks": "Databricks", "stripe": "Stripe", "safe superintelligence": "SSI", "ssi": "SSI",
    "thinking machines": "Thinking Machines", "cohere": "Cohere", "figure": "Figure",
    "republican": "共和党", "republicans": "共和党", "democratic": "民主党", "democrats": "民主党",
    "democrat": "民主党", "other": "其他", "none": "都没有", "nobody": "没人", "no one": "没人",
    "bitcoin": "比特币", "ethereum": "以太坊", "solana": "Solana", "gold": "黄金", "silver": "白银",
    "s&p 500": "标普500", "nasdaq": "纳指", "oil": "原油",
}
COUNTRIES = {
    "united states": "美国", "us": "美国", "u.s.": "美国", "usa": "美国", "china": "中国", "taiwan": "台湾",
    "japan": "日本", "south korea": "韩国", "korea": "韩国", "north korea": "朝鲜", "india": "印度",
    "pakistan": "巴基斯坦", "russia": "俄罗斯", "ukraine": "乌克兰", "iran": "伊朗", "israel": "以色列",
    "saudi arabia": "沙特", "qatar": "卡塔尔", "uae": "阿联酋", "turkey": "土耳其", "egypt": "埃及",
    "canada": "加拿大", "mexico": "墨西哥", "brazil": "巴西", "argentina": "阿根廷", "venezuela": "委内瑞拉",
    "european union": "欧盟", "eu": "欧盟", "united kingdom": "英国", "uk": "英国", "germany": "德国",
    "france": "法国", "italy": "意大利", "spain": "西班牙", "poland": "波兰", "australia": "澳大利亚",
    "indonesia": "印尼", "vietnam": "越南", "philippines": "菲律宾", "thailand": "泰国", "singapore": "新加坡",
    "south africa": "南非", "switzerland": "瑞士", "norway": "挪威", "sweden": "瑞典", "finland": "芬兰",
    "lebanon": "黎巴嫩", "syria": "叙利亚", "iraq": "伊拉克", "yemen": "也门", "jordan": "约旦",
    "oman": "阿曼", "cuba": "古巴", "greenland": "格陵兰", "denmark": "丹麦", "panama": "巴拿马",
    "colombia": "哥伦比亚", "chile": "智利", "peru": "秘鲁", "nigeria": "尼日利亚", "hungary": "匈牙利",
    "netherlands": "荷兰", "belgium": "比利时", "estonia": "爱沙尼亚", "latvia": "拉脱维亚",
    "lithuania": "立陶宛", "moldova": "摩尔多瓦", "belarus": "白俄罗斯", "georgia": "格鲁吉亚",
    "armenia": "亚美尼亚", "azerbaijan": "阿塞拜疆", "kazakhstan": "哈萨克斯坦", "afghanistan": "阿富汗",
    "bahrain": "巴林", "kuwait": "科威特", "libya": "利比亚", "sudan": "苏丹", "somalia": "索马里",
    "ethiopia": "埃塞俄比亚", "malaysia": "马来西亚", "bangladesh": "孟加拉", "myanmar": "缅甸",
    "new zealand": "新西兰", "ireland": "爱尔兰", "portugal": "葡萄牙", "greece": "希腊", "austria": "奥地利",
    "czech republic": "捷克", "romania": "罗马尼亚", "serbia": "塞尔维亚", "hamas": "哈马斯",
    "hezbollah": "真主党", "houthis": "胡塞", "kyiv": "基辅", "kharkiv": "哈尔科夫", "odesa": "敖德萨",
    "dnipro": "第聂伯", "zaporizhzhia": "扎波罗热", "kramatorsk": "克拉马托尔斯克", "sloviansk": "斯拉维扬斯克",
}
_LOOKUP = {**NAMES, **COUNTRIES}

_NUM = r"[\$€£]?\s?\d[\d,]*(?:\.\d+)?\s?(?:[kmbt]|bn|tn)?%?"


def _ymd(mon: str, day: str | None, year: str | None) -> str | None:
    mo = MONTHS.get(mon.lower().rstrip("."))
    if not mo:
        return None
    s = (f"{year}年" if year else "") + f"{mo}月"
    if day:
        s += f"{int(day)}日"
    return s


def zh_date(s: str) -> str | None:
    """'by December 31, 2026' → '2026年12月31日前'; 'October' → '10月'; 'Q1 2027' → '2027年一季度'."""
    t = s.strip().rstrip("?").strip()
    low = t.lower()
    pre, suf = "", ""
    m = re.match(r"^(by|before|on|in|through|until|after|end of)\s+(.*)$", low)
    if m:
        w, low = m.group(1), m.group(2)
        suf = {"by": "前", "before": "之前", "through": "为止", "until": "为止", "after": "之后",
               "end of": "底"}.get(w, "")
    m = re.match(r"^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$", low)
    if m:
        d = _ymd(m.group(1), m.group(2), m.group(3))
        return d + suf if d else None
    m = re.match(r"^([a-z]{3,9})(?:,?\s*(\d{4}))?$", low)
    if m and MONTHS.get(m.group(1)):
        d = _ymd(m.group(1), None, m.group(2))
        return (d + ("底" if suf == "底" else suf)) if d else None
    m = re.match(r"^q([1-4])\s*(\d{4})?$", low)
    if m:
        q = "一二三四"[int(m.group(1)) - 1]
        return (f"{m.group(2)}年" if m.group(2) else "") + f"{q}季度" + suf
    m = re.match(r"^(\d{4})$", low)
    if m:
        return f"{m.group(1)}年" + (suf or "")
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", low)
    if m:
        return f"{int(m.group(1))}年{int(m.group(2))}月{int(m.group(3))}日" + suf
    return None


def _num(s: str) -> str:
    return re.sub(r"\s+", "", s)


def zh_label(g: str) -> str | None:
    """Outcome label of a multi-outcome market → Chinese, or None when it needs a real translator."""
    if not g:
        return None
    t = g.strip()
    low = t.lower().strip()
    if low in ("yes", "no"):
        return "是" if low == "yes" else "否"
    if low in _LOOKUP:
        return _LOOKUP[low]
    d = zh_date(t)
    if d:
        return d
    m = re.fullmatch(r"(.+?)\s*[–—-]\s*(.+)", t)
    if m and not re.search(r"\d\s*[–—-]\s*\d", t[:6] if t[:1].isdigit() else ""):
        a, b = zh_date(m.group(1)), zh_date(m.group(2))
        if a and b:
            return f"{a}–{b}"
    # pure numbers / prices / arrows / ranges
    if re.fullmatch(r"[↑↓<>≤≥+\-–—~\s$€£%.,:/()0-9kmbtKMBT]+", t) and re.search(r"\d", t):
        return t
    m = re.fullmatch(r"(\d+)\+?\s*bps?\s*(decrease|cut|increase|hike)s?", low)
    if m:
        plus = "+" if "+" in low else ""
        return ("降息" if m.group(2) in ("decrease", "cut") else "加息") + f" {m.group(1)}{plus} 个基点"
    m = re.fullmatch(r"(decrease|cut|increase|hike)s?\s*(?:by\s*)?(\d+)\+?\s*bps?", low)
    if m:
        plus = "+" if "+" in low else ""
        return ("降息" if m.group(1) in ("decrease", "cut") else "加息") + f" {m.group(2)}{plus} 个基点"
    if re.fullmatch(r"no change|unchanged|hold|pause", low):
        return "按兵不动"
    m = re.fullmatch(r"(\d+)\+?\s*\((\d+)\+?\s*bps?\)", low)
    if m:
        return f"{m.group(1)}{'+' if '+' in low else ''} 次（{m.group(2)} 个基点）"
    m = re.fullmatch(r"(no|none|zero|0) (cuts?|hikes?)", low)
    if m:
        return "一次都不" + ("降" if "cut" in low else "加")
    m = re.fullmatch(r"(\d+)\+?\s*(cuts?|hikes?)", low)
    if m:
        return f"{m.group(1)}{'+' if '+' in low else ''} 次" + ("降息" if "cut" in low else "加息")
    m = re.fullmatch(rf"(less than|under|below|fewer than|<)\s*({_NUM})", low)
    if m:
        return f"低于 {_num(m.group(2))}"
    m = re.fullmatch(rf"(more than|over|above|greater than|at least|>)\s*({_NUM})(\s*or more)?", low)
    if m:
        return f"高于 {_num(m.group(2))}"
    m = re.fullmatch(rf"({_NUM})\s*(\+|or more|or higher|or above)", low)
    if m:
        return f"{_num(m.group(1))} 及以上"
    m = re.fullmatch(rf"({_NUM})\s*(or less|or lower|or below|or fewer)", low)
    if m:
        return f"{_num(m.group(1))} 及以下"
    m = re.fullmatch(rf"(?:between\s*)?({_NUM})\s*(?:-|–|to|and)\s*({_NUM})", low)
    if m:
        return f"{_num(m.group(1))}–{_num(m.group(2))}"
    m = re.fullmatch(r"(\d+)\s*(countries|companies|cities|times|seats|states|problems?)", low)
    if m:
        unit = {"countries": "个国家", "companies": "家公司", "cities": "座城市", "times": "次", "seats": "席",
                "states": "个州"}.get(m.group(2), "个")
        return f"{m.group(1)} {unit}"
    m = re.fullmatch(r"(\d+)\+?", low)
    if m:
        return t
    # "Anthropic IPO" style: one name + a known suffix
    for k, v in _LOOKUP.items():
        if low == k + " ipo":
            return v + " 上市"
    m = re.fullmatch(r"([a-z]{3,9})\.?\s*(\d{4})?\s*(fomc |fed )?meeting", low)
    if m and MONTHS.get(m.group(1)):
        return (_ymd(m.group(1), None, m.group(2)) or "") + "议息会议"
    # a model/product name kept as is (letters + digits + dots, short): "Claude 6", "GPT-7", "Gemini 3.5 Pro"
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9.\- ]{0,24}", t) and re.search(r"\d", t) and len(t.split()) <= 4 \
            and not any(w in MONTHS for w in low.replace(",", " ").split()):
        return t
    return None


# --------------------------------------------------------------------------------------------
class Translations:
    """Cache: English text → Chinese. Only real translations (Claude or owner) are stored."""

    def __init__(self):
        d = read_json(TRANSLATIONS, {})
        self.items: dict[str, dict] = d.get("items") or {}
        self.dirty = False

    def get(self, en: str) -> str | None:
        if not en:
            return None
        it = self.items.get(_key(en))
        return it.get("zh") if it else None

    def put(self, en: str, zh: str, by: str = "claude"):
        if not en or not zh:
            return
        self.items[_key(en)] = {"zh": zh.strip(), "by": by, "at": datetime.now().strftime("%Y-%m-%dT%H:%M")}
        self.dirty = True

    def save(self):
        if self.dirty:
            write_json(TRANSLATIONS, {"v": 1, "n": len(self.items), "items": self.items}, indent=0)
            self.dirty = False


def _key(en: str) -> str:
    return re.sub(r"\s+", " ", en.replace("’", "'").strip())


def needs_title(event: dict, m: dict) -> bool:
    """Multi-outcome event (title + label) or a single question?"""
    return bool((m.get("groupItemTitle") or "").strip()) and len(event.get("markets") or []) > 1


def units_for(event: dict, m: dict) -> list[str]:
    """English strings this market's Chinese text is built from (to be translated by Claude)."""
    if needs_title(event, m):
        out = [event.get("title") or ""]
        g = (m.get("groupItemTitle") or "").strip()
        if zh_label(g) is None:
            out.append(g)
        return [u for u in out if u]
    return [m.get("question") or event.get("title") or ""]


def fill_blank(tz: str, gz: str) -> str | None:
    """'10月28日以太坊高于___？' + '4,000' → '10月28日以太坊高于 4,000？';
    '德州会在……前出台禁建令吗？' + '12月31日' → '德州会在12月31日前出台禁建令吗？'"""
    for blank in ("___", "__", "……", "…", "多少"):
        if blank in tz:
            g = gz
            after = tz.split(blank, 1)[1]
            if after.startswith(("前", "之前")) and g.endswith(("前", "之前")):
                g = g[:-2] if g.endswith("之前") else g[:-1]
            is_date = bool(re.search(r"\d+月|\d{4}年|季度", g)) and not re.search(r"[未不没无]", g)
            is_num = bool(re.match(r"[\d↑↓$<>≤≥]", g)) and not is_date
            if blank in ("……", "…") and not is_date:
                return None  # '……' stands for a date in these titles
            if blank == "多少" and not is_num:
                return None  # only fill 多少 with a number
            if blank in ("___", "__") and not (is_num or is_date or len(g) <= 12):
                return None
            sep = " " if is_num else ""
            return tz.replace(blank, sep + g + (sep if after and not after.startswith(("？", "?", "前")) else ""), 1)
    return None


def compose(event: dict, m: dict, tr: Translations) -> tuple[str, bool]:
    """→ (Chinese text, fully translated?)"""
    q = m.get("question") or event.get("title") or ""
    if needs_title(event, m):
        title = event.get("title") or q
        g = (m.get("groupItemTitle") or "").strip()
        tz = tr.get(title)
        gz = zh_label(g) or tr.get(g)
        if tz and gz:
            filled = fill_blank(tz, gz)
            return (filled or f"{tz.rstrip('？?')}｜{gz}"), True
        qz = tr.get(q)
        if qz:
            return qz, True
        if tz:
            return f"{tz.rstrip('？?')}｜{g}", False
        return q, False
    qz = tr.get(q)
    return (qz, True) if qz else (q, False)
