# m365-skill-pack

Microsoft 365 Copilot のカスタムエージェント(Agent Builder)に「実装 → 監査 → 修正」の反復を
任せ、Claude Code / GitHub Copilot 側は「タスク契約を書く」「入力 ZIP を作る」「結果を取り込む」
だけにして消費トークンを減らすための道具一式。

## 何が入っているか

| 場所 | 内容 |
| --- | --- |
| `SKILL.md` | Claude Code / GitHub Copilot 向けの手順(英語)。ハーネスが自動で読む |
| `m365/SETUP.md` | **Microsoft 365 Copilot 側で 1 回だけ行う**セットアップ手順(日本語) |
| `m365/agents/impl-loop.md`, `m365/agents/auditor.md` | Agent Builder に貼るエージェント定義シート |
| `m365/skills/implement`, `audit`, `probe` | Microsoft 365 側のスキル素材(`SKILL.template.md` + Python スクリプト) |
| `scripts/pack-skill.mjs` | スキルを検証して Agent Builder 用 `.zip` にする |
| `scripts/make-input.mjs` | リポジトリ全体 + `_m365/TASK.md` を入力 ZIP にする(中身は読まない) |
| `scripts/unpack-output.mjs` | 返ってきた出力 ZIP をリポジトリへ展開し、監査結果を表示する |
| `references/` | 公式文書に基づく制約一覧、バンドル書式、ループ規約 |

## 送信先の制限(必ず守る)

入力 ZIP を添付してよいのは **職場・学校アカウントでサインインした Microsoft 365 Copilot** だけ
です。エンタープライズ データ保護(EDP)が効くのはこの面だけで、無料の Copilot(Windows の
Store 版アプリや個人アカウントの copilot.microsoft.com)には EDP が無く、リポジトリの中身を
送ると**情報流出**になります。手元に無料版しか無い環境では ZIP を作るところまでにし、添付と
実行は Microsoft 365 Copilot が使える環境で行ってください。

## 前提

- 利用する Microsoft 365 テナントで Agent Builder が使え、「構成」タブに「スキル」の節がある
  (スキル機能はプレビューで Frontier プログラム登録と Copilot ライセンスまたは従量課金が要る)。
- ローカルに Node 20 以上。依存パッケージは不要(スクリプトは標準モジュールのみ)。
- サンドボックスの Python 版や添付ファイルの扱いは公式文書に無いため、**最初に probe スキルで
  実測**し、`references/*.md` の「Measured」表に書き込んでから本番に使う。

## 使い方

以下のコマンドの `<skill-dir>` は、このスキルが置かれているディレクトリ。このリポジトリでは
`shared/skills/m365-skill-pack`、Copilot 向け配布をコピーした先では `.github/skills/m365-skill-pack`、
Claude Code のプラグインとして導入した場合はプラグインの `skills/m365-skill-pack`。

### 初回(1 回だけ)

1. スキル ZIP を作る:

   ```bash
   node <skill-dir>/scripts/pack-skill.mjs <skill-dir>/m365/skills/implement <skill-dir>/m365/skills/audit <skill-dir>/m365/skills/probe --from-template --out ./m365-zips
   ```

2. `m365/SETUP.md` の手順で、Agent Builder に `impl-loop` と `auditor` を作り、
   ZIP を取り付け、probe を走らせて結果を記録する。

### タスクごと

1. `<repo>/.m365/<slug>/TASK.md` を書く(書式は `references/loop-protocol.md`)。
   Claude Code / Copilot に頼めばこのスキルが書く。
2. 入力 ZIP を作る:

   ```bash
   node <skill-dir>/scripts/make-input.mjs --task .m365/<slug>/TASK.md
   ```

   `.m365/<slug>/in-<slug>.zip` ができる。環境変数 `M365_DROP_DIR` に OneDrive の同期フォルダを
   指定すると、そこにもコピーされる。ZIP が添付として読めない面では `--format md`。
3. Microsoft 365 Copilot で `impl-loop` を開き、ZIP を添付して「Run the loop」を送る。
   返ってきた `out-<slug>-r<N>.zip` をダウンロードする(OneDrive にも出る)。
   独立した監査が欲しければ同じ ZIP を `auditor` に添付して「Audit this bundle」。
4. 取り込む:

   ```bash
   node <skill-dir>/scripts/unpack-output.mjs .m365/<slug>/out-<slug>-r2.zip
   ```

   変更はワークツリーに展開され(コミットはしない)、`_m365/*` は `.m365/<slug>/reports/` に
   入る。展開は入力時点のスナップショットとの三方比較で、サンドボックスが触らなかったファイルは
   手元の版を保ち、双方で変わったファイルは衝突として書かずに報告する(`--force` でサンドボックス
   の版を採る)。`_m365/manifest.json` の無い ZIP は単純上書き。配置できない内容(ディレクトリが
   要る場所にファイルがある、大文字小文字だけ違う名前など)は何も書かずに拒否する。入力から既定で
   除外されるパス(`node_modules/`、`.env`、`.venv/`、`.m365/`、鍵など)への書き込みは
   `git status` に出ないことがあるため `--allow-excluded` が要る。終了コードは衝突あり=3(判定より
   優先)、それ以外は PASS=0 / FAIL=2 / 監査結果なし=1。`git diff` と
   `reports/AUDIT.md` を見て、取り込むか再ラウンドかを決める。

## 制約の早見表

- スクリプトに入れられるのは `.py .js .mjs .cjs .ts .mts .sh .bash` だけ。`.cmd` / `.bat` /
  `.ps1` は不可(公式)。
- ZIP は丸ごとアップロード、1 エージェント 8 スキルまで、50 MB / 25 MB・ファイル / 350 ファイル、
  深さ 3。
- サンドボックスはネットワーク無し・パッケージ導入不可・git 無し。
- スキルを持つエージェントにはナレッジ(埋め込みファイル)を足せない。リポジトリの文脈は入力 ZIP で
  渡す。
- エージェント指示文は 8,000 文字。ナレッジに逃がしてはいけない(公式の注意)。

詳細と出典は `references/m365-constraints.md` と `references/agent-builder-rules.md`。

## 手動で ZIP を作る場合

`pack-skill.mjs` が使えないときは、`SKILL.template.md` を `SKILL.md` に改名し、`common/` の
中身をコピーしたうえで、PowerShell 7 の `Compress-Archive` でフォルダの**中身**(フォルダ自体では
なく)を圧縮する。拡張子・深さ・文字数の検証は手で行う。

## Cowork について

Copilot アプリの Cowork は同じ形式のスキル ZIP を受け付け、`.zip` 添付と OneDrive 出力を公式に
対応しているが、従量課金で、使えるかは組織設定次第。本線は Agent Builder のカスタムエージェント。

## テスト

リポジトリ直下で `npm test`(ZIP 生成の往復、バリデータ、バンドルの往復、Python スクリプトの
相互運用)。
