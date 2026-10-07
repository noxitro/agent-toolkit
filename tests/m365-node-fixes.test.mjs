// Regression tests for the Node-side review findings: all-or-nothing apply with file/
// directory swaps, case-only renames, excluded destinations, BOM/CR baselines, header-flag
// and Windows device names, reader limits, symlinked --repo, `..name` paths, positional
// `.`, common/ filtering and the small CLI fixes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseArgs } from '../shared/skills/m365-skill-pack/scripts/lib/args.mjs'
import { formatBundle, parseBundle, unsafePathReason } from '../shared/skills/m365-skill-pack/scripts/lib/bundle.mjs'
import { validateSkillDir } from '../shared/skills/m365-skill-pack/scripts/lib/m365-rules.mjs'
import { MAX_ENTRY_BYTES, readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const AUDIT = `# AUDIT\n\n\`\`\`json\n{"schema":"m365-audit/1","task":"demo-task","verdict":"PASS","final_round":1,"max_rounds":2,"rounds":[]}\n\`\`\`\n`
const TASK = '# TASK demo-task\n\n## Goal\n\nDo it.\n'
const run = (script, args, cwd) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })
const sha = (data) => createHash('sha256').update(data).digest('hex')

function repoWith(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'm365fix-'))
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), data)
  }
  return repo
}

/** An output ZIP; `baseline` (path -> content) becomes the carried manifest. */
function outZip(repo, entries, { baseline = null, deletes = [] } = {}) {
  const zipEntries = Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) }))
  zipEntries.push({ name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) })
  if (baseline) {
    const files = Object.fromEntries(Object.entries(baseline).map(([p, c]) => [p, sha(Buffer.from(c))]))
    zipEntries.push({ name: '_m365/manifest.json', data: Buffer.from(JSON.stringify({ schema: 'm365-manifest/1', task: 'demo-task', files })) })
  }
  if (deletes.length) zipEntries.push({ name: '_m365/DELETED.txt', data: Buffer.from(deletes.join('\n') + '\n') })
  const out = join(mkdtempSync(join(tmpdir(), 'm365fix-out-')), 'out.zip')
  writeFileSync(out, writeZip(zipEntries))
  return out
}
const unpack = (repo, zip, ...extra) => run('unpack-output.mjs', [zip, '--repo', repo, '--json', ...extra], repo)

// ------------------------------------------------------------------ item 1
test('unpack-output.mjs: a file replaced by a directory of the same name applies cleanly', () => {
  const repo = repoWith({ docs: 'old docs\n', 'src/app.py': 'x = 1\n' })
  const zip = outZip(repo, { 'docs/index.md': '# docs\n', 'src/app.py': 'x = 2\n' }, { baseline: { docs: 'old docs\n', 'src/app.py': 'x = 1\n' }, deletes: ['docs'] })
  const r = unpack(repo, zip)
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.deleted, ['docs'])
  assert.deepEqual(j.added, ['docs/index.md'])
  assert.equal(readFileSync(join(repo, 'docs/index.md'), 'utf8'), '# docs\n')
  assert.equal(readFileSync(join(repo, 'src/app.py'), 'utf8'), 'x = 2\n')
  assert.deepEqual(readdirSync(repo).filter((n) => n.includes('.m365-')), [], 'no staging files left behind')
})

test('unpack-output.mjs: a bundle carrying both x and x/y.txt is refused before anything is written', () => {
  const repo = repoWith({ 'src/app.py': 'x = 1\n' })
  const zip = outZip(repo, { 'src/app.py': 'x = 2\n', x: 'file\n', 'x/y.txt': 'nested\n' })
  const r = unpack(repo, zip)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /also the directory of x\/y\.txt/)
  assert.equal(readFileSync(join(repo, 'src/app.py'), 'utf8'), 'x = 1\n')
  assert.ok(!existsSync(join(repo, '.m365')))
})

