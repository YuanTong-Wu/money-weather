"""Display names for the global universe.

  cn  SSE/SZSE official short names (万科A, 贵州茅台)
  hk  HKEX Chinese names -> simplified, -W/-SW/-S/-B suffixes dropped from the display name (kept in native)
  tw  TWSE/TPEX names -> simplified (台积电, 鸿海)
  jp  JPX names: when the Japanese name is all kanji (after mapping common katakana words like ホールディングス -> 控股),
      shinjitai -> simplified (三菱商事, 东京海上控股); else the curated table; else a short English name
  others: curated common Chinese names (zh_table.ZH) for well-known companies; else a short English name
Every row gets: name, native (local-language name if any), enShort, nameSrc.
"""
import re, sys, unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sources as src          # noqa: E402
from zh_table import ZH        # noqa: E402

try:
    from opencc import OpenCC
    _T2S = OpenCC("t2s")

    def t2s(s):
        out = _T2S.convert(s)
        if len(out) != len(s):
            return out
        # keep the traditional char where the simplified form is a rare non-BMP codepoint (鋐 -> 𬭎) fonts lack
        return "".join(o if ord(o) <= 0xFFFF else c for o, c in zip(out, s))
except Exception:  # noqa: BLE001  (opencc-python-reimplemented missing -> keep traditional)
    def t2s(s):
        return s

CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
KANA = re.compile(r"[぀-ヿㇰ-ㇿｦ-ﾟ]")


def has_cjk(s):
    return bool(s and CJK.search(s))


def has_kana(s):
    return bool(s and KANA.search(s))


def nfkc(s):
    return unicodedata.normalize("NFKC", s or "").strip()


# ------------------------------------------------------------------------------------------------- English
_TAIL_WORDS = {w.lower() for w in """inc incorporated corp corporation co company companies ltd limited plc p.l.c
ag se s.e sa s.a s.a.b spa s.p.a nv n.v ab asa a/s as oyj oy abp bhd tbk llc lp kgaa gmbh sgps sa/nv publ (publ)
aktiengesellschaft société européenne anonyme ord ordinary shares registered reg holding holdings group grp
s.a.s sca s.c.a societe ltda participações participacoes industria k.k kk""".split()}
_TAIL_PHRASES = [r"public company limited", r"public limited company", r"company limited", r"co\.?,?\s*ltd",
                 r"société européenne", r"societe europeenne", r"société anonyme", r"& co\.? kgaa", r"and company",
                 r"s\.a\.b\. de c\.v\.", r"de c\.v\."]


def en_short(long_name, short_name="", limit=22):
    s = nfkc(long_name or short_name)
    s = re.sub(r"\s*[\(\[].*?[\)\]]\s*", " ", s).strip()
    s = re.sub(r",(?=\S)", ", ", s)                       # "Co.,Ltd" -> "Co., Ltd"
    s = s.split(" - ")[0]                                   # "Petróleo Brasileiro S.A. - Petrobras"
    s = re.sub(r"^the\s+", "", s, flags=re.I)
    for ph in _TAIL_PHRASES:
        s = re.sub(rf"[\s,]+{ph}\.?\s*$", "", s, flags=re.I)
    toks = s.split()
    while len(toks) > 1 and toks[-1].strip(",.-").lower() in _TAIL_WORDS | {""}:
        toks.pop()
    s = " ".join(toks).strip(" ,.-")
    if not s:
        s = nfkc(short_name).title()
    if s.isupper() and len(s) > 5:
        s = s.title()
    if len(s) > limit:
        cut = s[:limit].rsplit(" ", 1)[0].strip(" ,.-&")
        cut = re.sub(r"(\s+(of|and|&|de|du|des|di|da|do|der|la|le))+$", "", cut, flags=re.I)
        s = cut if len(cut) >= 6 else s[:limit]
    return s


