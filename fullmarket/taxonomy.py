"""Full-market taxonomy tables: 11 sectors -> Nasdaq industries (+ a few sensible synthetic groups).

Nasdaq's industry labels are SIC-based and sometimes odd (Visa under "Business Services", General
Dynamics under "Marine Transportation", ASML under "Industrial Machinery"). We keep Nasdaq industries
as the backbone and fix the worst cases with:
  SYNTH      named cross-industry groups (payments, crypto, defense, space, nuclear, BDCs, ...)
  TICKER_TO  single-ticker moves into an existing industry slug
  MERGE      small industries folded into a sensible sibling
Industries that still have < 4 members are auto-merged into the largest sibling of the same sector;
industries with > 60 members are split into children (REIT sub-types, or market-cap tiers).
"""

# sector key -> (zh name, emoji, desc, tags)
SECTORS = {
    "tech":   ("科技", "💻", "做芯片、电脑、软件和网络设备的公司，数字世界的地基。", []),
    "comm":   ("通信传媒", "📡", "电话网、互联网平台、影视和游戏，让信息和故事跑起来。", []),
    "health": ("医疗", "🏥", "药、医疗器械、医院和医保，管人的身体。", ["health"]),
    "fin":    ("金融", "🏦", "银行、券商、保险、支付和加密货币，钱本身住的地方。", ["finance"]),
    "realty": ("房地产", "🏠", "收租的地产信托、盖房子的建筑商和地产中介。", ["realestate"]),
    "energy": ("能源", "🛢️", "挖油气、运油气、炼油，还有铀矿和太阳能。", ["energy"]),
    "util":   ("公用事业", "💡", "电、水、燃气这些每天都离不开的东西，按月收费。", ["power"]),
    "mat":    ("原材料", "⛏️", "化工、金属、矿石和木材，造一切东西的原料。", []),
    "ind":    ("工业", "🏭", "机器、飞机、军工、运输和工程，经济的肌肉。", []),
    "disc":   ("可选消费", "🛍️", "想买才买的东西：车、衣服、餐厅、旅游、电商。", ["consumer"]),
    "staple": ("必需消费", "🛒", "吃喝和日用品，再穷也得买。", ["consumer"]),
}
SECTOR_ORDER = ["tech", "comm", "health", "fin", "ind", "disc", "staple", "energy", "util", "mat", "realty"]

