#!/usr/bin/env python3
"""Shared table reader and writers for the data skills (CSV / TSV / XLSX).

Python 3.8+, standard library only. The Copilot sandbox has no network and no package
installer, so XLSX is read with zipfile + xml.etree instead of openpyxl.

Every cell comes back as a string: numbers as plain decimal text, dates as
"YYYY-MM-DD" (or "YYYY-MM-DD HH:MM:SS" / "HH:MM:SS"), booleans as TRUE/FALSE.
User-facing problems raise TableError with a Japanese message; scripts print it and
exit 2 instead of showing a traceback.

Import from a script in the same directory:

    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import tabular_io
"""

import csv
import datetime
import io
import math
import os
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

CSV_EXT = {".csv", ".txt"}
TSV_EXT = {".tsv", ".tab"}
XLSX_EXT = {".xlsx", ".xlsm"}
TABLE_EXT = ".csv,.tsv,.txt,.xlsx,.xlsm"

csv.field_size_limit(min(sys.maxsize, 2 ** 31 - 1))


class TableError(Exception):
    """A problem the user can fix (bad file, unknown column, ...). Message is Japanese."""


# --------------------------------------------------------------------------- text

def nfkc(value):
    return unicodedata.normalize("NFKC", value or "")


def norm_key(value):
    """Loose comparison key for column names and category labels."""
    return re.sub(r"\s+", "", nfkc(str(value))).lower()


_MINUS = dict.fromkeys(map(ord, "−‒–—―－ー"), "-")


