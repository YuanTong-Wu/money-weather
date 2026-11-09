"""Finer units for HQs whose hq.json point is a city centre (DESIGN §26 amendment 4; refine round 2026-10-28).

The critics found whole cities piled into one district: 上海 66 % of its listed money in 黄浦区, 北京 43 % in 东城区,
London 60 % in Westminster (City of London and Canary Wharf empty), every Mumbai company in Mumbai Suburban. The
hq.json point of a company with no street address is the city's GeoNames centre, which falls in one central unit.
This module adds the evidence that names the real unit, strongest first:

  1. the street address names the unit            (build_admin2.Locator.refine: cninfo 办公地址, Yahoo address —
                                                   now with real pinyin readings, 'Pudong New Area', the A-share
                                                   twin's cninfo address for H-shares / ADRs, and the zone tables
                                                   below for 张江 → 浦东新区, Admiralty → 中西区 …)
  2. the postcode places the HQ                   (postal(): GeoNames postal codes, CC BY 4.0 — GB full postcodes,
                                                   SG, KR, JP, AU, CA, CH, DE, FR, NL, SE, BR points; US ZIP county;
                                                   Mumbai PIN ranges for Mumbai City vs Mumbai Suburban)
  3. a postcode that address-confirmed HQs share  (learned(): CN 6-digit / TW 3-digit postcodes, only when every
                                                   confirmed HQ with that code sits in the same unit)

and marks what stays a guess: units.json `guess[ticker] = level` — the unit at that level and below comes from a
city-centre (or stand-in) point, not from an address: the hover must not name that district as fact (区不详 / 估).
"""
from __future__ import annotations

import json
import math
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

GEO = Path(__file__).resolve().parent
POSTAL = GEO / 'geonames.nosync' / 'postal'
TABLES = GEO / 'tables'