# Nasdaq industry -> (slug, sector, zh, emoji, desc, tags)
IND = {
    # --- tech
    "Semiconductors": ("semis", "tech", "芯片", "🔌", "设计和制造芯片的公司，电子世界的砖头。", ["chip"]),
    "Computer Software: Prepackaged Software": ("software", "tech", "软件", "🧩", "卖软件和云服务的公司，按年收订阅费。", ["software"]),
    "EDP Services": ("it-services", "tech", "IT服务", "🖥️", "替企业管系统、算工资、跑电脑的外包大管家。", ["software"]),
    "Electronic Components": ("components", "tech", "电子元件", "🔩", "连接器、传感器、光器件这些电子零件。", []),
    "Electrical Products": ("ems", "tech", "电子代工", "🏭", "替别人组装电路板和电子产品的工厂。", []),
    "Computer Manufacturing": ("hardware", "tech", "电脑硬件", "💻", "做电脑、服务器和手机的公司。", []),
    "Computer peripheral equipment": ("peripherals", "tech", "电脑外设", "🖱️", "键盘鼠标、打印机、3D 打印这些电脑周边。", []),
    "Computer Communications Equipment": ("networking", "tech", "网络设备", "🌐", "交换机和路由器，让数据在网线里跑。", []),
    "Radio And Television Broadcasting And Communications Equipment": ("wireless", "tech", "无线设备", "📡", "基站、对讲机和卫星，让信号在空中飞。", []),
    "Telecommunications Equipment": ("telecom-equip", "tech", "通信设备", "📶", "光纤、光模块和通信器材，网络的血管。", []),
    "Retail: Computer Software & Peripheral Equipment": ("it-distrib", "tech", "IT分销", "📦", "把电脑、软件批发给企业的中间商。", []),
    "Multi-Sector Companies": ("licensing", "tech", "专利授权", "📜", "靠专利和技术授权收钱的公司。", []),
    # --- comm
    "Computer Software: Programming Data Processing": ("internet", "comm", "互联网", "🌐", "搜索、社交、广告这些天天上网用的平台。", []),
    "Cable & Other Pay Television Services": ("cable", "comm", "有线电视", "📺", "拉网线、卖电视和宽带套餐的公司。", []),
    "Broadcasting": ("broadcast", "comm", "广播音频", "📻", "电台、电视台和音乐流媒体。", []),
    "Movies/Entertainment": ("movies", "comm", "影视娱乐", "🎬", "拍电影、开影院、做视频流媒体的公司。", []),
    "Consumer Electronics/Video Chains": ("movies", "comm", "影视娱乐", "🎬", "", []),
    "Advertising": ("ads", "comm", "广告营销", "📣", "帮品牌打广告、做营销的公司。", []),
    "Publishing": ("publishing", "comm", "出版资讯", "📚", "书、报纸、数据和资讯的出版商。", []),
    "Newspapers/Magazines": ("publishing", "comm", "出版资讯", "📚", "", []),
    "Books": ("publishing", "comm", "出版资讯", "📚", "", []),
    # --- health
    "Biotechnology: Pharmaceutical Preparations": ("pharma", "health", "制药", "💊", "研发和卖药的公司，一款新药能养活一家公司。", ["biotech"]),
    "Pharmaceuticals and Biotechnology": ("pharma", "health", "制药", "💊", "", ["biotech"]),
    "Biotechnology: Biological Products (No Diagnostic Substances)": ("biologics", "health", "生物药", "🧬", "用细胞、抗体和基因做药的生物科技公司。", ["biotech"]),
    "Medical/Dental Instruments": ("medtech", "health", "医疗器械", "🩺", "手术机器人、心脏支架、血糖仪这些医疗器械。", []),
    "Industrial Specialties": ("ind-special", "ind", "工业特材", "🧱", "特种材料、安全设备和工业小众产品。", []),
    "Medical Specialities": ("labs", "health", "化验检测", "🧪", "抽血化验、基因检测这类化验服务。", []),
    "Medical/Nursing Services": ("care-services", "health", "医疗服务", "👩‍⚕️", "居家护理、远程看病、心理咨询这类服务。", []),
    "Hospital/Nursing Management": ("hospitals", "health", "医院养老", "🏥", "开医院、康复中心和养老院的公司。", []),
    "Biotechnology: Laboratory Analytical Instruments": ("lab-tools", "health", "实验仪器", "🔬", "给药厂和实验室卖仪器、试剂的公司。", []),
    "Precision Instruments": ("lab-tools", "health", "实验仪器", "🔬", "", []),
    "Biotechnology: In Vitro & In Vivo Diagnostic Substances": ("diagnostics", "health", "诊断试剂", "🧫", "做化验试剂和检测盒的公司。", ["biotech"]),
    "Biotechnology: Electromedical & Electrotherapeutic Apparatus": ("electromed", "health", "医疗电子", "💓", "起搏器、影像设备这类带电的医疗设备。", []),
    "Medical Electronics": ("electromed", "health", "医疗电子", "💓", "", []),
    "Biotechnology: Commercial Physical & Biological Resarch": ("cro", "health", "医药外包", "🧪", "替药厂跑临床试验、做研究的外包公司。", []),
    "Medicinal Chemicals and Botanical Products": ("cannabis", "health", "大麻草药", "🌿", "大麻、草药和天然药物相关的公司。", []),
    "Other Pharmaceuticals": ("drug-distrib", "health", "医药分销", "🚚", "把药从药厂送到药店和医院的批发商。", []),
    "Retail-Drug Stores and Proprietary Stores": ("drug-distrib", "health", "医药分销", "🚚", "", []),
    "Ophthalmic Goods": ("eyecare", "health", "眼科", "👓", "隐形眼镜、眼镜和眼科手术。", []),
    "Misc Health and Biotechnology Services": ("dialysis", "health", "透析与健康", "🩸", "洗肾中心、生育服务这类专门健康服务。", []),
    # --- finance
    "Major Banks": ("banks", "fin", "美国银行", "🏦", "存钱放贷的美国银行，经济的血管。", []),
    "Commercial Banks": ("banks", "fin", "美国银行", "🏦", "", []),
    "Banks": ("thrifts", "fin", "储蓄银行", "🐷", "吸收存款、主要放房贷的储蓄银行和社区小银行。", []),
    "Savings Institutions": ("thrifts", "fin", "储蓄银行", "🐷", "", []),
    "Finance: Consumer Services": ("consumer-fin", "fin", "消费信贷", "💳", "信用卡、消费贷、学生贷，借钱给个人的公司。", []),
    "Investment Managers": ("asset-mgmt", "fin", "资产管理", "💼", "替别人管钱、收管理费的基金公司和私募。", []),
    "Investment Bankers/Brokers/Service": ("brokers", "fin", "券商交易所", "📈", "买卖股票的券商、投行和交易所。", []),
    "Property-Casualty Insurers": ("pc-insur", "fin", "财产保险", "🛡️", "车险、房屋险、灾害险，赔东西坏了的钱。", []),
    "Life Insurance": ("life-insur", "fin", "人寿保险", "👪", "卖寿险、年金和养老钱的公司。", []),
    "Accident &Health Insurance": ("life-insur", "fin", "人寿保险", "👪", "", []),
    "Specialty Insurers": ("insur-brokers", "fin", "保险经纪", "🤝", "帮企业买保险拿佣金的经纪商和特种保险。", []),
    "Finance Companies": ("fin-cos", "fin", "专项金融", "🏛️", "催收、农业贷款这类专门的金融公司。", []),
    "Finance/Investors Services": ("fin-cos", "fin", "专项金融", "🏛️", "", []),
    "Diversified Financial Services": ("fin-cos", "fin", "专项金融", "🏛️", "", []),
    # --- real estate
    "Real Estate Investment Trusts": ("reits", "realty", "收租信托", "🏢", "拥有楼宇收租金、再把钱分给股东的地产信托（REIT）。", []),
    "Real Estate": ("re-services", "realty", "地产服务", "🔑", "卖房中介、物业管理和地产开发商。", []),
    "Building operators": ("re-services", "realty", "地产服务", "🔑", "", []),
    "Homebuilding": ("homebuilders", "realty", "盖房子", "🏗️", "盖新房子卖给家庭的建筑商。", []),
    # --- energy
    "Oil & Gas Production": ("e-and-p", "energy", "油气开采", "🛢️", "在地下找油、抽油、卖油的公司。", ["oil"]),
    "Integrated oil Companies": ("big-oil", "energy", "石油巨头", "🏛️", "从开采到加油站全包的石油巨头。", ["oil"]),
    "Oil Refining/Marketing": ("refining", "energy", "炼油加油", "⛽", "把原油炼成汽油柴油，再卖到加油站。", ["oil"]),
    "Oil/Gas Transmission": ("midstream", "energy", "油气管道", "🛤️", "铺管道、建储罐、出口液化气，把油气运到四面八方。", ["oil"]),
    "Oilfield Services/Equipment": ("oil-services", "energy", "油服", "🛠️", "帮油公司打井、压裂、修设备的服务商。", ["oil"]),
    "Oil and Gas Field Machinery": ("oil-equip", "energy", "油气设备", "🔧", "钻机、井口和海上平台设备。", ["oil"]),
    "Coal Mining": ("coal", "energy", "煤炭", "⚫", "挖煤的公司，炼钢和发电都要用。", []),
    # --- utilities
    "Electric Utilities: Central": ("electric", "util", "电力公司", "⚡", "发电送电、按月收电费的电力公司。", []),
    "Power Generation": ("electric", "util", "电力公司", "⚡", "", []),
    "Natural Gas Distribution": ("gas-util", "util", "燃气", "🔥", "把天然气送到家里做饭取暖的公司。", []),
    "Water Supply": ("water", "util", "水务", "💧", "自来水和污水处理公司。", []),
    # --- materials
    "Major Chemicals": ("chemicals", "mat", "化工", "🧪", "生产塑料原料、工业气体、涂料的化工厂。", []),
    "Specialty Chemicals": ("chemicals", "mat", "化工", "🧪", "", []),
    "Paints/Coatings": ("chemicals", "mat", "化工", "🧪", "", []),
    "Precious Metals": ("gold", "mat", "黄金白银", "🥇", "挖金矿银矿、或者买金矿分成的公司。", ["gold", "metals"]),
    "Metal Mining": ("metals", "mat", "铜铁稀土", "⛏️", "挖铜、铁、锂和稀土的矿业公司。", ["metals"]),
    "Other Metals and Minerals": ("metals", "mat", "铜铁稀土", "⛏️", "", ["metals"]),
    "Steel/Iron Ore": ("steel", "mat", "钢铁铝", "🏗️", "炼钢、炼铝、做金属材料的公司。", ["metals"]),
    "Aluminum": ("steel", "mat", "钢铁铝", "🏗️", "", ["metals"]),
    "Mining & Quarrying of Nonmetallic Minerals (No Fuels)": ("aggregates", "mat", "砂石骨料", "🪨", "挖砂石、做骨料的公司，盖楼修路要用。", []),
    "Building Materials": ("cement", "mat", "水泥建材", "🧱", "水泥、混凝土和外墙板。", []),
    "Containers/Packaging": ("packaging", "mat", "包装", "📦", "纸箱、易拉罐、玻璃瓶这些包装。", []),
    "Paper": ("paper", "mat", "造纸", "📄", "生产纸浆和纸张的公司。", []),
    "Forest Products": ("wood", "mat", "木材", "🌲", "砍树、做木板和建筑木料的公司。", []),
    "Plastic Products": ("plastics", "mat", "塑料制品", "🧴", "塑料瓶盖、管材、泳池这类塑料制品。", []),
    "Agricultural Chemicals": ("agchem", "mat", "化肥农药", "🌱", "化肥和农药，让庄稼长得更好。", []),
    # --- industrials
    "Industrial Machinery/Components": ("machinery", "ind", "工业机械", "⚙️", "造机器、泵、马达和自动化设备的工厂。", []),
    "Miscellaneous manufacturing industries": ("machinery", "ind", "工业机械", "⚙️", "", []),
    "Aerospace": ("aerospace", "ind", "航空航天", "✈️", "造飞机、发动机和机场运营的公司。", []),
    "Military/Government/Technical": ("gov-eng", "ind", "工程顾问", "📐", "替政府和大企业做设计、工程和技术外包。", []),
    "Engineering & Construction": ("construction", "ind", "基建施工", "🚧", "盖厂房、架电网、装空调的施工承包商。", []),
    "Water Sewer Pipeline Comm & Power Line Construction": ("construction", "ind", "基建施工", "🚧", "", []),
    "General Bldg Contractors - Nonresidential Bldgs": ("construction", "ind", "基建施工", "🚧", "", []),
    "Metal Fabrications": ("metal-fab", "ind", "金属加工", "🔩", "做轴承、阀门、液压件这些金属零件的工厂。", []),
    "Marine Transportation": ("shipping", "ind", "航运", "🚢", "开大船运油、运气、运集装箱的公司。", []),
    "Air Freight/Delivery Services": ("airlines", "ind", "航空公司", "🛫", "载客飞行的航空公司。", []),
    "Trucking Freight/Courier Services": ("trucking", "ind", "卡车快递", "🚚", "开卡车、送快递的运输公司。", []),
    "Railroads": ("rail", "ind", "铁路", "🚂", "拉货的铁路公司，北美经济的大动脉。", []),
    "Integrated Freight & Logistics": ("logistics", "ind", "物流货代", "📦", "替别人安排运输、管仓库的货代公司。", []),
    "Construction/Ag Equipment/Trucks": ("heavy-mach", "ind", "工程机械", "🚜", "挖掘机、拖拉机、重卡这些大家伙。", []),
    "Tools/Hardware": ("heavy-mach", "ind", "工程机械", "🚜", "", []),
    "Professional Services": ("consulting", "ind", "咨询人力", "👔", "管理咨询、猎头和劳务派遣。", []),
    "Business Services": ("biz-services", "ind", "企业服务", "📋", "替企业处理数据、外包、拍卖这些杂事。", []),
    "Diversified Commercial Services": ("rentals-svc", "ind", "设备租赁", "🧰", "出租工程设备、做安保清洁的企业服务。", []),
    "Rental/Leasing Companies": ("leasing", "ind", "租车租机", "🚐", "租车、租卡车、租飞机的公司。", []),
    "Misc Corporate Leasing Services": ("leasing", "ind", "租车租机", "🚐", "", []),
    "Environmental Services": ("waste", "ind", "垃圾环保", "♻️", "收垃圾、处理废物的公司。", []),
    "Office Equipment/Supplies/Services": ("office", "ind", "办公设备", "🖨️", "ATM、收银机、办公家具这些。", []),
    "Fluid Controls": ("fluid", "ind", "泵阀水处理", "🚰", "泵、阀门、过滤器和水处理设备。", []),
    "Pollution Control Equipment": ("fluid", "ind", "泵阀水处理", "🚰", "", []),
    "Building Products": ("building-prod", "ind", "建筑产品", "🚪", "门窗、灯具、屋顶这些建筑用品。", []),
    "Ordnance And Accessories": ("arms", "ind", "枪械安防", "🎯", "警用电击枪、执法记录仪和枪支弹药。", ["defense"]),
    "Wholesale Distributors": ("ind-distrib", "ind", "工业批发", "🧰", "", []),
    "Durable Goods": ("ind-distrib", "ind", "工业批发", "🧰", "", []),
    "Miscellaneous": ("ind-distrib", "ind", "工业批发", "🧰", "", []),
    "Professional and commerical equipment": ("ind-distrib", "ind", "工业批发", "🧰", "", []),
    "Electronics Distribution": ("specialty-retail", "disc", "专卖店", "🏬", "", []),
    "Garments and Clothing": ("apparel", "disc", "服装品牌", "👕", "", []),
    "Textiles": ("apparel", "disc", "服装品牌", "👕", "", []),
    # --- consumer discretionary
    "Auto Manufacturing": ("autos", "disc", "汽车", "🚗", "造汽车的公司，从油车到电动车。", ["ev"]),
    "Auto Parts:O.E.M.": ("auto-parts", "disc", "汽车零件", "🔧", "给车厂供应零件的公司。", []),
    "Motor Vehicles": ("rv-moto", "disc", "摩托房车", "🏍️", "摩托车、房车、游艇这些大玩具。", []),
    "Automotive Aftermarket": ("auto-after", "disc", "汽车后市场", "🛞", "轮胎、修车、汽配零售这些车的售后生意。", []),
    "Auto & Home Supply Stores": ("auto-after", "disc", "汽车后市场", "🛞", "", []),
    "Retail-Auto Dealers and Gas Stations": ("auto-dealers", "disc", "汽车经销", "🚙", "卖新车二手车的车行，和加油站便利店。", []),
    "Catalog/Specialty Distribution": ("ecommerce", "disc", "电商", "🛒", "在网上卖货的平台和网店。", []),
    "Restaurants": ("restaurants", "disc", "餐厅", "🍔", "汉堡、咖啡、墨西哥卷这些连锁餐厅。", []),
    "Hotels/Resorts": ("hotels", "disc", "酒店赌场", "🏨", "连锁酒店、度假村和赌场。", []),
    "Services-Misc. Amusement & Recreation": ("leisure", "disc", "娱乐休闲", "🎢", "主题乐园、体育赛事、博彩和演唱会。", []),
    "Other Consumer Services": ("life-services", "disc", "生活服务", "🧺", "殡葬、报税、托儿这类生活服务。", []),
    "Apparel": ("apparel", "disc", "服装品牌", "👕", "卖衣服的品牌，从运动服到奢侈品。", []),
    "Shoe Manufacturing": ("shoes", "disc", "鞋", "👟", "运动鞋和皮鞋品牌。", []),
    "Clothing/Shoe/Accessory Stores": ("apparel-retail", "disc", "服饰零售", "👗", "卖衣服鞋包的连锁店，包括折扣店。", []),
    "Other Specialty Stores": ("specialty-retail", "disc", "专卖店", "🏬", "美妆、体育用品、家具、典当这些专门店。", []),
    "Consumer Specialties": ("specialty-retail", "disc", "专卖店", "🏬", "", []),
    "Home Furnishings": ("home", "disc", "家居", "🛋️", "家具、床垫、地毯和厨房用品。", []),
    "RETAIL: Building Materials": ("home-improve", "disc", "家装建材", "🔨", "卖装修材料和工具的大卖场。", []),
    "Consumer Electronics/Appliances": ("gadgets", "disc", "家电数码", "📱", "电视、音响、家电和小电器。", []),
    "Recreational Games/Products/Toys": ("toys", "disc", "玩具运动", "🧸", "玩具、高尔夫球具、健身器材。", []),
    "Transportation Services": ("travel", "disc", "旅游预订", "🧳", "订机票、订酒店、订民宿的旅游平台。", []),
    # --- consumer staples
    "Department/Specialty Retail Stores": ("big-box", "staple", "超市卖场", "🏪", "沃尔玛、好市多这种什么都卖的大卖场。", []),
    "Food Chains": ("grocers", "staple", "生鲜超市", "🥬", "卖蔬菜水果肉的连锁超市。", []),
    "Beverages (Production/Distribution)": ("beverages", "staple", "饮料酒水", "🥤", "可乐、啤酒、烈酒和能量饮料。", []),
    "Packaged Foods": ("foods", "staple", "包装食品", "🥫", "零食、罐头、调料这些超市货架上的食品。", []),
    "Specialty Foods": ("snacks", "staple", "糖果零食", "🍫", "巧克力、糖果和坚果零食。", []),
    "Meat/Poultry/Fish": ("meat", "staple", "肉类", "🥩", "养鸡养猪、做肉制品的公司。", []),
    "Farming/Seeds/Milling": ("farming", "staple", "农业粮食", "🌾", "种子、粮食贸易、农场和果蔬。", []),
    "Food Distributors": ("food-distrib", "staple", "食品批发", "🚛", "把食材批发给餐厅和学校的公司。", []),
    "Package Goods/Cosmetics": ("household", "staple", "日用美妆", "🧴", "牙膏、洗发水、纸巾、化妆品这些每天要用的东西。", []),
    "Tobacco": ("tobacco", "staple", "烟草", "🚬", "香烟、电子烟和尼古丁袋。", []),
}

