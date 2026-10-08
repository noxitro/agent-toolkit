# m365-org-skills

Microsoft 365 Copilot の **Agent Builder** に入れて開発チームで使うスキルと、エージェント定義。
推進担当がスキル入りのエージェントを作って開発チームに共有し、メンバーは Agent Store からそのエージェントを
追加して使う、という配り方を前提にしている。

第 1 弾は**開発向け**に絞った。中身は、自作の議事録スキル 1 本と、公開されているスキル 6 本(GitHub と Microsoft が
公開しているもの)を Microsoft 365 Copilot 向けに取り込んだもの。公開スキルは「実際にどう動くか」を確かめる試験も兼ねる。

コードの実装・監査を Copilot に任せる道具は別物で、[`shared/skills/m365-skill-pack`](../shared/skills/m365-skill-pack/) にある。

## 前提(2026-10 時点の公式文書)

- スキル機能は Learn の文書ではプレビューで、**Frontier プログラムに登録した組織**が対象。**Microsoft 365 Copilot ライセンスか従量課金**が要る。
  ライセンスの無い人に共有したエージェントは、使おうとするとエラーになることがある。
  一般提供(GA)の展開がメッセージ センター MC1476977 で告知されたという報道がある(既報・未確認)。自社テナントのメッセージ センターで確かめる。
- **Microsoft Purview の情報バリア(Information Barriers)を使うテナントでは使えない**。
- スキルはサンドボックスで動く(職場での利用では Linux。OS は公式文書に書かれていない)。**ネットワーク不可・パッケージの追加インストール不可**。入っているライブラリは非公開。
  → 自作のスクリプトは **Python の標準ライブラリだけ**で書いてある(Python 3.8 以上の文法。3.8 での実行は未確認)。
- 社内サイト・社内システム・リポジトリには届かない。使う資料はチャットに**添付**するか貼り付ける。
- 1 エージェントにスキル 8 個まで。スキルはエージェント間で使い回せない(同じスキルを別のエージェントにも入れるときは ZIP を個別に追加)。
- スキルと埋め込みファイル(ナレッジ)は併用できない。