# ── zone / neighbourhood tables (address words that name a unit without its own name) ─────────────────────
# {parent unit id (a2 for CN admin3, 'CN-HK' a1 for HK admin2): {unit name_zh: [regex, …]}}. Only used when the
# address names no unit itself. Each entry is a well-known zone whose land lies in that unit as DataV draws it.
ZONES = {
    'CN-310000': {  # 上海
        '浦东新区': [r'zhangjiang', r'lujiazui', r'jinqiao', r'waigaoqiao', r'lingang', r'pilot free trade zone',
                 r'free trade (test |pilot )?zone', r'chuansha', r'kangqiao', r'zhoupu', r'huamu', r'tangzhen',
                 r'gaoqiao', r'sanlin', r'beicai', r'nanhui', r'huinan', r'zhuqiao', r'datuan', r'shuyuan',
                 r'nicheng', r'hangtou', r'gaodong', r'caolu', r'heqing', r'jinyang', r'yangjing', r'weifang',
                 r'tangqiao', r'zhangjiang hi-?tech', r'expo'],
        '闵行区': [r'xinzhuang', r'qibao', r'zizhu', r'maqiao', r'wujing', r'meilong', r'huacao', r'zhuanqiao',
                r'pujiang town', r'jiangchuan', r'gumei', r'hongqiao town'],
        '徐汇区': [r'caohejing(?!.*pujiang)', r'xujiahui', r'tianlin', r'kangjian', r'huajing', r'longhua',
                r'xuhui'],
        '静安区': [r'shibei', r'pengpu', r'daning'],
        '杨浦区': [r'wujiaochang', r'xinjiangwancheng', r'kongjiang', r'pingliang'],
        '松江区': [r'jiuting', r'sijing', r'chedun', r'dongjing', r'sheshan', r'xiaokunshan', r'xinbang', r'yexie'],
        '嘉定区': [r'anting', r'malu', r'nanxiang', r'jiangqiao', r'huating', r'waigang', r'xuhang', r'juyuan'],
        '青浦区': [r'xujing', r'zhaoxiang', r'huaxin', r'baihe', r'chonggu', r'zhujiajiao', r'jinze', r'liantang',
                r'xiayang', r'yingpu'],
        '宝山区': [r'luodian', r'yuepu', r'gucun', r'yanghang', r'dachang', r'miaohang', r'songnan', r'luojing',
                r'wusong', r'zhangmiao'],
        '奉贤区': [r'nanqiao', r'zhuanghang', r'zhelin', r'situan', r'jinhui', r'qingcun', r'haiwan', r'fengcheng'],
        '金山区': [r'jinshanwei', r'zhujing', r'fengjing', r'tinglin', r'caojing', r'shanyang', r'langxia'],
        '普陀区': [r'zhenru', r'changfeng', r'taopu', r'ganquan', r'yichuan'],
        '长宁区': [r'linkong', r'xianxia', r'beixinjing', r'xinjing town'],
        '虹口区': [r'north bund', r'quyang', r'liangcheng'],
        '崇明区': [r'changxing island', r'hengsha'],
    },
    'CN-110000': {  # 北京
        '海淀区': [r'zhongguancun', r'shangdi', r'xierqi', r'wudaokou', r'xueyuan road', r'xibeiwang', r'yongfeng',
                r'zhichun', r'qinghe', r'wanliu', r'sijiqing', r'xisanqi', r'suzhou street', r'haidian'],
        '朝阳区': [r'wangjing', r'jiuxianqiao', r'jianguomenwai', r'guomao', r'china world', r'sanlitun',
                r'liangmaqiao', r'chaowai', r'dongsanhuan', r'east (3rd|third) ring', r'east (4th|fourth) ring',
                r'jinsong', r'shuangjing', r'dawang', r'jintai', r'yayuncun', r'datun', r'anzhen', r'sanyuanqiao',
                r'lufthansa', r'chaoyang park', r'jinghui', r'guanghua road'],
        '西城区': [r'financial street', r'jinrong (street|dajie|st)', r'fuxingmen', r'fuchengmen', r'xidan',
                r'xizhimen', r'xuanwumen', r'deshengmen', r'yuetan', r'guanganmen', r'xicheng'],
        '东城区': [r'dongcheng', r'wangfujing', r'chaoyangmen', r'jianguomennei', r'dongzhimen', r'andingmen',
                r'dongsi', r'dongdan', r'chongwenmen', r'yonghegong', r'beixinqiao'],
        '大兴区': [r'yizhuang', r'beijing economic[- ]?(and[- ])?technological development', r'\bbda\b', r'daxing'],
        '昌平区': [r'changping', r'huilongguan', r'tiantongyuan', r'future science (city|park)', r'life science park',
                r'xiaotangshan', r'beiqijia', r'nanshao'],
        '顺义区': [r'shunyi', r'tianzhu', r'konggang', r'houshayu'],
        '丰台区': [r'fengtai', r'lize'],
        '石景山区': [r'shijingshan', r'shougang'],
        '房山区': [r'fangshan', r'liangxiang'],
        '怀柔区': [r'huairou', r'yanqi'],
    },
    'CN-440300': {  # 深圳
        '南山区': [r'nanshan', r'shekou', r'qianhai', r'houhai', r'shenzhen bay', r'xili', r'science (and|&) technology park',
                r'hi-?tech industrial park', r'high-?tech industrial park', r'\bkeji\b', r'gaoxin (south|north|middle)',
                r'yuehai', r'taoyuan', r'nantou', r'shahe', r'zhaoshang'],
        '福田区': [r'futian', r'chegongmiao', r'huaqiang', r'xiangmihu', r'lianhua', r'meilin', r'shatou'],
        '罗湖区': [r'luohu', r'dongmen', r'sungang', r'cuizhu', r'qingshuihe', r'huangbeiling'],
        '宝安区': [r"bao'?an", r'xixiang', r'fuyong', r'shajing', r'songgang', r'shiyan', r'hangcheng', r'fuhai',
                r'yanluo'],
        '龙岗区': [r'longgang', r'bantian', r'buji', r'henggang', r'pingdi', r'pinghu', r'longcheng', r'baolong',
                r'nanwan', r'jihua'],
        '龙华区': [r'longhua', r'guanlan', r'dalang', r'minzhi', r'guanhu', r'fucheng'],
        '坪山区': [r'pingshan', r'kengzi'],
        '光明区': [r'guangming', r'gongming'],
        '盐田区': [r'yantian', r'shatoujiao'],
    },
    'CN-440100': {  # 广州
        '天河区': [r'tianhe', r'zhujiang new town', r'zhujiang xincheng', r'huacheng avenue', r'linhe'],
        '海珠区': [r'haizhu', r'pazhou'],
        '黄埔区': [r'huangpu', r'science city', r'guangzhou (high|hi)-?tech', r'guangzhou economic (and|&) technological',
                r'guangzhou development district', r'luogang'],
        '番禺区': [r'panyu', r'dashi'],
        '南沙区': [r'nansha'],
        '白云区': [r'baiyun'],
        '越秀区': [r'yuexiu'],
        '荔湾区': [r'liwan'],
        '增城区': [r'zengcheng', r'xintang'],
        '花都区': [r'huadu'],
    },
    'CN-330100': {  # 杭州
        '滨江区': [r'binjiang', r'hangzhou (high|hi)-?tech', r'hi-?tech (industrial )?(development )?zone'],
        '余杭区': [r'yuhang', r'xixi', r'future sci(ence)?[- ]?(and )?tech(nology)? city', r'wuchang', r'liangzhu',
                r'cangqian'],
        '钱塘区': [r'qiantang', r'xiasha', r'hangzhou economic (and|&) technological', r'\bheda\b', r'dajiangdong'],
        '萧山区': [r'xiaoshan'],
        '西湖区': [r'xihu', r'west lake', r'zhuantang', r'sandun'],
        '上城区': [r'qianjiang new city', r'qianjiang century city'],
        '临平区': [r'linping'],
    },
    'CN-120000': {  # 天津
        '滨海新区': [r'binhai', r'\bteda\b', r'tianjin economic[- ]?(and[- ])?technological development', r'tianjin port',
                 r'airport economic', r'tanggu', r'hangu', r'dagang', r'free trade', r'yujiapu', r'lingang'],
    },
    'CN-610100': {  # 西安
        '未央区': [r"xi'?an economic (and|&) technological development"],
        '雁塔区': [r"xi'?an (high|hi)-?tech", r'qujiang', r'gaoxin'],
        '灞桥区': [r'chanba'],
    },
    'CN-420100': {  # 武汉
        '洪山区': [r'optics valley', r'guanggu'],   # (not the whole East Lake zone: it reaches into 江夏区)
    },
    'CN-340100': {  # 合肥
        '蜀山区': [r'hefei (high|hi)-?tech', r'hefei economic (and|&) technological'],
    },
    'CN-510100': {'郫都区': [r'west(ern)? (high|hi)-?tech (zone|district)', r'high-?tech (west|western) zone',
                          r'western park hi-?tech']},  # 成都
    'CN-320100': {  # 南京
        '栖霞区': [r'nanjing economic (and|&) technological', r'xianlin'],
        '江宁区': [r'qilin'],
    },
    'CN-320500': {  # 苏州 (DataV draws the Suzhou Industrial Park's land inside 吴中区)
        '虎丘区': [r'suzhou new (district|area)', r'\bsnd\b', r'suzhou national new', r'suzhou (high|hi)-?tech'],
        '吴中区': [r'suzhou industrial park', r'\bsip\b', r'jinji lake', r'dushu lake'],
    },
    'CN-320200': {'新吴区': [r'wuxi new (district|area)', r'wuxi national (high|hi)-?tech']},  # 无锡
    'CN-370200': {'黄岛区': [r'west coast new area', r'qingdao economic (and|&) technological']},  # 青岛
    'CN-210200': {'金州区': [r'dalian economic (and|&) technological']},                        # 大连
    'CN-370100': {'历下区': [r'jinan (high|hi)-?tech']},                                        # 济南
    'CN-HK': {  # 香港 18 districts (admin2): neighbourhoods and streets in Yahoo's address / city field
        '中西区': [r'\bcentral\b', r'admiralty', r'sheung wan', r'mid-?levels', r'sai ying pun', r'kennedy town',
                r"queen'?s road central", r'des voeux road', r'connaught (road|place)', r'garden road',
                r'finance street', r'harbour view street', r'queensway', r'cotton tree drive', r'wyndham street',
                r'jervois street', r'tim mei avenue', r'harcourt road', r'ice house street', r'pedder street'],
        '湾仔区': [r'wan ?chai', r'causeway bay', r'happy valley', r'harbou?r road', r'gloucester road', r'hennessy road',
                r'leighton road', r'hysan avenue', r'matheson street', r'times square', r"queen'?s road east",
                r'lee garden', r'tin hau'],
        '东区': [r'north point', r'quarry bay', r'tai ?koo', r"king'?s road", r'java road', r'marble road',
               r'king wah road', r'westlands road', r'island east', r'chai wan', r'shau kei wan', r'sai wan ho'],
        '南区': [r'wong chuk hang', r'aberdeen', r'ap lei chau', r'cyberport', r'pok fu lam', r'island south',
               r'heung yip road'],
        '油尖旺区': [r'tsim sha tsui', r'mong ?kok', r'yau ma tei', r'jordan road', r'austin road west', r'canton road',
                 r'harbour city', r'salisbury road', r'nathan road', r'kowloon station', r'union square'],
        '深水埗区': [r'cheung sha wan', r'sham shui po', r'lai chi kok', r'mei foo'],
        '九龙城区': [r'hung hom', r'kowloon city', r'to kwa wan', r'ho man tin', r'kowloon tong', r'kai tak',
                 r'hung luen road'],
        '黄大仙区': [r'wong tai sin', r'diamond hill', r'san po kong'],
        '观塘区': [r'kwun tong', r'kowloon bay', r'ngau tau kok', r'lam tin', r'yau tong', r'wai yip street',
                r'hoi bun road', r'hung to road', r'sheung yuet road', r'lam hing street', r'telford'],
        '荃湾区': [r'tsuen wan'],
        '屯门区': [r'tuen mun'],
        '元朗区': [r'yuen long', r'tin shui wai'],
        '北区': [r'sheung shui', r'fanling'],
        '西贡区': [r'tseung kwan o', r'sai kung'],
        '沙田区': [r'sha ?tin', r'fo tan', r'shek mun', r'ma on shan', r'tai wai'],
        '葵青区': [r'kwai chung', r'kwai fong', r'tsing yi', r'kwai cheong'],
        '离岛区': [r'lantau', r'tung chung', r'chek lap kok', r'airport', r'discovery bay'],
    },
}
# the same zones as cninfo writes them (Chinese 办公地址). Regexes; generic words ('开发区', '高新区') only with the
# city in front, so '南京市江宁经济技术开发区' or '合肥新站高新区' never land in the main zone's district.
C = r'(市)?(国家)?'
ZONES_ZH = {
    'CN-310000': {'浦东新区': ['张江', '陆家嘴', '金桥', '外高桥', '临港', '自由贸易试验区', '自贸试验区', '川沙', '康桥', '周浦',
                           '唐镇', '高桥镇', '三林', '北蔡', '南汇', '惠南', '祝桥', '航头'],
                  '闵行区': ['紫竹', '莘庄', '七宝', '马桥', '吴泾', '梅陇', '华漕', '颛桥', '浦江镇', '江川路'],
                  '徐汇区': ['漕河泾', '徐家汇'], '静安区': ['市北高新'], '杨浦区': ['五角场'],
                  '松江区': ['九亭', '泗泾', '车墩', '洞泾', '佘山', '小昆山'], '嘉定区': ['安亭', '马陆', '南翔', '江桥镇', '外冈'],
                  '青浦区': ['徐泾', '赵巷', '华新镇', '白鹤镇', '朱家角'], '宝山区': ['罗店', '月浦', '顾村', '杨行', '罗泾'],
                  '奉贤区': ['南桥镇', '庄行', '柘林', '四团', '金汇镇', '青村', '海湾镇'],
                  '金山区': ['金山卫', '朱泾', '枫泾', '亭林', '漕泾']},
    'CN-110000': {'海淀区': ['中关村', '上地', '西二旗', '五道口', '学院路'],
                  '朝阳区': ['望京', '酒仙桥', '建国门外', '国贸', '三里屯', '亮马桥'],
                  '西城区': ['金融大街', '复兴门', '阜成门', '西单', '西直门', '宣武门'],
                  '东城区': ['王府井', '朝阳门', '建国门内', '东直门'],
                  '大兴区': ['亦庄', '北京' + C + '经济技术开发区', '北京经济开发区'],
                  '昌平区': ['未来科学城', '回龙观', '生命科学园']},
    'CN-440300': {'南山区': ['深圳' + C + '高新技术产业园', '科技园', '前海', '蛇口', '后海', '深圳湾'],
                  '福田区': ['车公庙', '华强', '香蜜湖', '福田保税区']},
    'CN-440100': {'黄埔区': ['科学城', '广州' + C + '(高新技术产业开发区|经济技术开发区|开发区)', '萝岗'],
                  '天河区': ['珠江新城'], '海珠区': ['琶洲']},
    'CN-330100': {'余杭区': ['未来科技城', '仓前', '良渚'],
                  '钱塘区': ['杭州' + C + '经济技术开发区', '下沙', '大江东'], '滨江区': ['杭州' + C + '高新']},
    'CN-120000': {'滨海新区': ['天津' + C + '经济技术开发区', '泰达', '天津港', '保税区', '自由贸易试验区', '空港经济区', '塘沽',
                           '汉沽', '大港', '于家堡']},
    'CN-610100': {'未央区': ['西安' + C + '经济技术开发区', '西安经开区'], '雁塔区': ['西安' + C + '高新', '曲江'],
                  '灞桥区': ['浐灞'], '长安区': ['航天基地', '航天城']},
    'CN-420100': {'洪山区': ['光谷']},
    'CN-340100': {'蜀山区': ['合肥' + C + '高新', '合肥' + C + '经济技术开发区', '合肥经开区']},
    'CN-320100': {'栖霞区': ['南京' + C + '经济技术开发区', '仙林'], '江宁区': ['麒麟']},
    'CN-320500': {'虎丘区': ['苏州' + C + '高新', '苏州新区'], '吴中区': ['苏州' + C + '工业园区']},
    'CN-320200': {'新吴区': ['无锡' + C + '新区', '无锡' + C + '高新']},
    'CN-370200': {'黄岛区': ['西海岸新区', '青岛' + C + '经济技术开发区']},
    'CN-210200': {'金州区': ['大连' + C + '经济技术开发区']},
    'CN-370100': {'历下区': ['济南' + C + '高新']},
    'CN-430100': {'岳麓区': ['长沙' + C + '高新'], '长沙县': ['长沙' + C + '经济技术开发区', '星沙']},
    'CN-220100': {'朝阳区': ['长春' + C + '高新']},
    'CN-510100': {'郫都区': ['高新西区', '郫县']},   # 成都高新西区 lies in 郫都区 (old name 郫县)
}
for _a, _d in ZONES_ZH.items():
    for _z, _ws in _d.items():
        ZONES.setdefault(_a, {}).setdefault(_z, []).extend(_ws)
