// The staged implementer of m365-skill-pack (scripts/lib/staged.mjs) behind a scripted fake
// port: plan parsing, one writer per file, retries, long files in parts, the cumulative
// bundle across rounds, and the whole thing inside runLoop.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatBundle, parseBundle, withProtocolFile } from '../shared/skills/m365-skill-pack/scripts/lib/bundle.mjs'
import { runLoop, sessionTokens } from '../shared/skills/m365-skill-pack/scripts/lib/external-loop.mjs'
import { createStagedImplementer, parseFileReply, parseMoreReply, parsePlan, splitHead } from '../shared/skills/m365-skill-pack/scripts/lib/staged.mjs'

const dir = mkdtempSync(join(tmpdir(), 'm365staged-'))
const SLUG = 'demo'
const FENCE = '`'.repeat(3)

function input(files) {
  const p = join(dir, `in-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(p, formatBundle({ task: SLUG, kind: 'input', files: files.map(([path, data]) => ({ path, data: Buffer.from(data) })) }))
  return p
}
const fileReply = (path, body, extra = '') => `### FILE ${path}\n${FENCE}text\n${body}\n${FENCE}\n${extra}`

// A port answering from a script keyed by role; it records every request.
function fakePort(script) {
  const requests = []
  let chats = 0
  return {
    requests,
    async send(req) {
      requests.push(req)
      const reply = script(req, requests.length)
      return { reply, chat: req.chat ?? `chat-${++chats}`, seconds: 1 }
    },
  }
}

test('plan lines, file replies and parts are parsed strictly', () => {
  assert.deepEqual(parsePlan('M365-STATUS: CONTINUE session=x round=1 as=impl\n\nFILE src/a.h | the interface\n- `FILE src/a.cpp | its body`\nDELETE old.txt\nFILE src/a.h | again'), {
    files: [{ path: 'src/a.h', purpose: 'the interface' }, { path: 'src/a.cpp', purpose: 'its body' }],
    deletes: ['old.txt'],
  })
  assert.throws(() => parsePlan('FILE ../escape.txt | no'))
  // A README with an inner three-backtick block inside a three-backtick fence comes back whole.
  const md = parseFileReply(`### FILE README.md\n${FENCE}markdown\n# t\n${FENCE}\ncmake ..\n${FENCE}\nend\n${FENCE}\nCONTINUES`, 'README.md')
  assert.equal(md.file.content, `# t\n${FENCE}\ncmake ..\n${FENCE}\nend\n`)
  assert.equal(md.continues, true)
  assert.match(parseFileReply(fileReply('b.txt', 'x'), 'a.txt').error, /asked for a.txt/)
  assert.match(parseFileReply('no section', 'a.txt').error, /no "### FILE" line/)
  assert.deepEqual(parseMoreReply(`${FENCE}cpp\nline 9\nline 10\n${FENCE}\nCONTINUES`), { text: 'line 9\nline 10\n', continues: true })
  assert.deepEqual(splitHead('session: s\nround: 2\nfinal: yes\nAttached: x'), { head: 'session: s\nround: 2\nfinal: yes', body: 'Attached: x' })
})

test('one round: plan, a writer per file in a new chat, a long file in parts, the bundle', async () => {
  const t = sessionTokens()
  const port = fakePort((req) => {
    if (req.role === 'plan') return `M365-STATUS: CONTINUE session=${t.a} round=1 as=impl\n\nFILE src/a.h | declares f\nFILE src/a.cpp | defines f\nDELETE old.txt`
    if (req.role === 'write' && req.path === 'src/a.h') return fileReply('src/a.h', 'int f();')
    if (req.role === 'write') return fileReply('src/a.cpp', 'int f() {', 'CONTINUES')
    return `${FENCE}\n  return 1;\n}\n${FENCE}`
  })
  const A = createStagedImplementer({ token: t.a, slug: SLUG, port, inputPaths: new Set(['old.txt']), workDir: join(dir, 'w1'), plannerInstructions: 'PLAN RULES', writerInstructions: 'WRITER RULES for {{PATH}}' })
  const inBundle = input([['old.txt', 'bye\n'], ['_m365/TASK.md', '# TASK demo\n']])
  const r = await A.turn(1, `session: ${t.a}\nround: 1\nAttached: in.md (the input bundle).`, [inBundle])

  assert.equal(r.files.length, 1)
  const out = parseBundle(readFileSync(r.files[0], 'utf8'))
  assert.deepEqual(out.files.map((f) => [f.path, f.content]), [['src/a.h', 'int f();\n'], ['src/a.cpp', 'int f() {\n  return 1;\n}\n']])
  assert.deepEqual(out.deletes, ['old.txt'])
  assert.deepEqual(port.requests.map((q) => q.role), ['plan', 'write', 'write', 'more'])
  const [plan, w1, w2, more] = port.requests
  assert.match(plan.text, /^session: .*\nround: 1\nstep: plan\n\nPLAN RULES\n/)
  assert.deepEqual(plan.attachments, [inBundle])
  assert.equal(w1.chat, null)
  assert.equal(w2.chat, null)
  assert.equal(more.chat, 'chat-3', 'the next part goes to the writer that wrote the first part')
  const ctx = readFileSync(w2.attachments[0], 'utf8')
  assert.match(ctx, /^WRITER RULES for src\/a\.cpp/)
  assert.match(ctx, /# TASK demo/)
  assert.match(ctx, /### FILE src\/a\.h\n/, 'a writer sees the files written before it')
})

test('a bad writer reply is asked again in a fresh chat, and giving up leaves no bundle', async () => {
  const t = sessionTokens()
  let bad = 0
  const port = fakePort((req) => {
    if (req.role === 'plan') return `M365-STATUS: CONTINUE session=${t.a} round=1 as=impl\nFILE a.txt | text`
    return ++bad < 3 ? 'Here is the file: a.txt' : fileReply('a.txt', 'ok')
  })
  const A = createStagedImplementer({ token: t.a, slug: SLUG, port, workDir: join(dir, 'w2') })
  const r = await A.turn(1, `session: ${t.a}\nround: 1`, [input([['_m365/TASK.md', '# TASK demo\n']])])
  assert.equal(r.files.length, 1)
  assert.match(readFileSync(port.requests[3].attachments[0], 'utf8'), /A previous reply for this file was rejected \(no "### FILE" line\)/)

  const never = fakePort((req) => (req.role === 'plan' ? `M365-STATUS: CONTINUE session=${t.a} round=1 as=impl\nFILE a.txt | text` : 'nothing'))
  const B = createStagedImplementer({ token: t.a, slug: SLUG, port: never, workDir: join(dir, 'w3'), maxAttempts: 2 })
  const g = await B.turn(1, `session: ${t.a}\nround: 1`, [input([])])
  assert.deepEqual(g.files, [])
  assert.match(g.detail, /no usable reply for a\.txt/)
})

test('inside runLoop: round 2 keeps round 1 files, rewrites the planned ones, PASS ends it', async () => {
  const t = sessionTokens()
  const port = fakePort((req) => {
    if (req.role === 'plan' && req.round === 1) return `M365-STATUS: CONTINUE session=${t.a} round=1 as=impl\nFILE a.txt | one\nFILE b.txt | two`
    if (req.role === 'plan' && req.round === 2) return `M365-STATUS: CONTINUE session=${t.a} round=2 as=impl\nFILE b.txt | two, fixed`
    if (req.role === 'plan') return `M365-STATUS: PASS session=${t.a} round=${req.round} as=impl`
    return fileReply(req.path, `${req.path} r${req.round}`)
  })
  const A = createStagedImplementer({ token: t.a, slug: SLUG, port, workDir: join(dir, 'w4'), inlineAttachments: true })
  const verdicts = ['FAIL', 'PASS']
  const B = {
    token: t.b,
    async turn(round) {
      const verdict = verdicts[round - 1]
      const audit = `# AUDIT\n\n${FENCE}json\n${JSON.stringify({ schema: 'm365-audit/1', task: SLUG, verdict, final_round: 1, max_rounds: 1, rounds: [{ round: 1, verdict, checks: [] }] })}\n${FENCE}\n`
      const p = join(dir, `audit-${SLUG}-r${round}.md`)
      writeFileSync(p, formatBundle({ task: SLUG, kind: 'audit', round, files: [{ path: '_m365/AUDIT.md', data: Buffer.from(audit) }] }))
      return { reply: `M365-STATUS: ${verdict} session=${t.b} round=${round} as=review\n`, files: [p] }
    },
  }
  const r = await runLoop({ A, B, slug: SLUG, inBundle: input([['_m365/TASK.md', '# TASK demo\n']]), maxRounds: 3, keep: (f) => f })
  assert.equal(r.outcome, 'pass')
  assert.equal(r.rounds, 2)
  const out = parseBundle(readFileSync(r.lastOut, 'utf8'))
  assert.deepEqual(out.files.map((f) => [f.path, f.content]), [['a.txt', 'a.txt r1\n'], ['b.txt', 'b.txt r2\n']])
  const plan2 = port.requests.find((q) => q.role === 'plan' && q.round === 2)
  assert.match(plan2.text, /=== ATTACHED: audit-demo-r1\.md ===/, 'inline mode puts the review into the plan message')
  assert.deepEqual(plan2.attachments, [])
})

test('a protocol file such as the build log is added to a bundle, never a repository file', () => {
  const b = formatBundle({ task: SLUG, kind: 'output', files: [{ path: 'a.txt', data: Buffer.from('x\n') }], skipped: [{ path: 'i.png', reason: 'binary' }] })
  const once = withProtocolFile(b, '_m365/BUILD.log', 'BUILD: FAIL\nsrc/a.cpp(3): error C2065')
  const twice = withProtocolFile(once, '_m365/BUILD.log', 'BUILD: PASS')
  const parsed = parseBundle(twice)
  assert.deepEqual(parsed.files.map((f) => [f.path, f.content]), [['a.txt', 'x\n'], ['_m365/BUILD.log', 'BUILD: PASS\n']])
  assert.equal(parsed.skipped.length, 1)
  assert.throws(() => withProtocolFile(b, 'src/a.cpp', 'no'), /not a protocol path/)
})
