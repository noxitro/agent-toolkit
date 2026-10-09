// Japanese Markdown report for `scout.mjs scan`. One row per skill, sorted by verdict,
// then keyword score, then source and name; details for every skill follow the table.

import { LEVEL_LABEL, VERDICTS } from '../../../shared/skills/m365-skill-convert/scripts/lib/checks.mjs'

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const clip = (s, n) => {
  const cps = [...String(s ?? '')]
  return cps.length > n ? cps.slice(0, n - 1).join('') + '…' : cps.join('')
}

export function sortRecords(records) {
  return [...records].sort(
    (a, b) =>
      VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      a.repo.localeCompare(b.repo) ||
      a.name.localeCompare(b.name),
  )
}

const VERDICT_HELP = [
  ['候補', 'ライセンスが緩い(MIT・Apache-2.0 など)、形式どおり、外部への依存も危険の印も見当たらない', '`adopt` して、日本語の依頼例と読み替えを書く'],
  ['要書き換え', '別のツール向けの記述(保存先、${input:}、Slack、~~ のコネクタなど)や、外せば済むファイルがある', '`adopt` して、読み替え(extra)に言い換えを書く'],
  ['要確認', '危険の印、人に関わる判断、ライセンスが判別できない、probe で確かめるべきライブラリがある', '人が中身を読んで判断する。ライブラリは probe で確かめる'],
  ['不可', '制限付き・不明のライセンス、Windows のスクリプト、サンドボックスに無い CLI ツール、ネットワーク前提、上限超え', '使わない(`adopt --force` で上書きできるが勧めない)'],
]

export function renderReport({ records, sources, keywords, generatedAt, overlaysCmd }) {
  const sorted = sortRecords(records)
  const out = []
  out.push('# 公開スキルの機械チェック結果', '')
  out.push('> **これは機械による下調べです。安全性や権利を保証するものではありません。**')
  out.push('> 判定は、ファイル名・ライセンス文・本文の文字列を照合して付けた目安です。見落としも誤検出もあります。')
  out.push('> 採用するスキルは、`SKILL.md` と、同梱するすべてのファイル(references・scripts・assets など)を、**使う前に人が全文読んでください**。')
  out.push('> スキルは AI への指示そのものです。外部への送信、不審な指示、社外サービス前提の手順が無いかを確かめてください。', '')
  out.push(`- 作成日時: ${generatedAt}`)
  out.push(`- キーワード: ${keywords.length ? keywords.join(' ') : '(指定なし)'}`)
  out.push(`- スキルの数: ${records.length}`, '')

  out.push('## 取得元', '')
  out.push('| リポジトリ | コミット | 日付 | スキル | メモ |', '| --- | --- | --- | --- | --- |')
  for (const s of sources) {
    const n = records.filter((r) => r.repo === s.repo).length
    out.push(`| [${s.repo}](https://github.com/${s.repo}) | ${s.meta ? '`' + s.meta.commit.slice(0, 12) + '`' : '(未取得)'} | ${s.meta?.date ?? ''} | ${n} | ${cell(s.note)} |`)
  }
  out.push('')

  out.push('## 判定の意味', '')
  out.push('| 判定 | 意味 | 次にすること |', '| --- | --- | --- |')
  for (const [v, m, next] of VERDICT_HELP) out.push(`| ${v} | ${cell(m)} | ${cell(next)} |`)
  out.push('')

  out.push('## 集計', '')
  out.push(`| 取得元 | ${VERDICTS.join(' | ')} |`, `| --- | ${VERDICTS.map(() => '---:').join(' | ')} |`)
  for (const s of sources) out.push(`| ${s.repo} | ${VERDICTS.map((v) => records.filter((r) => r.repo === s.repo && r.verdict === v).length).join(' | ')} |`)
  out.push(`| 合計 | ${VERDICTS.map((v) => records.filter((r) => r.verdict === v).length).join(' | ')} |`, '')

  const row = (r) => {
    const reasons = r.findings.filter((f) => f.level !== 'info').slice(0, 3).map((f) => clip(f.msg, 90))
    const more = r.findings.filter((f) => f.level !== 'info').length - reasons.length
    return `| ${r.verdict} | [${cell(r.name)}](#${anchor(r)}) | ${cell(r.repo)} | ${cell(r.license.label)} | ${r.score ?? ''} | ${cell(reasons.join(' / ') + (more > 0 ? ` ほか ${more} 件` : '') || '—')} |`
  }
  if (keywords.length) {
    const hits = sorted.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict))
    out.push('## キーワードに合うもの', '')
    out.push(`名前に含まれれば 2 点、説明に含まれれば 1 点(キーワードごと)。${hits.length} 件。`, '')
    out.push('| 判定 | スキル | 取得元 | ライセンス | 関連度 | 主な理由 |', '| --- | --- | --- | --- | ---: | --- |')
    for (const r of hits.slice(0, 60)) out.push(row(r))
    if (hits.length > 60) out.push('', `(ほか ${hits.length - 60} 件は下の一覧を参照)`)
    out.push('')
  }

  out.push('## 一覧(判定順)', '')
  out.push('| 判定 | スキル | 取得元 | ライセンス | 関連度 | 主な理由 |', '| --- | --- | --- | --- | ---: | --- |')
  for (const r of sorted) out.push(row(r))
  out.push('')

  out.push('## 詳細', '')
  out.push(`採用するときは \`${overlaysCmd} <ID>\` を実行する(ID は各項目の 2 行目)。`, '')
  for (const r of sorted) {
    out.push(`### <a id="${anchor(r)}"></a>[${r.verdict}] ${r.name}`, '')
    out.push(`- ID: \`${r.id}\`(コミット \`${(r.commit ?? '').slice(0, 12)}\`、${r.date ?? ''})`)
    out.push(`- 元のフォルダ: https://github.com/${r.repo}/tree/${r.commit ?? 'HEAD'}/${r.path}`)
    out.push(`- 説明: ${clip(r.description, 300).replace(/\s+/g, ' ')}`)
    for (const f of r.findings) out.push(`- [${LEVEL_LABEL[f.level]}] ${f.msg}`)
    out.push('')
  }
  return out.join('\n')
}

function anchor(r) {
  return 's-' + r.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
