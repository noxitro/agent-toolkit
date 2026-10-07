#!/usr/bin/env node
// Apply an output bundle from Microsoft 365 Copilot to the repository and report the
// audit verdict. Accepts a .zip or a Markdown bundle. Protocol files under _m365/ go
// to the reports directory, never into the repository. Nothing is committed.
//
//   node unpack-output.mjs <out.zip|out.md> [--repo <dir>] [--reports <dir>] [--dry-run] [--force]
//                          [--allow-excluded] [--json]
//
// Exit code: 3 = conflicts left unresolved (takes precedence), otherwise 0 = PASS, 2 = FAIL,
// 1 = error or no usable AUDIT.md.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs, usage } from './lib/args.mjs'
import { PROTOCOL_PREFIX, assertSafePath, isBinary, isGitSegment, isProtocolPath, isSafeSlug, normaliseText, parseAuditSummary, parseBundle, restoreTextStyle } from './lib/bundle.mjs'
import { INPUT_EXCLUDE_RES } from './lib/m365-rules.mjs'
import { readZip } from './lib/unzip.mjs'

const HELP = `
Usage: node unpack-output.mjs <out.zip|out.md> [options]

  --repo <dir>      repository root to write into (default: current directory)
  --reports <dir>   where _m365/* files go (default: <repo>/.m365/<slug>/reports)
  --dry-run         report what would change without writing
  --force           overwrite files that changed both locally and in the sandbox
  --allow-excluded  allow writes and deletions under paths make-input excludes by default
                    (node_modules/, .env, .venv/, .m365/, keys, build output, ...)
  --json            machine-readable summary

With a bundle from \`pack --full\` the apply is three-way against the input snapshot:
files the sandbox left untouched keep their local copy, and a file changed on both
sides is reported as a conflict and left alone unless --force is given. A bundle
without _m365/manifest.json is applied as a plain overwrite.
Exit: 3 conflicts (takes precedence), 0 PASS, 2 FAIL, 1 error or no usable AUDIT.md.
`

let args
try {
  args = parseArgs(process.argv.slice(2), { repo: 'string', reports: 'string', 'dry-run': 'bool', force: 'bool', 'allow-excluded': 'bool', json: 'bool', help: 'bool' })
} catch (e) {
  usage(`${e.message}\n${HELP}`)
}
const { opts, positionals } = args
if (opts.help || positionals.length !== 1) usage(HELP, opts.help ? 0 : 1)

const file = resolve(positionals[0])
// The real path, once: a --repo that is itself a symlink is the user's choice, and every
// containment check below then compares real paths.
let repo = resolve(opts.repo ?? process.cwd())
try {
  repo = realpathSync.native(repo)
} catch {
  usage(`--repo ${repo}: not found`)
}
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
  // macOS and Windows file systems ignore letter case and Unicode normalisation, so two
  // delivered names that fold together would land in one file, and a name that is both a
  // file and a directory prefix cannot be laid out at all. Checked on every platform.
  const byFold = new Map()
  for (const f of files) {
    const k = foldPath(f.path)
    if (byFold.has(k)) throw new Error(`bundle: ${byFold.get(k)} and ${f.path} differ only in letter case or Unicode normalisation`)
    byFold.set(k, f.path)
  }
  for (const f of files) {
    const segs = foldPath(f.path).split('/')
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/')
      if (byFold.has(prefix)) throw new Error(`bundle: ${byFold.get(prefix)} is delivered as a file but is also the directory of ${f.path}`)
    }
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

/** Case- and normalisation-insensitive key, as the default macOS and Windows file systems compare names. */
function foldPath(p) {
  return p.normalize('NFC').toLowerCase()
}

/** A relative path that climbs out of its base (`..notes.md` is a name, not a climb). */
function escapes(rel) {
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)
}

