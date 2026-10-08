#!/usr/bin/env python3
"""Turn a meeting transcript into compact text for minutes.

Usage:
    python3 transcript_to_text.py <file> [--out transcript.txt] [--json]

Reads a Teams WebVTT transcript (.vtt), a Teams transcript exported as Word (.docx) or a
plain text file (.txt / .md), merges consecutive turns of the same speaker and prints

    # 文字起こし(整形済み)
    ...statistics (duration, speakers, talk-time share)...
    [HH:MM:SS] 話者: 発言

With --out the text goes to that file and only the statistics are printed. With --json the
statistics and turns are printed as JSON instead (for checks and tests).

Timestamps are elapsed time from the start of the recording, not wall-clock time. A run of
one speaker is split into a new line once it spans 60 seconds or 400 characters, so every
line's timestamp stays close to what it says.

Exit codes (messages on stderr; warnings start with "警告:" and do not change the exit code):
  0  success
  2  unreadable or unsupported input, or an empty file
  3  the file is readable but is not a transcript (no speakers and times). The message is always
     NOT_TRANSCRIPT below; with --out the plain body text is written to that file instead, so
     the caller can read it as an ordinary meeting memo.
Python 3.8+, standard library only.
"""

import argparse
import html
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

UNKNOWN = "(話者不明)"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
MAX_XML_BYTES = 64 * 1024 * 1024
EXIT_INPUT = 2
EXIT_NOT_TRANSCRIPT = 3
# One stable message for every "readable, but not a transcript" case (.txt, .md and .docx alike).
NOT_TRANSCRIPT = "話者と時刻を含む文字起こし形式ではありません(メモとしてそのまま読んでください)"
# A merged run of one speaker starts a new line after this span / length (see merge()).
MERGE_SPAN_SEC = 60
MERGE_MAX_CHARS = 400

# "00:01:02.345" (WebVTT), "100:00:00.000" (recordings over 99 hours) and "0:0:5.43" (older
# Teams .docx) are all valid.
TS = r"(?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?"
# Prefix match: a WebVTT cue timing line may carry cue settings after the end time.
CUE_RE = re.compile(r"^\s*(" + TS + r")\s*-->\s*(" + TS + r")")
# Whole-line match for files without a WEBVTT header: only "name:value" cue settings may follow,
# so a memo line such as "10:00 --> 11:00 DB停止" is not taken as a cue.
CUE_LINE_RE = re.compile(r"^\s*(" + TS + r")\s*-->\s*(" + TS + r")(?:\s+[^\s:]+:\S+)*\s*$")
# "山田 太郎   0:05" / "山田 太郎 1:02:03" (newer Teams .docx export)
NAME_TIME_RE = re.compile(r"^(?P<name>\S.*?)[\s　]+(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\s*$")
# Characters that never appear in a display name but do in sentences ("リリースは金曜の、15:00").
# ASCII "," and "." are left out on purpose: "Yamada, Taro" and "J. Smith" are common display
# names. A sentence with them is caught by the word count, the heading order and the time order.
HEAD_PUNCT = set("。、！？，．!?")
HEAD_MAX_CHARS = 40
HEAD_MAX_WORDS_WITH_ASCII_PUNCT = 4
HEAD_WINDOW = 64
# "0:01:02 山田: text" or "[00:01:02] 山田: text" (already compact text)
TIME_NAME_TEXT_RE = re.compile(r"^\[?(?P<time>" + TS + r")\]?\s+(?P<name>(?![^:：]*-->)[^:：]{1,40})[:：]\s*(?P<text>.*)$")
# A voice runs to its </v>, to the next <v ...> in the same cue, or to the end of the cue.
VOICE_RE = re.compile(r"<v(?:\.[^\s>]+)?\s+([^>]+)>(.*?)(?=</v>|<v[\s.]|$)", re.S)
TAG_RE = re.compile(r"</?[^>]+>")
# The export header carries the meeting date ("2026年10月1日 10:00", "2026/10/01 10:00"); not a speaker.
DATE_LIKE_RE = re.compile(r"^\d{4}\s*[年/.-]|\d{1,2}月\d{1,2}日|^(?:[A-Z][a-z]+day|[A-Z][a-z]{2,8}\s+\d{1,2},)")


class InputError(Exception):
    pass


