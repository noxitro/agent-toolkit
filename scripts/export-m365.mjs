#!/usr/bin/env node
// Write, or verify, the production repository of m365-skill-pack (see lib/export-m365.mjs).
//
//   node scripts/export-m365.mjs <out-dir>           write the export into <out-dir>
//   node scripts/export-m365.mjs <out-dir> --check   exit 1 when <out-dir> differs from a fresh export
//
// The export is scanned before anything is written; a forbidden word, a network call or a
// URL outside the allow-list stops it. Writing refuses a non-empty directory that is not a
// previous export, and only ever removes files a previous export listed in EXPORT.json.
// A .git directory in <out-dir> is left alone, so the target can be its own repository.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { buildExport, diffExport, scanFiles } from './lib/export-m365.mjs'
import { ROOT } from './lib/toolkit.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const outArg = args.find((a) => !a.startsWith('--'))
if (!outArg) {
  console.error('Usage: node scripts/export-m365.mjs <out-dir> [--check]')
  process.exit(1)
}
const outDir = resolve(outArg)
if (outDir === ROOT || outDir.startsWith(`${ROOT}\\`) || outDir.startsWith(`${ROOT}/`)) {
  console.error(`refusing to export into this repository (${outDir}); choose a directory outside it`)
  process.exit(1)
}

// The export copies the generated plugin and Copilot trees, so they must match shared/.
const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--check'], { encoding: 'utf8' })
if (built.status !== 0) {
  console.error(`generated output is stale; run npm run build first\n${built.stdout}${built.stderr}`)
  process.exit(1)
}

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const dirty = git('status', '--porcelain', '--', 'shared', 'plugins', 'dist', 'LICENSE') !== ''
const commit = `${git('rev-parse', 'HEAD')}${dirty ? '-dirty' : ''}`
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const files = buildExport({ root: ROOT, version, commit })

const problems = scanFiles(files)
if (problems.length) {
  console.error(`export refused - ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

function readTree(dir) {
  const map = new Map()
  if (!existsSync(dir)) return map
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (d === dir && n === '.git') continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else map.set(relative(dir, p).replace(/\\/g, '/'), readFileSync(p))
    }
  }
  walk(dir)
  return map
}

const onDisk = readTree(outDir)
const diff = diffExport(files, outDir, onDisk)

if (check) {
  const n = diff.missing.length + diff.changed.length + diff.extra.length
  for (const p of diff.missing) console.log(`  missing  ${p}`)
  for (const p of diff.changed) console.log(`  changed  ${p}`)
  for (const p of diff.extra) console.log(`  extra    ${p}`)
  console.log(n ? `\n${outDir} differs from a fresh export (${n} path(s)).` : `${outDir} matches a fresh export (${files.length} files).`)
  process.exit(n ? 1 : 0)
}

let previous = null
if (onDisk.has('EXPORT.json')) {
  try {
    previous = JSON.parse(onDisk.get('EXPORT.json').toString('utf8'))
  } catch {
    previous = null
  }
}
if (onDisk.size && !previous) {
  console.error(`refusing to write: ${outDir} has files but no EXPORT.json from a previous export`)
  process.exit(1)
}
const keep = new Set(files.map((f) => f.path))
for (const p of Object.keys(previous?.files ?? {})) {
  if (!keep.has(p)) rmSync(join(outDir, ...p.split('/')), { force: true })
}
for (const f of files) {
  const dest = join(outDir, ...f.path.split('/'))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, f.data)
}
const unknown = diff.extra.filter((p) => !(p in (previous?.files ?? {})) && p !== 'EXPORT.json')
console.log(`exported ${files.length} files to ${outDir} (source ${commit})`)
if (unknown.length) console.log(`note: files not written by an export were left alone:\n  ${unknown.join('\n  ')}`)
