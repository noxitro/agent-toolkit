# doc-context-build

社内のドキュメント サイトを材料に、ガイドライン文書を Microsoft 365 Copilot に書かせるための
**「Copilot に添付する直前まで」**を自動化する道具。収集(collect)→ 文脈別の束ね(bundle)→
執筆ルールの合成(compose)の 3 段で、設計は [docs/doc-automation-workflow.md](../../../docs/doc-automation-workflow.md)。

執筆そのものは Microsoft 365 Copilot の執筆エージェントが行う。このスキルはサイトに触り、
社内情報をローカルに写すので、**キャッシュと出力の置き場は元サイトの閲覧範囲に合わせる**こと。

## 何が入っているか

| 場所 | 内容 |
| --- | --- |
| `SKILL.md` | Claude Code / GitHub Copilot 向けの手順(英語)。ハーネスが自動で読む |
| `scripts/collect.py` | 収集。ホーム URL からツリーを辿り、`out/cache/pages/` に 1 ページ 1 ファイルで保存 |
| `scripts/bundle.py` | 束ね。`manifest.json` に従って `out/bundles/<文脈>.md` を作り、変更の影響(`impact.md`)を出す |
| `scripts/compose.py` | 合成。ルールと束から `out/context/<ガイドライン>.md`(大きければ `part1..N`)を作る |
| `scripts/docctx_lib.py` | 共通部品(設定、HTML → Markdown、front matter) |
| `build-context.bat` | 3 段を順に実行する Windows 用の起動ファイル |
| `example/` | プロジェクトの雛形(`docctx.json`、`manifest.json`、`rules/`)。コピーして使う |

必要なもの: Python 3.8 以上(標準ライブラリだけ)。

## 使い方

### 1. プロジェクトを作る

`example/` を任意の場所にコピーし、`docctx.json` を直す。

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `root_url` | ツリーの起点(ホーム URL)。同じホストで、このパス配下だけを辿る | 必須 |
| `max_depth` | 起点からの深さの上限 | 3 |
| `max_pages` | 安全のためのページ数上限 | 500 |
| `exclude` | パスにこの文字列を含むページは辿らない | `[]` |
| `token_env` | アクセス トークンを入れる環境変数の名前 | `DOC_SITE_TOKEN` |
| `auth_header` | トークンの送り方。`{token}` が置き換わる | `Authorization: Bearer {token}` |
| `stale_days` | 束の最も古いページがこの日数より古ければ警告 | 30 |
| `split_chars` | 合成結果がこの文字数を超えたら分割 | 30000 |
| `out_dir` / `rules_dir` / `manifest` | 出力先、ルールの場所、目録の場所(設定ファイルからの相対) | `out` / `rules` / `manifest.json` |

トークンは環境変数に入れる。ファイルには書かない。

```bat
set DOC_SITE_TOKEN=<トークン>
```

`manifest.json` で文脈(束)とガイドラインを決める。`include` は URL のパス接頭辞、`pages` は
単独ページ、`exclude` は除外する文字列。ガイドラインは束 1 つとカテゴリ 1 つを指す。

`rules/` に執筆ルールを置く。`common.md`(共通、必須)、`<カテゴリ>.md`(任意)、
`<ガイドライン>.md`(任意)、`output-contract.md`(出力契約と自己検査、必須。合成結果の末尾に入る)。

### 2. 実行する

```bat
build-context.bat <プロジェクトのフォルダー>
```

または個別に:

```bash
python scripts/collect.py <プロジェクト>
python scripts/bundle.py <プロジェクト>
python scripts/compose.py <プロジェクト>
```

### 3. Copilot に渡す

`out/context/<ガイドライン>.md` を Microsoft 365 Copilot の執筆エージェントに添付する。
`part1.md` 〜 `partN.md` に分かれているときは、**全部を 1 回のメッセージに添付**する(1 会話
20 ファイルまで)。`<ガイドライン>.sources.json` に、使った元ページと取得日が残る。

## 古さの検知

- `collect.py` は 2 回目以降、キャッシュ済みページを条件付きで要求(ETag / Last-Modified)し、
  本文ハッシュでも比べる。変わったページだけ書き換え、消えたページは `cache/_removed/` へ移す。
  結果は `out/cache/changes.md`。
- `collect.py --dry-run` は何も書かずにサイトとキャッシュを比べる(差分があれば終了コード 3)。
  定期実行して「再収集が要るか」を知る用途。
- `bundle.py` は直前の収集で変わったページが、どの束とどのガイドラインに影響するかを
  `out/bundles/impact.md` に出す。書き直しが要るガイドラインの一覧になる。
- `compose.py` は束の最も古いページが `stale_days` より古ければ警告し、コンテキストの冒頭にも
  その旨を書く。`--strict` ならそのガイドラインを作らず終了コード 1。
- 出力契約で、生成物の末尾に「元ページの取得日」を書かせる。

## 出力の構成

```text
out/
├── cache/
│   ├── index.json        URL → ファイル・ハッシュ・取得日時・リンク
│   ├── changes.md        直前の収集の追加・変更・削除
│   ├── pages/*.md        1 ページ 1 ファイル(front matter 付き)
│   └── _removed/         元サイトから消えたページ
├── bundles/
│   ├── <文脈>.md         束
│   └── impact.md         変更の影響(束 → ガイドライン)
└── context/
    ├── <ガイドライン>.md            添付する 1 本(分割時は .part1.md …)
    └── <ガイドライン>.sources.json  使った元ページと取得日
```

## 試し方(模擬サイト)

リポジトリの `tests/fixtures/doc-site/` にトークン必須の模擬サイトがある。

```bash
python tests/fixtures/doc-site-server.py tests/fixtures/doc-site --port 8765
```

別のターミナルで `set DOC_SITE_TOKEN=test-token` のうえ `build-context.bat shared/skills/doc-context-build/example`
を実行すると、`example/out/` に一式ができる。自動テストは `tests/doc-context-build.test.mjs`。
