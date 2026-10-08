// Tests for the text-oriented Microsoft 365 Copilot skills under m365-org-skills/skills:
// minutes (transcript_to_text.py), doc-style-check (style_check.py) and training-quiz
// (extract_text.py, quiz_to_csv.py), plus packing of those skills and proposal-outline.
// Fixtures (.vtt, .docx, .pptx) are built at test time in a temp dir; the scripts run under
// `python -I`. Every Python test is skipped when no Python 3 interpreter is available.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(ROOT, 'm365-org-skills/skills')
const PACKER = join(ROOT, 'shared/skills/m365-skill-pack/scripts/pack-skill.mjs')
const TRANSCRIPT = join(SKILLS, 'minutes/scripts/transcript_to_text.py')
const STYLE = join(SKILLS, 'doc-style-check/scripts/style_check.py')
const EXTRACT = join(SKILLS, 'training-quiz/scripts/extract_text.py')
const QUIZ = join(SKILLS, 'training-quiz/scripts/quiz_to_csv.py')
const MY_SKILLS = ['minutes', 'doc-style-check', 'proposal-outline', 'training-quiz']

function findPython() {
  for (const cmd of [['python'], ['py', '-3'], ['python3']]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), '--version'], { encoding: 'utf8' })
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return cmd
  }
  return null
}

const PY = findPython()
const NO_PY = 'no Python 3 interpreter found (tried python, py -3, python3)'
const DIR = mkdtempSync(join(tmpdir(), 'm365-org-text-'))
after(() => rmSync(DIR, { recursive: true, force: true }))

function py(script, args) {
  return spawnSync(PY[0], [...PY.slice(1), '-I', script, ...args], { encoding: 'utf8', cwd: DIR })
}

