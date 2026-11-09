// geo/iso.js — ISO 3166 lookups for the real-Earth map (§25) + the 全球 (gl) tree → country mapping.
// Pure data + pure functions, no DOM, no fetch. world-atlas 2.0.2 feature ids are ISO 3166-1 numeric
// strings ('156' = China); the gl tree's country nodes carry `markets: ['cn', …]` (ISO alpha-2, lower case).
//
//   byNum('156') / byA2('cn')      → {num, a2, en, zh} | null
//   numOf('hk') → '344'             a2Of('344') → 'HK'           zhName('JP') → '日本'
//   isoForNode(node)                → ['CN','HK','TW'] (alpha-2, upper case) for a gl world/region/country node;
//                                     [] for anything without geography (sectors, stocks, 精选/全市场 nodes)
//   glOf('be')                      → {country:'gl-eu-other', region:'gl-europe'} | null
//   registerTree(glTree)            → re-index from the live tree (markets fields win over the static table)
//
// Features in world-atlas with a null id (Somaliland, Kosovo, N. Cyprus, Indian Ocean Ter., Siachen Glacier)
// are keyed by NULL_ID[name].key ('x-kosovo' …); none of them is a gl market.

/** [numeric, alpha-2, world-atlas English name, 中文名] — every feature id in countries-50m.json. */
export const COUNTRIES = [
  ['004','AF',"Afghanistan",'阿富汗'],
  ['008','AL',"Albania",'阿尔巴尼亚'],
  ['010','AQ',"Antarctica",'南极洲'],
  ['012','DZ',"Algeria",'阿尔及利亚'],
  ['016','AS',"American Samoa",'美属萨摩亚'],
  ['020','AD',"Andorra",'安道尔'],
  ['024','AO',"Angola",'安哥拉'],
  ['028','AG',"Antigua and Barb.",'安提瓜和巴布达'],
  ['031','AZ',"Azerbaijan",'阿塞拜疆'],
  ['032','AR',"Argentina",'阿根廷'],
  ['036','AU',"Australia",'澳大利亚'],
  ['040','AT',"Austria",'奥地利'],
  ['044','BS',"Bahamas",'巴哈马'],
  ['048','BH',"Bahrain",'巴林'],
  ['050','BD',"Bangladesh",'孟加拉国'],
  ['051','AM',"Armenia",'亚美尼亚'],
  ['052','BB',"Barbados",'巴巴多斯'],
  ['056','BE',"Belgium",'比利时'],
  ['060','BM',"Bermuda",'百慕大'],
  ['064','BT',"Bhutan",'不丹'],
  ['068','BO',"Bolivia",'玻利维亚'],
  ['070','BA',"Bosnia and Herz.",'波黑'],
  ['072','BW',"Botswana",'博茨瓦纳'],
  ['076','BR',"Brazil",'巴西'],
  ['084','BZ',"Belize",'伯利兹'],
  ['086','IO',"Br. Indian Ocean Ter.",'英属印度洋领地'],
  ['090','SB',"Solomon Is.",'所罗门群岛'],
  ['092','VG',"British Virgin Is.",'英属维尔京群岛'],
  ['096','BN',"Brunei",'文莱'],
  ['100','BG',"Bulgaria",'保加利亚'],
  ['104','MM',"Myanmar",'缅甸'],
  ['108','BI',"Burundi",'布隆迪'],
  ['112','BY',"Belarus",'白俄罗斯'],
  ['116','KH',"Cambodia",'柬埔寨'],
  ['120','CM',"Cameroon",'喀麦隆'],
  ['124','CA',"Canada",'加拿大'],
  ['132','CV',"Cabo Verde",'佛得角'],
  ['136','KY',"Cayman Is.",'开曼群岛'],
  ['140','CF',"Central African Rep.",'中非'],
  ['144','LK',"Sri Lanka",'斯里兰卡'],
  ['148','TD',"Chad",'乍得'],
  ['152','CL',"Chile",'智利'],
  ['156','CN',"China",'中国'],
  ['158','TW',"Taiwan",'台湾'],
  ['170','CO',"Colombia",'哥伦比亚'],
  ['174','KM',"Comoros",'科摩罗'],
  ['178','CG',"Congo",'刚果（布）'],
  ['180','CD',"Dem. Rep. Congo",'刚果（金）'],
  ['184','CK',"Cook Is.",'库克群岛'],
  ['188','CR',"Costa Rica",'哥斯达黎加'],
  ['191','HR',"Croatia",'克罗地亚'],
  ['192','CU',"Cuba",'古巴'],
  ['196','CY',"Cyprus",'塞浦路斯'],
  ['203','CZ',"Czechia",'捷克'],
  ['204','BJ',"Benin",'贝宁'],
  ['208','DK',"Denmark",'丹麦'],
  ['212','DM',"Dominica",'多米尼克'],
  ['214','DO',"Dominican Rep.",'多米尼加共和国'],
  ['218','EC',"Ecuador",'厄瓜多尔'],
  ['222','SV',"El Salvador",'萨尔瓦多'],
  ['226','GQ',"Eq. Guinea",'赤道几内亚'],
  ['231','ET',"Ethiopia",'埃塞俄比亚'],
  ['232','ER',"Eritrea",'厄立特里亚'],
  ['233','EE',"Estonia",'爱沙尼亚'],
  ['234','FO',"Faeroe Is.",'法罗群岛'],
  ['238','FK',"Falkland Is.",'福克兰群岛'],
  ['239','GS',"S. Geo. and the Is.",'南乔治亚岛'],
  ['242','FJ',"Fiji",'斐济'],
  ['246','FI',"Finland",'芬兰'],
  ['248','AX',"Åland",'奥兰群岛'],
  ['250','FR',"France",'法国'],
  ['258','PF',"Fr. Polynesia",'法属波利尼西亚'],
  ['260','TF',"Fr. S. Antarctic Lands",'法属南部领地'],
  ['262','DJ',"Djibouti",'吉布提'],
  ['266','GA',"Gabon",'加蓬'],
  ['268','GE',"Georgia",'格鲁吉亚'],
  ['270','GM',"Gambia",'冈比亚'],
  ['275','PS',"Palestine",'巴勒斯坦'],
  ['276','DE',"Germany",'德国'],
  ['288','GH',"Ghana",'加纳'],
  ['296','KI',"Kiribati",'基里巴斯'],
  ['300','GR',"Greece",'希腊'],
  ['304','GL',"Greenland",'格陵兰'],
  ['308','GD',"Grenada",'格林纳达'],
  ['316','GU',"Guam",'关岛'],
  ['320','GT',"Guatemala",'危地马拉'],
  ['324','GN',"Guinea",'几内亚'],
  ['328','GY',"Guyana",'圭亚那'],
  ['332','HT',"Haiti",'海地'],
  ['334','HM',"Heard I. and McDonald Is.",'赫德岛和麦克唐纳群岛'],
  ['336','VA',"Vatican",'梵蒂冈'],
  ['340','HN',"Honduras",'洪都拉斯'],
  ['344','HK',"Hong Kong",'香港'],
  ['348','HU',"Hungary",'匈牙利'],
  ['352','IS',"Iceland",'冰岛'],
  ['356','IN',"India",'印度'],
  ['360','ID',"Indonesia",'印度尼西亚'],
  ['364','IR',"Iran",'伊朗'],
  ['368','IQ',"Iraq",'伊拉克'],
  ['372','IE',"Ireland",'爱尔兰'],
  ['376','IL',"Israel",'以色列'],
  ['380','IT',"Italy",'意大利'],
  ['384','CI',"Côte d'Ivoire",'科特迪瓦'],
  ['388','JM',"Jamaica",'牙买加'],
  ['392','JP',"Japan",'日本'],
  ['398','KZ',"Kazakhstan",'哈萨克斯坦'],
  ['400','JO',"Jordan",'约旦'],
  ['404','KE',"Kenya",'肯尼亚'],
  ['408','KP',"North Korea",'朝鲜'],
  ['410','KR',"South Korea",'韩国'],
  ['414','KW',"Kuwait",'科威特'],
  ['417','KG',"Kyrgyzstan",'吉尔吉斯斯坦'],
  ['418','LA',"Laos",'老挝'],
  ['422','LB',"Lebanon",'黎巴嫩'],
  ['426','LS',"Lesotho",'莱索托'],
  ['428','LV',"Latvia",'拉脱维亚'],
  ['430','LR',"Liberia",'利比里亚'],
  ['434','LY',"Libya",'利比亚'],
  ['438','LI',"Liechtenstein",'列支敦士登'],
  ['440','LT',"Lithuania",'立陶宛'],
  ['442','LU',"Luxembourg",'卢森堡'],
  ['446','MO',"Macao",'澳门'],
  ['450','MG',"Madagascar",'马达加斯加'],
  ['454','MW',"Malawi",'马拉维'],
  ['458','MY',"Malaysia",'马来西亚'],
  ['462','MV',"Maldives",'马尔代夫'],
  ['466','ML',"Mali",'马里'],
  ['470','MT',"Malta",'马耳他'],
  ['478','MR',"Mauritania",'毛里塔尼亚'],
  ['480','MU',"Mauritius",'毛里求斯'],
  ['484','MX',"Mexico",'墨西哥'],
  ['492','MC',"Monaco",'摩纳哥'],
  ['496','MN',"Mongolia",'蒙古'],
  ['498','MD',"Moldova",'摩尔多瓦'],
  ['499','ME',"Montenegro",'黑山'],
  ['500','MS',"Montserrat",'蒙特塞拉特'],
  ['504','MA',"Morocco",'摩洛哥'],
  ['508','MZ',"Mozambique",'莫桑比克'],
  ['512','OM',"Oman",'阿曼'],
  ['516','NA',"Namibia",'纳米比亚'],
  ['520','NR',"Nauru",'瑙鲁'],
  ['524','NP',"Nepal",'尼泊尔'],
  ['528','NL',"Netherlands",'荷兰'],
  ['531','CW',"Curaçao",'库拉索'],
  ['533','AW',"Aruba",'阿鲁巴'],
  ['534','SX',"Sint Maarten",'荷属圣马丁'],
  ['540','NC',"New Caledonia",'新喀里多尼亚'],
  ['548','VU',"Vanuatu",'瓦努阿图'],
  ['554','NZ',"New Zealand",'新西兰'],
  ['558','NI',"Nicaragua",'尼加拉瓜'],
  ['562','NE',"Niger",'尼日尔'],
  ['566','NG',"Nigeria",'尼日利亚'],
  ['570','NU',"Niue",'纽埃'],
  ['574','NF',"Norfolk Island",'诺福克岛'],
  ['578','NO',"Norway",'挪威'],
  ['580','MP',"N. Mariana Is.",'北马里亚纳群岛'],
  ['583','FM',"Micronesia",'密克罗尼西亚'],
  ['584','MH',"Marshall Is.",'马绍尔群岛'],
  ['585','PW',"Palau",'帕劳'],
  ['586','PK',"Pakistan",'巴基斯坦'],
  ['591','PA',"Panama",'巴拿马'],
  ['598','PG',"Papua New Guinea",'巴布亚新几内亚'],
  ['600','PY',"Paraguay",'巴拉圭'],
  ['604','PE',"Peru",'秘鲁'],
  ['608','PH',"Philippines",'菲律宾'],
  ['612','PN',"Pitcairn Is.",'皮特凯恩群岛'],
  ['616','PL',"Poland",'波兰'],
  ['620','PT',"Portugal",'葡萄牙'],
  ['624','GW',"Guinea-Bissau",'几内亚比绍'],
  ['626','TL',"Timor-Leste",'东帝汶'],
  ['630','PR',"Puerto Rico",'波多黎各'],
  ['634','QA',"Qatar",'卡塔尔'],
  ['642','RO',"Romania",'罗马尼亚'],
  ['643','RU',"Russia",'俄罗斯'],
  ['646','RW',"Rwanda",'卢旺达'],
  ['652','BL',"St-Barthélemy",'圣巴泰勒米'],
  ['654','SH',"Saint Helena",'圣赫勒拿'],
  ['659','KN',"St. Kitts and Nevis",'圣基茨和尼维斯'],
  ['660','AI',"Anguilla",'安圭拉'],
  ['662','LC',"Saint Lucia",'圣卢西亚'],
  ['663','MF',"St-Martin",'法属圣马丁'],
  ['666','PM',"St. Pierre and Miquelon",'圣皮埃尔和密克隆群岛'],
  ['670','VC',"St. Vin. and Gren.",'圣文森特和格林纳丁斯'],
  ['674','SM',"San Marino",'圣马力诺'],
  ['678','ST',"São Tomé and Principe",'圣多美和普林西比'],
  ['682','SA',"Saudi Arabia",'沙特'],
  ['686','SN',"Senegal",'塞内加尔'],
  ['688','RS',"Serbia",'塞尔维亚'],
  ['690','SC',"Seychelles",'塞舌尔'],
  ['694','SL',"Sierra Leone",'塞拉利昂'],
  ['702','SG',"Singapore",'新加坡'],
  ['703','SK',"Slovakia",'斯洛伐克'],
  ['704','VN',"Vietnam",'越南'],
  ['705','SI',"Slovenia",'斯洛文尼亚'],
  ['706','SO',"Somalia",'索马里'],
  ['710','ZA',"South Africa",'南非'],
  ['716','ZW',"Zimbabwe",'津巴布韦'],
  ['724','ES',"Spain",'西班牙'],
  ['728','SS',"S. Sudan",'南苏丹'],
  ['729','SD',"Sudan",'苏丹'],
  ['732','EH',"W. Sahara",'西撒哈拉'],
  ['740','SR',"Suriname",'苏里南'],
  ['748','SZ',"eSwatini",'斯威士兰'],
  ['752','SE',"Sweden",'瑞典'],
  ['756','CH',"Switzerland",'瑞士'],
  ['760','SY',"Syria",'叙利亚'],
  ['762','TJ',"Tajikistan",'塔吉克斯坦'],
  ['764','TH',"Thailand",'泰国'],
  ['768','TG',"Togo",'多哥'],
  ['776','TO',"Tonga",'汤加'],
  ['780','TT',"Trinidad and Tobago",'特立尼达和多巴哥'],
  ['784','AE',"United Arab Emirates",'阿联酋'],
  ['788','TN',"Tunisia",'突尼斯'],
  ['792','TR',"Turkey",'土耳其'],
  ['795','TM',"Turkmenistan",'土库曼斯坦'],
  ['796','TC',"Turks and Caicos Is.",'特克斯和凯科斯群岛'],
  ['800','UG',"Uganda",'乌干达'],
  ['804','UA',"Ukraine",'乌克兰'],
  ['807','MK',"Macedonia",'北马其顿'],
  ['818','EG',"Egypt",'埃及'],
  ['826','GB',"United Kingdom",'英国'],
  ['831','GG',"Guernsey",'根西岛'],
  ['832','JE',"Jersey",'泽西岛'],
  ['833','IM',"Isle of Man",'马恩岛'],
  ['834','TZ',"Tanzania",'坦桑尼亚'],
  ['840','US',"United States of America",'美国'],
  ['850','VI',"U.S. Virgin Is.",'美属维尔京群岛'],
  ['854','BF',"Burkina Faso",'布基纳法索'],
  ['858','UY',"Uruguay",'乌拉圭'],
  ['860','UZ',"Uzbekistan",'乌兹别克斯坦'],
  ['862','VE',"Venezuela",'委内瑞拉'],
  ['876','WF',"Wallis and Futuna Is.",'瓦利斯和富图纳'],
  ['882','WS',"Samoa",'萨摩亚'],
  ['887','YE',"Yemen",'也门'],
  ['894','ZM',"Zambia",'赞比亚'],
];

