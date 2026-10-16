// The staged implementer for the external loop (references/loop-protocol.md, "Staged
// implementer"): session A only plans each round - its reply is the status line plus one
// line per file saying what that file must do - and every planned file is written by a
// writer in a chat of its own, from that line and an attached context file. This module
// assembles the cumulative output bundle, so runLoop and session B see exactly what they see
// from an unstaged session A.
//
// Why: asked for a whole round in one reply, a Microsoft 365 Copilot chat returned stubs and
// empty bundles on a multi-file task; asked in a fresh chat for one file with the context
// attached, it wrote the whole file. The chat itself stays behind a port, so the same module
// runs on a person relaying, on a UI Automation driver for one Copilot app or another, or
// on a test fake.
//
// A port is { send(request) -> Promise<{ reply, chat, seconds? }> } where request is
//   role:        'plan'  - session A's own chat (one per run)
//                'write' - a file writer; `chat` is null, so the port opens a new chat
//                'more'  - the next part of a long file, in the writer's chat
//   chat:        an id the port returned before, or null for a new chat
//   text:        the message; it never needs a blank line
//   attachments: local files to attach (the context file; the bundles of a plan turn
//                unless `inlineAttachments`)
//   marker:      a line of `text` unique to this message, to find it in the conversation
//   round, path: for logs
// The port returns the reply as text and the id of the chat it used.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertSafePath, formatBundle, parseBundle } from './bundle.mjs'
import { parseStatus } from './external-loop.mjs'

const ROUTING_RE = /^(session|round|final|step):/

/** The routing lines a loop message starts with (`session:`, `round:`, `final:`) and the rest. */
export function splitHead(message) {
  const lines = String(message).split('\n')
  const i = lines.findIndex((l) => !ROUTING_RE.test(l))
  const k = i === -1 ? lines.length : i
  return { head: lines.slice(0, k).join('\n'), body: lines.slice(k).join('\n') }
}

/** `FILE <path> | <purpose>` and `DELETE <path>` lines of a plan reply. */
export function parsePlan(reply) {
  const files = []
  const deletes = []
  for (const raw of String(reply).replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*[-*]?\s*`?(FILE|DELETE)\s+([^\s`|]+)\s*(?:\|\s*(.*?))?`?\s*$/.exec(raw)
    if (!m) continue
    const path = assertSafePath(m[2].trim())
    if (m[1] === 'DELETE') {
      if (!deletes.includes(path)) deletes.push(path)
    } else if (!files.some((f) => f.path === path)) {
      files.push({ path, purpose: (m[3] ?? '').trim() })
    }
  }
  return { files, deletes }
}

/**
 * The FILE section of a writer's reply. The file's fence closes at the last line equal to
 * its opening fence, so a Markdown file holding three-backtick blocks inside a
 * three-backtick fence still comes back whole. `continues`: a CONTINUES line follows.
 */
export function parseFileReply(reply, path) {
  const lines = String(reply).replace(/\r\n?/g, '\n').split('\n')
  const k = lines.findIndex((l) => l.startsWith('### FILE '))
  if (k === -1) return { error: 'no "### FILE" line' }
  const got = lines[k].slice('### FILE '.length).replace(/\s+\[[a-z,]+\]$/, '').trim()
  if (got !== path) return { error: `FILE ${got}, asked for ${path}` }
  const open = /^(`{3,})/.exec(lines[k + 1] ?? '')
  if (!open) return { error: 'no fence after the FILE line' }
  let j = -1
  for (let x = lines.length - 1; x > k + 1; x--) {
    if (lines[x].trim() === open[1]) {
      j = x
      break
    }
  }
  if (j === -1) return { error: 'the fence of the file is not closed' }
  const body = lines.slice(k + 2, j)
  return {
    file: { path, content: body.length ? `${body.join('\n')}\n` : '' },
    continues: lines.slice(j + 1).some((l) => l.trim() === 'CONTINUES'),
  }
}

