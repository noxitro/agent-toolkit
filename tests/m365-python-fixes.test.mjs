// Regression tests for the review findings fixed in the sandbox scripts
// (audit_checks.py, run_round.py, bundle_io.py). Bundles are written by hand or with
// Python's zipfile so that these tests do not depend on the local Node bundle code.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(ROOT, 'shared/skills/m365-skill-pack/m365/skills')
const BUNDLE_IO = join(SKILLS, 'common/scripts/bundle_io.py')
const AUDIT = join(SKILLS, 'audit/scripts/audit_checks.py')
const ROUND = join(SKILLS, 'implement/scripts/run_round.py')

function findPython() {
  for (const cand of [['python'], ['python3'], ['py', '-3']]) {
    const r = spawnSync(cand[0], [...cand.slice(1), '--version'], { encoding: 'utf8' })
    if (!r.error && r.status === 0) return cand
  }
  return null
}
const PY = findPython()
const py = (args) => spawnSync(PY[0], [...PY.slice(1), ...args], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
const ok = (r, what) => {
  assert.equal(r.status, 0, `${what}\n${r.stdout}${r.stderr}`)
  return r
}

const TASK = '# TASK fix\n\n## Goal\n\nx\n\n## Scope\n\n- src/**\n\n## Acceptance\n\n- AC-1: y\n'

/** A Markdown bundle from {path: text}; extra lines (### DELETE, ## Skipped) go last. */
function mdBundle(files, { kind = 'input', extra = [] } = {}) {
  const out = ['# m365-bundle v1', '- task: fix', `- kind: ${kind}`, '- round: 0', `- files: ${Object.keys(files).length}`, '', '## Files', '']
  for (const [path, text] of Object.entries(files)) {
    out.push(`### FILE ${path}`, '```', text.replace(/\n$/, ''), '```', '')
  }
  return out.concat(extra, ['']).join('\n')
}

/** A ZIP of {path: string|Buffer}, written by Python's zipfile. */
function zipBundle(zipPath, files) {
  const spec = Object.entries(files).map(([name, data]) => [name, Buffer.from(data).toString('base64')])
  const src = 'import base64,json,sys,zipfile\n' +
    'with zipfile.ZipFile(sys.argv[1], "w") as z:\n' +
    '    for n, d in json.loads(sys.argv[2]):\n' +
    '        z.writestr(n, base64.b64decode(d))\n'
  ok(py(['-I', '-c', src, zipPath, JSON.stringify(spec)]), 'write zip')
  return zipPath
}

/** Unpack an input bundle of {path: text} (plus TASK.md) into a fresh working directory. */
function workdir(prefix, files, task = TASK) {
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  const bundle = join(tmp, 'in.md')
  writeFileSync(bundle, mdBundle({ ...files, '_m365/TASK.md': task }))
  const work = join(tmp, 'work')
  ok(py([BUNDLE_IO, 'unpack', bundle, work]), 'unpack input')
  return { tmp, work }
}

const checks = (work, extra = []) => {
  const r = ok(py([AUDIT, 'check', work, ...extra]), 'audit check')
  return Object.fromEntries(JSON.parse(r.stdout).checks.map((c) => [c.id, c]))
}

test('audit_checks: TASK.md list variants parse; an unreadable Scope or Acceptance is an error', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const variants = '# TASK fix\n\n## Scope\n\n1. src/**\n2) `docs/`\n\n## Acceptance criteria\n\n' +
    '1. **AC-1**: bold id\n- AC-2 - dash\n- **AC-3:** colon inside bold\n- AC-4 \u2014 em dash\n'
  const { work } = workdir('m365fix-task-', { 'src/a.py': 'x = 1\n', 'other.txt': 'o\n' }, variants)
  writeFileSync(join(work, 'src/a.py'), 'x = 2\n')
  const r = JSON.parse(ok(py([AUDIT, 'check', work]), 'check').stdout)
  assert.deepEqual(r.acceptance.map((a) => a.id), ['AC-1', 'AC-2', 'AC-3', 'AC-4'])
  assert.equal(r.checks.find((c) => c.id === 'scope').status, 'PASS')
  writeFileSync(join(work, 'other.txt'), 'changed\n')
  assert.match(checks(work).scope.detail, /outside scope: other\.txt/)

  const bad = {
    scope: '# TASK fix\n\n## Scope\n\nOnly src/** may change.\n\n## Acceptance\n\n- AC-1: y\n',
    acceptance: '# TASK fix\n\n## Scope\n\n- src/**\n\n## Acceptance\n\nAC-1 means the tests pass.\n',
  }
  for (const [name, task] of Object.entries(bad)) {
    const w = workdir(`m365fix-bad${name}-`, { 'src/a.py': 'x = 1\n' }, task).work
    writeFileSync(join(w, 'src/a.py'), 'x = 2\n')
    const c = py([AUDIT, 'check', w])
    assert.equal(c.status, 1, `${name}: check must fail\n${c.stdout}${c.stderr}`)
    assert.match(c.stderr, new RegExp(`## ${name[0].toUpperCase()}${name.slice(1)}" has text but no`))
    const rep = py([AUDIT, 'report', w, '--round', '1'])
    assert.notEqual(rep.status, 0, `${name}: report must not PASS silently`)
    assert.ok(!existsSync(join(w, '_m365/AUDIT.md')), `${name}: no AUDIT.md`)
  }
})

