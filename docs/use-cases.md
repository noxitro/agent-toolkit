# agent-toolkit を活用してできること

agent-toolkit は、スキル・エージェント・コマンドを 1 回書いて、Claude Code・OpenCode・GitHub Copilot へ配るためのリポジトリ。
この文書は、チームで生成 AI の活用を進めるときに、agent-toolkit とその周りの道具で何ができるかを、
**溜める → 測る → 整える → 比べる**の順にまとめたもの。どれも「入れれば効く」とは限らないので、
導入して使われ方を測り、あり・なしで比べて、効いたものだけを標準にする前提で書いている。

確度の表記: **公式**(一次文書)/ **実測** / **既報**(第三者)/ **推測**。日付は確かめた日。

## agent-toolkit に入っているもの

| 部品 | できること |
| --- | --- |
| `shared/` とビルド | 1 回書いたスキル・コマンド・エージェントを、3 つのハーネスの形に生成して配る([README](../README.md)) |
| `agent-asset-authoring`(スキル) | 複数のハーネスで動く資産を書くときの決まりと、片方でだけ黙って動かなくなる罠 |
| `new-agent-asset`(コマンド) | 新しい資産の雛形を作り、生成物を作り直す |
| `asset-reviewer`(エージェント) | 公開前の資産を読み取り専用で審査する |
| [`tools/copilot-session-export`](../tools/copilot-session-export/README.md) | Copilot のセッションを、アプリからでも `/export` と同じ Markdown で書き出す。返答ごとのトークンと AI クレジットも付けられる |
| [`tools/copilot-usage-export`](../tools/copilot-usage-export/README.md) | PC に残る記録から、セッション × 役ごとの消費と経過を書き出す。毎日の自動実行もできる |

どちらのツールもモデルを呼ばないので、書き出しにトークンもクレジットも使わない。

## 答えたい問いと、方針の骨格

| 問い | 測るもの |
| --- | --- |
| AI 中心で開発が回るか | 受け入れ条件の到達点、人が直接書いた量 |
| 少ない予算で回るか | 作業ごとの AI 使用量とトークン |
| モデルをどう使い分けるか | 安いモデル + 仕組み 対 上位モデル単独 |
| 誰が回しても同じになるか | 知識・手順・ゲートを固定し、別の人が再現する |

原則: **純正の機能を先に試し、足りないと測れた所にだけ自作を足す。1 回の比較で変える要素は 1 つ。**
自作を足すときは `shared/` に書けば、使うハーネスが混ざったチームでも同じ資産を配れる。

| 層 | 第一候補 | 対抗 | 決め手 |
| --- | --- | --- | --- |
| 知識の置き場 | LLM Wiki | 指示ファイルに書き足すだけ / Copilot Memory / RAG | 同じ罠の再発が減るか。文脈の消費 |
| コード理解 | 純正の LSP と言語サービス | Serena | 純正で足りない作業があるか |
| 段取り | 純正(`/plan` → autopilot、auto、HydraFusion) | ユーザーハーネス、dynamic workflows | 「完了」の質、費用、人の時間 |
| 合否の判定 | hooks と CI による機械の検査 | モデルの審査(Rubber Duck・`/review`・自作の審査役) | 誤 PASS の数 |
| 計測 | 記録の書き出しと集計(LLM を使わない) | CLI の OpenTelemetry 出力 | 使う面の記録が取れるか |

使える機能は面(Visual Studio・VS Code・Copilot CLI・GitHub Copilot app)ごとに違う。Visual Studio で使えないものは都度書く。

## 1. 溜める: LLM Wiki

踏んだ罠・判断の根拠・モデルの癖を、セッションと人をまたいで再利用する。RAG のように毎回ゼロから探すのではなく、
LLM が整理して書き溜め、相互リンクと食い違いの印まで維持する(Karpathy の LLM Wiki パターン)。