class NotTranscript(Exception):
    """Readable text without speakers and times; carries the plain text for the memo path."""

    def __init__(self, path, text):
        Exception.__init__(self, "%s: %s" % (NOT_TRANSCRIPT, path))
        self.text = text


def parse_ts(s):
    s = s.replace(",", ".")
    parts = s.split(":")
    secs = float(parts[-1])
    mins = int(parts[-2]) if len(parts) >= 2 else 0
    hours = int(parts[-3]) if len(parts) >= 3 else 0
    return hours * 3600 + mins * 60 + secs


def fmt_ts(sec):
    sec = int(sec or 0)  # floor, as Teams shows cue times
    return "%02d:%02d:%02d" % (sec // 3600, sec % 3600 // 60, sec % 60)


def fmt_dur(sec):
    sec = int(round(sec))
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    if h:
        return "%d時間%02d分%02d秒" % (h, m, s)
    if m:
        return "%d分%02d秒" % (m, s)
    return "%d秒" % s


def clean(text):
    text = TAG_RE.sub("", text)
    text = html.unescape(text).replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def join_text(a, b):
    """Join two utterances: no space after Japanese punctuation, one space otherwise."""
    if not a or not b:
        return a or b
    return a + ("" if a[-1] in "。！？、」』）" else " ") + b


def join_all(parts):
    out = ""
    for p in parts:
        out = join_text(out, clean(p))
    return out


def clean_lines(text):
    """clean() for a multi-line cue body: lines joined like utterances (no space after 。)."""
    return join_all(text.split("\n"))


def read_text_file(path):
    with open(path, "rb") as f:
        data = f.read()
    encodings = ("utf-8-sig", "cp932")
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        encodings = ("utf-16",)  # Notepad's "Unicode"; the BOM tells the byte order
    for enc in encodings:
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise InputError("文字コードを判別できません(UTF-8 か Shift_JIS で保存してください): %s" % path)


def docx_paragraphs(path):
    """Paragraph texts of word/document.xml in document order (tables included)."""
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

    def para_text(p):
        buf = []

        def walk(el):
            for c in el:
                if c.tag == MC_FALLBACK:
                    continue
                if c.tag == W + "t":
                    buf.append(c.text or "")
                elif c.tag == W + "tab":
                    buf.append("\t")
                elif c.tag in (W + "br", W + "cr"):
                    buf.append("\n")
                elif c.tag == W + "p":
                    continue  # nested paragraph (text box) is visited on its own
                else:
                    walk(c)
        walk(p)
        return "".join(buf)

    def visit(el):
        for c in el:
            if c.tag == MC_FALLBACK:
                continue
            if c.tag == W + "p":
                for line in para_text(c).split("\n"):
                    out.append(line)
            visit(c)
    visit(root)
    return out


def parse_vtt(text):
    turns = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines):
        m = CUE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        start, end = parse_ts(m.group(1)), parse_ts(m.group(2))
        i += 1
        body = []
        while i < len(lines) and lines[i].strip() and not CUE_RE.match(lines[i]):
            body.append(lines[i])
            i += 1
        raw = "\n".join(body)
        voices = VOICE_RE.findall(raw)
        if voices:
            for name, said in voices:
                said = clean_lines(said)
                if said:
                    turns.append({"start": start, "end": end, "speaker": clean(name) or UNKNOWN, "text": said})
        else:
            said = clean_lines(raw)
            if said:
                turns.append({"start": start, "end": end, "speaker": UNKNOWN, "text": said})
    return turns


def preamble_warning(lines, first, what):
    """Non-empty lines before the first cue/heading are not utterances; say so instead of
    dropping them quietly."""
    skipped = [l for l in lines[:first] if l]
    if skipped:
        return ["%sより前の %d 行は発言として扱っていません(%s)"
                % (what, len(skipped), " / ".join(l[:40] for l in skipped[:3]) + (" / …" if len(skipped) > 3 else ""))]
    return []


