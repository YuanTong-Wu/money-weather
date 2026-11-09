"""Global-universe taxonomy: regions -> countries (markets), 11 sectors, Yahoo industries (+ Chinese labels),
industry groups for crowded sectors, and the 申万 tables used for A-shares.

Ids: every global node id starts with "gl-" (the root is "gl-world"); stock ids stay "s:<yfinance symbol>".
Country node  gl-<mk>                    e.g. gl-jp
Sector node   gl-<mk>-<sec>              e.g. gl-jp-tech
Group node    gl-<mk>-<sec>-<grp>        e.g. gl-jp-ind-move
Industry node gl-<mk>-<sec>-<ind>        e.g. gl-jp-tech-semis       (A/H: native 东财 industry slugs)
Tier node     gl-<mk>-<sec>-<ind>-t<k>   cap slices of one big industry ("tier": true)
"""

# ----------------------------------------------------------------------------------------------- geography
# region id -> (zh, emoji, desc, [market keys in display order])
REGIONS = [
    ("gl-greater-china", "大中华", "🐉", "A股、港股和台股：全球第二大的钱池，散户最多、风向转得最快。", ["cn", "hk", "tw"]),
    ("gl-asia-pac", "亚太", "🌏", "日本、韩国、印度和澳洲：芯片、汽车、矿和新兴的大市场。", ["jp", "kr", "in", "au"]),
    ("gl-europe", "欧洲", "🏰", "老牌工业、奢侈品、药和银行，钱慢但沉。", [
        "gb", "ch", "de", "fr", "nl", "it", "es", "se", "dk", "fi", "no", "eu-other"]),
    ("gl-americas", "美洲", "🌎", "美国以外的美洲：加拿大和巴西，能源、矿和大宗商品的老家。", ["ca", "br"]),
]
# market key -> (zh, emoji(flag ok in data), desc, currency, yahoo suffix(es), tags)
MARKETS = {
    "cn": ("A股", "🇨🇳", "上海和深圳交易所的 A 股，中国本土的钱在这里。", "CNY", [".SS", ".SZ"], ["china"]),
    "hk": ("港股", "🇭🇰", "香港交易所：中国公司 + 国际资金的交汇口，南向资金从这里进来。", "HKD", [".HK"], ["china"]),
    "tw": ("台股", "🇹🇼", "台湾的上市和上柜公司，全世界的芯片和服务器从这里出货。", "TWD", [".TW", ".TWO"], ["emerging"]),
    "jp": ("日本", "🇯🇵", "东京交易所：汽车、商社、半导体设备和大银行。", "JPY", [".T"], ["japan"]),
    "kr": ("韩国", "🇰🇷", "韩国 KOSPI 和 KOSDAQ：存储芯片、电池、汽车和造船。", "KRW", [".KS", ".KQ"], ["emerging"]),
    "in": ("印度", "🇮🇳", "印度国家交易所：增长最快的大经济体，内资散户在涌入。", "INR", [".NS"], ["emerging"]),
    "au": ("澳洲", "🇦🇺", "澳洲交易所：矿业、银行和养老金的大本营。", "AUD", [".AX"], []),
    "gb": ("英国", "🇬🇧", "伦敦交易所：石油、银行、矿业和烟草，分红大户。", "GBP", [".L"], ["europe"]),
    "ch": ("瑞士", "🇨🇭", "瑞士交易所：药厂、雀巢、银行和手表，避险的钱爱来。", "CHF", [".SW"], ["europe"]),
    "de": ("德国", "🇩🇪", "法兰克福 XETRA：汽车、化工、工业和军工。", "EUR", [".DE"], ["europe"]),
    "fr": ("法国", "🇫🇷", "巴黎泛欧交易所：奢侈品、航空、能源和银行。", "EUR", [".PA"], ["europe"]),
    "nl": ("荷兰", "🇳🇱", "阿姆斯特丹：光刻机、支付和几家跨国巨头。", "EUR", [".AS"], ["europe"]),
    "it": ("意大利", "🇮🇹", "米兰交易所：银行、能源、豪车和公用事业。", "EUR", [".MI"], ["europe"]),
    "es": ("西班牙", "🇪🇸", "马德里交易所：银行、电力、电信和服装。", "EUR", [".MC"], ["europe"]),
    "se": ("瑞典", "🇸🇪", "斯德哥尔摩：工业设备、银行、游戏和私募。", "SEK", [".ST"], ["europe"]),
    "dk": ("丹麦", "🇩🇰", "哥本哈根：减肥药、航运、风电和啤酒。", "DKK", [".CO"], ["europe"]),
    "fi": ("芬兰", "🇫🇮", "赫尔辛基：通信设备、森工、电梯和能源。", "EUR", [".HE"], ["europe"]),
    "no": ("挪威", "🇳🇴", "奥斯陆：石油、三文鱼、航运和铝。", "NOK", [".OL"], ["europe"]),
    "be": ("比利时", "🇧🇪", "布鲁塞尔：啤酒、药和控股公司。", "EUR", [".BR"], ["europe"]),
    "at": ("奥地利", "🇦🇹", "维也纳：银行、石油和东欧生意。", "EUR", [".VI"], ["europe"]),
    "pt": ("葡萄牙", "🇵🇹", "里斯本：电力、零售和能源。", "EUR", [".LS"], ["europe"]),
    "ie": ("爱尔兰", "🇮🇪", "都柏林：建材、航空和银行。", "EUR", [".IR"], ["europe"]),
    "pl": ("波兰", "🇵🇱", "华沙：银行、能源、零售和游戏，东欧最大的市场。", "PLN", [".WA"], ["europe", "emerging"]),
    "ca": ("加拿大", "🇨🇦", "多伦多交易所：银行、油砂、金矿和铁路。", "CAD", [".TO", ".V"], []),
    "br": ("巴西", "🇧🇷", "圣保罗交易所：石油、铁矿、银行和农业，拉美的钱池。", "BRL", [".SA"], ["emerging"]),
}
# small European markets folded into one country-like node so the Europe planet stays <= 15 children
EU_OTHER = ("eu-other", "欧洲其他", "🇪🇺", "比利时、奥地利、葡萄牙、爱尔兰、波兰这些较小的欧洲市场。",
            ["be", "at", "pt", "ie", "pl"])
