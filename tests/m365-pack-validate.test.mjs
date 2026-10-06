import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LIMITS, checkAgentInstructions, validateSkillDir } from '../shared/skills/m365-skill-pack/scripts/lib/m365-rules.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACK = join(ROOT, 'shared/skills/m365-skill-pack/scripts/pack-skill.mjs')
const SKILL_MD = '---\nname: demo\ndescription: Use when testing.\n---\n\nDo the thing.\n'

function skillDir(files = {}, name = 'demo') {
  const dir = join(mkdtempSync(join(tmpdir(), 'm365pack-')), name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries({ 'SKILL.md': SKILL_MD, ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const problemsOf = (dir, opts) => validateSkillDir(dir, opts).problems

test('validator: accepts a plain skill and puts SKILL.md first', () => {
  const v = validateSkillDir(skillDir({ 'scripts/run.py': '#!/usr/bin/env python3\nprint(1)\n', 'resources/notes.md': '# n\n' }))
  assert.deepEqual(v.problems, [])
  assert.equal(v.name, 'demo')
  assert.deepEqual(v.entries.map((e) => e.name), ['SKILL.md', 'resources/notes.md', 'scripts/run.py'])
})

test('validator: rejects Windows script types with a targeted message', () => {
  for (const f of ['scripts/run.ps1', 'scripts/run.cmd', 'scripts/run.bat']) {
    const p = problemsOf(skillDir({ [f]: 'echo hi\n' }))
    assert.equal(p.length, 1, f)
    assert.match(p[0], /Windows script/)
  }
})

test('validator: rejects files without an extension, unknown extensions and dotfiles', () => {
  assert.match(problemsOf(skillDir({ 'scripts/Makefile': 'all:\n' }))[0], /no extension/)
  assert.match(problemsOf(skillDir({ 'data.parquet': 'x' }))[0], /not in the allowed/)
  assert.match(problemsOf(skillDir({ '.env': 'x' }))[0], /dotfile/)
})

test('validator: default depth is two nested directories', () => {
  assert.deepEqual(problemsOf(skillDir({ 'a/b/x.py': 'pass\n' })), [])
  assert.match(problemsOf(skillDir({ 'a/b/c/x.py': 'pass\n' }))[0], /nested 3/)
  assert.deepEqual(problemsOf(skillDir({ 'a/b/c/x.py': 'pass\n' }), { maxDepth: 3 }), [])
})

test('validator: missing SKILL.md, missing name, oversized instructions', () => {
  const noSkill = join(mkdtempSync(join(tmpdir(), 'm365pack-')), 'x')
  mkdirSync(noSkill)
  writeFileSync(join(noSkill, 'a.md'), 'x')
  assert.match(problemsOf(noSkill)[0], /SKILL.md is missing/)
  assert.match(problemsOf(skillDir({ 'SKILL.md': '---\ndescription: d\n---\nbody\n' }))[0], /`name`/)
  const big = `---\nname: demo\ndescription: d\n---\n${'x'.repeat(LIMITS.skillInstructionChars + 1)}\n`
  assert.match(problemsOf(skillDir({ 'SKILL.md': big }))[0], /must be under/)
})

test('validator: strips BOM and normalises CRLF, or fails under --strict', () => {
  const dir = skillDir({ 'SKILL.md': '﻿' + SKILL_MD.replace(/\n/g, '\r\n'), 'scripts/a.sh': '#!/bin/sh\r\necho\r\n' })
  const v = validateSkillDir(dir)
  assert.deepEqual(v.problems, [])
  assert.equal(v.notices.length, 3)
  for (const e of v.entries) {
    assert.ok(!e.data.includes(0x0d), `${e.name} has no CR`)
    assert.notEqual(e.data[0], 0xef)
  }
  const strict = validateSkillDir(dir, { strict: true })
  assert.equal(strict.problems.length, 3)
})

test('validator: --from-template renames SKILL.template.md and merges common/', () => {
  const base = mkdtempSync(join(tmpdir(), 'm365pack-'))
  const skill = join(base, 'implement')
  const common = join(base, 'common')
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  mkdirSync(join(common, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.template.md'), SKILL_MD.replace('demo', 'implement'))
  writeFileSync(join(skill, 'scripts/run.py'), 'pass\n')
  writeFileSync(join(common, 'scripts/io.py'), 'pass\n')
  assert.match(problemsOf(skill)[0], /SKILL.md is missing/)
  const v = validateSkillDir(skill, { fromTemplate: true, commonDir: common })
  assert.deepEqual(v.problems, [])
  assert.deepEqual(v.entries.map((e) => e.name), ['SKILL.md', 'scripts/io.py', 'scripts/run.py'])
})

test('validator: per-agent totals', () => {
  const files = {}
  for (let i = 0; i < LIMITS.filesPerAgent; i++) files[`r/f${i}.txt`] = 'x'
  const dir = skillDir(files)
  const r = spawnSync(process.execPath, [PACK, dir, '--out', join(dir, '..', 'out')], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /exceed the 350/)
  const nine = Array.from({ length: 9 }, (_, i) => skillDir({}, `s${i}`))
  const r2 = spawnSync(process.execPath, [PACK, ...nine, '--out', join(nine[0], '..', 'out')], { encoding: 'utf8' })
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /exceed the 8/)
})

test('pack-skill.mjs: writes <name>.zip and reports json', () => {
  const dir = skillDir({ 'scripts/run.py': 'pass\n' })
  const out = join(dir, '..', 'out')
  const r = spawnSync(process.execPath, [PACK, dir, '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.ok, true)
  assert.equal(j.results[0].zip, join(out, 'demo.zip'))
})

test('instructions mode: 8,000 character limit', () => {
  assert.deepEqual(checkAgentInstructions('x'.repeat(8000)).problems, [])
  assert.equal(checkAgentInstructions('x'.repeat(8001)).problems.length, 1)
  assert.equal(checkAgentInstructions('﻿abc').problems.length, 1)
  const f = join(mkdtempSync(join(tmpdir(), 'm365ins-')), 'i.md')
  writeFileSync(f, 'y'.repeat(8001))
  const r = spawnSync(process.execPath, [PACK, 'instructions', f], { encoding: 'utf8' })
  assert.equal(r.status, 1)
})

test('shipped templates pack cleanly and the agent sheets fit the limit', () => {
  const skills = join(ROOT, 'shared/skills/m365-skill-pack/m365/skills')
  const out = mkdtempSync(join(tmpdir(), 'm365ship-'))
  const r = spawnSync(process.execPath, [PACK, join(skills, 'implement'), join(skills, 'audit'), join(skills, 'probe'), '--from-template', '--out', out, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.results.map((x) => x.name).sort(), ['audit', 'implement', 'probe'])
  const plain = spawnSync(process.execPath, [PACK, join(skills, 'probe'), '--out', out], { encoding: 'utf8' })
  assert.equal(plain.status, 1, 'without --from-template there is no SKILL.md')
})

test('agent definition sheets: instruction blocks fit the Agent Builder limit', () => {
  for (const sheet of ['impl-loop.md', 'auditor.md']) {
    const r = spawnSync(process.execPath, [PACK, 'instructions', join(ROOT, 'shared/skills/m365-skill-pack/m365/agents', sheet), '--json'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const j = JSON.parse(r.stdout)
    assert.ok(j.chars > 1000 && j.chars <= LIMITS.agentInstructionChars, `${sheet}: ${j.chars} chars`)
  }
})
