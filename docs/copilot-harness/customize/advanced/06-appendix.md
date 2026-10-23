# 6. 付録

## A. 載せる・載せないの判定一覧

基準: GitHub Copilot(CLI・アプリ)で対応し、かつ他のエージェント環境のどれか 1 つ以上で同じ形式か同じ考え方が通用する。
Copilot の列は公式の対応表(customization cheat sheet、2026-10-21 取得 ◎)の Copilot CLI 列。アプリはこの表に列が無く、CLI の上に構築されている ◎ことから CLI と同じとみなす。

| 機能 | Copilot CLI | 他環境の例 | 判定 | 章 |
| --- | :-: | --- | --- | --- |
| カスタム指示(AGENTS.md 等) | ✓ | Claude Code、OpenCode、Codex | 載せる | 1 |
| エージェントスキル(SKILL.md) | ✓ | Claude Code、OpenCode、Codex(同じ仕様) | 載せる | 2 |
| カスタムエージェント / サブエージェント | ✓ | Claude Code、OpenCode、Codex(形式は別) | 載せる(設計を) | 3 |
| MCP サーバー | ✓ | 全部 | 載せる | 4 |
| フック | ✓ | Claude Code、Codex | 基準は満たす。ユーザーハーネスの部品ではないため**概要だけ**(D-2) | — |
| プラグイン | ✓ | Claude Code | 基準は満たす。配布の手段であり部品ではないため**概要だけ**(D-3) | — |
| プロンプトファイル(.prompt.md) | **✗** | — | **載せない**。スキルの `/名前` 起動で代替(D-1) | — |
| Plan / Autopilot、クラウドサンドボックス、Canvas、Computer use、Automations、BYOK | アプリ固有 | — | 載せない(D-4) | — |

## B. Copilot での置き場の早見表(2026-10 時点 ◎)

| 部品 | リポジトリ | 個人 | 備考 |
| --- | --- | --- | --- |
| 指示 | `AGENTS.md`(ネスト可)、`.github/copilot-instructions.md`、`.github/instructions/**/*.instructions.md` | `~/.copilot/copilot-instructions.md`、`~/.copilot/instructions/**/*.instructions.md` | 全部結合。優先順位なし。`CLAUDE.md` `GEMINI.md` も読む |
| スキル | `.github/skills/<name>/SKILL.md`(`.agents/skills/`、`.claude/skills/` も) | `~/.copilot/skills/`、`~/.agents/skills/` | 同名は先勝ち(リポジトリ > 個人) |
| カスタムエージェント | `.github/agents/<name>.agent.md`(`.claude/agents/` も) | `~/.copilot/agents/<name>.agent.md` | 同 ID は**個人が優先**(スキルとは逆) |
| MCP | `.github/mcp.json`(共有)、`.mcp.json`(ローカル) | `~/.copilot/mcp-config.json` | 近いファイルが優先。フォルダ信頼後にだけ読む |
| フック | `.github/hooks/*.json` | `~/.copilot/hooks/` | version 1 の JSON |
| 承認の保存 | — | `~/.copilot/permissions-config.json` | 拒否は保存されない(`--deny-tool` は起動ごと) |
| CLI の設定 | `.github/copilot/settings.json` | `~/.copilot/settings.json` | `disabledSkills`、`enabledMcpServers` など |

`COPILOT_HOME` で `~/.copilot` の場所を変えられる ◎。

## C. 確認コマンド集

| 目的 | セッション内 | 非対話 |
| --- | --- | --- |
| 読まれた環境の全体 | `/env` | — |
| 指示ファイルの一覧と個別の無効化 | `/instructions` | `copilot instruction list [--json]` |
| スキルの一覧・詳細・再読み込み | `/skills list`、`/skills info <name>`、`/skills reload` | `copilot skill list [--json]` |
| スキルの手動起動 | `/<name> 引数` | — |
| エージェントの一覧と選択 | `/agent` | `copilot --agent=<name> --prompt "..."` |
| MCP の一覧・詳細・停止 | `/mcp list`、`/mcp show <name>`、`/mcp disable <name>` | `copilot mcp list` |
| 承認のリセット | `/reset-allowed-tools` | — |
| 新しいセッション(指示の再読み込み) | `/new` | — |

