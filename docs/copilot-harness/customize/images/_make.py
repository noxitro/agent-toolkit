# -*- coding: utf-8 -*-
"""docs/customize の図版(SVG)を生成する。

実行:  python docs/customize/images/_make.py
PNG:   python docs/customize/images/_make.py --png   (LibreOffice で SVG → PNG。pptx 用)
"""
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).parent
FONT = "Meiryo, 'Yu Gothic UI', 'Noto Sans JP', sans-serif"
INK = "#1f2933"
MUTED = "#52606d"
LINE = "#9aa5b1"
RED = "#c62828"
GREEN = "#2e7d32"
C_INS, B_INS = "#e3f2fd", "#1e88e5"
C_SKL, B_SKL = "#e8f5e9", "#43a047"
C_AGT, B_AGT = "#fff3e0", "#fb8c00"
C_MCP, B_MCP = "#f3e5f5", "#8e24aa"
C_HRN, B_HRN = "#fffde7", "#f9a825"
C_HUM, B_HUM = "#eceff1", "#607d8b"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.parts = w, h, []
        self.parts.append(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="{FONT}">'
        )
        self.parts.append(f"<title>{esc(title)}</title>")
        self.parts.append(
            "<defs>"
            f'<marker id="arr" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="{MUTED}"/></marker>'
            f'<marker id="arr-red" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="{RED}"/></marker>'
            f'<marker id="arr-green" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="{GREEN}"/></marker>'
            f'<marker id="arr-grey" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="{LINE}"/></marker>'
            "</defs>"
        )
        self.parts.append(f'<rect width="{w}" height="{h}" fill="#ffffff"/>')

    def box(self, x, y, w, h, lines, fill="#fff", stroke=LINE, size=15, bold_first=True, rx=8, align="middle"):
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
        )
        n = len(lines)
        lh = size * 1.45
        y0 = y + h / 2 - (n - 1) * lh / 2 + size * 0.35
        for i, t in enumerate(lines):
            fw = "bold" if (i == 0 and bold_first) else "normal"
            col = INK if (i == 0 and bold_first) else MUTED
            tx = x + w / 2 if align == "middle" else x + 12
            anchor = "middle" if align == "middle" else "start"
            self.parts.append(
                f'<text x="{tx}" y="{y0 + i * lh:.1f}" font-size="{size}" font-weight="{fw}" fill="{col}" text-anchor="{anchor}">{esc(t)}</text>'
            )

    def text(self, x, y, t, size=14, fill=MUTED, anchor="start", bold=False):
        fw = "bold" if bold else "normal"
        self.parts.append(
            f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{fw}" fill="{fill}" text-anchor="{anchor}">{esc(t)}</text>'
        )

    def arrow(self, x1, y1, x2, y2, label=None, color=MUTED, marker="arr", dash=None, lx=None, ly=None, lsize=13):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1.8" marker-end="url(#{marker})"{d}/>'
        )
        if label:
            lx = lx if lx is not None else (x1 + x2) / 2
            ly = ly if ly is not None else (y1 + y2) / 2 - 6
            self.parts.append(
                f'<text x="{lx}" y="{ly}" font-size="{lsize}" fill="{color}" text-anchor="middle">{esc(label)}</text>'
            )

    def path(self, d, label=None, color=MUTED, marker="arr", lx=0, ly=0, dash=None, lsize=13):
        dd = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.8" marker-end="url(#{marker})"{dd}/>'
        )
        if label:
            self.parts.append(
                f'<text x="{lx}" y="{ly}" font-size="{lsize}" fill="{color}" text-anchor="middle">{esc(label)}</text>'
            )

    def save(self, name):
        self.parts.append("</svg>")
        (OUT / name).write_text("\n".join(self.parts), encoding="utf-8")
        print("wrote", name)


