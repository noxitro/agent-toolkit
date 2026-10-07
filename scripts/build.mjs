#!/usr/bin/env node
// Generate the per-harness distributions from shared/**.
//
//   node scripts/build.mjs           regenerate the owned output directories
//   node scripts/build.mjs --check   fail if the committed output is out of date
//
// Owned output (wiped and rewritten on every build):
//   plugins/<CLAUDE_PLUGIN>/{skills,commands,agents}   Claude Code plugin payload
//   dist/opencode/{agent,command}                      OpenCode global config payload
//   dist/copilot/{skills,prompts,agents}               GitHub Copilot .github payload

import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OWNED_DIRS, ROOT, emit, ensureRoot, loadAssets, scanTree, validateAsset } from './lib/toolkit.mjs'

const check = process.argv.includes('--check')

// Everything up to the rmSync below is read-only, so a wrong ROOT or a broken source tree
// stops the build before any owned directory is touched.
ensureRoot('build')

const report = { problems: [], warnings: [] }
const assets = loadAssets(report)
const problems = [...report.problems, ...assets.flatMap(validateAsset)]
if (problems.length) {
  console.error('Cannot build - fix these first (see `npm run validate`):')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
for (const w of report.warnings) console.warn(`warning: ${w}`)
if (assets.length === 0) {
  console.error(`Cannot build - no shared assets found under ${join(ROOT, 'shared')}. Nothing was changed.`)
  process.exit(1)
}

/** path (posix, repo-relative) -> { contents } | { copyFrom } */
const planned = new Map()
for (const asset of assets) {
  for (const file of emit(asset)) {
    const key = file.path.split('\\').join('/')
    if (planned.has(key)) {
      console.error(`Output collision on ${key} (produced by more than one shared asset).`)
      process.exit(1)
    }
    planned.set(key, file)
  }
}

/**
 * Regular files currently in the owned directories, plus anything a build would never
 * produce there: symlinks or special files, and empty directories.
 */
function currentFiles() {
  const found = new Map()
  const strays = []
  for (const dir of OWNED_DIRS) {
    const abs = join(ROOT, dir)
    const key = dir.split('\\').join('/')
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (!st.isDirectory()) {
      strays.push(`${key} (${st.isSymbolicLink() ? 'symlink' : 'not a directory'})`)
      continue
    }
    const tree = scanTree(abs)
    for (const rel of tree.files) found.set(`${key}/${rel}`, join(abs, rel))
    for (const o of tree.others) strays.push(`${key}/${o.path} (${o.type})`)
    for (const d of tree.emptyDirs) strays.push(`${key}/${d}/ (empty directory)`)
  }
  return { found, strays }
}

function bytesFor(file) {
  return file.copyFrom ? readFileSync(file.copyFrom) : Buffer.from(file.contents, 'utf8')
}

if (check) {
  const { found: existing, strays } = currentFiles()
  const added = []
  const changed = []
  const removed = []

  for (const [path, file] of planned) {
    const abs = existing.get(path)
    if (!abs) added.push(path)
    else if (!readFileSync(abs).equals(bytesFor(file))) changed.push(path)
  }
  for (const path of existing.keys()) if (!planned.has(path)) removed.push(path)

  if (added.length || changed.length || removed.length || strays.length) {
    console.error('Generated output is out of date. Run `npm run build` and commit the result.')
    for (const p of added) console.error(`  + missing   ${p}`)
    for (const p of changed) console.error(`  ~ stale     ${p}`)
    for (const p of removed) console.error(`  - orphaned  ${p}`)
    for (const p of strays) console.error(`  ! stray     ${p}`)
    process.exit(1)
  }
  console.log(`Generated output is up to date (${planned.size} files from ${assets.length} shared assets).`)
  process.exit(0)
}

for (const dir of OWNED_DIRS) rmSync(join(ROOT, dir), { recursive: true, force: true })
for (const [path, file] of planned) {
  const abs = join(ROOT, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytesFor(file))
}

console.log(`Built ${planned.size} files from ${assets.length} shared assets:`)
for (const path of [...planned.keys()].sort()) console.log(`  ${path}`)
