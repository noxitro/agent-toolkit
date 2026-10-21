# copilot-usage-export

GitHub Copilot(Copilot CLI と、同じ記録を使うデスクトップ版)が PC に残している記録から、
**セッション × 役ごとの消費**と、**セッションごとの経過の記録**(依頼・応答・ツール呼び出し・サブエージェントの委譲と報告)を書き出す。
モデルは呼ばないので、トークンもクレジットも使わない。

このフォルダだけで完結している。どのリポジトリやフォルダに置いても動く。

## 目的

- どの作業に、どのモデルで、どれだけのクレジットとトークンを使ったかを、記録から確かめる。
- 本体とサブエージェント(役ごと)の消費を分けて見る。
- 何を頼み、エージェントが何をして、どこで失敗したかを後から追う。

## 起動

| 操作 | 方法 |
| --- | --- |
| 直近 7 日に動いたセッションを書き出す | `copilot-usage-export.bat` をダブルクリック |
| 日付を指定する(UTC) | `copilot-usage-export.bat -Since 2026-10-19` |
| 特定のセッションだけ | `copilot-usage-export.bat -SessionId <ID の先頭数文字>` |
| ツールの結果も記録に入れる | `copilot-usage-export.bat -ToolOutput all`(既定は `fail` = 失敗したときだけ。`none` で入れない) |
| 記録を Copilot CLI の `/share file` と同じ形式で出す | `copilot-usage-export-cli.bat` をダブルクリック(= `copilot-usage-export.bat -Format cli`。両方出すなら `-Format both`) |
| 生の記録(events.jsonl)も複製する | `copilot-usage-export.bat -Raw`(`output\raw\` へ) |
| 出力先を変える | `copilot-usage-export.bat -OutDir <出力先のフォルダ>` |
| 毎日自動で動かす | `copilot-usage-export-schedule.bat` をダブルクリックし、1 を選ぶ(時刻を聞かれるので HH:mm で答える。毎日その時刻に実行し、PC が止まっていたら次に起動したとき。いまのユーザーで登録し、管理者権限は要らない) |

必要なもの: Windows 10 / 11 の標準の PowerShell 5.1 だけ(Node.js や Python は不要。SQLite は Windows 同梱の `winsqlite3.dll` を使う)。

## 出すもの

既定の出力先はこのフォルダの `output\`(同じフォルダの `.gitignore` で git から除外している)。

| ファイル | 中身 |
| --- | --- |
| `output\usage-<日付>.csv` | 日ごとの CSV(セッションの開始日で分ける)。再実行すると同じセッションの行を差し替えるので、何度動かしても重複しない |
| `output\sessions\<日付>\<時刻>_<ID 8 桁>.md` | セッションごとの記録(`-Format record`(既定)と `both` のとき) |
| `output\cli\<日付>\copilot-session-<ID>.md` | セッションごとの記録を Copilot CLI の書き出しと同じ形式で(`-Format cli` と `both` のとき) |
| `output\copilot-usage-export.log` | 自動実行のときの結果 |

### セッションごとの記録

- **概要**: リポジトリとブランチ、作業フォルダ、開始時刻、Copilot の版、最初のモデルと推論強度、使ったスキル、
  クレジット(呼び出しの合計と終了時の確定値)、終わり方、コンテキストの最大使用率
- **役ごとの消費**: 役(main と、委譲先のエージェント名)ごとのモデル・呼び出し回数・クレジット・トークン・ツール回数・失敗数
- **経過**: 依頼文と応答(全文)、ツール呼び出し 1 回 1 行(名前・引数の要約・成否・所要時間・エラー)、
  サブエージェントの開始と完了、委譲の指示と報告(全文)、モデルの変更、承認の要求、エラー・中断・会話の要約
- **終了時の記録**: 終わり方、API 時間、変更した行数とファイル

入れないもの: システムプロンプト、スキルの本文、モデル内部の推論、成功したツールの結果(`-ToolOutput all` で入る)。

### Copilot CLI の形式(`-Format cli`)

Copilot CLI の `/share file`(別名 `/export file`)が出す Markdown と同じ組み立てで、
記録(events.jsonl)から書き出す。CLI でその場で書き出し忘れたセッションも、後から同じ形で残せる。
CSV はどの形式でも出す。

- 冒頭に `# Copilot CLI Session` と、セッション ID・開始・所要時間・書き出した時刻の注記
- 項目ごとに `---` で区切り、開始からの経過(`<sub>1m 5s</sub>`)のあとに `### User` / `### Copilot` / ``### `ツール名` ``
- ツールは意図の要約(太字)、引数(grep・glob・view・edit・create は 1 行、他は `Arguments` を折りたたんだ JSON)、
  結果(5 行を超えると折りたたむ)。失敗は見出しに `— Failed`
- サブエージェントの動きは、委譲したツールの見出し(`### task (Completed)`)の下にまとめる
- エラー・情報・警告・会話の要約・完了の報告・通知も CLI と同じ見出しで出す
- `-ToolOutput` は効かない(CLI と同じく、ツールの結果は常に入る)

CLI の書き出しと違うところ:

- モデル内部の推論(`### Reasoning`)は入れない
- 所要時間は最後の出来事まで(CLI は書き出した時点まで)。書き出した時刻は、このツールを動かした時刻
- 末尾の 1 行は、このツールが書き出したことと秘密情報の疑いの件数
- 実行中だけ見えるもの(シェルの途中出力・フックの進捗・画像)は記録に残らないので出ない
- コードの外の `<` を `\<` にする規則は、CLI の Markdown 解析を簡略化したもの(コードブロックとインラインコードは残す)
- events.jsonl が無いセッションは出さない

形式は Copilot CLI 1.0.100 に同梱のソース(書き出しとタイムラインの組み立て)で確かめた。CLI の版上げで形が変わることがある。

### 秘密情報の警告

記録は書き換えない。ただ、エージェントが設定ファイルを読んだ結果などで API キーやトークンが入ることがあるので、
それらしい文字列を数えて**警告だけ出す**(画面かログに該当ファイルと種類、各記録の末尾に件数。CLI の形式でも同じ)。警告が出たら中身を確認し、
本物なら記録から消して鍵を作り直す。

## CSV の列

| 列 | 意味 |
| --- | --- |
| `source` | `desktop`(デスクトップ版のセッション)/ `cli`(Copilot CLI) |
| `repo` `branch` | リポジトリとブランチ |
| `session_id` `title` | セッション ID と名前(デスクトップ版は題名、CLI は要約か最初の依頼文) |
| `agent` `role` | `(main)` = セッション本体、UUID = 委譲されたサブエージェント。`role` はその役の名前 |
| `calls` `credits` | モデル呼び出し回数と AI クレジット |
| `session_credits_final` | セッション終了時の確定値(main の行だけ。**合計に足さない**。`credits` の合計との突き合わせ用) |
| `input_tokens` `cache_read_tokens` `cache_write_tokens` `output_tokens` `reasoning_tokens` `cache_hit_pct` | トークンの内訳と、`cache_read / input` の百分率 |
| `model_seconds` `models` `reasoning_effort` | モデルの応答時間の合計(秒)、使われたモデル、推論強度 |
| `user_requests` `tool_calls` `tool_failures` | 依頼の回数(main の行だけ)、ツール呼び出しの回数、失敗の回数 |
| `context_peak_pct` | コンテキスト使用率の最大(デスクトップ版のセッションだけ) |
| `ended` | `shutdown` = 正常に終了、`no-shutdown` = 実行中か、ウィンドウを閉じて終わった(確定値なし)、`no-events` = 経過の記録が無い |
| `first_call_local` `first_call_utc` `last_call_utc` `cwd` | 時刻と作業フォルダ |

## 読んでいる場所(文書化されていない内部構造)

| ファイル | 使うもの |
| --- | --- |
| `%USERPROFILE%\.copilot\session-store.db` | `assistant_usage_events`(1 行 = 1 モデル呼び出し)、`sessions`(作業フォルダ・リポジトリ・ブランチ・要約) |
| `%USERPROFILE%\.copilot\data.db` | `sessions`(デスクトップ版のセッション名)、`session_context_usage`(コンテキスト使用率)。認証情報の表は読まない |
| `%USERPROFILE%\.copilot\session-state\<ID>\events.jsonl` | セッションの全イベント |

DB は使用中なので一時フォルダにコピーしてから読み、読み終えたら消す。元のファイルには書き込まない。
クレジットは `total_nano_aiu / 1e9`。同じ行の単価が公式の単価表と一致することを根拠にしている。
課金画面の値と一度は突き合わせること。

## 止まるとき・注意

- Copilot の版上げで表や列が変わると、黙って 0 を出す代わりに、無い列の名前と今ある列を表示して終了コード 1 で止まる。
  `copilot-usage-export.ps1` の `$need` と SQL を新しい列名に合わせる。
- events.jsonl のイベントの形が変わった場合は止まらず、読めなかった行の数を記録の末尾に出す。
- ウィンドウやタブを閉じて終わったセッションは、終了時の確定値が残らない(`ended = no-shutdown`)。消費は呼び出しごとの記録から集計できる。
- 記録には依頼文と応答が全文で入る。人に渡すときは中身を確認する。

確認済みの環境: Windows 11、Copilot CLI 1.0.100(2026-10)。