def fig1():
    s = Svg(960, 570, "Copilot に振る舞いを与える部品と、いつ効くか")
    s.text(30, 40, "Copilot に決まった振る舞いをさせる 4 つの部品と、それを組み合わせたユーザーハーネス", 19, INK, bold=True)
    s.text(30, 66, "横軸はセッションの時間。色の付いた区間で、その部品の内容がモデルの文脈(コンテキスト)に乗る", 14)
    tl_y = 110
    s.arrow(290, tl_y, 930, tl_y, color=LINE, marker="arr-grey")
    for label, x in (("セッション開始", 300), ("依頼を受けた", 520), ("作業中(ツール呼び出し)", 760)):
        s.parts.append(f'<line x1="{x}" y1="{tl_y - 8}" x2="{x}" y2="{tl_y + 8}" stroke="{LINE}" stroke-width="1.5"/>')
        s.text(x, tl_y - 14, label, 13, MUTED, anchor="middle")
    y = 140
    rows = [
        ("指示", ["AGENTS.md", ".github/copilot-instructions.md"], C_INS, B_INS),
        ("スキル", [".github/skills/<name>/SKILL.md"], C_SKL, B_SKL),
        ("カスタムエージェント", [".github/agents/<name>.agent.md"], C_AGT, B_AGT),
        ("MCP", ["~/.copilot/mcp-config.json など"], C_MCP, B_MCP),
    ]
    for name, where, fill, stroke in rows:
        s.box(30, y, 250, 60, [name] + where, fill=fill, stroke=stroke, size=13, align="start")
        bar = lambda x1, x2, dash=None, label=None: (
            s.parts.append(
                f'<rect x="{x1}" y="{y + 18}" width="{x2 - x1}" height="24" rx="4" fill="{fill}" stroke="{stroke}" stroke-width="1.2"'
                + (f' stroke-dasharray="{dash}"' if dash else "") + "/>"
            ),
            label and s.text((x1 + x2) / 2, y + 35, label, 12, INK, anchor="middle"),
        )
        if name == "指示":
            bar(300, 930, None, "常時(開始時に全文が乗る)")
        elif name == "スキル":
            bar(300, 520, "4 3", "description だけ")
            bar(520, 930, None, "本文(依頼が合致したときだけ読まれる)")
        elif name == "カスタムエージェント":
            bar(520, 930, None, "人が選んだとき、または本体から委譲されたとき(別の文脈で動く)")
        else:
            bar(300, 520, None, "ツール定義")
            bar(760, 930, None, "呼び出しごとに実行")
        y += 76
    s.box(30, y + 6, 900, 70, [
        "ユーザーハーネス = 上の 4 つを組み合わせて「実装役が作る → 審査役が検証する → ゲートを満たしたら次へ」を回す仕組み",
        "HARNESS.md(フェーズ定義とゲート条件)+ 実装役・審査役のエージェント + 起動スキル(phase-loop)+ 結果の置き場(TEST_REPORT.md)",
    ], fill=C_HRN, stroke=B_HRN, size=14)
    s.text(30, 552, "常時乗るもの(指示、description、MCP のツール定義)は 1 行増やすごとに全依頼のコストになる。手順は合致時だけ乗るスキル本文へ逃がす。", 13)
    s.save("fig1-parts-timeline.svg")


def fig2():
    s = Svg(960, 500, "スキルが読まれる仕組み")
    s.text(30, 40, "スキルが読まれる仕組み: description が発動を決め、本文は合致してから読まれる", 19, INK, bold=True)
    s.box(30, 120, 250, 90, ["セッション開始", "全スキルの name と description", "だけを読み込む"], fill=C_SKL, stroke=B_SKL, size=14)
    s.box(360, 120, 220, 90, ["依頼を受ける", "「Phase 3 を進めて」", "「/phase-loop 3」"], fill=C_HUM, stroke=B_HUM, size=14)
    s.box(660, 120, 270, 90, ["合致を判断", "依頼文 × description", "(本文はまだ読まれていない)"], fill="#fff", stroke=LINE, size=14)
    s.arrow(280, 165, 360, 165)
    s.arrow(580, 165, 660, 165)
    s.box(660, 290, 270, 100, ["合致した", "SKILL.md 本文と、本文が参照する", "references/ scripts/ を読んで作業"], fill=C_SKL, stroke=B_SKL, size=14)
    s.box(360, 290, 220, 100, ["合致しない", "本文は読まれない", "(素の Copilot として応答)"], fill="#fff", stroke=LINE, size=14)
    s.arrow(795, 210, 795, 290, label="自動選択", color=GREEN, marker="arr-green", lx=840, ly=255)
    s.arrow(680, 210, 560, 290, label="合致せず", color=RED, marker="arr-red", lx=590, ly=245)
    s.path("M 560 125 C 620 75, 950 75, 950 250 C 950 285, 945 300, 932 310", label="/<スキル名> で手動起動(合致判断を飛ばす)", lx=760, ly=72, dash="5 4")
    s.box(30, 290, 250, 100, ["だから", "description には「いつ使うか」を書く。", "本文の良し悪しは発動に効かない"], fill=C_HRN, stroke=B_HRN, size=14)
    s.text(30, 440, "増やすたびに description の合計が全依頼のコストになり、似た description 同士で取り合いが起きる。同時に置くスキルは絞る。", 13)
    s.text(30, 465, "確認: /skills list(登録されたか)→ 依頼を打ってスキルが読まれた表示が出るか(発動したか)。見えない資産は存在しないのと同じ。", 13)
    s.save("fig2-skill-activation.svg")