test('unpack-output.mjs: a write under a local file that is not deleted is refused up front', () => {
  const repo = repoWith({ lib: 'a file\n', 'src/app.py': 'x = 1\n' })
  const zip = outZip(repo, { 'src/app.py': 'x = 2\n', 'lib/a.js': 'a\n' })
  const r = unpack(repo, zip)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /lib is a file here, not a directory/)
  assert.equal(readFileSync(join(repo, 'src/app.py'), 'utf8'), 'x = 1\n', 'all-or-nothing')
})

test('unpack-output.mjs: a write under a file kept by a conflicting delete becomes a conflict', () => {
  const repo = repoWith({ docs: 'edited locally\n' })
  const zip = outZip(repo, { 'docs/index.md': '# docs\n' }, { baseline: { docs: 'old docs\n' }, deletes: ['docs'] })
  const r = unpack(repo, zip)
  assert.equal(r.status, 3, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).conflicts.sort(), ['docs', 'docs/index.md'])
  assert.equal(readFileSync(join(repo, 'docs'), 'utf8'), 'edited locally\n')
})

test('unpack-output.mjs: a phase-2 failure is reported with what was and was not applied', () => {
  const repo = repoWith({ 'old.txt': 'old\n' })
  const long = `${'n'.repeat(300)}.txt` // longer than any file system allows: fails on rename
  const zip = outZip(repo, { 'a.txt': 'a\n', [long]: 'too long\n' }, { deletes: ['old.txt'] })
  const r = unpack(repo, zip)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /error: applying the bundle failed/)
  assert.match(r.stderr, /applied \(2\):\n {4}- old\.txt\n {4}\+ a\.txt/)
  assert.match(r.stderr, /not applied \(\d+\):[\s\S]*nnnn/)
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no raw stack trace')
  assert.deepEqual(readdirSync(repo).filter((n) => n.includes('.m365-')), [], 'staged temporaries removed')
})

test('unpack-output.mjs: an existing file keeps its mode when replaced', (t) => {
  if (process.platform === 'win32') return t.skip('no POSIX modes')
  const repo = repoWith({ 'run.sh': '#!/bin/sh\necho 1\n' })
  spawnSync('chmod', ['755', join(repo, 'run.sh')])
  const r = unpack(repo, outZip(repo, { 'run.sh': '#!/bin/sh\necho 2\n' }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(lstatSync(join(repo, 'run.sh')).mode & 0o777, 0o755)
})

// ------------------------------------------------------------------ item 2
test('unpack-output.mjs: a case-only rename is applied as one rename, not a delete of the new file', () => {
  const repo = repoWith({ 'Readme.md': 'old\n' })
  const zip = outZip(repo, { 'README.md': 'new\n' }, { baseline: { 'Readme.md': 'old\n' }, deletes: ['Readme.md'] })
  const r = unpack(repo, zip)
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual([j.added, j.deleted, j.conflicts], [['README.md'], ['Readme.md'], []])
  assert.deepEqual(readdirSync(repo).filter((n) => /readme/i.test(n)), ['README.md'])
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'new\n')
})

test('unpack-output.mjs: a case-only rename of a locally edited file is a conflict on both halves', () => {
  const repo = repoWith({ 'Readme.md': 'edited here\n' })
  const zip = outZip(repo, { 'README.md': 'new\n' }, { baseline: { 'Readme.md': 'old\n' }, deletes: ['Readme.md'] })
  const r = unpack(repo, zip)
  assert.equal(r.status, 3)
  assert.deepEqual(JSON.parse(r.stdout).conflicts.sort(), ['README.md', 'Readme.md'])
  assert.deepEqual(readdirSync(repo).filter((n) => /readme/i.test(n)), ['Readme.md'])
  assert.equal(readFileSync(join(repo, 'Readme.md'), 'utf8'), 'edited here\n')
})

test('unpack-output.mjs: two delivered names that fold together are refused', () => {
  const repo = repoWith()
  for (const pair of [['a.md', 'A.md'], ['café.md', 'café.md']]) {
    const r = unpack(repo, outZip(repo, { [pair[0]]: '1\n', [pair[1]]: '2\n' }))
    assert.equal(r.status, 1, pair.join())
    assert.match(r.stderr, /differ only in letter case or Unicode normalisation/)
  }
  assert.deepEqual(readdirSync(repo), [])
})

// ------------------------------------------------------------------ item 3
test('unpack-output.mjs: destinations the input excludes need --allow-excluded', () => {
  for (const p of ['node_modules/x/index.js', '.env', '.venv/lib/site.py', '.m365/demo/notes.md', 'keys/server.PEM']) {
    const repo = repoWith()
    const zip = outZip(repo, { [p]: 'x\n' })
    const r = unpack(repo, zip)
    assert.equal(r.status, 1, p)
    assert.match(r.stderr, /--allow-excluded/)
    assert.ok(!existsSync(join(repo, p)), p)
    const ok = unpack(repo, zip, '--allow-excluded')
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(readFileSync(join(repo, p), 'utf8'), 'x\n')
  }
  const repo = repoWith({ '.env': 'SECRET=1\n' })
  const r = unpack(repo, outZip(repo, {}, { deletes: ['.env'] }))
  assert.equal(r.status, 1, 'a deletion is held to the same rule')
  assert.ok(existsSync(join(repo, '.env')))
})

// ------------------------------------------------------------------ item 4
test('unpack-output.mjs: BOM + CRLF local file matches a normalised baseline and keeps its style', () => {
  const repo = repoWith({ 'notes.txt': '﻿a\r\nb\r\n' })
  // A Markdown input bundle hashed the normalised text; the output came back as a ZIP.
  const zip = outZip(repo, { 'notes.txt': 'a\nc\n' }, { baseline: { 'notes.txt': 'a\nb\n' } })
  const r = unpack(repo, zip)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).modified, ['notes.txt'])
  assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), '﻿a\r\nc\r\n')
})