agent-toolkit でできること: wiki を調べる・入れるスキル(例: `wiki-query`・`wiki-ingest`)を `shared/skills/` に書けば、
3 つのハーネスで同じ手順になる。新しい資産は `new-agent-asset` で作り、`asset-reviewer` で審査してから出す。

設計案:

- リポジトリは 1 つ。チームや領域ごとにドメインで分ける。入るのはレビューを通ったものだけ。
- 入れるのは人が承認してから。確度は ◎(実測・一次資料)と ○(間接の裏付け)の 2 段にし、推測は書かない。
- 置き場の分担: 罠と根拠は wiki、手順はスキル、常に守る規則は指示ファイル、忘れたら壊れる検査はスクリプトと CI。
- 定期の見直しで、よく引かれる知見をスキルや指示へ格上げする。

論点:

- **比べる相手は「なし」だけでなく「指示ファイルに書き足すだけ」。** 指示ファイルは毎回読まれ、仕組みも最も簡単。これに勝てないなら wiki は要らない。
- Copilot Memory は、GitHub 上のリポジトリが前提で、Business では既定でオフ(公式)。GitHub 以外のリポジトリでは代わりにならない。
  VS Code には端末内に保存する別の memory ツールがあり、GitHub 以外のリポジトリでも使える(公式)。比べる候補にはなる。
- 誤りも積み上がる。出典・確度・レビュー・機械の点検(push 前と CI)で抑える。
- 効果は知識が溜まる前には出にくい。測るのは、知見が溜まった最初のフェーズの終わりにする。

## 2. 測る: 記録の書き出しと集計

毎回記録するもの: 到達点、AI 使用量とトークン、人の介入の回数と時間、手戻り、
**誤 PASS**(機械の検査で落ちるのに「完了」と報告した回数)、スキルと wiki の呼び出し回数。
「読まれた」と「役に立った」は別で、役に立ったかは比べて確かめる(4 節)。

agent-toolkit でできること:

- **書き出す**: `copilot-session-export` で作業の終わりにセッションを残し、`copilot-usage-export` で役ごとの消費を毎日書き出す。
  記録は後から取り直せないので、初日から残す。