def fig3():
    s = Svg(960, 560, "ユーザーハーネスの部品と、誰が何を読むか")
    s.text(30, 40, "ユーザーハーネスの部品と、誰が何を読むか", 19, INK, bold=True)
    s.text(30, 64, "実線の矢印が 1 周の流れ(①〜④)。点線は「読む」関係。人が一から書くのは HARNESS.md だけで、残りは雛形をコピーする", 14)
    s.box(30, 110, 130, 70, ["人", "リーダー / 作業者"], fill=C_HUM, stroke=B_HUM)
    s.box(220, 110, 200, 70, ["phase-loop(スキル)", "1 周の手順を固定した起動文"], fill=C_SKL, stroke=B_SKL, size=14)
    s.box(480, 110, 200, 70, ["オーケストレータ", "チャット本体。実装も判定もしない"], fill="#fff", stroke=LINE, size=14)
    s.box(740, 110, 190, 70, ["TEST_REPORT.md", "phase-log.csv(結果と記録)"], fill=C_INS, stroke=B_INS, size=14)
    s.box(30, 300, 190, 80, ["共通指示", "AGENTS.md /", "copilot-instructions.md"], fill=C_INS, stroke=B_INS, size=14)
    s.box(300, 300, 190, 80, ["@implementer", "実装役。作って、ビルドと", "テストを通して、定型で報告"], fill=C_AGT, stroke=B_AGT, size=14)
    s.box(660, 300, 190, 80, ["@reviewer", "審査役。読み取り専用。", "自分で測り直して VERDICT"], fill=C_AGT, stroke=B_AGT, size=14)
    s.box(360, 450, 240, 80, ["HARNESS.md", "フェーズ定義・ゲート条件・運用則", "(人がエージェントと相談して書く)"], fill=C_HRN, stroke=B_HRN, size=14)
    s.arrow(160, 145, 220, 145, label="「Phase N を進めて」", lx=190, ly=100, lsize=12)
    s.arrow(420, 145, 480, 145)
    s.arrow(540, 180, 420, 300, label="① 実装依頼", lx=440, ly=235)
    s.arrow(490, 320, 660, 320, label="② 報告 → 審査前 git diff → 審査依頼", lx=575, ly=292, lsize=12)
    s.arrow(720, 300, 610, 180, label="③ VERDICT → 審査後 git diff 比較", lx=745, ly=235, lsize=12)
    s.arrow(680, 145, 740, 145, label="④ PASS: 記録", lx=710, ly=100, lsize=12)
    s.path("M 660 350 C 560 420, 500 420, 490 360", label="FAIL: 再現手順付きで差し戻し(最大 3 周)", color=RED, marker="arr-red", lx=575, ly=412, lsize=12)
    s.arrow(395, 380, 440, 450, color=LINE, marker="arr-grey", dash="4 3", label="読む", lx=395, ly=425)
    s.arrow(755, 380, 560, 450, color=LINE, marker="arr-grey", dash="4 3", label="読む(ゲート条件)", lx=700, ly=425)
    s.arrow(580, 180, 520, 450, color=LINE, marker="arr-grey", dash="4 3", label="読む", lx=568, ly=430)
    s.arrow(125, 300, 500, 180, color=LINE, marker="arr-grey", dash="4 3", label="常時(全エージェントが読む)", lx=250, ly=228)
    s.text(30, 545, "審査役の「直さない」は tools 制限 + 指示本文 + 審査前後の git diff 比較の三重で裏付ける。どれか 1 つでは保証にならない。", 13)
    s.save("fig3-harness-parts.svg")


