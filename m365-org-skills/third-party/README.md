# third-party

公開スキルを Microsoft 365 Copilot 向けに取り込んだもの。各フォルダは取り込みスクリプトが作る。手で直さない。

- 取り込みスクリプト: [`../scout/import-upstream.mjs`](../scout/import-upstream.mjs)(Node.js 20 以上と git だけで動く)。
  以前の `import_upstream.py` を Node に移したもので、同じ入力からは同じバイト列を出す。
- 取り込むスキルと読み替えの文面: [`overlays.json`](overlays.json)
- `_upstream/`: 元の `SKILL.md` の写し(差分確認用。ZIP には入らない)

## ライセンス

取り込んだスキルのフォルダと `_upstream/` の写しは、agent-toolkit の MIT ライセンス(リポジトリ直下の `LICENSE`)の対象**ではない**。
それぞれ元のリポジトリのライセンスに従い、その本文を各スキルのフォルダの `LICENSE.txt` として同梱している。

| 元のリポジトリ | ライセンス | 対象 |
| --- | --- | --- |
| [github/awesome-copilot](https://github.com/github/awesome-copilot) | MIT(著作権者 GitHub, Inc.) | `create-architectural-decision-record/`、`create-specification/`、`incident-postmortem/`、`meeting-minutes/`、`prd/`、`sql-code-review/`、と `_upstream/` の同名の `*.SKILL.md` |
| [microsoft/cat-agent-skills](https://github.com/microsoft/cat-agent-skills) | MIT(著作権者 Microsoft Corporation) | `root-cause-analysis/`、と `_upstream/root-cause-analysis.SKILL.md` |

`_upstream/<名前>.SKILL.md` に適用されるライセンスの本文は、同じ名前のフォルダの `LICENSE.txt`(例: `_upstream/prd.SKILL.md` には `prd/LICENSE.txt`)。

取り込み直しの手順は [`../README.md`](../README.md) の「公開スキルの取り込み方」。