def parse_ranges(lines):
    """Older Teams export: "0:0:0.0 --> 0:0:5.4" / speaker / text..."""
    turns, i, first = [], 0, None
    while i < len(lines):
        m = CUE_LINE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        if first is None:
            first = i
        start, end = parse_ts(m.group(1)), parse_ts(m.group(2))
        i += 1
        block = []
        while i < len(lines) and not CUE_LINE_RE.match(lines[i]):
            if lines[i]:
                block.append(lines[i])
            i += 1
        if not block:
            continue
        voices = VOICE_RE.findall("\n".join(block))
        if voices:
            for name, said in voices:
                said = clean_lines(said)
                if said:
                    turns.append({"start": start, "end": end, "speaker": clean(name) or UNKNOWN, "text": said})
        elif len(block) >= 2:
            turns.append({"start": start, "end": end, "speaker": clean(block[0]), "text": join_all(block[1:])})
        else:
            turns.append({"start": start, "end": end, "speaker": UNKNOWN, "text": clean(block[0])})
    return turns, preamble_warning(lines, first or 0, "最初の時刻行")


def head_candidates(lines):
    """Per line: None, or (name, seconds, plausible) for a "名前   0:15" shaped line."""
    out = []
    for l in lines:
        m = NAME_TIME_RE.match(l) if l else None
        if not m or DATE_LIKE_RE.search(m.group("name")):
            out.append(None)  # the export header's date line is neither a heading nor a warning
            continue
        name = clean(m.group("name"))
        plausible = (len(name) <= HEAD_MAX_CHARS and not (HEAD_PUNCT & set(name))
                     and not (len(name.split()) > HEAD_MAX_WORDS_WITH_ASCII_PUNCT and re.search(r"[.,]", name)))
        out.append((name, parse_ts(m.group("time")), plausible))
    return out


def choose_headings(lines, cands):
    """Pick the headings among the plausible "名前   0:15" lines.

    A body paragraph can end in a time too ("リリースは金曜の 15:00"), so the headings are the
    longest chain of candidates in which (1) times never go backwards and (2) no heading
    directly follows another heading (every heading has a body). Ties go to the chain whose
    speaker names recur as headings elsewhere (a sentence fragment rarely does), then to the
    chain of earlier lines: of a heading and a time-ending body line right after it, the
    heading comes first. Each chain looks back at most HEAD_WINDOW candidates, so the cost
    stays linear.
    """
    nonempty = [i for i, l in enumerate(lines) if l]
    next_nonempty = dict(zip(nonempty, nonempty[1:]))
    plaus = [i for i, c in enumerate(cands) if c and c[2]]
    freq = {}
    for i in plaus:
        freq[cands[i][0]] = freq.get(cands[i][0], 0) + 1
    best, back = [], []
    for k, i in enumerate(plaus):
        name, t, _ = cands[i]
        rec = 1 if freq[name] > 1 else 0
        score, frm = (1, rec, -i), None
        for j in range(max(0, k - HEAD_WINDOW), k):
            pj = plaus[j]
            if cands[pj][1] > t or next_nonempty.get(pj) == i:
                continue
            s = best[j]
            c = (s[0] + 1, s[1] + rec, s[2] - i)
            if c > score:
                score, frm = c, j
        best.append(score)
        back.append(frm)
    heads = []
    k = max(range(len(plaus)), key=lambda x: best[x]) if plaus else None
    while k is not None:
        heads.append(plaus[k])
        k = back[k]
    heads.reverse()
    return heads


def parse_headings(lines):
    """Newer Teams export: "山田 太郎   0:05" then the utterance in the next paragraph(s).
    Heading-shaped lines that are not chosen as headings stay in the text and are reported."""
    cands = head_candidates(lines)
    heads = choose_headings(lines, cands)
    if not heads:
        return [], [], []
    chosen = set(heads)
    demoted = [lines[i] for i, c in enumerate(cands) if c and i > heads[0] and i not in chosen]
    turns, warnings = [], []
    for n, h in enumerate(heads):
        name, t, _ = cands[h]
        stop = heads[n + 1] if n + 1 < len(heads) else len(lines)
        said = join_all(l for l in lines[h + 1:stop] if l)
        if said:
            turns.append({"start": t, "end": None, "speaker": name, "text": said})
        else:
            warnings.append("見出し「%s」の後に発言の本文がありません" % lines[h])
    if demoted:
        warnings.append("話者・時刻の見出しに似た %d 行を発言の本文として扱いました(例: %s)"
                        % (len(demoted), " / ".join(d[:40] for d in demoted[:3])))
    # The export starts with the title, the date and the length of the recording; still listed,
    # so a memo that only looks like a transcript does not lose its first lines unseen.
    warnings += preamble_warning(lines, heads[0], "最初の話者見出し")
    return turns, heads, warnings