出典: [Custom skills in declarative agents](https://learn.microsoft.com/microsoft-365/copilot/extensibility/declarative-agent-skills)、
[Add custom skills in Agent Builder](https://learn.microsoft.com/microsoft-365/copilot/extensibility/agent-builder-add-skills)、
[Share and manage agents built in Agent Builder](https://learn.microsoft.com/microsoft-365/copilot/extensibility/agent-builder-share-manage-agents)。

## ラインナップ

### エージェント(`agents/`)

Agent Builder の構成画面にそのまま写せる定義シート(名前・説明・指示文・スターター プロンプト・入れるスキル)。

| シート | 名前 | 入れるスキル | 共有先 |
| --- | --- | --- | --- |
| [dev-assistant.md](agents/dev-assistant.md) | 開発アシスタント | minutes, incident-postmortem, root-cause-analysis, create-architectural-decision-record, create-specification, prd, sql-code-review(7 個) | 開発チームのグループ |
| [skill-lab.md](agents/skill-lab.md) | スキル検証 | probe, minutes, meeting-minutes(3 個) | 共有しない(推進担当だけ) |

### スキル

| スキル | 何をするか | 元 | 置き場所 |
| --- | --- | --- | --- |
| `minutes` | 会議の文字起こし(Teams の .vtt / .docx、メモ)から、要約・決定事項・ToDo・チケット候補付きの議事録を **Markdown ファイル**で作る | 自作 | `skills/minutes` |
| `incident-postmortem` | 障害報告書(ポストモーテム)。タイムライン・なぜなぜ・対策の表 | github/awesome-copilot | `third-party/` |
| `root-cause-analysis` | なぜなぜ分析と特性要因図(HTML)で原因を分析。事実・推測・否定を札で区別 | microsoft/cat-agent-skills | `third-party/` |
| `create-architectural-decision-record` | 設計判断の記録(ADR) | github/awesome-copilot | `third-party/` |
| `create-specification` | 仕様書(要件・制約・インターフェース・受け入れ条件) | github/awesome-copilot | `third-party/` |
| `prd` | 新機能の要求仕様(PRD)。書く前に質問して前提を埋める | github/awesome-copilot | `third-party/` |
| `sql-code-review` | SQL のレビュー(インジェクション・性能・保守性) | github/awesome-copilot | `third-party/` |
| `meeting-minutes` | 公開版の議事録スキル。自作の `minutes` と出来を比べるための検証用 | github/awesome-copilot | `third-party/` |
| `probe` | サンドボックスの実測(Python の版・使えるライブラリ・添付ファイルの置き場所)。推進担当が最初に 1 回使う | 自作 | `shared/skills/m365-skill-pack/m365/skills/probe` |

#### probe(環境の実測)とは

従業員が使うスキルではなく、推進担当が使う**計測器**。Microsoft はサンドボックスの Python の版・入っているライブラリ・
チャットに添付したファイルの置き場所を公開していないので、実際に走らせて測る。公開スキルの中には
python-docx や openpyxl などを前提にするものがあり、それを採用できるかはこの結果で決める。

### 公開スキルの取り込み方(`third-party/`)

- 元のスキルの本文は**改変せずに**残し、先頭に「Microsoft 365 Copilot で使うときの読み替え」の節(日本語)を足している。
  読み替えの中身: 回答は日本語、リポジトリへの保存はファイルで返す形に、社内システムには接続しない、資料に無い担当者や期限を作らない、など。
  節の文面は [`third-party/overlays.json`](third-party/overlays.json) にある。
- 各スキルに `LICENSE.txt`(元のリポジトリの LICENSE そのまま)と `SOURCE.md`(取り込んだコミットと変更点)を同梱する。
- `third-party/_upstream/` は元の `SKILL.md` の写し。上流が更新されたときの差分確認に使う(ZIP には入らない)。
- 評価の記録(採用しなかったものと理由を含む)は [external-skills.md](external-skills.md)。

上流が更新されたときの取り込み直し:

```bash
git clone --depth 1 https://github.com/github/awesome-copilot <作業フォルダ>/awesome-copilot
git clone --depth 1 https://github.com/microsoft/cat-agent-skills <作業フォルダ>/cat-agent-skills
python m365-org-skills/third-party/import_upstream.py --src <作業フォルダ>
```

そのあと `git diff m365-org-skills/third-party` で**フォルダ全体の**変更(`SKILL.md` の原文、`references/`・`assets/` の中身、LICENSE)を読み、
問題が無ければ `npm test` で確認する。取り込みスクリプトは、シンボリック リンクや上流フォルダの外を指すパスを見つけると、何も書き換えずに止まる。
**新しい版の中身を読まずに取り込まない**(スキルは AI への指示そのもの)。

### 保留中(今回のラインナップから外したもの)

全社展開を考えていたときに作ったもの。ZIP にはしないが、テスト済みのまま残している。

| スキル | 内容 |
| --- | --- |
| `skills/table-summary` | CSV / XLSX の集計 |
| `skills/log-summary` | ログの集計 |
| `skills/doc-style-check` | 社内文書の表記チェック |
| `skills/expense-check` | 経費データの規程チェック |
| `skills/data-normalize` | 名簿の整形と重複検出 |
| `skills/proposal-outline` | 提案書の骨子 |
| `skills/training-quiz` | 研修資料から理解度テスト |

定義シートは `agents/parked/`。使うときは `node shared/skills/m365-skill-pack/scripts/pack-skill.mjs m365-org-skills/skills/<名前> --from-template --out <出力先>` で ZIP にする。

## 使い方(推進担当)

### 1. ZIP を作る

必要なもの: Node.js 20 以上。

[`build-zips.bat`](build-zips.bat) をダブルクリックする。`<リポジトリ>\artifacts\m365-org-zips\` に 9 個の ZIP ができる
(開発アシスタント用 7 個、検証用の `meeting-minutes` と `probe`)。ZIP にする前に、ファイルの形式・拡張子・
ディレクトリの深さ・`SKILL.md` の文字数が検査され、違反があれば止まる。

### 2. 検証用エージェントで試す

1. [skill-lab.md](agents/skill-lab.md) のとおりに「スキル検証」エージェントを作る(共有しない)。
2. 何かファイルを 1 つ添付して、スターター プロンプト「環境を測る」を押す。返ってきた `probe-output.txt` の
   Python の版・使えるモジュール・添付ファイルが見えた場所を、`shared/skills/m365-skill-pack/references/m365-constraints.md` の
   「Measured」表に日付付きで記録する。
3. 同じ会議の文字起こしを添付して「自作版で議事録」「公開版で議事録」を順に押し、出来を比べる。
   見るところ: 文字起こしに無い担当者・期限を作っていないか、要約が 3 行で言えているか、Markdown ファイルが返ってきたか。

### 3. 開発アシスタントを作る

1. Copilot チャットで「新しいエージェント」→ 構成画面へ進む(自然文で作らせず、手で設定する)。
2. [dev-assistant.md](agents/dev-assistant.md) の「名前」「説明」「Instructions」を貼り、スターター プロンプトを登録する。
3. 「ドキュメント、グラフ、コードの作成」をオンにする。
4. 「スキル」→「追加」で、シートに書かれた 7 個の ZIP を 1 個ずつ追加する。ナレッジは追加しない。
5. 試用画面でスターター プロンプトを押し、スキルが使われること・ファイルが返ることを確かめてから「作成」する。

### 4. 共有する

共有ダイアログで、所有者(「編集可」)を**個人で 2 名以上**にする(グループは所有者になれない)。
開発チームのグループを「チャット可」で追加する。

### 5. 更新する

1. 自作スキルは `skills/` を、公開スキルは上の「取り込み直し」の手順で直し、`build-zips.bat` で ZIP を作り直す。
2. そのスキルを入れている**すべてのエージェント**で、古いスキルを削除して新しい ZIP を追加する
   (`minutes` は開発アシスタントとスキル検証の 2 か所)。
3. 試用画面で確認してから、右上の「更新」を押して公開する。編集は自動で保存されるが、「更新」を押すまで利用者には見えない。
   反映には数分かかることがある。変更内容はこのリポジトリのコミットで記録する。

このリポジトリは公開されているので、**社名や社内固有の値は、このリポジトリではなく社内側の写し(フォーク)で書き換える**。

## テスト

```bash
npm test
```

- `tests/m365-org-text.test.mjs` / `tests/m365-org-data.test.mjs`: 自作スキルのスクリプトを `python -I` で実行して確かめる
  (データ系は ZIP を作って展開した中で実行する)。全スキルが ZIP の検査を通ることも確かめる。Python が無い環境ではスキップ。
- `tests/m365-org-thirdparty.test.mjs`: 公開スキルの「原文」以降が `_upstream/` の写しと 1 文字も違わないこと、ライセンスと出典があること、
  ZIP の検査を通ること、定義シートが実在するスキルだけを 8 個以内で指していることを確かめる。
  上流そのものとの一致は、取り込み直したときの `git diff` で確かめる(テストはネットワークを使わない)。

## 確かめていないこと

- 実際の Microsoft 365 Copilot のサンドボックスでの動作(添付ファイルの置き場所、作ったファイルがダウンロードとして返るか)。
  手順 2 の probe で確かめる。
- 公開スキルの「読み替え」の節が、英語の原文より優先して守られるか。手順 2・3 の試用で確かめる。
- `LICENSE.txt` が Agent Builder に受け付けられるか(`.txt` は許可された形式なので通る見込み)。
- Python 3.8 での実行(文法の検査のみ。手元は 3.13)。
- Teams から実際に書き出した文字起こし(.vtt / .docx)での動作(同じ形式で自作したファイルでのみ確認)。
