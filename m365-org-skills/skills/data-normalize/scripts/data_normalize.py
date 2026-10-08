#!/usr/bin/env python3
"""Normalize a roster / customer list and find duplicate candidates. Python 3.8+, stdlib only.

    python3 scripts/data_normalize.py <file.csv|file.xlsx> [--sheet NAME] [--out-dir DIR]
        [--rule "列名=phone"]... [--dup-key "氏名+電話番号"]... [--rules resources/normalize-rules.json]

Writes, without touching the input:
    <name>_normalized.csv   same columns and row order, values normalized
    <name>_changes.csv      one line per changed or doubtful cell (row, column, before, after)
    <name>_duplicates.csv   duplicate candidate groups
and prints a Markdown summary.

Rules: text (全角英数→半角, 半角カナ→全角, 空白の整理), katakana / hiragana (text + かな変換),
phone, postal, email, nfkc (Unicode NFKC 全体), none (触らない).
"""

import argparse
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tabular_io as tio  # noqa: E402
from tabular_io import TableError  # noqa: E402

RULES = ("text", "katakana", "hiragana", "phone", "postal", "email", "nfkc", "none")
RULE_LABEL = {"text": "文字の整形", "katakana": "カタカナ化", "hiragana": "ひらがな化", "phone": "電話番号",
              "postal": "郵便番号", "email": "メールアドレス", "nfkc": "NFKC", "none": "変更しない"}

_FULL_ASCII = {c: c - 0xFEE0 for c in range(0xFF01, 0xFF5F)}
_FULL_ASCII[0x3000] = 0x20
_HALF_KANA = re.compile("[｡-ﾟ]+")
_SPACES = re.compile(r"[\s　]+")
_HYPHENS = "‐‑‒–—―−ーｰ－⁃﹣"


def skill_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm_text(v):
    """全角英数記号→半角, 半角カナ→全角カナ (濁点結合), 全角空白→半角, 前後空白除去, 連続空白→1つ."""
    s = v.translate(_FULL_ASCII)
    s = _HALF_KANA.sub(lambda m: unicodedata.normalize("NFKC", m.group(0)), s)
    return _SPACES.sub(" ", s).strip()


def to_katakana(s):
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in s)


def to_hiragana(s):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def norm_phone(v):
    """Return (value, note). note is '' when fine, otherwise a reason to review."""
    s = norm_text(v)
    if not s:
        return s, ""
    if re.search(r"内線|ext|ｘ|x\d|#", s, re.I):
        return s, "内線などを含むため変更していません"
    t = s
    for h in _HYPHENS:
        t = t.replace(h, "-")
    if re.match(r"^\+\s*81", t):  # +81 3-1234-5678, +81(0)3-..., +81-90-...
        rest = re.sub(r"^\+\s*81[\s\-]*", "", t)
        rest = re.sub(r"^\(0\)[\s\-]*", "", rest)
        rest = rest.lstrip("-( )")
        t = rest if rest.startswith("0") else "0" + rest
    groups = [g for g in re.split(r"[^0-9]+", t) if g]
    digits = "".join(groups)
    if re.search(r"[^0-9\-()\s.+]", t):
        return s, "数字と区切り以外の文字を含むため変更していません"
    if not digits.startswith("0"):
        if len(digits) in (9, 10):
            return s, "先頭の 0 が欠落している可能性があります (Excel で数値になった?)"
        return s, "電話番号として桁数が合いません"
    n = len(digits)
    if n == 11 and digits[:3] in ("070", "080", "090", "050", "060", "020"):
        return "%s-%s-%s" % (digits[:3], digits[3:7], digits[7:]), ""
    if n == 11 and digits.startswith("0800"):
        return "%s-%s-%s" % (digits[:4], digits[4:7], digits[7:]), ""
    if n == 10 and digits[:4] in ("0120", "0570", "0990"):
        return "%s-%s-%s" % (digits[:4], digits[4:7], digits[7:]), ""
    if n == 10 and digits[:2] in ("03", "06"):
        return "%s-%s-%s" % (digits[:2], digits[2:6], digits[6:]), ""
    if n == 10:
        if len(groups) == 3 and 2 <= len(groups[0]) <= 5 and len(groups[2]) == 4:
            return "-".join(groups), ""
        return digits, "市外局番の区切りを判定できないため数字のみにしました"
    return s, "電話番号として桁数が合いません (%d 桁)" % n