def parse_lines(lines):
    """Docx or text transcripts. Returns (turns, format label, warnings); ([], None, []) if none."""
    lines = [l.strip() for l in lines]
    nonempty = [l for l in lines if l]
    # Older Teams export ("0:0:0.0 --> 0:0:5.4" lines). One stray arrow line in a memo is not
    # enough: whole-line cue timings must make up a real share of the text.
    cues = sum(1 for l in nonempty if CUE_LINE_RE.match(l))
    if cues >= 2 and cues * 6 >= len(nonempty):
        turns, warnings = parse_ranges(lines)
        return turns, "Teams 文字起こし(時刻範囲形式)", warnings
    # "[00:01:02] 山田: text" lines
    hits = [TIME_NAME_TEXT_RE.match(l) for l in nonempty]
    if hits and sum(1 for h in hits if h) >= max(2, len(hits) // 2):
        turns, first = [], None
        for i, l in enumerate(lines):
            m = TIME_NAME_TEXT_RE.match(l)
            if m:
                if first is None:
                    first = i
                turns.append({"start": parse_ts(m.group("time")), "end": None, "speaker": m.group("name").strip(), "text": clean(m.group("text"))})
            elif l and turns:
                turns[-1]["text"] = join_text(turns[-1]["text"], clean(l))
        return [t for t in turns if t["text"]], "時刻付きテキスト", preamble_warning(lines, first or 0, "最初の発言行")
    # Newer Teams export: "山田 太郎   0:05" then text paragraphs
    turns, heads, warnings = parse_headings(lines)
    if turns and (len(heads) >= 2 or not [l for l in lines[:heads[0]] if l]):
        return turns, "Teams 文字起こし(話者・時刻見出し形式)", warnings
    return [], None, []


def merge(turns):
    """Join consecutive turns of one speaker, but start a new line once the run spans
    MERGE_SPAN_SEC seconds from its first timestamp or reaches MERGE_MAX_CHARS characters, so a
    line's timestamp always stays close to everything on that line."""
    merged = []
    for t in turns:
        last = merged[-1] if merged else None
        if (last is not None and last["speaker"] == t["speaker"]
                and len(last["text"]) < MERGE_MAX_CHARS
                and (t["start"] is None or last["start"] is None or t["start"] - last["start"] < MERGE_SPAN_SEC)):
            last["text"] = join_text(last["text"], t["text"])
            if t["end"] is not None:
                last["end"] = t["end"]
            elif last["end"] is not None:
                last["end"] = None if t["start"] is None else max(last["end"], t["start"])
            last["pieces"] += 1
        else:
            d = dict(t)
            d["pieces"] = 1
            merged.append(d)
    return merged


def stats(turns, merged):
    have_end = all(t["end"] is not None for t in turns) and turns
    starts = [t["start"] for t in turns if t["start"] is not None]
    if have_end:
        first, last = min(starts), max(t["end"] for t in turns)
    elif starts:
        first, last = min(starts), max(starts)
    else:
        first = last = 0
    per = {}
    order = []
    for t in turns:
        s = t["speaker"]
        if s not in per:
            per[s] = {"name": s, "seconds": 0.0, "chars": 0, "turns": 0}
            order.append(s)
        per[s]["chars"] += len(t["text"])
        if have_end:
            per[s]["seconds"] += max(0.0, t["end"] - t["start"])
    for m in merged:
        per[m["speaker"]]["turns"] += 1
    basis = "seconds" if have_end else "chars"
    total = sum(p[basis] for p in per.values()) or 1
    speakers = []
    for s in order:
        p = per[s]
        p["share"] = round(100.0 * p[basis] / total, 1)
        p["seconds"] = round(p["seconds"], 1)
        speakers.append(p)
    speakers.sort(key=lambda p: -p[basis])
    return {
        "start": fmt_ts(first), "end": fmt_ts(last),
        "duration_sec": int(round(last - first)),
        "share_basis": "発言時間" if have_end else "文字数",
        "speakers": speakers,
        "raw_turns": len(turns), "merged_turns": len(merged),
    }


def load(path):
    """Returns (turns, format label, warnings). Raises InputError or NotTranscript."""
    ext = os.path.splitext(path)[1].lower()
    if not os.path.isfile(path):
        raise InputError("ファイルが見つかりません: %s" % path)
    if ext == ".docx":
        lines = docx_paragraphs(path)
    elif ext in (".vtt", ".txt", ".md", ".text"):
        text = read_text_file(path)
        if text.lstrip("﻿").lstrip().startswith("WEBVTT") or (ext == ".vtt"):
            turns = parse_vtt(text)
            if not turns:
                raise InputError("WebVTT に発言(キュー)が見つかりません: %s" % path)
            return turns, "WebVTT", []
        lines = text.splitlines()
    elif ext == ".doc":
        raise InputError("古い Word 形式 (.doc) は読めません。.docx で保存し直すか、Teams から .vtt または .docx でダウンロードしてください。")
    else:
        raise InputError("未対応の形式です (%s)。.vtt / .docx / .txt を添付してください。" % (ext or "拡張子なし"))
    if not any(l.strip() for l in lines):
        raise InputError("ファイルに本文がありません: %s" % path)
    turns, label, warnings = parse_lines(lines)
    if not turns:
        raise NotTranscript(path, "\n".join(l.rstrip() for l in lines).strip("\n") + "\n")
    return turns, label, warnings


def render(path, label, st, merged):
    out = ["# 文字起こし(整形済み)", "",
           "- 元ファイル: %s" % os.path.basename(path),
           "- 形式: %s" % label,
           "- 時刻: [HH:MM:SS] は録音開始からの経過時間(会議の実時刻ではない)",
           "- 会議時間: %s(%s〜%s%s)" % (fmt_dur(st["duration_sec"]), st["start"], st["end"],
                                     "" if st["share_basis"] == "発言時間" else "。最後の発言の開始時刻までの概算"),
           "- 発言: %d件(同じ話者の連続発言をまとめる前は %d件)" % (st["merged_turns"], st["raw_turns"]),
           "- 話者: %d名(割合の基準: %s)" % (len(st["speakers"]), st["share_basis"])]
    for p in st["speakers"]:
        extra = "%s・" % fmt_dur(p["seconds"]) if st["share_basis"] == "発言時間" else ""
        out.append("  - %s: %s%.1f%%・発言%d回" % (p["name"], extra, p["share"], p["turns"]))
    out.append("")
    out.append("---")
    out.append("")
    for m in merged:
        out.append("[%s] %s: %s" % (fmt_ts(m["start"]), m["speaker"], m["text"]))
    return "\n".join(out) + "\n"


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Compact a Teams transcript for minutes.")
    ap.add_argument("file")
    ap.add_argument("--out", help="write the compact text here (the plain text if the file is not a transcript); print only the statistics")
    ap.add_argument("--json", action="store_true", help="print statistics and merged turns as JSON")
    args = ap.parse_args(argv)
    try:
        turns, label, warnings = load(args.file)
    except NotTranscript as e:
        print("注意: %s" % e, file=sys.stderr)
        if args.out:
            with open(args.out, "w", encoding="utf-8", newline="\n") as f:
                f.write(e.text)
            print("本文をそのまま書き出しました(会議メモとして読んでください): %s (%d文字)"
                  % (os.path.abspath(args.out), len(e.text)), file=sys.stderr)
        return EXIT_NOT_TRANSCRIPT
    except InputError as e:
        print("エラー: %s" % e, file=sys.stderr)
        return EXIT_INPUT
    for w in warnings:
        print("警告: %s" % w, file=sys.stderr)
    merged = merge(turns)
    st = stats(turns, merged)
    if args.json:
        doc = dict(st)
        doc["format"] = label
        doc["warnings"] = warnings
        doc["turns"] = [{"start": fmt_ts(m["start"]), "speaker": m["speaker"], "text": m["text"], "pieces": m["pieces"]} for m in merged]
        print(json.dumps(doc, ensure_ascii=False, indent=1))
        return 0
    text = render(args.file, label, st, merged)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        head = text.split("\n---\n", 1)[0]
        print(head)
        print("\n整形済みテキストを書き出しました: %s (%d文字)" % (os.path.abspath(args.out), len(text)))
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