# synthetic groups: slug -> (sector, zh, emoji, desc, tags, [tickers])
SYNTH = {
    "semi-equip": ("tech", "芯片设备", "🔬", "造芯片用的光刻机、刻蚀机和检测机，芯片厂的铲子。", ["chip", "ai"],
                   "ASML LRCX KLAC AMAT ONTO MKSI TER COHU AEHR NVMI CAMT KLIC FORM ACLS UCTT ICHR ENTG PLAB AMKR VECO ACMR "
                   "BESI ASYS KLIC CAMT".split()),
    "storage": ("tech", "存储", "💾", "内存和硬盘，AI 时代存数据的仓库。", ["chip", "ai"],
                "MU SKHY SNDK STX WDC PSTG P NTAP SIMO".split()),
    "cyber": ("tech", "网络安全", "🛡️", "防黑客、管密码、守数据的安全公司。", ["security", "software"],
              "PANW CRWD FTNT ZS NET OKTA CYBR CHKP S QLYS TENB RPD VRNS FFIV SAIL RBRK GEN CVLT VRSN "
              "NTCT ATEN OSPN CRWV_X".split()),
    "quantum": ("tech", "量子计算", "⚛️", "用量子原理造新型计算机的公司，还很早期。", [],
                "IONQ RGTI QBTS QNT QUBT XNDU HQ BTQ ARQQ QMCO".split()),
    "ai-cloud": ("tech", "AI 云算力", "☁️", "出租 GPU、建 AI 数据中心的新云公司。", ["ai", "cloud"],
                 "CRWV NBIS IREN CIFR WULF APLD CORZ GLXY DOCN VNET GDS KC".split()),
    "telecom": ("comm", "电信运营", "📞", "卖手机套餐和宽带、收月租的电话公司。", [],
                "VZ TMUS T AMX CHT VOD BCE VIV TU TIGO TLK SKM KT TIMB VEON TEO LUMN TDS TKC PHI KYIV AD "
                "IHS IDT CABO SHEN ATNI CCOI USM ECHO SATS".split()),
    "games": ("comm", "游戏", "🎮", "做电子游戏的公司。", [],
              "EA TTWO RBLX NTES U PLTK GRVY SCPL SOHU HUYA DOYU".split()),
    "payments": ("fin", "支付", "💸", "刷卡、扫码、转账背后的收钱通道。", [],
                 "V MA PYPL FISV FI FIS GPN CPAY WEX RELY DLO PAY PAYP XYZ FOUR WU EEFT PAGS STNE MQ FLYW PAYO "
                 "AFRM KLAR SEZL WSE KSPI ACIW TOST".split()),
    "crypto": ("fin", "加密货币", "🪙", "比特币交易所、矿场和囤币公司。", ["crypto"],
               "COIN CRCL MSTR BMNR HUT RIOT MARA CLSK BLSH ASST XXI BTDR GEMI BITF HIVE SBET ETHZ "
               "UPXI DFDV NAKA FIGR".split()),
    "ratings": ("fin", "评级数据", "📊", "给公司打分、卖金融数据和指数的公司。", [],
                "SPGI MCO MSCI FDS MORN EFX TRU FICO VRSK".split()),
    "bdc": ("fin", "私募贷款", "🤝", "把钱借给中小企业、收高利息再分红的放贷公司（BDC）。", [],
            "ARCC OBDC FSK MAIN HTGC BXSL GBDC TSLX OCSL PSEC MFIC BCSF NMFC SLRC TCPC CION FDUS CGBD KBDC "
            "NCDL OTF CCAP GAIN TRIN PFLT CSWC BBDC MSDL PSBD HRZN TPVG GSBD OFS SAR WHF PNNT GLAD MSIF".split()),
    "conglomerate": ("fin", "综合控股", "🏰", "什么都投的控股集团，比如巴菲特的伯克希尔。", [],
                     "BRK-B BN IX IEP L CODI BOC BBUC BIP BIPC SEB".split()),
    "managed-care": ("health", "医保公司", "🩹", "卖医疗保险、替病人付医药费的公司。", [],
                     "UNH ELV CI HUM CNC MOH OSCR ALHC CVS CLOV".split()),
    "nuclear": ("energy", "核能铀矿", "☢️", "挖铀矿、做核燃料、造小型核电站的公司。", ["power"],
                "CCJ NXE UEC DNN UUUU LEU OKLO SMR NNE XE NWCL IMSR STDN ISOU URG EU LTBR".split()),
    "solar": ("energy", "光伏储能", "☀️", "太阳能板、储能电池、燃料电池这些新能源。", ["clean"],
              "FSLR ENPH SEDG RUN NXT ARRY SHLS JKS DQ CSIQ FLNC EOSE PLUG BE TE MAXN NOVA GEVO "
              "AMPX ENVX QS SLDP FAC".split()),
    "ipp": ("util", "独立发电", "🔋", "自己发电卖给电网的发电商，AI 用电的大供应商。", ["power", "ai"],
            "VST CEG NRG TLN".split()),
    "defense": ("ind", "国防军工", "🎖️", "造导弹、战舰、无人机，卖给军队的公司。", ["defense"],
                "LMT NOC GD HII LHX KTOS ESLT BWXT DRS CW AVAV MRCY LDOS CACI SAIC BAH KRMN PSN VVX".split()),
    "space": ("ind", "太空", "🚀", "造火箭和卫星、在天上做生意的公司。", ["space"],
              "SPCX RKLB ASTS FLY RDW VOYG YSS PL BKSY LUNR SATL SPCE IRDM GSAT MDA TSAT".split()),
    "power-equip": ("ind", "电力设备", "🔌", "变压器、开关柜、发电机，电网和数据中心的心脏。", ["power", "ai"],
                    "GEV ETN VRT HUBB POWL NVT AMSC GNRC ENS ATKR".split()),
    "hvac": ("ind", "暖通空调", "❄️", "空调、暖气和楼宇控制，数据中心也靠它降温。", [],
             "TT CARR JCI LII AAON MOD SPXC OTIS".split()),
    "ind-distrib": ("ind", "工业批发", "🧰", "把螺丝、管道、电线批发给工厂和工地的分销商。", [],
                    "GWW FAST FERG WSO CNM SITE AIT MSM WCC DSGR BXC ADIG REZI DXPE POOL".split()),
    "ride-delivery": ("disc", "出行外卖", "🛵", "打车、送外卖、送生鲜的平台。", [],
                      "UBER DASH LYFT GRAB CART".split()),
    "cruise": ("disc", "邮轮", "🛳️", "开大邮轮带人度假的公司。", [],
               "RCL CCL NCLH VIK LIND".split()),
    "education": ("disc", "教育", "🎓", "学校、网课和补习班。", [],
                  "EDU TAL LAUR LOPE BFAM LRN DAO PRDO STRA UTI AFYA PXED APEI LINC GOTU GHC ATGE DUOL COUR "
                  "CHGG UDMY NRDY".split()),
    "tobacco": ("staple", "烟草", "🚬", "香烟、电子烟和尼古丁袋。", [],
                "PM MO BTI RLX TPB AIIR".split()),
}

