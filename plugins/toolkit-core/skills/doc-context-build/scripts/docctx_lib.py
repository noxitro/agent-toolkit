#!/usr/bin/env python3
"""Shared pieces of the doc-context-build scripts (collect / bundle / compose).

Standard library only, Python 3.8+. Nothing here opens a network connection; collect.py
does that. Nothing here reads the access token; collect.py reads it from the environment
variable named in the config and never writes it anywhere.
"""

import datetime as _dt
import hashlib
import html
import json
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

CONFIG_DEFAULTS = {
    "max_depth": 3,
    "max_pages": 500,
    "exclude": [],
    "token_env": "DOC_SITE_TOKEN",
    "auth_header": "Authorization: Bearer {token}",
    "stale_days": 30,
    "split_chars": 30000,
    "bundle_warn_chars": 36000,
    "out_dir": "out",
    "rules_dir": "rules",
    "manifest": "manifest.json",
    "timeout_sec": 30,
    "user_agent": "doc-context-build/1.0",
}

# `python -I` ignores PYTHONIOENCODING, and on Windows a piped stdout would otherwise be the
# ANSI code page; the reports are Japanese, so force UTF-8 and plain LF on both streams.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", newline="\n")
    except (AttributeError, ValueError):
        pass

PAGE_MARK = "<!-- docctx:page {url} -->"
PAGE_MARK_RE = re.compile(r"^<!-- docctx:page (\S+) -->$", re.M)


def die(msg, code=2):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def now_iso():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(s):
    if not s:
        return None
    try:
        return _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return None


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_text(path, text):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def sha256_text(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- config

class Project:
    """A project = a docctx.json plus the rules/ and manifest.json beside it."""

    def __init__(self, config_path):
        config_path = os.path.abspath(config_path)
        if os.path.isdir(config_path):
            config_path = os.path.join(config_path, "docctx.json")
        if not os.path.exists(config_path):
            die("config not found: " + config_path)
        self.config_path = config_path
        self.dir = os.path.dirname(config_path)
        cfg = dict(CONFIG_DEFAULTS)
        cfg.update(read_json(config_path, {}))
        if not cfg.get("root_url"):
            die("docctx.json: root_url is required")
        self.cfg = cfg
        self.rules_dir = self._rel(cfg["rules_dir"])
        self.manifest_path = self._rel(cfg["manifest"])
        self.set_out_dir(self._rel(cfg["out_dir"]))

    def _rel(self, p):
        return p if os.path.isabs(p) else os.path.normpath(os.path.join(self.dir, p))

    def set_out_dir(self, out_dir):
        """Point every output location under out_dir (also used by --out)."""
        self.out_dir = os.path.abspath(out_dir)
        self.cache_dir = os.path.join(self.out_dir, "cache")
        self.pages_dir = os.path.join(self.cache_dir, "pages")
        self.removed_dir = os.path.join(self.cache_dir, "_removed")
        self.index_path = os.path.join(self.cache_dir, "index.json")
        self.bundles_dir = os.path.join(self.out_dir, "bundles")
        self.context_dir = os.path.join(self.out_dir, "context")

    def load_index(self):
        return read_json(self.index_path, {"root_url": self.cfg["root_url"], "pages": {}, "last_run": {}})

    def load_manifest(self):
        m = read_json(self.manifest_path)
        if m is None:
            die("manifest not found: " + self.manifest_path)
        m.setdefault("bundles", {})
        m.setdefault("guidelines", {})
        return m


# ---------------------------------------------------------------- URLs

def normalize_url(url):
    """Lower-case scheme/host, drop the fragment, and treat `.../index.html` as `.../`."""
    parts = urlsplit(url)
    path = parts.path or "/"
    if path.endswith("/index.html") or path.endswith("/index.htm"):
        path = path.rsplit("/", 1)[0] + "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def in_scope(url, root_url, excludes):
    """Same scheme+host as root and path under the root path, not excluded."""
    u, r = urlsplit(url), urlsplit(root_url)
    if u.scheme != r.scheme or u.netloc.lower() != r.netloc.lower():
        return False
    root_path = r.path if r.path.endswith("/") else r.path.rsplit("/", 1)[0] + "/"
    if not (u.path + "/").startswith(root_path):
        return False
    return not any(ex in u.path for ex in excludes)


def url_slug(url):
    u = urlsplit(url)
    path = u.path.strip("/") or "index"
    if path.endswith("/"):
        path += "index"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", path.replace("/", "__"))
    slug = re.sub(r"\.html?$", "", slug)
    return slug[:150] + "-" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]


# ---------------------------------------------------------------- HTML -> Markdown