test('unpack-output.mjs: a lone-CR file untouched in the sandbox is kept, not a conflict', () => {
  const repo = repoWith({ 'old.txt': 'a\rb\r', 'bom.md': '﻿# t\n' })
  const zip = outZip(repo, { 'old.txt': 'a\nb\n', 'bom.md': '# t\n' }, { baseline: { 'old.txt': 'a\nb\n', 'bom.md': '# t\n' } })
  const r = unpack(repo, zip)
  assert.equal(r.status, 0, r.stdout)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.conflicts, [])
  assert.deepEqual(j.kept, ['old.txt'])
  assert.deepEqual(j.unchanged, ['bom.md'], 'with its BOM restored the delivered file is identical')
  assert.equal(readFileSync(join(repo, 'old.txt'), 'utf8'), 'a\rb\r')
})

test('unpack-output.mjs: a Markdown bundle restores the BOM of the file it replaces', () => {
  const repo = repoWith({ 'doc.md': '﻿# old\r\n' })
  const md = join(repo, 'out.md')
  writeFileSync(md, formatBundle({ task: 'demo-task', kind: 'output', files: [{ path: 'doc.md', data: Buffer.from('# new\n') }, { path: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }] }))
  const r = unpack(repo, md)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(repo, 'doc.md'), 'utf8'), '﻿# new\r\n')
})

// ------------------------------------------------------------- items 5 and 9
test('path model: header-flag suffixes, Windows device names and 8.3 short names are unsafe', () => {
  for (const p of ['a/b [noeol]', 'x [draft]/y.md', 'notes []', 'CON', 'con.txt', 'src/Nul.tar.gz', 'COM1', 'lpt9.md', 'aux .txt', 'PRN.', 'PROGRA~1/x.md', 'foo~2.txt']) assert.ok(unsafePathReason(p), p)
  for (const p of ['console.md', 'COM10.txt', 'connect/x.md', 'a [b] c.md', 'a[b].md', 'tilde~x.md', 'auxiliary.py']) assert.equal(unsafePathReason(p), null, p)
  assert.match(unsafePathReason('a/b [noeol]'), /reserves for flags/)
  assert.match(unsafePathReason('nul.txt'), /device name/)
  assert.throws(() => formatBundle({ task: 't', kind: 'output', files: [{ path: 'b [noeol]', data: Buffer.from('x') }] }), /unsafe path/)
})

