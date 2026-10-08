#!/usr/bin/env node
// Install this repository's generated skills, commands and agents into the per-user folders
// that Claude Code, OpenCode and GitHub Copilot read. On Windows, install.bat runs the
// PowerShell port (scripts/install-assets.ps1) instead, so no Node.js is needed there; the two
// share scripts/install-presets.json and the state file, and must behave the same.
//
//   node scripts/install-assets.mjs                  install or update (the first run asks which
//                                                    harnesses to install for)
//   node scripts/install-assets.mjs --setup [list]   choose the harnesses again (e.g. claude,copilot)
//   node scripts/install-assets.mjs --link           switch to symlinks into this clone (developers)
//   node scripts/install-assets.mjs --copy           switch back to copies (the default)
//   node scripts/install-assets.mjs --check          report state, exit 1 if anything needs attention
//   node scripts/install-assets.mjs --remove         uninstall everything this installer put in place
//   node scripts/install-assets.mjs --force          also overwrite files edited or placed by hand
//
// Copy mode (default) needs no special rights and leaves nothing pointing back at this folder,
// so a downloaded ZIP of the repository can be deleted after installing. Link mode makes every
// `npm run build` and `git pull` live at once, but on Windows needs Developer Mode (or an
// elevated prompt), and the links break when the clone moves.
//
// What gets installed:
//   - "harnesses" presets: every generated asset of each selected harness (scripts/lib/presets.mjs),
//     expanded on every run, so assets added by a build arrive by rerunning this.
//   - "links" in toolkit.config.json (shared, committed) and toolkit.local.json (this machine
//     only, git-ignored), for anything the presets do not cover, installed in the same mode:
//     "links": [{ "path": "~/.agents/skills/wiki-query", "target": "plugins/llm-wiki/skills/wiki-query" }]
//     `path` may start with "~" (home directory); `target` is relative to the repository root.
//
// The mode, the harness selection and a content hash of every copy are kept per user in
// ~/.agent-toolkit/<package>.json rather than in the clone, so a newer download of the
// repository updates (or removes) what an older one installed. Files this installer did not
// put there, and copies edited since, are never overwritten or deleted without --force;
// anything it did put there that is no longer selected is removed.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { HARNESSES, allPresetDirs, harnessInfo, normalize, presetEntries, staleLinks, treeHash } from './lib/presets.mjs'

// Read here rather than from lib/toolkit.mjs, which needs the yaml package: the installer
// must run from a downloaded ZIP without `npm ci`. Same rules as lib/toolkit.mjs.
const ROOT = process.env.AGENT_TOOLKIT_ROOT ? resolve(process.env.AGENT_TOOLKIT_ROOT) : process.cwd()
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : {})
const config = readJson(join(ROOT, 'toolkit.config.json'))
const pkg = readJson(join(ROOT, 'package.json'))
const CLAUDE_PLUGIN = config.claudePlugin ?? 'toolkit-core'

const args = process.argv.slice(2)
const check = args.includes('--check')
const remove = args.includes('--remove')
const force = args.includes('--force')
const setupAt = args.indexOf('--setup')
const setup = setupAt !== -1
const setupList = setup && args[setupAt + 1] && !args[setupAt + 1].startsWith('--') ? args[setupAt + 1] : null
if (args.includes('--copy') && args.includes('--link')) {
  console.error('Choose one of --copy and --link.')
  process.exit(1)
}

const HOME = resolve(homedir())
const tilde = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p)
const expandHome = (p) => (p.startsWith('~') ? join(HOME, p.slice(1)) : p)

const id = (pkg.name ?? basename(ROOT)).replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-')
const STATE = join(HOME, '.agent-toolkit', `${id}.json`)
const saved = readJson(STATE)
const state = { mode: 'copy', harnesses: [], copies: {}, ...saved }
if (args.includes('--copy')) state.mode = 'copy'
if (args.includes('--link')) state.mode = 'link'
const linkMode = state.mode === 'link'

function saveState() {
  mkdirSync(dirname(STATE), { recursive: true })
  const { mode, harnesses, copies } = state
  writeFileSync(STATE, JSON.stringify({ mode, harnesses, version: pkg.version, source: ROOT, copies }, null, 2) + '\n')
}

