#!/usr/bin/env python3
"""Check a Japanese business document against the style rules.

Usage:
    python3 style_check.py <file.txt|.md|.docx> [--rules resources/style-rules.json]
                           [--out report.md] [--csv report.csv] [--json]

Checks (each can be switched off in the rules file): 表記ゆれ, 冗長表現・二重否定, 禁止語,
全角英数字, 半角カナ, です・ます調とだ・である調の混在, 長い文, 読点の多い文, 句読点の重複,
括弧の対応. The script only reports; it never rewrites the document.

Output: a Markdown report (行:位置 / 種別 / 該当箇所 / 提案) on stdout or in --out, and a
CSV (UTF-8 with BOM so that Excel opens it) with --csv. For .docx, 行 is the paragraph
number counted from the top of the body, empty paragraphs included.

Exit codes: 0 checked (with or without findings), 2 unreadable input or rules.
Python 3.8+, standard library only.
"""

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
MAX_XML_BYTES = 64 * 1024 * 1024
DEFAULT_RULES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "style-rules.json")

PAIRS = {"「": "」", "『": "』", "（": "）", "(": ")", "【": "】", "［": "］", "[": "]",
         "〔": "〕", "｛": "｝", "{": "}", "〈": "〉", "《": "》", "“": "”"}
CLOSERS = {v: k for k, v in PAIRS.items()}
QUOTE_OPEN = {"「": "」", "『": "』"}
ENDERS = "。！？!?"
TRAILERS = "」』）)】"
# "1) 項目" / "a）" / "①)" at the start of a line: an enumerator, not an unmatched bracket.
ENUM_RE = re.compile(r"^\s*[0-9０-９a-zA-Zａ-ｚＡ-Ｚ①-⑳ア-ンｱ-ﾝ]{1,3}[)）]")
ZENKAKU_RE = re.compile(r"[Ａ-Ｚａ-ｚ０-９]+")
HANKAKU_KANA_RE = re.compile(r"[\uff61-\uff9f]+")
DUP_PUNCT_RE = re.compile(r"(、、+|。。+|，，+|．．+)")
MASU_END = ("ます", "ません", "ました", "ませんでした", "ましょう", "です", "でした", "でしょう", "ください", "下さい", "ございます")
DA_END = ("だ", "である", "だった", "であった", "だろう", "であろう", "ではない", "でない", "じゃない",
          "する", "した", "している", "していた", "される", "された", "できる", "できない",
          "ない", "なかった", "ある", "あった", "いる", "いた", "なる", "なった", "思う", "考える")
MASU, DA = "です・ます調", "だ・である調"
CHECK_NAMES = ("variants", "zenkaku_alnum", "hankaku_kana", "style_mix", "sentence_length", "commas",
               "duplicate_punctuation", "brackets", "redundant", "forbidden")


class InputError(Exception):
    pass


