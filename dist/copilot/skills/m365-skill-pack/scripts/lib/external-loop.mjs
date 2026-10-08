// The script-driven loop of references/loop-protocol.md ("External loop"): two sessions,
// A (impl-session) and B (review-session), and this controller carrying bundles between
// them. It only reads the status line of each reply to route it, and stops on anything it
// does not expect instead of guessing. Sessions are passed in, so the same controller runs
// against a person relaying to Microsoft 365 Copilot, a test fake - or, later, a UI
// Automation driver.
//
// A session is { token, turn(round, message, attachments) -> Promise<{ reply, files }> }.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseAuditSummary } from './bundle.mjs'
import { readZip } from './unzip.mjs'

const STATUS_RE = /^M365-STATUS:\s*(CONTINUE|PASS|FAIL)\s+session=(\S+)\s+round=(\d+)\s+as=(impl|review)\.?$/i
const ROLE_OF = { A: 'impl', B: 'review' }

/** Escapes a string for use inside a RegExp (slugs may contain dots). */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Thrown by the `implemented` hook when A's bundle cannot be applied: the loop stops. */
export class LoopStop extends Error {}

/** One base for both sessions of a run; the last letter tells them apart (a = A, b = B). */
export function sessionTokens() {
  const base = `m365r${randomBytes(4).toString('hex')}`
  return { a: `${base}a`, b: `${base}b` }
}

/**
 * The status line. Expected on the first line; found later (but still before the bundle)
 * it is accepted and recorded as "later". Text inside the bundle is never looked at, so a
 * status line quoted in a file cannot route the loop. Missing: null.
 */
