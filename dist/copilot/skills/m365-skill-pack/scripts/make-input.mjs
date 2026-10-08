#!/usr/bin/env node
// Build the input bundle for the Microsoft 365 Copilot impl-loop agent: the repository
// (or a subset) plus _m365/TASK.md, as one .zip (default) or one Markdown file.
//
//   node make-input.mjs --task <TASK.md> [--out <dir>] [--format zip|md] [--repo <dir>]
//                       [--exclude <glob>]... [--max-file <bytes>] [--max-total <bytes>]
//                       [--ext md|txt] [--store] [<path>...]
//
// The harness that runs this never has to read the files: everything is discovered with
// `git ls-files` (tracked + untracked-not-ignored) or a directory walk, filtered by the
// default exclusions in lib/m365-rules.mjs, and written straight to disk.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs, usage } from './lib/args.mjs'
import { formatBundle, isBinary, isProtocolPath, unsafePathReason } from './lib/bundle.mjs'
import { CONVENTION_FILES, INPUT_EXCLUDE_RES, globToRegExp } from './lib/m365-rules.mjs'
import { writeZip } from './lib/zip.mjs'

const HELP = `
Usage: node make-input.mjs --task <TASK.md> [options] [<path>...]

  --task <file>        _m365/TASK.md for this task (required; first line "# TASK <slug>")
  --out <dir>          output directory (default: <repo>/.m365/<slug>)
  --repo <dir>         repository root (default: current directory)
  --format zip|md      zip (default) or a Markdown bundle
  --ext md|txt         extension for the Markdown bundle (default md)
  --exclude <glob>     extra exclusion (repeatable); defaults cover .git, node_modules, .env, builds
  --max-file <bytes>   warn above this size per file (default 1048576)
  --max-total <bytes>  warn above this total (default 15000000)
  --store              zip without compression
  --quiet              print only the output path
  <path>...            restrict to these files/directories (default: whole repository)

Environment: M365_DROP_DIR - if set, the bundle is also copied there (e.g. a synced OneDrive folder).
`

let args
try {
  args = parseArgs(process.argv.slice(2), {
    task: 'string', out: 'string', repo: 'string', format: 'string', ext: 'string', exclude: 'list',
    'max-file': 'number', 'max-total': 'number', store: 'bool', quiet: 'bool', help: 'bool',
  })
} catch (e) {
  usage(`${e.message}\n${HELP}`)
}
const { opts, positionals } = args
if (opts.help) usage(HELP, 0)
if (!opts.task) usage(`--task is required\n${HELP}`)

const repo = resolve(opts.repo ?? process.cwd())
const format = opts.format ?? 'zip'
if (!['zip', 'md'].includes(format)) usage('--format must be zip or md')
const maxFile = opts['max-file'] ?? 1024 * 1024
const maxTotal = opts['max-total'] ?? 15_000_000

const taskText = readFileSync(resolve(opts.task), 'utf8').replace(/^﻿/, '')
const slugMatch = /^# TASK\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/m.exec(taskText)
if (!slugMatch) usage(`${opts.task}: first heading must be "# TASK <slug>" (letters, digits, . _ -)`)
const slug = slugMatch[1]
const outDir = resolve(opts.out ?? join(repo, '.m365', slug))

// ----------------------------------------------------------------- discovery
function toPosix(p) {
  return p.split(sep).join('/')
}

function gitFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function walkFiles(dir, base, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) walkFiles(abs, base, out)
    else if (e.isFile()) out.push(toPosix(relative(base, abs)))
  }
  return out
}

let candidates = gitFiles() ?? walkFiles(repo, repo)
// Defaults are case-insensitive (they guard secrets); user globs are exact-case.
const excludes = [...INPUT_EXCLUDE_RES, ...opts.exclude.map((g) => globToRegExp(g))]
candidates = candidates.filter((p) => !excludes.some((re) => re.test(p)))

if (positionals.length) {
  const wanted = positionals.map((p) => toPosix(relative(repo, resolve(repo, p))).replace(/\/+$/, ''))
  candidates = candidates.filter((p) => wanted.some((w) => p === w || p.startsWith(`${w}/`)))
}

