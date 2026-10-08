// Tests for the imported public skills under m365-org-skills/third-party and for the agent
// sheets under m365-org-skills/agents. The packages are assembled by
// m365-org-skills/scout/import-upstream.mjs from upstream clones; these tests need no network and check
// that the assembled packages still carry the upstream text untouched, the license, the
// Japanese adaptation section, and that every sheet names only skills that exist.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORG = join(ROOT, 'm365-org-skills')
const TP = join(ORG, 'third-party')
const PACKER = join(ROOT, 'shared/skills/m365-skill-pack/scripts/pack-skill.mjs')
const CFG = JSON.parse(readFileSync(join(TP, 'overlays.json'), 'utf8'))
const DIR = mkdtempSync(join(tmpdir(), 'm365-org-tp-'))
after(() => rmSync(DIR, { recursive: true, force: true }))

const lf = (s) => s.replace(/\r\n/g, '\n')

function splitFrontmatter(text) {
  assert.ok(text.startsWith('---\n'), 'frontmatter')
  const end = text.indexOf('\n---\n', 4)
  assert.ok(end > 0, 'frontmatter end')
  return { fm: text.slice(4, end), body: text.slice(end + 5) }
}

for (const skill of CFG.skills) {
  test(`third-party ${skill.name}: upstream text kept, license and adaptation added`, () => {
    const dir = join(TP, skill.name)
    const pkg = lf(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
    const upstream = lf(readFileSync(join(TP, '_upstream', `${skill.name}.SKILL.md`), 'utf8'))
    const p = splitFrontmatter(pkg)
    const u = splitFrontmatter(upstream)

    assert.match(p.fm, new RegExp(`^name: ${skill.name}$`, 'm'))
    assert.ok(p.fm.includes(skill.trigger_ja), 'Japanese trigger words in the description')
    assert.ok(p.body.includes(CFG.common[0]), 'adaptation section heading')
    for (const line of skill.extra || []) assert.ok(p.body.includes(line), `extra line: ${line.slice(0, 30)}`)

    const marker = '\n## 原文\n\n'
    const at = p.body.indexOf(marker)
    assert.ok(at > 0, 'original-text marker')
    assert.equal(p.body.slice(at + marker.length), u.body.replace(/^\n+/, ''), 'original body unchanged')

    const license = readFileSync(join(dir, 'LICENSE.txt'), 'utf8')
    assert.match(license, /MIT License/)
    assert.match(license, /Permission is hereby granted/)
    const source = readFileSync(join(dir, 'SOURCE.md'), 'utf8')
    assert.match(source, new RegExp(`${skill.repo.replace('/', '\\/')}`))
    assert.match(source, /コミット `[0-9a-f]{40}`/)
    for (const rel of skill.files) assert.ok(existsSync(join(dir, ...rel.split('/'))), rel)
  })
}

test('third-party: every package passes the Agent Builder packer', () => {
  const dirs = CFG.skills.map((s) => join(TP, s.name))
  const r = spawnSync(process.execPath, [PACKER, ...dirs, '--out', DIR, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.results.map((x) => x.name).sort(), CFG.skills.map((s) => s.name).sort())
})

test('agent sheets: each names at most 8 skills, all of which exist', () => {
  const known = new Set([
    ...readdirSync(join(ORG, 'skills')).filter((n) => n !== 'common'),
    ...CFG.skills.map((s) => s.name),
    'probe',
  ])
  const sheets = readdirSync(join(ORG, 'agents')).filter((n) => n.endsWith('.md'))
  assert.ok(sheets.length >= 1)
  for (const sheet of sheets) {
    const text = readFileSync(join(ORG, 'agents', sheet), 'utf8')
    const named = new Set([...text.matchAll(/`([a-z0-9-]+)\.zip`/g)].map((m) => m[1]))
    assert.ok(named.size >= 1 && named.size <= 8, `${sheet}: ${named.size} skills`)
    for (const n of named) assert.ok(known.has(n), `${sheet} names unknown skill ${n}`)
    const r = spawnSync(process.execPath, [PACKER, 'instructions', join(ORG, 'agents', sheet)], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${sheet}: ${r.stderr || r.stdout}`)
  }
})
