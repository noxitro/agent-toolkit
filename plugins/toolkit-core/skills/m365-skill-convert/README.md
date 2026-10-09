# m365-skill-convert(スキルを Microsoft 365 Copilot 用の ZIP にする)

手元にある・GitHub にある・インストール済みのエージェント スキル(`SKILL.md` のあるフォルダ)を 1 つ指定すると、
Microsoft 365 Copilot の **Agent Builder**(と Copilot Cowork)に追加できるスキル ZIP と、日本語のレポートを作る。

- Claude Code / GitHub Copilot では「このスキルを Agent Builder 用の ZIP にして」と頼めば、このスキルが使われる
  (エージェントがスクリプトを実行し、レポートとスキルの全文を読んで、要約・懸念・読み替えの案を返す)。
- エージェントを使わない人は、agent-toolkit リポジトリの `m365-org-skills/skill2zip.bat` をダブルクリックする
  (スキルのフォルダを .bat にドラッグしてもよい)。

**機械がやるのは下調べまで。** スキルは AI への指示そのもので、判定が「候補」でも安全の保証にはならない。
使う前に、`SKILL.md` と同梱ファイルを人が全文読む。

## 必要なもの

Node.js 20 以上。GitHub から取るときは git も。Python は要らない。

## 使い方

```bash
node <このフォルダ>/scripts/skill2zip.mjs <スキル> [オプション]
```

`<スキル>` は次のどれか。

| 指定 | 例 |
| --- | --- |
| スキルのフォルダ(直下に `SKILL.md`) | `./my-skill`、`C:\work\my-skill\SKILL.md` |
| GitHub のフォルダの URL | `https://github.com/github/awesome-copilot/tree/main/skills/prd`(`.../blob/<ブランチ>/<パス>/SKILL.md` も可) |
| インストール済みのスキルの名前 | `my-skill`(`~/.claude/skills`、`.claude/skills`、`.github/skills`、`~/.copilot/skills`、`~/.agents/skills`、Claude Code のプラグインを探す。複数見つかったら一覧を出して止まる) |

| オプション | 意味 |
| --- | --- |
| `--out <フォルダ>` | 出力先(既定: 今のフォルダの `m365-zips`) |
| `--origin own\|third-party` | 自作か第三者のものか(既定: GitHub は第三者、それ以外は自作) |
| `--overlay ja\|none` | 日本語の「読み替え」の節を付けるか(既定: 第三者は付ける、自作は付けない) |
| `--overlay-file <ファイル>` | 読み替えの定義(既定: `<出力先>/<名前>.overlay.json`) |
| `--draft` | 読み替えに TODO が残っていても `<名前>.draft.zip` を作る(試し用。Agent Builder には追加しない) |
| `--force` | 機械チェックで止まる理由があっても作る(理由はレポートと `SOURCE.md` に残る) |
| `--allow-license-unknown` | 自作のスキルで LICENSE が無くても続ける(第三者のスキルには使えない) |
| `--name <名前>` | ZIP のスキル名。frontmatter の `name` を置き換える。`name` が規則(英小文字・数字と 1 個ずつのハイフン、64 文字以内)に合わないと止まるので、そのときに使う |
| `--max-depth <n>` | フォルダの深さの上限(既定 2)。Agent Builder の文書の「3」をそのまま使うなら 3 |
| `--checks <ファイル>` | チェックの語句(既定: `scripts/lib/checks.json`。自分用に変えるときは写しを作って渡す) |

終了コードは 0(ZIP を作った)、1(止めた。理由はレポート)、2(指定の誤り・使えない入力)。
レポートを書いたときは、標準出力の最後の行が `REPORT: <レポートのパス>` になる(`skill2zip.bat` はこのファイルを開く)。

## 出力

| ファイル | 中身 |
| --- | --- |
| `<名前>.zip` | Agent Builder の「スキル」→「追加」で入れる ZIP |
| `<名前>.report.md` | 日本語のレポート(結果、止めた理由、自動で直したこと、機械チェックの結果、ZIP に入るファイル) |
| `node_modules/<名前>/` | ZIP と同じ中身。人が全文読むためのコピー(`node_modules` という名前は、テストの自動実行に拾われないため) |
| `<名前>.overlay.json` | 読み替えを付けるときだけ。最初は TODO 入りのひな形ができるので、書き換えてからもう一度実行する |

第三者のスキルの ZIP には、`LICENSE.txt`(元のライセンス)と `SOURCE.md`(出どころ・版・変更点)が入る。

## 何をするか

1. 元のフォルダをコピーする(元のフォルダには何も書かない)。GitHub は浅い・部分的な clone をシンボリック リンクを作らずに
   OS の一時フォルダへ取り、終わったら消す。シンボリック リンクやサブモジュールがあれば止まる。
2. 安全な修正だけを自動で行い、すべてレポートに書く: 拡張子の無い `LICENSE` に `.txt` を付ける、`SKILL.md` から参照されていない
   `README.md`・`metadata.json`・`.github/` などを外す、BOM と CRLF を直す、frontmatter を `name` と `description` だけにする。
3. スキル スカウトと同じ機械チェック(ライセンス・形式・Python/Node の依存・CLI ツール・通信・別ツール向けの記述・人に関わる判断)をかける。
4. 次のものがあると止まる(`--force` で通せるが勧めない): 制限付き・見つからないライセンス、Windows のスクリプト、
   サンドボックスに無い CLI ツール、通信が必須、Claude Code 専用の機能(サブエージェント、`claude -p`、`allowed-tools` など)、上限超え。
   frontmatter の `name` がスキル名の規則に合わないときも止まる(`--force` では通らない。元のスキルを直すか `--name`)。
   出力のファイル名には、規則に合う名前だけを使う。
5. `$ARGUMENTS`・`${CLAUDE_...}`・`${input:...}` のような、Microsoft 365 では置き換わらない変数は止める理由にしないが、
   レポートの先頭(「先に確認すること」)と画面の要約に出す。
6. 読み替えを付けるときは、TODO が残っている間は ZIP を作らない(`--draft` を除く)。
7. m365-skill-pack の検査・ZIP 化と同じコードで ZIP にする(同じ入力なら `pack-skill.mjs` とバイト単位で同じ ZIP)。

スキルの中身は一切実行しない。ZIP をどこかにアップロードすることもしない(Agent Builder への追加は人が手で行う)。
ローカルのフォルダやインストール済みのスキルでは git も起動しない(フォルダの `.git/config` に、git にプログラムを実行させる
設定があってもよいように)。コミットと GitHub のリモートは `.git` の中のファイルを直接読んで調べる。
GitHub の URL は、パスに `\`・`:`・制御文字・`.`/`..` を含むもの、`%` の書き方が不正なものを受け付けない。
`SOURCE.md` には、手元のパスや URL の認証情報を書かない(リモートは `https://github.com/<owner>/<repo>` の形のときだけ書く)。

## コードの置き場所

検査(`scripts/lib/checks.mjs`、`checks.json`)、安全な clone(`git.mjs`)、読み替えの組み立て(`overlay.mjs`、`overlay-ja.json`)は、
このフォルダにある 1 つだけを、スキル スカウト(`m365-org-skills/scout/`)も読み込んで使う。
このフォルダだけをコピーしても動くように、Agent Builder 向けの検査と ZIP 化(`m365-rules.mjs`、`zip.mjs`、`args.mjs`)は
m365-skill-pack と同じファイルを置いている。食い違うとテスト(`tests/m365-skill-convert.test.mjs`)が落ちる。