function insideDir(base, abs) {
  const rel = relative(base, abs)
  return rel !== '' && !escapes(rel) && !rel.split(/[\\/]/).some(isGitSegment)
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
  // The probe stops at the base: the base itself was vetted by the caller (the repository
  // is already a real path) and may legitimately be reached through a symlink.
  let probe = abs
  while (probe !== base && !existsL(probe)) {
    const up = dirname(probe)
    if (up === probe) return false
    probe = up
  }
  if (probe === base) return true
  try {
    if (lstatSync(probe).isSymbolicLink()) return false
  } catch {
    return false
  }
  const realBase = realpathSync.native(base)
  const realProbe = realpathSync.native(probe)
  if (realProbe === realBase) return true
  const rel = relative(realBase, realProbe)
  return rel !== '' && !escapes(rel) && !rel.split(/[\\/]/).some(isGitSegment)
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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
/**
 * sha256 of the bytes as given and of the exact normalisation formatBundle applies (BOM
 * dropped, CRLF and lone CR to LF, strict UTF-8), so a file the sandbox saw through a
 * Markdown bundle, or a CRLF checkout, still matches its baseline.
 */
function hashesOf(buf) {
  const out = new Set([sha256(buf)])
  const text = normaliseText(buf)
  if (text !== null) out.add(sha256(Buffer.from(text, 'utf8')))
  return out
}
/** Same inode: on a case-insensitive file system README.md and Readme.md are one file. */
function sameFile(a, b) {
  try {
    const x = lstatSync(a, { bigint: true })
    const y = lstatSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

// Phase 1: decide every write and delete, refusing the whole bundle on any unsafe or
// impossible destination. Phase 2 performs them, so a refusal never leaves a
// half-applied tree.
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

// The input left these out on purpose, so `git status` may not show what lands there
// (ignored files, .m365/ itself). Only an explicit flag lets the bundle touch them.
if (!opts['allow-excluded']) {
  const hit = [...files.filter((f) => !isProtocolPath(f.path)).map((f) => f.path), ...deletes].filter((p) => INPUT_EXCLUDE_RES.some((re) => re.test(p)))
  if (hit.length) throw new Error(`refusing to touch paths the input bundle excludes by default (rerun with --allow-excluded if intended): ${hit.join(', ')}`)
}

// A deletion whose name folds to a delivered file is a case-only (or normalisation-only)
// rename. It is applied as delete-then-write, judged by the old spelling the sandbox saw,
// so a case-insensitive file system never loses the new file to the old name's unlink.
const writeByFold = new Map(files.filter((f) => !isProtocolPath(f.path)).map((f) => [foldPath(f.path), f.path]))
const renameFrom = new Map() // delivered path -> deleted old spelling
for (const d of deletes) {
  const w = writeByFold.get(foldPath(d))
  if (!w) continue
  const from = resolve(repo, d)
  const to = resolve(repo, w)
  if (!insideRepo(from)) throw new Error(`refusing to delete outside the repository: ${d}`)
  // Two distinct local files (case-sensitive file system): an ordinary delete and write.
  if (existsL(from) && (!existsL(to) || sameFile(from, to))) renameFrom.set(w, d)
}
const renamedFrom = new Set(renameFrom.values())

const deleteSet = new Set() // absolute paths deleted by this plan
const blockedDeletes = new Set() // absolute paths a conflict keeps in place
for (const d of deletes) {
  if (renamedFrom.has(d)) continue
  const dest = resolve(repo, d)
  if (!insideRepo(dest)) throw new Error(`refusing to delete outside the repository: ${d}`)
  if (!existsL(dest)) continue
  if (!lstatSync(dest).isFile()) throw new Error(`refusing to delete ${d}: it is a directory or special file here, and a bundle deletes files only`)
  const base = baseOf(d)
  // With a baseline, deleting is allowed only for a file the sandbox saw and that is
  // still at its snapshot state; anything else here is newer than what was judged.
  if (baseline && !opts.force && (base === undefined || !hashesOf(readFileSync(dest)).has(base))) {
    conflicts.push(d)
    blockedDeletes.add(dest)
    continue
  }
  deleted.push(d)
  deleteSet.add(dest)
  plan.push({ kind: 'delete', dest, rel: d })
}

const writes = []
for (const f of files) {
  if (isProtocolPath(f.path)) {
    let dest = resolve(reportsDir, f.path.slice(PROTOCOL_PREFIX.length))
    if (auditOnly && f.path === `${PROTOCOL_PREFIX}AUDIT.md` && existsL(dest)) {
      dest = join(dirname(dest), 'AUDIT.auditor.md')
      auditSavedAs = dest
    }
    const contained = existsL(reportsDir) ? realInside(reportsDir, dest) : insideDir(reportsDir, dest)
    if (!contained) throw new Error(`refusing to write outside the reports directory: ${f.path}`)
    if (existsL(dest) && !lstatSync(dest).isFile()) throw new Error(`refusing to write ${f.path}: ${dest} is a directory or special file`)
    reports.push(f.path)
    writes.push({ kind: 'write', dest, data: f.data, rel: f.path })
    continue
  }
  const dest = resolve(repo, f.path)
  if (!insideRepo(dest)) throw new Error(`refusing to write outside the repository: ${f.path}`)
  const from = renameFrom.get(f.path)
  // For a rename the local copy is the old spelling; its snapshot entry decides.
  const localPath = from ? resolve(repo, from) : dest
  const exists = existsL(localPath)
  if (exists && !lstatSync(localPath).isFile()) throw new Error(`refusing to write ${f.path}: it is a directory or special file here`)
  const local = exists ? readFileSync(localPath) : null
  const base = baseOf(from ?? f.path)
  // A local file that matches the snapshot only after normalisation (BOM, CRLF) keeps
  // that style; so does any existing file a Markdown bundle (always LF, no BOM) replaces.
  const viaNormalisation = local && base !== undefined && sha256(local) !== base && hashesOf(local).has(base)
  let data = f.data
  if (local && (f.text || viaNormalisation) && !isBinary(f.data, f.path)) data = restoreTextStyle(f.data, local)
  const mode = exists ? lstatSync(localPath).mode & 0o7777 : null
  if (from) {
    if (baseline && !opts.force && (base === undefined || !hashesOf(local).has(base))) {
      // The old spelling changed locally since the snapshot: neither half of the rename runs.
      conflicts.push(f.path, from)
      blockedDeletes.add(localPath)
      continue
    }
    added.push(f.path)
    deleted.push(from)
    deleteSet.add(localPath)
    plan.push({ kind: 'delete', dest: localPath, rel: from })
    writes.push({ kind: 'write', dest, data, mode, rel: f.path })
    continue
  }
  if (local && local.equals(data)) {
    unchanged.push(f.path)
    continue
  }
  // Three-way apply against the baseline the sandbox started from (carried manifest).
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
  writes.push({ kind: 'write', dest, data, mode, rel: f.path })
}

// Every directory a write needs must be absent, a directory, or a file this plan deletes
// first (the sandbox replaced file `docs` by `docs/index.md`). A file a conflict keeps in
// place turns the write into a conflict too; any other file there refuses the bundle.
for (const w of writes) {
  let p = dirname(w.dest)
  let blocker = null
  for (;;) {
    let st = null
    try {
      st = lstatSync(p)
    } catch {
      /* absent: created on apply */
    }
    if (st) {
      if (!st.isDirectory()) blocker = p
      break
    }
    const up = dirname(p)
    if (up === p) break
    p = up
  }
  if (blocker && deleteSet.has(blocker)) w.afterDeletes = true
  else if (blocker && blockedDeletes.has(blocker)) {
    for (const list of [added, modified]) if (list.includes(w.rel)) list.splice(list.indexOf(w.rel), 1)
    conflicts.push(w.rel)
    w.skip = true
  } else if (blocker) throw new Error(`refusing to write ${w.rel}: ${relative(repo, blocker) || blocker} is a file here, not a directory`)
}
plan.push(...writes.filter((w) => !w.skip))

/**
 * Phase 2. Writes are staged as temporary files beside their destination first, so a full
 * disk or a permission error surfaces before anything is replaced; then the deletions run,
 * then the writes that needed a deleted file's place, then every staged file is renamed
 * into place. A failure still reports exactly what was and was not applied.
 */
function applyPlan(steps) {
  const staged = []
  const madeDirs = []
  const done = []
  const stage = (step) => {
    const made = mkdirSync(dirname(step.dest), { recursive: true })
    if (made) madeDirs.push(made)
    // A short name, so a destination near the 255-byte name limit can still be staged.
    const tmp = join(dirname(step.dest), `.m365-${process.pid}-${staged.length}.tmp`)
    writeFileSync(tmp, step.data, { flag: 'wx' })
    staged.push({ tmp, step })
    if (step.mode !== null && step.mode !== undefined) chmodSync(tmp, step.mode) // keep an executable bit
  }
  let failed = null
  try {
    for (const s of steps) if (s.kind === 'write' && !s.afterDeletes) stage(s)
    for (const s of steps) {
      if (s.kind !== 'delete') continue
      try {
        unlinkSync(s.dest)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e // already gone (a case-folded duplicate): the goal is met
      }
      done.push(s)
    }
    for (const s of steps) if (s.kind === 'write' && s.afterDeletes) stage(s)
    for (const st of staged) {
      renameSync(st.tmp, st.step.dest)
      st.renamed = true
      done.push(st.step)
    }
  } catch (e) {
    failed = e
  }
  if (!failed) return
  for (const st of staged) {
    if (st.renamed) continue
    try {
      unlinkSync(st.tmp)
    } catch {
      /* best effort */
    }
  }
  for (const d of madeDirs.reverse()) pruneEmptyDirs(d)
  const notDone = steps.filter((s) => !done.includes(s))
  const line = (s) => `    ${s.kind === 'delete' ? '-' : isProtocolPath(s.rel) ? 'r' : '+'} ${s.rel}`
  console.error(`error: applying the bundle failed: ${failed.code ? `${failed.code}: ` : ''}${failed.message}`)
  console.error(`  applied (${done.length}):${done.length ? `\n${done.map(line).join('\n')}` : ' nothing'}`)
  console.error(`  not applied (${notDone.length}):${notDone.length ? `\n${notDone.map(line).join('\n')}` : ' nothing'}`)
  if (done.length) console.error('  the working tree is partly updated; review with git status and git diff before retrying.')
  process.exit(1)
}

/** Remove directories created for staging that ended up empty, deepest first. */
function pruneEmptyDirs(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) if (e.isDirectory()) pruneEmptyDirs(join(dir, e.name))
  try {
    rmdirSync(dir)
  } catch {
    /* not empty: something was applied there */
  }
}

if (!opts['dry-run']) applyPlan(plan)

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
