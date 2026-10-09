# スキルの探し方と取り込み方(skill scout)

公開されているスキル(`SKILL.md` 形式)を集めて機械で検査し、自分で中身を確かめて採用したものだけを
Microsoft 365 Copilot(Agent Builder)のスキル ZIP にするための手引きと道具。

**機械がやるのは「候補を集めて、検査結果つきで並べる」まで。** 採用するかどうかは、必ず人が `SKILL.md` と同梱ファイルを
全文読んで決める。スキルは AI への指示そのもので、不適切な指示が入っていてもエージェントはそれに従ってしまう。
Microsoft も Copilot Cowork の文書で「信頼できる出どころのスキルだけをアップロードする」よう注意している。

## スカウトと変換ツールの使い分け

| したいこと | 道具 |
| --- | --- |
| 多くの公開リポジトリから候補を集めて、比べて選ぶ | このスカウト |
| ZIP にしたいスキルが 1 本決まっている(手元のフォルダ・GitHub の URL・インストール済みのスキル) | 変換ツール [`../skill2zip.bat`](../skill2zip.bat)(説明は [`../README.md`](../README.md) の「1 つのスキルを ZIP にする」) |

どちらも同じ検査・安全な取得・読み替えの組み立てのコードを使う。そのコードは変換ツールのスキル
`shared/skills/m365-skill-convert/scripts/lib/` に 1 つだけあり、スカウトはそれを読み込む。

## 必要なもの

- Node.js 20 以上と git(Python は不要)。
- GitHub に接続できるネットワーク(社内のプロキシ設定は git の設定に従う)。
- 取得は**自分の PC で**行う。Microsoft 365 Copilot のサンドボックスはネットワークに出られないので、そこからは集められない。

## 流れ

```text
1. 集める   scout-scan.bat(fetch + scan)        → artifacts/skill-scout/report.md
2. 読む     report.md で候補を選び、SKILL.md と同梱ファイルを全文読む
3. 選ぶ     node m365-org-skills/scout/scout.mjs adopt <スキル名...>
4. 書く     artifacts/skill-scout/overlays.json の TODO(日本語の依頼例・読み替え)を埋める
5. 作る     scout-build.bat(build)              → artifacts/skill-scout/zips/*.zip
6. 試す     自分だけのエージェントに入れて試し、問題が無ければ推進担当へ
```

`artifacts/` は git の管理外なので、集めたものや作った ZIP がリポジトリに混ざることはない。
使い方の一覧は `node m365-org-skills/scout/scout.mjs --help`。

### 1. 集める

[`scout-scan.bat`](scout-scan.bat) をダブルクリックする。[`sources.json`](sources.json) に書かれたリポジトリから
スキルのフォルダだけを取得し、全スキルを検査して `artifacts/skill-scout/report.md` を開く。

探したい内容が決まっているときは、キーワードで関連度順に並べられる:

```bash
node m365-org-skills/scout/scout.mjs fetch
```

```bash
node m365-org-skills/scout/scout.mjs scan --keyword "議事録 meeting incident spec review"
```

取得したリポジトリは `artifacts/skill-scout/cache/node_modules/<リポジトリ名>` に置く。この道具は中のものを**一切実行しない**。
`node_modules` の下に置くのは、`npm test`(`node --test`)が取得物の中の `test-*.js` などをテストと間違えて実行しないため
(実際に一度起きた)。シンボリック リンクやサブモジュール、実行属性の付いたファイルは取り込まずに検査結果に出す。

検査に使う語句(人に関わる判断の語句、読み替えが要る語句、サンドボックスに無い CLI ツール)は
[`checks.json`](../../shared/skills/m365-skill-convert/scripts/lib/checks.json) で直せる(変換ツールと共通。自分用に変えるときは写しを作って `--checks <ファイル>` で渡す)。

### 2. 読む

`report.md` の判定は機械の下見にすぎない。

