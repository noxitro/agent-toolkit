// Harness presets for scripts/install-assets.mjs: which generated files go into which per-user
// discovery folder. A preset is expanded from the generated output on every run, so an asset
// added by the next build is installed by the next run without editing any config.
// No npm dependencies here: the installer runs from a downloaded ZIP without `npm ci`.
//
// Locations (checked 2026-10; harness-version dependent, see docs/harness-notes.md):
//   claude    ~/.claude/{skills,commands,agents}/
//   opencode  ~/.config/opencode/{commands,agents}/ (XDG_CONFIG_HOME honoured, also on Windows)
//   copilot   ~/.copilot/{skills,agents}/ and the VS Code user prompts folder (default profile)

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const HARNESSES = ['claude', 'opencode', 'copilot']

/** Per-user discovery folders, by harness and destination kind. */
export function userDirs({ home, platform, env }) {
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
  const vscodeUser =
    platform === 'win32'
      ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code', 'User')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Code', 'User')
        : join(xdg, 'Code', 'User')
  return {
    claude: {
      skills: join(home, '.claude', 'skills'),
      commands: join(home, '.claude', 'commands'),
      agents: join(home, '.claude', 'agents'),
    },
    opencode: {
      commands: join(xdg, 'opencode', 'commands'),
      agents: join(xdg, 'opencode', 'agents'),
    },
    copilot: {
      skills: join(home, '.copilot', 'skills'),
      agents: join(home, '.copilot', 'agents'),
      prompts: join(vscodeUser, 'prompts'),
    },
  }
}

/** [generated source dir (relative to the repository root), destination kind] per harness. */
function sources(claudePlugin) {
  return {
    claude: [
      [join('plugins', claudePlugin, 'skills'), 'skills'],
      [join('plugins', claudePlugin, 'commands'), 'commands'],
      [join('plugins', claudePlugin, 'agents'), 'agents'],
    ],
    opencode: [
      [join('dist', 'opencode', 'command'), 'commands'],
      [join('dist', 'opencode', 'agent'), 'agents'],
    ],
    copilot: [
      [join('dist', 'copilot', 'skills'), 'skills'],
      [join('dist', 'copilot', 'agents'), 'agents'],
      [join('dist', 'copilot', 'prompts'), 'prompts'],
    ],
  }
}

/**
 * Copilot (VS Code and CLI) also reads ~/.claude/skills and ~/.claude/agents, so with the
 * claude preset in place the copilot copies of the same assets would show up twice.
 */
export const SHARED_WITH_CLAUDE = ['skills', 'agents']

/**
 * Entries for the selected harnesses: [{ path, target }] with an absolute `path` and a
 * `target` relative to `root`, the same shape as "links" in the config files.
 */
export function presetEntries(root, harnesses, { claudePlugin, home, platform, env }) {
  const dirs = userDirs({ home, platform, env })
  const src = sources(claudePlugin)
  const links = []
  for (const harness of harnesses) {
    for (const [from, kind] of src[harness]) {
      if (harness === 'copilot' && harnesses.includes('claude') && SHARED_WITH_CLAUDE.includes(kind)) continue
      const abs = join(root, from)
      if (!existsSync(abs)) continue
      for (const entry of readdirSync(abs).sort()) {
        if (entry.startsWith('.')) continue
        links.push({ path: join(dirs[harness][kind], entry), target: join(from, entry) })
      }
    }
  }
  return links
}

/** Every destination folder any preset can write to, selected or not. */
export function allPresetDirs(opts) {
  return [...new Set(Object.values(userDirs(opts)).flatMap((d) => Object.values(d)))]
}

// Case is folded only where the filesystem does (Windows); elsewhere two paths that
// differ by case are two different targets.
export function normalize(p, platform = process.platform) {
  const r = resolve(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r
}

export function isInside(child, parent, platform = process.platform) {
  const c = normalize(child, platform)
  const p = normalize(parent, platform)
  return c === p || c.startsWith(p + (platform === 'win32' ? '\\' : sep))
}

/**
 * Symlinks in `dirs` that point into `root` but are not in `keep` (normalized link paths):
 * links an earlier run created for an asset or harness that is no longer selected. Only
 * symlinks into this clone count, so links from other clones and real files are left alone.
 */
export function staleLinks(dirs, root, keep, platform = process.platform) {
  const stale = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (!st.isSymbolicLink() || keep.has(normalize(p, platform))) continue
      const target = resolve(dirname(p), readlinkSync(p))
      if (isInside(target, root, platform)) stale.push({ path: p, target })
    }
  }
  return stale
}

/**
 * Content hash of a file or directory tree (relative paths and bytes), used to tell an
 * installed copy that is still as installed from one the user has edited since.
 */
export function treeHash(p) {
  const h = createHash('sha256')
  const walk = (abs, rel) => {
    if (lstatSync(abs).isDirectory()) {
      h.update(`d ${rel}\0`)
      for (const e of readdirSync(abs).sort()) walk(join(abs, e), rel ? `${rel}/${e}` : e)
    } else {
      h.update(`f ${rel}\0`)
      h.update(readFileSync(abs))
      h.update('\0')
    }
  }
  walk(p, '')
  return h.digest('hex')
}
