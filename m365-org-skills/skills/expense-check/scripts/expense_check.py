#!/usr/bin/env python3
"""Check expense / invoice rows against resources/rules.json. Python 3.8+, standard library only.

    python3 scripts/expense_check.py <file.csv|file.xlsx> [--sheet NAME] [--rules resources/rules.json]
                                     [--as-of YYYY-MM-DD] [--out violations.csv] [--max-rows 50]

Prints a Markdown summary to stdout and writes every finding to the violations CSV
(UTF-8 with BOM). Findings are results, not failures: the exit code is 0 when the check
ran, 2 when the input or the rules could not be read.
"""

import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tabular_io as tio  # noqa: E402
from tabular_io import TableError  # noqa: E402

KEYS = ("date", "amount", "category", "payee", "description", "employee", "receipt")
LABEL = {"date": "日付", "amount": "金額", "category": "費目", "payee": "支払先", "description": "摘要",
         "employee": "申請者", "receipt": "領収書"}
SEV = {"error": "エラー", "warn": "注意"}
NO_RECEIPT = {"", "無", "なし", "無し", "未", "未提出", "no", "n", "false", "0", "×", "x", "-"}


def skill_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_rules(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            rules = json.load(f)
    except OSError as e:
        raise TableError("ルールファイルを開けませんでした: %s (%s)" % (path, e))
    except ValueError as e:
        raise TableError("ルールファイル %s の JSON が不正です: %s" % (path, e))
    if not isinstance(rules, dict):
        raise TableError("ルールファイル %s の最上位は { ... } (オブジェクト) にしてください。" % path)
    limits = rules.get("category_limits") or {}
    if not isinstance(limits, dict):
        raise TableError("category_limits は {\"費目\": 上限金額} の形にしてください。")
    for k, v in limits.items():
        if v is not None and tio.parse_number(v) is None:
            raise TableError("category_limits の「%s」の上限 %r が数値ではありません。" % (k, v))
    for k in ("max_age_days", "default_limit", "receipt_required_over"):
        v = rules.get(k)
        if v is not None and tio.parse_number(v) is None:
            raise TableError("%s の値 %r が数値ではありません (使わないときは null)。" % (k, v))
    for k in ("future_date", "nonpositive_amount", "unknown_category", "duplicate"):
        v = rules.get(k, "warn")
        if v not in ("error", "warn", "ignore", None):
            raise TableError("%s は \"error\" / \"warn\" / \"ignore\" のどれかにしてください (現在: %r)。" % (k, v))
    for k in ("forbidden_keywords", "keyword_columns", "duplicate_keys", "required_columns", "required_values", "holidays"):
        v = rules.get(k)
        if v is not None and not isinstance(v, list):
            raise TableError("%s は [ ... ] (配列) にしてください。" % k)
    return rules


def map_columns(header, rules):
    """logical key -> column index (or None). columns{} first, then column_aliases{}."""
    names = rules.get("columns") or {}
    aliases = rules.get("column_aliases") or {}
    found = {}
    for key in KEYS:
        cands = []
        if names.get(key):
            cands.append(names[key])
        cands += [a for a in (aliases.get(key) or []) if a]
        idx = None
        for c in cands:
            idx = tio.try_column(header, c)
            if idx is not None:
                break
        found[key] = idx
    return found


def as_date(text):
    dt = tio.parse_date(text)
    return dt.date() if dt else None


def check(table, rules, as_of):
    cols = map_columns(table.header, rules)
    findings = []  # (row_no, sev, check, column, value, message)
    file_notes = []
    for key in rules.get("required_columns") or []:
        if cols.get(key) is None:
            name = (rules.get("columns") or {}).get(key, key)
            file_notes.append(("エラー", "必須列がない", "列「%s」(%s) が見つかりません。関連するチェックは行っていません。"
                               % (name, LABEL.get(key, key))))
    limits = {}
    for k, v in (rules.get("category_limits") or {}).items():
        limits[tio.norm_key(k)] = (k, tio.parse_number(v) if v is not None else None)
    default_limit = tio.parse_number(rules.get("default_limit")) if rules.get("default_limit") is not None else None
    words = [w for w in (rules.get("forbidden_keywords") or []) if str(w).strip()]
    kw_cols = [k for k in (rules.get("keyword_columns") or ["description"]) if cols.get(k) is not None]
    max_age = rules.get("max_age_days")
    max_age = int(tio.parse_number(max_age)) if max_age is not None else None
    receipt_over = rules.get("receipt_required_over")
    receipt_over = tio.parse_number(receipt_over) if receipt_over is not None else None
    holidays = set()
    for h in rules.get("holidays") or []:
        d = as_date(h)
        if d is None:
            raise TableError("holidays の「%s」を日付として読めません (YYYY-MM-DD で書いてください)。" % h)
        holidays.add(d)
    dup_keys = [k for k in (rules.get("duplicate_keys") or []) if k in KEYS]
    sev_future = rules.get("future_date", "error")
    sev_nonpos = rules.get("nonpositive_amount", "warn")
    sev_unknown = rules.get("unknown_category", "warn")
    sev_dup = rules.get("duplicate", "warn")

    def val(r, key):
        i = cols.get(key)
        return r[i].strip() if i is not None else ""

    dup_groups = {}
    for no, r in zip(table.row_numbers, table.rows):
        def add(sev, name, key, msg):
            findings.append((no, sev, name, LABEL.get(key, key) if key else "", val(r, key) if key else "", msg))

        for key in rules.get("required_values") or []:
            if cols.get(key) is not None and not val(r, key):
                add("エラー", "必須項目が空欄", key, "%s が入力されていません" % LABEL.get(key, key))
        amount = None
        if cols["amount"] is not None and val(r, "amount"):
            amount = tio.parse_number(val(r, "amount"))
            if amount is None:
                add("エラー", "金額が数値でない", "amount", "金額を数値として読めません")
            elif amount <= 0 and sev_nonpos in SEV:
                add(SEV[sev_nonpos], "金額が 0 以下", "amount", "金額が 0 以下です (返金・訂正なら摘要に理由を記載)")
        d = None
        if cols["date"] is not None and val(r, "date"):
            d = as_date(val(r, "date"))
            if d is None:
                add("エラー", "日付が不正", "date", "日付として読めません (例: 2026-04-01)")
            else:
                age = (as_of - d).days
                if age < 0 and sev_future in SEV:
                    add(SEV[sev_future], "未来の日付", "date", "基準日 %s より後の日付です" % as_of.isoformat())
                elif max_age is not None and age > max_age:
                    add("エラー", "申請期限切れ", "date", "利用日から %d 日経過 (期限 %d 日)" % (age, max_age))
                if rules.get("flag_weekends") and d.weekday() >= 5:
                    add("注意", "土日の利用", "date", "%s曜日の利用です" % "月火水木金土日"[d.weekday()])
                if rules.get("flag_holidays") and d in holidays:
                    add("注意", "祝日の利用", "date", "祝日・休日の利用です")
        cat = val(r, "category")
        if amount is not None and cols["category"] is not None and cat:
            hit = limits.get(tio.norm_key(cat))
            limit = hit[1] if hit else default_limit
            if hit is None and limits and sev_unknown in SEV:
                add(SEV[sev_unknown], "上限未設定の費目", "category", "費目「%s」はルールに上限がありません" % cat)
            if limit is not None and amount > limit:
                add("エラー", "上限超過", "amount", "%s の上限 %s 円を %s 円超過" % (
                    cat, "{:,}".format(int(limit)) if float(limit).is_integer() else limit,
                    "{:,.0f}".format(amount - limit)))
        if receipt_over is not None and amount is not None and amount > receipt_over and cols["receipt"] is not None:
            if tio.norm_key(val(r, "receipt")) in NO_RECEIPT:
                add("エラー", "領収書なし", "receipt", "%s 円を超える支出に領収書がありません" % "{:,.0f}".format(receipt_over))
        for key in kw_cols:
            text = tio.norm_key(val(r, key))
            hits = [w for w in words if tio.norm_key(w) in text]
            if hits:
                add("エラー", "禁止語を含む", key, "禁止語: %s" % "、".join(hits))
        if dup_keys and all(cols.get(k) is not None for k in dup_keys) and sev_dup in SEV:
            parts = []
            for k in dup_keys:
                v = val(r, k)
                if k == "date":
                    v = d.isoformat() if d else ""
                elif k == "amount":
                    v = tio.format_number(amount) if amount is not None else ""
                else:
                    v = tio.norm_key(v)
                parts.append(v)
            if all(parts):
                dup_groups.setdefault(tuple(parts), []).append(no)

    for nos in dup_groups.values():
        if len(nos) > 1:
            for no in nos:
                others = ", ".join(str(n) for n in nos if n != no)
                findings.append((no, SEV[sev_dup], "重複の疑い", "/".join(LABEL[k] for k in dup_keys), "",
                                 "%s が同じ行があります (行 %s)" % ("・".join(LABEL[k] for k in dup_keys), others)))
    order = {"エラー": 0, "注意": 1}
    findings.sort(key=lambda f: (f[0], order.get(f[1], 2), f[2]))
    return cols, findings, file_notes


def main(argv=None):
    tio.setup_stdout()
    ap = argparse.ArgumentParser(description="経費・請求データのルールチェック")
    ap.add_argument("input", help="入力ファイル (.csv .tsv .xlsx)")
    ap.add_argument("--rules", default=os.path.join(skill_root(), "resources", "rules.json"),
                    help="ルールファイル (既定: resources/rules.json)")
    ap.add_argument("--sheet", help="Excel のシート名または番号")
    ap.add_argument("--encoding", help="CSV の文字コードを強制 (例: cp932)")
    ap.add_argument("--header-row", type=int, help="見出し行の行番号 (既定: 自動)")
    ap.add_argument("--as-of", help="期限・未来日付の基準日 YYYY-MM-DD (既定: ルールの reference_date、なければ今日)")
    ap.add_argument("--out", help="指摘一覧 CSV (既定: <入力名>_violations.csv)")
    ap.add_argument("--max-rows", type=int, default=50, help="Markdown に表示する指摘の最大行数")
    args = ap.parse_args(argv)

    rules = load_rules(args.rules)
    as_of_text = args.as_of or rules.get("reference_date")
    if as_of_text:
        as_of = as_date(as_of_text)
        if as_of is None:
            raise TableError("基準日「%s」を日付として読めません (YYYY-MM-DD)。" % as_of_text)
    else:
        as_of = datetime.date.today()
    table = tio.read_table(args.input, args.sheet, args.encoding, None, args.header_row)
    cols, findings, file_notes = check(table, rules, as_of)
    out = args.out or tio.default_out(args.input, "violations")

    def cell(r_no, key):
        i = cols.get(key)
        return table.rows[index[r_no]][i] if i is not None and r_no in index else ""

    index = {no: k for k, no in enumerate(table.row_numbers)}
    header = ["行", "重要度", "チェック", "列", "値", "内容", "日付", "金額", "費目", "支払先", "申請者"]
    rows = [[no, sev, name, col, v, msg] + [cell(no, k) for k in ("date", "amount", "category", "payee", "employee")]
            for no, sev, name, col, v, msg in findings]
    rows = [["(ファイル)", sev, name, "", "", msg] + [""] * 5 for sev, name, msg in file_notes] + rows
    tio.write_csv(out, header, rows, inputs=[args.input, args.rules])

    err_rows = {f[0] for f in findings if f[1] == "エラー"}
    warn_rows = {f[0] for f in findings if f[1] == "注意"} - err_rows
    counts = {}
    for f in findings:
        counts[(f[2], f[1])] = counts.get((f[2], f[1]), 0) + 1

    lines = ["## 経費チェック結果", "",
             "- 入力: %s (%s)" % (os.path.basename(args.input), tio.describe_source(table)),
             "- ルール: %s" % os.path.basename(args.rules),
             "- 基準日: %s%s" % (as_of.isoformat(), "" if as_of_text else " (今日)"),
             "- 列の対応: " + ", ".join("%s=%s" % (LABEL[k], table.header[i] if i is not None else "(なし)")
                                    for k, i in cols.items()),
             "",
             "### 概要", "",
             "- 対象 %d 行のうち、エラーあり %d 行、注意のみ %d 行、指摘なし %d 行" % (
                 len(table.rows), len(err_rows), len(warn_rows), len(table.rows) - len(err_rows) - len(warn_rows))]
    for sev, name, msg in file_notes:
        lines.append("- **%s** %s: %s" % (sev, name, msg))
    if counts:
        lines += ["", "### チェック別の件数", ""]
        lines.append(tio.markdown_table(["チェック", "重要度", "件数"],
                                        [[n, s, c] for (n, s), c in sorted(counts.items(), key=lambda kv: -kv[1])],
                                        None, align=["l", "l", "r"]))
        lines += ["", "### 指摘一覧", ""]
        lines.append(tio.markdown_table(header[:6] + ["金額", "支払先"],
                                        [r[:6] + [r[7], r[9]] for r in rows if r[0] != "(ファイル)"], args.max_rows))
    else:
        lines += ["", "ルールに反する行は見つかりませんでした。"]
    limits = rules.get("category_limits") or {}
    lines += ["", "### 適用したルール", "",
              "- 費目別上限: " + (", ".join("%s %s 円" % (k, v) for k, v in limits.items()) or "なし"),
              "- 申請期限: %s" % ("利用日から %s 日以内" % rules.get("max_age_days") if rules.get("max_age_days") is not None else "なし"),
              "- 禁止語: " + ("、".join(rules.get("forbidden_keywords") or []) or "なし"),
              "- 重複判定: " + ("・".join(LABEL.get(k, k) for k in rules.get("duplicate_keys") or []) or "なし"),
              "- 土日の指摘: %s / 祝日の指摘: %s" % ("する" if rules.get("flag_weekends") else "しない",
                                            "する" if rules.get("flag_holidays") else "しない"),
              "", "- 指摘一覧 CSV: %s (%d 件, UTF-8 BOM 付き)" % (out, len(rows))]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    tio.run_main(main)
