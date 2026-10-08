# 職場でフォークして使うときの扱い

コードを見せてよい AI が **Microsoft 365 Copilot(職場・学校アカウント)と GitHub Copilot だけ**の
環境で、このリポジトリをフォークして `m365-skill-pack` を使うときの確認事項。無料モデルや
第三者の AI サービス(opencode、Claude など)へは何も送らないことを前提にする。

## 想定フロー

```text
GitHub Copilot ─(skill: m365-skill-pack)→ スクリプト ─(UI Automation)→ Microsoft 365 Copilot
      ↑                                        │  セッション A: impl-session / セッション B: review-session
      └──── 判定の要約と取り込んだ差分 ←────────┘
```

1. GitHub Copilot が `m365-skill-pack` を呼び、`_m365/TASK.md` を書く。
2. スクリプトが入力バンドルを作り(`make-input.mjs`)、Microsoft 365 Copilot の 2 つのチャットを
   回す(`references/loop-protocol.md` の「External loop」)。
3. 終わったら出力を作業コピーに取り込み(`unpack-output.mjs`)、判定と変更ファイルの一覧を
   GitHub Copilot に返す。GitHub Copilot は差分を確認してから次の判断をする。

**このリポジトリにあるもの / フォークで作るもの**:

| 部品 | 状態 |
| --- | --- |
| skill 本体(手順・バンドル作成・取り込み・規約・エージェント定義シート) | ある(`shared/skills/m365-skill-pack/`、GitHub Copilot 向けは `dist/copilot/`) |
| ループの制御(状態行で次の送り先を決める) | ある(`tools/m365-emu/external.mjs`。運ぶ手段に依存しない) |
| UI Automation で Copilot を操作する部品 | **無い**。フォークで作り、`manualSession()` と同じ形(`turn(round, message, attachments)`)にする |
| 実リポジトリに対して外部ループを回す入口 | **無い**。`tools/m365-emu` は練習用フィクスチャしか受け付けない。フォークで「skill → 入口スクリプト → `runLoop` → 取り込み → 要約を出力」を作る |

## データの行き先

| 何が | どこへ | 備考 |
| --- | --- | --- |
| リポジトリのファイル一式と `_m365/TASK.md` | Microsoft 365 Copilot(職場テナント) | 企業向けデータ保護の対象。`.env*`・鍵・資格情報ファイルは `make-input.mjs` が自動で除外(下記) |
| `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md` | 同上(`_m365/CONVENTIONS/`) | 秘密を書かないこと |
| 入力・出力バンドルの写し | `M365_DROP_DIR` を設定したときだけ、その OneDrive フォルダ | **職場の OneDrive** を指すこと |
| TASK、判定、差分 | GitHub Copilot | 組織の GitHub Copilot ポリシーの範囲 |
| 送る内容(手動ドライバ) | クリップボード | 下記「クリップボード」 |

スクリプト類は、上記以外に通信しない(テレメトリ・自動更新・外部 API 呼び出しは無い)。外部へ出る
可能性がある箇所は、次の「止めるもの」に挙げたものだけ。

## フォークで消す・止めるもの

- **`tools/m365-emu/config.json` の `"allowOpencode"` を `false` にする**。opencode ドライバ(無料モデルに
  練習用フィクスチャを送る)が、どの指定でも起動しなくなる。合わせて `tools/m365-emu/m365-emu.bat` を消してよい。
  既定のドライバは手動(人が Copilot に運ぶ)で、opencode は明示しないと動かない。
- **`.github/workflows/claude.yml` を消す**。コメントの `/claude` で Claude(Anthropic)を呼ぶ。外部リポジトリ
  `noxitro/github-templates` の共通ワークフローを `@main` で参照している。
- **`.github/workflows/secret-scan.yml` を置き換える**。同じ外部リポジトリを `@main` で参照しており、その中身が
  変わればフォークの権限で動く。組織の秘密スキャンに置き換えるか、中身を取り込んで固定する。
- 任意: `.github/workflows/link-check.yml`(GitHub のランナーが文書内の公開 URL にアクセスする。コードは送らない)。
  他のアクション(`actions/checkout@v4` など)も、組織の規則で SHA 固定が要るなら合わせる。
- 任意: OpenCode 向けの生成物(`dist/opencode/`)。モデルではなく配布物で、通信はしない。

## 運用上の注意

- **probe の `--network` を付けない**。付けたときだけ、サンドボックスから外部(1.1.1.1:443)への接続を試す。
  既定では何にも接続しない。
- **クリップボード**: 手動ドライバは送る内容をクリップボードに入れる。Windows の「クリップボードの履歴」
  と「デバイス間で共有」が有効だと、内容が同期されうる。実コードを扱う UI Automation 部品では、
  クリップボードを使わない入力方法にするか、この設定を無効にした端末で動かす。練習用フィクスチャだけなら
  `--skip-clipboard` でも運べる。
- **`tools/m365-emu` に実リポジトリを流さない**。フィクスチャしか受け付けない作りを外さないこと。
  個人向け Copilot に貼る手動ドライバは企業向けデータ保護の外になる。
- **入力から外すファイル**: `make-input.mjs` は既定で `.git`・`node_modules`・ビルド出力・`.env`/`.env.*`/`.envrc`・
  鍵(`*.pem` `*.key` `*.pfx` `*.p12` `*.jks` `*.ppk` `id_rsa*` `id_ed25519*` `*.keystore`)・
  `secrets.*`/`credentials.*`・`.ssh/` `.aws/` `.azure/` `.gnupg/`・`.npmrc` `.pypirc` `.netrc` `.git-credentials`・
  `*.kdbx`・`*.tfstate*`・`*.publishsettings` を除外する。プロジェクト固有の秘密は `--exclude <glob>` で足し、
  入力のファイル一覧(ZIP の中身)を最初の数回は人が確認する。
- **リンクでの導入**: `toolkit.local.json`(git に入らない)にこの端末用のリンクを書き、`npm run links`。
