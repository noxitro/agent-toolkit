#!/usr/bin/env python3
"""Step 3 - compose: put the writing rules around a bundle and produce the file(s) to
attach to the Microsoft 365 Copilot agent.

Usage:
    python3 compose.py <project-dir | docctx.json> [--out <dir>] [--only <guideline,...>] [--strict]

For each guideline in manifest.json:

    header (what this is, N / M, retrieval dates)
    rules/common.md                 required
    rules/<category>.md             optional
    rules/<guideline>.md            optional
    bundles/<bundle>.md             the sources
    rules/output-contract.md        required - stays at the very end

If the result is longer than split_chars (default 30,000), it is split at page boundaries
into <guideline>.part1.md ... partN.md: rules stay in part 1, the output contract in the
last part, and every part starts with the same header saying "N / M - attach all parts in
one message before asking for the document". A single page longer than the limit is split
at its headings.

Freshness: if the bundle's oldest page is older than stale_days, a warning is printed
(and the context header says so); with --strict the guideline is skipped and the exit
code is 1. Standard library only, Python 3.8+.
"""

import argparse
import datetime as dt
import os
import re
import sys

sys.dont_write_bytecode = True  # no __pycache__ next to the skill sources
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docctx_lib import (PAGE_MARK_RE, Project, die, now_iso, parse_iso, read_text,  # noqa: E402
                        split_front_matter, write_json, write_text)


def load_rule(prj, name, required=False):
    path = os.path.join(prj.rules_dir, name + ".md")
    if os.path.exists(path):
        return read_text(path).strip() + "\n"
    if required:
        die("required rule file missing: " + path, 1)
    return ""


def split_pages(bundle_body):
    """Return [(url, text)] from a bundle body using the page markers."""
    pieces = PAGE_MARK_RE.split(bundle_body)
    # pieces = [preamble, url1, text1, url2, text2, ...]
    out = [("", pieces[0])] if pieces[0].strip() else []
    for i in range(1, len(pieces), 2):
        out.append((pieces[i], pieces[i + 1]))
    return out


def chunk_text(text, limit):
    """Split one over-long page at headings, then paragraphs."""
    if len(text) <= limit:
        return [text]
    chunks, cur = [], ""
    for block in re.split(r"(?=^#{1,6} )", text, flags=re.M):
        if len(cur) + len(block) > limit and cur:
            chunks.append(cur)
            cur = ""
        while len(block) > limit:
            cut = block.rfind("\n\n", 0, limit)
            cut = cut if cut > 0 else limit
            chunks.append(cur + block[:cut])
            cur, block = "", block[cut:].lstrip("\n")
        cur += block
    if cur:
        chunks.append(cur)
    return chunks


def header(gl_name, spec, bundle_fm, n, total, stale_note):
    lines = ["<!-- docctx:context %s part %d/%d -->" % (gl_name, n, total),
             "# コンテキスト: %s(%d / %d)" % (spec.get("title", gl_name), n, total), ""]
    if total > 1:
        lines += ["**このファイルは %d 本に分かれています。%d 本すべてを 1 回のメッセージに添付してから、ガイドラインの執筆を依頼してください。**" % (total, total),
                  "執筆ルールは 1 本目、出力契約と自己検査は %d 本目の末尾にあります。" % total, ""]
    lines += ["- 束: %s(%s ページ、最も古い取得: %s、束の作成: %s)" % (
        bundle_fm.get("title", spec.get("bundle")), bundle_fm.get("pages", "?"), bundle_fm.get("oldest_retrieved_at", "?"), bundle_fm.get("built_at", "?")),
              "- 合成: %s" % now_iso()]
    if stale_note:
        lines.append("- **注意: %s**" % stale_note)
    return "\n".join(lines) + "\n\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("project")
    ap.add_argument("--out")
    ap.add_argument("--only", help="comma-separated guideline names")
    ap.add_argument("--strict", action="store_true", help="skip stale bundles and exit 1")
    ap.add_argument("--split-chars", type=int, help="override split_chars from docctx.json")
    args = ap.parse_args(argv)

    prj = Project(args.project)
    if args.out:
        prj.set_out_dir(args.out)
    manifest = prj.load_manifest()
    only = set(args.only.split(",")) if args.only else None
    limit = args.split_chars or prj.cfg["split_chars"]
    stale_days = prj.cfg["stale_days"]
    common = load_rule(prj, "common", required=True)
    contract = load_rule(prj, "output-contract", required=True)
    rc = 0

    for gl, spec in manifest["guidelines"].items():
        if only and gl not in only:
            continue
        bpath = os.path.join(prj.bundles_dir, spec.get("bundle", "") + ".md")
        if not os.path.exists(bpath):
            die("bundle for guideline '%s' not found: %s (run bundle.py)" % (gl, bpath), 1)
        bfm, bbody = split_front_matter(read_text(bpath))
        oldest = parse_iso(bfm.get("oldest_retrieved_at"))
        stale_note = ""
        if oldest and (dt.datetime.now(dt.timezone.utc) - oldest).days > stale_days:
            stale_note = "束の最も古いページは %d 日前の取得です(しきい値 %d 日)。collect.py で再収集してください。" % (
                (dt.datetime.now(dt.timezone.utc) - oldest).days, stale_days)
            print("warning: %s - %s" % (gl, stale_note))
            if args.strict:
                print("strict: skipping %s" % gl)
                rc = 1
                continue

        rules = "## 執筆ルール(共通)\n\n" + common
        cat = load_rule(prj, spec["category"]) if spec.get("category") else ""
        if cat:
            rules += "\n## 執筆ルール(カテゴリ: %s)\n\n" % spec["category"] + cat
        own = load_rule(prj, gl)
        if own:
            rules += "\n## 執筆ルール(このガイドライン)\n\n" + own
        rules += "\n"
        tail = "\n---\n\n## 出力契約と自己検査\n\n" + contract

        # Pieces that may be distributed over parts: rules first, then pages, contract last.
        pieces = [rules]
        for url, text in split_pages(bbody):
            prefix = ("\n---\n\n<!-- 元ページ: %s -->\n\n" % url) if url else "\n"
            for c in chunk_text(text.strip("\n") + "\n", limit):
                pieces.append(prefix + c)
                prefix = "\n<!-- 元ページ(続き): %s -->\n\n" % url
        pieces.append(tail)

        # Greedy packing at piece boundaries; the header is added afterwards (~600 chars).
        parts, cur = [], ""
        for p in pieces:
            if cur and len(cur) + len(p) > limit:
                parts.append(cur)
                cur = ""
            cur += p
        parts.append(cur)

        total = len(parts)
        written = []
        for i, body in enumerate(parts, 1):
            name = gl + (".md" if total == 1 else ".part%d.md" % i)
            path = os.path.join(prj.context_dir, name)
            write_text(path, header(gl, spec, bfm, i, total, stale_note) + re.sub(r"\n{3,}", "\n\n", body.lstrip("\n")))
            written.append(path)
        sources = re.findall(r"^- \[.*\]\((\S+)\) \(取得: (\S+)\)$", bbody, re.M)
        write_json(os.path.join(prj.context_dir, gl + ".sources.json"), {
            "guideline": gl, "bundle": spec.get("bundle"), "composed_at": now_iso(), "parts": [os.path.basename(w) for w in written],
            "stale": bool(stale_note), "sources": [{"url": u, "retrieved_at": t} for u, t in sources]})
        print("context %-20s %d part(s), %d chars total -> %s" % (gl, total, sum(len(p) for p in parts), prj.context_dir))
        for w in written:
            print("  " + w)
    return rc


if __name__ == "__main__":
    sys.exit(main())
