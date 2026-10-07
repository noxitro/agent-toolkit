#!/usr/bin/env node
// Apply an output bundle from Microsoft 365 Copilot to the repository and report the
// audit verdict. Accepts a .zip or a Markdown bundle. Protocol files under _m365/ go
// to the reports directory, never into the repository. Nothing is committed.
//
//   node unpack-output.mjs <out.zip|out.md> [--repo <dir>] [--reports <dir>] [--dry-run] [--force] [--json]
//
// Exit code: 3 = conflicts left unresolved (takes precedence), otherwise 0 = PASS, 2 = FAIL,
// 1 = error or no usable AUDIT.md.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs, usage } from './lib/args.mjs'
import { PROTOCOL_PREFIX, assertSafePath, isGitSegment, isProtocolPath, isSafeSlug, matchLineEndings, parseAuditSummary, parseBundle } from './lib/bundle.mjs'
import { readZip } from './lib/unzip.mjs'

const HELP = `
Usage: node unpack-output.mjs <out.zip|out.md> [options]

  --repo <dir>      repository root to write into (default: current directory)
  --reports <dir>   where _m365/* files go (default: <repo>/.m365/<slug>/reports)
  --dry-run         report what would change without writing
  --force           overwrite files that changed both locally and in the sandbox
  --json            machine-readable summary

With a bundle from \`pack --full\` the apply is three-way against the input snapshot:
files the sandbox left untouched keep their local copy, and a file changed on both
sides is reported as a conflict and left alone unless --force is given. A bundle
without _m365/manifest.json is applied as a plain overwrite.
Exit: 3 conflicts (takes precedence), 0 PASS, 2 FAIL, 1 error or no usable AUDIT.md.
`

let args
try {
  args = parseArgs(process.argv.slice(2), { repo: 'string', reports: 'string', 'dry-run': 'bool', force: 'bool', json: 'bool', help: 'bool' })
} catch (e) {
  usage(`${e.message}\n${HELP}`)
}
const { opts, positionals } = args
if (opts.help || positionals.length !== 1) usage(HELP, opts.help ? 0 : 1)

const file = resolve(positionals[0])
const repo = resolve(opts.repo ?? process.cwd())
const raw = readFileSync(file)

// ------------------------------------------------------------ read bundle
/** @type {{ path: string, data: Buffer }[]} */
let files = []
let deletes = []
let task = null
const isZip = raw.length >= 4 && raw.readUInt32LE(0) === 0x04034b50
if (isZip) {
  for (const e of readZip(raw)) {
    if (e.isDir) continue
    assertSafePath(e.name)
    if (files.some((f) => f.path === e.name)) throw new Error(`bundle: duplicate entry ${e.name}`)
    files.push({ path: e.name, data: e.data })
  }
  const del = files.find((f) => f.path === `${PROTOCOL_PREFIX}DELETED.txt`)
  if (del) deletes = del.data.toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(assertSafePath)
} else {
  const b = parseBundle(raw.toString('utf8'))
  task = b.header.task ?? null
  files = b.files.map((f) => ({ path: f.path, data: Buffer.from(f.content, 'utf8'), text: true }))
  deletes = b.deletes
}
// A deletion list that contradicts the file list, repeats itself, or names protocol
// files is a malformed bundle; refuse it before touching anything.
{
  const filePaths = new Set(files.map((f) => f.path))
  const seenDel = new Set()
  for (const d of deletes) {
    if (isProtocolPath(d)) throw new Error(`bundle: deletion list names a protocol path: ${d}`)
    if (filePaths.has(d)) throw new Error(`bundle: ${d} is both delivered and listed for deletion`)
    if (seenDel.has(d)) throw new Error(`bundle: ${d} is listed for deletion twice`)
    seenDel.add(d)
  }
}
const taskFile = files.find((f) => f.path === `${PROTOCOL_PREFIX}TASK.md`)
if (!task && taskFile) task = /^# TASK\s+(\S+)/m.exec(taskFile.data.toString('utf8'))?.[1] ?? null
const auditFile = files.find((f) => f.path === `${PROTOCOL_PREFIX}AUDIT.md`)
const audit = auditFile ? parseAuditSummary(auditFile.data.toString('utf8')) : { error: 'bundle has no _m365/AUDIT.md' }
if (!task && audit.summary?.task) task = audit.summary.task
// The slug names a directory under .m365/; anything that is not a plain slug is untrusted input.
if (task && !isSafeSlug(task)) {
  console.error(`warning: bundle task name ${JSON.stringify(task)} is not a valid slug; reports go to .m365/unknown/`)
  task = null
}
task = task ?? 'unknown'

