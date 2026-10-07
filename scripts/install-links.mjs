#!/usr/bin/env node
// Create (or verify) the symlinks that install this repository's generated output into
// the harness discovery locations on this machine.
//
//   node scripts/install-links.mjs           create or repair every link
//   node scripts/install-links.mjs --check   report state, exit 1 if any link is missing/wrong
//
// Links are declared in toolkit.config.json:
//   "links": [{ "path": "~/.agents/skills/wiki-query", "target": "plugins/llm-wiki/skills/wiki-query" }]
// `path` may start with "~/" (home directory); `target` is relative to the repository root.
// Targets are resolved to absolute paths, so moving the repository means re-running this.
//
// A link is replaced by creating the new one under a temporary name and renaming it over
// the old one, so a failure part-way leaves the previous link in place.
//
// Windows: directory links are junctions, which need neither Developer Mode nor elevation.
// File links are symlinks and do need one of them.

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { ROOT, config, ensureRoot } from './lib/toolkit.mjs'

const check = process.argv.includes('--check')

ensureRoot('install-links')

const links = config.links ?? []

if (links.length === 0) {
  console.log('No links declared in toolkit.config.json - nothing to do.')
  process.exit(0)
}

// Only "~", "~/..." and "~\\..." name the home directory. "~user/..." would otherwise
// resolve to a literal "~user" directory under the current one, so it is refused.
function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  if (p.startsWith('~')) throw new Error(`${p}: only ~ and ~/ are expanded; write the home directory out`)
  return p
}

// Create the link next to its final location, then rename it into place. rename() replaces
// an existing symlink atomically on POSIX; on Windows it may refuse to replace a directory
// link, so the old link is first moved aside and restored if the second rename fails.
function placeLink(target, linkPath, type, replacing) {
  const tmp = join(dirname(linkPath), `.${basename(linkPath)}.tmp-${process.pid}-${Date.now()}`)
  symlinkSync(target, tmp, type)
  try {
    renameSync(tmp, linkPath)
    return
  } catch (e) {
    if (!replacing) {
      unlinkSync(tmp)
      throw e
    }
  }
  const aside = `${tmp}.old`
  try {
    renameSync(linkPath, aside)
  } catch (e) {
    unlinkSync(tmp)
    throw e
  }
  try {
    renameSync(tmp, linkPath)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort; the error that matters is e */
    }
    try {
      renameSync(aside, linkPath)
    } catch (restore) {
      e.message += ` (and the previous link could not be restored; it is at ${aside}: ${restore.message})`
    }
    throw e
  }
  unlinkSync(aside)
}

// Case is folded only where the filesystem does (Windows); elsewhere two paths that
// differ by case are two different targets.
function normalize(p) {
  const r = resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r
}

let problems = 0

for (const { path: rawPath, target: rawTarget } of links) {
  const label = rawPath
  let linkPath
  try {
    linkPath = resolve(expandHome(rawPath))
  } catch (e) {
    console.log(`  x ${label}\n      ${e.message}`)
    problems++
    continue
  }
  const target = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(ROOT, rawTarget)

  if (!existsSync(target)) {
    console.log(`  x ${label}\n      target does not exist: ${target} (run npm run build first?)`)
    problems++
    continue
  }
  const type = statSync(target).isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'

  let state = 'missing'
  let current = null
  try {
    const st = lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      current = readlinkSync(linkPath)
      // A relative link target is relative to the link's own directory, not to the cwd.
      state = normalize(resolve(dirname(linkPath), current)) === normalize(target) ? 'ok' : 'wrong-target'
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
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    placeLink(target, linkPath, type, state === 'wrong-target')
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