# single-ticker moves into an existing slug (Nasdaq SIC labels that read wrong on a map)
TICKER_TO = {
    # tech
    "QCOM": "semis", "HPE": "hardware", "CDW": "it-distrib", "NSIT": "it-distrib", "CNXN": "it-distrib",
    "ARW": "it-distrib", "AVT": "it-distrib", "GRMN": "gadgets", "ZBRA": "hardware", "TRMB": "software",
    "KEYS": "components", "TDY": "components", "AME": "machinery", "ROP": "software", "ADEA": "licensing",
    "AKAM": "it-services", "ACN": "it-services", "IT": "consulting", "TEL": "components",
    "HUBB": "power-equip", "VLTO": "fluid", "CLS": "ems", "JBL": "ems", "FLEX": "ems", "APH": "components",
    # comm
    "NFLX": "movies", "DIS": "movies", "WMG": "movies", "IQ": "movies", "WBD": "movies", "SKYD": "movies",
    "YELP": "internet", "ZD": "internet", "BBY": "gadgets", "SPOT": "broadcast", "TME": "broadcast",
    # health
    "TMO": "lab-tools", "DHR": "lab-tools", "ISRG": "medtech", "EW": "medtech", "STE": "medtech",
    "ZBH": "medtech", "SNN": "medtech", "ALGN": "medtech", "ESTA": "medtech", "ENOV": "medtech", "AVR": "medtech",
    "ZJYL": "medtech", "SMTI": "medtech", "INCY": "pharma", "HSIC": "drug-distrib", "GRDN": "drug-distrib",
    "EVH": "care-services", "HLF": "household", "MMM": "machinery", "PRE": "diagnostics",
    # finance
    "BAM": "asset-mgmt", "HASI": "fin-cos", "EFC": "reits", "INVH": "reits", "TRNO": "reits", "GTY": "reits",
    "UE": "reits", "CURB": "reits", "HPP": "reits", "GOOD": "reits", "IIPR": "reits", "PDM": "reits",
    "BSRT": "reits", "PRG": "consumer-fin", "UPBD": "consumer-fin", "KPLT": "consumer-fin",
    "NU": "consumer-fin", "SOFI": "consumer-fin", "CHYM": "consumer-fin", "AXP": "consumer-fin",
    # energy
    "SHEL": "big-oil", "TTE": "big-oil", "E": "big-oil", "PBR": "big-oil", "CNQ": "big-oil", "CVE": "big-oil",
    "EC": "big-oil", "WDS": "big-oil", "MPC": "refining", "VLO": "refining", "PSX": "refining", "PBF": "refining",
    "CVI": "refining", "DK": "refining", "DINO": "refining", "PARR": "refining", "SUN": "refining",
    "ENB": "midstream", "WMB": "midstream", "EPD": "midstream", "KMI": "midstream", "TRGP": "midstream",
    "TRP": "midstream", "MPLX": "midstream", "PAA": "midstream", "PAGP": "midstream", "WES": "midstream",
    "DTM": "midstream", "AM": "midstream", "OKE": "midstream", "ET": "midstream", "HESM": "midstream",
    "KNTK": "midstream", "ENLC": "midstream", "PBA": "midstream", "KEY_X": "midstream", "GEL": "midstream",
    "ATO": "gas-util", "NFG": "gas-util", "NJR": "gas-util", "SR": "gas-util", "OGS": "gas-util",
    "NWN": "gas-util", "UGP": "refining", "SPH": "gas-util", "SGU": "gas-util", "DEC": "e-and-p",
    "BHP": "metals", "TECK": "metals", "SQM": "metals", "HL": "gold", "GAU": "gold", "UAMY": "metals",
    # materials
    "ECL": "chemicals", "SCL": "chemicals", "FUL": "chemicals", "ASPN": "chemicals", "CSL": "building-prod",
    "CLX": "household", "KMB": "household", "AMCR": "packaging", "GEF": "packaging", "KALU": "steel",
    "CSTM": "steel", "MTX": "chemicals",
    # industrials
    "GE": "aerospace", "EMR": "machinery", "AOS": "fluid", "DE": "heavy-mach", "PCAR": "heavy-mach",
    "OSK": "heavy-mach", "CMI": "heavy-mach", "AGCO": "heavy-mach", "LOAR": "aerospace", "ATRO": "aerospace",
    "DCO": "aerospace", "AADX": "aerospace", "TDG": "aerospace", "FER": "construction", "STRL": "construction", "GVA": "construction",
    "ROAD": "construction", "MWH": "construction", "FDX": "trucking", "FDXF": "trucking", "XPO": "logistics",
    "GXO": "logistics", "RXO": "logistics", "GATX": "leasing", "AER": "leasing", "HAFN": "shipping",
    "BWLP": "shipping", "VTOL": "airlines", "VRRM": "biz-services", "PAYX": "biz-services", "CTAS": "biz-services",
    "TNET": "consulting", "KFY": "consulting", "DFIN": "biz-services", "CRAI": "consulting",
    "RTO": "rentals-svc", "UNF": "rentals-svc", "MAS": "building-prod", "AWI": "building-prod",
    "AYI": "building-prod", "TTC": "heavy-mach", "BRK-B": "conglomerate", "TMS": "biz-services",
    "BELFB": "components", "BGSI": "auto-after", "AAUC": "gold", "ARIS": "gold", "AUXX": "gold", "BMM": "metals",
    "HSLV": "gold", "OGC": "gold", "CNL": "gold", "SLSR": "metals", "APXC": "metals", "AIN": "machinery",
    "THO": "rv-moto", "PII": "rv-moto", "DOO": "rv-moto", "BC": "rv-moto", "WGO": "rv-moto", "LCII": "rv-moto",
    "PATK": "rv-moto", "CWH": "rv-moto", "MBUU": "rv-moto", "MCFT": "rv-moto", "LKQ": "auto-after",
    "GPC": "auto-after", "XPEL": "auto-after",
    # consumer
    "BABA": "ecommerce", "PDD": "ecommerce", "MELI": "ecommerce", "EBAY": "ecommerce", "ETSY": "ecommerce",
    "JD": "ecommerce", "SE": "ecommerce", "CPNG": "ecommerce", "ABNB": "travel", "TCOM": "travel",
    "TRIP": "travel", "DPZ": "restaurants", "ADM": "farming", "BG": "farming", "DAR": "farming",
    "INGR": "foods", "CTVA": "farming", "WSM": "home", "RH": "home", "TSCO": "home-improve",
    "SGI": "home", "CSW": "building-prod", "QXO": "building-prod", "BLDR": "building-prod",
    "BCC": "building-prod", "IBP": "building-prod", "GEO": "re-services", "ECG": "construction",
    "CVNA": "auto-dealers", "KMX": "auto-dealers", "SBH": "specialty-retail",
}