function insideDir(base, abs) {
  const rel = relative(base, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(/[\\/]/).some(isGitSegment)
}

/** lstat-based existence: a dangling symlink counts as present (existsSync would follow it and say no). */
function existsL(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Lexical containment is not enough once something on the path is a symlink: find the
 * nearest existing path component with lstat (so a dangling link is seen, not skipped),
 * refuse it outright if it is a symlink, and require the real path of what remains to
 * stay inside the real base.
 */
function realInside(base, abs) {
  if (!insideDir(base, abs)) return false
  let probe = abs
  while (!existsL(probe)) {
    const up = dirname(probe)
    if (up === probe) return false
    probe = up
  }
  try {
    if (lstatSync(probe).isSymbolicLink()) return false
  } catch {
    return false
  }
  const realBase = realpathSync.native(base)
  const realProbe = realpathSync.native(probe)
  if (realProbe === realBase) return true
  const rel = relative(realBase, realProbe)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(/[\\/]/).some(isGitSegment)
}
const insideRepo = (abs) => realInside(repo, abs)

const reportsDir = resolve(opts.reports ?? join(repo, '.m365', task, 'reports'))
if (!opts.reports && !insideDir(join(repo, '.m365'), reportsDir)) throw new Error(`refusing to write reports outside ${join(repo, '.m365')}: ${reportsDir}`)

// ----------------------------------------------------------------- apply

const added = []
const modified = []
const unchanged = []
const deleted = []
const kept = [] // untouched in the sandbox, so the local copy (possibly newer) stays
const conflicts = [] // both sides changed since the snapshot; nothing written (use --force)
const reports = []

// The baseline is the input manifest a `pack --full` bundle carries: path -> sha256 of
// the bytes the sandbox started from. Without it the apply is a plain overwrite.
const manifestFile = files.find((f) => f.path === `${PROTOCOL_PREFIX}manifest.json`)
let baseline = null
if (manifestFile) {
  try {
    const m = JSON.parse(manifestFile.data.toString('utf8'))
    if (m && m.schema === 'm365-manifest/1' && m.files && typeof m.files === 'object' && !Array.isArray(m.files)) {
      // A null-prototype copy, so file names like "constructor" cannot hit inherited properties.
      baseline = Object.assign(Object.create(null), m.files)
    } else console.error('warning: _m365/manifest.json in the bundle has an unexpected shape; applying without a baseline')
  } catch {
    console.error('warning: the bundle carries an unreadable _m365/manifest.json; applying without a baseline')
  }
}
const baseOf = (path) => (baseline && Object.hasOwn(baseline, path) ? baseline[path] : undefined)

/** Byte-level CRLF -> LF, with no text decoding so invalid UTF-8 cannot collide with U+FFFD. */
function stripCr(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue
    out[n++] = buf[i]
  }
  return out.subarray(0, n)
}
/** sha256 of the bytes as given and of their LF-normalised form, so CRLF checkouts still match. */
function hashesOf(buf) {
  const out = new Set([createHash('sha256').update(buf).digest('hex')])
  if (buf.includes(0x0d)) out.add(createHash('sha256').update(stripCr(buf)).digest('hex'))
  return out
}

// Phase 1: decide every write and delete, refusing the whole bundle on any unsafe
// destination. Phase 2 performs them, so a refusal never leaves a half-applied tree.
const plan = []
// An audit-only bundle (from the `auditor` agent) must not overwrite the implementer's
// report already in the reports directory; it is saved beside it instead.
const auditOnly = files.every((f) => isProtocolPath(f.path))
let auditSavedAs = null
if (!opts.reports && existsL(join(repo, '.m365')) && !realInside(repo, join(repo, '.m365'))) throw new Error(`refusing to use ${join(repo, '.m365')}: it leaves the repository`)
// The slug directory itself (.m365/<slug>) and the reports directory may exist already;
// neither may be a symlink that leads out of .m365/.
for (const dir of [dirname(reportsDir), reportsDir])
  if (!opts.reports && existsL(dir) && !realInside(join(repo, '.m365'), dir)) throw new Error(`refusing to use ${dir}: it leaves ${join(repo, '.m365')}`)

for (const f of files) {
  if (isProtocolPath(f.path)) {
    let dest = resolve(reportsDir, f.path.slice(PROTOCOL_PREFIX.length))
    if (auditOnly && f.path === `${PROTOCOL_PREFIX}AUDIT.md` && existsL(dest)) {
      dest = join(dirname(dest), 'AUDIT.auditor.md')
      auditSavedAs = dest
    }
    const contained = existsL(reportsDir) ? realInside(reportsDir, dest) : insideDir(reportsDir, dest)
    if (!contained) throw new Error(`refusing to write outside the reports directory: ${f.path}`)
    reports.push(f.path)
    plan.push({ kind: 'write', dest, data: f.data })
    continue
  }
  const dest = resolve(repo, f.path)
  if (!insideRepo(dest)) throw new Error(`refusing to write outside the repository: ${f.path}`)
  const exists = existsL(dest)
  let data = f.data
  if (f.text && exists) data = Buffer.from(matchLineEndings(f.data.toString('utf8'), readFileSync(dest, 'utf8')), 'utf8')
  const local = exists ? readFileSync(dest) : null
  if (local && local.equals(data)) {
    unchanged.push(f.path)
    continue
  }
  // Three-way apply against the baseline the sandbox started from (carried manifest).
  const base = baseOf(f.path)
  if (base !== undefined) {
    const remoteTouched = !hashesOf(f.data).has(base)
    const localTouched = local ? !hashesOf(local).has(base) : true
    if (!remoteTouched) {
      // Untouched in the sandbox: whatever is here now is newer than the snapshot.
      kept.push(f.path)
      continue
    }
    if (localTouched && !opts.force) {
      conflicts.push(f.path)
      continue
    }
  } else if (baseline && local && !opts.force) {
    // Added remotely (absent from the snapshot), but something else already exists here.
    // Without any baseline the apply is a plain overwrite, as documented.
    conflicts.push(f.path)
    continue
  }
  ;(exists ? modified : added).push(f.path)
  plan.push({ kind: 'write', dest, data })
}
for (const d of deletes) {
  const dest = resolve(repo, d)
  if (!insideRepo(dest)) throw new Error(`refusing to delete outside the repository: ${d}`)
  if (!existsL(dest)) continue
  const base = baseOf(d)
  // With a baseline, deleting is allowed only for a file the sandbox saw and that is
  // still at its snapshot state; anything else here is newer than what was judged.
  if (baseline && !opts.force && (base === undefined || !hashesOf(readFileSync(dest)).has(base))) {
    conflicts.push(d)
    continue
  }
  deleted.push(d)
  plan.push({ kind: 'delete', dest })
}

if (!opts['dry-run']) {
  for (const step of plan) {
    if (step.kind === 'write') {
      mkdirSync(dirname(step.dest), { recursive: true })
      writeFileSync(step.dest, step.data)
    } else unlinkSync(step.dest)
  }
}

// ---------------------------------------------------------------- report
const verdict = audit.summary?.verdict ?? null
const summary = { bundle: file, task, dryRun: !!opts['dry-run'], verdict, finalRound: audit.summary?.final_round ?? null, baseline: !!baseline, added, modified, unchanged, kept, conflicts, deleted, reports: reports.map((p) => (p === `${PROTOCOL_PREFIX}AUDIT.md` && auditSavedAs ? auditSavedAs : join(reportsDir, p.slice(PROTOCOL_PREFIX.length)))), auditSavedAs, auditError: audit.error ?? null }

if (opts.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`${opts['dry-run'] ? '[dry-run] ' : ''}bundle ${file}`)
  console.log(`  task: ${task}  verdict: ${verdict ?? 'n/a'}${summary.finalRound ? `  final round: ${summary.finalRound}` : ''}`)
  if (audit.error) console.log(`  audit: ${audit.error}`)
  console.log(`  added ${added.length}, modified ${modified.length}, unchanged ${unchanged.length}, kept ${kept.length}, conflicts ${conflicts.length}, deleted ${deleted.length}, reports ${reports.length}${baseline ? '' : '  (no baseline manifest: plain overwrite)'}`)
  for (const p of added) console.log(`    + ${p}`)
  for (const p of modified) console.log(`    ~ ${p}`)
  for (const p of deleted) console.log(`    - ${p}`)
  for (const p of kept) console.log(`    = ${p}  (untouched in the sandbox; local copy kept)`)
  for (const p of conflicts) console.log(`    ! ${p}  (changed both locally and in the sandbox; not written - resolve by hand or rerun with --force)`)
  for (const p of summary.reports) console.log(`    r ${p}`)
  if (auditSavedAs) console.log(`  the independent audit was saved as AUDIT.auditor.md so the implementer's AUDIT.md stays; compare the two verdicts.`)
  if (audit.summary) {
    for (const r of audit.summary.rounds ?? []) {
      const fails = (r.checks ?? []).filter((c) => c.status !== 'PASS')
      console.log(`  round ${r.round}: ${r.verdict}${fails.length ? ' - ' + fails.map((c) => `${c.id}${c.detail ? ` (${c.detail})` : ''}`).join('; ') : ''}`)
    }
  }
  if (!opts['dry-run']) {
    try {
      const st = execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (st.trim()) console.log(`  git status --short:\n${st.replace(/^/gm, '    ')}`)
      console.log('  review with: git diff --stat ; nothing has been committed.')
    } catch {
      /* git not available; fine */
    }
  }
}

// Conflicts mean the working tree is not what the audit judged, so exit 3 outranks every
// other outcome (PASS, FAIL and a missing report alike).
process.exit(conflicts.length ? 3 : verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 2 : 1)
