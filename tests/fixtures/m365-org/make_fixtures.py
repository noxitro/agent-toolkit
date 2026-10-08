#!/usr/bin/env python3
"""Write the input files for tests/m365-org-data.test.mjs into a directory.

    python3 make_fixtures.py <out-dir>

Generated at test time instead of committed so that binary files (XLSX, zip, cp932) stay
out of the repository and every byte is visible here. Standard library only.
"""

import datetime
import os
import sys
import zipfile


def serial(d):
    return (d - datetime.date(1899, 12, 30)).days


def write(path, text, encoding="utf-8"):
    with open(path, "w", encoding=encoding, newline="") as f:
        f.write(text)


def xlsx(path):
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8"?><workbook %s %s><sheets>'
            '<sheet name="売上" sheetId="1" r:id="rId1"/><sheet name="メモ" sheetId="2" r:id="rId2"/>'
            '</sheets></workbook>' % (ns, rns)),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>'
            '</Relationships>'),
        # cellXfs: 0 General, 1 date (14), 2 custom datetime, 3 custom yen number, 4 time (20)
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8"?><styleSheet %s>'
            '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy/m/d\\ h:mm"/>'
            '<numFmt numFmtId="165" formatCode="#,##0&quot;円&quot;"/></numFmts>'
            '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/>'
            '<xf numFmtId="165"/><xf numFmtId="20"/></cellXfs></styleSheet>' % ns),
        # 0..: plain strings; 6 is rich text; 7 has a phonetic guide (rPh) that must be ignored
        "xl/sharedStrings.xml": (
            '<?xml version="1.0" encoding="UTF-8"?><sst %s>'
            '<si><t>部署</t></si><si><t>担当</t></si><si><t>日付</t></si><si><t>金額</t></si>'
            '<si><t>営業部</t></si><si><t>総務部</t></si>'
            '<si><r><t>山</t></r><r><rPr><b/></rPr><t>田</t></r></si>'
            '<si><t>佐藤</t><rPh sb="0" eb="2"><t>サトウ</t></rPh></si>'
            '<si><t>2026年度 売上一覧</t></si>'
            '</sst>' % ns),
    }
    d1, d2, d3 = (serial(datetime.date(2026, 4, 1)), serial(datetime.date(2026, 4, 15)),
                  serial(datetime.date(2026, 5, 2)))
    rows = [
        '<row r="1"><c r="A1" t="s"><v>8</v></c></row>',
        '<row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c>'
        '<c r="D3" t="s"><v>3</v></c><c r="E3" t="inlineStr"><is><t>確認</t></is></c>'
        '<c r="F3" t="inlineStr"><is><t>受付</t></is></c><c r="G3" t="inlineStr"><is><t>時刻</t></is></c></row>',
        '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" t="s"><v>6</v></c><c r="C4" s="1"><v>%d</v></c>'
        '<c r="D4" s="3"><v>1200</v></c><c r="E4" t="b"><v>1</v></c><c r="F4" s="2"><v>%d.5</v></c>'
        '<c r="G4" s="4"><v>0.75</v></c></row>' % (d1, d1),
        '<row r="5"><c r="A5" t="s"><v>4</v></c><c r="B5" t="s"><v>7</v></c><c r="C5" s="1"><v>%d</v></c>'
        '<c r="D5"><v>800.25</v></c><c r="E5" t="b"><v>0</v></c></row>' % d2,
        '<row r="6"><c r="A6" t="s"><v>5</v></c><c r="B6" t="inlineStr"><is><t>鈴木</t></is></c>'
        '<c r="C6" s="1"><v>%d</v></c><c r="D6"><v>3000</v></c></row>' % d3,
    ]
    files["xl/worksheets/sheet1.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?><worksheet %s><sheetData>%s</sheetData></worksheet>'
        % (ns, "".join(rows)))
    files["xl/worksheets/sheet2.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?><worksheet %s><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>項目</t></is></c><c r="B1" t="inlineStr"><is><t>値</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>メモ</t></is></c><c r="B2"><v>42</v></c></row>'
        '</sheetData></worksheet>' % ns)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text.encode("utf-8"))


