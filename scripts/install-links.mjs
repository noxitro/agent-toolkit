#!/usr/bin/env node
// Create (or verify) the symlinks that install this repository's generated output into
// the harness discovery locations on this machine.
//
//   node scripts/install-links.mjs           create or repair every link
//   node scripts/install-links.mjs --check   report state, exit 1 if any link is missing/wrong
//
// Links are declared under "links" in toolkit.config.json (shared, committed) and in
// toolkit.local.json (this machine only, git-ignored; see toolkit.local.example.json):
//   "links": [{ "path": "~/.agents/skills/wiki-query", "target": "plugins/llm-wiki/skills/wiki-query" }]
// `path` may start with "~" (home directory); `target` is relative to the repository root.
// Targets are resolved to absolute paths, so moving the repository means re-running this.
//
// Windows: symlink creation needs Developer Mode (or elevation). Directory links use the
// "dir" symlink type rather than a junction so that files and directories are handled alike.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ROOT } from './lib/toolkit.mjs'

const check = process.argv.includes('--check')

function readLinks(name) {
  const p = join(ROOT, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).links ?? [] : []
}
const links = [...readLinks('toolkit.config.json'), ...readLinks('toolkit.local.json')]

if (links.length === 0) {
  console.log('No links declared in toolkit.config.json or toolkit.local.json - nothing to do.')
  process.exit(0)
}

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

// Case is folded only where the filesystem does (Windows); elsewhere two paths that
// differ by case are two different targets.
function normalize(p) {
  const r = resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r
}

let problems = 0

for (const { path: rawPath, target: rawTarget } of links) {
  const linkPath = resolve(expandHome(rawPath))
  const target = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(ROOT, rawTarget)
  const label = rawPath

  if (!existsSync(target)) {
    console.log(`  x ${label}\n      target does not exist: ${target} (run npm run build first?)`)
    problems++
    continue
  }
  const type = statSync(target).isDirectory() ? 'dir' : 'file'

  let state = 'missing'
  let current = null
  try {
    const st = lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      current = readlinkSync(linkPath)
      state = normalize(current) === normalize(target) ? 'ok' : 'wrong-target'
    } else {
      state = 'not-a-link'
    }
  } catch {
    state = 'missing'
  }

  if (state === 'ok') {
    console.log(`  = ${label}`)
    continue
  }

  if (check) {
    const detail = state === 'wrong-target' ? `points to ${current}` : state
    console.log(`  x ${label}\n      ${detail}; expected -> ${target}`)
    problems++
    continue
  }

  if (state === 'not-a-link') {
    // A real file or directory at the link path is user data (or a typo in the config);
    // never delete it on the user's behalf. Only symlinks are ours to replace.
    console.log(`  x ${label}\n      a real ${lstatSync(linkPath).isDirectory() ? 'directory' : 'file'} exists here; move or remove it yourself, then rerun`)
    problems++
    continue
  }
  if (state === 'wrong-target') unlinkSync(linkPath)
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    symlinkSync(target, linkPath, type)
  } catch (e) {
    console.log(`  x ${label}\n      ${e.message}`)
    if (/EPERM|privilege/i.test(e.message))
      console.log('      Symlink creation refused - enable Developer Mode (Windows) or run elevated, then restart the terminal.')
    problems++
    continue
  }
  console.log(`  + ${label}\n      -> ${target}${state === 'wrong-target' ? '  (replaced a link to ' + current + ')' : ''}`)
}

if (problems) {
  console.error(`\n${problems} link(s) ${check ? 'need attention' : 'could not be created'}.`)
  process.exit(1)
}
console.log(`\nAll ${links.length} links ${check ? 'verified' : 'in place'}.`)