/** The next lines of a long file; a stray fence around them and CONTINUES are not content. */
export function parseMoreReply(reply) {
  const lines = String(reply).replace(/\r\n?/g, '\n').split('\n')
  const continues = lines.some((l) => l.trim() === 'CONTINUES')
  let body = lines.filter((l) => l.trim() !== 'CONTINUES')
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body[body.length - 1].trim()) body.pop()
  if (body.length >= 2 && /^`{3,}[\w+-]*$/.test(body[0].trim()) && /^`{3,}$/.test(body[body.length - 1].trim())) body = body.slice(1, -1)
  if (!body.length) return { error: 'no lines' }
  return { text: `${body.join('\n')}\n`, continues }
}

function readBundleFiles(file) {
  try {
    return parseBundle(readFileSync(file, 'utf8')).files
  } catch {
    return []
  }
}

/**
 * Session A for runLoop, staged.
 * - token, slug: as for any session; inputPaths: Set of the input bundle's file paths (a
 *   DELETE of a file that was not in the input just drops it from the bundle).
 * - port: see the top of this file. workDir: where context files and replies are kept.
 * - plannerInstructions: text put into the first plan message (null when the planner is a
 *   custom agent that already has its instructions). writerInstructions: text put at the
 *   top of every context file (null for a writer agent with instructions of its own).
 * - inlineAttachments: put the bundles of a plan turn into the message text as
 *   `=== ATTACHED: <name> ===` blocks instead of attaching them.
 * - includeRepository: the context file holds every repository file (small repositories);
 *   otherwise only the files written so far and the current content of the planned file.
 * - onEvent(event): progress for logs ({ type: 'plan' | 'file' | 'more' | 'gave-up', ... }).
 */