const realRepo = realpathSync.native(repo)
const dirCache = new Map()
function dirInsideRepo(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir)
  let ok = false
  try {
    const real = realpathSync.native(dir)
    const rel = relative(realRepo, real)
    ok = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    ok = false
  }
  dirCache.set(dir, ok)
  return ok
}

const files = []
const skipped = []
let total = 0
for (const rel of candidates.sort()) {
  const why = unsafePathReason(rel)
  if (why) {
    skipped.push({ path: rel, reason: why })
    continue
  }
  if (isProtocolPath(rel)) {
    skipped.push({ path: rel, reason: 'reserved _m365/ prefix' })
    continue
  }
  const abs = join(repo, rel)
  let st
  try {
    st = lstatSync(abs) // lstat: a tracked symlink must not smuggle its target's contents in
  } catch {
    continue
  }
  if (st.isSymbolicLink()) {
    skipped.push({ path: rel, reason: 'symbolic link' })
    continue
  }
  if (!st.isFile()) continue
  // lstat only covers the last component; a symlinked or junctioned parent directory
  // would still lead outside the repository, so the parent's real path is checked too.
  if (!dirInsideRepo(dirname(abs))) {
    skipped.push({ path: rel, reason: 'parent directory resolves outside the repository' })
    continue
  }
  const data = readFileSync(abs)
  if (format === 'md' && isBinary(data, rel)) {
    skipped.push({ path: rel, reason: 'binary' })
    continue
  }
  if (st.size > maxFile) console.warn(`warning: ${rel} is ${st.size} bytes (over --max-file ${maxFile})`)
  files.push({ path: rel, data })
  total += st.size
}

// ------------------------------------------------------------ protocol files
files.push({ path: '_m365/TASK.md', data: Buffer.from(taskText.replace(/\r\n/g, '\n'), 'utf8') })
for (const conv of CONVENTION_FILES) {
  const abs = join(repo, conv)
  let st
  try {
    st = lstatSync(abs)
  } catch {
    continue
  }
  if (st.isSymbolicLink() || !dirInsideRepo(dirname(abs))) {
    skipped.push({ path: conv, reason: 'symbolic link (conventions file)' })
    continue
  }
  if (st.isFile()) files.push({ path: `_m365/CONVENTIONS/${basename(conv)}`, data: readFileSync(abs) })
}

if (total > maxTotal) console.warn(`warning: bundle holds ${total} bytes of repository files (over --max-total ${maxTotal}); consider restricting paths`)

// ------------------------------------------------------------------- output
mkdirSync(outDir, { recursive: true })
let outFile
if (format === 'zip') {
  outFile = join(outDir, `in-${slug}.zip`)
  writeFileSync(outFile, writeZip(files.map((f) => ({ name: f.path, data: f.data })), { store: opts.store }))
} else {
  const ext = opts.ext ?? 'md'
  if (!['md', 'txt'].includes(ext)) usage('--ext must be md or txt')
  outFile = join(outDir, `in-${slug}.${ext}`)
  writeFileSync(outFile, formatBundle({ task: slug, kind: 'input', round: 0, files, skipped }), 'utf8')
}

const drop = process.env.M365_DROP_DIR
let dropped = null
if (drop && existsSync(drop)) {
  dropped = join(drop, basename(outFile))
  copyFileSync(outFile, dropped)
} else if (drop) {
  // A typo or an unsynced OneDrive folder must not look like a successful hand-off.
  console.error(`warning: M365_DROP_DIR ${drop} does not exist; the bundle was not copied there`)
}

if (opts.quiet) console.log(outFile)
else {
  console.log(`input bundle: ${outFile}`)
  console.log(`  task: ${slug}  files: ${files.length}  repository bytes: ${total}${skipped.length ? `  skipped: ${skipped.length}` : ''}`)
  if (dropped) console.log(`  copied to M365_DROP_DIR: ${dropped}`)
  console.log('  next: attach this file to the impl-loop agent in Microsoft 365 Copilot (work or school account) and send its starter prompt.')
}
// Always, even with --quiet: this bundle holds the repository.
console.error('note: attach only to Microsoft 365 Copilot with a work or school account (Enterprise Data Protection); the free consumer Copilot has none and would leak the repository.')