function pyJson(script, args) {
  const r = py(script, [...args, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

// Builds a zip from {name: text} with the Python standard library (what the sandbox has too).
function buildZip(name, parts) {
  const spec = join(DIR, `${name}.json`)
  writeFileSync(spec, JSON.stringify(parts))
  const code = 'import json,sys,zipfile\n' +
    'parts=json.load(open(sys.argv[1],encoding="utf-8"))\n' +
    'with zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as z:\n' +
    '    [z.writestr(k,v.encode("utf-8")) for k,v in parts.items()]\n'
  const out = join(DIR, name)
  const r = spawnSync(PY[0], [...PY.slice(1), '-I', '-c', code, spec, out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return out
}

const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// paras: strings, {style, text} for a styled paragraph, or {cell} for a one-cell table.
function docx(name, paras, styles) {
  const body = paras.map((p) => {
    if (typeof p === 'string') return `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`
    if (p.cell) return `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>${esc(p.cell)}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    return `<w:p><w:pPr><w:pStyle w:val="${p.style}"/></w:pPr><w:r><w:t>${esc(p.text)}</w:t></w:r></w:p>`
  }).join('')
  const parts = { 'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${WNS}><w:body>${body}</w:body></w:document>` }
  if (styles) parts['word/styles.xml'] = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${WNS}>${styles}</w:styles>`
  return buildZip(name, parts)
}

const VTT = `WEBVTT

1c2d/10-0
00:00:01.000 --> 00:00:04.000
<v 山田 太郎>それでは定例会議を始めます。</v>

1c2d/11-0
00:00:04.500 --> 00:00:08.000
<v 山田 太郎>今日の議題は来期の予算です。</v>

1c2d/12-0
00:00:08.500 --> 00:00:10.500
<v 佐藤 花子>資料を共有します &amp; 説明します。</v>

1c2d/13-0
00:00:11.000 --> 00:00:21.000
<v 山田 太郎>では佐藤さん、来週金曜までに見積もりをお願いします。

00:01:00.000 --> 00:01:02.000
<v 佐藤 花子>承知しました。</v>
`

test('minutes: WebVTT turns are parsed, merged per speaker and counted', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = join(DIR, 'meeting.vtt')
  writeFileSync(file, VTT)
  const s = pyJson(TRANSCRIPT, [file])
  assert.equal(s.format, 'WebVTT')
  assert.equal(s.raw_turns, 5)
  assert.equal(s.merged_turns, 4)
  assert.equal(s.duration_sec, 61)
  assert.equal(s.share_basis, '発言時間')
  assert.deepEqual(s.speakers.map((p) => p.name), ['山田 太郎', '佐藤 花子'])
  assert.equal(s.speakers[0].turns, 2)
  assert.equal(s.speakers[0].seconds, 16.5)
  assert.equal(s.speakers[0].share + s.speakers[1].share, 100)
  // Consecutive turns joined without a stray space after 。, entities decoded, missing </v> tolerated.
  assert.equal(s.turns[0].text, 'それでは定例会議を始めます。今日の議題は来期の予算です。')
  assert.equal(s.turns[0].pieces, 2)
  assert.equal(s.turns[1].text, '資料を共有します & 説明します。')
  assert.match(s.turns[2].text, /^では佐藤さん、来週金曜までに見積もりをお願いします。$/)
  assert.equal(s.turns[3].start, '00:01:00')
})

test('minutes: --out writes the compact text and prints only the statistics', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = join(DIR, 'meeting2.vtt')
  writeFileSync(file, VTT)
  const out = join(DIR, 'transcript.txt')
  const r = py(TRANSCRIPT, [file, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /話者: 2名/)
  assert.doesNotMatch(r.stdout, /\[00:00:01\]/)
  const text = readFileSync(out, 'utf8')
  assert.match(text, /^\[00:00:01\] 山田 太郎: それでは定例会議を始めます。今日の議題は来期の予算です。$/m)
  assert.match(text, /^\[00:00:08\] 佐藤 花子: /m)
})

test('minutes: a Teams .docx transcript (speaker + time headings) is read, the date line is not a speaker', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('teams.docx', [
    // The date line has text after it and its "10:00" is not later than the headings, so
    // without the date exclusion it would become a speaker called "2026年10月1日".
    '定例会議 - 文字起こし', '2026年10月1日 10:00', '録音 45分 12秒',
    '山田 太郎   10:03', '本日はお集まりいただきありがとうございます。',
    '山田 太郎   10:15', '最初の議題に入ります。',
    '佐藤 花子   11:02', '進捗を報告します。', '予定どおりです。',
  ])
  const s = pyJson(TRANSCRIPT, [file])
  assert.match(s.format, /見出し形式/)
  assert.deepEqual(s.speakers.map((p) => p.name).sort(), ['佐藤 花子', '山田 太郎'])
  assert.equal(s.share_basis, '文字数')
  assert.equal(s.merged_turns, 2)
  assert.equal(s.turns[0].text, '本日はお集まりいただきありがとうございます。最初の議題に入ります。')
  assert.equal(s.turns[1].text, '進捗を報告します。予定どおりです。')
  assert.equal(s.turns[1].start, '00:11:02')
})

test('minutes: the older .docx layout (time range / speaker / text) is read too', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('teams-old.docx', [
    '0:0:0.0 --> 0:0:5.0', '山田 太郎', 'はじめます。',
    '0:0:5.0 --> 0:0:9.0', '佐藤 花子', 'よろしくお願いします。',
  ])
  const s = pyJson(TRANSCRIPT, [file])
  assert.match(s.format, /時刻範囲形式/)
  assert.equal(s.duration_sec, 9)
  assert.deepEqual(s.turns.map((x) => x.speaker), ['山田 太郎', '佐藤 花子'])
})

test('minutes: unsupported or empty input fails loudly with exit 2', (t) => {
  if (!PY) return t.skip(NO_PY)
  const pdf = join(DIR, 'x.pdf')
  writeFileSync(pdf, '%PDF-1.4')
  let r = py(TRANSCRIPT, [pdf])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未対応の形式/)
  const empty = join(DIR, 'empty.txt')
  writeFileSync(empty, '\n\n')
  r = py(TRANSCRIPT, [empty])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /本文がありません/)
})

// SKILL.template.md branches on this exact message and on exit code 3.
const NOT_TRANSCRIPT = '話者と時刻を含む文字起こし形式ではありません'

test('minutes: a memo (.docx, .txt, or with a stray "-->" line) gets one message, exit 3 and its full text in --out', (t) => {
  if (!PY) return t.skip(NO_PY)
  const skill = readFileSync(join(SKILLS, 'minutes/SKILL.template.md'), 'utf8')
  assert.ok(skill.includes(NOT_TRANSCRIPT) && /終了コード 3/.test(skill), 'SKILL must branch on the message and exit 3')
  const arrow = join(DIR, 'memo_arrow.txt')
  // The reviewer's shape: arrows with text after the times are a schedule, not cue timings.
  writeFileSync(arrow, '移行計画\n10:00 --> 11:00 DB停止\n11:00 --> 12:00 切替\n担当は山田\n')
  const cases = [
    [docx('memo2.docx', ['会議メモ', '予算は据え置きの方向。', '次回 10:00']), ['会議メモ', '予算は据え置きの方向。', '次回 10:00']],
    [arrow, ['移行計画', '10:00 --> 11:00 DB停止', '11:00 --> 12:00 切替', '担当は山田']],
  ]
  const md = join(DIR, 'memo.md')
  writeFileSync(md, '# 会議メモ\n- 予算据え置き\n')
  cases.push([md, ['# 会議メモ', '- 予算据え置き']])
  for (const [file, lines] of cases) {
    const out = join(DIR, 'memo-out.txt')
    rmSync(out, { force: true })
    const r = py(TRANSCRIPT, [file, '--out', out])
    assert.equal(r.status, 3, `${file}: ${r.stderr}`)
    assert.ok(r.stderr.includes(NOT_TRANSCRIPT), r.stderr)
    assert.equal(readFileSync(out, 'utf8'), lines.join('\n') + '\n')
  }
})

test('minutes: a new-format .docx body line ending in a time is text, not a speaker (Japanese)', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('teams-new-ja.docx', [
    '定例会議-20261001_100012-会議の録音', '2026年10月1日, 10:00AM', '45分 12秒', '',
    '山田 太郎   0:03', 'それでは始めます。',
    '佐藤 花子   0:15', 'リリースは金曜の 15:00', 'でどうでしょう。',
    '山田 太郎   0:40', 'はい、15:00 で決定です。締めは 17:30',
    '鈴木 一郎   1:02:03', '了解です 10:30',
    '佐藤 花子   1:02:08', '承知しました 9:45',
    '鈴木 一郎   1:02:10', 'あと一点。',
  ])
  const r = py(TRANSCRIPT, [file, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const s = JSON.parse(r.stdout)
  assert.deepEqual(s.speakers.map((p) => p.name).sort(), ['佐藤 花子', '山田 太郎', '鈴木 一郎'])
  assert.deepEqual(s.turns.map((x) => [x.start, x.speaker, x.text]), [
    ['00:00:03', '山田 太郎', 'それでは始めます。'],
    ['00:00:15', '佐藤 花子', 'リリースは金曜の 15:00 でどうでしょう。'],
    ['00:00:40', '山田 太郎', 'はい、15:00 で決定です。締めは 17:30'],
    ['01:02:03', '鈴木 一郎', '了解です 10:30'],
    ['01:02:08', '佐藤 花子', '承知しました 9:45'],
    ['01:02:10', '鈴木 一郎', 'あと一点。'],
  ])
  // Demoted heading-shaped lines are reported, not hidden.
  assert.match(r.stderr, /警告: 話者・時刻の見出しに似た 4 行を発言の本文として扱いました/)
  assert.deepEqual(s.warnings.length, 2) // the demoted lines and the export header before the first heading
})

test('minutes: a new-format .docx body line ending in a time is text, not a speaker (English)', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('teams-new-en.docx', [
    'Weekly sync-20261001_100012-Meeting Recording', 'October 1, 2026, 10:00AM', '45m 12s', '',
    'Taro Yamada   0:03', "Let's start.",
    'Hanako Sato   0:15', 'Ship at 3 PM on Friday, ok at 10:30',
    'Taro Yamada   0:40', 'Agreed.',
    'Yamada, Taro (Sales)   0:52', 'One more thing at 11:00',
    'Taro Yamada   1:05', 'Done.',
  ])
  const s = pyJson(TRANSCRIPT, [file])
  assert.deepEqual(s.speakers.map((p) => p.name).sort(), ['Hanako Sato', 'Taro Yamada', 'Yamada, Taro (Sales)'])
  assert.deepEqual(s.turns.map((x) => x.text), ["Let's start.", 'Ship at 3 PM on Friday, ok at 10:30', 'Agreed.', 'One more thing at 11:00', 'Done.'])
})

test('minutes: a heading in body position, a heading going back in time, and an empty last heading', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('teams-new-odd.docx', [
    '山田 太郎   0:15', 'リリースは', '金曜 15:00',  // a clock time at the end of a second body paragraph
    '佐藤 花子   0:40', '了解です。',
    '山田 太郎   0:50', '前回は', '議事録 0:10', // goes back in time: body text
    '佐藤 花子   1:00', 'はい。',
    '鈴木 一郎   1:10',
  ])
  const r = py(TRANSCRIPT, [file, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const s = JSON.parse(r.stdout)
  assert.deepEqual(s.turns.map((x) => [x.speaker, x.text]), [
    ['山田 太郎', 'リリースは 金曜 15:00'],
    ['佐藤 花子', '了解です。'],
    ['山田 太郎', '前回は 議事録 0:10'],
    ['佐藤 花子', 'はい。'],
  ])
  assert.match(r.stderr, /警告: 見出し「鈴木 一郎   1:10」の後に発言の本文がありません/)
  assert.match(r.stderr, /見出しに似た 2 行を発言の本文として扱いました/)
})

test('minutes: each heading rule holds on its own (heading after heading, time order, sentence punctuation)', (t) => {
  if (!PY) return t.skip(NO_PY)
  const cases = {
    // In order and name-like, but it directly follows a heading: it is that heading's body.
    adjacent: ['山田 太郎   0:03', 'はい 0:05', '佐藤 花子   0:10', 'うん。'],
    // Name-like with its own body, but earlier than the heading before it.
    backwards: ['山田 太郎   0:30', 'はい。', 'メモ 0:10', '続き。', '佐藤 花子   0:40', 'うん。'],
    // In order with its own body, but the "name" is a sentence.
    sentence: ['山田 太郎   0:10', 'はい。', '以上です。次は 0:20', '続き', '佐藤 花子   0:30', 'うん。'],
  }
  for (const [name, paras] of Object.entries(cases)) {
    const s = pyJson(TRANSCRIPT, [docx(`rule-${name}.docx`, paras)])
    assert.deepEqual(s.turns.map((x) => x.speaker), ['山田 太郎', '佐藤 花子'], name)
    assert.equal(s.turns[0].text, paras.slice(1, -2).join(' ').replace(/。 /g, '。'), name)
  }
})

test('minutes: WebVTT edge cases (voices without </v>, >99 hours, UTF-16, multi-line cues)', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = join(DIR, 'edge.vtt')
  writeFileSync(file, [
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:03.000 align:start',
    '<v.loud 山田 太郎>聞こえますか', '<v 佐藤 花子>聞こえます', '',
    '00:00:04.000 --> 00:00:06.000', '<v 田中>テストは全部通っています。', '残りは性能だけです。</v>', '',
    '100:00:00.000 --> 100:00:01.000', '<v 山田 太郎>100時間後</v>', '',
  ].join('\n'))
  const s = pyJson(TRANSCRIPT, [file])
  assert.deepEqual(s.turns.map((x) => [x.start, x.speaker, x.text]), [
    ['00:00:01', '山田 太郎', '聞こえますか'],
    ['00:00:01', '佐藤 花子', '聞こえます'],
    ['00:00:04', '田中', 'テストは全部通っています。残りは性能だけです。'],
    ['100:00:00', '山田 太郎', '100時間後'],
  ])
  // Notepad's "Unicode" (UTF-16 LE with BOM)
  const u16 = join(DIR, 'utf16.vtt')
  writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v 山田>テスト</v>\n', 'utf16le')]))
  const u = pyJson(TRANSCRIPT, [u16])
  assert.deepEqual(u.turns.map((x) => [x.speaker, x.text]), [['山田', 'テスト']])
})

test('minutes: a long run of one speaker is split so every line stays near its timestamp', (t) => {
  if (!PY) return t.skip(NO_PY)
  const ts = (sec) => `00:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000`
  const cues = ['WEBVTT', '']
  // 18 cues of one speaker, one every 10 s (0 to 170 s), then a long monologue in one minute.
  for (let i = 0; i < 18; i++) cues.push(`${ts(i * 10)} --> ${ts(i * 10 + 9)}`, `<v 山田>発言${i}。</v>`, '')
  for (let i = 0; i < 6; i++) cues.push(`${ts(200 + i * 5)} --> ${ts(204 + i * 5)}`, `<v 佐藤>${'あ'.repeat(99)}。</v>`, '')
  const file = join(DIR, 'long.vtt')
  writeFileSync(file, cues.join('\n'))
  const s = pyJson(TRANSCRIPT, [file])
  const yamada = s.turns.filter((x) => x.speaker === '山田')
  assert.deepEqual(yamada.map((x) => x.start), ['00:00:00', '00:01:00', '00:02:00'])
  assert.deepEqual(yamada.map((x) => x.pieces), [6, 6, 6])
  const sato = s.turns.filter((x) => x.speaker === '佐藤')
  assert.deepEqual(sato.map((x) => x.pieces), [4, 2]) // a new line once 400 characters are reached
  assert.ok(sato.every((x) => x.text.length <= 500))
  // Nothing is lost by the split.
  assert.equal(yamada.map((x) => x.text).join(''), Array.from({ length: 18 }, (_, i) => `発言${i}。`).join(''))
})

const STYLE_TXT = [
  'この資料は会議で使用します。',
  '新機能は誰でも利用出来ます。資料を確認して下さい。',
  'バージョンはＶｅｒ２です。ｶﾀｶﾅの表記も確認します。',
  '結果は良好だ。',
  '「括弧（ずれ」に注意します。',
  '「閉じ忘れの括弧があります。',
  '1) 番号付きの項目です。',
  `${'長い文の例です'.repeat(14)}。`,
  'あれ、これ、それ、どれ、を確認します。',
  'まず最初に説明します。',
].join('\n')

test('doc-style-check: the rules find 表記ゆれ, 全角英数, 半角カナ, 文体の混在, brackets and long sentences', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = join(DIR, 'doc.txt')
  writeFileSync(file, STYLE_TXT)
  const f = pyJson(STYLE, [file])
  const at = (type) => f.filter((x) => x.type === type)
  assert.deepEqual(at('表記ゆれ').map((x) => [x.line, x.text]), [[2, '出来'], [2, '下さい']])
  assert.match(at('表記ゆれ')[0].suggest, /^でき/)
  assert.deepEqual(at('全角英数字').map((x) => [x.line, x.col, x.text, x.suggest]), [[3, 7, 'Ｖｅｒ２', 'Ver2(半角にする)']])
  assert.deepEqual(at('半角カナ').map((x) => [x.line, x.text]), [[3, 'ｶﾀｶﾅ']])
  assert.match(at('半角カナ')[0].suggest, /^カタカナ/)
  // Only line 4 is だ・である調; 「閉じ忘れ… stays one unclosed-quote sentence ending in ます.
  assert.deepEqual(at('文体の混在').map((x) => x.line), [4])
  assert.match(at('文体の混在')[0].suggest, /です・ます調に合わせる/)
  assert.deepEqual(at('括弧の不一致').map((x) => x.line), [5])
  assert.match(at('括弧の不一致')[0].suggest, /「（」に対応する閉じ括弧は「）」/)
  // Line 5 also leaves 「 open after the mismatch; line 6 never closes; the "1)" enumerator is not flagged.
  assert.deepEqual(at('括弧の対応').map((x) => x.line), [5, 6])
  assert.deepEqual(at('長い文').map((x) => x.line), [8])
  assert.deepEqual(at('読点の多い文').map((x) => x.line), [9])
  assert.deepEqual(at('冗長表現').map((x) => [x.line, x.text]), [[10, 'まず最初に']])
})

test('doc-style-check: Markdown report and CSV (BOM, Excel friendly) are written', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = join(DIR, 'doc2.txt')
  writeFileSync(file, STYLE_TXT)
  const md = join(DIR, 'style-report.md')
  const csv = join(DIR, 'style-report.csv')
  const r = py(STYLE, [file, '--out', md, '--csv', csv])
  assert.equal(r.status, 0, r.stderr)
  const report = readFileSync(md, 'utf8')
  assert.match(report, /\| 行:位置 \| 種別 \| 該当箇所 \| 提案 \|/)
  assert.match(report, /\| 2:10 \| 表記ゆれ \| 新機能は誰でも利用\*\*出来\*\*ます。/)
  const bytes = readFileSync(csv)
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const lines = bytes.toString('utf8').slice(1).trim().split(/\r?\n/)
  assert.equal(lines[0], '行,位置,種別,該当,前後,提案')
  assert.ok(lines.some((l) => l.startsWith('2,10,表記ゆれ,出来,') && l.includes('【出来】')))
})

test('doc-style-check: .docx paragraphs are numbered and checked; rules can be switched off', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('style.docx', ['ご連絡致します。', '', '資料はＡ４で印刷します。'])
  const f = pyJson(STYLE, [file])
  assert.deepEqual(f.map((x) => [x.line, x.type]), [[1, '表記ゆれ'], [3, '全角英数字']])
  const rules = JSON.parse(readFileSync(join(SKILLS, 'doc-style-check/resources/style-rules.json'), 'utf8'))
  rules.checks.zenkaku_alnum = false
  const custom = join(DIR, 'rules-off.json')
  writeFileSync(custom, JSON.stringify(rules))
  const g = pyJson(STYLE, [file, '--rules', custom])
  assert.deepEqual(g.map((x) => x.type), ['表記ゆれ'])
})

test('doc-style-check: a broken rules file stops the run instead of checking with defaults', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = join(DIR, 'doc3.txt')
  writeFileSync(file, 'テストです。')
  const bad = join(DIR, 'rules-bad.json')
  writeFileSync(bad, JSON.stringify({ variants: [{ pattern: '(', regex: true, suggest: 'x' }] }))
  const r = py(STYLE, [file, '--rules', bad])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /正規表現が不正/)
})

test('training-quiz: extract_text reads .docx paragraphs with locations and Japanese heading styles', (t) => {
  if (!PY) return t.skip(NO_PY)
  const file = docx('material.docx', [{ style: '1', text: '情報セキュリティの基本' }, '', 'パスワードは12文字以上にします。', { cell: '表の中の文です。' }],
    '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>')
  const r = py(EXTRACT, [file])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n'), [
    '[段落1] [見出し] 情報セキュリティの基本',
    '[段落3] パスワードは12文字以上にします。',
    '[段落4] 表の中の文です。',
  ])
})

test('training-quiz: extract_text follows the .pptx slide order and includes notes and hidden marks', (t) => {
  if (!PY) return t.skip(NO_PY)
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const rels = (items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
  const slide = (texts, attrs = '') => `<?xml version="1.0"?><p:sld ${P}${attrs}><p:cSld><p:spTree><p:sp><p:txBody>${texts.map((x) => `<a:p><a:r><a:t>${x}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  const file = buildZip('deck.pptx', {
    // slide2.xml is shown first: the order comes from sldIdLst, not from the file names.
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(`<Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide2.xml"/>`),
    'ppt/slides/slide1.xml': slide(['まとめ', '報告は24時間以内'], ' show="0"'),
    'ppt/slides/slide2.xml': slide(['研修の目的', 'インシデントの初動を学ぶ']),
    'ppt/slides/_rels/slide2.xml.rels': rels(`<Relationship Id="rId9" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`),
    'ppt/notesSlides/notesSlide1.xml': slide(['講師メモ:最初に目的を説明する', '2']),
  })
  const out = join(DIR, 'material.txt')
  const r = py(EXTRACT, [file, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /スライド 2枚/)
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [
    '=== スライド 1 ===', '研修の目的', 'インシデントの初動を学ぶ', '[ノート] 講師メモ:最初に目的を説明する',
    '=== スライド 2 (非表示スライド) ===', 'まとめ', '報告は24時間以内',
  ])
})

test('training-quiz: extract_text leaves PDF to the agent (exit 3)', (t) => {
  if (!PY) return t.skip(NO_PY)
  const pdf = join(DIR, 'material.pdf')
  writeFileSync(pdf, '%PDF-1.4')
  const r = py(EXTRACT, [pdf])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /エージェントが直接読んで/)
})

test('training-quiz: quiz_to_csv validates questions and writes CSV and Forms text', (t) => {
  if (!PY) return t.skip(NO_PY)
  const quiz = {
    title: '情報セキュリティ研修 理解度テスト',
    questions: [
      { type: '選択式', difficulty: '易', question: 'パスワードの最低文字数は?', choices: ['8文字', '10文字', '12文字', '16文字'], answer: 'C', explanation: '12文字以上と定めている。', source: '段落3' },
      { type: '○×', difficulty: '中', question: 'インシデントは48時間以内に報告する。', answer: 'x', explanation: '24時間以内。', source: 'スライド2' },
      { type: '記述', difficulty: '難', question: '研修の目的を説明せよ。', answer: 'インシデントの初動を学ぶこと。', explanation: '目的のスライド参照。', source: 'スライド1' },
    ],
  }
  const json = join(DIR, 'quiz.json')
  writeFileSync(json, JSON.stringify(quiz))
  const csv = join(DIR, 'quiz.csv')
  const forms = join(DIR, 'quiz-forms.txt')
  const r = py(QUIZ, [json, '--csv', csv, '--forms-text', forms])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /3問/)
  const lines = readFileSync(csv, 'utf8').replace(/^\ufeff/, '').trim().split(/\r?\n/)
  assert.equal(lines[0], '番号,形式,難易度,問題文,選択肢1,選択肢2,選択肢3,選択肢4,正解,解説,出典')
  assert.equal(lines[1], '1,選択式,易,パスワードの最低文字数は?,8文字,10文字,12文字,16文字,12文字,12文字以上と定めている。,段落3')
  assert.equal(lines[2], '2,○×,中,インシデントは48時間以内に報告する。,○,×,,,×,24時間以内。,スライド2')
  assert.equal(lines[3], '3,記述,難,研修の目的を説明せよ。,,,,,インシデントの初動を学ぶこと。,目的のスライド参照。,スライド1')
  const ft = readFileSync(forms, 'utf8')
  assert.match(ft, /^1\. パスワードの最低文字数は\?\na\. 8文字\nb\. 10文字\nc\. 12文字\nd\. 16文字$/m)
  assert.doesNotMatch(ft, /24時間以内。/)
})

test('training-quiz: quiz_to_csv refuses an answer that is not a choice and writes nothing', (t) => {
  if (!PY) return t.skip(NO_PY)
  const json = join(DIR, 'quiz-bad.json')
  writeFileSync(json, JSON.stringify({ questions: [
    { type: '選択式', difficulty: '易', question: 'Q', choices: ['A案', 'B案', 'A案'], answer: 'C案', explanation: 'e', source: '' },
  ] }))
  const csv = join(DIR, 'quiz-bad.csv')
  const r = py(QUIZ, [json, '--csv', csv])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /answer が選択肢のどれとも一致しません/)
  assert.match(r.stderr, /重複/)
  assert.match(r.stderr, /source/)
  assert.equal(existsSync(csv), false)
})

test('every text skill packs with --from-template without problems', () => {
  const out = join(DIR, 'zips')
  const r = spawnSync(process.execPath, [PACKER, ...MY_SKILLS.map((s) => join(SKILLS, s)), '--from-template', '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  const results = Array.isArray(parsed) ? parsed : parsed.results ?? [parsed]
  assert.equal(results.length, MY_SKILLS.length)
  for (const res of results) {
    assert.deepEqual(res.problems, [], res.name)
    assert.deepEqual(res.warnings, [], res.name)
    assert.ok(MY_SKILLS.includes(res.name), res.name)
    assert.ok(existsSync(join(out, `${res.name}.zip`)), res.name)
  }
})