- **集計する**: 別のリポジトリの [agent-session-atlas](https://github.com/noxitro/agent-session-atlas)(試作)が、
  `~/.copilot` の記録から、トークン・AIU・skill / agent / hook・指示ファイルの注入・wiki の参照・摩擦・変更行数を LLM なしで集計する。
  - 元のファイルは書き換えず、複製してから読む。HTML 1 ファイルで外部への通信なし、共有用の伏せ字版(`--anonymize`)あり。
  - プロジェクト・ブランチ・期間で絞れる。条件ごとに作業フォルダを分ければ、そのまま比べられる。記録の欠けは 0 にせず件数で出す。

使う前に直す・確かめること(agent-session-atlas):

- **wiki の参照は、パスに `global-llm-wiki` を含むものだけを数える**(skill 名 wiki-ingest・query・lint の呼び出しは数える)。
  チームの wiki の場所を設定で渡せるようにする。wiki の効果を測る前に必ず直す。
- 読むのは `~/.copilot`(CLI・アプリ・SDK・VS Code の Agent Host)。**Visual Studio のセッションが取れるかは未確認。**
- 費用は AIU で出す。AI クレジットへの換算は未確認なので、比べるときは AIU とトークンで比べる。
- 集計は 1 台ずつ。複数人の記録をまとめる機能は無い。
- 推定人手工数と wiki の効果点は LLM の推定。効果はあり・なしの比較で見る。判定に渡すファイルには依頼文などの本文が入る。
- Node.js 24 と npm の依存が要る。

注意: IDE でのエージェント利用が、使用量メトリクスから欠落する不具合がある。回復には VS Code 1.139.0 以降、Visual Studio 18.12 以降が要る
(課金には影響なし、欠落分は戻らない。公式 2026-10-06)。記録に使う IDE の版をそろえる。

## 3. 整える: ハーネスと道具

### ユーザーハーネス

agent-toolkit でできること: 実装役と審査役のエージェントを `shared/agents/` に書けば、3 つのハーネスへ同じ定義で配れる。

- 実装役と審査役を分ける。審査役は読み取り専用で、実装役と別のモデルにする。
- フェーズの定義とゲート表を先に書く。合否はできるだけ機械で決める。
- 起動は人が明示する。誤作動を避けるため、指示ファイルには規則だけを置き、ハーネスを起動させない。
- 指示文に「確認すること」と書くだけでは、安いモデルは省く。守らせたいことは機械の検査に置く。
- autopilot は同じモデルの自己検証だけで、独立した審査は自動では入らない。組み込みの `rubber-duck`・`code-review` を呼ぶかはモデルが決める(実測)。
- 実測例(Copilot CLI 1.0.100、全役 GPT-6 Luna、1 回): 手動で 2 セッションに分けると 0.96 クレジット、オーケストレータからサブエージェントに委ねると 2.01 クレジット。
  差の主因は本体の文脈のキャッシュ書き込みと失効で、サブエージェント自体は単独より安かった。

### HydraFusion との比べ方

HydraFusion(research preview)は、1 ターンの中で複数のモデルを組み合わせる Copilot の純正の段取り(公式、2026-09-30・10-14)。

- **Single**: 1 つのモデルが直接解く。
- **Cascade**: 効率の良いモデルが下書きし、品質の関門が受け入れるか、上位モデルへ上げる。
- **Critique**: 下書きを別系統のモデルが読み取り専用で批評し(Rubber Duck と同じ型)、1 回だけ直す。
- **Max**: 同じ仕組みで推論を深くした版(2026-10-14)。
- 候補のモデルは Claude Opus 5.5・GPT-6 Astra・GPT-6.1 Sol・GPT-6 Luna。面は VS Code 1.140 以降・GitHub Copilot app・CLI で、**Visual Studio の記載は無い。**
  Business では管理者がプレビュー機能を許可する必要がある。

Cascade と Critique は、ユーザーハーネスの「安いモデル + 関門」「別系統の審査」を純正で 1 ターンに畳んだもの。役割が重なるので、先に選ばず比べる。

| | HydraFusion | ユーザーハーネス |
| --- | --- | --- |
| 段取りの単位 | 1 ターン | フェーズ(数セッション) |
| 合否の決め方 | モデルの判定(関門・批評) | 機械の検査(ビルド・テスト・hooks・CI)と、別モデルの審査 |
| モデルの選択 | HydraFusion が決める | 人が役ごとに決める |
| 費用と内訳 | 公式の記載なし。既報(第三者)では、呼んだモデルの分がすべて課金される | 審査役の分だけ増える。役ごとにセッションが分かれるので数えられる |
| 準備 | 作る手間なし。プレビュー機能の許可が要る | エージェントの定義とゲート表を作り、`shared/` から配る |

比べるときはモデルをそろえられない(HydraFusion が選ぶ)。差はモデル込みの段取りの差として読む。

### コード理解: LSP か Serena か

| 道具 | 面 | 参照・呼び出し階層 | 名前の変更 | 前提 | 状態 |
| --- | --- | --- | --- | --- | --- |
| `find_symbol` | Visual Studio | ○ | × | 言語サービスのある言語のプロジェクト | GA(18.4) |
| 言語ベンダーのプラグインが積む言語サーバ | CLI | ○ | 言語サーバ次第 | マーケットプレイスから入れる | 言語による |
| LSP の直接設定 | CLI・アプリ | ○ | ○(言語サーバが対応すれば) | `.github/lsp.json` か `~/.copilot/lsp-config.json` | GA |
| Serena | MCP(面を問わない) | ○ | ○ | 言語ごとの言語サーバ、Python 3.11 以上 3.15 未満 | 2.1.0(2026-10-19) |

- 判断: **純正から始め、Serena は「純正で足りない作業がある」と測ってから入れる**(推測に基づく方針)。
  Serena に固有なのは、関数本体の差し替えなどの編集の道具と、面をまたいで同じ使い方ができること。
- 言語ごとに、ベンダーの公式プラグインがあるかをまず確かめる。GitHub の公式プラグイン集に無くても、言語のチームが自分のマーケットプレイスで出していることがある。
- Serena の注意:
  - 2.0.0(2026-10-13)から本体のライセンスが GPL-3.0-or-later に変わった(SolidLSP は MIT、1.7.0 以前は MIT のまま。公式)。
  - 言語によっては、起動直後の索引中に参照検索が空を返し、未完了を知らせないという未解決の報告がある(既報)。
  - Serena 自身の定量データは無い。出回る「トークン 50% 減」は、第三者による古い版での推計(既報)。
  - 1〜3 行の修正は関数本体ごと送り直すので不利(公式)。
- 言語サーバは、プロジェクトの構成(ビルド定義やコンパイルの設定)を読めないと正しく動かない。1 ファイルで試してから広げる。
- 「参照 0 件 = 使われていない」と信じない。動的な呼び出し、リフレクション、文字列から名前を引く仕組み、別の構成でしか使わないコードは拾えないことがある。

### そのほかの候補

| 手法 | 何に効くか | 状態・前提 |
| --- | --- | --- |
| hooks と CI でゲートを機械にする | 「完了」の自己申告に頼らない。触ってはいけない所を止める | hooks は CLI で GA、VS Code は preview、**Visual Studio は非対応**(公式) |
| 安いモデルで複数回試し、物差しで選ぶ | 難所を上位モデルより安く越える | 物差しが要る |
| `/review`・Rubber Duck | 自作の審査役の代わりになるか | 純正。呼ぶかはモデルが決める |
| auto(efficiency / balance / intelligence)と `autoTier` | 使い分けの手間を減らす。費用を統制する(auto は 10% 割引) | CLI・VS Code・アプリ。**Visual Studio 2026 では使えない**(公式) |
| dynamic workflows | 段取りをコードで固定する | public preview(2026-10-01)。CLI は `--experimental` |
| Agent Plugins 1.0 | スキル・MCP・エージェントをまとめて配る | GA(VS Code・CLI・SDK・アプリ) |
| ローカルサンドボックス | エージェントが触れる範囲を絞る | GA(2026-10-07)。外への通信は既定で許可。Windows 11 25H2 以降 |

効く見込みが最も大きいのはゲートの機械化(推測)。

## 4. 比べる

約束(破ると結論が読めなくなる):

1. 変える要素は 1 つだけにする。
2. 同じ出発点から、別々の作業フォルダで回す。
3. 物差しは回す前に固定する。
4. 「なし」側の漏れを塞ぐ(指示ファイルの規則・スキル・記憶機能から知識が入る)。agent-toolkit で配った資産も、「なし」側では外す。
5. 課題は未着手のものにし、wiki と関係の薄い課題を 1 本対照に混ぜる。

| 比べること | 変えるもの | そろえるもの | 時期 |
| --- | --- | --- | --- |
| wiki の効果 | wiki あり / なし | モデル・ハーネス・課題 | 知見が溜まった最初のフェーズの終わり |
| 知識の置き方 | wiki / 指示ファイルに書き足すだけ | モデル・課題 | 上に相乗り(予算次第) |
| ハーネスの効果 | 純正のみ / ユーザーハーネス | wiki・モデル・課題 | 本番のフェーズの中盤 |
| 純正の段取りで足りるか | HydraFusion / ユーザーハーネス | wiki・課題(モデルはそろえられない) | 上に相乗り(プレビューの許可が出たら) |
| コード理解の道具 | 純正の LSP / Serena | ほか全部 | 純正で足りない作業が見つかったら |

回数は予算の範囲で少なくなるので、結論は「傾向」として出す。

## 進め方と予算

| フェーズ | やること | 測ること |
| --- | --- | --- |
| 準備 | wiki のスキルと計測の道具を入れる。記録の決まり、課題と物差しの候補を決める。言語サーバを 1 ファイルで試す。プレビュー機能と Serena の可否を確かめる | 1 回の比較にかかる量を小さく測る |
| 探索 | 探索しながら知見を溜める。ハーネスを試作する | 終わりに wiki の棚卸しと wiki の効果測定 |
| 本番 | ハーネスを先に立てて本番を進める | 中盤にハーネスの効果測定(HydraFusion との比較もここ)、工数 |
| まとめ | 結果の整理と評価 | 新しい測定はしない |

- 「ノウハウが溜まったら」ではなく、時期で区切って測る。ハーネスの測定をまとめのフェーズまで延ばすと、結果を受けて直す時間が残らない。
- 効果測定の枠を本番と分けるかを先に決める。分けない場合も、効果測定の消費は分けて記録する。
- 同じ実装を条件の数だけ回すので、費用は条件の数に比例して増える。1 回の比較の量を測ってから回数を決める。
- 安いモデルを既定にし、上位モデルは計画と審査の要所だけに使う。HydraFusion は費用の公式の説明が無いので、小さく実測するまで見積もらない。

## チームで始める前に決めておくこと

1. プレビュー機能(HydraFusion、dynamic workflows、preview の言語サーバ)を試すか。
2. 比べる課題と物差しを誰が作るか。
3. 記録の残し方: 作業の終わりに書き出すか、毎日自動で書き出すか。集計の結果を共有するときは伏せ字版にするか。
4. wiki の定期の見直しの担当。
5. Serena は、純正で足りない作業が見つかってから入れる。そのときに版を固定するかを決める。

## 出典(公式は 2026-10-23〜28 に確認)

- HydraFusion: [VS Code とアプリへの提供](https://github.blog/changelog/2026-09-30-hydrafusion-in-vs-code-and-the-github-copilot-app)、[更新と Max](https://github.blog/changelog/2026-10-14-hydrafusion-updates-and-new-max-option)、[課金(既報・第三者)](https://www.beri.net/article/github-hydrafusion-router-per-phase-token-billing-task-mix-cost)
- LSP: [LSP サーバ](https://docs.github.com/en/copilot/concepts/customizations/lsp-servers)、[LSP サーバの追加](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/add-lsp-servers)、[GitHub の公式プラグイン集](https://github.com/github/copilot-plugins)
- [Visual Studio のエージェントモード(`find_symbol`)](https://learn.microsoft.com/visualstudio/ide/copilot-agent-mode)
- Serena: [リポジトリ](https://github.com/oraios/serena)、[CHANGELOG](https://github.com/oraios/serena/blob/main/CHANGELOG.md)、[PyPI](https://pypi.org/project/serena-agent/)
- [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- [hooks](https://docs.github.com/en/copilot/concepts/agents/hooks)、[面ごとの対応表](https://docs.github.com/en/copilot/reference/customization-cheat-sheet)
- [auto のモデル選択](https://docs.github.com/en/copilot/concepts/auto-model-selection)
- [dynamic workflows](https://github.blog/changelog/2026-10-01-dynamic-workflows-in-copilot-cli-and-the-copilot-app)
- [Agent Plugins 1.0](https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app)
- [ローカルサンドボックス](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/using-local-sandboxing)
- [使用量メトリクスの欠落](https://github.blog/changelog/2026-10-06-update-your-ide-to-restore-agent-activity-in-copilot-usage-metrics)
- [組織の課金](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises)
- [agent-session-atlas](https://github.com/noxitro/agent-session-atlas)