def read_text_file(path):
    with open(path, "rb") as f:
        data = f.read()
    for enc in ("utf-8-sig", "cp932"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise InputError("文字コードを判別できません(UTF-8 か Shift_JIS で保存してください): %s" % path)


def docx_paragraphs(path):
    try:
        with zipfile.ZipFile(path) as z:
            info = z.getinfo("word/document.xml")
            if info.file_size > MAX_XML_BYTES:
                raise InputError("word/document.xml が大きすぎます (%d bytes)" % info.file_size)
            root = ET.fromstring(z.read(info))
    except (zipfile.BadZipFile, KeyError) as e:
        raise InputError("Word (.docx) として読めません: %s (%s)" % (path, e))
    except ET.ParseError as e:
        raise InputError("Word の本文 XML を解析できません: %s (%s)" % (path, e))
    out = []

    def para_text(p, buf):
        for c in p:
            if c.tag == MC_FALLBACK or c.tag == W + "p":
                continue
            if c.tag == W + "t":
                buf.append(c.text or "")
            elif c.tag == W + "tab":
                buf.append("\t")
            elif c.tag in (W + "br", W + "cr"):
                buf.append(" ")
            else:
                para_text(c, buf)

    def visit(el):
        for c in el:
            if c.tag == MC_FALLBACK:
                continue
            if c.tag == W + "p":
                buf = []
                para_text(c, buf)
                out.append("".join(buf))
            visit(c)
    visit(root)
    return out


def load_lines(path):
    if not os.path.isfile(path):
        raise InputError("ファイルが見つかりません: %s" % path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        return docx_paragraphs(path), "docx"
    if ext in (".txt", ".md", ".markdown", ".text"):
        return read_text_file(path).replace("\r\n", "\n").replace("\r", "\n").split("\n"), ("md" if ext in (".md", ".markdown") else "txt")
    if ext == ".doc":
        raise InputError("古い Word 形式 (.doc) は読めません。.docx で保存し直してください。")
    raise InputError("未対応の形式です (%s)。.docx / .txt / .md を添付してください。" % (ext or "拡張子なし"))


def load_rules(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            rules = json.load(f)
    except (OSError, ValueError) as e:
        raise InputError("ルールファイルを読めません: %s (%s)" % (path, e))
    if not isinstance(rules, dict):
        raise InputError("ルールファイルの最上位は {} にしてください: %s" % path)
    checks = dict((k, True) for k in CHECK_NAMES)
    checks.update(rules.get("checks") or {})
    compiled = {}
    for group in ("variants", "redundant", "forbidden"):
        items = []
        for n, r in enumerate(rules.get(group) or []):
            if not isinstance(r, dict) or not r.get("pattern"):
                raise InputError("%s の %d 番目に pattern がありません" % (group, n + 1))
            try:
                rx = re.compile(r["pattern"] if r.get("regex") else re.escape(r["pattern"]))
            except re.error as e:
                raise InputError("%s の %d 番目の正規表現が不正です: %s (%s)" % (group, n + 1, r["pattern"], e))
            items.append((rx, r))
        compiled[group] = items
    try:
        limits = {"sentence": int(rules.get("max_sentence_chars", 80)),
                  "commas": int(rules.get("max_commas_per_sentence", 4)),
                  "findings": int(rules.get("max_findings", 300))}
    except (TypeError, ValueError) as e:
        raise InputError("数値の設定が不正です: %s" % e)
    return checks, compiled, limits


def snippet(line, s, e, md=True, width=10):
    pre = line[max(0, s - width):s]
    post = line[e:e + width]
    pre = ("…" if s - width > 0 else "") + pre
    post = post + ("…" if e + width < len(line) else "")
    hit = line[s:e]
    return pre + ("**%s**" % hit if md else "【%s】" % hit) + post, hit


def head(text, n=40):
    text = text.strip()
    return text if len(text) <= n else text[:n] + "…"


def sentences(line):
    """Split one line into (start, end) spans; 。 inside 「」『』 does not end a sentence."""
    spans, start, depth, i, n = [], 0, 0, 0, len(line)
    while i < n:
        ch = line[i]
        if ch in QUOTE_OPEN:
            depth += 1
        elif ch in ("」", "』") and depth > 0:
            depth -= 1
        elif ch in ENDERS and depth == 0:
            j = i + 1
            while j < n and (line[j] in ENDERS or line[j] in TRAILERS):
                j += 1
            spans.append((start, j))
            start, i = j, j
            continue
        i += 1
    if line[start:].strip():
        spans.append((start, n))
    return [(s, e) for s, e in spans if line[s:e].strip()]


def classify(sentence):
    body = sentence.strip().rstrip(ENDERS + TRAILERS + "　 ").rstrip("ねよ")
    if not body:
        return None
    for end in MASU_END:
        if body.endswith(end):
            return MASU
    for end in DA_END:
        if body.endswith(end):
            return DA
    return None


def blank_inline_code(line):
    return re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)


def check(lines, kind, checks, compiled, limits):
    findings = []
    styled = []

    def add(ln, col, typ, text, ctx, suggest):
        findings.append({"line": ln, "col": col, "type": typ, "text": text, "context": ctx, "suggest": suggest})

    in_fence = False
    for ln, raw in enumerate(lines, 1):
        line = raw
        stripped = line.strip()
        prose = True
        if kind == "md":
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            line = blank_inline_code(line)
            if stripped.startswith("|") or stripped.startswith("#") or re.match(r"^\s*([-*+]|\d+[.)])\s", line):
                prose = False
        if not stripped:
            continue

        for group, label in (("variants", "表記ゆれ"), ("redundant", "冗長表現"), ("forbidden", "禁止語")):
            if not checks.get(group):
                continue
            for rx, r in compiled[group]:
                for m in rx.finditer(line):
                    if m.end() == m.start():
                        continue
                    ctx, hit = snippet(line, m.start(), m.end())
                    note = ("(%s)" % r["note"]) if r.get("note") else ""
                    add(ln, m.start() + 1, r.get("type") or label, hit, ctx, "%s%s" % (r.get("suggest", ""), note))
        if checks.get("zenkaku_alnum"):
            for m in ZENKAKU_RE.finditer(line):
                ctx, hit = snippet(line, m.start(), m.end())
                add(ln, m.start() + 1, "全角英数字", hit, ctx, "%s(半角にする)" % unicodedata.normalize("NFKC", hit))
        if checks.get("hankaku_kana"):
            for m in HANKAKU_KANA_RE.finditer(line):
                ctx, hit = snippet(line, m.start(), m.end())
                add(ln, m.start() + 1, "半角カナ", hit, ctx, "%s(全角にする)" % unicodedata.normalize("NFKC", hit))
        if checks.get("duplicate_punctuation"):
            for m in DUP_PUNCT_RE.finditer(line):
                ctx, hit = snippet(line, m.start(), m.end())
                add(ln, m.start() + 1, "句読点の重複", hit, ctx, "%s(1つにする)" % hit[0])
        if checks.get("brackets"):
            stack = []
            skip = ENUM_RE.match(line)
            for i, ch in enumerate(line):
                if skip and i == skip.end() - 1:
                    continue
                if ch in PAIRS:
                    stack.append((ch, i))
                elif ch in CLOSERS:
                    if stack and stack[-1][0] == CLOSERS[ch]:
                        stack.pop()
                    elif stack:
                        o, oi = stack.pop()
                        ctx, _ = snippet(line, oi, i + 1)
                        add(ln, oi + 1, "括弧の不一致", line[oi] + "…" + ch, ctx,
                            "「%s」に対応する閉じ括弧は「%s」" % (o, PAIRS[o]))
                    else:
                        ctx, hit = snippet(line, i, i + 1)
                        add(ln, i + 1, "括弧の対応", hit, ctx, "開き括弧「%s」がない" % CLOSERS[ch])
            for o, oi in stack:
                ctx, hit = snippet(line, oi, oi + 1)
                add(ln, oi + 1, "括弧の対応", hit, ctx, "閉じ括弧「%s」がない" % PAIRS[o])
        if not prose:
            continue
        for s, e in sentences(line):
            sent = line[s:e].strip()
            if checks.get("sentence_length") and len(sent) > limits["sentence"]:
                add(ln, s + 1, "長い文", "%d文字" % len(sent), head(sent),
                    "%d文字以内を目安に分割する" % limits["sentence"])
            commas = sent.count("、") + sent.count("，")
            if checks.get("commas") and commas >= limits["commas"]:
                add(ln, s + 1, "読点の多い文", "読点%d個" % commas, head(sent), "文を分けるか読点を減らす")
            style = classify(sent)
            if style:
                styled.append((ln, s + 1, style, sent))

    if checks.get("style_mix"):
        masu = sum(1 for x in styled if x[2] == MASU)
        da = sum(1 for x in styled if x[2] == DA)
        if masu and da:
            base = MASU if masu >= da else DA
            for ln, col, style, sent in styled:
                if style != base:
                    add(ln, col, "文体の混在", style, head(sent),
                        "基調の%sに合わせる(%s %d文 / %s %d文)" % (base, MASU, masu, DA, da))
    findings.sort(key=lambda f: (f["line"], f["col"]))
    return findings


def md_cell(s):
    return str(s).replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")


def render(path, kind, findings, limit):
    counts = {}
    for f in findings:
        counts[f["type"]] = counts.get(f["type"], 0) + 1
    out = ["# 表記・体裁チェック結果", "",
           "- 対象: %s" % os.path.basename(path),
           "- 指摘: %d件" % len(findings)]
    if kind == "docx":
        out.append("- 行: Word の段落番号(本文の先頭から数え、空の段落も含む)")
    if counts:
        out.append("- 内訳: " + "、".join("%s %d" % (k, v) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))
    out.append("")
    if not findings:
        out.append("指摘はありません。")
        return "\n".join(out) + "\n"
    out.append("| 行:位置 | 種別 | 該当箇所 | 提案 |")
    out.append("|---|---|---|---|")
    for f in findings[:limit]:
        out.append("| %d:%d | %s | %s | %s |" % (f["line"], f["col"], md_cell(f["type"]), md_cell(f["context"]), md_cell(f["suggest"])))
    if len(findings) > limit:
        out.append("")
        out.append("ほか %d 件は省略しました(全件は CSV を参照)。" % (len(findings) - limit))
    return "\n".join(out) + "\n"


def write_csv(path, findings):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["行", "位置", "種別", "該当", "前後", "提案"])
        for x in findings:
            w.writerow([x["line"], x["col"], x["type"], x["text"], x["context"].replace("**", "【", 1).replace("**", "】", 1), x["suggest"]])


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Japanese document style checker.")
    ap.add_argument("file")
    ap.add_argument("--rules", default=DEFAULT_RULES)
    ap.add_argument("--out", help="write the Markdown report here")
    ap.add_argument("--csv", help="write all findings as CSV (UTF-8 with BOM)")
    ap.add_argument("--json", action="store_true", help="print findings as JSON")
    args = ap.parse_args(argv)
    try:
        checks, compiled, limits = load_rules(args.rules)
        lines, kind = load_lines(args.file)
    except InputError as e:
        print("エラー: %s" % e, file=sys.stderr)
        return 2
    findings = check(lines, kind, checks, compiled, limits)
    if args.csv:
        write_csv(args.csv, findings)
    if args.json:
        print(json.dumps(findings, ensure_ascii=False, indent=1))
        return 0
    report = render(args.file, kind, findings, limits["findings"])
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(report)
        print(report.split("\n\n", 1)[0])
        print("\nレポートを書き出しました: %s" % os.path.abspath(args.out))
        if args.csv:
            print("CSV を書き出しました: %s" % os.path.abspath(args.csv))
    else:
        sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