# explicit merges for small industries (slug -> target slug)
MERGE = {
    "fin-cos": "consumer-fin",
    "licensing": "it-services",
    "arms": "defense",
    "office": "ind-distrib",
    "it-distrib": "ind-distrib",
    "eyecare": "medtech",
    "cannabis": "pharma",
}

# Giant industries (> SPLIT_MAX members) are split into children.
SPLIT_MAX = 60
SPLIT_TARGET = 45
TIER_LABELS = {   # one label per tier, biggest first; length should equal ceil(n / SPLIT_TARGET)
    "banks": ["大银行", "大中型银行", "中型银行", "地区银行", "社区银行"],
    "pharma": ["大药厂", "中大型药企", "中型药企", "小型药企", "新药初创", "微型药企"],
    "biologics": ["生物药大厂", "中小生物药"],
    "software": ["大型软件", "中型软件", "小型软件"],
    "machinery": ["机械大厂", "中小机械"],
    "e-and-p": ["油气大户", "中小油气"],
    "electric": ["大电力公司", "中小电力"],
    "it-services": ["大型IT服务", "中小IT服务"],
    "consumer-fin": ["大型信贷", "中小信贷"],
    "pc-insur": ["大财险", "中小财险"],
    "asset-mgmt": ["大资管", "中小资管"],
    "semis": ["芯片巨头", "中型芯片", "小型芯片"],
    "medtech": ["器械大厂", "中小器械"],
    "gold": ["大金矿", "中小金银矿"],
    "chemicals": ["化工大厂", "中小化工"],
}

