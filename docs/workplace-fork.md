# 本番(職場)での配布と使い方

コードを見せてよい AI が **Microsoft 365 Copilot(職場・学校アカウント)と GitHub Copilot だけ**の
環境で `m365-skill-pack` を使うときの配り方と確認事項。無料モデルや第三者の AI サービスへは何も
送らないことを前提にする。

## このリポジトリをフォークしない: 本番用リポジトリを書き出す

このリポジトリには、テスト用の模擬環境(`tools/m365-emu`。無料モデルを呼ぶ opencode ドライバを含む)、
Claude を呼ぶ GitHub のワークフロー、OpenCode 向けの生成物など、本番に要らないものが入っている。
Claude Code はマーケットプレイスを追加した時点で**そのリポジトリを丸ごと端末に置く**ので
(実測: `~/.claude/plugins/marketplaces/<名前>/` に、入れていないプラグインまで含めた全体があった)、
同じリポジトリの中でプラグインを分けても、要らないコードが職場の PC に届く。

そこで本番には、skill だけを書き出した**別のリポジトリ**を使う。

```bash
npm run export:m365 -- <本番用リポジトリのディレクトリ>
```

| 入るもの | 入らないもの |
| --- | --- |
| `plugins/m365-skill-pack/`(Claude Code 用プラグイン、skill 1 つ)と、それだけを載せたマーケットプレイス | `tools/`(模擬環境、opencode ドライバ、偽エージェント) |
| `copilot/skills/m365-skill-pack/`(GitHub Copilot 用、中身は同じ) | `.github/workflows/`(Claude、外部の共通ワークフロー、リンク検査) |
| README、LICENSE、`EXPORT.json`(元のコミットと全ファイルの SHA-256) | 他のスキル・コマンド・エージェント、`dist/opencode/`、テスト |

- **書き出し前の検査**: 全ファイルを走査し、外部のモデル提供元・テスト用の部品の名前、ネットワーク通信を
  行う API(`fetch(`、`socket.create_connection` など)、Microsoft の文書以外の URL が一つでもあれば、
  何も書かずに失敗する。skill 内のスクリプトはどれもネットワークに接続しない(probe の接続確認も削除済み)。
- **安全な上書き**: 書き出し先が「以前の書き出しではない、空でないディレクトリ」なら拒否する。消すのは、
  前回の `EXPORT.json` に載っていたファイルだけ。`.git` と、書き出しが作っていないファイルには触らない。
- **ずれの検査**: `npm run export:m365 -- <dir> --check` で、書き出し先が今のソースと一致するかを確かめる。
- 本番用リポジトリは生成物なので直接編集しない。UI Automation の部品など本番で足すものは、書き出しが
  管理しない別のパスに置く(上書きされない)。

## 想定フロー

```text
GitHub Copilot ─(skill: m365-skill-pack)→ スクリプト ─(UI Automation)→ Microsoft 365 Copilot
      ↑                                        │  セッション A: impl-session / セッション B: review-session
      └──── 判定の要約と取り込んだ差分 ←────────┘
```

| 部品 | 状態 |
| --- | --- |
| skill 本体(手順・バンドル作成と取り込み・規約・エージェント定義シート) | 本番用リポジトリに入る |
| ループの制御(状態行で次の送り先を決める `runLoop`) | 本番用リポジトリに入る(`scripts/lib/external-loop.mjs`) |
| UI Automation で Copilot を操作する部品 | **無い**。本番側で作り、`turn(round, message, attachments)` を持つセッションとして `runLoop` に渡す |
| 実リポジトリに対して外部ループを回す入口 | **無い**。本番側で「skill → 入口スクリプト → `runLoop` → 取り込み → 要約を出力」を作る |

## データの行き先

| 何が | どこへ | 備考 |
| --- | --- | --- |
| リポジトリのファイル一式と `_m365/TASK.md` | Microsoft 365 Copilot(職場テナント) | 企業向けデータ保護の対象。鍵・資格情報類は自動で除外(下記) |
| `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md` | 同上(`_m365/CONVENTIONS/`) | 秘密を書かないこと |
| 入力・出力バンドルの写し | `M365_DROP_DIR` を設定したときだけ、その OneDrive フォルダ | **職場の OneDrive** を指すこと |
| TASK、判定、差分 | GitHub Copilot | 組織の GitHub Copilot ポリシーの範囲 |

本番用リポジトリのスクリプトは、上記以外に通信しない(テレメトリ・自動更新・外部 API 呼び出しは無い)。

## 運用上の注意

- **クリップボード**: UI Automation の部品で貼り付けにクリップボードを使うと、Windows の「クリップボードの履歴」と
  「デバイス間で共有」が有効な端末では内容が同期されうる。クリップボードを使わない入力にするか、この設定を
  無効にした端末で動かす。
- **入力から外すファイル**: `make-input.mjs` は既定で `.git`・`node_modules`・ビルド出力・`.env`/`.env.*`/`.envrc`・
  鍵(`*.pem` `*.key` `*.pfx` `*.p12` `*.jks` `*.ppk` `id_rsa*` `id_ed25519*` `*.keystore`)・
  `secrets.*`/`credentials.*`・`.ssh/` `.aws/` `.azure/` `.gnupg/`・`.npmrc` `.pypirc` `.netrc` `.git-credentials`・
  `*.kdbx`・`*.tfstate*`・`*.publishsettings` を除外する。プロジェクト固有の秘密は `--exclude <glob>` で足し、
  入力のファイル一覧(ZIP の中身)を最初の数回は人が確認する。
- **個人向けの無料 Copilot にバンドルを添付しない**(企業向けデータ保護が無い)。

## このリポジトリ自体をフォークする場合(非推奨)

どうしてもこのリポジトリごと使うなら、少なくとも次を行う: `tools/m365-emu/config.json` の
`"allowOpencode"` を `false` にする(opencode ドライバがどの指定でも起動しなくなる)、
`.github/workflows/claude.yml` を消す、`.github/workflows/secret-scan.yml`(外部リポジトリの共通ワークフローを
`@main` で参照)を組織のものに置き換える。それでもテスト用のコードは端末に残る。
