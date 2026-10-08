#!/usr/bin/env python3
"""Extract the text of training material with source locations.

Usage:
    python3 extract_text.py <file.docx|.pptx|.txt|.md> [--out material.txt]

.docx: one line per paragraph, prefixed with [段落N]; headings are marked [見出し].
.pptx: === スライド N === blocks in presentation order (hidden slides marked), followed by
       the speaker notes as [ノート].
.txt / .md: passed through with [行N] prefixes.
.pdf and other formats are not handled (exit 3): the agent reads them itself.

Every line carries its location so that each quiz question can cite where its answer is.
Exit codes: 0 success, 2 unreadable input, 3 format the script does not handle.
Python 3.8+, standard library only.
"""

import argparse
import os
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
MAX_XML_BYTES = 64 * 1024 * 1024
HEADING_RE = re.compile(r"^(heading|title|subtitle|見出し|表題)", re.I)


class InputError(Exception):
    pass


class Unsupported(Exception):
    pass


def read_xml(z, name):
    info = z.getinfo(name)
    if info.file_size > MAX_XML_BYTES:
        raise InputError("%s が大きすぎます (%d bytes)" % (name, info.file_size))
    try:
        return ET.fromstring(z.read(info))
    except ET.ParseError as e:
        raise InputError("%s を解析できません (%s)" % (name, e))


def open_zip(path, kind):
    try:
        return zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise InputError("%s として読めません: %s (%s)" % (kind, path, e))


def docx_lines(path):
    with open_zip(path, "Word (.docx)") as z:
        try:
            root = read_xml(z, "word/document.xml")
        except KeyError:
            raise InputError("word/document.xml がありません。Word 文書ではないようです: %s" % path)
        # Japanese Word stores "見出し 1" under styleId "1"; the style name ("heading 1") is reliable.
        headings = set()
        if "word/styles.xml" in z.namelist():
            for st in read_xml(z, "word/styles.xml").iter(W + "style"):
                name = st.find(W + "name")
                label = name.get(W + "val", "") if name is not None else ""
                if HEADING_RE.match(label) or HEADING_RE.match(st.get(W + "styleId", "")):
                    headings.add(st.get(W + "styleId", ""))
    out = []

    def collect(el, buf):
        for c in el:
            if c.tag == MC_FALLBACK or c.tag == W + "p":
                continue
            if c.tag == W + "t":
                buf.append(c.text or "")
            elif c.tag == W + "tab":
                buf.append("\t")
            elif c.tag in (W + "br", W + "cr"):
                buf.append(" ")
            else:
                collect(c, buf)

    n = [0]

    def visit(el):
        for c in el:
            if c.tag == MC_FALLBACK:
                continue
            if c.tag == W + "p":
                n[0] += 1
                buf = []
                collect(c, buf)
                text = "".join(buf).strip()
                if text:
                    style = c.find("%spPr/%spStyle" % (W, W))
                    sid = style.get(W + "val", "") if style is not None else ""
                    outline = c.find("%spPr/%soutlineLvl" % (W, W))
                    mark = "[見出し] " if (sid in headings or HEADING_RE.match(sid) or outline is not None) else ""
                    out.append("[段落%d] %s%s" % (n[0], mark, text))
            visit(c)
    visit(root)
    return out


def rels(z, part):
    """Relationship id -> absolute part name for one package part."""
    d, f = posixpath.split(part)
    name = posixpath.join(d, "_rels", f + ".rels")
    if name not in z.namelist():
        return {}
    out = {}
    for r in read_xml(z, name).iter(PR + "Relationship"):
        if r.get("TargetMode") == "External":
            continue
        target = r.get("Target", "")
        full = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(d, target))
        out[r.get("Id")] = (full, r.get("Type", ""))
    return out


def shape_paragraphs(root):
    lines = []
    for para in root.iter(A + "p"):
        text = "".join(t.text or "" for t in para.iter(A + "t")).strip()
        if text:
            lines.append(text)
    return lines


def pptx_lines(path):
    with open_zip(path, "PowerPoint (.pptx)") as z:
        names = set(z.namelist())
        if "ppt/presentation.xml" not in names:
            raise InputError("ppt/presentation.xml がありません。PowerPoint ファイルではないようです: %s" % path)
        pres_rels = rels(z, "ppt/presentation.xml")
        order = []
        for sid in read_xml(z, "ppt/presentation.xml").iter(P + "sldId"):
            target = pres_rels.get(sid.get(R + "id"))
            if target and target[0] in names:
                order.append(target[0])
        if not order:  # no slide list: fall back to the file numbering
            order = sorted((n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                           key=lambda n: int(re.findall(r"\d+", n)[-1]))
        out = []
        for i, part in enumerate(order, 1):
            root = read_xml(z, part)
            hidden = " (非表示スライド)" if root.get("show") == "0" else ""
            out.append("=== スライド %d%s ===" % (i, hidden))
            body = shape_paragraphs(root)
            out.extend(body if body else ["(テキストなし)"])
            for full, typ in rels(z, part).values():
                if typ.endswith("/notesSlide") and full in names:
                    notes = [t for t in shape_paragraphs(read_xml(z, full)) if not re.fullmatch(r"\d+", t)]
                    for t in notes:
                        out.append("[ノート] %s" % t)
        return out


def text_lines(path):
    with open(path, "rb") as f:
        data = f.read()
    for enc in ("utf-8-sig", "cp932"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise InputError("文字コードを判別できません(UTF-8 か Shift_JIS で保存してください): %s" % path)
    return ["[行%d] %s" % (i, l) for i, l in enumerate(text.splitlines(), 1) if l.strip()]


def extract(path):
    if not os.path.isfile(path):
        raise InputError("ファイルが見つかりません: %s" % path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        return docx_lines(path)
    if ext == ".pptx":
        return pptx_lines(path)
    if ext in (".txt", ".md", ".markdown", ".text"):
        return text_lines(path)
    if ext in (".doc", ".ppt"):
        raise Unsupported("古い Office 形式 (%s) は読めません。.docx / .pptx で保存し直してください。" % ext)
    raise Unsupported("この形式 (%s) はスクリプトでは扱いません。PDF などはエージェントが直接読んでください。" % (ext or "拡張子なし"))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Extract training material text with locations.")
    ap.add_argument("file")
    ap.add_argument("--out", help="write the text here and print only a summary")
    args = ap.parse_args(argv)
    try:
        lines = extract(args.file)
    except InputError as e:
        print("エラー: %s" % e, file=sys.stderr)
        return 2
    except Unsupported as e:
        print("未対応: %s" % e, file=sys.stderr)
        return 3
    text = "\n".join(lines) + "\n"
    if not any(l and not l.startswith("===") and l != "(テキストなし)" for l in lines):
        print("エラー: テキストが見つかりません(画像だけの資料かもしれません): %s" % args.file, file=sys.stderr)
        return 2
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        slides = sum(1 for l in lines if l.startswith("=== スライド"))
        unit = "スライド %d枚" % slides if slides else "%d行" % len(lines)
        print("抽出しました: %s (%s, %d文字)" % (os.path.abspath(args.out), unit, len(text)))
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