def norm_postal(v):
    s = norm_text(v).replace("〒", "").strip()
    if not s:
        return s, ""
    t = s
    for h in _HYPHENS:
        t = t.replace(h, "-")
    if re.search(r"[^0-9\-\s]", t):
        return norm_text(v), "数字とハイフン以外を含むため変更していません"
    digits = re.sub(r"\D", "", t)
    if len(digits) == 7:
        return "%s-%s" % (digits[:3], digits[3:]), ""
    if len(digits) in (5, 6):
        return norm_text(v), "7 桁ではありません (先頭の 0 が欠落している可能性)"
    return norm_text(v), "郵便番号として桁数が合いません (%d 桁)" % len(digits)


def norm_email(v):
    s = re.sub(r"\s+", "", unicodedata.normalize("NFKC", v)).lower()
    if not s:
        return s, ""
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s.]+$", s):
        return s, "メールアドレスの形式ではありません"
    return s, ""


def apply_rule(rule, v):
    if rule == "none":
        return v, ""
    if rule == "text":
        return norm_text(v), ""
    if rule == "katakana":
        return to_katakana(norm_text(v)), ""
    if rule == "hiragana":
        return to_hiragana(norm_text(v)), ""
    if rule == "nfkc":
        return _SPACES.sub(" ", unicodedata.normalize("NFKC", v)).strip(), ""
    if rule == "phone":
        return norm_phone(v)
    if rule == "postal":
        return norm_postal(v)
    if rule == "email":
        return norm_email(v)
    raise TableError("未知の規則「%s」です。使える規則: %s" % (rule, " / ".join(RULES)))


def compare_key(rule, v):
    if rule == "phone":
        d = re.sub(r"\D", "", v)
        return d
    return tio.norm_key(v)


