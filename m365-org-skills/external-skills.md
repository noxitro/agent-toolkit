# 公開されているスキルの評価(2026-10-08 時点)

Microsoft 365 Copilot(Agent Builder)のスキルとして社内に取り込めるかを、公開リポジトリごとに
評価した記録。**取り込む前に、その時点の LICENSE と中身をもう一度確認すること**。

凡例: ◎ そのまま使える / △ 書き換えれば使える / ✕ 使えない。
確度: 【実測】リポジトリのファイルを読んで確認 / 【公式】Microsoft の文書 / 【既報】第三者の記述 / 【推測】

## 採用したもの(2026-10-09)

開発アシスタント(`agents/dev-assistant.md`)に入れた 6 本と、検証用の 1 本。取り込み方は README の「公開スキルの取り込み方」。

| スキル | 出どころ | 理由 |
| --- | --- | --- |
| `incident-postmortem` | github/awesome-copilot | 障害報告書の型。テキストのみで、サンドボックスの制約に当たらない |
| `root-cause-analysis` | microsoft/cat-agent-skills | 事実・推測・否定を札で分ける作りが、資料に無いことを作らない方針と合う。同梱の HTML の script は図の線を描くだけで通信しない(全文を確認) |
| `create-architectural-decision-record` | github/awesome-copilot | ADR の型 |
| `create-specification` | github/awesome-copilot | 仕様書の型 |
| `prd` | github/awesome-copilot | 書く前に質問させる作り |
| `sql-code-review` | github/awesome-copilot | SQL レビューの観点表 |
| `meeting-minutes`(検証用) | github/awesome-copilot | 自作の `minutes` との比較用。原文は「示唆された担当・期限で埋める」と書くので、比較の観点になる |

採用を見送ったもの: cat-agent-skills の `meeting-analyzer`。会議の参加者一人ひとりの人物像・力関係・言わなかったことを推定する作りで、
社内で配ると人事評価やプライバシーの面で問題になりうるため。

## 判定の前提(公式)