test('audit_checks syntax: compile-time errors and deep nesting FAIL instead of passing or crashing', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { work } = workdir('m365fix-syntax-', { 'src/keep.py': 'x = 1\n' })
  const cases = {
    'src/ret.py': 'return 1\n',
    'src/brk.py': 'break\n',
    'src/glob.py': 'def f():\n    x = 1\n    global x\n',
    'src/deep.py': `x = ${'('.repeat(100000)}1${')'.repeat(100000)}\n`,
  }
  for (const [p, text] of Object.entries(cases)) writeFileSync(join(work, p), text)
  const syntax = checks(work).syntax
  assert.equal(syntax.status, 'FAIL')
  assert.match(syntax.detail, /src\/ret\.py:1: 'return' outside function/)
  assert.match(syntax.detail, /src\/brk\.py:1: 'break' outside loop/)
  assert.match(syntax.detail, /src\/glob\.py:3: .*global/)
  assert.match(syntax.detail, /src\/deep\.py:\d+: /)
})

test('bundle_io unpack: a file/directory clash (a and a/b) aborts before anything is written', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-clash-'))
  const zip = zipBundle(join(tmp, 'clash.zip'), { 'aaa.txt': 'first\n', a: 'file\n', 'a/b': 'nested\n', '_m365/TASK.md': TASK })
  const md = join(tmp, 'clash.md')
  writeFileSync(md, mdBundle({ 'aaa.txt': 'first\n', a: 'file\n', 'a/b': 'nested\n' }))
  for (const bundle of [zip, md]) {
    const work = join(tmp, `${bundle.endsWith('.zip') ? 'zip' : 'md'}-work`)
    const r = py([BUNDLE_IO, 'unpack', bundle, work])
    assert.equal(r.status, 1, `${bundle}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /a is both a file and the directory of a\/b/)
    assert.ok(!existsSync(work), 'nothing written')
  }
  // The same clash against a file already in the working directory.
  const work = join(tmp, 'existing')
  mkdirSync(work)
  writeFileSync(join(work, 'a'), 'already a file\n')
  const ok2 = zipBundle(join(tmp, 'ok.zip'), { 'aaa.txt': 'first\n', 'a/b': 'nested\n', '_m365/TASK.md': TASK })
  const r = py([BUNDLE_IO, 'unpack', ok2, work])
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /exists in .* and is not a directory/)
  assert.deepEqual(readdirSync(work), ['a'], 'nothing else written')
})

test('bundle_io: a deleted file that becomes a directory (docs -> docs/index.md) round-trips', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { tmp, work } = workdir('m365fix-file2dir-', { docs: 'was a file\n', 'src/a.py': 'x = 1\n' })
  rmSync(join(work, 'docs'))
  mkdirSync(join(work, 'docs'))
  writeFileSync(join(work, 'docs/index.md'), '# now a directory\n')
  for (const ext of ['zip', 'md']) {
    const out = join(tmp, `out.${ext}`)
    ok(py([BUNDLE_IO, 'pack', work, out]), `pack ${ext}`)
    // The deletion is only recorded, so it does not clash with the delivered docs/index.md.
    const audit = join(tmp, `audit-${ext}`)
    ok(py([BUNDLE_IO, 'unpack', out, audit]), `unpack ${ext}`)
    assert.equal(readFileSync(join(audit, 'docs/index.md'), 'utf8'), '# now a directory\n')
    assert.match(readFileSync(join(audit, '_m365/DELETED.txt'), 'utf8'), /^docs$/m)
  }
})

test('cache directories (.pytest_cache, node_modules, ...) are never walked, hashed or packed', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { tmp, work } = workdir('m365fix-junk-', { 'src/a.py': 'x = 1\n', 'src/.mypy_cache/old.json': '{}\n' })
  for (const d of ['.pytest_cache', 'node_modules', 'src/.mypy_cache', 'src/__pycache__']) {
    mkdirSync(join(work, d), { recursive: true })
    writeFileSync(join(work, d, 'junk.txt'), 'cache\n')
  }
  writeFileSync(join(work, 'src/a.py'), 'x = 2\n')
  const st = JSON.parse(ok(py([BUNDLE_IO, 'status', work]), 'status').stdout)
  assert.deepEqual(st, { added: [], modified: ['src/a.py'], deleted: [], unchanged: 0 })
  const c = checks(work)
  assert.equal(c.scope.status, 'PASS', c.scope.detail)
  assert.match(c.files.detail, /^1 changed/)
  const out = join(tmp, 'out.md')
  ok(py([ROUND, 'start', work]), 'start')
  ok(py([ROUND, 'finish', work, '--verdict', 'FAIL', '--notes', 'n']), 'finish')
  assert.doesNotMatch(readFileSync(join(work, '_m365/ROUNDS.md'), 'utf8'), /junk|cache/)
  ok(py([BUNDLE_IO, 'pack', work, out, '--full']), 'pack')
  assert.doesNotMatch(readFileSync(out, 'utf8'), /junk\.txt|_cache|node_modules/)
})

test('run_round finish: --verdict PASS needs AUDIT.md to record PASS for the round', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { work } = workdir('m365fix-finish-', { 'src/a.py': 'x = 1\n' })
  writeFileSync(join(work, 'src/a.py'), 'x = 2\n')
  ok(py([ROUND, 'start', work]), 'start')
  const r = py([ROUND, 'finish', work, '--verdict', 'PASS'])
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /needs _m365\/AUDIT\.md to record PASS for round 1/)
  ok(py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS']), 'report')
  const f = JSON.parse(ok(py([ROUND, 'finish', work, '--verdict', 'PASS']), 'finish after audit').stdout)
  assert.equal(f.next, 'stop')
  // FAIL stays allowed without an audit of the round.
  ok(py([ROUND, 'start', work]), 'start round 2')
  ok(py([ROUND, 'finish', work, '--verdict', 'FAIL', '--notes', 'no audit']), 'FAIL without audit')
})

test('audit_checks report --allow-empty lets a task that changes nothing PASS', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { work } = workdir('m365fix-empty-', { 'src/a.py': 'x = 1\n' })
  const plain = JSON.parse(ok(py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS']), 'report').stdout.match(/\{[\s\S]*\}/)[0])
  assert.equal(plain.verdict, 'FAIL')
  const allowed = ok(py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS', '--allow-empty']), 'report --allow-empty')
  assert.match(allowed.stdout, /"verdict": "PASS"/)
  const help = ok(py([AUDIT, 'report', '--help']), 'help').stdout
  assert.match(help, /--allow-empty/)
  assert.doesNotMatch(help, /default <workdir>\/_m365\/checks\.json\)/)
})

test('bundle_io: a path segment ending in " [word]" is refused (would read as header flags)', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-flag-'))
  for (const evil of ['notes [draft]', 'logs/log [noeol]', 'dir [x]/file.txt']) {
    const zip = zipBundle(join(tmp, 'f.zip'), { 'ok.txt': 'ok\n', [evil]: 'x\n', '_m365/TASK.md': TASK })
    const work = join(tmp, 'work')
    const r = py([BUNDLE_IO, 'unpack', zip, work])
    assert.equal(r.status, 1, `${evil}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /unsafe path .*reads as Markdown bundle flags/)
    assert.ok(!existsSync(work))
  }
  // A packer refuses too, instead of writing a bundle that reads back wrong.
  const { work } = workdir('m365fix-flagpack-', { 'src/a.py': 'x = 1\n' })
  writeFileSync(join(work, 'notes [draft]'), 'draft\n')
  const r = py([BUNDLE_IO, 'pack', work, join(tmp, 'out.md')])
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /notes \[draft\]/)
  // A bracket that is not at the end of a segment, or has no space before it, is fine.
  ok(py([BUNDLE_IO, 'unpack', zipBundle(join(tmp, 'fine.zip'), { 'a[1].txt': 'x\n', '[x] y.txt': 'y\n' }), join(tmp, 'fine')]), 'brackets elsewhere')
})