class _MarkdownParser(HTMLParser):
    """A small, predictable HTML to Markdown converter.

    Keeps headings, paragraphs, lists, links, emphasis, code and tables. Drops script,
    style, nav, header, footer and aside. If the page has <main> or <article>, only that
    part is kept.
    """

    SKIP = {"script", "style", "noscript", "nav", "header", "footer", "aside", "template", "svg"}

    def __init__(self, base_url, scope_tags):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.scope_tags = scope_tags  # e.g. {"main", "article"} or empty = whole body
        self.out = []
        self.links = []
        self.title = ""
        self._in_title = False
        self._skip = 0
        self._scope = 0 if scope_tags else 1
        self._list = []  # stack of ("ul"|"ol", counter)
        self._pre = 0
        self._code = 0
        self._href = None
        self._link_text = []
        self._row = None
        self._cell = None
        self._table_rows = 0

    # -- helpers
    def _emit(self, s):
        if self._href is not None:  # an open link wins, even inside a table cell
            self._link_text.append(s)
        elif self._cell is not None:
            self._cell.append(s)
        else:
            self.out.append(s)

    def _newline(self, n=1):
        """Make sure the output ends with at least n newlines (looks at the tail only)."""
        if self._cell is not None:
            return
        trailing = 0
        for piece in reversed(self.out):
            stripped = piece.rstrip("\n")
            trailing += len(piece) - len(stripped)
            if stripped:
                break
        if trailing < n:
            self.out.append("\n" * (n - trailing))

    # -- tags
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._in_title = True
            return
        if tag in self.scope_tags:
            self._scope += 1
        if tag in self.SKIP:
            self._skip += 1
            return
        if tag == "a" and a.get("href"):
            href = urljoin(self.base_url, a["href"].strip())
            if href.split("#")[0]:
                self.links.append(href.split("#")[0])
        if self._skip or not self._scope:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._newline(2)
            self._emit("#" * int(tag[1]) + " ")
        elif tag == "p":
            self._newline(2)
        elif tag in ("ul", "ol"):
            self._newline(1)
            self._list.append([tag, 0])
        elif tag == "li":
            self._newline(1)
            depth = max(len(self._list) - 1, 0)
            if self._list and self._list[-1][0] == "ol":
                self._list[-1][1] += 1
                self._emit("  " * depth + "%d. " % self._list[-1][1])
            else:
                self._emit("  " * depth + "- ")
        elif tag == "pre":
            self._pre += 1
            if self._list:  # inside a list item: keep the item on one line
                self._emit(" `")
            else:
                self._newline(2)
                self._emit("```\n")
        elif tag == "code" and not self._pre:
            self._emit("`")
            self._code += 1
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "a" and a.get("href"):
            self._href = urljoin(self.base_url, a["href"].strip())
            self._link_text = []
        elif tag == "br":
            self._emit("\n")
        elif tag == "hr":
            self._newline(2)
            self._emit("---")
            self._newline(2)
        elif tag == "table":
            self._newline(2)
            self._table_rows = 0
        elif tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
        elif tag == "blockquote":
            self._newline(2)
            self._emit("> ")
        elif tag in ("div", "section", "article", "main", "dt", "dd", "figure", "figcaption"):
            self._newline(1)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
            return
        if tag in self.SKIP:
            self._skip = max(self._skip - 1, 0)
            return
        if tag in self.scope_tags:
            self._scope = max(self._scope - 1, 0)
            self._newline(1)
            return
        if self._skip or not self._scope:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote"):
            self._newline(2)
        elif tag in ("ul", "ol"):
            if self._list:
                self._list.pop()
            self._newline(2 if not self._list else 1)
        elif tag == "li":
            self._newline(1)
        elif tag == "pre":
            self._pre = max(self._pre - 1, 0)
            if self._list:
                self._emit("` ")
            else:
                self._newline(1)
                self._emit("```")
                self._newline(2)
        elif tag == "code" and not self._pre:
            self._code = max(self._code - 1, 0)
            self._emit("`")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "a" and self._href is not None:
            text = "".join(self._link_text).strip() or self._href
            href, self._href, self._link_text = self._href, None, []
            self._emit("[%s](%s)" % (text, href))
        elif tag in ("td", "th"):
            cell = " ".join("".join(self._cell).split())
            self._cell = None
            if self._row is not None:
                self._row.append(cell)
        elif tag == "tr":
            if self._row is not None:
                self.out.append("| " + " | ".join(self._row) + " |\n")
                if self._table_rows == 0:
                    self.out.append("|" + " --- |" * len(self._row) + "\n")
                self._table_rows += 1
            self._row = None
        elif tag == "table":
            self._newline(2)

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self._skip or not self._scope:
            return
        if self._pre:
            self._emit(" ".join(data.split()) if self._list else data)
        else:
            text = re.sub(r"\s+", " ", data)
            if text.strip() or (self.out and not self.out[-1].endswith("\n")):
                self._emit(text if text.strip() else " ")

    def result(self):
        text = "".join(self.out)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip() + "\n"


def html_to_markdown(html_text, base_url):
    """Return (title, markdown, links)."""
    lowered = html_text.lower()
    scope = set()
    if "<main" in lowered:
        scope.add("main")
    elif "<article" in lowered:
        scope.add("article")
    p = _MarkdownParser(base_url, scope)
    p.feed(html_text)
    p.close()
    title = " ".join(html.unescape(p.title).split())
    md = p.result()
    if not title:
        m = re.search(r"^# (.+)$", md, re.M)
        title = m.group(1).strip() if m else base_url
    return title, md, p.links


# ---------------------------------------------------------------- front matter

def front_matter(fields):
    lines = ["---"]
    for k, v in fields.items():
        if v is None:
            continue
        s = str(v)
        if any(c in s for c in ":#\"'\n") or s != s.strip():
            s = json.dumps(s, ensure_ascii=False)
        lines.append("%s: %s" % (k, s))
    lines.append("---")
    return "\n".join(lines) + "\n"


def split_front_matter(text):
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fields = {}
    for line in text[4:end].splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            v = v.strip()
            if v.startswith('"'):
                try:
                    v = json.loads(v)
                except ValueError:
                    pass
            fields[k.strip()] = v
    return fields, text[end + 5:]


def page_body(text):
    """Strip the front matter of a cached page and return its Markdown body."""
    return split_front_matter(text)[1]
