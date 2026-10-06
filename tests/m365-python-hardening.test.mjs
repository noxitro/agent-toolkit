// bundle_io.py must refuse the same .git look-alikes as the JS side.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_IO = join(ROOT, 'shared/skills/m365-skill-pack/m365/skills/common/scripts/bundle_io.py')

function findPython() {
  for (const cand of [['python'], ['python3'], ['py', '-3']]) {
    const r = spawnSync(cand[0], [...cand.slice(1), '--version'], { encoding: 'utf8' })
    if (!r.error && r.status === 0) return cand
  }
  return null
}
const PY = findPython()

test('bundle_io.py unpack: refuses .git look-alikes and reserved characters, writes nothing', (t) => {
  if (!PY) return t.skip('no python interpreter on PATH')
  const tmp = mkdtempSync(join(tmpdir(), 'm365pyhard-'))
  const cases = {
    'gitcase.zip': '.GIT/hooks/pre-commit',
    'short.zip': 'GIT~1/hooks/pre-push',
    'trailing.zip': 'src/.git./x',
    'colon.zip': 'a:b/c',
    'dup.zip': null,
  }
  for (const [file, evil] of Object.entries(cases)) {
    const entries = [{ name: 'ok.txt', data: Buffer.from('fine\n') }, { name: '_m365/TASK.md', data: Buffer.from('# TASK t\n') }]
    if (evil) entries.push({ name: evil, data: Buffer.from('pwned\n') })
    else entries.push({ name: 'ok.txt', data: Buffer.from('again\n') })
    const zipPath = join(tmp, file)
    writeFileSync(zipPath, writeZip(entries))
    const work = join(tmp, `${file}-work`)
    const r = spawnSync(PY[0], [...PY.slice(1), BUNDLE_IO, 'unpack', zipPath, work], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    assert.equal(r.status, 1, `${file}: exit ${r.status}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, evil ? /unsafe path|\.git segment|reserved character|dot or space/ : /twice|duplicate/i, file)
    assert.ok(!existsSync(work), `${file}: nothing written`)
  }
})
