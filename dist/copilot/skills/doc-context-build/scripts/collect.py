#!/usr/bin/env python3
"""Step 1 - collect: crawl a documentation site tree into a local page cache.

Usage:
    python3 collect.py <project-dir | docctx.json> [--out <dir>] [--dry-run] [--max-pages N]

Starts at root_url, follows links that stay on the same host under the root path (depth
<= max_depth, paths containing an `exclude` entry skipped) and stores each page as
Markdown under <out>/cache/pages/ with a front matter (source_url, title, retrieved_at,
content_hash, parent_url, depth). External links are recorded, never fetched.

Freshness: a page already cached is requested conditionally (If-None-Match /
If-Modified-Since). A 304 or an unchanged content hash keeps the old file and only
updates checked_at. Pages that disappeared are moved to cache/_removed/. The run writes
cache/changes.md (added / changed / removed) and index.json keeps the same lists under
last_run so bundle.py can report which bundles and guidelines are affected.

--dry-run fetches and compares but writes nothing: a cheap staleness check.

The access token is read from the environment variable named by `token_env` (default
DOC_SITE_TOKEN) and sent as `auth_header` ("Authorization: Bearer {token}" by default).
It is never written to any file and never printed. Standard library only, Python 3.8+.
"""

import argparse
import os
import shutil
import sys
import urllib.error
import urllib.request
from collections import deque
from urllib.parse import urlsplit

sys.dont_write_bytecode = True  # no __pycache__ next to the skill sources
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docctx_lib import (Project, die, front_matter, html_to_markdown, in_scope, normalize_url,  # noqa: E402
                        now_iso, sha256_text, url_slug, write_json, write_text)

GONE = (404, 410)  # the page no longer exists; anything else is a failure that keeps the cache