def main():
    out = sys.argv[1]
    if not os.path.isdir(out):
        os.makedirs(out)
    # table-summary: Shift_JIS (cp932) CSV with yen signs, full-width digits and a non-number
    write(os.path.join(out, "sales_sjis.csv"),
          "部署,氏名,金額,日付\r\n営業,山田,\"1,200\",2026/4/1\r\n営業,佐藤,￥３００,2026/4/2\r\n"
          "総務,鈴木,500円,2026/4/3\r\n総務,田中,△100,2026/4/3\r\n開発,高橋,未定,2026/4/5\r\n", "cp932")
    write(os.path.join(out, "sales_bom.tsv"), "地域\t売上\n関東\t100\n関西\t250\n関東\t50\n", "utf-8-sig")
    xlsx(os.path.join(out, "book.xlsx"))
    # expense-check: one row per rule (as of 2026-09-30)
    write(os.path.join(out, "expenses.csv"),
          "日付,申請者,費目,支払先,摘要,金額\n"
          "2026/09/01,山田,交際費,料亭A,顧客接待,25000\n"        # row 2: over the 20,000 limit
          "2026/09/02,佐藤,会議費,カフェB,打合せ,1200\n"          # row 3: duplicate of row 4
          "2026/09/02,佐藤,会議費,ｶﾌｪB,打合せ,\"1,200\"\n"       # row 4: duplicate (half-width kana)
          "2026/05/01,鈴木,交通費,JR,出張,3000\n"                 # row 5: older than 90 days
          "2026/09/05,田中,消耗品費,量販店C,商品券購入,5000\n"    # row 6: forbidden word
          "2026/09/06,伊藤,交通費,,移動,800\n"                    # row 7: payee missing
          "2026/12/01,加藤,交通費,バス,移動,500\n"                # row 8: future date
          "2026/09/10,吉田,会議費,カフェD,打合せ,4000\n",         # row 9: clean
          "utf-8-sig")
    write(os.path.join(out, "expenses_nocol.csv"), "日付,費目,金額\n2026/09/01,会議費,100\n", "utf-8")
    # data-normalize
    write(os.path.join(out, "roster.csv"),
          "顧客ID,氏名,フリガナ,電話番号,郵便番号,メールアドレス\n"
          "Ａ００１,山田　太郎 ,やまだ たろう,０９０（１２３４）５６７８,〒１００－０００１,Taro.Yamada@Example.COM\n"
          "A002,山田 太郎,ﾔﾏﾀﾞ ﾀﾛｳ,090-1234-5678,1000001,taro.yamada@example.com\n"
          "A003,佐藤花子,サトウハナコ,0312345678,530-0001,hanako@\n"
          "A004,鈴木一郎,スズキ,312345678,600001,s@example.jp\n",
          "utf-8-sig")
    # log-summary
    write(os.path.join(out, "app.log"),
          "2026-10-01T09:00:01.123+09:00 INFO  [main] Server started on port 8080\n"
          "2026-10-01T09:05:12 ERROR [db] Connection timeout after 3000 ms to 10.0.0.5:5432\n"
          "java.sql.SQLException: timeout\n"
          "    at com.example.Db.connect(Db.java:42)\n"
          "2026-10-01T09:06:13 ERROR [db] Connection timeout after 5000 ms to 10.0.0.6:5432\n"
          "2026-10-01T10:00:00 WARN  Disk usage 91% on /var/lib/data\n"
          "2026-10-01T10:30:00 INFO  user 4f3a2b1c-1111-2222-3333-444455556666 logged in\n"
          "2026-10-01T11:00:00 ERROR [db] Connection timeout after 1000 ms to 10.0.0.5:5432\n")
    with zipfile.ZipFile(os.path.join(out, "logs.zip"), "w") as z:
        z.writestr("batch/batch.log",
                   ("2026/10/01 09:10:00 警告 バッチ処理 遅延 120 秒\n"
                    "2026/10/01 09:20:00 エラー 取込に失敗 件数=3\n"
                    "Oct  1 12:00:00 host sshd[1234]: error: Failed password for root from 192.168.1.10 port 22\n"
                    ).encode("cp932"))
        z.writestr("readme.md", "not a log")
    return 0


if __name__ == "__main__":
    sys.exit(main())