/** world-atlas features without an ISO numeric id, by their properties.name. */
export const NULL_ID = {
  'Somaliland': { key: 'x-somaliland', a2: null, zh: '索马里兰' },
  'Kosovo': { key: 'x-kosovo', a2: 'XK', zh: '科索沃' },
  'N. Cyprus': { key: 'x-n-cyprus', a2: null, zh: '北塞浦路斯' },
  'Indian Ocean Ter.': { key: 'x-indian-ocean-ter', a2: null, zh: '澳属印度洋领地' },
  'Siachen Glacier': { key: 'x-siachen', a2: null, zh: '锡亚琴冰川' },
};

const BY_NUM = new Map();
const BY_A2 = new Map();
for (const [num, a2, en, zh] of COUNTRIES) {
  const rec = Object.freeze({ num, a2, en, zh });
  BY_NUM.set(num, rec);
  if (a2 && !BY_A2.has(a2)) BY_A2.set(a2, rec);
}
for (const [en, v] of Object.entries(NULL_ID)) {
  const rec = Object.freeze({ num: v.key, a2: v.a2, en, zh: v.zh });
  BY_NUM.set(v.key, rec);
  if (v.a2 && !BY_A2.has(v.a2)) BY_A2.set(v.a2, rec);
}

/** Market-code spellings that are not ISO alpha-2. */
const A2_ALIAS = { UK: 'GB', EL: 'GR', KS: 'XK' };