# yahoo market for the screener exchange codes lives in sources.MARKET_EXCHANGES

# ----------------------------------------------------------------------------------------------- sectors
YAHOO_SECTOR = {
    "Technology": "tech", "Communication Services": "comm", "Healthcare": "health", "Financial Services": "fin",
    "Industrials": "ind", "Consumer Cyclical": "disc", "Consumer Defensive": "staple", "Energy": "energy",
    "Utilities": "util", "Basic Materials": "mat", "Real Estate": "realty",
}
# key -> (zh, emoji, desc, tags)  (same wording family as fullmarket/taxonomy.py)
SECTORS = {
    "tech":   ("科技", "💻", "芯片、电子、电脑和软件，数字世界的地基。", []),
    "comm":   ("通信传媒", "📡", "电信、互联网平台、游戏和影视。", []),
    "health": ("医疗", "🏥", "药、医疗器械、医院和医保。", ["health"]),
    "fin":    ("金融", "🏦", "银行、券商、保险，钱本身住的地方。", ["finance"]),
    "ind":    ("工业", "🏭", "机器、电力设备、军工、运输和工程，经济的肌肉。", []),
    "disc":   ("可选消费", "🛍️", "想买才买的东西：车、衣服、餐厅、旅游、电商。", ["consumer"]),
    "staple": ("必需消费", "🛒", "吃喝和日用品，再穷也得买。", ["consumer"]),
    "energy": ("能源", "🛢️", "石油、天然气、煤和铀。", ["energy"]),
    "util":   ("公用事业", "💡", "电、水、燃气，按月收钱的生意。", ["power"]),
    "mat":    ("原材料", "⛏️", "化工、钢铁、有色、金矿和建材。", []),
    "realty": ("房地产", "🏠", "开发商、物业和收租的信托。", ["realestate"]),
}
SECTOR_ORDER = ["tech", "comm", "health", "fin", "ind", "disc", "staple", "energy", "util", "mat", "realty"]

