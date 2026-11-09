#!/usr/bin/env python3
"""Admin-1 (state / province / prefecture …) context layer for the real-Earth map — one TopoJSON per market.

Source: Natural Earth 1:10m admin-1 states/provinces (v5.1.1). Output: web/vendor/geo/admin1/<ISO2>.json
(object `admin1`, feature id = ISO 3166-2 code or a documented pseudo-code, properties name / name_zh /
iso_3166_2) + web/vendor/geo/admin1/index.json. See geodata/admin1_README.md.

    python3 geodata/build_admin1.py                 # download (cached) → build all → validate
    python3 geodata/build_admin1.py --only CN,JP    # rebuild some markets (index.json is merged)
    python3 geodata/build_admin1.py --check         # only validate what is on disk
    python3 geodata/build_admin1.py --cap 250       # per-file size cap in KB (default 300)

Needs Python 3 (stdlib only) and Node (mapshaper 0.6 via `npx -y mapshaper@0.6`, or $MAPSHAPER).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'web' / 'vendor' / 'geo' / 'admin1'
VENDOR = ROOT / 'web' / 'vendor'
CACHE_DIR = ROOT / 'geodata' / 'cache' / 'ne_admin1'
NE_ZIP_URL = 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip'
NE_GEOJSON_URL = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
                  'ne_10m_admin_1_states_provinces.geojson')
NE_STEM = 'ne_10m_admin_1_states_provinces'
OBJECT = 'admin1'
CAP_KB = 300          # per file
TOTAL_KB = 6000       # all files together
# Visvalingam interval ladder (metres). The finest step that fits the cap wins; never coarser than needed.
LADDER = [60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650, 800, 1000, 1300, 1600, 2000, 2500, 3200, 4000]

# ── markets ──────────────────────────────────────────────────────────────────────────────────────────────
# ISO2 → expected unit count (validated) and a short note for the README / index.
MARKETS = {
    'US': (51, '50 states + DC'),
    'CN': (34, '31 provinces/regions/municipalities + Hong Kong, Macau, Taiwan as single units'),
    'JP': (47, 'prefectures'),
    'IN': (36, '28 states + 8 union territories'),
    'KR': (17, 'provinces + metropolitan cities'),
    'TW': (21, 'counties/cities (Natural Earth has no Lienchiang/Matsu)'),
    'CA': (13, 'provinces + territories'),
    'AU': (9, '6 states + NT + ACT + Jervis Bay Territory'),
    'BR': (27, '26 states + Federal District'),
    'DE': (16, 'Länder'),
    'GB': (12, '9 English regions (ITL1) + Wales, Scotland, Northern Ireland'),
    'FR': (18, '13 metropolitan regions + 5 overseas regions'),
    'CH': (26, 'cantons'),
    'IT': (20, 'regions'),
    'ES': (19, '17 autonomous communities + Ceuta, Melilla'),
    'NL': (12, 'provinces (Caribbean Netherlands left out)'),
    'SE': (21, 'counties (län)'),
    'MX': (32, '31 states + Mexico City'),
    'ID': (33, 'provinces (Natural Earth 2022: before the 2012 North Kalimantan / 2022 Papua splits)'),
    'SA': (13, 'regions'),
    'ZA': (9, 'provinces'),
    'IL': (6, 'districts'),
}

# ── names ────────────────────────────────────────────────────────────────────────────────────────────────
CN_ZH = {
    'CN-BJ': '北京', 'CN-TJ': '天津', 'CN-HE': '河北', 'CN-SX': '山西', 'CN-NM': '内蒙古', 'CN-LN': '辽宁',
    'CN-JL': '吉林', 'CN-HL': '黑龙江', 'CN-SH': '上海', 'CN-JS': '江苏', 'CN-ZJ': '浙江', 'CN-AH': '安徽',
    'CN-FJ': '福建', 'CN-JX': '江西', 'CN-SD': '山东', 'CN-HA': '河南', 'CN-HB': '湖北', 'CN-HN': '湖南',
    'CN-GD': '广东', 'CN-GX': '广西', 'CN-HI': '海南', 'CN-CQ': '重庆', 'CN-SC': '四川', 'CN-GZ': '贵州',
    'CN-YN': '云南', 'CN-XZ': '西藏', 'CN-SN': '陕西', 'CN-GS': '甘肃', 'CN-QH': '青海', 'CN-NX': '宁夏',
    'CN-XJ': '新疆', 'CN-HK': '香港', 'CN-MO': '澳门', 'CN-TW': '台湾',
}
JP_ZH = [
    '北海道', '青森县', '岩手县', '宫城县', '秋田县', '山形县', '福岛县', '茨城县', '栃木县', '群马县', '埼玉县',
    '千叶县', '东京都', '神奈川县', '新潟县', '富山县', '石川县', '福井县', '山梨县', '长野县', '岐阜县', '静冈县',
    '爱知县', '三重县', '滋贺县', '京都府', '大阪府', '兵库县', '奈良县', '和歌山县', '鸟取县', '岛根县', '冈山县',
    '广岛县', '山口县', '德岛县', '香川县', '爱媛县', '高知县', '福冈县', '佐贺县', '长崎县', '熊本县', '大分县',
    '宫崎县', '鹿儿岛县', '冲绳县',
]
JP_ZH = {f'JP-{i + 1:02d}': z for i, z in enumerate(JP_ZH)}
KR_ZH = {
    'KR-11': '首尔特别市', 'KR-26': '釜山广域市', 'KR-27': '大邱广域市', 'KR-28': '仁川广域市', 'KR-29': '光州广域市',
    'KR-30': '大田广域市', 'KR-31': '蔚山广域市', 'KR-50': '世宗特别自治市', 'KR-41': '京畿道', 'KR-42': '江原特别自治道',
    'KR-43': '忠清北道', 'KR-44': '忠清南道', 'KR-45': '全北特别自治道', 'KR-46': '全罗南道', 'KR-47': '庆尚北道',
    'KR-48': '庆尚南道', 'KR-49': '济州特别自治道',
}
TW_NAMES = {  # ISO → (English, Chinese)
    'TW-TPE': ('Taipei City', '台北市'), 'TW-NWT': ('New Taipei City', '新北市'), 'TW-TAO': ('Taoyuan City', '桃园市'),
    'TW-TXG': ('Taichung City', '台中市'), 'TW-TNN': ('Tainan City', '台南市'), 'TW-KHH': ('Kaohsiung City', '高雄市'),
    'TW-KEE': ('Keelung City', '基隆市'), 'TW-HSZ': ('Hsinchu City', '新竹市'), 'TW-CYI': ('Chiayi City', '嘉义市'),
    'TW-HSQ': ('Hsinchu County', '新竹县'), 'TW-MIA': ('Miaoli County', '苗栗县'), 'TW-CHA': ('Changhua County', '彰化县'),
    'TW-NAN': ('Nantou County', '南投县'), 'TW-YUN': ('Yunlin County', '云林县'), 'TW-CYQ': ('Chiayi County', '嘉义县'),
    'TW-PIF': ('Pingtung County', '屏东县'), 'TW-ILA': ('Yilan County', '宜兰县'), 'TW-HUA': ('Hualien County', '花莲县'),
    'TW-TTT': ('Taitung County', '台东县'), 'TW-PEN': ('Penghu County', '澎湖县'), 'TW-KIN': ('Kinmen County', '金门县'),
    'TW-LIE': ('Lienchiang County', '连江县'),
}
GB_UNITS = {  # NE region (England) / geonunit (others) → (id, iso_3166_2, English, Chinese)
    'North East': ('GB-ENG-NE', 'GB-ENG', 'North East England', '东北英格兰'),
    'North West': ('GB-ENG-NW', 'GB-ENG', 'North West England', '西北英格兰'),
    'Yorkshire and the Humber': ('GB-ENG-YH', 'GB-ENG', 'Yorkshire and the Humber', '约克郡-亨伯'),
    'East Midlands': ('GB-ENG-EM', 'GB-ENG', 'East Midlands', '东米德兰兹'),
    'West Midlands': ('GB-ENG-WM', 'GB-ENG', 'West Midlands', '西米德兰兹'),
    'East': ('GB-ENG-EE', 'GB-ENG', 'East of England', '英格兰东部'),
    'Greater London': ('GB-ENG-LDN', 'GB-ENG', 'London', '伦敦'),
    'South East': ('GB-ENG-SE', 'GB-ENG', 'South East England', '东南英格兰'),
    'South West': ('GB-ENG-SW', 'GB-ENG', 'South West England', '西南英格兰'),
    'Wales': ('GB-WLS', 'GB-WLS', 'Wales', '威尔士'),
    'Scotland': ('GB-SCT', 'GB-SCT', 'Scotland', '苏格兰'),
    'Northern Ireland': ('GB-NIR', 'GB-NIR', 'Northern Ireland', '北爱尔兰'),
}
FR_UNITS = {  # NE region_cod → (ISO 3166-2, English, Chinese)
    'FR-ARA': ('FR-ARA', 'Auvergne-Rhône-Alpes', '奥弗涅-罗讷-阿尔卑斯'),
    'FR-BFC': ('FR-BFC', 'Bourgogne-Franche-Comté', '勃艮第-弗朗什-孔泰'),
    'FR-BRE': ('FR-BRE', 'Brittany', '布列塔尼'),
    'FR-CVL': ('FR-CVL', 'Centre-Val de Loire', '中央-卢瓦尔河谷'),
    'FR-COR': ('FR-20R', 'Corsica', '科西嘉'),
    'FR-GES': ('FR-GES', 'Grand Est', '大东部'),
    'FR-HDF': ('FR-HDF', 'Hauts-de-France', '上法兰西'),
    'FR-IDF': ('FR-IDF', 'Île-de-France', '法兰西岛'),
    'FR-NOR': ('FR-NOR', 'Normandy', '诺曼底'),
    'FR-NAQ': ('FR-NAQ', 'Nouvelle-Aquitaine', '新阿基坦'),
    'FR-OCC': ('FR-OCC', 'Occitanie', '奥克西塔尼'),
    'FR-PDL': ('FR-PDL', 'Pays de la Loire', '卢瓦尔河地区'),
    'FR-PAC': ('FR-PAC', "Provence-Alpes-Côte d'Azur", '普罗旺斯-阿尔卑斯-蓝色海岸'),
    'FR-GUA': ('FR-971', 'Guadeloupe', '瓜德罗普'),
    'FR-MTQ': ('FR-972', 'Martinique', '马提尼克'),
    'FR-GUF': ('FR-973', 'French Guiana', '法属圭亚那'),
    'FR-LRE': ('FR-974', 'Réunion', '留尼汪'),
    'FR-MAY': ('FR-976', 'Mayotte', '马约特'),
}
IT_UNITS = {  # NE region_cod (= ISO 3166-2) → (English, Chinese)
    'IT-21': ('Piedmont', '皮埃蒙特'), 'IT-23': ('Aosta Valley', '瓦莱达奥斯塔'), 'IT-25': ('Lombardy', '伦巴第'),
    'IT-32': ('Trentino-South Tyrol', '特伦蒂诺-上阿迪杰'), 'IT-34': ('Veneto', '威尼托'),
    'IT-36': ('Friuli-Venezia Giulia', '弗留利-威尼斯朱利亚'), 'IT-42': ('Liguria', '利古里亚'),
    'IT-45': ('Emilia-Romagna', '艾米利亚-罗马涅'), 'IT-52': ('Tuscany', '托斯卡纳'), 'IT-55': ('Umbria', '翁布里亚'),
    'IT-57': ('Marche', '马尔凯'), 'IT-62': ('Lazio', '拉齐奥'), 'IT-65': ('Abruzzo', '阿布鲁佐'), 'IT-67': ('Molise', '莫利塞'),
    'IT-72': ('Campania', '坎帕尼亚'), 'IT-75': ('Apulia', '普利亚'), 'IT-77': ('Basilicata', '巴西利卡塔'),
    'IT-78': ('Calabria', '卡拉布里亚'), 'IT-82': ('Sicily', '西西里'), 'IT-88': ('Sardinia', '撒丁'),
}
ES_UNITS = {  # NE region_cod → (ISO 3166-2, English, Chinese); ES.CE holds both Ceuta and Melilla (split by ISO)
    'ES.AN': ('ES-AN', 'Andalusia', '安达卢西亚'), 'ES.AR': ('ES-AR', 'Aragon', '阿拉贡'),
    'ES.AS': ('ES-AS', 'Asturias', '阿斯图里亚斯'), 'ES.CN': ('ES-CN', 'Canary Islands', '加那利群岛'),
    'ES.CB': ('ES-CB', 'Cantabria', '坎塔布里亚'), 'ES.CL': ('ES-CL', 'Castile and León', '卡斯蒂利亚-莱昂'),
    'ES.CM': ('ES-CM', 'Castilla-La Mancha', '卡斯蒂利亚-拉曼恰'), 'ES.CT': ('ES-CT', 'Catalonia', '加泰罗尼亚'),
    'ES-CE': ('ES-CE', 'Ceuta', '休达'), 'ES-ML': ('ES-ML', 'Melilla', '梅利利亚'),
    'ES.EX': ('ES-EX', 'Extremadura', '埃斯特雷马杜拉'), 'ES.NA': ('ES-NC', 'Navarre', '纳瓦拉'),
    'ES.GA': ('ES-GA', 'Galicia', '加利西亚'), 'ES.PM': ('ES-IB', 'Balearic Islands', '巴利阿里群岛'),
    'ES.LO': ('ES-RI', 'La Rioja', '拉里奥哈'), 'ES.MD': ('ES-MD', 'Madrid', '马德里'),
    'ES.MU': ('ES-MC', 'Murcia', '穆尔西亚'), 'ES.PV': ('ES-PV', 'Basque Country', '巴斯克'),
    'ES.VC': ('ES-VC', 'Valencia', '瓦伦西亚'),
}
# Natural Earth code → current ISO 3166-2 code (or our pseudo-code where ISO has none).
ISO_FIX = {
    'TW-TPQ': 'TW-NWT',     # New Taipei (renamed 2010)
    'MX-DIF': 'MX-CMX',     # Mexico City (2016)
    'MX-X01~': 'MX-YUC',    # Arrecife Alacranes (minor island) belongs to Yucatán
    'CN-X01~': 'CN-HI',     # Paracel Islands → Hainan (Sansha)
    'AU-X03~': 'AU-TAS',    # Macquarie Island → Tasmania
    'AU-X02~': 'AU-JBT',    # Jervis Bay Territory (no ISO code; pseudo-code)
}
NO_ISO = {'AU-JBT'}         # pseudo-codes: iso_3166_2 = null
NAME_FIX = {
    'CN-NM': 'Inner Mongolia', 'CN-HK': 'Hong Kong', 'CN-MO': 'Macau', 'CN-TW': 'Taiwan',
    'DE-HB': 'Bremen', 'BR-DF': 'Federal District', 'MX-CMX': 'Mexico City', 'MX-MEX': 'State of Mexico',
    'SA-04': 'Eastern Province', 'SA-14': 'Asir', 'SA-03': 'Al-Madinah', 'SA-02': 'Makkah',
    'IL-D': 'Southern District', 'IL-Z': 'Northern District', 'IL-M': 'Central District', 'IL-HA': 'Haifa District',
    'IL-JM': 'Jerusalem District', 'IL-TA': 'Tel Aviv District', 'AU-JBT': 'Jervis Bay Territory',
    'ZA-NL': 'KwaZulu-Natal', 'US-DC': 'District of Columbia',
}
ZH_FIX = {'US-WV': '西弗吉尼亚州', 'IN-OR': '奥迪沙邦',
          'CA-BC': '不列颠哥伦比亚省', 'CA-AB': '阿尔伯塔省', 'CA-SK': '萨斯喀彻温省', 'CA-MB': '曼尼托巴省', 'CA-ON': '安大略省',
          'CA-QC': '魁北克省', 'CA-NB': '新不伦瑞克省', 'CA-NS': '新斯科舍省', 'CA-PE': '爱德华王子岛省',
          'CA-NL': '纽芬兰与拉布拉多省', 'CA-YT': '育空地区', 'CA-NT': '西北地区', 'CA-NU': '努纳武特地区',
          'AU-JBT': '杰维斯湾领地', 'MX-CMX': '墨西哥城', 'BR-PA': '帕拉州', 'BR-CE': '塞阿拉州', 'BR-AP': '阿马帕州',
          'BR-BA': '巴伊亚州', 'BR-GO': '戈亚斯州', 'BR-MG': '米纳斯吉拉斯州', 'BR-TO': '托坎廷斯州', 'BR-PB': '帕拉伊巴州',
          'BR-PE': '伯南布哥州', 'BR-RN': '北里奥格兰德州', 'BR-ES': '圣埃斯皮里图州', 'BR-DF': '联邦区',
          'IN-DH': '达德拉-纳加尔哈维利和达曼-第乌', 'ID-JK': '雅加达首都特区', 'ID-BA': '巴厘省', 'ID-AC': '亚齐省'}
# Natural Earth name_zh is mostly simplified Chinese; fold the few traditional characters it still has.
T2S = str.maketrans({
    '亞': '亚', '倫': '伦', '傑': '杰', '內': '内', '區': '区', '圖': '图', '奧': '奥', '實': '实', '廣': '广', '會': '会',
    '東': '东', '爾': '尔', '灣': '湾', '紐': '纽', '納': '纳', '維': '维', '羅': '罗', '聖': '圣', '萊': '莱', '蓋': '盖',
    '薩': '萨', '蘭': '兰', '貝': '贝', '賈': '贾', '達': '达', '靈': '灵', '頓': '顿', '馬': '马', '魯': '鲁', '齊': '齐',
    '韋': '韦', '別': '别', '烏': '乌', '茲': '兹', '島': '岛', '國': '国', '縣': '县', '門': '门', '華': '华', '龍': '龙',
    '雲': '云', '陽': '阳', '義': '义', '遼': '辽', '寧': '宁', '黃': '黄', '蘇': '苏', '與': '与', '愛': '爱', '岡': '冈',
    '長': '长', '兒': '儿', '葉': '叶', '賀': '贺', '靜': '静', '關': '关', '歐': '欧', '廳': '厅', '盧': '卢', '濟': '济',
    '－': '-', '·': '·',
})
TRAD_CHARS = set('亞倫傑內區圖奧實廣會東爾灣紐納維羅聖萊蓋薩蘭貝賈達靈頓馬魯齊韋別烏茲島國縣門華龍雲陽義遼寧黃蘇與愛岡長兒葉賀靜關歐廳盧濟')


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def strip_accents(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def zh_clean(s):
    s = (s or '').strip().translate(T2S)
    return s or None


# ── source ───────────────────────────────────────────────────────────────────────────────────────────────
def mapshaper_cmd() -> list[str]:
    env = os.environ.get('MAPSHAPER')
    if env:
        return shlex.split(env)
    if shutil.which('mapshaper'):
        return ['mapshaper']
    return ['npx', '-y', 'mapshaper@0.6']


def run(cmd: list[str], **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        raise SystemExit(f'command failed ({r.returncode}): {" ".join(cmd)}\n{r.stderr[-2000:]}')
    return r


def fetch(url: str, dest: Path):
    log(f'  downloading {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'money-weather/geodata (build_admin1.py)'})
    tmp = dest.with_suffix(dest.suffix + '.part')
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, 'wb') as f:
        shutil.copyfileobj(r, f)
    tmp.replace(dest)


def source_geojson(cache: Path) -> Path:
    """Natural Earth admin-1 as GeoJSON (converted once from the shapefile, or the GitHub mirror's GeoJSON)."""
    cache.mkdir(parents=True, exist_ok=True)
    gj = cache / f'{NE_STEM}.geojson'
    if gj.exists() and gj.stat().st_size > 10_000_000:
        return gj
    zp = cache / f'{NE_STEM}.zip'
    try:
        if not zp.exists():
            fetch(NE_ZIP_URL, zp)
        shp_dir = cache / 'shp'
        with zipfile.ZipFile(zp) as z:
            for n in z.namelist():  # flat archive; refuse anything with a path
                if '/' in n or '\\' in n or n.startswith('.'):
                    continue
                (shp_dir).mkdir(exist_ok=True)
                (shp_dir / n).write_bytes(z.read(n))
        run(mapshaper_cmd() + ['-i', str(shp_dir / f'{NE_STEM}.shp'), 'encoding=utf8',
                               '-o', 'format=geojson', str(gj)])
    except (OSError, SystemExit, zipfile.BadZipFile) as e:
        log(f'  zip route failed ({e}); trying the GitHub GeoJSON mirror')
        fetch(NE_GEOJSON_URL, gj)
    return gj


# ── units ────────────────────────────────────────────────────────────────────────────────────────────────
def unit_of(iso: str, p: dict):
    """(id, iso_3166_2, name, name_zh) for an NE feature in market `iso`, or None to leave it out."""
    a2, a3, code = p.get('iso_a2'), p.get('adm0_a3'), (p.get('iso_3166_2') or '').strip()
    if iso == 'CN':
        if a3 == 'HKG':
            uid = 'CN-HK'
        elif a3 == 'MAC':
            uid = 'CN-MO'
        elif a3 == 'TWN':
            uid = 'CN-TW'
        elif a2 == 'CN':
            uid = ISO_FIX.get(code, code)
        else:
            return None
        return uid, uid, NAME_FIX.get(uid) or p.get('name'), CN_ZH[uid]
    if a2 != iso:
        return None
    if iso == 'AU' and a3 != 'AUS':
        return None  # Ashmore and Cartier Islands
    if iso == 'NL' and code.startswith('NL-BQ'):
        return None  # Bonaire / Saba / St. Eustatius
    if iso == 'GB':
        key = p.get('region') if p.get('geonunit') == 'England' else p.get('geonunit')
        uid, code3166, en, zh = GB_UNITS[key]
        return uid, code3166, en, zh
    if iso == 'FR':
        uid, en, zh = FR_UNITS[(p.get('region_cod') or '').strip()]
        return uid, uid, en, zh
    if iso == 'IT':
        uid = (p.get('region_cod') or '').strip()
        en, zh = IT_UNITS[uid]
        return uid, uid, en, zh
    if iso == 'ES':
        rc = (p.get('region_cod') or '').strip()
        uid, en, zh = ES_UNITS[code if rc == 'ES.CE' else rc]
        return uid, uid, en, zh
    uid = ISO_FIX.get(code, code)
    if iso == 'TW':
        en, zh = TW_NAMES[uid]
        return uid, uid, en, zh
    name = NAME_FIX.get(uid) or (p.get('name_en') or '').strip() or (p.get('name') or '').strip()
    if iso == 'JP':
        name = strip_accents(re.sub(r'\s+Prefecture$', '', name))
        zh = JP_ZH[uid]
    elif iso == 'KR':
        zh = KR_ZH[uid]
    else:
        zh = ZH_FIX.get(uid) or zh_clean(p.get('name_zh'))
    return uid, (None if uid in NO_ISO else uid), name, zh


def market_features(iso: str, feats: list[dict]) -> list[dict]:
    out = []
    for f in feats:
        u = unit_of(iso, f['properties'])
        if not u or not f.get('geometry'):
            continue
        uid, code, name, zh = u
        out.append({'type': 'Feature', 'geometry': f['geometry'],
                    'properties': {'id': uid, 'name': name, 'name_zh': zh, 'iso_3166_2': code}})
    return out


# ── geometry helpers ─────────────────────────────────────────────────────────────────────────────────────
def bbox_of(features) -> list[float]:
    x0 = y0 = math.inf
    x1 = y1 = -math.inf
    for f in features:
        g = f['geometry']
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        for poly in polys:
            for x, y in poly[0]:
                x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
    return [x0, y0, x1, y1]


def quantization(bbox, interval_m: float) -> int:
    """Grid ≈ interval/4 (20–150 m): invisible next to the simplification, small deltas."""
    grid_m = min(150.0, max(20.0, interval_m / 4))
    span_deg = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    return int(min(1e6, max(1e4, span_deg * 111_320 / grid_m)))


def part_km2(ring) -> float:
    """Approximate area of a lon/lat ring in km² (fine for the small islands it is used on)."""
    lat = sum(p[1] for p in ring) / len(ring)
    a = abs(sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))) / 2
    return a * 111.32 ** 2 * math.cos(math.radians(lat))