def fig4():
    s = Svg(960, 420, "フェーズゲートの 1 周")
    s.text(30, 40, "フェーズゲートの 1 周: PASS しない限り次へ進まない。3 周で収束しなければ人に戻す", 19, INK, bold=True)
    s.box(30, 120, 170, 80, ["準備", "HARNESS.md の Phase N を", "復唱、未検証項目を引き継ぐ"], fill="#fff", stroke=LINE, size=14)
    s.box(260, 120, 170, 80, ["実装", "@implementer", "ビルド・テスト・自己検証"], fill=C_AGT, stroke=B_AGT, size=14)
    s.box(490, 120, 170, 80, ["審査", "@reviewer", "測り直し・陽性コントロール"], fill=C_AGT, stroke=B_AGT, size=14)
    s.box(720, 120, 210, 80, ["締め", "差分確認 → 人がコミット →", "TEST_REPORT.md / phase-log.csv"], fill=C_INS, stroke=B_INS, size=14)
    s.arrow(200, 160, 260, 160)
    s.arrow(430, 160, 490, 160, label="git diff 採取", lsize=12, ly=108)
    s.arrow(660, 160, 720, 160, label="PASS", color=GREEN, marker="arr-green", ly=108)
    s.path("M 575 200 C 575 280, 345 280, 345 200", label="FAIL: 再現手順付きで差し戻し(周回 +1)", color=RED, marker="arr-red", lx=460, ly=278)
    s.box(260, 320, 400, 60, ["周回が 3 を超えたら止めて人に戻す", "モデルを上げない。スコープ分割か要件見直しをリーダーが決める。記録は残す(判定: 上限到達)"], fill=C_HUM, stroke=B_HUM, size=13)
    s.arrow(460, 288, 460, 320, color=RED, marker="arr-red")
    s.text(30, 405, "審査の前後で git diff を比較し、差分があれば VERDICT を無効にして再審査する(審査役が書き込んでいないことの事後検出)。", 13)
    s.save("fig4-phase-loop.svg")


def fig5():
    s = Svg(960, 420, "MCP の位置づけ")
    s.text(30, 40, "MCP: エージェント環境(クライアント)が外部のツールとデータに同じ作法でつながる", 19, INK, bold=True)
    s.box(30, 120, 260, 150, ["エージェント環境(MCP クライアント)", "Copilot CLI / アプリ、Claude Code、", "OpenCode、Codex …", "", "設定ファイルにサーバーを列挙する"], fill=C_HUM, stroke=B_HUM, size=14)
    s.box(380, 100, 220, 70, ["MCP サーバー(stdio)", "ローカルで起動する子プロセス"], fill=C_MCP, stroke=B_MCP, size=14)
    s.box(380, 200, 220, 70, ["MCP サーバー(HTTP)", "リモートの URL に接続"], fill=C_MCP, stroke=B_MCP, size=14)
    s.box(700, 100, 230, 70, ["外部のツール・データ", "Issue / PR、組織内の API、DB、文書"], fill="#fff", stroke=LINE, size=14)
    s.box(700, 200, 230, 70, ["外部のツール・データ", "SaaS、検索、チケット"], fill="#fff", stroke=LINE, size=14)
    s.arrow(290, 150, 380, 135, label="tools / resources / prompts", lx=335, ly=190, lsize=12)
    s.arrow(290, 220, 380, 235)
    s.arrow(600, 135, 700, 135)
    s.arrow(600, 235, 700, 235)
    s.box(30, 300, 900, 90, [
        "設計判断と注意",
        "① ツール定義は開始時に全部文脈へ乗る(サーバーを足すほど毎依頼が重い)  ② ツール出力は信頼できない入力(命令が混ざっていても従わせない)",
        "③ 既に CLI があるものは MCP にせず、スキルからその CLI を叩く  ④ 書き込み系ツールは確認ダイアログを飛ばさない",
    ], fill=C_HRN, stroke=B_HRN, size=13)
    s.save("fig5-mcp.svg")


if __name__ == "__main__":
    for f in (fig1, fig2, fig3, fig4, fig5):
        f()
    if "--png" in sys.argv:
        import os, shutil
        soffice = os.environ.get("SOFFICE") or shutil.which("soffice") or "soffice"
        for svg in sorted(OUT.glob("fig*.svg")):
            subprocess.run([soffice, "--headless", "--convert-to", "png", "--outdir", str(OUT), str(svg)], check=False)
        print("png done")
