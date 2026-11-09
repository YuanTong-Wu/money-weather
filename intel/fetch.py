"""intel/fetch.py — fetch a URL with the standard library and turn it into readable text.

Safety and limits: http/https only; hosts that resolve to private/loopback/link-local addresses are
refused (also after redirects); 12 s socket timeout and a 20 s overall deadline; at most 3 MB read
(8 MB after gzip). HTML is stripped to text, preferring <article>/<main> when it holds the story.
X/Twitter post links go through the public oEmbed endpoint (the page itself needs JavaScript).
Never raises: returns FetchResult(ok=False, error=…) with a plain-Chinese reason instead.
"""
from __future__ import annotations

import gzip
import html
import ipaddress
import json
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
from html.parser import HTMLParser

TIMEOUT_S = 12
DEADLINE_S = 20
MAX_BYTES = 3_000_000
MAX_DECODED = 8_000_000
MAX_TEXT_CHARS = 12_000          # what goes into the prompt
THIN_CHARS = 280                 # less readable text than this → probably paywall / JS / login

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/128.0 Safari/537.36")


@dataclass
class FetchResult:
    ok: bool
    url: str
    final_url: str = ""
    title: str = ""
    site: str = ""
    published: str = ""            # YYYY-MM-DD if the page says
    description: str = ""
    text: str = ""
    chars: int = 0
    truncated: bool = False
    thin: bool = False
    error: str = ""                # plain Chinese, shown to the owner
    notes: list[str] = field(default_factory=list)

    def summary(self) -> dict:
        return {"ok": self.ok, "url": self.url, "finalUrl": self.final_url or self.url, "title": self.title,
                "site": self.site, "published": self.published, "chars": self.chars,
                "truncated": self.truncated, "thin": self.thin, "error": self.error}


# ───────────────────────────────────────── network ────────────────────────────────────────────
class _Refused(Exception):
    pass


def _check_host(host: str) -> None:
    if not host:
        raise _Refused("链接里没有网址")
    if host.lower() in ("localhost",) or host.lower().endswith((".local", ".localhost", ".internal")):
        raise _Refused("不抓本机或内网地址")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise _Refused("找不到这个网站（域名解析失败）")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast \
                or ip.is_unspecified:
            raise _Refused("不抓本机或内网地址")


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        p = urllib.parse.urlsplit(newurl)
        if p.scheme not in ("http", "https"):
            raise _Refused("网页跳到了不支持的地址")
        _check_host(p.hostname or "")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SafeRedirect())


def normalize_url(raw: str) -> str:
    s = (raw or "").strip().strip("<>\"'")
    if s and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", s) and re.match(r"^[\w.-]+\.[a-z]{2,}(/|$)", s, re.I):
        s = "https://" + s
    return s


def _download(url: str) -> tuple[bytes, str, str]:
    """→ (body bytes, content-type header, final url). Raises _Refused / urllib errors."""
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https"):
        raise _Refused("只支持 http/https 网址")
    _check_host(p.hostname or "")
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    t0 = time.monotonic()
    with _OPENER.open(req, timeout=TIMEOUT_S) as resp:
        ctype = resp.headers.get("Content-Type", "") or ""
        enc = (resp.headers.get("Content-Encoding", "") or "").lower()
        chunks, total = [], 0
        while True:
            if time.monotonic() - t0 > DEADLINE_S:
                break
            b = resp.read(65536)
            if not b:
                break
            chunks.append(b)
            total += len(b)
            if total >= MAX_BYTES:
                break
        body = b"".join(chunks)
        final = resp.geturl() or url
    if enc == "gzip" or body[:2] == b"\x1f\x8b":
        try:
            d = zlib.decompressobj(16 + zlib.MAX_WBITS)
            body = d.decompress(body, MAX_DECODED)
        except zlib.error:
            try:
                body = gzip.decompress(body)[:MAX_DECODED]
            except OSError:
                pass
    elif enc == "deflate":
        try:
            body = zlib.decompressobj().decompress(body, MAX_DECODED)
        except zlib.error:
            try:
                body = zlib.decompressobj(-zlib.MAX_WBITS).decompress(body, MAX_DECODED)
            except zlib.error:
                pass
    return body, ctype, final


def _decode(body: bytes, ctype: str) -> str:
    cands = []
    m = re.search(r"charset=([\w-]+)", ctype or "", re.I)
    if m:
        cands.append(m.group(1))
    head = body[:4096].decode("ascii", "ignore")
    m = re.search(r"<meta[^>]+charset=[\"']?([\w-]+)", head, re.I)
    if m:
        cands.append(m.group(1))
    cands += ["utf-8", "gb18030", "big5", "latin-1"]
    for c in cands:
        c = {"gb2312": "gb18030", "gbk": "gb18030"}.get(c.lower(), c)
        try:
            return body.decode(c)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


# ───────────────────────────────────────── HTML → text ────────────────────────────────────────
_SKIP = {"script", "style", "noscript", "svg", "template", "iframe", "canvas", "button", "select",
         "nav", "footer", "aside", "figure", "figcaption", "picture", "video", "audio", "dialog", "menu"}
