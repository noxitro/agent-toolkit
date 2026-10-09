// Resolve the converter's input - a local skill folder, a GitHub folder URL, or the name of
// an installed skill - to a folder on disk. GitHub input is fetched with the same safe
// sparse shallow clone as the skill scout (lib/git.mjs) into a temp folder under the OS
// temp directory, inside a folder named node_modules so test runners never pick it up.
// Nothing found here is executed. git is never started inside a local or installed input
// (its .git/config could make git run programs): the facts the report needs - commit,
// GitHub origin, index entries that are links or submodules - are read from the files
// directly by local-git.mjs.

import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { cloneSparse, git, isCommitId, remoteRefs, sparsePatterns, specialEntries } from './git.mjs'
import { readLocalRepo } from './local-git.mjs'
import { strictlyInside } from './paths.mjs'

export class InputError extends Error {}

const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(tree|blob)\/(.+?))?\/?$/
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * Parse https://github.com/<owner>/<repo>/tree/<ref>/<path> (or /blob/<ref>/<path>/SKILL.md).
 * Returns { owner, repo, rest } where rest is "<ref>/<path>" still to be split against the
 * remote's branch and tag names (a branch name may contain slashes).
 */
export function parseGitHubUrl(input) {
  const m = GITHUB_RE.exec(input.trim().replace(/[?#].*$/, ''))
  if (!m) return null
  const [, owner, repo, kind, restRaw] = m
  if ([owner, repo].some((p) => p === '.' || p === '..')) return null
  // Split on "/" first, then decode each segment, so an encoded separator (%2F, %5C) or an
  // encoded dot segment cannot slip past the checks. The parts become a path inside the
  // clone joined with the OS separator, so anything that could leave the clone on Windows
  // or POSIX is refused: slashes and backslashes inside a segment, drive colons, NUL and
  // control characters, empty, "." and ".." segments.
  const raw = restRaw ? restRaw.split('/') : []
  const parts = []
  for (const [i, seg] of raw.entries()) {
    if (seg === '' && i === raw.length - 1) continue
    let p
    try {
      p = decodeURIComponent(seg)
    } catch {
      throw new InputError(`URL の % の書き方が不正です: ${input}`)
    }
    if (p === '' || p === '.' || p === '..' || /[\\/:\x00-\x1f\x7f]/.test(p)) throw new InputError(`URL のパスが不正です(使えない文字か . / .. を含む): ${input}`)
    parts.push(p)
  }
  if (kind === 'blob') {
    if (parts.at(-1) !== 'SKILL.md') throw new InputError(`GitHub の blob の URL は SKILL.md を指すものだけ使えます: ${input}`)
    parts.pop()
  }
  return { owner, repo, kind: kind ?? null, rest: parts.join('/') }
}

/** The clone URL for owner/repo. SKILL2ZIP_GITHUB_BASE replaces https://github.com (tests point it at file:// repositories). */
export function cloneUrl(owner, repo) {
  const base = process.env.SKILL2ZIP_GITHUB_BASE
  return base ? `${base.replace(/\/+$/, '')}/${owner}/${repo}` : `https://github.com/${owner}/${repo}.git`
}

/** Split "<ref>/<path>" using the remote's branch and tag names; the longest matching ref wins. */
export function splitRefAndPath(rest, refs) {
  const parts = rest.split('/').filter(Boolean)
  if (!parts.length) return { ref: '', path: '' }
  for (let n = parts.length; n >= 1; n--) {
    const ref = parts.slice(0, n).join('/')
    if (refs.has(ref)) return { ref, path: parts.slice(n).join('/') }
  }
  if (isCommitId(parts[0])) return { ref: parts[0].toLowerCase(), path: parts.slice(1).join('/') }
  if (/^[0-9a-f]{7,39}$/i.test(parts[0])) throw new InputError(`コミットは 40 桁の ID で指定してください(短い ID ${parts[0]} は取得できません)`)
  throw new InputError(`ブランチまたはタグ ${parts[0]} がリポジトリにありません`)
}

/** Where installed skills are looked up, in order. `home` and `cwd` are absolute. */
export function installedLocations({ home, cwd }) {
  const list = [
    { dir: join(home, '.claude', 'skills'), where: 'Claude Code(ユーザー)' },
    { dir: join(cwd, '.claude', 'skills'), where: 'Claude Code(このフォルダ)' },
    { dir: join(cwd, '.github', 'skills'), where: 'GitHub Copilot(このリポジトリ)' },
    { dir: join(home, '.copilot', 'skills'), where: 'GitHub Copilot(ユーザー)' },
    { dir: join(home, '.agents', 'skills'), where: '~/.agents(ユーザー)' },
  ]
  // Claude Code plugins: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/
  const cache = join(home, '.claude', 'plugins', 'cache')
  for (const mk of subdirs(cache)) for (const pl of subdirs(join(cache, mk))) for (const ver of subdirs(join(cache, mk, pl))) {
    const dir = join(cache, mk, pl, ver, 'skills')
    if (existsSync(dir)) list.push({ dir, where: `Claude Code のプラグイン ${pl}@${mk}(${ver})` })
  }
  return list
}

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Every installed copy of skill `name`, de-duplicated by real path (link installs point at one folder). */
export function findInstalled(name, ctx) {
  const seen = new Map()
  for (const loc of installedLocations(ctx)) {
    const dir = join(loc.dir, name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    let real
    try {
      real = realpathSync.native(dir)
    } catch {
      continue
    }
    const prev = seen.get(real)
    if (prev) prev.where.push(loc.where)
    else seen.set(real, { dir: real, path: dir, where: [loc.where] })
  }
  return [...seen.values()]
}

/** SKILL.md files below `dir` (not at its root), for the "not at the root" error. */
function nestedSkillFiles(dir, prefix = '', depth = 0, out = []) {
  if (depth > 3 || out.length >= 10) return out
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) nestedSkillFiles(dir, rel, depth + 1, out)
    else if (prefix && e.isFile() && e.name.toLowerCase() === 'skill.md') out.push(rel)
  }
  return out
}

/** Throw unless `dir` has a file named exactly SKILL.md at its root. */
export function requireSkillRoot(dir, label) {
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    throw new InputError(`${label} を読めません: ${e.message}`)
  }
  if (names.some((e) => e.name === 'SKILL.md' && e.isFile())) return
  const alt = names.find((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')
  if (alt) throw new InputError(`${label} の ${alt.name} は名前が SKILL.md ではありません(大文字小文字も含めて SKILL.md にしてください)`)
  const nested = nestedSkillFiles(dir)
  if (nested.length) throw new InputError(`${label} の直下に SKILL.md がありません。SKILL.md はスキルのフォルダの直下に置きます。見つかった場所: ${nested.join(', ')}(そのフォルダを指定してください)`)
  throw new InputError(`${label} に SKILL.md がありません`)
}

/** Nearest ancestor of `dir` (inclusive) that is a git work tree root, or null. */
function gitRootOf(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}


/**
 * Resolve the input. Returns
 *   { kind: 'local'|'installed'|'github', label, dir, root, rel, special, notes, git, origin, where, cleanup }
 * where `root` is the folder the license search may climb to (repository root or the skill
 * folder itself), `rel` the skill folder relative to it (posix, '' when equal), `special`
 * the git entries that are links/submodules/executables with root-relative paths, `notes`
 * what could not be checked (for the report).
 */
export function resolveInput(input, { cwd = process.cwd(), home = homedir(), log = () => {} } = {}) {
  if (!input) throw new InputError('変換するスキルを指定してください(フォルダ、GitHub の URL、インストール済みのスキル名)')

  if (/^https?:\/\//i.test(input)) {
    const gh = parseGitHubUrl(input)
    if (!gh) throw new InputError(`GitHub のフォルダの URL(https://github.com/<owner>/<repo>/tree/<ブランチ>/<パス>)を指定してください: ${input}`)
    return resolveGitHub(gh, log)
  }

  const asPath = resolve(cwd, input)
  if (existsSync(asPath)) {
    let dir = realpathSync.native(asPath)
    if (statSync(dir).isFile()) {
      if (basename(dir) !== 'SKILL.md') throw new InputError(`${input} はフォルダでも SKILL.md でもありません`)
      dir = dirname(dir)
    }
    return local(dir, 'local', input, null)
  }
  if (/[\\/]/.test(input) || input.startsWith('.') || !NAME_RE.test(input)) throw new InputError(`${input} が見つかりません`)

  const found = findInstalled(input, { home, cwd })
  if (!found.length) {
    const where = installedLocations({ home, cwd }).map((l) => l.where)
    throw new InputError(`インストール済みのスキル ${input} が見つかりません(探した場所: ${[...new Set(where)].join('、')})。フォルダのパスか GitHub の URL で指定してください`)
  }
  if (found.length > 1) {
    const lines = found.map((f) => `  - ${f.dir}(${f.where.join('、')})`).join('\n')
    throw new InputError(`スキル ${input} が ${found.length} か所にあります。どれを変換するか、フォルダのパスで指定してください:\n${lines}`)
  }
  return local(found[0].dir, 'installed', input, found[0].where.join('、'))
}

function local(dir, kind, input, where) {
  requireSkillRoot(dir, input)
  const root = gitRootOf(dir) ?? dir
  const rel = relative(root, dir).split(sep).join('/')
  // Read from the files; git itself is never run inside the user's folder.
  const facts = existsSync(join(root, '.git')) ? readLocalRepo(root, rel) : null
  return {
    kind,
    label: kind === 'installed' ? `${input}(${where})` : input,
    dir,
    root,
    rel,
    special: facts?.special ?? [],
    notes: facts?.notes ?? [],
    git: facts && (facts.commit || facts.remote) ? { commit: facts.commit, date: null, remote: facts.remote } : null,
    origin: 'own',
    where,
    cleanup: () => {},
  }
}

function resolveGitHub(gh, log) {
  const url = cloneUrl(gh.owner, gh.repo)
  const display = `https://github.com/${gh.owner}/${gh.repo}`
  const work = mkdtempSync(join(tmpdir(), 'skill2zip-'))
  const cleanup = () => rmSync(work, { recursive: true, force: true, maxRetries: 3 })
  try {
    let ref = ''
    let path = ''
    if (gh.rest) {
      log(`${display}: ブランチとタグを確かめています`)
      ;({ ref, path } = splitRefAndPath(gh.rest, remoteRefs(url)))
    }
    // node_modules in the path keeps test runners (node --test, Jest, pytest) away from the clone.
    const dir = join(work, 'node_modules', gh.repo)
    log(`${display}: ${path || '(リポジトリの最上位)'} を取得しています${ref ? `(${ref})` : ''}`)
    const commit = cloneSparse({ url, dir, patterns: sparsePatterns([path]), ref })
    const date = git(['-C', dir, 'log', '-1', '--format=%cs']).trim()
    const skillDir = path ? join(dir, ...path.split('/')) : dir
    // Defence in depth: parseGitHubUrl already refuses anything that could leave the clone.
    if (path && !strictlyInside(dir, skillDir)) throw new InputError(`URL のパスがリポジトリの外を指しています: ${path}`)
    let plain = false
    try {
      plain = lstatSync(skillDir).isDirectory()
    } catch {}
    if (!plain) throw new InputError(`${display} の ${ref || '既定のブランチ'} に ${path} というフォルダがありません`)
    requireSkillRoot(skillDir, `${display}/tree/${ref || 'HEAD'}/${path}`)
    if (path && !strictlyInside(realpathSync.native(dir), realpathSync.native(skillDir))) throw new InputError(`URL のパスがリポジトリの外を指しています: ${path}`)
    return {
      kind: 'github',
      label: `${display}/tree/${ref || commit}/${path}`.replace(/\/$/, ''),
      dir: skillDir,
      root: dir,
      rel: path,
      special: specialEntries(dir),
      notes: [],
      git: { remote: display, commit, date, ref, path, repo: `${gh.owner}/${gh.repo}` },
      origin: 'third-party',
      where: null,
      cleanup,
    }
  } catch (e) {
    cleanup()
    throw e
  }
}