_ZONES_RE = {a: {z: [re.compile(r, re.I) for r in rs] for z, rs in d.items()} for a, d in ZONES.items()}


def zone_match(groups, parent, cands):
    """The single candidate unit (id) a zone / neighbourhood word points to, else None. `groups` = address strings
    in order of trust (Yahoo's city field, the street line, the building line); the first that names exactly one
    unit wins, then all of them together ('Central Plaza … Harbour Road | Wan Chai' → 湾仔区 from the city field)."""
    tab = _ZONES_RE.get(parent)
    if not tab:
        return None
    by_zh = {p.get('name_zh'): uid for uid, p in cands}

    def hits(text):
        out = set()
        for zh, res in tab.items():
            if zh in by_zh and any(r.search(text) for r in res):
                out.add(by_zh[zh])
        return out
    groups = [g for g in groups if g]
    for g in groups + [' | '.join(groups)]:
        h = hits(g)
        if len(h) == 1:
            return h.pop()
    return None


# ── GeoNames postal codes ─────────────────────────────────────────────────────────────────────────────────
# Only where the codes are precise (GB / CA full postcodes, SG buildings, KR 국가기초구역, JP 町, AU suburbs) and the
# metros are split into several units. Not CH / DE / FR / NL / SE / BR: their Yahoo codes are often PO boxes
# (Julius Bär 'Zurich 8010' = the Mülligen mail centre, Atlas Copco 'Nacka 105 23', Dassault 'Saint-Cloud 75008');
# not IN: GeoNames' PIN points and districts are approximate (Connaught Place 110001 → 'Central Delhi').
POSTAL_FILES = {'GB': 'GB_full.csv.zip', 'CA': 'CA_full.csv.zip', 'US': 'US.zip', 'IN': 'IN.zip', 'JP': 'JP.zip',
                'KR': 'KR.zip', 'SG': 'SG.zip', 'AU': 'AU.zip'}
