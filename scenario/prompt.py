"""The prompt and the output schema for the reasoning step (DESIGN §9 step 1).

The method text below is a faithful, compressed version of the owner's playbook
(时间差打法 + 合理激进). Change it there first, then here.
"""
from __future__ import annotations

import re
from datetime import date as _date

from weather import SEASONS, TIERS, World  # type: ignore

SYSTEM = (
    "你是「钱的天气」的推演引擎。主人写下一个带日期的判断，你把它推成一张“钱会怎么流”的地图。"
    "你只输出一个合法的 JSON 对象，不要任何别的文字，不要 markdown 代码块。"
)

METHOD = """\
# 主人的打法（必须照着做）
1. 优势在“早”，不在“快”。市场极其灵敏：公开数据和第一层后果几乎马上进价格。主人的优势是比市场更早想到日子和第二、三层后果，提前在场、拿得住。要找的是需要一个个季度的现实（财报、合同、订单、招聘和裁员数据）慢慢逼市场相信的地方，不是消息当天几分钟的反应。
2. 根是一句带日期、能核对的话，分三档：
   - 弱：只有方向成立，事情照现在的趋势慢慢来（AI 的根就是：AI 照现在这样继续涨）。
   - 中：明显比市场预期快或大，但不完全是原话（AI 的根就是：两年内明显跑到预期前面）。
   - 强：原话、原日期完全成真。
   每个落点都要标它至少要哪一档的根才成立（needs）：问“根只成立到这一档，这一条还对不对”。弱的根就成立的落点最值钱。
3. 用四个问题往下推后果，每个答案写成一句能核对的话：
   ① 谁要多买什么  ② 谁省了钱  ③ 谁收到钱  ④ 谁的生意没了
   然后再往下推一层：这些事发生了，又会带出什么。推到说不出具体的公司类别为止。不要只在 AI 硬件里转，那是旧打法。
4. 链条越短越可靠。第一层后果最可靠，每往下一层就更不可靠。两年以外的具体情形不当真。
5. 赌误差的方向，不赌具体的路。优先“越快越赚、不用猜对具体怎么走”的落点（robust=true），比如“用的算力更多”“按人头卖的生意受损”。要猜中某一家、某一个标准、某一条具体路线才赚的，robust=false。
6. 合理激进：根默认成立，你不要去削弱它，“已经涨了”“还没证据”“太早”都不是理由。但不编造：只写你确定知道的事实，自己推的就是推断；不要写看起来像查到的具体数字。
7. 根自己的认错线要近：按月列出接下来三个月（{m1}、{m2}、{m3}）每个月该出现的公开信号，再加一两条根的日期之后的。每条具体到“谁、在哪、什么数或什么事”，到期能一眼核对。到期一个都没出现，就把根降一档。
8. 这是研究材料：不写买卖指令、不写仓位，不出现“买入”“卖出”“建议持有”。
9. 挂在同一件事上的算一注：给每条 impact 一个 factor（它真正押的那件事，比如“算力用得更多”“按人头卖的生意受损”“电不够用”），同一件事用同一个词。二十条都靠同一件事，那是一注，不是二十注。
10. 宁可估，不可空：缺数据的地方用预言市场的相近盘子或产业链逻辑补一个合理的估计，但要老实标明是估的（rootOdds.direct=false，写 basis 和 conf），绝不把估计说成查到的事实。
"""

TIER_TEXT = {
    "强": "主人选了「强」档：推演原话、原日期完全成真的世界。只有强档才成立的落点可以写，但弱档就成立的落点最值钱，要先找。",
    "中": "主人选了「中」档：推演“明显比市场预期快或大，但不一定是原话的日期”的世界。需要强档才成立的落点最多写 3 条，标 needs=强。",
    "弱": "主人选了「弱」档：推演“方向对，但原话的日期不成真，事情照现在的趋势慢慢来”的世界（AI 的根就是：AI 照现在这样继续涨）。"
          "大多数落点必须在弱档下也成立（needs=弱）；需要中/强档才成立的最多写 3 条，并如实标 needs，引擎会给它们打折。"
          "lag 也要按慢的世界写，不要照搬强档的时间。",
}

