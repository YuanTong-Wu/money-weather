"""macro/instruments.py: what the macro planet is made of.

Every instrument is measured on a "strength" basis so that up = money flowing INTO it:
  - FX pairs quoted as USD/XXX (USDJPY=X …) are inverted → up = that currency gets stronger vs the dollar;
    DXY stays as is (up = the dollar gets stronger).
  - Treasury futures: price up = yields down = money going into bonds.
  - VIX: Yahoo has no VIX futures (VX=F), so the ^VIX index stands in for the price (est), while open
    interest / positioning come from the real CFTC report for CBOE VIX futures.
mult = contract multiplier (USD per 1.0 of the quoted price per contract) → dollar volume = C·V·mult.
cftc = CFTC legacy futures-only contract market code (open interest + speculator positioning, weekly).
"""
from __future__ import annotations

GROUPS = [
    {"id": "macro-fx", "name": "外汇", "emoji": "💱", "desc": "各国货币对美元的强弱：涨=这种货币变强，钱往那里去。",
     "tags": ["rates"]},
    {"id": "macro-rates", "name": "美债期货", "emoji": "🏦", "desc": "美国国债期货：涨=利率在降，钱在躲进债券。",
     "tags": ["rates"]},
    {"id": "macro-index", "name": "股指期货", "emoji": "📈", "desc": "大钱用期货押整个股市：标普、纳指、小盘股，还有恐慌指数。",
     "tags": []},
    {"id": "macro-energy", "name": "能源期货", "emoji": "🛢️", "desc": "原油、天然气、成品油：通胀和地缘的温度计。",
     "tags": ["energy", "oil"]},
    {"id": "macro-metals", "name": "金属期货", "emoji": "🥇", "desc": "黄金白银是避险，铜和铂金看经济和工业。",
     "tags": ["gold", "metals"]},
    {"id": "macro-ags", "name": "农产品期货", "emoji": "🌾", "desc": "玉米、大豆、小麦：粮价，通胀里最容易被忽视的一块。",
     "tags": []},
]

# key, yahoo symbol, name, group, kind, invert, mult, cftc, quote label, note
_I = [
    ("dxy", "DX-Y.NYB", "美元指数", "macro-fx", "index", False, 1000, "098662", "DXY", "美元对一篮子货币，涨=美元变强"),
    ("eur", "EURUSD=X", "欧元", "macro-fx", "fx", False, 0, "099741", "EUR/USD", "涨=欧元变强"),
    ("jpy", "USDJPY=X", "日元", "macro-fx", "fx", True, 0, "097741", "USD/JPY", "按日元强弱算，涨=日元变强"),
    ("cnh", "USDCNH=X", "人民币", "macro-fx", "fx", True, 0, None, "USD/CNH", "离岸人民币，按人民币强弱算"),
    ("gbp", "GBPUSD=X", "英镑", "macro-fx", "fx", False, 0, "096742", "GBP/USD", "涨=英镑变强"),
    ("aud", "AUDUSD=X", "澳元", "macro-fx", "fx", False, 0, "232741", "AUD/USD", "涨=澳元变强"),
    ("cad", "USDCAD=X", "加元", "macro-fx", "fx", True, 0, "090741", "USD/CAD", "按加元强弱算"),
    ("chf", "USDCHF=X", "瑞郎", "macro-fx", "fx", True, 0, "092741", "USD/CHF", "按瑞郎强弱算，避险货币"),
    ("krw", "USDKRW=X", "韩元", "macro-fx", "fx", True, 0, None, "USD/KRW", "按韩元强弱算"),
    ("inr", "USDINR=X", "印度卢比", "macro-fx", "fx", True, 0, None, "USD/INR", "按卢比强弱算"),
    ("mxn", "USDMXN=X", "墨西哥比索", "macro-fx", "fx", True, 0, "095741", "USD/MXN", "按比索强弱算，套息货币"),
    ("brl", "USDBRL=X", "巴西雷亚尔", "macro-fx", "fx", True, 0, "102741", "USD/BRL", "按雷亚尔强弱算"),
    ("zt", "ZT=F", "2年美债期货", "macro-rates", "future", False, 2000, "042601", "ZT", "涨=短端利率在降"),
    ("zn", "ZN=F", "10年美债期货", "macro-rates", "future", False, 1000, "043602", "ZN", "涨=长端利率在降"),
    ("zb", "ZB=F", "30年美债期货", "macro-rates", "future", False, 1000, "020601", "ZB", "涨=超长端利率在降"),
    ("es", "ES=F", "标普500期货", "macro-index", "future", False, 50, "13874A", "ES", "大钱押整个美股的地方"),
    ("nq", "NQ=F", "纳指100期货", "macro-index", "future", False, 20, "209742", "NQ", "科技股的期货"),
    ("rty", "RTY=F", "罗素2000期货", "macro-index", "future", False, 50, "239742", "RTY", "小盘股的期货"),
    ("vx", "^VIX", "恐慌指数", "macro-index", "index", False, 1000, "1170E1", "VIX", "VIX 期货价拿不到，用指数代替"),
    ("cl", "CL=F", "WTI原油", "macro-energy", "future", False, 1000, "067651", "CL", "美国原油"),
    ("bz", "BZ=F", "布伦特原油", "macro-energy", "future", False, 1000, None, "BZ", "国际油价基准"),
    ("ng", "NG=F", "天然气", "macro-energy", "future", False, 10000, "023651", "NG", "美国天然气（亨利港）"),
    ("ho", "HO=F", "柴油", "macro-energy", "future", False, 42000, "022651", "HO", "纽约港超低硫柴油"),
    ("rb", "RB=F", "汽油", "macro-energy", "future", False, 42000, "111659", "RB", "RBOB 汽油"),
    ("gc", "GC=F", "黄金", "macro-metals", "future", False, 100, "088691", "GC", "避险之王"),
    ("si", "SI=F", "白银", "macro-metals", "future", False, 5000, "084691", "SI", "半避险半工业"),
    ("hg", "HG=F", "铜", "macro-metals", "future", False, 25000, "085692", "HG", "铜博士：经济和电网的体温计"),
    ("pl", "PL=F", "铂金", "macro-metals", "future", False, 50, "076651", "PL", "汽车催化剂和氢能"),
    ("zc", "ZC=F", "玉米", "macro-ags", "future", False, 50, "002602", "ZC", "饲料和乙醇"),
    ("zs", "ZS=F", "大豆", "macro-ags", "future", False, 50, "005602", "ZS", "中国是最大买家"),
    ("zw", "ZW=F", "小麦", "macro-ags", "future", False, 50, "001602", "ZW", "芝加哥软红冬麦"),
]
INSTRUMENTS = [{"key": k, "sym": s, "name": n, "group": g, "kind": kd, "invert": inv, "mult": m, "cftc": c,
                "quote": q, "note": note, "id": "m:" + k.upper()}
               for k, s, n, g, kd, inv, m, c, q, note in _I]