def parse_number(value):
    """Parse '1,234' '￥1,234' '1234円' '１２３' '△500' '(500)' '-1.5e3'. None if not a number."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    t = nfkc(str(value)).strip()
    if not t:
        return None
    t = t.translate(_MINUS)
    neg = False
    if t[0] in "△▲":  # △ ▲ (accounting negative)
        neg, t = True, t[1:].strip()
    if len(t) > 2 and t[0] == "(" and t[-1] == ")":
        neg, t = True, t[1:-1].strip()
    t = re.sub(r"[\s,¥$\\]", "", t)  # spaces, thousands separators, ¥, $, backslash (yen in cp932 fonts)
    if t.endswith("円"):  # 円
        t = t[:-1]
    if t.startswith("¥") or t.startswith("$"):
        t = t[1:]
    if not re.match(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$", t):
        return None
    try:
        n = float(t)
    except ValueError:
        return None
    if math.isinf(n) or math.isnan(n):
        return None
    return -n if neg else n


def format_number(n):
    if n is None:
        return ""
    if float(n).is_integer() and abs(n) < 1e15:
        return str(int(n))
    return "%.15g" % n


_ERA = {"令和": 2018, "R": 2018, "平成": 1988, "H": 1988, "昭和": 1925, "S": 1925}
_DATE_RE = re.compile(
    r"^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?"
    r"(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$")
_ERA_RE = re.compile(
    r"^(令和|平成|昭和|[RHS])\s*(\d{1,2}|元)\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$")


def parse_date(value):
    """'2026-04-01' '2026/4/1' '2026年4月1日' '令和8年4月1日' 'R8.4.1' (+ optional time).

    Returns datetime.datetime (time 00:00 when absent) or None.
    """
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value
    if isinstance(value, datetime.date):
        return datetime.datetime(value.year, value.month, value.day)
    t = nfkc(str(value)).strip()
    if not t:
        return None
    try:
        m = _DATE_RE.match(t)
        if m:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            hh = int(m.group(4) or 0)
            mm = int(m.group(5) or 0)
            ss = int(m.group(6) or 0)
            return datetime.datetime(y, mo, d, hh, mm, ss)
        m = _ERA_RE.match(t.upper() if len(t) and t[0] in "rhs" else t)
        if m:
            n = 1 if m.group(2) == "元" else int(m.group(2))
            return datetime.datetime(_ERA[m.group(1)] + n, int(m.group(3)), int(m.group(4)))
    except ValueError:
        return None
    return None


def format_datetime(dt):
    if dt is None:
        return ""
    if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
        return dt.strftime("%Y-%m-%d")
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------- CSV

def decode_bytes(data, encoding=None):
    """Return (text, encoding_name). Tries UTF-8 (with/without BOM), UTF-16 BOM, cp932, EUC-JP."""
    if encoding:
        try:
            return data.decode(encoding), encoding
        except (UnicodeDecodeError, LookupError) as e:
            raise TableError("指定の文字コード %s で読めませんでした (%s)。--encoding を外して自動判定を試してください。" % (encoding, e))
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace"), "utf-8-sig"
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        try:
            return data.decode("utf-16"), "utf-16"
        except UnicodeDecodeError:
            pass
    for enc in ("utf-8", "cp932", "euc_jp"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    raise TableError(
        "文字コードを判定できませんでした (UTF-8 / Shift_JIS(cp932) / EUC-JP のいずれでもありません)。"
        "Excel で「CSV UTF-8 (コンマ区切り)」として保存し直すか、--encoding で指定してください。")


def sniff_delimiter(text, ext):
    if ext in TSV_EXT:
        return "\t"
    sample = [ln for ln in text.splitlines()[:30] if ln.strip()]
    if not sample:
        return ","
    best, best_score = ",", (-1, -1)
    for d in (",", "\t", ";", "|"):
        try:
            counts = [len(r) for r in csv.reader(io.StringIO("\n".join(sample)), delimiter=d)]
        except csv.Error:
            continue
        if not counts or max(counts) < 2:
            continue
        common = max(set(counts), key=counts.count)
        score = (counts.count(common) * 100 // len(counts), common)
        if score > best_score:
            best, best_score = d, score
    return best


def read_csv(path, encoding=None, delimiter=None):
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise TableError("ファイルを開けませんでした: %s (%s)" % (path, e))
    if b"\x00" in data[:4096] and not (data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff")):
        raise TableError("テキストの表ファイルではないようです (バイナリデータを含みます): %s" % path)
    text, enc = decode_bytes(data, encoding)
    ext = os.path.splitext(path)[1].lower()
    delim = delimiter or sniff_delimiter(text, ext)
    if delim in ("\\t", "tab", "TAB"):
        delim = "\t"
    try:
        records = list(csv.reader(io.StringIO(text, newline=""), delimiter=delim))
    except csv.Error as e:
        raise TableError("CSV として読めませんでした: %s" % e)
    rows = [(i + 1, r) for i, r in enumerate(records)]
    return rows, {"format": "csv", "encoding": enc, "delimiter": delim}


# --------------------------------------------------------------------------- XLSX

BUILTIN_DATE_IDS = set(range(14, 23)) | {45, 46, 47} | set(range(27, 37)) | set(range(50, 59))
BUILTIN_TIME_ONLY = {18, 19, 20, 21, 45, 46, 47, 32, 33}


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _children(el, name):
    return [c for c in el if _local(c.tag) == name]


def _find(el, name):
    for c in el:
        if _local(c.tag) == name:
            return c
    return None


def is_date_format(code):
    if not code:
        return False
    c = code.split(";")[0]
    if c.strip().lower() == "general":
        return False
    c = re.sub(r'"[^"]*"', "", c)
    c = re.sub(r"\\.", "", c)
    c = re.sub(r"\[(?![hms]+\])[^\]]*\]", "", c, flags=re.I)  # [Red], [$-411] but keep [h]
    c = re.sub(r"[eE][+-]", "", c)
    return bool(re.search(r"[ymdhsge]", c.lower()))


def excel_serial_to_datetime(serial, date1904=False):
    if date1904:
        base = datetime.datetime(1904, 1, 1)
    elif serial < 60:
        base = datetime.datetime(1899, 12, 31)
    elif serial < 61:
        return datetime.datetime(1900, 2, 28)  # Excel's fictitious 1900-02-29
    else:
        base = datetime.datetime(1899, 12, 30)
    ms = int(round(serial * 86400000))
    return base + datetime.timedelta(milliseconds=ms)


def _col_index(ref):
    n = 0
    for ch in ref:
        if "A" <= ch <= "Z":
            n = n * 26 + (ord(ch) - 64)
        elif "a" <= ch <= "z":
            n = n * 26 + (ord(ch) - 96)
        else:
            break
    return n - 1


def _xml(zf, name):
    try:
        with zf.open(name) as f:
            return ET.parse(f).getroot()
    except KeyError:
        return None
    except ET.ParseError as e:
        raise TableError("Excel ファイルの内部 XML (%s) を読めませんでした: %s" % (name, e))


def _string_item(si):
    """Text of <si>/<is>: direct <t> plus rich-text runs <r><t>; skips phonetic <rPh>."""
    parts = []
    for c in si:
        n = _local(c.tag)
        if n == "t":
            parts.append(c.text or "")
        elif n == "r":
            t = _find(c, "t")
            if t is not None:
                parts.append(t.text or "")
    return "".join(parts)


def _open_xlsx(path):
    if os.path.splitext(path)[1].lower() == ".xls":
        raise TableError("旧形式の .xls には対応していません。Excel で .xlsx または CSV として保存し直してください。")
    try:
        return zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise TableError("Excel (.xlsx) ファイルとして開けませんでした。ファイルが壊れているか、パスワード保護されている可能性があります: %s" % path)
    except OSError as e:
        raise TableError("ファイルを開けませんでした: %s (%s)" % (path, e))


def xlsx_sheets(zf):
    wb = _xml(zf, "xl/workbook.xml")
    if wb is None:
        raise TableError("Excel ブックの構成 (xl/workbook.xml) が見つかりません。.xlsx 形式か確認してください。")
    rels = _xml(zf, "xl/_rels/workbook.xml.rels")
    targets = {}
    if rels is not None:
        for r in rels:
            targets[r.get("Id")] = r.get("Target", "")
    pr = _find(wb, "workbookPr")
    date1904 = pr is not None and pr.get("date1904") in ("1", "true")
    sheets = []
    sh = _find(wb, "sheets")
    for s in (_children(sh, "sheet") if sh is not None else []):
        rid = None
        for k, v in s.attrib.items():
            if _local(k) == "id":
                rid = v
        target = targets.get(rid, "")
        if target.startswith("/"):
            target = target[1:]
        elif not target.startswith("xl/"):
            target = "xl/" + target
        sheets.append((s.get("name", ""), target))
    return sheets, date1904


def _styles(zf):
    st = _xml(zf, "xl/styles.xml")
    date_styles, time_only = set(), set()
    if st is None:
        return date_styles, time_only
    custom = {}
    nf = _find(st, "numFmts")
    if nf is not None:
        for f in _children(nf, "numFmt"):
            try:
                custom[int(f.get("numFmtId"))] = f.get("formatCode", "")
            except (TypeError, ValueError):
                pass
    xfs = _find(st, "cellXfs")
    for i, xf in enumerate(_children(xfs, "xf") if xfs is not None else []):
        try:
            fid = int(xf.get("numFmtId", "0"))
        except ValueError:
            continue
        if fid in custom:
            code = custom[fid]
            if is_date_format(code):
                date_styles.add(i)
                stripped = re.sub(r'"[^"]*"|\\.|\[\$[^\]]*\]', "", code.split(";")[0]).lower()
                if not re.search(r"[ydge]", stripped) and re.search(r"[hs]", stripped):
                    time_only.add(i)
        elif fid in BUILTIN_DATE_IDS:
            date_styles.add(i)
            if fid in BUILTIN_TIME_ONLY:
                time_only.add(i)
    return date_styles, time_only


def read_xlsx(path, sheet=None):
    zf = _open_xlsx(path)
    with zf:
        sheets, date1904 = xlsx_sheets(zf)
        if not sheets:
            raise TableError("Excel ブックにシートがありません。")
        names = [n for n, _ in sheets]
        if sheet in (None, ""):
            idx = 0
        else:
            idx = None
            for i, n in enumerate(names):
                if n == sheet or norm_key(n) == norm_key(sheet):
                    idx = i
                    break
            if idx is None and str(sheet).isdigit() and 1 <= int(sheet) <= len(names):
                idx = int(sheet) - 1
            if idx is None:
                raise TableError("シート「%s」が見つかりません。シート一覧: %s" % (sheet, " / ".join(names)))
        name, target = sheets[idx]
        shared = []
        sst = _xml(zf, "xl/sharedStrings.xml")
        if sst is not None:
            shared = [_string_item(si) for si in _children(sst, "si")]
        date_styles, time_only = _styles(zf)
        try:
            f = zf.open(target)
        except KeyError:
            raise TableError("シート「%s」の本体 (%s) がブック内に見つかりません。" % (name, target))
        rows = []
        with f:
            try:
                row_no = 0
                for _ev, el in ET.iterparse(f, events=("end",)):
                    if _local(el.tag) != "row":
                        continue
                    try:
                        row_no = int(el.get("r"))
                    except (TypeError, ValueError):
                        row_no += 1
                    cells = {}
                    nxt = 0
                    for c in _children(el, "c"):
                        ref = c.get("r")
                        col = _col_index(ref) if ref else nxt
                        nxt = col + 1
                        cells[col] = _cell_value(c, shared, date_styles, time_only, date1904)
                    if cells:
                        width = max(cells) + 1
                        rows.append((row_no, [cells.get(i, "") for i in range(width)]))
                    el.clear()
            except ET.ParseError as e:
                raise TableError("シート「%s」の XML を読めませんでした: %s" % (name, e))
        return rows, {"format": "xlsx", "sheet": name, "sheets": names, "date1904": date1904}


def _cell_value(c, shared, date_styles, time_only, date1904):
    t = c.get("t", "n")
    v = _find(c, "v")
    raw = v.text if v is not None and v.text is not None else ""
    if t == "s":
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return ""
    if t == "inlineStr":
        is_ = _find(c, "is")
        return _string_item(is_) if is_ is not None else ""
    if t == "b":
        return "TRUE" if raw == "1" else "FALSE"
    if t in ("str", "e"):
        return raw
    if t == "d":  # ISO 8601 date cell (strict files)
        dt = parse_date(raw.replace("T", " ").split(".")[0])
        return format_datetime(dt) if dt else raw
    if raw == "":
        return ""
    try:
        num = float(raw)
    except ValueError:
        return raw
    try:
        style = int(c.get("s", "0"))
    except ValueError:
        style = 0
    if style in date_styles:
        try:
            dt = excel_serial_to_datetime(num, date1904)
        except (OverflowError, ValueError):
            return format_number(num)
        if style in time_only or (num < 1 and num >= 0 and not float(num).is_integer()):
            return dt.strftime("%H:%M:%S")
        if float(num).is_integer():
            return dt.strftime("%Y-%m-%d")
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    return format_number(num)


# ---------------------------------------------------------------------- the table

class Table(object):
    def __init__(self, header, rows, row_numbers, meta):
        self.header = header
        self.rows = rows
        self.row_numbers = row_numbers
        self.meta = meta

    def col(self, name, label="列"):
        return find_column(self.header, name, label)


def find_column(header, name, label="列"):
    """Index of a column; exact match first, then a loose (NFKC / case / space) match."""
    if name in header:
        return header.index(name)
    key = norm_key(name)
    for i, h in enumerate(header):
        if norm_key(h) == key:
            return i
    raise TableError("%s「%s」が見つかりません。存在する列: %s" % (label, name, " / ".join(header)))


def try_column(header, name):
    try:
        return find_column(header, name)
    except TableError:
        return None


def _pick_header(records, header_row=None):
    if header_row:
        for pos, (no, r) in enumerate(records):
            if no == header_row:
                return pos
        raise TableError("見出し行 %s 行目が見つかりません。" % header_row)
    window = [(pos, sum(1 for v in r if str(v).strip())) for pos, (_no, r) in enumerate(records[:20])]
    window = [(p, n) for p, n in window if n > 0]
    if not window:
        raise TableError("データが空です (見出し行が見つかりません)。")
    top = max(n for _p, n in window)
    need = max(1, (top + 1) // 2)
    for p, n in window:
        if n >= need:
            return p
    return window[0][0]


def read_table(path, sheet=None, encoding=None, delimiter=None, header_row=None):
    """Read CSV/TSV/XLSX into a Table. Header is the first well-filled row (title rows skipped)."""
    if not os.path.isfile(path):
        raise TableError("ファイルが見つかりません: %s" % path)
    ext = os.path.splitext(path)[1].lower()
    if ext in XLSX_EXT or ext == ".xls":
        records, meta = read_xlsx(path, sheet)
    else:
        with open(path, "rb") as f:
            head = f.read(4)
        if head.startswith(b"PK\x03\x04"):
            records, meta = read_xlsx(path, sheet)
        else:
            records, meta = read_csv(path, encoding, delimiter)
    records = [(no, r) for no, r in records if any(str(v).strip() for v in r)]
    if not records:
        raise TableError("データが空です: %s" % path)
    hp = _pick_header(records, header_row)
    hno, hdr = records[hp]
    data = records[hp + 1:]
    width = max([len(hdr)] + [len(r) for _n, r in data])
    header, seen = [], {}
    for i in range(width):
        h = str(hdr[i]).strip() if i < len(hdr) else ""
        if not h:
            h = "列%d" % (i + 1)
        if h in seen:
            seen[h] += 1
            h = "%s_%d" % (h, seen[h])
        else:
            seen[h] = 1
        header.append(h)
    rows, nums = [], []
    for no, r in data:
        r = [str(v) for v in r] + [""] * (width - len(r))
        rows.append(r)
        nums.append(no)
    meta["header_row"] = hno
    meta["path"] = path
    return Table(header, rows, nums, meta)


def describe_source(t):
    m = t.meta
    if m.get("format") == "xlsx":
        s = "Excel シート「%s」(全 %d シート: %s)" % (m["sheet"], len(m["sheets"]), " / ".join(m["sheets"]))
    else:
        d = {"\t": "タブ", ",": "カンマ", ";": "セミコロン", "|": "縦棒"}.get(m.get("delimiter"), m.get("delimiter"))
        s = "CSV (文字コード %s, 区切り %s)" % (m.get("encoding"), d)
    return "%s / 見出し %d 行目 / データ %d 行 × %d 列" % (s, m.get("header_row", 1), len(t.rows), len(t.header))


# ------------------------------------------------------------------------ writers

def same_file(a, b):
    try:
        return os.path.exists(a) and os.path.exists(b) and os.path.samefile(a, b)
    except OSError:
        return os.path.abspath(a) == os.path.abspath(b)


def check_output_path(out, inputs):
    for p in inputs:
        if p and same_file(out, p):
            raise TableError("出力先が入力ファイルと同じです。入力を上書きしないよう、別の名前を指定してください: %s" % out)
    d = os.path.dirname(os.path.abspath(out))
    if not os.path.isdir(d):
        try:
            os.makedirs(d)
        except OSError as e:
            raise TableError("出力先フォルダを作れませんでした: %s (%s)" % (d, e))


def write_csv(path, header, rows, inputs=()):
    """UTF-8 with BOM so that Excel (Japanese) opens it without garbling."""
    check_output_path(path, inputs)
    try:
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(header)
            for r in rows:
                w.writerow(["" if v is None else v for v in r])
    except OSError as e:
        raise TableError("出力ファイルを書けませんでした: %s (%s)" % (path, e))
    return path


def md_cell(v, width=60):
    s = "" if v is None else str(v)
    s = s.replace("\r\n", " ").replace("\n", " ").replace("\r", " ").replace("|", "\\|")
    if len(s) > width:
        s = s[: width - 1] + "…"
    return s


def markdown_table(header, rows, max_rows=30, width=60, align=None):
    """Markdown table; at most max_rows rows, then a line saying how many were omitted."""
    out = ["| " + " | ".join(md_cell(h, width) for h in header) + " |"]
    seps = []
    for i in range(len(header)):
        seps.append("---:" if align and i < len(align) and align[i] == "r" else "---")
    out.append("| " + " | ".join(seps) + " |")
    shown = rows if max_rows is None or max_rows <= 0 else rows[:max_rows]
    for r in shown:
        out.append("| " + " | ".join(md_cell(v, width) for v in r) + " |")
    if len(rows) > len(shown):
        out.append("")
        out.append("(ほか %d 行は省略。全件は出力 CSV を参照)" % (len(rows) - len(shown)))
    return "\n".join(out)


def default_out(input_path, suffix, out_dir="."):
    stem = os.path.splitext(os.path.basename(input_path))[0] or "output"
    return os.path.join(out_dir, "%s_%s.csv" % (stem, suffix))


def run_main(main):
    """Run a script's main(); user errors print a Japanese message and exit 2, no traceback."""
    try:
        code = main()
    except TableError as e:
        sys.stderr.write("エラー: %s\n" % e)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
    except MemoryError:
        sys.stderr.write("エラー: データが大きすぎてメモリに載りません。行数を絞る (--filter など) か、ファイルを分割してください。\n")
        sys.exit(2)
    sys.exit(code or 0)


def setup_stdout():
    """Force UTF-8 output so that Japanese text survives any sandbox locale."""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