/** Normalise 'cn' / 'CN' / 'uk' → 'CN' / 'GB'; null if unknown. */
export function normA2(code) {
  if (code == null) return null;
  let a = String(code).trim().toUpperCase();
  a = A2_ALIAS[a] || a;
  return BY_A2.has(a) ? a : null;
}

export function byNum(num) {
  if (num == null) return null;
  const s = String(num);
  return BY_NUM.get(s) || BY_NUM.get(s.padStart(3, '0')) || null;
}
export function byA2(a2) { const a = normA2(a2); return a ? BY_A2.get(a) : null; }
export function numOf(a2) { const r = byA2(a2); return r ? r.num : null; }
export function a2Of(num) { const r = byNum(num); return r ? r.a2 : null; }
export function zhName(code) {
  const r = byA2(code) || byNum(code);
  return r ? r.zh : null;
}

// ---------------------------------------------------------------------------------------------------
// 全球 (gl) tree mapping. Static fallback = data/gl/tree.json as of 2026-10-28; registerTree() refreshes it
// from the live tree's `markets` fields, so new markets work without editing this file.

/** gl country node id → member alpha-2 codes. */
export const GL_COUNTRY = {
  'gl-cn': ['CN'], 'gl-hk': ['HK'], 'gl-tw': ['TW'],
  'gl-jp': ['JP'], 'gl-in': ['IN'], 'gl-kr': ['KR'], 'gl-au': ['AU'],
  'gl-gb': ['GB'], 'gl-fr': ['FR'], 'gl-ch': ['CH'], 'gl-de': ['DE'], 'gl-nl': ['NL'], 'gl-se': ['SE'],
  'gl-es': ['ES'], 'gl-it': ['IT'], 'gl-eu-other': ['BE', 'AT', 'PT', 'IE', 'PL'],
  'gl-dk': ['DK'], 'gl-no': ['NO'], 'gl-fi': ['FI'],
  'gl-ca': ['CA'], 'gl-br': ['BR'],
};
/** gl region node id → its country node ids. */
export const GL_REGION = {
  'gl-greater-china': ['gl-cn', 'gl-hk', 'gl-tw'],
  'gl-asia-pac': ['gl-jp', 'gl-in', 'gl-kr', 'gl-au'],
  'gl-europe': ['gl-gb', 'gl-fr', 'gl-ch', 'gl-de', 'gl-nl', 'gl-se', 'gl-es', 'gl-it', 'gl-eu-other', 'gl-dk', 'gl-no', 'gl-fi'],
  'gl-americas': ['gl-ca', 'gl-br'],
};