## D. 対象外の機能(名前と理由だけ)

### D-1. プロンプトファイル(`.github/prompts/*.prompt.md`)

VS Code と Visual Studio では使えるが、**Copilot CLI とアプリでは読まれない** ◎(公式の対応表で ✗。CLI のカスタマイズ一覧にも記述が無い)。
同じ用途(定型の起動文を `/名前` で呼ぶ)はスキルで実現する。第 5 章の `phase-loop` がその形。

### D-2. フック(概要のみ)

セッションの節目でシェルコマンド(または HTTP、プロンプト)を自動実行する仕組み ◎。Copilot CLI と Copilot cloud agent が対応 ◎。アプリでは「プラグインが同梱できる」としか書かれていない ◎。

- 置き場: `.github/hooks/*.json`(リポジトリ)、`~/.copilot/hooks/`(個人)◎。`{ "version": 1, "hooks": { ... } }` の JSON ◎。
- 主な節目: `sessionStart`、`sessionEnd`、`userPromptSubmitted`、`userPromptTransformed`、`preToolUse`、`postToolUse`、`postToolUseFailure`、`agentStop`、`subagentStart`、`subagentStop`、`errorOccurred`、`preCompact`、`permissionRequest`、`notification` ◎。
- できること: `preToolUse` でツール呼び出しを `allow` / `deny` / `ask` に振り分ける、引数を書き換える ◎。`agentStop` で停止を差し止めてもう 1 ターン回す ◎。
- 本資料で扱わない理由: ユーザーハーネスの 1 周はスキルとエージェントで閉じており、フックを前提にすると他環境に持ち運べない部分が増える。
  `preToolUse` で `tests/` 配下への書き込みを機械的に deny する、のような使い方は有効なので、ハーネスが回り始めた後の強化策として検討する。

### D-3. プラグイン(概要のみ)

スキル・カスタムエージェント・フック・MCP 設定をまとめて配布する単位 ◎。マーケットプレイス、リポジトリ、ローカルパスから導入できる ◎。
本資料では「管理リポジトリからコピーで配る」(第 5.6 節)を採るので扱わない。自前のマーケットプレイスを立てる段になったら再検討する。

### D-4. アプリ固有の機能

Plan / Autopilot モード、クラウドサンドボックス、Canvas、Computer use、Automations、BYOK ◎。どれもエージェント環境の UI 機能で、資産の置き方には関係しない。
Plan モードだけは第 5.4 節で「HARNESS.md の草案を出させる」ときに使う。

## E. 他のエージェント環境での対応(2026-10-21 取得、公式文書 ◎)

登録方法は説明しない。「同じ形式が通用するか」の確認だけ。

| 機能 | Claude Code | OpenCode | Codex CLI |
| --- | --- | --- | --- |
| 指示ファイル | `CLAUDE.md`(無ければ `AGENTS.md` を読む。v2.1.277 以降)。サブディレクトリは必要時に読む | `AGENTS.md`(無ければ `CLAUDE.md`)。上位ディレクトリへ遡る | `AGENTS.md`(`AGENTS.override.md` が優先)。ルートから作業ディレクトリまで連結、32 KiB 上限 |
| スキル(SKILL.md) | 同じ仕様 ◎。`.claude/skills/`、`~/.claude/skills/` | 同じ仕様 ◎。`.opencode/skills/` のほか `.claude/skills/`、`.agents/skills/`、`~/.claude/skills/`、`~/.agents/skills/` も読む | 同じ仕様 ◎。`.agents/skills/`(作業ディレクトリ・親・リポジトリルート)、`~/.agents/skills/` |
| カスタムエージェント | `.claude/agents/*.md`(Markdown + frontmatter、`name` `description` 必須) | `.opencode/agents/*.md` または `opencode.json` の `agent` | `.codex/agents/*.toml`(`name` `description` `developer_instructions` 必須) |
| MCP | `.mcp.json`(`mcpServers`、`type` は stdio / http)、`~/.claude.json` | `opencode.json` の `mcp`(`type` は local / remote) | `~/.codex/config.toml` の `[mcp_servers.<name>]` |
| フック | `settings.json` の `hooks` | ネイティブのフックは無し。JS/TS プラグインでイベント購読 | `hooks.json` または `config.toml` の `[hooks]` |

