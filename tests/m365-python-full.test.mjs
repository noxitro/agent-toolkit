// `bundle_io.py pack --full` must give an independent auditor the whole tree while
// `status` still reports only the real changes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'shared/skills/m365-skill-pack/scripts')
const BUNDLE_IO = join(ROOT, 'shared/skills/m365-skill-pack/m365/skills/common/scripts/bundle_io.py')

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

test('pack --full carries every file and the manifest; the auditor sees the real changes', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365full-'))
  const repo = join(tmp, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/app.py'), 'def f():\n    return 1\n')
  writeFileSync(join(repo, 'src/caller.py'), 'from src.app import f\n')
  writeFileSync(join(repo, 'src/old.txt'), 'remove me\n')
  const task = join(tmp, 'TASK.md')
  writeFileSync(task, '# TASK full\n\n## Goal\n\nx\n\n## Acceptance\n\n- AC-1: y\n')
  const made = ok(spawnSync(process.execPath, [join(SCRIPTS, 'make-input.mjs'), '--task', task, '--repo', repo, '--out', tmp, '--quiet'], { encoding: 'utf8' }), 'make-input')
  const work = join(tmp, 'work')
  ok(py([BUNDLE_IO, 'unpack', made.stdout.trim(), work]), 'unpack input')
  writeFileSync(join(work, 'src/app.py'), 'def f():\n    return 2\n')
  writeFileSync(join(work, 'src/new.py'), 'z = 1\n')
  rmSync(join(work, 'src/old.txt'))
  const out = join(tmp, 'out-full-r1.zip')
  ok(py([BUNDLE_IO, 'pack', work, out, '--full']), 'pack --full')
  const names = readZip(readFileSync(out)).map((e) => e.name).sort()
  assert.ok(names.includes('src/caller.py'), 'unchanged caller ships')
  assert.ok(names.includes('src/app.py') && names.includes('src/new.py'))
  assert.ok(!names.includes('src/old.txt'))
  assert.ok(names.includes('_m365/manifest.json') && names.includes('_m365/DELETED.txt'))

  const auditWork = join(tmp, 'audit-work')
  const un = ok(py([BUNDLE_IO, 'unpack', out, auditWork]), 'unpack output as auditor')
  assert.match(un.stdout, /manifest: carried from the input/)
  const st = JSON.parse(ok(py([BUNDLE_IO, 'status', auditWork]), 'status').stdout)
  assert.deepEqual(st.added, ['src/new.py'])
  assert.deepEqual(st.modified, ['src/app.py'])
  assert.deepEqual(st.deleted, ['src/old.txt'])
  assert.equal(readFileSync(join(auditWork, 'src/caller.py'), 'utf8'), 'from src.app import f\n')

  // The local unpacker applies the full snapshot and reports the untouched file as unchanged.
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'unpack-output.mjs'), out, '--repo', repo, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'no AUDIT.md in this synthetic bundle -> exit 1')
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.unchanged, ['src/caller.py'])
  assert.deepEqual(j.modified, ['src/app.py'])
  assert.deepEqual(j.added, ['src/new.py'])
  assert.deepEqual(j.deleted, ['src/old.txt'])
})
