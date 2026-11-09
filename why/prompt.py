"""why/prompt.py — the question Claude gets for one 为什么 target (DESIGN §12 voice, §21 card).

    system_prompt() -> str      the 老风 rules: search the exact dates, every reason dated + linked, honest when
                                there is no clear news, opinion only in `say`, strict JSON
    user_prompt(f) -> str       built from facts.build(): measured numbers, dates to search, the question
    SCHEMA                      the JSON shape (passed to the gate; also validated in card.py)
"""
from __future__ import annotations

from why.util import today_et

REASON_TYPES = ("news", "earnings", "macro", "policy", "flow-mechanics", "rumor")

SCHEMA = {
    "type": "object",
    "properties": {
        "say": {"type": "string", "description": "老风一句话 ≤30 字，犀利、有立场"},
        "sayMild": {"type": "string", "description": "同一个意思的温和版"},
        "reasons": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
            "text": {"type": "string"}, "date": {"type": "string"}, "source": {"type": "string"},
            "url": {"type": "string"}, "type": {"type": "string", "enum": list(REASON_TYPES)},
            "conf": {"type": "number", "minimum": 0, "maximum": 1}},
            "required": ["text", "date", "source", "url", "type", "conf"]}},
        "counter": {"type": "array", "maxItems": 4, "items": {"type": "object", "properties": {
            "text": {"type": "string"}, "date": {"type": "string"}, "source": {"type": "string"},
            "url": {"type": "string"}}, "required": ["text"]}},
        "watch": {"type": "array", "maxItems": 4, "items": {"type": "object", "properties": {
            "by": {"type": "string"}, "what": {"type": "string"}}, "required": ["by", "what"]}},
        "honest": {"type": "string"},
        "timeline": {"type": "string", "enum": ["fits", "partly", "no-news"]},
    },
    "required": ["say", "reasons", "counter", "watch", "honest"],
}

SYSTEM = """你是「钱的天气」里的老风：见过太多轮周期的市场评论员，说话直接、犀利、有点毒舌、敢站队。
主人在地图上点了「为什么？」——你要上网查清楚：地图测到的这股钱的流向，背后到底是什么原因。只能用 WebSearch / WebFetch。

铁律：
1. 先查后说。围绕给你的确切日期搜：起风那天前后各 3 天、最猛那天当天和前一天（美股新闻常在前一天盘后或当天盘前）。中英文都搜，英文来源通常更全。优先一手来源（公司公告、财报、SEC 8-K/10-Q/13D/Form 4、监管和央行文件），其次路透、彭博、CNBC、WSJ、FT、Barron's、MarketWatch、Yahoo Finance、Investing.com、行业媒体。
2. reasons：每条是一个具体的、带日期的原因——发生了什么、为什么会让钱这样走。必须附你这次真的搜到或打开过的具体文章/文件 URL（不是首页、不是搜索结果页、不是你猜的链接）和事件/发布日期 YYYY-MM-DD。按重要性排，最多 5 条。没有真实链接的原因不准放进 reasons。
3. type 只能是：news（公司/行业新闻）、earnings（财报/指引）、macro（利率、美元、经济数据、央行）、policy（政策/监管/关税/预算/合同）、flow-mechanics（指数调仓、期权到期、ETF 申赎、空头回补/逼空、解禁、增发、大股东减持、再平衡——纯资金面）、rumor（未证实的传言，必须标出来）。
4. conf 0–1：日期对得上 + 一手来源 → 0.7–0.9；只有一家二手报道或日期对不太上 → ≤ 0.5；推测 → ≤ 0.3。
5. 诚实：查不到能对上日期的明确新闻，就直说，honest 里写清楚可能是什么（指数调仓、期权到期、板块轮动、空头回补、跟风炒作、整体风险偏好变化），并说明你查了什么没查到。绝不编造新闻、日期、数字、链接。有明确新闻时，honest 写一句时间线对不对得上（例如「新闻 10 月 5 日盘后出，6 日开盘就砸，对得上」）。honest 用大白话，≤ 120 字，不要出现 fits/partly 这类英文词。timeline：fits=新闻和钱的时间对得上 / partly=只解释了一部分 / no-news=没有明确新闻。
6. 地图上的数字是测量值，不是新闻，不能当来源；「估算净流」= 成交额 × 当天买卖力度，只是估算，不是真实申赎金额，别把它当新闻里的数字引用。但要用它判断时间线：在钱动之后才出的新闻不能当起因（可以放进 counter 或 honest）。
7. counter：跟主流解释相反的证据或另一种解释（有来源就带来源；没有就空列表）。
8. watch：接下来要盯的 1–3 件带日期的事（财报日、数据发布、政策节点、解禁日、到期日），by 写 YYYY-MM-DD 或 YYYY-MM，必须是今天之后的日子；财报日要查公司公告/IR 页面确认，没确认就在 what 里写「预计」。
9. say：一句 ≤ 30 字的老风点评，简体中文——犀利、有立场、可以刻薄，但必须从你查到的原因和地图数字推出来；不喊单、不给买卖建议；写完读一遍，不要错别字和生造词。sayMild：同一个意思的温和版。
10. 全部用简体中文（专有名词、代码、来源名可以保留英文）。公司名用下面给的名字（中文名或英文原名），不要自己音译（Twist 不是「推特」）。
11. 查完以后，最后一条消息只输出一个 JSON 对象，不要 markdown 代码块、不要别的话。字符串里不要用英文双引号，要引用就用「」。
JSON：{"say":"…","sayMild":"…","reasons":[{"text":"…","date":"YYYY-MM-DD","source":"媒体或机构名","url":"https://…","type":"news","conf":0.8}],"counter":[{"text":"…","date":"YYYY-MM-DD","source":"…","url":"https://…"}],"watch":[{"by":"YYYY-MM-DD","what":"…"}],"honest":"…","timeline":"fits"}"""


