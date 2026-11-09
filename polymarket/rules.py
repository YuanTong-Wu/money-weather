"""polymarket/rules.py: the curated rule table.

Three jobs:
  1. relevance: which Polymarket markets matter for money flows (drop sports, celebrity, weather...);
  2. mapping: market → map territories with a sign (+1 = YES is good for that territory's money);
  3. concepts: plain topic tags used by search.py to match a free-text judgment (Chinese or English).

How a market gets its nodes:
  direction (dir) of the market   × sign of the theme in the rule   × sign of the node in the theme
  - dir: +1 if YES means "the thing goes up / happens", -1 if "goes down / does not happen"
    (from the wording: reach/above/(HIGH)/↑ vs dip/below/(LOW)/↓, or "not"/"no" questions);
    for bucket events ("3 cuts", "4.25%", "$2.50-$3.00") it is the bucket relative to the
    most likely bucket (above it = +1, below = -1, the favourite itself = 0, no nodes).
  - themes: a named set of territories with signs, e.g. fed_dovish = bonds up, cash down...
  - companies named in the market ("NVIDIA", "(NVDA)", "Anthropic") add their stock node and
    its region, with the rule's company polarity (co).

Node ids follow the generated tree (web/data/tree.json). Unknown ids are resolved upward by the
kebab-case convention ('industrial-gold' → 'industrial'), then dropped if still unknown.
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------------------------
# categories (display order)
# ---------------------------------------------------------------------------------------------
CATEGORIES = {
    "rates":    {"zh": "利率", "emoji": "🏦"},
    "macro":    {"zh": "经济", "emoji": "📊"},
    "trade":    {"zh": "关税贸易", "emoji": "🚢"},
    "geo":      {"zh": "地缘", "emoji": "🌐"},
    "politics": {"zh": "美国政治", "emoji": "🏛️"},
    "ai":       {"zh": "AI", "emoji": "🤖"},
    "tech":     {"zh": "科技公司", "emoji": "💻"},
    "stocks":   {"zh": "股市", "emoji": "📈"},
    "crypto":   {"zh": "加密", "emoji": "🪙"},
    "energy":   {"zh": "能源", "emoji": "🛢️"},
    "commod":   {"zh": "商品", "emoji": "🥇"},
    "health":   {"zh": "医药", "emoji": "💊"},
    "other":    {"zh": "其他", "emoji": "🔹"},
}

# when several rules match, the category comes from the highest one here
CAT_PRIORITY = ["ai", "rates", "macro", "trade", "energy", "commod", "crypto", "geo", "politics", "health",
                "tech", "stocks", "other"]

# per-market volume floor (USD, lifetime) by category; AI milestones are thin but they are the
# owner's yardstick (market's AI dates vs theirs), so they get a much lower floor.
# emphasised areas (AI, Fed/rates, tariffs, geopolitics) get lower floors than the rest.
VOLUME_FLOOR = {"default": 25_000, "ai": 5_000, "milestone": 1_000, "unmapped": 25_000,
                "trade": 5_000, "rates": 10_000, "geo": 15_000, "macro": 15_000, "crypto": 25_000}

# ---------------------------------------------------------------------------------------------
# themes: territory sets. "+" = this theme going up / happening is good for that territory's money.
# ---------------------------------------------------------------------------------------------
_T = {
    "fed_dovish":       "bonds-long+ bonds-mid+ realestate-builders+ realestate-homes+ commod-gold+ crypto-btc+ cash-tbill- cash-fx-",
    "rates_up":         "bonds-long- bonds-mid- bonds-agg- realestate-builders- realestate-homes- cash-tbill+ cash-float+",
    "mortgage_up":      "realestate-builders- realestate-deal- realestate-reno- bonds-agg-",
    "inflation_up":     "bonds-tips+ commod-gold+ commod-broad+ bonds-long- realestate-builders- cash-float+",
    "recession":        "bonds-long+ bonds-mid+ commod-gold+ cash-tbill+ bonds-hy- industrial-machine- industrial-freight- consumer-travel- finance-banks- energy-shale- commod-copper-",
    "fed_indep_hit":    "commod-gold+ crypto-btc+ bonds-long- cash-fx-",
    "us_credit_stress": "commod-gold+ crypto-btc+ bonds-long- cash-tbill-",
    "tariff_up":        "consumer-stores- consumer-ecom- robot-cars- robot-parts- commod-ag- industrial-steel+ commod-gold+",
    "taiwan_conflict":  "intl-taiwan- ai-compute-foundry- ai-compute-chips- ai-compute-equip- intl-china- intl-korea- space-primes+ space-drones+ commod-gold+ bonds-long+",
    "china_conflict":   "intl-china- space-primes+ space-drones+ commod-gold+",
    "mideast_escalation": "commod-oil+ energy-majors+ energy-shale+ energy-service+ space-primes+ industrial-air- consumer-travel- commod-gold+",
    "ukraine_escalation": "space-primes+ space-drones+ intl-europe- energy-gas+ commod-ag+ commod-gold+",
    "oil_up":           "commod-oil+ energy-majors+ energy-shale+ energy-service+ industrial-air- consumer-travel-",
    "natgas_up":        "energy-gas+ commod-oil+",
    "gold_up":          "commod-gold+ commod-miners+ industrial-gold+",
    "silver_up":        "commod-silver+ commod-miners+",
    "copper_up":        "commod-copper+ industrial-copper+",
    "gop_win":          "energy-shale+ space-primes+ finance-banks+ crypto-btc+ energy-clean-",
    "shutdown":         "space-govit|space-deftech- security-gov-",
    "fuel_export_ban":  "energy-refine- industrial-air+ industrial-freight+",
    # AI: the owner's root is "AI arrives earlier than the market thinks"; four questions →
    # who buys more (compute, memory, power), who loses (per-seat SaaS, IT outsourcing).
    "ai_accel":         "ai-compute-chips+ ai-compute-memory+ ai-power-plants+ ai-power-equip+ ai-cloud-giants+ ai-cloud-neo+ software-itsvc- software-saas-",
    "ai_release":       "ai-compute-chips+ ai-compute-memory+ ai-cloud-neo+",
    "ai_capital":       "ai-compute-chips+ ai-compute-memory+ ai-cloud-neo+ ai-power-plants+",
    "ai_bust":          "ai-compute-chips- ai-compute-memory- ai-cloud-neo- ai-power-plants- ai-power-build- bonds-long+",
    "dc_moratorium":    "ai-power-dc- ai-power-build- ai-cloud-neo- ai-power-plants-",
    "ai_regulation":    "ai-compute-chips- ai-cloud-giants- ai-cloud-neo-",
    "gpu_price_up":     "ai-cloud-neo+ ai-compute-chips+",
    "ai_capex":         "ai-compute-chips+ ai-compute-memory+ ai-compute-network+ ai-power-equip+ ai-power-build+",
    "ai_usage":         "ai-compute-chips+ ai-cloud-neo+ ai-cloud-giants+",
    "chips_china_open": "ai-compute-chips+ ai-compute-equip+",
    "china_ai_up":      "intl-cn-net+",
    "china_growth":     "intl-china+ commod-copper+ industrial-copper+",
    "europe_growth":    "intl-europe+",
    "ecb_dovish":       "intl-eu-etf+ cash-fx-",
    "boj_hawkish":      "cash-fx+ intl-japan-",
    "crypto_btc_up":    "crypto-btc+ crypto-treasury+ crypto-miners+ crypto-exch+",
    "crypto_alt_up":    "crypto-alt+ crypto-exch+ crypto-treasury+",
    "stablecoin_up":    "crypto-exch+ finance-fintech+",
    "crypto_treasury_stress": "crypto-treasury- crypto-btc-",
    "stocks_up":        "us+ cash-tbill-",
    "market_crash":     "us- bonds-long+ cash-tbill+ commod-gold+",
    "nuclear_up":       "ai-power-nuclear+ commod-uranium+",
    "robot_up":         "robot-bots|robot-smart+",
    "robotaxi_up":      "robot-drive+",
    "space_up":         "space-newspace|space-rocket+",
    "ipo_window":       "finance-wallst+",
    "crypto_ipo":       "crypto-exch+",
    "housing_up":       "realestate-builders+ realestate-deal+ realestate-reno+",
    "obesity_up":       "health-obesity+",
    "pharma_pressure":  "health-pharma- health-biotech-",
    "defense_up":       "space-primes+ space-drones+",
    "airline_stress":   "industrial-air-",
    "bank_stress":      "finance-banks-regional- finance-banks-big- bonds-long+",
    "quantum_up":       "software-quantum+",
    "korea_up":         "intl-korea+",
    "japan_up":         "intl-japan+",
    "china_stocks_up":  "intl-cn-etf|intl-china+",
    "india_up":         "intl-india+",
}
# a token may list alternatives "a|b": the first id that exists in the tree is used
THEMES: dict[str, list[tuple[str, int]]] = {
    k: [(tok[:-1], 1 if tok[-1] == "+" else -1) for tok in v.split()] for k, v in _T.items()
}

THEME_ZH = {
    "fed_dovish": "钱变松", "rates_up": "利率走高", "inflation_up": "通胀升温", "recession": "经济衰退",
    "tariff_up": "关税加码", "taiwan_conflict": "台海冲突", "mideast_escalation": "中东升级",
    "ukraine_escalation": "俄乌升级", "oil_up": "油价上涨", "ai_accel": "AI 提速", "ai_release": "新模型发布",
    "ai_capital": "AI 融资热", "ai_bust": "AI 泡沫破裂", "dc_moratorium": "机房禁令", "crypto_btc_up": "比特币上涨",
}

# ---------------------------------------------------------------------------------------------
# companies → tickers (only emitted when the ticker exists in the tree)
# ---------------------------------------------------------------------------------------------
COMPANIES = {
    r"nvidia": ["NVDA"], r"microsoft|azure": ["MSFT"], r"\bapple\b": ["AAPL"],
    r"alphabet|google|gemini|deepmind|waymo": ["GOOGL"], r"amazon|\baws\b": ["AMZN"],
    r"\bmeta\b|facebook|instagram|\bmuse\b|llama": ["META"], r"tesla|optimus|cybercab": ["TSLA"],
    r"broadcom": ["AVGO"], r"\btsmc\b|taiwan semiconductor": ["TSM"], r"\bamd\b": ["AMD"], r"\bintel\b": ["INTC"],
    r"micron": ["MU"], r"oracle": ["ORCL"], r"palantir": ["PLTR"], r"netflix": ["NFLX"], r"coinbase": ["COIN"],
    r"microstrategy|\bstrategy\b \(mstr\)|\bmstr\b|\bstrc\b": ["MSTR"], r"robinhood": ["HOOD"],
    r"rocket lab": ["RKLB"], r"airbnb": ["ABNB"], r"spacex|starship": ["SPCX"], r"coreweave": ["CRWV"],
    r"nuscale": ["SMR"], r"\boklo\b": ["OKLO"], r"berkshire": ["BRK-B"], r"jpmorgan|jp morgan": ["JPM"],
    r"eli lilly|\blilly\b": ["LLY"], r"novo nordisk": ["NVO"], r"\bvisa\b": ["V"], r"mastercard": ["MA"],
    r"boeing": ["BA"], r"disney": ["DIS"], r"walmart": ["WMT"], r"costco": ["COST"], r"\buber\b": ["UBER"],
    r"\bcircle\b": ["CRCL"], r"opendoor": ["OPEN"], r"gamestop": ["GME"], r"\bebay\b": ["EBAY"],
    r"paypal": ["PYPL"], r"pinterest": ["PINS"], r"\bsnap\b": ["SNAP"], r"reddit": ["RDDT"],
    r"salesforce": ["CRM"], r"adobe": ["ADBE"], r"servicenow": ["NOW"], r"\bibm\b": ["IBM"], r"cisco": ["CSCO"],
    r"\bdell\b": ["DELL"], r"supermicro|super micro": ["SMCI"], r"\barm holdings\b|\barm\b \(arm\)": ["ARM"],
    r"\basml\b": ["ASML"], r"qualcomm": ["QCOM"], r"marvell": ["MRVL"], r"alibaba|\bqwen\b": ["BABA"],
    r"baidu|\bernie\b": ["BIDU"], r"\bpdd\b|pinduoduo|temu": ["PDD"], r"\bnio\b": ["NIO"], r"xpeng": ["XPEV"],
    r"li auto": ["LI"], r"rivian": ["RIVN"], r"lucid": ["LCID"], r"\bford\b": ["F"], r"general motors": ["GM"],
    r"toyota": ["TM"], r"\bsony\b": ["SONY"], r"lockheed": ["LMT"], r"northrop": ["NOC"], r"raytheon|\brtx\b": ["RTX"],
    r"unitedhealth": ["UNH"], r"pfizer": ["PFE"], r"moderna": ["MRNA"], r"chevron": ["CVX"],
    r"exxon": ["XOM"], r"occidental": ["OXY"], r"constellation energy": ["CEG"], r"vistra": ["VST"],
    r"ge vernova": ["GEV"], r"nebius": ["NBIS"], r"\biren\b": ["IREN"], r"bitmine": ["BMNR"], r"spotify": ["SPOT"],
    r"shopify": ["SHOP"], r"duolingo": ["DUOL"], r"gitlab": ["GTLB"], r"viking therapeutics": ["VKTX"],
    r"\bbp\b": ["BP"], r"\bshell\b": ["SHEL"], r"intuitive surgical": ["ISRG"], r"snowflake": ["SNOW"],
    r"crowdstrike": ["CRWD"], r"palo alto": ["PANW"], r"applovin": ["APP"], r"strategy inc": ["MSTR"],
    r"sofi": ["SOFI"], r"\bhims\b": ["HIMS"], r"unity software": ["U"], r"roblox": ["RBLX"], r"\bionq\b": ["IONQ"],
    r"rigetti": ["RGTI"], r"d-wave": ["QBTS"], r"\bjoby\b": ["JOBY"], r"archer aviation": ["ACHR"],
    r"ast spacemobile": ["ASTS"], r"lumen": ["LUMN"], r"warner bros": ["WBD"], r"paramount": ["PSKY"],
    r"comcast": ["CMCSA"], r"at&t": ["T"], r"verizon": ["VZ"], r"t-mobile": ["TMUS"], r"\bkraken\b": [],
    r"goldman sachs": ["GS"], r"morgan stanley": ["MS"], r"bank of america": ["BAC"], r"wells fargo": ["WFC"],
    r"citigroup|\bciti\b": ["C"], r"blackrock": ["BLK"], r"blackstone": ["BX"], r"mercadolibre": ["MELI"],
    r"\bsea limited\b": ["SE"], r"jd\.com": ["JD"], r"tencent": [], r"bytedance|tiktok": [],
}
# AI labs that are private: which listed stocks carry their fate
LAB_PROXIES = {
    "openai": (r"openai|chatgpt|\bgpt\b|gpt[- ]?\d|gpt (?:astra|terra|sol|luna)|sora|sam altman", ["MSFT", "ORCL"]),
    "anthropic": (r"anthropic|claude|\bfable\b|\bopus\b|\bsonnet\b|dario amodei", ["AMZN", "GOOGL"]),
    "google": (r"google|gemini|deepmind|alphabet", ["GOOGL"]),
    "meta": (r"\bmeta\b|\bmuse\b|llama", ["META"]),
    "xai": (r"\bxai\b|\bgrok\b", []),
}
CHINESE_AI = r"deepseek|\bkimi\b|moonshot|\bqwen\b|alibaba|z\.ai|\bglm\b|zhipu|baidu|\bernie\b|bytedance|doubao|minimax|tencent|hunyuan|chinese (ai|company|lab)"

# ---------------------------------------------------------------------------------------------
# exclusions (checked first)
# ---------------------------------------------------------------------------------------------
EXCLUDE_TAGS = {
    "sports", "soccer", "football", "nfl", "nba", "mlb", "nhl", "tennis", "esports", "games", "ufc", "f1",
    "formula1", "golf", "cricket", "boxing", "mma", "basketball", "baseball", "hockey", "cfb", "ncaaf",
    "ncaa-football", "ncaab", "epl", "la-liga", "ucl", "uel", "serie-a", "serie-b", "ligue-1", "bundesliga",
    "premier-league", "efl-championship", "counter-strike-2", "league-of-legends", "dota-2", "valorant",
    "pop-culture", "celebrities", "movies", "music", "awards", "oscars", "oscars-2027", "grammys", "emmys",
    "tv", "television", "youtube", "mrbeast", "weather", "daily-temperature", "highest-temperature",
    "hurricanes", "earthquakes", "mentions", "tweet-markets", "elon-tweets", "chess", "olympics",
    "world-cup", "fifa-world-cup", "eurovision", "religion", "pope", "royals", "dating", "reality-tv",
    "season-stats", "props", "cfb-win-totals",
}
EXCLUDE_PAT = re.compile(
    r"up or down|steps down|step down|meet next in|withdraw from nato|(second|third)[- ]best|#[23] ai|\b(2nd|3rd)\b|"
    r"style control|webdev|image.to.video|text.to.(image|video)|\bvideo ai\b|image ai|math ai (lab|model)|agent lab|"
    r"best ai agent|what kind of product|consumer hardware|earbuds|headphones|social network|house seat|senate seat|congressional district|\b[a-z]{2}-\d{2}\b|"
    r"\band will (the|there)\b|launch a token|launch (its|a) (own )?coin|\bsay\b|\bmention|tweets?\b|# of tweets|posts? on x|truth social post|temperature|"
    r"\bweather\b|hurricane|\bdivorce\b|\bbaby\b|\bpregnan|\bdating\b|\bwedding\b|\bspy be accused|"
    r"public ticker be|lead bank in|outage|go down on|rename itself|\bpurge\b|sentenced|\bjail\b|"
    r"ground beef|dozen eggs|hotdog|\bfdv\b|airdrop|token launch|memecoin|pump\.fun|\bansem\b|cashcat|"
    r"hyperliquid|\bhype\b|lighter|zcash|monero|plasma|ethena|\baster\b|uniswap|dogecoin|\bbnb\b|"
    r"\bpepe\b|\bbonk\b|\bshib\b|how many dissent|dissent at|mayor|magistrate|governor election|"
    r"primary|nominee|nomination|popular vote|approval rating|time person of the year|"
    r"satoshi|\bselfie\b|seen together|\bmeet with\b|meets with|visit (to|china|the us)|"
    r"\bcabinet\b|press secretary|\bimpeach|resign|out as (president|premier|prime minister)|"
    r"\bcoup\b|citizenship|released from|public appearance|confirmed outside|"
    r"which companies announce bankruptcy|richest person|best month|how many coins|"
    r"\bflip\b.*\bsol\b|altcoin market cap|vs\. gold vs\.|outperform gold",
    re.I)
# a few names that look like matches but are not ("gold medal", "golden state" ...)
FALSE_FRIENDS = re.compile(r"gold medal|golden|goldman|olympic gold|heat ?map|gold card", re.I)

# ---------------------------------------------------------------------------------------------
# direction words
# ---------------------------------------------------------------------------------------------
DOWN_Q = re.compile(
    r"\(low\)|↓|\bdip(s)? (to|below)\b|\bdips?\b|\bbelow\b|\bunder\b|less than|\bfall(s)? (to|below)\b|"
    r"\bdrop(s)? (to|below)\b|\bfall\b|\bdecline|\blowest\b|\bcrash\b|\bplunge|\bsink", re.I)
UP_Q = re.compile(
    r"\(high\)|↑|\breach(es)?\b|\babove\b|at least|more than|\bexceed|\bhigher\b|\bhighest\b|"
    r"all.time high|\bath\b|\bhits?\b|\bover\b|\brise(s)? to\b|\bclimb|\bsurpass|\bgreater than|\+\s*$", re.I)
NEG_Q = re.compile(r"\bnot\b|\bno ipo\b|\bwon'?t\b|\bnever\b|\bno (deal|ceasefire|agreement)\b|\bfail(s)? to\b|"
                   r"\b(there )?be no\b|\bno (new|next|further|more)\b", re.I)
EVENT_DOWN = re.compile(r"how low|\bdip\b|\blow(est)?\b \(?", re.I)
EVENT_UP = re.compile(r"how high|all.time high", re.I)

# ---------------------------------------------------------------------------------------------
# rules: ordered; every matching rule contributes. Fields:
#   pat     regex over "question || event title || group title" (lowercased)
#   cat     category of the market (first matching rule wins)
#   themes  [(theme, sign)]: sign = what YES (dir=+1) means for the theme
#   dir     "event" (YES = it happens; NEG words flip) | "level" (up/down words) | "bucket"
#           (ordinal vs favourite bucket; falls back to level when not a bucket event) | "none"
#   higher  for buckets: what a higher number means for the theme (+1 / -1)
#   co      company polarity: +1 named company benefits if YES, -1 suffers, 0 ignore
#   labs    True → AI lab names add their listed proxies with co polarity
#   conf    "hi" (trusted) | "lo" (a Claude mapping may replace it)
#   tags    concept tags (used for search and display)
#   milestone  AI-milestone market (gets the lowest volume floor; feeds aiWatch)
#   not     regex that must NOT match
# ---------------------------------------------------------------------------------------------
R = []


def rule(name, cat, pat, themes=(), dir="event", higher=1, co=0, labs=False, conf="hi", tags=(),
         milestone=False, nott=None, need_tag=None, solo=False, need=None):
    R.append({"name": name, "cat": cat, "pat": re.compile(pat, re.I), "themes": list(themes), "dir": dir,
              "higher": higher, "co": co, "labs": labs, "conf": conf, "tags": list(tags),
              "milestone": milestone, "not": re.compile(nott, re.I) if nott else None, "need_tag": need_tag,
              "solo": solo, "need": re.compile(need, re.I) if need else None})


# --- AI milestones (the owner's yardstick) -----------------------------------------------------
rule("agi", "ai", r"\bagi\b|artificial general intelligence|superintelligen|\basi\b(?! ?\()|safe superintelligence",
     [("ai_accel", 1)], labs=True, co=1, tags=["ai", "agi", "milestone"], milestone=True, nott=r"\bssi public model")
rule("rsi", "ai", r"recursive self.?improv|self.?improving ai|automated ai research|ai research(er)? (automat|intern)|"
     r"ai (does|doing|conducts?) (its own )?(ai )?research|singularity|intelligence explosion",
     [("ai_accel", 1)], labs=True, co=1, tags=["ai", "rsi", "agi", "milestone"], milestone=True)
rule("ai_math", "ai", r"millennium prize|riemann hypothesis|navier.?stokes|imo gold|math(ematical)? olympiad|"
     r"frontiermath|erd(o|ő)s problem|unsolved (math|problem)|fields medal",
     [("ai_accel", 1)], labs=True, co=1, tags=["ai", "ai-benchmark", "math", "milestone"], milestone=True,
     nott=r"which millennium prize problem")
rule("ai_bench", "ai", r"humanity.?s last exam|\bhle\b|arena score|chatbot arena|text arena|arena debut|"
     r"arena rank|swe.?bench|arc.?agi|benchmark|\bscore on\b",
     [("ai_release", 1)], labs=True, co=1, tags=["ai", "ai-benchmark", "milestone"], milestone=True, conf="hi")
rule("ai_agent_long", "ai", r"agent.{0,40}(hours|days|week|month).{0,20}(autonom|without)|autonomous agent|"
     r"personal agent", [("ai_usage", 1)], labs=True, co=1, tags=["ai", "agent", "milestone"],
     milestone=True, conf="lo")
rule("ai_jobs", "ai", r"\bai\b.{0,40}(jobs|unemployment|layoffs?|replac|white.collar)|"
     r"(jobs|layoffs?|white.collar).{0,40}\bai\b", [("ai_accel", 1)], tags=["ai", "jobs", "milestone"],
     milestone=True, conf="lo")
# --- AI releases & rankings --------------------------------------------------------------------
rule("ai_release", "ai", r"(released?|launch(e[sd])?|ship(s|ped)?|announce[sd]?|debut)\b.{0,60}\b(model|gpt|claude|gemini|grok|"
     r"llama|fable|opus|sonnet|muse|deepseek|kimi|qwen|glm|ssi)|\b(gpt[- ]?\d|gpt (astra|terra|sol|luna)|claude \d|"
     r"gemini (\d|pro|flash|ultra|carbon|argon)|grok \d|fable|claude opus|muse spark|kimi k\d|deepseek|qwen|z\.ai glm)\b.{0,40}"
     r"(released?|launch|by\b|on\.\.\.|on\b)",
     [("ai_release", 1)], labs=True, co=1, tags=["ai", "ai-release", "milestone"], milestone=True,
     nott=r"token price|valuation|\bipo\b|outage|access to")
rule("ai_rank", "ai", r"best ai model|top \S* ?ai model|#1 ai model|best chinese ai|ai lab by openrouter|"
     r"have a #1|ai company end of|top ai lab|first hit \d+ on chatbot arena|(second|third)?.?best .{0,30}"
     r"(ai|model|lab)\b|best .{0,30}ai at the end|ai lab (at|end)|top \d+ ai model",
     [], labs=True, co=1, tags=["ai", "ai-ranking"], conf="hi", solo=True)
rule("ai_china", "ai", CHINESE_AI, [("china_ai_up", 1)], tags=["ai", "china", "chinese-ai"], conf="lo",
     nott=r"removes? public access|military companies")
# --- AI money & infrastructure -----------------------------------------------------------------
rule("ai_bust", "ai", r"ai bubble|ai (industry )?downturn|(openai|anthropic|xai|coreweave|nebius|lambda|mistral|"
     r"perplexity).{0,40}bankrupt|bankrupt.{0,40}(openai|anthropic|coreweave)",
     [("ai_bust", 1)], labs=True, co=-1, tags=["ai", "ai-bubble"], milestone=True)
rule("ai_capital", "ai", r"(openai|anthropic|\bxai\b|mistral|perplexity|databricks|\bssi\b|cursor|anysphere|"
     r"lambda|cerebras|scale ai|moonshot|kimi|deepseek|thinking machines).{0,60}(ipo|valuation|market cap|raise|"
     r"funding|\$\d)|(\bipo\b|valuation|market cap).{0,60}(openai|anthropic|\bxai\b|perplexity|databricks|cerebras|"
     r"deepseek|moonshot|kimi)|(openai|anthropic).{0,30}(vs|or).{0,30}(higher valuation|ipo first)",
     [("ai_capital", 1), ("ipo_window", 1)], dir="level", labs=True, co=1, tags=["ai", "ai-capital", "ipo", "valuation"],
     nott=r"lead bank|ticker|flip btc")
rule("dc_moratorium", "ai", r"data ?cent(er|re)s? (moratorium|ban)|moratorium on (new )?data|ban (on )?(new )?data ?cent",
     [("dc_moratorium", 1)], tags=["ai", "datacenter", "power", "regulation"], milestone=False)
rule("ai_regulation", "ai", r"\bai\b.{0,30}(safety )?(bill|act\b|regulation|law\b|executive order|moratorium|pause)|"
     r"regulate ai|pause (ai|frontier)|pace the ai frontier|removes? public access to .{0,40}(ai|model)|"
     r"\bsb ?(53|1047)\b|eu ai act|bans? .{0,40}(ai|model)\b",
     [("ai_regulation", 1)], tags=["ai", "ai-regulation"], conf="lo", nott=r"data ?cent")
rule("ai_preempt", "ai", r"preempt.{0,30}(state )?ai|ai preemption", [("ai_regulation", -1)], tags=["ai", "ai-regulation"])
rule("gpu_price", "ai", r"gpu rental|\bh100\b|\bh200\b|\bb200\b|\ba100\b|rtx 5090|ornn", [("gpu_price_up", 1)],
     dir="bucket", higher=1, tags=["ai", "compute", "gpu", "nvidia"])
rule("ai_capex", "ai", r"\bcapex\b|capital expenditures?", [("ai_capex", 1)], dir="level", co=0,
     tags=["ai", "capex", "compute", "bigtech"])
rule("cloud_growth", "ai", r"azure|\baws\b revenue|google cloud|cloud revenue", [("ai_usage", 1)], dir="level", co=1,
     tags=["ai", "cloud", "bigtech", "earnings"])
rule("ai_usage", "ai", r"token usage|openrouter|chatgpt.{0,20}(users|weekly)|weekly active", [("ai_usage", 1)],
     dir="level", tags=["ai", "ai-usage"], conf="lo", nott=r"lab by openrouter")
rule("token_price", "ai", r"token price", [], tags=["ai", "ai-price"], conf="lo")
rule("export_ctrl", "ai", r"export control|export ban|chips? (to|for) china|sell .{0,30}chips?.{0,20}china|\bh20\b|"
     r"\bh200\b.{0,30}china", [("chips_china_open", -1)], dir="export", tags=["ai", "china", "chips", "trade"],
     conf="lo", nott=r"military companies|diesel|gasoline|crude|\boil\b|\bfuel|\blng\b|natural gas")
rule("fuel_export_ban", "energy", r"(diesel|gasoline|fuel|crude|oil) export ban|export ban.{0,30}(diesel|gasoline|fuel)|"
     r"ban.{0,20}(diesel|gasoline|fuel|crude) exports", [("fuel_export_ban", 1)], tags=["oil", "energy", "trade"],
     conf="lo")
rule("cmc_list", "geo", r"chinese military companies list|entity list", [("china_growth", 1)], dir="listrm", co=1,
     tags=["china", "trade", "sanctions"], conf="lo")
rule("ai_misc", "ai", r"\bopenai\b|anthropic|\bclaude\b|chatgpt|\bgpt\b|gemini|deepmind|\bxai\b|\bgrok\b|\bllm\b|"
     r"artificial intelligence|\bai model|\bai lab", [], labs=True, co=1, tags=["ai"], conf="lo",
     nott=r"lab leak|spy|ticker|lead bank")
# --- robots, space, quantum --------------------------------------------------------------------
rule("humanoid", "tech", r"optimus|humanoid|figure ai|robot", [("robot_up", 1)], co=1, tags=["robot", "tesla"],
     nott=r"robotaxi|robinhood")
rule("robotaxi", "tech", r"robotaxi|waymo|cybercab|self.driving|driverless|autonomous (car|vehicle|driving)",
     [("robotaxi_up", 1)], dir="level", co=1, tags=["robot", "robotaxi", "autonomy"])
rule("space", "tech", r"spacex|starship|\bspcx\b", [("space_up", 1)], dir="level", co=1, tags=["space", "spacex"],
     nott=r"largest company|market cap")
rule("quantum", "tech", r"quantum (computer|computing|supremacy|advantage)", [("quantum_up", 1)], tags=["quantum"], conf="lo")
# --- rates -------------------------------------------------------------------------------------
rule("fed_cuts_count", "rates", r"fed rate cuts? happen|how many fed rate cuts|no fed rate cuts", [("fed_dovish", 1)],
     dir="bucket", higher=1, tags=["fed", "rates", "rate-cut"])
rule("fed_rate_level", "rates", r"federal funds rate be|fed(eral)? (funds )?rate (be|hit|at the end)|what will the fed rate|"
     r"what will fed rate", [("fed_dovish", -1)], dir="bucket", higher=1, tags=["fed", "rates"])
rule("fed_decision", "rates", r"\bfed\b.{0,40}(increase|decrease|hike|cut|no change).{0,60}meeting|fed decision|"
     r"fed decisions|\bfomc\b|fed rate (cut|hike)|fed (cuts?|hikes?) rates|emergency rate cut|"
     r"another fed rate hike|fed rate cut by|no change or hike|federal reserve",
     [("fed_dovish", 1)], dir="cb", tags=["fed", "rates"], nott=r"how many fed rate cuts|cuts? happen")
rule("fed_emergency", "rates", r"emergency rate cut", [("recession", 1)], tags=["fed", "recession"])
rule("fed_indep", "rates", r"powell.{0,40}(out|fire|fired|charged|removed|remove|indict)|fire powell|"
     r"(lisa )?cook.{0,30}(out|fired|removed)|fed (independence|chair).{0,40}(fired|removed)",
     [("fed_indep_hit", 1)], tags=["fed", "powell", "fed-independence"], conf="lo")
rule("yields", "rates", r"treasury yield|\d+-year (treasury|yield)|10y yield|bond yield|\btnx\b",
     [("rates_up", 1)], dir="level", tags=["rates", "yields", "bonds"], nott=r"japan|jgb")
rule("mortgage", "rates", r"mortgage rate", [("mortgage_up", 1)], dir="level", tags=["rates", "mortgage", "housing"])
rule("jgb", "rates", r"japan 10y|jgb|japanese government bond", [("boj_hawkish", 1)], dir="level",
     tags=["rates", "japan"], conf="lo")
rule("ecb", "rates", r"\becb\b|european central bank", [("ecb_dovish", 1)], dir="cb", tags=["rates", "europe"], conf="lo")
rule("boj", "rates", r"bank of japan|\bboj\b", [("boj_hawkish", -1)], dir="cb", tags=["rates", "japan"], conf="lo")
rule("boe", "rates", r"bank of england|\bboe\b", [("europe_growth", 1)], dir="cb", tags=["rates", "europe", "uk"], conf="lo")
rule("cb_other", "rates", r"bank of canada|reserve bank of australia|\brba\b|bank of mexico|banxico|bank of brazil|"
     r"reserve bank of india|people'?s bank of china|\bpboc\b|swiss national bank", [], dir="cb",
     tags=["rates", "central-bank"], conf="lo")
# --- macro -------------------------------------------------------------------------------------
rule("recession", "macro", r"recession|negative gdp|economic state", [("recession", 1)], tags=["recession", "macro"],
     nott=r"\b(uk|germany|japan|canada|eurozone|china)\b")
rule("unemployment", "macro", r"unemployment", [("recession", 1)], dir="bucket", higher=1,
     tags=["jobs", "unemployment", "macro"], nott=r"\b(uk|germany|japan|canada|eurozone|china|india|brazil)\b")
rule("payrolls", "macro", r"nonfarm|payrolls|jobs report|jobs added|jobless claims", [("recession", -1)], dir="bucket",
     higher=1, tags=["jobs", "macro"])
rule("layoffs", "macro", r"layoffs?", [("recession", 1)], dir="level", tags=["jobs", "layoffs"], conf="lo")
rule("us_gdp", "macro", r"(us|u\.s\.|united states|american)\b.{0,20}gdp|gdp growth in (q\d|20\d\d)|^gdp growth",
     [("recession", -1)], dir="bucket", higher=1, tags=["gdp", "macro"],
     nott=r"china|\buk\b|u\.k\.|euro|japan|germany|mexico|canada|brazil|india|world|global|negative|korea|france")
rule("econ_soft", "macro", r"soft landing", [("recession", -1)], tags=["macro", "recession"], solo=True)
rule("econ_hot", "macro", r"overheating", [("inflation_up", 1)], tags=["macro", "inflation"], solo=True)
rule("econ_stag", "macro", r"stagflation", [("inflation_up", 1), ("recession", 1)], tags=["macro", "inflation", "recession"],
     solo=True)
rule("china_gdp", "macro", r"china.{0,30}gdp|gdp.{0,30}china", [("china_growth", 1)], dir="bucket", higher=1,
     tags=["china", "gdp"])
rule("europe_gdp", "macro", r"(eurozone|germany|euro area|uk|u\.k\.).{0,30}gdp", [("europe_growth", 1)], dir="bucket",
     higher=1, tags=["europe", "gdp"], conf="lo")
rule("world_gdp", "macro", r"world gdp|global gdp", [("china_growth", 1)], dir="bucket", higher=1, tags=["gdp", "global"],
     conf="lo")
rule("us_inflation", "macro", r"inflation|\bcpi\b|\bpce\b|\bppi\b", [("inflation_up", 1)], dir="bucket", higher=1,
     tags=["inflation", "macro"],
     nott=r"\b(uk|u\.k\.|britain|germany|japan|canada|eurozone|euro area|china|india|brazil|mexico|argentina|"
          r"south africa|south korea|turkey|australia|russia)\b")
rule("gas_price", "energy", r"\bgas (price|hit|prices)|gasoline|price of gas", [("oil_up", 1)], dir="level",
     tags=["oil", "gasoline", "inflation"])
rule("housing", "macro", r"home prices?|housing starts|existing home sales|case.shiller", [("housing_up", 1)],
     dir="level", tags=["housing"])
rule("bank_fail", "macro", r"banks? (will )?fail|bank failure|bank run", [("bank_stress", 1)], tags=["banks", "credit"])
rule("airline_bk", "macro", r"airlines?.{0,40}bankrupt", [("airline_stress", 1)], tags=["airlines"])
rule("debt", "politics", r"debt ceiling|default on (its|us|u\.s\.) debt|u\.?s\.? default|credit rating downgrade",
     [("us_credit_stress", 1)], tags=["debt", "politics"], conf="lo")
# --- trade -------------------------------------------------------------------------------------
rule("tariff_rate", "trade", r"tariff rate on|average tariff|effective tariff rate", [("tariff_up", 1)], dir="bucket",
     higher=1, tags=["tariff", "trade"])
rule("tariff", "trade", r"tariff|trade war|section 232|section 301|de minimis", [("tariff_up", 1)], dir="tariff",
     tags=["tariff", "trade"], nott=r"tariff rate on")
rule("trade_deal", "trade", r"(trade (deal|agreement|truce)|economic deal).{0,60}(china|\beu\b|europe|japan|canada|"
     r"mexico|india|korea|\buk\b|united kingdom|taiwan|vietnam)|(china|\beu\b|europe|japan|canada|mexico|india|"
     r"korea|taiwan|vietnam).{0,60}trade (deal|agreement|truce)", [("tariff_up", -1)], tags=["trade", "deal"],
     conf="lo")
# smaller partners: only that country's own territory moves (no broad tariff theme)
rule("trade_deal_minor", "trade", r"(trade (deal|agreement|truce)|economic deal).{0,60}(argentina|brazil|indonesia|"
     r"australia|switzerland|south africa|pakistan|israel|philippines|thailand|malaysia|singapore|chile|peru|"
     r"colombia|turkey|poland|saudi)", [], tags=["trade", "deal"], conf="lo",
     nott=r"china|\beu\b|europe|japan|canada|mexico|india|korea|\buk\b|united kingdom|taiwan|vietnam")
# --- geopolitics -------------------------------------------------------------------------------
rule("taiwan", "geo", r"(invade|invasion|blockade|military clash|attack|war\b|missile|strike).{0,40}taiwan|"
     r"taiwan.{0,40}(invade|invasion|blockade|clash)|china x taiwan", [("taiwan_conflict", 1)],
     tags=["china", "taiwan", "geopolitics", "war"])
rule("china_clash", "geo", r"china x (japan|philippines|india)|(us|u\.s\.) x china military|china.{0,20}military clash|"
     r"south china sea", [("china_conflict", 1)], tags=["china", "geopolitics", "war"], nott=r"taiwan")
rule("mideast", "geo", r"\biran|israel|hormuz|houthi|bab el.mandeb|red sea|hezbollah|\bgaza\b|yemen|saudi|kharg|"
     r"\buae\b|qatar|aden|tanker|shipping (successfully )?targeted|ships transit",
     [("mideast_escalation", 1)], dir="geo", tags=["mideast", "oil", "geopolitics"],
     need=r"war\b|strike|attack|military|invade|invasion|closed|\bclose\b|closure|blockade|hormuz|bab el|shipping|tanker|"
          r"\boil\b|pipeline|missile|drone|ceasefire|truce|peace deal|nuclear (deal|agreement|weapon|bomb|test|program|"
          r"facilit|site)|enrich|bomb|conflict|clash|traffic|ships|seize|fees|troops|enter|sever",
     nott=r"gay|marriage|ambassador|genocide|out as|speaker|minister|recogni[sz]e|annex|election|court|guilty|"
          r"visit|award|saudi.{0,20}nuclear deal|world cup|olympic")
rule("ukraine", "geo", r"russia|ukrain|putin|zelensk|\bnato\b|kyiv|crimea|donbas|pokrovsk|zaporizh|kharkiv|odesa",
     [("ukraine_escalation", 1)], dir="geo", tags=["russia", "ukraine", "geopolitics"],
     need=r"ceasefire|peace|deal|agreement|referendum|nato|troops|nuclear|security guarantee|sanction|invade|invasion|"
          r"attack|war\b|meet|summit|talks|clash|mobiliz|martial law|\bg7\b|rejoin|"
          r"(capture|enter|take).{0,30}(kyiv|kharkiv|odesa|zaporizhzhia city|dnipro|kramatorsk|sloviansk)",
     nott=r"bank of russia|russian diesel|russian oil|out as|election|re-enter|airport|royal caf|world cup|olympic|"
          r"capture (?!.{0,30}(kyiv|kharkiv|odesa|zaporizhzhia city|dnipro|kramatorsk|sloviansk))")
rule("sanction_relief", "energy", r"(sanction relief|lift(s|ed)? sanctions|sanctions? (lifted|eased)).{0,40}"
     r"(iran|venezuel|russia|oil)|(iran|venezuel|russia).{0,40}(oil )?sanction relief|imports? russian (diesel|oil)|"
     r"cuba oil sanction", [("oil_up", -1)], tags=["oil", "sanctions"], conf="lo")
rule("north_korea", "geo", r"north korea|kim jong", [("defense_up", 1)], tags=["geopolitics", "korea"], conf="lo")
# --- US politics -------------------------------------------------------------------------------
rule("midterms", "politics", r"control the (house|senate)|balance of power|party will win the (house|senate)|"
     r"(senate|house) majority|win the (house|senate)", [("gop_win", 1)], dir="party",
     tags=["midterms", "politics", "election"], conf="lo",
     nott=r"pending|margin|seats|by how much|\bmov\b|majority leader|speaker")
rule("shutdown", "politics", r"government shutdown|shutdown", [("shutdown", 1)], dir="shutdown",
     tags=["shutdown", "politics"])
# --- stocks & companies ------------------------------------------------------------------------
rule("index", "stocks", r"s&p 500|\bspx\b|\(spy\)|\bspy\b|nasdaq|dow jones|\bqqq\b", [("stocks_up", 1)], dir="level",
     tags=["stocks", "sp500"], nott=r"added to (the )?s&p|join(s|ed)? (the )?s&p|inclusion|listed on (the )?nasdaq|"
                                     r"compan(y|ies)|buys? bitcoin")
rule("crash", "stocks", r"circuit breaker|market crash|stock market crash|bear market", [("market_crash", 1)],
     tags=["stocks", "crash"])
rule("kospi", "stocks", r"kospi|\bewy\b|south korea etf", [("korea_up", 1)], dir="level", tags=["stocks", "korea"])
rule("nikkei", "stocks", r"nikkei|topix|\bewj\b", [("japan_up", 1)], dir="level", tags=["stocks", "japan"])
rule("hangseng", "stocks", r"hang seng|csi 300|shanghai composite|\bfxi\b", [("china_stocks_up", 1)], dir="level",
     tags=["stocks", "china"])
rule("eu_index", "stocks", r"ftse|\bdax\b|stoxx|cac 40", [("europe_growth", 1)], dir="level", tags=["stocks", "europe"])
rule("india_index", "stocks", r"sensex|nifty", [("india_up", 1)], dir="level", tags=["stocks", "india"])
rule("largest_co", "tech", r"largest company|largest .{0,10}company in the world|market cap(italization)?",
     [], dir="bucket", higher=1, co=1, tags=["bigtech", "market-cap"],
     nott=r"\bipo\b|private company|openai|anthropic|spacex' market cap")
rule("stock_price", "stocks", r"what will .{2,60}\([a-z.\-]{1,6}\) hit|will .{2,60}\([a-z.\-]{1,6}\) (hit|reach|close|dip|"
     r"finish|end)|\([a-z.\-]{1,6}\) (closes|close|finish)", [], dir="level", co=1, tags=["stocks"])
rule("earnings", "tech", r"beat (quarterly )?earnings|earnings beat|quarterly revenue|\beps\b", [], co=1,
     tags=["earnings", "bigtech"])
rule("acquired", "tech", r"\bbe acquired\b|\bacquired before\b|\bacquire\b|\bacquisition of\b|merger",
     [], co=1, tags=["m&a"], conf="lo", nott=r"acquired by (openai|anthropic)")
rule("ipo_generic", "tech", r"\bipo\b|initial public offering|go public", [("ipo_window", 1)], dir="ipo",
     labs=True, co=1, tags=["ipo"], conf="lo", nott=r"lead bank|ticker|raise in its ipo")
rule("bankrupt_co", "tech", r"bankrupt", [], co=-1, tags=["bankruptcy"], conf="lo",
     nott=r"airline|openai|anthropic|coreweave")
rule("nuclear_bk", "energy", r"nuscale.{0,30}bankrupt|oklo.{0,30}bankrupt", [("nuclear_up", -1)], tags=["nuclear"])
# --- crypto ------------------------------------------------------------------------------------
rule("btc", "crypto", r"bitcoin|\bbtc\b", [("crypto_btc_up", 1)], dir="level", tags=["crypto", "bitcoin"],
     nott=r"anthropic|openai|flip btc|satoshi|unban")
rule("crypto_policy", "crypto", r"clarity act|genius act|market structure (bill|act)|crypto (bill|legislation|"
     r"market structure)|stablecoin (bill|act)|strategic bitcoin|bitcoin act", [("crypto_btc_up", 1), ("stablecoin_up", 1)],
     tags=["crypto", "policy", "regulation"])
rule("btc_unban", "crypto", r"unban bitcoin|legali[sz]e bitcoin|bitcoin reserve", [("crypto_btc_up", 1)],
     tags=["crypto", "bitcoin", "policy"])
rule("eth", "crypto", r"ethereum|\beth\b|\bether\b", [("crypto_alt_up", 1)], dir="level", tags=["crypto", "ethereum"])
rule("sol_xrp", "crypto", r"solana|\bsol\b|\bxrp\b|ripple", [("crypto_alt_up", 1)], dir="level",
     tags=["crypto", "altcoin"], conf="lo", nott=r"gpt sol")
rule("stablecoin", "crypto", r"stablecoin|\busdt\b|\busdc\b|tether", [("stablecoin_up", 1)], dir="level",
     tags=["crypto", "stablecoin"])
rule("crypto_etf", "crypto", r"crypto etf|(spot )?(sol|xrp|ether|eth) etf|etf (approval|approved)", [("crypto_alt_up", 1)],
     tags=["crypto", "etf"])
rule("crypto_treasury", "crypto", r"microstrategy|\bmstr\b|\bstrc\b|strategy.{0,20}(margin call|bankrupt)",
     [("crypto_treasury_stress", 1)], dir="mstr", tags=["crypto", "mstr"])
rule("crypto_ipo", "crypto", r"(kraken|consensys|okx|ledger|gemini exchange|bitgo|circle).{0,40}\bipo\b",
     [("crypto_ipo", 1)], dir="ipo", tags=["crypto", "ipo"])
# --- energy & commodities ----------------------------------------------------------------------
rule("oil", "energy", r"crude oil|\bwti\b|\bbrent\b|oil price|price of oil|oil (above|below|hit|reach)|\(cl\)",
     [("oil_up", 1)], dir="level", tags=["oil", "energy"], nott=r"pending|venezuel|production|reserves|inventor")
rule("crude_stocks", "energy", r"crude (oil )?(reserves|inventor|stocks)|strategic petroleum reserve|\bspr\b",
     [("oil_up", -1)], dir="level", tags=["oil", "energy"], conf="lo")
rule("venezuela_oil", "energy", r"venezuel.{0,40}(oil|crude) production", [("oil_up", -1)], dir="level",
     tags=["oil", "venezuela"])
rule("opec", "energy", r"\bopec\b", [("oil_up", 1)], dir="opec", tags=["oil", "opec"])
rule("natgas", "energy", r"natural gas|henry hub|\blng\b|\bng\b price", [("natgas_up", 1)], dir="level",
     tags=["gas", "energy"])
rule("nuclear", "energy", r"uranium|nuclear (reactor|power|plant|energy)|small modular reactor|\bsmr\b",
     [("nuclear_up", 1)], tags=["nuclear", "power"], conf="lo", nott=r"weapon|bomb|warhead|test|strike|iran")
rule("gold", "commod", r"\bgold\b|xauusd|\(gc\)", [("gold_up", 1)], dir="level", tags=["gold", "commodities"])
rule("silver", "commod", r"\bsilver\b|xagusd", [("silver_up", 1)], dir="level", tags=["silver", "commodities"])
rule("copper", "commod", r"\bcopper\b", [("copper_up", 1)], dir="level", tags=["copper", "commodities"])
# --- health ------------------------------------------------------------------------------------
rule("glp1", "health", r"glp.?1|ozempic|wegovy|zepbound|mounjaro|orforglipron|retatrutide|tirzepatide|semaglutide|"
     r"cagrisema|obesity (drug|pill)|weight.?loss (drug|pill)",
     [("obesity_up", 1)], co=1, tags=["health", "glp1"], conf="lo")
rule("drug_pricing", "health", r"drug pric|most.favou?red.nation|pharma(ceutical)? tariff|medicare negotiat",
     [("pharma_pressure", 1)], tags=["health", "drug-pricing"], conf="lo")

RULES = R

# tags that make an unmatched big market worth keeping as "other" (Claude may map it later)
MONEY_TAGS = {"economy", "finance", "fed-rates", "macro-indicators", "inflation", "tariffs", "trade-war", "ai",
              "tech", "big-tech", "crypto", "oil", "equities", "stocks", "ipos", "business", "economic-policy",
              "commodities", "gold", "compute", "openai", "anthropic", "nvidia", "treasuries", "earnings"}
OTHER_MIN_VOLUME = 250_000

# ---------------------------------------------------------------------------------------------
# Chinese (and casual) words → concept tags, for search.py
# ---------------------------------------------------------------------------------------------
CONCEPT_ZH = {
    "fed": ["美联储", "联储", "降息", "加息", "议息", "fomc", "鲍威尔", "货币政策", "联邦基金"],
    "rate-cut": ["降息", "减息", "宽松", "放水"],
    "rate-hike": ["加息", "收紧", "紧缩"],
    "rates": ["利率", "收益率", "国债", "美债", "基点", "bp"],
    "yields": ["收益率", "10年期", "十年期", "美债"],
    "mortgage": ["房贷", "按揭"],
    "inflation": ["通胀", "cpi", "物价", "pce", "通货膨胀"],
    "recession": ["衰退", "经济危机", "硬着陆", "萧条"],
    "jobs": ["失业", "就业", "非农", "裁员", "白领", "换人", "劳动力", "岗位"],
    "gdp": ["gdp", "经济增长", "增速"],
    "tariff": ["关税", "贸易战", "进口税"],
    "trade": ["贸易", "贸易协议", "出口管制"],
    "china": ["中国", "中美", "北京", "习近平", "大陆"],
    "taiwan": ["台湾", "两岸", "台海", "武统", "攻台", "封锁台湾"],
    "japan": ["日本", "日元", "日债"],
    "europe": ["欧洲", "欧元", "欧央行"],
    "mideast": ["中东", "伊朗", "以色列", "霍尔木兹", "胡塞", "沙特", "红海", "也门", "加沙"],
    "russia": ["俄罗斯", "普京", "俄乌"],
    "ukraine": ["乌克兰", "俄乌", "泽连斯基", "停火"],
    "war": ["战争", "开战", "冲突", "入侵", "打仗"],
    "oil": ["石油", "原油", "油价", "opec", "欧佩克", "汽油"],
    "gas": ["天然气", "lng"],
    "energy": ["能源"],
    "gold": ["黄金", "金价"],
    "silver": ["白银"],
    "copper": ["铜"],
    "midterms": ["中期选举", "中期", "众议院", "参议院", "国会"],
    "politics": ["民主党", "共和党", "特朗普", "选举", "大选", "政府关门", "停摆"],
    "shutdown": ["政府关门", "停摆"],
    "ai": ["ai", "人工智能", "大模型", "模型", "智能体", "agent"],
    "agi": ["agi", "通用人工智能", "超级智能", "asi"],
    "rsi": ["rsi", "自我改进", "自我迭代", "递归", "自己做研究", "自己做 ai 研究", "ai 研究", "自动化研究", "自己改进自己"],
    "milestone": ["实现", "突破", "里程碑"],
    "ai-release": ["发布", "新模型", "上线", "推出"],
    "ai-benchmark": ["千禧年", "数学难题", "奥数", "imo", "跑分", "排行榜", "竞技场", "hle", "基准"],
    "math": ["数学", "千禧年", "猜想"],
    "openai": ["openai", "chatgpt", "gpt", "奥特曼"],
    "anthropic": ["anthropic", "claude", "fable"],
    "google": ["谷歌", "google", "gemini", "deepmind", "waymo"],
    "xai": ["xai", "grok", "马斯克"],
    "meta": ["meta", "扎克伯格", "llama"],
    "chinese-ai": ["deepseek", "深度求索", "kimi", "月之暗面", "通义", "千问", "智谱", "国产模型"],
    "nvidia": ["英伟达", "nvidia", "黄仁勋", "显卡"],
    "compute": ["算力", "gpu", "租金", "h100", "b200", "芯片"],
    "datacenter": ["数据中心", "机房"],
    "power": ["电力", "电网", "发电"],
    "ai-regulation": ["监管", "法案", "安全法", "禁令", "暂停令"],
    "ai-bubble": ["泡沫", "破裂", "崩盘"],
    "ai-capital": ["估值", "融资"],
    "ipo": ["上市", "ipo"],
    "valuation": ["估值", "市值"],
    "bigtech": ["微软", "苹果", "亚马逊", "科技巨头", "最大公司", "市值"],
    "capex": ["资本开支", "capex", "投入", "砸钱"],
    "earnings": ["财报", "业绩"],
    "crypto": ["加密", "币", "数字货币"],
    "bitcoin": ["比特币", "btc"],
    "ethereum": ["以太坊", "eth"],
    "stablecoin": ["稳定币", "usdt", "usdc"],
    "stocks": ["股市", "美股", "大盘"],
    "sp500": ["标普", "s&p", "纳指", "道指"],
    "crash": ["崩盘", "熔断", "股灾", "暴跌"],
    "robot": ["机器人", "人形", "擎天柱", "optimus"],
    "robotaxi": ["无人驾驶", "自动驾驶", "robotaxi", "无人车"],
    "space": ["太空", "spacex", "星舰", "火箭"],
    "nuclear": ["核电", "核能", "铀", "小型堆"],
    "defense": ["军工", "国防", "导弹"],
    "health": ["医药", "药价", "医保", "fda"],
    "glp1": ["减肥药", "glp-1", "司美格鲁肽"],
    "housing": ["房价", "房地产", "买房"],
    "banks": ["银行", "暴雷"],
    "quantum": ["量子"],
}
