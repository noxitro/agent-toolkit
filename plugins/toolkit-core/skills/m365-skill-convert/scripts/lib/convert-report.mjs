// The Japanese report (<name>.report.md) written next to the zip by skill2zip.mjs.

import { LEVEL_LABEL } from './checks.mjs'

const KIND_LABEL = { local: 'ローカルのフォルダ', installed: 'インストール済みのスキル', github: 'GitHub' }
const ORIGIN_LABEL = { own: '自作のスキル', 'third-party': '第三者のスキル' }

export function renderConvertReport(r, { originWhy, command }) {
  const out = []
  const status = r.zip
    ? r.draft
      ? `**下書きの ZIP を作った**(読み替えに TODO が残っている。このまま Agent Builder に追加しない): \`${r.zip}\`(${r.bytes} バイト)`
      : `**ZIP を作った**: \`${r.zip}\`(${r.bytes} バイト)`
    : '**ZIP は作っていない**(理由は「止めた理由」)'
  out.push(`# スキル変換レポート: ${r.name}`, '')
  out.push('> **これは機械による下調べです。安全性や権利を保証するものではありません。**')
  out.push('> 判定は、ファイル名・ライセンス文・本文の文字列を照合して付けた目安です。見落としも誤検出もあります。')
  out.push('> 使う前に、`SKILL.md` と、同梱するすべてのファイル(references・scripts・assets など)を**人が全文読んでください**。')
  out.push('> スキルは AI への指示そのものです。外部への送信、不審な指示、社外サービス前提の手順が無いかを確かめてください。', '')

  out.push('## 結果', '')
  out.push(`- ${status}`)
  const stale = (r.removedOld ?? []).filter((p) => p !== r.zip)
  if (stale.length) out.push(`- 前回の実行で作った ${stale.map((p) => `\`${p.split(/[\\/]/).pop()}\``).join(', ')} は、このレポートと合わないので消した`)
  out.push(`- 機械チェックの判定: **${r.verdict}**(スカウトと同じ基準。意味は末尾)`)
  out.push(`- 入力: ${r.input.label}(${KIND_LABEL[r.input.kind]})`)
  if (r.input.git?.commit) out.push(`- 版: コミット \`${r.input.git.commit}\`${r.input.git.date ? `(${r.input.git.date})` : ''}${r.input.git.remote ? `、${r.input.git.remote}` : ''}`)
  out.push(`- 出どころの扱い: ${ORIGIN_LABEL[r.origin]}(${originWhy})`)
  out.push(`- ライセンス: ${r.record.license.label}${r.record.license.file ? `(${r.record.license.file})` : ''}`)
  out.push(`- 読み替え(日本語): ${r.overlay.mode === 'ja' ? `付けた。定義: \`${r.overlay.file}\`${r.overlay.created ? '(今回、TODO 入りのひな形を作った)' : ''}` : '付けていない(--overlay ja で付けられる)'}`)
  if (r.staged) out.push(`- 中身を読むフォルダ: \`${r.staged}\`(ZIP と同じ中身。\`node_modules\` という名前は、テストの自動実行に拾われないようにするため)`)
  out.push(`- 実行したコマンド: \`${command}\``, '')

  if (r.stopping.length || r.hardProblems.length) {
    out.push('## 止めた理由', '')
    for (const b of r.stopping) out.push(`- ${b}`)
    for (const p of r.hardProblems) out.push(`- ${p}(--force でも変えられない。元のスキルを直す)`)
    const hints = []
    if (r.stopping.some((b) => /LICENSE が見つからない/.test(b)) && r.origin === 'own') hints.push('自作のスキルでライセンスを付けていないだけなら `--allow-license-unknown` で続けられる。')
    if (r.stopping.some((b) => !b.startsWith('読み替えに TODO'))) hints.push('理由を読んで納得できるものだけ `--force` で続けられる(第三者のスキルのライセンスが理由なら使わない)。')
    if (r.stopping.some((b) => b.startsWith('読み替えに TODO'))) hints.push(`\`${r.overlay.file}\` の TODO を書き換えてから、同じコマンドをもう一度実行する。試しに作るだけなら \`--draft\`。`)
    if (hints.length) out.push('', ...hints.map((h) => `- ${h}`))
    out.push('')
  }
  if (r.forced.length) {
    out.push('## --force で通した項目', '', '機械チェックでは止まる理由があるが、指定により ZIP を作った。', '')
    for (const f of r.forced) out.push(`- ${f}`)
    out.push('')
  }

  out.push('## 自動で直したこと', '')
  out.push('元のフォルダは変えていない。コピーに対して次を行った。', '')
  const fixLines = r.changes.length ? r.changes : ['(なし)']
  for (const c of fixLines) out.push(`- ${c}`)
  for (const f of r.fixes.filter((x) => x.kind === 'keep')) out.push(`- ${f.text}: ${f.files.map((x) => `\`${x}\``).join(', ')}`)
  out.push('')

  if (r.frontmatter.items.length) {
    out.push('## frontmatter で外したキー', '')
    out.push('| キー | 扱い | 元の値 |', '| --- | --- | --- |')
    for (const it of r.frontmatter.items) {
      const how = it.level === 'block' ? `止める理由: ${it.why}` : it.level === 'review' ? `要確認: ${it.why}` : '外した(Agent Builder は name と description だけを使う)'
      out.push(`| \`${it.key}\` | ${cell(how)} | ${it.raw ? '`' + cell(clip(it.raw.replace(/\n/g, ' ⏎ '), 120)) + '`' : ''} |`)
    }
    out.push('')
  }

  out.push('## 機械チェックの結果', '')
  for (const level of ['block', 'review', 'rewrite', 'info']) {
    const fs = r.record.findings.filter((f) => f.level === level)
    for (const f of fs) out.push(`- [${LEVEL_LABEL[level]}] ${f.msg}${f.claudeOnly ? '(Claude Code 専用の機能。変換では止める理由)' : ''}`)
  }
  for (const w of r.warnings) out.push(`- [注意] ${w}`)
  out.push('')

  if (r.overlay.mode === 'ja') {
    out.push('## 読み替え(日本語)', '')
    out.push(`定義ファイル: \`${r.overlay.file}\`。\`trigger_ja\` は description の末尾に足す日本語の依頼例、\`extra\` は「このスキルでの読み替え」に足す行。`, '')
    out.push(`- trigger_ja: ${r.overlay.trigger}`)
    for (const l of r.overlay.extra ?? []) out.push(`- extra: ${l}`)
    if (r.overlay.todo) out.push('', 'TODO が残っている。スキルの全文を読んでから書き換える(使い分け、返すファイルの名前、接続できないサービスの言い換え)。')
    out.push('')
  }

  out.push('## ZIP に入るファイル', '')
  if (r.files.length) {
    out.push('| ファイル | バイト |', '| --- | ---: |')
    for (const f of r.files) out.push(`| \`${f.name}\` | ${f.bytes} |`)
  } else out.push('(検査を通らなかったので一覧を作れない)')
  out.push('')

  out.push('## 次にすること', '')
  out.push('1. 上の「中身を読むフォルダ」の `SKILL.md` と同梱ファイルを全文読む。何をさせるスキルか、外部への送信・個人の評価や推定・ライセンスの条件が無いかを確かめる。')
  if (r.overlay.mode === 'ja') out.push('2. 読み替えの TODO を埋めて、もう一度実行する。')
  out.push(`${r.overlay.mode === 'ja' ? 3 : 2}. 自分だけの(共有しない)エージェントで試してから、Agent Builder の「スキル」→「追加」で ZIP を追加する。ZIP を社外のサービスにアップロードしない。`, '')

  out.push('## 判定の意味', '')
  out.push('| 判定 | 意味 |', '| --- | --- |')
  out.push('| 候補 | ライセンス・形式・依存・危険の検査で引っかかるものが無い(安全の保証ではない) |')
  out.push('| 要書き換え | 別のツール向けの記述(保存先、`${input:}`、Slack など)がある。読み替えを書く |')
  out.push('| 要確認 | ライブラリが要る、通信の可能性、人に関わる判断、ライセンスが判別できない など。人が読んで判断する |')
  out.push('| 不可 | 制限付き・不明のライセンス、Windows のスクリプト、サンドボックスに無い CLI ツール、通信が必須、上限超え |')
  out.push('')
  return out.join('\n')
}

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const clip = (s, n) => {
  const cps = [...String(s ?? '')]
  return cps.length > n ? cps.slice(0, n - 1).join('') + '…' : cps.join('')
}
