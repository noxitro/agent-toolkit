// Harness presets for scripts/install-assets.mjs: which generated files go into which per-user
// discovery folder. The table itself is scripts/install-presets.json, shared with the Windows
// installer (scripts/install-assets.ps1) so the two cannot disagree about locations. A preset
// is expanded from the generated output on every run, so an asset added by the next build is
// installed by the next run without editing any config.
// No npm dependencies here: the installer runs from a downloaded ZIP without `npm ci`.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TABLE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'install-presets.json'), 'utf8').replace(/^\uFEFF/, ''),
).harnesses

export const HARNESSES = Object.keys(TABLE)
export const harnessInfo = (h) => TABLE[h]

/** Values for the {variables} in install-presets.json. */
export function presetVars({ home, platform, env, claudePlugin = '' }) {
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config')
  const vscodeUser =
    platform === 'win32'
      ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code', 'User')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Code', 'User')
        : join(xdgConfig, 'Code', 'User')
  return { home, xdgConfig, vscodeUser, claudePlugin }
}

const expand = (template, vars) => join(...template.split('/').map((part) => part.replace(/\{(\w+)\}/g, (_, v) => vars[v])))

/**
 * Entries for the selected harnesses: [{ path, target }] with an absolute `path` and a
 * `target` relative to `root`, the same shape as "links" in the config files.
 */
export function presetEntries(root, harnesses, opts) {
  const vars = presetVars(opts)
  const entries = []
  for (const harness of harnesses) {
    for (const { from, to, skipIfSelected } of TABLE[harness].entries) {
      if (skipIfSelected && harnesses.includes(skipIfSelected)) continue
      const src = expand(from, vars)
      if (!existsSync(join(root, src))) continue
      for (const entry of readdirSync(join(root, src)).sort()) {
        if (entry.startsWith('.')) continue
        entries.push({ path: join(expand(to, vars), entry), target: join(src, entry) })
      }
    }
  }
  return entries
}

/** Every destination folder any preset can write to, selected or not. */
export function allPresetDirs(opts) {
  const vars = presetVars(opts)
  return [...new Set(Object.values(TABLE).flatMap((h) => h.entries.map((e) => expand(e.to, vars))))]
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