_BLOCK = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section",
          "article", "main", "blockquote", "pre", "header", "dd", "dt", "hr"}
_VOID = {"br", "hr", "img", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "track"}
_DATE_META = ("article:published_time", "og:published_time", "datepublished", "pubdate", "publishdate",
              "date", "dc.date", "dc.date.issued", "parsely-pub-date", "sailthru.date", "article.published",
              "publish-date", "og:updated_time", "article:modified_time")


class _Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.stack: list[str] = []
        self.in_title = False
        self.title = ""
        self.meta: dict[str, str] = {}
        self.all: list[str] = []
        self.focus: list[str] = []        # text inside <article>/<main>
        self.focus_depth = 0
        self.header_depth = 0             # page <header> outside article = site chrome
        self.ld: list[str] = []
        self.in_ld = False
        self.time_dt = ""

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"]
            return
        if tag == "time" and not self.time_dt and a.get("datetime"):
            self.time_dt = a["datetime"]
        if tag == "script" and "ld+json" in a.get("type", ""):
            self.in_ld = True
        if tag in _VOID:
            if tag in ("br", "hr"):
                self._emit("\n")
            return
        self.stack.append(tag)
        if tag == "title":
            self.in_title = True
        if tag in _SKIP or (tag == "header" and not self.focus_depth):
            self.skip += 1
        if tag in ("article", "main"):
            self.focus_depth += 1
        if tag in _BLOCK:
            self._emit("\n")

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if tag == "script":
            self.in_ld = False
        if tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            if t == "title":
                self.in_title = False
            if t in _SKIP or (t == "header" and not self.focus_depth):
                self.skip = max(0, self.skip - 1)
            if t in ("article", "main"):
                self.focus_depth = max(0, self.focus_depth - 1)
            if t in _BLOCK:
                self._emit("\n")
            if t == tag:
                break

    def handle_data(self, data):
        if self.in_ld:
            self.ld.append(data)
            return
        if self.in_title:
            self.title += data
            return
        if self.skip:
            return
        self._emit(data)

    def _emit(self, s: str) -> None:
        if self.skip and s != "\n":
            return
        self.all.append(s)
        if self.focus_depth:
            self.focus.append(s)


def _clean_lines(raw: str) -> str:
    out, seen = [], set()
    for line in raw.split("\n"):
        line = re.sub(r"[ \t 　]+", " ", line).strip()
        if len(line) < 4:
            continue
        cjk = len(re.findall(r"[一-鿿]", line))
        words = len(line.split())
        # menus, buttons, share bars: very short lines with no sentence in them
        if cjk < 6 and words < 4 and not re.search(r"\d", line):
            continue
        if line in seen:
            continue
        seen.add(line)
        out.append(line)
    return "\n".join(out)


_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct",
                                         "nov", "dec"], start=1)}


def _date_only(s: str) -> str:
    s = s or ""
    m = re.search(r"(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.search(r"\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d\d)\b", s)        # January 6, 2025
        m2 = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(20\d\d)\b", s)       # 6 January 2025
        if m and m.group(1).lower() in _MONTHS:
            y, mo, d = int(m.group(3)), _MONTHS[m.group(1).lower()], int(m.group(2))
        elif m2 and m2.group(2).lower() in _MONTHS:
            y, mo, d = int(m2.group(3)), _MONTHS[m2.group(2).lower()], int(m2.group(1))
        else:
            return ""
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return ""
    return f"{y}-{mo:02d}-{d:02d}"


def html_to_text(doc: str) -> dict:
    """→ {title, text, published, description, site}. Pure function (used by --file too)."""
    p = _Extractor()
    try:
        p.feed(doc)
        p.close()
    except Exception:  # HTMLParser is forgiving, but never let a weird page crash ingest
        pass
    meta = p.meta
    title = (meta.get("og:title") or meta.get("twitter:title") or p.title or "").strip()
    published = ""
    for k in _DATE_META:
        if meta.get(k):
            published = _date_only(meta[k])
            if published:
                break
    headline = ""
    for blob in p.ld:
        try:
            data = json.loads(blob.strip())
        except ValueError:
            continue
        items = data if isinstance(data, list) else (data.get("@graph") if isinstance(data, dict) and
                                                      isinstance(data.get("@graph"), list) else [data])
        for it in items:
            if isinstance(it, dict):
                published = published or _date_only(str(it.get("datePublished") or ""))
                headline = headline or str(it.get("headline") or "")
    if not published and p.time_dt:
        published = _date_only(p.time_dt)
    focus = _clean_lines("".join(p.focus))
    whole = _clean_lines("".join(p.all))
    text = focus if len(focus) >= 400 else whole
    if not published:
        # press releases often carry the date only in the text ("For release at 2:00 p.m. EDT September 17, 2025")
        published = _date_only(text[:1500])
    return {"title": html.unescape(title or headline).strip()[:200], "text": text, "published": published,
            "description": (meta.get("og:description") or meta.get("description") or "").strip()[:500],
            "site": (meta.get("og:site_name") or "").strip()[:60]}