let countryMap = new Map(Object.entries(GL_COUNTRY));   // gl country id → [A2]
let regionMap = new Map(Object.entries(GL_REGION));     // gl region id → [gl country id]
let a2Index = null;                                      // A2 → {country, region}

function buildA2Index() {
  a2Index = new Map();
  for (const [rid, cids] of regionMap) {
    for (const cid of cids) for (const a of countryMap.get(cid) || []) if (!a2Index.has(a)) a2Index.set(a, { country: cid, region: rid });
  }
  for (const [cid, list] of countryMap) for (const a of list) if (!a2Index.has(a)) a2Index.set(a, { country: cid, region: null });
}

const normList = (arr) => {
  const out = [];
  for (const m of arr || []) { const a = normA2(m); if (a && !out.includes(a)) out.push(a); }
  return out;
};

/**
 * Re-index from the live gl tree (data/gl/tree.json): every node with `markets` is a country node, its parent
 * a region. Safe to call repeatedly; ignores trees without any `markets` (精选 / 全市场).
 */
export function registerTree(tree) {
  if (!tree || typeof tree !== 'object') return false;
  const cm = new Map(), rm = new Map();
  const walk = (n, parent, depth) => {
    if (!n || depth > 4) return;
    const list = Array.isArray(n.markets) ? normList(n.markets) : null;
    if (list && list.length) {
      cm.set(n.id, list);
      if (parent) { if (!rm.has(parent.id)) rm.set(parent.id, []); rm.get(parent.id).push(n.id); }
      return; // below a country node are sectors — no geography
    }
    for (const c of n.children || []) walk(c, n, depth + 1);
  };
  walk(tree, null, 0);
  if (!cm.size) return false;
  for (const [k, v] of Object.entries(GL_COUNTRY)) if (!cm.has(k)) cm.set(k, v);
  for (const [k, v] of Object.entries(GL_REGION)) if (!rm.has(k)) rm.set(k, v);
  countryMap = cm; regionMap = rm; a2Index = null;
  return true;
}