def load_rules(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except OSError as e:
        raise TableError("規則ファイルを開けませんでした: %s (%s)" % (path, e))
    except ValueError as e:
        raise TableError("規則ファイル %s の JSON が不正です: %s" % (path, e))
    if not isinstance(data, dict):
        raise TableError("規則ファイルの最上位は { ... } にしてください。")
    for name, rule in (data.get("column_rules") or {}).items():
        if rule not in RULES:
            raise TableError("column_rules の「%s」の規則「%s」は使えません。使える規則: %s" % (name, rule, " / ".join(RULES)))
    for item in data.get("auto_detect") or []:
        if not isinstance(item, dict) or item.get("rule") not in RULES:
            raise TableError("auto_detect の要素 %r が不正です ({\"pattern\": ..., \"rule\": ...})。" % (item,))
        try:
            re.compile(item.get("pattern", ""))
        except re.error as e:
            raise TableError("auto_detect の正規表現「%s」が不正です: %s" % (item.get("pattern"), e))
    if data.get("default_rule", "text") not in RULES:
        raise TableError("default_rule「%s」は使えません。" % data.get("default_rule"))
    return data


def decide_rules(header, rules, overrides):
    decided = []
    explicit = rules.get("column_rules") or {}
    for h in header:
        rule, why = None, ""
        for name, r in overrides.items():
            if tio.norm_key(name) == tio.norm_key(h):
                rule, why = r, "指定"
        if rule is None:
            for name, r in explicit.items():
                if tio.norm_key(name) == tio.norm_key(h):
                    rule, why = r, "規則ファイル"
        if rule is None:
            for item in rules.get("auto_detect") or []:
                if re.search(item["pattern"], h):
                    rule, why = item["rule"], "列名から推定"
                    break
        if rule is None:
            rule, why = rules.get("default_rule", "text"), "既定"
        decided.append((rule, why))
    return decided


def parse_overrides(items, header):
    out = {}
    for it in items:
        if "=" not in it:
            raise TableError("--rule は「列名=規則」の形で指定してください (例: --rule \"TEL=phone\")。")
        name, rule = it.rsplit("=", 1)
        name, rule = name.strip(), rule.strip().lower()
        if rule not in RULES:
            raise TableError("規則「%s」は使えません。使える規則: %s" % (rule, " / ".join(RULES)))
        tio.find_column(header, name, "--rule の列")
        out[name] = rule
    return out


def key_sets(header, rules, dup_args):
    sets = []
    if dup_args:
        for d in dup_args:
            names = [n.strip() for n in re.split(r"[+,]", d) if n.strip()]
            sets.append(tuple(tio.find_column(header, n, "重複判定の列") for n in names))
    else:
        for names in rules.get("duplicate_keys") or []:
            if isinstance(names, str):
                names = [names]
            idx = [tio.try_column(header, n) for n in names]
            if idx and all(i is not None for i in idx):
                sets.append(tuple(idx))
    uniq = []
    for s in sets:
        if s not in uniq:
            uniq.append(s)
    return uniq


def main(argv=None):
    tio.setup_stdout()
    ap = argparse.ArgumentParser(description="名簿・顧客データの正規化と重複候補の検出")
    ap.add_argument("input", help="入力ファイル (.csv .tsv .xlsx)")
    ap.add_argument("--sheet", help="Excel のシート名または番号")
    ap.add_argument("--encoding", help="CSV の文字コードを強制 (例: cp932)")
    ap.add_argument("--header-row", type=int, help="見出し行の行番号 (既定: 自動)")
    ap.add_argument("--rules", default=os.path.join(skill_root(), "resources", "normalize-rules.json"),
                    help="規則ファイル (既定: resources/normalize-rules.json)")
    ap.add_argument("--rule", action="append", default=[], metavar="列名=規則",
                    help="列の規則を指定 (%s)" % " / ".join(RULES))
    ap.add_argument("--dup-key", action="append", default=[], metavar="列A+列B",
                    help="重複判定に使う列の組 (複数可。既定は規則ファイルの duplicate_keys のうち存在する組)")
    ap.add_argument("--no-dup", action="store_true", help="重複候補の検出をしない")
    ap.add_argument("--out-dir", default=".", help="出力先フォルダ (既定: 現在のフォルダ)")
    ap.add_argument("--max-rows", type=int, default=20, help="Markdown に表示する最大行数")
    args = ap.parse_args(argv)

    rules = load_rules(args.rules)
    table = tio.read_table(args.input, args.sheet, args.encoding, None, args.header_row)
    header = table.header
    decided = decide_rules(header, rules, parse_overrides(args.rule, header))

    cleaned, changes = [], []
    per_col = [[0, 0] for _ in header]  # changed, review
    for no, r in zip(table.row_numbers, table.rows):
        out = []
        for i, v in enumerate(r):
            rule = decided[i][0]
            nv, note = apply_rule(rule, v)
            out.append(nv)
            if nv != v:
                per_col[i][0] += 1
            if note:
                per_col[i][1] += 1
            if nv != v or note:
                changes.append([no, header[i], v, nv, RULE_LABEL[rule], "要確認" if note else "変更", note])
        cleaned.append(out)

    stem = os.path.splitext(os.path.basename(args.input))[0] or "data"
    out_clean = os.path.join(args.out_dir, "%s_normalized.csv" % stem)
    out_changes = os.path.join(args.out_dir, "%s_changes.csv" % stem)
    out_dups = os.path.join(args.out_dir, "%s_duplicates.csv" % stem)
    inputs = [args.input, args.rules]
    tio.write_csv(out_clean, header, cleaned, inputs)
    ch_header = ["行", "列", "変更前", "変更後", "規則", "種別", "備考"]
    tio.write_csv(out_changes, ch_header, changes, inputs)

    groups = []
    sets = [] if args.no_dup else key_sets(header, rules, args.dup_key)
    if not args.no_dup:
        full = tuple(range(len(header)))  # rows identical in every column; checked first
        sets = [full] + [s for s in sets if s != full]
        reported = set()
        for ks in sets:
            buckets, order = {}, []
            for no, r in zip(table.row_numbers, cleaned):
                parts = tuple(compare_key(decided[i][0], r[i]) for i in ks)
                if not all(parts):
                    if len(ks) != len(header) or not any(parts):
                        continue
                if parts not in buckets:
                    buckets[parts] = []
                    order.append(parts)
                buckets[parts].append(no)
            label = "全列一致" if len(ks) == len(header) and len(ks) > 1 else "+".join(header[i] for i in ks)
            for parts in order:
                nos = buckets[parts]
                if len(nos) > 1 and frozenset(nos) not in reported:
                    reported.add(frozenset(nos))
                    groups.append((label, ks, nos))
    index = {no: k for k, no in enumerate(table.row_numbers)}
    dup_rows = []
    for gi, (label, ks, nos) in enumerate(groups, 1):
        for no in nos:
            r = cleaned[index[no]]
            dup_rows.append([gi, label, " / ".join(r[i] for i in ks if len(ks) < len(header)) or "(全列)", no] + r)
    if not args.no_dup:
        tio.write_csv(out_dups, ["グループ", "判定キー", "キーの値", "行"] + header, dup_rows, inputs)

    lines = ["## 名簿データの正規化結果", "",
             "- 入力: %s (%s)" % (os.path.basename(args.input), tio.describe_source(table)),
             "- 入力ファイルは変更していません。行番号は元ファイルの行番号です。", "",
             "### 列ごとの規則と件数", ""]
    lines.append(tio.markdown_table(
        ["列", "規則", "決め方", "変更", "要確認"],
        [[h, RULE_LABEL[decided[i][0]], decided[i][1], per_col[i][0], per_col[i][1]] for i, h in enumerate(header)],
        None, align=["l", "l", "l", "r", "r"]))
    review = [c for c in changes if c[5] == "要確認"]
    if review:
        lines += ["", "### 要確認のセル (%d 件)" % len(review), ""]
        lines.append(tio.markdown_table(["行", "列", "値", "理由"], [[c[0], c[1], c[2], c[6]] for c in review], args.max_rows))
    done = [c for c in changes if c[5] == "変更"]
    if done:
        lines += ["", "### 変更の例 (全 %d 件)" % len(done), ""]
        lines.append(tio.markdown_table(["行", "列", "変更前", "変更後"], [c[:4] for c in done], min(args.max_rows, 10)))
    if args.no_dup:
        lines += ["", "- 重複候補の検出: 行っていません (--no-dup)"]
    else:
        lines += ["", "### 重複候補 (%d グループ)" % len(groups), "",
                  "- 判定キー: " + ", ".join("全列一致" if len(ks) == len(header) else "+".join(header[i] for i in ks)
                                         for ks in sets)]
        if groups:
            lines.append("")
            lines.append(tio.markdown_table(["グループ", "判定キー", "キーの値", "行"],
                                            [[gi, g[0], dup_rows_key(g, cleaned, index, header), ", ".join(map(str, g[2]))]
                                             for gi, g in enumerate(groups, 1)], args.max_rows))
    lines += ["", "### 出力ファイル (UTF-8 BOM 付き CSV)", "",
              "- 正規化後のデータ: %s (%d 行)" % (out_clean, len(cleaned)),
              "- 変更ログ: %s (%d 件)" % (out_changes, len(changes))]
    if not args.no_dup:
        lines.append("- 重複候補: %s (%d 行)" % (out_dups, len(dup_rows)))
    print("\n".join(lines))
    return 0


def dup_rows_key(g, cleaned, index, header):
    label, ks, nos = g
    if len(ks) == len(header) and len(ks) > 1:
        return "(全列)"
    r = cleaned[index[nos[0]]]
    return " / ".join(r[i] for i in ks)


if __name__ == "__main__":
    tio.run_main(main)
