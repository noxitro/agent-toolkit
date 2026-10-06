// Regression tests for the findings of the GitHub Copilot review on the first PR.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { INPUT_EXCLUDE_RES, validateSkillDir } from '../shared/skills/m365-skill-pack/scripts/lib/m365-rules.mjs'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const TASK = '# TASK demo-task\n\n## Goal\n\nDo it.\n\n## Acceptance\n\n- AC-1: compiles\n'
const AUDIT = '# AUDIT\n\n```json\n{"schema":"m365-audit/1","task":"demo-task","verdict":"PASS","final_round":1,"max_rounds":2,"rounds":[{"round":1,"verdict":"PASS","checks":[{"id":"AC-1","status":"PASS"}]}]}\n```\n'
const run = (script, args, cwd) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })

function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), 'm365rev-'))
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/app.py'), 'x = 1\n')
  mkdirSync(join(repo, '.m365'))
  writeFileSync(join(repo, '.m365/TASK.md'), TASK)
  return { base, repo }
}

test('default secret exclusions ignore letter case; user globs stay exact', () => {
  for (const p of ['.ENV', 'config/.Env.local', 'certs/SERVER.PEM', 'Credentials.json', 'a/b/Secrets.yaml', 'NODE_MODULES/x.js'])
    assert.ok(INPUT_EXCLUDE_RES.some((re) => re.test(p)), `${p} must be excluded`)
  assert.ok(!INPUT_EXCLUDE_RES.some((re) => re.test('src/environment.py')))
  const { repo } = repoFixture()
  mkdirSync(join(repo, 'certs'), { recursive: true })
  for (const rel of ['.ENV', 'certs/Server.PEM', 'Keep.py']) writeFileSync(join(repo, rel), 'x')
  const r = run('make-input.mjs', ['--task', join(repo, '.m365/TASK.md'), '--repo', repo, '--out', join(repo, '.m365/out'), '--quiet'], repo)
  assert.equal(r.status, 0, r.stderr)
  const names = readZip(readFileSync(r.stdout.trim())).map((e) => e.name)
  assert.ok(names.includes('Keep.py'))
  assert.ok(!names.includes('.ENV') && !names.includes('certs/Server.PEM'), names.join(','))
})

test('skill validator: a name that is not a plain slug is an error', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'm365name-')), 'evil')
  mkdirSync(dir)
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: ../../outside\ndescription: d\n---\nbody\n')
  const v = validateSkillDir(dir)
  assert.ok(v.problems.some((p) => /must be lowercase words/.test(p)), v.problems.join('\n'))
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'pack-skill.mjs'), dir, '--out', join(dir, '..', 'out')], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.ok(!existsSync(join(dir, '..', '..', 'outside.zip')) && !existsSync(join(dir, '..', 'out')))
})

test('zip reader: entry count and cumulative size limits apply before inflating', () => {
  const many = Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.alloc(0) }))
  assert.throws(() => readZip(writeZip(many)), /entries \(limit/)
  const z = writeZip([{ name: 'a.txt', data: Buffer.alloc(1024, 0x61) }, { name: 'b.txt', data: Buffer.alloc(1024, 0x62) }])
  const eocd = z.length - 22
  let cd = z.readUInt32LE(eocd + 16)
  // Lie about both declared sizes so their sum exceeds the cumulative cap.
  for (let i = 0; i < 2; i++) {
    z.writeUInt32LE(200 * 1024 * 1024, cd + 24)
    cd += 46 + z.readUInt16LE(cd + 28)
  }
  assert.throws(() => readZip(z), /declares|in total|limit/)
})

test('unpack-output.mjs: deletion list conflicts are refused before anything is written', () => {
  const { repo } = repoFixture()
  const cases = [
    [{ name: 'src/app.py', data: Buffer.from('y = 2\n') }, { name: '_m365/DELETED.txt', data: Buffer.from('src/app.py\n') }],
    [{ name: '_m365/DELETED.txt', data: Buffer.from('src/app.py\nsrc/app.py\n') }],
    [{ name: '_m365/DELETED.txt', data: Buffer.from('_m365/TASK.md\n') }],
  ]
  for (const [i, entries] of cases.entries()) {
    const zipPath = join(repo, `del${i}.zip`)
    writeFileSync(zipPath, writeZip([...entries, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]))
    const r = run('unpack-output.mjs', [zipPath, '--repo', repo], repo)
    assert.equal(r.status, 1, `case ${i}: ${r.stdout}`)
    assert.match(r.stderr, /deletion|both delivered|twice/)
  }
  assert.equal(readFileSync(join(repo, 'src/app.py'), 'utf8'), 'x = 1\n', 'repository untouched')
})

test('unpack-output.mjs: a symlinked directory inside the repo cannot redirect writes outside', (t) => {
  const { base, repo } = repoFixture()
  const outside = join(base, 'outside')
  mkdirSync(outside)
  try {
    symlinkSync(outside, join(repo, 'src', 'generated'), 'dir')
  } catch (e) {
    return t.skip(`cannot create symlinks here: ${e.message}`)
  }
  const zipPath = join(repo, 'via-link.zip')
  writeFileSync(zipPath, writeZip([{ name: 'src/generated/evil.txt', data: Buffer.from('x') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]))
  const r = run('unpack-output.mjs', [zipPath, '--repo', repo], repo)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /outside the repository/)
  assert.ok(!existsSync(join(outside, 'evil.txt')))
  const delZip = join(repo, 'del-via-link.zip')
  writeFileSync(join(outside, 'victim.txt'), 'keep')
  writeFileSync(delZip, writeZip([{ name: '_m365/DELETED.txt', data: Buffer.from('src/generated/victim.txt\n') }, { name: '_m365/AUDIT.md', data: Buffer.from(AUDIT) }]))
  const r2 = run('unpack-output.mjs', [delZip, '--repo', repo], repo)
  assert.equal(r2.status, 1, r2.stdout)
  assert.ok(existsSync(join(outside, 'victim.txt')))
})

test('build: {{literal:ARGS}} survives generation as the canonical token', () => {
  for (const file of ['plugins/toolkit-core/commands/new-agent-asset.md', 'dist/copilot/prompts/new-agent-asset.prompt.md', 'dist/opencode/command/new-agent-asset.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(text.includes('use `{{ARGS}}` wherever'), `${file} keeps the literal token in the guidance`)
    assert.ok(!text.includes('{{literal:'), `${file} has no unexpanded escape`)
  }
  const reviewer = readFileSync(join(ROOT, 'dist/copilot/agents/asset-reviewer.agent.md'), 'utf8')
  assert.ok(reviewer.includes('written as `{{ARGS}}`'))
  const prompt = readFileSync(join(ROOT, 'dist/copilot/prompts/new-agent-asset.prompt.md'), 'utf8')
  assert.ok(prompt.includes('from: ${input:args}'), 'the real argument slot is still substituted')
})