# ------------------------------------------------------------------------------------------------- Japanese
KATA_WORDS = [  # longest first
    ("フィナンシャル・グループ", "金融集团"), ("フィナンシャルグループ", "金融集团"), ("ホールディングス", "控股"),
    ("ホールデイングス", "控股"), ("グループ本社", "集团"), ("グループ", "集团"), ("フィナンシャル", "金融"),
    ("コーポレーション", ""), ("カンパニー", ""), ("インターナショナル", "国际"), ("エレクトロン", "电子"),
    ("エレクトロニクス", "电子"), ("テクノロジー", "科技"), ("システムズ", "系统"), ("システム", "系统"),
    ("エンジニアリング", "工程"), ("サービス", "服务"), ("ジャパン", "日本"), ("・", ""),
]
SHINJITAI = str.maketrans({
    "気": "气", "鉄": "铁", "険": "险", "売": "卖", "薬": "药", "楽": "乐", "発": "发", "広": "广", "総": "总",
    "実": "实", "証": "证", "経": "经", "済": "济", "関": "关", "電": "电", "東": "东", "製": "制", "鋼": "钢",
    "銀": "银", "行": "行", "産": "产", "業": "业", "機": "机", "械": "械", "車": "车", "動": "动", "自": "自",
    "国": "国", "際": "际", "様": "样", "郵": "邮", "便": "便", "貯": "贮", "倉": "仓", "庫": "库", "運": "运",
    "輸": "输", "送": "送", "陸": "陆", "海": "海", "空": "空", "船": "船", "鉱": "矿", "山": "山", "興": "兴",
    "駅": "驿", "旅": "旅", "団": "团", "変": "变", "圧": "压", "伝": "传", "転": "转", "恵": "惠",
    "沢": "泽", "浜": "滨", "沖": "冲", "縄": "绳", "応": "应", "対": "对", "営": "营", "当": "当", "労": "劳",
    "働": "働", "検": "检", "査": "查", "価": "价", "値": "值", "鋳": "铸", "鍛": "锻", "線": "线", "絵": "绘",
    "図": "图", "書": "书", "読": "读", "語": "语", "話": "话", "聞": "闻", "医": "医", "療": "疗", "歯": "齿",
    "飲": "饮", "飯": "饭", "酒": "酒", "醸": "酿", "粧": "妆", "紙": "纸", "織": "织", "綿": "绵", "紡": "纺",
    "絹": "绢", "縫": "缝", "装": "装", "飾": "饰", "冷": "冷", "凍": "冻", "暖": "暖", "房": "房", "灯": "灯",
    "硝": "硝", "研": "研", "究": "究", "開": "开", "閉": "闭", "間": "间", "門": "门", "問": "问", "陽": "阳",
    "陰": "阴", "雲": "云", "雪": "雪", "風": "风", "島": "岛", "嶋": "岛", "崎": "崎", "邦": "邦", "瀬": "濑",
    "賀": "贺", "栄": "荣", "営": "营", "党": "党", "県": "县", "区": "区", "芸": "艺", "単": "单", "円": "圆",
    "黒": "黑", "斎": "斋", "竜": "龙", "亀": "龟", "仏": "佛", "児": "儿", "従": "从", "徳": "德", "拡": "扩",
    "択": "择", "沢": "泽", "浅": "浅", "渋": "涩", "焼": "烧", "畳": "叠", "痩": "瘦", "研": "研", "礼": "礼",
    "穏": "稳", "粋": "粹", "継": "继", "続": "续", "緑": "绿", "縁": "缘", "繊": "纤", "聴": "听", "脳": "脑",
    "荘": "庄", "蔵": "藏", "訳": "译", "読": "读", "豊": "丰", "賛": "赞", "践": "践", "軽": "轻", "辺": "边",
    "鉛": "铅", "銭": "钱", "録": "录", "鏡": "镜", "闘": "斗", "陥": "陷", "隠": "隐", "雑": "杂", "顔": "颜",
    "類": "类", "験": "验", "騒": "骚", "髪": "发", "魚": "鱼", "鳥": "鸟", "麦": "麦", "亜": "亚", "悪": "恶",
    "圏": "圈", "堅": "坚", "塩": "盐", "壊": "坏", "奨": "奖", "姫": "姬", "宝": "宝", "寿": "寿", "峡": "峡",
    "帯": "带", "弐": "贰", "戦": "战", "戸": "户", "拠": "据", "挙": "举", "数": "数", "斉": "齐", "旧": "旧",
    "昼": "昼", "枢": "枢", "桜": "樱", "検": "检", "楼": "楼", "権": "权", "歓": "欢", "歴": "历", "毎": "每",
    "灰": "灰", "点": "点", "犠": "牺", "猟": "猎", "獣": "兽", "献": "献", "瓶": "瓶", "発": "发",
    "盗": "盗", "県": "县", "砕": "碎", "禅": "禅", "称": "称", "稲": "稻", "穂": "穗", "窓": "窗", "粛": "肃",
    "糸": "丝", "経": "经", "絶": "绝", "縦": "纵", "署": "署", "羽": "羽", "聖": "圣", "胆": "胆", "臓": "脏",
    "与": "与", "舗": "铺", "舎": "舍", "芦": "芦", "茎": "茎", "荷": "荷", "薫": "薰", "虫": "虫", "蛍": "萤",
    "衆": "众", "覚": "觉", "観": "观", "触": "触", "誉": "誉", "謡": "谣", "譲": "让", "賃": "赁", "賄": "贿",
    "賞": "赏", "躍": "跃", "込": "入", "迫": "迫", "逓": "递", "遅": "迟", "遥": "遥", "郷": "乡", "酔": "醉",
    "釈": "释", "鈴": "铃", "鋭": "锐", "錬": "炼", "閣": "阁", "闇": "暗", "阪": "阪", "隣": "邻", "雇": "雇",
    "霊": "灵", "静": "静", "響": "响", "頭": "头", "頼": "赖", "題": "题", "駆": "驱", "黄": "黄", "齢": "龄",
    "丼": "丼", "畿": "畿", "銘": "铭", "設": "设", "計": "计", "築": "筑", "建": "建", "器": "器", "具": "具",
    "術": "术", "創": "创", "協": "协", "組": "组", "合": "合", "連": "连", "携": "携", "貿": "贸", "易": "易",
    "商": "商", "事": "事", "株": "株", "式": "式", "会": "会", "社": "社", "信": "信", "託": "托", "損": "损",
    "保": "保", "命": "命", "火": "火", "災": "灾", "生": "生", "活": "活", "協": "协", "農": "农", "林": "林",
    "漁": "渔", "牧": "牧", "畜": "畜", "飼": "饲", "料": "料", "肥": "肥", "糧": "粮", "穀": "谷", "粉": "粉",
    "麺": "面", "菓": "果", "乳": "乳", "肉": "肉", "卵": "卵", "油": "油", "脂": "脂", "糖": "糖", "茶": "茶",

})