def dissolve(iso: str, src: Path, work: Path) -> list[dict]:
    """One feature per unit (mapshaper -dissolve2: shared borders become identical vertices)."""
    out = work / f'{iso}.units.geojson'
    run(mapshaper_cmd() + ['-i', str(src), '-dissolve2', 'id', 'copy-fields=name,name_zh,iso_3166_2',
                           '-o', 'format=geojson', str(out)])
    return json.loads(out.read_text('utf-8'))['features']


def drop_islets(units: list[dict], min_km2: float) -> list[dict]:
    """Drop detached parts (no vertex shared with another unit) smaller than min_km2 — never a unit's largest
    part, so a unit made only of islets (Lakshadweep, Penghu, Kinmen …) keeps its main island."""
    def parts(g):
        return [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    owner = {}
    for u in units:
        for poly in parts(u['geometry']):
            for ring in poly:
                for x, y in ring:
                    owner.setdefault((x, y), set()).add(u['properties']['id'])
    out = []
    for u in units:
        uid = u['properties']['id']
        ps = parts(u['geometry'])
        big = max(range(len(ps)), key=lambda i: part_km2(ps[i][0]))
        keep = []
        for i, poly in enumerate(ps):
            if i != big and part_km2(poly[0]) < min_km2 and \
                    not any(len(owner[(x, y)]) > 1 or uid not in owner[(x, y)] for x, y in poly[0]):
                continue
            keep.append(poly)
        geom = {'type': 'Polygon', 'coordinates': keep[0]} if len(keep) == 1 else \
            {'type': 'MultiPolygon', 'coordinates': keep}
        out.append({'type': 'Feature', 'properties': u['properties'], 'geometry': geom})
    return out


# Huge, nearly company-free units whose coastlines dominate the file: simplified SPARSE_FACTOR× coarser, so the
# populated units of the same market keep a finer step inside the size cap (shared borders take the finer step).
SPARSE = {'CA': {'CA-NU', 'CA-NT', 'CA-YT'}, 'US': {'US-AK'}}
SPARSE_FACTOR = 4


def islet_km2(interval_m: float) -> float:
    return max(0.05, (interval_m / 1000) ** 2 * 0.5)


def build_one(iso: str, units: list[dict], work: Path, interval: int, bbox) -> Path:
    src = work / f'{iso}.{interval}.in.geojson'
    src.write_text(json.dumps({'type': 'FeatureCollection', 'features': drop_islets(units, islet_km2(interval))},
                              ensure_ascii=False), 'utf-8')
    out = work / f'{iso}.{interval}.topo.json'
    sparse = SPARSE.get(iso)
    simplify = ['-simplify', f'interval={interval}', 'keep-shapes'] if not sparse else \
        ['-simplify', 'variable', f'interval={json.dumps(sorted(sparse))}.indexOf(id) > -1 ? '
                                  f'{interval * SPARSE_FACTOR} : {interval}', 'keep-shapes']
    run(mapshaper_cmd() + [
        '-i', str(src),
        *simplify,
        '-rename-layers', OBJECT,
        '-o', 'format=topojson', f'quantization={quantization(bbox, interval)}', 'id-field=id', str(out),
    ])
    return out


def finish(iso: str, raw: Path, interval: int) -> dict:
    """Tidy mapshaper's TopoJSON: ids, property order, bbox, stable order; compact JSON."""
    t = json.loads(raw.read_text('utf-8'))
    obj = t['objects'][OBJECT]
    geoms = []
    for g in obj['geometries']:
        p = g.get('properties') or {}
        gid = g.get('id') or p.get('id')
        if g.get('type') is None or not g.get('arcs'):
            continue  # vanished (should not happen with keep-shapes; caught by the validator)
        geoms.append({'type': g['type'], 'id': gid, 'arcs': g['arcs'],
                      'properties': {'name': p.get('name'), 'name_zh': p.get('name_zh'),
                                     'iso_3166_2': p.get('iso_3166_2') or None}})
    geoms.sort(key=lambda g: g['id'])
    topo = {'type': 'Topology', 'bbox': None, 'transform': t['transform'],
            'objects': {OBJECT: {'type': 'GeometryCollection', 'geometries': geoms}}, 'arcs': t['arcs']}
    topo['bbox'] = decoded_bbox(topo)
    topo['meta'] = {'source': 'Natural Earth 1:10m admin-1 v5.1.1', 'market': iso,
                    'simplify_m': interval, 'built': time.strftime('%Y-%m-%d')}
    if iso in SPARSE:
        topo['meta']['sparse'] = {'ids': sorted(SPARSE[iso]), 'simplify_m': interval * SPARSE_FACTOR}
    return topo


def decode_arcs(topo) -> list[list[tuple[float, float]]]:
    sx, sy = topo['transform']['scale']
    tx, ty = topo['transform']['translate']
    arcs = []
    for arc in topo['arcs']:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def decoded_bbox(topo):
    xs, ys = [], []
    for a in decode_arcs(topo):
        for x, y in a:
            xs.append(x)
            ys.append(y)
    return [round(min(xs), 5), round(min(ys), 5), round(max(xs), 5), round(max(ys), 5)]


# ── validation ───────────────────────────────────────────────────────────────────────────────────────────
NODE_CHECK = r"""
const fs = require('fs'), vm = require('vm'), path = require('path');
const [vendor, dir, ...files] = process.argv.slice(1);
const ctx = { self: {}, console }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['geo/topojson-client.min.js', 'd3.min.js']) vm.runInContext(fs.readFileSync(path.join(vendor, f), 'utf8'), ctx);
const { topojson, d3 } = ctx; const out = {};
for (const f of files) {
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const name = Object.keys(t.objects)[0];
  const fc = topojson.feature(t, t.objects[name]);
  const mesh = topojson.mesh(t, t.objects[name], (a, b) => a !== b);
  let open = 0, badLL = 0, inverted = [], km2 = {};
  for (const ft of fc.features) {
    const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
    for (const p of polys) for (const r of p) {
      const a = r[0], b = r[r.length - 1];
      if (r.length < 4 || a[0] !== b[0] || a[1] !== b[1]) open++;
      for (const [x, y] of r) if (!(x >= -180 && x <= 180 && y >= -90 && y <= 90)) badLL++;
    }
    const ar = d3.geoArea(ft);
    if (ar > 2 * Math.PI) inverted.push(ft.id);
    km2[ft.id] = Math.round(ar * 6371 * 6371);
  }
  const lines = mesh.type === 'MultiLineString' ? mesh.coordinates.length : 1;
  out[f] = { object: name, n: fc.features.length, open, badLL, inverted, meshLines: lines, km2 };
}
process.stdout.write(JSON.stringify(out));
"""


def validate(files: list[Path], strict_size=True, cap_kb=CAP_KB) -> list[str]:
    errs = []
    names = [f.name for f in files]
    r = subprocess.run(['node', '-e', NODE_CHECK, str(VENDOR), str(OUT_DIR), *names], capture_output=True, text=True)
    if r.returncode:
        return [f'node check failed: {r.stderr[-1500:]}']
    node = json.loads(r.stdout)
    for f in files:
        iso = f.stem
        t = json.loads(f.read_text('utf-8'))
        n_exp = MARKETS[iso][0]
        geoms = t['objects'][OBJECT]['geometries']
        ids = [g['id'] for g in geoms]
        res = node[f.name]
        if len(geoms) != n_exp or res['n'] != n_exp:
            errs.append(f'{iso}: {len(geoms)} units, expected {n_exp}')
        if len(set(ids)) != len(ids):
            errs.append(f'{iso}: duplicate ids')
        for g in geoms:
            p = g['properties']
            if not p.get('name') or not p.get('name_zh'):
                errs.append(f'{iso}/{g["id"]}: missing name / name_zh')
            if p.get('name_zh') and set(p['name_zh']) & TRAD_CHARS:
                errs.append(f'{iso}/{g["id"]}: traditional characters in {p["name_zh"]}')
            if p.get('iso_3166_2') is not None and not re.fullmatch(r'[A-Z]{2}-[A-Z0-9]{1,3}', p['iso_3166_2']):
                errs.append(f'{iso}/{g["id"]}: odd iso_3166_2 {p["iso_3166_2"]}')
            if g['type'] not in ('Polygon', 'MultiPolygon'):
                errs.append(f'{iso}/{g["id"]}: geometry {g["type"]}')
        if res['open'] or res['badLL'] or res['inverted']:
            errs.append(f'{iso}: open rings {res["open"]}, bad lon/lat {res["badLL"]}, inverted {res["inverted"]}')
        if res['meshLines'] < 1 and n_exp > 1:
            errs.append(f'{iso}: no inner borders')
        tiny = [k for k, v in res['km2'].items() if v <= 0]
        if tiny:
            errs.append(f'{iso}: zero-area units {tiny}')
        kb = f.stat().st_size / 1000
        if strict_size and kb > cap_kb:
            errs.append(f'{iso}: {kb:.0f} KB > {cap_kb} KB')
    return errs


# ── main ─────────────────────────────────────────────────────────────────────────────────────────────────
def write_json(path: Path, obj):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    tmp.replace(path)


def write_index():
    idx = {}
    for iso in MARKETS:
        f = OUT_DIR / f'{iso}.json'
        if not f.exists():
            continue
        t = json.loads(f.read_text('utf-8'))
        idx[iso] = {'file': f.name, 'units': len(t['objects'][OBJECT]['geometries']), 'bytes': f.stat().st_size,
                    'object': OBJECT, 'bbox': t['bbox'], 'simplify_m': t['meta']['simplify_m'], 'note': MARKETS[iso][1]}
        if 'sparse' in t['meta']:
            idx[iso]['sparse'] = t['meta']['sparse']
    write_json(OUT_DIR / 'index.json', idx)
    return idx


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', help='comma-separated ISO2 list')
    ap.add_argument('--cap', type=int, default=CAP_KB, help='per-file cap, KB')
    ap.add_argument('--total', type=int, default=TOTAL_KB, help='all files together, KB')
    ap.add_argument('--min-interval', type=int, default=LADDER[0], help='finest simplification step, m')
    ap.add_argument('--cache', type=Path, default=CACHE_DIR, help='where the Natural Earth download is kept')
    ap.add_argument('--check', action='store_true', help='only validate the files on disk')
    a = ap.parse_args()
    only = [s.strip().upper() for s in a.only.split(',')] if a.only else list(MARKETS)
    bad = [s for s in only if s not in MARKETS]
    if bad:
        raise SystemExit(f'unknown market(s): {bad}')

    if not a.check:
        gj = source_geojson(a.cache)
        log(f'source {gj}')
        feats = json.loads(gj.read_text('utf-8'))['features']
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        ladder = [s for s in LADDER if s >= a.min_interval] or [a.min_interval]
        with tempfile.TemporaryDirectory(prefix='admin1-') as td:
            work = Path(td)
            for iso in only:
                mf = market_features(iso, feats)
                src = work / f'{iso}.in.geojson'
                src.write_text(json.dumps({'type': 'FeatureCollection', 'features': mf}, ensure_ascii=False), 'utf-8')
                bb = bbox_of(mf)
                units = dissolve(iso, src, work)
                # smallest interval that fits: bisect the ladder (output size falls monotonically with interval)
                lo, hi, best = 0, len(ladder) - 1, None
                while lo <= hi:
                    mid = (lo + hi) // 2
                    raw = build_one(iso, units, work, ladder[mid], bb)
                    topo = finish(iso, raw, ladder[mid])
                    size = len(json.dumps(topo, ensure_ascii=False, separators=(',', ':')).encode())
                    if size <= a.cap * 1000:
                        best, hi = (ladder[mid], topo, size), mid - 1
                    else:
                        lo = mid + 1
                if best is None:
                    raise SystemExit(f'{iso}: does not fit {a.cap} KB even at {ladder[-1]} m')
                interval, topo, size = best
                write_json(OUT_DIR / f'{iso}.json', topo)
                got = len(topo['objects'][OBJECT]['geometries'])
                log(f'{iso}: {len(mf)} NE features → {got} units, {size / 1000:.0f} KB at {interval} m'
                    + ('' if got == MARKETS[iso][0] else f'  (expected {MARKETS[iso][0]}!)'))
        idx = write_index()
        total = sum(v['bytes'] for v in idx.values())
        log(f'index: {len(idx)} markets, {total / 1e6:.2f} MB')
        if total > a.total * 1000:
            log(f'WARNING total {total / 1000:.0f} KB > {a.total} KB — rerun with a lower --cap')

    files = [OUT_DIR / f'{iso}.json' for iso in only if (OUT_DIR / f'{iso}.json').exists()]
    errs = validate(files, cap_kb=a.cap)
    idx = json.loads((OUT_DIR / 'index.json').read_text('utf-8')) if (OUT_DIR / 'index.json').exists() else {}
    total = sum(v['bytes'] for v in idx.values())
    if total > a.total * 1000:
        errs.append(f'total {total / 1000:.0f} KB > {a.total} KB')
    if errs:
        log('VALIDATION FAILED:\n  ' + '\n  '.join(errs))
        raise SystemExit(1)
    log(f'ok: {len(files)} files valid (units, names, closed rings, lon/lat, d3 winding, ≤ {a.cap} KB), '
        f'total {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