// ------------------------------------------------------------------ item 6
test('make-input.mjs: a ZIP over the reader limits is refused, not written', () => {
  const repo = repoWith({ 'small.txt': 'x\n', '.m365/TASK.md': TASK })
  writeFileSync(join(repo, 'big.bin'), '')
  truncateSync(join(repo, 'big.bin'), MAX_ENTRY_BYTES + 1)
  const r = run('make-input.mjs', ['--task', '.m365/TASK.md', '--repo', repo, '--store'], repo)
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /reader limits[\s\S]*big\.bin/)
  assert.ok(!existsSync(join(repo, '.m365/demo-task/in-demo-task.zip')))
})

// ------------------------------------------------------------------ item 7
test('unpack-output.mjs: --repo given as a symlink accepts a new top-level file', (t) => {
  const real = repoWith({ 'a.txt': 'a\n' })
  const link = join(mkdtempSync(join(tmpdir(), 'm365fix-link-')), 'repo')
  try {
    symlinkSync(real, link, 'dir')
  } catch (e) {
    return t.skip(`cannot create symlinks here: ${e.message}`)
  }
  const r = unpack(link, outZip(real, { 'new.txt': 'new\n' }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(real, 'new.txt'), 'utf8'), 'new\n')
})

// ------------------------------------------------------------------ item 8
test('`..name` paths are names, not escapes, on both sides', () => {
  const repo = repoWith({ '..notes.md': 'n\n', '..cache/x.md': 'c\n', '.m365/TASK.md': TASK })
  const r = run('make-input.mjs', ['--task', '.m365/TASK.md', '--repo', repo, '--quiet'], repo)
  assert.equal(r.status, 0, r.stderr)
  const names = readZip(readFileSync(r.stdout.trim())).map((e) => e.name)
  assert.ok(names.includes('..notes.md') && names.includes('..cache/x.md'), names.join())
  const target = repoWith()
  const u = unpack(target, outZip(target, { '..notes.md': 'n2\n', '..cache/y.md': 'y\n' }))
  assert.equal(u.status, 0, u.stderr)
  assert.equal(readFileSync(join(target, '..cache/y.md'), 'utf8'), 'y\n')
})

// ----------------------------------------------------------------- item 10
test('make-input.mjs: positional "." is the whole repository; a path outside it is an error', () => {
  const repo = repoWith({ 'src/a.py': 'a = 1\n', 'b.txt': 'b\n', '.m365/TASK.md': TASK })
  const r = run('make-input.mjs', ['--task', '.m365/TASK.md', '--repo', repo, '--quiet', '.'], repo)
  assert.equal(r.status, 0, r.stderr)
  const names = readZip(readFileSync(r.stdout.trim())).map((e) => e.name).sort()
  assert.deepEqual(names, ['_m365/TASK.md', 'b.txt', 'src/a.py'])
  const bad = run('make-input.mjs', ['--task', '.m365/TASK.md', '--repo', repo, '..'], repo)
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /not inside the repository/)
})