VOICE = """# 说话的口气（老风）
你是“老风”，见过太多轮牛熊的天气播报员：一针见血、有点毒舌、敢站队，拥挤的就说挤，死钱就说死钱。
例：“AI 算力又在吸血，整个美股的钱都往这一个洞里灌。”“网络安全冷得像冰窖，可偏偏这种时候最像春天前夜。”
规矩：观点必须从地图上的天气或推理链里来，不许凭空吹；事实和数字要准，不编数字；每句不超过 30 个字；
是成年人的犀利，不卖萌、不堆感叹号。headline、take、chain.say、why、upside、risk、polymarket.say 都用这个口气；
headlineMild 是同一句话的温和版。
"""

WORLDVIEW = """\
# 主人的背景看法（只在根和 AI 有关时用）
主人认为 AI 按指数走，而且正在跑到市场预期前面。主人说的 RSI 指“中间那档”：大部分 AI 研究的活由 AI 干，人只定方向和验收，不要求完全闭环。主人 2026-10-03 的根：2026 年 11 月基本实现 RSI，同一个月出现能连续干一个月的 agent；之后公司用一到两年真的换人。
主人的经验：普通的 AI 发布不是信号；最像 RSI 的大消息出来时，第一层当天走一半左右，第二层当天只走约一成，几周后才跟上。
"""

OUTPUT_RULES = """\
# 输出要求
- root.text：主人的原话，最多补上日期，不超过 60 个字。你对原话怎么理解、按什么标准算成真，写在 root.note（不超过 80 个字）。root.date：YYYY-MM 或 YYYY-MM-DD。
- rootOdds：预言市场给这个根多大机会，按主人选的那一档算（弱档就估“方向成立、照现在的趋势走”的机会，不是原话原日期的机会）。prob 是 0 到 1 之间的数（某一盘 YES 是 23%，就写 0.23）。
  有一盘直接押的就是这件事（同一件事、同一个日子）：direct=true，marketIds 写它。
  没有直接押的：用相近的盘子推（比如“2027 年前宣布 AGI”推“11 月实现 RSI”），direct=false，basis 写“用相近的盘子推算：怎么推的”，conf 写 0 到 1 的把握；
  一盘相关的都没有：按产业链逻辑估一个市场大概信几成，direct=false，marketIds 写 []，basis 写“产业链逻辑推断：理由”，conf 不超过 0.3。
  say 一句大白话（“预言市场只给这件事约两成机会，主人比市场早得多”），估的就说“估计”。
- impacts 10 到 18 条，正负都要有（“谁的生意没了”也要落到地图上）。id 必须是地图里的，尽量用最具体的那一层地块（缩进最深的那层）；股票（s:代码）只在它本身就是最干净的载体时才用，最多 5 个。
- dir：1 = 钱会流进来、对它好；-1 = 钱会流出去、对它坏。strength：1 小，2 中，3 大。
- lag：从今天算起，这块地的钱什么时候开始明显按这件事流动：now（一个月内）、1-3m、3-12m、1y+。
- order：第几层后果（1 = 直接后果，2 = 再往下一层，3 = 再往下两层）。
- needs：至少要哪一档的根（弱/中/强）。robust：true 或 false（见打法第 5 条）。
- why：一句大白话说清机制，具体到“谁多花了或少花了什么钱”。
- factor：这一条真正押的那件事，不超过 8 个字，同一件事的几条用完全相同的词。整张图通常只有 3 到 5 个 factor。
- upside：对了有多大，一句话给量级（“HBM 收入再翻一倍”“外包收入掉一到两成”），不超过 25 个字；拿不准就写“量级说不准”。
- check：这一条自己的认错的数，带日期，比如“到 2027-02 美光财报里 HBM 收入环比不到两成，这条算错”。日期是估的就写“约”。
- chain：先四步，q 依次是“谁要多买什么”“谁省了钱”“谁收到钱”“谁的生意没了”；再加 1 到 2 步，q 写“再往下一层”。say 一句能核对的话；nodes 列它落到的地图 id。
- headline：一句话写“如果这成真，钱会从【某处】流向【某处】”，不超过 40 个字，老风的口气。headlineMild：同一句的温和版。title：不超过 12 个字。
- take：老风的一句总评，不超过 40 个字：最大的时间差在哪、哪里早被抢跑了（看地图上的季节、拥挤度和 60 日涨跌说话）。
- upside：对了有多大，一句话，给量级和一句理由。risk：最要紧的一条风险，只写一条。
- polymarket：只能用上面列出的市场 id，挑真相关的 0 到 6 个，不相关就别硬挑。relation：supports（YES 说明根在往成真走）、contradicts（YES 说明根错了）、timing（它在给同一件事定日子）。say：一句“市场认为……；主人的日期比市场早／晚／差不多……”，要把市场的概率和截止日说出来。
- killSignals：4 到 6 条。by 用 YYYY-MM-DD；前三条分别落在接下来三个月里。ifMissing 写到期没出现该怎么办（通常是“根降一档”）。
- 说话：大白话，结论先说，句子短，不用破折号，不以问句结尾。不用“动量”“相对强弱”“z 分数”这类词。
"""


