#!/usr/bin/env python3
"""Summarize text logs: levels, message templates, timeline. Python 3.8+, standard library only.

    python3 scripts/log_summary.py <file.log|file.txt|file.gz|logs.zip>... [--grep REGEX] [--level ERROR,WARN]
        [--since "2026-10-01 09:00"] [--until "2026-10-01 18:00"] [--bucket auto|hour|day]
        [--top 20] [--year 2026] [--out-dir DIR] [--prefix NAME]

A record is a line with a timestamp plus the following lines without one (stack traces).
Files without any timestamp are counted line by line. Prints a Markdown report and writes
<prefix>_templates.csv and <prefix>_timeline.csv (UTF-8 with BOM).
"""

import argparse
import datetime
import gzip
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tabular_io as tio  # noqa: E402
from tabular_io import TableError  # noqa: E402

LOG_EXT = (".log", ".txt", ".out", ".err", ".trace")
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MONTHS = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}

TS_PATTERNS = [
    ("iso", re.compile(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?")),
    ("slash", re.compile(r"(\d{4})/(\d{1,2})/(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.,]\d+)?")),
    ("clf", re.compile(r"\[(\d{2})/(%s)/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?: [+-]\d{4})?\]" % "|".join(MONTHS))),
    ("syslog", re.compile(r"(?<![A-Za-z])(%s) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})" % "|".join(MONTHS))),
]
TS_SEARCH_WINDOW = 80  # a timestamp must start within the first 80 characters of the line

LEVELS = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "不明"]
LEVEL_RE = re.compile(
    r"(?<![A-Za-z])(FATAL|CRITICAL|CRIT|EMERG(?:ENCY)?|ALERT|SEVERE|ERROR|ERR|EXCEPTION|TRACEBACK|"
    r"WARNING|WARN|NOTICE|INFO|INFORMATION|DEBUG|TRACE|FINE[RST]*)(?![A-Za-z])"
    r"|(致命的|重大|エラー|異常|失敗|例外|警告|注意|情報)", re.I)
LEVEL_MAP = {"FATAL": "FATAL", "CRITICAL": "FATAL", "CRIT": "FATAL", "EMERG": "FATAL", "EMERGENCY": "FATAL",
             "ALERT": "FATAL", "SEVERE": "ERROR", "ERROR": "ERROR", "ERR": "ERROR", "EXCEPTION": "ERROR",
             "TRACEBACK": "ERROR", "WARNING": "WARN", "WARN": "WARN", "NOTICE": "INFO", "INFO": "INFO",
             "INFORMATION": "INFO", "DEBUG": "DEBUG", "TRACE": "DEBUG",
             "致命的": "FATAL", "重大": "FATAL", "エラー": "ERROR", "異常": "ERROR", "失敗": "ERROR",
             "例外": "ERROR", "警告": "WARN", "注意": "WARN", "情報": "INFO"}

MASKS = [
    (re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"), "<UUID>"),
    (re.compile(r"https?://[^\s\"'<>]+"), "<URL>"),
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "<EMAIL>"),
    (re.compile(r"(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?![\w.])"), "<IP>"),
    (re.compile(r"(?<![\w])[A-Za-z]:\\[^\s\"'<>|]*|\\\\[^\s\"'<>|]+"), "<PATH>"),
    (re.compile(r"(?<![\w.:/<-])/(?:[\w.@~-]+/)+[\w.@~-]*"), "<PATH>"),
    (re.compile(r"\b0x[0-9a-fA-F]+\b"), "<HEX>"),
    (re.compile(r"\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\b"), "<HEX>"),
    (re.compile(r"\d+(?:[.,:]\d+)*"), "<N>"),
]


def find_timestamp(line, year):
    """(datetime, (start, end)) or (None, None)."""
    for kind, rx in TS_PATTERNS:
        m = rx.search(line, 0, TS_SEARCH_WINDOW + 40)
        if not m or m.start() > TS_SEARCH_WINDOW:
            continue
        g = m.groups()
        try:
            if kind in ("iso", "slash"):
                dt = datetime.datetime(int(g[0]), int(g[1]), int(g[2]), int(g[3]), int(g[4]), int(g[5]))
            elif kind == "clf":
                dt = datetime.datetime(int(g[2]), MONTHS[g[1]], int(g[0]), int(g[3]), int(g[4]), int(g[5]))
            else:
                dt = datetime.datetime(year, MONTHS[g[0]], int(g[1]), int(g[2]), int(g[3]), int(g[4]))
        except ValueError:
            continue
        return dt, m.span(), kind
    return None, None, None


def find_level(line):
    m = LEVEL_RE.search(line)
    if not m:
        return "不明", None
    tok = m.group(0)
    return LEVEL_MAP.get(tok.upper(), LEVEL_MAP.get(tok, "不明")), m.span()


def template_of(line, ts_span, lv_span):
    s = line
    cut = sorted([sp for sp in (ts_span, lv_span) if sp], reverse=True)
    for a, b in cut:
        s = s[:a] + " " + s[b:]
    for rx, rep in MASKS:
        s = rx.sub(rep, s)
    s = re.sub(r"\[\s*\]|\(\s*\)", " ", s)
    s = re.sub(r"^[\s:|,-]+", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:200] or "(本文なし)"


def decode(data, name, notes):
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return data.decode("utf-16", errors="replace")
    for enc in ("utf-8", "cp932", "euc_jp"):
        try:
            text = data.decode(enc)
            if enc != "utf-8":
                notes.append("%s は %s として読みました" % (name, enc))
            return text
        except UnicodeDecodeError:
            continue
    notes.append("%s は文字コードを判定できず、読めない文字を置き換えました" % name)
    return data.decode("utf-8", errors="replace")


def is_log_name(name):
    low = name.lower()
    base = os.path.basename(low)
    if not base or base.startswith(".") or "__macosx" in low:
        return False
    if low.endswith(".gz"):
        low = low[:-3]
    return low.endswith(LOG_EXT) or bool(re.search(r"\.log\.\d+$", low)) or ("." not in base)


def iter_sources(paths, notes):
    """Yield (display name, text)."""
    total = [0]

    def budget(n, name):
        total[0] += n
        if total[0] > MAX_TOTAL_BYTES:
            raise TableError("ログの合計が %d MB を超えました (%s で中止)。期間やファイルを絞って添付してください。"
                             % (MAX_TOTAL_BYTES // (1024 * 1024), name))

    for p in paths:
        if not os.path.isfile(p):
            raise TableError("ファイルが見つかりません: %s" % p)
        low = p.lower()
        if low.endswith(".zip"):
            try:
                zf = zipfile.ZipFile(p)
            except zipfile.BadZipFile:
                raise TableError("zip ファイルとして開けませんでした: %s" % p)
            with zf:
                members = [i for i in zf.infolist() if not i.is_dir() and is_log_name(i.filename)]
                if not members:
                    notes.append("%s の中にログらしいファイル (.log .txt など) がありませんでした" % os.path.basename(p))
                for info in members:
                    if info.flag_bits & 0x1:
                        notes.append("%s はパスワード付きのため読めませんでした" % info.filename)
                        continue
                    try:
                        buf = io.BytesIO()
                        with zf.open(info) as f:
                            while True:
                                chunk = f.read(1024 * 1024)
                                if not chunk:
                                    break
                                budget(len(chunk), info.filename)
                                buf.write(chunk)
                        data = buf.getvalue()
                    except (RuntimeError, zipfile.BadZipFile, NotImplementedError) as e:
                        notes.append("%s を展開できませんでした (%s)" % (info.filename, e))
                        continue
                    name = "%s:%s" % (os.path.basename(p), info.filename)
                    if info.filename.lower().endswith(".gz"):
                        data = gunzip(data, name, budget)
                    yield name, decode(data, name, notes)
        else:
            budget(os.path.getsize(p), p)
            with open(p, "rb") as f:
                data = f.read()
            if low.endswith(".gz"):
                data = gunzip(data, p, budget)
            if b"\x00" in data[:4096] and not (data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff")):
                notes.append("%s はテキストではないようなので読み飛ばしました" % os.path.basename(p))
                continue
            yield os.path.basename(p), decode(data, os.path.basename(p), notes)


def gunzip(data, name, budget):
    out = io.BytesIO()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as g:
            while True:
                chunk = g.read(1024 * 1024)
                if not chunk:
                    break
                budget(len(chunk), name)
                out.write(chunk)
    except (OSError, EOFError) as e:
        raise TableError("gzip を展開できませんでした: %s (%s)" % (name, e))
    return out.getvalue()


def parse_bound(text, name):
    if not text:
        return None
    dt = tio.parse_date(text)
    if dt is None:
        m = re.match(r"^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})\s*$", tio.nfkc(text))
        if m:
            dt = datetime.datetime(*[int(x) for x in m.groups()])
    if dt is None:
        raise TableError("%s「%s」を日時として読めません (例: 2026-10-01 または 2026-10-01 09:00)。" % (name, text))
    return dt


def iter_records(text, year):
    """Yield (first line, datetime, timestamp span, kind, continuation lines). In a log that has
    timestamps, a line without one (stack trace, exception message, wrapped text) belongs to
    the record above it. Lines before the first timestamp are records of their own."""
    lines = text.splitlines()
    has_ts = any(find_timestamp(ln, year)[0] for ln in lines[:200] if ln.strip())
    cur = None
    extra = 0
    for ln in lines:
        if not ln.strip():
            continue
        if not has_ts:
            yield ln, None, None, None, 0
            continue
        dt, span, kind = find_timestamp(ln, year)
        if dt is not None:
            if cur is not None:
                yield cur + (extra,)
            cur, extra = (ln, dt, span, kind), 0
        elif cur is None:
            yield ln, None, None, None, 0
        else:
            extra += 1
    if cur is not None:
        yield cur + (extra,)


def main(argv=None):
    tio.setup_stdout()
    ap = argparse.ArgumentParser(description="ログの集計 (レベル別件数・頻出メッセージ・時間帯別件数)")
    ap.add_argument("inputs", nargs="+", help="ログファイル (.log .txt .gz) または .zip")
    ap.add_argument("--grep", help="この正規表現に一致するレコードだけを数える (大文字小文字を区別しない)")
    ap.add_argument("--level", help="数えるレベル (例: ERROR,FATAL)。FATAL/ERROR/WARN/INFO/DEBUG/不明")
    ap.add_argument("--since", help="この日時以降 (例: 2026-10-01 または \"2026-10-01 09:00\")")
    ap.add_argument("--until", help="この日時より前")
    ap.add_argument("--bucket", choices=("auto", "hour", "day"), default="auto", help="時系列の単位 (既定: 期間が 3 日以内なら時間)")
    ap.add_argument("--top", type=int, default=20, help="頻出メッセージの表示件数")
    ap.add_argument("--year", type=int, help="syslog 形式 (年なし) の年 (既定: 今年)")
    ap.add_argument("--out-dir", default=".", help="出力先フォルダ")
    ap.add_argument("--prefix", default="log_summary", help="出力ファイル名の先頭")
    args = ap.parse_args(argv)

    try:
        grep = re.compile(args.grep, re.I) if args.grep else None
    except re.error as e:
        raise TableError("--grep の正規表現が不正です: %s" % e)
    levels = None
    if args.level:
        levels = set()
        for lv in args.level.split(","):
            lv = lv.strip()
            key = LEVEL_MAP.get(lv.upper(), lv if lv in LEVELS else None)
            if key is None:
                raise TableError("レベル「%s」は使えません。使えるもの: %s" % (lv, " / ".join(LEVELS)))
            levels.add(key)
    since, until = parse_bound(args.since, "--since"), parse_bound(args.until, "--until")
    year = args.year or datetime.date.today().year

    notes = []
    files = []
    level_counts = dict.fromkeys(LEVELS, 0)
    templates = {}
    timeline = {}
    total_lines = total_records = matched = no_ts = 0
    first = last = None
    kinds = {}
    for name, text in iter_sources(args.inputs, notes):
        n_lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
        n_rec = n_cont = 0
        for line, dt, ts_span, kind, extra in iter_records(text, year):
            n_rec += 1
            n_cont += extra
            if kind:
                kinds[kind] = kinds.get(kind, 0) + 1
            if (since or until) and dt is None:
                no_ts += 1
                continue
            if since and dt < since or until and dt >= until:
                continue
            level, lv_span = find_level(line)
            if levels and level not in levels:
                continue
            if grep and not grep.search(line):
                continue
            matched += 1
            level_counts[level] += 1
            key = (level, template_of(line, ts_span, lv_span))
            t = templates.get(key)
            if t is None:
                t = templates[key] = {"n": 0, "first": None, "last": None, "example": line.strip()[:300], "files": set()}
            t["n"] += 1
            t["files"].add(name.split(":")[0])
            if dt is not None:
                if t["first"] is None or dt < t["first"]:
                    t["first"] = dt
                if t["last"] is None or dt > t["last"]:
                    t["last"] = dt
                first = dt if first is None or dt < first else first
                last = dt if last is None or dt > last else last
                hour = dt.replace(minute=0, second=0, microsecond=0)
                b = timeline.get(hour)
                if b is None:
                    b = timeline[hour] = [0, 0, 0]
                b[0] += 1
                if level in ("FATAL", "ERROR"):
                    b[1] += 1
                elif level == "WARN":
                    b[2] += 1
        files.append((name, n_lines, n_rec, n_cont))
        total_lines += n_lines
        total_records += n_rec
    if not files:
        raise TableError("読めるログファイルがありませんでした。" + (" " + " / ".join(notes) if notes else ""))

    bucket = args.bucket
    if bucket == "auto":
        bucket = "hour" if first is None or (last - first) <= datetime.timedelta(days=3) else "day"
    fmt = "%Y-%m-%d %H:00" if bucket == "hour" else "%Y-%m-%d"
    buckets = {}
    for dt, (n, e, w) in timeline.items():
        k = dt.strftime(fmt)
        b = buckets.setdefault(k, [0, 0, 0])
        b[0] += n
        b[1] += e
        b[2] += w
    if first is not None:  # fill empty buckets so that gaps are visible
        step = datetime.timedelta(hours=1) if bucket == "hour" else datetime.timedelta(days=1)
        cur = first.replace(minute=0, second=0, microsecond=0)
        if bucket == "day":
            cur = cur.replace(hour=0)
        guard = 0
        while cur <= last and guard < 5000:
            buckets.setdefault(cur.strftime(fmt), [0, 0, 0])
            cur += step
            guard += 1
    tl_rows = [[k] + buckets[k] for k in sorted(buckets)]

    ranked = sorted(templates.items(), key=lambda kv: (-kv[1]["n"], LEVELS.index(kv[0][0]), kv[0][1]))
    tpl_header = ["順位", "件数", "レベル", "メッセージのパターン", "初回", "最終", "ファイル", "例"]
    tpl_rows = [[i, t["n"], lv, tp, tio.format_datetime(t["first"]) if t["first"] else "",
                 tio.format_datetime(t["last"]) if t["last"] else "", " ".join(sorted(t["files"])), t["example"]]
                for i, ((lv, tp), t) in enumerate(ranked, 1)]
    out_tpl = os.path.join(args.out_dir, "%s_templates.csv" % args.prefix)
    out_tl = os.path.join(args.out_dir, "%s_timeline.csv" % args.prefix)
    tio.write_csv(out_tpl, tpl_header, tpl_rows, args.inputs)
    tio.write_csv(out_tl, ["時間帯" if bucket == "hour" else "日付", "件数", "ERROR+FATAL", "WARN"], tl_rows, args.inputs)

    cond = []
    if args.grep:
        cond.append("grep /%s/" % args.grep)
    if levels:
        cond.append("レベル %s" % ",".join(sorted(levels)))
    if since:
        cond.append("%s 以降" % tio.format_datetime(since))
    if until:
        cond.append("%s より前" % tio.format_datetime(until))
    lines = ["## ログ集計結果", "",
             "- 対象: %d ファイル、%d 行、%d レコード (日時のない続きの行 %d 行は直前のレコードの一部として数えた)"
             % (len(files), total_lines, total_records, sum(f[3] for f in files)),
             "- 期間: %s 〜 %s" % (tio.format_datetime(first) if first else "(タイムスタンプなし)",
                                 tio.format_datetime(last) if last else ""),
             "- 集計対象: %d レコード%s" % (matched, ("(条件: %s)" % "、".join(cond)) if cond else "")]
    if kinds.get("syslog"):
        lines.append("- 注意: 年のない syslog 形式の日時は %d 年として扱いました (--year で変更可)" % year)
    if kinds.get("iso"):
        lines.append("- 時刻はログに書かれたまま扱い、タイムゾーンの換算はしていません")
    if no_ts:
        lines.append("- 注意: 期間指定のため、タイムスタンプのない %d レコードを除外しました" % no_ts)
    for n in notes:
        lines.append("- 注意: %s" % n)
    lines += ["", "### レベル別件数", ""]
    lines.append(tio.markdown_table(["レベル", "件数"], [[lv, level_counts[lv]] for lv in LEVELS if level_counts[lv]] or [["(なし)", 0]],
                                    None, align=["l", "r"]))
    lines += ["", "### 頻出メッセージ (上位 %d / 全 %d パターン)" % (min(args.top, len(tpl_rows)), len(tpl_rows)), ""]
    lines.append(tio.markdown_table(tpl_header[:6], [r[:6] for r in tpl_rows], args.top, width=100))
    err_rows = [r for r in tpl_rows if r[2] in ("FATAL", "ERROR")]
    if err_rows and len(tpl_rows) > args.top:
        lines += ["", "### ERROR / FATAL のパターン (上位 10)", ""]
        lines.append(tio.markdown_table(tpl_header[:6], [r[:6] for r in err_rows], 10, width=100))
    if tl_rows:
        peak = max(r[1] for r in tl_rows) or 1
        lines += ["", "### %s別件数" % ("時間帯" if bucket == "hour" else "日"), ""]
        shown = [r + ["█" * int(round(20.0 * r[1] / peak))] for r in tl_rows]
        lines.append(tio.markdown_table(["時間帯" if bucket == "hour" else "日付", "件数", "ERROR+FATAL", "WARN", "グラフ"],
                                        shown, 72, align=["l", "r", "r", "r", "l"]))
    lines += ["", "### ファイル別", ""]
    lines.append(tio.markdown_table(["ファイル", "行数", "レコード", "続きの行"], [list(f) for f in files], 30,
                                    align=["l", "r", "r", "r"]))
    lines += ["", "- 出力: %s (全パターン), %s (時系列) ※ UTF-8 BOM 付き CSV" % (out_tpl, out_tl)]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    tio.run_main(main)