/** Which gl country / region an alpha-2 belongs to: {country, region} | null. */
export function glOf(code) {
  const a = normA2(code);
  if (!a) return null;
  if (!a2Index) buildA2Index();
  return a2Index.get(a) || null;
}

/**
 * Alpha-2 codes (upper case) covered by a tree node; [] when the node has no real geography.
 *  - node.markets (gl country node)                 → those markets
 *  - node.children with markets (gl region node)    → union of the children's markets
 *  - a node whose children are regions (gl world)   → union of everything below (two levels)
 *  - otherwise the static table, or the 'gl-xx' id pattern for a market added later (gl-sg → SG)
 * A node id or a plain string id both work.
 */
export function isoForNode(node) {
  if (node == null) return [];
  const id = typeof node === 'string' ? node : node.id;
  if (typeof node === 'object') {
    if (Array.isArray(node.markets) && node.markets.length) return normList(node.markets);
    const kids = node.children || [];
    if (kids.length) {
      const out = [];
      let geoKids = 0;
      for (const c of kids) {
        const sub = isoForNode(c);
        if (sub.length) geoKids++;
        for (const a of sub) if (!out.includes(a)) out.push(a);
      }
      // only a node whose children are (mostly) geographic is itself geographic — never a sector bag
      if (geoKids && geoKids >= kids.length / 2) return out;
    }
  }
  if (countryMap.has(id)) return countryMap.get(id).slice();
  if (regionMap.has(id)) {
    const out = [];
    for (const cid of regionMap.get(id)) for (const a of countryMap.get(cid) || []) if (!out.includes(a)) out.push(a);
    return out;
  }
  const m = /^gl-([a-z]{2})$/.exec(id || '');
  if (m) { const a = normA2(m[1]); if (a) return [a]; }
  return [];
}

/** gl country node ids under a region (static/registered table), for region → members. */
export function glCountriesOf(regionId) { return (regionMap.get(regionId) || []).slice(); }
