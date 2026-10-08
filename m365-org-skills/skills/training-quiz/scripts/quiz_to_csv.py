#!/usr/bin/env python3
"""Validate quiz questions and write them as CSV (and optional Forms import text).

Usage:
    python3 quiz_to_csv.py quiz.json --csv quiz.csv [--forms-text quiz-forms.txt]

quiz.json:
    {"title": "...", "questions": [
      {"type": "選択式", "difficulty": "易", "question": "...",
       "choices": ["...", "...", "...", "..."], "answer": "<choice text, A-F or 1-6>",
       "explanation": "...", "source": "スライド3"},
      {"type": "○×", "difficulty": "中", "question": "...", "answer": "○", ...},
      {"type": "記述", "difficulty": "難", "question": "...", "answer": "<模範解答>", ...}]}

Checks: known type and difficulty, 2-6 distinct choices, exactly one answer that is one of
the choices, ○/× answers, non-empty explanation and source. Any error stops the run
(exit 2) and nothing is written. Warnings (exit 0) flag choices such as 「上記すべて」.

CSV columns (UTF-8 with BOM, opens in Excel): 番号, 形式, 難易度, 問題文, 選択肢1..選択肢N
(N = max(4, most choices used)), 正解, 解説, 出典.
--forms-text writes the questions in the numbered layout that Microsoft Forms "Quick
Import" reads from a Word document (question line, then a. b. c. choices), without answers.
Python 3.8+, standard library only.
"""

import argparse
import csv
import json
import re
import sys

TYPES = {"選択式": "選択式", "択一": "選択式", "choice": "選択式",
         "○×": "○×", "〇×": "○×", "マルバツ": "○×", "truefalse": "○×",
         "記述": "記述", "記述式": "記述", "text": "記述"}
DIFFICULTIES = {"易": "易", "やさしい": "易", "初級": "易", "中": "中", "普通": "中", "中級": "中",
                "難": "難", "難しい": "難", "上級": "難"}
MARU = {"○", "〇", "o", "O", "◯", "正", "true", "True"}
BATSU = {"×", "x", "X", "✕", "誤", "false", "False"}
LETTERS = "ABCDEF"
VAGUE_CHOICE = re.compile(r"上記すべて|以上すべて|すべて正しい|全て正しい|いずれでもない|どれでもない|上記以外")


def text(v):
    return v.strip() if isinstance(v, str) else ""