export function createStagedImplementer({
  token, slug, port, inputPaths = new Set(), workDir,
  plannerInstructions = null, writerInstructions = null,
  inlineAttachments = false, includeRepository = true,
  maxAttempts = 3, maxParts = 12, onEvent = () => {},
}) {
  const state = { turns: 0, planChat: null, files: new Map(), deletes: new Set() }
  return {
    token,
    async turn(round, message, attachments) {
      state.turns++
      const roundDir = join(workDir, `r${round}`)
      mkdirSync(roundDir, { recursive: true })
      const { head, body } = splitHead(message)
      const planHead = `${head}\nstep: plan`
      const blocks = inlineAttachments ? attachments.map((a) => `=== ATTACHED: ${basename(a)} ===\n${readFileSync(a, 'utf8')}`).join('\n') : ''
      const intro = state.turns === 1 && plannerInstructions ? `\n${plannerInstructions}\n` : ''
      const text = `${planHead}\n${intro}${body}${blocks ? `\n${blocks}` : ''}`
      const planned = await port.send({ role: 'plan', chat: state.planChat, text, attachments: inlineAttachments ? [] : attachments, marker: head || planHead, round })
      state.planChat = planned.chat ?? state.planChat
      let seconds = planned.seconds ?? 0
      const reply = planned.reply
      writeFileSync(join(roundDir, 'plan.reply.md'), reply)
      if (parseStatus(reply)?.status !== 'CONTINUE') return { reply, files: [], seconds }
      const plan = parsePlan(reply)
      writeFileSync(join(roundDir, 'plan.json'), JSON.stringify(plan, null, 2))
      onEvent({ type: 'plan', round, files: plan.files.length, deletes: plan.deletes.length })

      // What the writers see: the repository as it stands (the input in round 1, the
      // whole-repository view of the work so far later), the task, the review, the build log.
      const repoFiles = attachments[0] ? readBundleFiles(attachments[0]) : []
      const protocol = (p) => repoFiles.find((f) => f.path === p)?.content ?? ''
      const review = attachments[1] ? readFileSync(attachments[1], 'utf8') : ''
      const written = []
      const contextFile = (i, item, attempt, lastError) => {
        const now = new Map()
        for (const f of repoFiles) {
          if (f.path.startsWith('_m365/')) continue
          if (includeRepository || f.path === item.path || state.files.has(f.path)) now.set(f.path, f)
        }
        for (const [p, f] of state.files) now.set(p, f)
        for (const p of plan.deletes) now.delete(p)
        for (const f of written) now.set(f.path, f)
        const listing = repoFiles.filter((f) => !f.path.startsWith('_m365/')).map((f) => f.path)
        const name = `write-r${round}-f${String(i + 1).padStart(2, '0')}-t${attempt}.txt`
        const file = join(roundDir, name)
        writeFileSync(file, [
          ...(writerInstructions ? [writerInstructions.replaceAll('{{PATH}}', item.path).replaceAll('{{PURPOSE}}', item.purpose || '(see the task contract)')] : []),
          '=== THE FILE TO WRITE ===', `Path: ${item.path}`, `What it must contain and do (from the implementer's plan): ${item.purpose || '(see the task contract)'}`, '',
          ...(attempt > 1 ? [`A previous reply for this file was rejected (${lastError}). Follow the reply format exactly.`, ''] : []),
          '=== THE TASK CONTRACT: _m365/TASK.md ===', protocol('_m365/TASK.md'),
          ...(review ? ['=== THE REVIEW BEING FIXED ===', review] : []),
          ...(protocol('_m365/BUILD.log') ? ['=== THE LATEST REAL BUILD OF THE REPOSITORY (every error in it is a defect to fix) ===', protocol('_m365/BUILD.log')] : []),
          ...(includeRepository ? [] : ['=== EVERY FILE OF THE REPOSITORY (paths) ===', ...listing, '']),
          `=== ${includeRepository ? 'THE REPOSITORY AS IT STANDS' : 'THE FILES WRITTEN SO FAR AND THE CURRENT CONTENT OF THIS FILE'} (bundle) ===`,
          formatBundle({ task: slug, kind: 'output', round, files: [...now.values()].map((f) => ({ path: f.path, data: Buffer.from(f.content, 'utf8') })) }),
        ].join('\n'))
        return { file, name }
      }

      for (const [i, item] of plan.files.entries()) {
        let got = null
        let lastError = ''
        let writerChat = null
        for (let attempt = 1; attempt <= maxAttempts && !got; attempt++) {
          const ctx = contextFile(i, item, attempt, lastError)
          const marker = `writer: ${slug} r${round} f${i + 1} t${attempt}`
          const r = await port.send({ role: 'write', chat: null, text: `${marker}\nFollow the attached ${ctx.name}: write the file it describes.`, attachments: [ctx.file], marker, round, path: item.path })
          seconds += r.seconds ?? 0
          writeFileSync(join(roundDir, `${String(i + 1).padStart(2, '0')}-t${attempt}.reply.md`), r.reply)
          const f = parseFileReply(r.reply, item.path)
          onEvent({ type: 'file', round, index: i + 1, of: plan.files.length, path: item.path, attempt, error: f.error ?? null, lines: f.file ? f.file.content.split('\n').length - 1 : 0, seconds: r.seconds ?? 0 })
          if (f.error) lastError = f.error
          else {
            got = f
            writerChat = r.chat ?? null
          }
        }
        if (!got) {
          onEvent({ type: 'gave-up', round, path: item.path, error: lastError })
          return { reply, files: [], seconds, detail: `no usable reply for ${item.path} (${lastError})` }
        }
        let content = got.file.content
        let more = got.continues
        for (let part = 2; more && part <= maxParts; part++) {
          const marker = `writer: ${slug} r${round} f${i + 1} p${part}`
          const r = await port.send({ role: 'more', chat: writerChat, text: `${marker}\nSend the next lines of ${item.path}.`, attachments: [], marker, round, path: item.path })
          seconds += r.seconds ?? 0
          writeFileSync(join(roundDir, `${String(i + 1).padStart(2, '0')}-p${part}.reply.md`), r.reply)
          const m = parseMoreReply(r.reply)
          onEvent({ type: 'more', round, path: item.path, part, error: m.error ?? null, lines: m.text ? m.text.split('\n').length - 1 : 0, seconds: r.seconds ?? 0 })
          if (m.error) break
          content += m.text
          more = m.continues
        }
        written.push({ path: item.path, content })
      }

      for (const p of plan.deletes) {
        state.files.delete(p)
        if (inputPaths.has(p)) state.deletes.add(p)
      }
      for (const f of written) {
        state.files.set(f.path, f)
        state.deletes.delete(f.path)
      }
      const out = join(roundDir, `out-${slug}-r${round}.md`)
      writeFileSync(out, formatBundle({
        task: slug, kind: 'output', round,
        files: [...state.files.values()].map((f) => ({ path: f.path, data: Buffer.from(f.content, 'utf8') })),
        deletes: [...state.deletes],
      }))
      return { reply, files: [out], seconds }
    },
  }
}