// Copies are recorded relative to the home folder ("~/.claude/skills/x", always with "/"), so
// both installers agree on the key however each spells the home folder (Windows PowerShell 5.1
// expands 8.3 short names such as RUNNER~1, Node does not). Looked up case-insensitively where
// the filesystem is.
const keyOf = (p) => (p.startsWith(HOME + sep) ? '~/' + p.slice(HOME.length + 1).split(sep).join('/') : p)
const pathOf = (k) => (k.startsWith('~/') ? join(HOME, ...k.slice(2).split('/')) : k)
const recordKey = (p) => Object.keys(state.copies).find((k) => normalize(pathOf(k)) === normalize(p))
const recorded = (p) => state.copies[recordKey(p)]
function forget(p) {
  const k = recordKey(p)
  if (k) delete state.copies[k]
}
function record(p, hash) {
  forget(p)
  state.copies[keyOf(p)] = hash
}

function parseHarnesses(text) {
  const byNumber = Object.fromEntries(HARNESSES.map((h, i) => [String(i + 1), h]))
  const picked = text.split(/[\s,]+/).filter(Boolean).map((t) => byNumber[t] ?? t.toLowerCase())
  const unknown = picked.filter((h) => !HARNESSES.includes(h))
  if (unknown.length) throw new Error(`unknown harness: ${unknown.join(', ')} (choose from ${HARNESSES.join(', ')})`)
  return HARNESSES.filter((h) => picked.includes(h))
}

async function askHarnesses() {
  if (!process.stdin.isTTY) {
    console.error(`No harnesses selected. Run with --setup <list>, e.g. --setup ${HARNESSES.join(',')}`)
    process.exit(1)
  }
  console.log('Which tools should the assets be installed for?')
  HARNESSES.forEach((h, i) => {
    const { label, summary } = harnessInfo(h)
    console.log(`  ${i + 1}) ${h.padEnd(9)} ${label.padEnd(15)} ${summary}`)
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await rl.question('Numbers or names, comma-separated [1]: ')).trim() || '1'
      try {
        const picked = parseHarnesses(answer)
        if (picked.length) return picked
      } catch (e) {
        console.log(`  ${e.message}`)
      }
    }
  } finally {
    rl.close()
  }
}

const declared = [...(config.links ?? []), ...(readJson(join(ROOT, 'toolkit.local.json')).links ?? [])]

if (setup || (!check && !remove && state.harnesses.length === 0 && declared.length === 0 && process.stdin.isTTY)) {
  try {
    state.harnesses = setupList ? parseHarnesses(setupList) : await askHarnesses()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  console.log()
}

const env = { home: HOME, platform: process.platform, env: process.env }
const entries = [
  ...declared,
  ...presetEntries(ROOT, state.harnesses, { claudePlugin: CLAUDE_PLUGIN, ...env }),
].map(({ path, target }) => {
  const dest = resolve(expandHome(path))
  return { dest, src: isAbsolute(target) ? resolve(target) : resolve(ROOT, target), label: tilde(dest) }
})
const keep = new Set(entries.map((e) => normalize(e.dest)))

/** What is at `dest` now, from this installer's point of view. */
function inspect(dest) {
  let st
  try {
    st = lstatSync(dest)
  } catch {
    return { kind: 'missing' }
  }
  if (st.isSymbolicLink()) return { kind: 'link', to: readlinkSync(dest) }
  const hash = recorded(dest)
  if (hash === undefined) return { kind: 'foreign', dir: st.isDirectory() }
  return { kind: treeHash(dest) === hash ? 'copy' : 'edited', dir: st.isDirectory() }
}

function clear(dest) {
  if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest)
  else rmSync(dest, { recursive: true, force: true })
  forget(dest)
}

function place(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  if (linkMode) {
    symlinkSync(src, dest, statSync(src).isDirectory() ? 'dir' : 'file')
  } else {
    cpSync(src, dest, { recursive: true })
    record(dest, treeHash(dest))
  }
}

let problems = 0
const fail = (label, detail) => {
  console.log(`  x ${label}\n      ${detail}`)
  problems++
}

// Copies recorded by an earlier run that are no longer selected, plus links into this clone
// left in any preset folder (asset deleted, harness deselected, switched to copy mode).
const staleCopies = Object.keys(state.copies).map(pathOf).filter((p) => !keep.has(normalize(p)))
const strayLinks = staleLinks(allPresetDirs(env), ROOT, keep)