持ち運びの指針:

- **スキルは `.github/skills/` を正にして、他環境向けには `.agents/skills/` にコピーする。** OpenCode と Codex は `.agents/skills/` を読み、Copilot も読む。
- **指示は `AGENTS.md` を正にする。** Claude Code だけは `CLAUDE.md` があるとそちらを読むので、`CLAUDE.md` には「`AGENTS.md` を見よ」とだけ書く(正典 1 か所)。
- **MCP の `.mcp.json` は Copilot と Claude Code で同じファイル名だが、`type` の値が違う**(Copilot は local / http、Claude Code は stdio / http)。
  両方で使うリポジトリでは、Copilot 用を `.github/mcp.json`、Claude Code 用を `.mcp.json` に分ける ▲(同居させたときの挙動は未確認)。
- **カスタムエージェントは環境ごとに書き直す。** 持ち運ぶのは本文(規則と報告形式)で、frontmatter は環境の書式に合わせる。

## F. スクリーンショットの撮影指定

資料には固定の画像を入れていない(アプリの画面は版で変わる)。説明会の前にリーダーが手元の環境で撮り、`images/ss-<n>.png` に置いて本文の `📷 SS-n` の位置に差し込む。
撮る前に: アカウント名・組織名・リポジトリ名・Issue 本文など、公開してはいけない情報が映らないサンプルリポジトリを使う。版(アプリと CLI)と撮影日を各画像の脚注に書く。

| 番号 | 章 | 何を撮るか | 画面に入っているべきもの |
| --- | --- | --- | --- |
| SS-1 | 1 | `/instructions` の出力 | `AGENTS.md` と `.github/instructions/*.instructions.md` が一覧に出ている |
| SS-2 | 2 | `/skills list` の出力 | `build-and-test` と `phase-loop` の name と description |
| SS-3 | 2 | 依頼を打ってスキルが読み込まれた表示 | スキル名が読み込みの表示に出ている。直後の応答の冒頭 |
| SS-4 | 3 | `/agent` の一覧 | `implementer` と `reviewer` の description |
| SS-5 | 3 | 審査役に修正を頼んで断られた応答 | 「直さない。FAIL にする」趣旨の応答と、ファイルが変わっていない `git status` |
| SS-6 | 4 | `/mcp list` の出力 | 組み込みの GitHub MCP サーバーと、追加した 1 つ |
| SS-7 | 4 | MCP ツール呼び出しの承認ダイアログ | 「今回だけ / セッション中 / 今後聞かない」の選択肢 |
| SS-8 | 5 | `/phase-loop 1` 直後の復唱 | 「実装:」行とゲート条件 3 件の復唱 |
| SS-9 | 5 | 審査役の VERDICT: FAIL の報告 | 生出力の末尾、再現手順、陽性コントロールの節 |
| SS-10 | 5 | セッションの使用量表示 | 本体とサブエージェントの消費が分かれている(版により表示が異なる △) |
| SS-11 | 5 | アプリのセッション一覧 | 1 フェーズ 1 セッションで、各セッションにブランチ名が付いている |

## G. 参照(2026-10-21 取得)

GitHub Docs(Copilot CLI)

