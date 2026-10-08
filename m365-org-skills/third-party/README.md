# third-party

公開スキルを Microsoft 365 Copilot 向けに取り込んだもの。各フォルダは取り込みスクリプトが作る。手で直さない。

- 取り込みスクリプト: [`../scout/import-upstream.mjs`](../scout/import-upstream.mjs)(Node.js 20 以上と git だけで動く)。
  以前の `import_upstream.py` を Node に移したもので、同じ入力からは同じバイト列を出す。
- 取り込むスキルと読み替えの文面: [`overlays.json`](overlays.json)
- `_upstream/`: 元の `SKILL.md` の写し(差分確認用。ZIP には入らない)

取り込み直しの手順は [`../README.md`](../README.md) の「公開スキルの取り込み方」。
