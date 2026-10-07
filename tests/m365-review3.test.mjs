// Regression tests for the final pre-merge review: dangling symlink destinations,
// all-or-nothing apply, and the independent audit report kept beside the implementer's.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const AUDIT = (verdict) => `# AUDIT\n\n\`\`\`json\n{"schema":"m365-audit/1","task":"demo-task","verdict":"${verdict}","final_round":1,"max_rounds":2,"rounds":[{"round":1,"verdict":"${verdict}","checks":[{"id":"AC-1","status":"${verdict}"}]}]}\n\`\`\`\n`
const run = (script, args, cwd) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })

function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), 'm365rev3-'))
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/app.py'), 'x = 1\n')
  return { base, repo }
}

test('unpack-output.mjs: a dangling symlink at the destination is refused and nothing else is written', (t) => {
  const { base, repo } = repoFixture()
  const outside = join(base, 'outside')
  mkdirSync(outside)
  try {
    symlinkSync(join(outside, 'pwn.txt'), join(repo, 'src/new.txt'), 'file') // target does not exist
  } catch (e) {
    return t.skip(`cannot create symlinks here: ${e.message}`)
  }
  const zipPath = join(repo, 'out.zip')
  writeFileSync(zipPath, writeZip([
    { name: 'src/first.py', data: Buffer.from('first = 1\n') }, // planned before the bad one
    { name: 'src/new.txt', data: Buffer.from('new\n') },
    { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT('PASS')) },
  ]))
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo], repo)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /outside the repository/)
  assert.ok(!existsSync(join(outside, 'pwn.txt')), 'nothing written through the link')
  assert.ok(!existsSync(join(repo, 'src/first.py')), 'all-or-nothing: the earlier file was not written either')
  assert.ok(!existsSync(join(repo, '.m365')), 'no reports written either')
})

test('unpack-output.mjs: an audit-only bundle lands beside the implementer report', () => {
  const { repo } = repoFixture()
  const out = join(repo, 'out.zip')
  writeFileSync(out, writeZip([{ name: 'src/app.py', data: Buffer.from('x = 2\n') }, { name: '_m365/TASK.md', data: Buffer.from('# TASK demo-task\n') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT('PASS')) }]))
  assert.equal(run('unpack-output.mjs', [out, '--repo', repo], repo).status, 0)
  const auditZip = join(repo, 'audit.zip')
  writeFileSync(auditZip, writeZip([{ name: '_m365/AUDIT.md', data: Buffer.from(AUDIT('FAIL')) }]))
  const r = run('unpack-output.mjs', [auditZip, '--repo', repo, '--json'], repo)
  assert.equal(r.status, 2, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.ok(j.auditSavedAs.endsWith('AUDIT.auditor.md'))
  const reports = join(repo, '.m365/demo-task/reports')
  assert.match(readFileSync(join(reports, 'AUDIT.md'), 'utf8'), /"verdict":"PASS"/, 'implementer report untouched')
  assert.match(readFileSync(join(reports, 'AUDIT.auditor.md'), 'utf8'), /"verdict":"FAIL"/)
  assert.equal(readFileSync(join(repo, 'src/app.py'), 'utf8'), 'x = 2\n', 'repository untouched by the audit bundle')
})