BORDER_KM = {'GB': 0.05, 'SG': 0.05}   # a postcode / street point this close to the old unit is too close to call
BORDER_KM_DEFAULT = 0.3
CITY_IS_UNIT = {'JP', 'KR'}   # Yahoo's city names the unit: a postcode elsewhere is a typo or a corporate code
POSTAL_URL = 'https://download.geonames.org/export/zip/'
# how far (km) a postcode point may lie from the hq.json city point and still be "the same city" (the hq city is
# Yahoo's own city, so the postcode belongs to it; the bound only catches typos and registered-office mix-ups)
POSTAL_KM = {'US': 45, 'CA': 40, 'AU': 40, 'BR': 40, 'IN': 40}
POSTAL_KM_DEFAULT = 30


def _pc_norm(cc, z):
    z = (z or '').strip().upper()
    if cc in ('GB', 'CA'):
        z = re.sub(r'\s+', '', z)
        return z[:-3] + ' ' + z[-3:] if len(z) > 3 else z
    if cc in ('NL',):
        return re.sub(r'\s+', '', z)[:4]
    if cc in ('SE',):
        return re.sub(r'\D', '', z)[:5]
    if cc == 'JP':
        d = re.sub(r'\D', '', z)
        return d[:3] + '-' + d[3:] if len(d) == 7 else None
    if cc == 'BR':
        d = re.sub(r'\D', '', z)
        return d[:5] + '-' + d[5:] if len(d) == 8 else None
    if cc in ('US',):
        d = re.sub(r'\D', '', z)
        return d[:5] if len(d) >= 5 else None
    if cc in ('IN',):
        d = re.sub(r'\D', '', z)
        return d if len(d) == 6 else None
    return re.sub(r'\s+', '', z) or None


