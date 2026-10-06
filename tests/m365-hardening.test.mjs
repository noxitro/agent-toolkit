// Regression tests for the findings of the pre-push review: .git look-alikes, report
// directory traversal through the task name, key material in subdirectories, and
// duplicate or inconsistent ZIP entries.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { isSafeSlug, parseBundle, unsafePathReason } from '../shared/skills/m365-skill-pack/scripts/lib/bundle.mjs'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const TASK = '# TASK demo-task\n\n## Goal\n\nDo it.\n\n## Acceptance\n\n- AC-1: compiles\n'
const AUDIT = '# AUDIT\n\n```json\n{"schema":"m365-audit/1","task":"demo-task","verdict":"PASS","final_round":1,"max_rounds":2,"rounds":[{"round":1,"verdict":"PASS","checks":[{"id":"AC-1","status":"PASS"}]}]}\n```\n'
const run = (script, args, cwd) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })

function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), 'm365hard-'))
  const repo = join(base, 'a', 'b', 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(repo, '.git', 'description'), 'keep me\n')
  writeFileSync(join(repo, 'src/app.py'), 'x = 1\n')
  mkdirSync(join(repo, '.m365'))
  writeFileSync(join(repo, '.m365/TASK.md'), TASK)
  return { base, repo }
}

test('path model: refuses .git look-alikes and reserved characters', () => {
  for (const p of ['.GIT/hooks/pre-commit', 'GIT~1/hooks/pre-push', '.Git/description', 'src/.git./x', 'src/.git /x', 'a:b/c', 'trailing./x', 'trailing /x', 'src/con|x', 'src/x\u0001y'])
    assert.ok(unsafePathReason(p), `${p} must be refused`)
  assert.equal(unsafePathReason('src/git/x.py'), null)
  assert.equal(unsafePathReason('src/.gitignore'), null)
  assert.equal(unsafePathReason('src/.github/workflows/ci.yml'), null)
  for (const s of ['../../ESCAPED', '.git', 'GIT~1', 'a/b', '', '..', '.']) assert.ok(!isSafeSlug(s), s)
  assert.ok(isSafeSlug('demo-task_1.2'))
})

test('unpack-output.mjs: .git look-alikes in a zip or DELETED.txt touch nothing', () => {
  const { repo } = repoFixture()
  const cases = [
    writeZip([{ name: '.GIT/hooks/pre-commit', data: Buffer.from('#!/bin/sh\necho pwned\n') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]),
    writeZip([{ name: 'GIT~1/hooks/pre-push', data: Buffer.from('x') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]),
    writeZip([{ name: '_m365/DELETED.txt', data: Buffer.from('.Git/description\n') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]),
  ]
  for (const [i, zip] of cases.entries()) {
    const zipPath = join(repo, `evil${i}.zip`)
    writeFileSync(zipPath, zip)
    const r = run('unpack-output.mjs', [zipPath, '--repo', repo], repo)
    assert.equal(r.status, 1, `case ${i}: ${r.stdout}`)
    assert.match(r.stderr, /unsafe path/)
  }
  assert.ok(!existsSync(join(repo, '.git/hooks/pre-commit')))
  assert.ok(!existsSync(join(repo, '.git/hooks/pre-push')))
  assert.equal(readFileSync(join(repo, '.git/description'), 'utf8'), 'keep me\n')
})

test('unpack-output.mjs: the task name cannot steer the reports directory', () => {
  const { base, repo } = repoFixture()
  const zipPath = join(repo, 'traversal.zip')
  writeFileSync(zipPath, writeZip([{ name: '_m365/AUDIT.md', data: Buffer.from(AUDIT.replace('"task":"demo-task"', '"task":"../../ESCAPED"')) }]))
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo, '--json'], repo)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /not a valid slug/)
  assert.ok(existsSync(join(repo, '.m365/unknown/reports/AUDIT.md')))
  assert.ok(!existsSync(join(base, 'ESCAPED')) && !existsSync(join(base, 'a', 'ESCAPED')))
})

test('make-input.mjs: key material in subdirectories is excluded and the EDP note survives --quiet', () => {
  const { repo } = repoFixture()
  for (const rel of ['certs/server.pem', 'config/app.key', 'config/cert.pfx', 'deep/er/secrets.json', 'deep/id_ed25519', 'ok/notes.md']) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), 'x')
  }
  const r = run('make-input.mjs', ['--task', join(repo, '.m365/TASK.md'), '--repo', repo, '--out', join(repo, '.m365/out'), '--quiet'], repo)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /Enterprise Data Protection/)
  const names = readZip(readFileSync(r.stdout.trim())).map((e) => e.name)
  assert.ok(names.includes('ok/notes.md'))
  for (const n of names) assert.ok(!/\.(pem|key|pfx)$|secrets\.|id_ed25519/.test(n), `${n} must not ship`)
})

test('zip reader: duplicate entries, mismatched local names, declared-size lies', () => {
  assert.throws(() => readZip(writeZip([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'a.txt', data: Buffer.from('2') }])), /duplicate entry/)
  const z = writeZip([{ name: 'ab.txt', data: Buffer.from('1') }])
  z.write('xb.txt', 30, 'utf8') // corrupt only the local header name
  assert.throws(() => readZip(z), /does not match/)
  const big = writeZip([{ name: 'z.txt', data: Buffer.alloc(100_000, 0x61) }])
  const eocd = big.length - 22
  const cd = big.readUInt32LE(eocd + 16)
  big.writeUInt32LE(10, cd + 24) // declare 10 bytes while the stream inflates to 100000
  assert.throws(() => readZip(big), /size mismatch|maxOutputLength|Buffer/i)
  assert.throws(() => parseBundle('# m365-bundle v1\n\n### FILE a.txt\n```\nx\n```\n\n### FILE a.txt\n```\ny\n```\n'), /duplicate path/)
})

test('pack-skill.mjs: writes nothing when one of several skills fails', () => {
  const base = mkdtempSync(join(tmpdir(), 'm365packall-'))
  const good = join(base, 'good')
  const bad = join(base, 'bad')
  mkdirSync(good)
  mkdirSync(bad)
  writeFileSync(join(good, 'SKILL.md'), '---\nname: good\ndescription: d\n---\nbody\n')
  writeFileSync(join(bad, 'SKILL.md'), '---\nname: bad\ndescription: d\n---\nbody\n')
  writeFileSync(join(bad, 'run.ps1'), 'x')
  const out = join(base, 'out')
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'pack-skill.mjs'), good, bad, '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.ok(!existsSync(join(out, 'good.zip')), 'good.zip must not be written when bad fails')
})