// ----------------------------------------------------------------- item 11
test('validator: common/ gets the same junk, symlink and SKILL.* filtering as the skill', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'm365fix-skill-'))
  const skill = join(base, 'demo')
  const common = join(base, 'common')
  mkdirSync(join(common, 'scripts'), { recursive: true })
  mkdirSync(skill)
  writeFileSync(join(skill, 'SKILL.template.md'), '---\nname: demo\ndescription: Use when testing.\n---\n\nDo it.\n')
  writeFileSync(join(common, 'scripts/io.py'), 'print(1)\n')
  writeFileSync(join(common, '.DS_Store'), 'junk')
  writeFileSync(join(common, 'scripts/io.pyc'), 'junk')
  let v = validateSkillDir(skill, { fromTemplate: true, commonDir: common })
  assert.deepEqual(v.problems, [])
  assert.deepEqual(v.entries.map((e) => e.name), ['SKILL.md', 'scripts/io.py'])
  assert.ok(v.skipped.includes('common/.DS_Store (junk)') && v.skipped.includes('common/scripts/io.pyc (junk)'), v.skipped.join())

  writeFileSync(join(common, 'SKILL.md'), '---\nname: other\ndescription: x\n---\n')
  v = validateSkillDir(skill, { fromTemplate: true, commonDir: common })
  assert.match(v.problems.join('\n'), /common\/SKILL\.md would collide/)
  assert.equal(v.entries.filter((e) => e.name === 'SKILL.md').length <= 1, true)
  try {
    symlinkSync(join(common, 'scripts/io.py'), join(common, 'scripts/link.py'))
  } catch (e) {
    return t.skip(`cannot create symlinks here: ${e.message}`)
  }
  v = validateSkillDir(skill, { fromTemplate: true, commonDir: common })
  assert.match(v.problems.join('\n'), /common\/scripts\/link\.py is a symbolic link/)
})

// ----------------------------------------------------------------- item 12
test('zip writer: more than 65535 entries fails with the friendly limit message', () => {
  const entries = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.alloc(0) }))
  assert.throws(() => writeZip(entries, { store: true }), /non-ZIP64 limits/)
})

test('args: a blank numeric value is refused instead of becoming 0', () => {
  assert.throws(() => parseArgs(['--max-depth='], { 'max-depth': 'number' }), /must be a number/)
  assert.throws(() => parseArgs(['--max-depth', ' '], { 'max-depth': 'number' }), /must be a number/)
  assert.equal(parseArgs(['--max-depth=0'], { 'max-depth': 'number' }).opts['max-depth'], 0)
})

test('validator: a file inside a dot-directory is refused like a dotfile', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'm365fix-dot-')), 'demo')
  mkdirSync(join(dir, '.hidden'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Use when testing.\n---\n\nDo it.\n')
  writeFileSync(join(dir, '.hidden/x.md'), '# x\n')
  assert.match(validateSkillDir(dir).problems.join('\n'), /\.hidden\/x\.md is a dotfile or lies in a dot-directory/)
})

test('pack-skill.mjs: two skills with the same name are an error and nothing is written', () => {
  const base = mkdtempSync(join(tmpdir(), 'm365fix-twins-'))
  for (const d of ['one', 'two']) {
    mkdirSync(join(base, d))
    writeFileSync(join(base, d, 'SKILL.md'), '---\nname: same\ndescription: Use when testing.\n---\n\nDo it.\n')
  }
  const out = join(base, 'out')
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'pack-skill.mjs'), join(base, 'one'), join(base, 'two'), '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /name: same` is also used by/)
  assert.ok(!existsSync(join(out, 'same.zip')))
})

test('make-input.mjs: a Markdown bundle skips non-UTF-8 files instead of corrupting them', () => {
  const repo = repoWith({ 'ok.txt': 'fine\n', 'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), '.m365/TASK.md': TASK })
  const r = run('make-input.mjs', ['--task', '.m365/TASK.md', '--repo', repo, '--format', 'md', '--quiet'], repo)
  assert.equal(r.status, 0, r.stderr)
  const b = parseBundle(readFileSync(r.stdout.trim(), 'utf8'))
  assert.ok(b.files.some((f) => f.path === 'ok.txt'))
  assert.ok(!b.files.some((f) => f.path === 'latin1.txt'))
  assert.deepEqual(b.skipped, [{ path: 'latin1.txt', reason: 'not UTF-8 text' }])
  assert.throws(() => formatBundle({ task: 't', kind: 'input', files: [{ path: 'x.txt', data: Buffer.from([0xff]) }] }), /not UTF-8/)
})
