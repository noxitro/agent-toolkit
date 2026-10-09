// Path guards for the converter: every file it writes must stay inside the folder it was
// meant for, and the source folder must never be a target. Names that come from a skill
// (its frontmatter `name`, its folder name) are turned into a plain slug before they are
// used in a file name.

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class PathError extends Error {}

/** Agent Builder's rule for a skill name, also the rule for every output file name. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_NAME_MAX = 64

export const validSkillName = (s) => typeof s === 'string' && s.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(s)

/** A slug of [a-z0-9-] (at most 64 characters) for file names, or '' when nothing is left. */
export function slug(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/, '')
}

/** True when `child` is strictly inside `parent` (after resolving; never equal to it). */
export function strictlyInside(parent, child) {
  const r = relative(resolve(parent), resolve(child))
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}

/** `join(dir, ...parts)`, refusing a result that is not strictly inside `dir`. */
export function inside(dir, ...parts) {
  const p = join(dir, ...parts)
  if (!strictlyInside(dir, p)) throw new PathError(`書き込み先 ${p} が ${dir} の外になるので書きません`)
  return p
}

/** Real path of `p`; for a path that does not exist yet, the real path of its nearest existing ancestor plus the rest. */
export function realish(p) {
  const rest = []
  let cur = resolve(p)
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest)
    } catch {}
    const parent = dirname(cur)
    if (parent === cur) return resolve(p)
    rest.unshift(basename(cur))
    cur = parent
  }
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** True when one path is the other or inside it, comparing real paths (links and junctions resolved). */
export function overlaps(a, b) {
  const norm = (p) => {
    const r = realish(p).replace(/[\\/]+$/, '') + sep
    return CASE_INSENSITIVE ? r.toLowerCase() : r
  }
  const x = norm(a)
  const y = norm(b)
  return x.startsWith(y) || y.startsWith(x)
}