def normalise(q, n, errors, warnings):
    where = "問%d" % n
    if not isinstance(q, dict):
        errors.append("%s: 問題はオブジェクト({...})で書いてください" % where)
        return None
    typ = TYPES.get(text(q.get("type")))
    if not typ:
        errors.append("%s: type は 選択式 / ○× / 記述 のいずれか(現在: %r)" % (where, q.get("type")))
        return None
    diff = DIFFICULTIES.get(text(q.get("difficulty")))
    if not diff:
        errors.append("%s: difficulty は 易 / 中 / 難 のいずれか(現在: %r)" % (where, q.get("difficulty")))
    question = text(q.get("question"))
    if not question:
        errors.append("%s: question(問題文)が空です" % where)
    explanation = text(q.get("explanation"))
    if not explanation:
        errors.append("%s: explanation(解説)が空です" % where)
    source = text(q.get("source"))
    if not source:
        errors.append("%s: source(資料内の出典位置)が空です。資料にない内容は出題しません" % where)
    raw_answer = q.get("answer")
    if isinstance(raw_answer, list):
        errors.append("%s: answer は1つだけにしてください(複数正解は出題しません)" % where)
        return None
    answer = text(raw_answer) if not isinstance(raw_answer, int) or isinstance(raw_answer, bool) else str(raw_answer)
    choices = []
    if typ == "選択式":
        choices = [text(c) for c in (q.get("choices") or [])]
        if len(choices) < 2 or len(choices) > 6:
            errors.append("%s: 選択式の選択肢は2〜6個にしてください(現在 %d 個)" % (where, len(choices)))
        if any(not c for c in choices):
            errors.append("%s: 空の選択肢があります" % where)
        if len(set(choices)) != len(choices):
            errors.append("%s: 同じ選択肢が重複しています" % where)
        for c in choices:
            if VAGUE_CHOICE.search(c):
                warnings.append("%s: 選択肢「%s」は紛らわしい出題になりやすいので避けてください" % (where, c))
        if answer in choices:
            pass
        elif len(answer) == 1 and answer.upper() in LETTERS and LETTERS.index(answer.upper()) < len(choices):
            answer = choices[LETTERS.index(answer.upper())]
        elif answer.isdigit() and 1 <= int(answer) <= len(choices):
            answer = choices[int(answer) - 1]
        else:
            errors.append("%s: answer が選択肢のどれとも一致しません(%r)" % (where, raw_answer))
        if choices.count(answer) > 1:
            errors.append("%s: 正解と同じ文言の選択肢が複数あります" % where)
    elif typ == "○×":
        if answer in MARU:
            answer = "○"
        elif answer in BATSU:
            answer = "×"
        else:
            errors.append("%s: ○×問題の answer は ○ か × にしてください(%r)" % (where, raw_answer))
        choices = ["○", "×"]
    else:
        if not answer:
            errors.append("%s: 記述問題にも answer(模範解答・採点の観点)を書いてください" % where)
    if re.search(r"ないとは言えない|ないわけではない|なくはない", question):
        warnings.append("%s: 問題文に二重否定があります。ひっかけにならないよう言い換えてください" % where)
    return {"type": typ, "difficulty": diff or "", "question": question, "choices": choices,
            "answer": answer, "explanation": explanation, "source": source}


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Validate quiz JSON and write CSV.")
    ap.add_argument("json_file")
    ap.add_argument("--csv", required=True, help="CSV to write (UTF-8 with BOM)")
    ap.add_argument("--forms-text", help="also write a Forms Quick Import friendly text")
    args = ap.parse_args(argv)
    try:
        with open(args.json_file, "r", encoding="utf-8-sig") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print("エラー: 問題ファイル(JSON)を読めません: %s" % e, file=sys.stderr)
        return 2
    items = doc.get("questions") if isinstance(doc, dict) else doc
    if not isinstance(items, list) or not items:
        print("エラー: questions に問題が1問もありません", file=sys.stderr)
        return 2
    errors, warnings, rows = [], [], []
    for n, q in enumerate(items, 1):
        r = normalise(q, n, errors, warnings)
        if r:
            rows.append(r)
    if errors:
        print("エラー: %d件。修正してから再実行してください(ファイルは書き出していません)" % len(errors), file=sys.stderr)
        for e in errors:
            print("- %s" % e, file=sys.stderr)
        return 2
    width = max([4] + [len(r["choices"]) for r in rows])
    with open(args.csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["番号", "形式", "難易度", "問題文"] + ["選択肢%d" % i for i in range(1, width + 1)] + ["正解", "解説", "出典"])
        for n, r in enumerate(rows, 1):
            ch = r["choices"] + [""] * (width - len(r["choices"]))
            w.writerow([n, r["type"], r["difficulty"], r["question"]] + ch + [r["answer"], r["explanation"], r["source"]])
    if args.forms_text:
        out = []
        title = text(doc.get("title")) if isinstance(doc, dict) else ""
        if title:
            out += [title, ""]
        for n, r in enumerate(rows, 1):
            out.append("%d. %s" % (n, r["question"]))
            for i, c in enumerate(r["choices"]):
                out.append("%s. %s" % ("abcdef"[i], c))
            out.append("")
        with open(args.forms_text, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(out))
    by_type, by_diff = {}, {}
    for r in rows:
        by_type[r["type"]] = by_type.get(r["type"], 0) + 1
        by_diff[r["difficulty"]] = by_diff.get(r["difficulty"], 0) + 1
    print("書き出しました: %s (%d問)" % (args.csv, len(rows)))
    print("形式: " + "、".join("%s %d" % kv for kv in sorted(by_type.items())))
    print("難易度: " + "、".join("%s %d" % (k, by_diff[k]) for k in ("易", "中", "難") if k in by_diff))
    if args.forms_text:
        print("Forms 取り込み用テキスト: %s" % args.forms_text)
    for wmsg in warnings:
        print("注意: %s" % wmsg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
