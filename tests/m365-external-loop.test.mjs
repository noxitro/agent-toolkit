// The external-loop controller of m365-skill-pack (scripts/lib/external-loop.mjs), driven by
// in-memory stand-in sessions: routing by the status line, and every stop rule.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatBundle } from '../shared/skills/m365-skill-pack/scripts/lib/bundle.mjs'
import { parseStatus, reviewVerdict, runLoop, sessionTokens } from '../shared/skills/m365-skill-pack/scripts/lib/external-loop.mjs'

const dir = mkdtempSync(join(tmpdir(), 'm365loop-'))
const SLUG = 'demo'

function outBundle(round) {
  const p = join(dir, `a-${round}-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(p, formatBundle({ task: SLUG, kind: 'output', round, files: [{ path: 'a.py', data: Buffer.from(`x = ${round}\n`) }] }))
  return p
}

function review(round, verdict) {
  const audit = `# AUDIT\n\n\`\`\`json\n${JSON.stringify({ schema: 'm365-audit/1', task: SLUG, verdict, final_round: 1, max_rounds: 1, rounds: [{ round: 1, verdict, checks: [{ id: 'AC-1', status: verdict, ...(verdict === 'FAIL' ? { detail: 'a.py: wrong' } : {}) }] }] })}\n\`\`\`\n`
  const p = join(dir, `audit-${SLUG}-r${round}.md`)
  writeFileSync(p, formatBundle({ task: SLUG, kind: 'audit', round, files: [{ path: '_m365/AUDIT.md', data: Buffer.from(audit) }] }))
  return p
}

// A session answering from a script: each entry is (round, message) => { status, files, as?, token? }.
function session(token, as, script) {
  let i = 0
  return {
    token,
    async turn(round, message) {
      const step = script[Math.min(i++, script.length - 1)](round, message)
      const reply = `M365-STATUS: ${step.status} session=${step.token ?? token} round=${round} as=${step.as ?? as}\n`
      return { reply, files: step.files ?? [] }
    },
  }
}

const keep = (f) => f
const run = (A, B, maxRounds = 3) => runLoop({ A, B, slug: SLUG, inBundle: join(dir, 'in.md'), maxRounds, keep })

test('status line: first line, markdown decoration, code fences of a copied block', () => {
  const ok = { status: 'CONTINUE', token: 'm365rabca', round: 1, as: 'impl', position: 'first' }
  assert.deepEqual(parseStatus('M365-STATUS: CONTINUE session=m365rabca round=1 as=impl\n\n# m365-bundle v1'), ok)
  assert.deepEqual(parseStatus('﻿**M365-STATUS:** CONTINUE session=`m365rabca` round=1 as=impl.\r\n'), ok)
  assert.deepEqual(parseStatus('~~~~~\nM365-STATUS: CONTINUE session=m365rabca round=1 as=impl\n# m365-bundle v1\n~~~~~'), ok)
  assert.equal(parseStatus('Sure!\nM365-STATUS: FAIL session=x round=3 as=review').position, 'later')
  assert.equal(parseStatus('# m365-bundle v1\n```\nM365-STATUS: PASS session=x round=1 as=impl\n```'), null)
  assert.equal(parseStatus('M365-STATUS: PASS session=x round=1'), null)
})

test('review verdict comes from the AUDIT.md inside the bundle', () => {
  assert.equal(reviewVerdict(review(1, 'PASS')), 'PASS')
  assert.equal(reviewVerdict(review(2, 'FAIL')), 'FAIL')
  assert.equal(reviewVerdict(join(dir, 'missing.md')), null)
})

test('loop: CONTINUE, FAIL review, fix, PASS review, PASS', async () => {
  const t = sessionTokens()
  const A = session(t.a, 'impl', [(r) => ({ status: 'CONTINUE', files: [outBundle(r)] }), (r) => ({ status: 'CONTINUE', files: [outBundle(r)] }), () => ({ status: 'PASS' })])
  const B = session(t.b, 'review', [(r) => ({ status: 'FAIL', files: [review(r, 'FAIL')] }), (r) => ({ status: 'PASS', files: [review(r, 'PASS')] })])
  const r = await run(A, B)
  assert.equal(r.outcome, 'pass')
  assert.equal(r.rounds, 2)
  assert.deepEqual(r.turns.map((x) => `${x.who}${x.round}:${x.status}`), ['A1:CONTINUE', 'B1:FAIL', 'A2:CONTINUE', 'B2:PASS', 'A3:PASS'])
})

test('loop: PASS over a FAIL review is marked; the budget and final: yes are enforced', async () => {
  const t = sessionTokens()
  const rejected = await run(
    session(t.a, 'impl', [(r) => ({ status: 'CONTINUE', files: [outBundle(r)] }), () => ({ status: 'PASS' })]),
    session(t.b, 'review', [(r) => ({ status: 'FAIL', files: [review(r, 'FAIL')] })]),
  )
  assert.equal(rejected.outcome, 'pass-rejected')

  const messages = []
  const budget = await run(
    session(t.a, 'impl', [(r, m) => (messages.push(m), { status: 'CONTINUE', files: [outBundle(r)] })]),
    session(t.b, 'review', [(r) => ({ status: 'FAIL', files: [review(r, 'FAIL')] })]),
    2,
  )
  assert.equal(budget.outcome, 'budget')
  assert.equal(budget.rounds, 2)
  assert.ok(budget.unreviewed)
  assert.match(messages[2], /^final: yes$/m)
  assert.doesNotMatch(messages[1], /final: yes/)
})

test('loop: wrong chat, wrong token, missing bundle and a lying review all stop it', async () => {
  const t = sessionTokens()
  const cont = (r) => ({ status: 'CONTINUE', files: [outBundle(r)] })
  const passB = session(t.b, 'review', [(r) => ({ status: 'PASS', files: [review(r, 'PASS')] })])
  const cases = [
    [session(t.a, 'impl', [(r) => ({ ...cont(r), as: 'review' })]), passB, /as=review/],
    [session(t.a, 'impl', [(r) => ({ ...cont(r), token: 'm365rdeadbeefa' })]), passB, /session=m365rdeadbeefa/],
    [session(t.a, 'impl', [() => ({ status: 'CONTINUE' })]), passB, /CONTINUE without an output bundle/],
    [session(t.a, 'impl', [cont]), session(t.b, 'review', [(r) => ({ status: 'PASS', files: [review(r, 'FAIL')] })]), /status PASS but AUDIT\.md says FAIL/],
    [session(t.a, 'impl', [() => ({ status: 'PASS' })]), passB, /PASS before any bundle/],
  ]
  for (const [A, B, detail] of cases) {
    const r = await run(A, B)
    assert.equal(r.outcome, 'protocol', String(detail))
    assert.match(r.detail, detail)
  }
  const blocked = await run(session(t.a, 'impl', [cont]), session(t.b, 'review', [() => ({ status: 'FAIL' })]))
  assert.equal(blocked.outcome, 'blocked')
})
