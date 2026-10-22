# copilot-session-export

GitHub Copilot のデスクトップ アプリでも、Copilot CLI の `/export`(= `/share file`)と同じ Markdown をその場で書き出せるようにする拡張。
モデルは呼ばないので、トークンも AI クレジットも使わない。

| コマンド | 書き出すもの |
| --- | --- |
| `/export [file] [パス]` | Copilot CLI の `/export file` と同じ Markdown(CLI 本物の出力と突き合わせて確かめた) |
| `/save-session [パス]` | 使用量(役 × モデルごとの AI クレジットとトークン)付きの、読みやすい記録 |

## 目的

- 作業の途中や終わりに、アプリを離れずにセッションの記録を残す。
- 書き出しにモデルを使わない。スキルやプロンプトで「記録を書いて」と頼む方法は、そのたびにトークンを使う。

Copilot CLI(ターミナル)には組み込みの `/export` がある。しかし、SDK 経由でランタイムを動かす形(デスクトップ アプリと同じ形)には `/export` が無く、
`/share` も `link` と `off` しか受け付けない(下の「確かめたこと」)。この拡張はそこを埋める。

## 起動

| 操作 | 方法 |
| --- | --- |
| 入れる | `install.bat` をダブルクリックし、1 を選ぶ(`install.bat install` でも同じ) |
| 状態を見る | `install.bat` で 2 を選ぶ |
| 外す | `install.bat` で 3 を選ぶ |
| 書き出す | Copilot のセッションの入力欄で `/export` または `/save-session` と打つ |

入れたあと、デスクトップ アプリはアプリを再起動してから使える(開いていたセッションは、入力欄の `/restart-session` で読み直せる)。

**新しいセッションの最初のメッセージには使えない。** 拡張はセッションができてから読み込まれるので、新しいセッションの入力欄に最初に打った
`/export` は、ただの依頼としてモデルに送られる(トークンを使う)。1 往復以上したセッションで、入力欄に `/` を打って一覧から選ぶ。
一覧に `/export`(説明が「Copilot CLI の /export file と同じ…」のもの)が出ないときは送らない。
必要なもの: Windows 10 / 11 の標準の PowerShell 5.1(インストーラー)。拡張そのものは Copilot が起動する Node.js のプロセスで動き、
外部のパッケージは使わない(Node.js の標準モジュールと、Copilot が渡す SDK だけ)。

### インストーラーがすること