# Yahoo industry -> (slug, zh, emoji, desc, tags). Sector comes from the screener record.
IND = {
    # --- tech
    "Semiconductors": ("semis", "芯片", "🔌", "设计和制造芯片的公司。", ["chip"]),
    "Semiconductor Equipment & Materials": ("semi-equip", "芯片设备材料", "🔬", "造芯片用的机器、硅片和材料。", ["chip"]),
    "Electronic Components": ("components", "电子元件", "🔩", "电路板、连接器、被动元件和光器件。", []),
    "Computer Hardware": ("hardware", "电脑硬件", "🖥️", "服务器、电脑、存储和代工组装。", []),
    "Consumer Electronics": ("cons-elec", "消费电子", "📱", "手机、电视、相机和家电电子。", []),
    "Communication Equipment": ("comm-equip", "通信设备", "📶", "基站、光模块、交换机和网络设备。", []),
    "Electronics & Computer Distribution": ("elec-distrib", "电子分销", "📦", "把芯片和电子件批发给工厂的中间商。", []),
    "Information Technology Services": ("it-services", "IT服务", "🧑‍💻", "替企业做系统、外包和数字化。", ["software"]),
    "Scientific & Technical Instruments": ("instruments", "仪器仪表", "📐", "测量、检测和科学仪器。", []),
    "Software—Application": ("software-app", "应用软件", "🧩", "卖给企业和个人用的软件。", ["software"]),
    "Software—Infrastructure": ("software-infra", "基础软件", "🗄️", "数据库、云、安全和操作系统这类底层软件。", ["software", "cloud"]),
    "Solar": ("solar", "光伏", "☀️", "太阳能板、硅料和逆变器。", ["clean"]),
    # --- comm
    "Telecom Services": ("telecom", "电信运营", "📞", "移动、宽带和固网运营商，收月租。", []),
    "Internet Content & Information": ("internet", "互联网平台", "🌐", "搜索、社交、内容和门户网站。", []),
    "Electronic Gaming & Multimedia": ("games", "游戏", "🎮", "做游戏和互动娱乐的公司。", []),
    "Entertainment": ("entertain", "影视娱乐", "🎬", "电影、音乐、演出和流媒体。", []),
    "Advertising Agencies": ("ads", "广告营销", "📣", "替品牌打广告、做营销。", []),
    "Broadcasting": ("broadcast", "广播电视", "📺", "电视台和电台。", []),
    "Publishing": ("publishing", "出版", "📚", "书报、教材和资讯出版。", []),
    # --- health
    "Drug Manufacturers—General": ("pharma", "大药厂", "💊", "全球卖药的大型制药公司。", ["health"]),
    "Drug Manufacturers—Specialty & Generic": ("pharma-spec", "专科仿制药", "💉", "专科药、仿制药和中药。", ["health"]),
    "Biotechnology": ("biotech", "生物科技", "🧬", "研发新药和生物技术的公司。", ["biotech"]),
    "Medical Devices": ("med-devices", "医疗设备", "🩻", "影像、手术和植入类医疗设备。", ["health"]),
    "Medical Instruments & Supplies": ("med-supplies", "医疗耗材", "🩹", "注射器、导管和各种耗材。", ["health"]),
    "Diagnostics & Research": ("diagnostics", "诊断与CRO", "🧪", "化验检测和替药厂做研发的CRO。", ["health"]),
    "Medical Care Facilities": ("hospitals", "医院诊所", "🏥", "医院、诊所和养老护理。", ["health"]),
    "Medical Distribution": ("med-distrib", "医药流通", "🚚", "把药和器械批发到医院药店。", ["health"]),
    "Pharmaceutical Retailers": ("pharmacy", "药店", "🏪", "连锁药店。", ["health"]),
    "Healthcare Plans": ("health-ins", "医保", "📋", "医疗保险和健康计划。", ["health"]),
    "Health Information Services": ("health-it", "医疗信息化", "💾", "医院软件和医疗数据服务。", ["health"]),
    # --- fin
    "Banks—Diversified": ("banks-big", "大银行", "🏦", "什么业务都做的大型银行。", ["finance"]),
    "Banks—Regional": ("banks", "银行", "🏛️", "吸存放贷的商业银行。", ["finance"]),
    "Capital Markets": ("brokers", "券商投行", "📈", "券商、投行和交易服务。", ["finance"]),
    "Asset Management": ("asset-mgmt", "资管投资", "💼", "基金、资管、控股和投资公司。", ["finance"]),
    "Financial Data & Stock Exchanges": ("exchanges", "交易所数据", "🏟️", "交易所和金融数据公司。", ["finance"]),
    "Financial Conglomerates": ("fin-conglo", "金融集团", "🏢", "什么金融业务都有的综合集团。", ["finance"]),
    "Credit Services": ("credit", "消费信贷", "💳", "信用卡、消费贷和支付。", ["finance"]),
    "Mortgage Finance": ("mortgage", "房贷金融", "🏠", "房贷和住房金融。", ["finance", "rates"]),
    "Insurance—Life": ("ins-life", "寿险", "👪", "人寿和养老保险。", ["finance"]),
    "Insurance—Property & Casualty": ("ins-pc", "财险", "🚗", "车险、财产险和意外险。", ["finance"]),
    "Insurance—Diversified": ("ins-div", "综合保险", "☂️", "寿险财险都做的保险集团。", ["finance"]),
    "Insurance—Reinsurance": ("reins", "再保险", "🌪️", "替保险公司兜底的再保险。", ["finance"]),
    "Insurance—Specialty": ("ins-spec", "特种保险", "🛡️", "信用险、担保和小众保险。", ["finance"]),
    "Insurance Brokers": ("ins-broker", "保险经纪", "🤝", "替客户买保险、收佣金的中介。", ["finance"]),
    "Shell Companies": ("shell", "壳公司", "🐚", "空壳和特殊目的收购公司。", ["finance"]),
    # --- ind
    "Aerospace & Defense": ("aero-def", "航空军工", "✈️", "飞机、发动机、导弹和军工。", ["defense", "space"]),
    "Airlines": ("airlines", "航空公司", "🛫", "载人飞来飞去的航空公司。", []),
    "Airports & Air Services": ("airports", "机场", "🛬", "机场和航空地勤服务。", []),
    "Building Products & Equipment": ("building-prod", "建材设备", "🧱", "门窗、管道、空调和建筑设备。", []),
    "Business Equipment & Supplies": ("office", "办公设备", "🖨️", "打印机、办公用品和设备。", []),
    "Conglomerates": ("conglo", "综合集团", "🏙️", "什么都做的大型多元集团。", []),
    "Consulting Services": ("consulting", "咨询", "🧠", "管理咨询、测评和专业服务。", []),
    "Electrical Equipment & Parts": ("elec-equip", "电力设备", "⚡", "电网设备、电机、电池和电缆。", ["power"]),
    "Engineering & Construction": ("construction", "工程建筑", "🏗️", "盖楼修路、建电站的工程公司。", []),
    "Farm & Heavy Construction Machinery": ("heavy-mach", "重型机械", "🚜", "挖掘机、卡车、农机和船舶。", []),
    "Industrial Distribution": ("ind-distrib", "工业分销", "📦", "批发工业用品和零件。", []),
    "Infrastructure Operations": ("infra-ops", "基建运营", "🛣️", "收费公路、港口和基建运营。", []),
    "Integrated Freight & Logistics": ("logistics", "物流快递", "🚚", "快递、货运和供应链物流。", []),
    "Marine Shipping": ("shipping", "航运", "🚢", "集装箱、油轮和散货船。", []),
    "Metal Fabrication": ("metal-fab", "金属加工", "🔧", "铸件、锻件和金属结构件。", []),
    "Pollution & Treatment Controls": ("enviro", "环保设备", "♻️", "污水、废气处理和环保设备。", []),
    "Railroads": ("rail", "铁路", "🚆", "铁路运输和轨道设备。", []),
    "Rental & Leasing Services": ("leasing", "租赁", "🔑", "设备、飞机和车辆租赁。", []),
    "Security & Protection Services": ("security-svc", "安防", "🛡️", "安保、监控和消防。", []),
    "Specialty Business Services": ("biz-services", "企业服务", "📋", "替企业做各种外包杂活。", []),
    "Specialty Industrial Machinery": ("machinery", "工业机械", "⚙️", "自动化、机床、泵阀和专用设备。", []),
    "Staffing & Employment Services": ("staffing", "人力资源", "👔", "招聘、派遣和人力外包。", []),
    "Tools & Accessories": ("tools", "工具", "🔨", "电动工具、刀具和五金。", []),
    "Trucking": ("trucking", "公路货运", "🚛", "卡车运输。", []),
    "Waste Management": ("waste", "垃圾处理", "🗑️", "收垃圾、回收和危废处理。", []),
    # --- disc
    "Auto Manufacturers": ("autos", "整车", "🚗", "造汽车、电动车和摩托车。", ["ev"]),
    "Auto Parts": ("auto-parts", "汽车零部件", "🛞", "轮胎、座椅、电子和各种汽车零件。", ["ev"]),
    "Auto & Truck Dealerships": ("auto-dealers", "汽车经销", "🏬", "卖车和汽车服务的经销商。", []),
    "Recreational Vehicles": ("rv", "房车摩托", "🏍️", "摩托、房车和休闲车。", []),
    "Internet Retail": ("ecommerce", "电商", "🛒", "网上卖东西的平台。", []),
    "Specialty Retail": ("specialty-retail", "专业零售", "🏪", "各种专卖店和连锁店。", []),
    "Department Stores": ("dept-stores", "百货", "🏬", "百货公司和商场。", []),
    "Home Improvement Retail": ("home-retail", "家装零售", "🪚", "建材家装卖场。", []),
    "Apparel Retail": ("apparel-retail", "服装零售", "👚", "卖衣服的连锁店。", []),
    "Apparel Manufacturing": ("apparel", "服装", "👗", "做衣服和品牌服饰。", []),
    "Footwear & Accessories": ("shoes", "鞋包配饰", "👟", "鞋、包、眼镜和配饰。", []),
    "Luxury Goods": ("luxury", "奢侈品", "💎", "名牌包、珠宝和手表。", []),
    "Textile Manufacturing": ("textiles", "纺织", "🧵", "纺纱织布。", []),
    "Furnishings, Fixtures & Appliances": ("appliances", "家电家居", "🛋️", "家电、家具和厨卫。", []),
    "Residential Construction": ("homebuild", "住宅建筑", "🏘️", "盖房子卖房子的建筑商。", ["realestate"]),
    "Packaging & Containers": ("packaging", "包装", "📦", "纸箱、瓶罐和包装材料。", []),
    "Restaurants": ("restaurants", "餐饮", "🍜", "餐厅和连锁快餐。", []),
    "Lodging": ("hotels", "酒店", "🏨", "酒店和住宿。", []),
    "Resorts & Casinos": ("casinos", "度假赌场", "🎰", "度假村和赌场。", []),
    "Gambling": ("gambling", "博彩", "🎲", "彩票、博彩和赛马。", []),
    "Leisure": ("leisure", "休闲娱乐", "🎡", "主题乐园、健身、玩具和运动器材。", []),
    "Travel Services": ("travel", "旅游", "🧳", "旅行社、订票平台和邮轮。", []),
    "Personal Services": ("personal-svc", "生活服务", "💇", "教育以外的各种生活服务。", []),
    # --- staple
    "Beverages—Non-Alcoholic": ("drinks", "饮料", "🥤", "软饮、矿泉水和咖啡茶饮。", []),
    "Beverages—Brewers": ("beer", "啤酒", "🍺", "啤酒厂。", []),
    "Beverages—Wineries & Distilleries": ("liquor", "白酒烈酒", "🍶", "白酒、威士忌、葡萄酒。", []),
    "Packaged Foods": ("foods", "食品", "🍱", "包装食品、调味品和乳制品。", []),
    "Confectioners": ("candy", "糖果零食", "🍫", "巧克力、糖果和零食。", []),
    "Farm Products": ("farm", "农牧", "🌾", "种植、养殖和农产品。", []),
    "Food Distribution": ("food-distrib", "食品流通", "🚛", "食品批发和流通。", []),
    "Grocery Stores": ("grocery", "超市", "🛒", "超市和便利店。", []),
    "Discount Stores": ("discount", "折扣店", "🏷️", "大卖场和折扣连锁。", []),
    "Household & Personal Products": ("household", "日化", "🧴", "洗护、化妆品和日用品。", []),
    "Tobacco": ("tobacco", "烟草", "🚬", "香烟和电子烟。", []),
    "Education & Training Services": ("education", "教育", "🎓", "学校、培训和网课。", []),
    # --- energy
    "Oil & Gas Integrated": ("oil-major", "石油巨头", "🛢️", "从采油到加油站一条龙的大石油公司。", ["oil"]),
    "Oil & Gas E&P": ("oil-ep", "油气开采", "⛽", "找油、采油、采气的公司。", ["oil"]),
    "Oil & Gas Equipment & Services": ("oil-svc", "油服", "🔧", "钻井设备和油田服务。", ["oil"]),
    "Oil & Gas Drilling": ("oil-drill", "钻井", "🏗️", "海上和陆地钻井平台。", ["oil"]),
    "Oil & Gas Midstream": ("midstream", "油气管道", "🚰", "管道、储运和液化天然气。", ["oil"]),
    "Oil & Gas Refining & Marketing": ("refining", "炼化加油", "🏭", "炼油厂和加油站。", ["oil"]),
    "Thermal Coal": ("coal", "煤炭", "⚫", "挖煤卖煤。", []),
    "Uranium": ("uranium", "铀矿", "☢️", "核电用的铀。", ["power"]),
    # --- util
    "Utilities—Regulated Electric": ("electric", "电力", "🔌", "发电和输电的电力公司。", ["power"]),
    "Utilities—Renewable": ("renewables", "新能源发电", "🌬️", "风电、光伏和水电运营商。", ["power", "clean"]),
    "Utilities—Independent Power Producers": ("ipp", "独立发电", "🏭", "卖电给电网的独立电厂。", ["power"]),
    "Utilities—Diversified": ("util-div", "综合公用", "🏙️", "电、气、水都做的公用事业集团。", ["power"]),
    "Utilities—Regulated Gas": ("gas", "燃气", "🔥", "城市燃气和天然气管网。", ["power"]),
    "Utilities—Regulated Water": ("water", "水务", "💧", "自来水和污水处理。", ["power"]),
    # --- mat
    "Steel": ("steel", "钢铁", "🏗️", "炼钢和钢材。", ["metals"]),
    "Aluminum": ("aluminum", "铝", "🥫", "电解铝和铝材。", ["metals"]),
    "Copper": ("copper", "铜", "🟠", "铜矿和铜材。", ["metals"]),
    "Other Industrial Metals & Mining": ("metals", "有色矿业", "⛏️", "铁矿、锂、镍、稀土等矿。", ["metals"]),
    "Gold": ("gold", "金矿", "🥇", "挖黄金的公司。", ["gold", "metals"]),
    "Silver": ("silver", "银矿", "🥈", "挖白银的公司。", ["gold", "metals"]),
    "Other Precious Metals & Mining": ("precious", "贵金属", "💍", "铂、钯和其他贵金属。", ["gold", "metals"]),
    "Coking Coal": ("coking-coal", "焦煤", "🪨", "炼钢用的焦煤和焦炭。", ["metals"]),
    "Chemicals": ("chemicals", "基础化工", "🧪", "大宗化学品和石化。", []),
    "Specialty Chemicals": ("spec-chem", "精细化工", "⚗️", "特种化学品、涂料和新材料。", []),
    "Agricultural Inputs": ("agri-inputs", "化肥农药", "🌱", "化肥、农药和种子。", []),
    "Building Materials": ("building-mat", "建材", "🧱", "水泥、玻璃和建筑材料。", []),
    "Lumber & Wood Production": ("lumber", "木材", "🪵", "林场和木材加工。", []),
    "Paper & Paper Products": ("paper", "造纸", "📄", "纸浆和纸制品。", []),
    # --- realty
    "Real Estate—Development": ("re-dev", "地产开发", "🏗️", "拿地盖楼卖房的开发商。", ["realestate"]),
    "Real Estate—Diversified": ("re-div", "综合地产", "🏢", "开发、收租和物业都做的地产集团。", ["realestate"]),
    "Real Estate Services": ("re-services", "物业中介", "🔑", "物业管理和房产中介。", ["realestate"]),
    "REIT—Diversified": ("reit-div", "综合信托", "🏦", "什么楼都持有的地产信托。", ["realestate"]),
    "REIT—Industrial": ("reit-ind", "仓储物流信托", "🏭", "出租仓库和物流园。", ["realestate"]),
    "REIT—Office": ("reit-office", "写字楼信托", "🏢", "出租办公楼。", ["realestate"]),
    "REIT—Retail": ("reit-retail", "商场信托", "🛍️", "出租商场和店铺。", ["realestate"]),
    "REIT—Residential": ("reit-resi", "住宅信托", "🏘️", "出租公寓。", ["realestate"]),
    "REIT—Healthcare Facilities": ("reit-health", "医疗地产信托", "🧓", "出租医院和养老院。", ["realestate"]),
    "REIT—Hotel & Motel": ("reit-hotel", "酒店信托", "🏨", "持有酒店的信托。", ["realestate"]),
    "REIT—Mortgage": ("reit-mort", "房贷信托", "🏦", "放房贷的信托。", ["realestate", "rates"]),
    "REIT—Specialty": ("reit-spec", "特种信托", "🗼", "数据中心、铁塔和基建信托。", ["realestate"]),
}

