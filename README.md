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
scripts/                          ビルドと検証
tests/                            スキルに同梱するスクリプトの単体テスト
toolkit.config.json               リポジトリごとのビルド設定
docs/                             ハーネスごとのメモ
```

`scripts/` と `toolkit.config.json` は、同じツールチェーンを姉妹リポジトリ(公開前の資産を
育てる incubation リポジトリ)にそのまま置けるように書いてある。違うのは `claudePlugin` だけ。
ツールチェーンをバイト単位で同一に保つことで、資産の昇格が「ファイル移動 + 再ビルド」で済む。

`dist/` と `plugins/*/{skills,commands,agents}` の中身はビルドのたびにゼロから作り直される。
直接編集しないこと。編集しても消され、CI が拒否する。

## 導入

### Claude Code

```bash
/plugin marketplace add noxitro/agent-toolkit
```

```bash
/plugin install toolkit-core@agent-toolkit
```

### OpenCode

配布物をグローバル設定ディレクトリ(全プロジェクト)か、1 つのプロジェクトの `.opencode/` に
コピーする。OpenCode はそこから `agent/` と `command/` の両方を読む。

```bash
cp -r dist/opencode/. ~/.config/opencode/
```

### GitHub Copilot(VS Code / CLI)

使いたいリポジトリに配布物をコピーする。

```bash
cp -r dist/copilot/. .github/
```

1 つのリポジトリでなく全ワークスペースで使いたい場合は、プロンプトファイルをユーザーレベルの
場所に置く。[docs/harness-notes.md](docs/harness-notes.md) を参照。

### 職場でフォークして使う場合

コードを見せてよい AI が Microsoft 365 Copilot と GitHub Copilot に限られる環境では、このリポジトリを
フォークせず、`m365-skill-pack` だけを書き出した本番用リポジトリを使う(`npm run export:m365 -- <dir>`)。
テスト用の模擬環境や無料モデルを使う経路は一切入らない。詳細とデータの行き先は
[docs/workplace-fork.md](docs/workplace-fork.md)。

### このクローンからシンボリックリンクで導入(開発中の自分用)

コピーやプラグイン導入の代わりに、生成物へのシンボリックリンクをユーザーレベルの探索場所に張ると、
`npm run build` の結果がそのまま全セッションに反映される。張るリンクはこのマシン用の
`toolkit.local.json`(git に入らない)の `links` に書く。`toolkit.local.example.json` をコピーして始める
(`path` は `~` 始まり可、`target` はリポジトリからの相対)。全員に張りたいリンクだけを `toolkit.config.json` の `links` に書く。

```bash
npm run links
```

`npm run links:check` で張られているかを確かめられる。Windows では開発者モードが要る。リンクは
絶対パスで張られるので、クローンを移動したら張り直す。同じ資産をプラグインでも導入すると二重に
読み込まれるので、どちらか一方にする。

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
| `new-agent-asset` | コマンド | このリポジトリに新しい資産の雛形を作る |
| `asset-reviewer` | エージェント | 新しい資産を読み取り専用で審査する |

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run validate` | 共有資産の契約、名前と置き場所の一致、`name` ≤ 64 と `description` ≤ 1024、名前の一意性、マシン固有パスの不在、マニフェストとバージョンの整合 |
| `npm run build` | 生成物のディレクトリをすべて `shared/` から作り直す |
| `npm run build:check` | コミット済みの生成物がソースと一致しなければ失敗(欠落・陳腐化・孤児ファイル) |
| `npm run check` | `validate` + `build:check`。コミット前に実行する |
| `npm run export:m365 -- <dir>` | `m365-skill-pack` だけを本番用リポジトリとして書き出す。外部モデル・通信 API・許可外 URL を検査し、見つかれば書かない。`--check` でずれを検査 |
| `npm test` | スキルに同梱するスクリプトの単体テスト(現在は `m365-skill-pack` の ZIP ライタ、バンドル書式、パッケージ検証、サンドボックス側 Python スクリプト、`m365-emu` の一巡。Python が PATH に無ければ Python のテストはスキップ) |
| `node tools/m365-emu/run.mjs` | `m365-skill-pack` の Microsoft 365 側を模擬し、練習用フィクスチャで一巡させて採点する。エージェント役は opencode と無料モデル(既定、`m365-emu.bat`)か、人が Microsoft 365 Copilot に手で運ぶ手動ドライバ(`--driver manual`、`m365-emu-manual.bat`)。手動ドライバでは、スクリプトが実装セッションとレビューセッションの間を回す外部ループ(`--loop external`、`m365-emu-loop.bat`)も使える。手引きは [tools/m365-emu/README.md](tools/m365-emu/README.md) |

## CI

| ワークフロー | 契機 | 強制する内容 |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | `main` への push、PR | `npm run validate`、`npm run build:check`、`npm test`、markdownlint |
| [`link-check.yml`](.github/workflows/link-check.yml) | Markdown を触る PR、毎週 | lychee によるリンク検査。定期実行で失敗したときは run を落とさず issue を開く |
| [`release.yml`](.github/workflows/release.yml) | タグ `v*` | タグが `package.json` と一致すること、`npm run check` 全体、`opencode.zip` / `copilot.zip` 付きのリリース発行 |

## バージョン管理

バージョンの正本は `package.json` だけ。`plugins/*/.claude-plugin/plugin.json` や
`.claude-plugin/marketplace.json` がそれと食い違えば `validate` が失敗し、タグが食い違えば
リリースのワークフローが失敗する。リリースするには 3 つを同時に上げてコミットし、`vX.Y.Z` の
タグを push する。

## ライセンス

[MIT](LICENSE)