# ───────────────────────────────────────── public ─────────────────────────────────────────────
def _twitter_oembed(url: str) -> FetchResult | None:
    p = urllib.parse.urlsplit(url)
    host = (p.hostname or "").lower()
    if not (host.endswith("twitter.com") or host.endswith("x.com")) or "/status/" not in p.path:
        return None
    api = "https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=" + urllib.parse.quote(
        "https://twitter.com" + p.path, safe="")
    try:
        body, ctype, _ = _download(api)
        data = json.loads(_decode(body, ctype))
    except Exception:
        return FetchResult(ok=False, url=url, error="X/推特的帖子抓不到（可能已删或不公开），请把帖子文字粘贴过来")
    h = data.get("html") or ""
    quote = re.sub(r"<a [^>]*>(pic\.twitter\.com[^<]*)</a>", "", h)
    txt = html_to_text(quote)["text"] or re.sub(r"<[^>]+>", " ", quote)
    txt = html.unescape(txt).strip()
    author = data.get("author_name") or ""
    return FetchResult(ok=bool(txt), url=url, final_url=url, title=f"{author} 的帖子" if author else "X 帖子",
                       site="X", published=_date_only(txt[-60:]), text=txt[:MAX_TEXT_CHARS], chars=len(txt),
                       error="" if txt else "帖子里没有文字")


def fetch_url(raw_url: str) -> FetchResult:
    url = normalize_url(raw_url)
    if not url:
        return FetchResult(ok=False, url=raw_url, error="网址是空的")
    tw = _twitter_oembed(url)
    if tw is not None:
        return tw
    try:
        body, ctype, final = _download(url)
    except _Refused as e:
        return FetchResult(ok=False, url=url, error=str(e))
    except urllib.error.HTTPError as e:
        why = {401: "要登录", 403: "网站拒绝了（可能防爬虫或要登录）", 404: "网页不存在", 429: "访问太频繁被挡了",
               451: "这个地区看不了"}.get(e.code, f"网站返回错误 {e.code}")
        return FetchResult(ok=False, url=url, error=f"网页抓不到：{why}")
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason):
            return FetchResult(ok=False, url=url, error=f"网页抓不到：{TIMEOUT_S} 秒没有回应")
        return FetchResult(ok=False, url=url, error=f"网页抓不到：连不上（{str(reason)[:80]}）")
    except Exception as e:  # never let a fetch crash the job
        return FetchResult(ok=False, url=url, error=f"网页抓不到：{type(e).__name__}")

    ct = ctype.lower()
    if "pdf" in ct or body[:5] == b"%PDF-":
        return FetchResult(ok=False, url=url, final_url=final, error="这是 PDF，暂时读不了，请把要紧的段落粘贴过来")
    if any(x in ct for x in ("image/", "video/", "audio/", "octet-stream", "zip")):
        return FetchResult(ok=False, url=url, final_url=final, error="这个链接不是文字网页")
    doc = _decode(body, ctype)
    if "html" in ct or "xml" in ct or re.search(r"<(html|body|div|p)\b", doc[:3000], re.I):
        info = html_to_text(doc)
    elif "json" in ct:
        info = {"title": "", "text": doc, "published": "", "description": "", "site": ""}
    else:
        info = {"title": "", "text": _clean_lines(doc) or doc, "published": "", "description": "", "site": ""}
    text = info["text"]
    if info["description"] and info["description"] not in text[:2000]:
        text = info["description"] + "\n" + text
    full = len(text)
    res = FetchResult(ok=True, url=url, final_url=final, title=info["title"], site=info["site"] or
                      (urllib.parse.urlsplit(final).hostname or ""), published=info["published"],
                      description=info["description"], text=text[:MAX_TEXT_CHARS], chars=full,
                      truncated=full > MAX_TEXT_CHARS)
    if len(body) >= MAX_BYTES:
        res.notes.append("网页太大，只读了前面一部分")
    if full < THIN_CHARS:
        res.thin = True
        res.notes.append("网页正文很少（可能要登录、有付费墙，或靠脚本加载）")
        if full < 40:
            res.ok = False
            res.error = "网页里几乎没有正文（可能要登录、有付费墙，或靠脚本加载），请把文字粘贴过来"
    return res


def slug_words(url: str) -> str:
    """Words hidden in a URL path (news URLs often carry the headline). Used when the fetch failed."""
    p = urllib.parse.urlsplit(normalize_url(url))
    parts = [x for x in re.split(r"[/_\-.]+", urllib.parse.unquote(p.path)) if x]
    words = [w for w in parts if re.fullmatch(r"[A-Za-z]{2,}|[一-鿿]+", w)
             and w.lower() not in {"html", "htm", "php", "aspx", "www", "com", "news", "article", "articles",
                                   "story", "amp", "index", "en", "us", "world", "business", "markets", "tech",
                                   "technology", "status"}]
    return " ".join(words)
