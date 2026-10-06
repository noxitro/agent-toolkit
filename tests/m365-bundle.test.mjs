import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { formatBundle, parseAuditSummary, parseBundle, unsafePathReason } from '../shared/skills/m365-skill-pack/scripts/lib/bundle.mjs'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const TASK = '# TASK demo-task\n\n## Goal\n\nDo it.\n\n## Scope\n\n- src/**\n\n## Acceptance\n\n- AC-1: compiles\n\n## Max rounds\n\n2\n'

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'm365repo-'))
  const files = {
    'src/app.py': 'def f():\n    return "```"\n',
    'src/noeol.txt': 'no newline at end',
    'src/crlf.txt': 'one\r\ntwo\r\n',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    'CLAUDE.md': '# conventions\n',
    '.env': 'SECRET=1\n',
    'node_modules/x/index.js': 'x\n',
  }
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), data)
  }
  mkdirSync(join(repo, '.m365'))
  writeFileSync(join(repo, '.m365/TASK.md'), TASK)
  return repo
}

const run = (script, args, cwd) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })

test('path model: rejects escapes', () => {
  for (const p of ['../x', 'C:/x', '/etc/x', 'a\\b', '.git/config', 'a//b', './a', '']) assert.ok(unsafePathReason(p), p)
  assert.equal(unsafePathReason('src/app.py'), null)
})

test('markdown bundle: round trip of awkward content', () => {
  const files = [
    { path: 'src/app.py', data: Buffer.from('x = "```"\n````\n') },
    { path: 'src/noeol.txt', data: Buffer.from('no newline') },
    { path: 'src/crlf.txt', data: Buffer.from('a\r\nb\r\n') },
    { path: 'src/empty.txt', data: Buffer.alloc(0) },
  ]
  const text = formatBundle({ task: 't', kind: 'output', round: 1, files, deletes: ['old.txt'], skipped: [{ path: 'p.png', reason: 'binary' }] })
  const b = parseBundle(text)
  assert.equal(b.header.kind, 'output')
  assert.deepEqual(b.files.map((f) => f.content), ['x = "```"\n````\n', 'no newline', 'a\nb\n', ''])
  assert.deepEqual(b.deletes, ['old.txt'])
  assert.deepEqual(b.skipped, [{ path: 'p.png', reason: 'binary' }])
  assert.throws(() => parseBundle('# nope\n'), /not a bundle/)
  assert.throws(() => parseBundle('# m365-bundle v1\n\n### FILE ../x\n```\n```\n'), /unsafe path/)
})

test('make-input.mjs: zip of the whole repo with exclusions and conventions', () => {
  const repo = fixture()
  const r = run('make-input.mjs', ['--task', join(repo, '.m365/TASK.md'), '--repo', repo, '--out', join(repo, '.m365/out'), '--quiet'], repo)
  assert.equal(r.status, 0, r.stderr)
  const zipPath = r.stdout.trim()
  assert.ok(zipPath.endsWith('in-demo-task.zip'))
  const names = readZip(readFileSync(zipPath)).map((e) => e.name).sort()
  assert.deepEqual(names, ['CLAUDE.md', '_m365/CONVENTIONS/CLAUDE.md', '_m365/TASK.md', 'assets/logo.png', 'src/app.py', 'src/crlf.txt', 'src/noeol.txt'])
  const crlf = readZip(readFileSync(zipPath)).find((e) => e.name === 'src/crlf.txt')
  assert.equal(crlf.data.toString(), 'one\r\ntwo\r\n', 'zip keeps bytes')
})

test('make-input.mjs: markdown format skips binaries and restricts to paths', () => {
  const repo = fixture()
  const r = run('make-input.mjs', ['--task', join(repo, '.m365/TASK.md'), '--repo', repo, '--out', join(repo, '.m365/out'), '--format', 'md', '--quiet', 'src'], repo)
  assert.equal(r.status, 0, r.stderr)
  const b = parseBundle(readFileSync(r.stdout.trim(), 'utf8'))
  assert.deepEqual(b.files.map((f) => f.path), ['src/app.py', 'src/crlf.txt', 'src/noeol.txt', '_m365/TASK.md', '_m365/CONVENTIONS/CLAUDE.md'])
  assert.equal(b.files.find((f) => f.path === 'src/crlf.txt').content, 'one\ntwo\n')
})