1. `session-export\` の 3 ファイルを `%USERPROFILE%\.copilot\extensions\session-export\` に写す(環境変数 `COPILOT_HOME` があればその下)。
2. `%USERPROFILE%\.copilot\settings.json` の `feature_flags.enabled` に `EXTENSIONS` を足す(書き換える前の内容は `settings.json.bak`)。
   Copilot の拡張は実験的機能で、この機能フラグが有効なときだけ読み込まれる。`/experimental on`(または `--experimental` を付けた起動)でも有効になるが、
   そちらはほかの実験的機能もまとめて有効にして `settings.json` に `"experimental": true` を残すので、インストーラーは使わない。
   すでに有効なら何もしない。

外すときは、フォルダを消し、足した `EXTENSIONS` だけを外す。ほかの拡張のために機能フラグを残したいときは `settings.json.bak` から戻す。

## 使い方

### /export

| 打つもの | 書き出す先 |
| --- | --- |
| `/export` または `/export file` | 作業フォルダの `copilot-session-<セッション ID>.md`(CLI と同じ) |
| `/export file <フォルダ>` | そのフォルダの中に同じ名前で |
| `/export file <パス>.md` | そのファイル(上書き) |

`file` は省略できる(`/export <パス>` でもよい)。CLI の `/export` のうち `html` `gist` `link` `research` には対応していない(打つと警告だけ出す)。
相対パスはセッションの作業フォルダから解決する。デスクトップ アプリでは、書き出したあと「Session exported to: <パス> フォルダを開きますか?」の
確認ダイアログが出て、Accept でエクスプローラーがそのファイルを選んだ状態で開く(Decline / Cancel なら何もしない)。
CLI では同じ内容が 1 行で出る。どちらも記録に残らないので、次の書き出しには載らない。

Copilot CLI(ターミナル)では、組み込みの `/export` が優先され、この拡張の `/export` は一覧に出ない(CLI は組み込みと同じ名前の拡張コマンドを外す)。

CLI の `/export` と違うところ(どちらも記録に残らないもの):

- CLI の画面にだけ出た表示(「Tip: /share」のようなヒント、シェルの途中出力、フックの進捗)は入らない。
- 所要時間と書き出した時刻は、この拡張で書き出した時点のもの。

### /save-session

| 打つもの | 書き出す先 |
| --- | --- |
| `/save-session` | `%USERPROFILE%\copilot-sessions\<日付>\<時刻>_<ID 8 桁>.md` |
| `/save-session <フォルダ>` | そのフォルダの中に同じ名前で |
| `/save-session <パス>.md` | そのファイル(上書き) |

出すもの:

- **概要**: セッション ID、作業フォルダ、開始時刻、書き出した時刻、Copilot の版
- **使用量**(書き出した時点): AI クレジット、依頼の回数、プレミアムリクエスト換算、モデルの応答時間の合計、変更したファイル数と行数、
  役(main と委譲先のエージェント)× モデルごとの呼び出し回数・クレジット・トークンの内訳
- **経過**: 依頼文と応答(全文)、ツール呼び出し 1 回 1 行(名前・引数の要約・成否・所要時間・失敗の理由)、
  サブエージェントの開始と完了とその中のツール(`[名前]` 付き)、委譲先の報告(全文、折りたたみ)、モデルの変更、スキル、エラー、中断、会話の要約

入れないもの: モデル内部の推論、成功したツールの結果(委譲先の報告を除く)、システムプロンプト、
指示ファイルの自動差し込みなど人が打っていないメッセージ、画面の見出し用の `report_intent`。

どちらの書き出しにも依頼文と応答が全文で入る。エージェントが設定ファイルを読んだ結果などで秘密情報が混ざることがあるので、人に渡すときは中身を確認する。

## 確かめたこと

Copilot CLI 1.0.99-2(デスクトップ アプリが使っているランタイム)を SDK から画面なしで動かし、デスクトップ アプリと同じ起動方法
(アプリ同梱の `extension_bootstrap.mjs`)で拡張を起動して、スラッシュコマンドを `session.commands.invoke` で実行した。

| 確かめたこと | 結果 |
| --- | --- |
| `/export` と `/save-session` の実行でモデルが呼ばれるか | 呼ばれない(`assistant.usage` イベント 0 件、使用量の記録 `session-store.db` の行数も実行の前後で同じ) |
| 拡張の `/export` の出力と、CLI 本物の `/export file` の出力 | 4 セッション(最大約 5 万 4 千行。サブエージェント・失敗・推論・中断・通知・会話の要約を含む)で、上の「違うところ」以外が一致 |
| 拡張が画面に出す 1 行が記録に残るか | 残らない(events.jsonl の行数が前後で同じ) |
| 組み込みの `/export`・`/share file <パス>`(SDK 経由) | `/export` は `Unknown slash command`、`/share file` は `Invalid usage. Use: /share [link\|off]` |
| 機能フラグなし | 拡張が読み込まれない(`Unknown slash command`) |
| `settings.json` の `feature_flags.enabled: ["EXTENSIONS"]` だけ | 読み込まれる(空の `settings.json` の対照では読み込まれない) |
| 環境変数 `COPILOT_CLI_ENABLED_FEATURE_FLAGS=EXTENSIONS` だけ | 読み込まれる。設定ファイルは書き換わらない |
| `--experimental` を付けて起動 | 読み込まれるが、`settings.json` に `"experimental": true` が保存される |
| 手元の 158 セッションの記録(events.jsonl)を両形式で描画 | 失敗 0 |

デスクトップ アプリ(GitHub Copilot app、ランタイム 1.0.99-2)の画面でも試した。

| 確かめたこと | 結果 |
| --- | --- |
| 1 往復したセッションの入力欄に `/ex` と打つ | アプリ独自の `/export-gist` などと並んで、拡張の `/export` と `/save-session` が説明付きで出る |
| 一覧から `/export` を選んで実行 | 作業フォルダに `copilot-session-<ID>.md` ができ、確認ダイアログが出る。Accept でエクスプローラーが開く |
| そのときのモデル呼び出しと記録 | 使用量の記録の行数は前後で同じ。セッションの記録にも依頼・応答・ダイアログは増えない |
| 新しいセッションの最初のメッセージとして `/export` を打つ | 依頼としてモデルに送られた(上の「新しいセッションの最初のメッセージには使えない」) |
| アプリはセッションのログ(`session.info`)を画面に出すか | 出さない。そのため書き出した先は確認ダイアログで知らせる |

CLI 本物の出力は、`copilot --resume <ID> -i "/export file <パス>"` で作った(最初の入力がスラッシュコマンドとして実行され、モデルは呼ばれない)。

単体テスト(合成したイベント列。規則を 1 つ壊すと該当のテストが落ちることも確認済み):

```bash
node --test tools/copilot-session-export/test/render-cli.test.mjs tools/copilot-session-export/test/render.test.mjs
```

未確認: VS Code・Visual Studio の Copilot から使えるか。アプリでの `/save-session` の実行(`/export` と同じ仕組みで、画面なしの検証では動いている)。

## 仕組みと注意

- Copilot CLI の拡張(公式文書: [About CLI extensions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions)、
  [Create an extension](https://docs.github.com/en/copilot/tutorials/create-an-extension))。拡張はセッションと別の Node.js のプロセスで動き、
  `joinSession({ commands })` で登録したスラッシュコマンドは、人が打ったときにそのプロセスの関数が呼ばれるだけで、モデルには渡らない。
- 記録は `session.getEvents()`、使用量は `session.rpc.usage.getMetrics()`(どちらも SDK の API。後者は実験的)から読む。
- `/export` の書式は、CLI がイベントから画面のタイムラインを組み、それを Markdown にする 2 段をなぞったもの(`session-export\render-cli.mjs`)。
  CLI の版上げで書式が変わることがあるので、そのときは上の方法で CLI 本物の出力を作って突き合わせる。
- 拡張は実験的機能で、版上げで API や有効化の方法が変わることがある。機能フラグの名前と `settings.json` の読み方、
  組み込みと同じ名前の拡張コマンドの扱いは、Copilot CLI 1.0.100 に同梱のソースで確かめたもので、公式文書には書かれていない。
- 拡張はあなたの権限で動く。ここにあるのは `session-export\` の 3 ファイルだけで、ネットワークには出ない。

確認済みの環境: Windows 11、Copilot CLI 1.0.99-2 / 1.0.100、Node.js 24(2026-10)。
