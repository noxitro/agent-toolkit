// Regression tests for the second Copilot review: three-way apply, symlinks in the
// input, top-level frontmatter keys, and the Python ZIP limits.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'
import { validateAsset } from '../scripts/lib/toolkit.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const BUNDLE_IO = join(ROOT, 'shared/skills/m365-skill-pack/m365/skills/common/scripts/bundle_io.py')
const TASK = '# TASK demo-task\n\n## Goal\n\nDo it.\n\n## Acceptance\n\n- AC-1: compiles\n'
const AUDIT = '# AUDIT\n\n```json\n{"schema":"m365-audit/1","task":"demo-task","verdict":"PASS","final_round":1,"max_rounds":2,"rounds":[{"round":1,"verdict":"PASS","checks":[{"id":"AC-1","status":"PASS"}]}]}\n```\n'
const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex')
const run = (script, args, cwd) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })

function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), 'm365rev2-'))
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/app.py'), 'x = 1\n')
  writeFileSync(join(repo, 'src/util.py'), 'u = 1\n')
  writeFileSync(join(repo, 'src/old.py'), 'o = 1\n')
  mkdirSync(join(repo, '.m365'))
  writeFileSync(join(repo, '.m365/TASK.md'), TASK)
  return { base, repo }
}

function fullBundle(overrides = {}) {
  const manifest = { schema: 'm365-manifest/1', task: 'demo-task', files: { 'src/app.py': sha('x = 1\n'), 'src/util.py': sha('u = 1\n'), 'src/old.py': sha('o = 1\n') } }
  const entries = [
    { name: 'src/app.py', data: Buffer.from(overrides.app ?? 'x = 2\n') }, // changed in the sandbox
    { name: 'src/util.py', data: Buffer.from('u = 1\n') }, // untouched in the sandbox
    { name: 'src/new.py', data: Buffer.from('n = 1\n') }, // added in the sandbox
    { name: '_m365/DELETED.txt', data: Buffer.from('src/old.py\n') },
    { name: '_m365/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) },
  ]
  return writeZip(entries)
}

test('three-way apply: local edits to untouched files are kept, both-sides changes are conflicts', () => {
  const { repo } = repoFixture()
  writeFileSync(join(repo, 'src/util.py'), 'u = 99  # edited locally while the loop ran\n')
  const zipPath = join(repo, 'out.zip')
  writeFileSync(zipPath, fullBundle())
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo, '--json'], repo)
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.baseline, true)
  assert.deepEqual(j.kept, ['src/util.py'])
  assert.deepEqual(j.modified, ['src/app.py'])
  assert.deepEqual(j.added, ['src/new.py'])
  assert.deepEqual(j.deleted, ['src/old.py'])
  assert.deepEqual(j.conflicts, [])
  assert.equal(readFileSync(join(repo, 'src/util.py'), 'utf8'), 'u = 99  # edited locally while the loop ran\n')
  assert.equal(readFileSync(join(repo, 'src/app.py'), 'utf8'), 'x = 2\n')

  // Now a file changed on both sides, and a locally edited file the sandbox deleted.
  const { repo: repo2 } = repoFixture()
  writeFileSync(join(repo2, 'src/app.py'), 'x = 3  # local\n')
  writeFileSync(join(repo2, 'src/old.py'), 'o = 2  # local\n')
  writeFileSync(join(repo2, 'src/new.py'), 'n = 0  # local, pre-existing\n')
  const zip2 = join(repo2, 'out.zip')
  writeFileSync(zip2, fullBundle())
  const r2 = run('unpack-output.mjs', [zip2, '--repo', repo2, '--json'], repo2)
  assert.equal(r2.status, 3, 'conflicts exit 3')
  const j2 = JSON.parse(r2.stdout)
  assert.deepEqual(j2.conflicts.sort(), ['src/app.py', 'src/new.py', 'src/old.py'])
  assert.equal(readFileSync(join(repo2, 'src/app.py'), 'utf8'), 'x = 3  # local\n', 'conflict left alone')
  assert.ok(existsSync(join(repo2, 'src/old.py')), 'locally edited file not deleted')
  const r3 = run('unpack-output.mjs', [zip2, '--repo', repo2, '--json', '--force'], repo2)
  assert.equal(r3.status, 0, r3.stderr)
  assert.equal(readFileSync(join(repo2, 'src/app.py'), 'utf8'), 'x = 2\n')
  assert.ok(!existsSync(join(repo2, 'src/old.py')))
})