# Sectors with too many industries for one planet get a middle layer (sector -> group -> industry).
GROUPS = {
    "ind": [
        ("ind-make", "机器制造", "⚙️", "造机器、零件、电力和空调设备的工厂。",
         ["machinery", "heavy-mach", "metal-fab", "fluid", "power-equip", "hvac", "ind-special"]),
        ("ind-air", "航空国防", "✈️", "飞机、军工和太空。", ["aerospace", "defense", "space"]),
        ("ind-move", "交通运输", "🚚", "用船、飞机、卡车、火车运人运货。",
         ["shipping", "airlines", "trucking", "rail", "logistics", "leasing"]),
        ("ind-build", "工程建筑", "🏗️", "盖楼修路、架电网，和卖建材五金。",
         ["construction", "gov-eng", "building-prod", "ind-distrib"]),
        ("ind-service", "企业服务", "📋", "替企业干杂活：外包、咨询、租设备、收垃圾。",
         ["biz-services", "consulting", "rentals-svc", "waste"]),
    ],
    "disc": [
        ("disc-auto", "汽车世界", "🚘", "造车、卖车、修车的一条龙，还有摩托房车。",
         ["autos", "auto-parts", "auto-dealers", "auto-after", "rv-moto"]),
        ("disc-shop", "逛街购物", "🛍️", "网上和街上的各种商店。",
         ["ecommerce", "specialty-retail", "home-improve", "home", "gadgets", "toys"]),
        ("disc-fun", "吃喝玩乐", "🎡", "餐厅、酒店、邮轮、旅游和娱乐。",
         ["restaurants", "hotels", "cruise", "leisure", "travel", "ride-delivery"]),
        ("disc-wear", "穿搭", "👗", "衣服、鞋子和服饰店。", ["apparel", "shoes", "apparel-retail"]),
        ("disc-life", "生活教育", "🎓", "学校网课和各种生活服务。", ["education", "life-services"]),
    ],
}