出典: [Custom skills in declarative agents (preview)](https://learn.microsoft.com/microsoft-365/copilot/extensibility/declarative-agent-skills)

- スクリプトは `.py .js .mjs .cjs .ts .mts .sh .bash` のみ。`.cmd` `.bat` `.ps1` `.exe` は入れられない。
- サンドボックスは**ネットワーク不可・パッケージの追加インストール不可**。入っているパッケージの一覧は公開されておらず、
  文書は「確認できるまで依存するな」とだけ書いている。→ ライブラリ前提のスキルは、probe で実測してから採否を決める。
- 同梱できるファイル形式に `.ttf` や拡張子の無いファイル(`LICENSE` など)は含まれない。`LICENSE` は `LICENSE.txt` に改名して同梱する【推測: 改名で受け付けられるかは未実測】。
- ディレクトリの深さは 3 まで。1 エージェントにスキル 8 個まで。スキルと埋め込みファイル(ナレッジ)は併用不可。
- スクリプトからコネクタ・MCP は呼べない(オーケストレーター経由のみ)。

## 候補一覧

| 出どころ | ライセンス(社内配布) | 実行に要るもの | 判定 |
| --- | --- | --- | --- |
| [anthropics/skills](https://github.com/anthropics/skills) `skills/{docx,pptx,xlsx,pdf}` | **独自ライセンス**。複製・派生物の作成・第三者への配布・サービス外への持ち出しを禁止【実測: `skills/docx/LICENSE.txt`】 | soffice、pandoc、Node の docx/pptxgenjs など。pptx は SKILL.md が 2 万字超【実測】 | ✕(ライセンス) |
| 同 `internal-comms` | Apache-2.0【実測】 | テキストのみ。Slack・Google Drive 前提の例文 | △ Teams・Outlook・SharePoint に書き換え |
| 同 `brand-guidelines` / `theme-factory` | Apache-2.0 | テキスト | △ 自社の配色・書体に差し替え |
| 同 `doc-coauthoring` | **LICENSE が見当たらない**(README は「多くは Apache 2.0」とだけ)【実測】 | Claude の機能前提 | ✕ 許諾が不明なので保留 |
| 同 `skill-creator` `mcp-builder` `webapp-testing` ほか | Apache-2.0 | `claude -p`・ブラウザ・npm・ネットワーク | ✕ |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) 経理(`variance-analysis` `reconciliation` `journal-entry-prep` `close-management`) | Apache-2.0【実測】 | テキストのみ。`~~erp` などコネクタ前提の記述 | △ データは添付で受け取る形に |
| 同 人事(`performance-review` `onboarding` `interview-prep` `policy-lookup`) | Apache-2.0 | テキストのみ | △ 社内規程を resources に同梱 |
| 同 営業(`call-summary` `account-plan` `handle-objection`) | Apache-2.0 | テキストのみ(CRM 前提のものは除外) | △ |
| 同 法務(`review-contract` `triage-nda`) | Apache-2.0 | 社内プレイブック前提 | △ 自社のプレイブックを同梱 |
| 同 開発・業務(`incident-response` `code-review` `documentation` `process-doc` `runbook` `status-report`) | Apache-2.0 | `~~chat` `~~monitoring` の参照 | △ |
| [microsoft/cat-agent-skills](https://github.com/microsoft/cat-agent-skills) `submissions/{meeting-analyzer,root-cause-analysis,vendor-contract-risk-review}` | MIT【実測】 | テキストのみ(音声入力を除く) | ◎ |
| 同 `presentation-talk-track-builder` / `commenting-content` | MIT | 標準ライブラリ / lxml | ◎〜△(lxml は probe で確認) |
| 同 `redlining-content` `pdf-table-data-conversion` `process-sop-architect` `accessibility-pass` | MIT | lxml・pdfplumber・openpyxl・python-docx・python-pptx | △ probe で確認できれば採用。投稿者は「Copilot Studio のサンドボックスには入っている」と書く【既報・製品が別なので M365 では未確認】 |
| 同 `chart-builder` `gantt-chart-generator` `monte-carlo-analysis` | MIT | pandas・matplotlib・numpy | △ 同上 |
| 同 `doc-format-converter` `qr-code-builder` `copilot-studio-agent-test` ほか | MIT | markitdown・cv2・`.cmd`/`.ps1` など | ✕ |
| [github/awesome-copilot](https://github.com/github/awesome-copilot) `skills/{meeting-minutes,performance-review-writer,incident-postmortem,create-architectural-decision-record,prd,create-specification,sql-code-review}` | MIT(一部のスキルは個別の LICENSE を持つので個別に確認)【実測】 | テキストのみ | ◎ |
| 同 `convert-{word,excel,pdf}-to-md` `md-to-docx` | MIT | markitdown・PyMuPDF・npm | ✕(標準ライブラリで書き直せば △) |
| [obra/superpowers](https://github.com/obra/superpowers) `systematic-debugging` `test-driven-development` `brainstorming` `writing-plans` | MIT | 他スキル参照・git・サブエージェント | △ 相互参照を外して開発者向けに |

調べたが対象外: microsoft/agent-framework のサンプル(小さすぎて雛形の参考程度)、microsoft/skills(Azure SDK 向けでネットワーク前提)、
agentskills.io(仕様の紹介のみで一覧は無い)。

## 取り込みの手順

1. **ライセンス**: Apache-2.0 は LICENSE の写しを同梱し、改変したファイルに改変した旨を書く。MIT は著作権表示と許諾表示を残す。
2. **中身を全文読む**: スキルは AI への指示そのもの。外部送信・不審な指示・社外サービス前提の手順が無いか確認する
   (Microsoft も Cowork の文書で「信頼できる出どころのスキルだけをアップロードする」よう注意している)。
3. **書き換え**: Slack・Google Drive・`~~` で始まるコネクタの記述を、「添付ファイルを受け取る」「Teams・Outlook」に置き換える。
   ギャラリー用の付属ファイル(`metadata.json` など)は外す。
4. **検証と ZIP 化**: `node shared/skills/m365-skill-pack/scripts/pack-skill.mjs <dir> --out <出力先>` が形式・拡張子・深さ・文字数を検査する。
5. **試用**: Agent Builder の試用画面で、スキルが選ばれるか・スクリプトが動くかを確認してから共有する。

出典: 2026-10-08 に各リポジトリを取得して確認(anthropics/skills @683bc88、microsoft/cat-agent-skills、github/awesome-copilot、
anthropics/knowledge-work-plugins は同日の main)。`skills/docx/LICENSE.txt` の制限条項と、cat-agent-skills(MIT)・
knowledge-work-plugins(Apache-2.0)のライセンス種別は GitHub API で再確認済み。