test('make-input.mjs: symbolic links are skipped, including a symlinked conventions file', (t) => {
  const { base, repo } = repoFixture()
  const outside = join(base, 'outside.txt')
  writeFileSync(outside, 'SECRET OUTSIDE\n')
  try {
    symlinkSync(outside, join(repo, 'src/link.txt'), 'file')
    symlinkSync(outside, join(repo, 'CLAUDE.md'), 'file')
  } catch (e) {
    return t.skip(`cannot create symlinks here: ${e.message}`)
  }
  const r = run('make-input.mjs', ['--task', join(repo, '.m365/TASK.md'), '--repo', repo, '--out', join(repo, '.m365/out'), '--quiet'], repo)
  assert.equal(r.status, 0, r.stderr)
  const entries = readZip(readFileSync(r.stdout.trim()))
  for (const e of entries) assert.ok(!e.data.toString().includes('SECRET OUTSIDE'), `${e.name} leaks the symlink target`)
  assert.ok(!entries.some((e) => e.name === 'src/link.txt' || e.name === '_m365/CONVENTIONS/CLAUDE.md'))
})

test('validateAsset: unknown top-level frontmatter keys are errors', () => {
  const asset = { kind: 'skills', name: 'demo', sourceFile: 'shared/skills/demo/SKILL.md', data: { name: 'demo', description: 'd', targets: ['claude'], 'allowed-tools': 'Read' }, body: 'body' }
  const problems = validateAsset(asset)
  assert.ok(problems.some((p) => /top-level key `allowed-tools` is not portable/.test(p)), problems.join('\n'))
  assert.deepEqual(validateAsset({ ...asset, data: { name: 'demo', description: 'd', targets: ['claude'], harness: { claude: { frontmatter: { 'allowed-tools': 'Read' } } } } }), [])
})

test('bundle_io.py: entry count and declared sizes are bounded before reading', (t) => {
  const py = ['python', 'python3', 'py'].map((c) => (c === 'py' ? ['py', '-3'] : [c])).find((cand) => {
    const r = spawnSync(cand[0], [...cand.slice(1), '--version'], { encoding: 'utf8' })
    return !r.error && r.status === 0
  })
  if (!py) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365pylim-'))
  const many = join(tmp, 'many.zip')
  writeFileSync(many, writeZip(Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.alloc(0) }))))
  const r = spawnSync(py[0], [...py.slice(1), BUNDLE_IO, 'unpack', many, join(tmp, 'w1')], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /entries \(limit/)
  const lie = writeZip([{ name: 'a.txt', data: Buffer.alloc(2048, 0x61) }])
  const eocd = lie.length - 22
  lie.writeUInt32LE(100 * 1024 * 1024, lie.readUInt32LE(eocd + 16) + 24)
  const liePath = join(tmp, 'lie.zip')
  writeFileSync(liePath, lie)
  const r2 = spawnSync(py[0], [...py.slice(1), BUNDLE_IO, 'unpack', liePath, join(tmp, 'w2')], { encoding: 'utf8' })
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /declares .* bytes \(limit/)
  // A small lie passes the per-entry cap and must be caught by the size check on read.
  const small = writeZip([{ name: 'b.txt', data: Buffer.alloc(2048, 0x62) }])
  small.writeUInt32LE(1024, small.readUInt32LE(small.length - 22 + 16) + 24)
  const smallPath = join(tmp, 'small.zip')
  writeFileSync(smallPath, small)
  const r3 = spawnSync(py[0], [...py.slice(1), BUNDLE_IO, 'unpack', smallPath, join(tmp, 'w3')], { encoding: 'utf8' })
  assert.equal(r3.status, 1)
  assert.match(r3.stderr, /declared size|CRC/)
  assert.ok(!existsSync(join(tmp, 'w3')))
})

test('three-way apply: deleting a path the snapshot never saw is a conflict; odd file names are safe', () => {
  const base = mkdtempSync(join(tmpdir(), 'm365rev2b-'))
  const repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'secret.env'), 'local only\n')
  const manifest = { schema: 'm365-manifest/1', task: 'demo-task', files: { 'a.txt': sha('a\n') } }
  const zipPath = join(repo, 'out.zip')
  writeFileSync(zipPath, writeZip([
    { name: 'constructor', data: Buffer.from('new file with an inherited-property name\n') },
    { name: '_m365/DELETED.txt', data: Buffer.from('secret.env\n') },
    { name: '_m365/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) },
  ]))
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo, '--json'], repo)
  assert.equal(r.status, 3, r.stdout + r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.conflicts, ['secret.env'])
  assert.deepEqual(j.added, ['constructor'], 'a file named like an Object property is just a file')
  assert.ok(existsSync(join(repo, 'secret.env')))
  // An array-shaped manifest is not a baseline: plain overwrite, no conflicts.
  const zip2 = join(repo, 'out2.zip')
  writeFileSync(zip2, writeZip([{ name: 'a.txt', data: Buffer.from('b\n') }, { name: '_m365/manifest.json', data: Buffer.from('{"schema":"m365-manifest/1","files":[]}') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]))
  const r2 = run('unpack-output.mjs', [zip2, '--repo', repo, '--json'], repo)
  assert.equal(r2.status, 0, r2.stderr)
  assert.equal(JSON.parse(r2.stdout).baseline, false)
})