class Postal:
    def __init__(self, fetch=None, log=print):
        self.idx = {}
        self.fetch = fetch
        self.log = log

    def rows(self, cc, code):
        if cc not in POSTAL_FILES:
            return []
        if cc not in self.idx:
            self.idx[cc] = self._load(cc)
        if not code:
            return []
        r = self.idx[cc].get(code)
        if r or cc not in ('GB', 'CA'):
            return r or []
        # a postcode newer than the dump: the sector ('E14 5') / FSA ('M2N')
        out = []
        pre = code[:-2] if cc == 'GB' else code[:3]
        for k, v in self.idx[cc].items():
            if k.startswith(pre):
                out += v
        return out

    def _load(self, cc):
        p = POSTAL / POSTAL_FILES[cc]
        if not p.exists() and self.fetch:
            p.parent.mkdir(parents=True, exist_ok=True)
            self.fetch(POSTAL_URL + POSTAL_FILES[cc], p)
        if not p.exists():
            return {}
        z = zipfile.ZipFile(p)
        name = next(n for n in z.namelist() if n.endswith('.txt') and 'readme' not in n.lower())
        idx = defaultdict(list)
        for line in z.read(name).decode('utf-8').splitlines():
            c = line.split('\t')
            if len(c) < 11 or not c[9] or not c[10]:
                continue
            k = _pc_norm(cc, c[1]) if cc not in ('GB', 'CA') else c[1].strip().upper()
            if not k:
                continue
            idx[k].append({'place': c[2], 'a1': c[3], 'a2': c[5].strip(), 'a2c': c[6].strip(), 'a3': c[7].strip(),
                           'a3c': c[8].strip(), 'lat': float(c[9]), 'lon': float(c[10]),
                           'acc': int(c[11]) if len(c) > 11 and c[11].strip().isdigit() else None})
        return idx