BY_KEY = {x["key"]: x for x in INSTRUMENTS}
# extra symbols fetched for context (not territories)
# USDCNY=X (onshore, daily) only fills USD/CNH days before its hourly history starts (macro/build.py fetch_prices)
EXTRA = {"vix3m": "^VIX3M", "cny_onshore": "USDCNY=X"}

# (up, down) one-liners in the §12 voice. Up = strength rising / money flowing in.
FLAVOR = {
    "dxy": ("美元在吸血，全世界的钱往美国跑。", "美元在泄气，钱开始往美国外面跑。"),
    "eur": ("欧元被买，钱在回流欧洲。", "欧元被抛，钱在逃离欧洲。"),
    "jpy": ("日元被抢，套息交易在平仓，杠杆要小心。", "日元继续被当提款机，套息交易还在加码。"),
    "cnh": ("人民币在走强，钱在往中国回流。", "人民币被压着，钱在往外溜。"),
    "gbp": ("英镑被买，伦敦在回血。", "英镑被抛，没人想留在英国。"),
    "aud": ("澳元在涨，市场在押全球增长和大宗商品。", "澳元在跌，风险偏好在退潮。"),
    "cad": ("加元被买，北边的钱在回来。", "加元被抛，北边的钱在撤。"),
    "chf": ("瑞郎被抢，有人在买避险。", "瑞郎被抛，避险情绪在退。"),
    "krw": ("韩元走强，外资在回韩国。", "韩元走弱，外资在撤韩国。"),
    "inr": ("卢比走强，钱在进印度。", "卢比走弱，钱在离开印度。"),
    "mxn": ("比索走强，套息的钱在进墨西哥。", "比索被抛，套息交易在撤。"),
    "brl": ("雷亚尔走强，钱在进巴西。", "雷亚尔被抛，钱在逃离巴西。"),
    "zt": ("2年美债被买，市场在押降息。", "2年美债被抛，市场在赌美联储不松口。"),
    "zn": ("10年美债被买，钱在躲进长债。", "10年美债被抛，利率往上顶，估值要被压。"),
    "zb": ("30年美债被抢，有人在押经济要冷。", "30年美债被砸，长端在要更高的利息。"),
    "es": ("标普期货在被加仓，大钱在进场。", "标普期货在被减仓，大钱在撤。"),
    "nq": ("纳指期货被抢，科技股的钱还在涌。", "纳指期货被抛，科技股的钱在撤。"),
    "rty": ("小盘股期货被买，钱开始往小公司走。", "小盘股期货被抛，小公司没人要。"),
    "vx": ("恐慌在升温，有人在花钱买保险。", "恐慌在退潮，没人愿意买保险。"),
    "cl": ("油价在冲，通胀的火又被点着了。", "油价在跌，通胀压力松了口气。"),
    "bz": ("布伦特在涨，全球的油价在一起往上顶。", "布伦特在跌，全球需求在降温。"),
    "ng": ("天然气在涨，电费账单要跟着涨。", "天然气在跌，气多得用不完。"),
    "ho": ("柴油在涨，卡车和工厂的成本在升。", "柴油在跌，运输成本松了口气。"),
    "rb": ("汽油在涨，加油站的账单要变贵。", "汽油在跌，消费者的钱包松了点。"),
    "gc": ("黄金又被抢，有人在为最坏情况买保险。", "黄金被抛，避险的钱在撤。"),
    "si": ("白银被抢，投机的钱在冲。", "白银被抛，投机的钱在跑。"),
    "hg": ("铜在涨，“铜博士”说经济还撑得住。", "铜在跌，“铜博士”在说经济要冷。"),
    "pl": ("铂金被买，冷门金属也有人抢了。", "铂金被抛，冷门金属没人要。"),
    "zc": ("玉米在涨，饲料和乙醇的成本在升。", "玉米在跌，农民的日子不好过。"),
    "zs": ("大豆在涨，食品成本又在往上走。", "大豆在跌，买家一点不急。"),
    "zw": ("小麦在涨，粮价又在添火。", "小麦在跌，粮食不缺。"),
}