def _is_ai(text: str) -> bool:
    return bool(re.search(r"AI|A\.I\.|人工智能|RSI|AGI|agent|智能体|大模型|模型|算力|OpenAI|Anthropic|自我改进|机器人",
                          text, re.I))


def _months_after(d: _date, n: int) -> list[str]:
    out, y, m = [], d.year, d.month
    for _ in range(n):
        m += 1
        if m > 12:
            y, m = y + 1, 1
        out.append(f"{y}-{m:02d}")
    return out


def weather_str(f: dict) -> str:
    s = SEASONS[f["season"]]
    season = f"{s['emoji']}{s['name']}" if f["season"] != "none" else "平"
    return f"{season} 风{f['wind']:+.1f} 挤{f['pres']} 60日{f['ret60'] * 100:+.0f}%"


def season_summary(world: World) -> str:
    """One line per season over the leaf regions: where money is just arriving, where it is leaving."""
    groups: dict[str, list[tuple[float, str]]] = {k: [] for k in ("spring", "summer", "autumn", "winter")}
    for rid in world.regions:
        if rid == "world" or not world.is_leaf_region(rid):
            continue
        f = world.feat(rid)
        if f["season"] in groups:
            groups[f["season"]].append((f["wind"], world.nodes[rid].get("name") or rid))
    out = ["今天各季节的地块（最具体那层，按风排）："]
    for k, rev in (("spring", True), ("summer", True), ("autumn", False), ("winter", False)):
        items = sorted(groups[k], reverse=rev)
        if not items:
            continue
        s = SEASONS[k]
        names = "、".join(n for _, n in items[:14]) + (f" 等 {len(items)} 块" if len(items) > 14 else "")
        out.append(f"- {s['emoji']}{s['name']}（{s['now']}）：{names}")
    return "\n".join(out)


STOCKS_PER_LINE = 8


def tree_lines(world: World) -> str:
    lines = []

    def walk(nid, depth):
        n = world.nodes[nid]
        if n.get("kind") == "stock":
            return
        kids = world.children.get(nid, [])
        if nid != "world":
            desc = (n.get("desc") or "").strip()
            line = f"{'  ' * (depth - 1)}{nid} | {n.get('name', '')} | {desc}"
            stocks = [k for k in kids if world.nodes[k].get("kind") == "stock"]
            tags = (n.get("tags") or [])[:4] if stocks else []  # parents carry every child's tag: noise
            if tags:
                line += f" [{','.join(tags)}]"
            line += f" | {weather_str(world.feat(nid))}"
            if stocks:
                names = []
                stocks = sorted(stocks, key=lambda k: -world.dv(k))[:STOCKS_PER_LINE]
                for s in stocks:
                    sn = world.nodes[s]
                    t = sn.get("ticker") or s[2:]
                    nm = sn.get("name") or ""
                    names.append(t if (not nm or nm.upper() == t) else f"{t} {nm}")
                line += " | 股票: " + ", ".join(names)
            lines.append(line)
        for k in kids:
            walk(k, depth + 1)

    walk("world", 0)
    return "\n".join(lines)


