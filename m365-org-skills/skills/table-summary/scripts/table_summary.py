#!/usr/bin/env python3
"""Profile, filter and pivot a CSV / TSV / XLSX table. Python 3.8+, standard library only.

Examples (run from the skill root):
    python3 scripts/table_summary.py data.xlsx --list-sheets
    python3 scripts/table_summary.py data.csv --profile --out profile.csv
    python3 scripts/table_summary.py data.xlsx --sheet 売上 --group-by 部署 --sum 金額 --count --out pivot.csv
    python3 scripts/table_summary.py data.csv --filter "地域=関東" --filter "金額>=10000" --out filtered.csv

The Markdown report goes to stdout; --out writes the full result as UTF-8 (BOM) CSV.
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tabular_io as tio  # noqa: E402
from tabular_io import TableError  # noqa: E402

OPS = ("!=", ">=", "<=", "=", ">", "<", "~")


def parse_filter(expr, header):
    m = re.match(r"^(.+?)(!=|>=|<=|=|>|<|~)(.*)$", expr)
    if not m:
        raise TableError("絞り込み条件「%s」の形式が不正です。「列名=値」「列名>=10000」「列名~含む文字」のように指定してください。" % expr)
    col = tio.find_column(header, m.group(1).strip(), "絞り込みの列")
    return col, m.group(2), m.group(3).strip(), expr


def match_filter(value, op, target):
    if op == "~":
        return tio.norm_key(target) in tio.norm_key(value)
    # The target decides the comparison: a number compares numbers, a date compares dates.
    # A cell that does not parse as the same kind never satisfies an ordering condition.
    b = tio.parse_number(target)
    if b is not None:
        a = tio.parse_number(value)
    else:
        b = tio.parse_date(target)
        a = tio.parse_date(value) if b is not None else None
    if b is None or a is None:
        if op in (">=", "<=", ">", "<") and b is not None:
            return False
        a, b = tio.nfkc(value).strip().lower(), tio.nfkc(target).strip().lower()
    if op == "=":
        return a == b
    if op == "!=":
        return a != b
    if isinstance(a, str) != isinstance(b, str):
        return False
    try:
        return {">=": a >= b, "<=": a <= b, ">": a > b, "<": a < b}[op]
    except TypeError:
        return False


def apply_filters(table, filters):
    parsed = [parse_filter(f, table.header) for f in filters]
    rows, nums = [], []
    for no, r in zip(table.row_numbers, table.rows):
        if all(match_filter(r[c], op, v) for c, op, v, _e in parsed):
            rows.append(r)
            nums.append(no)
    return rows, nums


def guess_type(values):
    """('数値'|'日付'|'文字列'|'空', count of values that do not fit)."""
    if not values:
        return "空", 0
    nums = sum(1 for v in values if tio.parse_number(v) is not None)
    if nums >= 0.9 * len(values):
        return "数値", len(values) - nums
    dates = sum(1 for v in values if tio.parse_date(v) is not None)
    if dates >= 0.9 * len(values):
        return "日付", len(values) - dates
    return "文字列", 0


def profile(header, rows, top_n):
    out = []
    for i, h in enumerate(header):
        col = [r[i] for r in rows]
        vals = [v for v in col if str(v).strip()]
        kind, misfit = guess_type(vals)
        counts = {}
        for v in vals:
            counts[v] = counts.get(v, 0) + 1
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:top_n]
        mn = mx = total = mean = ""
        if kind == "数値":
            ns = [n for n in (tio.parse_number(v) for v in vals) if n is not None]
            if ns:
                mn, mx = tio.format_number(min(ns)), tio.format_number(max(ns))
                total = tio.format_number(round(sum(ns), 10))
                mean = tio.format_number(round(sum(ns) / len(ns), 4))
        elif kind == "日付":
            ds = [d for d in (tio.parse_date(v) for v in vals) if d is not None]
            if ds:
                mn, mx = tio.format_datetime(min(ds)), tio.format_datetime(max(ds))
        note = ("%s以外 %d 件" % (kind, misfit)) if misfit else ""
        out.append([h, kind, len(vals), len(col) - len(vals), len(counts), mn, mx, total, mean,
                    ", ".join("%s (%d)" % (tio.md_cell(k, 30), n) for k, n in top), note])
    return ["列名", "推定型", "非空", "空欄", "種類数", "最小", "最大", "合計", "平均", "上位の値 (件数)", "備考"], out


PERIODS = {"month": ("%Y-%m", "月"), "月": ("%Y-%m", "月"), "year": ("%Y", "年"), "年": ("%Y", "年"),
           "day": ("%Y-%m-%d", "日"), "日": ("%Y-%m-%d", "日")}


def group_spec(header, spec):
    """'部署' -> (index, None, '部署'); '日付:月' -> (index, '%Y-%m', '日付(月)')."""
    name, period = spec, None
    if ":" in spec:
        head, tail = spec.rsplit(":", 1)
        if tail.strip().lower() in PERIODS and tio.try_column(header, spec) is None:
            name, period = head.strip(), PERIODS[tail.strip().lower()]
    i = tio.find_column(header, name, "グループ化の列")
    return i, period[0] if period else None, "%s(%s)" % (header[i], period[1]) if period else header[i]


def group_value(value, fmt):
    v = value.strip()
    if fmt is None:
        return v or "(空欄)"
    d = tio.parse_date(v)
    return d.strftime(fmt) if d else ("(空欄)" if not v else "(日付以外)")


def pivot(header, rows, group_cols, sum_cols, mean_cols, want_count):
    specs = [group_spec(header, g) for g in group_cols]
    gidx = [i for i, _f, _l in specs]
    sidx = [tio.find_column(header, s, "合計する列") for s in sum_cols]
    midx = [tio.find_column(header, s, "平均する列") for s in mean_cols]
    groups, order = {}, []
    skipped = {}
    for r in rows:
        key = tuple(group_value(r[i], f) for i, f, _l in specs)
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"n": 0, "sum": [0.0] * len(sidx), "msum": [0.0] * len(midx), "mn": [0] * len(midx)}
            order.append(key)
        g["n"] += 1
        for j, i in enumerate(sidx):
            v = tio.parse_number(r[i])
            if v is None:
                if r[i].strip():
                    skipped[header[i]] = skipped.get(header[i], 0) + 1
            else:
                g["sum"][j] += v
        for j, i in enumerate(midx):
            v = tio.parse_number(r[i])
            if v is None:
                if r[i].strip():
                    skipped[header[i]] = skipped.get(header[i], 0) + 1
            else:
                g["msum"][j] += v
                g["mn"][j] += 1
    if any(f for _i, f, _l in specs):
        order.sort()  # a period grouping reads best in time order
    elif sidx:
        order.sort(key=lambda k: -groups[k]["sum"][0])
    elif want_count:
        order.sort(key=lambda k: -groups[k]["n"])
    out_header = [label for _i, _f, label in specs]
    if want_count:
        out_header.append("件数")
    out_header += ["合計(%s)" % header[i] for i in sidx]
    out_header += ["平均(%s)" % header[i] for i in midx]
    out = []
    for k in order:
        g = groups[k]
        row = list(k)
        if want_count:
            row.append(g["n"])
        row += [tio.format_number(round(s, 10)) for s in g["sum"]]
        row += [tio.format_number(round(s / n, 4)) if n else "" for s, n in zip(g["msum"], g["mn"])]
        out.append(row)
    totals = {"件数": sum(groups[k]["n"] for k in order)}
    for j, i in enumerate(sidx):
        totals["合計(%s)" % header[i]] = tio.format_number(round(sum(groups[k]["sum"][j] for k in order), 10))
    return out_header, out, skipped, totals


def main(argv=None):
    tio.setup_stdout()
    ap = argparse.ArgumentParser(description="CSV / TSV / XLSX の集計 (プロファイル・絞り込み・ピボット)")
    ap.add_argument("input", help="入力ファイル (.csv .tsv .txt .xlsx)")
    ap.add_argument("--sheet", help="Excel のシート名または 1 始まりの番号 (既定: 先頭シート)")
    ap.add_argument("--list-sheets", action="store_true", help="シート一覧だけを表示")
    ap.add_argument("--encoding", help="CSV の文字コードを強制 (例: cp932, utf-8)")
    ap.add_argument("--delimiter", help="CSV の区切り文字を強制 (例: , または tab)")
    ap.add_argument("--header-row", type=int, help="見出し行の行番号 (既定: 自動。タイトル行を飛ばす)")
    ap.add_argument("--profile", action="store_true", help="列ごとの型・件数・最小/最大/合計/平均・上位の値")
    ap.add_argument("--group-by", action="append", default=[], metavar="COL",
                    help="グループ化する列 (複数可)。日付列は「日付:月」「日付:年」「日付:日」で期間ごとにまとめる")
    ap.add_argument("--sum", action="append", default=[], metavar="COL", help="合計する列 (複数可)")
    ap.add_argument("--mean", action="append", default=[], metavar="COL", help="平均する列 (複数可)")
    ap.add_argument("--count", action="store_true", help="グループごとの件数を出す")
    ap.add_argument("--filter", action="append", default=[], metavar="EXPR",
                    help='絞り込み 例: "部署=営業" "金額>=10000" "摘要~交通" (複数指定は AND)')
    ap.add_argument("--top", type=int, default=5, help="プロファイルで示す上位の値の数 (既定 5)")
    ap.add_argument("--max-rows", type=int, default=30, help="Markdown に表示する最大行数 (既定 30)")
    ap.add_argument("--out", help="結果を書き出す CSV (UTF-8 BOM 付き。Excel でそのまま開ける)")
    args = ap.parse_args(argv)

    if args.list_sheets:
        ext = os.path.splitext(args.input)[1].lower()
        if ext not in tio.XLSX_EXT:
            print("CSV/TSV にはシートがありません: %s" % args.input)
            return 0
        if not os.path.isfile(args.input):
            raise TableError("ファイルが見つかりません: %s" % args.input)
        zf = tio._open_xlsx(args.input)
        with zf:
            sheets, _d = tio.xlsx_sheets(zf)
        for i, (n, _t) in enumerate(sheets, 1):
            print("%d\t%s" % (i, n))
        return 0

    table = tio.read_table(args.input, args.sheet, args.encoding, args.delimiter, args.header_row)
    rows, nums = apply_filters(table, args.filter) if args.filter else (table.rows, table.row_numbers)

    lines = ["## 表データの集計結果", "", "- 入力: %s" % os.path.basename(args.input),
             "- 形式: %s" % tio.describe_source(table)]
    if args.filter:
        lines.append("- 絞り込み: %s → %d 行 (全 %d 行中)" % (" かつ ".join(args.filter), len(rows), len(table.rows)))
    lines.append("")

    if args.group_by:
        want_count = args.count or not (args.sum or args.mean)
        h, out, skipped, totals = pivot(table.header, rows, args.group_by, args.sum, args.mean, want_count)
        lines.append("### %s ごとの集計 (%d グループ)" % (" × ".join(args.group_by), len(out)))
        lines.append("")
        lines.append(tio.markdown_table(h, out, args.max_rows, align=["l"] * len(args.group_by) + ["r"] * 99))
        lines.append("")
        lines.append("- 総計: " + ", ".join("%s %s" % (k, v) for k, v in totals.items() if k != "件数" or want_count))
        for col, n in skipped.items():
            lines.append("- 注意: 列「%s」の %d 件は数値として読めず集計から除外しました" % (col, n))
        result_header, result_rows = h, out
    elif args.sum or args.mean:
        raise TableError("--sum / --mean は --group-by と一緒に指定してください (全体の合計だけなら --profile で確認できます)。")
    elif args.profile or not args.filter:
        h, out = profile(table.header, rows, args.top)
        lines.append("### 列のプロファイル (%d 列)" % len(out))
        lines.append("")
        lines.append(tio.markdown_table(h, out, args.max_rows, width=80))
        result_header, result_rows = h, out
    else:
        lines.append("### 絞り込み結果 (%d 行)" % len(rows))
        lines.append("")
        h = ["元の行"] + table.header
        result_rows = [[n] + r for n, r in zip(nums, rows)]
        lines.append(tio.markdown_table(h, result_rows, args.max_rows))
        result_header = h

    if args.out:
        tio.write_csv(args.out, result_header, result_rows, inputs=[args.input])
        lines.append("")
        lines.append("- 出力ファイル: %s (%d 行, UTF-8 BOM 付き CSV)" % (args.out, len(result_rows)))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    tio.run_main(main)
