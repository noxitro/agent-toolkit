// The data skills under m365-org-skills/skills (table-summary, expense-check, data-normalize,
// log-summary): each is packed exactly as for Agent Builder (--from-template merges common/),
// unpacked into a temp directory, and its script is run there under `python -I` so that a
// hidden dependency on the repository layout or on site-packages would fail the test.
// Inputs come from tests/fixtures/m365-org/make_fixtures.py (cp932 CSV, XLSX, zip, ...).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACK = join(ROOT, 'shared/skills/m365-skill-pack/scripts/pack-skill.mjs')
const SKILLS_DIR = join(ROOT, 'm365-org-skills/skills')
const FIXTURES = join(ROOT, 'tests/fixtures/m365-org/make_fixtures.py')
const SKILLS = ['table-summary', 'expense-check', 'data-normalize', 'log-summary']

function findPython() {
  for (const cand of [['python3'], ['python'], ['py', '-3']]) {
    if (spawnSync(cand[0], [...cand.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']).status === 0) return cand
  }
  return null
}
const PY = findPython()

let env = null
function setup() {
  if (env) return env
  const base = mkdtempSync(join(tmpdir(), 'm365org-'))
  const zips = join(base, 'zips')
  const packed = spawnSync(process.execPath, [PACK, ...SKILLS.map((s) => join(SKILLS_DIR, s)), '--from-template', '--out', zips, '--json'], { encoding: 'utf8' })
  const unzip = 'import sys, zipfile\nfor z, d in zip(sys.argv[1::2], sys.argv[2::2]):\n    zipfile.ZipFile(z).extractall(d)'
  const pairs = SKILLS.flatMap((s) => [join(zips, `${s}.zip`), join(base, 'stage', s)])
  if (packed.status === 0) {
    const r = spawnSync(PY[0], [...PY.slice(1), '-I', '-c', unzip, ...pairs], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  const data = join(base, 'data')
  const fx = spawnSync(PY[0], [...PY.slice(1), '-I', FIXTURES, data], { encoding: 'utf8' })
  assert.equal(fx.status, 0, fx.stderr)
  env = { base, packed, data, stage: (s) => join(base, 'stage', s) }
  return env
}

/** Run a skill script from the unpacked package, cwd = the fixture directory. */
function run(skill, script, args, cwd) {
  const e = setup()
  const r = spawnSync(PY[0], [...PY.slice(1), '-I', join(e.stage(skill), 'scripts', script), ...args], {
    cwd: cwd || e.data, encoding: 'utf8',
  })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

function csv(path) {
  const text = readFileSync(path, 'utf8')
  assert.equal(text.charCodeAt(0), 0xfeff, `${path} should start with a UTF-8 BOM for Excel`)
  return text.slice(1).trim().split(/\r?\n/)
}

const outDir = () => mkdtempSync(join(setup().base, 'out-'))
const skipNoPy = (t) => (PY ? false : (t.skip('no python interpreter on PATH'), true))

test('org data skills: every skill packs cleanly with --from-template and carries the shared helpers', (t) => {
  if (skipNoPy(t)) return
  const { packed, stage } = setup()
  assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  const summary = JSON.parse(packed.stdout)
  assert.equal(summary.ok, true)
  for (const r of summary.results) {
    assert.deepEqual([r.problems, r.warnings], [[], []], r.name)
    assert.ok(SKILLS.includes(r.name), r.name)
  }
  for (const s of SKILLS) {
    for (const f of ['SKILL.md', 'scripts/locate_inputs.py', 'scripts/tabular_io.py']) assert.ok(existsSync(join(stage(s), f)), `${s}/${f}`)
    const md = readFileSync(join(stage(s), 'SKILL.md'), 'utf8')
    assert.match(md, new RegExp(`^---\\nname: ${s}\\n`))
    const desc = /\ndescription: (.*)\n/.exec(md)[1]
    assert.ok(desc.length <= 1000, `${s}: description is ${desc.length} chars`)
    assert.ok(md.length < 6000, `${s}: SKILL.md is ${md.length} chars`)
    assert.match(md, /インターネット/, `${s}: says that the sandbox is offline`)
  }
})

test('org data skills: scripts parse as Python 3.8 and avoid 3.9+ only APIs', (t) => {
  if (skipNoPy(t)) return
  const { stage } = setup()
  const files = SKILLS.flatMap((s) => readdirSync(join(stage(s), 'scripts')).filter((f) => f.endsWith('.py')).map((f) => join(stage(s), 'scripts', f)))
  const code = 'import ast, sys\nfor p in sys.argv[1:]:\n    ast.parse(open(p, encoding="utf-8").read(), p, feature_version=(3, 8))'
  const r = spawnSync(PY[0], [...PY.slice(1), '-I', '-c', code, ...files], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const banned = /\.removeprefix\(|\.removesuffix\(|\bzoneinfo\b|math\.lcm|functools\.cache\b|BooleanOptionalAction|\bstr \| None|:\s*(list|dict|tuple|set)\[/
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), banned, f)
})

test('table-summary: cp932 CSV is detected and yen / full-width / triangle numbers are summed', (t) => {
  if (skipNoPy(t)) return
  const dir = outDir()
  const r = run('table-summary', 'table_summary.py', ['sales_sjis.csv', '--group-by', '部署', '--sum', '金額', '--count', '--out', join(dir, 'p.csv')])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /文字コード cp932, 区切り カンマ/)
  assert.match(r.out, /列「金額」の 1 件は数値として読めず/)
  assert.deepEqual(csv(join(dir, 'p.csv')), ['部署,件数,合計(金額)', '営業,2,1500', '総務,2,400', '開発,1,0'])
})

test('table-summary: UTF-8 BOM TSV, profile and filters', (t) => {
  if (skipNoPy(t)) return
  const tsv = run('table-summary', 'table_summary.py', ['sales_bom.tsv', '--profile'])
  assert.equal(tsv.status, 0, tsv.err)
  assert.match(tsv.out, /文字コード utf-8-sig, 区切り タブ/)
  assert.match(tsv.out, /\| 売上 \| 数値 \| 3 \| 0 \| 3 \| 50 \| 250 \| 400 \| 133\.3333 \|/)
  const f = run('table-summary', 'table_summary.py', ['sales_sjis.csv', '--filter', '金額>=400'])
  assert.equal(f.status, 0, f.err)
  assert.match(f.out, /金額>=400 → 2 行/) // 1,200 and 500円; "未定" is not a number and does not match
  const d = run('table-summary', 'table_summary.py', ['sales_sjis.csv', '--filter', '日付>=2026-04-03', '--filter', '部署~総'])
  assert.match(d.out, /→ 2 行/)
})

test('table-summary: XLSX shared / rich / inline strings, phonetic guide, dates and sheets', (t) => {
  if (skipNoPy(t)) return
  const dir = outDir()
  const sheets = run('table-summary', 'table_summary.py', ['book.xlsx', '--list-sheets'])
  assert.equal(sheets.out.trim().split(/\r?\n/).join('|'), '1\t売上|2\tメモ')
  const r = run('table-summary', 'table_summary.py', ['book.xlsx', '--filter', '部署=営業部', '--out', join(dir, 'rows.csv')])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /見出し 3 行目/) // the title row 1 and the empty row 2 are skipped
  const rows = csv(join(dir, 'rows.csv'))
  assert.equal(rows[0], '元の行,部署,担当,日付,金額,確認,受付,時刻')
  assert.equal(rows[1], '4,営業部,山田,2026-04-01,1200,TRUE,2026-04-01 12:00:00,18:00:00')
  assert.equal(rows[2], '5,営業部,佐藤,2026-04-15,800.25,FALSE,,') // rPh "サトウ" is not part of the text
  const g = run('table-summary', 'table_summary.py', ['book.xlsx', '--group-by', '部署', '--sum', '金額', '--out', join(dir, 'g.csv')])
  assert.deepEqual(csv(join(dir, 'g.csv')), ['部署,合計(金額)', '総務部,3000', '営業部,2000.25'])
  run('table-summary', 'table_summary.py', ['book.xlsx', '--group-by', '日付:月', '--sum', '金額', '--count', '--out', join(dir, 'm.csv')])
  assert.deepEqual(csv(join(dir, 'm.csv')), ['日付(月),件数,合計(金額)', '2026-04,2,2000.25', '2026-05,1,3000'])
  const memo = run('table-summary', 'table_summary.py', ['book.xlsx', '--sheet', '2'])
  assert.match(memo.out, /シート「メモ」/)
})

test('table-summary: user errors are Japanese messages with exit 2, and the input is never overwritten', (t) => {
  if (skipNoPy(t)) return
  const { data } = setup()
  for (const args of [['sales_sjis.csv', '--group-by', '部門'], ['book.xlsx', '--sheet', '請求'], ['nothing.csv'], ['sales_sjis.csv', '--filter', 'あいう']]) {
    const r = run('table-summary', 'table_summary.py', args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.err, /^エラー: /)
    assert.doesNotMatch(r.err, /Traceback/)
  }
  const before = readFileSync(join(data, 'sales_sjis.csv'))
  const r = run('table-summary', 'table_summary.py', ['sales_sjis.csv', '--profile', '--out', 'sales_sjis.csv'])
  assert.equal(r.status, 2)
  assert.match(r.err, /入力ファイルと同じ/)
  assert.deepEqual(readFileSync(join(data, 'sales_sjis.csv')), before)
})

test('expense-check: limit, forbidden word, duplicate, missing value, age and future date', (t) => {
  if (skipNoPy(t)) return
  const dir = outDir()
  const out = join(dir, 'v.csv')
  const r = run('expense-check', 'expense_check.py', ['expenses.csv', '--as-of', '2026-09-30', '--out', out])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /対象 8 行のうち、エラーあり 5 行、注意のみ 2 行、指摘なし 1 行/)
  const found = csv(out).slice(1).map((l) => l.split(',').slice(0, 3).join(' '))
  assert.deepEqual(found, [
    '2 エラー 上限超過',
    '3 注意 重複の疑い',
    '4 注意 重複の疑い',
    '5 エラー 申請期限切れ',
    '6 エラー 禁止語を含む',
    '7 エラー 必須項目が空欄',
    '8 エラー 未来の日付',
  ])
  assert.match(r.out, /交際費 の上限 20,000 円を 5,000 円超過/)
})

test('expense-check: a missing required column is reported, and broken rules are a Japanese error', (t) => {
  if (skipNoPy(t)) return
  const dir = outDir()
  const r = run('expense-check', 'expense_check.py', ['expenses_nocol.csv', '--as-of', '2026-09-30', '--out', join(dir, 'v.csv')])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /必須列がない: 列「支払先」/)
  const bad = run('expense-check', 'expense_check.py', ['expenses.csv', '--rules', 'sales_bom.tsv'])
  assert.equal(bad.status, 2)
  assert.match(bad.err, /JSON が不正/)
})

test('data-normalize: width, kana, spaces, phone, postal and e-mail with a change log and duplicates', (t) => {
  if (skipNoPy(t)) return
  const { data } = setup()
  const dir = outDir()
  const before = readFileSync(join(data, 'roster.csv'))
  const r = run('data-normalize', 'data_normalize.py', ['roster.csv', '--out-dir', dir])
  assert.equal(r.status, 0, r.err)
  assert.deepEqual(readFileSync(join(data, 'roster.csv')), before)
  assert.deepEqual(csv(join(dir, 'roster_normalized.csv')), [
    '顧客ID,氏名,フリガナ,電話番号,郵便番号,メールアドレス',
    'A001,山田 太郎,ヤマダ タロウ,090-1234-5678,100-0001,taro.yamada@example.com',
    'A002,山田 太郎,ヤマダ タロウ,090-1234-5678,100-0001,taro.yamada@example.com',
    'A003,佐藤花子,サトウハナコ,03-1234-5678,530-0001,hanako@',
    'A004,鈴木一郎,スズキ,312345678,600001,s@example.jp',
  ])
  const changes = csv(join(dir, 'roster_changes.csv'))
  assert.equal(changes[0], '行,列,変更前,変更後,規則,種別,備考')
  assert.ok(changes.includes('2,電話番号,０９０（１２３４）５６７８,090-1234-5678,電話番号,変更,'))
  assert.ok(changes.some((l) => l.startsWith('5,電話番号,312345678,312345678,電話番号,要確認,先頭の 0')))
  assert.ok(changes.some((l) => l.startsWith('4,メールアドレス,hanako@,hanako@,メールアドレス,要確認,')))
  const dups = csv(join(dir, 'roster_duplicates.csv'))
  // rows 2 and 3 differ only in notation; after normalization their e-mail addresses match
  assert.deepEqual(dups.slice(1).map((l) => l.split(',').slice(0, 4).join(',')), [
    '1,メールアドレス,taro.yamada@example.com,2',
    '1,メールアドレス,taro.yamada@example.com,3',
  ])
  const keyed = run('data-normalize', 'data_normalize.py', ['roster.csv', '--out-dir', dir, '--dup-key', '氏名+電話番号', '--rule', '顧客ID=none'])
  assert.equal(keyed.status, 0, keyed.err)
  assert.match(keyed.out, /\| 1 \| 氏名\+電話番号 \| 山田 太郎 \/ 090-1234-5678 \| 2, 3 \|/)
  assert.ok(csv(join(dir, 'roster_normalized.csv'))[1].startsWith('Ａ００１,'), '--rule 顧客ID=none keeps the value')
})

test('log-summary: levels, templates, continuation lines, zip members in cp932', (t) => {
  if (skipNoPy(t)) return
  const dir = outDir()
  const r = run('log-summary', 'log_summary.py', ['app.log', 'logs.zip', '--year', '2026', '--out-dir', dir])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /2 ファイル、11 行、9 レコード \(日時のない続きの行 2 行/)
  assert.match(r.out, /\| ERROR \| 5 \|/)
  assert.match(r.out, /\| WARN \| 2 \|/)
  assert.match(r.out, /\| INFO \| 2 \|/)
  assert.match(r.out, /logs\.zip:batch\/batch\.log は cp932/)
  const tpl = csv(join(dir, 'log_summary_templates.csv'))
  assert.ok(tpl[1].startsWith('1,3,ERROR,[db] Connection timeout after <N> ms to <IP>,2026-10-01 09:05:12,2026-10-01 11:00:00,'), tpl[1])
  assert.ok(tpl.some((l) => l.includes(',INFO,user <UUID> logged in,')))
  assert.ok(tpl.some((l) => l.includes(',WARN,Disk usage <N>% on <PATH>,')))
  assert.ok(tpl.some((l) => l.includes(',ERROR,取込に失敗 件数=<N>,')))
  const tl = csv(join(dir, 'log_summary_timeline.csv'))
  assert.deepEqual(tl.slice(0, 2), ['時間帯,件数,ERROR+FATAL,WARN', '2026-10-01 09:00,5,3,1'])
  assert.equal(tl.length, 5) // 09:00 .. 12:00
})

test('log-summary: grep, level and period filters; a bad regex is a Japanese error', (t) => {
  if (skipNoPy(t)) return
  const dir = outDir()
  const r = run('log-summary', 'log_summary.py', ['app.log', '--level', 'ERROR', '--since', '2026-10-01 09:06', '--grep', 'timeout', '--out-dir', dir])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /集計対象: 2 レコード/)
  const bad = run('log-summary', 'log_summary.py', ['app.log', '--grep', '(', '--out-dir', dir])
  assert.equal(bad.status, 2)
  assert.match(bad.err, /^エラー: --grep の正規表現が不正/)
})

test('locate_inputs: finds an attachment in the working directory and skips the skill itself', (t) => {
  if (skipNoPy(t)) return
  const { data, stage } = setup()
  const r = spawnSync(PY[0], [...PY.slice(1), '-I', join(stage('table-summary'), 'scripts', 'locate_inputs.py'), '--ext', '.xlsx', '--max-depth', '1'], { cwd: data, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const first = r.stdout.split(/\r?\n/).find((l) => l.includes('book.xlsx'))
  assert.ok(first, r.stdout)
  assert.equal(Number(/\t(\d+) bytes/.exec(first)[1]), statSync(join(data, 'book.xlsx')).size)
  const self = spawnSync(PY[0], [...PY.slice(1), '-I', join(stage('table-summary'), 'scripts', 'locate_inputs.py'), '--ext', '.py', '--max-depth', '1'], {
    cwd: stage('table-summary'), encoding: 'utf8',
  })
  assert.doesNotMatch(self.stdout, /tabular_io\.py|table_summary\.py/)
})