const AUDIT_PASS = '# AUDIT\n\n```json\n{"schema":"m365-audit/1","task":"demo-task","verdict":"PASS","final_round":1,"max_rounds":2,"rounds":[{"round":1,"verdict":"PASS","checks":[{"id":"syntax","status":"PASS"},{"id":"AC-1","status":"PASS"}]}]}\n```\n\n## Round 1\n\nok\n'
const AUDIT_FAIL = AUDIT_PASS.replace('"verdict":"PASS","final_round"', '"verdict":"FAIL","final_round"')

test('unpack-output.mjs: applies a zip, routes _m365 to reports, keeps CRLF, deletes, exit codes', () => {
  const repo = fixture()
  const out = join(repo, '.m365/out')
  mkdirSync(out, { recursive: true })
  const zip = writeZip([
    { name: 'src/app.py', data: Buffer.from('def f():\n    return 1\n') },
    { name: 'src/new.py', data: Buffer.from('x = 1\n') },
    { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT_FAIL) },
    { name: '_m365/TASK.md', data: Buffer.from(TASK) },
    { name: '_m365/DELETED.txt', data: Buffer.from('src/noeol.txt\n') },
  ])
  const zipPath = join(out, 'out-demo-task-r1.zip')
  writeFileSync(zipPath, zip)
  const dry = run('unpack-output.mjs', [zipPath, '--repo', repo, '--dry-run', '--json'], repo)
  assert.equal(dry.status, 2, dry.stderr)
  assert.ok(existsSync(join(repo, 'src/noeol.txt')), 'dry run deletes nothing')
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo, '--json'], repo)
  assert.equal(r.status, 2, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.modified, ['src/app.py'])
  assert.deepEqual(j.added, ['src/new.py'])
  assert.deepEqual(j.deleted, ['src/noeol.txt'])
  assert.equal(j.verdict, 'FAIL')
  assert.ok(existsSync(join(repo, '.m365/demo-task/reports/AUDIT.md')))
  assert.ok(!existsSync(join(repo, '_m365')), 'protocol files never land in the repo')
  assert.ok(!existsSync(join(repo, 'src/noeol.txt')))

  const md = formatBundle({ task: 'demo-task', kind: 'output', round: 1, files: [{ path: 'src/crlf.txt', data: Buffer.from('one\nthree\n') }, { path: '_m365/AUDIT.md', data: Buffer.from(AUDIT_PASS) }] })
  const mdPath = join(out, 'out-demo-task-r1.md')
  writeFileSync(mdPath, md)
  const r2 = run('unpack-output.mjs', [mdPath, '--repo', repo], repo)
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
  assert.equal(readFileSync(join(repo, 'src/crlf.txt'), 'utf8'), 'one\r\nthree\r\n', 'existing CRLF style kept')

  const bad = writeZip([{ name: 'src/x.py', data: Buffer.alloc(0) }])
  const badPath = join(out, 'bad.zip')
  writeFileSync(badPath, bad)
  const r3 = run('unpack-output.mjs', [badPath, '--repo', repo], repo)
  assert.equal(r3.status, 1, 'no AUDIT.md -> exit 1')
})

test('unpack-output.mjs: refuses path escapes inside a zip', () => {
  const repo = fixture()
  const zipPath = join(repo, 'evil.zip')
  writeFileSync(zipPath, writeZip([{ name: '../evil.txt', data: Buffer.from('x') }]))
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo], repo)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unsafe path/)
  assert.ok(!existsSync(join(repo, '..', 'evil.txt')))
})

test('audit summary parser', () => {
  assert.equal(parseAuditSummary(AUDIT_PASS).summary.verdict, 'PASS')
  assert.ok(parseAuditSummary('# AUDIT\nno block').error)
  assert.ok(parseAuditSummary('# AUDIT\n```json\n{"schema":"x"}\n```').error)
  assert.ok(parseAuditSummary('nope').error)
})

test('markdown bundle: a file holding only a newline round-trips', () => {
  const text = formatBundle({ task: 't', kind: 'input', files: [{ path: 'nl.txt', data: Buffer.from('\n') }, { path: 'empty.txt', data: Buffer.alloc(0) }] })
  assert.deepEqual(parseBundle(text).files.map((f) => f.content), ['\n', ''])
})
