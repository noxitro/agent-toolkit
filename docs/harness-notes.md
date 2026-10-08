# ハーネスごとのメモ

各ハーネスが資産をどこから探すか、そして正しく見える資産が何もしなくなる罠。バージョンに
依存する記述には日付を付けてある。保証ではなくスナップショットとして読むこと。

## Claude Code

**導入。** `/plugin marketplace add noxitro/agent-toolkit` のあと
`/plugin install toolkit-core@agent-toolkit`。マーケットプレイスのマニフェストは
`.claude-plugin/marketplace.json` にあり、`./plugins/toolkit-core` を指す。プラグイン自身の
マニフェストは `plugins/toolkit-core/.claude-plugin/plugin.json`。

**プラグイン内での探索。** `skills/<name>/SKILL.md`、`commands/<name>.md`、`agents/<name>.md`。
スキルは `description` を見てモデルが発動し、コマンドは `/<name>` と打って呼び、エージェントは
サブエージェントとして起動される。

**メモ。**

- スキルの `name` はディレクトリ名と一致させる。読み込むかどうかの判断に使われる文章は
  description だけ。
- フックはハーネス固有なので、共有資産の契約には意図的に含めていない。

## OpenCode

**導入。** `dist/opencode/.` を全プロジェクト向けなら `~/.config/opencode/` に、1 つのプロジェクト
向けなら `.opencode/` にコピーする。`agent/` と `command/` の両方がそこから読まれる。Copilot の
プロンプトファイルと違い、グローバルの置き場は本当にワークスペース非依存。

**メモ。**

- **スキル機構が無い。** `opencode` を対象にしたスキルはグローバルなコマンドとして出力されるので、
  モデルが拾うのではなく人が打つ必要がある。自動発動してこそ価値がある資産なら、`targets` から
  `opencode` を外す。
- **権限はツールを狭めるのではなく消す。** エージェントの `permission` ブロックに包括的な `deny` が
  あると、そのツールはエージェントから丸ごと消え、`tools: { bash: true }` でも戻らない。失敗は
  静かで、能力が無いままエージェントは成功を報告し続ける。明示的に許可し、実際のツール呼び出しを
  観察して確かめる。
- OpenCode は Claude Code 互換のために `~/.claude/CLAUDE.md` も読む。`~/.config/opencode/AGENTS.md`
  で上書きしない限り、グローバルな Claude の指示が効く。
- プロジェクト外のパスは `external_directory` 権限で制御され、既定は `ask`。非対話の `opencode run`
  はこれを自動で拒否する。プロジェクト外の絶対パスを読む資産は、「指示を無視している」ように
  見えて、実際には遮断されている。
- 公式文書の置き場は複数形の `agents/`・`commands/`(2026-10 時点)。`npm run links` は複数形の
  側に張る。配布物は単数形の `agent/`・`command/` のままなので、コピーで導入して読まれない版では
  複数形に名前を変える。
- Windows では npm が `opencode` を PowerShell のシムとして入れる。実行ファイルが必要な
  ランチャーは `%APPDATA%\npm\opencode.cmd` を使う。

## GitHub Copilot

**導入。** `dist/copilot/.` を、資産を使いたいリポジトリの `.github/` にコピーする。

| 資産 | リポジトリ内の置き場 | ユーザーレベルの置き場 |
| --- | --- | --- |
| スキル | `.github/skills/<name>/SKILL.md` | `~/.copilot/skills/`、`~/.claude/skills/`、`~/.agents/skills/` |
| プロンプト | `.github/prompts/<name>.prompt.md` | VS Code のプロファイルのユーザーデータ(既定プロファイルは Windows: `%APPDATA%\Code\User\prompts\`) |
| エージェント | `.github/agents/<name>.agent.md` | `~/.copilot/agents/`、`~/.claude/agents/` |

**メモ。**

- **プロンプトファイルは既定でワークスペース単位。** あるリポジトリに入れたプロンプトは別の
  リポジトリでは出てこない。VS Code のユーザーレベルの場所に置けば見えるようになるが、*見つかる*
  ことと、ワークスペース外のパスを*読んでよい*ことは別。
- Copilot は agentskills.io のスキル形式(`SKILL.md` + frontmatter)を採用した。だから 1 つの
  ソースで Copilot と Claude Code の両方に配れる。共通の制約(`name` は小文字ハイフン区切りで
  64 文字以内かつディレクトリ名と一致、`description` は 1024 文字以内)は `npm run validate` が
  強制する。
- `~/.claude/skills/` が個人スキルの探索場所の 1 つなので、Claude Code 向けに入れたスキルは
  Copilot からも見える。特定のハーネスで動く前提の資産は、自分の本文にそう書く必要がある。
  置き場所は強制してくれない。
- Copilot CLI は `CLAUDE.md` を直接読むので、Claude の指示を持つリポジトリはそのまま動く。

### Visual Studio 2026(VS Code ではない)

生成物は同じで、呼び方とバージョンの下限が違う(2026-08 時点。バージョン依存):

- プロンプトファイルは VS 2022 17.10 以降で動くが、`#prompt:<file>` か ➕ アイコンから呼ぶ。
  カスタムプロンプトの `/` 補完は Visual Studio 2026 から。
- カスタム指示は**既定で無効**: ツール → オプション → GitHub → Copilot → Copilot Chat →
  「Enable custom instructions…」。
- カスタムエージェント(`.github/agents/*.agent.md`)は VS 2026 18.4 以降、Agent Skills は
  VS 2026 18.5 以降。
- プロンプトファイルの探索は開いているリポジトリの `.github/prompts` から始まるので、`.github/`
  へのコピー導入が公式の経路。

## ハーネス横断

- **フックは配られない。** フックの配線はハーネスごと(Claude Code: 作業ディレクトリの
  `.claude/settings*.json`、Copilot CLI/cloud: `.github/hooks/<skill>.json`)で、`shared/` からは
  生成しない。
- **資産を投機的に積まない。** 導入済みの description はすべて毎ターンのコンテキストに載る。
  資産を 1 つ増やすたびに他の全資産の発動精度が薄まり、レビューすべき面も広がる。