if (remove) {
  for (const { dest } of entries) {
    const now = inspect(dest)
    if (now.kind === 'link' || now.kind === 'copy' || (force && now.kind === 'edited')) {
      clear(dest)
      console.log(`  - ${tilde(dest)}`)
    } else if (now.kind === 'edited') {
      forget(dest)
      console.log(`  ! ${tilde(dest)}\n      edited since it was installed; left in place (--force removes it)`)
    }
  }
  for (const p of staleCopies) {
    if (!existsSync(p)) continue
    if (inspect(p).kind === 'copy' || force) {
      clear(p)
      console.log(`  - ${tilde(p)}`)
    } else console.log(`  ! ${tilde(p)}\n      edited since it was installed; left in place (--force removes it)`)
  }
  for (const { path } of strayLinks) {
    unlinkSync(path)
    console.log(`  - ${tilde(path)}`)
  }
  rmSync(STATE, { force: true })
  console.log('\nUninstalled. Start a new session in each tool to drop the assets.')
  process.exit(0)
}

if (entries.length === 0 && staleCopies.length === 0 && strayLinks.length === 0) {
  console.log('Nothing selected. Run with --setup to choose the tools to install for.')
  process.exit(0)
}

let changed = 0
for (const { dest, src, label } of entries) {
  if (!existsSync(src)) {
    fail(label, `source does not exist: ${src} (run npm run build first?)`)
    continue
  }
  const now = inspect(dest)

  // Already as wanted?
  if (linkMode && now.kind === 'link' && normalize(now.to) === normalize(src)) {
    console.log(`  = ${label}`)
    continue
  }
  if (!linkMode && now.kind === 'copy' && recorded(dest) === treeHash(src)) {
    console.log(`  = ${label}`)
    continue
  }
  // A hand-made copy identical to ours (e.g. from the old `cp -r` instructions) is adopted.
  if (!linkMode && now.kind === 'foreign' && treeHash(dest) === treeHash(src)) {
    if (!check) record(dest, treeHash(dest))
    console.log(`  = ${label}  (already identical; now tracked)`)
    continue
  }

  // Never overwrite what the user made or edited, unless asked to.
  if ((now.kind === 'foreign' || now.kind === 'edited') && !force) {
    const what = now.kind === 'edited' ? 'was edited since it was installed' : `is a ${now.dir ? 'directory' : 'file'} this installer did not create`
    fail(label, `${what}; move it away or rerun with --force to overwrite it`)
    continue
  }

  if (check) {
    const detail = {
      missing: 'not installed',
      link: linkMode ? `links to ${now.to}` : 'is a link; expected a copy',
      copy: linkMode ? 'is a copy; expected a link' : 'outdated copy',
      foreign: 'differs from this version',
      edited: 'edited since it was installed',
    }[now.kind]
    fail(label, detail)
    continue
  }

  const verb = now.kind === 'missing' ? '+' : '~'
  try {
    if (now.kind !== 'missing') clear(dest)
    place(src, dest)
  } catch (e) {
    fail(label, e.message)
    if (/EPERM|privilege/i.test(e.message))
      console.log('      Symlink creation refused - enable Developer Mode (Windows) or run elevated, or install with --copy.')
    continue
  }
  changed++
  console.log(`  ${verb} ${label}${linkMode ? `\n      -> ${src}` : ''}`)
}

for (const p of staleCopies) {
  if (!existsSync(p)) {
    forget(p)
    continue
  }
  const kind = inspect(p).kind
  if (check) {
    fail(tilde(p), 'installed earlier but no longer selected')
    continue
  }
  if (kind === 'copy' || force) {
    clear(p)
    changed++
    console.log(`  - ${tilde(p)}  (no longer selected)`)
  } else {
    forget(p)
    console.log(`  ! ${tilde(p)}\n      no longer selected, but edited since it was installed; left in place`)
  }
}

for (const { path, target } of strayLinks) {
  if (check) {
    fail(tilde(path), `stale link to ${target}`)
    continue
  }
  unlinkSync(path)
  changed++
  console.log(`  - ${tilde(path)}  (stale link removed)`)
}

if (!check) saveState()

if (problems) {
  console.error(`\n${problems} item(s) ${check ? 'need attention' : 'could not be installed'}.`)
  process.exit(1)
}
const scope = state.harnesses.length ? ` for ${state.harnesses.join(', ')}` : ''
console.log(`\n${entries.length} asset(s) ${check ? 'verified' : 'installed'}${scope} (${state.mode} mode, version ${pkg.version ?? 'unknown'}).`)
if (changed && !check) console.log('Start a new session in each tool to pick up the changes.')