# REIT sub-types (the REIT industry is split by what the buildings are, not by size)
REIT_TYPES = [
    ("reit-dc", "数据中心铁塔", "🗼", "出租机房和信号塔的信托，AI 和手机信号的房东。", ["ai"],
     "EQIX DLR AMT CCI SBAC IRM UNIT BXDC".split(), None),
    ("reit-resi", "公寓住宅", "🏘️", "出租公寓、独栋房和活动房营地的信托。", [],
     "AVB EQR ESS MAA UDR CPT INVH AMH SUI ELS IRT ELME NXRT VRE CSR UMH AIV BRT VMRK".split(),
     r"Residential|Apartment|Homes\b|Communities|Living"),
    ("reit-ind", "仓库物流", "🏭", "出租仓库和物流中心的信托，网购的房东。", [],
     "PLD REXR EGP FR STAG TRNO LINE COLD ILPT PLYM LXP IIPR MRP GOOD".split(), r"Industrial|Logistic|Warehouse"),
    ("reit-retail", "商场门店", "🛍️", "出租购物中心和街边店铺的信托。", [],
     "SPG O KIM REG FRT NNN ADC BRX MAC SKT KRG PECO SITC AKR UE GTY FCPT EPRT CURB BFS ALX IVT WSR NTST "
     "ROIC CBL PINE FVR".split(), r"Retail|Shopping|Mall|Outlet"),
    ("reit-office", "写字楼", "🏢", "出租办公楼和实验室楼的信托。", [],
     "BXP VNO SLG KRC CUZ HIW DEI HPP PDM BDN JBGS ESRT EQC CDP DEA PGRE AAT CIO FSP OPI NLOP ARE".split(),
     r"Office"),
    ("reit-health", "医疗养老", "🧓", "出租养老院、医院和诊所楼的信托。", ["health"],
     "WELL VTR DOC OHI SBRA CTRE NHI MPW HR AHR LTC UHT GMRE CHCT DHC".split(), r"Health|Medical|Senior|Care\b"),
    ("reit-mort", "房贷信托", "🏦", "不买楼、专门放房贷和买房贷债券的信托，对利率最敏感。", ["rates", "finance"],
     "NLY AGNC STWD BXMT RITM ABR LADR KREF ACRE TRTX EFC IVR ARR DX ORC CIM MFA PMT RC TWO BRSP FBRT ADAM "
     "NREF SEVN AOMR MITT RWT LFT CHMI GPMT ACR".split(), r"Mortgage|Lending|Capital|Finance|Credit"),
    ("reit-hotel", "酒店赌场", "🎰", "拥有酒店和赌场楼的信托。", [],
     "HST PK RHP APLE VICI GLPI SHO DRH PEB XHR RLJ INN EPR".split(), r"Hotel|Hospitality|Lodging|Resort"),
    ("reit-special", "特种信托", "🌲", "自助仓储、林地、广告牌这些特别的收租生意。", [],
     "PSA EXR CUBE NSA SMA WY RYN PCH LAMR OUT SAFE FPI LAND".split(), None),
]