def pm_lines(markets: list[dict]) -> str:
    if not markets:
        return "（这次没有找到相关的预言市场，polymarket 输出空数组）"
    out = []
    for m in markets:
        d7 = "" if m.get("d7") is None else f"，一周 {m['d7'] * 100:+.0f} 个点"
        q = m["q"] if m.get("qZh") in (None, "", m["q"]) else f"{m['qZh']}（{m['q']}）"
        vol = m.get("volume") or 0
        vol_s = f"{vol / 1e6:.1f}M" if vol >= 1e6 else f"{vol / 1e3:.0f}k"
        out.append(f"- id={m['id']} | {q} | YES 概率 {m['prob'] * 100:.1f}%{d7} | 截止 {m.get('endDate') or '?'} | 成交 ${vol_s}")
    return "\n".join(out)


def ladder_lines(ladders: list[dict]) -> str:
    if not ladders:
        return ""
    out = ["市场给这些事定的日子（概率阶梯：每一档是“在这个日期之前发生”的 YES 概率，括号里是那一档的市场 id，也可以用在 polymarket 和 rootOdds 里）："]
    for e in ladders:
        rungs = " · ".join(f"{x['date']} 前 {x['prob'] * 100:.1f}%（id={x['id']}）" for x in e["ladder"][:6]
                           if x.get("prob") is not None)
        p50 = f"市场认为 {e['p50']} 前过半" if e.get("p50") else "哪一档都没过半"
        out.append(f"- {e['title']} | {rungs} | {p50}")
    return "\n".join(out)


def build(world: World, text: str, date: str | None, tier: str | None, markets: list[dict],
          today: _date | None = None, ladders: list[dict] | None = None) -> str:
    today = today or _date.today()
    m1, m2, m3 = _months_after(today, 3)
    date_line = (f"主人给的日期：{date}（以这个为准，root.date 就写它）" if date else
                 "主人没单独给日期：从原话里找；原话里也没有，root.date 写这件事最可能发生的月份（YYYY-MM，不要写今天），"
                 "并在 root.note 里说清楚")
    tier_line = (f"主人选的根的档：{tier}（root.tier 就写它）。{TIER_TEXT.get(tier, '')}" if tier else
                 "主人没选档：原话带具体日期就当“强”，否则当“中”。弱档就成立的落点最值钱，要先找。")
    parts = [
        f"今天是 {today.isoformat()}，地图数据截至 {world.asOf}（美股收盘）。",
        "主人写下了一个判断，叫“根”：",
        f"「{text.strip()}」",
        date_line,
        tier_line,
        "",
        "请推演：如果这个根按主人的日期成真，钱会从哪里流到哪里；落在地图的哪些地块；什么时候；"
        "主人要的是比市场早，所以要把“市场一时半会儿想不到、要靠几个季度的现实才信”的落点找出来。"
        "哪里已经被算进价格，程序会用今天的天气另算，你不用因为某块地已经很热就不写它。",
        "",
        METHOD.format(m1=m1, m2=m2, m3=m3),
        WORLDVIEW if _is_ai(text) else "",
        "# 地图（只能用这里的 id）",
        "每行：id | 名字 | 说明 [标签] | 今天的天气 | 股票。缩进表示层级，缩进最深的是最具体的地块；股票 id 写成 s:代码（例如 s:NVDA）。",
        "天气：季节（🌱春=钱刚开始进来还不挤，接下来可能入夏；☀️夏=正热人多，小心入秋；🍂秋=钱从拥挤处撤离，可能入冬；"
        "❄️冬=冷清没人管，等春天；平=平稳），"
        "风=钱的流向（正=流入，跟它自己过去一年比），挤=拥挤度 0-100，60日=过去 60 个交易日涨跌。",
        season_summary(world),
        tree_lines(world),
        "",
        "# 预言市场（Polymarket，真钱下注的概率）",
        pm_lines(markets),
        ladder_lines(ladders or []),
        "提醒：预言市场盘子小，可能错；主人的记录显示它们常常把 AI 的日子估得太早，不是太晚。"
        "用它来比日子：市场给这件事多大概率、在什么日期之前；主人的日期比市场早还是晚。",
        "",
        VOICE,
        OUTPUT_RULES,
        "只输出 JSON。",
    ]
    return "\n".join(parts)


