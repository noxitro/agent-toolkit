# agent-toolkit

コーディングエージェント向けのスキル・エージェント・コマンド・ワークフローを **1 回書いて**、
**Claude Code**・**OpenCode**・**GitHub Copilot**(VS Code / CLI / Visual Studio 2026)へ配るための
リポジトリ。

各ハーネスは自分の決まったパスにある資産しか見つけないので、「共有」を 3 つが同時に読む
1 つの物理ディレクトリで実現することはできない。代わりに、すべての資産を [`shared/`](shared/) の
下に 1 回だけ書き、ビルドがハーネスごとの形に生成する。生成物はコミットするので、利用者は
ビルド無しに各ハーネスの通常の方法で導入でき、ソースと生成物がずれれば CI が落ちる。

## 対応ハーネス

| 役割 | Claude Code | OpenCode | GitHub Copilot |
| --- | --- | --- | --- |
| スキル | `skills/<name>/SKILL.md` | *(スキル機構が無いのでコマンドとして出力)* | `.github/skills/<name>/SKILL.md` |
| コマンド / プロンプト | `commands/<name>.md` | `command/<name>.md` | `.github/prompts/<name>.prompt.md` |
| サブエージェント | `agents/<name>.md` | `agent/<name>.md` | `.github/agents/<name>.agent.md` |
| 配布 | プラグイン マーケットプレイス | `~/.config/opencode/` へコピー | `.github/` へコピー |

ハーネスごとの詳細、バージョン要件、既知の罠は [docs/harness-notes.md](docs/harness-notes.md) を
参照。

## 構成

```text
.claude-plugin/marketplace.json   Claude Code のマーケットプレイス マニフェスト
shared/                           単一ソース — 編集するのはここだけ
  skills/<name>/SKILL.md          (任意で references/ や scripts/ を同梱。そのままコピーされる)
  commands/<name>.md
  agents/<name>.md
plugins/toolkit-core/             生成物 — Claude Code プラグインの中身
  .claude-plugin/plugin.json      (手書き)
  skills/ commands/ agents/       (生成)
dist/                             生成物 — コピーして使う配布物
  opencode/{agent,command}/
  copilot/{skills,prompts,agents}/
scripts/                          ビルド、検証、インストーラ
install.bat                       Windows 用のインストーラ(scripts/install-assets.ps1 を呼ぶ。Node.js 不要)
tests/                            スキルに同梱するスクリプトの単体テスト
toolkit.config.json               リポジトリごとのビルド設定
docs/                             ハーネスごとのメモ
m365-org-skills/                  Microsoft 365 Copilot(Agent Builder)で開発チームに配るスキルとエージェント定義
                                  (ハーネス向けの生成対象ではない。README は m365-org-skills/README.md)
```

`scripts/` と `toolkit.config.json` は、同じツールチェーンを姉妹リポジトリ(公開前の資産を
育てる incubation リポジトリ)にそのまま置けるように書いてある。違うのは `claudePlugin` だけ。
ツールチェーンをバイト単位で同一に保つことで、資産の昇格が「ファイル移動 + 再ビルド」で済む。

`dist/` と `plugins/*/{skills,commands,agents}` の中身はビルドのたびにゼロから作り直される。
直接編集しないこと。編集しても消され、CI が拒否する。

## 導入

どの方法も、入るのは同じ生成物。1 台の PC ではどれか 1 つにする(重ねると同じ資産が二重に
読み込まれる)。