ZCTA_REL = GEO / 'admin2.nosync' / 'src' / 'census_rel' / 'zcta_county.txt'
ZCTA_REL_URL = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt'
_ZCTA = {}


def zcta_county_share(z):
    """{'US-<county fips>': share of the ZCTA's land} from the Census 2020 ZCTA–county relationship file."""
    if 'd' not in _ZCTA:
        d = defaultdict(dict)
        if ZCTA_REL.exists():
            with open(ZCTA_REL, encoding='utf-8-sig') as f:
                head = f.readline().rstrip('\n').split('|')
                iz, ic, ia, ip = (head.index(k) for k in ('GEOID_ZCTA5_20', 'GEOID_COUNTY_20', 'AREALAND_ZCTA5_20',
                                                           'AREALAND_PART'))
                for line in f:
                    c = line.rstrip('\n').split('|')
                    if not c[iz] or not c[ia]:
                        continue
                    tot = float(c[ia] or 0)
                    if tot > 0:
                        d[c[iz]]['US-' + c[ic]] = float(c[ip] or 0) / tot
        _ZCTA['d'] = d
    return _ZCTA['d'].get(z, {})


# Mumbai: GeoNames gives district "Mumbai" for both Mumbai City and Mumbai Suburban PINs. India Post PINs
# 400001–400039 are the island city (Colaba … Mahim / Sion / Wadala), except 400024 (Nehru Nagar, Kurla) and
# 400029 (Santacruz airport); 400040–400104 are the suburbs (Bandra-Kurla Complex 400051, Andheri, Powai …).
def mumbai_pin(pin):
    if not pin or not re.fullmatch(r'400\d{3}', pin):
        return None
    n = int(pin[3:])
    if 1 <= n <= 39 and n not in (24, 29):
        return 'IN-mumbai'
    if 40 <= n <= 104 or n in (24, 29):
        return 'IN-mumbai-suburban'
    return None


def _unit_word_strip(s):
    s = (s or '').lower()
    s = re.sub(r'\b(county|parish|borough|city and borough|census area|municipality|district|dist|ku|shi|gun|gu|'
               r'si|city|of)\b', ' ', s)
    return re.sub(r'[^a-z]+', '', s)


def load_moved(tables=TABLES):
    """Tickers whose hq.json city is not Yahoo's (ops.tsv / overrides.tsv): their Yahoo postcode / address is the
    registered office, not the place the map uses."""
    out = set()
    for f in ('ops.tsv', 'overrides.tsv'):
        p = tables / f
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if not line.strip() or line.startswith('#'):
                continue
            c = line.split('\t')
            if len(c) > 1 and c[1].strip() and c[1].strip() != '=':
                out.add(c[0].strip())
    return out


def km(lon1, lat1, lon2, lat2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(max(0.0, a)))