test('bundle_io: Windows device names and 8.3 short-name segments are refused, as in bundle.mjs', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-dev-'))
  for (const [evil, why] of [['nul.txt', /device name/], ['src/CON', /device name/], ['com1.tar.gz', /device name/], ['PROGRA~1/x.txt', /short-name/]]) {
    const work = join(tmp, 'work')
    const r = py([BUNDLE_IO, 'unpack', zipBundle(join(tmp, 'd.zip'), { 'ok.txt': 'ok\n', [evil]: 'x\n', '_m365/TASK.md': TASK }), work])
    assert.equal(r.status, 1, `${evil}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, why)
    assert.ok(!existsSync(work))
  }
  ok(py([BUNDLE_IO, 'unpack', zipBundle(join(tmp, 'fine.zip'), { 'console.txt': 'x\n', 'nul_check.py': 'y\n', 'a~b.txt': 'z\n' }), join(tmp, 'fine')]), 'names that only look close')
})

test('audit_checks json: NaN, Infinity and a BOM FAIL; JSON-with-comments files may have comments', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { work } = workdir('m365fix-json-', { 'src/a.py': 'x = 1\n' })
  mkdirSync(join(work, 'src/.vscode'), { recursive: true })
  const jsonc = '{\n  // comment with "quotes"\n  "a": "http://x/*y*/", /* block\n */ "b": [1, 2,],\n}\n'
  writeFileSync(join(work, 'src/tsconfig.build.json'), jsonc)
  writeFileSync(join(work, 'src/.vscode/settings.json'), jsonc)
  writeFileSync(join(work, 'src/conf.jsonc'), jsonc)
  let j = checks(work).json
  assert.equal(j.status, 'PASS', j.detail)
  assert.match(j.detail, /3 file\(s\)/)
  writeFileSync(join(work, 'src/nan.json'), '{"a": NaN}\n')
  writeFileSync(join(work, 'src/inf.json'), '[-Infinity]\n')
  writeFileSync(join(work, 'src/bom.json'), '\ufeff{}\n')
  writeFileSync(join(work, 'src/plain.json'), '{"a": 1, // no comments in plain JSON\n}\n')
  j = checks(work).json
  assert.equal(j.status, 'FAIL')
  assert.match(j.detail, /src\/nan\.json: NaN is not valid JSON/)
  assert.match(j.detail, /src\/inf\.json: -Infinity is not valid JSON/)
  assert.match(j.detail, /src\/bom\.json: starts with a UTF-8 byte order mark/)
  assert.match(j.detail, /src\/plain\.json: /)
  assert.doesNotMatch(j.detail, /tsconfig|settings|conf\.jsonc/)
})

test('bundle_io unpack: an output ZIP that carries only a manifest is detected as output', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-marker-'))
  const manifest = JSON.stringify({ schema: 'm365-manifest/1', task: 'fix', files: { 'src/a.py': '0'.repeat(64) } })
  const zip = zipBundle(join(tmp, 'out.zip'), { 'src/a.py': 'x = 2\n', '_m365/TASK.md': TASK, '_m365/manifest.json': manifest })
  const work = join(tmp, 'work')
  const r = ok(py([BUNDLE_IO, 'unpack', zip, work]), 'unpack')
  assert.match(r.stdout, /kind: output/)
  assert.match(r.stdout, /manifest: carried from the input/)
  const st = JSON.parse(ok(py([BUNDLE_IO, 'status', work]), 'status').stdout)
  assert.deepEqual(st.modified, ['src/a.py'])
})

test('Markdown pack --full: a skipped binary file does not read as deleted after unpack', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-skip-'))
  const task = TASK.replace('- src/**', '- src/a.py')
  const zip = zipBundle(join(tmp, 'in.zip'), { 'src/a.py': 'x = 1\n', 'logo.png': Buffer.from([0x89, 0x50, 0, 1]), '_m365/TASK.md': task })
  const work = join(tmp, 'work')
  ok(py([BUNDLE_IO, 'unpack', zip, work]), 'unpack input')
  writeFileSync(join(work, 'src/a.py'), 'x = 2\n')
  const out = join(tmp, 'out.md')
  ok(py([BUNDLE_IO, 'pack', work, out, '--full']), 'pack --full md')
  assert.match(readFileSync(out, 'utf8'), /## Skipped\n\n- logo\.png \(binary\)/)
  const auditWork = join(tmp, 'audit')
  const un = ok(py([BUNDLE_IO, 'unpack', out, auditWork]), 'unpack output')
  assert.match(un.stdout, /not carried, left out of the manifest .*logo\.png/)
  const st = JSON.parse(ok(py([BUNDLE_IO, 'status', auditWork]), 'status').stdout)
  assert.deepEqual(st.deleted, [])
  assert.deepEqual(st.modified, ['src/a.py'])
  const c = checks(auditWork)
  assert.equal(c.scope.status, 'PASS', c.scope.detail)
})

test('bundle_io unpack: a Markdown "### DELETE _m365/..." is refused like the ZIP deletion list', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-mddel-'))
  const md = join(tmp, 'out.md')
  writeFileSync(md, mdBundle({ 'src/a.py': 'x = 1\n', '_m365/TASK.md': TASK }, { kind: 'output', extra: ['### DELETE _m365/manifest.json', ''] }))
  const work = join(tmp, 'work')
  const r = py([BUNDLE_IO, 'unpack', md, work])
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /deletes a protocol path: _m365\/manifest\.json/)
  assert.ok(!existsSync(work))
})

test('audit_checks forbidden: the whole changed file is checked, as the docs say', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const task = `${TASK}\n## Forbidden patterns\n\n- print\\(\n`
  const { work } = workdir('m365fix-forbid-', { 'src/a.py': 'print("old")\nx = 1\n' }, task)
  writeFileSync(join(work, 'src/a.py'), 'print("old")\nx = 2\n')
  const f = checks(work).forbidden
  assert.equal(f.status, 'FAIL')
  assert.match(f.detail, /src\/a\.py:1: print\\\(/)
  const docs = ['references/loop-protocol.md', 'm365/skills/audit/SKILL.template.md', 'm365/skills/implement/SKILL.template.md']
  for (const d of docs) {
    assert.match(readFileSync(join(ROOT, 'shared/skills/m365-skill-pack', d), 'utf8'), /lines\s+that\s+were\s+(already\s+)?there\s+before/, d)
  }
})

test('bundle_io unpack: delivered paths that fold together (case, NFC) are refused, as unpack-output.mjs does', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-fold-'))
  const nfc = 'café.md'
  const nfd = 'café.md'
  const cases = [
    [zipBundle(join(tmp, 'case.zip'), { 'a.md': '1\n', 'A.md': '2\n', '_m365/TASK.md': TASK }), /a\.md and A\.md differ only in letter case or Unicode normalisation/],
    [zipBundle(join(tmp, 'nfc.zip'), { [nfc]: '1\n', [nfd]: '2\n' }), /differ only in letter case or Unicode normalisation/],
    [join(tmp, 'dir.md'), /Docs is delivered as a file but is also the directory of docs\/x\.md/],
  ]
  writeFileSync(cases[2][0], mdBundle({ Docs: 'file\n', 'docs/x.md': 'nested\n' }))
  for (const [bundle, want] of cases) {
    const work = join(tmp, 'work')
    const r = py([BUNDLE_IO, 'unpack', bundle, work])
    assert.equal(r.status, 1, `${bundle}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, want)
    assert.ok(!existsSync(work), 'nothing written')
  }
  // A deletion that folds to a delivered path is a case-only rename, not a collision.
  const rename = zipBundle(join(tmp, 'rename.zip'), { 'README.md': 'new\n', '_m365/DELETED.txt': 'Readme.md\n', '_m365/TASK.md': TASK })
  ok(py([BUNDLE_IO, 'unpack', rename, join(tmp, 'renamed')]), 'case-only rename')
})

test('bundle_io pack: names that fold together are refused before any bundle is written', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const { tmp, work } = workdir('m365fix-foldpack-', { 'src/a.py': 'x = 1\n', 'Readme.md': 'r\n' })
  writeFileSync(join(work, 'src/A.py'), 'x = 2\n')
  for (const out of ['out.zip', 'out.md']) {
    const r = py([BUNDLE_IO, 'pack', work, join(tmp, out), '--full'])
    assert.equal(r.status, 1, `${out}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /src\/A\.py and src\/a\.py differ only in letter case/)
    assert.ok(!existsSync(join(tmp, out)), `${out} not written`)
  }
  // A case-only rename (old spelling deleted) packs fine.
  const { tmp: tmp2, work: work2 } = workdir('m365fix-foldren-', { 'Readme.md': 'r\n' })
  writeFileSync(join(work2, 'README.md'), 'r\n')
  ok(py(['-I', '-c', 'import os,sys; os.remove(sys.argv[1])', join(work2, 'Readme.md')]), 'remove')
  ok(py([BUNDLE_IO, 'pack', work2, join(tmp2, 'out.zip')]), 'pack a case-only rename')
})

test('bundle_io: a case variant of the reserved _m365/ prefix is refused on unpack and pack', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365fix-alias-'))
  for (const files of [{ 'ok.txt': 'ok\n', '_M365/AUDIT.md': '# AUDIT\n' }, { 'ok.txt': 'ok\n', '_M365': 'x\n' }]) {
    const work = join(tmp, 'work')
    const r = py([BUNDLE_IO, 'unpack', zipBundle(join(tmp, 'a.zip'), files), work])
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /unsafe path "_M365.*_m365/)
    assert.ok(!existsSync(work))
  }
  const md = join(tmp, 'del.md')
  writeFileSync(md, mdBundle({ 'ok.txt': 'ok\n' }, { kind: 'output', extra: ['### DELETE _M365/manifest.json', ''] }))
  const del = py([BUNDLE_IO, 'unpack', md, join(tmp, 'work')])
  assert.equal(del.status, 1, `${del.stdout}${del.stderr}`)
  assert.match(del.stderr, /_M365\/manifest\.json/)
  // A sandbox that grew _M365/ beside _m365/ cannot pack it into a bundle the local side would refuse.
  const { tmp: t2, work } = workdir('m365fix-aliaspack-', { 'src/a.py': 'x = 1\n' })
  mkdirSync(join(work, '_M365'))
  writeFileSync(join(work, '_M365/AUDIT.md'), '# AUDIT\n')
  for (const out of ['out.zip', 'out.md']) {
    const r = py([BUNDLE_IO, 'pack', work, join(t2, out)])
    assert.equal(r.status, 1, `${out}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /_M365\/AUDIT\.md/)
    assert.ok(!existsSync(join(t2, out)), `${out} not written`)
  }
})