# Sectors with too many industries for one planet get a middle layer (applied per country when the sector has
# more than GROUP_OVER industry children). Groups with one member collapse back to the industry.
GROUP_OVER = 12
GROUPS = {
    "ind": [
        ("make", "机器制造", "⚙️", "工业机械、重型机械、工具和金属加工。",
         ["machinery", "heavy-mach", "metal-fab", "tools", "office", "enviro", "conglo"]),
        ("power", "电力设备", "⚡", "电网、电机、电池和电缆。", ["elec-equip"]),
        ("air", "航空军工", "✈️", "飞机、发动机和军工。", ["aero-def"]),
        ("move", "交通运输", "🚚", "飞机、船、火车、卡车运人运货，还有机场和收费公路。",
         ["airlines", "airports", "shipping", "rail", "trucking", "logistics", "infra-ops"]),
        ("build", "工程建筑", "🏗️", "盖楼修路、建材设备和工业分销。", ["construction", "building-prod", "ind-distrib"]),
        ("service", "企业服务", "📋", "外包、咨询、人力、租赁、安防和垃圾处理。",
         ["biz-services", "consulting", "staffing", "leasing", "security-svc", "waste"]),
    ],
    "disc": [
        ("auto", "汽车", "🚘", "整车、零部件、经销和摩托房车。", ["autos", "auto-parts", "auto-dealers", "rv"]),
        ("shop", "逛街购物", "🛍️", "电商、百货和各种专卖店。",
         ["ecommerce", "specialty-retail", "dept-stores", "home-retail", "apparel-retail"]),
        ("wear", "穿戴奢侈", "👜", "服装、鞋包、纺织和奢侈品。", ["apparel", "shoes", "luxury", "textiles"]),
        ("home", "家居住房", "🛋️", "家电家具、住宅建筑和包装。", ["appliances", "homebuild", "packaging"]),
        ("fun", "吃喝玩乐", "🎡", "餐厅、酒店、赌场、旅游和生活服务。",
         ["restaurants", "hotels", "casinos", "gambling", "leisure", "travel", "personal-svc"]),
    ],
    "mat": [
        ("chem", "化工", "🧪", "基础化工、精细化工和化肥农药。", ["chemicals", "spec-chem", "agri-inputs"]),
        ("metal", "钢铁有色", "⛏️", "钢、铝、铜、焦煤和各种矿。", ["steel", "aluminum", "copper", "metals", "coking-coal"]),
        ("precious", "贵金属", "🥇", "金、银和其他贵金属。", ["gold", "silver", "precious"]),
        ("build", "建材林纸", "🧱", "水泥玻璃、木材和造纸。", ["building-mat", "lumber", "paper"]),
    ],
    "fin": [
        ("bank", "银行信贷", "🏦", "银行、信用卡和房贷。", ["banks-big", "banks", "credit", "mortgage"]),
        ("ins", "保险", "☂️", "寿险、财险、再保险和保险中介。",
         ["ins-life", "ins-pc", "ins-div", "reins", "ins-spec", "ins-broker"]),
        ("mkt", "券商资管", "📈", "券商、资管、交易所和金融集团。", ["brokers", "asset-mgmt", "exchanges", "fin-conglo", "shell"]),
    ],
    "health": [
        ("drug", "制药", "💊", "大药厂、专科仿制药和生物科技。", ["pharma", "pharma-spec", "biotech"]),
        ("device", "器械诊断", "🩺", "医疗设备、耗材和诊断研发外包。", ["med-devices", "med-supplies", "diagnostics"]),
        ("care", "医疗服务", "🏥", "医院、医药流通、药店、医保和信息化。",
         ["hospitals", "med-distrib", "pharmacy", "health-ins", "health-it"]),
    ],
    "tech": [
        ("chip", "半导体", "🔌", "芯片和芯片设备材料。", ["semis", "semi-equip"]),
        ("hw", "电子硬件", "🖥️", "电子元件、电脑、消费电子、通信设备、仪器和光伏。",
         ["components", "hardware", "cons-elec", "comm-equip", "elec-distrib", "instruments", "solar"]),
        ("sw", "软件服务", "🧩", "应用软件、基础软件和IT服务。", ["software-app", "software-infra", "it-services"]),
    ],
    "staple": [
        ("eat", "吃喝", "🍱", "食品、饮料、酒、糖果和农牧。",
         ["foods", "drinks", "beer", "liquor", "candy", "farm", "food-distrib"]),
        ("store", "超市日化", "🛒", "超市、折扣店、日化、烟草和教育。",
         ["grocery", "discount", "household", "tobacco", "education"]),
    ],
    "realty": [
        ("dev", "地产开发", "🏗️", "开发商、综合地产和物业中介。", ["re-dev", "re-div", "re-services"]),
        ("reit", "收租信托", "🏢", "各种收租的地产信托。",
         ["reit-div", "reit-ind", "reit-office", "reit-retail", "reit-resi", "reit-health", "reit-hotel", "reit-mort",
          "reit-spec"]),
    ],
}