def system_prompt() -> str:
    return SYSTEM


KIND_HINT = {
    "node": "这是一个板块/地区。先找共同原因（宏观、政策、行业新闻、龙头财报），再看是不是被一两只大票带的（下面列了钱主要进出了谁）。",
    "stock": "这是一只股票。先查公司自己的事（财报、指引、合同、评级、增发、高管、诉讼、Form 4），再查行业和大盘。",
    "day": "只查这一天。先确认那天的价格和成交是真的大动（下面有数），再找当天和前一天盘后的具体事件；同行同一天也跌/涨的话，说明是板块的事。",
    "edge": "这是关系网上的一条边（两家公司之间的生意关系）。查这条关系本身最近有没有变化，再判断两边的钱是不是因为它在走。",
    "channel": "这是今天的主航道（钱从一个大板块流向另一个）。这多半是宏观/风险偏好层面的轮动，查那几天的宏观数据、央行、利率、美元、地缘、大事件。",
    "landing": "这是推演里的一个落点。重点是：最近有没有带日期的证据表明市场已经在按推演的逻辑定价（或者在反着走）。",
    "market": "这是一个预言市场。查推动概率变化的具体新闻和日期，再说对地图上的钱意味着什么。",
}


FOCUS_HINT = ("这一天本身就是大事（涨跌远超它平时一天的波动，或是这一波里最大的一天）。先解释这一天："
              "{first}同一天的消息排在 reasons 最前面；之前那一波的原因放后面或一句带过。")


def _hint(f: dict) -> str:
    fo = f.get("focus") or {}
    if not fo:
        return KIND_HINT.get(f.get("kind"), "")
    first = ("整个板块同一天一起动，先找板块共同的原因（行业新闻、政策、龙头公告、研报），再看公司自己的事。" if fo.get("together")
             else "同行没跟着动，多半是它自己的事（公告、财报、合同、评级、大单）。" if fo.get("nPeers") and not fo.get("same")
             else "先查它自己的事，再看同行和板块。")
    return FOCUS_HINT.format(first=first)


def user_prompt(f: dict) -> str:
    facts = f.get("facts") or {}
    try:
        from why import memo as wmemo
        memo = wmemo.lines_for(f)
    except Exception:  # noqa: BLE001 — the memo is optional
        memo = []
    lines = [
        f"今天 {today_et()}（美东）。地图数据截至 {f.get('asOf')}。问的是 {f.get('date')} 这一天的状况。",
        _hint(f),
        "—— 地图测到的（由价格和成交额算出，不是新闻；风 > 0 = 钱流入，拥挤度 0–100 跟它自己过去一年比）——",
        *(f.get("context") or []),
        "—— 给主人看的四句事实（你的回答要能解释它们）——",
        f"是什么：{facts.get('what')}",
        f"多少钱：{facts.get('howMuch')}",
        f"从什么时候：{facts.get('since')}",
        f"跟邻居比：{facts.get('vsNeighbours')}",
    ]
    if f.get("searchDates"):
        lines.append("重点搜这些日期前后：" + "、".join(f["searchDates"]))
    if f.get("searchTerms"):
        lines.append("可以用来搜的代码/名字：" + "、".join(str(x) for x in f["searchTerms"]))
    if memo:
        lines += ["—— 之前的卡片已经查到过（保持一致；查到更新、更权威的来源就用新的，并在 reasons 里写明来源）——", *memo]
    lines += ["—— 问题 ——", f.get("question") or ""]
    return "\n".join(x for x in lines if x is not None and x != "")


def retry_note(issues: list[str]) -> str:
    return ("\n\n—— 上一次的回答没通过检查 ——\n" + "；".join(issues[:6]) +
            "\n请重新查并严格按 JSON 格式回答：简体中文、每条 reason 带真实的具体文章 URL 和 YYYY-MM-DD 日期；"
            "查不到就让 reasons 为空、在 honest 里直说。")