| 判定 | 意味 | 次にすること |
| --- | --- | --- |
| 候補 | ライセンス・形式・依存・危険の検査で引っかかるものが無い | 全文を読む |
| 要書き換え | 「`docs/` に保存」「`${input:...}`」「Slack を見る」など、Microsoft 365 向けの読み替えが要る記述がある | 全文を読み、読み替えを書く |
| 要確認 | ライブラリが要る、外部への通信がありうる、人物の評価や推定をする、ライセンスが判断できない など | 理由の箇所を読んで判断する。ライブラリは probe で実測してから |
| 不可 | 使えないライセンス、Windows 用スクリプト、サンドボックスに無いツールが必須、通信が必須 | 使わない |

全文を読むときの確認項目(今回実際に当たったもの):

1. **ライセンスはスキルのフォルダごとに見る。** リポジトリ直下が Apache-2.0 でも、フォルダの中に別の LICENSE があることがある。
   anthropics/skills の Word・Excel・PowerPoint・PDF のスキルは、複製・改変・配布を禁じる独自ライセンスで、社内でも使えない。
2. **動く前提か。** サンドボックスは通信も追加インストールもできない。`.cmd` `.bat` `.ps1` `.exe` は入れられない。
   LibreOffice・pandoc・markitdown などの外部ツールが前提のスキルは動かない。python-docx などのライブラリは、入っているかどうかが
   公開されていないので、probe(環境確認スキル)で実測してから採否を決める。
3. **何をさせるスキルか。** 会議の参加者一人ひとりの人物像や力関係を推定するスキル(cat-agent-skills の meeting-analyzer)は、
   社内で配ると人事評価やプライバシーの問題になりうるので見送った。人を評価・推定するものは推進担当に相談する。
4. **同梱ファイルも読む。** HTML や script があれば、外部の URL を読み込んだり送信したりしないか確かめる。
5. **外部のサービスを前提にしていないか。** Slack・Google Drive・Jira・`~~chat` のようなコネクタ前提の記述は、読み替えが要る。

### 3. 選ぶ

```bash
node m365-org-skills/scout/scout.mjs adopt incident-postmortem create-specification
```

`artifacts/skill-scout/overlays.json` に、選んだスキルの項目が「TODO」付きで追加される。
同じ名前のスキルが複数のリポジトリにあるときは、レポートの ID(`<リポジトリ>:<パス>`)で指定する。
判定が「不可」のスキルは追加されない(`--force` で上書きできるが勧めない)。
読み替えが要る箇所は、`extra` に TODO 付きの行として最初から入る。

### 4. 読み替えを書く

元の `SKILL.md` は**一字も変えない**。先頭に日本語の「Microsoft 365 Copilot で使うときの読み替え」の節を足す形にする。
共通の読み替え(日本語で答える、リポジトリへの保存はファイルで返す、社内システムには接続しない、資料に無いことを作らない、
秘密情報を書き写さない)は最初から入っている。スキルごとに次の 2 つを書く。

- `trigger_ja`: 日本語での依頼例。**同じエージェントに入れる別のスキルと取り合う依頼があれば、使い分けも書く**。
  例:「原因の分析だけを頼まれたときは使わない(root-cause-analysis を使う)」。スキルの選択は説明文(description)で行われるので、
  使い分けは本文ではなくここに書く。
- `extra`: そのスキル固有の読み替え。例:
  - 原文の保存先(`docs/adr/` など)の代わりに返すファイル名
  - 原文が「必ず埋める」と求める欄で、資料に無ければ「要確認」にすること
  - 原文の手順(「書く前に 2 つ以上質問する」など)を、エージェントの指示より優先すること
  - データベースに接続できないので、性能の指摘は「推定」と書くこと

書き方の実例は [`../third-party/overlays.json`](../third-party/overlays.json) にある。

### 5. 作る

[`scout-build.bat`](scout-build.bat) をダブルクリックする。TODO が残っていると止まる。取得し直した結果「不可」になったスキルが
あっても止まる。採用したあとに上流が更新されていれば警告が出るので、差分を読んでから作り直す。1 エージェントに入れられるのは
8 個までなので、それを超えると注意が出る。
ZIP には元の LICENSE(`LICENSE.txt`)と出典(`SOURCE.md`: リポジトリ・コミット・変更点)が入る。MIT や Apache-2.0 は、
この著作権表示と許諾表示を同梱することが利用の条件になっている。

### 6. 試す

