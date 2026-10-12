#!/usr/bin/env python3
"""Step 2 - bundle: group cached pages into one Markdown file per context.

Usage:
    python3 bundle.py <project-dir | docctx.json> [--out <dir>] [--only <bundle,...>]

manifest.json decides which pages go where:

    {
      "bundles": {
        "packaging": {"title": "パッケージ作成", "include": ["/docs/packaging/"], "exclude": ["/draft/"],
                      "pages": ["https://.../docs/env/setup.html"]}
      },
      "guidelines": {
        "package-guide": {"title": "パッケージ作成ガイドライン", "bundle": "packaging", "category": "dev"}
      }
    }

`include` entries are URL path prefixes (or full URLs); `pages` adds single pages; `exclude`
removes by substring. Pages keep the crawl order (tree order). Each bundle starts with a
front matter and a list of its sources (URL + retrieved_at), and every page is preceded by
a `<!-- docctx:page URL -->` marker that compose.py uses as a split boundary.

Also writes bundles/impact.md: which bundles and guidelines are touched by the pages that
the last collect run added, changed or removed. Standard library only, Python 3.8+.
"""

import argparse
import os
import sys
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docctx_lib import PAGE_MARK, Project, die, front_matter, page_body, read_text, write_text  # noqa: E402


def select(pages, spec):
    inc = spec.get("include", [])
    exc = spec.get("exclude", [])
    single = set(spec.get("pages", []))
    chosen = []
    for url, e in pages.items():
        path = urlsplit(url).path
        hit = url in single or any(url.startswith(p) if p.startswith("http") else path.startswith(p) for p in inc)
        if hit and not any(x in url for x in exc):
            chosen.append((e.get("order", 0), url, e))
    chosen.sort()
    return chosen


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("project")
    ap.add_argument("--out")
    ap.add_argument("--only", help="comma-separated bundle names")
    args = ap.parse_args(argv)

    prj = Project(args.project)
    if args.out:
        prj.set_out_dir(args.out)
    index = prj.load_index()
    pages = index.get("pages", {})
    if not pages:
        die("cache is empty - run collect.py first (%s)" % prj.index_path, 1)
    manifest = prj.load_manifest()
    only = set(args.only.split(",")) if args.only else None
    warn_chars = prj.cfg["bundle_warn_chars"]

    membership = {}  # url -> [bundle]
    for name, spec in manifest["bundles"].items():
        if only and name not in only:
            continue
        chosen = select(pages, spec)
        if not chosen:
            die("bundle '%s' selected no pages - check include/pages in %s" % (name, prj.manifest_path), 1)
        parts, sources = [], []
        oldest = min(e.get("retrieved_at", "") for _, _, e in chosen)
        for _, url, e in chosen:
            membership.setdefault(url, []).append(name)
            sources.append("- [%s](%s) (取得: %s)" % (e.get("title", url), url, e.get("retrieved_at", "?")))
            body = page_body(read_text(os.path.join(prj.cache_dir, e["file"])))
            parts.append(PAGE_MARK.format(url=url) + "\n" + body.rstrip() + "\n")
        fm = front_matter({"bundle": name, "title": spec.get("title", name), "built_at": index.get("collected_at"),
                           "oldest_retrieved_at": oldest, "pages": len(chosen)})
        text = (fm + "\n# 束: %s\n\n## 含めたページ\n\n%s\n\n%s" % (spec.get("title", name), "\n".join(sources), "\n".join(parts)))
        out = os.path.join(prj.bundles_dir, name + ".md")
        write_text(out, text)
        note = "  (warning: %d chars > %d; consider splitting the context in manifest)" % (len(text), warn_chars) if len(text) > warn_chars else ""
        print("bundle %-20s %3d pages %7d chars -> %s%s" % (name, len(chosen), len(text), out, note))

    last = index.get("last_run", {})
    touched = {u: k for k in ("added", "changed", "removed") for u in last.get(k, [])}
    by_bundle = {}
    for url, kind in touched.items():
        for b in membership.get(url, []):
            by_bundle.setdefault(b, []).append("%s (%s)" % (url, kind))
    lines = ["# 影響レポート (収集 %s)" % last.get("at", "?"), ""]
    if not touched:
        lines.append("前回の収集で追加・変更・削除されたページはありません。")
    elif not by_bundle:
        lines.append("変更されたページはありますが、どの束にも含まれていません。")
    else:
        for b, urls in sorted(by_bundle.items()):
            gls = [g for g, spec in manifest["guidelines"].items() if spec.get("bundle") == b]
            lines += ["## 束 %s" % b, "", "影響するガイドライン: %s" % (", ".join(gls) or "(なし)"), ""] + ["- %s" % u for u in urls] + [""]
    write_text(os.path.join(prj.bundles_dir, "impact.md"), "\n".join(lines) + "\n")
    print("IMPACT: %s%s" % (os.path.join(prj.bundles_dir, "impact.md"), "  (changes affect %d bundle(s))" % len(by_bundle) if by_bundle else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