# Big industries are split into equal-count market-cap tiers.
SPLIT_MAX = 60
SPLIT_TARGET = 45
MIN_LEAF = 4          # industries with fewer stocks are folded into "其他<sector>"
FLAT_SECTOR = 24      # a sector with <= this many stocks in a country skips the industry level
TIER_WORDS = ["龙头", "大型", "中大型", "中型", "中小型", "小型", "微型", "迷你", "袖珍", "尾部", "末端", "零星",
              "最小", "极小", "微小"]

# ----------------------------------------------------------------------------------------------- 申万行业 (A 股)
# A-shares use the native 申万 2021 classification (www.swsresearch.com): sector (11 keys, same as everywhere)
# -> [申万一级 as a group when the sector has > GROUP_OVER 二级 children] -> 申万二级 -> [申万三级 when > SPLIT_MAX]
# -> [cap tiers]. Ids use the 申万 codes: gl-cn-ind-sw64 (一级), gl-cn-ind-sw6402 (二级), gl-cn-ind-sw640201 (三级).
SW_L1 = {  # code -> (sector, emoji, desc)
    "11": ("staple", "🌾", "种地、养猪、养鱼、种子饲料，中国人的饭碗。"),
    "22": ("mat", "🧪", "化学原料、化学制品、塑料、化纤和农药化肥。"),
    "23": ("mat", "🏗️", "炼钢、特钢和铁矿石，盖楼造车的骨头。"),
    "24": ("mat", "⛏️", "铜铝锂钴、黄金稀土和各种新材料。"),
    "27": ("tech", "🔌", "芯片、元件、面板、手机零件，A股科技的主战场。"),
    "28": ("disc", "🚗", "整车、零部件和汽车服务，电动车的大本营。"),
    "33": ("disc", "🧊", "空调冰箱、小家电、厨卫和家电零件。"),
    "34": ("staple", "🍶", "白酒、饮料乳品、调味品和零食。"),
    "35": ("disc", "👗", "纺织、服装家纺和首饰。"),
    "36": ("disc", "🛋️", "造纸、包装印刷、家居用品和文具玩具。"),
    "37": ("health", "💊", "化学药、中药、生物药、器械和医疗服务。"),
    "41": ("util", "💡", "发电和燃气，按月收钱的生意。"),
    "42": ("ind", "🚚", "物流、铁路公路、航空机场和航运港口。"),
    "43": ("realty", "🏠", "开发商和物业服务，曾经的印钞机。"),
    "45": ("disc", "🏬", "百货超市、专业连锁、电商和贸易。"),
    "46": ("disc", "🎡", "旅游景区、酒店餐饮、教育和专业服务。"),
    "48": ("fin", "🏦", "国有大行、股份行、城商行和农商行。"),
    "49": ("fin", "📈", "券商、保险和多元金融，牛市的发动机。"),
    "51": ("ind", "🏙️", "什么都做一点的综合类公司。"),
    "61": ("mat", "🧱", "水泥、玻璃玻纤和装修建材。"),
    "62": ("ind", "🏗️", "基建、房建、专业工程和装修装饰。"),
    "63": ("ind", "⚡", "电池、光伏、风电、电网设备和电机，新能源的硬件。"),
    "64": ("ind", "⚙️", "通用设备、专用设备、工程机械和自动化（机器人）。"),
    "65": ("ind", "🚀", "航空航天、船舶、地面兵装和军工电子。"),
    "71": ("tech", "🖥️", "软件、IT服务和计算机设备，信创和 AI 应用都在这。"),
    "72": ("comm", "🎬", "游戏、影视、广告、出版和数字媒体。"),
    "73": ("tech", "📶", "光模块、通信设备和运营商。"),
    "74": ("energy", "⚫", "挖煤和炼焦。"),
    "75": ("energy", "🛢️", "油气开采、油服和炼化。"),
    "76": ("ind", "♻️", "污水、固废和环保设备。"),
    "77": ("staple", "💄", "化妆品、个护用品和医美。"),
}
SW_L2_SECTOR = {"7301": "comm"}       # 通信服务 (运营商) lives in 通信传媒, 通信设备 stays in 科技
SW_L2 = {  # code -> (emoji, desc); missing codes fall back to the 一级 emoji and a generic sentence
    "1101": ("🌱", "种子和粮食种植。"), "1102": ("🐟", "海洋捕捞和水产养殖。"), "1103": ("🌲", "林场和林木。"),
    "1104": ("🌽", "猪饲料、鸡饲料和水产饲料。"), "1105": ("🫘", "粮油、果蔬和农产品加工。"),
    "1107": ("🐖", "养猪养鸡，猪周期说的就是它。"), "1108": ("💉", "兽药和动物疫苗。"), "1109": ("🚜", "农业综合服务。"),
    "2202": ("🧪", "纯碱、氯碱、钛白粉这些大宗化工原料。"), "2203": ("⚗️", "各种精细化学品和新材料。"),
    "2204": ("🧵", "涤纶、氨纶、粘胶这些化学纤维。"), "2205": ("🧴", "塑料和改性塑料、薄膜。"), "2206": ("🛞", "轮胎和橡胶制品。"),
    "2208": ("🌾", "化肥农药，粮价的影子。"), "2209": ("💠", "非金属矿物材料。"),
    "2303": ("🪨", "铁矿石和炼钢原料。"), "2304": ("🏗️", "普通钢材，看基建和房地产的脸色。"), "2305": ("🔩", "特种钢和不锈钢。"),
    "2402": ("🧲", "磁材、合金和金属新材料。"), "2403": ("🟠", "铜铝铅锌，经济的体温计。"), "2404": ("🥇", "黄金白银，避险的钱爱来。"),
    "2405": ("🔬", "稀土、钨、钼这些小金属。"), "2406": ("🔋", "锂和钴镍，电池的原料。"),
    "2701": ("🔌", "芯片设计、制造、封测、设备和材料，自主可控的主线。"), "2702": ("🔩", "电路板和被动元件。"),
    "2703": ("💡", "面板、LED 和光学元件。"), "2704": ("🔋", "其他电子零件。"), "2705": ("📱", "手机、耳机和消费电子代工。"),
    "2706": ("⚗️", "电子特气、光刻胶等电子化学品。"),
    "2802": ("🛞", "汽车零部件，电动车和机器人的供应链。"), "2803": ("🏬", "汽车经销和后市场服务。"),
    "2804": ("🏍️", "摩托车和其他车。"), "2805": ("🚗", "造乘用车的整车厂。"), "2806": ("🚛", "卡车和客车。"),
    "3301": ("🧊", "空调冰箱洗衣机。"), "3302": ("📺", "电视机。"), "3303": ("🍳", "小家电。"), "3304": ("🚰", "厨电和卫浴电器。"),
    "3305": ("💡", "照明设备。"), "3306": ("⚙️", "家电零部件，压缩机电机这些。"), "3307": ("🔌", "其他家电。"),
    "3404": ("🍱", "肉制品、速冻和预制菜。"), "3405": ("🍶", "白酒，A股的硬通货。"), "3406": ("🍺", "啤酒、黄酒和葡萄酒。"),
    "3407": ("🥛", "饮料和乳品。"), "3408": ("🍪", "零食和烘焙。"), "3409": ("🧂", "酱油醋和调味品。"),
    "3501": ("🧵", "纺纱织布和印染。"), "3502": ("👔", "服装和家纺品牌。"), "3503": ("💍", "黄金珠宝首饰。"),
    "3601": ("📄", "造纸。"), "3602": ("📦", "包装和印刷。"), "3603": ("🛋️", "家具、卫浴和家居用品。"), "3605": ("✏️", "文具、玩具和体育用品。"),
    "3701": ("💊", "化学药和原料药。"), "3702": ("🌿", "中药和中成药。"), "3703": ("🧬", "疫苗、血制品和生物药。"),
    "3704": ("🚚", "医药流通和连锁药店。"), "3705": ("🩺", "医疗设备、耗材和诊断。"), "3706": ("🏥", "医院和研发外包（CXO）。"),
    "4101": ("🔌", "火电、水电、核电、风光发电。"), "4103": ("🔥", "城市燃气。"),
    "4208": ("📦", "快递和物流。"), "4209": ("🛣️", "铁路和高速公路。"), "4210": ("🛫", "航空公司和机场。"), "4211": ("🚢", "航运和港口。"),
    "4301": ("🏗️", "盖楼卖房的开发商。"), "4303": ("🔑", "物业管理和房产中介。"),
    "4502": ("🚢", "贸易公司。"), "4503": ("🏬", "百货、超市和商业综合体。"), "4504": ("🏪", "专业连锁店。"),
    "4506": ("🛒", "电商和跨境电商。"), "4507": ("🛍️", "免税和旅游零售。"),
    "4606": ("⚽", "体育。"), "4607": ("🛵", "本地生活服务。"), "4608": ("📋", "检测、人力和咨询这些专业服务。"),
    "4609": ("🍜", "酒店和餐饮。"), "4610": ("🏞️", "旅游景区。"), "4611": ("🎓", "学校和培训。"),
    "4802": ("🏛️", "工农中建交邮，国家队银行。"), "4803": ("🏦", "招行兴业这些全国性股份行。"),
    "4804": ("🏙️", "城市商业银行。"), "4805": ("🌾", "农村商业银行。"), "4806": ("🏦", "其他银行。"),
    "4901": ("📈", "券商，牛市第一个跑。"), "4902": ("☂️", "保险公司。"), "4903": ("💼", "信托、租赁、期货和多元金融。"),
    "5101": ("🏙️", "综合类。"),
    "6101": ("🧱", "水泥。"), "6102": ("🪟", "玻璃和玻纤。"), "6103": ("🪚", "管材、涂料、瓷砖这些装修建材。"),
    "6201": ("🏢", "房屋建设。"), "6202": ("🪚", "装修装饰。"), "6203": ("🛣️", "修路架桥的基建央企。"),
    "6204": ("🏗️", "钢结构、化学工程这些专业工程。"), "6206": ("📐", "工程设计和咨询。"),
    "6301": ("🌀", "电机。"), "6303": ("🔌", "其他电源设备。"), "6305": ("☀️", "光伏硅料、硅片、电池片和组件。"),
    "6306": ("🌬️", "风机和风电零部件。"), "6307": ("🔋", "动力电池、储能和锂电材料。"), "6308": ("⚡", "特高压、变压器和电网设备。"),
    "6401": ("⚙️", "机床、轴承、泵阀这些通用设备。"), "6402": ("🛠️", "各行各业的专用设备。"), "6405": ("🚆", "高铁地铁设备。"),
    "6406": ("🚜", "挖掘机和起重机。"), "6407": ("🤖", "机器人、工控和激光设备。"),
    "6501": ("🚀", "火箭和卫星。"), "6502": ("✈️", "军机和航空发动机。"), "6503": ("🛡️", "地面兵器。"),
    "6504": ("🚢", "军船和船舶制造。"), "6505": ("🛰️", "军工电子和雷达。"),
    "7101": ("🖥️", "服务器、安防和计算机设备。"), "7103": ("🧑‍💻", "IT服务和系统集成。"), "7104": ("🧩", "软件开发。"),
    "7204": ("🎮", "游戏。"), "7205": ("📣", "广告营销。"), "7206": ("🎞️", "影视和院线。"), "7207": ("📲", "数字媒体。"),
    "7208": ("💬", "社交平台。"), "7209": ("📚", "出版。"), "7210": ("📺", "电视广播。"),
    "7301": ("📞", "三大运营商和通信服务。"), "7302": ("📶", "光模块、通信设备和天线，AI 算力的光通路。"),
    "7401": ("⚫", "煤矿。"), "7402": ("🔥", "焦炭。"), "7501": ("⛽", "油气开采。"), "7502": ("🔧", "油服和海上工程。"),
    "7503": ("🏭", "炼化和油品贸易。"), "7601": ("💧", "污水、固废和环境治理。"), "7602": ("♻️", "环保设备。"),
    "7701": ("🧴", "纸尿裤、卫生巾这些个护用品。"), "7702": ("💄", "化妆品。"), "7703": ("💉", "医美。"),
}