1. 共有しない自分だけのエージェントを作り、ZIP を追加する(手順は [`../README.md`](../README.md) の「検証用エージェントで試す」)。
2. 実際の資料で頼み、次を確かめる:
   - 依頼に合うスキルが選ばれるか(別のスキルに取られないか)
   - 読み替えが守られるか(日本語で答える、ファイルで返る、資料に無いことを作らない)
   - スクリプトがあるスキルは、エラーにならないか
3. 問題が無ければ推進担当に渡す。開発チーム向けの共有エージェントに入れるかどうかは推進担当が決める。

## 探す場所を増やす

[`sources.json`](sources.json) にリポジトリを足す。候補のリポジトリは次で探せる(GitHub の公開検索を使う。見つかったものを
自動では足さない):

```bash
node m365-org-skills/scout/scout.mjs discover
```

認証なしの GitHub 検索を使うので、1 分に 10 回までしか問い合わせられない。社内のプロキシを通す必要がある環境では、
Node の既定ではプロキシを使わないため失敗することがある(その場合は GitHub の画面で topic `agent-skills` などを検索する)。

2026-10 時点で中身を確かめた出どころ:

| 出どころ | 中身 | ライセンス | 向き不向き |
| --- | --- | --- | --- |
| github/awesome-copilot `skills/` | GitHub が運営するコミュニティ集。議事録・ADR・仕様書・障害報告など | MIT(一部のスキルは個別の LICENSE) | 手順書だけのものが多く、そのまま動きやすい |
| microsoft/cat-agent-skills `submissions/` | Microsoft が運営する、Copilot Studio・Cowork 向けの集まり | MIT | Microsoft 365 向けに書かれていて相性が良い。ライブラリ前提のものが混じる |
| anthropics/knowledge-work-plugins | 経理・人事・営業・法務・開発などの部門別 | Apache-2.0 | 社内システムへの接続前提の記述を、添付前提に書き換える必要がある |
| anthropics/skills | Anthropic 公式 | フォルダによって違う | Word・Excel・PowerPoint・PDF は独自ライセンスで使えない |

agentskills.io は仕様の説明で、スキルの一覧は載っていない。

## Windows で手作業するときの罠

この道具を使えば気にしなくてよいが、git や Git Bash で手作業するときに当たったもの:

- Git Bash で `git sparse-checkout set /skills/xxx/` と書くと、パスが `C:/Program Files/Git/skills/...` に化けて何も取得されない。
  そのコマンドにだけ `MSYS_NO_PATHCONV=1` を付けるか、PowerShell で実行する。ただし `MSYS_NO_PATHCONV=1` を常に設定すると、
  ローカルのフォルダからの `git clone`(`file://`)が壊れる(Git for Windows 2.53 で実測)。
- Git Bash の `ln -s` は、権限が無いとリンクを作らずにファイルを複製する。リンクの扱いを試すときは結果を `ls -la` で確かめる。
- 拡張子の無い `LICENSE` は Agent Builder の許可されたファイル形式に無いので、`LICENSE.txt` にする。
- 取得したリポジトリをリポジトリの中の普通のフォルダに置くと、`node --test` がその中の `test-*.js` を実行してしまう。

## レポートの限界

判定は文字列の照合なので、誤検出も見落としもある。2026-10-09 の実行で見えた誤検出の例:

- 「Rate individual」のように、人の評価と関係ない文脈の語句が「人に関わる判断」に当たる。
- 参考資料の中で CLI ツールに触れているだけでも「不可」になる。
- ブラウザで読む JS ファイルも「要確認」になる。

逆に「候補」でも安全の保証にはならない。最後は必ず人が全文を読む。

## ライセンスについて

- 使ってよいのは、社内での複製・改変・配布が許されるライセンス(MIT・Apache-2.0・BSD など)のものだけ。
- 著作権表示と許諾表示を同梱する(この道具は `LICENSE.txt` として自動で入れる)。Apache-2.0 は改変した旨の明記も条件で、
  この道具は `SOURCE.md` に変更点を書く。
- ライセンスが見つからないもの、独自ライセンスのものは使わない。判断に迷うものは社内の OSS 利用規程に従い、推進担当に相談する。
- これは法的な助言ではない。社内に OSS の利用規程や法務の確認手順があれば、それに従う。
