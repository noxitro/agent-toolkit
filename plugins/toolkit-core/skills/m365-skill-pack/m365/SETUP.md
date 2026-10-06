# 初回セットアップ(Microsoft 365 Copilot 側で 1 回だけ行う)

Microsoft 365 Copilot にカスタムエージェント 2 つ(`impl-loop` と `auditor`)を作り、
スキル ZIP を取り付ける手順。**人が Agent Builder の画面で行う作業**で、スクリプトでは
自動化できない。作るのは初回だけで、以後のタスクでは同じエージェントを使い回す。

## 送信先の制限

ここで作るエージェントと、以後のタスクで添付する ZIP は、**職場・学校アカウントの Microsoft 365
Copilot(エンタープライズ データ保護あり)専用**。無料の Copilot アプリや個人アカウントには
絶対に添付しない(EDP が無く、リポジトリの内容が外部送信=流出になる)。

## 前提

- Microsoft 365 Copilot に組織アカウントでサインインでき、Agent Builder(左ペインの
  「エージェント」→「新しいエージェント」)が開ける。
- Agent Builder のスキル機能はプレビューで、**組織が Microsoft Frontier プログラムに
  登録されている**ことと、Microsoft 365 Copilot ライセンスまたは従量課金が必要
  (公式: `references/agent-builder-rules.md` の出典)。「構成」タブに「スキル」の
  節が無ければ、この前提を満たしていない。
- ローカルで `node scripts/pack-skill.mjs` が動く(Node 20 以上)。

## 1. スキル ZIP を作る(ローカル)

```bash
node shared/skills/m365-skill-pack/scripts/pack-skill.mjs shared/skills/m365-skill-pack/m365/skills/implement shared/skills/m365-skill-pack/m365/skills/audit shared/skills/m365-skill-pack/m365/skills/probe --from-template --out ./m365-zips
```

`implement.zip` / `audit.zip` / `probe.zip` ができる。検証エラーが出たら中身を直してから
進む(許可されない拡張子・深すぎる入れ子・文字数超過が主な原因)。アップロードが拒否された
ときの逃げ道は `--store`(無圧縮)→ `--wrap`(フォルダで包む)の順に試す。

## 2. probe 用の使い捨てエージェントで環境を測る

1. 「新しいエージェント」→「スキップして構成」。
2. 名前 `probe-check`、説明は「Runs the probe skill.」、指示は次の 3 行:

   ```text
   When asked to probe, use the probe skill and return its full output as probe-output.txt.
   Do not summarise the output.
   State whether the attached file was visible to the script and under which path.
   ```

3. 「構成」→「スキル」→「追加」で `probe.zip` をアップロード(**ZIP 丸ごと**。SKILL.md
   単体は不可)。
4. 「試してみる」で、小さな ZIP(何でもよい)を添付して
   `Run the probe skill and return its complete output as probe-output.txt.` を送る。
5. 返ってきた `probe-output.txt` を保存し、次を `references/m365-constraints.md` と
   `references/agent-builder-rules.md` の「Measured」節に日付付きで書き足す:
   - ZIP のアップロードがそのまま受理されたか(deflate / ルート直置き)
   - Python の版、OS、作業ディレクトリ
   - **添付した ZIP をスクリプトがパスで読めたか**(読めなければ入力は `--format md`)
   - 「ドキュメント、グラフ、コードの作成」を OFF にしてもスクリプトが走るか
   - 生成ファイルが OneDrive のどこに出たか
6. 「試してみる」でスクリプトが走らない場合は、エージェントを保存・共有(自分だけ)してから
   通常のチャットで同じことを試す。

## 3. `impl-loop` を作る

1. 「新しいエージェント」→「スキップして構成」。
2. `agents/impl-loop.md` の各ブロックを対応する欄に貼る: 名前、説明、指示(コードブロックの
   中身だけ)。指示は 8,000 文字以内(シートの時点で約 3,200 文字)。
3. 既定の応答モードを「深く考える」にする。
4. 機能トグルは probe の結果に従う(既定は「ドキュメント、グラフ、コードの作成」ON)。
5. 「スキル」→「追加」で `implement.zip`、続けて `audit.zip` をアップロードする。
6. **ナレッジは追加しない**(スキルと埋め込みファイルは併用できない)。
7. スターター プロンプトを 2 つ登録する(シートの表)。
8. 保存し、共有は「自分だけ」から始める。

## 4. `auditor` を作る

`agents/auditor.md` を使い、同じ手順。スキルは `audit.zip` だけ。応答モードは「自動」。

## 5. 動作確認(hello タスク)

1. ローカルで 2 ファイル程度の小さなリポジトリに `_m365/TASK.md` を書き、わざと 1 つ失敗する
   受け入れ基準(例: 禁止パターン `print\(` を含むコードを許さない)を入れる。
2. `make-input.mjs` で入力 ZIP を作り、`impl-loop` に添付して「Run the loop」を送る。
3. 2 ラウンド回って `out-<slug>-r2.zip` が返り、OneDrive に保存されることを確認する。
4. 同じ ZIP を `auditor` に添付して「Audit this bundle」を送り、`audit-<slug>.zip` を得る。
5. `unpack-output.mjs` で取り込み、終了コードと `reports/AUDIT.md` を確認する。
6. 所要時間、通った添付形式(`.zip` / `.md`)、拒否されたものを Measured 節に追記する。

## 以後のタスク

エージェントは作り直さない。`_m365/TASK.md` を書き、`make-input.mjs` で ZIP を作り、
添付して送り、返ってきた ZIP を `unpack-output.mjs` で取り込む。指示文を直したいときは
`agents/*.md` を編集し、`pack-skill.mjs instructions` で文字数を確かめてから貼り直す。

## 代替面: Cowork

Copilot アプリの Cowork は、同じ `SKILL.md` ルートの ZIP をスキルとして受け付け、添付に
`.zip` を公式に対応し、成果物を OneDrive の `Cowork` フォルダに出す。ただし従量課金で、
使えるかは組織の設定による。使えるなら `implement.zip` / `audit.zip` をそのまま
Cowork の「スキルのアップロード」に載せ、エージェント定義シートの指示文をセッションの最初に
貼る。
