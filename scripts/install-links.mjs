#!/usr/bin/env node
// Create (or verify) the symlinks that install this repository's generated output into
// the harness discovery locations on this machine.
//
//   node scripts/install-links.mjs                  create or repair every link (first run asks
//                                                   which harnesses to link when nothing is declared)
//   node scripts/install-links.mjs --setup [list]   choose the harnesses (e.g. claude,copilot), then link
//   node scripts/install-links.mjs --check          report state, exit 1 if any link is missing/wrong/stale
//   node scripts/install-links.mjs --remove         remove every link this clone created
//
// Links come from three places:
//   - "harnesses" in toolkit.local.json: presets that link every generated asset of those
//     harnesses into their per-user folders (scripts/lib/links.mjs). Expanded on every run, so
//     assets added by a build are picked up by rerunning this.
//   - "links" in toolkit.config.json (shared, committed) and toolkit.local.json (this machine
//     only, git-ignored; see toolkit.local.example.json), for anything the presets do not cover:
//     "links": [{ "path": "~/.agents/skills/wiki-query", "target": "plugins/llm-wiki/skills/wiki-query" }]
//     `path` may start with "~" (home directory); `target` is relative to the repository root.
// Targets are resolved to absolute paths, so moving the repository means re-running this.
// A link in a preset folder that points into this clone but is no longer declared (asset
// deleted, harness deselected) is removed.
//
// Windows: symlink creation needs Developer Mode (or elevation). Directory links use the
// "dir" symlink type rather than a junction so that files and directories are handled alike.
// install-links.bat at the repository root checks both before running this.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { CLAUDE_PLUGIN, ROOT } from './lib/toolkit.mjs'
import { HARNESSES, allPresetDirs, normalize, presetLinks, staleLinks } from './lib/links.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const remove = args.includes('--remove')
const setupAt = args.indexOf('--setup')
const setup = setupAt !== -1
const setupList = setup && args[setupAt + 1] && !args[setupAt + 1].startsWith('--') ? args[setupAt + 1] : null

const LOCAL = join(ROOT, 'toolkit.local.json')
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {})
const shared = readJson(join(ROOT, 'toolkit.config.json'))
const local = readJson(LOCAL)

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
  console.log('Which harnesses should this clone be linked into?')
  console.log('  1) claude    Claude Code     ~/.claude/{skills,commands,agents}')
  console.log('  2) opencode  OpenCode        ~/.config/opencode/{commands,agents}')
  console.log('  3) copilot   GitHub Copilot  ~/.copilot/{skills,agents}, VS Code user prompts')
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

const declaredLinks = [...(shared.links ?? []), ...(local.links ?? [])]
let harnesses = local.harnesses ?? []

if (setup || (!check && !remove && harnesses.length === 0 && declaredLinks.length === 0 && process.stdin.isTTY)) {
  try {
    harnesses = setupList ? parseHarnesses(setupList) : await askHarnesses()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  writeFileSync(LOCAL, JSON.stringify({ ...local, harnesses }, null, 2) + '\n')
  console.log(`Saved harnesses [${harnesses.join(', ')}] to toolkit.local.json.\n`)
}

const env = { home: homedir(), platform: process.platform, env: process.env }
const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const tilde = (p) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p)
const links = [
  ...declaredLinks.map((l) => ({ ...l, label: l.path })),
  ...presetLinks(ROOT, harnesses, { claudePlugin: CLAUDE_PLUGIN, ...env }).map((l) => ({
    ...l,
    label: tilde(l.path),
  })),
].map(({ path, target, label }) => ({
  linkPath: resolve(expandHome(path)),
  target: isAbsolute(target) ? resolve(target) : resolve(ROOT, target),
  label,
}))

const keep = new Set(links.map((l) => normalize(l.linkPath)))
const stale = staleLinks(allPresetDirs(env), ROOT, keep)

if (links.length === 0 && stale.length === 0) {
  console.log('No links declared. Run with --setup to choose harnesses, or add "links" to toolkit.local.json.')
  process.exit(0)
}

let problems = 0

if (remove) {
  // Only symlinks are ours to delete: a real file at a declared path is left alone.
  for (const { linkPath, label } of [...links, ...stale.map((s) => ({ linkPath: s.path, label: tilde(s.path) }))]) {
    let st
    try {
      st = lstatSync(linkPath)
    } catch {
      continue
    }
    if (!st.isSymbolicLink()) continue
    unlinkSync(linkPath)
    console.log(`  - ${label}`)
  }
  if (harnesses.length) {
    writeFileSync(LOCAL, JSON.stringify({ ...local, harnesses: [] }, null, 2) + '\n')
    console.log('\nCleared the harness selection in toolkit.local.json.')
  }
  console.log('Links removed.')
  process.exit(0)
}

for (const { linkPath, target, label } of links) {
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

for (const { path, target } of stale) {
  if (check) {
    console.log(`  x ${tilde(path)}\n      stale link to ${target}; no longer declared`)
    problems++
    continue
  }
  unlinkSync(path)
  console.log(`  - ${tilde(path)}\n      (stale link to ${target} removed)`)
}

if (problems) {
  console.error(`\n${problems} link(s) ${check ? 'need attention' : 'could not be created'}.`)
  process.exit(1)
}
console.log(`\nAll ${links.length} links ${check ? 'verified' : 'in place'}.`)