SW_SHORT = {
    "消费电子零部件及组装": "消费电子组装", "通信网络设备及器件": "通信网络设备", "通信线缆及配套": "通信线缆",
    "通信终端及配件": "通信终端", "蓄电池及其他电池": "蓄电池等", "线缆部件及其他": "线缆部件", "食品及饲料添加剂": "食品添加剂",
    "能源及重型设备": "重型设备", "车身附件及饰件": "车身饰件", "汽车电子电气系统": "汽车电子", "底盘与发动机系统": "底盘发动机",
    "其他汽车零部件": "其他汽配", "水务及水治理": "水务治理", "综合环境治理": "综合环保", "纺织服装设备": "纺服设备",
    "印刷包装机械": "包装机械", "制冷空调设备": "制冷空调", "电网自动化设备": "电网自动化", "电工仪器仪表": "电工仪表",
    "光伏电池组件": "电池组件", "光伏加工设备": "光伏装备", "锂电专用设备": "锂电设备", "其他计算机设备": "其他计算机",
    "其他自动化设备": "其他自动化", "胶黏剂及胶带": "胶黏剂", "电能综合服务": "电能服务", "旅游及景区": "旅游景区",
    "其他化学原料": "其他化原料", "其他塑料制品": "其他塑料", "其他橡胶制品": "其他橡胶", "其他专业工程": "其他工程",
    "其他通用设备": "其他通用", "其他专用设备": "其他专用", "其他家居用品": "其他家居", "其他化学制品": "其他化学品",
    "非金属材料Ⅲ": "非金属材料", "医疗研发外包": "研发外包", "医院": "医院", "其他医疗服务": "其他医疗服务",
    "体外诊断": "体外诊断", "专业连锁Ⅲ": "专业连锁", "跨境电商": "跨境电商", "国有大型银行": "国有大行",
    "工程咨询服务": "工程咨询", "地面兵装Ⅲ": "地面兵装", "航天装备Ⅲ": "航天装备", "航空装备Ⅲ": "航空装备",
    "军工电子Ⅲ": "军工电子", "航海装备Ⅲ": "航海装备", "钼": "钼", "其他金属新材料": "其他新材料", "磁性材料": "磁材",
    "其他小金属": "其他小金属", "铅锌": "铅锌", "其他通信设备": "其他通信", "品牌消费电子": "品牌电子",
}


def sw_clean(name):
    name = (name or "").strip()
    name = SW_SHORT.get(name, name)
    return SW_SHORT.get(name.replace("Ⅱ", "").replace("Ⅲ", "").strip(), name.replace("Ⅱ", "").replace("Ⅲ", "").strip())