AI_TICKERS = set("""NVDA AMD AVGO TSM MU SKHY MRVL ARM SMCI VRT ANET CRWV NBIS ALAB CRDO PLTR MSFT GOOGL META AMZN
ORCL CBRS SNDK DELL CLS COHR LITE CIEN FN AAOI APLD IREN CIFR WULF CORZ ETN GEV VST CEG TLN OKLO SMR
ASML AMAT LRCX KLAC TER CDNS SNPS INTC QCOM APP AI SOUN BBAI PATH SNOW DDOG MDB NET HPE""".split())

COUNTRY_ZH = {
    "United States": "", "Canada": "加拿大", "United Kingdom": "英国", "China": "中国", "Hong Kong": "香港",
    "Israel": "以色列", "Bermuda": "百慕大", "Brazil": "巴西", "Netherlands": "荷兰", "Cayman Islands": "开曼",
    "Switzerland": "瑞士", "Ireland": "爱尔兰", "Singapore": "新加坡", "Argentina": "阿根廷",
    "Luxembourg": "卢森堡", "Mexico": "墨西哥", "South Korea": "韩国", "Greece": "希腊", "France": "法国",
    "Japan": "日本", "Taiwan": "台湾", "India": "印度", "Germany": "德国", "Australia": "澳洲",
    "Spain": "西班牙", "Italy": "意大利", "Denmark": "丹麦", "Norway": "挪威", "Sweden": "瑞典",
    "Finland": "芬兰", "Belgium": "比利时", "Chile": "智利", "Colombia": "哥伦比亚", "Peru": "秘鲁",
    "South Africa": "南非", "Indonesia": "印尼", "Philippines": "菲律宾", "Turkey": "土耳其",
    "Monaco": "摩纳哥", "Jersey": "泽西岛", "Puerto Rico": "", "Uruguay": "乌拉圭", "Panama": "巴拿马",
    "Kazakhstan": "哈萨克", "Macau": "澳门", "Austria": "奥地利", "Cyprus": "塞浦路斯", "Guernsey": "根西岛",
    "Isle of Man": "马恩岛", "Bahamas": "巴哈马", "Malta": "马耳他", "Thailand": "泰国", "Vietnam": "越南",
    "Malaysia": "马来西亚", "United Arab Emirates": "阿联酋", "Poland": "波兰", "Portugal": "葡萄牙",
    "Czech Republic": "捷克", "Hungary": "匈牙利", "Russia": "俄罗斯", "Ukraine": "乌克兰", "Costa Rica": "哥斯达黎加",
    "British Virgin Islands": "英属维京", "Marshall Islands": "马绍尔", "Liberia": "利比里亚", "Curacao": "库拉索",
    "New Zealand": "新西兰", "Iceland": "冰岛", "Georgia": "格鲁吉亚", "Nigeria": "尼日利亚", "Egypt": "埃及",
}
CHINA = {"China", "Hong Kong", "Macau"}
JAPAN = {"Japan"}
EUROPE = {"United Kingdom", "Netherlands", "Switzerland", "Ireland", "Luxembourg", "France", "Germany", "Spain",
          "Italy", "Denmark", "Norway", "Sweden", "Finland", "Belgium", "Greece", "Monaco", "Jersey", "Austria",
          "Cyprus", "Guernsey", "Isle of Man", "Malta", "Poland", "Portugal", "Czech Republic", "Hungary", "Iceland"}
EMERGING = {"Brazil", "Argentina", "Mexico", "South Korea", "Taiwan", "India", "Chile", "Colombia", "Peru",
            "South Africa", "Indonesia", "Philippines", "Turkey", "Uruguay", "Panama", "Kazakhstan", "Thailand",
            "Vietnam", "Malaysia", "United Arab Emirates", "Russia", "Ukraine", "Costa Rica", "Nigeria", "Egypt",
            "Georgia"}
BANK_SLUGS = {"banks", "thrifts"}