def postal_refine(L, P, t, cc, zipc, lon, lat, tri, inner_point, unit_name, yf_city=''):
    """([a1, a2, a3, lon, lat], how) — or (None, confirmed). The postcode's point (majority unit of its GeoNames
    rows) replaces a city-centre point when it lands in another unit of the same city (≤ POSTAL_KM); confirmed =
    the postcode lands in the unit the point is already in."""
    code = _pc_norm(cc, zipc)
    if not code:
        return None, False
    if cc == 'IN':
        mu = mumbai_pin(code)
        if mu:
            if mu == tri[1]:
                return None, True
            sh = L.sh2('IN')
            rings = next((r for uid, _, r, _ in sh.items if uid == mu), None)
            if rings is None:
                return None, False
            x, y = inner_point(rings)
            if km(lon, lat, x, y) > POSTAL_KM['IN']:
                return None, False
            a1 = next(p.get('a1') for uid, p, _, _ in sh.items if uid == mu)
            return [a1, mu, None, x, y], 'pin-mumbai'
        return None, False   # other Indian PINs: GeoNames is too coarse to split a city
    rows = P.rows(cc, code)
    if not rows:
        return None, False
    lim = POSTAL_KM.get(cc, POSTAL_KM_DEFAULT)
    votes = Counter()
    pts = defaultdict(list)
    for r in rows:
        if km(lon, lat, r['lon'], r['lat']) > lim:
            continue
        got, c2, how = L.locate(r['lon'], r['lat'], cc)
        if not got[1] or c2 != cc:
            continue
        key = tuple(got)
        votes[key] += 1
        pts[key].append((r['lon'], r['lat'], r))
    if not votes:
        return None, False
    (best, n), = votes.most_common(1)
    if n < 0.6 * sum(votes.values()):
        return None, False
    best = list(best)
    if best[1] == tri[1] and (best[2] == tri[2] or not best[2]):
        return None, (cc != 'US' or not tri[2])
    xs = sorted(p[0] for p in pts[tuple(best)])
    ys = sorted(p[1] for p in pts[tuple(best)])
    x, y = xs[len(xs) // 2], ys[len(ys) // 2]
    # the median point must itself sit in that unit (else the unit's inner point)
    chk, _, _ = L.locate(x, y, cc)
    if chk[1] != best[1] or (best[2] and chk[2] != best[2]):
        x, y = pts[tuple(best)][0][:2]
    if cc == 'US':
        # ZIP centroids straddle Census places: only a different COUNTY, and only when the Census ZCTA–county
        # relationship file puts most of the ZIP's land there (30339 Home Depot: 96 % Cobb, the city point is Fulton)
        # (no street geocode reached this far): also the ZIP's own place name must be Yahoo's city — a typo'd ZIP
        # (Alkami: 'Plano 75204', 75204 is Dallas) must not move a company
        share = zcta_county_share(code)
        places = {re.sub(r'[^a-z]', '', p[2]['place'].lower()) for p in pts[tuple(best)]}
        yc = re.sub(r'[^a-z]', '', (yf_city or '').lower().replace('saint ', 'st').replace('st. ', 'st'))
        places = {x.replace('saint', 'st') for x in places}
        if best[1] == tri[1] or share.get(best[1], 0) < 0.7 or yc not in places:
            return None, False
    if cc in CITY_IS_UNIT and best[1] != tri[1]:
        yc = _unit_word_strip(yf_city)
        if yc and yc == _unit_word_strip(unit_name(tri[1])):
            return None, False
    if near_border(L, tri, x, y, BORDER_KM.get(cc, BORDER_KM_DEFAULT)):
        return None, False
    return [best[0], best[1], best[2], round(x, 5), round(y, 5)], 'postal'


def near_border(L, tri, x, y, lim=BORDER_KM_DEFAULT):
    """the new point lies within `lim` km of the old (deepest) unit — simplified borders cannot tell"""
    _, rings = L.unit_props(tri[2] or tri[1])
    if not rings:
        return False
    import numpy as np  # noqa
    c = math.cos(math.radians(y))
    best = 1e9
    for r in rings:
        dx = (r[:, 0] - x) * 111.32 * c
        dy = (r[:, 1] - y) * 110.57
        x1, y1, x2, y2 = dx[:-1], dy[:-1], dx[1:], dy[1:]
        ex, ey = x2 - x1, y2 - y1
        LL = ex * ex + ey * ey
        t = np.where(LL > 0, np.clip(-(x1 * ex + y1 * ey) / np.where(LL > 0, LL, 1), 0, 1), 0)
        px, py = x1 + t * ex, y1 + t * ey
        if len(px):
            best = min(best, float(np.sqrt((px * px + py * py).min())))
    return best < lim


# ── US street addresses: US Census Bureau batch geocoder (public domain) ─────────────────────────────────────
GEOCODE_DIR = GEO / 'admin2.nosync' / 'src' / 'census_geocode'
GEOCODE_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/addressbatch'
_GC = {}


def census_points():
    """{ticker: (lon, lat)} — Yahoo street address of US HQs matched by the Census geocoder (us_out.csv; rebuild:
    tools in units_README.md). Only 'Match' rows."""
    if 'd' not in _GC:
        d = {}
        p = GEOCODE_DIR / 'us_out.csv'
        if p.exists():
            import csv
            with open(p, newline='', encoding='utf-8') as f:
                for r in csv.reader(f):
                    if len(r) >= 6 and r[2] == 'Match' and r[5]:
                        # a Non_Exact match only when it kept the ZIP ('3M Center, 55144' → '3M CENTER DR, 55117': no)
                        zin, zout = r[1].rsplit(',', 1)[-1].strip(), r[4].rsplit(',', 1)[-1].strip()
                        if r[3] != 'Exact' and zin != zout:
                            continue
                        try:
                            x, y = (float(v) for v in r[5].split(','))
                        except ValueError:
                            continue
                        d[r[0]] = (x, y, r[3])
        _GC['d'] = d
    return _GC['d']


def street_refine(L, t, lon, lat, tri):
    """([a1, a2, a3, lon, lat], 'street') or (None, confirmed) from the Census geocode of the HQ street address."""
    g = census_points().get(t)
    if not g:
        return None, False
    x, y, _ = g
    if km(lon, lat, x, y) > 40:
        return None, False
    got, c2, _ = L.locate(x, y, 'US')
    if c2 != 'US' or not got[1]:
        return None, False
    if got[0] != tri[0] and km(lon, lat, x, y) > 15:
        return None, False
    if got[1] == tri[1] and got[2] == tri[2]:
        return None, True
    if near_border(L, tri, x, y, 0.1):
        return None, False
    return [got[0], got[1], got[2], round(x, 5), round(y, 5)], 'street'


# ── postcodes shared with address-confirmed HQs (CN, TW) ───────────────────────────────────────────────────
def learn_codes(confirmed, key, min_n=1):
    """{code: unit} for codes whose confirmed HQs all sit in one unit (and at least min_n of them).
    confirmed = [(code, unit)]."""
    by = defaultdict(Counter)
    for code, unit in confirmed:
        k = key(code)
        if k:
            by[k][unit] += 1
    return {k: next(iter(c)) for k, c in by.items() if len(c) == 1 and sum(c.values()) >= min_n}


def cn_code(z):
    """a 6-digit Chinese postcode that names a delivery area — not a city's / county's main code (xxxx00:
    561000 is all of 安顺, 411100 all of 湘潭)"""
    d = re.sub(r'\D', '', z or '')
    return d if len(d) == 6 and d[0] != '0' and not d.endswith('00') else None


def tw_code(z):
    d = re.sub(r'\D', '', z or '')
    return d[:3] if len(d) in (3, 5, 6) else None


# ── guesses: units that come from a city-centre point ─────────────────────────────────────────────────────
def city_pops(gn_path):
    """{(norm name, cc): [(pop, lon, lat)]} from GeoNames cities15000 (name + ascii + alternates of big cities)."""
    out = defaultdict(list)
    if not gn_path.exists():
        return out
    with open(gn_path, encoding='utf-8') as f:
        for line in f:
            c = line.rstrip('\n').split('\t')
            if len(c) < 15:
                continue
            try:
                pop = int(c[14] or 0)
                lat, lon = float(c[4]), float(c[5])
            except ValueError:
                continue
            names = {c[1], c[2]}
            if pop >= 500000:
                names |= set(c[3].split(',')) if c[3] else set()
            for n in names:
                n = re.sub(r'[^a-z0-9]+', ' ', n.lower()).strip()
                if n:
                    out[(n, c[8])].append((pop, lon, lat))
    return out


def geocode_us(hq, yf_of, log=print, fetch_url=None):
    """Geocode the Yahoo street address of every US HQ not yet in us_out.csv with the Census batch geocoder
    (≤ 10,000 rows per call; public domain). Appends to us_out.csv. Network; run with --fetch-addresses."""
    import csv
    import io
    import urllib.request
    import uuid
    GEOCODE_DIR.mkdir(parents=True, exist_ok=True)
    out = GEOCODE_DIR / 'us_out.csv'
    have = set()
    if out.exists():
        with open(out, newline='', encoding='utf-8') as f:
            have = {r[0] for r in csv.reader(f) if r}
    rows = []
    for t, v in hq.items():
        if v[3] != 'US' or t in have or (len(v) > 5 and v[5] in ('country', 'region', 'nongeo')):
            continue
        d = yf_of(t)
        a1, a2 = (d.get('a1') or '').strip(), (d.get('a2') or '').strip()
        st = a1 if re.match(r'^\d', a1) else a2 if re.match(r'^\d', a2) else a1
        if st and d.get('city') and d.get('state'):
            rows.append([t, st.replace(',', ' '), d['city'], d['state'], (d.get('zip') or '')[:5]])
    if not rows:
        log('geocode-us: nothing new')
        return 0
    n = 0
    for i in range(0, len(rows), 9000):
        buf = io.StringIO()
        csv.writer(buf).writerows(rows[i:i + 9000])
        b = uuid.uuid4().hex
        body = (f'--{b}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\nPublic_AR_Current\r\n'
                f'--{b}\r\nContent-Disposition: form-data; name="vintage"\r\n\r\nCurrent_Current\r\n'
                f'--{b}\r\nContent-Disposition: form-data; name="addressFile"; filename="a.csv"\r\n'
                f'Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{b}--\r\n').encode()
        req = urllib.request.Request(GEOCODE_URL, data=body, headers={'Content-Type': f'multipart/form-data; boundary={b}'})
        with urllib.request.urlopen(req, timeout=1800) as r:
            txt = r.read().decode('utf-8', 'replace')
        with open(out, 'a', encoding='utf-8') as f:
            f.write(txt if txt.endswith('\n') else txt + '\n')
        n += len(rows[i:i + 9000])
    _GC.clear()
    log(f'geocode-us: {n} addresses sent to the Census geocoder')
    return n
