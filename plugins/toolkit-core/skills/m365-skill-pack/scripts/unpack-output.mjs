#!/usr/bin/env node
// Apply an output bundle from Microsoft 365 Copilot to the repository and report the
// audit verdict. Accepts a .zip or a Markdown bundle. Protocol files under _m365/ go
// to the reports directory, never into the repository. Nothing is committed.
//
//   node unpack-output.mjs <out.zip|out.md> [--repo <dir>] [--reports <dir>] [--dry-run] [--json]
//
// Exit code: 0 = PASS, 2 = FAIL, 1 = error or no usable AUDIT.md.

import { execFileSync } from 'node:child_process'
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
  --json            machine-readable summary
`

let args
try {
  args = parseArgs(process.argv.slice(2), { repo: 'string', reports: 'string', 'dry-run': 'bool', json: 'bool', help: 'bool' })
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

/**
 * Lexical containment is not enough once a directory inside the repository is a symlink
 * to somewhere else: resolve the nearest existing ancestor and require its real path to
 * stay inside the real base. A path whose final component is itself a symlink is refused.
 */
function realInside(base, abs) {
  if (!insideDir(base, abs)) return false
  let probe = abs
  while (!existsSync(probe)) probe = dirname(probe)
  try {
    if (lstatSync(probe).isSymbolicLink() && probe === abs) return false
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
const reports = []

for (const f of files) {
  if (isProtocolPath(f.path)) {
    const dest = resolve(reportsDir, f.path.slice(PROTOCOL_PREFIX.length))
    if (!opts['dry-run']) mkdirSync(reportsDir, { recursive: true })
    if (!(opts['dry-run'] ? insideDir(reportsDir, dest) : realInside(reportsDir, dest))) throw new Error(`refusing to write outside the reports directory: ${f.path}`)
    reports.push(f.path)
    if (!opts['dry-run']) {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, f.data)
    }
    continue
  }
  const dest = resolve(repo, f.path)
  if (!insideRepo(dest)) throw new Error(`refusing to write outside the repository: ${f.path}`)
  const exists = existsSync(dest)
  let data = f.data
  if (f.text && exists) data = Buffer.from(matchLineEndings(f.data.toString('utf8'), readFileSync(dest, 'utf8')), 'utf8')
  if (exists && readFileSync(dest).equals(data)) {
    unchanged.push(f.path)
    continue
  }
  ;(exists ? modified : added).push(f.path)
  if (!opts['dry-run']) {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, data)
  }
}
for (const d of deletes) {
  const dest = resolve(repo, d)
  if (!insideRepo(dest)) throw new Error(`refusing to delete outside the repository: ${d}`)
  if (!existsSync(dest)) continue
  deleted.push(d)
  if (!opts['dry-run']) unlinkSync(dest)
}

// ---------------------------------------------------------------- report
const verdict = audit.summary?.verdict ?? null
const summary = { bundle: file, task, dryRun: !!opts['dry-run'], verdict, finalRound: audit.summary?.final_round ?? null, added, modified, unchanged, deleted, reports: reports.map((p) => join(reportsDir, p.slice(PROTOCOL_PREFIX.length))), auditError: audit.error ?? null }

if (opts.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`${opts['dry-run'] ? '[dry-run] ' : ''}bundle ${file}`)
  console.log(`  task: ${task}  verdict: ${verdict ?? 'n/a'}${summary.finalRound ? `  final round: ${summary.finalRound}` : ''}`)
  if (audit.error) console.log(`  audit: ${audit.error}`)
  console.log(`  added ${added.length}, modified ${modified.length}, unchanged ${unchanged.length}, deleted ${deleted.length}, reports ${reports.length}`)
  for (const p of added) console.log(`    + ${p}`)
  for (const p of modified) console.log(`    ~ ${p}`)
  for (const p of deleted) console.log(`    - ${p}`)
  for (const p of summary.reports) console.log(`    r ${p}`)
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

process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 2 : 1)