- Add custom instructions to Copilot CLI — <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>
- Add skills to Copilot CLI — <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills>
- Create custom agents for Copilot CLI — <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli>
- Invoke custom agents — <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents>
- Add MCP servers to Copilot CLI — <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
- Allowing tools in Copilot CLI — <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools>
- Copilot CLI command reference — <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- Copilot CLI configuration directory reference — <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference>
- Copilot CLI hooks reference — <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference>
- Comparing Copilot CLI features — <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features>
- About custom agents (CLI) — <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents>
- Administer Copilot CLI for your enterprise — <https://docs.github.com/en/copilot/how-tos/copilot-cli/administer-copilot-cli-for-your-enterprise>

GitHub Docs(共通)

- Customization cheat sheet — <https://docs.github.com/en/copilot/reference/customization-cheat-sheet>
- About agent skills — <https://docs.github.com/en/copilot/concepts/agents/about-agent-skills>
- Custom agents configuration — <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
- About MCP — <https://docs.github.com/en/copilot/concepts/context/mcp>
- Hooks reference — <https://docs.github.com/copilot/reference/hooks-reference>
- About plugins — <https://docs.github.com/en/copilot/concepts/agents/about-plugins>
- Configure an enterprise MCP allowlist — <https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-enterprise-allowlist>
- Supported surfaces for policies — <https://docs.github.com/en/copilot/reference/supported-surfaces-for-policies>

GitHub Docs(GitHub Copilot app)

- About the GitHub Copilot app — <https://docs.github.com/en/copilot/concepts/agents/github-copilot-app>
- Quickstart for the GitHub Copilot app — <https://docs.github.com/en/copilot/get-started/quickstart-copilot-app>
- Customize the GitHub Copilot app — <https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app>
- Agent sessions — <https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions>
- Configure local sandboxing — <https://docs.github.com/en/copilot/how-tos/github-copilot-app/configure-local-sandboxing>

仕様・他環境

- Agent Skills specification — <https://agentskills.io/specification>
- Claude Code: Memory / Skills / Subagents / MCP / Hooks — <https://code.claude.com/docs/en/memory> 、/skills 、/sub-agents 、/mcp 、/hooks
- OpenCode: Rules / Skills / Agents / MCP servers / Plugins — <https://opencode.ai/docs/rules/> 、/skills/ 、/agents/ 、/mcp-servers/ 、/plugins/
- Codex: AGENTS.md / Skills / Subagents / MCP / Hooks — <https://learn.chatgpt.com/docs/agent-configuration/agents-md> 、/docs/build-skills 、/docs/agent-configuration/subagents 、/docs/extend/mcp 、/docs/hooks

実測(△)の出典: 実測記録(2026-10-19、Copilot CLI 1.0.100、最安帯モデル、小さな課題で各条件 1 回)。委譲のコスト比較、審査役の編集拒否、陽性コントロールの質のぶれは全てこの記録による。

## H. 用語集

README の用語表に、本文で使った語を足したもの。

| 語 | 意味 |
| --- | --- |
| 文脈(コンテキスト) | モデルが 1 回の応答で読める入力の全体。指示・description・ツール定義は常時乗る |
| 段階的な開示 | スキルの仕組み。description だけ常時、本文は合致時 |
| サブエージェント | 本体から委譲されて別の文脈で走るエージェント。カスタムエージェントの設定で起動する |
| 委譲 | 本体が作業をサブエージェントに渡すこと。description に合致すると自動で起きる |
| オーケストレータ | ユーザーハーネスの 1 周を回す本体のチャット。実装も判定もしない |
| ゲート条件 | 審査役が機械的に確認できる合格条件。「正しく動く」は条件ではない |
| 陽性コントロール / 陰性コントロール | 壊した実装で FAIL が出るか / 正しい実装で PASS が出るか。両方揃って検査になる |
| 未検証 | 試していない項目。PASS にも FAIL にも数えず、理由付きで残す |
| 周回上限 | 1 フェーズの実装 → 審査の繰り返し回数の上限(3)。超えたら人に戻す |
| 正典 | 規約の置き場を 1 か所に決めたもの。他は参照だけ |