export function parseStatus(reply) {
  const all = String(reply ?? '').replace(/^﻿/, '').split(/\r?\n/)
  const end = all.findIndex((l) => l.trim() === '# m365-bundle v1')
  const lines = (end === -1 ? all : all.slice(0, end)).map((l) => l.replace(/[*`]/g, '').replace(/^[>#\s]+/, '').trim())
  let position = 'first'
  for (const l of lines) {
    if (!l) continue
    const m = STATUS_RE.exec(l)
    if (m) return { status: m[1].toUpperCase(), token: m[2], round: Number(m[3]), as: m[4].toLowerCase(), position }
    position = 'later'
  }
  return null
}

/** Verdict of the AUDIT.md inside a review bundle (.zip or text bundle), or null. */
export function reviewVerdict(file) {
  try {
    let text
    if (/\.zip$/i.test(file)) {
      const e = readZip(readFileSync(file)).find((x) => x.name === '_m365/AUDIT.md')
      text = e?.data.toString('utf8')
    } else {
      const m = /### FILE _m365\/AUDIT\.md\n(`{3,})[^\n]*\n([\s\S]*?)\n\1(?:\n|$)/.exec(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
      text = m?.[2]
    }
    const s = text ? parseAuditSummary(text) : null
    return s && !s.error ? s.summary.verdict : null
  } catch {
    return null
  }
}

export function messageToA(token, round, attachments, final = false) {
  const names = attachments.map((a) => basename(a))
  const body = round === 1
    ? `Attached: ${names[0]} (the input bundle). Implement round 1 as your instructions describe.`
    : `Attached: ${names[0]} (your latest output bundle) and ${names[1]} (the review from session B). Weigh each finding and reply as your instructions describe.`
  return `session: ${token}\nround: ${round}\n${final ? 'final: yes\n' : ''}${body}\n`
}

export function messageToB(token, round, attachments) {
  return `session: ${token}\nround: ${round}\nAttached: ${basename(attachments[0])} (the implementer's work after round ${round}). Review it as your instructions describe.\n`
}

/**
 * Run the loop. Returns { outcome, detail, rounds, turns, lastOut, lastReview, lastReviewStatus, unreviewed }.
 * outcome: pass | pass-rejected | blocked | budget | protocol
 * rounds: how many output bundles A produced that were applied (its implementing rounds).
 * `keep(file, name)` copies a returned file somewhere durable and returns the new path.
 * `implemented(outFile, round)` applies A's bundle to the working copy and returns what B
 * is handed (the bundle itself, or a full snapshot when A's bundle holds only changes);
 * it throws LoopStop when the bundle cannot be applied.
 */
export async function runLoop({ A, B, slug, inBundle, maxRounds, keep, implemented = (f) => f }) {
  const turns = []
  const esc = escapeRe(slug)
  const outRe = new RegExp(`^out-${esc}-r(\\d+)\\.(zip|md)$`)
  const auditRe = new RegExp(`^audit-${esc}-r(\\d+)\\.(zip|md)$`)
  let lastOut = null
  let lastReview = null
  let lastReviewStatus = null
  let unreviewed = null
  let rounds = 0
  let round = 1
  const stop = (outcome, detail) => ({ outcome, detail, rounds, turns, lastOut, lastReview, lastReviewStatus, unreviewed })
  const check = (who, s) => {
    if (!s) return `${who} round ${round}: no status line`
    const session = who === 'A' ? A : B
    if (s.as !== ROLE_OF[who]) return `${who} round ${round}: reply says as=${s.as} - sent to the wrong chat?`
    if (s.token !== session.token || s.round !== round) return `${who} round ${round}: status line for session=${s.token} round=${s.round}`
    return null
  }

  let attachments = [inBundle]
  for (;;) {
    const final = round > maxRounds
    const a = await A.turn(round, messageToA(A.token, round, attachments, final), attachments)
    const sa = parseStatus(a.reply)
    turns.push({ who: 'A', round, status: sa?.status ?? null, position: sa?.position ?? null, files: a.files.map((f) => basename(f)), seconds: a.seconds ?? null })
    const badA = check('A', sa)
    if (badA) return stop('protocol', badA)
    if (sa.status === 'FAIL') return stop('blocked', `A round ${round}: FAIL`)
    if (sa.status === 'PASS') {
      if (!lastOut) return stop('protocol', 'A answered PASS before any bundle was reviewed')
      return stop(lastReviewStatus === 'FAIL' ? 'pass-rejected' : 'pass', lastReviewStatus === 'FAIL' ? 'A rejected the findings of the last review' : null)
    }
    const out = a.files.find((f) => outRe.test(basename(f))) ?? a.files.find((f) => /\.(zip|md)$/i.test(f))
    if (!out) return stop('protocol', `A round ${round}: CONTINUE without an output bundle`)
    const ext = /\.md$/i.test(out) ? '.md' : '.zip'
    if (final) {
      // Told it was the last round, A still wanted another review: the bundle is kept for a
      // person but never applied, and lastOut stays the last reviewed one.
      unreviewed = keep(out, `out-${slug}-r${round}-unreviewed${ext}`)
      return stop('budget', `A answered CONTINUE in round ${round}; the budget is ${maxRounds}`)
    }
    const kept = keep(out, `out-${slug}-r${round}${ext}`)
    let forReview
    try {
      forReview = await implemented(kept, round)
    } catch (e) {
      if (e instanceof LoopStop) return stop('protocol', `A round ${round}: ${e.message}`)
      throw e
    }
    lastOut = kept
    rounds = round

    const b = await B.turn(round, messageToB(B.token, round, [forReview]), [forReview])
    const sb = parseStatus(b.reply)
    turns.push({ who: 'B', round, status: sb?.status ?? null, position: sb?.position ?? null, files: b.files.map((f) => basename(f)), seconds: b.seconds ?? null })
    const badB = check('B', sb)
    if (badB) return stop('protocol', badB)
    const rev = b.files.find((f) => auditRe.test(basename(f))) ?? b.files.find((f) => /\.(zip|md)$/i.test(f))
    if (!rev) {
      // B may only answer FAIL without a review when it could not read the bundle.
      if (sb.status === 'FAIL') return stop('blocked', `B round ${round}: FAIL without a review (the bundle could not be read)`)
      return stop('protocol', `B round ${round}: PASS without a review bundle`)
    }
    lastReview = keep(rev, `audit-${slug}-r${round}${/\.md$/i.test(rev) ? '.md' : '.zip'}`)
    const verdict = reviewVerdict(lastReview)
    if (verdict !== sb.status) return stop('protocol', `B round ${round}: status ${sb.status} but AUDIT.md says ${verdict ?? 'nothing readable'}`)
    lastReviewStatus = sb.status

    round++
    attachments = [lastOut, lastReview]
  }
}