def jp_name(raw):
    """JPX Japanese name -> simplified Chinese if it can be read as Chinese, else None."""
    s = nfkc(raw)
    s = s.replace("株式会社", "").replace("(株)", "").strip()
    for a, b in KATA_WORDS:
        s = s.replace(a, b)
    s = s.replace("・", "").strip()
    if not s or has_kana(s) or not has_cjk(s):
        return None
    s = t2s(s.translate(SHINJITAI))
    if len(s) > 10:
        return None
    return s


# ------------------------------------------------------------------------------------------------- HK / TW / CN
HK_SUFFIX = re.compile(r"\s*[-－]\s*(SW|W|S|B|SB|R|P|WR|SWR|U)\s*$", re.I)
TW_SUFFIX = re.compile(r"(\s*[-－]\s*(KY|DR|創|创)|\s*[*＊]+)\s*$", re.I)


def cn_name(raw):
    s = nfkc(raw).replace(" ", "").replace("　", "")
    return s


def hk_name(raw):
    s = t2s(nfkc(raw)).replace(" ", "")
    return HK_SUFFIX.sub("", s) or s, s


def tw_name(raw):
    s = t2s(nfkc(raw)).replace(" ", "")
    return TW_SUFFIX.sub("", s) or s, s


# ------------------------------------------------------------------------------------------------- assign
def assign_names(rows):
    a = src.a_lists()["rows"]
    hk = src.hkex()["rows"]
    tw = src.taiwan()["rows"]
    jp = src.jpx()["rows"]
    for r in rows:
        t, mk = r["t"], r["mk"]
        r["enShort"] = en_short(r.get("en"), r.get("short"))
        name = native = src_tag = None
        if t in ZH:
            name, src_tag = ZH[t], "curated"
        if mk == "cn" and t in a:
            native = cn_name(a[t]["name"])
            if not name:
                name, src_tag = native, "exchange"
        elif mk == "hk":
            code = t.split(".")[0].zfill(4) + ".HK"
            if code in hk:
                disp, native = hk_name(hk[code]["name"])
                if not name:
                    name, src_tag = disp, "exchange"
        elif mk == "tw" and t in tw:
            disp, native = tw_name(tw[t]["name"])
            if not name:
                name, src_tag = disp, "exchange"
        elif mk == "jp" and t in jp:
            native = nfkc(jp[t]["name"])
            if not name:
                zj = jp_name(jp[t]["name"])
                if zj:
                    name, src_tag = zj, "jp-kanji"
        if not name:
            name, src_tag = r["enShort"], "english"
        r["name"], r["native"], r["nameSrc"] = name, native, src_tag
    return rows