class _InScopeRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only when it stays inside the crawl scope.

    urllib would otherwise resend every header, including Authorization, to whatever host
    the site redirects to (an SSO login page on another domain, for example), and would
    then hand that login page back as if it were the document.
    """

    def __init__(self, root, excludes):
        self.root, self.excludes = root, excludes

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not in_scope(normalize_url(newurl), self.root, self.excludes):
            raise urllib.error.HTTPError(req.full_url, code, "redirect out of scope: " + newurl, headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_opener(cfg, root, excludes):
    token = os.environ.get(cfg["token_env"], "")
    headers = {"User-Agent": cfg["user_agent"], "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"}
    if token:
        name, _, value = cfg["auth_header"].partition(":")
        headers[name.strip()] = value.strip().replace("{token}", token)
    opener = urllib.request.build_opener(_InScopeRedirects(root, excludes))
    return opener, headers, bool(token)


def fetch(opener, url, headers, cached, timeout):
    """Return (status, body_text, etag, last_modified).

    status: int HTTP status (304 = unchanged), "skip" for non-HTML (body = content type),
    "error" for a network problem (body = reason).
    """
    h = dict(headers)
    if cached:
        if cached.get("etag"):
            h["If-None-Match"] = cached["etag"]
        if cached.get("last_modified"):
            h["If-Modified-Since"] = cached["last_modified"]
    req = urllib.request.Request(url, headers=h)
    try:
        with opener.open(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype and "xml" not in ctype and ctype:
                return "skip", ctype, None, None
            raw = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.status, raw.decode(charset, errors="replace"), resp.headers.get("ETag"), resp.headers.get("Last-Modified")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, "", (cached or {}).get("etag"), (cached or {}).get("last_modified")
        return e.code, (e.msg if 300 <= e.code < 400 else ""), None, None
    except (urllib.error.URLError, OSError) as e:
        return "error", str(e.reason if hasattr(e, "reason") else e), None, None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("project")
    ap.add_argument("--out", help="output directory (default: out_dir in docctx.json)")
    ap.add_argument("--dry-run", action="store_true", help="fetch and compare, write nothing")
    ap.add_argument("--max-pages", type=int, help="safety cap (default: max_pages in docctx.json)")
    args = ap.parse_args(argv)

    prj = Project(args.project)
    if args.out:
        prj.set_out_dir(args.out)
    cfg = prj.cfg
    root = normalize_url(cfg["root_url"])
    excludes = list(cfg["exclude"])
    max_pages = args.max_pages or cfg["max_pages"]
    opener, headers, has_token = build_opener(cfg, root, excludes)
    if not has_token:
        print("note: %s is not set; requesting without credentials" % cfg["token_env"])

    index = prj.load_index()
    old_pages = index.get("pages", {})
    new_pages = {}
    added, changed, removed, unchanged, failed, skipped, kept = [], [], [], [], [], [], []
    external = set()
    run_at = now_iso()

    queue = deque([(root, 0, None)])
    seen = {root}
    order = 0
    while queue:
        url, depth, parent = queue.popleft()
        if len(new_pages) >= max_pages:
            print("warning: max_pages=%d reached; stopping" % max_pages)
            break
        cached = old_pages.get(url)
        status, body, etag, last_mod = fetch(opener, url, headers, cached, cfg["timeout_sec"])
        if status == "skip":
            skipped.append((url, body))
            continue
        if status == 304 and not cached:
            status, body = "error", "304 without a cached copy"
        # Any 3xx that reaches here is a redirect the handler refused (out of scope); 304 is fine.
        if status == "error" or (isinstance(status, int) and status >= 300 and status != 304):
            reason = body if status == "error" else ("%s %s" % (status, body)).strip()
            if url == root:
                die("root_url could not be fetched (%s). Check the URL and the %s environment variable." % (reason, cfg["token_env"]), 1)
            if status in GONE or not cached:
                failed.append((url, reason))
                continue
            # A transient failure must not look like a removal: keep the cached copy and
            # keep crawling through its known links.
            entry = dict(cached)
            entry.update({"checked_at": run_at, "last_error": reason, "depth": depth, "parent_url": parent, "order": order})
            new_pages[url] = entry
            kept.append((url, reason))
        elif status == 304:
            entry = dict(cached)
            entry.pop("last_error", None)
            entry.update({"checked_at": run_at, "depth": depth, "parent_url": parent, "order": order})
            new_pages[url] = entry
            unchanged.append(url)
        else:
            title, md, links = html_to_markdown(body, url)
            links = [normalize_url(l) for l in links]
            content_hash = sha256_text(md)
            entry = {
                "file": "pages/" + url_slug(url) + ".md", "title": title, "content_hash": content_hash,
                "retrieved_at": run_at, "checked_at": run_at, "etag": etag, "last_modified": last_mod,
                "depth": depth, "parent_url": parent, "order": order,
                "links": sorted({l for l in links if in_scope(l, root, excludes)}),
                "external_links": sorted({l for l in links if urlsplit(l).netloc.lower() != urlsplit(root).netloc.lower()}),
            }
            if cached and cached.get("content_hash") == content_hash:
                entry["retrieved_at"] = cached.get("retrieved_at", run_at)
                entry["file"] = cached.get("file", entry["file"])
                unchanged.append(url)
            else:
                (changed if cached else added).append(url)
                if not args.dry_run:
                    fm = front_matter({
                        "source_url": url, "title": title, "retrieved_at": run_at, "content_hash": content_hash,
                        "parent_url": parent, "depth": depth,
                    })
                    write_text(os.path.join(prj.cache_dir, entry["file"]), fm + "\n" + md)
            new_pages[url] = entry
        order += 1
        external.update(entry.get("external_links", []))
        if depth < cfg["max_depth"]:
            for link in entry.get("links", []):
                if link not in seen and in_scope(link, root, excludes):
                    seen.add(link)
                    queue.append((link, depth + 1, url))

    for url, entry in old_pages.items():
        if url not in new_pages:
            removed.append(url)
            src = os.path.join(prj.cache_dir, entry.get("file", ""))
            if not args.dry_run and os.path.exists(src):
                os.makedirs(prj.removed_dir, exist_ok=True)
                shutil.move(src, os.path.join(prj.removed_dir, os.path.basename(src)))

    report = ["# 収集レポート (%s)" % run_at, "", "- root: %s" % root,
              "- 取得 %d ページ: 追加 %d / 変更 %d / 不変 %d / 削除 %d / 失敗(キャッシュ維持) %d / 失敗 %d / 非HTML %d" % (
                  len(new_pages), len(added), len(changed), len(unchanged), len(removed), len(kept), len(failed), len(skipped)),
              "- 外部リンク(取得しない): %d" % len(external), ""]
    for label, items in (("追加", added), ("変更", changed), ("削除", removed)):
        if items:
            report += ["## %s" % label, ""] + ["- %s" % u for u in items] + [""]
    if kept:
        report += ["## 失敗(前回のキャッシュを維持)", ""] + ["- %s (%s)" % (u, s) for u, s in kept] + [""]
    if failed:
        report += ["## 失敗", ""] + ["- %s (%s)" % (u, s) for u, s in failed] + [""]
    if skipped:
        report += ["## 非HTML(記録のみ)", ""] + ["- %s (%s)" % (u, c) for u, c in skipped] + [""]
    if external:
        report += ["## 外部リンク", ""] + ["- %s" % u for u in sorted(external)] + [""]
    text = "\n".join(report)

    if args.dry_run:
        print(text)
        print("dry-run: nothing written. %s" % ("changes detected" if (added or changed or removed) else "cache is current"))
        return 3 if (added or changed or removed) else 0

    index = {"root_url": root, "collected_at": run_at, "pages": new_pages,
             "last_run": {"at": run_at, "added": added, "changed": changed, "removed": removed}}
    write_json(prj.index_path, index)
    write_text(os.path.join(prj.cache_dir, "changes.md"), text)
    print(text)
    print("INDEX: %s" % prj.index_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