| 使い方 | おすすめの方法 |
| --- | --- |
| Claude Code だけ使う | [プラグイン](#claude-code-のプラグイン)。権限不要で、更新も `/plugin` から |
| OpenCode / Copilot も使う、またはプラグインを使わない | [インストーラ](#インストーラユーザー単位にコピー)でユーザー単位のフォルダにコピー |
| 1 つのリポジトリのメンバー全員に Copilot 用の資産を配る | [そのリポジトリの `.github/` にコピー](#リポジトリの-github-にコピーcopilot) |
| このリポジトリで資産を開発している | [インストーラのリンクモード](#開発者向けリンクモード) |

### Claude Code のプラグイン

```bash
/plugin marketplace add noxitro/agent-toolkit
```

```bash
/plugin install toolkit-core@agent-toolkit
```

### インストーラ(ユーザー単位にコピー)

生成物を各ツールがユーザー単位で読むフォルダにコピーする。管理者権限も開発者モードも要らず、
コピーが終わればダウンロードしたフォルダは消してよい。

| OS | 実行するもの | 必要なもの |
| --- | --- | --- |
| Windows 10 / 11 | `install.bat`(中身は `scripts/install-assets.ps1`) | なし(Windows に入っている PowerShell 5.1 で動く) |
| macOS / Linux | `node scripts/install-assets.mjs` | Node.js 20 以上(`npm ci` は不要) |

1. [リリース](https://github.com/noxitro/agent-toolkit/releases)の「Source code (zip)」をダウンロード
   する(または `git clone`)。
2. **Windows**:展開する**前に** ZIP を右クリック →「プロパティ」→「許可する」にチェック →「OK」。
   そのあと展開し、`install.bat` をダブルクリックする。
   **macOS / Linux**:展開したフォルダで `node scripts/install-assets.mjs` を実行する。
3. 初回だけ、どのツール向けに入れるかを番号で聞かれる(例:`1,3`)。
4. 各ツールで新しいセッションを開くと読み込まれる。

更新は、新しい版をダウンロードして同じように実行するだけ。選んだツールと入れたファイルの記録は
ダウンロードしたフォルダではなく `~/.agent-toolkit/` にあるので、別の場所に展開した新しい版からでも
更新・削除できる。Windows 版と macOS / Linux 版は同じ記録を読み書きする。

| 操作 | Windows | macOS / Linux |
| --- | --- | --- |
| 入れる・更新する | `install.bat` | `node scripts/install-assets.mjs` |
| ツールを選び直す | `install.bat --setup` | `node scripts/install-assets.mjs --setup claude,copilot` |
| 状態を確かめる(何も変えない) | `install.bat --check` | `node scripts/install-assets.mjs --check` |
| アンインストール | `install.bat --remove` | `node scripts/install-assets.mjs --remove` |

| ツール | コピー先 |
| --- | --- |
| `claude` | `~/.claude/skills/`、`~/.claude/commands/`、`~/.claude/agents/` |
| `opencode` | `~/.config/opencode/commands/`、`~/.config/opencode/agents/` |
| `copilot` | `~/.copilot/skills/`、`~/.copilot/agents/`、VS Code のユーザー プロンプト フォルダ(既定プロファイル) |

安全側の決まり:

- **自分で置いたものは上書きしない。** インストーラが入れていないファイル、入れたあとに編集された
  ファイルは、上書きも削除もせずに知らせる(`--force` を付けたときだけ上書きする)。中身がこの版と
  同じなら、そのまま管理下に入れる。
- **要らなくなったものは消す。** 新しい版で無くなった資産や、選択から外したツールの資産は、
  インストーラが入れて未編集のものだけ削除する。
- Copilot(VS Code / CLI)は `~/.claude/skills/` と `~/.claude/agents/` も読むので、`claude` と `copilot` を
  両方選ぶと、二重に見えないよう Copilot 側のスキルとエージェントは入れない(プロンプトだけ入れる)。
- Claude Code のプラグインで入れている場合は、先に `/plugin uninstall toolkit-core@agent-toolkit` で外す。

組織で管理されている Windows PC で止まる場合:

- **「スクリプトの実行が無効になっている」「デジタル署名されていない」**:実行ポリシーがグループ
  ポリシーで固定されている。`install.bat` は今回の実行に限ってポリシーを緩めるが、グループ ポリシーの設定は
  それより優先される。手順 2 の「許可する」をしてから展開し直しても止まるなら、IT 部門に相談する。
- **「ConstrainedLanguage mode」と表示される**:AppLocker / WDAC でスクリプトが制限されている。
  インストーラは動かせないので、IT 部門に相談するか、上の表のコピー先に手でコピーする。

### リポジトリの `.github/` にコピー(Copilot)

1 つのリポジトリで、そのメンバー全員に使わせたい場合は、そのリポジトリに配布物をコピーして
コミットする。Visual Studio 2026 ではこれが公式の経路。

```bash
cp -r dist/copilot/. .github/
```

### 開発者向け:リンクモード

このリポジトリで資産を開発しているなら、コピーの代わりにこのクローンへのシンボリックリンクを
張れる。`npm run build` や `git pull` の結果がそのまま全セッションに反映される。

```bash
npm run links                    # = node scripts/install-assets.mjs --link
npm run assets -- --copy         # コピーに戻す
npm run assets:check
```

Windows では `install.bat --link`。シンボリックリンクの作成には**開発者モード**(または管理者として
実行)が要り、無効なら設定画面を開く。開発者モードは PC 全体の設定で、組織の管理下の PC では有効に
できないことが多いので、利用者への配布にはコピーを使う。リンクは絶対パスで張られるので、クローンを
移動したらもう一度実行する。

プリセットで足りない場所は `toolkit.local.json`(git に入らない)の `links` に個別に書く(`path` は
`~` 始まり可、`target` はリポジトリからの相対)。選んだモードで入る。全員に入れたいものだけを
`toolkit.config.json` の `links` に書く。書式は `toolkit.local.example.json` を参照。

## 資産の書き方

`shared/` の下にソースを作り、`npm run check` を通してから、ソースと再生成した出力を一緒に
コミットする。

```yaml
---
name: my-asset            # 小文字の単語をハイフンでつなぐ。64 文字以内。ディレクトリ名(スキル)
                          # またはファイル名(コマンド・エージェント)と一致させる
description: Use when …   # 1024 文字以内。ハーネスが発動判断に使うトリガー文
targets: [claude, opencode, copilot]
harness:                  # 任意。ハーネスごとの逃げ道
  claude:
    frontmatter:          # 生成する frontmatter にそのまま混ぜられる
      allowed-tools: Read, Grep
  opencode:
    frontmatter:
      mode: subagent
  copilot:
    skip: true            # fork せずに、あるハーネスだけからこの資産を外す
---
```

可搬なのは `name`・`description`・`targets` だけ。それ以外(ツールの許可リスト、モデル固定、
権限、`mode`)はハーネス固有で、`harness.<name>.frontmatter` に置く。呼び出し引数は `{{ARGS}}` と
書く。ビルドがハーネス固有のプレースホルダ(`$ARGUMENTS`、Copilot のプロンプトファイルでは
`${input:args}`)に置き換える。本文でこのトークン自体に言及したいとき(書き方の説明など)は
`{{literal:ARGS}}` と書くと、どのハーネスでも置換されずに `{{ARGS}}` のまま出力される。

同じ規約と可搬性の罠は、このリポジトリの `agent-asset-authoring` スキルにも書いてあるので、
作業中のエージェントに直接読ませられる。

### ソースと出力の対応

| ソース | `claude` | `opencode` | `copilot` |
| --- | --- | --- | --- |
| `shared/skills/x/SKILL.md` | `plugins/toolkit-core/skills/x/SKILL.md` | `dist/opencode/command/x.md` | `dist/copilot/skills/x/SKILL.md` |
| `shared/commands/x.md` | `plugins/toolkit-core/commands/x.md` | `dist/opencode/command/x.md` | `dist/copilot/prompts/x.prompt.md` |
| `shared/agents/x.md` | `plugins/toolkit-core/agents/x.md` | `dist/opencode/agent/x.md` | `dist/copilot/agents/x.agent.md` |

資産名は 3 種類をまたいで一意にする。スキルとコマンドが同名だと、OpenCode の command
ディレクトリで衝突するため。

## 収録している資産

| 資産 | 種類 | 内容 |
| --- | --- | --- |
| `agent-asset-authoring` | スキル | 複数ハーネスで動く資産の書き方(共有 frontmatter の契約、ハーネス固有の設定の置き場、可搬性の罠) |
| `m365-skill-pack` | スキル | 実装↔監査の反復を Microsoft 365 Copilot のカスタムエージェント(Agent Builder)に委ねるための資産一式。スキル ZIP の検証と梱包、入力 ZIP の作成、結果の取り込み。日本語の手引きは [shared/skills/m365-skill-pack/README.md](shared/skills/m365-skill-pack/README.md) |
| `m365-skill-convert` | スキル | 既存のスキル(手元のフォルダ・GitHub の URL・インストール済み)を 1 本、Microsoft 365 Copilot(Agent Builder)のスキル ZIP にする。自動修正・機械チェック・日本語のレポート付き。日本語の手引きは [shared/skills/m365-skill-convert/README.md](shared/skills/m365-skill-convert/README.md) |
| `new-agent-asset` | コマンド | このリポジトリに新しい資産の雛形を作る |
| `asset-reviewer` | エージェント | 新しい資産を読み取り専用で審査する |

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run validate` | 共有資産の契約、名前と置き場所の一致、`name` ≤ 64 と `description` ≤ 1024、名前の一意性、マシン固有パスの不在、マニフェストとバージョンの整合 |
| `npm run build` | 生成物のディレクトリをすべて `shared/` から作り直す |
| `npm run build:check` | コミット済みの生成物がソースと一致しなければ失敗(欠落・陳腐化・孤児ファイル) |
| `npm run check` | `validate` + `build:check`。コミット前に実行する |
| `npm run assets` | 生成物をユーザー単位の探索場所に入れる・更新する(`-- --setup`・`-- --remove` も可。Windows の利用者向けは `install.bat`) |
| `npm run assets:check` | 入っている資産の状態を確かめる。欠落・古い版・不要なものがあれば失敗 |
| `npm run links` | `assets` をリンクモードで実行する(開発者向け) |
| `npm test` | スキルに同梱するスクリプトの単体テスト(現在は `m365-skill-pack` の ZIP ライタ、バンドル書式、パッケージ検証、サンドボックス側 Python スクリプトと、`m365-skill-convert` の変換)と、Node 版・PowerShell 版インストーラの同じシナリオでの検査。Python や PowerShell が PATH に無ければその分はスキップ(PowerShell の場所は環境変数 `PWSH` でも指定できる) |

## CI

| ワークフロー | 契機 | 強制する内容 |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | `main` への push、PR | `npm run validate`、`npm run build:check`、`npm test`、markdownlint、Windows(PowerShell 5.1)でのインストーラのテスト |
| [`link-check.yml`](.github/workflows/link-check.yml) | Markdown を触る PR、毎週 | lychee によるリンク検査。定期実行で失敗したときは run を落とさず issue を開く |
| [`release.yml`](.github/workflows/release.yml) | タグ `v*` | タグが `package.json` と一致すること、`npm run check` 全体、`opencode.zip` / `copilot.zip` 付きのリリース発行 |

## バージョン管理

バージョンの正本は `package.json` だけ。`plugins/*/.claude-plugin/plugin.json` や
`.claude-plugin/marketplace.json` がそれと食い違えば `validate` が失敗し、タグが食い違えば
リリースのワークフローが失敗する。リリースするには 3 つを同時に上げてコミットし、`vX.Y.Z` の
タグを push する。

## ライセンス

[MIT](LICENSE)。ただし [`m365-org-skills/third-party/`](m365-org-skills/third-party/) の公開スキル(と `_upstream/` の写し)は
元のリポジトリのライセンスに従う。どのライセンスが適用されるかは [`m365-org-skills/third-party/README.md`](m365-org-skills/third-party/README.md) に書いた。