def schema(world: World, markets: list[dict]) -> dict:
    ids = sorted(i for i in world.nodes if i != "world")
    pm_ids = [m["id"] for m in markets]
    pm_item = {"type": "object", "required": ["id", "relation", "say"], "additionalProperties": False,
               "properties": {"id": {"type": "string"},
                              "relation": {"type": "string", "enum": ["supports", "contradicts", "timing"]},
                              "say": {"type": "string"}}}
    if pm_ids:
        pm_item["properties"]["id"]["enum"] = pm_ids
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "headline", "headlineMild", "take", "root", "rootOdds", "upside", "risk", "chain",
                     "impacts", "polymarket", "killSignals"],
        "properties": {
            "title": {"type": "string"},
            "headline": {"type": "string"},
            "headlineMild": {"type": "string"},
            "take": {"type": "string"},
            "root": {"type": "object", "required": ["text", "date", "tier"], "additionalProperties": False,
                     "properties": {"text": {"type": "string"}, "date": {"type": "string"},
                                    "tier": {"type": "string", "enum": TIERS}, "note": {"type": "string"}}},
            "rootOdds": {"type": "object", "required": ["prob", "marketIds", "say", "direct", "basis", "conf"],
                         "additionalProperties": False,
                         "properties": {"prob": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
                                        "direct": {"type": "boolean"},
                                        "basis": {"type": "string"},
                                        "conf": {"type": "number", "minimum": 0, "maximum": 1},
                                        "marketIds": {"type": "array", "maxItems": 6 if pm_ids else 0,
                                                      "items": ({"type": "string", "enum": pm_ids} if pm_ids
                                                                else {"type": "string"})},
                                        "say": {"type": "string"}}},
            "upside": {"type": "string"},
            "risk": {"type": "string"},
            "chain": {"type": "array", "minItems": 4, "maxItems": 7, "items": {
                "type": "object", "required": ["step", "q", "say", "nodes"], "additionalProperties": False,
                "properties": {"step": {"type": "integer"}, "q": {"type": "string"}, "say": {"type": "string"},
                               "nodes": {"type": "array", "items": {"type": "string", "enum": ids}}}}},
            "impacts": {"type": "array", "minItems": 4, "maxItems": 24, "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "dir", "strength", "lag", "order", "needs", "robust", "factor", "why", "upside",
                             "check"],
                "properties": {
                    "id": {"type": "string", "enum": ids},
                    "dir": {"type": "integer", "enum": [1, -1]},
                    "strength": {"type": "integer", "minimum": 1, "maximum": 3},
                    "lag": {"type": "string", "enum": ["now", "1-3m", "3-12m", "1y+"]},
                    "order": {"type": "integer", "minimum": 1, "maximum": 3},
                    "needs": {"type": "string", "enum": TIERS},
                    "robust": {"type": "boolean"},
                    "factor": {"type": "string"},
                    "why": {"type": "string"},
                    "upside": {"type": "string"},
                    "check": {"type": "string"}}}},
            "polymarket": {"type": "array", "maxItems": 6 if pm_ids else 0, "items": pm_item},
            "killSignals": {"type": "array", "minItems": 3, "maxItems": 8, "items": {
                "type": "object", "required": ["by", "signal"], "additionalProperties": False,
                "properties": {"by": {"type": "string"}, "signal": {"type": "string"},
                               "ifMissing": {"type": "string"}}}},
        },
    }
